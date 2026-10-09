import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { buildWorkflowSettingMetadata } from '../../../../src/core/workflow-setting-metadata';
import { OPTIONAL_QUALITY_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/optional-quality';

const registry = OPTIONAL_QUALITY_SETTING_REGISTRY;
const cadenceId = 'optional-checks-review-failure-cadence-interval';

test('optional quality registers only the two existing scalar settings with canonical defaults', () => {
    const defaults = buildDefaultWorkflowConfig().optional_quality_checks;
    assert.equal(defaults.enabled, true);
    assert.equal(defaults.review_failure_cadence_interval, 3);
    assert.deepEqual(registry.entries.map(entry => [entry.id, entry.key, entry.default_value]), [
        ['optional-checks-enabled', 'optional_quality_checks.enabled', true],
        [cadenceId, 'optional_quality_checks.review_failure_cadence_interval', 3]
    ]);
    for (const entry of registry.entries) {
        assert.deepEqual(entry.owner, { kind: 'workflow', section: 'optional-quality-checks' });
        assert.equal(entry.exposure, 'operator-visible');
        for (const target of ['live', 'template'] as const) {
            const changes = registry.materialize(entry.id, entry.default_value, { target });
            assert.deepEqual(changes, [{ path: entry.key, value: entry.default_value }]);
            assert.ok(Object.isFrozen(changes));
            assert.ok(Object.isFrozen(changes[0]));
        }
    }
    for (const id of ['optional-skill-selection-mode', 'full-suite-enabled', 'task-reset-enabled', 'optional-checks-rules']) {
        assert.throws(() => registry.require(id), /Unknown workflow setting/);
    }
    assert.throws(() => registry.materialize(cadenceId, 3, { target: 'other' } as never), /target/);
});

test('optional-quality admission rejects coercions and preserves the owner cadence boundaries', () => {
    for (const value of [true, false]) {
        assert.equal(registry.validate('optional-checks-enabled', value), value);
        assert.deepEqual(registry.materialize('optional-checks-enabled', value, { target: 'live' }), [
            { path: 'optional_quality_checks.enabled', value }
        ]);
    }
    for (const value of ['true', 'false', 0, 1, null, undefined, [], {}]) {
        assert.throws(() => registry.validate('optional-checks-enabled', value), /Invalid value/);
        assert.throws(() => registry.materialize('optional-checks-enabled', value, { target: 'live' }), /Invalid value/);
    }
    for (const value of [1, 3, 100]) {
        assert.equal(registry.validate(cadenceId, value), value);
        assert.deepEqual(registry.materialize(cadenceId, value, { target: 'template' }), [
            { path: 'optional_quality_checks.review_failure_cadence_interval', value }
        ]);
    }
    for (const value of [0, -1, 101, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null, true, [], {}]) {
        assert.throws(() => registry.validate(cadenceId, value), /Invalid value/);
        assert.throws(() => registry.materialize(cadenceId, value, { target: 'live' }), /Invalid value/);
    }
});

test('mutable presentation copies cannot change admission, defaults or frozen registry ownership', () => {
    const presentation = buildWorkflowSettingMetadata(registry);
    const enabled = presentation.find(entry => entry.id === 'optional-checks-enabled')!;
    const cadence = presentation.find(entry => entry.id === cadenceId)!;
    enabled.options[0].value = 'yes';
    enabled.options.push({ value: 'bypass', label: 'Bypass', description: 'Untrusted presentation option.' });
    cadence.min = 0;
    cadence.max = 1000;
    assert.equal(registry.require(enabled.id).ui.options![0].value, 'true');
    assert.equal(registry.require(enabled.id).ui.options!.length, 2);
    assert.equal(registry.require(cadence.id).ui.min, 1);
    assert.equal(registry.require(cadence.id).ui.max, 100);
    assert.throws(() => registry.validate(enabled.id, 'yes'), /Invalid value/);
    assert.throws(() => registry.validate(cadence.id, 101), /Invalid value/);
    for (const entry of registry.entries) {
        assert.ok(Object.isFrozen(entry));
        assert.ok(Object.isFrozen(entry.owner));
        assert.ok(Object.isFrozen(entry.ui));
        assert.ok(Object.isFrozen(entry.ui.options));
    }
    assert.deepEqual(registry.entries.map(entry => entry.default_value), [true, 3]);
});
