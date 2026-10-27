import { isAuthenticatedReviewRestartBoundary } from '../review/review-restart-boundary';
import { isInvocationReadObservationActive } from '../../core/invocation-read-observation';
import { countNextStepWork } from '../../core/next-step-measurement';
import { cloneJson } from '../../core/immutable-json';
import { normalizePath } from '../../core/orchestrator-paths';
import { isPlainRecord } from '../../core/records';

// Private retained facts: the public token cannot expose mutable Maps or an event array.
export interface TaskRouteQuery { readonly kind: 'task-route-query-v1' }
type Event = Readonly<Record<string, unknown>>;
interface Row { event: Event; ordinal: number; startByte: number; sequence: number }
interface WitnessLink { row: Row; references: number; previous: WitnessLink | null; next: WitnessLink | null }
interface State {
    count: number; bytes: number; exact: Map<number, Row>; sha: Map<string, Row>;
    latest: Map<string, Row>; lanes: Map<string, Row>; prepared: Map<string, Row>;
    reused: Map<string, Row>; routing: Map<string, Row>; attestations: Map<string, Row[]>; launchPrepared: Map<string, Row[]>; telemetry: Map<string, Row[]>; artifactBindings: Map<string, Row[]>;
    preflight: Map<string, Row>; prefix: Record<string, Row | undefined>; first: Map<string, Row>;
    split: Row[]; last: Row | null;
    coherentRestarts: Map<string, Row[]>; laneRestarts: Map<string, Row[]>;
    allLaunchPrepared: Row[]; launchInputPins: Map<string, Row[]>;
    witnesses: Map<Row, WitnessLink>; witnessHead: WitnessLink | null; witnessTail: WitnessLink | null;
}
const states = new WeakMap<TaskRouteQuery, State>();
const key = (...parts: string[]) => JSON.stringify(parts);
const text = (value: unknown) => String(value || '').trim();
const lower = (value: unknown) => text(value).toLowerCase();
const firstString = (primary: unknown, alias: unknown) => typeof primary === 'string' && primary.trim()
    ? primary.trim() : typeof alias === 'string' && alias.trim() ? alias.trim() : '';
const telemetryTypes = new Set(['REVIEWER_DELEGATION_STARTED', 'REVIEWER_LAUNCH_COMPLETED',
    'REVIEWER_PROVIDER_FAILED', 'REVIEWER_LAUNCH_FAILED', 'REVIEWER_DELEGATION_FAILED', 'REVIEWER_PROVIDER_LAUNCH_FAILED']);
const boundaries = new Set(['IMPLEMENTATION_STARTED', 'REVIEW_PHASE_STARTED', 'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE', 'COMPLETION_GATE_FAILED', 'COMPLETION_GATE_PASSED']);
const preflightTypes = new Set([...boundaries, 'TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'PREFLIGHT_FAILED',
    'HANDSHAKE_DIAGNOSTICS_RECORDED', 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'COMPILE_GATE_PASSED',
    'COHERENT_CYCLE_RESTARTED', 'REVIEW_CYCLE_RESTARTED']);
const splitTypes = new Set(['SPLIT_REQUIRED_LATCHED', 'STATUS_CHANGED', 'SPLIT_REQUIRED_CLEARED',
    'REVIEW_CYCLE_CONTINUATION_APPROVED', 'DECOMPOSED_PARENT_COMPLETED']);

/** Maintain the selected union in native append order. Prefix rows are already retained
 * by the current preflight slots; only the newly observed row is ever appended. */
function retainWitness(s: State, row: Row | undefined): void {
    if (!row) return;
    const existing = s.witnesses.get(row);
    if (existing) { existing.references++; return; }
    if (s.witnessTail && s.witnessTail.row.ordinal >= row.ordinal) throw new Error('Route witness order changed.');
    const link: WitnessLink = { row, references: 1, previous: s.witnessTail, next: null };
    if (s.witnessTail) s.witnessTail.next = link; else s.witnessHead = link;
    s.witnessTail = link; s.witnesses.set(row, link);
}
function releaseWitness(s: State, row: Row | undefined): void {
    if (!row) return;
    const link = s.witnesses.get(row);
    if (!link) throw new Error('Missing route witness reference.');
    if (--link.references) return;
    if (link.previous) link.previous.next = link.next; else s.witnessHead = link.next;
    if (link.next) link.next.previous = link.previous; else s.witnessTail = link.previous;
    s.witnesses.delete(row);
}
function replacePreflightWitness(s: State, name: string, row: Row): void {
    retainWitness(s, row);
    releaseWitness(s, s.preflight.get(name));
    s.preflight.set(name, row);
}

