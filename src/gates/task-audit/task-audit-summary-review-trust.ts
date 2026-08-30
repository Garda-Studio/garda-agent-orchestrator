import * as fs from 'node:fs';
import * as path from 'node:path';
import { withReviewArtifactReadBarrier } from '../../gate-runtime/review-artifacts';
import { buildReviewTrustSummary, type ReviewTrustSummary } from '../review/review-trust-summary';
import { computeReviewRelevantScopeFingerprint } from '../review-reuse';
import {
    buildDomainScopeFingerprints,
    getReviewLaneScopeSha256,
    normalizeDomainScopeFingerprints
} from '../scope/domain-scope-fingerprints';
import {
    REVIEW_TRUST_COMPATIBILITY_TYPES,
    collectKnownRequiredReviewTypes,
    getCanonicalReviewContextPath,
    isPlainRecord,
    isSafeCanonicalArtifactPath,
    normalizeSha256Text,
    normalizeTrustToken,
    safeReadJson,
    safeReviewArtifactFileSha256
} from './task-audit-summary-review-common';
import {
    getReviewLaneArtifactEvidenceViolations,
    isCustomReviewLaneInSnapshot
} from '../review-context/review-context-lane';

export interface FinalCloseoutReviewTrustSummary extends ReviewTrustSummary {}

function reviewGateMatchesCurrentCycle(
    reviewGate: Record<string, unknown>,
    taskId: string,
    preflightSha256?: string | null
): boolean {
    if (String(reviewGate.task_id || '').trim() !== taskId) {
        return false;
    }
    if (
        normalizeTrustToken(reviewGate.status) !== 'PASSED'
        || normalizeTrustToken(reviewGate.outcome) !== 'PASS'
    ) {
        return false;
    }

    const expectedPreflightSha256 = String(preflightSha256 || '').trim().toLowerCase();
    if (!expectedPreflightSha256) {
        return true;
    }

    return String(reviewGate.preflight_hash_sha256 || '').trim().toLowerCase() === expectedPreflightSha256;
}

function reviewGateCheckIsIndependent(check: Record<string, unknown>): boolean {
    const routingPolicy = isPlainRecord(check.reviewer_routing_policy)
        ? check.reviewer_routing_policy
        : null;
    const reviewerIdentity = String(check.reviewer_identity || '').trim();

    return check.required === true
        && check.skipped_by_override !== true
        && check.receipt_valid === true
        && normalizeTrustToken(check.trust_level) === 'INDEPENDENT_AUDITED'
        && String(check.reviewer_execution_mode || '').trim() === 'delegated_subagent'
        && reviewerIdentity.startsWith('agent:')
        && !String(check.reviewer_fallback_reason || '').trim()
        && !!routingPolicy
        && (
            routingPolicy.delegation_required === true
            && String(routingPolicy.expected_execution_mode || '').trim() === 'delegated_subagent'
            && routingPolicy.fallback_allowed === false
            && routingPolicy.fallback_reason_required === false
        );
}

