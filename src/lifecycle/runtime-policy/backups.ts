import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveBundleName } from '../../core/constants';
import {
    assertBoundContainedRemovalTree,
    assertContainedDestination,
    bindContainedDestination,
    readBoundedContainedDirectory,
    removeBoundContainedPath,
    type ContainedDestination
} from '../../core/contained-filesystem';
import { lstatFileIdentitySync } from '../../core/file-stat';
import {
    createRollbackSnapshot,
    ensureWithinRoot,
    ensureRelativeSafe,
    getLifecycleOperationLockPath,
    getRollbackRecordsPath,
    getTimestamp,
    readRollbackRecords,
    validateTargetRoot,
    writeRollbackRecords,
    withLifecycleOperationLock
} from '../common';
import { getUpdateRollbackItems } from '../update/update';
import { processCleanupCandidates } from '../cleanup/cleanup-removal';
import type { CleanupItem } from '../cleanup/cleanup-types';
import { withLifecycleRuntimeMutationGenerationForPath } from '../runtime-mutation-generation';

export const DEFAULT_BACKUP_KEEP_LATEST = 10;

const BACKUP_METADATA_FILE_NAME = 'backup-metadata.json';
const BACKUP_ID_PATTERN = /^(update|scheduled|manual)-(\d{8}-\d{6})(?:-(\d{3}))?$/i;
const BACKUP_TIMESTAMP_PATTERN = /^\d{8}-\d{6}(?:-\d{3})?$/;

export type BackupReason = 'update' | 'scheduled' | 'manual';
export type BackupHealthStatus = 'AVAILABLE' | 'MISSING_RECORDS' | 'INVALID_RECORDS';

export interface BackupMetadata {
    schemaVersion: 1;
    reason: BackupReason;
    createdAt: string;
    source: 'backup-backend';
}

export interface BackupSummary {
    id: string;
    reason: BackupReason;
    createdAt: string;
    snapshotPath: string;
    relativeSnapshotPath: string;
    restoreSnapshotPath: string;
    rollbackRecordsPath: string;
    sizeBytes: number;
    recordCount: number;
    health: BackupHealthStatus;
    healthMessage: string | null;
}

export interface CreateBackupSnapshotOptions {
    targetRoot: string;
    bundleRoot: string;
    reason: BackupReason;
    initAnswersPath?: string;
    timestamp?: string;
}

export interface BackupRetentionOptions {
    targetRoot: string;
    bundleRoot?: string;
    keepLatest?: number;
    dryRun?: boolean;
}

export interface BackupRetentionResult {
    targetRoot: string;
    keepLatest: number;
    dryRun: boolean;
    candidates: CleanupItem[];
    removed: CleanupItem[];
    skipped: CleanupItem[];
    errors: Array<{ path: string; message: string }>;
    totalFreedBytes: number;
    result: 'SUCCESS' | 'ERRORS';
}

export interface BackupDeletionOptions {
    targetRoot: string;
    snapshotIds: readonly string[];
}

export interface ConfirmedBackupDeletionOptions extends BackupDeletionOptions {
    confirmationToken: string;
    confirm: boolean;
    confirmFinalRecoveryPoint?: boolean;
}

export interface BackupDeletionPreview {
    targetRoot: string;
    snapshotIds: string[];
    backups: BackupSummary[];
    confirmationToken: string;
    totalSizeBytes: number;
    lostRecoveryPointCount: number;
    remainingRecoveryPointCount: number;
    requiresFinalRecoveryPointConfirmation: boolean;
    warnings: string[];
}

export interface BackupDeletionResult {
    targetRoot: string;
    requestedIds: string[];
    removedIds: string[];
    errors: Array<{ snapshotId: string; message: string }>;
    totalFreedBytes: number;
    inventory: BackupSummary[];
    inventoryRefreshed: boolean;
    inventoryError: string | null;
    result: 'SUCCESS' | 'ERRORS';
}

const BACKUP_DELETION_LIMITS = Object.freeze({
    snapshots: 128,
    inventoryEntries: 2048,
    members: 100_000,
    fileBytes: 64 * 1024 * 1024,
    metadataBytes: 1024 * 1024,
    totalBytes: 2 * 1024 * 1024 * 1024
});

