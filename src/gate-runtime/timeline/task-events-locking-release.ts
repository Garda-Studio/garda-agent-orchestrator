import * as fs from 'node:fs';

import { DEFAULT_LOCK_RELEASE_RETRIES, DEFAULT_LOCK_RELEASE_RETRY_MS, MAX_LOCK_RELEASE_RETRY_MS, TRANSIENT_LOCK_ACQUIRE_ERROR_CODES, TRANSIENT_LOCK_RELEASE_ERROR_CODES } from './task-events-locking-types';
import type { LockOwnerMetadata } from './task-events-locking-types';
import { getErrorCode, getErrorMessage, createLockId, redactLockPath, sanitizeLockIdForPath, sleepMsSync } from './task-events-locking-support';
import { lockMetadataMatchesLockId, normalizeHostname, readLockMetadata } from './task-events-locking-metadata';

const LOCK_RELEASE_INTENT_SUFFIX = '.release-intent';
const LOCK_RELEASE_INTENT_TTL_MS = 3000;
const LOCK_RELEASE_INTENT_CLOCK_SKEW_TOLERANCE_MS = 1;

interface LockReleaseIntent {
    lock_id: string;
    created_at_utc: string;
    pid: number;
}

function resolveLockReleaseIntentPath(lockPath: string): string {
    return `${lockPath}${LOCK_RELEASE_INTENT_SUFFIX}`;
}

function readLockReleaseIntent(intentPath: string): LockReleaseIntent | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(intentPath, 'utf8')) as Partial<LockReleaseIntent>;
        if (
            typeof parsed.lock_id !== 'string'
            || !parsed.lock_id.trim()
            || typeof parsed.created_at_utc !== 'string'
            || !Number.isInteger(parsed.pid)
        ) {
            return null;
        }
        return {
            lock_id: parsed.lock_id,
            created_at_utc: parsed.created_at_utc,
            pid: parsed.pid as number
        };
    } catch {
        return null;
    }
}

function getLockReleaseIntentAgeMs(intentPath: string): number | null {
    try {
        const state = fs.lstatSync(intentPath);
        const ageMs = Date.now() - state.mtimeMs;
        if (!Number.isFinite(ageMs) || ageMs < -LOCK_RELEASE_INTENT_CLOCK_SKEW_TOLERANCE_MS) return null;
        return Math.max(0, ageMs);
    } catch {
        return null;
    }
}

function readActiveLockReleaseIntent(lockPath: string): LockReleaseIntent | null {
    const intentPath = resolveLockReleaseIntentPath(lockPath);
    const ageMs = getLockReleaseIntentAgeMs(intentPath);
    if (ageMs === null || ageMs > LOCK_RELEASE_INTENT_TTL_MS) return null;
    return readLockReleaseIntent(intentPath);
}

export function resolveActiveLockReleaseIntentLockId(
    lockPath: string,
    expectedLockId: string | null | undefined
): string | null {
    const intent = readActiveLockReleaseIntent(lockPath);
    if (!intent) return null;
    if (expectedLockId) return intent.lock_id === expectedLockId ? intent.lock_id : null;
    return lockMetadataMatchesLockId(readLockMetadata(lockPath), intent.lock_id)
        ? intent.lock_id
        : null;
}

function claimLockReleaseIntent(intentPath: string, lockId: string): string | null {
    const claimedPath = `${intentPath}.clearing-${process.pid}-${Date.now()}-${sanitizeLockIdForPath(lockId)}`;
    try {
        fs.renameSync(intentPath, claimedPath);
        return claimedPath;
    } catch (error: unknown) {
        const errorCode = getErrorCode(error);
        if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR') return null;
        throw error;
    }
}

function restoreUnownedLockReleaseIntent(claimedPath: string, intentPath: string): void {
    try {
        if (!fs.existsSync(intentPath)) fs.renameSync(claimedPath, intentPath);
    } catch {
        // A foreign intent fails closed until its bounded TTL expires.
    }
}

function clearLockReleaseIntent(
    lockPath: string,
    lockId: string,
    allowExpired: boolean,
    allowUnbound: boolean = false
): boolean {
    const intentPath = resolveLockReleaseIntentPath(lockPath);
    const claimedPath = claimLockReleaseIntent(intentPath, lockId);
    if (!claimedPath) return true;

    const intent = readLockReleaseIntent(claimedPath);
    const ageMs = getLockReleaseIntentAgeMs(claimedPath);
    if (
        intent?.lock_id === lockId
        || allowUnbound
        || (allowExpired && ageMs !== null && ageMs > LOCK_RELEASE_INTENT_TTL_MS)
    ) {
        fs.rmSync(claimedPath, { force: true });
        return true;
    }

    restoreUnownedLockReleaseIntent(claimedPath, intentPath);
    return false;
}

