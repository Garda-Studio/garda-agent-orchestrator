import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isPlainRecord } from '../../../../core/records';
import { hasAuthenticatedZeroDiffAuditScope } from '../../../../gates/next-step/next-step-preflight-workspace-readiness';
import {
    emitMandatoryPreflightFailedEvent,
    emitMandatoryPreflightStartedEvent
} from '../../../../gate-runtime/lifecycle-events';
import { appendMandatoryTaskEvent, assertValidTaskId } from '../../../../gate-runtime/task-events';
import { acquireFilesystemLock, releaseFilesystemLock } from '../../../../gate-runtime/task-events-locking';
import { buildBudgetForecast, resolveDepthEscalation, resolveRiskAwareDepth } from '../../../../gate-runtime/budget-preflight';
import {
    classifyChange,
    getClassificationConfig,
    getReviewCapabilities,
    type ClassifyChangeResult
} from '../../../../gates/preflight/classify-change';
import {
    computeTaskPlanDigest,
    isApprovedPlan,
    validateTaskPlan
} from '../../../../schemas/task-plan';
import { buildGeneratedRuntimeArtifactHygieneWarnings } from '../../../../gates/shared/generated-runtime-artifacts';
import { loadReviewExecutionPolicyConfig } from '../../../../core/review-execution-policy';
import { loadFullSuiteValidationConfig } from '../../../../core/full-suite-validation-config';
import { readReviewCatalogConfigFile } from '../../../../core/review-catalog';
import { resolveTaskProfileSelection } from '../../../../policy/task-profile-selection';
import {
    buildEffectiveReviewSnapshot,
    collectKnownReviewSkillIds,
    resolveEffectiveReviewTaskIntent
} from '../../../../policy/effective-review-snapshot';
import {
    resolveLegacyCompatibilityReviewCatalogBinding,
    resolveProfileReviewCatalogPolicy
} from '../../../../policy/profile-review-catalog-policy';
import {
    resolveTaskProfileReviewTriggerPolicy,
    resolveTaskProfileSelectionFromSnapshot,
    summarizeTaskProfilePolicySnapshot
} from '../../../../policy/task-profile-policy-snapshot';
import { detectCodeChanged } from '../../../../gates/preflight/preflight-code-change';
import {
    applyTaskRequiredReviewDeclaration,
    resolveTaskRequiredReviewDeclaration
} from '../../../../gates/preflight/classify-change-task-required-reviews';
import {
    buildOptionalSkillSelectionArtifact,
    isMandatoryOptionalSkillSelectionPolicyMode,
    isOptionalSkillSelectionPolicyConfigured,
    readOptionalSkillSelectionPolicyConfig,
    type OptionalSkillPathEvidenceSource,
    type OptionalSkillSelectionPhase,
    writeOptionalSkillSelectionArtifact
} from '../../../../runtime/optional-skill-selection';
import { getWorkspaceSnapshotCached } from '../../../../gates/workspace/workspace-snapshot-cache';
import {
    parseSplitCheckpointDetectionSource,
    resolveAuthenticatedSplitCheckpointPreflightScope,
    resolveSplitCheckpointTaskScope
} from '../../../../gates/split-required/split-checkpoint-scope';
import { buildDomainScopeFingerprints } from '../../../../gates/scope/domain-scope-fingerprints';
import { loadIsolationModeConfig } from '../../../../gates/isolation/isolation-mode';
import { resolveIsolatedOrchestratorRoot, resolveGateExecutionPath } from '../../../../gates/isolation/isolation-sandbox';
import {
    buildStagedBaselineTrustInputFingerprint,
    deriveTaskOwnedDirtyWorkspaceScope,
    deriveProtectedDirtyWorkspaceScope,
    detectProtectedDirtyWorkspaceDrift
} from '../../../../gates/workspace/dirty-worktree-protection';
import { assessProtectedManifest } from '../../../../validators/protected-manifest-assessment';
import { evaluateProtectedManifestBaselineAllowance, getProtectedManifestLifecycleGuard } from '../../../../gates/protected-control-plane/protected-manifest-guard';
import { getTaskModeEvidence, getTaskModeEvidenceViolations } from '../../../../gates/task-mode/task-mode';
import {
    getCurrentWorkflowConfigChanges,
    getAuditedWorkflowConfigChangeProvenance,
    getWorkflowConfigChangedFiles,
    getWorkflowConfigControlPlanePaths,
    getWorkflowConfigWorkViolations
} from '../../../../gates/workflow-config/workflow-config-work';
import { readTaskQueueMetadata } from '../../../../gates/task-audit/task-audit-summary-collectors';
import { readSkillsHeadlinesIfPresent } from '../../../../runtime/skill-headlines-store';
import { getRulePackEvidence, getRulePackEvidenceViolations } from '../../../../gates/rule-pack/rule-pack';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { normalizeOptionalPath, removeArtifactIfExists, resolvePathForWrite, writeTextArtifact } from '../../../gate-cli/gates-artifacts';
import { expandValueList, parseBooleanOption, parseIntOption } from '../../../gate-cli/gates-parser';
import { getErrorMessage, resolveOrchestratorRoot, appendMetricsIfEnabled } from './gate-flow-helpers';
import { getTaskOwnedManifestChangedFiles } from './compile-flow-scope-guards';
import {
    buildClassifyChangeOrchestratorWorkRestartCommand,
    buildDomainReviewSurface,
    getChangedProtectedFiles,
    getClassificationRenameCount,
    isZeroDiffBaselineOnlyNoReviewableScope,
    listChangedFilesPredatingTaskMode,
    mergePathLists,
    readCurrentTaskSummary,
    resolveClassifyChangeOutputPath,
    resolveOptionalSkillTaskText,
    resolvePrePreflightSequenceLockPath,
    subtractPathList
} from './compile-flow-shared-evidence';
import {
    evaluateGateFlowStartupDiagnostics,
    evaluateGateFlowTimelineReadiness,
    resolveGateFlowTimelinePath
} from '../support/gate-flow-runtime';

function reconcileProfileGuardrailsWithRequiredReviews(
    guardrails: unknown,
    requiredReviews: Record<string, boolean>
): unknown {
    if (!guardrails || typeof guardrails !== 'object' || Array.isArray(guardrails)) {
        return guardrails;
    }
    const guardrailRecord = guardrails as Record<string, unknown>;
    if (!Array.isArray(guardrailRecord.decisions)) {
        return guardrails;
    }

    return {
        ...guardrailRecord,
        decisions: guardrailRecord.decisions.map((decision) => {
            if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
                return decision;
            }
            const decisionRecord = decision as Record<string, unknown>;
            const reviewType = typeof decisionRecord.review_type === 'string' ? decisionRecord.review_type : '';
            if (!reviewType) {
                return decision;
            }
            if (requiredReviews[reviewType] !== true && decisionRecord.effective_value === true) {
                return {
                    ...decisionRecord,
                    effective_value: false,
                    decision: 'not_required_by_preflight',
                    reason: `${reviewType} review not required because preflight required_reviews.${reviewType}=false; profile diagnostics must match lifecycle review requirements`
                };
            }
            if (requiredReviews[reviewType] !== true || decisionRecord.effective_value === true) {
                return decision;
            }

            return {
                ...decisionRecord,
                effective_value: true,
                decision: 'preflight_required',
                reason: `${reviewType} review kept because preflight required_reviews.${reviewType}=true; profile diagnostics must match lifecycle review requirements`
            };
        })
    };
}

export function applyEffectiveTaskPolicyToPreflightResult(
    result: ClassifyChangeResult,
    effectiveTaskPolicy: ReturnType<typeof resolveTaskProfileSelection>['effective_policy']
): void {
    const guardrailDecisions = new Map(
        (effectiveTaskPolicy.guardrail_diagnostics?.decisions || []).map((decision) => [decision.review_type, decision])
    );
    for (const [reviewType, currentValue] of Object.entries(result.required_reviews)) {
        const guardrailDecision = guardrailDecisions.get(reviewType);
        if (guardrailDecision?.decision === 'zero_diff_no_reviewable_scope') {
            result.required_reviews[reviewType] = false;
        } else if (currentValue === true) {
            result.required_reviews[reviewType] = true;
        } else if (
            guardrailDecision?.effective_value === true
            && (
                guardrailDecision.profile_wanted === true
                || guardrailDecision.decision === 'profile_forced'
                || guardrailDecision.decision === 'domain_triggered'
            )
        ) {
            result.required_reviews[reviewType] = true;
        } else {
            result.required_reviews[reviewType] = false;
        }
    }
    result.profile_guardrails = reconcileProfileGuardrailsWithRequiredReviews(
        effectiveTaskPolicy.guardrail_diagnostics,
        result.required_reviews
    );
}

function parseFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function isLocalizationOnlyReviewTriggerScope(result: ClassifyChangeResult): boolean {
    return result.triggers.ui_i18n_review_trigger_suppressed === true
        && result.triggers.ui_i18n_companion_driver_files.length === 0
        && result.triggers.ui_i18n_companion_files.length > 0;
}

function getReviewTriggerEffectiveMetric(
    result: ClassifyChangeResult,
    rawMetric: 'changed_files_count' | 'changed_lines_total'
): number {
    if (result.triggers.ui_i18n_review_trigger_suppressed !== true && result.triggers.ui_i18n_companion_scope !== true) {
        return result.metrics[rawMetric];
    }
    const effectiveValue = rawMetric === 'changed_files_count'
        ? result.metrics.review_trigger_effective_changed_files_count
        : result.metrics.review_trigger_effective_changed_lines_total;
    return parseFiniteNumber(effectiveValue)
        ?? result.metrics[rawMetric];
}

function normalizePortablePathList(paths: readonly string[] | null | undefined): string[] {
    return [...new Set((Array.isArray(paths) ? paths : [])
        .map((entry) => String(entry || '').replace(/\\/g, '/').trim())
        .filter(Boolean))]
        .sort();
}

function pathScopeContainsAll(scopePaths: readonly string[], changedPaths: readonly string[]): boolean {
    if (changedPaths.length === 0) {
        return true;
    }
    const scope = new Set(normalizePortablePathList(scopePaths));
    return normalizePortablePathList(changedPaths).every((entry) => scope.has(entry));
}

function resolveOptionalSkillSelectionPhaseInput(input: {
    changedFiles: readonly string[];
    plannedChangedFiles: readonly string[];
    taskPlanScopeFiles: readonly string[];
    explicitChangedFilesProvided: boolean;
}): {
    selectionPhase: OptionalSkillSelectionPhase;
    pathEvidenceSource: OptionalSkillPathEvidenceSource;
} {
    const changedFiles = normalizePortablePathList(input.changedFiles);
    if (changedFiles.length === 0) {
        return {
            selectionPhase: 'pre_implementation',
            pathEvidenceSource: 'none'
        };
    }
    if (pathScopeContainsAll(input.plannedChangedFiles, changedFiles)) {
        return {
            selectionPhase: 'pre_implementation',
            pathEvidenceSource: 'planned_changed_files'
        };
    }
    if (pathScopeContainsAll(input.taskPlanScopeFiles, changedFiles)) {
        return {
            selectionPhase: 'pre_implementation',
            pathEvidenceSource: 'task_plan_scope'
        };
    }
    if (input.explicitChangedFilesProvided) {
        return {
            selectionPhase: 'pre_implementation',
            pathEvidenceSource: 'explicit_scope'
        };
    }
    return {
        selectionPhase: 'post_diff',
        pathEvidenceSource: 'actual_changed_files'
    };
}

function readApprovedTaskPlanScopeFiles(
    repoRoot: string,
    taskId: string,
    taskModeEvidence: ReturnType<typeof getTaskModeEvidence>
): string[] {
    const planMetadata = taskModeEvidence.plan;
    if (!planMetadata?.plan_path || !planMetadata.plan_sha256) {
        return [];
    }
    try {
        const planFilePath = gateHelpers.resolvePathInsideRepo(planMetadata.plan_path, repoRoot, { allowMissing: false });
        if (!planFilePath || !fs.existsSync(planFilePath) || !fs.statSync(planFilePath).isFile()) {
            return [];
        }
        const validatedPlan = validateTaskPlan(JSON.parse(fs.readFileSync(planFilePath, 'utf8')));
        if (validatedPlan.task_id !== taskId || !isApprovedPlan(validatedPlan)) {
            return [];
        }
        const currentDigest = computeTaskPlanDigest(validatedPlan);
        if (currentDigest !== planMetadata.plan_sha256) {
            return [];
        }
        return normalizePortablePathList(validatedPlan.scope_files);
    } catch {
        return [];
    }
}

export interface ClassifyChangeCommandOptions {
    repoRoot?: string;
    changedFiles?: unknown;
    detectionSource?: unknown;
    includeUntracked?: unknown;
    useStaged?: boolean;
    taskIntent?: unknown;
    fastPathMaxFiles?: unknown;
    fastPathMaxChangedLines?: unknown;
    performanceHeuristicMinLines?: unknown;
    taskId?: unknown;
    taskModePath?: string;
    rulePackPath?: string;
    forceAllDomainReviews?: unknown;
    forceCodeReview?: unknown;
    outputPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

interface PreflightFailureDiagnostics {
    reason_code: string;
    pre_task_modified_files?: string[];
    dirty_workspace_baseline_changed_files?: string[];
    current_workspace_changed_files?: string[];
    authorized_scope_changed_files?: string[];
    changed_protected_files?: string[];
    detection_source?: string;
    explicit_changed_files_provided?: boolean;
    use_staged?: boolean;
    include_untracked?: boolean;
}

export function runClassifyChangeCommand(options: ClassifyChangeCommandOptions): { outputText: string } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const resolvedTaskId = gateHelpers.resolveTaskId(options.taskId || '', options.outputPath || '');
    const resolvedTaskModePath = String(options.taskModePath || '');
    if (resolvedTaskId) {
        assertValidTaskId(resolvedTaskId);
        const includeUntrackedForStart = parseBooleanOption(options.includeUntracked, options.useStaged ? false : true);
        emitMandatoryPreflightStartedEvent(orchestratorRoot, resolvedTaskId, {
            task_intent: String(options.taskIntent || ''),
            include_untracked: includeUntrackedForStart,
            use_staged: options.useStaged === true
        });
    }

