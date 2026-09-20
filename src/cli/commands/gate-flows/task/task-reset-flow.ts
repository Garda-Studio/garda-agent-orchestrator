import { TASK_QUEUE_FILENAME } from '../../../../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../../../../core/filesystem';
import { writeTaskQueueFile } from '../../../../core/task-queue/task-queue-repository';
import { readTaskQueueStatusToken } from '../../../../core/active-task-state';
import {
    formatActiveTaskQueueTable,
    parseCanonicalActiveTaskQueue,
    replaceTaskMdTableCell,
    type CanonicalActiveTaskQueueRow
} from '../../../../core/task-md-table';
import { resolveTaskResetAvailability } from '../../../../core/task-reset-availability';
import { assertValidTaskId } from '../../../../gate-runtime/task-events';
import { withFilesystemLock } from '../../../../gate-runtime/task-events-locking';
import { loadIndex, removeEntries } from '../../../../gate-runtime/reviews-index';
import { reconcileTimelineSummaryForTask } from '../../../../gate-runtime/timeline-summary';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { resolveReviewScratchRoots } from '../../../../gates/review/review-scratch-paths';
import {
    readTaskQueueStatus,
    syncTaskQueueStatusDetailed,
    withTaskQueueStatusSyncLock
} from './task-queue-sync';

export type TaskResetOutcome =
    | 'RESET_COMPLETE'
    | 'ALREADY_RESET'
    | 'TARGET_STATUS_REQUIRED'
    | 'CONFIRMATION_REQUIRED'
    | 'TASK_RESET_DISABLED'
    | 'DRY_RUN';

export type TaskResetTargetStatus = 'TODO' | 'DONE';

export interface TaskResetArtifact {
    path: string;
    type: 'task-events' | 'review-artifact' | 'review-temp-dir';
    fileName?: string;
}

export interface TaskResetScope {
    taskId: string;
    eventsPath: string;
    taskLockPath: string;
    aggregatePath: string;
    aggregateLockPath: string;
    reviewTempDir: string;
    reviewTempDirs: string[];
    reviewArtifactNames: string[];
    artifacts: TaskResetArtifact[];
    aggregateLineCount: number;
    pendingFollowUpTaskIds: string[];
    preservedFollowUpTaskIds: string[];
    previousStatus: string | null;
    hasAnyArtifacts: boolean;
}

export interface TaskResetCommandResult {
    outcome: TaskResetOutcome;
    taskId: string;
    previousStatus: string | null;
    targetStatus: TaskResetTargetStatus | null;
    dryRun: boolean;
    artifacts: TaskResetArtifact[];
    aggregateLinesRemoved: number;
    resetReportPath: string | null;
    statusSyncOutcome: string | null;
    outputLines: string[];
    exitCode: number;
}

export interface RunTaskResetOptions {
    taskId?: unknown;
    dryRun?: boolean;
    confirm?: boolean;
    toStatus?: unknown;
    reopen?: boolean;
    discard?: boolean;
    repoRoot?: string;
    eventsRoot?: string;
    reviewsRoot?: string;
    asJson?: boolean;
}

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function pathExists(p: string): boolean {
    try {
        return fs.existsSync(p);
    } catch {
        return false;
    }
}

function deleteFileIfExists(filePath: string): void {
    try {
        if (fs.existsSync(filePath)) {
            fs.rmSync(filePath, { force: true });
        }
    } catch {
        // best-effort cleanup
    }
}

function deleteDirectoryIfExists(dirPath: string): void {
    try {
        if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true });
        }
    } catch {
        // best-effort cleanup
    }
}

function parseAggregateTaskId(line: string): string | null {
    try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return String(parsed.task_id || '').trim() || null;
    } catch {
        return null;
    }
}

function isGeneratedReviewFollowUpRow(parentTaskId: string, row: CanonicalActiveTaskQueueRow): boolean {
    const escapedParentTaskId = escapeRegExp(parentTaskId);
    return new RegExp(`^${escapedParentTaskId}-F[1-9][0-9]*$`, 'u').test(row.taskId)
        && row.notes.includes(`Child of \`${parentTaskId}\`.`)
        && /review_follow_up_(?:group_)?fingerprint=[0-9a-f]{64}/iu.test(row.notes);
}

