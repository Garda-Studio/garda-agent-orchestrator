import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { redactSecretText } from '../../core/redaction';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { buildTaskQueueStatusContract } from '../../core/task-queue-status-contract';
import { writeReviewArtifactText } from '../../gate-runtime/review-artifacts';
import {
    appendMandatoryTaskEvent
} from '../../gate-runtime/task-events';
import type {
    ScopeBudgetGuardEvaluation
} from '../../core/scope-budget-guard';
import type {
    ReviewCycleGuardEvaluation
} from '../../core/review-cycle-guard';
import { readTaskQueueEntries } from '../../core/task-queue-read';
import { withTaskQueueTransaction } from '../../core/task-queue/task-queue-repository';
import { readTaskQueueStatusToken } from '../../core/task-queue/task-queue-status';
import {
    syncTaskQueueStatusDetailed,
    type TaskQueueStatusSyncResult
} from '../../cli/commands/gate-flows/task/task-queue-sync';
import {
    fileSha256,
    normalizePath
} from '../shared/helpers';
import {
    canCaptureSplitRequiredWip,
    captureAndSuspendSplitRequiredWip,
    type SplitRequiredWipCaptureResult
} from '../split-required/split-required-wip';
import { resolveWipRoot } from '../split-required/split-required-wip-contracts';
import { reuseRetainedWipForDecomposition } from '../split-required/split-required-wip-decomposition';
import {
    collectOrderedTimelineEvents
} from '../completion/completion-evidence';
import type {
    ReviewCycleContinuationAssessment
} from '../review-cycle/review-cycle-continuation';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    SPLIT_REQUIRED_STATUS
} from './next-step-task-queue';
import { isPlainRecord } from '../../core/records';

export type SplitRequiredGuardKind = 'scope_budget' | 'review_cycle' | 'full_suite_repair';

export type SplitRequiredLatchFaultBoundary =
    | 'after_status_sync'
    | 'after_wip_capture'
    | 'after_latch_artifact'
    | 'after_latch_event'
    | 'after_status_event';

export interface SplitRequiredLatchResult {
    artifact_path: string;
    artifact_sha256: string;
    status_sync: TaskQueueStatusSyncResult;
    status_event_recorded: boolean;
    latch_event_recorded: boolean;
    wip_capture: SplitRequiredWipCaptureResult | null;
}

export interface SplitRequiredLatchEvidence {
    valid: boolean;
    reason: string;
    artifact_path: string;
    artifact_sha256: string | null;
    guard_kind: string | null;
}

export interface ReviewCycleContinuationSplitLatchClearance {
    valid: boolean;
    reason: string;
    resume_status: 'IN_PROGRESS' | 'IN_REVIEW' | null;
}

export type SplitRequiredDecompositionWipSuspensionResult = SplitRequiredWipCaptureResult | {
    status: 'NOT_REQUIRED';
    manifest_path: null;
    manifest_sha256: null;
    tracked_files: string[];
    untracked_files: string[];
    violations: string[];
};

function getOrchestratorRootFromEventsRoot(eventsRoot: string): string {
    return path.resolve(eventsRoot, '..', '..');
}

export function resolveSplitRequiredArtifactPath(reviewsRoot: string, taskId: string): string {
    return path.join(reviewsRoot, `${taskId}-split-required.json`);
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

export function isSuccessfulSplitRequiredStatusSync(result: TaskQueueStatusSyncResult): boolean {
    return result.outcome === 'updated' || result.outcome === 'already_synced';
}

function writeStableJsonIfChanged(filePath: string, payload: Record<string, unknown>): string {
    const content = redactSecretText(`${JSON.stringify(payload, null, 2)}\n`);
    if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8') !== content) {
        writeReviewArtifactText(filePath, content);
    }
    return createHash('sha256').update(content).digest('hex');
}

function buildSplitRequiredArtifact(params: {
    taskId: string;
    timestampUtc: string;
    guardKind: SplitRequiredGuardKind;
    guardReason: string;
    rawGuardSummary: string;
    preflightPath: string;
    preflightSha256: string;
    materializationPhase: 'pending_status_sync' | 'status_synced' | 'complete' | 'status_sync_failed';
    statusSync: Record<string, unknown>;
    wipCapture: SplitRequiredWipCaptureResult | null;
    guardDetails: Record<string, unknown>;
}): Record<string, unknown> {
    const wipNextActions = params.guardKind === 'full_suite_repair'
        ? []
        : [
            'list_split_required_wip',
            'preview_or_restore_selected_wip_in_child_task',
            'retire_split_required_wip_when_no_longer_needed'
        ];
    return {
        schema_version: 1,
        timestamp_utc: params.timestampUtc,
        task_id: params.taskId,
        status: SPLIT_REQUIRED_STATUS,
        guard_kind: params.guardKind,
        guard_reason: params.guardReason,
        raw_guard_summary: params.rawGuardSummary,
        preflight_path: normalizePath(params.preflightPath),
        preflight_sha256: params.preflightSha256,
        materialization_phase: params.materializationPhase,
        status_sync: params.statusSync,
        next_actions: [
            'create_and_link_child_tasks',
            'rerun_next_step_on_parent_to_transition_to_decomposed',
            ...wipNextActions,
            'or_use_explicit_operator_task_reset_or_discard'
        ],
        wip_capture: params.wipCapture
            ? {
                status: params.wipCapture.status,
                checkout_state: readWipCaptureCheckoutState(params.wipCapture),
                manifest_path: params.wipCapture.manifest_path,
                manifest_sha256: params.wipCapture.manifest_sha256,
                tracked_files: params.wipCapture.tracked_files,
                untracked_files: params.wipCapture.untracked_files,
                violations: params.wipCapture.violations
            }
            : null,
        guard_details: params.guardDetails
    };
}

type SplitRequiredWipCheckoutState = 'suspended' | 'restored' | 'indeterminate';

