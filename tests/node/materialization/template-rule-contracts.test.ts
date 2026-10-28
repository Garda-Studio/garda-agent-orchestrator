import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runInit } from '../../../src/materialization/init';
import { getTaskModeRuleSectionMigrations } from '../../../src/materialization/rule-contracts';
import { runVerify } from '../../../src/validators/verify';
import { NOT_EVERY_REQUEST_IS_A_TASK_RULE } from '../../../src/core/onboarding-contract';
import { findRepoRoot, setupTestWorkspace, writeInitAnswers } from './install-workspace-builder';

const repoRoot = findRepoRoot();
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const COMMIT_SURFACES = [
    'template/docs/agent-rules/00-core.md',
    'template/docs/agent-rules/40-commands.md',
    'template/docs/agent-rules/80-task-workflow.md',
    'template/skills/orchestration/SKILL.md',
    'template/skills/orchestration/references/stage-gates.md'
];

describe('shipped rule contracts', () => {
    it('describes both task-bound native commit permission modes', () => {
        for (const relativePath of COMMIT_SURFACES) {
            const text = read(relativePath);
            assert.match(text, /ON grant, run .*gate human-commit --task-id "<task-id>" --message "<message>".*after completion\/task-audit PASS without asking/u, relativePath);
            assert.match(text, /OFF or missing authority, ask .*Do you want me to commit now\? \(yes\/no\)/u, relativePath);
            assert.match(text, /--task-id "<task-id>" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp of the answer>" --message/u, relativePath);
            assert.match(text, /missing or stale confirmation is refused/u, relativePath);
            assert.doesNotMatch(text, /never overrides OFF|confirmation flags to bypass permission|OFF or unavailable authority blocks native|With OFF or unavailable authority, explain the audited enablement/u, relativePath);
            assert.match(text, /exactly accepted staged task scope and post-commit audit/u, relativePath);
            assert.match(text, /Never suggest or run a plain \x60git commit\x60/u, relativePath);
        }
    });

    it('keeps public CLI reference consistent with protected confirmation', () => {
        const text = read('docs/cli-reference.md');
        assert.match(text, /With OFF or missing authority/u);
        assert.match(text, /--task-id "<task-id>" --operator-confirmed yes --operator-confirmed-at-utc/u);
        assert.match(text, /missing or stale confirmation is refused/u);
        assert.doesNotMatch(text, /blocks native commits, even with legacy confirmation|authenticated Local commit ON required/u);
    });

    it('keeps settings, help and the work example consistent with protected confirmation', () => {
        const settings = read('src/core/workflow-settings/protected-controls.ts');
        const help = read('src/cli/commands/cli-help-output.ts');
        const example = read('docs/work-example.md');
        assert.match(settings, /Require fresh operator confirmation for each native task commit/u);
        assert.doesNotMatch(settings, /Block native local commits and revoke earlier grants/u);
        assert.match(help, /OFF revokes durable permission and requires a fresh operator confirmation and answer timestamp/u);
        assert.match(example, /Only under OFF or missing authority/u);
        assert.match(example, /Authenticated ON runs this command without asking/u);
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

describe('materialized rule verifier compatibility', () => {
    it('ships every snippet consumed by the native rule contract verifier', () => {
        for (const migration of getTaskModeRuleSectionMigrations()) {
            const relativePath = 'template/' + migration.templateRelativePath.split('/template/')[1];
            const content = read(relativePath);
            for (const snippet of migration.requiredSnippets) {
                assert.ok(content.includes(snippet), relativePath + ': ' + snippet);
            }
        }
    });

    it('passes native rule checks after real init and rejects incompatible shipped report wording', (t) => {
        const w = setupTestWorkspace(repoRoot);
        t.after(() => fs.rmSync(w.projectRoot, { recursive: true, force: true }));
        const answersPath = writeInitAnswers(w.bundleRoot, {
            AssistantLanguage: 'English', AssistantBrevity: 'concise', SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false', ClaudeOrchestratorFullAccess: 'false', TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE'
        });
        fs.writeFileSync(path.join(w.projectRoot, 'package.json'), JSON.stringify({
            name: 'installed-rule-contract-fixture', private: true, scripts: { build: 'node -e "process.exit(0)"' }
        }));
        runInit({ targetRoot: w.projectRoot, bundleRoot: w.bundleRoot, sourceOfTruth: 'Codex',
            assistantLanguage: 'English', assistantBrevity: 'concise', enforceNoAutoCommit: false });
        const options = { targetRoot: w.projectRoot, sourceOfTruth: 'Codex', initAnswersPath: answersPath };
        const accepted = runVerify(options);
        assert.deepEqual(accepted.violations.commandsContractViolations, []);
        assert.deepEqual(accepted.violations.coreRuleContractViolations, []);
        assert.deepEqual(accepted.violations.ruleFileViolations, []);
        // Reproduce a release where template and live agree but both violate the verifier.
        for (const area of ['template', 'live']) {
            const file = path.join(w.bundleRoot, area, 'docs/agent-rules/80-task-workflow.md');
            const current = fs.readFileSync(file, 'utf8');
            assert.ok(current.includes('summary of what changed -> verbatim Garda final user report'));
            fs.writeFileSync(file, current.replace('summary of what changed -> verbatim Garda final user report',
                'summary -> verbatim Garda final user report'));
        }
        const rejected = runVerify(options);
        assert.equal(rejected.passed, false);
        assert.ok(rejected.violations.ruleFileViolations.some(entry =>
            entry.includes('80-task-workflow.md') && entry.includes('Final user report order is mandatory')));
    });
});
