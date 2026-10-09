import { listBackups } from '../../../lifecycle/backups';
import { UI_ACTION_ROLLBACK_TIMEOUT_MS, buildUiActionDefinition } from './action-common';
import type { UiActionDefinition } from './types';

export const BACKUP_RESTORE_ACTION_ID_PREFIX = 'backup-restore:';
export const MANUAL_BACKUP_CREATE_ACTION_ID = 'backup-create-manual';
export const BACKUP_DELETE_SELECTED_ACTION_ID = 'backup-delete-selected';
export const BACKUP_DELETE_CONFIRMATION_PHRASE = 'DELETE SELECTED BACKUPS';

export function buildBackupRestoreActionId(backupId: string): string {
    return `${BACKUP_RESTORE_ACTION_ID_PREFIX}${backupId}`;
}

export function buildBackupRestoreConfirmationPhrase(backupId: string): string {
    return `RESTORE BACKUP ${backupId}`;
}

export function buildManualBackupCreateConfirmationPhrase(): string {
    return 'CREATE BACKUP';
}

function buildManualBackupCreateAction(repoRoot: string): UiActionDefinition {
    return buildUiActionDefinition(
        repoRoot,
        MANUAL_BACKUP_CREATE_ACTION_ID,
        'Backups',
        'Create manual backup',
        'Create a manual rollback backup snapshot through the guarded backup backend.',
        [
            'backup',
            'create',
            '--target-root',
            repoRoot,
            '--confirm'
        ],
        {
            mutates: true,
            confirmationPhrase: buildManualBackupCreateConfirmationPhrase(),
            timeoutMs: UI_ACTION_ROLLBACK_TIMEOUT_MS
        }
    );
}

export function buildUiBackupActionDefinitions(repoRoot: string): UiActionDefinition[] {
    const manualBackupAction = buildManualBackupCreateAction(repoRoot);
    let backups;
    try {
        backups = listBackups(repoRoot);
    } catch {
        return [manualBackupAction];
    }

    return [manualBackupAction, ...backups.map((backup) => {
        const restorable = backup.health === 'AVAILABLE';
        return buildUiActionDefinition(
            repoRoot,
            buildBackupRestoreActionId(backup.id),
            'Backups',
            `Restore backup ${backup.id}`,
            `Restore workspace state from backup snapshot ${backup.relativeSnapshotPath} through the guarded rollback backend.`,
            [
                'rollback',
                '--snapshot-path',
                backup.restoreSnapshotPath,
                '--target-root',
                repoRoot
            ],
            {
                mutates: true,
                confirmationPhrase: buildBackupRestoreConfirmationPhrase(backup.id),
                enabled: restorable,
                timeoutMs: UI_ACTION_ROLLBACK_TIMEOUT_MS,
                unavailableReason: backup.healthMessage
                    ? `Backup is not restorable (${backup.health}): ${backup.healthMessage}`
                    : `Backup is not restorable (${backup.health}).`
            }
        );
    })];
}
