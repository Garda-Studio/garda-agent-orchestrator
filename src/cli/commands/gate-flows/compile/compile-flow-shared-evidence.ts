import { TASK_QUEUE_FILENAME } from '../../../../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleNameForTarget,
    UNCONFIGURED_COMPILE_GATE_COMMAND,
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND
} from '../../../../core/constants';
import { readWorkflowConfigForMerge } from '../../../../core/workflow-config';
import { parseTaskMdTableRow } from '../../../../core/task-md-table';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../../../core/subprocess';
import { classifyChange } from '../../../../gates/preflight/classify-change';
import { getTaskModeEvidence } from '../../../../gates/task-mode/task-mode';
import { parseSplitCheckpointDetectionSource } from '../../../../gates/split-required/split-checkpoint-scope';
import {
    getWorkflowConfigChangedFiles,
    getWorkflowConfigControlPlanePaths
} from '../../../../gates/workflow-config/workflow-config-work';
import { resolveGateExecutionPath } from '../../../../gates/isolation/isolation-sandbox';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { resolveDefaultReviewsPath, resolvePathForWrite } from '../../../gate-cli/gates-artifacts';
import { splitOutputLines } from './gate-flow-helpers';

type ClassificationResult = ReturnType<typeof classifyChange>;

export function buildNextStepRecoveryCommand(repoRoot: string, taskId: string): string {
    const resolvedRepoRoot = path.resolve(repoRoot || '.');
    const cliPrefix = fs.existsSync(path.join(resolvedRepoRoot, 'bin', 'garda.js'))
        ? 'node bin/garda.js'
        : `node ${resolveBundleNameForTarget(resolvedRepoRoot)}/bin/garda.js`;
    return `${cliPrefix} next-step "${taskId}" --repo-root "."`;
}

export function appendNextStepRecoveryHint(message: string, repoRoot: string, taskId: string): string {
    const trimmed = String(message || '').trim();
    if (!trimmed || !taskId || /\bnext-step\b/.test(trimmed)) {
        return trimmed;
    }
    return `${trimmed} NextStep: run ${buildNextStepRecoveryCommand(repoRoot, taskId)} and follow its single recommended command before retrying compile-gate.`;
}

export function readConfiguredFullSuiteCommandForCompileGate(repoRoot: string): string | null {
    const workflowConfigPath = resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'workflow-config.json'));
    const result = readWorkflowConfigForMerge(workflowConfigPath);
    const config = result.config;
    if (!config || typeof config.full_suite_validation !== 'object' || Array.isArray(config.full_suite_validation)) {
        return null;
    }
    const fullSuiteConfig = config.full_suite_validation as Record<string, unknown>;
    const command = typeof fullSuiteConfig.command === 'string'
        ? fullSuiteConfig.command.trim()
        : '';
    if (!command || command === UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND) {
        return null;
    }
    return command;
}

export function readConfiguredCompileGateCommandForCompileGate(repoRoot: string): {
    command: string | null;
    configPath: string;
} {
    const workflowConfigPath = resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'workflow-config.json'));
    const result = readWorkflowConfigForMerge(workflowConfigPath);
    const config = result.config;
    if (!config || typeof config.compile_gate !== 'object' || Array.isArray(config.compile_gate)) {
        return { command: null, configPath: workflowConfigPath };
    }
    const compileGateConfig = config.compile_gate as Record<string, unknown>;
    const command = typeof compileGateConfig.command === 'string'
        ? compileGateConfig.command.trim()
        : '';
    if (!command || command === UNCONFIGURED_COMPILE_GATE_COMMAND) {
        return { command: null, configPath: workflowConfigPath };
    }
    return { command, configPath: workflowConfigPath };
}

export function buildUnconfiguredCompileGateCommandMessage(repoRoot: string, configPath: string): string {
    const cliPrefix = gateHelpers.isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(repoRoot));
    const normalizedConfigPath = gateHelpers.normalizePath(configPath);
    return [
        `Compile gate command is unconfigured in ${normalizedConfigPath}.`,
        'Compile-gate is fail-closed and will not read 40-commands.md as a fallback because compile/build/type-check commands are project-specific.',
        `Set a real compile/build/type-check command with: ${cliPrefix} workflow set --compile-gate-command "<command>" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --target-root ".".`,
        'If this workspace has not been initialized, rerun agent-init/project discovery so it can record the project-specific compile-gate command.'
    ].join(' ');
}

export function buildDomainReviewSurface(result: ClassificationResult): Record<string, boolean> {
    const triggers = result.triggers;
    const hasReviewableDiff = Array.isArray(result.changed_files)
        ? result.changed_files.length > 0
        : result.metrics.changed_files_count > 0;
    return {
        db: triggers.db === true,
        security: triggers.security === true,
        refactor: triggers.refactor_heuristic === true || (triggers.refactor_intent === true && hasReviewableDiff),
        api: triggers.api === true,
        test: triggers.test === true,
        performance: triggers.performance === true,
        infra: triggers.infra === true,
        dependency: triggers.dependency === true
    };
}

