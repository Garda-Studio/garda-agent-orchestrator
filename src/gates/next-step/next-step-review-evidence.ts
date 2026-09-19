import * as path from 'node:path';

import {
    getReviewExecutionDependencies,
    type EffectiveReviewExecutionPolicyMode
} from '../../core/review-execution-policy';
import {
    buildGateChainLaunchDecision,
    formatGateChainLaunchDecision
} from '../../core/dependent-validation-chains';
import {
    validateStrictReusedReviewEvidence,
    type ReviewReuseTelemetryEventLike
} from '../review-reuse/review-reuse-telemetry';
import {
    evaluateHiddenReviewTimingTrust,
    stripReviewTimingProvenanceTimestamps
} from '../review/review-timing-trust';
import {
    normalizePath
} from '../shared/helpers';
import { readReviewArtifactFileSha256 } from '../../gate-runtime/review-artifacts';
import { readTaskTimelineJsonlEntries } from '../../gate-runtime/timeline/task-events-helpers';
import {
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    timelineHasDelegatedReviewInvocationAttestation
} from './next-step-review-invocation-evidence';
import {
    fileExists,
    getLatestReviewEventSequence,
    getLatestTaskSequenceForEventTypes,
    getTimelineEventTaskSequence,
    isPlainRecord,
    readTaskTimelineEventLikes,
    withNextStepReviewEvidenceSnapshot
} from './next-step-review-timeline-evidence';
import type {
    ReviewArtifactState
} from './next-step-review-artifact-readers';

export function timelineHasReviewReuseRecordedAfterCompile(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    return withNextStepReviewEvidenceSnapshot(
        eventsRoot,
        taskId,
        () => validateStrictReviewReuseForState(eventsRoot, taskId, state).valid
    );
}

function readCompleteReviewTimelineEvidence(eventsRoot: string, taskId: string): {
    events: ReviewReuseTelemetryEventLike[];
    latestCompileSequence: number | null;
} | null {
    // Reuse references historical proof and invocation timing outside the recent tail.
    // The authenticated snapshot reader bounds bytes and parsed structure for the full history.
    const events: ReviewReuseTelemetryEventLike[] = [];
    let latestCompileSequence: number | null = null;
    for (const entry of readTaskTimelineJsonlEntries(path.join(eventsRoot, `${taskId}.jsonl`))) {
        if (!entry.record) return null;
        events.push(entry.record);
        if (entry.record.event_type === 'COMPILE_GATE_PASSED') {
            const sequence = getTimelineEventTaskSequence(entry.record);
            if (sequence != null) latestCompileSequence = Math.max(latestCompileSequence ?? 0, sequence);
        }
    }
    return { events, latestCompileSequence };
}

function validateStrictReviewReuseForState(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): ReturnType<typeof validateStrictReusedReviewEvidence> {
    if (
        !state.reusedExistingReview
        || !state.receiptExists
        || !state.contextExists
        || (!state.contextCurrent && !state.domainScopeCurrent)
        || !state.artifactExists
    ) {
        return { valid: false, reason: 'reused review evidence is not current or complete' };
    }
    const reviewContextSha256 = readReviewArtifactFileSha256(state.contextPath);
    const reviewArtifactSha256 = readReviewArtifactFileSha256(state.artifactPath);
    if (!reviewContextSha256 || !reviewArtifactSha256) {
        return { valid: false, reason: 'reused review evidence cannot be bound to current compile telemetry' };
    }
    const repoRoot = path.resolve(eventsRoot, '..', '..', '..');
    const timeline = readCompleteReviewTimelineEvidence(eventsRoot, taskId);
    if (!timeline) {
        return { valid: false, reason: 'reused review timeline contains malformed historical JSON' };
    }
    if (timeline.latestCompileSequence == null) {
        return { valid: false, reason: 'reused review evidence cannot be bound to current compile telemetry' };
    }
    return validateStrictReusedReviewEvidence({
        repoRoot,
        taskId,
        reviewType: state.reviewType,
        events: timeline.events,
        receiptPath: state.receiptPath,
        reviewContextSha256,
        reviewContextReuseSha256: state.receiptReviewContextReuseSha256,
        reviewTreeStateSha256: state.receiptReviewTreeStateSha256,
        reviewScopeSha256: state.receiptReviewScopeSha256,
        codeScopeSha256: state.receiptCodeScopeSha256,
        reviewArtifactSha256,
        reusedFromReceiptPath: state.reusedFromReceiptPath,
        reusedFromReceiptSha256: state.reusedFromReceiptSha256,
        reusedFromReviewContextSha256: state.reusedFromReviewContextSha256,
        reusedFromReviewContextReuseSha256: state.reusedFromReviewContextReuseSha256,
        reusedFromReviewTreeStateSha256: state.reusedFromReviewTreeStateSha256,
        reusedFromReviewScopeSha256: state.reusedFromReviewScopeSha256,
        reusedFromCodeScopeSha256: state.reusedFromCodeScopeSha256,
        reviewerExecutionMode: state.reviewerProvenance?.reviewer_execution_mode || null,
        reviewerIdentity: state.reviewerIdentity,
        reviewerProvenance: state.reviewerProvenance as unknown as Record<string, unknown> | null,
        latestCompileTaskSequence: timeline.latestCompileSequence
    });
}

