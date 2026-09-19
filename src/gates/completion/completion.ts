import * as path from 'node:path';
import {
    computeProtectedSnapshotDigest,
    normalizePath,
    joinOrchestratorPath,
    resolvePathInsideRepo,
    toPlainRecord,
    getProtectedControlPlaneRoots,
    scanProtectedPathHashes,
    evaluateProtectedControlPlaneManifest
} from '../shared';
import { detectCodeChanged, preflightRequiresAnyReview } from '../preflight';
import { evaluateIsolationModePostTask, loadIsolationModeConfig, validateSandbox } from '../isolation';
import {
    detectProtectedDirtyWorkspaceDrift,
    getProtectedDirtyWorkspaceScopeFromPreflight
} from '../workspace';
import {
    getProtectedManifestLifecycleGuard,
    reconstructProtectedSnapshotBeforeCompileGeneratedArtifacts,
    validateCompileGeneratedProtectedArtifactEvidence
} from '../protected-control-plane';
import { getNoOpEvidence, getTaskModeEvidence, getTaskModeEvidenceViolations } from '../task-mode';
import {
    getHandshakeEvidence,
    getHandshakeEvidenceViolations,
    getShellSmokeEvidence,
    getShellSmokeEvidenceViolations
} from '../diagnostics';
import { getRulePackEvidence, getRulePackEvidenceViolations } from '../rule-pack';
import {
    resolveRuntimeReviewerIdentity,
    resolveReviewerRoutingPolicy
} from '../review';
import {
    collectOrderedTimelineEvents,
    readJsonArtifact,
    ensurePassedArtifactStatus,
    readOptionalArtifactStringField
} from './completion-evidence';
import {
    REVIEW_CONTRACTS,
    REVIEW_SKILL_CANDIDATES,
    resolveCompletionReviewContracts,
    resolveCompletionReviewSkillCandidates,
    validateStageSequence,
    validateZeroDiffCompletionEvidence,
    validateReviewSkillEvidence,
    validatePreflightForCompletion
} from './completion-verdict';

import {
    buildCoherentCycleRestartCommand,
    buildReviewCycleRestartCommand
} from './completion-reporting';
import {
    loadFullSuiteValidationConfig,
    isFullSuiteNotRequiredForDocsOnlyScope,
    isFullSuiteNotRequiredForZeroDiffNoReviewableScope
} from '../full-suite';
import {
    getProjectMemoryImpactLifecycleEvidence
} from '../project-memory-impact';
import {
    validateStrictDeferredReviewFollowups,
    type DeferredFollowupValidationResult
} from './completion-deferred-followups';
import {
    getCurrentWorkflowConfigChanges,
    getWorkflowConfigWorkViolations
} from '../workflow-config';
import { resolveReviewExecutionPolicyModeFromPreflight } from '../../core/review-execution-policy';
import {
    bindFullSuiteValidationBarrier,
    resolveCompiledReviewDependencyGraphFromPreflight
} from '../../core/review-dependency-graph';
import {
    assertEffectiveReviewSnapshotExecutionPolicyBinding,
    hasCurrentReviewDependencyGraphContract,
    type EffectiveReviewSnapshot,
    type FrozenReviewExecutionPolicyBinding
} from '../../policy/effective-review-snapshot';
import { validateProjectMemoryImpactForCompletion } from './completion-project-memory';
import {
    collectRequiredReviewEvidence,
    resolveCompletionReviewTrustSummary
} from './completion-required-review-evidence';
import { collectFullSuiteValidationEvidence } from './completion-full-suite-evidence';
import { readTaskQueueEntries } from '../../core/task-queue-read';

export { detectCodeChanged, preflightRequiresAnyReview } from '../preflight';

export {
    quotePowerShellCliValue,
    buildCoherentCycleRestartCommand,
    buildReviewCycleRestartCommand,
    formatCompletionGateResult
} from './completion-reporting';

export {
    collectOrderedTimelineEvents,
    readJsonArtifact,
    ensurePassedArtifactStatus,
    readOptionalArtifactStringField,
    normalizeTimelineDetailString,
    getTimelineSkillId,
    getTimelineReferencePath,
    eventMatchesReviewSkill,
    eventMatchesStage,
    findLatestTimelineEvent,
    findLatestStageOccurrence,
    findLatestStageOccurrenceInRange,
    findLatestRecordedReviewContextPath
} from './completion-evidence';
export type { TimelineEventEntry } from './completion-evidence';

