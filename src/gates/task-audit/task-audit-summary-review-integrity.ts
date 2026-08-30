import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeReviewReceiptReviewerProvenance } from '../../gate-runtime/review-context';
import {
    readReviewArtifactTextFile,
    withReviewArtifactReadBarrier
} from '../../gate-runtime/review-artifacts';
import { reviewerIdentityMatchesDelegatedLaunchCycle } from '../../gate-runtime/review/reviewer-identity-contract';
import {
    validateHistoricalReviewRecordedTelemetryEventMatch,
    validateStrictReusedReviewEvidence,
    type ReviewReuseTelemetryEventLike
} from '../review-reuse/review-reuse-telemetry';
import {
    collectEffectiveReviewTypeIds,
    collectKnownRequiredReviewTypes,
    collectUnsafeRequiredReviewTypeIssues,
    getCanonicalReviewContextPath,
    isPlainRecord,
    isSafeCanonicalArtifactPath,
    normalizeSha256Text,
    normalizeTrustToken,
    safeReadJson,
    safeReviewArtifactFileSha256
} from './task-audit-summary-review-common';
import { reviewReceiptMatchesCurrentReviewDomain, type FinalCloseoutReviewTrustSummary } from './task-audit-summary-review-trust';
import {
    getReviewLaneArtifactEvidenceViolations,
    isCustomReviewLaneInSnapshot
} from '../review-context/review-context-lane';

export interface FinalCloseoutReviewIntegrityAttestation {
    schema_version: 1;
    enforcement_mode: 'ADVISORY' | 'BLOCKING';
    status: 'INDEPENDENT_REVIEW_ATTESTED' | 'NO_REVIEW_REQUIRED' | 'DEGRADED_OR_UNVERIFIABLE';
    required_review_count: number;
    required_review_types: string[];
    independent_review_completed: boolean;
    completion_review_attested: boolean;
    completion_review_attestation_not_required: boolean;
    completion_allowed: boolean;
    fake_or_fallback_artifacts_observed: boolean; same_agent_fallback_observed: boolean;
    fallback_artifacts_observed: boolean; legacy_local_review_observed: boolean;
    missing_or_unverifiable_artifacts_observed: boolean; fabricated_artifacts_observed: boolean;
    observed_issues: string[]; reason: string; visible_summary_line: string; final_report_lines: string[];
}

function formatReviewIntegrityObservationLines(input: {
    fakeOrFallbackArtifactsObserved: boolean;
    sameAgentFallbackObserved: boolean;
    fallbackArtifactsObserved: boolean;
    legacyLocalReviewObserved: boolean;
    missingOrUnverifiableObserved: boolean;
    fabricatedArtifactsObserved: boolean;
}): string[] {
    return [
        `Fake/fallback artifacts observed: ${input.fakeOrFallbackArtifactsObserved ? 'yes' : 'no'}.`,
        `Same-agent fallback observed: ${input.sameAgentFallbackObserved ? 'yes' : 'no'}.`,
        `Fallback artifacts observed: ${input.fallbackArtifactsObserved ? 'yes' : 'no'}.`,
        `Legacy local review observed: ${input.legacyLocalReviewObserved ? 'yes' : 'no'}.`,
        `Missing/unverifiable artifacts observed: ${input.missingOrUnverifiableObserved ? 'yes' : 'no'}.`,
        `Fabricated artifacts observed: ${input.fabricatedArtifactsObserved ? 'yes' : 'no'}.`
    ];
}

function reviewLooksFabricated(content: string): boolean {
    const normalized = String(content || '');
    return /^\s*(?:this\s+is\s+)?(?:a\s+)?(?:fake|fabricated)\s+review[.!]?\s*$/imu.test(normalized) || /^\s*(?:obviously synthetic|placeholder review|todo review)\b/imu.test(normalized) || /\b(?:review output|review artifact)\s*:\s*(?:fake|fabricated|placeholder|todo)\b/iu.test(normalized);
}

function readEventTaskSequence(event: ReviewReuseTelemetryEventLike): number | null {
    const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
    const sequence = typeof integrity?.task_sequence === 'number'
        ? integrity.task_sequence
        : Number(integrity?.task_sequence);
    return Number.isInteger(sequence) ? sequence : null;
}

function findLatestEventTaskSequenceForTypes(
    events: readonly ReviewReuseTelemetryEventLike[] | undefined,
    eventTypes: readonly string[]
): number | null {
    if (!events) {
        return null;
    }
    const normalizedEventTypes = new Set(eventTypes.map((eventType) => eventType.trim().toUpperCase()));
    let latestSequence: number | null = null;
    for (const event of events) {
        if (!normalizedEventTypes.has(String(event.event_type || '').trim().toUpperCase())) {
            continue;
        }
        const sequence = readEventTaskSequence(event);
        if (sequence != null) {
            latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
        }
    }
    return latestSequence;
}

