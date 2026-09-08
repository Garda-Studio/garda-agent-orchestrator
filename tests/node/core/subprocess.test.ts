import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildWindowsBatchCommandLine,
    DEFAULT_COMPILE_TIMEOUT_MS,
    DEFAULT_GIT_CLONE_TIMEOUT_MS,
    DEFAULT_GIT_TIMEOUT_MS,
    DEFAULT_NPM_TIMEOUT_MS,
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

    it('kills process that traps SIGTERM (exercises taskkill /F on Windows)', async () => {
        // Process installs a SIGTERM handler so child.kill('SIGTERM') alone would
        // not terminate it. On Windows the taskkill /F flag force-kills regardless.
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

    it('spawnShellCommand terminates inherited-pipe descendants when taskkill is unavailable', async () => {
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
