import type { CompletionGateFinalizationLockPolicy } from '../locks/finalization-lock';
import type {
    buildTokenEconomySummary,
    TaskCycleBindingSnapshot
} from '../task-events-summary/task-events-summary';
import type { EffectiveReviewExecutionPolicyMode } from '../../core/review-execution-policy';
import type { TaskQueueStatusContract } from '../../core/task-queue-status-contract';
import type { KnownNonBlockingSignal } from '../shared/known-nonblocking-signals';
import type {
    BlockerEntry,
    EvidenceArtifact,
    FinalCloseoutArtifactPaths,
    FinalCloseoutDocsSummary,
    FinalCloseoutImplementationSummary,
    FinalCloseoutOptionalSkillsSummary,
    FinalCloseoutReviewIntegrityAttestation,
    FinalCloseoutReviewTrustSummary,
    FinalReportContract,
    GateOutcome,
    ProfileReviewDecisionSummary,
    ReviewAttemptSummary
} from './task-audit-summary-collectors';
import type { ReviewCoverageAuditSummary } from './task-audit-summary-review-coverage';
import type { ReviewFindingsAuditSummary } from './task-audit-summary-review-findings';
import type { TaskQueueEntry } from '../../core/task-queue-read';
import type { FinalCloseoutOrchestratorDefectCaptureSummary } from './task-audit-summary-orchestrator-defects';
import type { WorkspaceSnapshotRequest } from '../workspace/workspace-snapshot-cache';

export interface TaskAuditSummaryOptions {
    taskId: string;
    repoRoot: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
    ignoreActiveCompletionFinalizationLock?: boolean;
    taskQueueEntries?: ReadonlyMap<string, TaskQueueEntry>;
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest;
}

export interface FinalCloseoutArtifact {
    schema_version: 1;
    event_source: 'task-audit-summary';
    task_id: string;
    generated_utc: string;
    audit_status: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    status: 'READY' | 'NOT_READY';
    blocker: string | null;
    artifact_state: 'PENDING' | 'MATERIALIZED' | 'REMOVED' | 'NOT_READY';
    cycle_binding?: (TaskCycleBindingSnapshot & {
        no_op_sha256?: string | null;
        no_op_event_sha256?: string | null;
    }) | null;
    artifact_paths: FinalCloseoutArtifactPaths;
    implementation_summary: FinalCloseoutImplementationSummary;
    review_trust?: FinalCloseoutReviewTrustSummary | null;
    review_timing_audit?: FinalCloseoutReviewTimingAuditSummary | null;
    review_integrity_attestation?: FinalCloseoutReviewIntegrityAttestation;
    review_attempt_summary?: ReviewAttemptSummary | null;
    review_findings_audit?: ReviewFindingsAuditSummary | null;
    review_coverage_summary?: ReviewCoverageAuditSummary | null;
    optional_skills?: FinalCloseoutOptionalSkillsSummary | null;
    workflow?: {
        mandatory_full_suite_enabled: boolean;
        visible_summary_line: string;
        review_execution_policy_mode?: EffectiveReviewExecutionPolicyMode | null;
        review_execution_policy_summary_line?: string | null;
        full_suite_timeout?: FinalCloseoutFullSuiteTimeoutSummary | null;
        workflow_config_audit?: FinalCloseoutWorkflowConfigAuditSummary | null;
    } | null;
    docs: FinalCloseoutDocsSummary;
    project_memory?: FinalCloseoutProjectMemorySummary | null;
    orchestrator_defect_capture?: FinalCloseoutOrchestratorDefectCaptureSummary;
    known_non_blocking_signals?: KnownNonBlockingSignal[];
    token_economy: ReturnType<typeof buildTokenEconomySummary> | null;
    task_cycle_diagnostics?: FinalCloseoutTaskCycleDiagnostics;
    task_queue_status_contract?: TaskQueueStatusContract;
    agent_report?: {
        assistant_language: string | null;
        assistant_language_confirmed: boolean | null;
        next_task_command: string | null;
        latest_update_notice: string | null;
    } | null;
    commit_command_template: string;
    commit_command_suggestion: string;
    commit_question: string;
}

export interface FinalCloseoutTaskCycleDiagnostics {
    status: 'NONE' | 'PARTIAL' | 'DIAGNOSTIC';
    task_status: string | null;
    timeline_warning_kind: string | null;
    missing_lifecycle_events: string[];
    message: string | null;
    repair_guidance: string | null;
    timeline_path: string | null;
    workspace_ready_for_tasks: boolean;
    visible_summary_line: string;
}

