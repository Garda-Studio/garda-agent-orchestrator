import * as fs from 'node:fs';
import * as path from 'node:path';
import { PUBLIC_BUNDLE_ASSETS } from '../core/public-bundle-assets';
import {
    bindContainedDestination,
    copyContainedFile,
    ensureContainedDirectory,
    removeContainedPath,
    writeContainedFile
} from '../core/contained-filesystem';
import {
    assertCopySourceTree,
    copyPathRecursive,
    ensureRelativeSafe,
    ensureWithinRoot,
    readdirRecursiveDirs,
    readdirRecursiveFiles
} from './generic-utils';
import { withLifecycleRuntimeMutationGenerationForPath } from './runtime-mutation-generation';
import {
    assertNoLinkedPathComponents,
    getRollbackSnapshotIntegrityPath,
    verifyRollbackSnapshotIntegrity,
    writeRollbackSnapshotIntegrity
} from './rollback/rollback-snapshot-integrity';

type JsonObject = Record<string, unknown>;

export interface RollbackRecord {
    relativePath: string;
    existed: boolean;
    pathType: string;
}

export interface SyncBackupMetadata extends JsonObject {
    preexistingMap: Record<string, unknown>;
}

export interface UpdateSentinelMetadata extends JsonObject {
    startedAt?: string;
    fromVersion?: string;
    toVersion?: string;
    phase?: string;
    syncBackupRoot?: string;
    syncBackupMetadataPath?: string;
    plannedSyncItems?: string[];
}

export interface UninstallSentinelMetadata extends JsonObject {
    startedAt?: string;
    operation?: string;
    rollbackSnapshotPath?: string;
    timestamp?: string;
    skipBackups?: boolean;
    keepPrimaryEntrypoint?: boolean;
    keepTaskFile?: boolean;
    keepRuntimeArtifacts?: boolean;
}

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const ROLLBACK_RECORDS_FILE_NAME = 'rollback-records.json';
export const SYNC_BACKUP_METADATA_FILE_NAME = 'sync-backup-metadata.json';
export const UPDATE_SENTINEL_FILE_NAME = '.update-in-progress';
export const UNINSTALL_SENTINEL_FILE_NAME = '.uninstall-in-progress';

export const BUNDLE_SYNC_ITEMS = Object.freeze([
    '.gitattributes',
    'bin',
    'dist',
    'package.json',
    'src',
    'template',
    'README.md',
    'HOW_TO.md',
    'MANIFEST.md',
    'AGENT_INIT_PROMPT.md',
    'CHANGELOG.md',
    'LICENSE',
    ...PUBLIC_BUNDLE_ASSETS,
    'VERSION'
]);

function createRollbackSnapshotUnjournaled(
    rootPath: string,
    snapshotRoot: string,
    relativePaths: readonly string[]
): RollbackRecord[] {
    const unique = [...new Set(relativePaths)].sort();
    const records: RollbackRecord[] = [];
    bindContainedDestination(rootPath, snapshotRoot);

    for (const rel of unique) {
        if (!rel || rel === '.') continue;
        ensureRelativeSafe(rel, 'Rollback relativePath');
        const targetPath = path.join(rootPath, rel);
        ensureWithinRoot(rootPath, targetPath, 'Rollback target');
        bindContainedDestination(rootPath, targetPath);
        bindContainedDestination(rootPath, path.join(snapshotRoot, rel));
        if (fs.existsSync(targetPath)) assertCopySourceTree(targetPath);
    }

    for (const rel of unique) {
        if (!rel || rel === '.') continue;
        ensureRelativeSafe(rel, 'Rollback relativePath');

        const targetPath = path.join(rootPath, rel);
        ensureWithinRoot(rootPath, targetPath, 'Rollback target');
        bindContainedDestination(rootPath, targetPath);

        const exists = fs.existsSync(targetPath);
        let pathType = 'missing';
        if (exists) {
            const stats = fs.lstatSync(targetPath);
            pathType = stats.isDirectory() ? 'directory' : 'file';
            const snapshotPath = path.join(snapshotRoot, rel);
            ensureContainedDirectory(rootPath, path.dirname(snapshotPath));
            copyPathRecursive(targetPath, snapshotPath, rootPath);
        }
        records.push({ relativePath: rel, existed: exists, pathType });
    }

    return records;
}