export function readReviewTrustSummaryFromReviewGate(
    reviewGate: Record<string, unknown> | null,
    requiredReviews: Record<string, boolean>,
    taskId: string,
    scopeCategory: string | null,
    preflightSha256?: string | null,
    currentPreflight?: Record<string, unknown> | null,
    reviewsRoot?: string | null
): FinalCloseoutReviewTrustSummary | null {
    const requiredReviewTypes = collectKnownRequiredReviewTypes(requiredReviews, currentPreflight);
    if (requiredReviewTypes.length === 0 || !reviewGateMatchesCurrentCycle(reviewGate || {}, taskId, preflightSha256)) {
        return null;
    }

    const reviewGateRequiredReviews = isPlainRecord(reviewGate?.required_reviews)
        ? reviewGate.required_reviews
        : null;
    const reviewChecks = isPlainRecord(reviewGate?.review_checks)
        ? reviewGate.review_checks
        : null;
    if (!reviewGateRequiredReviews || !reviewChecks) {
        return null;
    }

    const executionModes = new Set<string>();
    let reusedCount = 0;
    let freshCount = 0;
    for (const reviewType of requiredReviewTypes) {
        if (reviewGateRequiredReviews[reviewType] !== true) {
            return null;
        }
        const check = isPlainRecord(reviewChecks[reviewType])
            ? reviewChecks[reviewType] as Record<string, unknown>
            : null;
        if (!check || !reviewGateCheckIsIndependent(check)) {
            return null;
        }
        if (currentPreflight && isCustomReviewLaneInSnapshot(currentPreflight, reviewType)) {
            if (!reviewsRoot) {
                return null;
            }
            const receipt = safeReadJson(path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`));
            if (!receipt || receipt.task_id !== taskId || receipt.review_type !== reviewType) {
                return null;
            }
            try {
                if (getReviewLaneArtifactEvidenceViolations({
                    artifact: receipt,
                    preflight: currentPreflight,
                    reviewType,
                    label: `Review receipt for '${reviewType}'`
                }).length > 0) {
                    return null;
                }
            } catch {
                return null;
            }
        }
        if (check.reused_existing_review === true) {
            reusedCount++;
        } else {
            freshCount++;
        }
        executionModes.add('DELEGATED_SUBAGENT');
    }

    const scopeLabel = String(scopeCategory || '').trim() ? `${String(scopeCategory).trim()} task` : 'task';
    const formattedModes = [...executionModes].sort().join(', ') || 'unknown execution mode';
    const reuseSuffix = reusedCount > 0
        ? (freshCount > 0 ? ` (REUSED: ${reusedCount}, FRESH: ${freshCount})` : ' (REUSED)')
        : '';
    return {
        status: 'INDEPENDENT_AUDITED',
        trust_levels: ['INDEPENDENT_AUDITED'],
        execution_modes: [...executionModes].sort(),
        independent_review_attested: true,
        reused_count: reusedCount,
        fresh_count: freshCount,
        completion_policy: 'INDEPENDENT_REVIEW_ATTESTED',
        visible_summary_line:
            `Review trust: INDEPENDENT_AUDITED${reuseSuffix} via ${formattedModes}; ` +
            'independent reviewer launch attested.',
        policy_summary_line:
            `Review policy: independent reviewer launch attestation satisfies mandatory review for this ${scopeLabel}.`
    };
}

export function buildUnavailableRequiredReviewTrustSummary(
    requiredReviews: Record<string, boolean>,
    scopeCategory: string | null
): FinalCloseoutReviewTrustSummary | null {
    const requiredReviewCount = Object.values(requiredReviews).filter((value) => value === true).length;
    return buildReviewTrustSummary([], scopeCategory, requiredReviewCount);
}

export function readReviewTrustSummary(
    requiredReviews: Record<string, boolean>,
    reviewsRoot: string,
    taskId: string,
    scopeCategory: string | null,
    preflightSha256?: string | null,
    currentPreflight?: Record<string, unknown> | null,
    repoRoot?: string | null
): FinalCloseoutReviewTrustSummary | null {
    return withReviewArtifactReadBarrier(reviewsRoot, () => readReviewTrustSummaryUnlocked(
        requiredReviews,
        reviewsRoot,
        taskId,
        scopeCategory,
        preflightSha256,
        currentPreflight,
        repoRoot
    ));
}

function readReviewTrustSummaryUnlocked(
    requiredReviews: Record<string, boolean>,
    reviewsRoot: string,
    taskId: string,
    scopeCategory: string | null,
    preflightSha256?: string | null,
    currentPreflight?: Record<string, unknown> | null,
    repoRoot?: string | null
): FinalCloseoutReviewTrustSummary | null {
    const requiredReviewTypes = collectKnownRequiredReviewTypes(requiredReviews, currentPreflight);
    const compatibilityFallbackActive = requiredReviewTypes.length === 0;
    const compatibilityReviewTypes = requiredReviewTypes.length > 0
        ? requiredReviewTypes
        : REVIEW_TRUST_COMPATIBILITY_TYPES.filter((reviewType) => (
            fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`))
            || fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}.md`))
            || fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`))
        ));
    const entries = compatibilityReviewTypes.flatMap((reviewType) => {
        const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
        const reviewPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
        const reviewContextPath = getCanonicalReviewContextPath(reviewsRoot, taskId, reviewType);
        const receipt = safeReadJson(receiptPath);
        if (!receipt || receipt.task_id !== taskId || receipt.review_type !== reviewType) {
            return [];
        }
        if (currentPreflight && isCustomReviewLaneInSnapshot(currentPreflight, reviewType)) {
            try {
                if (getReviewLaneArtifactEvidenceViolations({
                    artifact: receipt,
                    preflight: currentPreflight,
                    reviewType,
                    label: `Review receipt for '${reviewType}'`
                }).length > 0) {
                    return [];
                }
            } catch {
                return [];
            }
        }
        if (!fs.existsSync(reviewPath)) {
            return [];
        }
        const actualReviewArtifactHash = safeReviewArtifactFileSha256(reviewPath);
        const recordedReviewArtifactHash = typeof receipt.review_artifact_sha256 === 'string'
            ? receipt.review_artifact_sha256.trim().toLowerCase()
            : '';
        if (!actualReviewArtifactHash) {
            return [];
        }
        if (!recordedReviewArtifactHash && !compatibilityFallbackActive) {
            return [];
        }
        if (recordedReviewArtifactHash && recordedReviewArtifactHash !== actualReviewArtifactHash) {
            return [];
        }
        const expectedPreflightHash = typeof preflightSha256 === 'string'
            ? preflightSha256.trim().toLowerCase()
            : '';
        const recordedPreflightHash = typeof receipt.preflight_sha256 === 'string'
            ? receipt.preflight_sha256.trim().toLowerCase()
            : '';
        if (
            expectedPreflightHash
            && (!recordedPreflightHash || recordedPreflightHash !== expectedPreflightHash)
            && !reviewReceiptMatchesCurrentReviewDomain(receipt, currentPreflight, repoRoot)
        ) {
            return [];
        }
        const recordedReviewContextHash = typeof receipt.review_context_sha256 === 'string'
            ? receipt.review_context_sha256.trim().toLowerCase()
            : '';
        let contextFallbackReasonRequired: boolean | null = null;
        if (expectedPreflightHash && !recordedReviewContextHash) {
            return [];
        }
        if (recordedReviewContextHash) {
            const actualReviewContextHash = fs.existsSync(reviewContextPath) && isSafeCanonicalArtifactPath(reviewContextPath, reviewsRoot)
                ? safeReviewArtifactFileSha256(reviewContextPath)
                : null;
            if (!actualReviewContextHash || recordedReviewContextHash !== actualReviewContextHash) {
                return [];
            }
            const reviewContext = safeReadJson(reviewContextPath);
            const reviewerRouting = reviewContext && typeof reviewContext.reviewer_routing === 'object'
                ? reviewContext.reviewer_routing as Record<string, unknown>
                : null;
            const contextExecutionMode = reviewerRouting && typeof reviewerRouting.actual_execution_mode === 'string'
                ? reviewerRouting.actual_execution_mode.trim()
                : '';
            const contextReviewerSessionId = reviewerRouting && typeof reviewerRouting.reviewer_session_id === 'string'
                ? reviewerRouting.reviewer_session_id.trim()
                : '';
            const contextFallbackReason = reviewerRouting && typeof reviewerRouting.fallback_reason === 'string'
                ? reviewerRouting.fallback_reason.trim()
                : '';
            const contextCapabilityLevel = reviewerRouting && typeof reviewerRouting.capability_level === 'string'
                ? reviewerRouting.capability_level.trim()
                : '';
            const contextDelegationRequired = reviewerRouting?.delegation_required === true;
            const contextExpectedExecutionMode = reviewerRouting && typeof reviewerRouting.expected_execution_mode === 'string'
                ? reviewerRouting.expected_execution_mode.trim()
                : '';
            const contextFallbackAllowed = reviewerRouting && typeof reviewerRouting.fallback_allowed === 'boolean'
                ? reviewerRouting.fallback_allowed
                : null;
            contextFallbackReasonRequired = reviewerRouting && typeof reviewerRouting.fallback_reason_required === 'boolean'
                ? reviewerRouting.fallback_reason_required
                : null;
            const invalidContextIdentityScope =
                contextExecutionMode !== 'delegated_subagent'
                || !contextReviewerSessionId.startsWith('agent:');
            const invalidContextPolicy =
                (contextDelegationRequired && contextExecutionMode !== 'delegated_subagent')
                || contextCapabilityLevel === 'single_agent_only'
                || contextExpectedExecutionMode === 'same_agent_fallback'
                || contextFallbackAllowed === true
                || contextFallbackReasonRequired === true
                || !!contextFallbackReason;
            const receiptExecutionMode = typeof receipt.reviewer_execution_mode === 'string'
                ? receipt.reviewer_execution_mode.trim()
                : '';
            const receiptReviewerIdentity = typeof receipt.reviewer_identity === 'string'
                ? receipt.reviewer_identity.trim()
                : '';
            const receiptFallbackReason = typeof receipt.reviewer_fallback_reason === 'string'
                ? receipt.reviewer_fallback_reason.trim()
                : '';
            if (
                !contextExecutionMode
                || !contextReviewerSessionId
                || invalidContextIdentityScope
                || invalidContextPolicy
            ) {
                return [];
            }
            if (receiptExecutionMode && receiptExecutionMode !== 'delegated_subagent') {
                return [];
            }
            if (receiptExecutionMode && receiptExecutionMode !== contextExecutionMode) {
                return [];
            }
            if (receiptReviewerIdentity && !receiptReviewerIdentity.startsWith('agent:')) {
                return [];
            }
            if (receiptReviewerIdentity && receiptReviewerIdentity !== contextReviewerSessionId) {
                return [];
            }
            if (receiptFallbackReason) {
                return [];
            }
        }
        return [{
            review_type: reviewType,
            trust_level: typeof receipt.trust_level === 'string' ? receipt.trust_level : null,
            reviewer_execution_mode: typeof receipt.reviewer_execution_mode === 'string' ? receipt.reviewer_execution_mode : null,
            reviewer_identity: typeof receipt.reviewer_identity === 'string' ? receipt.reviewer_identity : null,
            reviewer_fallback_reason: typeof receipt.reviewer_fallback_reason === 'string' ? receipt.reviewer_fallback_reason : null,
            reviewer_fallback_reason_required: contextFallbackReasonRequired,
            reviewer_provenance: receipt.reviewer_provenance ?? null,
            reused_existing_review: receipt.reused_existing_review === true
        }];
    });
    return buildReviewTrustSummary(entries, scopeCategory, compatibilityReviewTypes.length);
}

