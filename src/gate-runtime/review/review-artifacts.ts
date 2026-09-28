import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import { completePathFileIdentitySync, lstatFileIdentitySync } from '../../core/file-stat';
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
    resolveCanonicalReviewsDirectoryPath,
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
    routes: Map<string, ReviewArtifactReadSnapshotRoute>;
    reads: Map<string, CachedReviewArtifactRead>;
    retainedBytes: number;
    maxArtifacts: number;
    maxBytes: number;
    budgetError: ReviewArtifactReadBudgetError | null;
}

interface ReviewArtifactReadSnapshotRoute {
    canonicalRootKey: string;
    canonicalRootPath: string;
    invalid: boolean;
    lexicalRootPath: string;
}

const inProcessReviewArtifactReadSnapshots = new Map<string, ReviewArtifactReadSnapshotState>();

interface ReviewArtifactGenerationCapture {
    reviewsDirectoryIdentity: fs.Stats | null;
    indexIdentity: fs.Stats | null;
}

interface ReviewArtifactReadBarrierState {
    expectedGeneration: ReviewArtifactGenerationCapture;
    registeredKeys: Set<string>;
    activeParticipants: number;
    invalidated: boolean;
}

const inProcessReviewArtifactReadBarriers = new Map<string, ReviewArtifactReadBarrierState>();

interface ReviewArtifactReadBarrierParticipantAuthority {
    active: boolean;
    barrier: ReviewArtifactReadBarrierState;
    roots: ReadonlySet<string>;
}

const reviewArtifactReadBarrierParticipantAuthorities = new AsyncLocalStorage<
    ReadonlySet<ReviewArtifactReadBarrierParticipantAuthority>
>();

interface InProcessReviewArtifactTransactionContext {
    lockKey: string;
    settled: boolean;
    succeeded: boolean;
}

const reviewArtifactTransactionContext = new AsyncLocalStorage<InProcessReviewArtifactTransactionContext>();

interface CachedReviewArtifactRead {
    content: Buffer | null;
    exists: boolean;
    identity?: fs.Stats;
    sha256: string | null;
    valid: boolean;
}

export interface ReviewArtifactFileReadSnapshot {
    active: boolean;
    content: Buffer | null;
    exists: boolean;
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
    if (inProcessReviewLockQueues.has(lockPath)) {
        throw new Error(
            'Synchronous review artifact transaction cannot start while an asynchronous transaction is active or queued. '
            + 'Await the asynchronous transaction before starting the synchronous write.'
        );
    }
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const { handle, telemetry } = acquireFilesystemLock(lockPath, {
        timeoutMs: options.lockTimeoutMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS,
        retryMs: options.lockRetryMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS,
        staleMs: options.lockStaleMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS,
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery,
        ownerLabel: 'review-artifact-transaction'
    });
    let activeReadBarrier: ReviewArtifactReadBarrierState | null = null;
    let mutationStarted = false;
    try {
        activeReadBarrier = prepareActiveReviewArtifactReadBarrierMutation(reviewsDir);
        mutationStarted = true;
        return {
            result: callback(),
            lock_path: lockPath,
            telemetry
        };
    } finally {
        try {
            if (mutationStarted && activeReadBarrier) {
                activeReadBarrier.expectedGeneration = captureReviewArtifactGeneration(reviewsDir);
            }
        } finally {
            releaseFilesystemLock(handle);
        }
    }
}

function normalizeReviewArtifactReadSnapshotKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function reviewArtifactPathLookupIsMissing(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) {
        return false;
    }
    const code = String((error as { code?: unknown }).code || '');
    return code === 'ENOENT' || code === 'ENOTDIR';
}