export function beginRouteVerifiedPass() {
    const s: State = { count: 0, bytes: 0, exact: new Map(), sha: new Map(), latest: new Map(),
        lanes: new Map(), prepared: new Map(), reused: new Map(), routing: new Map(), attestations: new Map(), launchPrepared: new Map(), telemetry: new Map(), artifactBindings: new Map(),
        preflight: new Map(), prefix: {}, first: new Map(), split: [], last: null,
        coherentRestarts: new Map(), laneRestarts: new Map(), allLaunchPrepared: [], launchInputPins: new Map(),
        witnesses: new Map(), witnessHead: null, witnessTail: null };
    let unavailable = false;
    let finished = false;
    return {
        accept(event: Event | null, ordinal: number, startByte: number | undefined): void {
            if (finished) throw new Error('Route query pass already finished.');
            s.count = ordinal + 1;
            if (!event || startByte == null) { unavailable = true; return; }
            try {
            const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
            const sequence = Number(integrity.task_sequence);
            if (!Number.isInteger(sequence) || sequence <= 0 || s.exact.has(sequence)) {
                unavailable = true; return;
            }
            const row: Row = { event, ordinal, startByte, sequence };
            const type = text(event.event_type), normalized = type.toUpperCase();
            text(event.timestamp_utc); text(event.outcome); // Match ordered-reader coercion failures via fallback.
            const details = isPlainRecord(event.details) ? event.details : {};
            s.exact.set(sequence, row); s.sha.set(lower(integrity.event_sha256), row);
            s.latest.set(type, row);
            if (type) retainWitness(s, row);
            if (s.last && text(s.last.event.event_type)) releaseWitness(s, s.last);
            s.last = row;
            s.lanes.set(key(normalized, String(details.review_type ?? details.reviewType ?? '').trim().toLowerCase()), row);
            if (type === 'REVIEW_PHASE_STARTED') s.prepared.set(key(text(details.review_type || details.reviewType),
                normalizePath(details.output_path || details.outputPath || '').toLowerCase()), row);
            if (event.event_type === 'REVIEW_CONTEXT_REUSE_ACCEPTED' && details.current_pass_review_evidence === true) {
                const output = normalizePath(details.output_path || details.outputPath || details.review_context_path || details.reviewContextPath || '').toLowerCase();
                if (output) s.reused.set(key(text(details.review_type || details.reviewType), output), row);
            }
            if (type === 'REVIEWER_DELEGATION_ROUTED' && text(details.reviewer_execution_mode) === 'delegated_subagent') {
                s.routing.set(key(text(details.review_type), text(details.reviewer_session_id)), row);
            }
            if (telemetryTypes.has(type)) {
                const k = key(type, text(details.review_type || details.reviewType),
                    lower(details.review_context_sha256 || details.reviewContextSha256),
                    lower(details.routing_event_sha256 || details.routingEventSha256));
                const rows = s.telemetry.get(k) ?? []; rows.push(row); s.telemetry.set(k, rows);
            }
            const artifactKey = key(firstString(details.task_id, details.taskId), firstString(details.review_type, details.reviewType),
                firstString(details.review_context_sha256, details.reviewContextSha256).toLowerCase(),
                firstString(details.routing_event_sha256, details.routingEventSha256).toLowerCase());
            const artifactRows = s.artifactBindings.get(artifactKey) ?? [];
            artifactRows.push(row); s.artifactBindings.set(artifactKey, artifactRows);
            // The very same predicate as the native consumer owns actor, outcome, detail
            // binding and lane preservation. A coercion failure disables this optional query.
            if (type === 'COHERENT_CYCLE_RESTARTED' || type === 'REVIEW_CYCLE_RESTARTED') {
                const task = text(event.task_id);
                if (type === 'COHERENT_CYCLE_RESTARTED') {
                    if (isAuthenticatedReviewRestartBoundary(event, task, '')) appendRow(s.coherentRestarts, task, row);
                } else if (Array.isArray(details.invalidated_review_types)) {
                    for (const lane of new Set(details.invalidated_review_types.map(text))) {
                        if (isAuthenticatedReviewRestartBoundary(event, task, lane)) appendRow(s.laneRestarts, key(task, lane), row);
                    }
                }
            }
            // Discovery deliberately uses first-string aliases and no lane/mode filter,
            // unlike the stricter prepared-event validator below.
            if (type === 'REVIEWER_LAUNCH_PREPARED') s.allLaunchPrepared.push(row);
            if (type === 'REVIEWER_LAUNCH_INPUT_PINNED') {
                appendRow(s.launchInputPins, key(firstString(details.task_id, details.taskId),
                    firstString(details.review_type, details.reviewType),
                    firstString(details.prepared_launch_event_sha256, details.preparedLaunchEventSha256).toLowerCase()), row);
            }
            if (type === 'REVIEWER_LAUNCH_PREPARED' && text(details.reviewer_execution_mode) === 'delegated_subagent') {
                const k = key(text(details.review_type), lower(details.review_context_sha256 || details.reviewContextSha256),
                    lower(details.routing_event_sha256));
                const rows = s.launchPrepared.get(k) ?? []; rows.push(row); s.launchPrepared.set(k, rows);
            }
            if (type === 'REVIEWER_INVOCATION_ATTESTED') {
                const k = key(text(details.review_type), lower(details.routing_event_sha256));
                const rows = s.attestations.get(k) ?? []; rows.push(row); s.attestations.set(k, rows);
            }
            // Fixed cardinality prefix witnesses preserve every predicate used by preflight recovery.
            // Earliest boundaries deliberately survive task-mode resets (native global rejection).
            if (normalized === 'PREFLIGHT_CLASSIFIED') {
                const prefix: State['prefix'] = {
                    'IMPLEMENTATION_STARTED': s.preflight.get('IMPLEMENTATION_STARTED'),
                    'REVIEW_PHASE_STARTED': s.preflight.get('REVIEW_PHASE_STARTED'),
                    'REVIEW_GATE_PASSED': s.preflight.get('REVIEW_GATE_PASSED'),
                    'REVIEW_GATE_PASSED_WITH_OVERRIDE': s.preflight.get('REVIEW_GATE_PASSED_WITH_OVERRIDE'),
                    'COMPLETION_GATE_FAILED': s.preflight.get('COMPLETION_GATE_FAILED'),
                    'COMPLETION_GATE_PASSED': s.preflight.get('COMPLETION_GATE_PASSED'),
                    'TASK_MODE_ENTERED': s.preflight.get('TASK_MODE_ENTERED'),
                    'PREFLIGHT_CLASSIFIED': s.preflight.get('PREFLIGHT_CLASSIFIED'),
                    'PREFLIGHT_FAILED': s.preflight.get('PREFLIGHT_FAILED'),
                    'HANDSHAKE_DIAGNOSTICS_RECORDED': s.preflight.get('HANDSHAKE_DIAGNOSTICS_RECORDED'),
                    'SHELL_SMOKE_PREFLIGHT_RECORDED': s.preflight.get('SHELL_SMOKE_PREFLIGHT_RECORDED'),
                    'COMPILE_GATE_PASSED': s.preflight.get('COMPILE_GATE_PASSED'),
                    'COHERENT_CYCLE_RESTARTED': s.preflight.get('COHERENT_CYCLE_RESTARTED'),
                    'REVIEW_CYCLE_RESTARTED': s.preflight.get('REVIEW_CYCLE_RESTARTED'),
                    'RULE_PACK_LOADED:TASK_ENTRY': s.preflight.get('RULE_PACK_LOADED:TASK_ENTRY')
                };
                // Retain before releasing: a row can occupy both the old and new prefix.
                for (const prior of Object.values(prefix)) retainWitness(s, prior);
                for (const prior of Object.values(s.prefix)) releaseWitness(s, prior);
                s.prefix = prefix;
            }
            if (preflightTypes.has(normalized)) replacePreflightWitness(s, normalized, row);
            if (normalized === 'RULE_PACK_LOADED' && text(details.stage).toUpperCase() === 'TASK_ENTRY') {
                replacePreflightWitness(s, 'RULE_PACK_LOADED:TASK_ENTRY', row);
            }
            if (boundaries.has(normalized)) {
                const k = normalized === 'IMPLEMENTATION_STARTED' ? 'implementation' : 'nonimplementation';
                if (!s.first.has(k)) { retainWitness(s, row); s.first.set(k, row); }
            }
            if (splitTypes.has(normalized)) s.split.push(row); // All matching rows; no dedupe/multiplicity loss.
            } catch { unavailable = true; } // Optional normalization must never change native integrity acceptance.
        },
        finish(status: string, byteLength: number | null): TaskRouteQuery | null {
            finished = true;
            // A legacy prefix is not a globally unique sequence index. Its native path remains exact.
            if (unavailable || status !== 'PASS' || byteLength == null) return null;
            s.bytes = byteLength;
            const token: TaskRouteQuery = Object.freeze({ kind: 'task-route-query-v1' });
            states.set(token, s);
            return token;
        }
    };
}
function state(query: TaskRouteQuery): State {
    const value = states.get(query); if (!value) throw new Error('Unknown route query token.'); return value;
}
function bounded(s: State, row: Row | undefined): row is Row {
    return !!row && row.ordinal >= s.count - 4096
        && (s.bytes <= 2 * 1024 * 1024 || row.startByte > s.bytes - 2 * 1024 * 1024);
}
export function routeLatestSequence(query: TaskRouteQuery, types: readonly string[], tail = false): number | null {
    const s = state(query); let latest: number | null = null;
    for (const type of types) {
        countNextStepWork('visit:route_query_requested_type'); const row = s.latest.get(type);
        if (row && (!tail || bounded(s, row))) latest = Math.max(latest ?? 0, row.sequence);
    }
    return latest;
}
export function routeExactEvent(query: TaskRouteQuery, sequence: number, sha256: string): Event | null {
    const row = state(query).exact.get(sequence);
    return row && lower((row.event.integrity as Record<string, unknown>).event_sha256) === sha256 ? row.event : null;
}
export function routeLatestLane(query: TaskRouteQuery, type: string, lane: string): number | null {
    const s = state(query), row = s.lanes.get(key(type.trim().toUpperCase(), lane.trim().toLowerCase()));
    return bounded(s, row) ? row.sequence : null;
}
export function routeLatestReuse(query: TaskRouteQuery, lane: string, contextPath: string): number | null {
    const s = state(query), row = s.reused.get(key(lane, normalizePath(contextPath).toLowerCase()));
    return bounded(s, row) ? row.sequence : null;
}
export function routePreparedAfter(query: TaskRouteQuery, lane: string, contextPath: string, compile: number): boolean {
    const row = state(query).prepared.get(key(lane, normalizePath(contextPath).toLowerCase()));
    return !!row && row.sequence > compile;
}
export function routeRoutingAfter(query: TaskRouteQuery, lane: string, identity: string, compile: number): string | null {
    const row = state(query).routing.get(key(lane, identity));
    return row && row.sequence > compile ? lower((row.event.integrity as Record<string, unknown>).event_sha256) : null;
}
export function routeInvocationCandidates(query: TaskRouteQuery, lane: string, routingSha: string): Event[] {
    const s = state(query); const rows: Event[] = [];
    const routing = s.sha.get(routingSha); if (routing) rows.push(routing.event);
    for (const row of s.attestations.get(key(lane, routingSha)) ?? []) {
        countNextStepWork('visit:route_query_attestation_candidate'); rows.push(row.event);
    }
    return rows; // Private caller array, retained records are immutable canonical parser records.
}
export function routeHasBoundedEvents(query: TaskRouteQuery): boolean {
    const s = state(query); return bounded(s, s.last ?? undefined);
}
export interface RouteOrderedEvent {
    event_type: string; outcome?: string; timestamp_utc: string; sequence: number;
    details: Record<string, unknown> | null;
    integrity: { schema_version: number; task_sequence: number; prev_event_sha256: string | null; event_sha256: string };
}
function ordered(row: Row): RouteOrderedEvent {
    countNextStepWork('visit:route_query_ordered_witness');
    const event = row.event, integrity = event.integrity as Record<string, unknown>;
    return { event_type: text(event.event_type).toUpperCase(), outcome: text(event.outcome).toUpperCase() || undefined,
        timestamp_utc: text(event.timestamp_utc), sequence: row.ordinal,
        details: isPlainRecord(event.details) ? cloneJson(event.details) : null,
        integrity: { schema_version: Number(integrity.schema_version), task_sequence: row.sequence,
            prev_event_sha256: integrity.prev_event_sha256 == null ? null : lower(integrity.prev_event_sha256) || null,
            event_sha256: lower(integrity.event_sha256) } };
}
export function routePreflightWitnesses(query: TaskRouteQuery): RouteOrderedEvent[] {
    const selected: RouteOrderedEvent[] = [];
    for (let link = state(query).witnessHead; link; link = link.next) selected.push(ordered(link.row));
    return selected;
}
export function routeSplitWitnesses(query: TaskRouteQuery): RouteOrderedEvent[] {
    return state(query).split.map(ordered);
}

