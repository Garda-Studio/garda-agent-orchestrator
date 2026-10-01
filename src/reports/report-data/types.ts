import type { WorkflowConfigData } from '../../core/workflow-config';
import type { TaskStatsResult } from '../../cli/commands/stats';
import type { CompactLatestCycleTaskEventsSummary } from '../../gates/task-events-summary';
import type { TaskAuditSummaryResult } from '../../gates/task-audit/task-audit-summary';
import type { WorkspaceSnapshotRequest } from '../../gates/workspace/workspace-snapshot-cache';
import type {
    FullSuiteTimeoutAttemptEvidence,
    FullSuiteTimeoutForecast,
    FullSuiteTimeoutRepairTaskProposal,
    FullSuiteValidationResult
} from '../../gates/full-suite/full-suite-validation';
import type {
    BackupHealthStatus,
    BackupReason
} from '../../lifecycle/backups';
import type {
    WorkflowSettingOption,
    WorkflowSettingValueType
} from '../workflow-setting-metadata';
import type {
    CanonicalOptionalSkillSelectionPolicyMode,
    OptionalSkillSelectionPolicyMode
} from '../../runtime/optional-skill-selection';
import type { ScopeBudgetStatusSnapshot } from '../../core/scope-budget-status';
import type {
    ReviewFindingPolicy,
    ReviewFollowUpPolicy,
    ReviewFollowUpTaskProfileAssignment
} from '../../policy/profile-resolver';
import type { ReviewTriggerPolicy } from '../../policy/review-trigger-policy';
import type { ReviewRemediationModePolicySummary } from '../../policy/review-remediation-mode-policy';
import type { ReviewFollowUpTaskClosurePolicySnapshot } from '../../core/review-follow-up-task-closure-policy';
import type { NextStepResult } from '../../gates/next-step';
import type { ReportTaskTimeline } from './task-timeline';

export const REPORT_DATA_CONTRACT_SCHEMA_VERSION = 1;
export const DEFAULT_REPORT_MAX_DETAILED_TASKS = 0;

export interface ReportDataUnavailableEntry {
    scope: string;
    reason: string;
}

export interface ReportTaskQueueRow {
    task_id: string;
    status: string;
    status_token: string | null;
    priority: string;
    area: string;
    title: string;
    owner: string;
    updated: string;
    profile: string;
    notes: string;
}

export interface ReportTaskActivitySummary {
    lifecycle_event_count: number;
    first_lifecycle_event_utc: string | null;
    last_lifecycle_event_utc: string | null;
    review_attempt_count: number;
    review_receipt_count: number;
    artifact_count: number;
    metric_sample_count: number;
    verification_status: string | null;
    health_state: string | null;
    retention_state: string | null;
    retention_tier: string | null;
}

export interface ReportArtifactLink {
    kind: string;
    path: string;
    exists: boolean;
    sha256: string | null;
}

export type ReportFullSuiteState =
    | 'not_required'
    | 'not_run'
    | 'passed'
    | 'warned'
    | 'failed'
    | 'timed_out'
    | 'skipped'
    | 'stale'
    | 'unavailable';

export type ReportFullSuiteFreshness =
    | 'not_required'
    | 'missing'
    | 'current'
    | 'reused_current_scope'
    | 'stale'
    | 'unavailable';

export interface ReportFullSuiteSummary {
    state: ReportFullSuiteState;
    freshness: ReportFullSuiteFreshness;
    enabled: boolean;
    required: boolean;
    status: FullSuiteValidationResult['status'] | null;
    command: string;
    placement: WorkflowConfigData['full_suite_validation']['placement'];
    duration_ms: number | null;
    duration_human: string | null;
    timed_out: boolean | null;
    exit_code: number | null;
    timeout_blocker: boolean;
    timeout_retry_count: number;
    timeout_max_attempts: number;
    timeout_attempts: FullSuiteTimeoutAttemptEvidence[];
    timeout_attempts_exhausted: boolean | null;
    timeout_warning_only_continuation: boolean | null;
    timeout_repair_task_proposal: FullSuiteTimeoutRepairTaskProposal | null;
    artifact_path: string;
    artifact_exists: boolean;
    artifact_sha256: string | null;
    output_artifact_path: string | null;
    updated_at_utc: string | null;
    compact_summary: string[];
    violations: string[];
    warnings: string[];
    skip_reason: string | null;
    mismatch_reason: string | null;
    timeout_forecast: FullSuiteTimeoutForecast;
    timeout_forecast_label: string;
}

