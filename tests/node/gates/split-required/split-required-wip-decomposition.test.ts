import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    captureAndSuspendSplitRequiredWip,
    restoreSplitRequiredWip
} from '../../../../src/gates/split-required/split-required-wip';
import { suspendSplitRequiredWipBeforeDecomposition } from '../../../../src/gates/next-step/next-step-split-required-latch';

const TASK_ID = 'T-DECOMP-WIP';
const PARENT_PATHS = ['src/a.ts', 'src/b.ts', 'src/new.ts'];
const PRIVATE_PATH = 'garda-agent-orchestrator/runtime/tmp/T-DECOMP-WIP-input.json';

function git(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

function write(repoRoot: string, relativePath: string, value: string): void {
    fs.mkdirSync(path.dirname(path.join(repoRoot, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, relativePath), value);
}

function fixture() {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-decomp-wip-'));
    git(repoRoot, ['init']);
    git(repoRoot, ['config', 'user.email', 'test@example.invalid']);
    git(repoRoot, ['config', 'user.name', 'Test User']);
    git(repoRoot, ['config', 'core.autocrlf', 'false']);
    write(repoRoot, '.gitignore', 'garda-agent-orchestrator/runtime/\n');
    write(repoRoot, 'src/a.ts', 'export const a = 1;\n');
    write(repoRoot, 'src/b.ts', 'export const b = 1;\n');
    write(repoRoot, 'src/repair.ts', 'export const repair = 1;\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'initial']);
    write(repoRoot, 'src/a.ts', 'export const a = 2;\n');
    write(repoRoot, 'src/b.ts', 'export const b = 2;\n');
    write(repoRoot, 'src/new.ts', 'export const created = 1;\n');
    write(repoRoot, PRIVATE_PATH, '{"owned":true}\n');
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
    const preflightPath = path.join(reviewsRoot, TASK_ID + '-preflight.json');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(preflightPath, JSON.stringify({ task_id: TASK_ID, changed_files: PARENT_PATHS }));
    return { repoRoot, reviewsRoot, preflightPath };
}

function capture(fx: ReturnType<typeof fixture>) {
    const result = captureAndSuspendSplitRequiredWip({
        repoRoot: fx.repoRoot, taskId: TASK_ID, preflightPath: fx.preflightPath,
        guardKind: 'review_cycle', guardReason: 'parent review-cycle limit'
    });
    assert.equal(result.status, 'CAPTURED', result.violations.join('\n'));
    assert.ok(result.manifest_path);
    return { ...fx, manifestPath: result.manifest_path };
}

function restore(fx: ReturnType<typeof capture>, includePaths: string[]) {
    return restoreSplitRequiredWip({
        repoRoot: fx.repoRoot, taskId: TASK_ID, manifestPath: fx.manifestPath, includePaths
    });
}

function decompose(fx: ReturnType<typeof fixture>) {
    return suspendSplitRequiredWipBeforeDecomposition({
        repoRoot: fx.repoRoot, reviewsRoot: fx.reviewsRoot, taskId: TASK_ID,
        latchEvidence: { valid: true, reason: 'fixture', artifact_path: '', artifact_sha256: null, guard_kind: 'review_cycle' }
    });
}

function partialFixture() {
    const fx = capture(fixture());
    const result = restore(fx, ['src/a.ts', 'src/new.ts']);
    assert.equal(result.status, 'RESTORED', result.violations.join('\n'));
    return fx;
}

function cleanup(repoRoot: string): void {
    assert.ok(path.resolve(repoRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

describe('retained WIP decomposition and selected restore', () => {
    it('reuses partially restored parent WIP while private artifacts remain suspended', (context) => {
        const fx = partialFixture();
        context.after(() => cleanup(fx.repoRoot));
        const before = fs.readFileSync(fx.manifestPath);
        const result = decompose(fx);
        assert.equal(result.status, 'ALREADY_CAPTURED', result.violations.join('\n'));
        assert.equal(result.manifest_path, fx.manifestPath);
        assert.deepEqual(fs.readFileSync(fx.manifestPath), before);
        assert.equal(fs.readFileSync(path.join(fx.repoRoot, 'src/a.ts'), 'utf8'), 'export const a = 2;\n');
        assert.equal(fs.readFileSync(path.join(fx.repoRoot, 'src/b.ts'), 'utf8'), 'export const b = 1;\n');
        assert.ok(!fs.existsSync(path.join(fx.repoRoot, PRIVATE_PATH)));
    });

    it('preserves unrelated staged, unstaged and untracked work during decomposition', (context) => {
        const fx = partialFixture();
        context.after(() => cleanup(fx.repoRoot));
        write(fx.repoRoot, 'src/repair.ts', 'export const repair = 2;\n');
        git(fx.repoRoot, ['add', 'src/repair.ts']);
        write(fx.repoRoot, 'src/repair.ts', 'export const repair = 3;\n');
        write(fx.repoRoot, 'scratch.txt', 'foreign work\n');
        const before = git(fx.repoRoot, ['diff', '--binary', '--cached']) + git(fx.repoRoot, ['diff', '--binary']);
        const result = decompose(fx);
        assert.equal(result.status, 'ALREADY_CAPTURED', result.violations.join('\n'));
        assert.equal(git(fx.repoRoot, ['diff', '--binary', '--cached']) + git(fx.repoRoot, ['diff', '--binary']), before);
        assert.equal(fs.readFileSync(path.join(fx.repoRoot, 'scratch.txt'), 'utf8'), 'foreign work\n');
    });

    it('reuses a fully suspended parent capture even after an unrelated repair', (context) => {
        const fx = capture(fixture());
        context.after(() => cleanup(fx.repoRoot));
        write(fx.repoRoot, 'src/repair.ts', 'export const repair = 2;\n');
        const result = decompose(fx);
        assert.equal(result.status, 'ALREADY_CAPTURED', result.violations.join('\n'));
        assert.equal(fs.readFileSync(path.join(fx.repoRoot, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
    });

    it('keeps ordinary capture strict for a partial restored checkout', (context) => {
        const fx = partialFixture();
        context.after(() => cleanup(fx.repoRoot));
        const result = captureAndSuspendSplitRequiredWip({
            repoRoot: fx.repoRoot, taskId: TASK_ID, preflightPath: fx.preflightPath,
            guardKind: 'review_cycle', guardReason: 'ordinary capture'
        });
        assert.equal(result.status, 'BLOCKED');
    });

    for (const target of ['src/a.ts', 'src/new.ts']) {
        it('rejects drift in restored parent content: ' + target, (context) => {
            const fx = partialFixture();
            context.after(() => cleanup(fx.repoRoot));
            write(fx.repoRoot, target, 'changed after restoration\n');
            const result = decompose(fx);
            assert.equal(result.status, 'BLOCKED');
            assert.equal(fs.readFileSync(path.join(fx.repoRoot, target), 'utf8'), 'changed after restoration\n');
        });
    }

    it('rejects staging drift in a previously restored parent file', (context) => {
        const fx = partialFixture();
        context.after(() => cleanup(fx.repoRoot));
        git(fx.repoRoot, ['add', 'src/a.ts']);
        const result = decompose(fx);
        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some(v => v.includes('index differs')));
    });

    it('rejects modified retained patch bytes', (context) => {
        const fx = partialFixture();
        context.after(() => cleanup(fx.repoRoot));
        const manifest = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
        fs.appendFileSync(manifest.patches.unstaged.path, 'tampered\n');
        const result = decompose(fx);
        assert.equal(result.status, 'BLOCKED');
    });

    it('rejects a modified capture manifest even when its new content parses', (context) => {
        const fx = partialFixture();
        context.after(() => cleanup(fx.repoRoot));
        const manifest = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
        manifest.guard_reason = 'tampered capture';
        fs.writeFileSync(fx.manifestPath, JSON.stringify(manifest));
        assert.equal(decompose(fx).status, 'BLOCKED');
    });

    it('rejects a corrupted parent event timeline', (context) => {
        const fx = partialFixture();
        context.after(() => cleanup(fx.repoRoot));
        const eventFile = path.join(fx.repoRoot, 'garda-agent-orchestrator/runtime/task-events', TASK_ID + '.jsonl');
        fs.appendFileSync(eventFile, 'invalid-json\n');
        assert.equal(decompose(fx).status, 'BLOCKED');
    });

    it('rejects a changed HEAD instead of treating it as the original capture', (context) => {
        const fx = partialFixture();
        context.after(() => cleanup(fx.repoRoot));
        git(fx.repoRoot, ['commit', '--allow-empty', '-m', 'head changed']);
        assert.equal(decompose(fx).status, 'BLOCKED');
    });

    it('rejects an obstruction in a suspended private artifact path', (context) => {
        const fx = partialFixture();
        context.after(() => cleanup(fx.repoRoot));
        fs.mkdirSync(path.join(fx.repoRoot, PRIVATE_PATH), { recursive: true });
        assert.equal(decompose(fx).status, 'BLOCKED');
    });

    it('falls back to normal capture when no retained manifest exists', (context) => {
        const fx = fixture();
        context.after(() => cleanup(fx.repoRoot));
        const result = decompose(fx);
        assert.equal(result.status, 'CAPTURED', result.violations.join('\n'));
    });

    it('restores an explicit subset beside unrelated work and preserves earlier restored files', (context) => {
        const fx = partialFixture();
        context.after(() => cleanup(fx.repoRoot));
        write(fx.repoRoot, 'src/repair.ts', 'export const repair = 2;\n');
        git(fx.repoRoot, ['add', 'src/repair.ts']);
        write(fx.repoRoot, 'src/repair.ts', 'export const repair = 3;\n');
        write(fx.repoRoot, 'scratch.txt', 'foreign\n');
        const indexBefore = git(fx.repoRoot, ['show', ':src/repair.ts']);
        const preview = restoreSplitRequiredWip({
            repoRoot: fx.repoRoot, taskId: TASK_ID, manifestPath: fx.manifestPath,
            includePaths: ['src/b.ts'], dryRun: true
        });
        assert.equal(preview.status, 'DRY_RUN_OK', preview.violations.join('\n'));
        assert.equal(fs.readFileSync(path.join(fx.repoRoot, 'src/b.ts'), 'utf8'), 'export const b = 1;\n');
        const result = restore(fx, ['src/b.ts']);
        assert.equal(result.status, 'RESTORED', result.violations.join('\n'));
        assert.equal(fs.readFileSync(path.join(fx.repoRoot, 'src/b.ts'), 'utf8'), 'export const b = 2;\n');
        assert.equal(fs.readFileSync(path.join(fx.repoRoot, 'src/a.ts'), 'utf8'), 'export const a = 2;\n');
        assert.equal(fs.readFileSync(path.join(fx.repoRoot, 'src/repair.ts'), 'utf8'), 'export const repair = 3;\n');
        assert.equal(git(fx.repoRoot, ['show', ':src/repair.ts']), indexBefore);
        assert.equal(fs.readFileSync(path.join(fx.repoRoot, 'scratch.txt'), 'utf8'), 'foreign\n');
    });

    it('rejects dirt in the explicitly selected restore target without overwriting it', (context) => {
        const fx = partialFixture();
        context.after(() => cleanup(fx.repoRoot));
        write(fx.repoRoot, 'src/repair.ts', 'foreign\n');
        write(fx.repoRoot, 'src/b.ts', 'selected target changed\n');
        const result = restore(fx, ['src/b.ts']);
        assert.equal(result.status, 'BLOCKED');
        assert.equal(fs.readFileSync(path.join(fx.repoRoot, 'src/b.ts'), 'utf8'), 'selected target changed\n');
    });

    it('keeps full restore strict for unrelated tracked changes', (context) => {
        const fx = capture(fixture());
        context.after(() => cleanup(fx.repoRoot));
        write(fx.repoRoot, 'src/repair.ts', 'foreign\n');
        const result = restoreSplitRequiredWip({ repoRoot: fx.repoRoot, taskId: TASK_ID, manifestPath: fx.manifestPath });
        assert.equal(result.status, 'BLOCKED');
        assert.equal(fs.readFileSync(path.join(fx.repoRoot, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
    });


    for (const args of [['add', 'src/new.ts'], ['add', '-N', 'src/new.ts']]) {
        it('rejects parent-owned untracked index drift: ' + args.join(' '), (context) => {
            const fx = partialFixture();
            context.after(() => cleanup(fx.repoRoot));
            git(fx.repoRoot, args);
            assert.equal(decompose(fx).status, 'BLOCKED');
            const preview = restoreSplitRequiredWip({
                repoRoot: fx.repoRoot, taskId: TASK_ID, manifestPath: fx.manifestPath,
                includePaths: ['src/b.ts'], dryRun: true
            });
            assert.equal(preview.status, 'BLOCKED');
            assert.equal(fs.readFileSync(path.join(fx.repoRoot, 'src/b.ts'), 'utf8'), 'export const b = 1;\n');
        });
    }

    for (const operation of ['addition', 'rename']) {
        it('rejects an untracked obstruction at a suspended staged ' + operation, (context) => {
            const base = fixture();
            context.after(() => cleanup(base.repoRoot));
            const target = 'src/added.ts';
            if (operation === 'rename') {
                // Capture both rename endpoints; Git's rename display must not hide the source deletion.
                git(base.repoRoot, ['config', 'diff.renames', 'false']);
                git(base.repoRoot, ['mv', 'src/a.ts', target]);
            }
            else {
                write(base.repoRoot, target, 'export const added = 1;\n');
                git(base.repoRoot, ['add', target]);
            }
            fs.writeFileSync(base.preflightPath, JSON.stringify({ task_id: TASK_ID, changed_files: [...PARENT_PATHS, target] }));
            const fx = capture(base);
            const restored = restore(fx, ['src/b.ts', 'src/new.ts']);
            assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
            write(fx.repoRoot, target, 'foreign obstruction\n');
            assert.equal(decompose(fx).status, 'BLOCKED');
            assert.equal(fs.readFileSync(path.join(fx.repoRoot, target), 'utf8'), 'foreign obstruction\n');
        });
    }

    for (const changedWorkspaceRead of [1, 2]) {
    it('rejects an artifact modified during workspace read ' + changedWorkspaceRead, (context) => {
        const fx = partialFixture();
        context.after(() => cleanup(fx.repoRoot));
        const manifest = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
        const readers = require('../../../../src/gates/split-required/split-required-wip-restore-plan') as typeof import('../../../../src/gates/split-required/split-required-wip-restore-plan');
        const original = readers.readAuthenticatedRepoFileSnapshot;
        let mutated = false;
        let workspaceReads = 0;
        readers.readAuthenticatedRepoFileSnapshot = (...args: Parameters<typeof original>) => {
            if (args[1] === 'src/a.ts') {
                workspaceReads += 1;
                if (workspaceReads === changedWorkspaceRead) {
                    fs.appendFileSync(manifest.patches.unstaged.path, 'changed mid-inspection\n');
                    mutated = true;
                }
            }
            return original(...args);
        };
        let result: ReturnType<typeof decompose>;
        try { result = decompose(fx); }
        finally { readers.readAuthenticatedRepoFileSnapshot = original; }
        assert.ok(mutated);
        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some(v => v.includes('artifact')));
    });
    }

    it('reconstructs the captured index from immutable staged patch bytes', (context) => {
        const base = fixture();
        git(base.repoRoot, ['add', 'src/a.ts']);
        const fx = capture(base);
        context.after(() => cleanup(fx.repoRoot));
        const restored = restore(fx, ['src/a.ts', 'src/new.ts']);
        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        const manifest = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
        const patchPath = manifest.patches.staged.path;
        const originalPatch = fs.readFileSync(patchPath, 'utf8');
        const readers = require('../../../../src/gates/split-required/split-required-wip-restore-plan') as typeof import('../../../../src/gates/split-required/split-required-wip-restore-plan');
        const original = readers.readAuthenticatedRepoFileSnapshot;
        let reads = 0;
        readers.readAuthenticatedRepoFileSnapshot = (...args: Parameters<typeof original>) => {
            if (args[1] === 'src/a.ts') {
                reads += 1;
                if (reads === 1) {
                    const objectId = childProcess.execFileSync('git', ['-C', fx.repoRoot, 'hash-object', '-w', '--stdin'], {
                        input: 'export const a = 3;\n', encoding: 'utf8', stdio: 'pipe'
                    }).trim();
                    git(fx.repoRoot, ['update-index', '--cacheinfo', '100644,' + objectId + ',src/a.ts']);
                    const altered = originalPatch.replace('+export const a = 2;', '+export const a = 3;')
                        .replace(/(index [0-9a-f]+\.\.)([0-9a-f]+)/u, (_match, prefix: string, hash: string) => prefix + objectId.slice(0, hash.length));
                    fs.writeFileSync(patchPath, altered);
                } else if (reads === 2) fs.writeFileSync(patchPath, originalPatch);
            }
            return original(...args);
        };
        let result: ReturnType<typeof decompose>;
        try { result = decompose(fx); }
        finally {
            readers.readAuthenticatedRepoFileSnapshot = original;
            fs.writeFileSync(patchPath, originalPatch);
        }
        assert.ok(reads > 0);
        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some(v => v.includes('index differs')));
    });

    it('still rejects earlier restored-parent drift when restoring beside unrelated work', (context) => {
        const fx = partialFixture();
        context.after(() => cleanup(fx.repoRoot));
        write(fx.repoRoot, 'src/repair.ts', 'foreign\n');
        write(fx.repoRoot, 'src/a.ts', 'earlier restored content changed\n');
        assert.equal(restore(fx, ['src/b.ts']).status, 'BLOCKED');
        assert.equal(fs.readFileSync(path.join(fx.repoRoot, 'src/b.ts'), 'utf8'), 'export const b = 1;\n');
    });
});
