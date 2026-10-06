import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    emitPlanCreatedEvent,
    emitProviderRoutingEvent,
    emitStatusChangedEvent
} from '../../../../gate-runtime/lifecycle-events';
import {
    appendMandatoryTaskEvent,
    assertValidTaskId
} from '../../../../gate-runtime/task-events';
import type { LockHandle } from '../../../../gate-runtime/task-events-locking';
import {
    buildTaskModeArtifact,
    getTaskModeEvidence,
    getTaskModeEvidenceViolations,
    parseTaskModeDepth,
    readOptionalMarkdownWorkingPlan,
    resolveTaskModeArtifactPath
} from '../../../../gates/task-mode/task-mode';
import { selectTaskModePlan } from '../../../../gates/task-mode/task-mode-plan';
import { buildTaskPlanDiagnostics, formatTaskPlanDiagnostics } from '../../../../gates/diagnostics/task-plan-diagnostics';
import {
    captureDirtyWorkspaceBaseline,
    type DirtyWorkspaceBaseline
} from '../../../../gates/workspace/dirty-worktree-protection';
import {
    getCurrentWorkflowConfigFileHashes,
    getWorkflowConfigPreTaskBaselineState,
    normalizeWorkflowConfigFileHashes
} from '../../../../gates/workflow-config/workflow-config-work';
import {
    readTaskQueueMetadata
} from '../../../../gates/task-audit/task-audit-summary-collectors';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    resolveTaskProfileSelection
} from '../../../../policy/task-profile-selection';
import {
    buildTaskProfilePolicySnapshot,
    type TaskProfilePolicySnapshot
} from '../../../../policy/task-profile-policy-snapshot';
import {
    loadReviewExecutionPolicyConfig
} from '../../../../core/review-execution-policy';
import { loadFullSuiteValidationConfig } from '../../../../core/full-suite-validation-config';
import { resolveReviewFollowUpTaskClosurePolicy } from '../../../../core/review-follow-up-task-closure-policy';
import { readTaskQueueEntries } from '../../../../core/task-queue-read';
import { withTaskPlanMutationLock } from '../../../../core/task-plan-save';
import {
    readImplementationTaskMode,
    resolveActiveTaskEntryApproval,
    withImplementationOwnershipLock
} from '../../../../gates/workspace/active-implementation-ownership';
import {
    normalizeOptionalPath,
    removeArtifactIfExists,
    resolveDefaultMetricsPath,
    resolvePathForWrite,
    writeJsonArtifact
} from '../../../gate-cli/gates-artifacts';
import {
    parseBooleanOption
} from '../../../gate-cli/gates-parser';
import { requireResolvedPath } from '../../shared-command-utils';
import {
    getErrorMessage,
    resolveOrchestratorRoot,
    appendMetricsIfEnabled
} from '../compile/gate-flow-helpers';
import { readRoutingDecision } from './routing-decision';
import { readTaskQueueStatus, syncTaskQueueStatus } from '../task/task-queue-sync';
import {
    assertTaskModeProtectedEntryAllowed,
    WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE
} from './task-mode-entry-protection';
import { resolveTaskModeEntryScope } from './task-mode-entry-scope';
import { resolveTaskModeStartBanner } from './task-mode-entry-start-banner';
import {
    assertTaskModeRuntimeIdentity,
    resolveTaskModeReviewerRoutingFields
} from './task-mode-runtime-identity';
import {
    runCommandTimeoutDiagnosticsCommand,
    runHandshakeDiagnosticsCommand,
    runShellSmokePreflightCommand,
    type CommandTimeoutDiagnosticsCommandOptions,
    type HandshakeDiagnosticsCommandOptions,
    type ShellSmokePreflightCommandOptions
} from './task-mode-diagnostics-commands';
import {
    runBindRulePackToPreflightCommand,
    runLoadRulePackCommand,
    runRecordNoOpCommand,
    runRecordStrictDecompositionDecisionCommand,
    type BindRulePackToPreflightCommandOptions,
    type LoadRulePackCommandOptions,
    type RecordNoOpCommandOptions,
    type RecordStrictDecompositionDecisionCommandOptions
} from './task-mode-record-commands';
import {
    runRecordReviewCycleContinuationCommand,
    runRecordReviewCycleSplitDecisionCommand,
    type RecordReviewCycleContinuationCommandOptions,
    type RecordReviewCycleSplitDecisionCommandOptions
} from './task-mode-review-cycle-commands';
import {
    runListSplitRequiredWipCommand,
    runRestoreSplitRequiredWipCommand,
    runRetireSplitRequiredWipCommand,
    type ListSplitRequiredWipCommandOptions,
    type RestoreSplitRequiredWipCommandOptions,
    type RetireSplitRequiredWipCommandOptions
} from './task-mode-split-required-wip-commands';

export { WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE };
export {
    runBindRulePackToPreflightCommand,
    runLoadRulePackCommand,
    runRecordNoOpCommand,
    runCommandTimeoutDiagnosticsCommand,
    runHandshakeDiagnosticsCommand,
    runRecordReviewCycleContinuationCommand,
    runRecordReviewCycleSplitDecisionCommand,
    runRecordStrictDecompositionDecisionCommand,
    runListSplitRequiredWipCommand,
    runRestoreSplitRequiredWipCommand,
    runRetireSplitRequiredWipCommand,
    runShellSmokePreflightCommand
};
export type {
    BindRulePackToPreflightCommandOptions,
    CommandTimeoutDiagnosticsCommandOptions,
    HandshakeDiagnosticsCommandOptions,
    LoadRulePackCommandOptions,
    RecordNoOpCommandOptions,
    RecordReviewCycleContinuationCommandOptions,
    RecordReviewCycleSplitDecisionCommandOptions,
    RecordStrictDecompositionDecisionCommandOptions,
    ListSplitRequiredWipCommandOptions,
    RestoreSplitRequiredWipCommandOptions,
    RetireSplitRequiredWipCommandOptions,
    ShellSmokePreflightCommandOptions
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readReusableProfilePolicySnapshot(
    repoRoot: string,
    taskId: string,
    artifactPath: string,
    options: { requireSnapshot: boolean }
): TaskProfilePolicySnapshot | null {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        const evidence = getTaskModeEvidence(repoRoot, taskId, artifactPath);
        if (evidence.timeline_declares_profile_policy_snapshot) {
            throw new Error(
                `Existing task-mode profile policy snapshot is not reusable (${evidence.profile_policy_snapshot_status}). ` +
                `${getTaskModeEvidenceViolations(evidence).join(' ') || 'Snapshot evidence validation failed.'}`
            );
        }
        return null;
    }

    let declaresSnapshot = false;
    try {
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown;
        if (isPlainRecord(artifact)) {
            declaresSnapshot = artifact.profile_policy_snapshot_required === true
                || artifact.profile_policy_snapshot != null;
        }
    } catch (error: unknown) {
        if (options.requireSnapshot) {
            throw new Error(
                `Existing task-mode profile policy snapshot is not reusable (INVALID). ` +
                `Task-mode artifact could not be parsed: ${getErrorMessage(error)}`
            );
        }
        return null;
    }

    const evidence = getTaskModeEvidence(repoRoot, taskId, artifactPath);
    if (
        evidence.evidence_status === 'PASS'
        && evidence.profile_policy_snapshot_status === 'PASS'
        && evidence.profile_policy_snapshot
    ) {
        return evidence.profile_policy_snapshot;
    }
    if (declaresSnapshot || evidence.timeline_declares_profile_policy_snapshot || options.requireSnapshot) {
        throw new Error(
            `Existing task-mode profile policy snapshot is not reusable (${evidence.profile_policy_snapshot_status}). ` +
            `${[
                ...evidence.profile_policy_snapshot_violations,
                ...getTaskModeEvidenceViolations(evidence)
            ].join(' ') || 'Snapshot evidence validation failed.'}`
        );
    }
    return null;
}

export interface EnterTaskModeCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    entryMode?: unknown;
    requestedDepth?: unknown;
    effectiveDepth?: unknown;
    taskSummary?: unknown;
    startBanner?: unknown;
    plannedChangedFiles?: unknown;
    allowedActiveTasks?: unknown;
    orchestratorWork?: unknown;
    workflowConfigWork?: unknown;
    upgradeExistingTaskMode?: unknown;
    operatorConfirmed?: unknown;
    operatorConfirmedAtUtc?: unknown;
    allowedDirtyWorkflowConfigFiles?: unknown;
    workflowConfigFileHashesOverride?: Record<string, string | null> | null;
    workflowConfigCompatibilityBaselineFilesOverride?: unknown;
    provider?: unknown;
    routedTo?: unknown;
    actor?: unknown;
    planPath?: string;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

interface TaskModeScopeUpgradeState {
    dirtyWorkspaceBaseline: DirtyWorkspaceBaseline;
    allowedDirtyWorkflowConfigFiles: string[];
    workflowConfigFileHashes: Record<string, string | null> | null;
    workflowConfigCompatibilityBaselineFiles: string[];
}

