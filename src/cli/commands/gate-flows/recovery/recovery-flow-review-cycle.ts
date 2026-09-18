import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import { getReviewExecutionPreparationBatches, resolveReviewExecutionPolicyModeFromPreflight } from '../../../../core/review-execution-policy';
import { resolveCompiledReviewDependencyGraphFromPreflight } from '../../../../core/review-dependency-graph';
import { type TokenEconomyConfig } from '../../../../gates/review-context/review-context-token-economy';
import { resolveTaskProfileReviewTriggerPolicy } from '../../../../policy/task-profile-policy-snapshot';
import {
    collectReviewRemediationProtectedBoundarySignals,
    hasReviewRemediationPolicySourceChange,
    resolveReviewRemediationModePolicyFromSnapshot
} from '../../../../policy/review-remediation-mode-policy';
import { buildScopedDiff, resolveMetadataPath as resolveScopedDiffMetadataPath, resolveOutputPath as resolveScopedDiffOutputPath } from '../../../../gates/preflight/build-scoped-diff';
import { getPreflightContext, getWorkspaceSnapshot } from '../../../../gates/compile/compile-gate';
import {
    assessExplicitIgnoredRemediationTargets,
    readTaskReviewArtifactTexts,
    type IgnoredRemediationTargetAssessment
} from '../../../../gates/review-remediation/ignored-remediation-targets';
import {
    getReviewRemediationBaselineArtifactPath
} from '../../../../gates/review-remediation/review-remediation-baseline';
import {
    classifyReviewRemediationDelta
} from '../../../../gates/review-remediation/review-remediation-delta';
import { inspectTaskEventFile } from '../../../../gate-runtime/task-events';
import {
    resolveAuthoritativeReviewRemediationDecision,
    type AuthoritativeReviewRemediationDecision,
    type ReviewRemediationDecisionClassification,
    type ReviewRemediationModePolicyValidationInputs,
    type ReviewRemediationReusableReceipt
} from '../../../../gates/review-remediation/review-remediation-recovery-routing';
import { buildReviewContextPreflightDiffExpectations } from '../../../../gates/review-context/review-context-contract';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    type CompileGateCommandOptions
} from '../compile/compile-flow';
import { buildNextStepRecoveryCommand } from '../compile/compile-flow-shared-evidence';
import { resolveDefaultReviewsPath } from '../../../gate-cli/gates-artifacts';
import {
    resolveOrchestratorRoot
} from '../compile/gate-flow-helpers';
import {
    runBuildReviewContextCommand,
    readTimelineEventsSummary,
    type BuildReviewContextCommandResult
} from '../../gate-build-handlers';
import {
    bindAuthoritativeRemediationDecisionToPreflight,
    buildAuthenticatedRemediationReviewExecution
} from '../review-context/review-context-flow';
import {
    runHandshakeDiagnosticsCommand,
    runLoadRulePackCommand,
    runShellSmokePreflightCommand
} from '../task-mode/task-mode-flow';
import { resolveGateExecutionPath } from '../../../../gates/isolation/isolation-sandbox';
import { resolveRuntimeReviewerIdentity } from '../../../../gates/review/reviewer-routing';
import {
    assessReviewRemediationScopeBoundary,
    classifyReviewRemediationFix,
    getTaskManualValidationBoundaryFiles,
    REMEDIATION_IMPACT_ANALYSIS_TOPICS,
    resolveCurrentRemediationChangedFiles,
    resolveReviewRemediationClassifyChangedFiles,
    resolveReviewRemediationImpactAnalysis,
    writeReviewRemediationCycleArtifact
} from './recovery-flow-remediation';
import {
    getEffectiveDepthFromPreflight,
    getReviewCyclePrePreflightRefreshPlan,
    normalizeRuleFileList,
    resolveReviewCycleReplayScope
} from './recovery-flow-replay-scope';
import { buildReviewCycleRestartedOutput } from './recovery-flow-rendering';
import {
    excludeUnchangedDirtyWorkspaceBaselineFiles,
    normalizeChangedFiles
} from './recovery-flow-shared';
import type {
    RestartReviewCycleCommandOptions,
    ReviewRemediationImpactAnalysis
} from './recovery-flow-types';
import {
    buildOptionalSkillRebindDetails,
    readRestartOptionalSkillActivationSnapshot,
    readRestartOptionalSkillDeclineSnapshot,
    rebindRestartOptionalSkillActivationsForCurrentCycle,
    rebindRestartOptionalSkillDeclinesForCurrentCycle
} from './recovery-flow-optional-skills';
import {
    appendRestartCompletedEvidence,
    collectRequiredRestartReviewTypes as collectRequiredReviewTypes,
    ensureRestartStepPassed as ensureStepPassed,
    requireRestartArtifactSha256 as requireArtifactSha256,
    resolveRecoveryPreflightPath
} from './recovery-flow-restart-evidence';
import { runRecoveryFlowPreflightPipeline } from './recovery-flow-preflight-pipeline';
function getDependencyBlockReason(error: unknown, reviewType: string): string | null {
    const message = error instanceof Error ? error.message : String(error);
    const isUpstreamReviewBlock = message.includes(
        `ReviewType '${reviewType}' is blocked until upstream reviews pass for the current cycle:`
    );
    const isTrustBoundaryPrerequisiteBlock = message.includes(
        'Review context cannot be built because required trust-boundary analysis is'
    );
    if (!isUpstreamReviewBlock && !isTrustBoundaryPrerequisiteBlock) {
        return null;
    }
    return message.trim();
}

export function resolveRuntimeReviewRemediationModeGuards(options: {
    currentChangedFiles: readonly string[];
    preflightPayload?: unknown;
    authenticatedTaskCriteria?: string | null;
    currentTaskCriteria?: string | null;
}) {
    const protectedBoundarySignals = collectReviewRemediationProtectedBoundarySignals({
        changedFiles: options.currentChangedFiles,
        preflight: options.preflightPayload
    });
    const criteriaComparisonRequested = options.authenticatedTaskCriteria !== undefined
        || options.currentTaskCriteria !== undefined;
    const authenticatedTaskCriteria = String(options.authenticatedTaskCriteria || '').trim();
    const currentTaskCriteria = String(options.currentTaskCriteria || '').trim();
    const criteriaBindingChanged = criteriaComparisonRequested
        && (
            !authenticatedTaskCriteria
            || !currentTaskCriteria
            || authenticatedTaskCriteria !== currentTaskCriteria
        );
    return {
        protectedBoundarySignals,
        taskCriteriaChanged:
            protectedBoundarySignals.includes('task_criteria_or_policy') || criteriaBindingChanged,
        policyChanged: hasReviewRemediationPolicySourceChange(options.currentChangedFiles)
    };
}

