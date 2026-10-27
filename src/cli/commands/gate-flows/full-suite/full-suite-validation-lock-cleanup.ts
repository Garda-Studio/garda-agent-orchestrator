import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { redactHostname } from '../../../../core/redaction';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { resolveGardaCliPrefix } from '../../../../core/garda-cli-prefix';

const FULL_SUITE_GENERATED_LOCKS = Object.freeze([
    '.scripts-build.lock',
    '.node-build.lock',
    'dist.lock'
]);
const GENERATED_LOCK_STALE_THRESHOLD_MS = 30 * 60 * 1000;

type GeneratedLockOwnerMetadataStatus = 'ok' | 'missing' | 'invalid_json' | 'invalid_shape' | 'read_error';

interface GeneratedLockOwnerMetadata {
    readonly pid: number | null;
    readonly hostname: string | null;
    readonly created_at_utc: string | null;
    readonly metadata_status: GeneratedLockOwnerMetadataStatus;
}

export interface GeneratedLockCleanupInspectionOptions {
    readonly nowMs?: number;
    readonly readOwnerFile?: (ownerPath: string) => string;
    readonly statPath?: (targetPath: string) => Pick<fs.Stats, 'mtimeMs' | 'isFile' | 'isDirectory'>;
    readonly processAlive?: (pid: number | null) => boolean | null;
    readonly removeLockPath?: (lockPath: string) => void;
}

export interface GeneratedLockCleanupObservation {
    readonly lock_path: string;
    readonly removed: boolean;
    readonly reason: string;
    readonly owner_pid: number | null;
    readonly owner_alive: boolean | null;
    readonly owner_hostname: string | null;
    readonly owner_created_at_utc: string | null;
    readonly owner_metadata_status: GeneratedLockOwnerMetadataStatus;
    readonly owner_host_matches_current: boolean | null;
    readonly lock_age_ms: number | null;
    readonly owner_file_age_ms: number | null;
    readonly stale_threshold_ms: number;
    readonly recommended_next_command: string;
}

function readGeneratedLockOwnerMetadata(
    lockPath: string,
    options: GeneratedLockCleanupInspectionOptions
): GeneratedLockOwnerMetadata {
    const ownerPath = path.join(lockPath, 'owner.json');
    let rawContent = '';
    try {
        const ownerStats = statPath(ownerPath, options);
        if (!ownerStats.isFile()) {
            return buildEmptyOwnerMetadata('missing');
        }
        rawContent = readOwnerFile(ownerPath, options);
    } catch (error: unknown) {
        const code = error != null && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '')
            : '';
        return buildEmptyOwnerMetadata(code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR'
            ? 'missing'
            : 'read_error');
    }

    try {
        const parsed = JSON.parse(rawContent) as Record<string, unknown>;
        const ownerPid = Number.isInteger(parsed.pid) && Number(parsed.pid) > 0
            ? Number(parsed.pid)
            : null;
        const ownerHostname = typeof parsed.hostname === 'string' && parsed.hostname.trim()
            ? parsed.hostname.trim()
            : null;
        const ownerCreatedAtUtc =
            typeof parsed.created_at_utc === 'string' && parsed.created_at_utc.trim()
                ? parsed.created_at_utc.trim()
                : typeof parsed.startedAtUtc === 'string' && parsed.startedAtUtc.trim()
                    ? parsed.startedAtUtc.trim()
                    : null;
        return {
            pid: ownerPid,
            hostname: ownerHostname,
            created_at_utc: ownerCreatedAtUtc,
            metadata_status: ownerPid !== null || ownerHostname !== null || ownerCreatedAtUtc !== null
                ? 'ok'
                : 'invalid_shape'
        };
    } catch {
        return buildEmptyOwnerMetadata('invalid_json');
    }
}

function buildEmptyOwnerMetadata(metadataStatus: GeneratedLockOwnerMetadataStatus): GeneratedLockOwnerMetadata {
    return {
        pid: null,
        hostname: null,
        created_at_utc: null,
        metadata_status: metadataStatus
    };
}

function readOwnerFile(ownerPath: string, options: GeneratedLockCleanupInspectionOptions): string {
    return options.readOwnerFile
        ? options.readOwnerFile(ownerPath)
        : fs.readFileSync(ownerPath, 'utf8');
}

