import * as fs from 'node:fs';
import {
    buildReviewVerdictTokenSet,
    extractReviewVerdictSectionTokenMatch,
    normalizeReviewerExecutionMode,
    normalizeReviewReceiptReviewerProvenance,
    type ReviewReceipt
} from '../../gate-runtime/review-context';
import {
    readReviewArtifactFileSha256,
    readReviewArtifactFileSnapshot,
    readReviewArtifactJsonFile,
    readReviewArtifactTextFile
} from '../../gate-runtime/review-artifacts';
import * as gateHelpers from '../shared/helpers';
import {
    computeReviewReuseCodeScopeFingerprint,
    computeReviewRelevantScopeFingerprint,
    getReviewContextReuseContractBindingMismatch,
    resolveReviewReceiptReuseContractBindings,
    type ReviewContextReuseContractBindings
} from './';
import type { ReviewDependencyTimelineEvent } from '../review/review-dependencies';
import {
    validateStrictReusedReviewEvidence,
    validateHistoricalReviewRecordedReceiptSnapshot,
    validateHistoricalReviewRecordedReviewArtifactPath,
    validateHistoricalReviewRecordedTelemetryEventMatch
} from './review-reuse-telemetry';
import {
    evaluateHiddenReviewTimingTrust,
    stripReviewTimingProvenanceTimestamps
} from '../review/review-timing-trust';
import {
    normalizeReviewFindingsValidationReceiptReference,
    validateReviewFindingsValidationArtifactForReceipt
} from '../review/review-findings-validation-artifact';
import {
    resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence,
    reviewFindingsValidationArtifactHasBlockingFindings
} from '../review/review-finding-disposition';
import { validateReviewFindingsDispositionEvidence } from '../review/review-findings-disposition-evidence';
import {
    getReviewLaneArtifactEvidenceViolations,
    isCustomReviewLaneInSnapshot
} from '../review-context/review-context-lane';

export interface HistoricalReviewReuseCandidate {
    telemetryReceiptPath: string;
    sourceReceiptPath: string;
    sourceReceiptSha256: string | null;
    sourceArtifactPath: string;
    sourceKind: 'latest_receipt' | 'historical_review_recorded';
    sourceEvent: ReviewDependencyTimelineEvent | null;
    sourceDescription: string;
}

export interface AcceptedReviewReuseCandidateEvidence {
    candidate: HistoricalReviewReuseCandidate;
    verifiedReceiptPath: string | null;
    receipt: ReviewReceipt;
    reusedFromReceiptPath: string | null;
    reusedFromReceiptSha256: string | null;
    reviewerExecutionMode: string;
    reviewerIdentity: string;
    historicalReviewerProvenance: NonNullable<ReturnType<typeof normalizeReviewReceiptReviewerProvenance>>;
    expectedContextSha256: string | null;
    expectedContextReuseSha256: string | null;
    expectedReviewTreeStateSha256: string | null;
    expectedReviewScopeSha256: string | null;
    expectedCodeScopeSha256: string | null;
    historicalReviewArtifactSha256: string;
    artifactText: string;
    contextHashMatches: boolean;
    contextReuseHashMatches: boolean;
    receiptContextReuseHashMatches: boolean;
    historicalSchema3ContextReuseHashMatches: boolean;
    testOnlyDeltaContextMismatch: boolean;
    remediationPreservedScopeMismatch: boolean;
    remediationPreservedScopeMismatchReason: string | null;
}

