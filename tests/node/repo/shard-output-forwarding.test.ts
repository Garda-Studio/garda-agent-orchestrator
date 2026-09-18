import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';

import { ShardOutputForwarder } from '../../../scripts/node-foundation/shard-output-forwarding';
import type { BuildResult } from '../../../scripts/node-foundation/build';
import { isolateTestRunnerEnvironment } from '../process-environment-fixtures';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function controlledSink(highWaterMark = 1): {
    sink: Writable; chunks: Buffer[]; callbacks: Array<(error?: Error | null) => void>;
} {
    const chunks: Buffer[] = [];
    const callbacks: Array<(error?: Error | null) => void> = [];
    const sink = new Writable({ highWaterMark, write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk)); callbacks.push(callback);
    } });
    return { sink, chunks, callbacks };
}

function collectingSink(): { sink: Writable; chunks: Buffer[] } {
    const chunks: Buffer[] = [];
    return { chunks, sink: new Writable({ write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk)); callback();
    } }) };
}

async function drainUntilFlushed(output: ShardOutputForwarder, sinks: ReturnType<typeof controlledSink>[]): Promise<void> {
    let done = false;
    const flushed = output.flush().then(() => { done = true; });
    for (let index = 0; index < 1000 && !done; index += 1) {
        for (const sink of sinks) sink.callbacks.shift()?.();
        await tick();
    }
    assert.equal(done, true, 'forwarding must finish after every sink drains');
    await flushed;
    output.cancel();
    await tick();
}

for (const stalled of ['stdout', 'stderr', 'log'] as const) {
    test(`bounded forwarding preserves every byte with stalled ${stalled}`, async (context) => {
        const slow = controlledSink();
        const log = stalled === 'log' ? slow : collectingSink();
        const stdout = stalled === 'stdout' ? slow : collectingSink();
        const stderr = stalled === 'stderr' ? slow : collectingSink();
        const failures: Error[] = [];
        const output = new ShardOutputForwarder(log.sink, stdout.sink, stderr.sink, (error) => failures.push(error));
        context.after(() => output.cancel());
        const chunks = Array.from({ length: 100 }, (_, index) => Buffer.alloc(64, index));
        const source = Readable.from(chunks, { objectMode: false, highWaterMark: 16 });
        output.forward(source, stalled === 'stderr' ? stderr.sink : stdout.sink, () => {});
        await tick();
        for (let index = 0; index < 20; index += 1) output.diagnostic('heartbeat', null);
        await tick();
        assert.equal(source.isPaused(), true);
        assert.equal(slow.sink.writableLength, 64);
        assert.equal(slow.callbacks.length, 1);
        assert.ok(source.readableLength <= 64);
        await drainUntilFlushed(output, [slow]);
        const consoleOutput = stalled === 'stderr' ? stderr : stdout;
        assert.deepEqual(Buffer.concat(consoleOutput.chunks), Buffer.concat(chunks));
        assert.deepEqual(Buffer.concat(log.chunks.filter((chunk) => chunk.length === 64)), Buffer.concat(chunks));
        assert.deepEqual(failures, []);
    });
}

test('both sinks must drain before a producer resumes', async (context) => {
    const log = controlledSink();
    const stdout = controlledSink();
    const stderr = collectingSink();
    const output = new ShardOutputForwarder(log.sink, stdout.sink, stderr.sink, (error) => assert.fail(error.message));
    context.after(() => output.cancel());
    const source = Readable.from([Buffer.from('first'), Buffer.from('second')], { objectMode: false });
    output.forward(source, stdout.sink, () => {});
    await tick();
    log.callbacks.shift()?.();
    await tick();
    assert.equal(source.isPaused(), true);
    assert.equal(stdout.chunks.length, 1);
    await drainUntilFlushed(output, [log, stdout]);
    assert.equal(Buffer.concat(log.chunks).toString(), 'firstsecond');
    assert.deepEqual(log.chunks, stdout.chunks);
});

test('shared sinks stop all producers with one listener set', async (context) => {
    const slow = controlledSink();
    const consoleSink = collectingSink();
    const originalListeners = slow.sink.listenerCount('drain');
    const outputs = Array.from({ length: 20 }, () => new ShardOutputForwarder(
        slow.sink, consoleSink.sink, consoleSink.sink, (error) => assert.fail(error.message)));
    context.after(() => outputs.forEach((output) => output.cancel()));
    const sources = outputs.map((output) => {
        const source = Readable.from([Buffer.alloc(64), Buffer.alloc(64)], { objectMode: false });
        output.forward(source, consoleSink.sink, () => {});
        return source;
    });
    await tick();
    assert.equal(slow.sink.listenerCount('drain'), originalListeners + 1);
    assert.equal(slow.sink.writableLength, 64);
    assert.ok(sources.every((source) => source.isPaused()));
    await Promise.all(outputs.map((output) => drainUntilFlushed(output, [slow])));
    assert.equal(Buffer.concat(slow.chunks).length, 20 * 2 * 64);
    assert.equal(slow.sink.listenerCount('drain'), originalListeners);
});

