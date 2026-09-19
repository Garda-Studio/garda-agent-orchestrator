import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import * as gitChangeClassification from '../../../../src/core/git-change-classification';
import {
    createWorkspaceSnapshotGitGeneration,
    getWorkspaceSnapshot
} from '../../../../src/gates/compile/compile-gate';
import { readCompileReadiness } from '../../../../src/gates/next-step/next-step-compile-readiness';
import { readPreflightWorkspaceReadiness } from '../../../../src/gates/next-step/next-step-preflight-workspace-readiness';
import {
    buildDocsOnlyDeltaReadiness,
    readCurrentGitWorkspaceSnapshot
} from '../../../../src/gates/scope/docs-only-delta-readiness';
import { buildFinalCloseoutArtifact } from '../../../../src/gates/task-audit/task-audit-summary-closeout-artifact';
import {
    buildPostDoneWorkspaceDriftBlocker,
    evaluateStagedPostDoneAuditedScope,
    resolveCommittableChangedFiles
} from '../../../../src/gates/task-audit/task-audit-summary-drift';
import { getCurrentWorkflowConfigChanges } from '../../../../src/gates/workflow-config/workflow-config-work-changes';
import {
    computeSnapshotFingerprint,
    createWorkspaceSnapshotRequest,
    getWorkspaceSnapshotCached,
    invalidateSnapshotCache,
    parseGitCachedRawDiffDeletedPaths,
    readHeadSha,
    readSnapshotCache,
    resolveSnapshotCachePath,
    resolveWorkspaceSnapshotRequest,
    statGitIndex,
    writeSnapshotCache
} from '../../../../src/gates/workspace/workspace-snapshot-cache';
import type { WorkspaceSnapshotCacheEntry } from '../../../../src/gates/workspace/workspace-snapshot-cache';

