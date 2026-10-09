import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startLocalUiServer } from '../../../src/reports/ui';
import { getBackupSnapshotsRoot, type BackupDeletionPreview, type BackupDeletionResult } from '../../../src/lifecycle/backups';
import { getRollbackRecordsPath, writeRollbackRecords } from '../../../src/lifecycle/common';
import { cleanupLocalUiTestResources, makeLocalUiTempRepo, writeLocalUiRepoFixture } from './local-ui-test-helpers';

function getUiActionAuditPath(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'ui-actions', 'audit.jsonl');
}

type PreviewPayload = Omit<BackupDeletionPreview, 'targetRoot'> & { status: string; irreversible: boolean };
type ResultPayload = Omit<BackupDeletionResult, 'targetRoot'> & { status: string };

async function fixture(actionsEnabled = true) {
    const repoRoot = makeLocalUiTempRepo();
    writeLocalUiRepoFixture(repoRoot);
    const ids = [1, 2, 3].map(day => `update-2026050${day}-010000-000`);
    const snapshots = ids.map(id => {
        const snapshot = path.join(getBackupSnapshotsRoot(repoRoot), id);
        const file = path.join(snapshot, 'garda-agent-orchestrator/VERSION');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, id + '\n');
        writeRollbackRecords(snapshot, [{ relativePath: 'garda-agent-orchestrator/VERSION', existed: true, pathType: 'file' }]);
        return snapshot;
    });
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled });
    const html = await (await fetch(server.url)).text();
    const token = html.match(/const actionToken = "([^"]+)";/u)?.[1];
    assert.ok(token);
    const headers = { 'content-type': 'application/json', origin: server.url.slice(0, -1), 'x-garda-action-token': token };
    const post = (payload: Record<string, unknown>, override = {}) => fetch(`${server.url}api/actions`, {
        method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify({ action_id: 'backup-delete-selected', ...payload })
    });
    const close = () => cleanupLocalUiTestResources({ repoRoot, server });
    return { repoRoot, ids, snapshots, post, close };
}

test('backup deletion HTTP rejects disabled actions and origin/token/content-type failures without removing snapshots', async () => {
    for (const actionsEnabled of [false, true]) {
        const f = await fixture(actionsEnabled);
        try {
            const overrides = actionsEnabled ? [{ origin: 'http://foreign.invalid' }, { 'x-garda-action-token': 'wrong' }, { 'content-type': 'text/plain' }] : [{}];
            for (const override of overrides) {
                const response = await f.post({ mode: 'execute', snapshot_ids: [f.ids[0]] }, override);
                assert.equal(response.status, 403);
                assert.ok(f.snapshots.every(snapshot => fs.existsSync(snapshot)));
            }
        } finally { await f.close(); }
    }
});

test('backup deletion HTTP rejects empty, duplicate, traversal, unknown selection and client-root overrides', async () => {
    const f = await fixture();
    try {
        for (const payload of [
            { snapshot_ids: [] }, { snapshot_ids: [f.ids[0], f.ids[0]] }, { snapshot_ids: '../outside' },
            { snapshot_ids: ['../outside'] }, { snapshot_ids: ['update-19990101-010000-000'] },
            { snapshot_ids: [f.ids[0]], targetRoot: f.repoRoot }, { snapshot_ids: [f.ids[0]], snapshot_path: f.snapshots[0] }
        ]) {
            const response = await f.post({ mode: 'preview', ...payload });
            assert.ok([400, 409].includes(response.status));
            assert.ok(f.snapshots.every(snapshot => fs.existsSync(snapshot)));
        }
        const preview = await (await f.post({ mode: 'preview', snapshot_ids: [f.ids[0]] })).json() as PreviewPayload;
        for (const mode of [['preview'], ['execute'], null, 1, {}, true]) {
            const invalid = await f.post({ mode, snapshot_ids: [f.ids[0]], confirmation_token: preview.confirmationToken });
            assert.equal(invalid.status, 400, 'non-string modes must never reach deletion');
            assert.ok(f.snapshots.every(snapshot => fs.existsSync(snapshot)));
        }
    } finally { await f.close(); }
});

