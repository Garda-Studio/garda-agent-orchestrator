import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import { getPreflightContext } from '../../../../gates/compile/compile-gate';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    type CompileGateCommandOptions
} from '../compile/compile-flow';
import { buildNextStepRecoveryCommand } from '../compile/compile-flow-shared-evidence';
import { resolveDefaultReviewsPath } from '../../../gate-cli/gates-artifacts';
import { resolveOrchestratorRoot } from '../compile/gate-flow-helpers';
import {
    runEnterTaskModeCommand,
    runHandshakeDiagnosticsCommand,
    runLoadRulePackCommand,
    runShellSmokePreflightCommand
} from '../task-mode/task-mode-flow';
import {
    getEffectiveDepthFromPreflight,
    getTaskEntryRuleFilesForDepth,
    normalizeRuleFileList,
    resolveReplayScope
} from './recovery-flow-replay-scope';
import { buildCoherentCycleRestartedOutput } from './recovery-flow-rendering';
import type { RestartCoherentCycleCommandOptions } from './recovery-flow-types';
import {
    buildOptionalSkillRebindDetails,
    readRestartOptionalSkillActivationSnapshot,
    readRestartOptionalSkillDeclineSnapshot,
    rebindRestartOptionalSkillActivationsForCurrentCycle,
    rebindRestartOptionalSkillDeclinesForCurrentCycle
} from './recovery-flow-optional-skills';
import {
    appendRestartCompletedEvidence,
    collectRequiredRestartReviewTypes,
    ensureRestartStepPassed,
    resolveRecoveryPreflightPath,
    resolveRestartAllowedDirtyWorkflowConfigFiles,
    toNonNegativeRestartCount
} from './recovery-flow-restart-evidence';
import { runRecoveryFlowPreflightPipeline } from './recovery-flow-preflight-pipeline';
import { readInterruptedCoherentCycleReadiness } from './recovery-flow-interrupted-coherent-cycle';

