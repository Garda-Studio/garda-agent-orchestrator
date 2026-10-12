export type ValidationPurpose = 'test' | 'compile' | 'typecheck' | 'validation';
export type ValidationInputRole = 'source' | 'test' | 'helper' | 'config';
export interface ValidationInput { path: string; role: ValidationInputRole }
export interface ValidationTarget { id: string; source: string; selector: string }
export interface ValidationRecipe {
    id: string;
    purpose: ValidationPurpose;
    executable: string;
    argv: Array<string | { target: string }>;
    cwd: string;
    inputs: ValidationInput[];
    targets: ValidationTarget[];
    environment: Record<string, string>;
    timeout_ms: number;
    max_attempts: number;
    max_output_bytes: number;
    max_input_bytes: number;
    required_capabilities: Array<'offline' | 'write_confinement'>;
    result_format: 'tap' | 'opaque';
}
export interface ProjectValidationContract {
    schema_version: 1;
    recipes: ValidationRecipe[];
}
export interface ValidationFileIdentity {
    path: string;
    sha256: string;
    size: number;
    identity: string;
}
export interface ApprovedValidationContract {
    schema_version: 1;
    contract: ProjectValidationContract;
    tools: Record<string, ValidationFileIdentity>;
    dependencies: Record<string, ValidationFileIdentity>;
}
export interface FrozenValidationRecipe {
    schema_version: 1;
    task_id: string;
    preflight_sha256: string;
    authority_sha256: string;
    scope_sha256: string;
    recipe: ValidationRecipe;
    tool: ValidationFileIdentity;
    inputs: ValidationFileIdentity[];
    snapshot_sha256: string;
}
export interface ValidationCase { id: string; outcome: 'passed' | 'failed' | 'skipped' }
export interface ValidationAttempt {
    schema_version: 1;
    attempt_id: string;
    snapshot: FrozenValidationRecipe;
    started_at: string;
    completed_at?: string;
    termination_signal?: string | null;
    duration_ms: number;
    exit_code: number;
    timed_out: boolean;
    cancelled: boolean;
    output_path: string;
    source_archive_path: string;
    source_archive_sha256: string;
    output_sha256: string;
    output_bytes: number;
    truncated: boolean;
    cases: ValidationCase[] | null;
    violations: string[];
    expected_failure: boolean;
}
