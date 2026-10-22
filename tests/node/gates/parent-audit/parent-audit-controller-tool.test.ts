import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parentReviewerControllerTool } from '../../../../src/gates/parent-audit/parent-audit-inputs';

test('parent aggregate reviewer controller tool follows the prepared provider', () => {
    assert.equal(parentReviewerControllerTool('Codex'), 'collaboration.spawn_agent');
    for (const provider of ['Claude', 'Cursor', 'GitHubCopilot', 'Gemini', 'Qwen']) {
        assert.equal(parentReviewerControllerTool(provider), 'provider-delegated-subagent', provider);
    }
});

test('parent audit navigation never hardcodes the Codex controller tool', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '../../../../src/gates/parent-audit/parent-audit-navigation.js'), 'utf8');
    assert.doesNotMatch(source, /--controller-tool "collaboration\.spawn_agent"/u);
    assert.match(source, /parentReviewerControllerTool/u);
});
