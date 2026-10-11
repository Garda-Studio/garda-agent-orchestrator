import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac } from 'node:crypto';
import { removeOwnedDisposableArtifacts } from '../../../src/lifecycle/cleanup';
import { getLifecycleOperationLockPath } from '../../../src/lifecycle/lock/lifecycle-lock';
import { computeFileSha256 } from '../gates/task-audit/task-audit-summary-fixtures';
import { fixture, taskId } from './owned-disposable-artifact-fixtures';

const rawFs = require('node:fs') as typeof fs;

function ownedFixture(t: TestContext) {
    const f = fixture(t), owned = f.produce(), preview = f.preview(owned.registrationId);
    assert.equal(preview.status, 'READY', preview.blockers.join());
    const selection = { ...f.options, registrationIds: [owned.registrationId], ownershipDigest: preview.ownership_digest! };
    const alpha = path.join(owned.payloadPath, 'alpha.txt'), binary = path.join(owned.payloadPath, 'nested', 'bytes.bin');
    const ledger = path.join(f.runtime, 'task-ledger', `${taskId}.json`), key = path.join(f.runtime, 'disposable-producers', '.authority-key');
    const authorityBefore = [owned.ownerPath, ledger, key].map(computeFileSha256);
    const apply = () => removeOwnedDisposableArtifacts({ ...selection, confirmed: true });
    const payloadHashes = () => [alpha, binary].map(computeFileSha256);
    return { ...f, owned, initialPreview: preview, selection, alpha, binary, ledger, key, authorityBefore, apply, payloadHashes };
}

function afterFirstPending(t: TestContext, action: () => void): void {
    const rename = rawFs.renameSync;
    let invoked = false;
    t.mock.method(rawFs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        rename(from, to);
        if (!invoked && String(to).endsWith(`${path.sep}00000000.json`) && String(to).includes('.progress')) {
            invoked = true; action();
        }
    });
}

function progressFrames(directory: string) {
    return fs.readdirSync(directory).sort().filter(name => /^\d{8}\.json$/u.test(name))
        .map(name => ({ path: path.join(directory, name), record: JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) }));
}

test('confirmed apply removes exactly the preview members and bytes while retaining readable authenticated compact history', t => {
    const f = ownedFixture(t), second = f.produce(), preview = f.preview(f.owned.registrationId, second.registrationId);
    const touched: string[] = [], unlink = rawFs.unlinkSync, rmdir = rawFs.rmdirSync;
    t.mock.method(rawFs, 'unlinkSync', (candidate: fs.PathLike) => {
        if (preview.items.some(item => String(candidate).startsWith(path.join(f.targetRoot, item.path!) + path.sep))) touched.push(String(candidate));
        unlink(candidate);
    });
    t.mock.method(rawFs, 'rmdirSync', (candidate: fs.PathLike, options?: fs.RmDirOptions) => {
        assert.ok(!options?.recursive);
        if (preview.items.some(item => String(candidate).startsWith(path.join(f.targetRoot, item.path!)))) touched.push(String(candidate));
        rmdir(candidate, options);
    });
    const result = removeOwnedDisposableArtifacts({ ...f.options, registrationIds: [second.registrationId, f.owned.registrationId],
        ownershipDigest: preview.ownership_digest!, confirmed: true });
    assert.equal(result.status, 'REMOVED', result.errors.join()); assert.equal(result.counts_complete, true);
    assert.equal(result.removed_file_count, preview.file_count); assert.equal(result.removed_bytes, preview.total_bytes);
    assert.deepEqual(result.removed_roots.sort(), preview.items.map(item => item.path!).sort());
    assert.deepEqual(touched.sort(), preview.items.flatMap(item => item.inventory.map(entry => path.join(f.targetRoot, entry.path))).sort());
    assert.equal(fs.existsSync(f.owned.payloadPath), false); assert.equal(fs.existsSync(second.payloadPath), false);
    assert.deepEqual([f.owned.ownerPath, f.ledger, f.key].map(computeFileSha256), f.authorityBefore);
    assert.equal(JSON.parse(fs.readFileSync(f.ledger, 'utf8')).verification.status, 'VERIFIED');
    const intent = JSON.parse(fs.readFileSync(result.journal_path!, 'utf8')), frames = progressFrames(result.progress_directory!);
    assert.equal(intent.status, 'PENDING'); assert.equal(intent.intent.file_count, preview.file_count);
    assert.equal(intent.intent.total_bytes, result.removed_bytes); assert.equal(intent.intent.compact_evidence_sha256, preview.compact_evidence_sha256);
    assert.equal(frames.length, touched.length * 2 + 1); assert.equal(frames.at(-1)!.record.progress.event, 'FINISHED');
    assert.equal(frames.at(-1)!.record.progress.removed_bytes, preview.total_bytes);
    for (let index = 0; index < frames.length; index += 1) {
        const { record } = frames[index], keys = ['schema_version', 'kind', 'prepared_at_utc', 'journal_creation_identity', 'progress'];
        const unsigned = Object.fromEntries(keys.map(key => [key, record[key]]));
        const signature = createHmac('sha256', fs.readFileSync(f.key)).update(JSON.stringify({
            domain: 'garda.owned-disposable-retirement-progress.v1', record: unsigned })).digest('hex');
        assert.equal(record.authentication_sha256, signature); assert.equal(record.progress.sequence, index);
        assert.equal(record.progress.previous_sha256, index ? computeFileSha256(frames[index - 1].path) : null);
        assert.equal(record.progress.intent_sha256, result.journal_sha256);
        assert.equal(fs.statSync(frames[index].path).nlink, 1);
        if (record.progress.event === 'PENDING') assert.equal(frames[index + 1].record.progress.event, 'REMOVED');
    }
});

