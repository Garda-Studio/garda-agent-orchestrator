import * as fs from 'node:fs';
import { findUnapprovedActiveImplementationOwners } from '../workspace/active-implementation-ownership';
import { assertWorkflowTransactionReadable } from '../../core/workflow-transaction-state';
import * as path from 'node:path';

import {
    LEGACY_REVIEW_EXECUTION_POLICY_MODE,
    resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig,
    resolveReviewExecutionPolicyModeFromPreflight,
    type EffectiveReviewExecutionPolicyMode,
    type ResolvedReviewExecutionPolicyConfig
} from '../../core/review-execution-policy';
import {
    bindFullSuiteValidationBarrier,
    resolveCompiledReviewDependencyGraphFromPreflight
} from '../../core/review-dependency-graph';
import {
    assertEffectiveReviewSnapshotExecutionPolicyBinding,
    getEffectiveReviewSnapshotViolations,
    hasCurrentReviewDependencyGraphContract,
    type EffectiveReviewSnapshot,
    type FrozenReviewExecutionPolicyBinding
} from '../../policy/effective-review-snapshot';
import { isPlainRecord } from '../../core/records';
import {
    readTaskQueueEntries,
    type TaskQueueEntry
} from '../../core/task-queue-read';
import {
    resolveTaskResetAvailability
} from '../../core/task-reset-availability';
import {
    resolveReviewerResultRecoveryIdentity
} from '../review/security/reviewer-result-recovery-identity';
import {
    REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION,
    REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION,
    REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION,
    REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION
} from '../../gate-runtime/reviewer-session-contract';
import {
    buildReviewVerdictTokenSet,
    formatAcceptedReviewVerdictTokens
} from '../../gate-runtime/review-context';
import {
    readReviewArtifactFileSha256,
    withReviewArtifactReadBarrier
} from '../../gate-runtime/review-artifacts';
import { withTaskIndexReadSnapshot } from '../../gate-runtime/reviews-index';
import { assertValidTaskId, readTaskTimelineJsonlEntries, withTaskTimelineReadSnapshot } from '../../gate-runtime/task-events';
import {
    buildTaskAuditSummary,
    type TaskAuditSummaryResult
} from '../task-audit/task-audit-summary';
import {
    resolveEventsRoot,
    resolveReviewsRoot,
    type GateOutcome
} from '../task-audit/task-audit-summary-collectors';
import {
    readOrderedTaskEvents,
    type TaskAuditEvent
} from '../task-audit/task-audit-summary-lifecycle';
import {
    buildFullSuiteTimeoutForecast,
    formatFullSuitePerformanceGuidance,
    formatFullSuiteTimeoutForecast,
    isFullSuiteNotRequiredForDocsOnlyScope,
    isFullSuiteNotRequiredForZeroDiffNoReviewableScope,
    loadFullSuiteValidationConfig,
    resolveWorkflowConfigPath
} from '../full-suite/full-suite-validation';
import {
    readFullSuiteRepairTaskMaterializationEvidence
} from '../full-suite/full-suite-repair-task';
import {
    findFullSuiteRepairChildHandoffState,
    resolveFullSuiteRepairDecompositionState
} from '../full-suite/full-suite-repair-decomposition';
import {
    sameRepairChildScopes,
    validateRepairChildChangedFiles
} from '../full-suite/full-suite-repair-child-scope';
import { buildAuthoritativeReviewCoverageContract } from '../review-context/review-context-coverage';
import {
    readRecoverableFullSuiteValidationRunMarker,
    resolveFullSuiteValidationRunMarkerPath
} from '../full-suite/full-suite-validation-run-marker';
import type {
    ReviewTrustSummary
} from '../review/review-trust-summary';
import {
    fileSha256,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import {
    normalizeWorkspaceRelativePath,
    normalizeWorkspaceRelativePaths
} from '../workspace/dirty-worktree-protection';
import {
    taskMetadataAllowsWorkflowConfigWork
} from '../workflow-config/workflow-config-work-paths';
import {
    collectKnownNonBlockingSignals,
    type KnownNonBlockingSignal
} from '../shared/known-nonblocking-signals';
import {
    isSourceCheckoutGeneratedRuntimeArtifactPath
} from '../shared/generated-runtime-artifacts';
import {
    resolveBundleRootForTarget,
    resolveBundleNameForTarget
} from '../../core/constants';
import {
    buildGardaSelfGuardPolicyChangeCommand,
    buildDefaultWorkflowConfig,
    formatGardaSelfGuardProtectedControlPlaneGuidance,
    isGardaSelfGuardDenyAgentEntryForBundle,
    type FullSuiteValidationPlacement
} from '../../core/workflow-config';
import {
    isOrchestratorSourceCheckout
} from '../protected-control-plane/protected-control-plane';
import {
    getProjectMemoryImpactLifecycleEvidence
} from '../project-memory-impact/project-memory-impact';
import { getCurrentNoOpEventSha256, getNoOpEvidence } from '../task-mode/no-op';
import {
    readOptionalMarkdownWorkingPlan,
    type TaskModeMarkdownWorkingPlanMetadata
} from '../task-mode/task-mode';
import {
    buildCurrentCycleOptionalSkillActivationIndex,
    buildCurrentCycleOptionalSkillDeclineIndex,
    buildMandatoryCurrentCycleOptionalSkillActivationIndex,
    computeOptionalSkillTaskTextSha256,
    getOptionalSkillSelectionArtifactViolations,
    getOptionalSkillSelectionConfigPath,
    isMandatoryOptionalSkillSelectionPolicyMode,
    isOptionalSkillSelectionPolicyConfigured,
    normalizeOptionalSkillPathEvidenceSource,
    normalizeOptionalSkillSelectionPolicyMode,
    normalizeOptionalSkillSelectionPhase,
    readOptionalSkillSelectionArtifact,
    readOptionalSkillSelectionPolicyConfig,
    readOptionalSkillSelectionTimelineEvidence
} from '../../runtime/optional-skill-selection';
import {
    readInstalledSkillPacks,
    suggestSkills
} from '../../runtime/skills';
import {
    getActiveTaskLifecycleGateIds,
    resolveFirstActiveTaskLifecycleGate
} from '../../runtime/task-lifecycle-phase-runtime';
import {
    readStartupCycleReadiness
} from './next-step-startup-readiness';
import {
    buildNextStepTaskStartGuidance,
    type NextStepTaskStartGuidanceSummary
} from './next-step-task-start-guidance';
import {
    selectTaskEntryRulePackFileNames
} from '../rule-pack/rule-pack-selection';
import { readTaskModeProtectedManifestRecoveryRoute } from './next-step-startup-routing';
import {
    readCompileReadiness,
    readPreflightWorkspaceReadiness
} from './next-step-compile-full-suite-readiness';
import {
    getClassificationConfig,
    getReviewCapabilities
} from '../preflight/classify-change-config';
import {
    resolveTaskRequiredReviewDeclaration
} from '../preflight/classify-change-task-required-reviews';
import {
    assessReviewRemediationScopeBoundary,
    getTaskManualValidationBoundaryFiles
} from '../review-remediation/review-remediation-scope-boundary';
import {
    resolveIgnoredRemediationCommandChangedFiles
} from '../review-remediation/ignored-remediation-targets';
import {
    resolveProviderFromEnvironment as resolveProviderFromRegistryEnvironment
} from '../../core/provider-registry';
import {
    evaluateScopeBudgetGuard,
    normalizeScopeBudgetGuardConfig,
    readScopeBudgetChangedFilesCount,
    readScopeBudgetChangedLinesTotal,
    type ScopeBudgetGuardEvaluation
} from '../../core/scope-budget-guard';
import {
    assessReviewCycleContinuationEvidence
} from '../review-cycle/review-cycle-continuation';
import { resolveTaskProfileSelection } from '../../policy/task-profile-selection';
import {
    resolveTaskProfileTaskDecompositionPolicy,
    type TaskProfilePolicySnapshot
} from '../../policy/task-profile-policy-snapshot';
import { validateWorkflowConfig } from '../../schemas/config-artifacts';
import {
    buildForcedSourceCheckoutRuntimeBuildCommand,
    detectSourceCheckoutRuntimeStaleness,
    type SourceCheckoutRuntimeStalenessResult
} from '../../validators';
import {
    buildDefaultReviewScratchCommandPath
} from '../review/review-scratch-paths';
import {
    buildTaskQueueStatusContract,
    type TaskQueueStatusContract
} from '../../core/task-queue-status-contract';
import {
    isTaskQueueActiveStatus,
    isTaskQueueSplitRequiredStatus
} from '../../core/active-task-state';
import {
    buildNextStepCoreArtifactSpecs,
    fullSuiteArtifactMatchesCurrentCycle,
    hasAcceptedDocsOnlyFullSuiteSkipArtifact
} from './next-step-readiness-readers';
import {
    buildTaskQueueFollowUpFingerprintIndex,
    getScopedDiffMetadataReadiness,
    readReviewArtifactState,
    readReviewTrust,
    scopedDiffExpectedForReview,
    type ReviewArtifactState
} from './next-step-review-artifact-readers';
import {
    resolveLockedReviewFindingPolicyFromPreflight
} from '../review/review-finding-disposition';
import {
    applyFullSuiteReadinessToReviewLaunchPlan,
    buildNextStepReviewLaunchPlan,
    describeBlockedReviewDependencies,
    getDownstreamReviewTypesFor,
    toNextStepBlockedReviewLanes
} from './next-step-review-launch-planner';
import {
    resolveReviewLaunchableLanePreparationRoute
} from './next-step-review-cycle-routing';
import {
    buildProviderNativeReviewerLaunchTargetSummary,
    buildReviewerReadinessChainSummary,
    getCurrentReviewerLaunchArtifactEvidenceForInvocation,
    timelineHasDelegatedReviewInvocationForCurrentContext,
    timelineHasDelegatedReviewRoutingAfterCompile
} from './next-step-reviewer-launch-evidence';
import {
    isFullSuiteSatisfiedBySemanticCycleResume,
    isReviewSatisfiedBySemanticCycleResume,
    resolveFailedReviewRemediationRoute,
    resolveStrictSequentialUpstreamReuseRoute,
    type ReviewReuseCandidateHint
} from './next-step-review-reuse-routing';
import {
    readSemanticCycleResumeRoutingState
} from '../semantic-cycle-resume/semantic-cycle-routing';
import {
    isPassedIntermediateCommandEvent,
    readFocusedTestRequiredByReview,
    readPostReviewFocusedIntermediateEvidence
} from './next-step-focused-intermediate-evidence';
import {
    buildReviewGateChainStatusSummary,
    findStrictSequentialUpstreamNeedingCurrentCycleReuse,
    getHiddenReviewTimingTrustRemediation,
    reviewStateHasCurrentRecordedEvidence,
    reviewStateHasSatisfiedEvidence,
    timelineHasReviewContextPreparedAfterCompile,
    timelineHasReviewReuseRecordedAfterCompile
} from './next-step-review-evidence';
import {
    resolvePostReviewLifecycleDecisionRouteFromState
} from './next-step-post-review-routes';
import {
    resolveNextStepCompileGateRoute,
    resolveNextStepQualityChecklistRoute
} from './next-step-pre-review-routing';
import {
    buildBaselineOnlyPreImplementationRoute
} from './next-step-pre-implementation-routing';
import {
    buildTestFirstExpectedFailureRoute
} from './next-step-test-first-routing';
import {
    buildNextStepQualityChecklistSummary,
    markQualityChecklistReadinessStaleForWorkspace,
    readQualityChecklistReadiness,
    type NextStepQualityChecklistSummary
} from './next-step-quality-checklist-readiness';
import {
    mergeTaskOwnedMetadataRefreshFiles
} from './next-step-task-owned-metadata';
import {
    readPostDoneWorkspaceDriftDecision,
    readReadyFinalReportSummary,
    type NextStepFinalReportSummary
} from './next-step-closeout-status-readers';
import {
    evaluatePostReviewSourceMutationGuard,
    hasAuthenticatedFixNowDisposition,
    resolveAuthenticatedFixNowRemediationState
} from './next-step-post-review-source-mutation-guard';
import {
    materializeSplitRequiredLatch,
    readSplitRequiredLatchEvidence,
    sanitizeScopeBudgetGuardSummary,
} from './next-step-split-required-latch';
import {
    resolveClassifyDecisionRoute,
    resolveCompletedCloseoutDecisionRoute,
    resolveFullSuiteDecisionRoute,
    resolveOptionalSkillSelectionDecisionRoute,
    resolvePendingOptionalSkillDecisionRoute,
    resolvePreGuardDecisionRoute,
    resolveStartupDecisionRoute,
    resolveTaskIdCaseMismatchDecisionRoute,
    resolveTaskQueueTerminalDecisionRoute,
    type NextStepDecisionRoutePayload
} from './next-step-decision-route-groups';
import {
    NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE,
    createAuthenticatedNextStepStateProjection,
    selectNextStepDecision,
    type AuthenticatedNextStepDecisionBinding,
    type NextStepDecisionCandidate,
    type NextStepDecisionCheckpoint,
    type NextStepDecisionKind
} from './next-step-decision-engine';
import {
    resolveReviewCycleGuardDecisionRoute,
    resolveScopeBudgetGuardDecisionRoute,
    resolveValidationDecisionRoute,
    type NextStepGuardDecision
} from './next-step-validation-routes';
import {
    resolveActiveReviewLifecycleDecisionRoute,
    resolveContextPreparationLifecycleRoute,
    resolveCurrentCycleReviewReuseRoute,
    resolveDelegatedReadinessLifecycleRoute,
    resolveDelegatedReviewerIdentityBinding,
    resolveFindingsFollowUpLifecycleRoute
} from './next-step-review-lifecycle-routes';
import {
    buildReviewCycleContinuationCommand,
    buildReviewCycleOperatorBlock,
    buildReviewCycleSplitDecisionCommand,
    materializeReviewCycleAutoSplitPrompt,
    readReviewCycleGuardEvaluation,
    type NextStepReviewCycleBlock
} from './next-step-review-cycle-guard';
import {
    buildCommand,
    buildBundleRelativePath,
    buildNavigatorCommand,
    buildProjectMemoryImpactCommand,
    formatNextStepInlineList,
    formatNextStepInlineValue,
    quoteCommandValue,
    toRepoDisplayPath
} from './next-step-command-formatters';
export { formatNextStepText } from './next-step-command-formatters';
import {
    buildCompleteReviewerLaunchCommand,
    buildPrepareReviewerLaunchCommand,
    buildRecordReviewOutputCorrectionInvocationCommand,
    buildRecordReviewOutputCorrectionTransportCommand,
    buildRecordReviewerDelegationStartedCommand,
    buildRecordReviewResultCommand,
    buildRecordReviewerInvocationCommand,
    buildRestartReviewCycleCommand,
    buildReviewRoutingCommand,
    buildScopedDiffCommand,
    buildTaskModePathCommandParts
} from './next-step-review-command-builders';
import { buildCoherentCycleRestartCommand } from '../completion/completion-reporting';
export type { NextStepQualityChecklistSummary } from './next-step-quality-checklist-readiness';
import {
    buildDocImpactCommandPlan,
    buildDocImpactCompatibilityHint,
    buildProjectMemoryNextStepSummary,
    buildStaleCompletionFailureDocCloseoutAllowance,
    isProjectMemoryEvidenceCurrentForCloseout,
    readNextStepCloseoutTimelineSnapshot,
    readPreflightCycleReadiness,
    type NextStepProjectMemorySummary
} from './next-step-doc-closeout-readiness';
import {
    readCurrentGitWorkspaceSnapshot
} from '../scope/docs-only-delta-readiness';
import {
    createWorkspaceSnapshotRequest,
    type WorkspaceSnapshotRequest
} from '../workspace/workspace-snapshot-cache';
import {
    buildClassifyChangeCommand,
    withNextStepCommandWorkspaceReadSnapshot,
    buildCompileGateCommand,
    buildCompletionGateCommand,
    buildEnterTaskModeCommand,
    buildOrchestratorWorkRestartCommand,
    buildPostPreflightRulePackBindCommand,
    buildPostPreflightRulePackCommandForFiles,
    buildQualityChecklistCommand,
    buildReviewContextCommand,
    getEffectiveDepthForPostPreflightRules,
    getPostPreflightRuleFileNames,
    getPreflightRefreshChangedFiles,
    getStringField,
    getTaskModeDirtyWorkspaceBaselineCommandChangedFiles,
    getTaskModeDirtyWorkspaceBaselineChangedFiles,
    getTaskModeDirtyWorkspaceBaselineFileHashes,
    getTaskModePlannedChangedFiles,
    resolveAuthenticatedSplitCheckpointCommandScope
} from './next-step-lifecycle-command-builders';
import {
    isLatestCompletionCurrent,
    readCoherentCycleReadiness,
    readFailedGateRecovery,
    readPostPreflightRulePackReadiness
} from './next-step-preflight-recovery';
import {
    readCurrentProtectedScopeBeforePreflight
} from './next-step-protected-scope';
import {
    buildStrictDecompositionDecisionRequirement,
    resolveStrictDecompositionContinuationRoute
} from './next-step-strict-decomposition-routing';
import {
    createNextStepResolutionContext,
    type NextStepOptions,
    type NextStepResolutionContext
} from './next-step-resolution-context';
import {
    renderNextStepOutput
} from './next-step-output-rendering';
import {
    assertNextStepEffectExecutionComplete,
    assertNextStepEffectPlanHash,
    createNextStepEffectExecutor,
    createNextStepEffectPlanner,
    type NextStepEffectController,
    type NextStepEffectPlan
} from './next-step-effects';

const REVIEW_PREPARATION_ORDER = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'performance',
    'infra',
    'dependency',
    'test'
]);

export type NextStepStatus = 'BLOCKED' | 'READY' | 'DONE' | 'DECOMPOSED' | 'SPLIT_REQUIRED';

export interface NextStepCommand {
    label: string;
    command: string;
}

export interface NextStepArtifactState {
    key: string;
    path: string;
    exists: boolean;
}

export interface NextStepFullSuiteSummary {
    enabled: boolean;
    command: string;
    placement: FullSuiteValidationPlacement;
    config_path: string;
    config_source: 'effective_workflow_config';
    note: string;
    recommended_timeout_seconds?: number | null;
    timeout_forecast_note?: string | null;
    performance_guidance_note?: string | null;
}

export interface NextStepReviewSummary {
    required_reviews: string[];
    review_execution_policy_mode: EffectiveReviewExecutionPolicyMode;
    review_execution_policy_source: ReviewExecutionPolicySource;
    review_finding_policy_id: string;
    review_finding_policy_source: string;
    review_finding_policy_actions: {
        critical: string;
        high: string;
        medium: string;
        low: string;
        residual_risk: string;
    };
    launchable_review_types: string[];
    blocked_review_lanes: NextStepBlockedReviewLane[];
    failed_review_type: string | null;
    next_review_type: string | null;
    blocked_review_dependencies: string[];
    ordinary_doc_review_skips: { path: string; pattern: string }[];
    trust: ReviewTrustSummary | null;
    trust_note: string | null;
}

export interface NextStepBlockedReviewLane {
    review_type: string;
    blocked_by: string[];
    reason: string;
}

export type { NextStepFinalReportSummary } from './next-step-closeout-status-readers';
export type { NextStepProjectMemorySummary } from './next-step-doc-closeout-readiness';

export interface NextStepInvalidationImpactSummary {
    stale_artifact_classes: string[];
    affected_review_lanes: string[];
    minimal_recovery_chain: string[];
    reuse_candidates: string[];
}

export interface NextStepProfileSummary {
    task_selected_profile: string | null;
    profile_selection_source: string | null;
    effective_profile: string | null;
    effective_profile_source: string | null;
    runtime_active_profile: string | null;
    runtime_active_profile_source: string | null;
    task_decomposition_enabled: boolean | null;
    task_decomposition_configured: boolean | null;
    task_decomposition_provenance: string | null;
    requested_depth: number | null;
    effective_depth: number | null;
    depth_escalation_reason: string | null;
    total_forecast_tokens: number | null;
    effective_forecast_tokens: number | null;
    token_economy_active_for_depth: boolean | null;
}

export interface NextStepOptionalSkillSelectionSummary {
    artifact_path: string | null;
    artifact_present: boolean;
    artifact_violations: string[];
    timeline_invalid_json: boolean;
    current_policy_mode: string | null;
    policy_mode: string | null;
    decision: string | null;
    selection_phase: string;
    path_evidence_source: string;
    post_diff_self_check: boolean;
    selected_skill_ids: string[];
    selected_skill_sources: string[];
    selected_skill_details: Array<{
        id: string;
        pack: string | null;
        source: string;
        allowed_skill_path: string;
    }>;
    activated_skill_ids: string[];
    declined_skill_ids: string[];
    pending_activation_skill_ids: string[];
    recommended_missing_pack_ids: string[];
    as_is_reason: string | null;
    changed_paths: string[];
    changed_paths_count: number;
    visible_summary_line: string | null;
    activation_commands: string[];
    decline_commands: string[];
    skill_catalog_path: string | null;
    task_start_instruction: string;
}

export type {
    NextStepReviewCycleAutoSplitPrompt,
    NextStepReviewCycleBlock,
    NextStepReviewCycleLatestFailedReview
} from './next-step-review-cycle-guard';

export interface NextStepResult {
    schema_version: 1;
    task_id: string;
    generated_utc: string;
    navigator_command: string;
    status: NextStepStatus;
    next_gate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    missing_artifacts: NextStepArtifactState[];
    present_artifacts: NextStepArtifactState[];
    full_suite_validation: NextStepFullSuiteSummary;
    project_memory: NextStepProjectMemorySummary | null;
    review: NextStepReviewSummary;
    task_queue_status_contract: TaskQueueStatusContract;
    audit_status: TaskAuditSummaryResult['status'];
    profile: NextStepProfileSummary | null;
    markdown_working_plan: TaskModeMarkdownWorkingPlanMetadata | null;
    optional_skill_selection: NextStepOptionalSkillSelectionSummary | null;
    task_start_guidance: NextStepTaskStartGuidanceSummary | null;
    quality_checklist: NextStepQualityChecklistSummary | null;
    warnings: string[];
    invalidation_impact: NextStepInvalidationImpactSummary | null;
    known_non_blocking_signals: KnownNonBlockingSignal[];
    review_cycle_block: NextStepReviewCycleBlock | null;
    final_report: NextStepFinalReportSummary | null;
}


interface ArtifactSpec {
    key: string;
    path: string;
}

function normalizeReviewTypeValue(value: unknown): string | null {
    const reviewType = String(value || '').trim().toLowerCase();
    return reviewType || null;
}

function addNormalizedReviewTypes(target: Set<string>, value: unknown): void {
    if (Array.isArray(value)) {
        for (const entry of value) {
            const reviewType = normalizeReviewTypeValue(entry);
            if (reviewType) {
                target.add(reviewType);
            }
        }
        return;
    }
    if (typeof value === 'string') {
        for (const entry of value.split(',')) {
            const reviewType = normalizeReviewTypeValue(entry);
            if (reviewType) {
                target.add(reviewType);
            }
        }
        return;
    }
    if (isPlainRecord(value)) {
        for (const [key, enabled] of Object.entries(value)) {
            if (enabled === true || isPlainRecord(enabled)) {
                const reviewType = normalizeReviewTypeValue(key);
                if (reviewType) {
                    target.add(reviewType);
                }
            }
        }
    }
}

