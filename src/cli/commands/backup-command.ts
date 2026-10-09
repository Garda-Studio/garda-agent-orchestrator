import * as path from 'node:path';
import {
    createBackupSnapshot,
    deleteSelectedBackups,
    previewBackupDeletion,
    type BackupDeletionPreview,
    type BackupDeletionResult,
    pruneBackups,
    type BackupRetentionResult
} from '../../lifecycle/backups';
import {
    buildDefaultWorkflowConfig,
    getWorkflowConfigPath,
    normalizeAutoBackupConfig,
    readWorkflowConfigForMerge,
    type AutoBackupConfig
} from '../../core/workflow-config';
import { withLifecycleOperationLock } from '../../lifecycle/common';
import {
    ensureDirectoryExists,
    normalizePathValue,
    PackageJsonLike,
    parseOptions,
    printHelp
} from './cli-helpers';
import {
    ensureBundleExists,
    formatKeyValueOutput,
    getDefaultInitAnswersPath,
    ParsedOptionsRecord
} from './shared-command-utils';

function toRelativeTargetPath(targetRoot: string, absolutePath: string): string {
    return path.relative(targetRoot, absolutePath).replace(/\\/g, '/');
}

function readManualBackupRetentionConfig(bundleRoot: string): AutoBackupConfig {
    const defaultConfig = buildDefaultWorkflowConfig();
    const readResult = readWorkflowConfigForMerge(getWorkflowConfigPath(bundleRoot));
    return normalizeAutoBackupConfig(readResult.config?.auto_backup ?? defaultConfig.auto_backup);
}

function summarizeRetentionResult(retention: BackupRetentionResult): Record<string, unknown> {
    return {
        retentionApplied: !retention.dryRun,
        retentionKeepLatest: retention.keepLatest,
        retentionResult: retention.result,
        retentionCandidateCount: retention.candidates.length,
        retentionRemovedCount: retention.removed.length,
        retentionSkippedCount: retention.skipped.length,
        retentionErrorCount: retention.errors.length,
        retentionTotalFreedBytes: retention.totalFreedBytes
    };
}

function buildBackupHelpText(): string {
    return [
        'GARDA_COMMAND_HELP',
        'Command: backup',
        '',
        'Usage:',
        '  garda backup create --confirm [--target-root PATH] [--init-answers-path PATH] [--json]',
        '  garda backup create --dry-run [--target-root PATH] [--json]',
        '  garda backup delete --snapshot-id ID [--snapshot-id ID ...] --dry-run [--target-root PATH] [--json]',
        '  garda backup delete --snapshot-id ID [--snapshot-id ID ...] --confirm --preview-token HASH [--confirm-final-recovery-point] [--target-root PATH] [--json]',
        '',
        'Description:',
        '  Creates a manual rollback backup snapshot in the backup inventory.',
        '',
        'Notes:',
        '  Mutating backup create runs require --confirm. Dry-run prints the planned target without creating files.',
        '  Confirmed manual backups apply the configured auto_backup.keep_latest retention policy and report the pruning result.',
        '  Selected deletion accepts inventory IDs only. First preview the exact selection; confirmation must include that preview token.',
        '  A changed inventory invalidates confirmation. Removing the final recovery point requires --confirm-final-recovery-point.',
        '  Deletion coordinates with backup/restore/update and preserves unselected snapshots. Partial failures return a non-zero exit.'
    ].join('\n');
}

export async function handleBackup(commandArgv: string[], packageJson: PackageJsonLike): Promise<void> {
    const subcommand = String(commandArgv[0] || '').trim().toLowerCase();
    if (!subcommand || subcommand === 'help' || commandArgv.includes('--help') || commandArgv.includes('-h')) {
        console.log(buildBackupHelpText());
        return;
    }
    if (subcommand === 'delete') {
        handleBackupDelete(commandArgv.slice(1), packageJson);
        return;
    }
    if (subcommand !== 'create') {
        printHelp(packageJson);
        throw new Error(`Unsupported backup subcommand: ${subcommand}`);
    }

    const definitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--confirm': { key: 'confirm', type: 'boolean' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv.slice(1), definitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    const bundlePath = ensureBundleExists(targetRoot, 'backup create');
    const initAnswersPath = typeof options.initAnswersPath === 'string'
        ? options.initAnswersPath
        : getDefaultInitAnswersPath(targetRoot, bundlePath);
    const retentionConfig = readManualBackupRetentionConfig(bundlePath);

    if (options.dryRun === true) {
        const result = {
            targetRoot,
            backupMode: 'manual',
            dryRun: true,
            status: 'SKIPPED_DRY_RUN',
            snapshotPath: 'not-created-in-dry-run',
            initAnswersPath,
            retentionApplied: false,
            retentionKeepLatest: retentionConfig.keep_latest,
            retentionResult: 'SKIPPED_DRY_RUN'
        };
        if (options.json === true) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            formatKeyValueOutput(result, [
                'targetRoot',
                'backupMode',
                'dryRun',
                'status',
                'snapshotPath',
                'initAnswersPath',
                'retentionApplied',
                'retentionKeepLatest',
                'retentionResult'
            ]);
        }
        return;
    }

    if (options.confirm !== true) {
        throw new Error('backup create mutates the workspace and requires --confirm. Use --dry-run for a read-only preview.');
    }

    const { backup, retention } = withLifecycleOperationLock(targetRoot, 'backup', () => {
        const created = createBackupSnapshot({
            targetRoot,
            bundleRoot: bundlePath,
            reason: 'manual',
            initAnswersPath
        });
        const retentionResult = pruneBackups({
            targetRoot,
            bundleRoot: bundlePath,
            keepLatest: retentionConfig.keep_latest
        });
        return {
            backup: created,
            retention: retentionResult
        };
    });
    const retentionSummary = summarizeRetentionResult(retention);
    const status = retention.result !== 'SUCCESS'
        ? 'CREATED_WITH_RETENTION_WARNING'
        : backup.health === 'AVAILABLE' ? 'SUCCESS' : 'CREATED_WITH_HEALTH_WARNING';
    const result = {
        targetRoot,
        backupMode: 'manual',
        dryRun: false,
        status,
        backupId: backup.id,
        createdAt: backup.createdAt,
        snapshotPath: backup.relativeSnapshotPath,
        rollbackRecordsPath: toRelativeTargetPath(path.resolve(targetRoot), backup.rollbackRecordsPath),
        rollbackRecordCount: backup.recordCount,
        sizeBytes: backup.sizeBytes,
        health: backup.health,
        healthMessage: backup.healthMessage,
        ...retentionSummary
    };

    if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    formatKeyValueOutput(result, [
        'targetRoot',
        'backupMode',
        'dryRun',
        'status',
        'backupId',
        'createdAt',
        'snapshotPath',
        'rollbackRecordsPath',
        'rollbackRecordCount',
        'sizeBytes',
        'health',
        'healthMessage',
        'retentionApplied',
        'retentionKeepLatest',
        'retentionResult',
        'retentionCandidateCount',
        'retentionRemovedCount',
        'retentionSkippedCount',
        'retentionErrorCount',
        'retentionTotalFreedBytes'
    ]);
}

