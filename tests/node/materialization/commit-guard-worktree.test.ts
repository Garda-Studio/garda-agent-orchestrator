import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGit } from '../../../src/core/git-helpers';
import { applyCommitGuardHook, runInstall } from '../../../src/materialization/install';
import { COMMIT_GUARD_START } from '../../../src/materialization/content-builders';
import { findRepoRoot, setupTestWorkspace, writeInitAnswers } from './install-workspace-builder';

const gitOptions = { timeoutMs: 5000, maxBuffer: 64 * 1024 };

function git(root: string, args: string[]): string {
    return runGit(root, args, gitOptions).trim();
}

function withRepository(action: (root: string, linked: string) => void): void {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'garda hooks '));
    const root = path.join(temporary, 'ordinary clone');
    const linked = path.join(temporary, 'linked worktree');
    try {
        fs.mkdirSync(root);
        git(root, ['init', '--quiet']);
        git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=',
            'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
        git(root, ['worktree', 'add', '--quiet', '--detach', linked]);
        action(root, linked);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

function hookPath(root: string): string {
    return path.resolve(git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-commit']));
}

describe('commit guard Git worktree destinations', () => {
    it('installs and preserves user hooks in a real ordinary Git checkout', () => {
        withRepository((root) => {
            assert.ok(fs.statSync(path.join(root, '.git')).isDirectory());
            assert.ok(fs.statSync(path.join(root, '.git', 'HEAD')).isFile());
            const destination = hookPath(root);
            const userHook = '#!/usr/bin/env bash\necho ordinary-user-hook\n';
            fs.writeFileSync(destination, userHook);
            if (process.platform !== 'win32') fs.chmodSync(destination, 0o640);
            assert.equal(applyCommitGuardHook(root, true, true), true);
            assert.equal(fs.readFileSync(destination, 'utf8'), userHook);
            const backups: string[] = [];
            assert.equal(applyCommitGuardHook(root, true, false, (file, relative) => {
                assert.equal(file, destination);
                assert.equal(relative, '.git/hooks/pre-commit');
                backups.push(fs.readFileSync(file, 'utf8'));
            }), true);
            assert.deepEqual(backups, [userHook]);
            assert.ok(fs.readFileSync(destination, 'utf8').includes('ordinary-user-hook'));
            assert.ok(fs.readFileSync(destination, 'utf8').includes(COMMIT_GUARD_START));
            if (process.platform !== 'win32') assert.equal(fs.statSync(destination).mode & 0o111, 0o111);
            assert.equal(applyCommitGuardHook(root, true, false), false);
            assert.equal(applyCommitGuardHook(root, false, false), true);
            assert.equal(fs.readFileSync(destination, 'utf8'), userHook);
        });
    });

    it('creates the guard in the common Git directory for a real worktree with spaces', () => {
        withRepository((root, linked) => {
            assert.ok(fs.statSync(path.join(linked, '.git')).isFile());
            assert.equal(applyCommitGuardHook(linked, true, false), true);
            const destination = hookPath(root);
            assert.equal(hookPath(linked), destination);
            assert.ok(fs.readFileSync(destination, 'utf8').includes(COMMIT_GUARD_START));
            assert.equal(applyCommitGuardHook(linked, true, false), false);
            assert.ok(fs.statSync(path.join(linked, '.git')).isFile());
        });
    });

    it('preserves and backs up user hooks while enabling and disabling the shared guard', () => {
        withRepository((root, linked) => {
            const destination = hookPath(root);
            const userHook = '#!/usr/bin/env bash\necho "user hook"\n';
            fs.writeFileSync(destination, userHook);
            const backups: string[] = [];
            const backup = (file: string, relative: string) => {
                assert.equal(file, destination);
                assert.equal(relative, '.git/hooks/pre-commit');
                backups.push(fs.readFileSync(file, 'utf8'));
            };
            assert.equal(applyCommitGuardHook(linked, true, false, backup), true);
            assert.equal(backups[0], userHook);
            assert.ok(fs.readFileSync(destination, 'utf8').includes('echo "user hook"'));
            assert.equal(applyCommitGuardHook(linked, false, false, backup), true);
            assert.equal(fs.readFileSync(destination, 'utf8'), userHook);
        });
    });

    it('does not write hook directories or hook bytes during dry-run', () => {
        withRepository((root, linked) => {
            const destination = hookPath(root);
            fs.rmSync(path.dirname(destination), { recursive: true });
            assert.equal(applyCommitGuardHook(linked, true, true), true);
            assert.equal(fs.existsSync(path.dirname(destination)), false);
            fs.mkdirSync(path.dirname(destination));
            fs.writeFileSync(destination, '#!/usr/bin/env bash\necho keep\n');
            const previous = fs.readFileSync(destination);
            assert.equal(applyCommitGuardHook(linked, true, true), true);
            assert.deepEqual(fs.readFileSync(destination), previous);
        });
    });

    it('honors workspace-local core.hooksPath instead of installing an unused guard', () => {
        withRepository((root, linked) => {
            git(root, ['config', 'core.hooksPath', '.custom hooks']);
            const destination = path.join(linked, '.custom hooks', 'pre-commit');
            assert.equal(applyCommitGuardHook(linked, true, false), true);
            assert.ok(fs.readFileSync(destination, 'utf8').includes(COMMIT_GUARD_START));
            assert.equal(fs.existsSync(path.join(root, '.git', 'hooks', 'pre-commit')), false);
        });
    });

    it('rejects external core.hooksPath without modifying its user hook', () => {
        assert.doesNotThrow(() => withRepository((root, linked) => {
            const outside = path.join(path.dirname(root), 'external hooks');
            fs.mkdirSync(outside);
            const destination = path.join(outside, 'pre-commit');
            fs.writeFileSync(destination, 'outside stays');
            git(root, ['config', 'core.hooksPath', outside]);
            assert.throws(() => applyCommitGuardHook(linked, true, false), /external core.hooksPath/);
            assert.equal(fs.readFileSync(destination, 'utf8'), 'outside stays');
        }));
    });

    it('rejects malformed gitdir pointers instead of creating a directory through them', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-bad-gitdir-'));
        try {
            fs.writeFileSync(path.join(root, '.git'), 'not a gitdir pointer\n');
            assert.throws(() => applyCommitGuardHook(root, true, false), /Cannot resolve/);
            assert.equal(fs.readFileSync(path.join(root, '.git'), 'utf8'), 'not a gitdir pointer\n');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects a hooks-directory link before touching the external target', () => {
        assert.doesNotThrow(() => withRepository((root, linked) => {
            const hooks = path.dirname(hookPath(root));
            const outside = path.join(path.dirname(root), 'outside linked hooks');
            fs.mkdirSync(outside);
            fs.rmSync(hooks, { recursive: true });
            fs.symlinkSync(outside, hooks, process.platform === 'win32' ? 'junction' : 'dir');
            assert.throws(() => applyCommitGuardHook(linked, true, false), /symlink or junction|external core.hooksPath/);
            assert.deepEqual(fs.readdirSync(outside), []);
        }));
    });

    it('rejects a hard-linked hook without modifying the other file', () => {
        assert.doesNotThrow(() => withRepository((root, linked) => {
            const outside = path.join(path.dirname(root), 'outside hook');
            fs.writeFileSync(outside, 'keep hard link');
            fs.linkSync(outside, hookPath(root));
            assert.throws(() => applyCommitGuardHook(linked, true, false), /hard-linked/);
            assert.equal(fs.readFileSync(outside, 'utf8'), 'keep hard link');
        }));
    });

    it('rejects destination substitution by the backup callback', () => {
        assert.doesNotThrow(() => withRepository((root, linked) => {
            const hooks = path.dirname(hookPath(root));
            fs.writeFileSync(path.join(hooks, 'pre-commit'), 'original user hook');
            assert.throws(() => applyCommitGuardHook(linked, true, false, () => {
                fs.renameSync(hooks, hooks + '.old');
                fs.mkdirSync(hooks);
                fs.writeFileSync(path.join(hooks, 'pre-commit'), 'replacement owner');
            }), /identity changed/);
            assert.equal(fs.readFileSync(path.join(hooks, 'pre-commit'), 'utf8'), 'replacement owner');
        }));
    });

    it('rejects in-place Git metadata changes by the backup callback', () => {
        assert.doesNotThrow(() => withRepository((root, linked) => {
            const destination = hookPath(root);
            fs.writeFileSync(destination, 'original hook');
            assert.throws(() => applyCommitGuardHook(linked, true, false, () => {
                fs.appendFileSync(path.join(root, '.git', 'config'), '\n# changed during backup\n');
            }), /metadata changed/);
            assert.equal(fs.readFileSync(destination, 'utf8'), 'original hook');
        }));
    });

    it('honors core.hooksPath from included Git configuration', () => {
        withRepository((root, linked) => {
            const included = path.join(root, '.git', 'hook-options.conf');
            git(root, ['config', '--file', included, 'core.hooksPath', '.included hooks']);
            git(root, ['config', 'include.path', included]);
            const destination = path.join(linked, '.included hooks', 'pre-commit');
            assert.equal(applyCommitGuardHook(linked, true, false), true);
            assert.ok(fs.readFileSync(destination, 'utf8').includes(COMMIT_GUARD_START));
        });
    });

    it('rejects included Git configuration changes by the backup callback', () => {
        assert.doesNotThrow(() => withRepository((root, linked) => {
            const included = path.join(root, '.git', 'hook-options.conf');
            git(root, ['config', '--file', included, 'core.hooksPath', '.original hooks']);
            git(root, ['config', 'include.path', included]);
            const original = path.join(linked, '.original hooks', 'pre-commit');
            const replacement = path.join(linked, '.replacement hooks', 'pre-commit');
            fs.mkdirSync(path.dirname(original));
            fs.mkdirSync(path.dirname(replacement));
            fs.writeFileSync(original, 'original user hook');
            fs.writeFileSync(replacement, 'replacement user hook');
            assert.throws(() => applyCommitGuardHook(linked, true, false, () => {
                git(root, ['config', '--file', included, 'core.hooksPath', '.replacement hooks']);
            }), /destination changed/);
            assert.equal(fs.readFileSync(original, 'utf8'), 'original user hook');
            assert.equal(fs.readFileSync(replacement, 'utf8'), 'replacement user hook');
        }));
    });

    it('ignores inherited repository-routing environment variables', () => {
        withRepository((root, linked) => {
            const previous = process.env.GIT_COMMON_DIR;
            try {
                process.env.GIT_COMMON_DIR = path.join(path.dirname(root), 'foreign metadata');
                assert.equal(applyCommitGuardHook(linked, true, false), true);
                assert.ok(fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8').includes(COMMIT_GUARD_START));
                assert.equal(fs.existsSync(process.env.GIT_COMMON_DIR), false);
            } finally {
                if (previous === undefined) delete process.env.GIT_COMMON_DIR;
                else process.env.GIT_COMMON_DIR = previous;
            }
        });
    });

    it('creates and repairs executable hook modes on POSIX', { skip: process.platform === 'win32' }, () => {
        withRepository((root, linked) => {
            const destination = hookPath(root);
            applyCommitGuardHook(linked, true, false);
            assert.equal(fs.statSync(destination).mode & 0o111, 0o111);
            fs.chmodSync(destination, 0o640);
            assert.equal(applyCommitGuardHook(linked, true, true), true);
            assert.equal(fs.statSync(destination).mode & 0o777, 0o640);
            assert.equal(applyCommitGuardHook(linked, true, false), true);
            assert.equal(fs.statSync(destination).mode & 0o777, 0o751);
        });
    });

    for (const layout of ['ordinary checkout', 'linked worktree']) {
        it(`runs public materialization install in ${layout} and retains the user hook backup`, () => {
            const fixture = setupTestWorkspace(findRepoRoot());
            try {
                withRepository((root, linked) => {
                    const target = layout === 'ordinary checkout' ? root : linked;
                    const destination = hookPath(root);
                    const userHook = '#!/usr/bin/env bash\necho existing-user-hook\n';
                    fs.writeFileSync(destination, userHook);
                    const bundleRoot = path.join(target, 'garda-agent-orchestrator');
                    fs.cpSync(fixture.bundleRoot, bundleRoot, { recursive: true });
                    const answersPath = writeInitAnswers(bundleRoot, {
                        AssistantLanguage: 'English', AssistantBrevity: 'concise', SourceOfTruth: 'Codex',
                        EnforceNoAutoCommit: 'true', ClaudeOrchestratorFullAccess: 'false',
                        TokenEconomyEnabled: 'true', CollectedVia: 'CLI_NONINTERACTIVE'
                    });
                    const result = runInstall({ targetRoot: target, bundleRoot,
                        runInit: false, sourceOfTruth: 'Codex', assistantLanguage: 'English',
                        assistantBrevity: 'concise', initAnswersPath: answersPath });
                    assert.equal(result.preCommitHookUpdated, true);
                    assert.ok(fs.readFileSync(destination, 'utf8').includes('existing-user-hook'));
                    assert.ok(result.backupRoot);
                    assert.equal(fs.readFileSync(path.join(result.backupRoot!, '.git', 'hooks', 'pre-commit'), 'utf8'), userHook);
                });
            } finally {
                fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
            }
        });
    }
});