function readLatestReviewGateOverrideSkippedReviewTypes(eventsRoot: string, taskId: string): Set<string> {
    const orderedEvents = readOrderedTaskEvents(path.join(eventsRoot, `${taskId}.jsonl`)).events;
    for (let index = orderedEvents.length - 1; index >= 0; index -= 1) {
        const event = orderedEvents[index];
        const eventType = String(event.event_type || '').trim();
        if (eventType !== 'REVIEW_GATE_PASSED' && eventType !== 'REVIEW_GATE_PASSED_WITH_OVERRIDE') {
            continue;
        }
        if (eventType !== 'REVIEW_GATE_PASSED_WITH_OVERRIDE') {
            return new Set();
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const attestation = isPlainRecord(details.review_authorship_attestation)
            ? details.review_authorship_attestation
            : {};
        const skippedReviewTypes = new Set<string>();
        addNormalizedReviewTypes(skippedReviewTypes, details.skip_reviews);
        addNormalizedReviewTypes(skippedReviewTypes, details.skipped_review_types);
        addNormalizedReviewTypes(skippedReviewTypes, attestation.skipped_review_types);
        return skippedReviewTypes;
    }
    return new Set();
}

function readLatestTaskEventSequence(eventsRoot: string, taskId: string, eventTypes: readonly string[]): number | null {
    const expectedTypes = new Set(eventTypes.map((eventType) => String(eventType || '').trim().toUpperCase()));
    const orderedEvents = readOrderedTaskEvents(path.join(eventsRoot, `${taskId}.jsonl`)).events;
    for (let index = orderedEvents.length - 1; index >= 0; index -= 1) {
        const event = orderedEvents[index];
        const eventType = String(event.event_type || '').trim().toUpperCase();
        if (!expectedTypes.has(eventType)) {
            continue;
        }
        const sequence = Number(event.sequence);
        return Number.isInteger(sequence) ? sequence : index;
    }
    return null;
}

function hasPassedCompletionBeforeNoOpEvent(eventsRoot: string, taskId: string, noOpEventSha256: string): boolean {
    const events = readTaskTimelineJsonlEntries(path.join(eventsRoot, `${taskId}.jsonl`))
        .map((entry) => entry.record)
        .filter((record): record is Readonly<Record<string, unknown>> => record !== null);
    const noOpIndex = events.findIndex((event) => event.event_type === 'NO_OP_RECORDED'
        && isPlainRecord(event.integrity)
        && event.integrity.event_sha256 === noOpEventSha256);
    if (noOpIndex < 0) {
        return false;
    }
    let taskEntryIndex = -1;
    for (let index = 0; index < noOpIndex; index += 1) {
        if (events[index].event_type === 'TASK_MODE_ENTERED') {
            taskEntryIndex = index;
        }
    }
    let latestCompletion: string | null = null;
    for (let index = taskEntryIndex + 1; index < noOpIndex; index += 1) {
        const eventType = String(events[index].event_type || '');
        if (eventType === 'COMPLETION_GATE_PASSED' || eventType === 'COMPLETION_GATE_FAILED') {
            latestCompletion = eventType;
        }
    }
    return taskEntryIndex >= 0 && latestCompletion === 'COMPLETION_GATE_PASSED';
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function fullSuiteFailedTimeoutRetryAvailable(
    artifact: Record<string, unknown> | null,
    forecast: { recommended_timeout_seconds?: unknown; configured_timeout_seconds?: unknown } | null
): boolean {
    if (!isPlainRecord(artifact) || artifact.status !== 'FAILED' || artifact.timed_out !== true || !forecast) {
        return false;
    }

    const recommendedTimeoutSeconds = Number(forecast.recommended_timeout_seconds);
    if (!Number.isFinite(recommendedTimeoutSeconds) || recommendedTimeoutSeconds <= 0) {
        return false;
    }

    const artifactForecast = isPlainRecord(artifact.timeout_forecast) ? artifact.timeout_forecast : null;
    const priorConfiguredTimeoutSeconds = Number(artifactForecast?.configured_timeout_seconds);
    if (Number.isFinite(priorConfiguredTimeoutSeconds) && priorConfiguredTimeoutSeconds > 0) {
        return recommendedTimeoutSeconds > priorConfiguredTimeoutSeconds;
    }

    const durationMs = Number(artifact.duration_ms);
    return Number.isFinite(durationMs) && durationMs > 0 && recommendedTimeoutSeconds * 1000 > durationMs;
}

function getFullSuiteTimeoutPolicy(artifact: Record<string, unknown> | null): Record<string, unknown> | null {
    return isPlainRecord(artifact?.timeout_policy) ? artifact.timeout_policy : null;
}

function fullSuiteCycleBindingMatches(left: Record<string, unknown> | null, right: Record<string, unknown> | null): boolean {
    if (!left || !right) {
        return false;
    }
    const leftPreflightPath = normalizePath(left.preflight_path || '');
    const rightPreflightPath = normalizePath(right.preflight_path || '');
    const leftPreflightSha = String(left.preflight_sha256 || '').trim().toLowerCase();
    const rightPreflightSha = String(right.preflight_sha256 || '').trim().toLowerCase();
    const leftCompileTimestamp = String(left.compile_gate_timestamp || '').trim();
    const rightCompileTimestamp = String(right.compile_gate_timestamp || '').trim();
    return !!leftPreflightPath
        && leftPreflightPath === rightPreflightPath
        && !!leftPreflightSha
        && leftPreflightSha === rightPreflightSha
        && !!leftCompileTimestamp
        && leftCompileTimestamp === rightCompileTimestamp;
}

function hasFullSuiteTimeoutWarningLifecyclePolicy(
    repoRoot: string,
    taskId: string,
    artifact: Record<string, unknown> | null
): boolean {
    const artifactCycleBinding = isPlainRecord(artifact?.cycle_binding) ? artifact.cycle_binding : null;
    if (!artifactCycleBinding) {
        return false;
    }
    const taskEventPath = path.join(
        joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events')),
        `${taskId}.jsonl`
    );
    const orderedEvents = readOrderedTaskEvents(taskEventPath);
    return [...orderedEvents.events].reverse().some((event: TaskAuditEvent) => {
        if (String(event.event_type || '').trim() !== 'FULL_SUITE_VALIDATION_WARNED') {
            return false;
        }
        if (String(event.outcome || '').trim().toUpperCase() !== 'WARN') {
            return false;
        }
        const details = isPlainRecord(event.details) ? event.details : null;
        const lifecycleTimeoutPolicy = isPlainRecord(details?.timeout_policy) ? details.timeout_policy : null;
        const lifecycleCycleBinding = isPlainRecord(details?.cycle_binding) ? details.cycle_binding : null;
        return !!lifecycleTimeoutPolicy
            && lifecycleTimeoutPolicy.timeout_blocker === false
            && lifecycleTimeoutPolicy.warning_only_continuation === true
            && fullSuiteCycleBindingMatches(artifactCycleBinding, lifecycleCycleBinding);
    });
}

interface FullSuiteTimeoutRepairTaskProposal {
    suggestedTaskId: string | null;
    summary: string | null;
    repeatedBlockerAnalysis: string | null;
}

function getFullSuiteTimeoutRepairTaskProposal(
    timeoutPolicy: Record<string, unknown> | null
): FullSuiteTimeoutRepairTaskProposal {
    const proposal = isPlainRecord(timeoutPolicy?.repair_task_proposal)
        ? timeoutPolicy.repair_task_proposal
        : null;
    if (!proposal) {
        return {
            suggestedTaskId: null,
            summary: null,
            repeatedBlockerAnalysis: null
        };
    }
    const taskId = String(proposal.suggested_task_id || '').trim();
    const title = String(proposal.title || '').trim();
    const area = String(proposal.area || '').trim();
    const rationale = String(proposal.rationale || '').trim();
    const summary = [
        taskId ? `id=${taskId}` : null,
        title ? `title=${title}` : null,
        area ? `area=${area}` : null,
        rationale ? `rationale=${rationale}` : null
    ].filter(Boolean).join('; ') || null;
    const repeatedBlocker = isPlainRecord(timeoutPolicy?.repeated_blocker_analysis)
        ? timeoutPolicy.repeated_blocker_analysis
        : null;
    const repeatedBlockerAnalysis = repeatedBlocker?.status === 'REPEATED_BLOCKER'
        ? [
            `source_task_id=${String(repeatedBlocker.source_task_id || '').trim() || '<missing>'}`,
            `observed_task_id=${String(repeatedBlocker.observed_task_id || '').trim() || '<missing>'}`,
            `matched_ancestor_task_id=${String(repeatedBlocker.matched_ancestor_task_id || '').trim() || '<missing>'}`,
            `fingerprint=${String(repeatedBlocker.blocker_fingerprint_sha256 || '').trim() || '<missing>'}`,
            `gate=${String(repeatedBlocker.gate || '').trim() || '<missing>'}`,
            `failure_class=${String(repeatedBlocker.failure_class || '').trim() || '<missing>'}`,
            `required_resolution=${String(repeatedBlocker.required_resolution || '').trim() || '<missing>'}`
        ].join('; ')
        : null;
    return {
        suggestedTaskId: taskId || null,
        summary,
        repeatedBlockerAnalysis
    };
}

function isFullSuiteTimeoutRepairTaskMaterialized(
    repoRoot: string,
    reviewsRoot: string,
    taskEntries: Map<string, TaskQueueEntry>,
    proposal: FullSuiteTimeoutRepairTaskProposal,
    taskId: string,
    fullSuiteArtifactPath: string
): boolean {
    if (!proposal.suggestedTaskId) {
        return false;
    }
    const decomposition = resolveFullSuiteRepairDecompositionState(
        repoRoot,
        taskId,
        { allowCompletedChildren: true }
    );
    if (
        !decomposition.ready
        || decomposition.child_task_ids.some((childTaskId) => !taskEntries.has(childTaskId))
    ) {
        return false;
    }
    return readFullSuiteRepairTaskMaterializationEvidence({
        repoRoot,
        reviewsRoot,
        taskId,
        fullSuiteArtifactPath,
        childTaskId: null,
        childTaskIds: decomposition.child_task_ids
    }).materialized;
}

function isFullSuiteWarningOnlyContinuationArtifact(
    artifact: Record<string, unknown> | null,
    currentCycle: boolean,
    lifecycleGatePassed: boolean,
    lifecycleWarningPolicyPresent: boolean
): boolean {
    const timeoutPolicy = getFullSuiteTimeoutPolicy(artifact);
    return currentCycle
        && lifecycleGatePassed
        && lifecycleWarningPolicyPresent
        && artifact?.status === 'WARNED'
        && artifact.timed_out === true
        && timeoutPolicy?.timeout_blocker === false
        && timeoutPolicy.warning_only_continuation === true;
}

function isFullSuiteLifecyclePassArtifactAccepted(
    artifact: Record<string, unknown> | null,
    currentCycle: boolean,
    lifecycleGatePassed: boolean
): boolean {
    if (!currentCycle || !lifecycleGatePassed) {
        return false;
    }
    if (artifact?.status === 'WARNED' && artifact.timed_out === true) {
        return false;
    }
    return true;
}

function isFullSuiteTimeoutBlockerExhaustedArtifact(
    artifact: Record<string, unknown> | null,
    currentCycle: boolean
): boolean {
    const timeoutPolicy = getFullSuiteTimeoutPolicy(artifact);
    const status = String(artifact?.status || '').trim();
    return currentCycle
        && (status === 'FAILED' || status === 'WARNED')
        && artifact?.timed_out === true
        && timeoutPolicy?.timeout_blocker !== false
        && timeoutPolicy?.attempts_exhausted === true;
}

interface FullSuiteManualRetryEvidence {
    available: boolean;
    reason: string | null;
}

interface FullSuiteTargetedDiagnosticEvidence {
    available: boolean;
    reason: string | null;
}

function readFullSuiteManualRetryEvidence(options: {
    repoRoot: string;
    taskId: string;
    fullSuiteArtifact: Record<string, unknown> | null;
    fullSuiteArtifactPath: string;
    preflightSha256: string | null;
    currentFailedFullSuite: boolean;
}): FullSuiteManualRetryEvidence {
    if (!options.currentFailedFullSuite || !isPlainRecord(options.fullSuiteArtifact)) {
        return { available: false, reason: null };
    }
    const evidencePath = joinOrchestratorPath(
        options.repoRoot,
        path.join('runtime', 'manual-validation', options.taskId, 'full-suite-retry-evidence.json')
    );
    if (!fileExists(evidencePath)) {
        return { available: false, reason: null };
    }
    let evidence: Record<string, unknown>;
    try {
        const parsed = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as unknown;
        if (!isPlainRecord(parsed)) {
            return { available: false, reason: null };
        }
        evidence = parsed;
    } catch {
        return { available: false, reason: null };
    }
    if (String(evidence.task_id || '').trim() !== options.taskId) {
        return { available: false, reason: null };
    }
    const allowedReasonKinds = new Set(['transient', 'out_of_scope', 'harness', 'focused_pass_after_failure']);
    const reasonKind = String(evidence.reason_kind || '').trim();
    if (!allowedReasonKinds.has(reasonKind)) {
        return { available: false, reason: null };
    }
    const expectedFailureArtifactSha256 = String(fileSha256(options.fullSuiteArtifactPath) || '').trim().toLowerCase();
    if (!expectedFailureArtifactSha256) {
        return { available: false, reason: null };
    }
    if (String(evidence.full_suite_failure_artifact_sha256 || '').trim().toLowerCase() !== expectedFailureArtifactSha256) {
        return { available: false, reason: null };
    }
    const expectedPreflightSha256 = String(options.preflightSha256 || '').trim().toLowerCase();
    if (!expectedPreflightSha256 || String(evidence.preflight_sha256 || '').trim().toLowerCase() !== expectedPreflightSha256) {
        return { available: false, reason: null };
    }
    const focusedValidation = isPlainRecord(evidence.focused_validation)
        ? evidence.focused_validation
        : null;
    const focusedCommand = String(focusedValidation?.command || '').trim();
    if (!focusedCommand) {
        return { available: false, reason: null };
    }
    const focusedStatus = String(focusedValidation?.status || '').trim().toUpperCase();
    const focusedExitCode = focusedValidation?.exit_code;
    const focusedExitCodePresent = Object.prototype.hasOwnProperty.call(focusedValidation || {}, 'exit_code');
    const focusedExitCodePassed = focusedExitCodePresent
        && typeof focusedExitCode === 'number'
        && Number.isInteger(focusedExitCode)
        && focusedExitCode === 0;
    const focusedStatusFailed = focusedStatus === 'FAILED' || focusedStatus === 'FAIL' || focusedStatus === 'ERROR';
    const focusedStatusPassed = focusedStatus === 'PASSED' || focusedStatus === 'PASS';
    const focusedExitCodeContradictsPass = focusedExitCodePresent && !focusedExitCodePassed;
    const focusedPassed = !focusedStatusFailed && !focusedExitCodeContradictsPass && (focusedExitCodePassed || focusedStatusPassed);
    if (!focusedPassed) {
        return { available: false, reason: null };
    }
    const reason = `Evidence: ${normalizePath(evidencePath)}; reason_kind=${reasonKind}${focusedCommand ? `; focused_command=${focusedCommand}` : ''}.`;
    return { available: true, reason };
}

function readFullSuiteTargetedDiagnosticEvidence(options: {
    eventsRoot: string;
    taskId: string;
    currentFailedFullSuite: boolean;
}): FullSuiteTargetedDiagnosticEvidence {
    if (!options.currentFailedFullSuite) {
        return { available: false, reason: null };
    }
    const timelinePath = path.join(options.eventsRoot, `${options.taskId}.jsonl`);
    const events = readOrderedTaskEvents(timelinePath).events;
    const failedIndex = findLatestCurrentTaskEventIndex(events, options.taskId, 'FULL_SUITE_VALIDATION_FAILED');
    if (failedIndex < 0) {
        return { available: false, reason: null };
    }
    for (let index = events.length - 1; index > failedIndex; index -= 1) {
        const event = events[index];
        if (String(event.task_id || '').trim() !== options.taskId) {
            continue;
        }
        if (String(event.event_type || '') !== 'INTERMEDIATE_COMMAND_RUN') {
            continue;
        }
        if (!isPassedIntermediateCommandEvent(event)) {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const artifactPath = String(details.artifact_path || '').trim();
        const commandSource = String(details.command_source || '').trim();
        const command = String(details.command || '').trim();
        const evidenceParts = [
            artifactPath ? `artifact=${normalizePath(artifactPath)}` : null,
            commandSource ? `command_source=${commandSource}` : null,
            command ? `command=${command}` : null
        ].filter((part): part is string => !!part);
        const reason = evidenceParts.length > 0
            ? `Evidence: ${evidenceParts.join('; ')}.`
            : null;
        return { available: true, reason };
    }
    return { available: false, reason: null };
}

function findLatestCurrentTaskEventIndex(
    events: TaskAuditEvent[],
    taskId: string,
    eventType: string
): number {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (
            String(event.task_id || '').trim() === taskId
            && String(event.event_type || '') === eventType
        ) {
            return index;
        }
    }
    return -1;
}


function resolveBundleRootForNextStep(repoRoot: string): string {
    const sourceCheckoutBundleRoot = path.resolve(repoRoot);
    return fs.existsSync(path.join(sourceCheckoutBundleRoot, 'bin', 'garda.js'))
        ? sourceCheckoutBundleRoot
        : path.join(sourceCheckoutBundleRoot, resolveBundleNameForTarget(repoRoot));
}

function artifactState(repoRoot: string, specs: ArtifactSpec[]): {
    present: NextStepArtifactState[];
    missing: NextStepArtifactState[];
} {
    const states = specs.map((spec) => ({
        key: spec.key,
        path: toRepoDisplayPath(repoRoot, spec.path),
        exists: fileExists(spec.path)
    }));
    return {
        present: states.filter((state) => state.exists),
        missing: states.filter((state) => !state.exists)
    };
}

function getGateStatus(summary: TaskAuditSummaryResult, gateName: string): GateOutcome['status'] | null {
    return summary.gates.find((gate) => gate.gate === gateName)?.status || null;
}

function isGatePassed(summary: TaskAuditSummaryResult, gateName: string): boolean {
    return getGateStatus(summary, gateName) === 'PASS';
}

function getRequiredReviewTypes(requiredReviews: Record<string, boolean>): string[] {
    return REVIEW_PREPARATION_ORDER.filter((reviewType) => requiredReviews[reviewType]);
}

function hasZeroDiffNoReviewableScopeSuppression(
    preflight: Record<string, unknown> | null,
    requiredReviewTypes: string[]
): boolean {
    return !!preflight
        && requiredReviewTypes.length === 0
        && isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflight);
}

function preflightRequiresAuditedNoOp(preflight: Record<string, unknown> | null): boolean {
    if (!preflight || !isPlainRecord(preflight.zero_diff_guard)) {
        return false;
    }
    const zeroDiffGuard = preflight.zero_diff_guard;
    return zeroDiffGuard.zero_diff_detected === true
        && zeroDiffGuard.completion_requires_audited_no_op === true;
}

type ReviewExecutionPolicySource = 'preflight' | 'task_profile' | 'workflow_config' | 'workflow_config_fallback';

function hasPreflightReviewPolicyMode(preflight: Record<string, unknown> | null): boolean {
    return !!preflight
        && isPlainRecord(preflight.review_execution_policy)
        && Object.prototype.hasOwnProperty.call(preflight.review_execution_policy, 'mode');
}

function resolveReviewPolicy(
    preflight: Record<string, unknown> | null,
    workflowPolicy: ResolvedReviewExecutionPolicyConfig,
    frozenPolicy?: FrozenReviewExecutionPolicyBinding | null
): {
    mode: EffectiveReviewExecutionPolicyMode;
    source: ReviewExecutionPolicySource;
} {
    const frozenCurrentContract = !!frozenPolicy && (
        Object.prototype.hasOwnProperty.call(frozenPolicy, 'review_dependency_graph')
        || Object.prototype.hasOwnProperty.call(frozenPolicy, 'full_suite_validation')
    );
    if (hasPreflightReviewPolicyMode(preflight)) {
        const mode = resolveReviewExecutionPolicyModeFromPreflight(preflight);
        if (frozenCurrentContract && mode !== frozenPolicy.mode) {
            throw new Error(
                `Preflight review execution policy mode '${mode}' does not match frozen task profile mode '${frozenPolicy.mode}'.`
            );
        }
        return {
            mode,
            source: 'preflight'
        };
    }
    if (!preflight && frozenCurrentContract) {
        return {
            mode: frozenPolicy.mode,
            source: 'task_profile'
        };
    }
    if (frozenCurrentContract) {
        throw new Error(
            'Preflight review execution policy is required by the frozen task profile; refusing live workflow fallback.'
        );
    }
    return {
        mode: workflowPolicy.mode,
        source: workflowPolicy.configured ? 'workflow_config' : 'workflow_config_fallback'
    };
}

function resolveFrozenReviewExecutionPolicyBinding(
    taskMode: Record<string, unknown> | null
): FrozenReviewExecutionPolicyBinding | null {
    const profileSnapshot = isPlainRecord(taskMode?.profile_policy_snapshot)
        ? taskMode.profile_policy_snapshot
        : null;
    return profileSnapshot && isPlainRecord(profileSnapshot.review_execution_policy)
        ? profileSnapshot.review_execution_policy as unknown as FrozenReviewExecutionPolicyBinding
        : null;
}

function resolveTimelineBoundReviewDependencyGraph(
    eventsRoot: string,
    taskId: string,
    preflight: Record<string, unknown> | null
): EffectiveReviewSnapshot['review_dependency_graph'] | undefined {
    if (!preflight?.effective_review_snapshot) {
        return undefined;
    }
    const timeline = readOrderedTaskEvents(path.join(eventsRoot, `${taskId}.jsonl`)).events;
    let latestPreflightEvent: (typeof timeline)[number] | undefined;
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
        const event = timeline[index];
        if (String(event.event_type || '').trim().toUpperCase() === 'PREFLIGHT_CLASSIFIED') {
            latestPreflightEvent = event;
            break;
        }
    }
    const eventDetails = isPlainRecord(latestPreflightEvent?.details)
        ? latestPreflightEvent.details
        : null;
    const eventSnapshot = eventDetails?.effective_review_snapshot;
    if (!eventSnapshot) {
        throw new Error(
            'Latest PREFLIGHT_CLASSIFIED timeline event is missing the effective review snapshot binding.'
        );
    }
    const preflightSnapshot = preflight.effective_review_snapshot;
    const eventViolations = getEffectiveReviewSnapshotViolations(eventSnapshot);
    const preflightViolations = getEffectiveReviewSnapshotViolations(preflightSnapshot);
    if (eventViolations.length > 0 || preflightViolations.length > 0) {
        throw new Error(
            `Current-cycle effective review snapshot binding is invalid: ${[
                ...eventViolations,
                ...preflightViolations
            ].join('; ')}`
        );
    }
    const eventSnapshotRecord = eventSnapshot as EffectiveReviewSnapshot;
    const preflightSnapshotRecord = preflightSnapshot as EffectiveReviewSnapshot;
    if (eventSnapshotRecord.snapshot_sha256 !== preflightSnapshotRecord.snapshot_sha256) {
        throw new Error(
            'Preflight effective review snapshot does not match the latest PREFLIGHT_CLASSIFIED timeline binding.'
        );
    }
    return eventSnapshotRecord.review_dependency_graph;
}

function resolveTaskQueueCaseMismatch(taskEntries: Map<string, TaskQueueEntry>, taskId: string): string | null {
    const normalizedTaskId = taskId.toLowerCase();
    for (const entryTaskId of taskEntries.keys()) {
        if (entryTaskId !== taskId && entryTaskId.toLowerCase() === normalizedTaskId) {
            return entryTaskId;
        }
    }
    return null;
}

