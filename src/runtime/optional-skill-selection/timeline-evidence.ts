import * as path from 'node:path';
import {
    readTaskTimelineBoundedJsonlTail,
    taskTimelineAwareFileExists
} from '../../gate-runtime/task-events';
import { BASELINE_SKILL_DIRECTORIES } from '../skill-manifest';

import {
    type OptionalSkillSelectionTimelineEvidence,
    type OptionalSkillSelectionActivationEvidence,
    type OptionalSkillSelectionDeclineEvidence,
    type OptionalSkillSelectionReferenceLoadEvidence,
    type OptionalSkillSelectionArtifact,
    computeOptionalSkillSelectionFingerprint,
    resolvePortableRepoPath,
    selectLatestTimestamp,
    toTimestampMs
} from './types';

interface TimelinePoint {
    timestampUtc: string | null;
    taskSequence: number | null;
}

export const OPTIONAL_SKILL_TIMELINE_READ_LIMITS = Object.freeze({
    maxBytes: 1024 * 1024,
    maxLines: 4096,
    maxEvents: 2048,
    maxParseAttempts: 4096
});

export interface OptionalSkillActivationPoint {
    timestampMs: number;
    eventSequence: number | null;
}

function readTaskEventSequence(event: Record<string, unknown>): number | null {
    const integrity = event.integrity;
    if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)) {
        return null;
    }
    const value = Number((integrity as Record<string, unknown>).task_sequence);
    return Number.isFinite(value) ? value : null;
}

export function compareOptionalSkillEvidencePoints(
    left: OptionalSkillActivationPoint,
    right: OptionalSkillActivationPoint
): number {
    if (left.eventSequence !== null && right.eventSequence !== null) {
        return left.eventSequence - right.eventSequence;
    }
    if (left.eventSequence !== null) {
        return 1;
    }
    if (right.eventSequence !== null) {
        return -1;
    }
    return left.timestampMs - right.timestampMs;
}

function selectLatestTimelinePoint(current: TimelinePoint, next: TimelinePoint): TimelinePoint {
    if (next.taskSequence !== null && current.taskSequence !== null) {
        return next.taskSequence >= current.taskSequence ? next : current;
    }
    if (next.taskSequence !== null && current.taskSequence === null) {
        return next;
    }
    if (next.taskSequence === null && current.taskSequence !== null) {
        return current;
    }
    return selectLatestTimestamp(current.timestampUtc, next.timestampUtc) === next.timestampUtc
        ? next
        : current;
}

function normalizeSha256Fingerprint(value: unknown): string | null {
    const fingerprint = String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : null;
}

