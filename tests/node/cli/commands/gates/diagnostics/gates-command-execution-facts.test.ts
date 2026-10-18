import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { executeCommandAsync } from '../../../../../../src/cli/gate-cli/gates-subprocess';

function command(source: string): string {
    const quote = (value: string) => '"' + value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"') + '"';
    return `${quote(process.execPath)} -e ${quote(source)}`;
}

it('retains the observed child close signal through the command and invocation records', async () => {
    const mutable = require('node:child_process') as typeof childProcess;
    const original = mutable.spawn;
    const observed: { child?: childProcess.ChildProcess; signal?: NodeJS.Signals | null } = {};
    mutable.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
        const child = original(...args);
        observed.child = child;
        child.stdout?.once('data', () => child.kill('SIGTERM'));
        child.once('close', (_code, signal) => { observed.signal = signal; });
        return child;
    }) as typeof original;
    try {
        const result = await executeCommandAsync(command('console.log("READY");setInterval(()=>{},1000)'),
            { captureInvocations: true, timeoutMs: 5000 });
        assert.equal(observed.signal, 'SIGTERM');
        assert.equal((result as { terminationSignal?: string }).terminationSignal, observed.signal);
        assert.equal((result.invocations?.[0] as { terminationSignal?: string }).terminationSignal, observed.signal);
        assert.equal(result.timedOut, false);
        assert.equal(result.cancelled, false);
    } finally {
        mutable.spawn = original;
        if (observed.child?.exitCode === null && observed.child.signalCode === null) observed.child.kill('SIGKILL');
    }
});

it('retains child output truncation even when a later command succeeds', async () => {
    const bytes = 20 * 1024 * 1024 + 127;
    const result = await executeCommandAsync(command(`process.stdout.write("x".repeat(${bytes}))`)
        + ' && ' + command('console.log("SECOND")'), { captureInvocations: true, timeoutMs: 20_000 });
    assert.equal(result.exitCode, 0);
    assert.equal((result as { outputTruncated?: boolean }).outputTruncated, true);
    assert.equal((result.invocations?.[0] as { stdoutTruncated?: boolean }).stdoutTruncated, true);
    assert.equal((result.invocations?.[0] as { stdoutOriginalBytes?: number }).stdoutOriginalBytes, bytes);
    assert.equal(result.invocations?.[1].exitCode, 0);
});
