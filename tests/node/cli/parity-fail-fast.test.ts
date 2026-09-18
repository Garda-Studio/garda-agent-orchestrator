import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as childProcess from 'node:child_process';
import {
    EXIT_OFFLINE_BLOCKED,
    EXIT_PRECONDITION_FAILURE
} from '../../../src/cli/exit-codes';
import { dispatchCliCommand } from '../../../src/cli/commands/command-dispatch';
import {
    buildForcedSourceCheckoutRuntimeBuildCommand,
    BUNDLE_RUNTIME_INVENTORY_PATHS,
    CRITICAL_BUNDLE_PATHS
} from '../../../src/validators/workspace-layout';

const EXPECTED_SOURCE_RUNTIME_REBUILD_COMMAND = buildForcedSourceCheckoutRuntimeBuildCommand();

function findRepoRoot(startDir: string): string {
    let current = path.resolve(startDir);
    while (true) {
        const packageJsonPath = path.join(current, 'package.json');
        const cliPath = path.join(current, 'bin', 'garda.js');
        if (fs.existsSync(packageJsonPath) && fs.existsSync(cliPath)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`Could not resolve repository root from: ${startDir}`);
        }
        current = parent;
    }
}

const REPO_ROOT = findRepoRoot(__dirname);
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'garda.js');
const TEST_PACKAGE_JSON = { name: 'garda-agent-orchestrator-test', version: '1.0.0' };
const CLI_CHILD_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 30_000;
const WORKFLOW_CLI_REGRESSION_TIMEOUT_MS = CLI_CHILD_TIMEOUT_MS;

function cliChildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env = { ...process.env, ...overrides };
    delete env.NO_COLOR;
    return env;
}

