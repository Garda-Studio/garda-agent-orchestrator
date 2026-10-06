import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    normalizeDomainScopeFingerprints,
    type DomainScopeFingerprintEntry,
    type DomainScopeFingerprints
} from '../scope/domain-scope-fingerprints';
import {
    fileSha256,
    normalizePath,
    joinOrchestratorPath,
    resolvePathInsideRepo,
    isPathRealpathInsideRoot
} from '../shared/helpers';
import {
    getWorkspaceSnapshotCached,
    resolveWorkspaceSnapshotRequest,
    type WorkspaceSnapshotRequest
} from '../workspace/workspace-snapshot-cache';
import {
    normalizeWorkspaceRelativePath,
    normalizeWorkspaceRelativePaths
} from '../workspace/dirty-worktree-protection';
import {
    isSourceCheckoutGeneratedRuntimeArtifactPath
} from '../shared/generated-runtime-artifacts';
import {
    isWorkflowConfigControlPlanePath,
    isOrchestratorSourceCheckout
} from '../protected-control-plane/protected-control-plane';
import {
    mergeTaskOwnedMetadataRefreshFiles
} from './next-step-task-owned-metadata';
import {
    isDependencyManifestLockfileRelatedToAny
} from '../scope/dependency-manifest-lockfile-scope';
import {
    buildScopeContentFingerprint
} from '../compile/compile-gate';
import {
    normalizeGitChangeClassificationEvidence
} from '../../core/git-change-classification';
import {
    buildDocsOnlyDeltaReadiness,
    describePathList,
    getDocImpactDeclaredDocsUpdated,
    readCurrentGitWorkspaceSnapshot,
    stringSha256
} from '../scope/docs-only-delta-readiness';
import {
    buildCurrentDomainScopeFingerprints,
    onlyNeutralCloseoutDomainChanged
} from './next-step-readiness-domain-scope';
import {
    readGitIgnoredPathSet
} from './next-step-protected-scope';
import { isPlainRecord } from '../../core/records';
import { assertValidTaskId, inspectTaskEventFile, readTaskTimelineJsonlEntries, type TaskTimelineJsonlEntry } from '../../gate-runtime/task-events';
import { getCurrentNoOpEventSha256, getNoOpEvidence } from '../task-mode/no-op';
import { getTaskModeEvidence } from '../task-mode/task-mode-evidence';
import { getAuditedWorkflowConfigChangeProvenance } from '../workflow-config/workflow-config-work-audit';
import { normalizeWorkflowConfigSha256 } from '../workflow-config/workflow-config-work-paths';

function isCanonicalZeroDiffNoOpPreflight(preflight: Record<string, unknown>): boolean {
    const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
    const guard = isPlainRecord(preflight.zero_diff_guard) ? preflight.zero_diff_guard : {};
    return Array.isArray(preflight.changed_files) && preflight.changed_files.length === 0
        && metrics.changed_lines_total === 0
        && Array.isArray(metrics.actual_changed_files) && metrics.actual_changed_files.length === 0
        && guard.zero_diff_detected === true && guard.completion_requires_audited_no_op === true;
}

function hasCommandOnlyConfigAuditChain(options: {
    repoRoot: string;
    taskId: string;
    relativePath: string;
    baselineHash: string | null;
    preflightHash: string | null;
    taskCycleEntries: readonly TaskTimelineJsonlEntry[];
    taskEntryHash: string;
}): boolean {
    const currentHash = fileSha256(path.resolve(options.repoRoot, options.relativePath));
    if (!options.baselineHash || !currentHash || currentHash !== options.preflightHash) return false;
    const provenance = getAuditedWorkflowConfigChangeProvenance({
        repoRoot: options.repoRoot, taskId: options.taskId, changedFiles: [options.relativePath],
        currentFileHashes: { [options.relativePath]: currentHash }
    });
    if (!provenance.accepted) return false;
    const auditPath = provenance.records[0].audit_path;
    const records = new Map(fs.readFileSync(auditPath, 'utf8').split(/\r?\n/u)
        .filter((line) => line.trim()).map((line) => [stringSha256(line), JSON.parse(line) as unknown]));
    let cursor: string | null = null;
    let baselineSeen = false;
    const preparedRecords = new Set<string>();
    const boundRecords = new Set<string>();
    // Inspect the complete current cycle, including mutations that return to the baseline.
    for (const entry of options.taskCycleEntries) {
        const event = entry.record;
        const prepared = event?.event_type === 'WORKFLOW_CONFIG_MUTATION_PREPARED';
        if (!prepared && event?.event_type !== 'WORKFLOW_CONFIG_MUTATION_AUDITED') continue;
        const details = isPlainRecord(event.details) ? event.details : {};
        const boundConfigPath = resolvePathInsideRepo(String(details.config_path || ''), options.repoRoot, { enforceInside: true });
        if (!boundConfigPath || normalizeWorkspaceRelativePath(options.repoRoot,
            path.relative(options.repoRoot, boundConfigPath)) !== options.relativePath) continue;
        const recordHash = normalizeWorkflowConfigSha256(details.audit_record_sha256);
        const boundAuditPath = resolvePathInsideRepo(String(details.audit_path || ''), options.repoRoot, { enforceInside: true });
        const stageRecords = prepared ? preparedRecords : boundRecords;
        if (event?.actor !== 'workflow-config-set' || event.outcome !== (prepared ? 'INFO' : 'PASS')
            || details.task_mode_entry_sha256 !== options.taskEntryHash
            || !boundAuditPath || path.resolve(boundAuditPath) !== path.resolve(auditPath)
            || !recordHash || stageRecords.has(recordHash)
            || !prepared && !preparedRecords.has(recordHash)) return false;
        stageRecords.add(recordHash);
        const record = records.get(recordHash);
        if (!isPlainRecord(record) || record.event_source !== 'workflow-config-set') return false;
        const auditConfigPath = resolvePathInsideRepo(String(record.config_path || ''), options.repoRoot, {
            enforceInside: true
        });
        if (!auditConfigPath || normalizeWorkspaceRelativePath(options.repoRoot,
            path.relative(options.repoRoot, auditConfigPath)) !== options.relativePath) return false;
        if (!Array.isArray(record.changed_fields) || record.changed_fields.length !== 1
            || record.changed_fields[0] !== 'full_suite_validation.command'
            || record.command_only_change !== true
            || !['cli', 'local-ui'].includes(String(record.mutation_source || 'cli'))
            || !Array.isArray(record.active_task_ids)
            || !record.active_task_ids.includes(options.taskId)
            || !Number.isFinite(Date.parse(String(record.timestamp_utc || '')))) return false;
    }
    if (preparedRecords.size !== boundRecords.size) return false;
    // Audit publication holds the workflow lock; event publication may interleave after commit.
    for (const [recordHash, record] of records) {
        if (!boundRecords.has(recordHash) || !isPlainRecord(record)) continue;
        const beforeHash = normalizeWorkflowConfigSha256(record.before_sha256);
        const afterHash = normalizeWorkflowConfigSha256(record.after_sha256);
        if (!beforeHash || !afterHash || (cursor !== null && beforeHash !== cursor)) return false;
        baselineSeen ||= beforeHash === options.baselineHash || afterHash === options.baselineHash;
        cursor = afterHash;
    }
    return baselineSeen && cursor === currentHash;
}

