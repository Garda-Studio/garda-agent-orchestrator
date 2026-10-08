import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';
import { buildGitignoreEntries, syncManagedGitignoreBlockInContent } from '../../../src/materialization/content-builders';

interface IgnoreMatch {
    file: string;
    pattern: string;
    ignored: boolean;
}

function matchIgnoredFiles(files: string[], gitignoreContent?: string): IgnoreMatch[] {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-generated-ignore-'));
    try {
        const init = childProcess.spawnSync('git', ['-c', 'init.templateDir=', 'init', '--quiet'], {
            cwd: fixtureRoot, encoding: 'utf8', windowsHide: true
        });
        assert.equal(init.status, 0, init.stderr || String(init.error || 'git init failed'));
        if (gitignoreContent === undefined) {
            fs.copyFileSync(path.join(getRepoRoot(), '.gitignore'), path.join(fixtureRoot, '.gitignore'));
        } else {
            fs.writeFileSync(path.join(fixtureRoot, '.gitignore'), gitignoreContent, 'utf8');
        }
        // --no-index also exposes an overbroad rule that would hide an already tracked template.
        const result = childProcess.spawnSync('git', [
            '-c', 'core.excludesFile=', 'check-ignore', '--no-index', '--verbose', '--non-matching', '--stdin', '-z'
        ], { cwd: fixtureRoot, input: files.join('\0') + '\0', encoding: 'utf8', windowsHide: true });
        assert.ok(result.status === 0 || result.status === 1, result.stderr || String(result.error));
        const fields = result.stdout.split('\0');
        assert.equal(fields.pop(), '');
        assert.equal(fields.length, files.length * 4);
        return files.map((file, index) => {
            const [source, line, pattern, matchedFile] = fields.slice(index * 4, index * 4 + 4);
            assert.equal(matchedFile, file);
            if (line) assert.equal(source, '.gitignore');
            return { file, pattern, ignored: Boolean(line) && !pattern.startsWith('!') };
        });
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

const generatedEntrypoints = [
    '.claude/settings.json', '.agentignore', '.agents/workflows/start-task.md',
    '.antigravity/rules.md', '.github/agents/orchestrator.md', '.github/copilot-instructions.md',
    '.junie/guidelines.md', '.qwen/settings.json', '.windsurf/rules/rules.md',
    'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'QWEN.md', 'TASK.md',
    'garda-agent-orchestrator/live/config/workflow-config.json'
];

test('root generated entrypoints and publish build lock remain ignored', () => {
    const files = [...generatedEntrypoints, 'dist.lock/owner.json', 'live/config/settings.json',
        'runtime/task.json', 'bin/garda.js', 'bin/garda/src/cli/main.js', 'TASK_DONE.md'];
    for (const match of matchIgnoredFiles(files)) {
        assert.equal(match.ignored, true, match.file);
    }
    assert.equal(matchIgnoredFiles(['dist.lock/owner.json'])[0].pattern, '/dist.lock/');
});

test('nested templates and user entrypoints stay visible to Git', () => {
    const files = ['template/', 'examples/project/'].flatMap((prefix) => (
        [...generatedEntrypoints, 'dist.lock/owner.json', 'live/settings.json', 'runtime/task.json',
            'bin/garda.js', 'bin/garda/README.md', 'TASK_DONE.md'].map((file) => prefix + file)
    ));
    files.push('AGENTS.md.backup', 'TASK.md.backup', 'dist.lock.backup/owner.json');
    for (const match of matchIgnoredFiles(files)) {
        assert.equal(match.ignored, false, match.file);
        assert.equal(match.pattern, '', match.file);
    }
});

test('intentional build dependency and editor ignores retain their exception', () => {
    const files = ['dist/main.js', 'nested/dist/main.js', 'node_modules/package/index.js',
        'nested/node_modules/package/index.js', '.node-build/test.js', '.scripts-build/test.js',
        '.node-build.lock/owner.json', '.scripts-build.lock/owner.json', '.tmp_rtk_bin_fixture/tool',
        '.idea/workspace.xml', '.vscode/extensions.json', 'coverage/index.html',
        'nested/coverage/index.html', 'release-archives/release.zip', 'scripts/test/local.ts',
        'docs_local/note.md', '.DS_Store', 'nested/Thumbs.db', 'Desktop.ini', 'testResults.xml',
        'tsc-errors-full.txt', 'tsc-target-errors.txt', 'project.iml'];
    for (const match of matchIgnoredFiles(files)) {
        assert.equal(match.ignored, true, match.file);
    }
    const settings = matchIgnoredFiles(['.vscode/settings.json'])[0];
    assert.equal(settings.ignored, false);
    assert.equal(settings.pattern, '!.vscode/settings.json');
});

test('native managed-ignore refresh prevents broad patterns from hiding nested templates', () => {
    const original = fs.readFileSync(path.join(getRepoRoot(), '.gitignore'), 'utf8');
    const entries = buildGitignoreEntries(['AGENTS.md'], [], false);
    const refreshed = syncManagedGitignoreBlockInContent(original, entries, false);
    assert.equal(refreshed.content, original);
    assert.equal(refreshed.changed, false);
    assert.equal(refreshed.addedEntries, 0);
    assert.deepEqual(syncManagedGitignoreBlockInContent(refreshed.content, entries, false), refreshed);
    const rootFiles = [...generatedEntrypoints, 'dist.lock/owner.json'];
    const nestedFiles = ['template/', 'examples/project/'].flatMap(prefix =>
        rootFiles.map(file => prefix + file));
    const matches = matchIgnoredFiles([...rootFiles, ...nestedFiles], refreshed.content);
    for (const match of matches.slice(0, rootFiles.length)) assert.equal(match.ignored, true, match.file);
    for (const match of matches.slice(rootFiles.length)) {
        assert.equal(match.ignored, false, match.file);
        assert.equal(match.pattern, '', match.file);
    }
});