function parseOptionalNumberField(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function readWorkflowConfigRecordForNextStep(repoRoot: string): Record<string, unknown> | null {
    const workflowConfigPath = resolveWorkflowConfigPath(repoRoot);
    assertWorkflowTransactionReadable(path.dirname(path.dirname(path.dirname(workflowConfigPath))));
    if (!fileExists(workflowConfigPath)) {
        return null;
    }

    let workflowConfig: unknown;
    try {
        workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
    } catch (error: unknown) {
        throw new Error(
            `Workflow config at '${toRepoDisplayPath(repoRoot, workflowConfigPath)}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (!isPlainRecord(workflowConfig)) {
        throw new Error(
            `Workflow config at '${toRepoDisplayPath(repoRoot, workflowConfigPath)}' must be a JSON object.`
        );
    }
    return workflowConfig;
}

function resolveReviewExecutionPolicyForNextStep(
    workflowConfig: Record<string, unknown> | null
): ResolvedReviewExecutionPolicyConfig {
    return resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig(
        workflowConfig,
        LEGACY_REVIEW_EXECUTION_POLICY_MODE
    );
}

function readScopeBudgetGuardEvaluation(
    repoRoot: string,
    preflight: Record<string, unknown> | null,
    profileSummary: NextStepProfileSummary | null,
    requiredReviewTypes: string[]
): ScopeBudgetGuardEvaluation | null {
    if (!preflight) {
        return null;
    }
    const budgetForecast = isPlainRecord(preflight.budget_forecast) ? preflight.budget_forecast : {};
    const defaultWorkflowConfig = buildDefaultWorkflowConfig();
    let rawScopeBudgetGuard: unknown = defaultWorkflowConfig.scope_budget_guard;
    const workflowConfig = readWorkflowConfigRecordForNextStep(repoRoot);
    if (workflowConfig?.scope_budget_guard !== undefined) {
        const validatedWorkflowConfig = validateWorkflowConfig({
            full_suite_validation: defaultWorkflowConfig.full_suite_validation,
            review_execution_policy: defaultWorkflowConfig.review_execution_policy,
            scope_budget_guard: workflowConfig.scope_budget_guard
        });
        rawScopeBudgetGuard = isPlainRecord(validatedWorkflowConfig.scope_budget_guard)
            ? validatedWorkflowConfig.scope_budget_guard
            : defaultWorkflowConfig.scope_budget_guard;
    }

    const changedFilesCount = readScopeBudgetChangedFilesCount(preflight);
    const changedLinesTotal = readScopeBudgetChangedLinesTotal(preflight);
    const totalEstimatedReviewTokens =
        parseOptionalNumberField(budgetForecast.total_estimated_review_tokens)
        ?? 0;
    return evaluateScopeBudgetGuard(
        normalizeScopeBudgetGuardConfig(rawScopeBudgetGuard),
        {
            profileName: profileSummary?.effective_profile || profileSummary?.task_selected_profile || null,
            changedFilesCount,
            changedLinesTotal,
            requiredReviewCount: requiredReviewTypes.length,
            totalEstimatedReviewTokens
        }
    );
}

function buildNextStepProfileSummary(
    repoRoot: string,
    taskEntry: TaskQueueEntry | null,
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null
): NextStepProfileSummary | null {
    const rawTaskProfile = typeof taskMode?.task_profile === 'string' && taskMode.task_profile.trim()
        ? taskMode.task_profile.trim()
        : typeof taskEntry?.profile === 'string' && taskEntry.profile.trim()
            ? taskEntry.profile.trim()
            : null;

    let resolvedSelection: ReturnType<typeof resolveTaskProfileSelection>['selection'] | null;
    try {
        resolvedSelection = resolveTaskProfileSelection(
            resolveBundleRootForTarget(repoRoot),
            rawTaskProfile,
            typeof preflight?.scope_category === 'string' ? preflight.scope_category : null
        ).selection;
    } catch {
        resolvedSelection = null;
    }

    const budgetForecast = preflight?.budget_forecast && typeof preflight.budget_forecast === 'object'
        ? preflight.budget_forecast as Record<string, unknown>
        : null;
    const depthEscalation = preflight?.depth_escalation && typeof preflight.depth_escalation === 'object'
        ? preflight.depth_escalation as Record<string, unknown>
        : null;
    const frozenTaskDecomposition = isPlainRecord(taskMode?.profile_policy_snapshot)
        ? resolveTaskProfileTaskDecompositionPolicy(
            taskMode.profile_policy_snapshot as unknown as TaskProfilePolicySnapshot
        )
        : null;
    let liveTaskDecomposition: ReturnType<typeof resolveTaskProfileSelection>['effective_policy']['task_decomposition'] | null = null;
    if (!frozenTaskDecomposition) {
        try {
            liveTaskDecomposition = resolveTaskProfileSelection(
                resolveBundleRootForTarget(repoRoot),
                rawTaskProfile,
                typeof preflight?.scope_category === 'string' ? preflight.scope_category : null
            ).effective_policy.task_decomposition;
        } catch {
            liveTaskDecomposition = null;
        }
    }
    const legacyProfileName = String(
        taskMode?.active_profile
        || rawTaskProfile
        || resolvedSelection?.effective_profile
        || ''
    ).trim().toLowerCase();
    const taskDecomposition = frozenTaskDecomposition || liveTaskDecomposition || {
        enabled: legacyProfileName === 'strict' || legacyProfileName === 'balanced',
        configured: false,
        provenance: legacyProfileName === 'strict'
            ? 'legacy_snapshot_strict_compatibility'
            : legacyProfileName === 'balanced'
                ? 'legacy_snapshot_balanced_default'
                : 'legacy_snapshot_disabled_default'
    };

    const summary: NextStepProfileSummary = {
        task_selected_profile: rawTaskProfile || resolvedSelection?.task_profile || null,
        profile_selection_source:
            (typeof taskMode?.profile_selection_source === 'string' && taskMode.profile_selection_source.trim())
            || resolvedSelection?.profile_selection_source
            || null,
        effective_profile:
            (typeof taskMode?.active_profile === 'string' && taskMode.active_profile.trim())
            || resolvedSelection?.effective_profile
            || null,
        effective_profile_source:
            (typeof taskMode?.profile_source === 'string' && taskMode.profile_source.trim())
            || resolvedSelection?.effective_profile_source
            || null,
        runtime_active_profile:
            (typeof taskMode?.runtime_active_profile === 'string' && taskMode.runtime_active_profile.trim())
            || resolvedSelection?.runtime_active_profile
            || null,
        runtime_active_profile_source:
            (typeof taskMode?.runtime_profile_source === 'string' && taskMode.runtime_profile_source.trim())
            || resolvedSelection?.runtime_profile_source
            || null,
        task_decomposition_enabled: taskDecomposition?.enabled ?? null,
        task_decomposition_configured: taskDecomposition?.configured ?? null,
        task_decomposition_provenance: taskDecomposition?.provenance ?? null,
        requested_depth:
            parseOptionalNumberField(budgetForecast?.requested_depth)
            ?? parseOptionalNumberField(taskMode?.requested_depth),
        effective_depth:
            parseOptionalNumberField(budgetForecast?.effective_depth)
            ?? parseOptionalNumberField(preflight?.risk_aware_depth && typeof preflight.risk_aware_depth === 'object'
                ? (preflight.risk_aware_depth as Record<string, unknown>).effective_depth
                : null)
            ?? parseOptionalNumberField(taskMode?.effective_depth),
        depth_escalation_reason:
            typeof depthEscalation?.escalation_reason === 'string' && depthEscalation.escalation_reason.trim()
                ? depthEscalation.escalation_reason.trim()
                : null,
        total_forecast_tokens: parseOptionalNumberField(budgetForecast?.total_forecast_tokens),
        effective_forecast_tokens: parseOptionalNumberField(budgetForecast?.effective_forecast_tokens),
        token_economy_active_for_depth:
            typeof budgetForecast?.token_economy_active_for_depth === 'boolean'
                ? budgetForecast.token_economy_active_for_depth
                : null
    };

    if (
        summary.task_selected_profile == null
        && summary.effective_profile == null
        && summary.runtime_active_profile == null
        && summary.task_decomposition_enabled == null
        && summary.requested_depth == null
        && summary.effective_depth == null
        && summary.total_forecast_tokens == null
    ) {
        return null;
    }

    return summary;
}

function resolveProviderFromEnvironment(): string | null {
    return resolveProviderFromRegistryEnvironment(process.env);
}

function isGardaSelfGuardDenyAgentEntry(repoRoot: string): boolean {
    return isGardaSelfGuardDenyAgentEntryForBundle(
        isOrchestratorSourceCheckout(repoRoot),
        resolveBundleRootForNextStep(repoRoot)
    );
}

function getPreflightTriggers(preflight: Record<string, unknown> | null): Record<string, unknown> {
    return isPlainRecord(preflight?.triggers) ? preflight.triggers : {};
}

function preflightTouchesProtectedControlPlane(preflight: Record<string, unknown> | null): boolean {
    const triggers = getPreflightTriggers(preflight);
    if (triggers.protected_control_plane_changed === true) {
        return true;
    }
    return Array.isArray(triggers.changed_protected_files) && triggers.changed_protected_files.length > 0;
}

function getPreflightChangedFilesForReviewRemediation(preflight: Record<string, unknown> | null): string[] {
    return Array.isArray(preflight?.changed_files)
        ? preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
}

function getExpandedNonTestReviewRemediationFiles(params: {
    repoRoot: string;
    taskId: string;
    preflight: Record<string, unknown> | null;
    currentChangedFiles?: readonly string[];
    taskMode: Record<string, unknown> | null;
}): string[] {
    if (!params.preflight || !params.currentChangedFiles || params.currentChangedFiles.length === 0) {
        return [];
    }
    const classificationConfig = getClassificationConfig(params.repoRoot);
    const scopeBoundary = assessReviewRemediationScopeBoundary(
        getPreflightChangedFilesForReviewRemediation(params.preflight),
        params.currentChangedFiles,
        [
            ...getTaskModeDirtyWorkspaceBaselineChangedFiles(params.repoRoot, params.taskMode),
            ...getTaskManualValidationBoundaryFiles(params.taskId, params.currentChangedFiles)
        ],
        classificationConfig.test_trigger_regexes
    );
    return scopeBoundary.expandedNonTestFiles;
}

type CurrentGitWorkspaceSnapshot = NonNullable<ReturnType<typeof readCurrentGitWorkspaceSnapshot>>;

function getFilteredNoPreflightClassifyChangedFiles(
    repoRoot: string,
    taskMode?: Record<string, unknown> | null,
    currentSnapshot?: CurrentGitWorkspaceSnapshot | null
): string[] | undefined {
    const workspaceSnapshot = currentSnapshot === undefined
        ? readCurrentGitWorkspaceSnapshot(repoRoot, true)
        : currentSnapshot;
    if (!workspaceSnapshot) {
        return undefined;
    }
    const rawChangedFiles = [...new Set(
        workspaceSnapshot.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
    )].sort();
    const filteredChangedFiles = filterSourceCheckoutGeneratedRuntimeArtifacts(repoRoot, rawChangedFiles);
    const ignoredGeneratedRuntimeFiles = Array.isArray((workspaceSnapshot as Record<string, unknown>).ignored_generated_runtime_files)
        ? ((workspaceSnapshot as Record<string, unknown>).ignored_generated_runtime_files as unknown[])
            .map((entry) => normalizePath(entry))
            .filter(Boolean)
        : [];
    const taskModeChangedFiles = taskMode?.workflow_config_work === true
        ? filterSourceCheckoutGeneratedRuntimeArtifacts(repoRoot, getTaskModePlannedChangedFiles(taskMode))
        : [];
    const filteredWithTaskModeScope = [...new Set([
        ...filteredChangedFiles,
        ...taskModeChangedFiles
    ])].sort();
    if (ignoredGeneratedRuntimeFiles.length > 0 && filteredChangedFiles.length > 0) {
        return filteredWithTaskModeScope;
    }
    return filteredChangedFiles.length !== rawChangedFiles.length
        ? filteredWithTaskModeScope
        : undefined;
}

function getOrdinaryDocReviewSkips(preflight: Record<string, unknown> | null): { path: string; pattern: string }[] {
    const triggers = getPreflightTriggers(preflight);
    const matches = Array.isArray(triggers.ordinary_doc_path_matches)
        ? triggers.ordinary_doc_path_matches
        : [];
    return matches
        .map((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return null;
            }
            const raw = entry as Record<string, unknown>;
            const matchedPath = normalizePath(raw.path);
            const pattern = normalizePath(raw.pattern);
            return matchedPath && pattern ? { path: matchedPath, pattern } : null;
        })
        .filter((entry): entry is { path: string; pattern: string } => entry !== null)
        .sort((left, right) => left.path.localeCompare(right.path) || left.pattern.localeCompare(right.pattern));
}

function readStringArrayFromObjects(value: unknown, fieldName: string): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return null;
            }
            return String((entry as Record<string, unknown>)[fieldName] || '').trim() || null;
        })
        .filter((entry): entry is string => entry !== null)
        .sort();
}

function readOptionalSkillSelectionDetails(value: unknown): NextStepOptionalSkillSelectionSummary['selected_skill_details'] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return null;
            }
            const raw = entry as Record<string, unknown>;
            const id = String(raw.id || '').trim();
            const source = String(raw.source || '').trim();
            const allowedSkillPath = String(raw.allowed_skill_path || '').trim();
            if (!id || !source || !allowedSkillPath) {
                return null;
            }
            const pack = String(raw.pack || '').trim() || null;
            return {
                id,
                pack,
                source,
                allowed_skill_path: allowedSkillPath
            };
        })
        .filter((entry): entry is NextStepOptionalSkillSelectionSummary['selected_skill_details'][number] => entry !== null)
        .sort((left, right) => left.id.localeCompare(right.id));
}

function buildOptionalSkillTaskStartInstruction(input: {
    policyMode: string | null;
    selectedSkillIds: string[];
    pendingActivationSkillIds: string[];
    declinedSkillIds: string[];
    recommendedMissingPackIds: string[];
    asIsReason: string | null;
    skillCatalogPath: string | null;
    activationCommands: string[];
    declineCommands: string[];
    selectionPhase: string;
    pathEvidenceSource: string;
    artifactViolations: string[];
}): string {
    if (input.artifactViolations.length > 0) {
        return `Optional skill selection artifact is invalid for current navigator use: ${input.artifactViolations.join(' ')} Rerun classify-change for the current task cycle before activation or review continuation.`;
    }
    if (input.policyMode === 'off') {
        return 'Optional skill selection is disabled by policy; proceed without specialized optional skill activation.';
    }
    if (input.selectionPhase === 'post_diff') {
        if (input.selectedSkillIds.length > 0) {
            return `Selected optional skill(s): ${input.selectedSkillIds.join(', ')} surfaced from post-diff changed paths. Treat this as a post-implementation self-check only; do not activate it as pre-implementation skill use.`;
        }
        if (input.recommendedMissingPackIds.length > 0) {
            return `Optional skill recommendation(s): ${input.recommendedMissingPackIds.join(', ')} surfaced from post-diff changed paths. Treat this as a post-implementation self-check only; do not install or activate them as pre-implementation gate work.`;
        }
        const reason = input.asIsReason || 'generic_context_sufficient';
        return `Optional skill selection surfaced post-diff as_is (${reason}). Treat this as a post-implementation self-check only; no pre-implementation activation is required.`;
    }
    if (input.selectedSkillIds.length > 0) {
        const skillList = input.selectedSkillIds.join(', ');
        if (input.declinedSkillIds.length > 0 && input.pendingActivationSkillIds.length === 0) {
            return `Selected optional skill(s): ${skillList}. Explicit non-use is recorded for ${input.declinedSkillIds.join(', ')}; continue with the normal navigator command.`;
        }
        if (input.pendingActivationSkillIds.length > 0 && input.activationCommands.length > 0) {
            if (isMandatoryOptionalSkillSelectionPolicyMode(input.policyMode)) {
                return `Selected optional skill(s): ${skillList}. Run the activation command(s) before implementation so the timeline records the required chosen role/skill.`;
            }
            const declineHint = input.declineCommands.length > 0
                ? ' If you intentionally will not use it, run the decline command so next-step stops repeating the activation hint.'
                : '';
            return `Selected optional skill(s): ${skillList}. If you use the selected skill, run the activation command(s) before implementation so the timeline records that choice; otherwise continue with the normal navigator command.${declineHint}`;
        }
        if (input.pendingActivationSkillIds.length === 0) {
            return `Selected optional skill(s): ${skillList}. Current-cycle activation evidence is present; continue with the normal navigator command.`;
        }
        return `Selected optional skill(s): ${skillList}. Rerun the navigator until classify-change materializes current-cycle selection evidence, then activate the selected skill before implementation.`;
    }
    if (input.recommendedMissingPackIds.length > 0) {
        if (isMandatoryOptionalSkillSelectionPolicyMode(input.policyMode)) {
            return `Mandatory optional skill selection found missing pack recommendation(s): ${input.recommendedMissingPackIds.join(', ')}. Install a recommended pack, create or choose an installed specialist skill, then rerun classify-change and activation before implementation.`;
        }
        return `No installed optional skill is selected; missing pack recommendation(s): ${input.recommendedMissingPackIds.join(', ')}. Inspect the compact skill catalog before implementation and either install/select a pack through the supported flow or proceed with the recorded no-specialized-skill decision.`;
    }
    const reason = input.asIsReason || 'generic_context_sufficient';
    if (isMandatoryOptionalSkillSelectionPolicyMode(input.policyMode)) {
        return `Mandatory optional skill selection has no installed specialist skill selected (reason: ${reason}). Install or create a relevant specialist skill, choose it for this task, then rerun classify-change and activation before implementation.`;
    }
    const catalogHint = input.skillCatalogPath ? ` Compact catalog: ${input.skillCatalogPath}.` : '';
    return `No specialized optional skill selected; current-cycle evidence records as_is (${reason}). Inspect the compact skill catalog if that looks wrong; otherwise this is the explicit no-specialized-skill-needed decision.${catalogHint}`;
}

function buildOptionalSkillSelectionSummary(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflight: Record<string, unknown> | null,
    taskText: string | null
): NextStepOptionalSkillSelectionSummary | null {
    const preflightOptional = preflight?.optional_skill_selection;
    if (!preflightOptional || typeof preflightOptional !== 'object' || Array.isArray(preflightOptional)) {
        return null;
    }
    const preflightOptionalRecord = preflightOptional as Record<string, unknown>;
    const bundleRoot = path.join(repoRoot, resolveBundleNameForTarget(repoRoot));
    const artifactPath = normalizePath(String(preflightOptionalRecord.artifact_path || '').trim());
    const resolvedArtifactPath = artifactPath
        ? resolvePathInsideRepo(artifactPath, repoRoot, { allowMissing: true })
        : null;
    const artifact = readOptionalSkillSelectionArtifact(
        bundleRoot,
        taskId
    );
    const artifactPayload = artifact?.payload || null;
    const policyConfigPath = getOptionalSkillSelectionConfigPath(bundleRoot);
    const hasCurrentPolicyConfig = fs.existsSync(policyConfigPath)
        || isOptionalSkillSelectionPolicyConfigured(bundleRoot);
    const currentPolicyMode = hasCurrentPolicyConfig
        ? readOptionalSkillSelectionPolicyConfig(bundleRoot).mode
        : null;
    const artifactViolations = artifact
        ? getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact, {
            requireMaterializedArtifact: false,
            validateAgainstCurrentHeadlines: false,
            validateAgainstCurrentInventory: false,
            expectedTaskTextSha256: computeOptionalSkillTaskTextSha256(String(taskText || '')),
            ...(currentPolicyMode ? { expectedPolicyMode: currentPolicyMode } : {})
        })
        : [];
    const artifactValid = artifactViolations.length === 0;
    const selectedSkillIds = readStringArrayFromObjects(artifactPayload?.selected_installed_skills, 'id');
    const selectedSkillSources = readStringArrayFromObjects(artifactPayload?.selected_installed_skills, 'source');
    const selectedSkillDetails = readOptionalSkillSelectionDetails(artifactPayload?.selected_installed_skills);
    const recommendedMissingPackIds = readStringArrayFromObjects(artifactPayload?.recommended_missing_packs, 'id');
    const rawPolicyMode = String(preflightOptionalRecord.policy_mode || artifactPayload?.policy_mode || '').trim();
    const snapshotPolicyMode = rawPolicyMode ? normalizeOptionalSkillSelectionPolicyMode(rawPolicyMode) : null;
    // Prefer live config when present so policy switches invalidate stale selection routing.
    const policyMode = currentPolicyMode ?? snapshotPolicyMode;
    const decision = String(preflightOptionalRecord.decision || artifactPayload?.decision || '').trim() || null;
    const selectionPhase = normalizeOptionalSkillSelectionPhase(
        artifactPayload?.selection_phase || preflightOptionalRecord.selection_phase,
        'pre_implementation'
    );
    const pathEvidenceSource = normalizeOptionalSkillPathEvidenceSource(
        artifactPayload?.path_evidence_source || preflightOptionalRecord.path_evidence_source,
        selectionPhase === 'post_diff' ? 'actual_changed_files' : 'none'
    );
    const isPostDiffSelection = selectionPhase === 'post_diff';
    const asIsReason = String(artifactPayload?.as_is_reason || '').trim() || null;
    const changedPaths = Array.isArray(artifactPayload?.changed_paths)
        ? artifactPayload.changed_paths
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
        : [];
    const changedPathsCount = changedPaths.length;
    const visibleSummaryLine = String(preflightOptionalRecord.visible_summary_line || artifactPayload?.visible_summary_line || '').trim() || null;
    const skillCatalogPath = String(artifactPayload?.headlines_path || '').trim() || null;
    const timelineEvidence = artifactPayload
        ? readOptionalSkillSelectionTimelineEvidence(
            bundleRoot,
            taskId
        )
        : null;
    const timelineInvalidJson = timelineEvidence?.invalidJson === true;
    const isMandatoryPolicy = isMandatoryOptionalSkillSelectionPolicyMode(policyMode);
    const activationIndex = artifactPayload && artifactValid && timelineEvidence && !timelineEvidence.invalidJson
        ? isMandatoryPolicy
            ? buildMandatoryCurrentCycleOptionalSkillActivationIndex(artifactPayload, timelineEvidence)
            : buildCurrentCycleOptionalSkillActivationIndex(artifactPayload, timelineEvidence)
        : new Map<string, number>();
    const declineIndex = artifactPayload && artifactValid && timelineEvidence && !timelineEvidence.invalidJson
        ? buildCurrentCycleOptionalSkillDeclineIndex(artifactPayload, timelineEvidence)
        : new Map<string, number>();
    const activatedSkillIds = selectedSkillIds.filter((skillId) => activationIndex.has(skillId));
    const declinedSkillIds = isMandatoryPolicy
        ? []
        : selectedSkillIds.filter((skillId) => declineIndex.has(skillId) && !activationIndex.has(skillId));
    const pendingActivationSkillIds = artifactValid && decision === 'selected_installed_skills' && !isPostDiffSelection
        ? selectedSkillIds.filter((skillId) => !activationIndex.has(skillId) && (isMandatoryPolicy || !declineIndex.has(skillId)))
        : [];
    const activationCommands = pendingActivationSkillIds.map((skillId) => (
        `${cliPrefix} gate activate-optional-skill --task-id ${quoteCommandValue(taskId)} --skill-id ${quoteCommandValue(skillId)} --repo-root "."`
    ));
    const declineCommands = pendingActivationSkillIds
        .filter(() => !isMandatoryOptionalSkillSelectionPolicyMode(policyMode))
        .map((skillId) => (
            `${cliPrefix} gate decline-optional-skill --task-id ${quoteCommandValue(taskId)} --skill-id ${quoteCommandValue(skillId)} --reason "not_used_for_current_implementation" --repo-root "."`
        ));
    return {
        artifact_path: artifactPath || null,
        artifact_present: resolvedArtifactPath ? fs.existsSync(resolvedArtifactPath) : false,
        artifact_violations: artifactViolations,
        timeline_invalid_json: timelineInvalidJson,
        current_policy_mode: currentPolicyMode,
        policy_mode: policyMode,
        decision,
        selection_phase: selectionPhase,
        path_evidence_source: pathEvidenceSource,
        post_diff_self_check: isPostDiffSelection && selectedSkillIds.length > 0,
        selected_skill_ids: selectedSkillIds,
        selected_skill_sources: selectedSkillSources,
        selected_skill_details: selectedSkillDetails,
        activated_skill_ids: activatedSkillIds,
        declined_skill_ids: declinedSkillIds,
        pending_activation_skill_ids: pendingActivationSkillIds,
        recommended_missing_pack_ids: recommendedMissingPackIds,
        as_is_reason: asIsReason,
        changed_paths: changedPaths,
        changed_paths_count: changedPathsCount,
        visible_summary_line: visibleSummaryLine,
        activation_commands: decision === 'selected_installed_skills' && !isPostDiffSelection ? activationCommands : [],
        decline_commands: decision === 'selected_installed_skills' && !isPostDiffSelection ? declineCommands : [],
        skill_catalog_path: skillCatalogPath,
        task_start_instruction: buildOptionalSkillTaskStartInstruction({
            policyMode,
            selectedSkillIds,
            pendingActivationSkillIds,
            declinedSkillIds,
            recommendedMissingPackIds,
            asIsReason,
            skillCatalogPath,
            activationCommands: decision === 'selected_installed_skills' && !isPostDiffSelection ? activationCommands : [],
            declineCommands: decision === 'selected_installed_skills' && !isPostDiffSelection ? declineCommands : [],
            selectionPhase,
            pathEvidenceSource,
            artifactViolations
        })
    };
}

function getPendingOptionalSkillActivationCommand(
    optionalSkillSelection: NextStepOptionalSkillSelectionSummary | null
): { skillId: string; command: string } | null {
    if (!optionalSkillSelection || optionalSkillSelection.decision !== 'selected_installed_skills') {
        return null;
    }
    if (optionalSkillSelection.artifact_violations.length > 0) {
        return null;
    }
    if (optionalSkillSelection.timeline_invalid_json) {
        return null;
    }
    if (!isMandatoryOptionalSkillSelectionPolicyMode(optionalSkillSelection.policy_mode)) {
        return null;
    }
    const pendingSkillId = optionalSkillSelection.pending_activation_skill_ids[0];
    if (!pendingSkillId) {
        return null;
    }
    const command = optionalSkillSelection.activation_commands[0] || null;
    return command ? { skillId: pendingSkillId, command } : null;
}

function getAvailableRelevantOptionalSkillSuggestions(input: {
    repoRoot: string;
    taskText: string;
    changedPaths: string[];
}): string[] {
    try {
        const result = suggestSkills(
            path.join(input.repoRoot, resolveBundleNameForTarget(input.repoRoot)),
            input.repoRoot,
            {
                taskText: input.taskText,
                changedPaths: input.changedPaths,
                limit: 5,
                packLimit: 0
            }
        );
        return result.availableRelevantSkills
            .map((skill) => String(skill.id || '').trim())
            .filter(Boolean)
            .sort();
    } catch {
        return [];
    }
}

function isOptionalSkillPackInstalled(repoRoot: string, packId: string): boolean {
    try {
        const bundleRoot = path.join(repoRoot, resolveBundleNameForTarget(repoRoot));
        return readInstalledSkillPacks(bundleRoot).installedPackIds.includes(packId);
    } catch {
        return false;
    }
}

function getMandatoryOptionalSkillRemediationCommand(
    optionalSkillSelection: NextStepOptionalSkillSelectionSummary | null,
    cliPrefix: string,
    taskText: string,
    options: {
        repoRoot: string;
        reclassifyCommand: string;
    }
): { label: string; command: string; reason: string } | null {
    if (!optionalSkillSelection || !isMandatoryOptionalSkillSelectionPolicyMode(optionalSkillSelection.policy_mode)) {
        return null;
    }
    if (optionalSkillSelection.artifact_violations.length > 0) {
        return null;
    }
    if (optionalSkillSelection.selection_phase === 'post_diff') {
        return null;
    }
    if (optionalSkillSelection.decision === 'selected_installed_skills') {
        return null;
    }
    if (optionalSkillSelection.decision === 'as_is' && optionalSkillSelection.changed_paths_count === 0) {
        return null;
    }

    const recommendedPackId = optionalSkillSelection.recommended_missing_pack_ids[0] || null;
    if (recommendedPackId) {
        // Cheap inventory check avoids suggestSkills discovery I/O on the missing-pack path.
        if (isOptionalSkillPackInstalled(options.repoRoot, recommendedPackId)) {
            return {
                label: 'Rematerialize optional skill selection',
                command: options.reclassifyCommand,
                reason:
                    `Mandatory optional skill selection recommended missing pack ${formatNextStepInlineValue(recommendedPackId)}, ` +
                    `but pack ${formatNextStepInlineValue(recommendedPackId)} is already installed. ` +
                    'Rerun classify-change to materialize selected_installed_skills evidence, then activate the selected skill before implementation. ' +
                    'Do not treat the current as_is/missing-pack decision as activation; choose the installed specialist through rematerialization.'
            };
        }
        return {
            label: `Install optional skill pack ${recommendedPackId}`,
            command: `${cliPrefix} skills add ${quoteCommandValue(recommendedPackId)} --target-root "."`,
            reason:
                `Mandatory optional skill selection recommended missing pack ${formatNextStepInlineValue(recommendedPackId)}, ` +
                'but no installed specialist skill is selected. Install or create an appropriate specialist skill, then rerun classify-change and activate the selected skill before implementation.'
        };
    }

    // For as_is (and other non-missing-pack decisions), probe installed relevant suggestions
    // so the navigator rematerializes instead of looping on skills suggest.
    const relevantInstalledSuggestionIds = getAvailableRelevantOptionalSkillSuggestions({
        repoRoot: options.repoRoot,
        taskText,
        changedPaths: optionalSkillSelection.changed_paths
    });
    if (relevantInstalledSuggestionIds.length > 0) {
        return {
            label: 'Rematerialize optional skill selection',
            command: options.reclassifyCommand,
            reason:
                `Mandatory optional skill selection produced decision ${formatNextStepInlineValue(optionalSkillSelection.decision || 'unknown')}, ` +
                `but installed relevant skill suggestion(s) are already available: ${formatNextStepInlineList(relevantInstalledSuggestionIds)}. ` +
                'Rerun classify-change to materialize selected_installed_skills evidence, then activate the selected skill before implementation. ' +
                'Do not treat the current as_is/missing-pack decision as activation; choose the installed specialist through rematerialization.'
        };
    }

    return {
        label: 'Inspect specialist skill suggestions',
        command: `${cliPrefix} skills suggest --task-text ${quoteCommandValue(taskText)} --target-root "."`,
        reason:
            `Mandatory optional skill selection produced decision ${formatNextStepInlineValue(optionalSkillSelection.decision || 'unknown')} ` +
            'without an installed specialist skill. Install or create an appropriate specialist skill, choose it for this task, then rerun classify-change and activate it before implementation.'
    };
}

function buildResult(params: {
    taskId: string;
    navigatorCommand: string;
    status: NextStepStatus;
    nextGate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    missingArtifacts: NextStepArtifactState[];
    presentArtifacts: NextStepArtifactState[];
    fullSuite: NextStepFullSuiteSummary;
    projectMemory?: NextStepProjectMemorySummary | null;
    review: NextStepReviewSummary;
    auditStatus: TaskAuditSummaryResult['status'];
    profile: NextStepProfileSummary | null;
    markdownWorkingPlan?: TaskModeMarkdownWorkingPlanMetadata | null;
    optionalSkillSelection?: NextStepOptionalSkillSelectionSummary | null;
    taskStartGuidance?: NextStepTaskStartGuidanceSummary | null;
    qualityChecklist?: NextStepQualityChecklistSummary | null;
    warnings?: string[];
    reviewCycleBlock?: NextStepReviewCycleBlock | null;
    finalReport?: NextStepFinalReportSummary | null;
    sourceRuntimeStaleness?: SourceCheckoutRuntimeStalenessResult | null;
}): NextStepResult {
    const intendedGateCommand = params.commands.find((command) => /\bgate\s+[a-z0-9-]+/iu.test(command.command));
    if (
        params.sourceRuntimeStaleness?.isStale
        && params.nextGate !== 'source-runtime-remediation'
        && intendedGateCommand
    ) {
        return buildSourceRuntimeRemediationResult({
            ...params,
            intendedGate: params.nextGate || intendedGateCommand.label,
            intendedCommand: intendedGateCommand.command,
            staleness: params.sourceRuntimeStaleness
        });
    }
    const invalidationImpact = buildInvalidationImpactSummary(params);
    const knownNonBlockingSignals = collectKnownNonBlockingSignals({
        projectMemory: params.projectMemory || null,
        nextGate: params.nextGate,
        reason: params.reason,
        commands: params.commands
    });
    return renderNextStepOutput({
        ...params,
        invalidationImpact,
        knownNonBlockingSignals,
        taskQueueStatusContract: buildTaskQueueStatusContract(params.taskId)
    });
}

function buildFinalCloseoutMissingArtifacts(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    paths: {
        finalCloseoutJsonPath: string;
        finalCloseoutMarkdownPath: string;
    }
): NextStepArtifactState[] {
    const finalUserReportPath = path.join(reviewsRoot, `${taskId}-final-user-report.md`);
    return [
        { key: 'final-closeout-json', path: paths.finalCloseoutJsonPath },
        { key: 'final-closeout-markdown', path: paths.finalCloseoutMarkdownPath },
        { key: 'final-user-report', path: finalUserReportPath }
    ].map((artifact) => ({
        key: artifact.key,
        path: toRepoDisplayPath(repoRoot, artifact.path),
        exists: fs.existsSync(artifact.path)
    }));
}

function filterNotRequiredCoreMissingArtifacts(
    missingArtifacts: NextStepArtifactState[],
    options: {
        fullSuiteRequired: boolean;
        compileGateRequired: boolean;
        completionGatePassed: boolean;
    }
): NextStepArtifactState[] {
    return missingArtifacts.filter((artifact) => {
        if (!options.fullSuiteRequired && artifact.key === 'full-suite-validation') {
            return false;
        }
        if (!options.compileGateRequired && artifact.key === 'compile-gate') {
            return false;
        }
        if (options.completionGatePassed && artifact.key === 'completion-gate') {
            return false;
        }
        return true;
    });
}

function buildInvalidationImpactSummary(params: {
    status: NextStepStatus;
    nextGate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    review: NextStepReviewSummary;
}): NextStepInvalidationImpactSummary | null {
    if (params.status === 'DONE' || params.status === 'READY' || !params.nextGate) {
        return null;
    }
    const text = `${params.title} ${params.reason}`;
    if (!hasInvalidationSignal(text, params.nextGate)) {
        return null;
    }
    const affectedReviewLanes = getAffectedReviewLanes(text, params.review);
    return {
        stale_artifact_classes: getStaleArtifactClasses(text, params.nextGate),
        affected_review_lanes: affectedReviewLanes,
        minimal_recovery_chain: buildMinimalRecoveryChain(params.nextGate, params.commands, text),
        reuse_candidates: buildReuseCandidates(text, affectedReviewLanes)
    };
}

function hasInvalidationSignal(text: string, nextGate: string): boolean {
    return /\b(?:stale|mismatch|mismatched|does not match|invalidates?|outdated|scope drift|current preflight|latest compile|newer compile|domain-limited remediation|lane-domain current|rebind|review reuse|materialize reuse)\b/iu.test(text)
        || ['classify-change', 'bind-rule-pack-to-preflight'].includes(nextGate);
}

function getStaleArtifactClasses(text: string, nextGate: string): string[] {
    const classes: string[] = [];
    const add = (value: string) => {
        if (!classes.includes(value)) {
            classes.push(value);
        }
    };
    if (/\bpreflight\b|\bscope drift\b|\bchanged fingerprints?\b/iu.test(text) || nextGate === 'classify-change') add('preflight/scope');
    if (/\brule[- ]?pack\b|\bPOST_PREFLIGHT\b/iu.test(text) || nextGate === 'bind-rule-pack-to-preflight') add('rule-pack binding');
    if (/\bcompile\b/iu.test(text) || nextGate === 'compile-gate') add('compile evidence');
    if (/\bfull-suite\b/iu.test(text) || nextGate === 'full-suite-validation') add('full-suite evidence');
    if (/\bscoped diff\b/iu.test(text) || nextGate === 'build-scoped-diff') add('scoped diff metadata');
    if (/\breview[- ]?context\b/iu.test(text) || nextGate === 'build-review-context') add('review context');
    if (/\brouting\b|\bREVIEWER_DELEGATION_ROUTED\b/iu.test(text) || nextGate === 'record-review-routing') add('reviewer routing');
    if (/\blaunch\b|\binvocation\b/iu.test(text) || ['prepare-reviewer-launch', 'complete-reviewer-launch', 'record-review-invocation'].includes(nextGate)) add('reviewer launch/invocation');
    if (/\breceipt\b|\breview artifact\b|\breview output\b|\breviewer_provenance\b/iu.test(text) || nextGate === 'record-review-result') add('review artifact/receipt');
    if (/\brequired-reviews-check\b|\breview gate\b/iu.test(text) || nextGate === 'required-reviews-check') add('review gate evidence');
    return classes.length > 0 ? classes : [nextGate];
}

function getAffectedReviewLanes(text: string, review: NextStepReviewSummary): string[] {
    const lanes = new Set<string>();
    for (const reviewType of REVIEW_PREPARATION_ORDER) {
        const quoted = new RegExp(`['"]${reviewType}['"]`, 'iu');
        const labelled = new RegExp(`\\b${reviewType}\\b(?=\\s+(?:review|lane|context|routing|receipt|PASS|evidence))`, 'iu');
        if (quoted.test(text) || labelled.test(text)) {
            lanes.add(reviewType);
        }
    }
    if (review.next_review_type) {
        lanes.add(review.next_review_type);
    }
    for (const lane of review.blocked_review_lanes) {
        lanes.add(lane.review_type);
        for (const blocker of lane.blocked_by) {
            if (REVIEW_PREPARATION_ORDER.includes(blocker)) {
                lanes.add(blocker);
            }
        }
    }
    return REVIEW_PREPARATION_ORDER.filter((reviewType) => lanes.has(reviewType));
}

function buildMinimalRecoveryChain(nextGate: string, commands: NextStepCommand[], text: string): string[] {
    const chain = [nextGate];
    if (nextGate === 'classify-change') {
        chain.push('rerun navigator for POST_PREFLIGHT, compile, and review refresh decisions');
    } else if (nextGate === 'build-review-context' && /\breview reuse\b|\bmaterialize reuse\b|\brebind\b|\blane-domain current\b/iu.test(text)) {
        chain.push('materialize current-cycle review reuse');
        chain.push('rerun navigator before downstream review/check gates');
    } else if (nextGate.startsWith('record-review') || nextGate.includes('reviewer')) {
        chain.push('record current reviewer evidence');
        chain.push('rerun navigator before review gate');
    } else if (commands.length > 0) {
        chain.push('rerun navigator after the printed command');
    }
    return chain;
}

function buildReuseCandidates(text: string, affectedReviewLanes: string[]): string[] {
    if (/\breuse eligibility validation\b.*\bbefore treating\b|\bbefore treating .*PASS evidence as reusable\b/iu.test(text)) {
        return affectedReviewLanes.length > 0
            ? affectedReviewLanes.map((reviewType) => (
                `${reviewType} (historical PASS evidence exists; authoritative reuse eligibility is pending build-review-context validation)`
            ))
            : ['historical PASS evidence exists; authoritative reuse eligibility is pending build-review-context validation'];
    }
    if (!/\breview reuse\b|\bmaterialize reuse\b|\blane-domain current\b|\bdomain-limited remediation\b|\bexisting .*PASS evidence\b/iu.test(text)) {
        return ['none indicated'];
    }
    if (affectedReviewLanes.length === 0) {
        return ['unchanged upstream PASS evidence, if named by the current gate reason'];
    }
    return affectedReviewLanes.map((reviewType) => `${reviewType} (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)`);
}

export function buildReviewReuseCandidatesForDiagnostics(text: string, affectedReviewLanes: string[]): string[] {
    return buildReuseCandidates(text, affectedReviewLanes);
}

export function buildFocusedRecoveryCoverageContractSha256(options: {
    reviewType: string;
    preflight: Record<string, unknown>;
    repoRoot: string;
}): string {
    return buildAuthoritativeReviewCoverageContract(options).contract.contract_sha256;
}

function getCurrentWorkspaceRefreshChangedFiles(
    repoRoot: string,
    preflight: Record<string, unknown> | null,
    fallbackChangedFiles: string[] | undefined,
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest
): string[] | undefined {
    const detectionSource = String(preflight?.detection_source || '').trim().toLowerCase();
    if (detectionSource !== 'explicit_changed_files') {
        return fallbackChangedFiles;
    }
    const includeUntracked = typeof preflight?.include_untracked === 'boolean'
        ? preflight.include_untracked
        : true;
    const currentSnapshot = readCurrentGitWorkspaceSnapshot(
        repoRoot,
        includeUntracked,
        workspaceSnapshotRequest
    );
    if (!currentSnapshot) {
        return fallbackChangedFiles;
    }
    const snapshotChangedFiles = [...new Set(
        currentSnapshot.changed_files.map((entry: string) => normalizePath(entry)).filter(Boolean)
    )].sort();
    return mergeTaskOwnedMetadataRefreshFiles(snapshotChangedFiles, fallbackChangedFiles);
}

function getPreflightRefreshCommandChangedFiles(params: {
    repoRoot: string;
    taskMode: Record<string, unknown> | null;
    preflight: Record<string, unknown> | null;
    fallbackChangedFiles: string[] | undefined;
    includeFullFailedReviewRemediationScope?: boolean;
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest;
}): string[] | undefined {
    const plannedChangedFiles = filterSourceCheckoutGeneratedRuntimeArtifacts(
        params.repoRoot,
        getTaskModePlannedChangedFiles(params.taskMode)
    );
    if (plannedChangedFiles.length > 0) {
        const taskScopedChangedFiles = params.taskMode?.workflow_config_work === true
            ? filterSourceCheckoutGeneratedRuntimeArtifacts(params.repoRoot, getPreflightRefreshChangedFiles(params.repoRoot, params.taskMode, params.preflight))
            : plannedChangedFiles;
        const currentChangedFiles = filterOptionalSourceCheckoutGeneratedRuntimeArtifacts(params.repoRoot, getCurrentWorkspaceRefreshChangedFiles(
            params.repoRoot,
            params.preflight,
            params.fallbackChangedFiles,
            params.workspaceSnapshotRequest
        ));
        if (!currentChangedFiles) {
            return taskScopedChangedFiles;
        }
        if (params.taskMode?.workflow_config_work === true) {
            return currentChangedFiles.length > 0
                ? [...new Set([...taskScopedChangedFiles, ...currentChangedFiles])].sort()
                : taskScopedChangedFiles;
        }
        const plannedSet = new Set(plannedChangedFiles);
        const dirtyBaselineSet = new Set([
            ...getTaskModeDirtyWorkspaceBaselineChangedFiles(params.repoRoot, params.taskMode),
            ...getPreflightTriggerChangedFiles(params.repoRoot, params.preflight, 'dirty_workspace_baseline_changed_files')
        ]);
        const dirtyBaselineFileHashes = getTaskModeDirtyWorkspaceBaselineFileHashes(params.repoRoot, params.taskMode);
        const unchangedDirtyBaselineSet = new Set(
            [...dirtyBaselineSet].filter((changedFile) => (
                dirtyBaselineFileMatchesCurrent(params.repoRoot, changedFile, dirtyBaselineFileHashes)
            ))
        );
        const currentTaskScopeChangedFiles = currentChangedFiles.filter((changedFile) => (
            plannedSet.has(changedFile)
                || !unchangedDirtyBaselineSet.has(changedFile)
        ));
        const currentChangedSet = new Set(currentChangedFiles);
        const taskScopedRefreshChangedFiles = taskScopedChangedFiles.filter((changedFile) => (
            !dirtyBaselineSet.has(changedFile) || currentChangedSet.has(changedFile)
        ));
        return currentTaskScopeChangedFiles.length > 0
            ? [...new Set([...taskScopedRefreshChangedFiles, ...currentTaskScopeChangedFiles])].sort()
            : taskScopedChangedFiles;
    }
    const explicitAuthorizedFiles = String(params.preflight?.detection_source || '').trim().toLowerCase()
        === 'explicit_changed_files'
        && Array.isArray(params.preflight?.authorized_files)
        ? normalizeWorkspaceRelativePaths(params.repoRoot, params.preflight.authorized_files)
        : [];
    if (explicitAuthorizedFiles.length > 0 && !params.includeFullFailedReviewRemediationScope) {
        const currentChangedFiles = filterOptionalSourceCheckoutGeneratedRuntimeArtifacts(
            params.repoRoot,
            getCurrentWorkspaceRefreshChangedFiles(
                params.repoRoot,
                params.preflight,
                params.fallbackChangedFiles,
                params.workspaceSnapshotRequest
            )
        );
        if (!currentChangedFiles) {
            return explicitAuthorizedFiles;
        }
        const authorizedSet = new Set(explicitAuthorizedFiles);
        const dirtyBaselineSet = new Set([
            ...getTaskModeDirtyWorkspaceBaselineChangedFiles(params.repoRoot, params.taskMode),
            ...getPreflightTriggerChangedFiles(
                params.repoRoot,
                params.preflight,
                'dirty_workspace_baseline_changed_files'
            )
        ]);
        const dirtyBaselineFileHashes = {
            ...getTaskModeDirtyWorkspaceBaselineFileHashes(params.repoRoot, params.taskMode),
            ...getPreflightTriggerFileHashes(
                params.repoRoot,
                params.preflight,
                'dirty_workspace_protected_file_hashes'
            )
        };
        const unchangedDirtyBaselineSet = new Set(
            [...dirtyBaselineSet].filter((changedFile) => (
                dirtyBaselineFileMatchesCurrent(params.repoRoot, changedFile, dirtyBaselineFileHashes)
            ))
        );
        const taskScopedCurrentFiles = currentChangedFiles.filter((changedFile) => (
            authorizedSet.has(changedFile) || !unchangedDirtyBaselineSet.has(changedFile)
        ));
        return taskScopedCurrentFiles.length > 0
            ? taskScopedCurrentFiles
            : explicitAuthorizedFiles;
    }
    const dirtyBaselineCommandFiles = getTaskModeDirtyWorkspaceBaselineCommandChangedFiles(params.repoRoot, params.taskMode);
    if (dirtyBaselineCommandFiles.length > 0) {
        return filterOptionalSourceCheckoutGeneratedRuntimeArtifacts(params.repoRoot, dirtyBaselineCommandFiles);
    }
    return filterOptionalSourceCheckoutGeneratedRuntimeArtifacts(params.repoRoot, getCurrentWorkspaceRefreshChangedFiles(
        params.repoRoot,
        params.preflight,
        params.fallbackChangedFiles,
        params.workspaceSnapshotRequest
    ));
}

function filterOptionalSourceCheckoutGeneratedRuntimeArtifacts(repoRoot: string, changedFiles: string[] | undefined): string[] | undefined {
    return changedFiles ? filterSourceCheckoutGeneratedRuntimeArtifacts(repoRoot, changedFiles) : undefined;
}

function filterSourceCheckoutGeneratedRuntimeArtifacts(repoRoot: string, changedFiles: readonly string[]): string[] {
    const isSourceCheckout = isOrchestratorSourceCheckout(repoRoot);
    return [...new Set(
        changedFiles
            .map((entry) => normalizePath(entry))
            .filter((entry) => entry && !isSourceCheckoutGeneratedRuntimeArtifactPath(entry, isSourceCheckout))
    )].sort();
}

function buildAuthenticatedScopeClassifyChangeCommand(params: {
    repoRoot: string;
    cliPrefix: string;
    taskId: string;
    taskMode: Record<string, unknown> | null;
    taskModePath: string | null;
    preflightCommandPath: string;
    includePlannedScope: boolean;
    changedFiles?: string[];
    taskIntent?: string | null;
    taskQueueEntries: ReadonlyMap<string, TaskQueueEntry>;
}): string {
    const authenticatedTaskIntent = params.taskQueueEntries.get(params.taskId)?.title
        || params.taskIntent;
    const classifyParams = {
        ...params,
        taskIntent: authenticatedTaskIntent
    };
    const splitCheckpointScope = resolveAuthenticatedSplitCheckpointCommandScope(
        params.repoRoot,
        params.taskId,
        params.taskQueueEntries
    );
    const callerChangedFiles = normalizeChangedFileSet(params.changedFiles || []);
    if (
        splitCheckpointScope
        && !splitCheckpointScope.violation
        && splitCheckpointScope.changedFiles.length > 0
        && splitCheckpointScope.detectionSource
    ) {
        if (
            callerChangedFiles.length > 0
            && !sameChangedFileSet(callerChangedFiles, splitCheckpointScope.changedFiles)
        ) {
            return buildClassifyChangeCommand(classifyParams);
        }
        return buildClassifyChangeCommand({
            ...classifyParams,
            includePlannedScope: false,
            changedFiles: splitCheckpointScope.changedFiles,
            detectionSource: splitCheckpointScope.detectionSource
        });
    }
    return buildClassifyChangeCommand(classifyParams);
}

function normalizeChangedFileSet(changedFiles: readonly string[]): string[] {
    return [...new Set(changedFiles.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
}

function sameChangedFileSet(left: readonly string[], right: readonly string[]): boolean {
    const normalizedLeft = normalizeChangedFileSet(left);
    const normalizedRight = normalizeChangedFileSet(right);
    return normalizedLeft.length === normalizedRight.length
        && normalizedLeft.every((entry, index) => entry === normalizedRight[index]);
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

function getPreflightTriggerChangedFiles(
    repoRoot: string,
    preflight: Record<string, unknown> | null,
    fieldName: string
): string[] {
    const triggers = preflight?.triggers;
    if (!triggers || typeof triggers !== 'object' || Array.isArray(triggers)) {
        return [];
    }
    const value = (triggers as Record<string, unknown>)[fieldName];
    return normalizeWorkspaceRelativePaths(repoRoot, value);
}

function getPreflightTriggerFileHashes(
    repoRoot: string,
    preflight: Record<string, unknown> | null,
    fieldName: string
): Record<string, string> {
    const triggers = preflight?.triggers;
    if (!triggers || typeof triggers !== 'object' || Array.isArray(triggers)) {
        return {};
    }
    const value = (triggers as Record<string, unknown>)[fieldName];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    const hashes: Record<string, string> = {};
    for (const [filePath, hash] of Object.entries(value as Record<string, unknown>)) {
        const normalizedPath = normalizeWorkspaceRelativePath(repoRoot, filePath);
        const normalizedHash = String(hash || '').trim().toLowerCase();
        if (normalizedPath && /^[0-9a-f]{64}$/u.test(normalizedHash)) {
            hashes[normalizedPath] = normalizedHash;
        }
    }
    return hashes;
}

function getBuildReviewContextReuseCandidateHint(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): ReviewReuseCandidateHint {
    return state.reusedExistingReview && timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state)
        ? 'current-context-candidate'
        : 'validation-required';
}

function buildSourceRuntimeRemediationResult(params: {
    taskId: string;
    navigatorCommand: string;
    intendedGate: string;
    intendedCommand: string;
    staleness: SourceCheckoutRuntimeStalenessResult;
    missingArtifacts: NextStepArtifactState[];
    presentArtifacts: NextStepArtifactState[];
    fullSuite: NextStepFullSuiteSummary;
    projectMemory?: NextStepProjectMemorySummary | null;
    review: NextStepReviewSummary;
    auditStatus: TaskAuditSummaryResult['status'];
    profile: NextStepProfileSummary | null;
    markdownWorkingPlan?: TaskModeMarkdownWorkingPlanMetadata | null;
}): NextStepResult {
    const violationSummary = params.staleness.violations.length > 0
        ? params.staleness.violations.join('; ')
        : 'source checkout generated runtime may be stale';
    const remediation = params.staleness.remediation
        || `Run "${buildForcedSourceCheckoutRuntimeBuildCommand()}" before continuing gate execution from this source checkout. ` +
            'This disables build-script and publish-runtime reuse so stale generated runtime evidence is refreshed.';
    return buildResult({
        taskId: params.taskId,
        navigatorCommand: params.navigatorCommand,
        status: 'BLOCKED',
        nextGate: 'source-runtime-remediation',
        title: 'Rebuild source-checkout runtime before continuing.',
        reason:
            `Source checkout generated runtime is stale: ${violationSummary}. ` +
            `Remediation blocks intended gate '${params.intendedGate}'. ` +
            'Use the forced rebuild command below so build-script and publish-runtime reuse cannot leave stale runtime evidence in place. ' +
            `After the rebuild, rerun the navigator to continue with '${params.intendedGate}': ${params.intendedCommand}.`,
        commands: [
            buildCommand('Rebuild source-checkout runtime', remediation.replace(/^Run\s+"([^"]+)".*$/u, '$1'))
        ],
        missingArtifacts: params.missingArtifacts,
        presentArtifacts: params.presentArtifacts,
        fullSuite: params.fullSuite,
        projectMemory: params.projectMemory || null,
        review: params.review,
        auditStatus: params.auditStatus,
        profile: params.profile,
        markdownWorkingPlan: params.markdownWorkingPlan || null
    });
}

function buildTaskEntryRulePackCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskMode: Record<string, unknown> | null,
    taskModePath: string | null
): string {
    const effectiveDepth = typeof taskMode?.effective_depth === 'number'
        ? taskMode.effective_depth
        : null;
    const ruleFileNames = selectTaskEntryRulePackFileNames({ effectiveDepth });
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "TASK_ENTRY"',
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        ...ruleFileNames.map((fileName) => (
            `--loaded-rule-file "${buildBundleRelativePath(repoRoot, `live/docs/agent-rules/${fileName}`)}"`
        )),
        '--repo-root "."'
    ].join(' ');
}

function resolveRulePackStage(rulePack: Record<string, unknown> | null): string | null {
    const latestStage = typeof rulePack?.latest_stage === 'string'
        ? rulePack.latest_stage.trim()
        : '';
    if (latestStage) {
        return latestStage;
    }
    return typeof rulePack?.stage === 'string' ? rulePack.stage.trim() || null : null;
}

export function createNextStepDecisionRouteCoordinator(
    binding: AuthenticatedNextStepDecisionBinding
): (
    checkpoint: NextStepDecisionCheckpoint,
    kind: NextStepDecisionKind,
    route: NextStepDecisionRoutePayload | null
) => NextStepDecisionRoutePayload | null {
    const decisionCandidates = new Map<
        NextStepDecisionCheckpoint,
        NextStepDecisionCandidate<NextStepDecisionRoutePayload>
    >();
    let nextDecisionCheckpointIndex = 0;

    return (checkpoint, kind, route) => {
        const expectedCheckpoint = NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE[nextDecisionCheckpointIndex];
        if (checkpoint !== expectedCheckpoint) {
            throw new Error(
                `Next-step decision checkpoint ${checkpoint} was evaluated out of order; expected ${expectedCheckpoint}.`
            );
        }
        decisionCandidates.set(checkpoint, { checkpoint, kind, evaluation: 'evaluated', route });
        nextDecisionCheckpointIndex += 1;
        const decision = selectNextStepDecision(createAuthenticatedNextStepStateProjection({
            binding,
            candidates: NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE.map((candidateCheckpoint) => (
                decisionCandidates.get(candidateCheckpoint) ?? {
                    checkpoint: candidateCheckpoint,
                    kind: 'normal',
                    evaluation: 'pending',
                    route: null
                }
            ))
        }));
        return decision?.route ?? null;
    };
}

export function resolveNextStepGuardDecisionWithWorkflowConfigBoundary<TEvaluation>(options: {
    readEvaluation: () => TEvaluation;
    resolveDecisionRoute: (evaluation: TEvaluation) => NextStepGuardDecision;
    buildWorkflowConfigValidationRoute: (error: unknown) => NextStepDecisionRoutePayload;
}): {
    kind: NextStepDecisionKind;
    route: NextStepDecisionRoutePayload | null;
    warnings: string[];
} {
    let evaluation: TEvaluation;
    try {
        evaluation = options.readEvaluation();
    } catch (error: unknown) {
        return {
            kind: 'normal',
            route: options.buildWorkflowConfigValidationRoute(error),
            warnings: []
        };
    }

    const resolution = options.resolveDecisionRoute(evaluation);
    return {
        kind: 'split',
        route: resolution.route,
        warnings: resolution.warnings
    };
}

function buildPendingNextStepEffectRoute(options: {
    effects: NextStepEffectController;
    repoRoot: string;
    eventsRoot: string;
    reviewsRoot: string;
    taskId: string;
    cliPrefix: string;
}): NextStepDecisionRoutePayload | null {
    const plan = options.effects.pendingPlan();
    if (!plan) {
        return null;
    }
    const summaries = plan.effects.map((effect) => effect.summary);
    const command = [
        `${options.cliPrefix} gate next-step`,
        `--task-id ${quoteCommandValue(options.taskId)}`,
        '--execute-effects',
        `--effect-plan-sha256 ${quoteCommandValue(plan.plan_sha256)}`,
        `--events-root ${quoteCommandValue(toRepoDisplayPath(options.repoRoot, options.eventsRoot))}`,
        `--reviews-root ${quoteCommandValue(toRepoDisplayPath(options.repoRoot, options.reviewsRoot))}`,
        '--repo-root "."'
    ].join(' ');
    return {
        status: 'BLOCKED',
        nextGate: 'next-step-effect',
        title: 'Execute the guarded next-step effect plan.',
        reason:
            'Next-step inspection is side-effect free. The authenticated state requires explicit effect execution before routing can continue. ' +
            `Plan ${plan.plan_sha256} contains ${plan.effects.length} ordered effect(s): ${summaries.join('; ')}.`,
        commands: [buildCommand('Execute next-step effects', command)]
    };
}

export function resolveNextStepDecisionRoute(
    context: NextStepResolutionContext,
    effects: NextStepEffectController = createNextStepEffectPlanner()
): NextStepResult {
    const {
        repoRoot,
        taskId,
        reviewsRoot,
        eventsRoot,
        cliPrefix,
        taskModePath,
        preflightCommandPath,
        readinessArtifacts,
        preflightPath,
        rulePackPath,
        preflight,
        rulePack,
        taskMode,
        preflightSha256,
        taskEventsPath
    } = context;
    const navigatorCommand = buildNavigatorCommand(cliPrefix, taskId);
    const markdownWorkingPlan = readOptionalMarkdownWorkingPlan(repoRoot, taskId);
    const taskEntries = readTaskQueueEntries(repoRoot);
    const taskEntry = taskEntries.get(taskId) || null;
    const taskIdCaseMismatch = taskEntry ? null : resolveTaskQueueCaseMismatch(taskEntries, taskId);
    let taskRequiredReviewDeclarationError: string | null = null;
    if (taskEntry && !preflight) {
        try {
            resolveTaskRequiredReviewDeclaration({
                taskId,
                notes: taskEntry.notes,
                reviewCapabilities: getReviewCapabilities(repoRoot)
            });
        } catch (error: unknown) {
            taskRequiredReviewDeclarationError = error instanceof Error ? error.message : String(error);
        }
    }
    const defaultExecutionProvider = resolveProviderFromEnvironment();
    const profileSummary = buildNextStepProfileSummary(repoRoot, taskEntry, taskMode, preflight);
    const findingPolicyResolution = resolveLockedReviewFindingPolicyFromPreflight(
        preflight || {
            profile_policy_snapshot: isPlainRecord(taskMode?.profile_policy_snapshot)
                ? taskMode.profile_policy_snapshot
                : null
        }
    );
    const findingPolicySummary = {
        review_finding_policy_id: findingPolicyResolution.policy.policy_id,
        review_finding_policy_source: findingPolicyResolution.source,
        review_finding_policy_actions: {
            ...findingPolicyResolution.policy.findings,
            residual_risk: findingPolicyResolution.policy.residual_risk
        }
    };
    const optionalSkillSelectionSummary = buildOptionalSkillSelectionSummary(
        repoRoot,
        cliPrefix,
        taskId,
        preflight,
        taskEntry?.title || null
    );
    let workflowReviewPolicy: ResolvedReviewExecutionPolicyConfig = {
        mode: LEGACY_REVIEW_EXECUTION_POLICY_MODE,
        configured: false
    };
    let workflowConfigRecord: Record<string, unknown> | null = null;
    try {
        workflowConfigRecord = readWorkflowConfigRecordForNextStep(repoRoot);
        workflowReviewPolicy = resolveReviewExecutionPolicyForNextStep(
            workflowConfigRecord
        );
    } catch (error: unknown) {
        const fallbackFullSuiteConfig = loadFullSuiteValidationConfig(repoRoot);
        const coreArtifacts = artifactState(repoRoot, buildNextStepCoreArtifactSpecs(readinessArtifacts));
        return buildResult({
            taskId,
            navigatorCommand,
            status: 'BLOCKED',
            nextGate: 'workflow-config-validation',
            title: 'Validate workflow configuration before continuing.',
            reason: error instanceof Error ? error.message : String(error),
            commands: [
                buildCommand(
                    'Validate workflow config',
                    `${cliPrefix} workflow validate --target-root "."`
                )
            ],
            missingArtifacts: coreArtifacts.missing,
            presentArtifacts: coreArtifacts.present,
            fullSuite: {
                enabled: fallbackFullSuiteConfig.enabled,
                command: fallbackFullSuiteConfig.command,
                placement: fallbackFullSuiteConfig.placement,
                config_path: toRepoDisplayPath(repoRoot, resolveWorkflowConfigPath(repoRoot)),
                config_source: 'effective_workflow_config',
                note: 'Full-suite validation is unavailable until workflow config validation passes.'
            },
            review: {
                required_reviews: [],
                review_execution_policy_mode: LEGACY_REVIEW_EXECUTION_POLICY_MODE,
                review_execution_policy_source: 'workflow_config_fallback',
                ...findingPolicySummary,
                launchable_review_types: [],
                blocked_review_lanes: [],
                failed_review_type: null,
                next_review_type: null,
                blocked_review_dependencies: [],
                ordinary_doc_review_skips: [],
                trust: null,
                trust_note: 'Review trust is unavailable until workflow config validation passes.'
            },
            auditStatus: 'INCOMPLETE',
            profile: profileSummary,
            markdownWorkingPlan,
            optionalSkillSelection: optionalSkillSelectionSummary,
            sourceRuntimeStaleness: detectSourceCheckoutRuntimeStaleness(repoRoot)
        });
    }
    const workspaceSnapshotRequest = createWorkspaceSnapshotRequest(repoRoot);
    const summary = buildTaskAuditSummary({
        taskId,
        repoRoot,
        eventsRoot,
        reviewsRoot,
        taskQueueEntries: taskEntries,
        workspaceSnapshotRequest
    });
    const frozenReviewPolicy = resolveFrozenReviewExecutionPolicyBinding(taskMode);
    const reviewPolicy = resolveReviewPolicy(preflight, workflowReviewPolicy, frozenReviewPolicy);
    const frozenReviewDependencyGraph = frozenReviewPolicy && preflight?.effective_review_snapshot
        ? assertEffectiveReviewSnapshotExecutionPolicyBinding(
            preflight.effective_review_snapshot as EffectiveReviewSnapshot,
            frozenReviewPolicy
        )
        : null;
    const timelineBoundReviewDependencyGraph = resolveTimelineBoundReviewDependencyGraph(
        eventsRoot,
        taskId,
        preflight
    );
    const reviewDependencyGraph = resolveCompiledReviewDependencyGraphFromPreflight(
        preflight,
        reviewPolicy.mode,
        timelineBoundReviewDependencyGraph ?? frozenReviewDependencyGraph,
        !!frozenReviewPolicy && hasCurrentReviewDependencyGraphContract(frozenReviewPolicy)
    );
    const fullSuiteConfig = bindFullSuiteValidationBarrier(
        loadFullSuiteValidationConfig(repoRoot),
        reviewDependencyGraph
    );
    const fullSuiteTimeoutForecast = fullSuiteConfig.enabled
        ? buildFullSuiteTimeoutForecast(repoRoot, fullSuiteConfig)
        : null;
    const fullSuiteTimeoutForecastLine = fullSuiteTimeoutForecast
        ? formatFullSuiteTimeoutForecast(fullSuiteTimeoutForecast)
        : null;
    const fullSuiteNotRequiredForDocsOnly = isFullSuiteNotRequiredForDocsOnlyScope(preflight || {});
    const requiredReviewTypes = getRequiredReviewTypes(summary.required_reviews);
    const fullSuiteNotRequiredForZeroDiffNoReviewableScope = hasZeroDiffNoReviewableScopeSuppression(preflight, requiredReviewTypes);
    const fullSuiteNotRequiredForCurrentScope = fullSuiteNotRequiredForDocsOnly || fullSuiteNotRequiredForZeroDiffNoReviewableScope;
    const semanticCycleResume = readSemanticCycleResumeRoutingState({
        repo_root: repoRoot,
        task_id: taskId,
        manifest_path: readinessArtifacts.paths.semanticCycleRebindPath,
        task_events_path: taskEventsPath,
        preflight_path: preflightPath
    });
    const semanticResumeReusable = semanticCycleResume.status === 'REUSABLE';
    const fullSuiteLifecycleGatePassed = isGatePassed(summary, 'full-suite-validation');
    const fullSuiteGateStatus = getGateStatus(summary, 'full-suite-validation');
    const fullSuiteCurrentArtifactMatchesCycle = fullSuiteArtifactMatchesCurrentCycle(
        readinessArtifacts.fullSuiteValidation,
        taskId,
        preflightPath,
        preflightSha256,
        summary
    );
    const fullSuiteCurrentArtifactMatchesConfig = !fullSuiteConfig.enabled
        || (
            readinessArtifacts.fullSuiteValidation != null
            && readinessArtifacts.fullSuiteValidation.enabled === true
            && String(readinessArtifacts.fullSuiteValidation.command || '').trim() === fullSuiteConfig.command
            && String(readinessArtifacts.fullSuiteValidation.placement || '').trim() === fullSuiteConfig.placement
        );
    const fullSuiteCurrentArtifactMatchesCycleAndConfig = fullSuiteCurrentArtifactMatchesCycle
        && fullSuiteCurrentArtifactMatchesConfig;
    const semanticFullSuiteReusable = isFullSuiteSatisfiedBySemanticCycleResume({
        semanticResumeReusable,
        acceptedFullSuite: semanticCycleResume.accepted_full_suite,
        currentConfigMatches: fullSuiteCurrentArtifactMatchesConfig
    });
    const fullSuiteCurrentGateStatus = semanticFullSuiteReusable
        ? 'PASS'
        : fullSuiteCurrentArtifactMatchesCycleAndConfig
            ? fullSuiteGateStatus
            : null;
    const fullSuiteLifecycleWarningPolicyPresent = hasFullSuiteTimeoutWarningLifecyclePolicy(
        repoRoot,
        taskId,
        readinessArtifacts.fullSuiteValidation
    );
    const fullSuiteWarningOnlyContinuationAccepted = isFullSuiteWarningOnlyContinuationArtifact(
        readinessArtifacts.fullSuiteValidation,
        fullSuiteCurrentArtifactMatchesCycleAndConfig,
        fullSuiteLifecycleGatePassed,
        fullSuiteLifecycleWarningPolicyPresent
    );
    const fullSuiteLifecyclePassArtifactAccepted = isFullSuiteLifecyclePassArtifactAccepted(
        readinessArtifacts.fullSuiteValidation,
        fullSuiteCurrentArtifactMatchesCycleAndConfig,
        fullSuiteLifecycleGatePassed
    );
    const fullSuiteGatePassed = semanticFullSuiteReusable
        ? true
        : fullSuiteNotRequiredForDocsOnly
        ? hasAcceptedDocsOnlyFullSuiteSkipArtifact(
                reviewsRoot,
                taskId,
                fullSuiteConfig.command,
                preflightPath,
                preflightSha256,
                summary
            )
        : fullSuiteNotRequiredForZeroDiffNoReviewableScope
            ? true
            : fullSuiteLifecyclePassArtifactAccepted || fullSuiteWarningOnlyContinuationAccepted;
    const fullSuiteSummary: NextStepFullSuiteSummary = {
        enabled: fullSuiteConfig.enabled,
        command: fullSuiteConfig.command,
        placement: fullSuiteConfig.placement,
        config_path: toRepoDisplayPath(repoRoot, resolveWorkflowConfigPath(repoRoot)),
        config_source: 'effective_workflow_config',
        recommended_timeout_seconds: fullSuiteTimeoutForecast?.recommended_timeout_seconds ?? null,
        timeout_forecast_note: fullSuiteTimeoutForecastLine,
        performance_guidance_note: formatFullSuitePerformanceGuidance(fullSuiteConfig.command),
        note: fullSuiteConfig.enabled && fullSuiteNotRequiredForDocsOnly
            ? 'Full-suite validation is enabled, but this docs-only scope only requires a NOT_REQUIRED artifact.'
            : fullSuiteConfig.enabled && fullSuiteNotRequiredForZeroDiffNoReviewableScope
            ? 'Full-suite validation is enabled, but this BASELINE_ONLY pre-implementation scope has no reviewable diff and requires audited no-op evidence instead.'
            : fullSuiteConfig.enabled
            ? 'Full-suite validation is mandatory because the effective workflow config enables it.'
            : 'Full-suite validation is disabled in the effective workflow config.'
    };
    const projectMemoryEvidence = getProjectMemoryImpactLifecycleEvidence({
        repoRoot,
        taskId,
        preflightPath
    });
    const projectMemorySummary = buildProjectMemoryNextStepSummary(repoRoot, projectMemoryEvidence, {
        taskId,
        preflightPath
    });
    const taskQueueFollowUpFingerprintIndex = buildTaskQueueFollowUpFingerprintIndex(taskEntries, taskId);
    const reviewStates = requiredReviewTypes.map((reviewType) => (
        readReviewArtifactState(
            reviewsRoot,
            taskId,
            reviewType,
            preflightPath,
            preflightSha256,
            preflight,
            repoRoot,
            taskQueueFollowUpFingerprintIndex
        )
    ));
    const fullSuiteTimedOutRetryAvailable = fullSuiteFailedTimeoutRetryAvailable(
        readinessArtifacts.fullSuiteValidation,
        fullSuiteTimeoutForecast
    );
    const currentFailedFullSuiteValidation = fullSuiteGateStatus === 'FAIL'
        && fullSuiteCurrentArtifactMatchesCycleAndConfig;
    const fullSuiteTimeoutPolicy = getFullSuiteTimeoutPolicy(readinessArtifacts.fullSuiteValidation);
    const fullSuiteTimeoutBlockerExhausted = isFullSuiteTimeoutBlockerExhaustedArtifact(
        readinessArtifacts.fullSuiteValidation,
        fullSuiteCurrentArtifactMatchesCycleAndConfig
    );
    const fullSuiteTimeoutRepairTaskProposal = getFullSuiteTimeoutRepairTaskProposal(fullSuiteTimeoutPolicy);
    const fullSuiteTimeoutRepairTaskMaterialized = isFullSuiteTimeoutRepairTaskMaterialized(
        repoRoot,
        reviewsRoot,
        taskEntries,
        fullSuiteTimeoutRepairTaskProposal,
        taskId,
        readinessArtifacts.paths.fullSuiteValidationPath
    );
    const fullSuiteManualRetryEvidence = readFullSuiteManualRetryEvidence({
        repoRoot,
        taskId,
        fullSuiteArtifact: readinessArtifacts.fullSuiteValidation,
        fullSuiteArtifactPath: readinessArtifacts.paths.fullSuiteValidationPath,
        preflightSha256,
        currentFailedFullSuite: currentFailedFullSuiteValidation
    });
    const fullSuiteTargetedDiagnosticEvidence = readFullSuiteTargetedDiagnosticEvidence({
        eventsRoot,
        taskId,
        currentFailedFullSuite: currentFailedFullSuiteValidation
    });
    const currentCompileGateTimestamp = String(
        summary.gates.find((gate: GateOutcome) => gate.gate === 'compile-gate')?.timestamp_utc || ''
    ).trim() || null;
    const interruptedFullSuiteRun = fullSuiteConfig.enabled && !fullSuiteGatePassed && !fullSuiteNotRequiredForCurrentScope
        ? readRecoverableFullSuiteValidationRunMarker(
            repoRoot,
            taskId,
            preflightPath,
            preflightSha256,
            currentCompileGateTimestamp
        )
        : null;
    const unresolvedFullSuiteRunMarkerPath = (() => {
        if (
            !fullSuiteConfig.enabled
            || fullSuiteGatePassed
            || fullSuiteNotRequiredForCurrentScope
            || interruptedFullSuiteRun
        ) {
            return null;
        }
        const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
        return fs.existsSync(markerPath) ? normalizePath(markerPath) : null;
    })();
    const reviewGateAlreadyPassed = isGatePassed(summary, 'required-reviews-check');
    const latestReviewGatePassSequence = reviewGateAlreadyPassed
        ? readLatestTaskEventSequence(eventsRoot, taskId, ['REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE'])
        : null;
    const latestCompilePassSequence = reviewGateAlreadyPassed
        ? readLatestTaskEventSequence(eventsRoot, taskId, ['COMPILE_GATE_PASSED'])
        : null;
    const latestCompletionFailureSequence = reviewGateAlreadyPassed
        ? readLatestTaskEventSequence(eventsRoot, taskId, ['COMPLETION_GATE_FAILED'])
        : null;
    const postReviewGateFreshnessRecoveryActive = Boolean(
        reviewGateAlreadyPassed
        && latestReviewGatePassSequence != null
        && (
            (
                latestCompilePassSequence != null
                && latestCompilePassSequence > latestReviewGatePassSequence
            )
            || (
                latestCompletionFailureSequence != null
                && latestCompletionFailureSequence > latestReviewGatePassSequence
            )
        )
    );
    const postReviewGateFreshnessRecoveryReason = latestCompletionFailureSequence != null
        && latestReviewGatePassSequence != null
        && latestCompletionFailureSequence > latestReviewGatePassSequence
        ? `COMPLETION_GATE_FAILED seq ${latestCompletionFailureSequence} followed review gate pass seq ${latestReviewGatePassSequence}`
        : latestCompilePassSequence != null
            && latestReviewGatePassSequence != null
            && latestCompilePassSequence > latestReviewGatePassSequence
            ? `COMPILE_GATE_PASSED seq ${latestCompilePassSequence} followed review gate pass seq ${latestReviewGatePassSequence}`
            : 'post-review closeout recovery needs current-cycle review binding';
    const reviewGateOverrideSkippedReviewTypes = reviewGateAlreadyPassed
        ? readLatestReviewGateOverrideSkippedReviewTypes(eventsRoot, taskId)
        : new Set<string>();
    const reviewLaunchPlan = applyFullSuiteReadinessToReviewLaunchPlan(
        buildNextStepReviewLaunchPlan({
            requiredReviewTypes,
            policyMode: reviewPolicy.mode,
            dependencyGraph: reviewDependencyGraph,
            requiredReviews: summary.required_reviews,
            reviewStates,
            isSatisfied: (state) => (
                reviewGateOverrideSkippedReviewTypes.has(normalizeReviewTypeValue(state.reviewType) || '')
                || isReviewSatisfiedBySemanticCycleResume({
                    reviewType: state.reviewType,
                    ordinarySatisfied: reviewStateHasSatisfiedEvidence(
                        repoRoot,
                        eventsRoot,
                        taskId,
                        state as ReviewArtifactState
                    ),
                    semanticResumeReusable,
                    acceptedReviewTypes: semanticCycleResume.accepted_review_types
                })
            ),
            isCurrentFailed: (state) => reviewStateHasCurrentRecordedEvidence(repoRoot, eventsRoot, taskId, state as ReviewArtifactState)
        }),
        fullSuiteConfig.enabled,
        fullSuiteConfig.placement,
        fullSuiteNotRequiredForCurrentScope,
        fullSuiteCurrentGateStatus
    );
    const reviewTrust = readReviewTrust(reviewsRoot, taskId, requiredReviewTypes, summary.scope_category);
    const reviewSummary: NextStepReviewSummary = {
        required_reviews: requiredReviewTypes,
        review_execution_policy_mode: reviewPolicy.mode,
        review_execution_policy_source: reviewPolicy.source,
        ...findingPolicySummary,
        launchable_review_types: reviewLaunchPlan.launchable_review_types,
        blocked_review_lanes: toNextStepBlockedReviewLanes(reviewLaunchPlan),
        failed_review_type: reviewLaunchPlan.failed_review_type,
        next_review_type: reviewLaunchPlan.next_review_type,
        blocked_review_dependencies: reviewLaunchPlan.blocked_review_dependencies,
        ordinary_doc_review_skips: getOrdinaryDocReviewSkips(preflight),
        trust: reviewTrust,
        trust_note: reviewTrust?.visible_summary_line || (
            requiredReviewTypes.length > 0
                ? 'Review trust is unavailable until required review receipts exist.'
                : null
        )
    };
    const coreArtifacts = artifactState(
        repoRoot,
        buildNextStepCoreArtifactSpecs(
            readinessArtifacts,
            projectMemoryEvidence.required ? projectMemoryEvidence.artifact_path : null
        )
    );
    const filteredMissingArtifacts = filterNotRequiredCoreMissingArtifacts(coreArtifacts.missing, {
        fullSuiteRequired: fullSuiteConfig.enabled && !fullSuiteNotRequiredForCurrentScope,
        compileGateRequired: summary.gates.some((gate) => gate.gate === 'compile-gate'),
        completionGatePassed: isGatePassed(summary, 'completion-gate')
    });

    const sourceRuntimeStaleness = detectSourceCheckoutRuntimeStaleness(repoRoot);
    const qualityChecklistReadiness = preflight
        ? readQualityChecklistReadiness({
            repoRoot,
            reviewsRoot,
            taskId,
            preflight,
            preflightPath,
            preflightSha256,
            workflowConfig: workflowConfigRecord,
            effects
        })
        : null;
    const resultBase = {
        taskId,
        navigatorCommand,
        missingArtifacts: filteredMissingArtifacts,
        presentArtifacts: coreArtifacts.present,
        fullSuite: fullSuiteSummary,
        projectMemory: projectMemorySummary,
        review: reviewSummary,
        profile: profileSummary,
        markdownWorkingPlan,
        optionalSkillSelection: optionalSkillSelectionSummary,
        taskStartGuidance: buildNextStepTaskStartGuidance({
            optionalSkillSelection: optionalSkillSelectionSummary,
            preflight
        }),
        qualityChecklist: qualityChecklistReadiness
            ? buildNextStepQualityChecklistSummary(qualityChecklistReadiness)
            : null,
        auditStatus: summary.status,
        warnings: [] as string[],
        sourceRuntimeStaleness
    };
    const initialEffectRoute = buildPendingNextStepEffectRoute({
        effects,
        repoRoot,
        eventsRoot,
        reviewsRoot,
        taskId,
        cliPrefix
    });
    if (initialEffectRoute) {
        return buildResult({
            ...resultBase,
            status: initialEffectRoute.status,
            nextGate: initialEffectRoute.nextGate,
            title: initialEffectRoute.title,
            reason: initialEffectRoute.reason,
            commands: initialEffectRoute.commands
        });
    }
    const decisionProjectionBinding = Object.freeze({
        source: 'authenticated-resolution-context' as const,
        taskId,
        taskModePath: toRepoDisplayPath(repoRoot, taskModePath),
        preflightSha256
    });
    const selectProjectedDecisionRoute = createNextStepDecisionRouteCoordinator(decisionProjectionBinding);
    const buildDecisionRouteResult = (
        route: NextStepDecisionRoutePayload,
        overrides: { qualityChecklist?: NextStepQualityChecklistSummary | null } = {}
    ): NextStepResult => buildResult({
        ...resultBase,
        status: route.status,
        nextGate: route.nextGate,
        title: route.title,
        reason: route.reason,
        commands: route.commands,
        missingArtifacts: route.missingArtifacts ?? resultBase.missingArtifacts,
        presentArtifacts: route.presentArtifacts ?? coreArtifacts.present,
        reviewCycleBlock: route.reviewCycleBlock ?? null,
        finalReport: route.finalReport ?? null,
        ...overrides
    });
    const taskMetadataValidationRoute: NextStepDecisionRoutePayload | null = taskRequiredReviewDeclarationError
        ? {
            status: 'BLOCKED',
            nextGate: 'task-metadata-validation',
            title: 'Correct the TASK.md required-review declaration.',
            reason:
                `${taskRequiredReviewDeclarationError} Correct the task notes to the exact form ` +
                '`Required reviews: lane, lane.` and rerun the navigator before classify-change.',
            commands: []
        }
        : null;
    const taskMetadataValidationDecision = selectProjectedDecisionRoute(
        'task-metadata-validation',
        'normal',
        taskMetadataValidationRoute
    );
    if (taskMetadataValidationDecision) {
        return buildDecisionRouteResult(taskMetadataValidationDecision);
    }
    let noPreflightCurrentSnapshot: CurrentGitWorkspaceSnapshot | null | undefined;
    const readNoPreflightCurrentSnapshot = (): CurrentGitWorkspaceSnapshot | null => {
        if (noPreflightCurrentSnapshot === undefined) {
            noPreflightCurrentSnapshot = readCurrentGitWorkspaceSnapshot(
                repoRoot,
                true,
                workspaceSnapshotRequest
            );
        }
        return noPreflightCurrentSnapshot;
    };
    const buildCurrentProtectedScopeTaskModeRestartRoute = (): NextStepDecisionRoutePayload | null => {
        const currentProtectedScope = readCurrentProtectedScopeBeforePreflight(
            repoRoot,
            readNoPreflightCurrentSnapshot(),
            () => readCurrentGitWorkspaceSnapshot(repoRoot, true, workspaceSnapshotRequest),
            taskMode
        );
        const currentProtectedScopeNeedsTaskModeRestart = currentProtectedScope
            && (
                taskMode?.orchestrator_work !== true
                || (currentProtectedScope.workflowConfigFiles.length > 0 && taskMode?.workflow_config_work !== true)
            );
        if (!currentProtectedScope || !currentProtectedScopeNeedsTaskModeRestart) {
            return null;
        }
        const protectedScopeList = currentProtectedScope.protectedFiles.join(', ');
        const missingFlagLabel = currentProtectedScope.workflowConfigFiles.length > 0 && taskMode?.workflow_config_work !== true
            ? '--orchestrator-work --workflow-config-work'
            : '--orchestrator-work';
        if (isGardaSelfGuardDenyAgentEntry(repoRoot)) {
            return {
                status: 'BLOCKED',
                nextGate: 'operator-maintenance',
                title: 'Garda self-guard blocks agent-owned protected control-plane work.',
                reason:
                    `The current workspace already contains protected Garda control-plane files before classify-change: ${protectedScopeList}. ` +
                    formatGardaSelfGuardProtectedControlPlaneGuidance(),
                commands: [
                    buildCommand('Operator policy change', buildGardaSelfGuardPolicyChangeCommand(cliPrefix))
                ]
            };
        }
        if (
            currentProtectedScope.workflowConfigFiles.length > 0
            && !taskMetadataAllowsWorkflowConfigWork(taskEntry)
        ) {
            const taskResetAvailability = resolveTaskResetAvailability(repoRoot);
            return taskResetAvailability.enabled
                ? {
                    status: 'BLOCKED',
                    nextGate: 'task-reset',
                    title: 'Reset stale task mode after an operator workflow-config update.',
                    reason:
                        `The current workspace contains operator-approved workflow-config updates outside this task's ownership: ${protectedScopeList}. ` +
                        'Reset the stale lifecycle evidence for rerun, then rerun next-step to enter task mode against the approved config baseline.',
                    commands: [
                        buildCommand(
                            'Reset task for fresh workflow-config baseline',
                            `${cliPrefix} gate task-reset --task-id "${taskId}" --reopen --confirm --repo-root "."`
                        )
                    ]
                }
                : {
                    status: 'BLOCKED',
                    nextGate: 'operator-maintenance',
                    title: 'Enable audited task reset for workflow-config baseline recovery.',
                    reason:
                        `The current workspace contains operator-approved workflow-config updates outside this task's ownership: ${protectedScopeList}. ` +
                        'Audited task reset must be enabled before the stale task-mode baseline can be replaced.',
                    commands: [
                        buildCommand('Enable task reset', taskResetAvailability.remediationCommand)
                    ]
                };
        }
        return {
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Restart task mode for protected scope before classify.',
            reason:
                `The current workspace already contains protected orchestrator control-plane files before classify-change: ${protectedScopeList}. ` +
                `Task-mode evidence must declare ${missingFlagLabel} before protected scope is classified; fresh operator approval is required.`,
            commands: [
                buildCommand(
                    currentProtectedScope.workflowConfigFiles.length > 0
                        ? 'Restart task mode with workflow-config work'
                        : 'Restart task mode with orchestrator work',
                    buildOrchestratorWorkRestartCommand(
                        repoRoot,
                        cliPrefix,
                        taskId,
                        taskMode,
                        currentProtectedScope.changedFiles,
                        currentProtectedScope.workflowConfigFiles.length > 0
                    )
                )
            ]
        };
    };

    const taskIdCaseMismatchRoute = resolveTaskIdCaseMismatchDecisionRoute({
        requestedTaskId: taskId,
        taskIdCaseMismatch,
        cliPrefix,
        presentArtifacts: coreArtifacts.present
    });
    const taskIdCaseMismatchDecision = selectProjectedDecisionRoute(
        'task-id-casing',
        'normal',
        taskIdCaseMismatchRoute
    );
    if (taskIdCaseMismatchDecision) {
        return buildDecisionRouteResult(taskIdCaseMismatchDecision);
    }

    const fullSuiteRepairChildRoute = (() => {
        const repairChildHandoff = findFullSuiteRepairChildHandoffState(
            repoRoot,
            taskId,
            reviewsRoot,
            eventsRoot,
            taskEntries
        );
        if (!repairChildHandoff) {
            return null;
        }
        const repairEvidence = repairChildHandoff.decomposition.ready
            ? readFullSuiteRepairTaskMaterializationEvidence({
                repoRoot,
                reviewsRoot,
                taskId: repairChildHandoff.parent_task_id,
                fullSuiteArtifactPath: repairChildHandoff.full_suite_artifact_path,
                childTaskId: taskId,
                childTaskIds: repairChildHandoff.decomposition.child_task_ids
            })
            : null;
        if (!repairChildHandoff.decomposition.ready || !repairEvidence?.materialized) {
            const reason = !repairChildHandoff.decomposition.ready
                ? repairChildHandoff.decomposition.violations.join(' ')
                : repairEvidence?.reason || 'full-suite repair materialization evidence is missing';
            return {
                status: 'BLOCKED',
                nextGate: 'full-suite-repair-child-handoff',
                title: 'Complete the multi-child full-suite repair handoff before executing this child.',
                reason:
                    `Repair child ${taskId} is linked from parent ${repairChildHandoff.parent_task_id}, but its authenticated ` +
                    `two-or-more-child decomposition handoff is not current. ${reason} ` +
                    'Do not enter task mode, classify, compile, review, or complete the repair child until the parent materializes the validated handoff.',
                commands: [
                    buildCommand(
                        'Continue repair parent handoff',
                        `${cliPrefix} next-step "${repairChildHandoff.parent_task_id}" --repo-root "."`
                    )
                ]
            } satisfies NextStepDecisionRoutePayload;
        }
        if (!repairEvidence.scoped_handoff || !repairEvidence.child_scopes) {
            return {
                status: 'BLOCKED',
                nextGate: 'full-suite-repair-child-scope',
                title: 'Migrate the repair handoff to immutable child scopes before executing this child.',
                reason:
                    `Repair child ${taskId} is linked from parent ${repairChildHandoff.parent_task_id}, but the `
                    + 'materialized handoff predates scoped child isolation. Restore or migrate the suspended parent WIP; '
                    + 'do not rematerialize over a legacy suspended capture.',
                commands: [
                    buildCommand(
                        'Continue repair parent recovery',
                        `${cliPrefix} next-step "${repairChildHandoff.parent_task_id}" --repo-root "."`
                    )
                ]
            } satisfies NextStepDecisionRoutePayload;
        }
        if (!sameRepairChildScopes(
            repairEvidence.child_scopes,
            repairChildHandoff.decomposition.child_scopes
        )) {
            return {
                status: 'BLOCKED',
                nextGate: 'full-suite-repair-child-scope',
                title: 'Restore the immutable child scope declarations used by the materialized handoff.',
                reason:
                    `Repair child ${taskId} scope declarations changed after parent `
                    + `${repairChildHandoff.parent_task_id} suspended WIP. The materialized scope binding is immutable.`,
                commands: []
            } satisfies NextStepDecisionRoutePayload;
        }
        const repairScopeViolations = validateRepairChildChangedFiles(
            repairEvidence.child_scopes,
            taskId,
            getPreflightChangedFilesForReviewRemediation(preflight)
        );
        if (repairScopeViolations.length > 0) {
            return {
                status: 'BLOCKED',
                nextGate: 'full-suite-repair-child-scope',
                title: 'Return the repair child to its immutable isolated file scope.',
                reason:
                    `${repairScopeViolations.join(' ')} The suspended parent WIP remains isolated and must not be `
                    + 'absorbed into this repair child.',
                commands: []
            } satisfies NextStepDecisionRoutePayload;
        }
        return null;
    })();
    const fullSuiteRepairChildDecision = selectProjectedDecisionRoute(
        'full-suite-repair-child',
        'normal',
        fullSuiteRepairChildRoute
    );
    if (fullSuiteRepairChildDecision) {
        return buildDecisionRouteResult(fullSuiteRepairChildDecision);
    }

    let splitRequiredReviewCycleContinuationAssessment:
        ReturnType<typeof assessReviewCycleContinuationEvidence> | null = null;
    if (isTaskQueueSplitRequiredStatus(taskEntry?.status || null)) {
        const splitRequiredLatch = readSplitRequiredLatchEvidence({
            reviewsRoot,
            eventsRoot,
            taskId
        });
        if (splitRequiredLatch.valid && splitRequiredLatch.guard_kind === 'review_cycle') {
            try {
                const reviewCycleGuardResult = readReviewCycleGuardEvaluation(repoRoot, eventsRoot, taskId);
                const pendingRequiredReviewTypes = requiredReviewTypes.filter((reviewType) => {
                    const state = reviewStates.find((candidate) => candidate.reviewType === reviewType);
                    return !state || !reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, state);
                });
                splitRequiredReviewCycleContinuationAssessment = assessReviewCycleContinuationEvidence({
                    repoRoot,
                    reviewsRoot,
                    eventsRoot,
                    taskId,
                    evaluation: reviewCycleGuardResult.evaluation,
                    reviewPhase: {
                        required_review_types: requiredReviewTypes,
                        pending_required_review_types: pendingRequiredReviewTypes
                    }
                });
            } catch {
                splitRequiredReviewCycleContinuationAssessment = null;
            }
        }
    }

    const currentNoOpEvidence = preflight && preflightRequiresAuditedNoOp(preflight)
        ? getNoOpEvidence(repoRoot, taskId, '', preflightCommandPath)
        : null;
    const currentNoOpEventSha256 = currentNoOpEvidence?.evidence_status === 'PASS'
        ? getCurrentNoOpEventSha256(repoRoot, taskId, currentNoOpEvidence, eventsRoot)
        : null;
    const allowAuditedNoOpRecovery = !!currentNoOpEventSha256
        && hasPassedCompletionBeforeNoOpEvent(eventsRoot, taskId, currentNoOpEventSha256);
    const taskQueueTerminalRoute = resolveTaskQueueTerminalDecisionRoute({
        repoRoot,
        reviewsRoot,
        eventsRoot,
        taskId,
        cliPrefix,
        taskEntries,
        taskEntry,
        completionGatePassed: isGatePassed(summary, 'completion-gate'),
        latestCompletionCurrent: isLatestCompletionCurrent(eventsRoot, taskId),
        allowAuditedNoOpRecovery,
        finalReportContractReady: summary.final_report_contract.status === 'READY',
        finalReportContractBlocker: summary.final_report_contract.blocker || null,
        summaryBlockers: summary.blockers.map((blocker) => `${blocker.gate}: ${blocker.reason}`),
        filteredMissingArtifacts,
        corePresentArtifacts: coreArtifacts.present,
        fullSuiteArtifactPath: readinessArtifacts.paths.fullSuiteValidationPath,
        reviewCycleContinuationAssessment: splitRequiredReviewCycleContinuationAssessment,
        effects
    });
    const taskQueueTerminalEffectRoute = buildPendingNextStepEffectRoute({
        effects,
        repoRoot,
        eventsRoot,
        reviewsRoot,
        taskId,
        cliPrefix
    });
    const taskQueueTerminalDecision = selectProjectedDecisionRoute(
        'task-queue-terminal',
        isTaskQueueSplitRequiredStatus(taskEntry?.status || null) ? 'split' : 'normal',
        taskQueueTerminalEffectRoute ?? taskQueueTerminalRoute
    );
    if (taskQueueTerminalDecision) {
        return buildDecisionRouteResult(taskQueueTerminalDecision);
    }

    let completedCloseoutDecisionRoute: NextStepDecisionRoutePayload | null = null;
    if (currentNoOpEvidence?.evidence_status === 'PASS') {
        if (!currentNoOpEventSha256) {
            completedCloseoutDecisionRoute = {
                status: 'BLOCKED',
                nextGate: 'record-no-op',
                title: 'Record current audited no-op event.',
                reason: 'The no-op artifact has no current integrity-bound NO_OP_RECORDED event. Record it again, then rerun the downstream gates through next-step.',
                commands: [buildCommand(
                    'Record current audited no-op event',
                    `${cliPrefix} gate record-no-op --task-id "${taskId}" --classification "AUDIT_ONLY" --reason "<operator-approved no-op rationale>" --preflight-path "${preflightCommandPath}" --repo-root "."`
                )]
            };
        }
    }

    if (!completedCloseoutDecisionRoute
        && isGatePassed(summary, 'completion-gate')
        && isLatestCompletionCurrent(eventsRoot, taskId)) {
        const hasFinalCloseoutArtifact = fs.existsSync(readinessArtifacts.paths.finalCloseoutJsonPath)
            || fs.existsSync(readinessArtifacts.paths.finalCloseoutMarkdownPath);
        const postDoneDrift = hasFinalCloseoutArtifact
            ? readPostDoneWorkspaceDriftDecision(
                repoRoot,
                preflight,
                readinessArtifacts.paths.docImpactPath,
                readinessArtifacts.paths.finalCloseoutJsonPath,
                workspaceSnapshotRequest
            )
            : { blocked: false, reason: 'No materialized final closeout artifact exists yet.' };
        const finalReport = readReadyFinalReportSummary(repoRoot, reviewsRoot, taskId, summary, eventsRoot);
        completedCloseoutDecisionRoute = resolveCompletedCloseoutDecisionRoute({
            completionGatePassed: true,
            latestCompletionCurrent: true,
            postDoneDriftBlocked: postDoneDrift.blocked,
            postDoneDriftReason: postDoneDrift.reason,
            finalReportContractReady: summary.final_report_contract.status === 'READY',
            finalReportContractBlocker: summary.final_report_contract.blocker || '',
            finalReport,
            taskAuditCommand: `${cliPrefix} gate task-audit-summary --task-id "${taskId}" --repo-root "."`,
            missingArtifacts: buildFinalCloseoutMissingArtifacts(repoRoot, reviewsRoot, taskId, {
                finalCloseoutJsonPath: readinessArtifacts.paths.finalCloseoutJsonPath,
                finalCloseoutMarkdownPath: readinessArtifacts.paths.finalCloseoutMarkdownPath
            })
        });
    }
    const completedCloseoutDecision = selectProjectedDecisionRoute(
        'completed-closeout',
        completedCloseoutDecisionRoute?.nextGate === 'record-no-op' ? 'audited-no-op' : 'normal',
        completedCloseoutDecisionRoute
    );
    if (completedCloseoutDecision) {
        return buildDecisionRouteResult(completedCloseoutDecision);
    }

    const docImpactPath = readinessArtifacts.paths.docImpactPath;
    const closeoutTimelineSnapshot = readNextStepCloseoutTimelineSnapshot(eventsRoot, taskId);
    const preflightWorkspaceReadiness = preflight
        ? readPreflightWorkspaceReadiness(repoRoot, preflight, {
            failedReviewType: null,
            failedReviewVerdict: null,
            docImpactPath,
            plannedChangedFiles: getTaskModePlannedChangedFiles(taskMode),
            dirtyWorkspaceBaselineChangedFiles: getTaskModeDirtyWorkspaceBaselineChangedFiles(repoRoot, taskMode),
            dirtyWorkspaceBaselineFileHashes: getTaskModeDirtyWorkspaceBaselineFileHashes(repoRoot, taskMode),
            workspaceSnapshotRequest
        })
        : { ready: false, reason: 'No current preflight exists.' };
    const strictPreGuardWorkspaceReadiness = preflight
        ? readPreflightWorkspaceReadiness(repoRoot, preflight, {
            failedReviewType: null,
            failedReviewVerdict: null,
            docImpactPath,
            plannedChangedFiles: getTaskModePlannedChangedFiles(taskMode),
            dirtyWorkspaceBaselineChangedFiles: getTaskModeDirtyWorkspaceBaselineChangedFiles(repoRoot, taskMode),
            dirtyWorkspaceBaselineFileHashes: getTaskModeDirtyWorkspaceBaselineFileHashes(repoRoot, taskMode),
            workspaceSnapshotRequest,
            allowDocsOnlyDelta: false
        })
        : { ready: false, reason: 'No current preflight exists.' };
    const staleCompletionFailureDocCloseoutAllowance =
        buildStaleCompletionFailureDocCloseoutAllowance(
            repoRoot,
            eventsRoot,
            taskId,
            preflightPath,
            preflightSha256,
            preflightWorkspaceReadiness,
            docImpactPath,
            closeoutTimelineSnapshot
        );
    const preflightCycleReadiness = readPreflightCycleReadiness(
        eventsRoot,
        taskId,
        {
            ...staleCompletionFailureDocCloseoutAllowance,
            timelineSnapshot: closeoutTimelineSnapshot
        }
    );
    const failedReviewStateFromLaunchPlan = reviewLaunchPlan.next_review_type
        ? reviewStates.find((candidate) => (
            candidate.reviewType === reviewLaunchPlan.next_review_type && candidate.failed
        ))
        : undefined;
    const failedCurrentReviewStateForPreflight = failedReviewStateFromLaunchPlan
        ?? resolveAuthenticatedFixNowRemediationState(reviewStates, reviewLaunchPlan.next_review_type)
        ?? undefined;
    const effectivePreflightWorkspaceReadiness = preflight && failedCurrentReviewStateForPreflight
        ? readPreflightWorkspaceReadiness(repoRoot, preflight, {
            failedReviewType: failedCurrentReviewStateForPreflight?.reviewType || null,
            failedReviewVerdict: failedCurrentReviewStateForPreflight?.verdictToken || failedCurrentReviewStateForPreflight?.failToken || null,
            docImpactPath,
            plannedChangedFiles: getTaskModePlannedChangedFiles(taskMode),
            dirtyWorkspaceBaselineChangedFiles: getTaskModeDirtyWorkspaceBaselineChangedFiles(repoRoot, taskMode),
            dirtyWorkspaceBaselineFileHashes: getTaskModeDirtyWorkspaceBaselineFileHashes(repoRoot, taskMode),
            workspaceSnapshotRequest
        })
        : preflightWorkspaceReadiness;
    const effectiveStrictPreGuardWorkspaceReadiness = preflight && failedCurrentReviewStateForPreflight
        ? readPreflightWorkspaceReadiness(repoRoot, preflight, {
            failedReviewType: failedCurrentReviewStateForPreflight?.reviewType || null,
            failedReviewVerdict: failedCurrentReviewStateForPreflight?.verdictToken || failedCurrentReviewStateForPreflight?.failToken || null,
            docImpactPath,
            plannedChangedFiles: getTaskModePlannedChangedFiles(taskMode),
            dirtyWorkspaceBaselineChangedFiles: getTaskModeDirtyWorkspaceBaselineChangedFiles(repoRoot, taskMode),
            dirtyWorkspaceBaselineFileHashes: getTaskModeDirtyWorkspaceBaselineFileHashes(repoRoot, taskMode),
            workspaceSnapshotRequest,
            allowDocsOnlyDelta: false
        })
        : strictPreGuardWorkspaceReadiness;

    const startupCycleReadiness = readStartupCycleReadiness(repoRoot, eventsRoot, taskId, taskModePath, {
        enforceLateRulePackAfterReviewPhase:
            !preflight || !preflightCycleReadiness.ready || !effectivePreflightWorkspaceReadiness.ready
    });
    const startupRoute = resolveStartupDecisionRoute({
        enterTaskModePassed: isGatePassed(summary, 'enter-task-mode'),
        unapprovedActiveTaskOwners: findUnapprovedActiveImplementationOwners(repoRoot, taskId, taskEntries),
        protectedManifestRecovery: readTaskModeProtectedManifestRecoveryRoute(repoRoot, eventsRoot, taskId, cliPrefix),
        defaultExecutionProvider,
        enterTaskModeCommand: buildEnterTaskModeCommand(repoRoot, cliPrefix, taskId, taskEntry, defaultExecutionProvider, taskMode),
        startupCycleReadiness,
        loadRulePackPassed: isGatePassed(summary, 'load-rule-pack'),
        rulePackStage: resolveRulePackStage(rulePack),
        preflightExists: Boolean(preflight),
        taskEntryRulePackCommand: buildTaskEntryRulePackCommand(repoRoot, cliPrefix, taskId, taskMode, taskModePath),
        handshakeDiagnosticsPassed: isGatePassed(summary, 'handshake-diagnostics'),
        handshakeDiagnosticsCommand: `${cliPrefix} gate handshake-diagnostics --task-id "${taskId}" --repo-root "."`,
        shellSmokePreflightPassed: isGatePassed(summary, 'shell-smoke-preflight'),
        shellSmokePreflightCommand: `${cliPrefix} gate shell-smoke-preflight --task-id "${taskId}" --repo-root "."`
    });
    const startupDecision = selectProjectedDecisionRoute('startup', 'normal', startupRoute);
    if (startupDecision) {
        return buildDecisionRouteResult(startupDecision);
    }

    const strictDecompositionRequirement = buildStrictDecompositionDecisionRequirement({
        taskId,
        taskEntry,
        taskMode,
        preflight,
        profileSummary,
        requiredReviewTypes
    });
    const buildStrictDecompositionContinuationBlock = (): NextStepDecisionRoutePayload | null => {
        const strictRoute = resolveStrictDecompositionContinuationRoute({
            repoRoot,
            eventsRoot,
            taskEntries,
            taskId,
            cliPrefix,
            requirement: strictDecompositionRequirement,
            requiredReviewTypes,
            baseMissingArtifacts: resultBase.missingArtifacts,
            basePresentArtifacts: coreArtifacts.present,
            effects
        });
        const strictDecompositionEffectRoute = buildPendingNextStepEffectRoute({
            effects,
            repoRoot,
            eventsRoot,
            reviewsRoot,
            taskId,
            cliPrefix
        });
        if (strictDecompositionEffectRoute) {
            return strictDecompositionEffectRoute;
        }
        if (!strictRoute) {
            return null;
        }
        return {
            status: strictRoute.status,
            nextGate: strictRoute.nextGate,
            title: strictRoute.title,
            reason: strictRoute.reason,
            commands: strictRoute.commands,
            missingArtifacts: strictRoute.missingArtifacts ?? resultBase.missingArtifacts,
            presentArtifacts: strictRoute.presentArtifacts ?? coreArtifacts.present,
            finalReport: strictRoute.finalReport
        };
    };

    const classifyDecisionRoute = resolveClassifyDecisionRoute({
        preflightExists: Boolean(preflight),
        classifyChangePassed: isGatePassed(summary, 'classify-change'),
        readFailedGateRecovery: () => readFailedGateRecovery(
            repoRoot,
            eventsRoot,
            taskId,
            cliPrefix,
            taskMode,
            taskModePath,
            preflightCommandPath,
            taskEntry
        ),
        resolveStrictDecompositionRoute: buildStrictDecompositionContinuationBlock,
        resolveProtectedScopeRoute: buildCurrentProtectedScopeTaskModeRestartRoute,
        buildClassifyCommand: () => {
            const filteredNoPreflightChangedFiles = getFilteredNoPreflightClassifyChangedFiles(
                repoRoot,
                taskMode,
                readNoPreflightCurrentSnapshot()
            );
            return buildAuthenticatedScopeClassifyChangeCommand({
                repoRoot,
                cliPrefix,
                taskId,
                taskMode,
                taskModePath,
                preflightCommandPath,
                includePlannedScope: !filteredNoPreflightChangedFiles,
                changedFiles: filteredNoPreflightChangedFiles,
                taskQueueEntries: taskEntries
            });
        }
    });
    const classifyDecision = selectProjectedDecisionRoute('classify', 'normal', classifyDecisionRoute);
    if (classifyDecision) {
        return buildDecisionRouteResult(classifyDecision);
    }

    const optionalSkillRefreshCommand = buildAuthenticatedScopeClassifyChangeCommand({
        repoRoot,
        cliPrefix,
        taskId,
        taskMode,
        taskModePath,
        preflightCommandPath,
        includePlannedScope: false,
        taskIntent: taskEntry?.title || null,
        taskQueueEntries: taskEntries,
        changedFiles: getPreflightRefreshCommandChangedFiles({
            repoRoot,
            taskMode,
            preflight,
            fallbackChangedFiles: getPreflightRefreshChangedFiles(repoRoot, taskMode, preflight),
            workspaceSnapshotRequest
        })
    });
    const mandatoryOptionalSkillRemediation = getMandatoryOptionalSkillRemediationCommand(
        optionalSkillSelectionSummary,
        cliPrefix,
        taskEntry?.title || taskId,
        {
            repoRoot,
            reclassifyCommand: optionalSkillRefreshCommand
        }
    );
    const optionalSkillSelectionDecisionRoute = resolveOptionalSkillSelectionDecisionRoute({
        optionalSkillSelection: optionalSkillSelectionSummary,
        mandatoryRemediation: mandatoryOptionalSkillRemediation,
        mandatoryPolicyMode: isMandatoryOptionalSkillSelectionPolicyMode(optionalSkillSelectionSummary?.policy_mode),
        refreshCommand: optionalSkillRefreshCommand,
        timelineIntegrityCommand:
            `${cliPrefix} gate task-events-summary --task-id ${quoteCommandValue(taskId)} --as-json --repo-root "."`
    });
    const optionalSkillSelectionDecision = selectProjectedDecisionRoute(
        'optional-skill-selection',
        'normal',
        optionalSkillSelectionDecisionRoute
    );
    if (optionalSkillSelectionDecision) {
        return buildDecisionRouteResult(optionalSkillSelectionDecision);
    }

    const coherentCycleReadiness = readCoherentCycleReadiness(
        repoRoot,
        eventsRoot,
        reviewsRoot,
        taskId,
        preflightPath,
        taskModePath,
        taskEntry?.title || getStringField(taskMode, 'task_summary', taskId)
    );
    const postPreflightRulePackReadiness = readPostPreflightRulePackReadiness(
        repoRoot,
        taskId,
        preflightPath,
        rulePackPath,
        taskModePath
    );
    const failedReviewRemediationExpandedNonTestFiles = failedCurrentReviewStateForPreflight
        ? getExpandedNonTestReviewRemediationFiles({
            repoRoot,
            taskId,
            preflight,
            currentChangedFiles: (reviewGateAlreadyPassed
                ? effectivePreflightWorkspaceReadiness.currentChangedFiles
                : effectiveStrictPreGuardWorkspaceReadiness.currentChangedFiles),
            taskMode
        })
        : [];
    const failedReviewIgnoredRemediationChangedFiles = failedCurrentReviewStateForPreflight
        ? resolveIgnoredRemediationCommandChangedFiles({
            repoRoot,
            taskId,
            reviewArtifactPaths: [failedCurrentReviewStateForPreflight.artifactPath],
            taskMode
        })
        : [];
    const pendingOptionalSkillActivation = getPendingOptionalSkillActivationCommand(optionalSkillSelectionSummary);
    const currentProtectedScopeRoute = buildCurrentProtectedScopeTaskModeRestartRoute();
    const currentProtectedScopeDecision = selectProjectedDecisionRoute(
        'protected-scope',
        'normal',
        currentProtectedScopeRoute
    );
    if (currentProtectedScopeDecision) {
        return buildDecisionRouteResult(currentProtectedScopeDecision);
    }

    const preGuardWorkspaceReadiness = reviewGateAlreadyPassed
        ? effectivePreflightWorkspaceReadiness
        : effectiveStrictPreGuardWorkspaceReadiness;
    const postReviewSourceMutationGuard = evaluatePostReviewSourceMutationGuard({
        repoRoot,
        preflight,
        workspaceReadiness: preGuardWorkspaceReadiness,
        reviewStates,
        authorizedImplementationTransition: Boolean(
            failedCurrentReviewStateForPreflight
            && hasAuthenticatedFixNowDisposition(failedCurrentReviewStateForPreflight)
        )
    });

    const preGuardRoute = resolvePreGuardDecisionRoute({
        preflightCycleReadiness,
        preflightCycleRefreshCommand: buildAuthenticatedScopeClassifyChangeCommand({
            repoRoot,
            cliPrefix,
            taskId,
            taskMode,
            taskModePath,
            preflightCommandPath,
            includePlannedScope: false,
            taskQueueEntries: taskEntries,
            changedFiles: getPreflightRefreshCommandChangedFiles({
                repoRoot,
                taskMode,
                preflight,
                fallbackChangedFiles: getPreflightRefreshChangedFiles(repoRoot, taskMode, preflight),
                workspaceSnapshotRequest
            })
        }),
        protectedControlPlane: {
            touched: preflightTouchesProtectedControlPlane(preflight),
            taskModeHasOrchestratorWork: Boolean(taskMode?.orchestrator_work),
            selfGuardDeny: isGardaSelfGuardDenyAgentEntry(repoRoot),
            selfGuardGuidance: formatGardaSelfGuardProtectedControlPlaneGuidance(),
            selfGuardPolicyChangeCommand: buildGardaSelfGuardPolicyChangeCommand(cliPrefix),
            orchestratorWorkRestartCommand: buildOrchestratorWorkRestartCommand(repoRoot, cliPrefix, taskId, taskMode)
        },
        postReviewSourceMutationGuard,
        workspaceReadiness: preGuardWorkspaceReadiness,
        workspaceRefreshCommand: buildAuthenticatedScopeClassifyChangeCommand({
            repoRoot,
            cliPrefix,
            taskId,
            taskMode,
            taskModePath,
            preflightCommandPath,
            includePlannedScope: false,
            taskQueueEntries: taskEntries,
            changedFiles: getPreflightRefreshCommandChangedFiles({
                repoRoot,
                preflight,
                taskMode,
                includeFullFailedReviewRemediationScope: Boolean(failedCurrentReviewStateForPreflight),
                workspaceSnapshotRequest,
                fallbackChangedFiles: (reviewGateAlreadyPassed
                    ? effectivePreflightWorkspaceReadiness.currentChangedFiles
                    : effectiveStrictPreGuardWorkspaceReadiness.currentChangedFiles)
                    ?? getPreflightRefreshChangedFiles(repoRoot, taskMode, preflight)
            })
        }),
        failedReviewRemediation: failedCurrentReviewStateForPreflight && isTaskQueueActiveStatus(taskEntry?.status ?? null)
            ? {
                reviewType: failedCurrentReviewStateForPreflight.reviewType,
                verdictToken:
                    failedCurrentReviewStateForPreflight.verdictToken
                    || failedCurrentReviewStateForPreflight.failToken
                    || 'FAILED',
                expandedNonTestFiles: failedReviewRemediationExpandedNonTestFiles,
                closedCycleRestart: reviewGateAlreadyPassed
                    ? {
                        boundary: 'REVIEW_GATE_PASSED',
                        command: buildCoherentCycleRestartCommand(
                            repoRoot,
                            taskId,
                            preflightCommandPath,
                            taskModePath,
                            null,
                            null,
                            {
                                requiresOperatorConfirmation: Boolean(
                                    taskMode?.orchestrator_work === true
                                    || taskMode?.workflow_config_work === true
                                ),
                                taskIntent: taskEntry?.title || getStringField(taskMode, 'task_summary', taskId)
                            }
                        )
                    }
                    : null,
                restartReviewCycleCommand: buildRestartReviewCycleCommand(
                    repoRoot,
                    cliPrefix,
                    taskId,
                    taskEntry?.title || getStringField(taskMode, 'task_summary', taskId),
                    preflightCommandPath,
                    taskModePath,
                    failedReviewIgnoredRemediationChangedFiles,
                    {
                        reviewType: failedCurrentReviewStateForPreflight.reviewType
                    }
                )
            }
            : null,
        coherentCycleReadiness,
        navigatorCommand,
        postPreflightRulePack: {
            stage: resolveRulePackStage(rulePack),
            ready: postPreflightRulePackReadiness.ready,
            reason: postPreflightRulePackReadiness.reason,
            canBind: postPreflightRulePackReadiness.rebind?.can_bind === true,
            rebindReason: postPreflightRulePackReadiness.rebind?.reason,
            loadCommand: buildPostPreflightRulePackCommandForFiles(
                repoRoot,
                cliPrefix,
                taskId,
                getPostPreflightRuleFileNames(preflight, taskMode),
                taskModePath
            ),
            bindCommand: buildPostPreflightRulePackBindCommand(
                repoRoot,
                cliPrefix,
                taskId,
                taskModePath
            )
        },
        optionalSkillActivation: pendingOptionalSkillActivation
    });
    const preGuardDecision = selectProjectedDecisionRoute('pre-guard', 'normal', preGuardRoute);
    if (preGuardDecision) {
        const qualityChecklist = preGuardDecision.nextGate === 'classify-change' && qualityChecklistReadiness
            ? buildNextStepQualityChecklistSummary(
                markQualityChecklistReadinessStaleForWorkspace(qualityChecklistReadiness, preGuardDecision.reason)
            )
            : resultBase.qualityChecklist;
        return buildDecisionRouteResult(preGuardDecision, { qualityChecklist });
    }

    const scopeBudgetGuardResolution = resolveNextStepGuardDecisionWithWorkflowConfigBoundary({
        readEvaluation: () => readScopeBudgetGuardEvaluation(
            repoRoot,
            preflight,
            profileSummary,
            requiredReviewTypes
        ),
        resolveDecisionRoute: (evaluation) => resolveScopeBudgetGuardDecisionRoute({
            evaluation,
            guardReason: evaluation?.should_block
                ? sanitizeScopeBudgetGuardSummary(evaluation)
                : null,
            materializeLatch: () => {
                const guardDetails = {
                    action: evaluation!.action,
                    profile_name: evaluation!.profile_name,
                    violations: evaluation!.violations.map((violation) => ({
                        metric: violation.metric,
                        actual: violation.actual,
                        limit: violation.limit,
                        warning_limit: violation.warning_limit,
                        blocking_limit: violation.blocking_limit,
                        severity: violation.severity
                    }))
                };
                return effects.run({
                    kind: 'materialize-scope-budget-split-latch',
                    summary: `Materialize the scope-budget split latch for ${taskId}`,
                    input: {
                        task_id: taskId,
                        preflight_sha256: preflightSha256,
                        guard_details: guardDetails
                    },
                    preview: () => ({
                        artifact_path: path.join(reviewsRoot, `${taskId}-split-required.json`),
                        artifact_sha256: '<planned>',
                        status_sync: { outcome: 'updated', error_message: null },
                        status_event_recorded: true,
                        latch_event_recorded: true,
                        wip_capture: null
                    } as ReturnType<typeof materializeSplitRequiredLatch>),
                    execute: () => materializeSplitRequiredLatch({
                        repoRoot,
                        eventsRoot,
                        reviewsRoot,
                        taskId,
                        guardKind: 'scope_budget',
                        guardReason: sanitizeScopeBudgetGuardSummary(evaluation!),
                        rawGuardSummary: evaluation!.summary_line,
                        preflightPath,
                        guardDetails
                    })
                });
            },
            formatArtifactPath: (artifactPath) => toRepoDisplayPath(repoRoot, artifactPath),
            presentArtifacts: coreArtifacts.present
        }),
        buildWorkflowConfigValidationRoute: (error) => ({
            status: 'BLOCKED',
            nextGate: 'workflow-config-validation',
            title: 'Validate workflow configuration before continuing.',
            reason: error instanceof Error ? error.message : String(error),
            commands: [
                buildCommand(
                    'Validate workflow config',
                    `${cliPrefix} workflow validate --target-root "."`
                )
            ]
        })
    });
    resultBase.warnings.push(...scopeBudgetGuardResolution.warnings);
    const scopeBudgetEffectRoute = buildPendingNextStepEffectRoute({
        effects,
        repoRoot,
        eventsRoot,
        reviewsRoot,
        taskId,
        cliPrefix
    });
    const scopeBudgetDecision = selectProjectedDecisionRoute(
        'scope-budget-guard',
        scopeBudgetGuardResolution.kind,
        scopeBudgetEffectRoute ?? scopeBudgetGuardResolution.route
    );
    if (scopeBudgetDecision) {
        return buildDecisionRouteResult(scopeBudgetDecision);
    }

    const reviewCycleGuardResolution = resolveNextStepGuardDecisionWithWorkflowConfigBoundary({
        readEvaluation: () => readReviewCycleGuardEvaluation(repoRoot, eventsRoot, taskId),
        resolveDecisionRoute: ({ evaluation, latestFailedReview }) => resolveReviewCycleGuardDecisionRoute({
            evaluation,
            getPendingRequiredReviewTypes: () => requiredReviewTypes.filter((reviewType) => {
                const state = reviewStates.find((candidate) => candidate.reviewType === reviewType);
                return !state || !reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, state);
            }),
            assessContinuation: (pendingReviewTypes) => assessReviewCycleContinuationEvidence({
                repoRoot,
                reviewsRoot,
                eventsRoot,
                taskId,
                evaluation: evaluation!,
                reviewPhase: {
                    required_review_types: requiredReviewTypes,
                    pending_required_review_types: pendingReviewTypes
                }
            }),
            buildOperatorBlock: () => buildReviewCycleOperatorBlock(
                evaluation!,
                latestFailedReview
            ),
            materializeLatch: () => {
                const guardDetails = {
                    action: evaluation!.action,
                    total_non_test_review_count: evaluation!.total_non_test_review_count,
                    failed_non_test_review_count: evaluation!.failed_non_test_review_count,
                    cumulative_total_non_test_review_count: evaluation!.attempt_diagnostics.cumulative_total_non_test_review_count,
                    cumulative_failed_non_test_review_count: evaluation!.attempt_diagnostics.cumulative_failed_non_test_review_count,
                    current_scope_total_non_test_review_count: evaluation!.current_scope_total_non_test_review_count,
                    current_scope_failed_non_test_review_count: evaluation!.current_scope_failed_non_test_review_count,
                    current_scope_counts_by_review_type: evaluation!.current_scope_counts_by_review_type,
                    fresh_non_test_review_count: evaluation!.attempt_diagnostics.fresh_non_test_review_count,
                    reused_non_test_review_count: evaluation!.attempt_diagnostics.reused_non_test_review_count,
                    fresh_reused_by_review_type: evaluation!.attempt_diagnostics.fresh_reused_by_review_type,
                    scope_hash_count_by_review_type: evaluation!.attempt_diagnostics.scope_hash_count_by_review_type,
                    top_scope_hashes_by_review_type: evaluation!.attempt_diagnostics.top_scope_hashes_by_review_type,
                    excluded_review_types: evaluation!.excluded_review_types,
                    violations: evaluation!.violations.map((violation) => ({
                        metric: violation.metric,
                        actual: violation.actual,
                        limit: violation.limit
                    }))
                };
                return effects.run({
                    kind: 'materialize-review-cycle-split-latch',
                    summary: `Materialize the review-cycle split latch for ${taskId}`,
                    input: {
                        task_id: taskId,
                        preflight_sha256: preflightSha256,
                        guard_details: guardDetails
                    },
                    preview: () => ({
                        artifact_path: path.join(reviewsRoot, `${taskId}-split-required.json`),
                        artifact_sha256: '<planned>',
                        status_sync: { outcome: 'updated', error_message: null },
                        status_event_recorded: true,
                        latch_event_recorded: true,
                        wip_capture: null
                    } as ReturnType<typeof materializeSplitRequiredLatch>),
                    execute: () => materializeSplitRequiredLatch({
                        repoRoot,
                        eventsRoot,
                        reviewsRoot,
                        taskId,
                        guardKind: 'review_cycle',
                        guardReason: buildReviewCycleOperatorBlock(
                            evaluation!,
                            latestFailedReview
                        ).reason,
                        rawGuardSummary: evaluation!.summary_line,
                        preflightPath,
                        guardDetails
                    })
                });
            },
            materializeAutoSplitPrompt: (latchResult) => effects.run({
                kind: 'materialize-review-cycle-auto-split-prompt',
                summary: `Materialize the review-cycle auto-split prompt for ${taskId}`,
                input: {
                    task_id: taskId,
                    preflight_sha256: preflightSha256,
                    evaluation_summary: evaluation!.summary_line,
                    latest_failed_review: latestFailedReview,
                    cli_prefix: cliPrefix,
                    full_suite_command: fullSuiteConfig.command
                },
                preview: () => ({
                    kind: 'review_cycle_auto_split_prompt',
                    artifact_path: normalizePath(path.join(
                        'garda-agent-orchestrator',
                        'runtime',
                        'reviews',
                        `${taskId}-review-cycle-auto-split-prompt.md`
                    )),
                    artifact_sha256: '<planned>'
                } as ReturnType<typeof materializeReviewCycleAutoSplitPrompt>),
                execute: () => materializeReviewCycleAutoSplitPrompt({
                    repoRoot,
                    reviewsRoot,
                    taskId,
                    evaluation: evaluation!,
                    latestFailedReview,
                    latchResult,
                    cliPrefix,
                    fullSuiteCommand: fullSuiteConfig.command
                })
            }),
            buildContinuationCommand: () => buildReviewCycleContinuationCommand(
                cliPrefix,
                taskId,
                evaluation!
            ),
            buildSplitDecisionCommand: () => buildReviewCycleSplitDecisionCommand(
                repoRoot,
                cliPrefix,
                taskId,
                evaluation!,
                preflightPath
            ),
            formatArtifactPath: (artifactPath) => toRepoDisplayPath(repoRoot, artifactPath),
            presentArtifacts: coreArtifacts.present,
            defaultMissingArtifacts: resultBase.missingArtifacts
        }),
        buildWorkflowConfigValidationRoute: (error) => ({
            status: 'BLOCKED',
            nextGate: 'workflow-config-validation',
            title: 'Validate workflow configuration before continuing.',
            reason: error instanceof Error ? error.message : String(error),
            commands: [
                buildCommand(
                    'Validate workflow config',
                    `${cliPrefix} workflow validate --target-root "."`
                )
            ]
        })
    });
    resultBase.warnings.push(...reviewCycleGuardResolution.warnings);
    const reviewCycleEffectRoute = buildPendingNextStepEffectRoute({
        effects,
        repoRoot,
        eventsRoot,
        reviewsRoot,
        taskId,
        cliPrefix
    });
    const reviewCycleDecision = selectProjectedDecisionRoute(
        'review-cycle-guard',
        reviewCycleGuardResolution.kind,
        reviewCycleEffectRoute ?? reviewCycleGuardResolution.route
    );
    if (reviewCycleDecision) {
        return buildDecisionRouteResult(reviewCycleDecision);
    }

    const strictDecompositionBlock = buildStrictDecompositionContinuationBlock();
    const strictDecompositionDecision = selectProjectedDecisionRoute(
        'strict-decomposition',
        'split',
        strictDecompositionBlock
    );
    if (strictDecompositionDecision) {
        return buildDecisionRouteResult(strictDecompositionDecision);
    }

    const pendingOptionalSkillDecisionRoute = resolvePendingOptionalSkillDecisionRoute(
        pendingOptionalSkillActivation
    );
    const pendingOptionalSkillDecision = selectProjectedDecisionRoute(
        'optional-skill-activation',
        'normal',
        pendingOptionalSkillDecisionRoute
    );
    if (pendingOptionalSkillDecision) {
        return buildDecisionRouteResult(pendingOptionalSkillDecision);
    }

    const fullSuiteCommand = `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
    let auditedNoOpState: {
        required: boolean;
        passed: boolean;
        evidenceStatus: string;
        command: string;
    } | null = null;
    const resolveAuditedNoOpState = () => {
        if (!auditedNoOpState) {
            const required = preflightRequiresAuditedNoOp(preflight);
            const evidence = required
                ? getNoOpEvidence(repoRoot, taskId, '', preflightCommandPath)
                : null;
            auditedNoOpState = {
                required,
                passed: evidence?.evidence_status === 'PASS'
                    && !!getCurrentNoOpEventSha256(repoRoot, taskId, evidence, eventsRoot),
                evidenceStatus: evidence?.evidence_status || 'EVIDENCE_FILE_MISSING',
                command:
                    `${cliPrefix} gate record-no-op --task-id "${taskId}" --classification "AUDIT_ONLY" --reason "<operator-approved no-op rationale>" --preflight-path "${preflightCommandPath}" --repo-root "."`
            };
        }
        return auditedNoOpState;
    };
    const resolveFullSuiteLifecycleRoute = () => {
        const fullSuiteRepairTaskCommand =
            `${cliPrefix} gate materialize-full-suite-repair-task --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --full-suite-artifact-path "${toRepoDisplayPath(repoRoot, readinessArtifacts.paths.fullSuiteValidationPath)}" --repo-root "."`;
        const fullSuiteRunMarkerRecoveryCommand =
            `${cliPrefix} gate full-suite-run-marker-recovery --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
        const fullSuiteRunMarkerCleanupCommand =
            `${cliPrefix} gate full-suite-run-marker-recovery --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --clear-dead-marker --operator-confirmed yes --repo-root "."`;
        return resolveFullSuiteDecisionRoute({
            enabled: fullSuiteConfig.enabled,
            placement: fullSuiteConfig.placement,
            notRequiredForCurrentScope: fullSuiteNotRequiredForCurrentScope,
            gateStatus: fullSuiteCurrentGateStatus,
            gatePassed: fullSuiteGatePassed,
            timeoutBlockerExhausted: fullSuiteTimeoutBlockerExhausted,
            timeoutRepairTaskProposal: fullSuiteTimeoutRepairTaskProposal.summary,
            repeatedTimeoutBlockerAnalysis: fullSuiteTimeoutRepairTaskProposal.repeatedBlockerAnalysis,
            timeoutRepairTaskCommand: fullSuiteTimeoutRepairTaskProposal.suggestedTaskId
                ? fullSuiteRepairTaskCommand
                : null,
            timeoutRepairTaskMaterialized: fullSuiteTimeoutRepairTaskMaterialized,
            timedOutRetryAvailable: fullSuiteTimedOutRetryAvailable,
            transientRetryEvidenceAvailable: fullSuiteManualRetryEvidence.available,
            transientRetryEvidenceReason: fullSuiteManualRetryEvidence.reason,
            targetedDiagnosticRetryAvailable: fullSuiteTargetedDiagnosticEvidence.available,
            targetedDiagnosticRetryReason: fullSuiteTargetedDiagnosticEvidence.reason,
            configPath: fullSuiteSummary.config_path,
            commandText: fullSuiteConfig.command,
            timeoutForecastLine: fullSuiteTimeoutForecastLine,
            command: fullSuiteCommand,
            runMarkerRecoveryCommand: fullSuiteRunMarkerRecoveryCommand,
            runMarkerCleanupCommand: fullSuiteRunMarkerCleanupCommand,
            navigatorCommand,
            nextReviewType: reviewLaunchPlan.next_review_type,
            interruptedRun: interruptedFullSuiteRun,
            unresolvedRunMarkerPath: unresolvedFullSuiteRunMarkerPath
        });
    };
    const validationDecisionRoute = resolveValidationDecisionRoute({
        lifecycleGateIds: getActiveTaskLifecycleGateIds('validation', {
            changes_exist:
                Array.isArray(preflight?.changed_files) && preflight.changed_files.length > 0,
            optional_quality_checks_enabled: qualityChecklistReadiness?.enabled === true,
            full_suite_after_compile_before_reviews:
                fullSuiteConfig.enabled && fullSuiteConfig.placement === 'after_compile_before_reviews'
        }),
        resolveQualityChecklistRoute: () => qualityChecklistReadiness
            ? resolveNextStepQualityChecklistRoute({
                enabled: qualityChecklistReadiness.enabled,
                required: qualityChecklistReadiness.required,
                ready: qualityChecklistReadiness.ready,
                status: qualityChecklistReadiness.status,
                reason: qualityChecklistReadiness.reason,
                actionRequiredSummary: qualityChecklistReadiness.actionRequiredSummary,
                answersTemplatePath: qualityChecklistReadiness.answersTemplatePath
                    ? toRepoDisplayPath(repoRoot, qualityChecklistReadiness.answersTemplatePath)
                    : null,
                command: buildQualityChecklistCommand(
                    repoRoot,
                    cliPrefix,
                    taskId,
                    preflightCommandPath,
                    taskModePath,
                    qualityChecklistReadiness.answersTemplatePath
                )
            })
            : null,
        resolveBaselineOnlyPreImplementationRoute: () => buildBaselineOnlyPreImplementationRoute({
            repoRoot,
            cliPrefix,
            taskEntry,
            taskMode,
            preflight,
            auditedNoOpPassed: resolveAuditedNoOpState().passed
        }),
        resolveTestFirstExpectedFailureRoute: () => buildTestFirstExpectedFailureRoute({
            repoRoot,
            reviewsRoot,
            eventsRoot,
            taskId,
            taskEntry,
            preflight,
            preflightPath,
            preflightCommandPath,
            cliPrefix,
            workspaceReady: preflightWorkspaceReadiness.ready,
            currentChangedFiles: preflightWorkspaceReadiness.currentChangedFiles
        }),
        resolveCompileGateRoute: () => {
            const semanticCompileAccepted = semanticResumeReusable && semanticCycleResume.accepted_compile;
            const compileReadiness = semanticCompileAccepted
                ? { ready: true, reason: semanticCycleResume.reason }
                : preflight
                ? readCompileReadiness(
                    repoRoot,
                    reviewsRoot,
                    eventsRoot,
                    taskId,
                    preflightPath,
                    workspaceSnapshotRequest
                )
                : { ready: false, reason: 'No current preflight exists.' };
            return resolveNextStepCompileGateRoute({
                compileGatePassed: semanticCompileAccepted || isGatePassed(summary, 'compile-gate'),
                ready: compileReadiness.ready,
                reason: compileReadiness.reason,
                recoveryGate: compileReadiness.recoveryGate,
                restartTaskModeCommand: buildOrchestratorWorkRestartCommand(
                    repoRoot,
                    cliPrefix,
                    taskId,
                    taskMode
                ),
                refreshPreflightCommand: buildAuthenticatedScopeClassifyChangeCommand({
                    repoRoot,
                    cliPrefix,
                    taskId,
                    taskMode,
                    taskModePath,
                    preflightCommandPath,
                    includePlannedScope: false,
                    taskQueueEntries: taskEntries,
                    changedFiles: getPreflightRefreshCommandChangedFiles({
                        repoRoot,
                        preflight,
                        taskMode,
                        workspaceSnapshotRequest,
                        fallbackChangedFiles: preflightWorkspaceReadiness.currentChangedFiles
                            ?? getPreflightRefreshChangedFiles(repoRoot, taskMode, preflight)
                    })
                }),
                compileCommand: buildCompileGateCommand(
                    repoRoot,
                    cliPrefix,
                    taskId,
                    preflightCommandPath,
                    taskModePath
                )
            });
        },
        resolveAuditedNoOpState,
        resolveFullSuiteValidationRoute: resolveFullSuiteLifecycleRoute
    });
    const validationDecision = selectProjectedDecisionRoute(
        'validation',
        validationDecisionRoute?.nextGate === 'record-no-op' ? 'audited-no-op' : 'normal',
        validationDecisionRoute
    );
    if (validationDecision) {
        return buildDecisionRouteResult(validationDecision);
    }

    const reviewBoundaryDecisionRoute = resolveFirstActiveTaskLifecycleGate(
        getActiveTaskLifecycleGateIds('review', {
            reviews_required: requiredReviewTypes.length > 0,
            full_suite_before_review_checkpoint:
                fullSuiteConfig.enabled && fullSuiteConfig.placement === 'before_test_review'
        }),
        { 'full-suite-validation': resolveFullSuiteLifecycleRoute }
    );
    const reviewBoundaryDecision = selectProjectedDecisionRoute(
        'review-boundary',
        'normal',
        reviewBoundaryDecisionRoute
    );
    if (reviewBoundaryDecision) {
        return buildDecisionRouteResult(reviewBoundaryDecision);
    }

    if (reviewLaunchPlan.next_review_type) {
        const reviewType = reviewLaunchPlan.next_review_type;
        const state = reviewStates.find((candidate) => candidate.reviewType === reviewType);
        const currentReviewReuseRecorded = state
            ? state.reusedExistingReview && timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state)
            : false;
        const currentReviewEvidenceSatisfied = state
            ? reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, state)
            : false;
        const currentReviewRecordedEvidenceCurrent = state
            ? reviewStateHasCurrentRecordedEvidence(repoRoot, eventsRoot, taskId, state)
            : false;
        const currentReviewContextInvocationAttested = state
            ? timelineHasDelegatedReviewInvocationForCurrentContext(repoRoot, eventsRoot, taskId, state)
            : false;
        const currentReviewContextPrepared = state
            ? timelineHasReviewContextPreparedAfterCompile(eventsRoot, taskId, reviewType, state.contextPath)
            : false;
        const currentReviewerLaunchArtifactEvidence = state
            ? getCurrentReviewerLaunchArtifactEvidenceForInvocation(repoRoot, eventsRoot, taskId, state)
            : null;
        const dependencies = reviewLaunchPlan.blocked_review_dependencies;
        const reviewDepth = getEffectiveDepthForPostPreflightRules(preflight, taskMode);
        const scopedDiffMetadataPath = path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.json`);
        const scopedDiffOutputPath = path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.diff`);
        const scopedDiffReadiness = scopedDiffExpectedForReview({
            preflight,
            reviewType
        })
            ? getScopedDiffMetadataReadiness({
                metadataPath: scopedDiffMetadataPath,
                preflight,
                preflightPath,
                preflightSha256,
                reviewType
            })
            : { ready: true, reason: 'Scoped diff metadata is not required for this review context.' };
        const reviewerReadinessChain = buildReviewerReadinessChainSummary(
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            state,
            (candidateState) => reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, candidateState)
        );
        const resolveFindingsFollowUpRoute = (): NextStepDecisionRoutePayload | null => {
            const dispositionArtifactPath = state?.reviewFindingsDispositionArtifactPath
                || path.join(reviewsRoot, `${taskId}-${reviewType}-findings-disposition.json`);
            const followUpArtifactPath = state?.reviewFindingsFollowUpArtifactPath
                || dispositionArtifactPath.replace(/-findings-disposition\.json$/u, '-findings-follow-ups.json');
            return resolveFindingsFollowUpLifecycleRoute({
                reviewType,
                findingsDispositionReady: Boolean(
                    state?.reviewFindingsDisposition
                    && state.ready
                    && currentReviewRecordedEvidenceCurrent
                ),
                followUpCount: state?.reviewFindingsDisposition?.counts_by_action.create_follow_up || 0,
                followUpSatisfied: Boolean(state?.reviewFindingsFollowUpSatisfied),
                groupedByParent: state?.reviewFollowUpMaterializationMode === 'grouped_by_parent',
                validationArtifactDisplayPath: state?.reviewFindingsValidationArtifactPath
                    ? formatNextStepInlineValue(toRepoDisplayPath(repoRoot, state.reviewFindingsValidationArtifactPath))
                    : null,
                materializeFollowUpsCommand: buildCommand(
                    'Materialize review follow-up tasks',
                    `${cliPrefix} gate materialize-review-follow-up-tasks ` +
                    `--task-id "${taskId}" ` +
                    `--review-type "${reviewType}" ` +
                    `--disposition-artifact-path "${toRepoDisplayPath(repoRoot, dispositionArtifactPath)}" ` +
                    `--receipt-path "${toRepoDisplayPath(repoRoot, state?.receiptPath || path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`))}" ` +
                    `--artifact-path "${toRepoDisplayPath(repoRoot, followUpArtifactPath)}" ` +
                        '--repo-root "."'
                )
            });
        };
        const resolveCurrentCycleReuseDecisionRoute = (): NextStepDecisionRoutePayload | null => {
            const currentCycleReuseCandidate = Boolean(
                state
                && state.ready
                && state.contextExists
                && state.domainScopeCurrent
                && !state.failed
                && !currentReviewEvidenceSatisfied
            );
            return resolveCurrentCycleReviewReuseRoute({
                reviewType,
                stateReady: Boolean(state?.ready),
                contextExists: Boolean(state?.contextExists),
                domainScopeCurrent: Boolean(state?.domainScopeCurrent),
                reviewFailed: Boolean(state?.failed),
                currentReviewEvidenceSatisfied,
                postReviewGateFreshnessRecoveryActive,
                postReviewGateFreshnessRecoveryReason,
                scopedDiffReadiness,
                reviewerReadinessChain,
                reviewContextChain: currentCycleReuseCandidate
                    ? buildReviewGateChainStatusSummary({
                        repoRoot,
                        eventsRoot,
                        taskId,
                        reviewType,
                        edgeId: postReviewGateFreshnessRecoveryActive
                            ? 'post-review-gate-to-review-reuse'
                            : 'compile-to-review-reuse',
                        reason: postReviewGateFreshnessRecoveryActive
                            ? `post-review gate freshness recovery must materialize '${reviewType}' current-cycle reuse before closeout`
                            : `latest compile evidence is current before materializing '${reviewType}' current-cycle review reuse`,
                        preflightPath: preflightCommandPath,
                        reviewContextPath: state?.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
                        depth: reviewDepth
                    })
                    : '',
                commands: {
                    buildScopedDiff: buildCommand(
                        'Build scoped diff',
                        buildScopedDiffCommand({
                            cliPrefix,
                            reviewType,
                            preflightCommandPath,
                            outputPath: toRepoDisplayPath(repoRoot, scopedDiffOutputPath),
                            metadataPath: toRepoDisplayPath(repoRoot, scopedDiffMetadataPath)
                        })
                    ),
                    buildReviewContext: buildCommand(
                        'Build review context',
                        buildReviewContextCommand(
                            repoRoot,
                            cliPrefix,
                            taskId,
                            reviewType,
                            reviewDepth,
                            preflightCommandPath,
                            taskModePath
                        )
                    )
                }
            });
        };
        const resolveDependencyPreparationRoute = (): NextStepDecisionRoutePayload | null =>
            resolveReviewLaunchableLanePreparationRoute({
                reviewPolicyMode: reviewPolicy.mode,
                reviewType,
                dependencies,
                dependencyDetails: dependencies.length > 0
                    ? describeBlockedReviewDependencies(dependencies, reviewStates)
                    : '',
                reviewerReadinessChain,
                reviewContextChain: '',
                scopedDiffReadiness: { ready: true, reason: '' },
                stateExists: true,
                contextExists: true,
                contextCurrent: true,
                contextDetailsSuffix: '',
                commands: {
                    finishUpstreamReview: buildCommand(
                        'Finish upstream review first',
                        navigatorCommand
                    ),
                    buildScopedDiff: buildCommand('Build scoped diff', navigatorCommand),
                    buildReviewContext: buildCommand('Build review context', navigatorCommand)
                }
            });
        const resolveStrictSequentialUpstreamReuseDecisionRoute =
            (): NextStepDecisionRoutePayload | null => {
            const strictSequentialUpstreamReuse = findStrictSequentialUpstreamNeedingCurrentCycleReuse({
                repoRoot,
                eventsRoot,
                taskId,
                targetReviewType: reviewType,
                requiredReviews: summary.required_reviews,
                policyMode: reviewPolicy.mode,
                reviewStates
            });
            if (!strictSequentialUpstreamReuse) {
                return null;
            }
            const upstreamReviewType = strictSequentialUpstreamReuse.upstreamReviewType;
            const upstreamState = strictSequentialUpstreamReuse.upstreamState;
            const upstreamScopedDiffMetadataPath = path.join(reviewsRoot, `${taskId}-${upstreamReviewType}-scoped.json`);
            const upstreamScopedDiffOutputPath = path.join(reviewsRoot, `${taskId}-${upstreamReviewType}-scoped.diff`);
            const upstreamScopedDiffReadiness = scopedDiffExpectedForReview({
                preflight,
                reviewType: upstreamReviewType
            })
                ? getScopedDiffMetadataReadiness({
                    metadataPath: upstreamScopedDiffMetadataPath,
                    preflight,
                    preflightPath,
                    preflightSha256,
                    reviewType: upstreamReviewType
                })
                : { ready: true, reason: 'Scoped diff metadata is not required for this review context.' };
            const upstreamReviewerReadinessChain = buildReviewerReadinessChainSummary(
                repoRoot,
                eventsRoot,
                taskId,
                upstreamReviewType,
                upstreamState,
                (candidateState) => reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, candidateState)
            );
            const upstreamReviewContextChain = buildReviewGateChainStatusSummary({
                repoRoot,
                eventsRoot,
                taskId,
                reviewType: upstreamReviewType,
                edgeId: 'compile-to-review-context',
                reason:
                    `latest compile evidence is current before materializing '${upstreamReviewType}' review reuse ` +
                    `for downstream '${reviewType}' preparation`,
                preflightPath: preflightCommandPath,
                reviewContextPath: upstreamState.contextPath
                    ? toRepoDisplayPath(repoRoot, upstreamState.contextPath)
                    : undefined,
                depth: reviewDepth
            });
            return resolveStrictSequentialUpstreamReuseRoute({
                reviewPolicyMode: reviewPolicy.mode,
                downstreamReviewType: reviewType,
                upstreamReviewType,
                reuseCandidateHint: getBuildReviewContextReuseCandidateHint(eventsRoot, taskId, upstreamState),
                upstreamScopedDiffReadiness,
                upstreamReviewerReadinessChain,
                upstreamReviewContextChain,
                commands: {
                    buildScopedDiff: buildCommand(
                        'Build scoped diff',
                        buildScopedDiffCommand({
                            cliPrefix,
                            reviewType: upstreamReviewType,
                            preflightCommandPath,
                            outputPath: toRepoDisplayPath(repoRoot, upstreamScopedDiffOutputPath),
                            metadataPath: toRepoDisplayPath(repoRoot, upstreamScopedDiffMetadataPath)
                        })
                    ),
                    buildReviewContext: buildCommand(
                        'Build upstream review context',
                        buildReviewContextCommand(repoRoot, cliPrefix, taskId, upstreamReviewType, reviewDepth, preflightCommandPath, taskModePath)
                    )
                }
            });
        };
        const resolveFailedReviewDecisionRoute = (): NextStepDecisionRoutePayload | null => {
            if (!state?.failed) {
                return null;
            }
            const correctionFullReviewRestart =
                state.failureKind === 'review-correction-full-review-required';
            const taskIntent = taskEntry?.title || getStringField(taskMode, 'task_summary', taskId);
            const downstreamReviewTypes = getDownstreamReviewTypesFor(
                reviewType,
                requiredReviewTypes,
                summary.required_reviews,
                reviewPolicy.mode,
                reviewDependencyGraph
            );
            const reviewContextChain = buildReviewGateChainStatusSummary({
                repoRoot,
                eventsRoot,
                taskId,
                reviewType,
                edgeId: 'compile-to-review-context',
                reason: `latest compile evidence is current before rebuilding '${reviewType}' review context`,
                preflightPath: preflightCommandPath,
                reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
                depth: reviewDepth
            });
            const requiredFocusedTestPath = state.failureKind === 'missing-focused-validation-evidence'
                ? readFocusedTestRequiredByReview({
                    taskId,
                    reviewType,
                    reviewArtifactPath: state.artifactPath
                })
                : null;
            const focusedRecoveryCoverageContractSha256 = state.failureKind === 'missing-focused-validation-evidence'
                ? buildFocusedRecoveryCoverageContractSha256({
                    reviewType,
                    preflight: preflight as Record<string, unknown>,
                    repoRoot
                })
                : null;
            const focusedIntermediateEvidence = state.failureKind === 'missing-focused-validation-evidence'
                ? readPostReviewFocusedIntermediateEvidence({
                    repoRoot,
                    reviewsRoot,
                    eventsRoot,
                    taskId,
                    reviewType,
                    reviewArtifactPath: state.artifactPath,
                    reviewResultRecordedAtUtc: state.reviewResultRecordedAtUtc,
                    reviewerProvenanceTaskSequence: state.reviewerProvenance?.task_sequence ?? null,
                    changedFiles: getPreflightChangedFilesForReviewRemediation(preflight),
                    expectedPreflightPath: preflightPath,
                    expectedPreflightSha256: preflightSha256,
                    expectedCoverageContractSha256: focusedRecoveryCoverageContractSha256
                })
                : { available: false, reason: null };
            const reviewerResultRecoveryIdentity = [
                'review-validation-rejected',
                'review-correction-transport-selection-required'
            ].includes(state.failureKind || '')
                ? resolveReviewerResultRecoveryIdentity({
                    launchState: currentReviewerLaunchArtifactEvidence?.state === 'provider_failed'
                        ? 'launched'
                        : currentReviewerLaunchArtifactEvidence?.state || 'missing_or_invalid',
                    launchReviewerIdentity: currentReviewerLaunchArtifactEvidence?.reviewerIdentity || null,
                    receiptReviewerIdentity: state.reviewerIdentity,
                    receiptIdentityCurrent: state.receiptContractCurrent === true,
                    contextReviewerIdentity: state.contextReviewerIdentity,
                    receivingGateCanResolveCurrentAttempt: false
                })
                : null;
            return resolveFailedReviewRemediationRoute({
                taskId,
                reviewType,
                verdictToken: state.verdictToken || state.failToken || 'FAILED',
                failureKind: state.failureKind,
                failureReason: state.failureReason,
                currentReviewRecordedEvidenceCurrent,
                focusedIntermediateEvidence,
                currentReviewContextPrepared,
                scopedDiffReadiness,
                reviewerReadinessChain,
                reviewContextChain,
                downstreamReviewTypes,
                reviewerResultRecoveryIdentity,
                launchArtifactState: currentReviewerLaunchArtifactEvidence?.state || 'missing_or_invalid',
                correctionHandoff: state.reviewOutputCorrectionHandoff,
                commands: {
                    restartReviewCycle: buildCommand(
                        state.failureKind === 'missing-focused-validation-evidence'
                            ? 'Restart review cycle after focused validation evidence'
                            : state.failureKind === 'missing-validation-evidence'
                            ? 'Restart review cycle after manual-validation evidence refresh'
                            : 'Restart review cycle for reviewer launch retry',
                        buildRestartReviewCycleCommand(
                            repoRoot,
                            cliPrefix,
                            taskId,
                            taskIntent,
                            preflightCommandPath,
                            taskModePath,
                            resolveIgnoredRemediationCommandChangedFiles({
                                repoRoot,
                                taskId,
                                reviewArtifactPaths: [state.artifactPath],
                                taskMode
                            }),
                            {
                                includeChangedFileScope:
                                    !correctionFullReviewRestart
                                    && state.failureKind !== 'missing-focused-validation-evidence'
                                    && state.failureKind !== 'missing-validation-evidence',
                                reviewType,
                                reviewEvidenceOnly: correctionFullReviewRestart
                            }
                        )
                    ),
                    rerunNavigator: buildCommand(
                        'Rerun navigator after fixing implementation',
                        navigatorCommand
                    ),
                    compileGate: buildCommand(
                        'Run compile gate to refresh validation evidence',
                        buildCompileGateCommand(
                            repoRoot,
                            cliPrefix,
                            taskId,
                            preflightCommandPath,
                            taskModePath
                        )
                    ),
                    buildScopedDiff: buildCommand(
                        'Build scoped diff',
                        buildScopedDiffCommand({
                            cliPrefix,
                            reviewType,
                            preflightCommandPath,
                            outputPath: toRepoDisplayPath(repoRoot, scopedDiffOutputPath),
                            metadataPath: toRepoDisplayPath(repoRoot, scopedDiffMetadataPath)
                        })
                    ),
                    buildReviewContext: buildCommand(
                        'Build review context',
                        buildReviewContextCommand(
                            repoRoot,
                            cliPrefix,
                            taskId,
                            reviewType,
                            reviewDepth,
                            preflightCommandPath,
                            taskModePath,
                            requiredFocusedTestPath
                        )
                    ),
                    recordCorrectionInvocation: buildCommand(
                        'After launching the correction-only reviewer, attest its provider invocation',
                        buildRecordReviewOutputCorrectionInvocationCommand(
                            repoRoot,
                            cliPrefix,
                            taskId,
                            reviewType,
                            state.reviewOutputCorrectionArtifactPath || state.artifactPath,
                            state.reviewOutputCorrectionArtifactPath
                                ? readReviewArtifactFileSha256(state.reviewOutputCorrectionArtifactPath)
                                    || '<persisted correction input sha256>'
                                : '<persisted correction input sha256>',
                            taskModePath,
                            state.reviewOutputCorrectionLaunchState === 'delegation_started'
                                ? {
                                    producerIdentity: state.reviewOutputCorrectionProducerIdentity,
                                    providerInvocationId: state.reviewOutputCorrectionProviderInvocationId,
                                    attestationSource: state.reviewOutputCorrectionAttestationSource
                                }
                                : undefined
                        )
                    ),
                    recordCorrectionTransport: buildCommand(
                        'Record fail-closed provider-controller session unavailability',
                        buildRecordReviewOutputCorrectionTransportCommand({
                            repoRoot,
                            cliPrefix,
                            taskId,
                            reviewType,
                            correctionArtifactPath:
                                state.reviewOutputCorrectionArtifactPath || state.artifactPath,
                            reviewerIdentity:
                                state.reviewOutputCorrectionReviewerIdentity
                                || (
                                    reviewerResultRecoveryIdentity?.ready
                                        ? reviewerResultRecoveryIdentity.reviewerIdentity
                                        : null
                                )
                                || state.contextReviewerIdentity
                                || '<agent:original-reviewer-id>',
                            providerInvocationId:
                                state.reviewOutputCorrectionOriginalProviderInvocationId
                                || '<original-provider-invocation-id>',
                            taskModePath
                        })
                    ),
                    recordResult: buildCommand(
                        'Record corrected delegated review result',
                        buildRecordReviewResultCommand(
                            repoRoot,
                            cliPrefix,
                            taskId,
                            reviewType,
                            reviewerResultRecoveryIdentity?.ready
                                ? reviewerResultRecoveryIdentity.reviewerIdentity
                                : null,
                            preflightCommandPath,
                            taskModePath,
                            null
                        )
                    )
                }
            });
        };
        const resolveContextPreparationRoute = (): NextStepDecisionRoutePayload | null => {
            const reviewContextChain = buildReviewGateChainStatusSummary({
                repoRoot,
                eventsRoot,
                taskId,
                reviewType,
                edgeId: 'compile-to-review-context',
                reason: `latest compile evidence is current before '${reviewType}' review-context preparation`,
                preflightPath: preflightCommandPath,
                reviewContextPath: state?.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
                depth: reviewDepth
            });
            const contextDetails = state?.violations
                .filter((violation) => violation.includes('review context'))
                .join(' ');
            const buildContextCommand = buildCommand(
                'Build review context',
                buildReviewContextCommand(repoRoot, cliPrefix, taskId, reviewType, reviewDepth, preflightCommandPath, taskModePath)
            );
            const preparationRoute = resolveReviewLaunchableLanePreparationRoute({
                reviewPolicyMode: reviewPolicy.mode,
                reviewType,
                dependencies: [],
                dependencyDetails: '',
                reviewerReadinessChain,
                reviewContextChain,
                scopedDiffReadiness,
                stateExists: Boolean(state),
                contextExists: Boolean(state?.contextExists),
                contextCurrent: Boolean(state?.contextCurrent),
                contextDetailsSuffix: contextDetails ? ` ${contextDetails}` : '',
                commands: {
                    finishUpstreamReview: buildCommand(
                        'Finish upstream review first',
                        navigatorCommand
                    ),
                    buildScopedDiff: buildCommand(
                        'Build scoped diff',
                        buildScopedDiffCommand({
                            cliPrefix,
                            reviewType,
                            preflightCommandPath,
                            outputPath: toRepoDisplayPath(repoRoot, scopedDiffOutputPath),
                            metadataPath: toRepoDisplayPath(repoRoot, scopedDiffMetadataPath)
                        })
                    ),
                    buildReviewContext: buildContextCommand
                }
            });
            return resolveContextPreparationLifecycleRoute({
                contextReady: Boolean(state?.contextExists && state.contextCurrent),
                reviewType,
                reviewerReadinessChain,
                reviewContextChain,
                preparationRoute,
                buildReviewContextCommand: buildContextCommand
            });
        };
        const resolveDelegatedReadinessDecisionRoute = (): NextStepDecisionRoutePayload | null => {
            if (!state || !state.contextExists || !state.contextCurrent) {
                return null;
            }
        const contextReviewerIdentity = state.contextReviewerIdentity || '';
        const providerLaunchTargetSummary = buildProviderNativeReviewerLaunchTargetSummary(taskMode);
        const routingCurrent = (
            contextReviewerIdentity.startsWith('agent:')
            && timelineHasDelegatedReviewRoutingAfterCompile(eventsRoot, taskId, reviewType, contextReviewerIdentity)
        );
        const launchArtifactEvidence = currentReviewerLaunchArtifactEvidence
            || getCurrentReviewerLaunchArtifactEvidenceForInvocation(repoRoot, eventsRoot, taskId, state);
        const reviewerIdentityBinding = resolveDelegatedReviewerIdentityBinding({
            contextReviewerIdentity,
            launchArtifactState: launchArtifactEvidence.state,
            launchReviewerIdentity: launchArtifactEvidence.reviewerIdentity
        });
        const delegatedReviewerIdentity = reviewerIdentityBinding.delegatedReviewerIdentity;
        const reviewerIdentity = reviewerIdentityBinding.reviewerIdentity;
        const routingReviewerIdentity = null;
        const defaultLaunchArtifactPath = buildDefaultReviewScratchCommandPath(
            repoRoot,
            taskId,
            reviewType,
            'reviewer-launch.json'
        );
        const currentLaunchArtifactPath = launchArtifactEvidence.path
            ? toRepoDisplayPath(repoRoot, launchArtifactEvidence.path)
            : defaultLaunchArtifactPath;
        const reviewRoutingChain = buildReviewGateChainStatusSummary({
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            edgeId: 'review-context-to-routing',
            reason: `current '${reviewType}' review context is ready for routing before reviewer launch preparation`,
            preflightPath: preflightCommandPath,
            reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
            depth: reviewDepth
        });
        const launchPreparationChain = buildReviewGateChainStatusSummary({
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            edgeId: 'review-routing-to-launch-prepared',
            reason: `current '${reviewType}' routing telemetry is ready before reviewer launch preparation`,
            preflightPath: preflightCommandPath,
            reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
            depth: reviewDepth
        });
        const launchCompletionChain = buildReviewGateChainStatusSummary({
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            edgeId: 'review-launch-prepared-to-launch-completed',
            reason: `prepared '${reviewType}' launch metadata is ready to be completed with provider-owned invocation evidence`,
            preflightPath: preflightCommandPath,
            reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
            depth: reviewDepth
        });
        const reviewInvocationChain = buildReviewGateChainStatusSummary({
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            edgeId: 'review-launch-completed-to-invocation',
            reason: `completed '${reviewType}' launch evidence is ready for invocation attestation before review output materialization`,
            preflightPath: preflightCommandPath,
            reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
            depth: reviewDepth
        });
        const reviewResultChain = buildReviewGateChainStatusSummary({
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            edgeId: 'review-invocation-to-result',
            reason: `current '${reviewType}' invocation attestation is ready before review result materialization`,
            preflightPath: preflightCommandPath,
            reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
            depth: reviewDepth
        });
        const acceptedVerdictTokens = formatAcceptedReviewVerdictTokens(
            buildReviewVerdictTokenSet(reviewType, state.passToken || null, state.failToken || null)
        );
        const stateViolations = state.violations.length > 0
            ? state.violations.join('; ')
            : 'review artifact or receipt is missing';
        const reviewCycleTaskIntent = taskEntry?.title || getStringField(taskMode, 'task_summary', taskId);
        return resolveDelegatedReadinessLifecycleRoute({
            contextReady: true,
            contextReviewerIdentity,
            recordedReviewerIdentity: state.reviewerIdentity || '',
            launchArtifactState: launchArtifactEvidence.state,
            identityBinding: reviewerIdentityBinding,
            launchInputArtifactPath: launchArtifactEvidence.launchInputArtifactPath,
            launchInputArtifactSha256: launchArtifactEvidence.launchInputArtifactSha256,
            decision: {
                reviewType,
                currentReviewReuseRecorded,
                currentReviewEvidenceSatisfied,
                currentReviewContextInvocationAttested,
                routingCurrent,
                artifactExists: state.artifactExists,
                receiptExists: state.receiptExists,
                reviewFailed: state.failed,
                stateReady: state.ready,
                stateViolationsText: stateViolations,
                launchArtifactOrphanedReason: launchArtifactEvidence.orphanedReason,
                providerLaunchTargetSummary,
                reviewerReadinessChain,
                reviewRoutingChain,
                launchPreparationChain,
                launchCompletionChain,
                reviewInvocationChain,
                reviewResultChain,
                acceptedVerdictTokens,
                hiddenTimingTrustRemediation: getHiddenReviewTimingTrustRemediation(eventsRoot, taskId, state),
                reusedExistingReview: state.reusedExistingReview,
                instructions: {
                opaqueHandoff: REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
                freshContextLaunch: REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION,
                sessionReuseBoundary: REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION,
                realSubagentOrStop: REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION,
                cleanupAfterReceipt: REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION
                },
                commands: {
                recordRouting: buildCommand(
                    'Record fresh delegated review routing',
                    buildReviewRoutingCommand(repoRoot, cliPrefix, taskId, reviewType, routingReviewerIdentity, taskModePath)
                ),
                prepareLaunch: buildCommand(
                    'Prepare delegated reviewer launch metadata',
                    buildPrepareReviewerLaunchCommand(
                        repoRoot,
                        cliPrefix,
                        taskId,
                        reviewType,
                        routingReviewerIdentity,
                        defaultLaunchArtifactPath,
                        taskModePath
                    )
                ),
                recordDelegationStartedChoices: [
                    buildCommand(
                        'Record delegated reviewer start from reviewer-facing launch artifact',
                        buildRecordReviewerDelegationStartedCommand({
                            cliPrefix,
                            taskId,
                            reviewType,
                            reviewerIdentity: delegatedReviewerIdentity,
                            launchArtifactPath: currentLaunchArtifactPath,
                            launchInputMode: 'launch_artifact_path',
                            launchInputArtifactPath: launchArtifactEvidence.launchInputArtifactPath,
                            launchInputSha256: launchArtifactEvidence.launchInputArtifactSha256,
                            providerInvocationId: launchArtifactEvidence.providerInvocationId,
                            controllerInvocationId: launchArtifactEvidence.controllerInvocationId,
                            attestationSource: launchArtifactEvidence.attestationSource
                        })
                    ),
                    buildCommand(
                        'Record delegated reviewer start from exact copy-paste prompt',
                        buildRecordReviewerDelegationStartedCommand({
                            cliPrefix,
                            taskId,
                            reviewType,
                            reviewerIdentity: delegatedReviewerIdentity,
                            launchArtifactPath: currentLaunchArtifactPath,
                            launchInputMode: 'copy_paste_prompt',
                            launchInputSha256:
                                launchArtifactEvidence.copyPasteReviewerLaunchPromptSha256,
                            providerInvocationId: launchArtifactEvidence.providerInvocationId,
                            controllerInvocationId: launchArtifactEvidence.controllerInvocationId,
                            attestationSource: launchArtifactEvidence.attestationSource
                        })
                    )
                ],
                recordDelegationStarted: buildCommand(
                    'Record delegated reviewer start',
                    launchArtifactEvidence.launchInputMode
                        ? buildRecordReviewerDelegationStartedCommand({
                            cliPrefix,
                            taskId,
                            reviewType,
                            reviewerIdentity: delegatedReviewerIdentity,
                            launchArtifactPath: currentLaunchArtifactPath,
                            launchInputMode: launchArtifactEvidence.launchInputMode,
                            launchInputArtifactPath: launchArtifactEvidence.launchInputArtifactPath,
                            launchInputSha256: launchArtifactEvidence.launchInputSha256,
                            providerInvocationId: launchArtifactEvidence.providerInvocationId,
                            controllerInvocationId: launchArtifactEvidence.controllerInvocationId,
                            attestationSource: launchArtifactEvidence.attestationSource
                        })
                        : navigatorCommand
                ),
                completeLaunch: buildCommand(
                    'Complete delegated reviewer launch metadata',
                    launchArtifactEvidence.launchInputMode
                        ? buildCompleteReviewerLaunchCommand({
                            cliPrefix,
                            taskId,
                            reviewType,
                            reviewerIdentity: delegatedReviewerIdentity,
                            launchArtifactPath: currentLaunchArtifactPath,
                            launchInputMode: launchArtifactEvidence.launchInputMode,
                            launchInputArtifactPath: launchArtifactEvidence.launchInputArtifactPath,
                            launchInputSha256: launchArtifactEvidence.launchInputSha256,
                            providerInvocationId: launchArtifactEvidence.providerInvocationId,
                            controllerInvocationId: launchArtifactEvidence.controllerInvocationId,
                            attestationSource: launchArtifactEvidence.attestationSource,
                            recordInvocation: true
                        })
                        : navigatorCommand
                ),
                recoverOrphanedLaunch: buildCommand(
                    'Restart/supersede orphaned delegated reviewer launch',
                    buildRestartReviewCycleCommand(
                        repoRoot,
                        cliPrefix,
                        taskId,
                        reviewCycleTaskIntent,
                        preflightCommandPath,
                        taskModePath,
                        [],
                        {
                            includeChangedFileScope: false,
                            reviewType,
                            reviewEvidenceOnly: true
                        }
                    )
                ),
                recoverFailedLaunch: buildCommand(
                    'Restart/supersede failed delegated reviewer launch',
                    buildRestartReviewCycleCommand(
                        repoRoot,
                        cliPrefix,
                        taskId,
                        reviewCycleTaskIntent,
                        preflightCommandPath,
                        taskModePath,
                        [],
                        {
                            includeChangedFileScope: false,
                            reviewType,
                            reviewEvidenceOnly: true
                        }
                    )
                ),
                recordInvocation: buildCommand(
                    'Record delegated reviewer launch attestation',
                    buildRecordReviewerInvocationCommand(
                        repoRoot,
                        cliPrefix,
                        taskId,
                        reviewType,
                        reviewerIdentity,
                        currentLaunchArtifactPath,
                        taskModePath
                    )
                ),
                recordResult: buildCommand(
                    launchArtifactEvidence.reviewOutputPath
                        ? 'Record delegated review output file, then close reviewer'
                        : 'Pipe delegated review output into stdin, then close reviewer',
                    buildRecordReviewResultCommand(
                        repoRoot,
                        cliPrefix,
                        taskId,
                        reviewType,
                        reviewerIdentity,
                        preflightCommandPath,
                        taskModePath,
                        launchArtifactEvidence.reviewOutputPath
                    )
                )
                }
            }
        });
        };
        const activeReviewLifecycleDecisionRoute = resolveActiveReviewLifecycleDecisionRoute({
            resolveFindingsFollowUpRoute,
            resolveCurrentCycleReuseRoute: resolveCurrentCycleReuseDecisionRoute,
            resolveDependencyPreparationRoute,
            resolveStrictSequentialUpstreamReuseRoute:
                resolveStrictSequentialUpstreamReuseDecisionRoute,
            resolveFailedReviewRemediationRoute: resolveFailedReviewDecisionRoute,
            resolveContextPreparationRoute,
            resolveDelegatedReadinessRoute: resolveDelegatedReadinessDecisionRoute
        });
        const activeReviewDecision = selectProjectedDecisionRoute(
            'active-review',
            state?.failed ? 'failed-review' : 'normal',
            activeReviewLifecycleDecisionRoute
        );
        if (activeReviewDecision) {
            const semanticResumePrefix = semanticResumeReusable
                ? `${semanticCycleResume.reason} Accepted unchanged review lanes: ${
                    semanticCycleResume.accepted_review_types.join(', ') || 'none'
                }. `
                : '';
            return buildResult({
                ...resultBase,
                status: activeReviewDecision.status,
                nextGate: activeReviewDecision.nextGate,
                title: activeReviewDecision.title,
                reason: semanticResumePrefix + activeReviewDecision.reason,
                commands: activeReviewDecision.commands
            });
        }
    }
    if (!reviewLaunchPlan.next_review_type) {
        const completedReviewPhaseDecision = selectProjectedDecisionRoute(
            'active-review',
            'normal',
            null
        );
        if (completedReviewPhaseDecision) {
            throw new Error('Completed review phase must not produce an active-review route.');
        }
    }

    const docImpactCommandPlan = buildDocImpactCommandPlan(
        cliPrefix,
        taskId,
        preflightCommandPath,
        preflight,
        repoRoot,
        effectivePreflightWorkspaceReadiness.acceptedDocsOnlyDeltaFiles || []
    );
    const postReviewLifecycleDecisionRoute = resolvePostReviewLifecycleDecisionRouteFromState({
        repoRoot,
        eventsRoot,
        reviewsRoot,
        taskId,
        cliPrefix,
        preflight,
        preflightPath,
        preflightCommandPath,
        preflightSha256,
        taskMode,
        taskModePath,
        reviewGateAlreadyPassed,
        requiredReviewTypes,
        requiredReviews: summary.required_reviews,
        reviewPolicyMode: reviewPolicy.mode,
        reviewStates,
        closeoutState: {
            requiredReviewsGatePassed: isGatePassed(summary, 'required-reviews-check'),
            zeroDiffNoReviewCloseout: hasZeroDiffNoReviewableScopeSuppression(preflight, requiredReviewTypes),
            docImpactGatePassed: isGatePassed(summary, 'doc-impact-gate'),
            docImpactRequiresProjectMemoryBeforeAssessment:
                docImpactCommandPlan.requiresProjectMemoryBeforeAssessment,
            docImpactCompatibilityHint: buildDocImpactCompatibilityHint(),
            docImpactCommand: docImpactCommandPlan.command,
            fullSuiteEnabled: fullSuiteConfig.enabled,
            fullSuiteGatePassed,
            fullSuiteTimeoutBlockerResolvedByRepairTask: fullSuiteTimeoutBlockerExhausted && fullSuiteTimeoutRepairTaskMaterialized,
            fullSuiteNotRequiredForDocsOnly,
            fullSuitePlacement: fullSuiteConfig.placement,
            fullSuiteConfigPath: fullSuiteSummary.config_path,
            fullSuiteCommandText: fullSuiteConfig.command,
            fullSuiteTimeoutForecastLine,
            fullSuiteCommand,
            projectMemoryRequired: projectMemoryEvidence.required,
            projectMemoryEvidenceCurrent: isProjectMemoryEvidenceCurrentForCloseout({
                eventsRoot,
                taskId,
                docImpactPath,
                evidenceCurrent: projectMemoryEvidence.evidence_status === 'CURRENT',
                timelineSnapshot: closeoutTimelineSnapshot
            }),
            projectMemoryVisibleSummaryLine: projectMemoryEvidence.visible_summary_line,
            projectMemoryAffectedMemoryFiles: projectMemoryEvidence.affected_memory_files,
            projectMemoryViolations: projectMemoryEvidence.violations,
            projectMemoryCommand: buildProjectMemoryImpactCommand(cliPrefix, taskId, preflightCommandPath, projectMemorySummary),
            completionGatePassed: isGatePassed(summary, 'completion-gate'),
            completionCommand: buildCompletionGateCommand(repoRoot, cliPrefix, taskId, preflightCommandPath, taskModePath)
        }
    });
    const postReviewDecision = selectProjectedDecisionRoute(
        'post-review',
        'normal',
        postReviewLifecycleDecisionRoute
    );
    if (!postReviewDecision) {
        throw new Error('Post-review lifecycle decision route is required.');
    }
    return buildResult({
        ...resultBase,
        status: postReviewDecision.status,
        nextGate: postReviewDecision.nextGate,
        title: postReviewDecision.title,
        reason: postReviewDecision.reason,
        commands: postReviewDecision.commands
    });
}

