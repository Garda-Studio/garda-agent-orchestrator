import { handleSet } from '../../../../../../src/cli/commands/workflow/workflow-command-set';
import { initializeGitRepo } from '../preflight/gates-preflight-fixtures';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runClassifyChangeCommand } from '../../../../../../src/cli/commands/gates';
import { createTempRepo, seedInitAnswers, seedTaskQueue, runEnterTaskMode } from '../preflight/gates-preflight-fixtures';

for (const file of ['dist/formatter.js', 'src/core/formatter.ts', 'bin/garda.js', 'template/AGENTS.md', 'README.md']) {
    test(`G1 installed bundle ${file} cannot enter task scope even with approval`, () => {
        const root = createTempRepo();
        try {
            seedInitAnswers(root); seedTaskQueue(root, 'T-101'); initializeGitRepo(root);
            handleSet({ targetRoot: root, gardaSelfGuard: 'off', json: true, operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: new Date().toISOString() });
            const bundleFile = 'garda-agent-orchestrator/' + file;
            fs.mkdirSync(path.dirname(path.join(root, bundleFile)), { recursive: true });
            fs.writeFileSync(path.join(root, bundleFile), 'patched');
            assert.throws(() => runEnterTaskMode({ repoRoot: root, taskId: 'T-101', taskSummary: 'Patch formatter',
                provider: 'Codex', plannedChangedFiles: [bundleFile], orchestratorWork: true,
                operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() }), /Installed Garda bundle cannot be task scope/);
            assert.throws(() => runClassifyChangeCommand({ repoRoot: root, taskId: 'T-101', changedFiles: [bundleFile] }),
                /Installed Garda bundle cannot be task scope/);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
}