function resolveTaskModeScopeUpgrade(input: {
    repoRoot: string;
    taskId: string;
    artifactPath: string;
    requested: boolean;
    requireCompleteUpgradeScope: boolean;
    previousTaskMode?: ReturnType<typeof getTaskModeEvidence>;
    orchestratorWork: boolean;
    workflowConfigWork: boolean;
    plannedChangedFiles: string[];
    currentDirtyWorkspaceBaseline: DirtyWorkspaceBaseline;
    dirtyWorkflowConfigFiles: string[];
}): TaskModeScopeUpgradeState | null {
    if (!input.requested) {
        return null;
    }

    const previousTaskMode = input.previousTaskMode || getTaskModeEvidence(input.repoRoot, input.taskId, input.artifactPath);
    const violations = getTaskModeEvidenceViolations(previousTaskMode);
    if (violations.length > 0) {
        throw new Error(
            'Cannot upgrade task-mode scope without valid current task-mode evidence. ' + violations.join(' ')
        );
    }
    if (previousTaskMode.orchestrator_work === true && !input.orchestratorWork) {
        throw new Error('Task-mode scope upgrade cannot remove the existing --orchestrator-work authorization.');
    }
    if (previousTaskMode.workflow_config_work === true && !input.workflowConfigWork) {
        throw new Error('Task-mode scope upgrade cannot remove the existing --workflow-config-work authorization.');
    }
    if (!previousTaskMode.dirty_workspace_baseline) {
        // Legacy identity validation checks both the artifact and its entry event before backfilling.
        if (!input.requireCompleteUpgradeScope && previousTaskMode.identity_backfilled_from_legacy && previousTaskMode.evidence_path) {
            const originalArtifact = JSON.parse(fs.readFileSync(previousTaskMode.evidence_path, 'utf8')) as Record<string, unknown>;
            if (!Object.prototype.hasOwnProperty.call(originalArtifact, 'dirty_workspace_baseline')) {
                return null;
            }
        }
        throw new Error('Cannot upgrade task-mode scope because the original dirty workspace baseline is missing.');
    }

    const originalBaselineFiles = new Set(previousTaskMode.dirty_workspace_baseline.changed_files);
    const plannedFiles = new Set(input.plannedChangedFiles);
    const unplannedTaskOwnedFiles = input.currentDirtyWorkspaceBaseline.changed_files.filter((entry) => (
        !originalBaselineFiles.has(entry) && !plannedFiles.has(entry)
    ));
    if (input.requireCompleteUpgradeScope && unplannedTaskOwnedFiles.length > 0) {
        throw new Error(
            'Task-mode scope upgrade requires every post-entry changed file in the planned scope: ' +
            unplannedTaskOwnedFiles.join(', ') + '.'
        );
    }

    const preExistingWorkflowConfigFiles = input.dirtyWorkflowConfigFiles.filter((entry) => (
        originalBaselineFiles.has(entry)
    ));
    if (preExistingWorkflowConfigFiles.length > 0) {
        throw new Error(
            'Task-mode scope upgrade cannot authorize workflow config files that were already dirty at original entry: ' +
            preExistingWorkflowConfigFiles.join(', ') + '.'
        );
    }
    if (input.dirtyWorkflowConfigFiles.length > 0 && !previousTaskMode.workflow_config_file_hashes) {
        throw new Error(
            'Task-mode scope upgrade cannot authenticate the original workflow config baseline because its hashes are missing.'
        );
    }

    return {
        dirtyWorkspaceBaseline: previousTaskMode.dirty_workspace_baseline,
        allowedDirtyWorkflowConfigFiles: [...input.dirtyWorkflowConfigFiles],
        workflowConfigFileHashes: previousTaskMode.workflow_config_file_hashes,
        workflowConfigCompatibilityBaselineFiles: previousTaskMode.workflow_config_compatibility_baseline_files
    };
}

export function runEnterTaskModeCommand(options: EnterTaskModeCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    return withImplementationOwnershipLock(
        repoRoot,
        lock => withTaskPlanMutationLock(repoRoot, assertValidTaskId(String(options.taskId || '').trim()),
            planLock => runEnterTaskModeWithOwnershipLock(options, lock, planLock))
    );
}