function readWipCaptureCheckoutState(
    capture: SplitRequiredWipCaptureResult | null
): SplitRequiredWipCheckoutState | null {
    if (!capture) return null;
    const value = (capture as SplitRequiredWipCaptureResult & {
        checkout_state?: SplitRequiredWipCheckoutState;
    }).checkout_state;
    if (value === 'suspended' || value === 'restored' || value === 'indeterminate') {
        return value;
    }
    return capture.status === 'CAPTURED' || capture.status === 'ALREADY_CAPTURED'
        ? 'suspended'
        : null;
}

function readPersistedSuccessfulStatusSync(
    artifact: Record<string, unknown> | null,
    currentStatusSync: TaskQueueStatusSyncResult
): TaskQueueStatusSyncResult | null {
    if (!artifact) {
        return null;
    }
    const phase = String(artifact.materialization_phase || '').trim();
    const persisted = isPlainRecord(artifact.status_sync) ? artifact.status_sync : null;
    const outcome = String(persisted?.outcome || '').trim();
    const previousStatus = readTaskQueueStatusToken(
        persisted?.previous_status == null ? null : String(persisted.previous_status)
    );
    const hasRecoverablePreviousStatus = previousStatus === 'IN_PROGRESS'
        || previousStatus === 'IN_REVIEW';
    const hasRecoverablePendingTransition = phase === 'pending_status_sync'
        && outcome === 'pending'
        && currentStatusSync.outcome === 'already_synced'
        && hasRecoverablePreviousStatus;
    const hasRecoverableFailedRollback = phase === 'status_sync_failed'
        && outcome === 'write_failed'
        && currentStatusSync.outcome === 'already_synced'
        && hasRecoverablePreviousStatus;
    if (
        !hasRecoverablePendingTransition
        && !hasRecoverableFailedRollback
        && (
            (phase !== 'status_synced' && phase !== 'complete')
            || (outcome !== 'updated' && outcome !== 'already_synced')
        )
    ) {
        return null;
    }
    if (String(persisted?.next_status || '').trim() !== SPLIT_REQUIRED_STATUS) {
        return null;
    }
    if (!hasRecoverablePreviousStatus) {
        return null;
    }
    const errorMessage = persisted?.error_message == null
        ? null
        : String(persisted.error_message);
    const recoveredOutcome: 'updated' | 'already_synced' = hasRecoverablePendingTransition
        || hasRecoverableFailedRollback
        || outcome === 'updated'
        ? 'updated'
        : 'already_synced';
    return {
        ...currentStatusSync,
        outcome: recoveredOutcome,
        previous_status: previousStatus,
        next_status: SPLIT_REQUIRED_STATUS,
        error_message: errorMessage
    };
}

function readPersistedWipCapture(params: {
    artifact: Record<string, unknown> | null;
    repoRoot: string;
    taskId: string;
    guardKind: SplitRequiredGuardKind;
    preflightSha256: string;
}): SplitRequiredWipCaptureResult | null {
    if (!params.artifact || String(params.artifact.materialization_phase || '') !== 'complete') {
        return null;
    }
    const persisted = isPlainRecord(params.artifact.wip_capture) ? params.artifact.wip_capture : null;
    const status = String(persisted?.status || '').trim();
    const manifestPathValue = typeof persisted?.manifest_path === 'string'
        ? persisted.manifest_path.trim()
        : '';
    const manifestSha256 = typeof persisted?.manifest_sha256 === 'string'
        ? persisted.manifest_sha256.trim().toLowerCase()
        : '';
    if (
        (status !== 'CAPTURED' && status !== 'ALREADY_CAPTURED')
        || !manifestPathValue
        || !manifestSha256
    ) {
        return null;
    }
    const manifestPath = path.resolve(manifestPathValue);
    let canonicalManifestPath: string;
    let canonicalWipRoot: string;
    try {
        canonicalManifestPath = fs.realpathSync.native(manifestPath);
        canonicalWipRoot = fs.realpathSync.native(resolveWipRoot(params.repoRoot, params.taskId));
    } catch {
        return null;
    }
    if (
        !fs.lstatSync(manifestPath).isFile()
        || (
            canonicalManifestPath !== canonicalWipRoot
            && !canonicalManifestPath.startsWith(`${canonicalWipRoot}${path.sep}`)
        )
        || fileSha256(canonicalManifestPath) !== manifestSha256
    ) {
        return null;
    }
    const manifest = safeReadJson(canonicalManifestPath);
    if (
        !isPlainRecord(manifest)
        || manifest.kind !== 'split_required_wip'
        || manifest.status !== 'suspended'
        || manifest.task_id !== params.taskId
        || manifest.guard_kind !== params.guardKind
        || manifest.preflight_sha256 !== params.preflightSha256
    ) {
        return null;
    }
    const toStringList = (value: unknown): string[] => Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
    return {
        status,
        checkout_state: 'suspended',
        manifest_path: normalizePath(canonicalManifestPath),
        manifest_sha256: manifestSha256,
        tracked_files: toStringList(persisted?.tracked_files),
        untracked_files: toStringList(persisted?.untracked_files),
        violations: toStringList(persisted?.violations)
    } as SplitRequiredWipCaptureResult;
}

function readPersistedSplitRequiredEventState(params: {
    eventsRoot: string;
    taskId: string;
    guardKind: SplitRequiredGuardKind;
    artifactPath: string;
    artifactSha256: string;
    previousStatus: string | null;
}): { latchEventRecorded: boolean; statusEventRecorded: boolean } {
    if (!params.artifactSha256) {
        return { latchEventRecorded: false, statusEventRecorded: false };
    }
    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(
        path.join(params.eventsRoot, `${params.taskId}.jsonl`),
        timelineErrors
    );
    if (timelineErrors.length > 0) {
        return { latchEventRecorded: false, statusEventRecorded: false };
    }
    const artifactPath = normalizePath(params.artifactPath);
    const matchesArtifact = (details: Record<string, unknown>): boolean => (
        normalizePath(String(details.artifact_path || '')) === artifactPath
        && String(details.artifact_sha256 || '').toLowerCase() === params.artifactSha256
        && String(details.guard_kind || '') === params.guardKind
    );
    return {
        latchEventRecorded: timeline.some((event) => (
            event.event_type === 'SPLIT_REQUIRED_LATCHED'
            && String(event.details?.status || '') === SPLIT_REQUIRED_STATUS
            && matchesArtifact(event.details || {})
        )),
        statusEventRecorded: timeline.some((event) => (
            event.event_type === 'STATUS_CHANGED'
            && String(event.details?.previous_status || '') === params.previousStatus
            && String(event.details?.new_status || '') === SPLIT_REQUIRED_STATUS
            && String(event.details?.reason || '') === 'auto_split_guard_latched'
            && matchesArtifact(event.details || {})
        ))
    };
}

