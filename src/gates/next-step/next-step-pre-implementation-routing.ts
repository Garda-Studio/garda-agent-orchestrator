import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';

import {
    computeTaskPlanDigest,
    validateTaskPlan
} from '../../schemas/task-plan';
import { isPlainRecord } from '../../core/records';
import {
    normalizePath,
    isPathRealpathInsideRoot,
    resolvePathInsideRepo,
    testPathPrefix
} from '../shared/helpers';
import {
    getClassificationConfig
} from '../preflight/classify-change';
import {
    formatNextStepInlineList
} from './next-step-command-formatters';
import {
    buildOrchestratorWorkRestartCommand,
    getStringField,
    getTaskModePlannedChangedFiles
} from './next-step-lifecycle-command-builders';
import {
    resolveAuthenticatedGroupedReviewFollowUpScope
} from './next-step-review-artifact-readers';
import type {
    TaskQueueEntry
} from './next-step-task-queue';

const GIT_CHECK_IGNORE_TIMEOUT_MS = 5000;

interface StructuredPlannedScope {
    files: string[];
    diagnostics: string[];
}

export interface NextStepPreImplementationRoute {
    nextGate: 'implementation' | 'materialize-planned-scope' | 'enter-task-mode' | 'follow-up-scope-evidence';
    title: string;
    reason: string;
    commands: Array<{ label: string; command: string }>;
}

export interface BaselineOnlyPreImplementationRouteOptions {
    repoRoot: string;
    cliPrefix: string;
    taskEntry: TaskQueueEntry | null;
    taskMode: Record<string, unknown> | null;
    preflight: Record<string, unknown> | null;
    auditedNoOpPassed: boolean;
}

function preflightRequiresAuditedNoOp(preflight: Record<string, unknown> | null): boolean {
    if (!preflight || !isPlainRecord(preflight.zero_diff_guard)) {
        return false;
    }
    const zeroDiffGuard = preflight.zero_diff_guard;
    return zeroDiffGuard.zero_diff_detected === true
        && zeroDiffGuard.completion_requires_audited_no_op === true;
}

function normalizePlannedFiles(values: readonly unknown[]): string[] {
    return [...new Set(values.map((entry) => normalizePath(String(entry || '').trim())).filter(Boolean))].sort();
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        const payload = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        return isPlainRecord(payload) ? payload : null;
    } catch {
        return null;
    }
}

function emptyStructuredPlannedScope(): StructuredPlannedScope {
    return {
        files: [],
        diagnostics: []
    };
}

function ignoredTaskPlanScope(reason: string): StructuredPlannedScope {
    return {
        files: [],
        diagnostics: [`Attached task plan ignored: ${reason}`]
    };
}

function resolveAuthorizedTaskPlanPath(repoRoot: string, rawPlanPath: string): string | null {
    let planPath: string | null = null;
    try {
        planPath = resolvePathInsideRepo(rawPlanPath, repoRoot, { allowMissing: false, enforceInside: true });
    } catch {
        return null;
    }
    if (!planPath || !isPathRealpathInsideRoot(planPath, repoRoot)) {
        return null;
    }
    try {
        return fs.statSync(planPath).isFile() ? planPath : null;
    } catch {
        return null;
    }
}

function readTaskPlanScopeFiles(
    repoRoot: string,
    taskId: string | null,
    taskMode: Record<string, unknown> | null
): StructuredPlannedScope {
    const plan = isPlainRecord(taskMode?.plan) ? taskMode.plan : null;
    const rawPlanPath = String(plan?.plan_path || '').trim();
    if (!rawPlanPath) {
        return emptyStructuredPlannedScope();
    }
    const expectedSha256 = String(plan?.plan_sha256 || '').trim().toLowerCase();
    if (!expectedSha256) {
        return ignoredTaskPlanScope('task-mode plan_sha256 is missing.');
    }
    if (!taskId) {
        return ignoredTaskPlanScope('active task id is unavailable.');
    }
    const planPath = resolveAuthorizedTaskPlanPath(repoRoot, rawPlanPath);
    if (!planPath) {
        return ignoredTaskPlanScope('plan path is missing, not a regular file, or escapes the repository root after realpath resolution.');
    }
    const payload = readJsonRecord(planPath);
    if (!payload) {
        return ignoredTaskPlanScope('plan file is not a valid JSON object.');
    }
    let validatedPlan: ReturnType<typeof validateTaskPlan>;
    try {
        validatedPlan = validateTaskPlan(payload);
    } catch {
        return ignoredTaskPlanScope('plan file does not match the task-plan schema.');
    }
    const actualSha256 = computeTaskPlanDigest(validatedPlan);
    const embeddedSha256 = String(validatedPlan.plan_sha256 || '').trim().toLowerCase();
    if (validatedPlan.task_id !== taskId) {
        return ignoredTaskPlanScope(`plan task_id '${validatedPlan.task_id}' does not match active task '${taskId}'.`);
    }
    if (validatedPlan.status !== 'approved') {
        return ignoredTaskPlanScope(`plan status is '${validatedPlan.status}', not approved.`);
    }
    if (embeddedSha256 && embeddedSha256 !== actualSha256) {
        return ignoredTaskPlanScope('embedded plan_sha256 does not match the computed plan digest.');
    }
    if (expectedSha256 !== actualSha256) {
        return ignoredTaskPlanScope('task-mode plan_sha256 does not match the computed plan digest.');
    }
    return {
        files: normalizePlannedFiles(validatedPlan.scope_files),
        diagnostics: []
    };
}