test('flush waits for write callbacks even below the high-water mark', async (context) => {
    const slow = controlledSink(65536);
    const log = collectingSink();
    const output = new ShardOutputForwarder(log.sink, slow.sink, slow.sink, (error) => assert.fail(error.message));
    context.after(() => output.cancel());
    output.forward(Readable.from(['last byte']), slow.sink, () => {});
    await tick();
    let flushed = false;
    const pending = output.flush().then(() => { flushed = true; });
    await tick();
    assert.equal(flushed, false);
    slow.callbacks.shift()?.();
    await pending;
});

for (const sinkName of ['stdout', 'stderr', 'log'] as const) {
    for (const terminal of ['error', 'close'] as const) {
        test(`${sinkName} ${terminal} rejects flush and releases sources`, async (context) => {
            const slow = controlledSink();
            const healthy = collectingSink();
            const log = sinkName === 'log' ? slow.sink : healthy.sink;
            const stdout = sinkName === 'stdout' ? slow.sink : healthy.sink;
            const stderr = sinkName === 'stderr' ? slow.sink : healthy.sink;
            const failures: Error[] = [];
            const output = new ShardOutputForwarder(log, stdout, stderr, (error) => failures.push(error));
            context.after(() => output.cancel());
            const source = Readable.from(['one', 'two']);
            output.forward(source, sinkName === 'stderr' ? stderr : stdout, () => {});
            await tick();
            const rejected = assert.rejects(output.flush());
            if (terminal === 'error') slow.callbacks.shift()?.(new Error('controlled sink failure'));
            else slow.sink.destroy();
            await rejected;
            assert.equal(failures.length, 1);
            assert.equal(source.listenerCount('data'), 0);
            slow.callbacks.shift()?.();
            await tick();
            assert.equal(slow.sink.listenerCount('drain'), 0);
        });
    }
}

test('cancellation retains an error listener until outstanding writes finish', async () => {
    const slow = controlledSink();
    const healthy = collectingSink();
    const output = new ShardOutputForwarder(healthy.sink, slow.sink, healthy.sink, (error) => assert.fail(error.message));
    output.forward(Readable.from(['pending']), slow.sink, () => {});
    await tick();
    output.cancel();
    await tick();
    assert.equal(slow.sink.listenerCount('error'), 1);
    slow.callbacks.shift()?.(new Error('late failure after cancellation'));
    await tick();
    assert.equal(slow.sink.listenerCount('error'), 0);
});

function runnerFixture(context: TestContext): BuildResult {
    context.after(isolateTestRunnerEnvironment());
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-backpressure-'));
    context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const buildRoot = path.join(repoRoot, '.node-build');
    const relative = 'tests/node/backpressure.test.js';
    fs.mkdirSync(path.dirname(path.join(buildRoot, relative)), { recursive: true });
    fs.writeFileSync(path.join(buildRoot, relative), 'void 0;\n');
    const result = { repoRoot, buildRoot, copiedFiles: [relative], generatedCliPath: '', manifestPath: '' };
    const build = require('../../../scripts/node-foundation/build') as typeof import('../../../scripts/node-foundation/build');
    context.mock.method(build, 'buildNodeFoundation', () => result);
    context.mock.method(build, 'buildPublishRuntime', () => result);
    const originalArgv = process.argv;
    context.after(() => { process.argv = originalArgv; });
    process.argv = ['node', 'test.js', 'tests/node/backpressure.test.ts'];
    return result;
}

test('runner fails when an empty shard log reports a finalization error', async (context) => {
    runnerFixture(context);
    const errors: Error[] = [];
    const log = new Writable({
        write(_chunk, _encoding, callback) { callback(); },
        final(callback) { setImmediate(() => callback(new Error('log finalization failed'))); }
    });
    log.on('error', (error) => errors.push(error));
    const mutableFs = require('node:fs') as typeof fs;
    context.mock.method(mutableFs, 'createWriteStream', () => log as fs.WriteStream);
    const child = new EventEmitter() as childProcess.ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr });
    const mutableChildProcess = require('node:child_process') as typeof childProcess;
    context.mock.method(mutableChildProcess, 'spawn', () => {
        setImmediate(() => { stdout.end(); stderr.end(); child.emit('exit', 0); child.emit('close'); });
        return child;
    });
    const runner = require('../../../scripts/node-foundation/test') as typeof import('../../../scripts/node-foundation/test');
    const code = await runner.runNodeFoundationTests();
    await tick();
    assert.equal(errors.length, 1);
    assert.equal(code, 1);
});

