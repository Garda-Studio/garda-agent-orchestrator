import * as childProcess from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPlainRecord } from '../../core/records';
import { findUnapprovedActiveImplementationOwners } from '../workspace/active-implementation-ownership';
import {
    selectRulePackFiles
} from '../review-context/review-context-token-economy';
import {
    isPathRealpathInsideRoot,
    normalizePath
} from '../shared/helpers';
import {
    normalizeWorkspaceRelativePath,
    normalizeWorkspaceRelativePaths
} from '../workspace/dirty-worktree-protection';
import {
    assessQualityChecklistAnswersTemplateFile,
    buildQualityChecklistArtifact,
    resolveDefaultQualityChecklistAnswersTemplatePath
} from '../quality-checklist';
import type {
    TaskQueueEntry
} from './next-step-task-queue';
import {
    buildBundleRelativePath,
    quoteCommandValue,
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    buildReviewPhaseCommand,
    buildTaskModePathCommandParts
} from './next-step-review-command-builders';
import {
    getPreflightChangedFiles
} from './next-step-doc-closeout-readiness';
import {
    resolveTaskProfileSelection
} from '../../policy/task-profile-selection';
import {
    resolveBundleRootForTarget
} from '../../core/constants';
import {
    expandDependencyManifestLockfileScope
} from '../scope/dependency-manifest-lockfile-scope';
import {
    REVIEW_CONTRACTS
} from '../required-reviews/required-reviews-check';
import {
    getWorkflowConfigChangedFiles
} from '../workflow-config/workflow-config-work';
import {
    selectTaskEntryRulePackFileNames
} from '../rule-pack/rule-pack-selection';
import {
    resolveSplitCheckpointTaskScope
} from '../split-required/split-checkpoint-scope';

export interface AuthenticatedSplitCheckpointCommandScope {
    detectionSource: string;
    changedFiles: string[];
    violation: string | null;
}

function resolveDefaultDepthFromTaskQueue(repoRoot: string, taskEntry: TaskQueueEntry | null): string {
    try {
        const resolvedProfile = resolveTaskProfileSelection(
            resolveBundleRootForTarget(repoRoot),
            taskEntry?.profile || null
        );
        const depth = resolvedProfile.effective_policy.depth;
        if (Number.isInteger(depth) && depth >= 1 && depth <= 3) {
            return String(depth);
        }
    } catch {
        // Fall back to legacy queue-name mapping when profile config is unavailable.
    }
    const profile = String(taskEntry?.profile || '').trim().toLowerCase();
    if (profile === 'fast' || profile === 'docs-only') return '1';
    return '2';
}

function resolveDefaultDepthFromTaskMode(taskMode: Record<string, unknown> | null): string {
    // Restart commands must preserve the task-mode artifact snapshot. Fresh task
    // entry resolves profile defaults; restart should not drift if profiles.json changes later.
    return getNumberField(taskMode, 'requested_depth', '<1|2|3>');
}

function shouldPreserveEffectiveDepthForRestart(
    taskMode: Record<string, unknown> | null,
    requestedDepth: string,
    effectiveDepth: string
): boolean {
    if (!effectiveDepth) {
        return false;
    }
    const effectiveDepthSource = getStringField(taskMode, 'effective_depth_source', '');
    if (effectiveDepthSource === 'explicit') {
        return true;
    }
    return !effectiveDepthSource && requestedDepth !== effectiveDepth;
}

export function getStringField(source: Record<string, unknown> | null, field: string, fallback: string): string {
    const rawValue = source?.[field];
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    return value || fallback;
}

function getNumberField(source: Record<string, unknown> | null, field: string, fallback: string): string {
    const value = source?.[field];
    return Number.isInteger(value) ? String(value) : fallback;
}

function buildProtectedOperatorConfirmationCommandParts(): string[] {
    return [
        '--operator-confirmed yes',
        '--operator-confirmed-at-utc "<ISO-8601 timestamp>"'
    ];
}

function readGitPathLines(repoRoot: string, args: string[]): string[] | null {
    try {
        const output = childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 10000
        });
        return String(output || '').split(/\r?\n/).map((entry) => normalizePath(entry)).filter(Boolean);
    } catch {
        return null;
    }
}

