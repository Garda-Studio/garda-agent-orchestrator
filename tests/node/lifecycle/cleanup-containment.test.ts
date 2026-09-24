import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import fsNative from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    bindContainedDestination,
    removeBoundContainedPath,
    removeContainedPath,
    writeContainedFile
} from '../../../src/core/contained-filesystem';
import { installSignalHandlers, registerTempRoot, uninstallSignalHandlers } from '../../../src/cli/signal-handler';
import { acquireUpdateSource, cleanupOldUpdateTempRoots, getUpdateTempRoot } from '../../../src/lifecycle/check-update';
import { cloneGitUpdateSource } from '../../../src/lifecycle/update-git';
import { createWriteTextFileStage } from '../../../src/materialization/staged-side-effects';

describe('contained lifecycle cleanup', () => {
    it('preserves a substituted final directory when removal was bound to the original', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-remove-bound-'));
        try {
            const target = path.join(root, 'owned');
            fs.mkdirSync(target);
            const binding = bindContainedDestination(root, target);
            const moved = path.join(root, 'moved-owned');
            fs.renameSync(target, moved);
            fs.mkdirSync(target);
            fs.writeFileSync(path.join(target, 'foreign.txt'), 'foreign');

            assert.throws(() => removeBoundContainedPath(binding, true), /identity changed/);
            assert.equal(fs.readFileSync(path.join(target, 'foreign.txt'), 'utf8'), 'foreign');
            assert.equal(fs.existsSync(moved), true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects removal of the containment root through a Windows case variant', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-remove-root-case-'));
        try {
            const caseVariant = process.platform === 'win32' ? root.toUpperCase() : root;
            assert.throws(() => removeContainedPath(root, caseVariant, true), /containment root/);
            assert.equal(fs.existsSync(root), true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects a hard-linked descendant before deleting any sibling', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-remove-hardlink-'));
        try {
            const target = path.join(root, 'owned');
            fs.mkdirSync(target);
            fs.writeFileSync(path.join(target, 'safe.txt'), 'safe');
            const outside = path.join(root, 'outside.txt');
            fs.writeFileSync(outside, 'outside');
            fs.linkSync(outside, path.join(target, 'linked.txt'));

            assert.throws(() => removeContainedPath(root, target, true), /hard-linked/);
            assert.equal(fs.readFileSync(path.join(target, 'safe.txt'), 'utf8'), 'safe');
            assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects a junction descendant without changing its outside target', (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-remove-junction-'));
        try {
            const target = path.join(root, 'owned');
            const outside = path.join(root, 'outside');
            fs.mkdirSync(target);
            fs.mkdirSync(outside);
            fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside');
            try {
                fs.symlinkSync(outside, path.join(target, 'linked'), 'junction');
            } catch (error: unknown) {
                const code = (error as NodeJS.ErrnoException).code;
                if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code || '')) {
                    t.skip(`Junctions unavailable: ${code}`);
                    return;
                }
                throw error;
            }

            assert.throws(() => removeContainedPath(root, target, true), /symlink|junction/);
            assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('writes and recursively removes a valid in-root tree', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-remove-valid-'));
        try {
            const target = path.join(root, 'owned');
            const filePath = path.join(target, 'nested', 'file.txt');
            writeContainedFile(root, filePath, 'owned');
            assert.equal(fs.readFileSync(filePath, 'utf8'), 'owned');
            removeBoundContainedPath(bindContainedDestination(root, target), true);
            assert.equal(fs.existsSync(target), false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('treats repeated successful bound cleanup as complete', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-remove-repeat-'));
        try {
            const target = path.join(root, 'owned');
            fs.mkdirSync(target);
            const binding = bindContainedDestination(root, target);
            removeBoundContainedPath(binding, true);
            assert.doesNotThrow(() => removeBoundContainedPath(binding, true));
            assert.equal(fs.existsSync(target), false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('preserves a child replaced during directory enumeration', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-remove-enumeration-'));
        const originalReaddir = fsNative.readdirSync;
        try {
            const target = path.join(root, 'owned');
            fs.mkdirSync(target);
            const child = path.join(target, 'child.txt');
            fs.writeFileSync(child, 'original');
            const readdirMock = mock.method(fsNative, 'readdirSync', ((filePath: fs.PathLike, options?: unknown) => {
                const entries = originalReaddir(filePath, options as never);
                if (String(filePath) === target) {
                    fs.renameSync(child, path.join(root, 'original.txt'));
                    fs.writeFileSync(child, 'foreign');
                }
                return entries;
            }) as typeof fs.readdirSync);
            try {
                assert.throws(() => removeContainedPath(root, target, true), /directory changed during enumeration/);
            } finally {
                readdirMock.mock.restore();
            }
            assert.equal(fs.readFileSync(child, 'utf8'), 'foreign');
            assert.throws(() => removeContainedPath(root, target, true), /ambiguous previously rejected path/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('preserves a concurrently replaced descendant during recursive cleanup', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-remove-race-'));
        const originalUnlink = fsNative.unlinkSync;
        try {
            const target = path.join(root, 'owned');
            fs.mkdirSync(target);
            const first = path.join(target, 'a.txt');
            const second = path.join(target, 'b.txt');
            fs.writeFileSync(first, 'first');
            fs.writeFileSync(second, 'second');
            const unlinkMock = mock.method(fsNative, 'unlinkSync', (filePath: fs.PathLike) => {
                if (String(filePath) === first) {
                    fs.renameSync(second, path.join(root, 'original-b.txt'));
                    fs.writeFileSync(second, 'foreign');
                }
                return originalUnlink(filePath);
            });
            try {
                assert.throws(() => removeContainedPath(root, target, true), /identity changed/);
            } finally {
                unlinkMock.mock.restore();
            }
            assert.equal(fs.readFileSync(second, 'utf8'), 'foreign');
            assert.equal(fs.readFileSync(path.join(root, 'original-b.txt'), 'utf8'), 'second');
            assert.throws(() => removeContainedPath(root, target, true), /ambiguous previously rejected path/);
            assert.equal(fs.readFileSync(second, 'utf8'), 'foreign');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('update temporary cleanup', () => {
    it('preserves a replacement of a creator-owned npm candidate after enumeration', async () => {
        const deployedBundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-npm-owned-'));
        const originalReaddir = fsNative.readdirSync;
        let acquired: Awaited<ReturnType<typeof acquireUpdateSource>> | null = null;
        let replacedPath: string | null = null;
        try {
            acquired = await acquireUpdateSource({
                deployedBundleRoot,
                packageSpec: 'garda-agent-orchestrator@1.0.0',
                npmViewRunner() {
                    return { status: 0, stdout: JSON.stringify({
                        version: '1.0.0', 'dist.integrity': 'sha512-test'
                    }) };
                },
                async npmInstallRunner() {
                    return { cancelled: false, timedOut: false, exitCode: 0, stdout: '', stderr: '' };
                },
                installedPackageRootResolver(installRoot) {
                    return { packageName: 'garda-agent-orchestrator', packageRoot: installRoot };
                }
            });
            const candidate = acquired.sourceRoot;
            replacedPath = `${candidate}-original`;
            fs.utimesSync(candidate, new Date(0), new Date(0));
            const updateRoot = getUpdateTempRoot(path.join(deployedBundleRoot, 'runtime'));
            const readdirMock = mock.method(fsNative, 'readdirSync', ((filePath: fs.PathLike, options?: unknown) => {
                const entries = originalReaddir(filePath, options as never);
                if (String(filePath) === updateRoot) {
                    fs.renameSync(candidate, replacedPath!);
                    fs.mkdirSync(candidate);
                    fs.writeFileSync(path.join(candidate, 'foreign.txt'), 'foreign');
                    fs.utimesSync(candidate, new Date(0), new Date(0));
                }
                return entries;
            }) as typeof fs.readdirSync);
            try {
                assert.throws(() => cleanupOldUpdateTempRoots(path.join(deployedBundleRoot, 'runtime'), 1, Date.now()), /identity changed/);
            } finally {
                readdirMock.mock.restore();
            }
            assert.equal(fs.readFileSync(path.join(candidate, 'foreign.txt'), 'utf8'), 'foreign');
        } finally {
            if (replacedPath) fs.rmSync(replacedPath, { recursive: true, force: true });
            fs.rmSync(deployedBundleRoot, { recursive: true, force: true });
        }
    });

    it('preserves a replaced update-temp parent after its directory listing', () => {
        const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-npm-parent-'));
        const originalReaddir = fsNative.readdirSync;
        try {
            const updateRoot = getUpdateTempRoot(runtimeRoot);
            const candidate = path.join(updateRoot, 'npm-old');
            fs.mkdirSync(candidate, { recursive: true });
            fs.utimesSync(candidate, new Date(0), new Date(0));
            const readdirMock = mock.method(fsNative, 'readdirSync', ((filePath: fs.PathLike, options?: unknown) => {
                const entries = originalReaddir(filePath, options as never);
                if (String(filePath) === updateRoot) {
                    fs.renameSync(updateRoot, `${updateRoot}-original`);
                    fs.mkdirSync(candidate, { recursive: true });
                    fs.writeFileSync(path.join(candidate, 'foreign.txt'), 'foreign');
                    fs.utimesSync(candidate, new Date(0), new Date(0));
                }
                return entries;
            }) as typeof fs.readdirSync);
            try {
                assert.throws(() => cleanupOldUpdateTempRoots(runtimeRoot, 1, Date.now()), /identity changed/);
            } finally {
                readdirMock.mock.restore();
            }
            assert.equal(fs.readFileSync(path.join(candidate, 'foreign.txt'), 'utf8'), 'foreign');
        } finally {
            fs.rmSync(runtimeRoot, { recursive: true, force: true });
        }
    });

    it('rejects signal registration when the creator-owned root was replaced', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-signal-registration-'));
        try {
            const owned = path.join(root, 'owned');
            fs.mkdirSync(owned);
            const binding = bindContainedDestination(root, owned);
            fs.renameSync(owned, path.join(root, 'original'));
            fs.mkdirSync(owned);
            fs.writeFileSync(path.join(owned, 'foreign.txt'), 'foreign');
            assert.throws(() => registerTempRoot(owned, binding), /identity changed/);
            assert.equal(fs.readFileSync(path.join(owned, 'foreign.txt'), 'utf8'), 'foreign');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('signal cleanup preserves a replaced temporary root', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-signal-owned-'));
        const moved = `${tempRoot}-original`;
        const originalExit = process.exit;
        let exitCode: number | null = null;
        const priorListeners = process.listeners('SIGTERM');
        try {
            process.exit = ((code?: number) => {
                exitCode = code ?? null;
                return undefined as never;
            }) as typeof process.exit;
            installSignalHandlers();
            registerTempRoot(tempRoot);
            fs.renameSync(tempRoot, moved);
            fs.mkdirSync(tempRoot);
            fs.writeFileSync(path.join(tempRoot, 'foreign.txt'), 'foreign');
            const handler = process.listeners('SIGTERM').find((entry) => !priorListeners.includes(entry));
            assert.ok(handler);
            handler('SIGTERM');
            for (let attempt = 0; attempt < 100 && exitCode === null; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.equal(exitCode, 143);
            assert.equal(fs.readFileSync(path.join(tempRoot, 'foreign.txt'), 'utf8'), 'foreign');
            assert.equal(fs.existsSync(moved), true);
        } finally {
            process.exit = originalExit;
            uninstallSignalHandlers();
            fs.rmSync(tempRoot, { recursive: true, force: true });
            fs.rmSync(moved, { recursive: true, force: true });
        }
    });

    it('preserves an unowned old npm root containing a hard-linked file', () => {
        const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-old-npm-'));
        try {
            const candidate = path.join(getUpdateTempRoot(runtimeRoot), 'npm-old');
            fs.mkdirSync(candidate, { recursive: true });
            const outside = path.join(runtimeRoot, 'outside.txt');
            fs.writeFileSync(outside, 'outside');
            fs.linkSync(outside, path.join(candidate, 'linked.txt'));
            const now = Date.now();
            fs.utimesSync(candidate, new Date(now - 10_000), new Date(now - 10_000));

            assert.deepEqual(cleanupOldUpdateTempRoots(runtimeRoot, 5_000, now), []);
            assert.equal(fs.existsSync(candidate), true);
            assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
        } finally {
            fs.rmSync(runtimeRoot, { recursive: true, force: true });
        }
    });

    it('preserves a replaced Git clone root during cleanup', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cleanup-git-repo-'));
        let clonePath: string | null = null;
        let templateRoot: string | null = null;
        try {
            fs.writeFileSync(path.join(repoRoot, 'README.md'), 'fixture');
            childProcess.execFileSync('git', ['init', '-q'], { cwd: repoRoot });
            childProcess.execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
            childProcess.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                'commit', '-qm', 'fixture'], { cwd: repoRoot });
            const clone = await cloneGitUpdateSource(repoRoot, null);
            clonePath = clone.clonePath;
            templateRoot = String(clone.env.GIT_TEMPLATE_DIR);
            const moved = `${clonePath}-original`;
            fs.renameSync(clonePath, moved);
            fs.mkdirSync(clonePath);
            fs.writeFileSync(path.join(clonePath, 'foreign.txt'), 'foreign');

            assert.throws(() => clone.cleanup(), /identity changed/);
            assert.equal(fs.readFileSync(path.join(clonePath, 'foreign.txt'), 'utf8'), 'foreign');
            assert.equal(fs.existsSync(moved), true);
            fs.rmSync(moved, { recursive: true, force: true });
        } finally {
            if (clonePath) fs.rmSync(clonePath, { recursive: true, force: true });
            if (templateRoot) fs.rmSync(templateRoot, { recursive: true, force: true });
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});

describe('materialization rollback cleanup', () => {
    it('preserves a parent supplied after stage creation', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-stage-foreign-parent-'));
        const originalLstat = fsNative.lstatSync;
        try {
            const parent = path.join(root, 'foreign-parent');
            const target = path.join(parent, 'file.txt');
            const stage = createWriteTextFileStage(target, 'generated', root);
            let parentInspections = 0;
            const lstatMock = mock.method(fsNative, 'lstatSync', (filePath: fs.PathLike) => {
                if (String(filePath) === parent && ++parentInspections === 3) fs.mkdirSync(parent);
                return originalLstat(filePath);
            });
            try {
                stage.apply();
            } finally {
                lstatMock.mock.restore();
            }
            stage.rollback?.();
            assert.equal(fs.existsSync(parent), true);
            assert.equal(fs.existsSync(target), false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('preserves a substituted empty parent after removing the generated file', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-stage-cleanup-'));
        const originalRm = fsNative.rmSync;
        const originalUnlink = fsNative.unlinkSync;
        try {
            const parent = path.join(root, 'generated');
            const target = path.join(parent, 'file.txt');
            const stage = createWriteTextFileStage(target, 'generated', root);
            stage.apply();
            let substituted = false;
            const substitute = (filePath: fs.PathLike) => {
                if (String(filePath) === target && !substituted) {
                    substituted = true;
                    fs.renameSync(parent, path.join(root, 'original-parent'));
                    fs.mkdirSync(parent);
                }
            };
            const rmMock = mock.method(fsNative, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
                const result = originalRm(...args);
                substitute(args[0]);
                return result;
            });
            const unlinkMock = mock.method(fsNative, 'unlinkSync', (filePath: fs.PathLike) => {
                const result = originalUnlink(filePath);
                substitute(filePath);
                return result;
            });
            try {
                assert.throws(() => stage.rollback?.(), /identity changed/);
            } finally {
                rmMock.mock.restore();
                unlinkMock.mock.restore();
            }
            assert.equal(substituted, true);
            assert.equal(fs.existsSync(parent), true);
            assert.equal(fs.existsSync(path.join(root, 'original-parent')), true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
