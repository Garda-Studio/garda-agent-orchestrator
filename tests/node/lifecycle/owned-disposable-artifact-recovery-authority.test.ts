import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac } from 'node:crypto';
import { bindContainedDestination } from '../../../src/core/contained-filesystem';
import { lstatFileIdentitySync } from '../../../src/core/file-stat';
import { prepareOwnedDisposableArtifactRetirement, removeOwnedDisposableArtifacts } from '../../../src/lifecycle/cleanup';
import { readOwnedDisposableRetirementIntent } from '../../../src/lifecycle/cleanup/owned-disposable-artifact-journal';
import { readOwnedDisposableArtifactRecoveryAuthority }
    from '../../../src/lifecycle/cleanup/owned-disposable-artifact-recovery-authority';
import { inspectOwnedDisposableArtifact, inspectOwnedDisposableArtifactOwner }
    from '../../../src/lifecycle/cleanup/owned-disposable-artifact-registration';
import { OWNED_DISPOSABLE_PREVIEW_LIMITS as LIMITS }
    from '../../../src/lifecycle/cleanup/owned-disposable-artifact-preview-contracts';
import { scratchBindingIdentity, scratchStatIdentity } from '../../../src/lifecycle/cleanup/scratch-writer-ownership';
import { computeFileSha256 } from '../gates/task-audit/task-audit-summary-fixtures';
import { fixture, taskId } from './owned-disposable-artifact-fixtures';

const rawFs = require('node:fs') as typeof fs;
const JOURNAL_KEYS = ['schema_version', 'kind', 'status', 'prepared_at_utc', 'journal_creation_identity', 'intent'];
const OWNER_KEYS = ['schema_version', 'kind', 'registration_id', 'workspace_identity', 'task_id', 'run_id', 'category',
    'payload_relative_path', 'root_creation_identity', 'pid', 'hostname', 'producer_instance_id', 'registered_at_utc', 'sealed_at_utc'];
type IntentFixtureRecord = Record<string, unknown> & {
    intent: Record<string, unknown> & {
        file_count: number;
        roots: Array<Record<string, unknown> & { inventory: Array<Record<string, unknown>> }>;
    };
};

function ownedFixture(t: TestContext, emptyPayload = false) {
    const f = fixture(t), owned = f.produce();
    if (emptyPayload) {
        fs.unlinkSync(path.join(owned.payloadPath, 'alpha.txt'));
        fs.unlinkSync(path.join(owned.payloadPath, 'nested', 'bytes.bin'));
        fs.rmdirSync(path.join(owned.payloadPath, 'nested'));
    }
    const preview = f.preview(owned.registrationId);
    assert.equal(preview.status, 'READY', preview.blockers.join());
    const selection = { ...f.options, registrationIds: [owned.registrationId], ownershipDigest: preview.ownership_digest! };
    const prepared = prepareOwnedDisposableArtifactRetirement({ ...selection, confirmed: true });
    assert.equal(prepared.status, 'PENDING', prepared.errors.join());
    const journal = prepared.journal_path!, key = path.join(f.runtime, 'disposable-producers', '.authority-key');
    const authorityFiles = [owned.ownerPath, key, path.join(f.reviews, `${taskId}-task-mode.json`),
        path.join(f.runtime, 'task-ledger', `${taskId}.json`)];
    const authorityHashes = () => authorityFiles.map(computeFileSha256);
    const payloadFiles = [path.join(owned.payloadPath, 'alpha.txt'), path.join(owned.payloadPath, 'nested', 'bytes.bin')];
    const payloadHashes = () => payloadFiles.map(computeFileSha256);
    // Only test-fixture metadata is re-signed to exercise authenticated malformed/legacy records; no workspace receipts.
    function resign(file: string, keys: string[], domain: string, change: (record: Record<string, unknown>) => void) {
        const record: Record<string, unknown> = JSON.parse(fs.readFileSync(file, 'utf8')); change(record);
        const unsigned = Object.fromEntries(keys.map(name => [name, record[name]]));
        record.authentication_sha256 = createHmac('sha256', fs.readFileSync(key))
            .update(JSON.stringify({ domain, record: unsigned })).digest('hex');
        fs.writeFileSync(file, JSON.stringify(record) + '\n');
    }
    const resignIntent = (change: (record: IntentFixtureRecord) => void, domain = 'garda.owned-disposable-retirement-intent.v1') =>
        resign(journal, JOURNAL_KEYS, domain, record => change(record as IntentFixtureRecord));
    const read = () => readOwnedDisposableArtifactRecoveryAuthority(selection);
    const apply = () => removeOwnedDisposableArtifacts({ ...selection, confirmed: true });
    return { ...f, owned, selection, prepared, journal, key, authorityFiles, authorityHashes, payloadFiles, payloadHashes,
        resign, resignIntent, read, apply };
}

