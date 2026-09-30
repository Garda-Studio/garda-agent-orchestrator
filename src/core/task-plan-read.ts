import * as fs from 'node:fs';
import * as path from 'node:path';

import { joinOrchestratorPath, resolvePathInsideRepo } from './orchestrator-paths';
import { TASK_QUEUE_FILENAME } from './orchestration-constants';
import { assertCanonicalTaskId } from './task-ids';
import { parseTaskQueueEntriesFromContent } from './task-queue-read';
import { readTaskQueueStatusToken } from './task-queue/task-queue-status';
import { computeTaskPlanDigest, validateTaskPlan } from '../schemas/task-plan';

export const TASK_PLAN_READ_MAX_BYTES = 1024 * 1024;
const TASK_QUEUE_READ_MAX_BYTES = 4 * TASK_PLAN_READ_MAX_BYTES;

export interface TaskPlanReadResult {
    task_id: string;
    path: string;
    state: 'missing' | 'ready' | 'draft' | 'invalid';
    content: string | null;
    diagnostics: string[];
}

/** Resolve the existing JSON convention; Markdown working plans are separate. */
export function resolveCanonicalTaskPlanPath(repoRoot: string, taskId: string): string {
    const id = assertCanonicalTaskId(taskId);
    const candidate = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${id}-task-plan.json`));
    return resolvePathInsideRepo(candidate, repoRoot, { allowMissing: true, enforceInside: true })!;
}

export function readBoundedTaskPlanFile(repoRoot: string, file: string, maxBytes: number): string | null {
    resolvePathInsideRepo(file, repoRoot, { allowMissing: true, enforceInside: true });
    let before: fs.Stats;
    try {
        before = fs.lstatSync(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new Error('Plan inspection requires an unshared regular file without links.');
    }
    if (before.size > maxBytes) throw new Error(`Inspection file exceeds the ${maxBytes}-byte limit.`);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new Error('Inspection file identity changed before reading.');
        }
        const buffer = Buffer.alloc(maxBytes + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
            const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
            if (count === 0) break;
            bytes += count;
        }
        if (bytes > maxBytes) throw new Error(`Inspection file exceeds the ${maxBytes}-byte limit.`);
        resolvePathInsideRepo(file, repoRoot, { enforceInside: true });
        const after = fs.lstatSync(file);
        const finished = fs.fstatSync(fd);
        if (after.isSymbolicLink() || after.nlink !== 1 || finished.nlink !== 1
            || after.dev !== opened.dev || after.ino !== opened.ino
            || finished.size !== opened.size || finished.mtimeMs !== opened.mtimeMs) {
            throw new Error('Inspection file changed during reading.');
        }
        return buffer.subarray(0, bytes).toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

export function readTaskPlan(repoRoot: string, taskId: string): TaskPlanReadResult {
    const planPath = resolveCanonicalTaskPlanPath(repoRoot, taskId);
    const result: TaskPlanReadResult = {
        task_id: taskId,
        path: path.relative(path.resolve(repoRoot), planPath).replace(/\\/g, '/'),
        state: 'missing',
        content: null,
        diagnostics: []
    };
    try {
        result.content = readBoundedTaskPlanFile(repoRoot, planPath, TASK_PLAN_READ_MAX_BYTES);
        if (result.content === null) return result;
        const plan = validateTaskPlan(JSON.parse(result.content));
        if (plan.task_id !== taskId) throw new Error(`Plan task_id '${plan.task_id}' does not match '${taskId}'.`);
        if (plan.plan_sha256 && plan.plan_sha256 !== computeTaskPlanDigest(plan)) {
            throw new Error('Plan content digest does not match plan_sha256.');
        }
        if (plan.status === 'superseded') throw new Error('The plan is superseded.');
        result.state = plan.status === 'approved' ? 'ready' : 'draft';
    } catch (error) {
        result.state = 'invalid';
        const diagnostic = error instanceof Error ? error.message : String(error);
        result.diagnostics.push(diagnostic.length > 240 ? `${diagnostic.slice(0, 237)}...` : diagnostic);
    }
    return result;
}

export function listTaskPlans(repoRoot: string, missingOnly = false): Omit<TaskPlanReadResult, 'content'>[] {
    const queueFile = path.resolve(repoRoot, TASK_QUEUE_FILENAME);
    const content = readBoundedTaskPlanFile(repoRoot, queueFile, TASK_QUEUE_READ_MAX_BYTES);
    if (content === null) throw new Error(`${TASK_QUEUE_FILENAME} was not found.`);
    const results: Omit<TaskPlanReadResult, 'content'>[] = [];
    for (const entry of parseTaskQueueEntriesFromContent(content).values()) {
        if (readTaskQueueStatusToken(entry.status) !== 'TODO' || !/^\[plan\](?:\s|$)/u.test(entry.notes || '')) continue;
        const { content: _content, ...result } = readTaskPlan(repoRoot, entry.taskId);
        if (!missingOnly || result.state === 'missing') results.push(result);
    }
    return results;
}
