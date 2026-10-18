export interface WorkflowConfigWorkEvidence {
    task_id?: string | null;
    workflow_config_work?: boolean | null;
    orchestrator_work?: boolean | null;
    workflow_config_file_hashes?: Record<string, string | null> | null;
    identity_backfilled_from_legacy?: boolean | null;
}

export interface CurrentWorkflowConfigChanges {
    changed_files: string[];
    current_file_hashes: Record<string, string | null>;
    baseline_file_hashes: Record<string, string | null> | null;
    baseline_source: 'task_mode' | 'protected_manifest' | null;
    scan_error: string | null;
}

export interface WorkflowConfigAuditChangeRecord {
    audit_path: string;
    timestamp_utc: string | null;
    mutation_source: string;
    actor: string | null;
    config_path: string;
    changed_fields: string[];
    active_task_ids: string[];
    active_task_id: string | null;
    after_sha256: string | null;
    before_sha256?: string | null;
    migration_task_entries?: Record<string, string>;
}

export interface WorkflowConfigAuditProvenance {
    accepted: boolean;
    audited_files: string[];
    unaudited_files: string[];
    records: WorkflowConfigAuditChangeRecord[];
    visible_summary_line: string;
}

export interface WorkflowConfigPreTaskBaselineState {
    changed_files: string[];
    compatibility_baseline_files: string[];
    git_changed_files: string[];
    protected_manifest_changed_files: string[];
    protected_manifest_status: 'missing' | 'present' | 'invalid';
}

export interface ProtectedManifestWorkflowConfigHashes {
    status: 'missing' | 'present' | 'invalid';
    hashes: Record<string, string | null>;
}
