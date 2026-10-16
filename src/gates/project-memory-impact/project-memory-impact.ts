import * as path from 'node:path';
import { resolveBundleNameForTarget } from '../../core/constants';
import {
    resolveLiveProjectMemoryDir,
    resolveTemplateProjectMemoryDir
} from '../../core/project-memory';
import { validateProjectMemoryBootstrap } from '../../validators/project-memory';
import { normalizePath } from '../shared/helpers';
import { toRepoPath, uniqueSorted } from './project-memory-impact-common';
import {
    buildProjectMemoryVisibleSummary,
    compareImpactArtifactToExpected,
    readImpactArtifact,
    resolveLifecycleCompactStatus
} from './project-memory-impact-artifacts';
import {
    buildAffectedMemoryPaths,
    buildImpactFingerprint,
    readCompactState,
    readPreflightChangedFiles,
    routeProjectMemoryImpact as routeProjectMemoryImpactInternal
} from './project-memory-impact-routing';
import {
    normalizeMaintenanceMode,
    resolveProjectMemoryRuntime
} from './project-memory-impact-runtime';
import {
    buildUpdateEvidence,
    readUpdateEvidence,
    validateExistingUpdateEvidence
} from './project-memory-impact-update-evidence';
import { buildProjectMemoryImpactNextStep } from './project-memory-impact-next-step';
import type {
    ProjectMemoryImpactArtifact,
    ProjectMemoryImpactEvidenceStatus,
    ProjectMemoryImpactLifecycleEvidence,
    ProjectMemoryImpactOptions,
    ProjectMemoryImpactStatus,
    ProjectMemoryUpdateEvidence
} from './project-memory-impact-types';

export {
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    PROJECT_MEMORY_IMPACT_BLOCKED_EVENT
} from './project-memory-impact-types';
export type {
    ProjectMemoryChangedFilesSource,
    ProjectMemoryImpactArtifact,
    ProjectMemoryImpactEvidenceStatus,
    ProjectMemoryImpactLifecycleEvidence,
    ProjectMemoryImpactOptions,
    ProjectMemoryImpactReason,
    ProjectMemoryImpactStatus,
    ProjectMemoryUpdateEvidence,
    ProjectMemoryUpdateEvidenceStatus
} from './project-memory-impact-types';
export { routeProjectMemoryImpact } from './project-memory-impact-routing';

