import * as fs from 'node:fs';
import * as path from 'node:path';

import { readTaskQueueStatusToken } from '../../../core/active-task-state';
import { TASK_QUEUE_FILENAME } from '../../../core/orchestration-constants';
import {
    replaceReviewFollowUpTaskClosurePolicyMetadata,
    resolveReviewFollowUpTaskClosurePolicy,
    type ReviewFollowUpTaskClosurePolicyTaskContext,
    type ReviewFollowUpTaskClosurePolicyValue
} from '../../../core/review-follow-up-task-closure-policy';
import {
    parseCanonicalActiveTaskQueue,
    replaceTaskMdTableCell
} from '../../../core/task-md-table';
import { withTaskQueueStatusSyncLock } from '../../../cli/commands/gate-flows/task/task-queue-sync';
import { writeTaskQueueFile } from '../../../core/task-queue/task-queue-repository';
import { appendUiActionAudit } from './action-common';
import type { UiActionAuditRecord, UiActionMode } from './types';

export const TASK_CLOSURE_POLICY_ACTION_ID = 'task-review-follow-up-closure-policy';
export const TASK_CLOSURE_POLICY_CONFIRMATION_PHRASE = 'UPDATE F-TASK POLICY';

const TASK_CLOSURE_POLICY_REQUEST_KEYS = new Set([
    'action_id',
    'mode',
    'confirmation',
    'skip_low_findings',
    'forbid_child_tasks',
    'expected_notes_sha256'
]);

export interface UiTaskClosurePolicyRequest {
    action_id?: unknown;
    mode?: unknown;
    confirmation?: unknown;
    skip_low_findings?: unknown;
    forbid_child_tasks?: unknown;
    expected_notes_sha256?: unknown;
}

export interface UiTaskClosurePolicyActionResult {
    status: 'previewed' | 'confirmation_required' | 'executed' | 'unavailable' | 'conflict' | 'failed';
    http_status: number;
    task_id: string;
    mode: UiActionMode;
    proposed_value: ReviewFollowUpTaskClosurePolicyValue | null;
    expected_notes_sha256: string | null;
    current_policy: ReturnType<typeof resolveReviewFollowUpTaskClosurePolicy> | null;
    audit_path: string;
    requires_confirmation: boolean;
    confirmation_phrase: string;
    unavailable_reason: string | null;
}

interface CanonicalTaskSnapshot {
    taskPath: string;
    content: string;
    newline: string;
    taskLineIndex: number;
    rawLine: string;
    statusToken: string | null;
    notes: string;
    policyContext: ReviewFollowUpTaskClosurePolicyTaskContext;
    policy: ReturnType<typeof resolveReviewFollowUpTaskClosurePolicy>;
}

class TaskClosurePolicyConflictError extends Error {
    readonly snapshot: CanonicalTaskSnapshot | null;

    constructor(message: string, snapshot: CanonicalTaskSnapshot | null = null) {
        super(message);
        this.snapshot = snapshot;
    }
}

function parseMode(value: unknown): UiActionMode | null {
    return value === 'preview' || value === 'execute' ? value : null;
}

function requestValidationError(payload: UiTaskClosurePolicyRequest): string | null {
    if (payload.action_id !== TASK_CLOSURE_POLICY_ACTION_ID) {
        return `action_id must be '${TASK_CLOSURE_POLICY_ACTION_ID}'.`;
    }
    const unexpectedKeys = Object.keys(payload).filter((key) => !TASK_CLOSURE_POLICY_REQUEST_KEYS.has(key));
    if (unexpectedKeys.length > 0) {
        return `Unexpected request field(s): ${unexpectedKeys.sort().join(', ')}.`;
    }
    if (!parseMode(payload.mode)) {
        return "mode must be 'preview' or 'execute'.";
    }
    return null;
}

