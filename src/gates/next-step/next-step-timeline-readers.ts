import { countNextStepWork } from '../../core/next-step-measurement';
import {
    type TimelineEventEntry
} from '../completion/completion-evidence';

export function findLatestTimelineEvent(
    events: TimelineEventEntry[],
    predicate: (entry: TimelineEventEntry) => boolean
): TimelineEventEntry | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        countNextStepWork('visit:next-step-timeline-readers:event:9');
        const entry = events[index];
        if (predicate(entry)) {
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
