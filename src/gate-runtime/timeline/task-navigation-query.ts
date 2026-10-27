/** Internal audit/navigation facts, fed in the existing canonical verification callback. */
import { countNextStepWork } from '../../core/next-step-measurement';
import { isPlainRecord } from '../../core/records';
import { isAcceptedReviewTimelineRecord, type CompiledReviewDependencyGraph,
    type ReviewDependencyTimelineEventLike } from '../../core/review-dependency-graph';
import { parseTimestamp, formatTimestamp } from '../../core/event-timestamps';

type Event = Readonly<Record<string, unknown>>;
export interface NavigationTimelineQuery {
    readonly ordered: boolean;
    readonly count: number;
    readonly firstEventUtc: string | null;
    readonly lastEventUtc: string | null;
    readonly hasParentMarker: boolean;
    readonly hasSplit: boolean;
    readonly hasSupportingLifecycleAnchor: boolean;
    readonly hasReviewProgressAfterCompile: boolean;
    readonly latestTaskEntryIndex: number;
}
interface State {
    events: Event[];
    bySequence: Map<number, Event>;
    coverageBindings: Set<string>;
    acknowledgements: Map<string, { event: Event; index: number }>;
    latestExact: Map<string, Event>;
    latestNormalized: Map<string, Event>;
    latestReview: Map<string, Event>;
    latestDependencyReview: Map<string, Event>;
    firstPhase: Map<string, Event>;
    firstAccepted: Map<string, Event>;
    typedPhase: Event | null;
    untypedPhase: Event | null;
    compilePass: Event | null;
    restart: Event | null;
}
const states = new WeakMap<NavigationTimelineQuery, State>();
const arrays = new WeakMap<object, NavigationTimelineQuery>();
const SUPPORTING = new Set(['HANDSHAKE_DIAGNOSTICS_RECORDED', 'SHELL_SMOKE_PREFLIGHT_RECORDED',
    'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'REVIEW_PHASE_STARTED', 'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE', 'DOC_IMPACT_ASSESSED', 'PROJECT_MEMORY_IMPACT_ASSESSED']);
export const FULL_SUITE_TYPES = Object.freeze(['FULL_SUITE_VALIDATION_PASSED', 'FULL_SUITE_VALIDATION_WARNED',
    'FULL_SUITE_VALIDATION_FAILED', 'FULL_SUITE_VALIDATION_SKIPPED']);
export function navigationEventSequence(event: Event): number {
    return Number(isPlainRecord(event.integrity) ? event.integrity.task_sequence : 0);
}
function dependencyEvent(event: Event): ReviewDependencyTimelineEventLike {
    return { event_type: String(event.event_type || '').trim().toUpperCase(), sequence: navigationEventSequence(event),
        details: event.details && typeof event.details === 'object' ? event.details as Record<string, unknown> : null };
}
export function beginNavigationTimelineQueryPass() {
    const state: State = { events: [], bySequence: new Map(), coverageBindings: new Set(), acknowledgements: new Map(), latestExact: new Map(), latestNormalized: new Map(), latestReview: new Map(),
        latestDependencyReview: new Map(), firstPhase: new Map(), firstAccepted: new Map(), typedPhase: null,
        untypedPhase: null, compilePass: null, restart: null };
    let unsupported = false, sealed = false;
    let complete: NavigationTimelineQuery | null = null;
    let ordered = true, previousTime = -Infinity, previousSequence = -Infinity, hasParentMarker = false,
        hasSplit = false, hasSupportingLifecycleAnchor = false, latestCompile = -Infinity,
        latestProgress = -Infinity, latestTaskEntryIndex = -1;
    return {
        accept(record: Event | null): void {
          if (sealed) throw new Error('Navigation timeline collector is closed.');
          try {
            if (!record) { ordered = false; return; }
            const timestamp = parseTimestamp(record.timestamp_utc).getTime(), sequence = navigationEventSequence(record);
            if (timestamp <= 0 || timestamp < previousTime || !Number.isSafeInteger(sequence) || sequence <= previousSequence || sequence <= 0) ordered = false;
            previousTime = timestamp; previousSequence = sequence;
            const index = state.events.length;
            state.bySequence.set(sequence, record);
            state.events.push(record); // Reference only; record graph belongs to the canonical immutable parser owner.
            const exact = String(record.event_type || ''), type = exact.trim().toUpperCase();
            const details = record.details && typeof record.details === 'object' ? record.details as Record<string, unknown> : {};
            state.latestExact.set(exact, record); state.latestNormalized.set(type, record);
            if (type === 'ORCHESTRATOR_DEFECT_ACKNOWLEDGED') {
                const raw = isPlainRecord(record.details) ? record.details : {};
                const id = typeof raw.defect_id === 'string' ? raw.defect_id.trim() : '';
                state.acknowledgements.set(id || `missing-defect-id-${index}`, { event: record, index });
            }
            if (exact.trim() === 'REVIEW_RECORDED') {
                state.coverageBindings.add(JSON.stringify([String(details.review_type || '').trim().toLowerCase(),
                    String(details.review_context_sha256 || '').trim().toLowerCase(), String(details.preflight_sha256 || '').trim().toLowerCase()]));
            }
            if (exact === 'TASK_MODE_ENTERED') latestTaskEntryIndex = index;
            if (exact === 'DECOMPOSED_PARENT_COMPLETED') hasParentMarker = true;
            if (exact === 'STRICT_DECOMPOSITION_DECISION_RECORDED' && details.decision === 'split-required') hasParentMarker = hasSplit = true;
            if (SUPPORTING.has(exact)) hasSupportingLifecycleAnchor = true;
            if (type === 'COMPILE_GATE_PASSED' || type === 'COMPILE_GATE_FAILED') latestCompile = sequence;
            if (type.startsWith('REVIEW_') || type.startsWith('REVIEWER_') || type === 'COMPLETION_GATE_PASSED' || type === 'COMPLETION_GATE_FAILED') latestProgress = sequence;
            // These resets are EXACTLY the native dependency-order floor. Global latest records and typed presence survive.
            if (type === 'COMPILE_GATE_PASSED' || type === 'REVIEW_CYCLE_RESTARTED') {
                state.firstPhase.clear(); state.firstAccepted.clear();
                if (type === 'COMPILE_GATE_PASSED') state.compilePass = record; else state.restart = record;
            }
            if (type === 'REVIEW_PHASE_STARTED') {
                const lane = String(details.review_type ?? details.reviewType ?? '').trim().toLowerCase();
                if (lane) { state.typedPhase ??= record; if (!state.firstPhase.has(lane)) state.firstPhase.set(lane, record); }
                else state.untypedPhase = record;
            }
            if (type === 'REVIEW_RECORDED') {
                const lane = String(details.review_type || details.reviewType || '').trim().toLowerCase();
                state.latestReview.set(lane, record);
                const dependencyLane = String(details.review_type ?? details.reviewType ?? '').trim().toLowerCase();
                state.latestDependencyReview.set(dependencyLane, record);
                if (!state.firstAccepted.has(dependencyLane) && isAcceptedReviewTimelineRecord(dependencyEvent(record)))
                    state.firstAccepted.set(dependencyLane, record);
            }
          } catch { unsupported = true; } // Projection failure never changes native integrity acceptance.
        },
        finish(verified: boolean): NavigationTimelineQuery | null {
            if (sealed) return complete;
            sealed = true;
            if (!verified || unsupported) return null;
            // One retained internal view. It is never copied per consumer and is not placed in the memoized object graph.
            Object.freeze(state.events);
            const query: NavigationTimelineQuery = Object.freeze({ ordered, count: state.events.length,
                firstEventUtc: state.events.length ? formatTimestamp(state.events[0].timestamp_utc) : null,
                lastEventUtc: state.events.length ? formatTimestamp(state.events[state.events.length - 1].timestamp_utc) : null,
                hasParentMarker, hasSplit, hasSupportingLifecycleAnchor,
                hasReviewProgressAfterCompile: latestCompile === -Infinity || latestProgress > latestCompile, latestTaskEntryIndex });
            states.set(query, state); arrays.set(state.events, query);
            complete = query;
            return query;
        }
    };
}
export function navigationQueryForEvents(events: readonly object[]): NavigationTimelineQuery | null {
    return arrays.get(events) ?? null;
}
export function navigationOrderedEvents(query: NavigationTimelineQuery): readonly Event[] | null {
    return query.ordered ? states.get(query)?.events ?? null : null;
}
export function navigationRawEvents(query: NavigationTimelineQuery): readonly Event[] {
    const state = states.get(query); if (!state) throw new Error('Unknown navigation timeline query.');
    return state.events;
}
export function navigationLatestEvent(query: NavigationTimelineQuery, type: string, normalized = false): Event | null {
    countNextStepWork('visit:audit_query_type');
    const state = states.get(query);
    return (normalized ? state?.latestNormalized : state?.latestExact)?.get(type) ?? null;
}
export function navigationLatestReview(query: NavigationTimelineQuery, lane: string, nullish = false): Event | null {
    countNextStepWork('visit:audit_query_lane');
    const state = states.get(query);
    return (nullish ? state?.latestDependencyReview : state?.latestReview)?.get(lane) ?? null;
}
/** Exact witnesses for the FIRST native order violation, not a replacement for its full public result array. */
export function navigationDependencyWitnesses(query: NavigationTimelineQuery, graph: CompiledReviewDependencyGraph): ReviewDependencyTimelineEventLike[] {
    const state = states.get(query); if (!state || !query.ordered) throw new Error('Unordered navigation dependency query.');
    const selected = new Map<number, Event>();
    const add = (event: Event | null | undefined) => { if (event) selected.set(navigationEventSequence(event), event); };
    add(state.compilePass); add(state.restart); add(state.typedPhase); add(state.untypedPhase);
    for (const lane of graph.nodes) {
        countNextStepWork('visit:audit_dependency_query_lane');
        add(state.firstPhase.get(lane)); add(state.latestDependencyReview.get(lane)); add(state.firstAccepted.get(lane));
    }
    const result: ReviewDependencyTimelineEventLike[] = [];
    for (const event of selected.values()) { countNextStepWork('visit:audit_dependency_witness'); result.push(dependencyEvent(event)); }
    return result.sort((left, right) => { countNextStepWork('visit:audit_dependency_witness_comparison'); return left.sequence - right.sequence; });
}

export function navigationEventAtSequence(query: NavigationTimelineQuery, sequence: number): Event | null {
    countNextStepWork('visit:audit_query_sequence');
    return states.get(query)?.bySequence.get(sequence) ?? null;
}
export function navigationHasCoverageBinding(query: NavigationTimelineQuery, lane: string, contextSha: string, preflightSha: string): boolean {
    countNextStepWork('visit:audit_query_coverage_binding');
    return states.get(query)?.coverageBindings.has(JSON.stringify([lane, contextSha, preflightSha])) === true;
}
export function navigationAcknowledgements(query: NavigationTimelineQuery): readonly { event: Event; index: number }[] {
    const state = states.get(query); if (!state) return [];
    const values: { event: Event; index: number }[] = [];
    for (const value of state.acknowledgements.values()) {
        countNextStepWork('visit:audit_query_acknowledgement'); values.push({ event: value.event, index: value.index });
    }
    return values;
}
