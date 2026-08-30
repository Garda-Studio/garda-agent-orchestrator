// Extracted from required-reviews-check.ts; keep behavior changes in the facade tests.
import * as path from 'node:path';

import { isPlainRecord } from '../../core/records';
import { REVIEW_TRIVIAL_OUTPUT_THRESHOLD_MESSAGE } from '../../core/orchestration-constants';
import {
    auditReviewArtifactCompaction,
    normalizeCompatibilityReviewerExecutionMode,
    type ReviewReceipt
} from '../../gate-runtime/review-context';
import { readReviewArtifactFileSha256 } from '../../gate-runtime/review-artifacts';
import {
    getReviewArtifactFindingsEvidence,
    getReviewFindingsEvidenceFromValidationArtifact,
    isTrivialReview
} from '../completion';
import { normalizePath, toPlainRecord } from '../shared/helpers';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations
} from '../review-context/review-context-contract';
import {
    resolvePersistedRemediationReviewExecutionAuthority
} from '../review-remediation/review-remediation-execution-authority';
import type { ReviewRemediationReviewContract } from '../review-remediation/review-remediation-review-contract';
import {
    getReviewLaneArtifactEvidenceViolations,
    isCustomReviewLaneInSnapshot
} from '../review-context/review-context-lane';
import { reviewContextLaneScopeMatchesCurrentPreflight } from '../scope/domain-scope-fingerprints';
import { resolveReviewContextRoutingIdentity } from '../review-context/review-context-routing';
import { resolveReviewerPromptArtifactBinding } from '../review/review-prompt-artifact';
import {
    assertReviewTreeStateFresh,
    type ReviewTreeStateFreshnessCache
} from '../review/review-tree-state';
import { type ReviewDependencyTimelineEvent } from '../review/review-dependencies';
import { validateStrictReusedReviewEvidence } from '../review-reuse/review-reuse-telemetry';
import { getMandatoryDelegatedReviewTrustViolation } from '../review/review-trust-policy';
import {
    getReviewReceiptExecutionEvidenceContractViolations,
    normalizeReviewReceiptEvidenceFields,
    type ReviewEvidenceReviewerProvenance
} from '../review/review-evidence-contract';
import {
    evaluateHiddenReviewTimingTrust,
    stripReviewTimingProvenanceTimestamps
} from '../review/review-timing-trust';
import { normalizeRuntimeIdentitySource, normalizeSourceOfTruthValue, resolveReviewerRoutingPolicy } from '../review/reviewer-routing';
import { reviewerIdentityMatchesDelegatedLaunchCycle } from '../../gate-runtime/review/reviewer-identity-contract';
import {
    reviewContextRequiresFindingsOnlyArtifact
} from '../review/review-findings-artifact-verdict';
import {
    getReviewCoverageValidationSummaryContractViolations,
    type ReviewCoverageContract
} from '../review/review-coverage-ledger';
import {
    validateReviewFindingsValidationArtifactForReceipt
} from '../review/review-findings-validation-artifact';
import {
    resolveLockedReviewFindingPolicyFromPreflight,
    resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence
} from '../review/review-finding-disposition';
import { validateReviewFindingsDispositionEvidence } from '../review/review-findings-disposition-evidence';
import {
    findLatestRoutingEventForReviewType,
    findLatestTimelineSequence,
    findMatchingInvocationAttestationEvent,
    findMatchingRoutingEventWithDeferredIdentityFallback
} from './required-reviews-check-dependencies';
import {
    normalizeSha256String,
    readReviewReceiptSnapshot,
    resolvePreflightPayloadForReviewValidation,
    resolveReviewContextTreeStateSha256,
    validateDerivedReviewReceiptPath,
    type ReviewArtifactEntry
} from './required-reviews-check-evidence';

export interface ReviewArtifactGateEligibilityResult {
    compactionAudit: ReturnType<typeof auditReviewArtifactCompaction> | null;
    receiptValid: boolean;
    reusedExistingReview: boolean;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
    reviewerFallbackReason: string | null;
    trustLevel: string | null;
    reviewerRoutingPolicy: Record<string, unknown> | null;
    trivialReview: boolean;
    findingsEvidence: ReturnType<typeof getReviewArtifactFindingsEvidence> | null;
    violations: string[];
}

function getPreflightScopeSha256(preflightPayload: Record<string, unknown> | null): string | null {
    const metrics = preflightPayload?.metrics && typeof preflightPayload.metrics === 'object' && !Array.isArray(preflightPayload.metrics)
        ? preflightPayload.metrics as Record<string, unknown>
        : null;
    return normalizeSha256String(metrics?.scope_sha256) || normalizeSha256String(metrics?.changed_files_sha256);
}