export function resolveRuntimeDecisionInputs(options: {
    repoRoot: string;
    taskId: string;
    remediationReviewType: string;
    requiredReviewTypes: readonly string[];
    remediationFixClassification: {
        category: string;
        reason: string;
        blocked_before_reuse: boolean;
        invalidated_review_types: string[];
    };
    profilePolicySnapshot: unknown;
    currentChangedFiles: readonly string[];
    reviewTriggerPolicy: {
        test_path_regexes: readonly string[];
        test_refactor_structural_path_regexes: readonly string[];
        test_refactor_changed_lines_threshold: number;
    };
    allowAuthenticatedDelta: boolean;
    preflightPayload?: unknown;
    authenticatedTaskCriteria?: string | null;
    currentTaskCriteria?: string | null;
}): {
    currentReviewType: string;
    classification: ReviewRemediationDecisionClassification;
    modePolicyValidationInputs: ReviewRemediationModePolicyValidationInputs | null;
} {
    const currentReviewType = options.remediationReviewType
        || options.remediationFixClassification.invalidated_review_types[0]
        || options.requiredReviewTypes[0]
        || '';
    if (!currentReviewType) {
        throw new Error('Review remediation decision requires at least one current required review lane.');
    }
    const buildFullFallback = (reason: string): {
        currentReviewType: string;
        classification: ReviewRemediationDecisionClassification;
        modePolicyValidationInputs: null;
    } => {
        const invalidatedReviewTypes = [...new Set([
            ...options.remediationFixClassification.invalidated_review_types,
            currentReviewType
        ])];
        return {
            currentReviewType,
            modePolicyValidationInputs: null,
            classification: {
                source: 'runtime_fix',
                classification: {
                    category: options.remediationFixClassification.category,
                    reason,
                    blocked_before_reuse: options.remediationFixClassification.blocked_before_reuse,
                    invalidated_review_types: invalidatedReviewTypes
                }
            }
        };
    };
    if (options.allowAuthenticatedDelta && options.remediationReviewType) {
        const reviewArtifactPath = resolveDefaultReviewsPath(
            options.repoRoot,
            `${options.taskId}-${currentReviewType}.md`
        );
        const baselineArtifactPath = getReviewRemediationBaselineArtifactPath(reviewArtifactPath);
        if (!fs.existsSync(baselineArtifactPath) || !fs.statSync(baselineArtifactPath).isFile()) {
            return buildFullFallback('Authenticated remediation baseline is unavailable; FULL review is required.');
        }
        const orchestratorRoot = resolveOrchestratorRoot(options.repoRoot);
        const timelinePath = path.join(orchestratorRoot, 'runtime', 'task-events', `${options.taskId}.jsonl`);
        const recordedEvent = { details: null as Record<string, unknown> | null };
        let consecutiveDeltaReviews = 0;
        const timelineIntegrity = inspectTaskEventFile(timelinePath, options.taskId, {
            onIntegrityEvent: (event) => {
                const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                    ? event.details as Record<string, unknown>
                    : null;
                if (
                    String(event.event_type || '').trim().toUpperCase() === 'REVIEW_RECORDED'
                    && String(event.outcome || '').trim().toUpperCase() === 'PASS'
                    && String(details?.review_type || '').trim().toLowerCase() === currentReviewType
                ) {
                    recordedEvent.details = details;
                    const recordedMode = String(details?.review_execution_mode || '').trim().toUpperCase();
                    consecutiveDeltaReviews = recordedMode === 'DELTA'
                        ? consecutiveDeltaReviews + 1
                        : 0;
                }
            }
        });
        if (timelineIntegrity.status !== 'PASS') {
            return buildFullFallback(
                `Task timeline cannot authenticate remediation snapshot lineage (${timelineIntegrity.status}); FULL review is required.`
            );
        }
        const recordedEventDetails = recordedEvent.details;
        if (!recordedEventDetails) {
            return buildFullFallback(
                'Review telemetry does not bind an immutable remediation snapshot; FULL review is required.'
            );
        }
        const recordedReviewExecutionMode = String(
            recordedEventDetails.review_execution_mode || ''
        ).trim().toUpperCase();
        if (!['FULL', 'DELTA'].includes(recordedReviewExecutionMode)) {
            return buildFullFallback(
                `Review telemetry contains unsupported review execution mode `
                + `'${recordedReviewExecutionMode || 'missing'}'; FULL review is required.`
            );
        }
        if (
            !String(recordedEventDetails.remediation_baseline_snapshot_path || '').trim()
            || !String(recordedEventDetails.remediation_baseline_snapshot_sha256 || '').trim()
        ) {
            return buildFullFallback(
                'Latest authenticated review telemetry does not bind an immutable remediation snapshot; '
                + 'FULL review is required.'
            );
        }
        const baselineSnapshotPath = path.resolve(
            options.repoRoot,
            String(recordedEventDetails.remediation_baseline_snapshot_path)
        );
        const baselineSnapshotSha256 = String(
            recordedEventDetails.remediation_baseline_snapshot_sha256 || ''
        ).trim().toLowerCase();
        const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
        const expectedFileName = (
            `${options.taskId}-${currentReviewType}-remediation-baseline-${baselineSnapshotSha256}.json`
        ).toLowerCase();
        if (
            !/^[0-9a-f]{64}$/u.test(baselineSnapshotSha256)
            || !gateHelpers.isPathRealpathInsideRoot(baselineSnapshotPath, reviewsRoot, { allowMissing: false })
            || path.basename(baselineSnapshotPath).toLowerCase() !== expectedFileName
        ) {
            return buildFullFallback(
                'Review telemetry contains an unsafe or invalid remediation snapshot binding; FULL review is required.'
            );
        }
        try {
            const modePolicyResolution = resolveReviewRemediationModePolicyFromSnapshot(
                options.profilePolicySnapshot
            );
            const modeGuards = resolveRuntimeReviewRemediationModeGuards(options);
            const delta = classifyReviewRemediationDelta({
                repoRoot: options.repoRoot,
                taskId: options.taskId,
                reviewType: currentReviewType,
                baselineArtifactPath: baselineSnapshotPath,
                baselineArtifactSha256: baselineSnapshotSha256,
                currentChangedFiles: options.currentChangedFiles,
                testPathRegexes: options.reviewTriggerPolicy.test_path_regexes,
                structuralTestPathRegexes: options.reviewTriggerPolicy.test_refactor_structural_path_regexes,
                structuralTestChangedLinesThreshold:
                    options.reviewTriggerPolicy.test_refactor_changed_lines_threshold,
                modePolicy: modePolicyResolution.policy,
                modePolicyLegacyFallback: modePolicyResolution.legacy_fallback,
                consecutiveDeltaReviews,
                protectedBoundarySignals: modeGuards.protectedBoundarySignals,
                taskCriteriaChanged: modeGuards.taskCriteriaChanged,
                policyChanged: modeGuards.policyChanged,
                uncertainCrossFileImpact:
                    options.remediationFixClassification.category === 'unknown'
            });
            const baseline = JSON.parse(fs.readFileSync(baselineSnapshotPath, 'utf8')) as Record<string, unknown>;
            const bindings = baseline.bindings as Record<string, unknown> | undefined;
            const policy = bindings?.policy as Record<string, unknown> | undefined;
            return {
                currentReviewType,
                modePolicyValidationInputs: {
                    consecutiveDeltaReviews,
                    protectedBoundarySignals: modeGuards.protectedBoundarySignals,
                    taskCriteriaChanged: modeGuards.taskCriteriaChanged,
                    policyChanged: modeGuards.policyChanged,
                    uncertainCrossFileImpact:
                        options.remediationFixClassification.category === 'unknown'
                },
                classification: {
                    source: 'delta',
                    delta,
                    profilePolicySnapshot: options.profilePolicySnapshot,
                    baselineProfilePolicySnapshotSha256: String(
                        policy?.profile_policy_snapshot_sha256 || ''
                    ).trim().toLowerCase()
                }
            };
        } catch (error: unknown) {
            return buildFullFallback(
                `Authenticated remediation snapshot could not be validated: ${error instanceof Error ? error.message : String(error)} FULL review is required.`
            );
        }
    }
    return {
        currentReviewType,
        modePolicyValidationInputs: null,
        classification: {
            source: 'runtime_fix',
            classification: {
                category: options.remediationFixClassification.category,
                reason: options.remediationFixClassification.reason,
                blocked_before_reuse: options.remediationFixClassification.blocked_before_reuse,
                invalidated_review_types: options.remediationFixClassification.invalidated_review_types
            }
        }
    };
}

