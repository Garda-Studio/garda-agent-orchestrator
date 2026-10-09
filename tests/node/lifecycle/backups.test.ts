import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const mutableFs = require('node:fs') as typeof fs;

import {
    createBackupSnapshot,
    deleteSelectedBackups,
    DEFAULT_BACKUP_KEEP_LATEST,
    getBackupSnapshotsRoot,
    listBackups,
    previewBackupDeletion,
    pruneBackups,
    resolveBackupRestoreSnapshotPath
} from '../../../src/lifecycle/backups';
import {
    getRollbackRecordsPath,
    removePathRecursive,
    withLifecycleOperationLock,
    writeRollbackRecords
} from '../../../src/lifecycle/common';

function makeWorkspace(prefix: string) {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
    return { targetRoot, bundleRoot };
}

function seedRollbackSnapshot(targetRoot: string, name: string): string {
    const snapshotPath = path.join(
        targetRoot,
        'garda-agent-orchestrator',
        'runtime',
        'update-rollbacks',
        name
    );
    const versionPath = path.join(snapshotPath, 'garda-agent-orchestrator', 'VERSION');
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, `${name}\n`, 'utf8');
    writeRollbackRecords(snapshotPath, [
        {
            relativePath: 'garda-agent-orchestrator/VERSION',
            existed: true,
            pathType: 'file'
        }
    ]);
    return snapshotPath;
}

describe('backup backend inventory', () => {
    it('lists existing update scheduled and manual backups with restore metadata and size', () => {
        const { targetRoot, bundleRoot } = makeWorkspace('gao-backups-list-');
        try {
            const updateSnapshotPath = seedRollbackSnapshot(targetRoot, 'update-20260501-010000-000');
            const scheduled = createBackupSnapshot({
                targetRoot,
                bundleRoot,
                reason: 'scheduled',
                timestamp: '20260502-010000-000'
            });
            const manual = createBackupSnapshot({
                targetRoot,
                bundleRoot,
                reason: 'manual',
                timestamp: '20260502-020000-000'
            });

            const backups = listBackups(targetRoot);
            assert.equal(backups.length, 3);
            assert.deepEqual(
                backups.map((backup) => backup.reason).sort(),
                ['manual', 'scheduled', 'update']
            );

            const update = backups.find((backup) => backup.reason === 'update');
            assert.ok(update, 'update backup must be listed');
            assert.equal(update.snapshotPath, updateSnapshotPath);
            assert.equal(update.restoreSnapshotPath, updateSnapshotPath);
            assert.equal(update.health, 'AVAILABLE');
            assert.equal(update.recordCount, 1);
            assert.ok(update.sizeBytes > 0, 'update backup size should be reported');
            assert.equal(resolveBackupRestoreSnapshotPath(targetRoot, update.id), update.snapshotPath);
            assert.equal(resolveBackupRestoreSnapshotPath(targetRoot, update.relativeSnapshotPath), update.snapshotPath);

            assert.equal(scheduled.reason, 'scheduled');
            assert.equal(fs.existsSync(getRollbackRecordsPath(scheduled.snapshotPath)), true);
            assert.equal(scheduled.health, 'AVAILABLE');
            assert.ok(scheduled.sizeBytes > 0, 'scheduled backup size should be reported');
            assert.equal(manual.reason, 'manual');
            assert.equal(manual.health, 'AVAILABLE');
            assert.equal(resolveBackupRestoreSnapshotPath(targetRoot, manual.id), manual.snapshotPath);
        } finally {
            removePathRecursive(targetRoot);
        }
    });

    it('diagnoses missing records and refuses restore bridge for unrestorable backups', () => {
        const { targetRoot } = makeWorkspace('gao-backups-health-');
        try {
            const brokenSnapshotPath = path.join(
                targetRoot,
                'garda-agent-orchestrator',
                'runtime',
                'update-rollbacks',
                'scheduled-20260503-010000-000'
            );
            fs.mkdirSync(brokenSnapshotPath, { recursive: true });

            const [backup] = listBackups(targetRoot);
            assert.equal(backup.id, 'scheduled-20260503-010000-000');
            assert.equal(backup.reason, 'scheduled');
            assert.equal(backup.health, 'MISSING_RECORDS');
            assert.match(backup.healthMessage || '', /Rollback records file not found/);
            assert.throws(
                () => resolveBackupRestoreSnapshotPath(targetRoot, backup.id),
                /not restorable/
            );
        } finally {
            removePathRecursive(targetRoot);
        }
    });

    it('prunes the oldest backup when the default latest-ten retention is exceeded', () => {
        const { targetRoot, bundleRoot } = makeWorkspace('gao-backups-prune-');
        try {
            for (let day = 1; day <= DEFAULT_BACKUP_KEEP_LATEST + 1; day += 1) {
                seedRollbackSnapshot(targetRoot, `update-202605${String(day).padStart(2, '0')}-010000-000`);
            }

            const result = pruneBackups({ targetRoot, bundleRoot });
            assert.equal(result.result, 'SUCCESS');
            assert.equal(result.keepLatest, DEFAULT_BACKUP_KEEP_LATEST);
            assert.equal(result.removed.length, 1);
            assert.equal(result.removed[0].reason, 'count');

            const oldestPath = path.join(
                targetRoot,
                'garda-agent-orchestrator',
                'runtime',
                'update-rollbacks',
                'update-20260501-010000-000'
            );
            assert.equal(fs.existsSync(oldestPath), false, 'oldest backup should be pruned');
            assert.equal(listBackups(targetRoot).length, DEFAULT_BACKUP_KEEP_LATEST);
        } finally {
            removePathRecursive(targetRoot);
        }
    });
});