function resolveReviewArtifactCanonicalCandidatePath(filePath: string): string {
    const resolvedPath = path.resolve(filePath);
    const missingSegments: string[] = [];
    let existingAncestor = resolvedPath;
    while (true) {
        try {
            return path.resolve(fs.realpathSync.native(existingAncestor), ...missingSegments);
        } catch (error: unknown) {
            if (!reviewArtifactPathLookupIsMissing(error)) {
                return resolvedPath;
            }
            const parentPath = path.dirname(existingAncestor);
            if (parentPath === existingAncestor) {
                return resolvedPath;
            }
            missingSegments.unshift(path.basename(existingAncestor));
            existingAncestor = parentPath;
        }
    }
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

function createReviewArtifactReadSnapshotRelease(
    snapshotKey: string,
    snapshot: ReviewArtifactReadSnapshotState
): () => void {
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        snapshot.depth -= 1;
        if (snapshot.depth <= 0 && inProcessReviewArtifactReadSnapshots.get(snapshotKey) === snapshot) {
            inProcessReviewArtifactReadSnapshots.delete(snapshotKey);
        }
    };
}

function registerReviewArtifactReadSnapshotRoute(
    snapshot: ReviewArtifactReadSnapshotState,
    lexicalRootPath: string,
    canonicalRootPath: string
): void {
    const lexicalRootKey = normalizeReviewArtifactReadSnapshotKey(lexicalRootPath);
    const canonicalRootKey = normalizeReviewArtifactReadSnapshotKey(canonicalRootPath);
    let invalid = false;
    for (const activeSnapshot of inProcessReviewArtifactReadSnapshots.values()) {
        const activeRoute = activeSnapshot.routes.get(lexicalRootKey);
        if (!activeRoute) {
            continue;
        }
        if (activeRoute.invalid || activeRoute.canonicalRootKey !== canonicalRootKey) {
            activeRoute.invalid = true;
            invalid = true;
        }
    }
    const existingRoute = snapshot.routes.get(lexicalRootKey);
    if (existingRoute) {
        existingRoute.invalid = existingRoute.invalid
            || invalid
            || existingRoute.canonicalRootKey !== canonicalRootKey;
        return;
    }
    snapshot.routes.set(lexicalRootKey, {
        canonicalRootKey,
        canonicalRootPath,
        invalid,
        lexicalRootPath: path.resolve(lexicalRootPath)
    });
}

export function withReviewArtifactReadSnapshot<T>(
    reviewsDir: string,
    callback: () => T,
    options: ReviewArtifactLockOptions = {}
): T {
    const rootPath = path.resolve(reviewsDir);
    const realRootPath = resolveReviewArtifactCanonicalCandidatePath(rootPath);
    const snapshotKey = normalizeReviewArtifactReadSnapshotKey(realRootPath);
    const existing = inProcessReviewArtifactReadSnapshots.get(snapshotKey);
    if (existing) {
        existing.depth += 1;
        registerReviewArtifactReadSnapshotRoute(existing, rootPath, realRootPath);
        const release = createReviewArtifactReadSnapshotRelease(snapshotKey, existing);
        try {
            return settleReviewArtifactReadSnapshot(callback(), existing, release);
        } catch (error: unknown) {
            release();
            throw error;
        }
    }

    const snapshot = {
        depth: 1,
        rootPath,
        realRootPath,
        routes: new Map<string, ReviewArtifactReadSnapshotRoute>(),
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
    registerReviewArtifactReadSnapshotRoute(snapshot, rootPath, realRootPath);
    const release = createReviewArtifactReadSnapshotRelease(snapshotKey, snapshot);
    try {
        return settleReviewArtifactReadSnapshot(callback(), snapshot, release);
    } catch (error: unknown) {
        release();
        throw error;
    }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === 'object' && value !== null) || typeof value === 'function'
        ? typeof (value as { then?: unknown }).then === 'function'
        : false;
}

function settleReviewArtifactReadSnapshot<T>(
    result: T,
    snapshot: ReviewArtifactReadSnapshotState,
    release: () => void
): T {
    if (isPromiseLike(result)) {
        return Promise.resolve(result).then((value) => {
            if (snapshot.budgetError) {
                throw snapshot.budgetError;
            }
            return value;
        }).finally(release) as T;
    }
    try {
        if (snapshot.budgetError) {
            throw snapshot.budgetError;
        }
        return result;
    } finally {
        release();
    }
}

interface ReviewArtifactReadSnapshotMatch {
    cacheKey: string;
    routeInvalid: boolean;
    snapshot: ReviewArtifactReadSnapshotState;
}

function reviewArtifactPathDepth(filePath: string): number {
    return path.resolve(filePath).split(path.sep).filter(Boolean).length;
}