interface CommandWorkspaceReadSnapshot {
    active: boolean;
    repositories: Map<string, { changedFiles: string[]; reliable: boolean }>;
}

const commandWorkspaceReadSnapshots = new AsyncLocalStorage<CommandWorkspaceReadSnapshot>();

export function withNextStepCommandWorkspaceReadSnapshot<T>(callback: () => T): T {
    const snapshot: CommandWorkspaceReadSnapshot = { active: true, repositories: new Map() };
    return commandWorkspaceReadSnapshots.run(snapshot, () => {
        try {
            return callback();
        } finally {
            snapshot.active = false;
            snapshot.repositories.clear();
        }
    });
}

function readCurrentWorkspaceChangedFiles(repoRoot: string): { changedFiles: string[]; reliable: boolean } {
    const snapshot = commandWorkspaceReadSnapshots.getStore();
    const resolvedRoot = path.resolve(repoRoot);
    const key = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
    const cached = snapshot?.active ? snapshot.repositories.get(key) : null;
    if (cached) return { changedFiles: [...cached.changedFiles], reliable: cached.reliable };
    const result = captureCurrentWorkspaceChangedFiles(repoRoot);
    if (snapshot?.active) snapshot.repositories.set(key, result);
    return { changedFiles: [...result.changedFiles], reliable: result.reliable };
}

function captureCurrentWorkspaceChangedFiles(repoRoot: string): { changedFiles: string[]; reliable: boolean } {
    const trackedChangedFiles = readGitPathLines(repoRoot, ['diff', '--name-only', '--diff-filter=ACDMRTUXB', 'HEAD', '--']);
    const untrackedChangedFiles = readGitPathLines(repoRoot, ['ls-files', '--others', '--exclude-standard']);
    if (trackedChangedFiles === null || untrackedChangedFiles === null) {
        return { changedFiles: [], reliable: false };
    }
    return {
        changedFiles: [...new Set([
            ...trackedChangedFiles,
            ...untrackedChangedFiles
        ])].sort(),
        reliable: true
    };
}