test('recovery authority authenticates real sealed ownership and signed parent owner and key identities without payload mutation', t => {
    const f = ownedFixture(t), before = [...f.authorityHashes(), ...f.payloadHashes(), computeFileSha256(f.journal)];
    const authority = f.read(), root = authority.intent.roots[0];
    assert.equal(authority.absence_authorized, false); assert.equal(authority.owners[0].producerState, 'dead');
    assert.equal(authority.owners[0].rootBinding.missingAt, null); assert.equal(authority.intent.total_bytes, 7);
    assert.equal(authority.intent.file_count, 2); assert.equal(authority.journal.sha256, f.prepared.journal_sha256);
    assert.deepEqual(root.inventory, f.preview(f.owned.registrationId).items[0].inventory);
    assert.equal(root.parent_creation_identity, scratchBindingIdentity(bindContainedDestination(f.targetRoot, path.dirname(f.owned.payloadPath))));
    assert.equal(root.owner_identity, authority.owners[0].ownerFile.identity);
    assert.equal(authority.intent.authority_identity, readOwnedDisposableRetirementIntent(f.selection).authorityIdentity);
    assert.equal(authority.owners[0].authorityIdentity, authority.intent.authority_identity);
    assert.equal(authority.owners[0].ownerFile.contents, undefined);
    assert.deepEqual([...f.authorityHashes(), ...f.payloadHashes(), computeFileSha256(f.journal)], before);
});

test('authenticated owner and anchored intent stay readable after actual retirement but authorize no absence', t => {
    const f = ownedFixture(t), before = f.authorityHashes(), result = f.apply();
    assert.equal(result.status, 'REMOVED', result.errors.join()); assert.equal(result.removed_bytes, 7);
    assert.equal(fs.existsSync(f.owned.payloadPath), false);
    const owner = inspectOwnedDisposableArtifactOwner({ ...f.options, registrationId: f.owned.registrationId }), authority = f.read();
    assert.equal(owner.rootBinding.missingAt, f.owned.payloadPath); assert.equal(authority.absence_authorized, false);
    assert.equal(authority.owners[0].ownerSha256, owner.ownerSha256); assert.equal(authority.intent.file_count, 2);
    assert.throws(() => inspectOwnedDisposableArtifact({ ...f.options, registrationId: f.owned.registrationId }), /payload root is missing/u);
    assert.deepEqual(f.authorityHashes(), before);
});

test('partial first apply preserves readable recovery authority and the remaining bytes after unlink failure', t => {
    const f = ownedFixture(t), original = rawFs.unlinkSync, denied = f.payloadFiles[1];
    let injected = false;
    t.mock.method(rawFs, 'unlinkSync', (file: fs.PathLike) => {
        if (String(file) === denied) { injected = true; throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' }); }
        return original(file);
    });
    const before = f.authorityHashes(), remaining = computeFileSha256(denied), result = f.apply();
    assert.equal(injected, true); assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.removed_file_count, 1);
    assert.equal(result.removed_bytes, 3); assert.equal(fs.existsSync(f.payloadFiles[0]), false);
    const authority = f.read(); assert.equal(authority.absence_authorized, false); assert.equal(authority.intent.total_bytes, 7);
    assert.equal(computeFileSha256(denied), remaining); assert.deepEqual(f.authorityHashes(), before);
});

