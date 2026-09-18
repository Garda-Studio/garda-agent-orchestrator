import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

const RETRYABLE_WINDOWS_CLEANUP_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
const SPAWN_OUTPUT_TAIL_LENGTH = 4000;
const CONSUMER_INSTALL_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
const FORBIDDEN_PUBLISHED_ROOTS = ['.node-build', '.scripts-build', 'src', 'tests'];
const NPM_PACK_TIMEOUT_MS = 120_000;
const NPM_INSTALL_TARBALL_TIMEOUT_MS = process.platform === 'win32' ? 300_000 : 120_000;
const LOCAL_TARBALL_INSTALL_BUDGET_MS = process.platform === 'win32' ? 180_000 : 60_000;
const CLI_COLD_START_BUDGET_MS = 10_000;

function getErrorCode(error: unknown): string {
    return error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
}

function removePackSmokeTempRoot(tempRoot: string): void {
    try {
        fs.rmSync(tempRoot, {
            recursive: true,
            force: true,
            maxRetries: process.platform === 'win32' ? 10 : 3,
            retryDelay: 100
        });
    } catch (error: unknown) {
        const errorCode = getErrorCode(error);
        if (process.platform === 'win32' && RETRYABLE_WINDOWS_CLEANUP_CODES.has(errorCode)) {
            console.warn(`pack-smoke temp cleanup skipped after retryable Windows ${errorCode}: ${tempRoot}`);
            return;
        }
        throw error;
    }
}

function loadPackFixtureItems(repoRoot: string): string[] {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const items = new Set<string>(pkgJson.files || []);
    items.delete('dist');
    items.delete('bin');
    items.add('src');
    items.add('package.json');
    items.add('scripts/package-legacy-entrypoint-compat.cjs');
    items.add('scripts/node-foundation');
    items.add('tsconfig.build.json');
    items.add('tsconfig.scripts.json');
    return Array.from(items).sort();
}

function copyPackFixture(repoRoot: string, fixtureRoot: string): void {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    for (const relativePath of loadPackFixtureItems(repoRoot)) {
        const src = path.join(repoRoot, relativePath);
        if (!fs.existsSync(src)) continue;
        fs.cpSync(src, path.join(fixtureRoot, relativePath), { recursive: true });
    }
    const legacyClaudeRelativePath = 'template/CLAUDE.md';
    const trackedLegacyTemplate = spawnGit(['ls-files', '--', legacyClaudeRelativePath], repoRoot);
    if (trackedLegacyTemplate.status !== 0) {
        throw new Error(formatSpawnFailure('git ls-files template/CLAUDE.md', trackedLegacyTemplate));
    }
    assert.equal(
        trackedLegacyTemplate.stdout.trim(),
        '',
        'source tree must not store template/CLAUDE.md in Git'
    );
    fs.rmSync(path.join(fixtureRoot, ...legacyClaudeRelativePath.split('/')), { force: true });
    // Symlink node_modules so tsc is available for the publish-runtime build
    const realNodeModules = path.join(repoRoot, 'node_modules');
    const fixtureNodeModules = path.join(fixtureRoot, 'node_modules');
    if (fs.existsSync(realNodeModules) && !fs.existsSync(fixtureNodeModules)) {
        fs.symlinkSync(realNodeModules, fixtureNodeModules, 'junction');
    }
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

function buildPackagingEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
}

function spawnNpm(args: string[], cwd: string, timeoutMs = NPM_PACK_TIMEOUT_MS): childProcess.SpawnSyncReturns<string> {
    if (process.platform === 'win32') {
        const commandLine = ['npm.cmd', ...args].map(quoteWindowsArgument).join(' ');
        return childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
            cwd,
            encoding: 'utf8',
            timeout: timeoutMs,
            windowsHide: true
        });
    }

    return childProcess.spawnSync('npm', args, {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true
    });
}

function spawnGit(args: string[], cwd: string): childProcess.SpawnSyncReturns<string> {
    return childProcess.spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true
    });
}

function formatSpawnFailure(label: string, result: childProcess.SpawnSyncReturns<string>): string {
    const lines = [`${label} failed:`];
    if (result.error) lines.push(`error=${result.error.message}`);
    if (result.status !== null) lines.push(`exit=${result.status}`);
    if (result.signal) lines.push(`signal=${result.signal}`);
    if (result.stdout) lines.push(`stdout:\n${tailOutput(result.stdout)}`);
    if (result.stderr) lines.push(`stderr:\n${tailOutput(result.stderr)}`);
    return lines.join('\n');
}