export function validateReviewArtifactGateEligibility(options: {
    resolvedTaskId: string | null;
    reviewKey: string;
    required: boolean;
    skippedByOverride: boolean;
    reviewArtifact: ReviewArtifactEntry;
    preflightPath?: string | null;
    preflightSha256?: string | null;
    preflightPayload?: Record<string, unknown> | null;
    repoRoot?: string | null;
    sourceOfTruth?: string | null;
    canonicalSourceOfTruth?: string | null;
    executionProvider?: string | null;
    executionProviderSource?: string | null;
    allowLegacyReviewContextIdentityFallback?: boolean;
    allowLaneDomainPreflightBinding?: boolean;
    requireFindingsDispositionEvidence?: boolean;
    timelineEvents?: readonly ReviewDependencyTimelineEvent[];
    treeStateFreshnessCache?: ReviewTreeStateFreshnessCache | null;
}): ReviewArtifactGateEligibilityResult {
    const { resolvedTaskId, reviewKey, required, skippedByOverride, reviewArtifact } = options;
    const errors: string[] = [];
    const artifactPath = reviewArtifact.path;
    const artifactContent = reviewArtifact.content;
    const reviewContext = reviewArtifact.reviewContext;
    const reviewContextTreeStateSha256 = resolveReviewContextTreeStateSha256(reviewContext);
    const routingMetadata = toPlainRecord(reviewContext?.reviewer_routing);
    const contextExecutionMode = normalizeCompatibilityReviewerExecutionMode(routingMetadata?.actual_execution_mode);
    const contextReviewerSessionId = typeof routingMetadata?.reviewer_session_id === 'string'
        ? String(routingMetadata.reviewer_session_id).trim()
        : '';
    const contextFallbackReason = typeof routingMetadata?.fallback_reason === 'string'
        ? String(routingMetadata.fallback_reason).trim()
        : '';
    const canonicalSourceOfTruth = normalizeSourceOfTruthValue(options.canonicalSourceOfTruth);
    const repoRoot = options.repoRoot || null;
    const currentExecutionProvider = normalizeSourceOfTruthValue(options.executionProvider);
    const resolvedRoutingIdentity = resolveReviewContextRoutingIdentity({
        reviewerRouting: routingMetadata,
        canonicalSourceOfTruth,
        executionProvider: currentExecutionProvider,
        allowLegacyCompatibility: options.allowLegacyReviewContextIdentityFallback === true
    });
    const legacySourceOfTruth = resolvedRoutingIdentity.legacy_source_of_truth;
    const routingCanonicalSourceOfTruth = resolvedRoutingIdentity.canonical_source_of_truth;
    const routingExecutionProvider = resolvedRoutingIdentity.execution_provider;
    const routingExecutionProviderSource = normalizeRuntimeIdentitySource(routingMetadata?.execution_provider_source);
    const routingIdentityStatus = resolvedRoutingIdentity.identity_status;
    const currentExecutionProviderSource = normalizeRuntimeIdentitySource(options.executionProviderSource);
    const routingPolicy = resolveReviewerRoutingPolicy(
        routingExecutionProvider ?? legacySourceOfTruth,
        routingExecutionProviderSource
    );
    const routingPolicySummary = {
        source_of_truth: legacySourceOfTruth,
        canonical_source_of_truth: routingCanonicalSourceOfTruth,
        execution_provider: routingExecutionProvider,
        execution_provider_source: routingExecutionProviderSource,
        identity_status: routingIdentityStatus,
        explicit_split_identity_present: resolvedRoutingIdentity.explicit_split_identity_present,
        legacy_identity_compatibility_applied: resolvedRoutingIdentity.legacy_identity_compatibility_applied,
        routed_to: typeof routingMetadata?.routed_to === 'string' ? String(routingMetadata.routed_to).trim() || null : null,
        provider_bridge: typeof routingMetadata?.provider_bridge === 'string' ? String(routingMetadata.provider_bridge).trim() || null : null,
        routing_provider: routingPolicy.source_of_truth,
        capability_level: routingPolicy.capability_level,
        delegation_required: routingPolicy.delegation_required,
        expected_execution_mode: routingPolicy.expected_execution_mode,
        fallback_allowed: routingPolicy.fallback_allowed,
        fallback_reason_required: routingPolicy.fallback_reason_required
    };
    let compactionAudit: ReturnType<typeof auditReviewArtifactCompaction> | null = null;
    let receiptValid = false;
    let reviewerExecutionMode: string | null = null;
    let reviewerIdentity: string | null = null;
    let reviewerFallbackReason: string | null = null;
    let reviewerProvenance: ReviewEvidenceReviewerProvenance = null;
    let trustLevel: string | null = null;
    let receiptReviewContextSha256: string | null = null;
    let validatedReceipt: ReviewReceipt | null = null;
    let reusedExistingReview = false;
    let reusedFromReviewTreeStateSha256: string | null = null;
    let trivialReview = false;
    let findingsEvidence: ReturnType<typeof getReviewArtifactFindingsEvidence> | null = null;
    let laneDomainPreflightBindingAllowed = false;
    const requiresFindingsOnlyArtifact = reviewContextRequiresFindingsOnlyArtifact(reviewContext);
    const preflightPayload = resolvePreflightPayloadForReviewValidation({
        preflightPayload: options.preflightPayload,
        preflightPath: options.preflightPath
    });

    if (artifactPath && artifactContent) {
        compactionAudit = auditReviewArtifactCompaction({
            artifactPath,
            content: artifactContent,
            reviewContext
        });
        if (required && !skippedByOverride) {
            trivialReview = isTrivialReview(artifactContent);
            if (trivialReview) {
                errors.push(
                    `Review artifact '${normalizePath(artifactPath)}' is trivial or obviously synthetic. ` +
                    REVIEW_TRIVIAL_OUTPUT_THRESHOLD_MESSAGE
                );
            }
            if (!requiresFindingsOnlyArtifact) {
                findingsEvidence = getReviewArtifactFindingsEvidence(artifactPath, artifactContent);
                errors.push(...findingsEvidence.violations);
            }
        }
        if (required && !skippedByOverride) {
            if (!reviewContext) {
                errors.push(`Required review '${reviewKey}' is missing a valid review-context artifact.`);
            }
            const diffExpectations = buildReviewContextPreflightDiffExpectations(preflightPayload, reviewKey);
            laneDomainPreflightBindingAllowed = options.allowLaneDomainPreflightBinding === true
                && reviewContextLaneScopeMatchesCurrentPreflight(reviewKey, reviewContext || null, preflightPayload);
            const reviewContextPath = reviewArtifact.reviewContextPath
                || artifactPath.replace(/\.md$/, '-review-context.json');
            const reviewExecution = isPlainRecord(reviewContext?.review_execution)
                ? reviewContext.review_execution as unknown as ReviewRemediationReviewContract
                : null;
            const reviewExecutionValidationAuthority = reviewExecution
                && resolvedTaskId
                && options.preflightSha256
                ? resolvePersistedRemediationReviewExecutionAuthority({
                    reviewsRoot: path.dirname(reviewContextPath),
                    taskId: resolvedTaskId,
                    reviewType: reviewKey,
                    preflightSha256: options.preflightSha256,
                    fullReviewScope: diffExpectations.expectedChangedFiles,
                    reviewExecution
                })
                : null;
            errors.push(...getReviewContextContractViolations({
                contextPath: reviewContextPath,
                reviewContext: reviewContext || null,
                expectedTaskId: resolvedTaskId,
                expectedReviewType: reviewKey,
                expectedPreflightPath: laneDomainPreflightBindingAllowed ? null : options.preflightPath,
                expectedPreflightSha256: laneDomainPreflightBindingAllowed ? null : options.preflightSha256,
                requireReviewType: true,
                requireTaskId: true,
                requirePreflightPath: !laneDomainPreflightBindingAllowed,
                requirePreflightSha256: !laneDomainPreflightBindingAllowed,
                ...diffExpectations,
                expectedChangedFiles: laneDomainPreflightBindingAllowed ? [] : diffExpectations.expectedChangedFiles,
                expectedPreflightPayload: preflightPayload,
                repoRoot: options.repoRoot || null,
                expectedReviewExecutionValidationAuthority: reviewExecutionValidationAuthority ?? undefined,
                expectedChangedFilesSha256: laneDomainPreflightBindingAllowed ? null : diffExpectations.expectedChangedFilesSha256,
                expectedScopeContentSha256: laneDomainPreflightBindingAllowed ? null : diffExpectations.expectedScopeContentSha256,
                expectedScopeSha256: laneDomainPreflightBindingAllowed ? null : diffExpectations.expectedScopeSha256,
                expectedScopedDiff: laneDomainPreflightBindingAllowed ? false : diffExpectations.expectedScopedDiff,
                requireDiffMaterialForRequiredReview: !laneDomainPreflightBindingAllowed
            }));
            if (reviewContext && requiresFindingsOnlyArtifact && !String(artifactContent || '').trim().startsWith('{')) {
                errors.push(
                    `Review artifact '${normalizePath(artifactPath)}' must be verdict-free findings JSON for current '${reviewKey}' review context; ` +
                    'legacy PASS/FAIL verdict-token artifacts are readable history only and cannot satisfy current review evidence.'
                );
            }
            if (reviewContext && !reviewContextTreeStateSha256) {
                errors.push(
                    `Required review '${reviewKey}' review-context is missing tree_state.tree_state_sha256.`
                );
            }
            if (repoRoot && reviewContext) {
                const contextPath = reviewContextPath;
                try {
                    assertReviewTreeStateFresh({
                        repoRoot,
                        reviewContext,
                        contextPath,
                        gateName: 'required-reviews-check',
                        freshnessCache: options.treeStateFreshnessCache
                    });
                } catch (exc: unknown) {
                    errors.push(exc instanceof Error ? exc.message : String(exc));
                }
                try {
                    resolveReviewerPromptArtifactBinding({
                        repoRoot,
                        reviewContext,
                        contextPath,
                        gateName: 'required-reviews-check'
                    });
                } catch (exc: unknown) {
                    errors.push(exc instanceof Error ? exc.message : String(exc));
                }
            }
            if (routingMetadata?.actual_execution_mode && !contextExecutionMode) {
                errors.push(
                    `Review '${reviewKey}' review-context has invalid reviewer_routing.actual_execution_mode ` +
                    `('${String(routingMetadata.actual_execution_mode)}').`
                );
            }
            if (!canonicalSourceOfTruth) {
                errors.push(
                    `Review '${reviewKey}' cannot be validated because the active workspace is missing canonical SourceOfTruth.`
                );
            } else if (!routingCanonicalSourceOfTruth) {
                errors.push(`Review '${reviewKey}' review-context is missing canonical_source_of_truth.`);
            } else if (routingCanonicalSourceOfTruth !== canonicalSourceOfTruth) {
                errors.push(
                    `Review '${reviewKey}' review-context canonical_source_of_truth (${routingCanonicalSourceOfTruth}) does not match canonical provider (${canonicalSourceOfTruth}).`
                );
            }
            if (!currentExecutionProvider) {
                errors.push(
                    `Review '${reviewKey}' cannot be validated because the active task is missing execution provider identity.`
                );
            } else if (!routingExecutionProvider) {
                errors.push(`Review '${reviewKey}' review-context is missing execution_provider.`);
            } else if (routingExecutionProvider !== currentExecutionProvider) {
                errors.push(
                    `Review '${reviewKey}' review-context execution_provider (${routingExecutionProvider}) does not match active runtime provider (${currentExecutionProvider}).`
                );
            }
            if (resolvedRoutingIdentity.explicit_split_identity_present && !routingExecutionProviderSource) {
                errors.push(`Review '${reviewKey}' review-context is missing execution_provider_source.`);
            } else if (
                resolvedRoutingIdentity.explicit_split_identity_present
                && currentExecutionProviderSource
                && routingExecutionProviderSource !== currentExecutionProviderSource
            ) {
                errors.push(
                    `Review '${reviewKey}' review-context execution_provider_source (${routingExecutionProviderSource}) ` +
                    `does not match active runtime source (${currentExecutionProviderSource}).`
                );
            }
            if (!routingIdentityStatus) {
                errors.push(`Review '${reviewKey}' review-context is missing identity_status.`);
            } else if (routingIdentityStatus !== 'resolved') {
                errors.push(
                    `Review '${reviewKey}' review-context runtime identity status must be 'resolved', got '${routingIdentityStatus}'.`
                );
            }
        }

        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const receiptPathViolation = validateDerivedReviewReceiptPath({
            reviewKey,
            artifactPath,
            receiptPath,
            repoRoot
        });
        if (receiptPathViolation) {
            errors.push(receiptPathViolation);
        } else {
            const receiptSnapshot = readReviewReceiptSnapshot({
                reviewKey,
                reviewArtifact,
                artifactPath,
                receiptPath
            });
            if (receiptSnapshot.receipt) {
                try {
                    const receipt = receiptSnapshot.receipt;
                    const evidenceFields = normalizeReviewReceiptEvidenceFields(receipt as unknown as Record<string, unknown>);
                    validatedReceipt = receipt;
                    if (preflightPayload && isCustomReviewLaneInSnapshot(preflightPayload, reviewKey)) {
                        try {
                            errors.push(...getReviewLaneArtifactEvidenceViolations({
                                artifact: receipt as unknown as Record<string, unknown>,
                                preflight: preflightPayload,
                                reviewType: reviewKey,
                                label: `Review receipt for '${reviewKey}'`
                            }));
                        } catch (error: unknown) {
                            errors.push(error instanceof Error ? error.message : String(error));
                        }
                    }
                    const currentArtifactHash = receiptSnapshot.artifactSha256
                        ?? readReviewArtifactFileSha256(artifactPath);
                    const executionEvidenceViolations = getReviewReceiptExecutionEvidenceContractViolations({
                        reviewContext: reviewContext || null,
                        receipt: receipt as unknown as Record<string, unknown>
                    });
                    errors.push(...executionEvidenceViolations.map((violation) =>
                        `Review receipt for '${reviewKey}' execution evidence violation: ${violation}.`
                    ));
                    if (receipt.task_id !== resolvedTaskId) {
                        errors.push(`Review receipt for '${reviewKey}' belongs to a different task: ${receipt.task_id}.`);
                    } else if (receipt.review_type !== reviewKey) {
                        errors.push(`Review receipt for '${reviewKey}' has mismatched review type: ${receipt.review_type}.`);
                    } else if (receipt.review_artifact_sha256 !== currentArtifactHash) {
                        errors.push(`Review artifact hash mismatch for '${reviewKey}'. Artifact was modified after receipt was issued.`);
                    } else if (required && !skippedByOverride && !reviewArtifact.reviewContextSha256) {
                        errors.push(`Required review '${reviewKey}' is missing a verifiable review-context hash.`);
                    } else if (required && !skippedByOverride && !receipt.review_context_sha256) {
                        errors.push(`Review receipt for '${reviewKey}' is missing review_context_sha256.`);
                    } else if (reviewArtifact.reviewContextSha256 && receipt.review_context_sha256 !== reviewArtifact.reviewContextSha256) {
                        errors.push(`Review context hash mismatch for '${reviewKey}'. Review-context artifact was modified after receipt was issued.`);
                    } else if (required && !skippedByOverride && reviewContextTreeStateSha256 && !normalizeSha256String(receipt.review_tree_state_sha256)) {
                        errors.push(`Review receipt for '${reviewKey}' is missing review_tree_state_sha256.`);
                    } else if (
                        reviewContextTreeStateSha256
                        && normalizeSha256String(receipt.review_tree_state_sha256)
                        && normalizeSha256String(receipt.review_tree_state_sha256) !== reviewContextTreeStateSha256
                    ) {
                        errors.push(
                            `Review tree-state hash mismatch for '${reviewKey}'. ` +
                            'Review-context tree_state does not match the receipt binding.'
                        );
                    } else {
                        receiptValid = executionEvidenceViolations.length === 0;
                    }
                    if (receipt.reviewer_execution_mode) {
                        reviewerExecutionMode = evidenceFields.reviewerExecutionMode;
                        if (!reviewerExecutionMode) {
                            errors.push(
                                `Review receipt for '${reviewKey}' has invalid reviewer_execution_mode ` +
                                `('${String(receipt.reviewer_execution_mode)}').`
                            );
                        }
                    }
                    reviewerIdentity = evidenceFields.reviewerIdentity;
                    reviewerFallbackReason = evidenceFields.reviewerFallbackReason;
                    if (receipt.reviewer_provenance != null) {
                        reviewerProvenance = evidenceFields.reviewerProvenance;
                        if (!reviewerProvenance) {
                            errors.push(`Review receipt for '${reviewKey}' has invalid reviewer_provenance.`);
                        }
                    }
                    trustLevel = evidenceFields.trustLevel;
                    reusedExistingReview = evidenceFields.reusedExistingReview;
                    reusedFromReviewTreeStateSha256 = evidenceFields.reusedFromReviewTreeStateSha256;
                    if (reusedExistingReview && !reusedFromReviewTreeStateSha256) {
                        errors.push(`Review receipt for '${reviewKey}' is missing reused_from_review_tree_state_sha256 for reused evidence.`);
                    }
                    receiptReviewContextSha256 = evidenceFields.reviewContextSha256;
                    if (reviewContext && requiresFindingsOnlyArtifact) {
                        const reviewCoverage = toPlainRecord((receipt as unknown as Record<string, unknown>).review_coverage);
                        const coverageContract = toPlainRecord(reviewContext.coverage_contract);
                        const expectedCoverageContractSha256 = String(coverageContract?.contract_sha256 || '').trim().toLowerCase() || null;
                        const reviewOutputContract = toPlainRecord(
                            (receipt as unknown as Record<string, unknown>).review_output_contract
                        );
                        const findingsCoverageContractSha256 = reusedExistingReview
                            ? String(reviewOutputContract?.coverage_contract_sha256 || '').trim().toLowerCase() || null
                            : expectedCoverageContractSha256;
                        if (reviewCoverage?.status !== 'PASS') {
                            errors.push(`Review receipt for '${reviewKey}' is missing complete review_coverage evidence.`);
                        } else if (coverageContract) {
                            const coverageCompatibilityViolations = getReviewCoverageValidationSummaryContractViolations(
                                reviewCoverage,
                                coverageContract as unknown as ReviewCoverageContract
                            );
                            if (coverageCompatibilityViolations.length > 0) {
                                errors.push(
                                    `Review receipt coverage contract mismatch for '${reviewKey}': ` +
                                    coverageCompatibilityViolations.join('; ')
                                );
                            }
                        }
                        const validationArtifact = validateReviewFindingsValidationArtifactForReceipt({
                            receipt: receipt as unknown as Record<string, unknown>,
                            reviewArtifactPath: artifactPath,
                            expectedTaskId: resolvedTaskId || '',
                            expectedReviewType: reviewKey,
                            expectedReviewOutputSha256: typeof (receipt as unknown as Record<string, unknown>).review_output_sha256 === 'string'
                                ? (receipt as unknown as Record<string, unknown>).review_output_sha256 as string
                                : null,
                            expectedReviewArtifactSha256: currentArtifactHash,
                            expectedReviewContextPath: reusedExistingReview
                                ? null
                                : reviewArtifact.reviewContextPath || artifactPath.replace(/\.md$/, '-review-context.json'),
                            expectedReviewContextSha256: reusedExistingReview
                                ? typeof receipt.reused_from_review_context_sha256 === 'string' ? receipt.reused_from_review_context_sha256 : null
                                : receipt.review_context_sha256 || reviewArtifact.reviewContextSha256 || null,
                            expectedPreflightPath: reusedExistingReview ? null : options.preflightPath,
                            expectedPreflightSha256: reusedExistingReview ? null : options.preflightSha256,
                            expectedScopeSha256: reusedExistingReview ? null : getPreflightScopeSha256(preflightPayload),
                            expectedReviewScopeSha256: reusedExistingReview
                                ? typeof receipt.reused_from_review_scope_sha256 === 'string' ? receipt.reused_from_review_scope_sha256 : null
                                : typeof receipt.review_scope_sha256 === 'string' ? receipt.review_scope_sha256 : null,
                            expectedCodeScopeSha256: reusedExistingReview
                                ? typeof receipt.reused_from_code_scope_sha256 === 'string' ? receipt.reused_from_code_scope_sha256 : null
                                : typeof receipt.code_scope_sha256 === 'string' ? receipt.code_scope_sha256 : null,
                            expectedReviewTreeStateSha256: reusedExistingReview
                                ? typeof receipt.reused_from_review_tree_state_sha256 === 'string' ? receipt.reused_from_review_tree_state_sha256 : null
                                : reviewContextTreeStateSha256,
                            expectedCoverageContractSha256: findingsCoverageContractSha256,
                            expectedReviewContext: reviewContext,
                            requireAccepted: true
                        });
                        errors.push(...validationArtifact.violations);
                        const policyResolution = reusedExistingReview
                            ? resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence(receipt as unknown as Record<string, unknown>)
                            : resolveLockedReviewFindingPolicyFromPreflight(preflightPayload);
                        findingsEvidence = getReviewFindingsEvidenceFromValidationArtifact(
                            artifactPath,
                            validationArtifact.artifact,
                            policyResolution
                        );
                        if (
                            options.requireFindingsDispositionEvidence !== false
                            && validationArtifact.valid
                            && validationArtifact.artifact
                            && validationArtifact.reference
                        ) {
                            if (!repoRoot || !validationArtifact.artifact_sha256) {
                                errors.push(
                                    `Required review '${reviewKey}' cannot validate findings dispositions without ` +
                                    'repo root and a hash-bound findings validation artifact.'
                                );
                            } else {
                                const dispositionEvidence = validateReviewFindingsDispositionEvidence({
                                    repoRoot,
                                    receipt: receipt as unknown as Record<string, unknown>,
                                    receiptPath,
                                    reviewArtifactPath: artifactPath,
                                    expectedTaskId: resolvedTaskId || '',
                                    expectedReviewType: reviewKey,
                                    validationArtifact: validationArtifact.artifact,
                                    validationArtifactPath: validationArtifact.reference.artifact_path,
                                    validationArtifactSha256: validationArtifact.artifact_sha256,
                                    policyResolution,
                                    expectedReceiptPath: reusedExistingReview
                                        ? typeof receipt.reused_from_receipt_path === 'string' ? receipt.reused_from_receipt_path : null
                                        : null,
                                    expectedReceiptSha256: reusedExistingReview
                                        ? typeof receipt.reused_from_receipt_sha256 === 'string' ? receipt.reused_from_receipt_sha256 : null
                                        : null,
                                    preferSnapshot: reusedExistingReview
                                });
                                errors.push(...dispositionEvidence.violations);
                            }
                        }
                    }
                } catch {
                    errors.push(`Review receipt for '${reviewKey}' is invalid JSON: ${normalizePath(receiptPath)}.`);
                }
            } else if (receiptSnapshot.receiptReadError) {
                errors.push(receiptSnapshot.receiptReadError);
            } else if (required && !skippedByOverride) {
                errors.push(`Verifiable review receipt missing for '${reviewKey}': ${normalizePath(receiptPath)}. Run 'gate record-review-receipt' to fix.`);
            }
        }

        if (required && !skippedByOverride && receiptValid) {
            if (!reviewerExecutionMode) {
                errors.push(`Review receipt for '${reviewKey}' is missing reviewer_execution_mode.`);
            }
            if (!reviewerIdentity) {
                errors.push(`Review receipt for '${reviewKey}' is missing reviewer_identity.`);
            }
            if (!reusedExistingReview && !contextExecutionMode) {
                errors.push(`Review '${reviewKey}' is missing reviewer_routing.actual_execution_mode in review-context.`);
            }
            if (!reusedExistingReview && !contextReviewerSessionId) {
                errors.push(`Review '${reviewKey}' is missing reviewer_routing.reviewer_session_id in review-context.`);
            }
            if (!reusedExistingReview && reviewerExecutionMode && contextExecutionMode && reviewerExecutionMode !== contextExecutionMode) {
                errors.push(
                    `Review '${reviewKey}' has inconsistent execution mode between receipt (${reviewerExecutionMode}) ` +
                    `and review-context (${contextExecutionMode}).`
                );
            }
            const contextReviewerIdentityMatchesReceipt = reviewerIdentity && contextReviewerSessionId
                ? reviewerIdentityMatchesDelegatedLaunchCycle({
                    observedIdentity: contextReviewerSessionId,
                    expectedIdentity: reviewerIdentity,
                    taskId: resolvedTaskId || '',
                    reviewType: reviewKey
                })
                : false;
            if (
                !reusedExistingReview
                && reviewerIdentity
                && contextReviewerSessionId
                && !contextReviewerIdentityMatchesReceipt
            ) {
                errors.push(
                    `Review '${reviewKey}' has inconsistent reviewer identity between receipt (${reviewerIdentity}) ` +
                    `and review-context (${contextReviewerSessionId}).`
                );
            }
            if (reviewerFallbackReason && contextFallbackReason && reviewerFallbackReason !== contextFallbackReason) {
                errors.push(`Review '${reviewKey}' has inconsistent fallback reason between receipt and review-context.`);
            }
            if (reviewerExecutionMode === 'same_agent_fallback') {
                errors.push(
                    `Review '${reviewKey}' used deprecated same_agent_fallback evidence. ` +
                    'Record a fresh delegated_subagent review for the current cycle.'
                );
            }
            if (!reusedExistingReview && contextExecutionMode === 'same_agent_fallback') {
                errors.push(
                    `Review '${reviewKey}' review-context records deprecated same_agent_fallback routing. ` +
                    'Record fresh delegated reviewer routing for the current cycle.'
                );
            }
            if (reviewerFallbackReason) {
                errors.push(
                    `Review '${reviewKey}' receipt includes reviewer_fallback_reason, but mandatory reviews now require delegated_subagent only.`
                );
            }
            if (!reusedExistingReview && contextFallbackReason) {
                errors.push(
                    `Review '${reviewKey}' review-context includes reviewer_routing.fallback_reason, but mandatory reviews now require delegated_subagent only.`
                );
            }
            if (reviewerExecutionMode === 'delegated_subagent' && reviewerIdentity && reviewerIdentity.startsWith('self:')) {
                errors.push(`Review '${reviewKey}' claims delegated_subagent execution but reviewer_identity is self-scoped (${reviewerIdentity}).`);
            } else if (reviewerExecutionMode === 'delegated_subagent' && reviewerIdentity && !reviewerIdentity.startsWith('agent:')) {
                errors.push(`Review '${reviewKey}' claims delegated_subagent execution but reviewer_identity must be agent-scoped (expected prefix 'agent:').`);
            }
            if (!reusedExistingReview && contextExecutionMode === 'delegated_subagent' && contextReviewerSessionId && contextReviewerSessionId.startsWith('self:')) {
                errors.push(`Review '${reviewKey}' review-context claims delegated_subagent execution but reviewer_session_id is self-scoped (${contextReviewerSessionId}).`);
            } else if (!reusedExistingReview && contextExecutionMode === 'delegated_subagent' && contextReviewerSessionId && !contextReviewerSessionId.startsWith('agent:')) {
                errors.push(`Review '${reviewKey}' review-context claims delegated_subagent execution but reviewer_session_id must be agent-scoped (expected prefix 'agent:').`);
            }
            if (routingPolicy.delegation_required && reviewerExecutionMode !== 'delegated_subagent') {
                errors.push(
                    `Review '${reviewKey}' must use delegated_subagent for provider '${routingPolicy.source_of_truth || 'unknown'}'. ` +
                    'Same-agent self-review is invalid for the mandatory review workflow.'
                );
            }
            if (routingPolicy.expected_execution_mode !== 'delegated_subagent' || !routingPolicy.delegation_required) {
                errors.push(
                    `Review '${reviewKey}' resolved non-delegated reviewer policy metadata for provider '${routingPolicy.source_of_truth || 'unknown'}'. ` +
                    'Mandatory reviews require delegated_subagent routing.'
                );
            }
            if (routingPolicy.fallback_allowed || routingPolicy.fallback_reason_required) {
                errors.push(
                    `Review '${reviewKey}' resolved stale fallback-capable reviewer policy metadata for provider '${routingPolicy.source_of_truth || 'unknown'}'.`
                );
            }
            if (trustLevel === 'LOCAL_AUDITED' && reviewerExecutionMode === 'delegated_subagent' && !reviewerProvenance) {
                errors.push(
                    `Review receipt for '${reviewKey}' is missing reviewer_provenance for LOCAL_AUDITED delegated_subagent execution.`
                );
            }
            if (reviewerExecutionMode === 'delegated_subagent') {
                const trustViolation = getMandatoryDelegatedReviewTrustViolation({
                    reviewKey,
                    trustLevel,
                    provenanceAttestationType: reviewerProvenance?.attestation_type
                });
                if (trustViolation) {
                    errors.push(trustViolation);
                }
            }
            if (reviewerExecutionMode === 'delegated_subagent' && reviewerIdentity && options.timelineEvents && options.timelineEvents.length > 0) {
                const latestCompilePassSequence = findLatestTimelineSequence(
                    options.timelineEvents,
                    (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
                );
                if (reusedExistingReview) {
                    if (latestCompilePassSequence == null) {
                        errors.push(
                            `Review '${reviewKey}' cannot validate reused evidence because COMPILE_GATE_PASSED telemetry is missing.`
                        );
                    } else if (!repoRoot) {
                        errors.push(
                            `Review '${reviewKey}' cannot validate reused evidence because repo root is unavailable.`
                        );
                    } else {
                        const strictReuseValidation = validateStrictReusedReviewEvidence({
                            repoRoot,
                            taskId: resolvedTaskId || '',
                            reviewType: reviewKey,
                            events: options.timelineEvents,
                            receiptPath,
                            reviewContextSha256: receiptReviewContextSha256,
                            reviewContextReuseSha256: validatedReceipt?.review_context_reuse_sha256,
                            reviewTreeStateSha256: validatedReceipt?.review_tree_state_sha256 || null,
                            reviewScopeSha256: validatedReceipt?.review_scope_sha256,
                            codeScopeSha256: validatedReceipt?.code_scope_sha256,
                            reviewArtifactSha256: readReviewArtifactFileSha256(artifactPath),
                            reusedFromReceiptPath: typeof validatedReceipt?.reused_from_receipt_path === 'string'
                                ? validatedReceipt.reused_from_receipt_path
                                : null,
                            reusedFromReceiptSha256: typeof validatedReceipt?.reused_from_receipt_sha256 === 'string'
                                ? validatedReceipt.reused_from_receipt_sha256
                                : null,
                            reusedFromReviewContextSha256: typeof validatedReceipt?.reused_from_review_context_sha256 === 'string'
                                ? validatedReceipt.reused_from_review_context_sha256
                                : null,
                            reusedFromReviewContextReuseSha256: typeof validatedReceipt?.reused_from_review_context_reuse_sha256 === 'string'
                                ? validatedReceipt.reused_from_review_context_reuse_sha256
                                : null,
                            reusedFromReviewTreeStateSha256,
                            reusedFromReviewScopeSha256: typeof validatedReceipt?.reused_from_review_scope_sha256 === 'string'
                                ? validatedReceipt.reused_from_review_scope_sha256
                                : null,
                            reusedFromCodeScopeSha256: typeof validatedReceipt?.reused_from_code_scope_sha256 === 'string'
                                ? validatedReceipt.reused_from_code_scope_sha256
                                : null,
                            reviewerExecutionMode,
                            reviewerIdentity,
                            reviewerProvenance: reviewerProvenance as unknown as Record<string, unknown> | null,
                            latestCompileEventSequence: latestCompilePassSequence
                        });
                        if (!strictReuseValidation.valid) {
                            const strictReuseReason = strictReuseValidation.reason.includes('current-cycle REVIEW_RECORDED reuse telemetry')
                                ? `Review '${reviewKey}' is missing current-cycle REVIEW_RECORDED reuse telemetry or it does not match strict reused evidence: ${strictReuseValidation.reason}.`
                                : strictReuseValidation.reason.includes('historical REVIEW_RECORDED telemetry')
                                    ? `Review receipt for '${reviewKey}' reused evidence is invalid: historical REVIEW_RECORDED telemetry validation failed: ${strictReuseValidation.reason}.`
                                    : `Review receipt for '${reviewKey}' reused evidence is invalid: ${strictReuseValidation.reason}.`;
                            errors.push(
                                strictReuseReason
                            );
                        } else {
                            const hiddenTimingTrust = evaluateHiddenReviewTimingTrust({
                                reviewType: reviewKey,
                                reusedExistingReview,
                                reviewerProvenance: stripReviewTimingProvenanceTimestamps(reviewerProvenance),
                                reviewResultRecordedAtUtc: typeof validatedReceipt?.review_result_recorded_at_utc === 'string'
                                    ? validatedReceipt.review_result_recorded_at_utc
                                    : null,
                                recordedAtUtc: typeof validatedReceipt?.recorded_at_utc === 'string'
                                    ? validatedReceipt.recorded_at_utc
                                    : null,
                                reviewOutputSourceMtimeUtc: typeof validatedReceipt?.review_output_source_mtime_utc === 'string'
                                    ? validatedReceipt.review_output_source_mtime_utc
                                    : null,
                                strictReusedReviewRecordedDetails: strictReuseValidation.historicalReviewRecordedDetails,
                                timelineEvents: options.timelineEvents,
                                latestCompileSequence: latestCompilePassSequence
                            });
                            if (!hiddenTimingTrust.trusted && hiddenTimingTrust.message) {
                                errors.push(
                                    `Review receipt for '${reviewKey}' is not sufficiently trustworthy. ${hiddenTimingTrust.message}`
                                );
                            }
                        }
                    }
                } else {
                    const routingEvent = findMatchingRoutingEventWithDeferredIdentityFallback(
                        options.timelineEvents,
                        reviewKey,
                        reviewerExecutionMode,
                        reviewerIdentity,
                        reviewerFallbackReason,
                        reviewerProvenance,
                        laneDomainPreflightBindingAllowed,
                        resolvedTaskId
                    );
                    const latestRoutingEvent = findLatestRoutingEventForReviewType(options.timelineEvents, reviewKey);
                    if (!routingEvent) {
                        errors.push(
                            `Review '${reviewKey}' is missing matching REVIEWER_DELEGATION_ROUTED telemetry in the current cycle for reviewer '${reviewerIdentity}'.`
                        );
                    } else if (!routingEvent.integrity) {
                        errors.push(
                            `Review '${reviewKey}' cannot validate reviewer_provenance because matching REVIEWER_DELEGATION_ROUTED telemetry is missing integrity.`
                        );
                    } else {
                        if (trustLevel === 'LOCAL_AUDITED') {
                            errors.push(
                                `Review receipt for '${reviewKey}' cannot claim LOCAL_AUDITED trust for delegated_subagent execution. ` +
                                'Current local routing telemetry is asserted-only until a separate launch-attestation contract exists.'
                            );
                        }
                        if (!reviewerProvenance) {
                            errors.push(
                                `Review receipt for '${reviewKey}' is missing reviewer_provenance for delegated_subagent execution.`
                            );
                        } else if (reviewerProvenance.attestation_type !== 'reviewer_invocation_attestation') {
                            errors.push(
                                `Review receipt for '${reviewKey}' reviewer_provenance does not match REVIEWER_INVOCATION_ATTESTED launch telemetry.`
                            );
                        } else {
                            const invocationAttestationEvent = findMatchingInvocationAttestationEvent(
                                options.timelineEvents,
                                {
                                    taskId: resolvedTaskId || '',
                                    reviewType: reviewKey,
                                    reviewerExecutionMode,
                                    reviewerIdentity,
                                    reviewContextSha256: receiptReviewContextSha256,
                                    reviewTreeStateSha256: reviewContextTreeStateSha256,
                                    routingEventSha256: String(routingEvent.integrity.event_sha256 || '').trim().toLowerCase(),
                                    reviewerProvenance
                                }
                            );
                            if (!invocationAttestationEvent) {
                                errors.push(
                                    `Review receipt for '${reviewKey}' reviewer_provenance does not match REVIEWER_INVOCATION_ATTESTED launch telemetry.`
                                );
                            } else {
                                const hiddenTimingTrust = evaluateHiddenReviewTimingTrust({
                                    reviewType: reviewKey,
                                    reusedExistingReview,
                                    reviewerProvenance: stripReviewTimingProvenanceTimestamps(reviewerProvenance),
                                    reviewResultRecordedAtUtc: typeof validatedReceipt?.review_result_recorded_at_utc === 'string'
                                        ? validatedReceipt.review_result_recorded_at_utc
                                        : null,
                                    recordedAtUtc: typeof validatedReceipt?.recorded_at_utc === 'string'
                                        ? validatedReceipt.recorded_at_utc
                                        : null,
                                    reviewOutputSourceMtimeUtc: typeof validatedReceipt?.review_output_source_mtime_utc === 'string'
                                        ? validatedReceipt.review_output_source_mtime_utc
                                        : null,
                                    timelineEvents: options.timelineEvents,
                                    latestCompileSequence: latestCompilePassSequence
                                });
                                if (!hiddenTimingTrust.trusted && hiddenTimingTrust.message) {
                                    errors.push(
                                        `Review receipt for '${reviewKey}' is not sufficiently trustworthy. ${hiddenTimingTrust.message}`
                                    );
                                }
                            }
                        }
                    }
                    if (latestRoutingEvent?.details) {
                        const latestRoutingExecutionMode = normalizeCompatibilityReviewerExecutionMode(
                            latestRoutingEvent.details.reviewer_execution_mode ?? latestRoutingEvent.details.reviewerExecutionMode
                        );
                        const latestRoutingSessionId = String(
                            (latestRoutingEvent.details.reviewer_session_id ?? latestRoutingEvent.details.reviewerSessionId) || ''
                        ).trim();
                        if (
                            latestRoutingExecutionMode
                            && contextExecutionMode
                            && latestRoutingExecutionMode !== contextExecutionMode
                        ) {
                            errors.push(
                                `Review '${reviewKey}' has inconsistent execution mode between REVIEWER_DELEGATION_ROUTED telemetry ` +
                                `(${latestRoutingExecutionMode}) and review-context (${contextExecutionMode}).`
                            );
                        }
                        if (
                            latestRoutingSessionId
                            && contextReviewerSessionId
                            && !reviewerIdentityMatchesDelegatedLaunchCycle({
                                observedIdentity: latestRoutingSessionId,
                                expectedIdentity: contextReviewerSessionId,
                                taskId: resolvedTaskId || '',
                                reviewType: reviewKey
                            })
                        ) {
                            errors.push(
                                `Review '${reviewKey}' has inconsistent reviewer identity between REVIEWER_DELEGATION_ROUTED telemetry ` +
                                `(${latestRoutingSessionId}) and review-context (${contextReviewerSessionId}).`
                            );
                        }
                    }
                }
            }
        }
    } else if (required && !skippedByOverride) {
        errors.push(`Review artifact missing for '${reviewKey}'.`);
    }

    return {
        compactionAudit,
        receiptValid,
        reusedExistingReview,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        trustLevel,
        reviewerRoutingPolicy: routingPolicySummary,
        trivialReview,
        findingsEvidence,
        violations: errors
    };
}
