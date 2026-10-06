import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPlainRecord } from '../../core/records';
import {
    appendMandatoryTaskEvent,
    inspectTaskEventFile,
    readTaskEventAppendState,
    withTaskTimelineReadSnapshot
} from '../../gate-runtime/task-events';
import type {
    TaskEventAppendState,
    TaskEventIntegrity
} from '../../gate-runtime/task-events';
import {
    detectSourceCheckoutRuntimeStaleness
} from '../../validators/workspace-layout/source-runtime';
import {
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import {
    readAndVerifySplitRequiredWipRestoreHandoff,
    replaceSplitRequiredWipRestoreHandoff
} from './split-required-wip-runtime-handoff-contracts';
import type {
    SplitRequiredWipRestoreHandoff,
    SplitRequiredWipRestoreHandoffIdentity,
    SplitRequiredWipRuntimeGeneration
} from './split-required-wip-runtime-handoff-contracts';
import { normalizeGitPath } from './split-required-wip-contracts';
import { readAuthenticatedRepoFileSnapshot } from './split-required-wip-restore-plan';

export interface SplitRequiredWipRestoreFinalizationResult {
    status: 'RESTORED' | 'ALREADY_RESTORED' | 'BLOCKED';
    output_lines: string[];
    violations: string[];
}

function taskEventFile(repoRoot: string, taskId: string): string {
    return path.join(
        joinOrchestratorPath(repoRoot, ''),
        'runtime',
        'task-events',
        `${taskId}.jsonl`
    );
}

function sameState(left: TaskEventAppendState, right: TaskEventAppendState): boolean {
    return left.matching_events === right.matching_events
        && left.parse_errors === right.parse_errors
        && left.last_integrity_sequence === right.last_integrity_sequence
        && left.last_event_sha256 === right.last_event_sha256;
}

export function captureHealthyTaskTimelineAnchor(
    repoRoot: string,
    taskId: string
): TaskEventAppendState {
    const eventFile = taskEventFile(repoRoot, taskId);
    const eventsRoot = path.dirname(eventFile);
    return withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        const inspection = inspectTaskEventFile(eventFile, taskId);
        if (inspection.status === 'FAILED'
            || inspection.parse_errors > 0
            || inspection.task_id_mismatches > 0
            || inspection.duplicate_event_hashes.length > 0
            || inspection.violations.length > 0) {
            throw new Error(
                `task timeline is not safe for restore handoff: status=${inspection.status}; `
                + `violations=${inspection.violations.join(' | ') || 'none'}`
            );
        }
        return readTaskEventAppendState(eventFile, taskId);
    });
}

export function assertTaskTimelineAnchorUnchanged(
    repoRoot: string,
    taskId: string,
    expected: TaskEventAppendState
): void {
    const actual = captureHealthyTaskTimelineAnchor(repoRoot, taskId);
    if (!sameState(actual, expected)) {
        throw new Error('task timeline changed while split-required WIP files were being restored.');
    }
}

const MAX_RUNTIME_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_MODULE_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_INPUT_FILES = 8192;
const MAX_RUNTIME_INPUT_ENTRIES = 65536;
const MAX_RUNTIME_INPUT_DEPTH = 64;
const MAX_RUNTIME_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_RUNTIME_METADATA_BYTES = 1024 * 1024;
const RUNTIME_INPUT_ROOTS = ['package.json', 'package-lock.json', 'tsconfig.json',
    'tsconfig.build.json', 'VERSION', 'src', 'scripts/node-foundation'] as const;
const RUNTIME_INPUT_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.ts']);

interface RuntimeFingerprintFile {
    path: string;
    size: number;
    sha256: string;
}

interface RuntimeInputScan {
    pending: Array<{ absolutePath: string; depth: number }>;
    entries: number;
}

type RuntimePathIdentities = Map<string, fs.Stats | null>;

function sameRuntimePathSnapshot(left: fs.Stats | null, right: fs.Stats | null): boolean {
    if (left === null || right === null) return left === right;
    const sameType = (left.isFile() && right.isFile()) || (left.isDirectory() && right.isDirectory());
    return sameType && !left.isSymbolicLink() && !right.isSymbolicLink()
        && left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs
        && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
        && left.mode === right.mode && left.nlink === right.nlink;
}

