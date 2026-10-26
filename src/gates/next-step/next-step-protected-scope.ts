import { countNextStepWork } from '../../core/next-step-measurement';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import {
    evaluateProtectedControlPlaneManifest,
    fileSha256,
    getProtectedControlPlaneRoots,
    isWorkflowConfigControlPlanePath,
    normalizePath,
    resolveProtectedControlPlaneManifestPath,
    testPathPrefix
} from '../shared/helpers';
import {
    splitGeneratedRuntimeControlPlaneArtifacts
} from '../shared/generated-runtime-artifacts';
import {
    isOrchestratorSourceCheckout
} from '../protected-control-plane/protected-control-plane';
import {
    normalizeDirtyWorkspaceBaseline
} from '../workspace/dirty-worktree-protection';
import { getAuditedWorkflowConfigChangeProvenance } from '../workflow-config/workflow-config-work-audit';
import { normalizeWorkflowConfigFileHashes } from '../workflow-config/workflow-config-work-paths';

export interface CurrentGitWorkspaceSnapshotLike {
    changed_files: string[];
}

export interface CurrentProtectedScope {
    changedFiles: string[];
    protectedFiles: string[];
    workflowConfigFiles: string[];
}

function excludeAuditedLifecycleWorkflowFiles(
    repoRoot: string, scope: CurrentProtectedScope | null, taskMode: Record<string, unknown> | null
): CurrentProtectedScope | null {
    const baseline = normalizeWorkflowConfigFileHashes(taskMode?.workflow_config_file_hashes);
    if (!scope || scope.workflowConfigFiles.length === 0 || !baseline || typeof taskMode?.task_id !== 'string') return scope;
    const provenance = getAuditedWorkflowConfigChangeProvenance({
        repoRoot, taskId: taskMode.task_id, changedFiles: scope.workflowConfigFiles,
        baselineFileHashes: baseline,
        currentFileHashes: Object.fromEntries(scope.workflowConfigFiles.map(file => [file, fileSha256(path.resolve(repoRoot, file))]))
    });
    const migrated = new Set(provenance.records
        .filter(record => (countNextStepWork('visit:next-step-protected-scope:event:46'), record.mutation_source === 'lifecycle')).map(record => (countNextStepWork('visit:next-step-protected-scope:event:46'), record.config_path)));
    const protectedFiles = scope.protectedFiles.filter(file => !migrated.has(file));
    return protectedFiles.length === 0 ? null : {
        changedFiles: scope.changedFiles.filter(file => !migrated.has(file)),
        protectedFiles,
        workflowConfigFiles: scope.workflowConfigFiles.filter(file => !migrated.has(file))
    };
}

function excludeUnchangedTaskModeBaselineFiles(
    repoRoot: string,
    scope: CurrentProtectedScope,
    taskMode: Record<string, unknown> | null
): CurrentProtectedScope | null {
    const baseline = normalizeDirtyWorkspaceBaseline(taskMode?.dirty_workspace_baseline, repoRoot);
    if (!baseline) {
        return scope;
    }
    const unchangedBaselineFiles = new Set(
        baseline.changed_files.filter((relativePath) => {
            const expectedHash = baseline.file_hashes[relativePath];
            if (!expectedHash || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
                return false;
            }
            return fileSha256(path.join(repoRoot, ...relativePath.split('/'))) === expectedHash;
        })
    );
    if (unchangedBaselineFiles.size === 0) {
        return scope;
    }
    const protectedFiles = scope.protectedFiles.filter((entry) => !unchangedBaselineFiles.has(entry));
    if (protectedFiles.length === 0) {
        return null;
    }
    return {
        changedFiles: scope.changedFiles.filter((entry) => !unchangedBaselineFiles.has(entry)),
        protectedFiles,
        workflowConfigFiles: scope.workflowConfigFiles.filter((entry) => !unchangedBaselineFiles.has(entry))
    };
}

