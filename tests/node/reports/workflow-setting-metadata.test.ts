import { WORKFLOW_SETTING_REGISTRY } from '../../../src/core/workflow-settings/registry';
import { COMPACT_SETTING_REGISTRY, compactSettingMinimum, compactSettingMaximum } from '../../../src/core/compact/setting-definitions';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { FULL_SUITE_SETTING_REGISTRY } from '../../../src/core/workflow-settings/full-suite';
import { OPTIONAL_QUALITY_SETTING_REGISTRY } from '../../../src/core/workflow-settings/optional-quality';
import { COMPILE_SETTING_REGISTRY } from '../../../src/core/workflow-settings/compile';
import { REVIEW_EXECUTION_SETTING_REGISTRY } from '../../../src/core/workflow-settings/review-execution';
import { SCOPE_BUDGET_THRESHOLD_SETTING_REGISTRY } from '../../../src/core/workflow-settings/scope-budget-thresholds';
import { SCOPE_BUDGET_CONTROL_SETTING_REGISTRY } from '../../../src/core/workflow-settings/scope-budget-controls';
import { REVIEW_CYCLE_SETTING_REGISTRY } from '../../../src/core/workflow-settings/review-cycle';
import { PROJECT_MEMORY_SETTING_REGISTRY } from '../../../src/core/workflow-settings/project-memory';
import { PROTECTED_CONTROL_SETTING_REGISTRY } from '../../../src/core/workflow-settings/protected-controls';
import { BACKUP_SETTING_REGISTRY } from '../../../src/core/workflow-settings/backup';
import { EXCLUDED_REVIEW_TYPES_SETTING_DESCRIPTION } from '../../../src/reports/review-type-setting-text';
import { getWorkflowSettingDefinition, WORKFLOW_SETTING_DEFINITIONS } from '../../../src/reports/workflow-setting-metadata';

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
    }
    return value;
}

test('backup adapter retains consecutive positions, exact flags and detached presentation without actions', () => {
    const ids = WORKFLOW_SETTING_DEFINITIONS.map(entry => entry.id);
    const first = ids.indexOf('local-commit-enabled') + 1;
    assert.deepEqual(ids.slice(first, first + 3),
        ['auto-backup-enabled', 'auto-backup-interval-days', 'auto-backup-keep-latest']);
    assert.equal(ids[first + 3], 'garda-self-guard');
    for (const entry of BACKUP_SETTING_REGISTRY.entries) {
        const report = getWorkflowSettingDefinition(entry.key)!;
        assert.equal(report.id, entry.id);
        assert.equal(report.flag, entry.cli.flag);
        assert.equal(report.value_type, entry.value_type);
        assert.deepEqual(report.options, entry.ui.options);
        assert.notEqual(report.options, entry.ui.options);
        assert.equal(report.min, entry.ui.min);
        assert.equal(report.max, entry.ui.max);
        for (const authority of ['owner', 'validate', 'materialize', 'default_value', 'execute', 'cleanup']) {
            assert.equal(authority in report, false);
        }
    }
    const enabled = getWorkflowSettingDefinition('auto_backup.enabled')!;
    const oldValue = enabled.options[0].value;
    try {
        enabled.options[0].value = 'purge';
        assert.equal(BACKUP_SETTING_REGISTRY.require(enabled.id).ui.options![0].value, 'true');
    } finally { enabled.options[0].value = oldValue; }
});

