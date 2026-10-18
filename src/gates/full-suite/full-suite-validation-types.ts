import type { FullSuiteValidationPlacement } from '../../core/workflow-config';
import type { RawOutputRetentionEvidence } from '../../gate-runtime/output-log-retention';
import type { OutOfScopeFailurePolicy } from '../../core/full-suite-validation-config';

export {
    OUT_OF_SCOPE_FAILURE_POLICIES
} from '../../core/full-suite-validation-config';
export type {
    FullSuiteValidationConfig,
    OutOfScopeFailurePolicy
} from '../../core/full-suite-validation-config';

export interface FullSuiteValidationCycleBinding {
    task_id: string;
    preflight_path: string;
    preflight_sha256: string;
    compile_gate_timestamp: string | null;
    scope_binding?: {
        changed_files_sha256: string | null;
        scope_sha256: string | null;
        scope_content_sha256: string | null;
    } | null;
}

export interface FullSuiteDurationHistoryEntry {
    timestamp_utc: string;
    task_id: string;
    status: 'PASSED' | 'FAILED' | 'WARNED';
    command: string;
    config_signature_sha256: string;
    duration_ms: number;
    timed_out: boolean;
    cancelled?: boolean;
    retry_contaminated?: boolean;
    exit_code: number | null;
    forecast_sample_eligible?: boolean;
    forecast_exclusion_reason?: FullSuiteDurationForecastExclusionReason;
}

export interface FullSuiteDurationHistory {
    schema_version: 1;
    history_limit: number;
    updated_at_utc: string;
    entries: FullSuiteDurationHistoryEntry[];
}

export type FullSuiteDurationForecastExclusionReason =
    | 'none'
    | 'timed_out'
    | 'interrupted_or_cancelled'
    | 'retry_contaminated'
    | 'non_passing_status'
    | 'nonzero_exit'
    | 'invalid_duration'
    | 'outlier_duration';

export interface FullSuiteTimeoutForecast {
    history_path: string;
    sample_count: number;
    excluded_sample_count: number;
    excluded_sample_reasons: Partial<Record<FullSuiteDurationForecastExclusionReason, number>>;
    average_duration_seconds: number | null;
    high_watermark_duration_seconds: number | null;
    recommended_timeout_seconds: number;
    safety_margin_seconds: number | null;
    recommendation_source: 'history' | 'config_timeout';
    configured_timeout_seconds: number;
    warning: string | null;
}

export interface FullSuiteDurationHistoryComparison {
    history_path: string;
    previous_sample_count: number;
    previous_average_duration_ms: number | null;
    previous_best_duration_ms: number | null;
    previous_latest_duration_ms: number | null;
    current_duration_ms: number;
    delta_vs_previous_average_ms: number | null;
    delta_vs_previous_best_ms: number | null;
    delta_vs_previous_latest_ms: number | null;
}

export interface FullSuiteTimeoutAttemptEvidence {
    attempt: number;
    exit_code: number | null;
    timed_out: boolean;
    cancelled?: boolean;
}

export interface FullSuiteTimeoutRepairTaskProposal {
    suggested_task_id: string;
    title: string;
    area: string;
    rationale: string;
}

export interface FullSuiteTimeoutBlockerIdentity {
    schema_version: 1;
    source_task_id: string;
    observed_task_id: string;
    base_commit: string;
    scope_sha256: string;
    gate: 'full-suite-validation';
    failure_class: 'timeout_retry_exhausted';
    fingerprint_sha256: string;
}

export interface FullSuiteRepeatedBlockerAnalysis {
    schema_version: 1;
    status: 'REPEATED_BLOCKER';
    source_task_id: string;
    observed_task_id: string;
    matched_ancestor_task_id: string;
    blocker_fingerprint_sha256: string;
    base_commit: string;
    scope_sha256: string;
    gate: 'full-suite-validation';
    failure_class: 'timeout_retry_exhausted';
    required_resolution: 'TRUE_DECOMPOSITION_OR_EXPLICIT_RECOVERY_DECISION';
}

