import * as bundleGuard from '../../../../../../src/gates/protected-control-plane/installed-bundle-guard';
import { handleSet } from '../../../../../../src/cli/commands/workflow/workflow-command-set';
import { initializeGitRepo } from '../preflight/gates-preflight-fixtures';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runClassifyChangeCommand } from '../../../../../../src/cli/commands/gates';
import { createTempRepo, seedInitAnswers, seedTaskQueue, runEnterTaskMode } from '../preflight/gates-preflight-fixtures';

for (const file of ['dist/formatter.js', 'src/core/formatter.ts', 'bin/garda.js', 'template/AGENTS.md', 'README.md', 'runtime/tool.ts', 'live/config/tool.ts', 'live/config/custom.json']) {
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

// Run the real gates and their actual scope guard with its POSIX platform branch on Windows too.
// This is branch coverage, not native Linux/macOS filesystem acceptance.
for (const platform of ['linux', 'darwin']) {
    for (const gate of ['entry', 'classify']) {
        test(`G1 case-varied bundle is rejected by ${gate} under ${platform} platform semantics`, t => {
            const root = createTempRepo();
            const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
            try {
                seedInitAnswers(root); seedTaskQueue(root, 'T-101'); initializeGitRepo(root);
                handleSet({ targetRoot: root, gardaSelfGuard: 'off', json: true, operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date().toISOString() });
                const bundleFile = 'GARDA-AGENT-ORCHESTRATOR/src/core/formatter.ts';
                fs.renameSync(path.join(root, 'garda-agent-orchestrator'), path.join(root, 'GARDA-AGENT-ORCHESTRATOR'));
                fs.mkdirSync(path.dirname(path.join(root, bundleFile)), { recursive: true });
                fs.writeFileSync(path.join(root, bundleFile), 'patched');
                const nativeGuard = bundleGuard.assertNoInstalledBundleScope;
                let guardCalled = false;
                t.mock.method(bundleGuard, 'assertNoInstalledBundleScope', (...args: Parameters<typeof nativeGuard>) => {
                    guardCalled = true;
                    // Keep native locking/filesystem operations on the actual host platform.
                    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
                    try { return nativeGuard(...args); }
                    finally { Object.defineProperty(process, 'platform', platformDescriptor); }
                });
                if (gate === 'entry') {
                    assert.throws(() => runEnterTaskMode({ repoRoot: root, taskId: 'T-101', taskSummary: 'Patch formatter',
                        provider: 'Codex', plannedChangedFiles: [bundleFile], orchestratorWork: true,
                        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() }), /Installed Garda bundle cannot be task scope/);
                } else {
                    assert.throws(() => runClassifyChangeCommand({ repoRoot: root, taskId: 'T-101', changedFiles: [bundleFile] }),
                        /Installed Garda bundle cannot be task scope/);
                }
                assert.equal(guardCalled, true);
            } finally {
                t.mock.restoreAll();
                Object.defineProperty(process, 'platform', platformDescriptor);
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    }
}
