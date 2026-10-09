import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowSettingRegistry } from '../../../../src/core/workflow-setting-manifest';
import { COMPACT_SETTING_REGISTRY } from '../../../../src/core/compact/setting-definitions';
import { BACKUP_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/backup';
import { COMPILE_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/compile';
import { FULL_SUITE_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/full-suite';
import { OPTIONAL_QUALITY_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/optional-quality';
import { PROJECT_MEMORY_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/project-memory';
import { PROTECTED_CONTROL_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/protected-controls';
import { REVIEW_CYCLE_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/review-cycle';
import { REVIEW_EXECUTION_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/review-execution';
import { SCOPE_BUDGET_CONTROL_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/scope-budget-controls';
import { SCOPE_BUDGET_THRESHOLD_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/scope-budget-thresholds';
import { WORKFLOW_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/registry';

const registry = WORKFLOW_SETTING_REGISTRY;
// Independent complete contract captured from accepted family HEAD 56dd690a before assembly.
// No expectation is derived from the aggregate or report implementation under test.
const EXPECTED_CONTRACT = [
    ["compact-enabled", "compact.enabled", "--compact-enabled", "boolean", true, {"kind": "workflow", "section": "compact"}],
    ["compact-git", "compact.git", "--compact-git", "boolean", true, {"kind": "workflow", "section": "compact"}],
    ["compact-file", "compact.file", "--compact-file", "boolean", true, {"kind": "workflow", "section": "compact"}],
    ["compact-rg", "compact.rg", "--compact-rg", "boolean", true, {"kind": "workflow", "section": "compact"}],
    ["compact-preview-lines", "compact.preview_lines", "--compact-preview-lines", "integer", 20, {"kind": "workflow", "section": "compact"}],
    ["compact-preview-chars", "compact.preview_chars", "--compact-preview-chars", "integer", 3000, {"kind": "workflow", "section": "compact"}],
    ["compact-exact-bytes", "compact.exact_bytes", "--compact-exact-bytes", "integer", 8192, {"kind": "workflow", "section": "compact"}],
    ["compact-read-bytes", "compact.read_bytes", "--compact-read-bytes", "integer", 4096, {"kind": "workflow", "section": "compact"}],
    ["compact-search-context", "compact.search_context", "--compact-search-context", "integer", 2, {"kind": "workflow", "section": "compact"}],
    ["compact-run-bytes", "compact.run_bytes", "--compact-run-bytes", "integer", 16777216, {"kind": "workflow", "section": "compact"}],
    ["compact-task-bytes", "compact.task_bytes", "--compact-task-bytes", "integer", 67108864, {"kind": "workflow", "section": "compact"}],
    ["compact-workspace-bytes", "compact.workspace_bytes", "--compact-workspace-bytes", "integer", 268435456, {"kind": "workflow", "section": "compact"}],
    ["compact-max-runs", "compact.max_runs", "--compact-max-runs", "integer", 2048, {"kind": "workflow", "section": "compact"}],
    ["full-suite-enabled", "full_suite_validation.enabled", "--full-suite-enabled", "boolean", false, {"kind": "workflow", "section": "full-suite-validation"}],
    ["optional-checks-enabled", "optional_quality_checks.enabled", "--optional-checks-enabled", "boolean", true, {"kind": "workflow", "section": "optional-quality-checks"}],
    ["optional-checks-review-failure-cadence-interval", "optional_quality_checks.review_failure_cadence_interval", "--optional-checks-review-failure-cadence-interval", "integer", 3, {"kind": "workflow", "section": "optional-quality-checks"}],
    ["compile-gate-command", "compile_gate.command", "--compile-gate-command", "string", "__COMPILE_GATE_COMMAND_UNCONFIGURED__", {"kind": "workflow", "section": "compile-gate"}],
    ["full-suite-command", "full_suite_validation.command", "--full-suite-command", "string", "__FULL_SUITE_COMMAND_UNCONFIGURED__", {"kind": "workflow", "section": "full-suite-validation"}],
    ["full-suite-timeout-ms", "full_suite_validation.timeout_ms", "--full-suite-timeout-ms", "integer", 900000, {"kind": "workflow", "section": "full-suite-validation"}],
    ["full-suite-timeout-blocker", "full_suite_validation.timeout_blocker", "--full-suite-timeout-blocker", "boolean", true, {"kind": "workflow", "section": "full-suite-validation"}],
    ["full-suite-timeout-retry-count", "full_suite_validation.timeout_retry_count", "--full-suite-timeout-retry-count", "integer", 1, {"kind": "workflow", "section": "full-suite-validation"}],
    ["full-suite-green-summary-max-lines", "full_suite_validation.green_summary_max_lines", "--full-suite-green-summary-max-lines", "integer", 5, {"kind": "workflow", "section": "full-suite-validation"}],
    ["full-suite-red-failure-chunk-lines", "full_suite_validation.red_failure_chunk_lines", "--full-suite-red-failure-chunk-lines", "integer", 50, {"kind": "workflow", "section": "full-suite-validation"}],
    ["full-suite-out-of-scope-failure-policy", "full_suite_validation.out_of_scope_failure_policy", "--full-suite-out-of-scope-failure-policy", "enum", "AUDIT_AND_BLOCK", {"kind": "workflow", "section": "full-suite-validation"}],
    ["full-suite-placement", "full_suite_validation.placement", "--full-suite-placement", "enum", "after_compile_before_reviews", {"kind": "workflow", "section": "full-suite-validation"}],
    ["review-execution-policy", "review_execution_policy.mode", "--review-execution-policy", "enum", "strict_sequential", {"kind": "workflow", "section": "review-execution-policy"}],
    ["scope-budget-enabled", "scope_budget_guard.enabled", "--scope-budget-enabled", "boolean", true, {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-action", "scope_budget_guard.action", "--scope-budget-action", "enum", "WARN_ONLY", {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-profiles", "scope_budget_guard.profiles", "--scope-budget-profiles", "enum_list", ["strict"], {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-max-files", "scope_budget_guard.max_files", "--scope-budget-max-files", "integer", 20, {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-max-changed-lines", "scope_budget_guard.max_changed_lines", "--scope-budget-max-changed-lines", "integer", 2000, {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-max-required-reviews", "scope_budget_guard.max_required_reviews", "--scope-budget-max-required-reviews", "integer", 5, {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-max-review-tokens", "scope_budget_guard.max_review_tokens", "--scope-budget-max-review-tokens", "integer", 50000, {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-warn-files", "scope_budget_guard.warn_files", "--scope-budget-warn-files", "integer", 20, {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-block-files", "scope_budget_guard.block_files", "--scope-budget-block-files", "integer", 50, {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-warn-changed-lines", "scope_budget_guard.warn_changed_lines", "--scope-budget-warn-changed-lines", "integer", 2000, {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-block-changed-lines", "scope_budget_guard.block_changed_lines", "--scope-budget-block-changed-lines", "integer", 5000, {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-warn-required-reviews", "scope_budget_guard.warn_required_reviews", "--scope-budget-warn-required-reviews", "integer", 5, {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-block-required-reviews", "scope_budget_guard.block_required_reviews", "--scope-budget-block-required-reviews", "integer", 8, {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-warn-review-tokens", "scope_budget_guard.warn_review_tokens", "--scope-budget-warn-review-tokens", "integer", 50000, {"kind": "workflow", "section": "scope-budget-guard"}],
    ["scope-budget-block-review-tokens", "scope_budget_guard.block_review_tokens", "--scope-budget-block-review-tokens", "integer", 100000, {"kind": "workflow", "section": "scope-budget-guard"}],
    ["review-cycle-enabled", "review_cycle_guard.enabled", "--review-cycle-enabled", "boolean", true, {"kind": "workflow", "section": "review-cycle-guard"}],
    ["review-cycle-action", "review_cycle_guard.action", "--review-cycle-action", "enum", "BLOCK_FOR_OPERATOR_DECISION", {"kind": "workflow", "section": "review-cycle-guard"}],
    ["review-cycle-max-failed-non-test-reviews", "review_cycle_guard.max_failed_non_test_reviews", "--review-cycle-max-failed-non-test-reviews", "integer", 10, {"kind": "workflow", "section": "review-cycle-guard"}],
    ["review-cycle-max-total-non-test-reviews", "review_cycle_guard.max_total_non_test_reviews", "--review-cycle-max-total-non-test-reviews", "integer", 30, {"kind": "workflow", "section": "review-cycle-guard"}],
    ["review-cycle-excluded-review-types", "review_cycle_guard.excluded_review_types", "--review-cycle-excluded-review-types", "enum_list", ["test"], {"kind": "workflow", "section": "review-cycle-guard"}],
    ["review-cycle-auto-split-enabled", "review_cycle_guard.auto_split_enabled", "--review-cycle-auto-split-enabled", "boolean", true, {"kind": "workflow", "section": "review-cycle-guard"}],
    ["project-memory-enabled", "project_memory_maintenance.enabled", "--project-memory-enabled", "boolean", true, {"kind": "workflow", "section": "project-memory"}],
    ["project-memory-mode", "project_memory_maintenance.mode", "--project-memory-mode", "enum", "update", {"kind": "workflow", "section": "project-memory"}],
    ["project-memory-run-before-final-closeout", "project_memory_maintenance.run_before_final_closeout", "--project-memory-run-before-final-closeout", "boolean", true, {"kind": "workflow", "section": "project-memory"}],
    ["project-memory-require-user-approval-for-writes", "project_memory_maintenance.require_user_approval_for_writes", "--project-memory-require-user-approval-for-writes", "boolean", true, {"kind": "workflow", "section": "project-memory"}],
    ["project-memory-max-compact-summary-chars", "project_memory_maintenance.max_compact_summary_chars", "--project-memory-max-compact-summary-chars", "integer", 12000, {"kind": "workflow", "section": "project-memory"}],
    ["project-memory-read-strategy", "project_memory_maintenance.read_strategy", "--project-memory-read-strategy", "enum", "index_first", {"kind": "workflow", "section": "project-memory"}],
    ["project-memory-impact-retention-days", "project_memory_maintenance.impact_artifact_retention_days", "--project-memory-impact-artifact-retention-days", "integer", 30, {"kind": "workflow", "section": "project-memory"}],
    ["task-reset-enabled", "task_reset.enabled", "--task-reset-enabled", "boolean", false, {"kind": "workflow", "section": "task-reset"}],
    ["local-commit-enabled", "local_commit.enabled", "--local-commit-enabled", "boolean", false, {"kind": "workflow", "section": "local-commit"}],
    ["auto-backup-enabled", "auto_backup.enabled", "--auto-backup-enabled", "boolean", false, {"kind": "workflow", "section": "auto-backup"}],
    ["auto-backup-interval-days", "auto_backup.interval_days", "--auto-backup-interval-days", "integer", 1, {"kind": "workflow", "section": "auto-backup"}],
    ["auto-backup-keep-latest", "auto_backup.keep_latest", "--auto-backup-keep-latest", "integer", 10, {"kind": "workflow", "section": "auto-backup"}],
    ["garda-self-guard", "orchestrator_work_policy.mode", "--garda-self-guard", "enum", "deny_agent_entry", {"kind": "workflow", "section": "orchestrator-work-policy"}]
];

const families = [COMPACT_SETTING_REGISTRY, BACKUP_SETTING_REGISTRY, COMPILE_SETTING_REGISTRY,
    FULL_SUITE_SETTING_REGISTRY, OPTIONAL_QUALITY_SETTING_REGISTRY, PROJECT_MEMORY_SETTING_REGISTRY,
    PROTECTED_CONTROL_SETTING_REGISTRY, REVIEW_CYCLE_SETTING_REGISTRY, REVIEW_EXECUTION_SETTING_REGISTRY,
    SCOPE_BUDGET_CONTROL_SETTING_REGISTRY, SCOPE_BUDGET_THRESHOLD_SETTING_REGISTRY];

test('aggregate retains every accepted id, key, flag, type, default, owner and deterministic order', () => {
    assert.deepEqual(registry.entries.map(entry => [entry.id, entry.key, entry.cli.flag,
        entry.value_type, entry.default_value, entry.owner]), EXPECTED_CONTRACT);
    assert.equal(registry.entries.length, 60);
    assert.ok(Object.isFrozen(registry));
    assert.ok(Object.isFrozen(registry.entries));
    assert.throws(() => (registry.entries as unknown[]).push({}), TypeError);
    assert.equal(registry.get('COMPACT-ENABLED'), registry.require('compact-enabled'));
    assert.equal(registry.get('optional-skill-selection-mode'), null);
    assert.throws(() => registry.require('optional-skill-selection-mode'), /Unknown workflow setting/);
});

test('all compact and family validators and materializers are reused without competing policy', () => {
    const ownerEntries = families.flatMap(family => family.entries);
    assert.equal(ownerEntries.length, 60);
    for (const ownerEntry of ownerEntries) {
        const entry = registry.require(ownerEntry.id);
        assert.equal(entry.validate, ownerEntry.validate);
        assert.equal(entry.materialize, ownerEntry.materialize);
        assert.deepEqual(entry.ui, ownerEntry.ui);
        assert.deepEqual(entry.cli, ownerEntry.cli);
        assert.deepEqual(registry.validate(entry.id, entry.default_value), ownerEntry.default_value);
        assert.ok(Object.isFrozen(entry));
        assert.ok(Object.isFrozen(entry.owner));
        assert.ok(Object.isFrozen(entry.ui));
        for (const target of ['live', 'template'] as const) {
            const family = families.find(candidate => candidate.get(entry.id))!;
            const changes = registry.materialize(entry.id, entry.default_value, { target });
            assert.deepEqual(changes, family.materialize(entry.id, ownerEntry.default_value, { target }));
            assert.ok(Object.isFrozen(changes));
            assert.ok(changes.every(change => Object.isFrozen(change)));
        }
        assert.throws(() => registry.validate(entry.id, null), /Invalid value/);
        assert.throws(() => registry.materialize(entry.id, null, { target: 'live' }), /Invalid value/);
    }
});

test('composition retains cross-family duplicate and sensitive-definition rejection', () => {
    const first = registry.entries[0];
    assert.throws(() => createWorkflowSettingRegistry([...registry.entries, first]), /duplicate.*id/);
    const other = { ...first, id: 'additional-setting', cli: { flag: '--additional-setting' as const } };
    assert.throws(() => createWorkflowSettingRegistry([...registry.entries, other]), /duplicate.*key/);
    assert.throws(() => createWorkflowSettingRegistry([...registry.entries,
        { ...other, key: 'additional.setting', cli: first.cli }]), /duplicate.*CLI flag/);
    assert.throws(() => createWorkflowSettingRegistry([...registry.entries,
        { ...other, key: 'credentials.password' }]), /secret|sensitive/);
});

test('pure typed candidates retain protected-owner boundaries without action or grant authority', () => {
    assert.equal(registry.require('garda-self-guard').ui.editable, false);
    assert.throws(() => registry.materialize('garda-self-guard', 'allow_agent_entry', { target: 'live' }), /Invalid value/);
    assert.throws(() => registry.materialize('task-reset-enabled', true, { target: 'other' } as never), /target/);
    assert.throws(() => registry.materialize('local-commit-enabled', true, {} as never), /target/);
    for (const id of ['reset-authority', 'commit-grant', 'task-reset-action', 'backup-create']) {
        assert.throws(() => registry.require(id), /Unknown workflow setting/);
    }
    for (const entry of registry.entries) {
        for (const authority of ['execute', 'grant', 'receipt', 'cleanup', 'reset']) {
            assert.equal(authority in entry, false);
        }
    }
});
