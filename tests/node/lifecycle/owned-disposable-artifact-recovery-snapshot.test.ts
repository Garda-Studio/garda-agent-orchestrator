import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { removeBoundContainedPath } from '../../../src/core/contained-filesystem';
import { fsyncDirectoryBestEffort } from '../../../src/core/filesystem';
import { prepareOwnedDisposableArtifactRetirement, withOwnedDisposableRetirementMutation }
    from '../../../src/lifecycle/cleanup/owned-disposable-artifact-journal';
import { removeOwnedDisposableArtifacts } from '../../../src/lifecycle/cleanup/owned-disposable-artifact-removal';
import { readOwnedDisposableArtifactRecoverySnapshot }
    from '../../../src/lifecycle/cleanup/owned-disposable-artifact-recovery-snapshot';
import { computeFileSha256 } from '../gates/task-audit/task-audit-summary-fixtures';
import { fixture, taskId } from './owned-disposable-artifact-fixtures';

const rawFs = require('node:fs') as typeof fs;

function ownedFixture(t: TestContext, count = 1, includeDependency = false) {
    const f = fixture(t), owned = Array.from({ length: count }, () => f.produce());
    const dependency = path.join(f.reviews, `${taskId}-dependency-note.json`);
    if (includeDependency) fs.writeFileSync(dependency, JSON.stringify({ note: 'original benign native dependency' }) + '\n');
    const preview = f.preview(...owned.map(item => item.registrationId));
    assert.equal(preview.status, 'READY', preview.blockers.join());
    const selection = { ...f.options, registrationIds: owned.map(item => item.registrationId),
        ownershipDigest: preview.ownership_digest! };
    const prepared = prepareOwnedDisposableArtifactRetirement({ ...selection, confirmed: true });
    assert.equal(prepared.status, 'PENDING', prepared.errors.join());
    const journal = prepared.journal_path!, directory = journal.replace(/\.json$/u, '.progress');
    const key = path.join(f.runtime, 'disposable-producers', '.authority-key'), payload = owned[0].payloadPath;
    const alpha = path.join(payload, 'alpha.txt'), nested = path.join(payload, 'nested'), binary = path.join(nested, 'bytes.bin');
    const nativeFiles = [...owned.map(item => item.ownerPath), key, journal, path.join(f.targetRoot, 'TASK.md'),
        path.join(f.reviews, `${taskId}-task-mode.json`), path.join(f.runtime, 'task-ledger', `${taskId}.json`),
        ...(includeDependency ? [dependency] : [])];
    const read = () => readOwnedDisposableArtifactRecoverySnapshot(selection);
    function hashes() {
        const files = [...nativeFiles];
        function collect(candidate: string) {
            if (!fs.existsSync(candidate)) return;
            if (fs.lstatSync(candidate).isDirectory()) for (const name of fs.readdirSync(candidate)) collect(path.join(candidate, name));
            else files.push(candidate);
        }
        for (const item of owned) collect(item.payloadPath);
        collect(directory);
        return files.sort().map(file => [file, computeFileSha256(file)]);
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
                if (pending === 'error') mutation.fail('controlled error before unlink');
            }
        });
    }
    function finish() {
        const result = removeOwnedDisposableArtifacts({ ...selection, confirmed: true });
        assert.equal(result.status, 'REMOVED', result.errors.join());
    }
    return { ...f, owned, selection, journal, directory, key, payload, alpha, nested, binary, dependency, nativeFiles,
        read, hashes, prefix, finish };
}

test('unstarted recovery validates exact current payload and dependencies without changing any retained bytes', t => {
    const f = ownedFixture(t), before = f.hashes(), snapshot = f.read();
    assert.equal(snapshot.progress.status, 'UNSTARTED'); assert.equal(snapshot.roots[0].entries.length, 4);
    assert.equal(snapshot.remaining_file_count, 2); assert.equal(snapshot.remaining_bytes, 7);
    assert.equal(snapshot.pending_absent_path, null); assert.equal(snapshot.absence_authorized, false);
    assert.equal(snapshot.progress.known_removed_member_count, 0);
    assert.deepEqual(snapshot.roots[0].entries.map(entry => entry.view), snapshot.progress.authority.intent.roots[0].inventory);
    assert.deepEqual(f.hashes(), before); assert.equal(fs.existsSync(f.directory), false);
});

