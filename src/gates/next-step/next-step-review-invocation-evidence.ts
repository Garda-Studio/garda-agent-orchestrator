import * as path from 'node:path';
import { readTaskTimelineJsonlEntries } from '../../gate-runtime/timeline/task-events-helpers';

import {
    REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE,
    REVIEW_EVIDENCE_REQUIRED_PROVENANCE_ATTESTATION_TYPE,
    REVIEW_EVIDENCE_REQUIRED_PROVENANCE_EVENT_TYPE
} from '../review/review-evidence-contract';
import {
    getCurrentReviewerLaunchArtifactEvidenceForInvocation
} from './next-step-reviewer-launch-evidence';
import {
    fileExists,
    getLatestTaskSequenceForEventTypes,
    isPlainRecord,
    withNextStepReviewEvidenceSnapshot
} from './next-step-review-timeline-evidence';
import type {
    ReviewArtifactState
} from './next-step-review-artifact-readers';

export interface DelegatedReviewInvocationExpectation {
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    reviewContextSha256: string;
    reviewTreeStateSha256: string;
    routingEventSha256: string;
    launchArtifactSha256?: string | null;
    taskSequence: number;
    eventSha256: string;
    prevEventSha256: string | null;
}

function normalizeSha256(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function normalizeOptionalSha256(value: unknown): string | null {
    const normalized = normalizeSha256(value);
    return normalized || null;
}

function readTimelineEvents(eventsRoot: string, taskId: string): Record<string, unknown>[] {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return [];
    }
    return readTaskTimelineJsonlEntries(timelinePath)
        .flatMap((entry) => entry.record ? [entry.record] : []);
}

export function timelineHasMatchingDelegatedReviewInvocationAttestation(
    eventsRoot: string,
    expectation: DelegatedReviewInvocationExpectation
): boolean {
    const events = readTimelineEvents(eventsRoot, expectation.taskId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== REVIEW_EVIDENCE_REQUIRED_PROVENANCE_EVENT_TYPE) {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        if (String(details.task_id || '').trim() !== expectation.taskId) {
            continue;
        }
        if (String(details.review_type || '').trim() !== expectation.reviewType) {
            continue;
        }
        if (String(details.reviewer_execution_mode || '').trim() !== REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE) {
            continue;
        }
        const eventReviewerIdentity = String(details.reviewer_identity || details.reviewer_session_id || '').trim();
        if (eventReviewerIdentity !== expectation.reviewerIdentity) {
            continue;
        }
        if (
            normalizeSha256(details.review_context_sha256) !== expectation.reviewContextSha256
            || normalizeSha256(details.review_tree_state_sha256) !== expectation.reviewTreeStateSha256
            || normalizeSha256(details.routing_event_sha256) !== expectation.routingEventSha256
        ) {
            continue;
        }
        if (
            expectation.launchArtifactSha256
            && normalizeSha256(details.reviewer_launch_artifact_sha256) !== expectation.launchArtifactSha256
        ) {
            continue;
        }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
        const taskSequence = typeof integrity?.task_sequence === 'number'
            ? integrity.task_sequence
            : Number(integrity?.task_sequence);
        if (
            taskSequence !== expectation.taskSequence
            || normalizeSha256(integrity?.event_sha256) !== expectation.eventSha256
            || normalizeOptionalSha256(integrity?.prev_event_sha256) !== expectation.prevEventSha256
        ) {
            continue;
        }
        return true;
    }
    return false;
}

function buildDelegatedReviewInvocationExpectation(
    taskId: string,
    state: ReviewArtifactState,
    options: {
        requireReviewContextSha256: boolean;
        launchArtifactSha256?: string | null;
    }
): DelegatedReviewInvocationExpectation | null {
    if (state.reusedExistingReview) {
        return null;
    }
    if (!state.reviewerIdentity || !state.reviewerProvenance?.task_sequence || !state.reviewerProvenance.event_sha256) {
        return null;
    }
    if (
        state.reviewerProvenance.attestation_type !== REVIEW_EVIDENCE_REQUIRED_PROVENANCE_ATTESTATION_TYPE
        || state.reviewerProvenance.controller_event_type !== REVIEW_EVIDENCE_REQUIRED_PROVENANCE_EVENT_TYPE
    ) {
        return null;
    }
    const expectedReviewContextSha256 = normalizeSha256(state.reviewerProvenance.review_context_sha256);
    const expectedReviewTreeStateSha256 = state.contextReviewTreeStateSha256;
    if (
        (options.requireReviewContextSha256 && !expectedReviewContextSha256)
        || !expectedReviewTreeStateSha256
        || state.receiptReviewTreeStateSha256 !== expectedReviewTreeStateSha256
        || state.reviewerProvenance.review_tree_state_sha256 !== expectedReviewTreeStateSha256
    ) {
        return null;
    }
    return {
        taskId,
        reviewType: state.reviewType,
        reviewerIdentity: state.reviewerIdentity,
        reviewContextSha256: expectedReviewContextSha256,
        reviewTreeStateSha256: normalizeSha256(expectedReviewTreeStateSha256),
        routingEventSha256: normalizeSha256(state.reviewerProvenance.routing_event_sha256),
        launchArtifactSha256: options.launchArtifactSha256
            ? normalizeSha256(options.launchArtifactSha256)
            : null,
        taskSequence: state.reviewerProvenance.task_sequence,
        eventSha256: state.reviewerProvenance.event_sha256,
        prevEventSha256: state.reviewerProvenance.prev_event_sha256
    };
}

export function timelineHasDelegatedReviewInvocationAttestation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    return withNextStepReviewEvidenceSnapshot(eventsRoot, taskId, () => {
        const reviewerLaunchArtifactEvidence = getCurrentReviewerLaunchArtifactEvidenceForInvocation(
            repoRoot,
            eventsRoot,
            taskId,
            state
        );
        if (reviewerLaunchArtifactEvidence.state !== 'launched' || !reviewerLaunchArtifactEvidence.sha256) {
            return false;
        }
        const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
        if (
            latestCompileSequence == null
            || !state.reviewerProvenance?.task_sequence
            || state.reviewerProvenance.task_sequence <= latestCompileSequence
        ) {
            return false;
        }
        const expectation = buildDelegatedReviewInvocationExpectation(taskId, state, {
            requireReviewContextSha256: false,
            launchArtifactSha256: reviewerLaunchArtifactEvidence.sha256
        });
        if (!expectation) {
            return false;
        }
        return timelineHasMatchingDelegatedReviewInvocationAttestation(eventsRoot, expectation);
    });
}

export function timelineHasHistoricalDelegatedReviewInvocationAttestation(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    const expectation = buildDelegatedReviewInvocationExpectation(taskId, state, {
        requireReviewContextSha256: true
    });
    if (!expectation) {
        return false;
    }
    return timelineHasMatchingDelegatedReviewInvocationAttestation(eventsRoot, expectation);
}