test('protected adapter retains catalog positions and self-guard read-only presentation without grants', () => {
    const ids = WORKFLOW_SETTING_DEFINITIONS.map(entry => entry.id);
    const first = ids.indexOf('project-memory-impact-retention-days') + 1;
    assert.deepEqual(ids.slice(first, first + 2), ['task-reset-enabled', 'local-commit-enabled']);
    assert.equal(ids[first + 2], 'auto-backup-enabled');
    assert.equal(ids[ids.length - 1], 'garda-self-guard');
    for (const entry of PROTECTED_CONTROL_SETTING_REGISTRY.entries) {
        const report = getWorkflowSettingDefinition(entry.key)!;
        assert.equal(report.id, entry.id);
        assert.equal(report.flag, entry.cli.flag);
        assert.equal(report.value_type, entry.value_type);
        assert.deepEqual(report.options, entry.ui.options);
        assert.notEqual(report.options, entry.ui.options);
        assert.equal(report.editable, entry.ui.editable);
        for (const authority of ['owner', 'validate', 'materialize', 'default_value']) {
            assert.equal(authority in report, false);
        }
    }
    const guard = getWorkflowSettingDefinition('orchestrator_work_policy.mode')!;
    assert.equal(guard.editable, false);
    assert.deepEqual(guard.options.map(option => option.value), ['deny_agent_entry', 'require_operator_confirmation']);
    const original = guard.options[0].label;
    try {
        guard.options[0].label = 'mutated presentation';
        assert.equal(PROTECTED_CONTROL_SETTING_REGISTRY.require(guard.id).ui.options![0].label, original);
    } finally { guard.options[0].label = original; }
});

test('project-memory adapter preserves seven ordered settings without write or consent authority', () => {
    const ids = ['project-memory-enabled', 'project-memory-mode', 'project-memory-run-before-final-closeout',
        'project-memory-require-user-approval-for-writes', 'project-memory-max-compact-summary-chars',
        'project-memory-read-strategy', 'project-memory-impact-retention-days'];
    const catalogIds = WORKFLOW_SETTING_DEFINITIONS.map(entry => entry.id);
    const first = catalogIds.indexOf('review-cycle-auto-split-enabled') + 1;
    assert.deepEqual(catalogIds.slice(first, first + 7), ids);
    assert.equal(catalogIds[first + 7], 'task-reset-enabled');
    assert.deepEqual(PROJECT_MEMORY_SETTING_REGISTRY.entries.map(entry => entry.id), ids);
    for (const entry of PROJECT_MEMORY_SETTING_REGISTRY.entries) {
        const report = getWorkflowSettingDefinition(entry.key)!;
        assert.equal(report.id, entry.id);
        assert.equal(report.flag, entry.cli.flag);
        assert.equal(report.value_type, entry.value_type);
        assert.deepEqual(report.options, entry.ui.options);
        assert.notEqual(report.options, entry.ui.options);
        assert.equal(report.min, entry.ui.min);
        assert.equal(report.max, entry.ui.max);
        for (const authority of ['owner', 'validate', 'materialize', 'default_value']) {
            assert.equal(authority in report, false);
        }
    }
    assert.deepEqual(getWorkflowSettingDefinition('project_memory_maintenance.mode')!.options.map(option => option.value),
        ['off', 'check', 'update', 'strict']);
    assert.deepEqual(getWorkflowSettingDefinition('project_memory_maintenance.read_strategy')!.options.map(option => option.value),
        ['index_first']);
    const approval = getWorkflowSettingDefinition('project_memory_maintenance.require_user_approval_for_writes')!;
    const original = approval.options[0].label;
    try {
        approval.options[0].label = 'mutated presentation';
        assert.equal(PROJECT_MEMORY_SETTING_REGISTRY.require(approval.id).ui.options![0].label, original);
    } finally {
        approval.options[0].label = original;
    }
});

