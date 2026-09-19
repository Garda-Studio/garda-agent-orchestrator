import * as path from 'node:path';
import { readTaskTimelineJsonlEntries, taskTimelineAwareFileExists } from '../../gate-runtime/task-events';
import { withTaskTimelineFileReadSnapshot } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import { joinOrchestratorPath, normalizePath } from '../shared/helpers';
import { type RulePackStageLabel, type TimelineEventEntry } from './rule-pack-types';
import { isRecord } from './rule-pack-records';

export function getTaskTimelinePath(repoRoot: string, taskId: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
}

export function getLatestTaskModeSequence(events: TimelineEventEntry[]): number | null {
    const latestTaskMode = findLatestTimelineEvent(events, function (entry) {
        return entry.event_type === 'TASK_MODE_ENTERED';
    });
    return latestTaskMode ? latestTaskMode.sequence : null;
}

export function getLatestPostPreflightRulePackEventAfter(
    events: TimelineEventEntry[],
    sequence: number,
    expectedArtifactPath?: string
): TimelineEventEntry | null {
    const normalizedExpectedArtifactPath = expectedArtifactPath
        ? normalizePath(expectedArtifactPath).toLowerCase()
        : null;
    return findLatestTimelineEvent(events, function (entry) {
        if (entry.sequence <= sequence || entry.event_type !== 'RULE_PACK_LOADED') {
            return false;
        }
        const stage = String(entry.details?.stage || '').trim().toUpperCase();
        if (stage !== 'POST_PREFLIGHT') {
            return false;
        }
        if (!normalizedExpectedArtifactPath) {
            return true;
        }
        const eventArtifactPath = normalizeTimelinePathDetail(
            entry.details?.artifact_path ?? entry.details?.artifactPath
        );
        return (eventArtifactPath || '').toLowerCase() === normalizedExpectedArtifactPath;
    });
}

export function collectOrderedTimelineEvents(timelinePath: string, violations: string[]): TimelineEventEntry[] {
    const resolvedPath = path.resolve(String(timelinePath || ''));
    return withTaskTimelineFileReadSnapshot(resolvedPath, () => {
        if (!taskTimelineAwareFileExists(resolvedPath)) {
            violations.push(`Task timeline not found: ${normalizePath(resolvedPath)}`);
            return [];
        }

        const events: TimelineEventEntry[] = [];
        let sequence = 0;
        for (const timelineEntry of readTaskTimelineJsonlEntries(resolvedPath)) {
            const parsed = timelineEntry.record;
            if (!parsed) {
                violations.push(`Task timeline contains invalid JSON line: ${normalizePath(resolvedPath)}`);
                return [];
            }
            try {
                const eventType = String(parsed.event_type || '').trim().toUpperCase();
                const details = isRecord(parsed.details) ? parsed.details : null;
                if (eventType) {
                    events.push({
                        event_type: eventType,
                        sequence,
                        details
                    });
                }
                sequence += 1;
            } catch {
                violations.push(`Task timeline contains invalid JSON line: ${normalizePath(resolvedPath)}`);
                return [];
            }
        }

        return events;
    });
}

export function findLatestTimelineEvent(
    events: readonly TimelineEventEntry[],
    predicate: (entry: TimelineEventEntry) => boolean
): TimelineEventEntry | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (predicate(entry)) {
            return entry;
        }
    }
    return null;
}

export function normalizeTimelinePathDetail(value: unknown): string | null {
    const rawValue = String(value || '').trim();
    if (!rawValue) {
        return null;
    }
    return normalizePath(rawValue);
}

export function getLatestRulePackTimelineArtifactPath(
    events: readonly TimelineEventEntry[],
    stage: RulePackStageLabel,
    expectedPreflightPath: string | null
): string | null {
    const latestRulePackEvent = findLatestTimelineEvent(events, function (entry) {
        if (entry.event_type !== 'RULE_PACK_LOADED') {
            return false;
        }
        const eventStage = String(entry.details?.stage || '').trim().toUpperCase();
        if (eventStage !== stage) {
            return false;
        }
        if (stage !== 'POST_PREFLIGHT') {
            return true;
        }
        const eventPreflightPath = normalizeTimelinePathDetail(
            entry.details?.preflight_path ?? entry.details?.preflightPath
        );
        if (!expectedPreflightPath) {
            return true;
        }
        return (eventPreflightPath || '').toLowerCase() === expectedPreflightPath.toLowerCase();
    });
    return normalizeTimelinePathDetail(
        latestRulePackEvent?.details?.artifact_path ?? latestRulePackEvent?.details?.artifactPath
    );
}
