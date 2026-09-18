import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomically } from '../../../../core/filesystem';
import { isPlainRecord } from '../../../../core/records';
import { sha256RedactedJsonPayload } from '../../../../core/redaction';
import { getReviewOutputCorrectionProviderCapabilities } from '../../../../core/provider/provider-registry';
import {
    buildReviewReceipt,
    buildReviewReceiptReviewerInvocationProvenance,
    buildReviewReceiptReviewerProvenance,
    buildReviewVerdictTokenSet,
    extractReviewVerdictToken,
    formatAcceptedReviewVerdictTokens
} from '../../../../gate-runtime/review-context';
import { fileSha256 } from '../../../../gate-runtime/hash';
import {
    emitReviewRecordedEventAsync,
    emitReviewOutputCorrectionAcceptedEventAsync,
    emitReviewOutputCorrectionFullReviewRequiredEventAsync,
    emitReviewOutputCorrectionInvocationAttestedEventAsync,
    emitReviewOutputCorrectionNormalizedEventAsync,
    emitReviewOutputCorrectionRequiredEventAsync,
    emitReviewOutputCorrectionTransportEventAsync,
    emitReviewerDelegationStartedEventAsync,
    emitReviewerInvocationAttestedEventAsync,
    emitReviewerLaunchFailedEventAsync
} from '../../../../gate-runtime/lifecycle-events';
import {
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION
} from '../../../../gate-runtime/reviewer-session-contract';
import {
    buildPlannedReviewerIdentity,
    isResolvedReviewerIdentity,
    isPlannedReviewerIdentity
} from '../../../../gate-runtime/review/reviewer-identity-contract';
import {
    assertReviewArtifactFileSha256,
    writeReviewArtifactJson,
    writeReviewArtifactsWithRollback
} from '../../../../gate-runtime/review-artifacts';
import {
    acquireFilesystemLockAsync,
    assertValidTaskId,
    releaseFilesystemLock,
    taskEventAppendHasBlockingFailure
} from '../../../../gate-runtime/task-events';
import { inspectTaskEventFile } from '../../../../gate-runtime/task-events-integrity';
import {
    buildDomainScopeFingerprints
} from '../../../../gates/scope/domain-scope-fingerprints';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { normalizePath } from '../../../../gates/shared/helpers';
import {
    assertRequiredUpstreamReviewDependencies,
} from '../../../../gates/review/review-dependencies';
import {
    REVIEW_EVIDENCE_REQUIRED_TRUST_LEVEL
} from '../../../../gates/review/review-evidence-contract';
import {
    computeReviewContextReuseHash,
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    isNonTestReviewScope,
    resolveReviewContextReuseContractBindings
} from '../../../../gates/review-reuse/review-reuse';
import {
    resolveReviewerPromptArtifactBinding
} from '../../../../gates/review/review-prompt-artifact';
import {
    cleanupReviewTempSourceArtifact
} from '../../../gate-cli/gates-artifacts';
import {
    normalizePathValue,
    parseOptions
} from '../../cli-helpers';
import {
    type ParsedOptionsRecord
} from '../../shared-command-utils';
import {
    type ReviewResultHandlers,
    type ReviewResultHandlersDependencies,
    type ReviewerExecutionMode,
    recordReviewOutputCorrectionInvocationOptionDefinitions,
    recordReviewOutputCorrectionResponseOptionDefinitions,
    recordReviewOutputCorrectionTransportOptionDefinitions,
    recordReviewReceiptOptionDefinitions,
    recordReviewResultOptionDefinitions
} from './review-result-handler-contract';
import {
    appendSafeReviewOutputRetryInstruction,
    assertReviewOutputNotOlderThanDelegation,
    assertReviewTreeStateFreshOrHistoricalFailure,
    buildSafeReviewOutputRetryInstruction,
    getDelegationStartedAtUtc,
    isFailedReviewVerdictToken,
    sha256ReviewArtifactContent
} from './review-result-output-safety';
import {
    materializeReviewContent
} from './review-artifact-materialization';
import {
    readDependencyTimelineEvents
} from './review-dependency-timeline';
import {
    resolveReviewOutputInput
} from './review-output-input';
import {
    resolveReviewerLaunchArtifactPathForWrite
} from '../launch/review-artifact-path-support';
import {
    isCompletedReviewerLaunchAttemptConsumed
} from '../launch/reviewer-handoff-support';
import {
    withReviewerLaunchLaneTransaction
} from '../launch/reviewer-launch-lane-transaction';
import {
    assertArtifactReviewLaneEvidence,
    assertCanonicalReviewTypeId,
    resolveAuthenticatedReviewLaneContract
} from '../review-lane-contract';
import {
    assertReviewReceiptRoutingMatchesContext
} from './review-receipt-validation';
import {
    assertReviewExecutionRuntimeBindings,
    readReviewExecutionRuntimeBindings,
    resolveReviewExecutionRuntimeBindings
} from '../context/review-context-runtime-validation';
import { assertReviewLifecycleGuard } from '../../../../gates/review/review-lifecycle-guard';
import {
    resolveReviewCoverageEvidenceSnapshotCommit,
    type ReviewCoverageContract,
    type ReviewCoverageValidationSummary
} from '../../../../gates/review/review-coverage-ledger';
import {
    type ReviewFindingsReport
} from '../../../../gates/review/review-findings-schema';
import {
    buildReviewOutputCorrectionApiContinuationAcceptance,
    buildReviewOutputCorrectionCorrectionOnlyAcceptance,
    buildReviewOutputCorrectionLiveContinuationAcceptance,
    buildReviewOutputCorrectionArtifact,
    classifyReviewOutputCorrectionDiagnostics,
    computeRawReviewOutputSha256,
    getRejectedReviewOutputArtifactPath,
    getReviewOutputCorrectionArtifactPath,
    getReviewOutputCorrectionLaunchArtifactPath,
    hasCommittedReviewOutputCorrectionTransportEvent,
    isProviderOwnedReviewOutputCorrectionSessionAttestationSource,
    normalizeReviewOutputMechanically,
    persistReviewOutputCorrection,
    persistReviewOutputCorrectionTransportSelection,
    readReviewOutputCorrectionArtifact,
    updateReviewOutputCorrectionState,
    verifyCorrectedReviewOutput,
    type ReviewOutputCorrectionArtifact,
    type ReviewOutputCorrectionSessionAvailability,
    REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE,
    REVIEW_OUTPUT_CORRECTION_LAUNCH_ARTIFACT_TYPE,
    type ReviewOutputCorrectionProducerAttestation,
    type ReviewOutputCorrectionProducerInvocationEvidence
} from '../../../../gates/review/review-output-correction';
import {
    type ReviewRemediationReviewContract
} from '../../../../gates/review-remediation/review-remediation-review-contract';
import {
    evaluateReviewFindingsReportDispositions,
    resolveLockedReviewFindingPolicyFromPreflight,
    type LockedReviewFindingPolicyResolution,
    type ReviewFindingsDispositionEvaluation
} from '../../../../gates/review/review-finding-disposition';
import {
    buildReviewFindingsDispositionArtifact,
    getReviewFindingsDispositionArtifactPath,
    getReviewFindingsDispositionArtifactSnapshotPath,
    type ReviewFindingsDispositionArtifact
} from '../../../../gates/review/review-findings-disposition-artifact';
import {
    reviewContextRequiresFindingsOnlyArtifact,
    validateReviewFindingsContract,
    type JsonReviewFindingsArtifactValidation
} from '../../../../gates/review/review-findings-artifact-verdict';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath,
    getReviewFindingsValidationArtifactSnapshotPath,
    type ReviewFindingsValidationArtifact
} from '../../../../gates/review/review-findings-validation-artifact';
import {
    buildReviewRemediationBaselineArtifact,
    getReviewRemediationBaselineArtifactPath,
    getReviewRemediationBaselineSnapshotPath,
    type ReviewRemediationBaselineArtifact
} from '../../../../gates/review-remediation/review-remediation-baseline';
import {
    buildReviewRemediationDeltaBase
} from '../../../../gates/review-remediation/review-remediation-delta-contract';

export function restoreReviewerLaunchArtifactTextForResultRollback(
    artifactPath: string,
    artifactText: string
): void {
    writeFileAtomically(artifactPath, artifactText, { encoding: 'utf8' });
}

function summarizeReviewFindingsReport(report: ReviewFindingsReport): Record<string, unknown> {
    const findingIdsBySeverity = {
        critical: report.findings.critical.map((finding) => finding.id),
        high: report.findings.high.map((finding) => finding.id),
        medium: report.findings.medium.map((finding) => finding.id),
        low: report.findings.low.map((finding) => finding.id)
    };
    return {
        schema_version: 1,
        validation_note_ids: report.validation_notes.map((note) => note.id),
        coverage_obligation_ids: report.coverage_ledger.entries.map((entry) => entry.obligation_id),
        finding_ids_by_severity: findingIdsBySeverity,
        active_finding_count: Object.values(findingIdsBySeverity)
            .reduce((total, ids) => total + ids.length, 0),
        residual_risk_ids: report.residual_risks.map((risk) => risk.id),
        residual_risk_count: report.residual_risks.length
    };
}

function evaluateReviewFindingsReportDispositionsFromPreflight(
    report: ReviewFindingsReport,
    preflight: Record<string, unknown>
): ReviewFindingsDispositionEvaluation {
    return evaluateReviewFindingsReportDispositions(
        report,
        resolveLockedReviewFindingPolicyFromPreflight(preflight)
    );
}

function buildBoundedReviewRecordedTelemetryDetails(receipt: Record<string, unknown>): Record<string, unknown> {
    const telemetryDetails = { ...receipt };
    if (Object.prototype.hasOwnProperty.call(telemetryDetails, 'review_findings_report')) {
        delete telemetryDetails.review_findings_report;
        telemetryDetails.review_findings_report_telemetry_policy = 'omitted_full_payload_receipt_only';
    }
    return telemetryDetails;
}

interface ReviewFindingsValidationEvidence {
    artifactPath: string;
    snapshotPath: string;
    artifactSha256: string;
    payload: ReviewFindingsValidationArtifact;
}

interface ReviewFindingsDispositionEvidence {
    artifactPath: string;
    snapshotPath: string;
    artifactSha256: string;
    payload: ReviewFindingsDispositionArtifact;
}

interface ReviewRemediationBaselineEvidence {
    artifactPath: string;
    snapshotPath: string;
    artifactSha256: string;
    payload: ReviewRemediationBaselineArtifact;
}

function getPreflightScopeSha256(preflight: Record<string, unknown>): string | null {
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : null;
    return String(metrics?.scope_sha256 || metrics?.changed_files_sha256 || '').trim() || null;
}

function buildReviewFindingsValidationEvidence(options: {
    taskId: string;
    reviewType: string;
    validation: JsonReviewFindingsArtifactValidation;
    reviewOutputSha256?: string | null;
    reviewArtifactPath: string;
    reviewArtifactSha256?: string | null;
    reviewContextPath: string;
    reviewContextSha256?: string | null;
    preflightPath: string;
    preflightSha256?: string | null;
    scopeSha256?: string | null;
    reviewScopeSha256?: string | null;
    codeScopeSha256?: string | null;
    reviewTreeStateSha256?: string | null;
    coverageContract?: ReviewCoverageContract | null;
}): ReviewFindingsValidationEvidence {
    const artifactPath = getReviewFindingsValidationArtifactPath(options.reviewArtifactPath);
    const payload = buildReviewFindingsValidationArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        validation: options.validation,
        reviewOutputSha256: options.reviewOutputSha256 || null,
        reviewArtifactPath: options.reviewArtifactPath,
        reviewArtifactSha256: options.reviewArtifactSha256 || null,
        reviewContextPath: options.reviewContextPath,
        reviewContextSha256: options.reviewContextSha256 || null,
        preflightPath: options.preflightPath,
        preflightSha256: options.preflightSha256 || null,
        scopeSha256: options.scopeSha256 || null,
        reviewScopeSha256: options.reviewScopeSha256 || null,
        codeScopeSha256: options.codeScopeSha256 || null,
        reviewTreeStateSha256: options.reviewTreeStateSha256 || null,
        coverageContract: options.coverageContract || null
    });
    const artifactSha256 = sha256RedactedJsonPayload(payload);
    return {
        artifactPath,
        snapshotPath: getReviewFindingsValidationArtifactSnapshotPath(artifactPath, artifactSha256),
        artifactSha256,
        payload
    };
}

function buildReviewFindingsDispositionEvidence(options: {
    taskId: string;
    reviewType: string;
    reviewArtifactPath: string;
    validationEvidence: ReviewFindingsValidationEvidence;
    policyResolution: LockedReviewFindingPolicyResolution;
}): ReviewFindingsDispositionEvidence {
    const artifactPath = getReviewFindingsDispositionArtifactPath(options.reviewArtifactPath);
    const payload = buildReviewFindingsDispositionArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        validationArtifact: options.validationEvidence.payload,
        validationArtifactPath: options.validationEvidence.artifactPath,
        validationArtifactSha256: options.validationEvidence.artifactSha256,
        policyResolution: options.policyResolution
    });
    const artifactSha256 = sha256RedactedJsonPayload(payload);
    return {
        artifactPath,
        snapshotPath: getReviewFindingsDispositionArtifactSnapshotPath(artifactPath, artifactSha256),
        artifactSha256,
        payload
    };
}

function buildReviewRemediationBaselineEvidence(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewTreeStateSha256: string;
    changedFiles: readonly string[];
    reviewArtifactPath: string;
    reviewArtifactSha256: string;
    receipt: Record<string, unknown>;
    receiptSha256: string;
    validationEvidence: ReviewFindingsValidationEvidence;
    dispositionEvidence: ReviewFindingsDispositionEvidence;
    profilePolicySnapshot: unknown;
    originCoverageContract?: ReviewCoverageContract;
}): ReviewRemediationBaselineEvidence {
    const artifactPath = getReviewRemediationBaselineArtifactPath(options.reviewArtifactPath);
    const deltaBase = buildReviewRemediationDeltaBase({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewTreeStateSha256: options.reviewTreeStateSha256,
        changedFiles: options.changedFiles
    });
    const payload = buildReviewRemediationBaselineArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewArtifactPath: options.reviewArtifactPath,
        reviewArtifactSha256: options.reviewArtifactSha256,
        receiptPath: options.reviewArtifactPath.replace(/\.md$/u, '-receipt.json'),
        receiptSha256: options.receiptSha256,
        receipt: options.receipt,
        validationArtifactPath: options.validationEvidence.artifactPath,
        validationArtifactSha256: options.validationEvidence.artifactSha256,
        validationArtifact: options.validationEvidence.payload,
        dispositionArtifactPath: options.dispositionEvidence.artifactPath,
        dispositionArtifactSha256: options.dispositionEvidence.artifactSha256,
        dispositionArtifact: options.dispositionEvidence.payload,
        profilePolicySnapshot: options.profilePolicySnapshot,
        originCoverageContract: options.originCoverageContract,
        deltaBase
    });
    const artifactSha256 = sha256RedactedJsonPayload(payload);
    return {
        artifactPath,
        snapshotPath: getReviewRemediationBaselineSnapshotPath(artifactPath, artifactSha256),
        artifactSha256,
        payload
    };
}

async function writeRejectedReviewFindingsValidationEvidence(evidence: ReviewFindingsValidationEvidence): Promise<void> {
    await writeReviewArtifactsWithRollback([
        {
            artifactPath: evidence.artifactPath,
            contentType: 'json',
            payload: evidence.payload
        },
        {
            artifactPath: evidence.snapshotPath,
            contentType: 'json',
            payload: evidence.payload
        }
    ], async () => {
        assertReviewArtifactFileSha256(
            evidence.artifactPath,
            evidence.artifactSha256,
            'Review findings validation artifact'
        );
        assertReviewArtifactFileSha256(
            evidence.snapshotPath,
            evidence.artifactSha256,
            'Review findings validation snapshot'
        );
    });
}

function getArtifactStringField(artifact: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
        const value = artifact[key];
        if (value != null && String(value).trim()) {
            return String(value).trim();
        }
    }
    return '';
}

function correctionTransportEventMatchesPersistedSelection(options: {
    timelinePath: string;
    reviewType: string;
    selection: {
        artifact: ReviewOutputCorrectionArtifact;
        artifactFileSha256: string;
    } | null;
}): boolean {
    return options.selection !== null && hasCommittedReviewOutputCorrectionTransportEvent({
        timelineEvents: readDependencyTimelineEvents(options.timelinePath),
        reviewType: options.reviewType,
        correctionArtifactSha256: options.selection.artifact.artifact_sha256 || '',
        correctionPackageSha256: options.selection.artifactFileSha256
    });
}