function tailOutput(output: string): string {
    if (output.length <= SPAWN_OUTPUT_TAIL_LENGTH) {
        return output;
    }
    return `[truncated to last ${SPAWN_OUTPUT_TAIL_LENGTH} chars]\n${output.slice(-SPAWN_OUTPUT_TAIL_LENGTH)}`;
}

function runGit(args: string[], cwd: string): void {
    const result = spawnGit(args, cwd);
    if (result.status !== 0) {
        throw new Error(formatSpawnFailure(`git ${args.join(' ')}`, result));
    }
}

function initializeCleanPackFixture(repoRoot: string): void {
    fs.writeFileSync(
        path.join(repoRoot, '.gitignore'),
        [
            'node_modules/',
            '.scripts-build/',
            '.scripts-build.lock/',
            '.node-build/',
            '.node-build.lock/',
            '*.tgz',
            ''
        ].join('\n'),
        'utf8'
    );

    const buildResult = spawnNpm(['run', 'build:publish-runtime'], repoRoot);
    if (buildResult.status !== 0) {
        throw new Error(formatSpawnFailure('npm run build:publish-runtime', buildResult));
    }

    runGit(['-c', 'init.defaultBranch=main', 'init'], repoRoot);
    runGit(['config', 'user.email', 'test@example.com'], repoRoot);
    runGit(['config', 'user.name', 'Garda Test'], repoRoot);
    runGit(['add', '-A'], repoRoot);
    runGit(['commit', '--no-gpg-sign', '-m', 'pack fixture baseline'], repoRoot);
}

function assertNoConsumerInstallLifecycleScripts(packageJson: { scripts?: Record<string, string> }): void {
    const scripts = packageJson.scripts || {};
    for (const scriptName of CONSUMER_INSTALL_LIFECYCLE_SCRIPTS) {
        assert.equal(
            scripts[scriptName],
            undefined,
            `packed package must not run ${scriptName} during consumer install`
        );
    }
}

function assertCompiledOnlyPackageSurface(packageJson: { files?: unknown[] }, packageRoot?: string): void {
    const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
    assert.ok(!packageFiles.includes('src'), 'package.json files must exclude the TypeScript src tree');

    if (!packageRoot) return;
    for (const forbiddenRoot of FORBIDDEN_PUBLISHED_ROOTS) {
        assert.ok(
            !fs.existsSync(path.join(packageRoot, forbiddenRoot)),
            `installed package must not include ${forbiddenRoot}`
        );
    }
}

function packageFileIsPresent(packageRoot: string, relativePath: string): boolean {
    const normalizedPath = relativePath.replace(/\\/gu, '/');
    return fs.existsSync(path.join(packageRoot, normalizedPath));
}

