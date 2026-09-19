// Extracted from required-reviews-check.ts; keep behavior changes in the facade tests.
import { readTaskTimelineJsonlEntries, taskTimelineAwareFileExists } from '../../gate-runtime/task-events';
import { withTaskTimelineFileReadSnapshot } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import {
    normalizeCompatibilityReviewerExecutionMode,
    normalizeReviewProvenanceUtcTimestamp,
    normalizeReviewReceiptReviewerProvenance
} from '../../gate-runtime/review-context';
import { buildPlannedReviewerIdentity } from '../../gate-runtime/review/reviewer-identity-contract';
import { type ReviewDependencyTimelineEvent } from '../review/review-dependencies';
import { normalizeSha256String } from './required-reviews-check-evidence';

function timestampProvenanceMatchesEventDetails(
    details: Record<string, unknown> | null | undefined,
    provenanceValue: string | null | undefined,
    snakeKey: string,
    camelKey: string
): boolean {
    const rawValue = details?.[snakeKey] ?? details?.[camelKey];
    const rawText = String(rawValue || '').trim();
    if (!rawText) {
        return provenanceValue == null;
    }
    const eventValue = normalizeReviewProvenanceUtcTimestamp(rawText);
    return !!eventValue && provenanceValue === eventValue;
}

export function readReviewDependencyTimelineEvents(timelinePath: string): ReviewDependencyTimelineEvent[] {
    if (!timelinePath) {
        return [];
    }
    return withTaskTimelineFileReadSnapshot(timelinePath, () => {
        if (!taskTimelineAwareFileExists(timelinePath)) {
            return [];
        }
        const entries = readTaskTimelineJsonlEntries(timelinePath);
        if (entries.some((entry) => entry.record === null)) {
            return [];
        }
        return entries.map((timelineEntry, sequence) => {
            const parsed = timelineEntry.record!;
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
            return {
                event_type: String(parsed.event_type || '').trim().toUpperCase(),
                sequence,
                details,
                integrity: rawIntegrity
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
                    }
                    : null
            };
        });
    });
}

export function findLatestTimelineSequence(
    events: readonly ReviewDependencyTimelineEvent[],
    predicate: (entry: ReviewDependencyTimelineEvent) => boolean
): number | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (predicate(events[index])) {
            return events[index].sequence;
        }
    }
    return null;
}

export function findMatchingRoutingEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    reviewType: string,
    reviewerExecutionMode: string,
    reviewerIdentity: string,
    reviewerFallbackReason: string | null,
    reviewerProvenance?: ReturnType<typeof normalizeReviewReceiptReviewerProvenance>,
    allowHistoricalEvidence = false
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const latestCompilePassSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    const latestReviewPhaseSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => (
            entry.event_type === 'REVIEW_PHASE_STARTED'
            && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
        )
    );
    const cycleFloorSequence = allowHistoricalEvidence
        ? null
        : latestCompilePassSequence == null
        ? latestReviewPhaseSequence
        : latestReviewPhaseSequence == null
            ? latestCompilePassSequence
            : Math.max(latestCompilePassSequence, latestReviewPhaseSequence);
    if (cycleFloorSequence == null && !allowHistoricalEvidence) {
        return null;
    }
    if (reviewerProvenance?.attestation_type === 'controller_event_integrity') {
        for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
            const entry = timelineEvents[index];
            const details = entry.details;
            const eventFallbackReason = String((details?.reviewer_fallback_reason ?? details?.reviewerFallbackReason) || '').trim();
            if (cycleFloorSequence != null && entry.sequence <= cycleFloorSequence) {
                break;
            }
            if (
                entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
                && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
                && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === reviewerExecutionMode
                && String((details?.reviewer_session_id ?? details?.reviewerSessionId) || '').trim() === reviewerIdentity
                && (reviewerExecutionMode !== 'same_agent_fallback' || eventFallbackReason === (reviewerFallbackReason || ''))
                && entry.integrity
                && entry.integrity.task_sequence === reviewerProvenance.task_sequence
                && String(entry.integrity.event_sha256 || '').trim().toLowerCase() === reviewerProvenance.event_sha256
                && (entry.integrity.prev_event_sha256 == null
                    ? null
                    : String(entry.integrity.prev_event_sha256).trim().toLowerCase() || null) === reviewerProvenance.prev_event_sha256
            ) {
                return entry;
            }
        }
    }
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        if (cycleFloorSequence != null && entry.sequence <= cycleFloorSequence) {
            break;
        }
        const details = entry.details;
        const eventFallbackReason = String((details?.reviewer_fallback_reason ?? details?.reviewerFallbackReason) || '').trim();
        const eventSha256 = String(entry.integrity?.event_sha256 || '').trim().toLowerCase();
        const expectedRoutingEventSha256 = reviewerProvenance?.attestation_type === 'reviewer_invocation_attestation'
            ? String(reviewerProvenance.routing_event_sha256 || '').trim().toLowerCase()
            : '';
        if (
            entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
            && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === reviewerExecutionMode
            && String((details?.reviewer_session_id ?? details?.reviewerSessionId) || '').trim() === reviewerIdentity
            && (reviewerExecutionMode !== 'same_agent_fallback' || eventFallbackReason === (reviewerFallbackReason || ''))
            && (!expectedRoutingEventSha256 || eventSha256 === expectedRoutingEventSha256)
        ) {
            return entry;
        }
    }
    return null;
}