function normalizeArtifactPathForComparison(value: string): string {
    if (!String(value || '').trim()) {
        return '';
    }
    const normalized = normalizePath(path.resolve(value));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function findCompletedReviewerLaunchAttempt(
    timelineEvents: ReturnType<typeof readDependencyTimelineEvents>,
    launchArtifact: Record<string, unknown>,
    launchArtifactPath: string,
    launchArtifactSha256: string
): ReturnType<typeof readDependencyTimelineEvents>[number] | null {
    const reviewerLaunchAttemptId = getArtifactStringField(
        launchArtifact,
        'reviewer_launch_attempt_id',
        'reviewerLaunchAttemptId'
    ).toLowerCase();
    const reviewType = getArtifactStringField(launchArtifact, 'review_type', 'reviewType').toLowerCase();
    const reviewerIdentity = getArtifactStringField(
        launchArtifact,
        'reviewer_identity',
        'reviewerIdentity'
    );
    const reviewContextSha256 = getArtifactStringField(
        launchArtifact,
        'review_context_sha256',
        'reviewContextSha256'
    ).toLowerCase();
    if (!reviewerLaunchAttemptId || !reviewType || !reviewerIdentity || !reviewContextSha256) {
        return null;
    }
    const normalizedLaunchArtifactPath = normalizeArtifactPathForComparison(launchArtifactPath);
    return timelineEvents.find((event) => event.event_type === 'REVIEWER_LAUNCH_COMPLETED'
        && !!event.details
        && !!event.integrity
        && getArtifactStringField(
            event.details,
            'reviewer_launch_attempt_id',
            'reviewerLaunchAttemptId'
        ).toLowerCase() === reviewerLaunchAttemptId
        && getArtifactStringField(event.details, 'review_type', 'reviewType').toLowerCase() === reviewType
        && getArtifactStringField(event.details, 'reviewer_identity', 'reviewerIdentity') === reviewerIdentity
        && getArtifactStringField(
            event.details,
            'review_context_sha256',
            'reviewContextSha256'
        ).toLowerCase() === reviewContextSha256
        && normalizeArtifactPathForComparison(getArtifactStringField(
            event.details,
            'reviewer_launch_artifact_path',
            'reviewerLaunchArtifactPath'
        )) === normalizedLaunchArtifactPath
        && getArtifactStringField(
            event.details,
            'reviewer_launch_artifact_sha256',
            'reviewerLaunchArtifactSha256'
        ).toLowerCase() === launchArtifactSha256.toLowerCase()) || null;
}

function hasRecordedReviewerLaunchFailure(
    timelineEvents: ReturnType<typeof readDependencyTimelineEvents>,
    launchArtifact: Record<string, unknown>,
    launchArtifactPath: string,
    launchArtifactSha256: string
): boolean {
    const reviewerLaunchAttemptId = getArtifactStringField(
        launchArtifact,
        'reviewer_launch_attempt_id',
        'reviewerLaunchAttemptId'
    ).toLowerCase();
    const reviewType = getArtifactStringField(launchArtifact, 'review_type', 'reviewType').toLowerCase();
    const reviewerIdentity = getArtifactStringField(
        launchArtifact,
        'reviewer_identity',
        'reviewerIdentity'
    );
    const reviewContextSha256 = getArtifactStringField(
        launchArtifact,
        'review_context_sha256',
        'reviewContextSha256'
    ).toLowerCase();
    const normalizedLaunchArtifactPath = normalizeArtifactPathForComparison(launchArtifactPath);
    const validationArtifactPath = normalizeArtifactPathForComparison(getArtifactStringField(
        launchArtifact,
        'review_findings_validation_artifact_path',
        'reviewFindingsValidationArtifactPath'
    ));
    const validationArtifactSha256 = getArtifactStringField(
        launchArtifact,
        'review_findings_validation_artifact_sha256',
        'reviewFindingsValidationArtifactSha256'
    ).toLowerCase();
    return !!reviewerLaunchAttemptId && !!reviewType && !!reviewerIdentity && !!reviewContextSha256
        && !!validationArtifactPath && !!validationArtifactSha256
        && timelineEvents.some((event) => event.event_type === 'REVIEWER_LAUNCH_FAILED'
            && !!event.details
            && !!event.integrity
            && getArtifactStringField(
                event.details,
                'reviewer_launch_attempt_id',
                'reviewerLaunchAttemptId'
            ).toLowerCase() === reviewerLaunchAttemptId
            && getArtifactStringField(event.details, 'review_type', 'reviewType').toLowerCase() === reviewType
            && getArtifactStringField(event.details, 'reviewer_identity', 'reviewerIdentity') === reviewerIdentity
            && getArtifactStringField(
                event.details,
                'review_context_sha256',
                'reviewContextSha256'
            ).toLowerCase() === reviewContextSha256
            && getArtifactStringField(
                event.details,
                'launch_failure_stage',
                'launchFailureStage'
            ) === 'review_findings_validation'
            && normalizeArtifactPathForComparison(getArtifactStringField(
                event.details,
                'reviewer_launch_artifact_path',
                'reviewerLaunchArtifactPath'
            )) === normalizedLaunchArtifactPath
            && getArtifactStringField(
                event.details,
                'reviewer_launch_artifact_sha256',
                'reviewerLaunchArtifactSha256'
            ).toLowerCase() === launchArtifactSha256.toLowerCase()
            && getArtifactStringField(
                event.details,
                'review_findings_validation_artifact_sha256',
                'reviewFindingsValidationArtifactSha256'
            ).toLowerCase() === validationArtifactSha256
            && normalizeArtifactPathForComparison(getArtifactStringField(
                event.details,
                'review_findings_validation_artifact_path',
                'reviewFindingsValidationArtifactPath'
            )) === validationArtifactPath);
}

interface ReviewArtifactFileSnapshot {
    path: string;
    existed: boolean;
    content: Buffer | null;
}

interface ReviewArtifactFamilyRollbackJournal {
    schema_version: 1;
    artifact_path: string;
    snapshots: Array<{
        path: string;
        existed: boolean;
        content_base64: string | null;
    }>;
}

function normalizeReviewArtifactPathForComparison(pathValue: string): string {
    const normalizedPath = path.resolve(pathValue);
    return process.platform === 'win32'
        ? normalizedPath.toLowerCase()
        : normalizedPath;
}

function getReviewArtifactFamilyRollbackJournalPath(artifactPath: string): string {
    return path.join(
        path.dirname(artifactPath),
        `.${path.basename(artifactPath)}.rollback.json`
    );
}

function isReviewArtifactFamilyMemberPath(artifactPath: string, candidatePath: string): boolean {
    if (
        normalizeReviewArtifactPathForComparison(path.dirname(artifactPath))
        !== normalizeReviewArtifactPathForComparison(path.dirname(candidatePath))
    ) {
        return false;
    }
    const artifactExtension = path.extname(artifactPath);
    const artifactStem = path.basename(artifactPath, artifactExtension);
    const candidateName = path.basename(candidatePath);
    return candidateName === path.basename(artifactPath)
        || (
            candidateName.startsWith(`${artifactStem}-`)
            && candidateName.endsWith(artifactExtension)
        );
}

function assertReviewArtifactRollbackPathSafe(repoRoot: string, pathValue: string): void {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const resolvedPath = path.resolve(pathValue);
    if (!gateHelpers.isPathRealpathInsideRoot(resolvedPath, resolvedRepoRoot, { allowMissing: true })) {
        throw new Error(
            `Review findings validation rollback path must stay inside repo root: ${normalizePath(resolvedPath)}.`
        );
    }
    const relativePath = path.relative(resolvedRepoRoot, resolvedPath);
    let currentPath = resolvedRepoRoot;
    for (const segment of relativePath.split(path.sep).filter(Boolean)) {
        currentPath = path.join(currentPath, segment);
        if (fs.existsSync(currentPath) && fs.lstatSync(currentPath).isSymbolicLink()) {
            throw new Error(
                `Review findings validation rollback path must not traverse symlinks or junctions: ` +
                `${normalizePath(currentPath)}.`
            );
        }
    }
}

function captureReviewArtifactFile(repoRoot: string, pathValue: string): ReviewArtifactFileSnapshot {
    assertReviewArtifactRollbackPathSafe(repoRoot, pathValue);
    const pathExists = fs.existsSync(pathValue);
    if (pathExists && !fs.lstatSync(pathValue).isFile()) {
        throw new Error(
            `Review findings validation rollback family members must be regular files: ${normalizePath(pathValue)}.`
        );
    }
    const existed = pathExists;
    return {
        path: pathValue,
        existed,
        content: existed ? fs.readFileSync(pathValue) : null
    };
}

export function restoreReviewArtifactFile(repoRoot: string, snapshot: ReviewArtifactFileSnapshot): void {
    assertReviewArtifactRollbackPathSafe(repoRoot, snapshot.path);
    if (snapshot.existed) {
        if (snapshot.content === null) {
            throw new Error(
                `Review findings validation rollback snapshot is missing content for ${normalizePath(snapshot.path)}.`
            );
        }
        writeFileAtomically(snapshot.path, snapshot.content);
        return;
    }
    fs.rmSync(snapshot.path, { force: true });
}

function readReviewArtifactFamilyRollbackJournal(
    repoRoot: string,
    artifactPath: string,
    journalPath: string
): ReviewArtifactFileSnapshot[] {
    assertReviewArtifactRollbackPathSafe(repoRoot, journalPath);
    if (!fs.existsSync(journalPath) || !fs.lstatSync(journalPath).isFile()) {
        throw new Error(
            `Review findings validation rollback journal is missing or not a regular file: ` +
            `${normalizePath(journalPath)}.`
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    } catch (error: unknown) {
        throw new Error(
            `Review findings validation rollback journal is invalid JSON: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Review findings validation rollback journal must be a JSON object.');
    }
    const journal = parsed as Partial<ReviewArtifactFamilyRollbackJournal>;
    if (
        journal.schema_version !== 1
        || normalizeReviewArtifactPathForComparison(String(journal.artifact_path || ''))
            !== normalizeReviewArtifactPathForComparison(artifactPath)
        || !Array.isArray(journal.snapshots)
    ) {
        throw new Error('Review findings validation rollback journal binding is invalid.');
    }
    const seenPaths = new Set<string>();
    return journal.snapshots.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(
                `Review findings validation rollback journal snapshot ${index + 1} is invalid.`
            );
        }
        const snapshotPath = path.resolve(String(entry.path || ''));
        const normalizedSnapshotPath = normalizeReviewArtifactPathForComparison(snapshotPath);
        if (
            seenPaths.has(normalizedSnapshotPath)
            || !isReviewArtifactFamilyMemberPath(artifactPath, snapshotPath)
        ) {
            throw new Error(
                `Review findings validation rollback journal snapshot path is invalid: ` +
                `${normalizePath(snapshotPath)}.`
            );
        }
        seenPaths.add(normalizedSnapshotPath);
        assertReviewArtifactRollbackPathSafe(repoRoot, snapshotPath);
        if (typeof entry.existed !== 'boolean') {
            throw new Error(
                `Review findings validation rollback journal snapshot ${index + 1} is missing existed state.`
            );
        }
        if (!entry.existed) {
            if (entry.content_base64 !== null) {
                throw new Error(
                    `Review findings validation rollback journal snapshot ${index + 1} ` +
                    'must not contain bytes for an originally absent file.'
                );
            }
            return {
                path: snapshotPath,
                existed: false,
                content: null
            };
        }
        if (typeof entry.content_base64 !== 'string') {
            throw new Error(
                `Review findings validation rollback journal snapshot ${index + 1} is missing file bytes.`
            );
        }
        const content = Buffer.from(entry.content_base64, 'base64');
        if (content.toString('base64') !== entry.content_base64) {
            throw new Error(
                `Review findings validation rollback journal snapshot ${index + 1} has invalid base64 bytes.`
            );
        }
        return {
            path: snapshotPath,
            existed: true,
            content
        };
    });
}

export function recoverReviewArtifactFamilyRollbackIfPresent(
    repoRoot: string,
    artifactPath: string
): boolean {
    const journalPath = getReviewArtifactFamilyRollbackJournalPath(artifactPath);
    assertReviewArtifactRollbackPathSafe(repoRoot, journalPath);
    if (!fs.existsSync(journalPath)) {
        return false;
    }
    const snapshots = readReviewArtifactFamilyRollbackJournal(
        repoRoot,
        artifactPath,
        journalPath
    );
    snapshots
        .filter((snapshot) => snapshot.existed)
        .forEach((snapshot) => restoreReviewArtifactFile(repoRoot, snapshot));
    const originalExistingPaths = new Set(
        snapshots
            .filter((snapshot) => snapshot.existed)
            .map((snapshot) => normalizeReviewArtifactPathForComparison(snapshot.path))
    );
    const artifactDirectory = path.dirname(artifactPath);
    if (fs.existsSync(artifactDirectory) && fs.lstatSync(artifactDirectory).isDirectory()) {
        fs.readdirSync(artifactDirectory)
            .map((name) => path.join(artifactDirectory, name))
            .filter((candidatePath) => isReviewArtifactFamilyMemberPath(artifactPath, candidatePath))
            .filter((candidatePath) => !originalExistingPaths.has(
                normalizeReviewArtifactPathForComparison(candidatePath)
            ))
            .forEach((candidatePath) => {
                assertReviewArtifactRollbackPathSafe(repoRoot, candidatePath);
                if (!fs.lstatSync(candidatePath).isFile()) {
                    throw new Error(
                        `Review findings validation rollback family member must be a regular file: ` +
                        `${normalizePath(candidatePath)}.`
                    );
                }
                fs.rmSync(candidatePath, { force: true });
            });
    }
    fs.rmSync(journalPath, { force: true });
    return true;
}

function captureReviewArtifactFamily(repoRoot: string, artifactPath: string): ReviewArtifactFileSnapshot[] {
    recoverReviewArtifactFamilyRollbackIfPresent(repoRoot, artifactPath);
    const artifactDirectory = path.dirname(artifactPath);
    assertReviewArtifactRollbackPathSafe(repoRoot, artifactDirectory);
    const artifactExtension = path.extname(artifactPath);
    const artifactStem = path.basename(artifactPath, artifactExtension);
    if (!fs.existsSync(artifactDirectory) || !fs.lstatSync(artifactDirectory).isDirectory()) {
        return [captureReviewArtifactFile(repoRoot, artifactPath)];
    }
    const familyPaths = fs.readdirSync(artifactDirectory)
        .filter((name) => name === path.basename(artifactPath)
            || (name.startsWith(`${artifactStem}-`) && name.endsWith(artifactExtension)))
        .map((name) => path.join(artifactDirectory, name));
    if (!familyPaths.includes(artifactPath)) {
        familyPaths.push(artifactPath);
    }
    return familyPaths.map((familyPath) => captureReviewArtifactFile(repoRoot, familyPath));
}

export function restoreReviewArtifactFamily(
    repoRoot: string,
    artifactPath: string,
    snapshots: ReviewArtifactFileSnapshot[]
): void {
    if (recoverReviewArtifactFamilyRollbackIfPresent(repoRoot, artifactPath)) {
        return;
    }
    const journalPath = getReviewArtifactFamilyRollbackJournalPath(artifactPath);
    assertReviewArtifactRollbackPathSafe(repoRoot, journalPath);
    const journal: ReviewArtifactFamilyRollbackJournal = {
        schema_version: 1,
        artifact_path: normalizePath(path.resolve(artifactPath)),
        snapshots: snapshots.map((snapshot) => {
            if (snapshot.existed && snapshot.content === null) {
                throw new Error(
                    `Review findings validation rollback snapshot is missing content for ` +
                    `${normalizePath(snapshot.path)}.`
                );
            }
            return {
                path: normalizePath(path.resolve(snapshot.path)),
                existed: snapshot.existed,
                content_base64: snapshot.existed
                    ? snapshot.content!.toString('base64')
                    : null
            };
        })
    };
    writeFileAtomically(journalPath, `${JSON.stringify(journal, null, 2)}\n`, {
        encoding: 'utf8'
    });
    if (!recoverReviewArtifactFamilyRollbackIfPresent(repoRoot, artifactPath)) {
        throw new Error('Review findings validation rollback journal was not consumed.');
    }
}

async function emitFindingsValidationLaunchFailure(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    reviewContextSha256: string;
    launchArtifact: Record<string, unknown>;
    launchArtifactPath: string;
    launchArtifactSha256: string;
    rejectedLaunchArtifactSha256: string;
    rejectedAtUtc: string;
    validationReason: string;
    validationArtifactPath: string;
    validationArtifactSha256: string;
}): Promise<Awaited<ReturnType<typeof emitReviewerLaunchFailedEventAsync>>> {
    const reviewExecutionBindings = readReviewExecutionRuntimeBindings(
        options.launchArtifact,
        'Reviewer launch artifact'
    );
    return emitReviewerLaunchFailedEventAsync(
        gateHelpers.joinOrchestratorPath(options.repoRoot, ''),
        options.taskId,
        options.reviewType,
        'delegated_subagent',
        options.reviewerIdentity,
        options.reviewContextSha256,
        getArtifactStringField(options.launchArtifact, 'routing_event_sha256', 'routingEventSha256'),
        {
            launchDetails: {
                reviewer_launch_attempt_id: getArtifactStringField(
                    options.launchArtifact,
                    'reviewer_launch_attempt_id',
                    'reviewerLaunchAttemptId'
                ) || null,
                reviewer_launch_artifact_path: normalizePath(options.launchArtifactPath),
                reviewer_launch_artifact_sha256: options.launchArtifactSha256,
                rejected_reviewer_launch_artifact_sha256: options.rejectedLaunchArtifactSha256,
                provider_invocation_id: getArtifactStringField(
                    options.launchArtifact,
                    'provider_invocation_id',
                    'providerInvocationId'
                ) || null,
                controller_invocation_id: getArtifactStringField(
                    options.launchArtifact,
                    'controller_invocation_id',
                    'controllerInvocationId'
                ) || null,
                delegation_started_at_utc: getArtifactStringField(
                    options.launchArtifact,
                    'delegation_started_at_utc',
                    'delegationStartedAtUtc'
                ) || null,
                launch_failed_at_utc: options.rejectedAtUtc,
                launch_failure_stage: 'review_findings_validation',
                launch_failure_reason: options.validationReason,
                review_findings_validation_artifact_path: normalizePath(options.validationArtifactPath),
                review_findings_validation_artifact_sha256: options.validationArtifactSha256,
                ...reviewExecutionBindings
            }
        }
    );
}

const REVIEW_OUTPUT_COMPLETION_TIMESTAMP_TOLERANCE_MS = 1;
const FINDINGS_VALIDATION_FAILURE_FIELDS = [
    'launch_failure_stage',
    'launch_failure_reason',
    'launch_failed_at_utc',
    'launch_failure_recorded_by',
    'rejected_reviewer_launch_artifact_sha256',
    'review_findings_validation_artifact_path',
    'review_findings_validation_artifact_sha256',
    'review_result_rejected_at_utc'
] as const;

function resolveAuthenticatedReviewOutputCorrectionCapabilities(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    reviewContextSha256: string;
    invocationDetails: Record<string, unknown>;
}): {
    liveReviewerContinuation: boolean;
    apiConversationContinuation: boolean;
    providerId: string | null;
    providerInvocationId: string | null;
} {
    const unavailable = {
        liveReviewerContinuation: false,
        apiConversationContinuation: false,
        providerId: null,
        providerInvocationId: null
    };
    const launchArtifactPathValue = getArtifactStringField(
        options.invocationDetails,
        'reviewer_launch_artifact_path',
        'reviewerLaunchArtifactPath'
    );
    const expectedLaunchArtifactSha256 = getArtifactStringField(
        options.invocationDetails,
        'reviewer_launch_artifact_sha256',
        'reviewerLaunchArtifactSha256'
    ).toLowerCase();
    const launchArtifactPath = gateHelpers.resolvePathInsideRepo(
        launchArtifactPathValue,
        options.repoRoot,
        { allowMissing: true }
    );
    if (
        !launchArtifactPath
        || !fs.existsSync(launchArtifactPath)
        || !fs.statSync(launchArtifactPath).isFile()
        || !expectedLaunchArtifactSha256
        || fileSha256(launchArtifactPath)?.toLowerCase() !== expectedLaunchArtifactSha256
    ) {
        return unavailable;
    }
    let launchArtifact: Record<string, unknown>;
    try {
        const parsed = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as unknown;
        if (!isPlainRecord(parsed)) {
            return unavailable;
        }
        launchArtifact = parsed;
    } catch {
        return unavailable;
    }
    if (
        getArtifactStringField(launchArtifact, 'attestation_state', 'attestationState') !== 'launched'
        || getArtifactStringField(launchArtifact, 'task_id', 'taskId') !== options.taskId
        || getArtifactStringField(launchArtifact, 'review_type', 'reviewType').toLowerCase()
            !== options.reviewType
        || getArtifactStringField(launchArtifact, 'reviewer_identity', 'reviewerIdentity')
            !== options.reviewerIdentity
        || getArtifactStringField(launchArtifact, 'review_context_sha256', 'reviewContextSha256').toLowerCase()
            !== options.reviewContextSha256.toLowerCase()
    ) {
        return unavailable;
    }
    const provider = getArtifactStringField(launchArtifact, 'provider');
    const capabilities = getReviewOutputCorrectionProviderCapabilities(provider);
    const providerInvocationId = getArtifactStringField(
        launchArtifact,
        'provider_invocation_id',
        'providerInvocationId'
    );
    const invocationProviderInvocationId = getArtifactStringField(
        options.invocationDetails,
        'provider_invocation_id',
        'providerInvocationId'
    );
    const attestationSource = getArtifactStringField(
        launchArtifact,
        'attestation_source',
        'attestationSource'
    ) || getArtifactStringField(
        options.invocationDetails,
        'reviewer_launch_attestation_source',
        'reviewerLaunchAttestationSource',
        'attestation_source',
        'attestationSource'
    );
    const launchCompletedAtUtc = getArtifactStringField(
        launchArtifact,
        'launch_completed_at_utc',
        'launchCompletedAtUtc'
    );
    const hasProviderOwnedLiveSessionBinding = (
        getArtifactStringField(
            launchArtifact,
            'reviewer_execution_mode',
            'reviewerExecutionMode'
        ) === 'delegated_subagent'
        && !!providerInvocationId
        && providerInvocationId === invocationProviderInvocationId
        && !/^(?:unknown|n\/a|na|null|none|manual|mock|test|placeholder|<.*>)$/iu.test(providerInvocationId)
        && !!attestationSource
        && !/^(?:garda_prepare_reviewer_launch|orchestrator_mock|manual|mock|test|placeholder)$/iu.test(
            attestationSource
        )
        // Native Codex agent tools can continue a reviewer conversation, but do not
        // expose a provider response receipt that Garda can bind to corrected
        // output bytes. Keep that controller on the correction-only fallback.
        && ![
            'multi_agent_v1',
            'multi_agent_v1.spawn_agent',
            'collaboration.spawn_agent'
        ].includes(attestationSource.toLowerCase())
        && Number.isFinite(Date.parse(launchCompletedAtUtc))
    );
    return {
        // A provider capability alone is not liveness evidence. The continuation
        // branch is enabled only while the still-unconsumed attempt is bound to an
        // actual provider invocation and its completed delegated launch.
        liveReviewerContinuation:
            capabilities.liveReviewerContinuation && hasProviderOwnedLiveSessionBinding,
        apiConversationContinuation: capabilities.apiConversationContinuation,
        providerId: provider || null,
        providerInvocationId: providerInvocationId || null
    };
}

async function persistReviewOutputCorrectionRequired(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    reviewContextPath: string;
    rawReviewOutputContent: string;
    reviewOutputSourcePath?: string | null;
    validationEvidence: ReviewFindingsValidationEvidence;
    persistValidationEvidence: () => Promise<void>;
}): Promise<void> {
    const reviewContext = JSON.parse(
        fs.readFileSync(options.reviewContextPath, 'utf8')
    ) as Record<string, unknown>;
    const reviewContextSha256 = fileSha256(options.reviewContextPath) || '';
    const reviewTreeStateSha256 = getArtifactStringField(
        isPlainRecord(reviewContext.tree_state) ? reviewContext.tree_state : {},
        'tree_state_sha256',
        'treeStateSha256'
    ).toLowerCase();
    const timelinePath = gateHelpers.joinOrchestratorPath(
        options.repoRoot,
        path.join('runtime', 'task-events', `${options.taskId}.jsonl`)
    );
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const invocation = [...timelineEvents].reverse().find((event) => {
        const details = event.details || {};
        return event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
            && getArtifactStringField(details, 'task_id', 'taskId') === options.taskId
            && getArtifactStringField(details, 'review_type', 'reviewType').toLowerCase() === options.reviewType
            && getArtifactStringField(details, 'reviewer_identity', 'reviewerIdentity') === options.reviewerIdentity
            && getArtifactStringField(details, 'review_context_sha256', 'reviewContextSha256').toLowerCase() === reviewContextSha256;
    });
    const invocationDetails = invocation?.details || {};
    const reviewerAttemptId = getArtifactStringField(
        invocationDetails,
        'reviewer_launch_attempt_id',
        'reviewerLaunchAttemptId',
        'provider_invocation_id',
        'providerInvocationId'
    ) || String(invocation?.integrity?.event_sha256 || '').trim().toLowerCase();
    const reviewerInvocationEventSha256 = String(invocation?.integrity?.event_sha256 || '').trim().toLowerCase();
    if (!reviewerAttemptId) {
        throw new Error(
            `Review output correction cannot authenticate the reviewer attempt for '${options.reviewType}'. ` +
            'A fresh full reviewer is required.'
        );
    }
    const invocationIndex = invocation ? timelineEvents.lastIndexOf(invocation) : -1;
    const attemptAlreadyConsumed = invocationIndex >= 0 && timelineEvents.slice(invocationIndex + 1).some((event) => {
        const details = event.details || {};
        return event.event_type === 'REVIEW_RECORDED'
            && getArtifactStringField(details, 'review_type', 'reviewType').toLowerCase() === options.reviewType
            && getArtifactStringField(details, 'reviewer_identity', 'reviewerIdentity') === options.reviewerIdentity;
    });
    if (attemptAlreadyConsumed) {
        return;
    }
    await options.persistValidationEvidence();
    const correctionArtifactPath = getReviewOutputCorrectionArtifactPath(
        options.validationEvidence.payload.validation_result.bindings.output.review_artifact_path || ''
    );
    const previousCorrection = correctionArtifactPath
        ? readReviewOutputCorrectionArtifact(correctionArtifactPath)
        : { artifact: null, violations: [] as string[] };
    const correctionAttempt = previousCorrection.artifact
        && previousCorrection.violations.length === 0
        && previousCorrection.artifact.binding.review_context_sha256 === reviewContextSha256.toLowerCase()
        && previousCorrection.artifact.binding.review_tree_state_sha256 === reviewTreeStateSha256
        && previousCorrection.artifact.binding.reviewer_identity === options.reviewerIdentity
        && previousCorrection.artifact.binding.reviewer_attempt_id === reviewerAttemptId
        ? previousCorrection.artifact.recovery.correction_attempt + 1
        : 1;
    const reviewArtifactPath = options.validationEvidence.payload.validation_result.bindings.output.review_artifact_path;
    if (!reviewArtifactPath) {
        throw new Error(`Review output correction requires a canonical review artifact path for '${options.reviewType}'.`);
    }
    const provisionalRejectedPath = options.reviewOutputSourcePath || reviewArtifactPath;
    const correctionCapabilities = resolveAuthenticatedReviewOutputCorrectionCapabilities({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256,
        invocationDetails
    });
    const correctionArtifact = buildReviewOutputCorrectionArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        rejectedOutputPath: provisionalRejectedPath,
        rejectedOutputSha256: computeRawReviewOutputSha256(options.rawReviewOutputContent),
        rejectedOutputContent: options.rawReviewOutputContent,
        reviewContextPath: options.reviewContextPath,
        reviewContextSha256,
        reviewTreeStateSha256,
        reviewerIdentity: options.reviewerIdentity,
        reviewerAttemptId,
        reviewerInvocationEventSha256,
        validationArtifactPath: options.validationEvidence.snapshotPath,
        validationArtifactSha256: options.validationEvidence.artifactSha256,
        violations: options.validationEvidence.payload.validation_result.violations,
        correctionAttempt,
        capabilities: {
            gate_normalization: false,
            live_reviewer_continuation: correctionCapabilities.liveReviewerContinuation,
            api_conversation_continuation: correctionCapabilities.apiConversationContinuation,
            correction_only_invocation: true
        },
        providerId: correctionCapabilities.providerId,
        providerInvocationId: correctionCapabilities.providerInvocationId,
        sessionAvailability: 'pending'
    });
    const rejectedOutputPath = getRejectedReviewOutputArtifactPath(
        reviewArtifactPath,
        createHash('sha256').update(options.rawReviewOutputContent).digest('hex')
    );
    const correctionArtifactSnapshot = captureReviewArtifactFile(options.repoRoot, correctionArtifactPath);
    const correctionLaunchArtifactSnapshot = captureReviewArtifactFile(
        options.repoRoot,
        getReviewOutputCorrectionLaunchArtifactPath(reviewArtifactPath)
    );
    const rejectedOutputSnapshot = captureReviewArtifactFile(options.repoRoot, rejectedOutputPath);
    let persisted: ReturnType<typeof persistReviewOutputCorrection>;
    try {
        persisted = persistReviewOutputCorrection({
            repoRoot: options.repoRoot,
            reviewArtifactPath,
            rawOutput: options.rawReviewOutputContent,
            artifact: correctionArtifact
        });
    } catch (error) {
        restoreReviewArtifactFile(options.repoRoot, rejectedOutputSnapshot);
        restoreReviewArtifactFile(options.repoRoot, correctionLaunchArtifactSnapshot);
        restoreReviewArtifactFile(options.repoRoot, correctionArtifactSnapshot);
        throw error;
    }
    const details = {
        task_id: options.taskId,
        review_type: options.reviewType,
        state: persisted.artifact.state,
        reviewer_identity: options.reviewerIdentity,
        reviewer_attempt_id: reviewerAttemptId,
        reviewer_invocation_event_sha256: persisted.artifact.binding.reviewer_invocation_event_sha256,
        review_context_sha256: reviewContextSha256,
        review_tree_state_sha256: reviewTreeStateSha256,
        rejected_output_path: normalizePath(persisted.rejectedOutputPath),
        rejected_output_sha256: persisted.artifact.binding.original_output_sha256,
        findings_semantic_fingerprint: persisted.artifact.binding.findings_semantic_fingerprint,
        validation_artifact_path: normalizePath(options.validationEvidence.artifactPath),
        validation_artifact_sha256: options.validationEvidence.artifactSha256,
        correction_artifact_path: normalizePath(persisted.artifactPath),
        correction_artifact_sha256: persisted.artifact.artifact_sha256,
        correction_package_sha256: fileSha256(persisted.artifactPath),
        correction_attempt: persisted.artifact.recovery.correction_attempt,
        max_correction_attempts: persisted.artifact.recovery.max_correction_attempts,
        selected_transport: persisted.artifact.recovery.selected_transport,
        diagnostic_codes: persisted.artifact.diagnostics.map((diagnostic) => diagnostic.code),
        provider_id: persisted.artifact.transport_binding?.provider_id || null,
        provider_invocation_id: persisted.artifact.transport_binding?.provider_invocation_id || null,
        provider_capabilities: persisted.artifact.transport_binding?.provider_capabilities || null,
        provider_capabilities_sha256:
            persisted.artifact.transport_binding?.provider_capabilities_sha256 || null,
        session_availability: persisted.artifact.transport_binding?.session_availability || null
    };
    try {
        const event = persisted.artifact.state === 'FULL_REVIEW_REQUIRED'
            ? await emitReviewOutputCorrectionFullReviewRequiredEventAsync(
                gateHelpers.joinOrchestratorPath(options.repoRoot, ''),
                options.taskId,
                options.reviewType,
                details
            )
            : await emitReviewOutputCorrectionRequiredEventAsync(
                gateHelpers.joinOrchestratorPath(options.repoRoot, ''),
                options.taskId,
                options.reviewType,
                details
            );
        if (!event || taskEventAppendHasBlockingFailure(event, false)) {
            throw new Error(
                `Review output correction state could not be recorded for '${options.reviewType}'. ` +
                `Correction package: ${normalizePath(persisted.artifactPath)}.`
            );
        }
    } catch (error) {
        restoreReviewArtifactFile(options.repoRoot, rejectedOutputSnapshot);
        restoreReviewArtifactFile(options.repoRoot, correctionLaunchArtifactSnapshot);
        restoreReviewArtifactFile(options.repoRoot, correctionArtifactSnapshot);
        throw error;
    }
    if (
        persisted.artifact.state === 'REVIEW_OUTPUT_CORRECTION_REQUIRED'
        && (
            persisted.artifact.recovery.selected_transport === 'api_conversation_continuation'
            || persisted.artifact.recovery.selected_transport === 'correction_only_invocation'
        )
    ) {
        const pendingArtifactSnapshot = captureReviewArtifactFile(
            options.repoRoot,
            persisted.artifactPath
        );
        const pendingLaunchArtifactSnapshot = captureReviewArtifactFile(
            options.repoRoot,
            getReviewOutputCorrectionLaunchArtifactPath(reviewArtifactPath)
        );
        let selection: ReturnType<typeof persistReviewOutputCorrectionTransportSelection> | null = null;
        try {
            selection = persistReviewOutputCorrectionTransportSelection({
                repoRoot: options.repoRoot,
                artifactPath: persisted.artifactPath,
                artifact: persisted.artifact,
                sessionAvailability: 'stateless',
                reviewerIdentity: options.reviewerIdentity,
                providerInvocationId: correctionCapabilities.providerInvocationId || '',
                attestationSource: REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE
            });
            const binding = selection.artifact.transport_binding;
            const selectedTransport = selection.artifact.recovery.selected_transport;
            if (
                selectedTransport !== 'api_conversation_continuation'
                && selectedTransport !== 'correction_only_invocation'
            ) {
                throw new Error(
                    `Initial stateless correction selection produced unsupported transport '${selectedTransport}'.`
                );
            }
            const transportEvent = await emitReviewOutputCorrectionTransportEventAsync(
                gateHelpers.joinOrchestratorPath(options.repoRoot, ''),
                options.taskId,
                options.reviewType,
                selectedTransport,
                {
                    task_id: options.taskId,
                    review_type: options.reviewType,
                    reviewer_identity: options.reviewerIdentity,
                    reviewer_attempt_id: selection.artifact.binding.reviewer_attempt_id,
                    reviewer_invocation_event_sha256:
                        selection.artifact.binding.reviewer_invocation_event_sha256,
                    provider_id: binding?.provider_id || null,
                    provider_invocation_id: binding?.provider_invocation_id || null,
                    provider_capabilities: binding?.provider_capabilities || null,
                    provider_capabilities_sha256: binding?.provider_capabilities_sha256 || null,
                    session_availability: binding?.session_availability || null,
                    availability_attestation_source:
                        binding?.availability_attestation?.attestation_source || null,
                    availability_evidence_type:
                        binding?.availability_attestation?.evidence_type || null,
                    availability_provider_invocation_event_sha256:
                        binding?.availability_attestation?.provider_invocation_event_sha256 || null,
                    availability_provider_response_sha256:
                        binding?.availability_attestation?.provider_response_sha256 || null,
                    selected_transport: selectedTransport,
                    correction_attempt: selection.artifact.recovery.correction_attempt,
                    previous_correction_package_sha256: selection.previousArtifactFileSha256,
                    correction_package_sha256: selection.artifactFileSha256,
                    correction_artifact_path: normalizePath(selection.artifactPath),
                    correction_artifact_sha256: selection.artifact.artifact_sha256
                }
            );
            if (!transportEvent || taskEventAppendHasBlockingFailure(transportEvent, false)) {
                throw new Error(`Initial correction transport telemetry failed for '${options.reviewType}'.`);
            }
        } catch (error) {
            if (!correctionTransportEventMatchesPersistedSelection({
                timelinePath,
                reviewType: options.reviewType,
                selection
            })) {
                restoreReviewArtifactFile(options.repoRoot, pendingLaunchArtifactSnapshot);
                restoreReviewArtifactFile(options.repoRoot, pendingArtifactSnapshot);
            }
            throw error;
        }
    }
}

async function terminalizeCompletedLaunchAfterFindingsRejection(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    preflightPath: string;
    reviewContextPath: string;
    rawReviewOutputContent: string;
    reviewOutputSourcePath?: string | null;
    reviewOutputSourceMtimeUtc?: string | null;
    validationEvidence: ReviewFindingsValidationEvidence;
    persistValidationEvidence: () => Promise<void>;
}): Promise<void> {
    const reviewContextSha256 = fileSha256(options.reviewContextPath) || '';
    const reviewExecutionBindings = resolveReviewExecutionRuntimeBindings(
        JSON.parse(fs.readFileSync(options.reviewContextPath, 'utf8')) as Record<string, unknown>
    );
    const timelinePath = gateHelpers.joinOrchestratorPath(
        options.repoRoot,
        path.join('runtime', 'task-events', `${options.taskId}.jsonl`)
    );
    if (!inspectTaskEventFile(timelinePath, options.taskId).status.startsWith('PASS')) {
        await options.persistValidationEvidence();
        return;
    }
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const boundInvocation = [...timelineEvents].reverse().find((event) => {
        if (event.event_type !== 'REVIEWER_INVOCATION_ATTESTED' || !event.details || !event.integrity) {
            return false;
        }
        return getArtifactStringField(event.details, 'task_id', 'taskId') === options.taskId
            && getArtifactStringField(event.details, 'review_type', 'reviewType').toLowerCase() === options.reviewType
            && getArtifactStringField(event.details, 'reviewer_identity', 'reviewerIdentity') === options.reviewerIdentity
            && getArtifactStringField(event.details, 'review_context_sha256', 'reviewContextSha256').toLowerCase() === reviewContextSha256
            && !!getArtifactStringField(
                event.details,
                'reviewer_launch_artifact_sha256',
                'reviewerLaunchArtifactSha256'
            );
    });
    if (!boundInvocation?.details) {
        await options.persistValidationEvidence();
        return;
    }
    const launchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        artifactPathValue: getArtifactStringField(
            boundInvocation.details,
            'reviewer_launch_artifact_path',
            'reviewerLaunchArtifactPath'
        ) || undefined
    });
    if (!fs.existsSync(launchArtifactPath) || !fs.statSync(launchArtifactPath).isFile()) {
        await options.persistValidationEvidence();
        return;
    }

    const originalArtifactText = fs.readFileSync(launchArtifactPath, 'utf8');
    let launchArtifact: Record<string, unknown>;
    try {
        const parsed = JSON.parse(originalArtifactText) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            await options.persistValidationEvidence();
            return;
        }
        launchArtifact = parsed as Record<string, unknown>;
    } catch {
        await options.persistValidationEvidence();
        return;
    }

    const launchArtifactSha256 = fileSha256(launchArtifactPath) || '';
    const launchIdentityMatches = getArtifactStringField(launchArtifact, 'task_id', 'taskId') === options.taskId
        && getArtifactStringField(launchArtifact, 'review_type', 'reviewType').toLowerCase() === options.reviewType
        && getArtifactStringField(launchArtifact, 'reviewer_execution_mode', 'reviewerExecutionMode') === 'delegated_subagent'
        && getArtifactStringField(launchArtifact, 'reviewer_identity', 'reviewerIdentity') === options.reviewerIdentity
        && getArtifactStringField(launchArtifact, 'review_context_sha256', 'reviewContextSha256').toLowerCase() === reviewContextSha256;
    if (!launchIdentityMatches) {
        await options.persistValidationEvidence();
        return;
    }
    assertReviewExecutionRuntimeBindings(
        launchArtifact,
        reviewExecutionBindings,
        'Reviewer launch artifact'
    );
    const attestationState = getArtifactStringField(launchArtifact, 'attestation_state', 'attestationState');
    if (
        attestationState === 'launch_failed'
        && getArtifactStringField(launchArtifact, 'launch_failure_stage', 'launchFailureStage') === 'review_findings_validation'
    ) {
        if (hasRecordedReviewerLaunchFailure(timelineEvents, launchArtifact, launchArtifactPath, launchArtifactSha256)) {
            return;
        }
        const rejectedLaunchArtifactSha256 = getArtifactStringField(
            launchArtifact,
            'rejected_reviewer_launch_artifact_sha256',
            'rejectedReviewerLaunchArtifactSha256'
        ).toLowerCase();
        const invocationLaunchArtifactSha256 = getArtifactStringField(
            boundInvocation.details,
            'reviewer_launch_artifact_sha256',
            'reviewerLaunchArtifactSha256'
        ).toLowerCase();
        if (
            !rejectedLaunchArtifactSha256
            || rejectedLaunchArtifactSha256 !== invocationLaunchArtifactSha256
            || !findCompletedReviewerLaunchAttempt(
                timelineEvents,
                launchArtifact,
                launchArtifactPath,
                rejectedLaunchArtifactSha256
            )
            || isCompletedReviewerLaunchAttemptConsumed(timelineEvents, launchArtifact)
        ) {
            throw new Error(
                `Rejected findings recovery cannot authenticate the original completed launch for '${options.reviewType}'.`
            );
        }
        const storedValidationArtifactPath = gateHelpers.resolvePathInsideRepo(
            getArtifactStringField(
                launchArtifact,
                'review_findings_validation_artifact_path',
                'reviewFindingsValidationArtifactPath'
            ),
            options.repoRoot,
            { allowMissing: true }
        );
        const storedValidationArtifactSha256 = getArtifactStringField(
            launchArtifact,
            'review_findings_validation_artifact_sha256',
            'reviewFindingsValidationArtifactSha256'
        ).toLowerCase();
        const expectedValidationArtifactPath = normalizeArtifactPathForComparison(
            options.validationEvidence.artifactPath
        );
        if (
            !storedValidationArtifactPath
            || !storedValidationArtifactSha256
            || normalizeArtifactPathForComparison(storedValidationArtifactPath) !== expectedValidationArtifactPath
            || storedValidationArtifactSha256 !== options.validationEvidence.artifactSha256.toLowerCase()
            || fileSha256(storedValidationArtifactPath)?.toLowerCase() !== storedValidationArtifactSha256
        ) {
            throw new Error(
                `Rejected findings recovery cannot authenticate persisted validation evidence for '${options.reviewType}'.`
            );
        }
        const replayedFailureEvent = await emitFindingsValidationLaunchFailure({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerIdentity: options.reviewerIdentity,
            reviewContextSha256,
            launchArtifact,
            launchArtifactPath,
            launchArtifactSha256,
            rejectedLaunchArtifactSha256,
            rejectedAtUtc: getArtifactStringField(
                launchArtifact,
                'launch_failed_at_utc',
                'launchFailedAtUtc'
            ) || new Date().toISOString(),
            validationReason: getArtifactStringField(
                launchArtifact,
                'launch_failure_reason',
                'launchFailureReason'
            ) || 'Review findings validation rejected the delegated reviewer output.',
            validationArtifactPath: storedValidationArtifactPath,
            validationArtifactSha256: storedValidationArtifactSha256
        });
        if (!replayedFailureEvent || taskEventAppendHasBlockingFailure(replayedFailureEvent, false)) {
            throw new Error(
                `Rejected findings recovery requires REVIEWER_LAUNCH_FAILED telemetry for '${options.reviewType}'.`
            );
        }
        return;
    }
    if (
        attestationState !== 'launched'
        || getArtifactStringField(
            boundInvocation.details,
            'reviewer_launch_artifact_sha256',
            'reviewerLaunchArtifactSha256'
        ).toLowerCase() !== launchArtifactSha256
        || !launchArtifactSha256
    ) {
        await options.persistValidationEvidence();
        return;
    }
    const completedLaunchAttempt = findCompletedReviewerLaunchAttempt(
        timelineEvents,
        launchArtifact,
        launchArtifactPath,
        launchArtifactSha256
    );
    if (!completedLaunchAttempt) {
        await options.persistValidationEvidence();
        return;
    }
    if (isCompletedReviewerLaunchAttemptConsumed(timelineEvents, launchArtifact)) {
        return;
    }
    const validationArtifactSnapshots = captureReviewArtifactFamily(
        options.repoRoot,
        options.validationEvidence.artifactPath
    );
    const boundReviewOutputPath = getArtifactStringField(
        launchArtifact,
        'review_output_path',
        'reviewOutputPath'
    );
    const resolvedBoundReviewOutputPath = gateHelpers.resolvePathInsideRepo(
        boundReviewOutputPath,
        options.repoRoot,
        { allowMissing: true }
    );
    const resolvedReviewOutputSourcePath = gateHelpers.resolvePathInsideRepo(
        String(options.reviewOutputSourcePath || ''),
        options.repoRoot,
        { allowMissing: true }
    );
    const comparablePath = (value: string): string => {
        const resolved = path.resolve(value);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    if (!String(options.reviewOutputSourcePath || '').trim()) {
        try {
            await persistReviewOutputCorrectionRequired({
                repoRoot: options.repoRoot,
                taskId: options.taskId,
                reviewType: options.reviewType,
                reviewerIdentity: options.reviewerIdentity,
                reviewContextPath: options.reviewContextPath,
                rawReviewOutputContent: options.rawReviewOutputContent,
                reviewOutputSourcePath: null,
                validationEvidence: options.validationEvidence,
                persistValidationEvidence: options.persistValidationEvidence
            });
        } catch (error: unknown) {
            restoreReviewArtifactFamily(options.repoRoot, options.validationEvidence.artifactPath, validationArtifactSnapshots);
            throw error;
        }
        return;
    }
    if (
        !resolvedBoundReviewOutputPath
        || !resolvedReviewOutputSourcePath
        || comparablePath(resolvedBoundReviewOutputPath) !== comparablePath(resolvedReviewOutputSourcePath)
        || !options.reviewOutputSourceMtimeUtc
    ) {
        await options.persistValidationEvidence();
        return;
    }
    const reviewOutputSourceMtimeMs = Date.parse(options.reviewOutputSourceMtimeUtc);
    const completionEventTimestampMs = Date.parse(getArtifactStringField(
        completedLaunchAttempt.details || {},
        'launch_completed_at_utc',
        'launchCompletedAtUtc'
    ));
    if (
        !Number.isFinite(reviewOutputSourceMtimeMs)
        || !Number.isFinite(completionEventTimestampMs)
        || reviewOutputSourceMtimeMs
            > completionEventTimestampMs + REVIEW_OUTPUT_COMPLETION_TIMESTAMP_TOLERANCE_MS
    ) {
        await options.persistValidationEvidence();
        return;
    }
    assertReviewOutputNotOlderThanDelegation({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightPath: options.preflightPath,
        repoRoot: options.repoRoot,
        reviewerExecutionMode: 'delegated_subagent',
        reviewerIdentity: options.reviewerIdentity,
        reviewOutputSourcePath: resolvedReviewOutputSourcePath,
        reviewOutputSourceMtimeUtc: options.reviewOutputSourceMtimeUtc,
        delegationStartedAtUtc: getArtifactStringField(
            launchArtifact,
            'delegation_started_at_utc',
            'delegationStartedAtUtc'
        )
    });
    try {
        await persistReviewOutputCorrectionRequired({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerIdentity: options.reviewerIdentity,
            reviewContextPath: options.reviewContextPath,
            rawReviewOutputContent: options.rawReviewOutputContent,
            reviewOutputSourcePath: options.reviewOutputSourcePath,
            validationEvidence: options.validationEvidence,
            persistValidationEvidence: options.persistValidationEvidence
        });
    } catch (error: unknown) {
        restoreReviewArtifactFamily(options.repoRoot, options.validationEvidence.artifactPath, validationArtifactSnapshots);
        throw error;
    }
}

function restoreCompletedLaunchAfterAcceptedFindingsCorrection(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    invocationEvent: ReturnType<typeof readDependencyTimelineEvents>[number] | null;
    timelineEvents: ReturnType<typeof readDependencyTimelineEvents>;
}): { rollback: () => void } | null {
    const invocationDetails = options.invocationEvent?.details;
    if (!invocationDetails) {
        return null;
    }
    const launchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        artifactPathValue: getArtifactStringField(
            invocationDetails,
            'reviewer_launch_artifact_path',
            'reviewerLaunchArtifactPath'
        ) || undefined
    });
    if (!fs.existsSync(launchArtifactPath) || !fs.statSync(launchArtifactPath).isFile()) {
        return null;
    }
    const failedArtifactText = fs.readFileSync(launchArtifactPath, 'utf8');
    let failedArtifact: Record<string, unknown>;
    try {
        const parsed = JSON.parse(failedArtifactText) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        failedArtifact = parsed as Record<string, unknown>;
    } catch {
        return null;
    }
    if (
        getArtifactStringField(failedArtifact, 'attestation_state', 'attestationState') !== 'launch_failed'
        || getArtifactStringField(
            failedArtifact,
            'launch_failure_stage',
            'launchFailureStage'
        ) !== 'review_findings_validation'
    ) {
        return null;
    }
    const failedArtifactSha256 = fileSha256(launchArtifactPath) || '';
    const completedArtifactSha256 = getArtifactStringField(
        failedArtifact,
        'rejected_reviewer_launch_artifact_sha256',
        'rejectedReviewerLaunchArtifactSha256'
    ).toLowerCase();
    const invocationArtifactSha256 = getArtifactStringField(
        invocationDetails,
        'reviewer_launch_artifact_sha256',
        'reviewerLaunchArtifactSha256'
    ).toLowerCase();
    if (
        !failedArtifactSha256
        || !completedArtifactSha256
        || completedArtifactSha256 !== invocationArtifactSha256
        || !hasRecordedReviewerLaunchFailure(
            options.timelineEvents,
            failedArtifact,
            launchArtifactPath,
            failedArtifactSha256
        )
        || !findCompletedReviewerLaunchAttempt(
            options.timelineEvents,
            failedArtifact,
            launchArtifactPath,
            completedArtifactSha256
        )
    ) {
        throw new Error(
            `Accepted findings correction cannot authenticate the original completed launch for '${options.reviewType}'.`
        );
    }
    const restoredArtifact: Record<string, unknown> = {
        ...failedArtifact,
        attestation_state: 'launched'
    };
    for (const fieldName of FINDINGS_VALIDATION_FAILURE_FIELDS) {
        delete restoredArtifact[fieldName];
    }
    try {
        writeReviewArtifactJson(launchArtifactPath, restoredArtifact);
        if (fileSha256(launchArtifactPath)?.toLowerCase() !== completedArtifactSha256) {
            throw new Error('restored launch artifact hash does not match the completed launch');
        }
    } catch (error: unknown) {
        try {
            restoreReviewerLaunchArtifactTextForResultRollback(launchArtifactPath, failedArtifactText);
        } catch (rollbackError) {
            throw new Error(
                `Accepted findings correction could not restore the completed launch for '${options.reviewType}', ` +
                `and the failed launch artifact rollback also failed: ` +
                `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}. ` +
                `Original failure: ${error instanceof Error ? error.message : String(error)}`
            );
        }
        throw new Error(
            `Accepted findings correction could not restore the completed launch for '${options.reviewType}': ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
    }
    return {
        rollback: () => {
            restoreReviewerLaunchArtifactTextForResultRollback(launchArtifactPath, failedArtifactText);
            if (fileSha256(launchArtifactPath)?.toLowerCase() !== failedArtifactSha256.toLowerCase()) {
                throw new Error('failed launch artifact hash was not restored');
            }
        }
    };
}

function summarizeReviewFindingsValidationEvidence(evidence: ReviewFindingsValidationEvidence): Record<string, unknown> {
    return {
        artifact_path: normalizePath(evidence.artifactPath),
        artifact_sha256: evidence.artifactSha256,
        snapshot_path: normalizePath(evidence.snapshotPath),
        snapshot_sha256: evidence.artifactSha256,
        status: evidence.payload.validation_result.status,
        accepted: evidence.payload.validation_result.accepted,
        validation_result_sha256: evidence.payload.validation_result_sha256,
        violation_count: evidence.payload.validation_result.violations.length
    };
}

function summarizeReviewFindingsDispositionEvidence(evidence: ReviewFindingsDispositionEvidence): Record<string, unknown> {
    return {
        artifact_path: normalizePath(evidence.artifactPath),
        artifact_sha256: evidence.artifactSha256,
        snapshot_path: normalizePath(evidence.snapshotPath),
        snapshot_sha256: evidence.artifactSha256,
        disposition_result_sha256: evidence.payload.disposition_result_sha256,
        policy_id: evidence.payload.policy.policy_id,
        policy_source: evidence.payload.policy.policy_source,
        item_count: evidence.payload.summary.item_count,
        fix_now_count: evidence.payload.summary.fix_now_count,
        follow_up_pending_count: evidence.payload.summary.follow_up_pending_count,
        ignored_count: evidence.payload.summary.ignored_count,
        blocking_count: evidence.payload.summary.blocking_count
    };
}

interface ReviewOutputCorrectionAcceptanceTransaction {
    artifactPath: string;
    artifact: ReviewOutputCorrectionArtifact;
    providerResponseEventSha256?: string;
    invocationEventDetails: Record<string, unknown>;
    acceptedEventDetails: Record<string, unknown>;
}

function hasReviewOutputCorrectionInvocationAttestation(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    details: Record<string, unknown>;
}): boolean {
    const timelinePath = gateHelpers.joinOrchestratorPath(
        options.repoRoot,
        path.join('runtime', 'task-events', `${options.taskId}.jsonl`)
    );
    return readDependencyTimelineEvents(timelinePath).some((event) => {
        if (event.event_type !== 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED') {
            return false;
        }
        const details = event.details || {};
        return getArtifactStringField(details, 'task_id', 'taskId') === options.taskId
            && getArtifactStringField(details, 'review_type', 'reviewType').toLowerCase() === options.reviewType
            && getArtifactStringField(details, 'correction_producer_identity', 'correctionProducerIdentity')
                === getArtifactStringField(
                    options.details,
                    'correction_producer_identity',
                    'correctionProducerIdentity'
                )
            && getArtifactStringField(details, 'provider_invocation_id', 'providerInvocationId')
                === getArtifactStringField(options.details, 'provider_invocation_id', 'providerInvocationId')
            && getArtifactStringField(details, 'launch_input_sha256', 'launchInputSha256').toLowerCase()
                === getArtifactStringField(options.details, 'launch_input_sha256', 'launchInputSha256').toLowerCase();
    });
}

async function writeReviewReceiptSnapshotsAndTelemetry(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    artifactPath: string;
    artifactContent?: string | null;
    contextPath: string;
    rawReviewOutputPath?: string | null;
    rawReviewOutputSourcePath?: string | null;
    rawReviewOutputContent?: string | null;
    rawReviewOutputSha256?: string | null;
    receipt: Record<string, unknown>;
    receiptPayloadSha256: string;
    artifactSha256: string | null;
    findingsValidationEvidence?: ReviewFindingsValidationEvidence | null;
    findingsDispositionEvidence?: ReviewFindingsDispositionEvidence | null;
    remediationBaselineEvidence?: ReviewRemediationBaselineEvidence | null;
    correctionAcceptance?: ReviewOutputCorrectionAcceptanceTransaction | null;
}): Promise<string> {
    const receiptPath = options.artifactPath.replace(/\.md$/, '-receipt.json');
    const receiptSnapshotPath = options.artifactPath.replace(/\.md$/, `-receipt-${options.receiptPayloadSha256}.json`);
    const artifactSnapshotPath = options.artifactPath.replace(/\.md$/, `-artifact-${options.artifactSha256}.md`);

    const orchestratorRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, '');
    const artifactContent = options.artifactContent ?? fs.readFileSync(options.artifactPath, 'utf8');
    const writes = [
        ...(options.rawReviewOutputPath && options.rawReviewOutputContent != null
            ? [{
                artifactPath: options.rawReviewOutputPath,
                contentType: 'text' as const,
                content: options.rawReviewOutputContent
            }]
            : []),
        ...(options.artifactContent != null
            ? [{
                artifactPath: options.artifactPath,
                contentType: 'text' as const,
                content: options.artifactContent
            }]
            : []),
        {
            artifactPath: receiptPath,
            contentType: 'json' as const,
            payload: options.receipt
        },
        {
            artifactPath: receiptSnapshotPath,
            contentType: 'json' as const,
            payload: options.receipt
        },
        ...(options.findingsValidationEvidence
            ? [
                {
                    artifactPath: options.findingsValidationEvidence.artifactPath,
                    contentType: 'json' as const,
                    payload: options.findingsValidationEvidence.payload
                },
                {
                    artifactPath: options.findingsValidationEvidence.snapshotPath,
                    contentType: 'json' as const,
                    payload: options.findingsValidationEvidence.payload
                }
            ]
            : []),
        ...(options.findingsDispositionEvidence
            ? [
                {
                    artifactPath: options.findingsDispositionEvidence.artifactPath,
                    contentType: 'json' as const,
                    payload: options.findingsDispositionEvidence.payload
                },
                {
                    artifactPath: options.findingsDispositionEvidence.snapshotPath,
                    contentType: 'json' as const,
                    payload: options.findingsDispositionEvidence.payload
                }
            ]
            : []),
        ...(options.remediationBaselineEvidence
            ? [
                {
                    artifactPath: options.remediationBaselineEvidence.artifactPath,
                    contentType: 'json' as const,
                    payload: options.remediationBaselineEvidence.payload
                },
                {
                    artifactPath: options.remediationBaselineEvidence.snapshotPath,
                    contentType: 'json' as const,
                    payload: options.remediationBaselineEvidence.payload
                }
            ]
            : []),
        ...(options.correctionAcceptance
            ? [{
                artifactPath: options.correctionAcceptance.artifactPath,
                contentType: 'json' as const,
                payload: options.correctionAcceptance.artifact
            }]
            : []),
        {
            artifactPath: artifactSnapshotPath,
            contentType: 'text' as const,
            content: artifactContent
        }
    ];
    await writeReviewArtifactsWithRollback(writes, async () => {
        assertReviewArtifactFileSha256(receiptPath, options.receiptPayloadSha256, 'Review receipt');
        assertReviewArtifactFileSha256(receiptSnapshotPath, options.receiptPayloadSha256, 'Review receipt snapshot');
        assertReviewArtifactFileSha256(options.artifactPath, options.artifactSha256, 'Review artifact');
        assertReviewArtifactFileSha256(artifactSnapshotPath, options.artifactSha256, 'Review artifact snapshot');
        if (options.rawReviewOutputPath && options.rawReviewOutputContent != null) {
            assertReviewArtifactFileSha256(
                options.rawReviewOutputPath,
                options.rawReviewOutputSha256,
                'Canonical raw review output'
            );
        }
        if (options.findingsValidationEvidence) {
            assertReviewArtifactFileSha256(
                options.findingsValidationEvidence.artifactPath,
                options.findingsValidationEvidence.artifactSha256,
                'Review findings validation artifact'
            );
            assertReviewArtifactFileSha256(
                options.findingsValidationEvidence.snapshotPath,
                options.findingsValidationEvidence.artifactSha256,
                'Review findings validation snapshot'
            );
        }
        if (options.findingsDispositionEvidence) {
            assertReviewArtifactFileSha256(
                options.findingsDispositionEvidence.artifactPath,
                options.findingsDispositionEvidence.artifactSha256,
                'Review findings disposition artifact'
            );
            assertReviewArtifactFileSha256(
                options.findingsDispositionEvidence.snapshotPath,
                options.findingsDispositionEvidence.artifactSha256,
                'Review findings disposition snapshot'
            );
        }
        if (options.remediationBaselineEvidence) {
            assertReviewArtifactFileSha256(
                options.remediationBaselineEvidence.artifactPath,
                options.remediationBaselineEvidence.artifactSha256,
                'Review remediation baseline artifact'
            );
            assertReviewArtifactFileSha256(
                options.remediationBaselineEvidence.snapshotPath,
                options.remediationBaselineEvidence.artifactSha256,
                'Review remediation baseline snapshot'
            );
        }
        if (options.correctionAcceptance) {
            assertReviewArtifactFileSha256(
                options.correctionAcceptance.artifactPath,
                sha256RedactedJsonPayload(options.correctionAcceptance.artifact),
                'Review output correction artifact'
            );
            if (
                !options.correctionAcceptance.providerResponseEventSha256
                && !hasReviewOutputCorrectionInvocationAttestation({
                repoRoot: options.repoRoot,
                taskId: options.taskId,
                reviewType: options.reviewType,
                details: options.correctionAcceptance.invocationEventDetails
                })
            ) {
                const invocationEvent = await emitReviewOutputCorrectionInvocationAttestedEventAsync(
                    orchestratorRoot,
                    options.taskId,
                    options.reviewType,
                    options.correctionAcceptance.invocationEventDetails
                );
                if (!invocationEvent || taskEventAppendHasBlockingFailure(invocationEvent, false)) {
                    throw new Error(
                        `Review output correction invocation attestation failed for '${options.reviewType}'.`
                    );
                }
            }
            const acceptedEvent = await emitReviewOutputCorrectionAcceptedEventAsync(
                orchestratorRoot,
                options.taskId,
                options.reviewType,
                options.correctionAcceptance.acceptedEventDetails
            );
            if (!acceptedEvent || taskEventAppendHasBlockingFailure(acceptedEvent, false)) {
                throw new Error(`Review output correction acceptance telemetry failed for '${options.reviewType}'.`);
            }
        }
        const recordedEvent = await emitReviewRecordedEventAsync(orchestratorRoot, options.taskId, options.reviewType, {
            ...buildBoundedReviewRecordedTelemetryDetails(options.receipt),
            receipt_path: normalizePath(receiptPath),
            receipt_sha256: options.receiptPayloadSha256,
            receipt_snapshot_path: normalizePath(receiptSnapshotPath),
            receipt_snapshot_sha256: options.receiptPayloadSha256,
            review_artifact_path: normalizePath(options.artifactPath),
            review_artifact_snapshot_path: normalizePath(artifactSnapshotPath),
            review_artifact_snapshot_sha256: options.artifactSha256,
            review_context_path: normalizePath(options.contextPath),
            ...(options.remediationBaselineEvidence
                ? {
                    remediation_baseline_path: normalizePath(options.remediationBaselineEvidence.artifactPath),
                    remediation_baseline_sha256: options.remediationBaselineEvidence.artifactSha256,
                    remediation_baseline_snapshot_path: normalizePath(options.remediationBaselineEvidence.snapshotPath),
                    remediation_baseline_snapshot_sha256: options.remediationBaselineEvidence.artifactSha256
                }
                : {})
        });
        if (!recordedEvent || taskEventAppendHasBlockingFailure(recordedEvent, false)) {
            throw new Error(
                `Review receipts require REVIEW_RECORDED telemetry for '${options.reviewType}'. ` +
                'The lifecycle event could not be persisted.'
            );
        }
    });
    return receiptPath;
}

