import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac } from 'node:crypto';
import { bindContainedDestination, removeBoundContainedPath } from '../../../src/core/contained-filesystem';
import { lstatFileIdentitySync } from '../../../src/core/file-stat';
import { fsyncDirectoryBestEffort } from '../../../src/core/filesystem';
import { getLifecycleOperationLockPath } from '../../../src/lifecycle/lock/lifecycle-lock';
import { prepareOwnedDisposableArtifactRetirement, readOwnedDisposableRetirementProgress,
    withOwnedDisposableRecoveryMutation, withOwnedDisposableRetirementMutation }
    from '../../../src/lifecycle/cleanup/owned-disposable-artifact-journal';
import type { OwnedDisposableRecoveryMutation } from '../../../src/lifecycle/cleanup/owned-disposable-artifact-recovery-mutation';
import { removeOwnedDisposableArtifacts } from '../../../src/lifecycle/cleanup/owned-disposable-artifact-removal';
import { OWNED_DISPOSABLE_RECOVERY_MAX_ATTEMPTS, readOwnedDisposableArtifactRecoveryProgress }
    from '../../../src/lifecycle/cleanup/owned-disposable-artifact-recovery-progress';
import { readOwnedDisposableArtifactRecoverySnapshot }
    from '../../../src/lifecycle/cleanup/owned-disposable-artifact-recovery-snapshot';
import { scratchBindingIdentity, scratchSha256 } from '../../../src/lifecycle/cleanup/scratch-writer-ownership';
import { computeFileSha256 } from '../gates/task-audit/task-audit-summary-fixtures';
import { fixture, taskId } from './owned-disposable-artifact-fixtures';

const rawFs = require('node:fs') as typeof fs;