function retainRuntimePathIdentity(
    identities: RuntimePathIdentities,
    relativePath: string,
    identity: fs.Stats | null
): void {
    if (identities.has(relativePath)
        && !sameRuntimePathSnapshot(identities.get(relativePath) as fs.Stats | null, identity)) {
        throw staleRuntimeFingerprint('runtime authority changed during generation validation: ' + relativePath);
    }
    identities.set(relativePath, identity);
}

function assertRuntimePathIdentitiesCurrent(repoRoot: string, identities: RuntimePathIdentities): void {
    for (const [relativePath, expected] of identities) {
        let current: fs.Stats | null;
        try { current = fs.lstatSync(path.join(repoRoot, relativePath)); }
        catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            current = null;
        }
        if (!sameRuntimePathSnapshot(expected, current)) {
            throw staleRuntimeFingerprint('runtime authority changed during generation validation: ' + relativePath);
        }
    }
}

function samePath(left: string, right: string): boolean {
    const normalize = (value: string): string => {
        const resolved = path.resolve(value);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(left) === normalize(right);
}

function readAuthenticatedRuntimeFile(
    repoRoot: string,
    filePath: string,
    label: string,
    maxBytes: number,
    identities: RuntimePathIdentities
): Buffer {
    const relativePath = normalizeGitPath(path.relative(repoRoot, filePath));
    const snapshot = readAuthenticatedRepoFileSnapshot(repoRoot, relativePath, maxBytes);
    if (!snapshot.exists || snapshot.content === null) {
        throw new Error(`${label} is missing from the authenticated source-checkout runtime.`);
    }
    if (snapshot.content.length > maxBytes) {
        throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
    }
    if (snapshot.identity === null) throw staleRuntimeFingerprint('runtime file identity is missing: ' + relativePath);
    retainRuntimePathIdentity(identities, relativePath, snapshot.identity);
    return snapshot.content;
}

function readRuntimeManifest(repoRoot: string, manifestPath: string, identities: RuntimePathIdentities): {
    value: Record<string, unknown>;
    sha256: string;
} {
    const content = readAuthenticatedRuntimeFile(
        repoRoot,
        manifestPath,
        'runtime manifest',
        MAX_RUNTIME_MANIFEST_BYTES,
        identities
    );
    const parsed: unknown = JSON.parse(content.toString('utf8'));
    if (!isPlainRecord(parsed)) {
        throw new Error(`runtime manifest must be a JSON object: ${manifestPath}`);
    }
    return { value: parsed, sha256: createHash('sha256').update(content).digest('hex') };
}

function staleRuntimeFingerprint(reason: string): Error {
    return new Error(`stale runtime build cache fingerprint: ${reason}`);
}

function readRuntimeFingerprintMetadata(
    repoRoot: string,
    relativePath: string,
    optional: boolean,
    identities: RuntimePathIdentities
): Record<string, unknown> | null {
    const snapshot = readAuthenticatedRepoFileSnapshot(repoRoot, relativePath, MAX_RUNTIME_METADATA_BYTES);
    retainRuntimePathIdentity(identities, relativePath, snapshot.identity);
    if (!snapshot.exists || snapshot.content === null) {
        if (optional) return null;
        throw staleRuntimeFingerprint(`required build metadata is missing: ${relativePath}`);
    }
    try {
        const parsed: unknown = JSON.parse(snapshot.content.toString('utf8'));
        if (isPlainRecord(parsed)) return parsed;
    } catch (error: unknown) {
        if (!optional) throw staleRuntimeFingerprint(`invalid build metadata: ${relativePath}; ${String(error)}`);
    }
    if (optional) return null;
    throw staleRuntimeFingerprint(`build metadata must be a JSON object: ${relativePath}`);
}

function assertRuntimeFingerprintMetadata(
    repoRoot: string,
    fingerprint: Record<string, unknown>,
    identities: RuntimePathIdentities
): void {
    const pkg = readRuntimeFingerprintMetadata(repoRoot, 'package.json', false, identities) as Record<string, unknown>;
    const compiler = readRuntimeFingerprintMetadata(repoRoot, 'node_modules/typescript/package.json', true, identities);
    const expected = {
        schemaVersion: 1,
        kind: 'publish-runtime',
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        nodeEngineRange: isPlainRecord(pkg.engines) && typeof pkg.engines.node === 'string' && pkg.engines.node
            ? pkg.engines.node : '^22.13.0 || >=24.0.0',
        typescriptVersion: typeof compiler?.version === 'string' ? compiler.version : 'unknown'
    };
    if (Object.keys(fingerprint).length !== 10
        || Object.entries(expected).some(([key, value]) => fingerprint[key] !== value)) {
        throw staleRuntimeFingerprint('schema or build-host metadata does not match the current build inputs.');
    }
}

function readRuntimeFingerprintFiles(fingerprint: Record<string, unknown>): RuntimeFingerprintFile[] {
    if (!Array.isArray(fingerprint.files) || fingerprint.files.length > MAX_RUNTIME_INPUT_FILES
        || fingerprint.fileCount !== fingerprint.files.length) {
        throw staleRuntimeFingerprint('input file count is malformed or exceeds the bounded inventory.');
    }
    return fingerprint.files.map((entry: unknown) => {
        if (!isPlainRecord(entry) || Object.keys(entry).length !== 3 || typeof entry.path !== 'string'
            || !entry.path || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0
            || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
            throw staleRuntimeFingerprint('input file authority is malformed.');
        }
        return { path: entry.path, size: entry.size as number, sha256: entry.sha256 };
    });
}

function enqueueRuntimeFingerprintDirectory(
    absolutePath: string,
    depth: number,
    expected: fs.Stats,
    scan: RuntimeInputScan
): void {
    const directory = fs.opendirSync(absolutePath);
    try {
        let entry: fs.Dirent | null;
        while ((entry = directory.readSync()) !== null) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            if (++scan.entries > MAX_RUNTIME_INPUT_ENTRIES) {
                throw staleRuntimeFingerprint('current input traversal exceeds its entry limit.');
            }
            scan.pending.push({ absolutePath: path.join(absolutePath, entry.name), depth: depth + 1 });
        }
    } finally {
        directory.closeSync();
    }
    const current = fs.lstatSync(absolutePath);
    if (!sameRuntimePathSnapshot(expected, current)) {
        throw staleRuntimeFingerprint('input directory identity changed during traversal.');
    }
}