export function readCurrentStagedChangedFiles(repoRoot: string): string[] | null {
    return readGitPathLines(repoRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACDMRTUXB', '--']);
}

function isSafeRepoRelativePath(relativePath: string): boolean {
    const normalizedPath = normalizePath(relativePath).replace(/\/+$/, '');
    if (!normalizedPath || normalizedPath === '.' || path.isAbsolute(normalizedPath)) {
        return false;
    }
    return !normalizedPath.split('/').includes('..');
}

function isPlainDirectoryPlaceholder(repoRoot: string, relativePath: string): boolean {
    if (!isSafeRepoRelativePath(relativePath)) {
        return false;
    }
    const absolutePath = path.resolve(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
        return false;
    }
    const fileStatus = fs.lstatSync(absolutePath);
    return fileStatus.isDirectory() && !fileStatus.isSymbolicLink();
}

function isPhysicallyContainedCommandPath(repoRoot: string, relativePath: string): boolean {
    if (!isSafeRepoRelativePath(relativePath)) {
        return false;
    }
    return isPathRealpathInsideRoot(
        path.resolve(repoRoot, relativePath),
        repoRoot,
        { allowMissing: true }
    );
}

function expandDirectoryPlaceholdersForCommand(repoRoot: string, scopeFiles: string[]): string[] {
    const normalizedScopeFiles = [...new Set(scopeFiles.map((entry) => normalizePath(entry)).filter(Boolean))]
        .filter((entry) => isPhysicallyContainedCommandPath(repoRoot, entry))
        .sort();
    if (normalizedScopeFiles.length === 0) {
        return [];
    }
    const currentWorkspace = readCurrentWorkspaceChangedFiles(repoRoot);
    if (!currentWorkspace.reliable) {
        return normalizedScopeFiles;
    }
    const currentChangedFiles = currentWorkspace.changedFiles;
    if (currentChangedFiles.length === 0) {
        return normalizedScopeFiles.filter((entry) => {
            return !isPlainDirectoryPlaceholder(repoRoot, entry);
        });
    }
    const atomicScopeFiles = expandDependencyManifestLockfileScope(normalizedScopeFiles, currentChangedFiles);

    const expanded = new Set<string>();
    for (const scopeFile of atomicScopeFiles) {
        if (
            currentChangedFiles.includes(scopeFile)
            && isPhysicallyContainedCommandPath(repoRoot, scopeFile)
        ) {
            expanded.add(scopeFile);
        }
        const prefix = `${scopeFile.replace(/\/+$/, '')}/`;
        const matchingCurrentFiles = currentChangedFiles.filter((changedFile) => (
            changedFile.startsWith(prefix)
            && isPhysicallyContainedCommandPath(repoRoot, changedFile)
        ));
        if (matchingCurrentFiles.length > 0) {
            for (const matchingFile of matchingCurrentFiles) {
                expanded.add(matchingFile);
            }
            continue;
        }

        if (isPlainDirectoryPlaceholder(repoRoot, scopeFile)) {
            continue;
        }
        if (isPhysicallyContainedCommandPath(repoRoot, scopeFile)) {
            expanded.add(scopeFile);
        }
    }
    return [...expanded].sort();
}

export function quoteProviderForCommand(provider: string | null): string {
    if (provider) {
        return quoteCommandValue(provider);
    }
    return process.platform === 'win32'
        ? '"$env:GARDA_EXECUTION_PROVIDER"'
        : '"$GARDA_EXECUTION_PROVIDER"';
}

export function buildEnterTaskModeCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskEntry: TaskQueueEntry | null,
    provider: string | null,
    taskMode: Record<string, unknown> | null = null,
    unapprovedActiveTaskOwners?: readonly string[]
): string {
    const requestedDepth = taskMode
        ? resolveDefaultDepthFromTaskMode(taskMode)
        : resolveDefaultDepthFromTaskQueue(repoRoot, taskEntry);
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--entry-mode ${quoteCommandValue(getStringField(taskMode, 'entry_mode', 'EXPLICIT_TASK_EXECUTION'))}`,
        `--requested-depth ${quoteCommandValue(requestedDepth)}`,
        `--task-summary ${quoteCommandValue(getStringField(taskMode, 'task_summary', taskEntry?.title || taskId))}`
    ];
    parts.push(`--provider ${taskMode
        ? quoteCommandValue(getStringField(taskMode, 'provider', provider || '<provider>'))
        : quoteProviderForCommand(provider)}`);
    if (taskMode) {
        const plan = isPlainRecord(taskMode.plan) ? taskMode.plan : null;
        const planPath = getStringField(plan, 'plan_path', '');
        if (planPath) parts.push(`--plan-path ${quoteCommandValue(planPath)}`);
        for (const [field, flag] of [['start_banner', '--start-banner'], ['routed_to', '--routed-to']]) {
            const value = getStringField(taskMode, field, '');
            if (value) parts.push(`${flag} ${quoteCommandValue(value)}`);
        }
        const effectiveDepth = getNumberField(taskMode, 'effective_depth', '');
        if (shouldPreserveEffectiveDepthForRestart(taskMode, requestedDepth, effectiveDepth)) {
            parts.push(`--effective-depth ${quoteCommandValue(effectiveDepth)}`);
        }
    }
    const owners = unapprovedActiveTaskOwners ?? findUnapprovedActiveImplementationOwners(repoRoot, taskId);
    if (owners.length > 0) {
        for (const owner of owners) parts.push(`--allow-active-task ${quoteCommandValue(owner)}`);
        const plannedFiles = Array.isArray(taskMode?.planned_changed_files)
            ? taskMode.planned_changed_files.map(String) : [];
        for (const file of plannedFiles.length > 0 ? plannedFiles : ['<task-owned-file>']) {
            parts.push(`--planned-changed-file ${quoteCommandValue(file)}`);
        }
        if (taskMode) {
            parts.push('--upgrade-existing-task-mode');
            if (taskMode.orchestrator_work === true) parts.push('--orchestrator-work');
            if (taskMode.workflow_config_work === true) parts.push('--workflow-config-work');
        }
        parts.push(...buildProtectedOperatorConfirmationCommandParts());
    }
    parts.push('--repo-root "."');
    return parts.join(' ');
}

export function buildOrchestratorWorkRestartCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskMode: Record<string, unknown> | null,
    additionalPlannedChangedFiles: string[] = [],
    includeWorkflowConfigWork = false
): string {
    const requestedDepth = resolveDefaultDepthFromTaskMode(taskMode);
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--entry-mode ${quoteCommandValue(getStringField(taskMode, 'entry_mode', 'EXPLICIT_TASK_EXECUTION'))}`,
        `--requested-depth ${quoteCommandValue(requestedDepth)}`,
        `--task-summary ${quoteCommandValue(getStringField(taskMode, 'task_summary', '<TASK.md summary>'))}`,
        `--provider ${quoteCommandValue(getStringField(taskMode, 'provider', '<provider>'))}`
    ];
    const startBanner = getStringField(taskMode, 'start_banner', '');
    if (startBanner) {
        parts.push(`--start-banner ${quoteCommandValue(startBanner)}`);
    }
    const routedTo = getStringField(taskMode, 'routed_to', '');
    if (routedTo) {
        parts.push(`--routed-to ${quoteCommandValue(routedTo)}`);
    }
    const effectiveDepth = getNumberField(taskMode, 'effective_depth', '');
    if (shouldPreserveEffectiveDepthForRestart(taskMode, requestedDepth, effectiveDepth)) {
        parts.push(`--effective-depth ${quoteCommandValue(effectiveDepth)}`);
    }
    parts.push('--orchestrator-work');
    if (includeWorkflowConfigWork) {
        parts.push('--workflow-config-work');
    }
    parts.push('--upgrade-existing-task-mode');
    parts.push(...buildProtectedOperatorConfirmationCommandParts());
    const plannedChangedFiles = Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const dirtyBaselineChangedFiles = getTaskModeDirtyWorkspaceBaselineChangedFiles(repoRoot, taskMode);
    const currentChangedFiles = additionalPlannedChangedFiles
        .map((entry) => normalizePath(entry))
        .filter(Boolean);
    const restartScopeFiles = currentChangedFiles.length > 0
        ? currentChangedFiles
        : dirtyBaselineChangedFiles.length > 0
            ? dirtyBaselineChangedFiles
            : plannedChangedFiles;
    const mergedPlannedChangedFiles = expandDirectoryPlaceholdersForCommand(repoRoot, restartScopeFiles);
    const workflowConfigFileSet = includeWorkflowConfigWork
        ? new Set<string>()
        : new Set(getWorkflowConfigChangedFiles(mergedPlannedChangedFiles));
    for (const plannedChangedFile of mergedPlannedChangedFiles) {
        if (workflowConfigFileSet.has(plannedChangedFile)) {
            continue;
        }
        parts.push(`--planned-changed-file ${quoteCommandValue(plannedChangedFile)}`);
    }
    parts.push('--repo-root "."');
    return parts.join(' ');
}

