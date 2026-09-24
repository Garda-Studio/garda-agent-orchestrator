import { after, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsNative from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as childProcess from 'node:child_process';

import { runUpdateFromGit, buildGitCloneArgs, cloneGitUpdateSource } from '../../../src/lifecycle/update-git';
import { assertGitUpdateTransport, createIsolatedGitEnvironment, verifyGitUpdateSource } from '../../../src/lifecycle/update/update-git-source-verification';
import { removePathRecursive } from '../../../src/lifecycle/common';

const gitFixtureEnvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-git-fixture-env-'));
const gitFixtureEnv = createIsolatedGitEnvironment(gitFixtureEnvRoot);
after(() => removePathRecursive(gitFixtureEnvRoot));

function git(args: string[], cwd: string) {
    const result = childProcess.spawnSync('git', args, {
        cwd,
        env: gitFixtureEnv,
        stdio: 'pipe',
        encoding: 'utf8'
    });

    if (result.status !== 0) {
        const errorText = String(result.stderr || result.stdout || '').trim();
        throw new Error(`git ${args.join(' ')} failed: ${errorText}`);
    }
}

function gitText(args: string[], cwd: string): string {
    const result = childProcess.spawnSync('git', args, {
        cwd,
        env: gitFixtureEnv,
        stdio: 'pipe',
        encoding: 'utf8'
    });

    if (result.status !== 0) {
        const errorText = String(result.stderr || result.stdout || '').trim();
        throw new Error(`git ${args.join(' ')} failed: ${errorText}`);
    }

    return String(result.stdout || '').trim();
}

function createGitUpdateRepo(version: string, includePrebuilt = true, parentRoot = os.tmpdir()) {
    fs.mkdirSync(parentRoot, { recursive: true });
    const repoRoot = fs.mkdtempSync(path.join(parentRoot, 'gao-update-git-repo-'));
    fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'scripts', 'build.js'), [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const root = process.cwd();",
        "fs.mkdirSync(path.join(root, 'bin'), { recursive: true });",
        "fs.mkdirSync(path.join(root, 'dist', 'src'), { recursive: true });",
        "fs.writeFileSync(path.join(root, 'bin', 'garda.js'), '#!/usr/bin/env node\\n');",
        "fs.writeFileSync(path.join(root, 'dist', 'src', 'index.js'), 'module.exports = {};\\n');"
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'VERSION'), `${version}\n`, 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
        name: 'garda-agent-orchestrator',
        version,
        scripts: {
            build: 'node scripts/build.js'
        }
    }, null, 2));
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Updated bundle\n', 'utf8');
    if (includePrebuilt) {
        fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'dist', 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'dist', 'src', 'index.js'), 'module.exports = {};\n', 'utf8');
    }

    git(['init'], repoRoot);
    git(['config', 'user.email', 'tests@example.com'], repoRoot);
    git(['config', 'user.name', 'Garda Tests'], repoRoot);
    git(['add', '.'], repoRoot);
    git(['commit', '-m', 'init'], repoRoot);
    return repoRoot;
}

function createDeployedWorkspace(version: string) {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-git-target-'));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(bundleRoot, { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'dist', 'src'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), `${version}\n`, 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'dist', 'src', 'index.js'), 'module.exports = {};', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({
        name: 'garda-agent-orchestrator',
        version
    }, null, 2));
    return { targetRoot, bundleRoot };
}

describe('buildGitCloneArgs', () => {
    it('includes depth and repo path', () => {
        assert.deepEqual(
            buildGitCloneArgs('https://example.com/repo.git', null, 'C:/tmp/clone'),
            ['clone', '--depth', '1', 'https://example.com/repo.git', 'C:/tmp/clone']
        );
    });

    it('includes branch when provided', () => {
        assert.deepEqual(
            buildGitCloneArgs('https://example.com/repo.git', 'main', 'C:/tmp/clone'),
            ['clone', '--depth', '1', '--branch', 'main', '--single-branch', 'https://example.com/repo.git', 'C:/tmp/clone']
        );
    });

    it('forces local clone mode for an explicit path', () => {
        const localRepo = path.resolve('local-repo');
        assert.deepEqual(
            buildGitCloneArgs(localRepo, null, 'C:/tmp/clone'),
            ['clone', '--local', '--no-hardlinks', localRepo, 'C:/tmp/clone']
        );
    });
});