function clearLockReleaseIntentAfterReleaseAttempt(lockPath: string, lockId: string): void {
    try {
        clearLockReleaseIntent(lockPath, lockId, false);
    } catch (error: unknown) {
        process.stderr.write(
            `WARNING: LOCK_RELEASE_INTENT_CLEANUP_FAILED: lock=${redactLockPath(lockPath)}; code=${getErrorCode(error) || 'UNKNOWN'}; message=${getErrorMessage(error)}\n`
        );
    }
}

function createLockReleaseIntent(lockPath: string, lockId: string): void {
    const intentPath = resolveLockReleaseIntentPath(lockPath);
    const intent: LockReleaseIntent = {
        lock_id: lockId,
        created_at_utc: new Date().toISOString(),
        pid: process.pid
    };
    let conflictAttempts = 0;
    let transientRetries = 0;
    const startedAt = Date.now();
    while (conflictAttempts < 2) {
        try {
            fs.writeFileSync(intentPath, `${JSON.stringify(intent)}\n`, { encoding: 'utf8', flag: 'wx' });
            if (transientRetries > 0) {
                process.stderr.write(
                    `LOCK_RELEASE_RETRY_RESOLVED: kind=filesystem_lock_release_intent; lock=${redactLockPath(lockPath)}; retries=${transientRetries}; elapsed_ms=${Date.now() - startedAt}\n`
                );
            }
            return;
        } catch (error: unknown) {
            if (getErrorCode(error) !== 'EEXIST') {
                if (!isRetryableLockReleaseError(error) || transientRetries >= DEFAULT_LOCK_RELEASE_RETRIES) {
                    throw error;
                }
                transientRetries += 1;
                const delayMs = getLockReleaseDelayMs(transientRetries - 1);
                process.stderr.write(
                    `WARNING: LOCK_RELEASE_RETRY: ${formatLockReleaseDiagnostic(lockPath, 'filesystem_lock_release_intent', transientRetries, Date.now() - startedAt, error)}; next_delay_ms=${delayMs}\n`
                );
                sleepMsSync(delayMs);
                continue;
            }
            conflictAttempts += 1;
            const activeIntent = readActiveLockReleaseIntent(lockPath);
            if (activeIntent?.lock_id === lockId) return;
            if (
                !lockMetadataMatchesLockId(readLockMetadata(lockPath), lockId)
                || !clearLockReleaseIntent(lockPath, lockId, true, true)
            ) {
                throw new Error(`Another active release intent prevents owned lock release: ${redactLockPath(lockPath)}`);
            }
        }
    }
    throw new Error(`Failed to create owned lock release intent: ${redactLockPath(lockPath)}`);
}

export function isRetryableLockReleaseError(error: unknown): boolean {
    return TRANSIENT_LOCK_RELEASE_ERROR_CODES.has(getErrorCode(error));
}

export function isRetryableLockAcquireError(error: unknown): boolean {
    return TRANSIENT_LOCK_ACQUIRE_ERROR_CODES.has(getErrorCode(error));
}

export function getLockReleaseDelayMs(retryIndex: number): number {
    const baseDelay = DEFAULT_LOCK_RELEASE_RETRY_MS * Math.pow(2, Math.max(0, retryIndex));
    return Math.min(baseDelay, MAX_LOCK_RELEASE_RETRY_MS);
}

export function formatLockReleaseDiagnostic(lockPath: string, kind: string, retries: number, elapsedMs: number, error: unknown): string {
    const code = getErrorCode(error) || 'UNKNOWN';
    return [
        `kind=${kind}`,
        `lock=${redactLockPath(lockPath)}`,
        `retries=${retries}`,
        `elapsed_ms=${elapsedMs}`,
        `code=${code}`,
        `message=${getErrorMessage(error)}`
    ].join('; ');
}

export function createTransientLockPath(lockPath: string, kind: 'releasing' | 'stale', lockId?: string): string {
    const suffixParts = [
        kind,
        String(process.pid),
        String(Date.now()),
        sanitizeLockIdForPath(lockId || createLockId())
    ];
    return `${lockPath}.${suffixParts.join('-')}`;
}

export function removeLockPathWithRetry(lockPath: string, kind = 'filesystem_lock'): void {
    let retries = 0;
    const startedAt = Date.now();
    while (true) {
        try {
            fs.rmSync(lockPath, { recursive: true, force: true });
            if (fs.existsSync(lockPath)) {
                const error = new Error('Lock path still exists after recursive removal') as NodeJS.ErrnoException;
                error.code = 'EIO';
                throw error;
            }
            if (retries > 0) {
                process.stderr.write(
                    `LOCK_RELEASE_RETRY_RESOLVED: kind=${kind}; lock=${redactLockPath(lockPath)}; retries=${retries}; elapsed_ms=${Date.now() - startedAt}\n`
                );
            }
            return;
        } catch (error: unknown) {
            if (!isRetryableLockReleaseError(error) || retries >= DEFAULT_LOCK_RELEASE_RETRIES) {
                const diagnostic = formatLockReleaseDiagnostic(lockPath, kind, retries, Date.now() - startedAt, error);
                process.stderr.write(`WARNING: LOCK_RELEASE_FAILED: ${diagnostic}\n`);
                throw new Error(`Failed to release lock after retry backoff: ${diagnostic}`);
            }

            retries += 1;
            const delayMs = getLockReleaseDelayMs(retries - 1);
            process.stderr.write(
                `WARNING: LOCK_RELEASE_RETRY: ${formatLockReleaseDiagnostic(lockPath, kind, retries, Date.now() - startedAt, error)}; next_delay_ms=${delayMs}\n`
            );
            sleepMsSync(delayMs);
        }
    }
}