function resolveLexicalRootForCanonicalMatch(
    lexicalCandidatePath: string
): string {
    return path.dirname(path.resolve(lexicalCandidatePath));
}

function invalidateReviewArtifactReadSnapshotRoute(lexicalRootKey: string): void {
    for (const snapshot of inProcessReviewArtifactReadSnapshots.values()) {
        const route = snapshot.routes.get(lexicalRootKey);
        if (route) {
            route.invalid = true;
        }
    }
}

function refreshReviewArtifactReadSnapshotRoute(
    lexicalRootKey: string,
    route: ReviewArtifactReadSnapshotRoute
): void {
    if (route.invalid) {
        return;
    }
    const currentCanonicalRootKey = normalizeReviewArtifactReadSnapshotKey(
        resolveReviewArtifactCanonicalCandidatePath(route.lexicalRootPath)
    );
    if (currentCanonicalRootKey !== route.canonicalRootKey) {
        invalidateReviewArtifactReadSnapshotRoute(lexicalRootKey);
    }
}

function findReviewArtifactReadSnapshot(filePath: string): ReviewArtifactReadSnapshotMatch | null {
    const resolvedPath = path.resolve(filePath);
    const canonicalPath = resolveReviewArtifactCanonicalCandidatePath(resolvedPath);
    const lexicalCandidatePath = normalizeReviewArtifactReadSnapshotKey(resolvedPath);
    const canonicalCandidatePath = normalizeReviewArtifactReadSnapshotKey(canonicalPath);
    let bestCanonicalMatch: ReviewArtifactReadSnapshotState | null = null;
    let bestCanonicalRootPath: string | null = null;
    let bestCanonicalDepth = -1;
    let bestLexicalMatch: ReviewArtifactReadSnapshotMatch | null = null;
    let bestLexicalDepth = -1;
    let bestInvalidRouteMatch: ReviewArtifactReadSnapshotMatch | null = null;
    let bestInvalidRouteDepth = -1;
    for (const snapshot of inProcessReviewArtifactReadSnapshots.values()) {
        for (const [lexicalRootKey, route] of snapshot.routes) {
            if (!isPathInsideReviewArtifactSnapshot(lexicalCandidatePath, lexicalRootKey)) {
                continue;
            }
            refreshReviewArtifactReadSnapshotRoute(lexicalRootKey, route);
            const relativePath = path.relative(route.lexicalRootPath, resolvedPath);
            const routeCacheKey = normalizeReviewArtifactReadSnapshotKey(
                path.resolve(route.canonicalRootPath, relativePath)
            );
            const routeDepth = reviewArtifactPathDepth(lexicalRootKey);
            if (route.invalid) {
                if (routeDepth > bestInvalidRouteDepth) {
                    bestInvalidRouteMatch = {
                        cacheKey: routeCacheKey,
                        routeInvalid: true,
                        snapshot
                    };
                    bestInvalidRouteDepth = routeDepth;
                }
            } else if (routeDepth > bestLexicalDepth) {
                bestLexicalMatch = {
                    cacheKey: routeCacheKey,
                    routeInvalid: false,
                    snapshot
                };
                bestLexicalDepth = routeDepth;
            }
        }
        const canonicalRootPath = normalizeReviewArtifactReadSnapshotKey(snapshot.realRootPath);
        if (isPathInsideReviewArtifactSnapshot(canonicalCandidatePath, canonicalRootPath)) {
            const canonicalDepth = reviewArtifactPathDepth(canonicalRootPath);
            if (canonicalDepth > bestCanonicalDepth) {
                bestCanonicalMatch = snapshot;
                bestCanonicalRootPath = snapshot.realRootPath;
                bestCanonicalDepth = canonicalDepth;
            }
        }
    }
    if (bestInvalidRouteMatch) {
        return bestInvalidRouteMatch;
    }
    if (!bestCanonicalMatch || !bestCanonicalRootPath) {
        return bestLexicalMatch;
    }
    const lexicalRootPath = resolveLexicalRootForCanonicalMatch(resolvedPath);
    const canonicalLexicalRootPath = resolveReviewArtifactCanonicalCandidatePath(lexicalRootPath);
    registerReviewArtifactReadSnapshotRoute(
        bestCanonicalMatch,
        lexicalRootPath,
        canonicalLexicalRootPath
    );
    const registeredRoute = bestCanonicalMatch.routes.get(
        normalizeReviewArtifactReadSnapshotKey(lexicalRootPath)
    );
    return {
        cacheKey: normalizeReviewArtifactReadSnapshotKey(canonicalPath),
        routeInvalid: registeredRoute?.invalid === true,
        snapshot: bestCanonicalMatch
    };
}