test('unconfirmed apply blocks payload removal and compact metadata publication', t => {
    const f = ownedFixture(t), before = f.payloadHashes();
    const result = removeOwnedDisposableArtifacts({ ...f.selection, confirmed: false });
    assert.equal(result.status, 'CONFIRMATION_REQUIRED'); assert.equal(result.mutation_attempted, false);
    assert.equal(result.journal_path, null); assert.deepEqual(f.payloadHashes(), before);
    assert.equal(fs.existsSync(path.join(f.runtime, 'disposable-producers', 'retirements')), false);
});

test('stale digest blocks changed bytes and preserves all selected payload', t => {
    const f = ownedFixture(t); fs.writeFileSync(f.binary, 'changed binary');
    const before = f.payloadHashes(), result = f.apply();
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.mutation_attempted, false);
    assert.deepEqual(f.payloadHashes(), before); assert.equal(result.removed_bytes, 0);
});

test('caller snapshots and sparse registration selections are rejected without adopting deletion authority', t => {
    const f = ownedFixture(t), before = f.payloadHashes();
    const forged = removeOwnedDisposableArtifacts({ ...f.selection, confirmed: true, snapshot: f.initialPreview } as never);
    const sparse = removeOwnedDisposableArtifacts({ ...f.selection, confirmed: true, registrationIds: [, f.owned.registrationId] as never });
    assert.equal(forged.status, 'BLOCKED'); assert.equal(sparse.status, 'BLOCKED');
    assert.equal(forged.mutation_attempted, false); assert.equal(sparse.mutation_attempted, false);
    assert.deepEqual(f.payloadHashes(), before);
});

test('foreign existing progress is preserved and cannot be adopted or overwritten', t => {
    const f = ownedFixture(t), before = f.payloadHashes();
    const directory = path.join(f.runtime, 'disposable-producers', 'retirements', taskId, `${f.selection.ownershipDigest}.progress`);
    fs.mkdirSync(directory, { recursive: true });
    const unknown = path.join(directory, '00000000.json'); fs.writeFileSync(unknown, '{"foreign":true}\n');
    const hash = computeFileSha256(unknown), result = f.apply();
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.mutation_attempted, false);
    assert.equal(computeFileSha256(unknown), hash); assert.deepEqual(f.payloadHashes(), before);
});

test('changed owner after durable pending blocks every payload removal', t => {
    const f = ownedFixture(t), before = f.payloadHashes();
    afterFirstPending(t, () => fs.writeFileSync(f.owned.ownerPath, '{}\n'));
    const result = f.apply();
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.mutation_attempted, false);
    assert.deepEqual(f.payloadHashes(), before); assert.equal(result.removed_bytes, 0);
    assert.equal(progressFrames(result.progress_directory!)[0].record.progress.event, 'PENDING');
});

test('new WIP dependency after pending blocks apply and preserves recovery evidence', t => {
    const f = ownedFixture(t), before = f.payloadHashes(), recovery = path.join(f.runtime, 'wip', 'new-recovery.json');
    afterFirstPending(t, () => { fs.mkdirSync(path.dirname(recovery)); fs.writeFileSync(recovery, JSON.stringify({ task_id: taskId })); });
    const result = f.apply();
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.mutation_attempted, false);
    assert.deepEqual(f.payloadHashes(), before); assert.equal(JSON.parse(fs.readFileSync(recovery, 'utf8')).task_id, taskId);
});

test('new nested Git membership after pending blocks nonrecursive removal', t => {
    const f = ownedFixture(t), before = f.payloadHashes();
    afterFirstPending(t, () => fs.mkdirSync(path.join(f.owned.payloadPath, '.git')));
    const result = f.apply();
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.mutation_attempted, false);
    assert.deepEqual(f.payloadHashes(), before); assert.equal(fs.existsSync(path.join(f.owned.payloadPath, '.git')), true);
});

test('replaced root after pending blocks removal of both original and replacement payloads', t => {
    const f = ownedFixture(t), parked = `${f.owned.payloadPath}-preserved`, before = f.payloadHashes();
    afterFirstPending(t, () => {
        fs.renameSync(f.owned.payloadPath, parked); fs.mkdirSync(f.owned.payloadPath);
        fs.writeFileSync(path.join(f.owned.payloadPath, 'replacement.txt'), 'replacement');
    });
    const result = f.apply();
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.mutation_attempted, false);
    assert.deepEqual([path.join(parked, 'alpha.txt'), path.join(parked, 'nested', 'bytes.bin')].map(computeFileSha256), before);
    assert.equal(fs.readFileSync(path.join(f.owned.payloadPath, 'replacement.txt'), 'utf8'), 'replacement');
});