function resolveReviewFollowUpRows(repoRoot: string, parentTaskId: string): {
    pendingTaskIds: string[];
    preservedTaskIds: string[];
} {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (!fileExists(taskPath)) {
        return { pendingTaskIds: [], preservedTaskIds: [] };
    }
    const parsed = parseCanonicalActiveTaskQueue(fs.readFileSync(taskPath, 'utf8'));
    if (!parsed.found) {
        return { pendingTaskIds: [], preservedTaskIds: [] };
    }
    const pendingTaskIds: string[] = [];
    const preservedTaskIds: string[] = [];
    for (const row of parsed.rows) {
        if (!isGeneratedReviewFollowUpRow(parentTaskId, row)) {
            continue;
        }
        if (readTaskQueueStatusToken(row.status) === 'TODO') {
            pendingTaskIds.push(row.taskId);
        } else {
            preservedTaskIds.push(row.taskId);
        }
    }
    return { pendingTaskIds, preservedTaskIds };
}

function removeParentFollowUpMarkers(notes: string, removedTaskIds: ReadonlySet<string>): string {
    const markerPattern = /Review follow-up tasks materialized:\s*((?:`[^`\r\n]+`(?:,\s*)?)+);\s*artifact\s*`([^`\r\n]+)`\./giu;
    return notes.replace(markerPattern, (_match, taskList: string, artifactPath: string) => {
        const retainedTaskIds = [...String(taskList).matchAll(/`([^`\r\n]+)`/gu)]
            .map((candidate) => candidate[1].trim())
            .filter((taskId) => taskId && !removedTaskIds.has(taskId));
        return retainedTaskIds.length > 0
            ? `Review follow-up tasks materialized: ${retainedTaskIds.map((taskId) => `\`${taskId}\``).join(', ')}; artifact \`${artifactPath}\`.`
            : '';
    }).replace(/\s{2,}/gu, ' ').trim();
}

function rollbackPendingReviewFollowUpRows(
    repoRoot: string,
    parentTaskId: string,
    expectedTaskIds: readonly string[]
): string[] {
    if (expectedTaskIds.length === 0) {
        return [];
    }
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    return withTaskQueueStatusSyncLock(
        taskPath,
        (message) => { throw new Error(message); },
        () => {
            const originalContent = fs.readFileSync(taskPath, 'utf8');
            const parsed = parseCanonicalActiveTaskQueue(originalContent);
            if (!parsed.found) {
                throw new Error(parsed.unavailableReason || 'Canonical TASK.md queue is unavailable.');
            }
            const expected = new Set(expectedTaskIds);
            const removableRows = parsed.rows.filter((row) => (
                expected.has(row.taskId)
                && isGeneratedReviewFollowUpRow(parentTaskId, row)
                && readTaskQueueStatusToken(row.status) === 'TODO'
            ));
            if (removableRows.length !== expected.size) {
                throw new Error(
                    `Pending review follow-up rollback changed before reset: expected ${expected.size}, ` +
                    `found ${removableRows.length}. Rerun task-reset dry-run.`
                );
            }

            const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
            const lines = originalContent.split(/\r?\n/);
            const parentRow = parsed.rows.find((row) => row.taskId === parentTaskId);
            if (!parentRow) {
                throw new Error(`Parent task '${parentTaskId}' disappeared before review follow-up rollback.`);
            }
            const removedTaskIds = new Set(removableRows.map((row) => row.taskId));
            const nextParentNotes = removeParentFollowUpMarkers(parentRow.notes, removedTaskIds);
            const updatedParentLine = replaceTaskMdTableCell(parentRow.rawLine, 8, ` ${nextParentNotes || '-'} `);
            if (!updatedParentLine) {
                throw new Error(`Could not update parent task '${parentTaskId}' follow-up marker.`);
            }
            lines[parentRow.lineIndex] = updatedParentLine;
            for (const row of [...removableRows].sort((left, right) => right.lineIndex - left.lineIndex)) {
                lines.splice(row.lineIndex, 1);
            }
            writeTaskQueueFile(taskPath, formatActiveTaskQueueTable(lines.join(newline)));
            return [...removedTaskIds].sort((left, right) => left.localeCompare(right));
        }
    );
}

function assertTaskExistsInTaskMd(repoRoot: string, taskId: string): void {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        throw new Error(`TASK.md not found at: ${gateHelpers.normalizePath(taskPath)}`);
    }
    const content = fs.readFileSync(taskPath, 'utf8');
    const rowPattern = new RegExp(`^\\|\\s*${escapeRegExp(taskId)}\\s*\\|`, 'm');
    if (!rowPattern.test(content)) {
        throw new Error(`Task '${taskId}' not found in TASK.md. Cannot reset an unknown task.`);
    }
}

function removeTaskLinesFromAggregateLog(aggregatePath: string, taskId: string): number {
    if (!fileExists(aggregatePath)) return 0;
    const content = fs.readFileSync(aggregatePath, 'utf8');
    const lines = content.split('\n');
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
        if (!line.trim()) continue;
        if (parseAggregateTaskId(line) === taskId) {
            removed += 1;
        } else {
            kept.push(line);
        }
    }
    if (removed > 0) {
        writeFileAtomically(aggregatePath, kept.length > 0 ? `${kept.join('\n')}\n` : '', { encoding: 'utf8' });
    }
    return removed;
}

function resolveRepoRoot(repoRoot: string | undefined): string {
    return path.resolve(String(repoRoot || '.'));
}

function resolveEventsRoot(repoRoot: string, eventsRootOption: string | undefined): string {
    return eventsRootOption
        ? path.resolve(String(eventsRootOption))
        : gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
}

function resolveReviewsRoot(repoRoot: string, reviewsRootOption: string | undefined): string {
    return reviewsRootOption
        ? path.resolve(String(reviewsRootOption))
        : gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
}

function normalizeTargetStatus(value: unknown): TaskResetTargetStatus | null {
    const normalized = String(value || '').trim().toUpperCase();
    if (!normalized) {
        return null;
    }
    if (normalized === 'TODO' || normalized === 'DONE') {
        return normalized;
    }
    throw new Error(`Invalid task-reset target status '${String(value)}'. Expected TODO or DONE.`);
}

function normalizeTaskResetTaskId(taskId: string): string {
    return /^t-\d+(?:-\d+)*$/iu.test(taskId) ? taskId.toUpperCase() : taskId;
}

function resolveTaskResetTargetStatus(options: RunTaskResetOptions): TaskResetTargetStatus | null {
    const candidates: Array<{ source: string; status: TaskResetTargetStatus }> = [];
    if (options.reopen === true) {
        candidates.push({ source: '--reopen', status: 'TODO' });
    }
    if (options.discard === true) {
        candidates.push({ source: '--discard', status: 'DONE' });
    }
    if (options.toStatus !== undefined) {
        const status = normalizeTargetStatus(options.toStatus);
        if (status) {
            candidates.push({ source: '--to-status', status });
        }
    }

    const uniqueStatuses = [...new Set(candidates.map((candidate) => candidate.status))];
    if (uniqueStatuses.length > 1) {
        throw new Error(
            `Conflicting task-reset target status flags: ${candidates.map((candidate) => candidate.source).join(', ')}. ` +
            'Use exactly one of --reopen, --discard, or --to-status TODO|DONE.'
        );
    }
    return uniqueStatuses[0] ?? null;
}

export function resolveTaskResetScope(options: {
    taskId: string;
    repoRoot: string;
    eventsRoot: string;
    reviewsRoot: string;
}): TaskResetScope {
    const { taskId, repoRoot, eventsRoot, reviewsRoot } = options;

    const eventsPath = path.join(eventsRoot, `${taskId}.jsonl`);
    const taskLockPath = path.join(eventsRoot, `.${taskId}.lock`);
    const aggregatePath = path.join(eventsRoot, 'all-tasks.jsonl');
    const aggregateLockPath = path.join(eventsRoot, '.all-tasks.lock');
    const reviewTempDirs = resolveReviewScratchRoots(repoRoot)
        .map((reviewScratchRoot) => path.resolve(reviewScratchRoot, taskId));
    const reviewTempDir = reviewTempDirs[0];

    const artifacts: TaskResetArtifact[] = [];

    if (fileExists(eventsPath)) {
        artifacts.push({ path: eventsPath, type: 'task-events' });
    }

    const resetReportNames = new Set([
        `${taskId}-reset-report.json`,
        `${taskId}-reset-report.json.gz`
    ]);
    const reviewArtifactNames: string[] = [];
    const indexedReviewNames = fs.existsSync(reviewsRoot)
        ? loadIndex(reviewsRoot, { forceRebuild: true, readOnly: true }).index.entries
            .filter((entry) => entry.taskId === taskId && !resetReportNames.has(entry.fileName))
            .map((entry) => entry.fileName)
        : [];
    for (const name of indexedReviewNames) {
        const fullPath = path.join(reviewsRoot, name);
        if (fileExists(fullPath)) {
            artifacts.push({ path: fullPath, type: 'review-artifact', fileName: name });
            reviewArtifactNames.push(name);
        }
    }

    for (const candidateReviewTempDir of reviewTempDirs) {
        if (pathExists(candidateReviewTempDir)) {
            artifacts.push({ path: candidateReviewTempDir, type: 'review-temp-dir' });
        }
    }

    let aggregateLineCount = 0;
    if (fileExists(aggregatePath)) {
        const content = fs.readFileSync(aggregatePath, 'utf8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            if (parseAggregateTaskId(line) === taskId) {
                aggregateLineCount += 1;
            }
        }
    }

    const previousStatus = readTaskQueueStatus(repoRoot, taskId);
    const followUpRows = resolveReviewFollowUpRows(repoRoot, taskId);
    const hasAnyArtifacts = artifacts.length > 0
        || aggregateLineCount > 0
        || followUpRows.pendingTaskIds.length > 0;

    return {
        taskId,
        eventsPath,
        taskLockPath,
        aggregatePath,
        aggregateLockPath,
        reviewTempDir,
        reviewTempDirs,
        reviewArtifactNames,
        artifacts,
        aggregateLineCount,
        pendingFollowUpTaskIds: followUpRows.pendingTaskIds,
        preservedFollowUpTaskIds: followUpRows.preservedTaskIds,
        previousStatus,
        hasAnyArtifacts
    };
}

