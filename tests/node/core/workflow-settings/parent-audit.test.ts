import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { WORKFLOW_SETTING_REGISTRY } from '../../../../src/core/workflow-settings/registry';
import { validateWorkflowConfig } from '../../../../src/schemas/config-artifacts-workflow';

test('aggregate parent audit is an explicit opt-in workflow setting', () => {
    assert.deepEqual(buildDefaultWorkflowConfig().parent_audit, { enabled: false });
    const setting = WORKFLOW_SETTING_REGISTRY.get('parent-audit-enabled');
    assert.ok(setting, 'the UI and CLI must expose the same canonical setting');
    assert.equal(setting.key, 'parent_audit.enabled');
    assert.equal(setting.cli.flag, '--parent-audit-enabled');
    assert.equal(setting.ui.control, 'checkbox');
    assert.match(setting.ui.description, /manual|creation/iu);
});

test('parent audit configuration validates booleans instead of accepting an opaque section', () => {
    const defaults = buildDefaultWorkflowConfig();
    assert.throws(() => validateWorkflowConfig({ ...defaults, parent_audit: { enabled: 'sometimes' } }), /parent_audit/iu);
    assert.deepEqual(validateWorkflowConfig({ ...defaults, parent_audit: { enabled: true } }).parent_audit, { enabled: true });
    assert.deepEqual(validateWorkflowConfig(defaults).parent_audit, { enabled: false });
});
