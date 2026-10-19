import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    UI_ACTION_CLEANUP_TIMEOUT_MS,
    UI_ACTION_DEFAULT_TIMEOUT_MS,
    UI_ACTION_INSPECTION_TIMEOUT_MS,
    formatUiActionTimeoutMessage,
    runUiActionCommand
} from '../../../src/reports/ui/actions/action-common';
import { buildUiWorkspaceActionDefinitions } from '../../../src/reports/ui/actions/workspace-actions';
import type { UiActionDefinition } from '../../../src/reports/ui/actions/types';
import { SUBPROCESS_TERMINATION_TIMEOUT_MS } from '../../../src/core/subprocess';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid: number, timeoutMs = 5000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (!isProcessAlive(pid)) {
            return true;
        }
        await delay(100);
    }
    return !isProcessAlive(pid);
}

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-ui-action-timeout-'));
}

function cleanupTmpDir(tmpDir: string): void {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('runUiActionCommand reports timeout and kills the subprocess tree', async () => {
    const repoRoot = makeTmpDir();
    try {
        const timeoutMs = 3_000;
        const schedulingMarginMs = 1_000;
        const markerDelayMs = timeoutMs + SUBPROCESS_TERMINATION_TIMEOUT_MS + schedulingMarginMs;
        const childLifetimeMs = markerDelayMs + schedulingMarginMs;
        const markerPath = path.join(repoRoot, 'child-survived.txt');
        const childPidPath = path.join(repoRoot, 'child.pid');
        const childScript = [
            `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'alive'), ${markerDelayMs});`,
            `setTimeout(() => {}, ${childLifetimeMs});`
        ].join('');
        const parentScript = [
            'const childProcess = require("node:child_process");',
            'const fs = require("node:fs");',
            `const child = childProcess.spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
            `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
            `setTimeout(() => {}, ${childLifetimeMs});`
        ].join('');
        const action: UiActionDefinition = {
            id: 'timeout-regression',
            category: 'Test',
            label: 'Timeout Regression',
            description: 'Exercise local UI action timeout cleanup.',
            mutates: false,
            enabled: true,
            unavailable_reason: null,
            requires_confirmation: false,
            confirmation_phrase: null,
            timeout_ms: timeoutMs,
            command: {
                executable: process.execPath,
                args: ['-e', parentScript],
                display: 'node -e <timeout-regression>'
            }
        };

        const startedAt = performance.now();
        const result = await runUiActionCommand(action, repoRoot);

        assert.equal(result.timed_out, true);
        assert.equal(result.timeout_ms, timeoutMs);
        assert.notEqual(result.exit_code, 0);
        assert.ok(performance.now() - startedAt < markerDelayMs, 'action exceeded command and cleanup budgets');
        assert.match(result.stderr, /Process timed out after 3000 ms/u);
        assert.match(result.stderr, new RegExp(formatUiActionTimeoutMessage(3000).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
        assert.equal(fs.existsSync(childPidPath), true, 'child process pid should be captured before timeout cleanup');
        const childPid = Number(fs.readFileSync(childPidPath, 'utf8'));
        assert.ok(Number.isInteger(childPid) && childPid > 0);
        assert.equal(
            await waitForProcessExit(childPid),
            true,
            `child process ${childPid} should not survive UI action timeout cleanup`
        );
        assert.equal(fs.existsSync(markerPath), false, 'child process should not survive UI action timeout cleanup');
    } finally {
        cleanupTmpDir(repoRoot);
    }
});

test('workspace UI actions only expose visible switch controls with default timeout budgets', () => {
    const repoRoot = makeTmpDir();
    try {
        const actions = buildUiWorkspaceActionDefinitions(repoRoot);
        const actionIds = actions.map((action) => action.id).sort();

        assert.deepEqual(actionIds, [
            'doctor',
            'garda-off',
            'garda-on',
            'repair-inspect',
            'repair-locks-cleanup-stale',
            'repair-protected-manifest',
            'repair-rebuild-indexes',
            'status',
            'status-why-blocked'
        ]);
        const timeoutById = new Map(actions.map((action) => [action.id, action.timeout_ms]));
        assert.equal(timeoutById.get('status'), UI_ACTION_INSPECTION_TIMEOUT_MS);
        assert.equal(timeoutById.get('doctor'), UI_ACTION_INSPECTION_TIMEOUT_MS);
        assert.equal(timeoutById.get('status-why-blocked'), UI_ACTION_INSPECTION_TIMEOUT_MS);
        assert.equal(timeoutById.get('repair-inspect'), UI_ACTION_INSPECTION_TIMEOUT_MS);
        assert.equal(timeoutById.get('repair-rebuild-indexes'), UI_ACTION_CLEANUP_TIMEOUT_MS);
        assert.equal(timeoutById.get('repair-protected-manifest'), UI_ACTION_CLEANUP_TIMEOUT_MS);
        assert.equal(timeoutById.get('repair-locks-cleanup-stale'), UI_ACTION_CLEANUP_TIMEOUT_MS);
        assert.equal(timeoutById.get('garda-on'), UI_ACTION_DEFAULT_TIMEOUT_MS);
        assert.equal(timeoutById.get('garda-off'), UI_ACTION_DEFAULT_TIMEOUT_MS);
    } finally {
        cleanupTmpDir(repoRoot);
    }
});

test('runUiActionCommand uses the UI allowlisted environment instead of inheriting parent secrets', async () => {
    const repoRoot = makeTmpDir();
    const secretEnvKey = 'GARDA_UI_ACTION_SECRET_REGRESSION';
    const previousSecret = process.env[secretEnvKey];
    try {
        process.env[secretEnvKey] = 'must-not-leak';
        const action: UiActionDefinition = {
            id: 'env-regression',
            category: 'Test',
            label: 'Env Regression',
            description: 'Verify local UI action subprocess env isolation.',
            mutates: false,
            enabled: true,
            unavailable_reason: null,
            requires_confirmation: false,
            confirmation_phrase: null,
            timeout_ms: 5_000,
            command: {
                executable: process.execPath,
                args: ['-e', `process.stdout.write(process.env.${secretEnvKey} || 'missing')`],
                display: 'node -e <env-regression>'
            }
        };

        const result = await runUiActionCommand(action, repoRoot);

        assert.equal(result.exit_code, 0);
        assert.equal(result.timed_out, false);
        assert.equal(result.stdout, 'missing');
    } finally {
        if (previousSecret === undefined) {
            delete process.env[secretEnvKey];
        } else {
            process.env[secretEnvKey] = previousSecret;
        }
        cleanupTmpDir(repoRoot);
    }
});