// Bind only the native immutable parser entry view, never arbitrary mutable public arrays.
const entryViews = new WeakMap<readonly unknown[], TaskRouteQuery>();
export function bindRouteEntryView(query: TaskRouteQuery, entries: readonly unknown[]): void {
    if (Object.isFrozen(entries)) entryViews.set(entries, query);
}
export function routeQueryForEntries(entries: readonly unknown[]): TaskRouteQuery | null {
    return isInvocationReadObservationActive() ? entryViews.get(entries) ?? null : null;
}
export function routeEventIndexBySha(query: TaskRouteQuery, sha256: string): number {
    return state(query).sha.get(sha256)?.ordinal ?? -1;
}
export function* routePreparedLaunchIndices(query: TaskRouteQuery, lane: string,
    contextSha256: string, routingSha256: string): Iterable<number> {
    const rows = state(query).launchPrepared.get(key(lane, contextSha256, routingSha256)) ?? [];
    for (let index = rows.length - 1; index >= 0; index--) {
        countNextStepWork('visit:route_query_prepared_launch_candidate'); yield rows[index].ordinal;
    }
}

export function* routeTelemetryIndices(query: TaskRouteQuery, types: Iterable<string>, lane: string,
    contextSha: string, routingSha: string): Iterable<number> {
    for (const type of types) {
        countNextStepWork('visit:route_query_requested_telemetry_type');
        const rows = state(query).telemetry.get(key(type, lane, contextSha, routingSha)) ?? [];
        for (let index = rows.length - 1; index >= 0; index--) {
            countNextStepWork('visit:route_query_telemetry_candidate'); yield rows[index].ordinal;
        }
    }
}
export function* routeArtifactBindingIndices(query: TaskRouteQuery, task: string, lane: string,
    contextSha: string, routingSha: string, after: number): Iterable<number> {
    const rows = state(query).artifactBindings.get(key(task, lane, contextSha, routingSha)) ?? [];
    for (let index = rows.length - 1; index >= 0 && rows[index].ordinal > after; index--) {
        countNextStepWork('visit:route_query_artifact_binding_candidate'); yield rows[index].ordinal;
    }
}