export function getProjectMemoryImpactLifecycleEvidence(input: {
    repoRoot: string;
    taskId: string;
    preflightPath?: string | null;
    changedFiles?: string[];
    artifactPath?: string | null;
    updateArtifactPath?: string | null;
}): ProjectMemoryImpactLifecycleEvidence {
    const runtime = resolveProjectMemoryRuntime(input.repoRoot, input.taskId, input);
    if (!runtime.required) {
        const status = runtime.mode === 'off' ? 'OFF' : null;
        return {
            required: false,
            enabled: runtime.mode !== 'off',
            mode: runtime.mode,
            configured_mode: runtime.configuredMode,
            run_before_final_closeout: runtime.config.run_before_final_closeout,
            artifact_path: normalizePath(runtime.artifactPath),
            update_artifact_path: normalizePath(runtime.updateArtifactPath),
            status,
            outcome: status === 'OFF' ? 'PASS' : null,
            evidence_status: 'NOT_REQUIRED',
            update_needed: false,
            affected_memory_files: [],
            updated_memory_files: [],
            compact_status: null,
            compact_refreshed: null,
            visible_summary_line: buildProjectMemoryVisibleSummary({
                required: false,
                enabled: runtime.mode !== 'off',
                mode: runtime.mode,
                evidenceStatus: 'NOT_REQUIRED',
                status,
                updateNeeded: false,
                updatedMemoryFiles: [],
                compactStatus: null,
                compactRefreshed: null
            }),
            violations: []
        };
    }

    const expected = assessProjectMemoryImpact({
        repoRoot: runtime.repoRoot,
        taskId: runtime.taskId,
        preflightPath: runtime.preflightPath,
        changedFiles: input.changedFiles,
        artifactPath: runtime.artifactPath,
        updateArtifactPath: runtime.updateArtifactPath
    }).artifact;
    const actualResult = readImpactArtifact(runtime.artifactPath);
    const actual = actualResult.artifact;
    if (!actual) {
        const evidenceStatus: ProjectMemoryImpactEvidenceStatus = actualResult.exists ? 'INVALID' : 'MISSING';
        const violations = actualResult.exists
            ? actualResult.invalidReasons
            : [`Project memory impact artifact is missing: ${normalizePath(runtime.artifactPath)}.`];
        return {
            required: true,
            enabled: true,
            mode: runtime.mode,
            configured_mode: runtime.configuredMode,
            run_before_final_closeout: runtime.config.run_before_final_closeout,
            artifact_path: normalizePath(runtime.artifactPath),
            update_artifact_path: normalizePath(runtime.updateArtifactPath),
            status: null,
            outcome: null,
            evidence_status: evidenceStatus,
            update_needed: expected.update_needed,
            affected_memory_files: expected.affected_memory_files,
            updated_memory_files: expected.update_evidence.updated_memory_files,
            compact_status: expected.compact.status,
            compact_refreshed: null,
            visible_summary_line: buildProjectMemoryVisibleSummary({
                required: true,
                enabled: true,
                mode: runtime.mode,
                evidenceStatus,
                status: null,
                updateNeeded: expected.update_needed,
                updatedMemoryFiles: expected.update_evidence.updated_memory_files,
                compactStatus: expected.compact.status,
                compactRefreshed: null
            }),
            violations
        };
    }

    const violations = compareImpactArtifactToExpected(actual, expected);
    const evidenceStatus: ProjectMemoryImpactEvidenceStatus = violations.length > 0
        ? 'STALE'
        : actual.status === 'BLOCKED'
            ? 'BLOCKED'
            : actual.outcome === 'PASS'
                ? 'CURRENT'
                : 'INVALID';
    const compactRefreshed = actual.update_evidence.status === 'NOT_REQUIRED'
        ? null
        : readUpdateEvidence(runtime.updateArtifactPath)?.compact_refreshed ?? null;
    const lifecycleCompactStatus = resolveLifecycleCompactStatus({
        compactStatus: actual.compact.status,
        impactStatus: actual.status,
        evidenceStatus,
        compactRefreshed
    });
    return {
        required: true,
        enabled: true,
        mode: actual.mode,
        configured_mode: actual.configured_mode,
        run_before_final_closeout: runtime.config.run_before_final_closeout,
        artifact_path: normalizePath(runtime.artifactPath),
        update_artifact_path: normalizePath(runtime.updateArtifactPath),
        status: actual.status,
        outcome: actual.outcome,
        evidence_status: evidenceStatus,
        update_needed: actual.update_needed,
        affected_memory_files: actual.affected_memory_files,
        updated_memory_files: actual.update_evidence.updated_memory_files,
        compact_status: lifecycleCompactStatus,
        compact_refreshed: compactRefreshed,
        visible_summary_line: buildProjectMemoryVisibleSummary({
            required: true,
            enabled: true,
            mode: actual.mode,
            evidenceStatus,
            status: actual.status,
            updateNeeded: actual.update_needed,
            updatedMemoryFiles: actual.update_evidence.updated_memory_files,
            compactStatus: lifecycleCompactStatus,
            compactRefreshed
        }),
        violations
    };
}

