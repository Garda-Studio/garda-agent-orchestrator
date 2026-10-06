import type { TaskEventsSummaryResult } from '../../gates/task-events-summary';

export const MAX_TASK_TIMELINE_EVENTS = 100;
export const MAX_TASK_TIMELINE_DETAILS_CHARS = 4096;
const MAX_DETAIL_NODES = 96;
const MAX_DETAIL_DEPTH = 5;
const MAX_DETAIL_CHILDREN = 12;
const MAX_DETAIL_STRING_CHARS = 512;
const MAX_REVIEW_TYPES = 32;
const CYCLE_BOUNDARY_TYPES = new Set(['TASK_MODE_ENTERED', 'COHERENT_CYCLE_RESTARTED', 'REVIEW_CYCLE_RESTARTED']);
const REVIEW_ATTEMPT_TYPES = new Set(['REVIEWER_DELEGATION_STARTED', 'REVIEWER_LAUNCH_FAILED',
    'REVIEWER_LAUNCH_COMPLETED', 'REVIEWER_INVOCATION_ATTESTED', 'REVIEW_RECORDED']);

export interface ReportTaskTimelineEvent {
    index: number;
    timestamp_utc: string | null;
    event_type: string;
    outcome: string;
    cycle: number;
    description: string;
    review_type: string | null;
    review_attempt: number | null;
    details_json: string;
    details_truncated: boolean;
}

export interface ReportTaskTimeline {
    task_id: string;
    source_path: string;
    total_events: number;
    latest_cycle: number;
    omitted_events: number;
    truncated: boolean;
    incomplete: boolean;
    diagnostics: string[];
    latest_cycle_json: string | null;
    latest_cycle_json_truncated: boolean;
    events: ReportTaskTimelineEvent[];
}

const EVENT_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
    TASK_MODE_ENTERED: 'Task cycle started.',
    RULE_PACK_LOADED: 'Workflow rules loaded.',
    HANDSHAKE_DIAGNOSTICS_RECORDED: 'Runtime and reviewer capabilities checked.',
    SHELL_SMOKE_PREFLIGHT_RECORDED: 'Shell and workspace checks recorded.',
    PREFLIGHT_STARTED: 'Change classification started.',
    PREFLIGHT_CLASSIFIED: 'Change scope and required reviews classified.',
    PREFLIGHT_FAILED: 'Change classification failed.',
    IMPLEMENTATION_STARTED: 'Implementation validation started.',
    COMPILE_GATE_PASSED: 'Compilation passed.',
    COMPILE_GATE_FAILED: 'Compilation failed.',
    REVIEW_PHASE_STARTED: 'Review context prepared.',
    REVIEWER_DELEGATION_ROUTED: 'Independent review routed.',
    REVIEWER_LAUNCH_PREPARED: 'Reviewer launch prepared.',
    REVIEWER_LAUNCH_INPUT_PINNED: 'Reviewer input pinned.',
    REVIEWER_DELEGATION_STARTED: 'Independent reviewer started.',
    REVIEWER_LAUNCH_FAILED: 'Reviewer launch failed.',
    REVIEWER_LAUNCH_COMPLETED: 'Independent reviewer returned.',
    REVIEWER_INVOCATION_ATTESTED: 'Reviewer invocation recorded.',
    REVIEW_RECORDED: 'Review result recorded.',
    REVIEW_GATE_PASSED: 'Required reviews passed.',
    REVIEW_GATE_PASSED_WITH_OVERRIDE: 'Required reviews passed with an override.',
    REVIEW_GATE_FAILED: 'Required review checks failed.',
    DOC_IMPACT_GATE_PASSED: 'Documentation impact checked.',
    FULL_SUITE_VALIDATION_PASSED: 'Configured full suite passed.',
    FULL_SUITE_VALIDATION_FAILED: 'Configured full suite failed.',
    FULL_SUITE_VALIDATION_WARNED: 'Configured full suite recorded a warning.',
    FULL_SUITE_VALIDATION_SKIPPED: 'Configured full suite was skipped.',
    PROJECT_MEMORY_IMPACT_ASSESSED: 'Project memory impact assessed.',
    COMPLETION_GATE_PASSED: 'Task completion validated.',
    COMPLETION_GATE_FAILED: 'Task completion checks failed.',
    COHERENT_CYCLE_RESTARTED: 'Workflow cycle restarted from recorded recovery evidence.',
    REVIEW_CYCLE_RESTARTED: 'Review cycle restarted from recorded recovery evidence.'
});

interface DetailBudget {
    remaining: number;
    truncated: boolean;
}

