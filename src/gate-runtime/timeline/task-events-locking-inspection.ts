import * as fs from 'node:fs';

import { redactHostname as redactHostnameValue } from '../../core/redaction';
import { DEFAULT_LOCK_STALE_MS, FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV, LOCK_METADATA_GRACE_MS } from './task-events-locking-types';
import type { LockInspectionResult, LockOptions } from './task-events-locking-types';
import { redactLockPath, toPositiveInteger } from './task-events-locking-support';
import { allowForeignHostStaleRecovery, isCurrentHostOwner, isProcessLikelyAlive, readLockFreshness, readLockMetadata, requiresExplicitAgeRecovery } from './task-events-locking-metadata';
import { createTransientLockPath, lockMetadataMatchesCandidate, removeLockPath, restoreMismatchedClaimedLock } from './task-events-locking-release';

export function inspectLock(lockPath: string, staleMs: number): LockInspectionResult {
    const metadata = readLockMetadata(lockPath);
    const freshness = readLockFreshness(lockPath, metadata);
    const ageMs = freshness.freshnessSource === 'unknown'
        ? null
        : (freshness.heartbeatAgeMs ?? freshness.ownerFileAgeMs ?? freshness.lockDirAgeMs);
    if (freshness.lockDirAgeMs === null) {
        return {
            exists: false,
            ageMs: null,
            freshness,
            metadata,
            ownerHostMatchesCurrent: null,
            ownerAlive: null,
            staleReason: null
        };
    }

    const ownerHostMatchesCurrent = isCurrentHostOwner(metadata.hostname);
    const ownerAlive = ownerHostMatchesCurrent === false
        ? null
        : isProcessLikelyAlive(metadata.pid);
    if (ownerAlive === false) {
        return {
            exists: true,
            ageMs,
            freshness,
            metadata,
            ownerHostMatchesCurrent,
            ownerAlive,
            staleReason: 'owner_dead'
        };
    }

    if (metadata.pid === null
        && ageMs !== null
        && staleMs > 0
        && ageMs >= staleMs
        && ownerHostMatchesCurrent === false) {
        return {
            exists: true,
            ageMs,
            freshness,
            metadata,
            ownerHostMatchesCurrent,
            ownerAlive: null,
            staleReason: 'age_exceeded'
        };
    }

    if (metadata.pid === null
        && ownerHostMatchesCurrent !== false
        && ageMs !== null && ageMs >= LOCK_METADATA_GRACE_MS) {
        return {
            exists: true,
            ageMs,
            freshness,
            metadata,
            ownerHostMatchesCurrent,
            ownerAlive: null,
            staleReason: 'owner_dead'
        };
    }

    if (staleMs > 0
        && ageMs !== null
        && ageMs >= staleMs
        && ownerHostMatchesCurrent === false
        && ownerAlive !== true) {
        return {
            exists: true,
            ageMs,
            freshness,
            metadata,
            ownerHostMatchesCurrent,
            ownerAlive,
            staleReason: 'age_exceeded'
        };
    }

    return {
        exists: true,
        ageMs,
        freshness,
        metadata,
        ownerHostMatchesCurrent,
        ownerAlive,
        staleReason: null
    };
}

export function inspectFilesystemLock(lockPath: string, options: LockOptions = {}): LockInspectionResult {
    const staleMs = toPositiveInteger(options.staleMs, DEFAULT_LOCK_STALE_MS);
    return inspectLock(lockPath, staleMs);
}

export function filesystemLockRequiresExplicitForeignHostRecovery(inspection: LockInspectionResult): boolean {
    return requiresExplicitAgeRecovery(inspection);
}

export function isForeignHostFilesystemLockRecoveryAllowed(options: LockOptions = {}): boolean {
    return allowForeignHostStaleRecovery(options);
}

export function reclaimStaleFilesystemLock(lockPath: string, options: LockOptions = {}): { removed: boolean; inspection: LockInspectionResult } {
    const staleMs = toPositiveInteger(options.staleMs, DEFAULT_LOCK_STALE_MS);
    return tryRemoveStaleLock(lockPath, staleMs, options);
}