interface CapturedBackupMember {
    binding: ContainedDestination;
    metadata: string;
    directory: boolean;
    sizeBytes: number;
    sha256: string;
    names: string[];
    bytes?: Buffer;
}

interface CapturedBackup {
    summary: BackupSummary;
    members: CapturedBackupMember[];
    digest: string;
}

interface CapturedBackupInventory {
    root: ContainedDestination;
    names: string[];
    backups: CapturedBackup[];
}

interface BackupCaptureBudget { members: number; bytes: number }

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRuntimeRoot(targetRoot: string): string {
    return path.join(targetRoot, resolveBundleName(), 'runtime');
}

export function getBackupSnapshotsRoot(targetRoot: string): string {
    return path.join(getRuntimeRoot(targetRoot), 'update-rollbacks');
}

function getBackupMetadataPath(snapshotPath: string): string {
    return path.join(snapshotPath, BACKUP_METADATA_FILE_NAME);
}

function toRelativeTargetPath(targetRoot: string, absolutePath: string): string {
    return path.relative(targetRoot, absolutePath).replace(/\\/g, '/');
}

function calculatePathSizeBytes(targetPath: string): number {
    try {
        const stat = fs.statSync(targetPath);
        if (!stat.isDirectory()) {
            return stat.size;
        }
    } catch {
        return 0;
    }

    let total = 0;
    const stack = [targetPath];
    while (stack.length > 0) {
        const current = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            try {
                total += fs.statSync(fullPath).size;
            } catch {
                // Ignore unreadable files while reporting best-effort inventory size.
            }
        }
    }
    return total;
}

function normalizeBackupTimestamp(timestamp: string): string {
    const normalized = String(timestamp || '').trim();
    if (!BACKUP_TIMESTAMP_PATTERN.test(normalized)) {
        throw new Error(`Backup timestamp must match YYYYMMDD-HHMMSS[-mmm]: ${timestamp}`);
    }
    return normalized;
}

function parseCreatedAtFromId(id: string): string | null {
    const match = BACKUP_ID_PATTERN.exec(id);
    if (!match) {
        return null;
    }
    const [, , baseTimestamp, millis = '000'] = match;
    const compact = `${baseTimestamp}-${millis}`;
    const dateMatch = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/.exec(compact);
    if (!dateMatch) {
        return null;
    }
    const [, year, month, day, hour, minute, second, ms] = dateMatch;
    return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number(ms)
    ).toISOString();
}

function inferReasonFromId(id: string): BackupReason | null {
    const match = BACKUP_ID_PATTERN.exec(id);
    if (!match) {
        return null;
    }
    const reason = match[1].toLowerCase();
    return reason === 'scheduled' ? 'scheduled'
        : reason === 'manual' ? 'manual'
            : 'update';
}

function readBackupMetadata(snapshotPath: string): BackupMetadata | null {
    const metadataPath = getBackupMetadataPath(snapshotPath);
    if (!fs.existsSync(metadataPath)) {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const parsedObject = isJsonObject(parsed) ? parsed : null;
        const reason = parsedObject?.reason === 'scheduled' ? 'scheduled'
            : parsedObject?.reason === 'manual' ? 'manual'
                : parsedObject?.reason === 'update' ? 'update'
                : null;
        const createdAt = typeof parsedObject?.createdAt === 'string' && parsedObject.createdAt.trim()
            ? parsedObject.createdAt.trim()
            : null;
        if (!reason || !createdAt) {
            return null;
        }
        return {
            schemaVersion: 1,
            reason,
            createdAt,
            source: 'backup-backend'
        };
    } catch {
        return null;
    }
}

function writeBackupMetadata(snapshotPath: string, metadata: BackupMetadata): string {
    const metadataPath = getBackupMetadataPath(snapshotPath);
    fs.mkdirSync(snapshotPath, { recursive: true });
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    return metadataPath;
}

