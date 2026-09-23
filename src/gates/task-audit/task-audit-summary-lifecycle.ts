import { readTaskTimelineJsonlEntries } from '../../gate-runtime/task-events';
import {
    createTaskTimelineMemoizationKey,
    memoizeTaskTimelineSnapshot,
    type TaskTimelineDeepReadonly
} from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import {
    formatTimestamp,
    parseTimestamp,
    shouldIncludeFullSuiteTelemetryForCurrentCycle,
    type TaskCycleBindingSnapshot
} from '../task-events-summary/task-events-summary';
import { resolveFullSuiteValidationRequirementForOrderedTaskEvents } from '../../gate-runtime/lifecycle-event-types';
import {
    getReviewDependencyTimelineOrderViolations,
    type CompiledReviewDependencyGraph
} from '../../core/review-dependency-graph';
import {
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    PROJECT_MEMORY_IMPACT_BLOCKED_EVENT
} from '../project-memory-impact';
import {
    type BlockerEntry,
    type GateOutcome
} from './task-audit-summary-collectors';

export type TaskAuditEvent = Record<string, unknown>;

export interface LifecycleGateSpec {
    gate: string;
    pass_event: string;
    fail_events: string[];
}

export interface OrderedTaskEvents {
    events: TaskAuditEvent[];
    count: number;
    firstEventUtc: string | null;
    lastEventUtc: string | null;
}

const ORDERED_TASK_EVENTS_MEMOIZATION_KEY = createTaskTimelineMemoizationKey<OrderedTaskEvents>(
    'ordered-task-events'
);


const BASE_LIFECYCLE_GATES: ReadonlyArray<LifecycleGateSpec> = [
    { gate: 'enter-task-mode', pass_event: 'TASK_MODE_ENTERED', fail_events: [] },
    { gate: 'load-rule-pack', pass_event: 'RULE_PACK_LOADED', fail_events: ['RULE_PACK_LOAD_FAILED'] },
    { gate: 'handshake-diagnostics', pass_event: 'HANDSHAKE_DIAGNOSTICS_RECORDED', fail_events: [] },
    { gate: 'shell-smoke-preflight', pass_event: 'SHELL_SMOKE_PREFLIGHT_RECORDED', fail_events: [] },
    { gate: 'classify-change', pass_event: 'PREFLIGHT_CLASSIFIED', fail_events: ['PREFLIGHT_FAILED'] },
    { gate: 'compile-gate', pass_event: 'COMPILE_GATE_PASSED', fail_events: ['COMPILE_GATE_FAILED'] },
    { gate: 'review-phase', pass_event: 'REVIEW_PHASE_STARTED', fail_events: [] },
    { gate: 'required-reviews-check', pass_event: 'REVIEW_GATE_PASSED', fail_events: ['REVIEW_GATE_FAILED'] },
    { gate: 'doc-impact-gate', pass_event: 'DOC_IMPACT_ASSESSED', fail_events: ['DOC_IMPACT_ASSESSMENT_FAILED'] },
    { gate: 'completion-gate', pass_event: 'COMPLETION_GATE_PASSED', fail_events: ['COMPLETION_GATE_FAILED'] }
];

export function getLifecycleGates(
    fullSuiteValidationEnabled: boolean,
    projectMemoryImpactRequired: boolean,
    compileGateRequired = true
): LifecycleGateSpec[] {
    const gates = BASE_LIFECYCLE_GATES
        .filter((entry) => compileGateRequired || entry.gate !== 'compile-gate')
        .map((entry) => ({
            gate: entry.gate,
            pass_event: entry.pass_event,
            fail_events: [...entry.fail_events]
        }));
    if (fullSuiteValidationEnabled) {
        const completionIndex = gates.findIndex((entry) => entry.gate === 'completion-gate');
        const fullSuiteGate = {
            gate: 'full-suite-validation',
            pass_event: 'FULL_SUITE_VALIDATION_PASSED',
            fail_events: ['FULL_SUITE_VALIDATION_FAILED']
        };
        if (completionIndex === -1) {
            gates.push(fullSuiteGate);
        } else {
            gates.splice(completionIndex, 0, fullSuiteGate);
        }
    }
    if (projectMemoryImpactRequired) {
        const currentCompletionIndex = gates.findIndex((entry) => entry.gate === 'completion-gate');
        const projectMemoryGate = {
            gate: 'project-memory-impact',
            pass_event: PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
            fail_events: [PROJECT_MEMORY_IMPACT_BLOCKED_EVENT]
        };
        if (currentCompletionIndex === -1) {
            gates.push(projectMemoryGate);
        } else {
            gates.splice(currentCompletionIndex, 0, projectMemoryGate);
        }
    }
    return gates;
}