async function recordReviewReceiptFromArtifacts(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    artifactPath: string;
    reviewArtifactContent?: string | null;
    contextPath: string;
    rawReviewOutputPath?: string | null;
    rawReviewOutputSourcePath?: string | null;
    rawReviewOutputContent?: string | null;
    rawReviewOutputSha256?: string | null;
    rawReviewOutputSourceMtimeUtc?: string | null;
    reviewMaterializationFidelity?: string | null;
    historicalStaleReviewResultReason?: string | null;
    taskModePath?: string | null;
    reviewerExecutionMode: ReviewerExecutionMode;
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
    requireStrictBindingMetadata?: boolean;
    invocationReviewContextSha256?: string | null;
    routingReviewerIdentity?: string | null;
    correctionAcceptance?: ReviewOutputCorrectionAcceptanceTransaction | null;
}, dependencies: ReviewResultHandlersDependencies): Promise<string> {
    if (
        options.reviewArtifactContent == null
        && (!fs.existsSync(options.artifactPath) || !fs.statSync(options.artifactPath).isFile())
    ) {
        throw new Error(`Review artifact not found: ${options.artifactPath}`);
    }

    const preflight = JSON.parse(fs.readFileSync(options.preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(options.preflightPath);
    const artifactSha256 = options.reviewArtifactContent == null
        ? fileSha256(options.artifactPath)
        : sha256ReviewArtifactContent(options.reviewArtifactContent);
    const parsedReviewContext = JSON.parse(fs.readFileSync(options.contextPath, 'utf8')) as Record<string, unknown>;
    dependencies.assertReviewContextContractOrThrow({
        taskId: options.taskId,
        reviewType: options.reviewType,
        contextPath: options.contextPath,
        reviewContext: parsedReviewContext,
        preflightPath: options.preflightPath,
        preflightSha256,
        preflightPayload: preflight,
        requireStrictBindingMetadata: options.requireStrictBindingMetadata,
        repoRoot: options.repoRoot
    });
    const reviewExecutionBindings = resolveReviewExecutionRuntimeBindings(parsedReviewContext);
    const reviewLaneContract = resolveAuthenticatedReviewLaneContract({
        preflight,
        reviewContext: parsedReviewContext,
        reviewType: options.reviewType
    });
    const reviewArtifactContent = options.reviewArtifactContent
        ?? fs.readFileSync(options.artifactPath, 'utf8');
    const historicalStaleReviewResultReason = options.historicalStaleReviewResultReason || null;
    assertReviewTreeStateFreshOrHistoricalFailure({
        repoRoot: options.repoRoot,
        reviewContext: parsedReviewContext,
        contextPath: options.contextPath,
        gateName: 'record-review-receipt',
        allowHistoricalFailedReviewResult: Boolean(historicalStaleReviewResultReason)
    });
    resolveReviewerPromptArtifactBinding({
        repoRoot: options.repoRoot,
        contextPath: options.contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'record-review-receipt'
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const runtimeIdentity = dependencies.assertExplicitReviewContextRuntimeIdentity({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        contextPath: options.contextPath,
        reviewerRouting: currentRouting,
        taskModePath: String(options.taskModePath || '').trim()
    });
    dependencies.assertRoutingCompatibility({
        reviewType: options.reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerFallbackReason: options.reviewerFallbackReason
    });
    assertReviewReceiptRoutingMatchesContext({
        reviewType: options.reviewType,
        contextPath: options.contextPath,
        currentRouting,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewerFallbackReason: options.reviewerFallbackReason
    });

    const currentReviewerSessionId = currentRouting?.reviewer_session_id != null
        ? String(currentRouting.reviewer_session_id).trim()
        : '';
    const explicitRoutingReviewerIdentity = String(options.routingReviewerIdentity || '').trim();
    const routingReviewerIdentity = explicitRoutingReviewerIdentity
        || (isPlannedReviewerIdentity(currentReviewerSessionId)
            ? currentReviewerSessionId
            : options.reviewerIdentity);
    const timelinePath = gateHelpers.joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events', `${options.taskId}.jsonl`));
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const routingEvent = dependencies.findMatchingRoutingEvent(
        timelineEvents,
        options.reviewType,
        options.reviewerExecutionMode,
        routingReviewerIdentity,
        options.reviewerFallbackReason
    ) || (
        explicitRoutingReviewerIdentity && explicitRoutingReviewerIdentity !== options.reviewerIdentity
            ? null
            : isResolvedReviewerIdentity(options.reviewerIdentity)
                ? dependencies.findMatchingRoutingEvent(
                    timelineEvents,
                    options.reviewType,
                    options.reviewerExecutionMode,
                    buildPlannedReviewerIdentity(options.taskId, options.reviewType),
                    options.reviewerFallbackReason
                )
                : null
    );
    if (!routingEvent) {
        throw new Error(
            `Review receipts require pre-recorded REVIEWER_DELEGATION_ROUTED telemetry for '${options.reviewType}' ` +
            'in the current cycle ' +
            `with reviewer '${routingReviewerIdentity}' and execution mode '${options.reviewerExecutionMode}'.`
        );
    }
    const routingEventProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
    if (!routingEventProvenance) {
        throw new Error(
            `Review receipts require controller-attested reviewer_provenance for delegated_subagent '${options.reviewType}' reviews. ` +
            'Matching routing telemetry is missing event integrity.'
        );
    }

    const contextSha256 = fileSha256(options.contextPath);
    if (!contextSha256) {
        throw new Error(`Review receipts require a hashable review-context artifact: ${normalizePath(options.contextPath)}.`);
    }
    const invocationReviewContextSha256 = String(options.invocationReviewContextSha256 || '').trim().toLowerCase()
        || contextSha256;
    const reviewTreeStateSha256 = dependencies.getReviewTreeStateSha256(parsedReviewContext) || null;
    const invocationEvent = dependencies.findMatchingReviewerInvocationAttestationEvent(timelineEvents, {
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256: invocationReviewContextSha256,
        reviewTreeStateSha256,
        routingEventSha256: routingEventProvenance.event_sha256
    }) || (
        isResolvedReviewerIdentity(options.reviewerIdentity)
            ? [...timelineEvents].reverse().find((entry) => {
                const details = entry.details;
                const detailsReviewContextSha256 = String(details?.review_context_sha256 || details?.reviewContextSha256 || '')
                    .trim()
                    .toLowerCase();
                return entry.event_type === 'REVIEWER_INVOCATION_ATTESTED'
                    && String(details?.task_id || details?.taskId || '').trim() === options.taskId
                    && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === options.reviewType
                    && String(details?.reviewer_execution_mode || details?.reviewerExecutionMode || '').trim() === options.reviewerExecutionMode
                    && String(details?.reviewer_identity || details?.reviewer_session_id || '').trim() === options.reviewerIdentity
                    && detailsReviewContextSha256 === invocationReviewContextSha256
                    && String(details?.routing_event_sha256 || details?.routingEventSha256 || '').trim().toLowerCase() === routingEventProvenance.event_sha256
                    && (!reviewTreeStateSha256 || String(details?.review_tree_state_sha256 || details?.reviewTreeStateSha256 || '').trim().toLowerCase() === reviewTreeStateSha256)
                    && entry.integrity;
            }) || null
            : null
    );
    const reviewerProvenance = buildReviewReceiptReviewerInvocationProvenance(
        invocationEvent?.event_type || '',
        invocationEvent?.integrity,
        invocationEvent?.details
    );
    if (options.reviewerExecutionMode === 'delegated_subagent' && !reviewerProvenance) {
        throw new Error(
            `Review receipts require REVIEWER_INVOCATION_ATTESTED launch provenance for delegated_subagent '${options.reviewType}' reviews. ` +
            'Run the real delegated reviewer launch path before recording reviewer output; local routing telemetry alone is not enough.'
        );
    }
    if (options.reviewerExecutionMode === 'delegated_subagent') {
        const invocationDetails = invocationEvent?.details;
        const expectedLaunchArtifactSha256 = getArtifactStringField(
            invocationDetails || {},
            'reviewer_launch_artifact_sha256',
            'reviewerLaunchArtifactSha256'
        ).toLowerCase();
        const invocationLaunchArtifactPath = getArtifactStringField(
            invocationDetails || {},
            'reviewer_launch_artifact_path',
            'reviewerLaunchArtifactPath'
        );
        const launchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            artifactPathValue: invocationLaunchArtifactPath || undefined
        });
        if (
            !/^[0-9a-f]{64}$/u.test(expectedLaunchArtifactSha256)
            || !invocationLaunchArtifactPath
            || !fs.existsSync(launchArtifactPath)
            || !fs.statSync(launchArtifactPath).isFile()
        ) {
            throw new Error(
                `Review receipts require an invocation-bound reviewer launch artifact for '${options.reviewType}'.`
            );
        }
        const launchArtifact = JSON.parse(
            fs.readFileSync(launchArtifactPath, 'utf8')
        ) as Record<string, unknown>;
        const currentLaunchArtifactSha256 = fileSha256(launchArtifactPath)?.toLowerCase() || '';
        const acceptedFindingsCorrection =
            getArtifactStringField(launchArtifact, 'attestation_state', 'attestationState') === 'launch_failed'
            && getArtifactStringField(
                launchArtifact,
                'launch_failure_stage',
                'launchFailureStage'
            ) === 'review_findings_validation'
            && getArtifactStringField(
                launchArtifact,
                'rejected_reviewer_launch_artifact_sha256',
                'rejectedReviewerLaunchArtifactSha256'
            ).toLowerCase() === expectedLaunchArtifactSha256;
        if (currentLaunchArtifactSha256 !== expectedLaunchArtifactSha256 && !acceptedFindingsCorrection) {
            throw new Error(
                `Reviewer launch artifact hash does not match REVIEWER_INVOCATION_ATTESTED provenance for '${options.reviewType}'.`
            );
        }
        assertReviewExecutionRuntimeBindings(
            launchArtifact,
            reviewExecutionBindings,
            'Reviewer launch artifact'
        );
    }
    assertReviewOutputNotOlderThanDelegation({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightPath: options.preflightPath,
        repoRoot: options.repoRoot,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewOutputSourcePath: options.rawReviewOutputSourcePath ?? options.rawReviewOutputPath ?? null,
        reviewOutputSourceMtimeUtc: options.rawReviewOutputSourceMtimeUtc,
        delegationStartedAtUtc: getDelegationStartedAtUtc(reviewerProvenance)
    });
    const strictFindingsOnlyOutput = reviewContextRequiresFindingsOnlyArtifact(parsedReviewContext);
    const expectedPassVerdict = reviewLaneContract.passVerdict;
    const legacyVerdictToken = strictFindingsOnlyOutput
        ? extractReviewVerdictToken(
            reviewArtifactContent,
            expectedPassVerdict,
            reviewLaneContract.failVerdict,
            options.reviewType
        )
        : null;
    let findingsReport: ReviewFindingsReport | null = null;
    let coverageValidation: ReviewCoverageValidationSummary | null = null;
    let findingsValidationEvidence: ReviewFindingsValidationEvidence | null = null;
    let findingsDispositionEvidence: ReviewFindingsDispositionEvidence | null = null;
    let findingsValidation: JsonReviewFindingsArtifactValidation | null = null;
    if (
        String(reviewArtifactContent || '').trim().startsWith('{')
        || (strictFindingsOnlyOutput && !legacyVerdictToken)
    ) {
        findingsValidation = validateFindingsOnlyReviewOutput({
            reviewContent: reviewArtifactContent,
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewContextSha256: contextSha256,
            reviewTreeStateSha256: dependencies.getReviewTreeStateSha256(parsedReviewContext) || null,
            coverageContract: parsedReviewContext.coverage_contract as ReviewCoverageContract | null | undefined,
            expectedReviewExecutionContract: parsedReviewContext.review_execution as ReviewRemediationReviewContract,
            repoRoot: options.repoRoot,
            evidenceSnapshotCommit: resolveReviewCoverageEvidenceSnapshotCommit(preflight)
        });
        findingsReport = findingsValidation.report;
        coverageValidation = findingsValidation.coverage_validation;
    } else if (strictFindingsOnlyOutput) {
        throw new Error(
            `Current '${options.reviewType}' review receipts require a verdict-free findings JSON report. ` +
            'Legacy PASS/FAIL verdict-token artifacts are readable history only and cannot satisfy a new review cycle.'
        );
    }
    const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflight, options.repoRoot);
    const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint(
        options.reviewType,
        preflight,
        options.repoRoot
    );
    const scopeSha256 = getPreflightScopeSha256(preflight);
    if (findingsValidation) {
        findingsValidationEvidence = buildReviewFindingsValidationEvidence({
            taskId: options.taskId,
            reviewType: options.reviewType,
            validation: findingsValidation,
            reviewOutputSha256: options.rawReviewOutputSha256 || null,
            reviewArtifactPath: options.artifactPath,
            reviewArtifactSha256: artifactSha256,
            reviewContextPath: options.contextPath,
            reviewContextSha256: contextSha256,
            preflightPath: options.preflightPath,
            preflightSha256,
            scopeSha256,
            reviewScopeSha256: reviewScopeFingerprint.review_scope_sha256,
            codeScopeSha256: isNonTestReviewScope(options.reviewType)
                ? codeScopeFingerprint.code_scope_sha256
                : null,
            reviewTreeStateSha256,
            coverageContract: parsedReviewContext.coverage_contract as ReviewCoverageContract | null | undefined
        });
    }
    if (findingsValidation && (!findingsValidation.detected || !findingsValidation.valid || !findingsValidation.report)) {
        if (findingsValidationEvidence) {
            await terminalizeCompletedLaunchAfterFindingsRejection({
                repoRoot: options.repoRoot,
                taskId: options.taskId,
                reviewType: options.reviewType,
                reviewerIdentity: options.reviewerIdentity,
                preflightPath: options.preflightPath,
                reviewContextPath: options.contextPath,
                rawReviewOutputContent: reviewArtifactContent,
                reviewOutputSourcePath: options.rawReviewOutputSourcePath ?? options.rawReviewOutputPath ?? null,
                reviewOutputSourceMtimeUtc: options.rawReviewOutputSourceMtimeUtc,
                validationEvidence: findingsValidationEvidence,
                persistValidationEvidence: () => writeRejectedReviewFindingsValidationEvidence(findingsValidationEvidence)
            });
        }
        const validationMessage = findingsValidation.detected
            ? findingsValidation.violations.join(' ')
            : 'review output must be a JSON object.';
        throw new Error(
            `Verdict-free findings JSON report is invalid for '${options.reviewType}': ` +
            validationMessage
        );
    }
    if (findingsValidationEvidence?.payload.validation_result.accepted) {
        findingsDispositionEvidence = buildReviewFindingsDispositionEvidence({
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewArtifactPath: options.artifactPath,
            validationEvidence: findingsValidationEvidence,
            policyResolution: resolveLockedReviewFindingPolicyFromPreflight(preflight)
        });
    }
    const reviewContextContractBindings = resolveReviewContextReuseContractBindings(parsedReviewContext);
    const receipt = buildReviewReceipt({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256,
        scopeSha256,
        reviewScopeSha256: reviewScopeFingerprint.review_scope_sha256,
        codeScopeSha256: isNonTestReviewScope(options.reviewType)
            ? codeScopeFingerprint.code_scope_sha256
            : null,
        domainScopeFingerprints: buildDomainScopeFingerprints({
            repoRoot: options.repoRoot,
            detectionSource: String(preflight.detection_source || 'git_auto'),
            includeUntracked: preflight.include_untracked !== false,
            changedFiles: Array.isArray(preflight.changed_files) ? preflight.changed_files as string[] : []
        }),
        reviewContextSha256: contextSha256,
        reviewTreeStateSha256,
        reviewExecutionMode: reviewExecutionBindings.review_execution_mode,
        reviewExecutionContractSha256: reviewExecutionBindings.review_execution_contract_sha256,
        reviewExecutionFullScopeSha256: reviewExecutionBindings.review_execution_full_scope_sha256,
        reviewExecutionCompleteScopeLineageSha256:
            reviewExecutionBindings.review_execution_complete_scope_lineage_sha256,
        reviewExecutionFindingReconciliationSha256:
            reviewExecutionBindings.review_execution_finding_reconciliation_sha256,
        reviewContextReuseSha256: computeReviewContextReuseHash(parsedReviewContext),
        reviewCoverageContractSha256: reviewContextContractBindings.coverageContractSha256,
        reviewRuleContextSha256: reviewContextContractBindings.ruleContextSha256,
        reviewArtifactSha256: artifactSha256,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewerFallbackReason: options.reviewerFallbackReason,
        reviewerProvenance,
        trustLevel: REVIEW_EVIDENCE_REQUIRED_TRUST_LEVEL
    });
    Object.assign(receipt, reviewLaneContract.artifactEvidence);
    assertArtifactReviewLaneEvidence(
        receipt as unknown as Record<string, unknown>,
        reviewLaneContract,
        'Review receipt'
    );
    (receipt as unknown as Record<string, unknown>).review_result_recorded_at_utc =
        (receipt as unknown as Record<string, unknown>).recorded_at_utc ?? new Date().toISOString();
    (receipt as unknown as Record<string, unknown>).review_output_path = options.rawReviewOutputPath
        ? normalizePath(options.rawReviewOutputPath)
        : null;
    (receipt as unknown as Record<string, unknown>).review_output_sha256 = options.rawReviewOutputSha256 || null;
    (receipt as unknown as Record<string, unknown>).review_output_source_mtime_utc =
        options.rawReviewOutputSourceMtimeUtc || null;
    (receipt as unknown as Record<string, unknown>).review_materialization_fidelity = options.reviewMaterializationFidelity || 'exact';
    (receipt as unknown as Record<string, unknown>).review_coverage = coverageValidation;
    if (historicalStaleReviewResultReason) {
        (receipt as unknown as Record<string, unknown>).historical_stale_review_result = true;
        (receipt as unknown as Record<string, unknown>).review_result_scope = 'historical_stale_after_remediation';
        (receipt as unknown as Record<string, unknown>).historical_stale_review_reason = historicalStaleReviewResultReason;
    }
    if (findingsReport) {
        const findingsReportSha256 = sha256RedactedJsonPayload(findingsReport);
        const receiptRecord = receipt as unknown as Record<string, unknown>;
        receiptRecord.review_output_format = 'findings_json';
        receiptRecord.review_output_schema_version = findingsReport.schema_version;
        receiptRecord.review_findings_report_sha256 = findingsReportSha256;
        receiptRecord.review_findings_report = findingsReport;
        receiptRecord.review_findings_summary = summarizeReviewFindingsReport(findingsReport);
        if (!findingsDispositionEvidence) {
            throw new Error('Accepted findings JSON receipts require a hash-bound review_findings_disposition artifact.');
        }
        receiptRecord.review_findings_disposition = findingsDispositionEvidence.payload.disposition_result;
        receiptRecord.review_findings_disposition_artifact =
            summarizeReviewFindingsDispositionEvidence(findingsDispositionEvidence);
        if (findingsValidationEvidence) {
            receiptRecord.review_findings_validation = summarizeReviewFindingsValidationEvidence(findingsValidationEvidence);
        }
        receiptRecord.review_output_contract = {
            schema_version: 1,
            format: 'findings_json',
            report_sha256: findingsReportSha256,
            validation_artifact_sha256: findingsValidationEvidence?.artifactSha256 || null,
            validation_result_sha256: findingsValidationEvidence?.payload.validation_result_sha256 || null,
            disposition_artifact_sha256: findingsDispositionEvidence.artifactSha256,
            disposition_result_sha256: findingsDispositionEvidence.payload.disposition_result_sha256,
            raw_output_sha256: options.rawReviewOutputSha256 || null,
            review_artifact_sha256: artifactSha256,
            review_context_sha256: contextSha256,
            review_tree_state_sha256: reviewTreeStateSha256,
            ...reviewExecutionBindings,
            coverage_contract_sha256: findingsReport.coverage_ledger.coverage_contract_sha256,
            reviewer_identity: options.reviewerIdentity,
            reviewer_provenance_event_sha256: reviewerProvenance?.event_sha256 ?? null
        };
    }

    const receiptPayloadSha256 = sha256RedactedJsonPayload(receipt);
    let remediationBaselineEvidence: ReviewRemediationBaselineEvidence | null = null;
    if ((findingsDispositionEvidence?.payload.summary.fix_now_count || 0) > 0) {
        if (
            !findingsValidationEvidence
            || !findingsDispositionEvidence
            || !artifactSha256
            || !reviewTreeStateSha256
            || !Array.isArray(preflight.changed_files)
        ) {
            throw new Error('fix_now review findings require complete remediation baseline evidence.');
        }
        remediationBaselineEvidence = buildReviewRemediationBaselineEvidence({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewTreeStateSha256,
            changedFiles: preflight.changed_files as string[],
            reviewArtifactPath: options.artifactPath,
            reviewArtifactSha256: artifactSha256,
            receipt: receipt as unknown as Record<string, unknown>,
            receiptSha256: receiptPayloadSha256,
            validationEvidence: findingsValidationEvidence,
            dispositionEvidence: findingsDispositionEvidence,
            profilePolicySnapshot: preflight.profile_policy_snapshot,
            originCoverageContract: parsedReviewContext.coverage_contract as ReviewCoverageContract | undefined
        });
    }
    const completedLaunchRestoration = findingsValidationEvidence?.payload.validation_result.accepted
        && options.reviewerExecutionMode === 'delegated_subagent'
        ? restoreCompletedLaunchAfterAcceptedFindingsCorrection({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerIdentity: options.reviewerIdentity,
            invocationEvent,
            timelineEvents
        })
        : null;
    try {
        return await writeReviewReceiptSnapshotsAndTelemetry({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            artifactPath: options.artifactPath,
            artifactContent: options.reviewArtifactContent,
            contextPath: options.contextPath,
            rawReviewOutputPath: options.rawReviewOutputPath,
            rawReviewOutputContent: options.rawReviewOutputContent,
            rawReviewOutputSha256: options.rawReviewOutputSha256,
            receipt: receipt as unknown as Record<string, unknown>,
            receiptPayloadSha256,
            artifactSha256,
            findingsValidationEvidence,
            findingsDispositionEvidence,
            remediationBaselineEvidence,
            correctionAcceptance: options.correctionAcceptance
        });
    } catch (error: unknown) {
        try {
            completedLaunchRestoration?.rollback();
        } catch (rollbackError: unknown) {
            throw new Error(
                `Review receipt persistence failed and launch rollback also failed for '${options.reviewType}': ` +
                `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
                { cause: error }
            );
        }
        throw error;
    }
}

function validateFindingsOnlyReviewOutput(options: {
    reviewContent: string;
    taskId: string;
    reviewType: string;
    reviewContextSha256: string;
    reviewTreeStateSha256: string | null;
    coverageContract: ReviewCoverageContract | null | undefined;
    expectedReviewExecutionContract: ReviewRemediationReviewContract;
    repoRoot: string;
    evidenceSnapshotCommit?: string | null;
}): JsonReviewFindingsArtifactValidation {
    const validation = validateReviewFindingsContract({
        content: options.reviewContent,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewContextSha256: options.reviewContextSha256,
        expectedTreeStateSha256: options.reviewTreeStateSha256,
        coverageContract: options.coverageContract,
        expectedReviewExecutionContract: options.expectedReviewExecutionContract,
        repoRoot: options.repoRoot,
        evidenceSnapshotCommit: options.evidenceSnapshotCommit
    });
    return validation;
}

async function handleRecordReviewResultUnlocked(
    gateArgv: string[],
    dependencies: ReviewResultHandlersDependencies
): Promise<void> {
    const { options: rawOptions } = parseOptions(gateArgv, recordReviewResultOptionDefinitions(), { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = assertCanonicalReviewTypeId(options.reviewType);

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-result', 'review_phase');
    const { preflightPath, artifactPath, contextPath } = dependencies.resolveCanonicalReviewPaths(
        repoRoot,
        taskId,
        reviewType,
        options.preflightPath,
        options.reviewContextPath
    );
    const reviewOutput = await resolveReviewOutputInput(
        options,
        repoRoot,
        path.dirname(preflightPath),
        taskId,
        reviewType,
        dependencies.readReviewOutputFromStdin
    );
    let reviewContent = reviewOutput.reviewContent;
    let reviewMaterializationFidelity = 'exact';
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(preflightPath);
    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    dependencies.assertReviewContextContractOrThrow({
        taskId,
        reviewType,
        contextPath,
        reviewContext: parsedReviewContext,
        preflightPath,
        preflightSha256,
        preflightPayload,
        requireStrictBindingMetadata: !!options.reviewContextPath,
        repoRoot
    });
    const reviewLaneContract = resolveAuthenticatedReviewLaneContract({
        preflight: preflightPayload,
        reviewContext: parsedReviewContext,
        reviewType
    });
    const expectedPassVerdict = reviewLaneContract.passVerdict;
    const expectedFailVerdict = reviewLaneContract.failVerdict;
    const verdictTokenSet = buildReviewVerdictTokenSet(reviewType, expectedPassVerdict, expectedFailVerdict);
    const detectedLegacyVerdictToken = extractReviewVerdictToken(
        reviewContent,
        expectedPassVerdict,
        expectedFailVerdict,
        reviewType
    );
    let verdictToken = detectedLegacyVerdictToken;
    const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = dependencies.parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const reviewContextSha256 = fileSha256(contextPath) || '';
    const strictFindingsOnlyOutput = reviewContextRequiresFindingsOnlyArtifact(parsedReviewContext);
    const correctionArtifactPath = getReviewOutputCorrectionArtifactPath(artifactPath);
    let pendingCorrectionArtifact = null as ReturnType<typeof readReviewOutputCorrectionArtifact>['artifact'];
    let pendingCorrectionProducerAttestation: ReviewOutputCorrectionProducerAttestation | null = null;
    let pendingCorrectionLaunchInputSha256: string | null = null;
    let pendingCorrectionOriginalReviewerAttemptId: string | null = null;
    let pendingCorrectionProducerInvocationEvidence: ReviewOutputCorrectionProducerInvocationEvidence | null = null;
    const correctionResponseOutputSha256 = computeRawReviewOutputSha256(reviewOutput.reviewContent);
    if (fs.existsSync(correctionArtifactPath)) {
        const correctionRead = readReviewOutputCorrectionArtifact(correctionArtifactPath);
        if (!correctionRead.artifact) {
            await emitReviewOutputCorrectionFullReviewRequiredEventAsync(
                gateHelpers.joinOrchestratorPath(repoRoot, ''),
                taskId,
                reviewType,
                {
                    task_id: taskId,
                    review_type: reviewType,
                    reviewer_identity: reviewerIdentity,
                    correction_artifact_path: normalizePath(correctionArtifactPath),
                    reasons: correctionRead.violations
                }
            );
            throw new Error(
                `Review output correction evidence is unavailable or tampered for '${reviewType}'. ` +
                'Restart the review cycle and launch a fresh full reviewer.'
            );
        }
        const correctionArtifact = correctionRead.artifact;
        const timelineEvents = readDependencyTimelineEvents(timelinePath);
        const invocation = [...timelineEvents].reverse().find((event) => {
            const details = event.details || {};
            return event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
                && getArtifactStringField(details, 'review_type', 'reviewType').toLowerCase() === reviewType
                && getArtifactStringField(details, 'reviewer_identity', 'reviewerIdentity') === reviewerIdentity
                && getArtifactStringField(details, 'review_context_sha256', 'reviewContextSha256').toLowerCase() === reviewContextSha256;
        });
        const invocationDetails = invocation?.details || {};
        const reviewerAttemptId = getArtifactStringField(
            invocationDetails,
            'reviewer_launch_attempt_id',
            'reviewerLaunchAttemptId',
            'provider_invocation_id',
            'providerInvocationId'
        ) || String(invocation?.integrity?.event_sha256 || '').trim().toLowerCase();
        const correctionArtifactSha256 = fileSha256(correctionArtifactPath) || '';
        const producerAttestation: ReviewOutputCorrectionProducerAttestation = {
            producer_identity: String(options.correctionProducerIdentity || '').trim(),
            provider_invocation_id: String(options.correctionProviderInvocationId || '').trim(),
            provider_invocation_event_sha256: String(
                options.correctionProviderInvocationEventSha256 || ''
            ).trim().toLowerCase(),
            attestation_source: String(options.correctionAttestationSource || '').trim().toLowerCase(),
            launch_input_sha256: String(options.correctionLaunchInputSha256 || '').trim().toLowerCase(),
            fork_context: typeof options.correctionForkContext === 'boolean'
                ? options.correctionForkContext
                : null
        };
        const expectedProviderResponseEventType =
            correctionArtifact.recovery.selected_transport === 'live_reviewer_continuation'
                ? 'REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION'
                : correctionArtifact.recovery.selected_transport === 'api_conversation_continuation'
                    ? 'REVIEW_OUTPUT_CORRECTION_API_CONTINUATION'
                    : correctionArtifact.recovery.selected_transport === 'correction_only_invocation'
                        ? 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED'
                        : '';
        const expectedProviderResponseReviewerIdentity =
            correctionArtifact.recovery.selected_transport === 'correction_only_invocation'
                ? producerAttestation.producer_identity
                : reviewerIdentity;
        const providerResponseEvent = [...timelineEvents].reverse().find((event) => {
            const details = event.details || {};
            return event.event_type === expectedProviderResponseEventType
                && getArtifactStringField(details, 'review_type', 'reviewType').toLowerCase() === reviewType
                && getArtifactStringField(details, 'reviewer_identity', 'reviewerIdentity')
                    === expectedProviderResponseReviewerIdentity
                && getArtifactStringField(details, 'provider_invocation_id', 'providerInvocationId')
                    === producerAttestation.provider_invocation_id
                && getArtifactStringField(details, 'availability_attestation_source')
                    .toLowerCase() === producerAttestation.attestation_source
                && getArtifactStringField(details, 'correction_artifact_sha256').toLowerCase()
                    === String(correctionArtifact.artifact_sha256 || '').toLowerCase()
                && getArtifactStringField(details, 'correction_package_sha256').toLowerCase()
                    === correctionArtifactSha256.toLowerCase()
                && getArtifactStringField(details, 'availability_provider_response_sha256').toLowerCase()
                    === correctionResponseOutputSha256;
        }) || null;
        const producerInvocation = producerAttestation.provider_invocation_event_sha256
            ? timelineEvents.find((event) => (
                String(event.integrity?.event_sha256 || '').trim().toLowerCase()
                    === producerAttestation.provider_invocation_event_sha256
            ))
            : null;
        const producerInvocationDetails = producerInvocation?.details || {};
        const delegationStartedEventSha256 = getArtifactStringField(
            producerInvocationDetails,
            'correction_delegation_started_event_sha256'
        ).toLowerCase();
        const delegationStartedEvent = delegationStartedEventSha256
            ? timelineEvents.find((event) => (
                String(event.integrity?.event_sha256 || '').trim().toLowerCase()
                    === delegationStartedEventSha256
            ))
            : null;
        const delegationStartedDetails = delegationStartedEvent?.details || {};
        const producerInvocationEvidence: ReviewOutputCorrectionProducerInvocationEvidence | null = producerInvocation
            ? {
                event_type: String(producerInvocation.event_type || '').trim(),
                event_sha256: String(producerInvocation.integrity?.event_sha256 || '').trim().toLowerCase(),
                reviewer_identity: getArtifactStringField(
                    producerInvocationDetails,
                    'reviewer_identity',
                    'reviewerIdentity',
                    'reviewer_session_id',
                    'reviewerSessionId'
                ),
                reviewer_attempt_id: getArtifactStringField(
                    producerInvocationDetails,
                    'reviewer_launch_attempt_id',
                    'reviewerLaunchAttemptId',
                    'provider_invocation_id',
                    'providerInvocationId'
                ) || String(producerInvocation.integrity?.event_sha256 || '').trim().toLowerCase(),
                provider_invocation_id: getArtifactStringField(
                    producerInvocationDetails,
                    'provider_invocation_id',
                    'providerInvocationId',
                    'controller_invocation_id',
                    'controllerInvocationId'
                ),
                attestation_source: getArtifactStringField(
                    producerInvocationDetails,
                    'reviewer_launch_attestation_source',
                    'attestation_source',
                    'attestationSource'
                ).toLowerCase(),
                review_context_sha256: getArtifactStringField(
                    producerInvocationDetails,
                    'review_context_sha256',
                    'reviewContextSha256'
                ).toLowerCase(),
                launch_input_sha256: getArtifactStringField(
                    producerInvocationDetails,
                    'launch_input_sha256',
                    'launchInputSha256'
                ).toLowerCase(),
                delegation_started_event_type: String(delegationStartedEvent?.event_type || '').trim(),
                delegation_started_event_sha256: String(
                    delegationStartedEvent?.integrity?.event_sha256 || ''
                ).trim().toLowerCase(),
                delegation_started_reviewer_identity: getArtifactStringField(
                    delegationStartedDetails,
                    'reviewer_identity',
                    'reviewerIdentity',
                    'reviewer_session_id',
                    'reviewerSessionId'
                ),
                delegation_started_provider_invocation_id: getArtifactStringField(
                    delegationStartedDetails,
                    'provider_invocation_id',
                    'providerInvocationId'
                ),
                correction_launch_artifact_sha256: getArtifactStringField(
                    delegationStartedDetails,
                    'reviewer_launch_artifact_sha256'
                ).toLowerCase(),
                provider_response_event_type: String(providerResponseEvent?.event_type || '').trim(),
                provider_response_event_sha256: String(
                    providerResponseEvent?.integrity?.event_sha256 || ''
                ).trim().toLowerCase(),
                provider_response_sha256: getArtifactStringField(
                    providerResponseEvent?.details || {},
                    'availability_provider_response_sha256'
                ).toLowerCase()
            }
            : null;
        // --reviewer-identity continues to name the original review/receipt
        // owner. A correction-only producer is independently bound through
        // --correction-producer-identity and provider-owned invocation evidence.
        const correctionMatchesOriginalReviewerAttempt =
            correctionArtifact.binding.review_context_sha256 === reviewContextSha256.toLowerCase()
            && correctionArtifact.binding.reviewer_identity === reviewerIdentity
            && correctionArtifact.binding.reviewer_attempt_id === reviewerAttemptId;
        if (correctionMatchesOriginalReviewerAttempt && correctionRead.violations.length > 0) {
            await emitReviewOutputCorrectionFullReviewRequiredEventAsync(
                gateHelpers.joinOrchestratorPath(repoRoot, ''),
                taskId,
                reviewType,
                {
                    task_id: taskId,
                    review_type: reviewType,
                    reviewer_identity: reviewerIdentity,
                    correction_artifact_path: normalizePath(correctionArtifactPath),
                    reasons: correctionRead.violations
                }
            );
            throw new Error(
                `Review output correction evidence is unavailable or tampered for '${reviewType}'. ` +
                'Restart the review cycle and launch a fresh full reviewer.'
            );
        }
        if (correctionMatchesOriginalReviewerAttempt) {
            pendingCorrectionArtifact = correctionArtifact;
            pendingCorrectionProducerAttestation = producerAttestation;
            pendingCorrectionLaunchInputSha256 = correctionArtifactSha256;
            pendingCorrectionOriginalReviewerAttemptId = reviewerAttemptId;
            pendingCorrectionProducerInvocationEvidence = producerInvocationEvidence;
        }
    }
    let findingsReport: ReviewFindingsReport | null = null;
    let findingsDisposition: ReviewFindingsDispositionEvaluation | null = null;
    const rawReviewOutputSha256 = sha256ReviewArtifactContent(reviewOutput.reviewContent);
    const correctionComparisonOutputSha256 = computeRawReviewOutputSha256(reviewOutput.reviewContent);
    const reviewContentLooksLikeFindingsJson = String(reviewContent || '').trim().startsWith('{');
    if (strictFindingsOnlyOutput || (reviewContentLooksLikeFindingsJson && !verdictToken)) {
        let findingsValidation = validateFindingsOnlyReviewOutput({
            reviewContent,
            taskId,
            reviewType,
            reviewContextSha256,
            reviewTreeStateSha256: dependencies.getReviewTreeStateSha256(parsedReviewContext) || null,
            coverageContract: parsedReviewContext.coverage_contract as ReviewCoverageContract | null | undefined,
            expectedReviewExecutionContract: parsedReviewContext.review_execution as ReviewRemediationReviewContract,
            repoRoot,
            evidenceSnapshotCommit: resolveReviewCoverageEvidenceSnapshotCommit(preflightPayload)
        });
        if (!findingsValidation.valid && findingsValidation.detected) {
            const correctionDiagnostics = classifyReviewOutputCorrectionDiagnostics(findingsValidation.violations);
            const reviewExecutionContract = isPlainRecord(parsedReviewContext.review_execution)
                ? parsedReviewContext.review_execution
                : null;
            const delta = reviewExecutionContract && isPlainRecord(reviewExecutionContract.delta)
                ? reviewExecutionContract.delta
                : null;
            const findingReconciliation = reviewExecutionContract
                && isPlainRecord(reviewExecutionContract.finding_reconciliation)
                ? reviewExecutionContract.finding_reconciliation
                : null;
            const normalized = normalizeReviewOutputMechanically({
                content: reviewContent,
                diagnostics: correctionDiagnostics,
                bindings: {
                    taskId,
                    reviewType,
                    reviewContextSha256,
                    reviewTreeStateSha256: dependencies.getReviewTreeStateSha256(parsedReviewContext) || '',
                    coverageContractSha256: isPlainRecord(parsedReviewContext.coverage_contract)
                        ? String(parsedReviewContext.coverage_contract.contract_sha256 || '').trim().toLowerCase()
                        : null,
                    reviewExecution: reviewExecutionContract
                        ? {
                            mode: reviewExecutionContract.mode,
                            contract_sha256: reviewExecutionContract.contract_sha256,
                            covered_delta_targets: Array.isArray(delta?.required_delta_targets)
                                ? delta.required_delta_targets
                                : [],
                            inspected_prior_finding_ids: Array.isArray(findingReconciliation?.resolvable_finding_ids)
                                ? findingReconciliation.resolvable_finding_ids
                                : []
                        }
                        : null
                }
            });
            if (normalized.normalized) {
                const normalizedValidation = validateFindingsOnlyReviewOutput({
                    reviewContent: normalized.content,
                    taskId,
                    reviewType,
                    reviewContextSha256,
                    reviewTreeStateSha256: dependencies.getReviewTreeStateSha256(parsedReviewContext) || null,
                    coverageContract: parsedReviewContext.coverage_contract as ReviewCoverageContract | null | undefined,
                    expectedReviewExecutionContract: parsedReviewContext.review_execution as ReviewRemediationReviewContract,
                    repoRoot,
                    evidenceSnapshotCommit: resolveReviewCoverageEvidenceSnapshotCommit(preflightPayload)
                });
                if (normalizedValidation.valid && normalizedValidation.report) {
                    reviewContent = normalized.content;
                    reviewMaterializationFidelity = 'gate_mechanical_correction';
                    findingsValidation = normalizedValidation;
                    const normalizedEvent = await emitReviewOutputCorrectionNormalizedEventAsync(
                        gateHelpers.joinOrchestratorPath(repoRoot, ''),
                        taskId,
                        reviewType,
                        {
                            task_id: taskId,
                            review_type: reviewType,
                            reviewer_identity: reviewerIdentity,
                            review_context_sha256: reviewContextSha256,
                            review_tree_state_sha256: dependencies.getReviewTreeStateSha256(parsedReviewContext) || null,
                            original_output_sha256: rawReviewOutputSha256,
                            findings_semantic_fingerprint: normalized.fingerprint,
                            corrected_fields: correctionDiagnostics.map((diagnostic) => diagnostic.code)
                        }
                    );
                    if (!normalizedEvent || taskEventAppendHasBlockingFailure(normalizedEvent, false)) {
                        throw new Error(`Gate-owned review output normalization telemetry failed for '${reviewType}'.`);
                    }
                }
            }
        }
        if (!findingsValidation.detected || !findingsValidation.valid || !findingsValidation.report) {
            if (
                pendingCorrectionArtifact
                && pendingCorrectionProducerAttestation
                && pendingCorrectionLaunchInputSha256
                && pendingCorrectionOriginalReviewerAttemptId
                && correctionComparisonOutputSha256 !== pendingCorrectionArtifact.binding.original_output_sha256
            ) {
                const verification = verifyCorrectedReviewOutput({
                    artifact: pendingCorrectionArtifact,
                    correctedOutput: reviewContent,
                    reviewContextSha256,
                    reviewTreeStateSha256: dependencies.getReviewTreeStateSha256(parsedReviewContext) || '',
                    originalReviewerIdentity: reviewerIdentity,
                    originalReviewerAttemptId: pendingCorrectionOriginalReviewerAttemptId,
                    correctionArtifactSha256: pendingCorrectionLaunchInputSha256,
                    producerAttestation: pendingCorrectionProducerAttestation,
                    producerInvocationEvidence: pendingCorrectionProducerInvocationEvidence
                });
                if (pendingCorrectionArtifact.state === 'FULL_REVIEW_REQUIRED' || verification.requires_full_review) {
                    const reasons = pendingCorrectionArtifact.state === 'FULL_REVIEW_REQUIRED'
                        ? [pendingCorrectionArtifact.recovery.reason]
                        : verification.violations;
                    const updated = updateReviewOutputCorrectionState({
                        artifactPath: correctionArtifactPath,
                        artifact: pendingCorrectionArtifact,
                        state: 'FULL_REVIEW_REQUIRED',
                        reason: reasons.join(' ')
                    });
                    await emitReviewOutputCorrectionFullReviewRequiredEventAsync(
                        gateHelpers.joinOrchestratorPath(repoRoot, ''),
                        taskId,
                        reviewType,
                        {
                            task_id: taskId,
                            review_type: reviewType,
                            reviewer_identity: reviewerIdentity,
                            reviewer_attempt_id: pendingCorrectionOriginalReviewerAttemptId,
                            correction_artifact_path: normalizePath(correctionArtifactPath),
                            correction_artifact_sha256: updated.artifact_sha256,
                            correction_package_sha256: fileSha256(correctionArtifactPath),
                            correction_attempt: updated.recovery.correction_attempt,
                            reasons
                        }
                    );
                    throw new Error(
                        `Corrected review output cannot reuse the '${reviewType}' reviewer attempt: ${reasons.join(' ')} ` +
                        'Restart the review cycle and launch a fresh full reviewer.'
                    );
                }
            }
            const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflightPayload, repoRoot);
            const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint(reviewType, preflightPayload, repoRoot);
            const findingsValidationEvidence = buildReviewFindingsValidationEvidence({
                taskId,
                reviewType,
                validation: findingsValidation,
                reviewOutputSha256: rawReviewOutputSha256,
                reviewArtifactPath: artifactPath,
                reviewArtifactSha256: null,
                reviewContextPath: contextPath,
                reviewContextSha256,
                preflightPath,
                preflightSha256,
                scopeSha256: getPreflightScopeSha256(preflightPayload),
                reviewScopeSha256: reviewScopeFingerprint.review_scope_sha256,
                codeScopeSha256: isNonTestReviewScope(reviewType)
                    ? codeScopeFingerprint.code_scope_sha256
                    : null,
                reviewTreeStateSha256: dependencies.getReviewTreeStateSha256(parsedReviewContext) || null,
                coverageContract: parsedReviewContext.coverage_contract as ReviewCoverageContract | null | undefined
            });
            if (
                pendingCorrectionArtifact
                && pendingCorrectionProducerAttestation
                && pendingCorrectionLaunchInputSha256
                && pendingCorrectionOriginalReviewerAttemptId
                && correctionComparisonOutputSha256 !== pendingCorrectionArtifact.binding.original_output_sha256
            ) {
                await persistReviewOutputCorrectionRequired({
                    repoRoot,
                    taskId,
                    reviewType,
                    reviewerIdentity,
                    reviewContextPath: contextPath,
                    rawReviewOutputContent: reviewOutput.reviewContent,
                    reviewOutputSourcePath: reviewOutput.reviewOutputSourcePath,
                    validationEvidence: findingsValidationEvidence,
                    persistValidationEvidence: () => writeRejectedReviewFindingsValidationEvidence(
                        findingsValidationEvidence
                    )
                });
            } else {
                await terminalizeCompletedLaunchAfterFindingsRejection({
                    repoRoot,
                    taskId,
                    reviewType,
                    reviewerIdentity,
                    preflightPath,
                    reviewContextPath: contextPath,
                    rawReviewOutputContent: reviewOutput.reviewContent,
                    reviewOutputSourcePath: reviewOutput.reviewOutputSourcePath,
                    reviewOutputSourceMtimeUtc: reviewOutput.reviewOutputSourceMtimeUtc,
                    validationEvidence: findingsValidationEvidence,
                    persistValidationEvidence: () => writeRejectedReviewFindingsValidationEvidence(
                        findingsValidationEvidence
                    )
                });
            }
            if (!verdictToken) {
                const validationMessage = findingsValidation.detected
                    ? findingsValidation.violations.join(' ')
                    : 'review output must be a JSON object.';
                throw new Error(
                    `Verdict-free findings JSON report is invalid for '${reviewType}': ` +
                    validationMessage
                );
            }
        } else {
            findingsReport = findingsValidation.report;
            if (findingsReport) {
                findingsDisposition = evaluateReviewFindingsReportDispositionsFromPreflight(findingsReport, preflightPayload);
                verdictToken = findingsDisposition.blocking_count > 0 ? expectedFailVerdict : expectedPassVerdict;
            }
        }
    }
    if (
        pendingCorrectionArtifact
        && pendingCorrectionProducerAttestation
        && pendingCorrectionLaunchInputSha256
        && pendingCorrectionOriginalReviewerAttemptId
    ) {
        const verification = verifyCorrectedReviewOutput({
            artifact: pendingCorrectionArtifact,
            correctedOutput: reviewContent,
            reviewContextSha256,
            reviewTreeStateSha256: dependencies.getReviewTreeStateSha256(parsedReviewContext) || '',
            originalReviewerIdentity: reviewerIdentity,
            originalReviewerAttemptId: pendingCorrectionOriginalReviewerAttemptId,
            correctionArtifactSha256: pendingCorrectionLaunchInputSha256,
            producerAttestation: pendingCorrectionProducerAttestation,
            producerInvocationEvidence: pendingCorrectionProducerInvocationEvidence
        });
        if (pendingCorrectionArtifact.state === 'FULL_REVIEW_REQUIRED' || verification.requires_full_review) {
            const reasons = pendingCorrectionArtifact.state === 'FULL_REVIEW_REQUIRED'
                ? [pendingCorrectionArtifact.recovery.reason]
                : verification.violations;
            const updated = updateReviewOutputCorrectionState({
                artifactPath: correctionArtifactPath,
                artifact: pendingCorrectionArtifact,
                state: 'FULL_REVIEW_REQUIRED',
                reason: reasons.join(' ')
            });
            await emitReviewOutputCorrectionFullReviewRequiredEventAsync(
                gateHelpers.joinOrchestratorPath(repoRoot, ''),
                taskId,
                reviewType,
                {
                    task_id: taskId,
                    review_type: reviewType,
                    reviewer_identity: reviewerIdentity,
                    reviewer_attempt_id: pendingCorrectionOriginalReviewerAttemptId,
                    correction_artifact_path: normalizePath(correctionArtifactPath),
                    correction_artifact_sha256: updated.artifact_sha256,
                    correction_package_sha256: fileSha256(correctionArtifactPath),
                    reasons
                }
            );
            throw new Error(
                `Corrected review output cannot reuse the '${reviewType}' reviewer attempt: ${reasons.join(' ')} ` +
                'Restart the review cycle and launch a fresh full reviewer.'
            );
        }
    }
    if (!verdictToken) {
        const passExample = verdictTokenSet.canonicalPassToken || expectedPassVerdict;
        const failExample = verdictTokenSet.canonicalFailToken || expectedFailVerdict;
        const expectedOutputMessage = strictFindingsOnlyOutput
            ? (
                `Review output must contain a valid verdict-free findings JSON report for '${reviewType}'. ` +
                `Legacy PASS/FAIL verdict tokens are readable history only for current generated review contexts. `
            )
            : `Review output must contain a recognized verdict token for '${reviewType}' or a valid verdict-free findings JSON report. `;
        throw new Error(
            expectedOutputMessage +
            formatAcceptedReviewVerdictTokens(verdictTokenSet) +
            (strictFindingsOnlyOutput
                ? ` Legacy examples: '${passExample}' / '${failExample}'. Do not pass '--verdict pass' or similar flags; write the findings JSON object to the review output file.\n\n`
                : ` The token must appear as a standalone line inside the reviewer output file (--review-output-path), not as a CLI flag. Example PASS line: '${passExample}'. Example FAIL line: '${failExample}'. Do not pass '--verdict pass' or similar flags; place the token on its own line under a '## Verdict' heading in the review output file.\n\n`) +
            dependencies.buildMinimalPassReviewTemplateHint(reviewType, passExample) +
            `\n\n${buildSafeReviewOutputRetryInstruction(taskId, reviewType)}`
        );
    }
    const failedReviewVerdict = isFailedReviewVerdictToken(verdictToken, expectedFailVerdict);
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const runtimeIdentity = dependencies.assertExplicitReviewContextRuntimeIdentity({
        repoRoot,
        taskId,
        reviewType,
        contextPath,
        reviewerRouting: currentRouting,
        taskModePath: String(options.taskModePath || '').trim()
    });
    if (!runtimeIdentity.task_mode_identity_backfilled) {
        dependencies.assertReviewContextRuntimeIdentityMetadataPresent({
            reviewType,
            contextPath,
            reviewContext: parsedReviewContext,
            reviewerRouting: currentRouting
        });
    }
    if (reviewType === 'test') {
        assertRequiredUpstreamReviewDependencies({
            taskId,
            preflightPath,
            preflightPayload,
            reviewType,
            timelineEvents: readDependencyTimelineEvents(timelinePath),
            taskModePath: String(options.taskModePath || '').trim()
        });
    }
    let historicalStaleReviewResultReason: string | null = null;
    if (parsedReviewContext.tree_state != null) {
        historicalStaleReviewResultReason = assertReviewTreeStateFreshOrHistoricalFailure({
            repoRoot,
            reviewContext: parsedReviewContext,
            contextPath,
            gateName: 'record-review-result',
            allowHistoricalFailedReviewResult: failedReviewVerdict
        });
    }

    if (!findingsReport) {
        let materializedReview: ReturnType<typeof materializeReviewContent>;
        try {
            materializedReview = materializeReviewContent({
                artifactPath,
                reviewType,
                reviewContent,
                verdictToken,
                expectedPassVerdict,
                requirePassValidationNotes: dependencies.reviewContextRequiresPassValidationNotes(contextPath, repoRoot),
                analyze: dependencies.analyzeEarlyReviewMaterialization,
                normalizeHeadings: dependencies.normalizeReviewSectionHeadings,
                buildLosslessPassReviewNormalization: dependencies.buildLosslessPassReviewNormalization,
                isLosslessPassNormalizationEligibleViolation: dependencies.isLosslessPassNormalizationEligibleViolation,
                buildPassReviewTemplateHintMessage: dependencies.buildPassReviewTemplateHintMessage
            });
        } catch (error: unknown) {
            throw appendSafeReviewOutputRetryInstruction(error, taskId, reviewType);
        }
        reviewContent = materializedReview.reviewContent;
        reviewMaterializationFidelity = materializedReview.reviewMaterializationFidelity;
    }
    if (reviewType !== 'test') {
        assertRequiredUpstreamReviewDependencies({
            taskId,
            preflightPath,
            preflightPayload,
            reviewType,
            timelineEvents: readDependencyTimelineEvents(timelinePath),
            taskModePath: String(options.taskModePath || '').trim()
        });
    }
    historicalStaleReviewResultReason = historicalStaleReviewResultReason || assertReviewTreeStateFreshOrHistoricalFailure({
        repoRoot,
        reviewContext: parsedReviewContext,
        contextPath,
        gateName: 'record-review-result',
        allowHistoricalFailedReviewResult: failedReviewVerdict
    });
    resolveReviewerPromptArtifactBinding({
        repoRoot,
        contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'record-review-result'
    });
    dependencies.assertRoutingCompatibility({
        reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode,
        reviewerFallbackReason
    });

    const acceptedRawReviewContent = reviewOutput.reviewContent;
    const acceptedReviewArtifactContent = reviewContent.endsWith('\n') ? reviewContent : `${reviewContent}\n`;
    const invocationReviewContextSha256 = fileSha256(contextPath) || '';
    const preApplyReviewerSessionId = currentRouting?.reviewer_session_id != null
        ? String(currentRouting.reviewer_session_id).trim()
        : '';
    const routingReviewerIdentityForLookup = isPlannedReviewerIdentity(preApplyReviewerSessionId)
        ? preApplyReviewerSessionId
        : reviewerIdentity;
    const contextSha256 = invocationReviewContextSha256 || fileSha256(contextPath) || '';
    const correctionAcceptance = pendingCorrectionArtifact
        && pendingCorrectionProducerAttestation
        && pendingCorrectionLaunchInputSha256
        ? (() => {
            const acceptanceReason =
                'Attested corrected output preserved the bound reviewer attempt and findings semantic fingerprint.';
            const providerContinuation = [
                'live_reviewer_continuation',
                'api_conversation_continuation'
            ].includes(pendingCorrectionArtifact.recovery.selected_transport);
            const liveContinuation = pendingCorrectionArtifact.recovery.selected_transport
                === 'live_reviewer_continuation';
            const acceptedCorrection = liveContinuation
                ? buildReviewOutputCorrectionLiveContinuationAcceptance({
                    artifactPath: correctionArtifactPath,
                    artifact: pendingCorrectionArtifact,
                    reviewerIdentity,
                    providerInvocationId: pendingCorrectionProducerAttestation.provider_invocation_id,
                    providerInvocationEventSha256:
                        pendingCorrectionProducerAttestation.provider_invocation_event_sha256,
                    providerResponseEventSha256:
                        pendingCorrectionProducerInvocationEvidence?.provider_response_event_sha256 || '',
                    providerResponseSha256: rawReviewOutputSha256,
                    attestationSource: pendingCorrectionProducerAttestation.attestation_source,
                    reason: acceptanceReason
                })
                : pendingCorrectionArtifact.recovery.selected_transport === 'api_conversation_continuation'
                    ? buildReviewOutputCorrectionApiContinuationAcceptance({
                        artifactPath: correctionArtifactPath,
                        artifact: pendingCorrectionArtifact,
                        reviewerIdentity,
                        providerInvocationId:
                            pendingCorrectionProducerAttestation.provider_invocation_id,
                        providerInvocationEventSha256:
                            pendingCorrectionProducerAttestation.provider_invocation_event_sha256,
                        providerResponseEventSha256:
                            pendingCorrectionProducerInvocationEvidence?.provider_response_event_sha256 || '',
                        providerResponseSha256: rawReviewOutputSha256,
                        attestationSource: pendingCorrectionProducerAttestation.attestation_source,
                        reason: acceptanceReason
                    })
                    : buildReviewOutputCorrectionCorrectionOnlyAcceptance({
                        artifactPath: correctionArtifactPath,
                        artifact: pendingCorrectionArtifact,
                        reviewerIdentity: pendingCorrectionProducerAttestation.producer_identity,
                        providerInvocationId:
                            pendingCorrectionProducerAttestation.provider_invocation_id,
                        providerInvocationEventSha256:
                            pendingCorrectionProducerAttestation.provider_invocation_event_sha256,
                        providerResponseEventSha256:
                            pendingCorrectionProducerInvocationEvidence?.provider_response_event_sha256 || '',
                        providerResponseSha256: rawReviewOutputSha256,
                        attestationSource: pendingCorrectionProducerAttestation.attestation_source,
                        reason: acceptanceReason
                    });
            const transportBinding = acceptedCorrection.transport_binding;
            const transportAttestation = transportBinding?.availability_attestation;
            const providerResponseAttestation = acceptedCorrection.producer_response_attestation;
            return {
                artifactPath: correctionArtifactPath,
                artifact: acceptedCorrection,
                ...(providerContinuation || providerResponseAttestation
                    ? {
                        providerResponseEventSha256:
                            transportAttestation?.provider_response_event_sha256
                            || providerResponseAttestation?.provider_response_event_sha256
                            || ''
                    }
                    : {}),
                invocationEventDetails: {
                    task_id: taskId,
                    review_type: reviewType,
                    original_reviewer_identity: reviewerIdentity,
                    correction_producer_identity: pendingCorrectionProducerAttestation.producer_identity,
                    provider_invocation_id: pendingCorrectionProducerAttestation.provider_invocation_id,
                    attestation_source: pendingCorrectionProducerAttestation.attestation_source,
                    launch_input_mode: 'review_output_correction_artifact_path',
                    launch_input_sha256: pendingCorrectionLaunchInputSha256,
                    fork_context: pendingCorrectionProducerAttestation.fork_context,
                    corrected_output_sha256: rawReviewOutputSha256,
                    provider_response_event_sha256:
                        transportAttestation?.provider_response_event_sha256
                        || providerResponseAttestation?.provider_response_event_sha256
                        || null,
                    selected_transport: pendingCorrectionArtifact.recovery.selected_transport,
                    correction_package_sha256: pendingCorrectionLaunchInputSha256,
                    provider_id: pendingCorrectionArtifact.transport_binding?.provider_id || null,
                    provider_capabilities_sha256:
                        pendingCorrectionArtifact.transport_binding?.provider_capabilities_sha256 || null,
                    session_availability:
                        acceptedCorrection.transport_binding?.session_availability || null
                },
                acceptedEventDetails: {
                    task_id: taskId,
                    review_type: reviewType,
                    reviewer_identity: reviewerIdentity,
                    reviewer_attempt_id: acceptedCorrection.binding.reviewer_attempt_id,
                    correction_producer_identity: pendingCorrectionProducerAttestation.producer_identity,
                    provider_invocation_id: pendingCorrectionProducerAttestation.provider_invocation_id,
                    attestation_source: pendingCorrectionProducerAttestation.attestation_source,
                    correction_artifact_path: normalizePath(correctionArtifactPath),
                    correction_artifact_sha256: acceptedCorrection.artifact_sha256,
                    original_output_sha256: acceptedCorrection.binding.original_output_sha256,
                    corrected_output_sha256: rawReviewOutputSha256,
                    provider_response_event_sha256:
                        transportAttestation?.provider_response_event_sha256
                        || providerResponseAttestation?.provider_response_event_sha256
                        || null,
                    findings_semantic_fingerprint: acceptedCorrection.binding.findings_semantic_fingerprint,
                    selected_transport: acceptedCorrection.recovery.selected_transport,
                    correction_package_sha256: pendingCorrectionLaunchInputSha256,
                    provider_id: acceptedCorrection.transport_binding?.provider_id || null,
                    provider_capabilities_sha256:
                        acceptedCorrection.transport_binding?.provider_capabilities_sha256 || null,
                    session_availability:
                        acceptedCorrection.transport_binding?.session_availability || null
                }
            } satisfies ReviewOutputCorrectionAcceptanceTransaction;
        })()
        : null;

    const receiptPath = await recordReviewReceiptFromArtifacts({
        repoRoot,
        taskId,
        reviewType,
        preflightPath,
        artifactPath,
        reviewArtifactContent: acceptedReviewArtifactContent,
        contextPath,
        rawReviewOutputPath: reviewOutput.reviewOutputPath,
        rawReviewOutputSourcePath: reviewOutput.reviewOutputSourcePath,
        rawReviewOutputContent: acceptedRawReviewContent,
        rawReviewOutputSha256,
        rawReviewOutputSourceMtimeUtc: reviewOutput.reviewOutputSourceMtimeUtc,
        reviewMaterializationFidelity,
        historicalStaleReviewResultReason,
        taskModePath: String(options.taskModePath || '').trim(),
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        requireStrictBindingMetadata: !!options.reviewContextPath,
        invocationReviewContextSha256,
        routingReviewerIdentity: routingReviewerIdentityForLookup,
        correctionAcceptance
    }, dependencies);
    cleanupReviewTempSourceArtifact(repoRoot, taskId, reviewOutput.reviewOutputSourcePath);

    console.log(`REVIEW_RESULT_RECORDED: ${reviewType}`);
    console.log(`ArtifactPath: ${normalizePath(artifactPath)}`);
    console.log(`ContextPath: ${normalizePath(contextPath)}`);
    console.log(`ReceiptPath: ${normalizePath(receiptPath)}`);
    console.log(`ReviewerExecutionMode: ${reviewerExecutionMode}`);
    console.log(`ReviewerIdentity: ${reviewerIdentity}`);
    console.log(`ReviewOutputMode: ${reviewOutput.reviewOutputMode}`);
    console.log(`ReviewOutputPath: ${normalizePath(reviewOutput.reviewOutputPath)}`);
    console.log(`ReviewOutputSha256: ${rawReviewOutputSha256 || 'n/a'}`);
    console.log(`ReviewMaterializationFidelity: ${reviewMaterializationFidelity}`);
    if (historicalStaleReviewResultReason) {
        console.log('HistoricalStaleReviewResult: true');
        console.log(`HistoricalStaleReviewReason: ${historicalStaleReviewResultReason}`);
    }
    if (reviewOutput.reviewOutputSourcePath) {
        console.log(`ReviewOutputSourcePath: ${normalizePath(reviewOutput.reviewOutputSourcePath)}`);
    }
    console.log(`ContextSha256: ${contextSha256 || 'n/a'}`);
    if (reviewerFallbackReason) {
        console.log(`ReviewerFallbackReason: ${reviewerFallbackReason}`);
    }
    console.log(`VerdictToken: ${verdictToken}`);
    if (findingsDisposition) {
        console.log(`ReviewFindingsDisposition: ${findingsDisposition.verdict}`);
        console.log(`ReviewFindingsBlockingCount: ${findingsDisposition.blocking_count}`);
    }
    console.log(`ReviewerCleanup: ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}`);
}

async function handleRecordReviewReceiptUnlocked(
    gateArgv: string[],
    dependencies: ReviewResultHandlersDependencies
): Promise<void> {
    const { options: rawOptions } = parseOptions(gateArgv, recordReviewReceiptOptionDefinitions(), { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = assertCanonicalReviewTypeId(options.reviewType);

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-receipt', 'review_phase');
    const { preflightPath, artifactPath, contextPath } = dependencies.resolveCanonicalReviewPaths(
        repoRoot,
        taskId,
        reviewType,
        options.preflightPath,
        options.reviewContextPath
    );
    const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = dependencies.parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    assertRequiredUpstreamReviewDependencies({
        taskId,
        preflightPath,
        preflightPayload,
        reviewType,
        timelineEvents: readDependencyTimelineEvents(timelinePath),
        taskModePath: String(options.taskModePath || '').trim()
    });
    const receiptPath = await recordReviewReceiptFromArtifacts({
        repoRoot,
        taskId,
        reviewType,
        preflightPath,
        artifactPath,
        contextPath,
        rawReviewOutputPath: artifactPath,
        rawReviewOutputSha256: fileSha256(artifactPath),
        rawReviewOutputSourceMtimeUtc: fs.statSync(artifactPath).mtime.toISOString(),
        taskModePath: String(options.taskModePath || '').trim(),
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        requireStrictBindingMetadata: !!options.reviewContextPath
    }, dependencies);
    console.log(`REVIEW_RECORDED: ${reviewType} (Receipt: ${normalizePath(receiptPath)})`);
    console.log(`ReviewerCleanup: ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}`);
}

async function handleRecordReviewReceiptWithDependencies(
    gateArgv: string[],
    dependencies: ReviewResultHandlersDependencies
): Promise<void> {
    const { options: rawOptions } = parseOptions(gateArgv, recordReviewReceiptOptionDefinitions(), {
        allowPositionals: false
    });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = assertCanonicalReviewTypeId(options.reviewType);
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    const launchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
        repoRoot,
        taskId,
        reviewType,
        artifactPathValue: undefined
    });
    const resultLockPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'tmp', 'reviews', taskId, reviewType, '.record-review-result.lock')
    );
    await withReviewerLaunchLaneTransaction(launchArtifactPath, async () => {
        const { handle } = await acquireFilesystemLockAsync(resultLockPath, {
            ownerLabel: `record-review-result:${taskId}:${reviewType}`
        });
        try {
            await handleRecordReviewReceiptUnlocked(gateArgv, dependencies);
        } finally {
            releaseFilesystemLock(handle);
        }
    });
}

function getReviewOutputCorrectionTransportLockPath(
    repoRoot: string,
    taskId: string,
    reviewType: string
): string {
    return gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join(
            'runtime',
            'tmp',
            'reviews',
            taskId,
            reviewType,
            '.record-review-output-correction-transport.lock'
        )
    );
}

async function handleRecordReviewResultWithDependencies(
    gateArgv: string[],
    dependencies: ReviewResultHandlersDependencies
): Promise<void> {
    const { options: rawOptions } = parseOptions(gateArgv, recordReviewResultOptionDefinitions(), {
        allowPositionals: false
    });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = assertCanonicalReviewTypeId(options.reviewType);
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    const launchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
        repoRoot,
        taskId,
        reviewType,
        artifactPathValue: undefined
    });
    const resultLockPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'tmp', 'reviews', taskId, reviewType, '.record-review-result.lock')
    );
    const correctionTransportLockPath = getReviewOutputCorrectionTransportLockPath(
        repoRoot,
        taskId,
        reviewType
    );
    await withReviewerLaunchLaneTransaction(launchArtifactPath, async () => {
        const { handle: correctionTransportHandle } = await acquireFilesystemLockAsync(
            correctionTransportLockPath,
            {
                ownerLabel: `review-output-correction-transport:${taskId}:${reviewType}`
            }
        );
        try {
            const { handle } = await acquireFilesystemLockAsync(resultLockPath, {
                ownerLabel: `record-review-result:${taskId}:${reviewType}`
            });
            try {
                await handleRecordReviewResultUnlocked(gateArgv, dependencies);
            } finally {
                releaseFilesystemLock(handle);
            }
        } finally {
            releaseFilesystemLock(correctionTransportHandle);
        }
    });
}

async function handleRecordReviewOutputCorrectionTransportUnlocked(gateArgv: string[]): Promise<void> {
    const { options: rawOptions } = parseOptions(
        gateArgv,
        recordReviewOutputCorrectionTransportOptionDefinitions(),
        { allowPositionals: false }
    );
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = assertCanonicalReviewTypeId(options.reviewType);
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-output-correction-transport', 'review_phase');
    const canonicalReviewArtifactPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-${reviewType}.md`)
    );
    const canonicalCorrectionArtifactPath = getReviewOutputCorrectionArtifactPath(canonicalReviewArtifactPath);
    const suppliedCorrectionArtifactPath = path.resolve(
        repoRoot,
        String(options.correctionArtifactPath || '').trim()
    );
    if (
        normalizePath(suppliedCorrectionArtifactPath).toLowerCase()
        !== normalizePath(canonicalCorrectionArtifactPath).toLowerCase()
    ) {
        throw new Error(
            `Correction transport selection requires canonical artifact '${normalizePath(canonicalCorrectionArtifactPath)}'.`
        );
    }
    const correctionRead = readReviewOutputCorrectionArtifact(canonicalCorrectionArtifactPath);
    if (correctionRead.violations.length > 0 || !correctionRead.artifact) {
        throw new Error(
            `Correction transport selection requires intact correction evidence: ${correctionRead.violations.join(' ')}`
        );
    }
    const correctionArtifact = correctionRead.artifact;
    const sessionAvailability = String(options.sessionAvailability || '').trim().toLowerCase();
    if (!['closed', 'stateless'].includes(sessionAvailability)) {
        throw new Error(
            "Correction transport selection requires fail-closed --session-availability 'closed' or 'stateless'. " +
            'Live continuation is frozen only with an authenticated corrected response in record-review-result.'
        );
    }
    const reviewerIdentity = String(options.reviewerIdentity || '').trim();
    const providerInvocationId = String(options.providerInvocationId || '').trim();
    const suppliedAttestationSource = String(options.attestationSource || '').trim().toLowerCase();
    const attestationSource = suppliedAttestationSource
        || REVIEW_OUTPUT_CORRECTION_FAIL_CLOSED_ATTESTATION_SOURCE;
    const timelinePath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'task-events', `${taskId}.jsonl`)
    );
    const existingEvents = readDependencyTimelineEvents(timelinePath);
    const transportEventTypes = new Set([
        'REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION',
        'REVIEW_OUTPUT_CORRECTION_API_CONTINUATION',
        'REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION',
        'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED'
    ]);
    const emitPersistedTransportSelection = async (selection: {
        artifact: ReviewOutputCorrectionArtifact;
        artifactPath: string;
        previousArtifactFileSha256: string;
        artifactFileSha256: string;
    }): Promise<void> => {
        const binding = selection.artifact.transport_binding;
        const details = {
            task_id: taskId,
            review_type: reviewType,
            reviewer_identity: reviewerIdentity,
            reviewer_attempt_id: selection.artifact.binding.reviewer_attempt_id,
            reviewer_invocation_event_sha256:
                selection.artifact.binding.reviewer_invocation_event_sha256,
            provider_id: binding?.provider_id || null,
            provider_invocation_id: providerInvocationId,
            provider_capabilities: binding?.provider_capabilities || null,
            provider_capabilities_sha256: binding?.provider_capabilities_sha256 || null,
            session_availability: binding?.session_availability || null,
            availability_attestation_source: binding?.availability_attestation?.attestation_source || null,
            availability_evidence_type: binding?.availability_attestation?.evidence_type || null,
            availability_provider_invocation_event_sha256:
                binding?.availability_attestation?.provider_invocation_event_sha256 || null,
            availability_provider_response_sha256:
                binding?.availability_attestation?.provider_response_sha256 || null,
            selected_transport: selection.artifact.recovery.selected_transport,
            correction_attempt: selection.artifact.recovery.correction_attempt,
            previous_correction_package_sha256: selection.previousArtifactFileSha256,
            correction_package_sha256: selection.artifactFileSha256,
            correction_artifact_path: normalizePath(selection.artifactPath),
            correction_artifact_sha256: selection.artifact.artifact_sha256
        };
        const selectedTransport = selection.artifact.recovery.selected_transport;
        if (
            selectedTransport !== 'full_reviewer_relaunch'
            && selectedTransport !== 'live_reviewer_continuation'
            && selectedTransport !== 'api_conversation_continuation'
            && selectedTransport !== 'correction_only_invocation'
        ) {
            throw new Error(`Correction transport selection produced unsupported transport '${selectedTransport}'.`);
        }
        const event = selectedTransport === 'full_reviewer_relaunch'
            ? await emitReviewOutputCorrectionFullReviewRequiredEventAsync(
                gateHelpers.joinOrchestratorPath(repoRoot, ''),
                taskId,
                reviewType,
                details
            )
            : await emitReviewOutputCorrectionTransportEventAsync(
                gateHelpers.joinOrchestratorPath(repoRoot, ''),
                taskId,
                reviewType,
                selectedTransport,
                details
            );
        if (!event || taskEventAppendHasBlockingFailure(event, false)) {
            throw new Error(`Correction transport telemetry failed for '${reviewType}'.`);
        }
    };
    if (correctionArtifact.transport_binding?.session_availability !== 'pending') {
        const attestation = correctionArtifact.transport_binding?.availability_attestation;
        const existingEvent = [...existingEvents].reverse().find((event) => {
            const details = event.details || {};
            return transportEventTypes.has(event.event_type)
                && getArtifactStringField(details, 'correction_artifact_sha256')
                    === String(correctionArtifact.artifact_sha256 || '').toLowerCase();
        });
        const attestationMatches = (
            correctionArtifact.transport_binding?.session_availability === sessionAvailability
            && attestation?.reviewer_identity === reviewerIdentity
            && attestation.provider_invocation_id === providerInvocationId
            && attestation.attestation_source === attestationSource.toLowerCase()
        );
        if (
            attestationMatches
            && existingEvent
        ) {
            console.log(`REVIEW_OUTPUT_CORRECTION_TRANSPORT_ALREADY_RECORDED: ${reviewType}`);
            console.log(`SelectedTransport: ${correctionArtifact.recovery.selected_transport}`);
            console.log(`NextStep: node bin/garda.js next-step "${taskId}" --repo-root "."`);
            return;
        }
        if (attestationMatches) {
            const predecessorEvent = [...existingEvents].reverse().find((event) => {
                const details = event.details || {};
                return event.event_type === 'REVIEW_OUTPUT_CORRECTION_REQUIRED'
                    && getArtifactStringField(details, 'review_type', 'reviewType').toLowerCase() === reviewType
                    && Number(details.correction_attempt) === correctionArtifact.recovery.correction_attempt
                    && getArtifactStringField(details, 'reviewer_identity', 'reviewerIdentity')
                        === reviewerIdentity
                    && getArtifactStringField(details, 'provider_invocation_id', 'providerInvocationId')
                        === providerInvocationId
                    && getArtifactStringField(details, 'reviewer_invocation_event_sha256')
                        === correctionArtifact.binding.reviewer_invocation_event_sha256;
            });
            const previousArtifactFileSha256 = getArtifactStringField(
                predecessorEvent?.details || {},
                'correction_package_sha256'
            ).toLowerCase();
            const artifactFileSha256 = String(
                fileSha256(canonicalCorrectionArtifactPath) || ''
            ).toLowerCase();
            const predecessorAlreadyConsumed = existingEvents.some((event) => (
                transportEventTypes.has(event.event_type)
                && getArtifactStringField(event.details || {}, 'previous_correction_package_sha256')
                    === previousArtifactFileSha256
            ));
            if (
                predecessorEvent
                && /^[0-9a-f]{64}$/u.test(previousArtifactFileSha256)
                && /^[0-9a-f]{64}$/u.test(artifactFileSha256)
                && !predecessorAlreadyConsumed
            ) {
                await emitPersistedTransportSelection({
                    artifact: correctionArtifact,
                    artifactPath: canonicalCorrectionArtifactPath,
                    previousArtifactFileSha256,
                    artifactFileSha256
                });
                console.log(`REVIEW_OUTPUT_CORRECTION_TRANSPORT_RECOVERED: ${reviewType}`);
                console.log(`SelectedTransport: ${correctionArtifact.recovery.selected_transport}`);
                console.log(`NextStep: node bin/garda.js next-step "${taskId}" --repo-root "."`);
                return;
            }
        }
        throw new Error('Correction transport availability is already frozen and cannot be redefined.');
    }
    const correctionArtifactSnapshot = captureReviewArtifactFile(
        repoRoot,
        canonicalCorrectionArtifactPath
    );
    const correctionLaunchArtifactPath = getReviewOutputCorrectionLaunchArtifactPath(
        canonicalReviewArtifactPath
    );
    const correctionLaunchArtifactSnapshot = captureReviewArtifactFile(
        repoRoot,
        correctionLaunchArtifactPath
    );
    let persisted: ReturnType<typeof persistReviewOutputCorrectionTransportSelection> | null = null;
    try {
        persisted = persistReviewOutputCorrectionTransportSelection({
            repoRoot,
            artifactPath: canonicalCorrectionArtifactPath,
            artifact: correctionArtifact,
            sessionAvailability: sessionAvailability as Extract<
                ReviewOutputCorrectionSessionAvailability,
                'closed' | 'stateless'
            >,
            reviewerIdentity,
            providerInvocationId,
            attestationSource
        });
        await emitPersistedTransportSelection(persisted);
        console.log(`REVIEW_OUTPUT_CORRECTION_TRANSPORT_RECORDED: ${reviewType}`);
        console.log(`SessionAvailability: ${sessionAvailability}`);
        console.log(`SelectedTransport: ${persisted.artifact.recovery.selected_transport}`);
        console.log(`NextStep: node bin/garda.js next-step "${taskId}" --repo-root "."`);
    } catch (error) {
        if (!correctionTransportEventMatchesPersistedSelection({
            timelinePath,
            reviewType,
            selection: persisted
        })) {
            restoreReviewArtifactFile(repoRoot, correctionLaunchArtifactSnapshot);
            restoreReviewArtifactFile(repoRoot, correctionArtifactSnapshot);
        }
        throw error;
    }
}