export interface FinalCloseoutFullSuiteTimeoutSummary {
    artifact_present: boolean;
    status: string | null;
    timed_out: boolean | null;
    timeout_blocker: boolean | null;
    timeout_retry_count: number | null;
    max_attempts: number | null;
    attempts_count: number;
    attempts_exhausted: boolean | null;
    warning_only_continuation: boolean | null;
    repair_task_proposal: {
        suggested_task_id: string;
        title: string;
        area: string;
        rationale: string;
    } | null;
    warnings: string[];
    forecast_warning: string | null;
    forecast_excluded_sample_count: number | null;
    forecast_excluded_sample_reasons: Record<string, number>;
    visible_summary_line: string;
}

export interface FinalCloseoutWorkflowConfigAuditSummary {
    status: 'none' | 'audited' | 'unaudited';
    changed_files: string[];
    audited_files: string[];
    unaudited_files: string[];
    records: Array<{
        timestamp_utc: string | null;
        mutation_source: string;
        actor: string | null;
        config_path: string;
        changed_fields: string[];
        active_task_ids: string[];
        active_task_id: string | null;
        audit_path: string;
    }>;
    visible_summary_line: string;
}

export interface TaskAuditSummaryResult {
    task_id: string;
    generated_utc: string;
    status: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    events_count: number;
    first_event_utc: string | null;
    last_event_utc: string | null;
    integrity_status: string;
    gates: GateOutcome[];
    changed_files: string[];
    changed_files_count: number;
    changed_lines_total: number;
    required_reviews: Record<string, boolean>;
    scope_category: string | null;
    profile_review_decisions: ProfileReviewDecisionSummary | null;
    evidence: EvidenceArtifact[];
    blockers: BlockerEntry[];
    point_in_time_snapshot: PointInTimeSnapshot;
    task_cycle_diagnostics?: FinalCloseoutTaskCycleDiagnostics;
    review_attempt_summary?: ReviewAttemptSummary | null;
    review_findings_audit?: ReviewFindingsAuditSummary | null;
    review_coverage_summary?: ReviewCoverageAuditSummary | null;
    final_report_contract: FinalReportContract;
    final_closeout: FinalCloseoutArtifact;
}

export interface FinalCloseoutProjectMemorySummary {
    enabled: boolean;
    required: boolean;
    mode: string;
    evidence_status: string;
    status: string | null;
    update_needed: boolean | null;
    affected_memory_files: string[];
    updated_memory_files: string[];
    compact_status: string | null;
    compact_refreshed: boolean | null;
    artifact_path: string;
    update_artifact_path: string;
    visible_summary_line: string;
}

export interface FinalCloseoutReviewTimingAuditEntry {
    review_type: string;
    reviewer_identity: string | null;
    reviewer_execution_mode: string | null;
    reused_existing_review: boolean;
    receipt_path: string;
    receipt_sha256: string | null;
    review_output_path: string | null;
    review_output_sha256: string | null;
    provider: string | null;
    provider_invocation_id: string | null;
    reviewer_launch_attestation_source: string | null;
    launch_prepared_at_utc: string | null;
    delegation_started_at_utc: string | null;
    launched_at_utc: string | null;
    launch_completed_at_utc: string | null;
    invocation_attested_at_utc: string | null;
    review_result_recorded_at_utc: string | null;
    review_output_source_mtime_utc: string | null;
    delegation_to_result_ms: number | null;
    delegation_to_source_mtime_ms: number | null;
    gate_finalize_ms: number | null;
    launch_to_result_ms: number | null;
    launch_to_source_mtime_ms: number | null;
    hidden_timing_status: 'TRUSTED' | 'DISTRUSTED';
    hidden_timing_distrust_code: string | null;
}

export interface FinalCloseoutReviewTimingAuditSummary {
    entries: FinalCloseoutReviewTimingAuditEntry[];
    visible_summary_line: string;
}

export interface PointInTimeSnapshot {
    status: 'STABLE' | 'FINALIZATION_IN_FLIGHT';
    gate: 'completion-gate' | null;
    message: string | null;
    recommended_action: string | null;
    lock_path: string | null;
    owner_pid?: number | null;
    owner_hostname?: string | null;
    owner_created_at_utc?: string | null;
    owner_alive?: boolean | null;
    owner_metadata_status?: string | null;
    stale_reason?: string | null;
    subsystem_scope_note?: string | null;
    acquisition_policy?: CompletionGateFinalizationLockPolicy | null;
}
