#!/usr/bin/env node
/**
 * CI-friendly config validation script.
 *
 * Usage:
 *   node scripts/validate-config.cjs [--bundle-root <path>]
 *
 * Exits 0 on success, 1 on validation failure.
 * Designed for use in GitHub Actions or local pre-commit hooks.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
let bundleRoot = path.resolve(repoRoot, 'garda-agent-orchestrator');

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bundle-root' && args[i + 1]) {
        bundleRoot = path.resolve(args[i + 1]);
        i++;
    }
}

const cliPath = path.join(repoRoot, 'bin', 'garda.js');
const executionCwd = fs.existsSync(bundleRoot) && fs.statSync(bundleRoot).isDirectory()
    ? bundleRoot
    : repoRoot;

function resolveCliRuntimeMainPath() {
    const candidates = [
        path.join(repoRoot, '.node-build', 'src', 'cli', 'main.js'),
        path.join(repoRoot, 'dist', 'src', 'cli', 'main.js')
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function main() {
    const runtimeMainPath = resolveCliRuntimeMainPath();
    if (runtimeMainPath) {
        const previousCwd = process.cwd();
        const previousExitCode = process.exitCode;
        try {
            process.chdir(executionCwd);
            process.exitCode = 0;
            const runtimeMain = require(runtimeMainPath);
            await runtimeMain.runCliMainWithHandling(
                ['gate', 'validate-config', '--bundle-root', bundleRoot, '--compact'],
                repoRoot
            );
            return (process.exitCode || 0) === 0 ? 0 : 1;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }
    }

    const { execFileSync } = require('node:child_process');
    try {
        const output = execFileSync(
            process.execPath,
            [cliPath, 'gate', 'validate-config', '--bundle-root', bundleRoot, '--compact'],
            { cwd: executionCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], shell: false }
        );
        process.stdout.write(output);
        return 0;
    } catch (err) {
        if (err.stdout) {
            process.stdout.write(err.stdout);
        }
        if (err.stderr) {
            process.stderr.write(err.stderr);
        }
        return 1;
    }
}

main().catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err));
    process.stderr.write('\n');
    process.exit(1);
}).then((exitCode) => {
    if (typeof exitCode === 'number') {
        process.exit(exitCode);
    }
});
