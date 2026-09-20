import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { writeTaskQueueFile } from '../../core/task-queue/task-queue-repository';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    formatTaskQueueStatusCell,
    isTaskQueueDoneStatus,
    readTaskQueueStatusToken
} from '../../core/active-task-state';
import {
    formatActiveTaskQueueTable,
    parseCanonicalActiveTaskQueue,
    replaceTaskMdTableCell
} from '../../core/task-md-table';
import {
    TASK_ID_ALLOWED_PATTERN
} from '../../core/task-ids';
import {
    buildTaskQueueStatusContract,
    type TaskQueueStatusContract
} from '../../core/task-queue-status-contract';
import {
    withTaskQueueStatusSyncLock,
    type TaskQueueStatusSyncResult
} from '../../cli/commands/gate-flows/task/task-queue-sync';
import {
    normalizePath
} from '../shared/helpers';
import {
    SPLIT_REQUIRED_STATUS,
    extractExplicitLinkedChildTaskIds,
    parseTaskQueueEntriesFromContent,
    resolveDecomposedParentCompletionState,
    resolveSplitRequiredDecompositionState,
    resolveStrictDecompositionSplitRoutingState
} from './next-step-task-queue';

const TASK_QUEUE_TASK_ID_PATTERN = TASK_ID_ALLOWED_PATTERN;

export interface DecomposedParentBatchStatusSyncResult {
    outcome: TaskQueueStatusSyncResult['outcome'];
    task_path: string;
    root_task_id: string;
    task_ids: string[];
    updated_task_ids: string[];
    previous_statuses: Record<string, string | null>;
    next_status: 'DONE';
    error_message: string | null;
    status_contracts: Record<string, TaskQueueStatusContract>;
}

function fileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}

function syncTaskQueueStatusToDecomposed(repoRoot: string, taskId: string, options: {
    allowedPreviousStatuses: string[];
    validate: (taskEntries: ReturnType<typeof parseTaskQueueEntriesFromContent>) => string | null;
}): TaskQueueStatusSyncResult {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    const statusContract = buildTaskQueueStatusContract(taskId);
    if (!fileExists(taskPath)) {
        return {
            outcome: 'task_file_missing',
            task_path: normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: 'DECOMPOSED',
            error_message: null,
            status_contract: statusContract
        };
    }

    return withTaskQueueStatusSyncLock(
        taskPath,
        (message) => ({
            outcome: 'write_failed',
            task_path: normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: 'DECOMPOSED',
            error_message: message,
            status_contract: statusContract
        }),
        () => {
            const originalContent = fs.readFileSync(taskPath, 'utf8');
            const taskEntries = parseTaskQueueEntriesFromContent(originalContent);
            const targetExists = parseCanonicalActiveTaskQueue(originalContent).rows
                .some((row) => row.taskId === taskId);
            if (!targetExists) {
                return {
                    outcome: 'task_not_found',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: null,
                    next_status: 'DECOMPOSED',
                    error_message: null,
                    status_contract: statusContract
                };
            }
            const validationError = options.validate(taskEntries);
            if (validationError) {
                return {
                    outcome: 'write_failed',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: taskEntries.get(taskId)?.status || null,
                    next_status: 'DECOMPOSED',
                    error_message: validationError,
                    status_contract: statusContract
                };
            }
            const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
            const lines = originalContent.split(/\r?\n/);
            let previousStatus: string | null = null;
            let taskFound = false;
            let changed = false;

            for (const row of parseCanonicalActiveTaskQueue(originalContent).rows) {
                if (row.taskId !== taskId) {
                    continue;
                }
                taskFound = true;
                previousStatus = readTaskQueueStatusToken(row.status);
                if (!previousStatus || !options.allowedPreviousStatuses.includes(previousStatus)) {
                    return {
                        outcome: 'write_failed',
                        task_path: normalizePath(taskPath),
                        task_id: taskId,
                        previous_status: previousStatus,
                        next_status: 'DECOMPOSED',
                        error_message: `Expected previous status ${options.allowedPreviousStatuses.join(' or ')}; found ${previousStatus || 'unknown'}.`,
                        status_contract: statusContract
                    };
                }
                const updatedStatusCell = formatTaskQueueStatusCell(row.cells[1].raw, 'DECOMPOSED');
                if (updatedStatusCell !== row.cells[1].raw) {
                    const updatedLine = replaceTaskMdTableCell(row.rawLine, 1, updatedStatusCell);
                    if (!updatedLine) {
                        return {
                            outcome: 'write_failed',
                            task_path: normalizePath(taskPath),
                            task_id: taskId,
                            previous_status: previousStatus,
                            next_status: 'DECOMPOSED',
                            error_message: 'Failed to replace TASK.md status cell.',
                            status_contract: statusContract
                        };
                    }
                    lines[row.lineIndex] = updatedLine;
                    changed = true;
                }
                break;
            }

            if (!taskFound) {
                return {
                    outcome: 'task_not_found',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: null,
                    next_status: 'DECOMPOSED',
                    error_message: null,
                    status_contract: statusContract
                };
            }

            if (!changed) {
                return {
                    outcome: 'already_synced',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'DECOMPOSED',
                    error_message: null,
                    status_contract: statusContract
                };
            }

            try {
                writeTaskQueueFile(taskPath, lines.join(newline));
                return {
                    outcome: 'updated',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'DECOMPOSED',
                    error_message: null,
                    status_contract: statusContract
                };
            } catch (error: unknown) {
                return {
                    outcome: 'write_failed',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'DECOMPOSED',
                    error_message: error instanceof Error ? error.message : String(error),
                    status_contract: statusContract
                };
            }
        }
    );
}

