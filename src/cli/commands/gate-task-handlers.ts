import * as path from 'node:path';
import {
    emitMandatoryCompletionGateEventAsync
} from '../../gate-runtime/lifecycle-events';
import * as gateHelpers from '../../gates/shared/helpers';
import { formatCompletionGateResult, runCompletionGate } from '../../gates/completion/completion';
import { formatNextStepText, resolveNextStepFromCliOptions } from '../../gates/next-step/next-step';
import { withCompletionGateFinalizationLockAsync } from '../../gates/locks/finalization-lock';
import {
    runBindRulePackToPreflightCommand,
    runEnterTaskModeCommand,
    runHandshakeDiagnosticsCommand,
    runHumanCommitCommand,
    runLoadRulePackCommand,
    runLogTaskEventCommand,
    runRecordNoOpCommand,
    runRecordReviewCycleContinuationCommand,
    runRecordReviewCycleSplitDecisionCommand,
    runRecordStrictDecompositionDecisionCommand,
    runListSplitRequiredWipCommand,
    runRestoreSplitRequiredWipCommand,
    runRetireSplitRequiredWipCommand,
    runRestartCoherentCycleCommand,
    runRestartReviewCycleCommand,
    runShellSmokePreflightCommand,
    runCommandTimeoutDiagnosticsCommand,
    runIntermediateCommandCommand,
    runProjectMemoryImpactCommand,
    runQualityChecklistCommand
} from './gates';
import {
    recordTaskModeProtectedManifestFailure,
    runRecoverTaskModeProtectedManifestCommand
} from './gate-flows/task-mode/task-mode-entry-failure';
import {
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from './cli-helpers';
import type { ParsedOptionsRecord } from './shared-command-utils';
import { runGateCliHandler } from './gate-cli-handler';
import { reconcileSuccessfulCompletionFinalizationAsync } from './gate-flows/completion/completion-finalization';
import { runFullSuiteValidationCommand } from './gate-flows/full-suite/full-suite-validation-flow';
import { runFullSuiteRunMarkerRecoveryCommand } from './gate-flows/full-suite/full-suite-run-marker-recovery';
import {
    runMaterializeFullSuiteRepairTaskCommand,
    runRestoreFullSuiteRepairWipCommand
} from './gate-flows/full-suite/full-suite-repair-task-flow';
import { runTaskEventsSummaryCommand, runTaskAuditSummaryCommand } from './gate-flows/task/task-summary-flow';
import { runTaskResetCommand } from './gate-flows/task/task-reset-flow';
import { buildTaskResetMissingTaskIdMessage } from './task-reset-alias';
import { colorizeTaskAuditSummaryText } from './task-audit-human-format';
import { colorizeTaskEventsSummaryText } from './task-events-human-format';
import { EXIT_GATE_FAILURE } from '../exit-codes';

export async function handleEnterTaskMode(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--entry-mode': { key: 'entryMode', type: 'string' },
        '--requested-depth': { key: 'requestedDepth', type: 'string' },
        '--effective-depth': { key: 'effectiveDepth', type: 'string' },
        '--task-summary': { key: 'taskSummary', type: 'string' },
        '--start-banner': { key: 'startBanner', type: 'string' },
        '--planned-changed-file': { key: 'plannedChangedFiles', type: 'string[]' },
        '--planned-changed-files': { key: 'plannedChangedFiles', type: 'string[]' },
        '--orchestrator-work': { key: 'orchestratorWork', type: 'boolean' },
        '--workflow-config-work': { key: 'workflowConfigWork', type: 'boolean' },
        '--upgrade-existing-task-mode': { key: 'upgradeExistingTaskMode', type: 'boolean' },
        '--operator-confirmed': { key: 'operatorConfirmed', type: 'string' },
        '--operator-confirmed-at-utc': { key: 'operatorConfirmedAtUtc', type: 'string' },
        '--provider': { key: 'provider', type: 'string' },
        '--routed-to': { key: 'routedTo', type: 'string' },
        '--actor': { key: 'actor', type: 'string' },
        '--plan-path': { key: 'planPath', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runEnterTaskModeCommand, {
        onCommandError: (error, { options }) => recordTaskModeProtectedManifestFailure(options, error)
    });
}

export async function handleRecoverTaskModeProtectedManifest(gateArgv: string[]): Promise<void> {
    return runGateCliHandler(gateArgv, {
        '--task-id': { key: 'taskId', type: 'string' },
        '--operator-confirmed': { key: 'operatorConfirmed', type: 'string' },
        '--operator-confirmed-at-utc': { key: 'operatorConfirmedAtUtc', type: 'string' },
        '--inspected-protected-snapshot-sha256': { key: 'inspectedProtectedSnapshotSha256', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    }, runRecoverTaskModeProtectedManifestCommand);
}

export async function handleLoadRulePack(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--stage': { key: 'stage', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--loaded-rule-file': { key: 'loadedRuleFiles', type: 'string[]' },
        '--loaded-rule-files': { key: 'loadedRuleFiles', type: 'string[]' },
        '--actor': { key: 'actor', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runLoadRulePackCommand);
}

export async function handleBindRulePackToPreflight(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--actor': { key: 'actor', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runBindRulePackToPreflightCommand);
}

export async function handleRestartCoherentCycle(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--preflight-output-path': { key: 'preflightOutputPath', type: 'string' },
        '--changed-file': { key: 'changedFiles', type: 'string[]' },
        '--changed-files': { key: 'changedFiles', type: 'string[]' },
        '--use-staged': { key: 'useStaged', type: 'boolean' },
        '--include-untracked': { key: 'includeUntracked', type: 'boolean' },
        '--task-intent': { key: 'taskIntent', type: 'string' },
        '--commands-path': { key: 'commandsPath', type: 'string' },
        '--output-filters-path': { key: 'outputFiltersPath', type: 'string' },
        '--fail-tail-lines': { key: 'failTailLines', type: 'string' },
        '--operator-confirmed': { key: 'operatorConfirmed', type: 'string' },
        '--operator-confirmed-at-utc': { key: 'operatorConfirmedAtUtc', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runRestartCoherentCycleCommand);
}

export async function handleRestartReviewCycle(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--preflight-output-path': { key: 'preflightOutputPath', type: 'string' },
        '--changed-file': { key: 'changedFiles', type: 'string[]' },
        '--changed-files': { key: 'changedFiles', type: 'string[]' },
        '--use-staged': { key: 'useStaged', type: 'boolean' },
        '--include-untracked': { key: 'includeUntracked', type: 'boolean' },
        '--task-intent': { key: 'taskIntent', type: 'string' },
        '--impact-analysis': { key: 'impactAnalysis', type: 'string' },
        '--impact-analysis-path': { key: 'impactAnalysisPath', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--review-evidence-only': { key: 'reviewEvidenceOnly', type: 'boolean' },
        '--commands-path': { key: 'commandsPath', type: 'string' },
        '--output-filters-path': { key: 'outputFiltersPath', type: 'string' },
        '--fail-tail-lines': { key: 'failTailLines', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runRestartReviewCycleCommand);
}

export async function handleRecordNoOp(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--classification': { key: 'classification', type: 'string' },
        '--reason': { key: 'reason', type: 'string' },
        '--actor': { key: 'actor', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runRecordNoOpCommand);
}

export async function handleRecordStrictDecompositionDecision(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--decision': { key: 'decision', type: 'string' },
        '--task-profile': { key: 'taskProfile', type: 'string' },
        '--task-summary': { key: 'taskSummary', type: 'string' },
        '--reason': { key: 'reason', type: 'string' },
        '--scope-risk': { key: 'scopeRisk', type: 'string' },
        '--expected-review-type': { key: 'expectedReviewTypes', type: 'string[]' },
        '--expected-review-types': { key: 'expectedReviewTypes', type: 'string[]' },
        '--atomicity-constraint': { key: 'atomicityConstraints', type: 'string[]' },
        '--atomicity-constraints': { key: 'atomicityConstraints', type: 'string[]' },
        '--proposed-child-task-id': { key: 'proposedChildTaskIds', type: 'string[]' },
        '--proposed-child-task-ids': { key: 'proposedChildTaskIds', type: 'string[]' },
        '--work-package-contract-path': { key: 'workPackageContractPath', type: 'string' },
        '--actor': { key: 'actor', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runRecordStrictDecompositionDecisionCommand);
}

export async function handleRecordReviewCycleContinuation(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--decision': { key: 'decision', type: 'string' },
        '--reason': { key: 'reason', type: 'string' },
        '--baseline-total-non-test-reviews': { key: 'baselineTotalNonTestReviewCount', type: 'string' },
        '--baseline-failed-non-test-reviews': { key: 'baselineFailedNonTestReviewCount', type: 'string' },
        '--max-total-non-test-reviews': { key: 'maxTotalNonTestReviews', type: 'string' },
        '--max-failed-non-test-reviews': { key: 'maxFailedNonTestReviews', type: 'string' },
        '--excluded-review-type': { key: 'excludedReviewTypes', type: 'string[]' },
        '--excluded-review-types': { key: 'excludedReviewTypes', type: 'string[]' },
        '--operator-confirmed': { key: 'operatorConfirmed', type: 'string' },
        '--operator-confirmed-at-utc': { key: 'operatorConfirmedAtUtc', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runRecordReviewCycleContinuationCommand);
}

export async function handleRecordReviewCycleSplitDecision(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--decision': { key: 'decision', type: 'string' },
        '--reason': { key: 'reason', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--baseline-total-non-test-reviews': { key: 'baselineTotalNonTestReviewCount', type: 'string' },
        '--baseline-failed-non-test-reviews': { key: 'baselineFailedNonTestReviewCount', type: 'string' },
        '--max-total-non-test-reviews': { key: 'maxTotalNonTestReviews', type: 'string' },
        '--max-failed-non-test-reviews': { key: 'maxFailedNonTestReviews', type: 'string' },
        '--excluded-review-type': { key: 'excludedReviewTypes', type: 'string[]' },
        '--excluded-review-types': { key: 'excludedReviewTypes', type: 'string[]' },
        '--operator-confirmed': { key: 'operatorConfirmed', type: 'string' },
        '--operator-confirmed-at-utc': { key: 'operatorConfirmedAtUtc', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runRecordReviewCycleSplitDecisionCommand);
}

export async function handleListSplitRequiredWip(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runListSplitRequiredWipCommand);
}

export async function handleRestoreSplitRequiredWip(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--manifest-path': { key: 'manifestPath', type: 'string' },
        '--include-path': { key: 'includePaths', type: 'string[]' },
        '--include-paths': { key: 'includePaths', type: 'string[]' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runRestoreSplitRequiredWipCommand);
}

export async function handleRetireSplitRequiredWip(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--manifest-path': { key: 'manifestPath', type: 'string' },
        '--reason': { key: 'reason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runRetireSplitRequiredWipCommand);
}

export async function handleHandshakeDiagnostics(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--provider': { key: 'provider', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--cli-path': { key: 'cliPath', type: 'string' },
        '--effective-cwd': { key: 'effectiveCwd', type: 'string' },
        '--canonical-entrypoint': { key: 'canonicalEntrypoint', type: 'string' },
        '--provider-bridge': { key: 'providerBridge', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runHandshakeDiagnosticsCommand);
}

export async function handleShellSmokePreflight(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--provider': { key: 'provider', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--effective-cwd': { key: 'effectiveCwd', type: 'string' },
        '--probe-timeout-ms': { key: 'probeTimeoutMs', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runShellSmokePreflightCommand);
}

export async function handleCommandTimeoutDiagnostics(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--provider': { key: 'provider', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--effective-cwd': { key: 'effectiveCwd', type: 'string' },
        '--command-records-path': { key: 'commandRecordsPath', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runCommandTimeoutDiagnosticsCommand);
}

export async function handleQualityChecklist(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--answers-json': { key: 'answersJson', type: 'string' },
        '--answers-path': { key: 'answersPath', type: 'string' },
        '--answers-stdin': { key: 'answersStdin', type: 'boolean' },
        '--action-taken': { key: 'actionTaken', type: 'string[]' },
        '--actions-taken': { key: 'actionsTaken', type: 'string[]' },
        '--action-required': { key: 'actionRequired', type: 'string[]' },
        '--actions-required': { key: 'actionsRequired', type: 'string[]' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runQualityChecklistCommand);
}

export async function handleRunIntermediateCommand(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--command': { key: 'command', type: 'string' },
        '--command-source': { key: 'commandSource', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--output-path': { key: 'outputPath', type: 'string' },
        '--timeout-ms': { key: 'timeoutMs', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--preflight-sha256': { key: 'preflightSha256', type: 'string' },
        '--coverage-contract-sha256': { key: 'coverageContractSha256', type: 'string' },
        '--expect-failure': { key: 'expectFailure', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runIntermediateCommandCommand);
}

export async function handleProjectMemoryImpact(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--changed-file': { key: 'changedFiles', type: 'string[]' },
        '--changed-files': { key: 'changedFiles', type: 'string[]' },
        '--confirm-updated': { key: 'confirmUpdated', type: 'boolean' },
        '--updated-memory-file': { key: 'updatedMemoryFiles', type: 'string[]' },
        '--updated-memory-files': { key: 'updatedMemoryFiles', type: 'string[]' },
        '--skipped-memory-file': { key: 'skippedMemoryFiles', type: 'string[]' },
        '--skipped-memory-files': { key: 'skippedMemoryFiles', type: 'string[]' },
        '--skip-unchanged-candidates-rationale': { key: 'skipUnchangedCandidatesRationale', type: 'string' },
        '--mode': { key: 'mode', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--update-artifact-path': { key: 'updateArtifactPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runProjectMemoryImpactCommand);
}

export async function handleLogTaskEvent(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--event-type': { key: 'eventType', type: 'string' },
        '--outcome': { key: 'outcome', type: 'string' },
        '--message': { key: 'message', type: 'string' },
        '--actor': { key: 'actor', type: 'string' },
        '--details-json': { key: 'detailsJson', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runLogTaskEventCommand, {
        formatOutput: (result) => result.outputText,
        resolveExitCode: (result) => result.exitCode
    });
}

export async function handleTaskEventsSummary(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--output-path': { key: 'outputPath', type: 'string' },
        '--as-json': { key: 'asJson', type: 'boolean' },
        '--include-details': { key: 'includeDetails', type: 'boolean' },
        '--compact-latest-cycle': { key: 'compactLatestCycle', type: 'boolean' }
    };
    return runGateCliHandler(gateArgv, defs, runTaskEventsSummaryCommand, {
        formatOutput: (result, { options }) => (
            options.asJson !== true
            && options.compactLatestCycle !== true
            && !options.outputPath
                ? colorizeTaskEventsSummaryText(result.rendered)
                : result.rendered
        ),
        resolveExitCode: () => 0
    });
}

export async function handleTaskAuditSummary(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--output-path': { key: 'outputPath', type: 'string' },
        '--as-json': { key: 'asJson', type: 'boolean' }
    };
    return runGateCliHandler(gateArgv, defs, runTaskAuditSummaryCommand, {
        formatOutput: (result, { options }) => (
            options.asJson !== true && !options.outputPath
                ? colorizeTaskAuditSummaryText(result.rendered)
                : result.rendered
        ),
        resolveExitCode: (result) => result.exitCode
    });
}

export async function handleNextStep(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--target-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--execute-effects': { key: 'executeEffects', type: 'boolean' },
        '--effect-plan-sha256': { key: 'effectPlanSha256', type: 'string' },
        '--as-json': { key: 'asJson', type: 'boolean' }
    };
    return runGateCliHandler(gateArgv, defs, resolveNextStepFromCliOptions, {
        parseConfig: { allowPositionals: true, maxPositionals: 1 },
        mapOptions: ({ options, positionals }) => ({ ...options, positionals: [...positionals] }),
        formatOutput: (result, { options }) => (
            options.asJson === true
                ? `${JSON.stringify(result, null, 2)}\n`
                : formatNextStepText(result)
        ),
        resolveExitCode: () => 0
    });
}

export async function handleFullSuiteValidation(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runFullSuiteValidationCommand, {
        formatOutput: (result) => result.outputText,
        resolveExitCode: (result) => result.exitCode
    });
}

export async function handleFullSuiteRunMarkerRecovery(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--clear-dead-marker': { key: 'clearDeadMarker', type: 'boolean' },
        '--operator-confirmed': { key: 'operatorConfirmed', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runFullSuiteRunMarkerRecoveryCommand);
}

export async function handleMaterializeFullSuiteRepairTask(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--full-suite-artifact-path': { key: 'fullSuiteArtifactPath', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runMaterializeFullSuiteRepairTaskCommand);
}

export async function handleRestoreFullSuiteRepairWip(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--full-suite-artifact-path': { key: 'fullSuiteArtifactPath', type: 'string' },
        '--manifest-path': { key: 'manifestPath', type: 'string' },
        '--child-task-id': { key: 'childTaskId', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, runRestoreFullSuiteRepairWipCommand);
}

export async function handleCompletionGate(gateArgv: string[]): Promise<void> {
    const defs = {
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-id': { key: 'taskId', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--rule-pack-path': { key: 'rulePackPath', type: 'string' },
        '--timeline-path': { key: 'timelinePath', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--compile-evidence-path': { key: 'compileEvidencePath', type: 'string' },
        '--review-evidence-path': { key: 'reviewEvidencePath', type: 'string' },
        '--doc-impact-path': { key: 'docImpactPath', type: 'string' },
        '--no-op-artifact-path': { key: 'noOpArtifactPath', type: 'string' },
        '--handshake-path': { key: 'handshakePath', type: 'string' },
        '--shell-smoke-path': { key: 'shellSmokePath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, async (options: ParsedOptionsRecord) => {
        const repoRoot = normalizePathValue(options.repoRoot || '.');
        ensureDirectoryExists(repoRoot, 'Repo root');
        const completionTaskId = parseRequiredText(options.taskId, 'TaskId');
        const reviewsRoot = gateHelpers.resolvePathInsideRepo(String(options.reviewsRoot || ''), repoRoot, { allowMissing: true })
            || gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
        const { result } = await withCompletionGateFinalizationLockAsync(reviewsRoot, completionTaskId, async () => {
            const completionResult = runCompletionGate({
                repoRoot,
                preflightPath: parseRequiredText(options.preflightPath, 'PreflightPath'),
                taskId: completionTaskId,
                taskModePath: String(options.taskModePath || ''),
                rulePackPath: String(options.rulePackPath || ''),
                timelinePath: String(options.timelinePath || ''),
                reviewsRoot: String(options.reviewsRoot || ''),
                compileEvidencePath: String(options.compileEvidencePath || ''),
                reviewEvidencePath: String(options.reviewEvidencePath || ''),
                docImpactPath: String(options.docImpactPath || ''),
                noOpArtifactPath: String(options.noOpArtifactPath || ''),
                handshakePath: String(options.handshakePath || ''),
                shellSmokePath: String(options.shellSmokePath || '')
            });

            const resolvedCompletionTaskId = String(completionResult.task_id || '').trim();
            if (resolvedCompletionTaskId) {
                const orchestratorRoot = gateHelpers.joinOrchestratorPath(repoRoot, '');
                if (completionResult.outcome === 'PASS') {
                    try {
                        await reconcileSuccessfulCompletionFinalizationAsync({
                            repoRoot,
                            taskId: resolvedCompletionTaskId,
                            preflightPath: String(completionResult.preflight_path || ''),
                            previousStatusHint: 'IN_REVIEW',
                            completionEventDetails: {
                                status: completionResult.status,
                                outcome: completionResult.outcome,
                                preflight_path: completionResult.preflight_path,
                                timeline_path: completionResult.timeline_path,
                                violations: completionResult.violations
                            }
                        });
                    } catch (error: unknown) {
                        try {
                            await emitMandatoryCompletionGateEventAsync(orchestratorRoot, resolvedCompletionTaskId, false, {
                                status: completionResult.status,
                                outcome: 'FINALIZATION_FAILED',
                                preflight_path: completionResult.preflight_path,
                                timeline_path: completionResult.timeline_path,
                                violations: completionResult.violations,
                                finalization_error: error instanceof Error ? error.message : String(error)
                            });
                        } catch (eventError: unknown) {
                            throw new Error(
                                `completion-gate finalization failed after validation PASS, and mandatory lifecycle event `
                                + `'COMPLETION_GATE_FAILED' could not be appended. FinalizationError: `
                                + `${error instanceof Error ? error.message : String(error)} EventError: `
                                + `${eventError instanceof Error ? eventError.message : String(eventError)}`
                            );
                        }
                        throw new Error(
                            `completion-gate finalization failed after validation PASS. ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                } else {
                    try {
                        await emitMandatoryCompletionGateEventAsync(orchestratorRoot, resolvedCompletionTaskId, false, {
                            status: completionResult.status,
                            outcome: completionResult.outcome,
                            preflight_path: completionResult.preflight_path,
                            timeline_path: completionResult.timeline_path,
                            violations: completionResult.violations
                        });
                    } catch (error: unknown) {
                        throw new Error(
                            `completion-gate failed because mandatory lifecycle event 'COMPLETION_GATE_FAILED' could not be appended. ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                }
            }

            return completionResult;
        });
        return result;
    }, {
        formatOutput: (result) => `${formatCompletionGateResult(result)}\n`,
        resolveExitCode: (result) => result.outcome === 'PASS' ? 0 : EXIT_GATE_FAILURE
    });
}

export async function handleHumanCommit(gateArgv: string[]): Promise<void> {
    return runGateCliHandler(gateArgv, {}, (
        argv: string[]
    ) => runHumanCommitCommand(argv, { cwd: process.cwd() }), {
        skipParsing: true,
        mapOptions: ({ argv }) => [...argv],
        formatOutput: () => undefined,
        resolveExitCode: (exitCode) => exitCode
    });
}

export async function handleTaskReset(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--confirm': { key: 'confirm', type: 'boolean' },
        '--to-status': { key: 'toStatus', type: 'string' },
        '--reopen': { key: 'reopen', type: 'boolean' },
        '--discard': { key: 'discard', type: 'boolean' },
        '--events-root': { key: 'eventsRoot', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--as-json': { key: 'asJson', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    return runGateCliHandler(gateArgv, defs, (options: ParsedOptionsRecord) => {
        if (!options.taskId) {
            throw new Error(buildTaskResetMissingTaskIdMessage());
        }
        return runTaskResetCommand(options);
    });
}
