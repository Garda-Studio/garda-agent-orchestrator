import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
    buildDelegationTrustEvidence,
    getDelegationExitCode,
    getDelegationForwardSignals,
    resolveDelegationStartDirs,
    resolveDelegatedLauncherTrustEvidence
} from '../../../src/bin/garda';
import { GARDA_NO_DELEGATE_ENV } from '../../../src/core/review-delegation-policy';

const DELEGATION_HARNESS_TIMEOUT_MS = 60_000;
const DELEGATED_PROCESS_EXIT_TIMEOUT_MS = 30_000;

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function writeDelegationHarness(tempRoot: string): string {
    const harnessPath = path.join(tempRoot, 'delegate-harness.js');
    const compiledLauncherPath = path.resolve(__dirname, '../../../src/bin/garda.js');
    writeFile(harnessPath, `
const { delegateToLocalCli } = require(${JSON.stringify(compiledLauncherPath)});
delegateToLocalCli(process.argv[2], process.argv.slice(3)).then((exitCode) => {
  process.exitCode = exitCode;
}, (error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
`);
    return harnessPath;
}

function writePackageRoot(
    root: string,
    options?: { sourceCheckout?: boolean; deployedBundle?: boolean; packageName?: string }
): void {
    writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: options?.packageName ?? 'garda-agent-orchestrator' }, null, 2)
    );
    writeFile(path.join(root, 'VERSION'), '1.0.0\n');
    writeFile(path.join(root, 'bin', 'garda.js'), '#!/usr/bin/env node\n');
    if (options?.sourceCheckout) {
        writeFile(path.join(root, 'src', 'bin', 'garda.ts'), 'export {};\n');
        writeFile(path.join(root, 'scripts', 'node-foundation', 'build-scripts.cjs'), 'module.exports = {};\n');
        writeFile(path.join(root, 'tests', 'node', '.keep'), '');
    }
    if (options?.deployedBundle) {
        writeFile(path.join(root, 'MANIFEST.md'), '- bin/garda.js\n');
        writeFile(path.join(root, 'live', 'version.json'), '{"version":"1.0.0"}\n');
        writeFile(path.join(root, 'live', 'docs', 'agent-rules', '00-core.md'), '# Core Rules\n');
        writeFile(path.join(root, 'live', 'config', 'profiles.json'), '{}\n');
        writeFile(path.join(root, 'live', 'config', 'review-capabilities.json'), '{}\n');
    }
}

function spawnHarness(
    harnessPath: string,
    childScriptPath: string,
    args: string[] = [],
    env: NodeJS.ProcessEnv = process.env
): childProcess.ChildProcess {
    return childProcess.spawn(process.execPath, [harnessPath, childScriptPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env
    });
}

function spawnHarnessSync(
    harnessPath: string,
    childScriptPath: string,
    args: string[] = [],
    env: NodeJS.ProcessEnv = process.env
): childProcess.SpawnSyncReturns<string> {
    return childProcess.spawnSync(process.execPath, [harnessPath, childScriptPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        env,
        timeout: DELEGATION_HARNESS_TIMEOUT_MS
    });
}

function waitForClose(child: childProcess.ChildProcess): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (status, signal) => {
            resolve({ status, signal });
        });
    });
}

