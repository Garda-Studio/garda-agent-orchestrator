import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ALL_AGENT_ENTRYPOINT_FILES, resolveBundleName } from '../../core/constants';
import { getProviderBridgeDirectoryPaths } from '../../core/provider-registry';
import {
    BUNDLE_SYNC_ITEMS,
    copyPathRecursive,
    createRollbackSnapshot,
    ensureWithinRoot,
    getLifecycleOperationLockPath,
    getSyncBackupMetadataPath,
    getTimestamp,
    getRollbackRecordsPath,
    readSyncBackupMetadata,
    readUpdateSentinel,
    removePathRecursive,
    withLifecycleOperationLock,
    validateTargetRoot,
    writeRollbackRecords
} from '../common';
import { resolveUpdateSources } from './update-source';
import { assertNoLinkedPathComponents } from '../rollback/rollback-snapshot-integrity';
import {
    executeUpdatePipelineStages,
    type InstallRunnerOptions,
    type MaterializationRunnerOptions,
    type VerifyRunnerOptions,
    type ManifestRunnerOptions,
    type ContractMigrationResult,
    type ContractMigrationRunnerOptions
} from './update-execution';
import { collectUpdateAnnouncements } from './update-announcements';
import { writeUpdateReport, buildUpdateResult } from './update-reporting';
import { assertNoRuntimeLocksBeforeUpdateApply } from '../lock/runtime-lock-preflight';
import { assertUpdateApplyAllowedInSwitchMode } from './update-off-mode';

interface RollbackRecord {
    relativePath: string;
    existed: boolean;
    pathType: string;
}