function findFreshReviewTelemetryIssue(options: {
    reviewType: string; repoRoot: string | null | undefined; taskId: string; events: readonly ReviewReuseTelemetryEventLike[] | undefined;
    latestCompileTaskSequence: number | null; latestReviewGateTaskSequence: number | null; receiptPath: string; receiptSha256: string; receipt: Record<string, unknown>;
    reviewContextSha256: string; reviewTreeStateSha256: string; reviewArtifactSha256: string; reviewerExecutionMode: string; reviewerIdentity: string; reviewerProvenance: Record<string, unknown> | null;
    allowDomainScopeTelemetryOmission?: boolean;
}): string | null {
    if (!options.repoRoot) {
        return `${options.reviewType}: fresh review evidence cannot be validated without repo root`;
    }
    if (!options.events) {
        return `${options.reviewType}: fresh review evidence cannot be validated without task timeline`;
    }
    if (options.latestCompileTaskSequence == null) {
        return `${options.reviewType}: fresh review evidence cannot locate current compile telemetry`;
    }
    if (options.latestReviewGateTaskSequence == null) {
        return `${options.reviewType}: fresh review evidence cannot locate current required-reviews gate telemetry`;
    }
    if (options.latestReviewGateTaskSequence <= options.latestCompileTaskSequence) {
        return `${options.reviewType}: current required-reviews gate telemetry is not after the current compile telemetry`;
    }
    let lastReason: string | null = null;
    for (const event of [...options.events].sort((left, right) =>
        (readEventTaskSequence(right) ?? 0) - (readEventTaskSequence(left) ?? 0)
    )) {
        if (String(event.event_type || '').trim().toUpperCase() !== 'REVIEW_RECORDED') {
            continue;
        }
        const taskSequence = readEventTaskSequence(event);
        if (taskSequence != null && taskSequence <= options.latestCompileTaskSequence) {
            continue;
        }
        if (taskSequence != null && taskSequence >= options.latestReviewGateTaskSequence) {
            return `${options.reviewType}: review recorded after current required-reviews gate`;
        }
        const match = validateHistoricalReviewRecordedTelemetryEventMatch({
            event,
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            receiptPath: options.receiptPath,
            receiptSha256: options.receiptSha256,
            reviewContextSha256: options.reviewContextSha256,
            reviewContextReuseSha256: normalizeSha256Text(options.receipt.review_context_reuse_sha256) || undefined,
            reviewTreeStateSha256: options.reviewTreeStateSha256 || undefined,
            reviewScopeSha256: options.allowDomainScopeTelemetryOmission
                ? undefined
                : normalizeSha256Text(options.receipt.review_scope_sha256) || undefined,
            codeScopeSha256: options.allowDomainScopeTelemetryOmission
                ? undefined
                : normalizeSha256Text(options.receipt.code_scope_sha256) || undefined,
            reviewArtifactSha256: options.reviewArtifactSha256,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: options.reviewerIdentity,
            reviewerProvenance: options.reviewerProvenance,
            maxTaskSequenceExclusive: options.latestReviewGateTaskSequence,
            verifyReceiptSnapshot: true
        });
        if (match.matched) {
            return findFreshReviewerInvocationTelemetryIssue({
                ...options,
                events: options.events,
                latestReviewRecordedTaskSequence: taskSequence
            });
        }
        if (match.reason && match.reason !== 'wrong_event_type') {
            lastReason = match.reason;
        }
    }
    return `${options.reviewType}: missing current-cycle REVIEW_RECORDED telemetry or snapshot binding` +
        `${lastReason ? ` (${lastReason})` : ''}`;
}

function findFreshReviewerInvocationTelemetryIssue(options: {
    reviewType: string; taskId: string; events: readonly ReviewReuseTelemetryEventLike[]; latestCompileTaskSequence: number | null; latestReviewRecordedTaskSequence: number | null;
    reviewerExecutionMode: string; reviewerIdentity: string; reviewContextSha256: string; reviewTreeStateSha256: string; reviewerProvenance: Record<string, unknown> | null;
}): string | null {
    const provenance = normalizeReviewReceiptReviewerProvenance(options.reviewerProvenance);
    if (!provenance || provenance.attestation_type !== 'reviewer_invocation_attestation') {
        return `${options.reviewType}: missing matching REVIEWER_INVOCATION_ATTESTED telemetry`;
    }
    const provenanceReviewContextSha256 = String(provenance.review_context_sha256 || '').trim().toLowerCase();
    if (
        provenance.task_id !== options.taskId
        || provenance.review_type !== options.reviewType
        || provenance.reviewer_execution_mode !== options.reviewerExecutionMode
        || provenance.reviewer_identity !== options.reviewerIdentity
        || !provenanceReviewContextSha256
        || (options.reviewTreeStateSha256 && provenance.review_tree_state_sha256 !== options.reviewTreeStateSha256)
    ) {
        return `${options.reviewType}: reviewer invocation provenance does not match receipt`;
    }
    for (const event of options.events) {
        if (String(event.event_type || '').trim().toUpperCase() !== 'REVIEWER_INVOCATION_ATTESTED') { continue; }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
        const taskSequence = readEventTaskSequence(event);
        if (taskSequence == null || taskSequence <= (options.latestCompileTaskSequence ?? 0) || (options.latestReviewRecordedTaskSequence != null && taskSequence >= options.latestReviewRecordedTaskSequence)) { continue; }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventReviewTreeStateSha256 = normalizeSha256Text(details.review_tree_state_sha256 ?? details.reviewTreeStateSha256);
        if (taskSequence === provenance.task_sequence && normalizeSha256Text(integrity.event_sha256) === provenance.event_sha256 && (integrity.prev_event_sha256 == null ? null : normalizeSha256Text(integrity.prev_event_sha256)) === provenance.prev_event_sha256 && String(details.task_id ?? details.taskId ?? '').trim() === options.taskId && String(details.review_type ?? details.reviewType ?? '').trim().toLowerCase() === options.reviewType && String(details.reviewer_execution_mode ?? details.reviewerExecutionMode ?? '').trim() === options.reviewerExecutionMode && String(details.reviewer_identity ?? details.reviewerIdentity ?? details.reviewer_session_id ?? details.reviewerSessionId ?? '').trim() === options.reviewerIdentity && normalizeSha256Text(details.review_context_sha256 ?? details.reviewContextSha256) === provenanceReviewContextSha256 && (!options.reviewTreeStateSha256 || eventReviewTreeStateSha256 === options.reviewTreeStateSha256) && normalizeSha256Text(details.routing_event_sha256 ?? details.routingEventSha256) === provenance.routing_event_sha256) { return null; }
    }
    return `${options.reviewType}: missing matching REVIEWER_INVOCATION_ATTESTED telemetry`;
}