function statPath(
    targetPath: string,
    options: GeneratedLockCleanupInspectionOptions
): Pick<fs.Stats, 'mtimeMs' | 'isFile' | 'isDirectory'> {
    return options.statPath
        ? options.statPath(targetPath)
        : fs.statSync(targetPath);
}

function getPathAgeMs(targetPath: string, options: GeneratedLockCleanupInspectionOptions): number | null {
    try {
        return Math.max(0, getNowMs(options) - statPath(targetPath, options).mtimeMs);
    } catch {
        return null;
    }
}

function getNowMs(options: GeneratedLockCleanupInspectionOptions): number {
    return typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)
        ? options.nowMs
        : Date.now();
}

function isCurrentHostOwner(hostname: string | null): boolean | null {
    const normalizedOwner = normalizeHostname(hostname);
    if (!normalizedOwner) {
        return null;
    }
    return normalizedOwner === normalizeHostname(os.hostname());
}

function normalizeHostname(hostname: string | null): string | null {
    const trimmed = typeof hostname === 'string' ? hostname.trim() : '';
    return trimmed ? trimmed.toLowerCase() : null;
}

function isProcessAlive(pid: number | null, options: GeneratedLockCleanupInspectionOptions): boolean | null {
    if (options.processAlive) {
        return options.processAlive(pid);
    }
    if (pid === null || !Number.isInteger(pid) || pid <= 0) {
        return null;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        const code = error != null && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '')
            : '';
        if (code === 'ESRCH') {
            return false;
        }
        if (code === 'EPERM') {
            return true;
        }
        return null;
    }
}

export function cleanupGeneratedLocksAfterTimedOutFullSuite(
    repoRoot: string,
    options: GeneratedLockCleanupInspectionOptions = {}
): GeneratedLockCleanupObservation[] {
    const observations: GeneratedLockCleanupObservation[] = [];
    const resolvedRoot = path.resolve(repoRoot);

    for (const lockName of FULL_SUITE_GENERATED_LOCKS) {
        const lockPath = path.resolve(resolvedRoot, lockName);
        if (!lockPath.startsWith(`${resolvedRoot}${path.sep}`)) {
            continue;
        }
        if (!fs.existsSync(lockPath) || !fs.statSync(lockPath).isDirectory()) {
            continue;
        }

        const ownerMetadata = readGeneratedLockOwnerMetadata(lockPath, options);
        const ownerPid = ownerMetadata.pid;
        const ownerAlive = isProcessAlive(ownerPid, options);
        const ownerHostMatchesCurrent = isCurrentHostOwner(ownerMetadata.hostname);
        const commonObservation = buildGeneratedLockCleanupObservationBase(lockPath, ownerMetadata, ownerAlive, ownerHostMatchesCurrent, options);
        if (ownerPid !== null && ownerAlive === false && ownerHostMatchesCurrent !== false) {
            removeLockPath(lockPath, options);
            observations.push({
                ...commonObservation,
                removed: true,
                reason: 'owner_process_dead_after_full_suite_timeout',
                recommended_next_command: 'Retry the full-suite-validation command; the dead generated lock was removed after preserving timeout evidence.'
            });
            continue;
        }

        observations.push({
            ...commonObservation,
            removed: false,
            reason: resolveRetainedGeneratedLockReason(ownerMetadata, ownerAlive, ownerHostMatchesCurrent),
            recommended_next_command: buildRetainedGeneratedLockRecommendation(ownerMetadata, ownerAlive, ownerHostMatchesCurrent, resolveGardaCliPrefix(resolvedRoot))
        });
    }

    return observations;
}