export function getTaskModePlannedChangedFiles(taskMode: Record<string, unknown> | null): string[] {
    return Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
}

export function getTaskModeDirtyWorkspaceBaselineChangedFiles(
    repoRoot: string,
    taskMode: Record<string, unknown> | null
): string[] {
    if (taskMode?.orchestrator_work !== true) {
        return [];
    }
    const dirtyWorkspaceBaseline = taskMode.dirty_workspace_baseline;
    if (!dirtyWorkspaceBaseline || typeof dirtyWorkspaceBaseline !== 'object' || Array.isArray(dirtyWorkspaceBaseline)) {
        return [];
    }
    const changedFiles = (dirtyWorkspaceBaseline as Record<string, unknown>).changed_files;
    return normalizeWorkspaceRelativePaths(repoRoot, changedFiles);
}

export function getTaskModeDirtyWorkspaceBaselineCommandChangedFiles(
    repoRoot: string,
    taskMode: Record<string, unknown> | null
): string[] {
    if (taskMode?.orchestrator_work !== true) {
        return [];
    }
    const dirtyWorkspaceBaseline = taskMode.dirty_workspace_baseline;
    if (!dirtyWorkspaceBaseline || typeof dirtyWorkspaceBaseline !== 'object' || Array.isArray(dirtyWorkspaceBaseline)) {
        return [];
    }
    const changedFiles = (dirtyWorkspaceBaseline as Record<string, unknown>).changed_files;
    return Array.isArray(changedFiles)
        ? [...new Set(changedFiles
            .map((entry) => normalizeDirtyBaselineCommandPath(repoRoot, entry))
            .filter((entry): entry is string => !!entry))]
            .sort()
        : [];
}

