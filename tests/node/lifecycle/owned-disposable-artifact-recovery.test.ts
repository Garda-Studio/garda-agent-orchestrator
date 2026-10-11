import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fsyncDirectoryBestEffort } from '../../../src/core/filesystem';
import { getLifecycleOperationLockPath } from '../../../src/lifecycle/lock/lifecycle-lock';
import { resumeOwnedDisposableArtifacts } from '../../../src/lifecycle/cleanup/owned-disposable-artifact-recovery';
import { recoveryFixture } from './fixtures/disposable-recovery-fixtures';
import { recoveryCrashWorkerPath } from './fixtures/disposable-recovery-crash-worker';

const rawFs = require('node:fs') as typeof fs;
const run = (f: ReturnType<typeof recoveryFixture>) => resumeOwnedDisposableArtifacts({ ...f.selection, confirmed: true });

test('confirmed native recovery removes exact payload and retains readable compact authority', t => {
    const f = recoveryFixture(t), protectedHashes = f.hashes(), members = f.read().progress.order.length;
    const result = run(f);
    assert.equal(result.status, 'FINISHED', result.errors.join());
    assert.equal(result.already_finished, false); assert.equal(result.counts_complete, true);
    assert.equal(result.historical_removed_bytes, 0); assert.equal(result.historical_reconciled_bytes, 0);
    assert.equal(result.removed_member_count, members); assert.equal(result.removed_file_count, 2);
    assert.equal(result.removed_bytes, 7); assert.equal(result.reconciled_bytes, 0);
    assert.equal(result.remaining_bytes, 0); assert.equal(result.remaining_file_count, 0);
    assert.deepEqual(result.removed_roots, [path.relative(f.targetRoot, f.producers[0].payloadPath).replace(/\\/gu, '/')]);
    assert.deepEqual(f.payloadHashes(), []); assert.deepEqual(f.hashes(), protectedHashes);
    assert.equal(f.read().progress.status, 'FINISHED'); assert.equal(f.read().progress.known_removed_bytes, 7);
});

for (const state of ['partial', 'present', 'error'] as const) test(`public recovery retains genuine legacy ${state} frames`, t => {
    const f = recoveryFixture(t), protectedHashes = f.hashes();
    f.prefix(state === 'partial' ? 1 : 0, state === 'present' ? 'present' : state === 'error' ? 'error' : 'none');
    const prefix = f.frames(), result = run(f);
    assert.equal(result.status, 'FINISHED', result.errors.join());
    assert.equal(result.historical_removed_bytes, state === 'partial' ? 3 : 0);
    assert.equal(result.removed_bytes, state === 'partial' ? 4 : 7);
    assert.equal(result.reconciled_member_count, 0); assert.equal(result.counts_complete, true);
    assert.deepEqual(f.frames().slice(0, prefix.length), prefix); assert.deepEqual(f.hashes(), protectedHashes);
    assert.deepEqual(f.payloadHashes(), []); assert.equal(f.read().progress.last_error, null);
});

test('public recovery reports inherited pending absence separately from current actual unlink counts', t => {
    const f = recoveryFixture(t), protectedHashes = f.hashes(); f.prefix(0, 'absent');
    const prefix = f.frames(), result = run(f);
    assert.equal(result.status, 'FINISHED', result.errors.join());
    assert.equal(result.historical_removed_bytes, 0); assert.equal(result.removed_file_count, 1);
    assert.equal(result.removed_bytes, 4); assert.equal(result.reconciled_file_count, 1); assert.equal(result.reconciled_bytes, 3);
    assert.equal(f.read().progress.known_removed_bytes, 4); assert.equal(f.read().progress.reconciled_bytes, 3);
    assert.deepEqual(f.frames().slice(0, prefix.length), prefix); assert.deepEqual(f.hashes(), protectedHashes);
    const repeated = run(f);
    assert.equal(repeated.already_finished, true); assert.equal(repeated.historical_removed_bytes, 4);
    assert.equal(repeated.historical_reconciled_bytes, 3); assert.equal(repeated.removed_bytes, 0);
    assert.equal(repeated.reconciled_bytes, 0);
});

test('root pending absence retires one directory without claiming new file removal or bytes', t => {
    const f = recoveryFixture(t), members = f.read().progress.order.length; f.prefix(members - 1, 'absent');
    const result = run(f);
    assert.equal(result.status, 'FINISHED', result.errors.join()); assert.equal(result.historical_removed_bytes, 7);
    assert.equal(result.removed_member_count, 0); assert.equal(result.removed_bytes, 0);
    assert.equal(result.reconciled_member_count, 1); assert.equal(result.reconciled_file_count, 0);
    assert.equal(result.reconciled_bytes, 0); assert.deepEqual(result.removed_roots, []);
});

