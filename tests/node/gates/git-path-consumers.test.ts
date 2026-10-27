import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { getClassificationRenameCount } from '../../../src/cli/commands/gate-flows/compile/compile-flow-shared-evidence';
import { createWorkspaceSnapshotGitGeneration, getWorkspaceSnapshot } from '../../../src/gates/compile/compile-gate';
import { ensureCleanTrackedWorkspace } from '../../../src/gates/full-suite/full-suite-repair-restore-validation';
import { readCurrentStagedChangedFiles } from '../../../src/gates/next-step/next-step-lifecycle-command-builders';
import { collectChangedProjectMemoryFiles } from '../../../src/gates/project-memory-impact/project-memory-impact-update-evidence';
import { buildGitDiffSummary, readReviewContextChangedFiles } from '../../../src/gates/review-context/review-context-diff';
import { buildReviewTreeState } from '../../../src/gates/review/review-tree-state';
import { buildSplitCheckpointDetectionSource, getSplitCheckpointWorkspaceSnapshot } from '../../../src/gates/split-required/split-checkpoint-scope';
import { computeSnapshotFingerprint, getWorkspaceSnapshotCached } from '../../../src/gates/workspace/workspace-snapshot-cache';
import { initGitRepo, runGitFixtureCommand } from './git-fixtures';

function createRepository(context: TestContext, filePath: string, content = 'before\n'): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-git-path-consumer-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.dirname(path.join(root, filePath)), { recursive: true });
    fs.writeFileSync(path.join(root, filePath), content);
    initGitRepo(root);
    runGitFixtureCommand(root, ['config', 'core.quotePath', 'true']);
    runGitFixtureCommand(root, ['config', 'core.autocrlf', 'false']);
    return root;
}

