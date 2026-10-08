import { LIFECYCLE_EVENT_TYPES } from './lifecycle-event-types';

const RESERVED_EVENT_TYPES = new Set<string>(Object.values(LIFECYCLE_EVENT_TYPES));
const RESERVED_EVENT_PREFIXES = [
    'TASK_',
    'STATUS_',
    'CONTINUATION_',
    'SPLIT_REQUIRED_',
    'STRICT_DECOMPOSITION_',
    'DECOMPOSED_PARENT_',
    'COMPILE_GATE_',
    'REVIEW_',
    'REVIEWER_',
    'PREFLIGHT_',
    'COMPLETION_GATE_',
    'FULL_SUITE_VALIDATION_',
    'DOC_IMPACT_',
    'PROJECT_MEMORY_IMPACT_',
    'QUALITY_CHECKLIST_',
    'WORKFLOW_CONFIG_',
    'SKILL_',
    'INTERMEDIATE_COMMAND_',
    'TEST_FIRST_'
] as const;

export function assertGenericTaskEventAdmission(eventType: unknown): void {
    if (typeof eventType !== 'string' || !eventType.trim()) {
        throw new Error('EventType must be a non-empty string.');
    }

    const normalizedEventType = eventType.trim().toUpperCase();
    if (RESERVED_EVENT_TYPES.has(normalizedEventType)
        || RESERVED_EVENT_PREFIXES.some(prefix => normalizedEventType.startsWith(prefix))) {
        throw new Error(`EventType '${eventType}' is reserved and cannot be emitted via log-task-event.`);
    }
}
