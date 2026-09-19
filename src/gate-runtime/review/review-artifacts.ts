import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../../core/filesystem';
import { redactSecretText, serializeRedactedJson } from '../../core/redaction';
import { fileSha256 } from '../hash';
import {
    acquireFilesystemLock,
    acquireFilesystemLockAsync,
    filesystemLockRequiresExplicitForeignHostRecovery,
    FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV,
    inspectFilesystemLock,
    isForeignHostFilesystemLockRecoveryAllowed,
    reclaimStaleFilesystemLock,
    releaseFilesystemLock
} from '../timeline/task-events';
import {
    beginInProcessReviewTransactionSnapshot,
    currentProcessOwnsReviewTransactionLock,
    parseReviewArtifactFileName,
    rebuildAndPersistIndex,
    resolveIndexPath,
    resolveReviewTransactionLockPath,
    type ReviewsIndexMutationStatus,
    upsertEntry
} from './reviews-index';
import { isLowNoiseRuntimeWritesEnabled } from '../derived-runtime-writes';
import {
    abortRuntimeMutationGeneration,
    beginRuntimeMutationGeneration,
    commitRuntimeMutationGeneration,
    resolveOrchestratorRootFromRuntimePath,
    type RuntimeMutationGenerationTicket
} from '../runtime-mutation-generation';

const DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS = 25;
const DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS = 30 * 1000;
const DEFAULT_REVIEW_ARTIFACT_SNAPSHOT_MAX_ARTIFACTS = 4096;
const DEFAULT_REVIEW_ARTIFACT_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const REVIEWS_INDEX_FILE_NAME = 'reviews-index.json';
const inProcessReviewLockQueues = new Map<string, Promise<void>>();

interface ReviewArtifactReadSnapshotState {
    depth: number;
    rootPath: string;
    realRootPath: string;
    reads: Map<string, CachedReviewArtifactRead>;
    retainedBytes: number;
    maxArtifacts: number;
    maxBytes: number;
    budgetError: ReviewArtifactReadBudgetError | null;
}

const inProcessReviewArtifactReadSnapshots = new Map<string, ReviewArtifactReadSnapshotState>();

interface CachedReviewArtifactRead {
    content: Buffer | null;
    identity?: fs.Stats;
    sha256: string | null;
    valid: boolean;
}

export interface ReviewArtifactFileReadSnapshot {
    active: boolean;
    content: Buffer | null;
    sha256: string | null;
    valid: boolean;
}

export interface ReviewArtifactJsonReadSnapshot {
    active: boolean;
    sha256: string | null;
    valid: boolean;
    value: unknown;
}

export interface ReviewArtifactTextReadSnapshot {
    active: boolean;
    sha256: string | null;
    valid: boolean;
    value: string | null;
}

export interface ReviewArtifactLockOptions {
    lockTimeoutMs?: unknown;
    lockRetryMs?: unknown;
    lockStaleMs?: unknown;
    allowForeignHostStaleRecovery?: unknown;
    requireIndexUpdate?: unknown;
    excludeCompletionFinalizationLocks?: unknown;
    runtimeWritesMode?: unknown;
    lowNoiseRuntimeWrites?: unknown;
    snapshotMaxArtifacts?: unknown;
    snapshotMaxBytes?: unknown;
}

export class ReviewArtifactReadBudgetError extends Error {
    readonly code: 'ARTIFACT_COUNT_EXCEEDED' | 'BYTE_LIMIT_EXCEEDED';

    constructor(code: ReviewArtifactReadBudgetError['code'], message: string) {
        super(message);
        this.name = 'ReviewArtifactReadBudgetError';
        this.code = code;
    }
}

export interface ReviewArtifactLockTelemetry {
    retries: number;
    elapsedMs: number;
}

export interface ReviewArtifactWriteResult {
    artifact_path: string;
    lock_path: string;
    telemetry: ReviewArtifactLockTelemetry;
    index_update_status: ReviewsIndexMutationStatus;
    index_path: string;
    index_update_error?: string;
}

export interface ReviewArtifactRollbackState {
    existed: boolean;
    content: string | null;
}

export type ReviewArtifactLockStatus = 'ACTIVE' | 'STALE';

export interface ReviewArtifactLockHealth {
    lock_name: string;
    lock_path: string;
    artifact_path: string;
    task_id: string | null;
    artifact_type: string | null;
    status: ReviewArtifactLockStatus;
    age_ms: number | null;
    owner_pid: number | null;
    owner_hostname: string | null;
    owner_created_at_utc: string | null;
    owner_alive: boolean | null;
    owner_metadata_status: 'missing' | 'invalid_json' | 'invalid_shape' | 'ok';
    stale_reason: 'owner_dead' | 'age_exceeded' | null;
    remediation: string;
}

export interface ReviewArtifactLockScanResult {
    lock_root: string;
    subsystem_scope_note: string;
    locks: ReviewArtifactLockHealth[];
    active_count: number;
    stale_count: number;
}

export interface ReviewArtifactLockCleanupResult {
    lock_root: string;
    dry_run: boolean;
    removed_locks: string[];
    removable_stale_locks: string[];
    retained_live_locks: string[];
    failed_locks: string[];
    warnings: string[];
}

const REVIEW_ARTIFACT_LOCK_SUBSYSTEM_NOTE =
    'Review-artifact locks under runtime/reviews/*.lock plus shared runtime/.reviews-index.lock and runtime/.reviews-transaction.lock participate in the review-artifact lock subsystem.';

interface ReviewArtifactLockTarget {
    lockName: string;
    lockPath: string;
    artifactPath: string;
    taskId: string | null;
    artifactType: string | null;
}

