import * as fs from 'node:fs';
import * as path from 'node:path';

export const LIFECYCLE_EVENT_TYPES = Object.freeze({
    TASK_MODE_ENTERED: 'TASK_MODE_ENTERED',
    PLAN_CREATED: 'PLAN_CREATED',
    RULE_PACK_LOADED: 'RULE_PACK_LOADED',
    RULE_PACK_LOAD_FAILED: 'RULE_PACK_LOAD_FAILED',
    PREFLIGHT_STARTED: 'PREFLIGHT_STARTED',
    PREFLIGHT_CLASSIFIED: 'PREFLIGHT_CLASSIFIED',
    PREFLIGHT_FAILED: 'PREFLIGHT_FAILED',
    IMPLEMENTATION_STARTED: 'IMPLEMENTATION_STARTED',
    COMPILE_GATE_PASSED: 'COMPILE_GATE_PASSED',
    COMPILE_GATE_FAILED: 'COMPILE_GATE_FAILED',
    REVIEW_PHASE_STARTED: 'REVIEW_PHASE_STARTED',
    REVIEW_GATE_PASSED: 'REVIEW_GATE_PASSED',
    REVIEW_GATE_PASSED_WITH_OVERRIDE: 'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    REVIEW_GATE_FAILED: 'REVIEW_GATE_FAILED',
    DOC_IMPACT_ASSESSED: 'DOC_IMPACT_ASSESSED',
    DOC_IMPACT_ASSESSMENT_FAILED: 'DOC_IMPACT_ASSESSMENT_FAILED',
    REVIEW_RECORDED: 'REVIEW_RECORDED',
    REVIEW_OUTPUT_CORRECTION_REQUIRED: 'REVIEW_OUTPUT_CORRECTION_REQUIRED',
    REVIEW_OUTPUT_CORRECTION_NORMALIZED: 'REVIEW_OUTPUT_CORRECTION_NORMALIZED',
    REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION: 'REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION',
    REVIEW_OUTPUT_CORRECTION_API_CONTINUATION: 'REVIEW_OUTPUT_CORRECTION_API_CONTINUATION',
    REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION: 'REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION',
    REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED: 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED',
    REVIEW_OUTPUT_CORRECTION_ACCEPTED: 'REVIEW_OUTPUT_CORRECTION_ACCEPTED',
    REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED: 'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED',
    REVIEWER_DELEGATION_ROUTED: 'REVIEWER_DELEGATION_ROUTED',
    REVIEWER_LAUNCH_PREPARED: 'REVIEWER_LAUNCH_PREPARED',
    REVIEWER_LAUNCH_INPUT_PINNED: 'REVIEWER_LAUNCH_INPUT_PINNED',
    REVIEWER_DELEGATION_STARTED: 'REVIEWER_DELEGATION_STARTED',
    REVIEWER_LAUNCH_FAILED: 'REVIEWER_LAUNCH_FAILED',
    REVIEWER_LAUNCH_COMPLETED: 'REVIEWER_LAUNCH_COMPLETED',
    REVIEWER_INVOCATION_ATTESTED: 'REVIEWER_INVOCATION_ATTESTED',
    FULL_SUITE_VALIDATION_PASSED: 'FULL_SUITE_VALIDATION_PASSED',
    FULL_SUITE_VALIDATION_WARNED: 'FULL_SUITE_VALIDATION_WARNED',
    FULL_SUITE_VALIDATION_FAILED: 'FULL_SUITE_VALIDATION_FAILED',
    FULL_SUITE_VALIDATION_SKIPPED: 'FULL_SUITE_VALIDATION_SKIPPED',
    PROJECT_MEMORY_IMPACT_ASSESSED: 'PROJECT_MEMORY_IMPACT_ASSESSED',
    PROJECT_MEMORY_IMPACT_BLOCKED: 'PROJECT_MEMORY_IMPACT_BLOCKED',
    COMPLETION_GATE_PASSED: 'COMPLETION_GATE_PASSED',
    COMPLETION_GATE_FAILED: 'COMPLETION_GATE_FAILED',
    STATUS_CHANGED: 'STATUS_CHANGED',
    PROVIDER_ROUTING_DECISION: 'PROVIDER_ROUTING_DECISION',
    HANDSHAKE_DIAGNOSTICS_RECORDED: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
    SHELL_SMOKE_PREFLIGHT_RECORDED: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
    COMMAND_TIMEOUT_DIAGNOSTICS_RECORDED: 'COMMAND_TIMEOUT_DIAGNOSTICS_RECORDED',
    QUALITY_CHECKLIST_RECORDED: 'QUALITY_CHECKLIST_RECORDED',
    STRICT_DECOMPOSITION_DECISION_RECORDED: 'STRICT_DECOMPOSITION_DECISION_RECORDED',
    STRICT_DECOMPOSITION_SPLIT_ROUTED: 'STRICT_DECOMPOSITION_SPLIT_ROUTED',
    DECOMPOSED_PARENT_COMPLETED: 'DECOMPOSED_PARENT_COMPLETED',
    PARENT_AUDIT_RECORD_PUBLISHED: 'PARENT_AUDIT_RECORD_PUBLISHED'
});