function readWorkflowConfigProtectedManifestCandidates(repoRoot: string): string[] {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    if (!fs.existsSync(manifestPath)) {
        return [];
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        const protectedSnapshot = parsed.protected_snapshot
            && typeof parsed.protected_snapshot === 'object'
            && !Array.isArray(parsed.protected_snapshot)
            ? parsed.protected_snapshot as Record<string, unknown>
            : {};
        const protectedRoots = Array.isArray(parsed.protected_roots)
            ? parsed.protected_roots.map((entry) => normalizePath(entry)).filter(Boolean)
            : [];
        return [...new Set([
            ...Object.keys(protectedSnapshot).map((entry) => normalizePath(entry)).filter(Boolean),
            ...protectedRoots.filter((entry) => isWorkflowConfigControlPlanePath(entry))
        ])]
            .filter((entry) => isWorkflowConfigControlPlanePath(entry))
            .sort();
    } catch {
        return [];
    }
}

function readChangedWorkflowConfigProtectedManifestFiles(
    repoRoot: string,
    gitChangedFiles: readonly string[],
    gitIgnoredFiles: ReadonlySet<string>
): string[] {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    if (!fs.existsSync(manifestPath)) {
        return [];
    }
    try {
        const gitChangedFileSet = new Set(gitChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean));
        const requireCurrentWorkspaceSignal = repoHasGitMetadata(repoRoot);
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        const protectedSnapshot = parsed.protected_snapshot
            && typeof parsed.protected_snapshot === 'object'
            && !Array.isArray(parsed.protected_snapshot)
            ? parsed.protected_snapshot as Record<string, unknown>
            : {};
        const protectedRoots = Array.isArray(parsed.protected_roots)
            ? parsed.protected_roots.map((entry) => normalizePath(entry)).filter(Boolean)
            : [];
        const workflowConfigCandidates = [...new Set([
            ...Object.keys(protectedSnapshot).map((entry) => normalizePath(entry)).filter(Boolean),
            ...protectedRoots.filter((entry) => isWorkflowConfigControlPlanePath(entry))
        ])].sort();
        return workflowConfigCandidates
            .map((protectedPath) => ({
                protectedPath: normalizePath(protectedPath),
                expectedHash: String(protectedSnapshot[protectedPath] || '').trim().toLowerCase()
            }))
            .filter(({ protectedPath }) => protectedPath && isWorkflowConfigControlPlanePath(protectedPath))
            .filter(({ protectedPath, expectedHash }) => (
                expectedHash
                    ? String(fileSha256(path.join(repoRoot, protectedPath)) || '').trim().toLowerCase() !== expectedHash
                    : fs.existsSync(path.join(repoRoot, protectedPath))
            ))
            .filter(({ protectedPath }) => (
                !requireCurrentWorkspaceSignal
                || gitChangedFileSet.has(protectedPath)
                || gitIgnoredFiles.has(protectedPath)
            ))
            .map(({ protectedPath }) => protectedPath)
            .sort();
    } catch {
        return [];
    }
}

export function readGitIgnoredPathSet(repoRoot: string, candidatePaths: readonly string[]): ReadonlySet<string> {
    const normalizedCandidates = [...new Set(
        candidatePaths.map((entry) => normalizePath(entry)).filter(Boolean)
    )].sort();
    if (normalizedCandidates.length === 0 || !repoHasGitMetadata(repoRoot)) {
        return new Set<string>();
    }
    try {
        const result = childProcess.spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
            cwd: repoRoot,
            input: `${normalizedCandidates.join('\n')}\n`,
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true
        });
        if (result.status !== 0 || !result.stdout) {
            return new Set<string>();
        }
        return new Set(
            result.stdout
                .split(/\r?\n/u)
                .map((entry) => normalizePath(entry))
                .filter(Boolean)
        );
    } catch {
        return new Set<string>();
    }
}

function repoHasGitMetadata(repoRoot: string): boolean {
    return fs.existsSync(path.join(repoRoot, '.git'));
}

function filterGeneratedRuntimeControlPlaneArtifacts(
    changedFiles: readonly string[],
    isSourceCheckout: boolean
): string[] {
    return splitGeneratedRuntimeControlPlaneArtifacts(
        changedFiles.map((entry) => normalizePath(entry)).filter(Boolean),
        { isSourceCheckout }
    ).reviewableFiles.sort();
}

export function filterProtectedRestartScopeGeneratedRuntimeArtifacts(
    repoRoot: string,
    changedFiles: readonly string[]
): string[] {
    return filterGeneratedRuntimeControlPlaneArtifacts(changedFiles, isOrchestratorSourceCheckout(repoRoot));
}

