import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    buildReviewVerdictTokenSet,
    extractReviewVerdictSectionTokenMatch,
    normalizeReviewReceiptReviewerProvenance,
    normalizeReviewerExecutionMode,
    type ReviewReceipt
} from '../../../../gate-runtime/review-context';
import {
    type ReviewDependencyTimelineEvent
} from '../../../../gates/review/review-dependencies';
import {
    assertReviewTreeStateFresh
} from '../../../../gates/review/review-tree-state';
import {
    getReviewContextFullSuiteValidationViolations
} from '../../../../gates/review-context/review-context-validation-evidence';
import {
    resolveReviewerPromptArtifactBinding
} from '../../../../gates/review/review-prompt-artifact';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    isNonTestReviewScope
} from '../../../../gates/review-reuse/review-reuse';
import {
    validateReviewFindingsValidationArtifactForReceipt
} from '../../../../gates/review/review-findings-validation-artifact';
import {
    resolveLockedReviewFindingPolicyFromPreflight,
    resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence,
    reviewFindingsValidationArtifactHasBlockingFindings
} from '../../../../gates/review/review-finding-disposition';
import { validateReviewFindingsDispositionEvidence } from '../../../../gates/review/review-findings-disposition-evidence';
import {
    validateStrictReusedReviewEvidence
} from '../../../../gates/review-reuse/review-reuse-telemetry';
import {
    evaluateHiddenReviewTimingTrust,
    stripReviewTimingProvenanceTimestamps
} from '../../../../gates/review/review-timing-trust';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    readTimelineEventsSummary,
    type TimelineEventsSummaryResult
} from './review-context-command-binding';
import {
    getReviewTreeStateSha256FromContext,
    getRuleContextArtifactPathFromContext,
    getTokenEconomyActiveFromContext,
    isRecord,
    normalizeLowerText,
    normalizeOptionalPath,
    normalizeOptionalSha256,
    readJsonRecord
} from './review-context-flow-json';

export interface CurrentPassReviewEvidenceResult {
    accepted: boolean;
    reason: string;
    reviewContextPath: string;
    ruleContextArtifactPath: string | null;
    tokenEconomyActive: boolean | null;
    preflightSha256: string | null;
    reviewContextSha256: string | null;
    receiptPath: string | null;
    receiptSha256: string | null;
    reviewArtifactPath: string | null;
    reviewArtifactSha256: string | null;
    findingsValidationArtifactPath: string | null;
    findingsValidationArtifactSha256: string | null;
    findingsDispositionArtifactPath: string | null;
    findingsDispositionArtifactSha256: string | null;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
    reusedExistingReview: boolean;
    reviewRecordedSequence: number | null;
    reviewRecordedEventSha256: string | null;
    remediationMode: string | null;
    remediationAuthoritativeDecisionSha256: string | null;
    remediationClassificationSha256: string | null;
}

