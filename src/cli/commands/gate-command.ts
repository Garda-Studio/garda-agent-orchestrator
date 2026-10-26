import { getAllShimmedGateNames } from '../../compat/shim-registry';

import {
    buildGateCommandOverviewText,
    buildGateHelpText,
    buildTaskIdSyntaxRemediationMessage,
    hasStandaloneGateHelpFlag
} from './gate-command-help';

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
        for (const name of getAllShimmedGateNames().sort()) {
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
    const taskIdRemediationMessage = gateName === 'task-reset'
        ? null
        : buildTaskIdSyntaxRemediationMessage(gateName, gateArgv);
    if (taskIdRemediationMessage) {
        throw new Error(taskIdRemediationMessage);
    }

    switch (gateName) {
        case 'parent-audit':
            return (await import('./gate-parent-audit-handlers')).handleParentAudit(gateArgv);
        case 'validate-manifest':
            return (await import('./gate-validate-handlers')).handleValidateManifest(gateArgv);
        case 'validate-config':
            return (await import('./gate-validate-handlers')).handleValidateConfig(gateArgv);
        case 'classify-change':
            return (await import('./gate-build-handlers')).handleClassifyChange(gateArgv);
        case 'enter-task-mode':
            return (await import('./gate-task-handlers')).handleEnterTaskMode(gateArgv);
        case 'recover-task-mode-protected-manifest':
            return (await import('./gate-task-handlers')).handleRecoverTaskModeProtectedManifest(gateArgv);
        case 'restart-coherent-cycle':
            return (await import('./gate-task-handlers')).handleRestartCoherentCycle(gateArgv);
        case 'restart-review-cycle':
            return (await import('./gate-task-handlers')).handleRestartReviewCycle(gateArgv);
        case 'load-rule-pack':
            return (await import('./gate-task-handlers')).handleLoadRulePack(gateArgv);
        case 'bind-rule-pack-to-preflight':
            return (await import('./gate-task-handlers')).handleBindRulePackToPreflight(gateArgv);
        case 'record-no-op':
            return (await import('./gate-task-handlers')).handleRecordNoOp(gateArgv);
        case 'record-review-cycle-continuation':
            return (await import('./gate-task-handlers')).handleRecordReviewCycleContinuation(gateArgv);
        case 'record-review-cycle-split-decision':
            return (await import('./gate-task-handlers')).handleRecordReviewCycleSplitDecision(gateArgv);
        case 'record-strict-decomposition-decision':
            return (await import('./gate-task-handlers')).handleRecordStrictDecompositionDecision(gateArgv);
        case 'list-split-required-wip':
            return (await import('./gate-task-handlers')).handleListSplitRequiredWip(gateArgv);
        case 'restore-split-required-wip':
            return (await import('./gate-task-handlers')).handleRestoreSplitRequiredWip(gateArgv);
        case 'retire-split-required-wip':
            return (await import('./gate-task-handlers')).handleRetireSplitRequiredWip(gateArgv);
        case 'handshake-diagnostics':
            return (await import('./gate-task-handlers')).handleHandshakeDiagnostics(gateArgv);
        case 'shell-smoke-preflight':
            return (await import('./gate-task-handlers')).handleShellSmokePreflight(gateArgv);
        case 'command-timeout-diagnostics':
            return (await import('./gate-task-handlers')).handleCommandTimeoutDiagnostics(gateArgv);
        case 'quality-checklist':
            return (await import('./gate-task-handlers')).handleQualityChecklist(gateArgv);
        case 'run-intermediate-command':
            return (await import('./gate-task-handlers')).handleRunIntermediateCommand(gateArgv);
        case 'project-memory-impact':
            return (await import('./gate-task-handlers')).handleProjectMemoryImpact(gateArgv);
        case 'compile-gate':
            return (await import('./gate-build-handlers')).handleCompileGate(gateArgv);
        case 'build-scoped-diff':
            return (await import('./gate-build-handlers')).handleBuildScopedDiff(gateArgv);
        case 'build-review-context':
            return (await import('./gate-build-handlers')).handleBuildReviewContext(gateArgv);
        case 'activate-optional-skill':
            return (await import('./gate-build-handlers')).handleActivateOptionalSkill(gateArgv);
        case 'decline-optional-skill':
            return (await import('./gate-build-handlers')).handleDeclineOptionalSkill(gateArgv);
        case 'task-events-summary':
            return (await import('./gate-task-handlers')).handleTaskEventsSummary(gateArgv);
        case 'task-audit-summary':
            return (await import('./gate-task-handlers')).handleTaskAuditSummary(gateArgv);
        case 'next-step':
            return (await import('./gate-next-step-handler')).handleNextStep(gateArgv);
        case 'log-task-event':
            return (await import('./gate-task-handlers')).handleLogTaskEvent(gateArgv);
        case 'required-reviews-check':
            return (await import('./gate-review-handlers')).handleRequiredReviewsCheck(gateArgv);
        case 'doc-impact-gate':
            return (await import('./gate-review-handlers')).handleDocImpactGate(gateArgv);
        case 'full-suite-validation':
            return (await import('./gate-task-handlers')).handleFullSuiteValidation(gateArgv);
        case 'full-suite-run-marker-recovery':
            return (await import('./gate-task-handlers')).handleFullSuiteRunMarkerRecovery(gateArgv);
        case 'materialize-full-suite-repair-task':
            return (await import('./gate-task-handlers')).handleMaterializeFullSuiteRepairTask(gateArgv);
        case 'restore-full-suite-repair-wip':
            return (await import('./gate-task-handlers')).handleRestoreFullSuiteRepairWip(gateArgv);
        case 'record-review-result':
            return (await import('./gate-review-handlers')).handleRecordReviewResult(gateArgv);
        case 'record-review-output-correction-transport':
            return (await import('./gate-review-handlers')).handleRecordReviewOutputCorrectionTransport(gateArgv);
        case 'record-review-output-correction-response':
            return (await import('./gate-review-handlers')).handleRecordReviewOutputCorrectionResponse(gateArgv);
        case 'record-review-output-correction-invocation':
            return (await import('./gate-review-handlers')).handleRecordReviewOutputCorrectionInvocation(gateArgv);
        case 'completion-gate':
            return (await import('./gate-task-handlers')).handleCompletionGate(gateArgv);
        case 'record-review-routing':
            return (await import('./gate-review-handlers')).handleRecordReviewRouting(gateArgv);
        case 'prepare-reviewer-launch':
            return (await import('./gate-review-handlers')).handlePrepareReviewerLaunch(gateArgv);
        case 'record-reviewer-delegation-started':
            return (await import('./gate-review-handlers')).handleRecordReviewerDelegationStarted(gateArgv);
        case 'record-reviewer-launch-failed':
            return (await import('./gate-review-handlers')).handleRecordReviewerLaunchFailed(gateArgv);
        case 'complete-reviewer-launch':
            return (await import('./gate-review-handlers')).handleCompleteReviewerLaunch(gateArgv);
        case 'record-review-invocation':
            return (await import('./gate-review-handlers')).handleRecordReviewInvocation(gateArgv);
        case 'record-review-receipt':
            return (await import('./gate-review-handlers')).handleRecordReviewReceipt(gateArgv);
        case 'materialize-review-follow-up-tasks':
            return (await import('./gate-review-handlers')).handleMaterializeReviewFollowUpTasks(gateArgv);
        case 'human-commit':
            return (await import('./gate-task-handlers')).handleHumanCommit(gateArgv);
        case 'validate-isolation':
            return (await import('./gate-isolation-handlers')).handleValidateIsolation(gateArgv);
        case 'prepare-isolation':
            return (await import('./gate-isolation-handlers')).handlePrepareIsolation(gateArgv);
        case 'task-reset':
            return (await import('./gate-task-handlers')).handleTaskReset(gateArgv);
        default:
            throw new Error(`Unknown gate: ${gateName}`);
    }
}