export interface ReportTaskDetail {
    task_id: string;
    detail_status: 'loaded' | 'skipped';
    progress: {
        state: 'active' | 'blocked' | 'stale' | 'unknown' | 'incomplete' | 'completed' | 'unavailable';
        navigator_status: NextStepResult['status'] | null;
        completed_stages: Array<{ gate: string; timestamp_utc: string | null }>;
        current_stage: string | null;
        remaining_stages: Array<{ gate: string; status: 'failed' | 'pending' | 'unknown' }>;
        blocker: { gate: string | null; reason: string } | null;
        next_action: { gate: string | null; label: string; command: string | null } | null;
        final_report: {
            state: 'available' | 'missing' | 'pending' | 'stale' | 'unavailable';
            path: string | null;
            exists: boolean;
            sha256: string | null;
        };
        evidence_references: ReportArtifactLink[];
        timing: { first_event_utc: string | null; last_event_utc: string | null };
        diagnostics: string[];
    } | null;
    stats: TaskStatsResult | null;
    latest_cycle_events: CompactLatestCycleTaskEventsSummary | null;
    timeline?: ReportTaskTimeline | null;
    full_suite_validation: ReportFullSuiteSummary;
    review_follow_up_task_closure_policy: {
        stored: ReviewFollowUpTaskClosurePolicySnapshot;
        effective: ReviewFollowUpTaskClosurePolicySnapshot;
        effective_source: 'task_metadata' | 'task_mode_profile_policy_snapshot';
        state: 'editable' | 'inapplicable' | 'invalid' | 'completed' | 'pending_next_cycle';
        editable: boolean;
        editable_reason: string | null;
        metadata_path: string;
        drift_detected: boolean;
        diagnostics: string[];
    };
    audit: {
        status: TaskAuditSummaryResult['status'];
        gates: TaskAuditSummaryResult['gates'];
        blockers: TaskAuditSummaryResult['blockers'];
        required_reviews: TaskAuditSummaryResult['required_reviews'];
        changed_files: string[];
        review_attempt_summary: TaskAuditSummaryResult['review_attempt_summary'];
        review_findings_audit: TaskAuditSummaryResult['review_findings_audit'];
        final_report_contract_status: TaskAuditSummaryResult['final_report_contract']['status'];
        final_closeout_artifact_state: TaskAuditSummaryResult['final_closeout']['artifact_state'];
    } | null;
    plan: {
        available: boolean;
        task_id: string;
        task_title: string | null;
        task_status: string | null;
        summary: string | null;
        plan_path: string | null;
        markdown_path: string | null;
        markdown: string | null;
    };
    artifact_links: ReportArtifactLink[];
    quality_checklist: ReportTaskQualityChecklist;
    unavailable: ReportDataUnavailableEntry[];
}

export interface ReportTaskRow extends ReportTaskQueueRow {
    activity_summary: ReportTaskActivitySummary | null;
    detail: ReportTaskDetail;
}

export interface ReportWorkflowSetting {
    id: string;
    key: string;
    label: string;
    value: unknown;
    value_type: WorkflowSettingValueType;
    options: WorkflowSettingOption[];
    flag: string;
    command: string;
    description: string;
    editable: boolean;
    min?: number;
    max?: number;
    placeholder?: string;
    readiness?: {
        ready: boolean;
        configured_enabled: boolean;
        audited_enablement: boolean;
        disabled_reason: string | null;
        remediation_command: string | null;
        remediation_action_id: string | null;
    };
    readonly: true;
}

export interface ReportWorkflowConfigTab {
    compact_cache?: { bytes: number; runs: number; available: boolean };
    config_path: string;
    config_exists: boolean;
    status: 'present' | 'missing' | 'invalid';
    settings: ReportWorkflowSetting[];
    optional_quality_checks: WorkflowConfigData['optional_quality_checks'];
    optional_skill_selection_policy: {
        config_path: string;
        config_exists: boolean;
        status: 'present' | 'missing' | 'invalid';
        mode: OptionalSkillSelectionPolicyMode;
        effective_mode: CanonicalOptionalSkillSelectionPolicyMode;
        unavailable: ReportDataUnavailableEntry[];
    };
    unavailable: ReportDataUnavailableEntry[];
}

