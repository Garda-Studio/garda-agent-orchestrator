import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac } from 'node:crypto';
import { prepareOwnedDisposableArtifactRetirement, withOwnedDisposableRetirementMutation }
    from '../../../src/lifecycle/cleanup/owned-disposable-artifact-journal';
import { removeOwnedDisposableArtifacts } from '../../../src/lifecycle/cleanup/owned-disposable-artifact-removal';
import { readOwnedDisposableArtifactRecoveryProgress } from '../../../src/lifecycle/cleanup/owned-disposable-artifact-recovery-progress';
import { computeFileSha256 } from '../gates/task-audit/task-audit-summary-fixtures';
import { fixture, taskId } from './owned-disposable-artifact-fixtures';

const rawFs = require('node:fs') as typeof fs;
const DOMAIN = 'garda.owned-disposable-retirement-progress.v1';
const KEYS = ['schema_version', 'kind', 'prepared_at_utc', 'journal_creation_identity', 'progress'];

function ownedFixture(t: TestContext) {
    const f = fixture(t), owned = f.produce(), preview = f.preview(owned.registrationId);
    assert.equal(preview.status, 'READY', preview.blockers.join());
    const selection = { ...f.options, registrationIds: [owned.registrationId], ownershipDigest: preview.ownership_digest! };
    const prepared = prepareOwnedDisposableArtifactRetirement({ ...selection, confirmed: true });
    assert.equal(prepared.status, 'PENDING', prepared.errors.join());
    const journal = prepared.journal_path!, directory = journal.replace(/\.json$/u, '.progress');
    const key = path.join(f.runtime, 'disposable-producers', '.authority-key');
    const alpha = path.join(owned.payloadPath, 'alpha.txt'), binary = path.join(owned.payloadPath, 'nested', 'bytes.bin');
    const authorityFiles = [owned.ownerPath, key, journal, path.join(f.reviews, `${taskId}-task-mode.json`),
        path.join(f.runtime, 'task-ledger', `${taskId}.json`)];
    const read = () => readOwnedDisposableArtifactRecoveryProgress(selection);
    const apply = () => removeOwnedDisposableArtifacts({ ...selection, confirmed: true });
    const framePaths = () => fs.readdirSync(directory).sort().map(name => path.join(directory, name));
    const hashes = (files: readonly string[]) => files.map(computeFileSha256);
    // Fixture-only re-signing exercises authenticated semantic corruption; no production workspace evidence is modified.
    function resign(file: string, change: (record: any) => void, domain = DOMAIN) {
        const record = JSON.parse(fs.readFileSync(file, 'utf8')); change(record);
        const unsigned = Object.fromEntries(KEYS.map(name => [name, record[name]]));
        record.authentication_sha256 = createHmac('sha256', fs.readFileSync(key))
            .update(JSON.stringify({ domain, record: unsigned })).digest('hex');
        fs.writeFileSync(file, JSON.stringify(record) + '\n');
    }
    function finish() { const result = apply(); assert.equal(result.status, 'REMOVED', result.errors.join()); return framePaths(); }
    return { ...f, owned, selection, journal, directory, key, alpha, binary, authorityFiles, read, apply, framePaths,
        hashes, resign, finish };
}

test('missing progress is read-only unstarted metadata with no successful removal or absence authority', t => {
    const f = ownedFixture(t), before = f.hashes([...f.authorityFiles, f.alpha, f.binary]);
    const progress = f.read();
    assert.equal(progress.status, 'UNSTARTED'); assert.equal(progress.directoryIdentity, null);
    assert.deepEqual(progress.frames, []); assert.equal(progress.order.length, 4);
    assert.equal(progress.known_removed_member_count, 0); assert.equal(progress.known_removed_file_count, 0);
    assert.equal(progress.known_removed_bytes, 0); assert.equal(progress.pending_member_path, null);
    assert.equal(progress.absence_authorized, false); assert.equal(progress.authority.absence_authorized, false);
    assert.equal(fs.existsSync(f.directory), false);
    assert.deepEqual(f.hashes([...f.authorityFiles, f.alpha, f.binary]), before);
});