function collectRuntimeFingerprintInputPaths(repoRoot: string, identities: RuntimePathIdentities): string[] {
    const scan: RuntimeInputScan = {
        pending: RUNTIME_INPUT_ROOTS.map((relativePath) => ({ absolutePath: path.join(repoRoot, relativePath), depth: 0 })),
        entries: RUNTIME_INPUT_ROOTS.length
    };
    const files: string[] = [];
    while (scan.pending.length > 0) {
        const { absolutePath, depth } = scan.pending.pop() as { absolutePath: string; depth: number };
        if (depth > MAX_RUNTIME_INPUT_DEPTH) throw staleRuntimeFingerprint('input traversal exceeds its depth limit.');
        const relativePath = normalizeGitPath(path.relative(repoRoot, absolutePath));
        let stat: fs.Stats;
        try { stat = fs.lstatSync(absolutePath); }
        catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && depth === 0) {
                retainRuntimePathIdentity(identities, relativePath, null);
                continue;
            }
            throw error;
        }
        if (stat.isSymbolicLink()) throw staleRuntimeFingerprint('linked input paths are not authoritative.');
        if (depth === 0 || stat.isDirectory()) retainRuntimePathIdentity(identities, relativePath, stat);
        if (stat.isDirectory()) {
            enqueueRuntimeFingerprintDirectory(absolutePath, depth, stat, scan);
        } else if (stat.isFile() && RUNTIME_INPUT_EXTENSIONS.has(path.extname(absolutePath))) {
            files.push(normalizeGitPath(path.relative(repoRoot, absolutePath)));
            if (files.length > MAX_RUNTIME_INPUT_FILES) throw staleRuntimeFingerprint('current input inventory exceeds its file limit.');
        } else if (!stat.isFile()) {
            throw staleRuntimeFingerprint('non-regular input paths are not authoritative.');
        }
    }
    return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