test('backup deletion HTTP binds exact preview IDs and inventory, supports cancellation and requires final-point acknowledgement', async () => {
    const f = await fixture();
    try {
        const preview = await (await f.post({ mode: 'preview', snapshot_ids: [f.ids[0]] })).json() as PreviewPayload;
        assert.equal(preview.status, 'previewed');
        assert.deepEqual(preview.snapshotIds, [f.ids[0]]);
        assert.equal(preview.backups[0].id, f.ids[0]);
        assert.equal(preview.irreversible, true);
        assert.ok(preview.totalSizeBytes > 0);
        assert.ok(f.snapshots.every(snapshot => fs.existsSync(snapshot)), 'preview/cancel is read-only for snapshots');
        const execute = { mode: 'execute', snapshot_ids: [f.ids[0]], confirmation_token: preview.confirmationToken };
        assert.equal((await f.post(execute)).status, 409);
        assert.equal((await f.post({ ...execute, confirmation: 'DELETE SELECTED BACKUPS', snapshot_ids: [f.ids[1]] })).status, 409);
        fs.appendFileSync(path.join(f.snapshots[0], 'garda-agent-orchestrator/VERSION'), 'changed\n');
        assert.equal((await f.post({ ...execute, confirmation: 'DELETE SELECTED BACKUPS' })).status, 409);
        const final = await (await f.post({ mode: 'preview', snapshot_ids: f.ids })).json() as PreviewPayload;
        assert.equal(final.requiresFinalRecoveryPointConfirmation, true);
        assert.ok(final.warnings.length > 0);
        const all = { mode: 'execute', snapshot_ids: f.ids, confirmation_token: final.confirmationToken, confirmation: 'DELETE SELECTED BACKUPS' };
        assert.equal((await f.post(all)).status, 409);
        const response = await f.post({ ...all, confirm_final_recovery_point: true });
        assert.equal(response.status, 200);
        const result = await response.json() as ResultPayload;
        assert.equal(result.status, 'executed');
        assert.deepEqual(result.removedIds, f.ids);
        assert.equal(result.inventoryRefreshed, true);
        assert.deepEqual(result.inventory, []);
        const audit = fs.readFileSync(getUiActionAuditPath(f.repoRoot), 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line));
        const outcome = audit.at(-1);
        assert.equal(outcome.status, 'executed');
        assert.equal(outcome.result, 'SUCCESS');
        assert.deepEqual(outcome.requestedIds, f.ids);
        assert.deepEqual(outcome.removedIds, f.ids);
        assert.equal(outcome.inventoryRefreshed, true);
        assert.deepEqual(outcome.errors, []);
        assert.ok(audit.some(entry => entry.status === 'rejected'));
        assert.ok(f.snapshots.every(snapshot => !fs.existsSync(snapshot)));
    } finally { await f.close(); }
});

test('backup deletion HTTP reports denied removal truthfully and permits a fresh healthy preview in the same process', async t => {
    const f = await fixture();
    const mutableFs = require('node:fs') as typeof import('node:fs');
    const unlink = mutableFs.unlinkSync;
    try {
        const selection = [f.ids[0], f.ids[1]];
        const preview = await (await f.post({ mode: 'preview', snapshot_ids: selection })).json() as PreviewPayload;
        const blocked = getRollbackRecordsPath(f.snapshots[0]);
        const denial = t.mock.method(mutableFs, 'unlinkSync', (candidate: fs.PathLike) => {
            if (String(candidate) === blocked) throw Object.assign(new Error('HTTP regression removal denied'), { code: 'EACCES' });
            unlink(candidate);
        });
        const response = await f.post({ mode: 'execute', snapshot_ids: selection,
            confirmation_token: preview.confirmationToken, confirmation: 'DELETE SELECTED BACKUPS' });
        denial.mock.restore();
        const result = await response.json() as ResultPayload;
        assert.equal(response.status, 200);
        assert.equal(result.status, 'partial_failure');
        assert.deepEqual(result.requestedIds, selection);
        assert.deepEqual(result.removedIds, []);
        assert.ok(result.errors.length > 0);
        assert.equal(result.inventoryRefreshed, true);
        const outcome = JSON.parse(fs.readFileSync(getUiActionAuditPath(f.repoRoot), 'utf8').trim().split(/\r?\n/u).at(-1)!);
        assert.equal(outcome.status, 'partial_failure');
        assert.equal(outcome.result, result.result);
        assert.deepEqual(outcome.requestedIds, selection);
        assert.deepEqual(outcome.removedIds, []);
        assert.deepEqual(outcome.errors, result.errors);
        assert.equal(outcome.inventoryRefreshed, true);
        const retryResponse = await f.post({ mode: 'preview', snapshot_ids: [f.ids[1]] });
        assert.equal(retryResponse.status, 200);
        const retry = await retryResponse.json() as PreviewPayload;
        const removed = await (await f.post({ mode: 'execute', snapshot_ids: [f.ids[1]],
            confirmation_token: retry.confirmationToken, confirmation: 'DELETE SELECTED BACKUPS' })).json() as ResultPayload;
        assert.deepEqual(removed.removedIds, [f.ids[1]]);
        assert.ok(fs.existsSync(blocked));
        assert.ok(fs.existsSync(f.snapshots[2]));
    } finally { t.mock.restoreAll(); await f.close(); }
});


