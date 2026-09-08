import type { AggregateAppendMode, AggregateRetentionResult } from './task-events-retention';
import type { LockContentionLevel } from './task-events-locking';
import type { TaskEventPublicMetadata } from './task-event-public-contract';

export interface TaskEventAppendState {
    matching_events: number;
    parse_errors: number;
    last_integrity_sequence: number | null;
    last_event_sha256: string | null;
}

export interface AppendTaskEventOptions {
    actor?: string;
    passThru?: boolean;
    eventsRoot?: string;
    emitOnce?: unknown;
    lockTimeoutMs?: unknown;
    lockRetryMs?: unknown;
    lockStaleMs?: unknown;
    allowForeignHostStaleRecovery?: unknown;
    preWriteDelayMs?: unknown;
    aggregateMaxLines?: unknown;
    runtimeWritesMode?: unknown;
    lowNoiseRuntimeWrites?: unknown;
    expectedPreviousState?: TaskEventAppendState;
    /** Must complete synchronously; throwing or returning a promise prevents canonical append. */
    validateBeforeCanonicalAppend?: () => void;
}

export interface TaskEventIntegrity {
    schema_version: number;
    task_sequence: number;
    prev_event_sha256: string | null;
    event_sha256?: string;
}

export interface TaskEvent {
    schema_version: number;
    event_source: string;
    timestamp_utc: string;
    task_id: string;
    event_type: string;
    outcome: string;
    actor: string;
    message: string;
    details: unknown;
    public_metadata: TaskEventPublicMetadata;
    integrity?: TaskEventIntegrity;
}

export type TaskEventCommitStatus =
    | 'not_committed'
    | 'committed'
    | 'committed_with_derived_index_failure'
    | 'skipped_duplicate';

export interface AppendTaskEventResult {
    task_event_log_path: string;
    all_tasks_log_path: string;
    integrity: TaskEventIntegrity | null;
    commit_status: TaskEventCommitStatus;
    canonical_committed: boolean;
    warnings: string[];
    derived_warnings: string[];
    skipped_reason?: 'emit_once_duplicate' | null;
    aggregate_retention?: AggregateRetentionResult;
    lock_telemetry?: {
        task_lock_retries: number;
        task_lock_elapsed_ms: number;
        task_lock_contention_level: LockContentionLevel;
        task_lock_stale_recovered: boolean;
        task_lock_stale_reason: 'owner_dead' | 'age_exceeded' | null;
        aggregate_lock_retries: number;
        aggregate_lock_elapsed_ms: number;
        aggregate_lock_contention_level: LockContentionLevel;
        aggregate_lock_stale_recovered: boolean;
        aggregate_lock_stale_reason: 'owner_dead' | 'age_exceeded' | null;
        aggregate_append_mode: AggregateAppendMode;
    };
}

export interface TaskEventPaths {
    eventsRoot: string;
    taskFilePath: string;
    allTasksPath: string;
    taskLockPath: string;
    aggregateLockPath: string;
}
