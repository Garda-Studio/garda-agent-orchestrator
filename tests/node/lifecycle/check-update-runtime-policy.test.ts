import { beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { buildUpdateLifecycleRunner } from '../../../src/cli/commands/shared-command-utils';
import { writeProtectedControlPlaneManifest } from '../../../src/gates/shared/helpers';
import {
    getUpdateTempRoot,
    runCheckUpdate
} from '../../../src/lifecycle/check-update';
import { runUpdate } from '../../../src/lifecycle/update';
import { getUpdateRollbackItems } from '../../../src/lifecycle/update/update';
import { PUBLIC_BUNDLE_ASSETS } from '../../../src/core/public-bundle-assets';
import { verifySyncedItemsRestoredFromBackup } from '../../../src/lifecycle/check-update/check-update-bundle-sync';
import { runDoctor } from '../../../src/validators/doctor';
import {
    BUNDLE_SYNC_ITEMS,
    removePathRecursive,
    getUpdateSentinelPath,
    getLifecycleOperationLockPath,
    readSyncBackupMetadata,
    readUpdateSentinel,
    withLifecycleOperationLockAsync
} from '../../../src/lifecycle/common';
const FIRST_NPM_RELEASE_PACKAGE_SPEC = 'garda-agent-orchestrator@1.0.0';
const FIRST_NPM_RELEASE_FILENAME = 'garda-agent-orchestrator-1.0.0.tgz';
const NEXT_RELEASE_TEST_VERSION = '1.0.1';
const NPM_NETWORK_TESTS_ENABLED = process.env.GARDA_NPM_NETWORK_TESTS === '1';
const TEST_COMPILE_GATE_COMMAND = 'node -e "console.log(\'build ok\')"';

function assertOriginalBundleSnapshot(projectRoot: string, bundleRoot: string): void {
    const snapshotsRoot = path.join(bundleRoot, 'runtime', 'update-rollbacks');
    const snapshots = fs.readdirSync(snapshotsRoot).filter((entry) => entry.startsWith('update-'));
    assert.equal(snapshots.length, 1);
    assert.equal(fs.readFileSync(path.join(snapshotsRoot, snapshots[0], 'garda-agent-orchestrator', 'VERSION'), 'utf8').trim(), '0.0.1');
    assert.equal(fs.existsSync(getLifecycleOperationLockPath(projectRoot)), false);
}

function isNpmFixtureEnvironmentKey(key: string): boolean {
    return key.toUpperCase().startsWith('NPM_CONFIG_') || ['NPM_TOKEN', 'NODE_AUTH_TOKEN'].includes(key.toUpperCase());
}

beforeEach(async (context) => {
    // Flush completed test results before the next synchronous fixture workload.
    await yieldToEventLoop();
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-offline-npm-'));
    const inherited = Object.entries(process.env).filter(([key]) => isNpmFixtureEnvironmentKey(key));
    const clear = () => {
        for (const key of Object.keys(process.env).filter(isNpmFixtureEnvironmentKey)) delete process.env[key];
    };
    (context as TestContext).after(() => {
        clear();
        for (const [key, value] of inherited) process.env[key] = value;
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });
    clear();
    const userConfig = path.join(fixtureRoot, 'user.npmrc');
    const globalConfig = path.join(fixtureRoot, 'global.npmrc');
    fs.writeFileSync(userConfig, '', 'utf8');
    fs.writeFileSync(globalConfig, '', 'utf8');
    Object.assign(process.env, {
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
        npm_config_cache: path.join(fixtureRoot, 'cache'),
        npm_config_offline: String(!NPM_NETWORK_TESTS_ENABLED),
        npm_config_registry: NPM_NETWORK_TESTS_ENABLED ? 'https://registry.npmjs.org' : 'http://127.0.0.1:9',
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false'
    });
});

function getLockedLegacyPackageSpec(repoRoot: string, candidatePath?: string): string {
    const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'npm');
    const lock = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'garda-agent-orchestrator-1.0.0.lock.json'), 'utf8'));
    assert.equal(lock.name, 'garda-agent-orchestrator');
    assert.equal(lock.version, '1.0.0');
    assert.equal(lock.filename, FIRST_NPM_RELEASE_FILENAME);
    assert.match(lock.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/u);
    const tarballPath = candidatePath ?? path.join(fixtureRoot, FIRST_NPM_RELEASE_FILENAME);
    const actualIntegrity = `sha512-${createHash('sha512').update(fs.readFileSync(tarballPath)).digest('base64')}`;
    assert.equal(actualIntegrity, lock.integrity, 'Locked legacy release tarball integrity mismatch');
    return tarballPath;
}

function findRepoRoot() {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'template'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

function copyPathRecursive(sourcePath: string, destinationPath: string) {
    const stats = fs.lstatSync(sourcePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (stats.isDirectory()) {
        fs.mkdirSync(destinationPath, { recursive: true });
        for (const entry of fs.readdirSync(sourcePath)) {
            copyPathRecursive(path.join(sourcePath, entry), path.join(destinationPath, entry));
        }
        return;
    }
    fs.copyFileSync(sourcePath, destinationPath);
}

function seedBundleSyncSurface(sourceRoot: string, bundleRoot: string) {
    for (const item of BUNDLE_SYNC_ITEMS) {
        const sourceItemPath = path.join(sourceRoot, item);
        if (!fs.existsSync(sourceItemPath)) {
            continue;
        }
        copyPathRecursive(sourceItemPath, path.join(bundleRoot, item));
    }
}

function seedWorkflowConfigCompileGateCommand(bundleRoot: string, command: string = TEST_COMPILE_GATE_COMMAND) {
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
        compile_gate: {
            command
        }
    }, null, 2), 'utf8');
}

function quoteWindowsArgument(argument: string): string {
    const text = String(argument || '');
    if (!text || !/[ \t"]/u.test(text)) {
        return text;
    }

    let escaped = '"';
    let backslashCount = 0;
    for (const character of text) {
        if (character === '\\') {
            backslashCount += 1;
            continue;
        }
        if (character === '"') {
            escaped += '\\'.repeat(backslashCount * 2 + 1);
            escaped += '"';
            backslashCount = 0;
            continue;
        }
        if (backslashCount > 0) {
            escaped += '\\'.repeat(backslashCount);
            backslashCount = 0;
        }
        escaped += character;
    }
    if (backslashCount > 0) {
        escaped += '\\'.repeat(backslashCount * 2);
    }
    escaped += '"';
    return escaped;
}

function spawnNpm(args: string[], cwd: string) {
    if (process.platform === 'win32') {
        const commandLine = ['npm.cmd', ...args].map(quoteWindowsArgument).join(' ');
        return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
            cwd,
            encoding: 'utf8',
            timeout: 120_000,
            windowsHide: true
        });
    }

    return spawnSync('npm', args, {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true
    });
}

function getTypescriptCliPath(repoRoot: string): string {
    return path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
}

function syncGeneratedCliEntrypoint(repoRoot: string): void {
    const compiledCliPath = path.join(repoRoot, 'dist', 'src', 'bin', 'garda.js');
    if (!fs.existsSync(compiledCliPath)) {
        throw new Error(`compiled CLI launcher not found: ${compiledCliPath}`);
    }

    const repoCliPath = path.join(repoRoot, 'bin', 'garda.js');
    fs.mkdirSync(path.dirname(repoCliPath), { recursive: true });
    fs.copyFileSync(compiledCliPath, repoCliPath);
}

function loadPackFixtureItems(repoRoot: string): string[] {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const items = new Set<string>(pkgJson.files || []);
    items.delete('dist');
    items.delete('bin');
    items.add('package.json');
    items.add('scripts/package-legacy-entrypoint-compat.cjs');
    items.add('scripts/node-foundation');
    items.add('src');
    items.add('tsconfig.build.json');
    items.add('tsconfig.scripts.json');
    return Array.from(items).sort();
}