function owned(t: TestContext, count = 1, dependency = false) {
    const f = fixture(t), producers = Array.from({ length: count }, () => f.produce());
    const note = path.join(f.reviews, `${taskId}-dependency-note.json`);
    if (dependency) fs.writeFileSync(note, JSON.stringify({ note: 'original native dependency' }) + '\n');
    const preview = f.preview(...producers.map(item => item.registrationId));
    assert.equal(preview.status, 'READY', preview.blockers.join());
    const selection = { ...f.options, registrationIds: producers.map(item => item.registrationId), ownershipDigest: preview.ownership_digest! };
    const prepared = prepareOwnedDisposableArtifactRetirement({ ...selection, confirmed: true });
    assert.equal(prepared.status, 'PENDING', prepared.errors.join());
    const journal = prepared.journal_path!, directory = journal.replace(/\.json$/u, '.progress');
    const read = () => readOwnedDisposableArtifactRecoverySnapshot(selection);
    const payload = path.join(f.targetRoot, read().progress.authority.intent.roots[0].path);
    const key = path.join(f.runtime, 'disposable-producers', '.authority-key');
    const protectedFiles = [...producers.map(item => item.ownerPath), journal, key,
        path.join(f.runtime, 'task-ledger', `${taskId}.json`)];
    const hashes = () => protectedFiles.map(file => [file, computeFileSha256(file)]);
    function frames() { return fs.existsSync(directory) ? fs.readdirSync(directory).sort().map(name => [name, computeFileSha256(path.join(directory, name))]) : []; }
    function payloadHashes() {
        const result: string[][] = [];
        function collect(candidate: string) {
            if (!fs.existsSync(candidate)) return;
            if (fs.lstatSync(candidate).isDirectory()) for (const name of fs.readdirSync(candidate)) collect(path.join(candidate, name));
            else result.push([candidate, computeFileSha256(candidate)]);
        }
        for (const producer of producers) collect(producer.payloadPath);
        return result.sort((left, right) => left[0].localeCompare(right[0]));
    }
    function prefix(removed: number, pending: 'none' | 'present' | 'absent' | 'error' = 'none') {
        withOwnedDisposableRetirementMutation({ ...selection, confirmed: true }, mutation => {
            for (let index = 0; index < removed; index += 1) {
                const entry = mutation.pending(); assert.ok(entry);
                removeBoundContainedPath(entry.binding, false, () => {
                    fsyncDirectoryBestEffort(path.dirname(entry.binding.path)); mutation.removed();
                });
            }
            if (pending !== 'none') {
                const entry = mutation.pending(); assert.ok(entry);
                if (pending === 'absent') removeBoundContainedPath(entry.binding, false);
                if (pending === 'error') mutation.fail('controlled original failure');
            }
        });
    }
    const run = <T>(action: (mutation: OwnedDisposableRecoveryMutation) => T) =>
        withOwnedDisposableRecoveryMutation({ ...selection, confirmed: true }, action);
    function removeCurrent(mutation: OwnedDisposableRecoveryMutation) {
        const entry = mutation.pending(); assert.ok(entry);
        removeBoundContainedPath(entry.binding, false, () => {
            fsyncDirectoryBestEffort(path.dirname(entry.binding.path)); mutation.removed();
        });
    }
    function signFixtureFrame(record: Record<string, unknown>) {
        const unsigned = Object.fromEntries(['schema_version', 'kind', 'prepared_at_utc', 'journal_creation_identity', 'progress']
            .map(name => [name, record[name]]));
        record.authentication_sha256 = createHmac('sha256', fs.readFileSync(key))
            .update(JSON.stringify({ domain: 'garda.owned-disposable-retirement-progress.v1', record: unsigned })).digest('hex');
    }
    // Test-only malformed producer output with valid native purpose/signature and unchanged creation identity.
    function rewriteLast(change: (progress: Record<string, unknown>) => void) {
        const file = path.join(directory, fs.readdirSync(directory).sort().at(-1)!);
        const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        change(record.progress as Record<string, unknown>); signFixtureFrame(record);
        fs.writeFileSync(file, JSON.stringify(record) + '\n');
        return readOwnedDisposableRetirementProgress(selection);
    }
    // Fixture-only historical frames: real files, current time, genuine creation identities and native authentication.
    // The production gateway still exercises the final admitted attempt and the first rejected attempt.
    function seedRetryHistory(attempts: number) {
        const initial = fs.readdirSync(directory).sort(); assert.equal(initial.length, 2);
        const templates = initial.map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
        assert.deepEqual(templates.map(record => record.progress.event), ['RESUMED', 'ERROR']);
        let sequence = 2, previous = computeFileSha256(path.join(directory, initial[1]));
        for (let attempt = 2; attempt <= attempts; attempt += 1) for (const template of templates) {
            const file = path.join(directory, `${String(sequence).padStart(8, '0')}.json`);
            const descriptor = fs.openSync(file, 'wx');
            try {
                const stat = lstatFileIdentitySync(file, { bigint: true });
                assert.ok(stat.birthtimeNs > 0n);
                const record = { ...template, prepared_at_utc: new Date().toISOString(),
                    journal_creation_identity: scratchSha256(JSON.stringify([
                        scratchBindingIdentity(bindContainedDestination(f.targetRoot, directory)), file,
                        ...[stat.dev, stat.ino, stat.mode, stat.birthtimeNs].map(String)])),
                    progress: { ...template.progress, sequence, previous_sha256: previous, resume_attempt: attempt } };
                signFixtureFrame(record); fs.writeSync(descriptor, JSON.stringify(record) + '\n'); fs.fsyncSync(descriptor);
            } finally { fs.closeSync(descriptor); }
            previous = computeFileSha256(file); sequence += 1;
        }
        fsyncDirectoryBestEffort(directory);
        assert.equal(read().progress.resume_attempt_count, attempts);
    }
    return { ...f, selection, read, run, prefix, removeCurrent, journal, directory, key, note, payload,
        alpha: path.join(payload, 'alpha.txt'), binary: path.join(payload, 'nested', 'bytes.bin'), hashes, frames, payloadHashes,
        rewriteLast, seedRetryHistory };
}