test('signed REMOVED frames retain the observed surviving directory identity after each actual unlink', t => {
    const f = ownedFixture(t), original = rawFs.renameSync;
    const observed: string[] = [];
    t.mock.method(rawFs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
        original(source, destination);
        if (path.dirname(String(destination)) !== f.journal.replace(/\.json$/u, '.progress')
            || !/^[0-9]{8}[.]json$/u.test(path.basename(String(destination)))) return;
        const frame = JSON.parse(fs.readFileSync(destination, 'utf8')).progress;
        if (frame.event === 'REMOVED') {
            assert.equal(typeof frame.parent_identity, 'string');
            const parent = path.dirname(path.join(f.targetRoot, frame.member_path));
            assert.equal(frame.parent_identity, scratchStatIdentity(lstatFileIdentitySync(parent, { bigint: true })));
            observed.push(frame.member_path);
        }
    });
    const expected = f.read().intent.roots[0].inventory.map(member => member.path).sort();
    const result = f.apply(); assert.equal(result.status, 'REMOVED', result.errors.join());
    assert.deepEqual(observed.sort(), expected);
});

test('empty payload root removal signs the actual surviving parent stat and preserves authority with zero file and byte counts', t => {
    const f = ownedFixture(t, true), original = rawFs.renameSync, before = f.authorityHashes();
    const rootPath = path.relative(f.targetRoot, f.owned.payloadPath).replace(/\\/gu, '/');
    let observed = false;
    t.mock.method(rawFs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
        original(source, destination);
        if (path.dirname(String(destination)) !== f.journal.replace(/\.json$/u, '.progress')
            || !/^[0-9]{8}[.]json$/u.test(path.basename(String(destination)))) return;
        const frame = JSON.parse(fs.readFileSync(destination, 'utf8')).progress;
        if (frame.event === 'REMOVED') {
            assert.equal(frame.member_path, rootPath); assert.equal(frame.removed_member_count, 1);
            assert.equal(frame.parent_identity, scratchStatIdentity(lstatFileIdentitySync(path.dirname(f.owned.payloadPath), { bigint: true })));
            observed = true;
        }
    });
    const result = f.apply(); assert.equal(result.status, 'REMOVED', result.errors.join());
    assert.equal(observed, true); assert.equal(result.removed_file_count, 0); assert.equal(result.removed_bytes, 0);
    assert.equal(fs.existsSync(f.owned.payloadPath), false); assert.deepEqual(f.authorityHashes(), before);
});

test('legacy signed intent retains first-apply compatibility and rejects unsupported missing-parent authority after removal', t => {
    const f = ownedFixture(t);
    f.resignIntent(record => {
        delete record.intent.authority_identity;
        for (const root of record.intent.roots) { delete root.parent_creation_identity; delete root.owner_identity; }
    });
    const legacyHash = computeFileSha256(f.journal), before = f.authorityHashes(), authority = f.read();
    assert.equal(authority.intent.authority_identity, undefined); assert.equal(authority.absence_authorized, false);
    const prepared = prepareOwnedDisposableArtifactRetirement({ ...f.selection, confirmed: true });
    assert.equal(prepared.status, 'PENDING', prepared.errors.join()); assert.equal(prepared.created, false);
    assert.equal(prepared.journal_sha256, legacyHash);
    const removed = f.apply(); assert.equal(removed.status, 'REMOVED', removed.errors.join());
    assert.throws(f.read, /Legacy disposable intent lacks.*anchor/u);
    assert.equal(computeFileSha256(f.journal), legacyHash); assert.deepEqual(f.authorityHashes(), before);
});

test('rejects replacement of the surviving payload parent after an authentic full removal', t => {
    const f = ownedFixture(t), removed = f.apply(); assert.equal(removed.status, 'REMOVED', removed.errors.join());
    const parent = path.dirname(f.owned.payloadPath), parked = parent + '.preserved';
    fs.renameSync(parent, parked); fs.mkdirSync(parent);
    const before = f.authorityHashes(), journal = computeFileSha256(f.journal);
    assert.throws(f.read, /surviving payload parent creation identity changed/u);
    assert.equal(fs.existsSync(parked), true); assert.deepEqual(fs.readdirSync(parent), []);
    assert.equal(computeFileSha256(f.journal), journal); assert.deepEqual(f.authorityHashes(), before);
});

