import { getDefaultClassificationConfig } from '../../../../src/gates/preflight/classify-change';

export function makeConfig(overrides: Record<string, unknown> = {}) {
    const defaults = getDefaultClassificationConfig('/repo');
    // Re-build flattened config matching getClassificationConfig output shape.
    const base = {
        source: 'defaults',
        config_path: '/repo/garda-agent-orchestrator/live/config/paths.json',
        metrics_path: '/repo/garda-agent-orchestrator/runtime/metrics.jsonl',
        runtime_roots: defaults.runtime_roots.map(r => r.endsWith('/') ? r : r + '/').sort(),
        fast_path_roots: defaults.fast_path_roots.map(r => r.endsWith('/') ? r : r + '/').sort(),
        fast_path_allowed_regexes: defaults.fast_path_allowed_regexes,
        fast_path_sensitive_regexes: defaults.fast_path_sensitive_regexes,
        sql_or_migration_regexes: defaults.sql_or_migration_regexes,
        db_trigger_regexes: defaults.triggers.db,
        security_trigger_regexes: defaults.triggers.security,
        api_trigger_regexes: defaults.triggers.api,
        dependency_trigger_regexes: defaults.triggers.dependency,
        infra_trigger_regexes: defaults.triggers.infra,
        refactor_trigger_regexes: defaults.triggers.refactor,
        test_trigger_regexes: defaults.triggers.test,
        test_refactor_structural_trigger_regexes: [],
        test_refactor_changed_lines_threshold: defaults.test_refactor_changed_lines_threshold,
        performance_trigger_regexes: defaults.triggers.performance,
        security_trigger_name_tokens: defaults.trigger_name_tokens.security,
        db_trigger_name_tokens: defaults.trigger_name_tokens.db,
        code_like_regexes: defaults.code_like_regexes,
        protected_control_plane_roots: defaults.protected_control_plane_roots,
        ordinary_doc_paths: defaults.ordinary_doc_paths
    };
    return { ...base, ...overrides };
}

export const defaultCapabilities = {
    code: true,
    db: true,
    security: true,
    refactor: true,
    api: true,
    test: true,
    performance: true,
    infra: true,
    dependency: true
};