function removeLockPath(lockPath: string, options: GeneratedLockCleanupInspectionOptions): void {
    if (options.removeLockPath) {
        options.removeLockPath(lockPath);
        return;
    }
    fs.rmSync(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function buildGeneratedLockCleanupObservationBase(
    lockPath: string,
    ownerMetadata: GeneratedLockOwnerMetadata,
    ownerAlive: boolean | null,
    ownerHostMatchesCurrent: boolean | null,
    options: GeneratedLockCleanupInspectionOptions
): Omit<GeneratedLockCleanupObservation, 'removed' | 'reason' | 'recommended_next_command'> {
    return {
        lock_path: gateHelpers.normalizePath(lockPath),
        owner_pid: ownerMetadata.pid,
        owner_alive: ownerAlive,
        owner_hostname: redactHostname(ownerMetadata.hostname),
        owner_created_at_utc: ownerMetadata.created_at_utc,
        owner_metadata_status: ownerMetadata.metadata_status,
        owner_host_matches_current: ownerHostMatchesCurrent,
        lock_age_ms: getPathAgeMs(lockPath, options),
        owner_file_age_ms: getPathAgeMs(path.join(lockPath, 'owner.json'), options),
        stale_threshold_ms: GENERATED_LOCK_STALE_THRESHOLD_MS
    };
}

function resolveRetainedGeneratedLockReason(
    ownerMetadata: GeneratedLockOwnerMetadata,
    ownerAlive: boolean | null,
    ownerHostMatchesCurrent: boolean | null
): string {
    if (ownerMetadata.metadata_status === 'missing') {
        return 'owner_metadata_missing_after_full_suite_timeout';
    }
    if (ownerMetadata.metadata_status === 'read_error') {
        return 'owner_metadata_transient_read_error_after_full_suite_timeout';
    }
    if (ownerMetadata.metadata_status === 'invalid_json' || ownerMetadata.metadata_status === 'invalid_shape') {
        return 'owner_metadata_invalid_after_full_suite_timeout';
    }
    if (ownerHostMatchesCurrent === false) {
        return 'owner_foreign_host_after_full_suite_timeout';
    }
    if (ownerAlive === true) {
        return 'owner_process_still_alive_after_full_suite_timeout';
    }
    return 'owner_process_unknown_after_full_suite_timeout';
}

function buildRetainedGeneratedLockRecommendation(
    ownerMetadata: GeneratedLockOwnerMetadata,
    ownerAlive: boolean | null,
    ownerHostMatchesCurrent: boolean | null,
    cliPrefix: string
): string {
    if (ownerMetadata.metadata_status === 'missing'
        || ownerMetadata.metadata_status === 'read_error'
        || ownerMetadata.metadata_status === 'invalid_json'
        || ownerMetadata.metadata_status === 'invalid_shape') {
        return `Run \`${cliPrefix} doctor --target-root "."\` and inspect the retained generated lock owner metadata before manual cleanup.`;
    }
    if (ownerHostMatchesCurrent === false) {
        return 'Verify the foreign-host owner is gone before cleanup; do not remove this lock automatically from the local timeout handler.';
    }
    if (ownerAlive === true) {
        return 'Wait for the owner process to exit or stop it explicitly, then rerun the full-suite-validation command.';
    }
    return 'Inspect the owner process state and rerun full-suite-validation only after the retained lock is explained.';
}

export function formatGeneratedLockCleanupObservation(observation: GeneratedLockCleanupObservation): string {
    const action = observation.removed ? 'removed' : 'retained';
    const ownerPid = observation.owner_pid === null ? 'unknown' : String(observation.owner_pid);
    const ownerAlive = observation.owner_alive === null ? 'unknown' : (observation.owner_alive ? 'yes' : 'no');
    const ownerHost = observation.owner_hostname || 'unknown';
    const ownerCreatedAt = observation.owner_created_at_utc || 'unknown';
    const hostMatches = observation.owner_host_matches_current === null
        ? 'unknown'
        : (observation.owner_host_matches_current ? 'yes' : 'no');
    const lockAge = observation.lock_age_ms === null ? 'unknown' : `${observation.lock_age_ms}ms`;
    const ownerFileAge = observation.owner_file_age_ms === null ? 'unknown' : `${observation.owner_file_age_ms}ms`;
    return `Full-suite timeout cleanup ${action} generated lock ${observation.lock_path} `
        + `(reason=${observation.reason}; owner_metadata_status=${observation.owner_metadata_status}; `
        + `lock_age_ms=${lockAge}; owner_file_age_ms=${ownerFileAge}; stale_threshold_ms=${observation.stale_threshold_ms}; `
        + `owner_pid=${ownerPid}; owner_alive=${ownerAlive}; owner_hostname=${ownerHost}; `
        + `owner_created_at_utc=${ownerCreatedAt}; owner_host_matches_current=${hostMatches}; `
        + `recommended_next_command=${observation.recommended_next_command}).`;
}
