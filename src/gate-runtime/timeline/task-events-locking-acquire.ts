import * as fs from 'node:fs';
import * as path from 'node:path';

import { redactHostname as redactHostnameValue } from '../../core/redaction';
import { DEFAULT_LOCK_RETRY_MS, DEFAULT_LOCK_STALE_MS, DEFAULT_LOCK_TIMEOUT_MS, LOCK_CONTENTION_WARN_THRESHOLD } from './task-events-locking-types';
import type { AcquireLockTelemetry, LockHandle, LockInspectionResult, LockOptions } from './task-events-locking-types';
import { classifyLockContention, createLockId, redactLockPath, resolveMaxLockRetries, sleepMsAsync, sleepMsSync, toPositiveInteger } from './task-events-locking-support';
import { allowForeignHostStaleRecovery, isCurrentHostOwner, requiresExplicitAgeRecovery, startLockHeartbeat, writeLockMetadata } from './task-events-locking-metadata';
import { claimOwnedLockForRelease, isRetryableLockAcquireError, removeLockPath, removeLockPathWithRetry, resolveActiveLockReleaseIntentLockId } from './task-events-locking-release';
import { formatLockDiagnostic, inspectLock, tryRemoveStaleLock } from './task-events-locking-inspection';

export function acquireFilesystemLock(lockPath: string, options: LockOptions = {}): { handle: LockHandle; telemetry: AcquireLockTelemetry } {
    const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : undefined;
    const timeoutMs = toPositiveInteger(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    const retryMs = toPositiveInteger(options.retryMs, DEFAULT_LOCK_RETRY_MS);
    const staleMs = toPositiveInteger(options.staleMs, DEFAULT_LOCK_STALE_MS);
    const maxRetries = resolveMaxLockRetries(timeoutMs, retryMs);
    const startedAt = Date.now();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let lastInspection: LockInspectionResult = inspectLock(lockPath, staleMs);
    let releaseIntentLockId = lastInspection.metadata.lock_id;
    let retries = 0;
    let contentionWarned = false;
    let staleLockRecovered = false;
    let staleLockReason: 'owner_dead' | 'age_exceeded' | null = null;

    while (true) {
        try {
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            const lockId = createLockId();
            fs.mkdirSync(lockPath);
            try {
                writeLockMetadata(lockPath, lockId, options);
            } catch (metadataError: unknown) {
                removeLockPath(lockPath);
                throw metadataError;
            }
            const elapsedMs = Date.now() - startedAt;
            return {
                handle: { lockPath, lockId, ...(projectRoot ? { projectRoot } : {}) },
                telemetry: {
                    retries,
                    elapsedMs,
                    contentionLevel: classifyLockContention(retries, elapsedMs),
                    staleLockRecovered,
                    staleLockReason
                }
            };
        } catch (error: unknown) {
            const errCode = error != null && typeof error === 'object' && 'code' in error
                ? (error as { code?: string }).code
                : undefined;
            if (!isRetryableLockAcquireError(error)) {
                throw error;
            }

            if (errCode === 'EEXIST') {
                const activeReleaseIntentLockId = resolveActiveLockReleaseIntentLockId(
                    lockPath,
                    releaseIntentLockId || lastInspection.metadata.lock_id
                );
                if (activeReleaseIntentLockId) {
                    releaseIntentLockId = activeReleaseIntentLockId;
                } else {
                    const staleAttempt = tryRemoveStaleLock(lockPath, staleMs, { ...options, projectRoot });
                    lastInspection = staleAttempt.inspection;
                    releaseIntentLockId = lastInspection.metadata.lock_id;
                    if (staleAttempt.removed) {
                        staleLockRecovered = true;
                        staleLockReason = staleAttempt.inspection.staleReason;
                        continue;
                    }
                }
            } else {
                lastInspection = inspectLock(lockPath, staleMs);
                releaseIntentLockId = lastInspection.metadata.lock_id;
            }

            const ownerHostMatchesCurrent = isCurrentHostOwner(lastInspection.metadata.hostname);
            const currentProcessOwnsLock = lastInspection.metadata.pid === process.pid
                && ownerHostMatchesCurrent !== false
                && lastInspection.ownerAlive !== false;
            if (
                lastInspection.exists
                && (
                currentProcessOwnsLock
                || ownerHostMatchesCurrent === false
                || (requiresExplicitAgeRecovery(lastInspection) && !allowForeignHostStaleRecovery(options))
                )
            ) {
                const waitedMs = Date.now() - startedAt;
                throw new Error(
                    formatLockDiagnostic(lockPath, lastInspection, timeoutMs, waitedMs)
                    + '; retries=0; wait_strategy=immediate_fail'
                );
            }

            retries += 1;

            if (!contentionWarned && retries >= LOCK_CONTENTION_WARN_THRESHOLD) {
                contentionWarned = true;
                const elapsedMs = Date.now() - startedAt;
                const ownerPid = lastInspection.metadata.pid !== null ? String(lastInspection.metadata.pid) : 'unknown';
                const ownerHost = redactHostnameValue(lastInspection.metadata.hostname) || 'unknown';
                process.stderr.write(
                    `WARNING: lock contention on ${redactLockPath(lockPath)} (retries=${retries}, elapsed_ms=${elapsedMs}, owner_pid=${ownerPid}, owner_host=${ownerHost})\n`
                );
            }

            const waitedMs = Date.now() - startedAt;
            if (retries >= maxRetries) {
                throw new Error(
                    formatLockDiagnostic(lockPath, lastInspection, timeoutMs, waitedMs)
                    + `; retries=${retries}; max_retries=${maxRetries}; wait_strategy=sync_retry`
                );
            }

            if (waitedMs >= timeoutMs) {
                throw new Error(
                    formatLockDiagnostic(lockPath, lastInspection, timeoutMs, waitedMs)
                    + `; retries=${retries}; wait_strategy=sync_retry`
                );
            }

            sleepMsSync(retryMs);
        }
    }
}

export async function acquireFilesystemLockAsync(lockPath: string, options: LockOptions = {}): Promise<{ handle: LockHandle; telemetry: AcquireLockTelemetry }> {
    const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : undefined;
    const timeoutMs = toPositiveInteger(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    const retryMs = toPositiveInteger(options.retryMs, DEFAULT_LOCK_RETRY_MS);
    const staleMs = toPositiveInteger(options.staleMs, DEFAULT_LOCK_STALE_MS);
    const maxRetries = resolveMaxLockRetries(timeoutMs, retryMs);
    const startedAt = Date.now();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let lastInspection: LockInspectionResult = inspectLock(lockPath, staleMs);
    let releaseIntentLockId = lastInspection.metadata.lock_id;
    let retries = 0;
    let contentionWarned = false;
    let staleLockRecovered = false;
    let staleLockReason: 'owner_dead' | 'age_exceeded' | null = null;

    while (true) {
        try {
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            const lockId = createLockId();
            fs.mkdirSync(lockPath);
            try {
                writeLockMetadata(lockPath, lockId, options);
            } catch (metadataError: unknown) {
                removeLockPath(lockPath);
                throw metadataError;
            }
            const elapsedMs = Date.now() - startedAt;
            const contentionLevel = classifyLockContention(retries, elapsedMs);
            if (contentionLevel !== 'none' && contentionLevel !== 'low') {
                process.stderr.write(
                    `CONTENTION_RESOLVED: lock=${redactLockPath(lockPath)}; retries=${retries}; elapsed_ms=${elapsedMs}; contention_level=${contentionLevel}; stale_recovered=${staleLockRecovered}\n`
                );
            }
            const heartbeatTimer = startLockHeartbeat(lockPath, lockId, options);
            return {
                handle: { lockPath, lockId, heartbeatTimer, ...(projectRoot ? { projectRoot } : {}) },
                telemetry: {
                    retries,
                    elapsedMs,
                    contentionLevel,
                    staleLockRecovered,
                    staleLockReason
                }
            };
        } catch (error: unknown) {
            const errCode = error != null && typeof error === 'object' && 'code' in error
                ? (error as { code?: string }).code
                : undefined;
            if (!isRetryableLockAcquireError(error)) {
                throw error;
            }

            if (errCode === 'EEXIST') {
                const activeReleaseIntentLockId = resolveActiveLockReleaseIntentLockId(
                    lockPath,
                    releaseIntentLockId || lastInspection.metadata.lock_id
                );
                if (activeReleaseIntentLockId) {
                    releaseIntentLockId = activeReleaseIntentLockId;
                } else {
                    const staleAttempt = tryRemoveStaleLock(lockPath, staleMs, { ...options, projectRoot });
                    lastInspection = staleAttempt.inspection;
                    releaseIntentLockId = lastInspection.metadata.lock_id;
                    if (staleAttempt.removed) {
                        staleLockRecovered = true;
                        staleLockReason = staleAttempt.inspection.staleReason;
                        continue;
                    }
                }
            } else {
                lastInspection = inspectLock(lockPath, staleMs);
                releaseIntentLockId = lastInspection.metadata.lock_id;
            }

            const ownerHostMatchesCurrent = isCurrentHostOwner(lastInspection.metadata.hostname);
            const currentProcessOwnsLock = lastInspection.metadata.pid === process.pid
                && ownerHostMatchesCurrent !== false
                && lastInspection.ownerAlive !== false;
            if (
                lastInspection.exists
                && (
                currentProcessOwnsLock
                || ownerHostMatchesCurrent === false
                || (requiresExplicitAgeRecovery(lastInspection) && !allowForeignHostStaleRecovery(options))
                )
            ) {
                const waitedMs = Date.now() - startedAt;
                throw new Error(
                    formatLockDiagnostic(lockPath, lastInspection, timeoutMs, waitedMs)
                    + '; retries=0; wait_strategy=immediate_fail'
                );
            }

            retries += 1;

            if (!contentionWarned && retries >= LOCK_CONTENTION_WARN_THRESHOLD) {
                contentionWarned = true;
                const elapsedMs = Date.now() - startedAt;
                const ownerPid = lastInspection.metadata.pid !== null ? String(lastInspection.metadata.pid) : 'unknown';
                const ownerHost = redactHostnameValue(lastInspection.metadata.hostname) || 'unknown';
                process.stderr.write(
                    `WARNING: lock contention on ${redactLockPath(lockPath)} (retries=${retries}, elapsed_ms=${elapsedMs}, owner_pid=${ownerPid}, owner_host=${ownerHost})\n`
                );
            }

            if (retries >= maxRetries) {
                const elapsedMs = Date.now() - startedAt;
                throw new Error(
                    formatLockDiagnostic(lockPath, lastInspection, timeoutMs, elapsedMs)
                    + `; retries=${retries}; max_retries=${maxRetries}`
                );
            }

            const waitedMs = Date.now() - startedAt;
            if (waitedMs >= timeoutMs) {
                throw new Error(
                    formatLockDiagnostic(lockPath, lastInspection, timeoutMs, waitedMs)
                    + `; retries=${retries}`
                );
            }

            await sleepMsAsync(retryMs);
        }
    }
}

export function releaseFilesystemLock(lockHandle: LockHandle | null): void {
    if (!lockHandle || !lockHandle.lockPath) {
        return;
    }
    if (!lockHandle.lockId) {
        return;
    }
    if (lockHandle.heartbeatTimer) {
        clearInterval(lockHandle.heartbeatTimer);
    }
    const claimedPath = claimOwnedLockForRelease(lockHandle.lockPath, lockHandle.lockId, lockHandle.projectRoot);
    if (!claimedPath) {
        return;
    }
    removeLockPathWithRetry(claimedPath, 'filesystem_lock_release');
}

export function withFilesystemLock<T>(lockPath: string, options: LockOptions, callback: () => T): { result: T; telemetry: AcquireLockTelemetry } {
    const { handle, telemetry } = acquireFilesystemLock(lockPath, options);
    try {
        return { result: callback(), telemetry };
    } finally {
        releaseFilesystemLock(handle);
    }
}

export async function withFilesystemLockAsync<T>(lockPath: string, options: LockOptions, callback: () => Promise<T> | T): Promise<{ result: T; telemetry: AcquireLockTelemetry }> {
    const { handle, telemetry } = await acquireFilesystemLockAsync(lockPath, options);
    try {
        return { result: await callback(), telemetry };
    } finally {
        releaseFilesystemLock(handle);
    }
}
