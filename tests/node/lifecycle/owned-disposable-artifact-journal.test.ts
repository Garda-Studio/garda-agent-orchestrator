import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { prepareOwnedDisposableArtifactRetirement, inspectOwnedDisposableArtifactRetirement } from '../../../src/lifecycle/cleanup';
import { OWNED_DISPOSABLE_PREVIEW_LIMITS } from '../../../src/lifecycle/cleanup/owned-disposable-artifact-preview-contracts';
import { getLifecycleOperationLockPath } from '../../../src/lifecycle/lock/lifecycle-lock';
import { computeFileSha256 } from '../gates/task-audit/task-audit-summary-fixtures';
import { fixture, taskId } from './owned-disposable-artifact-fixtures';

const rawFs = require('node:fs') as typeof fs;

function ownedFixture(t: TestContext) {
    const f = fixture(t), owned = f.produce(), preview = f.preview(owned.registrationId);
    assert.equal(preview.status, 'READY', preview.blockers.join());
    const selection = { ...f.options, registrationIds: [owned.registrationId], ownershipDigest: preview.ownership_digest! };
    const protectedFiles = [owned.ownerPath, path.join(owned.payloadPath, 'alpha.txt'),
        path.join(owned.payloadPath, 'nested', 'bytes.bin'), path.join(f.runtime, 'task-ledger', `${taskId}.json`),
        path.join(f.runtime, 'disposable-producers', '.authority-key')];
    const journalDirectory = path.join(f.runtime, 'disposable-producers', 'retirements', taskId);
    const hashes = () => protectedFiles.map(computeFileSha256);
    const before = hashes();
    const prepare = () => prepareOwnedDisposableArtifactRetirement({ ...selection, confirmed: true });
    return { ...f, owned, initialPreview: preview, selection, protectedFiles, journalDirectory, hashes, before, prepare };
}

test('compact intent binds real sealed ownership and readable ledger without copying or removing payload bytes', t => {
    const f = ownedFixture(t), sentinel = 'PRIVATE_PAYLOAD_SENTINEL_'.repeat(10_000);
    fs.writeFileSync(path.join(f.owned.payloadPath, 'alpha.txt'), sentinel);
    const preview = f.preview(f.owned.registrationId), selection = { ...f.selection, ownershipDigest: preview.ownership_digest! };
    const before = f.hashes(), result = prepareOwnedDisposableArtifactRetirement({ ...selection, confirmed: true });
    assert.equal(result.status, 'PENDING', result.errors.join()); assert.equal(result.created, true);
    assert.equal(result.metadata_mutation_attempted, true); assert.equal(result.file_count, 2);
    assert.equal(result.total_bytes, Buffer.byteLength(sentinel) + 4); assert.equal(result.ownership_digest, preview.ownership_digest);
    const text = fs.readFileSync(result.journal_path!, 'utf8'), journal = JSON.parse(text);
    assert.equal(text.includes(sentinel), false); assert.ok(Buffer.byteLength(text) < 10_000);
    assert.equal(journal.status, 'PENDING'); assert.equal(journal.intent.compact_evidence_sha256, preview.compact_evidence_sha256);
    assert.deepEqual(journal.intent.roots[0].inventory, preview.items[0].inventory);
    assert.match(journal.authentication_sha256, /^[0-9a-f]{64}$/u); assert.equal(fs.statSync(result.journal_path!).nlink, 1);
    assert.equal(inspectOwnedDisposableArtifactRetirement(selection).journal_sha256, result.journal_sha256);
    assert.deepEqual(f.hashes(), before); assert.equal(fs.readFileSync(path.join(f.owned.payloadPath, 'alpha.txt'), 'utf8'), sentinel);
    assert.equal(JSON.parse(fs.readFileSync(f.protectedFiles[3], 'utf8')).verification.status, 'VERIFIED');
});

test('repeated preparation and read-only inspection retain the same ordinary compact intent', t => {
    const f = ownedFixture(t), first = f.prepare(), identity = fs.statSync(first.journal_path!, { bigint: true });
    const second = f.prepare(), inspected = inspectOwnedDisposableArtifactRetirement(f.selection);
    assert.equal(first.status, 'PENDING', first.errors.join()); assert.equal(second.status, 'PENDING', second.errors.join());
    assert.equal(second.created, false); assert.equal(second.metadata_mutation_attempted, false);
    assert.equal(second.journal_sha256, first.journal_sha256); assert.equal(inspected.status, 'PENDING');
    assert.equal(inspected.metadata_mutation_attempted, false); assert.equal(inspected.journal_sha256, first.journal_sha256);
    assert.equal(fs.statSync(first.journal_path!, { bigint: true }).ino, identity.ino);
    assert.deepEqual(f.hashes(), f.before);
});

