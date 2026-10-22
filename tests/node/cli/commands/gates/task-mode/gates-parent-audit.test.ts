import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { handleWorkflow } from '../../../../../../src/cli/commands/workflow/workflow-command';
import { handleParentAudit } from '../../../../../../src/cli/commands/gate-parent-audit-handlers';
import { getWorkflowSettingDefinition } from '../../../../../../src/reports/workflow-setting-metadata';
import { cleanupParentFixtures, parentFixture, PARENT_ID } from '../../../../gates/parent-audit/parent-audit-test-support';

afterEach(cleanupParentFixtures);

test('the parent-audit UI flag saves through the existing audited CLI path', async () => {
    const fixture = await parentFixture({ origin: 'manual', children: false });
    const flag = getWorkflowSettingDefinition('parent_audit.enabled')!;
    assert.equal(flag.flag, '--parent-audit-enabled');
    assert.throws(() => handleWorkflow(['set', flag.flag, 'true', '--target-root', fixture.root], { name: 'garda-fixture', version: '1.4.4' }), /operator/iu);
    const before = fs.readFileSync(fixture.config);
    assert.throws(() => handleWorkflow(['set', flag.flag, 'sometimes', '--target-root', fixture.root,
        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()], { name: 'garda-fixture', version: '1.4.4' }), /boolean|true|false/iu);
    assert.deepEqual(fs.readFileSync(fixture.config), before);
    const result = handleWorkflow(['set', flag.flag, 'true', '--target-root', fixture.root, '--json',
        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()], { name: 'garda-fixture', version: '1.4.4' });
    assert.ok(result && 'changed_fields' in result);
    assert.deepEqual(result.changed_fields, ['parent_audit.enabled']);
    assert.equal(JSON.parse(fs.readFileSync(fixture.config, 'utf8')).parent_audit.enabled, true);
});

test('native parent commands register manual grouping and reject arbitrary phases or commands', async () => {
    const fixture = await parentFixture({ origin: 'manual', children: false });
    await handleParentAudit(['--task-id', PARENT_ID, '--phase', 'register', '--repo-root', fixture.root]);
    await assert.rejects(handleParentAudit(['--task-id', PARENT_ID, '--phase', 'validate', '--command-index', '999', '--repo-root', fixture.root]), /command index is not declared/iu);
    await assert.rejects(handleParentAudit(['--task-id', PARENT_ID, '--phase', 'something-else', '--repo-root', fixture.root]), /phase must/iu);
    await assert.rejects(handleParentAudit(['--task-id', PARENT_ID, '--phase', 'register', '--audit-enabled', 'maybe', '--repo-root', fixture.root]), /true or false/iu);
});
