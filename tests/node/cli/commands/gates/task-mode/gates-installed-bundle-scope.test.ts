import * as bundleGuard from '../../../../../../src/gates/protected-control-plane/installed-bundle-guard';
import { handleSet } from '../../../../../../src/cli/commands/workflow/workflow-command-set';
import { INSTALLED_BUNDLE_OWNERSHIP_RULE } from '../../../../../../src/materialization/content-builders/content-builders-shared';
import { findRepoRoot } from '../../../../materialization/install-workspace-builder';
import { initializeGitRepo } from '../preflight/gates-preflight-fixtures';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runClassifyChangeCommand } from '../../../../../../src/cli/commands/gates';
import { createTempRepo, seedInitAnswers, seedTaskQueue, runEnterTaskMode, loadTaskEntryRulePack, runHandshakeForTask, runShellSmokeForTask } from '../preflight/gates-preflight-fixtures';

for (const file of ['dist/formatter.js', 'src/core/formatter.ts', 'bin/garda.js', 'template/AGENTS.md', 'README.md', 'runtime/tool.ts', 'live/config/tool.ts', 'live/config/custom.json',
    'live/docs/agent-rules/99-custom.md', 'live/docs/project-memory-extra/notes.md', 'live/docs/changes/RELEASE.md',
    'live/docs/project-memory/../../../dist/formatter.js']) {
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
                // Keep canonical identity/config valid; vary only the attempted bundle scope.
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

function startAppTask(root: string, plannedChangedFiles: string[]): void {
    runEnterTaskMode({ repoRoot: root, taskId: 'T-101', taskSummary: 'App change', provider: 'Codex', plannedChangedFiles });
    loadTaskEntryRulePack(root, 'T-101'); runHandshakeForTask(root, 'T-101'); runShellSmokeForTask(root, 'T-101');
}

test('G1 task-maintained project memory and internal changelog remain admissible installed task scope', () => {
    const root = createTempRepo();
    try {
        seedInitAnswers(root); seedTaskQueue(root, 'T-101');
        const documents = ['garda-agent-orchestrator/live/docs/project-memory/context.md',
            'garda-agent-orchestrator/live/docs/changes/CHANGELOG.md'];
        for (const file of documents) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'baseline\n');
        }
        initializeGitRepo(root);
        startAppTask(root, ['src/app.ts', ...documents]);
        fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 5;\n');
        for (const file of documents) fs.writeFileSync(path.join(root, file), 'task update\n');
        assert.doesNotThrow(() => runClassifyChangeCommand({ repoRoot: root, taskId: 'T-101', changedFiles: ['src/app.ts', ...documents] }));
        assert.doesNotThrow(() => runClassifyChangeCommand({ repoRoot: root, taskId: 'T-101' }));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('G1 tracked bundle file rewritten by update is rejected with untracking guidance', () => {
    const root = createTempRepo();
    try {
        const bundleFile = path.join(root, 'garda-agent-orchestrator', 'dist', 'formatter.js');
        fs.mkdirSync(path.dirname(bundleFile), { recursive: true }); fs.writeFileSync(bundleFile, 'before update\n');
        seedInitAnswers(root); seedTaskQueue(root, 'T-101'); initializeGitRepo(root);
        startAppTask(root, ['src/app.ts']);
        fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 5;\n');
        fs.writeFileSync(bundleFile, 'after update\n');
        assert.throws(() => runClassifyChangeCommand({ repoRoot: root, taskId: 'T-101' }),
            /Installed Garda bundle cannot be task scope: garda-agent-orchestrator\/dist\/formatter\.js\..*git rm -r --cached -- ":\(top,icase\)garda-agent-orchestrator"/s);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('G1 task-maintained document exemption keeps exact POSIX case below the bundle directory', () => {
    const root = createTempRepo();
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
        Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
        assert.doesNotThrow(() => bundleGuard.assertNoInstalledBundleScope(root, ['GARDA-AGENT-ORCHESTRATOR/live/docs/project-memory/context.md']));
        for (const file of ['garda-agent-orchestrator/live/docs/Project-Memory/context.md', 'garda-agent-orchestrator/live/docs/changes/changelog.md',
            'garda-agent-orchestrator/live/docs/project-memory']) {
            assert.throws(() => bundleGuard.assertNoInstalledBundleScope(root, [file]), /Installed Garda bundle cannot be task scope/, file);
        }
    } finally {
        Object.defineProperty(process, 'platform', platformDescriptor);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('G1 ownership rule constant matches every shipped rule template copy', () => {
    for (const name of ['00-core.md', '40-commands.md', '80-task-workflow.md']) {
        const template = fs.readFileSync(path.join(findRepoRoot(), 'template/docs/agent-rules', name), 'utf8');
        assert.deepEqual(template.split(/\r?\n/u).filter(line => line.startsWith('In installed projects,')),
            [INSTALLED_BUNDLE_OWNERSHIP_RULE], name);
    }
});