function buildOutputLines(
    outcome: TaskResetOutcome,
    taskId: string,
    previousStatus: string | null,
    targetStatus: TaskResetTargetStatus | null,
    dryRun: boolean,
    artifacts: TaskResetArtifact[],
    aggregateLinesRemoved: number,
    resetReportPath: string | null,
    statusSyncOutcome: string | null,
    pendingFollowUpTaskIds: readonly string[] = [],
    preservedFollowUpTaskIds: readonly string[] = []
): string[] {
    const lines: string[] = [];
    lines.push(outcome);
    lines.push(`TaskId: ${taskId}`);
    if (previousStatus) {
        lines.push(`PreviousStatus: ${previousStatus}`);
    }
    if (targetStatus) {
        lines.push(`TargetStatus: ${targetStatus}`);
    }
    if (dryRun) {
        lines.push('Mode: DRY_RUN');
    }
    if (outcome === 'TARGET_STATUS_REQUIRED') {
        lines.push('Action: Choose reset-for-rerun with --reopen/--to-status TODO, or terminal discard with --discard/--to-status DONE.');
    }
    if (outcome === 'CONFIRMATION_REQUIRED') {
        lines.push('Action: Pass --confirm to execute the reset or --dry-run to preview.');
    }
    if (outcome === 'ALREADY_RESET') {
        lines.push(`Note: Task already ${targetStatus ?? 'at target status'} with no remaining artifacts.`);
    }
    if (outcome === 'TASK_RESET_DISABLED') {
        lines.push('TaskResetEnabled: false');
        lines.push('Action: Enable confirmed reset mutations with audited command: workflow set --task-reset-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>".');
    }
    if (artifacts.length > 0) {
        lines.push(`ArtifactsFound: ${artifacts.length}`);
    }
    if (aggregateLinesRemoved > 0) {
        lines.push(`AggregateLogLinesRemoved: ${aggregateLinesRemoved}`);
    }
    if (targetStatus === 'TODO' && pendingFollowUpTaskIds.length > 0) {
        lines.push(`PendingFollowUpTasksPlannedForRemoval: ${pendingFollowUpTaskIds.join(', ')}`);
    }
    if (preservedFollowUpTaskIds.length > 0) {
        lines.push(`StartedOrTerminalFollowUpTasksPreserved: ${preservedFollowUpTaskIds.join(', ')}`);
    }
    if (resetReportPath) {
        lines.push(`ResetReport: ${gateHelpers.normalizePath(resetReportPath)}`);
    }
    if (statusSyncOutcome) {
        lines.push(`StatusSync: ${statusSyncOutcome}`);
    }
    return lines;
}

