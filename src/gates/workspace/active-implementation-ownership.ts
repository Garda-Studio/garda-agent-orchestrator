import * as fs from 'node:fs';
import * as path from 'node:path';

import { isTaskQueueActiveStatus } from '../../core/active-task-state';
import { readTaskQueueEntries, type TaskQueueEntry } from '../../core/task-queue-read';
import { acquireFilesystemLock, releaseFilesystemLock } from '../../gate-runtime/task-events-locking';
import { isPathRealpathInsideRoot, joinOrchestratorPath } from '../shared/helpers';
import { getNoOpEvidence, getCurrentNoOpEventSha256 } from '../task-mode/no-op';
import { getTaskModeEvidence } from '../task-mode/task-mode';

export function withImplementationOwnershipLock<T>(repoRoot: string, operation: () => T): T {
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
        return operation();
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
        const taskMode = getTaskModeEvidence(repoRoot, entry.taskId);
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
    const owners = findOtherActiveImplementationOwners(repoRoot, taskId, entries);
    if (owners.length > 0) {
        throw new Error(
            `${gate} refused for ${taskId}: active implementation owner in this worktree: ` +
            `${owners.join(', ')}. Complete or suspend the owning task before starting another code-changing task.`
        );
    }
}