test('backup deletion HTTP preserves completed result when outcome audit writing fails', async t => {
    const f = await fixture();
    const mutableFs = require('node:fs') as typeof import('node:fs');
    const append = mutableFs.appendFileSync;
    try {
        const preview = await (await f.post({ mode: 'preview', snapshot_ids: [f.ids[0]] })).json() as PreviewPayload;
        const auditPath = getUiActionAuditPath(f.repoRoot);
        t.mock.method(mutableFs, 'appendFileSync', (...args: Parameters<typeof fs.appendFileSync>) => {
            if (String(args[0]) === auditPath && String(args[1]).includes('"status":"executed"')) {
                throw Object.assign(new Error('outcome audit denied'), { code: 'EACCES' });
            }
            return append(...args);
        });
        const response = await f.post({ mode: 'execute', snapshot_ids: [f.ids[0]],
            confirmation_token: preview.confirmationToken, confirmation: 'DELETE SELECTED BACKUPS' });
        const result = await response.json() as ResultPayload & { audit_error: string };
        assert.equal(response.status, 200);
        assert.equal(result.status, 'executed');
        assert.deepEqual(result.removedIds, [f.ids[0]]);
        assert.equal(result.inventoryRefreshed, true);
        assert.match(result.audit_error, /could not be persisted/u);
        assert.equal(fs.existsSync(f.snapshots[0]), false);
        assert.ok(f.snapshots.slice(1).every(snapshot => fs.existsSync(snapshot)));
        assert.match(fs.readFileSync(auditPath, 'utf8'), /"status":"execution_requested"/u);
    } finally { t.mock.restoreAll(); await f.close(); }
});


test('backup deletion HTTP rejects execution when initial intent audit cannot be persisted', async t => {
    const f = await fixture();
    const mutableFs = require('node:fs') as typeof import('node:fs');
    const append = mutableFs.appendFileSync;
    try {
        const selection = [f.ids[0], f.ids[1]];
        const preview = await (await f.post({ mode: 'preview', snapshot_ids: selection })).json() as PreviewPayload;
        const auditPath = getUiActionAuditPath(f.repoRoot);
        const previousAudit = fs.readFileSync(auditPath);
        const files = f.snapshots.flatMap(snapshot => [
            path.join(snapshot, 'garda-agent-orchestrator/VERSION'), getRollbackRecordsPath(snapshot)
        ]);
        const previousBytes = files.map(file => fs.readFileSync(file));
        t.mock.method(mutableFs, 'appendFileSync', (...args: Parameters<typeof fs.appendFileSync>) => {
            if (String(args[0]) === auditPath && String(args[1]).includes('"status":"execution_requested"')) {
                throw Object.assign(new Error('intent audit denied'), { code: 'EACCES' });
            }
            return append(...args);
        });
        const response = await f.post({ mode: 'execute', snapshot_ids: selection,
            confirmation_token: preview.confirmationToken, confirmation: 'DELETE SELECTED BACKUPS' });
        assert.equal(response.status, 503);
        assert.match(JSON.stringify(await response.json()), /backup_audit_unavailable/u);
        assert.deepEqual(fs.readFileSync(auditPath), previousAudit);
        assert.ok(f.snapshots.every(snapshot => fs.existsSync(snapshot)));
        files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), previousBytes[index]));
    } finally { t.mock.restoreAll(); await f.close(); }
});