test('actual signed partial removal validates remaining bytes and authenticated changed parent identity', t => {
    const f = ownedFixture(t); f.prefix(1);
    const before = f.hashes(), snapshot = f.read();
    assert.equal(snapshot.progress.status, 'PARTIAL'); assert.equal(snapshot.progress.known_removed_member_count, 1);
    assert.equal(snapshot.progress.known_removed_file_count, 1); assert.equal(snapshot.progress.known_removed_bytes, 3);
    assert.equal(snapshot.remaining_file_count, 1); assert.equal(snapshot.remaining_bytes, 4);
    assert.equal(snapshot.roots[0].entries.length, 3); assert.equal(snapshot.pending_absent_path, null);
    assert.equal(snapshot.absence_authorized, false); assert.deepEqual(f.hashes(), before);
});

test('actual finished fully absent payload validates original digest and honest signed successful counts read-only', t => {
    const f = ownedFixture(t); f.finish();
    const before = f.hashes(), snapshot = f.read();
    assert.equal(fs.existsSync(f.payload), false); assert.equal(snapshot.progress.status, 'FINISHED');
    assert.equal(snapshot.progress.known_removed_member_count, 4); assert.equal(snapshot.progress.known_removed_file_count, 2);
    assert.equal(snapshot.progress.known_removed_bytes, 7); assert.equal(snapshot.remaining_file_count, 0);
    assert.equal(snapshot.remaining_bytes, 0); assert.deepEqual(snapshot.roots[0].entries, []);
    assert.equal(snapshot.pending_absent_path, null); assert.equal(snapshot.absence_authorized, false);
    assert.deepEqual(f.hashes(), before);
});

test('present signed pending member keeps original bytes and does not count as successful removal', t => {
    const f = ownedFixture(t); f.prefix(0, 'present');
    const before = f.hashes(), snapshot = f.read();
    assert.equal(snapshot.progress.status, 'PENDING'); assert.equal(snapshot.progress.known_removed_member_count, 0);
    assert.equal(snapshot.progress.known_removed_bytes, 0); assert.equal(snapshot.pending_absent_path, null);
    assert.equal(snapshot.remaining_file_count, 2); assert.equal(snapshot.remaining_bytes, 7);
    assert.equal(snapshot.absence_authorized, false); assert.deepEqual(f.hashes(), before);
});

test('one exact signed pending file absence remains uncertainty without successful accounting or mutation authority', t => {
    const f = ownedFixture(t); f.prefix(0, 'absent');
    const before = f.hashes(), snapshot = f.read();
    assert.equal(fs.existsSync(f.alpha), false); assert.equal(snapshot.progress.status, 'PENDING');
    assert.equal(snapshot.pending_absent_path, snapshot.progress.pending_member_path);
    assert.equal(snapshot.progress.known_removed_member_count, 0); assert.equal(snapshot.progress.known_removed_bytes, 0);
    assert.equal(snapshot.remaining_file_count, 1); assert.equal(snapshot.remaining_bytes, 4);
    assert.equal(snapshot.absence_authorized, false); assert.deepEqual(f.hashes(), before);
});

test('one exact signed pending root absence validates known descendants but never counts the unresolved root', t => {
    const f = ownedFixture(t); f.prefix(3, 'absent');
    const before = f.hashes(), snapshot = f.read();
    assert.equal(fs.existsSync(f.payload), false); assert.equal(snapshot.progress.known_removed_member_count, 3);
    assert.equal(snapshot.progress.known_removed_file_count, 2); assert.equal(snapshot.progress.known_removed_bytes, 7);
    assert.equal(snapshot.pending_absent_path, path.relative(f.targetRoot, f.payload).replace(/\\/gu, '/'));
    assert.equal(snapshot.remaining_file_count, 0); assert.equal(snapshot.remaining_bytes, 0);
    assert.equal(snapshot.absence_authorized, false); assert.deepEqual(f.hashes(), before);
});

test('real signed error preserves its pending present payload and exact zero successful accounting', t => {
    const f = ownedFixture(t); f.prefix(0, 'error');
    const before = f.hashes(), snapshot = f.read();
    assert.equal(snapshot.progress.status, 'ERROR'); assert.equal(snapshot.progress.last_error, 'controlled error before unlink');
    assert.equal(snapshot.progress.known_removed_member_count, 0); assert.equal(snapshot.remaining_bytes, 7);
    assert.equal(snapshot.pending_absent_path, null); assert.deepEqual(f.hashes(), before);
});