function requireReadyAuthoritativeDecision(
    decision: AuthoritativeReviewRemediationDecision
): AuthoritativeReviewRemediationDecision {
    if (decision.status === 'BLOCKED') {
        throw new Error(
            `Review remediation authoritative decision is blocked: ${decision.blocked_reasons.join(' ')}`
        );
    }
    return decision;
}

export function buildReviewEvidenceOnlyRestartPlan(
    invalidatedReviewTypes: readonly string[],
    remediationReviewType: string
): {
    launchRequiredReviewTypes: string[];
    pendingReviewTypes: string[];
    pendingReason: string;
    nextStep: string;
} {
    const normalizedInvalidatedReviewTypes = [...new Set(invalidatedReviewTypes
        .map((reviewType) => String(reviewType || '').trim().toLowerCase())
        .filter(Boolean))];
    const restartReviewTypes = normalizedInvalidatedReviewTypes.length > 0
        ? normalizedInvalidatedReviewTypes
        : [String(remediationReviewType || '').trim().toLowerCase()].filter(Boolean);
    const reviewLaneSummary = restartReviewTypes.join(', ');
    return {
        launchRequiredReviewTypes: [...restartReviewTypes],
        pendingReviewTypes: [...restartReviewTypes],
        pendingReason: 'failed delegated reviewer evidence invalidated the failed lane and every frozen-graph downstream lane',
        nextStep: restartReviewTypes.length === 1
            ? `Rerun next-step to materialize preserved review evidence and prepare one fresh '${reviewLaneSummary}' reviewer launch.`
            : `Rerun next-step to materialize preserved review evidence and prepare fresh reviewer launches for invalidated lanes: ${reviewLaneSummary}.`
    };
}

