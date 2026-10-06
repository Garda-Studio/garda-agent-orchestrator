import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readBoundedTaskPlanFile, TASK_PLAN_READ_MAX_BYTES } from '../../core/task-plan-read';
import { computeTaskPlanDigest, validateTaskPlan } from '../../schemas/task-plan';
import { joinOrchestratorPath, normalizePath, resolvePathInsideRepo } from '../shared/helpers';
import type { TaskModeArtifact } from '../task-mode/task-mode-contracts';

export interface TaskPlanDiagnostics {
    state: 'attached_json' | 'markdown_guidance' | 'none' | 'invalid';
    path: string;
    editable: false;
    evidence: 'current' | 'not_attached' | 'entry_invalid' | 'attachment_missing' | 'attachment_changed' | 'attachment_invalid';
    read_before_implementation: string;
}

type EntryPlanMetadata = Pick<TaskModeArtifact, 'plan' | 'markdown_working_plan'>;

function displayPath(repoRoot: string, file: string): string {
    return normalizePath(path.relative(path.resolve(repoRoot), file))
        .replace(/[\u0000-\u001f\u007f]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function inspectAttachment(repoRoot: string, taskId: string, entry: EntryPlanMetadata): TaskPlanDiagnostics['evidence'] {
    const metadata = entry.plan || entry.markdown_working_plan;
    if (!metadata) return 'not_attached';
    const file = 'plan_path' in metadata ? metadata.plan_path : metadata.working_plan_path;
    try {
        const resolved = resolvePathInsideRepo(file, repoRoot, { allowMissing: true, enforceInside: true })!;
        const content = readBoundedTaskPlanFile(repoRoot, resolved, TASK_PLAN_READ_MAX_BYTES);
        if (content === null) return 'attachment_missing';
        if (!entry.plan) {
            return createHash('sha256').update(content, 'utf8').digest('hex') === entry.markdown_working_plan!.working_plan_sha256
                ? 'current' : 'attachment_changed';
        }
        const plan = validateTaskPlan(JSON.parse(content));
        if (plan.task_id !== taskId || plan.status !== 'approved') return 'attachment_invalid';
        const digest = computeTaskPlanDigest(plan);
        if (plan.plan_sha256 && plan.plan_sha256 !== digest) return 'attachment_invalid';
        return digest === entry.plan.plan_sha256 ? 'current' : 'attachment_changed';
    } catch {
        return 'attachment_invalid';
    }
}

/** Read only the entry attachment; never discover or attach a second plan after start. */
export function buildTaskPlanDiagnostics(
    repoRoot: string,
    taskId: string,
    entry: EntryPlanMetadata,
    evidenceStatus = 'PASS'
): TaskPlanDiagnostics {
    const canonical = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-task-plan.json`));
    let file = canonical;
    let evidence: TaskPlanDiagnostics['evidence'] = evidenceStatus === 'PASS' ? 'not_attached' : 'entry_invalid';
    if (evidenceStatus === 'PASS' && (entry.plan || entry.markdown_working_plan)) {
        try {
            file = resolvePathInsideRepo(entry.plan?.plan_path || entry.markdown_working_plan!.working_plan_path,
                repoRoot, { allowMissing: true, enforceInside: true })!;
            evidence = inspectAttachment(repoRoot, taskId, entry);
        } catch {
            evidence = 'attachment_invalid';
        }
    }
    const state = evidence === 'current' ? (entry.plan ? 'attached_json' : 'markdown_guidance')
        : evidence === 'not_attached' ? 'none' : 'invalid';
    const planPath = displayPath(repoRoot, file);
    const hint = state === 'attached_json' ? `Read '${planPath}' before implementation.`
        : state === 'markdown_guidance' ? `Read optional Markdown guidance '${planPath}' before implementation.`
        : state === 'none' ? 'No plan attached; follow TASK.md before implementation.'
        : 'Inspect invalid attachment evidence before implementation; this diagnostic adds no readiness gate.';
    return { state, path: planPath, editable: false, evidence, read_before_implementation: hint };
}

export function formatTaskPlanDiagnostics(diagnostic: TaskPlanDiagnostics): string[] {
    return [
        `TaskPlanState: ${diagnostic.state}`,
        `TaskPlanPath: ${diagnostic.path}`,
        `TaskPlanEditable: ${diagnostic.editable}`,
        `TaskPlanEvidence: ${diagnostic.evidence}`,
        `ReadPlanHint: ${diagnostic.read_before_implementation}`
    ];
}
