import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildWindowsBatchCommandLine,
    DEFAULT_COMPILE_TIMEOUT_MS,
    DEFAULT_GIT_CLONE_TIMEOUT_MS,
    DEFAULT_GIT_TIMEOUT_MS,
    DEFAULT_NPM_TIMEOUT_MS,
    registerSubprocessSignalHandler,
    settleWithShutdownConcurrency,
    SHUTDOWN_CLEANUP_CONCURRENCY,
    SUBPROCESS_TERMINATION_TIMEOUT_MS,
    WINDOWS_EXIT_CLEANUP_BUDGET_MS,
    WINDOWS_PROCESS_TREE_TARGET_BATCH_MAX_CHARS,
    spawnStreamed,
    spawnShellCommand,
    spawnSyncWithTimeout
} from '../../../src/core/subprocess';

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
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !isProcessAlive(pid);
}

async function waitForFile(filePath: string, timeoutMs = 5000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (fs.existsSync(filePath)) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return fs.existsSync(filePath);
}

function createNodeBatchFixture(scriptSource = 'console.log("shelltest")'): { scriptPath: string; cleanup: () => void } {
    const batchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-batch-'));
    const jsPath = path.join(batchRoot, 'payload.js');
    const scriptPath = path.join(batchRoot, 'run-node.cmd');
    fs.writeFileSync(jsPath, `${scriptSource}\n`, 'utf8');
    fs.writeFileSync(scriptPath, `@echo off\r\n"${process.execPath}" "${jsPath}"\r\n`, 'utf8');
    return {
        scriptPath,
        cleanup() {
            fs.rmSync(batchRoot, { recursive: true, force: true });
        }
    };
}