test('one exact multi-producer selection finishes both roots while preserving their separate owners', t => {
    const f = recoveryFixture(t, 2), hashes = f.hashes(), result = run(f);
    assert.equal(result.status, 'FINISHED', result.errors.join()); assert.equal(result.removed_roots.length, 2);
    assert.equal(result.removed_file_count, 4); assert.equal(result.removed_bytes, 14);
    assert.deepEqual(f.hashes(), hashes); assert.deepEqual(f.payloadHashes(), []);
});

test('canonical finished repeat performs no filesystem mutation including locks or runtime generation', t => {
    const f = recoveryFixture(t); assert.equal(run(f).status, 'FINISHED');
    const prefix = f.frames(), hashes = f.hashes(), open = rawFs.openSync;
    for (const method of ['writeFileSync', 'writeSync', 'mkdirSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'linkSync', 'truncateSync'] as const) {
        t.mock.method(rawFs, method, () => { throw new Error(`Unexpected terminal mutation: ${method}`); });
    }
    t.mock.method(rawFs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        const flags = args[1];
        assert.ok(typeof flags === 'string' ? flags === 'r' : !(flags & (fs.constants.O_CREAT | fs.constants.O_TRUNC
            | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_RDWR)), `Unexpected terminal open: ${flags}`);
        return open(...args);
    });
    const result = run(f); t.mock.restoreAll();
    assert.equal(result.status, 'FINISHED', result.errors.join()); assert.equal(result.already_finished, true);
    assert.equal(result.mutation_attempted, false); assert.equal(result.removed_bytes, 0);
    assert.equal(result.historical_removed_bytes, 7); assert.equal(result.reconciled_bytes, 0);
    assert.deepEqual(f.frames(), prefix); assert.deepEqual(f.hashes(), hashes);
});

test('finished inspection rejects compact evidence changed during the actual native read and preserves it', t => {
    const f = recoveryFixture(t); assert.equal(run(f).status, 'FINISHED');
    const prefix = f.frames(), closeout = path.join(f.reviews, `${f.taskId}-final-closeout.json`);
    const original = fs.readFileSync(closeout), read = rawFs.readFileSync; let changed = false;
    t.mock.method(rawFs, 'readFileSync', ((...args: Parameters<typeof fs.readFileSync>) => {
        const value = read(...args);
        if (!changed && path.resolve(String(args[0])) === path.resolve(closeout)) {
            fs.appendFileSync(closeout, '\n'); changed = true;
        }
        return value;
    }) as typeof fs.readFileSync);
    const result = run(f); t.mock.restoreAll();
    assert.equal(changed, true); assert.equal(result.status, 'BLOCKED'); assert.equal(result.counts_complete, false);
    assert.equal(result.mutation_attempted, false); assert.equal(result.removed_bytes, 0);
    assert.deepEqual(fs.readFileSync(closeout), Buffer.concat([original, Buffer.from('\n')]));
    assert.deepEqual(f.frames(), prefix); assert.deepEqual(f.payloadHashes(), []);
});

test('missing confirmation and caller records or keys cannot publish progress or authorize recovery', t => {
    const f = recoveryFixture(t), hashes = f.hashes(), payload = f.payloadHashes();
    assert.equal(resumeOwnedDisposableArtifacts({ ...f.selection, confirmed: false }).status, 'CONFIRMATION_REQUIRED');
    for (const field of ['snapshot', 'records', 'key', 'removed_bytes']) {
        const result = resumeOwnedDisposableArtifacts({ ...f.selection, confirmed: true, [field]: {} });
        assert.equal(result.status, 'BLOCKED'); assert.equal(result.mutation_attempted, false);
        assert.equal(result.historical_removed_bytes, null); assert.equal(result.counts_complete, false);
    }
    assert.deepEqual(f.frames(), []); assert.deepEqual(f.hashes(), hashes); assert.deepEqual(f.payloadHashes(), payload);
    assert.equal(run(f).status, 'FINISHED'); const prefix = f.frames();
    const injected = { ...f.selection, confirmed: true, records: [] };
    assert.equal(resumeOwnedDisposableArtifacts(injected).status, 'BLOCKED');
    assert.equal(resumeOwnedDisposableArtifacts(Object.create({ ...f.selection, confirmed: true })).status, 'BLOCKED');
    assert.deepEqual(f.frames(), prefix);
});