test('multiple registrations validate one genuinely absent root and the exact original surviving second root', t => {
    const f = ownedFixture(t, 2); f.prefix(4);
    const before = f.hashes(), snapshot = f.read();
    assert.equal(snapshot.roots[0].entries.length, 0); assert.equal(snapshot.roots[1].entries.length, 4);
    assert.equal(snapshot.progress.known_removed_member_count, 4); assert.equal(snapshot.progress.known_removed_bytes, 7);
    assert.equal(snapshot.remaining_file_count, 2); assert.equal(snapshot.remaining_bytes, 7);
    assert.equal(snapshot.absence_authorized, false); assert.deepEqual(f.hashes(), before);
});

test('rejects unknown file absence without a corresponding signed pending or successful prefix', t => {
    const f = ownedFixture(t); fs.unlinkSync(f.binary);
    const before = f.hashes(); assert.throws(f.read, /unknown absence/u); assert.deepEqual(f.hashes(), before);
});

test('rejects fully absent root without signed successful or unresolved pending membership', t => {
    const f = ownedFixture(t); fs.rmSync(f.payload, { recursive: true });
    const before = f.hashes(); assert.throws(f.read, /unknown absence/u); assert.deepEqual(f.hashes(), before);
});

test('rejects a second unknown absence alongside the one genuine signed pending absence', t => {
    const f = ownedFixture(t); f.prefix(0, 'absent'); fs.unlinkSync(f.binary);
    const before = f.hashes(); assert.throws(f.read, /unknown absence/u); assert.deepEqual(f.hashes(), before);
});

test('rejects new remaining membership and preserves the extra file and native metadata', t => {
    const f = ownedFixture(t); fs.writeFileSync(path.join(f.payload, 'extra.txt'), 'preserve me');
    const before = f.hashes(); assert.throws(f.read, /membership/u); assert.deepEqual(f.hashes(), before);
});

test('rejects changed surviving file bytes while preserving its current bytes and all signed history', t => {
    const f = ownedFixture(t); fs.writeFileSync(f.binary, Buffer.from([4, 3, 2, 1]));
    const before = f.hashes(); assert.throws(f.read, /remaining member/u); assert.deepEqual(f.hashes(), before);
});

test('rejects same-byte replacement of a surviving file by a fresh ordinary object', t => {
    const f = ownedFixture(t), parked = path.join(f.bundleRoot, 'parked-alpha');
    fs.renameSync(f.alpha, parked); fs.writeFileSync(f.alpha, fs.readFileSync(parked));
    const before = f.hashes(); assert.throws(f.read, /remaining member/u); assert.deepEqual(f.hashes(), before);
    assert.equal(fs.readFileSync(parked, 'utf8'), 'abc');
});

test('rejects recreated signed removed member even when its bytes equal the original payload', t => {
    const f = ownedFixture(t); f.prefix(1); fs.writeFileSync(f.alpha, 'abc');
    const before = f.hashes(); assert.throws(f.read, /removed member.*replaced/u); assert.deepEqual(f.hashes(), before);
});

test('rejects replacement of the selected root and preserves both original and replacement data', t => {
    const f = ownedFixture(t), parked = path.join(f.bundleRoot, 'parked-payload');
    fs.renameSync(f.payload, parked); fs.mkdirSync(f.payload); fs.renameSync(path.join(parked, 'alpha.txt'), f.alpha);
    fs.renameSync(path.join(parked, 'nested'), f.nested);
    const before = f.hashes(); assert.throws(f.read, /creation identity|remaining member/u); assert.deepEqual(f.hashes(), before);
    assert.equal(fs.existsSync(parked), true);
});

test('rejects replacement of the surviving parent after actual finished payload removal', t => {
    const f = ownedFixture(t); f.finish();
    const parent = path.dirname(f.payload), parked = path.join(f.bundleRoot, 'parked-parent');
    fs.renameSync(parent, parked); fs.mkdirSync(parent);
    const before = f.hashes(); assert.throws(f.read, /parent creation identity/u); assert.deepEqual(f.hashes(), before);
    assert.equal(fs.existsSync(parked), true);
});

