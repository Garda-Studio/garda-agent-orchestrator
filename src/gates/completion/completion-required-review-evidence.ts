import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPlainRecord } from '../../core/records';
import type { ReviewReceipt } from '../../gate-runtime/review-context';
import {
    readReviewArtifactFileSha256,
    readReviewArtifactJsonFile,
    readReviewArtifactTextFile,
    withReviewArtifactReadBarrier
} from '../../gate-runtime/review-artifacts';
import { normalizePath } from '../shared/helpers';
import { resolveCanonicalReviewContextPath } from '../review-context/review-context-paths';
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
import {
    buildUnavailableRequiredReviewTrustSummary,
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate
} from '../task-audit/task-audit-summary-collectors';
import {
    findLatestRecordedReviewContextPath,
    readJsonArtifact,
    ensurePassedArtifactStatus,
    type TimelineEventEntry
} from './completion-evidence';
import {
    resolveCompletionReviewContracts,
    getReviewArtifactFindingsEvidence,
    getReviewFindingsEvidenceFromValidationArtifact
} from './completion-verdict';
import { reviewContextRequiresFindingsOnlyArtifact } from '../review/review-findings-artifact-verdict';
import {
    validateReviewFindingsValidationArtifactForReceipt
} from '../review/review-findings-validation-artifact';
import { getReviewReceiptExecutionEvidenceContractViolations } from '../review/review-evidence-contract';
import {
    resolveLockedReviewFindingPolicyFromPreflight,
    resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence
} from '../review/review-finding-disposition';
import { validateReviewFindingsDispositionEvidence } from '../review/review-findings-disposition-evidence';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    isNonTestReviewScope
} from '../review-reuse/review-reuse';