test('review-cycle adapter preserves six ordered definitions and its existing description export', () => {
    const ids = ['review-cycle-enabled', 'review-cycle-action', 'review-cycle-max-failed-non-test-reviews',
        'review-cycle-max-total-non-test-reviews', 'review-cycle-excluded-review-types', 'review-cycle-auto-split-enabled'];
    const catalogIds = WORKFLOW_SETTING_DEFINITIONS.map(entry => entry.id);
    const first = catalogIds.indexOf('scope-budget-block-review-tokens') + 1;
    assert.deepEqual(catalogIds.slice(first, first + 6), ids);
    assert.equal(catalogIds[first + 6], 'project-memory-enabled');
    assert.deepEqual(REVIEW_CYCLE_SETTING_REGISTRY.entries.map(entry => entry.id), ids);
    for (const entry of REVIEW_CYCLE_SETTING_REGISTRY.entries) {
        const report = getWorkflowSettingDefinition(entry.key)!;
        assert.equal(report.id, entry.id);
        assert.equal(report.flag, entry.cli.flag);
        assert.equal(report.value_type, entry.value_type);
        assert.deepEqual(report.options, entry.ui.options);
        assert.notEqual(report.options, entry.ui.options);
        for (const authority of ['owner', 'validate', 'materialize', 'default_value']) {
            assert.equal(authority in report, false);
        }
    }
    assert.equal(EXCLUDED_REVIEW_TYPES_SETTING_DESCRIPTION,
        'Multiple choice: checked review types are excluded from review-cycle guard counting.');
    const excluded = getWorkflowSettingDefinition('review_cycle_guard.excluded_review_types')!;
    assert.equal(excluded.description, EXCLUDED_REVIEW_TYPES_SETTING_DESCRIPTION);
    assert.equal(excluded.placeholder, 'test');
    assert.deepEqual(excluded.options, []);
    const action = getWorkflowSettingDefinition('review_cycle_guard.action')!;
    assert.deepEqual(action.options.map(option => option.value), ['BLOCK_FOR_OPERATOR_DECISION', 'WARN_ONLY']);
    const original = action.options[0].label;
    try {
        action.options[0].label = 'mutated presentation';
        assert.equal(REVIEW_CYCLE_SETTING_REGISTRY.require(action.id).ui.options![0].label, original);
    } finally {
        action.options[0].label = original;
    }
});

test('typed full-suite projection preserves the entire existing report contract and interleaved order', () => {
    // Independent pre-migration contract: all 61 definitions at accepted source HEAD 9a7d0374.
    const existingDefinitions = WORKFLOW_SETTING_DEFINITIONS.filter(
        entry => entry.id !== 'task-test-selection-require-operator-confirmation'
    );
    const digest = createHash('sha256').update(JSON.stringify(canonical(existingDefinitions))).digest('hex');
    assert.equal(existingDefinitions.length, 61);
    assert.equal(WORKFLOW_SETTING_DEFINITIONS.length, 62);
    assert.equal(digest, '5b5a817e07d37c55b65bcbd419cab2852ac33e604dbeeb39394bcef6681db370');
    const ids = WORKFLOW_SETTING_DEFINITIONS.map(entry => entry.id);
    assert.ok(ids.indexOf('full-suite-enabled') < ids.indexOf('optional-checks-enabled'));
    assert.equal(ids.indexOf('optional-checks-review-failure-cadence-interval'), ids.indexOf('optional-checks-enabled') + 1);
    assert.equal(ids.indexOf('optional-skill-selection-mode'), ids.indexOf('optional-checks-enabled') + 2);
    assert.ok(ids.indexOf('compile-gate-command') < ids.indexOf('full-suite-command'));
    assert.ok(ids.indexOf('full-suite-placement') < ids.indexOf('review-execution-policy'));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(WORKFLOW_SETTING_DEFINITIONS.map(entry => entry.key)).size, ids.length);
    assert.equal(new Set(WORKFLOW_SETTING_DEFINITIONS.map(entry => entry.flag)).size, ids.length);
});

test('optional-quality report fields remain presentation-only and keep their canonical owner separate', () => {
    for (const entry of OPTIONAL_QUALITY_SETTING_REGISTRY.entries) {
        const report = getWorkflowSettingDefinition(entry.key)!;
        assert.equal(report.id, entry.id);
        assert.equal(report.flag, entry.cli.flag);
        assert.equal(report.value_type, entry.value_type);
        assert.equal('owner' in report, false);
        assert.equal('validate' in report, false);
        assert.equal('materialize' in report, false);
        assert.equal('default_value' in report, false);
        assert.notEqual(report.options, entry.ui.options);
    }
    const cadence = getWorkflowSettingDefinition('optional_quality_checks.review_failure_cadence_interval')!;
    assert.equal(cadence.min, 1);
    assert.equal(cadence.max, 100);
    assert.equal(getWorkflowSettingDefinition('optional_quality_checks.rules'), null);
    assert.equal(getWorkflowSettingDefinition('optional_skill_selection_policy.mode')!.id, 'optional-skill-selection-mode');
});