function getStrictReusedReviewRecordedDetailsForTimingTrust(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): Record<string, unknown> | null {
    const validation = validateStrictReviewReuseForState(eventsRoot, taskId, state);
    return validation.valid ? validation.historicalReviewRecordedDetails : null;
}

export function buildReviewGateChainStatusSummary(options: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    reviewType: string;
    edgeId: string;
    status?: 'pass' | 'block';
    reason: string;
    preflightPath: string;
    reviewContextPath?: string;
    depth?: number | string;
}): string {
    const timelinePath = path.join(options.eventsRoot, `${options.taskId}.jsonl`);
    const decision = buildGateChainLaunchDecision({
        edgeId: options.edgeId,
        status: options.status || 'pass',
        reason: options.reason,
        context: {
            taskId: options.taskId,
            reviewType: options.reviewType,
            preflightPath: options.preflightPath,
            reviewContextPath: options.reviewContextPath,
            depth: options.depth,
            repoRoot: '.'
        },
        evidencePaths: [
            toRepoDisplayPath(options.repoRoot, timelinePath)
        ]
    });
    return (
        `${formatGateChainLaunchDecision(decision)} ` +
        'LaneScope=review_type; independent review lanes remain eligible when their own prerequisites are current.'
    );
}

export function timelineHasReviewContextPreparedAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    contextPath: string
): boolean {
    return withNextStepReviewEvidenceSnapshot(eventsRoot, taskId, () => {
        const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
        if (!fileExists(timelinePath)) {
            return false;
        }
        const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
        if (latestCompileSequence == null) {
            return false;
        }
        const expectedContextPath = normalizePath(contextPath).toLowerCase();
        for (const timelineEntry of readTaskTimelineJsonlEntries(timelinePath)) {
            const event = timelineEntry.record;
            if (!event) {
                continue;
            }
            try {
                if (String(event.event_type || '').trim() !== 'REVIEW_PHASE_STARTED') {
                    continue;
                }
                const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
                const taskSequence = typeof integrity?.task_sequence === 'number'
                    ? integrity.task_sequence
                    : Number(integrity?.task_sequence);
                if (!Number.isInteger(taskSequence) || taskSequence <= latestCompileSequence) {
                    continue;
                }
                const details = isPlainRecord(event.details) ? event.details : {};
                const eventReviewType = String(details.review_type || details.reviewType || '').trim();
                const outputPath = normalizePath(details.output_path || details.outputPath || '').toLowerCase();
                if (eventReviewType === reviewType && outputPath === expectedContextPath) {
                    return true;
                }
            } catch {
                // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
            }
        }
        return false;
    });
}

export function reviewStateHasSatisfiedEvidence(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    return withNextStepReviewEvidenceSnapshot(eventsRoot, taskId, () => {
        if (!state.ready) {
            return false;
        }
        if (getHiddenReviewTimingTrustRemediation(eventsRoot, taskId, state)) {
            return false;
        }
        if (
            state.reviewFindingsDisposition
            && state.reviewFindingsDisposition.counts_by_action.create_follow_up > 0
            && !state.reviewFindingsFollowUpSatisfied
            && state.reviewFollowUpMaterializationMode !== 'grouped_by_parent'
        ) {
            return false;
        }
        if (state.reusedExistingReview) {
            return timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state);
        }
        if (state.domainScopeCurrent && !state.contextCurrent) {
            return false;
        }
        return timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot, taskId, state);
    });
}

function getStringArrayField(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
}

