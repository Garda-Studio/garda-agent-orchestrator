import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getWorkspaceSnapshot } from '../../../../src/gates/compile/compile-gate';
import { computeCodeReviewScopeFingerprint } from '../../../../src/gates/review-reuse';
import {
    assertReviewTreeStateFresh,
    buildReviewTreeState,
    createReviewTreeStateFreshnessCache,
    getReviewTreeStateBlockingViolations,
    getReviewTreeStateFreshnessCacheStats
} from '../../../../src/gates/review/review-tree-state';
import { computeSnapshotFingerprint } from '../../../../src/gates/workspace/workspace-snapshot-cache';

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(result.status, 0, String(result.stderr || result.error || 'git command failed'));
}

function readGitRepositoryState(repoRoot: string) {
    return {
        head: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
        status: childProcess.execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' }).trimEnd(),
        indexDiff: childProcess.execFileSync('git', ['diff', '--cached', '--name-status'], { cwd: repoRoot, encoding: 'utf8' }).trimEnd(),
        worktreeDiff: childProcess.execFileSync('git', ['diff', '--name-status'], { cwd: repoRoot, encoding: 'utf8' }).trimEnd()
    };
}

function findTreeEntry(treeState: ReturnType<typeof buildReviewTreeState>, filePath: string) {
    const entry = treeState.entries.find((candidate) => candidate.path === filePath);
    assert.ok(entry, `expected tree-state entry for ${filePath}`);
    return entry;
}

