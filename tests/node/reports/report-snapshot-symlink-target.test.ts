import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import * as path from 'node:path';
import { buildReportSnapshotCacheKey } from '../../../src/reports/report-data/report-snapshot-fingerprint';
import { makeLocalUiTempRepo, writeLocalUiRepoFixture } from './local-ui-test-helpers';

test('snapshot keys follow ignored symlink target edits with unchanged size and mtime', (t) => {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const git = (args: string[]) => execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    git(['init', '-q']);
    git(['config', 'user.name', 'Garda Tests']);
    git(['config', 'user.email', 'tests@example.invalid']);
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'ignored-target.ts\n');
    git(['add', '.']);
    git(['commit', '-qm', 'baseline']);
    const targetPath = path.join(repoRoot, 'ignored-target.ts');
    const linkPath = path.join(repoRoot, 'visible.ts');
    fs.writeFileSync(targetPath, 'export const value = 1;\n');
    fs.utimesSync(targetPath, 946684800, 946684800);
    fs.writeFileSync(linkPath, 'ignored-target.ts');
    const originalStat = fs.statSync;
    const originalLstat = fs.lstatSync;
    const originalReadlink = fs.readlinkSync;
    const linkStat = Object.assign(Object.create(originalLstat(linkPath)) as fs.Stats, {
        mode: 0o120777, isSymbolicLink: () => true
    });
    // Model a stable file symlink without requiring Windows symlink privileges.
    t.mock.method(fs, 'lstatSync', (filePath: fs.PathLike) => String(filePath) === linkPath
        ? linkStat : originalLstat(filePath));
    t.mock.method(fs, 'readlinkSync', (filePath: fs.PathLike) => String(filePath) === linkPath
        ? 'ignored-target.ts' : originalReadlink(filePath));
    t.mock.method(fs, 'statSync', (filePath: fs.PathLike) => originalStat(
        String(filePath) === linkPath ? targetPath : filePath
    ));
    assert.equal(git(['ls-files', '--others', '--exclude-standard', '-z']), 'visible.ts\0');
    const before = originalStat(targetPath);
    const initial = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(initial, null);
    assert.equal(buildReportSnapshotCacheKey(repoRoot), initial);

    fs.writeFileSync(targetPath, 'export const value = 2;\n');
    fs.utimesSync(targetPath, 946684800, 946684800);
    const after = originalStat(targetPath);
    assert.deepEqual([after.size, after.mtimeMs], [before.size, before.mtimeMs]);
    assert.notEqual(after.ctimeMs, before.ctimeMs);
    const edited = buildReportSnapshotCacheKey(repoRoot);
    assert.notEqual(edited, initial,
        'an ignored target edit must invalidate freshness through its visible symlink');
    assert.equal(buildReportSnapshotCacheKey(repoRoot), edited);

    const changedMode = Object.assign(Object.create(after) as fs.Stats, { mode: after.mode ^ 0o100 });
    t.mock.method(fs, 'statSync', (filePath: fs.PathLike) => String(filePath) === linkPath
        ? changedMode : originalStat(filePath));
    assert.notEqual(buildReportSnapshotCacheKey(repoRoot), edited, 'target mode participates in freshness');
    t.mock.method(fs, 'statSync', (filePath: fs.PathLike) => originalStat(
        String(filePath) === linkPath ? repoRoot : filePath
    ));
    assert.equal(buildReportSnapshotCacheKey(repoRoot), null,
        'directory-link contents cannot be observed from directory metadata');
});
