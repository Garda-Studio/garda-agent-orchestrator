import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../constants';
import { readTaskQueueEntries } from '../task-queue-read';
import { isTaskQueueDoneStatus } from '../task-queue/active-task-state';
import { cleanupCompactTasks } from './store';
import { cleanupAuthorizedValidationOutput } from '../validation-output-retention';

export async function cleanupCompactAtTaskBoundary(
    repoRoot: string,
    completingTaskId?: string,
    options: { validationOutput?: boolean } = {}
): Promise<string[]> {
    const notes: string[] = [];
    const doneTasks = (): Set<string> => new Set(
        [...readTaskQueueEntries(repoRoot).values()].filter(task => isTaskQueueDoneStatus(task.status)
            && !fs.existsSync(path.join(repoRoot, resolveBundleName(), 'runtime/reviews', `${task.taskId}-completion-gate.lock`)))
            .map(task => task.taskId)
    );
    try {
        if (options.validationOutput !== false) {
            notes.push(...cleanupAuthorizedValidationOutput(repoRoot));
            for (const note of notes) console.warn(note);
        }
    } catch (error) {
        notes.push(`Validation output housekeeping pending: ${error instanceof Error ? error.message.slice(0, 200) : 'cleanup failed'}`);
    }
    if (!fs.existsSync(path.join(repoRoot, resolveBundleName(), 'runtime/compact'))) return notes;
    if (completingTaskId) {
        await cleanupCompactTasks(repoRoot, new Set([completingTaskId]));
    }
    try {
        await cleanupCompactTasks(repoRoot, doneTasks);
        return notes;
    } catch (error) {
        return [...notes, `Compact housekeeping pending: ${error instanceof Error ? error.message.slice(0, 200) : 'cleanup failed'}`];
    }
}
