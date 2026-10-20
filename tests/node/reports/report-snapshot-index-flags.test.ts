import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import * as path from 'node:path';
import { buildReportSnapshotCacheKey } from '../../../src/reports/report-data/report-snapshot-fingerprint';
import { makeLocalUiTempRepo, writeLocalUiRepoFixture } from './local-ui-test-helpers';

for (const flag of ['assume-unchanged', 'skip-worktree']) {
    test(`snapshot keys follow ${flag} changes without worktree writes`, () => {
        const repoRoot = makeLocalUiTempRepo();
        writeLocalUiRepoFixture(repoRoot);
        const git = (args: string[]) => execFileSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        });
        git(['init', '-q']);
        git(['config', 'user.name', 'Garda Tests']);
        git(['config', 'user.email', 'tests@example.invalid']);
        git(['config', 'core.autocrlf', 'false']);
        const sourcePath = path.join(repoRoot, 'данные с пробелами.ts');
        fs.writeFileSync(sourcePath, 'export const value = 1;\n');
        git(['add', '.']);
        git(['commit', '-qm', 'baseline']);
        git(['update-index', `--${flag}`, '--', 'данные с пробелами.ts']);
        fs.writeFileSync(sourcePath, 'export const value = 200;\n');
        const hidden = buildReportSnapshotCacheKey(repoRoot);
        const before = fs.statSync(sourcePath);
        const stageRecords = git(['ls-files', '--stage', '-z']);
        assert.notEqual(hidden, null);
        assert.equal(git(['status', '--porcelain=v1', '-z']), '');

        git(['update-index', `--no-${flag}`, '--', 'данные с пробелами.ts']);
        const visible = buildReportSnapshotCacheKey(repoRoot);
        const after = fs.statSync(sourcePath);
        assert.equal(git(['ls-files', '--stage', '-z']), stageRecords);
        assert.deepEqual([after.size, after.mtimeMs, after.ctimeMs], [before.size, before.mtimeMs, before.ctimeMs]);
        assert.notEqual(visible, hidden, 'revealing an existing modification changes quality freshness');
        assert.equal(buildReportSnapshotCacheKey(repoRoot), visible);
        assert.notEqual(git(['status', '--porcelain=v1', '-z']), '');

        git(['update-index', `--${flag}`, '--', 'данные с пробелами.ts']);
        assert.equal(buildReportSnapshotCacheKey(repoRoot), hidden, 'hiding the modification restores the prior key');
    });
}
