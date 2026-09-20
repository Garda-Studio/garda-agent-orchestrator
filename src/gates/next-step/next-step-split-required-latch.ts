import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { redactSecretText } from '../../core/redaction';
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
    materializationPhase: 'pending_status_sync' | 'complete' | 'status_sync_failed';
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

    return {
        valid: true,
        reason: 'split-required latch artifact and event are valid',
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

export function materializeSplitRequiredLatch(params: {
    repoRoot: string;
    eventsRoot: string;
    reviewsRoot: string;
    taskId: string;
    guardKind: SplitRequiredGuardKind;
    guardReason: string;
    rawGuardSummary: string;
    preflightPath: string;
    guardDetails: Record<string, unknown>;
}): SplitRequiredLatchResult {
    const artifactPath = resolveSplitRequiredArtifactPath(params.reviewsRoot, params.taskId);
    const existing = safeReadJson(artifactPath);
    const preflightSha256 = fileSha256(params.preflightPath) || '';
    const orchestratorRoot = getOrchestratorRootFromEventsRoot(params.eventsRoot);
    const existingCurrent =
        existing?.task_id === params.taskId
        && existing?.status === SPLIT_REQUIRED_STATUS
        && existing?.guard_kind === params.guardKind
        && existing?.preflight_sha256 === preflightSha256;
    const timestampUtc = existingCurrent && typeof existing?.timestamp_utc === 'string'
        ? existing.timestamp_utc
        : new Date().toISOString();
    if (!existingCurrent) {
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
                previous_status: null,
                next_status: SPLIT_REQUIRED_STATUS,
                error_message: null
            },
            wipCapture: null,
            guardDetails: params.guardDetails
        }));
    }
    const statusSync = syncTaskQueueStatusDetailed(params.repoRoot, params.taskId, SPLIT_REQUIRED_STATUS);
    let statusEventRecorded = false;
    let latchEventRecorded = false;
    if (!isSuccessfulSplitRequiredStatusSync(statusSync)) {
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
                outcome: statusSync.outcome,
                previous_status: statusSync.previous_status,
                next_status: statusSync.next_status,
                error_message: statusSync.error_message
            },
            wipCapture: null,
            guardDetails: params.guardDetails
        }));
        return {
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: failedArtifactSha256,
            status_sync: statusSync,
            status_event_recorded: false,
            latch_event_recorded: false,
            wip_capture: null
        };
    }

    let artifactSha256 = '';
    let wipCapture: SplitRequiredWipCaptureResult | null = null;
    try {
        if (shouldCaptureGenericSplitRequiredWip(params.guardKind) && canCaptureSplitRequiredWip(params.repoRoot)) {
            wipCapture = captureAndSuspendSplitRequiredWip({
                repoRoot: params.repoRoot,
                taskId: params.taskId,
                preflightPath: params.preflightPath,
                guardKind: params.guardKind,
                guardReason: params.guardReason
            });
            if (wipCapture.status === 'BLOCKED') {
                throw new Error(`split-required WIP capture failed: ${wipCapture.violations.join('; ') || 'unknown violation'}`);
            }
        }
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
        const latchEvidenceAfterArtifact = readSplitRequiredLatchEvidence({
            reviewsRoot: params.reviewsRoot,
            eventsRoot: params.eventsRoot,
            taskId: params.taskId
        });
        if (!latchEvidenceAfterArtifact.valid) {
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

        if (statusSync.outcome === 'updated') {
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
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        let rollbackMessage: string | null = null;
        if (statusSync.outcome === 'updated' && statusSync.previous_status) {
            const rollback = syncTaskQueueStatusDetailed(params.repoRoot, params.taskId, statusSync.previous_status);
            rollbackMessage = `rollback=${rollback.outcome}${rollback.error_message ? ` (${rollback.error_message})` : ''}`;
        }
        const failureStatusSync: TaskQueueStatusSyncResult = {
            ...statusSync,
            outcome: 'write_failed',
            error_message: rollbackMessage ? `${errorMessage}; ${rollbackMessage}` : errorMessage
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
}