function getStructuredPlannedScope(
    repoRoot: string,
    taskId: string | null,
    taskMode: Record<string, unknown> | null
): StructuredPlannedScope {
    // Markdown working plans are free-form executor guidance, not gate-owned scope authority.
    const taskPlanScope = readTaskPlanScopeFiles(repoRoot, taskId, taskMode);
    return {
        files: normalizePlannedFiles([
            ...getTaskModePlannedChangedFiles(taskMode),
            ...taskPlanScope.files
        ]),
        diagnostics: taskPlanScope.diagnostics
    };
}

function getIgnoredPlannedFiles(repoRoot: string, plannedFiles: readonly string[]): string[] {
    const candidates = normalizePlannedFiles(plannedFiles);
    if (candidates.length === 0) {
        return [];
    }
    try {
        const result = childProcess.spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
            cwd: repoRoot,
            input: `${candidates.join('\n')}\n`,
            encoding: 'utf8',
            timeout: GIT_CHECK_IGNORE_TIMEOUT_MS,
            windowsHide: true
        });
        if (result.status !== 0 || !result.stdout) {
            return [];
        }
        return normalizePlannedFiles(result.stdout.split(/\r?\n/u));
    } catch {
        return [];
    }
}

const EXPLICIT_NO_OP_AREA_PATTERN = /^(?:audit-only|no-op|noop)$/u;
const EXPLICIT_NO_OP_SUMMARY_OR_TITLE_PATTERN = /^(?:(?:audit[- ]?only|no[- ]?op)(?:\s+task\b|\s*:)|(?:close(?: out)?\s+)?already done\b|closeout only\b|docs only\b|no (?:code )?changes? required\b|no implementation required\b)/u;
const EXPLICIT_NO_OP_NOTES_PATTERN = /^(?:audit[- ]?only|no[- ]?op)\s+task(?:\s*[.:;]|$)|\breviewed\s+\d{4}-\d{2}-\d{2}\s*:\s*(?:audit[- ]?only|no[- ]?op)\b/u;

function taskMetadataExplicitlyAllowsNoOp(
    taskEntry: TaskQueueEntry | null,
    taskMode: Record<string, unknown> | null
): boolean {
    const summaryAndTitleParts = [
        getStringField(taskMode, 'task_summary', ''),
        taskEntry?.title || ''
    ].map((value) => value.trim().toLowerCase());
    const area = String(taskEntry?.area || '').trim().toLowerCase();
    const areaLeaf = area.split('/').filter(Boolean).at(-1) || '';
    const notes = String(taskEntry?.notes || '').trim().toLowerCase();
    return EXPLICIT_NO_OP_AREA_PATTERN.test(areaLeaf)
        || summaryAndTitleParts.some((value) => EXPLICIT_NO_OP_SUMMARY_OR_TITLE_PATTERN.test(value))
        || EXPLICIT_NO_OP_NOTES_PATTERN.test(notes);
}

function taskIntentLooksCodeChanging(taskEntry: TaskQueueEntry | null, taskMode: Record<string, unknown> | null): boolean {
    if (taskMetadataExplicitlyAllowsNoOp(taskEntry, taskMode)) {
        return false;
    }
    const text = [
        getStringField(taskMode, 'task_summary', ''),
        taskEntry?.area || '',
        taskEntry?.title || '',
        taskEntry?.notes || ''
    ].join(' ').toLowerCase();
    if (!text.trim()) {
        return false;
    }
    const hasImplementationAction = /\b(?:add|adjust|avoid|change|close|compare|complete|correct|cover|create|delete|distinguish|enforce|ensure|extract|fix|harden|implement|make|migrate|modify|move|narrow|prevent|refactor|remove|rename|replace|revise|route|split|support|surface|teach|unify|update|validate|warn)\b/u.test(text);
    const hasImplementationSurface = /\b(?:code[- ]?changing|implementation|source|runtime|workflow|navigator|next-step|preflight|compile|gate|scope|diagnostic|test(?:s|ing)?|handler|contract|project[- ]memory|memory map)\b/u.test(text);
    if (hasImplementationAction && hasImplementationSurface) {
        return true;
    }
    return Boolean(taskEntry?.taskId);
}