function bindPreSyncBundleToSnapshot(targetRoot: string, bundleRoot: string, snapshotPath: string, records: RollbackRecord[]): void {
    const sentinel = readUpdateSentinel(bundleRoot);
    if (!sentinel || sentinel.phase !== 'lifecycle') return;
    const ownerPath = path.join(getLifecycleOperationLockPath(targetRoot), 'owner.json');
    assertNoLinkedPathComponents(targetRoot, ownerPath);
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
    const acquiredAt = Date.parse(String(owner.acquired_at_utc || ''));
    const startedAt = Date.parse(String(sentinel.startedAt || ''));
    if (owner.operation !== 'update' || owner.pid !== process.pid
        || normalizeHostnameValue(owner.hostname) !== normalizeHostnameValue(os.hostname())
        || path.resolve(String(owner.target_root || '')) !== path.resolve(targetRoot)
        || !Number.isFinite(acquiredAt) || !Number.isFinite(startedAt) || startedAt < acquiredAt) {
        throw new Error('Update sync backup belongs to a different lifecycle operation.');
    }
    const backupsRoot = path.join(bundleRoot, 'runtime', 'bundle-backups');
    const backupRoot = path.resolve(String(sentinel.syncBackupRoot || ''));
    assertNoLinkedPathComponents(bundleRoot, backupsRoot);
    assertNoLinkedPathComponents(bundleRoot, snapshotPath);
    const backupName = path.relative(backupsRoot, backupRoot);
    if (!backupName || backupName.startsWith('..') || path.isAbsolute(backupName)
        || backupName.includes(path.sep) || !/^\d{8}-\d{6}(?:-\d{3})?$/.test(backupName)) {
        throw new Error('Update sync backup is not a direct child of the bundle backup root.');
    }
    ensureWithinRoot(backupsRoot, backupRoot, 'Update sync backup');
    assertNoLinkedPathComponents(backupsRoot, backupRoot);
    const metadataPath = getSyncBackupMetadataPath(backupRoot);
    if (path.resolve(String(sentinel.syncBackupMetadataPath || '')) !== path.resolve(metadataPath)) {
        throw new Error('Update sync backup metadata is not bound to the selected backup.');
    }
    const metadata = readSyncBackupMetadata(backupRoot);
    const backupCreatedAt = Date.parse(String(metadata.createdAt || ''));
    if (!Number.isFinite(backupCreatedAt) || backupCreatedAt < acquiredAt || backupCreatedAt > startedAt) {
        throw new Error('Update sync backup metadata belongs to a different lifecycle operation.');
    }
    const allowedItems = new Set<string>([...BUNDLE_SYNC_ITEMS, 'live/version.json']);
    const plannedItems = sentinel.plannedSyncItems;
    if (!Array.isArray(plannedItems) || !plannedItems.every((item) => typeof item === 'string' && allowedItems.has(item))
        || new Set(plannedItems).size !== plannedItems.length
        || !Array.isArray(metadata.plannedSyncItems)
        || JSON.stringify(metadata.plannedSyncItems) !== JSON.stringify(plannedItems)
        || !Object.prototype.hasOwnProperty.call(metadata.preexistingMap, 'VERSION')
        || plannedItems.some((item) => !Object.prototype.hasOwnProperty.call(metadata.preexistingMap, item))
        || Object.keys(metadata.preexistingMap).some((item) =>
            item !== 'VERSION' && item !== 'live/version.json' && !plannedItems.includes(item))) {
        throw new Error('Update sync backup metadata does not cover the current sync plan and VERSION.');
    }
    const bundleName = resolveBundleName();
    for (const [item, existed] of Object.entries(metadata.preexistingMap)) {
        if (!allowedItems.has(item) || typeof existed !== 'boolean') {
            throw new Error(`Update sync backup contains an invalid bundle item: ${item}`);
        }
        const relativePath = `${bundleName}/${item}`;
        const nestedLiveVersion = item === 'live/version.json';
        const recordPath = nestedLiveVersion ? `${bundleName}/live` : relativePath;
        const record = records.find((candidate) => candidate.relativePath.replace(/\\/g, '/') === recordPath);
        if (!record) throw new Error(`Rollback snapshot is missing bundle record: ${relativePath}`);
        const snapshotEntry = path.join(snapshotPath, relativePath);
        assertNoLinkedPathComponents(snapshotPath, snapshotEntry);
        if (existed) {
            const backupEntry = path.join(backupRoot, item);
            assertNoLinkedPathComponents(backupRoot, backupEntry);
            if (!fs.existsSync(backupEntry)) throw new Error(`Update sync backup entry is missing: ${item}`);
            removePathRecursive(snapshotEntry);
            fs.mkdirSync(path.dirname(snapshotEntry), { recursive: true });
            copyPathRecursive(backupEntry, snapshotEntry);
            if (!nestedLiveVersion) {
                record.existed = true;
                record.pathType = fs.lstatSync(snapshotEntry).isDirectory() ? 'directory' : 'file';
            }
        } else {
            removePathRecursive(snapshotEntry);
            if (!nestedLiveVersion) {
                record.existed = false;
                record.pathType = 'missing';
            }
        }
    }
    const versionPath = path.join(snapshotPath, bundleName, 'VERSION');
    if (typeof sentinel.fromVersion !== 'string'
        || fs.readFileSync(versionPath, 'utf8').trim() !== sentinel.fromVersion) {
        throw new Error('Rollback snapshot VERSION differs from the current update generation.');
    }
}

interface UpdateTrustContext {
    policy: string;
    overrideUsed: boolean;
    overrideSource: string;
    sourceType: string;
    sourceReference: string;
    gitCommitSha?: string | null;
    requestedPackageSpec?: string | null;
    exactPackageSpec?: string | null;
    resolvedPackageVersion?: string | null;
    resolvedPackageIntegrity?: string | null;
    releaseProvenanceStatus?: string | null;
    releaseProvenanceSummary?: string | null;
    releaseProvenanceRecommendation?: string | null;
}

interface RunUpdateOptions {
    targetRoot: string;
    bundleRoot: string;
    initAnswersPath?: string;
    dryRun?: boolean;
    skipVerify?: boolean;
    skipManifestValidation?: boolean;
    installRunner?: ((options: InstallRunnerOptions) => Record<string, unknown> | void) | null;
    materializationRunner?: ((options: MaterializationRunnerOptions) => Record<string, unknown> | void) | null;
    verifyRunner?: ((options: VerifyRunnerOptions) => unknown) | null;
    manifestRunner?: ((options: ManifestRunnerOptions) => unknown) | null;
    contractMigrationRunner?: ((options: ContractMigrationRunnerOptions) => ContractMigrationResult) | null;
    trustContext?: UpdateTrustContext | null;
    lifecycleLockAlreadyHeld?: boolean;
}

