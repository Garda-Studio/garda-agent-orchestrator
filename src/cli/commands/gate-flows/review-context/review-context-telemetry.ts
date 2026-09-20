import * as fs from 'node:fs';
import { readJsonFile } from '../../../../core/json';
import { isPlainRecord } from '../../../../core/records';
import {
    appendMandatoryTaskEventAsync,
    taskEventAppendHasBlockingFailure,
    type TaskEventAppendResult
} from '../../../../gate-runtime/task-events';
import {
    emitSkillReferenceLoadedEventAsync,
    emitSkillSelectedEventAsync
} from '../../../../runtime/skill-telemetry';
import * as gateHelpers from '../../../../gates/shared/helpers';
import type { ReviewSkillBinding } from '../../../../gates/review-context/review-context-artifacts';
import { reviewEvidenceRequiresFindingsValidation } from '../../../../gates/review-remediation/review-remediation-review-contract';

const REVIEW_CONTEXT_TELEMETRY_LOCK_TIMEOUT_MS = 30000;
const REVIEW_CONTEXT_TELEMETRY_LOCK_RETRY_MS = 10;
const reviewContextTelemetryQueues = new Map<string, Promise<void>>();

function parsePositiveInteger(value: unknown, fallback: number): number {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertReviewPreparationTelemetryCommitted(result: TaskEventAppendResult | null, eventType: string): void {
    if (result && !taskEventAppendHasBlockingFailure(result, false)) {
        return;
    }

    const diagnostics = result
        ? (
            result.warnings.length > 0
                ? result.warnings.join(' | ')
                : `commit_status=${result.commit_status}`
        )
        : 'append returned null';
    throw new Error(`Required review-context telemetry '${eventType}' append failed: ${diagnostics}`);
}

export async function serializeReviewContextTelemetry<T>(
    orchestratorRoot: string,
    taskId: string,
    work: () => Promise<T>
): Promise<T> {
    const queueKey = `${gateHelpers.normalizePath(orchestratorRoot)}::${taskId}`;
    const previous = reviewContextTelemetryQueues.get(queueKey) || Promise.resolve();
    let releaseQueue!: () => void;
    const queued = previous.catch(() => undefined).then(() => new Promise<void>((resolve) => {
        releaseQueue = resolve;
    }));
    reviewContextTelemetryQueues.set(queueKey, queued);

    try {
        await previous.catch(() => undefined);
        return await work();
    } finally {
        releaseQueue();
        if (reviewContextTelemetryQueues.get(queueKey) === queued) {
            reviewContextTelemetryQueues.delete(queueKey);
        }
    }
}

function buildTelemetryAppendOptions(options: {
    telemetryLockTimeoutMs?: unknown;
    telemetryLockRetryMs?: unknown;
}): {
    passThru: true;
    lockTimeoutMs: number;
    lockRetryMs: number;
} {
    return {
        passThru: true,
        lockTimeoutMs: parsePositiveInteger(options.telemetryLockTimeoutMs, REVIEW_CONTEXT_TELEMETRY_LOCK_TIMEOUT_MS),
        lockRetryMs: parsePositiveInteger(options.telemetryLockRetryMs, REVIEW_CONTEXT_TELEMETRY_LOCK_RETRY_MS)
    };
}

export async function emitCurrentPassReviewContextReuseAccepted(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    depth: number;
    preflightPath: string;
    reviewContextPath: string;
    ruleContextArtifactPath: string | null;
    currentPassReviewEvidence: {
        reusedExistingReview: boolean;
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
        findingsValidationRequired: boolean;
        reviewerExecutionMode: string | null;
        reviewerIdentity: string | null;
        reviewRecordedSequence: number | null;
        reviewRecordedEventSha256: string | null;
        remediationMode: string | null;
        remediationAuthoritativeDecisionSha256: string | null;
        remediationClassificationSha256: string | null;
        remediationAuthorityEligible: boolean;
    };
    telemetryLockTimeoutMs?: unknown;
    telemetryLockRetryMs?: unknown;
}): Promise<void> {
    const orchestratorRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, '');
    const preflightSha256 = gateHelpers.fileSha256(options.preflightPath);
    const reviewContextSha256 = gateHelpers.fileSha256(options.reviewContextPath);
    const receiptSha256 = options.currentPassReviewEvidence.receiptPath
        ? gateHelpers.fileSha256(options.currentPassReviewEvidence.receiptPath)
        : null;
    const reviewArtifactSha256 = options.currentPassReviewEvidence.reviewArtifactPath
        ? gateHelpers.fileSha256(options.currentPassReviewEvidence.reviewArtifactPath)
        : null;
    const findingsValidationArtifactSha256 = options.currentPassReviewEvidence.findingsValidationArtifactPath
        ? gateHelpers.fileSha256(options.currentPassReviewEvidence.findingsValidationArtifactPath)
        : null;
    const findingsDispositionArtifactSha256 = options.currentPassReviewEvidence.findingsDispositionArtifactPath
        ? gateHelpers.fileSha256(options.currentPassReviewEvidence.findingsDispositionArtifactPath)
        : null;
    if (!preflightSha256 || !reviewContextSha256 || !receiptSha256 || !reviewArtifactSha256) {
        throw new Error(
            'Current PASS review context reuse telemetry requires readable preflight, context, receipt, and review artifact hashes.'
        );
    }
    if (
        preflightSha256 !== options.currentPassReviewEvidence.preflightSha256
        || reviewContextSha256 !== options.currentPassReviewEvidence.reviewContextSha256
        || receiptSha256 !== options.currentPassReviewEvidence.receiptSha256
        || reviewArtifactSha256 !== options.currentPassReviewEvidence.reviewArtifactSha256
        || findingsValidationArtifactSha256
            !== options.currentPassReviewEvidence.findingsValidationArtifactSha256
        || findingsDispositionArtifactSha256
            !== options.currentPassReviewEvidence.findingsDispositionArtifactSha256
    ) {
        throw new Error(
            'Current PASS review context reuse telemetry requires unchanged authenticated evidence hashes.'
        );
    }
    const evidence = options.currentPassReviewEvidence;
    let receipt: unknown;
    let reviewContext: unknown;
    try {
        receipt = readJsonFile(evidence.receiptPath || '');
        reviewContext = readJsonFile(options.reviewContextPath);
    } catch {
        throw new Error(
            'Current PASS review context reuse telemetry requires readable receipt and review context JSON.'
        );
    }
    if (!isPlainRecord(receipt) || !isPlainRecord(reviewContext)) {
        throw new Error(
            'Current PASS review context reuse telemetry requires receipt and review context JSON objects.'
        );
    }
    const boundFindingsValidationRequired = reviewEvidenceRequiresFindingsValidation(receipt, reviewContext);
    if (evidence.findingsValidationRequired !== boundFindingsValidationRequired) {
        throw new Error(
            'Current PASS review context reuse telemetry findings requirement does not match the bound review output format.'
        );
    }
    const hasCompleteFindingsEvidence = Boolean(
        evidence.findingsValidationArtifactPath
        && findingsValidationArtifactSha256
        && evidence.findingsDispositionArtifactPath
        && findingsDispositionArtifactSha256
    );
    const hasAnyFindingsEvidence = Boolean(
        evidence.findingsValidationArtifactPath
        || findingsValidationArtifactSha256
        || evidence.findingsDispositionArtifactPath
        || findingsDispositionArtifactSha256
    );
    if (
        (evidence.findingsValidationRequired && !hasCompleteFindingsEvidence)
        || (!evidence.findingsValidationRequired && hasAnyFindingsEvidence)
    ) {
        throw new Error(
            'Current PASS review context reuse telemetry findings evidence does not match the bound review output format.'
        );
    }
    if (
        !evidence.reusedExistingReview
        && (
            !Number.isInteger(evidence.reviewRecordedSequence)
            || Number(evidence.reviewRecordedSequence) <= 0
            || !/^[0-9a-f]{64}$/u.test(String(evidence.reviewRecordedEventSha256 || ''))
        )
    ) {
        throw new Error(
            'Fresh current PASS review context reuse telemetry requires complete REVIEW_RECORDED authority bindings.'
        );
    }
    if (
        evidence.remediationAuthorityEligible
        && (
            !['FULL', 'DELTA'].includes(String(evidence.remediationMode || ''))
            || !/^[0-9a-f]{64}$/u.test(String(evidence.remediationAuthoritativeDecisionSha256 || ''))
            || !/^[0-9a-f]{64}$/u.test(String(evidence.remediationClassificationSha256 || ''))
        )
    ) {
        throw new Error(
            'Current PASS review context reuse telemetry requires complete remediation authority bindings.'
        );
    }
    const telemetryAppendOptions = buildTelemetryAppendOptions(options);
    await serializeReviewContextTelemetry(orchestratorRoot, options.taskId, async () => {
        assertReviewPreparationTelemetryCommitted(
            await appendMandatoryTaskEventAsync(
                orchestratorRoot,
                options.taskId,
                'REVIEW_CONTEXT_REUSE_ACCEPTED',
                'PASS',
                'Current PASS review context reuse accepted.',
                {
                    review_type: options.reviewType,
                    depth: options.depth,
                    preflight_path: gateHelpers.normalizePath(options.preflightPath),
                    preflight_sha256: preflightSha256,
                    output_path: gateHelpers.normalizePath(options.reviewContextPath),
                    review_context_path: gateHelpers.normalizePath(options.reviewContextPath),
                    review_context_sha256: reviewContextSha256,
                    review_context_artifact_path: options.ruleContextArtifactPath
                        ? gateHelpers.normalizePath(options.ruleContextArtifactPath)
                        : null,
                    current_pass_review_evidence: true,
                    review_reuse_evidence: options.currentPassReviewEvidence.reusedExistingReview ? 'REUSED' : 'FRESH',
                    reused_existing_review: options.currentPassReviewEvidence.reusedExistingReview,
                    receipt_path: gateHelpers.normalizePath(options.currentPassReviewEvidence.receiptPath),
                    receipt_sha256: receiptSha256,
                    review_artifact_path: gateHelpers.normalizePath(
                        options.currentPassReviewEvidence.reviewArtifactPath
                    ),
                    review_artifact_sha256: reviewArtifactSha256,
                    findings_validation_artifact_path: gateHelpers.normalizePath(
                        options.currentPassReviewEvidence.findingsValidationArtifactPath
                    ),
                    findings_validation_artifact_sha256: findingsValidationArtifactSha256,
                    findings_disposition_artifact_path: gateHelpers.normalizePath(
                        options.currentPassReviewEvidence.findingsDispositionArtifactPath
                    ),
                    findings_disposition_artifact_sha256: findingsDispositionArtifactSha256,
                    findings_validation_required: evidence.findingsValidationRequired,
                    reviewer_execution_mode: options.currentPassReviewEvidence.reviewerExecutionMode,
                    reviewer_identity: options.currentPassReviewEvidence.reviewerIdentity,
                    review_recorded_sequence: options.currentPassReviewEvidence.reviewRecordedSequence,
                    review_recorded_event_sha256: options.currentPassReviewEvidence.reviewRecordedEventSha256,
                    remediation_mode: options.currentPassReviewEvidence.remediationMode,
                    remediation_authoritative_decision_sha256:
                        options.currentPassReviewEvidence.remediationAuthoritativeDecisionSha256,
                    remediation_classification_sha256:
                        options.currentPassReviewEvidence.remediationClassificationSha256,
                    remediation_authority_eligible: evidence.remediationAuthorityEligible
                },
                telemetryAppendOptions
            ),
            'REVIEW_CONTEXT_REUSE_ACCEPTED'
        );
    });
}