function getReviewArtifactLockStaleMs(options: ReviewArtifactLockOptions): number {
    const parsed = Number.parseInt(String(options.lockStaleMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS;
}

function getReviewsRoot(orchestratorRoot: string): string {
    return path.join(orchestratorRoot, 'runtime', 'reviews');
}

function listReviewArtifactLockEntries(lockRoot: string): string[] {
    if (!fs.existsSync(lockRoot) || !fs.statSync(lockRoot).isDirectory()) {
        return [];
    }
    return fs.readdirSync(lockRoot)
        .filter((entryName) => {
            if (!entryName.endsWith('.lock')) {
                return false;
            }
            const fullPath = path.join(lockRoot, entryName);
            try {
                return fs.statSync(fullPath).isDirectory();
            } catch {
                return false;
            }
        })
        .sort();
}

function parseStandaloneReviewLockTaskId(artifactName: string): { taskId: string; artifactType: string } | null {
    const completionGateMatch = /^(T-.+)-completion-gate$/.exec(artifactName);
    if (!completionGateMatch || !completionGateMatch[1]) {
        return null;
    }
    return {
        taskId: completionGateMatch[1],
        artifactType: 'completion-gate'
    };
}

function buildReviewArtifactLockRemediation(entryName: string, ownerPid: number | null, staleReason: 'owner_dead' | 'age_exceeded' | null): string {
    if (staleReason === 'age_exceeded') {
        return [
            `Verify the remote owner is gone, then rerun with ${FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV}=1 and 'garda doctor --target-root "." --cleanup-stale-locks --dry-run' before applying cleanup for '${entryName}'.`,
            'Do not delete live review-artifact locks manually.'
        ].join(' ');
    }
    if (staleReason) {
        return [
            `Run 'garda doctor --target-root "." --cleanup-stale-locks --dry-run' first, then rerun without '--dry-run' if the review-artifact lock candidate list looks correct.`,
            'Only proven-stale review-artifact locks under runtime/reviews/*.lock are cleaned automatically.'
        ].join(' ');
    }
    return [
        `Wait for the owning process to release '${entryName}' or terminate PID ${ownerPid === null ? 'unknown' : String(ownerPid)} safely if it is hung.`,
        'Do not delete live review-artifact locks manually.'
    ].join(' ');
}

function resolveReviewArtifactLockTarget(lockRoot: string, entryName: string): ReviewArtifactLockTarget {
    const lockPath = path.join(lockRoot, entryName);
    const artifactName = entryName.slice(0, -'.lock'.length);
    const parsed = parseReviewArtifactFileName(artifactName) || parseStandaloneReviewLockTaskId(artifactName);
    return {
        lockName: entryName,
        lockPath: lockPath.replace(/\\/g, '/'),
        artifactPath: path.join(lockRoot, artifactName).replace(/\\/g, '/'),
        taskId: parsed?.taskId ?? null,
        artifactType: parsed?.artifactType ?? null
    };
}

function resolveSharedReviewsIndexLockTarget(orchestratorRoot: string): ReviewArtifactLockTarget | null {
    const reviewsRoot = getReviewsRoot(orchestratorRoot);
    const lockPath = path.join(path.dirname(reviewsRoot), '.reviews-index.lock');
    try {
        if (!fs.existsSync(lockPath) || !fs.statSync(lockPath).isDirectory()) {
            return null;
        }
    } catch {
        return null;
    }
    return {
        lockName: path.basename(lockPath),
        lockPath: lockPath.replace(/\\/g, '/'),
        artifactPath: path.join(reviewsRoot, REVIEWS_INDEX_FILE_NAME).replace(/\\/g, '/'),
        taskId: null,
        artifactType: 'reviews-index'
    };
}

function resolveSharedReviewTransactionLockTarget(orchestratorRoot: string): ReviewArtifactLockTarget | null {
    const reviewsRoot = getReviewsRoot(orchestratorRoot);
    const lockPath = resolveReviewTransactionLockPath(reviewsRoot);
    try {
        if (!fs.existsSync(lockPath) || !fs.statSync(lockPath).isDirectory()) {
            return null;
        }
    } catch {
        return null;
    }
    return {
        lockName: path.basename(lockPath),
        lockPath: lockPath.replace(/\\/g, '/'),
        artifactPath: reviewsRoot.replace(/\\/g, '/'),
        taskId: null,
        artifactType: 'reviews-transaction'
    };
}

function resolveReviewArtifactLockTargets(orchestratorRoot: string): ReviewArtifactLockTarget[] {
    const reviewsRoot = getReviewsRoot(orchestratorRoot);
    const targets = listReviewArtifactLockEntries(reviewsRoot)
        .map((entryName) => resolveReviewArtifactLockTarget(reviewsRoot, entryName));
    const sharedIndexLock = resolveSharedReviewsIndexLockTarget(orchestratorRoot);
    if (sharedIndexLock) {
        targets.push(sharedIndexLock);
    }
    const sharedTransactionLock = resolveSharedReviewTransactionLockTarget(orchestratorRoot);
    if (sharedTransactionLock) {
        targets.push(sharedTransactionLock);
    }
    return targets.sort((left, right) => left.lockName.localeCompare(right.lockName));
}

function buildReviewArtifactLockHealth(target: ReviewArtifactLockTarget, options: ReviewArtifactLockOptions): ReviewArtifactLockHealth | null {
    const inspection = inspectFilesystemLock(target.lockPath, {
        staleMs: getReviewArtifactLockStaleMs(options),
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
    });
    if (!inspection.exists) {
        return null;
    }

    return {
        lock_name: target.lockName,
        lock_path: target.lockPath,
        artifact_path: target.artifactPath,
        task_id: target.taskId,
        artifact_type: target.artifactType,
        status: inspection.staleReason ? 'STALE' : 'ACTIVE',
        age_ms: inspection.ageMs,
        owner_pid: inspection.metadata.pid,
        owner_hostname: inspection.metadata.hostname,
        owner_created_at_utc: inspection.metadata.created_at_utc,
        owner_alive: inspection.ownerAlive,
        owner_metadata_status: inspection.metadata.metadata_status,
        stale_reason: inspection.staleReason,
        remediation: buildReviewArtifactLockRemediation(target.lockName, inspection.metadata.pid, inspection.staleReason)
    };
}

export function scanReviewArtifactLocks(orchestratorRoot: string, options: ReviewArtifactLockOptions = {}): ReviewArtifactLockScanResult {
    const lockRoot = getReviewsRoot(orchestratorRoot);
    const locks = resolveReviewArtifactLockTargets(orchestratorRoot)
        .map((target) => buildReviewArtifactLockHealth(target, options))
        .filter((lock): lock is ReviewArtifactLockHealth => lock !== null);

    return {
        lock_root: lockRoot.replace(/\\/g, '/'),
        subsystem_scope_note: REVIEW_ARTIFACT_LOCK_SUBSYSTEM_NOTE,
        locks,
        active_count: locks.filter((lock) => lock.status === 'ACTIVE').length,
        stale_count: locks.filter((lock) => lock.status === 'STALE').length
    };
}

export function cleanupStaleReviewArtifactLocks(
    orchestratorRoot: string,
    options: ReviewArtifactLockOptions & { dryRun?: boolean } = {}
): ReviewArtifactLockCleanupResult {
    const dryRun = options.dryRun === true;
    const lockRoot = getReviewsRoot(orchestratorRoot);
    const staleMs = getReviewArtifactLockStaleMs(options);
    const foreignHostRecoveryAllowed = isForeignHostFilesystemLockRecoveryAllowed({
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
    });
    const removableStaleLocks: string[] = [];
    const retainedLiveLocks: string[] = [];
    const removedLocks: string[] = [];
    const failedLocks: string[] = [];
    const warnings: string[] = [];

    for (const target of resolveReviewArtifactLockTargets(orchestratorRoot)) {
        if (options.excludeCompletionFinalizationLocks === true && target.artifactType === 'completion-gate') {
            continue;
        }
        const inspection = inspectFilesystemLock(target.lockPath, {
            staleMs,
            allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
        });
        if (!inspection.exists) {
            continue;
        }

        if (!inspection.staleReason) {
            retainedLiveLocks.push(target.lockName);
            continue;
        }

        if (filesystemLockRequiresExplicitForeignHostRecovery(inspection) && !foreignHostRecoveryAllowed) {
            retainedLiveLocks.push(target.lockName);
            warnings.push(
                `Skipped aged foreign-host review-artifact lock '${target.lockName}': rerun cleanup with ${FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV}=1 after verifying the remote owner is gone.`
            );
            continue;
        }

        removableStaleLocks.push(target.lockName);
        if (dryRun) {
            continue;
        }

        try {
            const removalAttempt = reclaimStaleFilesystemLock(target.lockPath, {
                staleMs,
                allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
            });
            if (removalAttempt.removed) {
                removedLocks.push(target.lockName);
                continue;
            }

            const refreshed = inspectFilesystemLock(target.lockPath, {
                staleMs,
                allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
            });
            if (!refreshed.exists) {
                continue;
            }
            if (!refreshed.staleReason) {
                retainedLiveLocks.push(target.lockName);
                continue;
            }

            failedLocks.push(target.lockName);
            warnings.push(`Failed to remove stale review-artifact lock '${target.lockName}': stale candidate changed before cleanup could claim it safely.`);
        } catch (error: unknown) {
            failedLocks.push(target.lockName);
            warnings.push(`Failed to remove stale review-artifact lock '${target.lockName}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return {
        lock_root: lockRoot.replace(/\\/g, '/'),
        dry_run: dryRun,
        removed_locks: removedLocks,
        removable_stale_locks: removableStaleLocks,
        retained_live_locks: retainedLiveLocks,
        failed_locks: failedLocks,
        warnings
    };
}

export function getReviewArtifactLockPath(artifactPath: string): string {
    return `${artifactPath}.lock`;
}

export function getReviewArtifactTransactionLockPath(reviewsDir: string): string {
    return resolveReviewTransactionLockPath(reviewsDir);
}

function parseBooleanLike(value: unknown): boolean {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function shouldRequireIndexUpdate(options: ReviewArtifactLockOptions): boolean {
    return parseBooleanLike(options.requireIndexUpdate);
}

export function writeArtifactFileAtomically(filePath: string, content: string): string {
    return writeFileAtomically(filePath, content, { encoding: 'utf8' });
}

export function assertReviewArtifactFileSha256(
    artifactPath: string,
    expectedSha256: string | null | undefined,
    subject: string
): void {
    const normalizedExpected = String(expectedSha256 || '').trim().toLowerCase();
    if (!normalizedExpected) {
        return;
    }
    if (!/^[0-9a-f]{64}$/u.test(normalizedExpected)) {
        throw new Error(`${subject} expected sha256 is invalid: '${normalizedExpected}'.`);
    }
    const actualSha256 = fileSha256(artifactPath);
    if (actualSha256 !== normalizedExpected) {
        throw new Error(
            `${subject} sha256 mismatch after persistence: expected ${normalizedExpected}, ` +
            `found ${actualSha256 || 'missing'} at '${artifactPath.replace(/\\/g, '/')}'.`
        );
    }
}

export function withReviewArtifactLock<T>(
    artifactPath: string,
    callback: () => T,
    options: ReviewArtifactLockOptions = {}
): { result: T; lock_path: string; telemetry: ReviewArtifactLockTelemetry } {
    const lockPath = getReviewArtifactLockPath(artifactPath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const { handle, telemetry } = acquireFilesystemLock(lockPath, {
        timeoutMs: options.lockTimeoutMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS,
        retryMs: options.lockRetryMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS,
        staleMs: options.lockStaleMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS,
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
    });
    try {
        return {
            result: callback(),
            lock_path: lockPath,
            telemetry
        };
    } finally {
        releaseFilesystemLock(handle);
    }
}

export async function withReviewArtifactLockAsync<T>(
    artifactPath: string,
    callback: () => Promise<T>,
    options: ReviewArtifactLockOptions = {}
): Promise<{ result: T; lock_path: string; telemetry: ReviewArtifactLockTelemetry }> {
    const lockPath = getReviewArtifactLockPath(artifactPath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    return await withInProcessReviewLockQueue(lockPath, async () => {
        const { handle, telemetry } = await acquireFilesystemLockAsync(lockPath, {
            timeoutMs: options.lockTimeoutMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS,
            retryMs: options.lockRetryMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS,
            staleMs: options.lockStaleMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS,
            allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery,
            ownerLabel: 'review-artifact'
        });
        try {
            return {
                result: await callback(),
                lock_path: lockPath,
                telemetry
            };
        } finally {
            releaseFilesystemLock(handle);
        }
    });
}

function withReviewArtifactTransactionLock<T>(
    reviewsDir: string,
    callback: () => T,
    options: ReviewArtifactLockOptions = {}
): { result: T; lock_path: string; telemetry: ReviewArtifactLockTelemetry } {
    const lockPath = resolveReviewTransactionLockPath(reviewsDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const { handle, telemetry } = acquireFilesystemLock(lockPath, {
        timeoutMs: options.lockTimeoutMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS,
        retryMs: options.lockRetryMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS,
        staleMs: options.lockStaleMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS,
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery,
        ownerLabel: 'review-artifact-transaction'
    });
    try {
        return {
            result: callback(),
            lock_path: lockPath,
            telemetry
        };
    } finally {
        releaseFilesystemLock(handle);
    }
}

function normalizeReviewArtifactReadSnapshotKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInsideReviewArtifactSnapshot(candidatePath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameReviewArtifactFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}

function freezeReviewArtifactJson(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }
    for (const nested of Object.values(value)) {
        freezeReviewArtifactJson(nested);
    }
    return Object.freeze(value);
}

function positiveReviewArtifactSnapshotLimit(value: unknown, fallback: number): number {
    const parsed = Number(value ?? fallback);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function withReviewArtifactReadSnapshot<T>(
    reviewsDir: string,
    callback: () => T,
    options: ReviewArtifactLockOptions = {}
): T {
    const rootPath = path.resolve(reviewsDir);
    const snapshotKey = normalizeReviewArtifactReadSnapshotKey(rootPath);
    const existing = inProcessReviewArtifactReadSnapshots.get(snapshotKey);
    if (existing) {
        existing.depth += 1;
        try {
            return callback();
        } finally {
            existing.depth -= 1;
        }
    }

    let realRootPath = rootPath;
    try {
        realRootPath = fs.realpathSync.native(rootPath);
    } catch {
        // Missing roots remain bounded by their resolved lexical path.
    }
    const snapshot = {
        depth: 1,
        rootPath,
        realRootPath,
        reads: new Map<string, CachedReviewArtifactRead>(),
        retainedBytes: 0,
        maxArtifacts: positiveReviewArtifactSnapshotLimit(
            options.snapshotMaxArtifacts,
            DEFAULT_REVIEW_ARTIFACT_SNAPSHOT_MAX_ARTIFACTS
        ),
        maxBytes: positiveReviewArtifactSnapshotLimit(
            options.snapshotMaxBytes,
            DEFAULT_REVIEW_ARTIFACT_SNAPSHOT_MAX_BYTES
        ),
        budgetError: null
    };
    inProcessReviewArtifactReadSnapshots.set(snapshotKey, snapshot);
    try {
        const result = callback();
        if (snapshot.budgetError) {
            throw snapshot.budgetError;
        }
        return result;
    } finally {
        snapshot.depth -= 1;
        if (snapshot.depth <= 0) {
            inProcessReviewArtifactReadSnapshots.delete(snapshotKey);
        }
    }
}

function findReviewArtifactReadSnapshot(filePath: string): ReviewArtifactReadSnapshotState | null {
    const resolvedPath = path.resolve(filePath);
    let bestMatch: ReviewArtifactReadSnapshotState | null = null;
    for (const snapshot of inProcessReviewArtifactReadSnapshots.values()) {
        if (
            isPathInsideReviewArtifactSnapshot(resolvedPath, snapshot.rootPath)
            && (!bestMatch || snapshot.rootPath.length > bestMatch.rootPath.length)
        ) {
            bestMatch = snapshot;
        }
    }
    return bestMatch;
}

function invalidReviewArtifactRead(active: boolean): ReviewArtifactFileReadSnapshot {
    return { active, content: null, sha256: null, valid: false };
}

function cacheInvalidReviewArtifactRead(
    snapshot: ReviewArtifactReadSnapshotState,
    cacheKey: string
): ReviewArtifactFileReadSnapshot {
    const invalid = invalidReviewArtifactRead(true);
    snapshot.reads.set(cacheKey, {
        content: null,
        sha256: null,
        valid: false
    });
    return invalid;
}

function invalidateCachedReviewArtifactRead(
    snapshot: ReviewArtifactReadSnapshotState,
    cached: CachedReviewArtifactRead
): void {
    if (cached.content) {
        snapshot.retainedBytes -= cached.content.length;
    }
    cached.content = null;
    cached.sha256 = null;
    cached.valid = false;
}

function failReviewArtifactReadBudget(
    snapshot: ReviewArtifactReadSnapshotState,
    code: ReviewArtifactReadBudgetError['code'],
    message: string
): never {
    const error = snapshot.budgetError || new ReviewArtifactReadBudgetError(code, message);
    snapshot.budgetError = error;
    throw error;
}

function assertReviewArtifactCountBudget(snapshot: ReviewArtifactReadSnapshotState): void {
    if (snapshot.reads.size >= snapshot.maxArtifacts) {
        failReviewArtifactReadBudget(
            snapshot,
            'ARTIFACT_COUNT_EXCEEDED',
            `Review artifact read snapshot exceeds the ${snapshot.maxArtifacts}-artifact limit.`
        );
    }
}

function assertReviewArtifactByteBudget(snapshot: ReviewArtifactReadSnapshotState, nextBytes: number): void {
    if (
        !Number.isSafeInteger(nextBytes)
        || nextBytes < 0
        || nextBytes > snapshot.maxBytes - snapshot.retainedBytes
    ) {
        failReviewArtifactReadBudget(
            snapshot,
            'BYTE_LIMIT_EXCEEDED',
            `Review artifact read snapshot exceeds the ${snapshot.maxBytes}-byte aggregate limit.`
        );
    }
}

function readReviewArtifactBytesBounded(filePath: string, identity: fs.Stats): Buffer | null {
    const handle = fs.openSync(filePath, 'r');
    try {
        const openedIdentity = fs.fstatSync(handle);
        if (!sameReviewArtifactFileIdentity(identity, openedIdentity)) {
            return null;
        }
        const content = Buffer.allocUnsafe(identity.size);
        let offset = 0;
        while (offset < content.length) {
            const bytesRead = fs.readSync(handle, content, offset, content.length - offset, offset);
            if (bytesRead === 0) {
                return null;
            }
            offset += bytesRead;
        }
        const afterReadIdentity = fs.fstatSync(handle);
        return sameReviewArtifactFileIdentity(openedIdentity, afterReadIdentity) ? content : null;
    } finally {
        fs.closeSync(handle);
    }
}

function readReviewArtifactCanonicalSnapshot(filePath: string): ReviewArtifactFileReadSnapshot {
    const resolvedPath = path.resolve(filePath);
    const snapshot = findReviewArtifactReadSnapshot(resolvedPath);
    if (!snapshot) {
        return invalidReviewArtifactRead(false);
    }
    const cacheKey = normalizeReviewArtifactReadSnapshotKey(resolvedPath);
    const cached = snapshot.reads.get(cacheKey);
    if (cached) {
        if (cached.valid) {
            try {
                const currentIdentity = fs.lstatSync(resolvedPath);
                if (!cached.identity || !sameReviewArtifactFileIdentity(cached.identity, currentIdentity)) {
                    invalidateCachedReviewArtifactRead(snapshot, cached);
                }
            } catch {
                invalidateCachedReviewArtifactRead(snapshot, cached);
            }
        }
        return {
            active: true,
            content: cached.content,
            sha256: cached.sha256,
            valid: cached.valid
        };
    }

    assertReviewArtifactCountBudget(snapshot);
    try {
        const beforeRead = fs.lstatSync(resolvedPath);
        if (!beforeRead.isFile() || beforeRead.isSymbolicLink()) {
            return cacheInvalidReviewArtifactRead(snapshot, cacheKey);
        }
        const realPath = fs.realpathSync.native(resolvedPath);
        if (!isPathInsideReviewArtifactSnapshot(realPath, snapshot.realRootPath)) {
            return cacheInvalidReviewArtifactRead(snapshot, cacheKey);
        }
        assertReviewArtifactByteBudget(snapshot, beforeRead.size);
        const content = readReviewArtifactBytesBounded(resolvedPath, beforeRead);
        if (!content) {
            return cacheInvalidReviewArtifactRead(snapshot, cacheKey);
        }
        const afterRead = fs.lstatSync(resolvedPath);
        if (!sameReviewArtifactFileIdentity(beforeRead, afterRead)) {
            return cacheInvalidReviewArtifactRead(snapshot, cacheKey);
        }
        const sha256 = createHash('sha256').update(content).digest('hex').toLowerCase();
        snapshot.reads.set(cacheKey, {
            content,
            identity: afterRead,
            sha256,
            valid: true
        });
        snapshot.retainedBytes += content.length;
        return { active: true, content, sha256, valid: true };
    } catch (error: unknown) {
        if (error instanceof ReviewArtifactReadBudgetError) {
            throw error;
        }
        return cacheInvalidReviewArtifactRead(snapshot, cacheKey);
    }
}

export function readReviewArtifactFileSnapshot(filePath: string): ReviewArtifactFileReadSnapshot {
    const snapshot = readReviewArtifactCanonicalSnapshot(filePath);
    return {
        ...snapshot,
        content: snapshot.content ? Buffer.from(snapshot.content) : null
    };
}

export function readReviewArtifactTextFile(filePath: string): string {
    const snapshot = readReviewArtifactTextSnapshot(filePath);
    if (snapshot.active) {
        if (!snapshot.valid || snapshot.value === null) {
            throw new Error(`Review artifact text snapshot is unavailable: ${path.resolve(filePath)}`);
        }
        return snapshot.value;
    }
    return fs.readFileSync(filePath, 'utf8');
}

export function readReviewArtifactTextSnapshot(filePath: string): ReviewArtifactTextReadSnapshot {
    const fileSnapshot = readReviewArtifactCanonicalSnapshot(filePath);
    return {
        active: fileSnapshot.active,
        sha256: fileSnapshot.sha256,
        valid: fileSnapshot.valid && fileSnapshot.content !== null,
        value: fileSnapshot.valid && fileSnapshot.content !== null
            ? fileSnapshot.content.toString('utf8')
            : null
    };
}

export function readReviewArtifactFileSha256(filePath: string): string | null {
    const snapshot = readReviewArtifactCanonicalSnapshot(filePath);
    if (snapshot.active) {
        return snapshot.valid ? snapshot.sha256 : null;
    }
    return fileSha256(filePath);
}

export function readReviewArtifactJsonSnapshot(filePath: string): ReviewArtifactJsonReadSnapshot {
    const fileSnapshot = readReviewArtifactCanonicalSnapshot(filePath);
    if (!fileSnapshot.active || !fileSnapshot.valid || !fileSnapshot.content) {
        return {
            active: fileSnapshot.active,
            sha256: fileSnapshot.sha256,
            valid: false,
            value: null
        };
    }
    try {
        return {
            active: true,
            sha256: fileSnapshot.sha256,
            valid: true,
            value: freezeReviewArtifactJson(JSON.parse(fileSnapshot.content.toString('utf8')) as unknown)
        };
    } catch {
        return {
            active: true,
            sha256: fileSnapshot.sha256,
            valid: false,
            value: null
        };
    }
}

export function readReviewArtifactJsonFile(filePath: string): unknown {
    const snapshot = readReviewArtifactJsonSnapshot(filePath);
    if (snapshot.active) {
        if (!snapshot.valid) {
            throw new Error(`Review artifact JSON snapshot is unavailable: ${path.resolve(filePath)}`);
        }
        return snapshot.value;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

interface ReviewArtifactGenerationCapture {
    reviewsDirectoryIdentity: fs.Stats | null;
    indexIdentity: fs.Stats | null;
}

function captureOptionalReviewArtifactIdentity(targetPath: string): fs.Stats | null {
    try {
        return fs.lstatSync(targetPath);
    } catch {
        return null;
    }
}

function captureReviewArtifactGenerationUnderLock(
    reviewsDir: string,
    options: ReviewArtifactLockOptions
): ReviewArtifactGenerationCapture {
    const lockPath = resolveReviewTransactionLockPath(reviewsDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const { handle } = acquireFilesystemLock(lockPath, {
        timeoutMs: options.lockTimeoutMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS,
        retryMs: options.lockRetryMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS,
        staleMs: options.lockStaleMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS,
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery,
        ownerLabel: 'review-artifact-read-generation'
    });
    try {
        return {
            reviewsDirectoryIdentity: captureOptionalReviewArtifactIdentity(reviewsDir),
            indexIdentity: captureOptionalReviewArtifactIdentity(resolveIndexPath(reviewsDir))
        };
    } finally {
        releaseFilesystemLock(handle);
    }
}

function assertReviewArtifactGenerationUnchanged(
    reviewsDir: string,
    capture: ReviewArtifactGenerationCapture,
    options: ReviewArtifactLockOptions
): void {
    const current = captureReviewArtifactGenerationUnderLock(reviewsDir, options);
    const directoryUnchanged = capture.reviewsDirectoryIdentity === null
        ? current.reviewsDirectoryIdentity === null
        : current.reviewsDirectoryIdentity !== null
            && sameReviewArtifactFileIdentity(capture.reviewsDirectoryIdentity, current.reviewsDirectoryIdentity);
    const indexUnchanged = capture.indexIdentity === null
        ? current.indexIdentity === null
        : current.indexIdentity !== null
            && sameReviewArtifactFileIdentity(capture.indexIdentity, current.indexIdentity);
    if (!directoryUnchanged || !indexUnchanged) {
        throw new Error('Review artifact read snapshot was invalidated by a concurrent review publication.');
    }
}

export function withReviewArtifactReadBarrier<T>(
    reviewsDir: string,
    callback: () => T,
    options: ReviewArtifactLockOptions = {}
): T {
    const snapshotKey = normalizeReviewArtifactReadSnapshotKey(path.resolve(reviewsDir));
    if (inProcessReviewArtifactReadSnapshots.has(snapshotKey)) {
        return withReviewArtifactReadSnapshot(reviewsDir, callback, options);
    }
    if (currentProcessOwnsReviewTransactionLock(reviewsDir)) {
        return withReviewArtifactReadSnapshot(reviewsDir, callback, options);
    }
    const generationCapture = captureReviewArtifactGenerationUnderLock(reviewsDir, options);
    const result = withReviewArtifactReadSnapshot(reviewsDir, callback, options);
    assertReviewArtifactGenerationUnchanged(reviewsDir, generationCapture, options);
    return result;
}

async function withInProcessReviewLockQueue<T>(lockPath: string, callback: () => Promise<T>): Promise<T> {
    const previous = inProcessReviewLockQueues.get(lockPath) || Promise.resolve();
    const next = previous.catch(() => undefined).then(callback);
    const queueTail = next.then(() => undefined, () => undefined);
    inProcessReviewLockQueues.set(lockPath, queueTail);
    try {
        return await next;
    } finally {
        if (inProcessReviewLockQueues.get(lockPath) === queueTail) {
            inProcessReviewLockQueues.delete(lockPath);
        }
    }
}

async function withReviewArtifactTransactionLockAsync<T>(
    reviewsDir: string,
    callback: () => Promise<T>,
    options: ReviewArtifactLockOptions = {}
): Promise<{ result: T; lock_path: string; telemetry: ReviewArtifactLockTelemetry }> {
    const lockPath = resolveReviewTransactionLockPath(reviewsDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    return await withInProcessReviewLockQueue(lockPath, async () => {
        const { handle, telemetry } = await acquireFilesystemLockAsync(lockPath, {
            timeoutMs: options.lockTimeoutMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS,
            retryMs: options.lockRetryMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS,
            staleMs: options.lockStaleMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS,
            allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery,
            ownerLabel: 'review-artifact-transaction'
        });
        const releaseTransactionSnapshot = beginInProcessReviewTransactionSnapshot(reviewsDir);
        try {
            return {
                result: await callback(),
                lock_path: lockPath,
                telemetry
            };
        } finally {
            try {
                releaseTransactionSnapshot();
            } finally {
                releaseFilesystemLock(handle);
            }
        }
    });
}

function writeReviewArtifactTextUnlocked(
    artifactPath: string,
    content: string,
    options: ReviewArtifactLockOptions = {},
    updateIndex: boolean = true,
    trackRuntimeMutation: boolean = true,
    contentAlreadyRedacted: boolean = false
): ReviewArtifactWriteResult {
    const orchestratorRoot = trackRuntimeMutation
        ? resolveOrchestratorRootFromRuntimePath(artifactPath, 'reviews')
        : null;
    const rollbackState = shouldRequireIndexUpdate(options) || orchestratorRoot !== null
        ? captureReviewArtifactRollbackState(artifactPath)
        : null;
    const mutationTicket = orchestratorRoot === null
        ? null
        : beginRuntimeMutationGeneration(orchestratorRoot, 'review-artifact-write');
    let artifactPersisted = false;
    let mutationSettled = false;
    const redactedContent = contentAlreadyRedacted ? content : redactSecretText(content);
    try {
        const { lock_path, telemetry } = withReviewArtifactLock(artifactPath, () => {
            writeArtifactFileAtomically(artifactPath, redactedContent);
            artifactPersisted = true;
        }, options);
        const reviewsDir = path.dirname(artifactPath);
        const skipIndexUpdate = updateIndex
            && !shouldRequireIndexUpdate(options)
            && isLowNoiseRuntimeWritesEnabled(options);
        const indexUpdate = skipIndexUpdate
            ? {
                status: 'skipped_low_noise' as const,
                index_path: resolveIndexPath(reviewsDir),
                file_name: path.basename(artifactPath)
            }
            : updateIndex
            ? upsertEntry(reviewsDir, path.basename(artifactPath))
            : {
                status: 'updated' as const,
                index_path: resolveIndexPath(reviewsDir),
                file_name: path.basename(artifactPath)
            };
        if (indexUpdate.status === 'failed' && shouldRequireIndexUpdate(options)) {
            if (rollbackState) {
                try {
                    restoreReviewArtifactFromRollbackStateUnlocked(artifactPath, rollbackState, {
                        ...options,
                        requireIndexUpdate: false
                    });
                    if (mutationTicket) {
                        abortRuntimeMutationGeneration(mutationTicket);
                        mutationSettled = true;
                    }
                } catch {
                    // Preserve the index failure and leave generation evidence fail-closed.
                }
            }
            throw new Error(
                `Review artifact index update failed for '${path.basename(artifactPath)}': ${indexUpdate.error || 'unknown error'}`
            );
        }
        if (mutationTicket) {
            commitRuntimeMutationGeneration(mutationTicket);
            mutationSettled = true;
        }
        return {
            artifact_path: artifactPath,
            lock_path,
            telemetry,
            index_update_status: indexUpdate.status,
            index_path: indexUpdate.index_path,
            ...(indexUpdate.error ? { index_update_error: indexUpdate.error } : {})
        };
    } catch (error: unknown) {
        if (mutationTicket && !mutationSettled && !artifactPersisted) {
            try {
                abortRuntimeMutationGeneration(mutationTicket);
            } catch {
                // Preserve the write failure and leave damaged generation evidence fail-closed.
            }
        }
        throw error;
    }
}

export function writeReviewArtifactText(
    artifactPath: string,
    content: string,
    options: ReviewArtifactLockOptions = {}
): ReviewArtifactWriteResult {
    const { result } = withReviewArtifactTransactionLock(path.dirname(artifactPath), () => (
        writeReviewArtifactTextUnlocked(artifactPath, content, options)
    ), options);
    return result;
}

export function writeReviewArtifactJson(
    artifactPath: string,
    payload: unknown,
    options: ReviewArtifactLockOptions = {}
): ReviewArtifactWriteResult {
    const { result } = withReviewArtifactTransactionLock(path.dirname(artifactPath), () => (
        writeReviewArtifactTextUnlocked(
            artifactPath,
            serializeRedactedJson(payload),
            options,
            true,
            true,
            true
        )
    ), options);
    return result;
}

export type ReviewArtifactTransactionalWrite =
    | {
        artifactPath: string;
        contentType: 'json';
        payload: unknown;
        options?: ReviewArtifactLockOptions;
    }
    | {
        artifactPath: string;
        contentType: 'text';
        content: string;
        options?: ReviewArtifactLockOptions;
    };

export function captureReviewArtifactRollbackState(artifactPath: string): ReviewArtifactRollbackState {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return {
            existed: false,
            content: null
        };
    }
    return {
        existed: true,
        content: fs.readFileSync(artifactPath, 'utf8')
    };
}

export function restoreReviewArtifactFromRollbackState(
    artifactPath: string,
    rollbackState: ReviewArtifactRollbackState,
    options: ReviewArtifactLockOptions & { ensureTrailingNewline?: boolean } = {}
): void {
    if (!rollbackState.existed) {
        if (fs.existsSync(artifactPath)) {
            fs.rmSync(artifactPath, { force: true });
        }
        return;
    }
    const content = rollbackState.content || '';
    writeReviewArtifactText(
        artifactPath,
        options.ensureTrailingNewline && !content.endsWith('\n') ? `${content}\n` : content,
        options
    );
}

function restoreReviewArtifactFromRollbackStateUnlocked(
    artifactPath: string,
    rollbackState: ReviewArtifactRollbackState,
    options: ReviewArtifactLockOptions & { ensureTrailingNewline?: boolean } = {}
): void {
    withReviewArtifactLock(artifactPath, () => {
        if (!rollbackState.existed) {
            if (fs.existsSync(artifactPath)) {
                fs.rmSync(artifactPath, { force: true });
            }
            return;
        }
        const content = rollbackState.content || '';
        writeArtifactFileAtomically(
            artifactPath,
            options.ensureTrailingNewline && !content.endsWith('\n') ? `${content}\n` : content
        );
    }, options);
}

function getReviewArtifactTransactionEntryContent(entry: ReviewArtifactTransactionalWrite): string {
    if (entry.contentType === 'json') {
        return serializeRedactedJson(entry.payload);
    }
    return redactSecretText(entry.content);
}

function createReviewArtifactTransactionStagingDir(reviewsDir: string): string {
    fs.mkdirSync(reviewsDir, { recursive: true });
    return fs.mkdtempSync(path.join(reviewsDir, '.transaction-'));
}

function writeReviewArtifactTransactionEntryToStaging(
    entry: ReviewArtifactTransactionalWrite,
    stagingDir: string,
    index: number
): string {
    const stagedPath = path.join(stagingDir, `${String(index).padStart(4, '0')}-${path.basename(entry.artifactPath)}`);
    writeArtifactFileAtomically(stagedPath, getReviewArtifactTransactionEntryContent(entry));
    return stagedPath;
}

function commitStagedReviewArtifactTransactionEntry(
    entry: ReviewArtifactTransactionalWrite,
    stagedPath: string
): void {
    const content = fs.readFileSync(stagedPath, 'utf8');
    writeReviewArtifactTextUnlocked(entry.artifactPath, content, {
        ...entry.options,
        requireIndexUpdate: false
    }, false, false, true);
}

function assertTransactionIndexPersisted(reviewsDir: string, phase: string): void {
    const result = rebuildAndPersistIndex(reviewsDir);
    if (result.status === 'failed') {
        throw new Error(`Review artifact transaction index ${phase} failed: ${result.error || 'unknown error'}`);
    }
}

function resolveSingleTransactionReviewsDir(writes: readonly ReviewArtifactTransactionalWrite[]): string {
    const reviewsDir = path.dirname(writes[0].artifactPath);
    for (const entry of writes) {
        if (path.dirname(entry.artifactPath) !== reviewsDir) {
            throw new Error('Review artifact transaction writes must target one reviews directory.');
        }
    }
    return reviewsDir;
}

export async function writeReviewArtifactsWithRollback<T>(
    writes: readonly ReviewArtifactTransactionalWrite[],
    afterWrites: () => Promise<T>,
    options: ReviewArtifactLockOptions = {}
): Promise<T> {
    if (writes.length === 0) {
        return await afterWrites();
    }
    const reviewsDir = resolveSingleTransactionReviewsDir(writes);
    const { result } = await withReviewArtifactTransactionLockAsync(reviewsDir, async () => {
        const rollbackStates = writes.map((entry) => ({
            artifactPath: entry.artifactPath,
            rollbackState: captureReviewArtifactRollbackState(entry.artifactPath),
            options: entry.options
        }));
        const stagingDir = createReviewArtifactTransactionStagingDir(reviewsDir);
        let mutationTicket: RuntimeMutationGenerationTicket | null = null;
        try {
            const stagedWrites = writes.map((entry, index) => ({
                entry,
                stagedPath: writeReviewArtifactTransactionEntryToStaging(entry, stagingDir, index)
            }));
            const orchestratorRoot = resolveOrchestratorRootFromRuntimePath(writes[0].artifactPath, 'reviews');
            if (orchestratorRoot) {
                mutationTicket = beginRuntimeMutationGeneration(orchestratorRoot, 'review-artifact-transaction');
            }
            for (const stagedWrite of stagedWrites) {
                commitStagedReviewArtifactTransactionEntry(stagedWrite.entry, stagedWrite.stagedPath);
            }
            const afterWritesResult = await afterWrites();
            assertTransactionIndexPersisted(reviewsDir, 'commit');
            if (mutationTicket) {
                commitRuntimeMutationGeneration(mutationTicket);
                mutationTicket = null;
            }
            return afterWritesResult;
        } catch (error: unknown) {
            let rollbackFailed = false;
            let rollbackIndexPersisted = false;
            try {
                for (let index = rollbackStates.length - 1; index >= 0; index -= 1) {
                    const entry = rollbackStates[index];
                    try {
                        restoreReviewArtifactFromRollbackStateUnlocked(entry.artifactPath, entry.rollbackState, entry.options);
                    } catch {
                        rollbackFailed = true;
                    }
                }
                if (!rollbackFailed) {
                    assertTransactionIndexPersisted(reviewsDir, 'rollback');
                    rollbackIndexPersisted = true;
                }
            } catch {
                // Preserve the original write or post-write failure.
            }
            if (mutationTicket && !rollbackFailed && rollbackIndexPersisted) {
                try {
                    abortRuntimeMutationGeneration(mutationTicket);
                    mutationTicket = null;
                } catch {
                    // Preserve the original failure and leave generation evidence fail-closed.
                }
            }
            throw error;
        } finally {
            fs.rmSync(stagingDir, { recursive: true, force: true });
        }
    }, options);
    return result;
}
