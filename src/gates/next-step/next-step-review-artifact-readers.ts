import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    buildReviewVerdictTokenSet,
    formatReviewVerdictTokenList
} from '../../gate-runtime/review-context';
import {
    readReviewArtifactFileSha256,
    readReviewArtifactJsonFile,
    readReviewArtifactTextFile,
    withReviewArtifactReadSnapshot
} from '../../gate-runtime/review-artifacts';
import {
    inspectTaskEventFile
} from '../../gate-runtime/timeline/task-events-integrity';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    isPathRealpathInsideRoot,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import {
    REVIEW_CONTRACTS
} from '../required-reviews/required-reviews-check';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations
} from '../review-context/review-context-contract';
import type { ReviewRemediationReviewContract } from '../review-remediation/review-remediation-review-contract';
import {
    resolvePersistedRemediationReviewExecutionAuthority
} from '../review-remediation/review-remediation-execution-authority';
import {
    getReviewContextFullSuiteValidationViolations
} from '../review-context/review-context-validation-evidence';
import {
    reviewContextLaneScopeMatchesCurrentPreflight
} from '../scope/domain-scope-fingerprints';
import {
    buildReviewTrustSummary,
    type ReviewTrustSummary
} from '../review/review-trust-summary';
import {
    reviewContextRequiresFindingsOnlyArtifact,
    resolveReviewFindingsArtifactVerdictToken
} from '../review/review-findings-artifact-verdict';
import {
    getReviewFindingsValidationArtifactPath,
    validateReviewFindingsValidationArtifact,
    validateReviewFindingsValidationArtifactForReceipt,
    type ReviewFindingsValidationArtifact
} from '../review/review-findings-validation-artifact';
import {
    evaluateReviewFindingsValidationArtifactDispositions,
    type ReviewFindingsDispositionEvaluation,
    resolveLockedReviewFindingPolicyFromPreflight,
    resolveLockedReviewFindingPolicyFromReceiptDisposition,
    resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence,
    reviewFindingsValidationArtifactHasBlockingFindings
} from '../review/review-finding-disposition';
import {
    validateReviewFindingsDispositionEvidence
} from '../review/review-findings-disposition-evidence';
import {
    resolveReviewCoverageEvidenceSnapshotCommit,
    type ReviewCoverageContract
} from '../review/review-coverage-ledger';
import {
    normalizeReviewEvidenceSha256,
    normalizeReviewReceiptEvidenceFields,
    validateReviewReceiptEvidenceContract
} from '../review/review-evidence-contract';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    isNonTestReviewScope
} from '../review-reuse/review-reuse';
import {
    type ReviewReuseTelemetryEventLike,
    validateHistoricalReviewRecordedTelemetryEventMatch,
    validateStrictReusedReviewEvidence
} from '../review-reuse/review-reuse-telemetry';
import {
    readTaskQueueEntries,
    type TaskQueueEntry
} from '../../core/task-queue-read';
import {
    detectMissingFocusedValidationEvidenceFailureReason,
    detectMissingValidationEvidenceFailureReason,
    detectReviewLaunchPackageFailureReason,
    detectStaleValidationEvidenceFailureReason
} from './next-step-review-artifact-failure-detection';
import { isPlainRecord } from '../../core/records';
import type { ReviewFollowUpMaterializationMode } from '../../policy/profile-resolver';
import {
    getReviewOutputCorrectionArtifactPath,
    getReviewOutputCorrectionLaunchArtifactPath,
    readReviewOutputCorrectionArtifact
} from '../review/review-output-correction';
import {
    readTaskTimelineEventLikes,
    readTaskTimelineEventWindow,
    withNextStepReviewEvidenceSnapshot
} from './next-step-review-timeline-evidence';
import { reviewCorrectionWasSuperseded } from './next-step-review-correction-supersession';

const REVIEW_VERDICT_PASS_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(REVIEW_CONTRACTS));
const REVIEW_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const REVIEW_VERDICT_FAIL_TOKENS: Record<string, string> = Object.freeze(
    Object.fromEntries(Object.entries(REVIEW_VERDICT_PASS_TOKENS).map(([reviewType, passToken]) => {
        if (reviewType === 'code') {
            return [reviewType, 'CODE REVIEW FAILED'];
        }
        return [reviewType, passToken.replace(/\bPASSED\b/u, 'FAILED')];
    }))
);

export interface ReviewArtifactState {
    reviewType: string;
    contextPath: string;
    artifactPath: string;
    receiptPath: string;
    contextExists: boolean;
    contextCurrent: boolean;
    artifactExists: boolean;
    receiptExists: boolean;
    receiptContractCurrent?: boolean;
    passToken: string;
    failToken: string;
    verdictToken: string | null;
    failed: boolean;
    failureKind:
        | 'launch-package'
        | 'missing-focused-validation-evidence'
        | 'missing-validation-evidence'
        | 'stale-validation-evidence'
        | 'review-validation-rejected'
        | 'review-correction-transport-selection-required'
        | 'review-correction-full-review-required'
        | null;
    failureReason: string | null;
    reviewFindingsValidationAccepted: boolean | null;
    frozenReviewFindingsValidationAccepted?: boolean | null;
    reviewFindingsValidationRejected: boolean;
    reviewFindingsValidationArtifactPath: string | null;
    reviewOutputCorrectionArtifactPath?: string | null;
    reviewOutputCorrectionState?: string | null;
    reviewOutputCorrectionLaunchState?: string | null;
    reviewOutputCorrectionProducerIdentity?: string | null;
    reviewOutputCorrectionProviderInvocationId?: string | null;
    reviewOutputCorrectionAttestationSource?: string | null;
    reviewOutputCorrectionSessionAvailability?: string | null;
    reviewOutputCorrectionOriginalProviderInvocationId?: string | null;
    reviewOutputCorrectionReviewerIdentity?: string | null;
    reviewOutputCorrectionHandoff?: ReviewOutputCorrectionHandoffEvidence | null;
    reviewFindingsDisposition: ReviewFindingsDispositionEvaluation | null;
    frozenReviewFindingsDisposition?: ReviewFindingsDispositionEvaluation | null;
    reviewFindingsDispositionArtifactPath: string | null;
    reviewFindingsDispositionArtifactSha256: string | null;
    reviewFindingsFollowUpArtifactPath: string | null;
    reviewFindingsFollowUpSatisfied: boolean;
    reviewFollowUpMaterializationMode?: ReviewFollowUpMaterializationMode;
    domainScopeCurrent: boolean;
    ready: boolean;
    violations: string[];
    reviewerIdentity: string | null;
    contextReviewerIdentity: string | null;
    reusedExistingReview: boolean;
    reusedFromReceiptPath: string | null;
    reusedFromReceiptSha256: string | null;
    reusedFromReviewContextSha256: string | null;
    reusedFromReviewContextReuseSha256: string | null;
    reusedFromReviewTreeStateSha256: string | null;
    reusedFromReviewScopeSha256: string | null;
    reusedFromCodeScopeSha256: string | null;
    receiptReviewContextSha256: string | null;
    receiptReviewContextReuseSha256: string | null;
    receiptReviewScopeSha256: string | null;
    receiptCodeScopeSha256: string | null;
    contextReviewTreeStateSha256: string | null;
    receiptReviewTreeStateSha256: string | null;
    reviewerProvenance: {
        attestation_type: string;
        controller_event_type: string;
        task_sequence: number | null;
        prev_event_sha256: string | null;
        event_sha256: string | null;
        task_id?: string;
        review_type?: string;
        reviewer_execution_mode?: string;
        reviewer_identity?: string;
        review_context_sha256?: string;
        review_tree_state_sha256?: string | null;
        routing_event_sha256?: string;
        launch_prepared_at_utc?: string | null;
        launched_at_utc?: string | null;
        launch_completed_at_utc?: string | null;
        invocation_attested_at_utc?: string | null;
    } | null;
    reviewResultRecordedAtUtc: string | null;
    recordedAtUtc: string | null;
    reviewOutputSourceMtimeUtc: string | null;
}

