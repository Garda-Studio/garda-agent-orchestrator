import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    EXIT_GATE_FAILURE
} from '../../../exit-codes';
import {
    emitMandatoryImplementationStartedEventAsync
} from '../../../../gate-runtime/lifecycle-events';
import {
    appendMandatoryTaskEventAsync,
    assertValidTaskId
} from '../../../../gate-runtime/task-events';
import type { CommandCompactnessAudit } from '../../../../gates/task-events-summary/task-events-summary';
import {
    getCompileCommandProfile,
    getPreflightContext,
    getWorkspaceSnapshot,
    validateCompileGateCommand
} from '../../../../gates/compile/compile-gate';
import {
    classifyCompileInfraRecoveryHint,
    formatCompileInfraRecoveryHintLine
} from '../../../../gates/compile/compile-infra-recovery-hints';
import {
    getWorkspaceSnapshotCached
} from '../../../../gates/workspace/workspace-snapshot-cache';
import {
    buildDomainScopeFingerprints
} from '../../../../gates/scope/domain-scope-fingerprints';
import {
    detectProtectedDirtyWorkspaceDrift,
    getProtectedDirtyWorkspaceScopeFromPreflight
} from '../../../../gates/workspace/dirty-worktree-protection';
import { assertSingleActiveImplementationOwner } from '../../../../gates/workspace/active-implementation-ownership';
import {
    captureCompileGeneratedProtectedArtifactHashes,
    type CompileGeneratedProtectedArtifactEvidence
} from '../../../../gates/protected-control-plane/compile-generated-protected-artifacts';
import {
    getProtectedManifestLifecycleGuard
} from '../../../../gates/protected-control-plane/protected-manifest-guard';
import {
    getTaskModeEvidence,
    getTaskModeEvidenceViolations
} from '../../../../gates/task-mode/task-mode';
import {
    validateTaskPlan,
    computeTaskPlanDigest,
    isApprovedPlan,
    detectPlanDrift
} from '../../../../schemas/task-plan';
import type { PlanDriftResult } from '../../../../schemas/task-plan';
import {
    getRulePackEvidence,
    getPostPreflightSequenceEvidence,
    getRulePackEvidenceViolations
} from '../../../../gates/rule-pack/rule-pack';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    normalizeOptionalPath,
    removeArtifactIfExists,
    resolveDefaultMetricsPath,
    resolveDefaultReviewsPath,
    resolvePathForWrite,
    writeCompileEvidence,
    writeTextArtifact
} from '../../../gate-cli/gates-artifacts';
import {
    type OutputTelemetrySummary
} from '../../../gate-cli/gates-formatter';
import {
    expandValueList,
    parseBooleanOption,
    parseIntOption
} from '../../../gate-cli/gates-parser';
import { requireResolvedPath } from '../../shared-command-utils';
import {
    getErrorMessage,
    resolveOrchestratorRoot,
    appendMetricsIfEnabled
} from './gate-flow-helpers';
import { resolveBudgetTokensFromForecast, resolveOutputFiltersPath } from './output-budget-filter';
import {
    buildCompileScopeDriftMessage,
    evaluateCompileProtectedManifestGuard,
    evaluateCompileWorkflowConfigGuard,
    evaluatePostCompileProtectedManifestGuard
} from './compile-flow-scope-guards';
import {
    buildCompileOutputPresentation,
    executeCompileCommands,
    formatCompileOutputRetentionLine
} from './compile-flow-execution-retention';
import {
    appendNextStepRecoveryHint,
    buildUnconfiguredCompileGateCommandMessage,
    buildClassifyChangeOrchestratorWorkRestartCommand,
    readConfiguredCompileGateCommandForCompileGate,
    readConfiguredFullSuiteCommandForCompileGate,
    readCurrentTaskSummary
} from './compile-flow-shared-evidence';
import {
    evaluateGateFlowOptionalSkillSelection,
    evaluateGateFlowStartupDiagnostics
} from '../support/gate-flow-runtime';
import { runCompileFlowPreflightPipeline } from './compile-flow-preflight-pipeline';

