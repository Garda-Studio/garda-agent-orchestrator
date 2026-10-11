import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { previewOwnedDisposableArtifacts } from '../../../src/lifecycle/cleanup';
import { registerOwnedDisposableArtifact, sealOwnedDisposableArtifact } from '../../../src/lifecycle/cleanup/owned-disposable-artifact-registration';
import { assertOwnedDisposableSnapshotCurrent, buildOwnedDisposableArtifactSnapshot }
    from '../../../src/lifecycle/cleanup/owned-disposable-artifact-preview';
import { OWNED_DISPOSABLE_PREVIEW_LIMITS } from '../../../src/lifecycle/cleanup/owned-disposable-artifact-preview-contracts';
import { appendIntegrityEvent, computeFileSha256, writeArtifact, writeIntegrityEventSequence }
    from '../gates/task-audit/task-audit-summary-fixtures';
import { writeTaskQueue } from './cleanup-fixtures';
import { fixture, taskId } from './owned-disposable-artifact-fixtures';

test('exact dry-run inventories sealed exited producers and retains readable compact history', t => {
    const f = fixture(t), first = f.produce(), second = f.produce();
    const ledger = path.join(f.runtime, 'task-ledger', `${taskId}.json`), before = computeFileSha256(ledger);
    const preview = f.preview(second.registrationId, first.registrationId);
    assert.equal(preview.status, 'READY', preview.blockers.join('\n'));
    assert.equal(preview.file_count, 4); assert.equal(preview.total_bytes, 14);
    assert.match(preview.compact_evidence_sha256!, /^[0-9a-f]{64}$/u); assert.match(preview.ownership_digest!, /^[0-9a-f]{64}$/u);
    assert.equal(f.preview(first.registrationId, second.registrationId).ownership_digest, preview.ownership_digest);
    assert.equal(computeFileSha256(ledger), before); assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8')).verification.status, 'VERIFIED');
    assert.equal(fs.readFileSync(path.join(first.payloadPath, 'alpha.txt'), 'utf8'), 'abc');
    for (const item of preview.items) {
        assert.equal(item.state, 'eligible'); assert.equal(item.inventory.length, 4);
        assert.equal(item.inventory.filter(entry => entry.sha256).length, 2); assert.equal(item.bytes, 7);
    }
});

test('preview rejects unsealed, live and unknown ownership without adopting or deleting payloads', t => {
    const f = fixture(t), unsealed = f.produce(false);
    assert.match(f.preview(unsealed.registrationId).blockers.join(), /unsealed/u);
    const live = registerOwnedDisposableArtifact({ ...f.options, category: 'raw-stderr' });
    sealOwnedDisposableArtifact({ ...f.options, registrationId: live.registrationId });
    assert.match(f.preview(live.registrationId).blockers.join(), /live/u);
    const orphan = f.produce(); fs.unlinkSync(orphan.ownerPath);
    assert.match(f.preview(orphan.registrationId).blockers.join(), /missing/u);
    assert.equal(fs.existsSync(orphan.payloadPath), true); assert.equal(fs.existsSync(unsealed.payloadPath), true);
});