export {
    STAGE_SEQUENCE_ORDER,
    NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER,
    NON_CODE_STAGE_SEQUENCE_ORDER,
    REVIEW_CONTRACTS,
    EMPTY_REVIEW_MARKERS,
    CANONICAL_REVIEW_SECTION_HEADINGS,
    countCanonicalReviewSectionHeadings,
    validateStageSequence,
    validateZeroDiffCompletionEvidence,
    validateReviewSkillEvidence,
    validatePreflightForCompletion,
    isTrivialReview,
    extractMarkdownSectionLines,
    formatAcceptedReviewSectionHeadingShapes,
    getCanonicalReviewSectionHeading,
    normalizeCanonicalReviewSectionHeadings,
    normalizeReviewListText,
    isMeaningfulReviewEntry,
    getMarkdownMeaningfulEntries,
    getFindingsBySeverity,
    getReviewArtifactFindingsEvidence,
    getReviewFindingsEvidenceFromValidationArtifact
} from './completion-verdict';
export type { StageSequenceEvidence, ZeroDiffCompletionEvidence } from './completion-verdict';


export interface RunCompletionGateOptions {
    repoRoot?: string;
    preflightPath: string;
    taskId?: string;
    taskModePath?: string;
    rulePackPath?: string;
    reviewsRoot?: string;
    compileEvidencePath?: string;
    reviewEvidencePath?: string;
    docImpactPath?: string;
    timelinePath?: string;
    noOpArtifactPath?: string;
    handshakePath?: string;
    shellSmokePath?: string;
}