function printBackupDeletionPreview(preview: BackupDeletionPreview): void {
    formatKeyValueOutput({ status: 'PREVIEW', snapshotIds: preview.snapshotIds.join(', '),
        confirmationToken: preview.confirmationToken, totalSizeBytes: preview.totalSizeBytes,
        lostRecoveryPointCount: preview.lostRecoveryPointCount, remainingRecoveryPointCount: preview.remainingRecoveryPointCount,
        requiresFinalRecoveryPointConfirmation: preview.requiresFinalRecoveryPointConfirmation },
    ['status', 'snapshotIds', 'confirmationToken', 'totalSizeBytes', 'lostRecoveryPointCount',
        'remainingRecoveryPointCount', 'requiresFinalRecoveryPointConfirmation']);
    for (const backup of preview.backups) {
        formatKeyValueOutput({ snapshotId: backup.id, sizeBytes: backup.sizeBytes, health: backup.health,
            healthMessage: backup.healthMessage ?? 'none' }, ['snapshotId', 'sizeBytes', 'health', 'healthMessage']);
    }
    for (const warning of preview.warnings) console.log(`Warning: ${warning}`);
}

function printBackupDeletionResult(result: BackupDeletionResult): void {
    formatKeyValueOutput({ status: result.result, removedIds: result.removedIds.join(', ') || 'none',
        totalFreedBytes: result.totalFreedBytes, inventoryRefreshed: result.inventoryRefreshed,
        remainingSnapshotIds: result.inventory.map(backup => backup.id).join(', ') || 'none',
        inventoryError: result.inventoryError ?? 'none' },
    ['status', 'removedIds', 'totalFreedBytes', 'inventoryRefreshed', 'remainingSnapshotIds', 'inventoryError']);
    for (const error of result.errors) console.error(`Snapshot ${error.snapshotId}: ${error.message}`);
}

function handleBackupDelete(argv: string[], packageJson: PackageJsonLike): void {
    const definitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--snapshot-id': { key: 'snapshotIds', type: 'string[]' },
        '--preview-token': { key: 'confirmationToken', type: 'string' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--confirm': { key: 'confirm', type: 'boolean' },
        '--confirm-final-recovery-point': { key: 'confirmFinalRecoveryPoint', type: 'boolean' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(argv, definitions);
    const options = rawOptions as ParsedOptionsRecord;
    if (options.version) { console.log(packageJson.version); return; }
    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    ensureBundleExists(targetRoot, 'backup delete');
    const request = { targetRoot, snapshotIds: Array.isArray(options.snapshotIds) ? options.snapshotIds : [] };
    if (options.dryRun === true) {
        if (options.confirm === true || options.confirmFinalRecoveryPoint === true || options.confirmationToken !== undefined) {
            throw new Error('backup delete preview must use --dry-run without confirmation flags or a preview token.');
        }
        const preview = previewBackupDeletion(request);
        if (options.json === true) console.log(JSON.stringify(preview, null, 2));
        else printBackupDeletionPreview(preview);
        return;
    }
    if (options.confirm !== true) throw new Error('backup delete requires --confirm and --preview-token from a --dry-run preview.');
    const result = deleteSelectedBackups({ ...request, confirm: true,
        confirmationToken: typeof options.confirmationToken === 'string' ? options.confirmationToken : '',
        confirmFinalRecoveryPoint: options.confirmFinalRecoveryPoint === true });
    if (options.json === true) console.log(JSON.stringify(result, null, 2));
    else printBackupDeletionResult(result);
    if (result.result !== 'SUCCESS') process.exitCode = 1;
}
