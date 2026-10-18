import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getRepoRoot } from '../../../scripts/node-foundation/build';
import { migrateLegacyTaskTestSelectionGuidance } from '../../../src/materialization/rule-materialization';

const legacy = '- `garda workflow set` is a guarded workflow-config mutation surface and requires separate explicit operator approval with `--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`; agents must not approve workflow-config mutations for themselves.';
const template = fs.readFileSync(path.join(getRepoRoot(), 'template/docs/agent-rules/80-task-workflow.md'), 'utf8');

test('task-selection guidance migrates only the exact legacy sentence and preserves custom text', () => {
    for (const newline of ['\n', '\r\n']) {
        const input = ['User heading', legacy, legacy + ' custom rule', 'Quote: ' + legacy, 'User footer $&'].join(newline);
        const migrated = migrateLegacyTaskTestSelectionGuidance(input, template);
        assert.ok(migrated.includes('task_test_selection.require_operator_confirmation'));
        assert.ok(migrated.includes(legacy + ' custom rule'));
        assert.ok(migrated.includes('Quote: ' + legacy));
        assert.ok(migrated.endsWith('User footer $&'));
        assert.equal(migrateLegacyTaskTestSelectionGuidance(migrated, template), migrated);
        assert.equal(migrateLegacyTaskTestSelectionGuidance(input, 'Missing replacement'), input);
        if (newline === '\r\n') assert.equal(migrated.replaceAll('\r\n', '').includes('\n'), false);
    }
});

test('shipped orchestration directs blocked work through the navigator instead of reserved event logging', () => {
    const skill = fs.readFileSync(path.join(getRepoRoot(), 'template/skills/orchestration/SKILL.md'), 'utf8');
    assert.doesNotMatch(skill, /Log terminal event:/);
    assert.match(skill, /Do not call `log-task-event` for reserved events/);
    assert.match(skill, /actual failure evidence/);
    assert.match(skill, /task_test_selection.require_operator_confirmation/);
});
