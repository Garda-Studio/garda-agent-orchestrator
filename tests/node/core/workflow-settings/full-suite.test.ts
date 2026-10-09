import assert from 'node:assert/strict';
import test from 'node:test';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../../../src/core/constants';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { buildWorkflowSettingMetadata } from '../../../../src/core/workflow-setting-metadata';
import { FULL_SUITE_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/full-suite';

const registry = FULL_SUITE_SETTING_REGISTRY;

test('full-suite family keeps the existing stable settings and canonical defaults', () => {
    const defaults = {
        enabled: false,
        command: UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
        timeout_ms: 900_000,
        timeout_blocker: true,
        timeout_retry_count: 1,
        green_summary_max_lines: 5,
        red_failure_chunk_lines: 50,
        out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
        placement: 'after_compile_before_reviews'
    };
    assert.deepEqual(buildDefaultWorkflowConfig().full_suite_validation, defaults);
    assert.deepEqual(registry.entries.map(entry => entry.id), [
        'full-suite-enabled', 'full-suite-command', 'full-suite-timeout-ms', 'full-suite-timeout-blocker',
        'full-suite-timeout-retry-count', 'full-suite-green-summary-max-lines',
        'full-suite-red-failure-chunk-lines', 'full-suite-out-of-scope-failure-policy', 'full-suite-placement'
    ]);
    for (const entry of registry.entries) {
        const field = entry.key.slice('full_suite_validation.'.length) as keyof typeof defaults;
        assert.equal(entry.default_value, defaults[field]);
        assert.deepEqual(entry.owner, { kind: 'workflow', section: 'full-suite-validation' });
        assert.equal(entry.exposure, 'operator-visible');
        assert.equal(registry.validate(entry.id, defaults[field]), defaults[field]);
        for (const target of ['live', 'template'] as const) {
            assert.deepEqual(registry.materialize(entry.id, defaults[field], { target }), [
                { path: entry.key, value: defaults[field] }
            ]);
        }
    }
});

test('full-suite typed values retain owner scalar admission without turning UI hints into policy', () => {
    const cases: Array<[string, unknown, boolean]> = [
        ['full-suite-enabled', true, true], ['full-suite-enabled', false, true],
        ['full-suite-enabled', 'true', false], ['full-suite-enabled', 1, false],
        ['full-suite-timeout-blocker', false, true], ['full-suite-timeout-blocker', null, false],
        ['full-suite-command', 'npm test', true], ['full-suite-command', ' npm test ', true],
        ['full-suite-command', '', false], ['full-suite-command', '  ', false],
        ['full-suite-command', ['npm', 'test'], false],
        ['full-suite-timeout-ms', 1000, true], ['full-suite-timeout-ms', 999, false],
        ['full-suite-timeout-ms', 86_400_001, true],
        ['full-suite-timeout-ms', Number.MAX_SAFE_INTEGER, true],
        ['full-suite-timeout-ms', Number.MAX_SAFE_INTEGER + 1, false],
        ['full-suite-timeout-ms', NaN, false], ['full-suite-timeout-ms', Infinity, false],
        ['full-suite-timeout-ms', 1000.5, false], ['full-suite-timeout-ms', '1000', false],
        ['full-suite-timeout-retry-count', 0, true], ['full-suite-timeout-retry-count', 3, true],
        ['full-suite-timeout-retry-count', -1, false], ['full-suite-timeout-retry-count', 4, false],
        ['full-suite-green-summary-max-lines', 1, true], ['full-suite-green-summary-max-lines', 201, true],
        ['full-suite-green-summary-max-lines', 0, false],
        ['full-suite-red-failure-chunk-lines', 10, true], ['full-suite-red-failure-chunk-lines', 1001, true],
        ['full-suite-red-failure-chunk-lines', 9, false],
        ['full-suite-out-of-scope-failure-policy', 'AUDIT_AND_BLOCK', true],
        ['full-suite-out-of-scope-failure-policy', 'audit_and_warn', true],
        ['full-suite-out-of-scope-failure-policy', 'ignore', false],
        ['full-suite-placement', 'before_completion', true],
        ['full-suite-placement', 'BEFORE TEST REVIEW', true],
        ['full-suite-placement', 'skip_validation', false]
    ];
    for (const [id, value, admitted] of cases) {
        if (admitted) assert.equal(registry.validate(id, value), value, `${id}: ${String(value)}`);
        else assert.throws(() => registry.validate(id, value), /Invalid value/, `${id}: ${String(value)}`);
    }
});

test('full-suite materialization delegates normalization and returns frozen candidate descriptors', () => {
    const cases = [
        ['full-suite-command', ' npm test ', 'npm test'],
        ['full-suite-out-of-scope-failure-policy', 'audit_and_warn', 'AUDIT_AND_WARN'],
        ['full-suite-placement', 'BEFORE TEST REVIEW', 'before_test_review']
    ];
    for (const [id, value, canonical] of cases) {
        const result = registry.materialize(id, value, { target: 'live' });
        assert.deepEqual(result, [{ path: registry.require(id).key, value: canonical }]);
        assert.ok(Object.isFrozen(result));
        assert.ok(Object.isFrozen(result[0]));
    }
    assert.throws(() => registry.materialize('full-suite-timeout-ms', 999, { target: 'live' }), /Invalid value/);
    assert.throws(() => registry.materialize('full-suite-enabled', true, { target: 'other' } as never), /target/);
    assert.throws(() => registry.require('local-commit-enabled'), /Unknown workflow setting/);
});

test('full-suite presentation copies cannot change registry options or guarded setting ownership', () => {
    const projection = buildWorkflowSettingMetadata(registry);
    const placement = projection.find(entry => entry.id === 'full-suite-placement')!;
    const original = registry.require(placement.id);
    const firstLabel = original.ui.options![0].label;
    placement.options[0].label = 'Changed display copy';
    placement.options.push({ value: 'skip_validation', label: 'Skip', description: 'Untrusted display option.' });
    assert.equal(original.ui.options![0].label, firstLabel);
    assert.equal(original.ui.options!.length, 3);
    assert.throws(() => registry.validate(placement.id, 'skip_validation'), /Invalid value/);
    assert.ok(Object.isFrozen(original));
    assert.ok(Object.isFrozen(original.owner));
    assert.ok(Object.isFrozen(original.ui.options));
    assert.equal(buildWorkflowSettingMetadata(registry).find(entry => entry.id === placement.id)!.options[0].label, firstLabel);
});