function reviewIntegrityArtifactExists(reviewsRoot: string, taskId: string, reviewType: string): boolean {
    return fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`)) || fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}.md`)) || fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`));
}

function discoverReviewIntegrityObservationTypes(
    reviewsRoot: string,
    taskId: string,
    currentPreflight?: Record<string, unknown> | null
): string[] {
    return collectEffectiveReviewTypeIds(currentPreflight)
        .filter((reviewType) => reviewIntegrityArtifactExists(reviewsRoot, taskId, reviewType))
        .sort();
}

function collectReviewIntegrityIssues(options: {
    requiredReviewTypes: string[]; reviewsRoot: string; taskId: string; preflightSha256?: string | null;
    repoRoot?: string | null; currentPreflight?: Record<string, unknown> | null;
    timelineEvents?: readonly ReviewReuseTelemetryEventLike[]; strictVerification: boolean; initialIssues?: string[];
}): string[] {
    const issues: string[] = [...(options.initialIssues || [])];
    const expectedPreflightSha256 = String(options.preflightSha256 || '').trim().toLowerCase();
    const latestCompileTaskSequence = findLatestEventTaskSequenceForTypes(options.timelineEvents, ['COMPILE_GATE_PASSED']);
    const latestReviewGateTaskSequence = findLatestEventTaskSequenceForTypes(
        options.timelineEvents,
        ['REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE']
    );
    for (const reviewType of options.requiredReviewTypes) {
        const receiptPath = path.join(options.reviewsRoot, `${options.taskId}-${reviewType}-receipt.json`);
        const reviewPath = path.join(options.reviewsRoot, `${options.taskId}-${reviewType}.md`);
        const reviewContextPath = getCanonicalReviewContextPath(options.reviewsRoot, options.taskId, reviewType);
        const reviewContextPathSafe = isSafeCanonicalArtifactPath(reviewContextPath, options.reviewsRoot);
        const receipt = safeReadJson(receiptPath);
        const reviewExists = fs.existsSync(reviewPath) && fs.statSync(reviewPath).isFile();
        const receiptExists = fs.existsSync(receiptPath) && fs.statSync(receiptPath).isFile();
        const contextExists = fs.existsSync(reviewContextPath) && fs.statSync(reviewContextPath).isFile();
        let reviewContent = '';
        if (reviewExists) {
            try {
                reviewContent = readReviewArtifactTextFile(reviewPath);
            } catch {
                issues.push(`${reviewType}: review artifact changed or became unreadable during verification`);
            }
        }

        if (reviewExists && reviewLooksFabricated(reviewContent)) {
            issues.push(`${reviewType}: fabricated-looking review artifact content observed`);
        }
        if (!receipt || receipt.task_id !== options.taskId || receipt.review_type !== reviewType) {
            if (options.strictVerification || reviewExists || receiptExists || contextExists) {
                issues.push(`${reviewType}: missing or invalid review receipt`);
            }
            continue;
        }
        if (options.currentPreflight && isCustomReviewLaneInSnapshot(options.currentPreflight, reviewType)) {
            try {
                const laneEvidenceViolations = getReviewLaneArtifactEvidenceViolations({
                    artifact: receipt,
                    preflight: options.currentPreflight,
                    reviewType,
                    label: `Review receipt for '${reviewType}'`
                });
                issues.push(...laneEvidenceViolations.map((violation) => `${reviewType}: ${violation}`));
            } catch (error) {
                issues.push(
                    `${reviewType}: custom review lane binding cannot be validated: `
                    + (error instanceof Error ? error.message : String(error))
                );
            }
        }
        if (!reviewExists) {
            issues.push(`${reviewType}: missing review artifact`);
        }
        const receiptExecutionMode = String(receipt.reviewer_execution_mode || '').trim();
        const receiptReviewerIdentity = String(receipt.reviewer_identity || '').trim();
        const receiptFallbackReason = String(receipt.reviewer_fallback_reason || '').trim();
        const receiptTrustLevel = normalizeTrustToken(receipt.trust_level);
        const reusedExistingReview = receipt.reused_existing_review === true;
        const recordedReviewContextHash = String(receipt.review_context_sha256 || '').trim().toLowerCase();
        if (receiptExecutionMode === 'same_agent_fallback') {
            issues.push(`${reviewType}: same_agent_fallback review receipt observed`);
        } else if (receiptExecutionMode && receiptExecutionMode !== 'delegated_subagent') {
            issues.push(`${reviewType}: unverifiable reviewer execution mode '${receiptExecutionMode}'`);
        }
        if (!receiptReviewerIdentity) {
            issues.push(`${reviewType}: receipt omits reviewer identity`);
        } else if (receiptReviewerIdentity.startsWith('self:')) {
            issues.push(`${reviewType}: same_agent_fallback/self-scoped reviewer identity observed`);
        } else if (receiptExecutionMode === 'delegated_subagent' && !receiptReviewerIdentity.startsWith('agent:')) {
            issues.push(`${reviewType}: unverifiable reviewer identity '${receiptReviewerIdentity}'`);
        }
        if (receiptFallbackReason) {
            issues.push(`${reviewType}: fallback reason recorded on review receipt`);
        }
        if (receiptTrustLevel === 'LOCAL_ASSERTED' || receiptTrustLevel === 'LOCAL_AUDITED') {
            issues.push(`${reviewType}: legacy or local trust receipt '${receiptTrustLevel}' observed`);
        } else if (receiptTrustLevel !== 'INDEPENDENT_AUDITED') {
            issues.push(`${reviewType}: missing independent trust receipt`);
        }
        const provenance = receipt.reviewer_provenance == null
            ? null
            : normalizeReviewReceiptReviewerProvenance(receipt.reviewer_provenance);
        if (!provenance || provenance.attestation_type !== 'reviewer_invocation_attestation') {
            issues.push(`${reviewType}: missing independent reviewer invocation provenance`);
        } else {
            const provenanceTaskId = provenance.task_id;
            const provenanceReviewType = provenance.review_type;
            const provenanceExecutionMode = provenance.reviewer_execution_mode;
            const provenanceReviewerIdentity = provenance.reviewer_identity;
            const provenanceReviewContextHash = provenance.review_context_sha256;
            const reusedFromReviewContextHash = normalizeSha256Text(receipt.reused_from_review_context_sha256);
            const expectedProvenanceReviewContextHash = reusedExistingReview
                ? reusedFromReviewContextHash || recordedReviewContextHash
                : recordedReviewContextHash;
            if (reusedExistingReview && !reusedFromReviewContextHash) {
                issues.push(`${reviewType}: reused review receipt omits reused review context hash`);
            }
            if (provenanceTaskId !== options.taskId) {
                issues.push(`${reviewType}: reviewer provenance task id does not match receipt task`);
            }
            if (provenanceReviewType !== reviewType) {
                issues.push(`${reviewType}: reviewer provenance review type does not match receipt review type`);
            }
            if (provenanceExecutionMode !== receiptExecutionMode) {
                issues.push(`${reviewType}: reviewer provenance execution mode does not match receipt`);
            }
            if (provenanceReviewerIdentity !== receiptReviewerIdentity) {
                issues.push(`${reviewType}: reviewer provenance identity does not match receipt`);
            }
            if (!provenanceReviewerIdentity) {
                issues.push(`${reviewType}: reviewer provenance omits reviewer identity`);
            } else if (provenanceReviewerIdentity.startsWith('self:')) {
                issues.push(`${reviewType}: same_agent_fallback/self-scoped reviewer provenance observed`);
            }
            if (!provenanceReviewContextHash) {
                issues.push(`${reviewType}: reviewer provenance omits review context hash`);
            } else if (
                !reusedExistingReview
                && expectedProvenanceReviewContextHash
                && provenanceReviewContextHash !== expectedProvenanceReviewContextHash
            ) {
                const receiptReviewTreeStateHash = normalizeSha256Text(receipt.review_tree_state_sha256);
                const provenanceReviewTreeStateHash = normalizeSha256Text(provenance.review_tree_state_sha256);
                const invocationTimeContextBinding = receiptReviewTreeStateHash
                    && provenanceReviewTreeStateHash
                    && receiptReviewTreeStateHash === provenanceReviewTreeStateHash;
                if (!invocationTimeContextBinding) {
                    issues.push(`${reviewType}: reviewer provenance review context hash does not match receipt`);
                }
            }
        }
        const recordedReviewArtifactHash = String(receipt.review_artifact_sha256 || '').trim().toLowerCase();
        if (reviewExists && recordedReviewArtifactHash && safeReviewArtifactFileSha256(reviewPath) !== recordedReviewArtifactHash) {
            issues.push(`${reviewType}: review artifact hash does not match receipt`);
        }
        if (reviewExists && !recordedReviewArtifactHash) {
            issues.push(`${reviewType}: receipt omits review artifact hash`);
        }
        const recordedPreflightHash = String(receipt.preflight_sha256 || '').trim().toLowerCase();
        const preflightMismatchAcceptedByReviewDomain = !!expectedPreflightSha256
            && recordedPreflightHash !== expectedPreflightSha256
            && reviewReceiptMatchesCurrentReviewDomain(receipt as Record<string, unknown>, options.currentPreflight, options.repoRoot);
        if (
            expectedPreflightSha256
            && recordedPreflightHash !== expectedPreflightSha256
            && !preflightMismatchAcceptedByReviewDomain
        ) {
            issues.push(`${reviewType}: receipt preflight hash does not match current preflight`);
        }
        if (!recordedReviewContextHash) {
            issues.push(`${reviewType}: receipt omits review context hash`);
        } else if (!reviewContextPathSafe || !fs.existsSync(reviewContextPath) || safeReviewArtifactFileSha256(reviewContextPath) !== recordedReviewContextHash) {
            issues.push(`${reviewType}: review context hash is missing or does not match receipt`);
        }
        const reviewContext = reviewContextPathSafe ? safeReadJson(reviewContextPath) : null;
        const reviewContextTreeState = isPlainRecord(reviewContext?.tree_state)
            ? reviewContext?.tree_state as Record<string, unknown>
            : null;
        const reviewContextTreeStateHash = normalizeSha256Text(
            reviewContextTreeState?.tree_state_sha256 ?? reviewContextTreeState?.treeStateSha256
        );
        const receiptReviewTreeStateHash = normalizeSha256Text(receipt.review_tree_state_sha256);
        const reusedFromReviewTreeStateHash = normalizeSha256Text(receipt.reused_from_review_tree_state_sha256);
        if (reusedExistingReview) {
            if (!options.repoRoot) {
                issues.push(`${reviewType}: reused review evidence cannot be validated without repo root`);
            } else if (!options.timelineEvents) {
                issues.push(`${reviewType}: reused review evidence cannot be validated without task timeline`);
            } else {
                const strictReuseValidation = validateStrictReusedReviewEvidence({
                    repoRoot: options.repoRoot,
                    taskId: options.taskId,
                    reviewType,
                    events: options.timelineEvents,
                    receiptPath,
                    receiptSha256: safeReviewArtifactFileSha256(receiptPath),
                    reviewContextSha256: recordedReviewContextHash,
                    reviewContextReuseSha256: normalizeSha256Text(receipt.review_context_reuse_sha256),
                    reviewTreeStateSha256: receiptReviewTreeStateHash,
                    reviewScopeSha256: normalizeSha256Text(receipt.review_scope_sha256),
                    codeScopeSha256: normalizeSha256Text(receipt.code_scope_sha256),
                    reviewArtifactSha256: recordedReviewArtifactHash,
                    reusedFromReceiptPath: String(receipt.reused_from_receipt_path || '').trim() || null,
                    reusedFromReceiptSha256: normalizeSha256Text(receipt.reused_from_receipt_sha256),
                    reusedFromReviewContextSha256: normalizeSha256Text(receipt.reused_from_review_context_sha256),
                    reusedFromReviewContextReuseSha256: normalizeSha256Text(receipt.reused_from_review_context_reuse_sha256),
                    reusedFromReviewTreeStateSha256: reusedFromReviewTreeStateHash,
                    reusedFromReviewScopeSha256: normalizeSha256Text(receipt.reused_from_review_scope_sha256),
                    reusedFromCodeScopeSha256: normalizeSha256Text(receipt.reused_from_code_scope_sha256),
                    reviewerExecutionMode: receiptExecutionMode,
                    reviewerIdentity: receiptReviewerIdentity,
                    reviewerProvenance: isPlainRecord(receipt.reviewer_provenance) ? receipt.reviewer_provenance : null,
                    latestCompileTaskSequence
                });
                if (!strictReuseValidation.valid) {
                    issues.push(`${reviewType}: strict reused review evidence is invalid: ${strictReuseValidation.reason}`);
                } else if (
                    latestReviewGateTaskSequence == null
                    || strictReuseValidation.currentReuseEventTaskSequence >= latestReviewGateTaskSequence
                ) {
                    issues.push(`${reviewType}: reused review evidence was recorded after the current required-reviews gate`);
                }
            }
        } else {
            const telemetryIssue = findFreshReviewTelemetryIssue({
                reviewType,
                repoRoot: options.repoRoot,
                taskId: options.taskId,
                events: options.timelineEvents,
                latestCompileTaskSequence,
                latestReviewGateTaskSequence,
                receiptPath,
                receiptSha256: safeReviewArtifactFileSha256(receiptPath) || '',
                receipt: receipt as Record<string, unknown>,
                reviewContextSha256: recordedReviewContextHash,
                reviewTreeStateSha256: receiptReviewTreeStateHash,
                reviewArtifactSha256: recordedReviewArtifactHash,
                reviewerExecutionMode: receiptExecutionMode,
                reviewerIdentity: receiptReviewerIdentity,
                reviewerProvenance: isPlainRecord(receipt.reviewer_provenance) ? receipt.reviewer_provenance : null,
                allowDomainScopeTelemetryOmission: preflightMismatchAcceptedByReviewDomain
            });
            if (telemetryIssue) {
                issues.push(telemetryIssue);
            }
        }
        if (reviewContextTreeStateHash && !receiptReviewTreeStateHash) {
            issues.push(`${reviewType}: receipt omits review tree-state hash`);
        } else if (reviewContextTreeStateHash && receiptReviewTreeStateHash !== reviewContextTreeStateHash) {
            issues.push(`${reviewType}: receipt review tree-state hash does not match review context`);
        }
        if (reusedExistingReview && !reusedFromReviewTreeStateHash) {
            issues.push(`${reviewType}: reused review receipt omits reused review tree-state hash`);
        }
        if (provenance?.attestation_type === 'reviewer_invocation_attestation') {
            const expectedProvenanceReviewTreeStateHash = reusedExistingReview
                ? reusedFromReviewTreeStateHash || receiptReviewTreeStateHash || reviewContextTreeStateHash
                : receiptReviewTreeStateHash || reviewContextTreeStateHash;
            if (expectedProvenanceReviewTreeStateHash && !provenance.review_tree_state_sha256) {
                issues.push(`${reviewType}: reviewer provenance omits review tree-state hash`);
            } else if (
                expectedProvenanceReviewTreeStateHash
                && provenance.review_tree_state_sha256
                && provenance.review_tree_state_sha256 !== expectedProvenanceReviewTreeStateHash
            ) {
                issues.push(`${reviewType}: reviewer provenance review tree-state hash does not match receipt`);
            }
        }
        const reviewerRouting = isPlainRecord(reviewContext?.reviewer_routing)
            ? reviewContext?.reviewer_routing as Record<string, unknown>
            : null;
        if (!reviewerRouting) {
            issues.push(`${reviewType}: missing review context reviewer routing metadata`);
        } else if (reusedExistingReview) {
            // Reused reviews intentionally bind trust through historical receipt/provenance/reuse fields.
            // The current review-context can leave fresh launch routing fields empty for reuse evidence.
        } else {
            const contextExecutionMode = String(reviewerRouting.actual_execution_mode || '').trim();
            const contextReviewerSessionId = String(reviewerRouting.reviewer_session_id || '').trim();
            const contextFallbackReason = String(reviewerRouting.fallback_reason || '').trim();
            const contextDelegationRequired = reviewerRouting.delegation_required === true;
            const contextExpectedExecutionMode = String(reviewerRouting.expected_execution_mode || '').trim();
            const contextFallbackAllowed = reviewerRouting.fallback_allowed;
            const contextFallbackReasonRequired = reviewerRouting.fallback_reason_required;
            if (!contextExecutionMode) {
                issues.push(`${reviewType}: review context omits reviewer routing execution mode`);
            }
            if (!contextReviewerSessionId) {
                issues.push(`${reviewType}: review context omits reviewer routing identity`);
            }
            if (contextDelegationRequired !== true) {
                issues.push(`${reviewType}: review context does not require delegated reviewer routing`);
            }
            if (contextExpectedExecutionMode !== 'delegated_subagent') {
                issues.push(`${reviewType}: review context expected execution mode is not delegated_subagent`);
            }
            if (contextFallbackAllowed !== false || contextFallbackReasonRequired !== false) {
                issues.push(`${reviewType}: fallback-capable review context routing observed`);
            }
            if (contextExecutionMode === 'same_agent_fallback') {
                issues.push(`${reviewType}: same_agent_fallback review context routing observed`);
            } else if (contextExecutionMode && contextExecutionMode !== 'delegated_subagent') {
                issues.push(`${reviewType}: unverifiable review context execution mode '${contextExecutionMode}'`);
            }
            if (!reusedExistingReview && receiptExecutionMode && contextExecutionMode && receiptExecutionMode !== contextExecutionMode) {
                issues.push(`${reviewType}: review context execution mode does not match receipt`);
            }
            const launchBoundReviewerIdentity = provenance?.attestation_type === 'reviewer_invocation_attestation'
                ? provenance.reviewer_identity
                : '';
            const contextReviewerIdentityMatchesReceipt = contextReviewerSessionId === receiptReviewerIdentity || (
                !!launchBoundReviewerIdentity
                && reviewerIdentityMatchesDelegatedLaunchCycle({
                    observedIdentity: contextReviewerSessionId,
                    expectedIdentity: receiptReviewerIdentity,
                    taskId: options.taskId,
                    reviewType,
                    artifactResolvedReviewerIdentity: launchBoundReviewerIdentity
                })
            );
            if (
                !reusedExistingReview
                && contextReviewerSessionId
                && receiptReviewerIdentity
                && !contextReviewerIdentityMatchesReceipt
            ) {
                issues.push(`${reviewType}: review context reviewer identity does not match receipt`);
            }
            if (contextExecutionMode === 'delegated_subagent' && contextReviewerSessionId.startsWith('self:')) {
                issues.push(`${reviewType}: same_agent_fallback/self-scoped review context routing observed`);
            } else if (contextExecutionMode === 'delegated_subagent' && contextReviewerSessionId && !contextReviewerSessionId.startsWith('agent:')) {
                issues.push(`${reviewType}: unverifiable review context reviewer identity '${contextReviewerSessionId}'`);
            }
            if (reviewerRouting.fallback_allowed === true || reviewerRouting.fallback_reason_required === true || contextFallbackReason) {
                issues.push(`${reviewType}: fallback-capable review context routing observed`);
            }
        }
    }
    return [...new Set(issues)].sort((left, right) => left.localeCompare(right));
}

export function buildReviewIntegrityAttestation(options: {
    requiredReviews: Record<string, boolean>; reviewsRoot: string; taskId: string; scopeCategory: string | null; preflightSha256?: string | null;
    reviewTrustSummary: FinalCloseoutReviewTrustSummary | null; repoRoot?: string | null; currentPreflight?: Record<string, unknown> | null;
    timelineEvents?: readonly ReviewReuseTelemetryEventLike[]; initialIssues?: string[];
}): FinalCloseoutReviewIntegrityAttestation {
    return withReviewArtifactReadBarrier(options.reviewsRoot, () => buildReviewIntegrityAttestationUnlocked(options));
}

function buildReviewIntegrityAttestationUnlocked(options: {
    requiredReviews: Record<string, boolean>; reviewsRoot: string; taskId: string; scopeCategory: string | null; preflightSha256?: string | null;
    reviewTrustSummary: FinalCloseoutReviewTrustSummary | null; repoRoot?: string | null; currentPreflight?: Record<string, unknown> | null;
    timelineEvents?: readonly ReviewReuseTelemetryEventLike[]; initialIssues?: string[];
}): FinalCloseoutReviewIntegrityAttestation {
    const requiredReviewTypes = collectKnownRequiredReviewTypes(options.requiredReviews, options.currentPreflight);
    const unsafeRequiredReviewTypeIssues = collectUnsafeRequiredReviewTypeIssues(
        options.requiredReviews,
        options.currentPreflight
    );
    const rawRequiredReviewCount = Object.values(options.requiredReviews || {}).filter((required) => required === true).length;
    const requiredReviewCount = requiredReviewTypes.length;
    const observationReviewTypes = requiredReviewCount > 0
        ? requiredReviewTypes
        : discoverReviewIntegrityObservationTypes(options.reviewsRoot, options.taskId, options.currentPreflight);
    const independentReviewCompleted =
        options.reviewTrustSummary?.status === 'INDEPENDENT_AUDITED'
        && options.reviewTrustSummary.independent_review_attested === true;
    const strictVerification = requiredReviewCount > 0;
    const observedIssues = collectReviewIntegrityIssues({
        requiredReviewTypes: observationReviewTypes,
        reviewsRoot: options.reviewsRoot,
        taskId: options.taskId,
        preflightSha256: options.preflightSha256,
        repoRoot: options.repoRoot,
        currentPreflight: options.currentPreflight,
        timelineEvents: options.timelineEvents,
        strictVerification,
        initialIssues: [
            ...unsafeRequiredReviewTypeIssues,
            ...(options.initialIssues || [])
        ]
    });
    const issueText = observedIssues.join('\n').toLowerCase();
    const sameAgentFallbackObserved = issueText.includes('same_agent_fallback') || issueText.includes('self-scoped');
    const fallbackArtifactsObserved = sameAgentFallbackObserved || issueText.includes('fallback');
    const legacyLocalReviewObserved = issueText.includes('legacy or local trust') || issueText.includes('local_');
    const missingOrUnverifiableObserved =
        issueText.includes('missing')
        || issueText.includes('unverifiable')
        || issueText.includes('invalid')
        || issueText.includes('does not match')
        || issueText.includes('omits');
    const fabricatedArtifactsObserved = issueText.includes('fabricated-looking');
    const fakeOrFallbackObserved = fabricatedArtifactsObserved || fallbackArtifactsObserved;

    if (rawRequiredReviewCount === 0 && observedIssues.length === 0) {
        const reason = 'No mandatory review was required for this scope; completion is allowed but is not review-attested.';
        return {
            schema_version: 1,
            enforcement_mode: 'ADVISORY',
            status: 'NO_REVIEW_REQUIRED',
            required_review_count: 0,
            required_review_types: [],
            independent_review_completed: false,
            completion_review_attested: false,
            completion_review_attestation_not_required: true,
            completion_allowed: true,
            fake_or_fallback_artifacts_observed: fakeOrFallbackObserved,
            same_agent_fallback_observed: sameAgentFallbackObserved,
            fallback_artifacts_observed: fallbackArtifactsObserved,
            legacy_local_review_observed: legacyLocalReviewObserved,
            missing_or_unverifiable_artifacts_observed: missingOrUnverifiableObserved,
            fabricated_artifacts_observed: fabricatedArtifactsObserved,
            observed_issues: observedIssues,
            reason,
            visible_summary_line:
                'Review integrity: no mandatory review required; completion allowed without review attestation; ' +
                `fake/fallback/unverifiable artifacts observed=${observedIssues.length > 0 ? 'yes' : 'no'}; enforcement=advisory.`,
            final_report_lines: [
                'Review integrity: no mandatory independent review was required for this scope.',
                'Review integrity enforcement: advisory; this summary reports trust state but does not apply completion blocking.',
                'Independent review completed: not required.',
                'Completion review-attested: no (not required).',
                ...formatReviewIntegrityObservationLines({
                    fakeOrFallbackArtifactsObserved: fakeOrFallbackObserved,
                    sameAgentFallbackObserved,
                    fallbackArtifactsObserved,
                    legacyLocalReviewObserved,
                    missingOrUnverifiableObserved,
                    fabricatedArtifactsObserved
                }),
                `Completion allowed: yes. Reason: ${reason}`
            ]
        };
    }

    const completionReviewAttested = independentReviewCompleted && observedIssues.length === 0;
    const blockingEnforcementRequired = rawRequiredReviewCount > 0;
    const completionAllowed = !blockingEnforcementRequired || completionReviewAttested;
    const enforcementMode = blockingEnforcementRequired ? 'BLOCKING' : 'ADVISORY';
    const status = completionReviewAttested ? 'INDEPENDENT_REVIEW_ATTESTED' : 'DEGRADED_OR_UNVERIFIABLE';
    const reason = completionReviewAttested
        ? 'All mandatory reviews are independently audited and no fake, fallback, legacy, missing, fabricated, or unverifiable review artifacts were observed.'
        : blockingEnforcementRequired
            ? 'Mandatory review trust is degraded or unverifiable; final closeout is blocked until independent review evidence is current, hash-bound, and telemetry-bound.'
            : 'Review evidence is degraded or unverifiable, but no mandatory review was required for this scope; completion is allowed without review attestation.';
    return {
        schema_version: 1,
        enforcement_mode: enforcementMode,
        status,
        required_review_count: requiredReviewCount,
        required_review_types: requiredReviewTypes,
        independent_review_completed: independentReviewCompleted,
        completion_review_attested: completionReviewAttested,
        completion_review_attestation_not_required: false,
        completion_allowed: completionAllowed,
        fake_or_fallback_artifacts_observed: fakeOrFallbackObserved,
        same_agent_fallback_observed: sameAgentFallbackObserved,
        fallback_artifacts_observed: fallbackArtifactsObserved,
        legacy_local_review_observed: legacyLocalReviewObserved,
        missing_or_unverifiable_artifacts_observed: missingOrUnverifiableObserved,
        fabricated_artifacts_observed: fabricatedArtifactsObserved,
        observed_issues: observedIssues,
        reason,
        visible_summary_line:
            `Review integrity: ${status}; independent_review_completed=${independentReviewCompleted ? 'yes' : 'no'}; ` +
            `completion_review_attested=${completionReviewAttested ? 'yes' : 'no'}; ` +
            `completion_allowed=${completionAllowed ? 'yes' : 'no'}; fake/fallback/unverifiable artifacts observed=${observedIssues.length > 0 ? 'yes' : 'no'}; ` +
            `enforcement=${enforcementMode.toLowerCase()}.`,
        final_report_lines: [
            `Review integrity: ${status}.`,
            completionAllowed
                ? `Review integrity enforcement: ${enforcementMode.toLowerCase()}; this summary reports trust state without blocking final closeout for this scope.`
                : 'Review integrity enforcement: blocking; final closeout is blocked until mandatory review trust is independently attested.',
            `Independent review completed: ${independentReviewCompleted ? 'yes' : 'no'}.`,
            `Completion review-attested: ${completionReviewAttested ? 'yes' : 'no'}.`,
            ...formatReviewIntegrityObservationLines({
                fakeOrFallbackArtifactsObserved: fakeOrFallbackObserved,
                sameAgentFallbackObserved,
                fallbackArtifactsObserved,
                legacyLocalReviewObserved,
                missingOrUnverifiableObserved,
                fabricatedArtifactsObserved
            }),
            `Completion allowed: ${completionAllowed ? 'yes' : 'no'}. Reason: ${reason}`
        ]
    };
}

function stringArrayField(source: Record<string, unknown>, field: string): string[] {
    const value = source[field];
    return Array.isArray(value)
        ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
}

export function collectReviewAuthorshipAttestationIssues(
    reviewGate: Record<string, unknown> | null,
    requiredReviews: Record<string, boolean>,
    currentPreflight?: Record<string, unknown> | null
): string[] {
    const requiredReviewTypes = collectKnownRequiredReviewTypes(requiredReviews, currentPreflight);
    if (requiredReviewTypes.length === 0) {
        return [];
    }
    const attestation = isPlainRecord(reviewGate?.review_authorship_attestation)
        ? reviewGate.review_authorship_attestation as Record<string, unknown>
        : null;
    if (!attestation) {
        return [
            `review authorship attestation missing for required review lanes: ${requiredReviewTypes.join(', ')}`
        ];
    }
    const status = normalizeTrustToken(attestation.status);
    const issues = new Set<string>();
    const attestationValues = isPlainRecord(attestation.attestations)
        ? attestation.attestations as Record<string, unknown>
        : {};
    const requiredTypeSet = new Set(requiredReviewTypes);
    const derivedMissingTypes: string[] = [];
    const derivedFalseTypes: string[] = [];
    const derivedNonBooleanTypes: string[] = [];
    const derivedUnknownTypes = Object.keys(attestationValues)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry && !requiredTypeSet.has(entry));
    for (const reviewType of requiredReviewTypes) {
        if (!Object.hasOwn(attestationValues, reviewType)) {
            derivedMissingTypes.push(reviewType);
            continue;
        }
        const value = attestationValues[reviewType];
        if (value === false) {
            derivedFalseTypes.push(reviewType);
        } else if (value !== true) {
            derivedNonBooleanTypes.push(reviewType);
        }
    }
    const falseTypes = stringArrayField(attestation, 'false_review_types');
    const missingTypes = stringArrayField(attestation, 'missing_review_types');
    const unknownTypes = stringArrayField(attestation, 'unknown_review_types');
    const nonBooleanTypes = stringArrayField(attestation, 'non_boolean_review_types');
    const hasDerivedIssues =
        derivedMissingTypes.length > 0 ||
        derivedFalseTypes.length > 0 ||
        derivedNonBooleanTypes.length > 0 ||
        derivedUnknownTypes.length > 0;
    if (status === 'PASSED' && hasDerivedIssues) {
        issues.add('review authorship attestation status is PASSED but the payload does not cover current required review lanes');
    } else if (status === 'MISSING') {
        const missingReviewList = missingTypes.length > 0 ? missingTypes.join(', ') : requiredReviewTypes.join(', ');
        issues.add(`review authorship attestation missing for required review lanes: ${missingReviewList}`);
    } else if (status !== 'PASSED') {
        issues.add(`review authorship attestation status is ${status || 'UNKNOWN'}`);
    }
    for (const reviewType of [...new Set([...falseTypes, ...derivedFalseTypes])]) {
        issues.add(`${reviewType}: review authorship attestation is false; delegated reviewer authorship is not honestly attested`);
    }
    for (const reviewType of [...new Set([...missingTypes, ...derivedMissingTypes])]) {
        issues.add(`${reviewType}: review authorship attestation is missing`);
    }
    for (const reviewType of [...new Set([...unknownTypes, ...derivedUnknownTypes])]) {
        issues.add(`${reviewType}: review authorship attestation contains an unknown review type`);
    }
    for (const reviewType of [...new Set([...nonBooleanTypes, ...derivedNonBooleanTypes])]) {
        issues.add(`${reviewType}: review authorship attestation value is not boolean`);
    }
    for (const violation of stringArrayField(attestation, 'violations')) {
        issues.add(`review authorship attestation violation: ${violation}`);
    }
    return [...issues].sort((left, right) => left.localeCompare(right));
}