export function readOptionalSkillSelectionTimelineEvidence(
    bundleRoot: string,
    taskId: string,
    taskEventsPath?: string | null
): OptionalSkillSelectionTimelineEvidence {
    const resolvedTaskEventsPath = taskEventsPath
        ? path.resolve(taskEventsPath)
        : path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
    const eventTypes = new Set<string>();
    const optionalSkillActivations: OptionalSkillSelectionActivationEvidence[] = [];
    const optionalSkillDeclines: OptionalSkillSelectionDeclineEvidence[] = [];
    const optionalSkillReferenceLoads: OptionalSkillSelectionReferenceLoadEvidence[] = [];
    let latestTaskModeEntered: TimelinePoint = { timestampUtc: null, taskSequence: null };
    let latestCycleBoundary: TimelinePoint = { timestampUtc: null, taskSequence: null };
    let latestImplementationStarted: TimelinePoint = { timestampUtc: null, taskSequence: null };
    let latestCoherentCycleRestarted: TimelinePoint = { timestampUtc: null, taskSequence: null };

    if (!taskTimelineAwareFileExists(resolvedTaskEventsPath)) {
        return {
            timelinePath: resolvedTaskEventsPath,
            exists: false,
            invalidJson: false,
            eventTypes,
            latestTaskModeEnteredTimestampUtc: latestTaskModeEntered.timestampUtc,
            latestTaskModeEnteredTaskSequence: latestTaskModeEntered.taskSequence,
            latestCycleBoundaryTimestampUtc: latestCycleBoundary.timestampUtc,
            latestCycleBoundaryTaskSequence: latestCycleBoundary.taskSequence,
            latestImplementationStartedTimestampUtc: latestImplementationStarted.timestampUtc,
            latestImplementationStartedTaskSequence: latestImplementationStarted.taskSequence,
            latestCoherentCycleRestartedTimestampUtc: latestCoherentCycleRestarted.timestampUtc,
            latestCoherentCycleRestartedTaskSequence: latestCoherentCycleRestarted.taskSequence,
            optionalSkillActivations,
            optionalSkillDeclines,
            optionalSkillReferenceLoads
        };
    }

    const liveSkillsRoot = path.join(bundleRoot, 'live', 'skills');
    const boundedRead = readTaskTimelineBoundedJsonlTail<Record<string, unknown>>(
        resolvedTaskEventsPath,
        OPTIONAL_SKILL_TIMELINE_READ_LIMITS
    );
    for (const parsedLine of boundedRead.records) {
        const eventTaskId = String(parsedLine.task_id || '').trim();
        if (eventTaskId && eventTaskId !== taskId) {
            continue;
        }
        const eventType = String(parsedLine.event_type || '').trim().toUpperCase();
        const eventTimestampUtc = String(parsedLine.timestamp_utc || '').trim() || null;
        const taskSequence = readTaskEventSequence(parsedLine);
        const timelinePoint = { timestampUtc: eventTimestampUtc, taskSequence };
        if (eventType) {
            eventTypes.add(eventType);
        }
        if (eventType === 'TASK_MODE_ENTERED') {
            latestTaskModeEntered = selectLatestTimelinePoint(latestTaskModeEntered, timelinePoint);
        }
        if (eventType === 'TASK_MODE_ENTERED' || eventType === 'PREFLIGHT_STARTED' || eventType === 'PREFLIGHT_CLASSIFIED') {
            latestCycleBoundary = selectLatestTimelinePoint(latestCycleBoundary, timelinePoint);
        }
        if (eventType === 'IMPLEMENTATION_STARTED') {
            latestImplementationStarted = selectLatestTimelinePoint(latestImplementationStarted, timelinePoint);
        }
        if (eventType === 'COHERENT_CYCLE_RESTARTED') {
            latestCoherentCycleRestarted = selectLatestTimelinePoint(latestCoherentCycleRestarted, timelinePoint);
        }
        const details = parsedLine.details;
        if (eventType === 'COHERENT_CYCLE_RESTARTED' && details && typeof details === 'object' && !Array.isArray(details)) {
            const detailRecord = details as Record<string, unknown>;
            const reboundSkillIds = Array.isArray(detailRecord.optional_skill_activation_rebound_skill_ids)
                ? detailRecord.optional_skill_activation_rebound_skill_ids
                : [];
            const selectionFingerprintSha256 = normalizeSha256Fingerprint(
                detailRecord.optional_skill_activation_rebind_fingerprint_sha256
            );
            if (selectionFingerprintSha256) {
                for (const reboundSkillId of reboundSkillIds) {
                    const skillId = String(reboundSkillId || '').trim();
                    if (!skillId) {
                        continue;
                    }
                    optionalSkillActivations.push({
                        skillId,
                        triggerReason: 'coherent_cycle_restart_rebind',
                        timestampUtc: eventTimestampUtc,
                        eventSequence: taskSequence,
                        selectionFingerprintSha256
                    });
                }
            }
            const reboundDeclineSkillIds = Array.isArray(detailRecord.optional_skill_decline_rebound_skill_ids)
                ? detailRecord.optional_skill_decline_rebound_skill_ids
                : [];
            const declineSelectionFingerprintSha256 = normalizeSha256Fingerprint(
                detailRecord.optional_skill_decline_rebind_fingerprint_sha256
            );
            if (declineSelectionFingerprintSha256) {
                for (const reboundSkillId of reboundDeclineSkillIds) {
                    const skillId = String(reboundSkillId || '').trim();
                    if (!skillId) {
                        continue;
                    }
                    optionalSkillDeclines.push({
                        skillId,
                        triggerReason: 'coherent_cycle_restart_rebind',
                        timestampUtc: eventTimestampUtc,
                        eventSequence: taskSequence,
                        selectionFingerprintSha256: declineSelectionFingerprintSha256,
                        reason: null
                    });
                }
            }
        }
        if (eventType === 'SKILL_SELECTED' && details && typeof details === 'object' && !Array.isArray(details)) {
            const detailRecord = details as Record<string, unknown>;
            const triggerReason = String(detailRecord.trigger_reason || '').trim();
            if (triggerReason === 'optional_skill_selection') {
                optionalSkillActivations.push({
                    skillId: String(detailRecord.skill_id || '').trim() || null,
                    triggerReason: triggerReason || null,
                    timestampUtc: eventTimestampUtc,
                    eventSequence: taskSequence,
                    selectionFingerprintSha256: String(detailRecord.optional_skill_selection_fingerprint_sha256 || '').trim() || null
                });
            }
        }
        if (eventType === 'SKILL_DECLINED' && details && typeof details === 'object' && !Array.isArray(details)) {
            const detailRecord = details as Record<string, unknown>;
            const triggerReason = String(detailRecord.trigger_reason || '').trim();
            if (triggerReason === 'optional_skill_selection') {
                optionalSkillDeclines.push({
                    skillId: String(detailRecord.skill_id || '').trim() || null,
                    triggerReason: triggerReason || null,
                    timestampUtc: eventTimestampUtc,
                    eventSequence: taskSequence,
                    selectionFingerprintSha256: String(detailRecord.optional_skill_selection_fingerprint_sha256 || '').trim() || null,
                    reason: String(detailRecord.reason || '').trim() || null
                });
            }
        }
        if (eventType !== 'SKILL_REFERENCE_LOADED') {
            continue;
        }
        if (!details || typeof details !== 'object' || Array.isArray(details)) {
            continue;
        }
        const detailRecord = details as Record<string, unknown>;
        const triggerReason = String(detailRecord.trigger_reason || '').trim();
        if (triggerReason === 'review_skill') {
            continue;
        }
        const referencePath = String(detailRecord.reference_path || '').trim();
        if (!referencePath) {
            continue;
        }
        const resolvedReferencePath = resolvePortableRepoPath(bundleRoot, referencePath);
        const relativeReferencePath = path.relative(liveSkillsRoot, resolvedReferencePath).replace(/\\/g, '/');
        if (!relativeReferencePath || relativeReferencePath === '..' || relativeReferencePath.startsWith('../') || path.isAbsolute(relativeReferencePath)) {
            continue;
        }
        const skillDirectory = relativeReferencePath.split('/').filter(Boolean)[0] || '';
        if (BASELINE_SKILL_DIRECTORIES.includes(skillDirectory)) {
            continue;
        }
        optionalSkillReferenceLoads.push({
            skillId: String(detailRecord.skill_id || '').trim() || null,
            referencePath,
            resolvedReferencePath,
            triggerReason: triggerReason || null,
            timestampUtc: String(parsedLine.timestamp_utc || '').trim() || null,
            eventSequence: taskSequence
        });
    }

    return {
        timelinePath: resolvedTaskEventsPath,
        exists: true,
        invalidJson: boundedRead.invalidJson,
        boundedRead: {
            truncated: boundedRead.truncated,
            bytesRead: boundedRead.bytesRead,
            retainedLineCount: boundedRead.retainedLineCount,
            parsedEventCount: boundedRead.records.length,
            parseAttempts: boundedRead.parseAttempts,
            maxBytes: boundedRead.limits.maxBytes,
            maxLines: boundedRead.limits.maxLines,
            maxEvents: boundedRead.limits.maxEvents,
            maxParseAttempts: boundedRead.limits.maxParseAttempts
        },
        eventTypes,
        latestTaskModeEnteredTimestampUtc: latestTaskModeEntered.timestampUtc,
        latestTaskModeEnteredTaskSequence: latestTaskModeEntered.taskSequence,
        latestCycleBoundaryTimestampUtc: latestCycleBoundary.timestampUtc,
        latestCycleBoundaryTaskSequence: latestCycleBoundary.taskSequence,
        latestImplementationStartedTimestampUtc: latestImplementationStarted.timestampUtc,
        latestImplementationStartedTaskSequence: latestImplementationStarted.taskSequence,
        latestCoherentCycleRestartedTimestampUtc: latestCoherentCycleRestarted.timestampUtc,
        latestCoherentCycleRestartedTaskSequence: latestCoherentCycleRestarted.taskSequence,
        optionalSkillActivations,
        optionalSkillDeclines,
        optionalSkillReferenceLoads
    };
}

