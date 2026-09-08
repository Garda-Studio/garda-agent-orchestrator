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
    readReviewArtifactTextFile
} from '../../gate-runtime/review-artifacts';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import { normalizePath } from '../shared/helpers';
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
    validateReviewFindingsValidationArtifactForReceipt
} from '../review/review-findings-validation-artifact';
import {
    evaluateReviewFindingsValidationArtifactDispositions,
    type ReviewFindingsDispositionEvaluation,
    resolveLockedReviewFindingPolicyFromPreflight,
    resolveLockedReviewFindingPolicyFromReceiptDisposition,
    reviewFindingsValidationArtifactHasBlockingFindings
} from '../review/review-finding-disposition';
import {
    resolveReviewCoverageEvidenceSnapshotCommit,
    type ReviewCoverageContract
} from '../review/review-coverage-ledger';
import {
    normalizeReviewEvidenceSha256,
    validateReviewReceiptEvidenceContract
} from '../review/review-evidence-contract';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    isNonTestReviewScope
} from '../review-reuse/review-reuse';
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
import { readTaskTimelineEventLikes } from './next-step-review-timeline-evidence';
import { reviewCorrectionWasSuperseded } from './next-step-review-correction-supersession';

const REVIEW_VERDICT_PASS_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(REVIEW_CONTRACTS));
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
            const groupedFingerprint = extractGroupedReviewFollowUpFingerprint(notes);
            if (groupedFingerprint) {
                groupedFingerprintByTask.set(row.taskId, groupedFingerprint);
            }
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
                        fullReviewScope: preflightDiffExpectations.expectedChangedFiles,
                        reviewExecution
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
