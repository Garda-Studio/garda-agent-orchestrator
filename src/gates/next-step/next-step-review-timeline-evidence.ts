import * as path from 'node:path';
import type { BoundedJsonlTailResult } from '../../core/bounded-jsonl-tail';
import {
    readTaskTimelineBoundedJsonlTail,
    taskTimelineAwareFileExists,
    withTaskTimelineReadSnapshot
} from '../../gate-runtime/timeline/task-timeline-read-snapshot';

import type {
    ReviewReuseTelemetryEventLike
} from '../review-reuse/review-reuse-telemetry';
import { isPlainRecord } from '../../core/records';
export { isPlainRecord };

export function fileExists(filePath: string): boolean {
    return taskTimelineAwareFileExists(filePath);
}

export function withNextStepReviewEvidenceSnapshot<T>(
    eventsRoot: string,
    taskId: string,
    callback: () => T
): T {
    return withTaskTimelineReadSnapshot(eventsRoot, taskId, callback);
}

export const NEXT_STEP_REVIEW_TIMELINE_READ_LIMITS = Object.freeze({
    maxBytes: 2 * 1024 * 1024,
    maxLines: 8192,
    maxEvents: 4096,
    maxParseAttempts: 8192
});

export interface TaskTimelineEventWindow {
    events: ReviewReuseTelemetryEventLike[];
    truncated: boolean;
    invalidJson: boolean;
    bytesRead: number;
    retainedLineCount: number;
    parseAttempts: number;
}

function readTaskTimelineWindowFromPath(timelinePath: string): BoundedJsonlTailResult<ReviewReuseTelemetryEventLike> {
    return readTaskTimelineBoundedJsonlTail<ReviewReuseTelemetryEventLike>(
        timelinePath,
        NEXT_STEP_REVIEW_TIMELINE_READ_LIMITS
    );
}

export function readTaskTimelineEventWindow(eventsRoot: string, taskId: string): TaskTimelineEventWindow {
    return withNextStepReviewEvidenceSnapshot(eventsRoot, taskId, () => {
        const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
        if (!fileExists(timelinePath)) {
            return {
                events: [],
                truncated: false,
                invalidJson: false,
                bytesRead: 0,
                retainedLineCount: 0,
                parseAttempts: 0
            };
        }
        const result = readTaskTimelineWindowFromPath(timelinePath);
        return {
            events: result.invalidJson ? [] : result.records,
            truncated: result.truncated,
            invalidJson: result.invalidJson,
            bytesRead: result.bytesRead,
            retainedLineCount: result.retainedLineCount,
            parseAttempts: result.parseAttempts
        };
    });
}

export function getLatestTaskSequenceForEventTypes(
    eventsRoot: string,
    taskId: string,
    eventTypes: string[]
): number | null {
    return withNextStepReviewEvidenceSnapshot(eventsRoot, taskId, () => {
        const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
        if (!fileExists(timelinePath)) {
            return null;
        }
        const window = readTaskTimelineEventWindow(eventsRoot, taskId);
        if (window.invalidJson) {
            return null;
        }
        const wanted = new Set(eventTypes);
        let latestSequence: number | null = null;
        for (const event of window.events) {
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
        }
        return latestSequence;
    });
}

export function readTaskTimelineEventLikes(eventsRoot: string, taskId: string): ReviewReuseTelemetryEventLike[] {
    return readTaskTimelineEventWindow(eventsRoot, taskId).events;
}

export function getTimelineEventTaskSequence(event: ReviewReuseTelemetryEventLike): number | null {
    const integrity = event.integrity && typeof event.integrity === 'object' && !Array.isArray(event.integrity)
        ? event.integrity as Record<string, unknown>
        : null;
    const sequence = typeof integrity?.task_sequence === 'number'
        ? integrity.task_sequence
        : Number(integrity?.task_sequence);
    return Number.isInteger(sequence) && sequence > 0 ? sequence : null;
}

export function getLatestReviewEventSequence(
    events: readonly ReviewReuseTelemetryEventLike[],
    eventType: string,
    reviewType: string
): number | null {
    const normalizedEventType = eventType.trim().toUpperCase();
    const normalizedReviewType = reviewType.trim().toLowerCase();
    let latestSequence: number | null = null;
    for (const event of events) {
        if (String(event.event_type || '').trim().toUpperCase() !== normalizedEventType) {
            continue;
        }
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown>
            : null;
        const currentReviewType = String(details?.review_type ?? details?.reviewType ?? '').trim().toLowerCase();
        if (currentReviewType !== normalizedReviewType) {
            continue;
        }
        const sequence = getTimelineEventTaskSequence(event);
        if (sequence != null) {
            latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
        }
    }
    return latestSequence;
}
