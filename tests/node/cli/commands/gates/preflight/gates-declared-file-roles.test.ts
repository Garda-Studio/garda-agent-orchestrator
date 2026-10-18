import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runClassifyChangeCommand, runIntermediateCommandCommand } from '../../../../../../src/cli/commands/gates';
import { createTempRepo, getOrchestratorRoot, initializeGitRepo, loadTaskEntryRulePack,
    runEnterTaskMode, runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, seedTaskQueue } from './gates-preflight-fixtures';
import { loadPostPreflightRulePack } from '../../gate-test-seed-helpers';
import { readPreflightWorkspaceReadiness } from '../../../../../../src/gates/next-step/next-step-preflight-workspace-readiness';

test('explicit refresh preserves an untouched dirty README from a deferred task outside the selected scope', () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-explicit-foreign-readme';
    try {
        fs.mkdirSync(path.join(repoRoot, 'bot'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'bot/handler.ts'), 'export const value = 0;\n');
        fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Baseline\n');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Fixture instructions\n');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Deferred F1 work\n');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const entry = runEnterTaskMode({ repoRoot, taskId, provider: 'Codex',
            plannedChangedFiles: ['bot/handler.ts'], taskSummary: 'Keep bot-only task scope beside deferred README' });
        assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.writeFileSync(path.join(repoRoot, 'bot/handler.ts'), 'export const value = 1;\n');
        const preflight = JSON.parse(runClassifyChangeCommand({ repoRoot, taskId,
            taskIntent: 'Keep bot-only task scope beside deferred README', changedFiles: ['bot/handler.ts'],
            emitMetrics: false }).outputText);
        assert.deepEqual(preflight.changed_files, ['bot/handler.ts']);
        const taskMode = JSON.parse(fs.readFileSync(path.join(getOrchestratorRoot(repoRoot),
            'runtime/reviews', `${taskId}-task-mode.json`), 'utf8'));
        fs.writeFileSync(path.join(repoRoot, 'bot/handler.ts'), 'export const value = 2;\n');
        const readiness = readPreflightWorkspaceReadiness(repoRoot, preflight, {
            plannedChangedFiles: taskMode.planned_changed_files,
            dirtyWorkspaceBaselineChangedFiles: taskMode.dirty_workspace_baseline.changed_files,
            dirtyWorkspaceBaselineFileHashes: taskMode.dirty_workspace_baseline.file_hashes
        });
        assert.equal(readiness.ready, false);
        assert.deepEqual(readiness.currentChangedFiles, ['bot/handler.ts']);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8'), '# Deferred F1 work\n');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('ordinary native preflight uses declared roles and actual changes independently of planned authorization', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-declared-file-roles';
    try {
        const configRoot = path.join(getOrchestratorRoot(repoRoot), 'live/config');
        fs.mkdirSync(configRoot, { recursive: true });
        const roles = { 'src/view.mdx': 'source', 'config/live.yaml': 'source', 'tests/processor.yaml': 'source',
            'specifications/purchase.case': 'test', 'quality/购买': 'test', 'tests/purchase.yaml': 'test' };
        fs.writeFileSync(path.join(configRoot, 'paths.json'), JSON.stringify({ file_roles: roles }));
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Fixture instructions\n');
        for (const file of [...Object.keys(roles), 'README.md', 'src/unchanged.ts']) {
            fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, file), 'before\n');
        }
        fs.writeFileSync(path.join(repoRoot, 'quality/driver.cjs'), [
            "const test = require('node:test');",
            "const assert = require('node:assert/strict');",
            "test('purchase', () => assert.equal(require('node:fs').readFileSync(process.argv[2], 'utf8'), 'before\\n'));"
        ].join('\n'));
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'default', 'Test-first: expected-red');
        seedInitAnswers(repoRoot);
        const entry = runEnterTaskMode({ repoRoot, taskId, provider: 'Codex', taskSummary: 'Classify actual project roles' });
        assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        for (const [file, role] of [...Object.entries(roles), ['README.md', 'docs']]) {
            fs.writeFileSync(path.join(repoRoot, file), 'after\n');
            const result = runClassifyChangeCommand({ repoRoot, taskId, taskIntent: 'Classify actual project roles',
                changedFiles: [...Object.keys(roles), 'README.md', 'src/unchanged.ts'], emitMetrics: false });
            const preflight = JSON.parse(result.outputText);
            assert.equal(preflight.task_id, taskId);
            assert.deepEqual(preflight.changed_files, [file]);
            assert.equal(preflight.authorized_files.includes('src/unchanged.ts'), true);
            assert.equal(preflight.scope_category, role === 'source' ? 'code' : role === 'test' ? 'test-only' : 'docs-only', file);
            if (role === 'source') assert.equal(preflight.required_reviews.code, true, file);
            if (role === 'test') assert.equal(preflight.required_reviews.test, true, file);
            fs.writeFileSync(path.join(repoRoot, file), 'before\n');
        }
        fs.writeFileSync(path.join(repoRoot, 'specifications/purchase.case'), 'after\n');
        const preflightPath = path.join(getOrchestratorRoot(repoRoot), 'runtime/reviews', `${taskId}-preflight.json`);
        const redPreflight = runClassifyChangeCommand({ repoRoot, taskId, taskIntent: 'Verify declared test role',
            changedFiles: ['specifications/purchase.case'], outputPath: preflightPath, emitMetrics: false });
        assert.equal(JSON.parse(redPreflight.outputText).scope_category, 'test-only');
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, false).exitCode, 0);
        const testContext = process.env.NODE_TEST_CONTEXT;
        let red: Awaited<ReturnType<typeof runIntermediateCommandCommand>>;
        try {
            delete process.env.NODE_TEST_CONTEXT;
            red = await runIntermediateCommandCommand({ repoRoot, taskId, preflightPath,
                commandSource: 'targeted-test', command: 'node --test-reporter=tap quality/driver.cjs specifications/purchase.case',
                expectFailure: true });
        } finally {
            if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
            else process.env.NODE_TEST_CONTEXT = testContext;
        }
        assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
        assert.match(red.outputLines.join('\n'), /EXPECTED_FAILURE/u);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