function boundedDetailValue(value: unknown, budget: DetailBudget, depth = 0): unknown {
    if (budget.remaining-- <= 0 || depth > MAX_DETAIL_DEPTH) {
        budget.truncated = true;
        return '[Omitted]';
    }
    if (typeof value === 'string') {
        if (value.length > MAX_DETAIL_STRING_CHARS) budget.truncated = true;
        return value.slice(0, MAX_DETAIL_STRING_CHARS);
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (Array.isArray(value)) {
        if (value.length > MAX_DETAIL_CHILDREN) budget.truncated = true;
        return value.slice(0, MAX_DETAIL_CHILDREN).map(item => boundedDetailValue(item, budget, depth + 1));
    }
    if (typeof value !== 'object') return null;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let count = 0;
    for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (count++ >= MAX_DETAIL_CHILDREN || budget.remaining <= 0) {
            budget.truncated = true;
            break;
        }
        if (key.length > MAX_DETAIL_STRING_CHARS) {
            budget.truncated = true;
            continue;
        }
        result[key] = boundedDetailValue((value as Record<string, unknown>)[key], budget, depth + 1);
    }
    return result;
}

function boundedJson(value: unknown): { json: string; truncated: boolean } {
    const budget: DetailBudget = { remaining: MAX_DETAIL_NODES, truncated: false };
    const json = JSON.stringify(boundedDetailValue(value, budget), null, 2);
    return { json: json.slice(0, MAX_TASK_TIMELINE_DETAILS_CHARS), truncated: budget.truncated || json.length > MAX_TASK_TIMELINE_DETAILS_CHARS };
}

function projectDetails(event: TaskEventsSummaryResult['timeline'][number]): Pick<ReportTaskTimelineEvent, 'details_json' | 'details_truncated'> {
    const result = boundedJson({ event_type: event.event_type, outcome: event.outcome,
        timestamp_utc: event.timestamp_utc, actor: event.actor, message: event.message, details: event.details ?? null });
    return {
        details_json: result.json,
        details_truncated: result.truncated
            || event.event_type.length > 128 || event.outcome.length > 64 || (event.timestamp_utc?.length || 0) > 128
    };
}

function reviewType(event: TaskEventsSummaryResult['timeline'][number]): string | null {
    const details = event.details;
    if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
    const value = (details as Record<string, unknown>).review_type;
    return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

export function buildReportTaskTimeline(summary: TaskEventsSummaryResult, sourcePath = summary.source_path, latestCycle?: unknown): ReportTaskTimeline {
    const startOffset = Math.max(0, summary.timeline.length - MAX_TASK_TIMELINE_EVENTS);
    const events: ReportTaskTimelineEvent[] = [];
    const attempts = new Map<string, number>();
    let cycle = 0;
    let missingBoundary = false;
    let attemptsTruncated = false;
    for (let offset = 0; offset < summary.timeline.length; offset++) {
        const event = summary.timeline[offset];
        if (CYCLE_BOUNDARY_TYPES.has(event.event_type)) {
            cycle++;
            attempts.clear();
        }
        const type = reviewType(event);
        if (type && event.event_type === 'REVIEWER_DELEGATION_STARTED') {
            if (attempts.has(type) || attempts.size < MAX_REVIEW_TYPES) attempts.set(type, (attempts.get(type) || 0) + 1);
            else attemptsTruncated = true;
        }
        if (offset < startOffset) continue;
        if (cycle === 0) missingBoundary = true;
        events.push({
            index: event.index,
            timestamp_utc: event.timestamp_utc?.slice(0, 128) || null,
            event_type: event.event_type.slice(0, 128),
            outcome: event.outcome.slice(0, 64),
            cycle,
            description: Object.hasOwn(EVENT_DESCRIPTIONS, event.event_type) ? EVENT_DESCRIPTIONS[event.event_type]
                : 'Recorded event; no description is available for this event type.',
            review_type: type,
            review_attempt: type && REVIEW_ATTEMPT_TYPES.has(event.event_type) ? attempts.get(type) ?? null : null,
            ...projectDetails(event)
        });
    }
    const diagnostics: string[] = [];
    if (summary.parse_errors > 0) diagnostics.push(`${summary.parse_errors} malformed event line(s) were omitted by the canonical summary.`);
    if (summary.integrity.status !== 'PASS') diagnostics.push(`Canonical event integrity: ${summary.integrity.status.slice(0, 128)}; violations=${summary.integrity.violations.length}.`);
    if (summary.event_contract.unknown_schema_version_count > 0) diagnostics.push('History contains events with an unknown schema version.');
    if (missingBoundary) diagnostics.push('Some visible events have no recorded cycle-start boundary.');
    if (attemptsTruncated) diagnostics.push('Review attempt numbering is bounded; some review types have no displayed attempt number.');
    if (events.some(event => !event.timestamp_utc || !Number.isFinite(Date.parse(event.timestamp_utc)))) {
        diagnostics.push('Some visible events have a missing or invalid recorded time.');
    }
    const rawSummary = latestCycle === undefined ? null : boundedJson(latestCycle);
    return {
        task_id: summary.task_id,
        source_path: sourcePath,
        total_events: summary.events_count,
        latest_cycle: cycle,
        omitted_events: startOffset,
        truncated: startOffset > 0 || attemptsTruncated || rawSummary?.truncated === true || events.some(event => event.details_truncated),
        incomplete: diagnostics.length > 0,
        diagnostics,
        latest_cycle_json: rawSummary?.json || null,
        latest_cycle_json_truncated: rawSummary?.truncated || false,
        events
    };
}
