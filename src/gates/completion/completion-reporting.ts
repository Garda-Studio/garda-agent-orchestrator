import * as path from 'node:path';
import { getBundleCliCommand, getSourceCliCommand, resolveBundleName } from '../../core/constants';
import { isOrchestratorSourceCheckout } from '../shared/helpers';
import { buildReviewTrustSummaryFromCompatibilityArtifacts } from '../review/review-trust-summary';
import {
    isRestartWorkflowConfigScopeAuthorized,
    omitWorkflowConfigChangedFiles,
    resolveRestartCommandChangedFiles
} from '../recovery/restart-command-scope';

export function quotePowerShellCliValue(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildCoherentCycleRestartCommand(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    taskModePath: string | null,
    commandsPath: string | null,
    outputFiltersPath: string | null,
    options: {
        requiresOperatorConfirmation?: boolean;
        changedFiles?: readonly string[];
        taskIntent?: string | null;
    } = {}
): string {
    const cliPrefix = isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleName());
    const parts = [
        `${cliPrefix} gate restart-coherent-cycle`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        `--preflight-path ${quotePowerShellCliValue(preflightPath)}`
    ];
    const taskIntent = String(options.taskIntent || '').trim();
    if (taskIntent) {
        parts.push(`--task-intent ${quotePowerShellCliValue(taskIntent)}`);
    }
    if (taskModePath) {
        parts.push(`--task-mode-path ${quotePowerShellCliValue(taskModePath)}`);
    }
    if (commandsPath) {
        parts.push(`--commands-path ${quotePowerShellCliValue(commandsPath)}`);
    }
    if (outputFiltersPath) {
        parts.push(`--output-filters-path ${quotePowerShellCliValue(outputFiltersPath)}`);
    }
    const includeWorkflowConfigFiles = isRestartWorkflowConfigScopeAuthorized(repoRoot, taskId, taskModePath);
    const changedFiles = options.changedFiles
        ? [...new Set(options.changedFiles.map((entry) => String(entry || '').trim()).filter(Boolean))].sort()
        : resolveRestartCommandChangedFiles(repoRoot, preflightPath, { includeWorkflowConfigFiles });
    const commandChangedFiles = includeWorkflowConfigFiles
        ? changedFiles
        : omitWorkflowConfigChangedFiles(changedFiles);
    for (const changedFile of commandChangedFiles) {
        parts.push(`--changed-file ${quotePowerShellCliValue(changedFile)}`);
    }
    if (options.requiresOperatorConfirmation === true) {
        parts.push('--operator-confirmed yes');
        parts.push(`--operator-confirmed-at-utc ${quotePowerShellCliValue('<ISO-8601 timestamp>')}`);
    }
    return parts.join(' ');
}

export function buildReviewCycleRestartCommand(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    taskModePath: string | null,
    commandsPath: string | null,
    outputFiltersPath: string | null
): string {
    const cliPrefix = isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleName());
    const parts = [
        `${cliPrefix} gate restart-review-cycle`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        `--preflight-path ${quotePowerShellCliValue(preflightPath)}`,
        `--impact-analysis ${quotePowerShellCliValue('<replace with main-agent remediation impact analysis>')}`
    ];
    if (taskModePath) {
        parts.push(`--task-mode-path ${quotePowerShellCliValue(taskModePath)}`);
    }
    if (commandsPath) {
        parts.push(`--commands-path ${quotePowerShellCliValue(commandsPath)}`);
    }
    if (outputFiltersPath) {
        parts.push(`--output-filters-path ${quotePowerShellCliValue(outputFiltersPath)}`);
    }
    const includeWorkflowConfigFiles = isRestartWorkflowConfigScopeAuthorized(repoRoot, taskId, taskModePath);
    for (const changedFile of resolveRestartCommandChangedFiles(repoRoot, preflightPath, { includeWorkflowConfigFiles })) {
        parts.push(`--changed-file ${quotePowerShellCliValue(changedFile)}`);
    }
    return parts.join(' ');
}

export function buildCompletionGateSuccessAfterCommand(repoRoot: string, taskId: string): string {
    const cliPrefix = isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleName());
    return `AfterCommand: rerun ${cliPrefix} next-step "${taskId}" --repo-root "."; `
        + 'deliver the mandatory final report that next-step prints before asking for commit permission.';
}