    let prePreflightSequenceLockHandle: ReturnType<typeof acquireFilesystemLock>['handle'] | null = null;
    let preflightFailureDiagnostics: PreflightFailureDiagnostics | null = null;
    try {
    const explicitChangedFilesProvided = options.changedFiles !== undefined;
    const explicitChangedFiles = expandValueList(options.changedFiles, { splitDelimiters: true });
    const includeUntracked = parseBooleanOption(options.includeUntracked, options.useStaged ? false : true);
    const requestedDetectionSource = String(options.detectionSource || '').trim().toLowerCase();
    const requestedSplitCheckpointRange = parseSplitCheckpointDetectionSource(requestedDetectionSource);
    if (requestedDetectionSource && !requestedSplitCheckpointRange) {
        throw new Error(`Unsupported classify-change detection source override '${requestedDetectionSource}'.`);
    }
    const detectionSource = requestedSplitCheckpointRange
        ? requestedDetectionSource
        : explicitChangedFilesProvided
        ? 'explicit_changed_files'
        : (options.useStaged ? (includeUntracked ? 'git_staged_plus_untracked' : 'git_staged_only') : 'git_auto');
    const ordinaryWorkspaceSnapshot = requestedSplitCheckpointRange
        ? null
        : getWorkspaceSnapshotCached(
            repoRoot,
            detectionSource,
            includeUntracked,
            explicitChangedFiles
        );
    const splitCheckpointResolution = resolvedTaskId
        && (requestedSplitCheckpointRange
            || (!explicitChangedFilesProvided
                && options.useStaged !== true
                && ordinaryWorkspaceSnapshot?.changed_files.length === 0))
        ? resolveSplitCheckpointTaskScope(repoRoot, resolvedTaskId)
        : { scope: null, violation: null };
    if (splitCheckpointResolution.violation) {
        throw new Error(splitCheckpointResolution.violation);
    }
    if (requestedSplitCheckpointRange && !splitCheckpointResolution.scope) {
        throw new Error(
            'Split checkpoint detection source override requires authenticated split checkpoint scope for this task.'
        );
    }
    if (requestedSplitCheckpointRange) {
        resolveAuthenticatedSplitCheckpointPreflightScope(
            repoRoot,
            resolvedTaskId,
            requestedDetectionSource,
            explicitChangedFiles
        );
    }
    const workspaceSnapshot = splitCheckpointResolution.scope
        ? getWorkspaceSnapshotCached(
            repoRoot,
            splitCheckpointResolution.scope.detection_source,
            false,
            requestedSplitCheckpointRange ? explicitChangedFiles : splitCheckpointResolution.scope.changed_files,
            { noCache: true, readOnly: true }
        )
        : ordinaryWorkspaceSnapshot!;
    const authorizedFiles = Array.isArray(workspaceSnapshot.authorized_files)
        ? workspaceSnapshot.authorized_files
        : workspaceSnapshot.changed_files;
    const renameCount = getClassificationRenameCount(
        repoRoot,
        workspaceSnapshot.detection_source,
        workspaceSnapshot.changed_files
    );
    const taskModeEvidenceForClassification = resolvedTaskId
        ? getTaskModeEvidence(repoRoot, resolvedTaskId, resolvedTaskModePath)
        : null;
    const snapshotReviewTriggerPolicy = taskModeEvidenceForClassification?.evidence_status === 'PASS'
        && taskModeEvidenceForClassification.profile_policy_snapshot_status === 'PASS'
        && taskModeEvidenceForClassification.profile_policy_snapshot
        ? resolveTaskProfileReviewTriggerPolicy(taskModeEvidenceForClassification.profile_policy_snapshot)
        : undefined;
    const classificationConfig = getClassificationConfig(repoRoot, {
        reviewTriggerPolicy: snapshotReviewTriggerPolicy
    });
    const reviewCapabilities = getReviewCapabilities(repoRoot);
    const reviewExecutionPolicy = loadReviewExecutionPolicyConfig(repoRoot);
    const isSourceCheckout = gateHelpers.isOrchestratorSourceCheckout(repoRoot);
    const result: ClassifyChangeResult = classifyChange({
        normalizedFiles: authorizedFiles,
        repoRoot,
        isSourceCheckout,
        taskIntent: String(options.taskIntent || ''),
        fastPathMaxFiles: parseIntOption(options.fastPathMaxFiles, 2, 1),
        fastPathMaxChangedLines: parseIntOption(options.fastPathMaxChangedLines, 40, 1),
        performanceHeuristicMinLines: parseIntOption(options.performanceHeuristicMinLines, 120, 1),
        changedLinesTotal: workspaceSnapshot.changed_lines_total,
        additionsTotal: workspaceSnapshot.additions_total,
        deletionsTotal: workspaceSnapshot.deletions_total,
        changedFileStats: (workspaceSnapshot as Record<string, unknown>).changed_file_stats as
            | Record<string, { additions: number; deletions: number; changed_lines: number }>
            | undefined,
        renameCount,
        detectionSource: workspaceSnapshot.detection_source,
        classificationConfig,
        reviewCapabilities,
        reviewExecutionPolicyMode: reviewExecutionPolicy.mode
    });
    (result as unknown as Record<string, unknown>).authorized_files = authorizedFiles;
    result.changed_files = workspaceSnapshot.changed_files;
    const actualZeroDiffDetected = workspaceSnapshot.changed_files.length === 0;
    result.zero_diff_guard = {
        zero_diff_detected: actualZeroDiffDetected,
        status: actualZeroDiffDetected ? 'BASELINE_ONLY' : 'DIFF_PRESENT',
        completion_requires_audited_no_op: actualZeroDiffDetected,
        no_op_artifact_suffix: actualZeroDiffDetected ? '-no-op.json' : null,
        rationale: actualZeroDiffDetected
            ? 'Preflight authorized planned scope has no current Git diff. Task completion requires a produced diff or an audited no-op artifact.'
            : 'Workspace diff detected.'
    };
    result.git_change_classification = workspaceSnapshot.git_change_classification;
    (result.metrics as unknown as Record<string, unknown>).authorized_files_count = authorizedFiles.length;
    (result.metrics as unknown as Record<string, unknown>).authorized_files_sha256 = workspaceSnapshot.authorized_files_sha256;
    result.metrics.changed_files_count = workspaceSnapshot.changed_files_count;
    result.metrics.changed_files_sha256 = workspaceSnapshot.changed_files_sha256;
    result.metrics.scope_content_sha256 = workspaceSnapshot.scope_content_sha256;
    result.metrics.scope_sha256 = workspaceSnapshot.scope_sha256;
    (result.metrics as unknown as Record<string, unknown>).actual_changed_files = workspaceSnapshot.changed_files;
    (result.metrics as unknown as Record<string, unknown>).actual_changed_files_count = workspaceSnapshot.changed_files_count;
    (result.metrics as unknown as Record<string, unknown>).actual_changed_files_sha256 = workspaceSnapshot.changed_files_sha256;
    result.metrics.domain_scope_fingerprints = buildDomainScopeFingerprints({
        repoRoot,
        detectionSource: workspaceSnapshot.detection_source,
        includeUntracked: !!workspaceSnapshot.include_untracked,
        changedFiles: workspaceSnapshot.changed_files,
        classificationConfig
    });
    if (splitCheckpointResolution.scope) {
        result.split_checkpoint_scope = splitCheckpointResolution.scope;
    }
    const ignoredGeneratedRuntimeFiles = Array.isArray((workspaceSnapshot as Record<string, unknown>).ignored_generated_runtime_files)
        ? ((workspaceSnapshot as Record<string, unknown>).ignored_generated_runtime_files as string[])
        : [];
    if (ignoredGeneratedRuntimeFiles.length > 0) {
        result.metrics.ignored_generated_runtime_files_count = ignoredGeneratedRuntimeFiles.length;
        result.triggers.ignored_generated_runtime_files = ignoredGeneratedRuntimeFiles;
        result.workspace_hygiene_warnings = buildGeneratedRuntimeArtifactHygieneWarnings(ignoredGeneratedRuntimeFiles);
    }

    const protectedFilesSnapshot = gateHelpers.scanProtectedPathHashes(
        repoRoot,
        gateHelpers.getProtectedControlPlaneRoots(repoRoot)
    );
    const protectedFilesSnapshotSha256 = gateHelpers.computeProtectedSnapshotDigest(protectedFilesSnapshot);
    const protectedManifestEvidence = gateHelpers.evaluateProtectedControlPlaneManifest(
        repoRoot,
        protectedFilesSnapshot
    );
    result.triggers.protected_control_plane_snapshot_sha256 = protectedFilesSnapshotSha256;
    result.triggers.protected_control_plane_manifest_status = protectedManifestEvidence.status;
    result.triggers.protected_control_plane_manifest_path = protectedManifestEvidence.manifest_path;
    result.triggers.protected_control_plane_manifest_changed_files = protectedManifestEvidence.changed_files;
    let protectedManifestAssessment = assessProtectedManifest({
        evidence: protectedManifestEvidence
    });

    const isolationConfig = loadIsolationModeConfig(repoRoot);
    result.triggers.isolation_mode_enabled = isolationConfig.enabled;
    result.triggers.isolation_mode_enforcement = isolationConfig.enforcement;
    result.triggers.isolation_mode_use_sandbox = isolationConfig.use_sandbox;

    const sandboxResolution = resolveIsolatedOrchestratorRoot(repoRoot);
    result.triggers.isolation_sandbox_active = sandboxResolution.using_sandbox;
    result.triggers.isolation_sandbox_resolved_root = gateHelpers.normalizePath(sandboxResolution.resolved_root);
    result.triggers.isolation_sandbox_reason = sandboxResolution.reason;

    let isolationViolationMessage: string | null = null;
    if (isolationConfig.enabled && isolationConfig.require_manifest_match_before_task) {
        if (protectedManifestEvidence.status === 'MISSING') {
            const msg = 'Control-plane isolation requires a trusted manifest, but none was found. Run setup/update/reinit to generate one.';
            if (isolationConfig.enforcement === 'STRICT') {
                isolationViolationMessage = msg;
            }
            result.triggers.isolation_mode_pre_task_warning = msg;
        } else if (protectedManifestEvidence.status === 'INVALID') {
            const msg = `Trusted control-plane manifest at '${gateHelpers.normalizePath(protectedManifestEvidence.manifest_path)}' is malformed. Re-run setup/update/reinit.`;
            if (isolationConfig.enforcement === 'STRICT') {
                isolationViolationMessage = msg;
            }
            result.triggers.isolation_mode_pre_task_warning = msg;
        } else if (protectedManifestEvidence.status === 'DRIFT' && isolationConfig.refuse_on_preflight_drift) {
            const msg = `Control-plane isolation detected drift in ${protectedManifestEvidence.changed_files.length} file(s) before task start: ${protectedManifestEvidence.changed_files.join(', ')}. Refresh the trusted manifest or disable isolation mode.`;
            if (isolationConfig.enforcement === 'STRICT') {
                isolationViolationMessage = msg;
            }
            result.triggers.isolation_mode_pre_task_warning = msg;
        }
    }
    if (isolationViolationMessage) {
        result.isolation_mode_violation = isolationViolationMessage;
    }

    let currentTaskSummary: string | null = null;
    let effectiveTaskPolicy: ReturnType<typeof resolveTaskProfileSelection>['effective_policy'] | null = null;
    let zeroDiffBaselineOnlyNoReviewableScope = false;
    if (resolvedTaskId) {
        prePreflightSequenceLockHandle = acquireFilesystemLock(
            resolvePrePreflightSequenceLockPath(repoRoot, resolvedTaskId),
            {}
        ).handle;
        result.task_id = resolvedTaskId;

        const preflightErrors: string[] = [];
        const taskModeEvidence = taskModeEvidenceForClassification!;
        const taskQueueMetadata = readTaskQueueMetadata(repoRoot, resolvedTaskId);
        currentTaskSummary = readCurrentTaskSummary(repoRoot, resolvedTaskId, taskModeEvidence.task_summary);
        let trustedWorkflowConfigBaselineFiles: string[] = [];
        const rawTaskProfile = taskModeEvidence.task_profile || taskQueueMetadata?.profile || null;
        const profilesConfigPath = path.join(orchestratorRoot, 'live', 'config', 'profiles.json');
        try {
            const taskRequiredReviewDeclaration = resolveTaskRequiredReviewDeclaration({
                taskId: resolvedTaskId,
                notes: taskQueueMetadata?.notes,
                reviewCapabilities
            });
            if (taskRequiredReviewDeclaration) {
                result.task_required_review_declaration = taskRequiredReviewDeclaration;
                applyTaskRequiredReviewDeclaration(result.required_reviews, taskRequiredReviewDeclaration);
            }
        } catch (error: unknown) {
            preflightErrors.push(error instanceof Error ? error.message : String(error));
        }
        const domainSurface = buildDomainReviewSurface(result);
        const zeroDiffReviewPolicyRefreshAllowed = !parseBooleanOption(options.forceAllDomainReviews, false)
            && !parseBooleanOption(options.forceCodeReview, false)
            && (result.task_required_review_declaration?.applied_reviews.length || 0) === 0;
        (result.triggers as unknown as Record<string, unknown>).zero_diff_review_policy_refresh_allowed =
            actualZeroDiffDetected && zeroDiffReviewPolicyRefreshAllowed;
        let authenticatedNoOpScope = false;
        if (actualZeroDiffDetected && zeroDiffReviewPolicyRefreshAllowed && result.detection_source === 'git_staged_only') {
            try {
                const previousPath = gateHelpers.joinOrchestratorPath(repoRoot,
                    path.join('runtime', 'reviews', `${resolvedTaskId}-preflight.json`));
                const previous: unknown = JSON.parse(fs.readFileSync(previousPath, 'utf8'));
                if (isPlainRecord(previous) && isPlainRecord(previous.metrics)
                    && isPlainRecord(previous.triggers)
                    && previous.task_id === resolvedTaskId
                    && previous.triggers.zero_diff_review_policy_refresh_allowed === true
                    && (previous.detection_source === 'explicit_changed_files'
                        || (previous.detection_source === result.detection_source
                            && previous.metrics.scope_sha256 === result.metrics.scope_sha256
                            && previous.metrics.scope_content_sha256 === result.metrics.scope_content_sha256
                            && previous.metrics.changed_files_sha256 === result.metrics.changed_files_sha256))) {
                    authenticatedNoOpScope = hasAuthenticatedZeroDiffAuditScope(repoRoot, previous);
                }
            } catch {
                // Initial or malformed preflight evidence cannot remove profile reviews.
            }
        }
        const profileGuardrailOptions = {
            domainSurface,
            forceAllDomainReviews: parseBooleanOption(options.forceAllDomainReviews, false),
            forceCodeReview: parseBooleanOption(options.forceCodeReview, false),
            localizationOnlyScope: isLocalizationOnlyReviewTriggerScope(result),
            protectedControlPlaneChanged: result.triggers.protected_control_plane_changed === true,
            protectedControlPlaneDocsOnly: result.triggers.protected_control_plane_docs_only === true,
            zeroDiffBaselineOnly: zeroDiffReviewPolicyRefreshAllowed && isZeroDiffBaselineOnlyNoReviewableScope(
                result,
                domainSurface,
                taskModeEvidence.planned_changed_files || [],
                taskModeEvidence.dirty_workspace_baseline?.changed_files || [],
                authenticatedNoOpScope
            )
        };
        zeroDiffBaselineOnlyNoReviewableScope = profileGuardrailOptions.zeroDiffBaselineOnly;
        if (
            taskModeEvidence.evidence_status === 'PASS'
            && taskModeEvidence.profile_policy_snapshot_status === 'PASS'
            && taskModeEvidence.profile_policy_snapshot
        ) {
            try {
                const resolvedProfile = resolveTaskProfileSelectionFromSnapshot(
                    taskModeEvidence.profile_policy_snapshot,
                    typeof result.scope_category === 'string' ? result.scope_category : null,
                    profileGuardrailOptions
                );
                effectiveTaskPolicy = resolvedProfile.effective_policy;
                result.profile_selection = resolvedProfile.selection;
                result.profile_policy_snapshot = summarizeTaskProfilePolicySnapshot(taskModeEvidence.profile_policy_snapshot);
                result.review_execution_policy = {
                    mode: taskModeEvidence.profile_policy_snapshot.review_execution_policy.mode,
                    visible_summary_line: taskModeEvidence.profile_policy_snapshot.review_execution_policy.visible_summary_line
                };
                applyEffectiveTaskPolicyToPreflightResult(result, effectiveTaskPolicy);
            } catch (error: unknown) {
                preflightErrors.push(error instanceof Error ? error.message : String(error));
            }
        } else if (taskModeEvidence.profile_policy_snapshot_status === 'PASS' && taskModeEvidence.profile_policy_snapshot) {
            preflightErrors.push(
                `Task-mode profile policy snapshot is not reusable because task-mode evidence is ${taskModeEvidence.evidence_status}. ` +
                `${getTaskModeEvidenceViolations(taskModeEvidence).join(' ') || 'Snapshot evidence validation failed.'}`
            );
        } else if (
            fs.existsSync(profilesConfigPath)
            && fs.statSync(profilesConfigPath).isFile()
            && taskModeEvidence.evidence_status === 'PASS'
        ) {
            preflightErrors.push(
                `Task-mode profile policy snapshot is required but not reusable (${taskModeEvidence.profile_policy_snapshot_status}). ` +
                `${taskModeEvidence.profile_policy_snapshot_violations.join(' ') || 'Profile policy snapshot is missing from task-mode evidence.'}`
            );
        } else if (fs.existsSync(profilesConfigPath) && fs.statSync(profilesConfigPath).isFile()) {
            try {
                const resolvedProfile = resolveTaskProfileSelection(
                    orchestratorRoot,
                    rawTaskProfile,
                    typeof result.scope_category === 'string' ? result.scope_category : null,
                    profileGuardrailOptions
                );
                effectiveTaskPolicy = resolvedProfile.effective_policy;
                result.profile_selection = resolvedProfile.selection;
                applyEffectiveTaskPolicyToPreflightResult(result, effectiveTaskPolicy);
            } catch (error: unknown) {
                preflightErrors.push(error instanceof Error ? error.message : String(error));
            }
        } else if (String(rawTaskProfile || '').trim() && String(rawTaskProfile || '').trim().toLowerCase() !== 'default') {
            preflightErrors.push(
                `Task profile '${String(rawTaskProfile).trim()}' cannot be resolved because profiles config is missing: ${gateHelpers.normalizePath(profilesConfigPath)}`
            );
        }
        const dirtyWorkspaceBaseline = taskModeEvidence.dirty_workspace_baseline;
        const dirtyWorkspaceTaskOwnedScope = deriveTaskOwnedDirtyWorkspaceScope(
            repoRoot,
            dirtyWorkspaceBaseline,
            workspaceSnapshot.changed_files,
            {
                isExplicitTaskScope: explicitChangedFilesProvided || options.useStaged === true,
                plannedChangedFiles: taskModeEvidence.planned_changed_files || [],
                useStaged: options.useStaged === true
            }
        );
        const dirtyWorkspaceProtectedScope = deriveProtectedDirtyWorkspaceScope(
            repoRoot,
            dirtyWorkspaceBaseline,
            dirtyWorkspaceTaskOwnedScope?.owned_files || []
        );
        const dirtyWorkspaceProtectionDrift = detectProtectedDirtyWorkspaceDrift(
            repoRoot,
            dirtyWorkspaceProtectedScope
        );
        if (dirtyWorkspaceTaskOwnedScope) {
            result.triggers.dirty_workspace_task_owned_files = dirtyWorkspaceTaskOwnedScope.owned_files;
            result.triggers.dirty_workspace_task_owned_files_sha256 = dirtyWorkspaceTaskOwnedScope.owned_files_sha256;
            result.triggers.dirty_workspace_untouched_baseline_files = dirtyWorkspaceTaskOwnedScope.untouched_preexisting_files;
            result.triggers.dirty_workspace_staged_baseline_trust_status =
                dirtyWorkspaceTaskOwnedScope.staged_baseline_trust_status;
            result.triggers.dirty_workspace_staged_baseline_trust_violations =
                dirtyWorkspaceTaskOwnedScope.staged_baseline_trust_violations;
            result.triggers.dirty_workspace_staged_baseline_trust_input_sha256 =
                buildStagedBaselineTrustInputFingerprint(dirtyWorkspaceBaseline, repoRoot);
            if (dirtyWorkspaceTaskOwnedScope.staged_baseline_trust_status === 'FAIL') {
                preflightErrors.push(...dirtyWorkspaceTaskOwnedScope.staged_baseline_trust_violations);
            }
        }
        preflightErrors.push(...getTaskModeEvidenceViolations(taskModeEvidence));
        const workflowConfigChanges = getCurrentWorkflowConfigChanges(
            repoRoot,
            taskModeEvidence.workflow_config_file_hashes
        );
        const changedWorkflowConfigFiles = mergePathLists(
            workflowConfigChanges.changed_files,
            workflowConfigChanges.baseline_file_hashes
                ? []
                : getWorkflowConfigChangedFiles(result.changed_files, getWorkflowConfigControlPlanePaths(repoRoot))
        );
        trustedWorkflowConfigBaselineFiles = workflowConfigChanges.baseline_file_hashes && changedWorkflowConfigFiles.length === 0
            ? getWorkflowConfigControlPlanePaths(repoRoot)
            : [];
        result.triggers.changed_workflow_config_files = changedWorkflowConfigFiles;
        result.triggers.workflow_config_file_hashes = workflowConfigChanges.current_file_hashes;
        if (workflowConfigChanges.scan_error) {
            result.triggers.workflow_config_workspace_scan_error = workflowConfigChanges.scan_error;
        }
        const auditedWorkflowConfigProvenance = getAuditedWorkflowConfigChangeProvenance({
            repoRoot,
            changedFiles: changedWorkflowConfigFiles,
            currentFileHashes: workflowConfigChanges.current_file_hashes,
            taskId: taskModeEvidence.task_id
        });
        if (auditedWorkflowConfigProvenance.records.length > 0 || auditedWorkflowConfigProvenance.unaudited_files.length > 0) {
            result.triggers.workflow_config_audit_provenance = auditedWorkflowConfigProvenance;
        }
        const acceptedAuditedWorkflowConfigFiles = auditedWorkflowConfigProvenance.accepted
            ? auditedWorkflowConfigProvenance.audited_files
            : [];
        const changedProtectedFiles = mergePathLists(
            subtractPathList(getChangedProtectedFiles(result), [
                ...trustedWorkflowConfigBaselineFiles,
                ...acceptedAuditedWorkflowConfigFiles
            ]),
            auditedWorkflowConfigProvenance.accepted ? [] : changedWorkflowConfigFiles
        );
        result.triggers.changed_protected_files = changedProtectedFiles;
        result.triggers.protected_control_plane_changed = changedProtectedFiles.length > 0;
        if (preflightErrors.length === 0) {
            preflightErrors.push(...getWorkflowConfigWorkViolations({
                repoRoot,
                changedFiles: changedWorkflowConfigFiles,
                taskModeEvidence,
                phaseLabel: 'preflight classification',
                baselineFileHashes: workflowConfigChanges.baseline_file_hashes,
                currentFileHashes: workflowConfigChanges.current_file_hashes
            }));
        }
        if (
            preflightErrors.length === 0
            && changedProtectedFiles.length > 0
            && taskModeEvidence.orchestrator_work !== true
        ) {
            preflightFailureDiagnostics = {
                reason_code: 'protected_scope_requires_orchestrator_work',
                authorized_scope_changed_files: normalizePortablePathList(authorizedFiles),
                changed_protected_files: normalizePortablePathList(changedProtectedFiles),
                detection_source: workspaceSnapshot.detection_source,
                explicit_changed_files_provided: explicitChangedFilesProvided,
                use_staged: options.useStaged === true,
                include_untracked: includeUntracked
            };
            preflightErrors.push(
                `Preflight scope touches protected orchestrator control-plane files without task-mode --orchestrator-work: ${changedProtectedFiles.join(', ')}. ` +
                'Restart task mode as orchestrator work before preflight classification. ' +
                `Suggested command: ${buildClassifyChangeOrchestratorWorkRestartCommand({
                    repoRoot,
                    taskId: resolvedTaskId,
                    taskModeEvidence,
                    taskSummary: currentTaskSummary,
                    changedFiles: authorizedFiles
                })}`
            );
        }

        if (dirtyWorkspaceBaseline) {
            result.triggers.dirty_workspace_baseline_changed_files = dirtyWorkspaceBaseline.changed_files;
            result.triggers.dirty_workspace_baseline_changed_files_sha256 = dirtyWorkspaceBaseline.changed_files_sha256;
            result.triggers.dirty_workspace_protected_files = dirtyWorkspaceProtectedScope?.protected_files || [];
            result.triggers.dirty_workspace_protected_files_sha256 =
                dirtyWorkspaceProtectedScope?.protected_files_sha256 || null;
            result.triggers.dirty_workspace_protected_file_hashes =
                dirtyWorkspaceProtectedScope?.protected_file_hashes || {};
            result.triggers.dirty_workspace_protection_status = dirtyWorkspaceProtectionDrift.status;
            result.triggers.dirty_workspace_protection_assessment = dirtyWorkspaceProtectionDrift.assessment;
            result.triggers.dirty_workspace_protection_changed_files = dirtyWorkspaceProtectionDrift.changed_files;
        }
        const protectedManifestBaselineAllowance = evaluateProtectedManifestBaselineAllowance({
            orchestratorWork: taskModeEvidence.orchestrator_work === true,
            manifestStatus: protectedManifestEvidence.status,
            manifestChangedFiles: protectedManifestEvidence.changed_files,
            dirtyWorkspaceProtectionStatus: dirtyWorkspaceProtectionDrift.status,
            dirtyWorkspaceProtectedFiles: dirtyWorkspaceProtectedScope?.protected_files || [],
            sourceCheckoutInheritedDrift: protectedManifestEvidence.manifest?.is_source_checkout === true
                && gateHelpers.isOrchestratorSourceCheckout(repoRoot)
        });
        result.triggers.protected_control_plane_manifest_baseline_allowance_status =
            protectedManifestBaselineAllowance.status;
        protectedManifestAssessment = assessProtectedManifest({
            evidence: protectedManifestEvidence,
            baselineAllowanceStatus: protectedManifestBaselineAllowance.status,
            orchestratorWork: taskModeEvidence.orchestrator_work === true
        });

        const rulePackEvidence = getRulePackEvidence(repoRoot, resolvedTaskId, 'TASK_ENTRY', {
            artifactPath: String(options.rulePackPath || ''),
            taskModePath: String(options.taskModePath || '')
        });
        preflightErrors.push(...getRulePackEvidenceViolations(rulePackEvidence));

        const timelinePath = resolveGateFlowTimelinePath(repoRoot, resolvedTaskId);
        const timelineReadiness = evaluateGateFlowTimelineReadiness({
            orchestratorRoot,
            repoRoot,
            taskId: resolvedTaskId,
            timelinePath,
            requirements: [
                { eventType: 'TASK_MODE_ENTERED', recoveryInstruction: 'Run enter-task-mode before preflight.' },
                { eventType: 'RULE_PACK_LOADED', recoveryInstruction: 'Run load-rule-pack before preflight.' },
                { eventType: 'HANDSHAKE_DIAGNOSTICS_RECORDED', recoveryInstruction: 'Run handshake-diagnostics before preflight.' },
                { eventType: 'SHELL_SMOKE_PREFLIGHT_RECORDED', recoveryInstruction: 'Run shell-smoke-preflight before preflight.' }
            ]
        });
        preflightErrors.push(...timelineReadiness.violations);
        if (preflightErrors.length === 0) {
            preflightErrors.push(...evaluateGateFlowStartupDiagnostics({
                repoRoot,
                taskId: resolvedTaskId,
                taskModePath: options.taskModePath || '',
                timelinePath
            }));
        }
        const hasExplicitScopeIsolation = explicitChangedFilesProvided || options.useStaged === true;
        if (preflightErrors.length === 0 && !hasExplicitScopeIsolation) {
            const preTaskModifiedFiles = dirtyWorkspaceBaseline
                ? subtractPathList(dirtyWorkspaceBaseline.changed_files, trustedWorkflowConfigBaselineFiles)
                : listChangedFilesPredatingTaskMode(
                    repoRoot,
                    subtractPathList(workspaceSnapshot.changed_files, trustedWorkflowConfigBaselineFiles),
                    taskModeEvidence.evidence_path
                );
            if (preTaskModifiedFiles.length > 0) {
                preflightFailureDiagnostics = {
                    reason_code: 'dirty_baseline_requires_explicit_scope',
                    pre_task_modified_files: normalizePortablePathList(preTaskModifiedFiles),
                    dirty_workspace_baseline_changed_files: normalizePortablePathList(dirtyWorkspaceBaseline?.changed_files),
                    current_workspace_changed_files: normalizePortablePathList(workspaceSnapshot.changed_files),
                    explicit_changed_files_provided: explicitChangedFilesProvided,
                    use_staged: options.useStaged === true,
                    include_untracked: includeUntracked
                };
                preflightErrors.push(
                    `Workspace already contained modified files before task-mode entry: ${preTaskModifiedFiles.join(', ')}. ` +
                    'This run is invalid as a normal orchestrated task start because task-mode entry must happen before any edits. ' +
                    'The optional start marker is a one-time orchestrator-mode UX marker, not a file-state claim. ' +
                    'Clean/stash unrelated changes, or rerun classify-change with --use-staged or explicit --changed-file scope after entering task mode.'
                );
            }
        }
        if (preflightErrors.length === 0 && hasExplicitScopeIsolation && dirtyWorkspaceProtectionDrift.status === 'DRIFT_DETECTED') {
            preflightErrors.push(...dirtyWorkspaceProtectionDrift.violations);
        }
        if (preflightErrors.length === 0) {
            const taskOwnedManifestChangedFiles = getTaskOwnedManifestChangedFiles(
                workspaceSnapshot.changed_files,
                protectedManifestEvidence.changed_files
            );
            const classifyManifestRestartHint = taskModeEvidence.orchestrator_work !== true
                ? buildClassifyChangeOrchestratorWorkRestartCommand({
                    repoRoot,
                    taskId: resolvedTaskId,
                    taskModeEvidence,
                    taskSummary: currentTaskSummary,
                    changedFiles: [...workspaceSnapshot.changed_files, ...taskOwnedManifestChangedFiles]
                })
                : undefined;
            const protectedManifestGuard = getProtectedManifestLifecycleGuard({
                repoRoot,
                orchestratorWork: taskModeEvidence.orchestrator_work === true,
                phaseLabel: 'preflight classification',
                manifestEvidence: protectedManifestEvidence,
                dirtyWorkspaceProtectionStatus: dirtyWorkspaceProtectionDrift.status,
                dirtyWorkspaceProtectedFiles: dirtyWorkspaceProtectedScope?.protected_files || [],
                restartCommandHint: classifyManifestRestartHint
            });
            preflightErrors.push(...protectedManifestGuard.violations);
        }
        if (preflightErrors.length > 0) {
            throw new Error(preflightErrors.join(' '));
        }

        if (isolationViolationMessage) {
            throw new Error(`Control-plane isolation (STRICT) blocked preflight: ${isolationViolationMessage}`);
        }
    } else if (isolationViolationMessage) {
        throw new Error(`Control-plane isolation (STRICT) blocked preflight: ${isolationViolationMessage}`);
    }

    result.triggers.protected_control_plane_manifest_assessment =
        protectedManifestAssessment?.code || null;

    if (resolvedTaskId) {
        const taskModeForBudget = getTaskModeEvidence(repoRoot, resolvedTaskId, resolvedTaskModePath);
        const requestedDepth = taskModeForBudget.requested_depth || 2;

        let tokenEconomyEnabled = true;
        let enabledDepths = [1, 2];
        let baseStripExamples = true;
        let baseStripCodeBlocks = true;
        let baseScopedDiffs = true;
        let baseCompactReviewerOutput = true;
        const tokenEconomyPath = resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'token-economy.json'));
        try {
            if (fs.existsSync(tokenEconomyPath)) {
                const teConfig = JSON.parse(fs.readFileSync(tokenEconomyPath, 'utf8')) as Record<string, unknown>;
                if (typeof teConfig.enabled === 'boolean') tokenEconomyEnabled = teConfig.enabled;
                if (Array.isArray(teConfig.enabled_depths)) enabledDepths = teConfig.enabled_depths as number[];
                if (typeof teConfig.strip_examples === 'boolean') baseStripExamples = teConfig.strip_examples;
                if (typeof teConfig.strip_code_blocks === 'boolean') baseStripCodeBlocks = teConfig.strip_code_blocks;
                if (typeof teConfig.scoped_diffs === 'boolean') baseScopedDiffs = teConfig.scoped_diffs;
                if (typeof teConfig.compact_reviewer_output === 'boolean') baseCompactReviewerOutput = teConfig.compact_reviewer_output;
            }
        } catch { /* use defaults */ }