function normalizeDirtyBaselineCommandPath(repoRoot: string, value: unknown): string | null {
    const rawPath = String(value || '').trim();
    const normalizedRawPath = normalizePath(rawPath);
    if (!normalizedRawPath) {
        return null;
    }
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedPath = path.resolve(resolvedRoot, rawPath);
    const relativeFromRoot = path.relative(resolvedRoot, resolvedPath);
    if (!relativeFromRoot || relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
        return null;
    }
    const normalizedRelativePath = normalizePath(relativeFromRoot);
    if (!normalizedRelativePath) {
        return null;
    }
    try {
        if (
            fs.existsSync(resolvedPath)
            && !isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: false })
        ) {
            return null;
        }
        return normalizedRelativePath;
    } catch {
        return null;
    }
}

export function getTaskModeDirtyWorkspaceBaselineFileHashes(
    repoRoot: string,
    taskMode: Record<string, unknown> | null
): Record<string, string> {
    if (taskMode?.orchestrator_work !== true) {
        return {};
    }
    const dirtyWorkspaceBaseline = taskMode.dirty_workspace_baseline;
    if (!dirtyWorkspaceBaseline || typeof dirtyWorkspaceBaseline !== 'object' || Array.isArray(dirtyWorkspaceBaseline)) {
        return {};
    }
    const fileHashes = (dirtyWorkspaceBaseline as Record<string, unknown>).file_hashes;
    if (!fileHashes || typeof fileHashes !== 'object' || Array.isArray(fileHashes)) {
        return {};
    }
    const normalized: Record<string, string> = {};
    for (const [filePath, hash] of Object.entries(fileHashes as Record<string, unknown>)) {
        const normalizedPath = normalizeWorkspaceRelativePath(repoRoot, filePath);
        const normalizedHash = typeof hash === 'string' ? hash.trim().toLowerCase() : '';
        if (normalizedPath && normalizedHash) {
            normalized[normalizedPath] = normalizedHash;
        }
    }
    return normalized;
}

function getTaskModeClassifyChangedFiles(repoRoot: string, taskMode: Record<string, unknown> | null): string[] {
    const plannedChangedFiles = getTaskModePlannedChangedFiles(taskMode);
    const dirtyBaselineCommandFiles = getTaskModeDirtyWorkspaceBaselineCommandChangedFiles(repoRoot, taskMode);
    if (taskMode?.workflow_config_work === true) {
        return [...new Set([
            ...plannedChangedFiles,
            ...dirtyBaselineCommandFiles
        ])].sort();
    }
    if (plannedChangedFiles.length > 0) {
        return [...new Set(plannedChangedFiles)].sort();
    }
    return [...new Set(dirtyBaselineCommandFiles)].sort();
}

export function getPreflightRefreshChangedFiles(
    repoRoot: string,
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null
): string[] {
    const plannedChangedFiles = taskMode?.workflow_config_work === true
        ? [...new Set([
            ...getTaskModePlannedChangedFiles(taskMode),
            ...getTaskModeDirtyWorkspaceBaselineChangedFiles(repoRoot, taskMode)
        ])].sort()
        : getTaskModePlannedChangedFiles(taskMode).length > 0
            ? getTaskModePlannedChangedFiles(taskMode)
            : getTaskModeDirtyWorkspaceBaselineChangedFiles(repoRoot, taskMode);
    const detectionSource = String(preflight?.detection_source || '').trim().toLowerCase();
    const explicitPreflightChangedFiles = detectionSource === 'explicit_changed_files'
        ? getPreflightChangedFiles(preflight)
        : [];
    if (plannedChangedFiles.length > 0 || explicitPreflightChangedFiles.length > 0) {
        return [...new Set([
            ...plannedChangedFiles,
            ...explicitPreflightChangedFiles
        ])].sort();
    }
    if (detectionSource === 'explicit_changed_files') {
        return getPreflightChangedFiles(preflight);
    }
    return [];
}