function shouldCaptureGenericSplitRequiredWip(guardKind: SplitRequiredGuardKind): guardKind is 'scope_budget' | 'review_cycle' {
    return guardKind === 'scope_budget' || guardKind === 'review_cycle';
}

export function suspendSplitRequiredWipBeforeDecomposition(params: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    latchEvidence: SplitRequiredLatchEvidence;
}): SplitRequiredDecompositionWipSuspensionResult {
    const guardKind = params.latchEvidence.guard_kind;
    if (
        !params.latchEvidence.valid
        || (guardKind !== 'scope_budget' && guardKind !== 'review_cycle')
        || !canCaptureSplitRequiredWip(params.repoRoot)
    ) {
        return {
            status: 'NOT_REQUIRED',
            manifest_path: null,
            manifest_sha256: null,
            tracked_files: [],
            untracked_files: [],
            violations: []
        };
    }

    const retained = reuseRetainedWipForDecomposition({
        repoRoot: params.repoRoot,
        taskId: params.taskId,
        preflightPath: path.join(params.reviewsRoot, `${params.taskId}-preflight.json`),
        guardKind
    });
    if (retained) return retained;

    return captureAndSuspendSplitRequiredWip({
        repoRoot: params.repoRoot,
        taskId: params.taskId,
        preflightPath: path.join(params.reviewsRoot, `${params.taskId}-preflight.json`),
        guardKind,
        guardReason:
            `The active ${guardKind} split-required latch requires parent WIP to remain suspended before child execution.`
    });
}

export function readSplitRequiredLatchEvidence(params: {
    reviewsRoot: string;
    eventsRoot: string;
    taskId: string;
}): SplitRequiredLatchEvidence {
    const artifactPath = resolveSplitRequiredArtifactPath(params.reviewsRoot, params.taskId);
    if (!fileExists(artifactPath)) {
        return {
            valid: false,
            reason: `split-required latch artifact is missing at ${normalizePath(artifactPath)}`,
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: null,
            guard_kind: null
        };
    }

    const artifact = safeReadJson(artifactPath);
    if (!isPlainRecord(artifact)) {
        return {
            valid: false,
            reason: `split-required latch artifact is not a JSON object at ${normalizePath(artifactPath)}`,
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: fileSha256(artifactPath),
            guard_kind: null
        };
    }

    const artifactSha256 = fileSha256(artifactPath);
    const guardKind = typeof artifact.guard_kind === 'string' ? artifact.guard_kind.trim() : '';
    const guardDetails = isPlainRecord(artifact.guard_details) ? artifact.guard_details : null;
    const expectedStatusChangeReason = guardKind === 'review_cycle'
        && String(guardDetails?.event_source || '') === 'record-review-cycle-split-decision'
        ? 'manual_review_cycle_split_decision'
        : 'auto_split_guard_latched';
    const statusSync = isPlainRecord(artifact.status_sync) ? artifact.status_sync : null;
    const statusSyncOutcome = String(statusSync?.outcome || '').trim();
    const materializationPhase = String(artifact.materialization_phase || '').trim();
    if (artifact.task_id !== params.taskId) {
        return {
            valid: false,
            reason: 'split-required latch artifact task_id does not match the requested task',
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            guard_kind: guardKind || null
        };
    }
    if (artifact.status !== SPLIT_REQUIRED_STATUS) {
        return {
            valid: false,
            reason: 'split-required latch artifact status is not SPLIT_REQUIRED',
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            guard_kind: guardKind || null
        };
    }
    if (guardKind !== 'scope_budget' && guardKind !== 'review_cycle' && guardKind !== 'full_suite_repair') {
        return {
            valid: false,
            reason: 'split-required latch artifact guard_kind is not recognized',
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            guard_kind: guardKind || null
        };
    }
    if (materializationPhase && materializationPhase !== 'complete') {
        return {
            valid: false,
            reason: `split-required latch artifact is not complete (phase=${materializationPhase})`,
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            guard_kind: guardKind
        };
    }
    if (String(statusSync?.next_status || '') !== SPLIT_REQUIRED_STATUS) {
        return {
            valid: false,
            reason: 'split-required latch artifact status_sync.next_status is not SPLIT_REQUIRED',
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            guard_kind: guardKind
        };
    }
    if (statusSyncOutcome !== 'updated' && statusSyncOutcome !== 'already_synced') {
        return {
            valid: false,
            reason: `split-required latch artifact status sync is not successful (outcome=${statusSyncOutcome || 'missing'})`,
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            guard_kind: guardKind
        };
    }
    const previousStatus = readTaskQueueStatusToken(
        statusSync?.previous_status == null ? null : String(statusSync.previous_status)
    );
    if (
        statusSyncOutcome === 'updated'
        && previousStatus !== 'IN_PROGRESS'
        && previousStatus !== 'IN_REVIEW'
    ) {
        return {
            valid: false,
            reason: 'split-required latch artifact status_sync.previous_status is not an active task status',
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            guard_kind: guardKind
        };
    }

    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(path.join(params.eventsRoot, `${params.taskId}.jsonl`), timelineErrors);
    const normalizedArtifactPath = normalizePath(artifactPath);
    const hasLatchEvent = timeline.some((event) => {
        const details = event.details || {};
        return event.event_type === 'SPLIT_REQUIRED_LATCHED'
            && String(details.status || '') === SPLIT_REQUIRED_STATUS
            && String(details.guard_kind || '') === guardKind
            && String(details.artifact_sha256 || '').toLowerCase() === artifactSha256
            && normalizePath(String(details.artifact_path || '')) === normalizedArtifactPath;
    });
    if (!hasLatchEvent) {
        return {
            valid: false,
            reason: timelineErrors.length > 0
                ? `split-required latch event is missing or unreadable (${timelineErrors.join('; ')})`
                : 'split-required latch event is missing for the artifact',
            artifact_path: normalizedArtifactPath,
            artifact_sha256: artifactSha256,
            guard_kind: guardKind
        };
    }
    const hasStatusEvent = statusSyncOutcome !== 'updated' || timeline.some((event) => {
        const details = event.details || {};
        return event.event_type === 'STATUS_CHANGED'
            && String(details.previous_status || '') === previousStatus
            && String(details.new_status || '') === SPLIT_REQUIRED_STATUS
            && String(details.reason || '') === expectedStatusChangeReason
            && String(details.guard_kind || '') === guardKind
            && String(details.artifact_sha256 || '').toLowerCase() === artifactSha256
            && normalizePath(String(details.artifact_path || '')) === normalizedArtifactPath;
    });
    if (!hasStatusEvent) {
        return {
            valid: false,
            reason: timelineErrors.length > 0
                ? `split-required status transition event is missing or unreadable (${timelineErrors.join('; ')})`
                : 'split-required status transition event is missing for the artifact',
            artifact_path: normalizedArtifactPath,
            artifact_sha256: artifactSha256,
            guard_kind: guardKind
        };
    }

    return {
        valid: true,
        reason: 'split-required latch artifact and mandatory events are valid',
        artifact_path: normalizedArtifactPath,
        artifact_sha256: artifactSha256,
        guard_kind: guardKind
    };
}