        if (effectiveTaskPolicy) {
            tokenEconomyEnabled = effectiveTaskPolicy.token_economy.enabled;
            enabledDepths = effectiveTaskPolicy.token_economy.enabled_depths;
            baseStripExamples = effectiveTaskPolicy.token_economy.strip_examples;
            baseStripCodeBlocks = effectiveTaskPolicy.token_economy.strip_code_blocks;
            baseScopedDiffs = effectiveTaskPolicy.token_economy.scoped_diffs;
            baseCompactReviewerOutput = effectiveTaskPolicy.token_economy.compact_reviewer_output;
        }

        const riskTriggers = {
            db: !!result.triggers.db,
            security: !!result.triggers.security,
            refactor: !!result.triggers.refactor,
            api: !!result.triggers.api,
            test: !!result.triggers.test,
            performance: !!result.triggers.performance,
            infra: !!result.triggers.infra,
            dependency: !!result.triggers.dependency
        };

        const riskAwareDepth = resolveRiskAwareDepth(
            requestedDepth,
            result.mode,
            riskTriggers,
            {
                strip_examples: baseStripExamples,
                strip_code_blocks: baseStripCodeBlocks,
                scoped_diffs: baseScopedDiffs,
                compact_reviewer_output: baseCompactReviewerOutput
            }
        );