function writeFixtureFile(root: string, relativePath: string, content: string): void {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function seedMatchingSourceCheckoutBundle(root: string): void {
    writeFixtureFile(root, 'package.json', '{}\n');
    writeFixtureFile(root, 'VERSION', '1.0.0\n');
    writeFixtureFile(root, 'src/index.ts', 'export {};\n');
    writeFixtureFile(root, 'bin/garda.js', '#!/usr/bin/env node\n');
    for (const relativePath of [...CRITICAL_BUNDLE_PATHS, ...BUNDLE_RUNTIME_INVENTORY_PATHS]) {
        const content = relativePath === 'VERSION'
            ? '1.0.0\n'
            : relativePath.endsWith('.js')
                ? 'module.exports = {};\n'
                : relativePath.endsWith('.md')
                    ? '# fixture\n'
                    : '{}\n';
        writeFixtureFile(root, path.join('garda-agent-orchestrator', relativePath), content);
    }
}

function seedStaleSourceCheckoutBundle(root: string): void {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'bin'), { recursive: true });

    fs.writeFileSync(path.join(root, 'package.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), '', 'utf8');
    fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0', 'utf8');
    fs.writeFileSync(path.join(root, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

    const rootLauncher = path.join(root, 'bin', 'garda.js');
    const bundleLauncher = path.join(root, 'garda-agent-orchestrator', 'bin', 'garda.js');
    fs.writeFileSync(rootLauncher, 'new', 'utf8');
    fs.writeFileSync(bundleLauncher, 'old', 'utf8');
    const oldTime = new Date(Date.now() - 10000);
    fs.utimesSync(bundleLauncher, oldTime, oldTime);
}

test('gate command warns and continues when source checkout runtime is stale', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-warning-dispatch-'));
    const previousExitCode = process.exitCode;
    const originalConsoleError = console.error;
    const capturedErrors: string[] = [];
    try {
        seedMatchingSourceCheckoutBundle(tmpDir);
        writeFixtureFile(tmpDir, 'src/gates/next-step.ts', 'export const source = true;\n');
        writeFixtureFile(tmpDir, 'dist/src/index.js', 'module.exports = {};\n');
        writeFixtureFile(tmpDir, 'dist/src/gates/next-step.js', 'exports.source = false;\n');
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(path.join(tmpDir, 'dist', 'src', 'gates', 'next-step.js'), oldTime, oldTime);

        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        process.exitCode = 0;

        await assert.rejects(
            () => dispatchCliCommand({
                commandName: 'gate',
                commandArgv: ['stale-runtime-probe', '--repo-root', tmpDir],
                packageJson: TEST_PACKAGE_JSON,
                packageRoot: REPO_ROOT,
                globalFlags: { offline: false, forceNetwork: false }
            }),
            /Unknown gate: stale-runtime-probe/
        );

        const combinedErrors = capturedErrors.join('\n');
        assert.ok(combinedErrors.includes('Source Runtime Warning: source checkout generated runtime may be stale.'));
        assert.ok(combinedErrors.includes('src/gates/next-step.ts newer than dist/src/gates/next-step.js'));
        assert.ok(combinedErrors.includes(`Remediation: Run "${EXPECTED_SOURCE_RUNTIME_REBUILD_COMMAND}"`));
        assert.ok(combinedErrors.includes('GARDA_BUILD_SCRIPTS_FORCE_REBUILD'));
        assert.ok(combinedErrors.includes('GARDA_PUBLISH_RUNTIME_FORCE_REBUILD'));
    } finally {
        console.error = originalConsoleError;
        process.exitCode = previousExitCode;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('next-step command suppresses legacy warning when source checkout runtime is stale', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-warning-dispatch-'));
    const previousExitCode = process.exitCode;
    const originalConsoleError = console.error;
    const originalStdoutWrite = process.stdout.write;
    const capturedErrors: string[] = [];
    const capturedOutput: string[] = [];
    try {
        seedMatchingSourceCheckoutBundle(tmpDir);
        writeFixtureFile(tmpDir, 'src/gates/next-step.ts', 'export const source = true;\n');
        writeFixtureFile(tmpDir, 'dist/src/index.js', 'module.exports = {};\n');
        writeFixtureFile(tmpDir, 'dist/src/gates/next-step.js', 'exports.source = false;\n');
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(path.join(tmpDir, 'dist', 'src', 'gates', 'next-step.js'), oldTime, oldTime);

        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        (process.stdout as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]): boolean => {
            capturedOutput.push(String(args[0]));
            return true;
        };
        process.exitCode = 0;

        await dispatchCliCommand({
            commandName: 'next-step',
            commandArgv: ['T-runtime-probe', '--repo-root', tmpDir],
            packageJson: TEST_PACKAGE_JSON,
            packageRoot: REPO_ROOT,
            globalFlags: { offline: false, forceNetwork: false }
        });

        const combinedErrors = capturedErrors.join('\n');
        assert.ok(!combinedErrors.includes('Source Runtime Warning: source checkout generated runtime may be stale.'));
        assert.ok(!combinedErrors.includes('src/gates/next-step.ts newer than dist/src/gates/next-step.js'));
        assert.ok(capturedOutput.join('').includes('GARDA_NEXT_STEP'));
    } finally {
        console.error = originalConsoleError;
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalStdoutWrite;
        process.exitCode = previousExitCode;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('gate next-step suppresses legacy warning when source checkout runtime is stale', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-warning-dispatch-'));
    const previousExitCode = process.exitCode;
    const originalConsoleError = console.error;
    const originalStdoutWrite = process.stdout.write;
    const capturedErrors: string[] = [];
    const capturedOutput: string[] = [];
    try {
        seedMatchingSourceCheckoutBundle(tmpDir);
        writeFixtureFile(tmpDir, 'src/gates/next-step.ts', 'export const source = true;\n');
        writeFixtureFile(tmpDir, 'dist/src/index.js', 'module.exports = {};\n');
        writeFixtureFile(tmpDir, 'dist/src/gates/next-step.js', 'exports.source = false;\n');
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(path.join(tmpDir, 'dist', 'src', 'gates', 'next-step.js'), oldTime, oldTime);

        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        (process.stdout as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]): boolean => {
            capturedOutput.push(String(args[0]));
            return true;
        };
        process.exitCode = 0;

        await dispatchCliCommand({
            commandName: 'gate',
            commandArgv: ['next-step', 'T-runtime-probe', '--repo-root', tmpDir],
            packageJson: TEST_PACKAGE_JSON,
            packageRoot: REPO_ROOT,
            globalFlags: { offline: false, forceNetwork: false }
        });

        const combinedErrors = capturedErrors.join('\n');
        assert.ok(!combinedErrors.includes('Source Runtime Warning: source checkout generated runtime may be stale.'));
        assert.ok(!combinedErrors.includes('src/gates/next-step.ts newer than dist/src/gates/next-step.js'));
        assert.ok(capturedOutput.join('').includes('GARDA_NEXT_STEP'));
    } finally {
        console.error = originalConsoleError;
        (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalStdoutWrite;
        process.exitCode = previousExitCode;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('CLI blocks task execution commands when bundle is stale', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-fail-fast-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(tmpDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(tmpDir, 'garda-agent-orchestrator', 'bin', 'garda.js');

        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');
        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);
        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'gate', '--help'],
            { cwd: tmpDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        
        assert.equal(result.status, EXIT_PRECONDITION_FAILURE, `Expected CLI to exit with code ${EXIT_PRECONDITION_FAILURE} (PRECONDITION_FAILURE)`);
        assert.ok(
            combined.includes('Source Parity Violation: The deployed bundle is stale'),
            'Expected CLI to print parity violation message'
        );
        assert.ok(combined.includes('GARDA_COMMAND_HELP'));
        assert.ok(combined.includes('gate'));
        assert.ok(
            combined.includes('older than source launcher'),
            'Expected CLI to specify the launcher age violation'
        );
        const statusResult = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'status'],
            { cwd: tmpDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );
        
        const statusCombined = (statusResult.stdout || '') + (statusResult.stderr || '');
        assert.ok(!statusCombined.includes('Source Parity Violation: The deployed bundle is stale'), 'Status command should not crash with the top-level parity throw');

    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('read-only target-root commands warn on target parity drift without blocking', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-status-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-status-target-'));
    try {
        seedStaleSourceCheckoutBundle(targetDir);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'status', '--target-root', targetDir, '--json'],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0, 'status should remain read-only and continue after a parity warning');
        assert.ok(combined.includes('PARITY_WARNING'));
        assert.ok(combined.includes('AllowedCommand: status'));
        assert.ok(combined.includes('ParityPolicy: warn'));
        assert.ok(combined.includes(`ParityRoot: ${targetDir}`));
        assert.ok(combined.includes('Source Parity Warning: The deployed bundle is stale'));
        assert.ok(!combined.includes('PARITY_BLOCKED'));
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('mutating target-root lifecycle commands block on target parity drift', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-update-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-update-target-'));
    try {
        seedStaleSourceCheckoutBundle(targetDir);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'update', '--target-root', targetDir, '--dry-run'],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, EXIT_PRECONDITION_FAILURE);
        assert.ok(combined.includes('PARITY_BLOCKED'));
        assert.ok(combined.includes('BlockedCommand: update'));
        assert.ok(combined.includes('ParityPolicy: block'));
        assert.ok(combined.includes(`ParityRoot: ${targetDir}`));
        assert.ok(combined.includes('mutating lifecycle commands must not run'));
        assert.ok(combined.includes('Source Parity Violation: The deployed bundle is stale'));
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('local bundle refresh commands warn on parity drift so setup recovery remains reachable', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-setup-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-setup-target-'));
    try {
        seedStaleSourceCheckoutBundle(targetDir);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'setup', '--target-root', targetDir, '--help'],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0);
        assert.ok(combined.includes('PARITY_WARNING'));
        assert.ok(combined.includes('AllowedCommand: setup'));
        assert.ok(combined.includes('ParityPolicy: warn'));
        assert.ok(combined.includes(`ParityRoot: ${targetDir}`));
        assert.ok(combined.includes('setup refreshes the deployed bundle from the current trusted source checkout'));
        assert.ok(combined.includes('Usage:'));
        assert.ok(!combined.includes('PARITY_BLOCKED'));
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('init and reinit warnings do not claim to synchronize stale source artifacts', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-rematerialize-target-'));
    try {
        seedStaleSourceCheckoutBundle(targetDir);
        for (const commandName of ['init', 'reinit']) {
            const result = childProcess.spawnSync(
                process.execPath,
                [CLI_PATH, commandName, '--target-root', targetDir, '--help'],
                { cwd: targetDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
            );
            const combined = (result.stdout || '') + (result.stderr || '');
            assert.equal(result.status, 0);
            assert.ok(combined.includes('PARITY_WARNING'));
            assert.ok(combined.includes(`${commandName} rematerializes the existing deployed bundle without synchronizing source artifacts`));
            assert.ok(combined.includes('setup --no-prompt'));
            assert.ok(!combined.includes(`${commandName} refreshes the deployed bundle from the current trusted source checkout`));
        }
    } finally {
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('remote-source setup remains blocked on target parity drift', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-setup-remote-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-setup-remote-target-'));
    try {
        seedStaleSourceCheckoutBundle(targetDir);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'setup', '--target-root', targetDir, '--branch', 'dev', '--help'],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, EXIT_PRECONDITION_FAILURE);
        assert.ok(combined.includes('PARITY_BLOCKED'));
        assert.ok(combined.includes('BlockedCommand: setup'));
        assert.ok(combined.includes('ParityPolicy: block'));
        assert.ok(combined.includes(`ParityRoot: ${targetDir}`));
        assert.ok(combined.includes('mutating lifecycle commands must not run'));
        assert.ok(combined.includes('Source Parity Violation: The deployed bundle is stale'));
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
});

test('offline network-sensitive commands fail before target parity drift', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-offline-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-offline-target-'));
    try {
        seedStaleSourceCheckoutBundle(targetDir);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, '--offline', 'update', '--target-root', targetDir, '--help-not-real-flag'],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, EXIT_OFFLINE_BLOCKED);
        assert.ok(combined.includes('offline mode is active'));
        assert.ok(combined.includes('--force-network'));
        assert.ok(!combined.includes('PARITY_BLOCKED'));
        assert.ok(!combined.includes('Source Parity Violation: The deployed bundle is stale'));
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('read-only check-update help warns on target parity drift and stays discoverable', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-check-update-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-check-update-target-'));
    try {
        seedStaleSourceCheckoutBundle(targetDir);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'check-update', '--target-root', targetDir, '--help'],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0);
        assert.ok(combined.includes('PARITY_WARNING'));
        assert.ok(combined.includes('AllowedCommand: check-update'));
        assert.ok(combined.includes('ParityPolicy: warn'));
        assert.ok(combined.includes('check-update is read-only without --apply'));
        assert.ok(combined.includes('Usage:'));
        assert.ok(combined.includes('check-update'));
        assert.ok(!combined.includes('PARITY_BLOCKED'));
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('repair dry-run subcommands warn while confirmed repair mutations block on parity drift', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-repair-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-repair-target-'));
    try {
        seedStaleSourceCheckoutBundle(targetDir);

        const dryRunResult = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'repair', 'rebuild-indexes', '--target-root', targetDir, '--json'],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const dryRunCombined = (dryRunResult.stdout || '') + (dryRunResult.stderr || '');
        assert.equal(dryRunResult.status, 0, 'repair rebuild-indexes should remain dry-run without --confirm');
        assert.ok(dryRunCombined.includes('PARITY_WARNING'));
        assert.ok(dryRunCombined.includes('AllowedCommand: repair'));
        assert.ok(dryRunCombined.includes('ParityPolicy: warn'));
        assert.ok(dryRunCombined.includes('repair mutation subcommands are dry-run by default'));
        assert.ok(!dryRunCombined.includes('PARITY_BLOCKED'));

        const confirmedResult = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'repair', 'rebuild-indexes', '--target-root', targetDir, '--confirm'],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const confirmedCombined = (confirmedResult.stdout || '') + (confirmedResult.stderr || '');
        assert.equal(confirmedResult.status, EXIT_PRECONDITION_FAILURE);
        assert.ok(confirmedCombined.includes('PARITY_BLOCKED'));
        assert.ok(confirmedCombined.includes('BlockedCommand: repair'));
        assert.ok(confirmedCombined.includes('ParityPolicy: block'));
        assert.ok(confirmedCombined.includes('confirmed repair mutation paths must not run'));
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('workflow command resolves parity against --target-root instead of the caller cwd', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-target-'));
    try {
        fs.mkdirSync(path.join(callerDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(callerDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(callerDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(callerDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'workflow', 'show', '--target-root', targetDir],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0, 'workflow show should succeed when the target root itself is not stale');
        assert.ok(!combined.includes('Source Parity Violation: The deployed bundle is stale'));
        assert.ok(combined.includes('Mandatory full-suite: false'));
        assert.ok(combined.includes('Review execution policy: strict_sequential'));
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('review-capabilities show resolves parity against --target-root instead of the caller cwd', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-review-capabilities-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-review-capabilities-target-'));
    try {
        fs.mkdirSync(path.join(callerDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(callerDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(callerDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(callerDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'review-capabilities', 'show', '--target-root', targetDir],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0, 'review-capabilities show should succeed when the target root itself is not stale');
        assert.ok(!combined.includes('Source Parity Violation: The deployed bundle is stale'));
        assert.ok(combined.includes('Enabled optional reviews: api, test, performance, infra, dependency'));
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('workflow help remains discoverable when parity blocks the caller workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-help-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(tmpDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(tmpDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'workflow', '--help'],
            { cwd: tmpDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, EXIT_PRECONDITION_FAILURE);
        assert.ok(combined.includes('PARITY_BLOCKED'));
        assert.ok(combined.includes('GARDA_COMMAND_HELP'));
        assert.ok(combined.includes('workflow'));
        assert.ok(combined.includes('Default mode: workflow with no subcommand behaves like workflow show.'));
        assert.ok(combined.includes('Fix'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('review-capabilities help remains discoverable when parity blocks the caller workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-review-capabilities-help-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(tmpDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(tmpDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'review-capabilities', '--help'],
            { cwd: tmpDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, EXIT_PRECONDITION_FAILURE);
        assert.ok(combined.includes('PARITY_BLOCKED'));
        assert.ok(combined.includes('GARDA_COMMAND_HELP'));
        assert.ok(combined.includes('review-capabilities'));
        assert.ok(combined.includes('Default mode: review-capabilities with no subcommand behaves like review-capabilities show.'));
        assert.ok(combined.includes('Fix'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('next-step help remains discoverable when parity blocks the caller workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-next-step-help-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(tmpDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(tmpDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'next-step', 'T-250', '--repo-root', '.'],
            { cwd: tmpDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, EXIT_PRECONDITION_FAILURE);
        assert.ok(combined.includes('PARITY_BLOCKED'));
        assert.ok(combined.includes('GARDA_COMMAND_HELP'));
        assert.ok(combined.includes('next-step'));
        assert.ok(combined.includes('Default task-loop navigator'));
        assert.ok(combined.includes('review launchable batch'));
        assert.ok(combined.includes('legacy NextReview compatibility'));
        assert.ok(combined.includes('Fix'));
        assert.ok(!combined.includes('Cannot read properties of undefined'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('review-capabilities enable routes through the CLI dispatcher for --target-root and preserves JSON output', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-review-capabilities-set-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-review-capabilities-set-target-'));
    try {
        fs.mkdirSync(path.join(callerDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(callerDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(callerDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(callerDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const skillRoot = path.join(targetDir, 'garda-agent-orchestrator', 'live', 'skills', 'api-contract-review');
        fs.mkdirSync(skillRoot, { recursive: true });
        fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# api-contract-review\n', 'utf8');

        const result = childProcess.spawnSync(
            process.execPath,
            [
                CLI_PATH,
                'review-capabilities',
                'enable',
                '--target-root', targetDir,
                '--json',
                'api'
            ],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0, 'review-capabilities enable should succeed when routed to a clean target root');
        assert.ok(!combined.includes('Source Parity Violation: The deployed bundle is stale'));

        const parsed = JSON.parse(result.stdout || '');
        assert.equal(parsed.action, 'enable');
        assert.equal(parsed.status, 'CHANGED');
        assert.deepEqual(parsed.requested_capabilities, ['api']);
        assert.equal(parsed.enabled_capabilities.includes('api'), true);

        const configPath = path.join(targetDir, 'garda-agent-orchestrator', 'live', 'config', 'review-capabilities.json');
        assert.equal(fs.existsSync(configPath), true);
        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.api, true);
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('gate subcommand help remains discoverable when parity blocks the caller workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-gate-help-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(tmpDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(tmpDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'gate', 'enter-task-mode', '--help'],
            { cwd: tmpDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, EXIT_PRECONDITION_FAILURE);
        assert.ok(combined.includes('PARITY_BLOCKED'));
        assert.ok(combined.includes('enter-task-mode'));
        assert.ok(combined.includes('Enter explicit task mode before any implementation'));
        assert.ok(combined.includes('Usage'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('workflow set routes through the CLI dispatcher for --target-root and preserves JSON output', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-set-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-set-target-'));
    try {
        fs.mkdirSync(path.join(callerDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(callerDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(callerDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(callerDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const result = childProcess.spawnSync(
            process.execPath,
            [
                CLI_PATH,
                'workflow',
                'set',
                '--target-root', targetDir,
                '--full-suite-enabled', 'true',
                '--review-execution-policy', 'strict_sequential',
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', new Date().toISOString(),
                '--json'
            ],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0, 'workflow set should succeed when routed to a clean target root');
        assert.ok(!combined.includes('Source Parity Violation: The deployed bundle is stale'));

        const parsed = JSON.parse(result.stdout || '');
        assert.equal(parsed.action, 'set');
        assert.equal(parsed.status, 'CHANGED');
        assert.equal(parsed.full_suite_validation.enabled, true);
        assert.equal(parsed.review_execution_policy.mode, 'strict_sequential');
        assert.equal(parsed.visible_summary_line, 'Mandatory full-suite: true placement=after_compile_before_reviews mode=standard');
        assert.equal(parsed.review_execution_policy_summary_line, 'Review execution policy: strict_sequential');

        const configPath = path.join(targetDir, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
        assert.equal(fs.existsSync(configPath), true);
        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, true);
        assert.equal(parsedConfig.review_execution_policy.mode, 'strict_sequential');
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

test('workflow set human output separates requested fields from no-op changed fields', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-human-set-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-human-set-target-'));
    try {
        fs.mkdirSync(path.join(callerDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(callerDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(callerDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(callerDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const seedResult = childProcess.spawnSync(
            process.execPath,
            [
                CLI_PATH,
                'workflow',
                'set',
                '--target-root', targetDir,
                '--task-reset', 'off',
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', new Date().toISOString(),
                '--json'
            ],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: WORKFLOW_CLI_REGRESSION_TIMEOUT_MS }
        );
        assert.equal(seedResult.status, 0, 'workflow set seed should create target config');

        const result = childProcess.spawnSync(
            process.execPath,
            [
                CLI_PATH,
                'workflow',
                'set',
                '--target-root', targetDir,
                '--task-reset', 'off'
            ],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: WORKFLOW_CLI_REGRESSION_TIMEOUT_MS }
        );

        const combined = stripAnsi((result.stdout || '') + (result.stderr || ''));
        assert.equal(result.status, 0, 'workflow set no-op should succeed without operator confirmation');
        assert.ok(combined.includes('Status: NO_CHANGE'));
        assert.ok(combined.includes('RequestedFields: task_reset.enabled'));
        assert.ok(combined.includes('ChangedFields: none'));
        assert.ok(combined.includes('NoOpFields: task_reset.enabled'));
        assert.ok(!combined.includes('ChangedFields: task_reset.enabled'));
        assert.ok(!combined.includes('AuditPath:'));

        const jsonResult = childProcess.spawnSync(
            process.execPath,
            [
                CLI_PATH,
                'workflow',
                'set',
                '--target-root', targetDir,
                '--task-reset', 'off',
                '--json'
            ],
            {
                cwd: callerDir,
                windowsHide: true,
                encoding: 'utf8',
                timeout: WORKFLOW_CLI_REGRESSION_TIMEOUT_MS,
                env: { ...process.env, FORCE_COLOR: '1' }
            }
        );
        const jsonCombined = (jsonResult.stdout || '') + (jsonResult.stderr || '');
        assert.equal(jsonResult.status, 0, 'workflow set no-op JSON should succeed under FORCE_COLOR');
        assert.doesNotMatch(jsonCombined, /\u001b\[[0-9;]+m/u);
        const parsed = JSON.parse(jsonResult.stdout || '');
        assert.equal(parsed.action, 'set');
        assert.equal(parsed.status, 'NO_CHANGE');
        assert.deepEqual(parsed.requested_fields, ['task_reset.enabled']);
        assert.deepEqual(parsed.changed_fields, []);
        assert.deepEqual(parsed.noop_fields, ['task_reset.enabled']);
        assert.equal(parsed.audit_path, null);
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('workflow set human output colorizes statuses and honors no-color', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-color-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-color-target-'));
    try {
        fs.mkdirSync(path.join(callerDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(callerDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(callerDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(callerDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const seedResult = childProcess.spawnSync(
            process.execPath,
            [
                CLI_PATH,
                'workflow',
                'set',
                '--target-root', targetDir,
                '--task-reset', 'off',
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', new Date().toISOString(),
                '--json'
            ],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: WORKFLOW_CLI_REGRESSION_TIMEOUT_MS }
        );
        assert.equal(seedResult.status, 0, 'workflow set seed should create target config');

        const colorResult = childProcess.spawnSync(
            process.execPath,
            [
                CLI_PATH,
                'workflow',
                'set',
                '--target-root', targetDir,
                '--task-reset', 'off'
            ],
            {
                cwd: callerDir,
                windowsHide: true,
                encoding: 'utf8',
                timeout: WORKFLOW_CLI_REGRESSION_TIMEOUT_MS,
                env: cliChildEnv({ FORCE_COLOR: '1' })
            }
        );
        assert.equal(colorResult.status, 0, 'workflow set no-op should succeed with FORCE_COLOR');
        assert.match(colorResult.stdout || '', /\u001b\[[0-9;]+m/u);

        const noColorResult = childProcess.spawnSync(
            process.execPath,
            [
                CLI_PATH,
                '--no-color',
                'workflow',
                'set',
                '--target-root', targetDir,
                '--task-reset', 'off'
            ],
            {
                cwd: callerDir,
                windowsHide: true,
                encoding: 'utf8',
                timeout: WORKFLOW_CLI_REGRESSION_TIMEOUT_MS,
                env: cliChildEnv({ FORCE_COLOR: '1' })
            }
        );
        const noColorCombined = (noColorResult.stdout || '') + (noColorResult.stderr || '');
        assert.equal(noColorResult.status, 0, 'workflow set no-op should honor --no-color');
        assert.ok(noColorCombined.includes('Status: NO_CHANGE'));
        assert.doesNotMatch(noColorCombined, /\u001b\[[0-9;]+m/u);
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('workflow set routes legacy materialized target roots through the CLI dispatcher when review_execution_policy is introduced explicitly', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-legacy-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-workflow-legacy-target-'));
    try {
        fs.mkdirSync(path.join(callerDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(callerDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(callerDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(callerDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const configDir = path.join(targetDir, 'garda-agent-orchestrator', 'live', 'config');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(
            path.join(targetDir, 'garda-agent-orchestrator', 'live', 'version.json'),
            JSON.stringify({ version: '1.0.0' }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            path.join(configDir, 'workflow-config.json'),
            JSON.stringify({
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 25,
                    red_failure_chunk_lines: 80,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }, null, 2),
            'utf8'
        );

        const result = childProcess.spawnSync(
            process.execPath,
            [
                CLI_PATH,
                'workflow',
                'set',
                '--target-root', targetDir,
                '--review-execution-policy', 'strict_sequential',
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', new Date().toISOString(),
                '--json'
            ],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0, 'workflow set should succeed for a legacy materialized target root');
        assert.ok(!combined.includes('Source Parity Violation: The deployed bundle is stale'));

        const parsed = JSON.parse(result.stdout || '');
        assert.equal(parsed.action, 'set');
        assert.equal(parsed.status, 'CHANGED');
        assert.equal(parsed.review_execution_policy.mode, 'strict_sequential');
        assert.equal(parsed.review_execution_policy.configured, true);
        assert.equal(parsed.review_execution_policy_summary_line, 'Review execution policy: strict_sequential');

        const configPath = path.join(configDir, 'workflow-config.json');
        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, false);
        assert.equal(parsedConfig.review_execution_policy.mode, 'strict_sequential');
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});

test('profile command resolves parity against --target-root instead of the caller cwd', () => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-profile-caller-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-profile-target-'));
    try {
        fs.mkdirSync(path.join(callerDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(callerDir, 'garda-agent-orchestrator', 'bin'), { recursive: true });

        fs.writeFileSync(path.join(callerDir, 'package.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'src', 'index.ts'), '', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(callerDir, 'garda-agent-orchestrator', 'VERSION'), '1.0.0', 'utf8');

        const rootLauncher = path.join(callerDir, 'bin', 'garda.js');
        const bundleLauncher = path.join(callerDir, 'garda-agent-orchestrator', 'bin', 'garda.js');
        fs.writeFileSync(rootLauncher, 'new', 'utf8');
        fs.writeFileSync(bundleLauncher, 'old', 'utf8');

        const oldTime = new Date(Date.now() - 10000);
        fs.utimesSync(bundleLauncher, oldTime, oldTime);

        const profilesConfigDir = path.join(targetDir, 'garda-agent-orchestrator', 'live', 'config');
        fs.mkdirSync(profilesConfigDir, { recursive: true });
        fs.writeFileSync(path.join(profilesConfigDir, 'profiles.json'), JSON.stringify({
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Default profile.',
                    depth: 2,
                    review_policy: { code: true, db: 'auto', security: 'auto', refactor: 'auto' },
                    token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        }, null, 2), 'utf8');

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_PATH, 'profile', '--target-root', targetDir, '--json'],
            { cwd: callerDir, windowsHide: true, encoding: 'utf8', timeout: CLI_CHILD_TIMEOUT_MS }
        );

        const combined = (result.stdout || '') + (result.stderr || '');
        assert.equal(result.status, 0, 'profile should succeed when the target root itself is not stale');
        assert.ok(!combined.includes('Source Parity Violation: The deployed bundle is stale'));

        const parsed = JSON.parse(result.stdout || '');
        assert.equal(parsed.active_profile, 'balanced');
        assert.equal(parsed.config_path, path.join(targetDir, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json'));
    } finally {
        fs.rmSync(callerDir, { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
});
