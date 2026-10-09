import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { normalizeReviewCycleGuardConfig } from '../../../../src/core/review-cycle-guard';
import { buildWorkflowSettingMetadata } from '../../../../src/core/workflow-setting-metadata';
import { REVIEW_CYCLE_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/review-cycle';

const registry = REVIEW_CYCLE_SETTING_REGISTRY;
const fields = ['enabled', 'action', 'max_failed_non_test_reviews', 'max_total_non_test_reviews',
    'excluded_review_types', 'auto_split_enabled'] as const;

function materialize(field: string, value: unknown, expected: unknown): void {
    for (const target of ['live', 'template'] as const) {
        const changes = registry.materialize(`review-cycle-${field.replace(/_/gu, '-')}`, value, { target });
        assert.deepEqual(changes, [{ path: `review_cycle_guard.${field}`, value: expected }]);
        assert.ok(Object.isFrozen(changes));
        assert.ok(Object.isFrozen(changes[0]));
        if (Array.isArray(changes[0].value)) assert.ok(Object.isFrozen(changes[0].value));
    }
}

test('review-cycle family owns exactly the six existing settings with current defaults', () => {
    const defaults = buildDefaultWorkflowConfig().review_cycle_guard;
    assert.deepEqual(defaults, { enabled: true, action: 'BLOCK_FOR_OPERATOR_DECISION',
        max_failed_non_test_reviews: 10, max_total_non_test_reviews: 30,
        excluded_review_types: ['test'], auto_split_enabled: true });
    assert.deepEqual(registry.entries.map(entry => entry.key), fields.map(field => `review_cycle_guard.${field}`));
    for (const [index, entry] of registry.entries.entries()) {
        assert.equal(entry.id, `review-cycle-${fields[index].replace(/_/gu, '-')}`);
        assert.equal(entry.cli.flag, `--${entry.id}`);
        assert.deepEqual(entry.owner, { kind: 'workflow', section: 'review-cycle-guard' });
        assert.equal(entry.exposure, 'operator-visible');
        assert.deepEqual(entry.default_value, defaults[fields[index]]);
        materialize(fields[index], entry.default_value, entry.default_value);
        assert.ok(Object.isFrozen(entry));
        assert.ok(Object.isFrozen(entry.ui.options));
    }
    assert.throws(() => registry.require('scope-budget-enabled'), /Unknown workflow setting/);
});

test('booleans and canonical actions produce only selected candidates', () => {
    for (const field of ['enabled', 'auto_split_enabled']) {
        for (const value of [true, false]) materialize(field, value, value);
        for (const value of ['true', 1, null, {}, new Boolean(true)]) {
            assert.throws(() => registry.validate(`review-cycle-${field.replace(/_/gu, '-')}`, value), /Invalid value/);
        }
    }
    for (const value of ['BLOCK_FOR_OPERATOR_DECISION', 'WARN_ONLY']) materialize('action', value, value);
    for (const value of ['', 'warn-only', 'unknown', true, [], null]) {
        assert.throws(() => registry.materialize('review-cycle-action', value, { target: 'live' }), /Invalid value/);
    }
    // Existing config aliases remain the responsibility of the unchanged owner.
    assert.equal(normalizeReviewCycleGuardConfig({ action: 'warn-only' }).action, 'WARN_ONLY');
});

test('integer limits retain bounds without changing the companion limit', () => {
    for (const field of ['max_failed_non_test_reviews', 'max_total_non_test_reviews']) {
        const id = `review-cycle-${field.replace(/_/gu, '-')}`;
        const entry = registry.require(id);
        assert.equal(entry.ui.min, 1);
        assert.equal(entry.ui.max, 1000);
        for (const value of [1, entry.default_value, 1000]) materialize(field, value, value);
        for (const value of [0, -1, 1.5, 1001, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
            '10', null, undefined, true, [], {}, new Number(10)]) {
            assert.throws(() => registry.validate(id, value), /Invalid value/);
            assert.throws(() => registry.materialize(id, value, { target: 'template' }), /Invalid value/);
        }
    }
    materialize('max_failed_non_test_reviews', 1000, 1000);
    materialize('max_total_non_test_reviews', 1, 1);
});

test('excluded-type candidates retain owner normalization, fallback and unknown legacy names', () => {
    const input = [' Test ', 'CODE', 'legacy_custom', 'test', ''];
    const expected = ['test', 'code', 'legacy_custom'];
    materialize('excluded_review_types', input, expected);
    assert.deepEqual(input, [' Test ', 'CODE', 'legacy_custom', 'test', '']);
    const changes = registry.materialize('review-cycle-excluded-review-types', input, { target: 'live' });
    input[0] = 'mutated';
    assert.deepEqual(changes[0].value, expected);
    materialize('excluded_review_types', [], ['test']);
    materialize('excluded_review_types', [' ', ''], ['test']);
    for (const value of ['test', [1], ['test', 2], new Array(2), null, {}]) {
        assert.throws(() => registry.materialize('review-cycle-excluded-review-types', value, { target: 'live' }), /Invalid value/);
    }
    assert.ok(Object.isFrozen(registry.require('review-cycle-excluded-review-types').default_value));
});

test('presentation mutation and invalid targets cannot change admission or owner defaults', () => {
    const defaults = buildDefaultWorkflowConfig().review_cycle_guard;
    const presentation = buildWorkflowSettingMetadata(registry);
    presentation.find(entry => entry.id === 'review-cycle-action')!.options[0].value = 'unknown';
    presentation.find(entry => entry.id === 'review-cycle-max-total-non-test-reviews')!.max = 2000;
    assert.equal(registry.require('review-cycle-action').ui.options![0].value, 'BLOCK_FOR_OPERATOR_DECISION');
    assert.throws(() => registry.validate('review-cycle-action', 'unknown'), /Invalid value/);
    assert.throws(() => registry.validate('review-cycle-max-total-non-test-reviews', 1001), /Invalid value/);
    for (const entry of registry.entries) {
        assert.throws(() => registry.materialize(entry.id, entry.default_value, { target: 'other' } as never), /target/);
    }
    assert.deepEqual(buildDefaultWorkflowConfig().review_cycle_guard, defaults);
});
