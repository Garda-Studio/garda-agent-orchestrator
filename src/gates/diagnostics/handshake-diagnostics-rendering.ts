import type { HandshakeDiagnosticsArtifact } from './handshake-diagnostics-types';
import { formatTaskPlanDiagnostics } from './task-plan-diagnostics';

export function formatHandshakeDiagnosticsResult(artifact: HandshakeDiagnosticsArtifact): string[] {
    const lines: string[] = [
        artifact.outcome === 'PASS' ? 'HANDSHAKE_DIAGNOSTICS_PASSED' : 'HANDSHAKE_DIAGNOSTICS_FAILED',
        `TaskId: ${artifact.task_id}`,
        `Provider: ${artifact.provider || 'unknown'}`,
        `ExecutionProvider: ${artifact.execution_provider || artifact.provider || 'unknown'}`,
        `CanonicalSourceOfTruth: ${artifact.canonical_source_of_truth || 'unknown'}`,
        `CanonicalEntrypoint: ${artifact.canonical_entrypoint || 'none'} (${artifact.canonical_entrypoint_exists ? 'exists' : 'missing'})`,
        `ProviderBridge: ${artifact.provider_bridge || 'none'} (${artifact.provider_bridge_exists ? 'exists' : 'not expected or missing'})`,
        `RoutedTo: ${artifact.routed_to || 'none'}`,
        `ExecutionProviderSource: ${artifact.execution_provider_source || 'unknown'}`,
        `RuntimeIdentityStatus: ${artifact.runtime_identity_status || 'unknown'}`,
        `ReviewerCapabilityLevel: ${artifact.reviewer_capability_level || 'unknown'}`,
        `ReviewerExpectedExecutionMode: ${artifact.reviewer_expected_execution_mode || 'unknown'}`,
        `ReviewerSubagentLaunchStatus: ${artifact.reviewer_subagent_launch_status || 'unknown'}`,
        `ReviewerSubagentLaunchRoute: ${artifact.reviewer_subagent_launch_route || 'none'}`,
        `NoDelegateMode: ${artifact.no_delegate_mode_active === true ? 'active' : 'inactive'} (${artifact.no_delegate_mode_source || 'none'})`,
        `StartTaskRouter: ${artifact.start_task_router_path} (${artifact.start_task_router_exists ? 'exists' : 'missing'})`,
        `ExecutionContext: ${artifact.execution_context}`,
        `CliPath: ${artifact.cli_path}`,
        `EffectiveCwd: ${artifact.effective_cwd}`,
        `WorkspaceRoot: ${artifact.workspace_root}`
    ];

    if (artifact.task_plan) lines.push(...formatTaskPlanDiagnostics(artifact.task_plan));

    if (artifact.diagnostics.length > 0) {
        lines.push('Diagnostics:');
        for (const d of artifact.diagnostics) {
            const icon = d.status === 'ok' ? '+' : d.status === 'warning' ? '~' : '-';
            lines.push(`  [${icon}] ${d.check}: ${d.detail}`);
        }
    }

    if (artifact.violations.length > 0) {
        lines.push('Violations:');
        for (const v of artifact.violations) {
            lines.push(`  - ${v}`);
        }
    }

    if (Array.isArray(artifact.runtime_identity_violations) && artifact.runtime_identity_violations.length > 0) {
        lines.push('RuntimeIdentityViolations:');
        for (const violation of artifact.runtime_identity_violations) {
            lines.push(`  - ${violation}`);
        }
    }

    return lines;
}