export function syncTaskQueueStatusFromSplitRequiredToDecomposed(repoRoot: string, taskId: string): TaskQueueStatusSyncResult {
    return syncTaskQueueStatusToDecomposed(repoRoot, taskId, {
        allowedPreviousStatuses: [SPLIT_REQUIRED_STATUS],
        validate: (taskEntries) => {
            const state = resolveSplitRequiredDecompositionState(taskEntries, taskId);
            return state.ready
                ? null
                : 'The complete child task set is not valid for an atomic split-required transition.';
        }
    });
}

export function syncTaskQueueStatusFromStrictDecompositionToDecomposed(
    repoRoot: string,
    taskId: string,
    proposedChildTaskIds: string[]
): TaskQueueStatusSyncResult {
    return syncTaskQueueStatusToDecomposed(repoRoot, taskId, {
        allowedPreviousStatuses: ['TODO', 'IN_PROGRESS', 'IN_REVIEW'],
        validate: (taskEntries) => {
            const state = resolveStrictDecompositionSplitRoutingState(taskEntries, taskId, proposedChildTaskIds);
            return state.ready
                ? null
                : 'The complete strict child task set is not valid for an atomic decomposition transition.';
        }
    });
}

function buildDecomposedParentBatchStatusSyncResult(params: {
    taskPath: string;
    rootTaskId: string;
    taskIds: string[];
    updatedTaskIds?: string[];
    previousStatuses?: Record<string, string | null>;
    outcome: TaskQueueStatusSyncResult['outcome'];
    errorMessage?: string | null;
}): DecomposedParentBatchStatusSyncResult {
    const taskIds = [...new Set(params.taskIds)];
    return {
        outcome: params.outcome,
        task_path: normalizePath(params.taskPath),
        root_task_id: params.rootTaskId,
        task_ids: taskIds,
        updated_task_ids: params.updatedTaskIds || [],
        previous_statuses: params.previousStatuses || {},
        next_status: 'DONE',
        error_message: params.errorMessage || null,
        status_contracts: Object.fromEntries(
            taskIds.map((taskId) => [taskId, buildTaskQueueStatusContract(taskId)])
        )
    };
}