function isCurrentCycleOptionalSkillDecision(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence,
    entry: {
        timestampUtc: string | null;
        selectionFingerprintSha256?: string | null;
        triggerReason?: string | null;
        eventSequence?: number | null;
    }
): boolean {
    const taskModeLowerBoundTimestampMs = toTimestampMs(
        timelineEvidence.latestTaskModeEnteredTimestampUtc
        || payload.timestamp_utc
    );
    const cycleLowerBoundTimestampMs = toTimestampMs(
        timelineEvidence.latestCycleBoundaryTimestampUtc
        || timelineEvidence.latestTaskModeEnteredTimestampUtc
        || payload.timestamp_utc
    );
    const selectionFingerprintSha256 = String(
        payload.selection_fingerprint_sha256
        || computeOptionalSkillSelectionFingerprint(payload)
    ).trim();
    const eventTimestampMs = toTimestampMs(entry.timestampUtc);
    if (eventTimestampMs === null) {
        return false;
    }
    const coherentRestartBoundary = getLatestCoherentCycleRestartPoint(timelineEvidence);
    if (coherentRestartBoundary && didActivationOccurBeforeCycleBoundary({
        timestampMs: eventTimestampMs,
        eventSequence: entry.eventSequence ?? null
    }, coherentRestartBoundary)) {
        return false;
    }
    const entrySelectionFingerprintSha256 = String(entry.selectionFingerprintSha256 || '').trim().toLowerCase();
    if (entry.triggerReason === 'coherent_cycle_restart_rebind') {
        return Boolean(
            selectionFingerprintSha256
            && normalizeSha256Fingerprint(entrySelectionFingerprintSha256) === selectionFingerprintSha256
        );
    }
    if (
        selectionFingerprintSha256
        && entrySelectionFingerprintSha256
        && entrySelectionFingerprintSha256 !== selectionFingerprintSha256
    ) {
        return false;
    }
    if (taskModeLowerBoundTimestampMs !== null && eventTimestampMs < taskModeLowerBoundTimestampMs) {
        return Boolean(
            selectionFingerprintSha256
            && entrySelectionFingerprintSha256 === selectionFingerprintSha256
        );
    }
    if (cycleLowerBoundTimestampMs === null || eventTimestampMs >= cycleLowerBoundTimestampMs) {
        return true;
    }
    return Boolean(
        selectionFingerprintSha256
        && entrySelectionFingerprintSha256 === selectionFingerprintSha256
    );
}