async function handleRecordReviewOutputCorrectionTransport(gateArgv: string[]): Promise<void> {
    const { options: rawOptions } = parseOptions(
        gateArgv,
        recordReviewOutputCorrectionTransportOptionDefinitions(),
        { allowPositionals: false }
    );
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = assertCanonicalReviewTypeId(options.reviewType);
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    const canonicalReviewArtifactPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-${reviewType}.md`)
    );
    const correctionLaunchArtifactPath = getReviewOutputCorrectionLaunchArtifactPath(
        canonicalReviewArtifactPath
    );
    const selectionLockPath = getReviewOutputCorrectionTransportLockPath(
        repoRoot,
        taskId,
        reviewType
    );
    await withReviewerLaunchLaneTransaction(correctionLaunchArtifactPath, async () => {
        const { handle } = await acquireFilesystemLockAsync(selectionLockPath, {
            ownerLabel: `record-review-output-correction-transport:${taskId}:${reviewType}`
        });
        try {
            await handleRecordReviewOutputCorrectionTransportUnlocked(gateArgv);
        } finally {
            releaseFilesystemLock(handle);
        }
    });
}

async function handleRecordReviewOutputCorrectionResponseUnlocked(gateArgv: string[]): Promise<void> {
    const { options: rawOptions } = parseOptions(
        gateArgv,
        recordReviewOutputCorrectionResponseOptionDefinitions(),
        { allowPositionals: false }
    );
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = assertCanonicalReviewTypeId(options.reviewType);
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-output-correction-response', 'review_phase');
    const canonicalReviewArtifactPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-${reviewType}.md`)
    );
    const canonicalCorrectionArtifactPath = getReviewOutputCorrectionArtifactPath(
        canonicalReviewArtifactPath
    );
    const suppliedCorrectionArtifactPath = path.resolve(
        repoRoot,
        String(options.correctionArtifactPath || '').trim()
    );
    if (
        normalizePath(suppliedCorrectionArtifactPath).toLowerCase()
        !== normalizePath(canonicalCorrectionArtifactPath).toLowerCase()
    ) {
        throw new Error(
            `Correction response attestation requires canonical artifact '${normalizePath(canonicalCorrectionArtifactPath)}'.`
        );
    }
    const correctionRead = readReviewOutputCorrectionArtifact(canonicalCorrectionArtifactPath);
    if (correctionRead.violations.length > 0 || !correctionRead.artifact) {
        throw new Error(
            `Correction response attestation requires intact correction evidence: ${correctionRead.violations.join(' ')}`
        );
    }
    const correctionArtifact = correctionRead.artifact;
    const binding = correctionArtifact.transport_binding;
    const selectedTransport = correctionArtifact.recovery.selected_transport;
    const isLiveContinuation = selectedTransport === 'live_reviewer_continuation';
    const isApiContinuation = selectedTransport === 'api_conversation_continuation';
    if (
        correctionArtifact.state !== 'REVIEW_OUTPUT_CORRECTION_REQUIRED'
        || !binding
        || (
            !isLiveContinuation
            && !isApiContinuation
        )
        || (
            isLiveContinuation
            && (
                binding.session_availability !== 'pending'
                || binding.provider_capabilities.live_reviewer_continuation !== true
            )
        )
        || (
            isApiContinuation
            && (
                binding.session_availability !== 'stateless'
                || binding.provider_capabilities.api_conversation_continuation !== true
            )
        )
    ) {
        throw new Error('Correction response attestation requires a pending provider-continuation package.');
    }
    const reviewerIdentity = String(options.reviewerIdentity || '').trim();
    const providerInvocationId = String(options.providerInvocationId || '').trim();
    const attestationSource = String(options.attestationSource || '').trim().toLowerCase();
    if (
        !isResolvedReviewerIdentity(reviewerIdentity)
        || reviewerIdentity !== correctionArtifact.binding.reviewer_identity
        || providerInvocationId !== binding.provider_invocation_id
        || !isProviderOwnedReviewOutputCorrectionSessionAttestationSource(attestationSource)
    ) {
        throw new Error('Correction response attestation does not match the provider-owned reviewer session.');
    }
    const canonicalOutputRoot = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'tmp', 'reviews', taskId, reviewType)
    );
    const reviewOutputPath = path.resolve(repoRoot, String(options.reviewOutputPath || '').trim());
    const relativeOutputPath = path.relative(path.resolve(canonicalOutputRoot), reviewOutputPath);
    const outputStat = fs.lstatSync(reviewOutputPath);
    if (
        !relativeOutputPath
        || path.isAbsolute(relativeOutputPath)
        || relativeOutputPath === '..'
        || relativeOutputPath.startsWith(`..${path.sep}`)
        || outputStat.isSymbolicLink()
        || !outputStat.isFile()
    ) {
        throw new Error('Correction response attestation requires a regular task-owned review output file.');
    }
    if (!gateHelpers.isPathRealpathInsideRoot(reviewOutputPath, canonicalOutputRoot)) {
        throw new Error(
            'Correction response attestation output must not escape through symlinks or junctions.'
        );
    }
    const realReviewOutputPath = fs.realpathSync.native(reviewOutputPath);
    if (
        normalizePath(realReviewOutputPath).toLowerCase()
        !== normalizePath(reviewOutputPath).toLowerCase()
    ) {
        throw new Error(
            'Correction response attestation output must not traverse symlinks or junctions.'
        );
    }
    const providerResponseSha256 = fileSha256(reviewOutputPath) || '';
    if (!/^[0-9a-f]{64}$/u.test(providerResponseSha256)) {
        throw new Error('Correction response attestation could not hash the provider response.');
    }
    const timelinePath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'task-events', `${taskId}.jsonl`)
    );
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const invocationEvent = timelineEvents.find((event) => (
        String(event.integrity?.event_sha256 || '').trim().toLowerCase()
            === correctionArtifact.binding.reviewer_invocation_event_sha256
    ));
    const invocationDetails = invocationEvent?.details || {};
    if (
        invocationEvent?.event_type !== 'REVIEWER_INVOCATION_ATTESTED'
        || getArtifactStringField(invocationDetails, 'reviewer_identity', 'reviewerIdentity')
            !== reviewerIdentity
        || getArtifactStringField(invocationDetails, 'provider_invocation_id', 'providerInvocationId')
            !== providerInvocationId
        || getArtifactStringField(
            invocationDetails,
            'reviewer_launch_attestation_source',
            'attestation_source',
            'attestationSource'
        ).toLowerCase() !== attestationSource
    ) {
        throw new Error('Correction response attestation lacks matching provider-owned invocation telemetry.');
    }
    const boundLaunchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
        repoRoot,
        taskId,
        reviewType,
        artifactPathValue: getArtifactStringField(
            invocationDetails,
            'reviewer_launch_artifact_path',
            'reviewerLaunchArtifactPath'
        ) || undefined
    });
    const boundLaunchArtifactSha256 = fileSha256(boundLaunchArtifactPath) || '';
    let boundLaunchArtifact: Record<string, unknown>;
    try {
        const parsed = JSON.parse(fs.readFileSync(boundLaunchArtifactPath, 'utf8')) as unknown;
        if (!isPlainRecord(parsed)) {
            throw new Error('not an object');
        }
        boundLaunchArtifact = parsed;
    } catch {
        throw new Error('Correction response attestation requires the intact provider launch artifact.');
    }
    const boundReviewOutputPath = gateHelpers.resolvePathInsideRepo(
        getArtifactStringField(boundLaunchArtifact, 'review_output_path', 'reviewOutputPath'),
        repoRoot,
        { allowMissing: false }
    );
    if (!boundReviewOutputPath) {
        throw new Error('Correction response launch output binding is missing.');
    }
    if (
        getArtifactStringField(
            invocationDetails,
            'reviewer_launch_artifact_sha256',
            'reviewerLaunchArtifactSha256'
        ).toLowerCase() !== boundLaunchArtifactSha256.toLowerCase()
        || normalizePath(path.resolve(boundReviewOutputPath)).toLowerCase()
            !== normalizePath(reviewOutputPath).toLowerCase()
    ) {
        throw new Error(
            'Correction response output does not match the immutable provider launch output binding.'
        );
    }
    const delegationStartedAtMs = Date.parse(getArtifactStringField(
        invocationDetails,
        'delegation_started_at_utc',
        'delegationStartedAtUtc',
        'launched_at_utc',
        'launchedAtUtc'
    ));
    if (Number.isFinite(delegationStartedAtMs) && outputStat.mtimeMs + 1 < delegationStartedAtMs) {
        throw new Error('Correction response output predates the provider-owned reviewer delegation.');
    }
    const correctionPackageSha256 = fileSha256(canonicalCorrectionArtifactPath) || '';
    const expectedResponseEventType = isLiveContinuation
        ? 'REVIEW_OUTPUT_CORRECTION_LIVE_CONTINUATION'
        : 'REVIEW_OUTPUT_CORRECTION_API_CONTINUATION';
    const existingEvent = [...timelineEvents].reverse().find((event) => {
        const details = event.details || {};
        return event.event_type === expectedResponseEventType
            && getArtifactStringField(details, 'correction_artifact_sha256').toLowerCase()
                === String(correctionArtifact.artifact_sha256 || '').toLowerCase()
            && getArtifactStringField(details, 'correction_package_sha256').toLowerCase()
                === correctionPackageSha256
            && getArtifactStringField(details, 'availability_provider_response_sha256').toLowerCase()
                === providerResponseSha256;
    });
    if (existingEvent) {
        console.log(`REVIEW_OUTPUT_CORRECTION_RESPONSE_ALREADY_ATTESTED: ${reviewType}`);
        console.log(`ProviderResponseEventSha256: ${existingEvent.integrity?.event_sha256 || ''}`);
        console.log(`NextStep: node bin/garda.js next-step "${taskId}" --repo-root "."`);
        return;
    }
    const event = await emitReviewOutputCorrectionTransportEventAsync(
        gateHelpers.joinOrchestratorPath(repoRoot, ''),
        taskId,
        reviewType,
        selectedTransport,
        {
            task_id: taskId,
            review_type: reviewType,
            reviewer_identity: reviewerIdentity,
            reviewer_attempt_id: correctionArtifact.binding.reviewer_attempt_id,
            reviewer_invocation_event_sha256:
                correctionArtifact.binding.reviewer_invocation_event_sha256,
            provider_id: binding.provider_id,
            provider_invocation_id: providerInvocationId,
            provider_capabilities: binding.provider_capabilities,
            provider_capabilities_sha256: binding.provider_capabilities_sha256,
            session_availability: isLiveContinuation ? 'available' : 'stateless',
            availability_attestation_source: attestationSource,
            availability_evidence_type: 'provider_native_session_receipt',
            availability_provider_invocation_event_sha256:
                correctionArtifact.binding.reviewer_invocation_event_sha256,
            availability_provider_response_sha256: providerResponseSha256,
            provider_response_output_path: normalizePath(reviewOutputPath),
            selected_transport: selectedTransport,
            correction_attempt: correctionArtifact.recovery.correction_attempt,
            previous_correction_package_sha256: correctionPackageSha256,
            correction_package_sha256: correctionPackageSha256,
            correction_artifact_path: normalizePath(canonicalCorrectionArtifactPath),
            correction_artifact_sha256: correctionArtifact.artifact_sha256
        }
    );
    if (!event || taskEventAppendHasBlockingFailure(event, false)) {
        throw new Error(`Correction provider response attestation failed for '${reviewType}'.`);
    }
    console.log(`REVIEW_OUTPUT_CORRECTION_RESPONSE_ATTESTED: ${reviewType}`);
    console.log(`ProviderResponseSha256: ${providerResponseSha256}`);
    console.log(`ProviderResponseEventSha256: ${event.integrity?.event_sha256 || ''}`);
    console.log(`NextStep: node bin/garda.js next-step "${taskId}" --repo-root "."`);
}

