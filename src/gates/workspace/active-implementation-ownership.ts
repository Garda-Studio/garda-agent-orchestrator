import * as fs from 'node:fs';
import * as path from 'node:path';

import { isTaskQueueActiveStatus } from '../../core/active-task-state';
import { readTaskQueueEntries, type TaskQueueEntry } from '../../core/task-queue-read';
import { parseOperatorConfirmationYes, validateFreshOperatorConfirmation } from '../../core/operator-confirmation';
import { inspectTaskEventFile, readTaskTimelineJsonlEntries } from '../../gate-runtime/task-events';
import { acquireFilesystemLock, releaseFilesystemLock, type LockHandle } from '../../gate-runtime/task-events-locking';
import { isPathRealpathInsideRoot, joinOrchestratorPath, resolvePathInsideRepo } from '../shared/helpers';
import { getNoOpEvidence, getCurrentNoOpEventSha256 } from '../task-mode/no-op';
import { getTaskModeEvidence } from '../task-mode/task-mode';

export interface ActiveTaskApproval {
    operator_confirmed_at_utc: string;
    owners: Record<string, string>;
}

export function readImplementationTaskMode(repoRoot: string, taskId: string, artifactPath = '') {
    const mode = getTaskModeEvidence(repoRoot, taskId, artifactPath);
    return !artifactPath && mode.evidence_status !== 'PASS' && mode.timeline_artifact_path
        ? getTaskModeEvidence(repoRoot, taskId, mode.timeline_artifact_path)
        : mode;
}

function readActiveTaskApproval(repoRoot: string, taskId: string, artifactPath = ''): ActiveTaskApproval | null {
    const mode = readImplementationTaskMode(repoRoot, taskId, artifactPath);
    if (mode.evidence_status !== 'PASS' || !mode.evidence_hash) return null;
    const timelinePath = joinOrchestratorPath(repoRoot, `runtime/task-events/${taskId}.jsonl`);
    const inspection = inspectTaskEventFile(timelinePath, taskId);
    if (inspection.status !== 'PASS' && inspection.status !== 'PASS_WITH_LEGACY_PREFIX') return null;
    const entries = readTaskTimelineJsonlEntries(timelinePath);
    let eventIndex = entries.length - 1;
    while (eventIndex >= 0 && entries[eventIndex].record?.event_type !== 'TASK_MODE_ENTERED') eventIndex--;
    const event = entries[eventIndex]?.record;
    const details = event?.details as Record<string, unknown> | undefined;
    const approval = details?.active_task_approval as (ActiveTaskApproval & { task_mode_sha256?: string }) | undefined;
    if (!approval || approval.task_mode_sha256 !== mode.evidence_hash
        || typeof approval.operator_confirmed_at_utc !== 'string'
        || !Number.isFinite(Date.parse(approval.operator_confirmed_at_utc))
        || !approval.owners || typeof approval.owners !== 'object' || Array.isArray(approval.owners)) return null;
    return { operator_confirmed_at_utc: approval.operator_confirmed_at_utc, owners: approval.owners };
}

function readScopePathIdentity(repoRoot: string, scopePath: string): { path: string; fileIdentity: string | null } {
    const resolved = resolvePathInsideRepo(scopePath, repoRoot, { allowMissing: true });
    if (!resolved) throw new Error(`Invalid planned scope path: ${scopePath}`);
    let existing = resolved;
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) throw new Error(`Cannot resolve planned scope path: ${scopePath}`);
        existing = parent;
    }
    const physicalPath = path.join(fs.realpathSync.native(existing), path.relative(existing, resolved)).replace(/\\/gu, '/');
    const stat = existing === resolved ? fs.statSync(existing, { bigint: true }) : null;
    return {
        path: process.platform === 'win32' ? physicalPath.toLowerCase() : physicalPath,
        fileIdentity: stat?.isFile() && stat.ino !== 0n ? `${stat.dev}:${stat.ino}` : null
    };
}

function findScopeOverlap(repoRoot: string, receivingScope: string[], ownerScope: string[]): string[] {
    if (ownerScope.length === 0) return [];
    const ownerPaths = ownerScope.map(scopePath => readScopePathIdentity(repoRoot, scopePath));
    return receivingScope.filter(scopePath => {
        const receiving = readScopePathIdentity(repoRoot, scopePath);
        return ownerPaths.some(owner => receiving.path === owner.path
            || receiving.path.startsWith(`${owner.path}/`) || owner.path.startsWith(`${receiving.path}/`)
            || (!!receiving.fileIdentity && receiving.fileIdentity === owner.fileIdentity));
    });
}

function approvalCoversOwners(repoRoot: string, taskId: string, owners: string[], approval: ActiveTaskApproval | null): boolean {
    if (!approval) return false;
    const receiver = readImplementationTaskMode(repoRoot, taskId);
    if (receiver.evidence_status !== 'PASS') return false;
    return owners.every(owner => {
        const mode = readImplementationTaskMode(repoRoot, owner);
        return mode.evidence_status === 'PASS' && !!mode.evidence_hash
            && approval.owners[owner] === mode.evidence_hash
            && findScopeOverlap(repoRoot, receiver.planned_changed_files, mode.planned_changed_files).length === 0;
    });
}

export function findUnapprovedActiveImplementationOwners(
    repoRoot: string, taskId: string, entries?: ReadonlyMap<string, TaskQueueEntry>
): string[] {
    const owners = findOtherActiveImplementationOwners(repoRoot, taskId, entries);
    return owners.length === 0 || approvalCoversOwners(repoRoot, taskId, owners, readActiveTaskApproval(repoRoot, taskId))
        ? [] : owners;
}