function resolveNextStepWithEffectController(
    options: NextStepOptions,
    effects: NextStepEffectController
): NextStepResult {
    const repoRoot = path.resolve(options.repoRoot || '.');
    const taskId = assertValidTaskId(options.taskId);
    const eventsRoot = resolvePathInsideRepo(
        resolveEventsRoot(repoRoot, options.eventsRoot),
        repoRoot,
        { allowMissing: true }
    );
    if (!eventsRoot) {
        throw new Error('EventsRoot must resolve inside repo root without symlink or junction escape.');
    }
    const reviewsRoot = resolvePathInsideRepo(
        resolveReviewsRoot(repoRoot, options.reviewsRoot),
        repoRoot,
        { allowMissing: true }
    );
    if (!reviewsRoot) {
        throw new Error('ReviewsRoot must resolve inside repo root without symlink or junction escape.');
    }
    return withNextStepCommandWorkspaceReadSnapshot(() => withTaskTimelineReadSnapshot(eventsRoot, taskId, () => (
        withReviewArtifactReadBarrier(reviewsRoot, () => (
            withTaskIndexReadSnapshot(reviewsRoot, taskId, () => {
                const context = createNextStepResolutionContext({
                    ...options,
                    repoRoot,
                    taskId,
                    eventsRoot,
                    reviewsRoot
                });
                return resolveNextStepDecisionRoute(context, effects);
            })
        ))
    )));
}