export function hasSplitRequiredClearedEvidence(params: {
    eventsRoot: string;
    taskId: string;
    latchEvidence: SplitRequiredLatchEvidence;
}): boolean {
    if (!params.latchEvidence.valid || !params.latchEvidence.artifact_sha256) {
        return false;
    }

    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(path.join(params.eventsRoot, `${params.taskId}.jsonl`), timelineErrors);
    const normalizedArtifactPath = normalizePath(params.latchEvidence.artifact_path);
    const latchEvent = [...timeline].reverse().find((event) => {
        const details = event.details || {};
        return event.event_type === 'SPLIT_REQUIRED_LATCHED'
            && String(details.status || '') === SPLIT_REQUIRED_STATUS
            && String(details.guard_kind || '') === String(params.latchEvidence.guard_kind || '')
            && String(details.artifact_sha256 || '').toLowerCase() === params.latchEvidence.artifact_sha256
            && normalizePath(String(details.artifact_path || '')) === normalizedArtifactPath;
    });
    if (!latchEvent) {
        return false;
    }

    return timeline.some((event) => {
        const details = event.details || {};
        return event.sequence > latchEvent.sequence
            && event.event_type === 'SPLIT_REQUIRED_CLEARED'
            && String(details.previous_status || '') === SPLIT_REQUIRED_STATUS
            && String(details.new_status || '') === 'DECOMPOSED'
            && String(details.reason || '') === 'child_tasks_linked';
    });
}

function normalizeReviewTypeList(value: unknown): string[] {
    return Array.isArray(value)
        ? value
            .map((entry) => typeof entry === 'string' ? entry.trim().toLowerCase() : '')
            .filter(Boolean)
            .sort()
        : [];
}

export function assessReviewCycleContinuationSplitLatchClearance(params: {
    eventsRoot: string;
    taskId: string;
    latchEvidence: SplitRequiredLatchEvidence;
    continuationAssessment: ReviewCycleContinuationAssessment | null;
}): ReviewCycleContinuationSplitLatchClearance {
    const invalid = (reason: string): ReviewCycleContinuationSplitLatchClearance => ({
        valid: false,
        reason,
        resume_status: null
    });
    const continuation = params.continuationAssessment;
    if (
        !params.latchEvidence.valid
        || params.latchEvidence.guard_kind !== 'review_cycle'
        || !params.latchEvidence.artifact_sha256
    ) {
        return invalid('split-required latch is not a valid review-cycle latch');
    }
    if (
        continuation?.status !== 'ACTIVE'
        || !continuation.artifact
        || !continuation.artifact_sha256
    ) {
        return invalid('review-cycle continuation evidence is not active');
    }

    const latchArtifact = safeReadJson(params.latchEvidence.artifact_path);
    const statusSync = isPlainRecord(latchArtifact?.status_sync) ? latchArtifact.status_sync : null;
    const guardDetails = isPlainRecord(latchArtifact?.guard_details) ? latchArtifact.guard_details : null;
    if (!statusSync || !guardDetails) {
        return invalid('review-cycle latch status or guard details are missing');
    }
    const previousStatus = String(statusSync.previous_status || '').trim().toUpperCase();
    if (previousStatus !== 'IN_PROGRESS' && previousStatus !== 'IN_REVIEW') {
        return invalid(`review-cycle latch previous active status is invalid (${previousStatus || 'missing'})`);
    }

    const baseline = continuation.artifact.baseline;
    if (
        guardDetails.total_non_test_review_count !== baseline.total_non_test_review_count
        || guardDetails.failed_non_test_review_count !== baseline.failed_non_test_review_count
    ) {
        return invalid('review-cycle continuation baseline does not match the latched review counts');
    }
    const latchedExcludedReviewTypes = normalizeReviewTypeList(guardDetails.excluded_review_types);
    const continuationExcludedReviewTypes = normalizeReviewTypeList(baseline.excluded_review_types);
    if (latchedExcludedReviewTypes.join('\n') !== continuationExcludedReviewTypes.join('\n')) {
        return invalid('review-cycle continuation excluded review types do not match the latch');
    }

    const violations = Array.isArray(guardDetails.violations)
        ? guardDetails.violations.filter(isPlainRecord)
        : [];
    if (violations.length === 0) {
        return invalid('review-cycle latch has no authenticated guard violations');
    }
    for (const violation of violations) {
        const metric = String(violation.metric || '').trim();
        const expectedLimit = metric === 'total_non_test_review_count'
            ? baseline.max_total_non_test_reviews
            : metric === 'failed_non_test_review_count'
                ? baseline.max_failed_non_test_reviews
                : null;
        if (expectedLimit == null || violation.limit !== expectedLimit) {
            return invalid(`review-cycle continuation limit does not match latched violation ${metric || 'unknown'}`);
        }
    }

    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(
        path.join(params.eventsRoot, `${params.taskId}.jsonl`),
        timelineErrors
    );
    if (timelineErrors.length > 0) {
        return invalid(`review-cycle latch timeline is unreadable (${timelineErrors.join('; ')})`);
    }
    const normalizedLatchPath = normalizePath(params.latchEvidence.artifact_path);
    const latchEvent = [...timeline].reverse().find((event) => {
        const details = event.details || {};
        return event.event_type === 'SPLIT_REQUIRED_LATCHED'
            && String(details.guard_kind || '') === 'review_cycle'
            && String(details.artifact_sha256 || '').toLowerCase() === params.latchEvidence.artifact_sha256
            && normalizePath(String(details.artifact_path || '')) === normalizedLatchPath;
    });
    if (!latchEvent) {
        return invalid('review-cycle latch event is missing');
    }
    const normalizedContinuationPath = normalizePath(continuation.artifact_path);
    const approvalEvent = timeline.find((event) => {
        const details = event.details || {};
        return event.sequence > latchEvent.sequence
            && event.event_type === 'REVIEW_CYCLE_CONTINUATION_APPROVED'
            && String(details.artifact_sha256 || '').toLowerCase() === continuation.artifact_sha256
            && normalizePath(String(details.artifact_path || '')) === normalizedContinuationPath;
    });
    if (!approvalEvent) {
        return invalid('review-cycle continuation approval does not follow the bound split-required latch');
    }
    const continuationAlreadyConsumed = timeline.some((event) => {
        const details = event.details || {};
        const nextStatus = String(details.new_status || '').trim();
        return event.sequence > approvalEvent.sequence
            && event.event_type === 'SPLIT_REQUIRED_CLEARED'
            && String(details.previous_status || '') === SPLIT_REQUIRED_STATUS
            && (nextStatus === 'IN_PROGRESS' || nextStatus === 'IN_REVIEW')
            && String(details.reason || '') === 'review_cycle_continuation_approved'
            && String(details.guard_kind || '') === 'review_cycle'
            && String(details.latch_artifact_sha256 || '').toLowerCase() === params.latchEvidence.artifact_sha256
            && normalizePath(String(details.latch_artifact_path || '')) === normalizedLatchPath
            && String(details.continuation_artifact_sha256 || '').toLowerCase() === continuation.artifact_sha256
            && normalizePath(String(details.continuation_artifact_path || '')) === normalizedContinuationPath;
    });
    if (continuationAlreadyConsumed) {
        return invalid('review-cycle continuation was already consumed for the current split-required latch');
    }

    return {
        valid: true,
        reason: 'active one-shot continuation is bound to the current review-cycle latch',
        resume_status: previousStatus
    };
}

