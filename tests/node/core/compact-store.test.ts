import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withCompactStore, CompactCapture, readCompactOutput, cleanupCompactTasks } from '../../../src/core/compact/store';
import { DEFAULT_COMPACT_SETTINGS } from '../../../src/core/compact/contract';

function workspace(t: { after(fn: () => void): void }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-compact-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('small output does not create a run or a retrieval reference', async t => {
    const root = workspace(t);
    await withCompactStore(root, async store => {
        const capture = new CompactCapture(store, 'T-ONE', { ...DEFAULT_COMPACT_SETTINGS });
        await capture.write('stdout', Buffer.from('secret=unchanged\n'));
        const result = capture.finish({ exitCode: 0, timedOut: false, cancelled: false });
        assert.equal(result.ref, undefined);
        assert.equal(result.stdout, 'secret=unchanged\n');
    });
});

test('long output is byte-identical and searchable outside the preview', async t => {
    const root = workspace(t);
    const text = 'x'.repeat(16000) + '\nneedle=secret\n' + 'y'.repeat(16000);
    const ref = await withCompactStore(root, async store => {
        const capture = new CompactCapture(store, 'T-ONE', { ...DEFAULT_COMPACT_SETTINGS });
        await capture.write('stdout', Buffer.from(text));
        return capture.finish({ exitCode: 0, timedOut: false, cancelled: false }).ref!;
    });
    const found = await readCompactOutput(root, { taskId: 'T-ONE', ref, stream: 'stdout', query: 'needle=secret' });
    assert.ok(found.text.includes('needle=secret'));
    assert.ok(found.text.length <= 8000);
    await assert.rejects(readCompactOutput(root, { taskId: 'T-OTHER', ref, stream: 'stdout' }));
    await withCompactStore(root, store => {
        assert.equal(fs.readFileSync(store.runPath('T-ONE', ref) + '/stdout.log', 'utf8'), text);
    });
    assert.deepEqual(await cleanupCompactTasks(root, new Set(['T-OTHER'])), []);
    assert.deepEqual(await cleanupCompactTasks(root, new Set(['T-ONE'])), ['T-ONE']);
    await assert.rejects(readCompactOutput(root, { taskId: 'T-ONE', ref, stream: 'stdout' }), /not retained/);
});

test('capture cap reports partial and quotas preserve current-task data', async t => {
    const root = workspace(t);
    const settings = { ...DEFAULT_COMPACT_SETTINGS, runBytes: 16384, taskBytes: 16384, workspaceBytes: 16384 };
    await withCompactStore(root, async store => {
        const capture = new CompactCapture(store, 'T-ONE', settings);
        await assert.rejects(capture.write('stdout', Buffer.alloc(20000, 120)), /limit/);
        assert.equal(capture.finish({ exitCode: 1, timedOut: false, cancelled: false }).complete, false);
        const other = new CompactCapture(store, 'T-TWO', settings);
        await assert.rejects(other.write('stdout', Buffer.alloc(20000)), /quota/);
    });
});

test('storage rejects traversal and symlink cache roots', async t => {
    const root = workspace(t);
    await withCompactStore(root, store => assert.throws(() => store.runPath('../outside', 'bad')));
    const other = workspace(t);
    const cache = path.join(root, 'garda-agent-orchestrator/runtime/compact');
    fs.rmSync(cache, { recursive: true, force: true });
    fs.symlinkSync(other, cache, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(withCompactStore(root, () => undefined), /link|contain/i);
});

test('small partial captures retain a reference even below the in-memory ceiling', async t => {
    const root = workspace(t);
    await withCompactStore(root, async store => {
        const capture = new CompactCapture(store, 'T-PARTIAL', { ...DEFAULT_COMPACT_SETTINGS, runBytes: 12288 });
        await assert.rejects(capture.write('stdout', Buffer.alloc(6000, 120)), /limit/);
        const result = capture.finish({ exitCode: 1, timedOut: false, cancelled: false });
        assert.equal(result.complete, false);
        assert.ok(result.ref);
    });
});

test('manifest excludes subprocess capture buffers and bounds error metadata', async t => {
    const root = workspace(t);
    await withCompactStore(root, async store => {
        const capture = new CompactCapture(store, 'T-META', { ...DEFAULT_COMPACT_SETTINGS });
        await capture.write('stdout', Buffer.alloc(16000, 120));
        const outcome = { exitCode: 1, timedOut: false, cancelled: false, stdout: '\0'.repeat(10000), sinkError: '\0'.repeat(10000) };
        const result = capture.finish(outcome);
        const file = path.join(store.runPath('T-META', result.ref!), 'manifest.json');
        assert.ok(fs.statSync(file).size <= 8192);
        assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'stdout'), false);
    });
});

test('partial disk writes publish verifiable stored bytes instead of stale counters', async t => {
    const root = workspace(t);
    const ref = await withCompactStore(root, async store => {
        const capture = new CompactCapture(store, 'T-IO', { ...DEFAULT_COMPACT_SETTINGS });
        await capture.write('stdout', Buffer.alloc(16000, 120));
        const fsModule = require('node:fs') as typeof fs;
        const originalWrite = fsModule.writeSync;
        let first = true;
        fsModule.writeSync = ((fd: number, buffer: Buffer, offset: number, length: number) => {
            if (!first) throw new Error('Injected disk full');
            first = false;
            return originalWrite(fd, buffer, offset, Math.min(3, length));
        }) as typeof fs.writeSync;
        try { await assert.rejects(capture.write('stdout', Buffer.from('abcdef')), /disk full/); }
        finally { fsModule.writeSync = originalWrite; }
        return capture.finish({ exitCode: 1, timedOut: false, cancelled: false }).ref!;
    });
    const result = await readCompactOutput(root, { taskId: 'T-IO', ref, stream: 'stdout', tail: true });
    assert.equal(result.complete, false);
    assert.equal(result.bytes, 16003);
    assert.ok(result.text.endsWith('abc'));
});