export function getUpdateRollbackItems(rootPath: string, initAnswersResolvedPath: string): string[] {
    const items = [
        ...ALL_AGENT_ENTRYPOINT_FILES,
        TASK_QUEUE_FILENAME,
        '.claude/settings.local.json',
        '.qwen/settings.json',
        ...getProviderBridgeDirectoryPaths(),
        '.gitignore',
        '.git/hooks/pre-commit',
        resolveBundleName() + '/.gitattributes',
        resolveBundleName() + '/bin',
        resolveBundleName() + '/dist',
        resolveBundleName() + '/live',
        resolveBundleName() + '/live/docs/project-memory',
        resolveBundleName() + '/package.json',
        resolveBundleName() + '/src',
        resolveBundleName() + '/template',
        resolveBundleName() + '/README.md',
        resolveBundleName() + '/HOW_TO.md',
        resolveBundleName() + '/MANIFEST.md',
        resolveBundleName() + '/AGENT_INIT_PROMPT.md',
        resolveBundleName() + '/CHANGELOG.md',
        resolveBundleName() + '/LICENSE',
        resolveBundleName() + '/VERSION'
    ];

    const rootResolved = path.resolve(rootPath);
    const answersResolved = path.resolve(initAnswersResolvedPath);
    const rel = path.relative(rootResolved, answersResolved).replace(/\\/g, '/');
    items.push(rel);

    return [...new Set(items)].sort();
}

