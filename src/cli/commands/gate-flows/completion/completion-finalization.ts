import { TASK_QUEUE_FILENAME } from '../../../../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanupCompactAtTaskBoundary } from '../../../../core/compact/lifecycle';
import { cleanupTaskValidationOutput } from '../../../../core/validation-output-retention';

import { writeFileAtomically } from '../../../../core/filesystem';
import { isTaskQueueDoneStatus } from '../../../../core/active-task-state';
import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleName
} from '../../../../core/constants';
import {
    readTaskQueueEntries,
    type TaskQueueEntry
} from '../../../../core/task-queue-read';
import {
    emitMandatoryCompletionGateEventAsync,
    emitMandatoryStatusChangedEventAsync
} from '../../../../gate-runtime/lifecycle-events';
import { resolveTaskHistoryLedgerPath } from '../../../../gate-runtime/task-history-ledger';
import { collectOrderedTimelineEvents } from '../../../../gates/completion/completion-evidence';
import {
    extractExplicitLinkedChildTaskIds,
    isDecomposedParentTask,
    resolveDecomposedParentCompletionState
} from '../../../../gates/next-step/next-step-task-queue';
import {
    transitionDecomposedParentsToDone,
    type DecomposedParentBatchStatusSyncResult
} from '../../../../gates/next-step/next-step-task-queue-transitions';
import {
    isOrchestratorSourceCheckout,
    joinOrchestratorPath
} from '../../../../gates/shared/helpers';
import {
    buildTaskAuditSummary,
    synchronizeFinalCloseoutArtifacts
} from '../../../../gates/task-audit/task-audit-summary';
import { withFilesystemLock } from '../../../../gate-runtime/task-events-locking';
import { reconcileTimelineSummaryForTask } from '../../../../gate-runtime/timeline-summary';
import {
    readTaskQueueStatus,
    syncTaskQueueStatusDetailed,
    type TaskQueueStatusSyncResult
} from '../task/task-queue-sync';
import type { TimelineEventEntry } from '../../../../gates/completion/completion-evidence';
import { buildCloseoutFailure, CloseoutLinkageFailure, type CloseoutRecoveryEventSignature } from '../../../../gates/completion/completion-linkage-recovery';

interface CompletionEventDetails {
    status: unknown;
    outcome: unknown;
    preflight_path: unknown;
    timeline_path: unknown;
    violations: unknown;
}

type CompletionFinalizationStep =
    | 'COMPACT_CLEANUP'
    | 'STATUS_CHANGED'
    | 'COMPLETION_GATE_PASSED'
    | 'FINAL_CLOSEOUT'
    | 'DECOMPOSED_PARENT_AUTO_CLOSE';

interface TimelineStatusTransition {
    previous_status: string | null;
    new_status: string | null;
    sequence: number;
}

interface AggregateRollbackOptions {
    taskId: string;
    aggregateSnapshot: FileSnapshot;
}

interface TaskEventRollbackOptions {
    taskEventsRoot: string;
    taskId: string;
    timelineSnapshot: FileSnapshot;
    aggregateSnapshot: FileSnapshot;
    expectedRollbackEventSequences: RollbackEventSignature[][];
}

interface TaskEventRollbackResult {
    errors: string[];
    timeline_restored: boolean;
    aggregate_reconciled: boolean;
    summary_reconciled: boolean;
}

interface FileSnapshot {
    path: string;
    existed: boolean;
    content: string | null;
}

type RollbackEventSignature = CloseoutRecoveryEventSignature;

interface RollbackEventIdentity {
    task_id: string;
    task_sequence: number;
    event_sha256: string;
}

export interface CompletionFinalizationResult {
    completion_event_recorded: boolean;
    status_event_recorded: boolean;
    queue_status_before: string | null;
    queue_status_after: string | null;
    latest_timeline_status: string | null;
    task_queue_sync: TaskQueueStatusSyncResult;
    decomposed_parent_status_sync: DecomposedParentAutoCloseResult;
}

export interface ReconcileSuccessfulCompletionFinalizationOptions {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    completionEventDetails: CompletionEventDetails;
    previousStatusHint?: string;
    assertRecoveryBindings?: (expectedEvents: readonly CloseoutRecoveryEventSignature[]) => void;
}

function quotePowerShellCliValue(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function buildCompletionGateRerunCommand(repoRoot: string, taskId: string, preflightPath: string): string {
    const cliPrefix = isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleName());
    return [
        `${cliPrefix} gate completion-gate`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        `--preflight-path ${quotePowerShellCliValue(preflightPath)}`
    ].join(' ');
}

function getLatestSequence(events: TimelineEventEntry[], predicate: (event: TimelineEventEntry) => boolean): number | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!predicate(event)) {
            continue;
        }
        const sequence = Number(event.sequence);
        if (Number.isFinite(sequence)) {
            return sequence;
        }
        return index;
    }
    return null;
}

function getCurrentCycleBoundarySequence(events: TimelineEventEntry[]): number | null {
    return getLatestSequence(events, (event) => {
        const eventType = String(event.event_type || '').trim();
        return (
            eventType === 'DOC_IMPACT_ASSESSED'
            || eventType === 'REVIEW_GATE_PASSED'
            || eventType === 'REVIEW_GATE_PASSED_WITH_OVERRIDE'
        );
    });
}

function getLatestStatusTransition(events: TimelineEventEntry[]): TimelineStatusTransition | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'STATUS_CHANGED') {
            continue;
        }
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown>
            : {};
        const sequence = Number(event.sequence);
        return {
            previous_status: typeof details.previous_status === 'string' ? details.previous_status.trim().toUpperCase() : null,
            new_status: typeof details.new_status === 'string' ? details.new_status.trim().toUpperCase() : null,
            sequence: Number.isFinite(sequence) ? sequence : index
        };
    }
    return null;
}