describe('spawnStreamed', () => {
    it('shares one termination listener across concurrent children and removes it when idle', async () => {
        const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
        if (process.platform === 'win32') signals.push('SIGBREAK');
        const baseline = new Map(signals.map((signal) => [signal, process.listenerCount(signal)]));
        const children = [1, 2].map(() => spawnStreamed(
            process.execPath,
            ['-e', 'setTimeout(()=>{},250)'],
            { timeoutMs: 5000 }
        ));

        for (const signal of signals) {
            assert.equal(process.listenerCount(signal), (baseline.get(signal) || 0) + 1, signal);
        }

        await Promise.all(children);
        for (const signal of signals) {
            assert.equal(process.listenerCount(signal), baseline.get(signal), signal);
        }
    });

    it('captures stdout from a successful process', async () => {
        const result = await spawnStreamed(process.execPath, ['-e', 'console.log("hello")'], {
            timeoutMs: 5000
        });
        assert.equal(result.exitCode, 0);
        assert.match(result.stdout, /hello/);
        assert.equal(result.timedOut, false);
        assert.equal(result.cancelled, false);
    });

    it('captures stderr from a failing process', async () => {
        const result = await spawnStreamed(process.execPath, ['-e', 'console.error("fail"); process.exit(1)'], {
            timeoutMs: 5000
        });
        assert.equal(result.exitCode, 1);
        assert.match(result.stderr, /fail/);
        assert.equal(result.timedOut, false);
        assert.equal(result.cancelled, false);
    });

    it('times out a long-running process', async () => {
        const result = await spawnStreamed(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
            timeoutMs: 500
        });
        assert.equal(result.timedOut, true);
        assert.notEqual(result.exitCode, 0);
    });

    it('respects AbortController cancellation', async () => {
        const ac = new AbortController();
        const promise = spawnStreamed(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
            signal: ac.signal,
            timeoutMs: 30000
        });
        // Cancel quickly
        setTimeout(() => ac.abort(), 200);
        const result = await promise;
        assert.equal(result.cancelled, true);
    });

    it('resolves immediately when signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        const result = await spawnStreamed(process.execPath, ['-e', 'console.log("should not run")'], {
            signal: ac.signal
        });
        assert.equal(result.cancelled, true);
        assert.equal(result.stdout, '');
    });

    it('streams output via onStdout callback', async () => {
        const chunks: string[] = [];
        const result = await spawnStreamed(process.execPath, ['-e', 'console.log("chunk1"); console.log("chunk2")'], {
            timeoutMs: 5000,
            onStdout(chunk) { chunks.push(chunk); }
        });
        assert.equal(result.exitCode, 0);
        const combined = chunks.join('');
        assert.match(combined, /chunk1/);
        assert.match(combined, /chunk2/);
    });

    it('treats onSpawn observer failures as non-fatal diagnostics', async () => {
        let observedPid: number | null = null;
        const result = await spawnStreamed(process.execPath, ['-e', 'console.log("still runs")'], {
            timeoutMs: 5000,
            onSpawn(child) {
                observedPid = child.pid;
                throw new Error('observer failed');
            }
        });

        assert.equal(result.exitCode, 0);
        assert.match(result.stdout, /still runs/);
        assert.equal(typeof observedPid, 'number');
    });

    it('rejects with ENOENT for missing executable', async () => {
        await assert.rejects(
            () => spawnStreamed('__nonexistent_executable_12345__', [], { timeoutMs: 5000 }),
            (err) => (err as Error).message.includes('not found in PATH')
        );
    });

    it('sets stdoutTruncated and stderrTruncated to false under normal output', async () => {
        const result = await spawnStreamed(process.execPath, ['-e', 'console.log("ok")'], {
            timeoutMs: 5000
        });
        assert.equal(result.stdoutTruncated, false);
        assert.equal(result.stderrTruncated, false);
        assert.equal(result.stdoutOriginalBytes, Buffer.byteLength(result.stdout, 'utf8'));
        assert.equal(result.stderrOriginalBytes, 0);
    });

    it('sets stdoutTruncated when stdout exceeds maxBuffer', async () => {
        // Emit ~200 bytes of stdout against a 64-byte maxBuffer
        const script = 'for(let i=0;i<20;i++) process.stdout.write("0123456789")';
        const result = await spawnStreamed(process.execPath, ['-e', script], {
            timeoutMs: 5000,
            maxBuffer: 64
        });
        assert.equal(result.stdoutTruncated, true);
        assert.equal(result.stderrTruncated, false);
        assert.equal(result.stdoutOriginalBytes, 200);
        assert.match(result.stdout, /output truncated; omitted \d+ bytes/);
        assert.ok(result.stdout.startsWith('0123456789'));
        assert.ok(result.stdout.endsWith('0123456789'));
    });

    it('retains the buffered head and tail of an overflowing stdout chunk', async () => {
        const payload = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(8);
        const result = await spawnStreamed(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(payload)})`], {
            timeoutMs: 5000,
            maxBuffer: 64
        });
        assert.equal(result.stdoutTruncated, true);
        assert.ok(result.stdout.startsWith('ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF'));
        assert.ok(result.stdout.endsWith('UVWXYZ'));
        assert.match(result.stdout, /output truncated; omitted \d+ bytes/);
    });

    it('retains valid UTF-8 stdout head and tail at multibyte boundaries', async () => {
        const payload = '😀AB'.repeat(20);
        const result = await spawnStreamed(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(payload)})`], {
            timeoutMs: 5000,
            capturePolicy: { mode: 'head-tail', maxBytes: 10, headBytes: 5, tailBytes: 5 }
        });
        assert.equal(result.stdoutTruncated, true);
        assert.ok(result.stdout.startsWith('😀A'));
        assert.ok(result.stdout.endsWith('AB'));
        assert.match(result.stdout, /output truncated; omitted \d+ bytes/);
    });

    it('sets stderrTruncated when stderr exceeds maxBuffer', async () => {
        const script = 'for(let i=0;i<20;i++) process.stderr.write("0123456789")';
        const result = await spawnStreamed(process.execPath, ['-e', script], {
            timeoutMs: 5000,
            maxBuffer: 64
        });
        assert.equal(result.stderrTruncated, true);
        assert.equal(result.stdoutTruncated, false);
        assert.equal(result.stderrOriginalBytes, 200);
        assert.match(result.stderr, /output truncated; omitted \d+ bytes/);
        assert.ok(result.stderr.startsWith('0123456789'));
        assert.ok(result.stderr.endsWith('0123456789'));
    });

    it('retains valid UTF-8 stderr head and tail at multibyte boundaries', async () => {
        const payload = '😀AB'.repeat(20);
        const result = await spawnStreamed(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(payload)})`], {
            timeoutMs: 5000,
            capturePolicy: { mode: 'head-tail', maxBytes: 10, headBytes: 5, tailBytes: 5 }
        });
        assert.equal(result.stderrTruncated, true);
        assert.ok(result.stderr.startsWith('😀A'));
        assert.ok(result.stderr.endsWith('AB'));
        assert.match(result.stderr, /output truncated; omitted \d+ bytes/);
    });

    it('delivers callbacks for all chunks even when buffer is truncated', async () => {
        const allChunks: string[] = [];
        const script = 'for(let i=0;i<20;i++) process.stdout.write("0123456789")';
        const result = await spawnStreamed(process.execPath, ['-e', script], {
            timeoutMs: 5000,
            maxBuffer: 64,
            onStdout(chunk) { allChunks.push(chunk); }
        });
        assert.equal(result.stdoutTruncated, true);
        // Callbacks receive the full output regardless of maxBuffer
        const callbackTotal = allChunks.join('').length;
        assert.ok(callbackTotal >= 200, `Expected >=200 chars via callback, got ${callbackTotal}`);
    });

    it('delivers stderr callbacks for all chunks even when buffer is truncated', async () => {
        const allChunks: string[] = [];
        const script = 'for(let i=0;i<20;i++) process.stderr.write("0123456789")';
        const result = await spawnStreamed(process.execPath, ['-e', script], {
            timeoutMs: 5000,
            maxBuffer: 64,
            onStderr(chunk) { allChunks.push(chunk); }
        });
        assert.equal(result.stderrTruncated, true);
        const callbackTotal = allChunks.join('').length;
        assert.ok(callbackTotal >= 200, `Expected >=200 chars via stderr callback, got ${callbackTotal}`);
    });

    it('reports truncated false for pre-aborted signal', async () => {
        const ac = new AbortController();
        ac.abort();
        const result = await spawnStreamed(process.execPath, ['-e', 'console.log("nope")'], {
            signal: ac.signal
        });
        assert.equal(result.cancelled, true);
        assert.equal(result.stdoutTruncated, false);
        assert.equal(result.stderrTruncated, false);
        assert.equal(result.stdoutOriginalBytes, 0);
        assert.equal(result.stderrOriginalBytes, 0);
    });
});

describe('spawnSyncWithTimeout', () => {
    for (const stream of ['stdout', 'stderr']) {
        it(`does not report ${stream} buffer overflow as a timeout`, () => {
            const result = spawnSyncWithTimeout(process.execPath, ['-e', `process.${stream}.write('x'.repeat(2 * 1024 * 1024))`], {
                encoding: 'utf8', stdio: 'pipe', timeoutMs: 5000, maxBuffer: 512
            });
            assert.equal((result.error as NodeJS.ErrnoException)?.code, 'ENOBUFS');
            assert.notEqual(result.status, 0);
            assert.equal(result.timedOut, false);
        });
    }

    it('does not report a spawn failure as a timeout', () => {
        const result = spawnSyncWithTimeout(path.join(os.tmpdir(), 'garda-nonexistent-executable'), [], { timeoutMs: 5000 });
        assert.equal((result.error as NodeJS.ErrnoException)?.code, 'ENOENT');
        assert.equal(result.timedOut, false);
    });

    it('runs a process successfully', () => {
        const result = spawnSyncWithTimeout(process.execPath, ['-e', 'console.log("ok")'], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeoutMs: 5000
        });
        assert.equal(result.status, 0);
        assert.match(result.stdout, /ok/);
        assert.equal(result.timedOut, false);
    });

    it('sets timedOut flag when process exceeds timeout', () => {
        const result = spawnSyncWithTimeout(process.execPath, ['-e', 'const s=Date.now();while(Date.now()-s<10000){}'], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeoutMs: 500
        });
        assert.equal(result.timedOut, true);
    });

    it('passes through windowsHide by default', () => {
        const result = spawnSyncWithTimeout(process.execPath, ['-e', 'process.exit(0)'], {
            encoding: 'utf8',
            stdio: 'pipe'
        });
        assert.equal(result.status, 0);
    });
});

describe('spawnStreamed – kill-path cleanup', () => {
    it('terminates a process tree on timeout', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-spawn-tree-timeout-'));
        const childPidPath = path.join(tempDir, 'child.pid');
        const script = [
            "import * as cp from 'child_process';",
            "import * as fs from 'fs';",
            `const child = cp.spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {stdio:"ignore"});`,
            `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
            'setTimeout(()=>{},60000);'
        ].join('\n');

        try {
            const t0 = Date.now();
            const result = await spawnStreamed(process.execPath, ['-e', script], {
                timeoutMs: 1000
            });
            const elapsed = Date.now() - t0;

            assert.equal(result.timedOut, true);
            assert.notEqual(result.exitCode, 0);
            assert.ok(elapsed < 15000, `Expected resolution near timeout, took ${elapsed}ms`);
            const childPid = Number(fs.readFileSync(childPidPath, 'utf8'));
            assert.ok(Number.isInteger(childPid) && childPid > 0);
            assert.equal(await waitForProcessExit(childPid), true, `Expected child process ${childPid} to be terminated`);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('uses the trusted identity-bound Windows tree terminator and fails closed without a root handle', async () => {
        if (process.platform !== 'win32') return;
        const mutableChildProcess = require('node:child_process') as typeof childProcess;
        const originalSpawn = mutableChildProcess.spawn;
        const originalExecFile = mutableChildProcess.execFile;
        const originalSystemRoot = process.env.SystemRoot;
        const originalWindir = process.env.WINDIR;
        const subprocessModulePath = require.resolve('../../../src/core/subprocess');
        const cachedSubprocessModule = require.cache[subprocessModulePath];
        const commands: string[] = [];
        const helperScripts: string[] = [];
        const fakeChild = new EventEmitter() as childProcess.ChildProcess;
        Object.defineProperties(fakeChild, {
            pid: { value: 2_147_483_647 },
            exitCode: { value: 0, configurable: true },
            signalCode: { value: null, configurable: true },
            stdout: { value: null },
            stderr: { value: null }
        });
        fakeChild.kill = function (): boolean {
            queueMicrotask(() => fakeChild.emit('close', 1, 'SIGKILL'));
            return true;
        };

        try {
            process.env.SystemRoot = path.join(os.tmpdir(), 'attacker-system-root');
            process.env.WINDIR = path.join(os.tmpdir(), 'attacker-windir');
            delete require.cache[subprocessModulePath];
            const freshSubprocess = require('../../../src/core/subprocess') as typeof import('../../../src/core/subprocess');
            (mutableChildProcess as any).spawn = function () {
                return fakeChild;
            };
            (mutableChildProcess as any).execFile = function (...invocation: any[]) {
                const command = String(invocation[0]);
                const commandArgs = invocation[1] as string[];
                const callback = invocation[3] as (error: Error | null, stdout: string, stderr: string) => void;
                commands.push(command);
                helperScripts.push(Buffer.from(commandArgs.at(-1)!, 'base64').toString('utf16le'));
                queueMicrotask(() => {
                    callback(null, '1\n', '');
                    fakeChild.emit('close', 1, 'SIGKILL');
                });
                return fakeChild;
            };

            const result = await freshSubprocess.spawnStreamed('mock-command', [], { timeoutMs: 10 });
            assert.equal(result.timedOut, true);
            assert.equal(commands.length, 1);
            const trustedSystemRoot = fs.realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot');
            assert.equal(
                commands[0].toLowerCase(),
                path.join(trustedSystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').toLowerCase()
            );
            assert.match(helperScripts[0], /GetSystemTimePreciseAsFileTime/);
            assert.match(helperScripts[0], /processSnapshot\.ExistingBeforeFileTime/);
            assert.match(helperScripts[0], /if \(rootHandle == IntPtr\.Zero\) continue;/);
            assert.match(helperScripts[0], /GARDA_PROCESS_TREE_TARGETS/);
        } finally {
            (mutableChildProcess as any).spawn = originalSpawn;
            (mutableChildProcess as any).execFile = originalExecFile;
            if (originalSystemRoot === undefined) delete process.env.SystemRoot;
            else process.env.SystemRoot = originalSystemRoot;
            if (originalWindir === undefined) delete process.env.WINDIR;
            else process.env.WINDIR = originalWindir;
            delete require.cache[subprocessModulePath];
            if (cachedSubprocessModule) require.cache[subprocessModulePath] = cachedSubprocessModule;
        }
    });

    it('does not terminate a different Windows process outside the managed creation window', async () => {
        if (process.platform !== 'win32') return;
        const victim = childProcess.spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
        assert.ok(victim.pid);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const mutableChildProcess = require('node:child_process') as typeof childProcess;
        const originalSpawn = mutableChildProcess.spawn;
        const originalExecFile = mutableChildProcess.execFile;
        const fakeChild = new EventEmitter() as childProcess.ChildProcess;
        let pidOnlyKillCalls = 0;
        let pending: ReturnType<typeof spawnStreamed> | null = null;
        let resolveHelperCompletion = function (_result: { error: Error | null; stdout: string }): void {};
        const helperCompletion = new Promise<{ error: Error | null; stdout: string }>(function (resolve) {
            resolveHelperCompletion = resolve;
        });
        Object.defineProperties(fakeChild, {
            pid: { value: victim.pid },
            exitCode: { value: null, configurable: true },
            signalCode: { value: null, configurable: true },
            stdout: { value: null },
            stderr: { value: null }
        });
        fakeChild.kill = function (signal?: NodeJS.Signals | number): boolean {
            pidOnlyKillCalls += 1;
            return victim.kill(signal);
        };

        try {
            (mutableChildProcess as any).spawn = function () { return fakeChild; };
            (mutableChildProcess as any).execFile = function (...invocation: any[]) {
                const callback = invocation[3] as (error: Error | null, stdout: string, stderr: string) => void;
                invocation[3] = function (error: Error | null, stdout: string, stderr: string) {
                    callback(error, stdout, stderr);
                    resolveHelperCompletion({ error, stdout });
                };
                return (originalExecFile as any)(...invocation);
            };
            pending = spawnStreamed('mock-command', [], { timeoutMs: 10 });
            const helperResult = await helperCompletion;
            assert.equal(helperResult.error, null, 'the executable identity check did not complete');
            assert.equal(helperResult.stdout.trim(), '0', 'the stale PID passed its creation-window check');
            assert.equal(pidOnlyKillCalls, 0, 'identity rejection fell back to PID-only ChildProcess.kill');
            assert.equal(isProcessAlive(victim.pid!), true, 'identity mismatch terminated an unrelated process');
            fakeChild.emit('close', 1, 'SIGKILL');
            const result = await pending;
            assert.equal(result.timedOut, true);
        } finally {
            fakeChild.emit('close', 1, 'SIGKILL');
            if (pending) await pending.catch(() => undefined);
            (mutableChildProcess as any).spawn = originalSpawn;
            (mutableChildProcess as any).execFile = originalExecFile;
            if (victim.pid && isProcessAlive(victim.pid)) {
                try { victim.kill('SIGKILL'); } catch { /* Already exited. */ }
            }
        }
    });

    it('kills a process that traps SIGTERM', async () => {
        // Process installs a SIGTERM handler so a PID-only graceful signal would
        // not terminate it. The identity-bound platform tree terminator force-kills it.
        const script = 'process.on("SIGTERM",()=>{});setTimeout(()=>{},60000)';
        const result = await spawnStreamed(process.execPath, ['-e', script], {
            timeoutMs: 800
        });
        assert.equal(result.timedOut, true);
        assert.notEqual(result.exitCode, 0);
    });

    it('kill-path via AbortController without timeout', async () => {
        const ac = new AbortController();
        const t0 = Date.now();
        const promise = spawnStreamed(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
            signal: ac.signal,
            timeoutMs: 0
        });
        setTimeout(() => ac.abort(), 300);
        const result = await promise;
        const elapsed = Date.now() - t0;

        assert.equal(result.cancelled, true);
        assert.equal(result.timedOut, false);
        assert.ok(elapsed < 15000, `Expected prompt cancellation, took ${elapsed}ms`);
    });
});

