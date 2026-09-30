import * as path from 'node:path';
import {
    assertContainedDestination, bindContainedDestination, ensureContainedDirectory, writeContainedFile
} from './contained-filesystem';
import { resolvePathInsideRepo } from './orchestrator-paths';
import { TASK_QUEUE_FILENAME } from './orchestration-constants';
import { assertCanonicalTaskId } from './task-ids';
import { parseTaskQueueEntriesFromContent } from './task-queue-read';
import { readTaskQueueStatusToken } from './task-queue/task-queue-status';
import {
    readBoundedTaskPlanFile, resolveCanonicalTaskPlanPath, TASK_PLAN_READ_MAX_BYTES
} from './task-plan-read';
import { withFilesystemLock } from '../gate-runtime/timeline/task-events-locking';
import { serializeTaskPlan, validateTaskPlan } from '../schemas/task-plan';

const TASK_QUEUE_MAX_BYTES = 4 * TASK_PLAN_READ_MAX_BYTES;
const TASK_PLAN_LOCK_TIMEOUT_MS = 5000;

/** Task entry and plan publication share this task-local synchronization boundary. */
export function withTaskPlanMutationLock<T>(repoRoot: string, taskId: string, action: () => T): T {
    assertCanonicalTaskId(taskId);
    const reviewsRoot = path.dirname(resolveCanonicalTaskPlanPath(repoRoot, taskId));
    ensureContainedDirectory(repoRoot, reviewsRoot);
    const parent = bindContainedDestination(repoRoot, reviewsRoot);
    const lockPath = path.join(reviewsRoot, `${taskId}-task-plan.lock`);
    bindContainedDestination(repoRoot, lockPath);
    return withFilesystemLock(lockPath, {
        timeoutMs: TASK_PLAN_LOCK_TIMEOUT_MS, requireKnownDeadOwner: true, ownerLabel: 'task-plan-save-entry'
    }, () => {
        assertContainedDestination(parent);
        return action();
    }).result;
}

function assertTaskNeverStarted(repoRoot: string, taskId: string, planPath: string): void {
    const queue = readBoundedTaskPlanFile(repoRoot, path.join(repoRoot, TASK_QUEUE_FILENAME), TASK_QUEUE_MAX_BYTES);
    const entry = queue === null ? undefined : parseTaskQueueEntriesFromContent(queue).get(taskId);
    if (!entry || readTaskQueueStatusToken(entry.status) !== 'TODO') {
        throw new Error(`Plan saving requires an existing TODO task in the active queue: ${taskId}.`);
    }
    const reviewsRoot = path.dirname(planPath);
    for (const suffix of ['task-mode.json', 'preflight.json', 'completion-gate.json']) {
        const evidence = readBoundedTaskPlanFile(repoRoot, path.join(reviewsRoot, `${taskId}-${suffix}`), TASK_PLAN_READ_MAX_BYTES);
        if (evidence !== null) {
            throw new Error(`Task ${taskId} has start evidence; its plan cannot be replaced.`);
        }
    }
    const timelinePath = path.join(path.dirname(reviewsRoot), 'task-events', `${taskId}.jsonl`);
    const timeline = readBoundedTaskPlanFile(repoRoot, timelinePath, TASK_PLAN_READ_MAX_BYTES);
    // Even an empty retained timeline cannot certify never-started: it may be truncated history.
    if (timeline !== null) {
        throw new Error(`Task ${taskId} has lifecycle history or unknown start evidence; its plan cannot be replaced.`);
    }
}

export function saveTaskPlan(repoRoot: string, taskId: string, inputPath: string): string {
    const id = assertCanonicalTaskId(taskId);
    const input = resolvePathInsideRepo(inputPath, repoRoot, { enforceInside: true });
    if (!input) throw new Error('Task plan save requires an input file.');
    const content = readBoundedTaskPlanFile(repoRoot, input, TASK_PLAN_READ_MAX_BYTES);
    if (content === null) throw new Error(`Task plan input was not found: ${inputPath}.`);
    const plan = validateTaskPlan(JSON.parse(content));
    if (plan.task_id !== id) throw new Error(`Plan task_id '${plan.task_id}' does not match '${id}'.`);
    if (plan.status === 'approved') {
        for (const field of ['acceptance_criteria', 'verification_expectations', 'out_of_scope'] as const) {
            if (!plan[field]?.length) throw new Error(`Ready plans require nonempty ${field}.`);
        }
    }
    const serialized = serializeTaskPlan(plan);
    if (Buffer.byteLength(serialized, 'utf8') > TASK_PLAN_READ_MAX_BYTES) {
        throw new Error('Serialized task plan exceeds the plan read limit.');
    }
    return withTaskPlanMutationLock(repoRoot, id, () => {
        const planPath = resolveCanonicalTaskPlanPath(repoRoot, id);
        assertTaskNeverStarted(repoRoot, id, planPath);
        writeContainedFile(repoRoot, planPath, serialized);
        return planPath;
    });
}