test('actual finished first apply retains an exact authenticated ordered chain and honest known-success counts', t => {
    const f = ownedFixture(t), frames = f.finish(), before = f.hashes([...f.authorityFiles, ...frames]);
    const progress = f.read();
    assert.equal(progress.status, 'FINISHED'); assert.equal(progress.frames.length, 9);
    assert.equal(progress.known_removed_member_count, 4); assert.equal(progress.known_removed_file_count, 2);
    assert.equal(progress.known_removed_bytes, 7); assert.equal(progress.pending_member_path, null);
    assert.equal(progress.last_error, null); assert.equal(progress.absence_authorized, false);
    assert.deepEqual(progress.frames.map(frame => frame.binding.path), frames);
    const removed = frames.map(file => JSON.parse(fs.readFileSync(file, 'utf8')).progress)
        .filter(value => value.event === 'REMOVED');
    assert.deepEqual(removed.map(value => value.member_path), progress.order.map(member => member.path));
    for (const value of removed) assert.match(value.parent_identity, /^[0-9a-f]{64}$/u);
    assert.deepEqual(f.hashes([...f.authorityFiles, ...frames]), before);
});

test('actual EACCES partial apply retains pending/error metadata and excludes the failed member from counts', t => {
    const f = ownedFixture(t), unlink = rawFs.unlinkSync;
    let injected = false;
    t.mock.method(rawFs, 'unlinkSync', (candidate: fs.PathLike) => {
        if (String(candidate) === f.binary) { injected = true; throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' }); }
        unlink(candidate);
    });
    const result = f.apply(); assert.equal(injected, true); assert.equal(result.status, 'INCOMPLETE');
    const frames = f.framePaths(), before = f.hashes([...f.authorityFiles, ...frames, f.binary]), progress = f.read();
    const last = JSON.parse(fs.readFileSync(frames.at(-1)!, 'utf8')).progress;
    assert.ok(['PENDING', 'ERROR'].includes(last.event), result.errors.join());
    assert.equal(progress.status, last.event); assert.equal(progress.known_removed_member_count, 1);
    assert.equal(progress.known_removed_file_count, 1); assert.equal(progress.known_removed_bytes, 3);
    assert.equal(progress.pending_member_path, path.relative(f.targetRoot, f.binary).replace(/\\/gu, '/'));
    assert.ok(result.errors.some(message => message.includes('injected EACCES')));
    assert.equal(progress.last_error, last.event === 'ERROR' ? 'injected EACCES' : null);
    assert.equal(progress.absence_authorized, false);
    assert.deepEqual(f.hashes([...f.authorityFiles, ...frames, f.binary]), before);
});

test('native session ERROR before unlink retains pending metadata with zero successful counts', t => {
    const f = ownedFixture(t), before = f.hashes([...f.authorityFiles, f.alpha, f.binary]);
    withOwnedDisposableRetirementMutation({ ...f.selection, confirmed: true }, mutation => {
        assert.ok(mutation.pending()); mutation.fail('controlled interruption before unlink');
    });
    const frames = f.framePaths(), progress = f.read();
    assert.equal(frames.length, 2); assert.equal(progress.status, 'ERROR');
    assert.equal(progress.pending_member_path, progress.order[0].path);
    assert.equal(progress.last_error, 'controlled interruption before unlink');
    assert.equal(progress.known_removed_member_count, 0); assert.equal(progress.known_removed_file_count, 0);
    assert.equal(progress.known_removed_bytes, 0); assert.equal(progress.absence_authorized, false);
    assert.deepEqual(f.hashes([...f.authorityFiles, f.alpha, f.binary]), before);
});

test('a retained real signed pending prefix with missing payload describes uncertainty rather than successful removal', t => {
    const f = ownedFixture(t), frames = f.finish(), parked = path.join(f.bundleRoot, 'parked-progress');
    fs.mkdirSync(parked);
    for (const file of frames.slice(1)) fs.renameSync(file, path.join(parked, path.basename(file)));
    const before = f.hashes([...f.authorityFiles, frames[0]]), progress = f.read();
    assert.equal(progress.status, 'PENDING'); assert.equal(progress.known_removed_member_count, 0);
    assert.equal(progress.known_removed_file_count, 0); assert.equal(progress.known_removed_bytes, 0);
    assert.equal(progress.pending_member_path, progress.order[0].path); assert.equal(progress.absence_authorized, false);
    assert.equal(fs.existsSync(f.owned.payloadPath), false);
    assert.equal(fs.readdirSync(parked).length, frames.length - 1);
    assert.deepEqual(f.hashes([...f.authorityFiles, frames[0]]), before);
});

test('two registrations use the actual producer files-then-deepest-directories order per registration', t => {
    const f = ownedFixture(t), second = f.produce(), preview = f.preview(f.owned.registrationId, second.registrationId);
    assert.equal(preview.status, 'READY', preview.blockers.join());
    const selection = { ...f.options, registrationIds: [second.registrationId, f.owned.registrationId],
        ownershipDigest: preview.ownership_digest! };
    const prepared = prepareOwnedDisposableArtifactRetirement({ ...selection, confirmed: true });
    assert.equal(prepared.status, 'PENDING', prepared.errors.join());
    const result = removeOwnedDisposableArtifacts({ ...selection, confirmed: true });
    assert.equal(result.status, 'REMOVED', result.errors.join());
    const progress = readOwnedDisposableArtifactRecoveryProgress(selection);
    assert.equal(progress.status, 'FINISHED'); assert.equal(progress.known_removed_file_count, 4);
    assert.equal(progress.known_removed_member_count, 8); assert.equal(progress.known_removed_bytes, 14);
    const removed = progress.frames.map(file => JSON.parse(fs.readFileSync(file.binding.path, 'utf8')).progress)
        .filter(value => value.event === 'REMOVED');
    assert.deepEqual(removed.map(value => value.member_path), progress.order.map(member => member.path));
});

const corruptions = [
    ['sequence', (r: any) => { r.progress.sequence = 1; }, /schema|chain/u],
    ['previous hash', (r: any) => { r.progress.previous_sha256 = '0'.repeat(64); }, /schema|chain/u],
    ['intent hash', (r: any) => { r.progress.intent_sha256 = '0'.repeat(64); }, /schema|chain/u],
    ['ownership digest', (r: any) => { r.progress.ownership_digest = '0'.repeat(64); }, /schema|chain/u],
    ['order policy', (r: any) => { r.progress.order = 'wrong-order'; }, /schema|chain/u],
    ['member order', (r: any) => { r.progress.member_path = 'foreign/payload'; }, /pending|order/u],
    ['success counters', (r: any) => { r.progress.removed_bytes = 3; }, /counters/u],
    ['unknown field', (r: any) => { r.progress.caller_proof = true; }, /schema/u],
    ['early finish', (r: any) => { r.progress.event = 'FINISHED'; r.progress.member_path = null; }, /before exact completion/u],
    ['unmatched removal', (r: any) => { r.progress.event = 'REMOVED'; r.progress.parent_identity = '0'.repeat(64); }, /pending/u]
] as const;
for (const [label, change, pattern] of corruptions) test(`authenticated progress rejects ${label} without changing retained bytes`, t => {
    const f = ownedFixture(t);
    withOwnedDisposableRetirementMutation({ ...f.selection, confirmed: true }, mutation => {
        assert.ok(mutation.pending());
    });
    const frames = f.framePaths();
    assert.equal(frames.length, 1); assert.equal(path.basename(frames[0]), '00000000.json');
    const control = f.read();
    assert.equal(control.status, 'PENDING'); assert.equal(control.known_removed_member_count, 0);
    assert.equal(control.pending_member_path, control.order[0].path); assert.equal(control.absence_authorized, false);
    // A single real pending frame isolates the semantic guard from all descendant hash and transition errors.
    f.resign(frames[0], change);
    const retained = [...f.authorityFiles, ...frames, f.alpha, f.binary], before = f.hashes(retained);
    assert.throws(f.read, pattern); assert.deepEqual(f.hashes(retained), before);
});

test('rejects authenticated REMOVED without a signed bounded parent identity', t => {
    const f = ownedFixture(t), frames = f.finish(); f.resign(frames[1], r => { r.progress.parent_identity = null; });
    const before = f.hashes([...f.authorityFiles, ...frames]);
    assert.throws(f.read, /signed parent identity/u); assert.deepEqual(f.hashes([...f.authorityFiles, ...frames]), before);
});

test('rejects wrong progress authentication purpose and preserves the original frames and native authority', t => {
    const f = ownedFixture(t), frames = f.finish(); f.resign(frames[0], () => {}, 'garda.owned-disposable-retirement-intent.v1');
    const before = f.hashes([...f.authorityFiles, ...frames]);
    assert.throws(f.read, /progress is malformed/u); assert.deepEqual(f.hashes([...f.authorityFiles, ...frames]), before);
});

test('copied authentic frame bytes on a fresh file object reject while preserving both generations', t => {
    const f = ownedFixture(t), frames = f.finish(), original = frames[0] + '.parked';
    const before = computeFileSha256(frames[0]); fs.renameSync(frames[0], original);
    fs.copyFileSync(original, frames[0]); fs.renameSync(original, path.join(f.bundleRoot, 'original-frame.json'));
    assert.throws(f.read, /progress is malformed/u);
    assert.equal(computeFileSha256(frames[0]), before);
    assert.equal(computeFileSha256(path.join(f.bundleRoot, 'original-frame.json')), before);
});

test('rejects unknown interrupted metadata while preserving every diagnostic', t => {
    const f = ownedFixture(t), frames = f.finish(), orphan = path.join(f.directory, '.00000009.json.intent-interrupted');
    fs.writeFileSync(orphan, 'retained diagnostic'); const before = f.hashes([...f.authorityFiles, ...frames, orphan]);
    assert.throws(f.read, /unknown|interrupted/u); assert.deepEqual(f.hashes([...f.authorityFiles, ...frames, orphan]), before);
});

test('missing sequence members preserve all remaining authentic progress', t => {
    const f = ownedFixture(t), frames = f.finish(), parked = path.join(f.bundleRoot, 'parked-first-frame.json');
    fs.renameSync(frames[0], parked); const before = f.hashes([...f.authorityFiles, ...frames.slice(1), parked]);
    assert.throws(f.read, /nonsequential|missing/u);
    assert.deepEqual(f.hashes([...f.authorityFiles, ...frames.slice(1), parked]), before);
});

test('progress refuses a single frame above the metadata byte allowance before decoding it', t => {
    const f = ownedFixture(t), frames = f.finish(); fs.writeFileSync(frames[0], Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    const before = f.hashes([...f.authorityFiles, ...frames]);
    assert.throws(f.read, /allowance|bounded|large|size/u); assert.deepEqual(f.hashes([...f.authorityFiles, ...frames]), before);
});

test('rejects aggregate metadata byte excess from individually bounded authentic frames', t => {
    const f = ownedFixture(t), frames = f.finish(), padding = ' '.repeat(2 * 1024 * 1024);
    fs.appendFileSync(frames[0], padding);
    f.resign(frames[1], r => { r.progress.previous_sha256 = computeFileSha256(frames[0]); });
    fs.appendFileSync(frames[1], padding);
    assert.ok(fs.statSync(frames[0]).size < 4 * 1024 * 1024);
    assert.ok(fs.statSync(frames[1]).size < 4 * 1024 * 1024);
    const before = f.hashes([...f.authorityFiles, ...frames]);
    assert.throws(f.read, /allowance|bounded|large|size/u);
    assert.deepEqual(f.hashes([...f.authorityFiles, ...frames]), before);
});

test('rejects excess canonical progress entries before metadata reads and retains all diagnostics', t => {
    const f = ownedFixture(t); fs.mkdirSync(f.directory);
    for (let index = 0; index < 4099; index += 1) fs.writeFileSync(path.join(f.directory,
        `${String(index).padStart(8, '0')}.json`), 'retained bounded-entry diagnostic');
    const first = path.join(f.directory, '00000000.json'), last = path.join(f.directory, '00004098.json');
    const before = f.hashes([...f.authorityFiles, f.alpha, f.binary, first, last]);
    assert.throws(f.read, /allowance|bounded|budget|exceed/u); assert.equal(fs.readdirSync(f.directory).length, 4099);
    assert.deepEqual(f.hashes([...f.authorityFiles, f.alpha, f.binary, first, last]), before);
});

test('same-byte private key replacement preserves both copies and rejects changed native generation', t => {
    const f = ownedFixture(t), frames = f.finish(), parked = f.key + '.parked', before = computeFileSha256(f.key);
    fs.renameSync(f.key, parked); fs.writeFileSync(f.key, fs.readFileSync(parked), { mode: 0o600 });
    assert.throws(f.read, /authority|selection/u);
    assert.equal(computeFileSha256(f.key), before); assert.equal(computeFileSha256(parked), before);
    assert.equal(f.framePaths().length, frames.length);
});

test('missing private authority is not recreated while native intent and progress stay preserved', t => {
    const f = ownedFixture(t), frames = f.finish(); fs.renameSync(f.key, f.key + '.parked');
    const before = f.hashes([f.journal, f.owned.ownerPath, ...frames]);
    assert.throws(f.read); assert.equal(fs.existsSync(f.key), false);
    assert.deepEqual(f.hashes([f.journal, f.owned.ownerPath, ...frames]), before);
});

test('identical private key replacement during actual progress read rejects the changed generation', t => {
    const f = ownedFixture(t), frames = f.finish(), open = rawFs.openSync, parked = f.key + '.parked';
    let injected = false;
    const before = f.hashes([...f.authorityFiles, ...frames]);
    t.mock.method(rawFs, 'openSync', (file: fs.PathLike, flags: any, mode?: fs.Mode) => {
        if (String(file) === frames[0] && !injected) {
            injected = true; fs.renameSync(f.key, parked); fs.writeFileSync(f.key, fs.readFileSync(parked), { mode: 0o600 });
        }
        return open(file, flags, mode);
    });
    assert.throws(f.read, error => error instanceof Error
        && error.message === `Destination identity changed before mutation: ${f.key}`);
    assert.equal(injected, true);
    assert.deepEqual(f.hashes([...f.authorityFiles, ...frames]), before);
    assert.equal(computeFileSha256(parked), computeFileSha256(f.key));
});

test('a progress directory appearing during an absent-directory read is rejected before metadata returns', t => {
    const f = ownedFixture(t), open = rawFs.openSync, lstat = rawFs.lstatSync;
    let absenceObserved = false, injected = false;
    t.mock.method(rawFs, 'lstatSync', (file: fs.PathLike, options?: any) => {
        try { return lstat(file, options); }
        catch (error) {
            if (String(file) === f.directory && (error as NodeJS.ErrnoException).code === 'ENOENT') absenceObserved = true;
            throw error;
        }
    });
    t.mock.method(rawFs, 'openSync', (file: fs.PathLike, flags: any, mode?: fs.Mode) => {
        if (String(file) === f.journal && absenceObserved && !injected) { injected = true; fs.mkdirSync(f.directory); }
        return open(file, flags, mode);
    });
    assert.throws(f.read, error => error instanceof Error
        && error.message === `Destination identity changed before mutation: ${f.directory}`);
    assert.equal(injected, true);
    assert.equal(fs.existsSync(f.directory), true);
});

test('rejects caller progress paths and snapshots plus sparse native selections as authority', t => {
    const f = ownedFixture(t), before = f.hashes([...f.authorityFiles, f.alpha, f.binary]);
    assert.throws(() => readOwnedDisposableArtifactRecoveryProgress({ ...f.selection, progressPath: f.journal } as never), /exact declared/u);
    assert.throws(() => readOwnedDisposableArtifactRecoveryProgress({ ...f.selection, snapshot: {} } as never), /exact declared/u);
    assert.throws(() => readOwnedDisposableArtifactRecoveryProgress({ ...f.selection, registrationIds: [, f.owned.registrationId] as never }), /explicit nonempty bounded/u);
    assert.deepEqual(f.hashes([...f.authorityFiles, f.alpha, f.binary]), before);
});