function waitForStdout(child: childProcess.ChildProcess, expected: string): Promise<string> {
    return new Promise((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for stdout: ${expected}`));
        }, DELEGATION_HARNESS_TIMEOUT_MS);
        child.stdout?.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8');
            if (output.includes(expected)) {
                clearTimeout(timeout);
                resolve(output);
            }
        });
    });
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
    const deadline = Date.now() + DELEGATED_PROCESS_EXIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
            return true;
        }
        await delay(50);
    }
    return !isProcessAlive(pid);
}

test('delegation maps child exit codes and signals consistently', () => {
    assert.equal(getDelegationExitCode(0, null), 0);
    assert.equal(getDelegationExitCode(7, null), 7);
    assert.equal(getDelegationExitCode(null, 'SIGINT'), 130);
    assert.equal(getDelegationExitCode(null, 'SIGTERM'), 143);
    assert.equal(getDelegationExitCode(null, 'SIGBREAK'), 149);
    assert.equal(getDelegationExitCode(null, 'SIGKILL'), 137);
    assert.equal(getDelegationExitCode(null, null), 1);
});

test('delegation forwards platform-specific termination signals', () => {
    assert.deepEqual(getDelegationForwardSignals('linux'), ['SIGINT', 'SIGTERM']);
    assert.deepEqual(getDelegationForwardSignals('win32'), ['SIGINT', 'SIGTERM', 'SIGBREAK']);
});

test('delegation preserves child exit code', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-exit-'));
    try {
        const harnessPath = writeDelegationHarness(tempRoot);
        const childScriptPath = path.join(tempRoot, 'exit-code-child.js');
        writeFile(childScriptPath, 'process.exit(Number(process.argv[2]));\n');

        const result = spawnHarnessSync(harnessPath, childScriptPath, ['7']);

        assert.equal(result.status, 7);
        assert.equal(result.error, undefined);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation inherits child stdout and stderr', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-output-'));
    try {
        const harnessPath = writeDelegationHarness(tempRoot);
        const childScriptPath = path.join(tempRoot, 'output-child.js');
        writeFile(childScriptPath, `
process.stdout.write('delegated stdout\\n');
process.stderr.write('delegated stderr\\n');
process.exit(0);
`);

        const result = spawnHarnessSync(harnessPath, childScriptPath);

        assert.equal(result.status, 0);
        assert.match(result.stdout, /delegated stdout/);
        assert.match(result.stderr, /delegated stderr/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation timeout terminates the child process', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-timeout-'));
    try {
        const harnessPath = writeDelegationHarness(tempRoot);
        const pidPath = path.join(tempRoot, 'child.pid');
        const childScriptPath = path.join(tempRoot, 'timeout-child.js');
        writeFile(childScriptPath, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`);

        const child = spawnHarness(harnessPath, childScriptPath, [], {
            ...process.env,
            GARDA_LAUNCHER_DELEGATION_TIMEOUT_MS: '1000'
        });
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });

        await waitForStdout(child, 'ready');
        const delegatedPid = Number(fs.readFileSync(pidPath, 'utf8'));
        const result = await waitForClose(child);

        assert.notEqual(result.status, 0);
        assert.match(stderr, /delegated CLI timed out after 1000ms/);
        assert.equal(await waitForProcessExit(delegatedPid), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation forwards SIGTERM to the child on POSIX', {
    skip: process.platform === 'win32' ? 'POSIX signal handler semantics are not portable on Windows.' : false
}, async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-signal-'));
    try {
        const harnessPath = writeDelegationHarness(tempRoot);
        const childScriptPath = path.join(tempRoot, 'signal-child.js');
        writeFile(childScriptPath, `
process.on('SIGTERM', () => {
  process.stdout.write('child-sigterm\\n');
  process.exit(42);
});
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`);

        const child = spawnHarness(harnessPath, childScriptPath);
        let stdout = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        await waitForStdout(child, 'ready');

        child.kill('SIGTERM');
        const result = await waitForClose(child);

        assert.equal(result.status, 42);
        assert.equal(result.signal, null);
        assert.match(stdout, /child-sigterm/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation start-dir dedupe preserves case-distinct paths for case-sensitive filesystems', () => {
    const cwd = path.resolve('/tmp/repo');
    const targetRoot = path.resolve('/tmp/Repo');

    const startDirs = resolveDelegationStartDirs(['status', '--target-root', targetRoot], cwd);

    assert.deepEqual(startDirs.map((entry) => entry.startDir), [targetRoot, cwd]);
    assert.deepEqual(startDirs.map((entry) => entry.source), ['target_root', 'cwd']);
});