function copyPackFixture(repoRoot: string, fixtureRoot: string): void {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    for (const relativePath of loadPackFixtureItems(repoRoot)) {
        const sourcePath = path.join(repoRoot, relativePath);
        if (!fs.existsSync(sourcePath)) {
            continue;
        }
        fs.cpSync(sourcePath, path.join(fixtureRoot, relativePath), { recursive: true });
    }

    const realNodeModules = path.join(repoRoot, 'node_modules');
    const fixtureNodeModules = path.join(fixtureRoot, 'node_modules');
    if (fs.existsSync(realNodeModules) && !fs.existsSync(fixtureNodeModules)) {
        fs.symlinkSync(realNodeModules, fixtureNodeModules, 'junction');
    }
}

function buildPublishRuntimeInRepo(repoRoot: string): void {
    const result = spawnSync(process.execPath, [getTypescriptCliPath(repoRoot), '-p', 'tsconfig.build.json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true
    });

    if (result.status !== 0) {
        throw new Error(`publish runtime build failed:\n${result.stderr || result.stdout}`);
    }

    syncGeneratedCliEntrypoint(repoRoot);
}

function rewriteFixtureReleaseVersion(fixtureRoot: string, version: string): void {
    const packageJsonPath = path.join(fixtureRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
    packageJson.version = version;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'VERSION'), `${version}\n`, 'utf8');
}

function createCandidateTarball(repoRoot: string) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-candidate-pack-'));
    const fixtureRoot = path.join(tempRoot, 'pack-repo');
    copyPackFixture(repoRoot, fixtureRoot);
    rewriteFixtureReleaseVersion(fixtureRoot, NEXT_RELEASE_TEST_VERSION);
    buildPublishRuntimeInRepo(fixtureRoot);
    const legacyCompatResult = spawnSync(process.execPath, [
        'scripts/package-legacy-entrypoint-compat.cjs',
        'create'
    ], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true
    });
    if (legacyCompatResult.status !== 0) {
        throw new Error(`legacy compatibility template generation failed:\n${legacyCompatResult.stderr || legacyCompatResult.stdout}`);
    }

    const packResult = spawnNpm(['pack', '--ignore-scripts', '--pack-destination', fixtureRoot], fixtureRoot);
    if (packResult.status !== 0) {
        throw new Error(`npm pack failed:\n${packResult.stderr || packResult.stdout}`);
    }

    const lines = String(packResult.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    const tarballFilename = lines[lines.length - 1]?.trim();
    if (!tarballFilename) {
        throw new Error('npm pack did not produce a tarball filename.');
    }

    return {
        tempRoot,
        tarballPath: path.join(fixtureRoot, tarballFilename)
    };
}

function installPackageSpec(packageSpec: string, installRoot: string): string {
    fs.mkdirSync(installRoot, { recursive: true });
    fs.writeFileSync(
        path.join(installRoot, 'package.json'),
        JSON.stringify({ name: 'gao-checkupdate-release-seed', version: '0.0.0', private: true }, null, 2),
        'utf8'
    );

    const installResult = spawnNpm([
        'install',
        '--prefer-offline',
        '--no-save',
        '--ignore-scripts',
        '--package-lock=false',
        '--fund=false',
        '--audit=false',
        '--no-progress',
        packageSpec
    ], installRoot);
    if (installResult.status !== 0) {
        throw new Error(`npm install failed for '${packageSpec}':\n${installResult.stderr || installResult.stdout}`);
    }

    const installedPackageRoot = path.join(installRoot, 'node_modules', 'garda-agent-orchestrator');
    if (!fs.existsSync(installedPackageRoot)) {
        throw new Error(`Installed package root not found after npm install: ${installedPackageRoot}`);
    }
    return installedPackageRoot;
}

function setupPublishedReleaseSeededCheckUpdateWorkspace(releasePackageSpec: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-release-seeded-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    const installRoot = path.join(tmpDir, 'legacy-release-install');
    fs.mkdirSync(bundle, { recursive: true });
    copyPathRecursive(installPackageSpec(releasePackageSpec, installRoot), bundle);
    removePathRecursive(installRoot);

    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'runtime', 'init-answers.json'), JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    }, null, 2), 'utf8');
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    return { projectRoot: tmpDir, bundleRoot: bundle };
}

function loadLegacyUpdateCaller(bundleRoot: string) {
    const legacyCheckUpdatePath = path.join(bundleRoot, 'dist', 'src', 'lifecycle', 'check-update.js');
    const legacySharedUtilsPath = path.join(bundleRoot, 'dist', 'src', 'cli', 'commands', 'shared-command-utils.js');

    for (const modulePath of [legacyCheckUpdatePath, legacySharedUtilsPath]) {
        try {
            delete require.cache[require.resolve(modulePath)];
        } catch {
            // ignore cache miss
        }
    }

    const legacyCheckUpdateModule = require(legacyCheckUpdatePath) as { runCheckUpdate?: typeof runCheckUpdate };
    const legacySharedUtilsModule = require(legacySharedUtilsPath) as {
        buildUpdateLifecycleRunner?: typeof buildUpdateLifecycleRunner;
    };

    if (typeof legacyCheckUpdateModule.runCheckUpdate !== 'function') {
        throw new Error(`Legacy runCheckUpdate export not found: ${legacyCheckUpdatePath}`);
    }
    if (typeof legacySharedUtilsModule.buildUpdateLifecycleRunner !== 'function') {
        throw new Error(`Legacy buildUpdateLifecycleRunner export not found: ${legacySharedUtilsPath}`);
    }

    return {
        runLegacyCheckUpdate: legacyCheckUpdateModule.runCheckUpdate,
        buildLegacyUpdateLifecycleRunner: legacySharedUtilsModule.buildUpdateLifecycleRunner
    };
}

function createSourcePathFixture(repoRoot: string): string {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-source-'));
    seedBundleSyncSurface(repoRoot, sourceRoot);
    return sourceRoot;
}

function createMinimalSourcePathFixture(repoRoot: string, version = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim()): string {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-min-source-'));
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(path.join(sourceRoot, 'VERSION'), `${version}\n`, 'utf8');
    fs.writeFileSync(
        path.join(sourceRoot, 'package.json'),
        JSON.stringify({ name: packageJson.name, version }, null, 2),
        'utf8'
    );
    return sourceRoot;
}

function setupUpToDateSourceWorkspace(repoRoot: string) {
    const currentVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
    const sourceRoot = createSourcePathFixture(repoRoot);
    const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, currentVersion, {
        syncSurfaceFrom: sourceRoot
    });

    return {
        currentVersion,
        sourceRoot,
        projectRoot,
        bundleRoot
    };
}

function setupCheckUpdateWorkspace(
    repoRoot: string,
    deployedVersion: string,
    options: { syncSurfaceFrom?: string | null } = {}
) {
    void repoRoot;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    if (options.syncSurfaceFrom) {
        seedBundleSyncSurface(options.syncSurfaceFrom, bundle);
    }

    // Write a specific VERSION
    fs.writeFileSync(path.join(bundle, 'VERSION'), `${deployedVersion || '1.0.0'}\n`, 'utf8');

    // Create runtime dir
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    seedWorkflowConfigCompileGateCommand(bundle);
    fs.writeFileSync(path.join(bundle, 'runtime', 'init-answers.json'), JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    }, null, 2), 'utf8');
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    return { projectRoot: tmpDir, bundleRoot: bundle };
}