export function runCompletionGate(options: RunCompletionGateOptions) {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const preflightPath = resolvePathInsideRepo(options.preflightPath, repoRoot) as string;
    const validatedPreflight = validatePreflightForCompletion(preflightPath, options.taskId || '');
    const errors: string[] = [...validatedPreflight.errors];
    const resolvedTaskId = validatedPreflight.resolved_task_id;

    const reviewsRoot = options.reviewsRoot
        ? resolvePathInsideRepo(options.reviewsRoot, repoRoot, { allowMissing: true }) as string
        : path.dirname(preflightPath);
    const compileEvidencePath = options.compileEvidencePath
        ? resolvePathInsideRepo(options.compileEvidencePath, repoRoot, { allowMissing: true }) as string
        : path.join(reviewsRoot, `${resolvedTaskId}-compile-gate.json`);
    const reviewEvidencePath = options.reviewEvidencePath
        ? resolvePathInsideRepo(options.reviewEvidencePath, repoRoot, { allowMissing: true }) as string
        : path.join(reviewsRoot, `${resolvedTaskId}-review-gate.json`);
    const docImpactPath = options.docImpactPath
        ? resolvePathInsideRepo(options.docImpactPath, repoRoot, { allowMissing: true }) as string
        : path.join(reviewsRoot, `${resolvedTaskId}-doc-impact.json`);
    const timelinePath = options.timelinePath
        ? resolvePathInsideRepo(options.timelinePath, repoRoot, { allowMissing: true }) as string
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${resolvedTaskId}.jsonl`));
    const taskModeEvidence = getTaskModeEvidence(repoRoot, resolvedTaskId, options.taskModePath || '');
    const rulePackEvidence = getRulePackEvidence(repoRoot, resolvedTaskId, 'POST_PREFLIGHT', {
        artifactPath: options.rulePackPath || '',
        preflightPath,
        taskModePath: options.taskModePath || ''
    });
    const preflight = validatedPreflight.preflight || {};
    const reviewExecutionPolicyMode = resolveReviewExecutionPolicyModeFromPreflight(preflight);
    const frozenReviewPolicy = taskModeEvidence.profile_policy_snapshot?.review_execution_policy as
        FrozenReviewExecutionPolicyBinding | undefined;
    const frozenGraphContractRequired = !!frozenReviewPolicy
        && hasCurrentReviewDependencyGraphContract(frozenReviewPolicy);
    const frozenReviewDependencyGraph = frozenGraphContractRequired && preflight.effective_review_snapshot
        ? assertEffectiveReviewSnapshotExecutionPolicyBinding(
            preflight.effective_review_snapshot as EffectiveReviewSnapshot,
            frozenReviewPolicy
        )
        : null;
    const reviewDependencyGraph = resolveCompiledReviewDependencyGraphFromPreflight(
        preflight,
        reviewExecutionPolicyMode,
        frozenReviewDependencyGraph,
        frozenGraphContractRequired
    );
    const fullSuiteValidationConfig = bindFullSuiteValidationBarrier(
        loadFullSuiteValidationConfig(repoRoot),
        reviewDependencyGraph
    );
    const noOpEvidence = getNoOpEvidence(repoRoot, resolvedTaskId, options.noOpArtifactPath || '', preflightPath);
    const handshakeEvidence = getHandshakeEvidence(repoRoot, resolvedTaskId, {
        artifactPath: options.handshakePath || '',
        taskModePath: options.taskModePath || '',
        timelinePath
    });
    const shellSmokeEvidence = getShellSmokeEvidence(repoRoot, resolvedTaskId, {
        artifactPath: options.shellSmokePath || '',
        timelinePath
    });

    const fullSuiteNotRequiredForDocsOnly = isFullSuiteNotRequiredForDocsOnlyScope(preflight);
    const fullSuiteNotRequiredForZeroDiffNoReviewableScope = isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflight);
    const compileGateRequired = !(
        fullSuiteNotRequiredForZeroDiffNoReviewableScope
        && noOpEvidence.evidence_status === 'PASS'
    );
    const fullSuiteValidationRequired = fullSuiteValidationConfig.enabled
        && !fullSuiteNotRequiredForDocsOnly
        && !fullSuiteNotRequiredForZeroDiffNoReviewableScope;
    const dirtyWorkspaceProtectionEvidence = detectProtectedDirtyWorkspaceDrift(
        repoRoot,
        getProtectedDirtyWorkspaceScopeFromPreflight(preflight)
    );
    const preflightTriggers = toPlainRecord(preflight.triggers) || {};
    const preflightProtectedSnapshot = toPlainRecord(preflightTriggers.protected_control_plane_snapshot) || {};
    const hasProtectedSnapshot = Object.prototype.hasOwnProperty.call(preflightTriggers, 'protected_control_plane_snapshot');
    const preflightProtectedSnapshotDigest = String(preflightTriggers.protected_control_plane_snapshot_sha256 || '').trim().toLowerCase();
    const hasProtectedSnapshotDigest = /^[a-f0-9]{64}$/.test(preflightProtectedSnapshotDigest);
    const orchestratorWork = !!taskModeEvidence.orchestrator_work;
    const compileEvidence = compileGateRequired
        ? readJsonArtifact(compileEvidencePath, 'Compile gate', errors)
        : null;
    const hasCompileGeneratedProtectedArtifactEvidence = !!toPlainRecord(
        compileEvidence?.compile_generated_protected_artifacts
    );

    // Re-scan protected paths at completion to detect tampering.
    // When isolation mode is enabled, enforcement level governs whether drift is
    // a hard error (STRICT) or a logged warning (LOG_ONLY).
    const isolationConfig = loadIsolationModeConfig(repoRoot);
    const isolationWarnings: string[] = [];
    let currentProtectedSnapshot: Record<string, string> | null = null;
    let protectedControlPlaneWorkflowConfigChangedFilesAtCompletion: string[] = [];
    if (hasProtectedSnapshot || hasProtectedSnapshotDigest || hasCompileGeneratedProtectedArtifactEvidence) {
        currentProtectedSnapshot = scanProtectedPathHashes(
            repoRoot,
            getProtectedControlPlaneRoots(repoRoot)
        );
    }
    const compileGeneratedProtectedArtifactValidation = !orchestratorWork && currentProtectedSnapshot
        ? validateCompileGeneratedProtectedArtifactEvidence({
            repoRoot,
            compileEvidence,
            taskId: resolvedTaskId || '',
            preflightPath,
            preflightSha256: validatedPreflight.preflight_hash || '',
            currentProtectedSnapshot
        })
        : {
            allowed_changed_files: [],
            entries: [],
            violations: []
        };
    errors.push(...compileGeneratedProtectedArtifactValidation.violations);
    const compileGeneratedProtectedArtifactEntriesByPath = new Map(
        compileGeneratedProtectedArtifactValidation.entries.map((entry) => [entry.path, entry])
    );
    if ((hasProtectedSnapshot || hasProtectedSnapshotDigest) && currentProtectedSnapshot) {
        const currentProtectedSnapshotDigest = computeProtectedSnapshotDigest(currentProtectedSnapshot);
        let changedFiles: string[] = [];
        let taskMutatedProtectedControlPlane = false;

        if (hasProtectedSnapshot) {
            const allProtectedPaths = new Set([...Object.keys(preflightProtectedSnapshot), ...Object.keys(currentProtectedSnapshot)]);
            for (const p of allProtectedPaths) {
                if (preflightProtectedSnapshot[p] !== currentProtectedSnapshot[p]) {
                    const compileGeneratedEntry = compileGeneratedProtectedArtifactEntriesByPath.get(p);
                    const preflightHash = Object.prototype.hasOwnProperty.call(preflightProtectedSnapshot, p)
                        ? String(preflightProtectedSnapshot[p] || '').trim().toLowerCase()
                        : null;
                    if (
                        compileGeneratedEntry
                        && preflightHash === compileGeneratedEntry.before_sha256
                        && currentProtectedSnapshot[p] === compileGeneratedEntry.after_sha256
                    ) {
                        continue;
                    }
                    changedFiles.push(p);
                }
            }
            taskMutatedProtectedControlPlane = changedFiles.length > 0;
            protectedControlPlaneWorkflowConfigChangedFilesAtCompletion = changedFiles.filter((changedFile) => (
                Object.prototype.hasOwnProperty.call(preflightProtectedSnapshot, changedFile)
            ));
        } else if (
            hasProtectedSnapshotDigest
            && currentProtectedSnapshotDigest !== preflightProtectedSnapshotDigest
        ) {
            const reconstructedPreCompileSnapshot = reconstructProtectedSnapshotBeforeCompileGeneratedArtifacts(
                currentProtectedSnapshot,
                compileGeneratedProtectedArtifactValidation.entries
            );
            taskMutatedProtectedControlPlane =
                computeProtectedSnapshotDigest(reconstructedPreCompileSnapshot) !== preflightProtectedSnapshotDigest;
        }

        if (taskMutatedProtectedControlPlane && !orchestratorWork) {
            const driftMessage = changedFiles.length > 0
                ? `Control-plane files were modified in a non-orchestrator task: ${changedFiles.join(', ')}. ` +
                  'Protected orchestrator runtime paths are only allowed for tasks started with --orchestrator-work.'
                : 'Control-plane files were modified in a non-orchestrator task after the preflight protected snapshot digest changed. ' +
                  'Protected orchestrator runtime paths are only allowed for tasks started with --orchestrator-work.';
            if (isolationConfig.enabled && isolationConfig.enforcement === 'LOG_ONLY') {
                isolationWarnings.push(driftMessage + ' (LOG_ONLY mode — logged as warning)');
            } else {
                errors.push(driftMessage);
            }
        }
    }

    const protectedManifestEvidence = evaluateProtectedControlPlaneManifest(repoRoot, currentProtectedSnapshot);
    const protectedManifestGuard = getProtectedManifestLifecycleGuard({
        repoRoot,
        orchestratorWork,
        phaseLabel: 'completion gate',
        preflight,
        manifestEvidence: protectedManifestEvidence,
        lifecycleOwnedManifestChangedFiles:
            compileGeneratedProtectedArtifactValidation.allowed_changed_files
    });
    if (!orchestratorWork && protectedManifestGuard.status === 'BLOCK') {
        if (isolationConfig.enabled && isolationConfig.enforcement === 'LOG_ONLY') {
            isolationWarnings.push(`${protectedManifestGuard.violations.join(' ')} (LOG_ONLY mode — logged as warning)`);
        } else {
            errors.push(...protectedManifestGuard.violations);
        }
    }

    const workflowConfigBaseline = taskModeEvidence.workflow_config_file_hashes;
    const workflowConfigChanges = getCurrentWorkflowConfigChanges(repoRoot, workflowConfigBaseline, {
        allowProtectedManifestFallback: false
    });
    const workflowConfigWorkViolations = getWorkflowConfigWorkViolations({
        repoRoot,
        changedFiles: [
            ...workflowConfigChanges.changed_files,
            ...protectedControlPlaneWorkflowConfigChangedFilesAtCompletion
        ],
        taskModeEvidence,
        phaseLabel: 'completion gate',
        baselineFileHashes: workflowConfigChanges.baseline_file_hashes,
        currentFileHashes: workflowConfigChanges.current_file_hashes
    });
    errors.push(...workflowConfigWorkViolations);
    if (workflowConfigChanges.scan_error && workflowConfigWorkViolations.length > 0) {
        isolationWarnings.push(`Workflow config workspace scan warning: ${workflowConfigChanges.scan_error}`);
    }

    const docImpactEvidence = readJsonArtifact(docImpactPath, 'Doc impact gate', errors);
    const compileCommandsPath = readOptionalArtifactStringField(compileEvidence, 'commands_path');
    const compileOutputFiltersPath = readOptionalArtifactStringField(compileEvidence, 'output_filters_path');

    if (compileGateRequired) {
        ensurePassedArtifactStatus(compileEvidence, 'Compile gate', errors);
    }
    ensurePassedArtifactStatus(docImpactEvidence, 'Doc impact gate', errors);
    errors.push(...getTaskModeEvidenceViolations(taskModeEvidence));
    errors.push(...getRulePackEvidenceViolations(rulePackEvidence));
    errors.push(...getHandshakeEvidenceViolations(handshakeEvidence));
    errors.push(...getShellSmokeEvidenceViolations(shellSmokeEvidence));
    errors.push(...dirtyWorkspaceProtectionEvidence.violations);

    // Post-task isolation mode enforcement complements the protected drift check above.
    if (hasProtectedSnapshot && !orchestratorWork && isolationConfig.enabled) {
        const typedSnapshot: Record<string, string> = {};
        for (const [k, v] of Object.entries(preflightProtectedSnapshot)) {
            typedSnapshot[k] = String(v);
        }
        const isolationEvidence = evaluateIsolationModePostTask(
            repoRoot,
            typedSnapshot,
            compileGeneratedProtectedArtifactValidation.allowed_changed_files
        );
        errors.push(...isolationEvidence.violations);
        isolationWarnings.push(...isolationEvidence.warnings);
    }

    // Sandbox integrity check at completion.
    if (isolationConfig.enabled && isolationConfig.use_sandbox && !orchestratorWork) {
        const sandboxState = validateSandbox(repoRoot);
        if (sandboxState.exists) {
            if (sandboxState.drift_files.length > 0) {
                const sbMessage = `Isolation sandbox was modified during task (${sandboxState.drift_files.length} file(s) drifted). ` +
                    'This indicates the sandbox was tampered with during execution.';
                if (isolationConfig.enforcement === 'STRICT') {
                    errors.push(sbMessage);
                } else {
                    isolationWarnings.push(sbMessage + ' (LOG_ONLY mode — logged as warning)');
                }
            }
            if (!sandboxState.read_only_intact) {
                isolationWarnings.push(
                    'Isolation sandbox read-only flags were removed on some files. ' +
                    'Same-user limitation: read-only attributes are advisory, not a security boundary.'
                );
            }
        }
    }

    const timelineErrors: string[] = [];
    const orderedEvents = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    const timelineEventTypes = new Set(orderedEvents.map(e => e.event_type));
    const codeChanged = detectCodeChanged(validatedPreflight.preflight, repoRoot);
    const reviewRecordedRequired = preflightRequiresAnyReview(validatedPreflight.preflight);
    const latestCompileGatePassedTimestamp = [...orderedEvents]
        .reverse()
        .find((entry) => entry.event_type === 'COMPILE_GATE_PASSED')
        ?.timestamp_utc ?? null;

    errors.push(...timelineErrors);

    if (!timelineEventTypes.has('TASK_MODE_ENTERED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing TASK_MODE_ENTERED.`);
    }
    if (!timelineEventTypes.has('RULE_PACK_LOADED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing RULE_PACK_LOADED.`);
    }
    if (!timelineEventTypes.has('HANDSHAKE_DIAGNOSTICS_RECORDED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing HANDSHAKE_DIAGNOSTICS_RECORDED. Run handshake-diagnostics before preflight.`);
    }
    if (!timelineEventTypes.has('SHELL_SMOKE_PREFLIGHT_RECORDED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing SHELL_SMOKE_PREFLIGHT_RECORDED. Run shell-smoke-preflight before preflight.`);
    }
    if (compileGateRequired && !timelineEventTypes.has('COMPILE_GATE_PASSED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing COMPILE_GATE_PASSED.`);
    }
    if (reviewRecordedRequired && !timelineEventTypes.has('REVIEW_PHASE_STARTED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing REVIEW_PHASE_STARTED.`);
    }
    if (
        !timelineEventTypes.has('REVIEW_GATE_PASSED')
        && !timelineEventTypes.has('REVIEW_GATE_PASSED_WITH_OVERRIDE')
    ) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing REVIEW_GATE_PASSED.`);
    }

    const zeroDiffEvidence = validateZeroDiffCompletionEvidence(
        validatedPreflight.preflight,
        resolvedTaskId || '',
        taskModeEvidence.task_summary,
        noOpEvidence
    );
    errors.push(...zeroDiffEvidence.violations);

    const stageSequence = validateStageSequence(
        orderedEvents,
        codeChanged,
        timelinePath,
        reviewRecordedRequired,
        compileGateRequired
    );
    errors.push(...stageSequence.violations);

    const requiredReviews = validatedPreflight.preflight && typeof validatedPreflight.preflight.required_reviews === 'object'
        ? validatedPreflight.preflight.required_reviews
        : {};
    let effectiveReviewContracts = REVIEW_CONTRACTS;
    let effectiveReviewSkillCandidates = REVIEW_SKILL_CANDIDATES;
    try {
        effectiveReviewContracts = resolveCompletionReviewContracts(preflight);
        effectiveReviewSkillCandidates = resolveCompletionReviewSkillCandidates(preflight);
    } catch (error: unknown) {
        errors.push(error instanceof Error ? error.message : String(error));
    }
    const profileSelection = preflight.profile_selection && typeof preflight.profile_selection === 'object' && !Array.isArray(preflight.profile_selection)
        ? preflight.profile_selection as Record<string, unknown>
        : {};
    const activeProfile = String(profileSelection.effective_profile || profileSelection.task_profile || '').trim() || null;
    const runtimeIdentity = resolveRuntimeReviewerIdentity({
        repoRoot,
        taskId: resolvedTaskId,
        taskModePath: options.taskModePath || '',
        allowLegacyFallback: true
    });
    const executionProvider = runtimeIdentity.execution_provider;
    if (runtimeIdentity.identity_status !== 'resolved') {
        errors.push(
            `Runtime reviewer identity must stay resolved for completion, got '${runtimeIdentity.identity_status}'.`
        );
    }
    errors.push(...runtimeIdentity.violations);
    const requiredReviewTypesForRuntime = Object.entries(requiredReviews)
        .filter(([, required]) => required === true)
        .map(([reviewType]) => reviewType)
        .sort();
    if (requiredReviewTypesForRuntime.length > 0 && runtimeIdentity.reviewer_subagent_launch_status !== 'launchable') {
        const launchReason = runtimeIdentity.reviewer_subagent_launch_reason
            || 'Reviewer subagent launch is not currently attested.';
        const launchRemediation = runtimeIdentity.reviewer_subagent_launch_remediation
            ? ` ${runtimeIdentity.reviewer_subagent_launch_remediation}`
            : '';
        errors.push(
            `Completion cannot accept mandatory review evidence because delegated reviewer launch is ` +
            `'${runtimeIdentity.reviewer_subagent_launch_status}' for required reviews ` +
            `${requiredReviewTypesForRuntime.join(', ')}. ${launchReason}${launchRemediation}`
        );
    }
    const scopeCategory = typeof preflight.scope_category === 'string' ? preflight.scope_category : null;

    const {
        reviewArtifacts,
        receiptReviewTrustSummary,
        reviewGateTrustSummary
    } = collectRequiredReviewEvidence({
        reviewsRoot,
        taskId: resolvedTaskId || '',
        preflight,
        preflightPath: validatedPreflight.preflight_path || '',
        preflightSha256: validatedPreflight.preflight_hash || '',
        reviewEvidencePath,
        requiredReviews,
        scopeCategory,
        orderedEvents,
        errors
    });

    // Review-skill invocation evidence for code-changing tasks.
    const reviewSkillEvidence = validateReviewSkillEvidence(
        orderedEvents,
        requiredReviews,
        reviewArtifacts,
        codeChanged,
        timelinePath,
        executionProvider,
        runtimeIdentity.canonical_source_of_truth,
        runtimeIdentity.task_mode_identity_backfilled,
        runtimeIdentity.execution_provider_source,
        reviewExecutionPolicyMode,
        repoRoot,
        effectiveReviewSkillCandidates,
        reviewDependencyGraph
    );
    errors.push(...reviewSkillEvidence.violations);

    stageSequence.review_skill_ids = reviewSkillEvidence.skill_ids;
    stageSequence.review_skill_reference_paths = reviewSkillEvidence.reference_paths;
    stageSequence.review_artifact_keys = reviewSkillEvidence.artifact_keys;
    stageSequence.reviewer_execution_modes = reviewSkillEvidence.reviewer_execution_modes;

    // Build reviewer routing enforcement summary.
    const routingPolicy = resolveReviewerRoutingPolicy(executionProvider, runtimeIdentity.execution_provider_source);
    const reviewerRoutingEnforcement = {
        canonical_source_of_truth: runtimeIdentity.canonical_source_of_truth,
        canonical_entrypoint: runtimeIdentity.canonical_entrypoint,
        execution_provider: runtimeIdentity.execution_provider,
        execution_provider_source: runtimeIdentity.execution_provider_source,
        routed_to: runtimeIdentity.routed_to,
        provider_bridge: runtimeIdentity.provider_bridge,
        identity_status: runtimeIdentity.identity_status,
        identity_violations: runtimeIdentity.violations,
        no_delegate_mode: runtimeIdentity.no_delegate_mode,
        reviewer_subagent_launch_status: runtimeIdentity.reviewer_subagent_launch_status,
        reviewer_subagent_launch_reason: runtimeIdentity.reviewer_subagent_launch_reason,
        reviewer_subagent_launch_remediation: runtimeIdentity.reviewer_subagent_launch_remediation,
        source_of_truth: routingPolicy.source_of_truth,
        capability_level: routingPolicy.capability_level,
        delegation_required: routingPolicy.delegation_required,
        expected_execution_mode: routingPolicy.expected_execution_mode,
        fallback_allowed: routingPolicy.fallback_allowed,
        fallback_reason_required: routingPolicy.fallback_reason_required,
        observed_execution_modes: reviewSkillEvidence.reviewer_execution_modes,
        enforcement_level: 'hard_block'
    };
    const reviewTrustSummary = resolveCompletionReviewTrustSummary({
        requiredReviews,
        scopeCategory,
        receiptReviewTrustSummary,
        reviewGateTrustSummary
    });
    const deferredFollowupEvidence: DeferredFollowupValidationResult = validateStrictDeferredReviewFollowups({
        repoRoot,
        taskId: resolvedTaskId || '',
        activeProfile,
        reviewFindings: Object.entries(reviewArtifacts).map(([reviewType, artifact]) => ({
            reviewType,
            artifactPath: artifact.path,
            findings: artifact.findings_evidence.deferred_findings
        }))
    });
    errors.push(...deferredFollowupEvidence.violations);

    // Plan metadata from task-mode evidence (informational, never blocks)
    const planEvidence = {
        plan_guided: !!taskModeEvidence.plan,
        plan_path: taskModeEvidence.plan?.plan_path ?? null,
        plan_sha256: taskModeEvidence.plan?.plan_sha256 ?? null,
        plan_summary: taskModeEvidence.plan?.plan_summary ?? null
    };

    const fullSuiteValidationEvidence = collectFullSuiteValidationEvidence({
        enabled: fullSuiteValidationConfig.enabled,
        required: fullSuiteValidationRequired,
        reviewsRoot,
        taskId: String(resolvedTaskId || '').trim(),
        repoRoot,
        timelinePath,
        orderedEvents,
        expectedPreflightPath: validatedPreflight.preflight_path || '',
        expectedPreflightSha256: validatedPreflight.preflight_hash || '',
        expectedCompileGateTimestamp: latestCompileGatePassedTimestamp,
        expectedCommand: fullSuiteValidationConfig.command,
        fullSuiteNotRequiredForDocsOnly,
        errors
    });

    const projectMemoryImpactEvidence = getProjectMemoryImpactLifecycleEvidence({
        repoRoot,
        taskId: resolvedTaskId || '',
        preflightPath
    });
    errors.push(...validateProjectMemoryImpactForCompletion({
        evidence: projectMemoryImpactEvidence,
        orderedEvents,
        fullSuiteValidationEnabled: fullSuiteValidationRequired,
        timelinePath,
        docImpactEvidence: docImpactEvidence as Record<string, unknown> | null
    }));

    const status = errors.length > 0 ? 'FAILED' : 'PASSED';
    const outcome = errors.length > 0 ? 'FAIL' : 'PASS';
    const currentTaskIntent = resolvedTaskId
        ? readTaskQueueEntries(repoRoot).get(resolvedTaskId)?.title || taskModeEvidence.task_summary
        : taskModeEvidence.task_summary;
    const coherentCycleRestartCommand = stageSequence.violations.length > 0 && resolvedTaskId
        ? buildCoherentCycleRestartCommand(
            repoRoot,
            resolvedTaskId,
            normalizePath(preflightPath),
            taskModeEvidence.evidence_path,
            compileCommandsPath,
            compileOutputFiltersPath,
            {
                requiresOperatorConfirmation:
                    taskModeEvidence.orchestrator_work === true
                    || taskModeEvidence.workflow_config_work === true,
                taskIntent: currentTaskIntent
            }
        )
        : null;
    const reviewCycleRecoveryRelevant = resolvedTaskId
        && stageSequence.violations.length === 0
        && errors.length > 0
        && (
            reviewSkillEvidence.violations.length > 0
            || (!timelineEventTypes.has('REVIEW_GATE_PASSED') && !timelineEventTypes.has('REVIEW_GATE_PASSED_WITH_OVERRIDE'))
            || effectiveReviewContracts.some(([reviewKey]) => {
                if (!requiredReviews[reviewKey]) {
                    return false;
                }
                const artifact = reviewArtifacts[reviewKey];
                if (!artifact) {
                    return true;
                }
                return !artifact.content
                    || !artifact.reviewContext
                    || !artifact.receipt
                    || artifact.findings_evidence.violations.length > 0;
            })
        );
    const reviewCycleRestartCommand = reviewCycleRecoveryRelevant
        ? buildReviewCycleRestartCommand(
            repoRoot,
            resolvedTaskId,
            normalizePath(preflightPath),
            taskModeEvidence.evidence_path,
            compileCommandsPath,
            compileOutputFiltersPath
        )
        : null;

    return {
        status,
        outcome,
        task_id: resolvedTaskId,
        repo_root: normalizePath(repoRoot),
        preflight_path: normalizePath(preflightPath),
        reviews_root: normalizePath(reviewsRoot),
        task_mode_path: taskModeEvidence.evidence_path,
        rule_pack_path: rulePackEvidence.evidence_path,
        handshake_path: handshakeEvidence.evidence_path,
        shell_smoke_path: shellSmokeEvidence.evidence_path,
        compile_evidence_path: normalizePath(compileEvidencePath),
        review_evidence_path: normalizePath(reviewEvidencePath),
        doc_impact_path: normalizePath(docImpactPath),
        timeline_path: normalizePath(timelinePath),
        review_artifacts: reviewArtifacts,
        scope_category: scopeCategory,
        stage_sequence_evidence: stageSequence,
        reviewer_routing_enforcement: reviewerRoutingEnforcement,
        review_trust_summary: reviewTrustSummary,
        deferred_followup_evidence: deferredFollowupEvidence,
        full_suite_validation_evidence: fullSuiteValidationEvidence,
        project_memory_impact_evidence: projectMemoryImpactEvidence,
        zero_diff_evidence: zeroDiffEvidence,
        dirty_workspace_protection_evidence: dirtyWorkspaceProtectionEvidence,
        compile_generated_protected_artifact_evidence: compileGeneratedProtectedArtifactValidation,
        plan: planEvidence,
        isolation_mode_warnings: isolationWarnings,
        coherent_cycle_restart_command: coherentCycleRestartCommand,
        review_cycle_restart_command: reviewCycleRestartCommand,
        violations: errors
    };
}