test('compile report projection retains its interleaved position without scalar or execution authority', () => {
    const entry = COMPILE_SETTING_REGISTRY.require('compile-gate-command');
    const report = getWorkflowSettingDefinition('compile_gate.command')!;
    assert.equal(report.id, entry.id);
    assert.equal(report.flag, '--compile-gate-command');
    assert.equal(report.value_type, 'string');
    assert.equal(report.placeholder, 'compile/build/type-check command');
    assert.deepEqual(report.options, []);
    assert.notEqual(report.options, entry.ui.options);
    for (const authority of ['owner', 'validate', 'materialize', 'default_value']) {
        assert.equal(authority in report, false);
    }
    const ids = WORKFLOW_SETTING_DEFINITIONS.map(definition => definition.id);
    assert.equal(ids.indexOf(report.id), ids.indexOf('optional-skill-selection-mode') + 1);
    assert.equal(ids.indexOf('full-suite-command'), ids.indexOf(report.id) + 1);
});

test('scope-budget maxima retain bounds and contiguous report positions without policy authority', () => {
    const ids = ['scope-budget-max-files', 'scope-budget-max-changed-lines',
        'scope-budget-max-required-reviews', 'scope-budget-max-review-tokens'];
    const maxima = [10000, 1_000_000, 100, 10_000_000];
    const catalogIds = WORKFLOW_SETTING_DEFINITIONS.map(definition => definition.id);
    const first = catalogIds.indexOf('scope-budget-profiles') + 1;
    assert.deepEqual(catalogIds.slice(first, first + 4), ids);
    assert.equal(catalogIds[first + 4], 'scope-budget-warn-files');
    for (const [index, id] of ids.entries()) {
        const entry = SCOPE_BUDGET_THRESHOLD_SETTING_REGISTRY.require(id);
        const report = getWorkflowSettingDefinition(entry.key)!;
        assert.equal(report.id, id);
        assert.equal(report.flag, `--${id}`);
        assert.equal(report.value_type, 'integer');
        assert.equal(report.min, 1);
        assert.equal(report.max, maxima[index]);
        assert.deepEqual(report.options, []);
        assert.notEqual(report.options, entry.ui.options);
        for (const authority of ['owner', 'validate', 'materialize', 'default_value']) {
            assert.equal(authority in report, false);
        }
    }
});

test('review-execution report retains choices and position without lane or frozen-policy authority', () => {
    const entry = REVIEW_EXECUTION_SETTING_REGISTRY.require('review-execution-policy');
    const report = getWorkflowSettingDefinition('review_execution_policy.mode')!;
    assert.equal(report.id, entry.id);
    assert.equal(report.flag, '--review-execution-policy');
    assert.equal(report.value_type, 'enum');
    assert.deepEqual(report.options.map(option => option.value), [
        'parallel_all', 'test_after_code', 'code_first_optional', 'strict_sequential'
    ]);
    assert.notEqual(report.options, entry.ui.options);
    for (const authority of ['owner', 'validate', 'materialize', 'default_value']) {
        assert.equal(authority in report, false);
    }
    const ids = WORKFLOW_SETTING_DEFINITIONS.map(definition => definition.id);
    assert.equal(ids.indexOf(report.id), ids.indexOf('full-suite-placement') + 1);
    assert.equal(ids.indexOf('scope-budget-enabled'), ids.indexOf(report.id) + 1);
});

test('report lookup keeps full-suite shapes while scalar and materialization authority stay in the registry', () => {
    for (const entry of FULL_SUITE_SETTING_REGISTRY.entries) {
        const report = getWorkflowSettingDefinition(entry.key)!;
        assert.equal(report.id, entry.id);
        assert.equal(report.flag, entry.cli.flag);
        assert.equal(report.value_type, entry.value_type);
        assert.equal('owner' in report, false);
        assert.equal('validate' in report, false);
        assert.equal('materialize' in report, false);
        assert.notEqual(report.options, entry.ui.options);
    }
    assert.equal(getWorkflowSettingDefinition('full_suite_validation.unknown'), null);
    assert.throws(() => FULL_SUITE_SETTING_REGISTRY.require('optional-checks-enabled'), /Unknown workflow setting/);
});