export function rollbackDecomposedParentStatusSync(
    repoRoot: string,
    taskIds: string[],
    previousStatuses: Record<string, string | null>
): string | null {
    if (taskIds.length === 0) {
        return null;
    }
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (!fileExists(taskPath)) {
        return 'TASK.md is missing.';
    }
    return withTaskQueueStatusSyncLock(
        taskPath,
        (message) => message,
        () => {
            const originalContent = fs.readFileSync(taskPath, 'utf8');
            const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
            const lines = originalContent.split(/\r?\n/);
            const pendingTaskIds = new Set(taskIds);
            for (const row of parseCanonicalActiveTaskQueue(originalContent).rows) {
                if (pendingTaskIds.size === 0) {
                    break;
                }
                const taskId = row.taskId;
                if (!pendingTaskIds.has(taskId)) {
                    continue;
                }
                const previousStatus = previousStatuses[taskId];
                if (!previousStatus) {
                    return `Missing previous status for ${taskId}.`;
                }
                const updatedStatusCell = formatTaskQueueStatusCell(row.cells[1].raw, previousStatus);
                const updatedLine = replaceTaskMdTableCell(row.rawLine, 1, updatedStatusCell);
                if (!updatedLine) {
                    return `Failed to replace TASK.md status cell for ${taskId}.`;
                }
                lines[row.lineIndex] = updatedLine;
                pendingTaskIds.delete(taskId);
            }
            if (pendingTaskIds.size > 0) {
                return `Could not find TASK.md row(s): ${[...pendingTaskIds].join(', ')}.`;
            }
            try {
                writeTaskQueueFile(taskPath, formatActiveTaskQueueTable(lines.join(newline)));
                return null;
            } catch (error: unknown) {
                return error instanceof Error ? error.message : String(error);
            }
        }
    );
}