function selectCurrentScopeManifestChangedFiles(
    gitChangedFiles: readonly string[],
    manifestChangedFiles: readonly string[]
): string[] {
    const gitChangedFileSet = new Set(gitChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean));
    return [...new Set(
        manifestChangedFiles
            .map((entry) => normalizePath(entry))
            .filter((entry) => gitChangedFileSet.has(entry))
    )].sort();
}

function selectCurrentScopeWorkflowConfigManifestFiles(
    repoRoot: string,
    gitChangedFiles: readonly string[],
    manifestChangedFiles: readonly string[],
    gitIgnoredFiles: ReadonlySet<string>
): string[] {
    const gitChangedFileSet = new Set(gitChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean));
    return [...new Set(
        manifestChangedFiles
            .map((entry) => normalizePath(entry))
            .filter((entry) => isWorkflowConfigControlPlanePath(entry))
            .filter((entry) => !repoHasGitMetadata(repoRoot) || gitChangedFileSet.has(entry) || gitIgnoredFiles.has(entry))
    )].sort();
}

export function readCurrentProtectedScopeBeforePreflight(
    repoRoot: string,
    workspaceSnapshot: CurrentGitWorkspaceSnapshotLike | null,
    readWorkspaceSnapshot: () => CurrentGitWorkspaceSnapshotLike | null,
    taskMode: Record<string, unknown> | null = null
): CurrentProtectedScope | null {
    const snapshot = workspaceSnapshot ?? readWorkspaceSnapshot();
    const protectedRoots = getProtectedControlPlaneRoots(repoRoot);
    const isSourceCheckout = isOrchestratorSourceCheckout(repoRoot);
    const gitChangedFiles = snapshot
        ? snapshot.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const gitProtectedFiles = gitChangedFiles.filter((entry) => testPathPrefix(entry, protectedRoots));
    const protectedManifestEvidence = gitProtectedFiles.length > 0
        ? evaluateProtectedControlPlaneManifest(repoRoot, null, true)
        : null;
    const fullManifestChangedProtectedFiles = protectedManifestEvidence?.status === 'DRIFT'
        ? protectedManifestEvidence.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const workflowConfigManifestCandidates = fullManifestChangedProtectedFiles
        .filter((entry) => isWorkflowConfigControlPlanePath(entry));
    const standaloneWorkflowConfigCandidates = gitProtectedFiles.length === 0
        ? readWorkflowConfigProtectedManifestCandidates(repoRoot)
        : [];
    const gitIgnoredFiles = readGitIgnoredPathSet(repoRoot, [
        ...workflowConfigManifestCandidates,
        ...standaloneWorkflowConfigCandidates
    ]);
    const manifestChangedProtectedFiles = gitProtectedFiles.length > 0
        ? [
            ...selectCurrentScopeManifestChangedFiles(gitChangedFiles, fullManifestChangedProtectedFiles),
            ...selectCurrentScopeWorkflowConfigManifestFiles(
                repoRoot,
                gitChangedFiles,
                fullManifestChangedProtectedFiles,
                gitIgnoredFiles
            )
        ]
        : readChangedWorkflowConfigProtectedManifestFiles(repoRoot, gitChangedFiles, gitIgnoredFiles);
    const changedFiles = filterGeneratedRuntimeControlPlaneArtifacts([
        ...gitChangedFiles,
        ...manifestChangedProtectedFiles
    ], isSourceCheckout);
    if (changedFiles.length === 0) {
        return null;
    }
    const protectedFiles = filterGeneratedRuntimeControlPlaneArtifacts([
        ...gitProtectedFiles,
        ...manifestChangedProtectedFiles.filter((entry) => testPathPrefix(entry, protectedRoots))
    ], isSourceCheckout);
    if (protectedFiles.length === 0) {
        return null;
    }
    return excludeAuditedLifecycleWorkflowFiles(repoRoot, excludeUnchangedTaskModeBaselineFiles(repoRoot, {
        changedFiles,
        protectedFiles,
        workflowConfigFiles: protectedFiles.filter((entry) => isWorkflowConfigControlPlanePath(entry))
    }, taskMode), taskMode);
}