function latestReviewGateFailureIsAuthorshipAttestationOnly(
    eventsRoot: string,
    taskId: string,
    latestReviewGateFailureSequence: number
): boolean {
    const event = readTaskTimelineEventLikes(eventsRoot, taskId)
        .find((candidate) => (
            String(candidate.event_type || '').trim() === 'REVIEW_GATE_FAILED'
            && getTimelineEventTaskSequence(candidate) === latestReviewGateFailureSequence
        ));
    if (!event || !isPlainRecord(event.details)) {
        return false;
    }
    const details = event.details;
    const attestation = isPlainRecord(details.review_authorship_attestation)
        ? details.review_authorship_attestation
        : null;
    if (!attestation) {
        return false;
    }
    const status = String(attestation.status || '').trim().toUpperCase();
    if (!status || ['PASSED', 'NOT_REQUIRED'].includes(status)) {
        return false;
    }
    const violations = [
        ...getStringArrayField(details.violations),
        ...getStringArrayField(attestation.violations)
    ];
    return violations.length > 0
        && violations.every((violation) => /\bReview authorship attestation\b/i.test(violation));
}

export function getHiddenReviewTimingTrustRemediation(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): string | null {
    return withNextStepReviewEvidenceSnapshot(eventsRoot, taskId, () => {
        const completeTimeline = state.reusedExistingReview
            ? readCompleteReviewTimelineEvidence(eventsRoot, taskId)
            : null;
        const timelineEvents = completeTimeline?.events ?? readTaskTimelineEventLikes(eventsRoot, taskId);
        const latestCompileSequence = completeTimeline
            ? completeTimeline.latestCompileSequence
            : getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
        const strictReusedReviewRecordedDetails = state.reusedExistingReview
            ? getStrictReusedReviewRecordedDetailsForTimingTrust(eventsRoot, taskId, state)
            : null;
        if (state.reusedExistingReview && !strictReusedReviewRecordedDetails) {
            return null;
        }
        const timingTrust = evaluateHiddenReviewTimingTrust({
            reviewType: state.reviewType,
            reusedExistingReview: state.reusedExistingReview,
            reviewerProvenance: stripReviewTimingProvenanceTimestamps(state.reviewerProvenance),
            reviewResultRecordedAtUtc: state.reviewResultRecordedAtUtc,
            recordedAtUtc: state.recordedAtUtc,
            reviewOutputSourceMtimeUtc: state.reviewOutputSourceMtimeUtc,
            strictReusedReviewRecordedDetails,
            timelineEvents,
            latestCompileSequence
        });
        return timingTrust.trusted ? null : timingTrust.message;
    });
}

function isReviewFailTokenViolation(state: ReviewArtifactState, violation: string): boolean {
    return Boolean(
        state.failed
        && state.failToken
        && violation.includes(`review artifact contains fail token '${state.failToken}'`)
    );
}

function isFailedReviewOutcomeViolation(state: ReviewArtifactState, violation: string): boolean {
    return isReviewFailTokenViolation(state, violation)
        || Boolean(
            state.failed
            && violation.includes('review artifact contains active findings in findings JSON')
        )
        || Boolean(
            state.failed
            && violation.includes('review findings validation artifact contains active findings')
        )
        || Boolean(
            state.failed
            && violation.includes('review findings validation artifact contains fix_now findings or residual risks')
        )
        || Boolean(
            state.failed
            && violation.includes('review findings validation artifact is rejected')
        );
}

export function reviewStateHasCurrentRecordedEvidence(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    return withNextStepReviewEvidenceSnapshot(eventsRoot, taskId, () => {
        if (!state.contextExists || !state.artifactExists || !state.receiptExists) {
            return false;
        }
        const nonVerdictViolations = state.violations.filter(
            (violation) => !isFailedReviewOutcomeViolation(state, violation)
        );
        if (nonVerdictViolations.length > 0) {
            return false;
        }
        if (getHiddenReviewTimingTrustRemediation(eventsRoot, taskId, state)) {
            return false;
        }
        if (state.reusedExistingReview) {
            return timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state);
        }
        if (state.domainScopeCurrent && !state.contextCurrent && !state.failed) {
            return false;
        }
        return timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot, taskId, state);
    });
}

