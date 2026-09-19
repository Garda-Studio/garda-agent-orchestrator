import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    readTaskTimelineJsonlEntries,
    type TaskEventIntegrity
} from '../../gate-runtime/task-events';
import {
    taskTimelineAwareFileExists,
    withTaskTimelineFileReadSnapshot
} from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import { normalizePath } from '../shared/helpers';

export interface TimelineEventEntry {
    event_type: string;
    outcome?: string;
    timestamp_utc: string;
    sequence: number;
    details: Record<string, unknown> | null;
    integrity?: TaskEventIntegrity | null;
}

export function collectOrderedTimelineEvents(timelinePath: string, errors: string[]): TimelineEventEntry[] {
    const resolvedPath = path.resolve(String(timelinePath || ''));
    return withTaskTimelineFileReadSnapshot(resolvedPath, () => (
        collectOrderedTimelineEventsFromSnapshot(resolvedPath, errors)
    ));
}

function collectOrderedTimelineEventsFromSnapshot(
    resolvedPath: string,
    errors: string[]
): TimelineEventEntry[] {
    const entries: TimelineEventEntry[] = [];
    if (!taskTimelineAwareFileExists(resolvedPath)) {
        errors.push(`Task timeline not found: ${normalizePath(resolvedPath)}`);
        return entries;
    }

    let seq = 0;
    for (const timelineEntry of readTaskTimelineJsonlEntries(resolvedPath)) {
        const parsed = timelineEntry.record;
        if (!parsed) {
            errors.push(`Task timeline contains invalid JSON line: ${normalizePath(resolvedPath)}`);
            seq++;
            continue;
        }
        try {
            const eventType = String(parsed.event_type || '').trim().toUpperCase();
            const timestampUtc = String(parsed.timestamp_utc || '').trim();
            const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                ? parsed.details as Record<string, unknown>
                : null;
            const rawIntegrity = parsed.integrity && typeof parsed.integrity === 'object' && !Array.isArray(parsed.integrity)
                ? parsed.integrity as Record<string, unknown>
                : null;
            const taskSequence = typeof rawIntegrity?.task_sequence === 'number'
                ? rawIntegrity.task_sequence
                : Number(rawIntegrity?.task_sequence);
            const eventSha256 = String(rawIntegrity?.event_sha256 || '').trim().toLowerCase();
            const prevEventSha256Raw = rawIntegrity?.prev_event_sha256;
            const prevEventSha256 = prevEventSha256Raw == null
                ? null
                : String(prevEventSha256Raw).trim().toLowerCase() || null;
            const integrity = rawIntegrity
                && Number.isInteger(taskSequence)
                && taskSequence > 0
                && /^[0-9a-f]{64}$/.test(eventSha256)
                && (prevEventSha256 == null || /^[0-9a-f]{64}$/.test(prevEventSha256))
                ? {
                    schema_version: typeof rawIntegrity.schema_version === 'number'
                        ? rawIntegrity.schema_version
                        : Number(rawIntegrity.schema_version) || 1,
                    task_sequence: taskSequence,
                    prev_event_sha256: prevEventSha256,
                    event_sha256: eventSha256
                } as TaskEventIntegrity
                : null;
            if (eventType) {
                entries.push({
                    event_type: eventType,
                    outcome: String(parsed.outcome || '').trim().toUpperCase() || undefined,
                    timestamp_utc: timestampUtc,
                    sequence: seq,
                    details,
                    integrity
                });
            }
            seq++;
        } catch {
            errors.push(`Task timeline contains invalid JSON line: ${normalizePath(resolvedPath)}`);
            seq++;
            continue;
        }
    }

    return entries;
}