export interface CompileEvidenceSummary {
    status: string | null;
    preflightPath: string | null;
    preflightHashSha256: string | null;
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

export function readCompileEvidenceSummary(repoRoot: string, taskId: string): CompileEvidenceSummary {
    const compileEvidencePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-compile-gate.json`));
    if (!fs.existsSync(compileEvidencePath) || !fs.statSync(compileEvidencePath).isFile()) {
        return {
            status: null,
            preflightPath: null,
            preflightHashSha256: null
        };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(compileEvidencePath, 'utf8')) as Record<string, unknown>;
        return {
            status: String(parsed.status || '').trim() || null,
            preflightPath: gateHelpers.normalizePath(parsed.preflight_path),
            preflightHashSha256: String(parsed.preflight_hash_sha256 || '').trim().toLowerCase() || null
        };
    } catch {
        return {
            status: null,
            preflightPath: null,
            preflightHashSha256: null
        };
    }
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
    return passVerdicts[String(reviewType || '').trim().toLowerCase()]
        || `${String(reviewType || '').trim().toUpperCase()} REVIEW PASSED`;
}

function artifactHasPassVerdict(reviewType: string, artifactText: string): boolean {
    const tokenMatch = extractReviewVerdictSectionTokenMatch(
        artifactText,
        buildReviewVerdictTokenSet(reviewType, getReviewPassVerdict(reviewType))
    );
    return tokenMatch?.outcome === 'pass';
}

function getReceiptRecordString(receipt: ReviewReceipt, key: string): string | null {
    const value = (receipt as unknown as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getReceiptOutputContractString(receipt: ReviewReceipt, key: string): string | null {
    const contract = (receipt as unknown as Record<string, unknown>).review_output_contract;
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
        return null;
    }
    const value = (contract as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function receiptRequiresFindingsValidation(receipt: ReviewReceipt, reviewContext: Record<string, unknown>): boolean {
    const format = String(
        getReceiptRecordString(receipt, 'review_output_format')
        || getReceiptOutputContractString(receipt, 'format')
        || ''
    ).trim().toLowerCase();
    return Number(reviewContext.schema_version) >= 3
        || format === 'findings_json'
        || Boolean((receipt as unknown as Record<string, unknown>).review_findings_validation);
}

function findLatestCurrentCycleReviewRecordedEvent(options: {
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    latestCompilePassSequence: number;
    taskId: string;
    reviewType: string;
    receiptPath: string;
    receiptSha256: string | null;
    reviewContextPath: string;
    reviewContextSha256: string | null;
    reviewArtifactPath: string;
    reviewArtifactSha256: string | null;
    minSequenceExclusive?: number | null;
}): ReviewDependencyTimelineEvent | null {
    const normalizedReceiptPath = normalizeOptionalPath(options.receiptPath);
    const normalizedReviewContextPath = normalizeOptionalPath(options.reviewContextPath);
    const normalizedReviewArtifactPath = normalizeOptionalPath(options.reviewArtifactPath);
    for (let index = options.timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = options.timelineEvents[index];
        if (
            entry.sequence <= options.latestCompilePassSequence
            || (options.minSequenceExclusive != null && entry.sequence <= options.minSequenceExclusive)
            || entry.event_type !== 'REVIEW_RECORDED'
            || !entry.integrity
            || !isRecord(entry.details)
        ) {
            continue;
        }
        const details = entry.details;
        const detailsReviewType = normalizeLowerText(details.review_type ?? details.reviewType);
        const detailsTaskId = String(details.task_id ?? details.taskId ?? '').trim();
        if (
            detailsReviewType !== normalizeLowerText(options.reviewType)
            || (detailsTaskId && detailsTaskId !== options.taskId)
        ) {
            continue;
        }
        if (
            normalizeOptionalPath(details.receipt_path ?? details.receiptPath) !== normalizedReceiptPath
            || normalizeOptionalPath(details.review_context_path ?? details.reviewContextPath) !== normalizedReviewContextPath
            || normalizeOptionalPath(details.review_artifact_path ?? details.reviewArtifactPath) !== normalizedReviewArtifactPath
            || normalizeOptionalSha256(details.receipt_sha256 ?? details.receiptSha256) !== options.receiptSha256
            || normalizeOptionalSha256(details.review_context_sha256 ?? details.reviewContextSha256) !== options.reviewContextSha256
            || normalizeOptionalSha256(
                details.review_artifact_sha256
                ?? details.reviewArtifactSha256
                ?? details.review_artifact_snapshot_sha256
                ?? details.reviewArtifactSnapshotSha256
            ) !== options.reviewArtifactSha256
        ) {
            continue;
        }
        return entry;
    }
    return null;
}

function findMatchingInvocationAttestation(options: {
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    latestCompilePassSequence: number;
    taskId: string;
    reviewType: string;
    eventSha256: string;
    reviewContextSha256: string | null;
    reviewTreeStateSha256: string | null;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
}): ReviewDependencyTimelineEvent | null {
    for (const entry of options.timelineEvents) {
        if (
            entry.sequence <= options.latestCompilePassSequence
            || entry.event_type !== 'REVIEWER_INVOCATION_ATTESTED'
            || !entry.integrity
            || entry.integrity.event_sha256 !== options.eventSha256
            || !isRecord(entry.details)
        ) {
            continue;
        }
        const details = entry.details;
        if (
            String(details.task_id ?? details.taskId ?? '').trim() === options.taskId
            && normalizeLowerText(details.review_type ?? details.reviewType) === normalizeLowerText(options.reviewType)
            && normalizeOptionalSha256(details.review_context_sha256 ?? details.reviewContextSha256) === options.reviewContextSha256
            && normalizeOptionalSha256(details.review_tree_state_sha256 ?? details.reviewTreeStateSha256) === options.reviewTreeStateSha256
            && String(details.reviewer_execution_mode ?? details.reviewerExecutionMode ?? '').trim() === options.reviewerExecutionMode
            && String(details.reviewer_identity ?? details.reviewerIdentity ?? details.reviewer_session_id ?? '').trim() === options.reviewerIdentity
        ) {
            return entry;
        }
    }
    return null;
}

export function tryAcceptCurrentPassReviewEvidence(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    reviewContextPath: string;
    timelineEventsSummary?: TimelineEventsSummaryResult | null;
}): CurrentPassReviewEvidenceResult {
    const reject = (reason: string): CurrentPassReviewEvidenceResult => ({
        accepted: false,
        reason,
        reviewContextPath: gateHelpers.normalizePath(options.reviewContextPath),
        ruleContextArtifactPath: null,
        tokenEconomyActive: null,
        preflightSha256: null,
        reviewContextSha256: null,
        receiptPath: null,
        receiptSha256: null,
        reviewArtifactPath: null,
        reviewArtifactSha256: null,
        findingsValidationArtifactPath: null,
        findingsValidationArtifactSha256: null,
        findingsDispositionArtifactPath: null,
        findingsDispositionArtifactSha256: null,
        reviewerExecutionMode: null,
        reviewerIdentity: null,
        reusedExistingReview: false,
        reviewRecordedSequence: null,
        reviewRecordedEventSha256: null,
        remediationMode: null,
        remediationAuthoritativeDecisionSha256: null,
        remediationClassificationSha256: null
    });
    const currentPreflightHash = normalizeOptionalSha256(gateHelpers.fileSha256(options.preflightPath));
    const normalizedPreflightPath = gateHelpers.normalizePath(options.preflightPath);
    const compileEvidence = readCompileEvidenceSummary(options.repoRoot, options.taskId);
    if (
        compileEvidence.status !== 'PASSED'
        || compileEvidence.preflightPath !== normalizedPreflightPath
        || compileEvidence.preflightHashSha256 !== currentPreflightHash
    ) {
        return reject('current compile evidence is missing, failed, or bound to a different preflight artifact');
    }
    const timelinePath = gateHelpers.joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events', `${options.taskId}.jsonl`));
    const timelineEvents = options.timelineEventsSummary?.events || readTimelineEventsSummary(timelinePath).events;
    const latestCompilePassSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    if (latestCompilePassSequence == null) {
        return reject('task timeline has no compile pass before the current review cycle');
    }
    const reviewContext = readJsonRecord(options.reviewContextPath);
    if (!reviewContext) {
        return reject(`existing review context is missing or corrupt at ${gateHelpers.normalizePath(options.reviewContextPath)}`);
    }
    const fullSuiteViolations = getReviewContextFullSuiteValidationViolations({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightPath: options.preflightPath,
        preflightSha256: currentPreflightHash,
        reviewContext
    });
    if (fullSuiteViolations.length > 0) {
        return reject(fullSuiteViolations[0]);
    }
    const reviewContextSha256 = normalizeOptionalSha256(gateHelpers.fileSha256(options.reviewContextPath));
    const reviewTreeStateSha256 = getReviewTreeStateSha256FromContext(reviewContext);
    const ruleContextArtifactPath = getRuleContextArtifactPathFromContext(reviewContext);
    const reviewExecution = isRecord(reviewContext.review_execution)
        ? reviewContext.review_execution
        : null;
    if (
        String(reviewContext.task_id || '').trim() !== options.taskId
        || normalizeLowerText(reviewContext.review_type) !== normalizeLowerText(options.reviewType)
        || gateHelpers.normalizePath(reviewContext.preflight_path).toLowerCase() !== normalizedPreflightPath.toLowerCase()
        || normalizeOptionalSha256(reviewContext.preflight_sha256) !== currentPreflightHash
    ) {
        return reject('existing review context is bound to a different task, review type, or preflight hash');
    }
    if (!reviewContextSha256 || !reviewTreeStateSha256) {
        return reject('existing review context is missing a verifiable context hash or review tree-state hash');
    }
    if (!ruleContextArtifactPath) {
        return reject('existing review context is missing the rule-context artifact path');
    }
    try {
        assertReviewTreeStateFresh({
            repoRoot: options.repoRoot,
            reviewContext,
            contextPath: options.reviewContextPath,
            gateName: 'build-review-context current PASS reuse'
        });
    } catch (exc: unknown) {
        return reject(exc instanceof Error ? exc.message : String(exc));
    }
    let promptBinding: ReturnType<typeof resolveReviewerPromptArtifactBinding>;
    try {
        promptBinding = resolveReviewerPromptArtifactBinding({
            repoRoot: options.repoRoot,
            reviewContext,
            contextPath: options.reviewContextPath,
            gateName: 'build-review-context current PASS reuse'
        });
    } catch (exc: unknown) {
        return reject(exc instanceof Error ? exc.message : String(exc));
    }

    const reviewsRoot = path.dirname(options.preflightPath);
    const artifactPath = path.join(reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    const receipt = readJsonRecord(receiptPath) as ReviewReceipt | null;
    if (!receipt) {
        return reject(`review receipt is missing or corrupt at ${gateHelpers.normalizePath(receiptPath)}`);
    }
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return reject(`review artifact is missing at ${gateHelpers.normalizePath(artifactPath)}`);
    }
    const artifactText = fs.readFileSync(artifactPath, 'utf8');
    const artifactSha256 = normalizeOptionalSha256(gateHelpers.fileSha256(artifactPath));
    const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(options.preflightPayload, options.repoRoot);
    if (reviewScopeFingerprint.missing_review_relevant_files.length > 0) {
        return reject(`missing review-relevant scope file(s): ${reviewScopeFingerprint.missing_review_relevant_files.join(', ')}`);
    }
    const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint(options.reviewType, options.preflightPayload, options.repoRoot);
    if (codeScopeFingerprint.missing_non_test_files.length > 0) {
        return reject(`missing non-test scope file(s): ${codeScopeFingerprint.missing_non_test_files.join(', ')}`);
    }
    const metrics = isRecord(options.preflightPayload.metrics) ? options.preflightPayload.metrics : {};
    const expectedScopeSha256 = normalizeOptionalSha256(metrics.scope_sha256 || metrics.changed_files_sha256);
    const expectedReviewScopeSha256 = normalizeOptionalSha256(reviewScopeFingerprint.review_scope_sha256);
    const expectedCodeScopeSha256 = isNonTestReviewScope(options.reviewType)
        ? normalizeOptionalSha256(codeScopeFingerprint.code_scope_sha256)
        : null;
    let findingsValidationArtifactPath: string | null = null;
    let findingsValidationArtifactSha256: string | null = null;
    let findingsDispositionArtifactPath: string | null = null;
    let findingsDispositionArtifactSha256: string | null = null;
    if (receiptRequiresFindingsValidation(receipt, reviewContext)) {
        const findingsValidation = validateReviewFindingsValidationArtifactForReceipt({
            receipt: receipt as unknown as Record<string, unknown>,
            reviewArtifactPath: artifactPath,
            expectedTaskId: options.taskId,
            expectedReviewType: options.reviewType,
            expectedReviewOutputSha256: getReceiptRecordString(receipt, 'review_output_sha256')
                || getReceiptOutputContractString(receipt, 'raw_output_sha256'),
            expectedReviewArtifactSha256: artifactSha256,
            expectedReviewContextPath: receipt.reused_existing_review === true ? null : options.reviewContextPath,
            expectedReviewContextSha256: receipt.reused_existing_review === true
                ? normalizeOptionalSha256(receipt.reused_from_review_context_sha256)
                : reviewContextSha256,
            expectedPreflightPath: receipt.reused_existing_review === true ? null : options.preflightPath,
            expectedPreflightSha256: receipt.reused_existing_review === true ? null : currentPreflightHash,
            expectedScopeSha256: receipt.reused_existing_review === true ? null : expectedScopeSha256,
            expectedReviewScopeSha256: receipt.reused_existing_review === true
                ? normalizeOptionalSha256(receipt.reused_from_review_scope_sha256)
                : expectedReviewScopeSha256,
            expectedCodeScopeSha256: receipt.reused_existing_review === true
                ? normalizeOptionalSha256(receipt.reused_from_code_scope_sha256)
                : expectedCodeScopeSha256,
            expectedReviewTreeStateSha256: receipt.reused_existing_review === true
                ? normalizeOptionalSha256(receipt.reused_from_review_tree_state_sha256)
                : reviewTreeStateSha256,
            expectedCoverageContractSha256: receipt.reused_existing_review === true
                ? normalizeOptionalSha256(getReceiptOutputContractString(receipt, 'coverage_contract_sha256'))
                : isRecord(reviewContext.coverage_contract)
                    ? normalizeOptionalSha256((reviewContext.coverage_contract as Record<string, unknown>).contract_sha256)
                    : null,
            requireAccepted: true,
            preferSnapshot: receipt.reused_existing_review === true
        });
        if (!findingsValidation.valid) {
            return reject(`review findings validation artifact is invalid for current PASS reuse: ${findingsValidation.violations.join(' ')}`);
        }
        if (!findingsValidation.artifact || !findingsValidation.reference || !findingsValidation.artifact_sha256) {
            return reject('review findings validation artifact is missing complete authenticated evidence for current PASS reuse');
        }
        findingsValidationArtifactPath = gateHelpers.normalizePath(
            receipt.reused_existing_review === true && findingsValidation.reference.snapshot_path
                ? findingsValidation.reference.snapshot_path
                : findingsValidation.reference.artifact_path
        );
        findingsValidationArtifactSha256 = findingsValidation.artifact_sha256;
        const policyResolution = receipt.reused_existing_review === true
            ? resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence(
                receipt as unknown as Record<string, unknown>
            )
            : resolveLockedReviewFindingPolicyFromPreflight(options.preflightPayload);
        const dispositionEvidence = validateReviewFindingsDispositionEvidence({
            repoRoot: options.repoRoot,
            receipt: receipt as unknown as Record<string, unknown>,
            receiptPath,
            reviewArtifactPath: artifactPath,
            expectedTaskId: options.taskId,
            expectedReviewType: options.reviewType,
            validationArtifact: findingsValidation.artifact,
            validationArtifactPath: findingsValidation.reference.artifact_path,
            validationArtifactSha256: findingsValidation.artifact_sha256,
            policyResolution,
            expectedReceiptPath: receipt.reused_existing_review === true
                ? normalizeOptionalPath(receipt.reused_from_receipt_path)
                : null,
            expectedReceiptSha256: receipt.reused_existing_review === true
                ? normalizeOptionalSha256(receipt.reused_from_receipt_sha256)
                : null,
            preferSnapshot: receipt.reused_existing_review === true
        });
        if (!dispositionEvidence.valid) {
            return reject(
                `review findings disposition evidence is not satisfied for current PASS reuse: ` +
                dispositionEvidence.violations.join(' ')
            );
        }
        const dispositionReference = isRecord(
            (receipt as unknown as Record<string, unknown>).review_findings_disposition_artifact
        )
            ? (receipt as unknown as Record<string, unknown>).review_findings_disposition_artifact
            : null;
        const dispositionPath = isRecord(dispositionReference)
            ? receipt.reused_existing_review === true && typeof dispositionReference.snapshot_path === 'string'
                ? dispositionReference.snapshot_path
                : dispositionReference.artifact_path
            : null;
        if (!dispositionEvidence.artifact_sha256 || typeof dispositionPath !== 'string' || !dispositionPath.trim()) {
            return reject('review findings disposition artifact is missing complete authenticated evidence for current PASS reuse');
        }
        findingsDispositionArtifactPath = gateHelpers.normalizePath(dispositionPath);
        findingsDispositionArtifactSha256 = dispositionEvidence.artifact_sha256;
        if (reviewFindingsValidationArtifactHasBlockingFindings(
            findingsValidation.artifact,
            policyResolution
        )) {
            return reject('review findings validation artifact contains fix_now findings or residual risks');
        }
    } else if (!artifactHasPassVerdict(options.reviewType, artifactText)) {
        return reject('review artifact does not contain an accepted PASS verdict token');
    }
    if (
        String(receipt.task_id || '').trim() !== options.taskId
        || normalizeLowerText(receipt.review_type) !== normalizeLowerText(options.reviewType)
        || String(receipt.trust_level || '').trim() !== 'INDEPENDENT_AUDITED'
        || normalizeOptionalSha256(receipt.preflight_sha256) !== currentPreflightHash
        || normalizeOptionalSha256(receipt.scope_sha256) !== expectedScopeSha256
        || normalizeOptionalSha256(receipt.review_scope_sha256) !== expectedReviewScopeSha256
        || normalizeOptionalSha256(receipt.review_context_sha256) !== reviewContextSha256
        || normalizeOptionalSha256(receipt.review_tree_state_sha256) !== reviewTreeStateSha256
        || normalizeOptionalSha256(receipt.review_artifact_sha256) !== artifactSha256
        || (isNonTestReviewScope(options.reviewType)
            && normalizeOptionalSha256(receipt.code_scope_sha256) !== expectedCodeScopeSha256)
    ) {
        return reject('review receipt bindings do not match the current preflight, scope, context, tree-state, or artifact hash');
    }

    const receiptSha256 = normalizeOptionalSha256(gateHelpers.fileSha256(receiptPath));
    const reviewerExecutionMode = normalizeReviewerExecutionMode(receipt.reviewer_execution_mode);
    const reviewerIdentity = String(receipt.reviewer_identity || '').trim() || null;
    if (!reviewerExecutionMode || !reviewerIdentity) {
        return reject('review receipt is missing a trusted reviewer execution mode or identity');
    }
    const reviewerProvenance = normalizeReviewReceiptReviewerProvenance(receipt.reviewer_provenance);
    let reviewRecordedSequence: number | null = null;
    let reviewRecordedEventSha256: string | null = null;
    if (receipt.reused_existing_review === true) {
        const strictReuseValidation = validateStrictReusedReviewEvidence({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            events: timelineEvents,
            receiptPath,
            receiptSha256,
            reviewContextSha256,
            reviewContextReuseSha256: normalizeOptionalSha256(receipt.review_context_reuse_sha256),
            reviewTreeStateSha256,
            reviewScopeSha256: normalizeOptionalSha256(receipt.review_scope_sha256),
            codeScopeSha256: normalizeOptionalSha256(receipt.code_scope_sha256),
            reviewArtifactSha256: artifactSha256,
            reusedFromReceiptPath: typeof receipt.reused_from_receipt_path === 'string'
                ? receipt.reused_from_receipt_path
                : null,
            reusedFromReceiptSha256: normalizeOptionalSha256(receipt.reused_from_receipt_sha256),
            reusedFromReviewContextSha256: normalizeOptionalSha256(receipt.reused_from_review_context_sha256),
            reusedFromReviewContextReuseSha256: normalizeOptionalSha256(receipt.reused_from_review_context_reuse_sha256),
            reusedFromReviewTreeStateSha256: normalizeOptionalSha256(receipt.reused_from_review_tree_state_sha256),
            reusedFromReviewScopeSha256: normalizeOptionalSha256(receipt.reused_from_review_scope_sha256),
            reusedFromCodeScopeSha256: normalizeOptionalSha256(receipt.reused_from_code_scope_sha256),
            reviewerExecutionMode,
            reviewerIdentity,
            reviewerProvenance: reviewerProvenance
                ? { ...reviewerProvenance }
                : null,
            latestCompileEventSequence: latestCompilePassSequence
        });
        if (!strictReuseValidation.valid) {
            return reject(
                'current-cycle reused PASS receipt is missing strict reused evidence telemetry: ' +
                strictReuseValidation.reason
            );
        }
        const hiddenTimingTrust = evaluateHiddenReviewTimingTrust({
            reviewType: options.reviewType,
            reusedExistingReview: true,
            reviewerProvenance: stripReviewTimingProvenanceTimestamps(reviewerProvenance),
            reviewResultRecordedAtUtc: typeof receipt.review_result_recorded_at_utc === 'string'
                ? receipt.review_result_recorded_at_utc
                : null,
            recordedAtUtc: typeof receipt.recorded_at_utc === 'string' ? receipt.recorded_at_utc : null,
            reviewOutputSourceMtimeUtc: typeof receipt.review_output_source_mtime_utc === 'string'
                ? receipt.review_output_source_mtime_utc
                : null,
            strictReusedReviewRecordedDetails: strictReuseValidation.historicalReviewRecordedDetails,
            timelineEvents,
            latestCompileSequence: latestCompilePassSequence
        });
        if (!hiddenTimingTrust.trusted) {
            return reject(
                hiddenTimingTrust.message || 'current-cycle reused PASS receipt failed hidden review timing trust validation'
            );
        }
    } else {
        const invocationEvent = reviewerProvenance?.controller_event_type === 'REVIEWER_INVOCATION_ATTESTED'
            ? findMatchingInvocationAttestation({
                timelineEvents,
                latestCompilePassSequence,
                taskId: options.taskId,
                reviewType: options.reviewType,
                eventSha256: reviewerProvenance.event_sha256,
                reviewContextSha256,
                reviewTreeStateSha256,
                reviewerExecutionMode,
                reviewerIdentity
            })
            : null;
        if (
            !reviewerProvenance
            || reviewerProvenance.controller_event_type !== 'REVIEWER_INVOCATION_ATTESTED'
            || !invocationEvent
        ) {
            return reject('fresh PASS receipt is missing matching current-cycle reviewer invocation attestation');
        }
        const currentReviewRecorded = findLatestCurrentCycleReviewRecordedEvent({
            timelineEvents,
            latestCompilePassSequence,
            taskId: options.taskId,
            reviewType: options.reviewType,
            receiptPath,
            receiptSha256,
            reviewContextPath: options.reviewContextPath,
            reviewContextSha256,
            reviewArtifactPath: artifactPath,
            reviewArtifactSha256: artifactSha256,
            minSequenceExclusive: invocationEvent.sequence
        });
        if (!currentReviewRecorded) {
            return reject(
                'trusted current-cycle REVIEW_RECORDED telemetry is missing matching receipt/context/artifact bindings after reviewer invocation'
            );
        }
        if (
            currentReviewRecorded.integrity?.task_sequence == null
            || currentReviewRecorded.integrity.task_sequence <= (invocationEvent.integrity?.task_sequence || 0)
        ) {
            return reject('trusted current-cycle REVIEW_RECORDED telemetry must occur after reviewer invocation attestation');
        }
        reviewRecordedSequence = currentReviewRecorded.sequence;
        reviewRecordedEventSha256 = normalizeOptionalSha256(currentReviewRecorded.integrity?.event_sha256);
        if (!reviewRecordedEventSha256) {
            return reject('trusted current-cycle REVIEW_RECORDED telemetry is missing an authenticated event hash');
        }
    }

    return {
        accepted: true,
        reason: 'accepted: existing current-cycle independent PASS review evidence matches current preflight, scope, tree-state, context, receipt, artifact, and launch bindings; review context rebuild skipped',
        reviewContextPath: gateHelpers.normalizePath(options.reviewContextPath),
        ruleContextArtifactPath: gateHelpers.normalizePath(promptBinding.promptPath),
        tokenEconomyActive: getTokenEconomyActiveFromContext(reviewContext),
        preflightSha256: currentPreflightHash,
        reviewContextSha256,
        receiptPath: gateHelpers.normalizePath(receiptPath),
        receiptSha256,
        reviewArtifactPath: gateHelpers.normalizePath(artifactPath),
        reviewArtifactSha256: artifactSha256,
        findingsValidationArtifactPath,
        findingsValidationArtifactSha256,
        findingsDispositionArtifactPath,
        findingsDispositionArtifactSha256,
        reviewerExecutionMode,
        reviewerIdentity,
        reusedExistingReview: receipt.reused_existing_review === true,
        reviewRecordedSequence,
        reviewRecordedEventSha256,
        remediationMode: String(reviewExecution?.mode || '').trim().toUpperCase() || null,
        remediationAuthoritativeDecisionSha256: normalizeOptionalSha256(
            reviewExecution?.authoritative_decision_sha256
        ),
        remediationClassificationSha256: normalizeOptionalSha256(reviewExecution?.classification_sha256)
    };
}