export function formatLockDiagnostic(lockPath: string, inspection: LockInspectionResult, timeoutMs: number, waitedMs: number): string {
    const ageText = typeof inspection.ageMs === 'number' ? `${inspection.ageMs}ms` : 'unknown';
    const heartbeatAgeText = typeof inspection.freshness.heartbeatAgeMs === 'number' ? `${inspection.freshness.heartbeatAgeMs}ms` : 'unknown';
    const ownerFileAgeText = typeof inspection.freshness.ownerFileAgeMs === 'number' ? `${inspection.freshness.ownerFileAgeMs}ms` : 'unknown';
    const lockDirAgeText = typeof inspection.freshness.lockDirAgeMs === 'number' ? `${inspection.freshness.lockDirAgeMs}ms` : 'unknown';
    const ownerPidText = inspection.metadata.pid !== null ? String(inspection.metadata.pid) : 'unknown';
    const ownerAliveText = inspection.ownerAlive === null ? 'unknown' : (inspection.ownerAlive ? 'yes' : 'no');
    const ownerHostText = redactHostnameValue(inspection.metadata.hostname) || 'unknown';
    const createdAtText = inspection.metadata.created_at_utc || 'unknown';
    const staleReasonText = inspection.staleReason || 'none';
    const redactedLockPath = redactLockPath(lockPath);
    return [
        `Timed out acquiring file lock: ${redactedLockPath}`,
        `waited_ms=${waitedMs}`,
        `timeout_ms=${timeoutMs}`,
        `lock_age_ms=${ageText}`,
        `freshness_source=${inspection.freshness.freshnessSource}`,
        `heartbeat_age_ms=${heartbeatAgeText}`,
        `owner_file_age_ms=${ownerFileAgeText}`,
        `lock_dir_age_ms=${lockDirAgeText}`,
        `owner_pid=${ownerPidText}`,
        `owner_alive=${ownerAliveText}`,
        `owner_hostname=${ownerHostText}`,
        `owner_created_at_utc=${createdAtText}`,
        `owner_metadata_status=${inspection.metadata.metadata_status}`,
        `stale_reason=${staleReasonText}`,
        requiresExplicitAgeRecovery(inspection)
            ? `foreign_host_recovery_hint=verify remote owner is gone, then rerun with ${FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV}=1`
            : ''
    ].filter(Boolean).join('; ');
}

export function tryRemoveStaleLock(lockPath: string, staleMs: number, options: LockOptions = {}): { removed: boolean; inspection: LockInspectionResult } {
    const inspection = inspectLock(lockPath, staleMs);
    if (!inspection.exists || !inspection.staleReason) {
        return { removed: false, inspection };
    }
    if (options.requireKnownDeadOwner === true && (
        inspection.metadata.metadata_status !== 'ok' || !inspection.metadata.lock_id
        || inspection.metadata.pid === null || inspection.ownerHostMatchesCurrent !== true
        || inspection.ownerAlive !== false
    )) {
        return { removed: false, inspection };
    }
    if (requiresExplicitAgeRecovery(inspection) && !allowForeignHostStaleRecovery(options)) {
        return { removed: false, inspection };
    }

    const tempPath = createTransientLockPath(lockPath, 'stale', inspection.metadata.lock_id || undefined);
    try {
        fs.renameSync(lockPath, tempPath);
    } catch {
        return { removed: false, inspection };
    }

    const claimedInspection = inspectLock(tempPath, staleMs);
    if (!claimedInspection.exists
        || !claimedInspection.staleReason
        || !lockMetadataMatchesCandidate(inspection.metadata, claimedInspection.metadata)) {
        restoreMismatchedClaimedLock(tempPath, lockPath);
        return { removed: false, inspection: claimedInspection.exists ? claimedInspection : inspection };
    }

    removeLockPath(tempPath);

    return { removed: true, inspection };
}