test('unconfirmed intent performs no metadata publication and preserves native evidence', t => {
    const f = ownedFixture(t), result = prepareOwnedDisposableArtifactRetirement({ ...f.selection, confirmed: false });
    assert.equal(result.status, 'CONFIRMATION_REQUIRED'); assert.equal(result.metadata_mutation_attempted, false);
    assert.equal(result.journal_path, null); assert.equal(fs.existsSync(f.journalDirectory), false);
    assert.deepEqual(f.hashes(), f.before);
});

test('stale confirmed preview cannot publish an intent for changed payload bytes', t => {
    const f = ownedFixture(t); fs.writeFileSync(path.join(f.owned.payloadPath, 'alpha.txt'), 'changed retained payload');
    const before = f.hashes(), result = f.prepare();
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.metadata_mutation_attempted, false);
    assert.equal(fs.existsSync(f.journalDirectory), false); assert.deepEqual(f.hashes(), before);
});

test('rejects caller-authored proof and sparse registration selection without creating compact authority', t => {
    const f = ownedFixture(t), callerProof = prepareOwnedDisposableArtifactRetirement({ ...f.selection, confirmed: true,
        snapshot: { eligible: true, owner: f.owned } } as never);
    const sparse = prepareOwnedDisposableArtifactRetirement({ ...f.selection, confirmed: true, registrationIds: new Array<string>(1) });
    assert.equal(callerProof.status, 'BLOCKED'); assert.equal(sparse.status, 'BLOCKED');
    assert.equal(callerProof.metadata_mutation_attempted, false); assert.equal(sparse.metadata_mutation_attempted, false);
    assert.equal(fs.existsSync(f.journalDirectory), false); assert.deepEqual(f.hashes(), f.before);
});

test('tampered intent is rejected without overwriting journal or protected evidence', t => {
    const f = ownedFixture(t), first = f.prepare(), journal = JSON.parse(fs.readFileSync(first.journal_path!, 'utf8'));
    journal.intent.total_bytes = 0; fs.writeFileSync(first.journal_path!, JSON.stringify(journal));
    const tampered = computeFileSha256(first.journal_path!), inspected = inspectOwnedDisposableArtifactRetirement(f.selection), repeated = f.prepare();
    assert.equal(inspected.status, 'BLOCKED'); assert.equal(repeated.status, 'BLOCKED');
    assert.equal(repeated.metadata_mutation_attempted, false); assert.equal(computeFileSha256(first.journal_path!), tampered);
    assert.deepEqual(f.hashes(), f.before);
});

test('rejects copied authentic journal bytes with a replacement file identity', t => {
    const f = ownedFixture(t), first = f.prepare(), original = fs.readFileSync(first.journal_path!);
    fs.renameSync(first.journal_path!, first.journal_path! + '.preserved'); fs.writeFileSync(first.journal_path!, original);
    const before = computeFileSha256(first.journal_path!), inspected = inspectOwnedDisposableArtifactRetirement(f.selection), repeated = f.prepare();
    assert.equal(inspected.status, 'BLOCKED'); assert.equal(repeated.status, 'BLOCKED');
    assert.equal(fs.existsSync(first.journal_path! + '.preserved'), true); assert.equal(computeFileSha256(first.journal_path!), before);
    assert.deepEqual(f.hashes(), f.before);
});

test('linked journal storage cannot write into a foreign directory', t => {
    const f = ownedFixture(t), foreign = path.join(f.targetRoot, 'foreign-metadata'); fs.mkdirSync(foreign);
    fs.symlinkSync(foreign, path.join(f.runtime, 'disposable-producers', 'retirements'), 'dir');
    const result = f.prepare();
    assert.equal(result.status, 'BLOCKED'); assert.deepEqual(fs.readdirSync(foreign), []);
    assert.equal(result.created, false); assert.deepEqual(f.hashes(), f.before);
});

test('rejects shared journal objects without republishing protected metadata', t => {
    const f = ownedFixture(t), first = f.prepare(); fs.linkSync(first.journal_path!, path.join(f.targetRoot, 'shared-journal.json'));
    const before = computeFileSha256(first.journal_path!), inspected = inspectOwnedDisposableArtifactRetirement(f.selection), repeated = f.prepare();
    assert.equal(inspected.status, 'BLOCKED'); assert.equal(repeated.status, 'BLOCKED');
    assert.equal(fs.statSync(first.journal_path!).nlink, 2); assert.equal(computeFileSha256(first.journal_path!), before);
    assert.deepEqual(f.hashes(), f.before);
});

test('oversized persisted journal is rejected before a captured read or overwrite', t => {
    const f = ownedFixture(t), first = f.prepare(); fs.writeFileSync(first.journal_path!, Buffer.alloc(OWNED_DISPOSABLE_PREVIEW_LIMITS.metadataBytes + 1, 0x20));
    const before = computeFileSha256(first.journal_path!), inspected = inspectOwnedDisposableArtifactRetirement(f.selection), repeated = f.prepare();
    assert.equal(inspected.status, 'BLOCKED'); assert.equal(repeated.status, 'BLOCKED');
    assert.equal(repeated.metadata_mutation_attempted, false); assert.equal(computeFileSha256(first.journal_path!), before);
    assert.deepEqual(f.hashes(), f.before);
});