describe('Git update source boundary', () => {
    it('isolates fixture Git commands from inherited commit signing', () => {
        const previous = {
            GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
            GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
            GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0
        };
        process.env.GIT_CONFIG_COUNT = '1';
        process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign';
        process.env.GIT_CONFIG_VALUE_0 = 'true';
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-git-hostile-env-'));
        try {
            const repoRoot = createGitUpdateRepo('2.1.0', true, fixtureRoot);
            assert.match(gitText(['log', '-1', '--format=%s'], repoRoot), /init/u);
        } finally {
            for (const [name, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            removePathRecursive(fixtureRoot);
        }
    });

    it('rejects executable Git transports before cloning', () => {
        assert.throws(() => assertGitUpdateTransport('ssh://example.com/repo', 'ssh source'),
            /UPDATE_SOURCE_UNVERIFIED/);
        assert.throws(() => assertGitUpdateTransport('ext::command', 'external helper'),
            /UPDATE_SOURCE_UNVERIFIED/);
        assert.throws(() => assertGitUpdateTransport('file:///tmp/repo', 'file source'),
            /UPDATE_SOURCE_UNVERIFIED/);
    });

    it('rejects credential-bearing URLs without exposing their contents', async () => {
        for (const repoUrl of [
            'https://user:secret-token@example.com/repo.git',
            'https://example.com/repo.git?token=secret-token',
            'https://example.com/repo.git#secret-token'
        ]) {
            await assert.rejects(
                runUpdateFromGit({ targetRoot: '.', bundleRoot: '.', repoUrl, trustOverride: true }),
                (error: unknown) => {
                    assert.doesNotMatch(JSON.stringify(error), /secret-token/u);
                    assert.match(String(error), /UPDATE_SOURCE_UNVERIFIED/u);
                    return true;
                }
            );
        }
    });

    it('rejects a file URL through update orchestration before cloning', async () => {
        await assert.rejects(
            runUpdateFromGit({
                targetRoot: '.', bundleRoot: '.', repoUrl: 'file:///missing-garda-update-repo', trustOverride: true
            }),
            (error: unknown) => {
                assert.equal((error as { diagnosticCode?: string }).diagnosticCode, 'UPDATE_SOURCE_UNVERIFIED');
                return true;
            }
        );
    });

    it('removes inherited Git configuration from the clone environment', () => {
        const previous = process.env.GIT_CONFIG_COUNT;
        process.env.GIT_CONFIG_COUNT = '1';
        const templateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-git-template-test-'));
        try {
            const env = createIsolatedGitEnvironment(templateRoot);
            assert.equal(env.GIT_CONFIG_COUNT, undefined);
            assert.equal(env.GIT_CONFIG_GLOBAL, path.join(templateRoot, 'empty.gitconfig'));
            assert.equal(fs.readFileSync(String(env.GIT_CONFIG_GLOBAL), 'utf8'), '');
        } finally {
            if (previous === undefined) delete process.env.GIT_CONFIG_COUNT;
            else process.env.GIT_CONFIG_COUNT = previous;
            removePathRecursive(templateRoot);
        }
    });
});

describe('verified Git clone resources', () => {
    it('removes both clone and isolated template roots after use', async () => {
        const repoRoot = createGitUpdateRepo('2.1.0');
        try {
            const clone = await cloneGitUpdateSource(repoRoot, null);
            const templateRoot = String(clone.env.GIT_TEMPLATE_DIR);
            assert.ok(fs.existsSync(clone.clonePath));
            assert.ok(fs.existsSync(templateRoot));
            clone.cleanup();
            assert.equal(fs.existsSync(clone.clonePath), false);
            assert.equal(fs.existsSync(templateRoot), false);
        } finally {
            removePathRecursive(repoRoot);
        }
    });

    it('removes both temporary roots when Git clone fails', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-git-clone-failure-'));
        const previous = {
            TMPDIR: process.env.TMPDIR,
            TMP: process.env.TMP,
            TEMP: process.env.TEMP
        };
        process.env.TMPDIR = tempRoot;
        process.env.TMP = tempRoot;
        process.env.TEMP = tempRoot;
        try {
            assert.equal(os.tmpdir(), tempRoot);
            await assert.rejects(cloneGitUpdateSource(path.join(tempRoot, 'missing-repository'), null),
                /Failed to clone git update source/u);
            assert.deepEqual(fs.readdirSync(tempRoot), []);
        } finally {
            for (const [name, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            removePathRecursive(tempRoot);
        }
    });

    it('removes partial temporary roots when isolated Git setup fails', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-git-setup-failure-'));
        const previous = {
            TMPDIR: process.env.TMPDIR,
            TMP: process.env.TMP,
            TEMP: process.env.TEMP
        };
        process.env.TMPDIR = tempRoot;
        process.env.TMP = tempRoot;
        process.env.TEMP = tempRoot;
        const originalWriteFileSync = fsNative.writeFileSync;
        const writeMock = mock.method(fsNative, 'writeFileSync', (...args: unknown[]) => {
            if (String(args[0]).endsWith('empty.gitconfig')) {
                throw new Error('injected Git environment setup failure');
            }
            return Reflect.apply(originalWriteFileSync, fsNative, args);
        });
        try {
            assert.equal(os.tmpdir(), tempRoot);
            await assert.rejects(cloneGitUpdateSource(path.join(tempRoot, 'unused-repository'), null),
                /injected Git environment setup failure/u);
            assert.ok(writeMock.mock.callCount() > 0);
            assert.deepEqual(fs.readdirSync(tempRoot), []);
        } finally {
            writeMock.mock.restore();
            for (const [name, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            removePathRecursive(tempRoot);
        }
    });

    it('rejects source, ref, worktree, and package mismatches with a real Git repository', () => {
        const repoRoot = createGitUpdateRepo('2.1.0');
        const templateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-git-verifier-test-'));
        try {
            const env = createIsolatedGitEnvironment(templateRoot);
            const verify = (branch: string | null = null) => verifyGitUpdateSource({
                sourceRoot: repoRoot, repoUrl: repoRoot, branch, sourceReference: repoRoot, env, requireBundle: true
            });
            git(['remote', 'add', 'origin', path.join(repoRoot, 'other')], repoRoot);
            assert.throws(verify, /UPDATE_SOURCE_UNVERIFIED/u);
            git(['remote', 'set-url', 'origin', repoRoot], repoRoot);
            assert.throws(() => verify('missing-branch'), /UPDATE_SOURCE_UNVERIFIED/u);

            fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Dirty bundle\n', 'utf8');
            assert.throws(verify, /UPDATE_SOURCE_UNVERIFIED/u);
            git(['checkout', '--', 'README.md'], repoRoot);

            fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ invalid json', 'utf8');
            git(['add', 'package.json'], repoRoot);
            git(['commit', '-m', 'invalid package'], repoRoot);
            assert.throws(verify, /UPDATE_SOURCE_UNVERIFIED/u);

            fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ version: '3.0.0' }), 'utf8');
            git(['add', 'package.json'], repoRoot);
            git(['commit', '-m', 'mismatched version'], repoRoot);
            assert.throws(verify, /UPDATE_SOURCE_UNVERIFIED/u);
        } finally {
            removePathRecursive(repoRoot);
            removePathRecursive(templateRoot);
        }
    });
});

describe('runUpdateFromGit', () => {
    it('accepts an explicit relative local repository path', async () => {
        const repoParent = path.join(process.cwd(), 'garda-agent-orchestrator', 'runtime', 'tmp');
        const repoRoot = createGitUpdateRepo('2.1.0', true, repoParent);
        const repoUrl = `./${path.relative(process.cwd(), repoRoot).replaceAll('\\', '/')}`;
        const { targetRoot, bundleRoot } = createDeployedWorkspace('2.0.0');
        try {
            const result = await runUpdateFromGit({
                targetRoot, bundleRoot, repoUrl, checkOnly: true, trustOverride: true
            });
            assert.equal(result.repoUrl, repoUrl);
            assert.equal(result.updateAvailable, true);
        } finally {
            removePathRecursive(repoRoot);
            removePathRecursive(targetRoot);
        }
    });

    it('keeps a relative source bound to the invocation directory during cloning', async () => {
        const invocationRoot = process.cwd();
        const repoParent = path.join(invocationRoot, 'garda-agent-orchestrator', 'runtime', 'tmp');
        const repoRoot = createGitUpdateRepo('2.1.0', true, repoParent);
        const repoUrl = `./${path.relative(invocationRoot, repoRoot).replaceAll('\\', '/')}`;
        const { targetRoot, bundleRoot } = createDeployedWorkspace('2.0.0');
        try {
            const update = runUpdateFromGit({ targetRoot, bundleRoot, repoUrl, checkOnly: true, trustOverride: true });
            process.chdir(repoParent);
            const result = await update;
            assert.equal(result.repoUrl, repoUrl);
            assert.equal(result.updateAvailable, true);
        } finally {
            process.chdir(invocationRoot);
            removePathRecursive(repoRoot);
            removePathRecursive(targetRoot);
        }
    });

    it('accepts a Windows-native relative local repository path', { skip: process.platform !== 'win32' }, async () => {
        const invocationRoot = process.cwd();
        const repoParent = path.join(invocationRoot, 'garda-agent-orchestrator', 'runtime', 'tmp');
        const repoRoot = createGitUpdateRepo('2.1.0', true, repoParent);
        const repoUrl = `.\\${path.relative(invocationRoot, repoRoot)}`;
        const { targetRoot, bundleRoot } = createDeployedWorkspace('2.0.0');
        try {
            const result = await runUpdateFromGit({ targetRoot, bundleRoot, repoUrl, checkOnly: true, trustOverride: true });
            assert.equal(result.repoUrl, repoUrl);
            assert.equal(result.updateAvailable, true);
        } finally {
            removePathRecursive(repoRoot);
            removePathRecursive(targetRoot);
        }
    });

    it('detects update availability from a local git repository in check-only mode', async () => {
        const repoRoot = createGitUpdateRepo('2.1.0');
        const { targetRoot, bundleRoot } = createDeployedWorkspace('2.0.0');
        try {
            const result = await runUpdateFromGit({
                targetRoot,
                bundleRoot,
                repoUrl: repoRoot,
                checkOnly: true,
                noPrompt: true,
                trustOverride: true
            });

            assert.equal(result.sourceType, 'git');
            assert.equal(result.repoUrl, repoRoot);
            assert.equal(result.gitCommitSha, gitText(['rev-parse', 'HEAD'], repoRoot));
            assert.equal(result.checkUpdateResult, 'UPDATE_AVAILABLE');
            assert.equal(result.updateAvailable, true);
            assert.equal(result.updateApplied, false);
            assert.equal(result.trustPolicy, 'overridden');
            assert.equal(result.trustOverrideUsed, true);
            assert.equal(result.trustOverrideSource, 'cli-flag');
            assert.equal(result.releaseProvenanceStatus, 'TRUST_OVERRIDE_UNVERIFIED');
        } finally {
            removePathRecursive(repoRoot);
            removePathRecursive(targetRoot);
        }
    });

    it('runs the post-sync update lifecycle callback when applying an update', async () => {
        const repoRoot = createGitUpdateRepo('2.1.0');
        const { targetRoot, bundleRoot } = createDeployedWorkspace('2.0.0');
        try {
            const branchName = gitText(['branch', '--show-current'], repoRoot);
            let updateRunnerCalled = false;
            let updateRunnerSourceType = '';
            let updateRunnerSourceReference = '';
            let updateRunnerGitCommitSha = '';
            const result = await runUpdateFromGit({
                targetRoot,
                bundleRoot,
                repoUrl: repoRoot,
                branch: branchName,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (options) => {
                    updateRunnerCalled = true;
                    updateRunnerSourceType = options.sourceType;
                    updateRunnerSourceReference = options.sourceReference;
                    updateRunnerGitCommitSha = String(options.gitCommitSha || '');
                }
            });

            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.equal(result.updateApplied, true);
            assert.equal(updateRunnerCalled, true);
            assert.equal(updateRunnerSourceType, 'git');
            assert.equal(updateRunnerSourceReference, `${repoRoot}#${branchName}`);
            assert.equal(updateRunnerGitCommitSha, gitText(['rev-parse', 'HEAD'], repoRoot));
            assert.equal(result.gitCommitSha, updateRunnerGitCommitSha);
            assert.equal(result.sourceReference, `${repoRoot}#${branchName}`);
            assert.equal(result.trustOverrideSource, 'cli-flag');
            assert.equal(result.releaseProvenanceStatus, 'TRUST_OVERRIDE_UNVERIFIED');
            assert.ok(fs.existsSync(path.join(bundleRoot, 'dist', 'src', 'index.js')));
        } finally {
            removePathRecursive(repoRoot);
            removePathRecursive(targetRoot);
        }
    });

    it('rejects a source-only ref before executing its build script', async () => {
        const repoRoot = createGitUpdateRepo('2.1.0', false);
        const { targetRoot, bundleRoot } = createDeployedWorkspace('2.0.0');
        const markerPath = path.join(targetRoot, 'unsafe-build-ran');
        fs.writeFileSync(path.join(repoRoot, 'scripts', 'build.js'),
            `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`, 'utf8');
        git(['add', '.'], repoRoot);
        git(['commit', '-m', 'source only'], repoRoot);

        try {
            await assert.rejects(
                runUpdateFromGit({
                    targetRoot,
                    bundleRoot,
                    repoUrl: repoRoot,
                    noPrompt: true,
                    trustOverride: true
                }),
                (error) => {
                    assert.match((error as Error).message, /UPDATE_SOURCE_PREBUILT_REQUIRED/);
                    assert.match((error as Error).message, /prebuilt bundle/i);
                    return true;
                }
            );
            assert.equal(fs.existsSync(markerPath), false);
        } finally {
            removePathRecursive(repoRoot);
            removePathRecursive(targetRoot);
        }
    });

    it('does not accept an uncommitted prebuilt bundle even with trust override', async () => {
        const repoRoot = createGitUpdateRepo('2.1.0', false);
        const { targetRoot, bundleRoot } = createDeployedWorkspace('2.0.0');
        fs.mkdirSync(path.join(repoRoot, 'dist', 'src'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'dist', 'src', 'index.js'), 'module.exports = {};\n');
        fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n');
        try {
            await assert.rejects(runUpdateFromGit({
                targetRoot, bundleRoot, repoUrl: repoRoot, trustOverride: true, noPrompt: true
            }), /UPDATE_SOURCE_PREBUILT_REQUIRED/);
        } finally {
            removePathRecursive(repoRoot);
            removePathRecursive(targetRoot);
        }
    });

    it('rejects a committed link in the update tree before the lifecycle callback', async () => {
        const repoRoot = createGitUpdateRepo('2.1.0');
        const { targetRoot, bundleRoot } = createDeployedWorkspace('2.0.0');
        const blob = childProcess.spawnSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: repoRoot, input: '../outside.js', encoding: 'utf8'
        });
        assert.equal(blob.status, 0);
        git(['update-index', '--add', '--cacheinfo', `120000,${String(blob.stdout).trim()},dist/src/escape.js`], repoRoot);
        git(['commit', '-m', 'linked runtime'], repoRoot);
        let updateRunnerCalled = false;
        try {
            await assert.rejects(runUpdateFromGit({
                targetRoot, bundleRoot, repoUrl: repoRoot, trustOverride: true, noPrompt: true,
                updateRunner: () => { updateRunnerCalled = true; }
            }), /UPDATE_SOURCE_UNVERIFIED/);
            assert.equal(updateRunnerCalled, false);
        } finally {
            removePathRecursive(repoRoot);
            removePathRecursive(targetRoot);
        }
    });

    it('surfaces classified diagnostics when the requested branch is missing', async () => {
        const repoRoot = createGitUpdateRepo('2.1.0');
        const { targetRoot, bundleRoot } = createDeployedWorkspace('2.0.0');
        try {
            await assert.rejects(
                runUpdateFromGit({
                    targetRoot,
                    bundleRoot,
                    repoUrl: repoRoot,
                    branch: 'missing-branch',
                    checkOnly: true,
                    noPrompt: true,
                    trustOverride: true
                }),
                (error) => {
                    assert.match((error as Error).message, /DiagnosticTool: git/);
                    assert.match((error as Error).message, /DiagnosticCode: GIT_REF_NOT_FOUND/);
                    assert.match((error as Error).message, /DiagnosticSource:/);
                    assert.match((error as Error).message, /missing-branch/);
                    assert.match((error as Error).message, /DiagnosticStderr:/);
                    return true;
                }
            );
        } finally {
            removePathRecursive(repoRoot);
            removePathRecursive(targetRoot);
        }
    });
});