export type ReportQualityGateRuleSource = 'baseline' | 'custom';
export type ReportQualityGateRuleStatus = 'active' | 'disabled' | 'locally_edited' | 'deleted';

export interface ReportQualityGateRule {
    id: string;
    title: string;
    prompt: string;
    enabled: boolean;
    excluded_scope_categories: string[];
    present: boolean;
    source: ReportQualityGateRuleSource;
    statuses: ReportQualityGateRuleStatus[];
    baseline_title: string | null;
    baseline_prompt: string | null;
    baseline_excluded_scope_categories: string[] | null;
}

export type ReportQualityGateEvidenceStatus = 'current' | 'stale' | 'missing' | 'invalid' | 'disabled';
export type ReportQualityGateEffect = 'passed' | 'helped' | 'warned' | 'required_rework' | 'disabled' | 'skipped_cadence' | 'missing' | 'invalid' | 'stale';

export interface ReportQualityGateAnswerSummary {
    rule_id: string;
    status: string;
    answer: string;
    evidence_files: string[];
    actions_taken: string[];
    actions_required: string[];
}

export interface ReportQualityGateSkippedRuleSummary {
    rule_id: string;
    title: string;
    excluded_scope_categories: string[];
    scope_skip_reason: string | null;
}

export interface ReportQualityGateLatestCheck {
    artifact_path: string | null;
    artifact_exists: boolean;
    evidence_status: ReportQualityGateEvidenceStatus;
    checklist_status: string | null;
    outcome: string | null;
    effect: ReportQualityGateEffect;
    summary: string;
    stale_reason_codes?: string[];
    stale_reasons: string[];
    task_id: string | null;
    timestamp_utc: string | null;
    preflight_path: string | null;
    preflight_sha256: string | null;
    workflow_config_sha256: string | null;
    effective_policy_sha256: string | null;
    scope_category: string | null;
    changed_files_count: number | null;
    changed_files_preview: string[];
    changed_files_truncated: boolean;
    enabled_rule_count: number;
    active_rule_count: number | null;
    skipped_by_scope_rule_count: number | null;
    skipped_by_scope_rules: ReportQualityGateSkippedRuleSummary[];
    answer_count: number;
    action_taken_count: number;
    action_required_count: number;
    actions_taken: string[];
    actions_required: string[];
    answers: ReportQualityGateAnswerSummary[];
    timeline_event_count: number;
    latest_timeline_event_utc: string | null;
}

export interface ReportQualityGateActionRequiredHistoryEntry {
    task_id: string | null;
    timestamp_utc: string | null;
    artifact_path: string;
    evidence_status: ReportQualityGateEvidenceStatus;
    action_required_count: number;
    actions_required: string[];
    changed_files_count: number | null;
    changed_files_preview: string[];
}

export interface ReportTaskQualityChecklistLatest {
    artifact_path: string;
    artifact_exists: boolean;
    artifact_sha256: string | null;
    evidence_status: ReportQualityGateEvidenceStatus;
    checklist_status: string | null;
    outcome: string | null;
    effect: ReportQualityGateEffect;
    summary_key?: string;
    summary: string;
    stale_reason_codes?: string[];
    stale_reasons: string[];
    timestamp_utc: string | null;
    changed_files_count: number | null;
    changed_files_preview: string[];
    answer_count: number;
    action_taken_count: number;
    action_required_count: number;
    actions_taken: string[];
    actions_required: string[];
    answers: ReportQualityGateAnswerSummary[];
}

export interface ReportTaskQualityChecklist {
    latest: ReportTaskQualityChecklistLatest | null;
    action_required_history: ReportQualityGateActionRequiredHistoryEntry[];
}

export interface ReportQualityGateTab {
    config_path: string;
    config_exists: boolean;
    status: ReportWorkflowConfigTab['status'];
    enabled: boolean;
    baseline_version: string;
    shipped_baseline_version: string;
    baseline_version_label: string;
    shipped_baseline_version_label: string;
    baseline_rule_count: number;
    custom_rule_count: number;
    deleted_baseline_rule_count: number;
    rules: ReportQualityGateRule[];
    latest_check: ReportQualityGateLatestCheck;
    action_required_history: ReportQualityGateActionRequiredHistoryEntry[];
    unavailable: ReportDataUnavailableEntry[];
}

export type ReportProfileSource = 'built_in' | 'user';
export type ReportProfileReviewPolicyValue = boolean | 'auto';

export interface ReportProfileReviewType {
    id: string;
    label: string;
}