test('rejects payload root replacement while preserving the original payload and replacement sentinel', t => {
    const f = ownedFixture(t), parked = f.owned.payloadPath + '.preserved';
    fs.renameSync(f.owned.payloadPath, parked); fs.mkdirSync(f.owned.payloadPath);
    const sentinel = path.join(f.owned.payloadPath, 'sentinel.txt'); fs.writeFileSync(sentinel, 'replacement');
    const original = computeFileSha256(path.join(parked, 'alpha.txt')), before = f.authorityHashes();
    assert.throws(f.read, /payload creation identity changed/u);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'replacement');
    assert.equal(computeFileSha256(path.join(parked, 'alpha.txt')), original); assert.deepEqual(f.authorityHashes(), before);
});

test('rejects copied authentic producer metadata with a replacement owner identity', t => {
    const f = ownedFixture(t), contents = fs.readFileSync(f.owned.ownerPath), old = f.owned.ownerPath + '.preserved';
    fs.renameSync(f.owned.ownerPath, old); fs.writeFileSync(f.owned.ownerPath, contents);
    const owner = inspectOwnedDisposableArtifactOwner({ ...f.options, registrationId: f.owned.registrationId });
    assert.equal(owner.ownerSha256, JSON.parse(fs.readFileSync(f.journal, 'utf8')).intent.roots[0].owner_sha256);
    const before = f.payloadHashes(); assert.throws(f.read, /same signed.*owner/u);
    assert.equal(fs.existsSync(old), true); assert.deepEqual(f.payloadHashes(), before);
});

test('rejects copied private authority even when the authentic intent signature still matches its bytes', t => {
    const f = ownedFixture(t), contents = fs.readFileSync(f.key), old = f.key + '.preserved';
    fs.renameSync(f.key, old); fs.writeFileSync(f.key, contents, { mode: 0o600 });
    const native = readOwnedDisposableRetirementIntent(f.selection);
    assert.notEqual(native.authorityIdentity, native.intent.authority_identity);
    const before = f.payloadHashes(); assert.throws(f.read, /intent does not match/u);
    assert.equal(fs.existsSync(old), true); assert.deepEqual(f.payloadHashes(), before);
});

test('rejects an identical copied key introduced during final owner reconstruction and preserves all evidence and payload', t => {
    const f = ownedFixture(t), originalOpen = rawFs.openSync, contents = fs.readFileSync(f.key);
    const parked = f.key + '.preserved', keyHash = computeFileSha256(f.key);
    const preserved = [...f.authorityFiles.filter(file => file !== f.key), ...f.payloadFiles, f.journal];
    const before = preserved.map(computeFileSha256);
    let ownerOpens = 0, injected = false;
    t.mock.method(rawFs, 'openSync', (file: fs.PathLike, flags: fs.OpenMode, mode?: number) => {
        // Each owner pass opens its captured record and currentness check; the third open starts the final pass.
        if (String(file) === f.owned.ownerPath && ++ownerOpens === 3) {
            fs.renameSync(f.key, parked); fs.writeFileSync(f.key, contents, { mode: 0o600 }); injected = true;
        }
        return originalOpen(file, flags, mode);
    });
    assert.throws(f.read, /owner used a changed private authority generation/u);
    assert.equal(injected, true); assert.equal(ownerOpens, 4);
    assert.equal(computeFileSha256(f.key), keyHash); assert.equal(computeFileSha256(parked), keyHash);
    assert.deepEqual(preserved.map(computeFileSha256), before);
});

test('rejects an authenticated changed producer that is no longer positively known dead', t => {
    const f = ownedFixture(t);
    f.resign(f.owned.ownerPath, OWNER_KEYS, 'garda.owned-disposable-artifact.v1', record => { record.pid = process.pid; });
    assert.equal(inspectOwnedDisposableArtifactOwner({ ...f.options, registrationId: f.owned.registrationId }).producerState, 'unknown');
    const before = f.payloadHashes(); assert.throws(f.read, /positively known-dead local owner/u); assert.deepEqual(f.payloadHashes(), before);
});

test('native run evidence drift blocks read-only recovery authority without changing payload', t => {
    const f = ownedFixture(t), mode = f.authorityFiles[2], value = JSON.parse(fs.readFileSync(mode, 'utf8'));
    value.task_summary = 'changed native task entry'; fs.writeFileSync(mode, JSON.stringify(value));
    const before = f.payloadHashes(); assert.throws(f.read, /native task entry|native run|task run/u);
    assert.deepEqual(f.payloadHashes(), before);
});

