import * as path from 'node:path';
import { readTaskTimelineJsonlEntries } from '../../gate-runtime/task-events';
import {
    taskTimelineAwareFileExists,
    withTaskTimelineFileReadSnapshot
} from '../../gate-runtime/timeline/task-timeline-read-snapshot';

import { joinOrchestratorPath, normalizePath } from '../shared/helpers';

export type ReviewLifecycleActionType = 'review_phase' | 'review_gate';

export interface ReviewLifecycleGuardResult {
    status: 'ALLOW' | 'BLOCK';
    timeline_path: string;
    blocking_event: string | null;
    violations: string[];
}

function resolveTimelinePath(repoRoot: string, taskId: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
}

function resolveBlockingEvent(eventTypes: Set<string>): string | null {
    if (eventTypes.has('COMPLETION_GATE_PASSED')) {
        return 'COMPLETION_GATE_PASSED';
    }
    if (eventTypes.has('REVIEW_GATE_PASSED_WITH_OVERRIDE')) {
        return 'REVIEW_GATE_PASSED_WITH_OVERRIDE';
    }
    if (eventTypes.has('REVIEW_GATE_PASSED')) {
        return 'REVIEW_GATE_PASSED';
    }
    return null;
}

export interface ReviewLifecycleTimelineEntry {
    event_type: string;
    sequence: number;
}

const REVIEW_RESET_EVENTS = new Set([
    'TASK_MODE_ENTERED',
    'PREFLIGHT_CLASSIFIED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED'
]);

function collectTimelineEntries(timelinePath: string, errors: string[]): ReviewLifecycleTimelineEntry[] {
    const entries: ReviewLifecycleTimelineEntry[] = [];
    let sequence = 0;
    for (const timelineEntry of readTaskTimelineJsonlEntries(timelinePath)) {
        const parsed = timelineEntry.record;
        if (!parsed) {
            errors.push(`Task timeline '${normalizePath(timelinePath)}' contains invalid JSON.`);
            sequence += 1;
            continue;
        }
        try {
            const eventType = String(parsed.event_type || '').trim().toUpperCase();
            if (eventType) {
                entries.push({
                    event_type: eventType,
                    sequence
                });
            }
        } catch {
            errors.push(`Task timeline '${normalizePath(timelinePath)}' contains invalid JSON.`);
        }
        sequence += 1;
    }
    return entries;
}

function getLatestBlockingEntry(entries: readonly ReviewLifecycleTimelineEntry[]): ReviewLifecycleTimelineEntry | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (
            entry.event_type === 'COMPLETION_GATE_PASSED'
            || entry.event_type === 'REVIEW_GATE_PASSED_WITH_OVERRIDE'
            || entry.event_type === 'REVIEW_GATE_PASSED'
        ) {
            return entry;
        }
    }
    return null;
}

function hasRecoveryAttemptAfterBlocking(entries: readonly ReviewLifecycleTimelineEntry[], blockingSequence: number): boolean {
    return entries.some((entry) => REVIEW_RESET_EVENTS.has(entry.event_type) && entry.sequence > blockingSequence);
}

function buildBlockedMessage(
    timelinePath: string,
    blockingEvent: string,
    actionLabel: string,
    actionType: ReviewLifecycleActionType
): string {
    if (actionType === 'review_gate') {
        return (
            `Task timeline '${normalizePath(timelinePath)}' already contains ${blockingEvent}. ` +
            `Do not rerun '${actionLabel}' in place after the review stage has passed. ` +
            'Start a fresh attempt or invalidate downstream evidence before rerunning the review gate.'
        );
    }

    return (
        `Task timeline '${normalizePath(timelinePath)}' already contains ${blockingEvent}. ` +
        `Do not append late review-phase telemetry via '${actionLabel}' after the task has already advanced past review preparation. ` +
        'Start a fresh attempt or invalidate downstream evidence before rerunning review preparation.'
    );
}

export function getReviewLifecycleGuardFromEntries(
    timelinePath: string,
    timelineEntries: readonly ReviewLifecycleTimelineEntry[],
    hasTimelineErrors: boolean,
    actionLabel: string,
    actionType: ReviewLifecycleActionType
): ReviewLifecycleGuardResult {
    if (timelineEntries.length === 0 && !hasTimelineErrors) {
        return {
            status: 'ALLOW',
            timeline_path: normalizePath(timelinePath),
            blocking_event: null,
            violations: []
        };
    }
    if (hasTimelineErrors) {
        return {
            status: 'BLOCK',
            timeline_path: normalizePath(timelinePath),
            blocking_event: null,
            violations: [
                `Task timeline '${normalizePath(timelinePath)}' is unreadable. Resolve timeline integrity before rerunning '${actionLabel}'.`
            ]
        };
    }

    const timelineEventTypes = new Set(timelineEntries.map((entry) => entry.event_type));
    const blockingEvent = resolveBlockingEvent(timelineEventTypes);
    const latestBlockingEntry = getLatestBlockingEntry(timelineEntries);
    if (!blockingEvent || !latestBlockingEntry) {
        return {
            status: 'ALLOW',
            timeline_path: normalizePath(timelinePath),
            blocking_event: null,
            violations: []
        };
    }
    if (hasRecoveryAttemptAfterBlocking(timelineEntries, latestBlockingEntry.sequence)) {
        return {
            status: 'ALLOW',
            timeline_path: normalizePath(timelinePath),
            blocking_event: null,
            violations: []
        };
    }

    return {
        status: 'BLOCK',
        timeline_path: normalizePath(timelinePath),
        blocking_event: blockingEvent,
        violations: [buildBlockedMessage(timelinePath, blockingEvent, actionLabel, actionType)]
    };
}

export function getReviewLifecycleGuard(
    repoRoot: string,
    taskId: string,
    actionLabel: string,
    actionType: ReviewLifecycleActionType
): ReviewLifecycleGuardResult {
    const timelinePath = resolveTimelinePath(repoRoot, taskId);
    return withTaskTimelineFileReadSnapshot(timelinePath, () => {
        if (!taskTimelineAwareFileExists(timelinePath)) {
            return {
                status: 'ALLOW',
                timeline_path: normalizePath(timelinePath),
                blocking_event: null,
                violations: []
            };
        }

        const timelineErrors: string[] = [];
        const timelineEntries = collectTimelineEntries(timelinePath, timelineErrors);
        return getReviewLifecycleGuardFromEntries(
            timelinePath,
            timelineEntries,
            timelineErrors.length > 0,
            actionLabel,
            actionType
        );
    });
}

export function assertReviewLifecycleGuardFromEntries(
    timelinePath: string,
    timelineEntries: readonly ReviewLifecycleTimelineEntry[],
    hasTimelineErrors: boolean,
    actionLabel: string,
    actionType: ReviewLifecycleActionType
): void {
    const result = getReviewLifecycleGuardFromEntries(
        timelinePath,
        timelineEntries,
        hasTimelineErrors,
        actionLabel,
        actionType
    );
    if (result.status === 'BLOCK') {
        throw new Error(result.violations[0]);
    }
}

export function assertReviewLifecycleGuard(
    repoRoot: string,
    taskId: string,
    actionLabel: string,
    actionType: ReviewLifecycleActionType
): void {
    const result = getReviewLifecycleGuard(repoRoot, taskId, actionLabel, actionType);
    if (result.status === 'BLOCK') {
        throw new Error(result.violations[0]);
    }
}