for (const drift of ['new-member', 'replacement', 'key', 'owner', 'dependency'] as const) test(`recovery preserves changed ${drift} and remaining payload`, t => {
    const f = recoveryFixture(t, 1, true);
    if (drift === 'new-member') fs.writeFileSync(path.join(f.producers[0].payloadPath, 'unexpected.txt'), 'new bytes');
    if (drift === 'replacement') { fs.unlinkSync(f.alpha); fs.writeFileSync(f.alpha, 'abc'); }
    if (drift === 'key') fs.writeFileSync(f.key, Buffer.alloc(32, 23));
    if (drift === 'owner') fs.writeFileSync(f.producers[0].ownerPath, '{}\n');
    if (drift === 'dependency') fs.appendFileSync(f.note, 'changed dependency\n');
    const hashes = f.hashes(), payload = f.payloadHashes(), result = run(f);
    assert.equal(result.status, 'BLOCKED', result.errors.join()); assert.equal(result.mutation_attempted, false);
    assert.equal(result.removed_bytes, 0); assert.equal(result.counts_complete, false);
    assert.deepEqual(f.frames(), []); assert.deepEqual(f.hashes(), hashes); assert.deepEqual(f.payloadHashes(), payload);
});

for (const corrupted of ['frame', 'interrupted-temp'] as const) test(`recovery retains ${corrupted} diagnostics without removing payload`, t => {
    const f = recoveryFixture(t); f.prefix(0, 'present');
    const file = path.join(f.directory, corrupted === 'frame' ? fs.readdirSync(f.directory)[0] : '.00000001.json.intent-interrupted');
    fs.writeFileSync(file, '{}\n'); const prefix = f.frames(), hashes = f.hashes(), payload = f.payloadHashes();
    const result = run(f);
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.mutation_attempted, false);
    assert.deepEqual(f.frames(), prefix); assert.deepEqual(f.hashes(), hashes); assert.deepEqual(f.payloadHashes(), payload);
});

test('ambiguous unlink failure preserves same-process refusal and resumes in a genuine fresh process', t => {
    const f = recoveryFixture(t), payload = f.payloadHashes(), hashes = f.hashes(), unlink = rawFs.unlinkSync;
    t.mock.method(rawFs, 'unlinkSync', (file: fs.PathLike) => {
        if (path.resolve(String(file)) === path.resolve(f.alpha)) throw Object.assign(new Error('controlled unlink I/O failure'), { code: 'EIO' });
        return unlink(file);
    });
    const failed = run(f); t.mock.restoreAll();
    assert.equal(failed.status, 'INCOMPLETE'); assert.equal(failed.mutation_attempted, true);
    assert.equal(failed.counts_complete, false); assert.equal(failed.removed_bytes, 0);
    const names = fs.readdirSync(f.directory).filter(name => /^\d{8}\.json$/u.test(name)).sort();
    const pending = JSON.parse(fs.readFileSync(path.join(f.directory, names.at(-1)!), 'utf8')).progress;
    assert.equal(pending.event, 'PENDING'); assert.equal(pending.member_path, path.relative(f.targetRoot, f.alpha).split(path.sep).join('/'));
    assert.ok(failed.errors.some(message => message.includes('controlled unlink I/O failure')));
    assert.ok(failed.errors.some(message => message.includes('Error publication blocked; retain pending evidence')));
    assert.deepEqual(f.payloadHashes(), payload); const prefix = f.frames();
    const refused = run(f); assert.equal(refused.status, 'BLOCKED'); assert.equal(refused.mutation_attempted, false);
    assert.deepEqual(f.frames(), prefix); assert.deepEqual(f.payloadHashes(), payload);
    const sync = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-disposable-fresh-resume-'));
    t.after(() => fs.rmSync(sync, { recursive: true, force: true }));
    const options = path.join(sync, 'options.json'); fs.writeFileSync(options, JSON.stringify({ ...f.selection, confirmed: true }));
    const child = spawnSync(process.execPath, [recoveryCrashWorkerPath, options, path.join(sync, 'unused-marker'),
        'complete', f.producers[0].payloadPath], { encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
    const retried = JSON.parse(child.stdout);
    assert.equal(retried.status, 'FINISHED', retried.errors.join()); assert.equal(retried.removed_bytes, 7);
    assert.equal(retried.reconciled_bytes, 0); assert.deepEqual(f.frames().slice(0, prefix.length), prefix);
    assert.deepEqual(f.hashes(), hashes); assert.deepEqual(f.payloadHashes(), []);
});

test('unchanged permission-denied unlink publishes ERROR and safely resumes in the same process', t => {
    const f = recoveryFixture(t), payload = f.payloadHashes(), hashes = f.hashes(), unlink = rawFs.unlinkSync;
    let denied = false;
    t.mock.method(rawFs, 'unlinkSync', (file: fs.PathLike) => {
        if (path.resolve(String(file)) === path.resolve(f.alpha)) {
            denied = true;
            throw Object.assign(new Error('controlled unchanged unlink permission failure'), { code: 'EACCES' });
        }
        return unlink(file);
    });
    const failed = run(f); t.mock.restoreAll(); assert.equal(denied, true);
    assert.equal(failed.status, 'INCOMPLETE'); assert.equal(failed.mutation_attempted, true);
    assert.equal(failed.counts_complete, false); assert.equal(failed.removed_bytes, 0); assert.equal(failed.removed_file_count, 0);
    assert.ok(failed.errors.some(message => message.includes('controlled unchanged unlink permission failure')));
    assert.equal(failed.errors.some(message => message.includes('Error publication blocked')), false);
    assert.equal(f.read().progress.status, 'ERROR'); assert.deepEqual(f.payloadHashes(), payload);
    const prefix = f.frames(), retried = run(f);
    assert.equal(retried.status, 'FINISHED', retried.errors.join()); assert.equal(retried.counts_complete, true);
    assert.equal(retried.removed_bytes, 7); assert.equal(retried.removed_file_count, 2);
    assert.equal(retried.reconciled_bytes, 0); assert.equal(retried.historical_removed_bytes, 0);
    assert.deepEqual(f.frames().slice(0, prefix.length), prefix);
    assert.deepEqual(f.hashes(), hashes); assert.deepEqual(f.payloadHashes(), []);
});

test('failed REMOVED publication reports actual unlink and preserves interrupted diagnostics and remaining bytes', t => {
    const f = recoveryFixture(t), hashes = f.hashes(), rename = rawFs.renameSync;
    t.mock.method(rawFs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        if (path.dirname(String(to)) === f.directory
            && JSON.parse(fs.readFileSync(from, 'utf8')).progress?.event === 'REMOVED') throw new Error('controlled metadata publication failure');
        return rename(from, to);
    });
    const failed = run(f); t.mock.restoreAll();
    assert.equal(failed.status, 'INCOMPLETE'); assert.equal(failed.removed_file_count, 1);
    assert.equal(failed.removed_bytes, 3); assert.equal(failed.counts_complete, false);
    assert.equal(fs.existsSync(f.alpha), false); assert.deepEqual(fs.readFileSync(f.binary), Buffer.from([0, 1, 2, 3]));
    const retained = f.frames(); assert.ok(retained.some(([name]) => name.includes('.intent-')));
    assert.equal(run(f).status, 'BLOCKED'); assert.deepEqual(f.frames(), retained); assert.deepEqual(f.hashes(), hashes);
});

test('actual lifecycle owner loss during native resume publication blocks all payload mutation', t => {
    const f = recoveryFixture(t), payload = f.payloadHashes(), hashes = f.hashes(), rename = rawFs.renameSync;
    t.mock.method(rawFs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        rename(from, to);
        if (path.dirname(String(to)) === f.directory) fs.rmSync(getLifecycleOperationLockPath(f.targetRoot), { recursive: true, force: true });
    });
    const failed = run(f); t.mock.restoreAll();
    assert.equal(failed.status, 'BLOCKED'); assert.equal(failed.mutation_attempted, false);
    assert.equal(failed.removed_bytes, 0); assert.deepEqual(f.payloadHashes(), payload); assert.deepEqual(f.hashes(), hashes);
    assert.equal(f.read().progress.resume_attempt_count, 1);
});