function parseProposedValue(payload: UiTaskClosurePolicyRequest): ReviewFollowUpTaskClosurePolicyValue | null {
    if (
        typeof payload.skip_low_findings !== 'boolean'
        || typeof payload.forbid_child_tasks !== 'boolean'
    ) {
        return null;
    }
    return {
        skip_low_findings: payload.skip_low_findings,
        forbid_child_tasks: payload.forbid_child_tasks
    };
}

function readCanonicalTaskSnapshot(repoRoot: string, taskId: string): CanonicalTaskSnapshot {
    const taskPath = path.join(path.resolve(repoRoot), TASK_QUEUE_FILENAME);
    if (!fs.existsSync(taskPath)) {
        throw new Error('TASK.md is unavailable.');
    }
    const taskStat = fs.lstatSync(taskPath);
    if (!taskStat.isFile() || taskStat.isSymbolicLink()) {
        throw new Error('TASK.md must be a regular file and cannot be a symbolic link.');
    }
    const content = fs.readFileSync(taskPath, 'utf8');
    const parsed = parseCanonicalActiveTaskQueue(content);
    if (!parsed.found) {
        throw new Error(parsed.unavailableReason || 'Canonical Active Queue is unavailable.');
    }
    const matchingRows = parsed.rows.filter((row) => row.taskId === taskId);
    if (matchingRows.length !== 1) {
        throw new Error(matchingRows.length === 0
            ? `Task '${taskId}' was not found in TASK.md.`
            : `Task '${taskId}' appears more than once in TASK.md.`);
    }
    const row = matchingRows[0];
    const policyContext: ReviewFollowUpTaskClosurePolicyTaskContext = {
        taskId,
        taskRows: parsed.rows.map((candidate) => ({
            taskId: candidate.taskId,
            notes: candidate.notes || null
        }))
    };
    return {
        taskPath,
        content,
        newline: content.includes('\r\n') ? '\r\n' : '\n',
        taskLineIndex: row.lineIndex,
        rawLine: row.rawLine,
        statusToken: readTaskQueueStatusToken(row.status),
        notes: row.notes,
        policyContext,
        policy: resolveReviewFollowUpTaskClosurePolicy(row.notes, policyContext)
    };
}

function unavailableReason(snapshot: CanonicalTaskSnapshot): string | null {
    if (snapshot.statusToken === 'DONE') {
        return 'Completed tasks cannot be changed retroactively.';
    }
    if (!snapshot.policy.eligible) {
        return snapshot.policy.diagnostics.join(' ')
            || 'Closure controls apply only to review-generated follow-up tasks.';
    }
    if (!snapshot.policy.valid) {
        return snapshot.policy.diagnostics.join(' ')
            || 'Closure policy metadata is invalid and must be repaired outside the local UI.';
    }
    return null;
}

function auditResult(
    repoRoot: string,
    taskId: string,
    mode: UiActionMode,
    status: UiTaskClosurePolicyActionResult['status'],
    snapshot: CanonicalTaskSnapshot | null,
    proposedValue: ReviewFollowUpTaskClosurePolicyValue | null,
    afterNotesSha256: string | null = null,
    error?: string
): string {
    const record: UiActionAuditRecord = {
        timestamp_utc: new Date().toISOString(),
        action_id: `${taskId}:${TASK_CLOSURE_POLICY_ACTION_ID}`,
        task_id: taskId,
        mode,
        status,
        command: `Update ${TASK_QUEUE_FILENAME} review follow-up task closure policy metadata for ${taskId}`,
        before_notes_sha256: snapshot?.policy.source_notes_sha256 ?? null,
        after_notes_sha256: afterNotesSha256,
        ...(proposedValue ? { proposed_value: { ...proposedValue } } : {}),
        ...(error ? { error } : {})
    };
    return appendUiActionAudit(repoRoot, record);
}