function appendRow(rowsByKey: Map<string, Row[]>, name: string, row: Row): void {
    const rows = rowsByKey.get(name) ?? []; rows.push(row); rowsByKey.set(name, rows);
}
function lastOrdinal(rows: readonly Row[] | undefined): number {
    return rows?.length ? rows[rows.length - 1].ordinal : -1;
}
export function routeLatestReviewRestartIndex(query: TaskRouteQuery, task: string, lane: string): number {
    countNextStepWork('visit:route_query_restart_lookup');
    const s = state(query);
    return Math.max(lastOrdinal(s.coherentRestarts.get(task)), lastOrdinal(s.laneRestarts.get(key(task, lane))));
}
function firstOrdinalAfter(rows: readonly Row[] | undefined, after: number): number {
    // The current-cycle case is constant work even with many preserved-lane restarts.
    if (!rows?.length || rows[rows.length - 1].ordinal <= after) return -1;
    let lo = 0, hi = rows.length;
    while (lo < hi) {
        countNextStepWork('visit:route_query_restart_search');
        const mid = lo + Math.floor((hi - lo) / 2);
        if (rows[mid].ordinal <= after) lo = mid + 1; else hi = mid;
    }
    return rows[lo].ordinal;
}
export function routeFirstReviewRestartAfter(query: TaskRouteQuery, task: string, lane: string, after: number): number {
    countNextStepWork('visit:route_query_restart_lookup');
    const s = state(query);
    const coherent = firstOrdinalAfter(s.coherentRestarts.get(task), after);
    const review = firstOrdinalAfter(s.laneRestarts.get(key(task, lane)), after);
    return coherent < 0 ? review : review < 0 ? coherent : Math.min(coherent, review);
}
export function* routeLaunchDiscoveryIndices(query: TaskRouteQuery, after: number): Iterable<number> {
    const rows = state(query).allLaunchPrepared;
    for (let index = rows.length - 1; index >= 0 && rows[index].ordinal > after; index--) {
        countNextStepWork('visit:route_query_launch_discovery_candidate'); yield rows[index].ordinal;
    }
}
export function* routeLaunchInputPinIndices(query: TaskRouteQuery, task: string, lane: string,
    preparedSha: string, after: number): Iterable<number> {
    const boundary = routeFirstReviewRestartAfter(query, task, lane, after);
    const rows = state(query).launchInputPins.get(key(task, lane, preparedSha)) ?? [];
    for (const row of rows) {
        countNextStepWork('visit:route_query_input_pin_candidate');
        if (boundary >= 0 && row.ordinal >= boundary) break;
        if (row.ordinal > after) yield row.ordinal;
    }
}
