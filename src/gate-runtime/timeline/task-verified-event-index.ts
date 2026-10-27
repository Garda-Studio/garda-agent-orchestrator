/** Invocation-private selections over the canonical, fully verified parser records. */
import type { TaskEventIntegrity } from './task-events-io-types';
import { parseTimestamp } from '../../core/event-timestamps';
import { countNextStepWork } from '../../core/next-step-measurement';
import type { TaskTimelineDeepReadonly } from './task-timeline-read-snapshot';

/** Structural projection for navigation without an upward gate dependency. */
export interface IndexedTimelineEvent {
    event_type: string;
    outcome?: string;
    timestamp_utc: string;
    sequence: number;
    details: Record<string, unknown> | null;
    integrity?: TaskEventIntegrity | null;
}

type Event = TaskTimelineDeepReadonly<Record<string, unknown>>;
export interface VerifiedTaskEventIndex {
    readonly normalizedEvents: readonly IndexedTimelineEvent[];
    readonly startBytes: readonly number[];
    readonly events: readonly Event[];
    readonly ordered: readonly Event[];
    readonly lastIndexByType: Readonly<Record<string, number>>;
    readonly byType: Readonly<Record<string, readonly Event[]>>;
    readonly byTrimmedType: Readonly<Record<string, readonly Event[]>>;
    readonly taskModeBoundaries: readonly number[];
    readonly reviewCycleBoundaries: readonly number[];
}
const indices = new WeakMap<object, VerifiedTaskEventIndex>();
const positions = new WeakMap<object, number>();
const normalizedTypes = new WeakMap<object, Readonly<Record<string, readonly IndexedTimelineEvent[]>>>();
const empty: readonly Event[] = Object.freeze([]);
export function verifiedIndexForEvents(events: readonly object[]): VerifiedTaskEventIndex | null {
    return indices.get(events) ?? null;
}
export function bindVerifiedEventIndex(events: readonly object[], index: VerifiedTaskEventIndex): void {
    indices.set(events, index);
}
export function beginVerifiedEventIndexPass() {
    const startBytes: number[] = [];
    const normalizedEvents: IndexedTimelineEvent[] = [];
    const normalizedByType: Record<string, IndexedTimelineEvent[]> = Object.create(null);
    const events: Event[] = [], lastIndexByType: Record<string, number> = Object.create(null);
    const byType: Record<string, Event[]> = Object.create(null), byTrimmedType: Record<string, Event[]> = Object.create(null);
    const taskModeBoundaries: number[] = [], reviewCycleBoundaries: number[] = [];
    let monotonic = true, previousTime = -Infinity;
    return {
        accept(event: Event, startByte: number): void {
            countNextStepWork('visit:verified_timeline_index_event');
            const position = events.length, type = String(event.event_type || '');
            startBytes.push(startByte);
            positions.set(event, position); events.push(event);
            // Validation boundaries use strict equality, unlike telemetry's string coercion.
            if (typeof event.event_type === 'string') lastIndexByType[event.event_type] = position;
            (byType[type] ??= []).push(event); (byTrimmedType[type.trim()] ??= []).push(event);
            const normalizedType = type.trim().toUpperCase();
            if (normalizedType) {
                const raw = event.integrity && typeof event.integrity === 'object' && !Array.isArray(event.integrity)
                    ? event.integrity as Record<string, unknown> : null;
                const sequence = typeof raw?.task_sequence === 'number' ? raw.task_sequence : Number(raw?.task_sequence);
                const sha = String(raw?.event_sha256 || '').trim().toLowerCase();
                const previous = raw?.prev_event_sha256 == null ? null : String(raw.prev_event_sha256).trim().toLowerCase() || null;
                const integrity = raw && Number.isInteger(sequence) && sequence > 0 && /^[0-9a-f]{64}$/.test(sha)
                    && (previous == null || /^[0-9a-f]{64}$/.test(previous))
                    ? { schema_version: typeof raw.schema_version === 'number' ? raw.schema_version : Number(raw.schema_version) || 1,
                        task_sequence: sequence, prev_event_sha256: previous, event_sha256: sha } : null;
                const normalized: IndexedTimelineEvent = { event_type: normalizedType,
                    outcome: String(event.outcome || '').trim().toUpperCase() || undefined,
                    timestamp_utc: String(event.timestamp_utc || '').trim(), sequence: position,
                    details: event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                        ? event.details as Record<string, unknown> : null, integrity };
                // Source details are already deeply frozen by the canonical parser owner.
                if (integrity) Object.freeze(integrity);
                Object.freeze(normalized);
                normalizedEvents.push(normalized); (normalizedByType[normalizedType] ??= []).push(normalized);
            }
            if (event.event_type === 'TASK_MODE_ENTERED') taskModeBoundaries.push(position);
            if (event.event_type === 'REVIEW_CYCLE_RESTARTED') reviewCycleBoundaries.push(position);
            const time = parseTimestamp(event.timestamp_utc).getTime();
            if (time < previousTime) monotonic = false;
            previousTime = time;
        },
        finish(verified: boolean): VerifiedTaskEventIndex | null {
            if (!verified) return null;
            // Audit uses a stable timestamp sort. Preserve ties and legacy timestamps.
            const ordered = monotonic ? events : [...events].sort((a, b) => {
                countNextStepWork('visit:audit_ordered_event_comparison');
                return parseTimestamp(a.timestamp_utc).getTime() - parseTimestamp(b.timestamp_utc).getTime();
            });
            for (const list of Object.values(byType)) Object.freeze(list);
            for (const list of Object.values(byTrimmedType)) Object.freeze(list);
            for (const list of Object.values(normalizedByType)) Object.freeze(list);
            normalizedTypes.set(normalizedEvents, Object.freeze(normalizedByType));
            const index = Object.freeze({ normalizedEvents: Object.freeze(normalizedEvents), startBytes: Object.freeze(startBytes), events: Object.freeze(events), ordered: Object.freeze(ordered),
                lastIndexByType: Object.freeze(lastIndexByType), byType: Object.freeze(byType),
                byTrimmedType: Object.freeze(byTrimmedType), taskModeBoundaries: Object.freeze(taskModeBoundaries),
                reviewCycleBoundaries: Object.freeze(reviewCycleBoundaries) });
            indices.set(events, index); indices.set(ordered, index);
            return index;
        }
    };
}
/** Select requested types, preserving native order and stable timestamp ties. */
export function selectVerifiedEvents(index: VerifiedTaskEventIndex, types: readonly string[],
    options: { trimmed?: boolean; normalized?: boolean; ordered?: boolean } = {}): readonly Event[] {
    const table = options.trimmed ? index.byTrimmedType : index.byType;
    if (types.length === 1 && !options.ordered && !options.normalized) return table[types[0]] ?? empty;
    const selected: Event[] = [];
    for (const type of new Set(types)) {
        if (options.normalized) {
            for (const entry of normalizedTypes.get(index.normalizedEvents)?.[type] ?? []) {
                countNextStepWork('visit:verified_timeline_selected_event'); selected.push(index.events[entry.sequence]);
            }
        } else for (const event of table[type] ?? empty) {
            countNextStepWork('visit:verified_timeline_selected_event'); selected.push(event);
        }
    }
    selected.sort((a, b) => (options.ordered
        ? parseTimestamp(a.timestamp_utc).getTime() - parseTimestamp(b.timestamp_utc).getTime() : 0)
        || positions.get(a)! - positions.get(b)!);
    return selected;
}

export function verifiedEventPosition(event: object): number | undefined { return positions.get(event); }

export function normalizedEventsOfType(events: readonly IndexedTimelineEvent[], type: string): readonly IndexedTimelineEvent[] | null {
    const table = normalizedTypes.get(events);
    return table ? table[type] ?? [] : null;
}