function getCurrentAuditTaskMode(repoRoot: string, taskId: string) {
    let taskMode = getTaskModeEvidence(repoRoot, taskId);
    if (taskMode.evidence_status !== 'PASS' && taskMode.timeline_artifact_path) {
        taskMode = getTaskModeEvidence(repoRoot, taskId, taskMode.timeline_artifact_path);
    }
    return taskMode;
}

function canCloseAuthenticatedNoOpBesideProtectedBaseline(
    repoRoot: string,
    preflight: Record<string, unknown>,
    protectedBaselineFiles: readonly string[],
    changedWorkflowConfigFiles: readonly string[]
): boolean {
    if (!isCanonicalZeroDiffNoOpPreflight(preflight)) return false;
    try {
        const taskId = assertValidTaskId(String(preflight.task_id || ''));
        const evidence = getNoOpEvidence(repoRoot, taskId);
        const preflightPath = resolvePathInsideRepo(evidence.preflight_path || '', repoRoot);
        const reviewsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
        if (!preflightPath || !isPathRealpathInsideRoot(preflightPath, reviewsRoot)
            || JSON.stringify(JSON.parse(fs.readFileSync(preflightPath, 'utf8'))) !== JSON.stringify(preflight)) return false;
        const boundEvidence = getNoOpEvidence(repoRoot, taskId, '', preflightPath);
        const timelinePath = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
        const integrity = inspectTaskEventFile(timelinePath, taskId);
        if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(integrity.status)
            || !getCurrentNoOpEventSha256(repoRoot, taskId, boundEvidence)) return false;
        const taskMode = getCurrentAuditTaskMode(repoRoot, taskId);
        if (taskMode.evidence_status !== 'PASS') return false;
        const entries = readTaskTimelineJsonlEntries(timelinePath);
        let taskEntryIndex = entries.length - 1;
        while (taskEntryIndex >= 0 && entries[taskEntryIndex].record?.event_type !== 'TASK_MODE_ENTERED') taskEntryIndex -= 1;
        if (taskEntryIndex < 0 || entries[taskEntryIndex].record?.outcome !== 'PASS') return false;
        const taskEntryHash = stringSha256(entries[taskEntryIndex].rawLine.trim());
        const baselineHashes = taskMode.dirty_workspace_baseline?.file_hashes || {};
        const triggers = getPreflightTriggers(preflight);
        const protectedHashes = isPlainRecord(triggers.dirty_workspace_protected_file_hashes)
            ? triggers.dirty_workspace_protected_file_hashes : {};
        if (!protectedBaselineFiles.every((file) => (
            baselineHashes[file] && baselineHashes[file] === protectedHashes[file]
        ))) return false;
        const configHashes = getWorkflowConfigFileHashes(repoRoot, preflight);
        const snapshot = taskMode.profile_policy_snapshot;
        const snapshotConfigPath = snapshot && resolvePathInsideRepo(snapshot.resolution_sources.workflow_config,
            repoRoot, { enforceInside: true });
        return changedWorkflowConfigFiles.every((relativePath) => hasCommandOnlyConfigAuditChain({
            repoRoot, taskId, relativePath,
            baselineHash: snapshotConfigPath && normalizeWorkspaceRelativePath(repoRoot,
                path.relative(repoRoot, snapshotConfigPath)) === relativePath
                ? snapshot?.config_hashes.workflow_config || null : null,
            preflightHash: configHashes[relativePath] || null,
            taskEntryHash,
            taskCycleEntries: entries.slice(taskEntryIndex + 1)
        }));
    } catch {
        // Missing or malformed evidence cannot widen the existing protected-scope allowance.
        return false;
    }
}