export function removeLockPath(lockPath: string): void {
    removeLockPathWithRetry(lockPath, 'filesystem_lock');
}

export function renameLockPathWithRetry(
    lockPath: string,
    createDestinationPath: () => string,
    kind = 'filesystem_lock_rename',
    isExpectedOwner?: () => boolean
): string | null {
    let retries = 0;
    const startedAt = Date.now();
    while (true) {
        if (isExpectedOwner && !isExpectedOwner()) {
            return null;
        }

        const destinationPath = createDestinationPath();
        try {
            fs.renameSync(lockPath, destinationPath);
            if (retries > 0) {
                process.stderr.write(
                    `LOCK_RELEASE_RETRY_RESOLVED: kind=${kind}; lock=${redactLockPath(lockPath)}; retries=${retries}; elapsed_ms=${Date.now() - startedAt}\n`
                );
            }
            return destinationPath;
        } catch (error: unknown) {
            const errorCode = getErrorCode(error);
            if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR') {
                return null;
            }
            if (!isRetryableLockReleaseError(error) || retries >= DEFAULT_LOCK_RELEASE_RETRIES) {
                const diagnostic = formatLockReleaseDiagnostic(lockPath, kind, retries, Date.now() - startedAt, error);
                process.stderr.write(`WARNING: LOCK_RELEASE_FAILED: ${diagnostic}\n`);
                throw new Error(`Failed to claim lock for release after retry backoff: ${diagnostic}`);
            }

            retries += 1;
            const delayMs = getLockReleaseDelayMs(retries - 1);
            process.stderr.write(
                `WARNING: LOCK_RELEASE_RETRY: ${formatLockReleaseDiagnostic(lockPath, kind, retries, Date.now() - startedAt, error)}; next_delay_ms=${delayMs}\n`
            );
            sleepMsSync(delayMs);
        }
    }
}

export function lockMetadataMatchesCandidate(before: LockOwnerMetadata, after: LockOwnerMetadata): boolean {
    if (before.lock_id || after.lock_id) {
        return Boolean(before.lock_id && before.lock_id === after.lock_id);
    }
    return before.metadata_status === after.metadata_status
        && before.pid === after.pid
        && normalizeHostname(before.hostname) === normalizeHostname(after.hostname)
        && before.created_at_utc === after.created_at_utc;
}

export function restoreMismatchedClaimedLock(claimedPath: string, originalPath: string): void {
    try {
        if (fs.existsSync(originalPath)) {
            throw new Error('Canonical lock path is already occupied');
        }
        fs.renameSync(claimedPath, originalPath);
    } catch (error: unknown) {
        const diagnostic = [
            `lock=${redactLockPath(originalPath)}`,
            `claimed=${redactLockPath(claimedPath)}`,
            `code=${getErrorCode(error) || 'UNKNOWN'}`,
            `message=${getErrorMessage(error)}`
        ].join('; ');
        process.stderr.write(`WARNING: LOCK_RELEASE_RESTORE_FAILED: ${diagnostic}\n`);
        throw new Error(`Failed to restore claimed lock: ${diagnostic}`);
    }
}

export function claimOwnedLockForRelease(lockPath: string, lockId: string): string | null {
    if (!lockMetadataMatchesLockId(readLockMetadata(lockPath), lockId)) return null;
    createLockReleaseIntent(lockPath, lockId);
    let releasingPath: string | null;
    try {
        releasingPath = renameLockPathWithRetry(
            lockPath,
            () => createTransientLockPath(lockPath, 'releasing', lockId),
            'filesystem_lock_release_claim',
            () => lockMetadataMatchesLockId(readLockMetadata(lockPath), lockId)
        );
    } finally {
        clearLockReleaseIntentAfterReleaseAttempt(lockPath, lockId);
    }
    if (!releasingPath) return null;

    const claimedMetadata = readLockMetadata(releasingPath);
    if (lockMetadataMatchesLockId(claimedMetadata, lockId)) {
        return releasingPath;
    }

    restoreMismatchedClaimedLock(releasingPath, lockPath);
    return null;
}