        const effectiveDepth = riskAwareDepth.effective_depth;
        const reviewTriggerChangedFilesCount = Math.min(
            workspaceSnapshot.changed_files_count,
            getReviewTriggerEffectiveMetric(result, 'changed_files_count')
        );
        const reviewTriggerChangedLinesTotal = getReviewTriggerEffectiveMetric(result, 'changed_lines_total');

        const depthEscalation = resolveDepthEscalation({
            taskId: resolvedTaskId,
            requestedDepth,
            effectiveDepth,
            pathMode: result.mode,
            changedFilesCount: reviewTriggerChangedFilesCount,
            changedLinesTotal: reviewTriggerChangedLinesTotal,
            requiredReviews: result.required_reviews
        });

        const budgetForecast = buildBudgetForecast({
            taskId: resolvedTaskId,
            requestedDepth,
            effectiveDepth,
            pathMode: result.mode,
            changedFilesCount: reviewTriggerChangedFilesCount,
            changedLinesTotal: reviewTriggerChangedLinesTotal,
            requiredReviews: result.required_reviews,
            tokenEconomyEnabled,
            tokenEconomyEnabledDepths: enabledDepths
        });

        result.budget_forecast = budgetForecast;
        result.depth_escalation = depthEscalation;
        result.risk_aware_depth = riskAwareDepth;
    }

    const outputPath = resolveClassifyChangeOutputPath(repoRoot, resolvedTaskId || null, options.outputPath);
    let optionalSkillSelectionArtifactPath: string | null = null;
    if (outputPath) {
        let optionalSkillSelectionPreview: ReturnType<typeof buildOptionalSkillSelectionArtifact> | null = null;
        const taskModeEvidenceForOptionalSkills = resolvedTaskId
            ? getTaskModeEvidence(repoRoot, resolvedTaskId, resolvedTaskModePath)
            : null;
        const optionalSkillSelectionPhaseInput = resolvedTaskId && taskModeEvidenceForOptionalSkills
            ? resolveOptionalSkillSelectionPhaseInput({
                changedFiles: result.changed_files as string[],
                plannedChangedFiles: taskModeEvidenceForOptionalSkills.planned_changed_files || [],
                taskPlanScopeFiles: readApprovedTaskPlanScopeFiles(repoRoot, resolvedTaskId, taskModeEvidenceForOptionalSkills),
                explicitChangedFilesProvided
            })
            : {
                selectionPhase: 'pre_implementation' as OptionalSkillSelectionPhase,
                pathEvidenceSource: 'none' as OptionalSkillPathEvidenceSource
            };
        const optionalSkillPolicyEnabled = resolvedTaskId
            ? isOptionalSkillSelectionPolicyConfigured(orchestratorRoot)
            : false;
        const optionalSkillPolicyMode = (resolvedTaskId && optionalSkillPolicyEnabled)
            ? readOptionalSkillSelectionPolicyConfig(orchestratorRoot).mode
            : null;
        const optionalSkillTaskText = resolvedTaskId
            ? resolveOptionalSkillTaskText(repoRoot, resolvedTaskId, options.taskIntent, currentTaskSummary)
            : '';
        if (resolvedTaskId && optionalSkillPolicyEnabled) {
            try {
                result.optional_skill_selection = {
                    artifact_path: optionalSkillPolicyMode === 'off'
                        ? null
                        : normalizeOptionalPath(path.join(orchestratorRoot, 'runtime', 'reviews', `${resolvedTaskId}-optional-skill-selection.json`)),
                    policy_mode: optionalSkillPolicyMode,
                    decision: null,
                    visible_summary_line: optionalSkillPolicyMode === 'off'
                        ? 'Optional skills: as_is (reason: policy_off)'
                        : null
                };
                if (optionalSkillPolicyMode !== 'off') {
                    optionalSkillSelectionPreview = buildOptionalSkillSelectionArtifact(
                        orchestratorRoot,
                        resolvedTaskId,
                        {
                            taskText: optionalSkillTaskText,
                            changedPaths: result.changed_files as string[],
                            targetRoot: repoRoot,
                            selectionPhase: optionalSkillSelectionPhaseInput.selectionPhase,
                            pathEvidenceSource: optionalSkillSelectionPhaseInput.pathEvidenceSource
                        }
                    );
                    result.optional_skill_selection = {
                        artifact_path: normalizeOptionalPath(optionalSkillSelectionPreview.artifactPath),
                        policy_mode: optionalSkillSelectionPreview.payload.policy_mode,
                        decision: optionalSkillSelectionPreview.payload.decision,
                        selection_phase: optionalSkillSelectionPreview.payload.selection_phase,
                        path_evidence_source: optionalSkillSelectionPreview.payload.path_evidence_source,
                        visible_summary_line: optionalSkillSelectionPreview.payload.visible_summary_line
                    };
                }
            } catch (error: unknown) {
                if (isMandatoryOptionalSkillSelectionPolicyMode(optionalSkillPolicyMode)) {
                    throw error;
                }
                result.optional_skill_selection = {
                    artifact_path: normalizeOptionalPath(path.join(orchestratorRoot, 'runtime', 'reviews', `${resolvedTaskId}-optional-skill-selection.json`)),
                    policy_mode: optionalSkillPolicyMode,
                    decision: null,
                    visible_summary_line: null,
                    warning: error instanceof Error ? error.message : String(error)
                };
            }
        }
        if (resolvedTaskId && taskModeEvidenceForOptionalSkills) {
            const taskProfileSnapshot = taskModeEvidenceForOptionalSkills.profile_policy_snapshot;
            const knownReviewSkillIds = collectKnownReviewSkillIds(
                readSkillsHeadlinesIfPresent(orchestratorRoot)?.payload.skills
            );
            const catalog = readReviewCatalogConfigFile(
                path.join(orchestratorRoot, 'live', 'config', 'review-catalog.json'),
                { knownSkillIds: knownReviewSkillIds }
            );
            const legacyCompatibilityBinding = taskProfileSnapshot
                ? null
                : resolveLegacyCompatibilityReviewCatalogBinding(reviewCapabilities, catalog);
            const profileCatalogPolicy = taskProfileSnapshot
                ? resolveProfileReviewCatalogPolicy(
                    taskProfileSnapshot.source.effective_profile,
                    taskProfileSnapshot.review_lane_selection.profile_review_policy,
                    taskProfileSnapshot.review_lane_selection.review_capabilities,
                    catalog
                )
                : legacyCompatibilityBinding!.profile_policy;
            const fullSuiteValidation = taskProfileSnapshot?.review_execution_policy.full_suite_validation
                || loadFullSuiteValidationConfig(repoRoot);
            const effectiveReviewSnapshot = buildEffectiveReviewSnapshot({
                catalog,
                profilePolicy: profileCatalogPolicy,
                profileSnapshotSha256: taskProfileSnapshot?.snapshot_hash
                    || legacyCompatibilityBinding!.profile_snapshot_sha256,
                legacyRequiredReviews: result.required_reviews,
                taskRequiredReviewIds: result.task_required_review_declaration?.applied_reviews,
                scopeCategory: result.scope_category,
                taskIntent: resolveEffectiveReviewTaskIntent(options.taskIntent, currentTaskSummary),
                changedFiles: result.changed_files,
                taskTriggers: Object.fromEntries(
                    Object.entries(result.triggers)
                        .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
                ),
                optionalSkillIds: optionalSkillSelectionPreview?.payload.selected_installed_skills
                    .map((skill) => skill.id) || [],
                zeroDiffBaselineOnly: zeroDiffBaselineOnlyNoReviewableScope,
                reviewExecutionPolicyMode: taskProfileSnapshot?.review_execution_policy.mode
                    || reviewExecutionPolicy.mode,
                reviewDependencyGraph:
                    taskProfileSnapshot?.review_execution_policy.review_dependency_graph,
                fullSuiteValidation
            });
            result.effective_review_snapshot = effectiveReviewSnapshot;
            if (result.review_execution_policy && effectiveReviewSnapshot.review_dependency_graph) {
                result.review_execution_policy.dependency_graph = effectiveReviewSnapshot.review_dependency_graph;
            }
            result.required_reviews = { ...effectiveReviewSnapshot.required_reviews };
            result.profile_guardrails = reconcileProfileGuardrailsWithRequiredReviews(
                result.profile_guardrails,
                result.required_reviews
            );
            if (result.budget_forecast && result.risk_aware_depth) {
                const requiredReviewBudgetInput = {
                    taskId: resolvedTaskId,
                    requestedDepth: result.risk_aware_depth.requested_depth,
                    effectiveDepth: result.risk_aware_depth.effective_depth,
                    pathMode: result.mode,
                    changedFilesCount: Math.min(
                        workspaceSnapshot.changed_files_count,
                        getReviewTriggerEffectiveMetric(result, 'changed_files_count')
                    ),
                    changedLinesTotal: getReviewTriggerEffectiveMetric(result, 'changed_lines_total'),
                    requiredReviews: result.required_reviews
                };
                result.depth_escalation = resolveDepthEscalation(requiredReviewBudgetInput);
                result.budget_forecast = buildBudgetForecast({
                    ...requiredReviewBudgetInput,
                    tokenEconomyEnabled: effectiveTaskPolicy?.token_economy.enabled ?? true,
                    tokenEconomyEnabledDepths: effectiveTaskPolicy?.token_economy.enabled_depths ?? [1, 2]
                });
            }
        }
        const preflightArtifactText = `${JSON.stringify(result, null, 2)}\n`;
        const preflightSha256 = createHash('sha256').update(preflightArtifactText, 'utf8').digest('hex');
        writeTextArtifact(outputPath, preflightArtifactText);
        if (resolvedTaskId && optionalSkillPolicyEnabled) {
            let optionalSkillSelection;
            try {
                optionalSkillSelection = optionalSkillPolicyMode === 'off'
                    ? null
                    : optionalSkillSelectionPreview
                    ? writeOptionalSkillSelectionArtifact(
                        orchestratorRoot,
                        resolvedTaskId,
                        {
                            taskText: optionalSkillTaskText,
                            changedPaths: result.changed_files as string[],
                            targetRoot: repoRoot,
                            selectionPhase: optionalSkillSelectionPhaseInput.selectionPhase,
                            pathEvidenceSource: optionalSkillSelectionPhaseInput.pathEvidenceSource,
                            preflightPath: outputPath,
                            preflightSha256,
                            preparedArtifact: optionalSkillSelectionPreview,
                            loadedHeadlinesCache: optionalSkillSelectionPreview.loadedHeadlinesCache || null
                        }
                    )
                    : null;
            } catch (error: unknown) {
                if (!isMandatoryOptionalSkillSelectionPolicyMode(optionalSkillPolicyMode)) {
                    optionalSkillSelection = null;
                    result.optional_skill_selection = {
                        artifact_path: normalizeOptionalPath(path.join(orchestratorRoot, 'runtime', 'reviews', `${resolvedTaskId}-optional-skill-selection.json`)),
                        policy_mode: optionalSkillPolicyMode,
                        decision: optionalSkillSelectionPreview?.payload.decision || null,
                        visible_summary_line: optionalSkillSelectionPreview?.payload.visible_summary_line || null,
                        warning: error instanceof Error ? error.message : String(error)
                    };
                    writeTextArtifact(outputPath, `${JSON.stringify(result, null, 2)}\n`);
                } else {
                    removeArtifactIfExists(outputPath);
                    throw error;
                }
            }
            if (optionalSkillSelection) {
                optionalSkillSelectionArtifactPath = normalizeOptionalPath(optionalSkillSelection.artifactPath);
            } else if (isMandatoryOptionalSkillSelectionPolicyMode(optionalSkillPolicyMode)) {
                removeArtifactIfExists(outputPath);
                throw new Error('Optional skill selection artifact is required for the current policy mode, but no current-cycle artifact could be materialized.');
            }
        }
    }

    const metricsPath = options.metricsPath
        ? resolvePathForWrite(options.metricsPath, repoRoot)
        : resolvePathForWrite(classificationConfig.metrics_path, repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: new Date().toISOString(),
        event_type: 'preflight_classification',
        repo_root: gateHelpers.normalizePath(repoRoot),
        task_id: resolvedTaskId || null,
        output_path: normalizeOptionalPath(outputPath),
        result
    }, parseBooleanOption(options.emitMetrics, true));

    if (resolvedTaskId) {
        const codeChanged = detectCodeChanged(result as unknown as Record<string, unknown>, repoRoot);
        try {
            appendMandatoryTaskEvent(
                orchestratorRoot,
                resolvedTaskId,
                'PREFLIGHT_CLASSIFIED',
                'INFO',
                result.zero_diff_guard && result.zero_diff_guard.zero_diff_detected
                    ? `Preflight completed with mode ${result.mode} (zero-diff baseline only).`
                    : `Preflight completed with mode ${result.mode}.`,
                {
                    mode: result.mode,
                    output_path: normalizeOptionalPath(outputPath),
                    changed_files_count: result.metrics.changed_files_count,
                    changed_lines_total: result.metrics.changed_lines_total,
                    scope_sha256: result.metrics.scope_sha256,
                    scope_content_sha256: result.metrics.scope_content_sha256,
                    code_changed: codeChanged,
                    required_reviews: result.required_reviews,
                    review_execution_policy: result.review_execution_policy ?? null,
                    profile_selection: result.profile_selection ?? null,
                    profile_guardrails: result.profile_guardrails ?? null,
                    profile_policy_snapshot: result.profile_policy_snapshot ?? null,
                    effective_review_snapshot: result.effective_review_snapshot ?? null,
                    optional_skill_selection_artifact_path: optionalSkillSelectionArtifactPath,
                    zero_diff_guard: result.zero_diff_guard,
                    budget_forecast: result.budget_forecast || null,
                    depth_escalation: result.depth_escalation || null
                }
            );
        } catch (error: unknown) {
            removeArtifactIfExists(outputPath);
            throw new Error(
                `classify-change failed because mandatory lifecycle event 'PREFLIGHT_CLASSIFIED' could not be appended. ${getErrorMessage(error)}`
            );
        }
    }

    return {
        outputText: `${JSON.stringify(result, null, 2)}\n`
    };
    } catch (error: unknown) {
        if (resolvedTaskId) {
            try {
                emitMandatoryPreflightFailedEvent(orchestratorRoot, resolvedTaskId, {
                    error: getErrorMessage(error),
                    task_intent: String(options.taskIntent || ''),
                    ...(preflightFailureDiagnostics
                        ? {
                            preflight_failure_reason_code: preflightFailureDiagnostics.reason_code,
                            pre_task_modified_files: preflightFailureDiagnostics.pre_task_modified_files,
                            dirty_workspace_baseline_changed_files: preflightFailureDiagnostics.dirty_workspace_baseline_changed_files,
                            current_workspace_changed_files: preflightFailureDiagnostics.current_workspace_changed_files,
                            authorized_scope_changed_files: preflightFailureDiagnostics.authorized_scope_changed_files,
                            changed_protected_files: preflightFailureDiagnostics.changed_protected_files,
                            detection_source: preflightFailureDiagnostics.detection_source,
                            explicit_changed_files_provided: preflightFailureDiagnostics.explicit_changed_files_provided,
                            use_staged: preflightFailureDiagnostics.use_staged,
                            include_untracked: preflightFailureDiagnostics.include_untracked
                        }
                        : {})
                });
            } catch (eventError: unknown) {
                throw new Error(
                    `classify-change failed and mandatory lifecycle event 'PREFLIGHT_FAILED' could not be appended. Original error: ${getErrorMessage(error)} | Event append error: ${getErrorMessage(eventError)}`
                );
            }
        }
        throw error;
    } finally {
        releaseFilesystemLock(prePreflightSequenceLockHandle);
    }
}