export function syncDecomposedParentsToDone(
    repoRoot: string,
    rootTaskId: string,
    requestedTaskIds: string[]
): DecomposedParentBatchStatusSyncResult {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    const uniqueRequestedTaskIds = [...new Set(requestedTaskIds)];
    if (!fileExists(taskPath)) {
        return buildDecomposedParentBatchStatusSyncResult({
            taskPath,
            rootTaskId,
            taskIds: uniqueRequestedTaskIds,
            outcome: 'task_file_missing',
            errorMessage: null
        });
    }

    return withTaskQueueStatusSyncLock(
        taskPath,
        (message) => buildDecomposedParentBatchStatusSyncResult({
            taskPath,
            rootTaskId,
            taskIds: uniqueRequestedTaskIds,
            outcome: 'write_failed',
            errorMessage: message
        }),
        () => {
            const originalContent = fs.readFileSync(taskPath, 'utf8');
            const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
            const lines = originalContent.split(/\r?\n/);
            const taskEntries = parseTaskQueueEntriesFromContent(originalContent);
            const rootEntry = taskEntries.get(rootTaskId);
            if (!rootEntry) {
                return buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: uniqueRequestedTaskIds,
                    outcome: 'task_not_found',
                    errorMessage: null
                });
            }

            const completionState = resolveDecomposedParentCompletionState(
                taskEntries,
                rootTaskId,
                new Set<string>(),
                extractExplicitLinkedChildTaskIds
            );
            const previousStatuses: Record<string, string | null> = {};
            const failClosed = (message: string): DecomposedParentBatchStatusSyncResult => (
                buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: uniqueRequestedTaskIds,
                    previousStatuses,
                    outcome: 'write_failed',
                    errorMessage: message
                })
            );

            if (!completionState.hasLinkedChildren) {
                return failClosed(`Root task ${rootTaskId} no longer has explicit child task links.`);
            }
            if (completionState.missingChildTaskIds.length > 0) {
                return failClosed(
                    `Explicit child task link(s) missing at write time: ${completionState.missingChildTaskIds.join(', ')}.`
                );
            }
            if (!completionState.complete) {
                const unfinished = completionState.unfinishedRoute
                    ? `${completionState.unfinishedRoute.taskId} (${completionState.unfinishedRoute.status || 'unknown'})`
                    : 'unknown child';
                return failClosed(`Explicit child completion invariant is no longer satisfied at write time: ${unfinished}.`);
            }

            const freshTaskIds = [...new Set([...completionState.completedDecomposedTaskIds, rootTaskId])];
            const freshTaskIdSet = new Set(freshTaskIds);
            for (const requestedTaskId of uniqueRequestedTaskIds) {
                const requestedEntry = taskEntries.get(requestedTaskId);
                previousStatuses[requestedTaskId] = requestedEntry
                    ? readTaskQueueStatusToken(requestedEntry.status || '')
                    : null;
                if (!freshTaskIdSet.has(requestedTaskId)) {
                    return failClosed(
                        `Completion graph changed at write time; requested parent ${requestedTaskId} is no longer in the completed explicit child graph.`
                    );
                }
            }

            const rowByTaskId = new Map<string, ReturnType<typeof parseCanonicalActiveTaskQueue>['rows'][number]>();
            for (const row of parseCanonicalActiveTaskQueue(originalContent).rows) {
                if (TASK_QUEUE_TASK_ID_PATTERN.test(row.taskId)) {
                    rowByTaskId.set(row.taskId, row);
                }
            }

            const updatedTaskIds: string[] = [];
            for (const completedTaskId of freshTaskIds) {
                const completedEntry = taskEntries.get(completedTaskId);
                if (!completedEntry) {
                    return buildDecomposedParentBatchStatusSyncResult({
                        taskPath,
                        rootTaskId,
                        taskIds: freshTaskIds,
                        previousStatuses,
                        outcome: 'task_not_found',
                        errorMessage: null
                    });
                }
                const previousStatus = readTaskQueueStatusToken(completedEntry.status || '');
                previousStatuses[completedTaskId] = previousStatus;
                if (isTaskQueueDoneStatus(completedEntry.status)) {
                    continue;
                }
                if (previousStatus !== 'DECOMPOSED') {
                    return buildDecomposedParentBatchStatusSyncResult({
                        taskPath,
                        rootTaskId,
                        taskIds: freshTaskIds,
                        previousStatuses,
                        outcome: 'write_failed',
                        errorMessage: `Expected previous status DECOMPOSED for ${completedTaskId}; found ${previousStatus || 'unknown'}.`
                    });
                }
                const row = rowByTaskId.get(completedTaskId);
                if (!row) {
                    return buildDecomposedParentBatchStatusSyncResult({
                        taskPath,
                        rootTaskId,
                        taskIds: freshTaskIds,
                        previousStatuses,
                        outcome: 'task_not_found',
                        errorMessage: null
                    });
                }
                const updatedStatusCell = formatTaskQueueStatusCell(row.cells[1].raw, 'DONE');
                if (updatedStatusCell === row.cells[1].raw) {
                    continue;
                }
                const updatedLine = replaceTaskMdTableCell(row.rawLine, 1, updatedStatusCell);
                if (!updatedLine) {
                    return buildDecomposedParentBatchStatusSyncResult({
                        taskPath,
                        rootTaskId,
                        taskIds: freshTaskIds,
                        previousStatuses,
                        outcome: 'write_failed',
                        errorMessage: `Failed to replace TASK.md status cell for ${completedTaskId}.`
                    });
                }
                lines[row.lineIndex] = updatedLine;
                updatedTaskIds.push(completedTaskId);
            }

            if (updatedTaskIds.length === 0) {
                return buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: freshTaskIds,
                    previousStatuses,
                    outcome: 'already_synced',
                    errorMessage: null
                });
            }

            try {
                const currentContent = fs.readFileSync(taskPath, 'utf8');
                if (currentContent !== originalContent) {
                    return buildDecomposedParentBatchStatusSyncResult({
                        taskPath,
                        rootTaskId,
                        taskIds: freshTaskIds,
                        previousStatuses,
                        outcome: 'write_failed',
                        errorMessage:
                            'TASK.md changed during decomposed parent status sync; rerun next-step so write-time revalidation can use the latest task queue snapshot.'
                    });
                }
                writeTaskQueueFile(taskPath, formatActiveTaskQueueTable(lines.join(newline)));
                return buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: freshTaskIds,
                    updatedTaskIds,
                    previousStatuses,
                    outcome: 'updated',
                    errorMessage: null
                });
            } catch (error: unknown) {
                return buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: freshTaskIds,
                    previousStatuses,
                    outcome: 'write_failed',
                    errorMessage: error instanceof Error ? error.message : String(error)
                });
            }
        }
    );
}