test('changed remaining file after one unlink blocks further removal and preserves pending progress', t => {
    const f = ownedFixture(t), unlink = rawFs.unlinkSync;
    t.mock.method(rawFs, 'unlinkSync', (candidate: fs.PathLike) => {
        unlink(candidate); if (String(candidate) === f.alpha) fs.writeFileSync(f.binary, 'remaining changed payload');
    });
    const result = f.apply();
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.counts_complete, false);
    assert.equal(result.removed_file_count, 1); assert.equal(result.removed_bytes, 3);
    assert.equal(fs.existsSync(f.alpha), false); assert.equal(fs.readFileSync(f.binary, 'utf8'), 'remaining changed payload');
    assert.equal(progressFrames(result.progress_directory!)[0].record.progress.event, 'PENDING');
});

test('unlink failure retains durable pending evidence and all remaining payload members', t => {
    const f = ownedFixture(t), before = f.payloadHashes(), unlink = rawFs.unlinkSync;
    t.mock.method(rawFs, 'unlinkSync', (candidate: fs.PathLike) => {
        if (String(candidate) === f.alpha) throw Object.assign(new Error('injected unlink failure'), { code: 'EACCES' });
        unlink(candidate);
    });
    const result = f.apply();
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.counts_complete, false);
    assert.equal(result.removed_bytes, 0); assert.equal(result.removed_file_count, 0); assert.deepEqual(f.payloadHashes(), before);
    assert.ok(result.errors.some(message => message.includes('injected unlink failure')));
    assert.equal(progressFrames(result.progress_directory!)[0].record.progress.event, 'PENDING');
});

test('progress fsync failure blocks deletion and retains interrupted compact metadata', t => {
    const f = ownedFixture(t), before = f.payloadHashes(), fsync = rawFs.fsyncSync, open = rawFs.openSync;
    let progressDescriptor: number | null = null, failed = false;
    t.mock.method(rawFs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        const descriptor = open(...args);
        if (String(args[0]).includes('.progress') && String(args[0]).includes('.intent-')) progressDescriptor = descriptor;
        return descriptor;
    });
    t.mock.method(rawFs, 'fsyncSync', (descriptor: number) => {
        if (!failed && descriptor === progressDescriptor) { failed = true; throw Object.assign(new Error('injected progress fsync failure'), { code: 'EIO' }); }
        fsync(descriptor);
    });
    const result = f.apply();
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.mutation_attempted, false);
    assert.deepEqual(f.payloadHashes(), before); assert.equal(result.removed_bytes, 0);
    assert.ok(fs.readdirSync(result.progress_directory!).some(name => name.includes('.intent-')));
});

test('lifecycle lock generation loss after pending blocks payload deletion', t => {
    const f = ownedFixture(t), before = f.payloadHashes();
    afterFirstPending(t, () => fs.writeFileSync(path.join(getLifecycleOperationLockPath(f.targetRoot), 'owner.json'), '{}\n'));
    const result = f.apply();
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.mutation_attempted, false);
    assert.deepEqual(f.payloadHashes(), before); assert.ok(result.errors.some(message => message.includes('lock generation changed')));
});

test('producer writer lock loss after pending blocks payload deletion', t => {
    const f = ownedFixture(t), before = f.payloadHashes();
    let injected = false;
    afterFirstPending(t, () => {
        const owner = path.join(f.runtime, '.scratch-writers.lock', 'owner.json');
        const metadata = JSON.parse(fs.readFileSync(owner, 'utf8'));
        metadata.lock_id = 'foreign-writer-generation';
        fs.writeFileSync(owner, JSON.stringify(metadata));
        injected = true;
    });
    const result = f.apply();
    assert.equal(injected, true);
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.mutation_attempted, false);
    assert.deepEqual(f.payloadHashes(), before);
    assert.equal(result.removed_file_count, 0); assert.equal(result.removed_bytes, 0);
    assert.match(result.errors.join('\n'), /writer lock ownership changed/u);
    assert.equal(progressFrames(result.progress_directory!)[0].record.progress.event, 'PENDING');
});

test('tampered earlier progress frame blocks the next member and preserves remaining selection', t => {
    const f = ownedFixture(t), rename = rawFs.renameSync;
    t.mock.method(rawFs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        rename(from, to);
        if (String(to).endsWith(`${path.sep}00000001.json`) && String(to).includes('.progress')) {
            fs.writeFileSync(path.join(path.dirname(String(to)), '00000000.json'), '{}\n');
        }
    });
    const result = f.apply();
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.counts_complete, false);
    assert.equal(result.removed_file_count, 1); assert.equal(result.removed_bytes, 3);
    assert.equal(fs.existsSync(f.alpha), false); assert.equal(fs.readFileSync(f.binary).length, 4);
});