export function assessProjectMemoryImpact(options: ProjectMemoryImpactOptions): {
    artifact: ProjectMemoryImpactArtifact;
    updateEvidenceToWrite: ProjectMemoryUpdateEvidence | null;
    artifactPath: string;
    updateArtifactPath: string;
} {
    const runtime = resolveProjectMemoryRuntime(options.repoRoot, options.taskId, options);
    const repoRoot = runtime.repoRoot;
    const taskId = runtime.taskId;
    const bundleName = resolveBundleNameForTarget(repoRoot);
    const configured = runtime.config;
    const configuredMode = runtime.configuredMode;
    const mode = options.modeOverride
        ? normalizeMaintenanceMode(options.modeOverride, configuredMode)
        : runtime.mode;
    const liveMemoryDir = resolveLiveProjectMemoryDir(runtime.bundleRoot);
    const templateMemoryDir = resolveTemplateProjectMemoryDir(runtime.bundleRoot);
    const preflight = readPreflightChangedFiles(runtime.preflightPath);
    const explicitChangedFilesProvided = Array.isArray(options.changedFiles);
    const changedFiles = uniqueSorted(explicitChangedFilesProvided
        ? (options.changedFiles || []).map(toRepoPath)
        : preflight.changedFiles.map(toRepoPath));
    const routed = routeProjectMemoryImpactInternal(changedFiles);
    const affectedMemoryFileNames = routed.affectedFileNames;
    const affectedMemoryFiles = buildAffectedMemoryPaths(bundleName, affectedMemoryFileNames);
    const validationMode = mode === 'strict' ? 'strict' : 'check';
    const validation = validateProjectMemoryBootstrap(liveMemoryDir, {
        mode: validationMode,
        templateProjectMemoryDir: templateMemoryDir,
        maxCompactSummaryChars: configured.max_compact_summary_chars
    });
    const compact = readCompactState(liveMemoryDir, configured.max_compact_summary_chars);
    const impactFingerprint = buildImpactFingerprint({
        taskId,
        preflightHash: preflight.preflightHash,
        changedFiles,
        affectedMemoryFiles,
        reasons: routed.reasons
    });
    const updateNeeded = affectedMemoryFiles.length > 0;
    let updateEvidence: ProjectMemoryImpactArtifact['update_evidence'] = updateNeeded
        ? validateExistingUpdateEvidence({
            repoRoot,
            updateArtifactPath: runtime.updateArtifactPath,
            impactFingerprint,
            affectedMemoryFiles
        })
        : {
            status: 'NOT_REQUIRED',
            path: normalizePath(runtime.updateArtifactPath),
            updated_memory_files: [],
            skipped_memory_files: [],
            missing_updated_memory_files: [],
            invalid_reasons: []
        };
    let updateEvidenceToWrite: ProjectMemoryUpdateEvidence | null = null;
    const violations: string[] = [];

    if (options.confirmUpdated === true && updateNeeded) {
        const previousImpact = readImpactArtifact(runtime.artifactPath).artifact;
        const previousCompactSha256 = previousImpact?.impact_fingerprint_sha256 === impactFingerprint
            ? previousImpact.compact.sha256
            : null;
        const built = buildUpdateEvidence({
            repoRoot,
            bundleRoot: runtime.bundleRoot,
            taskId,
            impactFingerprint,
            affectedMemoryFiles,
            updatedMemoryFiles: options.updatedMemoryFiles || [],
            skippedMemoryFiles: options.skippedMemoryFiles || [],
            skipUnchangedCandidatesRationale: options.skipUnchangedCandidatesRationale || null,
            compactSha256: compact.sha256,
            previousCompactSha256
        });
        updateEvidenceToWrite = built.violations.length === 0 ? built.evidence : null;
        updateEvidence = {
            ...built.updateEvidence,
            path: normalizePath(runtime.updateArtifactPath)
        };
        violations.push(...built.violations);
    }

    if (mode !== 'off' && !explicitChangedFilesProvided && !preflight.readable) {
        violations.push(preflight.invalidReason || 'Preflight artifact could not be read.');
    }

    let status: ProjectMemoryImpactStatus;
    if (mode === 'off') {
        status = 'OFF';
    } else if (violations.length > 0) {
        status = 'BLOCKED';
    } else if (updateEvidence.status === 'VALID' && updateNeeded) {
        status = 'UPDATED';
    } else if (updateNeeded) {
        status = mode === 'strict' || mode === 'update' ? 'BLOCKED' : 'UPDATE_NEEDED';
        if (mode === 'strict' || mode === 'update') {
            violations.push(...updateEvidence.invalid_reasons);
        }
    } else {
        status = 'NO_UPDATE_NEEDED';
    }

    const artifact: ProjectMemoryImpactArtifact = {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        task_id: taskId,
        mode,
        configured_mode: configuredMode,
        enabled: mode !== 'off',
        status,
        outcome: status === 'BLOCKED' ? 'FAIL' : 'PASS',
        update_needed: status === 'UPDATE_NEEDED' || status === 'BLOCKED',
        writes_allowed: false,
        require_user_approval_for_writes: configured.require_user_approval_for_writes,
        changed_files_source: explicitChangedFilesProvided ? 'explicit' : 'preflight',
        preflight_path: runtime.preflightPath ? normalizePath(runtime.preflightPath) : null,
        preflight_hash_sha256: preflight.preflightHash,
        changed_files: changedFiles,
        affected_memory_files: affectedMemoryFiles,
        affected_memory_file_names: affectedMemoryFileNames,
        reasons: routed.reasons,
        validation,
        compact,
        update_evidence: updateEvidence,
        impact_fingerprint_sha256: impactFingerprint,
        next_step: buildProjectMemoryImpactNextStep(status, affectedMemoryFiles),
        violations
    };

    return {
        artifact,
        updateEvidenceToWrite,
        artifactPath: path.resolve(runtime.artifactPath),
        updateArtifactPath: path.resolve(runtime.updateArtifactPath)
    };
}