describe('timeout constants', () => {
    it('exports expected default timeout constants', () => {
        assert.equal(typeof DEFAULT_GIT_TIMEOUT_MS, 'number');
        assert.equal(typeof DEFAULT_GIT_CLONE_TIMEOUT_MS, 'number');
        assert.equal(typeof DEFAULT_NPM_TIMEOUT_MS, 'number');
        assert.equal(typeof DEFAULT_COMPILE_TIMEOUT_MS, 'number');
        assert.ok(DEFAULT_GIT_TIMEOUT_MS > 0);
        assert.ok(DEFAULT_COMPILE_TIMEOUT_MS >= DEFAULT_GIT_TIMEOUT_MS);
    });
});

describe('shutdown cleanup concurrency', () => {
    it('prevents a 128-item cleanup load from exceeding four workers or half the shutdown deadline', async () => {
        const itemCount = 128;
        const simulatedCleanupLatencyMs = 5;
        const expectedWaves = Math.ceil(itemCount / SHUTDOWN_CLEANUP_CONCURRENCY);
        let active = 0;
        let peakActive = 0;
        let completed = 0;
        const startedAt = Date.now();

        await settleWithShutdownConcurrency(
            Array.from({ length: itemCount }, (_value, index) => index),
            async function () {
                active += 1;
                peakActive = Math.max(peakActive, active);
                await new Promise((resolve) => setTimeout(resolve, simulatedCleanupLatencyMs));
                active -= 1;
                completed += 1;
            }
        );

        const elapsedMs = Date.now() - startedAt;
        assert.equal(completed, itemCount);
        assert.equal(peakActive, SHUTDOWN_CLEANUP_CONCURRENCY);
        assert.ok(
            elapsedMs >= (expectedWaves - 1) * simulatedCleanupLatencyMs,
            `cleanup queue did not execute in bounded waves: ${elapsedMs}ms`
        );
        assert.ok(
            elapsedMs < SUBPROCESS_TERMINATION_TIMEOUT_MS / 2,
            `128-item cleanup load exceeded half the shutdown deadline: ${elapsedMs}ms`
        );
    });

    it('prevents slow Windows closes from leaving queued child trees unsubmitted', async () => {
        if (process.platform !== 'win32') return;
        const mutableChildProcess = require('node:child_process') as typeof childProcess;
        const originalSpawn = mutableChildProcess.spawn;
        const originalExecFile = mutableChildProcess.execFile;
        const baselineSignalListeners = process.listeners('SIGTERM');
        const fakeChildren: childProcess.ChildProcess[] = [];
        const pendingResults: Array<Promise<unknown>> = [];
        let cleanup: Promise<void> | null = null;
        let helperCalls = 0;
        let helperTargets = '';
        const helperState: {
            settled: boolean;
            callback: ((error: Error | null, stdout: string, stderr: string) => void) | null;
        } = { settled: false, callback: null };
        const dispose = registerSubprocessSignalHandler(function (_signal, childCleanup) {
            cleanup = childCleanup;
        });

        try {
            (mutableChildProcess as any).spawn = function () {
                const child = new EventEmitter() as childProcess.ChildProcess;
                Object.defineProperties(child, {
                    pid: { value: 2_100_000_000 + fakeChildren.length },
                    exitCode: { value: null, configurable: true },
                    signalCode: { value: null, configurable: true },
                    stdout: { value: null },
                    stderr: { value: null }
                });
                fakeChildren.push(child);
                return child;
            };
            (mutableChildProcess as any).execFile = function (...invocation: any[]) {
                helperCalls += 1;
                const options = invocation[2] as { env?: NodeJS.ProcessEnv };
                helperTargets = options.env?.GARDA_PROCESS_TREE_TARGETS ?? '';
                helperState.callback = invocation[3];
                return new EventEmitter();
            };

            for (let index = 0; index < SHUTDOWN_CLEANUP_CONCURRENCY * 3; index += 1) {
                pendingResults.push(spawnStreamed('mock-command', [], { timeoutMs: 30_000 }));
            }
            const signalHandler = process.listeners('SIGTERM').find(
                (listener) => !baselineSignalListeners.includes(listener)
            );
            assert.ok(signalHandler, 'coordinator signal listener should be installed');

            signalHandler('SIGTERM');
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(helperCalls, 1, 'managed Windows trees were not submitted in one bounded helper launch');
            assert.equal(
                helperTargets.split(';').filter(Boolean).length,
                fakeChildren.length,
                'the batch helper did not receive every active child identity'
            );
            assert.ok(cleanup, 'coordinator should expose bounded child cleanup');

            helperState.settled = true;
            helperState.callback!(null, `${fakeChildren.length}\n`, '');
            for (const child of fakeChildren) child.emit('close', 1, 'SIGKILL');
            await cleanup;
            await Promise.all(pendingResults);
        } finally {
            if (!helperState.settled && helperState.callback) {
                helperState.settled = true;
                helperState.callback(null, '0\n', '');
            }
            for (const child of fakeChildren) child.emit('close', 1, 'SIGKILL');
            await Promise.allSettled(pendingResults);
            dispose();
            (mutableChildProcess as any).spawn = originalSpawn;
            (mutableChildProcess as any).execFile = originalExecFile;
        }
    });

    it('prevents a root-close race from dropping an admitted Windows process-tree cleanup', async () => {
        if (process.platform !== 'win32') return;
        const mutableChildProcess = require('node:child_process') as typeof childProcess;
        const originalSpawn = mutableChildProcess.spawn;
        const originalExecFile = mutableChildProcess.execFile;
        const baselineSignalListeners = process.listeners('SIGTERM');
        const fakeChild = new EventEmitter() as childProcess.ChildProcess;
        const managedPid = 2_075_000_000;
        let cleanup: Promise<void> | null = null;
        let helperTargets = '';
        const helperState: {
            callback: ((error: Error | null, stdout: string, stderr: string) => void) | null;
        } = { callback: null };
        let pending: ReturnType<typeof spawnStreamed> | null = null;
        const dispose = registerSubprocessSignalHandler(function (_signal, childCleanup) {
            cleanup = childCleanup;
        });
        Object.defineProperties(fakeChild, {
            pid: { value: managedPid },
            exitCode: { value: null, configurable: true },
            signalCode: { value: null, configurable: true },
            stdout: { value: null },
            stderr: { value: null }
        });

        try {
            (mutableChildProcess as any).spawn = function () { return fakeChild; };
            (mutableChildProcess as any).execFile = function (...invocation: any[]) {
                const options = invocation[2] as { env?: NodeJS.ProcessEnv };
                helperTargets = options.env?.GARDA_PROCESS_TREE_TARGETS ?? '';
                helperState.callback = invocation[3];
                return new EventEmitter();
            };

            pending = spawnStreamed('mock-command', [], { timeoutMs: 30_000 });
            const signalHandler = process.listeners('SIGTERM').find(
                (listener) => !baselineSignalListeners.includes(listener)
            );
            assert.ok(signalHandler, 'coordinator signal listener should be installed');

            signalHandler('SIGTERM');
            fakeChild.emit('close', 0, null);
            await new Promise((resolve) => setImmediate(resolve));

            assert.equal(
                helperTargets.split(';')[0]?.split(',')[0],
                String(managedPid),
                'the deferred drain dropped a root that closed after force termination was admitted'
            );
            assert.ok(helperState.callback, 'the identity-bound helper should receive the admitted root');
            helperState.callback(null, '0\n', '');
            helperState.callback = null;
            assert.ok(cleanup, 'coordinator should expose child cleanup');
            await cleanup;
            await pending;
        } finally {
            if (helperState.callback) helperState.callback(null, '0\n', '');
            fakeChild.emit('close', 0, null);
            if (pending) await pending.catch(() => undefined);
            dispose();
            (mutableChildProcess as any).spawn = originalSpawn;
            (mutableChildProcess as any).execFile = originalExecFile;
        }
    });

    it('prevents simultaneous Windows child timeouts from launching one helper per child', async () => {
        if (process.platform !== 'win32') return;
        const mutableChildProcess = require('node:child_process') as typeof childProcess;
        const originalSpawn = mutableChildProcess.spawn;
        const originalExecFile = mutableChildProcess.execFile;
        const fakeChildren: childProcess.ChildProcess[] = [];
        const pendingResults: Array<Promise<unknown>> = [];
        const helperCallbacks: Array<(error: Error | null, stdout: string, stderr: string) => void> = [];
        const helperTargetCounts: number[] = [];

        try {
            (mutableChildProcess as any).spawn = function () {
                const child = new EventEmitter() as childProcess.ChildProcess;
                Object.defineProperties(child, {
                    pid: { value: 2_050_000_000 + fakeChildren.length },
                    exitCode: { value: null, configurable: true },
                    signalCode: { value: null, configurable: true },
                    stdout: { value: null },
                    stderr: { value: null }
                });
                fakeChildren.push(child);
                return child;
            };
            (mutableChildProcess as any).execFile = function (...invocation: any[]) {
                const options = invocation[2] as { env?: NodeJS.ProcessEnv };
                helperTargetCounts.push(
                    (options.env?.GARDA_PROCESS_TREE_TARGETS ?? '').split(';').filter(Boolean).length
                );
                helperCallbacks.push(invocation[3]);
                return new EventEmitter();
            };

            for (let index = 0; index < SHUTDOWN_CLEANUP_CONCURRENCY * 3; index += 1) {
                pendingResults.push(spawnStreamed('mock-command', [], { timeoutMs: 10 }));
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert.deepEqual(
                helperTargetCounts,
                [fakeChildren.length],
                'simultaneous child timeouts were not coalesced into one bounded helper launch'
            );

            helperCallbacks.shift()!(null, `${fakeChildren.length}\n`, '');
            for (const child of fakeChildren) child.emit('close', 1, 'SIGKILL');
            await Promise.all(pendingResults);
        } finally {
            for (const callback of helperCallbacks) callback(null, '0\n', '');
            for (const child of fakeChildren) child.emit('close', 1, 'SIGKILL');
            await Promise.allSettled(pendingResults);
            (mutableChildProcess as any).spawn = originalSpawn;
            (mutableChildProcess as any).execFile = originalExecFile;
        }
    });

    it('prevents an oversized Windows target registry from exceeding helper environment limits', async () => {
        if (process.platform !== 'win32') return;
        const mutableChildProcess = require('node:child_process') as typeof childProcess;
        const originalSpawn = mutableChildProcess.spawn;
        const originalExecFile = mutableChildProcess.execFile;
        const baselineSignalListeners = process.listeners('SIGTERM');
        const inheritedProbeName = 'GARDA_OVERSIZED_PARENT_ENVIRONMENT';
        const originalInheritedProbe = process.env[inheritedProbeName];
        const childCount = 512;
        const fakeChildren: childProcess.ChildProcess[] = [];
        const pendingResults: Array<Promise<unknown>> = [];
        const helperEnvironments: NodeJS.ProcessEnv[] = [];
        let cleanup: Promise<void> | null = null;
        const dispose = registerSubprocessSignalHandler(function (_signal, childCleanup) {
            cleanup = childCleanup;
        });

        try {
            process.env[inheritedProbeName] = 'x'.repeat(20_000);
            (mutableChildProcess as any).spawn = function () {
                const child = new EventEmitter() as childProcess.ChildProcess;
                Object.defineProperties(child, {
                    pid: { value: 1_900_000_000 + fakeChildren.length },
                    exitCode: { value: null, configurable: true },
                    signalCode: { value: null, configurable: true },
                    stdout: { value: null },
                    stderr: { value: null }
                });
                fakeChildren.push(child);
                return child;
            };
            (mutableChildProcess as any).execFile = function (...invocation: any[]) {
                const options = invocation[2] as { env?: NodeJS.ProcessEnv };
                helperEnvironments.push(options.env ?? {});
                const callback = invocation[3] as (error: Error | null, stdout: string, stderr: string) => void;
                queueMicrotask(() => callback(null, '0\n', ''));
                return new EventEmitter();
            };

            for (let index = 0; index < childCount; index += 1) {
                pendingResults.push(spawnStreamed('mock-command', [], { timeoutMs: 30_000 }));
            }
            const signalHandler = process.listeners('SIGTERM').find(
                (listener) => !baselineSignalListeners.includes(listener)
            );
            assert.ok(signalHandler, 'coordinator signal listener should be installed');

            signalHandler('SIGTERM');
            await new Promise((resolve) => setImmediate(resolve));

            assert.ok(helperEnvironments.length > 1, 'oversized target registry was not chunked');
            assert.equal(
                helperEnvironments.reduce(function (count, environment) {
                    return count + (environment.GARDA_PROCESS_TREE_TARGETS ?? '').split(';').filter(Boolean).length;
                }, 0),
                childCount,
                'chunked helper launches did not receive every admitted child identity'
            );
            for (const environment of helperEnvironments) {
                assert.ok(
                    (environment.GARDA_PROCESS_TREE_TARGETS ?? '').length
                        <= WINDOWS_PROCESS_TREE_TARGET_BATCH_MAX_CHARS,
                    'a helper target payload exceeded its environment budget'
                );
                assert.equal(
                    Object.hasOwn(environment, inheritedProbeName),
                    false,
                    'the helper inherited an unrelated oversized parent environment value'
                );
            }

            for (const child of fakeChildren) child.emit('close', 1, 'SIGKILL');
            assert.ok(cleanup, 'coordinator should expose bounded child cleanup');
            await cleanup;
            await Promise.all(pendingResults);
        } finally {
            for (const child of fakeChildren) child.emit('close', 1, 'SIGKILL');
            await Promise.allSettled(pendingResults);
            if (originalInheritedProbe === undefined) delete process.env[inheritedProbeName];
            else process.env[inheritedProbeName] = originalInheritedProbe;
            dispose();
            (mutableChildProcess as any).spawn = originalSpawn;
            (mutableChildProcess as any).execFile = originalExecFile;
        }
    });

    it('prevents unbounded synchronous Windows exit cleanup across a larger registry', async () => {
        if (process.platform !== 'win32') return;
        const mutableChildProcess = require('node:child_process') as typeof childProcess;
        const originalSpawn = mutableChildProcess.spawn;
        const originalExecFileSync = mutableChildProcess.execFileSync;
        const baselineExitListeners = process.listeners('exit');
        const fakeChildren: childProcess.ChildProcess[] = [];
        let syncCalls = 0;

        try {
            (mutableChildProcess as any).spawn = function () {
                const child = new EventEmitter() as childProcess.ChildProcess;
                Object.defineProperties(child, {
                    pid: { value: 2_000_000_000 + fakeChildren.length },
                    exitCode: { value: null, configurable: true },
                    signalCode: { value: null, configurable: true },
                    stdout: { value: null },
                    stderr: { value: null }
                });
                child.kill = function (): boolean { return true; };
                fakeChildren.push(child);
                return child;
            };
            (mutableChildProcess as any).execFileSync = function (...invocation: any[]) {
                syncCalls += 1;
                const options = invocation[2] as { timeout?: number };
                const waitMs = Math.min(800, options.timeout ?? 0);
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
                return '0\n';
            };

            const pending = Array.from({ length: 8 }, () => spawnStreamed('mock-command', []));
            const exitHandler = process.listeners('exit').find((listener) => !baselineExitListeners.includes(listener));
            assert.ok(exitHandler, 'managed registry should install one exit listener');
            const startedAt = Date.now();
            exitHandler(0);
            const elapsedMs = Date.now() - startedAt;

            assert.equal(syncCalls, 1, 'exit cleanup did not batch the active child registry');
            assert.ok(
                elapsedMs <= WINDOWS_EXIT_CLEANUP_BUDGET_MS + 250,
                `exit cleanup exceeded its total budget: ${elapsedMs}ms`
            );

            for (const child of fakeChildren) child.emit('close', 1, 'SIGKILL');
            await Promise.all(pending);
        } finally {
            (mutableChildProcess as any).spawn = originalSpawn;
            (mutableChildProcess as any).execFileSync = originalExecFileSync;
            for (const child of fakeChildren) child.emit('close', 1, 'SIGKILL');
        }
    });
});

describe('shell-surface hardening', () => {
    it('buildWindowsBatchCommandLine quotes absolute batch paths and literal args', () => {
        const commandLine = buildWindowsBatchCommandLine('C:\\Program Files\\Tools\\npm.cmd', ['run', 'build script']);
        assert.equal(commandLine, 'call "C:\\Program Files\\Tools\\npm.cmd" run "build script"');
    });

    it('buildWindowsBatchCommandLine rejects unsafe cmd.exe expansion literals', () => {
        assert.throws(
            () => buildWindowsBatchCommandLine('C:\\Tools\\npm.cmd', ['%PATH%']),
            /cmd\.exe expansion, delayed expansion, quote, or control characters/
        );
        assert.throws(
            () => buildWindowsBatchCommandLine('C:\\Tools\\npm.cmd', ['bang!']),
            /without a proven escaping strategy/
        );
        assert.throws(
            () => buildWindowsBatchCommandLine('C:\\Tools\\npm.cmd', ['safe" & echo INJECTED']),
            /percent signs, exclamation marks, quotes, CR, or LF/
        );
    });

    it('buildWindowsBatchCommandLine rejects non-batch executables', () => {
        assert.throws(
            () => buildWindowsBatchCommandLine('C:\\Tools\\node.exe', ['-v']),
            /restricted to Windows \.cmd\/\.bat execution/
        );
    });

    it('spawnStreamed ignores shell property even if force-cast at runtime', async () => {
        // Prove that even if a caller bypasses TypeScript and sneaks in shell: true,
        // spawnStreamed does NOT pass it to child_process.spawn.
        const runtimeOpts = { timeoutMs: 5000, shell: true } as any;
        const result = await spawnStreamed(process.execPath, ['-e', 'console.log("safe")'], runtimeOpts);
        assert.equal(result.exitCode, 0);
        assert.match(result.stdout, /safe/);
    });

    it('spawnStreamed does not execute via shell even with crafted arguments', async () => {
        // A command-injection payload that would succeed under shell mode should
        // simply appear as a literal argument in non-shell mode.
        const maliciousArg = '&& echo INJECTED';
        const result = await spawnStreamed(
            process.execPath,
            ['-e', `process.stdout.write(process.argv[1])`, '--', maliciousArg],
            { timeoutMs: 5000 }
        );
        assert.equal(result.exitCode, 0);
        // The argument must arrive as-is, not interpreted by a shell
        assert.ok(result.stdout.includes('&& echo INJECTED'));
        assert.ok(!result.stdout.includes('INJECTED\n'));
    });

    it('spawnShellCommand rejects on non-Windows platforms', async () => {
        if (process.platform === 'win32') {
            const fixture = createNodeBatchFixture('console.log("shelltest")');
            try {
                const result = await spawnShellCommand(fixture.scriptPath, [], { timeoutMs: 5000 });
                assert.equal(result.exitCode, 0);
                assert.match(result.stdout, /shelltest/);
            } finally {
                fixture.cleanup();
            }
        } else {
            await assert.rejects(
                () => spawnShellCommand('C:\\temp\\echo.cmd', [], { timeoutMs: 5000 }),
                (err) => (err as Error).message.includes('restricted to Windows')
            );
        }
    });

    it('spawnShellCommand rejects relative batch paths on Windows', () => {
        if (process.platform !== 'win32') return;
        assert.throws(
            () => spawnShellCommand('relative-script.cmd', [], { timeoutMs: 5000 }),
            /absolute executable path/
        );
    });

    it('spawnShellCommand supports timeout', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createNodeBatchFixture('setTimeout(()=>{},60000)');
        try {
            const result = await spawnShellCommand(fixture.scriptPath, [], { timeoutMs: 500 });
            assert.equal(result.timedOut, true);
            assert.notEqual(result.exitCode, 0);
        } finally {
            fixture.cleanup();
        }
    });

    it('registers Windows shell and streamed children with the same signal coordinator', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createNodeBatchFixture('setTimeout(()=>{},60000)');
        const baselineListeners = process.listeners('SIGTERM');
        let cleanup: Promise<void> | null = null;
        const dispose = registerSubprocessSignalHandler(function (_signal, childCleanup) {
            cleanup = childCleanup;
        });
        const handler = process.listeners('SIGTERM').find((listener) => !baselineListeners.includes(listener));
        assert.ok(handler, 'coordinator signal listener should be installed');

        try {
            const streamed = spawnStreamed(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
                timeoutMs: 30_000
            });
            const shell = spawnShellCommand(fixture.scriptPath, [], { timeoutMs: 30_000 });
            assert.equal(process.listenerCount('SIGTERM'), baselineListeners.length + 1);

            handler('SIGTERM');
            await Promise.all([streamed, shell]);
            assert.ok(cleanup, 'coordinator should expose bounded child cleanup');
            await cleanup;
        } finally {
            dispose();
            fixture.cleanup();
        }

        assert.equal(process.listenerCount('SIGTERM'), baselineListeners.length);
    });

    it('spawnShellCommand rejects an adversarial PATH taskkill replacement and terminates inherited-pipe descendants', async () => {
        if (process.platform !== 'win32') return;
        const fakeToolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fake-taskkill-'));
        const fakeTaskkillPath = path.join(fakeToolRoot, 'taskkill.exe');
        fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), fakeTaskkillPath);
        const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
        const originalPath = process.env[pathKey];
        const fixture = createNodeBatchFixture([
            "const cp = require('node:child_process');",
            "const fs = require('node:fs');",
            "const descendant = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'inherit' });",
            "fs.writeFileSync(require('node:path').join(__dirname, 'descendant.pid'), String(descendant.pid));",
            'setTimeout(()=>{},60000);'
        ].join('\n'));
        let descendantPid: number | null = null;
        try {
            process.env[pathKey] = `${fakeToolRoot}${path.delimiter}${originalPath || ''}`;
            try {
                const startedAt = Date.now();
                const descendantPidPath = path.join(path.dirname(fixture.scriptPath), 'descendant.pid');
                const pending = spawnShellCommand(fixture.scriptPath, [], { timeoutMs: 3_000 });
                try {
                    assert.equal(await waitForFile(descendantPidPath, 2_000), true, 'descendant PID was not recorded');
                    descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
                    const result = await pending;
                    const elapsed = Date.now() - startedAt;
                    assert.equal(result.timedOut, true);
                    assert.ok(elapsed < 8_000, `Expected prompt process-tree cleanup, took ${elapsed}ms`);
                    assert.equal(await waitForProcessExit(descendantPid), true);
                } finally {
                    await pending.catch(() => undefined);
                }
            } finally {
                if (originalPath === undefined) delete process.env[pathKey];
                else process.env[pathKey] = originalPath;
            }
        } finally {
            if (descendantPid !== null && isProcessAlive(descendantPid)) {
                try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already exited. */ }
            }
            fixture.cleanup();
            fs.rmSync(fakeToolRoot, { recursive: true, force: true });
        }
    });

    it('terminates Windows descendant trees when the managed parent exits outside the signal path', async () => {
        if (process.platform !== 'win32') return;
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-parent-exit-'));
        const descendantPidPath = path.join(tempRoot, 'descendant.pid');
        const subprocessModulePath = require.resolve('../../../src/core/subprocess');
        const managedChildScript = [
            "const cp = require('node:child_process');",
            "const fs = require('node:fs');",
            "const descendant = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });",
            `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
            'setTimeout(()=>{},60000);'
        ].join('\n');
        const harnessScript = [
            `const { spawnStreamed } = require(${JSON.stringify(subprocessModulePath)});`,
            "const fs = require('node:fs');",
            `const descendantPidPath = ${JSON.stringify(descendantPidPath)};`,
            `void spawnStreamed(process.execPath, ['-e', ${JSON.stringify(managedChildScript)}], { timeoutMs: 60000 });`,
            'const poll = setInterval(() => {',
            '  if (!fs.existsSync(descendantPidPath)) return;',
            '  clearInterval(poll);',
            '  process.exit(0);',
            '}, 25);'
        ].join('\n');
        const harness = childProcess.spawn(process.execPath, ['-e', harnessScript], { stdio: 'ignore' });
        let descendantPid: number | null = null;

        try {
            const harnessExit = new Promise<number | null>((resolve, reject) => {
                harness.once('error', reject);
                harness.once('exit', resolve);
            });
            const exitCode = await Promise.race([
                harnessExit,
                new Promise<never>((_resolve, reject) => {
                    setTimeout(() => reject(new Error('parent-exit harness timed out')), 10_000).unref?.();
                })
            ]);
            assert.equal(exitCode, 0);
            assert.equal(await waitForFile(descendantPidPath), true, 'descendant PID was not recorded');
            descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
            assert.equal(await waitForProcessExit(descendantPid), true, 'descendant survived managed parent exit');
        } finally {
            if (harness.pid && isProcessAlive(harness.pid)) {
                try { harness.kill('SIGKILL'); } catch { /* Already exited. */ }
            }
            if (descendantPid !== null && isProcessAlive(descendantPid)) {
                try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already exited. */ }
            }
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('does not re-enter synchronous Windows cleanup after the bounded signal deadline', async () => {
        if (process.platform !== 'win32') return;
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-signal-bound-'));
        const childPidPath = path.join(tempRoot, 'child.pid');
        const syncCleanupMarkerPath = path.join(tempRoot, 'sync-cleanup.marker');
        const subprocessModulePath = require.resolve('../../../src/core/subprocess');
        const harnessScript = [
            "const cp = require('node:child_process');",
            "const fs = require('node:fs');",
            `const childPidPath = ${JSON.stringify(childPidPath)};`,
            `const syncCleanupMarkerPath = ${JSON.stringify(syncCleanupMarkerPath)};`,
            'cp.execFile = function () { return {}; };',
            'cp.execFileSync = function () { fs.writeFileSync(syncCleanupMarkerPath, "called"); return ""; };',
            `const subprocess = require(${JSON.stringify(subprocessModulePath)});`,
            'subprocess.registerSubprocessSignalHandler(function (signal, cleanup) {',
            '  void cleanup.then(function () { process.exit(subprocess.computeTerminationSignalExitCode(signal)); });',
            '});',
            'void subprocess.spawnStreamed(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {',
            '  timeoutMs: 60000,',
            '  onSpawn: function (child) { fs.writeFileSync(childPidPath, String(child.pid)); }',
            '});',
            'const poll = setInterval(function () {',
            '  if (!fs.existsSync(childPidPath)) return;',
            '  clearInterval(poll);',
            '  process.listeners("SIGTERM").at(-1)("SIGTERM");',
            '}, 25);'
        ].join('\n');
        const harness = childProcess.spawn(process.execPath, ['-e', harnessScript], { stdio: 'ignore' });
        let childPid: number | null = null;

        try {
            const startedAt = Date.now();
            const harnessExit = new Promise<number | null>((resolve, reject) => {
                harness.once('error', reject);
                harness.once('exit', resolve);
            });
            const exitCode = await Promise.race([
                harnessExit,
                new Promise<never>((_resolve, reject) => {
                    setTimeout(() => reject(new Error('bounded-signal harness timed out')), 12_000).unref?.();
                })
            ]);
            const elapsed = Date.now() - startedAt;
            assert.equal(exitCode, 143);
            assert.ok(elapsed < SUBPROCESS_TERMINATION_TIMEOUT_MS + 1_500, `signal exit exceeded bound: ${elapsed}ms`);
            assert.equal(fs.existsSync(syncCleanupMarkerPath), false, 'signal exit invoked synchronous cleanup');
            assert.equal(await waitForFile(childPidPath), true, 'managed child PID was not recorded');
            childPid = Number(fs.readFileSync(childPidPath, 'utf8'));
        } finally {
            if (harness.pid && isProcessAlive(harness.pid)) {
                try { harness.kill('SIGKILL'); } catch { /* Already exited. */ }
            }
            if (childPid !== null && isProcessAlive(childPid)) {
                try { process.kill(childPid, 'SIGKILL'); } catch { /* Already exited. */ }
            }
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('spawnShellCommand reports shell child process diagnostics without disrupting execution', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createNodeBatchFixture('console.log("shellspawn")');
        try {
            let observedPid: number | null = null;
            let observedShell = false;
            let observedCommand = '';
            const result = await spawnShellCommand(fixture.scriptPath, [], {
                timeoutMs: 5000,
                onSpawn(child) {
                    observedPid = child.pid;
                    observedShell = child.shell;
                    observedCommand = child.command;
                    throw new Error('observer failed');
                }
            });

            assert.equal(result.exitCode, 0);
            assert.match(result.stdout, /shellspawn/);
            assert.equal(typeof observedPid, 'number');
            assert.equal(observedShell, true);
            assert.match(observedCommand, /cmd(?:\.exe)?$/i);
        } finally {
            fixture.cleanup();
        }
    });

    it('spawnShellCommand supports AbortController cancellation', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createNodeBatchFixture('setTimeout(()=>{},60000)');
        try {
            const ac = new AbortController();
            const promise = spawnShellCommand(fixture.scriptPath, [], { signal: ac.signal, timeoutMs: 30000 });
            setTimeout(() => ac.abort(), 300);
            const result = await promise;
            assert.equal(result.cancelled, true);
        } finally {
            fixture.cleanup();
        }
    });

    it('spawnShellCommand exposes truncation flags under normal output', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createNodeBatchFixture('console.log("shelltrunctest")');
        try {
            const result = await spawnShellCommand(fixture.scriptPath, [], { timeoutMs: 5000 });
            assert.equal(result.exitCode, 0);
            assert.equal(result.stdoutTruncated, false);
            assert.equal(result.stderrTruncated, false);
            assert.equal(result.stderrOriginalBytes, 0);
        } finally {
            fixture.cleanup();
        }
    });

    it('spawnShellCommand sets stdoutTruncated when stdout exceeds maxBuffer', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createNodeBatchFixture("for(let i=0;i<20;i++) process.stdout.write('0123456789')");
        try {
            const result = await spawnShellCommand(fixture.scriptPath, [], { timeoutMs: 5000, maxBuffer: 64 });
            assert.equal(result.stdoutTruncated, true);
            assert.equal(result.stdoutOriginalBytes, 200);
            assert.match(result.stdout, /output truncated; omitted \d+ bytes/);
        } finally {
            fixture.cleanup();
        }
    });

    it('spawnShellCommand retains the buffered head and tail of an overflowing stdout chunk', async () => {
        if (process.platform !== 'win32') return;
        const payload = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(8);
        const fixture = createNodeBatchFixture(`process.stdout.write(${JSON.stringify(payload)})`);
        try {
            const result = await spawnShellCommand(fixture.scriptPath, [], { timeoutMs: 5000, maxBuffer: 64 });
            assert.equal(result.stdoutTruncated, true);
            assert.ok(result.stdout.startsWith('ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF'));
            assert.ok(result.stdout.endsWith('UVWXYZ'));
            assert.match(result.stdout, /output truncated; omitted \d+ bytes/);
        } finally {
            fixture.cleanup();
        }
    });

    it('spawnShellCommand retains valid UTF-8 stdout head and tail at multibyte boundaries', async () => {
        if (process.platform !== 'win32') return;
        const payload = '😀AB'.repeat(20);
        const fixture = createNodeBatchFixture(`process.stdout.write(${JSON.stringify(payload)})`);
        try {
            const result = await spawnShellCommand(fixture.scriptPath, [], {
                timeoutMs: 5000,
                capturePolicy: { mode: 'head-tail', maxBytes: 10, headBytes: 5, tailBytes: 5 }
            });
            assert.equal(result.stdoutTruncated, true);
            assert.ok(result.stdout.startsWith('😀A'));
            assert.ok(result.stdout.endsWith('AB'));
            assert.match(result.stdout, /output truncated; omitted \d+ bytes/);
        } finally {
            fixture.cleanup();
        }
    });

    it('spawnShellCommand sets stderrTruncated when stderr exceeds maxBuffer', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createNodeBatchFixture("for(let i=0;i<20;i++) process.stderr.write('0123456789')");
        try {
            const result = await spawnShellCommand(fixture.scriptPath, [], { timeoutMs: 5000, maxBuffer: 64 });
            assert.equal(result.stderrTruncated, true);
            assert.equal(result.stderrOriginalBytes, 200);
            assert.match(result.stderr, /output truncated; omitted \d+ bytes/);
        } finally {
            fixture.cleanup();
        }
    });

    it('spawnShellCommand retains valid UTF-8 stderr head and tail at multibyte boundaries', async () => {
        if (process.platform !== 'win32') return;
        const payload = '😀AB'.repeat(20);
        const fixture = createNodeBatchFixture(`process.stderr.write(${JSON.stringify(payload)})`);
        try {
            const result = await spawnShellCommand(fixture.scriptPath, [], {
                timeoutMs: 5000,
                capturePolicy: { mode: 'head-tail', maxBytes: 10, headBytes: 5, tailBytes: 5 }
            });
            assert.equal(result.stderrTruncated, true);
            assert.ok(result.stderr.startsWith('😀A'));
            assert.ok(result.stderr.endsWith('AB'));
            assert.match(result.stderr, /output truncated; omitted \d+ bytes/);
        } finally {
            fixture.cleanup();
        }
    });

    it('spawnShellCommand delivers stdout callbacks for all chunks even when buffer is truncated', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createNodeBatchFixture("for(let i=0;i<20;i++) process.stdout.write('0123456789')");
        try {
            const allChunks: string[] = [];
            const result = await spawnShellCommand(
                fixture.scriptPath,
                [],
                {
                    timeoutMs: 5000,
                    maxBuffer: 64,
                    onStdout(chunk) { allChunks.push(chunk); }
                }
            );
            assert.equal(result.stdoutTruncated, true);
            const callbackTotal = allChunks.join('').length;
            assert.ok(callbackTotal >= 200, `Expected >=200 chars via shell stdout callback, got ${callbackTotal}`);
        } finally {
            fixture.cleanup();
        }
    });

    it('spawnShellCommand delivers stderr callbacks for all chunks even when buffer is truncated', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createNodeBatchFixture("for(let i=0;i<20;i++) process.stderr.write('0123456789')");
        try {
            const allChunks: string[] = [];
            const result = await spawnShellCommand(
                fixture.scriptPath,
                [],
                {
                    timeoutMs: 5000,
                    maxBuffer: 64,
                    onStderr(chunk) { allChunks.push(chunk); }
                }
            );
            assert.equal(result.stderrTruncated, true);
            const callbackTotal = allChunks.join('').length;
            assert.ok(callbackTotal >= 200, `Expected >=200 chars via shell stderr callback, got ${callbackTotal}`);
        } finally {
            fixture.cleanup();
        }
    });

    it('spawnShellCommand reports truncated false for pre-aborted signal', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createNodeBatchFixture();
        try {
            const ac = new AbortController();
            ac.abort();
            const result = await spawnShellCommand(fixture.scriptPath, [], { signal: ac.signal });
            assert.equal(result.cancelled, true);
            assert.equal(result.stdoutTruncated, false);
            assert.equal(result.stderrTruncated, false);
            assert.equal(result.stdoutOriginalBytes, 0);
            assert.equal(result.stderrOriginalBytes, 0);
        } finally {
            fixture.cleanup();
        }
    });
});