function getBackupDirectoryEntries(targetRoot: string): string[] {
    const snapshotsRoot = getBackupSnapshotsRoot(targetRoot);
    if (!fs.existsSync(snapshotsRoot)) {
        return [];
    }
    return fs.readdirSync(snapshotsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && BACKUP_ID_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort();
}

function buildBackupSummary(targetRoot: string, snapshotPath: string): BackupSummary {
    const id = path.basename(snapshotPath);
    const metadata = readBackupMetadata(snapshotPath);
    const reason = metadata?.reason ?? inferReasonFromId(id) ?? 'update';
    const createdAt = metadata?.createdAt ?? parseCreatedAtFromId(id) ?? fs.statSync(snapshotPath).mtime.toISOString();
    const rollbackRecordsPath = getRollbackRecordsPath(snapshotPath);

    let recordCount = 0;
    let health: BackupHealthStatus = 'AVAILABLE';
    let healthMessage: string | null = null;
    try {
        recordCount = readRollbackRecords(snapshotPath).length;
    } catch (error: unknown) {
        healthMessage = error instanceof Error ? error.message : String(error);
        health = fs.existsSync(rollbackRecordsPath) ? 'INVALID_RECORDS' : 'MISSING_RECORDS';
    }

    return {
        id,
        reason,
        createdAt,
        snapshotPath,
        relativeSnapshotPath: toRelativeTargetPath(targetRoot, snapshotPath),
        restoreSnapshotPath: snapshotPath,
        rollbackRecordsPath,
        sizeBytes: calculatePathSizeBytes(snapshotPath),
        recordCount,
        health,
        healthMessage
    };
}

function compareBackupNewestFirst(left: BackupSummary, right: BackupSummary): number {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return rightTime - leftTime;
    }
    return right.id.localeCompare(left.id);
}

export function listBackups(targetRoot: string): BackupSummary[] {
    const normalizedTarget = path.resolve(targetRoot);
    const snapshotsRoot = getBackupSnapshotsRoot(normalizedTarget);
    return getBackupDirectoryEntries(normalizedTarget)
        .map((entryName) => buildBackupSummary(normalizedTarget, path.join(snapshotsRoot, entryName)))
        .sort(compareBackupNewestFirst);
}

export function resolveBackupRestoreSnapshotPath(targetRoot: string, backupIdOrPath: string): string {
    const normalizedTarget = path.resolve(targetRoot);
    const value = String(backupIdOrPath || '').trim();
    if (!value) {
        throw new Error('Backup restore target is required.');
    }

    const byId = listBackups(normalizedTarget).find((backup) => backup.id === value);
    const candidate = byId
        ? byId.snapshotPath
        : path.isAbsolute(value)
            ? value
            : path.resolve(normalizedTarget, value);
    const resolved = ensureWithinRoot(normalizedTarget, candidate, 'Backup restore snapshot path');
    const summary = listBackups(normalizedTarget).find((backup) => path.resolve(backup.snapshotPath) === resolved);
    if (!summary) {
        throw new Error(`Backup restore target was not found in backup inventory: ${backupIdOrPath}`);
    }
    if (summary.health !== 'AVAILABLE') {
        throw new Error(`Backup '${summary.id}' is not restorable: ${summary.healthMessage || summary.health}`);
    }
    return resolved;
}

export function createBackupSnapshot(options: CreateBackupSnapshotOptions): BackupSummary {
    const {
        targetRoot,
        bundleRoot,
        reason,
        initAnswersPath = path.join(resolveBundleName(), 'runtime', 'init-answers.json'),
        timestamp = getTimestamp()
    } = options;
    if (reason !== 'update' && reason !== 'scheduled' && reason !== 'manual') {
        throw new Error(`Unsupported backup reason: ${reason}`);
    }

    const normalizedTarget = validateTargetRoot(targetRoot, bundleRoot);
    const normalizedTimestamp = normalizeBackupTimestamp(timestamp);
    const snapshotPath = path.join(getBackupSnapshotsRoot(normalizedTarget), `${reason}-${normalizedTimestamp}`);
    const initAnswersResolvedPath = path.isAbsolute(initAnswersPath)
        ? initAnswersPath
        : path.resolve(normalizedTarget, initAnswersPath);
    ensureWithinRoot(normalizedTarget, initAnswersResolvedPath, 'Init answers path');

    return withLifecycleOperationLock(normalizedTarget, 'backup', () => withLifecycleRuntimeMutationGenerationForPath(
        snapshotPath,
        'lifecycle-backup-snapshot-create',
        () => {
            const rollbackItems = getUpdateRollbackItems(normalizedTarget, initAnswersResolvedPath);
            const records = createRollbackSnapshot(normalizedTarget, snapshotPath, rollbackItems);
            writeRollbackRecords(snapshotPath, records);
            writeBackupMetadata(snapshotPath, {
                schemaVersion: 1,
                reason,
                createdAt: parseCreatedAtFromId(path.basename(snapshotPath)) ?? new Date().toISOString(),
                source: 'backup-backend'
            });

            return buildBackupSummary(normalizedTarget, snapshotPath);
        }
    ));
}