describe('gates/review-tree-state', () => {
    it('captures staged-only, unstaged-only, mixed MM, and untracked path states', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-tree-state-status-'));
        try {
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'staged.ts'), 'export const staged = 1;\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'src', 'unstaged.ts'), 'export const unstaged = 1;\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'src', 'mixed.ts'), 'export const mixed = 1;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/staged.ts', 'src/unstaged.ts', 'src/mixed.ts']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);

            fs.writeFileSync(path.join(repoRoot, 'src', 'staged.ts'), 'export const staged = 2;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/staged.ts']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'unstaged.ts'), 'export const unstaged = 2;\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'src', 'mixed.ts'), 'export const mixed = 2;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/mixed.ts']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'mixed.ts'), 'export const mixed = 3;\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'src', 'untracked.ts'), 'export const untracked = 1;\n', 'utf8');

            const treeState = buildReviewTreeState({
                repoRoot,
                detectionSource: 'git_staged_plus_untracked',
                includeUntracked: true,
                changedFiles: [
                    'src/staged.ts',
                    'src/unstaged.ts',
                    'src/mixed.ts',
                    'src/untracked.ts'
                ],
                metrics: {
                    changed_files_sha256: 'changed-files-hash',
                    scope_content_sha256: 'scope-content-hash',
                    scope_sha256: 'scope-hash'
                }
            });

            const staged = findTreeEntry(treeState, 'src/staged.ts');
            assert.equal(staged.index_status, 'M');
            assert.equal(staged.worktree_status, ' ');
            assert.equal(staged.has_staged_change, true);
            assert.equal(staged.has_unstaged_change, false);
            assert.equal(staged.stale_staged_snapshot_risk, false);
            assert.match(String(staged.staged?.object_id || ''), /^[0-9a-f]{40,64}$/);
            assert.equal(staged.worktree.status, 'file');
            assert.match(String(staged.worktree.sha256 || ''), /^[0-9a-f]{64}$/);

            const unstaged = findTreeEntry(treeState, 'src/unstaged.ts');
            assert.equal(unstaged.index_status, ' ');
            assert.equal(unstaged.worktree_status, 'M');
            assert.equal(unstaged.has_staged_change, false);
            assert.equal(unstaged.has_unstaged_change, true);
            assert.equal(unstaged.stale_staged_snapshot_risk, true);
            assert.match(String(unstaged.staged?.object_id || ''), /^[0-9a-f]{40,64}$/);

            const mixed = findTreeEntry(treeState, 'src/mixed.ts');
            assert.equal(mixed.index_status, 'M');
            assert.equal(mixed.worktree_status, 'M');
            assert.equal(mixed.has_staged_change, true);
            assert.equal(mixed.has_unstaged_change, true);
            assert.equal(mixed.stale_staged_snapshot_risk, true);
            assert.match(String(mixed.staged?.object_id || ''), /^[0-9a-f]{40,64}$/);

            const untracked = findTreeEntry(treeState, 'src/untracked.ts');
            assert.equal(untracked.index_status, '?');
            assert.equal(untracked.worktree_status, '?');
            assert.equal(untracked.has_staged_change, false);
            assert.equal(untracked.has_unstaged_change, false);
            assert.equal(untracked.staged, null);
            assert.equal(untracked.worktree.status, 'file');
            assert.match(String(untracked.worktree.sha256 || ''), /^[0-9a-f]{64}$/);

            assert.deepEqual(treeState.stale_staged_snapshot_files, [
                'src/mixed.ts',
                'src/unstaged.ts'
            ]);
            assert.deepEqual(treeState.mixed_staged_worktree_files, ['src/mixed.ts']);
            assert.match(treeState.tree_state_sha256, /^[0-9a-f]{64}$/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('shares current freshness snapshots across repeated review artifact checks', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-tree-state-cache-'));
        try {
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/app.ts']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');

            const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', false, ['src/app.ts']);
            const treeState = buildReviewTreeState({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: false,
                changedFiles: snapshot.changed_files,
                metrics: {
                    changed_files_sha256: snapshot.changed_files_sha256,
                    scope_content_sha256: snapshot.scope_content_sha256,
                    scope_sha256: snapshot.scope_sha256
                }
            });
            const reviewContext = { tree_state: treeState };
            const freshnessCache = createReviewTreeStateFreshnessCache();

            assertReviewTreeStateFresh({
                repoRoot,
                reviewContext,
                contextPath: path.join(repoRoot, 'runtime', 'reviews', 'T-1-code-review-context.json'),
                gateName: 'required-reviews-check',
                freshnessCache
            });
            assert.deepEqual(getReviewTreeStateFreshnessCacheStats(freshnessCache), {
                current_scope_snapshot_count: 1,
                current_tree_state_count: 1
            });

            assertReviewTreeStateFresh({
                repoRoot,
                reviewContext,
                contextPath: path.join(repoRoot, 'runtime', 'reviews', 'T-1-security-review-context.json'),
                gateName: 'required-reviews-check',
                freshnessCache
            });
            assert.deepEqual(getReviewTreeStateFreshnessCacheStats(freshnessCache), {
                current_scope_snapshot_count: 1,
                current_tree_state_count: 1
            });
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('revalidates split-checkpoint freshness with the stored checkpoint files', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-tree-state-checkpoint-'));
        try {
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/app.ts']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            const baseCommit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/app.ts']);
            runGit(repoRoot, ['commit', '-m', 'checkpoint']);
            const checkpointCommit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
            const detectionSource = `git_split_checkpoint:${baseCommit}:${checkpointCommit}`;
            const beforeValidationState = readGitRepositoryState(repoRoot);
            const snapshot = getWorkspaceSnapshot(repoRoot, detectionSource, false, ['src/app.ts']);
            const treeState = buildReviewTreeState({ repoRoot, detectionSource, includeUntracked: false, changedFiles: snapshot.changed_files, metrics: snapshot });
            assert.doesNotThrow(() => assertReviewTreeStateFresh({
                repoRoot,
                reviewContext: { tree_state: treeState },
                contextPath: path.join(repoRoot, 'runtime', 'reviews', 'T-1-code-review-context.json'),
                gateName: 'record-review-routing'
            }));
            assert.deepEqual(readGitRepositoryState(repoRoot), beforeValidationState);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('accepts git-auto docs-only drift when the reviewed code domain still matches', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-tree-state-doc-drift-'));
        try {
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/app.ts']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');

            const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
            const treeState = buildReviewTreeState({
                repoRoot,
                detectionSource: 'git_auto',
                includeUntracked: true,
                changedFiles: snapshot.changed_files,
                metrics: {
                    changed_files_sha256: snapshot.changed_files_sha256,
                    scope_content_sha256: snapshot.scope_content_sha256,
                    scope_sha256: snapshot.scope_sha256
                }
            });
            const reviewContext = {
                review_type: 'code',
                tree_state: treeState
            };

            fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n\nCloseout note.\n', 'utf8');

            assert.doesNotThrow(() => assertReviewTreeStateFresh({
                repoRoot,
                reviewContext,
                contextPath: path.join(repoRoot, 'runtime', 'reviews', 'T-1-code-review-context.json'),
                gateName: 'required-reviews-check',
                freshnessCache: createReviewTreeStateFreshnessCache()
            }));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fails closed on git-auto config drift even when implementation files stay unchanged', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-tree-state-config-drift-'));
        try {
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/app.ts']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');

            const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
            const treeState = buildReviewTreeState({
                repoRoot,
                detectionSource: 'git_auto',
                includeUntracked: true,
                changedFiles: snapshot.changed_files,
                metrics: {
                    changed_files_sha256: snapshot.changed_files_sha256,
                    scope_content_sha256: snapshot.scope_content_sha256,
                    scope_sha256: snapshot.scope_sha256
                }
            });
            const reviewContext = {
                review_type: 'code',
                tree_state: treeState
            };

            fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
            fs.writeFileSync(
                path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
                '{\"full_suite_validation\":{\"enabled\":false}}\n',
                'utf8'
            );

            assert.throws(
                () => assertReviewTreeStateFresh({
                    repoRoot,
                    reviewContext,
                    contextPath: path.join(repoRoot, 'runtime', 'reviews', 'T-1-code-review-context.json'),
                    gateName: 'required-reviews-check',
                    freshnessCache: createReviewTreeStateFreshnessCache()
                }),
                /review context scope is stale|scope fingerprints are stale|tree_state is stale/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('binds in-repo symlink targets into review and reuse fingerprints', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-tree-state-symlink-target-'));
        try {
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            const targetPath = path.join(repoRoot, 'src', 'target.ts');
            const linkPath = path.join(repoRoot, 'src', 'link.ts');
            fs.writeFileSync(targetPath, 'export const value = "alpha";\n', 'utf8');
            runGit(repoRoot, ['add', 'src/target.ts']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            try {
                fs.symlinkSync(targetPath, linkPath, 'file');
            } catch (error) {
                t.skip(`file symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const preflight = {
                detection_source: 'explicit_changed_files',
                changed_files: ['src/link.ts']
            };
            const alphaSnapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/link.ts']);
            const alphaTreeState = buildReviewTreeState({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles: alphaSnapshot.changed_files,
                metrics: {
                    changed_files_sha256: alphaSnapshot.changed_files_sha256,
                    scope_content_sha256: alphaSnapshot.scope_content_sha256,
                    scope_sha256: alphaSnapshot.scope_sha256
                }
            });
            const alphaCacheFingerprint = computeSnapshotFingerprint(
                repoRoot,
                'explicit_changed_files',
                true,
                ['src/link.ts']
            );
            const alphaReuseScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);

            fs.writeFileSync(targetPath, 'export const value = "bravo";\n', 'utf8');

            const bravoSnapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/link.ts']);
            const bravoTreeState = buildReviewTreeState({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles: bravoSnapshot.changed_files,
                metrics: {
                    changed_files_sha256: bravoSnapshot.changed_files_sha256,
                    scope_content_sha256: bravoSnapshot.scope_content_sha256,
                    scope_sha256: bravoSnapshot.scope_sha256
                }
            });
            const bravoCacheFingerprint = computeSnapshotFingerprint(
                repoRoot,
                'explicit_changed_files',
                true,
                ['src/link.ts']
            );
            const bravoReuseScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);

            assert.equal(alphaTreeState.entries[0]?.worktree.status, 'symbolic_link');
            assert.equal(alphaTreeState.entries[0]?.worktree.target_status, 'file');
            assert.equal(alphaTreeState.entries[0]?.worktree.target_path, 'src/target.ts');
            assert.match(String(alphaTreeState.entries[0]?.worktree.target_sha256 || ''), /^[0-9a-f]{64}$/);
            assert.notEqual(bravoTreeState.tree_state_sha256, alphaTreeState.tree_state_sha256);
            assert.notEqual(bravoSnapshot.scope_content_sha256, alphaSnapshot.scope_content_sha256);
            assert.notEqual(bravoCacheFingerprint.fingerprint, alphaCacheFingerprint.fingerprint);
            assert.notEqual(bravoReuseScope.code_scope_sha256, alphaReuseScope.code_scope_sha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('captures broken symlinks as link-text-only reviewable entries', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-tree-state-broken-symlink-'));
        try {
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            runGit(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            const linkPath = path.join(repoRoot, 'src', 'broken-link.ts');
            try {
                fs.symlinkSync('missing-target.ts', linkPath, 'file');
            } catch (error) {
                t.skip(`file symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/broken-link.ts']);
            const treeState = buildReviewTreeState({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles: snapshot.changed_files,
                metrics: {
                    changed_files_sha256: snapshot.changed_files_sha256,
                    scope_content_sha256: snapshot.scope_content_sha256,
                    scope_sha256: snapshot.scope_sha256
                }
            });

            const entry = findTreeEntry(treeState, 'src/broken-link.ts');
            assert.equal(entry.worktree.status, 'symbolic_link');
            assert.equal(entry.worktree.target_status, 'missing');
            assert.equal(entry.worktree.link_target, 'missing-target.ts');
            assert.match(String(entry.worktree.link_sha256 || ''), /^[0-9a-f]{64}$/);
            assert.deepEqual(getReviewTreeStateBlockingViolations(treeState), []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fails closed for symlinks to directories because reviewer-visible file content is unreviewable', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-tree-state-directory-symlink-'));
        try {
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            runGit(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
            fs.mkdirSync(path.join(repoRoot, 'src', 'target-dir'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'target-dir', 'value.ts'), 'export const value = 1;\n', 'utf8');
            const linkPath = path.join(repoRoot, 'src', 'dir-link');
            try {
                fs.symlinkSync(path.join(repoRoot, 'src', 'target-dir'), linkPath, 'dir');
            } catch (error) {
                t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/dir-link']);
            const treeState = buildReviewTreeState({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles: snapshot.changed_files,
                metrics: {
                    changed_files_sha256: snapshot.changed_files_sha256,
                    scope_content_sha256: snapshot.scope_content_sha256,
                    scope_sha256: snapshot.scope_sha256
                }
            });

            const entry = findTreeEntry(treeState, 'src/dir-link');
            assert.equal(entry.worktree.status, 'unreviewable_symlink');
            assert.equal(entry.worktree.target_status, 'directory');
            assert.equal(entry.worktree.target_path, 'src/target-dir');
            assert.match(String(entry.worktree.link_sha256 || ''), /^[0-9a-f]{64}$/);
            assert.match(
                getReviewTreeStateBlockingViolations(treeState).join('\n'),
                /symlinks or junctions that do not resolve to regular in-repo files: src\/dir-link/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
