import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveBundleNameForTarget } from '../../core/constants';
import { readBoundedTaskPlanFile, readTaskPlan, TASK_PLAN_READ_MAX_BYTES } from '../../core/task-plan-read';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { fileSha256, joinOrchestratorPath, normalizePath, resolvePathInsideRepo } from '../shared/helpers';
import { computeTaskPlanDigest, isApprovedPlan, validateTaskPlan } from '../../schemas/task-plan';
import type { TaskModeMarkdownWorkingPlanMetadata, TaskModePlanMetadata } from './task-mode-contracts';

function buildApprovedPlanMetadata(content: string, planPath: string, taskId: string): TaskModePlanMetadata {
    const validated = validateTaskPlan(JSON.parse(content));
    if (validated.task_id !== taskId) {
        throw new Error(`Plan task_id '${validated.task_id}' does not match --task-id '${taskId}'.`);
    }
    if (!isApprovedPlan(validated)) {
        throw new Error(`Plan status is '${validated.status}'; only approved plans can be attached at task-mode entry.`);
    }
    const digest = computeTaskPlanDigest(validated);
    if (validated.plan_sha256 && validated.plan_sha256 !== digest) {
        throw new Error(`Plan plan_sha256 mismatch: embedded '${validated.plan_sha256}' vs computed '${digest}'.`);
    }
    return { plan_path: normalizePath(planPath), plan_sha256: digest, plan_summary: validated.goal };
}

/** Called inside the shared save/entry lock, after existing entry evidence is validated. */
export function selectTaskModePlan(
    repoRoot: string,
    taskId: string,
    explicitPath: string,
    previousPlan?: TaskModePlanMetadata | null
): { plan: TaskModePlanMetadata | null; diagnostic: string } {
    if (previousPlan === null) {
        if (explicitPath) throw new Error('An existing freeform task entry cannot attach a new plan after start.');
        return { plan: null, diagnostic: 'PreparedPlan: missing (existing freeform entry preserved)' };
    }
    const selectedPath = explicitPath || previousPlan?.plan_path;
    if (selectedPath) {
        const resolved = resolvePathInsideRepo(selectedPath, repoRoot, { allowMissing: false });
        if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
            throw new Error(`PlanPath not found or not a file: '${selectedPath}'.`);
        }
        if (previousPlan && normalizePath(resolved) !== normalizePath(path.resolve(repoRoot, previousPlan.plan_path))) {
            throw new Error('The attached plan path cannot change after task start.');
        }
        const canonicalPath = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-task-plan.json`));
        const content = normalizePath(resolved) === normalizePath(canonicalPath)
            ? readBoundedTaskPlanFile(repoRoot, resolved, TASK_PLAN_READ_MAX_BYTES)
            : fs.readFileSync(resolved, 'utf8');
        if (content === null) throw new Error(`PlanPath not found: '${selectedPath}'.`);
        const plan = buildApprovedPlanMetadata(content, resolved, taskId);
        if (previousPlan && plan.plan_sha256 !== previousPlan.plan_sha256) {
            throw new Error('Plan integrity mismatch: the attached plan changed after task start.');
        }
        return { plan, diagnostic: `PreparedPlan: attached (${previousPlan ? 'existing' : 'explicit'})` };
    }
    const prepared = readTaskPlan(repoRoot, taskId);
    if (prepared.state === 'invalid') {
        throw new Error(`Canonical prepared plan is invalid: ${prepared.diagnostics.join(' ')}`);
    }
    if (prepared.state === 'missing' || prepared.state === 'draft') {
        return { plan: null, diagnostic: `PreparedPlan: ${prepared.state} (optional; freeform execution)` };
    }
    return {
        plan: buildApprovedPlanMetadata(prepared.content!, path.resolve(repoRoot, prepared.path), taskId),
        diagnostic: 'PreparedPlan: attached (canonical)'
    };
}

function getMarkdownWorkingPlanPathCandidates(repoRoot: string, taskId: string): string[] {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const safeTaskId = assertValidTaskId(taskId);
    const fileName = `${safeTaskId}.md`;
    const candidates = [
        path.resolve(normalizedRepoRoot, resolveBundleNameForTarget(normalizedRepoRoot), 'runtime', 'plans', fileName),
        joinOrchestratorPath(normalizedRepoRoot, path.join('runtime', 'plans', fileName))
    ];
    return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

export function resolveMarkdownWorkingPlanPath(repoRoot: string, taskId: string): string {
    const [firstCandidate] = getMarkdownWorkingPlanPathCandidates(repoRoot, taskId);
    if (!firstCandidate) {
        throw new Error('Unable to resolve Markdown working-plan path.');
    }
    return firstCandidate;
}

export function readOptionalMarkdownWorkingPlan(
    repoRoot: string,
    taskId: string
): TaskModeMarkdownWorkingPlanMetadata | null {
    const normalizedRepoRoot = path.resolve(repoRoot);
    for (const candidatePath of getMarkdownWorkingPlanPathCandidates(normalizedRepoRoot, taskId)) {
        if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
            continue;
        }
        const workingPlanSha256 = fileSha256(candidatePath);
        if (!workingPlanSha256) {
            continue;
        }
        const relativePath = path.relative(normalizedRepoRoot, candidatePath);
        return {
            format: 'markdown',
            working_plan_path: normalizePath(
                relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
                    ? relativePath
                    : candidatePath
            ),
            working_plan_sha256: workingPlanSha256,
            byte_count: fs.statSync(candidatePath).size
        };
    }
    return null;
}
