import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { FULL_SUITE_SETTING_REGISTRY } from '../../../src/core/workflow-settings/full-suite';
import { getWorkflowSettingDefinition, WORKFLOW_SETTING_DEFINITIONS } from '../../../src/reports/workflow-setting-metadata';

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
    }
    return value;
}

test('typed full-suite projection preserves the entire existing report contract and interleaved order', () => {
    // Independent pre-migration contract: all 61 definitions at accepted source HEAD 9a7d0374.
    const digest = createHash('sha256').update(JSON.stringify(canonical(WORKFLOW_SETTING_DEFINITIONS))).digest('hex');
    assert.equal(WORKFLOW_SETTING_DEFINITIONS.length, 61);
    assert.equal(digest, '5b5a817e07d37c55b65bcbd419cab2852ac33e604dbeeb39394bcef6681db370');
    const ids = WORKFLOW_SETTING_DEFINITIONS.map(entry => entry.id);
    assert.ok(ids.indexOf('full-suite-enabled') < ids.indexOf('optional-checks-enabled'));
    assert.ok(ids.indexOf('compile-gate-command') < ids.indexOf('full-suite-command'));
    assert.ok(ids.indexOf('full-suite-placement') < ids.indexOf('review-execution-policy'));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(WORKFLOW_SETTING_DEFINITIONS.map(entry => entry.key)).size, ids.length);
    assert.equal(new Set(WORKFLOW_SETTING_DEFINITIONS.map(entry => entry.flag)).size, ids.length);
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
