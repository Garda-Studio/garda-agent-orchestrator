import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { getLifecycleOperationLockPath, getLastLifecycleLockTelemetry,
    LIFECYCLE_OPERATION_LOCK_OWNER_FILE_NAME } from '../../../src/lifecycle/lock/lifecycle-lock';
import { assertScratchLockRecoverySafe, resolveScratchWriterLocations } from '../../../src/lifecycle/cleanup/scratch-writer-ownership';
import { resumeOwnedDisposableArtifacts } from '../../../src/lifecycle/cleanup/owned-disposable-artifact-recovery';
import { recoveryFixture } from './fixtures/disposable-recovery-fixtures';
import { recoveryCrashWorkerPath } from './fixtures/disposable-recovery-crash-worker';

type Phase = 'pending' | 'unlinked' | 'before-finished';

test('crash readiness hides empty and partial marker bytes until publication', t => {
    const worker = require('./fixtures/disposable-recovery-crash-worker') as object;
    const publishCrashMarker = Reflect.get(worker, 'publishCrashMarker') as
        ((marker: string, phase: string) => void) | undefined;
    assert.ok(typeof publishCrashMarker === 'function', 'Crash readiness requires an atomic marker publisher.');
    const sync = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-disposable-marker-'));
    t.after(() => fs.rmSync(sync, { recursive: true, force: true }));
    const marker = path.join(sync, 'paused.json');
    const rawFs = require('node:fs') as typeof fs, originalWrite = rawFs.writeFileSync;
    t.mock.method(rawFs, 'writeFileSync', ((...args: Parameters<typeof fs.writeFileSync>) => {
        const [file, data, options] = args;
        originalWrite(file, '', options);
        assert.equal(fs.existsSync(marker), false, 'creating the file must not announce readiness');
        assert.throws(() => JSON.parse(fs.readFileSync(file, 'utf8')), SyntaxError);
        originalWrite(file, '{"pid":');
        assert.equal(fs.existsSync(marker), false, 'partial JSON must not announce readiness');
        assert.throws(() => JSON.parse(fs.readFileSync(file, 'utf8')), SyntaxError);
        originalWrite(file, data);
        assert.equal(fs.existsSync(marker), false, 'ready path must wait for complete publication');
    }) as typeof fs.writeFileSync);
    publishCrashMarker(marker, 'pending');
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { pid: process.pid, phase: 'pending' });
    assert.deepEqual(fs.readdirSync(sync), ['paused.json']);
});