function hasReviewArtifactReadSnapshotForRoot(snapshotKey: string): boolean {
    for (const snapshot of inProcessReviewArtifactReadSnapshots.values()) {
        if (normalizeReviewArtifactReadSnapshotKey(snapshot.realRootPath) === snapshotKey) {
            return true;
        }
    }
    return false;
}

function invalidReviewArtifactRead(active: boolean, exists = false): ReviewArtifactFileReadSnapshot {
    return { active, content: null, exists, sha256: null, valid: false };
}

function cacheInvalidReviewArtifactRead(
    snapshot: ReviewArtifactReadSnapshotState,
    cacheKey: string,
    exists: boolean
): ReviewArtifactFileReadSnapshot {
    const invalid = invalidReviewArtifactRead(true, exists);
    snapshot.reads.set(cacheKey, {
        content: null,
        exists,
        sha256: null,
        valid: false
    });
    return invalid;
}

function invalidateCachedReviewArtifactRead(
    snapshot: ReviewArtifactReadSnapshotState,
    cached: CachedReviewArtifactRead,
    exists: boolean
): void {
    if (cached.content) {
        snapshot.retainedBytes -= cached.content.length;
    }
    cached.content = null;
    cached.exists = cached.exists || exists;
    cached.sha256 = null;
    cached.valid = false;
    const barrier = findReviewArtifactReadBarrier(snapshot.realRootPath);
    if (barrier) {
        barrier.invalidated = true;
    }
}