export function buildBaselineOnlyPreImplementationRoute(
    params: BaselineOnlyPreImplementationRouteOptions
): NextStepPreImplementationRoute | null {
    const followUpScope = resolveAuthenticatedGroupedReviewFollowUpScope(params.repoRoot, params.taskEntry);
    if (followUpScope.status === 'invalid') {
        return {
            nextGate: 'follow-up-scope-evidence',
            title: 'Restore authenticated review follow-up scope before implementation.',
            reason:
                'The current task is a grouped review follow-up, but its authenticated lane artifacts cannot provide a safe planned scope. ' +
                `${followUpScope.diagnostics.join(' ')} Refuse implementation until the task-owned follow-up evidence is restored.`,
            commands: []
        };
    }
    const activeTaskId = params.taskEntry?.taskId || getStringField(params.taskMode, 'task_id', '');
    const structuredPlannedScope = getStructuredPlannedScope(params.repoRoot, activeTaskId || null, params.taskMode);
    const structuredPlannedFiles = normalizePlannedFiles([
        ...structuredPlannedScope.files,
        ...followUpScope.files
    ]);
    if (followUpScope.status === 'valid' && params.taskMode?.orchestrator_work !== true) {
        let protectedFiles: string[] = [];
        try {
            const classificationConfig = getClassificationConfig(params.repoRoot);
            protectedFiles = structuredPlannedFiles.filter((file) => (
                testPathPrefix(file, classificationConfig.protected_control_plane_roots)
            ));
        } catch (error) {
            return {
                nextGate: 'follow-up-scope-evidence',
                title: 'Resolve protected follow-up scope before implementation.',
                reason:
                    'Authenticated review follow-up scope exists, but protected-path classification failed closed: ' +
                    `${error instanceof Error ? error.message : String(error)}`,
                commands: []
            };
        }
        if (protectedFiles.length > 0) {
            return {
                nextGate: 'enter-task-mode',
                title: 'Upgrade task mode for authenticated protected follow-up scope.',
                reason:
                    'The current BASELINE_ONLY task is bound to accepted review findings that reference protected orchestrator files, ' +
                    `but task mode lacks --orchestrator-work. Protected scope: ${formatNextStepInlineList(protectedFiles)}. ` +
                    'Restart task mode with operator confirmation and the authenticated follow-up evidence files before implementation.',
                commands: [{
                    label: 'Upgrade task mode for protected follow-up scope',
                    command: buildOrchestratorWorkRestartCommand(
                        params.repoRoot,
                        params.cliPrefix,
                        activeTaskId,
                        params.taskMode,
                        structuredPlannedFiles
                    )
                }]
            };
        }
    }
    if (params.auditedNoOpPassed || !preflightRequiresAuditedNoOp(params.preflight)) {
        return null;
    }
    const changedFiles = Array.isArray(params.preflight?.changed_files)
        ? params.preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    if (changedFiles.length > 0) {
        return null;
    }
    const codeChangingIntent = taskIntentLooksCodeChanging(params.taskEntry, params.taskMode);
    if (structuredPlannedFiles.length === 0 && !codeChangingIntent && structuredPlannedScope.diagnostics.length === 0) {
        return null;
    }
    const ignoredPlannedFiles = getIgnoredPlannedFiles(params.repoRoot, structuredPlannedFiles);
    const plannedFilesNote = structuredPlannedFiles.length > 0
        ? ` Structured planned files: ${formatNextStepInlineList(structuredPlannedFiles)}.`
        : structuredPlannedScope.diagnostics.length > 0
            ? ' No authorized structured planned files are available; next-step must wait for a real diff or explicit no-op instead of compiling baseline-only evidence.'
            : ' No structured planned files are recorded; task text indicates an implementation task, so next-step must wait for a real diff or explicit no-op instead of compiling baseline-only evidence.';
    const ignoredFilesNote = ignoredPlannedFiles.length > 0
        ? ` Planned files ignored by git scope: ${formatNextStepInlineList(ignoredPlannedFiles)}. Keep the path explicit in classify-change or task-mode scope; git-auto will not discover ignored files.`
        : '';
    const taskPlanDiagnosticsNote = structuredPlannedScope.diagnostics.length > 0
        ? ` ${structuredPlannedScope.diagnostics.join(' ')}`
        : '';
    return {
        nextGate: structuredPlannedFiles.length > 0 ? 'materialize-planned-scope' : 'implementation',
        title: structuredPlannedFiles.length > 0
            ? 'Materialize planned task changes before compile.'
            : 'Implement task changes before compile.',
        reason:
            'The current preflight is BASELINE_ONLY with no reviewable diff, but this task has implementation intent. ' +
            'Do not run compile-gate against a clean pre-implementation baseline. ' +
            `${plannedFilesNote}${ignoredFilesNote}${taskPlanDiagnosticsNote} ` +
            'Implement or create the planned files first, then rerun next-step so classify-change can bind the real workspace scope before compile/review.',
        commands: []
    };
}