function parseOrderedTaskEvents(taskEventFile: string): OrderedTaskEvents {
    const events: TaskAuditEvent[] = [];

    for (const entry of readTaskTimelineJsonlEntries(taskEventFile)) {
        if (entry.record) {
            events.push(entry.record as TaskAuditEvent);
        }
    }

    events.sort((a, b) => {
        const ta = parseTimestamp(a.timestamp_utc);
        const tb = parseTimestamp(b.timestamp_utc);
        return ta.getTime() - tb.getTime();
    });

    return {
        events,
        count: events.length,
        firstEventUtc: events.length > 0 ? formatTimestamp(events[0].timestamp_utc) : null,
        lastEventUtc: events.length > 0 ? formatTimestamp(events[events.length - 1].timestamp_utc) : null
    };
}

function cloneOrderedTaskEvents(result: TaskTimelineDeepReadonly<OrderedTaskEvents>): OrderedTaskEvents {
    return {
        events: [...result.events] as TaskAuditEvent[],
        count: result.count,
        firstEventUtc: result.firstEventUtc,
        lastEventUtc: result.lastEventUtc
    };
}

export function readOrderedTaskEvents(taskEventFile: string): OrderedTaskEvents {
    const memoized = memoizeTaskTimelineSnapshot(
        taskEventFile,
        ORDERED_TASK_EVENTS_MEMOIZATION_KEY,
        'default',
        () => parseOrderedTaskEvents(taskEventFile)
    );
    if (memoized.active) {
        if (!memoized.valid) {
            throw new Error(`Task timeline snapshot changed while reading: ${taskEventFile}`);
        }
        return memoized.exists && memoized.value
            ? cloneOrderedTaskEvents(memoized.value)
            : {
                events: [],
                count: 0,
                firstEventUtc: null,
                lastEventUtc: null
            };
    }
    return parseOrderedTaskEvents(taskEventFile);
}

function findLatestEventForTypes(
    eventTypes: string[],
    events: TaskAuditEvent[],
    predicate?: (eventType: string, event: TaskAuditEvent) => boolean
): { event: TaskAuditEvent; eventType: string } | null {
    if (events.length === 0 || eventTypes.length === 0) {
        return null;
    }
    const wantedTypes = new Set(eventTypes);
    let latestSequenced: { event: TaskAuditEvent; eventType: string; sequence: number } | null = null;
    let latestUnsequenced: { event: TaskAuditEvent; eventType: string } | null = null;
    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        const eventType = String(event.event_type || '');
        if (!wantedTypes.has(eventType)) {
            continue;
        }
        if (predicate && !predicate(eventType, event)) {
            continue;
        }
        const sequence = readTaskEventSequence(event);
        if (sequence == null) {
            latestUnsequenced = { event, eventType };
        } else if (!latestSequenced || sequence >= latestSequenced.sequence) {
            latestSequenced = { event, eventType, sequence };
        }
    }
    return latestSequenced || latestUnsequenced;
}

const CURRENT_CYCLE_DOWNSTREAM_GATES = new Set([
    'review-phase',
    'required-reviews-check',
    'doc-impact-gate',
    'full-suite-validation',
    'project-memory-impact',
    'completion-gate'
]);

