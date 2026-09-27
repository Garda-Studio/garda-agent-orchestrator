import * as fs from 'node:fs';

import {
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo,
    toPlainRecord
} from '../shared/helpers';
import {
    getWorkflowConfigChangedFiles,
    normalizeWorkflowConfigFileHashes
} from '../workflow-config/workflow-config-work';

export interface RestartCommandChangedFilesOptions {
    includeWorkflowConfigFiles?: boolean;
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return toPlainRecord(parsed);
    } catch {
        return null;
    }
}

function toNormalizedPathList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(
        value
            .map((entry) => normalizePath(String(entry || '').trim()))
            .filter(Boolean)
    )].sort();
}

export function omitWorkflowConfigChangedFiles(changedFiles: readonly string[]): string[] {
    const workflowConfigFileSet = new Set(
        getWorkflowConfigChangedFiles(changedFiles)
            .map((entry) => normalizePath(entry))
            .filter(Boolean)
    );
    return [...new Set(
        changedFiles
            .map((entry) => normalizePath(entry))
            .filter(Boolean)
            .filter((entry) => !workflowConfigFileSet.has(entry))
    )].sort();
}

function resolvePreflightPath(repoRoot: string, preflightPath: string): string | null {
    try {
        return resolvePathInsideRepo(preflightPath, repoRoot, { enforceInside: true });
    } catch {
        return null;
    }
}

function resolveTaskModePath(repoRoot: string, taskId: string, taskModePath: string | null | undefined): string | null {
    const trimmedTaskId = String(taskId || '').trim();
    if (!trimmedTaskId) {
        return null;
    }
    const requestedPath = String(taskModePath || '').trim()
        || joinOrchestratorPath(repoRoot, `runtime/reviews/${trimmedTaskId}-task-mode.json`);
    try {
        return resolvePathInsideRepo(requestedPath, repoRoot, {
            allowMissing: true,
            enforceInside: true
        });
    } catch {
        return null;
    }
}

export function isRestartWorkflowConfigScopeAuthorized(
    repoRoot: string,
    taskId: string,
    taskModePath: string | null | undefined
): boolean {
    const trimmedTaskId = String(taskId || '').trim();
    const resolvedTaskModePath = resolveTaskModePath(repoRoot, trimmedTaskId, taskModePath);
    if (!resolvedTaskModePath) {
        return false;
    }
    const taskMode = readJsonRecord(resolvedTaskModePath);
    if (!taskMode) {
        return false;
    }
    const status = String(taskMode.status || '').trim().toUpperCase();
    const outcome = String(taskMode.outcome || '').trim().toUpperCase();
    return String(taskMode.task_id || '').trim() === trimmedTaskId
        && (status === 'PASSED' || status === 'PASS')
        && outcome === 'PASS'
        && taskMode.orchestrator_work === true
        && taskMode.workflow_config_work === true;
}

export function resolveRestartCommandChangedFiles(
    repoRoot: string,
    preflightPath: string,
    options: RestartCommandChangedFilesOptions = {}
): string[] {
    return resolveRestartCommandScope(repoRoot, preflightPath, options).changedFiles;
}

export function resolveRestartCommandScope(
    repoRoot: string,
    preflightPath: string,
    options: RestartCommandChangedFilesOptions = {}
): { changedFiles: string[]; useStaged: boolean } {
    const resolvedPreflightPath = resolvePreflightPath(repoRoot, preflightPath);
    if (!resolvedPreflightPath) {
        return { changedFiles: [], useStaged: false };
    }
    const preflight = readJsonRecord(resolvedPreflightPath);
    if (!preflight) {
        return { changedFiles: [], useStaged: false };
    }
    return {
        changedFiles: selectRestartChangedFiles(preflight, options),
        useStaged: preflight.detection_source === 'git_staged_only' || preflight.detection_source === 'git_staged_plus_untracked'
    };
}

function selectRestartChangedFiles(preflight: Record<string, unknown>, options: RestartCommandChangedFilesOptions): string[] {
    const triggers = toPlainRecord(preflight.triggers);
    const preflightChangedFiles = toNormalizedPathList(preflight.changed_files);
    const workflowConfigFiles = [...new Set([
        ...getWorkflowConfigChangedFiles(preflightChangedFiles),
        ...getWorkflowConfigChangedFiles(toNormalizedPathList(triggers?.changed_workflow_config_files))
    ])].sort();
    if (workflowConfigFiles.length === 0) {
        return preflightChangedFiles;
    }

    if (options.includeWorkflowConfigFiles === false) {
        return omitWorkflowConfigChangedFiles(preflightChangedFiles);
    }

    const workflowConfigHashes = normalizeWorkflowConfigFileHashes(triggers?.workflow_config_file_hashes);
    if (!workflowConfigHashes) {
        return [];
    }

    const attributedWorkflowConfigFiles = workflowConfigFiles.filter((relativePath) =>
        Object.prototype.hasOwnProperty.call(workflowConfigHashes, relativePath)
    );
    if (attributedWorkflowConfigFiles.length !== workflowConfigFiles.length) {
        return [];
    }

    return [...new Set([
        ...preflightChangedFiles,
        ...attributedWorkflowConfigFiles
    ])].sort();
}