function runEnterTaskModeWithOwnershipLock(
    options: EnterTaskModeCommandOptions,
    ownershipLock: LockHandle,
    taskPlanLock: LockHandle
): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const artifactPath = resolveTaskModeArtifactPath(repoRoot, taskId, String(options.artifactPath || ''));
    // A new task-mode entry must never inherit runtime identity from an older task-mode artifact.
    const routingDecision = readRoutingDecision(repoRoot, options.provider, options.routedTo);
    assertTaskModeRuntimeIdentity(repoRoot, taskId, routingDecision, artifactPath);
    const workflowConfigFileHashes = getCurrentWorkflowConfigFileHashes(repoRoot);
    const {
        plannedChangedFiles,
        protectedPlannedFiles,
        workflowConfigPlannedFiles
    } = resolveTaskModeEntryScope(repoRoot, options.plannedChangedFiles);
    const currentDirtyWorkspaceBaseline = captureDirtyWorkspaceBaseline(
        repoRoot, plannedChangedFiles, ownershipLock, { taskId, handle: taskPlanLock }
    );
    const orchestratorWork = parseBooleanOption(options.orchestratorWork, false);
    const workflowConfigWork = parseBooleanOption(options.workflowConfigWork, false);
    const upgradeExistingTaskMode = parseBooleanOption(options.upgradeExistingTaskMode, false);
    const workflowConfigPreTaskBaseline = getWorkflowConfigPreTaskBaselineState(repoRoot, workflowConfigFileHashes);
    const dirtyWorkflowConfigFiles = [...workflowConfigPreTaskBaseline.changed_files].sort();
    const startBanner = resolveTaskModeStartBanner(options.startBanner);

    const markdownWorkingPlan = readOptionalMarkdownWorkingPlan(repoRoot, taskId);

    const taskQueueEntries = readTaskQueueEntries(repoRoot);
    const taskQueueEntry = taskQueueEntries.get(taskId);
    const taskQueueMetadata = readTaskQueueMetadata(repoRoot, taskId, taskQueueEntries);

    const activeTaskApproval = resolveActiveTaskEntryApproval({
        repoRoot, taskId, artifactPath, entries: taskQueueEntries,
        allowedActiveTasks: options.allowedActiveTasks,
        operatorConfirmed: options.operatorConfirmed,
        operatorConfirmedAtUtc: options.operatorConfirmedAtUtc,
        plannedChangedFiles
    });

    const profilesConfigPath = path.join(orchestratorRoot, 'live', 'config', 'profiles.json');
    const profilesConfigExists = fs.existsSync(profilesConfigPath) && fs.statSync(profilesConfigPath).isFile();
    const reusableProfilePolicySnapshot = readReusableProfilePolicySnapshot(repoRoot, taskId, artifactPath, {
        requireSnapshot: profilesConfigExists
    });
    const previousTaskMode = readImplementationTaskMode(repoRoot, taskId);
    const preserveOwnershipBaseline = !!previousTaskMode && (
        previousTaskMode.evidence_status !== 'EVIDENCE_FILE_MISSING' || !!previousTaskMode.timeline_artifact_path
    );
    const preservedScope = resolveTaskModeScopeUpgrade({
        repoRoot, taskId, artifactPath,
        requested: upgradeExistingTaskMode || preserveOwnershipBaseline,
        requireCompleteUpgradeScope: upgradeExistingTaskMode,
        previousTaskMode: preserveOwnershipBaseline && previousTaskMode ? previousTaskMode : undefined,
        orchestratorWork, workflowConfigWork, plannedChangedFiles,
        currentDirtyWorkspaceBaseline, dirtyWorkflowConfigFiles
    });
    const scopeUpgrade = upgradeExistingTaskMode || activeTaskApproval ? preservedScope : null;
    const dirtyWorkspaceBaseline = preservedScope?.dirtyWorkspaceBaseline || currentDirtyWorkspaceBaseline;
    const planSelection = selectTaskModePlan(repoRoot, taskId, String(options.planPath || '').trim(),
        preserveOwnershipBaseline ? previousTaskMode?.plan ?? null : undefined);

    assertTaskModeProtectedEntryAllowed({
        repoRoot,
        orchestratorRoot,
        taskId,
        options,
        plannedChangedFiles,
        protectedPlannedFiles,
        workflowConfigPlannedFiles,
        dirtyWorkflowConfigFiles,
        workflowConfigPreTaskBaseline,
        orchestratorWork,
        workflowConfigWork,
        allowedDirtyWorkflowConfigFiles: scopeUpgrade?.allowedDirtyWorkflowConfigFiles
            || options.allowedDirtyWorkflowConfigFiles,
        taskQueueMetadata
    });
    const workflowConfigFileHashesForArtifact = normalizeWorkflowConfigFileHashes(options.workflowConfigFileHashesOverride)
        || normalizeWorkflowConfigFileHashes(preservedScope?.workflowConfigFileHashes)
        || workflowConfigFileHashes;
    const workflowConfigCompatibilityBaselineFiles = options.workflowConfigCompatibilityBaselineFilesOverride === undefined
        ? preservedScope?.workflowConfigCompatibilityBaselineFiles
            || workflowConfigPreTaskBaseline.compatibility_baseline_files
        : options.workflowConfigCompatibilityBaselineFilesOverride as string[];

    const rawTaskProfile = taskQueueMetadata?.profile || null;
    let taskProfile: string | null = null;
    let profileSelectionSource: 'task_queue' | 'workspace_active' | null = null;
    let activeProfile: string | null = null;
    let profileSource: 'built_in' | 'user' | null = null;
    let runtimeActiveProfile: string | null = null;
    let runtimeProfileSource: 'built_in' | 'user' | null = null;
    let profilePolicySnapshot: TaskProfilePolicySnapshot | null = null;
    let defaultTaskModeDepth = 2;
    let defaultTaskModeDepthResolvedFromProfile = false;
    if (reusableProfilePolicySnapshot) {
        profilePolicySnapshot = reusableProfilePolicySnapshot;
        taskProfile = reusableProfilePolicySnapshot.source.task_profile;
        profileSelectionSource = reusableProfilePolicySnapshot.source.profile_selection_source;
        activeProfile = reusableProfilePolicySnapshot.source.effective_profile;
        profileSource = reusableProfilePolicySnapshot.source.effective_profile_source;
        runtimeActiveProfile = reusableProfilePolicySnapshot.source.runtime_active_profile;
        runtimeProfileSource = reusableProfilePolicySnapshot.source.runtime_profile_source;
        if (
            Number.isInteger(reusableProfilePolicySnapshot.depth)
            && reusableProfilePolicySnapshot.depth >= 1
            && reusableProfilePolicySnapshot.depth <= 3
        ) {
            defaultTaskModeDepth = reusableProfilePolicySnapshot.depth;
            defaultTaskModeDepthResolvedFromProfile = true;
        }
    } else if (profilesConfigExists) {
        const resolvedProfile = resolveTaskProfileSelection(orchestratorRoot, rawTaskProfile);
        taskProfile = resolvedProfile.selection.task_profile;
        profileSelectionSource = resolvedProfile.selection.profile_selection_source;
        activeProfile = resolvedProfile.selection.effective_profile;
        profileSource = resolvedProfile.selection.effective_profile_source;
        runtimeActiveProfile = resolvedProfile.selection.runtime_active_profile;
        runtimeProfileSource = resolvedProfile.selection.runtime_profile_source;
        const reviewExecutionPolicy = loadReviewExecutionPolicyConfig(repoRoot);
        const fullSuiteValidation = loadFullSuiteValidationConfig(repoRoot);
        profilePolicySnapshot = buildTaskProfilePolicySnapshot(orchestratorRoot, rawTaskProfile, {
            reviewExecutionPolicyMode: reviewExecutionPolicy.mode,
            reviewExecutionPolicyConfigured: reviewExecutionPolicy.configured,
            fullSuiteValidationEnabled: fullSuiteValidation.enabled,
            fullSuiteValidationPlacement: fullSuiteValidation.placement,
            reviewFollowUpTaskClosurePolicy: taskQueueEntry?.reviewFollowUpTaskClosurePolicy
                || resolveReviewFollowUpTaskClosurePolicy(undefined)
        });
        if (
            Number.isInteger(resolvedProfile.effective_policy.depth)
            && resolvedProfile.effective_policy.depth >= 1
            && resolvedProfile.effective_policy.depth <= 3
        ) {
            defaultTaskModeDepth = resolvedProfile.effective_policy.depth;
            defaultTaskModeDepthResolvedFromProfile = true;
        }
    } else if (String(rawTaskProfile || '').trim() && String(rawTaskProfile || '').trim().toLowerCase() !== 'default') {
        throw new Error(
            `Task profile '${String(rawTaskProfile).trim()}' cannot be resolved because profiles config is missing: ${gateHelpers.normalizePath(profilesConfigPath)}`
        );
    }

    const reviewerRoutingFields = resolveTaskModeReviewerRoutingFields(routingDecision.provider);
    const requestedDepthWasExplicit = String(options.requestedDepth || '').trim() !== '';
    const effectiveDepthWasExplicit = String(options.effectiveDepth || '').trim() !== '';
    const requestedDepthSource = requestedDepthWasExplicit
        ? 'explicit'
        : defaultTaskModeDepthResolvedFromProfile ? 'profile_default' : 'legacy_default';
    const taskModeArtifact = buildTaskModeArtifact({
        taskId,
        entryMode: options.entryMode,
        requestedDepth: parseTaskModeDepth(options.requestedDepth, 'RequestedDepth', defaultTaskModeDepth),
        effectiveDepth: parseTaskModeDepth(
            options.effectiveDepth,
            'EffectiveDepth',
            parseTaskModeDepth(options.requestedDepth, 'RequestedDepth', defaultTaskModeDepth)
        ),
        requestedDepthSource,
        effectiveDepthSource: effectiveDepthWasExplicit ? 'explicit' : 'requested_depth',
        taskSummary: String(options.taskSummary || ''),
        orchestratorWork,
        workflowConfigWork,
        startBanner,
        provider: routingDecision.provider,
        canonicalSourceOfTruth: routingDecision.canonicalSourceOfTruth,
        executionProviderSource: routingDecision.executionProviderSource,
        reviewerCapabilityLevel: reviewerRoutingFields.reviewerCapabilityLevel,
        reviewerExpectedExecutionMode: reviewerRoutingFields.reviewerExpectedExecutionMode,
        reviewerFallbackAllowed: reviewerRoutingFields.reviewerFallbackAllowed,
        reviewerFallbackReasonRequired: reviewerRoutingFields.reviewerFallbackReasonRequired,
        reviewerSubagentLaunchStatus: routingDecision.reviewerSubagentLaunchStatus,
        reviewerSubagentLaunchRoute: routingDecision.reviewerSubagentLaunchRoute,
        reviewerSubagentLaunchReason: routingDecision.reviewerSubagentLaunchReason,
        reviewerSubagentLaunchRemediation: routingDecision.reviewerSubagentLaunchRemediation,
        runtimeIdentityStatus: routingDecision.identityStatus,
        runtimeIdentityViolations: routingDecision.violations,
        routedTo: routingDecision.routedTo,
        actor: String(options.actor || 'orchestrator'),
        plan: planSelection.plan,
        markdownWorkingPlan,
        plannedChangedFiles,
        taskProfile,
        profileSelectionSource,
        activeProfile,
        profileSource,
        runtimeActiveProfile,
        runtimeProfileSource,
        profilePolicySnapshot,
        dirtyWorkspaceBaseline,
        workflowConfigFileHashes: workflowConfigFileHashesForArtifact,
        workflowConfigCompatibilityBaselineFiles
    });
    writeJsonArtifact(artifactPath, taskModeArtifact);

    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: taskModeArtifact.timestamp_utc,
        event_type: 'task_mode_entered',
        status: taskModeArtifact.status,
        task_id: taskModeArtifact.task_id,
        artifact_path: normalizeOptionalPath(artifactPath),
        entry_mode: taskModeArtifact.entry_mode,
        requested_depth: taskModeArtifact.requested_depth,
        effective_depth: taskModeArtifact.effective_depth,
        start_banner: taskModeArtifact.start_banner,
        orchestrator_work: taskModeArtifact.orchestrator_work,
        workflow_config_work: taskModeArtifact.workflow_config_work,
        actor: taskModeArtifact.actor,
        plan_guided: !!taskModeArtifact.plan,
        markdown_working_plan_path: taskModeArtifact.markdown_working_plan?.working_plan_path ?? null,
        markdown_working_plan_sha256: taskModeArtifact.markdown_working_plan?.working_plan_sha256 ?? null,
        task_profile: taskModeArtifact.task_profile,
        profile_selection_source: taskModeArtifact.profile_selection_source,
        active_profile: taskModeArtifact.active_profile,
        profile_source: taskModeArtifact.profile_source,
        runtime_active_profile: taskModeArtifact.runtime_active_profile,
        runtime_profile_source: taskModeArtifact.runtime_profile_source,
        profile_policy_snapshot_required: taskModeArtifact.profile_policy_snapshot_required,
        profile_policy_snapshot_hash: taskModeArtifact.profile_policy_snapshot?.snapshot_hash ?? null,
        profile_policy_snapshot_config_hash: taskModeArtifact.profile_policy_snapshot?.config_hash ?? null,
        dirty_workspace_baseline_count: taskModeArtifact.dirty_workspace_baseline?.changed_files.length || 0,
        dirty_workspace_baseline_sha256: taskModeArtifact.dirty_workspace_baseline?.changed_files_sha256 || null,
        workflow_config_file_hash_count: Object.keys(taskModeArtifact.workflow_config_file_hashes || {}).length,
        workflow_config_compatibility_baseline_count: taskModeArtifact.workflow_config_compatibility_baseline_files.length
    }, parseBooleanOption(options.emitMetrics, true));

    try {
        appendMandatoryTaskEvent(
            orchestratorRoot,
            taskModeArtifact.task_id,
            'TASK_MODE_ENTERED',
            'PASS',
            taskModeArtifact.plan
                ? `Task mode entered via ${taskModeArtifact.entry_mode} (plan-guided).`
                : `Task mode entered via ${taskModeArtifact.entry_mode}.`,
            {
                artifact_path: normalizeOptionalPath(artifactPath),
                active_task_approval: activeTaskApproval
                    ? { ...activeTaskApproval, task_mode_sha256: gateHelpers.fileSha256(artifactPath) }
                    : null,
                entry_mode: taskModeArtifact.entry_mode,
                requested_depth: taskModeArtifact.requested_depth,
                effective_depth: taskModeArtifact.effective_depth,
                task_summary: taskModeArtifact.task_summary,
                orchestrator_work: taskModeArtifact.orchestrator_work,
                workflow_config_work: taskModeArtifact.workflow_config_work,
                start_banner: taskModeArtifact.start_banner,
                provider: taskModeArtifact.provider,
                canonical_source_of_truth: taskModeArtifact.canonical_source_of_truth,
                execution_provider_source: taskModeArtifact.execution_provider_source,
                reviewer_capability_level: taskModeArtifact.reviewer_capability_level,
                reviewer_expected_execution_mode: taskModeArtifact.reviewer_expected_execution_mode,
                reviewer_fallback_allowed: taskModeArtifact.reviewer_fallback_allowed,
                reviewer_fallback_reason_required: taskModeArtifact.reviewer_fallback_reason_required,
                reviewer_subagent_launch_status: taskModeArtifact.reviewer_subagent_launch_status,
                reviewer_subagent_launch_route: taskModeArtifact.reviewer_subagent_launch_route,
                reviewer_subagent_launch_reason: taskModeArtifact.reviewer_subagent_launch_reason,
                reviewer_subagent_launch_remediation: taskModeArtifact.reviewer_subagent_launch_remediation,
                runtime_identity_status: taskModeArtifact.runtime_identity_status,
                runtime_identity_violations: taskModeArtifact.runtime_identity_violations,
                routed_to: taskModeArtifact.routed_to,
                actor: taskModeArtifact.actor,
                plan_guided: !!taskModeArtifact.plan,
                plan_path: taskModeArtifact.plan?.plan_path ?? null,
                plan_sha256: taskModeArtifact.plan?.plan_sha256 ?? null,
                markdown_working_plan_path: taskModeArtifact.markdown_working_plan?.working_plan_path ?? null,
                markdown_working_plan_sha256: taskModeArtifact.markdown_working_plan?.working_plan_sha256 ?? null,
                task_profile: taskModeArtifact.task_profile,
                profile_selection_source: taskModeArtifact.profile_selection_source,
                active_profile: taskModeArtifact.active_profile,
                profile_source: taskModeArtifact.profile_source,
                runtime_active_profile: taskModeArtifact.runtime_active_profile,
                runtime_profile_source: taskModeArtifact.runtime_profile_source,
                ...(taskModeArtifact.profile_policy_snapshot
                    ? {
                        profile_policy_snapshot_required: true,
                        profile_policy_snapshot_hash: taskModeArtifact.profile_policy_snapshot.snapshot_hash,
                        profile_policy_snapshot_config_hash: taskModeArtifact.profile_policy_snapshot.config_hash
                    }
                    : {}),
                dirty_workspace_baseline_count: taskModeArtifact.dirty_workspace_baseline?.changed_files.length || 0,
                dirty_workspace_baseline_sha256: taskModeArtifact.dirty_workspace_baseline?.changed_files_sha256 || null,
                workflow_config_file_hash_count: Object.keys(taskModeArtifact.workflow_config_file_hashes || {}).length,
                workflow_config_compatibility_baseline_count: taskModeArtifact.workflow_config_compatibility_baseline_files.length
            }
        );
    } catch (error: unknown) {
        removeArtifactIfExists(artifactPath);
        throw new Error(
            `enter-task-mode failed because mandatory lifecycle event 'TASK_MODE_ENTERED' could not be appended. ${getErrorMessage(error)}`
        );
    }

    emitPlanCreatedEvent(orchestratorRoot, taskModeArtifact.task_id, {
        artifact_path: normalizeOptionalPath(artifactPath),
        entry_mode: taskModeArtifact.entry_mode,
        requested_depth: taskModeArtifact.requested_depth,
        effective_depth: taskModeArtifact.effective_depth,
        task_summary: taskModeArtifact.task_summary,
        start_banner: taskModeArtifact.start_banner,
        orchestrator_work: taskModeArtifact.orchestrator_work,
        workflow_config_work: taskModeArtifact.workflow_config_work,
        provider: taskModeArtifact.provider,
        canonical_source_of_truth: taskModeArtifact.canonical_source_of_truth,
        execution_provider_source: taskModeArtifact.execution_provider_source,
        runtime_identity_status: taskModeArtifact.runtime_identity_status,
        runtime_identity_violations: taskModeArtifact.runtime_identity_violations,
        routed_to: taskModeArtifact.routed_to,
        ...(taskModeArtifact.profile_policy_snapshot
            ? {
                profile_policy_snapshot_hash: taskModeArtifact.profile_policy_snapshot.snapshot_hash,
                profile_policy_snapshot_config_hash: taskModeArtifact.profile_policy_snapshot.config_hash
            }
            : {}),
        plan_guided: !!taskModeArtifact.plan,
        plan_path: taskModeArtifact.plan?.plan_path ?? null,
        plan_sha256: taskModeArtifact.plan?.plan_sha256 ?? null,
        markdown_working_plan_path: taskModeArtifact.markdown_working_plan?.working_plan_path ?? null,
        markdown_working_plan_sha256: taskModeArtifact.markdown_working_plan?.working_plan_sha256 ?? null,
        dirty_workspace_baseline_count: taskModeArtifact.dirty_workspace_baseline?.changed_files.length || 0,
        dirty_workspace_baseline_sha256: taskModeArtifact.dirty_workspace_baseline?.changed_files_sha256 || null,
        workflow_config_compatibility_baseline_count: taskModeArtifact.workflow_config_compatibility_baseline_files.length
    });

    const previousStatus = readTaskQueueStatus(repoRoot, taskModeArtifact.task_id);
    if (previousStatus && previousStatus !== 'IN_PROGRESS') {
        emitStatusChangedEvent(orchestratorRoot, taskModeArtifact.task_id, previousStatus, 'IN_PROGRESS');
        syncTaskQueueStatus(repoRoot, taskModeArtifact.task_id, 'IN_PROGRESS');
    }

    if (routingDecision.provider && routingDecision.routedTo) {
        emitProviderRoutingEvent(
            orchestratorRoot,
            taskModeArtifact.task_id,
            routingDecision.provider,
            routingDecision.routedTo,
            'task_mode_entry'
        );
    }

    return {
        outputLines: [
            'TASK_MODE_ENTERED',
            `TaskModeArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
            `EntryMode: ${taskModeArtifact.entry_mode}`,
            `RequestedDepth: ${taskModeArtifact.requested_depth}`,
            `EffectiveDepth: ${taskModeArtifact.effective_depth}`,
            ...(taskModeArtifact.start_banner ? [`StartBanner: ${taskModeArtifact.start_banner}`] : []),
            `OrchestratorWork: ${taskModeArtifact.orchestrator_work}`,
            `WorkflowConfigWork: ${taskModeArtifact.workflow_config_work}`,
            ...(routingDecision.provider ? [`Provider: ${routingDecision.provider}`] : []),
            ...(routingDecision.canonicalSourceOfTruth ? [`CanonicalSourceOfTruth: ${routingDecision.canonicalSourceOfTruth}`] : []),
            ...(routingDecision.executionProviderSource ? [`ExecutionProviderSource: ${routingDecision.executionProviderSource}`] : []),
            ...(routingDecision.identityStatus ? [`RuntimeIdentityStatus: ${routingDecision.identityStatus}`] : []),
            ...(routingDecision.routedTo ? [`RoutedTo: ${routingDecision.routedTo}`] : []),
            ...(routingDecision.reviewerSubagentLaunchStatus ? [`ReviewerSubagentLaunchStatus: ${routingDecision.reviewerSubagentLaunchStatus}`] : []),
            ...(routingDecision.reviewerSubagentLaunchRoute ? [`ReviewerSubagentLaunchRoute: ${routingDecision.reviewerSubagentLaunchRoute}`] : []),
            planSelection.diagnostic,
            ...(taskModeArtifact.plan ? [`PlanGuided: true`, `PlanPath: ${taskModeArtifact.plan.plan_path}`] : [`PlanGuided: false`]),
            ...(taskModeArtifact.markdown_working_plan
                ? [
                    `MarkdownWorkingPlanPath: ${taskModeArtifact.markdown_working_plan.working_plan_path}`,
                    `MarkdownWorkingPlanSha256: ${taskModeArtifact.markdown_working_plan.working_plan_sha256}`
                ]
                : []),
            ...formatTaskPlanDiagnostics(buildTaskPlanDiagnostics(repoRoot, taskId, taskModeArtifact)),
            ...(taskModeArtifact.profile_selection_source
                ? [`TaskProfile: ${taskModeArtifact.task_profile || 'default'} (${taskModeArtifact.profile_selection_source})`]
                : []),
            ...(taskModeArtifact.active_profile ? [`ActiveProfile: ${taskModeArtifact.active_profile} (${taskModeArtifact.profile_source || 'unknown'})`] : []),
            ...(taskModeArtifact.runtime_active_profile
                ? [`RuntimeActiveProfile: ${taskModeArtifact.runtime_active_profile} (${taskModeArtifact.runtime_profile_source || 'unknown'})`]
                : []),
            ...(taskModeArtifact.profile_policy_snapshot
                ? [`ProfilePolicySnapshotHash: ${taskModeArtifact.profile_policy_snapshot.snapshot_hash}`]
                : []),
            ...(plannedChangedFiles.length > 0 ? [`PlannedChangedFilesCount: ${plannedChangedFiles.length}`] : []),
            ...(protectedPlannedFiles.length > 0 ? [`PlannedProtectedFilesCount: ${protectedPlannedFiles.length}`] : []),
            `DirtyWorkspaceBaselineCount: ${taskModeArtifact.dirty_workspace_baseline?.changed_files.length || 0}`,
            `WorkflowConfigCompatibilityBaselineCount: ${taskModeArtifact.workflow_config_compatibility_baseline_files.length}`
        ],
        exitCode: 0
    };
}
