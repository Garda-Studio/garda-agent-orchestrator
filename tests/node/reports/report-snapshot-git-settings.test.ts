import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import * as path from 'node:path';
import { buildReportSnapshotCacheKey } from '../../../src/reports/report-data/report-snapshot-fingerprint';
import { makeLocalUiTempRepo, writeLocalUiRepoFixture } from './local-ui-test-helpers';

for (const input of ['configuration', 'attributes']) {
    test(`snapshot keys follow Git ${input} changes without worktree writes`, () => {
        const repoRoot = makeLocalUiTempRepo();
        writeLocalUiRepoFixture(repoRoot);
        const git = (args: string[]) => execFileSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        });
        git(['init', '-q']);
        git(['config', 'user.name', 'Garda Tests']);
        git(['config', 'user.email', 'tests@example.invalid']);
        git(['config', 'core.autocrlf', 'false']);
        git(['config', 'core.fileMode', 'false']);
        const attributesPath = path.resolve(repoRoot, git(['rev-parse', '--git-path', 'info/attributes']).trim());
        const neutralAttributes = 'source.ts !diff\n';
        fs.writeFileSync(attributesPath, neutralAttributes);
        const sourcePath = path.join(repoRoot, 'source.ts');
        fs.writeFileSync(sourcePath, 'export const value = 1;\n');
        git(['add', '.']);
        git(['commit', '-qm', 'baseline']);
        fs.writeFileSync(sourcePath, 'export const value = 2;\n');
        assert.notEqual(git(['status', '--porcelain=v1', '-z']), '');
        const before = fs.statSync(sourcePath);
        const staged = git(['ls-files', '--stage', '-v', '-z']);
        const fsmonitor = git(['ls-files', '-f', '-z']);
        const numstat = git(['diff', '--numstat', '-z']);
        const initial = buildReportSnapshotCacheKey(repoRoot);
        assert.notEqual(initial, null);

        if (input === 'configuration') {
            git(['config', 'core.fileMode', 'true']);
            assert.equal(git(['config', 'core.fileMode']).trim(), 'true');
        } else {
            fs.writeFileSync(attributesPath, 'source.ts -diff\n');
            assert.notEqual(git(['diff', '--numstat', '-z']), numstat,
                'effective attributes change quality line counts without modifying the worktree');
        }
        const after = fs.statSync(sourcePath);
        assert.deepEqual([after.mode, after.size, after.mtimeMs, after.ctimeMs],
            [before.mode, before.size, before.mtimeMs, before.ctimeMs]);
        assert.equal(git(['ls-files', '--stage', '-v', '-z']), staged);
        assert.equal(git(['ls-files', '-f', '-z']), fsmonitor);
        const normalized = buildReportSnapshotCacheKey(repoRoot);
        assert.notEqual(normalized, initial, 'Git freshness inputs changed without a worktree write');
        assert.equal(buildReportSnapshotCacheKey(repoRoot), normalized);

        if (input === 'configuration') git(['config', 'core.fileMode', 'false']);
        else fs.writeFileSync(attributesPath, neutralAttributes);
        assert.equal(buildReportSnapshotCacheKey(repoRoot), initial);
    });
}