export function reviewReceiptMatchesCurrentReviewDomain(
    receipt: Record<string, unknown>,
    currentPreflight?: Record<string, unknown> | null,
    repoRoot?: string | null
): boolean {
    if (!currentPreflight || !repoRoot) {
        return false;
    }
    const reviewType = String(receipt.review_type || '').trim().toLowerCase();
    const storedDomainScopeFingerprints = normalizeDomainScopeFingerprints(receipt.domain_scope_fingerprints);
    if (storedDomainScopeFingerprints) {
        const currentDomainScopeFingerprints = buildDomainScopeFingerprints({
            repoRoot,
            detectionSource: String(currentPreflight.detection_source || 'git_auto'),
            includeUntracked: currentPreflight.include_untracked !== false,
            changedFiles: Array.isArray(currentPreflight.changed_files)
                ? currentPreflight.changed_files as string[]
                : []
        });
        const expectedLaneScopeSha256 = getReviewLaneScopeSha256(reviewType, storedDomainScopeFingerprints);
        const currentLaneScopeSha256 = getReviewLaneScopeSha256(reviewType, currentDomainScopeFingerprints);
        return !!expectedLaneScopeSha256
            && !!currentLaneScopeSha256
            && expectedLaneScopeSha256 === currentLaneScopeSha256;
    }
    const expectedReviewScopeSha256 = normalizeSha256Text(receipt.review_scope_sha256);
    if (!expectedReviewScopeSha256) {
        return false;
    }
    try {
        const currentReviewScopeSha256 = normalizeSha256Text(
            computeReviewRelevantScopeFingerprint(currentPreflight, repoRoot).review_scope_sha256
        );
        return !!currentReviewScopeSha256 && currentReviewScopeSha256 === expectedReviewScopeSha256;
    } catch {
        return false;
    }
}
