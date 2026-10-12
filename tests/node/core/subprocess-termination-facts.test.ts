import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { spawnStreamed } from '../../../src/core/subprocess';

it('preserves ordinary zero and nonzero exits without inventing a signal', async () => {
    for (const code of [0, 7]) {
        const result = await spawnStreamed(process.execPath, ['-e', `process.exit(${code})`], { timeoutMs: 5000 });
        assert.equal(result.exitCode, code);
        assert.equal((result as { terminationSignal?: NodeJS.Signals }).terminationSignal, undefined);
        assert.equal(result.timedOut, false);
        assert.equal(result.cancelled, false);
    }
});

it('preserves the real child close signal without changing legacy exit classification', async () => {
    const mutableChildProcess = require('node:child_process') as typeof childProcess;
    const originalSpawn = mutableChildProcess.spawn;
    const observed = { child: null as childProcess.ChildProcess | null, signal: null as NodeJS.Signals | null, code: null as number | null };
    mutableChildProcess.spawn = ((command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
        const child = originalSpawn(command, args, options);
        observed.child = child;
        child.once('close', (code, signal) => { observed.code = code; observed.signal = signal; });
        return child;
    }) as typeof originalSpawn;
    try {
        const result = await spawnStreamed(process.execPath,
            ['-e', 'process.stdout.write("READY");setInterval(()=>{},1000)'], {
                timeoutMs: 5000,
                onStdout(chunk) { if (chunk.includes('READY')) assert.equal(observed.child!.kill('SIGTERM'), true); }
            });
        assert.equal(observed.signal, 'SIGTERM');
        assert.equal((result as { terminationSignal?: NodeJS.Signals }).terminationSignal, observed.signal);
        assert.equal(result.exitCode, observed.code ?? 1);
        assert.equal(result.timedOut, false);
        assert.equal(result.cancelled, false);
    } finally {
        mutableChildProcess.spawn = originalSpawn;
        if (observed.child?.exitCode === null && observed.child.signalCode === null) observed.child.kill('SIGKILL');
    }
});

it('preserves pre-launch cancellation without claiming an observed child signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await spawnStreamed(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal });
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 1);
    assert.equal((result as { terminationSignal?: NodeJS.Signals }).terminationSignal, undefined);
});