export interface ReviewOutputCorrectionHandoffEvidence {
    providerAction: string | null;
    providerResponseOutputPath?: string | null;
    launchState: string | null;
    targetReviewerIdentity: string | null;
    launchInputSha256: string | null;
    reviewerInvocationEventSha256: string | null;
    correctionProducerInvocationEventSha256: string | null;
    correctionProducerIdentity: string | null;
    correctionProviderInvocationId: string | null;
    originalProviderInvocationId: string | null;
    correctionAttestationSource: string | null;
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function getPreflightScopeSha256(preflightPayload: Record<string, unknown> | null): string | null {
    const metrics = preflightPayload?.metrics && typeof preflightPayload.metrics === 'object' && !Array.isArray(preflightPayload.metrics)
        ? preflightPayload.metrics as Record<string, unknown>
        : null;
    const candidate = String(metrics?.scope_sha256 || metrics?.changed_files_sha256 || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(candidate) ? candidate : null;
}

function getReceiptOutputContractString(receipt: Record<string, unknown>, key: string): string | null {
    const contract = receipt.review_output_contract;
    const value = contract && typeof contract === 'object' && !Array.isArray(contract)
        ? (contract as Record<string, unknown>)[key]
        : null;
    return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function sha256JsonPayload(value: unknown): string {
    return createHash('sha256')
        .update(`${JSON.stringify(value, null, 2)}\n`)
        .digest('hex');
}

function extractReviewFollowUpFingerprint(notes: string): string | null {
    return normalizeSha256(String(notes || '').match(/review_follow_up_fingerprint=([0-9a-f]{64})/iu)?.[1] || null);
}

function extractGroupedReviewFollowUpFingerprint(notes: string): string | null {
    return normalizeSha256(
        String(notes || '').match(/review_follow_up_group_fingerprint=([0-9a-f]{64})/iu)?.[1] || null
    );
}

function extractGroupedReviewFollowUpSnapshotHash(notes: string): string | null {
    return normalizeSha256(
        String(notes || '').match(/review_follow_up_snapshot_sha256=([0-9a-f]{64})/iu)?.[1] || null
    );
}

function extractGroupedReviewFollowUpCycleId(notes: string): string | null {
    return normalizeSha256(
        String(notes || '').match(/review_follow_up_cycle=([0-9a-f]{64})/iu)?.[1] || null
    );
}

interface GroupedReviewFollowUpLaneBinding {
    itemCount: number;
    itemFingerprintsSha256: string;
    sourceBindingSha256: string;
    artifactPath: string | null;
}

function extractGroupedReviewFollowUpLaneBindings(notes: string): Map<string, GroupedReviewFollowUpLaneBinding> {
    const bindings = new Map<string, GroupedReviewFollowUpLaneBinding>();
    const artifactPaths = new Map<string, string>();
    const artifactMatcher = /review_follow_up_lane_artifact=([a-z0-9_-]+):`([^`\r\n]+)`\./giu;
    for (const match of String(notes || '').matchAll(artifactMatcher)) {
        artifactPaths.set(match[1].toLowerCase(), normalizePath(match[2]));
    }
    const matcher = /review_follow_up_lane_binding=([a-z0-9_-]+):([0-9]+):([0-9a-f]{64}):([0-9a-f]{64})\./giu;
    for (const match of String(notes || '').matchAll(matcher)) {
        const itemCount = Number.parseInt(match[2], 10);
        const itemFingerprintsSha256 = normalizeSha256(match[3]);
        const sourceBindingSha256 = normalizeSha256(match[4]);
        if (Number.isSafeInteger(itemCount) && itemCount >= 0 && itemFingerprintsSha256 && sourceBindingSha256) {
            bindings.set(match[1].toLowerCase(), {
                itemCount,
                itemFingerprintsSha256,
                sourceBindingSha256,
                artifactPath: artifactPaths.get(match[1].toLowerCase()) || null
            });
        }
    }
    return bindings;
}

function resolveReviewFollowUpMaterializationMode(
    preflightPayload: Record<string, unknown> | null
): ReviewFollowUpMaterializationMode {
    const snapshot = isPlainRecord(preflightPayload?.profile_policy_snapshot)
        ? preflightPayload.profile_policy_snapshot
        : null;
    const policy = isPlainRecord(snapshot?.review_follow_up_policy)
        ? snapshot.review_follow_up_policy
        : null;
    return policy?.schema_version === 1 && policy.materialization_mode === 'grouped_by_parent'
        ? 'grouped_by_parent'
        : 'per_finding';
}

interface CurrentReviewFollowUpMaterializationBinding {
    mode: ReviewFollowUpMaterializationMode;
    snapshotHash: string;
    cycleId: string;
    groupFingerprint: string | null;
    preflightPath: string;
    preflightSha256: string;
    compileTimestamp: string;
}

function resolveCurrentReviewFollowUpMaterializationBinding(
    repoRoot: string,
    reviewsRoot: string,
    parentTaskId: string
): CurrentReviewFollowUpMaterializationBinding | null {
    const preflightPath = path.join(reviewsRoot, `${parentTaskId}-preflight.json`);
    const compileGatePath = path.join(reviewsRoot, `${parentTaskId}-compile-gate.json`);
    const preflight = readReviewArtifactJsonRecord(preflightPath);
    const compileGate = readReviewArtifactJsonRecord(compileGatePath);
    const snapshot = isPlainRecord(preflight?.profile_policy_snapshot)
        ? preflight.profile_policy_snapshot
        : null;
    const policy = isPlainRecord(snapshot?.review_follow_up_policy)
        ? snapshot.review_follow_up_policy
        : null;
    const mode = policy?.schema_version === 1
        && (policy.materialization_mode === 'per_finding' || policy.materialization_mode === 'grouped_by_parent')
        ? policy.materialization_mode
        : null;
    const snapshotHash = normalizeSha256(snapshot?.snapshot_hash);
    const compilePreflightSha256 = normalizeSha256(compileGate?.preflight_hash_sha256);
    const currentPreflightSha256 = fileExists(preflightPath)
        ? readReviewArtifactFileSha256(preflightPath)
        : null;
    const eventsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const timelineWindow = readTaskTimelineEventWindow(eventsRoot, parentTaskId);
    const latestCompileEvent = timelineWindow.invalidJson || timelineWindow.truncated
        ? null
        : [...timelineWindow.events].reverse().find((event) => (
            String(event.event_type || '').trim().toUpperCase() === 'COMPILE_GATE_PASSED'
            && String((event as unknown as Record<string, unknown>).outcome || '').trim().toUpperCase() === 'PASS'
        )) || null;
    const compileTimestamp = compileGate?.status === 'PASSED' && compileGate?.task_id === parentTaskId
        ? String(
            (latestCompileEvent as unknown as Record<string, unknown> | null)?.timestamp_utc || ''
        ).trim()
        : '';
    if (
        !mode
        || !snapshotHash
        || !compileTimestamp
        || !compilePreflightSha256
        || compilePreflightSha256 !== currentPreflightSha256
    ) {
        return null;
    }
    const cycleId = sha256JsonPayload({
        schema_version: 1,
        preflight_sha256: compilePreflightSha256,
        compile_gate_timestamp: compileTimestamp
    });
    return {
        mode,
        snapshotHash,
        cycleId,
        preflightPath,
        preflightSha256: compilePreflightSha256,
        compileTimestamp,
        groupFingerprint: mode === 'grouped_by_parent'
            ? sha256JsonPayload({
                schema_version: 1,
                parent_task_id: parentTaskId,
                snapshot_hash: snapshotHash,
                cycle_id: cycleId,
                materialization_mode: mode
            })
            : null
    };
}

function isParentFollowUpTaskId(parentTaskId: string, taskId: string): boolean {
    const prefix = `${parentTaskId}-F`;
    if (!taskId.startsWith(prefix)) {
        return false;
    }
    return /^[1-9][0-9]*$/u.test(taskId.slice(prefix.length));
}

export interface TaskQueueFollowUpFingerprintIndex {
    groupedByTask: Map<string, Map<string, GroupedReviewFollowUpLaneBinding>>;
    groupedFingerprintByTask: Map<string, string>;
    perFindingByTask: Map<string, string>;
}

export interface AuthenticatedReviewFollowUpScope {
    status: 'not_applicable' | 'valid' | 'invalid';
    files: string[];
    diagnostics: string[];
}

function resolveFollowUpArtifactPath(repoRoot: string, rawPath: unknown): string | null {
    const candidate = String(rawPath || '').trim();
    if (!candidate) {
        return null;
    }
    try {
        const resolved = resolvePathInsideRepo(candidate, repoRoot, {
            allowMissing: false,
            enforceInside: true
        });
        return resolved && isPathRealpathInsideRoot(resolved, repoRoot) && fileExists(resolved)
            ? resolved
            : null;
    } catch {
        return null;
    }
}

function readReviewArtifactJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        const value = readReviewArtifactJsonFile(filePath);
        return isPlainRecord(value) ? value : null;
    } catch {
        return null;
    }
}

interface AuthenticatedReviewReceiptSnapshot {
    receipt: Record<string, unknown>;
    receiptSnapshotPath: string;
    canonicalReceiptPath: string;
    receiptSha256: string;
    reviewArtifactPath: string;
    reviewArtifactSha256: string;
    reviewContextPath: string;
    reviewContext: Record<string, unknown>;
}

function recordString(record: Record<string, unknown> | null, key: string): string | null {
    const value = record?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

interface SuccessfulCompileBoundary {
    timestamp: string;
    taskSequence: number;
    eventSequence: number | null;
}

function latestSuccessfulCompileBefore(
    events: readonly ReviewReuseTelemetryEventLike[],
    beforeTaskSequence: number
): SuccessfulCompileBoundary | null {
    const event = [...events].reverse().find((candidate) => {
        const candidateSequence = Number(
            isPlainRecord(candidate.integrity) ? candidate.integrity.task_sequence : null
        );
        return (
            Number.isInteger(beforeTaskSequence)
            && Number.isInteger(candidateSequence)
            && candidateSequence < beforeTaskSequence
            && String(candidate.event_type || '').trim().toUpperCase() === 'COMPILE_GATE_PASSED'
            && String(
                (candidate as unknown as Record<string, unknown>).outcome || ''
            ).trim().toUpperCase() === 'PASS'
        );
    });
    const eventRecord = event as unknown as Record<string, unknown> | undefined;
    const integrity = isPlainRecord(event?.integrity) ? event.integrity : null;
    const timestamp = String(eventRecord?.timestamp_utc || '').trim();
    const taskSequence = Number(integrity?.task_sequence);
    const eventSequence = Number(event?.sequence);
    return event && timestamp && Number.isInteger(taskSequence)
        ? {
            timestamp,
            taskSequence,
            eventSequence: Number.isInteger(eventSequence) ? eventSequence : null
        }
        : null;
}

function reviewInvocationMatchesReceiptProvenance(options: {
    events: readonly ReviewReuseTelemetryEventLike[];
    taskId: string;
    reviewType: string;
    reviewRecordedTaskSequence: number | null;
    fields: ReturnType<typeof normalizeReviewReceiptEvidenceFields>;
}): boolean {
    const provenance = options.fields.reviewerProvenance;
    if (!provenance || provenance.attestation_type !== 'reviewer_invocation_attestation') {
        return false;
    }
    return options.events.some((event) => {
        if (String(event.event_type || '').trim().toUpperCase() !== 'REVIEWER_INVOCATION_ATTESTED') {
            return false;
        }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
        const details = isPlainRecord(event.details) ? event.details : null;
        const taskSequence = Number(integrity?.task_sequence);
        const reviewTreeStateSha256 = normalizeSha256(
            details?.review_tree_state_sha256 ?? details?.reviewTreeStateSha256
        );
        return (
            Number.isInteger(taskSequence)
            && taskSequence === provenance.task_sequence
            && (options.reviewRecordedTaskSequence == null || taskSequence < options.reviewRecordedTaskSequence)
            && normalizeSha256(integrity?.event_sha256) === provenance.event_sha256
            && (integrity?.prev_event_sha256 == null
                ? null
                : normalizeSha256(integrity.prev_event_sha256)) === provenance.prev_event_sha256
            && String(details?.task_id ?? details?.taskId ?? '').trim() === options.taskId
            && String(details?.review_type ?? details?.reviewType ?? '').trim().toLowerCase() === options.reviewType
            && String(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode ?? '').trim()
                === options.fields.reviewerExecutionMode
            && String(
                details?.reviewer_identity
                    ?? details?.reviewerIdentity
                    ?? details?.reviewer_session_id
                    ?? details?.reviewerSessionId
                    ?? ''
            ).trim() === options.fields.reviewerIdentity
            && normalizeSha256(details?.review_context_sha256 ?? details?.reviewContextSha256)
                === provenance.review_context_sha256
            && (!options.fields.reviewTreeStateSha256
                || reviewTreeStateSha256 === options.fields.reviewTreeStateSha256)
            && normalizeSha256(details?.routing_event_sha256 ?? details?.routingEventSha256)
                === provenance.routing_event_sha256
        );
    });
}

function resolveAuthenticatedReviewReceiptSnapshot(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    followUpArtifact: Record<string, unknown>;
    currentMaterializationBinding: CurrentReviewFollowUpMaterializationBinding;
}): { evidence: AuthenticatedReviewReceiptSnapshot | null; diagnostics: string[] } {
    const sourceReceipt = isPlainRecord(options.followUpArtifact.source_receipt)
        ? options.followUpArtifact.source_receipt
        : null;
    const canonicalReceiptPath = resolveFollowUpArtifactPath(options.repoRoot, sourceReceipt?.receipt_path);
    const receiptSha256 = normalizeSha256(sourceReceipt?.receipt_sha256);
    if (!canonicalReceiptPath || !receiptSha256) {
        return {
            evidence: null,
            diagnostics: [`Grouped ${options.reviewType} follow-up source receipt binding is missing or unsafe.`]
        };
    }
    const eventsRoot = joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events'));
    return withNextStepReviewEvidenceSnapshot(eventsRoot, options.taskId, () => {
        const timelinePath = path.join(eventsRoot, `${options.taskId}.jsonl`);
        const integrity = inspectTaskEventFile(timelinePath, options.taskId);
        if (integrity.violations.length > 0 || !['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(integrity.status)) {
            return {
                evidence: null,
                diagnostics: [
                    `Grouped ${options.reviewType} follow-up parent timeline integrity is invalid: ` +
                    `${integrity.violations.join(' ') || integrity.status}.`
                ]
            };
        }
        const window = readTaskTimelineEventWindow(eventsRoot, options.taskId);
        if (window.invalidJson || window.truncated) {
            return {
                evidence: null,
                diagnostics: [
                    `Grouped ${options.reviewType} follow-up parent review timeline is incomplete or malformed.`
                ]
            };
        }
        const candidates = [...window.events].reverse().filter((event) => {
            if (String(event.event_type || '').trim().toUpperCase() !== 'REVIEW_RECORDED') {
                return false;
            }
            const details = isPlainRecord(event.details) ? event.details : null;
            const eventReceiptPath = resolveFollowUpArtifactPath(
                options.repoRoot,
                details?.receipt_path ?? details?.receiptPath
            );
            return (
                String((event as unknown as Record<string, unknown>).outcome || '').trim().toUpperCase() === 'PASS'
                && String(details?.task_id ?? details?.taskId ?? '').trim() === options.taskId
                && String(details?.review_type ?? details?.reviewType ?? '').trim().toLowerCase()
                    === options.reviewType
                && Boolean(eventReceiptPath)
                && path.resolve(eventReceiptPath as string) === path.resolve(canonicalReceiptPath)
                && normalizeSha256(details?.receipt_sha256 ?? details?.receiptSha256) === receiptSha256
            );
        });
        const diagnostics: string[] = [];
        for (const event of candidates) {
            const details = isPlainRecord(event.details) ? event.details : null;
            if (!details) {
                continue;
            }
            const reviewRecordedSequence = Number(
                isPlainRecord(event.integrity) ? event.integrity.task_sequence : null
            );
            const currentCompileBoundary = latestSuccessfulCompileBefore(window.events, reviewRecordedSequence);
            if (currentCompileBoundary?.timestamp !== options.currentMaterializationBinding.compileTimestamp) {
                diagnostics.push(
                    `Grouped ${options.reviewType} follow-up REVIEW_RECORDED evidence is not bound to the current compile cycle.`
                );
                continue;
            }
            const receiptSnapshotPath = resolveFollowUpArtifactPath(
                options.repoRoot,
                details.receipt_snapshot_path ?? details.receiptSnapshotPath
            );
            const receiptSnapshotSha256 = normalizeSha256(
                details.receipt_snapshot_sha256 ?? details.receiptSnapshotSha256
            );
            const reviewArtifactSnapshotPath = resolveFollowUpArtifactPath(
                options.repoRoot,
                details.review_artifact_snapshot_path ?? details.reviewArtifactSnapshotPath
            );
            const reviewArtifactSnapshotSha256 = normalizeSha256(
                details.review_artifact_snapshot_sha256 ?? details.reviewArtifactSnapshotSha256
            );
            const reviewArtifactPath = resolveFollowUpArtifactPath(
                options.repoRoot,
                details.review_artifact_path ?? details.reviewArtifactPath
            );
            const reviewContextPath = resolveFollowUpArtifactPath(
                options.repoRoot,
                details.review_context_path ?? details.reviewContextPath
            );
            if (
                !receiptSnapshotPath
                || !receiptSnapshotSha256
                || readReviewArtifactFileSha256(receiptSnapshotPath) !== receiptSnapshotSha256
                || !reviewArtifactSnapshotPath
                || !reviewArtifactSnapshotSha256
                || readReviewArtifactFileSha256(reviewArtifactSnapshotPath) !== reviewArtifactSnapshotSha256
                || !reviewArtifactPath
                || readReviewArtifactFileSha256(reviewArtifactPath) !== reviewArtifactSnapshotSha256
                || !reviewContextPath
            ) {
                diagnostics.push(
                    `Grouped ${options.reviewType} follow-up REVIEW_RECORDED snapshot paths or hashes are missing, unsafe, or inconsistent.`
                );
                continue;
            }
            if (receiptSnapshotSha256 !== receiptSha256) {
                diagnostics.push(`Grouped ${options.reviewType} follow-up receipt snapshot hash does not match its source binding.`);
                continue;
            }
            const receipt = readReviewArtifactJsonRecord(receiptSnapshotPath);
            if (!receipt) {
                diagnostics.push(`Grouped ${options.reviewType} follow-up receipt snapshot is unreadable.`);
                continue;
            }
            const fields = normalizeReviewReceiptEvidenceFields(receipt);
            if (normalizeSha256(receipt.preflight_sha256)
                !== options.currentMaterializationBinding.preflightSha256) {
                diagnostics.push(
                    `Grouped ${options.reviewType} follow-up receipt preflight binding is stale.`
                );
                continue;
            }
            const eventMatch = validateHistoricalReviewRecordedTelemetryEventMatch({
                event,
                repoRoot: options.repoRoot,
                taskId: options.taskId,
                reviewType: options.reviewType,
                receiptPath: canonicalReceiptPath,
                receiptSha256,
                reviewContextSha256: fields.reviewContextSha256,
                reviewArtifactSha256: fields.reviewArtifactSha256,
                reviewerExecutionMode: fields.reviewerExecutionMode,
                reviewerIdentity: fields.reviewerIdentity,
                reviewerProvenance: fields.reviewerProvenance as unknown as Record<string, unknown> | null,
                verifyReceiptSnapshot: false
            });
            if (!eventMatch.matched) {
                diagnostics.push(
                    `Grouped ${options.reviewType} follow-up REVIEW_RECORDED evidence is invalid: ` +
                    `${eventMatch.reason || 'unknown mismatch'}.`
                );
                continue;
            }
            const reviewContext = readReviewArtifactJsonRecord(reviewContextPath);
            const reviewContextSha256 = reviewContext
                ? readReviewArtifactFileSha256(reviewContextPath)
                : null;
            const treeState = isPlainRecord(reviewContext?.tree_state) ? reviewContext.tree_state : null;
            const reviewerRouting = isPlainRecord(reviewContext?.reviewer_routing)
                ? reviewContext.reviewer_routing
                : null;
            if (!reviewContext) {
                diagnostics.push(
                    `Grouped ${options.reviewType} follow-up receipt contract is invalid: ` +
                    'review context is unavailable.'
                );
                continue;
            }
            const contextPreflightPath = normalizePath(recordString(reviewContext, 'preflight_path') || '');
            const contextPreflightSha256 = normalizeSha256(reviewContext.preflight_sha256);
            const fullSuiteValidation = isPlainRecord(reviewContext.full_suite_validation)
                ? reviewContext.full_suite_validation
                : null;
            const cycleBinding = isPlainRecord(fullSuiteValidation?.cycle_binding)
                ? fullSuiteValidation.cycle_binding
                : null;
            const contextCompileTimestamp = recordString(fullSuiteValidation, 'compile_gate_timestamp_utc')
                || recordString(cycleBinding, 'compile_gate_timestamp');
            if (
                contextPreflightPath !== normalizePath(options.currentMaterializationBinding.preflightPath)
                || contextPreflightSha256 !== options.currentMaterializationBinding.preflightSha256
                || (contextCompileTimestamp !== null
                    && contextCompileTimestamp !== options.currentMaterializationBinding.compileTimestamp)
                || (cycleBinding !== null && (
                    normalizeSha256(cycleBinding.preflight_sha256)
                        !== options.currentMaterializationBinding.preflightSha256
                    || recordString(cycleBinding, 'compile_gate_timestamp')
                        !== options.currentMaterializationBinding.compileTimestamp
                ))
            ) {
                diagnostics.push(
                    `Grouped ${options.reviewType} follow-up review context does not match the current preflight and compile cycle.`
                );
                continue;
            }
            const receiptContract = validateReviewReceiptEvidenceContract({
                taskId: options.taskId,
                reviewType: options.reviewType,
                receipt,
                artifactSha256: reviewArtifactSnapshotSha256,
                contextSha256: reviewContextSha256,
                contextReviewTreeStateSha256: normalizeSha256(treeState?.tree_state_sha256),
                contextExecutionMode: recordString(reviewerRouting, 'actual_execution_mode'),
                contextReviewerIdentity: recordString(reviewerRouting, 'reviewer_session_id'),
                reviewContext
            });
            if (receiptContract.violations.length > 0) {
                diagnostics.push(
                    `Grouped ${options.reviewType} follow-up receipt contract is invalid: ` +
                    `${receiptContract.violations.join(' ')}.`
                );
                continue;
            }
            const reviewerProvenance = receiptContract.fields.reviewerProvenance;
            if (
                receiptContract.fields.reusedExistingReview !== true
                && (
                    !reviewerProvenance
                    || latestSuccessfulCompileBefore(
                        window.events,
                        reviewerProvenance.task_sequence
                    )?.timestamp !== options.currentMaterializationBinding.compileTimestamp
                )
            ) {
                diagnostics.push(
                    `Grouped ${options.reviewType} follow-up reviewer invocation is not bound to the current compile cycle.`
                );
                continue;
            }
            if (receiptContract.fields.reusedExistingReview === true) {
                const strictReuseValidation = validateStrictReusedReviewEvidence({
                    repoRoot: options.repoRoot,
                    taskId: options.taskId,
                    reviewType: options.reviewType,
                    events: window.events,
                    receiptPath: canonicalReceiptPath,
                    receiptSha256,
                    reviewContextSha256: receiptContract.fields.reviewContextSha256,
                    reviewContextReuseSha256: receiptContract.fields.reviewContextReuseSha256,
                    reviewTreeStateSha256: receiptContract.fields.reviewTreeStateSha256,
                    reviewScopeSha256: receiptContract.fields.reviewScopeSha256,
                    codeScopeSha256: receiptContract.fields.codeScopeSha256,
                    reviewArtifactSha256: reviewArtifactSnapshotSha256,
                    reusedFromReceiptPath: receiptContract.fields.reusedFromReceiptPath,
                    reusedFromReceiptSha256: receiptContract.fields.reusedFromReceiptSha256,
                    reusedFromReviewContextSha256: receiptContract.fields.reusedFromReviewContextSha256,
                    reusedFromReviewContextReuseSha256:
                        receiptContract.fields.reusedFromReviewContextReuseSha256,
                    reusedFromReviewTreeStateSha256: receiptContract.fields.reusedFromReviewTreeStateSha256,
                    reusedFromReviewScopeSha256: receiptContract.fields.reusedFromReviewScopeSha256,
                    reusedFromCodeScopeSha256: receiptContract.fields.reusedFromCodeScopeSha256,
                    reviewerExecutionMode: receiptContract.fields.reviewerExecutionMode,
                    reviewerIdentity: receiptContract.fields.reviewerIdentity,
                    reviewerProvenance: reviewerProvenance as unknown as Record<string, unknown> | null,
                    latestCompileTaskSequence: currentCompileBoundary?.taskSequence ?? null,
                    latestCompileEventSequence: currentCompileBoundary?.eventSequence ?? null
                });
                if (!strictReuseValidation.valid) {
                    diagnostics.push(
                        `Grouped ${options.reviewType} follow-up reused receipt evidence is invalid: `
                        + `${strictReuseValidation.reason}.`
                    );
                    continue;
                }
            }
            const eventIntegrity = isPlainRecord(event.integrity) ? event.integrity : null;
            if (!reviewInvocationMatchesReceiptProvenance({
                events: window.events,
                taskId: options.taskId,
                reviewType: options.reviewType,
                reviewRecordedTaskSequence: Number.isInteger(eventIntegrity?.task_sequence)
                    ? Number(eventIntegrity?.task_sequence)
                    : null,
                fields: receiptContract.fields
            })) {
                diagnostics.push(
                    `Grouped ${options.reviewType} follow-up receipt provenance does not match ` +
                    'REVIEWER_INVOCATION_ATTESTED telemetry.'
                );
                continue;
            }
            return {
                evidence: {
                    receipt,
                    receiptSnapshotPath,
                    canonicalReceiptPath,
                    receiptSha256,
                    reviewArtifactPath,
                    reviewArtifactSha256: reviewArtifactSnapshotSha256,
                    reviewContextPath,
                    reviewContext
                },
                diagnostics: []
            };
        }
        return {
            evidence: null,
            diagnostics: diagnostics.filter(Boolean).length > 0
                ? diagnostics.filter(Boolean)
                : [`Grouped ${options.reviewType} follow-up has no authenticated REVIEW_RECORDED receipt snapshot.`]
        };
    });
}

function evidenceLocationToScopeFile(repoRoot: string, location: unknown): string | null {
    const normalizedLocation = normalizePath(String(location || '').trim());
    const candidate = normalizedLocation.replace(/:\d+(?::\d+)?$/u, '');
    if (!candidate) {
        return null;
    }
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedPath = path.isAbsolute(candidate)
        ? path.resolve(candidate)
        : path.resolve(resolvedRoot, candidate);
    const relativePath = normalizePath(path.relative(resolvedRoot, resolvedPath));
    if (
        !relativePath
        || relativePath === '.'
        || path.isAbsolute(relativePath)
        || relativePath.split('/').includes('..')
        || !isPathRealpathInsideRoot(resolvedPath, resolvedRoot, { allowMissing: true })
    ) {
        return null;
    }
    return relativePath;
}

function collectValidatedFollowUpEvidenceLocations(
    validationArtifact: ReviewFindingsValidationArtifact,
    followUpItems: readonly Record<string, unknown>[]
): { locations: string[]; missingItemKeys: string[] } {
    const inventory = validationArtifact.validation_result.normalized_inventory;
    const evidenceByItem = new Map<string, readonly string[]>();
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        for (const finding of inventory.findings_by_severity[severity]) {
            evidenceByItem.set(`finding\u0000${finding.id}`, finding.evidence_locations);
        }
    }
    for (const residualRisk of inventory.residual_risks) {
        evidenceByItem.set(`residual_risk\u0000${residualRisk.id}`, residualRisk.evidence_locations);
    }
    const locations: string[] = [];
    const missingItemKeys: string[] = [];
    for (const item of followUpItems) {
        const kind = String(item.source_item_kind || '').trim();
        const id = String(item.source_item_id || '').trim();
        const key = `${kind}\u0000${id}`;
        const itemLocations = evidenceByItem.get(key);
        if (!itemLocations) {
            missingItemKeys.push(`${kind}:${id}`);
            continue;
        }
        locations.push(...itemLocations);
    }
    return {
        locations: [...new Set(locations)].sort(),
        missingItemKeys
    };
}

function extractParentFollowUpArtifactPaths(notes: string, childTaskId: string): string[] {
    const artifactPaths = new Set<string>();
    const matcher = /Review follow-up tasks materialized:\s*([^;\r\n]+);\s*artifact\s+`([^`\r\n]+)`\./giu;
    for (const match of String(notes || '').matchAll(matcher)) {
        const childIds = [...match[1].matchAll(/`([^`\r\n]+)`/gu)].map((item) => item[1].trim());
        if (childIds.includes(childTaskId)) {
            artifactPaths.add(normalizePath(match[2]));
        }
    }
    return [...artifactPaths].sort();
}

function discoverCurrentGroupedFollowUpArtifactPaths(options: {
    repoRoot: string;
    reviewsRoot: string;
    parentTaskId: string;
    childTaskId: string;
    currentMaterializationBinding: CurrentReviewFollowUpMaterializationBinding;
}): { paths: string[]; diagnostics: string[] } {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(options.reviewsRoot, { withFileTypes: true });
    } catch (error) {
        return {
            paths: [],
            diagnostics: [
                `Grouped follow-up artifact discovery failed: ${error instanceof Error ? error.message : String(error)}`
            ]
        };
    }
    const prefix = `${options.parentTaskId}-`;
    const candidates = entries.filter((entry) => (
        entry.isFile()
        && entry.name.startsWith(prefix)
        && entry.name.endsWith('-findings-follow-ups.json')
    ));
    if (candidates.length > 128) {
        return {
            paths: [],
            diagnostics: [`Grouped follow-up artifact discovery exceeded the bounded 128-candidate limit.`]
        };
    }
    const paths: string[] = [];
    for (const candidate of candidates) {
        const artifactPath = resolveFollowUpArtifactPath(
            options.repoRoot,
            path.join(options.reviewsRoot, candidate.name)
        );
        const artifact = artifactPath ? readReviewArtifactJsonRecord(artifactPath) : null;
        const materializationPolicy = isPlainRecord(artifact?.materialization_policy)
            ? artifact.materialization_policy
            : null;
        const items = Array.isArray(artifact?.items) ? artifact.items : [];
        const bindsChild = items.some((item) => (
            isPlainRecord(item)
            && item.action === 'create_follow_up'
            && item.task_id === options.childTaskId
        ));
        if (
            artifactPath
            && artifact?.task_id === options.parentTaskId
            && materializationPolicy?.mode === 'grouped_by_parent'
            && normalizeSha256(materializationPolicy.snapshot_hash)
                === options.currentMaterializationBinding.snapshotHash
            && normalizeSha256(materializationPolicy.cycle_id)
                === options.currentMaterializationBinding.cycleId
            && normalizeSha256(materializationPolicy.group_fingerprint)
                === options.currentMaterializationBinding.groupFingerprint
            && bindsChild
        ) {
            paths.push(path.resolve(artifactPath));
        }
    }
    return { paths: [...new Set(paths)].sort(), diagnostics: [] };
}

function resolveAuthenticatedReviewFollowUpArtifactScope(options: {
    repoRoot: string;
    taskQueueEntries: ReadonlyMap<string, TaskQueueEntry>;
    taskQueueIndex: TaskQueueFollowUpFingerprintIndex;
    parentTaskId: string;
    childTaskId: string;
    reviewType: string;
    followUpArtifactPath: string;
    expectedFollowUpCount: number;
    materializationMode: ReviewFollowUpMaterializationMode;
    currentMaterializationBinding: CurrentReviewFollowUpMaterializationBinding;
}): { files: string[]; diagnostics: string[] } {
    const modeLabel = options.materializationMode === 'grouped_by_parent' ? 'Grouped' : 'Per-finding';
    const followUpArtifact = readReviewArtifactJsonRecord(options.followUpArtifactPath);
    if (!followUpArtifact) {
        return {
            files: [],
            diagnostics: [`${modeLabel} ${options.reviewType} follow-up provenance is incomplete or unreadable.`]
        };
    }
    const materializationPolicy = isPlainRecord(followUpArtifact.materialization_policy)
        ? followUpArtifact.materialization_policy
        : null;
    const artifactMode = materializationPolicy?.mode;
    const artifactSnapshotHash = normalizeSha256(materializationPolicy?.snapshot_hash);
    const artifactCycleId = normalizeSha256(materializationPolicy?.cycle_id);
    const artifactGroupFingerprint = normalizeSha256(materializationPolicy?.group_fingerprint);
    if (
        artifactMode !== options.materializationMode
        || artifactMode !== options.currentMaterializationBinding.mode
        || artifactSnapshotHash !== options.currentMaterializationBinding.snapshotHash
        || artifactCycleId !== options.currentMaterializationBinding.cycleId
        || artifactGroupFingerprint !== options.currentMaterializationBinding.groupFingerprint
    ) {
        return {
            files: [],
            diagnostics: [
                `${modeLabel} ${options.reviewType} follow-up materialization policy does not match the current parent snapshot and cycle.`
            ]
        };
    }
    const receiptResolution = resolveAuthenticatedReviewReceiptSnapshot({
        repoRoot: options.repoRoot,
        taskId: options.parentTaskId,
        reviewType: options.reviewType,
        followUpArtifact,
        currentMaterializationBinding: options.currentMaterializationBinding
    });
    if (!receiptResolution.evidence) {
        return { files: [], diagnostics: receiptResolution.diagnostics };
    }
    const receiptEvidence = receiptResolution.evidence;
    const sourceValidation = isPlainRecord(followUpArtifact.source_validation)
        ? followUpArtifact.source_validation
        : null;
    const receiptFields = normalizeReviewReceiptEvidenceFields(receiptEvidence.receipt);
    const validation = validateReviewFindingsValidationArtifactForReceipt({
        receipt: receiptEvidence.receipt,
        reviewArtifactPath: receiptEvidence.reviewArtifactPath,
        expectedTaskId: options.parentTaskId,
        expectedReviewType: options.reviewType,
        expectedReviewOutputSha256: recordString(receiptEvidence.receipt, 'review_output_sha256'),
        expectedReviewArtifactSha256: receiptEvidence.reviewArtifactSha256,
        expectedReviewContextPath: receiptFields.reusedExistingReview ? null : receiptEvidence.reviewContextPath,
        expectedReviewContextSha256: receiptFields.reusedExistingReview
            ? receiptFields.reusedFromReviewContextSha256
            : readReviewArtifactFileSha256(receiptEvidence.reviewContextPath),
        expectedPreflightPath: options.currentMaterializationBinding.preflightPath,
        expectedPreflightSha256: options.currentMaterializationBinding.preflightSha256,
        expectedReviewTreeStateSha256: receiptFields.reusedExistingReview
            ? receiptFields.reusedFromReviewTreeStateSha256
            : receiptFields.reviewTreeStateSha256,
        expectedReviewContext: receiptEvidence.reviewContext,
        requireAccepted: true,
        preferSnapshot: true
    });
    if (!validation.valid || !validation.artifact || !validation.reference || !validation.artifact_sha256) {
        return { files: [], diagnostics: validation.violations };
    }
    if (
        normalizePath(sourceValidation?.artifact_path) !== normalizePath(validation.reference.artifact_path)
        || normalizeSha256(sourceValidation?.artifact_sha256) !== validation.reference.artifact_sha256
        || normalizeSha256(sourceValidation?.validation_result_sha256) !== validation.reference.validation_result_sha256
        || sourceValidation?.status !== 'accepted'
        || sourceValidation?.accepted !== true
    ) {
        return {
            files: [],
            diagnostics: [`${modeLabel} ${options.reviewType} follow-up validation source binding is stale or inconsistent.`]
        };
    }
    const dispositionEvidence = validateReviewFindingsDispositionEvidence({
        repoRoot: options.repoRoot,
        receipt: receiptEvidence.receipt,
        receiptPath: receiptEvidence.receiptSnapshotPath,
        reviewArtifactPath: receiptEvidence.reviewArtifactPath,
        expectedTaskId: options.parentTaskId,
        expectedReviewType: options.reviewType,
        validationArtifact: validation.artifact,
        validationArtifactPath: validation.reference.artifact_path,
        validationArtifactSha256: validation.artifact_sha256,
        policyResolution: resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence(receiptEvidence.receipt),
        expectedReceiptPath: receiptEvidence.canonicalReceiptPath,
        expectedReceiptSha256: receiptEvidence.receiptSha256,
        preferSnapshot: true,
        taskQueueRows: [...options.taskQueueEntries.values()].map((row) => ({
            taskId: row.taskId,
            notes: row.notes
        }))
    });
    if (
        !dispositionEvidence.valid
        || !dispositionEvidence.artifact
        || !dispositionEvidence.artifact_sha256
        || !dispositionEvidence.follow_up_artifact_path
        || path.resolve(dispositionEvidence.follow_up_artifact_path) !== path.resolve(options.followUpArtifactPath)
    ) {
        return {
            files: [],
            diagnostics: [
                ...dispositionEvidence.violations,
                ...(dispositionEvidence.follow_up_artifact_path
                    && path.resolve(dispositionEvidence.follow_up_artifact_path) !== path.resolve(options.followUpArtifactPath)
                    ? [`${modeLabel} ${options.reviewType} follow-up path does not match receipt-bound disposition evidence.`]
                    : [])
            ]
        };
    }
    if (!followUpArtifactMatchesCurrentTaskQueue({
        artifact: followUpArtifact,
        dispositionArtifact: dispositionEvidence.artifact as unknown as Record<string, unknown>,
        dispositionArtifactSha256: dispositionEvidence.artifact_sha256,
        repoRoot: options.repoRoot,
        taskId: options.parentTaskId,
        reviewType: options.reviewType,
        expectedFollowUpCount: options.expectedFollowUpCount,
        materializationMode: options.materializationMode,
        followUpArtifactPath: options.followUpArtifactPath,
        taskQueueFollowUpFingerprintIndex: options.taskQueueIndex
    })) {
        return {
            files: [],
            diagnostics: [`${modeLabel} ${options.reviewType} follow-up artifact does not match its current TASK.md binding.`]
        };
    }
    const followUpItems = Array.isArray(followUpArtifact.items)
        ? followUpArtifact.items.filter((item): item is Record<string, unknown> => (
            isPlainRecord(item)
            && item.action === 'create_follow_up'
            && item.task_id === options.childTaskId
        ))
        : [];
    if (followUpItems.length === 0) {
        return {
            files: [],
            diagnostics: [`${modeLabel} ${options.reviewType} follow-up artifact does not bind the current child task.`]
        };
    }
    const evidence = collectValidatedFollowUpEvidenceLocations(validation.artifact, followUpItems);
    if (evidence.missingItemKeys.length > 0) {
        return {
            files: [],
            diagnostics: [
                `${modeLabel} ${options.reviewType} follow-up items are absent from authenticated validation inventory: ` +
                evidence.missingItemKeys.join(', ')
            ]
        };
    }
    const diagnostics: string[] = [];
    const files: string[] = [];
    for (const location of evidence.locations) {
        const scopeFile = evidenceLocationToScopeFile(options.repoRoot, location);
        if (!scopeFile) {
            diagnostics.push(`${modeLabel} ${options.reviewType} follow-up evidence location is unsafe: ${location}`);
        } else {
            files.push(scopeFile);
        }
    }
    return { files: [...new Set(files)].sort(), diagnostics };
}

function resolveAuthenticatedGroupedReviewFollowUpScopeUnlocked(
    repoRoot: string,
    taskEntry: TaskQueueEntry | null
): AuthenticatedReviewFollowUpScope {
    const taskId = String(taskEntry?.taskId || '').trim();
    const parentTaskId = taskId.replace(/-F[1-9][0-9]*$/u, '');
    if (!taskId || parentTaskId === taskId) {
        return { status: 'not_applicable', files: [], diagnostics: [] };
    }
    const taskQueueEntries = readTaskQueueEntries(repoRoot);
    const taskQueueIndex = buildTaskQueueFollowUpFingerprintIndex(taskQueueEntries, parentTaskId);
    if (!taskQueueIndex) {
        return { status: 'invalid', files: [], diagnostics: ['TASK.md follow-up index is unavailable.'] };
    }
    const laneBindings = taskQueueIndex.groupedByTask.get(taskId);
    const groupedFingerprint = taskQueueIndex.groupedFingerprintByTask.get(taskId);
    const perFindingFingerprint = taskQueueIndex.perFindingByTask.get(taskId);
    const parentLinkedArtifactPaths = extractParentFollowUpArtifactPaths(
        taskQueueEntries.get(parentTaskId)?.notes || '',
        taskId
    );
    const childClaimsReviewFollowUp = /(?:^|\s)review_follow_up_/iu.test(taskEntry?.notes || '');
    if (
        !perFindingFingerprint
        && !groupedFingerprint
        && (!laneBindings || laneBindings.size === 0)
        && !childClaimsReviewFollowUp
        && parentLinkedArtifactPaths.length === 0
    ) {
        return { status: 'not_applicable', files: [], diagnostics: [] };
    }
    if (perFindingFingerprint && (groupedFingerprint || (laneBindings && laneBindings.size > 0))) {
        return {
            status: 'invalid',
            files: [],
            diagnostics: [`Review follow-up task '${taskId}' has ambiguous grouped and per-finding provenance.`]
        };
    }

    if (perFindingFingerprint) {
        const artifactPaths = parentLinkedArtifactPaths;
        if (artifactPaths.length !== 1) {
            return {
                status: 'invalid',
                files: [],
                diagnostics: [
                    `Per-finding review follow-up task '${taskId}' must resolve exactly one parent-bound materialization artifact; ` +
                    `found ${artifactPaths.length}.`
                ]
            };
        }
        const followUpArtifactPath = resolveFollowUpArtifactPath(repoRoot, artifactPaths[0]);
        const followUpArtifact = followUpArtifactPath ? readReviewArtifactJsonRecord(followUpArtifactPath) : null;
        const materializationPolicy = isPlainRecord(followUpArtifact?.materialization_policy)
            ? followUpArtifact.materialization_policy
            : null;
        const summary = isPlainRecord(followUpArtifact?.summary) ? followUpArtifact.summary : null;
        const reviewType = recordString(followUpArtifact, 'review_type');
        const expectedFollowUpCount = typeof summary?.follow_up_obligation_count === 'number'
            && Number.isSafeInteger(summary.follow_up_obligation_count)
            && summary.follow_up_obligation_count > 0
            ? summary.follow_up_obligation_count
            : null;
        if (
            !followUpArtifactPath
            || !followUpArtifact
            || materializationPolicy?.mode !== 'per_finding'
            || !reviewType
            || expectedFollowUpCount === null
        ) {
            return {
                status: 'invalid',
                files: [],
                diagnostics: [`Per-finding review follow-up task '${taskId}' has incomplete materialization provenance.`]
            };
        }
        const currentMaterializationBinding = resolveCurrentReviewFollowUpMaterializationBinding(
            repoRoot,
            path.dirname(followUpArtifactPath),
            parentTaskId
        );
        if (!currentMaterializationBinding || currentMaterializationBinding.mode !== 'per_finding') {
            return {
                status: 'invalid',
                files: [],
                diagnostics: [
                    `Per-finding review follow-up task '${taskId}' does not match the current parent materialization mode and cycle.`
                ]
            };
        }
        const resolved = resolveAuthenticatedReviewFollowUpArtifactScope({
            repoRoot,
            taskQueueEntries,
            taskQueueIndex,
            parentTaskId,
            childTaskId: taskId,
            reviewType,
            followUpArtifactPath,
            expectedFollowUpCount,
            materializationMode: 'per_finding',
            currentMaterializationBinding
        });
        if (resolved.diagnostics.length > 0 || resolved.files.length === 0) {
            return {
                status: 'invalid',
                files: [],
                diagnostics: resolved.diagnostics.length > 0
                    ? resolved.diagnostics
                    : ['Authenticated per-finding follow-up artifact contains no usable evidence scope.']
            };
        }
        return { status: 'valid', files: resolved.files, diagnostics: [] };
    }

    if (!laneBindings || laneBindings.size === 0) {
        return {
            status: 'invalid',
            files: [],
            diagnostics: [
                `Review follow-up task '${taskId}' is missing authenticated grouped lane bindings in TASK.md.`
            ]
        };
    }

    const groupedSnapshotHash = extractGroupedReviewFollowUpSnapshotHash(taskEntry?.notes || '');
    const groupedCycleId = extractGroupedReviewFollowUpCycleId(taskEntry?.notes || '');
    const recomputedGroupFingerprint = groupedSnapshotHash && groupedCycleId
        ? sha256JsonPayload({
            schema_version: 1,
            parent_task_id: parentTaskId,
            snapshot_hash: groupedSnapshotHash,
            cycle_id: groupedCycleId,
            materialization_mode: 'grouped_by_parent'
        })
        : null;
    if (
        !groupedFingerprint
        || !groupedSnapshotHash
        || !groupedCycleId
        || groupedFingerprint !== recomputedGroupFingerprint
    ) {
        return {
            status: 'invalid',
            files: [],
            diagnostics: [`Grouped review follow-up task '${taskId}' has an invalid snapshot, cycle, or group fingerprint binding.`]
        };
    }
    const parentArtifactPaths = parentLinkedArtifactPaths;
    const resolvedParentArtifactPaths = parentArtifactPaths
        .map((artifactPath) => resolveFollowUpArtifactPath(repoRoot, artifactPath))
        .filter((artifactPath): artifactPath is string => Boolean(artifactPath))
        .map((artifactPath) => path.resolve(artifactPath))
        .sort();
    const resolvedLaneArtifactPaths = [...laneBindings.values()]
        .map((binding) => resolveFollowUpArtifactPath(repoRoot, binding.artifactPath))
        .filter((artifactPath): artifactPath is string => Boolean(artifactPath))
        .map((artifactPath) => path.resolve(artifactPath))
        .sort();
    const firstLaneArtifactPath = resolvedLaneArtifactPaths[0] || null;
    const currentGroupedMaterializationBinding = firstLaneArtifactPath
        ? resolveCurrentReviewFollowUpMaterializationBinding(
            repoRoot,
            path.dirname(firstLaneArtifactPath),
            parentTaskId
        )
        : null;
    if (
        !currentGroupedMaterializationBinding
        || currentGroupedMaterializationBinding.mode !== 'grouped_by_parent'
        || currentGroupedMaterializationBinding.snapshotHash !== groupedSnapshotHash
        || currentGroupedMaterializationBinding.cycleId !== groupedCycleId
        || currentGroupedMaterializationBinding.groupFingerprint !== groupedFingerprint
    ) {
        return {
            status: 'invalid',
            files: [],
            diagnostics: [
                `Grouped review follow-up task '${taskId}' does not match the current parent materialization snapshot and cycle.`
            ]
        };
    }
    const discoveredArtifacts = discoverCurrentGroupedFollowUpArtifactPaths({
        repoRoot,
        reviewsRoot: path.dirname(firstLaneArtifactPath as string),
        parentTaskId,
        childTaskId: taskId,
        currentMaterializationBinding: currentGroupedMaterializationBinding
    });
    const expectedArtifactPaths = [...new Set([
        ...resolvedParentArtifactPaths,
        ...discoveredArtifacts.paths
    ])].sort();
    if (
        resolvedParentArtifactPaths.length !== parentArtifactPaths.length
        || resolvedLaneArtifactPaths.length !== laneBindings.size
        || discoveredArtifacts.diagnostics.length > 0
        || JSON.stringify(expectedArtifactPaths) !== JSON.stringify(resolvedLaneArtifactPaths)
    ) {
        return {
            status: 'invalid',
            files: [],
            diagnostics: [
                `Grouped review follow-up task '${taskId}' lane set does not match the complete current-cycle materialization registry.`,
                ...discoveredArtifacts.diagnostics
            ]
        };
    }

    const diagnostics: string[] = [];
    const scopeFiles: string[] = [];
    for (const [reviewType, binding] of [...laneBindings.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const followUpArtifactPath = resolveFollowUpArtifactPath(repoRoot, binding.artifactPath);
        if (!followUpArtifactPath) {
            diagnostics.push(`Grouped ${reviewType} follow-up artifact path is missing, unsafe, or unreadable.`);
            continue;
        }
        const currentMaterializationBinding = resolveCurrentReviewFollowUpMaterializationBinding(
            repoRoot,
            path.dirname(followUpArtifactPath),
            parentTaskId
        );
        if (
            !currentMaterializationBinding
            || currentMaterializationBinding.mode !== 'grouped_by_parent'
            || currentMaterializationBinding.snapshotHash !== groupedSnapshotHash
            || currentMaterializationBinding.cycleId !== groupedCycleId
            || currentMaterializationBinding.groupFingerprint !== groupedFingerprint
        ) {
            diagnostics.push(
                `Grouped ${reviewType} follow-up does not match the current parent materialization snapshot and cycle.`
            );
            continue;
        }
        const resolved = resolveAuthenticatedReviewFollowUpArtifactScope({
            repoRoot,
            taskQueueEntries,
            taskQueueIndex,
            parentTaskId,
            childTaskId: taskId,
            reviewType,
            followUpArtifactPath,
            expectedFollowUpCount: binding.itemCount,
            materializationMode: 'grouped_by_parent',
            currentMaterializationBinding
        });
        diagnostics.push(...resolved.diagnostics);
        scopeFiles.push(...resolved.files);
    }
    if (diagnostics.length > 0) {
        return { status: 'invalid', files: [], diagnostics };
    }
    const files = [...new Set(scopeFiles)].sort();
    if (files.length === 0) {
        return {
            status: 'invalid',
            files: [],
            diagnostics: ['Authenticated grouped follow-up artifacts contain no usable evidence scope.']
        };
    }
    return { status: 'valid', files, diagnostics: [] };
}

export function resolveAuthenticatedGroupedReviewFollowUpScope(
    repoRoot: string,
    taskEntry: TaskQueueEntry | null
): AuthenticatedReviewFollowUpScope {
    const taskId = String(taskEntry?.taskId || '').trim();
    const parentTaskId = taskId.replace(/-F[1-9][0-9]*$/u, '');
    const resolveWithinArtifactSnapshot = () => withReviewArtifactReadSnapshot(
        path.resolve(repoRoot),
        () => resolveAuthenticatedGroupedReviewFollowUpScopeUnlocked(repoRoot, taskEntry)
    );
    if (!taskId || parentTaskId === taskId) {
        return resolveWithinArtifactSnapshot();
    }
    const eventsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    return withNextStepReviewEvidenceSnapshot(eventsRoot, parentTaskId, resolveWithinArtifactSnapshot);
}

export function buildTaskQueueFollowUpFingerprintIndex(
    taskEntries: ReadonlyMap<string, TaskQueueEntry>,
    parentTaskId: string
): TaskQueueFollowUpFingerprintIndex | null {
    const groupedByTask = new Map<string, Map<string, GroupedReviewFollowUpLaneBinding>>();
    const groupedFingerprintByTask = new Map<string, string>();
    const perFindingByTask = new Map<string, string>();
    for (const row of taskEntries.values()) {
        if (!isParentFollowUpTaskId(parentTaskId, row.taskId)) {
            continue;
        }
        const notes = row.notes || '';
        const fingerprint = extractReviewFollowUpFingerprint(notes);
        if (fingerprint) {
            perFindingByTask.set(row.taskId, fingerprint);
        }
        const groupedBindings = extractGroupedReviewFollowUpLaneBindings(notes);
        if (groupedBindings.size > 0) {
            groupedByTask.set(row.taskId, groupedBindings);
        }
        const groupedFingerprint = extractGroupedReviewFollowUpFingerprint(notes);
        if (groupedFingerprint) {
            groupedFingerprintByTask.set(row.taskId, groupedFingerprint);
        }
    }
    return { groupedByTask, groupedFingerprintByTask, perFindingByTask };
}

function readTaskQueueFollowUpFingerprintIndex(
    repoRoot: string,
    parentTaskId: string
): TaskQueueFollowUpFingerprintIndex | null {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (!fileExists(taskPath)) {
        return null;
    }
    return buildTaskQueueFollowUpFingerprintIndex(readTaskQueueEntries(repoRoot), parentTaskId);
}

function taskQueueHasFollowUpFingerprint(
    taskQueueFollowUpFingerprints: ReadonlyMap<string, string>,
    parentTaskId: string,
    taskId: string,
    fingerprint: string
): boolean {
    return (
        isParentFollowUpTaskId(parentTaskId, taskId)
        && taskQueueFollowUpFingerprints.get(taskId) === fingerprint
    );
}

function taskQueueHasGroupedFollowUpBinding(
    taskQueueGroupedFollowUpBindings: ReadonlyMap<string, ReadonlyMap<string, GroupedReviewFollowUpLaneBinding>>,
    taskQueueGroupedFollowUpFingerprints: ReadonlyMap<string, string>,
    parentTaskId: string,
    taskId: string,
    groupFingerprint: string,
    reviewType: string,
    itemFingerprints: readonly string[],
    sourceBindingSha256: string,
    artifactPath: string
): boolean {
    const binding = taskQueueGroupedFollowUpBindings.get(taskId)?.get(reviewType.toLowerCase());
    return (
        isParentFollowUpTaskId(parentTaskId, taskId)
        && taskQueueGroupedFollowUpFingerprints.get(taskId) === groupFingerprint
        && binding?.itemCount === itemFingerprints.length
        && binding.itemFingerprintsSha256 === sha256JsonPayload([...itemFingerprints].sort())
        && binding.sourceBindingSha256 === sourceBindingSha256
        && binding.artifactPath === normalizePath(artifactPath)
    );
}

function buildGroupedReviewFollowUpSourceBindingSha256(
    artifact: Record<string, unknown>,
    reviewType: string
): string | null {
    const sourceDisposition = isPlainRecord(artifact.source_disposition) ? artifact.source_disposition : null;
    const sourceValidation = isPlainRecord(artifact.source_validation) ? artifact.source_validation : null;
    const sourceReceipt = isPlainRecord(artifact.source_receipt) ? artifact.source_receipt : null;
    const validationArtifactSha256 = normalizeSha256(sourceValidation?.artifact_sha256);
    const validationResultSha256 = normalizeSha256(sourceValidation?.validation_result_sha256);
    const receiptSha256 = normalizeSha256(sourceReceipt?.receipt_sha256);
    const dispositionArtifactSha256 = normalizeSha256(sourceDisposition?.artifact_sha256);
    const dispositionResultSha256 = normalizeSha256(sourceDisposition?.disposition_result_sha256);
    if (
        !validationArtifactSha256
        || !validationResultSha256
        || !receiptSha256
        || !dispositionArtifactSha256
        || !dispositionResultSha256
    ) {
        return null;
    }
    return sha256JsonPayload({
        schema_version: 1,
        review_type: reviewType,
        validation_artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationResultSha256,
        receipt_sha256: receiptSha256,
        disposition_artifact_sha256: dispositionArtifactSha256,
        disposition_result_sha256: dispositionResultSha256
    });
}

function dispositionFollowUpItemKey(item: Record<string, unknown>): string | null {
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const kind = typeof item.kind === 'string' ? item.kind.trim() : '';
    const severity = typeof item.severity === 'string' ? item.severity.trim() : '';
    const action = typeof item.action === 'string' ? item.action.trim() : '';
    const sourceRule = typeof item.source_rule === 'string' ? item.source_rule.trim() : '';
    if (!id || !kind || !severity || action !== 'create_follow_up' || !sourceRule) {
        return null;
    }
    return [id, kind, severity, action, sourceRule].join('\u0000');
}

function followUpArtifactItemKey(item: Record<string, unknown>): string | null {
    const id = typeof item.source_item_id === 'string' ? item.source_item_id.trim() : '';
    const kind = typeof item.source_item_kind === 'string' ? item.source_item_kind.trim() : '';
    const severity = typeof item.severity === 'string' ? item.severity.trim() : '';
    const action = typeof item.action === 'string' ? item.action.trim() : '';
    const sourceRule = typeof item.source_rule === 'string' ? item.source_rule.trim() : '';
    if (!id || !kind || !severity || action !== 'create_follow_up' || !sourceRule) {
        return null;
    }
    return [id, kind, severity, action, sourceRule].join('\u0000');
}

function buildDispositionFollowUpFingerprint(params: {
    taskId: string;
    reviewType: string;
    item: Record<string, unknown>;
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
}): string | null {
    const id = typeof params.item.id === 'string' ? params.item.id.trim() : '';
    const kind = typeof params.item.kind === 'string' ? params.item.kind.trim() : '';
    const severity = typeof params.item.severity === 'string' ? params.item.severity.trim() : '';
    const action = typeof params.item.action === 'string' ? params.item.action.trim() : '';
    const sourceRule = typeof params.item.source_rule === 'string' ? params.item.source_rule.trim() : '';
    if (!id || !kind || !severity || action !== 'create_follow_up' || !sourceRule) {
        return null;
    }
    return sha256JsonPayload({
        schema_version: 1,
        parent_task_id: params.taskId,
        review_type: params.reviewType,
        item_id: id,
        item_kind: kind,
        severity,
        action,
        source_rule: sourceRule,
        validation_artifact_sha256: params.validationArtifactSha256,
        validation_result_sha256: params.validationResultSha256,
        disposition_artifact_sha256: params.dispositionArtifactSha256,
        disposition_result_sha256: params.dispositionResultSha256
    });
}

function buildExpectedDispositionFollowUpFingerprintIndex(params: {
    dispositionArtifact: Record<string, unknown>;
    dispositionArtifactSha256: string;
    taskId: string;
    reviewType: string;
    expectedFollowUpCount: number;
}): Map<string, string> | null {
    if (params.dispositionArtifact.task_id !== params.taskId || params.dispositionArtifact.review_type !== params.reviewType) {
        return null;
    }
    const sourceValidation = isPlainRecord(params.dispositionArtifact.source_validation)
        ? params.dispositionArtifact.source_validation
        : null;
    const validationArtifactSha256 = normalizeSha256(sourceValidation?.artifact_sha256);
    const validationResultSha256 = normalizeSha256(sourceValidation?.validation_result_sha256);
    const dispositionResultSha256 = normalizeSha256(params.dispositionArtifact.disposition_result_sha256);
    if (!validationArtifactSha256 || !validationResultSha256 || !dispositionResultSha256) {
        return null;
    }
    const dispositionItems = Array.isArray(params.dispositionArtifact.items)
        ? params.dispositionArtifact.items.filter((item): item is Record<string, unknown> => (
            isPlainRecord(item) && item.action === 'create_follow_up'
        ))
        : [];
    if (dispositionItems.length !== params.expectedFollowUpCount) {
        return null;
    }
    const expected = new Map<string, string>();
    for (const item of dispositionItems) {
        const key = dispositionFollowUpItemKey(item);
        const fingerprint = buildDispositionFollowUpFingerprint({
            taskId: params.taskId,
            reviewType: params.reviewType,
            item,
            validationArtifactSha256,
            validationResultSha256,
            dispositionArtifactSha256: params.dispositionArtifactSha256,
            dispositionResultSha256
        });
        if (!key || !fingerprint || expected.has(key)) {
            return null;
        }
        expected.set(key, fingerprint);
    }
    return expected;
}

export function followUpArtifactMatchesCurrentTaskQueue(params: {
    artifact: Record<string, unknown>;
    dispositionArtifact: Record<string, unknown>;
    dispositionArtifactSha256: string;
    repoRoot?: string;
    taskId: string;
    reviewType: string;
    expectedFollowUpCount: number;
    materializationMode: ReviewFollowUpMaterializationMode;
    followUpArtifactPath: string;
    taskQueueFollowUpFingerprintIndex?: TaskQueueFollowUpFingerprintIndex | null;
}): boolean {
    if (!params.repoRoot) {
        return false;
    }
    if (params.artifact.task_id !== params.taskId || params.artifact.review_type !== params.reviewType) {
        return false;
    }
    if (Array.isArray(params.artifact.violations) && params.artifact.violations.length > 0) {
        return false;
    }
    const items = Array.isArray(params.artifact.items) ? params.artifact.items : [];
    const followUpItems = items.filter((item): item is Record<string, unknown> => (
        isPlainRecord(item) && item.action === 'create_follow_up'
    ));
    const summary = isPlainRecord(params.artifact.summary) ? params.artifact.summary : null;
    const materializationPolicy = isPlainRecord(params.artifact.materialization_policy)
        ? params.artifact.materialization_policy
        : null;
    if ((materializationPolicy?.mode || 'per_finding') !== params.materializationMode) {
        return false;
    }
    const summaryFollowUpCount = typeof summary?.follow_up_obligation_count === 'number'
        ? summary.follow_up_obligation_count
        : null;
    if (summaryFollowUpCount !== params.expectedFollowUpCount) {
        return false;
    }
    if (followUpItems.length === 0) {
        return params.expectedFollowUpCount === 0 && params.artifact.status === 'NOT_REQUIRED';
    }
    if (followUpItems.length !== params.expectedFollowUpCount) {
        return false;
    }
    const expectedFingerprints = buildExpectedDispositionFollowUpFingerprintIndex({
        dispositionArtifact: params.dispositionArtifact,
        dispositionArtifactSha256: params.dispositionArtifactSha256,
        taskId: params.taskId,
        reviewType: params.reviewType,
        expectedFollowUpCount: params.expectedFollowUpCount
    });
    if (!expectedFingerprints || expectedFingerprints.size !== params.expectedFollowUpCount) {
        return false;
    }
    const taskQueueFollowUpFingerprintIndex = params.taskQueueFollowUpFingerprintIndex
        ?? readTaskQueueFollowUpFingerprintIndex(params.repoRoot, params.taskId);
    if (!taskQueueFollowUpFingerprintIndex) {
        return false;
    }
    const sourceItemKeys = new Set<string>();
    const taskIds = new Set<string>();
    const fingerprints = new Set<string>();
    const itemsMatch = followUpItems.every((item) => {
        const taskId = typeof item.task_id === 'string' ? item.task_id.trim() : '';
        const fingerprint = normalizeSha256(item.fingerprint);
        const sourceItemKey = followUpArtifactItemKey(item);
        const expectedFingerprint = sourceItemKey ? expectedFingerprints.get(sourceItemKey) : null;
        const materializationStatus = typeof item.materialization_status === 'string'
            ? item.materialization_status
            : '';
        if (
            !taskId
            || !fingerprint
            || !sourceItemKey
            || sourceItemKeys.has(sourceItemKey)
            || (params.materializationMode === 'per_finding' && taskIds.has(taskId))
            || fingerprints.has(fingerprint)
        ) {
            return false;
        }
        sourceItemKeys.add(sourceItemKey);
        taskIds.add(taskId);
        fingerprints.add(fingerprint);
        return (
            ['created', 'already_materialized'].includes(materializationStatus)
            && fingerprint === expectedFingerprint
            && (params.materializationMode === 'grouped_by_parent'
                ? true
                : taskQueueHasFollowUpFingerprint(
                    taskQueueFollowUpFingerprintIndex.perFindingByTask,
                    params.taskId,
                    taskId,
                    fingerprint as string
                ))
        );
    });
    if (!itemsMatch || sourceItemKeys.size !== expectedFingerprints.size) {
        return false;
    }
    if (params.materializationMode !== 'grouped_by_parent') {
        return true;
    }
    const [groupedTaskId] = [...taskIds];
    const groupFingerprint = normalizeSha256(materializationPolicy?.group_fingerprint);
    const sourceBindingSha256 = buildGroupedReviewFollowUpSourceBindingSha256(params.artifact, params.reviewType);
    return (
        taskIds.size === 1
        && Boolean(groupedTaskId)
        && Boolean(groupFingerprint)
        && Boolean(sourceBindingSha256)
        && taskQueueHasGroupedFollowUpBinding(
            taskQueueFollowUpFingerprintIndex.groupedByTask,
            taskQueueFollowUpFingerprintIndex.groupedFingerprintByTask,
            params.taskId,
            groupedTaskId,
            groupFingerprint as string,
            params.reviewType,
            [...fingerprints],
            sourceBindingSha256 as string,
            normalizePath(path.relative(params.repoRoot, params.followUpArtifactPath))
        )
    );
}

export function readReviewArtifactState(
    reviewsRoot: string,
    taskId: string,
    reviewType: string,
    preflightPath: string,
    preflightSha256: string | null,
    preflightPayload: Record<string, unknown> | null,
    repoRoot?: string,
    taskQueueFollowUpFingerprintIndex?: TaskQueueFollowUpFingerprintIndex | null
): ReviewArtifactState {
    const contextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const passToken = REVIEW_VERDICT_PASS_TOKENS[reviewType] || '';
    const failToken = REVIEW_VERDICT_FAIL_TOKENS[reviewType] || '';
    const violations: string[] = [];
    let contextPreflightBindingViolationIndex: number | null = null;
    const contextExists = fileExists(contextPath);
    let contextCurrent = false;
    const artifactExists = fileExists(artifactPath);
    const receiptExists = fileExists(receiptPath);
    let context: Record<string, unknown> | null = null;
    let receipt: Record<string, unknown> | null = null;
    let receiptCurrent = false;
    let receiptContractCurrent = false;
    let reviewerIdentity: string | null = null;
    let contextReviewerIdentity: string | null = null;
    let contextReviewTreeStateSha256: string | null = null;
    let receiptReviewTreeStateSha256: string | null = null;
    let reusedExistingReview = false;
    let reusedFromReceiptPath: string | null = null;
    let reusedFromReceiptSha256: string | null = null;
    let reusedFromReviewContextSha256: string | null = null;
    let reusedFromReviewContextReuseSha256: string | null = null;
    let reusedFromReviewTreeStateSha256: string | null = null;
    let reusedFromReviewScopeSha256: string | null = null;
    let reusedFromCodeScopeSha256: string | null = null;
    let receiptReviewContextSha256: string | null = null;
    let receiptReviewContextReuseSha256: string | null = null;
    let receiptReviewScopeSha256: string | null = null;
    let receiptCodeScopeSha256: string | null = null;
    let reviewerProvenance: ReviewArtifactState['reviewerProvenance'] = null;
    let verdictToken: string | null = null;
    let failed = false;
    let failureKind: ReviewArtifactState['failureKind'] = null;
    let failureReason: string | null = null;
    let reviewFindingsValidationAccepted: boolean | null = null;
    let frozenReviewFindingsValidationAccepted: boolean | null = null;
    let reviewFindingsValidationRejected = false;
    let reviewFindingsValidationArtifactPath: string | null = null;
    let reviewOutputCorrectionArtifactPath: string | null = null;
    let reviewOutputCorrectionState: string | null = null;
    let reviewOutputCorrectionLaunchState: string | null = null;
    let reviewOutputCorrectionProducerIdentity: string | null = null;
    let reviewOutputCorrectionProviderInvocationId: string | null = null;
    let reviewOutputCorrectionAttestationSource: string | null = null;
    let reviewOutputCorrectionSessionAvailability: string | null = null;
    let reviewOutputCorrectionOriginalProviderInvocationId: string | null = null;
    let reviewOutputCorrectionReviewerIdentity: string | null = null;
    let reviewOutputCorrectionHandoff: ReviewOutputCorrectionHandoffEvidence | null = null;
    let reviewFindingsDisposition: ReviewFindingsDispositionEvaluation | null = null;
    let frozenReviewFindingsDisposition: ReviewFindingsDispositionEvaluation | null = null;
    let reviewFindingsDispositionArtifactPath: string | null = null;
    let reviewFindingsDispositionArtifactSha256: string | null = null;
    let reviewFindingsFollowUpArtifactPath: string | null = null;
    let reviewFindingsFollowUpSatisfied = false;
    const reviewFollowUpMaterializationMode = resolveReviewFollowUpMaterializationMode(preflightPayload);
    let domainScopeCurrent = false;
    let reviewResultRecordedAtUtc: string | null = null;
    let recordedAtUtc: string | null = null;
    let reviewOutputSourceMtimeUtc: string | null = null;

    if (!contextExists) {
        violations.push('review context artifact is missing');
    } else {
        context = safeReadJson(contextPath);
        if (!context) {
            violations.push('review context artifact is invalid JSON');
        } else {
            const reviewerRouting = isPlainRecord(context.reviewer_routing)
                ? context.reviewer_routing
                : null;
            const contextTreeState = isPlainRecord(context.tree_state)
                ? context.tree_state
                : null;
            contextReviewTreeStateSha256 = typeof contextTreeState?.tree_state_sha256 === 'string'
                ? contextTreeState.tree_state_sha256.trim().toLowerCase() || null
                : null;
            if (!contextReviewTreeStateSha256) {
                violations.push('review context is missing tree_state.tree_state_sha256');
            }
            const contextReviewerSessionId = typeof reviewerRouting?.reviewer_session_id === 'string'
                ? reviewerRouting.reviewer_session_id.trim()
                : '';
            contextReviewerIdentity = contextReviewerSessionId || null;
            const contextPreflightPath = typeof context.preflight_path === 'string'
                ? normalizePath(context.preflight_path)
                : '';
            const contextPreflightHash = typeof context.preflight_sha256 === 'string'
                ? context.preflight_sha256.trim().toLowerCase()
                : '';
            const expectedPreflightPath = normalizePath(preflightPath);
            const expectedPreflightHash = String(preflightSha256 || '').trim().toLowerCase();
            if (
                contextPreflightPath
                && contextPreflightHash
                && contextPreflightPath.toLowerCase() === expectedPreflightPath.toLowerCase()
                && contextPreflightHash === expectedPreflightHash
            ) {
                const preflightDiffExpectations = buildReviewContextPreflightDiffExpectations(
                    preflightPayload,
                    reviewType
                );
                const reviewExecution = isPlainRecord(context.review_execution)
                    ? context.review_execution as unknown as ReviewRemediationReviewContract
                    : null;
                const reviewExecutionValidationAuthority = reviewExecution && repoRoot
                    ? resolvePersistedRemediationReviewExecutionAuthority({
                        reviewsRoot,
                        taskId,
                        reviewType,
                        preflightSha256: expectedPreflightHash,
                        preflightPath,
                        fullReviewScope: preflightDiffExpectations.expectedChangedFiles,
                        reviewExecution,
                        reviewContextPath: contextPath,
                        receiptPath
                    })
                    : null;
                const contractViolations = getReviewContextContractViolations({
                    contextPath,
                    reviewContext: context,
                    expectedTaskId: taskId,
                    expectedReviewType: reviewType,
                    expectedPreflightPath: preflightPath,
                    expectedPreflightSha256: preflightSha256,
                    requireReviewType: true,
                    requireTaskId: true,
                    requirePreflightPath: true,
                    requirePreflightSha256: true,
                    expectedPreflightPayload: preflightPayload,
                    repoRoot: repoRoot || null,
                    expectedReviewExecutionValidationAuthority: reviewExecutionValidationAuthority ?? undefined,
                    ...preflightDiffExpectations
                });
                const fullSuiteBindingViolations = repoRoot
                    ? getReviewContextFullSuiteValidationViolations({
                        repoRoot,
                        taskId,
                        reviewType,
                        preflightPath,
                        preflightSha256,
                        reviewContext: context
                    })
                    : [];
                if (contractViolations.length === 0 && fullSuiteBindingViolations.length === 0) {
                    contextCurrent = true;
                } else {
                    violations.push(...contractViolations);
                    violations.push(...fullSuiteBindingViolations);
                }
            } else {
                contextPreflightBindingViolationIndex = violations.length;
                violations.push(
                    'review context preflight binding is stale or missing ' +
                    `(context preflight_path='${contextPreflightPath || 'missing'}', preflight_sha256=${contextPreflightHash || 'missing'}; ` +
                    `expected preflight_path='${expectedPreflightPath || 'missing'}', preflight_sha256=${expectedPreflightHash || 'missing'})`
                );
            }
        }
    }

    const requiresFindingsOnlyArtifact = reviewContextRequiresFindingsOnlyArtifact(context);
    if (!artifactExists) {
        violations.push('review artifact is missing');
    } else {
        const content = readReviewArtifactTextFile(artifactPath);
        const contextSha256 = contextExists ? readReviewArtifactFileSha256(contextPath) : null;
        const contentLooksLikeJson = String(content || '').trim().startsWith('{');
        const parsedVerdictToken = requiresFindingsOnlyArtifact || contentLooksLikeJson
            ? null
            : resolveReviewFindingsArtifactVerdictToken({
                content,
                passToken: passToken || null,
                failToken: failToken || null,
                reviewType,
                expectedTaskId: taskId,
                expectedReviewContextSha256: contextSha256 || undefined,
                expectedTreeStateSha256: contextReviewTreeStateSha256 || undefined,
                coverageContract: context?.coverage_contract as ReviewCoverageContract | null | undefined,
                repoRoot: repoRoot || undefined,
                evidenceSnapshotCommit: resolveReviewCoverageEvidenceSnapshotCommit(preflightPayload)
            });
        const acceptedTokens = buildReviewVerdictTokenSet(reviewType, passToken || null, failToken || null);
        if (requiresFindingsOnlyArtifact && !contentLooksLikeJson) {
            violations.push(
                `review artifact must be verdict-free findings JSON for current '${reviewType}' review context; ` +
                'legacy PASS/FAIL verdict-token artifacts are readable history only and cannot satisfy current review evidence'
            );
        } else if (requiresFindingsOnlyArtifact && contentLooksLikeJson) {
            // Verdict for current findings-only contexts is derived only from the persisted validation artifact below.
        } else if (failToken && parsedVerdictToken === failToken) {
            verdictToken = failToken;
            failed = true;
            failureReason = detectReviewLaunchPackageFailureReason(content);
            if (failureReason) {
                failureKind = 'launch-package';
                violations.push(
                    `review artifact contains fail token '${failToken}' for reviewer launch package failure (${failureReason}); preserve the failed artifact and restart the review cycle without implementation changes`
                );
            } else {
                failureReason = detectMissingFocusedValidationEvidenceFailureReason(content);
                if (failureReason) {
                    failureKind = 'missing-focused-validation-evidence';
                    violations.push(
                        `review artifact contains fail token '${failToken}' for missing focused validation evidence (${failureReason}); preserve the failed artifact and use current task-owned focused validation evidence without fake implementation changes`
                    );
                } else {
                    failureReason = detectMissingValidationEvidenceFailureReason(content);
                }
                if (failureReason && !failureKind) {
                    failureKind = 'missing-validation-evidence';
                    violations.push(
                        `review artifact contains fail token '${failToken}' for missing attached validation evidence (${failureReason}); preserve the failed artifact and refresh review evidence without fake implementation changes`
                    );
                } else if (!failureReason) {
                    failureReason = detectStaleValidationEvidenceFailureReason(content);
                    if (failureReason) {
                        failureKind = 'stale-validation-evidence';
                        violations.push(
                            `review artifact contains fail token '${failToken}' for stale validation evidence (${failureReason}); preserve the failed artifact and refresh compile/full-suite evidence without fake implementation changes`
                        );
                    }
                }
            }
            if (!failureKind) {
                violations.push(
                    `review artifact contains fail token '${failToken}'; fix implementation and rerun compile plus '${reviewType}' review before launching dependent reviews`
                );
            }
        } else if (passToken && parsedVerdictToken === passToken) {
            verdictToken = passToken;
        } else {
            violations.push(
                `review artifact does not contain an accepted pass token ` +
                `(${formatReviewVerdictTokenList(acceptedTokens.passTokens)})`
            );
        }
    }

    if (!receiptExists) {
        violations.push('review receipt is missing');
    } else {
        receipt = safeReadJson(receiptPath);
        if (!receipt) {
            violations.push('review receipt is invalid JSON');
        }
    }

    if (context && receipt && artifactExists) {
        const artifactHash = readReviewArtifactFileSha256(artifactPath);
        const contextHash = readReviewArtifactFileSha256(contextPath);
        const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflightPayload || {}, repoRoot || '.');
        const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint(reviewType, preflightPayload || {}, repoRoot || '.');
        const reviewerRouting = isPlainRecord(context.reviewer_routing)
            ? context.reviewer_routing
            : null;
        const contextExecutionMode = typeof reviewerRouting?.actual_execution_mode === 'string'
            ? reviewerRouting.actual_execution_mode.trim()
            : '';
        const contextReviewerSessionId = typeof reviewerRouting?.reviewer_session_id === 'string'
            ? reviewerRouting.reviewer_session_id.trim()
            : '';
        const evidenceContract = validateReviewReceiptEvidenceContract({
            taskId,
            reviewType,
            receipt,
            artifactSha256: artifactHash || null,
            contextSha256: contextHash || null,
            contextReviewTreeStateSha256,
            contextExecutionMode: contextExecutionMode || null,
            contextReviewerIdentity: contextReviewerSessionId || null,
            reviewContext: context
        });
        const evidenceFields = evidenceContract.fields;
        violations.push(...evidenceContract.violations);
        receiptContractCurrent = contextCurrent && evidenceContract.violations.length === 0;
        reviewerIdentity = evidenceFields.reviewerIdentity;
        reusedExistingReview = evidenceFields.reusedExistingReview;
        reusedFromReceiptPath = evidenceFields.reusedFromReceiptPath;
        reusedFromReceiptSha256 = evidenceFields.reusedFromReceiptSha256;
        reusedFromReviewContextSha256 = evidenceFields.reusedFromReviewContextSha256;
        reusedFromReviewContextReuseSha256 = evidenceFields.reusedFromReviewContextReuseSha256;
        reusedFromReviewTreeStateSha256 = evidenceFields.reusedFromReviewTreeStateSha256;
        reusedFromReviewScopeSha256 = evidenceFields.reusedFromReviewScopeSha256;
        reusedFromCodeScopeSha256 = evidenceFields.reusedFromCodeScopeSha256;
        receiptReviewContextSha256 = evidenceFields.reviewContextSha256;
        receiptReviewContextReuseSha256 = evidenceFields.reviewContextReuseSha256;
        receiptReviewScopeSha256 = evidenceFields.reviewScopeSha256;
        receiptCodeScopeSha256 = evidenceFields.codeScopeSha256;
        receiptReviewTreeStateSha256 = evidenceFields.reviewTreeStateSha256;
        domainScopeCurrent = reviewReceiptDomainScopeMatchesCurrentPreflight(receipt, context, preflightPayload);
        reviewResultRecordedAtUtc = evidenceFields.reviewResultRecordedAtUtc;
        recordedAtUtc = evidenceFields.recordedAtUtc;
        reviewOutputSourceMtimeUtc = evidenceFields.reviewOutputSourceMtimeUtc;
        if (requiresFindingsOnlyArtifact) {
            const dispositionArtifact = isPlainRecord(receipt.review_findings_disposition_artifact)
                ? receipt.review_findings_disposition_artifact
                : null;
            reviewFindingsDispositionArtifactPath = typeof dispositionArtifact?.artifact_path === 'string'
                ? dispositionArtifact.artifact_path.trim() || null
                : null;
            reviewFindingsDispositionArtifactSha256 = typeof dispositionArtifact?.artifact_sha256 === 'string'
                ? dispositionArtifact.artifact_sha256.trim().toLowerCase() || null
                : null;
            if (reviewFindingsDispositionArtifactPath) {
                reviewFindingsFollowUpArtifactPath = reviewFindingsDispositionArtifactPath.replace(
                    /-findings-disposition\.json$/u,
                    '-findings-follow-ups.json'
                );
            }
            const coverageContract = isPlainRecord(context.coverage_contract)
                ? context.coverage_contract as unknown as ReviewCoverageContract
                : null;
            const currentScopeSha256 = getPreflightScopeSha256(preflightPayload);
            const currentReviewScopeSha256 = preflightPayload
                ? String(reviewScopeFingerprint.review_scope_sha256 || '').trim().toLowerCase() || null
                : null;
            const currentCodeScopeSha256 = preflightPayload && isNonTestReviewScope(reviewType)
                ? String(codeScopeFingerprint.code_scope_sha256 || '').trim().toLowerCase() || null
                : null;
            const validationArtifact = validateReviewFindingsValidationArtifactForReceipt({
                receipt,
                reviewArtifactPath: artifactPath,
                expectedTaskId: taskId,
                expectedReviewType: reviewType,
                expectedReviewOutputSha256: typeof receipt.review_output_sha256 === 'string'
                    ? receipt.review_output_sha256
                    : null,
                expectedReviewArtifactSha256: artifactHash || null,
                expectedReviewContextPath: reusedExistingReview ? null : contextPath,
                expectedReviewContextSha256: reusedExistingReview
                    ? reusedFromReviewContextSha256
                    : contextHash || null,
                expectedPreflightPath: reusedExistingReview ? null : preflightPath,
                expectedPreflightSha256: reusedExistingReview ? null : preflightSha256,
                expectedScopeSha256: reusedExistingReview
                    ? null
                    : currentScopeSha256 || normalizeReviewEvidenceSha256(receipt.scope_sha256),
                expectedReviewScopeSha256: reusedExistingReview
                    ? reusedFromReviewScopeSha256
                    : currentReviewScopeSha256 || receiptReviewScopeSha256,
                expectedCodeScopeSha256: reusedExistingReview
                    ? reusedFromCodeScopeSha256
                    : currentCodeScopeSha256 || receiptCodeScopeSha256,
                expectedReviewTreeStateSha256: reusedExistingReview
                    ? reusedFromReviewTreeStateSha256
                    : contextReviewTreeStateSha256,
                expectedCoverageContractSha256: reusedExistingReview
                    ? getReceiptOutputContractString(receipt, 'coverage_contract_sha256')
                    : String(coverageContract?.contract_sha256 || '').trim().toLowerCase() || null,
                expectedReviewContext: context,
                requireAccepted: true
            });
            reviewFindingsValidationArtifactPath = validationArtifact.reference?.artifact_path || null;
            reviewFindingsValidationAccepted = validationArtifact.accepted;
            violations.push(...validationArtifact.violations);
            receiptCurrent = receiptContractCurrent
                && validationArtifact.valid
                && validationArtifact.accepted;
            if (!validationArtifact.valid) {
                const frozenValidationArtifact = validateReviewFindingsValidationArtifactForReceipt({
                    receipt,
                    reviewArtifactPath: artifactPath,
                    expectedTaskId: taskId,
                    expectedReviewType: reviewType,
                    expectedReviewOutputSha256: typeof receipt.review_output_sha256 === 'string'
                        ? receipt.review_output_sha256
                        : null,
                    expectedReviewArtifactSha256: artifactHash || null,
                    expectedReviewContextPath: reusedExistingReview ? null : contextPath,
                    expectedReviewContextSha256: reusedExistingReview
                        ? reusedFromReviewContextSha256
                        : contextHash || null,
                    expectedPreflightPath: reusedExistingReview ? null : preflightPath,
                    expectedPreflightSha256: reusedExistingReview ? null : preflightSha256,
                    expectedScopeSha256: reusedExistingReview
                        ? null
                        : normalizeReviewEvidenceSha256(receipt.scope_sha256),
                    expectedReviewScopeSha256: reusedExistingReview
                        ? reusedFromReviewScopeSha256
                        : receiptReviewScopeSha256,
                    expectedCodeScopeSha256: reusedExistingReview
                        ? reusedFromCodeScopeSha256
                        : receiptCodeScopeSha256,
                    expectedReviewTreeStateSha256: reusedExistingReview
                        ? reusedFromReviewTreeStateSha256
                        : contextReviewTreeStateSha256,
                    expectedCoverageContractSha256: reusedExistingReview
                        ? getReceiptOutputContractString(receipt, 'coverage_contract_sha256')
                        : String(coverageContract?.contract_sha256 || '').trim().toLowerCase() || null,
                    expectedReviewContext: context,
                    requireAccepted: true
                });
                frozenReviewFindingsValidationAccepted = frozenValidationArtifact.accepted;
                if (frozenValidationArtifact.valid && frozenValidationArtifact.accepted) {
                    frozenReviewFindingsDisposition = evaluateReviewFindingsValidationArtifactDispositions(
                        frozenValidationArtifact.artifact,
                        reusedExistingReview
                            ? resolveLockedReviewFindingPolicyFromReceiptDisposition(receipt)
                            : resolveLockedReviewFindingPolicyFromPreflight(preflightPayload)
                    );
                }
            }
            if (validationArtifact.valid) {
                if (reviewFindingsValidationArtifactHasBlockingFindings(
                    validationArtifact.artifact,
                    reusedExistingReview
                        ? resolveLockedReviewFindingPolicyFromReceiptDisposition(receipt)
                        : resolveLockedReviewFindingPolicyFromPreflight(preflightPayload)
                )) {
                    const policyResolution = reusedExistingReview
                        ? resolveLockedReviewFindingPolicyFromReceiptDisposition(receipt)
                        : resolveLockedReviewFindingPolicyFromPreflight(preflightPayload);
                    reviewFindingsDisposition = evaluateReviewFindingsValidationArtifactDispositions(
                        validationArtifact.artifact,
                        policyResolution
                    );
                    verdictToken = failToken || null;
                    failed = true;
                    violations.push(
                        `review findings validation artifact contains fix_now findings or residual risks; fix implementation and rerun compile plus '${reviewType}' review before launching dependent reviews`
                    );
                } else {
                    const policyResolution = reusedExistingReview
                        ? resolveLockedReviewFindingPolicyFromReceiptDisposition(receipt)
                        : resolveLockedReviewFindingPolicyFromPreflight(preflightPayload);
                    reviewFindingsDisposition = evaluateReviewFindingsValidationArtifactDispositions(
                        validationArtifact.artifact,
                        policyResolution
                    );
                    if (
                        reviewFindingsDisposition.counts_by_action.create_follow_up > 0
                        && reviewFindingsFollowUpArtifactPath
                        && reviewFindingsDispositionArtifactSha256
                        && fileExists(reviewFindingsFollowUpArtifactPath)
                    ) {
                        const followUpArtifact = safeReadJson(reviewFindingsFollowUpArtifactPath);
                        const sourceDisposition = isPlainRecord(followUpArtifact?.source_disposition)
                            ? followUpArtifact.source_disposition
                            : null;
                        const status = typeof followUpArtifact?.status === 'string'
                            ? followUpArtifact.status
                            : '';
                        const sourceDispositionSha256 = typeof sourceDisposition?.artifact_sha256 === 'string'
                            ? sourceDisposition.artifact_sha256.trim().toLowerCase()
                            : '';
                        const dispositionArtifactPayload = reviewFindingsDispositionArtifactPath
                            && reviewFindingsDispositionArtifactSha256
                            && fileExists(reviewFindingsDispositionArtifactPath)
                            && readReviewArtifactFileSha256(reviewFindingsDispositionArtifactPath) === reviewFindingsDispositionArtifactSha256
                            ? safeReadJson(reviewFindingsDispositionArtifactPath)
                            : null;
                        reviewFindingsFollowUpSatisfied = (
                            ['MATERIALIZED', 'ALREADY_MATERIALIZED', 'NOT_REQUIRED'].includes(status)
                            && sourceDispositionSha256 === reviewFindingsDispositionArtifactSha256
                            && isPlainRecord(followUpArtifact)
                            && isPlainRecord(dispositionArtifactPayload)
                            && followUpArtifactMatchesCurrentTaskQueue({
                                artifact: followUpArtifact,
                                dispositionArtifact: dispositionArtifactPayload,
                                dispositionArtifactSha256: reviewFindingsDispositionArtifactSha256,
                                repoRoot,
                                taskId,
                                reviewType,
                                expectedFollowUpCount: reviewFindingsDisposition.counts_by_action.create_follow_up,
                                materializationMode: reviewFollowUpMaterializationMode,
                                followUpArtifactPath: reviewFindingsFollowUpArtifactPath,
                                taskQueueFollowUpFingerprintIndex
                            })
                        );
                    }
                    verdictToken = passToken || null;
                }
            }
        } else {
            receiptCurrent = receiptContractCurrent;
        }
        reviewerProvenance = evidenceFields.reviewerProvenance
            ? {
                attestation_type: evidenceFields.reviewerProvenance.attestation_type,
                controller_event_type: evidenceFields.reviewerProvenance.controller_event_type,
                task_sequence: evidenceFields.reviewerProvenance.task_sequence,
                prev_event_sha256: evidenceFields.reviewerProvenance.prev_event_sha256 == null
                    ? null
                    : String(evidenceFields.reviewerProvenance.prev_event_sha256 || '').trim().toLowerCase() || null,
                event_sha256: normalizeReviewEvidenceSha256(evidenceFields.reviewerProvenance.event_sha256),
                task_id: 'task_id' in evidenceFields.reviewerProvenance ? evidenceFields.reviewerProvenance.task_id : undefined,
                review_type: 'review_type' in evidenceFields.reviewerProvenance ? evidenceFields.reviewerProvenance.review_type : undefined,
                reviewer_execution_mode: 'reviewer_execution_mode' in evidenceFields.reviewerProvenance ? evidenceFields.reviewerProvenance.reviewer_execution_mode : undefined,
                reviewer_identity: 'reviewer_identity' in evidenceFields.reviewerProvenance ? evidenceFields.reviewerProvenance.reviewer_identity : undefined,
                review_context_sha256: 'review_context_sha256' in evidenceFields.reviewerProvenance ? evidenceFields.reviewerProvenance.review_context_sha256 : undefined,
                review_tree_state_sha256: 'review_tree_state_sha256' in evidenceFields.reviewerProvenance ? evidenceFields.reviewerProvenance.review_tree_state_sha256 : undefined,
                routing_event_sha256: 'routing_event_sha256' in evidenceFields.reviewerProvenance ? evidenceFields.reviewerProvenance.routing_event_sha256 : undefined,
                launch_prepared_at_utc: 'launch_prepared_at_utc' in evidenceFields.reviewerProvenance ? evidenceFields.reviewerProvenance.launch_prepared_at_utc : undefined,
                launched_at_utc: 'launched_at_utc' in evidenceFields.reviewerProvenance ? evidenceFields.reviewerProvenance.launched_at_utc : undefined,
                launch_completed_at_utc: 'launch_completed_at_utc' in evidenceFields.reviewerProvenance ? evidenceFields.reviewerProvenance.launch_completed_at_utc : undefined,
                invocation_attested_at_utc: 'invocation_attested_at_utc' in evidenceFields.reviewerProvenance ? evidenceFields.reviewerProvenance.invocation_attested_at_utc : undefined
            }
            : null;
    }
    if (requiresFindingsOnlyArtifact && !receiptCurrent && fileExists(getReviewFindingsValidationArtifactPath(artifactPath))) {
        const contextHash = contextExists ? readReviewArtifactFileSha256(contextPath) : null;
        const rejectedValidationArtifact = validateReviewFindingsValidationArtifact({
            artifactPath: getReviewFindingsValidationArtifactPath(artifactPath),
            expectedTaskId: taskId,
            expectedReviewType: reviewType,
            expectedReviewArtifactPath: artifactPath,
            expectedReviewContextPath: contextPath,
            expectedReviewContextSha256: contextHash || null,
            expectedPreflightPath: preflightPath,
            expectedPreflightSha256: preflightSha256,
            expectedScopeSha256: getPreflightScopeSha256(preflightPayload),
            expectedReviewTreeStateSha256: contextReviewTreeStateSha256,
            expectedCoverageContractSha256: isPlainRecord(context?.coverage_contract)
                ? String((context.coverage_contract as Record<string, unknown>).contract_sha256 || '').trim().toLowerCase() || null
                : null,
            expectedReviewContext: context,
            requireAccepted: false
        });
        if (!rejectedValidationArtifact.valid) {
            violations.push(...rejectedValidationArtifact.violations);
        } else if (!rejectedValidationArtifact.accepted && !reviewCorrectionWasSuperseded(
            path.join(path.dirname(reviewsRoot), 'task-events'),
            taskId,
            reviewType,
            getReviewOutputCorrectionArtifactPath(artifactPath)
        )) {
            reviewFindingsValidationArtifactPath = getReviewFindingsValidationArtifactPath(artifactPath);
            reviewFindingsValidationAccepted = false;
            reviewFindingsValidationRejected = true;
            verdictToken = failToken || null;
            failed = true;
            failureKind = 'review-validation-rejected';
            failureReason = rejectedValidationArtifact.artifact?.validation_result.violations.join(' ') || 'review findings validation rejected';
            const correctionPath = getReviewOutputCorrectionArtifactPath(artifactPath);
            if (fileExists(correctionPath)) {
                reviewOutputCorrectionArtifactPath = correctionPath;
                const correction = readReviewOutputCorrectionArtifact(correctionPath);
                reviewOutputCorrectionState = correction.artifact?.state || null;
                if (correction.violations.length > 0 || !correction.artifact) {
                    failureKind = 'review-correction-full-review-required';
                    failureReason = correction.violations.join(' ')
                        || 'review output correction evidence is unavailable';
                } else if (correction.artifact.state === 'FULL_REVIEW_REQUIRED') {
                    failureKind = 'review-correction-full-review-required';
                    failureReason = correction.artifact.recovery.reason;
                } else if (correction.artifact.state === 'REVIEW_OUTPUT_CORRECTION_REQUIRED') {
                    const handoff = correction.artifact.recovery.handoff;
                    const transportBinding = correction.artifact.transport_binding;
                    const originalProviderInvocationId = String(
                        transportBinding?.provider_invocation_id || ''
                    ).trim() || null;
                    reviewOutputCorrectionSessionAvailability =
                        transportBinding?.session_availability || null;
                    reviewOutputCorrectionOriginalProviderInvocationId =
                        originalProviderInvocationId;
                    reviewOutputCorrectionReviewerIdentity =
                        correction.artifact.binding.reviewer_identity || null;
                    if (
                        (
                            correction.artifact.recovery.selected_transport === 'api_conversation_continuation'
                            || correction.artifact.recovery.selected_transport === 'correction_only_invocation'
                        )
                        && transportBinding?.session_availability === 'pending'
                    ) {
                        failureKind = originalProviderInvocationId
                            ? 'review-correction-transport-selection-required'
                            : 'review-correction-full-review-required';
                        if (!originalProviderInvocationId) {
                            failureReason = [
                                failureReason,
                                'Review output correction transport is not bound to an authenticated original provider invocation; ' +
                                'a controller-only invocation cannot attest provider session availability.'
                            ].filter(Boolean).join(' ');
                        }
                    }
                    const correctionInputSha256 = readReviewArtifactFileSha256(correctionPath);
                    const correctionLaunchPath = getReviewOutputCorrectionLaunchArtifactPath(artifactPath);
                    const correctionLaunch = fileExists(correctionLaunchPath)
                        ? safeReadJson(correctionLaunchPath)
                        : null;
                    if (isPlainRecord(correctionLaunch)) {
                        reviewOutputCorrectionLaunchState = String(correctionLaunch.state || '').trim() || null;
                        reviewOutputCorrectionProducerIdentity = String(
                            correctionLaunch.correction_producer_identity || ''
                        ).trim() || null;
                        reviewOutputCorrectionProviderInvocationId = String(
                            correctionLaunch.provider_invocation_id || ''
                        ).trim() || null;
                        reviewOutputCorrectionAttestationSource = String(
                            correctionLaunch.attestation_source || ''
                        ).trim() || null;
                    }
                    const reviewerInvocationEventSha256 = String(
                        correction.artifact.binding.reviewer_invocation_event_sha256 || ''
                    ).trim().toLowerCase();
                    const timelineEvents = readTaskTimelineEventLikes(
                        path.join(path.dirname(reviewsRoot), 'task-events'),
                        taskId
                    );
                    const originalInvocation = timelineEvents.find((event) => {
                        const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
                        return event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
                            && String(integrity?.event_sha256 || '').trim().toLowerCase()
                                === reviewerInvocationEventSha256;
                    });
                    const originalInvocationDetails = originalInvocation
                        && isPlainRecord(originalInvocation.details)
                        ? originalInvocation.details
                        : null;
                    const originalInvocationProviderInvocationId = String(
                        originalInvocationDetails?.provider_invocation_id || ''
                    ).trim();
                    const originalInvocationReviewerIdentity = String(
                        originalInvocationDetails?.reviewer_identity
                        || originalInvocationDetails?.reviewer_session_id
                        || ''
                    ).trim();
                    const originalInvocationBindingValid = Boolean(
                        originalProviderInvocationId
                        && originalInvocationProviderInvocationId === originalProviderInvocationId
                        && originalInvocationReviewerIdentity === correction.artifact.binding.reviewer_identity
                    );
                    const authenticatedOriginalProviderInvocationId = originalInvocationBindingValid
                        ? originalProviderInvocationId
                        : null;
                    reviewOutputCorrectionOriginalProviderInvocationId =
                        authenticatedOriginalProviderInvocationId;
                    const correctionProducerInvocation = correction.artifact.recovery.selected_transport
                        === 'correction_only_invocation'
                        ? [...timelineEvents].reverse().find((event) => {
                            const details = isPlainRecord(event.details) ? event.details : null;
                            return event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
                                && String(details?.invocation_role || '').trim() === 'review_output_correction'
                                && String(details?.correction_artifact_sha256 || '').trim().toLowerCase()
                                    === correctionInputSha256;
                        })
                        : originalInvocation;
                    const correctionProducerDetails = correctionProducerInvocation
                        && isPlainRecord(correctionProducerInvocation.details)
                        ? correctionProducerInvocation.details
                        : null;
                    const correctionProducerIntegrity = correctionProducerInvocation
                        && isPlainRecord(correctionProducerInvocation.integrity)
                        ? correctionProducerInvocation.integrity
                        : null;
                    const correctionProducerInvocationEventSha256 = String(
                        correctionProducerIntegrity?.event_sha256 || ''
                    ).trim().toLowerCase();
                    const correctionProducerIdentity = String(
                        correctionProducerDetails?.reviewer_identity
                        || correctionProducerDetails?.reviewer_session_id
                        || ''
                    ).trim();
                    const correctionProviderInvocationId = String(
                        correctionProducerDetails?.provider_invocation_id || ''
                    ).trim();
                    const correctionAttestationSource = String(
                        correctionProducerDetails?.reviewer_launch_attestation_source
                        || correctionProducerDetails?.attestation_source
                        || ''
                    ).trim();
                    if (
                        !handoff
                        || !transportBinding
                        || !correctionInputSha256
                        || !/^[0-9a-f]{64}$/u.test(reviewerInvocationEventSha256)
                        || !originalInvocation
                        || (
                            failureKind === 'review-correction-transport-selection-required'
                            && !originalInvocationBindingValid
                        )
                    ) {
                        failureKind = 'review-correction-full-review-required';
                    }
                    reviewOutputCorrectionHandoff = {
                        providerAction: String(handoff?.provider_action || '').trim() || null,
                        providerResponseOutputPath: String(
                            handoff?.provider_response_output_path || ''
                        ).trim() || null,
                        launchState: reviewOutputCorrectionLaunchState,
                        targetReviewerIdentity: String(handoff?.target_reviewer_identity || '').trim() || null,
                        launchInputSha256: correctionInputSha256 || null,
                        reviewerInvocationEventSha256: reviewerInvocationEventSha256 || null,
                        correctionProducerInvocationEventSha256:
                            correctionProducerInvocationEventSha256 || null,
                        correctionProducerIdentity: correctionProducerIdentity || null,
                        correctionProviderInvocationId: correctionProviderInvocationId || null,
                        originalProviderInvocationId: authenticatedOriginalProviderInvocationId,
                        correctionAttestationSource: correctionAttestationSource || null
                    };
                    failureReason = [
                        failureReason,
                        `Correction package: ${normalizePath(correctionPath)}.`,
                        `Selected transport: ${correction.artifact.recovery.selected_transport}.`,
                        handoff
                            ? [
                                `ReviewerCorrectionHandoff: provider_action=${handoff.provider_action};`,
                                `ReviewerCorrectionInputArtifactPath=${handoff.launch_input_artifact_path || normalizePath(correctionPath)};`,
                                `ReviewerCorrectionInputArtifactSha256=${correctionInputSha256 || 'unavailable'};`,
                                `ReviewerInvocationEventSha256=${reviewerInvocationEventSha256 || 'unavailable'};`,
                                `CorrectionProducerInvocationEventSha256=${correctionProducerInvocationEventSha256 || 'unavailable'};`,
                                `CorrectionLaunchState=${reviewOutputCorrectionLaunchState || 'prepared'};`,
                                `CorrectionProducerIdentity=${correctionProducerIdentity || 'unavailable'};`,
                                `CorrectionProviderInvocationId=${correctionProviderInvocationId || 'unavailable'};`,
                                `CorrectionAttestationSource=${correctionAttestationSource || 'unavailable'};`,
                                `CorrectionSessionAvailability=${transportBinding?.session_availability || 'unavailable'};`,
                                `OriginalProviderInvocationId=${authenticatedOriginalProviderInvocationId || 'unavailable'};`,
                                `ProviderCapabilitiesSha256=${transportBinding?.provider_capabilities_sha256 || 'unavailable'};`,
                                `target_reviewer_identity=${handoff.target_reviewer_identity || 'new_correction_only_reviewer'};`,
                                `fork_context=${handoff.fork_context === false ? 'false' : 'preserve_current_conversation'}.`,
                                handoff.instruction
                            ].join(' ')
                            : 'ReviewerCorrectionHandoff is missing; correction recovery cannot be executed safely.'
                    ].filter(Boolean).join(' ');
                }
            } else {
                failureKind = 'review-correction-full-review-required';
                failureReason = [
                    failureReason,
                    `Review output correction package is missing: ${normalizePath(correctionPath)}.`
                ].filter(Boolean).join(' ');
            }
            violations.push(
                `review findings validation artifact is rejected: ` +
                failureReason
            );
        }
    }

    const effectiveViolations = domainScopeCurrent
        ? violations.filter((_, index) => index !== contextPreflightBindingViolationIndex)
        : violations;

    return {
        reviewType,
        contextPath,
        artifactPath,
        receiptPath,
        contextExists,
        contextCurrent,
        artifactExists,
        receiptExists,
        receiptContractCurrent,
        passToken,
        failToken,
        verdictToken,
        failed,
        failureKind,
        failureReason,
        reviewFindingsValidationAccepted,
        frozenReviewFindingsValidationAccepted,
        reviewFindingsValidationRejected,
        reviewFindingsValidationArtifactPath,
        reviewOutputCorrectionArtifactPath,
        reviewOutputCorrectionState,
        reviewOutputCorrectionLaunchState,
        reviewOutputCorrectionProducerIdentity,
        reviewOutputCorrectionProviderInvocationId,
        reviewOutputCorrectionAttestationSource,
        reviewOutputCorrectionSessionAvailability,
        reviewOutputCorrectionOriginalProviderInvocationId,
        reviewOutputCorrectionReviewerIdentity,
        reviewOutputCorrectionHandoff,
        reviewFindingsDisposition,
        frozenReviewFindingsDisposition,
        reviewFindingsDispositionArtifactPath,
        reviewFindingsDispositionArtifactSha256,
        reviewFindingsFollowUpArtifactPath,
        reviewFindingsFollowUpSatisfied,
        reviewFollowUpMaterializationMode,
        domainScopeCurrent,
        ready: effectiveViolations.length === 0,
        violations: effectiveViolations,
        reviewerIdentity,
        contextReviewerIdentity,
        reusedExistingReview,
        reusedFromReceiptPath,
        reusedFromReceiptSha256,
        reusedFromReviewContextSha256,
        reusedFromReviewContextReuseSha256,
        reusedFromReviewTreeStateSha256,
        reusedFromReviewScopeSha256,
        reusedFromCodeScopeSha256,
        receiptReviewContextSha256,
        receiptReviewContextReuseSha256,
        receiptReviewScopeSha256,
        receiptCodeScopeSha256,
        contextReviewTreeStateSha256,
        receiptReviewTreeStateSha256,
        reviewerProvenance,
        reviewResultRecordedAtUtc,
        recordedAtUtc,
        reviewOutputSourceMtimeUtc
    };
}

export function reviewReceiptDomainScopeMatchesCurrentPreflight(
    receipt: Record<string, unknown>,
    reviewContext: Record<string, unknown> | null,
    currentPreflight: Record<string, unknown> | null
): boolean {
    if (!reviewContext || !currentPreflight) {
        return false;
    }
    const reviewType = String(receipt.review_type || '').trim().toLowerCase();
    if (reviewType !== String(reviewContext.review_type || '').trim().toLowerCase()) {
        return false;
    }
    return reviewContextLaneScopeMatchesCurrentPreflight(reviewType, reviewContext, currentPreflight);
}

export function scopedDiffExpectedForReview(options: {
    preflight: Record<string, unknown> | null;
    reviewType: string;
}): boolean {
    return buildReviewContextPreflightDiffExpectations(options.preflight, options.reviewType).expectedScopedDiff;
}

export function getScopedDiffMetadataReadiness(options: {
    metadataPath: string;
    preflight: Record<string, unknown> | null;
    preflightPath: string;
    preflightSha256: string | null;
    reviewType: string;
}): { ready: boolean; reason: string } {
    const metadataPath = options.metadataPath;
    if (!fileExists(metadataPath)) {
        return {
            ready: false,
            reason: `Scoped diff metadata is missing: ${normalizePath(metadataPath)}.`
        };
    }
    const metadata = safeReadJson(metadataPath);
    if (!isPlainRecord(metadata)) {
        return {
            ready: false,
            reason: `Scoped diff metadata is invalid JSON: ${normalizePath(metadataPath)}.`
        };
    }
    if (typeof metadata.parse_error === 'string' && metadata.parse_error.trim()) {
        return {
            ready: false,
            reason: `Scoped diff metadata contains parse_error: ${metadata.parse_error.trim()}.`
        };
    }
    const outputDiffLineCount = typeof metadata.output_diff_line_count === 'number'
        ? metadata.output_diff_line_count
        : Number(metadata.output_diff_line_count);
    if (!Number.isFinite(outputDiffLineCount) || outputDiffLineCount <= 0) {
        return {
            ready: false,
            reason: `Scoped diff metadata has no output diff lines: ${normalizePath(metadataPath)}.`
        };
    }

    const contractViolations = getReviewContextContractViolations({
        contextPath: metadataPath,
        reviewContext: {
            scoped_diff: {
                expected: true,
                metadata_path: normalizePath(metadataPath),
                metadata
            }
        },
        expectedReviewType: options.reviewType,
        expectedPreflightPath: options.preflightPath,
        expectedPreflightSha256: options.preflightSha256,
        requireReviewType: false,
        requireTaskId: false,
        requirePreflightPath: false,
        requirePreflightSha256: false,
        requireDiffMaterialForRequiredReview: false,
        ...buildReviewContextPreflightDiffExpectations(options.preflight, options.reviewType),
        expectedScopedDiff: true
    });
    if (contractViolations.length > 0) {
        return {
            ready: false,
            reason: `Scoped diff metadata is stale or mismatched: ${contractViolations.join(' ')}`
        };
    }
    return { ready: true, reason: 'Scoped diff metadata is ready.' };
}

export function readReviewTrust(
    reviewsRoot: string,
    taskId: string,
    requiredReviewTypes: string[],
    scopeCategory: string | null
): ReviewTrustSummary | null {
    const entries = requiredReviewTypes.flatMap((reviewType) => {
        const receipt = safeReadJson(path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`));
        if (!receipt) {
            return [];
        }
        return [{
            review_type: reviewType,
            trust_level: typeof receipt.trust_level === 'string' ? receipt.trust_level : null,
            reviewer_execution_mode: typeof receipt.reviewer_execution_mode === 'string'
                ? receipt.reviewer_execution_mode
                : null,
            reviewer_identity: typeof receipt.reviewer_identity === 'string'
                ? receipt.reviewer_identity
                : null,
            reviewer_fallback_reason: typeof receipt.reviewer_fallback_reason === 'string'
                ? receipt.reviewer_fallback_reason
                : null,
            reviewer_provenance: receipt.reviewer_provenance ?? null,
            reused_existing_review: receipt.reused_existing_review === true
        }];
    });
    return buildReviewTrustSummary(entries, scopeCategory, requiredReviewTypes.length);
}