export function findStrictSequentialUpstreamNeedingCurrentCycleReuse(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    targetReviewType: string;
    requiredReviews: Record<string, boolean>;
    policyMode: EffectiveReviewExecutionPolicyMode;
    reviewStates: readonly ReviewArtifactState[];
    latestCompileSequence?: number | null;
}): { upstreamState: ReviewArtifactState; upstreamReviewType: string; latestCompileSequence: number } | null {
    return withNextStepReviewEvidenceSnapshot(params.eventsRoot, params.taskId, () => {
    if (params.policyMode !== 'strict_sequential') {
        return null;
    }
    const latestCompileSequence = params.latestCompileSequence ?? getLatestTaskSequenceForEventTypes(
        params.eventsRoot,
        params.taskId,
        ['COMPILE_GATE_PASSED']
    );
    if (latestCompileSequence == null) {
        return null;
    }
    const timelineEvents = readTaskTimelineEventLikes(params.eventsRoot, params.taskId);
    const stateByReviewType = new Map(params.reviewStates.map((state) => [state.reviewType, state]));
    const upstreamReviewTypes = getReviewExecutionDependencies(
        params.targetReviewType,
        params.requiredReviews,
        params.policyMode
    );
    for (const upstreamReviewType of upstreamReviewTypes) {
        const upstreamState = stateByReviewType.get(upstreamReviewType);
        if (
            !upstreamState?.ready
            || !upstreamState.domainScopeCurrent
            || upstreamState.failed
        ) {
            continue;
        }
        if (
            upstreamState.reusedExistingReview
            && timelineHasReviewReuseRecordedAfterCompile(params.eventsRoot, params.taskId, upstreamState)
        ) {
            continue;
        }
        const upstreamSatisfiedEvidence = reviewStateHasSatisfiedEvidence(
            params.repoRoot,
            params.eventsRoot,
            params.taskId,
            upstreamState
        );
        if (params.targetReviewType === 'test' && upstreamSatisfiedEvidence) {
            continue;
        }
        const upstreamRecordedSequence = getLatestReviewEventSequence(
            timelineEvents,
            'REVIEW_RECORDED',
            upstreamReviewType
        );
        if (
            !upstreamState.reusedExistingReview
            && upstreamRecordedSequence != null
            && upstreamRecordedSequence > latestCompileSequence
        ) {
            continue;
        }
        if (!upstreamState.reusedExistingReview && upstreamState.contextCurrent) {
            continue;
        }
        if (!upstreamState.reusedExistingReview && !upstreamSatisfiedEvidence) {
            continue;
        }
        return {
            upstreamState,
            upstreamReviewType,
            latestCompileSequence
        };
    }
    return null;
    });
}

export function findReviewGateStaleUpstreamRecovery(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    requiredReviewTypes: string[];
    requiredReviews: Record<string, boolean>;
    policyMode: EffectiveReviewExecutionPolicyMode;
    reviewStates: readonly ReviewArtifactState[];
}): { downstreamReviewType: string; upstreamState: ReviewArtifactState; upstreamReviewType: string; latestReviewGateFailureSequence: number } | null {
    return withNextStepReviewEvidenceSnapshot(params.eventsRoot, params.taskId, () => {
    const latestReviewGateFailureSequence = getLatestTaskSequenceForEventTypes(
        params.eventsRoot,
        params.taskId,
        ['REVIEW_GATE_FAILED']
    );
    if (latestReviewGateFailureSequence == null) {
        return null;
    }
    const latestReviewGatePassSequence = getLatestTaskSequenceForEventTypes(
        params.eventsRoot,
        params.taskId,
        ['REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE']
    );
    if (latestReviewGatePassSequence != null && latestReviewGatePassSequence > latestReviewGateFailureSequence) {
        return null;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(
        params.eventsRoot,
        params.taskId,
        ['COMPILE_GATE_PASSED']
    );
    if (latestCompileSequence == null || latestReviewGateFailureSequence <= latestCompileSequence) {
        return null;
    }
    if (latestReviewGateFailureIsAuthorshipAttestationOnly(
        params.eventsRoot,
        params.taskId,
        latestReviewGateFailureSequence
    )) {
        return null;
    }
    const timelineEvents = readTaskTimelineEventLikes(params.eventsRoot, params.taskId);
    const stateByReviewType = new Map(params.reviewStates.map((state) => [state.reviewType, state]));
    for (const downstreamReviewType of params.requiredReviewTypes) {
        const downstreamState = stateByReviewType.get(downstreamReviewType);
        if (!downstreamState || !reviewStateHasSatisfiedEvidence(params.repoRoot, params.eventsRoot, params.taskId, downstreamState)) {
            continue;
        }
        const upstreamReviewTypes = getReviewExecutionDependencies(
            downstreamReviewType,
            params.requiredReviews,
            params.policyMode
        );
        for (const upstreamReviewType of upstreamReviewTypes) {
            const upstreamState = stateByReviewType.get(upstreamReviewType);
            if (
                !upstreamState
                || !upstreamState.ready
                || !upstreamState.domainScopeCurrent
                || upstreamState.reusedExistingReview
                || !reviewStateHasSatisfiedEvidence(params.repoRoot, params.eventsRoot, params.taskId, upstreamState)
            ) {
                continue;
            }
            const acceptedContextSequence = getLatestReviewContextReuseAcceptedSequence(
                timelineEvents,
                upstreamState
            );
            if (
                acceptedContextSequence != null
                && acceptedContextSequence > latestReviewGateFailureSequence
            ) {
                continue;
            }
            return {
                downstreamReviewType,
                upstreamState,
                upstreamReviewType,
                latestReviewGateFailureSequence
            };
        }
    }
    return null;
    });
}

export function findReviewGateStaleContextPrecheckRecovery(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    requiredReviewTypes: string[];
    reviewStates: readonly ReviewArtifactState[];
}): { state: ReviewArtifactState; reviewType: string } | null {
    return withNextStepReviewEvidenceSnapshot(params.eventsRoot, params.taskId, () => {
    const stateByReviewType = new Map(params.reviewStates.map((state) => [state.reviewType, state]));
    for (const reviewType of params.requiredReviewTypes) {
        const state = stateByReviewType.get(reviewType);
        if (
            !state?.ready
            || !state.contextExists
            || !state.domainScopeCurrent
            || state.failed
        ) {
            continue;
        }
        if (reviewStateHasSatisfiedEvidence(params.repoRoot, params.eventsRoot, params.taskId, state)) {
            continue;
        }
        return { state, reviewType };
    }
    return null;
    });
}