export function resolveAuthenticatedSplitCheckpointCommandScope(
    repoRoot: string,
    taskId: string,
    taskQueueEntries?: ReadonlyMap<string, TaskQueueEntry>
): AuthenticatedSplitCheckpointCommandScope | null {
    const resolution = resolveSplitCheckpointTaskScope(repoRoot, taskId, taskQueueEntries);
    if (resolution.scope) {
        return {
            detectionSource: resolution.scope.detection_source,
            changedFiles: [...resolution.scope.changed_files],
            violation: null
        };
    }
    if (resolution.violation) {
        return {
            detectionSource: '',
            changedFiles: [],
            violation: resolution.violation
        };
    }
    return null;
}

export function buildClassifyChangeCommand(params: {
    repoRoot: string;
    cliPrefix: string;
    taskId: string;
    taskMode: Record<string, unknown> | null;
    taskModePath: string | null;
    preflightCommandPath: string;
    includePlannedScope: boolean;
    changedFiles?: string[];
    detectionSource?: string | null;
    taskIntent?: string | null;
}): string {
    const taskIntent = String(params.taskIntent || '').trim()
        || getStringField(params.taskMode, 'task_summary', '<task summary>');
    const parts = [
        `${params.cliPrefix} gate classify-change`,
        `--task-id ${quoteCommandValue(params.taskId)}`,
        `--task-intent ${quoteCommandValue(taskIntent)}`
    ];
    const changedFiles = params.changedFiles || (params.includePlannedScope
        ? getTaskModeClassifyChangedFiles(params.repoRoot, params.taskMode)
        : []);
    const expandedChangedFiles = expandDirectoryPlaceholdersForCommand(params.repoRoot, changedFiles);
    const detectionSource = String(params.detectionSource || '').trim();
    if (detectionSource) {
        parts.push(`--detection-source ${quoteCommandValue(detectionSource)}`);
    }
    for (const changedFile of expandedChangedFiles) {
        parts.push(`--changed-file ${quoteCommandValue(changedFile)}`);
    }
    if (expandedChangedFiles.length === 0 && (readCurrentStagedChangedFiles(params.repoRoot)?.length || 0) > 0) {
        parts.push('--use-staged');
    }
    parts.push(...buildTaskModePathCommandParts(params.repoRoot, params.taskId, params.taskModePath));
    parts.push(`--output-path ${quoteCommandValue(params.preflightCommandPath)}`);
    parts.push('--repo-root "."');
    return parts.join(' ');
}

export function getEffectiveDepthForPostPreflightRules(
    preflight: Record<string, unknown> | null,
    taskMode: Record<string, unknown> | null
): number {
    const riskAwareDepth = isPlainRecord(preflight?.risk_aware_depth) ? preflight.risk_aware_depth : null;
    const preflightDepth = typeof riskAwareDepth?.effective_depth === 'number'
        ? riskAwareDepth.effective_depth
        : Number(riskAwareDepth?.effective_depth);
    if (Number.isInteger(preflightDepth) && preflightDepth >= 1) {
        return preflightDepth;
    }
    const taskModeDepth = typeof taskMode?.effective_depth === 'number'
        ? taskMode.effective_depth
        : Number(taskMode?.effective_depth);
    if (Number.isInteger(taskModeDepth) && taskModeDepth >= 1) {
        return taskModeDepth;
    }
    return 2;
}

export function getPostPreflightRuleFileNames(
    preflight: Record<string, unknown> | null,
    taskMode: Record<string, unknown> | null
): string[] {
    const requiredReviews = isPlainRecord(preflight?.required_reviews) ? preflight.required_reviews : {};
    const effectiveDepth = getEffectiveDepthForPostPreflightRules(preflight, taskMode);
    const fileNames = new Set<string>(selectTaskEntryRulePackFileNames({ effectiveDepth }));
    for (const [reviewType, required] of Object.entries(requiredReviews)) {
        if (required !== true) {
            continue;
        }
        for (const fileName of selectRulePackFiles(reviewType, effectiveDepth)) {
            fileNames.add(fileName);
        }
    }
    return [...fileNames].sort();
}