export function pruneBackups(options: BackupRetentionOptions): BackupRetentionResult {
    const keepLatest = options.keepLatest ?? DEFAULT_BACKUP_KEEP_LATEST;
    if (!Number.isInteger(keepLatest) || keepLatest < 0) {
        throw new Error(`Backup retention keepLatest must be a non-negative integer: ${keepLatest}`);
    }
    const targetRoot = validateTargetRoot(options.targetRoot,
        options.bundleRoot ?? path.join(options.targetRoot, resolveBundleName()));
    const execute = () => pruneBackupsUnderLock({ ...options, targetRoot, keepLatest });
    return options.dryRun ? execute() : withLifecycleOperationLock(targetRoot, 'backup-retention', execute);
}

function pruneBackupsUnderLock(options: BackupRetentionOptions): BackupRetentionResult {
    const {
        targetRoot,
        bundleRoot = path.join(targetRoot, resolveBundleName()),
        keepLatest = DEFAULT_BACKUP_KEEP_LATEST,
        dryRun = false
    } = options;
    const normalizedTarget = validateTargetRoot(targetRoot, bundleRoot);
    const runtimeRoot = getRuntimeRoot(normalizedTarget);
    const candidates = listBackups(normalizedTarget)
        .slice(keepLatest)
        .map((backup): CleanupItem => ({
            path: backup.snapshotPath,
            category: 'backups',
            reason: 'count',
            sizeBytes: backup.sizeBytes
        }));
    const executePrune = () => processCleanupCandidates(candidates, dryRun, runtimeRoot);
    const { removed, skipped, errors, totalFreedBytes } = !dryRun && candidates.length > 0
        ? withLifecycleRuntimeMutationGenerationForPath(
            candidates[0].path,
            'lifecycle-backup-retention-prune',
            executePrune
        )
        : executePrune();
    return {
        targetRoot: normalizedTarget,
        keepLatest,
        dryRun,
        candidates,
        removed,
        skipped,
        errors,
        totalFreedBytes,
        result: errors.length > 0 ? 'ERRORS' : 'SUCCESS'
    };
}