export const MANDATORY_CODE_CHANGE_EVENTS: readonly string[] = Object.freeze([
    'TASK_MODE_ENTERED',
    'RULE_PACK_LOADED',
    'HANDSHAKE_DIAGNOSTICS_RECORDED',
    'SHELL_SMOKE_PREFLIGHT_RECORDED',
    'PREFLIGHT_CLASSIFIED',
    'IMPLEMENTATION_STARTED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_GATE_PASSED',
    'COMPLETION_GATE_PASSED'
]);

export const MANDATORY_NON_CODE_EVENTS: readonly string[] = Object.freeze([
    'TASK_MODE_ENTERED',
    'RULE_PACK_LOADED',
    'HANDSHAKE_DIAGNOSTICS_RECORDED',
    'SHELL_SMOKE_PREFLIGHT_RECORDED',
    'PREFLIGHT_CLASSIFIED',
    'IMPLEMENTATION_STARTED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_GATE_PASSED',
    'COMPLETION_GATE_PASSED'
]);

export const FULL_SUITE_VALIDATION_EVENTS: readonly string[] = Object.freeze([
    'FULL_SUITE_VALIDATION_PASSED',
    'FULL_SUITE_VALIDATION_WARNED',
    'FULL_SUITE_VALIDATION_FAILED',
    'FULL_SUITE_VALIDATION_SKIPPED'
] as const);

export const TERMINAL_PARENT_LIFECYCLE_EVENTS: readonly string[] = Object.freeze([
    'STRICT_DECOMPOSITION_SPLIT_ROUTED',
    'DECOMPOSED_PARENT_COMPLETED'
] as const);

function normalizeEventSet(events: Iterable<string>): Set<string> {
    const normalized = new Set<string>();
    for (const eventType of events) {
        const token = String(eventType || '').trim().toUpperCase();
        if (token) {
            normalized.add(token);
        }
    }
    return normalized;
}

export function hasSatisfiedLifecycleEvent(events: Iterable<string>, expectedEvent: string): boolean {
    const eventTypes = normalizeEventSet(events);
    const normalizedExpectedEvent = String(expectedEvent || '').trim().toUpperCase();
    if (!normalizedExpectedEvent) {
        return false;
    }
    if (normalizedExpectedEvent === 'REVIEW_GATE_PASSED') {
        return eventTypes.has('REVIEW_GATE_PASSED') || eventTypes.has('REVIEW_GATE_PASSED_WITH_OVERRIDE');
    }
    if (normalizedExpectedEvent === 'FULL_SUITE_VALIDATION_COMPLETE') {
        return FULL_SUITE_VALIDATION_EVENTS.some((eventType) => eventTypes.has(eventType));
    }
    return eventTypes.has(normalizedExpectedEvent);
}

export function getSatisfiedTerminalParentLifecycleEvents(events: Iterable<string>): string[] {
    const eventTypes = normalizeEventSet(events);
    return TERMINAL_PARENT_LIFECYCLE_EVENTS.filter((eventType) => eventTypes.has(eventType));
}

export interface FullSuiteValidationRequirementResolution {
    required: boolean;
    task_bound: boolean;
}

export function resolveFullSuiteValidationRequirementForTaskEvents(
    events: Iterable<string>,
    defaultEnabled: boolean = false
): FullSuiteValidationRequirementResolution {
    const eventTypes = normalizeEventSet(events);
    if (eventTypes.has('FULL_SUITE_VALIDATION_SKIPPED')) {
        return {
            required: false,
            task_bound: true
        };
    }
    if (hasSatisfiedLifecycleEvent(eventTypes, 'FULL_SUITE_VALIDATION_COMPLETE')) {
        return {
            required: true,
            task_bound: true
        };
    }
    if (eventTypes.has('COMPLETION_GATE_PASSED')) {
        return {
            required: false,
            task_bound: true
        };
    }
    return {
        required: defaultEnabled,
        task_bound: false
    };
}

export function resolveFullSuiteValidationRequirementForOrderedTaskEvents(
    events: Iterable<string>,
    defaultEnabled: boolean = false
): FullSuiteValidationRequirementResolution {
    const orderedEvents: string[] = [];
    for (const eventType of events) {
        const token = String(eventType || '').trim().toUpperCase();
        if (token) {
            orderedEvents.push(token);
        }
    }

    for (let index = orderedEvents.length - 1; index >= 0; index--) {
        const eventType = orderedEvents[index];
        if (FULL_SUITE_VALIDATION_EVENTS.includes(eventType)) {
            return resolveFullSuiteValidationRequirementForTaskEvents([eventType], defaultEnabled);
        }
    }

    return resolveFullSuiteValidationRequirementForTaskEvents(orderedEvents, defaultEnabled);
}

