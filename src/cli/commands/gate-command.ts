import { getAllShimmedGateNames } from '../../compat/shim-registry';
import { handleParentAudit } from './gate-parent-audit-handlers';
import {
    buildGateCommandOverviewText,
    buildGateHelpText,
    buildTaskIdSyntaxRemediationMessage,
    hasStandaloneGateHelpFlag
} from './gate-command-help';
import { handleValidateManifest, handleValidateConfig } from './gate-validate-handlers';
import {
    handleClassifyChange,
    handleCompileGate,
    handleBuildScopedDiff,
    handleBuildReviewContext,
    handleActivateOptionalSkill,
    handleDeclineOptionalSkill
} from './gate-build-handlers';
import {
    handleRequiredReviewsCheck,
    handleDocImpactGate,
    handleRecordReviewResult,
    handleRecordReviewRouting,
    handlePrepareReviewerLaunch,
    handleRecordReviewerDelegationStarted,
    handleRecordReviewerLaunchFailed,
    handleCompleteReviewerLaunch,
    handleRecordReviewInvocation,
    handleRecordReviewReceipt,
    handleRecordReviewOutputCorrectionInvocation,
    handleRecordReviewOutputCorrectionResponse,
    handleRecordReviewOutputCorrectionTransport,
    handleMaterializeReviewFollowUpTasks
} from './gate-review-handlers';
import {
    handleBindRulePackToPreflight,
    handleEnterTaskMode,
    handleRecoverTaskModeProtectedManifest,
    handleLoadRulePack,
    handleRestartCoherentCycle,
    handleRestartReviewCycle,
    handleRecordNoOp,
    handleRecordReviewCycleContinuation,
    handleRecordReviewCycleSplitDecision,
    handleRecordStrictDecompositionDecision,
    handleListSplitRequiredWip,
    handleRestoreSplitRequiredWip,
    handleRetireSplitRequiredWip,
    handleHandshakeDiagnostics,
    handleShellSmokePreflight,
    handleCommandTimeoutDiagnostics,
    handleQualityChecklist,
    handleRunIntermediateCommand,
    handleProjectMemoryImpact,
    handleLogTaskEvent,
    handleTaskEventsSummary,
    handleTaskAuditSummary,
        handleNextStep,
        handleFullSuiteValidation,
        handleFullSuiteRunMarkerRecovery,
        handleMaterializeFullSuiteRepairTask,
        handleRestoreFullSuiteRepairWip,
        handleCompletionGate,
        handleHumanCommit,
        handleTaskReset
} from './gate-task-handlers';
import { handleValidateIsolation, handlePrepareIsolation } from './gate-isolation-handlers';