test('native metadata recovery starts one signed attempt without removing any payload or replacing retained authority', t => {
    const f = owned(t), authority = f.hashes(), payload = f.payloadHashes();
    f.run(mutation => mutation.check());
    const snapshot = f.read();
    assert.equal(snapshot.progress.resume_attempt_count, 1); assert.equal(snapshot.progress.status, 'UNSTARTED');
    assert.equal(snapshot.progress.retired_member_count, 0); assert.equal(snapshot.progress.known_removed_bytes, 0);
    assert.equal(snapshot.progress.reconciled_bytes, 0); assert.equal(snapshot.absence_authorized, false);
    assert.equal(snapshot.progress.frames.length, 1); assert.deepEqual(f.hashes(), authority); assert.deepEqual(f.payloadHashes(), payload);
});

test('legacy partial and present pending progress continue with an exact current removal and unchanged historic frames', t => {
    const f = owned(t); f.prefix(1, 'present'); const old = f.frames(), authority = f.hashes();
    f.run(mutation => f.removeCurrent(mutation));
    const progress = f.read().progress;
    assert.equal(progress.retired_member_count, 2); assert.equal(progress.known_removed_file_count, 2);
    assert.equal(progress.known_removed_bytes, 7); assert.equal(progress.reconciled_member_count, 0);
    assert.equal(progress.resume_attempt_count, 1); assert.deepEqual(f.frames().slice(0, old.length), old);
    assert.deepEqual(f.hashes(), authority); assert.equal(fs.existsSync(f.binary), false);
});

test('legacy error reopens only through a signed resume transition and preserves its unresolved present member', t => {
    const f = owned(t); f.prefix(0, 'error'); const old = f.frames();
    f.run(mutation => f.removeCurrent(mutation));
    const progress = f.read().progress;
    assert.equal(progress.status, 'PARTIAL'); assert.equal(progress.last_error, null);
    assert.equal(progress.known_removed_bytes, 3); assert.equal(progress.resume_attempt_count, 1);
    assert.deepEqual(f.frames().slice(0, old.length), old); assert.equal(fs.existsSync(f.alpha), false);
});

test('historic signed pending absence cannot become current removal and is recorded in separate reconciliation counters', t => {
    const f = owned(t); f.prefix(0, 'absent');
    assert.throws(() => f.run(mutation => mutation.removed()), /issued member and exact pending absence/u);
    assert.throws(() => f.run(mutation => mutation.pending()), /explicit reconciliation/u);
    f.run(mutation => mutation.reconcilePending());
    const progress = f.read().progress;
    assert.equal(progress.known_removed_member_count, 0); assert.equal(progress.known_removed_bytes, 0);
    assert.equal(progress.reconciled_member_count, 1); assert.equal(progress.reconciled_file_count, 1);
    assert.equal(progress.reconciled_bytes, 3); assert.equal(progress.retired_member_count, 1);
    assert.equal(f.read().remaining_bytes, 4); assert.equal(progress.pending_member_path, null);
});

test('exact signed pending root absence reconciles without falsely increasing known file or byte removals', t => {
    const f = owned(t); f.prefix(3, 'absent'); const authority = f.hashes();
    f.run(mutation => { mutation.reconcilePending(); mutation.finish(); });
    const progress = f.read().progress;
    assert.equal(progress.status, 'FINISHED'); assert.equal(progress.retired_member_count, 4);
    assert.equal(progress.known_removed_member_count, 3); assert.equal(progress.known_removed_file_count, 2);
    assert.equal(progress.known_removed_bytes, 7); assert.equal(progress.reconciled_member_count, 1);
    assert.equal(progress.reconciled_file_count, 0); assert.equal(progress.reconciled_bytes, 0);
    assert.equal(fs.existsSync(f.payload), false); assert.deepEqual(f.hashes(), authority);
});

