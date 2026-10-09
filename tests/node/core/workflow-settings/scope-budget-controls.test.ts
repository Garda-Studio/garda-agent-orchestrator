import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { normalizeScopeBudgetGuardConfig } from '../../../../src/core/scope-budget-guard';
import { buildWorkflowSettingMetadata } from '../../../../src/core/workflow-setting-metadata';
import { SCOPE_BUDGET_CONTROL_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/scope-budget-controls';
import { SCOPE_BUDGET_THRESHOLD_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/scope-budget-thresholds';

const registry = SCOPE_BUDGET_CONTROL_SETTING_REGISTRY;
const thresholds = [
    { field: 'warn_files', minimum: 1, maximum: 10000, defaultValue: 20 },
    { field: 'block_files', minimum: 2, maximum: 10000, defaultValue: 50 },
    { field: 'warn_changed_lines', minimum: 1, maximum: 1_000_000, defaultValue: 2000 },
    { field: 'block_changed_lines', minimum: 2, maximum: 1_000_000, defaultValue: 5000 },
    { field: 'warn_required_reviews', minimum: 1, maximum: 100, defaultValue: 5 },
    { field: 'block_required_reviews', minimum: 2, maximum: 100, defaultValue: 8 },
    { field: 'warn_review_tokens', minimum: 1, maximum: 10_000_000, defaultValue: 50000 },
    { field: 'block_review_tokens', minimum: 2, maximum: 10_000_000, defaultValue: 100000 }
] as const;

function materialize(field: string, value: unknown, expected: unknown): void {
    const id = `scope-budget-${field.replace(/_/gu, '-')}`;
    for (const target of ['live', 'template'] as const) {
        const changes = registry.materialize(id, value, { target });
        assert.deepEqual(changes, [{ path: `scope_budget_guard.${field}`, value: expected }]);
        assert.ok(Object.isFrozen(changes));
        assert.ok(Object.isFrozen(changes[0]));
        if (Array.isArray(changes[0].value)) assert.ok(Object.isFrozen(changes[0].value));
    }
}

test('controls own exactly eleven definitions disjoint from the four legacy maxima', () => {
    const fields = ['enabled', 'action', 'profiles', ...thresholds.map(item => item.field)];
    const defaults = buildDefaultWorkflowConfig().scope_budget_guard;
    assert.deepEqual(registry.entries.map(entry => entry.key), fields.map(field => `scope_budget_guard.${field}`));
    const keys = [...registry.entries, ...SCOPE_BUDGET_THRESHOLD_SETTING_REGISTRY.entries].map(entry => entry.key);
    assert.equal(keys.length, 15);
    assert.equal(new Set(keys).size, 15);
    for (const entry of registry.entries) {
        assert.equal(entry.id, `scope-budget-${entry.key.split('.')[1].replace(/_/gu, '-')}`);
        assert.equal(entry.cli.flag, `--${entry.id}`);
        assert.equal(entry.exposure, 'operator-visible');
        assert.deepEqual(entry.owner, { kind: 'workflow', section: 'scope-budget-guard' });
        assert.deepEqual(entry.default_value, defaults[entry.key.split('.')[1] as keyof typeof defaults]);
        assert.ok(Object.isFrozen(entry));
        assert.ok(Object.isFrozen(entry.ui));
        assert.ok(Object.isFrozen(entry.ui.options));
    }
    assert.throws(() => registry.require('scope-budget-max-files'), /Unknown workflow setting/);
    assert.throws(() => registry.require('review-cycle-enabled'), /Unknown workflow setting/);
});

test('integer controls retain all scalar bounds and emit only the requested candidate', () => {
    for (const item of thresholds) {
        const id = `scope-budget-${item.field.replace(/_/gu, '-')}`;
        const entry = registry.require(id);
        assert.equal(entry.value_type, 'integer');
        assert.equal(entry.default_value, item.defaultValue);
        assert.equal(entry.ui.min, item.minimum);
        assert.equal(entry.ui.max, item.maximum);
        for (const value of [item.minimum, item.defaultValue, item.maximum]) {
            assert.equal(registry.validate(id, value), value);
            materialize(item.field, value, value);
        }
        for (const value of [item.minimum - 1, -1, 1.5, item.maximum + 1, NaN, Infinity,
            Number.MAX_SAFE_INTEGER + 1, '2', null, undefined, true, [], {}, new Number(2)]) {
            assert.throws(() => registry.validate(id, value), /Invalid value/);
            assert.throws(() => registry.materialize(id, value, { target: 'live' }), /Invalid value/);
        }
    }
    // Cross-field ordering remains with guarded writers; a scalar candidate does not clamp a companion field.
    materialize('warn_files', 10000, 10000);
    materialize('block_files', 2, 2);
});

test('boolean and compatibility action preserve their separate typed and presentation contracts', () => {
    for (const value of [true, false]) materialize('enabled', value, value);
    for (const value of ['true', 1, null, {}, new Boolean(true)]) {
        assert.throws(() => registry.validate('scope-budget-enabled', value), /Invalid value/);
    }
    const action = registry.require('scope-budget-action');
    assert.equal(action.ui.editable, false);
    assert.deepEqual(action.ui.options!.map(option => option.value), ['BLOCK_FOR_SPLIT', 'WARN_ONLY']);
    for (const value of ['BLOCK_FOR_SPLIT', 'WARN_ONLY']) materialize('action', value, value);
    for (const value of ['unknown', '', 'warn-only', true, [], null]) {
        assert.throws(() => registry.materialize(action.id, value, { target: 'live' }), /Invalid value/);
    }
    // The new typed candidate API does not replace the existing permissive legacy parser.
    assert.equal(normalizeScopeBudgetGuardConfig({ action: 'warn-only' }).action, 'WARN_ONLY');
});

test('profile candidates delegate canonicalization while retaining unknown legacy names and input isolation', () => {
    const entry = registry.require('scope-budget-profiles');
    assert.equal(entry.value_type, 'enum_list');
    assert.equal(entry.ui.placeholder, 'strict,balanced');
    assert.deepEqual(entry.ui.options, []);
    const input = [' Strict ', 'BALANCED', 'Legacy_Custom', 'strict', ''];
    const expected = ['strict', 'balanced', 'legacy_custom'];
    materialize('profiles', input, expected);
    assert.deepEqual(input, [' Strict ', 'BALANCED', 'Legacy_Custom', 'strict', '']);
    const changes = registry.materialize(entry.id, input, { target: 'live' });
    input[0] = 'mutated';
    assert.deepEqual(changes[0].value, expected);
    materialize('profiles', [], ['strict']);
    materialize('profiles', [' ', ''], ['strict']);
    for (const value of ['strict', [1], ['strict', 2], new Array(2), null, {}]) {
        assert.throws(() => registry.materialize(entry.id, value, { target: 'live' }), /Invalid value/);
    }
});

test('presentation mutations cannot change frozen control admission, defaults, or targets', () => {
    const defaults = buildDefaultWorkflowConfig().scope_budget_guard;
    const presentation = buildWorkflowSettingMetadata(registry);
    const action = presentation.find(entry => entry.id === 'scope-budget-action')!;
    action.editable = true;
    action.options[0].value = 'unknown';
    const block = presentation.find(entry => entry.id === 'scope-budget-block-files')!;
    block.min = 0;
    block.max = 100000;
    assert.equal(registry.require(action.id).ui.editable, false);
    assert.equal(registry.require(action.id).ui.options![0].value, 'BLOCK_FOR_SPLIT');
    assert.throws(() => registry.validate(action.id, 'unknown'), /Invalid value/);
    assert.throws(() => registry.validate(block.id, 1), /Invalid value/);
    for (const entry of registry.entries) {
        assert.throws(() => registry.materialize(entry.id, entry.default_value, { target: 'other' } as never), /target/);
    }
    assert.deepEqual(buildDefaultWorkflowConfig().scope_budget_guard, defaults);
    assert.ok(Object.isFrozen(registry.require('scope-budget-profiles').default_value));
});