test('rejects unsigned surviving directory stat change even when membership returns to its original state', t => {
    const f = ownedFixture(t), extra = path.join(f.nested, 'temporary');
    fs.writeFileSync(extra, 'x'); fs.unlinkSync(extra);
    const before = f.hashes(); assert.throws(f.read, /remaining member/u); assert.deepEqual(f.hashes(), before);
});

test('rejects changed signed removed parent identity after finished retirement and preserves the foreign sibling', t => {
    const f = ownedFixture(t); f.finish();
    const sibling = path.join(path.dirname(f.payload), 'foreign-sibling'); fs.writeFileSync(sibling, 'preserve');
    const before = f.hashes(); assert.throws(f.read, /signed parent identity/u); assert.deepEqual(f.hashes(), before);
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'preserve');
});

test('rejects symlink replacement of a remaining member without following or changing its target', t => {
    const f = ownedFixture(t), parked = path.join(f.bundleRoot, 'parked-binary');
    fs.renameSync(f.binary, parked); fs.symlinkSync(parked, f.binary);
    const before = f.hashes(); assert.throws(f.read, /symlink|symbolic|linked/u); assert.deepEqual(f.hashes(), before);
    assert.deepEqual(fs.readFileSync(parked), Buffer.from([0, 1, 2, 3]));
});

test('rejects caller supplied snapshot authority and preserves every actual input', t => {
    const f = ownedFixture(t), before = f.hashes();
    assert.throws(() => readOwnedDisposableArtifactRecoverySnapshot({ ...f.selection, snapshot: {} } as any), /declared|selection/u);
    assert.deepEqual(f.hashes(), before);
});

test('rejects a foreign ownership digest without adopting or creating metadata', t => {
    const f = ownedFixture(t); assert.equal(f.read().remaining_bytes, 7);
    const before = f.hashes();
    assert.throws(() => readOwnedDisposableArtifactRecoverySnapshot({ ...f.selection, ownershipDigest: '0'.repeat(64) }),
        { code: 'ENOENT', path: path.join(path.dirname(f.journal), '0'.repeat(64) + '.json') });
    assert.deepEqual(f.hashes(), before);
});

test('rejects identical private key bytes in a fresh key object without claiming inherited authority', t => {
    const f = ownedFixture(t), parked = path.join(f.bundleRoot, 'parked-key');
    assert.equal(f.read().remaining_bytes, 7);
    fs.renameSync(f.key, parked); fs.writeFileSync(f.key, fs.readFileSync(parked), { mode: 0o600 });
    const before = f.hashes();
    assert.throws(f.read, { message: 'Disposable recovery intent does not match the exact native selection or bounded counters.' });
    assert.deepEqual(f.hashes(), before);
});

test('rejects changed native owner bytes without replacing the owner or rewriting any history', t => {
    const f = ownedFixture(t); fs.appendFileSync(f.owned[0].ownerPath, '\n');
    const before = f.hashes(); assert.throws(f.read, /owner|sealed/u); assert.deepEqual(f.hashes(), before);
});

test('rejects changed native task-mode run evidence and preserves the current artifacts', t => {
    const f = ownedFixture(t); assert.equal(f.read().remaining_bytes, 7);
    fs.appendFileSync(path.join(f.reviews, `${taskId}-task-mode.json`), '\n');
    const before = f.hashes();
    assert.throws(f.read, { message: 'Disposable registration does not match the canonical workspace, task, current native run or payload path.' });
    assert.deepEqual(f.hashes(), before);
});

test('rejects changed dependency queue before accepting old committed compact evidence', t => {
    const f = ownedFixture(t); assert.equal(f.read().remaining_bytes, 7);
    fs.appendFileSync(path.join(f.targetRoot, 'TASK.md'), '\n');
    const before = f.hashes();
    assert.throws(f.read, { message: 'Disposable recovery committed native compact evidence changed or is ineligible.' });
    assert.deepEqual(f.hashes(), before);
});

test('rejects benign selected dependency byte drift through original digest reconstruction', t => {
    const f = ownedFixture(t, 1, true); assert.equal(f.read().remaining_bytes, 7);
    fs.appendFileSync(f.dependency, '\n');
    const before = f.hashes();
    assert.throws(f.read, { message: 'Disposable recovery original ownership digest differs from current native dependencies.' });
    assert.deepEqual(f.hashes(), before);
});