test('delegation trust model treats self-hosted source checkout as trusted without launcher delegation', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-trust-self-hosted-'));
    try {
        const sourceRoot = path.join(tempRoot, 'source');
        writePackageRoot(sourceRoot, { sourceCheckout: true });
        const currentScriptPath = path.join(sourceRoot, 'bin', 'garda.js');

        const evidence = resolveDelegatedLauncherTrustEvidence([], sourceRoot, currentScriptPath, sourceRoot);

        assert.equal(evidence.current_runtime.runtime_kind, 'source_checkout');
        assert.equal(evidence.current_runtime.package_installed_under_node_modules, false);
        assert.equal(evidence.current_runtime.recognized_package_name, true);
        assert.equal(evidence.delegated_runtime, null);
        assert.equal(evidence.implementation_delegation.decision, 'not_required');
        assert.equal(evidence.implementation_delegation.trust_level, 'trusted_self_hosted');
        assert.equal(evidence.mandatory_review_delegation.decision, 'allowed');
        assert.equal(evidence.mandatory_review_delegation.requires_provider_launch_attestation, true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation trust model blocks delegation when GARDA_NO_DELEGATE is active', () => {
    const previous = process.env[GARDA_NO_DELEGATE_ENV];
    process.env[GARDA_NO_DELEGATE_ENV] = '1';
    try {
        const evidence = buildDelegationTrustEvidence(
            {
                package_root: path.resolve('/tmp/garda-source'),
                runtime_kind: 'source_checkout',
                package_installed_under_node_modules: false,
                recognized_package_name: true,
                package_name: 'garda-agent-orchestrator',
                package_version: '1.0.0'
            },
            null
        );

        assert.equal(evidence.no_delegate_mode?.active, true);
        assert.equal(evidence.implementation_delegation.decision, 'blocked');
        assert.equal(evidence.mandatory_review_delegation.decision, 'blocked');
        assert.match(evidence.mandatory_review_delegation.reason, /GARDA_NO_DELEGATE is active/);
    } finally {
        if (previous === undefined) {
            delete process.env[GARDA_NO_DELEGATE_ENV];
        } else {
            process.env[GARDA_NO_DELEGATE_ENV] = previous;
        }
    }
});

test('delegation trust model does not trust unrecognized current runtime identity', () => {
    const evidence = buildDelegationTrustEvidence(
        {
            package_root: path.resolve('/tmp/unrecognized-source'),
            runtime_kind: 'source_checkout',
            package_installed_under_node_modules: false,
            recognized_package_name: false,
            package_name: 'not-garda-agent-orchestrator',
            package_version: null
        },
        {
            cli_path: path.resolve('/tmp/source/bin/garda.js'),
            root: path.resolve('/tmp/source'),
            runtime_kind: 'source_checkout',
            reason: 'target_root_source_checkout',
            package_name: 'garda-agent-orchestrator',
            package_version: '1.0.0',
            path_containment: 'validated'
        }
    );

    assert.equal(evidence.delegated_runtime, null);
    assert.equal(evidence.implementation_delegation.decision, 'not_required');
    assert.equal(evidence.implementation_delegation.trust_level, 'unknown');
    assert.match(evidence.implementation_delegation.reason, /package name is not recognized/);
    assert.equal(evidence.mandatory_review_delegation.decision, 'blocked');
    assert.equal(evidence.mandatory_review_delegation.trust_level, 'unknown');
    assert.equal(evidence.mandatory_review_delegation.requires_provider_launch_attestation, true);
});

test('delegation trust model fails closed for recognized package with unknown runtime kind', () => {
    const evidence = buildDelegationTrustEvidence(
        {
            package_root: path.resolve('/tmp/spoofed-garda-shape'),
            runtime_kind: 'unknown',
            package_installed_under_node_modules: false,
            recognized_package_name: true,
            package_name: 'garda-agent-orchestrator',
            package_version: null
        },
        {
            cli_path: path.resolve('/tmp/source/bin/garda.js'),
            root: path.resolve('/tmp/source'),
            runtime_kind: 'source_checkout',
            reason: 'target_root_source_checkout',
            package_name: 'garda-agent-orchestrator',
            package_version: '1.0.0',
            path_containment: 'validated'
        }
    );

    assert.equal(evidence.delegated_runtime, null);
    assert.equal(evidence.implementation_delegation.decision, 'blocked');
    assert.equal(evidence.implementation_delegation.trust_level, 'unknown');
    assert.match(evidence.implementation_delegation.reason, /runtime kind is unknown/);
    assert.equal(evidence.mandatory_review_delegation.decision, 'blocked');
    assert.equal(evidence.mandatory_review_delegation.trust_level, 'unknown');
    assert.equal(evidence.mandatory_review_delegation.requires_provider_launch_attestation, true);
});

test('delegation trust model fails closed for on-disk spoofed runtime shape', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-trust-spoofed-shape-'));
    try {
        const spoofedRoot = path.join(tempRoot, 'spoofed-garda-shape');
        writePackageRoot(spoofedRoot);
        const currentScriptPath = path.join(spoofedRoot, 'bin', 'garda.js');

        const evidence = resolveDelegatedLauncherTrustEvidence([], spoofedRoot, currentScriptPath, spoofedRoot);

        assert.equal(evidence.current_runtime.runtime_kind, 'unknown');
        assert.equal(evidence.current_runtime.package_installed_under_node_modules, false);
        assert.equal(evidence.current_runtime.recognized_package_name, true);
        assert.equal(evidence.delegated_runtime, null);
        assert.equal(evidence.implementation_delegation.decision, 'blocked');
        assert.equal(evidence.implementation_delegation.trust_level, 'unknown');
        assert.match(evidence.implementation_delegation.reason, /runtime kind is unknown/);
        assert.equal(evidence.mandatory_review_delegation.decision, 'blocked');
        assert.equal(evidence.mandatory_review_delegation.trust_level, 'unknown');
        assert.equal(evidence.mandatory_review_delegation.requires_provider_launch_attestation, true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation trust model fails closed when launcher path is not owned by the claimed package root', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-trust-launcher-mismatch-'));
    try {
        const sourceRoot = path.join(tempRoot, 'source');
        const unrelatedRoot = path.join(tempRoot, 'unrelated');
        writePackageRoot(sourceRoot, { sourceCheckout: true });
        writePackageRoot(unrelatedRoot, { sourceCheckout: true });
        const mismatchedScriptPath = path.join(unrelatedRoot, 'bin', 'garda.js');

        const evidence = resolveDelegatedLauncherTrustEvidence([], sourceRoot, mismatchedScriptPath, sourceRoot);

        assert.equal(evidence.current_runtime.runtime_kind, 'unknown');
        assert.equal(evidence.delegated_runtime, null);
        assert.equal(evidence.implementation_delegation.decision, 'blocked');
        assert.match(evidence.implementation_delegation.reason, /runtime kind is unknown/);
        assert.equal(evidence.mandatory_review_delegation.decision, 'blocked');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation trust model allows installed package to delegate to trusted target-root source checkout', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-trust-source-target-'));
    try {
        const installedRoot = path.join(tempRoot, 'consumer', 'node_modules', 'garda-agent-orchestrator');
        const sourceRoot = path.join(tempRoot, 'source');
        writePackageRoot(installedRoot);
        writePackageRoot(sourceRoot, { sourceCheckout: true });
        const currentScriptPath = path.join(installedRoot, 'bin', 'garda.js');

        const evidence = resolveDelegatedLauncherTrustEvidence(
            ['status', '--target-root', sourceRoot],
            path.join(tempRoot, 'consumer'),
            currentScriptPath,
            installedRoot
        );

        assert.equal(evidence.current_runtime.runtime_kind, 'packaged_npm');
        assert.equal(evidence.delegated_runtime?.cli_path, path.join(sourceRoot, 'bin', 'garda.js'));
        assert.equal(evidence.delegated_runtime?.runtime_kind, 'source_checkout');
        assert.equal(evidence.delegated_runtime?.reason, 'target_root_source_checkout');
        assert.equal(evidence.delegated_runtime?.package_name, 'garda-agent-orchestrator');
        assert.equal(evidence.delegated_runtime?.path_containment, 'validated');
        assert.equal(evidence.implementation_delegation.decision, 'allowed');
        assert.equal(evidence.implementation_delegation.trust_level, 'trusted_local_workspace');
        assert.equal(evidence.mandatory_review_delegation.decision, 'allowed');
        assert.equal(evidence.mandatory_review_delegation.requires_provider_launch_attestation, true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation trust model blocks target roots with unrecognized package metadata', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-trust-unrecognized-target-'));
    try {
        const installedRoot = path.join(tempRoot, 'consumer', 'node_modules', 'garda-agent-orchestrator');
        const sourceRoot = path.join(tempRoot, 'source');
        writePackageRoot(installedRoot);
        writePackageRoot(sourceRoot, { sourceCheckout: true, packageName: 'not-garda-agent-orchestrator' });
        const currentScriptPath = path.join(installedRoot, 'bin', 'garda.js');

        const evidence = resolveDelegatedLauncherTrustEvidence(
            ['status', '--target-root', sourceRoot],
            path.join(tempRoot, 'consumer'),
            currentScriptPath,
            installedRoot
        );

        assert.equal(evidence.current_runtime.runtime_kind, 'packaged_npm');
        assert.equal(evidence.delegated_runtime, null);
        assert.equal(evidence.implementation_delegation.decision, 'blocked');
        assert.match(evidence.implementation_delegation.reason, /could not resolve a trusted local source checkout or deployed bundle target/);
        assert.equal(evidence.mandatory_review_delegation.decision, 'blocked');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation trust model rejects candidate launcher paths escaping the package root', {
    skip: process.platform === 'win32' ? 'Symlink creation privileges are environment-dependent on Windows.' : false
}, () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-trust-escaping-launcher-'));
    try {
        const installedRoot = path.join(tempRoot, 'consumer', 'node_modules', 'garda-agent-orchestrator');
        const sourceRoot = path.join(tempRoot, 'source');
        const outsideRoot = path.join(tempRoot, 'outside');
        writePackageRoot(installedRoot);
        writePackageRoot(sourceRoot, { sourceCheckout: true });
        writeFile(path.join(outsideRoot, 'garda.js'), '#!/usr/bin/env node\n');
        fs.rmSync(path.join(sourceRoot, 'bin', 'garda.js'), { force: true });
        fs.symlinkSync(path.join(outsideRoot, 'garda.js'), path.join(sourceRoot, 'bin', 'garda.js'));
        const currentScriptPath = path.join(installedRoot, 'bin', 'garda.js');

        const evidence = resolveDelegatedLauncherTrustEvidence(
            ['status', '--target-root', sourceRoot],
            path.join(tempRoot, 'consumer'),
            currentScriptPath,
            installedRoot
        );

        assert.equal(evidence.delegated_runtime, null);
        assert.equal(evidence.implementation_delegation.decision, 'blocked');
        assert.equal(evidence.mandatory_review_delegation.decision, 'blocked');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation trust model allows installed package to delegate to trusted deployed bundle target', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-trust-bundle-target-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const installedRoot = path.join(workspaceRoot, 'node_modules', 'garda-agent-orchestrator');
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        writePackageRoot(installedRoot);
        writePackageRoot(bundleRoot, { deployedBundle: true });
        const currentScriptPath = path.join(installedRoot, 'bin', 'garda.js');

        const evidence = resolveDelegatedLauncherTrustEvidence(
            ['status', '--target-root', workspaceRoot],
            workspaceRoot,
            currentScriptPath,
            installedRoot
        );

        assert.equal(evidence.current_runtime.runtime_kind, 'packaged_npm');
        assert.equal(evidence.delegated_runtime?.cli_path, path.join(bundleRoot, 'bin', 'garda.js'));
        assert.equal(evidence.delegated_runtime?.runtime_kind, 'deployed_bundle');
        assert.equal(evidence.delegated_runtime?.reason, 'target_root_deployed_bundle');
        assert.equal(evidence.implementation_delegation.decision, 'allowed');
        assert.equal(evidence.implementation_delegation.trust_level, 'trusted_local_workspace');
        assert.equal(evidence.mandatory_review_delegation.decision, 'allowed');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation trust model treats self-hosted deployed bundle as launcher-local packaged runtime', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-trust-self-bundle-'));
    try {
        const bundleRoot = path.join(tempRoot, 'garda-agent-orchestrator');
        writePackageRoot(bundleRoot, { deployedBundle: true });
        const currentScriptPath = path.join(bundleRoot, 'bin', 'garda.js');

        const evidence = resolveDelegatedLauncherTrustEvidence([], bundleRoot, currentScriptPath, bundleRoot);

        assert.equal(evidence.current_runtime.runtime_kind, 'deployed_bundle');
        assert.equal(evidence.current_runtime.package_installed_under_node_modules, false);
        assert.equal(evidence.current_runtime.recognized_package_name, true);
        assert.equal(evidence.delegated_runtime, null);
        assert.equal(evidence.implementation_delegation.decision, 'not_required');
        assert.equal(evidence.implementation_delegation.trust_level, 'packaged_runtime');
        assert.match(evidence.implementation_delegation.reason, /launcher delegation is not required/);
        assert.equal(evidence.mandatory_review_delegation.decision, 'allowed');
        assert.equal(evidence.mandatory_review_delegation.trust_level, 'packaged_runtime');
        assert.equal(evidence.mandatory_review_delegation.requires_provider_launch_attestation, true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation trust model classifies direct deployed bundle roots as bundle targets', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-trust-direct-bundle-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const installedRoot = path.join(workspaceRoot, 'node_modules', 'garda-agent-orchestrator');
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        writePackageRoot(installedRoot);
        writePackageRoot(bundleRoot, { deployedBundle: true });
        const currentScriptPath = path.join(installedRoot, 'bin', 'garda.js');

        const targetEvidence = resolveDelegatedLauncherTrustEvidence(
            ['status', '--target-root', bundleRoot],
            workspaceRoot,
            currentScriptPath,
            installedRoot
        );
        const cwdEvidence = resolveDelegatedLauncherTrustEvidence(
            ['status'],
            bundleRoot,
            currentScriptPath,
            installedRoot
        );

        assert.equal(targetEvidence.delegated_runtime?.cli_path, path.join(bundleRoot, 'bin', 'garda.js'));
        assert.equal(targetEvidence.delegated_runtime?.runtime_kind, 'deployed_bundle');
        assert.equal(targetEvidence.delegated_runtime?.reason, 'target_root_deployed_bundle');
        assert.equal(cwdEvidence.delegated_runtime?.cli_path, path.join(bundleRoot, 'bin', 'garda.js'));
        assert.equal(cwdEvidence.delegated_runtime?.runtime_kind, 'deployed_bundle');
        assert.equal(cwdEvidence.delegated_runtime?.reason, 'cwd_deployed_bundle');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation trust model blocks unrecognized packaged runtime identity at wrapper level', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-trust-unrecognized-package-'));
    try {
        const installedRoot = path.join(tempRoot, 'consumer', 'node_modules', 'not-garda-agent-orchestrator');
        writePackageRoot(installedRoot, { packageName: 'not-garda-agent-orchestrator' });
        const currentScriptPath = path.join(installedRoot, 'bin', 'garda.js');

        const evidence = resolveDelegatedLauncherTrustEvidence(
            ['status'],
            path.join(tempRoot, 'consumer'),
            currentScriptPath,
            installedRoot
        );

        assert.equal(evidence.current_runtime.runtime_kind, 'packaged_npm');
        assert.equal(evidence.current_runtime.package_installed_under_node_modules, true);
        assert.equal(evidence.current_runtime.recognized_package_name, false);
        assert.equal(evidence.delegated_runtime, null);
        assert.equal(evidence.implementation_delegation.decision, 'blocked');
        assert.equal(evidence.implementation_delegation.trust_level, 'unknown');
        assert.match(evidence.implementation_delegation.reason, /package name is not recognized/);
        assert.equal(evidence.mandatory_review_delegation.decision, 'blocked');
        assert.equal(evidence.mandatory_review_delegation.trust_level, 'unknown');
        assert.equal(evidence.mandatory_review_delegation.requires_provider_launch_attestation, true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation trust model blocks installed package when no trusted runtime target exists', () => {
    const evidence = buildDelegationTrustEvidence(
        {
            package_root: path.resolve('/tmp/consumer/node_modules/garda-agent-orchestrator'),
            runtime_kind: 'packaged_npm',
            package_installed_under_node_modules: true,
            recognized_package_name: true,
            package_name: 'garda-agent-orchestrator',
            package_version: null
        },
        null
    );

    assert.equal(evidence.delegated_runtime, null);
    assert.equal(evidence.implementation_delegation.decision, 'blocked');
    assert.equal(evidence.implementation_delegation.trust_level, 'unknown');
    assert.match(evidence.implementation_delegation.reason, /could not resolve a trusted local source checkout or deployed bundle target/);
    assert.equal(evidence.mandatory_review_delegation.decision, 'blocked');
    assert.equal(evidence.mandatory_review_delegation.trust_level, 'unknown');
    assert.equal(evidence.mandatory_review_delegation.requires_provider_launch_attestation, true);
});
