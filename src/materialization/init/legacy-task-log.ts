import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { removeContainedPath } from '../../core/contained-filesystem';

export const LEGACY_TASK_LOG_RELATIVE_PATH = path.join('docs', 'tasks', 'TASKS.md');

// SHA-256 (LF-normalized) of every Garda task-log template shipped as live/docs/tasks/TASKS.md before 1.4.4.
const LEGACY_TASK_LOG_SHA256 = new Set([
    'cf1490d30e3bb318eb425e0405d2e214af14651f9c91f71e02ded47f5019a415',
    'f3d7b7b4c2f23d91ff82790b1cc4aecd8e22dea9bd3b303b268bbb9b7e86d8f5'
]);

/** Removes Garda's own legacy task log from a live tree only while it is byte-identical to a shipped copy. */
export function removeLegacyTaskLog(targetRoot: string, liveRoot: string): boolean {
    const taskLogPath = path.join(liveRoot, LEGACY_TASK_LOG_RELATIVE_PATH);
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(taskLogPath);
    } catch {
        return false;
    }
    if (!stat.isFile()) return false;
    const normalized = fs.readFileSync(taskLogPath, 'utf8').replace(/\r\n/g, '\n');
    if (!LEGACY_TASK_LOG_SHA256.has(createHash('sha256').update(normalized).digest('hex'))) return false;
    try {
        removeContainedPath(targetRoot, taskLogPath, false);
    } catch {
        // A linked or uncontained path is left for the operator; removing this copy is optional cleanup.
        return false;
    }
    const taskLogDirectory = path.dirname(taskLogPath);
    if (fs.readdirSync(taskLogDirectory).length === 0) removeContainedPath(targetRoot, taskLogDirectory, true);
    return true;
}