function normalizeHostnameValue(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

function hasLegacyOuterUpdateLock(normalizedTarget: string, bundleRoot: string): boolean {
    if (!readUpdateSentinel(path.resolve(bundleRoot))) {
        return false;
    }

    const ownerPath = path.join(getLifecycleOperationLockPath(normalizedTarget), 'owner.json');
    if (!fs.existsSync(ownerPath)) {
        return false;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
        const ownerTarget = typeof parsed.target_root === 'string' && parsed.target_root.trim()
            ? path.resolve(String(parsed.target_root))
            : null;

        return typeof parsed.pid === 'number'
            && parsed.pid === process.pid
            && normalizeHostnameValue(parsed.hostname) === normalizeHostnameValue(os.hostname())
            && String(parsed.operation || '').trim() === 'update'
            && ownerTarget === normalizedTarget;
    } catch {
        return false;
    }
}

function runValidatedUpdate(
    normalizedTarget: string,
    options: Omit<RunUpdateOptions, 'targetRoot' | 'lifecycleLockAlreadyHeld'>,
    lifecycleLockAlreadyHeld: boolean
) {
    const {
        bundleRoot,
        initAnswersPath = path.join(resolveBundleName(), 'runtime', 'init-answers.json'),
        dryRun = false,
        skipVerify = false,
        skipManifestValidation = false,
        installRunner = null,
        materializationRunner = null,
        verifyRunner = null,
        manifestRunner = null,
        contractMigrationRunner = null,
        trustContext = null
    } = options;
    const sources = resolveUpdateSources(normalizedTarget, initAnswersPath, bundleRoot);
    const timestamp = getTimestamp();
    const rollbackSnapshotRelativePath = `${resolveBundleName()}/runtime/update-rollbacks/update-${timestamp}`;
    const rollbackSnapshotPath = path.join(normalizedTarget, rollbackSnapshotRelativePath);
    const rollbackRecordsRelativePath = `${rollbackSnapshotRelativePath}/${path.basename(getRollbackRecordsPath(rollbackSnapshotPath))}`;
    const updateReportRelativePath = `${resolveBundleName()}/runtime/update-reports/update-${timestamp}.md`;
    const updateReportPath = path.join(normalizedTarget, updateReportRelativePath);

    let rollbackSnapshotCreated = false;
    let rollbackRecordCount = 0;
    let rollbackRecords: RollbackRecord[] = [];

    const effectiveTrustContext: UpdateTrustContext = trustContext || {
        policy: 'unknown',
        overrideUsed: false,
        overrideSource: 'none',
        sourceType: 'unknown',
        sourceReference: 'unknown',
        gitCommitSha: null,
        requestedPackageSpec: null,
        exactPackageSpec: null,
        resolvedPackageVersion: null,
        resolvedPackageIntegrity: null,
        releaseProvenanceStatus: null,
        releaseProvenanceSummary: null,
        releaseProvenanceRecommendation: null
    };

    assertUpdateApplyAllowedInSwitchMode({
        targetRoot: normalizedTarget,
        bundleRoot,
        applyRequested: true,
        dryRun,
        commandName: 'update apply'
    });

    if (!dryRun) {
        assertNoRuntimeLocksBeforeUpdateApply(bundleRoot);
    }

    if (!dryRun) {
        fs.mkdirSync(path.dirname(rollbackSnapshotPath), { recursive: true });
        const rollbackItems = getUpdateRollbackItems(normalizedTarget, sources.initAnswersResolvedPath);
        rollbackRecords = createRollbackSnapshot(normalizedTarget, rollbackSnapshotPath, rollbackItems) as RollbackRecord[];
        bindPreSyncBundleToSnapshot(normalizedTarget, bundleRoot, rollbackSnapshotPath, rollbackRecords);
        writeRollbackRecords(rollbackSnapshotPath, rollbackRecords);
        rollbackRecordCount = rollbackRecords.length;
        rollbackSnapshotCreated = true;
    }

    const stageResult = executeUpdatePipelineStages({
        normalizedTarget,
        bundleRoot,
        dryRun,
        skipVerify,
        skipManifestValidation,
        lifecycleLockAlreadyHeld,
        sources,
        runners: {
            installRunner,
            materializationRunner,
            verifyRunner,
            manifestRunner,
            contractMigrationRunner
        },
        rollbackSnapshotCreated,
        rollbackSnapshotPath,
        rollbackRecords
    });
    const announcements = !dryRun
        ? collectUpdateAnnouncements(bundleRoot, sources.previousVersion, stageResult.updatedVersion)
        : {
            updateMessages: [],
            releaseNotes: [],
            warnings: []
        };

    if (!dryRun) {
        writeUpdateReport(updateReportPath, {
            normalizedTarget,
            initAnswersResolvedPath: sources.initAnswersResolvedPath,
            rollbackSnapshotRelativePath,
            rollbackRecordsRelativePath,
            rollbackRecordCount,
            rollbackStatus: stageResult.rollbackStatus,
            trustContext: effectiveTrustContext,
            previousVersion: sources.previousVersion,
            previousVersionSource: sources.previousVersionSource,
            bundleVersion: sources.bundleVersion,
            stageResult,
            announcements
        });
    }

    return buildUpdateResult({
        normalizedTarget,
        sources,
        trustContext: effectiveTrustContext,
        rollbackSnapshotRelativePath,
        rollbackRecordsRelativePath,
        rollbackSnapshotCreated,
        rollbackRecordCount,
        stageResult,
        dryRun,
        updateReportRelativePath,
        announcements
    });
}

export function runUpdate(options: RunUpdateOptions) {
    const {
        targetRoot,
        lifecycleLockAlreadyHeld = false,
        ...validatedOptions
    } = options;

    const normalizedTarget = validateTargetRoot(targetRoot, validatedOptions.bundleRoot);
    const effectiveLifecycleLockAlreadyHeld = lifecycleLockAlreadyHeld
        || hasLegacyOuterUpdateLock(normalizedTarget, validatedOptions.bundleRoot);

    if (effectiveLifecycleLockAlreadyHeld) {
        return runValidatedUpdate(normalizedTarget, validatedOptions, true);
    }

    return withLifecycleOperationLock(normalizedTarget, 'update', () => (
        runValidatedUpdate(normalizedTarget, validatedOptions, false)
    ));
}
