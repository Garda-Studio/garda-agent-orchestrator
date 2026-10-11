import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS, FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV } from './task-events-locking-types';
import type { LockFreshness, LockInspectionResult, LockOptions, LockOwnerMetadata } from './task-events-locking-types';
import { getErrorCode, getErrorMessage, getLockOwnerCommand, parseBooleanLike, redactLockPath, toOptionalPositiveInteger } from './task-events-locking-support';

export function updateLockHeartbeatInPlace(
    metadataPath: string,
    serializeHeartbeat: (rawContent: string) => string | null
): void {
    let descriptor: number | undefined;
    try {
        const observed = fs.lstatSync(metadataPath, { bigint: true });
        if (!observed.isFile() || observed.ino <= 0n || observed.nlink !== 1n) return;
        descriptor = fs.openSync(metadataPath,
            fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== observed.dev
            || opened.ino !== observed.ino || opened.mode !== observed.mode
            || opened.birthtimeNs !== observed.birthtimeNs) return;
        const payload = serializeHeartbeat(fs.readFileSync(descriptor, 'utf8'));
        if (payload !== null) writeHeartbeatPayload(descriptor, payload);
    } catch (error: unknown) {
        if (!['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP'].includes(getErrorCode(error))) throw error;
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

function writeHeartbeatPayload(descriptor: number, payload: string): void {
    const bytes = Buffer.from(payload, 'utf8');
    let offset = 0;
    // readFileSync(fd) advances its offset; always write from position zero on the same object.
    while (offset < bytes.length) {
        const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (written <= 0) throw new Error('Lock heartbeat write made no progress.');
        offset += written;
    }
    fs.ftruncateSync(descriptor, bytes.length);
}

export function writeLockMetadata(lockPath: string, lockId: string, options: LockOptions | undefined): void {
    const metadataPath = path.join(lockPath, 'owner.json');
    const now = new Date().toISOString();
    const payload = {
        lock_id: lockId,
        pid: process.pid,
        hostname: os.hostname(),
        created_at_utc: now,
        heartbeat_at_utc: now,
        command: getLockOwnerCommand(options)
    };
    fs.writeFileSync(metadataPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

export function writeLockHeartbeat(lockPath: string, lockId: string): void {
    const metadataPath = path.join(lockPath, 'owner.json');
    updateLockHeartbeatInPlace(metadataPath, (rawContent) => {
        const metadata = parseLockMetadata(rawContent);
        if (!lockMetadataMatchesLockId(metadata, lockId)) return null;
        const payload = {
            lock_id: metadata.lock_id,
            pid: metadata.pid,
            hostname: metadata.hostname,
            created_at_utc: metadata.created_at_utc,
            heartbeat_at_utc: new Date().toISOString(),
            command: metadata.command
        };
        return JSON.stringify(payload, null, 2) + '\n';
    });
}

export function lockMetadataMatchesLockId(metadata: LockOwnerMetadata, lockId: string): boolean {
    return metadata.metadata_status === 'ok' && metadata.lock_id === lockId;
}

export function startLockHeartbeat(lockPath: string, lockId: string, options: LockOptions | undefined): ReturnType<typeof setInterval> | undefined {
    const heartbeatIntervalMs = toOptionalPositiveInteger(options?.heartbeatIntervalMs) ?? DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS;
    if (heartbeatIntervalMs <= 0) {
        return undefined;
    }
    const timer = setInterval(() => {
        try {
            writeLockHeartbeat(lockPath, lockId);
        } catch (error: unknown) {
            process.stderr.write(
                `WARNING: LOCK_HEARTBEAT_FAILED: lock=${redactLockPath(lockPath)}; message=${getErrorMessage(error)}\n`
            );
        }
    }, heartbeatIntervalMs);
    timer.unref?.();
    return timer;
}

export function readLockMetadata(lockPath: string): LockOwnerMetadata {
    const metadataPath = path.join(lockPath, 'owner.json');
    let rawContent = '';
    try {
        const stats = fs.statSync(metadataPath);
        if (!stats.isFile()) {
            return {
                lock_id: null,
                pid: null,
                hostname: null,
                created_at_utc: null,
                heartbeat_at_utc: null,
                command: null,
                metadata_status: 'missing'
            };
        }
        rawContent = fs.readFileSync(metadataPath, 'utf8');
    } catch (error: unknown) {
        const errorCode = error != null && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '')
            : '';
        if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR' || errorCode === 'EISDIR') {
            return {
                lock_id: null,
                pid: null,
                hostname: null,
                created_at_utc: null,
                heartbeat_at_utc: null,
                command: null,
                metadata_status: 'missing'
            };
        }
        return {
            lock_id: null,
            pid: null,
            hostname: null,
            created_at_utc: null,
            heartbeat_at_utc: null,
            command: null,
            metadata_status: 'missing'
        };
    }

    return parseLockMetadata(rawContent);
}

function parseLockMetadata(rawContent: string): LockOwnerMetadata {
    try {
        const parsed = JSON.parse(rawContent) as Record<string, unknown>;
        const lockIdValue = typeof parsed.lock_id === 'string' && parsed.lock_id.trim()
            ? parsed.lock_id.trim()
            : null;
        const pidValue = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
            ? parsed.pid
            : null;
        const hostnameValue = typeof parsed.hostname === 'string' && parsed.hostname.trim()
            ? parsed.hostname.trim()
            : null;
        const createdAtValue = typeof parsed.created_at_utc === 'string' && parsed.created_at_utc.trim()
            ? parsed.created_at_utc.trim()
            : null;
        const heartbeatAtValue = typeof parsed.heartbeat_at_utc === 'string' && parsed.heartbeat_at_utc.trim()
            ? parsed.heartbeat_at_utc.trim()
            : null;
        const commandValue = typeof parsed.command === 'string' && parsed.command.trim()
            ? parsed.command.trim()
            : null;
        const metadataStatus = pidValue || hostnameValue || createdAtValue
            ? 'ok'
            : 'invalid_shape';
        return {
            lock_id: lockIdValue,
            pid: pidValue,
            hostname: hostnameValue,
            created_at_utc: createdAtValue,
            heartbeat_at_utc: heartbeatAtValue,
            command: commandValue,
            metadata_status: metadataStatus
        };
    } catch {
        return {
            lock_id: null,
            pid: null,
            hostname: null,
            created_at_utc: null,
            heartbeat_at_utc: null,
            command: null,
            metadata_status: 'invalid_json'
        };
    }
}

export function parseUtcAgeMs(value: string | null | undefined): number | null {
    const timestampMs = Date.parse(String(value || ''));
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
        return null;
    }
    return Math.max(0, Date.now() - timestampMs);
}

export function getPathAgeMs(targetPath: string): number | null {
    try {
        const stats = fs.statSync(targetPath);
        return Math.max(0, Date.now() - stats.mtimeMs);
    } catch {
        return null;
    }
}

export function readLockFreshness(lockPath: string, metadata: LockOwnerMetadata): LockFreshness {
    const heartbeatAgeMs = parseUtcAgeMs(metadata.heartbeat_at_utc);
    const ownerFileAgeMs = getPathAgeMs(path.join(lockPath, 'owner.json'));
    const lockDirAgeMs = getPathAgeMs(lockPath);

    if (heartbeatAgeMs !== null) {
        return { freshnessSource: 'heartbeat', heartbeatAgeMs, ownerFileAgeMs, lockDirAgeMs };
    }
    if (ownerFileAgeMs !== null) {
        return { freshnessSource: 'owner_file', heartbeatAgeMs, ownerFileAgeMs, lockDirAgeMs };
    }
    if (lockDirAgeMs !== null) {
        return { freshnessSource: 'lock_dir', heartbeatAgeMs, ownerFileAgeMs, lockDirAgeMs };
    }
    return { freshnessSource: 'unknown', heartbeatAgeMs, ownerFileAgeMs, lockDirAgeMs };
}

export function isProcessLikelyAlive(pid: number | null): boolean | null {
    if (!pid || !Number.isInteger(pid) || pid <= 0) {
        return null;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        const errorCode = error != null && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '')
            : '';
        if (errorCode === 'EPERM') {
            return true;
        }
        if (errorCode === 'ESRCH') {
            return false;
        }
        return null;
    }
}

export function normalizeHostname(hostname: string | null): string | null {
    const trimmed = typeof hostname === 'string' ? hostname.trim() : '';
    return trimmed ? trimmed.toLowerCase() : null;
}

export function isCurrentHostOwner(hostname: string | null): boolean | null {
    const ownerHost = normalizeHostname(hostname);
    if (!ownerHost) {
        return null;
    }
    return ownerHost === normalizeHostname(os.hostname());
}

export function allowForeignHostStaleRecovery(options: LockOptions | undefined): boolean {
    if (options && options.allowForeignHostStaleRecovery !== undefined) {
        return parseBooleanLike(options.allowForeignHostStaleRecovery);
    }
    return parseBooleanLike(process.env[FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV]);
}

export function requiresExplicitAgeRecovery(inspection: LockInspectionResult): boolean {
    return inspection.ownerHostMatchesCurrent === false && inspection.staleReason === 'age_exceeded';
}