function isEventRelevantForLifecycleGate(
    gateSpec: LifecycleGateSpec,
    eventType: string,
    event: TaskAuditEvent,
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string
): boolean {
    if (!CURRENT_CYCLE_DOWNSTREAM_GATES.has(gateSpec.gate) || !currentCycle?.compile_gate_timestamp) {
        return true;
    }

    if (gateSpec.gate === 'full-suite-validation') {
        const details = event.details && typeof event.details === 'object'
            ? event.details as Record<string, unknown>
            : null;
        return shouldIncludeFullSuiteTelemetryForCurrentCycle(
            eventType,
            event.timestamp_utc,
            details,
            currentCycle,
            repoRoot
        );
    }

    const eventTime = parseTimestamp(event.timestamp_utc).getTime();
    const compileTime = parseTimestamp(currentCycle.compile_gate_timestamp).getTime();
    if (eventTime > 0 && compileTime > 0 && eventTime < compileTime) {
        return false;
    }

    return true;
}

function readTaskEventSequence(event: TaskAuditEvent): number | null {
    const integrity = event.integrity && typeof event.integrity === 'object' ? event.integrity as Record<string, unknown> : null;
    const sequence = typeof integrity?.task_sequence === 'number' ? integrity.task_sequence : Number(integrity?.task_sequence);
    return Number.isInteger(sequence) ? sequence : null;
}

export function hasCurrentCycleReviewProgress(events: ReadonlyArray<TaskAuditEvent>): boolean {
    let latestCompileIndex = -1;
    let latestCompileSequence: number | null = null;
    for (let index = 0; index < events.length; index += 1) {
        const eventType = String(events[index].event_type || '').trim().toUpperCase();
        if (eventType !== 'COMPILE_GATE_PASSED' && eventType !== 'COMPILE_GATE_FAILED') {
            continue;
        }
        const eventSequence = readTaskEventSequence(events[index]);
        if (
            latestCompileIndex === -1
            || (
                eventSequence != null
                && latestCompileSequence != null
                && eventSequence > latestCompileSequence
            )
            || (
                (eventSequence == null || latestCompileSequence == null)
                && index > latestCompileIndex
            )
        ) {
            latestCompileIndex = index;
            latestCompileSequence = eventSequence;
        }
    }
    if (latestCompileIndex === -1) {
        return true;
    }
    return events.some((event, index) => {
        const eventType = String(event.event_type || '').trim().toUpperCase();
        const isReviewOrCompletionEvent = eventType.startsWith('REVIEW_')
            || eventType.startsWith('REVIEWER_')
            || eventType === 'COMPLETION_GATE_PASSED'
            || eventType === 'COMPLETION_GATE_FAILED';
        if (!isReviewOrCompletionEvent) {
            return false;
        }
        const eventSequence = readTaskEventSequence(event);
        return latestCompileSequence != null && eventSequence != null
            ? eventSequence > latestCompileSequence
            : index > latestCompileIndex;
    });
}

function taskEventOccursAfter(candidate: TaskAuditEvent, anchor: TaskAuditEvent, currentCycle: TaskCycleBindingSnapshot | null): boolean {
    const candidateSequence = readTaskEventSequence(candidate);
    const anchorSequence = readTaskEventSequence(anchor);
    if (candidateSequence != null && anchorSequence != null) {
        return candidateSequence > anchorSequence;
    }
    const candidateTime = parseTimestamp(candidate.timestamp_utc).getTime();
    const anchorTime = parseTimestamp(anchor.timestamp_utc).getTime();
    const compileTime = currentCycle?.compile_gate_timestamp ? parseTimestamp(currentCycle.compile_gate_timestamp).getTime() : 0;
    if (candidateTime > 0 && compileTime > 0 && candidateTime < compileTime) {
        return false;
    }
    return candidateTime > 0 && anchorTime > 0 && candidateTime > anchorTime;
}