test('new pending disappearance stays readable ERROR and only a later invocation reconciles it', t => {
    const f = recoveryFixture(t), hashes = f.hashes();
    const snapshots: typeof import('../../../src/lifecycle/cleanup/owned-disposable-artifact-recovery-snapshot') =
        require('../../../src/lifecycle/cleanup/owned-disposable-artifact-recovery-snapshot');
    const read = snapshots.readOwnedDisposableArtifactRecoverySnapshot; let disappeared = false;
    t.mock.method(snapshots, 'readOwnedDisposableArtifactRecoverySnapshot', (selection: typeof f.selection) => {
        const proof = read(selection);
        if (!disappeared && proof.progress.frames.length === 2 && proof.progress.status === 'PENDING') {
            fs.unlinkSync(f.alpha); fsyncDirectoryBestEffort(path.dirname(f.alpha)); disappeared = true;
        }
        return proof;
    });
    const failed = run(f); t.mock.restoreAll(); assert.equal(disappeared, true);
    assert.equal(failed.status, 'INCOMPLETE'); assert.equal(failed.mutation_attempted, false);
    assert.equal(failed.removed_bytes, 0); assert.equal(failed.reconciled_bytes, 0);
    assert.equal(f.read().progress.status, 'ERROR'); const prefix = f.frames();
    const resumed = run(f);
    assert.equal(resumed.status, 'FINISHED', resumed.errors.join()); assert.equal(resumed.removed_bytes, 4);
    assert.equal(resumed.reconciled_bytes, 3); assert.equal(resumed.historical_removed_bytes, 0);
    assert.deepEqual(f.frames().slice(0, prefix.length), prefix); assert.deepEqual(f.hashes(), hashes);
});
