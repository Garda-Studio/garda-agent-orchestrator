import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runRetainedProducer } from './fixtures/retained-producer-process';

function isDead(pid: number): boolean {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

test('preserves actual producer PID, Unicode output, cwd and environment', t => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'garda retained producer '));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const result = runRetainedProducer(t, 'console.log(JSON.stringify({pid:process.pid,cwd:process.cwd(),value:process.env.PRODUCER_VALUE}));console.error("unicode: café")', {
        cwd, env: { ...process.env, PRODUCER_VALUE: 'space and café' }
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.pid, result.pid);
    assert.equal(output.cwd, fs.realpathSync(cwd));
    assert.equal(output.value, 'space and café');
    assert.match(result.stderr, /unicode: café/u);
    assert.equal(isDead(result.pid), true);
});

test('preserves a genuine nonzero child exit without a success claim', t => {
    const result = runRetainedProducer(t, 'console.log("before failure");process.exit(17)');
    assert.equal(result.status, 17);
    assert.equal(result.stdout.trim(), 'before failure');
    assert.equal(result.error, undefined);
    assert.equal(isDead(result.pid), true);
});

test('preserves -e argument layout with quotes, spaces and long environment input', t => {
    const args = ['module path with spaces', JSON.stringify({ quoted: 'a"b', unicode: 'café' }), 'yes'];
    const result = runRetainedProducer(t, 'console.log(JSON.stringify(process.argv.slice(1)))', {
        args, env: { ...process.env, PRODUCER_LARGE_VALUE: 'x'.repeat(20000) }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
});

test('rejects an oversized genuine output without treating exit zero as success', t => {
    const result = runRetainedProducer(t, 'console.log("x".repeat(1000))', { maxBuffer: 128 });
    assert.equal(result.status, null);
    assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, 'ENOBUFS');
});

test('bounds a hanging child and returns timeout failure after actual termination', { timeout: 20000 }, t => {
    const result = runRetainedProducer(t, 'setInterval(()=>{},1000)', { timeout: 250 });
    assert.equal(result.status, null);
    assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT');
    assert.equal(isDead(result.pid), true);
});

test('retains exited Windows identity through real process churn and releases on cleanup', {
    skip: process.platform !== 'win32', timeout: 45000
}, async t => {
    let retention: { pid: number; directory: string; readonly exited: boolean } | undefined;
    await t.test('genuine exited producer remains dead while its native handle is retained', child => {
        const result = runRetainedProducer(child, 'console.log(process.pid)');
        assert.equal(result.status, 0, result.stderr);
        assert.equal(Number(result.stdout.trim()), result.pid);
        retention = result.retention;
        assert.ok(retention);
        assert.equal(isDead(retention.pid), false);
        for (let count = 0; count < 12; count++) {
            const churn = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 5000 });
            assert.equal(churn.status, 0);
            assert.notEqual(churn.pid, result.pid, 'Retained producer PID must not be assigned to a churn child');
            assert.equal(isDead(result.pid), true);
        }
    });
    assert.ok(retention);
    assert.equal(retention.exited, true);
    assert.equal(fs.existsSync(retention.directory), false);
});

test('rejects invalid child deadlines before starting a process', t => {
    assert.throws(() => runRetainedProducer(t, '', { timeout: 0 }), /timeout/u);
    assert.throws(() => runRetainedProducer(t, '', { timeout: Number.NaN }), /timeout/u);
});