function assertRuntimeFingerprintInputs(
    repoRoot: string,
    files: RuntimeFingerprintFile[],
    identities: RuntimePathIdentities
): void {
    const currentPaths = collectRuntimeFingerprintInputPaths(repoRoot, identities);
    if (currentPaths.length !== files.length || currentPaths.some((entry, index) => entry !== files[index].path)) {
        throw staleRuntimeFingerprint('cached inventory does not match the complete current build inputs.');
    }
    let remainingBytes = MAX_RUNTIME_INPUT_BYTES;
    for (const file of files) {
        const content = readAuthenticatedRuntimeFile(repoRoot, path.join(repoRoot, file.path),
            'runtime build cache fingerprint input', Math.min(MAX_RUNTIME_MODULE_BYTES, remainingBytes), identities);
        remainingBytes -= content.length;
        if (content.length !== file.size || createHash('sha256').update(content).digest('hex') !== file.sha256) {
            throw staleRuntimeFingerprint(`current input content changed: ${file.path}`);
        }
    }
    const afterPaths = collectRuntimeFingerprintInputPaths(repoRoot, identities);
    if (afterPaths.length !== currentPaths.length || afterPaths.some((entry, index) => entry !== currentPaths[index])) {
        throw staleRuntimeFingerprint('current input inventory changed during fingerprint validation.');
    }
}