export function isTaskBoundFullSuiteValidationRequirement(
    eventsFound: Iterable<string>,
    completenessStatus: string | null | undefined
): boolean {
    const eventTypes = normalizeEventSet(eventsFound);
    if (hasSatisfiedLifecycleEvent(eventTypes, 'FULL_SUITE_VALIDATION_COMPLETE')) {
        return true;
    }
    return String(completenessStatus || '').trim().toUpperCase() === 'COMPLETE'
        && eventTypes.has('COMPLETION_GATE_PASSED');
}

export interface GetMandatoryEventsOptions {
    codeChanged: boolean;
    fullSuiteValidationEnabled?: boolean;
}

export function getMandatoryEvents(codeChangedOrOptions: boolean | GetMandatoryEventsOptions): readonly string[] {
    const options = typeof codeChangedOrOptions === 'boolean'
        ? { codeChanged: codeChangedOrOptions, fullSuiteValidationEnabled: false }
        : codeChangedOrOptions;
    const base = options.codeChanged ? MANDATORY_CODE_CHANGE_EVENTS : MANDATORY_NON_CODE_EVENTS;
    if (!options.fullSuiteValidationEnabled) {
        return base;
    }
    const events = [...base];
    const completionIndex = events.indexOf('COMPLETION_GATE_PASSED');
    if (completionIndex >= 0) {
        events.splice(completionIndex, 0, 'FULL_SUITE_VALIDATION_COMPLETE');
    }
    return Object.freeze(events);
}

export interface TimelineCompletenessResult {
    task_id: string;
    timeline_path: string;
    timeline_exists: boolean;
    events_found: string[];
    events_missing: string[];
    status: 'COMPLETE' | 'INCOMPLETE' | 'MISSING_TIMELINE';
    violations: string[];
    full_suite_validation_required?: boolean;
}

export function validateTimelineCompleteness(
    timelinePath: string,
    taskId: string,
    codeChangedOrOptions: boolean | { codeChanged: boolean; fullSuiteValidationEnabled?: boolean }
): TimelineCompletenessResult {
    const options = typeof codeChangedOrOptions === 'boolean'
        ? { codeChanged: codeChangedOrOptions, fullSuiteValidationEnabled: false }
        : codeChangedOrOptions;
    const normalizedPath = timelinePath.replace(/\\/g, '/');
    const result: TimelineCompletenessResult = {
        task_id: taskId,
        timeline_path: normalizedPath,
        timeline_exists: false,
        events_found: [],
        events_missing: [],
        status: 'MISSING_TIMELINE',
        violations: [],
        full_suite_validation_required: options.fullSuiteValidationEnabled
    };

    const resolvedPath = path.resolve(timelinePath);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        result.violations.push(`Task timeline not found for '${taskId}': ${normalizedPath}`);
        return result;
    }

    result.timeline_exists = true;
    const eventTypes = new Set<string>();
    const orderedEventTypes: string[] = [];

    try {
        const content = fs.readFileSync(resolvedPath, 'utf8');
        for (const rawLine of content.split('\n')) {
            if (!rawLine.trim()) continue;
            try {
                const parsed = JSON.parse(rawLine) as Record<string, unknown>;
                const eventType = String(parsed.event_type || '').trim().toUpperCase();
                if (eventType) {
                    orderedEventTypes.push(eventType);
                    eventTypes.add(eventType);
                }
            } catch {
                // integrity inspection handles malformed lines elsewhere
            }
        }
    } catch {
        result.violations.push(`Task timeline unreadable for '${taskId}': ${normalizedPath}`);
        return result;
    }

    const fullSuiteValidationRequirement = resolveFullSuiteValidationRequirementForOrderedTaskEvents(
        orderedEventTypes,
        options.fullSuiteValidationEnabled === true
    );
    result.full_suite_validation_required = fullSuiteValidationRequirement.required;

    const terminalParentEvents = getSatisfiedTerminalParentLifecycleEvents(eventTypes);
    if (terminalParentEvents.length > 0) {
        result.events_found = terminalParentEvents;
        result.events_missing = [];
        result.violations = [];
        result.status = 'COMPLETE';
        result.full_suite_validation_required = false;
        return result;
    }

    const mandatory = getMandatoryEvents({
        codeChanged: options.codeChanged,
        fullSuiteValidationEnabled: fullSuiteValidationRequirement.required
    });
    for (const expectedEvent of mandatory) {
        if (hasSatisfiedLifecycleEvent(eventTypes, expectedEvent)) {
            result.events_found.push(expectedEvent);
        } else {
            result.events_missing.push(expectedEvent);
            if (expectedEvent === 'FULL_SUITE_VALIDATION_COMPLETE') {
                result.violations.push(
                    `Task timeline '${normalizedPath}' is missing mandatory full-suite validation event `
                    + '(one of FULL_SUITE_VALIDATION_PASSED, FULL_SUITE_VALIDATION_WARNED, '
                    + 'FULL_SUITE_VALIDATION_FAILED, or FULL_SUITE_VALIDATION_SKIPPED).'
                );
            } else {
                result.violations.push(
                    `Task timeline '${normalizedPath}' is missing mandatory lifecycle event: ${expectedEvent}.`
                );
            }
        }
    }

    result.status = result.events_missing.length > 0 ? 'INCOMPLETE' : 'COMPLETE';
    return result;
}