test('all fifteen scope-budget projections retain ordered presentation-only ownership', () => {
    const controls = SCOPE_BUDGET_CONTROL_SETTING_REGISTRY.entries;
    const maxima = SCOPE_BUDGET_THRESHOLD_SETTING_REGISTRY.entries;
    const expected = [...controls.slice(0, 3), ...maxima, ...controls.slice(3)];
    const catalogIds = WORKFLOW_SETTING_DEFINITIONS.map(entry => entry.id);
    const start = catalogIds.indexOf('scope-budget-enabled');
    assert.deepEqual(catalogIds.slice(start, start + 15), expected.map(entry => entry.id));
    assert.equal(catalogIds[start + 15], 'review-cycle-enabled');
    for (const entry of controls) {
        const report = getWorkflowSettingDefinition(entry.key)!;
        assert.equal(report.id, entry.id);
        assert.equal(report.flag, entry.cli.flag);
        assert.equal(report.value_type, entry.value_type);
        assert.equal(report.min, entry.ui.min);
        assert.equal(report.max, entry.ui.max);
        assert.notEqual(report.options, entry.ui.options);
        for (const authority of ['owner', 'validate', 'materialize', 'default_value']) {
            assert.equal(authority in report, false);
        }
    }
    assert.equal(getWorkflowSettingDefinition('scope_budget_guard.action')!.editable, false);
    assert.equal(getWorkflowSettingDefinition('scope_budget_guard.profiles')!.placeholder, 'strict,balanced');
    const action = getWorkflowSettingDefinition('scope_budget_guard.action')!;
    const originalLabel = action.options[0].label;
    try {
        action.options[0].label = 'Mutated presentation';
        assert.equal(SCOPE_BUDGET_CONTROL_SETTING_REGISTRY.require(action.id).ui.options![0].label, originalLabel);
    } finally {
        action.options[0].label = originalLabel;
    }
});


test('complete assembly keeps the external policy position and compact presentation without write authority', () => {
    const typedIds = WORKFLOW_SETTING_REGISTRY.entries.map(entry => entry.id);
    assert.deepEqual(WORKFLOW_SETTING_DEFINITIONS.filter(entry => !['optional-skill-selection-mode', 'task-test-selection-require-operator-confirmation'].includes(entry.id))
        .map(entry => entry.id), typedIds);
    const policy = getWorkflowSettingDefinition('optional_skill_selection_policy.mode')!;
    const policyIndex = WORKFLOW_SETTING_DEFINITIONS.indexOf(policy);
    assert.equal(WORKFLOW_SETTING_DEFINITIONS[policyIndex - 1].id, 'optional-checks-review-failure-cadence-interval');
    assert.equal(WORKFLOW_SETTING_DEFINITIONS[policyIndex + 1].id, 'compile-gate-command');
    assert.deepEqual(policy.options.map(option => option.value), ['off', 'optional', 'mandatory', 'advisory', 'required', 'strict']);
    assert.equal(WORKFLOW_SETTING_REGISTRY.get(policy.id), null);
    assert.equal(getWorkflowSettingDefinition('unknown.setting'), null);
    for (const entry of COMPACT_SETTING_REGISTRY.entries) {
        const report = getWorkflowSettingDefinition(entry.key)!;
        assert.equal(report.value_type, entry.value_type);
        if (entry.value_type === 'boolean') {
            assert.deepEqual(report.options.map(option => option.value), ['true', 'false']);
        } else {
            assert.deepEqual(report.options, []);
            assert.equal(report.min, compactSettingMinimum(entry.id));
            assert.equal(report.max, compactSettingMaximum(entry.id));
        }
        assert.deepEqual(WORKFLOW_SETTING_REGISTRY.require(entry.id).ui, entry.ui);
    }
    for (const report of WORKFLOW_SETTING_DEFINITIONS) {
        for (const authority of ['owner', 'default_value', 'validate', 'materialize', 'execute', 'grant']) {
            assert.equal(authority in report, false);
        }
    }
});
