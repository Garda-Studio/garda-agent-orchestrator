import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mutableFs = require('node:fs') as typeof fs;

import { getLifecycleOperationLockPath, getRollbackRecordsPath } from '../../../../src/lifecycle/common';
import { createBackupSnapshot, listBackups, type BackupDeletionPreview } from '../../../../src/lifecycle/backups';
import { runCliWithCapturedOutput } from './gate-test-helpers';

function makeWorkspace(prefix: string): { targetRoot: string; bundleRoot: string } {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
    return { targetRoot, bundleRoot };
}

function combinedOutput(result: { logs: readonly string[]; errors: readonly string[] }): string {
    return [...result.logs, ...result.errors].join('\n');
}

function seedLifecycleOperationLock(targetRoot: string): void {
    const lockPath = getLifecycleOperationLockPath(targetRoot);
    const now = new Date().toISOString();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        operation: 'update',
        acquired_at_utc: now,
        heartbeat_at_utc: now,
        target_root: path.resolve(targetRoot)
    }, null, 2), 'utf8');
}

function writeWorkflowAutoBackupConfig(bundleRoot: string, keepLatest: number): void {
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
        auto_backup: {
            enabled: true,
            interval_days: 1,
            keep_latest: keepLatest
        }
    }, null, 2), 'utf8');
}

