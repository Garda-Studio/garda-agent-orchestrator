import * as path from 'node:path';
import {
    buildReviewCoverageContract,
    getReviewCoverageContractViolations,
    getReviewCoverageValidationSummaryContractViolations
} from '../review/review-coverage-ledger';
import { buildAuthoritativeReviewCoverageContract } from '../review-context/review-context-coverage';
import { buildReviewContextPreflightDiffExpectations } from '../review-context/review-context-contract';
import { getReviewReceiptExecutionEvidenceContractViolations } from '../review/review-evidence-contract';
import { validateReviewFindingsValidationArtifactForReceipt } from '../review/review-findings-validation-artifact';
import { resolvePersistedRemediationReviewExecutionAuthority } from '../review-remediation/review-remediation-execution-authority';
import {
    getReviewRemediationReviewContractViolations,
    type ReviewRemediationReviewContract,
    type ReviewRemediationReviewContractValidationAuthority
} from '../review-remediation/review-remediation-review-contract';
import {
    safeReadJson,
    safeReviewArtifactFileSha256
} from './task-audit-summary-review-common';

export interface ReviewCoverageAuditEntry {
    review_type: string;
    review_execution_mode: 'FULL' | 'DELTA' | null;
    review_execution_source: string | null;
    status: 'COMPLETE' | 'INCOMPLETE' | 'LEGACY_NOT_REQUIRED';
    contract_sha256: string | null;
    obligation_count: number;
    completed_obligation_count: number;
    omitted_obligation_ids: string[];
    duplicate_obligation_ids: string[];
    unknown_obligation_ids: string[];
    finding_ids: string[];
    violations: string[];
    receipt_path: string;
}

export interface ReviewCoverageAuditSummary {
    status: 'COMPLETE' | 'INCOMPLETE' | 'NOT_REQUIRED';
    entries: ReviewCoverageAuditEntry[];
    omitted_obligation_ids: string[];
    review_execution_modes: {
        full_count: number;
        delta_count: number;
        legacy_unknown_count: number;
    };
    visible_summary_line: string;
}

function eventDetails(event: Record<string, unknown>): Record<string, unknown> {
    return event.details && typeof event.details === 'object' && !Array.isArray(event.details)
        ? event.details as Record<string, unknown>
        : event;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
}

function stringValue(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nestedStringValue(value: unknown, key: string): string | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? stringValue((value as Record<string, unknown>)[key])
        : null;
}

function resolveReviewExecutionTelemetry(
    context: Record<string, unknown> | null,
    receipt: Record<string, unknown> | null
): { mode: 'FULL' | 'DELTA' | null; source: string | null } {
    const reviewExecution = context?.review_execution
        && typeof context.review_execution === 'object'
        && !Array.isArray(context.review_execution)
        ? context.review_execution as Record<string, unknown>
        : null;
    const contextMode = String(reviewExecution?.mode || '').trim().toUpperCase();
    const receiptMode = String(receipt?.review_execution_mode || '').trim().toUpperCase();
    const modeValue = contextMode === 'FULL' || contextMode === 'DELTA' ? contextMode : receiptMode;
    return {
        mode: modeValue === 'FULL' || modeValue === 'DELTA' ? modeValue : null,
        source: stringValue(reviewExecution?.source)
    };
}

export function resolveAuditedReviewCoverageScope(options: {
    fullChangedFiles: readonly string[];
    reviewExecution: ReviewRemediationReviewContract | null;
    executionAuthorityValid: boolean;
}): string[] {
    if (options.executionAuthorityValid && options.reviewExecution?.mode === 'DELTA') {
        return [...(options.reviewExecution.delta?.required_delta_targets ?? [])];
    }
    return [...options.fullChangedFiles];
}

