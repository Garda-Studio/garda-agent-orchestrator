import * as path from 'node:path';

import {
    appendMandatoryTaskEvent
} from '../../gate-runtime/task-events';
import {
    syncTaskQueueStatusDetailed,
    type TaskQueueStatusSyncResult
} from '../../cli/commands/gate-flows/task/task-queue-sync';
import {
    SPLIT_REQUIRED_STATUS
} from './next-step-task-queue';
import type {
    ReviewCycleContinuationAssessment
} from '../review-cycle/review-cycle-continuation';
import type {
    SplitRequiredLatchEvidence
} from './next-step-split-required-latch';
import {
    rollbackDecomposedParentStatusSync,
    syncDecomposedParentsToDone,
    syncTaskQueueStatusFromStrictDecompositionToDecomposed,
    syncTaskQueueStatusFromSplitRequiredToDecomposed,
    type DecomposedParentBatchStatusSyncResult
} from './next-step-task-queue-status-sync';

export interface SplitRequiredLatchTransitionEvidence {
    guard_kind: string | null;
    artifact_path: string;
    artifact_sha256: string | null;
}

export type { DecomposedParentBatchStatusSyncResult } from './next-step-task-queue-status-sync';

function getOrchestratorRootFromEventsRoot(eventsRoot: string): string {
    return path.resolve(eventsRoot, '..', '..');
}

export function transitionSplitRequiredParentToDecomposed(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
}): TaskQueueStatusSyncResult {
    const syncResult = syncTaskQueueStatusFromSplitRequiredToDecomposed(params.repoRoot, params.taskId);
    if (syncResult.outcome === 'updated') {
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'STATUS_CHANGED',
            'INFO',
            `Task status changed: ${syncResult.previous_status || SPLIT_REQUIRED_STATUS} -> DECOMPOSED.`,
            {
                previous_status: syncResult.previous_status || SPLIT_REQUIRED_STATUS,
                new_status: 'DECOMPOSED',
                reason: 'split_required_children_linked'
            },
            { actor: 'orchestrator' }
        );
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'SPLIT_REQUIRED_CLEARED',
            'INFO',
            'Split-required latch cleared because child tasks are linked.',
            {
                previous_status: syncResult.previous_status || SPLIT_REQUIRED_STATUS,
                new_status: 'DECOMPOSED',
                reason: 'child_tasks_linked'
            },
            { actor: 'orchestrator' }
        );
    }
    return syncResult;
}