export function buildCompletionReviewOrderBlocker(
    requiredReviews: Record<string, boolean>,
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string,
    reviewDependencyGraph: CompiledReviewDependencyGraph | null = null
): BlockerEntry | null {
    if (!Object.values(requiredReviews).some((required) => required === true)) {
        return null;
    }
    if (reviewDependencyGraph) {
        const dependencyOrderViolation = getReviewDependencyTimelineOrderViolations(
            reviewDependencyGraph,
            events.map((event, index) => ({
                event_type: String(event.event_type || '').trim().toUpperCase(),
                sequence: readTaskEventSequence(event) ?? index + 1,
                details: event.details && typeof event.details === 'object'
                    ? event.details as Record<string, unknown>
                    : null
            }))
        )[0];
        if (dependencyOrderViolation) {
            return {
                gate: 'required-reviews-check',
                reason:
                    `Review dependency order is invalid: '${dependencyOrderViolation.downstream_review_id}' ` +
                    `started without a current dependency-safe '${dependencyOrderViolation.upstream_review_id}' PASS ` +
                    `(${dependencyOrderViolation.code}).`
            };
        }
    }
    const reviewGatePass = findLatestEventForTypes(
        ['REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE'],
        events,
        (eventType, event) => isEventRelevantForLifecycleGate(
            { gate: 'required-reviews-check', pass_event: 'REVIEW_GATE_PASSED', fail_events: ['REVIEW_GATE_FAILED'] },
            eventType,
            event,
            currentCycle,
            repoRoot
        )
    );
    if (reviewGatePass) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (!taskEventOccursAfter(event, reviewGatePass.event, currentCycle)) {
                continue;
            }
            const eventType = String(event.event_type || '').trim().toUpperCase();
            const details = event.details && typeof event.details === 'object' ? event.details as Record<string, unknown> : null;
            const reviewType = String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
            if (eventType === 'REVIEW_RECORDED' && requiredReviews[reviewType] === true) {
                return {
                    gate: 'required-reviews-check',
                    reason: 'Required review evidence changed after REVIEW_GATE_PASSED; rerun required-reviews-check and completion-gate.'
                };
            }
        }
    }
    const completionPass = findLatestEventForTypes(
        ['COMPLETION_GATE_PASSED'],
        events,
        (eventType, event) => isEventRelevantForLifecycleGate(
            { gate: 'completion-gate', pass_event: 'COMPLETION_GATE_PASSED', fail_events: ['COMPLETION_GATE_FAILED'] },
            eventType,
            event,
            currentCycle,
            repoRoot
        )
    );
    if (!completionPass) {
        return null;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!taskEventOccursAfter(event, completionPass.event, currentCycle)) {
            continue;
        }
        const eventType = String(event.event_type || '').trim().toUpperCase();
        const details = event.details && typeof event.details === 'object' ? event.details as Record<string, unknown> : null;
        const reviewType = String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
        const reviewEvidenceChanged =
            (eventType === 'REVIEW_RECORDED' && requiredReviews[reviewType] === true)
            || eventType === 'REVIEW_GATE_PASSED'
            || eventType === 'REVIEW_GATE_PASSED_WITH_OVERRIDE'
            || eventType === 'REVIEW_GATE_FAILED';
        if (!reviewEvidenceChanged) {
            continue;
        }
        return {
            gate: 'completion-gate',
            reason: `Completion gate pass is stale because ${eventType} occurred afterward; rerun review gates and completion-gate.`
        };
    }
    return null;
}

export function resolveFullSuiteValidationRequirementForCurrentCycle(
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string,
    liveFullSuiteValidationEnabled: boolean
): boolean {
    if (!currentCycle?.compile_gate_timestamp) {
        return resolveFullSuiteValidationRequirementForOrderedTaskEvents(
            events.map((event) => String(event.event_type || '')),
            liveFullSuiteValidationEnabled
        ).required;
    }

    const currentCycleFullSuiteEventTypes = events
        .filter((event) => shouldIncludeFullSuiteTelemetryForCurrentCycle(
            String(event.event_type || ''),
            event.timestamp_utc,
            event.details && typeof event.details === 'object'
                ? event.details as Record<string, unknown>
                : null,
            currentCycle,
            repoRoot
        ))
        .map((event) => String(event.event_type || '').trim().toUpperCase())
        .filter((eventType) => eventType.startsWith('FULL_SUITE_VALIDATION_'));

    if (currentCycleFullSuiteEventTypes.length > 0) {
        return resolveFullSuiteValidationRequirementForOrderedTaskEvents(
            currentCycleFullSuiteEventTypes,
            liveFullSuiteValidationEnabled
        ).required;
    }

    return liveFullSuiteValidationEnabled;
}

