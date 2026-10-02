import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../core/filesystem';
import {
    readRuntimeMutationGeneration,
    RuntimeMutationGenerationError,
    type RuntimeMutationGenerationSnapshot
} from '../gate-runtime/runtime-mutation-generation';
import { withFilesystemLock } from '../gate-runtime/timeline/task-events-locking';

const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILE_NAME = '.toxin-snapshot-cache.json';
const CACHE_ANCHOR_FILE_NAME = '.toxin-snapshot-cache.anchor.json';
const CACHE_BUILD_LOCK_NAME = '.toxin-snapshot-cache.build.lock';
const RUNTIME_GENERATION_ARTIFACT_PREFIX = '.runtime-mutation-generation';
const MAX_CACHE_FILE_BYTES = 512 * 1024;
const MAX_CACHE_ANCHOR_FILE_BYTES = 64 * 1024;
const RETENTION_EPOCH_MS = 24 * 60 * 60 * 1000;
const MAX_STABLE_SCAN_ATTEMPTS = 3;
const CACHE_BUILD_LOCK_TIMEOUT_MS = 5_000;
const CACHE_BUILD_LOCK_RETRY_MS = 20;
const CACHE_BUILD_LOCK_STALE_MS = 5 * 60 * 1000;

export const RUNTIME_TOXIN_SCAN_DIRECTORIES: readonly string[] = Object.freeze([
    'reviews',
    'task-events',
    'backups',
    'bundle-backups',
    'update-reports',
    'update-rollbacks'
]);

export interface RuntimeToxinDiskSummary {
    directory: string;
    file_count: number;
    total_bytes: number;
}

export interface RuntimeToxinScanCacheValue {
    diskSummaries: RuntimeToxinDiskSummary[];
    runtimeTotalBytes: number;
    cleanupCandidateCount: number;
    cleanupCandidateBytes: number;
    noisyArtifactCount: number;
    noisyArtifactBytes: number;
    gateEventCount: number;
    nextRetentionTransitionAtMs: number | null;
}

interface ToxinSnapshotCachePayload {
    schema_version: 1;
    orchestrator_root_sha256: string;
    runtime_generation: RuntimeMutationGenerationSnapshot;
    retention_epoch: number;
    retention_valid_until_ms: number;
    cleanup_max_age_days: number;
    scanned_at_utc: string;
    scan_sha256: string;
    scan: RuntimeToxinScanCacheValue;
}

interface ToxinSnapshotCacheDocument {
    payload: ToxinSnapshotCachePayload;
    payload_sha256: string;
}

interface ToxinSnapshotCacheAnchorPayload {
    schema_version: 1;
    orchestrator_root_sha256: string;
    runtime_generation: RuntimeMutationGenerationSnapshot;
    cache_document_sha256: string;
}

interface ToxinSnapshotCacheAnchorDocument {
    payload: ToxinSnapshotCacheAnchorPayload;
    payload_sha256: string;
}

export interface CollectRuntimeToxinScanWithCacheOptions {
    orchestratorRoot: string;
    runtimeRoot: string;
    cleanupMaxAgeDays: number;
    nowMs: number;
    cacheEnabled: boolean;
    /** Reuse a validated cache, but scan misses without locks or persistence. */
    readOnly?: boolean;
    collectFresh: () => RuntimeToxinScanCacheValue;
}