export async function runRestartCoherentCycleCommand(
    options: RestartCoherentCycleCommandOptions
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
    const replayScope = resolveReplayScope(options, previousPreflight);
    const taskSummary = String(options.taskIntent || previousTaskMode.task_summary || '').trim();
    if (!taskSummary) {
        throw new Error('Task intent could not be resolved for coherent-cycle restart.');
    }
    const allowedDirtyWorkflowConfigFiles = previousTaskMode.orchestrator_work === true
        && previousTaskMode.workflow_config_work === true
        ? resolveRestartAllowedDirtyWorkflowConfigFiles(repoRoot, previousPreflight, replayScope.plannedChangedFiles)
        : [];

    const compileEvidencePath = resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`);
    const interruptedCycle = readInterruptedCoherentCycleReadiness({
        repoRoot,
        taskId: resolvedTaskId,
        taskModePath: resolvedTaskModePath,
        preflightPath: resolvedPreflightPath,
        compileEvidencePath
    });
    if (interruptedCycle.ready) {
        const refreshedRequiredReviews = previousPreflight.preflight.required_reviews as Record<string, boolean>;
        const nextStepSummary = 'continue from current compile evidence after finalizing the interrupted coherent-cycle restart.';
        const restartArtifactPath = appendRestartCompletedEvidence({
            repoRoot,
            taskId: resolvedTaskId,
            eventType: 'COHERENT_CYCLE_RESTARTED',
            artifactSuffix: '-coherent-cycle-restart.json',
            message: 'Interrupted coherent task cycle finalized from current verified compile evidence.',
            taskModePath: resolvedTaskModePath,
            preflightPath: resolvedPreflightPath,
            compileEvidencePath,
            detectionSource: replayScope.detectionSource,
            plannedChangedFilesCount: replayScope.plannedChangedFiles.length,
            detectedChangedFilesCount: toNonNegativeRestartCount(
                previousPreflight.changed_files_count,
                previousPreflight.changed_files.length
            ),
            elapsedMs: Date.now() - startedAt,
            restartReason: 'coherent_cycle_restart_resumed_after_interrupted_shell_smoke',
            nextStepSummary,
            extraDetails: {
                resumed_interrupted_restart: true,
                failed_shell_smoke_sequence: interruptedCycle.failedShellSmokeSequence,
                passed_shell_smoke_sequence: interruptedCycle.passedShellSmokeSequence,
                compile_sequence: interruptedCycle.compileSequence
            }
        });
        return {
            outputLines: buildCoherentCycleRestartedOutput({
                taskId: resolvedTaskId,
                navigatorCommand: buildNextStepRecoveryCommand(repoRoot, resolvedTaskId),
                taskModePath: resolvedTaskModePath,
                preflightPath: resolvedPreflightPath,
                restartArtifactPath,
                detectionSource: replayScope.detectionSource,
                plannedChangedFilesCount: replayScope.plannedChangedFiles.length,
                changedFilesCount: previousPreflight.changed_files_count,
                preflightMode: previousPreflight.preflight.mode,
                preflightScopeCategory: previousPreflight.preflight.scope_category,
                preflightChangedFilesCount: previousPreflight.changed_files_count,
                preflightRequiredReviewTypes: collectRequiredRestartReviewTypes(refreshedRequiredReviews)
            }),
            exitCode: 0
        };
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

        ensureRestartStepPassed('enter-task-mode', runEnterTaskModeCommand({
            repoRoot,
            taskId: resolvedTaskId,
            artifactPath: resolvedTaskModePath,
            entryMode: previousTaskMode.entry_mode || 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: previousTaskMode.requested_depth || 2,
            effectiveDepth: previousTaskMode.effective_depth || previousTaskMode.requested_depth || 2,
            taskSummary,
            startBanner: previousTaskMode.start_banner,
            plannedChangedFiles: replayScope.plannedChangedFiles,
            orchestratorWork: previousTaskMode.orchestrator_work === true,
            workflowConfigWork: previousTaskMode.workflow_config_work === true,
            operatorConfirmed: options.operatorConfirmed,
            operatorConfirmedAtUtc: options.operatorConfirmedAtUtc,
            allowedDirtyWorkflowConfigFiles,
            workflowConfigFileHashesOverride: previousTaskMode.workflow_config_file_hashes,
            workflowConfigCompatibilityBaselineFilesOverride: previousTaskMode.workflow_config_compatibility_baseline_files,
            provider: previousTaskMode.provider || undefined,
            routedTo: previousTaskMode.routed_to || undefined,
            planPath: previousTaskMode.plan?.plan_path || undefined,
            emitMetrics: options.emitMetrics
        }));

        ensureRestartStepPassed('load-rule-pack (TASK_ENTRY)', runLoadRulePackCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
            stage: 'TASK_ENTRY',
            loadedRuleFiles: getTaskEntryRuleFilesForDepth(
                previousTaskMode.effective_depth || previousTaskMode.requested_depth || 2
            ),
            emitMetrics: options.emitMetrics
        }));

        ensureRestartStepPassed('handshake-diagnostics', runHandshakeDiagnosticsCommand({
            repoRoot,
            taskId: resolvedTaskId,
            provider: previousTaskMode.provider || undefined,
            emitMetrics: options.emitMetrics
        }));

        ensureRestartStepPassed('shell-smoke-preflight', runShellSmokePreflightCommand({
            repoRoot,
            taskId: resolvedTaskId,
            provider: previousTaskMode.provider || undefined,
            emitMetrics: options.emitMetrics
        }));

        const refreshedPreflightPath = resolveRecoveryPreflightPath(
            repoRoot,
            resolvedTaskId,
            options.preflightOutputPath || resolvedPreflightPath,
            'PreflightOutputPath'
        );
        runClassifyChangeCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
            outputPath: refreshedPreflightPath,
            taskIntent: taskSummary,
            changedFiles: replayScope.changedFiles,
            useStaged: replayScope.useStaged,
            includeUntracked: replayScope.includeUntracked,
            emitMetrics: options.emitMetrics
        });
        const refreshedPreflight = getPreflightContext(refreshedPreflightPath, resolvedTaskId);
        const refreshedRequiredReviews = refreshedPreflight.preflight.required_reviews as Record<string, boolean>;
        const effectiveDepth = getEffectiveDepthFromPreflight(previousTaskMode, refreshedPreflight);

        ensureRestartStepPassed('load-rule-pack (POST_PREFLIGHT)', runLoadRulePackCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
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
            allowPlanDrift: options.allowPlanDrift,
            allowPlanDriftReason: options.allowPlanDriftReason,
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
            preflightPath: refreshedPreflightPath,
            commandsPath: options.commandsPath,
            outputFiltersPath: options.outputFiltersPath,
            failTailLines: options.failTailLines,
            emitMetrics: options.emitMetrics
        } as CompileGateCommandOptions);
        ensureRestartStepPassed('compile-gate', compileResult);
        const nextStepSummary = 'materialize review artifacts for the new compile cycle, then rerun required-reviews-check, doc-impact-gate, and completion-gate.';
        const restartArtifactPath = appendRestartCompletedEvidence({
            repoRoot,
            taskId: resolvedTaskId,
            eventType: 'COHERENT_CYCLE_RESTARTED',
            artifactSuffix: '-coherent-cycle-restart.json',
            message: 'Coherent task cycle restarted after compile gate pass.',
            taskModePath: resolvedTaskModePath,
            preflightPath: refreshedPreflightPath,
            compileEvidencePath,
            detectionSource: replayScope.detectionSource,
            plannedChangedFilesCount: replayScope.plannedChangedFiles.length,
            detectedChangedFilesCount: toNonNegativeRestartCount(
                refreshedPreflight.changed_files_count,
                refreshedPreflight.changed_files.length
            ),
            elapsedMs: Date.now() - startedAt,
            restartReason: 'coherent_cycle_restart_after_downstream_boundary_or_invalid_preflight_order',
            nextStepSummary,
            extraDetails: buildOptionalSkillRebindDetails(optionalSkillActivationRebind, optionalSkillDeclineRebind)
        });

        return {
            outputLines: buildCoherentCycleRestartedOutput({
                taskId: resolvedTaskId,
                navigatorCommand: buildNextStepRecoveryCommand(repoRoot, resolvedTaskId),
                taskModePath: resolvedTaskModePath,
                preflightPath: refreshedPreflightPath,
                restartArtifactPath,
                detectionSource: replayScope.detectionSource,
                plannedChangedFilesCount: replayScope.plannedChangedFiles.length,
                changedFilesCount: refreshedPreflight.changed_files_count,
                preflightMode: refreshedPreflight.preflight.mode,
                preflightScopeCategory: refreshedPreflight.preflight.scope_category,
                preflightChangedFilesCount: refreshedPreflight.changed_files_count,
                preflightRequiredReviewTypes: collectRequiredRestartReviewTypes(refreshedRequiredReviews)
            }),
            exitCode: 0
        };
    } catch (error: unknown) {
        return {
            outputLines: [
                'COHERENT_CYCLE_RESTART_FAILED',
                `TaskId: ${resolvedTaskId}`,
                error instanceof Error ? error.message : String(error)
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }
}