export function normalizeReceiptSha256(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

export function describeHistoricalReviewRecordedSource(event: ReviewDependencyTimelineEvent): string {
    const taskSequence = event.integrity?.task_sequence;
    const eventSha256 = String(event.integrity?.event_sha256 || '').trim().toLowerCase();
    return [
        'historical REVIEW_RECORDED',
        `seq=${event.sequence}`,
        Number.isInteger(taskSequence) ? `task_sequence=${taskSequence}` : null,
        eventSha256 ? `event_sha256=${eventSha256}` : null
    ].filter(Boolean).join(' ');
}

function getReviewPassVerdict(reviewType: string): string {
    const passVerdicts: Record<string, string> = {
        code: 'REVIEW PASSED',
        db: 'DB REVIEW PASSED',
        security: 'SECURITY REVIEW PASSED',
        refactor: 'REFACTOR REVIEW PASSED',
        api: 'API REVIEW PASSED',
        test: 'TEST REVIEW PASSED',
        performance: 'PERFORMANCE REVIEW PASSED',
        infra: 'INFRA REVIEW PASSED',
        dependency: 'DEPENDENCY REVIEW PASSED'
    };
    return passVerdicts[String(reviewType || '').trim().toLowerCase()] || `${String(reviewType || '').trim().toUpperCase()} REVIEW PASSED`;
}

function artifactHasPassVerdict(reviewType: string, artifactText: string): boolean {
    const tokenMatch = extractReviewVerdictSectionTokenMatch(
        artifactText,
        buildReviewVerdictTokenSet(reviewType, getReviewPassVerdict(reviewType))
    );
    return tokenMatch?.outcome === 'pass';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getReceiptRecordString(receipt: ReviewReceipt, key: string): string | null {
    const value = (receipt as unknown as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getReceiptOutputContract(receipt: ReviewReceipt): Record<string, unknown> | null {
    const contract = (receipt as unknown as Record<string, unknown>).review_output_contract;
    return isRecord(contract) ? contract : null;
}

function getReceiptOutputContractString(receipt: ReviewReceipt, key: string): string | null {
    const value = getReceiptOutputContract(receipt)?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function receiptRequiresFindingsValidation(receipt: ReviewReceipt): boolean {
    const receiptRecord = receipt as unknown as Record<string, unknown>;
    const format = String(
        receiptRecord.review_output_format
        || getReceiptOutputContract(receipt)?.format
        || ''
    ).trim().toLowerCase();
    return format === 'findings_json'
        || normalizeReviewFindingsValidationReceiptReference(receiptRecord.review_findings_validation) !== null;
}

function getReceiptBoundFindingsReviewArtifactPath(receipt: ReviewReceipt): string | null {
    const reference = normalizeReviewFindingsValidationReceiptReference(
        (receipt as unknown as Record<string, unknown>).review_findings_validation
    );
    if (!reference?.artifact_path.endsWith('-findings-validation.json')) {
        return null;
    }
    return reference.artifact_path.replace(/-findings-validation\.json$/u, '.md');
}

function validateFindingsValidationForHistoricalReuse(options: {
    repoRoot: string;
    receipt: ReviewReceipt;
    receiptPath: string;
    receiptSha256: string;
    taskId: string;
    reviewType: string;
    reviewArtifactPath: string;
    artifactSha256: string;
    sourceReceiptContextSha256: string | null;
    sourceReceiptReviewTreeStateSha256: string | null;
    sourceReceiptReviewScopeSha256: string | null;
    sourceReceiptCodeScopeSha256: string | null;
    expectedContextSha256: string | null;
    expectedReviewTreeStateSha256: string | null;
    expectedReviewScopeSha256: string | null;
    expectedCodeScopeSha256: string | null;
    preferSnapshot: boolean;
    allowLegacyMissingExecutionBinding: boolean;
}): string | null {
    const reusedExistingReview = options.receipt.reused_existing_review === true;
    const validation = validateReviewFindingsValidationArtifactForReceipt({
        receipt: options.receipt as unknown as Record<string, unknown>,
        reviewArtifactPath: options.reviewArtifactPath,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewOutputSha256: getReceiptRecordString(options.receipt, 'review_output_sha256')
            || getReceiptOutputContractString(options.receipt, 'raw_output_sha256'),
        expectedReviewArtifactSha256: options.artifactSha256,
        expectedReviewContextSha256: reusedExistingReview
            ? options.expectedContextSha256
            : options.sourceReceiptContextSha256,
        expectedPreflightSha256: reusedExistingReview
            ? null
            : getReceiptRecordString(options.receipt, 'preflight_sha256'),
        expectedScopeSha256: reusedExistingReview
            ? null
            : getReceiptRecordString(options.receipt, 'scope_sha256'),
        expectedReviewScopeSha256: reusedExistingReview
            ? options.expectedReviewScopeSha256
            : options.sourceReceiptReviewScopeSha256,
        expectedCodeScopeSha256: reusedExistingReview
            ? options.expectedCodeScopeSha256
            : options.sourceReceiptCodeScopeSha256,
        expectedReviewTreeStateSha256: reusedExistingReview
            ? options.expectedReviewTreeStateSha256
            : options.sourceReceiptReviewTreeStateSha256,
        expectedCoverageContractSha256: getReceiptOutputContractString(options.receipt, 'coverage_contract_sha256'),
        requireAccepted: true,
        preferSnapshot: options.preferSnapshot,
        allowLegacyMissingExecutionBinding: options.allowLegacyMissingExecutionBinding
    });
    if (!validation.valid) {
        return `prior findings validation artifact is invalid: ${validation.violations.join(' ')}`;
    }
    if (!validation.artifact || !validation.reference || !validation.artifact_sha256) {
        return 'prior findings validation artifact is missing complete authenticated evidence';
    }
    const policyResolution = resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence(
        options.receipt as unknown as Record<string, unknown>
    );
    const dispositionReceiptPath = reusedExistingReview
        ? getReceiptRecordString(options.receipt, 'reused_from_receipt_path') || options.receiptPath
        : options.receiptPath;
    const dispositionReceiptSha256 = reusedExistingReview
        ? normalizeReceiptSha256(options.receipt.reused_from_receipt_sha256) || options.receiptSha256
        : options.receiptSha256;
    const disposition = validateReviewFindingsDispositionEvidence({
        repoRoot: options.repoRoot,
        receipt: options.receipt as unknown as Record<string, unknown>,
        receiptPath: options.receiptPath,
        reviewArtifactPath: options.reviewArtifactPath,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        validationArtifact: validation.artifact,
        validationArtifactPath: validation.reference.artifact_path,
        validationArtifactSha256: validation.artifact_sha256,
        policyResolution,
        expectedReceiptPath: dispositionReceiptPath,
        expectedReceiptSha256: dispositionReceiptSha256,
        preferSnapshot: options.preferSnapshot
    });
    if (!disposition.valid) {
        return `prior findings disposition evidence is not satisfied: ${disposition.violations.join(' ')}`;
    }
    if (reviewFindingsValidationArtifactHasBlockingFindings(
        validation.artifact,
        policyResolution
    )) {
        return 'prior findings validation artifact contains policy-blocking active findings or residual risks';
    }
    return null;
}

function normalizeLowerText(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function readVerifiedCandidateReceipt(
    candidate: HistoricalReviewReuseCandidate,
    repoRoot: string,
    taskId: string,
    reviewType: string,
    sourceEventOverride: ReviewDependencyTimelineEvent | null = null
): {
    receipt: ReviewReceipt | null;
    receiptPath: string | null;
    receiptSha256: string | null;
    reason: string | null;
} {
    let receiptPath = candidate.sourceReceiptPath;
    const sourceEvent = sourceEventOverride || candidate.sourceEvent;
    if (candidate.sourceKind === 'historical_review_recorded' || sourceEventOverride) {
        const details = isRecord(sourceEvent?.details)
            ? sourceEvent?.details as Record<string, unknown>
            : null;
        if (!details) {
            return {
                receipt: null,
                receiptPath: null,
                receiptSha256: null,
                reason: 'historical REVIEW_RECORDED telemetry is missing receipt details'
            };
        }
        const snapshotValidation = validateHistoricalReviewRecordedReceiptSnapshot(details, repoRoot, { taskId, reviewType });
        if (!snapshotValidation.valid) {
            return {
                receipt: null,
                receiptPath: null,
                receiptSha256: null,
                reason: snapshotValidation.message
            };
        }
        receiptPath = snapshotValidation.resolvedPath;
    } else if (!fs.existsSync(receiptPath) || !fs.statSync(receiptPath).isFile()) {
        return {
            receipt: null,
            receiptPath: null,
            receiptSha256: null,
            reason: `latest mutable receipt is missing at ${gateHelpers.normalizePath(receiptPath)}`
        };
    }
    try {
        const receipt = readReviewArtifactJsonFile(receiptPath) as ReviewReceipt;
        const fileSnapshot = readReviewArtifactFileSnapshot(receiptPath);
        return {
            receipt,
            receiptPath,
            receiptSha256: String(
                (fileSnapshot.active
                    ? (fileSnapshot.valid ? fileSnapshot.sha256 : null)
                    : gateHelpers.fileSha256(receiptPath)) || ''
            ).trim().toLowerCase() || null,
            reason: null
        };
    } catch {
        return {
            receipt: null,
            receiptPath: null,
            receiptSha256: null,
            reason: candidate.sourceKind === 'historical_review_recorded'
                ? 'historical review receipt snapshot is not valid JSON'
                : 'latest mutable receipt is not valid JSON'
        };
    }
}

function readVerifiedCandidateReviewArtifact(
    candidate: HistoricalReviewReuseCandidate,
    repoRoot: string,
    taskId: string,
    reviewType: string,
    sourceEventOverride: ReviewDependencyTimelineEvent | null = null
): { artifactPath: string | null; artifactText: string | null; reason: string | null } {
    let artifactPath = candidate.sourceArtifactPath;
    const sourceEvent = sourceEventOverride || candidate.sourceEvent;
    if (candidate.sourceKind === 'historical_review_recorded' || sourceEventOverride) {
        const details = isRecord(sourceEvent?.details)
            ? sourceEvent?.details as Record<string, unknown>
            : null;
        if (!details) {
            return {
                artifactPath: null,
                artifactText: null,
                reason: 'historical REVIEW_RECORDED telemetry is missing review artifact details'
            };
        }
        const artifactValidation = validateHistoricalReviewRecordedReviewArtifactPath(details, repoRoot, {
            taskId,
            reviewType
        });
        if (!artifactValidation.valid) {
            return {
                artifactPath: artifactValidation.resolvedPath,
                artifactText: null,
                reason: artifactValidation.message
            };
        }
        artifactPath = artifactValidation.resolvedPath;
    }
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return {
            artifactPath,
            artifactText: null,
            reason: `prior review artifact is missing at ${gateHelpers.normalizePath(artifactPath)}`
        };
    }
    try {
        return {
            artifactPath,
            artifactText: readReviewArtifactTextFile(artifactPath),
            reason: null
        };
    } catch {
        return {
            artifactPath,
            artifactText: null,
            reason: `prior review artifact is unreadable at ${gateHelpers.normalizePath(artifactPath)}`
        };
    }
}

function findHistoricalReviewRecordedEventForLatestReceiptCandidate(options: {
    candidate: HistoricalReviewReuseCandidate;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    latestCompilePassSequence: number;
}): { event: ReviewDependencyTimelineEvent | null; reason: string | null } {
    const receiptSha256 = normalizeReceiptSha256(options.candidate.sourceReceiptSha256);
    if (!receiptSha256) {
        return {
            event: null,
            reason: 'latest mutable receipt hash is unavailable'
        };
    }
    const expectedReceiptPath = gateHelpers.normalizePath(options.candidate.telemetryReceiptPath).toLowerCase();
    for (let index = options.timelineEvents.length - 1; index >= 0; index -= 1) {
        const event = options.timelineEvents[index];
        if (
            event.sequence >= options.latestCompilePassSequence
            || event.event_type !== 'REVIEW_RECORDED'
            || !isRecord(event.details)
        ) {
            continue;
        }
        const details = event.details;
        if (
            normalizeLowerText(details.review_type ?? details.reviewType) !== normalizeLowerText(options.reviewType)
            || (String(details.task_id ?? details.taskId ?? '').trim()
                && String(details.task_id ?? details.taskId).trim() !== options.taskId)
            || gateHelpers.normalizePath(details.receipt_path ?? details.receiptPath ?? '').toLowerCase() !== expectedReceiptPath
        ) {
            continue;
        }
        const recordedReceiptSha256 = normalizeReceiptSha256(details.receipt_sha256 ?? details.receiptSha256);
        if (recordedReceiptSha256 !== receiptSha256) {
            continue;
        }
        const snapshotValidation = validateHistoricalReviewRecordedReceiptSnapshot(details, options.repoRoot, {
            taskId: options.taskId,
            reviewType: options.reviewType
        });
        if (!snapshotValidation.valid) {
            return {
                event: null,
                reason: snapshotValidation.message
            };
        }
        return { event, reason: null };
    }
    return {
        event: null,
        reason: 'latest mutable receipt hash does not match historical REVIEW_RECORDED telemetry'
    };
}

export function validateHistoricalReviewReuseCandidate(options: {
    candidate: HistoricalReviewReuseCandidate;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPayload: Record<string, unknown>;
    previousReviewContextReuseSha256?: string | null;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    latestCompilePassSequence: number;
    nonTestReviewScope: boolean;
    codeScopeFingerprint: ReturnType<typeof computeReviewReuseCodeScopeFingerprint>;
    reviewScopeFingerprint: ReturnType<typeof computeReviewRelevantScopeFingerprint>;
    hasCurrentCodeScope: boolean;
    hasCurrentReviewScope: boolean;
    currentCodeScopeSha256: string | null;
    currentReviewContextSha256: string | null;
    currentContextReuseSha256: string | null;
    currentSchema3ContextReuseSha256?: string | null;
    currentReviewContextContractBindings: ReviewContextReuseContractBindings;
    allowTestOnlyDeltaContextMismatch?: boolean;
    remediationPreservedScopeMismatchReason?: string | null;
}): { accepted: true; evidence: AcceptedReviewReuseCandidateEvidence } | { accepted: false; reason: string } {
    const sourceEventResolution = options.candidate.sourceKind === 'latest_receipt'
        ? findHistoricalReviewRecordedEventForLatestReceiptCandidate({
            candidate: options.candidate,
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            timelineEvents: options.timelineEvents,
            latestCompilePassSequence: options.latestCompilePassSequence
        })
        : {
            event: options.candidate.sourceEvent,
            reason: null
        };
    if (!sourceEventResolution.event) {
        return {
            accepted: false,
            reason: sourceEventResolution.reason || 'historical REVIEW_RECORDED telemetry is missing for this receipt'
        };
    }

    const verifiedReceipt = readVerifiedCandidateReceipt(
        options.candidate,
        options.repoRoot,
        options.taskId,
        options.reviewType,
        sourceEventResolution.event
    );
    if (!verifiedReceipt.receipt) {
        return {
            accepted: false,
            reason: verifiedReceipt.reason || 'historical review receipt could not be verified'
        };
    }

    const receipt = verifiedReceipt.receipt;
    const sourceReceiptSha256 = normalizeReceiptSha256(
        verifiedReceipt.receiptSha256 || options.candidate.sourceReceiptSha256
    );
    const reviewerExecutionMode = normalizeReviewerExecutionMode(receipt.reviewer_execution_mode);
    const reviewerIdentity = String(receipt.reviewer_identity || '').trim() || null;
    const historicalReviewerProvenance = receipt.reviewer_provenance == null
        ? null
        : normalizeReviewReceiptReviewerProvenance(receipt.reviewer_provenance);
    const historicalTrustLevel = String(receipt.trust_level || '').trim().toUpperCase();
    const sourceReceiptContextSha256 = normalizeReceiptSha256(receipt.review_context_sha256);
    const sourceReceiptContextReuseSha256 = normalizeReceiptSha256(receipt.review_context_reuse_sha256)
        || normalizeReceiptSha256(options.previousReviewContextReuseSha256);
    const sourceReceiptReviewScopeSha256 = normalizeReceiptSha256(receipt.review_scope_sha256);
    const sourceReceiptCodeScopeSha256 = normalizeReceiptSha256(receipt.code_scope_sha256);
    const historicalProvenanceContextSha256 = historicalReviewerProvenance?.attestation_type === 'reviewer_invocation_attestation'
        ? historicalReviewerProvenance.review_context_sha256
        : null;
    const historicalProvenanceReviewTreeStateSha256 = historicalReviewerProvenance?.attestation_type === 'reviewer_invocation_attestation'
        ? historicalReviewerProvenance.review_tree_state_sha256 || null
        : null;
    const sourceReceiptReviewTreeStateSha256 = normalizeReceiptSha256(receipt.review_tree_state_sha256);
    const sourceReceiptPath = gateHelpers.normalizePath(options.candidate.telemetryReceiptPath);
    const reusedFromReceiptPath = receipt.reused_existing_review === true && receipt.reused_from_receipt_path
        ? gateHelpers.normalizePath(receipt.reused_from_receipt_path)
        : sourceReceiptPath;
    const reusedFromReceiptSha256 = receipt.reused_existing_review === true
        ? normalizeReceiptSha256(receipt.reused_from_receipt_sha256) || sourceReceiptSha256
        : sourceReceiptSha256;
    const reusedFromReviewTreeStateSha256 = normalizeReceiptSha256(receipt.reused_from_review_tree_state_sha256);
    const expectedContextSha256 = receipt.reused_existing_review === true
        ? normalizeReceiptSha256(receipt.reused_from_review_context_sha256) || historicalProvenanceContextSha256
        : sourceReceiptContextSha256;
    const expectedContextReuseSha256 = receipt.reused_existing_review === true
        ? normalizeReceiptSha256(receipt.reused_from_review_context_reuse_sha256) || sourceReceiptContextReuseSha256
        : sourceReceiptContextReuseSha256;
    const expectedReviewTreeStateSha256 = receipt.reused_existing_review === true
        ? reusedFromReviewTreeStateSha256
        : sourceReceiptReviewTreeStateSha256;
    const expectedReviewScopeSha256 = receipt.reused_existing_review === true
        ? normalizeReceiptSha256(receipt.reused_from_review_scope_sha256) || sourceReceiptReviewScopeSha256
        : sourceReceiptReviewScopeSha256;
    const expectedCodeScopeSha256 = receipt.reused_existing_review === true
        ? normalizeReceiptSha256(receipt.reused_from_code_scope_sha256) || sourceReceiptCodeScopeSha256
        : sourceReceiptCodeScopeSha256;
    const remediationPreservedScopeMismatchReason = String(options.remediationPreservedScopeMismatchReason || '').trim() || null;
    const documentationReview = options.codeScopeFingerprint.documentation_review;
    const acceptableContextReuseHashes = [
        expectedContextReuseSha256,
        // Regenerated documentation contexts are mutable; receipt-bound hashes authenticate the reviewed bytes.
        documentationReview
            ? null
            : String(options.previousReviewContextReuseSha256 || '').trim().toLowerCase() || null
    ].filter((value): value is string => !!value);
    const historicalSchema3ContextReuseHashMatches = !!options.currentSchema3ContextReuseSha256
        && acceptableContextReuseHashes.includes(options.currentSchema3ContextReuseSha256);

    if (isCustomReviewLaneInSnapshot(options.preflightPayload, options.reviewType)) {
        try {
            const laneEvidenceViolations = getReviewLaneArtifactEvidenceViolations({
                artifact: receipt as unknown as Record<string, unknown>,
                preflight: options.preflightPayload,
                reviewType: options.reviewType,
                label: `Prior review receipt for '${options.reviewType}'`
            });
            if (laneEvidenceViolations.length > 0) {
                return { accepted: false, reason: laneEvidenceViolations.join(' ') };
            }
        } catch (error: unknown) {
            return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
        }
    }

    if (receipt.task_id !== options.taskId || receipt.review_type !== options.reviewType) {
        return { accepted: false, reason: 'prior review receipt task id or review type does not match current request' };
    }
    if (!sourceReceiptSha256) {
        return { accepted: false, reason: 'prior review receipt sha256 is unavailable' };
    }
    if (!reviewerExecutionMode || !reviewerIdentity || !sourceReceiptContextSha256 || !expectedContextSha256) {
        return { accepted: false, reason: 'prior review receipt is missing reviewer identity or review-context hash' };
    }
    if (!sourceReceiptReviewTreeStateSha256) {
        return { accepted: false, reason: 'prior review receipt is missing review_tree_state_sha256' };
    }
    if (!expectedReviewTreeStateSha256) {
        return { accepted: false, reason: 'prior review receipt is missing historical review-tree-state hash' };
    }
    if (receipt.reused_existing_review === true && !reusedFromReviewTreeStateSha256) {
        return { accepted: false, reason: 'prior reused review receipt is missing reused_from_review_tree_state_sha256' };
    }
    if (reviewerExecutionMode !== 'delegated_subagent' || !reviewerIdentity.startsWith('agent:') || !historicalReviewerProvenance) {
        return { accepted: false, reason: 'prior review receipt is not delegated-subagent evidence with historical provenance' };
    }
    const expectedInvocationContextSha256 = historicalProvenanceContextSha256;
    if (!expectedInvocationContextSha256) {
        return { accepted: false, reason: 'prior review provenance is missing the delegated invocation review-context hash' };
    }
    if (historicalProvenanceReviewTreeStateSha256 !== expectedReviewTreeStateSha256) {
        return {
            accepted: false,
            reason: 'prior review provenance does not bind to the historical review-tree-state hash'
        };
    }
    if (
        historicalTrustLevel !== 'INDEPENDENT_AUDITED'
        || historicalReviewerProvenance.attestation_type !== 'reviewer_invocation_attestation'
        || historicalReviewerProvenance.task_id !== options.taskId
        || historicalReviewerProvenance.review_type !== options.reviewType
        || historicalReviewerProvenance.reviewer_execution_mode !== reviewerExecutionMode
        || historicalReviewerProvenance.reviewer_identity !== reviewerIdentity
        || historicalReviewerProvenance.review_context_sha256 !== expectedInvocationContextSha256
    ) {
        return { accepted: false, reason: 'prior review provenance does not bind to the prior delegated reviewer invocation' };
    }

    const verifiedArtifact = readVerifiedCandidateReviewArtifact(
        options.candidate,
        options.repoRoot,
        options.taskId,
        options.reviewType,
        sourceEventResolution.event
    );
    if (!verifiedArtifact.artifactPath || verifiedArtifact.artifactText == null) {
        return {
            accepted: false,
            reason: verifiedArtifact.reason || 'prior review artifact could not be verified'
        };
    }
    const artifactText = verifiedArtifact.artifactText;
    const historicalReviewArtifactSha256 = String(readReviewArtifactFileSha256(verifiedArtifact.artifactPath) || '')
        .trim()
        .toLowerCase();
    if (receiptRequiresFindingsValidation(receipt)) {
        const sourceEventDetails = isRecord(sourceEventResolution.event?.details)
            ? sourceEventResolution.event?.details as Record<string, unknown>
            : null;
        const receiptBoundReviewArtifactPath = getReceiptBoundFindingsReviewArtifactPath(receipt);
        const mutableReviewArtifactPath = String(
            receiptBoundReviewArtifactPath
            ?? sourceEventDetails?.review_artifact_path
            ?? sourceEventDetails?.reviewArtifactPath
            ?? verifiedArtifact.artifactPath
        ).trim();
        const findingsValidationReuseReason = validateFindingsValidationForHistoricalReuse({
            repoRoot: options.repoRoot,
            receipt,
            receiptPath: sourceReceiptPath,
            receiptSha256: sourceReceiptSha256,
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewArtifactPath: mutableReviewArtifactPath,
            artifactSha256: historicalReviewArtifactSha256,
            sourceReceiptContextSha256,
            sourceReceiptReviewTreeStateSha256,
            sourceReceiptReviewScopeSha256,
            sourceReceiptCodeScopeSha256,
            expectedContextSha256,
            expectedReviewTreeStateSha256,
            expectedReviewScopeSha256,
            expectedCodeScopeSha256,
            preferSnapshot: options.candidate.sourceKind === 'historical_review_recorded',
            allowLegacyMissingExecutionBinding: historicalSchema3ContextReuseHashMatches
        });
        if (findingsValidationReuseReason) {
            return { accepted: false, reason: findingsValidationReuseReason };
        }
    } else if (!artifactHasPassVerdict(options.reviewType, artifactText)) {
        return { accepted: false, reason: 'prior review artifact is not a PASS verdict' };
    }
    if (String(receipt.review_artifact_sha256 || '').trim().toLowerCase() !== historicalReviewArtifactSha256) {
        return { accepted: false, reason: 'prior review artifact hash no longer matches the receipt' };
    }
    if (
        options.nonTestReviewScope
        && options.hasCurrentCodeScope
        && (!expectedCodeScopeSha256 || expectedCodeScopeSha256 !== options.currentCodeScopeSha256)
    ) {
        return {
            accepted: false,
            reason:
                `non-test scope changed since the prior review (expected code_scope_sha256=${expectedCodeScopeSha256 || 'missing'}, ` +
                `current=${options.currentCodeScopeSha256 || 'missing'})`
        };
    }
    if (
        !options.nonTestReviewScope
        && options.hasCurrentReviewScope
        && (!expectedReviewScopeSha256
            || expectedReviewScopeSha256 !== String(options.reviewScopeFingerprint.review_scope_sha256 || '').trim().toLowerCase())
    ) {
        return {
            accepted: false,
            reason:
                `review-relevant scope changed since the prior review (expected review_scope_sha256=${expectedReviewScopeSha256 || 'missing'}, ` +
                `current=${String(options.reviewScopeFingerprint.review_scope_sha256 || '').trim().toLowerCase() || 'missing'})`
        };
    }

    const historicalInvocationEvent = options.timelineEvents.find((entry) => (
        entry.sequence < options.latestCompilePassSequence
        && entry.event_type === 'REVIEWER_INVOCATION_ATTESTED'
        && entry.integrity
        && entry.integrity.task_sequence === historicalReviewerProvenance.task_sequence
        && String(entry.integrity.event_sha256 || '').trim().toLowerCase() === historicalReviewerProvenance.event_sha256
        && (entry.integrity.prev_event_sha256 == null
            ? null
            : String(entry.integrity.prev_event_sha256).trim().toLowerCase() || null) === historicalReviewerProvenance.prev_event_sha256
        && String(entry.details?.task_id || entry.details?.taskId || '').trim() === options.taskId
        && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === options.reviewType
        && String(entry.details?.reviewer_execution_mode || entry.details?.reviewerExecutionMode || '').trim() === reviewerExecutionMode
        && (
            String(entry.details?.reviewer_identity || entry.details?.reviewerIdentity || '').trim()
            || String(entry.details?.reviewer_session_id || entry.details?.reviewerSessionId || '').trim()
        ) === reviewerIdentity
        && String(entry.details?.review_context_sha256 || entry.details?.reviewContextSha256 || '').trim().toLowerCase() === expectedInvocationContextSha256
        && String(entry.details?.review_tree_state_sha256 || entry.details?.reviewTreeStateSha256 || '').trim().toLowerCase() === expectedReviewTreeStateSha256
        && String(entry.details?.routing_event_sha256 || entry.details?.routingEventSha256 || '').trim().toLowerCase() === historicalReviewerProvenance.routing_event_sha256
    ));
    if (!historicalInvocationEvent) {
        return {
            accepted: false,
            reason: 'historical delegated reviewer invocation telemetry is missing or does not match the receipt'
        };
    }

    const historicalRecordedEvent = validateHistoricalReviewRecordedTelemetryEventMatch({
        event: sourceEventResolution.event,
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        receiptPath: options.candidate.telemetryReceiptPath,
        reviewContextSha256: sourceReceiptContextSha256,
        reviewContextReuseSha256: sourceReceiptContextReuseSha256,
        reviewTreeStateSha256: sourceReceiptReviewTreeStateSha256,
        reviewScopeSha256: sourceReceiptReviewScopeSha256,
        codeScopeSha256: sourceReceiptCodeScopeSha256,
        reviewArtifactSha256: historicalReviewArtifactSha256,
        reusedFromReceiptPath: receipt.reused_existing_review === true ? reusedFromReceiptPath : undefined,
        reusedFromReceiptSha256: receipt.reused_existing_review === true ? reusedFromReceiptSha256 : undefined,
        reusedFromReviewContextSha256: receipt.reused_existing_review === true ? expectedContextSha256 : undefined,
        reusedFromReviewContextReuseSha256: receipt.reused_existing_review === true ? expectedContextReuseSha256 : undefined,
        reusedFromReviewTreeStateSha256: receipt.reused_existing_review === true ? expectedReviewTreeStateSha256 : undefined,
        reusedFromReviewScopeSha256: receipt.reused_existing_review === true ? expectedReviewScopeSha256 : undefined,
        reusedFromCodeScopeSha256: receipt.reused_existing_review === true ? expectedCodeScopeSha256 : undefined,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerProvenance: { ...historicalReviewerProvenance },
        maxEventSequenceExclusive: options.latestCompilePassSequence,
        verifyReceiptSnapshot: true
    }).matched;
    if (!historicalRecordedEvent) {
        return { accepted: false, reason: 'historical REVIEW_RECORDED telemetry does not match the prior receipt' };
    }

    let historicalRecordedEventDetails = isRecord(sourceEventResolution.event?.details)
        ? sourceEventResolution.event?.details as Record<string, unknown>
        : null;
    if (receipt.reused_existing_review === true) {
        const strictReuseValidation = validateStrictReusedReviewEvidence({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            events: options.timelineEvents,
            receiptPath: options.candidate.telemetryReceiptPath,
            receiptSha256: sourceReceiptSha256,
            reviewContextSha256: sourceReceiptContextSha256,
            reviewContextReuseSha256: sourceReceiptContextReuseSha256,
            reviewTreeStateSha256: sourceReceiptReviewTreeStateSha256,
            reviewScopeSha256: sourceReceiptReviewScopeSha256,
            codeScopeSha256: sourceReceiptCodeScopeSha256,
            reviewArtifactSha256: historicalReviewArtifactSha256,
            reusedFromReceiptPath,
            reusedFromReceiptSha256,
            reusedFromReviewContextSha256: expectedContextSha256,
            reusedFromReviewContextReuseSha256: expectedContextReuseSha256,
            reusedFromReviewTreeStateSha256: expectedReviewTreeStateSha256,
            reusedFromReviewScopeSha256: expectedReviewScopeSha256,
            reusedFromCodeScopeSha256: expectedCodeScopeSha256,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewerProvenance: { ...historicalReviewerProvenance },
            latestCompileEventSequence: options.latestCompilePassSequence
        });
        if (!strictReuseValidation.valid) {
            return {
                accepted: false,
                reason: 'historical reused review evidence is missing strict reused evidence telemetry: '
                    + strictReuseValidation.reason
            };
        }
        historicalRecordedEventDetails = strictReuseValidation.historicalReviewRecordedDetails;
    }
    const hiddenTimingTrust = evaluateHiddenReviewTimingTrust({
        reviewType: options.reviewType,
        reusedExistingReview: receipt.reused_existing_review === true,
        reviewerProvenance: stripReviewTimingProvenanceTimestamps(historicalReviewerProvenance),
        reviewResultRecordedAtUtc: typeof receipt.review_result_recorded_at_utc === 'string'
            ? receipt.review_result_recorded_at_utc
            : null,
        recordedAtUtc: typeof receipt.recorded_at_utc === 'string' ? receipt.recorded_at_utc : null,
        reviewOutputSourceMtimeUtc: typeof receipt.review_output_source_mtime_utc === 'string'
            ? receipt.review_output_source_mtime_utc
            : null,
        strictReusedReviewRecordedDetails: historicalRecordedEventDetails,
        timelineEvents: options.timelineEvents,
        latestCompileSequence: options.latestCompilePassSequence
    });
    if (!hiddenTimingTrust.trusted) {
        return {
            accepted: false,
            reason: hiddenTimingTrust.message || 'historical review evidence failed hidden review timing trust validation'
        };
    }

    const contextHashMatches = !!expectedContextSha256 && expectedContextSha256 === options.currentReviewContextSha256;
    const receiptContextReuseHashMatches = !!options.currentContextReuseSha256
        && !!expectedContextReuseSha256
        && expectedContextReuseSha256 === options.currentContextReuseSha256;
    const contextReuseHashMatches = [
        options.currentContextReuseSha256,
        options.currentSchema3ContextReuseSha256
    ].some((value) => !!value && acceptableContextReuseHashes.includes(value));
    const currentReviewScopeSha256 = String(options.reviewScopeFingerprint.review_scope_sha256 || '').trim().toLowerCase() || null;
    const codeScopeStillMatches = !!expectedCodeScopeSha256
        && !!options.currentCodeScopeSha256
        && expectedCodeScopeSha256 === options.currentCodeScopeSha256;
    const reviewScopeChangedAfterPriorReview = !!expectedReviewScopeSha256
        && !!currentReviewScopeSha256
        && expectedReviewScopeSha256 !== currentReviewScopeSha256;
    const testOnlyDeltaContextMismatch = !contextHashMatches
        && !contextReuseHashMatches
        && options.allowTestOnlyDeltaContextMismatch === true
        && options.nonTestReviewScope
        && options.hasCurrentCodeScope
        && codeScopeStillMatches
        && reviewScopeChangedAfterPriorReview;
    const remediationPreservedScopeMismatch = !contextHashMatches
        && !contextReuseHashMatches
        && !!remediationPreservedScopeMismatchReason
        && options.nonTestReviewScope
        && options.hasCurrentCodeScope
        && codeScopeStillMatches;
    if (!contextHashMatches && !receiptContextReuseHashMatches) {
        const contractBindingMismatch = getReviewContextReuseContractBindingMismatch(
            resolveReviewReceiptReuseContractBindings(receipt as unknown as Record<string, unknown>),
            options.currentReviewContextContractBindings
        );
        if (contractBindingMismatch) {
            return {
                accepted: false,
                reason: contractBindingMismatch
            };
        }
    }
    if (!contextHashMatches && !contextReuseHashMatches) {
        if (testOnlyDeltaContextMismatch || remediationPreservedScopeMismatch) {
            return {
                accepted: true,
                evidence: {
                    candidate: options.candidate,
                    verifiedReceiptPath: verifiedReceipt.receiptPath,
                    receipt,
                    reusedFromReceiptPath,
                    reusedFromReceiptSha256,
                    reviewerExecutionMode,
                    reviewerIdentity,
                    historicalReviewerProvenance,
                    expectedContextSha256,
                    expectedContextReuseSha256,
                    expectedReviewTreeStateSha256,
                    expectedReviewScopeSha256,
                    expectedCodeScopeSha256,
                    historicalReviewArtifactSha256,
                    artifactText,
                    contextHashMatches,
                    contextReuseHashMatches,
                    receiptContextReuseHashMatches,
                    historicalSchema3ContextReuseHashMatches,
                    testOnlyDeltaContextMismatch,
                    remediationPreservedScopeMismatch,
                    remediationPreservedScopeMismatchReason
                }
            };
        }
        return {
            accepted: false,
            reason:
                `review context inputs changed (context_sha256_match=${contextHashMatches}; ` +
                `reuse_sha256_match=${contextReuseHashMatches})`
        };
    }

    return {
        accepted: true,
        evidence: {
            candidate: options.candidate,
            verifiedReceiptPath: verifiedReceipt.receiptPath,
            receipt,
            reusedFromReceiptPath,
            reusedFromReceiptSha256,
            reviewerExecutionMode,
            reviewerIdentity,
            historicalReviewerProvenance,
            expectedContextSha256,
            expectedContextReuseSha256,
            expectedReviewTreeStateSha256,
            expectedReviewScopeSha256,
            expectedCodeScopeSha256,
            historicalReviewArtifactSha256,
            artifactText,
            contextHashMatches,
            contextReuseHashMatches,
            receiptContextReuseHashMatches,
            historicalSchema3ContextReuseHashMatches,
            testOnlyDeltaContextMismatch,
            remediationPreservedScopeMismatch,
            remediationPreservedScopeMismatchReason
        }
    };
}