function activeTaskConfirmationMessage(taskId: string, owners: string[]): string {
    return `Unfinished tasks in this worktree: ${owners.join(', ')}. `
        + `Ask the operator to confirm starting ${taskId} while preserving existing changes. `
        + `After approval, re-enter task mode with ${owners.map(owner => `--allow-active-task "${owner}"`).join(' ')} `
        + '--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" and an explicit planned file scope. '
        + 'This task-specific approval preserves dirty-workspace protection and is reused by later gates.';
}

export function resolveActiveTaskEntryApproval(input: {
    repoRoot: string;
    taskId: string;
    artifactPath: string;
    entries: ReadonlyMap<string, TaskQueueEntry>;
    allowedActiveTasks?: unknown;
    operatorConfirmed?: unknown;
    operatorConfirmedAtUtc?: unknown;
    plannedChangedFiles: string[];
}): ActiveTaskApproval | null {
    const owners = findOtherActiveImplementationOwners(input.repoRoot, input.taskId, input.entries);
    if (owners.length === 0) return null;
    // Entry writes a new receiver artifact. Only downstream gates may reuse a
    // grant; re-entry must not carry consent into a new scope or baseline.
    // Recovery may reuse the already disclosed owner list, but never consent.
    const previous = readActiveTaskApproval(input.repoRoot, input.taskId, input.artifactPath);
    const requested = Array.isArray(input.allowedActiveTasks)
        ? [...new Set(input.allowedActiveTasks.map(value => String(value).trim()))].sort()
        : approvalCoversOwners(input.repoRoot, input.taskId, owners, previous) ? owners : [];
    if (JSON.stringify(requested) !== JSON.stringify(owners)) {
        throw new Error(`task-mode entry refused for ${input.taskId}: ` + activeTaskConfirmationMessage(input.taskId, owners));
    }
    validateFreshOperatorConfirmation({
        actionLabel: 'Starting work alongside unfinished tasks',
        confirmed: parseOperatorConfirmationYes(input.operatorConfirmed),
        confirmedAtUtc: String(input.operatorConfirmedAtUtc || '').trim(),
        requireConfirmedAtUtc: true,
        instruction: activeTaskConfirmationMessage(input.taskId, owners)
    });
    if (input.plannedChangedFiles.length === 0) {
        throw new Error('Working alongside unfinished tasks requires an explicit --planned-changed-file scope.');
    }
    const ownerHashes = owners.map(owner => {
        const mode = readImplementationTaskMode(input.repoRoot, owner);
        if (mode.evidence_status !== 'PASS' || !mode.evidence_hash) {
            throw new Error(`Cannot approve unfinished task ${owner}: its task-mode evidence is invalid.`);
        }
        const overlappingFiles = findScopeOverlap(input.repoRoot, input.plannedChangedFiles, mode.planned_changed_files);
        if (overlappingFiles.length > 0) {
            throw new Error(`Task scope overlaps unfinished task ${owner}: ${overlappingFiles.join(', ')}. Choose disjoint task-owned files.`);
        }
        return [owner, mode.evidence_hash];
    });
    return { operator_confirmed_at_utc: String(input.operatorConfirmedAtUtc).trim(), owners: Object.fromEntries(ownerHashes) };
}

export function withImplementationOwnershipLock<T>(repoRoot: string, operation: (lock: LockHandle) => T): T {
    const lockPath = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-queue-locks', 'active-implementation.lock'));
    if (!isPathRealpathInsideRoot(lockPath, repoRoot, { allowMissing: true })) {
        throw new Error('Implementation ownership lock must remain inside the worktree.');
    }
    const { handle } = acquireFilesystemLock(lockPath, {
        ownerLabel: 'active-implementation-owner',
        requireKnownDeadOwner: true,
        allowForeignHostStaleRecovery: false
    });
    try {
        return operation(handle);
    } finally {
        releaseFilesystemLock(handle);
    }
}

/** An active queue row owns implementation only after it has entered task mode. */
export function findOtherActiveImplementationOwners(
    repoRoot: string,
    taskId: string,
    entries: ReadonlyMap<string, TaskQueueEntry> = readTaskQueueEntries(repoRoot)
): string[] {
    const owners: string[] = [];
    for (const entry of entries.values()) {
        if (entry.taskId === taskId || !isTaskQueueActiveStatus(entry.status)) {
            continue;
        }
        const taskMode = readImplementationTaskMode(repoRoot, entry.taskId);
        if (
            taskMode.evidence_status === 'EVIDENCE_FILE_MISSING'
            && !taskMode.timeline_artifact_path
            && (!taskMode.evidence_path || !fs.existsSync(taskMode.evidence_path))
        ) {
            // Queue-only rows have no implementation claim (for example, a waiting parent).
            continue;
        }
        if (taskMode.evidence_status === 'PASS') {
            const noOp = getNoOpEvidence(repoRoot, entry.taskId);
            if (getCurrentNoOpEventSha256(repoRoot, entry.taskId, noOp)) {
                continue;
            }
        }
        owners.push(entry.taskId);
    }
    return owners.sort();
}

export function assertSingleActiveImplementationOwner(
    repoRoot: string,
    taskId: string,
    gate: 'task-mode entry' | 'compile gate',
    entries?: ReadonlyMap<string, TaskQueueEntry>
): void {
    const owners = findUnapprovedActiveImplementationOwners(repoRoot, taskId, entries);
    if (owners.length > 0) {
        throw new Error(
            `${gate} refused for ${taskId}: ` + activeTaskConfirmationMessage(taskId, owners)
        );
    }
}