function getPreflightScopeSha256(preflight: Record<string, unknown>): string | null {
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : null;
    const candidate = String(metrics?.scope_sha256 || metrics?.changed_files_sha256 || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(candidate) ? candidate : null;
}

function getReceiptString(receipt: ReviewReceipt | null, key: string): string | null {
    const value = receipt
        ? (receipt as unknown as Record<string, unknown>)[key]
        : null;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getReceiptOutputContractString(receipt: ReviewReceipt | null, key: string): string | null {
    const contract = receipt
        ? (receipt as unknown as Record<string, unknown>).review_output_contract
        : null;
    const value = contract && typeof contract === 'object' && !Array.isArray(contract)
        ? (contract as Record<string, unknown>)[key]
        : null;
    return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function getReviewContextTreeStateSha256(reviewContext: Record<string, unknown> | null): string | null {
    const treeState = reviewContext?.tree_state;
    if (!treeState || typeof treeState !== 'object' || Array.isArray(treeState)) {
        return null;
    }
    const candidate = String((treeState as Record<string, unknown>).tree_state_sha256 || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(candidate) ? candidate : null;
}

function getCoverageContractSha256(reviewContext: Record<string, unknown> | null): string | null {
    const coverageContract = reviewContext?.coverage_contract;
    if (!coverageContract || typeof coverageContract !== 'object' || Array.isArray(coverageContract)) {
        return null;
    }
    const value = (coverageContract as Record<string, unknown>).contract_sha256;
    const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^[0-9a-f]{64}$/u.test(candidate) ? candidate : null;
}

function toRequiredReviewBooleanRecord(value: Record<string, unknown>): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const [key, enabled] of Object.entries(value)) {
        result[key] = enabled === true;
    }
    return result;
}

export interface CompletionReviewArtifactEvidence {
    path: string;
    content: string;
    reviewContextPath: string;
    reviewContext: Record<string, unknown> | null;
    receipt: ReviewReceipt | null;
    findings_evidence: ReturnType<typeof getReviewArtifactFindingsEvidence>;
}

export function collectRequiredReviewEvidence(input: {
    reviewsRoot: string;
    taskId: string;
    preflight: Record<string, unknown>;
    preflightPath: string;
    preflightSha256: string;
    reviewEvidencePath: string;
    requiredReviews: Record<string, unknown>;
    scopeCategory: string | null;
    orderedEvents: readonly TimelineEventEntry[];
    errors: string[];
}): {
    reviewArtifacts: Record<string, CompletionReviewArtifactEvidence>;
    receiptReviewTrustSummary: ReturnType<typeof readReviewTrustSummary>;
    reviewGateTrustSummary: ReturnType<typeof readReviewTrustSummaryFromReviewGate>;
} {
    const reviewArtifacts: Record<string, CompletionReviewArtifactEvidence> = {};
    const {
        receiptReviewTrustSummary,
        reviewGateTrustSummary
    } = withReviewArtifactReadBarrier(input.reviewsRoot, () => {
        const requiredReviewBooleans = toRequiredReviewBooleanRecord(input.requiredReviews);
        const repoRoot = path.resolve(input.reviewsRoot, '..', '..', '..');
        const reviewEvidence = readJsonArtifact(input.reviewEvidencePath, 'Review gate', input.errors);
        ensurePassedArtifactStatus(reviewEvidence, 'Review gate', input.errors);
        let reviewContracts: ReturnType<typeof resolveCompletionReviewContracts> = [];
        try {
            reviewContracts = resolveCompletionReviewContracts(input.preflight);
        } catch (error: unknown) {
            input.errors.push(error instanceof Error ? error.message : String(error));
        }
        for (const [reviewKey] of reviewContracts) {
            const required = !!input.requiredReviews[reviewKey];
            if (!required) {
                continue;
            }
            const artifactPath = path.join(input.reviewsRoot, `${input.taskId}-${reviewKey}.md`);
            const recordedReviewContextPath = findLatestRecordedReviewContextPath(input.orderedEvents, reviewKey);
            const reviewContextPath = resolveCanonicalReviewContextPath({
                reviewsRoot: input.reviewsRoot,
                taskId: input.taskId,
                reviewType: reviewKey,
                explicitPath: recordedReviewContextPath
            });
            const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
            const artifactExists = fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile();

            if (!artifactExists) {
                input.errors.push(`Required review artifact not found: ${normalizePath(artifactPath)}`);
                continue;
            }

            const artifactContent = readReviewArtifactTextFile(artifactPath);
            let reviewContext: Record<string, unknown> | null = null;
            let receipt: ReviewReceipt | null = null;
            if (fs.existsSync(reviewContextPath) && fs.statSync(reviewContextPath).isFile()) {
                try {
                    const parsedReviewContext = readReviewArtifactJsonFile(reviewContextPath);
                    if (parsedReviewContext && typeof parsedReviewContext === 'object' && !Array.isArray(parsedReviewContext)) {
                        reviewContext = parsedReviewContext as Record<string, unknown>;
                        const diffExpectations = buildReviewContextPreflightDiffExpectations(input.preflight, reviewKey);
                        const reviewExecution = isPlainRecord(reviewContext.review_execution)
                            ? reviewContext.review_execution as unknown as ReviewRemediationReviewContract
                            : null;
                        const reviewExecutionValidationAuthority = reviewExecution
                            ? resolvePersistedRemediationReviewExecutionAuthority({
                                reviewsRoot: input.reviewsRoot,
                                taskId: input.taskId,
                                reviewType: reviewKey,
                                preflightSha256: input.preflightSha256,
                                preflightPath: input.preflightPath,
                                fullReviewScope: diffExpectations.expectedChangedFiles,
                                reviewExecution,
                                reviewContextPath,
                                receiptPath
                            })
                            : null;
                        input.errors.push(...getReviewContextContractViolations({
                            contextPath: reviewContextPath,
                            reviewContext,
                            expectedTaskId: input.taskId,
                            expectedReviewType: reviewKey,
                            expectedPreflightPath: input.preflightPath,
                            expectedPreflightSha256: input.preflightSha256,
                            requireReviewType: true,
                            requireTaskId: true,
                            requirePreflightPath: true,
                            requirePreflightSha256: true,
                            expectedPreflightPayload: input.preflight,
                            repoRoot,
                            expectedReviewExecutionValidationAuthority: reviewExecutionValidationAuthority ?? undefined,
                            ...diffExpectations
                        }));
                    }
                } catch {
                    input.errors.push(`Required review-context artifact is invalid JSON: ${normalizePath(reviewContextPath)}`);
                }
            } else {
                input.errors.push(`Required review-context artifact not found: ${normalizePath(reviewContextPath)}`);
            }
            if (fs.existsSync(receiptPath) && fs.statSync(receiptPath).isFile()) {
                try {
                    const parsedReceipt = readReviewArtifactJsonFile(receiptPath);
                    if (parsedReceipt && typeof parsedReceipt === 'object' && !Array.isArray(parsedReceipt)) {
                        receipt = parsedReceipt as ReviewReceipt;
                        const recordedReviewArtifactSha256 = getReceiptString(
                            receipt,
                            'review_artifact_sha256'
                        )?.toLowerCase() ?? null;
                        const actualReviewArtifactSha256 = readReviewArtifactFileSha256(artifactPath);
                        if (
                            recordedReviewArtifactSha256
                            && recordedReviewArtifactSha256 !== actualReviewArtifactSha256
                        ) {
                            input.errors.push(
                                `Required review receipt for '${reviewKey}' has review_artifact_sha256 ` +
                                `that does not match the review artifact hash.`
                            );
                        }
                        input.errors.push(...getReviewReceiptExecutionEvidenceContractViolations({
                            reviewContext,
                            receipt: parsedReceipt as Record<string, unknown>
                        }));
                        if (isCustomReviewLaneInSnapshot(input.preflight, reviewKey)) {
                            try {
                                input.errors.push(...getReviewLaneArtifactEvidenceViolations({
                                    artifact: parsedReceipt as Record<string, unknown>,
                                    preflight: input.preflight,
                                    reviewType: reviewKey,
                                    label: `Required review receipt for '${reviewKey}'`
                                }));
                            } catch (error: unknown) {
                                input.errors.push(error instanceof Error ? error.message : String(error));
                            }
                        }
                    }
                } catch {
                    input.errors.push(`Required review receipt is invalid JSON: ${normalizePath(receiptPath)}`);
                }
            } else {
                input.errors.push(`Required review receipt not found: ${normalizePath(receiptPath)}`);
            }
            let findingsEvidence: ReturnType<typeof getReviewArtifactFindingsEvidence>;
            if (reviewContextRequiresFindingsOnlyArtifact(reviewContext)) {
                if (!receipt) {
                    findingsEvidence = getReviewFindingsEvidenceFromValidationArtifact(artifactPath, null);
                } else {
                    const reusedExistingReview = receipt.reused_existing_review === true;
                    const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(input.preflight, repoRoot);
                    const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint(reviewKey, input.preflight, repoRoot);
                    const validationArtifact = validateReviewFindingsValidationArtifactForReceipt({
                        receipt: receipt as unknown as Record<string, unknown>,
                        reviewArtifactPath: artifactPath,
                        expectedTaskId: input.taskId,
                        expectedReviewType: reviewKey,
                        expectedReviewOutputSha256: getReceiptString(receipt, 'review_output_sha256'),
                        expectedReviewArtifactSha256: readReviewArtifactFileSha256(artifactPath),
                        expectedReviewContextPath: reusedExistingReview ? null : reviewContextPath,
                        expectedReviewContextSha256: reusedExistingReview
                            ? getReceiptString(receipt, 'reused_from_review_context_sha256')
                            : readReviewArtifactFileSha256(reviewContextPath),
                        expectedPreflightPath: reusedExistingReview ? null : input.preflightPath,
                        expectedPreflightSha256: reusedExistingReview ? null : input.preflightSha256,
                        expectedScopeSha256: reusedExistingReview ? null : getPreflightScopeSha256(input.preflight),
                        expectedReviewScopeSha256: reusedExistingReview
                            ? getReceiptString(receipt, 'reused_from_review_scope_sha256')
                            : String(reviewScopeFingerprint.review_scope_sha256 || '').trim().toLowerCase() || null,
                        expectedCodeScopeSha256: reusedExistingReview
                            ? getReceiptString(receipt, 'reused_from_code_scope_sha256')
                            : isNonTestReviewScope(reviewKey)
                                ? String(codeScopeFingerprint.code_scope_sha256 || '').trim().toLowerCase() || null
                                : null,
                        expectedReviewTreeStateSha256: reusedExistingReview
                            ? getReceiptString(receipt, 'reused_from_review_tree_state_sha256')
                            : getReviewContextTreeStateSha256(reviewContext),
                        expectedCoverageContractSha256: reusedExistingReview
                            ? getReceiptOutputContractString(receipt, 'coverage_contract_sha256')
                            : getCoverageContractSha256(reviewContext),
                        expectedReviewContext: reviewContext,
                        requireAccepted: true
                    });
                    input.errors.push(...validationArtifact.violations);
                    const policyResolution = reusedExistingReview
                        ? resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence(receipt as unknown as Record<string, unknown>)
                        : resolveLockedReviewFindingPolicyFromPreflight(input.preflight);
                    findingsEvidence = getReviewFindingsEvidenceFromValidationArtifact(
                        artifactPath,
                        validationArtifact.valid ? validationArtifact.artifact : null,
                        policyResolution
                    );
                    if (
                        validationArtifact.valid
                        && validationArtifact.artifact
                        && validationArtifact.reference
                        && validationArtifact.artifact_sha256
                    ) {
                        const dispositionEvidence = validateReviewFindingsDispositionEvidence({
                            repoRoot,
                            receipt: receipt as unknown as Record<string, unknown>,
                            receiptPath,
                            reviewArtifactPath: artifactPath,
                            expectedTaskId: input.taskId,
                            expectedReviewType: reviewKey,
                            validationArtifact: validationArtifact.artifact,
                            validationArtifactPath: validationArtifact.reference.artifact_path,
                            validationArtifactSha256: validationArtifact.artifact_sha256,
                            policyResolution,
                            expectedReceiptPath: reusedExistingReview
                                ? getReceiptString(receipt, 'reused_from_receipt_path')
                                : null,
                            expectedReceiptSha256: reusedExistingReview
                                ? getReceiptString(receipt, 'reused_from_receipt_sha256')
                                : null,
                            preferSnapshot: reusedExistingReview
                        });
                        input.errors.push(...dispositionEvidence.violations);
                    }
                }
            } else {
                findingsEvidence = getReviewArtifactFindingsEvidence(artifactPath, artifactContent);
            }
            reviewArtifacts[reviewKey] = {
                path: normalizePath(artifactPath),
                content: artifactContent,
                reviewContextPath: normalizePath(reviewContextPath),
                reviewContext,
                receipt,
                findings_evidence: findingsEvidence
            };
            if (Array.isArray(findingsEvidence.violations) && findingsEvidence.violations.length > 0) {
                input.errors.push(...findingsEvidence.violations);
            }
        }
        const receiptReviewTrustSummary = readReviewTrustSummary(
            requiredReviewBooleans,
            input.reviewsRoot,
            input.taskId,
            input.scopeCategory,
            input.preflightSha256,
            input.preflight,
            repoRoot
        );
        const reviewGateTrustSummary = readReviewTrustSummaryFromReviewGate(
            reviewEvidence && typeof reviewEvidence === 'object' && !Array.isArray(reviewEvidence)
                ? reviewEvidence as Record<string, unknown>
                : null,
            requiredReviewBooleans,
            input.taskId,
            input.scopeCategory,
            input.preflightSha256,
            input.preflight,
            input.reviewsRoot
        );
        return {
            receiptReviewTrustSummary,
            reviewGateTrustSummary
        };
    });

    return {
        reviewArtifacts,
        receiptReviewTrustSummary,
        reviewGateTrustSummary
    };
}

export function resolveCompletionReviewTrustSummary(input: {
    requiredReviews: Record<string, unknown>;
    scopeCategory: string | null;
    receiptReviewTrustSummary: ReturnType<typeof readReviewTrustSummary>;
    reviewGateTrustSummary: ReturnType<typeof readReviewTrustSummaryFromReviewGate>;
}) {
    const hasRequiredReviews = Object.values(input.requiredReviews).some((value) => value === true);
    const requiredReviewBooleans = toRequiredReviewBooleanRecord(input.requiredReviews);
    return input.reviewGateTrustSummary
        ?? (hasRequiredReviews
            ? buildUnavailableRequiredReviewTrustSummary(requiredReviewBooleans, input.scopeCategory)
            : input.receiptReviewTrustSummary);
}
