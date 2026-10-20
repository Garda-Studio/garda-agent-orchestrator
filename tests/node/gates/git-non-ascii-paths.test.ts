import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { getWorkspaceSnapshot } from '../../../src/gates/compile/compile-gate';
import { runGitDiff } from '../../../src/gates/preflight/build-scoped-diff';
import { buildGitDiffSummary } from '../../../src/gates/review-context/review-context-diff';
import { buildReviewTreeState } from '../../../src/gates/review/review-tree-state';
import { initGitRepo, runGitFixtureCommand } from './git-fixtures';

function createGitPathFixture(context: TestContext) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-git-paths-'));
    context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const trackedFiles = ['ascii.txt', 'тест.txt', 'dir with space/файл.txt', '目录/文件.txt'];
    if (process.platform !== 'win32') trackedFiles.push('quote"name.txt');

    function writeFile(relativePath: string, content: string): void {
        const absolutePath = path.join(repoRoot, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content, 'utf8');
    }

    for (const relativePath of trackedFiles) writeFile(relativePath, 'first\nsecond\n');
    initGitRepo(repoRoot);
    runGitFixtureCommand(repoRoot, ['config', 'core.quotePath', 'true']);
    runGitFixtureCommand(repoRoot, ['config', 'core.autocrlf', 'false']);
    writeFile('новый.txt', 'new-untracked-content\n');
    return { repoRoot, trackedFiles, writeFile };
}

describe('Git paths with core.quotePath=true', () => {
    it('counts six changed lines for equal ASCII and Cyrillic edits', (context) => {
        const fixture = createGitPathFixture(context);
        fixture.writeFile('ascii.txt', 'first\nthird\nfourth\n');
        fixture.writeFile('тест.txt', 'first\nthird\nfourth\n');
        runGitFixtureCommand(fixture.repoRoot, ['add', 'ascii.txt', 'тест.txt']);

        for (const detectionSource of ['git_auto', 'git_staged_only', 'explicit_changed_files']) {
            const snapshot = getWorkspaceSnapshot(
                fixture.repoRoot, detectionSource, false, ['ascii.txt', 'тест.txt']
            );
            assert.equal(snapshot.changed_lines_total, 6, detectionSource);
            assert.deepEqual(snapshot.changed_file_stats['тест.txt'], {
                additions: 2, deletions: 1, changed_lines: 3
            });
        }
    });

    it('includes the Cyrillic staged blob in the review tree', (context) => {
        const fixture = createGitPathFixture(context);
        fixture.writeFile('тест.txt', 'staged-cyrillic-content\n');
        runGitFixtureCommand(fixture.repoRoot, ['add', 'тест.txt']);

        const tree = buildReviewTreeState({
            repoRoot: fixture.repoRoot,
            detectionSource: 'git_staged_only',
            includeUntracked: false,
            changedFiles: ['тест.txt']
        });
        assert.equal(tree.entries.length, 1);
        assert.equal(tree.entries[0].path, 'тест.txt');
        assert.equal(tree.entries[0].has_staged_change, true);
        assert.ok(tree.entries[0].staged);
        assert.match(String(tree.entries[0].staged.object_id), /^[0-9a-f]{40,64}$/u);
    });

    it('includes the content of an untracked Cyrillic file in the review diff', (context) => {
        const fixture = createGitPathFixture(context);
        const summary = buildGitDiffSummary(
            fixture.repoRoot, ['новый.txt'], { detection_source: 'git_auto' },
            path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-413-preflight.json')
        );
        assert.equal(summary.error, null);
        assert.match(summary.diff || '', /\+new-untracked-content/u);
    });

    it('shows an explicitly scoped modified Cyrillic file once as modified', (context) => {
        const fixture = createGitPathFixture(context);
        fixture.writeFile('тест.txt', 'modified-tracked-content\n');
        const summary = buildGitDiffSummary(
            fixture.repoRoot, ['тест.txt'], { detection_source: 'explicit_changed_files' },
            path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-413-preflight.json')
        );
        assert.equal(summary.error, null);
        assert.match(summary.diff || '', /\+modified-tracked-content/u);
        assert.equal((summary.diff || '').match(/^diff --git /gmu)?.length, 1);
        assert.doesNotMatch(summary.diff || '', /new file mode/u);
    });

    it('prints real Cyrillic paths in reviewer diff headers and stats', (context) => {
        const fixture = createGitPathFixture(context);
        fixture.writeFile('тест.txt', 'modified-tracked-content\n');
        const summary = buildGitDiffSummary(
            fixture.repoRoot, ['тест.txt'], { detection_source: 'git_auto' },
            path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-413-preflight.json')
        );
        assert.equal(summary.error, null);
        assert.match(summary.diff || '', /^diff --git a\/тест\.txt b\/тест\.txt$/mu);
        assert.match(summary.stat || '', /тест\.txt/u);
        const scoped = runGitDiff(fixture.repoRoot, false, ['тест.txt']);
        assert.match(scoped, /^\+\+\+ b\/тест\.txt$/mu);
        for (const text of [summary.diff || '', summary.stat || '', scoped]) {
            assert.doesNotMatch(text, /\\[0-7]{3}/u, 'reviewer diff text must not octal-escape paths');
        }
    });
});
