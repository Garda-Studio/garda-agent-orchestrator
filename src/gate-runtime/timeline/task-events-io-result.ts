import type { AggregateAppendMode } from './task-events-retention';
import type { LockContentionLevel } from './task-events-locking';
import type { AppendTaskEventResult, TaskEvent, TaskEventPaths } from './task-events-io-types';

const blockingAppendErrors = new WeakMap<AppendTaskEventResult, unknown>();

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function buildAppendWarning(prefix: string, error: unknown): string {
    return `${prefix}: ${getErrorMessage(error)}`;
}

export function createAppendResult(paths: TaskEventPaths): AppendTaskEventResult {
    return {
        task_event_log_path: paths.taskFilePath.replace(/\\/g, '/'),
        all_tasks_log_path: paths.allTasksPath.replace(/\\/g, '/'),
        integrity: null,
        commit_status: 'not_committed',
        canonical_committed: false,
        warnings: [],
        derived_warnings: [],
        skipped_reason: null,
        lock_telemetry: {
            task_lock_retries: 0,
            task_lock_elapsed_ms: 0,
            task_lock_contention_level: 'none',
            task_lock_stale_recovered: false,
            task_lock_stale_reason: null,
            aggregate_lock_retries: 0,
            aggregate_lock_elapsed_ms: 0,
            aggregate_lock_contention_level: 'none',
            aggregate_lock_stale_recovered: false,
            aggregate_lock_stale_reason: null,
            aggregate_append_mode: 'locked'
        }
    };
}

export function applyTaskLockTelemetry(result: AppendTaskEventResult, telemetry: {
    retries: number;
    elapsedMs: number;
    contentionLevel: LockContentionLevel;
    staleLockRecovered: boolean;
    staleLockReason: 'owner_dead' | 'age_exceeded' | null;
}): void {
    if (!result.lock_telemetry) {
        return;
    }
    result.lock_telemetry.task_lock_retries = telemetry.retries;
    result.lock_telemetry.task_lock_elapsed_ms = telemetry.elapsedMs;
    result.lock_telemetry.task_lock_contention_level = telemetry.contentionLevel;
    result.lock_telemetry.task_lock_stale_recovered = telemetry.staleLockRecovered;
    result.lock_telemetry.task_lock_stale_reason = telemetry.staleLockReason;
}

export function applyAggregateLockTelemetry(
    result: AppendTaskEventResult,
    appendMode: AggregateAppendMode,
    telemetry?: {
        retries: number;
        elapsedMs: number;
        contentionLevel: LockContentionLevel;
        staleLockRecovered: boolean;
        staleLockReason: 'owner_dead' | 'age_exceeded' | null;
    }
): void {
    if (!result.lock_telemetry) {
        return;
    }
    result.lock_telemetry.aggregate_append_mode = appendMode;
    if (!telemetry) {
        return;
    }
    result.lock_telemetry.aggregate_lock_retries = telemetry.retries;
    result.lock_telemetry.aggregate_lock_elapsed_ms = telemetry.elapsedMs;
    result.lock_telemetry.aggregate_lock_contention_level = telemetry.contentionLevel;
    result.lock_telemetry.aggregate_lock_stale_recovered = telemetry.staleLockRecovered;
    result.lock_telemetry.aggregate_lock_stale_reason = telemetry.staleLockReason;
}

export function markTaskEventCommitted(result: AppendTaskEventResult, event: TaskEvent): void {
    result.integrity = Object.assign({}, event.integrity);
    result.commit_status = 'committed';
    result.canonical_committed = true;
}

export function markTaskEventSkippedDuplicate(result: AppendTaskEventResult): void {
    result.skipped_reason = 'emit_once_duplicate';
    result.commit_status = 'skipped_duplicate';
    result.canonical_committed = false;
}

export function recordDerivedAppendWarning(result: AppendTaskEventResult, warning: string): void {
    result.warnings.push(warning);
    result.derived_warnings.push(warning);
    if (result.canonical_committed) {
        result.commit_status = 'committed_with_derived_index_failure';
    }
}

export function recordBlockingAppendError(result: AppendTaskEventResult, error: unknown): void {
    if (!blockingAppendErrors.has(result)) {
        blockingAppendErrors.set(result, error);
    }
}

export function getBlockingTaskEventAppendWarnings(result: AppendTaskEventResult): string[] {
    return result.warnings.filter((warning) => !result.derived_warnings.includes(warning));
}

export function taskEventAppendHasBlockingFailure(
    result: AppendTaskEventResult,
    acceptSkippedDuplicate = true
): boolean {
    const acceptedDuplicate = acceptSkippedDuplicate && result.skipped_reason === 'emit_once_duplicate';
    return (!result.canonical_committed && !acceptedDuplicate) ||
        result.commit_status === 'not_committed' ||
        getBlockingTaskEventAppendWarnings(result).length > 0;
}

export function assertMandatoryAppendCommitted(result: AppendTaskEventResult, eventType: string): void {
    const blockingWarnings = getBlockingTaskEventAppendWarnings(result);
    if (taskEventAppendHasBlockingFailure(result)) {
        const diagnostics = blockingWarnings.length > 0
            ? blockingWarnings
            : (result.warnings.length > 0 ? result.warnings : [`commit_status=${result.commit_status}`]);
        throw new Error(`Mandatory lifecycle event '${eventType}' append failed: ${diagnostics.join(' | ')}`, {
            cause: blockingAppendErrors.get(result)
        });
    }
}