export type ReportReviewCatalogProfileState = 'disabled' | 'auto' | 'required';

export interface ReportReviewCatalogLane {
    id: string;
    display_label: string;
    source: 'built_in' | 'custom';
    built_in: boolean;
    enabled_by_default: boolean;
    capability_enabled: boolean;
    skill_ids: string[];
    trigger: {
        mode: 'compatibility' | 'manual' | 'signals';
        signal_ids: string[];
    };
    coverage_category_ids: string[];
    reviewer_role: {
        role_id: string;
        focus_tags: string[];
    };
    verdict_tokens: {
        pass: string;
        fail: string;
    };
    profile: {
        name: string;
        state: ReportReviewCatalogProfileState;
        state_source: 'profile' | 'built_in_compatibility_default' | 'custom_disabled_default';
        active: boolean;
        inactive_reason: 'profile_disabled' | 'capability_disabled' | null;
        dependencies: string[];
        explanation: string[];
    };
}

export interface ReportReviewCatalogTab {
    status: 'present' | 'legacy_compatible' | 'invalid';
    catalog_path: string;
    capabilities_path: string;
    profiles_path: string;
    catalog_exists: boolean;
    catalog_sha256: string | null;
    state_sha256: string | null;
    active_profile: string | null;
    selected_profile: string | null;
    profile_names: string[];
    known_skill_ids: string[];
    validation: {
        status: 'PASS' | 'FAIL';
        issues: string[];
    };
    migration: {
        status: 'current' | 'legacy_compatible' | 'blocked_invalid';
        required: boolean;
        reason: string;
    };
    lanes: ReportReviewCatalogLane[];
}

export interface ReportProfileRow {
    name: string;
    source: ReportProfileSource;
    active: boolean;
    protected: boolean;
    description: string;
    depth: number;
    task_decomposition: {
        enabled: boolean;
        configured: boolean;
        provenance: string;
        diagnostics: string[];
        valid: boolean;
    };
    review_policy: Record<string, ReportProfileReviewPolicyValue>;
    review_finding_policy: ReviewFindingPolicy;
    review_finding_policy_sha256: string;
    review_finding_policy_migration: {
        required: boolean;
        reason: string;
        target_policy_id: ReviewFindingPolicy['policy_id'];
        diagnostics: string[];
    };
    review_follow_up_policy: ReviewFollowUpPolicy;
    review_follow_up_policy_diagnostics: string[];
    review_follow_up_task_profile_assignment: ReviewFollowUpTaskProfileAssignment;
    review_remediation_mode_policy: ReviewRemediationModePolicySummary;
    token_economy: Record<string, boolean>;
    skills: Record<string, boolean>;
}

export interface ReportProfilesTab {
    config_path: string;
    config_exists: boolean;
    status: 'present' | 'missing' | 'invalid';
    active_profile: string | null;
    review_trigger_policy: ReviewTriggerPolicy | null;
    review_types: ReportProfileReviewType[];
    review_catalog: ReportReviewCatalogTab;
    profiles: ReportProfileRow[];
    built_in_profile_names: string[];
    user_profile_names: string[];
    unavailable: ReportDataUnavailableEntry[];
}

export interface ReportInstructionEntry {
    id: string;
    title: string;
    body: string;
}

export interface ReportValueRow {
    id: string;
    label: string;
    description: string;
    value: unknown;
    file_path?: string | null;
}

export interface ReportCommandInfo {
    id: string;
    title: string;
    description: string;
    command: string;
}

export interface ReportOrdinaryDocsInfo {
    config_path: string;
    status: 'present' | 'missing' | 'invalid';
    paths: string[];
    unavailable: ReportDataUnavailableEntry[];
}

export interface ReportInitSettingsTab {
    init_answers_path: string;
    init_answers_status: 'present' | 'missing' | 'invalid';
    init_answers: ReportValueRow[];
    agent_init_state_path: string;
    agent_init_state_status: 'present' | 'missing' | 'invalid';
    agent_init_state: ReportValueRow[];
    ordinary_docs: ReportOrdinaryDocsInfo;
    commands: ReportCommandInfo[];
    unavailable: ReportDataUnavailableEntry[];
}

export interface ReportProjectMemoryFile {
    id: string;
    path: string;
    exists: boolean;
    purpose: string;
    read_role: 'read_first' | 'focused';
    size_bytes: number | null;
}