export function hasReviewCycleContinuationClearedEvidence(params: {
    eventsRoot: string;
    taskId: string;
    currentStatus: string;
    latchEvidence: SplitRequiredLatchEvidence;
}): boolean {
    if (
        !params.latchEvidence.valid
        || params.latchEvidence.guard_kind !== 'review_cycle'
        || !params.latchEvidence.artifact_sha256
    ) {
        return false;
    }
    const currentStatus = readTaskQueueStatusToken(params.currentStatus);
    if (currentStatus !== 'IN_PROGRESS' && currentStatus !== 'IN_REVIEW') {
        return false;
    }
    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(
        path.join(params.eventsRoot, `${params.taskId}.jsonl`),
        timelineErrors
    );
    if (timelineErrors.length > 0) {
        return false;
    }
    const normalizedLatchPath = normalizePath(params.latchEvidence.artifact_path);
    const latchEvent = [...timeline].reverse().find((event) => {
        const details = event.details || {};
        return event.event_type === 'SPLIT_REQUIRED_LATCHED'
            && String(details.guard_kind || '') === 'review_cycle'
            && String(details.artifact_sha256 || '').toLowerCase() === params.latchEvidence.artifact_sha256
            && normalizePath(String(details.artifact_path || '')) === normalizedLatchPath;
    });
    if (!latchEvent) {
        return false;
    }
    return timeline.some((event) => {
        const details = event.details || {};
        const nextStatus = String(details.new_status || '').trim();
        return event.sequence > latchEvent.sequence
            && event.event_type === 'SPLIT_REQUIRED_CLEARED'
            && String(details.previous_status || '') === SPLIT_REQUIRED_STATUS
            && nextStatus === currentStatus
            && String(details.reason || '') === 'review_cycle_continuation_approved'
            && String(details.guard_kind || '') === 'review_cycle'
            && String(details.latch_artifact_sha256 || '').toLowerCase() === params.latchEvidence.artifact_sha256
            && normalizePath(String(details.latch_artifact_path || '')) === normalizedLatchPath
            && typeof details.continuation_artifact_sha256 === 'string'
            && String(details.continuation_artifact_sha256).length > 0
            && typeof details.continuation_artifact_path === 'string'
            && String(details.continuation_artifact_path).length > 0;
    });
}

export function hasCompletedDecomposedParentAfterSplitRequiredClear(params: {
    eventsRoot: string;
    taskId: string;
    latchEvidence: SplitRequiredLatchEvidence;
}): boolean {
    if (!params.latchEvidence.valid || !params.latchEvidence.artifact_sha256) {
        return false;
    }

    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(path.join(params.eventsRoot, `${params.taskId}.jsonl`), timelineErrors);
    const normalizedArtifactPath = normalizePath(params.latchEvidence.artifact_path);
    const latchEvent = [...timeline].reverse().find((event) => {
        const details = event.details || {};
        return event.event_type === 'SPLIT_REQUIRED_LATCHED'
            && String(details.status || '') === SPLIT_REQUIRED_STATUS
            && String(details.guard_kind || '') === String(params.latchEvidence.guard_kind || '')
            && String(details.artifact_sha256 || '').toLowerCase() === params.latchEvidence.artifact_sha256
            && normalizePath(String(details.artifact_path || '')) === normalizedArtifactPath;
    });
    if (!latchEvent) {
        return false;
    }

    const clearEvent = timeline.find((event) => {
        const details = event.details || {};
        return event.sequence > latchEvent.sequence
            && event.event_type === 'SPLIT_REQUIRED_CLEARED'
            && String(details.previous_status || '') === SPLIT_REQUIRED_STATUS
            && String(details.new_status || '') === 'DECOMPOSED'
            && String(details.reason || '') === 'child_tasks_linked';
    });
    if (!clearEvent) {
        return false;
    }

    return timeline.some((event) => {
        const details = event.details || {};
        return event.sequence > clearEvent.sequence
            && event.event_type === 'DECOMPOSED_PARENT_COMPLETED'
            && String(details.previous_status || '') === 'DECOMPOSED'
            && String(details.new_status || '') === 'DONE'
            && String(details.reason || '') === 'explicit_children_done';
    });
}