function reviewArtifactReadPathExists(error: unknown): boolean {
    return !reviewArtifactPathLookupIsMissing(error);
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
    const match = findReviewArtifactReadSnapshot(resolvedPath);
    if (!match) {
        return invalidReviewArtifactRead(false);
    }
    const { cacheKey, routeInvalid, snapshot } = match;
    if (routeInvalid) {
        return invalidReviewArtifactRead(true, true);
    }
    const cached = snapshot.reads.get(cacheKey);
    if (cached) {
        if (cached.valid) {
            try {
                const currentIdentity = lstatFileIdentitySync(resolvedPath);
                if (!cached.identity || !sameReviewArtifactFileIdentity(cached.identity, currentIdentity)) {
                    invalidateCachedReviewArtifactRead(snapshot, cached, true);
                }
            } catch (error: unknown) {
                invalidateCachedReviewArtifactRead(snapshot, cached, reviewArtifactReadPathExists(error));
            }
        } else if (!cached.exists) {
            try {
                lstatFileIdentitySync(resolvedPath);
                cached.exists = true;
            } catch (error: unknown) {
                if (reviewArtifactReadPathExists(error)) {
                    cached.exists = true;
                }
            }
        }
        return {
            active: true,
            content: cached.content,
            exists: cached.exists,
            sha256: cached.sha256,
            valid: cached.valid
        };
    }

    assertReviewArtifactCountBudget(snapshot);
    try {
        const beforeRead = fs.lstatSync(resolvedPath);
        if (!beforeRead.isFile() || beforeRead.isSymbolicLink()) {
            return cacheInvalidReviewArtifactRead(snapshot, cacheKey, true);
        }
        const realPath = fs.realpathSync.native(resolvedPath);
        if (!isPathInsideReviewArtifactSnapshot(realPath, snapshot.realRootPath)) {
            return cacheInvalidReviewArtifactRead(snapshot, cacheKey, true);
        }
        assertReviewArtifactByteBudget(snapshot, beforeRead.size);
        const completeIdentity = completePathFileIdentitySync(resolvedPath, beforeRead);
        const content = readReviewArtifactBytesBounded(resolvedPath, completeIdentity);
        if (!content) {
            return cacheInvalidReviewArtifactRead(snapshot, cacheKey, true);
        }
        const afterRead = lstatFileIdentitySync(resolvedPath);
        if (!sameReviewArtifactFileIdentity(completeIdentity, afterRead)) {
            return cacheInvalidReviewArtifactRead(snapshot, cacheKey, true);
        }
        const sha256 = createHash('sha256').update(content).digest('hex').toLowerCase();
        snapshot.reads.set(cacheKey, {
            content,
            exists: true,
            identity: afterRead,
            sha256,
            valid: true
        });
        snapshot.retainedBytes += content.length;
        return { active: true, content, exists: true, sha256, valid: true };
    } catch (error: unknown) {
        if (error instanceof ReviewArtifactReadBudgetError) {
            throw error;
        }
        return cacheInvalidReviewArtifactRead(snapshot, cacheKey, reviewArtifactReadPathExists(error));
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

function captureOptionalReviewArtifactIdentity(targetPath: string): fs.Stats | null {
    try {
        return lstatFileIdentitySync(targetPath);
    } catch {
        return null;
    }
}

function captureReviewArtifactGeneration(reviewsDir: string): ReviewArtifactGenerationCapture {
    const canonicalReviewsDir = resolveCanonicalReviewsDirectoryPath(reviewsDir);
    return {
        reviewsDirectoryIdentity: captureOptionalReviewArtifactIdentity(canonicalReviewsDir),
        indexIdentity: captureOptionalReviewArtifactIdentity(resolveIndexPath(canonicalReviewsDir))
    };
}

function reviewArtifactGenerationMatches(
    capture: ReviewArtifactGenerationCapture,
    current: ReviewArtifactGenerationCapture
): boolean {
    const directoryUnchanged = capture.reviewsDirectoryIdentity === null
        ? current.reviewsDirectoryIdentity === null
        : current.reviewsDirectoryIdentity !== null
            && sameReviewArtifactFileIdentity(capture.reviewsDirectoryIdentity, current.reviewsDirectoryIdentity);
    const indexUnchanged = capture.indexIdentity === null
        ? current.indexIdentity === null
        : current.indexIdentity !== null
            && sameReviewArtifactFileIdentity(capture.indexIdentity, current.indexIdentity);
    return directoryUnchanged && indexUnchanged;
}

function prepareActiveReviewArtifactReadBarrierMutation(
    reviewsDir: string
): ReviewArtifactReadBarrierState | null {
    const barrier = findReviewArtifactReadBarrier(reviewsDir);
    if (
        barrier
        && (barrier.invalidated
            || !reviewArtifactGenerationMatches(barrier.expectedGeneration, captureReviewArtifactGeneration(reviewsDir)))
    ) {
        throw new Error('Review artifact read snapshot was invalidated by a concurrent review publication.');
    }
    if (barrier) {
        registerReviewArtifactReadBarrierKeys(barrier, reviewsDir);
    }
    return barrier;
}

function reviewArtifactReadBarrierKeys(reviewsDir: string): string[] {
    return [...new Set([
        normalizeReviewArtifactReadSnapshotKey(path.resolve(reviewsDir)),
        normalizeReviewArtifactReadSnapshotKey(resolveCanonicalReviewsDirectoryPath(reviewsDir))
    ])];
}

export function isReviewArtifactReadBarrierParticipant(filePath: string): boolean {
    const authorities = reviewArtifactReadBarrierParticipantAuthorities.getStore();
    if (!authorities) {
        return false;
    }
    const candidateParentPaths = [...new Set([
        normalizeReviewArtifactReadSnapshotKey(path.dirname(path.resolve(filePath))),
        normalizeReviewArtifactReadSnapshotKey(path.dirname(resolveReviewArtifactCanonicalCandidatePath(filePath)))
    ])];
    const lexicalParentPath = normalizeReviewArtifactReadSnapshotKey(path.dirname(path.resolve(filePath)));
    for (const authority of authorities) {
        if (authority.active && authority.barrier.activeParticipants > 0) {
            for (const rootPath of authority.roots) {
                if (candidateParentPaths.includes(rootPath)) {
                    return true;
                }
            }
            for (const snapshot of inProcessReviewArtifactReadSnapshots.values()) {
                const snapshotRootKey = normalizeReviewArtifactReadSnapshotKey(snapshot.realRootPath);
                const route = snapshot.routes.get(lexicalParentPath);
                if (
                    authority.roots.has(snapshotRootKey)
                    && route
                    && authority.roots.has(route.canonicalRootKey)
                ) {
                    return true;
                }
            }
        }
    }
    return false;
}

function findReviewArtifactReadBarrier(reviewsDir: string): ReviewArtifactReadBarrierState | null {
    for (const key of reviewArtifactReadBarrierKeys(reviewsDir)) {
        const barrier = inProcessReviewArtifactReadBarriers.get(key);
        if (barrier) {
            return barrier;
        }
    }
    return null;
}

function registerReviewArtifactReadBarrierKeys(
    barrier: ReviewArtifactReadBarrierState,
    reviewsDir: string
): void {
    const keys = reviewArtifactReadBarrierKeys(reviewsDir);
    for (const key of keys) {
        const existing = inProcessReviewArtifactReadBarriers.get(key);
        if (existing && existing !== barrier) {
            throw new Error('Review artifact read snapshot was invalidated by a concurrent review publication.');
        }
    }
    for (const key of keys) {
        inProcessReviewArtifactReadBarriers.set(key, barrier);
        barrier.registeredKeys.add(key);
    }
}

function unregisterReviewArtifactReadBarrier(barrier: ReviewArtifactReadBarrierState): void {
    for (const key of barrier.registeredKeys) {
        if (inProcessReviewArtifactReadBarriers.get(key) === barrier) {
            inProcessReviewArtifactReadBarriers.delete(key);
        }
    }
}

function releaseReviewArtifactReadBarrierParticipant(barrier: ReviewArtifactReadBarrierState): void {
    barrier.activeParticipants -= 1;
    if (barrier.activeParticipants <= 0) {
        unregisterReviewArtifactReadBarrier(barrier);
    }
}

function runReviewArtifactReadBarrierParticipant<T>(
    reviewsDir: string,
    callback: () => T,
    barrier: ReviewArtifactReadBarrierState,
    options: ReviewArtifactLockOptions
): T {
    barrier.activeParticipants += 1;
    const authority: ReviewArtifactReadBarrierParticipantAuthority = {
        active: true,
        barrier,
        roots: new Set(reviewArtifactReadBarrierKeys(reviewsDir))
    };
    const releaseParticipant = (): void => {
        if (!authority.active) {
            return;
        }
        authority.active = false;
        releaseReviewArtifactReadBarrierParticipant(barrier);
    };
    const transactionContext = getCurrentReviewArtifactTransactionContext(reviewsDir);
    let result: T;
    try {
        const authorities = new Set(reviewArtifactReadBarrierParticipantAuthorities.getStore() || []);
        authorities.add(authority);
        result = reviewArtifactReadBarrierParticipantAuthorities.run(
            authorities,
            () => withReviewArtifactReadSnapshot(reviewsDir, callback, options)
        );
    } catch (error: unknown) {
        releaseParticipant();
        throw error;
    }
    let promiseLike: boolean;
    try {
        promiseLike = isPromiseLike(result);
    } catch (error: unknown) {
        releaseParticipant();
        throw error;
    }
    if (promiseLike) {
        return Promise.resolve(result).then((value) => {
            assertReviewArtifactReadBarrierParticipantGeneration(
                reviewsDir,
                barrier,
                transactionContext,
                options
            );
            return value;
        }).finally(releaseParticipant) as T;
    }
    try {
        assertReviewArtifactReadBarrierParticipantGeneration(
            reviewsDir,
            barrier,
            transactionContext,
            options
        );
        return result;
    } finally {
        releaseParticipant();
    }
}

function getCurrentReviewArtifactTransactionContext(
    reviewsDir: string
): InProcessReviewArtifactTransactionContext | null {
    const context = reviewArtifactTransactionContext.getStore() ?? null;
    const lockKey = normalizeReviewArtifactReadSnapshotKey(resolveReviewTransactionLockPath(reviewsDir));
    return context?.lockKey === lockKey ? context : null;
}

function assertReviewArtifactReadBarrierParticipantGeneration(
    reviewsDir: string,
    barrier: ReviewArtifactReadBarrierState,
    transactionContext: InProcessReviewArtifactTransactionContext | null,
    options: ReviewArtifactLockOptions
): void {
    if (barrier.invalidated) {
        throw new Error('Review artifact read snapshot was invalidated by a concurrent review publication.');
    }
    if (currentProcessOwnsReviewTransactionLock(reviewsDir)) {
        if (transactionContext) {
            return;
        }
        throw new Error('Review artifact read snapshot was invalidated by a concurrent review publication.');
    }
    if (transactionContext && (!transactionContext.settled || !transactionContext.succeeded)) {
        throw new Error('Review artifact read snapshot was invalidated by a concurrent review publication.');
    }
    assertReviewArtifactGenerationUnchanged(reviewsDir, barrier.expectedGeneration, options);
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
        return captureReviewArtifactGeneration(reviewsDir);
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
    if (!reviewArtifactGenerationMatches(capture, current)) {
        throw new Error('Review artifact read snapshot was invalidated by a concurrent review publication.');
    }
}

export function withReviewArtifactReadBarrier<T>(
    reviewsDir: string,
    callback: () => T,
    options: ReviewArtifactLockOptions = {}
): T {
    const snapshotKey = normalizeReviewArtifactReadSnapshotKey(
        resolveCanonicalReviewsDirectoryPath(reviewsDir)
    );
    const ownsTransactionLock = currentProcessOwnsReviewTransactionLock(reviewsDir);
    const transactionContext = getCurrentReviewArtifactTransactionContext(reviewsDir);
    if (ownsTransactionLock && !transactionContext) {
        throw new Error('Review artifact read snapshot was invalidated by a concurrent review publication.');
    }
    const activeBarrier = findReviewArtifactReadBarrier(reviewsDir);
    if (activeBarrier) {
        return runReviewArtifactReadBarrierParticipant(reviewsDir, callback, activeBarrier, options);
    }
    if (ownsTransactionLock) {
        return withReviewArtifactReadSnapshot(reviewsDir, callback, options);
    }
    if (hasReviewArtifactReadSnapshotForRoot(snapshotKey)) {
        return withReviewArtifactReadSnapshot(reviewsDir, callback, options);
    }
    const generationCapture = captureReviewArtifactGenerationUnderLock(reviewsDir, options);
    const barrierState: ReviewArtifactReadBarrierState = {
        expectedGeneration: generationCapture,
        registeredKeys: new Set<string>(),
        activeParticipants: 0,
        invalidated: false
    };
    registerReviewArtifactReadBarrierKeys(barrierState, reviewsDir);
    return runReviewArtifactReadBarrierParticipant(reviewsDir, callback, barrierState, options);
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
        let activeReadBarrier: ReviewArtifactReadBarrierState | null = null;
        let mutationStarted = false;
        let releaseTransactionSnapshot: (() => void) | null = null;
        let transactionSucceeded = false;
        const transactionKey = normalizeReviewArtifactReadSnapshotKey(lockPath);
        const transactionContext: InProcessReviewArtifactTransactionContext = {
            lockKey: transactionKey,
            settled: false,
            succeeded: false
        };
        try {
            activeReadBarrier = prepareActiveReviewArtifactReadBarrierMutation(reviewsDir);
            mutationStarted = true;
            releaseTransactionSnapshot = beginInProcessReviewTransactionSnapshot(reviewsDir);
            const result = {
                result: await reviewArtifactTransactionContext.run(transactionContext, callback),
                lock_path: lockPath,
                telemetry
            };
            transactionSucceeded = true;
            return result;
        } finally {
            try {
                if (mutationStarted && activeReadBarrier) {
                    activeReadBarrier.expectedGeneration = captureReviewArtifactGeneration(reviewsDir);
                }
            } finally {
                try {
                    transactionContext.succeeded = transactionSucceeded;
                    transactionContext.settled = true;
                    releaseTransactionSnapshot?.();
                } finally {
                    releaseFilesystemLock(handle);
                }
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