function hasPreservedZeroDiffAuditWorkspace(
    repoRoot: string,
    preflight: Record<string, unknown>,
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest
): boolean {
    if (!isCanonicalZeroDiffNoOpPreflight(preflight)
        || (preflight.zero_diff_guard as Record<string, unknown>).status !== 'BASELINE_ONLY') return false;
    try {
        const taskId = assertValidTaskId(String(preflight.task_id || ''));
        const taskMode = getCurrentAuditTaskMode(repoRoot, taskId);
        const snapshot = taskMode.profile_policy_snapshot;
        if (taskMode.evidence_status !== 'PASS' || taskMode.profile_policy_snapshot_status !== 'PASS'
            || !snapshot) return false;
        const baseline = taskMode.dirty_workspace_baseline;
        const baselineFiles = normalizeWorkspaceRelativePaths(repoRoot, baseline?.changed_files || []);
        const baselineHashes = baseline?.file_hashes || {};
        const triggers = getPreflightTriggers(preflight);
        const protectedHashes = isPlainRecord(triggers.dirty_workspace_protected_file_hashes)
            ? triggers.dirty_workspace_protected_file_hashes : {};
        if (baselineFiles.length !== (baseline?.changed_files.length || 0)
            || !baselineFiles.every((file) => baselineHashes[file]
                && baselineHashes[file] === protectedHashes[file]
                && isPathRealpathInsideRoot(path.resolve(repoRoot, file), repoRoot)
                && fileSha256(path.resolve(repoRoot, file)) === baselineHashes[file])) return false;

        const sourcePaths = snapshot.resolution_sources as unknown as Record<string, unknown>;
        for (const [name, expectedHash] of Object.entries(snapshot.config_hashes)) {
            if (name === 'workflow_config') continue;
            const sourcePath = sourcePaths[name];
            if (!sourcePath) {
                if (expectedHash !== null) return false;
                continue;
            }
            const source = resolvePathInsideRepo(String(sourcePath), repoRoot, {
                enforceInside: true, allowMissing: expectedHash === null
            });
            if (!source || fileSha256(source) !== expectedHash) return false;
        }
        const configPath = resolvePathInsideRepo(snapshot.resolution_sources.workflow_config,
            repoRoot, { enforceInside: true });
        if (!configPath) return false;
        const configFile = normalizeWorkspaceRelativePath(repoRoot, path.relative(repoRoot, configPath));
        if (!configFile) return false;
        const configHash = fileSha256(configPath);
        if (!configHash || getWorkflowConfigFileHashes(repoRoot, preflight)[configFile] !== configHash) return false;
        const timelinePath = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
        if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspectTaskEventFile(timelinePath, taskId).status)) return false;
        const entries = readTaskTimelineJsonlEntries(timelinePath);
        let entryIndex = entries.length - 1;
        while (entryIndex >= 0 && entries[entryIndex].record?.event_type !== 'TASK_MODE_ENTERED') entryIndex -= 1;
        if (entryIndex < 0 || entries[entryIndex].record?.outcome !== 'PASS') return false;
        const cycleEntries = entries.slice(entryIndex + 1);
        const mutations = cycleEntries.filter((entry) => (
            entry.record?.event_type === 'WORKFLOW_CONFIG_MUTATION_PREPARED'
                || entry.record?.event_type === 'WORKFLOW_CONFIG_MUTATION_AUDITED'
        ));
        if (mutations.some((entry) => {
            const record = entry.record;
            const details = record && isPlainRecord(record.details) ? record.details : {};
            return resolvePathInsideRepo(String(details.config_path || ''), repoRoot, { enforceInside: true }) !== configPath;
        })) return false;
        if ((configHash !== snapshot.config_hashes.workflow_config || mutations.length > 0)
            && !hasCommandOnlyConfigAuditChain({
                repoRoot, taskId, relativePath: configFile,
                baselineHash: snapshot.config_hashes.workflow_config,
                preflightHash: configHash, taskCycleEntries: cycleEntries,
                taskEntryHash: stringSha256(entries[entryIndex].rawLine.trim())
            })) return false;
        const globalSnapshot = readCurrentGitWorkspaceSnapshot(repoRoot, true, workspaceSnapshotRequest);
        if (!globalSnapshot) return false;
        const baselineSet = new Set(baselineFiles);
        return filterSourceCheckoutGeneratedRuntimeArtifacts(repoRoot, globalSnapshot.changed_files)
            .every((file) => baselineSet.has(file) || file === configFile);
    } catch {
        return false;
    }
}