function getLatestBundleBackupRoot(bundleRoot: string): string {
    const backupsRoot = path.join(bundleRoot, 'runtime', 'bundle-backups');
    const backups = fs.readdirSync(backupsRoot).sort();
    assert.ok(backups.length > 0, 'Expected at least one bundle backup');
    return path.join(backupsRoot, backups[backups.length - 1]);
}

function readLatestSyncRollbackEvidence(bundleRoot: string): Record<string, unknown> {
    const evidencePath = path.join(getLatestBundleBackupRoot(bundleRoot), 'sync-rollback-result.json');
    assert.ok(fs.existsSync(evidencePath), 'Expected sync rollback evidence to be preserved');
    return JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as Record<string, unknown>;
}

function seedActiveReviewIndexLock(bundleRoot: string) {
    const lockPath = path.join(bundleRoot, 'runtime', '.reviews-index.lock');
    const now = new Date().toISOString();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        created_at_utc: now,
        heartbeat_at_utc: now,
        command: 'reviews-index'
    }), 'utf8');
}

describe('runCheckUpdate', () => {
    const repoRoot = findRepoRoot();
    it('detects UP_TO_DATE when versions match', async () => {
        const { currentVersion, sourceRoot, projectRoot, bundleRoot } = setupUpToDateSourceWorkspace(repoRoot);
        try {
            // Point to local repo as the "remote"
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                dryRun: true,
                trustOverride: true
            });

            assert.equal(result.checkUpdateResult, 'UP_TO_DATE');
            assert.equal(result.updateAvailable, false);
            assert.equal(result.contentDriftDetected, false);
            assert.equal(result.currentVersion, currentVersion);
            assert.equal(result.trustPolicy, 'overridden');
            assert.equal(result.trustOverrideUsed, true);
            assert.equal(result.trustOverrideSource, 'cli-flag');
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('detects UPDATE_AVAILABLE when deployed version is older', async () => {
        const sourceRoot = createMinimalSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                dryRun: false,
                apply: false,
                trustOverride: true
            });

            assert.equal(result.checkUpdateResult, 'UPDATE_AVAILABLE');
            assert.equal(result.updateAvailable, true);
            assert.equal(result.currentVersion, '0.0.1');
            assert.ok(result.latestVersion);
            assert.equal(result.updateApplied, false);
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('can acquire update source from an npm package spec', async () => {
        const { currentVersion, sourceRoot, projectRoot, bundleRoot } = setupUpToDateSourceWorkspace(repoRoot);
        try {
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                packageSpec: sourceRoot,
                noPrompt: true,
                dryRun: true,
                trustOverride: true,
                async npmInstallRunner(args) {
                    const prefixIndex = args.indexOf('--prefix');
                    assert.notEqual(prefixIndex, -1);
                    const installRoot = args[prefixIndex + 1];
                    const packageRoot = path.join(installRoot, 'node_modules', 'garda-agent-orchestrator');
                    seedBundleSyncSurface(sourceRoot, packageRoot);
                    return {
                        cancelled: false,
                        timedOut: false,
                        exitCode: 0,
                        stdout: '',
                        stderr: ''
                    };
                }
            });

            assert.equal(result.checkUpdateResult, 'UP_TO_DATE');
            assert.equal(result.sourceType, 'npm');
            assert.equal(result.packageSpec, sourceRoot);
            assert.equal(result.requestedPackageSpec, sourceRoot);
            assert.equal(result.exactPackageSpec, sourceRoot);
            assert.equal(result.resolvedPackageVersion, null);
            assert.equal(result.resolvedPackageIntegrity, null);
            assert.equal(result.releaseProvenanceStatus, 'TRUST_OVERRIDE_UNVERIFIED');
            assert.equal(result.updateAvailable, false);
            assert.equal(result.currentVersion, currentVersion);
            const updateTempRoot = getUpdateTempRoot(path.join(bundleRoot, 'runtime'));
            const tempEntries = fs.existsSync(updateTempRoot) ? fs.readdirSync(updateTempRoot) : [];
            assert.deepEqual(tempEntries.filter((entry) => entry.startsWith('npm-')), []);
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('treats same-version local source drift as update available and applies refresh', async () => {
        const currentVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        const sourceRoot = createSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, currentVersion, {
            syncSurfaceFrom: sourceRoot
        });

        try {
            fs.appendFileSync(
                path.join(sourceRoot, 'template', 'docs', 'agent-rules', '80-task-workflow.md'),
                '\n<!-- same-version refresh sentinel -->\n',
                'utf8'
            );

            const probeResult = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                dryRun: true,
                apply: false,
                trustOverride: true
            });

            assert.equal(probeResult.currentVersion, currentVersion);
            assert.equal(probeResult.latestVersion, currentVersion);
            assert.equal(probeResult.versionDiffDetected, false);
            assert.equal(probeResult.contentDriftDetected, true);
            assert.ok(probeResult.driftedSyncItems.includes('template'));
            assert.equal(probeResult.updateAvailable, true);
            assert.equal(probeResult.checkUpdateResult, 'UPDATE_AVAILABLE');

            let updateRunnerCalled = false;
            const applyResult = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    updateRunnerCalled = true;
                }
            });

            assert.ok(updateRunnerCalled, 'same-version local refresh must execute lifecycle runner');
            assert.equal(applyResult.updateApplied, true);
            assert.equal(applyResult.checkUpdateResult, 'UPDATED');
            assert.ok(applyResult.syncedItems.includes('template'));
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('applies update through the deployed lifecycle runner without self-locking', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1', {
            syncSurfaceFrom: repoRoot
        });

        try {
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: buildUpdateLifecycleRunner(bundleRoot, false)
            });

            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.equal(result.updateApplied, true);
            assert.notEqual(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '0.0.1');
            assertOriginalBundleSnapshot(projectRoot, bundleRoot);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('applies update through a legacy lifecycle runner that omits lifecycleLockAlreadyHeld', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1', {
            syncSurfaceFrom: repoRoot
        });

        try {
            const legacyRunner = buildUpdateLifecycleRunner(bundleRoot, false);
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner(runnerOptions) {
                    legacyRunner({
                        ...runnerOptions,
                        lifecycleLockAlreadyHeld: undefined
                    });
                }
            });

            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.equal(result.updateApplied, true);
            assert.notEqual(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '0.0.1');
            assertOriginalBundleSnapshot(projectRoot, bundleRoot);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rejects a damaged locked release tarball before package acquisition', (context) => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-damaged-release-'));
        context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
        const damagedPath = path.join(fixtureRoot, FIRST_NPM_RELEASE_FILENAME);
        const bytes = fs.readFileSync(getLockedLegacyPackageSpec(repoRoot));
        bytes[0] ^= 1;
        fs.writeFileSync(damagedPath, bytes);
        assert.throws(() => getLockedLegacyPackageSpec(repoRoot, damagedPath), /tarball integrity mismatch/u);
    });

    it('covers network-enabled npm acquisition from the pinned published release', { skip: !NPM_NETWORK_TESTS_ENABLED }, async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                packageSpec: FIRST_NPM_RELEASE_PACKAGE_SPEC,
                noPrompt: true,
                dryRun: true,
                trustOverride: true
            });
            assert.equal(result.sourceType, 'npm');
            assert.equal(result.latestVersion, '1.0.0');
            assert.equal(result.updateAvailable, true);
            assert.equal(result.updateApplied, false);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('updates from the locked local 1.0.0 tarball through the npm-backed legacy caller path without registry access', async () => {
        const candidateTarball = createCandidateTarball(repoRoot);
        try {
            const { projectRoot, bundleRoot } = setupPublishedReleaseSeededCheckUpdateWorkspace(getLockedLegacyPackageSpec(repoRoot));
            try {
                const legacyUpdateSourceBefore = fs.readFileSync(path.join(bundleRoot, 'src', 'lifecycle', 'update.ts'), 'utf8');
                assert.doesNotMatch(legacyUpdateSourceBefore, /hasLegacyOuterUpdateLock/);

                const {
                    runLegacyCheckUpdate,
                    buildLegacyUpdateLifecycleRunner
                } = loadLegacyUpdateCaller(bundleRoot);

                const result = await runLegacyCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    packageSpec: candidateTarball.tarballPath,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: buildLegacyUpdateLifecycleRunner(bundleRoot, false)
                });

                assert.equal(result.sourceType, 'npm');
                assert.equal(result.currentVersion, '1.0.0');
                assert.equal(result.latestVersion, NEXT_RELEASE_TEST_VERSION);
                assert.equal(result.checkUpdateResult, 'UPDATED');
                assert.equal(result.updateApplied, true);

                // The 1.0.0 caller executes from its source tree during this in-flight update,
                // while current packages intentionally install a compiled-only runtime.
                const updatedRuntime = fs.readFileSync(
                    path.join(bundleRoot, 'dist', 'src', 'lifecycle', 'update', 'update.js'),
                    'utf8'
                );
                assert.match(updatedRuntime, /hasLegacyOuterUpdateLock/);
                assert.equal(
                    fs.readFileSync(
                        path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-command-reference.md'),
                        'utf8'
                    ),
                    fs.readFileSync(
                        path.join(bundleRoot, 'template', 'docs', 'agent-rules', '40-command-reference.md'),
                        'utf8'
                    )
                );
            } finally {
                removePathRecursive(projectRoot);
            }
        } finally {
            removePathRecursive(candidateTarball.tempRoot);
        }
    });

    it('reports DRY_RUN_UPDATE_AVAILABLE when apply + dryRun', async () => {
        const sourceRoot = createMinimalSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                dryRun: true,
                apply: true,
                trustOverride: true
            });

            assert.equal(result.checkUpdateResult, 'DRY_RUN_UPDATE_AVAILABLE');
            assert.equal(result.updateAvailable, true);
            assert.ok(result.syncedItems.length > 0);
            assert.equal(result.updateApplied, false);
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('applies update with updateRunner callback', async () => {
        const sourceRoot = createMinimalSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            let updateRunnerCalled = false;

            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    updateRunnerCalled = true;
                }
            });

            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.equal(result.updateApplied, true);
            assert.ok(updateRunnerCalled);
            assert.ok(result.syncItemsUpdated > 0);
            assert.equal(result.syncRollbackStatus, 'NOT_TRIGGERED');
            assert.ok(fs.existsSync(result.syncBackupMetadataPath));
            assert.equal(result.trustOverrideUsed, true);
            assert.equal(result.trustOverrideSource, 'cli-flag');
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('blocks check-update apply when a review index runtime lock exists before bundle sync', async () => {
        const sourceRoot = createSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const originalDistContent = 'original dist sentinel';
            fs.mkdirSync(path.join(bundleRoot, 'dist'), { recursive: true });
            fs.writeFileSync(path.join(bundleRoot, 'dist', 'sentinel.txt'), originalDistContent, 'utf8');
            fs.mkdirSync(path.join(sourceRoot, 'dist'), { recursive: true });
            fs.writeFileSync(path.join(sourceRoot, 'dist', 'sentinel.txt'), 'updated dist sentinel', 'utf8');
            seedActiveReviewIndexLock(bundleRoot);

            let updateRunnerCalled = false;
            await assert.rejects(
                () => runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: sourceRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: () => {
                        updateRunnerCalled = true;
                    }
                }),
                /Runtime update preflight blocked apply.*review-artifact:\.reviews-index\.lock/
            );

            assert.equal(updateRunnerCalled, false, 'updateRunner must not execute while review locks exist');
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'dist', 'sentinel.txt'), 'utf8'), originalDistContent);
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'bundle-backups')), 'apply must stop before bundle sync starts');
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('revalidates workspace state after lock acquisition and skips redundant apply', async () => {
        const latestVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        const sourceRoot = createSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            let releaseBlocker!: () => void;
            let blockerEntered!: () => void;
            let updateRunnerCalled = false;
            const blockerEnteredPromise = new Promise<void>((resolve) => {
                blockerEntered = resolve;
            });
            const blockerReleasePromise = new Promise<void>((resolve) => {
                releaseBlocker = resolve;
            });

            const blocker = withLifecycleOperationLockAsync(projectRoot, 'concurrent-update', async () => {
                seedBundleSyncSurface(sourceRoot, bundleRoot);
                fs.writeFileSync(path.join(bundleRoot, 'VERSION'), `${latestVersion}\n`, 'utf8');
                blockerEntered();
                await blockerReleasePromise;
            });

            await blockerEnteredPromise;

            const resultPromise = runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    updateRunnerCalled = true;
                }
            });

            releaseBlocker();
            await blocker;

            const result = await resultPromise;
            assert.equal(updateRunnerCalled, false, 'updateRunner must not run when the workspace is already updated');
            assert.equal(result.currentVersion, latestVersion);
            assert.equal(result.latestVersion, latestVersion);
            assert.equal(result.updateAvailable, false);
            assert.equal(result.checkUpdateResult, 'UP_TO_DATE');
            assert.equal(result.updateApplied, false);
            assert.equal(result.syncItemsUpdated, 0);
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('revalidates workspace state after lock acquisition and refuses stale downgrade apply', async () => {
        const sourceRoot = createSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            fs.writeFileSync(path.join(sourceRoot, 'VERSION'), '1.5.0\n', 'utf8');

            let releaseBlocker!: () => void;
            let blockerEntered!: () => void;
            let updateRunnerCalled = false;
            const blockerEnteredPromise = new Promise<void>((resolve) => {
                blockerEntered = resolve;
            });
            const blockerReleasePromise = new Promise<void>((resolve) => {
                releaseBlocker = resolve;
            });

            const blocker = withLifecycleOperationLockAsync(projectRoot, 'concurrent-update', async () => {
                fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '9.9.9\n', 'utf8');
                blockerEntered();
                await blockerReleasePromise;
            });

            await blockerEnteredPromise;

            const resultPromise = runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    updateRunnerCalled = true;
                }
            });

            releaseBlocker();
            await blocker;

            const result = await resultPromise;
            assert.equal(updateRunnerCalled, false, 'updateRunner must not run when the workspace became newer than the source');
            assert.equal(result.currentVersion, '9.9.9');
            assert.equal(result.latestVersion, '1.5.0');
            assert.equal(result.updateAvailable, false);
            assert.equal(result.versionDiffDetected, false);
            assert.equal(result.contentDriftDetected, false);
            assert.equal(result.checkUpdateResult, 'UP_TO_DATE');
            assert.equal(result.updateApplied, false);
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('revalidates latest source version after lock acquisition when source-path mutates in place', async () => {
        const sourceRoot = createSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            fs.writeFileSync(path.join(sourceRoot, 'VERSION'), '1.5.0\n', 'utf8');

            let releaseBlocker!: () => void;
            let blockerEntered!: () => void;
            let updateRunnerCalled = false;
            const blockerEnteredPromise = new Promise<void>((resolve) => {
                blockerEntered = resolve;
            });
            const blockerReleasePromise = new Promise<void>((resolve) => {
                releaseBlocker = resolve;
            });

            const blocker = withLifecycleOperationLockAsync(projectRoot, 'concurrent-update', async () => {
                fs.writeFileSync(path.join(sourceRoot, 'VERSION'), '2.5.0\n', 'utf8');
                blockerEntered();
                await blockerReleasePromise;
            });

            await blockerEnteredPromise;

            const resultPromise = runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    updateRunnerCalled = true;
                }
            });

            releaseBlocker();
            await blocker;

            const result = await resultPromise;
            assert.equal(updateRunnerCalled, true, 'updateRunner should still execute when the source version advanced');
            assert.equal(result.currentVersion, '0.0.1');
            assert.equal(result.latestVersion, '2.5.0');
            assert.equal(result.updateAvailable, true);
            assert.equal(result.updateApplied, true);
            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '2.5.0');
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('rolls back sync on updateRunner failure', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            // Write a file that will get backed up and should be restored
            fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '0.0.1');

            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: repoRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: () => {
                        throw new Error('Simulated update failure');
                    }
                }),
                /sync rollback completed.*Simulated update failure/
            );

            // VERSION should be restored to original
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8'), '0.0.1');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('syncs public assets and restores their pre-update state when lifecycle fails', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const existingDoc = path.join(bundleRoot, 'docs', 'architecture.md');
            const newDoc = path.join(bundleRoot, 'docs', 'sbom.md');
            fs.mkdirSync(path.dirname(existingDoc), { recursive: true });
            fs.writeFileSync(existingDoc, 'previous architecture\n');
            fs.rmSync(newDoc, { force: true });
            const rollbackItems = getUpdateRollbackItems(projectRoot, path.join(bundleRoot, 'init-answers.json'));
            for (const item of PUBLIC_BUNDLE_ASSETS) {
                assert.ok(rollbackItems.includes(`garda-agent-orchestrator/${item}`));
            }
            await assert.rejects(runCheckUpdate({
                targetRoot: projectRoot, bundleRoot, sourcePath: repoRoot,
                noPrompt: true, apply: true, trustOverride: true,
                updateRunner: () => {
                    for (const item of PUBLIC_BUNDLE_ASSETS) {
                        assert.deepEqual(fs.readFileSync(path.join(bundleRoot, item)), fs.readFileSync(path.join(repoRoot, item)));
                    }
                    throw new Error('Simulated public-assets lifecycle failure');
                }
            }), /sync rollback completed.*Simulated public-assets lifecycle failure/);
            assert.equal(fs.readFileSync(existingDoc, 'utf8'), 'previous architecture\n');
            assert.equal(fs.existsSync(newDoc), false);
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '0.0.1');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('throws when deployed bundle not found', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-no-bundle-'));
        const fakeBundleRoot = path.join(tmpDir, 'other');
        fs.mkdirSync(fakeBundleRoot, { recursive: true });
        try {
            await assert.rejects(
                runCheckUpdate({
                    targetRoot: tmpDir,
                    bundleRoot: fakeBundleRoot,
                    sourcePath: repoRoot,
                    trustOverride: true
                }),
                /Deployed bundle not found/
            );
        } finally {
            removePathRecursive(tmpDir);
        }
    });

    it('throws when VERSION file is missing from deployed bundle', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-no-version-'));
        const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundle, { recursive: true });
        // Do not create VERSION file
        try {
            await assert.rejects(
                runCheckUpdate({
                    targetRoot: tmpDir,
                    bundleRoot: bundle,
                    sourcePath: repoRoot,
                    trustOverride: true
                }),
                /Current VERSION file not found/
            );
        } finally {
            removePathRecursive(tmpDir);
        }
    });

    it('throws when packageSpec and sourcePath are provided together', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    packageSpec: 'garda-agent-orchestrator@latest',
                    sourcePath: repoRoot,
                    trustOverride: true
                }),
                /either packageSpec or sourcePath/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('defers VERSION sync until after lifecycle completes', async () => {
        const sourceRoot = createMinimalSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            let versionDuringLifecycle = null;

            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    // Read VERSION during lifecycle execution - it should still be the old version
                    versionDuringLifecycle = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();
                }
            });

            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.equal(result.updateApplied, true);
            // During lifecycle, VERSION must still show the old version
            assert.equal(versionDuringLifecycle, '0.0.1',
                'VERSION must not be updated before lifecycle completes');
            // After lifecycle, VERSION should be updated
            const finalVersion = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();
            assert.notEqual(finalVersion, '0.0.1',
                'VERSION should be updated after lifecycle completes');
            assert.ok(result.syncedItems.includes('VERSION'),
                'VERSION should be listed in synced items');
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('realigns live/version.json after deferred VERSION sync completes', async () => {
        const sourceRoot = createMinimalSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            fs.mkdirSync(path.join(bundleRoot, 'live'), { recursive: true });
            fs.writeFileSync(
                path.join(bundleRoot, 'live', 'version.json'),
                JSON.stringify({ Version: '0.0.1', SourceOfTruth: 'Codex', CanonicalEntrypoint: 'AGENTS.md' }, null, 2),
                'utf8'
            );

            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {}
            });

            const finalVersion = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();
            const liveVersion = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'version.json'), 'utf8'));
            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.equal(liveVersion.Version, finalVersion);
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('rejects a hard-linked live version payload before creating sync backups', async () => {
        const sourceRoot = createMinimalSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const outside = path.join(projectRoot, 'outside-version.json');
            const content = JSON.stringify({ Version: '0.0.1' });
            fs.writeFileSync(outside, content);
            fs.linkSync(outside, path.join(bundleRoot, 'live', 'version.json'));

            await assert.rejects(runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {}
            }), /hard-linked/);
            assert.equal(fs.readFileSync(outside, 'utf8'), content);
            assert.equal(fs.existsSync(path.join(bundleRoot, 'runtime', 'bundle-backups')), false);
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('fails when lifecycle introduces a hard-linked live version payload after preflight', async () => {
        const sourceRoot = createMinimalSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const outside = path.join(projectRoot, 'outside-version.json');
            const content = JSON.stringify({ Version: 'outside' });
            fs.writeFileSync(outside, content);

            await assert.rejects(runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    fs.linkSync(outside, path.join(bundleRoot, 'live', 'version.json'));
                }
            }), /hard-linked/);
            assert.equal(fs.readFileSync(outside, 'utf8'), content);
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('rejects a hard-linked later source item before backup or earlier sync', async () => {
        const sourceRoot = createMinimalSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const outside = path.join(projectRoot, 'outside-readme.md');
            fs.writeFileSync(outside, '# Outside\n');
            fs.linkSync(outside, path.join(sourceRoot, 'README.md'));

            await assert.rejects(runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {}
            }), /hard-linked/);
            assert.equal(fs.existsSync(path.join(bundleRoot, 'package.json')), false);
            assert.equal(fs.existsSync(path.join(bundleRoot, 'runtime', 'bundle-backups')), false);
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('does not update VERSION when lifecycle fails', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '0.0.1');

            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: repoRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: () => {
                        throw new Error('Simulated lifecycle failure');
                    }
                }),
                /sync rollback completed.*Simulated lifecycle failure/
            );

            // VERSION must still be the old value - never advanced
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), '0.0.1',
                'VERSION must not advance when lifecycle fails');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('writes sentinel before lifecycle and removes it after success', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            let sentinelExistsDuringLifecycle = false;
            let sentinelDuringLifecycle: Record<string, unknown> | null = null;
            const sentinelPath = getUpdateSentinelPath(bundleRoot);

            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                updateRunner: () => {
                    sentinelExistsDuringLifecycle = fs.existsSync(sentinelPath);
                    sentinelDuringLifecycle = readUpdateSentinel(bundleRoot) as Record<string, unknown> | null;
                }
            });

            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.ok(sentinelExistsDuringLifecycle,
                'Sentinel must exist during lifecycle execution');
            assert.ok(fs.existsSync(result.syncBackupMetadataPath),
                'Sync backup metadata must be written before lifecycle execution');
            assert.ok(sentinelDuringLifecycle, 'Sentinel must be readable during lifecycle execution');
            const sentinel = sentinelDuringLifecycle as Record<string, unknown>;
            assert.equal(sentinel.phase, 'lifecycle');
            assert.equal(sentinel.syncBackupRoot, result.syncBackupRoot);
            assert.equal(sentinel.syncBackupMetadataPath, result.syncBackupMetadataPath);
            assert.deepEqual(sentinel.plannedSyncItems, BUNDLE_SYNC_ITEMS.filter((item) => item !== 'VERSION'));
            assert.ok(!fs.existsSync(sentinelPath),
                'Sentinel must be removed after successful update');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('cleans sentinel and preserves backup metadata when sync rollback succeeds', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const firstPlannedItem = BUNDLE_SYNC_ITEMS.find((item) => item !== 'VERSION' &&
                fs.existsSync(path.join(repoRoot, item)));
            assert.ok(firstPlannedItem, 'Test fixture must have at least one sync item');
            const firstBundleItemPath = path.join(bundleRoot, firstPlannedItem);
            const originalFirstItemContent = 'original first item content\n';
            fs.mkdirSync(path.dirname(firstBundleItemPath), { recursive: true });
            fs.writeFileSync(firstBundleItemPath, originalFirstItemContent, 'utf8');
            let checkedBeforeFirstSync = false;
            let syncBackupRoot: string | null = null;

            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: repoRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    _testHooks: {
                        beforeSyncItemFaultInjector: (_item, index) => {
                            if (index === 0) {
                                checkedBeforeFirstSync = true;
                                const preSyncSentinel = readUpdateSentinel(bundleRoot) as Record<string, unknown>;
                                assert.equal(preSyncSentinel.phase, 'syncing');
                                assert.equal(typeof preSyncSentinel.syncBackupRoot, 'string');
                                assert.ok(fs.existsSync(preSyncSentinel.syncBackupMetadataPath as string));
                                assert.equal(fs.readFileSync(firstBundleItemPath, 'utf8'), originalFirstItemContent);
                                syncBackupRoot = preSyncSentinel.syncBackupRoot as string;
                                throw new Error('Simulated sync interruption');
                            }
                        }
                    }
                }),
                /sync rollback completed.*Simulated sync interruption/
            );

            assert.ok(checkedBeforeFirstSync, 'Test must assert sentinel state before the first destructive sync');
            assert.equal(fs.readFileSync(firstBundleItemPath, 'utf8'), originalFirstItemContent);
            assert.ok(!fs.existsSync(getUpdateSentinelPath(bundleRoot)),
                'Sentinel must be removed after verified sync rollback');
            assert.ok(syncBackupRoot, 'Test must capture rollback backup root before failure');
            const metadata = readSyncBackupMetadata(syncBackupRoot as string);
            assert.equal(metadata.preexistingMap[firstPlannedItem], true);
            assert.deepEqual(metadata.plannedSyncItems, BUNDLE_SYNC_ITEMS.filter((item) => item !== 'VERSION'));
            const evidence = readLatestSyncRollbackEvidence(bundleRoot);
            assert.equal(evidence.status, 'SUCCESS');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('records npm update source provenance in the sentinel during apply', async () => {
        const sourceRoot = createSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            let sentinelDuringLifecycle: Record<string, unknown> | null = null;

            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                packageSpec: sourceRoot,
                noPrompt: true,
                apply: true,
                trustOverride: true,
                async npmInstallRunner(args) {
                    const prefixIndex = args.indexOf('--prefix');
                    assert.notEqual(prefixIndex, -1);
                    const installRoot = args[prefixIndex + 1];
                    const packageRoot = path.join(installRoot, 'node_modules', 'garda-agent-orchestrator');
                    seedBundleSyncSurface(sourceRoot, packageRoot);
                    return {
                        cancelled: false,
                        timedOut: false,
                        exitCode: 0,
                        stdout: '',
                        stderr: ''
                    };
                },
                updateRunner: () => {
                    sentinelDuringLifecycle = readUpdateSentinel(bundleRoot) as Record<string, unknown> | null;
                }
            });

            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.ok(sentinelDuringLifecycle, 'Sentinel must be readable during lifecycle execution');
            const sentinel = sentinelDuringLifecycle as Record<string, unknown>;
            assert.equal(sentinel.sourceType, 'npm');
            assert.equal(sentinel.sourceReference, sourceRoot);
            assert.equal(sentinel.packageSpec, sourceRoot);
            assert.equal(sentinel.requestedPackageSpec, sourceRoot);
            assert.equal(sentinel.exactPackageSpec, sourceRoot);
            assert.equal(sentinel.resolvedPackageVersion, null);
            assert.equal(sentinel.resolvedPackageIntegrity, null);
            assert.ok(!fs.existsSync(getUpdateSentinelPath(bundleRoot)),
                'Sentinel must be removed after successful update');
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('applies registry npm specs through exact install specs and resolved sentinel provenance', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            let installedSpec: string | null = null;
            let sentinelDuringLifecycle: Record<string, unknown> | null = null;
            let packageRoot = '';

            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                packageSpec: 'garda-agent-orchestrator@latest',
                noPrompt: true,
                apply: true,
                npmViewRunner(args) {
                    assert.deepEqual(args, [
                        'view',
                        'garda-agent-orchestrator@latest',
                        'version',
                        'dist.integrity',
                        '--json'
                    ]);
                    return {
                        status: 0,
                        stdout: JSON.stringify({
                            version: '9.9.9',
                            'dist.integrity': 'sha512-registry-integrity'
                        })
                    };
                },
                async npmInstallRunner(args) {
                    installedSpec = args[args.length - 1];
                    assert.equal(installedSpec, 'garda-agent-orchestrator@9.9.9');
                    const prefixIndex = args.indexOf('--prefix');
                    assert.notEqual(prefixIndex, -1);
                    const installRoot = args[prefixIndex + 1];
                    packageRoot = path.join(installRoot, 'node_modules', 'garda-agent-orchestrator');
                    seedBundleSyncSurface(repoRoot, packageRoot);
                    fs.writeFileSync(path.join(packageRoot, 'VERSION'), '9.9.9\n', 'utf8');
                    return {
                        cancelled: false,
                        timedOut: false,
                        exitCode: 0,
                        stdout: '',
                        stderr: ''
                    };
                },
                installedPackageRootResolver() {
                    return {
                        packageName: 'garda-agent-orchestrator',
                        packageRoot
                    };
                },
                updateRunner: () => {
                    sentinelDuringLifecycle = readUpdateSentinel(bundleRoot) as Record<string, unknown> | null;
                }
            });

            assert.equal(result.updateApplied, true);
            assert.equal(result.sourceReference, 'garda-agent-orchestrator@9.9.9');
            assert.equal(result.packageSpec, 'garda-agent-orchestrator@9.9.9');
            assert.equal(result.requestedPackageSpec, 'garda-agent-orchestrator@latest');
            assert.equal(result.exactPackageSpec, 'garda-agent-orchestrator@9.9.9');
            assert.equal(result.resolvedPackageVersion, '9.9.9');
            assert.equal(result.resolvedPackageIntegrity, 'sha512-registry-integrity');
            assert.equal(result.releaseProvenanceStatus, 'NPM_REGISTRY_INTEGRITY_RECORDED');
            assert.equal(installedSpec, 'garda-agent-orchestrator@9.9.9');

            assert.ok(sentinelDuringLifecycle, 'Sentinel must be readable during registry-backed apply');
            const sentinel = sentinelDuringLifecycle as Record<string, unknown>;
            assert.equal(sentinel.requestedPackageSpec, 'garda-agent-orchestrator@latest');
            assert.equal(sentinel.exactPackageSpec, 'garda-agent-orchestrator@9.9.9');
            assert.equal(sentinel.resolvedPackageVersion, '9.9.9');
            assert.equal(sentinel.resolvedPackageIntegrity, 'sha512-registry-integrity');
            assert.equal(sentinel.releaseProvenanceStatus, 'NPM_REGISTRY_INTEGRITY_RECORDED');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('cleans sentinel after verified lifecycle failure rollback', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const sentinelPath = getUpdateSentinelPath(bundleRoot);
            let syncBackupRoot: string | null = null;

            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: repoRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: () => {
                        const sentinel = readUpdateSentinel(bundleRoot) as Record<string, unknown>;
                        syncBackupRoot = sentinel.syncBackupRoot as string;
                        throw new Error('Simulated failure');
                    }
                }),
                /Simulated failure/
            );

            assert.ok(!fs.existsSync(sentinelPath),
                'Sentinel must be removed after verified sync rollback');
            assert.ok(syncBackupRoot, 'Test must capture rollback backup root before failure');
            const metadata = readSyncBackupMetadata(syncBackupRoot as string);
            assert.equal(metadata.preexistingMap.VERSION, true);
            const evidence = readLatestSyncRollbackEvidence(bundleRoot);
            assert.equal(evidence.status, 'SUCCESS');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('restores package and dist after lifecycle install failure rollback', async () => {
        const sourceRoot = createSourcePathFixture(repoRoot);
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1', {
            syncSurfaceFrom: repoRoot
        });
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                skipVerify: true,
                skipManifestValidation: true
            });

            const oldPackage = {
                name: 'garda-agent-orchestrator',
                version: '0.0.1',
                rollbackMarker: 'old-package'
            };
            const newPackage = {
                name: 'garda-agent-orchestrator',
                version: '1.1.0',
                rollbackMarker: 'new-package'
            };
            const distRelativePath = path.join('dist', 'src', 'core', 'task-md-table.js');
            const oldDist = 'exports.legacyOnly = true;\n';
            const newDist = 'exports.formatActiveTaskQueueTable = function () {};\n';

            fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify(oldPackage, null, 2), 'utf8');
            fs.mkdirSync(path.dirname(path.join(bundleRoot, distRelativePath)), { recursive: true });
            fs.writeFileSync(path.join(bundleRoot, distRelativePath), oldDist, 'utf8');
            writeProtectedControlPlaneManifest(projectRoot);

            fs.writeFileSync(path.join(sourceRoot, 'VERSION'), '1.1.0\n', 'utf8');
            fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify(newPackage, null, 2), 'utf8');
            fs.mkdirSync(path.dirname(path.join(sourceRoot, distRelativePath)), { recursive: true });
            fs.writeFileSync(path.join(sourceRoot, distRelativePath), newDist, 'utf8');

            let lifecycleSawNewPackage = false;
            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: sourceRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: () => {
                        const packageDuringLifecycle = JSON.parse(
                            fs.readFileSync(path.join(bundleRoot, 'package.json'), 'utf8')
                        ) as Record<string, unknown>;
                        lifecycleSawNewPackage = packageDuringLifecycle.rollbackMarker === 'new-package';
                        throw new Error('INSTALL_EXPORT_FAIL');
                    }
                }),
                /sync rollback completed.*INSTALL_EXPORT_FAIL/
            );

            assert.equal(lifecycleSawNewPackage, true, 'Lifecycle must fail after destructive bundle sync');
            assert.deepEqual(
                JSON.parse(fs.readFileSync(path.join(bundleRoot, 'package.json'), 'utf8')),
                oldPackage
            );
            assert.equal(fs.readFileSync(path.join(bundleRoot, distRelativePath), 'utf8'), oldDist);
            assert.ok(!fs.existsSync(getUpdateSentinelPath(bundleRoot)),
                'Sentinel must be removed after package/dist rollback verifies');
            const evidence = readLatestSyncRollbackEvidence(bundleRoot);
            assert.equal(evidence.status, 'SUCCESS');
            assert.equal(evidence.originalError, 'INSTALL_EXPORT_FAIL');
            assert.equal(evidence.syncBackupMetadataPath, path.join(getLatestBundleBackupRoot(bundleRoot), 'sync-backup-metadata.json'));
            assert.ok(Array.isArray(evidence.restoredItems), 'Sync rollback evidence must list restored items');
            assert.ok((evidence.restoredItems as unknown[]).includes('package.json'));
            assert.ok((evidence.restoredItems as unknown[]).includes('dist'));
            assert.ok((evidence.restoredItems as unknown[]).includes('VERSION'));
            const doctorResult = runDoctor({
                targetRoot: projectRoot,
                sourceOfTruth: 'Codex'
            });
            assert.equal(
                doctorResult.passed,
                true,
                [
                    'Doctor must pass after successful sync rollback',
                    ...doctorResult.partialStateEvidence.violations,
                    ...(doctorResult.verifyResult.violations
                        ? Object.values(doctorResult.verifyResult.violations).flat()
                        : []),
                    ...(doctorResult.manifestResult?.diagnostics.map((diagnostic) => diagnostic.message) ?? []),
                    ...(doctorResult.manifestError ? [doctorResult.manifestError] : []),
                    JSON.stringify({
                        parityResult: doctorResult.parityResult,
                        protectedManifestAssessment: doctorResult.protectedManifestAssessment,
                        lockHealth: doctorResult.lockHealth,
                        reviewLockHealth: doctorResult.reviewLockHealth,
                        completionFinalizationLockHealth: doctorResult.completionFinalizationLockHealth,
                        providerComplianceResult: doctorResult.providerComplianceResult,
                        runtimeMismatchEvidence: doctorResult.runtimeMismatchEvidence,
                        permissionEvidence: doctorResult.permissionEvidence,
                        rollbackHealthEvidence: doctorResult.rollbackHealthEvidence,
                        profileHealthEvidence: doctorResult.profileHealthEvidence
                    }, null, 2)
                ].join('\n')
            );
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('rejects arbitrary extra src files after rollback verification with running script path', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const backupRoot = path.join(bundleRoot, 'runtime', 'bundle-backups', 'verify-extra');
            const backupSrc = path.join(backupRoot, 'src');
            const destinationSrc = path.join(bundleRoot, 'src');
            const runningScriptPath = path.join(destinationSrc, 'bin', 'garda.js');

            fs.mkdirSync(path.join(backupSrc, 'bin'), { recursive: true });
            fs.writeFileSync(path.join(backupSrc, 'bin', 'index.js'), 'backup index\n', 'utf8');
            fs.mkdirSync(path.dirname(runningScriptPath), { recursive: true });
            fs.writeFileSync(path.join(destinationSrc, 'bin', 'index.js'), 'backup index\n', 'utf8');
            fs.writeFileSync(runningScriptPath, 'current running script\n', 'utf8');

            assert.doesNotThrow(() => verifySyncedItemsRestoredFromBackup(
                bundleRoot,
                backupRoot,
                { src: true },
                runningScriptPath
            ));

            fs.writeFileSync(path.join(destinationSrc, 'bin', 'unexpected.js'), 'leftover\n', 'utf8');

            assert.throws(
                () => verifySyncedItemsRestoredFromBackup(
                    bundleRoot,
                    backupRoot,
                    { src: true },
                    runningScriptPath
                ),
                /differs from rollback backup/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('accepts signal option without error on sourcePath flow', async () => {
        const { sourceRoot, projectRoot, bundleRoot } = setupUpToDateSourceWorkspace(repoRoot);
        try {
            const ac = new AbortController();
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                dryRun: true,
                trustOverride: true,
                signal: ac.signal
            });
            assert.equal(result.checkUpdateResult, 'UP_TO_DATE');
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('accepts onProgress option without error', async () => {
        const { sourceRoot, projectRoot, bundleRoot } = setupUpToDateSourceWorkspace(repoRoot);
        try {
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceRoot,
                noPrompt: true,
                dryRun: true,
                trustOverride: true,
                onProgress: () => {}
            });
            assert.equal(result.checkUpdateResult, 'UP_TO_DATE');
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('npm install streams progress via onProgress callback', async () => {
        const currentVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, currentVersion);
        try {
            const progressChunks: string[] = [];
            let installedSpec: string | null = null;
            let packageRoot = '';
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                packageSpec: repoRoot,
                noPrompt: true,
                dryRun: true,
                trustOverride: true,
                onProgress: (chunk) => { progressChunks.push(chunk); },
                async npmInstallRunner(args, options) {
                    installedSpec = args[args.length - 1] ?? null;
                    const prefixIndex = args.indexOf('--prefix');
                    assert.notEqual(prefixIndex, -1);
                    const installRoot = args[prefixIndex + 1];
                    assert.ok(installRoot);
                    packageRoot = path.join(installRoot, 'node_modules', 'garda-agent-orchestrator');
                    seedBundleSyncSurface(repoRoot, packageRoot);
                    options.onStderr?.('npm progress: installing local fixture\n');
                    return {
                        cancelled: false,
                        timedOut: false,
                        exitCode: 0,
                        stdout: '',
                        stderr: 'npm progress: installing local fixture\n'
                    };
                },
                installedPackageRootResolver() {
                    return {
                        packageName: 'garda-agent-orchestrator',
                        packageRoot
                    };
                }
            });
            assert.equal(result.sourceType, 'npm');
            assert.equal(installedSpec, repoRoot);
            assert.deepEqual(progressChunks, ['npm progress: installing local fixture\n']);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('classifies missing VERSION in an update source path', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        const invalidSourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-invalid-source-'));
        try {
            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: invalidSourceRoot,
                    noPrompt: true,
                    dryRun: true,
                    trustOverride: true
                }),
                (error) => {
                    assert.match((error as Error).message, /DiagnosticCode: UPDATE_SOURCE_VERSION_MISSING/);
                    assert.match((error as Error).message, /DiagnosticSource:/);
                    assert.match((error as Error).message, /DiagnosticHint:/);
                    return true;
                }
            );
        } finally {
            removePathRecursive(invalidSourceRoot);
            removePathRecursive(projectRoot);
        }
    });

    it('restores previous VERSION when deferred VERSION copy fails', async (context) => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            // Create a source directory that has a VERSION whose copy will fail.
            // We achieve this by making the source VERSION path point at a directory
            // (fs.copyFileSync throws EISDIR when the source is a directory).
            const fakeSourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-t092-src-'));
            context.after(() => removePathRecursive(fakeSourceRoot));
            // Seed the fake source with a minimal VERSION that is a *directory*,
            // which will make fs.copyFileSync throw during the deferred copy.
            const fakeVersionPath = path.join(fakeSourceRoot, 'VERSION');
            // First create a normal VERSION so the pre-check passes...
            fs.writeFileSync(fakeVersionPath, '9.9.9');
            // Copy at least one sync item so the sync loop has work to do.
            const fakeBinPath = path.join(fakeSourceRoot, 'bin');
            fs.mkdirSync(fakeBinPath, { recursive: true });
            fs.writeFileSync(path.join(fakeBinPath, 'stub.js'), '// stub');

            // We need the updateRunner to succeed (lifecycle passes) but then
            // the deferred VERSION copy to fail.  Replace the source VERSION
            // with a directory after lifecycle runs.
            let lifecycleCallCount = 0;
            const fakeUpdateRunner = () => {
                lifecycleCallCount++;
                // Swap the source VERSION file to a directory so copyFileSync
                // will throw EISDIR on the deferred copy.
                fs.unlinkSync(fakeVersionPath);
                fs.mkdirSync(fakeVersionPath, { recursive: true });
            };

            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: fakeSourceRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: fakeUpdateRunner
                }),
                (error) => {
                    // The error should propagate (it wraps the copyFileSync failure).
                    return error instanceof Error;
                }
            );

            assert.equal(lifecycleCallCount, 1, 'updateRunner should have been called');
            // The previous VERSION must be restored despite the late failure.
            assert.ok(fs.existsSync(path.join(bundleRoot, 'VERSION')),
                'VERSION file must still exist after deferred copy failure');
            assert.equal(
                fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(),
                '0.0.1',
                'VERSION must be restored to its previous value (T-092)'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('restores previous VERSION when apply fails after deferred VERSION sync', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            const liveVersionPath = path.join(bundleRoot, 'live', 'version.json');
            fs.mkdirSync(path.dirname(liveVersionPath), { recursive: true });
            fs.writeFileSync(liveVersionPath, JSON.stringify({
                Version: '0.0.1',
                UpdatedAt: 'before-update'
            }, null, 2) + '\n', 'utf8');
            let lifecycleStartedAt: unknown = null;
            let versionDeferredStartedAt: unknown = null;
            let versionDeferredSyncBackupRoot: string | null = null;

            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: repoRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    updateRunner: () => {
                        lifecycleStartedAt = (readUpdateSentinel(bundleRoot) as Record<string, unknown>).startedAt;
                    },
                    _testHooks: {
                        afterDeferredVersionSync: () => {
                            const sentinel = readUpdateSentinel(bundleRoot) as Record<string, unknown>;
                            assert.equal(sentinel.phase, 'version_deferred');
                            versionDeferredStartedAt = sentinel.startedAt;
                            versionDeferredSyncBackupRoot = sentinel.syncBackupRoot as string;
                            throw new Error('Simulated post-version failure');
                        }
                    }
                }),
                /sync rollback completed.*Simulated post-version failure/
            );

            assert.equal(
                fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(),
                '0.0.1',
                'VERSION must roll back when a later apply step fails after deferred sync'
            );
            assert.equal(
                JSON.parse(fs.readFileSync(liveVersionPath, 'utf8')).Version,
                '0.0.1',
                'live/version.json must roll back with VERSION after a later apply failure'
            );
            assert.ok(!fs.existsSync(getUpdateSentinelPath(bundleRoot)),
                'Sentinel must be removed after verified deferred-version rollback');
            assert.equal(lifecycleStartedAt, versionDeferredStartedAt,
                'Sentinel startedAt must remain stable across phase updates');
            assert.ok(versionDeferredSyncBackupRoot, 'Test must capture deferred-version backup root');
            const metadata = readSyncBackupMetadata(versionDeferredSyncBackupRoot as string);
            assert.equal(metadata.preexistingMap.VERSION, true);
            assert.equal(metadata.preexistingMap['live/version.json'], true);
            const evidence = readLatestSyncRollbackEvidence(bundleRoot);
            assert.equal(evidence.status, 'SUCCESS');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('restores previous VERSION for VERSION-only sources when a later apply step fails', async () => {
        const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-version-only-source-'));
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, '0.0.1');
        try {
            fs.writeFileSync(path.join(sourceRoot, 'VERSION'), '9.9.9\n', 'utf8');

            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: sourceRoot,
                    noPrompt: true,
                    apply: true,
                    trustOverride: true,
                    _testHooks: {
                        afterDeferredVersionSync: () => {
                            throw new Error('Simulated version-only post-sync failure');
                        }
                    }
                }),
                /sync rollback completed.*Simulated version-only post-sync failure/
            );

            assert.equal(
                fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(),
                '0.0.1',
                'VERSION-only apply failures must restore the previous VERSION'
            );
        } finally {
            removePathRecursive(sourceRoot);
            removePathRecursive(projectRoot);
        }
    });
});
