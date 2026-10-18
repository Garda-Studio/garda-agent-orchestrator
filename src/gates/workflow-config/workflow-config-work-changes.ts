import {
    getWorkspaceSnapshotCached,
    resolveWorkspaceSnapshotRequest,
    type WorkspaceSnapshotRequest
} from '../workspace/workspace-snapshot-cache';
import { isWorkflowConfigControlPlanePathShape } from '../shared/helpers';
import { getAuditedWorkflowConfigChangeProvenance } from './workflow-config-work-audit';
import { readProtectedManifestWorkflowConfigHashes } from './workflow-config-work-baseline';
import type {
    CurrentWorkflowConfigChanges,
    WorkflowConfigWorkEvidence
} from './workflow-config-work-contracts';
import {
    getCurrentWorkflowConfigFileHashes,
    getWorkflowConfigChangedFiles
} from './workflow-config-work-paths';

function getWorkflowConfigChangedFilesFromBaseline(
    currentFileHashes: Record<string, string | null>,
    baselineFileHashes: Record<string, string | null> | null | undefined
): string[] {
    if (!baselineFileHashes || Object.keys(baselineFileHashes).length === 0) {
        return [];
    }
    const changedFiles: string[] = [];
    const allPaths = new Set([...Object.keys(baselineFileHashes), ...Object.keys(currentFileHashes)]);
    for (const relativePath of allPaths) {
        const baselineHash = Object.prototype.hasOwnProperty.call(baselineFileHashes, relativePath)
            ? baselineFileHashes[relativePath]
            : null;
        if (
            isWorkflowConfigControlPlanePathShape(relativePath)
            && baselineHash !== currentFileHashes[relativePath]
        ) {
            changedFiles.push(relativePath);
        }
    }
    return changedFiles.sort();
}

function hasWorkflowConfigHashEvidence(value: Record<string, string | null> | null | undefined): boolean {
    return !!value
        && Object.keys(value).some((relativePath) => isWorkflowConfigControlPlanePathShape(relativePath));
}

function hasPresentWorkflowConfigHashEvidence(value: Record<string, string | null> | null | undefined): boolean {
    return !!value
        && Object.entries(value).some(([relativePath, hash]) => (
            isWorkflowConfigControlPlanePathShape(relativePath)
            && typeof hash === 'string'
            && hash.length > 0
        ));
}

export function getCurrentWorkflowConfigChanges(
    repoRoot: string,
    baselineFileHashes?: Record<string, string | null> | null,
    options: {
        allowProtectedManifestFallback?: boolean;
        workspaceSnapshotRequest?: WorkspaceSnapshotRequest;
    } = {}
): CurrentWorkflowConfigChanges {
    const authenticatedWorkspaceSnapshotRequest = options.workspaceSnapshotRequest
        ? resolveWorkspaceSnapshotRequest(repoRoot, options.workspaceSnapshotRequest)
        : undefined;
    const currentFileHashes = getCurrentWorkflowConfigFileHashes(repoRoot);
    const workflowConfigControlPlanePaths = [
        ...new Set([
            ...Object.keys(currentFileHashes),
            ...Object.keys(baselineFileHashes || {})
        ])
    ];
    let effectiveBaselineFileHashes = hasWorkflowConfigHashEvidence(baselineFileHashes)
        ? baselineFileHashes || null
        : null;
    let baselineSource: CurrentWorkflowConfigChanges['baseline_source'] = effectiveBaselineFileHashes
        ? 'task_mode'
        : null;
    if (!effectiveBaselineFileHashes && options.allowProtectedManifestFallback !== false) {
        const manifestState = readProtectedManifestWorkflowConfigHashes(repoRoot, workflowConfigControlPlanePaths);
        if (manifestState.status === 'present' && hasWorkflowConfigHashEvidence(manifestState.hashes)) {
            effectiveBaselineFileHashes = manifestState.hashes;
            baselineSource = 'protected_manifest';
        }
    }
    const baselineChangedFiles = getWorkflowConfigChangedFilesFromBaseline(currentFileHashes, effectiveBaselineFileHashes);
    const hasBaselineFileHashes = !!effectiveBaselineFileHashes && Object.keys(effectiveBaselineFileHashes).length > 0;
    try {
        const snapshot = authenticatedWorkspaceSnapshotRequest
            ? authenticatedWorkspaceSnapshotRequest.read('git_auto', true, [])
            : getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, [], { noCache: true });
        return {
            changed_files: getWorkflowConfigChangedFiles([
                ...(hasBaselineFileHashes ? [] : snapshot.changed_files),
                ...baselineChangedFiles
            ], workflowConfigControlPlanePaths),
            current_file_hashes: currentFileHashes,
            baseline_file_hashes: effectiveBaselineFileHashes,
            baseline_source: baselineSource,
            scan_error: null
        };
    } catch (error: unknown) {
        return {
            changed_files: getWorkflowConfigChangedFiles(
                baselineChangedFiles,
                workflowConfigControlPlanePaths
            ),
            current_file_hashes: currentFileHashes,
            baseline_file_hashes: effectiveBaselineFileHashes,
            baseline_source: baselineSource,
            scan_error: error instanceof Error ? error.message : String(error)
        };
    }
}

