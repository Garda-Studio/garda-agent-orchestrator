import { LIFECYCLE_EVENT_TYPES } from './lifecycle-event-types';
import { buildAppendWarning, recordDerivedAppendWarning } from './task-events-io-result';
import type { AppendTaskEventResult, TaskEvent } from './task-events-io-types';

const SUMMARY_REFRESH_EVENT_TYPES = new Set<string>([
    LIFECYCLE_EVENT_TYPES.TASK_MODE_ENTERED,
    LIFECYCLE_EVENT_TYPES.PLAN_CREATED,
    LIFECYCLE_EVENT_TYPES.RULE_PACK_LOADED,
    LIFECYCLE_EVENT_TYPES.RULE_PACK_LOAD_FAILED,
    LIFECYCLE_EVENT_TYPES.HANDSHAKE_DIAGNOSTICS_RECORDED,
    LIFECYCLE_EVENT_TYPES.SHELL_SMOKE_PREFLIGHT_RECORDED,
    LIFECYCLE_EVENT_TYPES.PREFLIGHT_STARTED,
    LIFECYCLE_EVENT_TYPES.PREFLIGHT_CLASSIFIED,
    LIFECYCLE_EVENT_TYPES.PREFLIGHT_FAILED,
    LIFECYCLE_EVENT_TYPES.IMPLEMENTATION_STARTED,
    LIFECYCLE_EVENT_TYPES.COMPILE_GATE_PASSED,
    LIFECYCLE_EVENT_TYPES.COMPILE_GATE_FAILED,
    LIFECYCLE_EVENT_TYPES.REVIEW_PHASE_STARTED,
    LIFECYCLE_EVENT_TYPES.REVIEW_RECORDED,
    LIFECYCLE_EVENT_TYPES.REVIEWER_LAUNCH_PREPARED,
    LIFECYCLE_EVENT_TYPES.REVIEWER_LAUNCH_INPUT_PINNED,
    LIFECYCLE_EVENT_TYPES.REVIEWER_INVOCATION_ATTESTED,
    LIFECYCLE_EVENT_TYPES.REVIEW_GATE_PASSED,
    LIFECYCLE_EVENT_TYPES.REVIEW_GATE_PASSED_WITH_OVERRIDE,
    LIFECYCLE_EVENT_TYPES.REVIEW_GATE_FAILED,
    LIFECYCLE_EVENT_TYPES.DOC_IMPACT_ASSESSED,
    LIFECYCLE_EVENT_TYPES.DOC_IMPACT_ASSESSMENT_FAILED,
    LIFECYCLE_EVENT_TYPES.PROJECT_MEMORY_IMPACT_ASSESSED,
    LIFECYCLE_EVENT_TYPES.PROJECT_MEMORY_IMPACT_BLOCKED,
    LIFECYCLE_EVENT_TYPES.COMPLETION_GATE_PASSED,
    LIFECYCLE_EVENT_TYPES.COMPLETION_GATE_FAILED
]);

function getCodeChangedHintFromEvent(event: TaskEvent | null): boolean | undefined {
    if (!event || event.event_type !== 'PREFLIGHT_CLASSIFIED') {
        return undefined;
    }
    if (!event.details || typeof event.details !== 'object' || Array.isArray(event.details)) {
        return undefined;
    }
    const details = event.details as Record<string, unknown>;
    return typeof details.code_changed === 'boolean' ? details.code_changed : undefined;
}

function shouldRefreshTimelineSummary(event: TaskEvent): boolean {
    return SUMMARY_REFRESH_EVENT_TYPES.has(event.event_type);
}

function updateTimelineSummaryBestEffortForEvent(eventsRoot: string, taskId: string, event: TaskEvent | null): string | null {
    try {
        const { updateTimelineSummaryForTask } = require('./timeline-summary') as typeof import('./timeline-summary');
        updateTimelineSummaryForTask(eventsRoot, taskId, getCodeChangedHintFromEvent(event));
        return null;
    } catch (error: unknown) {
        return buildAppendWarning('task-event timeline summary update failed', error);
    }
}

export function refreshTimelineSummaryForCommittedEvent(
    result: AppendTaskEventResult,
    eventsRoot: string,
    taskId: string,
    event: TaskEvent
): void {
    if (!shouldRefreshTimelineSummary(event)) {
        return;
    }
    const warning = updateTimelineSummaryBestEffortForEvent(eventsRoot, taskId, event);
    if (warning) {
        recordDerivedAppendWarning(result, warning);
        process.stderr.write(`WARNING: ${warning}\n`);
    }
}

/** Resolve summary code without writing or refreshing a summary. */
export function prepareTaskEventSummaryCode(): void {
    require('./timeline-summary');
}