function buildResult(options: {
    repoRoot: string;
    taskId: string;
    mode: UiActionMode;
    status: UiTaskClosurePolicyActionResult['status'];
    httpStatus: number;
    snapshot: CanonicalTaskSnapshot | null;
    resultSnapshot?: CanonicalTaskSnapshot | null;
    proposedValue: ReviewFollowUpTaskClosurePolicyValue | null;
    unavailableReason?: string | null;
    afterNotesSha256?: string | null;
    auditPath?: string;
    error?: string;
}): UiTaskClosurePolicyActionResult {
    return {
        status: options.status,
        http_status: options.httpStatus,
        task_id: options.taskId,
        mode: options.mode,
        proposed_value: options.proposedValue,
        expected_notes_sha256:
            (options.resultSnapshot === undefined ? options.snapshot : options.resultSnapshot)
                ?.policy.source_notes_sha256 ?? null,
        current_policy:
            (options.resultSnapshot === undefined ? options.snapshot : options.resultSnapshot)
                ?.policy ?? null,
        audit_path: options.auditPath ?? auditResult(
            options.repoRoot,
            options.taskId,
            options.mode,
            options.status,
            options.snapshot,
            options.proposedValue,
            options.afterNotesSha256,
            options.error
        ),
        requires_confirmation: true,
        confirmation_phrase: TASK_CLOSURE_POLICY_CONFIRMATION_PHRASE,
        unavailable_reason: options.unavailableReason || null
    };
}

function persistPolicy(
    repoRoot: string,
    taskId: string,
    expectedNotesSha256: string,
    proposedValue: ReviewFollowUpTaskClosurePolicyValue
): { snapshot: CanonicalTaskSnapshot; afterNotesSha256: string; auditPath: string } {
    const initialSnapshot = readCanonicalTaskSnapshot(repoRoot, taskId);
    return withTaskQueueStatusSyncLock(
        initialSnapshot.taskPath,
        (message) => {
            throw new TaskClosurePolicyConflictError(message, initialSnapshot);
        },
        () => {
            const snapshot = readCanonicalTaskSnapshot(repoRoot, taskId);
            const blockedReason = unavailableReason(snapshot);
            if (blockedReason) {
                throw new TaskClosurePolicyConflictError(blockedReason, snapshot);
            }
            if (snapshot.policy.source_notes_sha256 !== expectedNotesSha256) {
                throw new TaskClosurePolicyConflictError(
                    'TASK.md notes changed after preview; refresh task details and preview again.',
                    snapshot
                );
            }
            const nextNotes = replaceReviewFollowUpTaskClosurePolicyMetadata(
                snapshot.notes,
                proposedValue,
                snapshot.policyContext
            );
            const nextPolicy = resolveReviewFollowUpTaskClosurePolicy(nextNotes, snapshot.policyContext);
            if (
                !nextPolicy.eligible
                || !nextPolicy.valid
                || nextPolicy.skip_low_findings !== proposedValue.skip_low_findings
                || nextPolicy.forbid_child_tasks !== proposedValue.forbid_child_tasks
                || !nextPolicy.source_notes_sha256
            ) {
                throw new Error('Proposed review follow-up task closure policy failed validation before persistence.');
            }
            const nextLine = replaceTaskMdTableCell(snapshot.rawLine, 8, ` ${nextNotes} `);
            if (!nextLine) {
                throw new Error(`Could not update task '${taskId}' Notes metadata.`);
            }
            const lines = snapshot.content.split(/\r?\n/u);
            lines[snapshot.taskLineIndex] = nextLine;
            writeTaskQueueFile(snapshot.taskPath, lines.join(snapshot.newline));
            try {
                const persistedSnapshot = readCanonicalTaskSnapshot(repoRoot, taskId);
                if (
                    !persistedSnapshot.policy.valid
                    || persistedSnapshot.policy.skip_low_findings !== proposedValue.skip_low_findings
                    || persistedSnapshot.policy.forbid_child_tasks !== proposedValue.forbid_child_tasks
                    || persistedSnapshot.policy.source_notes_sha256 !== nextPolicy.source_notes_sha256
                ) {
                    throw new Error('Persisted review follow-up task closure policy failed read-after-write validation.');
                }
                const auditPath = auditResult(
                    repoRoot,
                    taskId,
                    'execute',
                    'executed',
                    snapshot,
                    proposedValue,
                    persistedSnapshot.policy.source_notes_sha256
                );
                return {
                    snapshot: persistedSnapshot,
                    afterNotesSha256: persistedSnapshot.policy.source_notes_sha256,
                    auditPath
                };
            } catch (error: unknown) {
                try {
                    writeTaskQueueFile(snapshot.taskPath, snapshot.content);
                    if (fs.readFileSync(snapshot.taskPath, 'utf8') !== snapshot.content) {
                        throw new Error('TASK.md rollback failed read-after-write validation.');
                    }
                } catch (rollbackError: unknown) {
                    const originalMessage = error instanceof Error ? error.message : String(error);
                    const rollbackMessage = rollbackError instanceof Error
                        ? rollbackError.message
                        : String(rollbackError);
                    throw new Error(`${originalMessage} Rollback failed: ${rollbackMessage}`);
                }
                throw error;
            }
        }
    );
}