export function hasGateOwnedDecomposedParentCompletionEvidence(params: {
    eventsRoot: string;
    taskId: string;
}): boolean {
    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(path.join(params.eventsRoot, `${params.taskId}.jsonl`), timelineErrors);
    const completionEvent = [...timeline].reverse().find((event) => {
        const details = event.details || {};
        return event.event_type === 'DECOMPOSED_PARENT_COMPLETED'
            && String(details.previous_status || '') === 'DECOMPOSED'
            && String(details.new_status || '') === 'DONE'
            && String(details.reason || '') === 'explicit_children_done';
    });
    if (!completionEvent) {
        return false;
    }
    return timeline.some((event) => {
        const details = event.details || {};
        return event.sequence < completionEvent.sequence
            && event.event_type === 'STATUS_CHANGED'
            && String(details.previous_status || '') === 'DECOMPOSED'
            && String(details.new_status || '') === 'DONE'
            && String(details.reason || '') === 'decomposed_explicit_children_done';
    });
}

export function sanitizeScopeBudgetGuardSummary(evaluation: ScopeBudgetGuardEvaluation): string {
    if (evaluation.violations.length === 0) {
        return evaluation.summary_line;
    }
    const metrics = evaluation.violations
        .filter((violation) => violation.severity === 'BLOCK')
        .map((violation) => violation.metric)
        .join(', ');
    return `Scope budget guard: BLOCK (configured blocking budget exceeded: ${metrics || 'unknown'})`;
}

export function sanitizeReviewCycleAutoSplitSummary(evaluation: ReviewCycleGuardEvaluation): string {
    if (evaluation.violations.length === 0) {
        return evaluation.summary_line;
    }
    const metrics = evaluation.violations.map((violation) => violation.metric).join(', ');
    return `Review cycle guard: ${evaluation.action} (configured review-cycle limit exceeded: ${metrics})`;
}

export interface MaterializeSplitRequiredLatchParams {
    repoRoot: string;
    eventsRoot: string;
    reviewsRoot: string;
    taskId: string;
    guardKind: SplitRequiredGuardKind;
    guardReason: string;
    rawGuardSummary: string;
    preflightPath: string;
    guardDetails: Record<string, unknown>;
    faultInjection?: (boundary: SplitRequiredLatchFaultBoundary) => void;
}

export function materializeSplitRequiredLatch(
    params: MaterializeSplitRequiredLatchParams
): SplitRequiredLatchResult {
    return materializeSplitRequiredLatchTransaction(params);
}