export function createRollbackSnapshot(
    rootPath: string,
    snapshotRoot: string,
    relativePaths: readonly string[]
): RollbackRecord[] {
    return withLifecycleRuntimeMutationGenerationForPath(
        snapshotRoot,
        'lifecycle-rollback-snapshot-create',
        () => createRollbackSnapshotUnjournaled(rootPath, snapshotRoot, relativePaths)
    );
}

export function getRollbackRecordsPath(snapshotRoot: string): string {
    return path.join(snapshotRoot, ROLLBACK_RECORDS_FILE_NAME);
}

export function writeRollbackRecords(snapshotRoot: string, records: readonly RollbackRecord[]): string {
    return withLifecycleRuntimeMutationGenerationForPath(
        snapshotRoot,
        'lifecycle-rollback-records-write',
        () => {
            const recordsPath = getRollbackRecordsPath(snapshotRoot);
            ensureContainedDirectory(path.parse(path.resolve(snapshotRoot)).root, snapshotRoot);
            bindContainedDestination(path.parse(path.resolve(snapshotRoot)).root, recordsPath);
            bindContainedDestination(path.parse(path.resolve(snapshotRoot)).root,
                getRollbackSnapshotIntegrityPath(snapshotRoot));
            assertNoLinkedPathComponents(snapshotRoot, recordsPath);
            const recordsBytes = Buffer.from(JSON.stringify(records, null, 2), 'utf8');
            writeContainedFile(path.parse(path.resolve(snapshotRoot)).root, recordsPath, recordsBytes);
            writeRollbackSnapshotIntegrity(snapshotRoot, records, recordsBytes);
            return recordsPath;
        }
    );
}

export function readRollbackRecords(snapshotRoot: string): RollbackRecord[] {
    const recordsPath = getRollbackRecordsPath(snapshotRoot);
    assertNoLinkedPathComponents(snapshotRoot, recordsPath);
    if (!fs.existsSync(recordsPath)) {
        throw new Error(`Rollback records file not found: ${recordsPath}`);
    }

    const recordsBytes = fs.readFileSync(recordsPath);
    let parsed: unknown;
    try {
        parsed = JSON.parse(recordsBytes.toString('utf8'));
    } catch (_error) {
        throw new Error(`Rollback records file is not valid JSON: ${recordsPath}`);
    }

    if (!Array.isArray(parsed)) {
        throw new Error(`Rollback records file must contain an array: ${recordsPath}`);
    }

    const seen = new Set<string>();
    const records = parsed.map((record: unknown, index: number): RollbackRecord => {
        const recordObject = isJsonObject(record) ? record : null;
        const relativePath = typeof recordObject?.relativePath === 'string'
            ? recordObject.relativePath.trim()
            : '';
        if (!relativePath) {
            throw new Error(`Rollback record at index ${index} is missing relativePath.`);
        }
        ensureRelativeSafe(relativePath, `Rollback record at index ${index} relativePath`);
        const normalizedPath = relativePath.replace(/\\/g, '/').toLowerCase();
        if (seen.has(normalizedPath)) throw new Error(`Duplicate rollback record: ${relativePath}`);
        seen.add(normalizedPath);
        if (typeof recordObject?.existed !== 'boolean'
            || !['file', 'directory', 'missing'].includes(String(recordObject.pathType))
            || (recordObject.existed && recordObject.pathType === 'missing')
            || (!recordObject.existed && recordObject.pathType !== 'missing')) {
            throw new Error(`Rollback record at index ${index} has invalid existence or pathType.`);
        }

        return {
            relativePath,
            existed: recordObject.existed,
            pathType: recordObject.pathType as string
        };
    });
    verifyRollbackSnapshotIntegrity(snapshotRoot, records, recordsBytes);
    return records;
}

export function getSyncBackupMetadataPath(backupRoot: string): string {
    return path.join(backupRoot, SYNC_BACKUP_METADATA_FILE_NAME);
}