export function transitionSplitRequiredParentToReviewCycleContinuation(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    resumeStatus: 'IN_PROGRESS' | 'IN_REVIEW';
    latchEvidence: SplitRequiredLatchEvidence;
    continuationAssessment: ReviewCycleContinuationAssessment;
}): TaskQueueStatusSyncResult {
    const syncResult = syncTaskQueueStatusDetailed(params.repoRoot, params.taskId, params.resumeStatus);
    if (syncResult.outcome === 'updated') {
        const orchestratorRoot = getOrchestratorRootFromEventsRoot(params.eventsRoot);
        try {
            appendMandatoryTaskEvent(
                orchestratorRoot,
                params.taskId,
                'SPLIT_REQUIRED_CLEARED',
                'INFO',
                'Review-cycle split-required latch cleared by an authenticated one-shot continuation.',
                {
                    previous_status: syncResult.previous_status || SPLIT_REQUIRED_STATUS,
                    new_status: params.resumeStatus,
                    reason: 'review_cycle_continuation_approved',
                    guard_kind: 'review_cycle',
                    latch_artifact_path: params.latchEvidence.artifact_path,
                    latch_artifact_sha256: params.latchEvidence.artifact_sha256,
                    continuation_artifact_path: params.continuationAssessment.artifact_path,
                    continuation_artifact_sha256: params.continuationAssessment.artifact_sha256
                },
                { actor: 'orchestrator' }
            );
        } catch (error: unknown) {
            const rollback = syncTaskQueueStatusDetailed(
                params.repoRoot,
                params.taskId,
                syncResult.previous_status || SPLIT_REQUIRED_STATUS
            );
            return {
                ...syncResult,
                outcome: 'write_failed',
                error_message:
                    `Mandatory SPLIT_REQUIRED_CLEARED append failed after TASK.md status sync: ` +
                    `${error instanceof Error ? error.message : String(error)}; ` +
                    `rollback=${rollback.outcome}${rollback.error_message ? ` (${rollback.error_message})` : ''}`
            };
        }
        try {
            appendMandatoryTaskEvent(
                orchestratorRoot,
                params.taskId,
                'STATUS_CHANGED',
                'INFO',
                `Task status changed: ${syncResult.previous_status || SPLIT_REQUIRED_STATUS} -> ${params.resumeStatus}.`,
                {
                    previous_status: syncResult.previous_status || SPLIT_REQUIRED_STATUS,
                    new_status: params.resumeStatus,
                    reason: 'review_cycle_continuation_approved'
                },
                { actor: 'orchestrator' }
            );
        } catch (error: unknown) {
            return {
                ...syncResult,
                outcome: 'write_failed',
                error_message:
                    'Mandatory STATUS_CHANGED append failed after authoritative review-cycle latch clearance; ' +
                    `the recovered TASK.md status was preserved because SPLIT_REQUIRED_CLEARED is committed: ` +
                    `${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
    return syncResult;
}

export function transitionStrictDecompositionParentToDecomposed(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    proposedChildTaskIds: string[];
    expectedChildProfile?: string;
}): TaskQueueStatusSyncResult {
    const syncResult = syncTaskQueueStatusFromStrictDecompositionToDecomposed(
        params.repoRoot,
        params.taskId,
        params.proposedChildTaskIds,
        params.expectedChildProfile || 'strict'
    );
    if (syncResult.outcome === 'updated') {
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'STATUS_CHANGED',
            'INFO',
            `Task status changed: ${syncResult.previous_status || 'UNKNOWN'} -> DECOMPOSED.`,
            {
                previous_status: syncResult.previous_status || 'UNKNOWN',
                new_status: 'DECOMPOSED',
                reason: 'strict_decomposition_children_linked'
            },
            { actor: 'orchestrator' }
        );
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'STRICT_DECOMPOSITION_SPLIT_ROUTED',
            'INFO',
            'Strict split-required decision routed the parent through linked child tasks.',
            {
                previous_status: syncResult.previous_status || 'UNKNOWN',
                new_status: 'DECOMPOSED',
                reason: 'child_tasks_linked'
            },
            { actor: 'orchestrator' }
        );
    }
    return syncResult;
}

export function restoreSplitRequiredParentFromPermanentLatch(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    latchEvidence: SplitRequiredLatchTransitionEvidence;
}): TaskQueueStatusSyncResult {
    const syncResult = syncTaskQueueStatusDetailed(params.repoRoot, params.taskId, SPLIT_REQUIRED_STATUS);
    if (syncResult.outcome === 'updated') {
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'STATUS_CHANGED',
            'INFO',
            `Task status changed: ${syncResult.previous_status || 'UNKNOWN'} -> ${SPLIT_REQUIRED_STATUS}.`,
            {
                previous_status: syncResult.previous_status || 'UNKNOWN',
                new_status: SPLIT_REQUIRED_STATUS,
                reason: 'split_required_permanent_latch_restored',
                guard_kind: params.latchEvidence.guard_kind,
                artifact_path: params.latchEvidence.artifact_path,
                artifact_sha256: params.latchEvidence.artifact_sha256
            },
            { actor: 'orchestrator' }
        );
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'SPLIT_REQUIRED_RESTORED',
            'BLOCKED',
            'Permanent split-required latch restored the parent task status.',
            {
                previous_status: syncResult.previous_status || 'UNKNOWN',
                new_status: SPLIT_REQUIRED_STATUS,
                guard_kind: params.latchEvidence.guard_kind,
                artifact_path: params.latchEvidence.artifact_path,
                artifact_sha256: params.latchEvidence.artifact_sha256
            },
            { actor: 'orchestrator' }
        );
    }
    return syncResult;
}

export function transitionDecomposedParentsToDone(params: {
    repoRoot: string;
    eventsRoot: string;
    rootTaskId: string;
    taskIds: string[];
}): DecomposedParentBatchStatusSyncResult {
    const syncResult = syncDecomposedParentsToDone(params.repoRoot, params.rootTaskId, params.taskIds);
    if (syncResult.outcome === 'updated') {
        const statusEventCommittedTaskIds = new Set<string>();
        try {
            const orchestratorRoot = getOrchestratorRootFromEventsRoot(params.eventsRoot);
            for (const taskId of syncResult.updated_task_ids) {
                const previousStatus = syncResult.previous_statuses[taskId] || 'DECOMPOSED';
                appendMandatoryTaskEvent(
                    orchestratorRoot,
                    taskId,
                    'STATUS_CHANGED',
                    'INFO',
                    `Task status changed: ${previousStatus} -> DONE.`,
                    {
                        previous_status: previousStatus,
                        new_status: 'DONE',
                        reason: 'decomposed_explicit_children_done'
                    },
                    { actor: 'orchestrator' }
                );
                statusEventCommittedTaskIds.add(taskId);
                appendMandatoryTaskEvent(
                    orchestratorRoot,
                    taskId,
                    'DECOMPOSED_PARENT_COMPLETED',
                    'INFO',
                    'Decomposed parent completed because every explicit child task is DONE.',
                    {
                        previous_status: previousStatus,
                        new_status: 'DONE',
                        reason: 'explicit_children_done'
                    },
                    { actor: 'orchestrator' }
                );
            }
        } catch (error: unknown) {
            const orchestratorRoot = getOrchestratorRootFromEventsRoot(params.eventsRoot);
            const compensation = compensateDecomposedParentStatusEvents({
                orchestratorRoot,
                taskIds: syncResult.updated_task_ids,
                previousStatuses: syncResult.previous_statuses,
                committedTaskIds: statusEventCommittedTaskIds
            });
            const uncompensatedCommittedTaskIds = syncResult.updated_task_ids.filter(
                (taskId) => statusEventCommittedTaskIds.has(taskId) && !compensation.compensatedTaskIds.has(taskId)
            );
            const rollbackTaskIds = syncResult.updated_task_ids.filter(
                (taskId) => !uncompensatedCommittedTaskIds.includes(taskId)
            );
            const rollbackError = rollbackDecomposedParentStatusSync(
                params.repoRoot,
                rollbackTaskIds,
                syncResult.previous_statuses
            );
            const remainingUpdatedTaskIds = rollbackError ? syncResult.updated_task_ids : uncompensatedCommittedTaskIds;
            const compensationMessage = compensation.errorMessages.length > 0
                ? ` Compensation event append failed: ${compensation.errorMessages.join('; ')}.`
                : (statusEventCommittedTaskIds.size > 0
                    ? ` Compensating STATUS_CHANGED event(s) recorded for: ${[...compensation.compensatedTaskIds].join(', ')}.`
                    : '');
            const rollbackMessage = rollbackError
                ? `Rollback failed for eligible TASK.md status changes: ${rollbackError}`
                : (rollbackTaskIds.length > 0
                    ? `Rolled back TASK.md status changes for: ${rollbackTaskIds.join(', ')}.`
                    : 'Skipped TASK.md rollback because every updated task already has an uncompensated committed status event.');
            const skippedRollbackMessage = uncompensatedCommittedTaskIds.length > 0
                ? ` Skipped rollback for task(s) with committed status events that could not be compensated: ${uncompensatedCommittedTaskIds.join(', ')}.`
                : '';
            return {
                ...syncResult,
                outcome: 'write_failed',
                updated_task_ids: remainingUpdatedTaskIds,
                error_message:
                    `Mandatory lifecycle event append failed after TASK.md status sync: ${error instanceof Error ? error.message : String(error)}. ` +
                    `${compensationMessage} ${rollbackMessage}${skippedRollbackMessage}`
            };
        }
    }
    return syncResult;
}

function compensateDecomposedParentStatusEvents(params: {
    orchestratorRoot: string;
    taskIds: string[];
    previousStatuses: Record<string, string | null>;
    committedTaskIds: Set<string>;
}): {
    compensatedTaskIds: Set<string>;
    errorMessages: string[];
} {
    const compensatedTaskIds = new Set<string>();
    const errorMessages: string[] = [];
    for (const taskId of params.taskIds) {
        if (!params.committedTaskIds.has(taskId)) {
            continue;
        }
        const previousStatus = params.previousStatuses[taskId] || 'DECOMPOSED';
        try {
            appendMandatoryTaskEvent(
                params.orchestratorRoot,
                taskId,
                'STATUS_CHANGED',
                'INFO',
                `Task status changed: DONE -> ${previousStatus} after failed decomposed parent completion audit.`,
                {
                    previous_status: 'DONE',
                    new_status: previousStatus,
                    reason: 'decomposed_parent_completion_event_failed_rollback'
                },
                { actor: 'orchestrator' }
            );
            compensatedTaskIds.add(taskId);
        } catch (error: unknown) {
            errorMessages.push(`${taskId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { compensatedTaskIds, errorMessages };
}
