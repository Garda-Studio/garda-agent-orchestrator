export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
export const DEFAULT_LOCK_RETRY_MS = 25;
export const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000;
export const DEFAULT_LOCK_RELEASE_RETRY_MS = 25;
export const DEFAULT_LOCK_RELEASE_RETRIES = 8;
export const MAX_LOCK_RELEASE_RETRY_MS = 250;
export const MAX_LOCK_RETRIES = 500;
export const LOCK_CONTENTION_WARN_THRESHOLD = 10;
export const LOCK_METADATA_GRACE_MS = 2000;
export const LOCK_OWNER_COMMAND_MAX_LENGTH = 160;
export const DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS = 10_000;
export const FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV = 'GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS';
export const TRANSIENT_LOCK_ACQUIRE_ERROR_CODES = new Set(['EEXIST', 'ENOENT', 'ENOTDIR', 'EPERM', 'EACCES', 'EBUSY']);
export const TRANSIENT_LOCK_RELEASE_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

export interface LockOptions {
    requireKnownDeadOwner?: boolean;
    timeoutMs?: unknown;
    retryMs?: unknown;
    staleMs?: unknown;
    heartbeatIntervalMs?: unknown;
    allowForeignHostStaleRecovery?: unknown;
    ownerLabel?: unknown;
}

export interface LockHandle {
    lockPath: string;
    lockId?: string;
    heartbeatTimer?: ReturnType<typeof setInterval>;
}

export interface LockOwnerMetadata {
    lock_id?: string | null;
    pid: number | null;
    hostname: string | null;
    created_at_utc: string | null;
    heartbeat_at_utc?: string | null;
    command?: string | null;
    metadata_status: 'missing' | 'invalid_json' | 'invalid_shape' | 'ok';
}

export interface LockInspectionResult {
    exists: boolean;
    ageMs: number | null;
    freshness: LockFreshness;
    metadata: LockOwnerMetadata;
    ownerHostMatchesCurrent: boolean | null;
    ownerAlive: boolean | null;
    staleReason: 'owner_dead' | 'age_exceeded' | null;
}

export type LockFreshnessSource = 'heartbeat' | 'owner_file' | 'lock_dir' | 'unknown';

export interface LockFreshness {
    freshnessSource: LockFreshnessSource;
    heartbeatAgeMs: number | null;
    ownerFileAgeMs: number | null;
    lockDirAgeMs: number | null;
}

export type LockContentionLevel = 'none' | 'low' | 'moderate' | 'high';
export type TaskEventLockStatus = 'ACTIVE' | 'STALE';

export interface AcquireLockTelemetry {
    retries: number;
    elapsedMs: number;
    contentionLevel: LockContentionLevel;
    staleLockRecovered: boolean;
    staleLockReason: 'owner_dead' | 'age_exceeded' | null;
}

export interface LockWaitEntry {
    retries: number;
    elapsed_ms: number;
    contention_level: LockContentionLevel;
    stale_recovered: boolean;
    stale_reason: 'owner_dead' | 'age_exceeded' | null;
}

export interface LockWaitDiagnostics {
    task_lock: LockWaitEntry;
    aggregate_lock: LockWaitEntry;
    overall_contention_level: LockContentionLevel;
    summary: string;
}

export interface TaskEventLockHealth {
    lock_name: string;
    lock_path: string;
    scope: 'aggregate' | 'task';
    task_id: string | null;
    status: TaskEventLockStatus;
    age_ms: number | null;
    heartbeat_age_ms: number | null;
    owner_file_age_ms: number | null;
    lock_dir_age_ms: number | null;
    freshness_source: LockFreshnessSource;
    owner_pid: number | null;
    owner_hostname: string | null;
    owner_created_at_utc: string | null;
    owner_alive: boolean | null;
    owner_metadata_status: LockOwnerMetadata['metadata_status'];
    stale_reason: LockInspectionResult['staleReason'];
    remediation: string;
}

export interface TaskEventLockScanResult {
    lock_root: string;
    subsystem_scope_note: string;
    locks: TaskEventLockHealth[];
    active_count: number;
    stale_count: number;
}

export interface TaskEventLockCleanupResult {
    lock_root: string;
    dry_run: boolean;
    removed_locks: string[];
    removable_stale_locks: string[];
    retained_live_locks: string[];
    failed_locks: string[];
    warnings: string[];
}