async function stopAt(t: TestContext, f: ReturnType<typeof recoveryFixture>, phase: Phase) {
    const sync = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-disposable-crash-'));
    t.after(() => fs.rmSync(sync, { recursive: true, force: true }));
    const options = path.join(sync, 'options.json'), marker = path.join(sync, 'paused.json');
    fs.writeFileSync(options, JSON.stringify({ ...f.selection, confirmed: true }) + '\n');
    const child = spawn(process.execPath, [recoveryCrashWorkerPath, options, marker, phase, f.producers[0].payloadPath],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(child.pid); const pid = child.pid; let exited = false, diagnostics = '';
    child.stdout.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4096); });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4096); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolve => {
        child.once('error', error => { exited = true; resolve({ code: null, signal: null, error }); });
        child.once('close', (code, signal) => { exited = true; resolve({ code, signal }); });
    });
    t.after(async () => { if (!exited) child.kill('SIGKILL'); await closed; });
    const deadline = Date.now() + 90_000;
    while (!fs.existsSync(marker) && !exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(fs.existsSync(marker), `Worker did not pause at ${phase}: ${diagnostics}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { pid, phase });
    const lifecyclePath = getLifecycleOperationLockPath(f.targetRoot);
    const ownerFile = path.join(lifecyclePath, LIFECYCLE_OPERATION_LOCK_OWNER_FILE_NAME);
    const ownerBytes = fs.readFileSync(ownerFile), owner = JSON.parse(ownerBytes.toString('utf8'));
    assert.equal(owner.pid, pid); assert.equal(owner.hostname, os.hostname());
    assert.doesNotThrow(() => process.kill(pid, 0));
    const writer = resolveScratchWriterLocations({ targetRoot: f.targetRoot, bundleRoot: f.bundleRoot,
        scratchName: 'disposable-producer-registry' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(writer.lockPath, 'owner.json'), 'utf8')).pid, pid);
    assert.throws(() => assertScratchLockRecoverySafe(f.targetRoot, writer.lockPath), /known-dead local recovery/u);
    const snapshot = f.read(), frames = f.frames();
    if (phase === 'before-finished') {
        assert.equal(snapshot.progress.status, 'PARTIAL');
        assert.equal(snapshot.progress.retired_member_count, snapshot.progress.order.length);
        assert.equal(snapshot.remaining_bytes, 0); assert.equal(snapshot.progress.known_removed_bytes, 7);
    } else {
        assert.equal(snapshot.progress.status, 'PENDING'); assert.equal(snapshot.progress.known_removed_bytes, 0);
        assert.equal(snapshot.pending_absent_path === null, phase === 'pending');
        assert.equal(snapshot.remaining_bytes, phase === 'pending' ? 7 : 4);
    }
    assert.equal(child.kill('SIGKILL'), true);
    const outcome = await closed;
    assert.equal(outcome.error, undefined); assert.equal(outcome.code, null); assert.equal(outcome.signal, 'SIGKILL');
    assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
    assert.deepEqual(fs.readFileSync(ownerFile), ownerBytes);
    assert.doesNotThrow(() => assertScratchLockRecoverySafe(f.targetRoot, writer.lockPath));
    assert.deepEqual(f.frames(), frames);
    return frames;
}

for (const phase of ['pending', 'unlinked', 'before-finished'] as const) {
    test(`real Linux SIGKILL at ${phase} resumes exact bytes with native dead-owner reclaim`,
        { skip: process.platform !== 'linux', timeout: 180_000 }, async t => {
            const f = recoveryFixture(t), protectedHashes = f.hashes();
            const prefix = await stopAt(t, f, phase);
            assert.deepEqual(f.hashes(), protectedHashes);
            const result = resumeOwnedDisposableArtifacts({ ...f.selection, confirmed: true });
            assert.equal(result.status, 'FINISHED', result.errors.join());
            assert.equal(getLastLifecycleLockTelemetry()?.staleLockRecovered, true);
            assert.equal(result.counts_complete, true); assert.equal(result.already_finished, false);
            assert.equal(result.historical_removed_bytes, phase === 'before-finished' ? 7 : 0);
            assert.equal(result.removed_bytes, phase === 'before-finished' ? 0 : phase === 'unlinked' ? 4 : 7);
            assert.equal(result.removed_file_count, phase === 'before-finished' ? 0 : phase === 'unlinked' ? 1 : 2);
            assert.equal(result.reconciled_bytes, phase === 'unlinked' ? 3 : 0);
            assert.equal(result.reconciled_file_count, phase === 'unlinked' ? 1 : 0);
            assert.equal(result.remaining_bytes, 0); assert.deepEqual(f.payloadHashes(), []);
            assert.deepEqual(f.frames().slice(0, prefix.length), prefix); assert.deepEqual(f.hashes(), protectedHashes);
            const progress = f.read().progress;
            assert.equal(progress.status, 'FINISHED'); assert.equal(progress.known_removed_bytes + progress.reconciled_bytes, 7);
            const finishedFrames = f.frames(), repeat = resumeOwnedDisposableArtifacts({ ...f.selection, confirmed: true });
            assert.equal(repeat.status, 'FINISHED', repeat.errors.join()); assert.equal(repeat.already_finished, true);
            assert.equal(repeat.mutation_attempted, false); assert.equal(repeat.removed_bytes, 0); assert.equal(repeat.reconciled_bytes, 0);
            assert.deepEqual(f.frames(), finishedFrames); assert.deepEqual(f.hashes(), protectedHashes);
        });
}
