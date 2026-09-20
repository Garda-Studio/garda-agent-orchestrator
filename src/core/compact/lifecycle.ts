import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../constants';
import { readTaskQueueEntries } from '../task-queue-read';
import { isTaskQueueDoneStatus } from '../task-queue/active-task-state';
import { cleanupCompactTasks } from './store';

export async function cleanupCompactAtTaskBoundary(repoRoot: string, completingTaskId?: string): Promise<string[]> {
    if (!fs.existsSync(path.join(repoRoot, resolveBundleName(), 'runtime/compact'))) return [];
    if (completingTaskId) {
        await cleanupCompactTasks(repoRoot, new Set([completingTaskId]));
    }
    try {
        await cleanupCompactTasks(repoRoot, () => new Set(
            [...readTaskQueueEntries(repoRoot).values()].filter(task => isTaskQueueDoneStatus(task.status)
                && !fs.existsSync(path.join(repoRoot, resolveBundleName(), 'runtime/reviews', `${task.taskId}-completion-gate.lock`)))
                .map(task => task.taskId)
        ));
        return [];
    } catch (error) {
        return [`Compact housekeeping pending: ${error instanceof Error ? error.message.slice(0, 200) : 'cleanup failed'}`];
    }
}