export interface ReportProjectMemoryAdvisory {
    prompt_path: string;
    prompt_exists: boolean;
}

export interface ReportProjectMemoryTab {
    settings_config_path: string;
    memory_directory_path: string;
    advisory: ReportProjectMemoryAdvisory;
    status: ReportValueRow[];
    settings: ReportWorkflowSetting[];
    files: ReportProjectMemoryFile[];
    unavailable: ReportDataUnavailableEntry[];
}

export interface ReportBackupRow {
    id: string;
    reason: BackupReason;
    created_at: string;
    size_bytes: number;
    size_human: string;
    health: BackupHealthStatus;
    health_message: string | null;
    record_count: number;
    relative_snapshot_path: string;
    restorable: boolean;
}

export interface ReportBackupsTab {
    workflow_config_path: string;
    snapshots_root: string;
    snapshots_root_exists: boolean;
    auto_backup: {
        enabled: boolean;
        interval_days: number;
        keep_latest: number;
    };
    rows: ReportBackupRow[];
    unavailable: ReportDataUnavailableEntry[];
}

export type ReportSystemStateHealth = 'ok' | 'attention' | 'error' | 'unknown';

export interface ReportSystemStateSignal {
    id: string;
    label: string;
    status: ReportSystemStateHealth;
    summary: string;
    remediation: string | null;
    value: unknown;
    source_path: string | null;
}

export interface ReportSystemStateConfigFile {
    id: string;
    label: string;
    path: string;
    status: 'present' | 'missing' | 'invalid';
    role: 'primary' | 'secondary';
}

export interface ReportSystemState {
    overall: {
        status: ReportSystemStateHealth;
        label: string;
        summary: string;
        generated_at_utc: string;
    };
    garda: ReportSystemStateSignal;
    ui_actions: ReportSystemStateSignal;
    task_queue: ReportSystemStateSignal & {
        counts: {
            total: number;
            active: number;
            todo: number;
            blocked: number;
            done: number;
            decomposed: number;
        };
        next_task_id: string | null;
    };
    workflow: ReportSystemStateSignal & {
        compile_command: string | null;
        full_suite_enabled: boolean;
        full_suite_command: string | null;
        full_suite_timeout_forecast_label: string | null;
        full_suite_timeout_blocker: boolean | null;
        full_suite_timeout_retry_count: number | null;
        full_suite_timeout_attempts_count: number | null;
        full_suite_timeout_max_attempts: number | null;
        full_suite_timeout_attempts_exhausted: boolean | null;
        full_suite_timeout_warning_only_continuation: boolean | null;
        full_suite_timeout_latest_warning: string | null;
        task_reset_ready: boolean;
    };
    scope_budget: ReportSystemStateSignal & {
        evaluation: ScopeBudgetStatusSnapshot;
    };
    quality_baseline: ReportSystemStateSignal;
    project_memory: ReportSystemStateSignal;
    protected_manifest: ReportSystemStateSignal & {
        assessment_code: string | null;
        changed_files: string[];
    };
    runtime: {
        stale_locks: ReportSystemStateSignal;
        incomplete_timeline: ReportSystemStateSignal;
        artifact_scan: ReportSystemStateSignal;
        artifact_signals: ReportSystemStateSignal[];
    };
    configuration_files: ReportSystemStateConfigFile[];
    signals: ReportSystemStateSignal[];
}

export interface ReportDataContract {
    schema_version: typeof REPORT_DATA_CONTRACT_SCHEMA_VERSION;
    generated_at_utc: string;
    repo_root: string;
    system_state: ReportSystemState;
    tasks_tab: {
        source_path: string;
        parser: 'canonical_active_queue_9_columns';
        rows: ReportTaskRow[];
    };
    workflow_config_tab: ReportWorkflowConfigTab;
    quality_gate_tab: ReportQualityGateTab;
    profiles_tab: ReportProfilesTab;
    init_settings_tab: ReportInitSettingsTab;
    project_memory_tab: ReportProjectMemoryTab;
    backups_tab: ReportBackupsTab;
    instructions_tab: {
        entries: ReportInstructionEntry[];
    };
    unavailable: ReportDataUnavailableEntry[];
}

export interface BuildReportDataContractOptions {
    repoRoot: string;
    generatedAtUtc?: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
    maxDetailedTasks?: number | null;
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest;
}

export interface BuildReportTaskDetailOptions {
    taskId: string;
    repoRoot: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest;
}