export function writeSyncBackupMetadata(backupRoot: string, metadata: SyncBackupMetadata): string {
    return withLifecycleRuntimeMutationGenerationForPath(
        backupRoot,
        'lifecycle-bundle-backup-metadata-write',
        () => {
            const metadataPath = getSyncBackupMetadataPath(backupRoot);
            writeContainedFile(path.parse(path.resolve(backupRoot)).root,
                metadataPath, JSON.stringify(metadata, null, 2));
            return metadataPath;
        }
    );
}

export function readSyncBackupMetadata(backupRoot: string): SyncBackupMetadata {
    const metadataPath = getSyncBackupMetadataPath(backupRoot);
    assertNoLinkedPathComponents(backupRoot, metadataPath);
    if (!fs.existsSync(metadataPath)) {
        throw new Error(`Sync backup metadata file not found: ${metadataPath}`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch (_error) {
        throw new Error(`Sync backup metadata file is not valid JSON: ${metadataPath}`);
    }

    const parsedObject = isJsonObject(parsed) ? parsed : null;
    const preexistingMap = parsedObject && isJsonObject(parsedObject.preexistingMap)
        ? parsedObject.preexistingMap
        : null;
    if (!preexistingMap || Array.isArray(preexistingMap)) {
        throw new Error(`Sync backup metadata is missing preexistingMap: ${metadataPath}`);
    }
    for (const key of Object.keys(preexistingMap)) {
        ensureRelativeSafe(key, 'Sync backup metadata key');
    }

    return {
        ...(parsedObject ?? {}),
        preexistingMap
    };
}

export function restoreRollbackSnapshot(
    rootPath: string,
    snapshotRoot: string,
    records: readonly RollbackRecord[]
): void {
    for (const record of records) {
        ensureRelativeSafe(record.relativePath, 'Rollback record.relativePath');
        const targetPath = path.join(rootPath, record.relativePath);
        ensureWithinRoot(rootPath, targetPath, 'Rollback restore target');
        assertNoLinkedPathComponents(rootPath, targetPath);
        bindContainedDestination(rootPath, targetPath);
        if (record.existed) {
            const snapshotPath = path.join(snapshotRoot, record.relativePath);
            assertNoLinkedPathComponents(snapshotRoot, snapshotPath);
            if (!fs.existsSync(snapshotPath)) {
                throw new Error(`Rollback snapshot entry missing for '${record.relativePath}': ${snapshotPath}`);
            }
            assertCopySourceTree(snapshotPath);
        }
    }
    for (const record of records) {
        const rel = record.relativePath;
        if (!rel) continue;
        ensureRelativeSafe(rel, 'Rollback record.relativePath');

        const targetPath = path.join(rootPath, rel);
        ensureWithinRoot(rootPath, targetPath, 'Rollback restore target');
        assertNoLinkedPathComponents(rootPath, targetPath);
        const snapshotPath = path.join(snapshotRoot, rel);
        assertNoLinkedPathComponents(snapshotRoot, snapshotPath);
        const shouldExist = record.existed;

        if (shouldExist) {
            if (!fs.existsSync(snapshotPath)) {
                throw new Error(`Rollback snapshot entry missing for '${rel}': ${snapshotPath}`);
            }
            removeContainedPath(rootPath, targetPath, true);
            ensureContainedDirectory(rootPath, path.dirname(targetPath));
            copyPathRecursive(snapshotPath, targetPath, rootPath);
            continue;
        }

        removeContainedPath(rootPath, targetPath, true);
    }
}

export function copyDirectoryContentMerge(
    sourceDirectory: string,
    destinationDirectory: string,
    skipDestinationFiles?: readonly string[] | null
): void {
    const sourceRoot = path.resolve(sourceDirectory);
    assertCopySourceTree(sourceRoot);
    if (!fs.lstatSync(sourceRoot).isDirectory()) {
        throw new Error(`Merge source must be a directory: ${sourceRoot}`);
    }
    const containmentRoot = path.parse(path.resolve(destinationDirectory)).root;
    bindContainedDestination(containmentRoot, destinationDirectory);

    const skipSet = new Set(
        (skipDestinationFiles ?? []).map((filePath) => path.resolve(filePath).toLowerCase())
    );

    const destRoot = path.resolve(destinationDirectory);
    const expectedDestFiles = new Set<string>();
    const plannedCopies: Array<{ source: string; destination: string }> = [];

    for (const sourceFile of readdirRecursiveFiles(sourceDirectory)) {
        const sourceStat = fs.lstatSync(sourceFile);
        if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.nlink !== 1) {
            throw new Error(`Refusing to copy symlink or junction source or hard-linked file: ${sourceFile}`);
        }
        const rel = path.relative(sourceRoot, sourceFile);
        if (!rel || rel === '.') continue;
        if (rel.split(path.sep).includes('..')) {
            throw new Error(`Source contains upward-relative paths: ${rel}`);
        }

        const destFile = path.resolve(path.join(destinationDirectory, rel));
        bindContainedDestination(containmentRoot, destFile);
        ensureWithinRoot(destRoot, destFile, 'Destination file');
        expectedDestFiles.add(destFile.toLowerCase());

        if (skipSet.has(destFile.toLowerCase())) continue;
        plannedCopies.push({ source: sourceFile, destination: destFile });
    }

    const staleFiles: string[] = [];
    for (const destFile of readdirRecursiveFiles(destinationDirectory)) {
        const destFull = path.resolve(destFile).toLowerCase();
        if (skipSet.has(destFull)) continue;
        if (!expectedDestFiles.has(destFull)) {
            bindContainedDestination(containmentRoot, destFile);
            ensureWithinRoot(destRoot, destFile, 'Removal target');
            staleFiles.push(destFile);
        }
    }

    ensureContainedDirectory(containmentRoot, destinationDirectory);
    for (const copy of plannedCopies) {
        copyContainedFile(containmentRoot, copy.source, copy.destination);
    }
    for (const destFile of staleFiles) {
        removeContainedPath(containmentRoot, destFile);
    }

    const dirs = readdirRecursiveDirs(destinationDirectory).sort((a, b) => b.length - a.length);
    for (const dir of dirs) {
        const dirFull = path.resolve(dir).toLowerCase();
        if (skipSet.has(dirFull)) continue;
        try {
            ensureWithinRoot(destRoot, dir, 'Directory to prune');
            bindContainedDestination(containmentRoot, dir);
            const entries = fs.readdirSync(dir);
            if (entries.length === 0) removeContainedPath(containmentRoot, dir);
        } catch {
            // Best-effort empty-directory cleanup.
        }
    }
}

export function restoreSyncedItemsFromBackup(
    targetBundleRoot: string,
    backupRoot: string,
    preexistingMap: Record<string, unknown>,
    runningScriptPath: string | null
): void {
    const resolvedTargetRoot = path.resolve(targetBundleRoot);
    for (const item of Object.keys(preexistingMap)) {
        if (!item) continue;
        ensureRelativeSafe(item, 'Synced item key');
        bindContainedDestination(resolvedTargetRoot, path.join(targetBundleRoot, item));
        if (preexistingMap[item]) {
            const backupPath = path.join(backupRoot, item);
            if (!fs.existsSync(backupPath)) {
                throw new Error(`Missing backup entry for '${item}': ${backupPath}`);
            }
            assertCopySourceTree(backupPath);
        }
    }
    for (const item of Object.keys(preexistingMap)) {
        if (!item) continue;
        ensureRelativeSafe(item, 'Synced item key');

        const destinationPath = path.join(targetBundleRoot, item);
        ensureWithinRoot(resolvedTargetRoot, destinationPath, 'Synced destination');
        const preexisting = Boolean(preexistingMap[item]);

        if (preexisting) {
            const backupPath = path.join(backupRoot, item);
            if (!fs.existsSync(backupPath)) {
                throw new Error(`Missing backup entry for '${item}': ${backupPath}`);
            }

            const isNodeRuntimeDir = item.toLowerCase() === 'src';
            if (isNodeRuntimeDir && fs.existsSync(backupPath) && fs.lstatSync(backupPath).isDirectory()) {
                if (!fs.existsSync(destinationPath) || !fs.lstatSync(destinationPath).isDirectory()) {
                    removeContainedPath(resolvedTargetRoot, destinationPath, true);
                    ensureContainedDirectory(resolvedTargetRoot, destinationPath);
                }
                const skipPaths = runningScriptPath ? [path.resolve(runningScriptPath)] : [];
                copyDirectoryContentMerge(backupPath, destinationPath, skipPaths);
                continue;
            }

            removeContainedPath(resolvedTargetRoot, destinationPath, true);
            ensureContainedDirectory(resolvedTargetRoot, path.dirname(destinationPath));
            copyPathRecursive(backupPath, destinationPath, resolvedTargetRoot);
            continue;
        }

        removeContainedPath(resolvedTargetRoot, destinationPath, true);
    }
}

export function syncWorkingTreeBundleItems(
    sourceBundleRoot: string,
    targetBundleRoot: string,
    relativeItems: readonly string[]
): void {
    const unique = [...new Set(relativeItems)].sort();
    const resolvedTargetRoot = path.resolve(targetBundleRoot);
    const selected: string[] = [];
    for (const item of unique) {
        if (!item) continue;
        ensureRelativeSafe(item, 'Sync item');
        const sourcePath = path.join(sourceBundleRoot, item);
        if (bindContainedDestination(sourceBundleRoot, sourcePath).missingAt) continue;
        bindContainedDestination(resolvedTargetRoot, path.join(targetBundleRoot, item));
        assertCopySourceTree(sourcePath);
        selected.push(item);
    }
    for (const item of selected) {
        const sourcePath = path.join(sourceBundleRoot, item);
        assertCopySourceTree(sourcePath);

        const destinationPath = path.join(targetBundleRoot, item);
        ensureWithinRoot(resolvedTargetRoot, destinationPath, 'Sync destination');
        removeContainedPath(resolvedTargetRoot, destinationPath, true);
        ensureContainedDirectory(resolvedTargetRoot, path.dirname(destinationPath));
        copyPathRecursive(sourcePath, destinationPath, resolvedTargetRoot);
    }
}

export function getUpdateSentinelPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'runtime', UPDATE_SENTINEL_FILE_NAME);
}