function inspectNextStepEffects(options: NextStepOptions): {
    result: NextStepResult;
    plan: NextStepEffectPlan | null;
} {
    const effects = createNextStepEffectPlanner();
    const result = resolveNextStepWithEffectController(options, effects);
    return { result, plan: effects.pendingPlan() };
}

export function resolveNextStep(options: NextStepOptions): NextStepResult {
    return inspectNextStepEffects(options).result;
}

export function executeNextStepEffects(
    options: NextStepOptions,
    expectedPlanSha256: string
): NextStepResult {
    const inspected = inspectNextStepEffects(options);
    assertNextStepEffectPlanHash(inspected.plan, expectedPlanSha256);
    const effects = createNextStepEffectExecutor(inspected.plan);
    const result = resolveNextStepWithEffectController(options, effects);
    assertNextStepEffectExecutionComplete(effects, inspected.plan);
    return result;
}

function parseTaskIdFromPreflightPath(preflightPath: string): string | null {
    const basename = path.basename(preflightPath).trim();
    const suffix = '-preflight.json';
    if (!basename.endsWith(suffix)) {
        return null;
    }
    return basename.slice(0, -suffix.length) || null;
}

function pickConsistentTaskId(candidates: Array<{ source: string; value: string | null }>): string {
    const normalized = candidates
        .map((candidate) => ({
            source: candidate.source,
            value: String(candidate.value || '').trim()
        }))
        .filter((candidate) => candidate.value);
    const uniqueValues = [...new Set(normalized.map((candidate) => candidate.value))];
    if (uniqueValues.length > 1) {
        throw new Error(`Conflicting task identifiers for next-step: ${normalized.map((candidate) => `${candidate.source}=${candidate.value}`).join(', ')}.`);
    }
    return uniqueValues[0] || '';
}