function hashRuntimeFingerprintPayload(
    fingerprint: Record<string, unknown>,
    files: RuntimeFingerprintFile[]
): string {
    // Schema 1 hashes the producer's field order, regardless of the cache JSON's key order.
    const payload = {
        schemaVersion: fingerprint.schemaVersion,
        kind: fingerprint.kind,
        nodeVersion: fingerprint.nodeVersion,
        platform: fingerprint.platform,
        arch: fingerprint.arch,
        nodeEngineRange: fingerprint.nodeEngineRange,
        typescriptVersion: fingerprint.typescriptVersion,
        fileCount: files.length,
        files
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function readPublishedRuntimeFingerprint(
    repoRoot: string,
    publishedManifestSha256: string,
    identities: RuntimePathIdentities
): string {
    const cachePath = path.join(repoRoot, '.scripts-build', 'publish-runtime-build-cache.json');
    const content = readAuthenticatedRuntimeFile(
        repoRoot,
        cachePath,
        'runtime build cache',
        MAX_RUNTIME_MANIFEST_BYTES,
        identities
    );
    const parsed: unknown = JSON.parse(content.toString('utf8'));
    if (!isPlainRecord(parsed) || !isPlainRecord(parsed.inputFingerprint)) {
        throw new Error('runtime build cache is missing authenticated input fingerprint.');
    }
    if (parsed.publishedManifestSha256 !== publishedManifestSha256) {
        throw new Error('runtime build cache does not bind the current published manifest.');
    }
    if (parsed.inputFingerprint.kind !== 'publish-runtime') {
        throw new Error('runtime build cache does not contain a publish-runtime fingerprint.');
    }
    const fingerprintSha256 = parsed.inputFingerprint.sha256;
    if (typeof fingerprintSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(fingerprintSha256)) {
        throw new Error('runtime build cache input fingerprint sha256 is missing or malformed.');
    }
    assertRuntimeFingerprintMetadata(repoRoot, parsed.inputFingerprint, identities);
    const files = readRuntimeFingerprintFiles(parsed.inputFingerprint);
    if (hashRuntimeFingerprintPayload(parsed.inputFingerprint, files) !== fingerprintSha256) {
        throw staleRuntimeFingerprint('cached payload does not match its declared SHA-256.');
    }
    assertRuntimeFingerprintInputs(repoRoot, files, identities);
    return fingerprintSha256;
}

function resolveBuildRoot(finalizerPath: string): { buildRoot: string; manifestPath: string } {
    const normalized = path.resolve(finalizerPath);
    for (const buildRootName of ['dist', '.node-build']) {
        const marker = `${path.sep}${buildRootName}${path.sep}src${path.sep}`;
        const markerIndex = normalized.lastIndexOf(marker);
        if (markerIndex < 0) {
            continue;
        }
        const buildRoot = normalized.slice(0, markerIndex + marker.length - (`src${path.sep}`).length);
        return {
            buildRoot,
            manifestPath: path.join(
                buildRoot,
                buildRootName === 'dist'
                    ? 'publish-runtime-manifest.json'
                    : 'node-foundation-manifest.json'
            )
        };
    }
    throw new Error('restore finalizer is not executing from a generated source-checkout runtime.');
}

export function resolveLoadedSplitRequiredWipRuntimeGeneration(
    repoRoot: string
): SplitRequiredWipRuntimeGeneration {
    const staleness = detectSourceCheckoutRuntimeStaleness(repoRoot);
    if (!staleness.isSourceCheckout || staleness.isStale) {
        throw new Error(
            staleness.remediation
                || `restored source-checkout runtime is not current: ${staleness.violations.join(' | ')}`
        );
    }
    const finalizerPath = __filename;
    const writerPath = require.resolve('../../gate-runtime/timeline/task-events-io');
    const { buildRoot, manifestPath } = resolveBuildRoot(finalizerPath);
    const expectedBuildRoot = path.resolve(repoRoot, 'dist');
    if (!samePath(buildRoot, expectedBuildRoot)) {
        throw new Error(
            `restore finalizer loaded a foreign or fallback runtime generation: ${normalizePath(buildRoot)}`
        );
    }
    const identities: RuntimePathIdentities = new Map();
    const { value: manifest, sha256: manifestSha256 } = readRuntimeManifest(repoRoot, manifestPath, identities);
    const manifestFiles = Array.isArray(manifest.files)
        ? new Set(manifest.files.filter((entry): entry is string => typeof entry === 'string'))
        : new Set<string>();
    for (const runtimePath of [finalizerPath, writerPath]) {
        const relativePath = normalizePath(path.relative(buildRoot, runtimePath));
        if (!manifestFiles.has(relativePath)) {
            throw new Error(`runtime manifest does not bind required finalizer module: ${relativePath}`);
        }
    }
    const generation = {
        build_root: normalizePath(buildRoot),
        input_fingerprint_sha256: readPublishedRuntimeFingerprint(repoRoot, manifestSha256, identities),
        finalizer_sha256: createHash('sha256').update(readAuthenticatedRuntimeFile(
            repoRoot,
            finalizerPath,
            'restore finalizer module',
            MAX_RUNTIME_MODULE_BYTES,
            identities
        )).digest('hex'),
        writer_sha256: createHash('sha256').update(readAuthenticatedRuntimeFile(
            repoRoot,
            writerPath,
            'task-event writer module',
            MAX_RUNTIME_MODULE_BYTES,
            identities
        )).digest('hex')
    };
    assertRuntimePathIdentitiesCurrent(repoRoot, identities);
    return generation;
}

function sameRuntimeGeneration(
    value: unknown,
    expected: SplitRequiredWipRuntimeGeneration
): boolean {
    return isPlainRecord(value)
        && value.build_root === expected.build_root
        && value.input_fingerprint_sha256 === expected.input_fingerprint_sha256
        && value.finalizer_sha256 === expected.finalizer_sha256
        && value.writer_sha256 === expected.writer_sha256;
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
    return Array.isArray(value)
        && value.every((entry): entry is string => typeof entry === 'string')
        && value.length === expected.length
        && value.every((entry, index) => entry === expected[index]);
}

function assertHandoffEventBindings(
    details: Record<string, unknown>,
    integrity: Record<string, unknown>,
    identity: SplitRequiredWipRestoreHandoffIdentity,
    runtimeGeneration: SplitRequiredWipRuntimeGeneration
): void {
    const expectedSequence = identity.timelineAnchor.last_integrity_sequence == null
        ? 1
        : identity.timelineAnchor.last_integrity_sequence + 1;
    if (details.handoff_id !== identity.handoffId
        || typeof details.handoff_path !== 'string'
        || path.resolve(details.handoff_path) !== path.resolve(identity.handoffPath)
        || typeof details.manifest_path !== 'string'
        || path.resolve(details.manifest_path) !== path.resolve(identity.manifestPath)
        || details.manifest_sha256 !== identity.manifestSha256
        || !sameStringArray(details.restored_files, identity.restoredFiles)
        || !sameStringArray(details.selected_paths, identity.selectedPaths)
        || !sameRuntimeGeneration(details.runtime_generation, runtimeGeneration)
        || integrity.task_sequence !== expectedSequence
        || integrity.prev_event_sha256 !== identity.timelineAnchor.last_event_sha256) {
        throw new Error(
            'canonical restore event does not match immutable restore handoff bindings.'
        );
    }
}

function handoffEventIntegrity(
    identity: SplitRequiredWipRestoreHandoffIdentity,
    runtimeGeneration: SplitRequiredWipRuntimeGeneration
): TaskEventIntegrity | null {
    const eventFile = taskEventFile(identity.repoRoot, identity.taskId);
    return withTaskTimelineReadSnapshot(path.dirname(eventFile), identity.taskId, () => {
        const matches: TaskEventIntegrity[] = [];
        const inspection = inspectTaskEventFile(eventFile, identity.taskId, {
            onIntegrityEvent: (record) => {
                if (record.task_id !== identity.taskId
                    || record.event_type !== 'SPLIT_REQUIRED_WIP_RESTORED'
                    || !isPlainRecord(record.details)
                    || record.details.handoff_id !== identity.handoffId) {
                    return;
                }
                if (!isPlainRecord(record.integrity)) {
                    throw new Error('canonical restore event is missing integrity evidence.');
                }
                if (record.actor !== 'orchestrator' || record.outcome !== 'PASS') {
                    throw new Error('canonical restore event has invalid author or outcome authority.');
                }
                const schemaVersion = record.integrity.schema_version;
                const taskSequence = record.integrity.task_sequence;
                const previousHash = record.integrity.prev_event_sha256;
                const eventHash = record.integrity.event_sha256;
                if (!Number.isSafeInteger(schemaVersion)
                    || !Number.isSafeInteger(taskSequence)
                    || Number(taskSequence) < 1
                    || (previousHash !== null
                        && (typeof previousHash !== 'string' || !/^[0-9a-f]{64}$/u.test(previousHash)))
                    || typeof eventHash !== 'string'
                    || !/^[0-9a-f]{64}$/u.test(eventHash)) {
                    throw new Error('canonical restore event contains malformed integrity evidence.');
                }
                assertHandoffEventBindings(
                    record.details,
                    record.integrity,
                    identity,
                    runtimeGeneration
                );
                matches.push({
                    schema_version: Number(schemaVersion),
                    task_sequence: Number(taskSequence),
                    prev_event_sha256: previousHash as string | null,
                    event_sha256: eventHash
                });
            }
        });
        if (inspection.status === 'FAILED'
            || inspection.parse_errors > 0
            || inspection.task_id_mismatches > 0
            || inspection.duplicate_event_hashes.length > 0
            || inspection.violations.length > 0) {
            throw new Error(
                `task timeline is not safe for restore event recovery: status=${inspection.status}; `
                + `violations=${inspection.violations.join(' | ') || 'none'}`
            );
        }
        if (matches.length > 1) {
            throw new Error(
                `restore handoff replay produced duplicate canonical events: ${identity.handoffId}`
            );
        }
        return matches[0] || null;
    });
}

function sameIntegrity(left: TaskEventIntegrity, right: TaskEventIntegrity): boolean {
    return left.schema_version === right.schema_version
        && left.task_sequence === right.task_sequence
        && left.prev_event_sha256 === right.prev_event_sha256
        && left.event_sha256 === right.event_sha256;
}

function assertFinalizedHandoffEvent(
    identity: SplitRequiredWipRestoreHandoffIdentity,
    handoff: SplitRequiredWipRestoreHandoff
): void {
    if (handoff.status !== 'finalized') {
        throw new Error(`restore handoff is not finalized; found ${handoff.status}.`);
    }
    if (!handoff.runtime_generation) {
        throw new Error('finalized restore handoff is missing runtime generation evidence.');
    }
    const existingIntegrity = handoffEventIntegrity(identity, handoff.runtime_generation);
    if (!handoff.event_integrity || !existingIntegrity
        || !sameIntegrity(handoff.event_integrity, existingIntegrity)) {
        throw new Error('finalized restore handoff is not bound to its canonical task event.');
    }
}

function finalizedOutput(
    identity: SplitRequiredWipRestoreHandoffIdentity,
    alreadyRestored: boolean
): SplitRequiredWipRestoreFinalizationResult {
    return {
        status: alreadyRestored ? 'ALREADY_RESTORED' : 'RESTORED',
        violations: [],
        output_lines: [
            alreadyRestored
                ? 'SPLIT_REQUIRED_WIP_ALREADY_RESTORED'
                : 'SPLIT_REQUIRED_WIP_RESTORED',
            `ManifestPath: ${normalizePath(identity.manifestPath)}`,
            `SelectedPaths: ${identity.selectedPaths.join(', ') || 'all'}`,
            `RestoredFiles: ${identity.restoredFiles.join(', ') || 'none'}`,
            `RuntimeHandoff: ${normalizePath(identity.handoffPath)}`
        ]
    };
}

function persistFinalizedHandoff(
    identity: SplitRequiredWipRestoreHandoffIdentity,
    handoff: SplitRequiredWipRestoreHandoff,
    runtimeGeneration: SplitRequiredWipRuntimeGeneration,
    integrity: TaskEventIntegrity
): void {
    replaceSplitRequiredWipRestoreHandoff(identity.handoffPath, {
        ...handoff,
        status: 'finalized',
        finalized_at_utc: new Date().toISOString(),
        runtime_generation: runtimeGeneration,
        event_integrity: integrity
    }, handoff);
}

export function authenticateFinalizedSplitRequiredWipRestoreHandoff(
    identity: SplitRequiredWipRestoreHandoffIdentity
): SplitRequiredWipRestoreFinalizationResult {
    try {
        const handoff = readAndVerifySplitRequiredWipRestoreHandoff(identity);
        assertFinalizedHandoffEvent(identity, handoff);
        return finalizedOutput(identity, true);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 'BLOCKED',
            violations: [message],
            output_lines: [
                'SPLIT_REQUIRED_WIP_RESTORE_BLOCKED',
                `Violation: ${message}`,
                `RuntimeHandoff: ${normalizePath(identity.handoffPath)}`
            ]
        };
    }
}

export function finalizeSplitRequiredWipRestoreHandoff(
    identity: SplitRequiredWipRestoreHandoffIdentity,
    resolveRuntimeGeneration: (repoRoot: string) => SplitRequiredWipRuntimeGeneration =
        resolveLoadedSplitRequiredWipRuntimeGeneration
): SplitRequiredWipRestoreFinalizationResult {
    try {
        const handoff = readAndVerifySplitRequiredWipRestoreHandoff(identity);
        if (handoff.status === 'prepared') {
            throw new Error('restore handoff has not been promoted with restored workspace evidence.');
        }
        if (handoff.status === 'finalized') {
            assertFinalizedHandoffEvent(identity, handoff);
            return finalizedOutput(identity, true);
        }

        const runtimeGeneration = resolveRuntimeGeneration(identity.repoRoot);
        const existingIntegrity = handoffEventIntegrity(identity, runtimeGeneration);
        if (existingIntegrity) {
            persistFinalizedHandoff(identity, handoff, runtimeGeneration, existingIntegrity);
            return finalizedOutput(identity, true);
        }

        const appendResult = appendMandatoryTaskEvent(
            joinOrchestratorPath(identity.repoRoot, ''),
            identity.taskId,
            'SPLIT_REQUIRED_WIP_RESTORED',
            'PASS',
            'Split-required WIP restored by explicit command through the restored runtime generation.',
            {
                handoff_id: identity.handoffId,
                handoff_path: normalizePath(identity.handoffPath),
                manifest_path: normalizePath(identity.manifestPath),
                manifest_sha256: identity.manifestSha256,
                restored_files: identity.restoredFiles,
                selected_paths: identity.selectedPaths,
                runtime_generation: runtimeGeneration
            },
            {
                actor: 'orchestrator',
                expectedPreviousState: handoff.timeline_anchor,
                validateBeforeCanonicalAppend: () => {
                    if (!sameRuntimeGeneration(resolveRuntimeGeneration(identity.repoRoot), runtimeGeneration)) {
                        throw new Error('runtime generation changed before canonical restore append.');
                    }
                    const verified = readAndVerifySplitRequiredWipRestoreHandoff(identity);
                    if (verified.status !== 'pending') {
                        throw new Error(
                            `restore handoff must remain pending until canonical append; found ${verified.status}.`
                        );
                    }
                }
            }
        );
        if (!appendResult.integrity) {
            throw new Error('restored-runtime event append returned no integrity evidence.');
        }
        persistFinalizedHandoff(identity, handoff, runtimeGeneration, appendResult.integrity);
        return finalizedOutput(identity, false);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 'BLOCKED',
            violations: [message],
            output_lines: [
                'SPLIT_REQUIRED_WIP_RESTORE_BLOCKED',
                `Violation: ${message}`,
                `RuntimeHandoff: ${normalizePath(identity.handoffPath)}`
            ]
        };
    }
}