test('invalid, duplicate, path-selected and over-budget inputs never produce deletion authority', t => {
    const f = fixture(t), owned = f.produce();
    for (const ids of [[], ['../outside'], [owned.registrationId, owned.registrationId],
        Array.from({ length: OWNED_DISPOSABLE_PREVIEW_LIMITS.selectedRoots + 1 }, (_, index) => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`)]) {
        assert.equal(f.preview(...ids).ownership_digest, null);
    }
    assert.equal(previewOwnedDisposableArtifacts({ ...f.options, registrationIds: [owned.registrationId],
        path: owned.payloadPath } as never).status, 'BLOCKED');
});

test('rejects a sparse registration array without emitting null IDs or changing protected evidence', t => {
    const f = fixture(t), owned = f.produce(), registrationIds = new Array<string>(1);
    const protectedFiles = [owned.ownerPath, path.join(owned.payloadPath, 'alpha.txt'),
        path.join(f.runtime, 'task-ledger', `${taskId}.json`)];
    const hashes = protectedFiles.map(computeFileSha256);
    const preview = previewOwnedDisposableArtifacts({ ...f.options, registrationIds });
    assert.equal(preview.status, 'BLOCKED'); assert.equal(preview.ownership_digest, null);
    assert.deepEqual(preview.registration_ids, []); assert.deepEqual(preview.items, []);
    assert.deepEqual(JSON.parse(JSON.stringify(preview)).registration_ids, []);
    assert.equal(preview.compact_evidence_sha256, null);
    assert.deepEqual(protectedFiles.map(computeFileSha256), hashes);
});

test('rejects mixed valid and missing registration IDs before publishing partial items', t => {
    const f = fixture(t), owned = f.produce(), registrationIds = new Array<string>(2);
    registrationIds[0] = owned.registrationId;
    const protectedFiles = [owned.ownerPath, path.join(owned.payloadPath, 'alpha.txt'),
        path.join(f.runtime, 'task-ledger', `${taskId}.json`)];
    const hashes = protectedFiles.map(computeFileSha256);
    const preview = previewOwnedDisposableArtifacts({ ...f.options, registrationIds });
    assert.equal(preview.status, 'BLOCKED'); assert.equal(preview.ownership_digest, null);
    assert.deepEqual(preview.registration_ids, []); assert.deepEqual(preview.items, []);
    assert.deepEqual(JSON.parse(JSON.stringify(preview)).registration_ids, []);
    assert.equal(preview.compact_evidence_sha256, null);
    assert.deepEqual(protectedFiles.map(computeFileSha256), hashes);
});

test('missing compact authority never accepts a DONE row or caller-provided success', t => {
    const f = fixture(t), owned = f.produce();
    fs.unlinkSync(path.join(f.runtime, 'task-ledger', `${taskId}.json`));
    assert.equal(f.preview(owned.registrationId).status, 'BLOCKED');
    assert.equal(previewOwnedDisposableArtifacts({ ...f.options, registrationIds: [owned.registrationId],
        completed: { eligible: true } } as never).ownership_digest, null);
    assert.equal(fs.existsSync(owned.payloadPath), true);
});

test('rejects symlink, shared and nested repository payloads', t => {
    const f = fixture(t), repository = f.produce(), linked = f.produce(), shared = f.produce();
    fs.mkdirSync(path.join(repository.payloadPath, '.git'));
    fs.symlinkSync(path.join(f.targetRoot, 'example.txt'), path.join(linked.payloadPath, 'alias'));
    fs.linkSync(path.join(f.targetRoot, 'example.txt'), path.join(shared.payloadPath, 'alias'));
    assert.equal(f.preview(repository.registrationId).ownership_digest, null);
    assert.equal(f.preview(linked.registrationId).ownership_digest, null);
    assert.equal(f.preview(shared.registrationId).ownership_digest, null);
    assert.equal(fs.readFileSync(path.join(f.targetRoot, 'example.txt'), 'utf8'), 'accepted content\n');
});

test('rejects bare Git at the owned root while preserving repository and compact evidence', t => {
    const f = fixture(t), bare = f.produceBare(false);
    assert.equal(bare.before.preview.status, 'READY', bare.before.preview.blockers.join());
    assert.equal(bare.isBare(), 'true'); assert.equal(fs.existsSync(path.join(bare.repository, '.git')), false);
    const preview = f.preview(bare.owned.registrationId);
    assert.equal(preview.status, 'BLOCKED'); assert.equal(preview.ownership_digest, null);
    assert.equal(preview.items[0].state, 'protected'); assert.match(preview.blockers.join(), /bare.*Git repository/u);
    assert.throws(() => assertOwnedDisposableSnapshotCurrent(bare.before));
    assert.deepEqual(bare.protectedFiles.map(computeFileSha256), bare.hashes);
    assert.equal(fs.existsSync(path.join(bare.repository, 'objects')), true);
    assert.equal(fs.existsSync(path.join(bare.repository, 'refs')), true); assert.equal(bare.isBare(), 'true');
});

test('rejects bare Git under an arbitrary nested name while preserving repository and compact evidence', t => {
    const f = fixture(t), bare = f.produceBare(true);
    assert.equal(bare.before.preview.status, 'READY', bare.before.preview.blockers.join());
    assert.equal(bare.isBare(), 'true'); assert.equal(fs.existsSync(path.join(bare.repository, '.git')), false);
    const preview = f.preview(bare.owned.registrationId);
    assert.equal(preview.status, 'BLOCKED'); assert.equal(preview.ownership_digest, null);
    assert.equal(preview.items[0].state, 'protected'); assert.match(preview.blockers.join(), /bare.*Git repository/u);
    assert.throws(() => assertOwnedDisposableSnapshotCurrent(bare.before));
    assert.deepEqual(bare.protectedFiles.map(computeFileSha256), bare.hashes);
    assert.equal(fs.existsSync(path.join(bare.repository, 'objects')), true);
    assert.equal(fs.existsSync(path.join(bare.repository, 'refs')), true); assert.equal(bare.isBare(), 'true');
});

test('malformed dependency queue and oversized authority remain protected', t => {
    const f = fixture(t), owned = f.produce();
    fs.appendFileSync(path.join(f.targetRoot, 'TASK.md'), '| T-UNKNOWN | invalid interrupted dependency row |\n');
    assert.equal(f.preview(owned.registrationId).ownership_digest, null);
    writeTaskQueue(f.targetRoot, [{ id: taskId, status: 'DONE' }]);
    const oversized = path.join(f.reviews, `${taskId}-oversized-evidence.json`);
    fs.writeFileSync(oversized, '{}'); fs.truncateSync(oversized, OWNED_DISPOSABLE_PREVIEW_LIMITS.authorityFileBytes + 1);
    assert.equal(f.preview(owned.registrationId).ownership_digest, null);
    assert.equal(fs.existsSync(oversized), true);
});

for (const reason of ['active', 'uncommitted', 'missing-ledger', 'changed-ledger', 'later-failure'] as const) {
    test(`preserves disposable payload when native completed-task proof is ${reason}`, t => {
        const f = fixture(t), owned = f.produce(), ledger = path.join(f.runtime, 'task-ledger', `${taskId}.json`);
        if (reason === 'active') writeTaskQueue(f.targetRoot, [{ id: taskId, status: 'IN_PROGRESS' }]);
        if (reason === 'uncommitted') fs.writeFileSync(path.join(f.targetRoot, 'example.txt'), 'new unaccepted content');
        if (reason === 'missing-ledger') fs.unlinkSync(ledger);
        if (reason === 'changed-ledger') fs.writeFileSync(ledger, JSON.stringify({ ...JSON.parse(fs.readFileSync(ledger, 'utf8')), audit_status: 'FAILED' }));
        if (reason === 'later-failure') appendIntegrityEvent(f.events, taskId, { event_type: 'COMPILE_GATE_FAILED' });
        assert.equal(f.preview(owned.registrationId).status, 'BLOCKED'); assert.equal(fs.existsSync(owned.payloadPath), true);
    });
}

for (const kind of ['nested-git', 'symlink', 'hardlink', 'replacement', 'oversized'] as const) {
    test(`exact inventory rejects ${kind} descendants while preserving compact evidence`, t => {
        const f = fixture(t), owned = f.produce();
        if (kind === 'nested-git') fs.writeFileSync(path.join(owned.payloadPath, '.git'), 'gitdir: elsewhere');
        if (kind === 'symlink') fs.symlinkSync(path.join(f.targetRoot, 'example.txt'), path.join(owned.payloadPath, 'link'));
        if (kind === 'hardlink') fs.linkSync(path.join(f.targetRoot, 'example.txt'), path.join(owned.payloadPath, 'shared'));
        if (kind === 'replacement') { fs.renameSync(owned.payloadPath, owned.payloadPath + '-original'); fs.mkdirSync(owned.payloadPath); }
        if (kind === 'oversized') fs.closeSync(fs.openSync(path.join(owned.payloadPath, 'huge'), 'w'));
        if (kind === 'oversized') fs.truncateSync(path.join(owned.payloadPath, 'huge'), OWNED_DISPOSABLE_PREVIEW_LIMITS.fileBytes + 1);
        assert.equal(f.preview(owned.registrationId).status, 'BLOCKED'); assert.equal(fs.existsSync(owned.ownerPath), true);
        assert.equal(fs.existsSync(path.join(f.runtime, 'task-ledger', `${taskId}.json`)), true);
    });
}

test('unfinished follow-ups and authenticated active worker references block otherwise eligible roots', t => {
    const f = fixture(t), owned = f.produce();
    writeTaskQueue(f.targetRoot, [{ id: taskId, status: 'DONE' }, { id: `${taskId}-F1`, status: 'TODO' }]);
    assert.match(f.preview(owned.registrationId).blockers.join(), /follow-up/u);
    writeTaskQueue(f.targetRoot, [{ id: taskId, status: 'DONE' }, { id: 'T-OTHER', status: 'IN_PROGRESS' }]);
    writeIntegrityEventSequence(f.events, 'T-OTHER', [{ event_type: 'TASK_MODE_ENTERED', details: { worker_payload: owned.payloadPath } }]);
    assert.match(f.preview(owned.registrationId).blockers.join(), /worker/u);
});

test('WIP references and unknown separate worker inventories require explicit recovery', t => {
    const f = fixture(t), owned = f.produce(), wip = path.join(f.runtime, 'wip', 'T-OTHER');
    fs.mkdirSync(wip, { recursive: true }); fs.writeFileSync(path.join(wip, 'manifest.json'), JSON.stringify({ selected_payload: owned.payloadPath }));
    assert.match(f.preview(owned.registrationId).blockers.join(), /WIP/u);
    fs.rmSync(wip, { recursive: true }); fs.mkdirSync(path.join(f.runtime, 'workers'));
    fs.writeFileSync(path.join(f.runtime, 'workers', 'unknown.json'), '{}');
    assert.match(f.preview(owned.registrationId).blockers.join(), /worker inventory/u);
});

function escapedWipJson(value: Record<string, string>): string {
    return JSON.stringify(value).replace(/[a-z0-9]/giu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

test('rejects Unicode-escaped WIP JSON payload references while preserving recovery and compact evidence', t => {
    const f = fixture(t), owned = f.produce(), ledger = path.join(f.runtime, 'task-ledger', `${taskId}.json`);
    const raw = path.join(owned.payloadPath, 'alpha.txt'), before = [raw, ledger, owned.ownerPath].map(computeFileSha256);
    assert.equal(f.preview(owned.registrationId).status, 'READY');
    const wip = path.join(f.runtime, 'wip', 'T-OTHER', 'manifest.JSON'), encoded = escapedWipJson({ selected_payload: owned.payloadPath });
    assert.equal(JSON.parse(encoded).selected_payload, owned.payloadPath); assert.equal(encoded.includes(owned.payloadPath), false);
    fs.mkdirSync(path.dirname(wip), { recursive: true }); fs.writeFileSync(wip, encoded);
    const result = f.preview(owned.registrationId);
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.ownership_digest, null);
    assert.equal(result.items[0].state, 'protected'); assert.match(result.blockers.join(), /WIP/u);
    assert.deepEqual([raw, ledger, owned.ownerPath].map(computeFileSha256), before);
    assert.equal(fs.readFileSync(wip, 'utf8'), encoded);
});

test('rejects Unicode-escaped WIP JSONL raw hash references while preserving selected bytes', t => {
    const f = fixture(t), owned = f.produce(), raw = path.join(owned.payloadPath, 'alpha.txt');
    const ledger = path.join(f.runtime, 'task-ledger', `${taskId}.json`), before = [raw, ledger, owned.ownerPath].map(computeFileSha256);
    assert.equal(f.preview(owned.registrationId).status, 'READY');
    const hash = computeFileSha256(raw), wip = path.join(f.runtime, 'wip', 'T-OTHER', 'references.jsonl');
    const encoded = escapedWipJson({ raw_sha256: hash }), contents = '{}\n' + encoded + '\n';
    assert.equal(JSON.parse(encoded).raw_sha256, hash); assert.equal(encoded.includes(hash), false);
    fs.mkdirSync(path.dirname(wip), { recursive: true }); fs.writeFileSync(wip, contents);
    const result = f.preview(owned.registrationId);
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.ownership_digest, null);
    assert.equal(result.items[0].state, 'protected'); assert.match(result.blockers.join(), /WIP/u);
    assert.deepEqual([raw, ledger, owned.ownerPath].map(computeFileSha256), before);
    assert.equal(fs.readFileSync(wip, 'utf8'), contents);
});

test('rejects Unicode-escaped WIP JSON task dependencies while preserving recovery state', t => {
    const f = fixture(t), owned = f.produce(), raw = path.join(owned.payloadPath, 'alpha.txt');
    const ledger = path.join(f.runtime, 'task-ledger', `${taskId}.json`), before = [raw, ledger, owned.ownerPath].map(computeFileSha256);
    assert.equal(f.preview(owned.registrationId).status, 'READY');
    const wip = path.join(f.runtime, 'wip', 'T-OTHER', 'manifest.json'), encoded = escapedWipJson({ source_task_id: taskId });
    assert.equal(JSON.parse(encoded).source_task_id, taskId); assert.equal(encoded.includes(taskId), false);
    fs.mkdirSync(path.dirname(wip), { recursive: true }); fs.writeFileSync(wip, encoded);
    const result = f.preview(owned.registrationId);
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.ownership_digest, null);
    assert.equal(result.items[0].state, 'protected'); assert.match(result.blockers.join(), /WIP/u);
    assert.deepEqual([raw, ledger, owned.ownerPath].map(computeFileSha256), before);
    assert.equal(fs.readFileSync(wip, 'utf8'), encoded);
});

test('rejects malformed structured WIP authority while preserving disposable payloads', t => {
    const f = fixture(t), owned = f.produce(), raw = path.join(owned.payloadPath, 'alpha.txt');
    const ledger = path.join(f.runtime, 'task-ledger', `${taskId}.json`), before = [raw, ledger, owned.ownerPath].map(computeFileSha256);
    assert.equal(f.preview(owned.registrationId).status, 'READY');
    const wip = path.join(f.runtime, 'wip', 'T-OTHER', 'references.jsonl'), contents = '{}\n{\n';
    fs.mkdirSync(path.dirname(wip), { recursive: true }); fs.writeFileSync(wip, contents);
    const result = f.preview(owned.registrationId);
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.ownership_digest, null);
    assert.equal(result.items[0].state, 'protected'); assert.match(result.blockers.join(), /JSON/u);
    assert.deepEqual([raw, ledger, owned.ownerPath].map(computeFileSha256), before);
    assert.equal(fs.readFileSync(wip, 'utf8'), contents);
});

test('rejects unverified compact migration for hash-bound raw evidence', t => {
    const f = fixture(t), owned = f.produce(), raw = path.join(owned.payloadPath, 'alpha.txt');
    writeArtifact(f.reviews, taskId, '-raw-evidence.json', { task_id: taskId, raw_sha256: computeFileSha256(raw),
        migration: { verified: true, compact_ledger: 'self-declared' } });
    assert.match(f.preview(owned.registrationId).blockers.join(), /hash-bound raw/u);
    assert.equal(fs.readFileSync(raw, 'utf8'), 'abc');
});

test('stale selection digests and retained snapshot checks detect byte, membership and dependency drift', t => {
    const f = fixture(t), owned = f.produce(), selection = { ...f.options, registrationIds: [owned.registrationId] };
    const before = buildOwnedDisposableArtifactSnapshot(selection);
    assert.equal(before.preview.status, 'READY', before.preview.blockers.join());
    fs.writeFileSync(path.join(owned.payloadPath, 'alpha.txt'), 'changed bytes');
    assert.throws(() => assertOwnedDisposableSnapshotCurrent(before), /changed/u);
    const after = buildOwnedDisposableArtifactSnapshot(selection);
    assert.equal(after.preview.status, 'READY', after.preview.blockers.join());
    assert.notEqual(after.preview.ownership_digest, before.preview.ownership_digest);
    fs.writeFileSync(path.join(owned.payloadPath, 'new.txt'), 'new');
    assert.throws(() => assertOwnedDisposableSnapshotCurrent(after), /changed/u);
    const next = buildOwnedDisposableArtifactSnapshot(selection);
    fs.mkdirSync(path.join(f.runtime, 'workers'));
    assert.throws(() => assertOwnedDisposableSnapshotCurrent(next), /changed/u);
});

test('copied private registrations cannot establish ownership in a different workspace', t => {
    const f = fixture(t), owned = f.produce(), other = fs.mkdtempSync(path.join(os.tmpdir(), 'disposable-foreign-'));
    t.after(() => fs.rmSync(other, { recursive: true, force: true }));
    fs.cpSync(f.targetRoot, other, { recursive: true });
    const result = previewOwnedDisposableArtifacts({ targetRoot: other, bundleRoot: path.join(other, 'garda-agent-orchestrator'),
        taskId, registrationIds: [owned.registrationId] });
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.ownership_digest, null);
});