export function processUiTaskClosurePolicyRequest(
    repoRoot: string,
    taskId: string,
    payload: UiTaskClosurePolicyRequest
): UiTaskClosurePolicyActionResult {
    const mode = parseMode(payload.mode) || 'preview';
    const proposedValue = parseProposedValue(payload);
    let snapshot: CanonicalTaskSnapshot | null = null;
    try {
        snapshot = readCanonicalTaskSnapshot(repoRoot, taskId);
        const validationError = requestValidationError(payload);
        if (validationError) {
            return buildResult({
                repoRoot,
                taskId,
                mode,
                status: 'failed',
                httpStatus: 400,
                snapshot,
                proposedValue,
                unavailableReason: validationError
            });
        }
        if (!proposedValue) {
            return buildResult({
                repoRoot,
                taskId,
                mode,
                status: 'failed',
                httpStatus: 400,
                snapshot,
                proposedValue,
                unavailableReason: 'Both closure policy settings must be booleans.'
            });
        }
        const blockedReason = unavailableReason(snapshot);
        if (blockedReason) {
            return buildResult({
                repoRoot,
                taskId,
                mode,
                status: 'unavailable',
                httpStatus: 409,
                snapshot,
                proposedValue,
                unavailableReason: blockedReason
            });
        }
        if (mode === 'preview') {
            return buildResult({
                repoRoot,
                taskId,
                mode,
                status: 'previewed',
                httpStatus: 200,
                snapshot,
                proposedValue
            });
        }
        if (payload.confirmation !== TASK_CLOSURE_POLICY_CONFIRMATION_PHRASE) {
            return buildResult({
                repoRoot,
                taskId,
                mode,
                status: 'confirmation_required',
                httpStatus: 409,
                snapshot,
                proposedValue
            });
        }
        const expectedNotesSha256 = typeof payload.expected_notes_sha256 === 'string'
            ? payload.expected_notes_sha256.trim().toLowerCase()
            : '';
        if (!/^[a-f0-9]{64}$/u.test(expectedNotesSha256)) {
            return buildResult({
                repoRoot,
                taskId,
                mode,
                status: 'conflict',
                httpStatus: 409,
                snapshot,
                proposedValue,
                unavailableReason: 'Execute requires the current notes hash returned by preview.'
            });
        }
        const persisted = persistPolicy(repoRoot, taskId, expectedNotesSha256, proposedValue);
        return buildResult({
            repoRoot,
            taskId,
            mode,
            status: 'executed',
            httpStatus: 200,
            snapshot,
            resultSnapshot: persisted.snapshot,
            proposedValue,
            afterNotesSha256: persisted.afterNotesSha256,
            auditPath: persisted.auditPath
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const conflict = error instanceof TaskClosurePolicyConflictError;
        const resultSnapshot = conflict && error.snapshot ? error.snapshot : snapshot;
        return buildResult({
            repoRoot,
            taskId,
            mode,
            status: conflict ? 'conflict' : 'failed',
            httpStatus: conflict ? 409 : 500,
            snapshot: resultSnapshot,
            proposedValue,
            unavailableReason: message,
            error: message
        });
    }
}
