import { assertNoInstalledBundleScope } from '../../../../gates/protected-control-plane/installed-bundle-guard';
import * as path from 'node:path';
import { getWorkflowConfigControlPlanePaths } from '../../../../gates/workflow-config/workflow-config-work';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { expandValueList } from '../../../gate-cli/gates-parser';

export interface TaskModeEntryScope {
    plannedChangedFiles: string[];
    protectedPlannedFiles: string[];
    workflowConfigPlannedFiles: string[];
}

export function normalizePlannedChangedFiles(repoRoot: string, rawValues: unknown): string[] {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const unique = new Set<string>();
    for (const rawValue of expandValueList(rawValues || [], { splitDelimiters: true })) {
        const rawPath = String(rawValue || '').trim();
        if (!rawPath) {
            continue;
        }
        const resolvedPath = gateHelpers.resolvePathInsideRepo(rawPath, normalizedRepoRoot, { allowMissing: true });
        if (!resolvedPath) {
            continue;
        }
        const relativePath = gateHelpers.normalizePath(path.relative(normalizedRepoRoot, resolvedPath));
        if (!relativePath || relativePath === '.' || relativePath.startsWith('../')) {
            throw new Error(`PlannedChangedFile must stay inside repo root. Got '${rawPath}'.`);
        }
        unique.add(relativePath);
    }
    return [...unique].sort();
}

export function resolveTaskModeEntryScope(repoRoot: string, rawPlannedChangedFiles: unknown): TaskModeEntryScope {
    const plannedChangedFiles = normalizePlannedChangedFiles(repoRoot, rawPlannedChangedFiles);
    assertNoInstalledBundleScope(repoRoot, plannedChangedFiles);
    const protectedPlannedFiles = plannedChangedFiles.filter((entry) =>
        gateHelpers.testPathPrefix(entry, gateHelpers.getProtectedControlPlaneRoots(repoRoot))
    );
    const workflowConfigControlPlanePaths = new Set(getWorkflowConfigControlPlanePaths(repoRoot));
    const workflowConfigPlannedFiles = plannedChangedFiles.filter((entry) =>
        workflowConfigControlPlanePaths.has(gateHelpers.normalizePath(entry))
    );
    return {
        plannedChangedFiles,
        protectedPlannedFiles,
        workflowConfigPlannedFiles
    };
}