export function resolveNextStepFromCliOptions(options: {
    taskId?: unknown;
    repoRoot?: unknown;
    eventsRoot?: unknown;
    reviewsRoot?: unknown;
    preflightPath?: unknown;
    positionals?: unknown;
    executeEffects?: unknown;
    effectPlanSha256?: unknown;
}): NextStepResult {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const positionals = Array.isArray(options.positionals)
        ? options.positionals.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const preflightPathText = String(options.preflightPath || '').trim();
    let resolvedPreflightPath: string | null = null;
    if (preflightPathText) {
        const rejectedPreflightPath = normalizePath(path.resolve(repoRoot, preflightPathText));
        try {
            resolvedPreflightPath = resolvePathInsideRepo(preflightPathText, repoRoot, { allowMissing: true });
        } catch {
            throw new Error(
                `PreflightPath must resolve inside repo root without symlink or junction escape: ${rejectedPreflightPath}. ` +
                'The derived ReviewsRoot must resolve inside repo root without symlink or junction escape.'
            );
        }
    }
    const taskId = pickConsistentTaskId([
        { source: '--task-id', value: String(options.taskId || '').trim() || null },
        { source: 'positional', value: positionals[0] || null },
        { source: '--preflight-path', value: resolvedPreflightPath ? parseTaskIdFromPreflightPath(resolvedPreflightPath) : null }
    ]);
    let reviewsRoot: string | null = resolvedPreflightPath ? path.dirname(resolvedPreflightPath) : null;
    if (options.reviewsRoot) {
        const requestedReviewsRoot = String(options.reviewsRoot).trim();
        const rejectedReviewsRoot = normalizePath(path.resolve(repoRoot, requestedReviewsRoot));
        try {
            reviewsRoot = resolvePathInsideRepo(requestedReviewsRoot, repoRoot, { allowMissing: true });
        } catch {
            throw new Error(
                `ReviewsRoot must resolve inside repo root without symlink or junction escape: ${rejectedReviewsRoot}`
            );
        }
    }
    const eventsRoot = options.eventsRoot
        ? resolvePathInsideRepo(String(options.eventsRoot), repoRoot, { allowMissing: true })
        : null;
    const nextStepOptions = {
        taskId,
        repoRoot,
        eventsRoot,
        reviewsRoot
    };
    const executeEffects = options.executeEffects === true;
    const effectPlanSha256 = String(options.effectPlanSha256 || '').trim();
    if (executeEffects) {
        return executeNextStepEffects(nextStepOptions, effectPlanSha256);
    }
    if (effectPlanSha256) {
        throw new Error('--effect-plan-sha256 requires --execute-effects.');
    }
    return resolveNextStep(nextStepOptions);
}
