import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    installSignalHandlers,
    uninstallSignalHandlers,
    registerCleanup,
    unregisterCleanup,
    registerTempRoot,
    getShutdownSignal,
    computeSignalExitCode
} from '../../../src/cli/signal-handler';
import {
    SHUTDOWN_CLEANUP_CONCURRENCY,
    spawnStreamed,
    SUBPROCESS_TERMINATION_TIMEOUT_MS
} from '../../../src/core/subprocess';

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForCondition(condition: () => boolean, timeoutMs = 5000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (condition()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return condition();
}

afterEach(() => {
    uninstallSignalHandlers();
});

describe('registerCleanup / unregisterCleanup', () => {
    it('registerCleanup returns a dispose function', () => {
        installSignalHandlers();
        const dispose = registerCleanup(() => {});
        assert.equal(typeof dispose, 'function');
        dispose();
    });

    it('unregisterCleanup removes a previously registered callback', () => {
        installSignalHandlers();
        const fn = () => {};
        registerCleanup(fn);
        unregisterCleanup(fn);
    });

    it('dispose function returned by registerCleanup unregisters the callback', () => {
        installSignalHandlers();
        let called = false;
        const dispose = registerCleanup(() => { called = true; });
        dispose();
        assert.equal(called, false);
    });
});

describe('getShutdownSignal', () => {
    it('returns null before installSignalHandlers is called', () => {
        assert.equal(getShutdownSignal(), null);
    });

    it('returns an AbortSignal after installSignalHandlers', () => {
        installSignalHandlers();
        const signal = getShutdownSignal();
        assert.ok(signal, 'signal should not be null');
        assert.equal(signal.aborted, false);
    });

    it('returns null after uninstallSignalHandlers', () => {
        installSignalHandlers();
        uninstallSignalHandlers();
        assert.equal(getShutdownSignal(), null);
    });
});

describe('installSignalHandlers', () => {
    it('is idempotent – calling twice does not throw', () => {
        installSignalHandlers();
        installSignalHandlers(); // second call is a no-op
        const signal = getShutdownSignal();
        assert.ok(signal);
    });

    it('installs one coordinator listener per supported termination signal', () => {
        const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
        if (process.platform === 'win32') signals.push('SIGBREAK');
        const baseline = new Map(signals.map((signal) => [signal, process.listenerCount(signal)]));

        installSignalHandlers();
        installSignalHandlers();

        for (const signal of signals) {
            assert.equal(process.listenerCount(signal), (baseline.get(signal) || 0) + 1, signal);
        }

        uninstallSignalHandlers();
        for (const signal of signals) {
            assert.equal(process.listenerCount(signal), baseline.get(signal), signal);
        }
    });
});

describe('registerTempRoot', () => {
    it('returns a dispose function', () => {
        installSignalHandlers();
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-signal-test-'));
        try {
            const dispose = registerTempRoot(tempDir);
            assert.equal(typeof dispose, 'function');
            dispose();
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('dispose does not throw for already-removed directories', () => {
        installSignalHandlers();
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-signal-test-'));
        const dispose = registerTempRoot(tempDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
        assert.doesNotThrow(() => dispose());
    });

    it('works without installSignalHandlers (cleanup only on explicit call)', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-signal-test-'));
        try {
            const dispose = registerTempRoot(tempDir);
            assert.equal(typeof dispose, 'function');
            dispose();
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});

describe('uninstallSignalHandlers', () => {
    it('clears all registered cleanup callbacks', () => {
        installSignalHandlers();
        registerCleanup(() => {});
        registerCleanup(() => {});
        uninstallSignalHandlers();
        assert.equal(getShutdownSignal(), null);
    });

    it('is safe to call when handlers are not installed', () => {
        assert.doesNotThrow(() => uninstallSignalHandlers());
    });
});

describe('computeSignalExitCode — signal-to-exit-code mapping', () => {
    it('SIGINT → 130 (128 + 2)', () => {
        assert.equal(computeSignalExitCode('SIGINT'), 130);
    });

    it('SIGTERM → 143 (128 + 15)', () => {
        assert.equal(computeSignalExitCode('SIGTERM'), 143);
    });

    it('SIGHUP → 129 (128 + 1)', () => {
        assert.equal(computeSignalExitCode('SIGHUP'), 129);
    });

    it('SIGPIPE → 141 (128 + 13)', () => {
        assert.equal(computeSignalExitCode('SIGPIPE'), 141);
    });

    it('SIGBREAK → 149 (128 + 21)', () => {
        assert.equal(computeSignalExitCode('SIGBREAK'), 149);
    });

    it('SIGWINCH → 156 (128 + 28)', () => {
        assert.equal(computeSignalExitCode('SIGWINCH'), 156);
    });

    it('null → EXIT_SIGNAL_INTERRUPT (130) as fallback', () => {
        assert.equal(computeSignalExitCode(null), 130);
    });

    it('unknown signal → EXIT_SIGNAL_INTERRUPT (130) as fallback', () => {
        assert.equal(computeSignalExitCode('SIGUNKNOWN' as NodeJS.Signals), 130);
    });
});

describe('onSignal integration — exit code propagation', () => {
    let exitCode: number | null;
    let originalExit: typeof process.exit;

    beforeEach(() => {
        exitCode = null;
        originalExit = process.exit;
        process.exit = ((code?: number) => {
            exitCode = code ?? null;
            return undefined as never;
        }) as typeof process.exit;
    });

    afterEach(() => {
        process.exit = originalExit;
        uninstallSignalHandlers();
    });

    it('SIGINT → process.exit(130)', async () => {
        installSignalHandlers();
        const handler = (process.listeners('SIGINT').pop() as Function) || (() => {});
        handler('SIGINT');
        assert.equal(await waitForCondition(() => exitCode !== null), true);
        assert.equal(exitCode, 130);
    });

    it('SIGTERM → process.exit(143)', async () => {
        installSignalHandlers();
        const handler = (process.listeners('SIGTERM').pop() as Function) || (() => {});
        handler('SIGTERM');
        assert.equal(await waitForCondition(() => exitCode !== null), true);
        assert.equal(exitCode, 143);
    });

    it('SIGHUP → process.exit(129)', async () => {
        installSignalHandlers();
        const handler = (process.listeners('SIGHUP').pop() as Function) || (() => {});
        handler('SIGHUP');
        assert.equal(await waitForCondition(() => exitCode !== null), true);
        assert.equal(exitCode, 129);
    });

    it('SIGBREAK invokes coordinated cleanup and preserves exit code 149 on Windows', async () => {
        if (process.platform !== 'win32') return;
        let cleanupFinished = false;
        const signalListenersBefore = process.listeners('SIGBREAK');
        installSignalHandlers();
        registerCleanup(async function () {
            await new Promise((resolve) => setTimeout(resolve, 25));
            cleanupFinished = true;
        });
        const handler = process.listeners('SIGBREAK').find((listener) => !signalListenersBefore.includes(listener));
        assert.ok(handler, 'coordinator SIGBREAK listener should be installed');

        handler('SIGBREAK');
        assert.equal(await waitForCondition(() => exitCode !== null), true);
        assert.equal(cleanupFinished, true);
        assert.equal(exitCode, 149);
    });

    it('ignores replay signal and does not exit again', async () => {
        installSignalHandlers();
        const handler = (process.listeners('SIGTERM').pop() as Function) || (() => {});
        handler('SIGTERM');
        assert.equal(await waitForCondition(() => exitCode !== null), true);
        assert.equal(exitCode, 143);
        exitCode = null;
        handler('SIGTERM');
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(exitCode, null, 'second call should not exit');
    });

    it('awaits asynchronous cleanup callbacks before exiting', async () => {
        let cleanupFinished = false;
        installSignalHandlers();
        registerCleanup(async function () {
            await new Promise((resolve) => setTimeout(resolve, 50));
            cleanupFinished = true;
        });
        const handler = (process.listeners('SIGTERM').pop() as Function) || (() => {});

        handler('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(exitCode, null);
        assert.equal(await waitForCondition(() => exitCode !== null), true);
        assert.equal(cleanupFinished, true);
        assert.equal(exitCode, 143);
    });

    it('prevents unbounded cleanup callback fan-out', async () => {
        let active = 0;
        let peakActive = 0;
        let completed = 0;
        installSignalHandlers();
        for (let index = 0; index < SHUTDOWN_CLEANUP_CONCURRENCY * 3; index += 1) {
            registerCleanup(async function () {
                active += 1;
                peakActive = Math.max(peakActive, active);
                await new Promise((resolve) => setTimeout(resolve, 15));
                active -= 1;
                completed += 1;
            });
        }
        const handler = process.listeners('SIGTERM').at(-1);
        assert.ok(handler);

        handler('SIGTERM');
        assert.equal(await waitForCondition(() => exitCode !== null), true);
        assert.equal(completed, SHUTDOWN_CLEANUP_CONCURRENCY * 3);
        assert.equal(peakActive, SHUTDOWN_CLEANUP_CONCURRENCY);
        assert.equal(exitCode, 143);
    });

    it('prevents a non-settling cleanup callback from blocking shutdown past its deadline', async () => {
        installSignalHandlers();
        registerCleanup(function () {
            return new Promise<void>(() => {});
        });
        const handler = process.listeners('SIGTERM').at(-1);
        assert.ok(handler);
        const startedAt = Date.now();

        handler('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(exitCode, null, 'shutdown skipped its bounded cleanup wait');
        assert.equal(
            await waitForCondition(() => exitCode !== null, SUBPROCESS_TERMINATION_TIMEOUT_MS + 2_000),
            true,
            'shutdown remained blocked beyond its cleanup deadline'
        );
        const elapsedMs = Date.now() - startedAt;
        assert.ok(
            elapsedMs >= SUBPROCESS_TERMINATION_TIMEOUT_MS - 250,
            `cleanup deadline fired too early: ${elapsedMs}ms`
        );
        assert.ok(
            elapsedMs < SUBPROCESS_TERMINATION_TIMEOUT_MS + 1_000,
            `cleanup deadline fired too late: ${elapsedMs}ms`
        );
        assert.equal(exitCode, 143);
    });

    it('blocks new admission and terminates two active process trees before preserving the signal exit code', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-signal-children-'));
        const descendantPaths = [
            path.join(tempDir, 'descendant-1.pid'),
            path.join(tempDir, 'descendant-2.pid')
        ];
        const signalListenersBefore = process.listeners('SIGTERM');
        installSignalHandlers();
        const handler = process.listeners('SIGTERM').find((listener) => !signalListenersBefore.includes(listener));
        assert.ok(handler, 'coordinator signal listener should be installed');

        const childScript = function (descendantPath: string): string {
            return [
                "const cp = require('node:child_process');",
                "const fs = require('node:fs');",
                "const descendant = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });",
                `fs.writeFileSync(${JSON.stringify(descendantPath)}, String(descendant.pid));`,
                'setTimeout(()=>{},60000);'
            ].join('\n');
        };

        try {
            const children = descendantPaths.map((descendantPath) => spawnStreamed(
                process.execPath,
                ['-e', childScript(descendantPath)],
                { timeoutMs: 30_000 }
            ));
            assert.equal(
                await waitForCondition(() => descendantPaths.every((descendantPath) => fs.existsSync(descendantPath))),
                true,
                'both child trees should be running before shutdown'
            );
            assert.equal(process.listenerCount('SIGTERM'), signalListenersBefore.length + 1);

            const startedAt = Date.now();
            handler('SIGTERM');
            await assert.rejects(
                () => spawnStreamed(process.execPath, ['-e', 'process.exit(0)']),
                /process termination is in progress/
            );
            await Promise.all(children);
            assert.equal(await waitForCondition(() => exitCode !== null), true);

            const descendantPids = descendantPaths.map((descendantPath) => Number(
                fs.readFileSync(descendantPath, 'utf8')
            ));
            assert.equal(
                await waitForCondition(() => descendantPids.every((pid) => !isProcessAlive(pid))),
                true,
                'no descendant process should remain alive'
            );
            assert.equal(exitCode, 143);
            assert.ok(
                Date.now() - startedAt < SUBPROCESS_TERMINATION_TIMEOUT_MS + 3000,
                'signal cleanup should be bounded'
            );
        } finally {
            uninstallSignalHandlers();
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