export function findMatchingRoutingEventWithDeferredIdentityFallback(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    reviewType: string,
    reviewerExecutionMode: string,
    reviewerIdentity: string,
    reviewerFallbackReason: string | null,
    reviewerProvenance?: ReturnType<typeof normalizeReviewReceiptReviewerProvenance>,
    allowHistoricalEvidence = false,
    taskId?: string | null
): ReviewDependencyTimelineEvent | null {
    const directMatch = findMatchingRoutingEvent(
        timelineEvents,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        reviewerProvenance,
        allowHistoricalEvidence
    );
    if (directMatch || !taskId) {
        return directMatch;
    }
    const plannedReviewerIdentity = buildPlannedReviewerIdentity(taskId, reviewType);
    if (plannedReviewerIdentity === reviewerIdentity) {
        return null;
    }
    return findMatchingRoutingEvent(
        timelineEvents,
        reviewType,
        reviewerExecutionMode,
        plannedReviewerIdentity,
        reviewerFallbackReason,
        reviewerProvenance,
        allowHistoricalEvidence
    );
}

export function findLatestRoutingEventForReviewType(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    reviewType: string
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const latestCompilePassSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    const latestReviewPhaseSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => (
            entry.event_type === 'REVIEW_PHASE_STARTED'
            && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
        )
    );
    const cycleFloorSequence = latestCompilePassSequence == null
        ? latestReviewPhaseSequence
        : latestReviewPhaseSequence == null
            ? latestCompilePassSequence
            : Math.max(latestCompilePassSequence, latestReviewPhaseSequence);
    if (cycleFloorSequence == null) {
        return null;
    }
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        if (entry.sequence <= cycleFloorSequence) {
            break;
        }
        if (
            entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
            && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
        ) {
            return entry;
        }
    }
    return null;
}

export function findMatchingInvocationAttestationEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    options: {
        taskId: string;
        reviewType: string;
        reviewerExecutionMode: string;
        reviewerIdentity: string;
        reviewContextSha256: string | null;
        reviewTreeStateSha256?: string | null;
        routingEventSha256: string | null;
        reviewerProvenance: NonNullable<ReturnType<typeof normalizeReviewReceiptReviewerProvenance>>;
    }
): ReviewDependencyTimelineEvent | null {
    if (options.reviewerProvenance.attestation_type !== 'reviewer_invocation_attestation') {
        return null;
    }
    const normalizedReviewType = String(options.reviewType || '').trim().toLowerCase();
    const normalizedTaskId = String(options.taskId || '').trim();
    const provenanceReviewContextSha256 = String(options.reviewerProvenance.review_context_sha256 || '').trim().toLowerCase();
    const normalizedReviewContextSha256 = normalizeSha256String(options.reviewContextSha256);
    const normalizedReviewTreeStateSha256 = normalizeSha256String(options.reviewTreeStateSha256);
    const normalizedRoutingEventSha256 = String(options.routingEventSha256 || '').trim().toLowerCase();
    if (
        options.reviewerProvenance.task_id !== normalizedTaskId
        || options.reviewerProvenance.review_type !== normalizedReviewType
        || options.reviewerProvenance.reviewer_execution_mode !== options.reviewerExecutionMode
        || options.reviewerProvenance.reviewer_identity !== options.reviewerIdentity
        || !provenanceReviewContextSha256
        || (normalizedReviewContextSha256
            && provenanceReviewContextSha256 !== normalizedReviewContextSha256)
        || (normalizedReviewTreeStateSha256
            && options.reviewerProvenance.review_tree_state_sha256 !== normalizedReviewTreeStateSha256)
        || options.reviewerProvenance.routing_event_sha256 !== normalizedRoutingEventSha256
    ) {
        return null;
    }

    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        const details = entry.details;
        const detailsTaskId = String(details?.task_id || details?.taskId || '').trim();
        const detailsReviewContextSha256 = String(details?.review_context_sha256 || details?.reviewContextSha256 || '')
            .trim()
            .toLowerCase();
        const detailsReviewTreeStateSha256 = normalizeSha256String(
            details?.review_tree_state_sha256 ?? details?.reviewTreeStateSha256
        );
        const detailsRoutingEventSha256 = String(details?.routing_event_sha256 || details?.routingEventSha256 || '')
            .trim()
            .toLowerCase();
        if (
            entry.event_type === 'REVIEWER_INVOCATION_ATTESTED'
            && (!detailsTaskId || detailsTaskId === normalizedTaskId)
            && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === options.reviewerExecutionMode
            && String((details?.reviewer_session_id ?? details?.reviewerSessionId ?? details?.reviewer_identity ?? details?.reviewerIdentity) || '').trim() === options.reviewerIdentity
            && detailsReviewContextSha256 === provenanceReviewContextSha256
            && (!normalizedReviewTreeStateSha256 || detailsReviewTreeStateSha256 === normalizedReviewTreeStateSha256)
            && detailsRoutingEventSha256 === normalizedRoutingEventSha256
            && entry.integrity
            && entry.integrity.task_sequence === options.reviewerProvenance.task_sequence
            && String(entry.integrity.event_sha256 || '').trim().toLowerCase() === options.reviewerProvenance.event_sha256
            && (entry.integrity.prev_event_sha256 == null
                ? null
                : String(entry.integrity.prev_event_sha256).trim().toLowerCase() || null) === options.reviewerProvenance.prev_event_sha256
            && timestampProvenanceMatchesEventDetails(
                details,
                options.reviewerProvenance.launch_prepared_at_utc,
                'launch_prepared_at_utc',
                'launchPreparedAtUtc'
            )
            && timestampProvenanceMatchesEventDetails(
                details,
                options.reviewerProvenance.launched_at_utc,
                'launched_at_utc',
                'launchedAtUtc'
            )
            && timestampProvenanceMatchesEventDetails(
                details,
                options.reviewerProvenance.launch_completed_at_utc,
                'launch_completed_at_utc',
                'launchCompletedAtUtc'
            )
            && timestampProvenanceMatchesEventDetails(
                details,
                options.reviewerProvenance.invocation_attested_at_utc,
                'invocation_attested_at_utc',
                'invocationAttestedAtUtc'
            )
        ) {
            return entry;
        }
    }
    return null;
}