export function formatCompletionGateResult(result: Record<string, unknown>): string {
    const lines: string[] = [
        result.outcome === 'PASS' ? 'COMPLETION_GATE_PASSED' : 'COMPLETION_GATE_FAILED',
        `TaskId: ${result.task_id}`,
        `Status: ${result.status}`,
        `Outcome: ${result.outcome}`
    ];
    const reviewTrustSummary = result.review_trust_summary && typeof result.review_trust_summary === 'object'
        ? result.review_trust_summary as Record<string, unknown>
        : null;
    const reviewArtifacts = result.review_artifacts && typeof result.review_artifacts === 'object'
        ? result.review_artifacts as Record<string, unknown>
        : null;
    const compatibilityTrustSummary = reviewArtifacts
        ? buildReviewTrustSummaryFromCompatibilityArtifacts(
            Object.fromEntries(
                Object.entries(reviewArtifacts).map(([reviewType, artifact]) => {
                    const artifactRecord = artifact && typeof artifact === 'object' && !Array.isArray(artifact)
                        ? artifact as Record<string, unknown>
                        : {};
                    const reviewContext = artifactRecord.reviewContext
                        && typeof artifactRecord.reviewContext === 'object'
                        && !Array.isArray(artifactRecord.reviewContext)
                        ? artifactRecord.reviewContext as Record<string, unknown>
                        : null;
                    const receipt = artifactRecord.receipt
                        && typeof artifactRecord.receipt === 'object'
                        && !Array.isArray(artifactRecord.receipt)
                        ? artifactRecord.receipt as Record<string, unknown>
                        : null;
                    return [reviewType, {
                        content: typeof artifactRecord.content === 'string' ? artifactRecord.content : null,
                        reviewContext,
                        receipt
                    }];
                })
            ),
            typeof result.scope_category === 'string' ? result.scope_category : null
        )
        : null;
    const reviewTrustLine = reviewTrustSummary && typeof reviewTrustSummary.visible_summary_line === 'string'
        ? reviewTrustSummary.visible_summary_line.trim()
        : (compatibilityTrustSummary?.visible_summary_line || '');
    const reviewPolicyLine = reviewTrustSummary && typeof reviewTrustSummary.policy_summary_line === 'string'
        ? reviewTrustSummary.policy_summary_line.trim()
        : (compatibilityTrustSummary?.policy_summary_line || '');
    if (reviewTrustLine) {
        lines.push(reviewTrustLine);
    }
    if (reviewPolicyLine) {
        lines.push(reviewPolicyLine);
    }

    const plan = result.plan as Record<string, unknown> | undefined;
    if (plan) {
        lines.push(`PlanGuided: ${!!plan.plan_guided}`);
        if (plan.plan_guided && plan.plan_path) {
            lines.push(`PlanPath: ${plan.plan_path}`);
        }
    }
    if (result.outcome === 'PASS') {
        const taskId = typeof result.task_id === 'string' ? result.task_id.trim() : '';
        const repoRoot = typeof result.repo_root === 'string' && result.repo_root.trim()
            ? result.repo_root
            : process.cwd();
        if (taskId) {
            lines.push(buildCompletionGateSuccessAfterCommand(repoRoot, taskId));
        }
    }

    if (Array.isArray(result.violations) && result.violations.length > 0) {
        lines.push('Violations:');
        for (const violation of result.violations) {
            lines.push(`- ${violation}`);
        }
    }

    if (typeof result.coherent_cycle_restart_command === 'string' && result.coherent_cycle_restart_command.trim()) {
        lines.push(`RecoveryCommand: ${result.coherent_cycle_restart_command}`);
    }
    if (typeof result.review_cycle_restart_command === 'string' && result.review_cycle_restart_command.trim()) {
        lines.push(
            typeof result.coherent_cycle_restart_command === 'string' && result.coherent_cycle_restart_command.trim()
                ? `ReviewRecoveryCommand: ${result.review_cycle_restart_command}`
                : `RecoveryCommand: ${result.review_cycle_restart_command}`
        );
    }

    if (Array.isArray(result.isolation_mode_warnings) && result.isolation_mode_warnings.length > 0) {
        lines.push('IsolationModeWarnings:');
        for (const warning of result.isolation_mode_warnings) {
            lines.push(`- ${warning}`);
        }
    }

    return lines.join('\n');
}
