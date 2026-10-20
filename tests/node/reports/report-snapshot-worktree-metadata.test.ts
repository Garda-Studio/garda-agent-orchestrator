import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import * as path from 'node:path';
import { buildReportSnapshotCacheKey } from '../../../src/reports/report-data/report-snapshot-fingerprint';
import { makeLocalUiTempRepo, writeLocalUiRepoFixture } from './local-ui-test-helpers';

function fixture(): { repoRoot: string; sourcePath: string; git: (args: string[]) => string } {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const git = (args: string[]) => execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    git(['init', '-q']);
    git(['config', 'user.name', 'Garda Tests']);
    git(['config', 'user.email', 'tests@example.invalid']);
    git(['config', 'core.autocrlf', 'false']);
    const sourcePath = path.join(repoRoot, 'source.ts');
    fs.writeFileSync(sourcePath, 'export const value = 1;\n');
    git(['add', '.']);
    git(['commit', '-qm', 'baseline']);
    return { repoRoot, sourcePath, git };
}

test('snapshot cache key checks never open tracked or untracked worktree file contents', (t) => {
    const { repoRoot, sourcePath } = fixture();
    fs.writeFileSync(sourcePath, 'export const value = 200;\n');
    const untrackedPath = path.join(repoRoot, 'untracked.txt');
    fs.writeFileSync(untrackedPath, 'untracked contents\n');
    const opened: string[] = [];
    const openSync = fs.openSync;
    t.mock.method(fs, 'openSync', (filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if ([sourcePath, untrackedPath].includes(String(filePath))) opened.push(String(filePath));
        return openSync(filePath, flags, mode);
    });
    const initial = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(initial, null);
    assert.equal(buildReportSnapshotCacheKey(repoRoot), initial);
    assert.deepEqual(opened, [], 'cache-key checks must use metadata instead of reading file contents');
});

test('snapshot metadata keys follow same-size edits, index blobs, HEAD and Unicode renames', () => {
    const { repoRoot, sourcePath, git } = fixture();
    const initial = buildReportSnapshotCacheKey(repoRoot);
    git(['commit', '--allow-empty', '-qm', 'move HEAD without changing files']);
    const movedHead = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(movedHead, initial);

    fs.writeFileSync(sourcePath, 'export const value = 2;\n');
    fs.utimesSync(sourcePath, 946684800, 946684800);
    const edited = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(edited, movedHead);
    fs.writeFileSync(sourcePath, 'export const value = 3;\n');
    fs.utimesSync(sourcePath, 946684800, 946684800);
    const editedAgain = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(editedAgain, edited, 'an already modified file changed without changing size');
    git(['add', '--', 'source.ts']);
    const staged = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(staged, editedAgain);

    fs.writeFileSync(sourcePath, 'export const value = 4;\n');
    git(['add', '--', 'source.ts']);
    const restaged = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(restaged, staged, 'staging new content changes the index blob');
    git(['mv', '--', 'source.ts', 'данные с пробелами.ts']);
    const renamed = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(renamed, restaged);
    assert.equal(buildReportSnapshotCacheKey(repoRoot), renamed);
    const untrackedPath = path.join(repoRoot, 'новый файл.txt');
    fs.writeFileSync(untrackedPath, 'new\n');
    const added = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(added, renamed);
    fs.unlinkSync(untrackedPath);
    assert.equal(buildReportSnapshotCacheKey(repoRoot), renamed);
});

test('submodule inputs use the fresh-report fallback instead of trusting directory metadata', () => {
    const { repoRoot, git } = fixture();
    const head = git(['rev-parse', 'HEAD']).trim();
    git(['update-index', '--add', '--cacheinfo', `160000,${head},dependency`]);
    fs.mkdirSync(path.join(repoRoot, 'dependency'));
    fs.writeFileSync(path.join(repoRoot, 'dependency', 'source.ts'), 'export const nested = true;\n');
    assert.equal(buildReportSnapshotCacheKey(repoRoot), null);
});