export function runTaskResetCommand(options: RunTaskResetOptions): TaskResetCommandResult {
    const rawTaskId = String(options.taskId || '').trim();

    const validatedId = assertValidTaskId(rawTaskId);
    const taskId = normalizeTaskResetTaskId(validatedId);

    const repoRoot = resolveRepoRoot(options.repoRoot);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const dryRun = Boolean(options.dryRun);
    const confirm = Boolean(options.confirm);
    const targetStatus = resolveTaskResetTargetStatus(options);

    assertTaskExistsInTaskMd(repoRoot, taskId);

    if (!dryRun && confirm && targetStatus) {
        const taskResetAvailability = resolveTaskResetAvailability(repoRoot);
        if (!taskResetAvailability.enabled) {
            const outputLines = buildOutputLines(
                'TASK_RESET_DISABLED', taskId, null,
                targetStatus, false, [], 0,
                null, null
            );
            outputLines.push(`ConfigPath: ${gateHelpers.normalizePath(taskResetAvailability.configPath)}`);
            if (taskResetAvailability.disabledReason) {
                outputLines.push(`Reason: ${taskResetAvailability.disabledReason}`);
            }
            return {
                outcome: 'TASK_RESET_DISABLED',
                taskId,
                previousStatus: null,
                targetStatus,
                dryRun: false,
                artifacts: [],
                aggregateLinesRemoved: 0,
                resetReportPath: null,
                statusSyncOutcome: null,
                outputLines,
                exitCode: 1
            };
        }
    }

    const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });

    if (!targetStatus) {
        const outputLines = buildOutputLines(
            'TARGET_STATUS_REQUIRED', taskId, scope.previousStatus,
            null, dryRun, scope.artifacts, scope.aggregateLineCount,
            null, null, scope.pendingFollowUpTaskIds, scope.preservedFollowUpTaskIds
        );
        return {
            outcome: 'TARGET_STATUS_REQUIRED',
            taskId,
            previousStatus: scope.previousStatus,
            targetStatus: null,
            dryRun,
            artifacts: scope.artifacts,
            aggregateLinesRemoved: 0,
            resetReportPath: null,
            statusSyncOutcome: null,
            outputLines,
            exitCode: 1
        };
    }

    if (scope.previousStatus === targetStatus && !scope.hasAnyArtifacts) {
        const outputLines = buildOutputLines(
            'ALREADY_RESET', taskId, scope.previousStatus,
            targetStatus, false, [], 0, null, null,
            scope.pendingFollowUpTaskIds, scope.preservedFollowUpTaskIds
        );
        return {
            outcome: 'ALREADY_RESET',
            taskId,
            previousStatus: scope.previousStatus,
            targetStatus,
            dryRun: false,
            artifacts: [],
            aggregateLinesRemoved: 0,
            resetReportPath: null,
            statusSyncOutcome: null,
            outputLines,
            exitCode: 0
        };
    }

    if (!dryRun && !confirm) {
        const outputLines = [
            'TASK_RESET_CONFIRMATION_REQUIRED',
            `TaskId: ${taskId}`,
            `PreviousStatus: ${scope.previousStatus ?? 'unknown'}`,
            `TargetStatus: ${targetStatus}`,
            `ArtifactsFound: ${scope.artifacts.length}`,
            `AggregateLogLines: ${scope.aggregateLineCount}`,
            'Action: Pass --confirm to execute the reset or --dry-run to preview.'
        ];
        if (targetStatus === 'TODO' && scope.pendingFollowUpTaskIds.length > 0) {
            outputLines.push(`PendingFollowUpTasksPlannedForRemoval: ${scope.pendingFollowUpTaskIds.join(', ')}`);
        }
        if (scope.preservedFollowUpTaskIds.length > 0) {
            outputLines.push(`StartedOrTerminalFollowUpTasksPreserved: ${scope.preservedFollowUpTaskIds.join(', ')}`);
        }
        return {
            outcome: 'CONFIRMATION_REQUIRED',
            taskId,
            previousStatus: scope.previousStatus,
            targetStatus,
            dryRun: false,
            artifacts: scope.artifacts,
            aggregateLinesRemoved: 0,
            resetReportPath: null,
            statusSyncOutcome: null,
            outputLines,
            exitCode: 0
        };
    }

    if (dryRun) {
        const outputLines = buildOutputLines(
            'DRY_RUN', taskId, scope.previousStatus,
            targetStatus, true, scope.artifacts, scope.aggregateLineCount,
            null, null, scope.pendingFollowUpTaskIds, scope.preservedFollowUpTaskIds
        );
        return {
            outcome: 'DRY_RUN',
            taskId,
            previousStatus: scope.previousStatus,
            targetStatus,
            dryRun: true,
            artifacts: scope.artifacts,
            aggregateLinesRemoved: scope.aggregateLineCount,
            resetReportPath: null,
            statusSyncOutcome: null,
            outputLines,
            exitCode: 0
        };
    }

    // Write audit breadcrumb before any deletion
    const resetReportPath = path.join(reviewsRoot, `${taskId}-reset-report.json`);
    const resetReport = {
        timestamp_utc: new Date().toISOString(),
        event_source: 'task-reset',
        task_id: taskId,
        previous_status: scope.previousStatus,
        target_status: targetStatus,
        removed_artifacts: scope.artifacts.map((a) => gateHelpers.normalizePath(a.path)),
        pending_follow_up_task_ids_planned_for_removal: targetStatus === 'TODO'
            ? scope.pendingFollowUpTaskIds
            : [],
        removed_pending_follow_up_task_ids: [] as string[],
        preserved_started_or_terminal_follow_up_task_ids: scope.preservedFollowUpTaskIds,
        aggregate_lines_removed: scope.aggregateLineCount,
        reset_by: 'operator'
    };
    fs.mkdirSync(reviewsRoot, { recursive: true });
    writeFileAtomically(resetReportPath, JSON.stringify(resetReport, null, 2) + '\n', { encoding: 'utf8' });

    const removedPendingFollowUpTaskIds = targetStatus === 'TODO'
        ? rollbackPendingReviewFollowUpRows(repoRoot, taskId, scope.pendingFollowUpTaskIds)
        : [];
    resetReport.removed_pending_follow_up_task_ids = removedPendingFollowUpTaskIds;
    writeFileAtomically(resetReportPath, JSON.stringify(resetReport, null, 2) + '\n', { encoding: 'utf8' });

    // Delete per-task events file under task lock
    withFilesystemLock(scope.taskLockPath, {}, () => {
        deleteFileIfExists(scope.eventsPath);
    });

    // Delete review artifacts (KNOWN_SUFFIXES enumeration — reset-report excluded)
    for (const artifact of scope.artifacts) {
        if (artifact.type === 'review-artifact') {
            deleteFileIfExists(artifact.path);
        }
    }

    // Delete review temp directory
    for (const reviewTempDir of scope.reviewTempDirs) {
        deleteDirectoryIfExists(reviewTempDir);
    }

    // Remove task lines from aggregate log under aggregate lock
    let aggregateLinesRemoved = 0;
    withFilesystemLock(scope.aggregateLockPath, {}, () => {
        aggregateLinesRemoved = removeTaskLinesFromAggregateLog(scope.aggregatePath, taskId);
    });

    // Update reviews index for deleted review artifacts
    if (scope.reviewArtifactNames.length > 0) {
        removeEntries(reviewsRoot, scope.reviewArtifactNames);
    }

    // Reconcile timeline summary (handles absent file case gracefully)
    try {
        reconcileTimelineSummaryForTask(eventsRoot, taskId);
    } catch {
        // Non-fatal: timeline reconciliation failure does not block reset
    }

    const syncResult = syncTaskQueueStatusDetailed(repoRoot, taskId, targetStatus);

    const outputLines = buildOutputLines(
        'RESET_COMPLETE', taskId, scope.previousStatus,
        targetStatus, false, scope.artifacts, aggregateLinesRemoved,
        resetReportPath, syncResult.outcome,
        scope.pendingFollowUpTaskIds, scope.preservedFollowUpTaskIds
    );
    if (removedPendingFollowUpTaskIds.length > 0) {
        outputLines.push(`PendingFollowUpTasksRemoved: ${removedPendingFollowUpTaskIds.join(', ')}`);
    }
    return {
        outcome: 'RESET_COMPLETE',
        taskId,
        previousStatus: scope.previousStatus,
        targetStatus,
        dryRun: false,
        artifacts: scope.artifacts,
        aggregateLinesRemoved,
        resetReportPath,
        statusSyncOutcome: syncResult.outcome,
        outputLines,
        exitCode: 0
    };
}