export function hasCurrentCycleProjectMemoryImpactEvent(
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string
): boolean {
    const gateSpec: LifecycleGateSpec = {
        gate: 'project-memory-impact',
        pass_event: PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
        fail_events: [PROJECT_MEMORY_IMPACT_BLOCKED_EVENT]
    };
    return events.some((event) => {
        const eventType = String(event.event_type || '').trim().toUpperCase();
        if (eventType !== PROJECT_MEMORY_IMPACT_ASSESSED_EVENT && eventType !== PROJECT_MEMORY_IMPACT_BLOCKED_EVENT) {
            return false;
        }
        return isEventRelevantForLifecycleGate(gateSpec, eventType, event, currentCycle, repoRoot);
    });
}

function resolveLifecycleGateStatus(
    gateSpec: LifecycleGateSpec,
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string
): { gateOutcome: GateOutcome; blocker: BlockerEntry | null } {
    const passEvents = gateSpec.pass_event === 'REVIEW_GATE_PASSED'
        ? [gateSpec.pass_event, 'REVIEW_GATE_PASSED_WITH_OVERRIDE']
        : gateSpec.pass_event === 'FULL_SUITE_VALIDATION_PASSED'
            ? [gateSpec.pass_event, 'FULL_SUITE_VALIDATION_WARNED']
            : [gateSpec.pass_event];
    const lifecyclePredicate = (eventType: string, event: TaskAuditEvent): boolean => (
        isEventRelevantForLifecycleGate(gateSpec, eventType, event, currentCycle, repoRoot)
    );
    const latestPass = findLatestEventForTypes(passEvents, events, lifecyclePredicate);
    const latestFail = findLatestEventForTypes(gateSpec.fail_events, events, lifecyclePredicate);

    if (latestPass && latestFail) {
        if (taskEventOccursAfter(latestFail.event, latestPass.event, currentCycle)) {
            return {
                gateOutcome: {
                    gate: gateSpec.gate,
                    status: 'FAIL',
                    event_type: latestFail.eventType,
                    timestamp_utc: formatTimestamp(latestFail.event.timestamp_utc)
                },
                blocker: {
                    gate: gateSpec.gate,
                    reason: `Gate emitted ${latestFail.eventType} after earlier pass`
                }
            };
        }
    }

    if (latestPass) {
        return {
            gateOutcome: {
                gate: gateSpec.gate,
                status: 'PASS',
                event_type: latestPass.eventType,
                timestamp_utc: formatTimestamp(latestPass.event.timestamp_utc)
            },
            blocker: null
        };
    }

    if (latestFail) {
        return {
            gateOutcome: {
                gate: gateSpec.gate,
                status: 'FAIL',
                event_type: latestFail.eventType,
                timestamp_utc: formatTimestamp(latestFail.event.timestamp_utc)
            },
            blocker: {
                gate: gateSpec.gate,
                reason: `Gate emitted ${latestFail.eventType}`
            }
        };
    }

    return {
        gateOutcome: {
            gate: gateSpec.gate,
            status: 'MISSING',
            event_type: gateSpec.pass_event
        },
        blocker: null
    };
}

export function buildLifecycleGateOutcomes(
    lifecycleGates: LifecycleGateSpec[],
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string
): { gates: GateOutcome[]; blockers: BlockerEntry[] } {
    const gates: GateOutcome[] = [];
    const blockers: BlockerEntry[] = [];

    for (const gateSpec of lifecycleGates) {
        const resolvedGate = resolveLifecycleGateStatus(gateSpec, events, currentCycle, repoRoot);
        gates.push(resolvedGate.gateOutcome);
        if (resolvedGate.blocker) {
            blockers.push(resolvedGate.blocker);
        }
    }

    return { gates, blockers };
}