function snapshotFiles(root: string): Map<string, number> {
    const files = new Map<string, number>();
    const pending = [root];
    while (pending.length > 0) {
        const current = pending.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const candidate = path.join(current, entry.name);
            if (entry.isDirectory()) pending.push(candidate);
            else files.set(candidate, fs.lstatSync(candidate).size);
        }
    }
    return files;
}

function deletionWorkspace() {
    const workspace = makeWorkspace('gao-backups-selected-delete-');
    const ids = [1, 2, 3].map(day => `update-2026050${day}-010000-000`);
    const snapshots = ids.map(id => seedRollbackSnapshot(workspace.targetRoot, id));
    return { ...workspace, ids, snapshots };
}

function seedPopulatedDirectoryRecords(snapshotPath: string): string {
    const directory = 'garda-agent-orchestrator/live/docs';
    const payload = path.join(snapshotPath, directory, 'nested', 'payload.txt');
    fs.mkdirSync(path.dirname(payload), { recursive: true });
    fs.mkdirSync(path.join(snapshotPath, directory, 'empty'));
    fs.writeFileSync(payload, 'preserved recovery payload');
    writeRollbackRecords(snapshotPath, [
        { relativePath: 'garda-agent-orchestrator/VERSION', existed: true, pathType: 'file' },
        { relativePath: directory, existed: true, pathType: 'directory' },
        { relativePath: 'garda-agent-orchestrator/absent.txt', existed: false, pathType: 'missing' }
    ]);
    return payload;
}

