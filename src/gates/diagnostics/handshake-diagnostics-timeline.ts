import * as path from 'node:path';
import {
    readTaskTimelineJsonlEntries,
    taskTimelineAwareFileExists
} from '../../gate-runtime/task-events';
import { withTaskTimelineFileReadSnapshot } from '../../gate-runtime/timeline/task-timeline-read-snapshot';

import {
    describePrePreflightCycleAnchor,
    getLatestPrePreflightCycleAnchor
} from '../preflight/pre-preflight-cycle-anchor';
import { normalizePath } from '../shared/helpers';
import type { TimelineEventEntry } from './handshake-diagnostics-types';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readTimelineEvents(timelinePath: string): TimelineEventEntry[] {
    const events: TimelineEventEntry[] = [];
    let sequence = 0;

    for (const timelineEntry of readTaskTimelineJsonlEntries(timelinePath)) {
        const parsed = timelineEntry.record;
        if (!parsed) {
            sequence += 1;
            continue;
        }
        try {
            const eventType = String(parsed.event_type || '').trim().toUpperCase();
            if (!eventType) {
                sequence += 1;
                continue;
            }
            events.push({
                event_type: eventType,
                sequence,
                details: isRecord(parsed.details) ? parsed.details : null
            });
        } catch {
            // Ignore malformed timeline lines here; upstream timeline collectors surface JSON errors separately.
        }
        sequence += 1;
    }

    return events;
}

function readTimelineEventsIfPresent(timelinePath: string): TimelineEventEntry[] | null {
    return withTaskTimelineFileReadSnapshot(timelinePath, () => (
        taskTimelineAwareFileExists(timelinePath) ? readTimelineEvents(timelinePath) : null
    ));
}

export function findLatestTimelineEvent(
    events: readonly TimelineEventEntry[],
    eventType: string
): TimelineEventEntry | null {
    const normalizedEventType = String(eventType || '').trim().toUpperCase();
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.event_type === normalizedEventType) {
            return event;
        }
    }
    return null;
}

/**
 * Verify that a HANDSHAKE_DIAGNOSTICS_RECORDED event exists in the timeline
 * and its latest recorded artifact_hash matches the actual artifact hash on disk.
 * Returns an empty array if verification passes or timeline is unavailable.
 */
export function verifyHandshakeTimelineBinding(
    taskId: string,
    artifactHash: string | null,
    timelinePath?: string
): string[] {
    if (!timelinePath) return [];

    const resolvedTimeline = path.resolve(timelinePath);
    const events = readTimelineEventsIfPresent(resolvedTimeline);
    if (!events) {
        return [];
    }

    const latestCycleAnchor = getLatestPrePreflightCycleAnchor(events);
    const latestHandshake = findLatestTimelineEvent(events, 'HANDSHAKE_DIAGNOSTICS_RECORDED');

    if (!latestCycleAnchor) {
        return [
            `Handshake diagnostics evidence is not bound to an active task cycle for '${taskId}'. ` +
            `Task timeline '${normalizePath(resolvedTimeline)}' is missing TASK_MODE_ENTERED. ` +
            'Run enter-task-mode before handshake-diagnostics and downstream preflight gates.'
        ];
    }

    if (!latestHandshake) {
        return [
            `Handshake diagnostics evidence is not bound to task timeline for '${taskId}'. ` +
            `HANDSHAKE_DIAGNOSTICS_RECORDED event is missing from '${normalizePath(resolvedTimeline)}'. ` +
            'Run handshake-diagnostics gate to emit proper lifecycle evidence.'
        ];
    }

    if (latestHandshake.sequence < latestCycleAnchor.sequence) {
        return [
            `Latest HANDSHAKE_DIAGNOSTICS_RECORDED evidence in '${normalizePath(resolvedTimeline)}' predates the ` +
            `${describePrePreflightCycleAnchor(latestCycleAnchor)} ` +
            `(handshake seq ${latestHandshake.sequence}). ` +
            'Re-run handshake-diagnostics for the current task cycle before shell-smoke-preflight, classify-change, or compile-gate. ' +
            'Do not parallelize enter-task-mode, handshake-diagnostics, and shell-smoke-preflight for the same task cycle.'
        ];
    }

    const recordedHash = latestHandshake.details && typeof latestHandshake.details.artifact_hash === 'string'
        ? latestHandshake.details.artifact_hash
        : null;
    if (artifactHash && recordedHash && artifactHash !== recordedHash) {
        return [
            `Handshake diagnostics artifact hash mismatch: file hash '${artifactHash}' ` +
            `does not match timeline-recorded hash '${recordedHash}'. ` +
            'The artifact may have been modified after the handshake gate ran.'
        ];
    }

    return [];
}