test('rejects a new WIP dependency and preserves its real recovery record', t => {
    const f = ownedFixture(t), directory = path.join(f.runtime, 'wip', 'foreign'); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'manifest.json'); fs.writeFileSync(file, JSON.stringify({ source_task_id: taskId }));
    const before = computeFileSha256(file), retained = f.hashes();
    assert.throws(f.read, /WIP dependency/u); assert.equal(computeFileSha256(file), before); assert.deepEqual(f.hashes(), retained);
});

test('rejects an unauthenticated worker namespace and preserves its current entries', t => {
    const f = ownedFixture(t), directory = path.join(f.runtime, 'workers'); fs.mkdirSync(directory);
    const file = path.join(directory, 'owner.json'); fs.writeFileSync(file, '{}');
    const before = computeFileSha256(file), retained = f.hashes();
    assert.throws(f.read, /worker inventory/u); assert.equal(computeFileSha256(file), before); assert.deepEqual(f.hashes(), retained);
});

test('rejects selected raw hash references even after actual payload removal and retains failure evidence', t => {
    const f = ownedFixture(t); f.finish();
    const file = path.join(f.reviews, `${taskId}-raw.json`);
    fs.writeFileSync(file, JSON.stringify({ raw_sha256: JSON.parse(fs.readFileSync(f.journal, 'utf8')).intent.roots[0].inventory
        .find((entry: any) => !entry.directory).sha256 }));
    const before = computeFileSha256(file), retained = f.hashes();
    assert.throws(f.read, /references selected raw bytes/u);
    assert.equal(computeFileSha256(file), before); assert.deepEqual(f.hashes(), retained);
});

test('rejects corrupt progress without rewriting the signed native intent or remaining payload', t => {
    const f = ownedFixture(t); f.prefix(1);
    const file = path.join(f.directory, '00000000.json'), value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.progress.removed_bytes = 999; fs.writeFileSync(file, JSON.stringify(value));
    const before = f.hashes(); assert.throws(f.read, /progress.*malformed|authentication/u); assert.deepEqual(f.hashes(), before);
});

test('rejects copied identical progress bytes in a new ordinary object and preserves every retained frame', t => {
    const f = ownedFixture(t); f.prefix(1);
    const file = path.join(f.directory, '00000000.json'), parked = path.join(f.bundleRoot, 'parked-frame');
    fs.renameSync(file, parked); fs.writeFileSync(file, fs.readFileSync(parked));
    const before = f.hashes(); assert.throws(f.read, /creation|progress/u); assert.deepEqual(f.hashes(), before);
    assert.equal(computeFileSha256(file), computeFileSha256(parked));
});

test('rejects surviving payload mutation during bounded inventory before publishing a snapshot', t => {
    const f = ownedFixture(t), open = rawFs.openSync;
    let injected = false;
    t.mock.method(rawFs, 'openSync', (candidate: fs.PathLike, ...args: any[]) => {
        const descriptor = (open as any)(candidate, ...args);
        if (!injected && String(candidate) === f.binary) { injected = true; fs.writeFileSync(f.alpha, 'changed'); }
        return descriptor;
    });
    assert.throws(f.read, /changed|remaining member/u); assert.equal(injected, true);
    assert.equal(fs.readFileSync(f.alpha, 'utf8'), 'changed'); assert.deepEqual(fs.readFileSync(f.binary), Buffer.from([0, 1, 2, 3]));
});

test('rejects dependency drift during the final native metadata recheck and preserves the changed dependency', t => {
    const f = ownedFixture(t, 1, true), open = rawFs.openSync;
    assert.equal(f.read().remaining_bytes, 7);
    let payloadRead = false, injected = false;
    t.mock.method(rawFs, 'openSync', (candidate: fs.PathLike, ...args: any[]) => {
        const descriptor = (open as any)(candidate, ...args);
        if (String(candidate) === f.alpha) payloadRead = true;
        if (payloadRead && !injected && String(candidate) === f.journal) { injected = true; fs.appendFileSync(f.dependency, '\n'); }
        return descriptor;
    });
    assert.throws(f.read, /dependency evidence changed/u); assert.equal(injected, true);
    assert.ok(fs.readFileSync(f.dependency, 'utf8').endsWith('\n\n')); assert.equal(fs.readFileSync(f.alpha, 'utf8'), 'abc');
});