export function readJsonArtifact(
    artifactPath: string,
    label: string,
    errors: string[],
    { required = true } = {}
): Record<string, unknown> | null {
    const resolvedPath = path.resolve(String(artifactPath || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        if (required) {
            errors.push(`${label} artifact not found: ${normalizePath(resolvedPath)}`);
        }
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    } catch {
        errors.push(`${label} artifact is not valid JSON: ${normalizePath(resolvedPath)}`);
        return null;
    }
}

export function ensurePassedArtifactStatus(
    artifact: Record<string, unknown> | null,
    label: string,
    errors: string[]
): void {
    if (!artifact) {
        return;
    }
    if (String(artifact.status || '').trim().toUpperCase() !== 'PASSED') {
        errors.push(`${label} artifact status must be PASSED, got '${String(artifact.status || 'UNKNOWN')}'.`);
    }
    if (String(artifact.outcome || '').trim().toUpperCase() !== 'PASS') {
        errors.push(`${label} artifact outcome must be PASS, got '${String(artifact.outcome || 'UNKNOWN')}'.`);
    }
}

export function readOptionalArtifactStringField(
    artifact: Record<string, unknown> | null,
    fieldName: string
): string | null {
    if (!artifact) {
        return null;
    }
    const value = artifact[fieldName];
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
}

export function normalizeTimelineDetailString(value: unknown): string | null {
    const text = String(value || '').trim();
    return text || null;
}

export function getTimelineSkillId(event: TimelineEventEntry): string | null {
    if (!event.details) {
        return null;
    }
    return normalizeTimelineDetailString(event.details.skill_id ?? event.details.skillId)?.toLowerCase() || null;
}

export function getTimelineReferencePath(event: TimelineEventEntry): string | null {
    if (!event.details) {
        return null;
    }
    const raw = normalizeTimelineDetailString(event.details.reference_path ?? event.details.referencePath);
    return raw ? normalizePath(raw).toLowerCase() : null;
}

export function eventMatchesReviewSkill(event: TimelineEventEntry, candidateSkillIds: string[]): boolean {
    const normalizedCandidates = candidateSkillIds.map(candidate => candidate.toLowerCase());
    const skillId = getTimelineSkillId(event);
    if (skillId && normalizedCandidates.includes(skillId)) {
        return true;
    }

    const referencePath = getTimelineReferencePath(event);
    if (!referencePath) {
        return false;
    }

    return normalizedCandidates.some((candidate) => referencePath.includes(`/live/skills/${candidate.toLowerCase()}/`));
}

export function eventMatchesStage(entry: TimelineEventEntry, stage: string): boolean {
    if (stage === 'REVIEW_GATE_PASSED') {
        return entry.event_type === 'REVIEW_GATE_PASSED' || entry.event_type === 'REVIEW_GATE_PASSED_WITH_OVERRIDE';
    }
    return entry.event_type === stage;
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

export function findLatestStageOccurrence(
    events: readonly TimelineEventEntry[],
    stage: string,
    upperBoundExclusive: number
): TimelineEventEntry | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry.sequence >= upperBoundExclusive) {
            continue;
        }
        if (eventMatchesStage(entry, stage)) {
            return entry;
        }
    }
    return null;
}

export function findLatestStageOccurrenceInRange(
    events: readonly TimelineEventEntry[],
    stage: string,
    lowerBoundExclusive: number,
    upperBoundExclusive: number
): TimelineEventEntry | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry.sequence >= upperBoundExclusive) {
            continue;
        }
        if (entry.sequence <= lowerBoundExclusive) {
            break;
        }
        if (eventMatchesStage(entry, stage)) {
            return entry;
        }
    }
    return null;
}

export function findLatestRecordedReviewContextPath(
    events: readonly TimelineEventEntry[],
    reviewKey: string
): string | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry.event_type !== 'REVIEW_RECORDED') {
            continue;
        }
        const recordedReviewType = String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase();
        if (recordedReviewType !== reviewKey) {
            continue;
        }
        const reviewContextPath = String(entry.details?.review_context_path || entry.details?.reviewContextPath || '').trim();
        if (reviewContextPath) {
            return reviewContextPath;
        }
    }
    return null;
}
