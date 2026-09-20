import { TASK_QUEUE_FILENAME } from '../../../../core/orchestration-constants';
import { withTaskQueueTransaction, writeTaskQueueFile } from '../../../../core/task-queue/task-queue-repository';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatTaskQueueStatusCell, normalizeTaskQueueStatusCell, readTaskQueueStatusToken } from '../../../../core/active-task-state';
import { buildTaskQueueStatusContract, type TaskQueueStatusContract } from '../../../../core/task-queue-status-contract';
import {
    formatActiveTaskQueueTable,
    parseCanonicalActiveTaskQueue,
    parseTaskMdTableRow,
    replaceTaskMdTableCell,
    type TaskMdTableCell
} from '../../../../core/task-md-table';
import * as gateHelpers from '../../../../gates/shared/helpers';

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

interface TaskQueueStatusRow {
    lineIndex: number;
    rawLine: string;
    cells: TaskMdTableCell[];
    taskId: string;
    status: string;
}

function readTaskQueueStatusRows(content: string): TaskQueueStatusRow[] {
    const parsed = parseCanonicalActiveTaskQueue(content);
    if (parsed.found) {
        return parsed.rows.map((row) => ({
            lineIndex: row.lineIndex,
            rawLine: row.rawLine,
            cells: row.cells,
            taskId: row.taskId,
            status: row.status
        }));
    }

    const rows: TaskQueueStatusRow[] = [];
    const lines = content.split(/\r?\n/);
    let inFirstTable = false;
    let sawAllowedLegacyHeading = false;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const rawLine = lines[lineIndex];
        const trimmed = rawLine.trim();
        if (!inFirstTable && /^##\s+Tasks\s*$/iu.test(trimmed)) {
            sawAllowedLegacyHeading = true;
            continue;
        }
        if (!inFirstTable && trimmed.startsWith('## ') && !sawAllowedLegacyHeading) {
            return rows;
        }
        if (!trimmed.startsWith('|')) {
            if (inFirstTable && trimmed !== '') {
                break;
            }
            continue;
        }
        inFirstTable = true;
        const cells = parseTaskMdTableRow(rawLine);
        const taskId = cells[0]?.trimmed || '';
        const status = cells[1]?.trimmed || '';
        if (
            cells.length >= 2
            && taskId
            && taskId.toLowerCase() !== 'id'
            && taskId.toLowerCase() !== 'task id'
            && status
            && readTaskQueueStatusToken(status)
        ) {
            rows.push({ lineIndex, rawLine, cells, taskId, status });
        }
    }
    return rows;
}

export function readTaskQueueStatus(repoRoot: string, taskId: string): string | null {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return null;
    }

    const content = fs.readFileSync(taskPath, 'utf8');
    for (const row of readTaskQueueStatusRows(content)) {
        if (row.taskId === taskId) {
            return readTaskQueueStatusToken(row.status);
        }
    }

    return null;
}

export function syncTaskQueueStatus(repoRoot: string, taskId: string, nextStatus: string): boolean {
    const result = syncTaskQueueStatusDetailed(repoRoot, taskId, nextStatus);
    return result.outcome === 'updated';
}

export interface TaskQueueStatusSyncResult {
    outcome: 'updated' | 'already_synced' | 'task_file_missing' | 'task_not_found' | 'write_failed';
    task_path: string;
    task_id: string;
    previous_status: string | null;
    next_status: string;
    error_message: string | null;
    status_contract: TaskQueueStatusContract;
}

export function withTaskQueueStatusSyncLock<T>(
    taskPath: string,
    onLockFailure: (message: string) => T,
    operation: () => T
): T {
    return withTaskQueueTransaction(taskPath, onLockFailure, operation);
}

export function syncTaskQueueStatusDetailed(repoRoot: string, taskId: string, nextStatus: string): TaskQueueStatusSyncResult {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    const statusContract = buildTaskQueueStatusContract(taskId);
    const normalizedNextStatus = normalizeTaskQueueStatusCell(nextStatus);
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            outcome: 'task_file_missing',
            task_path: gateHelpers.normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: normalizedNextStatus,
            error_message: null,
            status_contract: statusContract
        };
    }

    return withTaskQueueStatusSyncLock(
        taskPath,
        (message) => ({
            outcome: 'write_failed',
            task_path: gateHelpers.normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: normalizedNextStatus,
            error_message: message,
            status_contract: statusContract
        }),
        () => {
            const originalContent = fs.readFileSync(taskPath, 'utf8');
            const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
            const lines = originalContent.split(/\r?\n/);
            const queueRows = readTaskQueueStatusRows(originalContent);
            let changed = false;
            let taskFound = false;
            let previousStatus: string | null = null;

            for (const row of queueRows) {
                if (row.taskId !== taskId) {
                    continue;
                }

                taskFound = true;
                previousStatus = readTaskQueueStatusToken(row.status);
                const updatedStatusCell = formatTaskQueueStatusCell(row.cells[1].raw, normalizedNextStatus);
                if (updatedStatusCell !== row.cells[1].raw) {
                    const updatedLine = replaceTaskMdTableCell(row.rawLine, 1, updatedStatusCell);
                    if (!updatedLine) {
                        continue;
                    }
                    lines[row.lineIndex] = updatedLine;
                    changed = true;
                }
                break;
            }

            if (!taskFound) {
                return {
                    outcome: 'task_not_found',
                    task_path: gateHelpers.normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: null,
                    next_status: normalizedNextStatus,
                    error_message: null,
                    status_contract: statusContract
                };
            }

            const nextContent = formatActiveTaskQueueTable(lines.join(newline));
            const formatChanged = nextContent !== originalContent;

            if (!changed && !formatChanged) {
                return {
                    outcome: 'already_synced',
                    task_path: gateHelpers.normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: normalizedNextStatus,
                    error_message: null,
                    status_contract: statusContract
                };
            }

            try {
                writeTaskQueueFile(taskPath, nextContent);
            } catch (error: unknown) {
                return {
                    outcome: 'write_failed',
                    task_path: gateHelpers.normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: normalizedNextStatus,
                    error_message: getErrorMessage(error),
                    status_contract: statusContract
                };
            }

            return {
                outcome: 'updated',
                task_path: gateHelpers.normalizePath(taskPath),
                task_id: taskId,
                previous_status: previousStatus,
                next_status: normalizedNextStatus,
                error_message: null,
                status_contract: statusContract
            };
        }
    );
}