export function isZeroDiffBaselineOnlyNoReviewableScope(
    result: ClassificationResult,
    domainSurface: Record<string, boolean>,
    plannedChangedFiles: string[],
    dirtyWorkspaceBaselineChangedFiles: string[],
    authenticatedNoOpScope = false
): boolean {
    const zeroDiffGuard = result.zero_diff_guard as Record<string, unknown> | undefined;

    const noReviewableWorkspace = (result.detection_source === 'git_auto'
        && plannedChangedFiles.length === 0 && dirtyWorkspaceBaselineChangedFiles.length === 0)
        || (result.detection_source === 'git_staged_only' && authenticatedNoOpScope);

    return noReviewableWorkspace
        && result.scope_category === 'empty'
        && Array.isArray(result.changed_files)
        && result.changed_files.length === 0
        && result.metrics.changed_files_count === 0
        && result.metrics.changed_lines_total === 0
        && zeroDiffGuard?.zero_diff_detected === true
        && zeroDiffGuard?.status === 'BASELINE_ONLY'
        && zeroDiffGuard?.completion_requires_audited_no_op === true
        && result.triggers.protected_control_plane_changed !== true
        && !Object.values(domainSurface).some((value) => value === true);
}

export function getClassificationRenameCount(repoRoot: string, detectionSource: string, changedFiles: string[]): number {
    if (detectionSource === 'explicit_changed_files' && changedFiles.length === 0) {
        return 0;
    }

    const args = [
        '-C',
        repoRoot,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--name-status',
        '--diff-filter=ACDMRTUXB'
    ];
    const splitCheckpointRange = parseSplitCheckpointDetectionSource(detectionSource);
    if (splitCheckpointRange) {
        args.push(splitCheckpointRange.base_commit, splitCheckpointRange.checkpoint_commit, '--', ...changedFiles);
    } else if (detectionSource === 'git_staged_only' || detectionSource === 'git_staged_plus_untracked') {
        args.push('--cached');
    } else {
        args.push('HEAD');
        if (detectionSource === 'explicit_changed_files' && changedFiles.length > 0) {
            args.push('--', ...changedFiles);
        }
    }

    const result = spawnSyncWithTimeout('git', args, {
        cwd: repoRoot,
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    });
    if (result.error || result.status !== 0) {
        return 0;
    }

    return splitOutputLines(result.stdout).filter((line) => /^R\d*\t/i.test(line)).length;
}

export function getTaskModeEntryTimestampMs(taskModeEvidencePath: string | null): number | null {
    const resolvedPath = String(taskModeEvidencePath || '').trim();
    if (!resolvedPath || !fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return null;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
        const timestampUtc = String(parsed.timestamp_utc || '').trim();
        const parsedTimestamp = Date.parse(timestampUtc);
        if (Number.isFinite(parsedTimestamp)) {
            return parsedTimestamp;
        }
    } catch {
        // Fall back to file mtime below.
    }

    return fs.statSync(resolvedPath).mtimeMs;
}

export function readCurrentTaskSummary(repoRoot: string, taskId: string, fallbackTaskSummary: string | null): string | null {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (fs.existsSync(taskPath) && fs.statSync(taskPath).isFile()) {
        for (const line of fs.readFileSync(taskPath, 'utf8').split('\n')) {
            const cells = parseTaskMdTableRow(line);
            if (cells.length >= 5 && cells[0]?.trimmed === taskId) {
                return cells[4]?.trimmed || fallbackTaskSummary;
            }
        }
    }
    return null;
}

export function resolveOptionalSkillTaskText(
    repoRoot: string,
    taskId: string,
    taskIntent: unknown,
    fallbackTaskSummary: string | null
): string {
    const currentTaskSummary = String(readCurrentTaskSummary(repoRoot, taskId, fallbackTaskSummary) || '').trim();
    if (currentTaskSummary) {
        return currentTaskSummary;
    }
    const explicitTaskIntent = String(taskIntent || '').trim();
    if (explicitTaskIntent) {
        return explicitTaskIntent;
    }
    return '';
}

export function listChangedFilesPredatingTaskMode(
    repoRoot: string,
    changedFiles: string[],
    taskModeEvidencePath: string | null
): string[] {
    const taskModeTimestampMs = getTaskModeEntryTimestampMs(taskModeEvidencePath);
    if (taskModeTimestampMs == null || changedFiles.length === 0) {
        return [];
    }

    // Allow for coarse filesystem timestamp resolution.
    const cutoffTimestampMs = taskModeTimestampMs - 1000;
    const preTaskFiles = new Set<string>();
    for (const relativePath of changedFiles) {
        const absolutePath = path.join(repoRoot, relativePath);
        try {
            if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
                continue;
            }
            if (fs.statSync(absolutePath).mtimeMs < cutoffTimestampMs) {
                preTaskFiles.add(relativePath);
            }
        } catch {
            // Ignore unreadable files and let later scope validation surface them if needed.
        }
    }

    return [...preTaskFiles].sort();
}