describe('backup create CLI command', () => {
    it('prints a dry-run preview without creating a backup', async () => {
        const { targetRoot } = makeWorkspace('gao-cli-backup-dry-run-');
        try {
            const result = await runCliWithCapturedOutput([
                'backup',
                'create',
                '--target-root',
                targetRoot,
                '--dry-run'
            ], { cwd: targetRoot });

            assert.equal(result.exitCode, 0);
            assert.match(combinedOutput(result), /Status: SKIPPED_DRY_RUN/u);
            assert.match(combinedOutput(result), /RetentionApplied: False/u);
            assert.match(combinedOutput(result), /RetentionResult: SKIPPED_DRY_RUN/u);
            assert.equal(listBackups(targetRoot).length, 0);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('rejects mutating create without explicit confirmation', async () => {
        const { targetRoot } = makeWorkspace('gao-cli-backup-confirm-required-');
        try {
            const result = await runCliWithCapturedOutput([
                'backup',
                'create',
                '--target-root',
                targetRoot
            ], { cwd: targetRoot });

            assert.notEqual(result.exitCode, 0);
            assert.match(combinedOutput(result), /requires --confirm/u);
            assert.equal(listBackups(targetRoot).length, 0);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('creates a manual backup snapshot when confirmed', async () => {
        const { targetRoot } = makeWorkspace('gao-cli-backup-confirmed-');
        try {
            const result = await runCliWithCapturedOutput([
                'backup',
                'create',
                '--target-root',
                targetRoot,
                '--confirm'
            ], { cwd: targetRoot });

            const backups = listBackups(targetRoot);
            assert.equal(result.exitCode, 0);
            assert.match(combinedOutput(result), /Status: SUCCESS/u);
            assert.match(combinedOutput(result), /BackupId: manual-/u);
            assert.match(combinedOutput(result), /RetentionApplied: True/u);
            assert.match(combinedOutput(result), /RetentionResult: SUCCESS/u);
            assert.equal(backups.length, 1);
            assert.equal(backups[0].reason, 'manual');
            assert.equal(backups[0].health, 'AVAILABLE');
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('applies configured retention after confirmed manual backup creation', async () => {
        const { targetRoot, bundleRoot } = makeWorkspace('gao-cli-backup-retention-');
        try {
            writeWorkflowAutoBackupConfig(bundleRoot, 2);
            createBackupSnapshot({
                targetRoot,
                bundleRoot,
                reason: 'manual',
                timestamp: '20260501-010000-000'
            });
            createBackupSnapshot({
                targetRoot,
                bundleRoot,
                reason: 'manual',
                timestamp: '20260502-010000-000'
            });

            const result = await runCliWithCapturedOutput([
                'backup',
                'create',
                '--target-root',
                targetRoot,
                '--confirm'
            ], { cwd: targetRoot });

            const backups = listBackups(targetRoot);
            assert.equal(result.exitCode, 0);
            assert.match(combinedOutput(result), /RetentionApplied: True/u);
            assert.match(combinedOutput(result), /RetentionKeepLatest: 2/u);
            assert.match(combinedOutput(result), /RetentionRemovedCount: 1/u);
            assert.equal(backups.length, 2);
            assert.equal(
                backups.some((backup) => backup.id === 'manual-20260501-010000-000'),
                false,
                'oldest manual backup should be pruned by configured retention'
            );
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('does not create a confirmed backup while another lifecycle operation holds the lock', async () => {
        const { targetRoot } = makeWorkspace('gao-cli-backup-lock-held-');
        try {
            seedLifecycleOperationLock(targetRoot);
            const result = await runCliWithCapturedOutput([
                'backup',
                'create',
                '--target-root',
                targetRoot,
                '--confirm'
            ], { cwd: targetRoot });

            assert.notEqual(result.exitCode, 0);
            assert.match(combinedOutput(result), /Another lifecycle operation is already running/u);
            assert.equal(listBackups(targetRoot).length, 0);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('emits machine-readable JSON for confirmed manual backups', async () => {
        const { targetRoot } = makeWorkspace('gao-cli-backup-json-');
        try {
            const result = await runCliWithCapturedOutput([
                'backup',
                'create',
                '--target-root',
                targetRoot,
                '--confirm',
                '--json'
            ], { cwd: targetRoot });

            const parsed = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
            assert.equal(result.exitCode, 0);
            assert.equal(parsed.backupMode, 'manual');
            assert.equal(parsed.status, 'SUCCESS');
            assert.equal(typeof parsed.backupId, 'string');
            assert.match(String(parsed.backupId), /^manual-/u);
            assert.equal(parsed.retentionApplied, true);
            assert.equal(parsed.retentionResult, 'SUCCESS');
            assert.equal(listBackups(targetRoot).length, 1);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });
});

function seedDeletionBackups(targetRoot: string, bundleRoot: string): string[] {
    return [1, 2].map(day => createBackupSnapshot({
        targetRoot, bundleRoot, reason: 'manual', timestamp: `2026050${day}-010000-000`
    }).id);
}

async function previewDeletionCli(targetRoot: string, ids: readonly string[]): Promise<BackupDeletionPreview> {
    const result = await runCliWithCapturedOutput([
        'backup', 'delete', '--target-root', targetRoot, '--dry-run', '--json',
        ...ids.flatMap(id => ['--snapshot-id', id])
    ], { cwd: targetRoot });
    assert.equal(result.exitCode, 0, combinedOutput(result));
    return JSON.parse(result.logs.join('\n')) as BackupDeletionPreview;
}

describe('backup delete CLI command', () => {
    it('uses populated directory and missing-record health for final recovery-point confirmation', async () => {
        const { targetRoot, bundleRoot } = makeWorkspace('gao-cli-backup-delete-directory-health-');
        try {
            const payload = path.join(bundleRoot, 'live', 'docs', 'nested', 'payload.txt');
            fs.mkdirSync(path.dirname(payload), { recursive: true });
            fs.mkdirSync(path.join(bundleRoot, 'live', 'docs', 'empty'));
            fs.writeFileSync(payload, 'live directory recovery payload');
            const ids = seedDeletionBackups(targetRoot, bundleRoot);
            const backups = listBackups(targetRoot);
            const first = backups.find(backup => backup.id === ids[0])!;
            const records = JSON.parse(
                fs.readFileSync(getRollbackRecordsPath(first.snapshotPath), 'utf8')
            ) as { existed: boolean; pathType: string }[];
            assert.equal(records.some(record => record.existed && record.pathType === 'directory'), true);
            assert.equal(records.some(record => !record.existed && record.pathType === 'missing'), true);
            const all = await previewDeletionCli(targetRoot, ids);
            assert.equal(all.backups.every(backup => backup.health === 'AVAILABLE'), true);
            assert.equal(all.lostRecoveryPointCount, 2);
            assert.equal(all.requiresFinalRecoveryPointConfirmation, true);
            fs.unlinkSync(getRollbackRecordsPath(first.snapshotPath));
            const broken = await previewDeletionCli(targetRoot, [ids[0]]);
            assert.equal(broken.backups[0].health, 'MISSING_RECORDS');
            assert.equal(broken.lostRecoveryPointCount, 0);
            assert.equal(broken.remainingRecoveryPointCount, 1);
            assert.equal(broken.requiresFinalRecoveryPointConfirmation, false);
            const healthy = await previewDeletionCli(targetRoot, [ids[1]]);
            assert.equal(healthy.backups[0].health, 'AVAILABLE');
            assert.equal(healthy.lostRecoveryPointCount, 1);
            assert.equal(healthy.remainingRecoveryPointCount, 0);
            assert.equal(healthy.requiresFinalRecoveryPointConfirmation, true);
            const args = ['backup', 'delete', '--target-root', targetRoot, '--snapshot-id', ids[1],
                '--confirm', '--preview-token', healthy.confirmationToken, '--json'];
            const blocked = await runCliWithCapturedOutput(args, { cwd: targetRoot });
            assert.notEqual(blocked.exitCode, 0);
            assert.match(combinedOutput(blocked), /final recovery point/iu);
            assert.equal(fs.existsSync(first.snapshotPath), true);
            const accepted = await runCliWithCapturedOutput([...args, '--confirm-final-recovery-point'], { cwd: targetRoot });
            assert.equal(accepted.exitCode, 0, combinedOutput(accepted));
            const output = JSON.parse(accepted.logs.join('\n')) as { removedIds: string[]; inventory: { id: string; health: string }[] };
            assert.deepEqual(output.removedIds, [ids[1]]);
            assert.deepEqual(output.inventory.map(backup => [backup.id, backup.health]), [[ids[0], 'MISSING_RECORDS']]);
            assert.equal(fs.readFileSync(payload, 'utf8'), 'live directory recovery payload');
        } finally { fs.rmSync(targetRoot, { recursive: true, force: true }); }
    });

    it('prints exact IDs, health, bytes, loss warning and confirmation token in a read-only preview', async () => {
        const { targetRoot, bundleRoot } = makeWorkspace('gao-cli-backup-delete-preview-');
        try {
            const ids = seedDeletionBackups(targetRoot, bundleRoot);
            const result = await runCliWithCapturedOutput([
                'backup', 'delete', '--target-root', targetRoot, '--snapshot-id', ids[0], '--snapshot-id', ids[1], '--dry-run'
            ], { cwd: targetRoot });
            assert.equal(result.exitCode, 0);
            assert.match(combinedOutput(result), /Status: PREVIEW/u);
            assert.match(combinedOutput(result), /Health: AVAILABLE/u);
            assert.match(combinedOutput(result), /SizeBytes: \d+/u);
            assert.match(combinedOutput(result), /LostRecoveryPointCount: 2/u);
            assert.match(combinedOutput(result), /ConfirmationToken: [a-f0-9]{64}/u);
            assert.match(combinedOutput(result), /final recovery point/iu);
            assert.equal(listBackups(targetRoot).length, 2);
        } finally { fs.rmSync(targetRoot, { recursive: true, force: true }); }
    });

    it('requires both explicit confirmation and the exact preview token for mutation', async () => {
        const { targetRoot, bundleRoot } = makeWorkspace('gao-cli-backup-delete-confirm-');
        try {
            const ids = seedDeletionBackups(targetRoot, bundleRoot);
            for (const flags of [[], ['--confirm']]) {
                const result = await runCliWithCapturedOutput([
                    'backup', 'delete', '--target-root', targetRoot, '--snapshot-id', ids[0], ...flags
                ], { cwd: targetRoot });
                assert.notEqual(result.exitCode, 0);
                assert.match(combinedOutput(result), /confirm|token/iu);
            }
            assert.equal(listBackups(targetRoot).length, 2);
            const preview = await previewDeletionCli(targetRoot, [ids[0]]);
            const result = await runCliWithCapturedOutput([
                'backup', 'delete', '--target-root', targetRoot, '--snapshot-id', ids[0],
                '--confirm', '--preview-token', preview.confirmationToken, '--json'
            ], { cwd: targetRoot });
            assert.equal(result.exitCode, 0, combinedOutput(result));
            const output = JSON.parse(result.logs.join('\n')) as { result: string; removedIds: string[]; inventoryRefreshed: boolean };
            assert.equal(output.result, 'SUCCESS');
            assert.deepEqual(output.removedIds, [ids[0]]);
            assert.equal(output.inventoryRefreshed, true);
            assert.deepEqual(listBackups(targetRoot).map(backup => backup.id), [ids[1]]);
        } finally { fs.rmSync(targetRoot, { recursive: true, force: true }); }
    });

    it('requires separate final recovery point confirmation after the preview warning', async () => {
        const { targetRoot, bundleRoot } = makeWorkspace('gao-cli-backup-delete-final-');
        try {
            const ids = seedDeletionBackups(targetRoot, bundleRoot);
            const preview = await previewDeletionCli(targetRoot, ids);
            const args = ['backup', 'delete', '--target-root', targetRoot, '--confirm', '--preview-token', preview.confirmationToken,
                ...ids.flatMap(id => ['--snapshot-id', id])];
            const blocked = await runCliWithCapturedOutput(args, { cwd: targetRoot });
            assert.notEqual(blocked.exitCode, 0);
            assert.match(combinedOutput(blocked), /final recovery point/iu);
            assert.equal(listBackups(targetRoot).length, 2);
            const accepted = await runCliWithCapturedOutput([...args, '--confirm-final-recovery-point'], { cwd: targetRoot });
            assert.equal(accepted.exitCode, 0, combinedOutput(accepted));
            assert.equal(listBackups(targetRoot).length, 0);
        } finally { fs.rmSync(targetRoot, { recursive: true, force: true }); }
    });

    it('rejects stale confirmation, unsafe IDs, missing selection and ambiguous preview/confirmation flags', async () => {
        const { targetRoot, bundleRoot } = makeWorkspace('gao-cli-backup-delete-negative-');
        try {
            const ids = seedDeletionBackups(targetRoot, bundleRoot);
            const preview = await previewDeletionCli(targetRoot, [ids[0]]);
            const cases = [
                ['--dry-run'],
                ['--dry-run', '--snapshot-id', '../' + ids[0]],
                ['--dry-run', '--snapshot-id', ids[0], '--confirm'],
                ['--dry-run', '--snapshot-id', ids[0], '--snapshot-id', ids[0]],
                ['--confirm', '--snapshot-id', ids[1], '--preview-token', preview.confirmationToken]
            ];
            for (const flags of cases) {
                const result = await runCliWithCapturedOutput(['backup', 'delete', '--target-root', targetRoot, ...flags], { cwd: targetRoot });
                assert.notEqual(result.exitCode, 0, combinedOutput(result));
            }
            assert.equal(listBackups(targetRoot).length, 2);
        } finally { fs.rmSync(targetRoot, { recursive: true, force: true }); }
    });

    it('returns truthful partial failure JSON and a non-zero exit when an owned unlink is denied', async (t) => {
        const { targetRoot, bundleRoot } = makeWorkspace('gao-cli-backup-delete-denied-');
        const unlink = mutableFs.unlinkSync;
        try {
            const ids = seedDeletionBackups(targetRoot, bundleRoot);
            const preview = await previewDeletionCli(targetRoot, [ids[0]]);
            const selected = listBackups(targetRoot).find(backup => backup.id === ids[0])!;
            const blocked = getRollbackRecordsPath(selected.snapshotPath);
            t.mock.method(mutableFs, 'unlinkSync', (candidate: fs.PathLike) => {
                if (String(candidate) === blocked) throw Object.assign(new Error('selected unlink denied'), { code: 'EACCES' });
                unlink(candidate);
            });
            const result = await runCliWithCapturedOutput([
                'backup', 'delete', '--target-root', targetRoot, '--snapshot-id', ids[0],
                '--confirm', '--preview-token', preview.confirmationToken, '--json'
            ], { cwd: targetRoot });
            assert.notEqual(result.exitCode, 0);
            const output = JSON.parse(result.logs.join('\n')) as { result: string; removedIds: string[]; errors: { message: string }[] };
            assert.equal(output.result, 'ERRORS');
            assert.deepEqual(output.removedIds, []);
            assert.match(output.errors[0].message, /selected unlink denied/u);
            assert.equal(fs.existsSync(blocked), true);
            assert.equal(listBackups(targetRoot).some(backup => backup.id === ids[1] && backup.health === 'AVAILABLE'), true);
        } finally { t.mock.restoreAll(); fs.rmSync(targetRoot, { recursive: true, force: true }); }
    });
});