export function buildPostPreflightRulePackCommandForFiles(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    ruleFileNames: string[],
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "POST_PREFLIGHT"',
        `--preflight-path "${buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`)}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        ...ruleFileNames.map((fileName) => (
            `--loaded-rule-file "${buildBundleRelativePath(repoRoot, `live/docs/agent-rules/${fileName}`)}"`
        )),
        '--repo-root "."'
    ].join(' ');
}

export function buildPostPreflightRulePackBindCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate bind-rule-pack-to-preflight`,
        `--task-id "${taskId}"`,
        `--preflight-path "${buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`)}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}

export function buildCompileGateCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate compile-gate`,
        `--task-id "${taskId}"`,
        `--preflight-path "${preflightCommandPath}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}

export function buildQualityChecklistCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null,
    answersTemplatePath?: string | null
): string {
    const absoluteAnswersPath = answersTemplatePath
        ? path.resolve(repoRoot, answersTemplatePath)
        : resolveDefaultQualityChecklistAnswersTemplatePath(repoRoot, taskId);
    let answersTemplateIsExecutable = false;
    try {
        const assessment = assessQualityChecklistAnswersTemplateFile({
            repoRoot,
            taskId,
            preflightPath: preflightCommandPath,
            answersPath: absoluteAnswersPath
        });
        answersTemplateIsExecutable = assessment.status === 'current'
            && assessment.template !== null
            && buildQualityChecklistArtifact({
                repoRoot,
                taskId,
                preflightPath: preflightCommandPath,
                answers: assessment.template
            }).status !== 'CONFIG_ERROR';
    } catch {
        return '';
    }
    if (!answersTemplateIsExecutable) {
        return '';
    }
    const answersPath = toRepoDisplayPath(repoRoot, absoluteAnswersPath);
    return [
        `${cliPrefix} gate quality-checklist`,
        `--task-id "${taskId}"`,
        `--preflight-path "${preflightCommandPath}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        `--answers-path "${answersPath}"`,
        '--repo-root "."'
    ].join(' ');
}

export function buildReviewContextCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    reviewType: string,
    reviewDepth: number,
    preflightCommandPath: string,
    taskModePath: string | null,
    focusedRequiredTestPath?: string | null
): string {
    const focusedRequiredTest = normalizeWorkspaceRelativePath(repoRoot, String(focusedRequiredTestPath || '').trim());
    return [
        `${cliPrefix} gate build-review-context`,
        `--review-type "${reviewType}"`,
        `--depth "${reviewDepth}"`,
        `--preflight-path "${preflightCommandPath}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        ...(focusedRequiredTest
            ? [`--focused-required-test-path ${quoteCommandValue(focusedRequiredTest)}`]
            : []),
        '--repo-root "."'
    ].join(' ');
}

export function buildRequiredReviewsCheckCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null,
    reviewAuthorshipAttestationDefaults?: Record<string, boolean>
): string {
    const parts = [
        `--preflight-path "${preflightCommandPath}"`
    ];
    const attestationPlaceholder = buildReviewAuthorshipAttestationDefault(
        repoRoot,
        preflightCommandPath,
        reviewAuthorshipAttestationDefaults
    );
    if (attestationPlaceholder) {
        parts.push(`--review-authorship-attestation-json ${quoteCommandValue(attestationPlaceholder)}`);
    }
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'required-reviews-check', parts, taskModePath);
}

function buildReviewAuthorshipAttestationDefault(
    repoRoot: string,
    preflightCommandPath: string,
    reviewAuthorshipAttestationDefaults?: Record<string, boolean>
): string | null {
    try {
        const preflightPath = path.resolve(repoRoot, preflightCommandPath);
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const requiredReviews = isPlainRecord(preflight.required_reviews)
            ? preflight.required_reviews
            : {};
        const requiredReviewTypes = REVIEW_CONTRACTS
            .map(([reviewType]) => reviewType)
            .filter((reviewType) => requiredReviews[reviewType] === true);
        if (requiredReviewTypes.length === 0) {
            return null;
        }
        return JSON.stringify(Object.fromEntries(requiredReviewTypes.map((reviewType) => [
            reviewType,
            reviewAuthorshipAttestationDefaults?.[reviewType] === true
        ])));
    } catch {
        return null;
    }
}

export function buildCompletionGateCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'completion-gate', [
        `--preflight-path "${preflightCommandPath}"`
    ], taskModePath);
}