test('native metadata continuation spans an absent first root and the exact retained next root', t => {
    const f = owned(t, 2); f.prefix(4); const authority = f.hashes();
    f.run(mutation => f.removeCurrent(mutation));
    const snapshot = f.read();
    assert.equal(snapshot.progress.retired_member_count, 5); assert.equal(snapshot.progress.known_removed_file_count, 3);
    assert.equal(snapshot.roots[0].entries.length, 0); assert.equal(snapshot.remaining_file_count, 1);
    assert.equal(snapshot.progress.reconciled_member_count, 0); assert.deepEqual(f.hashes(), authority);
});

test('finished legacy history stays terminal and metadata finish inspection adds no frame or retained authority write', t => {
    const f = owned(t), result = removeOwnedDisposableArtifacts({ ...f.selection, confirmed: true });
    assert.equal(result.status, 'REMOVED', result.errors.join());
    const old = f.frames(), authority = f.hashes(); f.run(mutation => mutation.finish());
    assert.equal(f.read().progress.status, 'FINISHED'); assert.equal(f.read().progress.resume_attempt_count, 0);
    assert.deepEqual(f.frames(), old); assert.deepEqual(f.hashes(), authority); assert.equal(fs.existsSync(f.payload), false);
});

test('new native recovery failure retains exact pending payload and can reopen in a later bounded attempt', t => {
    const f = owned(t), payload = f.payloadHashes();
    f.run(mutation => { mutation.pending(); mutation.fail('controlled new failure'); });
    assert.equal(f.read().progress.status, 'ERROR'); assert.equal(f.read().progress.known_removed_bytes, 0);
    assert.deepEqual(f.payloadHashes(), payload);
    f.run(mutation => f.removeCurrent(mutation));
    assert.equal(f.read().progress.status, 'PARTIAL'); assert.equal(f.read().progress.resume_attempt_count, 2);
    assert.equal(f.read().progress.known_removed_bytes, 3); assert.equal(f.read().progress.reconciled_bytes, 0);
});

test('native recovery rejects missing confirmation and caller records keys or snapshots before metadata publication', t => {
    const f = owned(t), before = f.payloadHashes(), authority = f.hashes();
    assert.throws(() => withOwnedDisposableRecoveryMutation({ ...f.selection, confirmed: false }, () => undefined), /explicit confirmation/u);
    assert.throws(() => withOwnedDisposableRecoveryMutation({ ...f.selection, confirmed: true, snapshot: f.read() } as never, () => undefined), /exact declared selection fields/u);
    assert.throws(() => withOwnedDisposableRecoveryMutation({ ...f.selection, confirmed: true, key: 'caller' } as never, () => undefined), /exact declared selection fields/u);
    assert.throws(() => withOwnedDisposableRecoveryMutation({ ...f.selection, confirmed: true, record: {} } as never, () => undefined), /exact declared selection fields/u);
    assert.equal(fs.existsSync(f.directory), false); assert.deepEqual(f.payloadHashes(), before); assert.deepEqual(f.hashes(), authority);
});

test('native recovery refuses unknown absence without signed pending authority and preserves remaining bytes', t => {
    const f = owned(t); assert.equal(f.read().remaining_bytes, 7); fs.unlinkSync(f.alpha); const before = f.payloadHashes();
    assert.throws(() => f.run(() => undefined), /unknown absence/u);
    assert.equal(fs.existsSync(f.directory), false); assert.deepEqual(f.payloadHashes(), before);
});

test('native recovery refuses replaced remaining file creation even when its bytes are identical', t => {
    const f = owned(t); assert.equal(f.read().remaining_bytes, 7); const bytes = fs.readFileSync(f.alpha);
    fs.renameSync(f.alpha, f.alpha + '.saved'); fs.writeFileSync(f.alpha, bytes); fs.unlinkSync(f.alpha + '.saved');
    const before = f.payloadHashes();
    assert.throws(() => f.run(() => undefined), /creation, stat identity or bytes changed/u);
    assert.equal(fs.existsSync(f.directory), false); assert.deepEqual(f.payloadHashes(), before);
});