export async function handleGate(commandArgv: string[]): Promise<void> {
    if (commandArgv[0] === 'help') {
        const requestedGateName = String(commandArgv[1] || '').trim();
        console.log(requestedGateName ? buildGateHelpText(requestedGateName) : buildGateCommandOverviewText());
        return;
    }

    if (commandArgv.length === 0 || commandArgv[0] === '-h' || commandArgv[0] === '--help') {
        console.log(buildGateCommandOverviewText());
        console.log('');
        console.log('Available gates:');
        for (const name of [...getAllShimmedGateNames(), 'parent-audit'].sort()) {
            console.log(`  ${name}`);
        }
        return;
    }

    const gateName = commandArgv[0];
    const gateArgv = commandArgv.slice(1);
    if (hasStandaloneGateHelpFlag(gateArgv)) {
        console.log(buildGateHelpText(gateName));
        return;
    }
    const taskIdRemediationMessage = buildTaskIdSyntaxRemediationMessage(gateName, gateArgv);
    if (taskIdRemediationMessage) {
        throw new Error(taskIdRemediationMessage);
    }

    switch (gateName) {
        case 'parent-audit':
            return handleParentAudit(gateArgv);
        case 'validate-manifest':
            return handleValidateManifest(gateArgv);
        case 'validate-config':
            return handleValidateConfig(gateArgv);
        case 'classify-change':
            return handleClassifyChange(gateArgv);
        case 'enter-task-mode':
            return handleEnterTaskMode(gateArgv);
        case 'recover-task-mode-protected-manifest':
            return handleRecoverTaskModeProtectedManifest(gateArgv);
        case 'restart-coherent-cycle':
            return handleRestartCoherentCycle(gateArgv);
        case 'restart-review-cycle':
            return handleRestartReviewCycle(gateArgv);
        case 'load-rule-pack':
            return handleLoadRulePack(gateArgv);
        case 'bind-rule-pack-to-preflight':
            return handleBindRulePackToPreflight(gateArgv);
        case 'record-no-op':
            return handleRecordNoOp(gateArgv);
        case 'record-review-cycle-continuation':
            return handleRecordReviewCycleContinuation(gateArgv);
        case 'record-review-cycle-split-decision':
            return handleRecordReviewCycleSplitDecision(gateArgv);
        case 'record-strict-decomposition-decision':
            return handleRecordStrictDecompositionDecision(gateArgv);
        case 'list-split-required-wip':
            return handleListSplitRequiredWip(gateArgv);
        case 'restore-split-required-wip':
            return handleRestoreSplitRequiredWip(gateArgv);
        case 'retire-split-required-wip':
            return handleRetireSplitRequiredWip(gateArgv);
        case 'handshake-diagnostics':
            return handleHandshakeDiagnostics(gateArgv);
        case 'shell-smoke-preflight':
            return handleShellSmokePreflight(gateArgv);
        case 'command-timeout-diagnostics':
            return handleCommandTimeoutDiagnostics(gateArgv);
        case 'quality-checklist':
            return handleQualityChecklist(gateArgv);
        case 'run-intermediate-command':
            return handleRunIntermediateCommand(gateArgv);
        case 'project-memory-impact':
            return handleProjectMemoryImpact(gateArgv);
        case 'compile-gate':
            return handleCompileGate(gateArgv);
        case 'build-scoped-diff':
            return handleBuildScopedDiff(gateArgv);
        case 'build-review-context':
            return handleBuildReviewContext(gateArgv);
        case 'activate-optional-skill':
            return handleActivateOptionalSkill(gateArgv);
        case 'decline-optional-skill':
            return handleDeclineOptionalSkill(gateArgv);
        case 'task-events-summary':
            return handleTaskEventsSummary(gateArgv);
        case 'task-audit-summary':
            return handleTaskAuditSummary(gateArgv);
        case 'next-step':
            return handleNextStep(gateArgv);
        case 'log-task-event':
            return handleLogTaskEvent(gateArgv);
        case 'required-reviews-check':
            return handleRequiredReviewsCheck(gateArgv);
        case 'doc-impact-gate':
            return handleDocImpactGate(gateArgv);
        case 'full-suite-validation':
            return handleFullSuiteValidation(gateArgv);
        case 'full-suite-run-marker-recovery':
            return handleFullSuiteRunMarkerRecovery(gateArgv);
        case 'materialize-full-suite-repair-task':
            return handleMaterializeFullSuiteRepairTask(gateArgv);
        case 'restore-full-suite-repair-wip':
            return handleRestoreFullSuiteRepairWip(gateArgv);
        case 'record-review-result':
            return handleRecordReviewResult(gateArgv);
        case 'record-review-output-correction-transport':
            return handleRecordReviewOutputCorrectionTransport(gateArgv);
        case 'record-review-output-correction-response':
            return handleRecordReviewOutputCorrectionResponse(gateArgv);
        case 'record-review-output-correction-invocation':
            return handleRecordReviewOutputCorrectionInvocation(gateArgv);
        case 'completion-gate':
            return handleCompletionGate(gateArgv);
        case 'record-review-routing':
            return handleRecordReviewRouting(gateArgv);
        case 'prepare-reviewer-launch':
            return handlePrepareReviewerLaunch(gateArgv);
        case 'record-reviewer-delegation-started':
            return handleRecordReviewerDelegationStarted(gateArgv);
        case 'record-reviewer-launch-failed':
            return handleRecordReviewerLaunchFailed(gateArgv);
        case 'complete-reviewer-launch':
            return handleCompleteReviewerLaunch(gateArgv);
        case 'record-review-invocation':
            return handleRecordReviewInvocation(gateArgv);
        case 'record-review-receipt':
            return handleRecordReviewReceipt(gateArgv);
        case 'materialize-review-follow-up-tasks':
            return handleMaterializeReviewFollowUpTasks(gateArgv);
        case 'human-commit':
            return handleHumanCommit(gateArgv);
        case 'validate-isolation':
            return handleValidateIsolation(gateArgv);
        case 'prepare-isolation':
            return handlePrepareIsolation(gateArgv);
        case 'task-reset':
            return handleTaskReset(gateArgv);
        default:
            throw new Error(`Unknown gate: ${gateName}`);
    }
}