test('changed committed compact evidence blocks metadata-only recovery inspection', t => {
    const f = ownedFixture(t), ledger = f.authorityFiles[3], value = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    value.verification.status = 'INVALID'; fs.writeFileSync(ledger, JSON.stringify(value));
    const changed = computeFileSha256(ledger), before = f.payloadHashes();
    assert.throws(f.read, /committed native compact evidence changed or is ineligible/u);
    assert.equal(computeFileSha256(ledger), changed); assert.deepEqual(f.payloadHashes(), before);
});

test('missing private authority blocks inspection and is never recreated', t => {
    const f = ownedFixture(t), before = f.payloadHashes(), journal = computeFileSha256(f.journal); fs.unlinkSync(f.key);
    assert.throws(f.read, /missing|authority|key/u); assert.equal(fs.existsSync(f.key), false);
    assert.equal(computeFileSha256(f.journal), journal); assert.deepEqual(f.payloadHashes(), before);
});

test('copied authentic intent with a replacement file identity is rejected without overwrite', t => {
    const f = ownedFixture(t), contents = fs.readFileSync(f.journal), old = f.journal + '.preserved';
    fs.renameSync(f.journal, old); fs.writeFileSync(f.journal, contents);
    const before = f.payloadHashes(), copied = computeFileSha256(f.journal);
    assert.throws(f.read, /replaced|tampered/u); assert.equal(fs.existsSync(old), true);
    assert.equal(computeFileSha256(f.journal), copied); assert.deepEqual(f.payloadHashes(), before);
});

test('metadata signed for another purpose is rejected while preserving the intent and payload', t => {
    const f = ownedFixture(t); f.resignIntent(() => {}, 'garda.owned-disposable-retirement-progress.v1');
    const before = f.payloadHashes(), changed = computeFileSha256(f.journal);
    assert.throws(f.read, /malformed|tampered/u); assert.equal(computeFileSha256(f.journal), changed);
    assert.deepEqual(f.payloadHashes(), before);
});

test('authenticated inventory traversal is rejected before interpreting foreign member paths', t => {
    const f = ownedFixture(t), foreign = path.join(f.targetRoot, 'foreign.txt'); fs.writeFileSync(foreign, 'retain foreign bytes');
    f.resignIntent(record => { record.intent.roots[0].inventory[0].path = '../foreign.txt'; });
    const before = [...f.payloadHashes(), computeFileSha256(foreign)];
    assert.throws(f.read, /canonical bounded relative path/u); assert.deepEqual([...f.payloadHashes(), computeFileSha256(foreign)], before);
});

test('authenticated inconsistent inventory counters are rejected without deleting payload', t => {
    const f = ownedFixture(t); f.resignIntent(record => { record.intent.file_count += 1; });
    const before = f.payloadHashes(); assert.throws(f.read, /counters.*inconsistent/u); assert.deepEqual(f.payloadHashes(), before);
});

test('oversized compact intent is rejected by the bounded native read before decoding', t => {
    const f = ownedFixture(t); fs.writeFileSync(f.journal, Buffer.alloc(LIMITS.metadataBytes + 1, 0x61));
    const before = f.payloadHashes(), changed = computeFileSha256(f.journal);
    assert.throws(f.read, /allowance|bound|exceed|limit/u);
    assert.equal(computeFileSha256(f.journal), changed); assert.deepEqual(f.payloadHashes(), before);
});

test('caller-authored recovery proof and sparse selection are rejected before authority inspection', t => {
    const f = ownedFixture(t), before = [...f.authorityHashes(), ...f.payloadHashes(), computeFileSha256(f.journal)];
    assert.throws(() => readOwnedDisposableArtifactRecoveryAuthority({ ...f.selection, snapshot: { eligible: true } } as never), /exact declared selection/u);
    assert.throws(() => readOwnedDisposableArtifactRecoveryAuthority({ ...f.selection, registrationIds: new Array<string>(1) }), /unique native registration/u);
    assert.deepEqual([...f.authorityHashes(), ...f.payloadHashes(), computeFileSha256(f.journal)], before);
});