export interface FullSuiteTimeoutPolicyEvidence {
    timeout_blocker: boolean;
    timeout_retry_count: number;
    max_attempts: number;
    attempts: FullSuiteTimeoutAttemptEvidence[];
    attempts_exhausted: boolean;
    warning_only_continuation: boolean;
    repair_task_proposal: FullSuiteTimeoutRepairTaskProposal | null;
    blocker_identity?: FullSuiteTimeoutBlockerIdentity | null;
    repeated_blocker_analysis?: FullSuiteRepeatedBlockerAnalysis | null;
}

export interface FullSuiteCommandProvenance {
    command_descriptor?: import('../../core/validation-command-contract').ValidationCommandDescriptor;
    schema_version: 1;
    source: 'workflow_config.full_suite_validation.command';
    execution_mode: 'DIRECT_ARGV';
    validation_status: 'PASSED' | 'REJECTED';
    rejection_reason: 'SHELL_CONTROL_OPERATOR' | 'SHELL_INTERPRETER' | 'INVALID_ARGUMENT_SYNTAX' | null;
    detected_syntax: string | null;
}

export interface FullSuitePerformanceGuidance {
    mode: 'standard' | 'optimized_sharded' | 'optimized_reuse_aware' | 'optimized_sharded_reuse_aware';
    optimized: boolean;
    mandatory_boundary: string;
    optimized_command: string | null;
    fallback_command: string | null;
}

export interface FullSuiteValidationResult {
    status: 'PASSED' | 'FAILED' | 'WARNED' | 'SKIPPED';
    enabled: boolean;
    command: string;
    placement?: FullSuiteValidationPlacement;
    exit_code: number | null;
    timed_out: boolean;
    output_artifact_path: string | null;
    output_retention?: RawOutputRetentionEvidence | null;
    compact_summary: string[];
    failure_chunks: string[][];
    out_of_scope_failure_policy: OutOfScopeFailurePolicy;
    out_of_scope_failure_detected: boolean;
    out_of_scope_audit_verdict: 'BLOCKED' | 'WARNED' | 'NOT_APPLICABLE';
    harness_failure_detected?: boolean;
    harness_failure_audit_verdict?: 'WARNED' | 'NOT_APPLICABLE';
    harness_failure_reason?: string | null;
    required?: boolean;
    skip_reason?: string | null;
    violations: string[];
    warnings: string[];
    output_telemetry?: Record<string, unknown> | null;
    duration_ms?: number | null;
    duration_history_comparison?: FullSuiteDurationHistoryComparison | null;
    timeout_forecast?: FullSuiteTimeoutForecast | null;
    timeout_policy?: FullSuiteTimeoutPolicyEvidence | null;
    command_provenance?: FullSuiteCommandProvenance;
    cycle_binding?: FullSuiteValidationCycleBinding;
    failure_evidence?: FullSuiteFailureEvidence | null;
}

export interface FullSuiteFailureEvidenceCopiedLog {
    source_path: string;
    artifact_path: string;
    sha256: string;
    bytes: number;
    lines: number;
    truncated: boolean;
}

export type FullSuiteFailureKind = 'assertion' | 'timeout' | 'process_hang' | 'process_exit' | 'unknown';

export interface FullSuiteTopFailure {
    kind: FullSuiteFailureKind;
    summary: string;
    source: 'main_output' | 'copied_log';
    source_path: string | null;
    artifact_path: string | null;
    test_name?: string | null;
    file_path?: string | null;
    line?: number | null;
}

export interface FullSuiteFailureEvidence {
    schema_version: 1;
    task_id: string;
    status: 'FAILED' | 'WARNED';
    command: string;
    exit_code: number | null;
    timed_out: boolean;
    output_artifact_path: string | null;
    summary_artifact_path: string;
    copied_logs: FullSuiteFailureEvidenceCopiedLog[];
    copied_logs_count: number;
    max_copied_logs: number;
    max_log_chars: number;
    failure_kind: FullSuiteFailureKind;
    top_failures: FullSuiteTopFailure[];
    failure_chunks: string[][];
    compact_summary: string[];
    last_output_lines: string[];
    shard_diagnostics: string[];
    timeout_diagnostics: string[];
}

export interface FullSuiteFailureEvidenceOptions {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    result: FullSuiteValidationResult;
    outputLines: string[];
    maxCopiedLogs?: number;
    maxLogChars?: number;
}