async function handleRecordReviewOutputCorrectionResponse(gateArgv: string[]): Promise<void> {
    const { options: rawOptions } = parseOptions(
        gateArgv,
        recordReviewOutputCorrectionResponseOptionDefinitions(),
        { allowPositionals: false }
    );
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = assertCanonicalReviewTypeId(options.reviewType);
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    const canonicalReviewArtifactPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-${reviewType}.md`)
    );
    const correctionLaunchArtifactPath = getReviewOutputCorrectionLaunchArtifactPath(
        canonicalReviewArtifactPath
    );
    const responseLockPath = getReviewOutputCorrectionTransportLockPath(repoRoot, taskId, reviewType);
    await withReviewerLaunchLaneTransaction(correctionLaunchArtifactPath, async () => {
        const { handle } = await acquireFilesystemLockAsync(responseLockPath, {
            ownerLabel: `record-review-output-correction-response:${taskId}:${reviewType}`
        });
        try {
            await handleRecordReviewOutputCorrectionResponseUnlocked(gateArgv);
        } finally {
            releaseFilesystemLock(handle);
        }
    });
}

async function handleRecordReviewOutputCorrectionInvocationUnlocked(gateArgv: string[]): Promise<void> {
    const { options: rawOptions } = parseOptions(
        gateArgv,
        recordReviewOutputCorrectionInvocationOptionDefinitions(),
        { allowPositionals: false }
    );
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = assertCanonicalReviewTypeId(options.reviewType);
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-output-correction-invocation', 'review_phase');
    const canonicalReviewArtifactPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-${reviewType}.md`)
    );
    const canonicalCorrectionArtifactPath = getReviewOutputCorrectionArtifactPath(canonicalReviewArtifactPath);
    const suppliedCorrectionArtifactPath = path.resolve(
        repoRoot,
        String(options.correctionArtifactPath || '').trim()
    );
    if (
        normalizePath(suppliedCorrectionArtifactPath).toLowerCase()
        !== normalizePath(canonicalCorrectionArtifactPath).toLowerCase()
    ) {
        throw new Error(
            `Correction invocation requires canonical artifact '${normalizePath(canonicalCorrectionArtifactPath)}'.`
        );
    }
    const correctionRead = readReviewOutputCorrectionArtifact(canonicalCorrectionArtifactPath);
    if (correctionRead.violations.length > 0 || !correctionRead.artifact) {
        throw new Error(
            `Correction invocation requires intact correction evidence: ${correctionRead.violations.join(' ')}`
        );
    }
    const correctionArtifact = correctionRead.artifact;
    if (
        correctionArtifact.task_id !== taskId
        || correctionArtifact.review_type !== reviewType
        || correctionArtifact.state !== 'REVIEW_OUTPUT_CORRECTION_REQUIRED'
        || correctionArtifact.recovery.selected_transport !== 'correction_only_invocation'
    ) {
        throw new Error('Correction invocation is available only for the bound pending correction-only transport.');
    }
    const correctionArtifactSha256 = fileSha256(canonicalCorrectionArtifactPath) || '';
    const correctionLaunchArtifactPath = getReviewOutputCorrectionLaunchArtifactPath(
        canonicalReviewArtifactPath
    );
    if (!fs.existsSync(correctionLaunchArtifactPath) || !fs.statSync(correctionLaunchArtifactPath).isFile()) {
        throw new Error('Correction-only invocation requires a gate-owned prepared launch artifact.');
    }
    const correctionLaunchArtifactText = fs.readFileSync(correctionLaunchArtifactPath, 'utf8');
    let correctionLaunchArtifact: Record<string, unknown>;
    try {
        const parsed = JSON.parse(correctionLaunchArtifactText) as unknown;
        if (!isPlainRecord(parsed)) {
            throw new Error('not an object');
        }
        correctionLaunchArtifact = parsed;
    } catch {
        throw new Error('Correction-only invocation launch artifact is not valid JSON.');
    }
    if (
        correctionLaunchArtifact.artifact_type !== REVIEW_OUTPUT_CORRECTION_LAUNCH_ARTIFACT_TYPE
        || !['prepared', 'delegation_started'].includes(String(correctionLaunchArtifact.state || ''))
        || correctionLaunchArtifact.task_id !== taskId
        || correctionLaunchArtifact.review_type !== reviewType
        || String(correctionLaunchArtifact.correction_artifact_sha256 || '').toLowerCase()
            !== correctionArtifactSha256
        || String(correctionLaunchArtifact.launch_input_sha256 || '').toLowerCase()
            !== correctionArtifactSha256
        || String(correctionLaunchArtifact.review_context_sha256 || '').toLowerCase()
            !== correctionArtifact.binding.review_context_sha256
        || String(correctionLaunchArtifact.review_tree_state_sha256 || '').toLowerCase()
            !== correctionArtifact.binding.review_tree_state_sha256
        || String(correctionLaunchArtifact.provider_capabilities_sha256 || '').toLowerCase()
            !== String(correctionArtifact.transport_binding?.provider_capabilities_sha256 || '').toLowerCase()
        || String(correctionLaunchArtifact.session_availability || '')
            !== String(correctionArtifact.transport_binding?.session_availability || '')
        || normalizePath(String(correctionLaunchArtifact.provider_response_output_path || '')).toLowerCase()
            !== normalizePath(
                String(correctionArtifact.recovery.handoff?.provider_response_output_path || '')
            ).toLowerCase()
    ) {
        throw new Error('Correction-only invocation launch artifact is stale or does not match the correction package.');
    }
    const launchArtifactState = String(correctionLaunchArtifact.state || '');
    const callerSuppliedLaunchProvenance = [
        options.correctionProducerIdentity,
        options.providerInvocationId,
        options.attestationSource,
        options.launchInputSha256
    ].some((value) => typeof value !== 'undefined')
        || typeof options.forkContext !== 'undefined';
    if (launchArtifactState === 'delegation_started' && callerSuppliedLaunchProvenance) {
        throw new Error(
            'Correction-only invocation completion consumes the frozen provider delegation receipt; ' +
            'do not resupply identity, invocation, attestation, launch-input, or fork-context fields.'
        );
    }
    const launchInputSha256 = launchArtifactState === 'delegation_started'
        ? String(correctionLaunchArtifact.launch_input_sha256 || '').trim().toLowerCase()
        : String(options.launchInputSha256 || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(launchInputSha256) || launchInputSha256 !== correctionArtifactSha256) {
        throw new Error('Correction invocation launch input does not match the persisted correction package.');
    }
    const correctionProducerIdentity = launchArtifactState === 'delegation_started'
        ? String(correctionLaunchArtifact.correction_producer_identity || '').trim()
        : String(options.correctionProducerIdentity || '').trim();
    if (
        !isResolvedReviewerIdentity(correctionProducerIdentity)
        || correctionProducerIdentity === correctionArtifact.binding.reviewer_identity
    ) {
        throw new Error('Correction-only invocation requires a fresh resolved provider reviewer identity.');
    }
    const providerInvocationId = launchArtifactState === 'delegation_started'
        ? String(correctionLaunchArtifact.provider_invocation_id || '').trim()
        : String(options.providerInvocationId || '').trim();
    if (
        !providerInvocationId
        || /^(?:unknown|n\/a|na|null|none|manual|mock|test|placeholder|<.*>)$/iu.test(providerInvocationId)
    ) {
        throw new Error('Correction-only invocation requires the actual provider invocation id.');
    }
    const attestationSource = (
        launchArtifactState === 'delegation_started'
            ? String(correctionLaunchArtifact.attestation_source || '')
            : String(options.attestationSource || '')
    ).trim().toLowerCase();
    if (
        !attestationSource
        || /^(?:garda_prepare_reviewer_launch|orchestrator_mock|manual|mock|test|placeholder)$/iu.test(attestationSource)
        || !/(?:spawn|subagent|task|tool|launch|run|invocation)/iu.test(attestationSource)
    ) {
        throw new Error('Correction-only invocation requires provider/controller-owned attestation source.');
    }
    const forkContext = launchArtifactState === 'delegation_started'
        ? correctionLaunchArtifact.fork_context
        : options.forkContext;
    if (forkContext !== false) {
        throw new Error('Correction-only invocation requires --fork-context false.');
    }
    const timelinePath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'task-events', `${taskId}.jsonl`)
    );
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    if (['closed', 'stateless'].includes(
        correctionArtifact.transport_binding?.session_availability || ''
    )) {
        const transportEvent = [...timelineEvents].reverse().find((event) => {
            const details = event.details || {};
            return event.event_type === 'REVIEW_OUTPUT_CORRECTION_ONLY_INVOCATION'
                && getArtifactStringField(details, 'correction_artifact_sha256')
                    === String(correctionArtifact.artifact_sha256 || '').toLowerCase()
                && getArtifactStringField(details, 'provider_capabilities_sha256')
                    === correctionArtifact.transport_binding?.provider_capabilities_sha256;
        });
        if (!transportEvent) {
            throw new Error('Correction-only invocation lacks authenticated transport-selection telemetry.');
        }
    }
    const originalInvocation = timelineEvents.find((event) => (
        event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
        && String(event.integrity?.event_sha256 || '').trim().toLowerCase()
            === correctionArtifact.binding.reviewer_invocation_event_sha256
    ));
    if (!originalInvocation) {
        throw new Error('Correction-only invocation cannot authenticate the original reviewer invocation event.');
    }
    const originalDetails = originalInvocation.details || {};
    const routingEventSha256 = getArtifactStringField(
        originalDetails,
        'routing_event_sha256',
        'routingEventSha256'
    );
    const restorePreparedCorrectionLaunch = (): void => {
        if (launchArtifactState !== 'delegation_started') {
            writeFileAtomically(
                correctionLaunchArtifactPath,
                correctionLaunchArtifactText,
                { encoding: 'utf8' }
            );
        }
    };
    const emitWithPreparedLaunchRollback = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
            return await operation();
        } catch (error) {
            restorePreparedCorrectionLaunch();
            throw error;
        }
    };
    const delegationStartedAtUtc = launchArtifactState === 'delegation_started'
        ? String(correctionLaunchArtifact.delegation_started_at_utc || '')
        : new Date().toISOString();
    let providerResponseOutputPath = '';
    let providerResponseSha256 = '';
    if (launchArtifactState === 'delegation_started') {
        const declaredProviderResponseOutputPath = String(
            correctionLaunchArtifact.provider_response_output_path || ''
        ).trim();
        const expectedProviderResponseOutputPath = String(
            correctionArtifact.recovery.handoff?.provider_response_output_path || ''
        ).trim();
        if (!declaredProviderResponseOutputPath || !expectedProviderResponseOutputPath) {
            throw new Error('Correction-only completion requires a predeclared provider response output path.');
        }
        const resolvedProviderResponseOutputPath = gateHelpers.resolvePathInsideRepo(
            declaredProviderResponseOutputPath,
            repoRoot,
            { allowMissing: false }
        );
        if (!resolvedProviderResponseOutputPath) {
            throw new Error('Correction-only provider response output binding is missing.');
        }
        providerResponseOutputPath = resolvedProviderResponseOutputPath;
        if (
            normalizePath(providerResponseOutputPath).toLowerCase()
            !== normalizePath(path.resolve(expectedProviderResponseOutputPath)).toLowerCase()
        ) {
            throw new Error('Correction-only provider response does not match the prepared launch output binding.');
        }
        const providerResponseStat = fs.lstatSync(providerResponseOutputPath);
        const canonicalProviderResponseRoot = gateHelpers.joinOrchestratorPath(
            repoRoot,
            path.join('runtime', 'reviews')
        );
        if (
            providerResponseStat.isSymbolicLink()
            || !providerResponseStat.isFile()
            || !gateHelpers.isPathRealpathInsideRoot(
                providerResponseOutputPath,
                canonicalProviderResponseRoot
            )
        ) {
            throw new Error('Correction-only provider response must be a regular task-owned output file.');
        }
        const preparedAtMs = Date.parse(String(correctionLaunchArtifact.prepared_at_utc || ''));
        if (Number.isFinite(preparedAtMs) && providerResponseStat.mtimeMs + 1 < preparedAtMs) {
            throw new Error('Correction-only provider response predates the prepared provider launch.');
        }
        providerResponseSha256 = fileSha256(providerResponseOutputPath) || '';
        if (!/^[0-9a-f]{64}$/u.test(providerResponseSha256)) {
            throw new Error('Correction-only provider response hash is unavailable.');
        }
    }
    if (launchArtifactState === 'delegation_started' && (
        correctionLaunchArtifact.correction_producer_identity !== correctionProducerIdentity
        || correctionLaunchArtifact.provider_invocation_id !== providerInvocationId
        || correctionLaunchArtifact.attestation_source !== attestationSource
        || correctionLaunchArtifact.fork_context !== false
    )) {
        throw new Error('Correction-only invocation cannot redefine the persisted provider delegation.');
    }
    const startedCorrectionLaunchArtifact = launchArtifactState === 'delegation_started'
        ? correctionLaunchArtifact
        : {
            ...correctionLaunchArtifact,
            state: 'delegation_started',
            correction_producer_identity: correctionProducerIdentity,
            provider_invocation_id: providerInvocationId,
            attestation_source: attestationSource,
            fork_context: false,
            delegation_started_at_utc: delegationStartedAtUtc
        };
    if (launchArtifactState !== 'delegation_started') {
        writeFileAtomically(
            correctionLaunchArtifactPath,
            `${JSON.stringify(startedCorrectionLaunchArtifact, null, 2)}\n`,
            { encoding: 'utf8' }
        );
    }
    const correctionLaunchArtifactSha256 = fileSha256(correctionLaunchArtifactPath) || '';
    if (!/^[0-9a-f]{64}$/u.test(correctionLaunchArtifactSha256)) {
        restorePreparedCorrectionLaunch();
        throw new Error('Correction-only invocation launch artifact hash is unavailable.');
    }
    const existingDelegationStartedEvent = [...timelineEvents].reverse().find((event) => {
        const details = event.details || {};
        return event.event_type === 'REVIEWER_DELEGATION_STARTED'
            && getArtifactStringField(details, 'invocation_role') === 'review_output_correction'
            && getArtifactStringField(details, 'reviewer_launch_artifact_sha256')
                === correctionLaunchArtifactSha256
            && getArtifactStringField(details, 'reviewer_identity', 'reviewerIdentity')
                === correctionProducerIdentity
            && getArtifactStringField(details, 'provider_invocation_id', 'providerInvocationId')
                === providerInvocationId;
    });
    let delegationStartedEventSha256 = String(
        existingDelegationStartedEvent?.integrity?.event_sha256 || ''
    ).trim().toLowerCase();
    if (!existingDelegationStartedEvent) {
        const emittedDelegationStartedEvent = await emitWithPreparedLaunchRollback(() => (
            emitReviewerDelegationStartedEventAsync(
            gateHelpers.joinOrchestratorPath(repoRoot, ''),
            taskId,
            reviewType,
            'delegated_subagent',
            correctionProducerIdentity,
            correctionArtifact.binding.review_context_sha256,
            routingEventSha256,
            {
                launchDetails: {
                    invocation_role: 'review_output_correction',
                    reviewer_launch_attempt_id: providerInvocationId,
                    reviewer_launch_artifact_path: normalizePath(correctionLaunchArtifactPath),
                    reviewer_launch_artifact_sha256: correctionLaunchArtifactSha256,
                    provider_invocation_id: providerInvocationId,
                    reviewer_launch_attestation_source: attestationSource,
                    attestation_source: attestationSource,
                    launch_input_mode: 'review_output_correction_artifact',
                    launch_input_sha256: launchInputSha256,
                    correction_artifact_path: normalizePath(canonicalCorrectionArtifactPath),
                    correction_artifact_sha256: correctionArtifactSha256,
                    original_reviewer_invocation_event_sha256:
                        correctionArtifact.binding.reviewer_invocation_event_sha256,
                    review_tree_state_sha256: correctionArtifact.binding.review_tree_state_sha256,
                    delegation_started_at_utc: delegationStartedAtUtc,
                    launched_at_utc: delegationStartedAtUtc,
                    fork_context: false,
                    fresh_context: true,
                    isolated_context: true
                }
            }
            )
        ));
        if (
            !emittedDelegationStartedEvent
            || taskEventAppendHasBlockingFailure(emittedDelegationStartedEvent, false)
        ) {
            restorePreparedCorrectionLaunch();
            throw new Error(`Correction-only reviewer delegation start failed for '${reviewType}'.`);
        }
        delegationStartedEventSha256 = String(
            emittedDelegationStartedEvent.integrity?.event_sha256 || ''
        ).trim().toLowerCase();
    }
    if (!/^[0-9a-f]{64}$/u.test(delegationStartedEventSha256)) {
        restorePreparedCorrectionLaunch();
        throw new Error('Correction-only reviewer delegation-start event hash is unavailable.');
    }
    if (launchArtifactState !== 'delegation_started') {
        console.log(`REVIEW_OUTPUT_CORRECTION_DELEGATION_STARTED: ${reviewType}`);
        console.log(`CorrectionProducerIdentity: ${correctionProducerIdentity}`);
        console.log(`ProviderInvocationId: ${providerInvocationId}`);
        console.log(`DelegationStartedEventSha256: ${delegationStartedEventSha256}`);
        console.log(
            'NextStep: wait for the delegated correction reviewer to return, then rerun ' +
            `node bin/garda.js next-step "${taskId}" --repo-root "."`
        );
        return;
    }
    const existingInvocation = [...timelineEvents].reverse().find((event) => {
        const details = event.details || {};
        return event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
            && getArtifactStringField(details, 'invocation_role') === 'review_output_correction'
            && getArtifactStringField(details, 'correction_artifact_sha256') === correctionArtifactSha256
            && getArtifactStringField(details, 'correction_delegation_started_event_sha256')
                === delegationStartedEventSha256
            && getArtifactStringField(details, 'correction_launch_artifact_sha256')
                === correctionLaunchArtifactSha256
            && getArtifactStringField(details, 'reviewer_identity', 'reviewerIdentity') === correctionProducerIdentity
            && getArtifactStringField(details, 'provider_invocation_id', 'providerInvocationId') === providerInvocationId;
    });
    let invocationEventSha256 = String(existingInvocation?.integrity?.event_sha256 || '').trim().toLowerCase();
    if (!existingInvocation) {
        const invocationAttestedAtUtc = new Date().toISOString();
        const emittedInvocationEvent = await emitWithPreparedLaunchRollback(() => (
            emitReviewerInvocationAttestedEventAsync(
            gateHelpers.joinOrchestratorPath(repoRoot, ''),
            taskId,
            reviewType,
            'delegated_subagent',
            correctionProducerIdentity,
            correctionArtifact.binding.review_context_sha256,
            routingEventSha256,
            {
                launchDetails: {
                    invocation_role: 'review_output_correction',
                    reviewer_launch_attempt_id: providerInvocationId,
                    provider_invocation_id: providerInvocationId,
                    reviewer_launch_attestation_source: attestationSource,
                    attestation_source: attestationSource,
                    launch_input_mode: 'review_output_correction_artifact',
                    launch_input_sha256: launchInputSha256,
                    reviewer_launch_artifact_path: normalizePath(correctionLaunchArtifactPath),
                    reviewer_launch_artifact_sha256: correctionLaunchArtifactSha256,
                    correction_launch_artifact_sha256: correctionLaunchArtifactSha256,
                    correction_delegation_started_event_sha256: delegationStartedEventSha256,
                    correction_artifact_path: normalizePath(canonicalCorrectionArtifactPath),
                    correction_artifact_sha256: correctionArtifactSha256,
                    original_reviewer_invocation_event_sha256:
                        correctionArtifact.binding.reviewer_invocation_event_sha256,
                    review_tree_state_sha256: correctionArtifact.binding.review_tree_state_sha256,
                    delegation_started_at_utc: invocationAttestedAtUtc,
                    launched_at_utc: invocationAttestedAtUtc,
                    invocation_attested_at_utc: invocationAttestedAtUtc,
                    fork_context: false,
                    fresh_context: true,
                    isolated_context: true
                }
            }
            )
        ));
        if (!emittedInvocationEvent || taskEventAppendHasBlockingFailure(emittedInvocationEvent, false)) {
            restorePreparedCorrectionLaunch();
            throw new Error(`Correction-only reviewer invocation attestation failed for '${reviewType}'.`);
        }
        invocationEventSha256 = String(
            emittedInvocationEvent.integrity?.event_sha256 || ''
        ).trim().toLowerCase();
    }
    if (!/^[0-9a-f]{64}$/u.test(invocationEventSha256)) {
        restorePreparedCorrectionLaunch();
        throw new Error('Correction-only reviewer invocation event hash is unavailable.');
    }
    const existingCorrectionInvocation = [...timelineEvents].reverse().find((event) => {
        const details = event.details || {};
        return event.event_type === 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED'
            && getArtifactStringField(details, 'task_id', 'taskId') === taskId
            && getArtifactStringField(details, 'review_type', 'reviewType').toLowerCase() === reviewType
            && getArtifactStringField(details, 'correction_artifact_sha256')
                === String(correctionArtifact.artifact_sha256 || '').toLowerCase()
            && getArtifactStringField(details, 'correction_package_sha256') === correctionArtifactSha256
            && getArtifactStringField(details, 'correction_producer_identity') === correctionProducerIdentity
            && getArtifactStringField(details, 'provider_invocation_id') === providerInvocationId
            && getArtifactStringField(details, 'availability_provider_response_sha256')
                === providerResponseSha256;
    });
    let correctionResponseEventSha256 = String(
        existingCorrectionInvocation?.integrity?.event_sha256 || ''
    ).trim().toLowerCase();
    if (!existingCorrectionInvocation) {
        const correctionInvocationEvent = await emitWithPreparedLaunchRollback(() => (
            emitReviewOutputCorrectionInvocationAttestedEventAsync(
            gateHelpers.joinOrchestratorPath(repoRoot, ''),
            taskId,
            reviewType,
            {
                task_id: taskId,
                review_type: reviewType,
                reviewer_identity: correctionProducerIdentity,
                original_reviewer_identity: correctionArtifact.binding.reviewer_identity,
                correction_producer_identity: correctionProducerIdentity,
                reviewer_attempt_id: correctionArtifact.binding.reviewer_attempt_id,
                provider_invocation_id: providerInvocationId,
                provider_invocation_event_sha256: invocationEventSha256,
                attestation_source: attestationSource,
                availability_attestation_source: attestationSource,
                availability_evidence_type: 'provider_native_response_receipt',
                availability_provider_response_sha256: providerResponseSha256,
                provider_response_output_path: normalizePath(providerResponseOutputPath),
                launch_input_mode: 'review_output_correction_artifact_path',
                launch_input_sha256: launchInputSha256,
                correction_artifact_path: normalizePath(canonicalCorrectionArtifactPath),
                correction_artifact_sha256: correctionArtifact.artifact_sha256,
                correction_package_sha256: correctionArtifactSha256,
                correction_attempt: correctionArtifact.recovery.correction_attempt,
                validation_artifact_sha256: correctionArtifact.binding.validation_artifact_sha256,
                selected_transport: correctionArtifact.recovery.selected_transport,
                provider_id: correctionArtifact.transport_binding?.provider_id || null,
                provider_capabilities_sha256:
                    correctionArtifact.transport_binding?.provider_capabilities_sha256 || null,
                session_availability:
                    correctionArtifact.transport_binding?.session_availability || null,
                state: 'REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED',
                fork_context: false
            }
            )
        ));
        if (
            !correctionInvocationEvent
            || taskEventAppendHasBlockingFailure(correctionInvocationEvent, false)
        ) {
            restorePreparedCorrectionLaunch();
            throw new Error(`Correction-only invocation telemetry failed for '${reviewType}'.`);
        }
        correctionResponseEventSha256 = String(
            correctionInvocationEvent.integrity?.event_sha256 || ''
        ).trim().toLowerCase();
    }
    if (!/^[0-9a-f]{64}$/u.test(correctionResponseEventSha256)) {
        throw new Error('Correction-only provider response event hash is unavailable.');
    }
    console.log(`REVIEW_OUTPUT_CORRECTION_INVOCATION_ATTESTED: ${reviewType}`);
    console.log(`CorrectionProducerIdentity: ${correctionProducerIdentity}`);
    console.log(`ProviderInvocationId: ${providerInvocationId}`);
    console.log(`CorrectionInvocationEventSha256: ${invocationEventSha256}`);
    console.log(`ProviderResponseSha256: ${providerResponseSha256}`);
    console.log(`ProviderResponseEventSha256: ${correctionResponseEventSha256}`);
    console.log(`NextStep: node bin/garda.js next-step "${taskId}" --repo-root "."`);
}