function getLatestStatusTransitionAfterSequence(
    events: TimelineEventEntry[],
    afterSequence: number | null
): TimelineStatusTransition | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'STATUS_CHANGED') {
            continue;
        }
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown>
            : {};
        const rawSequence = Number(event.sequence);
        const effectiveSequence = Number.isFinite(rawSequence) ? rawSequence : index;
        if (afterSequence != null && effectiveSequence <= afterSequence) {
            continue;
        }
        return {
            previous_status: typeof details.previous_status === 'string' ? details.previous_status.trim().toUpperCase() : null,
            new_status: typeof details.new_status === 'string' ? details.new_status.trim().toUpperCase() : null,
            sequence: effectiveSequence
        };
    }
    return null;
}

function getLatestCurrentCycleStatusTransition(events: TimelineEventEntry[]): TimelineStatusTransition | null {
    return getLatestStatusTransitionAfterSequence(events, getCurrentCycleBoundarySequence(events));
}

function hasCurrentCycleCompletionPass(events: TimelineEventEntry[]): boolean {
    const boundarySequence = getCurrentCycleBoundarySequence(events);
    const latestCompletionPassSequence = getLatestSequence(events, (event) => (
        String(event.event_type || '').trim() === 'COMPLETION_GATE_PASSED'
    ));
    if (latestCompletionPassSequence == null) {
        return false;
    }
    if (boundarySequence == null) {
        return true;
    }
    return latestCompletionPassSequence > boundarySequence;
}

function hasCurrentCycleDoneStatus(events: TimelineEventEntry[]): boolean {
    return getLatestCurrentCycleStatusTransition(events)?.new_status === 'DONE';
}

function isSuccessfulTaskQueueSync(syncResult: TaskQueueStatusSyncResult): boolean {
    return syncResult.outcome === 'updated' || syncResult.outcome === 'already_synced';
}

interface DecomposedParentAutoCloseOutcome {
    root_task_id: string;
    outcome: DecomposedParentBatchStatusSyncResult['outcome'];
    updated_task_ids: string[];
    error_message: string | null;
}

interface DecomposedParentAutoCloseResult {
    attempted_parent_task_ids: string[];
    updated_task_ids: string[];
    outcomes: DecomposedParentAutoCloseOutcome[];
}

interface DecomposedParentAutoCloseRollbackState {
    aggregateSnapshot: FileSnapshot;
    timelineSnapshotsByTaskId: Map<string, FileSnapshot>;
}

function buildEmptyDecomposedParentAutoCloseResult(): DecomposedParentAutoCloseResult {
    return {
        attempted_parent_task_ids: [],
        updated_task_ids: [],
        outcomes: []
    };
}

function appendUniqueTaskIds(target: string[], taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
        if (!target.includes(taskId)) {
            target.push(taskId);
        }
    }
}

function createDecomposedParentAutoCloseRollbackState(eventsRoot: string): DecomposedParentAutoCloseRollbackState {
    return {
        aggregateSnapshot: captureFileSnapshot(path.join(eventsRoot, 'all-tasks.jsonl')),
        timelineSnapshotsByTaskId: new Map<string, FileSnapshot>()
    };
}

function captureDecomposedParentAutoCloseTimelineSnapshots(params: {
    eventsRoot: string;
    rollbackState: DecomposedParentAutoCloseRollbackState;
    taskIds: readonly string[];
}): void {
    for (const taskId of params.taskIds) {
        if (params.rollbackState.timelineSnapshotsByTaskId.has(taskId)) {
            continue;
        }
        params.rollbackState.timelineSnapshotsByTaskId.set(
            taskId,
            captureFileSnapshot(path.join(params.eventsRoot, `${taskId}.jsonl`))
        );
    }
}

