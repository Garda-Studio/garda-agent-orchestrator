import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { buildWorkflowSettingMetadata } from '../../../../src/core/workflow-setting-metadata';
import { SCOPE_BUDGET_THRESHOLD_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/scope-budget-thresholds';

const registry = SCOPE_BUDGET_THRESHOLD_SETTING_REGISTRY;
const cases = [
    { id: 'scope-budget-max-files', field: 'max_files', maximum: 10000, defaultValue: 20 },
    { id: 'scope-budget-max-changed-lines', field: 'max_changed_lines', maximum: 1_000_000, defaultValue: 2000 },
    { id: 'scope-budget-max-required-reviews', field: 'max_required_reviews', maximum: 100, defaultValue: 5 },
    { id: 'scope-budget-max-review-tokens', field: 'max_review_tokens', maximum: 10_000_000, defaultValue: 50000 }
] as const;

test('legacy maximum family retains exactly four ordered definitions, bounds and canonical defaults', () => {
    const defaults = buildDefaultWorkflowConfig().scope_budget_guard;
    assert.deepEqual(registry.entries.map(entry => entry.id), cases.map(item => item.id));
    for (const item of cases) {
        const entry = registry.require(item.id);
        assert.equal(entry.key, `scope_budget_guard.${item.field}`);
        assert.equal(entry.cli.flag, `--${item.id}`);
        assert.equal(entry.value_type, 'integer');
        assert.equal(entry.exposure, 'operator-visible');
        assert.deepEqual(entry.owner, { kind: 'workflow', section: 'scope-budget-guard' });
        assert.equal(entry.ui.min, 1);
        assert.equal(entry.ui.max, item.maximum);
        assert.deepEqual(entry.ui.options, []);
        assert.equal(entry.default_value, item.defaultValue);
        assert.equal(entry.default_value, defaults[item.field]);
    }
    for (const id of ['scope-budget-enabled', 'scope-budget-action', 'scope-budget-profiles',
        'scope-budget-warn-files', 'scope-budget-block-files', 'review-execution-policy']) {
        assert.throws(() => registry.require(id), /Unknown workflow setting/);
    }
});

test('bounded integers produce only frozen maximum candidates without rewriting warning/block policy', () => {
    const defaultsBefore = buildDefaultWorkflowConfig().scope_budget_guard;
    for (const item of cases) {
        for (const value of [1, item.defaultValue, item.maximum]) {
            assert.equal(registry.validate(item.id, value), value);
            for (const target of ['live', 'template'] as const) {
                const changes = registry.materialize(item.id, value, { target });
                assert.deepEqual(changes, [{ path: `scope_budget_guard.${item.field}`, value }]);
                assert.ok(Object.isFrozen(changes));
                assert.ok(Object.isFrozen(changes[0]));
            }
        }
        for (const value of [0, -1, 1.5, item.maximum + 1, Number.NaN, Number.POSITIVE_INFINITY,
            Number.MAX_SAFE_INTEGER + 1, '2', '', null, undefined, true, false, [], {}, new Number(2)]) {
            assert.throws(() => registry.validate(item.id, value), /Invalid value/);
            assert.throws(() => registry.materialize(item.id, value, { target: 'live' }), /Invalid value/);
        }
        assert.throws(() => registry.materialize(item.id, 2, { target: 'other' } as never), /target/);
    }
    assert.deepEqual(buildDefaultWorkflowConfig().scope_budget_guard, defaultsBefore);
});

test('mutable presentation bounds cannot change frozen scalar admission or ownership', () => {
    const presentation = buildWorkflowSettingMetadata(registry)[0];
    presentation.min = 0;
    presentation.max = 1_000_000;
    presentation.options.push({ value: '0', label: 'Untrusted', description: 'Untrusted presentation value.' });
    const entry = registry.require('scope-budget-max-files');
    assert.equal(entry.ui.min, 1);
    assert.equal(entry.ui.max, 10000);
    assert.deepEqual(entry.ui.options, []);
    assert.equal(entry.default_value, 20);
    assert.throws(() => registry.validate(entry.id, 0), /Invalid value/);
    assert.throws(() => registry.validate(entry.id, 10001), /Invalid value/);
    for (const object of [registry.entries, entry, entry.owner, entry.ui, entry.ui.options]) {
        assert.ok(Object.isFrozen(object));
    }
});