function backupDigest(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function backupMemberKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function backupStatMetadata(stat: fs.BigIntStats): string {
    return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.birthtimeNs,
        stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function normalizeSelectedBackupIds(values: readonly string[]): string[] {
    if (!Array.isArray(values) || values.length === 0 || values.length > BACKUP_DELETION_LIMITS.snapshots) {
        throw new Error('Backup selection requires 1 to 128 explicit snapshot IDs.');
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < values.length; index += 1) {
        const id = values[index];
        if (!Object.prototype.hasOwnProperty.call(values, index) || typeof id !== 'string'
            || !BACKUP_ID_PATTERN.test(id) || seen.has(id.toLowerCase())) {
            throw new Error('Backup selection requires dense, unique inventory snapshot IDs, never paths.');
        }
        seen.add(id.toLowerCase());
        ids.push(id);
    }
    return ids.sort();
}

function assertNoActiveBackupLifecycle(targetRoot: string): void {
    try {
        fs.lstatSync(getLifecycleOperationLockPath(targetRoot));
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    throw new Error('Backup deletion is unavailable during an active lifecycle operation; preserve the snapshot and retry after backup, restore or update finishes.');
}

function readBoundBackupFile(binding: ContainedDestination, metadata: string, retainBytes: boolean): {
    sha256: string; bytes?: Buffer
} {
    assertContainedDestination(binding);
    const descriptor = fs.openSync(binding.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const before = fs.fstatSync(descriptor, { bigint: true });
        const limit = retainBytes ? BACKUP_DELETION_LIMITS.metadataBytes : BACKUP_DELETION_LIMITS.fileBytes;
        if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)
            || backupStatMetadata(before) !== metadata) {
            throw new Error(`Backup file identity or bounded size changed: ${binding.path}`);
        }
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        const chunks: Buffer[] = [];
        let total = 0;
        for (let count = fs.readSync(descriptor, buffer); count > 0; count = fs.readSync(descriptor, buffer)) {
            total += count;
            if (total > limit) throw new Error(`Backup file byte limit exceeded: ${binding.path}`);
            hash.update(buffer.subarray(0, count));
            if (retainBytes) chunks.push(Buffer.from(buffer.subarray(0, count)));
        }
        if (total !== Number(before.size) || backupStatMetadata(fs.fstatSync(descriptor, { bigint: true })) !== metadata) {
            throw new Error(`Backup file changed while reading: ${binding.path}`);
        }
        assertContainedDestination(binding);
        if (backupStatMetadata(lstatFileIdentitySync(binding.path, { bigint: true })) !== metadata) {
            throw new Error(`Backup file changed after reading: ${binding.path}`);
        }
        return { sha256: hash.digest('hex'), ...(retainBytes ? { bytes: Buffer.concat(chunks) } : {}) };
    } finally { fs.closeSync(descriptor); }
}

function captureBackupMembers(targetRoot: string, snapshotPath: string, budget: BackupCaptureBudget): CapturedBackupMember[] {
    const snapshot = bindContainedDestination(targetRoot, snapshotPath);
    if (snapshot.missingAt || !fs.lstatSync(snapshot.path).isDirectory()) {
        throw new Error(`Backup snapshot is missing or not an ordinary directory: ${snapshotPath}`);
    }
    assertBoundContainedRemovalTree(snapshot, BACKUP_DELETION_LIMITS.members);
    const pending = [snapshot];
    const members: CapturedBackupMember[] = [];
    const metadataPaths = new Set([BACKUP_METADATA_FILE_NAME, 'rollback-records.json', 'rollback-integrity.json',
        `${resolveBundleName()}/VERSION`]);
    while (pending.length > 0) {
        if (++budget.members > BACKUP_DELETION_LIMITS.members) throw new Error('Backup inventory member limit exceeded.');
        const binding = pending.pop()!;
        assertContainedDestination(binding);
        const stat = lstatFileIdentitySync(binding.path, { bigint: true });
        const metadata = backupStatMetadata(stat);
        const directory = stat.isDirectory();
        const relative = path.relative(snapshotPath, binding.path).split(path.sep).join('/');
        const names = directory ? readBoundedContainedDirectory(binding, BACKUP_DELETION_LIMITS.members - budget.members) : [];
        if (names.some(name => name.toLowerCase() === '.git')) throw new Error('Backup snapshot crosses a nested repository boundary.');
        const sizeBytes = directory ? 0 : Number(stat.size);
        budget.bytes += sizeBytes;
        if (budget.bytes > BACKUP_DELETION_LIMITS.totalBytes) throw new Error('Backup inventory byte limit exceeded.');
        const content = directory ? { sha256: '' } : readBoundBackupFile(binding, metadata, metadataPaths.has(relative));
        if (backupStatMetadata(lstatFileIdentitySync(binding.path, { bigint: true })) !== metadata) {
            throw new Error(`Backup member changed during capture: ${binding.path}`);
        }
        members.push({ binding, metadata, directory, sizeBytes, names, ...content });
        pending.push(...names.map(name => bindContainedDestination(targetRoot, path.join(binding.path, name))));
    }
    const byPath = new Map(members.map(member => [backupMemberKey(member.binding.path), member]));
    for (const member of [...members].reverse()) {
        if (member.directory) member.sha256 = backupDigest(JSON.stringify(member.names.map(name => {
            const child = byPath.get(backupMemberKey(path.join(member.binding.path, name)))!;
            return [name, child.directory ? 'directory' : 'file', child.sha256];
        })));
    }
    assertBoundContainedRemovalTree(snapshot, BACKUP_DELETION_LIMITS.members, members.map(member => member.binding));
    return members;
}

function capturedBackupRecoveryPoint(
    snapshotPath: string, members: ReadonlyMap<string, CapturedBackupMember>
): number {
    const recordsFile = members.get(backupMemberKey(getRollbackRecordsPath(snapshotPath)));
    if (!recordsFile?.bytes) throw new Error('Rollback records file not found in captured snapshot.');
    const parsed: unknown = JSON.parse(recordsFile.bytes.toString('utf8'));
    if (!Array.isArray(parsed)) throw new Error('Rollback records file must contain an array.');
    const seen = new Set<string>();
    const records = parsed.map((value: unknown) => {
        if (!isJsonObject(value) || typeof value.relativePath !== 'string' || !value.relativePath.trim()) {
            throw new Error('Rollback record is missing relativePath.');
        }
        const relativePath = value.relativePath.trim();
        ensureRelativeSafe(relativePath, 'Rollback record relativePath');
        const key = relativePath.replace(/\\/g, '/').toLowerCase();
        if (seen.has(key)) throw new Error('Duplicate rollback record.');
        seen.add(key);
        if (typeof value.existed !== 'boolean' || !['file', 'directory', 'missing'].includes(String(value.pathType))
            || (value.existed && value.pathType === 'missing') || (!value.existed && value.pathType !== 'missing')) {
            throw new Error('Rollback record has invalid existence or pathType.');
        }
        const member = members.get(backupMemberKey(path.join(snapshotPath, relativePath)));
        const kind = member ? member.directory ? 'directory' : 'file' : 'missing';
        if (value.existed ? kind !== value.pathType : kind !== 'missing') {
            throw new Error('Rollback snapshot entry type mismatch.');
        }
        return { relativePath, existed: value.existed, pathType: value.pathType as string,
            digest: { relativePath, kind, sha256: member?.sha256 ?? null } };
    });
    const versionRecord = records.find(record => record.relativePath.replace(/\\/g, '/') === `${resolveBundleName()}/VERSION`);
    let version: string | null = null;
    if (versionRecord?.existed && versionRecord.pathType === 'file') {
        version = members.get(backupMemberKey(path.join(snapshotPath, resolveBundleName(), 'VERSION')))?.bytes?.toString('utf8').trim() ?? '';
        if (!version) throw new Error('Rollback snapshot VERSION is empty or missing.');
    }
    const actual = { schemaVersion: 1, snapshotName: path.basename(snapshotPath),
        recordsSha256: recordsFile.sha256, version, entries: records.map(record => record.digest) };
    const integrityFile = members.get(backupMemberKey(path.join(snapshotPath, 'rollback-integrity.json')));
    if (!integrityFile?.bytes || JSON.stringify(JSON.parse(integrityFile.bytes.toString('utf8'))) !== JSON.stringify(actual)) {
        throw new Error('Rollback snapshot integrity mismatch in captured snapshot.');
    }
    return records.length;
}

function buildCapturedBackupSummary(targetRoot: string, snapshotPath: string, captured: CapturedBackupMember[]): BackupSummary {
    const id = path.basename(snapshotPath);
    const members = new Map(captured.map(member => [backupMemberKey(member.binding.path), member]));
    let metadata: Record<string, unknown> | null = null;
    try {
        const bytes = members.get(backupMemberKey(getBackupMetadataPath(snapshotPath)))?.bytes;
        const value: unknown = bytes ? JSON.parse(bytes.toString('utf8')) : null;
        metadata = isJsonObject(value) ? value : null;
    } catch { /* Optional display metadata never grants deletion or recovery authority. */ }
    let health: BackupHealthStatus = 'AVAILABLE';
    let healthMessage: string | null = null;
    let recordCount = 0;
    try { recordCount = capturedBackupRecoveryPoint(snapshotPath, members); }
    catch (error: unknown) {
        health = members.has(backupMemberKey(getRollbackRecordsPath(snapshotPath))) ? 'INVALID_RECORDS' : 'MISSING_RECORDS';
        healthMessage = error instanceof Error ? error.message : String(error);
    }
    const reason = metadata?.reason === 'update' || metadata?.reason === 'manual' || metadata?.reason === 'scheduled'
        ? metadata.reason : inferReasonFromId(id) ?? 'update';
    const createdAt = typeof metadata?.createdAt === 'string' && metadata.createdAt.length <= 64
        && Number.isFinite(Date.parse(metadata.createdAt)) ? metadata.createdAt.trim() : parseCreatedAtFromId(id)!;
    return { id, reason, createdAt, snapshotPath, relativeSnapshotPath: toRelativeTargetPath(targetRoot, snapshotPath),
        restoreSnapshotPath: snapshotPath, rollbackRecordsPath: getRollbackRecordsPath(snapshotPath),
        sizeBytes: captured.reduce((sum, member) => sum + member.sizeBytes, 0), recordCount, health, healthMessage };
}

function capturedBackupDigest(members: readonly CapturedBackupMember[]): string {
    return backupDigest(JSON.stringify(members.map(member => [member.binding.path, member.metadata, member.sha256])
        .sort((left, right) => left[0].localeCompare(right[0]))));
}

function captureBackupInventory(targetRoot: string): CapturedBackupInventory {
    bindContainedDestination(path.parse(targetRoot).root, targetRoot);
    const root = bindContainedDestination(targetRoot, getBackupSnapshotsRoot(targetRoot));
    if (root.missingAt) throw new Error('Backup inventory was not found; no selected snapshot can be deleted.');
    const names = readBoundedContainedDirectory(root, BACKUP_DELETION_LIMITS.inventoryEntries);
    const budget: BackupCaptureBudget = { members: 0, bytes: 0 };
    const backups = names.filter(name => BACKUP_ID_PATTERN.test(name)).map(id => {
        const snapshotPath = path.join(root.path, id);
        const members = captureBackupMembers(targetRoot, snapshotPath, budget);
        return { summary: buildCapturedBackupSummary(targetRoot, snapshotPath, members), members,
            digest: capturedBackupDigest(members) };
    });
    if (JSON.stringify(readBoundedContainedDirectory(root, BACKUP_DELETION_LIMITS.inventoryEntries)) !== JSON.stringify(names)) {
        throw new Error('Backup inventory selection changed while inspecting.');
    }
    for (const backup of backups) for (const member of backup.members) {
        assertContainedDestination(member.binding);
        if (backupStatMetadata(lstatFileIdentitySync(member.binding.path, { bigint: true })) !== member.metadata) {
            throw new Error('Backup inventory selection changed while inspecting.');
        }
    }
    return { root, names, backups };
}

function backupInventoryDigest(inventory: CapturedBackupInventory): string {
    return backupDigest(JSON.stringify({ root: inventory.root.path,
        ancestry: inventory.root.existing.map(member => [member.path, member.dev.toString(), member.ino.toString(),
            member.mode.toString(), member.birthtimeNs.toString()]), names: inventory.names,
        backups: inventory.backups.map(backup => [backup.summary.id, backup.digest]) }));
}

function buildBackupDeletionPreview(targetRoot: string, ids: string[], inventory: CapturedBackupInventory): BackupDeletionPreview {
    const selected = ids.map(id => {
        const backup = inventory.backups.find(candidate => candidate.summary.id === id);
        if (!backup) throw new Error(`Selected backup snapshot was not found in current inventory: ${id}`);
        return backup.summary;
    });
    const lostRecoveryPointCount = selected.filter(backup => backup.health === 'AVAILABLE').length;
    const remainingRecoveryPointCount = inventory.backups.filter(backup =>
        !ids.includes(backup.summary.id) && backup.summary.health === 'AVAILABLE').length;
    const final = lostRecoveryPointCount > 0 && remainingRecoveryPointCount === 0 || ids.length === inventory.backups.length;
    return { targetRoot, snapshotIds: ids, backups: selected,
        confirmationToken: backupDigest(JSON.stringify({ selection: ids, inventory: backupInventoryDigest(inventory) })),
        totalSizeBytes: selected.reduce((sum, backup) => sum + backup.sizeBytes, 0),
        lostRecoveryPointCount, remainingRecoveryPointCount, requiresFinalRecoveryPointConfirmation: final,
        warnings: final ? ['This selection removes the final recovery point or last backup snapshot. Explicit final recovery point confirmation is required.'] : [] };
}

export function previewBackupDeletion(options: BackupDeletionOptions): BackupDeletionPreview {
    const targetRoot = path.resolve(options.targetRoot);
    const ids = normalizeSelectedBackupIds(options.snapshotIds);
    assertNoActiveBackupLifecycle(targetRoot);
    const inventory = captureBackupInventory(targetRoot);
    assertNoActiveBackupLifecycle(targetRoot);
    return buildBackupDeletionPreview(targetRoot, ids, inventory);
}

function removeCapturedBackup(backup: CapturedBackup, onFileRemoved: (bytes: number) => void): void {
    const bindings = backup.members.map(member => member.binding);
    assertBoundContainedRemovalTree(bindings[0], BACKUP_DELETION_LIMITS.members, bindings);
    for (const member of [...backup.members].reverse()) {
        assertContainedDestination(member.binding);
        if (!member.directory && readBoundBackupFile(member.binding, member.metadata, false).sha256 !== member.sha256) {
            throw new Error('Selected backup file content changed before removal.');
        }
        removeBoundContainedPath(member.binding, false, () => {
            if (!member.directory) onFileRemoved(member.sizeBytes);
        });
    }
}

function applyCapturedBackupDeletion(targetRoot: string, ids: string[], original: CapturedBackupInventory): BackupDeletionResult {
    const result: BackupDeletionResult = { targetRoot, requestedIds: ids, removedIds: [], errors: [],
        totalFreedBytes: 0, inventory: [], inventoryRefreshed: false, inventoryError: null, result: 'SUCCESS' };
    for (let index = 0; index < ids.length; index += 1) {
        try {
            const current = captureBackupInventory(targetRoot);
            const expected = { ...original, names: original.names.filter(name => !result.removedIds.includes(name)),
                backups: original.backups.filter(backup => !result.removedIds.includes(backup.summary.id)) };
            if (backupInventoryDigest(current) !== backupInventoryDigest(expected)) {
                throw new Error('Backup inventory selection changed before removal; obtain a fresh preview.');
            }
            const selected = current.backups.find(backup => backup.summary.id === ids[index])!;
            removeCapturedBackup(selected, bytes => { result.totalFreedBytes += bytes; });
            result.removedIds.push(ids[index]);
        } catch (error: unknown) {
            result.errors.push({ snapshotId: ids[index], message: error instanceof Error ? error.message : String(error) });
            result.errors.push(...ids.slice(index + 1).map(snapshotId => ({ snapshotId,
                message: 'Not attempted after a prior selected snapshot failure; preserved for a fresh preview.' })));
            break;
        }
    }
    try {
        result.inventory = captureBackupInventory(targetRoot).backups.map(backup => backup.summary).sort(compareBackupNewestFirst);
        result.inventoryRefreshed = true;
    } catch (error: unknown) { result.inventoryError = error instanceof Error ? error.message : String(error); }
    result.result = result.errors.length || result.inventoryError ? 'ERRORS' : 'SUCCESS';
    return result;
}

export function deleteSelectedBackups(options: ConfirmedBackupDeletionOptions): BackupDeletionResult {
    const targetRoot = path.resolve(options.targetRoot);
    const ids = normalizeSelectedBackupIds(options.snapshotIds);
    if (options.confirm !== true) throw new Error('Selected backup deletion requires explicit confirmation.');
    if (typeof options.confirmationToken !== 'string' || !/^[a-f0-9]{64}$/u.test(options.confirmationToken)) {
        throw new Error('Selected backup deletion requires the exact confirmation token from a current preview.');
    }
    assertNoActiveBackupLifecycle(targetRoot);
    return withLifecycleOperationLock(targetRoot, 'backup-delete', () => {
        const inventory = captureBackupInventory(targetRoot);
        const preview = buildBackupDeletionPreview(targetRoot, ids, inventory);
        if (preview.confirmationToken !== options.confirmationToken) throw new Error('Backup inventory selection changed or confirmation token belongs to another target; obtain a fresh preview.');
        if (preview.requiresFinalRecoveryPointConfirmation && options.confirmFinalRecoveryPoint !== true) {
            throw new Error('Deleting the final recovery point requires explicit final recovery point confirmation.');
        }
        return withLifecycleRuntimeMutationGenerationForPath(inventory.root.path, 'lifecycle-selected-backup-delete',
            () => applyCapturedBackupDeletion(targetRoot, ids, inventory));
    });
}