function initTestRepo(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-snap-cache-'));
    const repoRoot = path.join(tempDir, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 1;\n', 'utf8');
    execFileSync('git', ['-C', repoRoot, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'init'], { stdio: 'ignore' });
    return tempDir;
}

function cleanupTestRepo(tempDir: string): void {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function canonicalJsonForForgery(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalJsonForForgery(entry === undefined ? null : entry)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJsonForForgery(record[key])}`)
        .join(',')}}`;
}

function hashCanonicalForgery(value: unknown): string {
    return createHash('sha256').update(canonicalJsonForForgery(value), 'utf8').digest('hex');
}

function recomputeAttackerControlledHashes(entry: WorkspaceSnapshotCacheEntry): void {
    entry.integrity.snapshot_sha256 = hashCanonicalForgery(entry.snapshot);
    entry.integrity.params_sha256 = hashCanonicalForgery(entry.params);
    entry.integrity.workspace_identity_sha256 = hashCanonicalForgery({
        repo_root: process.platform === 'win32' ? entry.params.repo_root.toLowerCase() : entry.params.repo_root,
        fingerprint: entry.fingerprint
    });
    entry.integrity.entry_sha256 = hashCanonicalForgery({
        cache_version: entry.cache_version,
        fingerprint: entry.fingerprint,
        timestamp_utc: entry.timestamp_utc,
        params: entry.params,
        git_state: entry.git_state,
        snapshot_sha256: entry.integrity.snapshot_sha256,
        params_sha256: entry.integrity.params_sha256,
        workspace_identity_sha256: entry.integrity.workspace_identity_sha256
    });
}

describe('gates/workspace-snapshot-cache', () => {
    let tempDir: string;
    let repoRoot: string;

    beforeEach(() => {
        tempDir = initTestRepo();
        repoRoot = path.join(tempDir, 'repo');
    });

    afterEach(() => {
        cleanupTestRepo(tempDir);
    });

    describe('readHeadSha', () => {
        it('returns HEAD sha for a valid repo', () => {
            const sha = readHeadSha(repoRoot);
            assert.ok(sha, 'HEAD sha should be non-null');
            assert.match(sha, /^[0-9a-f]{40}$/);
        });

        it('returns null for non-repo directory', () => {
            const sha = readHeadSha(tempDir);
            assert.equal(sha, null);
        });
    });

    describe('statGitIndex', () => {
        it('returns non-zero mtime and size for a valid repo', () => {
            const stat = statGitIndex(repoRoot);
            assert.ok(stat.mtime_ms > 0);
            assert.ok(stat.size > 0);
        });

        it('returns zeros for non-repo directory', () => {
            const noGit = path.join(tempDir, 'nodir');
            fs.mkdirSync(noGit, { recursive: true });
            const stat = statGitIndex(noGit);
            assert.equal(stat.mtime_ms, 0);
            assert.equal(stat.size, 0);
        });
    });

    describe('computeSnapshotFingerprint', () => {
        it('returns a stable fingerprint for unchanged state', () => {
            const fp1 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            const fp2 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            assert.equal(fp1.fingerprint, fp2.fingerprint);
        });

        it('fingerprint changes when HEAD moves', () => {
            const fp1 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            fs.writeFileSync(path.join(repoRoot, 'new.ts'), 'export const b = 2;\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', '.'], { stdio: 'ignore' });
            execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'second'], { stdio: 'ignore' });
            const fp2 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            assert.notEqual(fp1.fingerprint, fp2.fingerprint);
        });

        it('fingerprint changes when files are staged', () => {
            const fp1 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            fs.writeFileSync(path.join(repoRoot, 'staged.ts'), 'export const c = 3;\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', 'staged.ts'], { stdio: 'ignore' });
            const fp2 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            assert.notEqual(fp1.fingerprint, fp2.fingerprint);
        });

        it('fingerprint changes when tracked worktree content changes without staging', () => {
            const fp1 = computeSnapshotFingerprint(repoRoot, 'git_auto', false, []);
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 42;\n', 'utf8');
            const fp2 = computeSnapshotFingerprint(repoRoot, 'git_auto', false, []);
            assert.notEqual(fp1.fingerprint, fp2.fingerprint);
        });

        it('fingerprint changes when untracked file content changes and includeUntracked=true', () => {
            fs.writeFileSync(path.join(repoRoot, 'draft.ts'), 'one\n', 'utf8');
            const fp1 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            fs.writeFileSync(path.join(repoRoot, 'draft.ts'), 'one\ntwo\nthree\n', 'utf8');
            const fp2 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            assert.notEqual(fp1.fingerprint, fp2.fingerprint);
        });

        it('fingerprint changes when parameters differ', () => {
            const fp1 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            const fp2 = computeSnapshotFingerprint(repoRoot, 'git_auto', false, []);
            const fp3 = computeSnapshotFingerprint(repoRoot, 'git_staged_only', true, []);
            const fp4 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, ['file.ts']);
            assert.notEqual(fp1.fingerprint, fp2.fingerprint);
            assert.notEqual(fp1.fingerprint, fp3.fingerprint);
            assert.notEqual(fp1.fingerprint, fp4.fingerprint);
        });

        it('fingerprint changes when an explicit symlink target content changes inside the repo', (t) => {
            const targetPath = path.join(repoRoot, 'target.ts');
            const symlinkPath = path.join(repoRoot, 'link.ts');
            fs.writeFileSync(targetPath, 'export const target = 1;\n', 'utf8');
            try {
                fs.symlinkSync(targetPath, symlinkPath, 'file');
            } catch (error) {
                t.skip(`file symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const fp1 = computeSnapshotFingerprint(repoRoot, 'explicit_changed_files', true, ['link.ts']);
            fs.writeFileSync(targetPath, 'export const target = 2;\n', 'utf8');
            const fp2 = computeSnapshotFingerprint(repoRoot, 'explicit_changed_files', true, ['link.ts']);

            assert.notEqual(fp1.fingerprint, fp2.fingerprint);
        });
    });

    describe('parseGitCachedRawDiffDeletedPaths', () => {
        it('derives staged deletion paths from cached raw diff output', () => {
            const rawDiff = [
                ':100644 000000 1111111111111111111111111111111111111111 0000000000000000000000000000000000000000 D\tfile.ts',
                ':100644 100644 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 M\tchanged.ts',
                ':100644 100644 4444444444444444444444444444444444444444 5555555555555555555555555555555555555555 R100\told.ts\tnew.ts',
                ':100644 000000 6666666666666666666666666666666666666666 0000000000000000000000000000000000000000 D\truntime/cache/workspace-snapshot.json'
            ].join('\n');

            assert.deepEqual(parseGitCachedRawDiffDeletedPaths(repoRoot, rawDiff), ['file.ts']);
        });
    });

    describe('performance characterization', () => {
        it('rejects mixed workspace generations across shared audit and report consumers', () => {
            const childProcessModule = require('node:child_process') as typeof import('node:child_process');
            const originalSpawnSync = childProcessModule.spawnSync;
            const originalExecFileSync = childProcessModule.execFileSync;
            const gitCommands: string[][] = [];
            childProcessModule.spawnSync = ((command: string, args: string[], options: unknown) => {
                if (command === 'git') gitCommands.push([...args]);
                return originalSpawnSync(command, args, options as never);
            }) as typeof originalSpawnSync;
            childProcessModule.execFileSync = ((command: string, args: string[], options: unknown) => {
                if (command === 'git') gitCommands.push([...args]);
                return originalExecFileSync(command, args, options as never);
            }) as typeof originalExecFileSync;
            try {
                fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
                const request = createWorkspaceSnapshotRequest(repoRoot);
                const first = request.read('git_auto', true, []);
                fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 3;\n', 'utf8');
                const repeated = request.read('git_auto', true, []);

                assert.strictEqual(repeated, first);
                assert.equal(Object.isFrozen(first), true);
                assert.equal(Object.isFrozen(first.changed_files), true);
                assert.equal(repeated.scope_content_sha256, first.scope_content_sha256);
                assert.equal(gitCommands.filter((args) => args.includes('status')).length, 1);
                assert.equal(gitCommands.filter((args) => args.includes('config')).length, 1);
                assert.equal(gitCommands.filter((args) => args.includes('--numstat')).length, 1);

                const refreshed = createWorkspaceSnapshotRequest(repoRoot).read('git_auto', true, []);
                assert.notEqual(refreshed.scope_content_sha256, first.scope_content_sha256);
            } finally {
                childProcessModule.spawnSync = originalSpawnSync;
                childProcessModule.execFileSync = originalExecFileSync;
            }
        });

        it('derives distinct request snapshots from at most eight Git subprocesses', () => {
            fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'ignored.ts\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'second.ts'), 'export const second = 1;\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', '.gitignore', 'second.ts'], { stdio: 'ignore' });
            execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'add mixed fixtures'], { stdio: 'ignore' });
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', 'file.ts'], { stdio: 'ignore' });
            fs.writeFileSync(path.join(repoRoot, 'second.ts'), 'export const second = 2;\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'draft.ts'), 'export const draft = true;\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'ignored.ts'), 'export const ignored = true;\n', 'utf8');

            const childProcessModule = require('node:child_process') as typeof import('node:child_process');
            const originalSpawnSync = childProcessModule.spawnSync;
            const originalExecFileSync = childProcessModule.execFileSync;
            const gitCommands: string[][] = [];
            childProcessModule.spawnSync = ((command: string, args: string[], options: unknown) => {
                if (command === 'git') gitCommands.push([...args]);
                return originalSpawnSync(command, args, options as never);
            }) as typeof originalSpawnSync;
            childProcessModule.execFileSync = ((command: string, args: string[], options: unknown) => {
                if (command === 'git') gitCommands.push([...args]);
                return originalExecFileSync(command, args, options as never);
            }) as typeof originalExecFileSync;
            try {
                const request = createWorkspaceSnapshotRequest(repoRoot);
                const withUntracked = request.read('git_auto', true, []);
                const withoutUntracked = request.read('git_auto', false, []);
                const stagedOnly = request.read('GIT_STAGED_ONLY', true, []);
                const equivalentStagedOnly = request.read('git_staged_only', false, []);
                const explicitIgnored = request.read('explicit_changed_files', true, ['ignored.ts']);

                assert.deepEqual(withUntracked.changed_files, ['draft.ts', 'file.ts', 'second.ts']);
                assert.deepEqual(withoutUntracked.changed_files, ['file.ts', 'second.ts']);
                assert.notStrictEqual(withUntracked, withoutUntracked);
                assert.strictEqual(stagedOnly, equivalentStagedOnly);
                assert.deepEqual(stagedOnly.changed_files, ['file.ts']);
                assert.deepEqual(explicitIgnored.changed_files, ['ignored.ts']);
                assert.ok(gitCommands.length <= 8, `expected at most 8 Git subprocesses, received ${gitCommands.length}`);
                assert.equal(gitCommands.filter((args) => args.includes('status')).length, 1);
                assert.equal(gitCommands.filter((args) => args.includes('config')).length, 1);
                assert.equal(gitCommands.filter((args) => args.includes('ls-tree')).length, 1);
                assert.equal(gitCommands.filter((args) => args.includes('ls-files')).length, 1);
                assert.equal(gitCommands.filter((args) => args.includes('--numstat')).length, 2);
            } finally {
                childProcessModule.spawnSync = originalSpawnSync;
                childProcessModule.execFileSync = originalExecFileSync;
            }
        });

        it('rejects foreign and forged workspace snapshot requests', () => {
            const request = createWorkspaceSnapshotRequest(repoRoot);
            assert.strictEqual(resolveWorkspaceSnapshotRequest(repoRoot, request), request);
            const forgedRequest = {
                repo_root: repoRoot,
                read: request.read
            };
            const rejectsForgedRequest = /not factory-authenticated for the requested repository root/u;
            const genuineGitGeneration = createWorkspaceSnapshotGitGeneration(repoRoot);
            const forgedGitGeneration = { ...genuineGitGeneration };
            assert.throws(
                () => getWorkspaceSnapshot(repoRoot, 'git_auto', true, [], forgedGitGeneration),
                /Workspace Git generation is not factory-authenticated/u
            );

            const foreignTempDir = initTestRepo();
            try {
                const foreignRepoRoot = path.join(foreignTempDir, 'repo');
                const foreignRequest = createWorkspaceSnapshotRequest(foreignRepoRoot);
                const foreignGitGeneration = createWorkspaceSnapshotGitGeneration(foreignRepoRoot);
                assert.throws(
                    () => resolveWorkspaceSnapshotRequest(repoRoot, foreignRequest),
                    /not factory-authenticated for the requested repository root/u
                );
                assert.throws(
                    () => resolveWorkspaceSnapshotRequest(repoRoot, forgedRequest),
                    rejectsForgedRequest
                );
                assert.throws(
                    () => getWorkspaceSnapshot(repoRoot, 'git_auto', true, [], foreignGitGeneration),
                    /Workspace Git generation is not factory-authenticated/u
                );
                assert.throws(
                    () => readCompileReadiness(repoRoot, tempDir, tempDir, 'T-TEST', 'missing.json', forgedRequest),
                    rejectsForgedRequest
                );
                assert.throws(
                    () => readPreflightWorkspaceReadiness(repoRoot, {}, { workspaceSnapshotRequest: forgedRequest }),
                    rejectsForgedRequest
                );
                assert.throws(
                    () => buildDocsOnlyDeltaReadiness(
                        repoRoot,
                        [],
                        [],
                        0,
                        true,
                        'git_auto',
                        '',
                        '',
                        [],
                        null,
                        forgedRequest
                    ),
                    rejectsForgedRequest
                );
                assert.throws(
                    () => readCurrentGitWorkspaceSnapshot(repoRoot, true, forgedRequest),
                    rejectsForgedRequest
                );
                assert.throws(
                    () => buildFinalCloseoutArtifact({
                        repoRoot,
                        workspaceSnapshotRequest: forgedRequest
                    } as Parameters<typeof buildFinalCloseoutArtifact>[0]),
                    rejectsForgedRequest
                );
                assert.throws(
                    () => buildPostDoneWorkspaceDriftBlocker(repoRoot, [], [], null, 'closeout.json', forgedRequest),
                    rejectsForgedRequest
                );
                assert.throws(
                    () => resolveCommittableChangedFiles(repoRoot, forgedRequest),
                    rejectsForgedRequest
                );
                assert.throws(
                    () => getCurrentWorkflowConfigChanges(repoRoot, null, { workspaceSnapshotRequest: forgedRequest }),
                    rejectsForgedRequest
                );
            } finally {
                cleanupTestRepo(foreignTempDir);
            }
        });

        it('reuses the request snapshot in repeated staged post-DONE checks', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', 'file.ts'], { stdio: 'ignore' });
            const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
            const closeoutPath = path.join(tempDir, 'closeout.json');
            fs.writeFileSync(closeoutPath, JSON.stringify({
                implementation_summary: {
                    audited_scope_provenance: {
                        use_staged: true,
                        detection_source: 'git_staged_only',
                        include_untracked: false,
                        changed_files: stagedSnapshot.changed_files,
                        changed_files_sha256: stagedSnapshot.changed_files_sha256,
                        scope_content_sha256: stagedSnapshot.scope_content_sha256
                    }
                }
            }), 'utf8');
            const request = createWorkspaceSnapshotRequest(repoRoot);
            const childProcessModule = require('node:child_process') as typeof import('node:child_process');
            const originalSpawnSync = childProcessModule.spawnSync;
            const gitCommands: string[][] = [];
            childProcessModule.spawnSync = ((command: string, args: string[], options: unknown) => {
                if (command === 'git') gitCommands.push([...args]);
                return originalSpawnSync(command, args, options as never);
            }) as typeof originalSpawnSync;
            try {
                const options = {
                    repoRoot,
                    auditedFiles: stagedSnapshot.changed_files,
                    currentChangedFiles: stagedSnapshot.changed_files,
                    finalCloseoutJsonPath: closeoutPath,
                    workspaceSnapshotRequest: request
                };
                const first = evaluateStagedPostDoneAuditedScope(options);
                const repeated = evaluateStagedPostDoneAuditedScope(options);

                assert.equal(first?.blocked, false);
                assert.deepEqual(repeated, first);
                assert.equal(gitCommands.filter((args) => (
                    args.includes('--numstat') && args.includes('--cached')
                )).length, 1);
            } finally {
                childProcessModule.spawnSync = originalSpawnSync;
            }
        });

        it('uses the cached raw diff as the only staged-only diff subprocess', () => {
            const originalSpawnSync = (require('node:child_process') as typeof import('node:child_process')).spawnSync;
            const diffCommands: string[][] = [];
            const childProcessModule = require('node:child_process') as typeof import('node:child_process');
            childProcessModule.spawnSync = ((command: string, args: string[], options: unknown) => {
                if (command === 'git' && args.includes('diff')) {
                    diffCommands.push([...args]);
                }
                return originalSpawnSync(command, args, options as never);
            }) as typeof originalSpawnSync;
            try {
                execFileSync('git', ['-C', repoRoot, 'rm', 'file.ts'], { stdio: 'ignore' });

                computeSnapshotFingerprint(repoRoot, 'git_staged_only', false, []);

                assert.equal(diffCommands.length, 1);
                assert.deepEqual(diffCommands[0].slice(0, 3), ['-C', repoRoot, 'diff']);
                assert.ok(diffCommands[0].includes('--raw'));
                assert.ok(!diffCommands[0].includes('--name-only'));
            } finally {
                childProcessModule.spawnSync = originalSpawnSync;
            }
        });

        it('resolves repo realpath once when hashing multiple explicit paths', () => {
            const extraPath = path.join(repoRoot, 'extra.ts');
            fs.writeFileSync(extraPath, 'export const extra = 1;\n', 'utf8');
            const fsModule = require('node:fs') as typeof import('node:fs');
            const originalRealpathSync = fsModule.realpathSync;
            let repoRealpathCalls = 0;
            fsModule.realpathSync = ((targetPath: fs.PathLike, options?: BufferEncoding | null) => {
                if (path.resolve(String(targetPath)) === path.resolve(repoRoot)) {
                    repoRealpathCalls += 1;
                }
                return originalRealpathSync(targetPath, options as never);
            }) as typeof fsModule.realpathSync;
            try {
                computeSnapshotFingerprint(repoRoot, 'explicit_changed_files', true, ['file.ts', 'extra.ts']);

                assert.equal(repoRealpathCalls, 1);
            } finally {
                fsModule.realpathSync = originalRealpathSync;
            }
        });
    });

    describe('readSnapshotCache / writeSnapshotCache', () => {
        it('round-trips a valid cache entry', () => {
            const cachePath = path.join(tempDir, 'cache.json');
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            const entry = readSnapshotCache(resolveSnapshotCachePath(repoRoot));
            assert.ok(entry);
            writeSnapshotCache(cachePath, entry);
            const read = readSnapshotCache(cachePath);
            assert.ok(read);
            assert.match(read.fingerprint, /^[0-9a-f]{64}$/u);
            assert.match(read.integrity.snapshot_sha256, /^[0-9a-f]{64}$/u);
            assert.match(read.integrity.params_sha256, /^[0-9a-f]{64}$/u);
            assert.match(read.integrity.workspace_identity_sha256, /^[0-9a-f]{64}$/u);
            assert.match(read.integrity.entry_sha256, /^[0-9a-f]{64}$/u);
            assert.match(read.integrity.entry_hmac_sha256, /^[0-9a-f]{64}$/u);
            assert.deepEqual(read.snapshot.changed_files, ['file.ts']);
        });

        it('returns null for missing file', () => {
            const read = readSnapshotCache(path.join(tempDir, 'nonexistent.json'));
            assert.equal(read, null);
        });

        it('returns null for invalid JSON', () => {
            const cachePath = path.join(tempDir, 'bad.json');
            fs.writeFileSync(cachePath, 'not json', 'utf8');
            assert.equal(readSnapshotCache(cachePath), null);
        });

        it('returns null for wrong cache version', () => {
            const cachePath = path.join(tempDir, 'old.json');
            fs.writeFileSync(cachePath, JSON.stringify({ cache_version: 1, fingerprint: 'x', snapshot: {} }), 'utf8');
            assert.equal(readSnapshotCache(cachePath), null);
        });

        it('returns null for current-version snapshots without changed file stats', () => {
            const cachePath = path.join(tempDir, 'missing-stats.json');
            fs.writeFileSync(cachePath, JSON.stringify({
                cache_version: 6,
                fingerprint: 'a'.repeat(64),
                snapshot: {
                    detection_source: 'git_auto',
                    use_staged: false,
                    include_untracked: true,
                    changed_files: ['file.ts'],
                    changed_files_count: 1,
                    ignored_generated_runtime_files: [],
                    ignored_generated_runtime_files_count: 0,
                    additions_total: 1,
                    deletions_total: 0,
                    changed_lines_total: 1,
                    changed_files_sha256: 'deadbeef',
                    scope_content_sha256: 'feedface',
                    scope_sha256: 'cafebabe'
                },
                params: {
                    repo_root: '/repo',
                    detection_source: 'git_auto',
                    include_untracked: true,
                    explicit_changed_files_hash: null
                },
                git_state: {
                    head_sha: 'abc',
                    index_mtime_ms: 12345,
                    index_size: 678
                }
            }), 'utf8');
            assert.equal(readSnapshotCache(cachePath), null);
        });
    });

    describe('getWorkspaceSnapshotCached', () => {
        it('returns a correct snapshot on first call (cache miss)', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(result.cache_hit, false);
            assert.ok(result.changed_files.includes('file.ts'));
            assert.equal(result.changed_files_count, 1);
            assert.ok(result.changed_lines_total > 0);
        });

        it('returns cache_hit=true on second call with no state change', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const first = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(first.cache_hit, false);

            const second = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(second.cache_hit, true);
            assert.deepEqual(second.changed_files, first.changed_files);
            assert.equal(second.changed_lines_total, first.changed_lines_total);
            assert.equal(second.scope_sha256, first.scope_sha256);
        });

        it('rejects a forged persisted snapshot payload and recomputes canonical scope', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const expected = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            const cachePath = resolveSnapshotCachePath(repoRoot);
            const persisted = readSnapshotCache(cachePath);
            assert.ok(persisted);
            invalidateSnapshotCache(repoRoot);

            const forged = structuredClone(persisted) as WorkspaceSnapshotCacheEntry;
            forged.snapshot.changed_file_stats['file.ts'].additions += 10;
            forged.snapshot.changed_file_stats['file.ts'].changed_lines += 10;
            forged.snapshot.additions_total += 10;
            forged.snapshot.changed_lines_total += 10;
            forged.snapshot.scope_content_sha256 = 'f'.repeat(64);
            forged.snapshot.scope_sha256 = createHash('sha256').update([
                forged.snapshot.detection_source,
                forged.snapshot.use_staged,
                forged.snapshot.include_untracked,
                forged.snapshot.changed_files_count,
                forged.snapshot.changed_lines_total,
                forged.snapshot.changed_files_sha256,
                forged.snapshot.scope_content_sha256
            ].join('|')).digest('hex');
            recomputeAttackerControlledHashes(forged);
            writeSnapshotCache(cachePath, forged);

            const resolved = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(resolved.cache_hit, false);
            assert.deepEqual(resolved.changed_file_stats, expected.changed_file_stats);
            assert.equal(resolved.scope_sha256, expected.scope_sha256);
        });

        it('rejects persisted cache entries with mismatched request parameters or scope bindings', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            const cachePath = resolveSnapshotCachePath(repoRoot);
            const persisted = readSnapshotCache(cachePath);
            assert.ok(persisted);
            invalidateSnapshotCache(repoRoot);

            const mismatchedParams = structuredClone(persisted) as WorkspaceSnapshotCacheEntry;
            mismatchedParams.params.detection_source = 'explicit_changed_files';
            writeSnapshotCache(cachePath, mismatchedParams);
            const afterParamsMismatch = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(afterParamsMismatch.cache_hit, false);

            const refreshed = readSnapshotCache(cachePath);
            assert.ok(refreshed);
            invalidateSnapshotCache(repoRoot);
            const mismatchedScope = structuredClone(refreshed) as WorkspaceSnapshotCacheEntry;
            mismatchedScope.snapshot.scope_sha256 = '0'.repeat(64);
            writeSnapshotCache(cachePath, mismatchedScope);
            const afterScopeMismatch = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(afterScopeMismatch.cache_hit, false);
            assert.notEqual(afterScopeMismatch.scope_sha256, '0'.repeat(64));
        });

        it('rejects a stale persisted workspace generation without TTL authority', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const stale = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            const cachePath = resolveSnapshotCachePath(repoRoot);
            const persisted = readSnapshotCache(cachePath);
            assert.ok(persisted);
            invalidateSnapshotCache(repoRoot);
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 3;\n', 'utf8');
            writeSnapshotCache(cachePath, persisted);

            const current = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(current.cache_hit, false);
            assert.notEqual(current.scope_content_sha256, stale.scope_content_sha256);
        });

        it('rejects workspace mutation between fingerprint and snapshot generation', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const childProcessModule = require('node:child_process') as typeof import('node:child_process');
            const originalSpawnSync = childProcessModule.spawnSync;
            const originalExecFileSync = childProcessModule.execFileSync;
            let mutationInjected = false;
            const injectMutationBeforeGitConfig = (command: string, args: readonly string[]): void => {
                if (command === 'git' && args.includes('config') && !mutationInjected) {
                    mutationInjected = true;
                    fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 3;\n', 'utf8');
                }
            };
            childProcessModule.spawnSync = ((command: string, args: string[], options: unknown) => {
                injectMutationBeforeGitConfig(command, args);
                return originalSpawnSync(command, args, options as never);
            }) as typeof originalSpawnSync;
            childProcessModule.execFileSync = ((command: string, args: string[], options: unknown) => {
                injectMutationBeforeGitConfig(command, args);
                return originalExecFileSync(command, args, options as never);
            }) as typeof originalExecFileSync;
            try {
                assert.throws(
                    () => getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []),
                    /generation changed during authenticated snapshot resolution/u
                );
                assert.equal(mutationInjected, true);
                assert.equal(readSnapshotCache(resolveSnapshotCachePath(repoRoot)), null);
            } finally {
                childProcessModule.spawnSync = originalSpawnSync;
                childProcessModule.execFileSync = originalExecFileSync;
            }
        });

        it('invalidates cache when file is staged', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const first = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(first.cache_hit, false);

            // Stage the file — changes git index
            execFileSync('git', ['-C', repoRoot, 'add', 'file.ts'], { stdio: 'ignore' });

            const second = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(second.cache_hit, false);
        });

        it('invalidates cache when tracked worktree content changes without staging', () => {
            const first = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(first.cache_hit, false);

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 3;\n', 'utf8');

            const second = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(second.cache_hit, false);
            assert.ok(second.changed_files.includes('file.ts'));
            assert.ok(second.changed_lines_total > 0);
        });

        it('invalidates cache when HEAD changes', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);

            execFileSync('git', ['-C', repoRoot, 'add', '.'], { stdio: 'ignore' });
            execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'change'], { stdio: 'ignore' });

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(result.cache_hit, false);
        });

        it('invalidates cache when parameters change', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            assert.equal(result.cache_hit, false);
        });

        it('keeps multiple parameter variants hot within one process', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const firstVariant = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            const secondVariant = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);

            const firstVariantAgain = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);

            assert.equal(firstVariant.cache_hit, false);
            assert.equal(secondVariant.cache_hit, false);
            assert.equal(firstVariantAgain.cache_hit, true);
            assert.deepEqual(firstVariantAgain.changed_files, firstVariant.changed_files);
        });

        it('respects noCache option', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, [], { noCache: true });
            assert.equal(result.cache_hit, false);
        });

        it('respects readOnly option (does not write cache file)', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, [], { readOnly: true });

            const cachePath = resolveSnapshotCachePath(repoRoot);
            assert.equal(fs.existsSync(cachePath), false);
        });

        it('does not read or write cache files through symlinked cache directories outside repo', (t) => {
            const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-snap-cache-outside-'));
            try {
                const cachePath = resolveSnapshotCachePath(repoRoot);
                fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
                fs.mkdirSync(path.dirname(path.dirname(cachePath)), { recursive: true });
                try {
                    fs.symlinkSync(outsideRoot, path.dirname(cachePath), process.platform === 'win32' ? 'junction' : 'dir');
                } catch (error) {
                    t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                    return;
                }
                fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');

                const first = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
                const second = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);

                assert.equal(first.cache_hit, false);
                assert.equal(second.cache_hit, false);
                assert.equal(fs.existsSync(path.join(outsideRoot, 'workspace-snapshot.json')), false);
            } finally {
                fs.rmSync(outsideRoot, { recursive: true, force: true });
            }
        });

        it('includes untracked files when requested', () => {
            fs.writeFileSync(path.join(repoRoot, 'untracked.ts'), 'export const u = 1;\n', 'utf8');
            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            assert.ok(result.changed_files.includes('untracked.ts'));
        });

        it('ignores generated runtime artifacts from git-auto untracked scope', () => {
            const generatedRelativePaths = [
                'mnt/wsl/projects/missing/runtime/task-events/T-504.jsonl',
                'runtime/.runtime-mutation-generation.anchor.json',
                'runtime/.runtime-mutation-generation/head.json',
                'runtime/.runtime-mutation-generation/state-a.json',
                'runtime/.runtime-mutation-generation/state-b.json',
                'runtime/.runtime-mutation-generation.lock/owner.json',
                'runtime/.reviews-index.lock/owner.json',
                'runtime/.reviews-transaction.lock/owner.json'
            ];
            for (const generatedRelativePath of generatedRelativePaths) {
                const generatedPath = path.join(repoRoot, generatedRelativePath);
                fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
                fs.writeFileSync(generatedPath, '{"generated":true}\n', 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'untracked.ts'), 'export const u = 1;\n', 'utf8');

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);

            assert.deepEqual(result.changed_files, ['untracked.ts']);
            assert.equal(result.changed_files_count, 1);
            assert.deepEqual(result.ignored_generated_runtime_files, generatedRelativePaths.sort());
            assert.equal(result.ignored_generated_runtime_files_count, generatedRelativePaths.length);
        });

        it('prevents generated runtime filtering from hiding unrelated lock names and user-owned lookalikes', () => {
            const reviewableRelativePaths = [
                'runtime/.reviews-external.lock/owner.json',
                'src/runtime/.reviews-index.lock/owner.json',
                'src/runtime/.runtime-mutation-generation/state-a.json'
            ];
            for (const reviewableRelativePath of reviewableRelativePaths) {
                const reviewablePath = path.join(repoRoot, reviewableRelativePath);
                fs.mkdirSync(path.dirname(reviewablePath), { recursive: true });
                fs.writeFileSync(reviewablePath, '{"userOwned":true}\n', 'utf8');
            }

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);

            assert.deepEqual(result.changed_files, reviewableRelativePaths.sort());
            for (const reviewableRelativePath of reviewableRelativePaths) {
                assert.ok(!result.ignored_generated_runtime_files.includes(reviewableRelativePath));
            }
        });

        it('invalidates cache when untracked file content changes and includeUntracked=true', () => {
            fs.writeFileSync(path.join(repoRoot, 'untracked.ts'), 'line one\n', 'utf8');
            const first = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            assert.equal(first.cache_hit, false);

            fs.writeFileSync(path.join(repoRoot, 'untracked.ts'), 'line one\nline two\nline three\n', 'utf8');
            const second = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            assert.equal(second.cache_hit, false);
            assert.ok(second.changed_lines_total > first.changed_lines_total);
        });

        it('excludes untracked files when not requested', () => {
            fs.writeFileSync(path.join(repoRoot, 'untracked.ts'), 'export const u = 1;\n', 'utf8');
            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.ok(!result.changed_files.includes('untracked.ts'));
        });

        it('handles explicit_changed_files detection source', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const result = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['nested/../file.ts']);
            assert.equal(result.cache_hit, false);
            assert.ok(result.changed_files.includes('file.ts'));
            assert.ok((result.changed_file_stats['file.ts']?.changed_lines || 0) > 0);
            assert.equal(result.detection_source, 'explicit_changed_files');
        });

        it('preserves explicit task-owned ignored workflow-config files without widening git-auto scope', () => {
            const workflowConfigRelativePath = 'garda-agent-orchestrator/live/config/workflow-config.json';
            const workflowConfigPath = path.join(repoRoot, ...workflowConfigRelativePath.split('/'));
            fs.mkdirSync(path.dirname(workflowConfigPath), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, '.gitignore'), `${workflowConfigRelativePath}\n`, 'utf8');
            fs.writeFileSync(workflowConfigPath, JSON.stringify({ full_suite_validation: { timeout_ms: 1000 } }, null, 2) + '\n', 'utf8');

            const automatic = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            assert.equal(automatic.changed_files.includes(workflowConfigRelativePath), false);

            const explicit = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', true, [workflowConfigRelativePath]);
            assert.equal(explicit.cache_hit, false);
            assert.deepEqual(explicit.changed_files, [workflowConfigRelativePath]);
            assert.equal(explicit.changed_files_count, 1);
            assert.equal(explicit.ignored_generated_runtime_files_count, 0);

            fs.writeFileSync(workflowConfigPath, JSON.stringify({ full_suite_validation: { timeout_ms: 2000 } }, null, 2) + '\n', 'utf8');
            const refreshed = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', true, [workflowConfigRelativePath]);
            assert.equal(refreshed.cache_hit, false);
            assert.deepEqual(refreshed.changed_files, [workflowConfigRelativePath]);
            assert.equal(refreshed.changed_files_sha256, explicit.changed_files_sha256);
            assert.notEqual(refreshed.scope_content_sha256, explicit.scope_content_sha256);
            assert.notEqual(refreshed.scope_sha256, explicit.scope_sha256);
        });

        it('invalidates explicit_changed_files cache when explicit file content changes', () => {
            const first = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['file.ts']);
            assert.equal(first.cache_hit, false);

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 99;\n', 'utf8');

            const second = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['file.ts']);
            assert.equal(second.cache_hit, false);
            assert.ok(second.changed_files.includes('file.ts'));
        });

        it('changes scope hash when file content changes without changing line totals', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const first = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['file.ts']);
            assert.equal(first.cache_hit, false);

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 3;\n', 'utf8');
            const future = new Date(Date.now() + 1000);
            fs.utimesSync(path.join(repoRoot, 'file.ts'), future, future);

            const second = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['file.ts']);
            assert.equal(second.cache_hit, false);
            assert.equal(second.changed_lines_total, first.changed_lines_total);
            assert.equal(second.changed_files_sha256, first.changed_files_sha256);
            assert.notEqual(second.scope_content_sha256, first.scope_content_sha256);
            assert.notEqual(second.scope_sha256, first.scope_sha256);
        });

        it('invalidates explicit_changed_files cache when same-size content changes with restored mtime', () => {
            const filePath = path.join(repoRoot, 'file.ts');
            fs.writeFileSync(filePath, 'export const a = 2;\n', 'utf8');
            const first = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['file.ts']);
            assert.equal(first.cache_hit, false);
            const stat = fs.statSync(filePath);

            fs.writeFileSync(filePath, 'export const b = 2;\n', 'utf8');
            fs.utimesSync(filePath, stat.atime, stat.mtime);

            const second = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['file.ts']);
            assert.equal(second.cache_hit, false);
            assert.equal(second.changed_files_sha256, first.changed_files_sha256);
            assert.notEqual(second.scope_content_sha256, first.scope_content_sha256);
            assert.notEqual(second.scope_sha256, first.scope_sha256);
        });

        it('cached result matches fresh result for same state', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');

            const fresh = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, [], { noCache: true });
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            // Second call should hit cache (after first wrote it)
            const fromCache = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);

            assert.deepEqual(fromCache.changed_files, fresh.changed_files);
            assert.equal(fromCache.changed_lines_total, fresh.changed_lines_total);
            assert.equal(fromCache.scope_sha256, fresh.scope_sha256);
            assert.equal(fromCache.changed_files_sha256, fresh.changed_files_sha256);
        });

        it('does not rerun the full canonical classifier on a cache hit', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const first = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            assert.equal(first.cache_hit, false);

            mock.method(gitChangeClassification, 'classifyGitChanges', () => {
                throw new Error('full classifier must not run while validating a cache hit');
            });
            try {
                const second = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
                assert.equal(second.cache_hit, true);
            } finally {
                mock.restoreAll();
            }
        });
    });

    describe('invalidateSnapshotCache', () => {
        it('removes existing cache file', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);

            const cachePath = resolveSnapshotCachePath(repoRoot);
            assert.ok(fs.existsSync(cachePath));

            const removed = invalidateSnapshotCache(repoRoot);
            assert.equal(removed, true);
            assert.equal(fs.existsSync(cachePath), false);
        });

        it('returns false when no cache file exists', () => {
            const removed = invalidateSnapshotCache(repoRoot);
            assert.equal(removed, false);
        });

        it('forces fresh computation on next call', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);

            invalidateSnapshotCache(repoRoot);

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(result.cache_hit, false);
        });
    });

    describe('edge cases', () => {
        it('handles repo with spaces in path', () => {
            const spacedDir = path.join(tempDir, 'repo with spaces');
            fs.mkdirSync(spacedDir, { recursive: true });
            execFileSync('git', ['init', spacedDir], { stdio: 'ignore' });
            execFileSync('git', ['-C', spacedDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
            execFileSync('git', ['-C', spacedDir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' });
            fs.writeFileSync(path.join(spacedDir, 'app.ts'), 'export const x = 1;\n', 'utf8');
            execFileSync('git', ['-C', spacedDir, 'add', '.'], { stdio: 'ignore' });
            execFileSync('git', ['-C', spacedDir, 'commit', '-m', 'init'], { stdio: 'ignore' });

            fs.writeFileSync(path.join(spacedDir, 'app.ts'), 'export const x = 2;\n', 'utf8');
            const result = getWorkspaceSnapshotCached(spacedDir, 'git_auto', false, []);
            assert.equal(result.cache_hit, false);
            assert.ok(result.changed_files.includes('app.ts'));

            const cached = getWorkspaceSnapshotCached(spacedDir, 'git_auto', false, []);
            assert.equal(cached.cache_hit, true);
        });

        it('handles empty workspace (no changes)', () => {
            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(result.changed_files_count, 0);
            assert.equal(result.changed_lines_total, 0);

            const cached = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(cached.cache_hit, true);
            assert.equal(cached.changed_files_count, 0);
        });

        it('handles staged-only detection source', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', 'file.ts'], { stdio: 'ignore' });

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(result.detection_source, 'git_staged_only');
            assert.equal(result.use_staged, true);
            assert.ok(result.changed_files.includes('file.ts'));

            const cached = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(cached.cache_hit, true);
        });

        it('ignores generated runtime artifacts from staged snapshot scope', () => {
            const generatedRelativePath = 'garda-agent-orchestrator/runtime/task-events/T-504.jsonl';
            const generatedPath = path.join(repoRoot, ...generatedRelativePath.split('/'));
            fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
            fs.writeFileSync(generatedPath, '{"event_type":"BASELINE"}\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', generatedRelativePath], { stdio: 'ignore' });
            execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'track generated artifact fixture'], { stdio: 'ignore' });

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            fs.writeFileSync(generatedPath, '{"event_type":"GENERATED"}\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', 'file.ts', generatedRelativePath], { stdio: 'ignore' });

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);

            assert.equal(result.detection_source, 'git_staged_only');
            assert.equal(result.use_staged, true);
            assert.deepEqual(result.changed_files, ['file.ts']);
            assert.equal(result.changed_files_count, 1);
            assert.deepEqual(result.ignored_generated_runtime_files, [generatedRelativePath]);
            assert.equal(result.ignored_generated_runtime_files_count, 1);
        });

        it('invalidates staged-only cache for staged deletions when the path is recreated untracked', () => {
            const clean = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(clean.changed_files_count, 0);

            execFileSync('git', ['-C', repoRoot, 'rm', 'file.ts'], { stdio: 'ignore' });
            const deleted = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(deleted.cache_hit, false);
            assert.deepEqual(deleted.changed_files, ['file.ts']);
            assert.equal(deleted.additions_total, 0);
            assert.equal(deleted.deletions_total, 1);

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(result.cache_hit, false);
            assert.deepEqual(result.changed_files, ['file.ts']);
            assert.equal(result.additions_total, 0);
            assert.equal(result.deletions_total, 1);

            const cached = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(cached.cache_hit, true);
            assert.deepEqual(cached.changed_files, ['file.ts']);
        });

        it('fails closed when staged-plus-untracked cache status fingerprint git probes fail', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', 'file.ts'], { stdio: 'ignore' });
            const first = getWorkspaceSnapshotCached(repoRoot, 'git_staged_plus_untracked', true, []);
            assert.equal(first.cache_hit, false);

            fs.writeFileSync(path.join(repoRoot, 'untracked.ts'), 'export const u = 1;\n', 'utf8');
            fs.renameSync(path.join(repoRoot, '.git'), path.join(repoRoot, '.git-offline'));
            assert.throws(
                () => getWorkspaceSnapshotCached(repoRoot, 'git_staged_plus_untracked', true, []),
                /git --no-pager status .* failed/
            );
        });

        it('keeps staged-only cache hit when only unstaged tracked changes appear later', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', 'file.ts'], { stdio: 'ignore' });

            const first = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(first.cache_hit, false);

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 3;\n', 'utf8');

            const second = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(second.cache_hit, true);
            assert.equal(second.changed_lines_total, first.changed_lines_total);
            assert.deepEqual(second.changed_files, first.changed_files);
        });

        it('survives corrupt cache file gracefully', () => {
            const cachePath = resolveSnapshotCachePath(repoRoot);
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            fs.writeFileSync(cachePath, '{{{{not json', 'utf8');

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(result.cache_hit, false);
            assert.ok(result.changed_files.includes('file.ts'));
        });
    });
});
