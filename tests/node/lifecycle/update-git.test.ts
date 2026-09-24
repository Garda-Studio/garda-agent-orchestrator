import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as childProcess from 'node:child_process';

import { runUpdateFromGit, buildGitCloneArgs } from '../../../src/lifecycle/update-git';
import { assertGitUpdateTransport, createIsolatedGitEnvironment } from '../../../src/lifecycle/update/update-git-source-verification';
import { removePathRecursive } from '../../../src/lifecycle/common';

function git(args: string[], cwd: string) {
    const result = childProcess.spawnSync('git', args, {
        cwd,
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
        stdio: 'pipe',
        encoding: 'utf8'
    });

    if (result.status !== 0) {
        const errorText = String(result.stderr || result.stdout || '').trim();
        throw new Error(`git ${args.join(' ')} failed: ${errorText}`);
    }

    return String(result.stdout || '').trim();
}

function createGitUpdateRepo(version: string, includePrebuilt = true) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-git-repo-'));
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
            ['clone', '--depth', '1', '--local', localRepo, 'C:/tmp/clone']
        );
    });
});

describe('Git update source boundary', () => {
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

describe('runUpdateFromGit', () => {
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