export function hasAuthenticatedZeroDiffAuditScope(
    repoRoot: string,
    preflight: Record<string, unknown>,
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest
): boolean {
    if (!hasPreservedZeroDiffAuditWorkspace(repoRoot, preflight, workspaceSnapshotRequest)) return false;
    try {
        const taskId = assertValidTaskId(String(preflight.task_id || ''));
        const canonicalPath = path.resolve(joinOrchestratorPath(repoRoot,
            path.join('runtime', 'reviews', `${taskId}-preflight.json`)));
        const noOp = getNoOpEvidence(repoRoot, taskId, '', canonicalPath);
        const boundPath = resolvePathInsideRepo(noOp.preflight_path || '', repoRoot, { enforceInside: true });
        if (noOp.classification !== 'ALREADY_DONE' || boundPath !== canonicalPath) return false;
        const taskMode = getCurrentAuditTaskMode(repoRoot, taskId);
        if (!readPreflightWorkspaceReadiness(repoRoot, preflight, {
            plannedChangedFiles: taskMode.planned_changed_files || [],
            dirtyWorkspaceBaselineChangedFiles: taskMode.dirty_workspace_baseline?.changed_files || [],
            dirtyWorkspaceBaselineFileHashes: Object.fromEntries(Object.entries(
                taskMode.dirty_workspace_baseline?.file_hashes || {}
            ).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
            allowDocsOnlyDelta: false, workspaceSnapshotRequest
        }).ready) return false;
        return canCloseAuthenticatedNoOpBesideProtectedBaseline(repoRoot, preflight,
            taskMode.dirty_workspace_baseline?.changed_files || [], []);
    } catch {
        return false;
    }
}

export interface PreflightWorkspaceReadiness {
    ready: boolean;
    reason: string;
    currentChangedFiles?: string[];
    acceptedDocsOnlyDeltaFiles?: string[];
    acceptedCloseoutOnlyDeltaFiles?: string[];
    awaitingMaterializedPlannedScope?: boolean;
}

export interface PreflightWorkspaceReadinessOptions {
    failedReviewType?: string | null;
    failedReviewVerdict?: string | null;
    docImpactPath?: string | null;
    allowDocsOnlyDelta?: boolean;
    plannedChangedFiles?: string[];
    dirtyWorkspaceBaselineChangedFiles?: string[];
    dirtyWorkspaceBaselineFileHashes?: Record<string, string>;
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest;
}

function isDistRuntimeOutputRelatedToPlannedSource(changedFile: string, plannedChangedFiles: readonly string[]): boolean {
    const normalizedChangedFile = normalizePath(changedFile);
    if (!normalizedChangedFile.startsWith('dist/src/') || !normalizedChangedFile.endsWith('.js')) {
        return false;
    }
    const sourceCandidate = `src/${normalizedChangedFile.slice('dist/src/'.length).replace(/\.js$/u, '.ts')}`;
    return plannedChangedFiles.some((plannedFile) => normalizePath(plannedFile) === sourceCandidate);
}

function sameSortedStringList(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((entry, index) => entry === sortedRight[index]);
}

function isRelatedToPlannedScope(changedFile: string, plannedChangedFiles: readonly string[]): boolean {
    if (isDependencyManifestLockfileRelatedToAny(changedFile, plannedChangedFiles)) {
        return true;
    }
    if (isDistRuntimeOutputRelatedToPlannedSource(changedFile, plannedChangedFiles)) {
        return true;
    }
    const normalizedChangedFile = normalizePath(changedFile);
    const [changedTopLevel] = normalizedChangedFile.split('/');
    if (!changedTopLevel || normalizedChangedFile === changedTopLevel) {
        return false;
    }
    return plannedChangedFiles.some((plannedFile) => {
        const normalizedPlannedFile = normalizePath(plannedFile);
        const [plannedTopLevel] = normalizedPlannedFile.split('/');
        const plannedDirectory = normalizedPlannedFile.split('/').slice(1, -1).join('/');
        if (
            changedTopLevel === 'tests'
            && plannedTopLevel === 'src'
            && plannedDirectory
            && normalizedChangedFile.includes(`/${plannedDirectory}/`)
        ) {
            return true;
        }
        return Boolean(plannedTopLevel)
            && normalizedPlannedFile !== plannedTopLevel
            && plannedTopLevel === changedTopLevel;
    });
}

function filterSourceCheckoutGeneratedRuntimeArtifacts(repoRoot: string, changedFiles: readonly string[]): string[] {
    const isSourceCheckout = isOrchestratorSourceCheckout(repoRoot);
    return [...new Set(
        changedFiles
            .map((entry) => normalizePath(entry))
            .filter((entry) => entry && !isSourceCheckoutGeneratedRuntimeArtifactPath(entry, isSourceCheckout))
    )].sort();
}

export function readPreflightWorkspaceReadiness(
    repoRoot: string,
    preflight: Record<string, unknown>,
    options: PreflightWorkspaceReadinessOptions = {}
): PreflightWorkspaceReadiness {
    const authenticatedWorkspaceSnapshotRequest = options.workspaceSnapshotRequest
        ? resolveWorkspaceSnapshotRequest(repoRoot, options.workspaceSnapshotRequest)
        : undefined;
    const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
    const expectedChangedLinesTotal = typeof metrics.changed_lines_total === 'number'
        ? metrics.changed_lines_total
        : Number(metrics.changed_lines_total);
    if (!Number.isFinite(expectedChangedLinesTotal) || expectedChangedLinesTotal < 0) {
        return {
            ready: true,
            reason: 'Preflight workspace freshness cannot be checked because metrics.changed_lines_total is missing.'
        };
    }

    const detectionSource = String(preflight.detection_source || 'git_auto').trim() || 'git_auto';
    const normalizedDetectionSource = detectionSource.toLowerCase();
    if (normalizedDetectionSource === 'git_staged_only'
        && getPreflightTriggers(preflight).zero_diff_review_policy_refresh_allowed === true
        && isCanonicalZeroDiffNoOpPreflight(preflight)
        && !hasPreservedZeroDiffAuditWorkspace(repoRoot, preflight, options.workspaceSnapshotRequest)) {
        return {
            ready: false,
            reason: 'Staged zero-diff audit no longer matches the unchanged parent baseline, global workspace or authenticated frozen settings.'
        };
    }
    const includeUntracked = normalizedDetectionSource === 'git_staged_only'
        ? false
        : (typeof preflight.include_untracked === 'boolean' ? preflight.include_untracked : true);
    const changedFiles = Array.isArray(preflight.changed_files)
        ? [...new Set(preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    const authorizedFiles = Array.isArray(preflight.authorized_files)
        ? [...new Set(preflight.authorized_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : changedFiles;
    const plannedChangedFiles = Array.isArray(options.plannedChangedFiles)
        ? filterSourceCheckoutGeneratedRuntimeArtifacts(repoRoot, options.plannedChangedFiles)
        : [];
    const dirtyWorkspaceBaselineChangedFiles = normalizeWorkspaceRelativePaths(
        repoRoot,
        options.dirtyWorkspaceBaselineChangedFiles
    );
    const dirtyWorkspaceBaselineFileHashes = options.dirtyWorkspaceBaselineFileHashes || {};
    const failedReviewType = String(options.failedReviewType || '').trim();
    const hasActualChangedFiles = Array.isArray(metrics.actual_changed_files);
    const legacyExpectedActualChangedFiles = hasActualChangedFiles
        ? [...new Set((metrics.actual_changed_files as unknown[])
            .map((entry) => normalizePath(String(entry || '')))
            .filter(Boolean))].sort()
        : changedFiles;
    const preflightGitClassification = normalizeGitChangeClassificationEvidence(
        preflight.git_change_classification
    );
    const preflightGitClassificationInvalid = preflight.git_change_classification != null
        && !preflightGitClassification;
    const expectedActualChangedFiles = preflightGitClassification
        ? preflightGitClassification.effective_changed_files
        : legacyExpectedActualChangedFiles;
    const expectedActualChangedFilesSha256 = typeof metrics.actual_changed_files_sha256 === 'string'
        ? metrics.actual_changed_files_sha256.trim().toLowerCase()
        : stringSha256(expectedActualChangedFiles.join('\n'));
    const expectedScopeContentSha256 = typeof metrics.scope_content_sha256 === 'string'
        ? metrics.scope_content_sha256.trim().toLowerCase()
        : '';
    const expectedDomainScopeFingerprints = normalizeDomainScopeFingerprints(
        isPlainRecord(metrics.domain_scope_fingerprints) ? metrics.domain_scope_fingerprints : null
    );
    const currentScope = authenticatedWorkspaceSnapshotRequest
        ? authenticatedWorkspaceSnapshotRequest.read(detectionSource, includeUntracked, authorizedFiles)
        : getWorkspaceSnapshotCached(
            repoRoot,
            detectionSource,
            includeUntracked,
            authorizedFiles,
            { noCache: true, readOnly: true }
        );
    const currentScopeGitClassification = normalizeGitChangeClassificationEvidence(
        currentScope.git_change_classification
    );
    const currentScopeGitClassificationInvalid = currentScope.git_change_classification != null
        && !currentScopeGitClassification;
    const snapshotChangedFiles = Array.isArray(currentScope.changed_files)
        ? currentScope.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const currentScopeFiles = currentScopeGitClassification
        ? currentScopeGitClassification.effective_changed_files
        : snapshotChangedFiles;
    const currentScopeFileSet = new Set(currentScopeFiles);
    const ignoredWorkflowConfigPreflightFiles = changedFiles.filter((entry) => (
        isWorkflowConfigControlPlanePath(entry) && !currentScopeFileSet.has(entry)
    ));
    const comparableChangedFiles = changedFiles.filter((entry) => (
        !ignoredWorkflowConfigPreflightFiles.includes(entry)
    ));
    const ignoredWorkflowConfigOnlyWorkspaceDelta = ignoredWorkflowConfigPreflightFiles.length > 0
        && sameSortedStringList(comparableChangedFiles, currentScopeFiles);
    const workflowConfigFileHashes = getWorkflowConfigFileHashes(repoRoot, preflight);
    const expectedComparableChangedFilesSha256 = ignoredWorkflowConfigOnlyWorkspaceDelta
        ? stringSha256(comparableChangedFiles.join('\n'))
        : expectedActualChangedFilesSha256;
    const expectedComparableChangedLinesTotal = ignoredWorkflowConfigOnlyWorkspaceDelta
        ? currentScope.changed_lines_total
        : expectedChangedLinesTotal;
    const violations: string[] = [];
    if (preflightGitClassificationInvalid) {
        violations.push('preflight canonical Git/EOL classification evidence is invalid');
    }
    if (currentScopeGitClassificationInvalid) {
        violations.push('current workspace snapshot canonical Git/EOL classification evidence is invalid');
    }
    if (
        preflightGitClassification
        && (
            !sameSortedStringList(preflightGitClassification.effective_changed_files, changedFiles)
            || !sameSortedStringList(preflightGitClassification.effective_changed_files, legacyExpectedActualChangedFiles)
        )
    ) {
        violations.push(
            'preflight canonical Git/EOL classification does not match its changed_files and metrics.actual_changed_files scope'
        );
    }
    if (
        currentScopeGitClassification
        && !sameSortedStringList(currentScopeGitClassification.effective_changed_files, snapshotChangedFiles)
    ) {
        violations.push(
            'current workspace snapshot canonical Git/EOL classification does not match its changed_files scope'
        );
    }
    if (currentScope.changed_files_sha256 !== expectedComparableChangedFilesSha256) {
        const expectedSet = new Set(expectedActualChangedFiles);
        const currentSet = new Set(currentScopeFiles);
        const missingFromPreflight = currentScopeFiles.filter((entry) => !expectedSet.has(entry));
        const noLongerCurrent = expectedActualChangedFiles
            .filter((entry) => !currentSet.has(entry));
        const ignoredWorkflowConfigNote = ignoredWorkflowConfigOnlyWorkspaceDelta
            ? `; ignored workflow-config-only local baseline files: ${describePathList(ignoredWorkflowConfigPreflightFiles)}`
            : '';
        violations.push(
            `stale preflight actual-diff file set ${describePathList(expectedActualChangedFiles)} differs from current workspace snapshot ${describePathList(currentScopeFiles)}` +
            `; missing from preflight: ${describePathList(missingFromPreflight)}` +
            `; no longer current: ${describePathList(noLongerCurrent)}${ignoredWorkflowConfigNote}`
        );
    }
    if (currentScope.changed_lines_total !== expectedComparableChangedLinesTotal) {
        violations.push(
            `preflight changed_lines_total=${expectedChangedLinesTotal} differs from current changed_lines_total=${currentScope.changed_lines_total}`
        );
    }
    if (
        !ignoredWorkflowConfigOnlyWorkspaceDelta
        && expectedScopeContentSha256
        && currentScope.scope_content_sha256 !== expectedScopeContentSha256
    ) {
        violations.push(
            `preflight scope_content_sha256=${expectedScopeContentSha256} differs from current scope_content_sha256=${currentScope.scope_content_sha256}`
        );
    }
    if (ignoredWorkflowConfigOnlyWorkspaceDelta && expectedDomainScopeFingerprints) {
        const currentDomainScopeFingerprints = buildCurrentDomainScopeFingerprints({
            repoRoot,
            detectionSource,
            includeUntracked,
            changedFiles: currentScope.changed_files
        });
        const domainViolations = getComparableNonConfigDomainViolations(
            expectedDomainScopeFingerprints,
            currentDomainScopeFingerprints
        );
        violations.push(...domainViolations.map((violation) => (
            `preflight non-config domain scope differs: ${violation} ` +
            'while ignored workflow-config local baseline is absent from git snapshot'
        )));
    }
    if (ignoredWorkflowConfigOnlyWorkspaceDelta && expectedScopeContentSha256 && !expectedDomainScopeFingerprints) {
        const currentFullScopeContentSha256 = buildScopeContentFingerprint(repoRoot, detectionSource, changedFiles);
        if (currentFullScopeContentSha256 !== expectedScopeContentSha256) {
            violations.push(
                `preflight scope_content_sha256=${expectedScopeContentSha256} differs from current full scope_content_sha256=${currentFullScopeContentSha256}` +
                ' while ignored workflow-config local baseline is absent from git snapshot'
            );
        }
    }
    if (ignoredWorkflowConfigOnlyWorkspaceDelta) {
        const hashViolations = getWorkflowConfigHashViolations(
            repoRoot,
            ignoredWorkflowConfigPreflightFiles,
            workflowConfigFileHashes
        );
        violations.push(...hashViolations.map((violation) => (
            `preflight workflow-config hash baseline differs: ${violation} ` +
            'while ignored workflow-config local baseline is absent from git snapshot'
        )));
    }
    const expectedScopeSha256 = typeof metrics.scope_sha256 === 'string'
        ? metrics.scope_sha256.trim().toLowerCase()
        : '';
    if (!ignoredWorkflowConfigOnlyWorkspaceDelta && expectedScopeSha256 && currentScope.scope_sha256 !== expectedScopeSha256) {
        violations.push(
            `preflight scope_sha256=${expectedScopeSha256} differs from current scope_sha256=${currentScope.scope_sha256}`
        );
    }
    let currentChangedFiles: string[] | undefined = Array.isArray(currentScope.changed_files)
        ? [...new Set([
            ...currentScope.changed_files.map((entry) => normalizePath(entry)).filter(Boolean),
            ...plannedChangedFiles
        ])].sort()
        : undefined;
    const allowDocsOnlyDelta = options.allowDocsOnlyDelta !== false;
    if (normalizedDetectionSource === 'explicit_changed_files') {
        const currentGitSnapshot = readCurrentGitWorkspaceSnapshot(
            repoRoot,
            includeUntracked,
            options.workspaceSnapshotRequest
        );
        if (currentGitSnapshot) {
            const unchangedProtectedFiles = getUnchangedProtectedDirtyWorkspaceFiles(repoRoot, preflight);
            const currentGitSnapshotFiles = currentGitSnapshot.changed_files
                .map((entry) => normalizePath(entry))
                .filter((entry) => entry && !isSourceCheckoutGeneratedRuntimeArtifactPath(entry, isOrchestratorSourceCheckout(repoRoot)));
            const preflightSet = new Set(authorizedFiles);
            const changedWorkflowConfigFiles = getTriggerPathList(repoRoot, preflight, 'changed_workflow_config_files');
            const uncoveredDirtyBaselineFiles = currentGitSnapshotFiles.filter((entry) => (
                unchangedProtectedFiles.has(entry) && !preflightSet.has(entry)
            ));
            if (changedWorkflowConfigFiles.length > 0 && uncoveredDirtyBaselineFiles.length > 0
                && !(violations.length === 0 && canCloseAuthenticatedNoOpBesideProtectedBaseline(
                    repoRoot, preflight, uncoveredDirtyBaselineFiles, changedWorkflowConfigFiles
                ))) {
                return {
                    ready: false,
                    reason:
                        'Protected workflow-config preflight is underscoped: current workspace still contains dirty-baseline files outside the preflight file set ' +
                        `${describePathList(uncoveredDirtyBaselineFiles)} while workflow-config files ${describePathList(changedWorkflowConfigFiles)} are in scope. ` +
                        'Refresh classify-change with the full current workspace diff before compile/review so source, test, docs, and workflow-config changes share one audited preflight.',
                    currentChangedFiles: currentGitSnapshotFiles
                };
            }
            const plannedSet = new Set(plannedChangedFiles);
            const preflightUsesOnlyPlannedScope = plannedSet.size > 0
                && authorizedFiles.length > 0
                && authorizedFiles.every((entry) => (
                    plannedSet.has(entry) || isRelatedToPlannedScope(entry, plannedChangedFiles)
                ));
            const dirtyBaselineSet = new Set([
                ...dirtyWorkspaceBaselineChangedFiles,
                ...getTriggerPathList(repoRoot, preflight, 'dirty_workspace_baseline_changed_files')
            ]);
            const unchangedDirtyBaselineSet = new Set(
                [...dirtyBaselineSet].filter((entry) => (
                    dirtyBaselineFileMatchesCurrent(repoRoot, entry, dirtyWorkspaceBaselineFileHashes)
                ))
            );
            const currentGitSnapshotFilesWithMetadata = mergeTaskOwnedMetadataRefreshFiles(
                currentGitSnapshotFiles,
                [
                    ...currentScope.changed_files,
                    ...[...dirtyBaselineSet].filter((entry) => !unchangedDirtyBaselineSet.has(entry))
                ]
            );
            const currentGitChangedFilesWithoutProtectedBaseline = currentGitSnapshotFilesWithMetadata.filter((entry) => (
                !unchangedProtectedFiles.has(entry)
            ));
            const currentPlannedScopeGitFiles = currentGitChangedFilesWithoutProtectedBaseline.filter((entry) => plannedSet.has(entry));
            const currentRelatedPlannedScopeGitFiles = currentGitChangedFilesWithoutProtectedBaseline.filter((entry) => (
                !plannedSet.has(entry)
                    && !dirtyBaselineSet.has(entry)
                    && isRelatedToPlannedScope(entry, plannedChangedFiles)
            ));
            const includeFullFailedReviewRemediationScope = Boolean(failedReviewType);
            const compareOnlyPlannedScope = !includeFullFailedReviewRemediationScope
                && preflightUsesOnlyPlannedScope
                && (currentPlannedScopeGitFiles.length > 0 || currentRelatedPlannedScopeGitFiles.length > 0);
            const currentGitChangedFiles = currentGitSnapshotFilesWithMetadata.filter((entry) => (
                !unchangedProtectedFiles.has(entry)
                    && (!includeFullFailedReviewRemediationScope
                        || !unchangedDirtyBaselineSet.has(entry)
                        || plannedSet.has(entry))
                    && (!compareOnlyPlannedScope
                        || plannedSet.has(entry)
                        || !unchangedDirtyBaselineSet.has(entry))
            ));
            const currentGitChangedSet = new Set(currentGitChangedFiles);
            const comparablePlannedChangedFiles = plannedChangedFiles.filter((entry) => (
                !dirtyBaselineSet.has(entry)
                    || currentGitChangedSet.has(entry)
                    || isWorkflowConfigControlPlanePath(entry)
            ));
            currentChangedFiles = [...new Set([
                ...currentGitChangedFiles,
                ...(hasActualChangedFiles ? [] : comparablePlannedChangedFiles)
            ])].sort();
            const currentComparableChangedFiles = preflightUsesOnlyPlannedScope
                ? currentChangedFiles
                : currentGitChangedFiles;
            if (
                !hasActualChangedFiles
                && preflightUsesOnlyPlannedScope
                && currentPlannedScopeGitFiles.length === 0
                && currentRelatedPlannedScopeGitFiles.length === 0
                && dirtyBaselineSet.size === 0
            ) {
                return {
                    ready: false,
                    reason:
                        `Preflight was classified from planned --changed-file hints ${describePathList(authorizedFiles)}, ` +
                        'but the current git workspace has no materialized diff for that planned scope. ' +
                        'Implement or create the planned files first, then rerun next-step so it can refresh classify-change for the real workspace diff before compile/review.',
                    currentChangedFiles,
                    awaitingMaterializedPlannedScope: true
                };
            }
            if (allowDocsOnlyDelta) {
                const docsOnlyDeltaReadiness = buildDocsOnlyDeltaReadiness(
                    repoRoot,
                    currentComparableChangedFiles,
                    changedFiles,
                    expectedComparableChangedLinesTotal,
                    includeUntracked,
                    detectionSource,
                    expectedComparableChangedFilesSha256,
                    expectedScopeContentSha256,
                    getDocImpactDeclaredDocsUpdated(options.docImpactPath),
                    expectedDomainScopeFingerprints,
                    options.workspaceSnapshotRequest
                );
                if (docsOnlyDeltaReadiness) {
                    return docsOnlyDeltaReadiness;
                }
            }
            const currentComparableChangedFileSet = new Set(currentComparableChangedFiles);
            const expectedGitScopeFiles = hasActualChangedFiles ? expectedActualChangedFiles : authorizedFiles;
            const expectedGitScopeFileSet = new Set(expectedGitScopeFiles);
            // Explicit classification can authenticate intentionally generated files that Git ignores
            // (for example source-checkout dist/src launcher output). Their content freshness was already
            // checked against currentScope above, so their absence from the ordinary Git snapshot is expected.
            const ignoredExplicitGitFiles = [...readGitIgnoredPathSet(repoRoot, expectedGitScopeFiles)]
                .filter((entry) => !currentComparableChangedFileSet.has(entry));
            const ignoredWorkflowConfigGitFiles = expectedGitScopeFiles.filter((entry) => (
                isWorkflowConfigControlPlanePath(entry) && !currentComparableChangedFileSet.has(entry)
            ));
            const ignoredExpectedGitFileSet = new Set([
                ...ignoredExplicitGitFiles,
                ...ignoredWorkflowConfigGitFiles
            ]);
            const gitComparableChangedFiles = expectedGitScopeFiles.filter((entry) => (
                !ignoredExpectedGitFileSet.has(entry)
            ));
            const ignoredExpectedOnlyGitDelta = ignoredExpectedGitFileSet.size > 0
                && sameSortedStringList(gitComparableChangedFiles, currentComparableChangedFiles);
            const ignoredWorkflowConfigOnlyGitDelta = ignoredWorkflowConfigGitFiles.length > 0
                && ignoredExpectedOnlyGitDelta;
            const currentFileSetHash = stringSha256(currentComparableChangedFiles.join('\n'));
            const expectedGitComparableChangedFilesSha256 = ignoredExpectedOnlyGitDelta
                ? stringSha256(gitComparableChangedFiles.join('\n'))
                : stringSha256(expectedGitScopeFiles.join('\n'));
            if (ignoredWorkflowConfigOnlyGitDelta && expectedDomainScopeFingerprints) {
                const currentDomainScopeFingerprints = buildCurrentDomainScopeFingerprints({
                    repoRoot,
                    detectionSource,
                    includeUntracked,
                    changedFiles: currentComparableChangedFiles
                });
                const domainViolations = getComparableNonConfigDomainViolations(
                    expectedDomainScopeFingerprints,
                    currentDomainScopeFingerprints
                );
                violations.push(...domainViolations.map((violation) => (
                    `preflight non-config domain scope differs: ${violation} ` +
                    'while ignored workflow-config local baseline is absent from git snapshot'
                )));
            }
            if (ignoredWorkflowConfigOnlyGitDelta) {
                const hashViolations = getWorkflowConfigHashViolations(
                    repoRoot,
                    ignoredWorkflowConfigGitFiles,
                    workflowConfigFileHashes
                );
                violations.push(...hashViolations.map((violation) => (
                    `preflight workflow-config hash baseline differs: ${violation} ` +
                    'while ignored workflow-config local baseline is absent from git snapshot'
                )));
            }
            if (currentFileSetHash !== expectedGitComparableChangedFilesSha256) {
                const currentSet = new Set(currentComparableChangedFiles);
                const missingFromPreflight = currentComparableChangedFiles.filter((entry) => !expectedGitScopeFileSet.has(entry));
                const noLongerCurrent = (ignoredExpectedOnlyGitDelta ? gitComparableChangedFiles : expectedGitScopeFiles)
                    .filter((entry) => !currentSet.has(entry));
                const ignoredProtectedNote = unchangedProtectedFiles.size > 0
                    ? `; ignored unchanged dirty-baseline files: ${describePathList([...unchangedProtectedFiles])}`
                    : '';
                const ignoredWorkflowConfigNote = ignoredWorkflowConfigOnlyGitDelta
                    ? `; ignored workflow-config-only local baseline files: ${describePathList(ignoredWorkflowConfigGitFiles)}`
                    : '';
                const ignoredExplicitGitNote = ignoredExplicitGitFiles.length > 0
                    ? `; ignored explicitly authorized Git-ignored files: ${describePathList(ignoredExplicitGitFiles)}`
                    : '';
                violations.push(
                    `stale preflight ${hasActualChangedFiles ? 'actual-diff' : 'authorized'} file set ${describePathList(expectedGitScopeFiles)} differs from current git snapshot ${describePathList(currentComparableChangedFiles)}` +
                    `; missing from preflight: ${describePathList(missingFromPreflight)}` +
                    `; no longer current: ${describePathList(noLongerCurrent)}${ignoredProtectedNote}${ignoredWorkflowConfigNote}${ignoredExplicitGitNote}`
                );
            }
        }
    }

    if (allowDocsOnlyDelta) {
        const docsOnlyDeltaReadiness = buildDocsOnlyDeltaReadiness(
            repoRoot,
            currentScope.changed_files,
            changedFiles,
            expectedComparableChangedLinesTotal,
            includeUntracked,
            detectionSource,
            expectedComparableChangedFilesSha256,
            expectedScopeContentSha256,
            getDocImpactDeclaredDocsUpdated(options.docImpactPath),
            expectedDomainScopeFingerprints,
            options.workspaceSnapshotRequest
        );
        if (docsOnlyDeltaReadiness) {
            return docsOnlyDeltaReadiness;
        }
    }

    if (violations.length > 0 && expectedDomainScopeFingerprints) {
        const currentDomainScopeFingerprints = buildCurrentDomainScopeFingerprints({
            repoRoot,
            detectionSource,
            includeUntracked,
            changedFiles: currentScope.changed_files
        });
        if (onlyNeutralCloseoutDomainChanged(expectedDomainScopeFingerprints, currentDomainScopeFingerprints)) {
            return {
                ready: true,
                reason: 'Preflight scope is current for implementation, test, docs, and config; only neutral closeout evidence changed.',
                currentChangedFiles,
                acceptedCloseoutOnlyDeltaFiles: [
                    ...new Set([
                        ...expectedDomainScopeFingerprints.domains.closeout.changed_files,
                        ...currentDomainScopeFingerprints.domains.closeout.changed_files
                    ])
                ].sort()
            };
        }
    }

    if (violations.length === 0) {
        return {
            ready: true,
            reason: 'Preflight scope still matches the current workspace.',
            currentChangedFiles
        };
    }
    const failedReviewNote = failedReviewType
        ? ` Stale failed review detected: '${failedReviewType}' previously recorded '${String(options.failedReviewVerdict || 'FAILED').trim() || 'FAILED'}', but the workspace hash changed after that review.`
        : '';
    return {
        ready: false,
        reason: `Preflight scope is stale before compile (${violations.join('; ')}).${failedReviewNote} Refresh classify-change for the current scope first.`,
        currentChangedFiles
    };
}

function getUnchangedProtectedDirtyWorkspaceFiles(
    repoRoot: string,
    preflight: Record<string, unknown>
): Set<string> {
    const triggers = getPreflightTriggers(preflight);
    const protectedFiles = normalizeWorkspaceRelativePaths(repoRoot, triggers.dirty_workspace_protected_files);
    const protectedHashes = isPlainRecord(triggers.dirty_workspace_protected_file_hashes)
        ? triggers.dirty_workspace_protected_file_hashes
        : {};
    const unchanged = new Set<string>();
    for (const protectedFile of protectedFiles) {
        const expectedHash = String(protectedHashes[protectedFile] || '').trim().toLowerCase();
        if (!expectedHash) {
            continue;
        }
        const currentHash = fileSha256(path.resolve(repoRoot, protectedFile));
        if (currentHash && currentHash === expectedHash) {
            unchanged.add(protectedFile);
        }
    }
    return unchanged;
}

function getPreflightTriggers(preflight: Record<string, unknown> | null): Record<string, unknown> {
    return isPlainRecord(preflight?.triggers) ? preflight.triggers : {};
}

function formatDomainValue(value: string | null): string {
    return value || 'null';
}

function getDomainScopeEntryViolations(
    domainName: 'implementation' | 'test' | 'docs',
    expected: DomainScopeFingerprintEntry,
    current: DomainScopeFingerprintEntry
): string[] {
    const violations: string[] = [];
    for (const fieldName of ['changed_files_sha256', 'scope_content_sha256', 'scope_sha256'] as const) {
        if (expected[fieldName] !== current[fieldName]) {
            violations.push(
                `${domainName} domain ${fieldName} expected=${formatDomainValue(expected[fieldName])}` +
                ` current=${formatDomainValue(current[fieldName])}` +
                ` expected_files=${describePathList(expected.changed_files)}` +
                ` current_files=${describePathList(current.changed_files)}`
            );
        }
    }
    return violations;
}

function getComparableNonConfigDomainViolations(
    expected: DomainScopeFingerprints,
    current: DomainScopeFingerprints
): string[] {
    const violations: string[] = [];
    for (const domainName of ['implementation', 'test', 'docs'] as const) {
        const expectedDomain = expected.domains[domainName];
        const currentDomain = current.domains[domainName];
        violations.push(...getDomainScopeEntryViolations(domainName, expectedDomain, currentDomain));
    }
    return violations;
}

type WorkflowConfigFileHashes = Record<string, string | null>;

function getWorkflowConfigFileHashes(repoRoot: string, preflight: Record<string, unknown>): WorkflowConfigFileHashes {
    const triggers = getPreflightTriggers(preflight);
    const rawHashes = isPlainRecord(triggers.workflow_config_file_hashes)
        ? triggers.workflow_config_file_hashes
        : {};
    const hashes: WorkflowConfigFileHashes = {};
    for (const [rawPath, rawHash] of Object.entries(rawHashes)) {
        const normalizedPath = normalizeWorkspaceRelativePath(repoRoot, rawPath);
        if (!normalizedPath) {
            continue;
        }
        hashes[normalizedPath] = typeof rawHash === 'string'
            ? rawHash.trim().toLowerCase() || null
            : null;
    }
    return hashes;
}

function getWorkflowConfigHashViolations(
    repoRoot: string,
    workflowConfigFiles: readonly string[],
    workflowConfigFileHashes: WorkflowConfigFileHashes
): string[] {
    const violations: string[] = [];
    for (const entry of workflowConfigFiles) {
        const normalizedPath = normalizeWorkspaceRelativePath(repoRoot, entry);
        if (!normalizedPath) {
            violations.push(`invalid workflow-config path '${entry}'`);
            continue;
        }
        const hasBaseline = Object.prototype.hasOwnProperty.call(workflowConfigFileHashes, normalizedPath);
        const expectedHash = hasBaseline ? workflowConfigFileHashes[normalizedPath] : null;
        if (!expectedHash) {
            violations.push(`missing workflow_config_file_hashes baseline for ${normalizedPath}`);
            continue;
        }
        const currentHash = fileSha256(path.resolve(repoRoot, normalizedPath));
        if (!currentHash) {
            violations.push(`current workflow-config file ${normalizedPath} is missing or unreadable`);
            continue;
        }
        const normalizedCurrentHash = currentHash.trim().toLowerCase();
        if (normalizedCurrentHash !== expectedHash) {
            violations.push(
                `workflow-config ${normalizedPath} sha256 expected=${expectedHash} current=${normalizedCurrentHash}`
            );
        }
    }
    return violations;
}

function getTriggerPathList(repoRoot: string, preflight: Record<string, unknown>, fieldName: string): string[] {
    const triggers = getPreflightTriggers(preflight);
    return normalizeWorkspaceRelativePaths(repoRoot, triggers[fieldName]);
}

function dirtyBaselineFileMatchesCurrent(
    repoRoot: string,
    changedFile: string,
    dirtyBaselineFileHashes: Record<string, string>
): boolean {
    const normalizedChangedFile = normalizeWorkspaceRelativePath(repoRoot, changedFile);
    if (!normalizedChangedFile) {
        return false;
    }
    const expectedHash = dirtyBaselineFileHashes[normalizedChangedFile];
    if (!expectedHash) {
        return false;
    }
    const currentHash = fileSha256(path.resolve(repoRoot, normalizedChangedFile));
    return !!currentHash && currentHash.trim().toLowerCase() === expectedHash;
}