export function buildReviewCoverageAuditSummary(options: {
    reviewsRoot: string;
    taskId: string;
    requiredReviews: Record<string, boolean>;
    orderedEvents?: readonly Record<string, unknown>[];
}): ReviewCoverageAuditSummary {
    const entries: ReviewCoverageAuditEntry[] = [];
    const repoRoot = path.resolve(options.reviewsRoot, '..', '..', '..');
    const preflightPath = path.join(options.reviewsRoot, `${options.taskId}-preflight.json`);
    const preflight = safeReadJson(preflightPath);
    const preflightSha256 = safeReviewArtifactFileSha256(preflightPath);
    for (const reviewType of Object.keys(options.requiredReviews).filter((key) => options.requiredReviews[key]).sort()) {
        const contextPath = path.join(options.reviewsRoot, `${options.taskId}-${reviewType}-review-context.json`);
        const receiptPath = path.join(options.reviewsRoot, `${options.taskId}-${reviewType}-receipt.json`);
        const context = safeReadJson(contextPath);
        const receipt = safeReadJson(receiptPath);
        const reviewExecutionTelemetry = resolveReviewExecutionTelemetry(context, receipt);
        const contextSchemaVersion = Number(context?.schema_version);
        if (Number.isInteger(contextSchemaVersion) && contextSchemaVersion > 0 && contextSchemaVersion < 3) {
            const contextSha256 = safeReviewArtifactFileSha256(contextPath);
            const receiptContextSha256 = String(receipt?.review_context_sha256 || '').trim().toLowerCase();
            const receiptPreflightSha256 = String(receipt?.preflight_sha256 || '').trim().toLowerCase();
            const recordedEventMatches = (options.orderedEvents || []).some((event) => {
                if (String(event.event_type || '').trim() !== 'REVIEW_RECORDED') {
                    return false;
                }
                const details = eventDetails(event);
                return String(details.review_type || '').trim().toLowerCase() === reviewType
                    && String(details.review_context_sha256 || '').trim().toLowerCase() === contextSha256
                    && String(details.preflight_sha256 || '').trim().toLowerCase() === preflightSha256;
            });
            if (preflight?.review_coverage_contract_required !== true
                && contextSha256 && preflightSha256
                && receiptContextSha256 === contextSha256
                && receiptPreflightSha256 === preflightSha256
                && recordedEventMatches) {
                entries.push({
                    review_type: reviewType,
                    review_execution_mode: reviewExecutionTelemetry.mode,
                    review_execution_source: reviewExecutionTelemetry.source,
                    status: 'LEGACY_NOT_REQUIRED',
                    contract_sha256: null,
                    obligation_count: 0,
                    completed_obligation_count: 0,
                    omitted_obligation_ids: [],
                    duplicate_obligation_ids: [],
                    unknown_obligation_ids: [],
                    finding_ids: [],
                    violations: [],
                    receipt_path: receiptPath
                });
                continue;
            }
        }
        const contract = context?.coverage_contract && typeof context.coverage_contract === 'object' && !Array.isArray(context.coverage_contract)
            ? context.coverage_contract as Record<string, unknown>
            : null;
        const authoritativeCoverage = preflight
            ? buildAuthoritativeReviewCoverageContract({ reviewType, preflight, repoRoot })
            : null;
        const authoritativeCoverageChangedFiles = authoritativeCoverage?.changedFiles || [];
        const violations: string[] = [];
        let authenticatedReviewExecution: ReviewRemediationReviewContract | null = null;
        if (context && preflight && preflightSha256 && contextSchemaVersion >= 4) {
            const reviewExecution = context.review_execution
                && typeof context.review_execution === 'object'
                && !Array.isArray(context.review_execution)
                ? context.review_execution as unknown as ReviewRemediationReviewContract
                : null;
            if (!reviewExecution) {
                violations.push('review context is missing the required schema-4 review_execution contract');
            } else {
                const fullReviewScope = reviewExecution.source === 'initial_full'
                    ? authoritativeCoverageChangedFiles
                    : buildReviewContextPreflightDiffExpectations(preflight, reviewType).expectedChangedFiles;
                const initialAuthority: ReviewRemediationReviewContractValidationAuthority = {
                    taskId: options.taskId,
                    reviewType,
                    preflightSha256,
                    mode: reviewExecution.mode,
                    fullReviewScope,
                    persistedDecisionSha256: null,
                    authoritativeDecisionSha256: null,
                    authoritativeClassificationSha256: null,
                    authoritativeDecision: null,
                    authoritativeClassification: null
                };
                const authority = reviewExecution.source === 'initial_full'
                    ? initialAuthority
                    : resolvePersistedRemediationReviewExecutionAuthority({
                        reviewsRoot: options.reviewsRoot,
                        taskId: options.taskId,
                        reviewType,
                        preflightSha256,
                        preflightPath,
                        fullReviewScope,
                        reviewExecution,
                        reviewContextPath: contextPath,
                        receiptPath
                    });
                if (!authority) {
                    violations.push('review context remediation review_execution authority is unavailable');
                } else {
                    const executionViolations = getReviewRemediationReviewContractViolations(reviewExecution, authority);
                    violations.push(...executionViolations
                        .map((violation) => `review context execution authority: ${violation}`));
                    if (executionViolations.length === 0) {
                        authenticatedReviewExecution = reviewExecution;
                    }
                }
            }
        }
        const coverageChangedFiles = resolveAuditedReviewCoverageScope({
            fullChangedFiles: authoritativeCoverageChangedFiles,
            reviewExecution: authenticatedReviewExecution,
            executionAuthorityValid: authenticatedReviewExecution !== null
        });
        const authoritativeContract = buildReviewCoverageContract({
            reviewType,
            changedFiles: coverageChangedFiles,
            categoryIds: authoritativeCoverage?.categoryIds
        });
        const coverage = receipt?.review_coverage && typeof receipt.review_coverage === 'object' && !Array.isArray(receipt.review_coverage)
            ? receipt.review_coverage as Record<string, unknown>
            : null;
        const receiptHash = String(coverage?.contract_sha256 || '').trim().toLowerCase();
        const obligationCount = authoritativeContract.obligation_count;
        const contractObligationIds = authoritativeContract.obligations.map((entry) => entry.id);
        const completedObligationCount = Number(coverage?.completed_obligation_count || 0);
        const reportedOmittedObligationIds = stringArray(coverage?.omitted_obligation_ids);
        const omissionAccountingValid = !authoritativeContract.required
            || completedObligationCount + reportedOmittedObligationIds.length === obligationCount;
        const omittedObligationIds = coverage && omissionAccountingValid
            ? reportedOmittedObligationIds
            : [...new Set([...reportedOmittedObligationIds, ...contractObligationIds])].sort();
        const duplicateObligationIds = stringArray(coverage?.duplicate_obligation_ids);
        const unknownObligationIds = stringArray(coverage?.unknown_obligation_ids);
        violations.push(...getReviewReceiptExecutionEvidenceContractViolations({
            reviewContext: context,
            receipt
        }));
        if (context && receipt && contextSchemaVersion >= 4) {
            const reviewArtifactPath = path.join(options.reviewsRoot, `${options.taskId}-${reviewType}.md`);
            const reusedExistingReview = receipt.reused_existing_review === true;
            const treeState = context.tree_state && typeof context.tree_state === 'object' && !Array.isArray(context.tree_state)
                ? context.tree_state as Record<string, unknown>
                : null;
            const validationArtifact = validateReviewFindingsValidationArtifactForReceipt({
                receipt,
                reviewArtifactPath,
                expectedTaskId: options.taskId,
                expectedReviewType: reviewType,
                expectedReviewOutputSha256: stringValue(receipt.review_output_sha256),
                expectedReviewArtifactSha256: safeReviewArtifactFileSha256(reviewArtifactPath),
                expectedReviewContextPath: reusedExistingReview ? null : contextPath,
                expectedReviewContextSha256: reusedExistingReview
                    ? stringValue(receipt.reused_from_review_context_sha256)
                    : safeReviewArtifactFileSha256(contextPath),
                expectedPreflightPath: reusedExistingReview ? null : preflightPath,
                expectedPreflightSha256: reusedExistingReview ? null : preflightSha256,
                expectedReviewTreeStateSha256: reusedExistingReview
                    ? stringValue(receipt.reused_from_review_tree_state_sha256)
                    : stringValue(treeState?.tree_state_sha256),
                expectedCoverageContractSha256: reusedExistingReview
                    ? nestedStringValue(receipt.review_output_contract, 'coverage_contract_sha256')
                    : stringValue(contract?.contract_sha256),
                expectedReviewContext: context,
                requireAccepted: true,
                preferSnapshot: true
            });
            violations.push(...validationArtifact.violations.map((violation) => `findings validation: ${violation}`));
        }
        if (!preflight) {
            violations.push('current preflight is missing or unreadable for authoritative coverage reconstruction');
        } else {
            violations.push(...getReviewCoverageContractViolations(contract, {
                reviewType,
                changedFiles: coverageChangedFiles,
                categoryIds: authoritativeCoverage?.categoryIds
            }));
        }
        if (!context || !Number.isInteger(contextSchemaVersion) || contextSchemaVersion < 3) {
            violations.push('review context is missing, unreadable, or has an invalid schema version');
            if (Number.isInteger(contextSchemaVersion) && contextSchemaVersion > 0 && contextSchemaVersion < 3) {
                violations.push('legacy review coverage exemption is not authenticated by receipt and lifecycle evidence');
            }
        }
        if (!String(contract?.contract_sha256 || '').trim()) violations.push('context coverage contract hash is missing');
        violations.push(...getReviewCoverageValidationSummaryContractViolations(coverage, authoritativeContract)
            .map((violation) => `receipt ${violation}`));
        const complete = violations.length === 0;
        entries.push({
            review_type: reviewType,
            review_execution_mode: reviewExecutionTelemetry.mode,
            review_execution_source: reviewExecutionTelemetry.source,
            status: complete ? 'COMPLETE' : 'INCOMPLETE',
            contract_sha256: receiptHash || null,
            obligation_count: obligationCount,
            completed_obligation_count: completedObligationCount,
            omitted_obligation_ids: omittedObligationIds,
            duplicate_obligation_ids: duplicateObligationIds,
            unknown_obligation_ids: unknownObligationIds,
            finding_ids: stringArray(coverage?.finding_ids),
            violations,
            receipt_path: receiptPath
        });
    }
    const incomplete = entries.filter((entry) => entry.status === 'INCOMPLETE');
    const omitted = [...new Set(incomplete.flatMap((entry) =>
        entry.omitted_obligation_ids.map((id) => `${entry.review_type}:${id}`)
    ))].sort();
    const status = entries.length === 0
        ? 'NOT_REQUIRED'
        : incomplete.length > 0 ? 'INCOMPLETE' : 'COMPLETE';
    const totals = entries.reduce((acc, entry) => ({
        completed: acc.completed + entry.completed_obligation_count,
        required: acc.required + entry.obligation_count
    }), { completed: 0, required: 0 });
    const executionModes = entries.reduce((acc, entry) => {
        if (entry.review_execution_mode === 'FULL') acc.full_count += 1;
        else if (entry.review_execution_mode === 'DELTA') acc.delta_count += 1;
        else acc.legacy_unknown_count += 1;
        return acc;
    }, { full_count: 0, delta_count: 0, legacy_unknown_count: 0 });
    return {
        status,
        entries,
        omitted_obligation_ids: omitted,
        review_execution_modes: executionModes,
        visible_summary_line:
            `Review coverage: status=${status}; obligations=${totals.completed}/${totals.required}; ` +
            `modes=FULL:${executionModes.full_count},DELTA:${executionModes.delta_count},legacy_unknown:${executionModes.legacy_unknown_count}; ` +
            `incomplete_reviews=${incomplete.map((entry) => entry.review_type).join(',') || 'none'}; ` +
            `omitted=${omitted.join(',') || 'none'}`
    };
}
