import * as path from 'node:path';
import { countNextStepWork } from '../../core/next-step-measurement';
import { withReviewArtifactReadBarrier } from '../../gate-runtime/review-artifacts';
import { joinOrchestratorPath } from '../shared/helpers';
import { validateReviewFindingsValidationArtifactForReceipt } from '../review/review-findings-validation-artifact';
import { resolveLockedReviewFindingPolicyFromReceiptDisposition,
    reviewFindingsValidationArtifactHasBlockingFindings } from '../review/review-finding-disposition';
import { createReviewAttemptArtifactIndex, type ReviewAttemptSnapshotReader } from './review-attempt-artifact-index';

interface ReviewCycleArtifactVerdictResult { failed: boolean | null; invalidSnapshot: boolean; }
function normalizeReviewCycleSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function resolveReviewCycleReviewsRoot(repoRoot: string): string {
    return path.resolve(joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews')));
}

function validateReviewCycleReceiptSnapshotBinding(
    artifactIndex: ReviewAttemptSnapshotReader,
    taskId: string,
    reviewType: string,
    details: Record<string, unknown> | null,
    reviewArtifactSnapshotSha256: string
): boolean {
    const receiptSnapshotPath = details?.receipt_snapshot_path ?? details?.receiptSnapshotPath;
    const receiptSnapshotSha256 = normalizeReviewCycleSha256(details?.receipt_snapshot_sha256 ?? details?.receiptSnapshotSha256);
    const hasReceiptSnapshotEvidence = Boolean(String(receiptSnapshotPath || '').trim() || receiptSnapshotSha256);
    if (!hasReceiptSnapshotEvidence) {
        return true;
    }
    if (!receiptSnapshotSha256) {
        return false;
    }
    const receiptResult = artifactIndex.readJsonSnapshot(
        receiptSnapshotPath,
        `${taskId}-${reviewType}-receipt-${receiptSnapshotSha256}.json`,
        receiptSnapshotSha256
    );
    const receipt = receiptResult.record;
    if (!receipt || receipt.task_id !== taskId || receipt.review_type !== reviewType) {
        return false;
    }
    return normalizeReviewCycleSha256(receipt.review_artifact_sha256) === reviewArtifactSnapshotSha256;
}

export function resolveValidatedReviewCycleArtifactForVerdict(options: {
    artifactIndex: ReviewAttemptSnapshotReader;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    details: Record<string, unknown> | null;
}): { content: string | null; resolvedPath: string | null; invalidSnapshot: boolean } {
    const snapshotPathText = String(
        options.details?.review_artifact_snapshot_path
        || options.details?.reviewArtifactSnapshotPath
        || ''
    ).trim();
    if (!snapshotPathText) {
        return { content: null, resolvedPath: null, invalidSnapshot: false };
    }
    const snapshotSha256 = normalizeReviewCycleSha256(
        options.details?.review_artifact_snapshot_sha256
        ?? options.details?.reviewArtifactSnapshotSha256
    );
    if (!snapshotSha256) {
        return { content: null, resolvedPath: null, invalidSnapshot: true };
    }
    const recordedArtifactSha256 = normalizeReviewCycleSha256(
        options.details?.review_artifact_sha256
        ?? options.details?.reviewArtifactSha256
    );
    if (recordedArtifactSha256 && recordedArtifactSha256 !== snapshotSha256) {
        return { content: null, resolvedPath: null, invalidSnapshot: true };
    }
    const expectedFileName = `${options.taskId}-${options.reviewType}-artifact-${snapshotSha256}.md`;
    const snapshotResult = options.artifactIndex.readTextSnapshot(
        snapshotPathText,
        expectedFileName,
        snapshotSha256
    );
    if (!snapshotResult.valid || snapshotResult.content === null) {
        return { content: null, resolvedPath: null, invalidSnapshot: true };
    }
    if (!validateReviewCycleReceiptSnapshotBinding(
        options.artifactIndex,
        options.taskId,
        options.reviewType,
        options.details,
        snapshotSha256
    )) {
        return { content: null, resolvedPath: null, invalidSnapshot: true };
    }
    return {
        content: snapshotResult.content,
        resolvedPath: path.resolve(resolveReviewCycleReviewsRoot(options.repoRoot), expectedFileName),
        invalidSnapshot: false
    };
}

function readValidatedReviewCycleReceiptSnapshot(options: {
    artifactIndex: ReviewAttemptSnapshotReader;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    details: Record<string, unknown> | null;
    reviewArtifactSha256: string;
}): { receipt: Record<string, unknown> | null; invalidSnapshot: boolean } {
    const receiptSnapshotSha256 = normalizeReviewCycleSha256(
        options.details?.receipt_snapshot_sha256 ?? options.details?.receiptSnapshotSha256
    );
    const receiptSnapshotPath = options.details?.receipt_snapshot_path ?? options.details?.receiptSnapshotPath;
    if (!receiptSnapshotSha256 && !String(receiptSnapshotPath || '').trim()) {
        return { receipt: null, invalidSnapshot: false };
    }
    if (!receiptSnapshotSha256) {
        return { receipt: null, invalidSnapshot: true };
    }
    const receiptResult = options.artifactIndex.readJsonSnapshot(
        receiptSnapshotPath,
        `${options.taskId}-${options.reviewType}-receipt-${receiptSnapshotSha256}.json`,
        receiptSnapshotSha256
    );
    const receipt = receiptResult.record;
    if (!receipt || receipt.task_id !== options.taskId || receipt.review_type !== options.reviewType) {
        return { receipt: null, invalidSnapshot: true };
    }
    if (normalizeReviewCycleSha256(receipt.review_artifact_sha256) !== options.reviewArtifactSha256) {
        return { receipt: null, invalidSnapshot: true };
    }
    return { receipt, invalidSnapshot: false };
}

export function getReviewCycleValidationArtifactVerdict(options: {
    artifactIndex: ReviewAttemptSnapshotReader;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    details: Record<string, unknown> | null;
    reviewArtifactSha256: string;
}): ReviewCycleArtifactVerdictResult | null {
    const receiptResult = readValidatedReviewCycleReceiptSnapshot(options);
    if (receiptResult.invalidSnapshot) {
        return { failed: null, invalidSnapshot: true };
    }
    if (!receiptResult.receipt || !receiptResult.receipt.review_findings_validation) {
        return null;
    }
    const reusedExistingReview = receiptResult.receipt.reused_existing_review === true;
    const validationResult = validateReviewFindingsValidationArtifactForReceipt({
        receipt: receiptResult.receipt,
        reviewArtifactPath: String(options.details?.review_artifact_path ?? options.details?.reviewArtifactPath ?? ''),
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewOutputSha256: typeof receiptResult.receipt.review_output_sha256 === 'string'
            ? receiptResult.receipt.review_output_sha256
            : null,
        expectedReviewArtifactSha256: options.reviewArtifactSha256,
        expectedReviewContextPath: reusedExistingReview
            ? null
            : String(options.details?.review_context_path ?? options.details?.reviewContextPath ?? '').trim() || null,
        expectedReviewContextSha256: reusedExistingReview
            ? normalizeReviewCycleSha256(receiptResult.receipt.reused_from_review_context_sha256)
            : normalizeReviewCycleSha256(options.details?.review_context_sha256 ?? options.details?.reviewContextSha256),
        expectedPreflightSha256: reusedExistingReview
            ? null
            : normalizeReviewCycleSha256(options.details?.preflight_sha256 ?? options.details?.preflightSha256),
        expectedScopeSha256: reusedExistingReview
            ? null
            : normalizeReviewCycleSha256(options.details?.scope_sha256 ?? options.details?.scopeSha256),
        expectedReviewScopeSha256: reusedExistingReview
            ? normalizeReviewCycleSha256(receiptResult.receipt.reused_from_review_scope_sha256)
            : normalizeReviewCycleSha256(options.details?.review_scope_sha256 ?? options.details?.reviewScopeSha256),
        expectedCodeScopeSha256: reusedExistingReview
            ? normalizeReviewCycleSha256(receiptResult.receipt.reused_from_code_scope_sha256)
            : normalizeReviewCycleSha256(options.details?.code_scope_sha256 ?? options.details?.codeScopeSha256),
        expectedReviewTreeStateSha256: reusedExistingReview
            ? normalizeReviewCycleSha256(receiptResult.receipt.reused_from_review_tree_state_sha256)
            : normalizeReviewCycleSha256(options.details?.review_tree_state_sha256 ?? options.details?.reviewTreeStateSha256),
        requireAccepted: true,
        preferSnapshot: true
    });
    if (!validationResult.valid) {
        return { failed: null, invalidSnapshot: true };
    }
    const policyResolution = resolveLockedReviewFindingPolicyFromReceiptDisposition(receiptResult.receipt);
    return {
        failed: reviewFindingsValidationArtifactHasBlockingFindings(validationResult.artifact, policyResolution),
        invalidSnapshot: false
    };
}

/** Full-history enforcement for explicit audit/completion, independent of guard policy or verdict. */
export function getReviewHistoryIntegrityViolations(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    timelineEvents: readonly { event_type?: unknown; details?: unknown }[];
}): string[] {
    return withReviewArtifactReadBarrier(options.reviewsRoot, () => {
        const artifactIndex = createReviewAttemptArtifactIndex(options.reviewsRoot, options.taskId);
        const violations: string[] = [];
        for (const [sequence, event] of options.timelineEvents.entries()) {
            countNextStepWork('visit:review_history_integrity_event');
            if (event.event_type !== 'REVIEW_RECORDED') continue;
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown> : null;
            // Legacy attempts without an immutable snapshot commitment remain diagnostic-only.
            const snapshotPath = String(details?.review_artifact_snapshot_path || details?.reviewArtifactSnapshotPath || '').trim();
            if (!snapshotPath) continue;
            const reviewType = String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
            let invalid = !reviewType;
            try {
                const artifact = resolveValidatedReviewCycleArtifactForVerdict({ artifactIndex,
                    repoRoot: options.repoRoot, taskId: options.taskId, reviewType, details });
                invalid ||= artifact.invalidSnapshot;
                if (!invalid) {
                    const digest = normalizeReviewCycleSha256(details?.review_artifact_snapshot_sha256
                        ?? details?.reviewArtifactSnapshotSha256)!;
                    const validation = getReviewCycleValidationArtifactVerdict({ artifactIndex,
                        repoRoot: options.repoRoot, taskId: options.taskId, reviewType, details,
                        reviewArtifactSha256: digest });
                    invalid ||= validation?.invalidSnapshot === true;
                }
            } catch {
                invalid = true;
            }
            if (invalid) violations.push(
                `Recorded review history integrity failed at event ${sequence} (${reviewType || 'unknown lane'}): `
                + 'the committed report, receipt or findings-validation snapshot is missing, changed or has invalid bindings.'
            );
        }
        return violations;
    });
}