function assertInstalledMarkdownRelativeLinks(packageRoot: string): void {
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const packageFiles: unknown[] = Array.isArray(packageJson.files) ? packageJson.files : [];
    const markdownFiles = packageFiles
        .filter((entry: unknown): entry is string => typeof entry === 'string' && entry.endsWith('.md'))
        .filter((entry: string) => packageFileIsPresent(packageRoot, entry));
    const markdownLinkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
    const missingLinks: string[] = [];

    for (const markdownFile of markdownFiles) {
        const source = fs.readFileSync(path.join(packageRoot, markdownFile), 'utf8');
        for (const match of source.matchAll(markdownLinkPattern)) {
            const rawTarget = match[1];
            if (!rawTarget || /^(?:https?:|mailto:|#)/iu.test(rawTarget)) {
                continue;
            }
            const targetWithoutAnchor = rawTarget.split('#')[0];
            if (!targetWithoutAnchor || targetWithoutAnchor.startsWith('/')) {
                continue;
            }
            const decodedTarget = decodeURIComponent(targetWithoutAnchor);
            const resolvedTarget = path
                .normalize(path.join(path.dirname(markdownFile), decodedTarget))
                .replace(/\\/gu, '/');
            if (!packageFileIsPresent(packageRoot, resolvedTarget)) {
                missingLinks.push(`${markdownFile} -> ${rawTarget} (${resolvedTarget})`);
            }
        }
    }

    assert.deepEqual(missingLinks, [], 'installed package markdown must not contain broken relative links');
}

function npmPack(repoRoot: string): string {
    const legacyClaudeTemplatePath = path.join(repoRoot, 'template', 'CLAUDE.md');
    assert.ok(
        !fs.existsSync(legacyClaudeTemplatePath),
        'fixture source tree must not start with a stored template/CLAUDE.md'
    );

    const result = spawnNpm(['pack', '--pack-destination', repoRoot], repoRoot);

    if (result.status !== 0) {
        throw new Error(formatSpawnFailure('npm pack', result));
    }

    assert.ok(
        !fs.existsSync(legacyClaudeTemplatePath),
        'postpack must remove the generated legacy template/CLAUDE.md from the package source tree'
    );

    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    return lines[lines.length - 1].trim();
}

function npmInstallTarball(tarballPath: string, installDir: string): number {
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(
        path.join(installDir, 'package.json'),
        JSON.stringify({ name: 'gao-smoke-test', version: '0.0.0', private: true }, null, 2),
        'utf8'
    );

    const startedAt = performance.now();
    const result = spawnNpm([
        'install',
        '--ignore-scripts',
        '--prefer-offline',
        '--no-fund',
        '--no-audit',
        '--no-progress',
        '--no-save',
        '--package-lock=false',
        tarballPath
    ], installDir, NPM_INSTALL_TARBALL_TIMEOUT_MS);
    const durationMs = Math.round(performance.now() - startedAt);

    if (result.status !== 0) {
        throw new Error(formatSpawnFailure(`npm install (timeout ${NPM_INSTALL_TARBALL_TIMEOUT_MS}ms)`, result));
    }
    return durationMs;
}

function runCli(cliScriptPath: string, args: string[], cwd: string): childProcess.SpawnSyncReturns<string> {
    return childProcess.spawnSync(
        process.execPath,
        [cliScriptPath, ...args],
        {
            cwd,
            encoding: 'utf8',
            env: buildPackagingEnv(),
            timeout: 30_000
        }
    );
}

test('npm pack -> install -> CLI invoke smoke test', () => {
    const repoRoot = getRepoRoot();
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const expectedVersion = packageJson.version;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pack-smoke-'));
    const fixtureRoot = path.join(tempRoot, 'pack-repo');
    const installRoot = path.join(tempRoot, 'install-root');

    try {
        assertNoConsumerInstallLifecycleScripts(packageJson);
        assertCompiledOnlyPackageSurface(packageJson);
        copyPackFixture(repoRoot, fixtureRoot);
        initializeCleanPackFixture(fixtureRoot);

        const tarballFilename = npmPack(fixtureRoot);
        const tarballPath = path.join(fixtureRoot, tarballFilename);

        assert.ok(fs.existsSync(tarballPath), `Tarball not found at ${tarballPath}`);

        const installDurationMs = npmInstallTarball(tarballPath, installRoot);
        assert.ok(
            installDurationMs <= LOCAL_TARBALL_INSTALL_BUDGET_MS,
            `local tarball install exceeded budget: observed=${installDurationMs}ms budget=${LOCAL_TARBALL_INSTALL_BUDGET_MS}ms`
        );

        const installedPackageRoot = path.join(installRoot, 'node_modules', 'garda-agent-orchestrator');
        assert.ok(fs.existsSync(installedPackageRoot), 'Installed package root must exist');

        const cliScript = path.join(installedPackageRoot, 'bin', 'garda.js');
        assert.ok(fs.existsSync(cliScript), 'bin/garda.js must be present in installed package');
        assert.ok(fs.existsSync(path.join(installedPackageRoot, 'bin', 'garda.js')), 'legacy bin/garda.js must remain present in installed package');

        // 1. Compiled dist/ must be present and development-only roots must be absent.
        assert.ok(
            fs.existsSync(path.join(installedPackageRoot, 'dist', 'src', 'index.js')),
            'dist/src/index.js must exist in the installed package'
        );
        assertCompiledOnlyPackageSurface(packageJson, installedPackageRoot);
        assert.ok(
            fs.existsSync(path.join(installedPackageRoot, 'template', 'entrypoints', 'canonical-rule-index.md')),
            'neutral canonical rule-index template must exist in the installed package'
        );
        assert.ok(
            fs.existsSync(path.join(installedPackageRoot, 'docs', 'operator-consistency-runbook.md')),
            'runtime-referenced operator consistency runbook must exist in the installed package'
        );
        assertInstalledMarkdownRelativeLinks(installedPackageRoot);
        const installedLegacyTemplatePath = path.join(installedPackageRoot, 'template', 'CLAUDE.md');
        assert.ok(
            fs.existsSync(installedLegacyTemplatePath),
            'packed package must include generated legacy template/CLAUDE.md for 1.0.0 updater compatibility'
        );
        assert.ok(
            fs.readFileSync(installedLegacyTemplatePath, 'utf8').includes('# CLAUDE.md'),
            'generated legacy template/CLAUDE.md must be provider-specific only inside the packed package'
        );

        // 2. --version prints the correct version
        const versionStartedAt = performance.now();
        const versionResult = runCli(cliScript, ['--version'], installRoot);
        const versionDurationMs = Math.round(performance.now() - versionStartedAt);
        assert.equal(versionResult.status, 0, `--version failed: ${versionResult.stderr}`);
        assert.match(versionResult.stdout.trim(), new RegExp(`^${expectedVersion.replace(/\./g, '\\.')}$`));
        assert.ok(
            versionDurationMs <= CLI_COLD_START_BUDGET_MS,
            `cold packaged CLI startup exceeded budget: observed=${versionDurationMs}ms budget=${CLI_COLD_START_BUDGET_MS}ms`
        );
        console.log(
            `PACK_SMOKE_PERFORMANCE install_ms=${installDurationMs} install_budget_ms=${LOCAL_TARBALL_INSTALL_BUDGET_MS} `
            + `cli_version_start_ms=${versionDurationMs} cli_start_budget_ms=${CLI_COLD_START_BUDGET_MS}`
        );

        // 3. --help prints usage information
        const helpResult = runCli(cliScript, ['--help'], installRoot);
        assert.equal(helpResult.status, 0, `--help failed: ${helpResult.stderr}`);
        assert.match(helpResult.stdout, /Usage:/);
        assert.match(helpResult.stdout, /setup/);

        // 4. status command works against a bare workspace (exercises compiled runtime)
        const workspaceRoot = path.join(installRoot, 'workspace');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        const statusResult = runCli(cliScript, ['status', '--target-root', workspaceRoot], workspaceRoot);
        assert.equal(statusResult.status, 0, `status failed: ${statusResult.stderr || statusResult.stdout}`);
        assert.match(statusResult.stdout, /GARDA_STATUS/);

        // A real packaged deployment must verify without development sources.
        const setupResult = runCli(cliScript, [
            'setup', '--target-root', workspaceRoot, '--no-prompt',
            '--assistant-language', 'English', '--assistant-brevity', 'concise',
            '--source-of-truth', 'Codex', '--active-agent-files', 'AGENTS.md',
            '--enforce-no-auto-commit', 'no', '--claude-orchestrator-full-access', 'no',
            '--token-economy-enabled', 'yes'
        ], workspaceRoot);
        assert.equal(setupResult.status, 0, formatSpawnFailure('packaged setup', setupResult));
        const deployedBundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        assert.equal(fs.existsSync(path.join(deployedBundleRoot, 'src')), false);
        fs.writeFileSync(path.join(workspaceRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
        const workflowResult = runCli(cliScript, [
            'workflow', 'set', '--target-root', workspaceRoot,
            '--compile-gate-command', 'node --check index.js',
            '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()
        ], workspaceRoot);
        assert.equal(workflowResult.status, 0, formatSpawnFailure('packaged workflow configuration', workflowResult));
        const verifyResult = runCli(cliScript, ['verify', '--target-root', workspaceRoot], workspaceRoot);
        assert.equal(verifyResult.status, 0, formatSpawnFailure('packaged verify', verifyResult));
        assert.match(verifyResult.stdout, /MissingPathCount: 0/);

        const deployedRuntimeEntrypoint = path.join(deployedBundleRoot, 'dist', 'src', 'index.js');
        fs.unlinkSync(deployedRuntimeEntrypoint);
        const missingRuntimeResult = runCli(cliScript, ['verify', '--target-root', workspaceRoot], installRoot);
        assert.equal(missingRuntimeResult.status, 4, formatSpawnFailure('missing runtime validation', missingRuntimeResult));
        assert.match(missingRuntimeResult.stdout, /MissingPathCount: 1/);
        assert.match(
            `${missingRuntimeResult.stdout}\n${missingRuntimeResult.stderr}`,
            /garda-agent-orchestrator\/dist\/src\/index\.js/,
            'verify must identify the missing runtime entrypoint'
        );

        // 5. No TypeScript stripping warnings from node_modules
        const combinedOutput = [
            versionResult.stdout, versionResult.stderr,
            helpResult.stdout, helpResult.stderr,
            statusResult.stdout, statusResult.stderr,
            setupResult.stdout, setupResult.stderr,
            workflowResult.stdout, workflowResult.stderr,
            verifyResult.stdout, verifyResult.stderr
        ].join('\n');
        assert.doesNotMatch(
            combinedOutput,
            /Stripping types is currently unsupported for files under node_modules/i,
            'CLI must not produce TypeScript stripping warnings from node_modules'
        );
    } finally {
        removePackSmokeTempRoot(tempRoot);
    }
});
