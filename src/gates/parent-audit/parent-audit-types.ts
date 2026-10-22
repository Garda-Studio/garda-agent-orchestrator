import type { ParentCompletionPolicy } from '../../core/parent-completion-policy';
import type { ValidationReportFile } from '../../core/validation-report-contract';
import type { NativeChildSourceAcceptance } from '../task-audit/task-audit-summary-decomposed-parent-proofs';

export interface ParentRecord extends Record<string, unknown> {
    schema_version: 1;
    event_source: 'parent-audit';
    task_id: string;
    kind: string;
}

export interface ParentCompletionContract extends ParentRecord {
    kind: 'contract';
    policy: ParentCompletionPolicy;
    title: string;
    profile: string;
    child_task_ids: string[];
    requirements: string[];
    unresolved_failures: string[];
    original_commands: string[];
    original_reports: Record<string, ValidationReportFile[]>;
    decomposition_sha256: string | null;
    entry_sha256: string | null;
    compatibility: boolean;
    decomposition_kind: 'strict' | 'guard' | 'manual';
    plan_binding: { path: string; sha256: string } | null;
    wip_capture_sha256: string[];
}

export interface ParentReviewInput extends ParentRecord {
    kind: 'review-input';
    attempt_id: string;
    contract_sha256: string;
    source_commit: string;
    source_tree: string;
    base_commit: string;
    child_sources: Array<{ task_id: string; commit: string; proof_sha256: string }>;
    changed_files: string[];
    diff_path: string;
    diff_sha256: string;
    output_path: string;
    reviewer_instructions: string;
    obligations: Array<{ id: string; description: string; required_finding: boolean }>;
    validation_evidence: Array<{ command: string; status: string; output_path: string | null; output_sha256: string | null }>;
    runtime_identity: { provider: string; entrypoint: string; execution_mode: 'delegated_subagent' };
    preparation_recovery?: { previous_input_sha256: string; reason: string };
}

export interface ParentAuditFinding {
    id: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    title: string;
    description: string;
    remediation: string;
    requirement_ids: string[];
    evidence: string[];
}

export interface ParentAuditOutput {
    schema_version: 1;
    task_id: string;
    attempt_id: string;
    input_sha256: string;
    requirements: Array<{ id: string; result: 'satisfied' | 'finding'; evidence: string[]; finding_ids: string[] }>;
    findings: ParentAuditFinding[];
}

export interface ParentAuditResult extends ParentRecord {
    kind: 'result';
    contract_sha256: string;
    input_sha256: string;
    attempt_id: string;
    reviewer_identity: string;
    output_sha256: string;
    source_commit: string;
    findings: ParentAuditFinding[];
    follow_up_task_id: string | null;
}

export interface ParentCompletionInspection {
    contract: ParentCompletionContract;
    contractSha256: string;
    childSources: NativeChildSourceAcceptance[];
    ready: boolean;
    result: ParentAuditResult | null;
    followUpTaskId: string | null;
    violations: string[];
}