test('native recovery refuses new remaining membership and preserves every original and added member', t => {
    const f = owned(t); assert.equal(f.read().remaining_bytes, 7); fs.writeFileSync(path.join(f.payload, 'new.txt'), 'retain');
    const before = f.payloadHashes();
    assert.throws(() => f.run(() => undefined), /unknown path/u);
    assert.deepEqual(f.payloadHashes(), before); assert.equal(fs.existsSync(f.directory), false);
});

test('native recovery refuses changed current dependency bytes before continuation', t => {
    const f = owned(t, 1, true); assert.equal(f.read().remaining_bytes, 7); fs.writeFileSync(f.note, '{"note":"changed"}\n');
    const before = f.payloadHashes(), authority = f.hashes();
    assert.throws(() => f.run(() => undefined), /original ownership digest differs/u);
    assert.deepEqual(f.payloadHashes(), before); assert.deepEqual(f.hashes(), authority);
});

test('native recovery refuses changed producer authority and leaves historic progress untouched', t => {
    const f = owned(t); f.prefix(1); assert.equal(f.read().progress.known_removed_bytes, 3);
    const old = f.frames(), before = f.payloadHashes(); fs.writeFileSync(f.key, Buffer.alloc(32, 0x39));
    assert.throws(() => f.run(() => undefined), {
        message: 'Compact retirement intent is malformed, foreign, replaced, tampered or stale; preserve journal and payload.'
    });
    assert.deepEqual(f.frames(), old); assert.deepEqual(f.payloadHashes(), before);
});

test('native recovery refuses native run drift rather than adopting a new producer generation', t => {
    const f = owned(t); assert.equal(f.read().remaining_bytes, 7);
    const mode = path.join(f.reviews, `${taskId}-task-mode.json`), data = JSON.parse(fs.readFileSync(mode, 'utf8'));
    fs.writeFileSync(mode, JSON.stringify({ ...data, task_summary: 'changed native run contract' }) + '\n');
    const before = f.payloadHashes();
    assert.throws(() => f.run(() => undefined), {
        message: 'Disposable registration does not match the canonical workspace, task, current native run or payload path.'
    });
    assert.deepEqual(f.payloadHashes(), before); assert.equal(fs.existsSync(f.directory), false);
});

test('native recovery preserves unknown interrupted progress metadata and refuses to append around it', t => {
    const f = owned(t); f.prefix(0, 'present'); assert.equal(f.read().progress.status, 'PENDING');
    const unknown = path.join(f.directory, '.interrupted.intent'); fs.writeFileSync(unknown, 'retain interrupted publication');
    const old = f.frames(), before = f.payloadHashes();
    assert.throws(() => f.run(() => undefined), /unknown, interrupted, missing or nonsequential metadata/u);
    assert.deepEqual(f.frames(), old); assert.deepEqual(f.payloadHashes(), before); assert.equal(fs.existsSync(unknown), true);
});

test('native recovery fails closed on an actual lifecycle lock generation change inside the callback', t => {
    const f = owned(t), before = f.payloadHashes();
    assert.throws(() => f.run(mutation => {
        fs.writeFileSync(path.join(getLifecycleOperationLockPath(f.targetRoot), 'owner.json'), '{"foreign":true}\n');
        mutation.pending();
    }), /lock|generation|owner/iu);
    assert.deepEqual(f.payloadHashes(), before);
    assert.equal(readOwnedDisposableArtifactRecoveryProgress(f.selection).known_removed_bytes, 0);
});

test('a returned recovery mutation handle expires and cannot append after native locks are released', t => {
    const f = owned(t), handle = f.run(mutation => mutation), before = f.frames();
    assert.throws(() => handle.pending(), /outside its native lock scope/u);
    assert.throws(() => handle.finish(), /outside its native lock scope/u);
    assert.deepEqual(f.frames(), before); assert.equal(f.read().progress.known_removed_bytes, 0);
});