export function getCurrentCycleOptionalSkillReferenceLoads(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillSelectionReferenceLoadEvidence[] {
    const lowerBound = selectLatestOptionalSkillPoint(
        getCurrentCycleBoundaryPoint(payload, timelineEvidence),
        getLatestCoherentCycleRestartPoint(timelineEvidence)
    );
    return timelineEvidence.optionalSkillReferenceLoads.filter((entry) => {
        if (!lowerBound) {
            return true;
        }
        const eventTimestampMs = toTimestampMs(entry.timestampUtc);
        if (eventTimestampMs === null) {
            return false;
        }
        return !didActivationOccurBeforeCycleBoundary({
            timestampMs: eventTimestampMs,
            eventSequence: entry.eventSequence ?? null
        }, lowerBound);
    });
}

export function getCurrentCycleOptionalSkillActivations(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillSelectionActivationEvidence[] {
    return timelineEvidence.optionalSkillActivations.filter((entry) => (
        isCurrentCycleOptionalSkillDecision(payload, timelineEvidence, entry)
    ));
}

export function getCurrentCycleOptionalSkillDeclines(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillSelectionDeclineEvidence[] {
    return (timelineEvidence.optionalSkillDeclines || []).filter((entry) => (
        isCurrentCycleOptionalSkillDecision(payload, timelineEvidence, entry)
    ));
}

export function buildCurrentCycleOptionalSkillActivationIndex(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): Map<string, number> {
    const activationPointIndex = buildCurrentCycleOptionalSkillActivationPointIndex(payload, timelineEvidence);
    const activationIndex = new Map<string, number>();
    for (const [skillId, activation] of activationPointIndex) {
        activationIndex.set(skillId, activation.timestampMs);
    }
    return activationIndex;
}

function buildCurrentCycleOptionalSkillActivationPointIndex(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): Map<string, OptionalSkillActivationPoint> {
    const activationIndex = new Map<string, OptionalSkillActivationPoint>();
    for (const activation of getCurrentCycleOptionalSkillActivations(payload, timelineEvidence)) {
        const skillId = String(activation.skillId || '').trim();
        const timestampMs = toTimestampMs(activation.timestampUtc);
        if (!skillId || timestampMs === null) {
            continue;
        }
        const activationPoint = {
            timestampMs,
            eventSequence: activation.eventSequence ?? null
        };
        const previous = activationIndex.get(skillId);
        if (!previous || compareOptionalSkillEvidencePoints(activationPoint, previous) > 0) {
            activationIndex.set(skillId, activationPoint);
        }
    }
    return activationIndex;
}

export function buildCurrentCycleOptionalSkillDeclineIndex(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): Map<string, number> {
    const declinePointIndex = new Map<string, OptionalSkillActivationPoint>();
    for (const decline of getCurrentCycleOptionalSkillDeclines(payload, timelineEvidence)) {
        const skillId = String(decline.skillId || '').trim();
        const timestampMs = toTimestampMs(decline.timestampUtc);
        if (!skillId || timestampMs === null) {
            continue;
        }
        const declinePoint = {
            timestampMs,
            eventSequence: decline.eventSequence ?? null
        };
        const previous = declinePointIndex.get(skillId);
        if (!previous || compareOptionalSkillEvidencePoints(declinePoint, previous) > 0) {
            declinePointIndex.set(skillId, declinePoint);
        }
    }
    const declineIndex = new Map<string, number>();
    for (const [skillId, decline] of declinePointIndex) {
        declineIndex.set(skillId, decline.timestampMs);
    }
    return declineIndex;
}

function getCurrentCycleBoundaryPoint(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillActivationPoint | null {
    const cycleBoundaryTimestampMs = toTimestampMs(
        timelineEvidence.latestCycleBoundaryTimestampUtc
        || timelineEvidence.latestTaskModeEnteredTimestampUtc
        || payload.timestamp_utc
    );
    if (cycleBoundaryTimestampMs === null) {
        return null;
    }
    return {
        timestampMs: cycleBoundaryTimestampMs,
        eventSequence: timelineEvidence.latestCycleBoundaryTaskSequence
            ?? timelineEvidence.latestTaskModeEnteredTaskSequence
            ?? null
    };
}

function getLatestCoherentCycleRestartPoint(
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillActivationPoint | null {
    const timestampMs = toTimestampMs(timelineEvidence.latestCoherentCycleRestartedTimestampUtc || null);
    if (timestampMs === null) {
        return null;
    }
    return {
        timestampMs,
        eventSequence: timelineEvidence.latestCoherentCycleRestartedTaskSequence ?? null
    };
}

function selectLatestOptionalSkillPoint(
    current: OptionalSkillActivationPoint | null,
    next: OptionalSkillActivationPoint | null
): OptionalSkillActivationPoint | null {
    if (!current) {
        return next;
    }
    if (!next) {
        return current;
    }
    return compareOptionalSkillEvidencePoints(next, current) >= 0 ? next : current;
}

function didActivationOccurBeforeCycleBoundary(
    activation: OptionalSkillActivationPoint,
    cycleBoundary: OptionalSkillActivationPoint
): boolean {
    return compareOptionalSkillEvidencePoints(activation, cycleBoundary) < 0;
}

export function getCurrentImplementationStartPoint(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillActivationPoint | null {
    const implementationTimestampMs = toTimestampMs(timelineEvidence.latestImplementationStartedTimestampUtc);
    if (implementationTimestampMs === null) {
        return null;
    }
    const implementationPoint = {
        timestampMs: implementationTimestampMs,
        eventSequence: timelineEvidence.latestImplementationStartedTaskSequence ?? null
    };
    const coherentRestart = getLatestCoherentCycleRestartPoint(timelineEvidence);
    if (
        coherentRestart
        && compareOptionalSkillEvidencePoints(implementationPoint, coherentRestart) < 0
    ) {
        return null;
    }
    const cycleBoundary = getCurrentCycleBoundaryPoint(payload, timelineEvidence);
    if (
        cycleBoundary
        && compareOptionalSkillEvidencePoints(implementationPoint, cycleBoundary) < 0
    ) {
        return null;
    }
    return implementationPoint;
}

export function didActivationOccurAfterImplementationStart(
    activation: OptionalSkillActivationPoint,
    implementationStart: OptionalSkillActivationPoint
): boolean {
    if (activation.eventSequence === null && implementationStart.eventSequence === null) {
        return activation.timestampMs > implementationStart.timestampMs;
    }
    return compareOptionalSkillEvidencePoints(activation, implementationStart) >= 0;
}

export function buildFreshCurrentCycleOptionalSkillActivationPointIndex(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): Map<string, OptionalSkillActivationPoint> {
    const activationIndex = new Map<string, OptionalSkillActivationPoint>();
    const cycleBoundary = getCurrentCycleBoundaryPoint(payload, timelineEvidence);
    for (const activation of getCurrentCycleOptionalSkillActivations(payload, timelineEvidence)) {
        const skillId = String(activation.skillId || '').trim();
        const timestampMs = toTimestampMs(activation.timestampUtc);
        if (!skillId || timestampMs === null) {
            continue;
        }
        const eventSequence = activation.eventSequence ?? null;
        const activationPoint = { timestampMs, eventSequence };
        if (cycleBoundary && didActivationOccurBeforeCycleBoundary(activationPoint, cycleBoundary)) {
            continue;
        }
        const previous = activationIndex.get(skillId);
        if (!previous) {
            activationIndex.set(skillId, activationPoint);
            continue;
        }
        if (compareOptionalSkillEvidencePoints(activationPoint, previous) > 0) {
            activationIndex.set(skillId, activationPoint);
        }
    }
    return activationIndex;
}

export function buildFreshCurrentCycleOptionalSkillDeclinePointIndex(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): Map<string, OptionalSkillActivationPoint> {
    const declineIndex = new Map<string, OptionalSkillActivationPoint>();
    const cycleBoundary = getCurrentCycleBoundaryPoint(payload, timelineEvidence);
    for (const decline of getCurrentCycleOptionalSkillDeclines(payload, timelineEvidence)) {
        const skillId = String(decline.skillId || '').trim();
        const timestampMs = toTimestampMs(decline.timestampUtc);
        if (!skillId || timestampMs === null) {
            continue;
        }
        const eventSequence = decline.eventSequence ?? null;
        const declinePoint = { timestampMs, eventSequence };
        if (cycleBoundary && didActivationOccurBeforeCycleBoundary(declinePoint, cycleBoundary)) {
            continue;
        }
        const previous = declineIndex.get(skillId);
        if (!previous) {
            declineIndex.set(skillId, declinePoint);
            continue;
        }
        if (compareOptionalSkillEvidencePoints(declinePoint, previous) > 0) {
            declineIndex.set(skillId, declinePoint);
        }
    }
    return declineIndex;
}

export function buildMandatoryCurrentCycleOptionalSkillActivationIndex(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): Map<string, number> {
    const implementationStart = getCurrentImplementationStartPoint(payload, timelineEvidence);
    const cycleBoundary = getCurrentCycleBoundaryPoint(payload, timelineEvidence);
    const activationIndex = new Map<string, OptionalSkillActivationPoint>();
    for (const activation of getCurrentCycleOptionalSkillActivations(payload, timelineEvidence)) {
        const skillId = String(activation.skillId || '').trim();
        const timestampMs = toTimestampMs(activation.timestampUtc);
        if (!skillId || timestampMs === null) {
            continue;
        }
        const activationPoint = {
            timestampMs,
            eventSequence: activation.eventSequence ?? null
        };
        if (cycleBoundary && didActivationOccurBeforeCycleBoundary(activationPoint, cycleBoundary)) {
            continue;
        }
        if (implementationStart && didActivationOccurAfterImplementationStart(activationPoint, implementationStart)) {
            continue;
        }
        const previous = activationIndex.get(skillId);
        if (!previous) {
            activationIndex.set(skillId, activationPoint);
            continue;
        }
        if (compareOptionalSkillEvidencePoints(activationPoint, previous) > 0) {
            activationIndex.set(skillId, activationPoint);
        }
    }
    const timestampIndex = new Map<string, number>();
    for (const [skillId, activation] of activationIndex) {
        if (implementationStart && didActivationOccurAfterImplementationStart(activation, implementationStart)) {
            continue;
        }
        timestampIndex.set(skillId, activation.timestampMs);
    }
    return timestampIndex;
}

export function getActivatedCurrentCycleOptionalSkillReferenceLoads(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillSelectionReferenceLoadEvidence[] {
    if (timelineEvidence.invalidJson) {
        return [];
    }
    const activationIndex = buildCurrentCycleOptionalSkillActivationPointIndex(payload, timelineEvidence);
    return getCurrentCycleOptionalSkillReferenceLoads(payload, timelineEvidence).filter((entry) => {
        const skillId = String(entry.skillId || '').trim();
        const activation = activationIndex.get(skillId);
        if (!skillId || !activation) {
            return false;
        }
        const eventTimestampMs = toTimestampMs(entry.timestampUtc);
        if (eventTimestampMs === null) {
            return false;
        }
        return !didActivationOccurBeforeCycleBoundary({
            timestampMs: eventTimestampMs,
            eventSequence: entry.eventSequence ?? null
        }, activation);
    });
}