export function getWorkflowConfigWorkViolations(options: {
    repoRoot?: string | null;
    changedFiles: readonly string[];
    taskModeEvidence: WorkflowConfigWorkEvidence;
    phaseLabel: string;
    baselineFileHashes?: Record<string, string | null> | null;
    currentFileHashes?: Record<string, string | null> | null;
}): string[] {
    const workflowConfigPathFilter = options.baselineFileHashes || options.currentFileHashes
        ? [
            ...Object.keys(options.baselineFileHashes || {}),
            ...Object.keys(options.currentFileHashes || {})
        ]
        : null;
    const changedWorkflowConfigFiles = getWorkflowConfigChangedFiles(options.changedFiles, workflowConfigPathFilter);
    if (
        !hasWorkflowConfigHashEvidence(options.baselineFileHashes)
        && hasPresentWorkflowConfigHashEvidence(options.currentFileHashes)
    ) {
        return [
            `Workflow config baseline hashes are missing before ${options.phaseLabel}. ` +
            'Re-enter task mode so workflow_config_file_hashes are captured before guarded workflow-config checks continue.'
        ];
    }

    if (changedWorkflowConfigFiles.length === 0) {
        return [];
    }

    if (options.repoRoot && options.currentFileHashes) {
        const provenance = getAuditedWorkflowConfigChangeProvenance({
            repoRoot: options.repoRoot,
            changedFiles: changedWorkflowConfigFiles,
            currentFileHashes: options.currentFileHashes,
            baselineFileHashes: options.baselineFileHashes,
            taskId: options.taskModeEvidence.task_id
        });
        if (provenance.accepted) {
            return [];
        }
    }

    if (
        options.taskModeEvidence.workflow_config_work === true
        && options.taskModeEvidence.orchestrator_work !== true
    ) {
        return [
            `Workflow config files changed before ${options.phaseLabel} with inconsistent task-mode evidence: ` +
            `--workflow-config-work requires --orchestrator-work: ${changedWorkflowConfigFiles.join(', ')}. ` +
            'Re-enter task mode with --orchestrator-work --workflow-config-work --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" after explicit operator approval.'
        ];
    }

    if (
        options.taskModeEvidence.orchestrator_work === true
        && options.taskModeEvidence.workflow_config_work === true
    ) {
        return [];
    }

    if (options.taskModeEvidence.workflow_config_work === true) {
        return [
            `Workflow config files changed before ${options.phaseLabel} with --workflow-config-work but without --orchestrator-work: ` +
            `${changedWorkflowConfigFiles.join(', ')}. Re-enter task mode with --orchestrator-work --workflow-config-work --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" after explicit operator approval.`
        ];
    }

    const flagHint = options.taskModeEvidence.orchestrator_work === true
        ? '--workflow-config-work'
        : '--orchestrator-work --workflow-config-work';
    return [
        `Workflow config files changed before ${options.phaseLabel} without task-mode ${flagHint}: ${changedWorkflowConfigFiles.join(', ')}. ` +
        `Re-enter task mode with ${flagHint} --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" only after explicit operator approval for tasks that intentionally change workflow-config.json; workflow set audit logs do not grant task-mode permission.`
    ];
}