export class ToxinSnapshotCacheError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ToxinSnapshotCacheError';
    }
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
    const actualKeys = Object.keys(value).sort();
    return actualKeys.length === expectedKeys.length
        && actualKeys.every((key, index) => key === [...expectedKeys].sort()[index]);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizedRootIdentity(orchestratorRoot: string): string {
    const resolved = path.normalize(path.resolve(orchestratorRoot));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function rootIdentitySha256(orchestratorRoot: string): string {
    return sha256(normalizedRootIdentity(orchestratorRoot));
}

function retentionEpoch(nowMs: number): number {
    return Math.floor(nowMs / RETENTION_EPOCH_MS);
}

function retentionEpochEndMs(nowMs: number): number {
    return (retentionEpoch(nowMs) + 1) * RETENTION_EPOCH_MS;
}

function retentionValidUntilMs(nowMs: number, nextTransitionAtMs: number | null): number {
    const epochEnd = retentionEpochEndMs(nowMs);
    return nextTransitionAtMs === null ? epochEnd : Math.min(epochEnd, nextTransitionAtMs);
}

function generationMatches(
    left: RuntimeMutationGenerationSnapshot,
    right: RuntimeMutationGenerationSnapshot
): boolean {
    return left.generation === right.generation
        && left.transition_sequence === right.transition_sequence
        && left.state_sha256 === right.state_sha256;
}

function hasRuntimeGenerationEvidence(orchestratorRoot: string): boolean {
    const runtimeRoot = path.join(path.resolve(orchestratorRoot), 'runtime');
    try {
        return fs.readdirSync(runtimeRoot).some((entry) => entry.startsWith(RUNTIME_GENERATION_ARTIFACT_PREFIX));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

function readGenerationForCache(orchestratorRoot: string): RuntimeMutationGenerationSnapshot | null {
    const hadGenerationEvidence = hasRuntimeGenerationEvidence(orchestratorRoot);
    try {
        return readRuntimeMutationGeneration(orchestratorRoot);
    } catch (error) {
        if (
            error instanceof RuntimeMutationGenerationError
            && error.code === 'MISSING'
            && !hadGenerationEvidence
            && !hasRuntimeGenerationEvidence(orchestratorRoot)
        ) {
            return null;
        }
        throw error;
    }
}

function parseGeneration(value: unknown): RuntimeMutationGenerationSnapshot | null {
    if (!isRecord(value) || !hasExactKeys(value, [
        'schema_version',
        'generation',
        'transition_sequence',
        'state_sha256'
    ])) {
        return null;
    }
    if (
        value.schema_version !== 1
        || !isNonNegativeSafeInteger(value.generation)
        || !isNonNegativeSafeInteger(value.transition_sequence)
        || typeof value.state_sha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(value.state_sha256)
    ) {
        return null;
    }
    return {
        schema_version: 1,
        generation: value.generation,
        transition_sequence: value.transition_sequence,
        state_sha256: value.state_sha256
    };
}

function parseDiskSummaries(value: unknown): RuntimeToxinDiskSummary[] | null {
    if (!Array.isArray(value) || value.length > RUNTIME_TOXIN_SCAN_DIRECTORIES.length) return null;
    const directories = new Set<string>();
    const summaries: RuntimeToxinDiskSummary[] = [];
    let previousDirectoryIndex = -1;
    for (const entry of value) {
        if (!isRecord(entry) || !hasExactKeys(entry, ['directory', 'file_count', 'total_bytes'])) {
            return null;
        }
        if (
            typeof entry.directory !== 'string'
            || !entry.directory
            || directories.has(entry.directory)
            || !isNonNegativeSafeInteger(entry.file_count)
            || !isNonNegativeSafeInteger(entry.total_bytes)
        ) {
            return null;
        }
        const directoryIndex = RUNTIME_TOXIN_SCAN_DIRECTORIES.indexOf(entry.directory);
        if (directoryIndex <= previousDirectoryIndex) return null;
        previousDirectoryIndex = directoryIndex;
        directories.add(entry.directory);
        summaries.push({
            directory: entry.directory,
            file_count: entry.file_count,
            total_bytes: entry.total_bytes
        });
    }
    return summaries;
}

function parseScan(value: unknown): RuntimeToxinScanCacheValue | null {
    if (!isRecord(value) || !hasExactKeys(value, [
        'diskSummaries',
        'runtimeTotalBytes',
        'cleanupCandidateCount',
        'cleanupCandidateBytes',
        'noisyArtifactCount',
        'noisyArtifactBytes',
        'gateEventCount',
        'nextRetentionTransitionAtMs'
    ])) {
        return null;
    }
    const diskSummaries = parseDiskSummaries(value.diskSummaries);
    const integerFields = [
        value.runtimeTotalBytes,
        value.cleanupCandidateCount,
        value.cleanupCandidateBytes,
        value.noisyArtifactCount,
        value.noisyArtifactBytes,
        value.gateEventCount
    ];
    if (!diskSummaries || integerFields.some((field) => !isNonNegativeSafeInteger(field))) {
        return null;
    }
    if (
        value.nextRetentionTransitionAtMs !== null
        && !isNonNegativeSafeInteger(value.nextRetentionTransitionAtMs)
    ) {
        return null;
    }
    const diskTotal = diskSummaries.reduce((sum, summary) => sum + summary.total_bytes, 0);
    if (diskTotal !== value.runtimeTotalBytes) return null;
    return {
        diskSummaries,
        runtimeTotalBytes: value.runtimeTotalBytes as number,
        cleanupCandidateCount: value.cleanupCandidateCount as number,
        cleanupCandidateBytes: value.cleanupCandidateBytes as number,
        noisyArtifactCount: value.noisyArtifactCount as number,
        noisyArtifactBytes: value.noisyArtifactBytes as number,
        gateEventCount: value.gateEventCount as number,
        nextRetentionTransitionAtMs: value.nextRetentionTransitionAtMs as number | null
    };
}

function parsePayload(value: unknown): ToxinSnapshotCachePayload | null {
    if (!isRecord(value) || !hasExactKeys(value, [
        'schema_version',
        'orchestrator_root_sha256',
        'runtime_generation',
        'retention_epoch',
        'retention_valid_until_ms',
        'cleanup_max_age_days',
        'scanned_at_utc',
        'scan_sha256',
        'scan'
    ])) {
        return null;
    }
    const runtimeGeneration = parseGeneration(value.runtime_generation);
    const scan = parseScan(value.scan);
    if (
        value.schema_version !== CACHE_SCHEMA_VERSION
        || typeof value.orchestrator_root_sha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(value.orchestrator_root_sha256)
        || !runtimeGeneration
        || !isNonNegativeSafeInteger(value.retention_epoch)
        || !isNonNegativeSafeInteger(value.retention_valid_until_ms)
        || typeof value.cleanup_max_age_days !== 'number'
        || !Number.isFinite(value.cleanup_max_age_days)
        || value.cleanup_max_age_days < 0
        || typeof value.scanned_at_utc !== 'string'
        || !Number.isFinite(Date.parse(value.scanned_at_utc))
        || typeof value.scan_sha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(value.scan_sha256)
        || value.scan_sha256 !== sha256(JSON.stringify(value.scan))
        || !scan
    ) {
        return null;
    }
    return {
        schema_version: 1,
        orchestrator_root_sha256: value.orchestrator_root_sha256,
        runtime_generation: runtimeGeneration,
        retention_epoch: value.retention_epoch,
        retention_valid_until_ms: value.retention_valid_until_ms,
        cleanup_max_age_days: value.cleanup_max_age_days,
        scanned_at_utc: value.scanned_at_utc,
        scan_sha256: value.scan_sha256,
        scan
    };
}

export function resolveToxinSnapshotCachePath(runtimeRoot: string): string {
    return path.join(path.resolve(runtimeRoot), CACHE_FILE_NAME);
}

export function resolveToxinSnapshotCacheAnchorPath(runtimeRoot: string): string {
    return path.join(path.resolve(runtimeRoot), CACHE_ANCHOR_FILE_NAME);
}

function resolveToxinSnapshotCacheBuildLockPath(runtimeRoot: string): string {
    return path.join(path.resolve(runtimeRoot), CACHE_BUILD_LOCK_NAME);
}

function hasValidCacheAnchor(
    anchorPath: string,
    cacheDocument: Record<string, unknown>,
    orchestratorRoot: string,
    generation: RuntimeMutationGenerationSnapshot
): boolean {
    try {
        const stat = fs.lstatSync(anchorPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CACHE_ANCHOR_FILE_BYTES) return false;
        const parsed = JSON.parse(fs.readFileSync(anchorPath, 'utf8')) as unknown;
        if (!isRecord(parsed) || !hasExactKeys(parsed, ['payload', 'payload_sha256'])) return false;
        if (!isRecord(parsed.payload) || !hasExactKeys(parsed.payload, [
            'schema_version',
            'orchestrator_root_sha256',
            'runtime_generation',
            'cache_document_sha256'
        ])) {
            return false;
        }
        if (
            typeof parsed.payload_sha256 !== 'string'
            || parsed.payload_sha256 !== sha256(JSON.stringify(parsed.payload))
        ) {
            return false;
        }
        const anchorGeneration = parseGeneration(parsed.payload.runtime_generation);
        return parsed.payload.schema_version === CACHE_SCHEMA_VERSION
            && parsed.payload.orchestrator_root_sha256 === rootIdentitySha256(orchestratorRoot)
            && typeof parsed.payload.cache_document_sha256 === 'string'
            && parsed.payload.cache_document_sha256 === sha256(JSON.stringify(cacheDocument))
            && anchorGeneration !== null
            && generationMatches(anchorGeneration, generation);
    } catch {
        return false;
    }
}

function readReusableCache(
    cachePath: string,
    orchestratorRoot: string,
    generation: RuntimeMutationGenerationSnapshot,
    cleanupMaxAgeDays: number,
    nowMs: number
): RuntimeToxinScanCacheValue | null {
    try {
        const stat = fs.lstatSync(cachePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CACHE_FILE_BYTES) {
            return null;
        }
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as unknown;
        if (!isRecord(parsed) || !hasExactKeys(parsed, ['payload', 'payload_sha256'])) {
            return null;
        }
        if (typeof parsed.payload_sha256 !== 'string') return null;
        if (sha256(JSON.stringify(parsed.payload)) !== parsed.payload_sha256) return null;
        const payload = parsePayload(parsed.payload);
        if (!payload) return null;
        if (payload.orchestrator_root_sha256 !== rootIdentitySha256(orchestratorRoot)) return null;
        if (!generationMatches(payload.runtime_generation, generation)) return null;
        if (!hasValidCacheAnchor(
            resolveToxinSnapshotCacheAnchorPath(path.dirname(cachePath)),
            parsed,
            orchestratorRoot,
            generation
        )) {
            return null;
        }
        if (payload.cleanup_max_age_days !== cleanupMaxAgeDays) return null;
        if (payload.retention_epoch !== retentionEpoch(nowMs)) return null;
        if (nowMs >= payload.retention_valid_until_ms) return null;
        return payload.scan;
    } catch {
        return null;
    }
}

function persistCacheBestEffort(
    cachePath: string,
    orchestratorRoot: string,
    generation: RuntimeMutationGenerationSnapshot,
    cleanupMaxAgeDays: number,
    nowMs: number,
    scan: RuntimeToxinScanCacheValue
): void {
    try {
        const anchorPath = resolveToxinSnapshotCacheAnchorPath(path.dirname(cachePath));
        for (const targetPath of [cachePath, anchorPath]) {
            if (!fs.existsSync(targetPath)) continue;
            const stat = fs.lstatSync(targetPath);
            if (!stat.isFile() || stat.isSymbolicLink()) return;
        }
        const payload: ToxinSnapshotCachePayload = {
            schema_version: 1,
            orchestrator_root_sha256: rootIdentitySha256(orchestratorRoot),
            runtime_generation: generation,
            retention_epoch: retentionEpoch(nowMs),
            retention_valid_until_ms: retentionValidUntilMs(nowMs, scan.nextRetentionTransitionAtMs),
            cleanup_max_age_days: cleanupMaxAgeDays,
            scanned_at_utc: new Date(nowMs).toISOString(),
            scan_sha256: sha256(JSON.stringify(scan)),
            scan
        };
        const document: ToxinSnapshotCacheDocument = {
            payload,
            payload_sha256: sha256(JSON.stringify(payload))
        };
        writeFileAtomically(cachePath, `${JSON.stringify(document)}\n`, { encoding: 'utf8' });
        const anchorPayload: ToxinSnapshotCacheAnchorPayload = {
            schema_version: 1,
            orchestrator_root_sha256: rootIdentitySha256(orchestratorRoot),
            runtime_generation: generation,
            cache_document_sha256: sha256(JSON.stringify(document))
        };
        const anchorDocument: ToxinSnapshotCacheAnchorDocument = {
            payload: anchorPayload,
            payload_sha256: sha256(JSON.stringify(anchorPayload))
        };
        writeFileAtomically(anchorPath, `${JSON.stringify(anchorDocument)}\n`, { encoding: 'utf8' });
    } catch {
        // Rebuildable cache persistence must never hide a canonical scan result.
    }
}

export function collectRuntimeToxinScanWithCache(
    options: CollectRuntimeToxinScanWithCacheOptions
): RuntimeToxinScanCacheValue {
    if (!options.cacheEnabled) return options.collectFresh();
    const cachePath = resolveToxinSnapshotCachePath(options.runtimeRoot);
    const initialGeneration = readGenerationForCache(options.orchestratorRoot);
    if (!initialGeneration) return options.collectFresh();
    const readConfirmedCache = (
        generation: RuntimeMutationGenerationSnapshot
    ): RuntimeToxinScanCacheValue | null => {
        const cached = readReusableCache(
            cachePath,
            options.orchestratorRoot,
            generation,
            options.cleanupMaxAgeDays,
            options.nowMs
        );
        if (!cached) return null;
        const confirmedGeneration = readGenerationForCache(options.orchestratorRoot);
        if (!confirmedGeneration) {
            throw new ToxinSnapshotCacheError(
                'Runtime mutation generation disappeared while validating the toxin snapshot cache.'
            );
        }
        return generationMatches(generation, confirmedGeneration) ? cached : null;
    };
    const cached = readConfirmedCache(initialGeneration);
    if (cached) return cached;
    if (options.readOnly) return options.collectFresh();

    return withFilesystemLock(
        resolveToxinSnapshotCacheBuildLockPath(options.runtimeRoot),
        {
            timeoutMs: CACHE_BUILD_LOCK_TIMEOUT_MS,
            retryMs: CACHE_BUILD_LOCK_RETRY_MS,
            staleMs: CACHE_BUILD_LOCK_STALE_MS,
            ownerLabel: 'toxin-snapshot-cache-build'
        },
        () => {
            const generationAfterLock = readGenerationForCache(options.orchestratorRoot);
            if (!generationAfterLock) return options.collectFresh();
            const cacheAfterLock = readConfirmedCache(generationAfterLock);
            if (cacheAfterLock) return cacheAfterLock;

            for (let attempt = 0; attempt < MAX_STABLE_SCAN_ATTEMPTS; attempt += 1) {
                const generationBefore = readGenerationForCache(options.orchestratorRoot);
                if (!generationBefore) return options.collectFresh();
                const scan = options.collectFresh();
                const generationAfter = readGenerationForCache(options.orchestratorRoot);
                if (!generationAfter) return options.collectFresh();
                if (!generationMatches(generationBefore, generationAfter)) continue;
                persistCacheBestEffort(
                    cachePath,
                    options.orchestratorRoot,
                    generationAfter,
                    options.cleanupMaxAgeDays,
                    options.nowMs,
                    scan
                );
                return scan;
            }
            throw new ToxinSnapshotCacheError(
                `Runtime generation changed during ${MAX_STABLE_SCAN_ATTEMPTS} consecutive toxin scans.`
            );
        }
    ).result;
}