function diffSummary(root: string, files: string[], source = 'explicit_changed_files') {
    return buildGitDiffSummary(root, files, { detection_source: source },
        path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-413-preflight.json'));
}

function legacyCacheFingerprint(root: string, filePath: string, content: string | null, source: string, version = 'v9'): string {
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
    const normalizedRoot = path.resolve(root).replace(/\\/gu, '/');
    const params = {
        detection_source: source,
        explicit_changed_files_hash: sha256(source === 'explicit_changed_files' ? filePath : ''),
        include_untracked: false,
        repo_root: process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
    };
    const state = content === null ? 'missing' : `file|${Buffer.byteLength(content)}|${sha256(content)}`;
    const descriptor = source === 'explicit_changed_files'
        ? `${filePath}|${state}`
        : source === 'git_staged_only'
            ? [runGitFixtureCommand(root, ['diff', '--cached', '--raw', '--find-renames', '--abbrev=40',
                '--diff-filter=ACDMRTUXB']).stdout.trimEnd(), `S|A||${filePath}`].join('\n')
            : `W|M||${filePath}|${state}`;
    const head = runGitFixtureCommand(root, ['rev-parse', 'HEAD']).stdout.trim();
    return sha256([version, source, head, sha256(descriptor), '0', '0', sha256(JSON.stringify(params))].join('|'));
}

describe('Git path consumers', () => {
    const fileNames = ['dir with space/файл.txt', '目录/文件.txt'];
    if (process.platform !== 'win32') fileNames.push('quote"name.txt');
    for (const filePath of fileNames) {
        it(`keeps staged and untracked paths consistent for ${filePath}`, (context) => {
            const root = createRepository(context, filePath);
            fs.writeFileSync(path.join(root, filePath), 'after\n');
            runGitFixtureCommand(root, ['add', '--', filePath]);
            const untrackedPath = `${filePath}.новый`;
            fs.writeFileSync(path.join(root, untrackedPath), 'untracked-marker\n');
            const snapshot = getWorkspaceSnapshot(root, 'git_auto', true, []);
            assert.deepEqual(snapshot.changed_files, [filePath, untrackedPath].sort());
            assert.equal(snapshot.changed_file_stats[filePath].changed_lines, 2);
            assert.deepEqual(readCurrentStagedChangedFiles(root), [filePath]);
            const generation = createWorkspaceSnapshotGitGeneration(root);
            Reflect.set(generation.readNumstat(false)[0], 'additions', 999);
            assert.deepEqual(getWorkspaceSnapshot(root, 'git_auto', true, [],
                generation), snapshot);
            const tree = buildReviewTreeState({ repoRoot: root, detectionSource: 'git_auto',
                includeUntracked: true, changedFiles: snapshot.changed_files });
            assert.ok(tree.entries.find(entry => entry.path === filePath)?.staged);
            const summary = diffSummary(root, snapshot.changed_files);
            assert.equal(summary.error, null);
            assert.match(summary.diff || '', /\+untracked-marker/u);
            assert.equal((summary.diff || '').match(/^diff --git /gmu)?.length, 2);
        });
    }

    it('counts a real Unicode rename once even when another file is named R100', (context) => {
        const original = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join('');
        const root = createRepository(context, 'тест.txt', original);
        runGitFixtureCommand(root, ['mv', 'тест.txt', '文件.txt']);
        fs.writeFileSync(path.join(root, '文件.txt'), original.replace('line 0\n', 'replacement\n'));
        fs.writeFileSync(path.join(root, 'R100'), 'status-looking-name\n');
        runGitFixtureCommand(root, ['add', '.']);
        assert.equal(getClassificationRenameCount(root, 'git_staged_only', ['文件.txt', 'R100']), 1);
        const snapshot = getWorkspaceSnapshot(root, 'git_staged_only', false, []);
        assert.equal(snapshot.changed_file_stats['文件.txt'].changed_lines, 2);
        const summary = diffSummary(root, ['тест.txt', '文件.txt'], 'git_staged_only');
        assert.equal(summary.error, null);
        assert.equal((summary.diff || '').match(/^diff --git /gmu)?.length, 1);
        assert.match(summary.diff || '', /rename from /u);
        assert.doesNotMatch(summary.diff || '', /new file mode/u);
    });

    it('collects real Unicode checkpoint scope and numstat paths', (context) => {
        const filePath = '目录/файл.txt';
        const root = createRepository(context, filePath);
        const base = runGitFixtureCommand(root, ['rev-parse', 'HEAD']).stdout.trim();
        fs.writeFileSync(path.join(root, filePath), 'after\n');
        runGitFixtureCommand(root, ['add', '.']);
        runGitFixtureCommand(root, ['commit', '-m', 'checkpoint']);
        const checkpoint = runGitFixtureCommand(root, ['rev-parse', 'HEAD']).stdout.trim();
        const snapshot = getSplitCheckpointWorkspaceSnapshot(root,
            buildSplitCheckpointDetectionSource({ base_commit: base, checkpoint_commit: checkpoint }), [filePath]);
        assert.deepEqual(snapshot.changed_files, [filePath]);
        assert.equal(snapshot.changed_lines_total, 2);
    });

    it('reports a renamed project-memory path without its source becoming a separate record', (context) => {
        const prefix = 'garda-agent-orchestrator/live/docs/project-memory/';
        const root = createRepository(context, `${prefix}тест.md`);
        runGitFixtureCommand(root, ['mv', `${prefix}тест.md`, `${prefix}文件.md`]);
        const result = collectChangedProjectMemoryFiles(root, path.join(root, 'garda-agent-orchestrator'));
        assert.equal(result.error, null);
        assert.deepEqual(result.files, [`${prefix}文件.md`]);
    });

    it('preserves tracked-change rejection and explicit scope containment', (context) => {
        const root = createRepository(context, 'тест.txt');
        fs.writeFileSync(path.join(root, 'тест.txt'), 'after\n');
        fs.writeFileSync(path.join(root, 'другой.txt'), 'outside-scope-marker\n');
        assert.deepEqual(ensureCleanTrackedWorkspace(root), ['unstaged tracked changes exist: тест.txt']);
        assert.doesNotMatch(diffSummary(root, ['тест.txt']).diff || '', /outside-scope-marker/u);
        assert.throws(() => readReviewContextChangedFiles(['../outside.txt']), /unsafe path/iu);
    });

    it('keeps the legacy ASCII snapshot fingerprint serialization byte-identical', (context) => {
        const root = createRepository(context, 'ascii.txt');
        const content = 'after\n';
        fs.writeFileSync(path.join(root, 'ascii.txt'), content);
        const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
        const pathsHash = sha256('ascii.txt');
        const contentHash = sha256(`ascii.txt:worktree:file:${Buffer.byteLength(content)}:${sha256(content)}`);
        const snapshot = getWorkspaceSnapshot(root, 'git_auto', false, []);
        assert.equal(snapshot.changed_files_sha256, pathsHash);
        assert.equal(snapshot.scope_content_sha256, contentHash);
        assert.equal(snapshot.scope_sha256, sha256(`git_auto|false|false|1|2|${pathsHash}|${contentHash}`));
    });

    it('invalidates legacy misparsed-path cache fingerprints while preserving ASCII fingerprints', (context) => {
        const content = 'after\n';
        for (const filePath of ['ascii.txt', 'тест.txt', '目录/文件.txt']) {
            const root = createRepository(context, filePath);
            fs.writeFileSync(path.join(root, filePath), content);
            for (const source of ['git_auto', 'explicit_changed_files']) {
                const files = source === 'explicit_changed_files' ? [filePath] : [];
                const current = computeSnapshotFingerprint(root, source, false, files).fingerprint;
                // Compare old path parsing within the current envelope version. Version 7
                // is independently invalidated even for ordinary ASCII by the v9 migration.
                const legacy = legacyCacheFingerprint(root, filePath, content, source);
                assert.notEqual(current, legacyCacheFingerprint(root, filePath, content, source, 'v7'));
                if (filePath === 'ascii.txt') assert.equal(current, legacy);
                else assert.notEqual(current, legacy);
            }
        }
        const root = createRepository(context, 'ascii.txt');
        // The literal-arrow ASCII exception is operator-approved; neither name needs a Windows file.
        for (const filePath of ['literal => name.txt', 'quote"name.txt']) {
            const current = computeSnapshotFingerprint(root, 'explicit_changed_files', false, [filePath]).fingerprint;
            assert.notEqual(current, legacyCacheFingerprint(root, filePath, null, 'explicit_changed_files'));
        }
    });

    it('invalidates legacy quoted-name index cache fingerprints for previously miscounted files', (context) => {
        const root = createRepository(context, 'ascii.txt');
        const filePath = 'quote"name.txt';
        // Card step 5 protects ASCII without quotes and permits changed hashes for quoted names.
        // An index-only file exercises that original allowance without creating an invalid Windows name.
        runGitFixtureCommand(root, ['config', 'core.protectNTFS', 'false']);
        const blob = runGitFixtureCommand(root, ['rev-parse', 'HEAD:ascii.txt']).stdout.trim();
        runGitFixtureCommand(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${filePath}`]);
        const snapshot = getWorkspaceSnapshot(root, 'git_staged_only', false, []);
        assert.deepEqual(snapshot.changed_files, [filePath]);
        assert.equal(snapshot.changed_file_stats[filePath].changed_lines, 1);
        const current = computeSnapshotFingerprint(root, 'git_staged_only', false, []).fingerprint;
        assert.notEqual(current, legacyCacheFingerprint(root, filePath, null, 'git_staged_only'));
    });

    it('invalidates staged Unicode deletions when their worktree path is recreated or edited', (context) => {
        for (const filePath of ['ascii.txt', 'тест.txt', '目录/文件.txt']) {
            const root = createRepository(context, filePath);
            runGitFixtureCommand(root, ['rm', '--', filePath]);
            const deleted = getWorkspaceSnapshotCached(root, 'git_staged_only', false, []);
            assert.equal(deleted.cache_hit, false);
            for (const content of ['recreated\n', 'edited again\n']) {
                fs.mkdirSync(path.dirname(path.join(root, filePath)), { recursive: true });
                fs.writeFileSync(path.join(root, filePath), content);
                const refreshed = getWorkspaceSnapshotCached(root, 'git_staged_only', false, []);
                assert.deepEqual(refreshed, {
                    ...getWorkspaceSnapshot(root, 'git_staged_only', false, []), cache_hit: false
                }, filePath);
                assert.equal(getWorkspaceSnapshotCached(root, 'git_staged_only', false, []).cache_hit, true);
            }
        }
    });
});