function rollbackDecomposedParentAutoCloseArtifacts(params: {
    eventsRoot: string;
    rollbackState: DecomposedParentAutoCloseRollbackState;
}): string[] {
    const rollbackErrors: string[] = [];
    const taskIds = [...params.rollbackState.timelineSnapshotsByTaskId.keys()];
    for (const [taskId, snapshot] of params.rollbackState.timelineSnapshotsByTaskId.entries()) {
        const taskLockPath = path.join(params.eventsRoot, `.${taskId}.lock`);
        try {
            withFilesystemLock(taskLockPath, {}, () => {
                restoreFileSnapshot(snapshot);
                reconcileTimelineSummaryForTask(params.eventsRoot, taskId);
            });
        } catch (rollbackError: unknown) {
            rollbackErrors.push(
                `${taskId} task-event rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
            );
        }
    }
    const aggregateLockPath = path.join(params.eventsRoot, '.all-tasks.lock');
    try {
        withFilesystemLock(aggregateLockPath, {}, () => {
            rollbackAggregateTaskEntriesForTaskIdsUnsafe({
                taskIds,
                aggregateSnapshot: params.rollbackState.aggregateSnapshot
            });
        });
    } catch (rollbackError: unknown) {
        rollbackErrors.push(
            `parent aggregate rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
    }
    return rollbackErrors;
}

function resolveParentTaskIdsLinkedToCompletedTasks(params: {
    taskEntries: Map<string, TaskQueueEntry>;
    completedTaskIds: Set<string>;
    settledParentTaskIds: Set<string>;
}): string[] {
    let expandedDoneBridge = true;
    while (expandedDoneBridge) {
        expandedDoneBridge = false;
        for (const entry of params.taskEntries.values()) {
            if (!isTaskQueueDoneStatus(entry.status) || params.completedTaskIds.has(entry.taskId)) {
                continue;
            }
            const childTaskIds = extractExplicitLinkedChildTaskIds(
                entry.notes,
                params.taskEntries.keys(),
                entry.taskId
            );
            if (childTaskIds.some((childTaskId) => params.completedTaskIds.has(childTaskId))) {
                params.completedTaskIds.add(entry.taskId);
                expandedDoneBridge = true;
            }
        }
    }

    const linkedParentTaskIds: string[] = [];
    for (const entry of params.taskEntries.values()) {
        if (!isDecomposedParentTask(entry) || params.settledParentTaskIds.has(entry.taskId)) {
            continue;
        }
        const childTaskIds = extractExplicitLinkedChildTaskIds(entry.notes, params.taskEntries.keys(), entry.taskId);
        if (childTaskIds.some((childTaskId) => params.completedTaskIds.has(childTaskId))) {
            linkedParentTaskIds.push(entry.taskId);
        }
    }
    return linkedParentTaskIds;
}

function assertSuccessfulDecomposedParentAutoCloseOutcome(syncResult: DecomposedParentBatchStatusSyncResult): void {
    if (syncResult.outcome === 'updated' || syncResult.outcome === 'already_synced') {
        return;
    }
    throw new Error(
        `decomposed parent auto-close failed for ${syncResult.root_task_id}: `
        + `${syncResult.error_message || syncResult.outcome}`
    );
}

function closeEligibleDecomposedParentsLinkedToCompletedTask(params: {
    repoRoot: string;
    eventsRoot: string;
    completedTaskId: string;
}): DecomposedParentAutoCloseResult {
    const result = buildEmptyDecomposedParentAutoCloseResult();
    const rollbackState = createDecomposedParentAutoCloseRollbackState(params.eventsRoot);
    const completedTaskIds = new Set<string>([params.completedTaskId]);
    const settledParentTaskIds = new Set<string>();
    let remainingPasses = Number.POSITIVE_INFINITY;

    try {
        while (remainingPasses > 0) {
            const taskEntries = readTaskQueueEntries(params.repoRoot, { missingFile: 'throw' });
            if (remainingPasses === Number.POSITIVE_INFINITY) {
                remainingPasses = Math.max(taskEntries.size + 1, 1);
            }
            remainingPasses -= 1;
            const linkedParentTaskIds = resolveParentTaskIdsLinkedToCompletedTasks({
                taskEntries,
                completedTaskIds,
                settledParentTaskIds
            });
            if (linkedParentTaskIds.length === 0) {
                break;
            }

            let updatedInPass = false;
            for (const parentTaskId of linkedParentTaskIds) {
                appendUniqueTaskIds(result.attempted_parent_task_ids, [parentTaskId]);
                const completionState = resolveDecomposedParentCompletionState(
                    taskEntries,
                    parentTaskId,
                    new Set<string>(),
                    extractExplicitLinkedChildTaskIds
                );
                if (
                    !completionState.hasLinkedChildren
                    || completionState.missingChildTaskIds.length > 0
                    || !completionState.complete
                ) {
                    continue;
                }
                const syncTaskIds = [...new Set([...completionState.completedDecomposedTaskIds, parentTaskId])];
                captureDecomposedParentAutoCloseTimelineSnapshots({
                    eventsRoot: params.eventsRoot,
                    rollbackState,
                    taskIds: syncTaskIds
                });
                const syncResult = transitionDecomposedParentsToDone({
                    repoRoot: params.repoRoot,
                    eventsRoot: params.eventsRoot,
                    rootTaskId: parentTaskId,
                    taskIds: syncTaskIds
                });
                result.outcomes.push({
                    root_task_id: parentTaskId,
                    outcome: syncResult.outcome,
                    updated_task_ids: syncResult.updated_task_ids,
                    error_message: syncResult.error_message
                });
                assertSuccessfulDecomposedParentAutoCloseOutcome(syncResult);
                settledParentTaskIds.add(parentTaskId);
                if (syncResult.updated_task_ids.length > 0) {
                    appendUniqueTaskIds(result.updated_task_ids, syncResult.updated_task_ids);
                    for (const updatedTaskId of syncResult.updated_task_ids) {
                        completedTaskIds.add(updatedTaskId);
                    }
                    updatedInPass = true;
                }
            }
            if (!updatedInPass) {
                break;
            }
        }

        if (remainingPasses <= 0) {
            throw new Error('decomposed parent auto-close exceeded the task queue graph traversal limit');
        }

        return result;
    } catch (error: unknown) {
        const rollbackErrors = rollbackDecomposedParentAutoCloseArtifacts({
            eventsRoot: params.eventsRoot,
            rollbackState
        });
        if (rollbackErrors.length > 0) {
            throw new Error(
                `${error instanceof Error ? error.message : String(error)} `
                + `Parent auto-close rollback failed: ${rollbackErrors.join(' | ')}`
            );
        }
        throw error;
    }
}

function resolveDoneTransitionPreviousStatus(
    queueStatusBefore: string | null,
    latestStatus: string | null,
    previousStatusHint?: string
): string {
    if (queueStatusBefore && queueStatusBefore !== 'DONE') {
        return queueStatusBefore;
    }
    if (latestStatus && latestStatus !== 'DONE') {
        return latestStatus;
    }
    const normalizedHint = String(previousStatusHint || 'IN_REVIEW').trim().toUpperCase();
    return normalizedHint || 'IN_REVIEW';
}

function captureFileSnapshot(filePath: string): FileSnapshot {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return {
            path: filePath,
            existed: false,
            content: null
        };
    }
    return {
        path: filePath,
        existed: true,
        content: fs.readFileSync(filePath, 'utf8')
    };
}

function captureFinalCloseoutSnapshots(orchestratorRoot: string, reviewsRoot: string, taskId: string): FileSnapshot[] {
    return [
        path.join(reviewsRoot, `${taskId}-final-closeout.json`),
        path.join(reviewsRoot, `${taskId}-final-closeout.md`),
        path.join(reviewsRoot, `${taskId}-final-user-report.md`),
        resolveTaskHistoryLedgerPath(orchestratorRoot, taskId)
    ].map((artifactPath) => captureFileSnapshot(artifactPath));
}

function restoreFileSnapshot(snapshot: FileSnapshot): void {
    if (fs.existsSync(snapshot.path)) {
        const stat = fs.statSync(snapshot.path);
        if (!stat.isFile()) {
            fs.rmSync(snapshot.path, { recursive: true, force: true });
        }
    }
    if (!snapshot.existed) {
        if (fs.existsSync(snapshot.path)) {
            fs.rmSync(snapshot.path, { recursive: true, force: true });
        }
        return;
    }
    fs.mkdirSync(path.dirname(snapshot.path), { recursive: true });
    writeFileAtomically(snapshot.path, snapshot.content || '', { encoding: 'utf8' });
}

function restoreSnapshots(snapshots: readonly FileSnapshot[]): string[] {
    const rollbackErrors: string[] = [];
    for (const snapshot of snapshots) {
        try {
            restoreFileSnapshot(snapshot);
        } catch (rollbackError: unknown) {
            rollbackErrors.push(
                `${path.basename(snapshot.path)} restore failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
            );
        }
    }
    return rollbackErrors;
}

function rawLineLooksLikeTaskId(rawLine: string, taskId: string): boolean {
    const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`"task_id"\\s*:\\s*"${escapedTaskId}"`).test(rawLine);
}

function readCurrentSnapshotContent(snapshot: FileSnapshot): string {
    if (!fs.existsSync(snapshot.path)) {
        if (!snapshot.existed) {
            return '';
        }
        throw new Error(
            `rollback target '${path.basename(snapshot.path)}' no longer matches the captured snapshot: expected file is missing`
        );
    }
    const stat = fs.statSync(snapshot.path);
    if (!stat.isFile()) {
        throw new Error(
            `rollback target '${path.basename(snapshot.path)}' no longer matches the captured snapshot: expected file but found non-file`
        );
    }
    return fs.readFileSync(snapshot.path, 'utf8');
}

function getAppendedRawLinesSinceSnapshot(snapshot: FileSnapshot): string[] {
    const baselineContent = snapshot.existed ? (snapshot.content || '') : '';
    const currentContent = readCurrentSnapshotContent(snapshot);
    if (!currentContent.startsWith(baselineContent)) {
        throw new Error(
            `rollback target '${path.basename(snapshot.path)}' no longer matches the captured snapshot prefix`
        );
    }
    return currentContent
        .slice(baselineContent.length)
        .split('\n')
        .filter((line) => line.trim().length > 0);
}

function buildSnapshotRestoredContent(snapshot: FileSnapshot, appendedLines: readonly string[]): string {
    const baselineContent = snapshot.existed ? (snapshot.content || '') : '';
    if (appendedLines.length === 0) {
        return baselineContent;
    }
    const separator = baselineContent.length > 0 && !baselineContent.endsWith('\n')
        ? '\n'
        : '';
    return `${baselineContent}${separator}${appendedLines.join('\n')}\n`;
}

function shouldKeepAppendedAggregateLogLineForTaskIds(rawLine: string, taskIds: ReadonlySet<string>): boolean {
    try {
        const parsed = JSON.parse(rawLine) as Record<string, unknown>;
        return !taskIds.has(String(parsed.task_id || '').trim());
    } catch {
        return ![...taskIds].some((taskId) => rawLineLooksLikeTaskId(rawLine, taskId));
    }
}

function parseRollbackEventIdentity(rawLine: string): RollbackEventIdentity | null {
    try {
        const parsed = JSON.parse(rawLine) as Record<string, unknown>;
        const integrity = parsed.integrity && typeof parsed.integrity === 'object' && !Array.isArray(parsed.integrity)
            ? parsed.integrity as Record<string, unknown>
            : null;
        const taskId = String(parsed.task_id || '').trim();
        const taskSequence = Number(integrity?.task_sequence);
        const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
        if (!taskId || !Number.isSafeInteger(taskSequence) || taskSequence < 1 || !/^[a-f0-9]{64}$/u.test(eventSha256)) {
            return null;
        }
        return {
            task_id: taskId,
            task_sequence: taskSequence,
            event_sha256: eventSha256
        };
    } catch {
        return null;
    }
}

function getRollbackEventIdentityKey(identity: RollbackEventIdentity): string {
    return `${identity.task_id}\u0000${identity.task_sequence}\u0000${identity.event_sha256}`;
}

function getTransactionOwnedRollbackEventIdentities(rawLines: readonly string[]): RollbackEventIdentity[] {
    const identities = rawLines.map((line) => parseRollbackEventIdentity(line));
    if (identities.some((identity) => identity == null)) {
        throw new Error('transaction-owned task-event suffix is missing valid integrity identity');
    }
    return identities as RollbackEventIdentity[];
}

function rollbackAggregateTransactionEventsAfterRewriteUnsafe(options: {
    aggregateSnapshot: FileSnapshot;
    transactionEventIdentities: readonly RollbackEventIdentity[];
}): void {
    if (options.transactionEventIdentities.length === 0) {
        return;
    }
    const aggregatePath = options.aggregateSnapshot.path;
    const currentContent = readCurrentSnapshotContent(options.aggregateSnapshot);
    const transactionIdentityKeys = new Set(
        options.transactionEventIdentities.map((identity) => getRollbackEventIdentityKey(identity))
    );
    let removedCount = 0;
    const keptLines = currentContent
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .filter((line) => {
            const identity = parseRollbackEventIdentity(line);
            if (!identity || !transactionIdentityKeys.has(getRollbackEventIdentityKey(identity))) {
                return true;
            }
            removedCount += 1;
            return false;
        });
    if (removedCount === 0) {
        return;
    }
    const restoredContent = keptLines.length > 0 ? `${keptLines.join('\n')}\n` : '';
    if (!options.aggregateSnapshot.existed && restoredContent.length === 0) {
        fs.rmSync(aggregatePath, { force: true });
        return;
    }
    writeFileAtomically(aggregatePath, restoredContent, { encoding: 'utf8' });
}

function rollbackAggregateTaskEntriesForTaskIdsUnsafe(options: {
    taskIds: readonly string[];
    aggregateSnapshot: FileSnapshot;
    transactionEventIdentities?: readonly RollbackEventIdentity[];
}): void {
    const taskIds = new Set(options.taskIds);
    const aggregatePath = options.aggregateSnapshot.path;
    const baselineContent = options.aggregateSnapshot.existed ? (options.aggregateSnapshot.content || '') : '';
    const currentContent = readCurrentSnapshotContent(options.aggregateSnapshot);
    if (!currentContent.startsWith(baselineContent) && options.transactionEventIdentities) {
        rollbackAggregateTransactionEventsAfterRewriteUnsafe({
            aggregateSnapshot: options.aggregateSnapshot,
            transactionEventIdentities: options.transactionEventIdentities
        });
        return;
    }
    const appendedTailLines = getAppendedRawLinesSinceSnapshot(options.aggregateSnapshot)
        .filter((line) => shouldKeepAppendedAggregateLogLineForTaskIds(line, taskIds));
    const restoredContent = buildSnapshotRestoredContent(options.aggregateSnapshot, appendedTailLines);
    if (!options.aggregateSnapshot.existed && restoredContent.length === 0) {
        if (fs.existsSync(aggregatePath)) {
            fs.rmSync(aggregatePath, { force: true });
        }
        return;
    }
    writeFileAtomically(aggregatePath, restoredContent, { encoding: 'utf8' });
}

function rollbackAggregateTaskEntriesUnsafe(
    options: AggregateRollbackOptions,
    transactionEventIdentities: readonly RollbackEventIdentity[]
): void {
    rollbackAggregateTaskEntriesForTaskIdsUnsafe({
        taskIds: [options.taskId],
        aggregateSnapshot: options.aggregateSnapshot,
        transactionEventIdentities
    });
}

function normalizeRollbackDetailValue(value: unknown): string {
    if (value == null) {
        return '';
    }
    return String(value).trim();
}

function buildRollbackEventSignature(
    eventType: string,
    detailSubset: Record<string, unknown> = {}
): RollbackEventSignature {
    const normalizedDetailSubset: Record<string, string> = {};
    for (const [key, value] of Object.entries(detailSubset)) {
        normalizedDetailSubset[key] = normalizeRollbackDetailValue(value);
    }
    return {
        event_type: String(eventType || '').trim().toUpperCase(),
        detail_subset: normalizedDetailSubset
    };
}

function getRollbackEventSignatures(rawLines: readonly string[]): RollbackEventSignature[] {
    const eventSignatures: RollbackEventSignature[] = [];
    for (const rawLine of rawLines) {
        try {
            const parsed = JSON.parse(rawLine) as Record<string, unknown>;
            const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                ? parsed.details as Record<string, unknown>
                : {};
            const normalizedDetails: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(details)) {
                normalizedDetails[key] = value;
            }
            eventSignatures.push(buildRollbackEventSignature(
                String(parsed.event_type || ''),
                normalizedDetails
            ));
        } catch {
            eventSignatures.push(buildRollbackEventSignature('<UNPARSEABLE>'));
        }
    }
    return eventSignatures;
}

function resolveAllowedRollbackEventSequences(
    pendingFinalizationStep: CompletionFinalizationStep | null,
    statusDoneRecorded: boolean,
    completionPassRecorded: boolean,
    statusEventRecorded: boolean,
    completionEventRecorded: boolean,
    previousStatusForDoneTransition: string,
    completionEventDetails: CompletionEventDetails
): RollbackEventSignature[][] {
    const statusChangedSignature = buildRollbackEventSignature('STATUS_CHANGED', {
        previous_status: previousStatusForDoneTransition,
        new_status: 'DONE'
    });
    const completionPassedSignature = buildRollbackEventSignature('COMPLETION_GATE_PASSED', {
        status: completionEventDetails.status,
        outcome: completionEventDetails.outcome,
        preflight_path: completionEventDetails.preflight_path,
        timeline_path: completionEventDetails.timeline_path
    });
    if (pendingFinalizationStep === 'STATUS_CHANGED') {
        return statusDoneRecorded ? [[]] : [[], [statusChangedSignature]];
    }
    if (pendingFinalizationStep === 'COMPLETION_GATE_PASSED') {
        if (completionPassRecorded) {
            return [[]];
        }
        return statusDoneRecorded
            ? [[], [completionPassedSignature]]
            : [[statusChangedSignature], [statusChangedSignature, completionPassedSignature]];
    }
    if (
        pendingFinalizationStep === 'FINAL_CLOSEOUT'
        || pendingFinalizationStep === 'DECOMPOSED_PARENT_AUTO_CLOSE'
        || pendingFinalizationStep === 'COMPACT_CLEANUP'
    ) {
        const sequence: RollbackEventSignature[] = [];
        if (statusEventRecorded) {
            sequence.push(statusChangedSignature);
        }
        if (completionEventRecorded) {
            sequence.push(completionPassedSignature);
        }
        return [sequence];
    }
    return [[]];
}

function materializeFinalCloseoutArtifactsForCompletionGate(options: {
    repoRoot: string;
    taskId: string;
    eventsRoot: string;
    reviewsRoot: string;
    assertRecoveryBindings?: () => void;
}): void {
    const summary = buildTaskAuditSummary({
        taskId: options.taskId,
        repoRoot: options.repoRoot,
        eventsRoot: options.eventsRoot,
        reviewsRoot: options.reviewsRoot,
        ignoreActiveCompletionFinalizationLock: true
    });
    options.assertRecoveryBindings?.();
    synchronizeFinalCloseoutArtifacts(summary);
    const finalCloseout = summary.final_closeout;
    const requiredArtifactPaths = [
        finalCloseout.artifact_paths.json,
        finalCloseout.artifact_paths.markdown,
        finalCloseout.artifact_paths.final_user_report
    ].filter(Boolean) as string[];
    const missingArtifacts = requiredArtifactPaths.filter((artifactPath) => (
        !fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()
    ));
    if (
        summary.status !== 'PASS'
        || finalCloseout.status !== 'READY'
        || finalCloseout.artifact_state !== 'MATERIALIZED'
        || missingArtifacts.length > 0
    ) {
        throw buildCloseoutFailure(
            `final closeout materialization did not produce a READY report: `
            + `audit_status=${summary.status}, closeout_status=${finalCloseout.status}, `
            + `artifact_state=${finalCloseout.artifact_state}, `
            + `missing_artifacts=${missingArtifacts.map((entry) => path.basename(entry)).join(', ') || '<none>'}`,
            summary
        );
    }
}

function formatRollbackEventSignature(signature: RollbackEventSignature): string {
    const detailEntries = Object.entries(signature.detail_subset);
    if (detailEntries.length === 0) {
        return signature.event_type || '<UNKNOWN>';
    }
    return `${signature.event_type}(${detailEntries.map(([key, value]) => `${key}=${value}`).join(', ')})`;
}

function formatAllowedRollbackEventSequences(sequences: readonly RollbackEventSignature[][]): string {
    return sequences
        .map((sequence) => sequence.length === 0 ? '<none>' : sequence.map((signature) => formatRollbackEventSignature(signature)).join(' -> '))
        .join(' | ');
}

function rollbackEventSignatureMatches(actual: RollbackEventSignature, expected: RollbackEventSignature): boolean {
    if (actual.event_type !== expected.event_type) {
        return false;
    }
    return Object.entries(expected.detail_subset).every(([key, value]) => (
        normalizeRollbackDetailValue(actual.detail_subset[key]) === value
    ));
}

function assertNoUnexpectedSameTaskAppend(options: TaskEventRollbackOptions): string[] {
    const appendedRawLines = getAppendedRawLinesSinceSnapshot(options.timelineSnapshot);
    const appendedEventSignatures = getRollbackEventSignatures(appendedRawLines);
    const allowedSequences = options.expectedRollbackEventSequences;
    const rollbackTailIsAllowed = allowedSequences.some((sequence) => (
        sequence.length === appendedEventSignatures.length
        && sequence.every((signature, index) => rollbackEventSignatureMatches(appendedEventSignatures[index], signature))
    ));
    if (!rollbackTailIsAllowed) {
        throw new Error(
            `same-task concurrent append detected before rollback: appended_events=${appendedEventSignatures.map((signature) => formatRollbackEventSignature(signature)).join(' -> ') || '<none>'}; `
            + `allowed_sequences=${formatAllowedRollbackEventSequences(allowedSequences)}`
        );
    }
    return appendedRawLines;
}

function rollbackTaskEventArtifacts(options: TaskEventRollbackOptions): TaskEventRollbackResult {
    const rollbackResult: TaskEventRollbackResult = {
        errors: [],
        timeline_restored: false,
        aggregate_reconciled: false,
        summary_reconciled: false
    };
    const taskLockPath = path.join(options.taskEventsRoot, `.${options.taskId}.lock`);
    const aggregateLockPath = path.join(options.taskEventsRoot, '.all-tasks.lock');
    try {
        withFilesystemLock(taskLockPath, {}, () => {
            const appendedRawLines = assertNoUnexpectedSameTaskAppend(options);
            const transactionEventIdentities = getTransactionOwnedRollbackEventIdentities(appendedRawLines);
            restoreFileSnapshot(options.timelineSnapshot);
            rollbackResult.timeline_restored = true;
            // Global lock order: nested completion rollback always acquires task before aggregate.
            withFilesystemLock(aggregateLockPath, {}, () => {
                rollbackAggregateTaskEntriesUnsafe({
                    taskId: options.taskId,
                    aggregateSnapshot: options.aggregateSnapshot
                }, transactionEventIdentities);
            });
            rollbackResult.aggregate_reconciled = true;
            reconcileTimelineSummaryForTask(options.taskEventsRoot, options.taskId);
            rollbackResult.summary_reconciled = true;
        });
    } catch (rollbackError: unknown) {
        rollbackResult.errors.push(
            `task-event rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
    }
    return rollbackResult;
}

function buildFinalizationRepairMessage(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    reason: string,
    queueStatus: string | null,
    latestTimelineStatus: string | null,
    completionPassRecorded: boolean,
    statusDoneRecorded: boolean,
    syncResult: TaskQueueStatusSyncResult | null
): string {
    const stateParts = [
        `task_queue_status=${queueStatus || 'missing'}`,
        `latest_timeline_status=${latestTimelineStatus || 'missing'}`,
        `completion_pass_recorded=${completionPassRecorded ? 'yes' : 'no'}`,
        `status_done_recorded=${statusDoneRecorded ? 'yes' : 'no'}`
    ];
    if (syncResult) {
        stateParts.push(`task_queue_sync=${syncResult.outcome}`);
        if (syncResult.error_message) {
            stateParts.push(`task_queue_sync_error=${syncResult.error_message}`);
        }
    }
    return [
        `completion-gate finalization for '${taskId}' is incomplete: ${reason}`,
        `Observed state: ${stateParts.join(', ')}.`,
        `Fix the underlying issue, then rerun: ${buildCompletionGateRerunCommand(repoRoot, taskId, preflightPath)}`
    ].join(' ');
}

export async function reconcileSuccessfulCompletionFinalizationAsync(
    options: ReconcileSuccessfulCompletionFinalizationOptions
): Promise<CompletionFinalizationResult> {
    const repoRoot = path.resolve(options.repoRoot);
    const taskId = String(options.taskId || '').trim();
    const orchestratorRoot = joinOrchestratorPath(repoRoot, '');
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    const taskEventsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const reviewsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const timelinePath = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const aggregatePath = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', 'all-tasks.jsonl'));
    const snapshots = [
        captureFileSnapshot(taskPath),
        captureFileSnapshot(timelinePath),
        captureFileSnapshot(aggregatePath),
        ...captureFinalCloseoutSnapshots(orchestratorRoot, reviewsRoot, taskId)
    ] as const;
    const orderedEvents = collectOrderedTimelineEvents(timelinePath, []);
    const queueStatusBefore = readTaskQueueStatus(repoRoot, taskId);
    const latestStatusTransition = getLatestStatusTransition(orderedEvents);
    const latestCurrentCycleStatusTransition = getLatestCurrentCycleStatusTransition(orderedEvents);
    const completionPassRecorded = hasCurrentCycleCompletionPass(orderedEvents);
    const statusDoneRecorded = hasCurrentCycleDoneStatus(orderedEvents);
    const previousStatusForDoneTransition = resolveDoneTransitionPreviousStatus(
        queueStatusBefore,
        latestCurrentCycleStatusTransition?.new_status || latestStatusTransition?.new_status || null,
        options.previousStatusHint
    );

    const syncResult = syncTaskQueueStatusDetailed(repoRoot, taskId, 'DONE');
    if (!isSuccessfulTaskQueueSync(syncResult)) {
        const rollbackErrors = syncResult.outcome === 'write_failed'
            ? restoreSnapshots([snapshots[0]])
            : [];
        const restoredEvents = collectOrderedTimelineEvents(timelinePath, []);
        const restoredLatestStatusTransition = getLatestStatusTransition(restoredEvents);
        const restoredLatestCurrentCycleStatusTransition = getLatestCurrentCycleStatusTransition(restoredEvents);
        const restoredQueueStatus = readTaskQueueStatus(repoRoot, taskId);
        const restoredCompletionPassRecorded = hasCurrentCycleCompletionPass(restoredEvents);
        const restoredStatusDoneRecorded = hasCurrentCycleDoneStatus(restoredEvents);
        const effectiveSyncResult: TaskQueueStatusSyncResult = rollbackErrors.length === 0
            ? syncResult
            : {
                ...syncResult,
                error_message: rollbackErrors.join(' | ')
            };
        throw new Error(
            buildFinalizationRepairMessage(
                repoRoot,
                taskId,
                options.preflightPath,
                `TASK.md queue state could not be reconciled to DONE.${rollbackErrors.length > 0 ? ` Rollback failed: ${rollbackErrors.join(' ')}` : ''}`,
                restoredQueueStatus,
                restoredLatestCurrentCycleStatusTransition?.new_status || restoredLatestStatusTransition?.new_status || null,
                restoredCompletionPassRecorded,
                restoredStatusDoneRecorded,
                effectiveSyncResult
            )
        );
    }

    let statusEventRecorded = false;
    let completionEventRecorded = false;
    let pendingFinalizationStep: CompletionFinalizationStep | null = null;
    let decomposedParentStatusSync = buildEmptyDecomposedParentAutoCloseResult();

    try {
        if (!statusDoneRecorded) {
            pendingFinalizationStep = 'STATUS_CHANGED';
            await emitMandatoryStatusChangedEventAsync(orchestratorRoot, taskId, previousStatusForDoneTransition, 'DONE');
            statusEventRecorded = true;
        }
        if (!completionPassRecorded) {
            pendingFinalizationStep = 'COMPLETION_GATE_PASSED';
            await emitMandatoryCompletionGateEventAsync(orchestratorRoot, taskId, true, options.completionEventDetails);
            completionEventRecorded = true;
        }
        // Recovery must check after the last await, before closeout removes review scratch.
        if (options.assertRecoveryBindings) {
            pendingFinalizationStep = 'COMPACT_CLEANUP';
            await cleanupCompactAtTaskBoundary(repoRoot, taskId, { validationOutput: false });
        }
        pendingFinalizationStep = 'FINAL_CLOSEOUT';
        materializeFinalCloseoutArtifactsForCompletionGate({
            repoRoot,
            taskId,
            eventsRoot: taskEventsRoot,
            reviewsRoot,
            assertRecoveryBindings: options.assertRecoveryBindings ? () => options.assertRecoveryBindings?.(
                resolveAllowedRollbackEventSequences('FINAL_CLOSEOUT', statusDoneRecorded, completionPassRecorded,
                    statusEventRecorded, completionEventRecorded, previousStatusForDoneTransition, options.completionEventDetails)[0]
            ) : undefined
        });
        // Ephemeral output is not gate evidence. Delete before parent auto-close,
        // whose transaction owns its own rollback and must remain the last step.
        if (!options.assertRecoveryBindings) {
            pendingFinalizationStep = 'COMPACT_CLEANUP';
            await cleanupCompactAtTaskBoundary(repoRoot, taskId, { validationOutput: false });
        }
        pendingFinalizationStep = 'DECOMPOSED_PARENT_AUTO_CLOSE';
        decomposedParentStatusSync = closeEligibleDecomposedParentsLinkedToCompletedTask({
            repoRoot,
            eventsRoot: taskEventsRoot,
            completedTaskId: taskId
        });
        pendingFinalizationStep = null;
    } catch (error: unknown) {
        const taskEventRollbackResult = rollbackTaskEventArtifacts({
            taskEventsRoot,
            taskId,
            timelineSnapshot: snapshots[1],
            aggregateSnapshot: snapshots[2],
            expectedRollbackEventSequences: resolveAllowedRollbackEventSequences(
                pendingFinalizationStep,
                statusDoneRecorded,
                completionPassRecorded,
                statusEventRecorded,
                completionEventRecorded,
                previousStatusForDoneTransition,
                options.completionEventDetails
            )
        });
        const queueRollbackErrors = taskEventRollbackResult.timeline_restored
            ? restoreSnapshots([snapshots[0]])
            : [];
        const finalCloseoutRollbackErrors = restoreSnapshots(snapshots.slice(3));
        const rollbackErrors = [
            ...taskEventRollbackResult.errors,
            ...queueRollbackErrors,
            ...finalCloseoutRollbackErrors
        ];

        const restoredEvents = collectOrderedTimelineEvents(timelinePath, []);
        const restoredLatestStatusTransition = getLatestStatusTransition(restoredEvents);
        const restoredLatestCurrentCycleStatusTransition = getLatestCurrentCycleStatusTransition(restoredEvents);
        const restoredQueueStatus = readTaskQueueStatus(repoRoot, taskId);
        const restoredCompletionPassRecorded = hasCurrentCycleCompletionPass(restoredEvents);
        const restoredStatusDoneRecorded = hasCurrentCycleDoneStatus(restoredEvents);
        const effectiveSyncResult: TaskQueueStatusSyncResult = rollbackErrors.length === 0
            ? syncResult
            : {
                ...syncResult,
                error_message: rollbackErrors.join(' | ')
            };

        const repairMessage = buildFinalizationRepairMessage(
                repoRoot,
                taskId,
                options.preflightPath,
                `${pendingFinalizationStep === 'COMPACT_CLEANUP'
                    ? `mandatory compact cache deletion failed. ${error instanceof Error ? error.message : String(error)}`
                    : pendingFinalizationStep === 'FINAL_CLOSEOUT'
                    ? `mandatory final closeout materialization failed. ${error instanceof Error ? error.message : String(error)}`
                    : pendingFinalizationStep === 'DECOMPOSED_PARENT_AUTO_CLOSE'
                    ? `mandatory decomposed parent auto-close failed. ${error instanceof Error ? error.message : String(error)}`
                    : pendingFinalizationStep === 'COMPLETION_GATE_PASSED'
                    ? `mandatory COMPLETION_GATE_PASSED append failed. ${error instanceof Error ? error.message : String(error)}`
                    : `mandatory STATUS_CHANGED append failed. ${error instanceof Error ? error.message : String(error)}`}${rollbackErrors.length > 0 ? ` Rollback failed: ${rollbackErrors.join(' ')}` : ''}`,
                restoredQueueStatus,
                restoredLatestCurrentCycleStatusTransition?.new_status || restoredLatestStatusTransition?.new_status || null,
                restoredCompletionPassRecorded,
                restoredStatusDoneRecorded,
                effectiveSyncResult
            );
        throw pendingFinalizationStep === 'FINAL_CLOSEOUT' && rollbackErrors.length === 0 && error instanceof CloseoutLinkageFailure
            ? new CloseoutLinkageFailure(repairMessage, error.defects)
            : new Error(repairMessage);
    }

    // Validation scratch survives any mandatory finalization rollback. Only after
    // the child and parent transactions succeed may earlier failed attempts be removed.
    for (const note of cleanupTaskValidationOutput(repoRoot, new Set([
        taskId, ...decomposedParentStatusSync.updated_task_ids
    ]))) console.warn(note);

    return {
        completion_event_recorded: completionEventRecorded,
        status_event_recorded: statusEventRecorded,
        queue_status_before: queueStatusBefore,
        queue_status_after: readTaskQueueStatus(repoRoot, taskId),
        latest_timeline_status: statusDoneRecorded || statusEventRecorded ? 'DONE' : (latestCurrentCycleStatusTransition?.new_status || latestStatusTransition?.new_status || null),
        task_queue_sync: syncResult,
        decomposed_parent_status_sync: decomposedParentStatusSync
    };
}