export async function emitGeneratedReviewContextPreparationTelemetry(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    depth: number;
    preflightPath: string;
    outputPath: string;
    ruleContextArtifactPath: string;
    selectedSkill: ReviewSkillBinding;
    telemetryLockTimeoutMs?: unknown;
    telemetryLockRetryMs?: unknown;
}): Promise<void> {
    const orchestratorRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, '');
    const skillId = options.selectedSkill.skill_id;
    const skillPath = options.selectedSkill.skill_path;
    const telemetryAppendOptions = buildTelemetryAppendOptions(options);

    await serializeReviewContextTelemetry(orchestratorRoot, options.taskId, async () => {
        await appendMandatoryTaskEventAsync(
            orchestratorRoot,
            options.taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started.',
            {
                review_type: options.reviewType,
                depth: options.depth,
                preflight_path: gateHelpers.normalizePath(options.preflightPath),
                output_path: options.outputPath,
                review_context_artifact_path: options.ruleContextArtifactPath
            },
            telemetryAppendOptions
        );
        assertReviewPreparationTelemetryCommitted(
            await emitSkillSelectedEventAsync(orchestratorRoot, options.taskId, skillId, null, 'required_review', telemetryAppendOptions),
            'SKILL_SELECTED'
        );
        if (fs.existsSync(skillPath) && fs.statSync(skillPath).isFile()) {
            assertReviewPreparationTelemetryCommitted(
                await emitSkillReferenceLoadedEventAsync(
                    orchestratorRoot,
                    options.taskId,
                    gateHelpers.normalizePath(skillPath),
                    skillId,
                    'review_skill',
                    telemetryAppendOptions
                ),
                'SKILL_REFERENCE_LOADED'
            );
        }
        assertReviewPreparationTelemetryCommitted(
            await emitSkillReferenceLoadedEventAsync(
                orchestratorRoot,
                options.taskId,
                gateHelpers.normalizePath(options.ruleContextArtifactPath),
                skillId,
                'review_context_artifact',
                telemetryAppendOptions
            ),
            'SKILL_REFERENCE_LOADED'
        );
    });
}
