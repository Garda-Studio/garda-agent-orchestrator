import test from 'node:test';
import assert from 'node:assert/strict';
import { compactPreview, validateCompactSettings, DEFAULT_COMPACT_SETTINGS } from '../../../src/core/compact/contract';
import { spawnStreamed } from '../../../src/core/process/subprocess';

test('compact preserves short data and secret-shaped strings without a reference', () => {
    const text = 'token=super-secret\nhello\n';
    assert.deepEqual(compactPreview(text), { text, omitted: false });
});

test('compact bounds long lines and retains beginning and tail', () => {
    const result = compactPreview('early cause\n' + 'x'.repeat(20000) + '\nlast line\n');
    assert.equal(result.omitted, true);
    assert.ok(result.text.length <= DEFAULT_COMPACT_SETTINGS.previewChars);
    assert.ok(result.text.includes('early cause'));
    assert.ok(result.text.includes('last line'));
});

test('compact validates quotas and does not accept unknown settings', () => {
    assert.throws(() => validateCompactSettings({ runBytes: 0 }));
    assert.throws(() => validateCompactSettings({ taskBytes: 1024 }));
    assert.throws(() => validateCompactSettings({ enabled: 'true' }));
    assert.throws(() => validateCompactSettings({ redact: true }));
    for (const key of ['constructor', 'toString', '__proto__']) {
        assert.throws(() => validateCompactSettings(JSON.parse(`{"${key}":1}`)));
    }
    assert.equal(validateCompactSettings({ enabled: false }).enabled, false);
});

test('stream sink preserves original bytes with backpressure', async () => {
    const chunks: Buffer[] = [];
    let pending = 0;
    const result = await spawnStreamed(process.execPath, ['-e', "process.stdout.write(Buffer.from([0xff,0x00,0x61]));process.stderr.write('secret=unchanged')"], {
        maxBuffer: 32,
        outputSink: { async write(stream, chunk) {
            assert.equal(pending++, 0);
            if (stream === 'stdout') chunks.push(Buffer.from(chunk));
            await new Promise(resolve => setTimeout(resolve, 5));
            pending--;
        } }
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([0xff, 0, 0x61]));
    assert.equal(result.stderr, 'secret=unchanged');
});

test('sink failure stops the producer and reports incomplete capture', async () => {
    const result = await spawnStreamed(process.execPath, ['-e', "setInterval(()=>process.stdout.write('x'),10)"], {
        timeoutMs: 5000,
        outputSink: { async write() { throw new Error('disk full'); } }
    });
    assert.equal(result.sinkError, 'disk full');
    assert.notEqual(result.exitCode, 0);
});

test('sink timeout still finishes after child exit', async () => {
    const result = await spawnStreamed(process.execPath, ['-e', "process.stdout.write('x')"], {
        timeoutMs: 200, outputSink: { write: () => new Promise(() => {}) }
    });
    assert.equal(result.timedOut, true);
    assert.ok(result.sinkError);
});

test('empty sink error is not mistaken for successful capture', async () => {
    const result = await spawnStreamed(process.execPath, ['-e', "process.stdout.write('x')"], {
        outputSink: { async write() { await new Promise(resolve => setTimeout(resolve, 100)); throw new Error(''); } }
    });
    assert.equal(result.sinkError, 'Output sink failed.');
});

test('sink callbacks receive final UTF-8 decoding remainder', async () => {
    let seen = '';
    const result = await spawnStreamed(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xe2]))'], {
        onStdout: chunk => { seen += chunk; }, outputSink: { async write() {} }
    });
    assert.equal(seen, result.stdout);
    assert.equal(seen, '\ufffd');
});
