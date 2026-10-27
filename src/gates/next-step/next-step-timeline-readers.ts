import * as path from 'node:path';
import { readInvocationVerifiedEventIndex } from '../../gate-runtime/timeline/task-events-integrity';
import { normalizedEventsOfType } from '../../gate-runtime/timeline/task-verified-event-index';
import { collectOrderedTimelineEvents } from '../completion/completion-evidence';
import { countNextStepWork } from '../../core/next-step-measurement';
import {
    type TimelineEventEntry
} from '../completion/completion-evidence';

export function findLatestTimelineEvent(
    events: readonly TimelineEventEntry[],
    predicate: string | ((entry: TimelineEventEntry) => boolean),
    requiredEventType?: string
): TimelineEventEntry | null {
    // A supplied type must be required by the predicate; unindexed streams retain native traversal.
    const type = typeof predicate === 'string' ? predicate : requiredEventType;
    const candidates = type === undefined ? events : normalizedEventsOfType(events, type) ?? events;
    const matches = typeof predicate === 'string' ? (entry: TimelineEventEntry) => entry.event_type === predicate : predicate;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
        countNextStepWork('visit:next-step-timeline-readers:event:9');
        const entry = candidates[index];
        if (matches(entry)) {
            return entry;
        }
    }
    return null;
}

export function getTimelineEventDetailString(
    event: TimelineEventEntry | null,
    fieldName: string
): string {
    const value = event?.details?.[fieldName];
    return typeof value === 'string' ? value.trim() : '';
}

/** Internal normalized view; public completion collections remain independent mutable arrays. */
export function collectImmutableTimelineEvents(file: string, errors: string[]): readonly TimelineEventEntry[] {
    const indexed = readInvocationVerifiedEventIndex(file, path.basename(file, '.jsonl'));
    return indexed?.normalizedEvents ?? collectOrderedTimelineEvents(file, errors);
}
