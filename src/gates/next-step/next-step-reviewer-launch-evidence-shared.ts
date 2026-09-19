import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isPlainRecord } from '../../core/records';
import { readTaskTimelineJsonlEntries } from '../../gate-runtime/timeline/task-events-helpers';
import { taskTimelineAwareFileExists } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import { withNextStepReviewEvidenceSnapshot } from './next-step-review-timeline-evidence';
export { isPlainRecord };

export const PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch_preparation';
export const COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch';
export const PROVIDER_FAILED_ATTESTATION_STATES = new Set(['provider_failed', 'launch_failed', 'delegation_failed']);
export const REVIEWER_PROVIDER_FAILURE_EVENT_TYPES = new Set([
    'REVIEWER_PROVIDER_FAILED',
    'REVIEWER_LAUNCH_FAILED',
    'REVIEWER_DELEGATION_FAILED',
    'REVIEWER_PROVIDER_LAUNCH_FAILED'
]);

export function fileExists(filePath: string): boolean {
    return taskTimelineAwareFileExists(filePath);
}

export function stringSha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function getLatestTaskSequenceForEventTypes(eventsRoot: string, taskId: string, eventTypes: string[]): number | null {
    return withNextStepReviewEvidenceSnapshot(eventsRoot, taskId, () => {
        const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
        if (!fileExists(timelinePath)) {
            return null;
        }
        const wanted = new Set(eventTypes);
        let latestSequence: number | null = null;
        for (const timelineEntry of readTaskTimelineJsonlEntries(timelinePath)) {
            const event = timelineEntry.record;
            if (!event) {
                return null;
            }
            try {
                if (!wanted.has(String(event.event_type || '').trim())) {
                    continue;
                }
                const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
                const sequence = typeof integrity?.task_sequence === 'number'
                    ? integrity.task_sequence
                    : Number(integrity?.task_sequence);
                if (Number.isInteger(sequence) && sequence > 0) {
                    latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
                }
            } catch {
                // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
            }
        }
        return latestSequence;
    });
}

export function getArtifactStringField(artifact: Record<string, unknown>, ...fieldNames: string[]): string {
    for (const fieldName of fieldNames) {
        const rawValue = artifact[fieldName];
        if (typeof rawValue === 'string' && rawValue.trim()) {
            return rawValue.trim();
        }
    }
    return '';
}

export function getEventTaskSequence(event: Record<string, unknown>): number | null {
    const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
    const sequence = typeof integrity?.task_sequence === 'number'
        ? integrity.task_sequence
        : Number(integrity?.task_sequence);
    return Number.isInteger(sequence) && sequence > 0 ? sequence : null;
}