export function resolvePrePreflightSequenceLockPath(repoRoot: string, taskId: string): string {
    return gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'task-events', `${taskId}-pre-preflight-sequence.lock`)
    );
}

export function resolveClassifyChangeOutputPath(
    repoRoot: string,
    taskId: string | null,
    explicitOutputPath: string | undefined
): string | null {
    const trimmedOutputPath = String(explicitOutputPath || '').trim();
    if (trimmedOutputPath) {
        return resolvePathForWrite(trimmedOutputPath, repoRoot);
    }
    if (taskId) {
        return resolveDefaultReviewsPath(repoRoot, `${taskId}-preflight.json`);
    }
    return null;
}

export function quotePowerShellCliValue(value: string): string {
    return `"${String(value).replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"')}"`;
}

function buildProtectedOperatorConfirmationCommandParts(): string[] {
    return [
        '--operator-confirmed yes',
        '--operator-confirmed-at-utc "<ISO-8601 timestamp>"'
    ];
}

export function buildClassifyChangeOrchestratorWorkRestartCommand(params: {
    repoRoot: string;
    taskId: string;
    taskModeEvidence: ReturnType<typeof getTaskModeEvidence>;
    taskSummary: string | null;
    changedFiles: string[];
}): string {
    const cliPrefix = gateHelpers.isOrchestratorSourceCheckout(params.repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(params.repoRoot));
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(params.repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(params.taskId)}`,
        `--entry-mode ${quotePowerShellCliValue(params.taskModeEvidence.entry_mode || 'EXPLICIT_TASK_EXECUTION')}`,
        `--task-summary ${quotePowerShellCliValue(params.taskSummary || params.taskModeEvidence.task_summary || '')}`,
        '--orchestrator-work'
    ];
    const requestedDepth = params.taskModeEvidence.requested_depth;
    if (requestedDepth) {
        parts.splice(4, 0, `--requested-depth ${quotePowerShellCliValue(String(requestedDepth || 2))}`);
    }
    const includeWorkflowConfigWork = params.taskModeEvidence.workflow_config_work === true
        || getWorkflowConfigChangedFiles([
            ...(params.taskModeEvidence.planned_changed_files || []),
            ...params.changedFiles
        ], getWorkflowConfigControlPlanePaths(params.repoRoot)).length > 0;
    if (includeWorkflowConfigWork) {
        parts.push('--workflow-config-work');
    }
    parts.push(...buildProtectedOperatorConfirmationCommandParts());
    if (params.taskModeEvidence.start_banner) {
        parts.push(`--start-banner ${quotePowerShellCliValue(params.taskModeEvidence.start_banner)}`);
    }
    const effectiveDepth = params.taskModeEvidence.effective_depth;
    const shouldPreserveEffectiveDepth = Boolean(effectiveDepth) && (
        params.taskModeEvidence.effective_depth_source === 'explicit'
        || (!params.taskModeEvidence.effective_depth_source && requestedDepth !== effectiveDepth)
    );
    if (shouldPreserveEffectiveDepth) {
        parts.push(`--effective-depth ${quotePowerShellCliValue(String(params.taskModeEvidence.effective_depth))}`);
    }
    if (params.taskModeEvidence.provider) {
        parts.push(`--provider ${quotePowerShellCliValue(params.taskModeEvidence.provider)}`);
    }
    if (params.taskModeEvidence.routed_to) {
        parts.push(`--routed-to ${quotePowerShellCliValue(params.taskModeEvidence.routed_to)}`);
    }
    const plannedFiles = new Set<string>();
    for (const plannedFile of params.taskModeEvidence.planned_changed_files || []) {
        const normalized = gateHelpers.normalizePath(plannedFile);
        if (normalized) {
            plannedFiles.add(normalized);
        }
    }
    for (const changedFile of params.changedFiles) {
        const normalized = gateHelpers.normalizePath(changedFile);
        if (normalized) {
            plannedFiles.add(normalized);
        }
    }
    for (const plannedFile of [...plannedFiles].sort()) {
        parts.push(`--planned-changed-file ${quotePowerShellCliValue(plannedFile)}`);
    }
    return parts.join(' ');
}

export function getChangedProtectedFiles(result: ClassificationResult): string[] {
    const rawValue = result.triggers.changed_protected_files;
    if (!Array.isArray(rawValue)) {
        return [];
    }
    return rawValue
        .map((entry) => gateHelpers.normalizePath(entry))
        .filter((entry) => entry.length > 0);
}

export function mergePathLists(...pathLists: string[][]): string[] {
    return [...new Set(pathLists.flat().map((entry) => gateHelpers.normalizePath(entry)).filter(Boolean))].sort();
}

export function subtractPathList(paths: string[], excludedPaths: string[]): string[] {
    const excluded = new Set(excludedPaths.map((entry) => gateHelpers.normalizePath(entry)).filter(Boolean));
    return paths
        .map((entry) => gateHelpers.normalizePath(entry))
        .filter((entry) => entry && !excluded.has(entry))
        .sort();
}