test('missing producer authority is never recreated for compact intent', t => {
    const f = ownedFixture(t), key = f.protectedFiles.pop()!; fs.unlinkSync(key);
    const before = f.hashes(), result = f.prepare();
    assert.equal(result.status, 'BLOCKED'); assert.equal(fs.existsSync(key), false);
    assert.equal(fs.existsSync(f.journalDirectory), false); assert.deepEqual(f.hashes(), before);
});

test('changed WIP authority blocks compact intent and preserves recovery evidence', t => {
    const f = ownedFixture(t), wip = path.join(f.runtime, 'wip', 'T-OTHER'); fs.mkdirSync(wip, { recursive: true });
    const recovery = path.join(wip, 'manifest.json'); fs.writeFileSync(recovery, JSON.stringify({ source_task_id: taskId }));
    const before = computeFileSha256(recovery), result = f.prepare();
    assert.equal(result.status, 'BLOCKED'); assert.equal(fs.existsSync(f.journalDirectory), false);
    assert.equal(computeFileSha256(recovery), before); assert.deepEqual(f.hashes(), f.before);
});

function afterIntentWrite(t: TestContext, action: () => void): void {
    const write = rawFs.writeFileSync;
    let injected = false;
    t.mock.method(rawFs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
        write(...args);
        if (!injected && typeof args[0] === 'number' && String(args[1]).includes('"kind":"owned_disposable_artifact_retirement_intent"')) {
            injected = true; action();
        }
    });
}

test('lifecycle lock loss blocks journal publication and preserves payload and native ledger', t => {
    const f = ownedFixture(t);
    afterIntentWrite(t, () => {
        const owner = path.join(getLifecycleOperationLockPath(f.targetRoot), 'owner.json');
        const metadata = JSON.parse(fs.readFileSync(owner, 'utf8')); metadata.lock_id = 'foreign-lifecycle-generation';
        fs.writeFileSync(owner, JSON.stringify(metadata));
    });
    const result = f.prepare();
    assert.equal(result.status, 'BLOCKED'); assert.match(result.errors.join(), /Lifecycle lock generation/u);
    assert.equal(fs.existsSync(result.journal_path!), false); assert.deepEqual(f.hashes(), f.before);
});

test('writer lock loss blocks journal publication and preserves payload and native ledger', t => {
    const f = ownedFixture(t);
    afterIntentWrite(t, () => {
        const owner = path.join(f.runtime, '.scratch-writers.lock', 'owner.json');
        const metadata = JSON.parse(fs.readFileSync(owner, 'utf8')); metadata.lock_id = 'foreign-writer-generation';
        fs.writeFileSync(owner, JSON.stringify(metadata));
    });
    const result = f.prepare();
    assert.equal(result.status, 'BLOCKED'); assert.match(result.errors.join(), /writer lock ownership changed/u);
    assert.equal(fs.existsSync(result.journal_path!), false); assert.deepEqual(f.hashes(), f.before);
});

test('payload drift during journal preparation blocks publication and retains changed data', t => {
    const f = ownedFixture(t), raw = path.join(f.owned.payloadPath, 'alpha.txt');
    afterIntentWrite(t, () => fs.writeFileSync(raw, 'changed during compact preparation'));
    const result = f.prepare();
    assert.equal(result.status, 'BLOCKED'); assert.match(result.errors.join(), /changed/u);
    assert.equal(fs.existsSync(result.journal_path!), false); assert.equal(fs.readFileSync(raw, 'utf8'), 'changed during compact preparation');
    assert.equal(computeFileSha256(f.owned.ownerPath), f.before[0]); assert.equal(computeFileSha256(f.protectedFiles[3]), f.before[3]);
});

test('metadata fsync failure prevents publication and leaves payload and compact history intact', t => {
    const f = ownedFixture(t), sync = rawFs.fsyncSync;
    let wroteIntent = false;
    afterIntentWrite(t, () => { wroteIntent = true; });
    t.mock.method(rawFs, 'fsyncSync', (descriptor: number) => {
        if (wroteIntent && fs.fstatSync(descriptor).isFile()) {
            wroteIntent = false; throw new Error('injected compact metadata fsync failure');
        }
        sync(descriptor);
    });
    const result = f.prepare();
    assert.equal(result.status, 'BLOCKED'); assert.match(result.errors.join(), /fsync failure/u);
    assert.equal(fs.existsSync(result.journal_path!), false); assert.deepEqual(f.hashes(), f.before);
});

test('rejects copied producer records masquerading as a signed retirement journal', t => {
    const f = ownedFixture(t), first = f.prepare(); fs.writeFileSync(first.journal_path!, fs.readFileSync(f.owned.ownerPath));
    const before = computeFileSha256(first.journal_path!), result = inspectOwnedDisposableArtifactRetirement(f.selection);
    assert.equal(result.status, 'BLOCKED'); assert.equal(computeFileSha256(first.journal_path!), before);
    assert.deepEqual(f.hashes(), f.before);
});