export function findDownstreamReviewNeedingDependencyRebind(params: {
    eventsRoot: string;
    taskId: string;
    requiredReviewTypes: string[];
    requiredReviews: Record<string, boolean>;
    policyMode: EffectiveReviewExecutionPolicyMode;
    reviewStates: readonly ReviewArtifactState[];
}): { downstreamState: ReviewArtifactState; upstreamReviewType: string } | null {
    return withNextStepReviewEvidenceSnapshot(params.eventsRoot, params.taskId, () => {
    const timelineEvents = readTaskTimelineEventLikes(params.eventsRoot, params.taskId);
    if (timelineEvents.length === 0) {
        return null;
    }
    const stateByReviewType = new Map(params.reviewStates.map((state) => [state.reviewType, state]));
    for (const reviewType of params.requiredReviewTypes) {
        const downstreamState = stateByReviewType.get(reviewType);
        if (!downstreamState?.ready || !downstreamState.contextExists) {
            continue;
        }
        const downstreamRebindSequence = getLatestDownstreamReviewRebindSequence(timelineEvents, downstreamState);
        if (downstreamRebindSequence == null) {
            continue;
        }
        const upstreamReviewTypes = getReviewExecutionDependencies(
            reviewType,
            params.requiredReviews,
            params.policyMode
        );
        for (const upstreamReviewType of upstreamReviewTypes) {
            const upstreamRecordedSequence = getLatestReviewEventSequence(timelineEvents, 'REVIEW_RECORDED', upstreamReviewType);
            if (upstreamRecordedSequence != null && upstreamRecordedSequence > downstreamRebindSequence) {
                return { downstreamState, upstreamReviewType };
            }
        }
    }
    return null;
    });
}

function getLatestDownstreamReviewRebindSequence(
    timelineEvents: readonly ReviewReuseTelemetryEventLike[],
    state: ReviewArtifactState
): number | null {
    const reviewPhaseSequence = getLatestReviewEventSequence(timelineEvents, 'REVIEW_PHASE_STARTED', state.reviewType);
    const reuseAcceptedSequence = getLatestReviewContextReuseAcceptedSequence(timelineEvents, state);
    if (reviewPhaseSequence == null) {
        return reuseAcceptedSequence;
    }
    if (reuseAcceptedSequence == null) {
        return reviewPhaseSequence;
    }
    return Math.max(reviewPhaseSequence, reuseAcceptedSequence);
}

function getLatestReviewContextReuseAcceptedSequence(
    timelineEvents: readonly ReviewReuseTelemetryEventLike[],
    state: ReviewArtifactState
): number | null {
    const expectedContextPath = normalizePath(state.contextPath).toLowerCase();
    let latestSequence: number | null = null;
    for (const event of timelineEvents) {
        if (event.event_type !== 'REVIEW_CONTEXT_REUSE_ACCEPTED') {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventReviewType = String(details.review_type || details.reviewType || '').trim();
        if (eventReviewType !== state.reviewType || details.current_pass_review_evidence !== true) {
            continue;
        }
        const outputPath = normalizePath(
            details.output_path || details.outputPath || details.review_context_path || details.reviewContextPath || ''
        ).toLowerCase();
        if (!outputPath || outputPath !== expectedContextPath) {
            continue;
        }
        const sequence = getTimelineEventTaskSequence(event);
        if (sequence == null) {
            continue;
        }
        latestSequence = latestSequence == null
            ? sequence
            : Math.max(latestSequence, sequence);
    }
    return latestSequence;
}
