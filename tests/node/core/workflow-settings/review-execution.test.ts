import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { buildWorkflowSettingMetadata } from '../../../../src/core/workflow-setting-metadata';
import { REVIEW_EXECUTION_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/review-execution';

const registry = REVIEW_EXECUTION_SETTING_REGISTRY;
const id = 'review-execution-policy';
const modes = ['parallel_all', 'test_after_code', 'code_first_optional', 'strict_sequential'];

test('review-execution family retains its single workflow setting, four ordered modes and canonical default', () => {
    const entry = registry.require(id);
    assert.equal(registry.entries.length, 1);
    assert.equal(entry.key, 'review_execution_policy.mode');
    assert.equal(entry.value_type, 'enum');
    assert.equal(entry.exposure, 'operator-visible');
    assert.deepEqual(entry.owner, { kind: 'workflow', section: 'review-execution-policy' });
    assert.equal(entry.default_value, 'strict_sequential');
    assert.equal(entry.default_value, buildDefaultWorkflowConfig().review_execution_policy.mode);
    assert.deepEqual(entry.ui.options!.map(option => option.value), modes);
    assert.equal(entry.cli.flag, '--review-execution-policy');
    for (const other of ['required-reviews', 'code-review-enabled', 'review-lane-policy', 'full-suite-command']) {
        assert.throws(() => registry.require(other), /Unknown workflow setting/);
    }
    assert.throws(() => registry.materialize(id, 'strict_sequential', { target: 'other' } as never), /target/);
});

test('mode candidates reuse owner normalization for both targets without exposing legacy or invalid scalars', () => {
    const cases = modes.map(mode => [mode, mode]);
    cases.push([' Parallel All ', 'parallel_all'], ['TEST-AFTER-CODE', 'test_after_code'], ['Code First Optional', 'code_first_optional']);
    for (const [input, canonical] of cases) {
        assert.equal(registry.validate(id, input), input);
        for (const target of ['live', 'template'] as const) {
            const changes = registry.materialize(id, input, { target });
            assert.deepEqual(changes, [{ path: 'review_execution_policy.mode', value: canonical }]);
            assert.ok(Object.isFrozen(changes));
            assert.ok(Object.isFrozen(changes[0]));
        }
    }
    for (const value of ['legacy_test_downstream', 'strict', 'unknown', '', '   ', null, undefined,
        true, false, 0, 1, [], {}, new String('parallel_all')]) {
        assert.throws(() => registry.validate(id, value), /Invalid value/);
        assert.throws(() => registry.materialize(id, value, { target: 'live' }), /Invalid value/);
    }
});

test('presentation mutation cannot expand canonical modes or change frozen ownership and defaults', () => {
    const presentation = buildWorkflowSettingMetadata(registry)[0];
    presentation.options[0].value = 'legacy_test_downstream';
    presentation.options[0].label = 'Untrusted label';
    presentation.options.push({ value: 'unknown', label: 'Unknown', description: 'Untrusted presentation option.' });
    const entry = registry.require(id);
    assert.deepEqual(entry.ui.options!.map(option => option.value), modes);
    assert.equal(entry.ui.options![0].label, 'parallel all');
    assert.equal(entry.default_value, 'strict_sequential');
    assert.throws(() => registry.validate(id, 'legacy_test_downstream'), /Invalid value/);
    assert.throws(() => registry.validate(id, 'unknown'), /Invalid value/);
    for (const object of [registry.entries, entry, entry.owner, entry.ui, entry.ui.options, ...entry.ui.options!]) {
        assert.ok(Object.isFrozen(object));
    }
});
