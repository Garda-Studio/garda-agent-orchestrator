import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NOT_EVERY_REQUEST_IS_A_TASK_RULE } from '../../../src/core/onboarding-contract';
import { getProviderBridgeEntries } from '../../../src/core/provider/provider-registry';
import { buildRedirectManagedBlock } from '../../../src/materialization/content-builders/content-builders-entrypoints';
import {
    buildProviderOrchestratorAgentContent,
    buildSharedStartTaskWorkflowContent
} from '../../../src/materialization/content-builders/content-builders-provider-bridges';

function findRepoRoot() {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'AGENT_INIT_PROMPT.md'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

test('generated entrypoints, bridges and start-task tell agents that not every request is a task', () => {
    assert.match(NOT_EVERY_REQUEST_IS_A_TASK_RULE, /wait for the user's decision; never add a row and enter it without that decision/);
    assert.ok(buildRedirectManagedBlock('CLAUDE.md', 'AGENTS.md', null).includes(NOT_EVERY_REQUEST_IS_A_TASK_RULE));
    assert.ok(buildSharedStartTaskWorkflowContent('AGENTS.md').includes(NOT_EVERY_REQUEST_IS_A_TASK_RULE));
    for (const entry of getProviderBridgeEntries()) {
        const bridgePath = entry.bridge!.orchestratorRelativePath;
        const content = buildProviderOrchestratorAgentContent(entry.displayLabel, 'AGENTS.md', bridgePath);
        assert.ok(content.includes(NOT_EVERY_REQUEST_IS_A_TASK_RULE), bridgePath);
        assert.ok(!content.includes('select/create a task row'), bridgePath);
    }
});

test('rule templates carry the same not-every-request-is-a-task rule', () => {
    for (const relativePath of [
        'template/entrypoints/canonical-rule-index.md',
        'template/.agents/workflows/start-task.md',
        'template/docs/agent-rules/00-core.md',
        'template/docs/agent-rules/80-task-workflow.md'
    ]) {
        const content = fs.readFileSync(path.join(findRepoRoot(), relativePath), 'utf8');
        assert.ok(content.includes(NOT_EVERY_REQUEST_IS_A_TASK_RULE), relativePath);
    }
});
