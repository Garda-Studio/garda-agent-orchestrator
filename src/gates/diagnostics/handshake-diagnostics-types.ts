import type { TaskPlanDiagnostics } from './task-plan-diagnostics';

export interface HandshakeDiagnosticsArtifact {
    schema_version: 1;
    timestamp_utc: string;
    event_source: 'handshake-diagnostics';
    task_id: string;
    status: 'PASSED' | 'FAILED';
    outcome: 'PASS' | 'FAIL';

    provider: string | null;
    execution_provider?: string | null;
    canonical_source_of_truth?: string | null;
    canonical_entrypoint: string | null;
    canonical_entrypoint_exists: boolean;
    provider_bridge: string | null;
    provider_bridge_exists: boolean;
    routed_to?: string | null;
    execution_provider_source?: string | null;
    reviewer_capability_level?: string | null;
    reviewer_expected_execution_mode?: string | null;
    reviewer_fallback_allowed?: boolean | null;
    reviewer_fallback_reason_required?: boolean | null;
    reviewer_subagent_launch_status?: string | null;
    reviewer_subagent_launch_route?: string | null;
    reviewer_subagent_launch_reason?: string | null;
    reviewer_subagent_launch_remediation?: string | null;
    no_delegate_mode_active?: boolean | null;
    no_delegate_mode_source?: string | null;
    no_delegate_mode_reason?: string | null;
    no_delegate_mode_remediation?: string | null;
    runtime_identity_status?: string | null;
    runtime_identity_violations?: string[];
    start_task_router_path: string;
    start_task_router_exists: boolean;
    execution_context: 'source-checkout' | 'materialized-bundle';
    cli_path: string;
    effective_cwd: string;
    workspace_root: string;
    task_plan?: TaskPlanDiagnostics;

    diagnostics: HandshakeDiagnostic[];
    violations: string[];
}

export interface HandshakeDiagnostic {
    check: string;
    status: 'ok' | 'warning' | 'error';
    detail: string;
}

export interface HandshakeEvidenceResult {
    task_id: string | null;
    evidence_path: string | null;
    evidence_hash: string | null;
    evidence_status: string;
    provider: string | null;
    violations: string[];
}

export interface BuildHandshakeDiagnosticsOptions {
    taskId: string;
    repoRoot: string;
    provider?: string | null;
    canonicalSourceOfTruth?: string | null;
    cliPath?: string | null;
    effectiveCwd?: string | null;
    canonicalEntrypoint?: string | null;
    providerBridge?: string | null;
    routedTo?: string | null;
    executionProviderSource?: string | null;
    reviewerCapabilityLevel?: string | null;
    reviewerExpectedExecutionMode?: string | null;
    reviewerFallbackAllowed?: boolean | null;
    reviewerFallbackReasonRequired?: boolean | null;
    reviewerSubagentLaunchStatus?: string | null;
    reviewerSubagentLaunchRoute?: string | null;
    reviewerSubagentLaunchReason?: string | null;
    reviewerSubagentLaunchRemediation?: string | null;
    noDelegateModeActive?: boolean | null;
    noDelegateModeSource?: string | null;
    noDelegateModeReason?: string | null;
    noDelegateModeRemediation?: string | null;
    runtimeIdentityStatus?: string | null;
    runtimeIdentityViolations?: string[] | null;
    precheckViolations?: string[];
}

export interface GetHandshakeEvidenceOptions {
    artifactPath?: string;
    taskModePath?: string;
    timelinePath?: string;
}

export interface TimelineEventEntry {
    event_type: string;
    sequence: number;
    details: Record<string, unknown> | null;
}