export function writeUpdateSentinel(bundleRoot: string, metadata: UpdateSentinelMetadata): string {
    const sentinelPath = getUpdateSentinelPath(bundleRoot);
    writeContainedFile(bundleRoot, sentinelPath, JSON.stringify(metadata, null, 2));
    return sentinelPath;
}

export function removeUpdateSentinel(bundleRoot: string): void {
    const sentinelPath = getUpdateSentinelPath(bundleRoot);
    removeContainedPath(bundleRoot, sentinelPath);
}

export function readUpdateSentinel(bundleRoot: string): UpdateSentinelMetadata | null {
    const sentinelPath = getUpdateSentinelPath(bundleRoot);
    assertNoLinkedPathComponents(bundleRoot, sentinelPath);
    if (!fs.existsSync(sentinelPath)) {
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(sentinelPath, 'utf8')) as UpdateSentinelMetadata;
    } catch {
        return null;
    }
}

export function getUninstallSentinelPath(targetRoot: string): string {
    return path.join(targetRoot, UNINSTALL_SENTINEL_FILE_NAME);
}

export function writeUninstallSentinel(targetRoot: string, metadata: UninstallSentinelMetadata): string {
    const sentinelPath = getUninstallSentinelPath(targetRoot);
    writeContainedFile(targetRoot, sentinelPath, JSON.stringify(metadata, null, 2));
    return sentinelPath;
}

export function readUninstallSentinel(targetRoot: string): UninstallSentinelMetadata | null {
    const sentinelPath = getUninstallSentinelPath(targetRoot);
    bindContainedDestination(targetRoot, sentinelPath);
    if (!fs.existsSync(sentinelPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(sentinelPath, 'utf8')) as UninstallSentinelMetadata;
    } catch {
        return null;
    }
}

export function removeUninstallSentinel(targetRoot: string): void {
    const sentinelPath = getUninstallSentinelPath(targetRoot);
    removeContainedPath(targetRoot, sentinelPath);
}

export function validateTargetRoot(targetRoot: string, bundleRoot: string): string {
    const normalizedTarget = path.resolve(targetRoot);
    const normalizedBundle = path.resolve(bundleRoot);
    if (normalizedTarget.toLowerCase() === normalizedBundle.toLowerCase()) {
        throw new Error(
            `TargetRoot points to orchestrator bundle directory '${bundleRoot}'. Use the project root parent directory instead.`
        );
    }
    return normalizedTarget;
}