describe('guarded selected backup deletion', () => {
    it('projects missing records into deletion health and final recovery-point confirmation', () => {
        const { targetRoot, ids, snapshots } = deletionWorkspace();
        try {
            fs.unlinkSync(getRollbackRecordsPath(snapshots[0]));
            const broken = previewBackupDeletion({ targetRoot, snapshotIds: [ids[0]] });
            assert.equal(broken.backups[0].health, 'MISSING_RECORDS');
            assert.equal(broken.backups[0].recordCount, 0);
            assert.match(broken.backups[0].healthMessage || '', /records file not found/iu);
            assert.equal(broken.lostRecoveryPointCount, 0);
            assert.equal(broken.remainingRecoveryPointCount, 2);
            assert.equal(broken.requiresFinalRecoveryPointConfirmation, false);
            const healthy = previewBackupDeletion({ targetRoot, snapshotIds: ids.slice(1) });
            assert.equal(healthy.lostRecoveryPointCount, 2);
            assert.equal(healthy.remainingRecoveryPointCount, 0);
            assert.equal(healthy.requiresFinalRecoveryPointConfirmation, true);
            assert.throws(() => deleteSelectedBackups({ targetRoot, snapshotIds: healthy.snapshotIds,
                confirmationToken: healthy.confirmationToken, confirm: true }), /final recovery point/iu);
            const removed = deleteSelectedBackups({ targetRoot, snapshotIds: broken.snapshotIds,
                confirmationToken: broken.confirmationToken, confirm: true });
            assert.equal(removed.result, 'SUCCESS');
            assert.deepEqual(removed.removedIds, [ids[0]]);
            assert.equal(removed.totalFreedBytes, broken.totalSizeBytes);
            assert.equal(removed.inventory.every(backup => backup.health === 'AVAILABLE'), true);
            assert.equal(resolveBackupRestoreSnapshotPath(targetRoot, ids[1]), snapshots[1]);
        } finally { removePathRecursive(targetRoot); }
    });

    it('counts populated directory and missing rollback records as a healthy recovery point', () => {
        const { targetRoot, ids, snapshots } = deletionWorkspace();
        try {
            const payload = seedPopulatedDirectoryRecords(snapshots[0]);
            const before = snapshotFiles(targetRoot);
            const preview = previewBackupDeletion({ targetRoot, snapshotIds: [ids[0]] });
            assert.equal(preview.backups[0].health, 'AVAILABLE');
            assert.equal(preview.backups[0].recordCount, 3);
            assert.equal(preview.lostRecoveryPointCount, 1);
            assert.equal(preview.remainingRecoveryPointCount, 2);
            assert.equal(preview.requiresFinalRecoveryPointConfirmation, false);
            assert.deepEqual(snapshotFiles(targetRoot), before);
            const all = previewBackupDeletion({ targetRoot, snapshotIds: ids });
            assert.equal(all.lostRecoveryPointCount, 3);
            assert.equal(all.requiresFinalRecoveryPointConfirmation, true);
            const result = deleteSelectedBackups({ targetRoot, snapshotIds: preview.snapshotIds,
                confirmationToken: preview.confirmationToken, confirm: true });
            assert.equal(result.result, 'SUCCESS');
            assert.deepEqual(result.removedIds, [ids[0]]);
            assert.equal(result.totalFreedBytes, preview.totalSizeBytes);
            assert.equal(fs.existsSync(payload), false);
            assert.equal(fs.existsSync(snapshots[0]), false);
            assert.equal(resolveBackupRestoreSnapshotPath(targetRoot, ids[1]), snapshots[1]);
        } finally { removePathRecursive(targetRoot); }
    });

    it('excludes changed nested directory payload from healthy recovery-point counts', () => {
        const { targetRoot, ids, snapshots } = deletionWorkspace();
        try {
            const payload = seedPopulatedDirectoryRecords(snapshots[0]);
            const healthy = previewBackupDeletion({ targetRoot, snapshotIds: [ids[0]] });
            assert.equal(healthy.backups[0].health, 'AVAILABLE');
            fs.writeFileSync(payload, 'changed nested recovery payload');
            const corrupt = previewBackupDeletion({ targetRoot, snapshotIds: [ids[0]] });
            assert.equal(corrupt.backups[0].health, 'INVALID_RECORDS');
            assert.match(corrupt.backups[0].healthMessage || '', /integrity mismatch/iu);
            assert.equal(corrupt.lostRecoveryPointCount, 0);
            assert.equal(corrupt.remainingRecoveryPointCount, 2);
            assert.equal(corrupt.requiresFinalRecoveryPointConfirmation, false);
            const final = previewBackupDeletion({ targetRoot, snapshotIds: ids.slice(1) });
            assert.equal(final.lostRecoveryPointCount, 2);
            assert.equal(final.remainingRecoveryPointCount, 0);
            assert.equal(final.requiresFinalRecoveryPointConfirmation, true);
            assert.throws(() => deleteSelectedBackups({ targetRoot, snapshotIds: healthy.snapshotIds,
                confirmationToken: healthy.confirmationToken, confirm: true }), /selection.*changed|token/iu);
            assert.equal(fs.readFileSync(payload, 'utf8'), 'changed nested recovery payload');
        } finally { removePathRecursive(targetRoot); }
    });

    it('previews exact selection, health, loss and bytes without modifying runtime state', () => {
        const { targetRoot, ids } = deletionWorkspace();
        try {
            const before = snapshotFiles(targetRoot);
            const preview = previewBackupDeletion({ targetRoot, snapshotIds: [ids[1], ids[0]] });
            assert.deepEqual(preview.snapshotIds, [ids[0], ids[1]]);
            assert.deepEqual(preview.backups.map(backup => backup.id), [ids[0], ids[1]]);
            assert.equal(preview.backups.every(backup => backup.health === 'AVAILABLE'), true);
            assert.equal(preview.lostRecoveryPointCount, 2);
            assert.equal(preview.remainingRecoveryPointCount, 1);
            assert.equal(preview.requiresFinalRecoveryPointConfirmation, false);
            assert.equal(preview.totalSizeBytes, preview.backups.reduce((sum, backup) => sum + backup.sizeBytes, 0));
            assert.match(preview.confirmationToken, /^[a-f0-9]{64}$/u);
            assert.equal(preview.confirmationToken,
                previewBackupDeletion({ targetRoot, snapshotIds: [ids[0], ids[1]] }).confirmationToken);
            assert.deepEqual(snapshotFiles(targetRoot), before);
        } finally { removePathRecursive(targetRoot); }
    });

    it('removes only explicitly selected snapshots and owned metadata and refreshes inventory', () => {
        const { targetRoot, ids, snapshots } = deletionWorkspace();
        try {
            const unrelated = path.join(getBackupSnapshotsRoot(targetRoot), 'unrelated-preserved', 'evidence.txt');
            fs.mkdirSync(path.dirname(unrelated), { recursive: true });
            fs.writeFileSync(unrelated, 'preserved');
            const preview = previewBackupDeletion({ targetRoot, snapshotIds: [ids[0], ids[2]] });
            const result = deleteSelectedBackups({
                targetRoot, snapshotIds: preview.snapshotIds, confirmationToken: preview.confirmationToken, confirm: true
            });
            assert.equal(result.result, 'SUCCESS');
            assert.deepEqual(result.removedIds, [ids[0], ids[2]]);
            assert.deepEqual(result.errors, []);
            assert.equal(result.totalFreedBytes, preview.totalSizeBytes);
            assert.equal(result.inventoryRefreshed, true);
            assert.deepEqual(result.inventory.map(backup => backup.id), [ids[1]]);
            assert.equal(fs.existsSync(snapshots[0]), false);
            assert.equal(fs.existsSync(snapshots[2]), false);
            assert.equal(resolveBackupRestoreSnapshotPath(targetRoot, ids[1]), snapshots[1]);
            assert.equal(fs.readFileSync(unrelated, 'utf8'), 'preserved');
        } finally { removePathRecursive(targetRoot); }
    });

    it('requires explicit confirmation, matching selection token and separate final recovery point confirmation', () => {
        const { targetRoot, ids, snapshots } = deletionWorkspace();
        try {
            const preview = previewBackupDeletion({ targetRoot, snapshotIds: ids });
            assert.equal(preview.requiresFinalRecoveryPointConfirmation, true);
            assert.equal(preview.remainingRecoveryPointCount, 0);
            assert.match(preview.warnings.join(' '), /final recovery point/iu);
            const request = { targetRoot, snapshotIds: ids, confirmationToken: preview.confirmationToken, confirm: true };
            assert.throws(() => deleteSelectedBackups({ ...request, confirm: false }), /confirmation/iu);
            assert.throws(() => deleteSelectedBackups({ ...request, confirmationToken: '0'.repeat(64) }), /selection.*changed|token/iu);
            assert.throws(() => deleteSelectedBackups(request), /final recovery point/iu);
            assert.equal(snapshots.every(snapshot => fs.existsSync(snapshot)), true);
            const result = deleteSelectedBackups({ ...request, confirmFinalRecoveryPoint: true });
            assert.equal(result.result, 'SUCCESS');
            assert.deepEqual(result.inventory, []);
        } finally { removePathRecursive(targetRoot); }
    });

    it('rejects paths, empty, duplicate, sparse and missing IDs before removing any snapshot', () => {
        const { targetRoot, ids, snapshots } = deletionWorkspace();
        try {
            const sparse = new Array<string>(2); sparse[1] = ids[0];
            for (const snapshotIds of [[], [ids[0], ids[0]], sparse, ['../' + ids[0]], [snapshots[0]], ['missing'], ['manual-20260509-010000-000']]) {
                assert.throws(() => previewBackupDeletion({ targetRoot, snapshotIds }), /snapshot|selection|ID/iu);
            }
            const preview = previewBackupDeletion({ targetRoot, snapshotIds: [ids[0]] });
            assert.throws(() => deleteSelectedBackups({
                targetRoot, snapshotIds: [ids[1]], confirmationToken: preview.confirmationToken, confirm: true
            }), /selection.*changed|token/iu);
            assert.equal(snapshots.every(snapshot => fs.existsSync(snapshot)), true);
        } finally { removePathRecursive(targetRoot); }
    });

    it('rejects foreign-target replay of a confirmation token even with equivalent snapshot payloads', () => {
        const first = deletionWorkspace(); const second = deletionWorkspace();
        try {
            const preview = previewBackupDeletion({ targetRoot: first.targetRoot, snapshotIds: [first.ids[0]] });
            assert.throws(() => deleteSelectedBackups({
                targetRoot: second.targetRoot, snapshotIds: [second.ids[0]],
                confirmationToken: preview.confirmationToken, confirm: true
            }), /selection.*changed|token/iu);
            assert.equal(fs.existsSync(second.snapshots[0]), true);
        } finally { removePathRecursive(first.targetRoot); removePathRecursive(second.targetRoot); }
    });

    it('rejects missing or physically replaced snapshots after preview without touching replacement bytes', () => {
        let rejectedCases = 0;
        for (const replace of [false, true]) {
            const { targetRoot, ids, snapshots } = deletionWorkspace();
            try {
                const preview = previewBackupDeletion({ targetRoot, snapshotIds: [ids[0]] });
                fs.renameSync(snapshots[0], path.join(targetRoot, 'preserved-original'));
                if (replace) seedRollbackSnapshot(targetRoot, ids[0]);
                assert.throws(() => deleteSelectedBackups({
                    targetRoot, snapshotIds: [ids[0]], confirmationToken: preview.confirmationToken, confirm: true
                }), /missing|not found|selection.*changed|token/iu);
                assert.equal(fs.existsSync(path.join(targetRoot, 'preserved-original')), true);
                if (replace) assert.equal(fs.existsSync(snapshots[0]), true);
                rejectedCases += 1;
            } finally { removePathRecursive(targetRoot); }
        }
        assert.equal(rejectedCases, 2);
    });

    it('rejects altered bytes and same-byte file replacements after preview', () => {
        let rejectedCases = 0;
        for (const sameBytes of [false, true]) {
            const { targetRoot, ids, snapshots } = deletionWorkspace();
            try {
                const file = path.join(snapshots[0], 'garda-agent-orchestrator', 'VERSION');
                const original = fs.readFileSync(file); const stat = fs.statSync(file);
                const preview = previewBackupDeletion({ targetRoot, snapshotIds: [ids[0]] });
                if (sameBytes) { fs.renameSync(file, path.join(targetRoot, 'preserved-version')); fs.writeFileSync(file, original); }
                else fs.writeFileSync(file, Buffer.alloc(original.length, 120));
                fs.utimesSync(file, stat.atime, stat.mtime);
                assert.throws(() => deleteSelectedBackups({
                    targetRoot, snapshotIds: [ids[0]], confirmationToken: preview.confirmationToken, confirm: true
                }), /selection.*changed|token/iu);
                assert.equal(fs.existsSync(file), true);
                rejectedCases += 1;
            } finally { removePathRecursive(targetRoot); }
        }
        assert.equal(rejectedCases, 2);
    });

    it('diagnoses corrupt snapshot health and preserves healthy recovery points during explicit corrupt deletion', () => {
        const { targetRoot, ids, snapshots } = deletionWorkspace();
        try {
            fs.writeFileSync(getRollbackRecordsPath(snapshots[0]), '{invalid');
            const preview = previewBackupDeletion({ targetRoot, snapshotIds: [ids[0]] });
            assert.equal(preview.backups[0].health, 'INVALID_RECORDS');
            assert.equal(preview.lostRecoveryPointCount, 0);
            assert.equal(preview.remainingRecoveryPointCount, 2);
            const result = deleteSelectedBackups({
                targetRoot, snapshotIds: [ids[0]], confirmationToken: preview.confirmationToken, confirm: true
            });
            assert.equal(result.result, 'SUCCESS');
            assert.equal(resolveBackupRestoreSnapshotPath(targetRoot, ids[1]), snapshots[1]);
        } finally { removePathRecursive(targetRoot); }
    });

    it('rejects a linked inventory root, linked payload, hard links and nested repository boundaries', (t) => {
        const rejectedCases: string[] = [];
        for (const unsafe of ['inventory-link', 'payload-link', 'hard-link', 'nested-repository']) {
            const { targetRoot, ids, snapshots } = deletionWorkspace();
            const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-backup-foreign-'));
            try {
                const foreign = path.join(outside, 'foreign.txt'); fs.writeFileSync(foreign, 'foreign-preserved');
                if (unsafe === 'inventory-link') {
                    const inventory = getBackupSnapshotsRoot(targetRoot);
                    fs.renameSync(inventory, path.join(targetRoot, 'preserved-inventory'));
                    fs.symlinkSync(outside, inventory, process.platform === 'win32' ? 'junction' : 'dir');
                } else if (unsafe === 'payload-link') {
                    if (process.platform === 'win32') { t.diagnostic('File-symlink negative is Linux-only; Windows junction negative remains active.'); continue; }
                    fs.symlinkSync(foreign, path.join(snapshots[0], 'foreign-link'));
                } else if (unsafe === 'hard-link') fs.linkSync(foreign, path.join(snapshots[0], 'foreign-hard-link'));
                else fs.mkdirSync(path.join(snapshots[0], '.git'));
                assert.throws(() => previewBackupDeletion({ targetRoot, snapshotIds: [ids[0]] }), /symlink|junction|hard.link|repository/iu);
                assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign-preserved');
                rejectedCases.push(unsafe);
            } finally { removePathRecursive(targetRoot); removePathRecursive(outside); }
        }
        assert.deepEqual(rejectedCases, process.platform === 'win32'
            ? ['inventory-link', 'hard-link', 'nested-repository']
            : ['inventory-link', 'payload-link', 'hard-link', 'nested-repository']);
    });

    it('rejects concurrent backup, restore and update, including same-process lock re-entry', () => {
        const { targetRoot, ids, snapshots } = deletionWorkspace();
        try {
            const preview = previewBackupDeletion({ targetRoot, snapshotIds: [ids[0]] });
            for (const operation of ['backup', 'restore', 'update']) {
                withLifecycleOperationLock(targetRoot, operation, () => {
                    assert.throws(() => previewBackupDeletion({ targetRoot, snapshotIds: [ids[0]] }), /active lifecycle|lifecycle operation/iu);
                    assert.throws(() => deleteSelectedBackups({
                        targetRoot, snapshotIds: [ids[0]], confirmationToken: preview.confirmationToken, confirm: true
                    }), /active lifecycle|lifecycle operation/iu);
                });
            }
            assert.equal(snapshots.every(snapshot => fs.existsSync(snapshot)), true);
        } finally { removePathRecursive(targetRoot); }
    });

    it('makes direct backup create and retention callers honor a real process-owned deletion lock', () => {
        const { targetRoot, bundleRoot, ids } = deletionWorkspace();
        try {
            const backend = path.resolve(__dirname, '../../../src/lifecycle/backups.js');
            withLifecycleOperationLock(targetRoot, 'backup-delete', () => {
                for (const operation of ['createBackupSnapshot', 'pruneBackups']) {
                    const options = { targetRoot, bundleRoot, reason: 'manual', timestamp: '20260509-010000-000', keepLatest: 0 };
                    const result = spawnSync(process.execPath, ['-e',
                        `require(${JSON.stringify(backend)})[${JSON.stringify(operation)}](${JSON.stringify(options)});`
                    ], { encoding: 'utf8', timeout: 20_000 });
                    assert.equal(result.error, undefined);
                    assert.notEqual(result.status, 0);
                    assert.match(result.stderr, /lifecycle.*lock|another lifecycle operation/iu);
                }
            });
            assert.deepEqual(listBackups(targetRoot).map(backup => backup.id).sort(), ids);
        } finally { removePathRecursive(targetRoot); }
    });

    it('preserves successful removal accounting and unrelated backups when the final inventory refresh fails', (t) => {
        const { targetRoot, ids, snapshots } = deletionWorkspace();
        const openDirectory = mutableFs.opendirSync;
        try {
            const untouched = new Map([...snapshotFiles(snapshots[1]), ...snapshotFiles(snapshots[2])]
                .map(([file]) => [file, fs.readFileSync(file)] as const));
            const preview = previewBackupDeletion({ targetRoot, snapshotIds: [ids[0]] });
            assert.ok(preview.totalSizeBytes > 0);
            let deniedRefreshes = 0;
            const denial = t.mock.method(mutableFs, 'opendirSync', (...args: Parameters<typeof openDirectory>) => {
                if (String(args[0]) === getBackupSnapshotsRoot(targetRoot) && !fs.existsSync(snapshots[0])) {
                    deniedRefreshes += 1;
                    throw Object.assign(new Error('final backup inventory refresh denied'), { code: 'EACCES' });
                }
                return openDirectory(...args);
            });
            const result = deleteSelectedBackups({ targetRoot, snapshotIds: preview.snapshotIds,
                confirmationToken: preview.confirmationToken, confirm: true });
            denial.mock.restore();
            assert.equal(deniedRefreshes, 1);
            assert.equal(result.result, 'ERRORS');
            assert.deepEqual(result.requestedIds, [ids[0]]);
            assert.deepEqual(result.removedIds, [ids[0]]);
            assert.equal(result.totalFreedBytes, preview.totalSizeBytes);
            assert.deepEqual(result.errors, []);
            assert.equal(result.inventoryRefreshed, false);
            assert.match(result.inventoryError!, /final backup inventory refresh denied/u);
            assert.deepEqual(result.inventory, []);
            assert.equal(fs.existsSync(snapshots[0]), false);
            assert.deepEqual(listBackups(targetRoot).map(backup => backup.id).sort(), ids.slice(1));
            for (const [file, bytes] of untouched) assert.deepEqual(fs.readFileSync(file), bytes);
        } finally { t.mock.restoreAll(); removePathRecursive(targetRoot); }
    });

    it('reports exact successful unlink bytes on permission failure and preserves unattempted and unselected snapshots', (t) => {
        const { targetRoot, ids, snapshots } = deletionWorkspace();
        const unlink = mutableFs.unlinkSync;
        try {
            const before = snapshotFiles(snapshots[0]); const blocked = getRollbackRecordsPath(snapshots[0]);
            const preview = previewBackupDeletion({ targetRoot, snapshotIds: [ids[0], ids[1]] });
            t.mock.method(mutableFs, 'unlinkSync', (candidate: fs.PathLike) => {
                if (String(candidate) === blocked) throw Object.assign(new Error('selected permission failure'), { code: 'EACCES' });
                unlink(candidate);
            });
            const result = deleteSelectedBackups({
                targetRoot, snapshotIds: preview.snapshotIds, confirmationToken: preview.confirmationToken, confirm: true
            });
            assert.equal(result.result, 'ERRORS');
            assert.deepEqual(result.removedIds, []);
            assert.equal(result.errors.length, 2);
            assert.match(result.errors[0].message, /permission failure/iu);
            assert.equal(result.totalFreedBytes,
                [...before].filter(([file]) => !fs.existsSync(file)).reduce((sum, [, bytes]) => sum + bytes, 0));
            assert.equal(fs.existsSync(blocked), true);
            assert.equal(resolveBackupRestoreSnapshotPath(targetRoot, ids[1]), snapshots[1]);
            assert.equal(resolveBackupRestoreSnapshotPath(targetRoot, ids[2]), snapshots[2]);
        } finally { t.mock.restoreAll(); removePathRecursive(targetRoot); }
    });

    for (const code of ['EACCES', 'EPERM']) {
        it(`refreshes and retries healthy unattempted selections in the same process after ${code}`, (t) => {
            const { targetRoot, ids, snapshots } = deletionWorkspace();
            const unlink = mutableFs.unlinkSync;
            try {
                const untouched = new Map([...snapshotFiles(snapshots[1]), ...snapshotFiles(snapshots[2])]
                    .map(([file]) => [file, fs.readFileSync(file)]));
                const original = snapshotFiles(snapshots[0]);
                const blocked = getRollbackRecordsPath(snapshots[0]);
                const preview = previewBackupDeletion({ targetRoot, snapshotIds: [ids[0], ids[1]] });
                const denial = t.mock.method(mutableFs, 'unlinkSync', (candidate: fs.PathLike) => {
                    if (String(candidate) === blocked) throw Object.assign(new Error('recoverable backup permission denial'), { code });
                    unlink(candidate);
                });
                const result = deleteSelectedBackups({ targetRoot, snapshotIds: preview.snapshotIds,
                    confirmationToken: preview.confirmationToken, confirm: true });
                denial.mock.restore();
                assert.equal(result.result, 'ERRORS');
                assert.deepEqual(result.requestedIds, [ids[0], ids[1]]);
                assert.deepEqual(result.removedIds, []);
                assert.deepEqual(result.errors.map(error => error.snapshotId), [ids[0], ids[1]]);
                assert.match(result.errors[0].message, /permission denial/);
                assert.match(result.errors[1].message, /Not attempted/);
                const freed = [...original].filter(([file]) => !fs.existsSync(file)).reduce((sum, [, bytes]) => sum + bytes, 0);
                assert.ok(freed > 0, 'the fixture must exercise a real partial unlink before denial');
                assert.equal(result.totalFreedBytes, freed);
                assert.equal(result.inventoryRefreshed, true);
                assert.equal(result.inventoryError, null);
                assert.deepEqual(result.inventory.map(backup => backup.id).sort(), ids);
                assert.equal(fs.existsSync(blocked), true);
                for (const [file, bytes] of untouched) assert.deepEqual(fs.readFileSync(file), bytes);
                assert.throws(() => deleteSelectedBackups({ targetRoot, snapshotIds: preview.snapshotIds,
                    confirmationToken: preview.confirmationToken, confirm: true }), /selection.*changed|token/iu);
                const final = previewBackupDeletion({ targetRoot, snapshotIds: ids.slice(1) });
                assert.equal(final.requiresFinalRecoveryPointConfirmation, true);
                assert.throws(() => deleteSelectedBackups({ targetRoot, snapshotIds: final.snapshotIds,
                    confirmationToken: final.confirmationToken, confirm: true }), /final recovery point/iu);
                const retry = previewBackupDeletion({ targetRoot, snapshotIds: [ids[1]] });
                const removed = deleteSelectedBackups({ targetRoot, snapshotIds: retry.snapshotIds,
                    confirmationToken: retry.confirmationToken, confirm: true });
                assert.equal(removed.result, 'SUCCESS');
                assert.deepEqual(removed.removedIds, [ids[1]]);
                assert.equal(removed.totalFreedBytes, retry.totalSizeBytes);
                assert.equal(removed.inventoryRefreshed, true);
                for (const [file, bytes] of untouched) {
                    if (file.startsWith(snapshots[2] + path.sep)) assert.deepEqual(fs.readFileSync(file), bytes);
                }
                assert.equal(resolveBackupRestoreSnapshotPath(targetRoot, ids[2]), snapshots[2]);
            } finally { t.mock.restoreAll(); removePathRecursive(targetRoot); }
        });
    }
});