test('native metadata publication detects an actual added progress member and retains the entire payload', t => {
    const f = owned(t), before = f.payloadHashes(), rename = rawFs.renameSync;
    t.after(() => { rawFs.renameSync = rename; });
    rawFs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
        if (String(destination) === path.join(f.directory, '00000001.json')) fs.writeFileSync(path.join(f.directory, '.foreign'), 'retain');
        return rename(source, destination);
    }) as typeof fs.renameSync;
    assert.throws(() => f.run(mutation => mutation.pending()), /unknown, interrupted, missing or nonsequential metadata/u);
    assert.deepEqual(f.payloadHashes(), before); assert.equal(fs.existsSync(path.join(f.directory, '.foreign')), true);
});

test('native metadata publication detects an actual payload byte change before exposing a current removal handle', t => {
    const f = owned(t), rename = rawFs.renameSync;
    assert.equal(f.read().remaining_bytes, 7); t.after(() => { rawFs.renameSync = rename; });
    rawFs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
        if (String(destination) === path.join(f.directory, '00000001.json')) fs.writeFileSync(f.alpha, 'retain changed bytes');
        return rename(source, destination);
    }) as typeof fs.renameSync;
    assert.throws(() => f.run(mutation => mutation.pending()), /changed|identity|inventory/iu);
    assert.equal(fs.readFileSync(f.alpha, 'utf8'), 'retain changed bytes'); assert.equal(fs.existsSync(f.binary), true);
});

test('native recovery rejects same-attempt reconciliation after a new pending member disappears before issue', t => {
    const f = owned(t), authority = f.hashes();
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
    let pendingFrames: string[][] = [];
    f.run(mutation => {
        assert.throws(() => mutation.pending(), /pending member disappeared before current mutation authorization/u);
        assert.equal(disappeared, true); assert.equal(mutation.inspect().progress.status, 'PENDING');
        pendingFrames = f.frames(); const remaining = f.payloadHashes();
        assert.throws(() => mutation.reconcilePending(), /unissued signed pending absence captured at resume/u);
        assert.deepEqual(f.frames(), pendingFrames); assert.deepEqual(f.payloadHashes(), remaining);
        assert.equal(mutation.inspect().progress.reconciled_member_count, 0);
        assert.equal(mutation.inspect().progress.known_removed_member_count, 0);
        mutation.fail('new pending member disappeared before issue');
    });
    assert.equal(f.read().progress.status, 'ERROR');
    f.run(mutation => mutation.reconcilePending());
    const progress = f.read().progress;
    assert.equal(progress.resume_attempt_count, 2); assert.equal(progress.reconciled_bytes, 3);
    assert.equal(progress.known_removed_bytes, 0); assert.equal(f.read().remaining_bytes, 4);
    assert.deepEqual(f.frames().slice(0, pendingFrames.length), pendingFrames); assert.deepEqual(f.hashes(), authority);
});

test('bounded native authenticated resume history accepts the last attempt and rejects an additional attempt without writes', t => {
    const f = owned(t), before = f.payloadHashes();
    f.run(mutation => mutation.fail('controlled retry'));
    f.seedRetryHistory(OWNED_DISPOSABLE_RECOVERY_MAX_ATTEMPTS - 1);
    const historic = f.frames(); f.run(mutation => mutation.fail('controlled final retry'));
    assert.equal(f.read().progress.resume_attempt_count, 64); assert.equal(f.read().progress.known_removed_bytes, 0);
    assert.deepEqual(f.frames().slice(0, historic.length), historic);
    const old = f.frames(), authority = f.hashes();
    assert.throws(() => f.run(() => undefined), /resume attempt allowance/u);
    assert.deepEqual(f.frames(), old); assert.deepEqual(f.hashes(), authority); assert.deepEqual(f.payloadHashes(), before);
});