export async function runRestartReviewCycleCommand(
    options: RestartReviewCycleCommandOptions
): Promise<{ outputLines: string[]; exitCode: number }> {
    const startedAt = Date.now();
    const {
        repoRoot,
        resolvedTaskId,
        previousTaskMode,
        resolvedTaskModePath,
        resolvedPreflightPath,
        previousPreflight
    } = runRecoveryFlowPreflightPipeline(options);
    const reviewEvidenceOnly = options.reviewEvidenceOnly === true;
    const remediationReviewType = String(options.reviewType || '').trim().toLowerCase();
    const replayScope = resolveReviewCycleReplayScope(options, previousPreflight, previousTaskMode);
    const previousChangedFiles = normalizeChangedFiles(previousPreflight.changed_files as unknown[]);
    let currentRemediationChangedFiles = reviewEvidenceOnly
        ? []
        : resolveCurrentRemediationChangedFiles(repoRoot, replayScope, previousTaskMode.dirty_workspace_baseline);
    const taskModeArtifactRelativePath = resolvedTaskModePath
        ? gateHelpers.normalizePath(path.relative(repoRoot, path.resolve(resolvedTaskModePath)))
        : '';
    const taskModeIndexRelativePath = taskModeArtifactRelativePath
        ? gateHelpers.normalizePath(path.join(path.dirname(taskModeArtifactRelativePath), 'reviews-index.json'))
        : '';
    const baseAllowedBoundaryFiles = [
        ...(previousTaskMode.dirty_workspace_baseline?.changed_files || []),
        taskModeArtifactRelativePath,
        taskModeIndexRelativePath,
        ...getTaskManualValidationBoundaryFiles(resolvedTaskId, currentRemediationChangedFiles)
    ].filter(Boolean);
    if (!previousTaskMode.profile_policy_snapshot) {
        throw new Error('Review-cycle recovery requires the authenticated task profile policy snapshot.');
    }
    const reviewTriggerPolicy = resolveTaskProfileReviewTriggerPolicy(previousTaskMode.profile_policy_snapshot);
    let ignoredRemediationTargetAssessment: IgnoredRemediationTargetAssessment = {
        targets: [],
        allowedBoundaryFiles: [],
        violations: []
    };
    let scopeBoundary = assessReviewRemediationScopeBoundary(
        previousChangedFiles,
        currentRemediationChangedFiles,
        baseAllowedBoundaryFiles,
        reviewTriggerPolicy.test_path_regexes
    );
    let remediationFixClassification = classifyReviewRemediationFix(
        scopeBoundary,
        [],
        undefined,
        reviewTriggerPolicy.test_path_regexes,
        undefined,
        {
            testRefactorChangedLinesThreshold: reviewTriggerPolicy.test_refactor_changed_lines_threshold,
            testRefactorStructuralPathRegexes: reviewTriggerPolicy.test_refactor_structural_path_regexes
        }
    );
    let remediationImpactAnalysis: ReviewRemediationImpactAnalysis;
    const taskSummary = String(options.taskIntent || previousTaskMode.task_summary || '').trim();
    if (!taskSummary) {
        throw new Error('Task intent could not be resolved for review-cycle restart.');
    }
    try {
        const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
        const optionalSkillActivationSnapshot = readRestartOptionalSkillActivationSnapshot(
            orchestratorRoot,
            resolvedTaskId
        );
        const optionalSkillDeclineSnapshot = readRestartOptionalSkillDeclineSnapshot(
            orchestratorRoot,
            resolvedTaskId
        );
        const refreshedPreflightPath = resolveRecoveryPreflightPath(
            repoRoot,
            resolvedTaskId,
            options.preflightOutputPath || resolvedPreflightPath,
            'PreflightOutputPath'
        );
        const prePreflightRefreshPlan = getReviewCyclePrePreflightRefreshPlan(repoRoot, resolvedTaskId);
        try {
            remediationImpactAnalysis = resolveReviewRemediationImpactAnalysis(
                repoRoot,
                options,
                scopeBoundary.currentChangedFiles
            );
        } catch (error: unknown) {
            const artifactPath = writeReviewRemediationCycleArtifact(repoRoot, resolvedTaskId, {
                schema_version: 1,
                task_id: resolvedTaskId,
                status: 'BLOCKED',
                reason: 'missing_or_incomplete_remediation_impact_analysis',
                previous_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                previous_preflight_sha256: fs.existsSync(resolvedPreflightPath)
                    ? gateHelpers.fileSha256(resolvedPreflightPath)
                    : null,
                detection_source: replayScope.detectionSource,
                impact_analysis: {
                    status: 'BLOCKED',
                    reason: error instanceof Error ? error.message : String(error),
                    required_topics: [...REMEDIATION_IMPACT_ANALYSIS_TOPICS],
                    affected_files: scopeBoundary.currentChangedFiles
                },
                remediation_fix_classification: remediationFixClassification,
                remediation_scope: {
                    status: scopeBoundary.status,
                    previous_changed_files: scopeBoundary.previousChangedFiles,
                    current_changed_files: scopeBoundary.currentChangedFiles,
                    expanded_files: scopeBoundary.expandedFiles,
                    expanded_non_test_files: scopeBoundary.expandedNonTestFiles,
                    allowed_test_only_expansion_files: scopeBoundary.allowedTestOnlyExpansionFiles
                },
                refresh_points: {
                    preflight: 'not_run_impact_analysis_blocked',
                    post_preflight_rule_pack: 'not_run_impact_analysis_blocked',
                    compile: 'not_run_impact_analysis_blocked',
                    review_contexts: 'not_run_impact_analysis_blocked'
                },
                reuse_boundaries: {
                    non_test_changes_must_stay_within_previous_preflight_scope: true,
                    test_only_expansion_allowed: true,
                    expanded_non_test_files_block_reuse: true
                }
            });
            throw new Error(
                `${error instanceof Error ? error.message : String(error)} ` +
                `Artifact: ${gateHelpers.normalizePath(artifactPath)}.`
            );
        }

        ignoredRemediationTargetAssessment = assessExplicitIgnoredRemediationTargets({
            repoRoot,
            taskId: resolvedTaskId,
            currentChangedFiles: scopeBoundary.currentChangedFiles,
            explicitChangedFiles: replayScope.changedFiles ?? [],
            guardedTargets: remediationImpactAnalysis.ignored_remediation_targets ?? [],
            impactAnalysisSummary: remediationImpactAnalysis.summary,
            reviewEvidenceTexts: readTaskReviewArtifactTexts(repoRoot, resolvedTaskId),
            taskMode: previousTaskMode as unknown as Record<string, unknown>
        });
        if (ignoredRemediationTargetAssessment.violations.length > 0) {
            const artifactPath = writeReviewRemediationCycleArtifact(repoRoot, resolvedTaskId, {
                schema_version: 1,
                task_id: resolvedTaskId,
                status: 'BLOCKED',
                reason: 'ignored_remediation_target_invalid',
                previous_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                previous_preflight_sha256: fs.existsSync(resolvedPreflightPath)
                    ? gateHelpers.fileSha256(resolvedPreflightPath)
                    : null,
                detection_source: replayScope.detectionSource,
                impact_analysis: remediationImpactAnalysis,
                ignored_remediation_targets: {
                    status: 'BLOCKED',
                    targets: ignoredRemediationTargetAssessment.targets,
                    violations: ignoredRemediationTargetAssessment.violations
                },
                remediation_fix_classification: remediationFixClassification,
                remediation_scope: {
                    status: scopeBoundary.status,
                    previous_changed_files: scopeBoundary.previousChangedFiles,
                    current_changed_files: scopeBoundary.currentChangedFiles,
                    expanded_files: scopeBoundary.expandedFiles,
                    expanded_non_test_files: scopeBoundary.expandedNonTestFiles,
                    allowed_test_only_expansion_files: scopeBoundary.allowedTestOnlyExpansionFiles
                },
                refresh_points: {
                    preflight: 'not_run_ignored_remediation_target_blocked',
                    post_preflight_rule_pack: 'not_run_ignored_remediation_target_blocked',
                    compile: 'not_run_ignored_remediation_target_blocked',
                    review_contexts: 'not_run_ignored_remediation_target_blocked'
                },
                reuse_boundaries: {
                    non_test_changes_must_stay_within_previous_preflight_scope: true,
                    test_only_expansion_allowed: true,
                    explicit_ignored_remediation_targets_require_hash_and_review_relevance: true,
                    expanded_non_test_files_block_reuse: true
                }
            });
            throw new Error(
                `restart-review-cycle blocked ignored remediation target evidence: ` +
                `${ignoredRemediationTargetAssessment.violations.join('; ')}. ` +
                `Artifact: ${gateHelpers.normalizePath(artifactPath)}.`
            );
        }
        currentRemediationChangedFiles = normalizeChangedFiles([
            ...currentRemediationChangedFiles,
            ...ignoredRemediationTargetAssessment.allowedBoundaryFiles
        ]);
        scopeBoundary = assessReviewRemediationScopeBoundary(
            previousChangedFiles,
            currentRemediationChangedFiles,
            [
                ...baseAllowedBoundaryFiles,
                ...ignoredRemediationTargetAssessment.allowedBoundaryFiles
            ],
            reviewTriggerPolicy.test_path_regexes
        );
        remediationImpactAnalysis = {
            ...remediationImpactAnalysis,
            affected_files: normalizeChangedFiles(scopeBoundary.currentChangedFiles)
        };
        remediationFixClassification = classifyReviewRemediationFix(
            scopeBoundary,
            [],
            remediationImpactAnalysis,
            reviewTriggerPolicy.test_path_regexes,
            undefined,
            {
                testRefactorChangedLinesThreshold: reviewTriggerPolicy.test_refactor_changed_lines_threshold,
                testRefactorStructuralPathRegexes: reviewTriggerPolicy.test_refactor_structural_path_regexes
            }
        );

        if (scopeBoundary.status === 'BLOCKED') {
            const artifactPath = writeReviewRemediationCycleArtifact(repoRoot, resolvedTaskId, {
                schema_version: 1,
                task_id: resolvedTaskId,
                status: 'BLOCKED',
                reason: 'failed_review_remediation_scope_expanded',
                previous_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                previous_preflight_sha256: fs.existsSync(resolvedPreflightPath)
                    ? gateHelpers.fileSha256(resolvedPreflightPath)
                    : null,
                detection_source: replayScope.detectionSource,
                impact_analysis: remediationImpactAnalysis,
                remediation_fix_classification: remediationFixClassification,
                remediation_scope: {
                    status: scopeBoundary.status,
                    previous_changed_files: scopeBoundary.previousChangedFiles,
                    current_changed_files: scopeBoundary.currentChangedFiles,
                    expanded_files: scopeBoundary.expandedFiles,
                    expanded_non_test_files: scopeBoundary.expandedNonTestFiles,
                    allowed_test_only_expansion_files: scopeBoundary.allowedTestOnlyExpansionFiles
                },
                refresh_points: {
                    preflight: 'not_run_scope_blocked',
                    post_preflight_rule_pack: 'not_run_scope_blocked',
                    compile: 'not_run_scope_blocked',
                    review_contexts: 'not_run_scope_blocked'
                },
                reuse_boundaries: {
                    non_test_changes_must_stay_within_previous_preflight_scope: true,
                    test_only_expansion_allowed: true,
                    expanded_non_test_files_block_reuse: true
                }
            });
            throw new Error(
                `restart-review-cycle blocked failed-review remediation because non-test files outside the failed review scope changed: ` +
                `${scopeBoundary.expandedNonTestFiles.join(', ')}. ` +
                `Artifact: ${gateHelpers.normalizePath(artifactPath)}. ` +
                'Refresh the normal preflight/classification path or split the expanded work into a separate task.'
            );
        }

        if (reviewEvidenceOnly) {
            if (!remediationReviewType) {
                throw new Error('review-evidence-only restart requires --review-type.');
            }
            const requiredReviews = previousPreflight.preflight.required_reviews as Record<string, boolean>;
            const requiredReviewTypes = collectRequiredReviewTypes(requiredReviews);
            const reviewExecutionPolicyMode = resolveReviewExecutionPolicyModeFromPreflight(previousPreflight.preflight);
            const reviewDependencyGraph = resolveCompiledReviewDependencyGraphFromPreflight(
                previousPreflight.preflight,
                reviewExecutionPolicyMode
            );
            if (!requiredReviewTypes.includes(remediationReviewType)) {
                throw new Error(
                    `review-evidence-only restart review type '${remediationReviewType}' is not required by the current preflight.`
                );
            }
            const compileEvidencePath = resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`);
            if (!fs.existsSync(compileEvidencePath) || !fs.statSync(compileEvidencePath).isFile()) {
                throw new Error('review-evidence-only restart requires current compile-gate evidence.');
            }
            const compileEvidence = JSON.parse(fs.readFileSync(compileEvidencePath, 'utf8')) as Record<string, unknown>;
            const currentPreflightSha256 = gateHelpers.fileSha256(resolvedPreflightPath);
            if (
                String(compileEvidence.status || '').trim() !== 'PASSED'
                || String(compileEvidence.task_id || '').trim() !== resolvedTaskId
                || String(compileEvidence.preflight_hash_sha256 || '').trim().toLowerCase() !== currentPreflightSha256
            ) {
                throw new Error(
                    'review-evidence-only restart requires PASSED compile evidence bound to the current task and preflight.'
                );
            }
            const liveWorkspaceSnapshot = getWorkspaceSnapshot(
                repoRoot,
                'git_auto',
                true,
                []
            ) as Record<string, unknown>;
            const liveChangedFiles = excludeUnchangedDirtyWorkspaceBaselineFiles(
                repoRoot,
                liveWorkspaceSnapshot.changed_files as unknown[],
                previousTaskMode.dirty_workspace_baseline
            );
            const expectedChangedFiles = excludeUnchangedDirtyWorkspaceBaselineFiles(
                repoRoot,
                previousChangedFiles,
                previousTaskMode.dirty_workspace_baseline
            );
            if (
                liveChangedFiles.length !== expectedChangedFiles.length
                || liveChangedFiles.some((entry, index) => entry !== expectedChangedFiles[index])
            ) {
                throw new Error(
                    'review-evidence-only restart is blocked because the live workspace file scope changed after compile.'
                );
            }
            const scopedWorkspaceSnapshot = getWorkspaceSnapshot(
                repoRoot,
                'explicit_changed_files',
                previousPreflight.include_untracked,
                previousChangedFiles
            ) as Record<string, unknown>;
            if (
                String(scopedWorkspaceSnapshot.scope_content_sha256 || '').trim().toLowerCase()
                !== String(compileEvidence.scope_content_sha256 || '').trim().toLowerCase()
            ) {
                throw new Error(
                    'review-evidence-only restart is blocked because task-scoped content changed after compile.'
                );
            }

            remediationFixClassification = classifyReviewRemediationFix(
                scopeBoundary,
                requiredReviewTypes,
                remediationImpactAnalysis,
                reviewTriggerPolicy.test_path_regexes,
                previousPreflight.preflight,
                {
                    testRefactorChangedLinesThreshold: reviewTriggerPolicy.test_refactor_changed_lines_threshold,
                    testRefactorStructuralPathRegexes: reviewTriggerPolicy.test_refactor_structural_path_regexes,
                    reviewEvidenceOnly: true,
                    remediationReviewType,
                    reviewDependencyGraph
                }
            );
            const evidenceOnlyDecisionInputs = resolveRuntimeDecisionInputs({
                repoRoot,
                taskId: resolvedTaskId,
                remediationReviewType,
                requiredReviewTypes,
                remediationFixClassification,
                profilePolicySnapshot: previousTaskMode.profile_policy_snapshot,
                currentChangedFiles: [],
                reviewTriggerPolicy,
                allowAuthenticatedDelta: false
            });
            const authoritativeDecision = bindAuthoritativeRemediationDecisionToPreflight(
                requireReadyAuthoritativeDecision(resolveAuthoritativeReviewRemediationDecision({
                    taskId: resolvedTaskId,
                    currentReviewType: evidenceOnlyDecisionInputs.currentReviewType,
                    classification: evidenceOnlyDecisionInputs.classification,
                    modePolicyValidationInputs: evidenceOnlyDecisionInputs.modePolicyValidationInputs,
                    requiredReviews,
                    reviewExecutionPolicyMode,
                    reviewDependencyGraph
                })),
                currentPreflightSha256
            );
            const effectiveDepth = getEffectiveDepthFromPreflight(previousTaskMode, previousPreflight);
            const evidenceOnlyRestartPlan = buildReviewEvidenceOnlyRestartPlan(
                authoritativeDecision.invalidated_review_types,
                remediationReviewType
            );
            const nextStep = evidenceOnlyRestartPlan.nextStep;
            const remediationArtifactPath = writeReviewRemediationCycleArtifact(repoRoot, resolvedTaskId, {
                schema_version: 1,
                task_id: resolvedTaskId,
                status: 'PASSED',
                previous_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                previous_preflight_sha256: currentPreflightSha256,
                refreshed_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                refreshed_preflight_sha256: currentPreflightSha256,
                detection_source: 'review_evidence_only',
                impact_analysis: remediationImpactAnalysis,
                remediation_fix_classification: remediationFixClassification,
                authoritative_review_decision: authoritativeDecision,
                authoritative_review_classification: evidenceOnlyDecisionInputs.classification,
                remediation_scope: {
                    status: scopeBoundary.status,
                    previous_changed_files: scopeBoundary.previousChangedFiles,
                    current_changed_files: [],
                    expanded_files: [],
                    expanded_non_test_files: [],
                    allowed_test_only_expansion_files: []
                },
                refresh_points: {
                    preflight: 'reused_current',
                    post_preflight_rule_pack: 'reused_current',
                    compile: 'reused_current',
                    review_contexts: 'deferred_to_navigator'
                },
                review_reuse: {
                    review_execution_policy: reviewExecutionPolicyMode,
                    prepared_review_types: [],
                    launch_required_review_types: evidenceOnlyRestartPlan.launchRequiredReviewTypes,
                    reused_review_types: authoritativeDecision.reused_review_types,
                    pending_review_types: evidenceOnlyRestartPlan.pendingReviewTypes,
                    pending_reason: evidenceOnlyRestartPlan.pendingReason
                }
            });
            const restartArtifactPath = appendRestartCompletedEvidence({
                repoRoot,
                taskId: resolvedTaskId,
                eventType: 'REVIEW_CYCLE_RESTARTED',
                artifactSuffix: '-review-cycle-restart.json',
                message: 'Delegated reviewer evidence-only cycle restarted without source or compile replay.',
                taskModePath: resolvedTaskModePath,
                preflightPath: resolvedPreflightPath,
                compileEvidencePath,
                detectionSource: 'review_evidence_only',
                plannedChangedFilesCount: previousChangedFiles.length,
                detectedChangedFilesCount: 0,
                elapsedMs: Date.now() - startedAt,
                restartReason: 'failed_delegated_reviewer_evidence_only',
                nextStepSummary: nextStep,
                extraDetails: {
                    remediation_artifact_path: gateHelpers.normalizePath(remediationArtifactPath),
                    remediation_artifact_sha256: requireArtifactSha256(remediationArtifactPath, 'review-remediation-cycle'),
                    impact_analysis_source: remediationImpactAnalysis.source,
                    affected_files_count: 0,
                    remediation_category: remediationFixClassification.category,
                    invalidated_review_types: authoritativeDecision.invalidated_review_types,
                    preserved_review_types: authoritativeDecision.preserved_review_types,
                    authoritative_review_decision: authoritativeDecision,
                    authoritative_review_classification: evidenceOnlyDecisionInputs.classification,
                    review_contexts_refresh_status: 'deferred_to_navigator',
                    review_execution_policy_mode: reviewExecutionPolicyMode,
                    prepared_review_types: [],
                    launch_required_review_types: evidenceOnlyRestartPlan.launchRequiredReviewTypes,
                    reused_review_types: authoritativeDecision.reused_review_types,
                    pending_review_types: evidenceOnlyRestartPlan.pendingReviewTypes,
                    pending_reason: evidenceOnlyRestartPlan.pendingReason
                }
            });
            return {
                outputLines: buildReviewCycleRestartedOutput({
                    taskId: resolvedTaskId,
                    navigatorCommand: buildNextStepRecoveryCommand(repoRoot, resolvedTaskId),
                    preflightPath: resolvedPreflightPath,
                    remediationArtifactPath,
                    restartArtifactPath,
                    detectionSource: 'review_evidence_only',
                    affectedFilesCount: 0,
                    impactAnalysisSource: remediationImpactAnalysis.source,
                    remediationCategory: remediationFixClassification.category,
                    invalidatedReviewTypes: authoritativeDecision.invalidated_review_types,
                    preservedReviewTypes: authoritativeDecision.preserved_review_types,
                    scopeBoundaryStatus: scopeBoundary.status,
                    previousFilesCount: previousChangedFiles.length,
                    currentFilesCount: 0,
                    expandedNonTestFiles: [],
                    reviewContextsRefreshStatus: 'deferred_to_navigator',
                    effectiveDepth,
                    reviewExecutionPolicyMode,
                    preparedResults: [],
                    launchRequiredReviewTypes: evidenceOnlyRestartPlan.launchRequiredReviewTypes,
                    reusedReviewTypes: authoritativeDecision.reused_review_types,
                    pendingReviewTypes: evidenceOnlyRestartPlan.pendingReviewTypes,
                    pendingReason: evidenceOnlyRestartPlan.pendingReason,
                    nextStep,
                    preflightMode: previousPreflight.preflight.mode,
                    preflightScopeCategory: previousPreflight.preflight.scope_category,
                    preflightChangedFilesCount: previousPreflight.changed_files_count,
                    preflightRequiredReviewTypes: requiredReviewTypes,
                    refreshPoints: {
                        preflight: 'reused_current',
                        postPreflightRulePack: 'reused_current',
                        compile: 'reused_current'
                    }
                }),
                exitCode: 0
            };
        }

        if (prePreflightRefreshPlan.rerunHandshakeDiagnostics) {
            ensureStepPassed('handshake-diagnostics', runHandshakeDiagnosticsCommand({
                repoRoot,
                taskId: resolvedTaskId,
                provider: previousTaskMode.provider || undefined,
                taskModePath: resolvedTaskModePath,
                allowCurrentShellSmokePrecheck: true,
                emitMetrics: options.emitMetrics
            }));
        }

        if (prePreflightRefreshPlan.rerunShellSmokePreflight) {
            ensureStepPassed('shell-smoke-preflight', runShellSmokePreflightCommand({
                repoRoot,
                taskId: resolvedTaskId,
                provider: previousTaskMode.provider || undefined,
                taskModePath: resolvedTaskModePath,
                emitMetrics: options.emitMetrics
            }));
        }

        runClassifyChangeCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath || undefined,
            outputPath: refreshedPreflightPath,
            taskIntent: taskSummary,
            changedFiles: resolveReviewRemediationClassifyChangedFiles(
                replayScope,
                scopeBoundary,
                ignoredRemediationTargetAssessment.allowedBoundaryFiles
            ),
            useStaged: replayScope.useStaged,
            includeUntracked: replayScope.includeUntracked,
            emitMetrics: options.emitMetrics
        });
        const refreshedPreflight = getPreflightContext(refreshedPreflightPath, resolvedTaskId);
        const refreshedRequiredReviews = refreshedPreflight.preflight.required_reviews as Record<string, boolean>;
        const effectiveDepth = getEffectiveDepthFromPreflight(previousTaskMode, refreshedPreflight);
        const reviewExecutionPolicyMode = resolveReviewExecutionPolicyModeFromPreflight(refreshedPreflight.preflight);
        const reviewDependencyGraph = resolveCompiledReviewDependencyGraphFromPreflight(
            refreshedPreflight.preflight,
            reviewExecutionPolicyMode
        );

        ensureStepPassed('load-rule-pack (POST_PREFLIGHT)', runLoadRulePackCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath || undefined,
            stage: 'POST_PREFLIGHT',
            preflightPath: refreshedPreflightPath,
            loadedRuleFiles: normalizeRuleFileList(refreshedRequiredReviews, effectiveDepth),
            emitMetrics: options.emitMetrics
        }));

        const optionalSkillActivationRebind = await rebindRestartOptionalSkillActivationsForCurrentCycle({
            orchestratorRoot,
            taskId: resolvedTaskId,
            snapshot: optionalSkillActivationSnapshot
        });
        const optionalSkillDeclineRebind = await rebindRestartOptionalSkillDeclinesForCurrentCycle({
            orchestratorRoot,
            taskId: resolvedTaskId,
            snapshot: optionalSkillDeclineSnapshot
        });
        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath || undefined,
            preflightPath: refreshedPreflightPath,
            commandsPath: options.commandsPath,
            outputFiltersPath: options.outputFiltersPath,
            failTailLines: options.failTailLines,
            emitMetrics: options.emitMetrics
        } as CompileGateCommandOptions);
        ensureStepPassed('compile-gate', compileResult);
        const remediationWorkspaceSnapshot = getWorkspaceSnapshot(
            repoRoot,
            String(refreshedPreflight.detection_source || replayScope.detectionSource),
            replayScope.includeUntracked ?? !replayScope.useStaged,
            normalizeChangedFiles(refreshedPreflight.changed_files as unknown[])
        ) as Record<string, unknown>;

        const requiredReviewBatches = getReviewExecutionPreparationBatches(
            refreshedRequiredReviews,
            reviewExecutionPolicyMode,
            reviewDependencyGraph
        );
        const requiredReviewTypes = requiredReviewBatches.flat();
        remediationFixClassification = classifyReviewRemediationFix(
            scopeBoundary,
            requiredReviewTypes,
            remediationImpactAnalysis,
            reviewTriggerPolicy.test_path_regexes,
            refreshedPreflight.preflight,
            {
                testRefactorChangedLinesThreshold: reviewTriggerPolicy.test_refactor_changed_lines_threshold,
                testRefactorStructuralPathRegexes: reviewTriggerPolicy.test_refactor_structural_path_regexes,
                changedFileStats: remediationWorkspaceSnapshot.changed_file_stats,
                reviewDependencyGraph
            }
        );
        const authoritativeDecisionInputs = resolveRuntimeDecisionInputs({
            repoRoot,
            taskId: resolvedTaskId,
            remediationReviewType,
            requiredReviewTypes,
            remediationFixClassification,
            profilePolicySnapshot: previousTaskMode.profile_policy_snapshot,
            currentChangedFiles: scopeBoundary.currentChangedFiles,
            reviewTriggerPolicy,
            allowAuthenticatedDelta: true,
            preflightPayload: refreshedPreflight.preflight,
            authenticatedTaskCriteria: previousTaskMode.task_summary,
            currentTaskCriteria: taskSummary
        });
        const preliminaryAuthoritativeDecisionWithoutPreflight = requireReadyAuthoritativeDecision(
            resolveAuthoritativeReviewRemediationDecision({
                taskId: resolvedTaskId,
                currentReviewType: authoritativeDecisionInputs.currentReviewType,
                classification: authoritativeDecisionInputs.classification,
                modePolicyValidationInputs: authoritativeDecisionInputs.modePolicyValidationInputs,
                requiredReviews: refreshedRequiredReviews,
                reviewExecutionPolicyMode,
                reviewDependencyGraph
            })
        );
        const refreshedPreflightSha256 = requireArtifactSha256(
            refreshedPreflightPath,
            'refreshed-preflight'
        );
        const preliminaryAuthoritativeDecision = bindAuthoritativeRemediationDecisionToPreflight(
            preliminaryAuthoritativeDecisionWithoutPreflight,
            refreshedPreflightSha256
        );
        const preliminaryLaneDecisionByType = new Map(
            preliminaryAuthoritativeDecision.lane_decisions.map((decision) => [decision.review_type, decision])
        );
        const refreshedFullReviewScope = normalizeChangedFiles(
            refreshedPreflight.preflight.changed_files as unknown[]
        );
        const sharedTokenEconomyConfigPath = resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'token-economy.json'));
        const sharedTokenEconomyConfigData: TokenEconomyConfig | null = (
            fs.existsSync(sharedTokenEconomyConfigPath)
            && fs.statSync(sharedTokenEconomyConfigPath).isFile()
        )
            ? JSON.parse(fs.readFileSync(sharedTokenEconomyConfigPath, 'utf8')) as TokenEconomyConfig
            : null;
        const sharedRuleContextSectionsCache = new Map();
        const sharedRuleFileContentCache = new Map<string, string>();
        const sharedRuntimeReviewerIdentity = resolveRuntimeReviewerIdentity({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
            taskModeEvidence: previousTaskMode,
            allowLegacyFallback: true
        });
        const preparedResults: BuildReviewContextCommandResult[] = [];
        const reusableReceipts: ReviewRemediationReusableReceipt[] = [];
        const launchRequiredReviewTypes: string[] = [];
        let pendingReviewTypes: string[] = [];
        let pendingReason: string | null = null;

        for (let batchIndex = 0; batchIndex < requiredReviewBatches.length; batchIndex += 1) {
            const reviewBatch = requiredReviewBatches[batchIndex];
            const batchTimelineSummary = readTimelineEventsSummary(
                gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${resolvedTaskId}.jsonl`))
            );
            const batchResults = await Promise.all(reviewBatch.map(async (reviewType) => {
                try {
                    const laneDecision = preliminaryLaneDecisionByType.get(reviewType);
                    if (!laneDecision) {
                        throw new Error(`Authoritative remediation decision is missing required lane '${reviewType}'.`);
                    }
                    const scopedDiffExpected = buildReviewContextPreflightDiffExpectations(
                        refreshedPreflight.preflight,
                        reviewType
                    ).expectedScopedDiff;
                    const scopedDiffMetadataPath = scopedDiffExpected
                        ? resolveScopedDiffMetadataPath('', refreshedPreflightPath, reviewType, repoRoot)
                        : '';
                    if (scopedDiffExpected) {
                        buildScopedDiff({
                            reviewType,
                            preflightPath: refreshedPreflightPath,
                            pathsConfigPath: resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'paths.json')),
                            outputPath: resolveScopedDiffOutputPath('', refreshedPreflightPath, reviewType, repoRoot),
                            metadataPath: scopedDiffMetadataPath,
                            repoRoot,
                            useStaged: replayScope.useStaged
                        });
                    }
                    const prepared = await runBuildReviewContextCommand({
                        repoRoot,
                        reviewType,
                        depth: String(effectiveDepth),
                        preflightPath: refreshedPreflightPath,
                        preflightPayload: refreshedPreflight.preflight,
                        taskModePath: String(previousTaskMode.evidence_path || '').trim() || undefined,
                        taskModeEvidence: previousTaskMode,
                        runtimeReviewerIdentity: sharedRuntimeReviewerIdentity,
                        tokenEconomyConfigPath: sharedTokenEconomyConfigPath,
                        tokenEconomyConfigData: sharedTokenEconomyConfigData,
                        scopedDiffMetadataPath,
                        timelineEventsSummary: batchTimelineSummary,
                        ruleContextSectionsCache: sharedRuleContextSectionsCache,
                        ruleFileContentCache: sharedRuleFileContentCache
                    });
                    return {
                        reviewType,
                        prepared,
                        dependencyBlockReason: null,
                        error: null
                    };
                } catch (error: unknown) {
                    return {
                        reviewType,
                        prepared: null,
                        dependencyBlockReason: getDependencyBlockReason(error, reviewType),
                        error
                    };
                }
            }));

            const unexpectedFailure = batchResults.find((result) => result.error && !result.dependencyBlockReason);
            if (unexpectedFailure) {
                throw unexpectedFailure.error;
            }

            for (const result of batchResults) {
                if (!result.prepared) {
                    continue;
                }
                preparedResults.push(result.prepared);
                if (result.prepared.acceptedReviewEvidenceKind) {
                    reusableReceipts.push({
                        review_type: result.reviewType,
                        reuse_status: 'ACCEPTED',
                        findings_satisfied: true,
                        evidence_kind: result.prepared.acceptedReviewEvidenceKind,
                        reason: result.prepared.acceptedReviewEvidenceKind === 'REUSED'
                            ? 'build-review-context accepted authenticated current-cycle reuse evidence'
                            : 'build-review-context accepted fresh authenticated current-cycle review evidence'
                    });
                } else {
                    reusableReceipts.push({
                        review_type: result.reviewType,
                        reuse_status: 'REJECTED',
                        findings_satisfied: false,
                        reason: 'build-review-context did not accept authenticated satisfied reuse evidence'
                    });
                    launchRequiredReviewTypes.push(result.reviewType);
                }
            }

            const dependencyBlockedResult = batchResults.find((result) => result.dependencyBlockReason);
            if (dependencyBlockedResult) {
                pendingReviewTypes = requiredReviewTypes.slice(requiredReviewTypes.indexOf(dependencyBlockedResult.reviewType));
                pendingReason = dependencyBlockedResult.dependencyBlockReason;
                break;
            }
        }

        const authoritativeDecision = bindAuthoritativeRemediationDecisionToPreflight(
            requireReadyAuthoritativeDecision(resolveAuthoritativeReviewRemediationDecision({
                taskId: resolvedTaskId,
                currentReviewType: authoritativeDecisionInputs.currentReviewType,
                classification: authoritativeDecisionInputs.classification,
                modePolicyValidationInputs: authoritativeDecisionInputs.modePolicyValidationInputs,
                requiredReviews: refreshedRequiredReviews,
                reviewExecutionPolicyMode,
                reviewDependencyGraph,
                reusableReceipts
            })),
            refreshedPreflightSha256
        );
        const reusedReviewTypes = authoritativeDecision.reused_review_types;
        const finalLaneDecisionByType = new Map(
            authoritativeDecision.lane_decisions.map((decision) => [decision.review_type, decision])
        );

        for (let index = 0; index < preparedResults.length; index += 1) {
            const preparedResult = preparedResults[index];
            if (!launchRequiredReviewTypes.includes(preparedResult.reviewType)) {
                continue;
            }
            const laneDecision = finalLaneDecisionByType.get(preparedResult.reviewType);
            if (!laneDecision || laneDecision.mode === 'REUSE') {
                throw new Error(
                    `Final authoritative remediation decision has no executable FULL/DELTA lane `
                    + `'${preparedResult.reviewType}'.`
                );
            }
            const reviewExecution = buildAuthenticatedRemediationReviewExecution({
                taskId: resolvedTaskId,
                reviewType: preparedResult.reviewType,
                preflightSha256: refreshedPreflightSha256,
                fullReviewScope: refreshedFullReviewScope,
                authoritativeDecision,
                authoritativeClassification: authoritativeDecisionInputs.classification,
                persistedDecisionSha256: authoritativeDecision.decision_sha256
            });
            const scopedDiffExpected = buildReviewContextPreflightDiffExpectations(
                refreshedPreflight.preflight,
                preparedResult.reviewType
            ).expectedScopedDiff;
            preparedResults[index] = await runBuildReviewContextCommand({
                repoRoot,
                reviewType: preparedResult.reviewType,
                depth: String(effectiveDepth),
                preflightPath: refreshedPreflightPath,
                preflightPayload: refreshedPreflight.preflight,
                taskModePath: String(previousTaskMode.evidence_path || '').trim() || undefined,
                taskModeEvidence: previousTaskMode,
                runtimeReviewerIdentity: sharedRuntimeReviewerIdentity,
                tokenEconomyConfigPath: sharedTokenEconomyConfigPath,
                tokenEconomyConfigData: sharedTokenEconomyConfigData,
                scopedDiffMetadataPath: scopedDiffExpected
                    ? resolveScopedDiffMetadataPath(
                        '',
                        refreshedPreflightPath,
                        preparedResult.reviewType,
                        repoRoot
                    )
                    : '',
                timelineEventsSummary: readTimelineEventsSummary(
                    gateHelpers.joinOrchestratorPath(
                        repoRoot,
                        path.join('runtime', 'task-events', `${resolvedTaskId}.jsonl`)
                    )
                ),
                reviewReuseBlockedReason: laneDecision.reason,
                reviewExecutionContract: reviewExecution.contract,
                reviewExecutionValidationAuthority: reviewExecution.validationAuthority,
                ruleContextSectionsCache: sharedRuleContextSectionsCache,
                ruleFileContentCache: sharedRuleFileContentCache
            });
        }

        const pendingOnTrustBoundaryPrerequisite = pendingReason?.includes(
            'Review context cannot be built because required trust-boundary analysis is'
        ) === true;
        const reviewContextsRefreshStatus = pendingReviewTypes.length > 0
            ? pendingOnTrustBoundaryPrerequisite
                ? 'partially_prepared_prerequisite_blocked'
                : 'partially_prepared_dependency_blocked'
            : 'prepared_or_reused';
        const nextStep = pendingReviewTypes.length > 0
            ? pendingOnTrustBoundaryPrerequisite
                ? 'Rerun next-step to refresh the mandatory trust-boundary checklist before building review contexts.'
                : 'Launch and record the prepared upstream reviews first, then rerun restart-review-cycle to materialize the remaining downstream review contexts.'
            : launchRequiredReviewTypes.length > 0
                ? 'Launch and record the prepared review types in dependency-safe order, then rerun required-reviews-check, doc-impact-gate, and completion-gate.'
                : 'All required review evidence is already current-cycle. Rerun required-reviews-check, doc-impact-gate, and completion-gate.';
        const remediationArtifactPath = writeReviewRemediationCycleArtifact(repoRoot, resolvedTaskId, {
            schema_version: 1,
            task_id: resolvedTaskId,
            status: 'PASSED',
            previous_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
            previous_preflight_sha256: fs.existsSync(resolvedPreflightPath)
                ? gateHelpers.fileSha256(resolvedPreflightPath)
                : null,
            refreshed_preflight_path: gateHelpers.normalizePath(refreshedPreflightPath),
            refreshed_preflight_sha256: fs.existsSync(refreshedPreflightPath)
                ? gateHelpers.fileSha256(refreshedPreflightPath)
                : null,
            detection_source: replayScope.detectionSource,
            impact_analysis: remediationImpactAnalysis,
            ignored_remediation_targets: {
                status: ignoredRemediationTargetAssessment.violations.length > 0 ? 'BLOCKED' : 'OK',
                targets: ignoredRemediationTargetAssessment.targets,
                violations: ignoredRemediationTargetAssessment.violations
            },
            remediation_fix_classification: remediationFixClassification,
            authoritative_review_decision: authoritativeDecision,
            authoritative_review_classification: authoritativeDecisionInputs.classification,
            remediation_scope: {
                status: scopeBoundary.status,
                previous_changed_files: scopeBoundary.previousChangedFiles,
                current_changed_files: scopeBoundary.currentChangedFiles,
                expanded_files: scopeBoundary.expandedFiles,
                expanded_non_test_files: scopeBoundary.expandedNonTestFiles,
                allowed_test_only_expansion_files: scopeBoundary.allowedTestOnlyExpansionFiles
            },
            refresh_points: {
                preflight: 'refreshed',
                post_preflight_rule_pack: 'reloaded',
                compile: 'rerun',
                review_contexts: reviewContextsRefreshStatus
            },
            review_reuse: {
                review_execution_policy: reviewExecutionPolicyMode,
                prepared_review_types: preparedResults.map((result) => result.reviewType),
                launch_required_review_types: launchRequiredReviewTypes,
                reused_review_types: reusedReviewTypes,
                pending_review_types: pendingReviewTypes,
                pending_reason: pendingReason
            },
            reuse_boundaries: {
                non_test_changes_must_stay_within_previous_preflight_scope: true,
                test_only_expansion_allowed: true,
                explicit_ignored_remediation_targets_require_hash_and_review_relevance: true,
                expanded_non_test_files_block_reuse: true
            }
        });
        const restartArtifactPath = appendRestartCompletedEvidence({
            repoRoot,
            taskId: resolvedTaskId,
            eventType: 'REVIEW_CYCLE_RESTARTED',
            artifactSuffix: '-review-cycle-restart.json',
            message: 'Review remediation cycle restarted after compile gate pass.',
            taskModePath: resolvedTaskModePath,
            preflightPath: refreshedPreflightPath,
            compileEvidencePath: resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`),
            detectionSource: replayScope.detectionSource,
            plannedChangedFilesCount: previousChangedFiles.length,
            detectedChangedFilesCount: scopeBoundary.currentChangedFiles.length,
            elapsedMs: Date.now() - startedAt,
            restartReason: 'failed_review_remediation_cycle',
            nextStepSummary: nextStep,
            extraDetails: {
                remediation_artifact_path: gateHelpers.normalizePath(remediationArtifactPath),
                remediation_artifact_sha256: requireArtifactSha256(remediationArtifactPath, 'review-remediation-cycle'),
                impact_analysis_source: remediationImpactAnalysis.source,
                affected_files_count: scopeBoundary.currentChangedFiles.length,
                remediation_category: remediationFixClassification.category,
                invalidated_review_types: authoritativeDecision.invalidated_review_types,
                preserved_review_types: authoritativeDecision.preserved_review_types,
                authoritative_review_decision: authoritativeDecision,
                authoritative_review_classification: authoritativeDecisionInputs.classification,
                review_contexts_refresh_status: reviewContextsRefreshStatus,
                review_execution_policy_mode: reviewExecutionPolicyMode,
                prepared_review_types: preparedResults.map((result) => result.reviewType),
                launch_required_review_types: launchRequiredReviewTypes,
                reused_review_types: reusedReviewTypes,
                pending_review_types: pendingReviewTypes,
                pending_reason: pendingReason,
                ...(buildOptionalSkillRebindDetails(optionalSkillActivationRebind, optionalSkillDeclineRebind) || {})
            }
        });

        return {
            outputLines: buildReviewCycleRestartedOutput({
                taskId: resolvedTaskId,
                navigatorCommand: buildNextStepRecoveryCommand(repoRoot, resolvedTaskId),
                preflightPath: refreshedPreflightPath,
                remediationArtifactPath,
                restartArtifactPath,
                detectionSource: replayScope.detectionSource,
                affectedFilesCount: scopeBoundary.currentChangedFiles.length,
                impactAnalysisSource: remediationImpactAnalysis.source,
                remediationCategory: remediationFixClassification.category,
                invalidatedReviewTypes: authoritativeDecision.invalidated_review_types,
                preservedReviewTypes: authoritativeDecision.preserved_review_types,
                scopeBoundaryStatus: scopeBoundary.status,
                previousFilesCount: scopeBoundary.previousChangedFiles.length,
                currentFilesCount: scopeBoundary.currentChangedFiles.length,
                expandedNonTestFiles: scopeBoundary.expandedNonTestFiles,
                reviewContextsRefreshStatus,
                effectiveDepth,
                reviewExecutionPolicyMode,
                preparedResults,
                launchRequiredReviewTypes,
                reusedReviewTypes,
                pendingReviewTypes,
                pendingReason,
                nextStep,
                preflightMode: refreshedPreflight.preflight.mode,
                preflightScopeCategory: refreshedPreflight.preflight.scope_category,
                preflightChangedFilesCount: refreshedPreflight.changed_files_count,
                preflightRequiredReviewTypes: collectRequiredReviewTypes(refreshedRequiredReviews)
            }),
            exitCode: 0
        };
    } catch (error: unknown) {
        return {
            outputLines: [
                'REVIEW_CYCLE_RESTART_FAILED',
                `TaskId: ${resolvedTaskId}`,
                error instanceof Error ? error.message : String(error)
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }
}