function materializeSplitRequiredLatchTransaction(
    params: MaterializeSplitRequiredLatchParams
): SplitRequiredLatchResult {
    const artifactPath = resolveSplitRequiredArtifactPath(params.reviewsRoot, params.taskId);
    const preflightSha256 = fileSha256(params.preflightPath) || '';
    const orchestratorRoot = getOrchestratorRootFromEventsRoot(params.eventsRoot);
    const taskPath = path.join(params.repoRoot, TASK_QUEUE_FILENAME);
    return withTaskQueueTransaction(taskPath, (message) => {
        const statusSync: TaskQueueStatusSyncResult = {
            outcome: 'write_failed',
            task_path: normalizePath(taskPath),
            task_id: params.taskId,
            previous_status: null,
            next_status: SPLIT_REQUIRED_STATUS,
            error_message: message,
            status_contract: buildTaskQueueStatusContract(params.taskId)
        };
        return {
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: fileSha256(artifactPath) || '',
            status_sync: statusSync,
            status_event_recorded: false,
            latch_event_recorded: false,
            wip_capture: null
        };
    }, () => {
        const existing = safeReadJson(artifactPath);
        const existingArtifactSha256 = fileSha256(artifactPath) || '';
        const taskStatusBeforeSync = readTaskQueueStatusToken(
            readTaskQueueEntries(params.repoRoot).get(params.taskId)?.status || null
        );
        const existingCurrent =
            existing?.task_id === params.taskId
            && existing?.status === SPLIT_REQUIRED_STATUS
            && existing?.guard_kind === params.guardKind
            && existing?.preflight_sha256 === preflightSha256;
        const existingEventState = readPersistedSplitRequiredEventState({
            eventsRoot: params.eventsRoot,
            taskId: params.taskId,
            guardKind: params.guardKind,
            artifactPath,
            artifactSha256: existingArtifactSha256,
            previousStatus: isPlainRecord(existing?.status_sync)
                && existing.status_sync.previous_status != null
                ? readTaskQueueStatusToken(String(existing.status_sync.previous_status))
                : null
        });
        const existingTransitionBound = Boolean(
            existingArtifactSha256
            && existing?.task_id === params.taskId
            && existing?.status === SPLIT_REQUIRED_STATUS
            && existing?.guard_kind === params.guardKind
            && existing?.materialization_phase === 'complete'
            && existingEventState.latchEventRecorded
            && existingEventState.statusEventRecorded
        );
        const timestampUtc = existingCurrent
            && taskStatusBeforeSync === SPLIT_REQUIRED_STATUS
            && typeof existing?.timestamp_utc === 'string'
            ? existing.timestamp_utc
            : new Date().toISOString();
        if (!existingCurrent || taskStatusBeforeSync !== SPLIT_REQUIRED_STATUS) {
            writeStableJsonIfChanged(artifactPath, buildSplitRequiredArtifact({
                taskId: params.taskId,
                timestampUtc,
                guardKind: params.guardKind,
                guardReason: params.guardReason,
                rawGuardSummary: params.rawGuardSummary,
                preflightPath: params.preflightPath,
                preflightSha256,
                materializationPhase: 'pending_status_sync',
                statusSync: {
                    outcome: 'pending',
                    previous_status: taskStatusBeforeSync,
                    next_status: SPLIT_REQUIRED_STATUS,
                    error_message: null
                },
                wipCapture: null,
                guardDetails: params.guardDetails
            }));
        }
        const currentStatusSync = syncTaskQueueStatusDetailed(params.repoRoot, params.taskId, SPLIT_REQUIRED_STATUS);
        if (!isSuccessfulSplitRequiredStatusSync(currentStatusSync)) {
            const failedArtifactSha256 = writeStableJsonIfChanged(artifactPath, buildSplitRequiredArtifact({
                taskId: params.taskId,
                timestampUtc,
                guardKind: params.guardKind,
                guardReason: params.guardReason,
                rawGuardSummary: params.rawGuardSummary,
                preflightPath: params.preflightPath,
                preflightSha256,
                materializationPhase: 'status_sync_failed',
                statusSync: {
                    outcome: currentStatusSync.outcome,
                    previous_status: currentStatusSync.previous_status,
                    next_status: currentStatusSync.next_status,
                    error_message: currentStatusSync.error_message
                },
                wipCapture: null,
                guardDetails: params.guardDetails
            }));
            return {
                artifact_path: normalizePath(artifactPath),
                artifact_sha256: failedArtifactSha256,
                status_sync: currentStatusSync,
                status_event_recorded: false,
                latch_event_recorded: false,
                wip_capture: null
            };
        }
        const persistedStatusSync = currentStatusSync.outcome === 'already_synced'
            && (existingCurrent || existingTransitionBound)
            ? readPersistedSuccessfulStatusSync(existing, currentStatusSync)
            : null;
        const statusSync = persistedStatusSync || currentStatusSync;
        let statusCheckpointPending = !persistedStatusSync;
        const persistedWipCapture = persistedStatusSync
            ? readPersistedWipCapture({
                artifact: existing,
                repoRoot: params.repoRoot,
                taskId: params.taskId,
                guardKind: params.guardKind,
                preflightSha256
            })
            : null;
        const persistedArtifactSha256 = persistedStatusSync
            && existingCurrent
            && String(existing?.materialization_phase || '') === 'complete'
            ? existingArtifactSha256
            : '';
        const persistedEventState = readPersistedSplitRequiredEventState({
            eventsRoot: params.eventsRoot,
            taskId: params.taskId,
            guardKind: params.guardKind,
            artifactPath,
            artifactSha256: persistedArtifactSha256,
            previousStatus: statusSync.previous_status
        });
        const completeLatchAfterStatusSync = (
            initialState: {
                artifactSha256: string;
                statusEventRecorded: boolean;
                latchEventRecorded: boolean;
                wipCapture: SplitRequiredWipCaptureResult | null;
            },
            recoveryAttempted: boolean,
            faultInjection: MaterializeSplitRequiredLatchParams['faultInjection'],
            priorErrorMessage: string | null = null
        ): SplitRequiredLatchResult => {
            let {
                artifactSha256,
                statusEventRecorded,
                latchEventRecorded,
                wipCapture
            } = initialState;
            let injectedFaultBoundary: SplitRequiredLatchFaultBoundary | null = null;
            const injectFault = (boundary: SplitRequiredLatchFaultBoundary): void => {
                if (!faultInjection) {
                    return;
                }
                try {
                    faultInjection(boundary);
                } catch (error: unknown) {
                    injectedFaultBoundary = boundary;
                    throw error;
                }
            };
            try {
                if (statusCheckpointPending) {
                    writeStableJsonIfChanged(artifactPath, buildSplitRequiredArtifact({
                        taskId: params.taskId,
                        timestampUtc,
                        guardKind: params.guardKind,
                        guardReason: params.guardReason,
                        rawGuardSummary: params.rawGuardSummary,
                        preflightPath: params.preflightPath,
                        preflightSha256,
                        materializationPhase: 'status_synced',
                        statusSync: {
                            outcome: statusSync.outcome,
                            previous_status: statusSync.previous_status,
                            next_status: statusSync.next_status,
                            error_message: statusSync.error_message
                        },
                        wipCapture: null,
                        guardDetails: params.guardDetails
                    }));
                    statusCheckpointPending = false;
                }
                injectFault('after_status_sync');
                if (
                    !wipCapture
                    && shouldCaptureGenericSplitRequiredWip(params.guardKind)
                    && canCaptureSplitRequiredWip(params.repoRoot)
                ) {
                    wipCapture = captureAndSuspendSplitRequiredWip({
                        repoRoot: params.repoRoot,
                        taskId: params.taskId,
                        preflightPath: params.preflightPath,
                        guardKind: params.guardKind,
                        guardReason: params.guardReason
                    });
                    if (wipCapture.status === 'BLOCKED') {
                        throw new Error(
                            `split-required WIP capture failed: ${wipCapture.violations.join('; ') || 'unknown violation'}`
                        );
                    }
                }
                injectFault('after_wip_capture');
                const artifact = buildSplitRequiredArtifact({
                    taskId: params.taskId,
                    timestampUtc,
                    guardKind: params.guardKind,
                    guardReason: params.guardReason,
                    rawGuardSummary: params.rawGuardSummary,
                    preflightPath: params.preflightPath,
                    preflightSha256,
                    materializationPhase: 'complete',
                    statusSync: {
                        outcome: statusSync.outcome,
                        previous_status: statusSync.previous_status,
                        next_status: statusSync.next_status,
                        error_message: statusSync.error_message
                    },
                    wipCapture,
                    guardDetails: params.guardDetails
                });
                artifactSha256 = writeStableJsonIfChanged(artifactPath, artifact);
                const currentEventState = readPersistedSplitRequiredEventState({
                    eventsRoot: params.eventsRoot,
                    taskId: params.taskId,
                    guardKind: params.guardKind,
                    artifactPath,
                    artifactSha256,
                    previousStatus: statusSync.previous_status
                });
                latchEventRecorded = currentEventState.latchEventRecorded;
                statusEventRecorded = currentEventState.statusEventRecorded;
                injectFault('after_latch_artifact');
                if (!latchEventRecorded) {
                    appendMandatoryTaskEvent(
                        orchestratorRoot,
                        params.taskId,
                        'SPLIT_REQUIRED_LATCHED',
                        'BLOCKED',
                        'Auto-split guard latched the parent task.',
                        {
                            status: SPLIT_REQUIRED_STATUS,
                            guard_kind: params.guardKind,
                            guard_reason: params.guardReason,
                            artifact_path: normalizePath(artifactPath),
                            artifact_sha256: artifactSha256,
                            preflight_path: normalizePath(params.preflightPath),
                            preflight_sha256: preflightSha256,
                            status_sync_outcome: statusSync.outcome,
                            wip_manifest_path: wipCapture?.manifest_path || null,
                            wip_manifest_sha256: wipCapture?.manifest_sha256 || null,
                            wip_capture_status: wipCapture?.status || null
                        },
                        { actor: 'orchestrator' }
                    );
                    latchEventRecorded = true;
                }
                injectFault('after_latch_event');

                if (statusSync.outcome === 'updated' && !statusEventRecorded) {
                    appendMandatoryTaskEvent(
                        orchestratorRoot,
                        params.taskId,
                        'STATUS_CHANGED',
                        'INFO',
                        `Task status changed: ${statusSync.previous_status || 'UNKNOWN'} -> ${SPLIT_REQUIRED_STATUS}.`,
                        {
                            previous_status: statusSync.previous_status || 'UNKNOWN',
                            new_status: SPLIT_REQUIRED_STATUS,
                            reason: 'auto_split_guard_latched',
                            guard_kind: params.guardKind,
                            artifact_path: normalizePath(artifactPath),
                            artifact_sha256: artifactSha256
                        },
                        { actor: 'orchestrator' }
                    );
                    statusEventRecorded = true;
                }
                injectFault('after_status_event');
            } catch (error: unknown) {
                const currentErrorMessage = error instanceof Error ? error.message : String(error);
                const errorMessage = priorErrorMessage
                    ? `${priorErrorMessage}; forward recovery failed: ${currentErrorMessage}`
                    : currentErrorMessage;
                const checkoutOwnedByCapture = Boolean(
                    wipCapture?.manifest_path
                    && readWipCaptureCheckoutState(wipCapture) === 'suspended'
                );
                const reusableWipCapture = wipCapture?.status === 'CAPTURED'
                    || wipCapture?.status === 'ALREADY_CAPTURED';
                if (injectedFaultBoundary === 'after_status_event') {
                    return {
                        artifact_path: normalizePath(artifactPath),
                        artifact_sha256: artifactSha256,
                        status_sync: statusSync,
                        status_event_recorded: statusEventRecorded,
                        latch_event_recorded: latchEventRecorded,
                        wip_capture: wipCapture
                    };
                }
                if (
                    !recoveryAttempted
                    && (injectedFaultBoundary || (checkoutOwnedByCapture && reusableWipCapture))
                ) {
                    return completeLatchAfterStatusSync({
                        artifactSha256,
                        statusEventRecorded,
                        latchEventRecorded,
                        wipCapture
                    }, true, undefined, errorMessage);
                }
                let rollbackMessage: string | null = null;
                if (!checkoutOwnedByCapture && statusSync.outcome === 'updated' && statusSync.previous_status) {
                    const rollback = syncTaskQueueStatusDetailed(params.repoRoot, params.taskId, statusSync.previous_status);
                    rollbackMessage = `rollback=${rollback.outcome}${rollback.error_message ? ` (${rollback.error_message})` : ''}`;
                }
                const recoverableErrorMessage = checkoutOwnedByCapture
                    ? `${errorMessage}; preserved SPLIT_REQUIRED status and task-owned suspended WIP for recoverable retry`
                    : errorMessage;
                const failureStatusSync: TaskQueueStatusSyncResult = {
                    ...statusSync,
                    outcome: 'write_failed',
                    error_message: rollbackMessage
                        ? `${recoverableErrorMessage}; ${rollbackMessage}`
                        : recoverableErrorMessage
                };
                try {
                    artifactSha256 = writeStableJsonIfChanged(artifactPath, buildSplitRequiredArtifact({
                        taskId: params.taskId,
                        timestampUtc,
                        guardKind: params.guardKind,
                        guardReason: params.guardReason,
                        rawGuardSummary: params.rawGuardSummary,
                        preflightPath: params.preflightPath,
                        preflightSha256,
                        materializationPhase: 'status_sync_failed',
                        statusSync: {
                            outcome: failureStatusSync.outcome,
                            previous_status: failureStatusSync.previous_status,
                            next_status: failureStatusSync.next_status,
                            error_message: failureStatusSync.error_message
                        },
                        wipCapture,
                        guardDetails: params.guardDetails
                    }));
                } catch {
                    artifactSha256 = artifactSha256 || '';
                }
                return {
                    artifact_path: normalizePath(artifactPath),
                    artifact_sha256: artifactSha256,
                    status_sync: failureStatusSync,
                    status_event_recorded: statusEventRecorded,
                    latch_event_recorded: latchEventRecorded,
                    wip_capture: wipCapture
                };
            }

            return {
                artifact_path: normalizePath(artifactPath),
                artifact_sha256: artifactSha256,
                status_sync: statusSync,
                status_event_recorded: statusEventRecorded,
                latch_event_recorded: latchEventRecorded,
                wip_capture: wipCapture
            };
        };
        return completeLatchAfterStatusSync({
            artifactSha256: persistedArtifactSha256,
            statusEventRecorded: persistedEventState.statusEventRecorded,
            latchEventRecorded: persistedEventState.latchEventRecorded,
            wipCapture: persistedWipCapture
        }, false, params.faultInjection);
    });
}
