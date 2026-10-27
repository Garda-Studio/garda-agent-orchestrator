import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { NOT_EVERY_REQUEST_IS_A_TASK_RULE } from '../../../src/core/onboarding-contract';
import { findRepoRoot } from './install-workspace-builder';

const repoRoot = findRepoRoot();
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const COMMIT_SURFACES = [
    'template/docs/agent-rules/00-core.md',
    'template/docs/agent-rules/80-task-workflow.md',
    'template/skills/orchestration/SKILL.md',
    'template/skills/orchestration/references/stage-gates.md'
];

describe('shipped rule contracts', () => {
    it('describes one native commit contract and no legacy commit question', () => {
        for (const relativePath of COMMIT_SURFACES) {
            const text = read(relativePath);
            assert.doesNotMatch(text, /Do you want me to commit now\?/u, relativePath);
            assert.doesNotMatch(text, /Never commit unless user explicitly requests commit/u, relativePath);
            assert.doesNotMatch(text, /`git commit -m "<type>\(<scope>\): <summary>"` suggestion/u, relativePath);
        }
        for (const relativePath of ['template/docs/agent-rules/80-task-workflow.md', 'template/skills/orchestration/SKILL.md']) {
            const text = read(relativePath);
            assert.match(text, /gate human-commit --task-id "<task-id>" --message "<message>"/u, relativePath);
            assert.match(text, /ON grant, run it after completion\/task-audit PASS without asking the commit question again/u, relativePath);
            assert.match(text, /Never suggest or run a plain `git commit`/u, relativePath);
        }
    });

    it('lets agents create Garda-materialized follow-up rows without asking', () => {
        assert.match(NOT_EVERY_REQUEST_IS_A_TASK_RULE, /Rows that Garda materializes itself .*create them without asking\./u);
        for (const relativePath of ['template/.agents/workflows/start-task.md', 'template/docs/agent-rules/00-core.md',
            'template/docs/agent-rules/80-task-workflow.md', 'template/entrypoints/canonical-rule-index.md']) {
            assert.ok(read(relativePath).includes(NOT_EVERY_REQUEST_IS_A_TASK_RULE), relativePath);
        }
    });

    it('documents the Required reviews task marker where agents plan and route reviews', () => {
        for (const relativePath of ['template/docs/agent-rules/80-task-workflow.md', 'template/skills/orchestration/SKILL.md']) {
            const text = read(relativePath);
            assert.ok(text.includes('`Required reviews: code, security, api, test.`'), relativePath);
            assert.match(text, /before `classify-change`/u, relativePath);
            assert.match(text, /disabled .*blocks preflight/u, relativePath);
            assert.match(text, /only in a Markdown working plan or a draft plan (?:is|are) not binding/u, relativePath);
            assert.ok(text.includes('garda-agent-orchestrator/template/templates/task-plan.json'), relativePath);
            assert.ok(text.includes('garda-agent-orchestrator/runtime/reviews/<task-id>-task-plan.json'), relativePath);
            assert.match(text, /`required_reviews`/u, relativePath);
        }
    });
});