test('native transport rejects excess selected-inventory progress allowance before reading or deleting any frame', t => {
    const f = owned(t), before = f.payloadHashes();
    const allowance = f.read().progress.order.length * 2 + OWNED_DISPOSABLE_RECOVERY_MAX_ATTEMPTS * 2 + 2;
    fs.mkdirSync(f.directory);
    for (let index = 0; index <= allowance; index += 1) {
        fs.writeFileSync(path.join(f.directory, `${String(index).padStart(8, '0')}.json`), 'retain unread invalid metadata\n');
    }
    const frames = f.frames(), open = rawFs.openSync; let frameReads = 0;
    t.mock.method(rawFs, 'openSync', (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (String(file).startsWith(f.directory + path.sep)) frameReads += 1;
        return open(file, flags, mode);
    });
    assert.throws(() => readOwnedDisposableRetirementProgress(f.selection), /allowance|bounded|budget|exceed/u);
    assert.equal(frameReads, 0); assert.deepEqual(f.frames(), frames); assert.deepEqual(f.payloadHashes(), before);
});

test('authenticated extended frame rejects dishonest reconciliation counts after native signature admission', t => {
    const f = owned(t); f.prefix(0, 'absent'); f.run(mutation => mutation.reconcilePending());
    assert.equal(f.read().progress.reconciled_member_count, 1);
    const transport = f.rewriteLast(progress => { progress.reconciled_member_count = 2; });
    assert.equal((transport.frames.at(-1)!.record.progress as Record<string, unknown>).reconciled_member_count, 2);
    const old = f.frames(), before = f.payloadHashes();
    assert.throws(() => f.run(() => undefined), /counters do not equal/u);
    assert.deepEqual(f.frames(), old); assert.deepEqual(f.payloadHashes(), before);
});

test('authenticated extended resume rejects a skipped attempt number after native signature admission', t => {
    const f = owned(t); f.run(mutation => mutation.check()); assert.equal(f.read().progress.resume_attempt_count, 1);
    const transport = f.rewriteLast(progress => { progress.resume_attempt = 2; });
    assert.equal((transport.frames.at(-1)!.record.progress as Record<string, unknown>).resume_attempt, 2);
    const old = f.frames(), before = f.payloadHashes();
    assert.throws(() => f.run(() => undefined), /counters do not equal/u);
    assert.deepEqual(f.frames(), old); assert.deepEqual(f.payloadHashes(), before);
});

test('authenticated reconciliation cannot replace a current pending removal created after resume', t => {
    const f = owned(t); f.run(mutation => f.removeCurrent(mutation)); assert.equal(f.read().progress.known_removed_bytes, 3);
    const transport = f.rewriteLast(progress => {
        Object.assign(progress, { event: 'RECONCILED', removed_member_count: 0, removed_file_count: 0, removed_bytes: 0,
            reconciled_member_count: 1, reconciled_file_count: 1, reconciled_bytes: 3 });
    });
    assert.equal((transport.frames.at(-1)!.record.progress as Record<string, unknown>).event, 'RECONCILED');
    const old = f.frames(), before = f.payloadHashes();
    assert.throws(() => f.run(() => undefined), /removed member lacks its exact pending record or signed parent identity/u);
    assert.deepEqual(f.frames(), old); assert.deepEqual(f.payloadHashes(), before);
});

test('authenticated extended history refuses a legacy schema downgrade after resume', t => {
    const f = owned(t); f.run(mutation => mutation.pending()); assert.equal(f.read().progress.status, 'PENDING');
    const transport = f.rewriteLast(progress => {
        for (const field of ['resume_version', 'resume_attempt', 'reconciled_member_count', 'reconciled_file_count', 'reconciled_bytes']) delete progress[field];
    });
    assert.equal(Object.hasOwn(transport.frames.at(-1)!.record.progress as object, 'resume_version'), false);
    const old = f.frames(), before = f.payloadHashes();
    assert.throws(() => f.run(() => undefined), /unsupported schema, chain, order or settled-state transition/u);
    assert.deepEqual(f.frames(), old); assert.deepEqual(f.payloadHashes(), before);
});