export { runClassifyChangeCommand } from './compile-flow-classify';
export type { ClassifyChangeCommandOptions } from './compile-flow-classify';

type CompileCommandProfile = ReturnType<typeof getCompileCommandProfile>;
type WorkspaceSnapshot = ReturnType<typeof getWorkspaceSnapshot>;
type PreflightContext = ReturnType<typeof getPreflightContext>;
type CommandPolicyAudit = CommandCompactnessAudit;

export interface CompileGateCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    taskModePath?: string;
    rulePackPath?: string;
    failTailLines?: unknown;
    metricsPath?: string;
    outputFiltersPath?: string;
    compileEvidencePath?: string;
    compileOutputPath?: string;
    commandsPath?: string;
    preflightPath?: string;
    emitMetrics?: unknown;
    allowPlanDrift?: unknown;
    allowPlanDriftReason?: string;
    allowFullTestCompileCommand?: unknown;
    allowFullTestCompileCommandReason?: string;
}

export async function runCompileGateCommand(options: CompileGateCommandOptions): Promise<{ outputLines: string[]; exitCode: number }> {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const resolvedTaskId = assertValidTaskId(String(options.taskId || '').trim());
    const failTailLines = parseIntOption(options.failTailLines, 50, 1);
    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    const outputFiltersPath = resolveOutputFiltersPath(repoRoot, options.outputFiltersPath || '');
    const compileEvidencePath = options.compileEvidencePath
        ? requireResolvedPath(resolvePathForWrite(options.compileEvidencePath, repoRoot), 'CompileEvidencePath')
        : resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`);
    const compileOutputPath = options.compileOutputPath
        ? requireResolvedPath(resolvePathForWrite(options.compileOutputPath, repoRoot), 'CompileOutputPath')
        : resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-output.log`);
    const allowFullTestCompileCommand = parseBooleanOption(options.allowFullTestCompileCommand, false);
    const allowFullTestCompileCommandReason = String(options.allowFullTestCompileCommandReason || '').trim();
    if (allowFullTestCompileCommand && !allowFullTestCompileCommandReason) {
        throw new Error('--allow-full-test-compile-command requires --allow-full-test-compile-command-reason.');
    }

    let resolvedCommandsPath: string | null = null;
    let compileCommands: string[] = [];
    let compileCommandSource: 'workflow_config' | 'unconfigured' = 'unconfigured';
    let compileWorkflowConfigPath: string | null = null;
    let resolvedPreflightPath: string | null = null;
    let preflightHash: string | null = null;
    let preflightContext: PreflightContext | null = null;
    let workspaceSnapshot: WorkspaceSnapshot | null = null;
    let taskModeEvidence = getTaskModeEvidence(repoRoot, resolvedTaskId, String(options.taskModePath || ''));
    let rulePackEvidence = getRulePackEvidence(repoRoot, resolvedTaskId, 'TASK_ENTRY', {
        artifactPath: String(options.rulePackPath || ''),
        taskModePath: String(options.taskModePath || '')
    });
    let warningCount = 0;
    let errorCount = 0;
    let exitCode = 0;
    let exceptionMessage: string | null = null;
    let selectedCommandProfile: CompileCommandProfile | null = null;
    let selectedCommandIndex = 0;
    let budgetTokensForOutputFilters: number | null = null;
    const compileOutputLines: string[] = [];
    const compileOutputChunks: string[] = [];
    const compileCommandAudits: CommandPolicyAudit[] = [];
    const startedAt = Date.now();
    let compileOutputInitialized = false;
    let planDriftResult: PlanDriftResult | null = null;
    let dirtyWorkspaceProtectionDrift = detectProtectedDirtyWorkspaceDrift(repoRoot, null);
    let protectedManifestGuard: ReturnType<typeof getProtectedManifestLifecycleGuard> | null = null;
    let compileGeneratedProtectedArtifacts: CompileGeneratedProtectedArtifactEvidence | null = null;
    let postPreflightSequenceEvidence: ReturnType<typeof getPostPreflightSequenceEvidence> | null = null;
    let workflowConfigBaselineForCompile: Record<string, string | null> | null = null;

    try {
        const fullSuiteCommand = readConfiguredFullSuiteCommandForCompileGate(repoRoot);
        const configuredCompileGateCommand = readConfiguredCompileGateCommandForCompileGate(repoRoot);
        compileWorkflowConfigPath = configuredCompileGateCommand.configPath;
        if (configuredCompileGateCommand.command) {
            compileCommandSource = 'workflow_config';
            validateCompileGateCommand(configuredCompileGateCommand.command, configuredCompileGateCommand.configPath, {
                fullSuiteCommand,
                allowFullTestCompileCommand,
                allowFullTestCompileCommandReason
            });
            compileCommands = [configuredCompileGateCommand.command];
        } else {
            compileCommands = [];
            compileCommandSource = 'unconfigured';
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = buildUnconfiguredCompileGateCommandMessage(
                repoRoot,
                configuredCompileGateCommand.configPath
            );
        }
        const sharedPreflight = await runCompileFlowPreflightPipeline({
            repoRoot,
            orchestratorRoot,
            taskId: resolvedTaskId,
            taskModePath: String(options.taskModePath || ''),
            rulePackPath: String(options.rulePackPath || ''),
            preflightPath: options.preflightPath,
            taskModeEvidence
        });
        resolvedPreflightPath = sharedPreflight.resolvedPreflightPath;
        preflightContext = sharedPreflight.preflightContext;
        rulePackEvidence = sharedPreflight.rulePackEvidence;
        taskModeEvidence = sharedPreflight.taskModeEvidence;
        const timelinePath = sharedPreflight.timelinePath;
        const timelineReadiness = sharedPreflight.timelineReadiness;
        const taskModeViolations = getTaskModeEvidenceViolations(taskModeEvidence);
        const rulePackViolations = getRulePackEvidenceViolations(rulePackEvidence);
        if (taskModeViolations.length > 0) {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = taskModeViolations.join(' ');
        } else if (rulePackViolations.length > 0) {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = rulePackViolations.join(' ');
        }
        const preflightChangedFiles = expandValueList(preflightContext.changed_files, { splitDelimiters: false });
        const preflightAuthorizedFiles = expandValueList(preflightContext.authorized_files, { splitDelimiters: false });
        const preCompileManifestGuard = evaluateCompileProtectedManifestGuard({
            repoRoot,
            taskModeEvidence,
            phaseLabel: 'compile gate',
            preflight: preflightContext.preflight,
            preflightChangedFiles: preflightAuthorizedFiles,
            buildRestartCommand: (changedFiles) => buildClassifyChangeOrchestratorWorkRestartCommand({
                repoRoot,
                taskId: resolvedTaskId,
                taskModeEvidence,
                taskSummary: taskModeEvidence.task_summary || null,
                changedFiles
            })
        });
        const preCompileManifestEvidence = preCompileManifestGuard.manifestEvidence;
        const preCompileTaskOwnedManifestFiles = preCompileManifestGuard.taskOwnedManifestFiles;
        const preCompileGeneratedArtifactHashes = captureCompileGeneratedProtectedArtifactHashes(repoRoot);
        protectedManifestGuard = preCompileManifestGuard.guard;
        if (!exceptionMessage && protectedManifestGuard.status === 'BLOCK') {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = protectedManifestGuard.violations.join(' ');
        }
        if (!exceptionMessage) {
            workflowConfigBaselineForCompile = taskModeEvidence.workflow_config_file_hashes;
            const workflowConfigGuard = evaluateCompileWorkflowConfigGuard({
                repoRoot,
                taskModeEvidence,
                phaseLabel: 'compile gate',
                baselineFileHashes: workflowConfigBaselineForCompile,
                preflightChangedFiles: preflightAuthorizedFiles
            });
            workflowConfigBaselineForCompile = workflowConfigGuard.baselineFileHashes;
            if (workflowConfigGuard.violations.length > 0) {
                exitCode = EXIT_GATE_FAILURE;
                exceptionMessage = workflowConfigGuard.violations.join(' ');
                if (workflowConfigGuard.scanError) {
                    exceptionMessage += ` Workspace scan warning: ${workflowConfigGuard.scanError}`;
                }
            }
        }
        workspaceSnapshot = getWorkspaceSnapshotCached(
            repoRoot,
            preflightContext.detection_source,
            preflightContext.include_untracked,
            preflightAuthorizedFiles
        );
        dirtyWorkspaceProtectionDrift = detectProtectedDirtyWorkspaceDrift(
            repoRoot,
            getProtectedDirtyWorkspaceScopeFromPreflight(preflightContext.preflight)
        );

        if (!exceptionMessage && timelineReadiness.violations.length > 0) {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = timelineReadiness.violations.join(' ');
        }
        if (!exceptionMessage) {
            const diagnosticsViolations = evaluateGateFlowStartupDiagnostics({
                repoRoot,
                taskId: resolvedTaskId,
                taskModePath: options.taskModePath || '',
                timelinePath
            });
            if (diagnosticsViolations.length > 0) {
                exitCode = EXIT_GATE_FAILURE;
                exceptionMessage = diagnosticsViolations.join(' ');
            }
        }
        if (!exceptionMessage) {
            const optionalSkillSelectionViolations = evaluateGateFlowOptionalSkillSelection({
                orchestratorRoot,
                taskId: resolvedTaskId,
                expectedPreflightPath: normalizeOptionalPath(resolvedPreflightPath) || '',
                expectedPreflightSha256: gateHelpers.fileSha256(resolvedPreflightPath),
                taskSummary: String(readCurrentTaskSummary(repoRoot, resolvedTaskId, taskModeEvidence.task_summary) || ''),
                timelineEvidence: timelineReadiness.timelineEvidence
            });
            if (optionalSkillSelectionViolations.length > 0) {
                exitCode = EXIT_GATE_FAILURE;
                exceptionMessage = optionalSkillSelectionViolations.join(' ');
            }
        }

        const shouldExplainPostPreflightSequence = !!resolvedPreflightPath && (
            !exceptionMessage
            || rulePackEvidence.evidence_status === 'EVIDENCE_FILE_MISSING'
            || rulePackEvidence.evidence_status === 'EVIDENCE_STAGE_MISSING'
            || rulePackEvidence.evidence_status === 'EVIDENCE_PREFLIGHT_PATH_MISMATCH'
            || rulePackEvidence.evidence_status === 'EVIDENCE_PREFLIGHT_HASH_MISMATCH'
            || rulePackEvidence.evidence_status === 'EVIDENCE_NOT_PASS'
        );
        if (shouldExplainPostPreflightSequence && resolvedPreflightPath && timelineReadiness.violations.length === 0) {
            postPreflightSequenceEvidence = getPostPreflightSequenceEvidence(repoRoot, resolvedTaskId, resolvedPreflightPath, {
                artifactPath: String(options.rulePackPath || ''),
                taskModePath: String(options.taskModePath || '')
            });
            if (postPreflightSequenceEvidence.violations.length > 0) {
                exitCode = EXIT_GATE_FAILURE;
                exceptionMessage = postPreflightSequenceEvidence.violations.join(' ');
            }
        }

        budgetTokensForOutputFilters = resolveBudgetTokensFromForecast(
            preflightContext ? (preflightContext as Record<string, unknown>).budget_forecast : null
        );

        const scopeDriftMessage = buildCompileScopeDriftMessage({
            preflightContext,
            workspaceSnapshot
        });
        if (!exceptionMessage && scopeDriftMessage) {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = scopeDriftMessage;
        }
        if (!exceptionMessage && dirtyWorkspaceProtectionDrift.status === 'DRIFT_DETECTED') {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = dirtyWorkspaceProtectionDrift.violations.join(' ');
        }

        if (!exceptionMessage && taskModeEvidence.plan && taskModeEvidence.plan.plan_path) {
            let loadedPlan: import('../../../../schemas/task-plan').TaskPlan | null = null;
            let planLoadError: string | null = null;
            try {
                const planFilePath = gateHelpers.resolvePathInsideRepo(taskModeEvidence.plan.plan_path, repoRoot, { allowMissing: false });
                if (!planFilePath || !fs.existsSync(planFilePath) || !fs.statSync(planFilePath).isFile()) {
                    planLoadError = `Plan artifact not found at '${taskModeEvidence.plan.plan_path}'. Replan the task or remove plan metadata.`;
                } else {
                    const planJson = JSON.parse(fs.readFileSync(planFilePath, 'utf8'));
                    const validated = validateTaskPlan(planJson);
                    if (validated.task_id !== resolvedTaskId) {
                        planLoadError = `Plan task_id '${validated.task_id}' does not match task '${resolvedTaskId}'.`;
                    } else if (!isApprovedPlan(validated)) {
                        planLoadError = `Plan status is '${validated.status}'; only approved plans enforce drift detection.`;
                    } else {
                        const digest = computeTaskPlanDigest(validated);
                        if (taskModeEvidence.plan.plan_sha256 && digest !== taskModeEvidence.plan.plan_sha256) {
                            planLoadError = `Plan integrity mismatch: task-mode sha256='${taskModeEvidence.plan.plan_sha256}' vs current='${digest}'. Plan may have been edited after approval.`;
                        } else {
                            loadedPlan = validated;
                        }
                    }
                }
            } catch (planError: unknown) {
                planLoadError = `Plan load/parse failed: ${getErrorMessage(planError)}. Replan the task or remove plan metadata.`;
            }

            if (planLoadError) {
                exitCode = EXIT_GATE_FAILURE;
                exceptionMessage = planLoadError;
            } else {
                planDriftResult = detectPlanDrift({
                    plan: loadedPlan,
                    actualFiles: preflightContext.changed_files as string[],
                    allowPlanDrift: parseBooleanOption(options.allowPlanDrift, false),
                    allowPlanDriftReason: String(options.allowPlanDriftReason || '').trim() || undefined
                });

                if (planDriftResult.status === 'REPLAN_REQUIRED') {
                    exitCode = EXIT_GATE_FAILURE;
                    exceptionMessage = planDriftResult.violations.join(' ');
                }
            }
        }

        if (!exceptionMessage) {
            assertSingleActiveImplementationOwner(repoRoot, resolvedTaskId, 'compile gate');
            await emitMandatoryImplementationStartedEventAsync(orchestratorRoot, resolvedTaskId, {
                preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                commands_path: normalizeOptionalPath(resolvedCommandsPath),
                changed_files_count: preflightContext.changed_files.length,
                changed_lines_total: preflightContext.changed_lines_total
            });
            preflightHash = gateHelpers.fileSha256(resolvedPreflightPath);
            compileOutputInitialized = true;

            const compileExecution = await executeCompileCommands({
                commands: compileCommands,
                repoRoot
            });
            compileOutputLines.push(...compileExecution.outputLines);
            compileOutputChunks.push(...compileExecution.outputChunks);
            compileCommandAudits.push(...compileExecution.commandAudits);
            warningCount = compileExecution.warningCount;
            errorCount = compileExecution.errorCount;
            selectedCommandProfile = compileExecution.selectedCommandProfile;
            selectedCommandIndex = compileExecution.selectedCommandIndex;
            if (compileExecution.exceptionMessage) {
                exitCode = compileExecution.exitCode;
                exceptionMessage = compileExecution.exceptionMessage;
            }
        }
        if (!exceptionMessage) {
            const postCompileWorkflowConfigGuard = evaluateCompileWorkflowConfigGuard({
                repoRoot,
                taskModeEvidence,
                phaseLabel: 'compile output validation',
                baselineFileHashes: workflowConfigBaselineForCompile
            });
            if (postCompileWorkflowConfigGuard.violations.length > 0) {
                exitCode = EXIT_GATE_FAILURE;
                exceptionMessage = postCompileWorkflowConfigGuard.violations.join(' ');
                if (postCompileWorkflowConfigGuard.scanError) {
                    exceptionMessage += ` Workspace scan warning: ${postCompileWorkflowConfigGuard.scanError}`;
                }
            }
        }
        if (!exceptionMessage) {
            const postCompileManifestGuard = evaluatePostCompileProtectedManifestGuard({
                repoRoot,
                taskModeEvidence,
                phaseLabel: 'compile output validation',
                preflight: preflightContext?.preflight,
                preflightChangedFiles,
                preCompileManifestEvidence,
                preCompileTaskOwnedManifestFiles,
                preCompileGeneratedArtifactHashes,
                buildRestartCommand: (changedFiles) => buildClassifyChangeOrchestratorWorkRestartCommand({
                    repoRoot,
                    taskId: resolvedTaskId,
                    taskModeEvidence,
                    taskSummary: taskModeEvidence.task_summary || null,
                    changedFiles
                })
            });
            compileGeneratedProtectedArtifacts =
                postCompileManifestGuard.compileGeneratedProtectedArtifacts;
            if (postCompileManifestGuard?.guard?.status === 'BLOCK') {
                exitCode = EXIT_GATE_FAILURE;
                exceptionMessage = postCompileManifestGuard.guard.violations.join(' ');
            }
        }
    } catch (error) {
        exceptionMessage = getErrorMessage(error);
        if (exitCode === 0) {
            exitCode = EXIT_GATE_FAILURE;
        }
    }
    if (exceptionMessage) {
        exceptionMessage = appendNextStepRecoveryHint(exceptionMessage, repoRoot, resolvedTaskId);
    }
    const infraRecoveryHint = exceptionMessage
        ? classifyCompileInfraRecoveryHint({
            outputLines: compileOutputLines,
            errorMessage: exceptionMessage
        })
        : null;

    const durationMs = Math.max(0, Date.now() - startedAt);
    const outputPresentation = buildCompileOutputPresentation({
        budgetTokensForOutputFilters,
        compileCommands,
        errorCount,
        exceptionMessage,
        failTailLines,
        outputChunks: compileOutputChunks,
        outputFiltersPath,
        outputLines: compileOutputLines,
        selectedCommandProfile,
        warningCount
    });
    const effectiveProfile = outputPresentation.effectiveProfile;
    const selectedOutputProfile = outputPresentation.selectedOutputProfile;
    const filteredOutput = outputPresentation.filteredOutput;
    const outputTelemetry = outputPresentation.outputTelemetry;
    const telemetrySummary: OutputTelemetrySummary = outputPresentation.telemetrySummary;
    const visibleSavingsLine = outputPresentation.visibleSavingsLine;
    const compileOutputText = outputPresentation.compileOutputText;
    const retainCompileOutput = outputPresentation.retainCompileOutput;
    const compileOutputRetention = outputPresentation.compileOutputRetention;
    if (compileOutputPath && compileOutputInitialized) {
        if (retainCompileOutput) {
            writeTextArtifact(compileOutputPath, compileOutputText);
        } else {
            removeArtifactIfExists(compileOutputPath);
        }
    }

    const gateContext: Record<string, unknown> = {
        commands_path: normalizeOptionalPath(resolvedCommandsPath),
        workflow_config_path: normalizeOptionalPath(compileWorkflowConfigPath),
        compile_command_source: compileCommandSource,
        compile_commands: compileCommands,
        compile_command: compileCommands.length > 0 ? compileCommands[0] : null,
        preflight_path: normalizeOptionalPath(resolvedPreflightPath),
        preflight_hash_sha256: preflightHash,
        preflight_detection_source: preflightContext ? preflightContext.detection_source : null,
        preflight_include_untracked: preflightContext ? !!preflightContext.include_untracked : null,
        preflight_changed_files_count: preflightContext ? preflightContext.changed_files_count : null,
        preflight_changed_lines_total: preflightContext ? preflightContext.changed_lines_total : null,
        preflight_changed_files_sha256: preflightContext ? preflightContext.changed_files_sha256 : null,
        preflight_scope_sha256: preflightContext ? preflightContext.scope_sha256 : null,
        preflight_scope_content_sha256: preflightContext ? preflightContext.scope_content_sha256 : null,
        task_mode: taskModeEvidence,
        rule_pack: rulePackEvidence,
        post_preflight_sequence: postPreflightSequenceEvidence,
        scope_detection_source: workspaceSnapshot ? workspaceSnapshot.detection_source : null,
        scope_use_staged: workspaceSnapshot ? !!workspaceSnapshot.use_staged : null,
        scope_include_untracked: workspaceSnapshot ? !!workspaceSnapshot.include_untracked : null,
        scope_authorized_files: workspaceSnapshot ? workspaceSnapshot.authorized_files : [],
        scope_authorized_files_count: workspaceSnapshot ? workspaceSnapshot.authorized_files_count : 0,
        scope_authorized_files_sha256: workspaceSnapshot ? workspaceSnapshot.authorized_files_sha256 : null,
        scope_changed_files: workspaceSnapshot ? workspaceSnapshot.changed_files : [],
        scope_changed_files_count: workspaceSnapshot ? workspaceSnapshot.changed_files_count : 0,
        scope_changed_lines_total: workspaceSnapshot ? workspaceSnapshot.changed_lines_total : 0,
        scope_changed_files_sha256: workspaceSnapshot ? workspaceSnapshot.changed_files_sha256 : null,
        scope_content_sha256: workspaceSnapshot ? workspaceSnapshot.scope_content_sha256 : null,
        scope_sha256: workspaceSnapshot ? workspaceSnapshot.scope_sha256 : null,
        scope_git_change_classification: workspaceSnapshot ? workspaceSnapshot.git_change_classification : null,
        domain_scope_fingerprints: workspaceSnapshot ? buildDomainScopeFingerprints({
            repoRoot,
            detectionSource: workspaceSnapshot.detection_source,
            includeUntracked: !!workspaceSnapshot.include_untracked,
            changedFiles: workspaceSnapshot.changed_files
        }) : null,
        dirty_workspace_protection: dirtyWorkspaceProtectionDrift,
        protected_manifest: protectedManifestGuard ? {
            status: protectedManifestGuard.manifest_evidence.status,
            manifest_path: protectedManifestGuard.manifest_evidence.manifest_path,
            changed_files: protectedManifestGuard.manifest_evidence.changed_files
        } : null,
        compile_generated_protected_artifacts: compileGeneratedProtectedArtifacts,
        evidence_path: normalizeOptionalPath(compileEvidencePath),
        compile_output_path: retainCompileOutput ? normalizeOptionalPath(compileOutputPath) : null,
        compile_output_retention: compileOutputRetention,
        output_filters_path: normalizeOptionalPath(outputFiltersPath),
        command_kind: effectiveProfile.kind,
        command_filter_strategy: effectiveProfile.strategy,
        command_profile_label: effectiveProfile.label,
        selected_output_profile: selectedOutputProfile,
        selected_budget_tier: filteredOutput.budget_tier ?? null,
        selected_command_index: selectedCommandIndex,
        compile_output_lines: compileOutputLines.length,
        compile_output_warning_lines: warningCount,
        compile_output_error_lines: errorCount,
        infra_recovery_hint: infraRecoveryHint,
        duration_ms: durationMs,
        exit_code: exceptionMessage ? exitCode : 0,
        command_policy_audits: compileCommandAudits,
        command_policy_warning_count: compileCommandAudits.reduce((sum, a) => sum + a.warning_count, 0),
        plan_drift: planDriftResult,
        ...outputTelemetry
    };

    if (exceptionMessage) {
        const failureEvent = {
            timestamp_utc: new Date().toISOString(),
            event_type: 'compile_gate_check',
            status: 'FAILED',
            task_id: resolvedTaskId,
            error: exceptionMessage,
            ...gateContext
        };
        appendMetricsIfEnabled(repoRoot, metricsPath, failureEvent, parseBooleanOption(options.emitMetrics, true));
        let failureReason = exceptionMessage;
        try {
            await appendMandatoryTaskEventAsync(orchestratorRoot, resolvedTaskId, 'COMPILE_GATE_FAILED', 'FAIL', 'Compile gate failed.', failureEvent);
        } catch (eventError: unknown) {
            failureReason = `Compile gate failed and mandatory lifecycle event 'COMPILE_GATE_FAILED' could not be appended. Original gate error: ${exceptionMessage} | Event append error: ${getErrorMessage(eventError)}`;
        }
        writeCompileEvidence(compileEvidencePath, resolvedTaskId, gateContext, 'FAILED', 'FAIL', failureReason);

        const outputLines = [
            'COMPILE_GATE_FAILED',
            `CompileSummary: FAILED | duration_ms=${durationMs} | exit_code=${exitCode} | errors=${errorCount} | warnings=${warningCount}`
        ];
        if (compileOutputPath) {
            outputLines.push(`CompileOutputPath: ${gateHelpers.normalizePath(compileOutputPath)}`);
        }
        outputLines.push(formatCompileOutputRetentionLine(compileOutputRetention));
        if (filteredOutput.lines.length > 0) {
            if (telemetrySummary.parser_mode === 'FULL' || telemetrySummary.parser_mode === 'DEGRADED') {
                outputLines.push(
                    `CompileOutputCompactSummary: parser=${telemetrySummary.parser_name} mode=${telemetrySummary.parser_mode} strategy=${telemetrySummary.parser_strategy}`
                );
            } else if (telemetrySummary.filter_mode.startsWith('profile:') && telemetrySummary.fallback_mode === 'none') {
                outputLines.push(`CompileOutputFilteredLines: profile=${telemetrySummary.filter_mode}`);
            } else {
                outputLines.push('CompileOutputFilteredLines:');
            }
            outputLines.push(...filteredOutput.lines);
        }
        if (visibleSavingsLine) {
            outputLines.push(visibleSavingsLine);
        }
        const infraRecoveryHintLine = formatCompileInfraRecoveryHintLine(infraRecoveryHint);
        if (infraRecoveryHintLine) {
            outputLines.push(infraRecoveryHintLine);
        }
        outputLines.push(`Reason: ${failureReason}`);
        return { outputLines, exitCode: EXIT_GATE_FAILURE };
    }

    const successEvent = {
        timestamp_utc: new Date().toISOString(),
        event_type: 'compile_gate_check',
        status: 'PASSED',
        task_id: resolvedTaskId,
        ...gateContext
    };
    appendMetricsIfEnabled(repoRoot, metricsPath, successEvent, parseBooleanOption(options.emitMetrics, true));
    try {
        await appendMandatoryTaskEventAsync(orchestratorRoot, resolvedTaskId, 'COMPILE_GATE_PASSED', 'PASS', 'Compile gate passed.', successEvent);
    } catch (error: unknown) {
        const failureReason = `Compile gate succeeded but mandatory lifecycle event 'COMPILE_GATE_PASSED' could not be appended. ${getErrorMessage(error)}`;
        writeCompileEvidence(compileEvidencePath, resolvedTaskId, gateContext, 'FAILED', 'FAIL', failureReason);
        return {
            outputLines: [
                'COMPILE_GATE_FAILED',
                `CompileSummary: FAILED | duration_ms=${durationMs} | exit_code=0 | errors=${errorCount} | warnings=${warningCount}`,
                `Reason: ${failureReason}`
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }
    writeCompileEvidence(compileEvidencePath, resolvedTaskId, gateContext, 'PASSED', 'PASS', null);

    const outputLines = [
        'COMPILE_GATE_PASSED',
        `CompileSummary: PASSED | duration_ms=${durationMs} | exit_code=0 | errors=${errorCount} | warnings=${warningCount}`
    ];
    if (planDriftResult) {
        outputLines.push(`PlanDrift: ${planDriftResult.status}`);
        if (planDriftResult.status === 'PLAN_DRIFT') {
            outputLines.push(`PlanDriftExtraFiles: ${planDriftResult.extra_files.join(', ')}`);
        }
    }
    if (retainCompileOutput && compileOutputPath) {
        outputLines.push(`CompileOutputPath: ${gateHelpers.normalizePath(compileOutputPath)}`);
    }
    outputLines.push(formatCompileOutputRetentionLine(compileOutputRetention));
    if (visibleSavingsLine) {
        outputLines.push(visibleSavingsLine);
    }
    return { outputLines, exitCode: 0 };
}