async function handleRecordReviewOutputCorrectionInvocation(gateArgv: string[]): Promise<void> {
    const { options: rawOptions } = parseOptions(
        gateArgv,
        recordReviewOutputCorrectionInvocationOptionDefinitions(),
        { allowPositionals: false }
    );
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = assertCanonicalReviewTypeId(options.reviewType);
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    const canonicalReviewArtifactPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-${reviewType}.md`)
    );
    const correctionLaunchArtifactPath = getReviewOutputCorrectionLaunchArtifactPath(
        canonicalReviewArtifactPath
    );
    const invocationLockPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join(
            'runtime',
            'tmp',
            'reviews',
            taskId,
            reviewType,
            '.record-review-output-correction-invocation.lock'
        )
    );
    await withReviewerLaunchLaneTransaction(correctionLaunchArtifactPath, async () => {
        const { handle } = await acquireFilesystemLockAsync(invocationLockPath, {
            ownerLabel: `record-review-output-correction-invocation:${taskId}:${reviewType}`
        });
        try {
            await handleRecordReviewOutputCorrectionInvocationUnlocked(gateArgv);
        } finally {
            releaseFilesystemLock(handle);
        }
    });
}

export function createReviewResultHandlers(dependencies: ReviewResultHandlersDependencies): ReviewResultHandlers {
    return {
        handleRecordReviewResult: (gateArgv) => handleRecordReviewResultWithDependencies(gateArgv, dependencies),
        handleRecordReviewReceipt: (gateArgv) => handleRecordReviewReceiptWithDependencies(gateArgv, dependencies),
        handleRecordReviewOutputCorrectionTransport,
        handleRecordReviewOutputCorrectionResponse,
        handleRecordReviewOutputCorrectionInvocation
    };
}