test('runner bounds a stalled log, times out, and preserves failure status', async (context) => {
    runnerFixture(context);
    process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS = '30';
    process.env.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS = '5';
    const log = controlledSink();
    const mutableFs = require('node:fs') as typeof fs;
    context.mock.method(mutableFs, 'createWriteStream', () => log.sink as fs.WriteStream);
    const child = new EventEmitter() as childProcess.ChildProcess;
    const stdout = new PassThrough({ highWaterMark: 16 });
    const stderr = new PassThrough({ highWaterMark: 16 });
    let killed = 0;
    Object.assign(child, { stdout, stderr, kill: () => { killed += 1; return true; } });
    const mutableChildProcess = require('node:child_process') as typeof childProcess;
    context.mock.method(mutableChildProcess, 'spawn', () => {
        setImmediate(() => { stdout.end(Buffer.alloc(64, 'x')); stderr.end('stderr'); child.emit('exit', 0); child.emit('close'); });
        return child;
    });
    const runner = require('../../../scripts/node-foundation/test') as typeof import('../../../scripts/node-foundation/test');
    assert.equal(await runner.runNodeFoundationTests(), 1);
    assert.equal(killed, 1);
    assert.equal(log.chunks.length, 1);
    assert.equal(log.sink.destroyed, true);
    log.callbacks.shift()?.();
    await tick();
});

for (const channel of ['stdout', 'stderr'] as const) {
    test(`runner waits for final ${channel} bytes and preserves a nonzero child exit`, async (context) => {
        const fixture = runnerFixture(context);
        const slow = controlledSink(65536);
        context.mock.getter(process, channel, () => slow.sink as typeof process.stdout);
        const child = new EventEmitter() as childProcess.ChildProcess;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        Object.assign(child, { stdout, stderr });
        const mutableChildProcess = require('node:child_process') as typeof childProcess;
        context.mock.method(mutableChildProcess, 'spawn', () => {
            setImmediate(() => {
                stdout.end(channel === 'stdout' ? 'trailing stdout\n' : undefined);
                stderr.end(channel === 'stderr' ? 'trailing stderr\n' : undefined);
                child.emit('exit', 7); child.emit('close');
            });
            return child;
        });
        const runner = require('../../../scripts/node-foundation/test') as typeof import('../../../scripts/node-foundation/test');
        let result: number | undefined;
        const pending = runner.runNodeFoundationTests().then((code) => { result = code; });
        for (let index = 0; index < 20 && slow.callbacks.length === 0; index += 1) await tick();
        assert.equal(slow.callbacks.length, 1);
        assert.equal(result, undefined);
        slow.callbacks.shift()?.();
        await pending;
        assert.equal(result, 7);
        assert.equal(Buffer.concat(slow.chunks).toString(), `trailing ${channel}\n`);
        const logs = path.join(fixture.buildRoot, 'test-shard-logs', `run-${process.pid}`);
        assert.equal(fs.readFileSync(path.join(logs, 'shard-01-of-01.log'), 'utf8'), `trailing ${channel}\n`);
    });

    test(`runner treats ${channel} failure as failure even if child exits successfully`, async (context) => {
        const fixture = runnerFixture(context);
        const slow = controlledSink();
        context.mock.getter(process, channel, () => slow.sink as typeof process.stdout);
        const child = new EventEmitter() as childProcess.ChildProcess;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let killed = 0;
        Object.assign(child, { stdout, stderr, kill: () => {
            killed += 1;
            stdout.end(); stderr.end(); child.emit('exit', 0); child.emit('close');
            return true;
        } });
        const mutableChildProcess = require('node:child_process') as typeof childProcess;
        context.mock.method(mutableChildProcess, 'spawn', () => {
            setImmediate(() => { (channel === 'stdout' ? stdout : stderr).write('accepted tail\n'); });
            return child;
        });
        const runner = require('../../../scripts/node-foundation/test') as typeof import('../../../scripts/node-foundation/test');
        const pending = runner.runNodeFoundationTests();
        for (let index = 0; index < 20 && slow.callbacks.length === 0; index += 1) await tick();
        assert.equal(slow.callbacks.length, 1);
        slow.callbacks.shift()?.(new Error('broken output sink'));
        assert.equal(await pending, 1);
        assert.equal(killed, 1);
        const logs = path.join(fixture.buildRoot, 'test-shard-logs', `run-${process.pid}`);
        const failureLog = fs.readFileSync(path.join(logs, 'shard-01-of-01.log'), 'utf8');
        assert.match(failureLog, /accepted tail/);
        assert.match(failureLog, /Node test output forwarding failed: broken output sink/);
        await tick();
    });
}
