import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../../core/constants';
import { pathExists, readTextFile } from '../../core/filesystem';
import { validateInitAnswers } from '../../schemas/init-answers';
import { runInstall } from '../../materialization/install';
import { runInit } from '../../materialization/init';
import {
    BUNDLE_SYNC_ITEMS,
    compareVersionStrings,
    copyPathRecursive,
    createRollbackSnapshot,
    ensureWithinRoot,
    getRollbackRecordsPath,
    getTimestamp,
    readRollbackRecords,
    removePathRecursive,
    removeUpdateSentinel,
    restoreRollbackSnapshot,
    validateTargetRoot,
    withLifecycleOperationLockAsync,
    writeRollbackRecords,
    writeSyncBackupMetadata,
    writeUpdateSentinel
} from '../common';
import { getUpdateRollbackItems } from '../update/update';
import { acquireUpdateSource, DEFAULT_PACKAGE_NAME } from '../check-update';
import { validatePathSourceTrust } from '../update/update-trust';
import { formatManifestResult, validateManifest } from '../../validators/validate-manifest';
import { formatVerifyResult, runVerify } from '../../validators/verify';
import { assertNoLinkedPathComponents, verifyRestoredRollbackSnapshot } from './rollback-snapshot-integrity';
import {
    withLifecycleRuntimeMutationGeneration,
    withLifecycleRuntimeMutationGenerationAsync
} from '../runtime-mutation-generation';

interface RollbackLifecycleOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
}

interface RunRollbackToVersionOptions extends RollbackLifecycleOptions {
    targetVersion: string;
    sourcePath?: string | null;
    packageSpec?: string | null;
    trustOverride?: boolean;
    initAnswersPath?: string;
    skipVerify?: boolean;
    skipManifestValidation?: boolean;
    installRunner?: (options: Parameters<typeof runInstall>[0]) => unknown;
    materializationRunner?: (options: Parameters<typeof runInit>[0]) => unknown;
}

interface RunSnapshotRollbackOptions extends RollbackLifecycleOptions {
    snapshotPath?: string | null;
}

interface RunRollbackOptions extends RunSnapshotRollbackOptions {
    targetVersion?: string | null;
    sourcePath?: string | null;
    packageSpec?: string | null;
    initAnswersPath?: string;
    trustOverride?: boolean;
    skipVerify?: boolean;
    skipManifestValidation?: boolean;
    installRunner?: (options: Parameters<typeof runInstall>[0]) => unknown;
    materializationRunner?: (options: Parameters<typeof runInit>[0]) => unknown;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function readVersionOrFallback(versionPath: string, fallbackValue: string = 'unknown'): string {
    if (!pathExists(versionPath)) {
        return fallbackValue;
    }

    const value = readTextFile(versionPath).trim();
    return value || fallbackValue;
}

function syncRestoredLiveVersion(bundleRoot: string, version: string): void {
    const liveVersionPath = path.join(bundleRoot, 'live', 'version.json');
    if (!pathExists(liveVersionPath)) return;
    assertNoLinkedPathComponents(bundleRoot, liveVersionPath);
    const parsed = JSON.parse(readTextFile(liveVersionPath)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Restored live/version.json is invalid: ${liveVersionPath}`);
    }
    parsed.Version = version;
    parsed.UpdatedAt = new Date().toISOString();
    fs.writeFileSync(liveVersionPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
}

export function getRollbackSnapshotsRoot(targetRoot: string): string {
    return path.join(targetRoot, resolveBundleName(), 'runtime', 'update-rollbacks');
}

export function getBundleBackupsRoot(targetRoot: string): string {
    return path.join(targetRoot, resolveBundleName(), 'runtime', 'bundle-backups');
}

export function listRollbackSnapshotPaths(targetRoot: string): string[] {
    const snapshotsRoot = getRollbackSnapshotsRoot(targetRoot);
    if (!pathExists(snapshotsRoot)) {
        return [];
    }

    return fs.readdirSync(snapshotsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^update-\d{8}-\d{6}(?:-\d{3})?$/i.test(entry.name))
        .map((entry) => path.join(snapshotsRoot, entry.name))
        .sort((left, right) => right.localeCompare(left));
}

export function resolveRollbackSnapshotPath(targetRoot: string, snapshotPath?: string | null): string {
    const normalizedTarget = path.resolve(targetRoot);
    if (snapshotPath) {
        const resolved = path.isAbsolute(snapshotPath)
            ? snapshotPath
            : path.resolve(normalizedTarget, snapshotPath);
        return ensureWithinRoot(normalizedTarget, resolved, 'Rollback snapshot path');
    }

    const candidates = listRollbackSnapshotPaths(targetRoot);
    if (candidates.length === 0) {
        throw new Error(`Rollback snapshots were not found under '${getRollbackSnapshotsRoot(targetRoot)}'.`);
    }

    return candidates[0];
}

export function listBundleBackupPaths(targetRoot: string): string[] {
    const backupsRoot = getBundleBackupsRoot(targetRoot);
    if (!pathExists(backupsRoot)) {
        return [];
    }

    return fs.readdirSync(backupsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}(?:-\d{3})?$/i.test(entry.name))
        .map((entry) => path.join(backupsRoot, entry.name))
        .sort((left, right) => right.localeCompare(left));
}

function getRelativeRollbackPath(targetRoot: string, absolutePath: string): string {
    return path.relative(targetRoot, absolutePath).replace(/\\/g, '/');
}

/**
 * Scans existing rollback snapshots for one whose VERSION matches the
 * requested version.  Returns the absolute snapshot path or null.
 */
export function findSnapshotByVersion(targetRoot: string, targetVersion: string): string | null {
    const snapshots = listRollbackSnapshotPaths(targetRoot);
    for (const snapshotPath of snapshots) {
        assertNoLinkedPathComponents(targetRoot, snapshotPath);
        if (!pathExists(getRollbackRecordsPath(snapshotPath))) continue;
        readRollbackRecords(snapshotPath);
        const versionPath = path.join(snapshotPath, resolveBundleName(), 'VERSION');
        assertNoLinkedPathComponents(snapshotPath, versionPath);
        if (!pathExists(versionPath)) continue;
        const version = readTextFile(versionPath).trim();
        if (version && compareVersionStrings(version, targetVersion) === 0) {
            return snapshotPath;
        }
    }
    return null;
}

async function runRollbackToVersionUnjournaled(options: RunRollbackToVersionOptions) {
    const {
        targetRoot,
        bundleRoot,
        targetVersion,
        sourcePath = null,
        packageSpec = null,
        trustOverride = false,
        initAnswersPath = path.join(resolveBundleName(), 'runtime', 'init-answers.json'),
        dryRun = false,
        skipVerify = false,
        skipManifestValidation = false,
        installRunner = null,
        materializationRunner = null
    } = options;

    const normalizedTarget = validateTargetRoot(targetRoot, bundleRoot);
    const deployedBundleRoot = path.join(normalizedTarget, resolveBundleName());
    if (!pathExists(deployedBundleRoot)) {
        throw new Error(`Deployed bundle not found: ${deployedBundleRoot}`);
    }

    const currentVersion = readVersionOrFallback(path.join(deployedBundleRoot, 'VERSION'));

    const initAnswersResolvedPath = path.isAbsolute(initAnswersPath)
        ? initAnswersPath
        : path.resolve(normalizedTarget, initAnswersPath);
    ensureWithinRoot(normalizedTarget, initAnswersResolvedPath, 'Init answers path');
    if (!pathExists(initAnswersResolvedPath)) {
        throw new Error(
            `Init answers artifact not found: ${initAnswersResolvedPath}. ` +
            'Version-based rollback requires init answers for re-materialization.'
        );
    }

    let initAnswers;
    try {
        initAnswers = JSON.parse(readTextFile(initAnswersResolvedPath));
    } catch (_e) {
        throw new Error(`Init answers artifact is not valid JSON: ${initAnswersResolvedPath}`);
    }
    const validated = validateInitAnswers(initAnswers);

    const timestamp = getTimestamp();
    const rollbackReportRelativePath = `${resolveBundleName()}/runtime/update-reports/rollback-to-version-${timestamp}.md`;
    const rollbackReportPath = path.join(normalizedTarget, rollbackReportRelativePath);
    const safetySnapshotRelativePath = `${resolveBundleName()}/runtime/update-rollbacks/rollback-${timestamp}`;
    const safetySnapshotPath = path.join(normalizedTarget, safetySnapshotRelativePath);
    const safetySnapshotRecordsRelativePath = `${safetySnapshotRelativePath}/${path.basename(getRollbackRecordsPath(safetySnapshotPath))}`;
    const bundleSyncBackupRelativePath = `${resolveBundleName()}/runtime/bundle-backups/${timestamp}`;
    const bundleSyncBackupPath = path.join(normalizedTarget, bundleSyncBackupRelativePath);

    let safetySnapshotCreated = false;
    let safetySnapshotRecordCount = 0;
    let safetyRollbackStatus = 'NOT_NEEDED';
    let syncStatus = 'NOT_RUN';
    let installStatus = 'NOT_RUN';
    let materializationStatus = 'NOT_RUN';
    let restoreStatus = 'NOT_RUN';

    const matchingSnapshot = sourcePath ? null : findSnapshotByVersion(normalizedTarget, targetVersion);
    let resolvedSourceType = 'unknown';
    let resolvedSourceReference = '';
    let sourceRoot: string | null = null;
    let sourceCleanup: () => void = () => {};
    let sourceVersion = 'unknown';

    if (sourcePath) {
        const resolvedSourcePath = path.resolve(String(sourcePath).trim());
        validatePathSourceTrust(resolvedSourcePath, { trustOverride });
        if (!pathExists(resolvedSourcePath)) {
            throw new Error(`Rollback source path not found: ${resolvedSourcePath}`);
        }
        if (!fs.lstatSync(resolvedSourcePath).isDirectory()) {
            throw new Error(`Rollback source path is not a directory: ${resolvedSourcePath}`);
        }
        resolvedSourceType = 'path';
        resolvedSourceReference = resolvedSourcePath;
        sourceRoot = resolvedSourcePath;
        sourceVersion = readVersionOrFallback(path.join(sourceRoot, 'VERSION'));
    } else if (matchingSnapshot) {
        resolvedSourceType = 'snapshot';
        resolvedSourceReference = getRelativeRollbackPath(normalizedTarget, matchingSnapshot);
        sourceRoot = path.join(matchingSnapshot, resolveBundleName());
        sourceVersion = readVersionOrFallback(path.join(sourceRoot, 'VERSION'));
    } else {
        let effectivePackageSpec = packageSpec || null;
        if (!effectivePackageSpec) {
            const deployedPkgPath = path.join(deployedBundleRoot, 'package.json');
            let packageName = DEFAULT_PACKAGE_NAME;
            if (pathExists(deployedPkgPath)) {
                try {
                    const pkgJson = JSON.parse(readTextFile(deployedPkgPath));
                    if (pkgJson && typeof pkgJson === 'object' && !Array.isArray(pkgJson) && 'name' in pkgJson) {
                        packageName = String(pkgJson.name).trim() || DEFAULT_PACKAGE_NAME;
                    }
                } catch (_e) { /* use default */ }
            }
            effectivePackageSpec = `${packageName}@${targetVersion}`;
        }

        const source = await acquireUpdateSource({
            deployedBundleRoot,
            packageSpec: effectivePackageSpec,
            trustOverride
        });
        resolvedSourceType = source.sourceType;
        resolvedSourceReference = source.sourceReference;
        sourceRoot = source.sourceRoot;
        sourceCleanup = source.cleanup;
        sourceVersion = readVersionOrFallback(path.join(sourceRoot, 'VERSION'));
    }

    if (sourceVersion === 'unknown') {
        sourceCleanup();
        throw new Error(
            'Cannot determine version of the rollback source. VERSION file is missing or empty.'
        );
    }
    if (compareVersionStrings(sourceVersion, targetVersion) !== 0) {
        sourceCleanup();
        throw new Error(
            `Source version '${sourceVersion}' does not match requested target version '${targetVersion}'.`
        );
    }
    if (compareVersionStrings(currentVersion, targetVersion) === 0) {
        sourceCleanup();
        throw new Error(
            `Current version '${currentVersion}' is already at the requested target version '${targetVersion}'.`
        );
    }

    const DEFERRED_VERSION_ITEM = 'VERSION';
    const previewAffectedItems: string[] = [];

    try {
        if (!dryRun) {
            fs.mkdirSync(path.dirname(safetySnapshotPath), { recursive: true });
            const rollbackItems = getUpdateRollbackItems(normalizedTarget, initAnswersResolvedPath);
            const safetyRecords = createRollbackSnapshot(
                normalizedTarget, safetySnapshotPath, rollbackItems
            );
            writeRollbackRecords(safetySnapshotPath, safetyRecords);
            safetySnapshotCreated = true;
            safetySnapshotRecordCount = safetyRecords.length;
        } else {
            const rollbackItems = getUpdateRollbackItems(normalizedTarget, initAnswersResolvedPath);
            for (const item of rollbackItems) {
                previewAffectedItems.push(item);
            }
        }

        if (!dryRun) {
            const syncPreexistingMap: Record<string, boolean> = {};
            for (const item of BUNDLE_SYNC_ITEMS) {
                if (item === DEFERRED_VERSION_ITEM) continue;

                const sourceItemPath = path.join(sourceRoot, item);
                if (!fs.existsSync(sourceItemPath)) continue;

                const destinationPath = path.join(deployedBundleRoot, item);
                const destinationExists = fs.existsSync(destinationPath);

                if (!(item in syncPreexistingMap)) {
                    syncPreexistingMap[item] = destinationExists;
                }

                if (destinationExists) {
                    const backupPath = path.join(bundleSyncBackupPath, item);
                    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
                    copyPathRecursive(destinationPath, backupPath);
                }

                removePathRecursive(destinationPath);
                fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
                copyPathRecursive(sourceItemPath, destinationPath);
            }

            if (Object.keys(syncPreexistingMap).length > 0) {
                writeSyncBackupMetadata(bundleSyncBackupPath, {
                    createdAt: new Date().toISOString(),
                    sourceType: resolvedSourceType,
                    sourceReference: resolvedSourceReference,
                    rollbackToVersion: targetVersion,
                    preexistingMap: syncPreexistingMap
                });
            }
            syncStatus = 'SUCCESS';
        } else {
            for (const item of BUNDLE_SYNC_ITEMS) {
                if (item === DEFERRED_VERSION_ITEM) continue;
                const sourceItemPath = path.join(sourceRoot, item);
                if (fs.existsSync(sourceItemPath)) {
                    previewAffectedItems.push(`${resolveBundleName()}/${item}`);
                }
            }
            previewAffectedItems.push(`${resolveBundleName()}/${DEFERRED_VERSION_ITEM}`);
            syncStatus = 'SKIPPED_DRY_RUN';
        }

        if (!dryRun) {
            writeUpdateSentinel(deployedBundleRoot, {
                startedAt: new Date().toISOString(),
                operation: 'rollback-to-version',
                fromVersion: currentVersion,
                toVersion: targetVersion
            });

            if (installRunner) {
                installRunner({
                    targetRoot: normalizedTarget,
                    bundleRoot: deployedBundleRoot,
                    dryRun: false,
                    assistantLanguage: validated.AssistantLanguage,
                    assistantBrevity: validated.AssistantBrevity,
                    sourceOfTruth: validated.SourceOfTruth,
                    initAnswersPath: initAnswersResolvedPath
                });
            } else {
                runInstall({
                    targetRoot: normalizedTarget,
                    bundleRoot: deployedBundleRoot,
                    runInit: false,
                    dryRun: false,
                    assistantLanguage: validated.AssistantLanguage,
                    assistantBrevity: validated.AssistantBrevity,
                    sourceOfTruth: validated.SourceOfTruth,
                    initAnswersPath: initAnswersResolvedPath
                });
            }
            installStatus = 'PASS';

            if (materializationRunner) {
                materializationRunner({
                    targetRoot: normalizedTarget,
                    bundleRoot: deployedBundleRoot,
                    assistantLanguage: validated.AssistantLanguage,
                    assistantBrevity: validated.AssistantBrevity,
                    sourceOfTruth: validated.SourceOfTruth,
                    enforceNoAutoCommit: validated.EnforceNoAutoCommit,
                    claudeOrchestratorFullAccess: validated.ClaudeOrchestratorFullAccess,
                    tokenEconomyEnabled: validated.TokenEconomyEnabled,
                    providerMinimalism: validated.ProviderMinimalism,
                    activeAgentFilesSeed: validated.ActiveAgentFiles ? validated.ActiveAgentFiles.join(', ') : null,
                    preserveLegacyReviewExecutionPolicyOmission: true
                });
            } else {
                runInit({
                    targetRoot: normalizedTarget,
                    bundleRoot: deployedBundleRoot,
                    dryRun: false,
                    assistantLanguage: validated.AssistantLanguage,
                    assistantBrevity: validated.AssistantBrevity,
                    sourceOfTruth: validated.SourceOfTruth,
                    enforceNoAutoCommit: validated.EnforceNoAutoCommit,
                    claudeOrchestratorFullAccess: validated.ClaudeOrchestratorFullAccess,
                    tokenEconomyEnabled: validated.TokenEconomyEnabled,
                    providerMinimalism: validated.ProviderMinimalism,
                    activeAgentFilesSeed: validated.ActiveAgentFiles ? validated.ActiveAgentFiles.join(', ') : null,
                    preserveLegacyReviewExecutionPolicyOmission: true
                });
            }
            materializationStatus = 'PASS';

            // Deferred VERSION sync — only after lifecycle completes
            const versionSourcePath = path.join(sourceRoot, DEFERRED_VERSION_ITEM);
            if (fs.existsSync(versionSourcePath)) {
                const versionDestPath = path.join(deployedBundleRoot, DEFERRED_VERSION_ITEM);
                removePathRecursive(versionDestPath);
                fs.mkdirSync(path.dirname(versionDestPath), { recursive: true });
                fs.copyFileSync(versionSourcePath, versionDestPath);
            }
            syncRestoredLiveVersion(deployedBundleRoot, sourceVersion);

            if (matchingSnapshot) {
                readRollbackRecords(matchingSnapshot);
            }
            const updatedVersion = readVersionOrFallback(path.join(deployedBundleRoot, 'VERSION'));
            if (updatedVersion !== sourceVersion) {
                throw new Error(`Rollback post-restore VERSION '${updatedVersion}' differs from source '${sourceVersion}'.`);
            }
            if (!skipVerify) {
                const verifyResult = runVerify({
                    targetRoot: normalizedTarget,
                    initAnswersPath: initAnswersResolvedPath,
                    sourceOfTruth: validated.SourceOfTruth
                });
                if (!verifyResult.passed) throw new Error(formatVerifyResult(verifyResult));
            }
            if (!skipManifestValidation) {
                const manifestResult = validateManifest(path.join(deployedBundleRoot, 'MANIFEST.md'), normalizedTarget);
                if (!manifestResult.passed) throw new Error(formatManifestResult(manifestResult));
            }

            removeUpdateSentinel(deployedBundleRoot);
            restoreStatus = 'SUCCESS';
            safetyRollbackStatus = 'NOT_TRIGGERED';
        } else {
            installStatus = 'SKIPPED_DRY_RUN';
            materializationStatus = 'SKIPPED_DRY_RUN';
            restoreStatus = 'SKIPPED_DRY_RUN';
            safetyRollbackStatus = 'SKIPPED_DRY_RUN';
        }
    } catch (error: unknown) {
        const errorMessage = getErrorMessage(error);
        removeUpdateSentinel(deployedBundleRoot);

        if (syncStatus !== 'SUCCESS') syncStatus = `FAILED: ${errorMessage}`;
        if (installStatus === 'NOT_RUN') installStatus = 'FAILED';
        if (materializationStatus === 'NOT_RUN') materializationStatus = 'FAILED';
        restoreStatus = `FAILED: ${errorMessage}`;

        if (dryRun || !safetySnapshotCreated) {
            sourceCleanup();
            throw new Error(`Rollback to version '${targetVersion}' failed. Error: ${errorMessage}`);
        }

        try {
            const safetyRecords = readRollbackRecords(safetySnapshotPath);
            restoreRollbackSnapshot(normalizedTarget, safetySnapshotPath, safetyRecords);
            verifyRestoredRollbackSnapshot(normalizedTarget, safetySnapshotPath, safetyRecords);
            safetyRollbackStatus = 'SUCCESS';
        } catch (safetyRollbackError: unknown) {
            const safetyRollbackMessage = getErrorMessage(safetyRollbackError);
            safetyRollbackStatus = `FAILED: ${safetyRollbackMessage}`;
            sourceCleanup();
            throw new Error(
                `Rollback to version '${targetVersion}' failed. Original error: ${errorMessage}. ` +
                `Safety rollback failed: ${safetyRollbackMessage}`
            );
        }

        sourceCleanup();
        throw new Error(
            `Rollback to version '${targetVersion}' failed and safety rollback completed successfully. ` +
            `Original error: ${errorMessage}`
        );
    }

    sourceCleanup();
    const updatedVersion = readVersionOrFallback(path.join(deployedBundleRoot, 'VERSION'));

    if (!dryRun) {
        fs.mkdirSync(path.dirname(rollbackReportPath), { recursive: true });
        const reportLines = [
            '# Rollback-to-Version Report',
            '',
            `GeneratedAt: ${new Date().toISOString()}`,
            `TargetRoot: ${normalizedTarget}`,
            `RollbackMode: version`,
            `RequestedVersion: ${targetVersion}`,
            `SourceType: ${resolvedSourceType}`,
            `SourceReference: ${resolvedSourceReference}`,
            `SourceVersion: ${sourceVersion}`,
            `SafetySnapshotPath: ${safetySnapshotRelativePath}`,
            `SafetySnapshotRecordsPath: ${safetySnapshotRecordsRelativePath}`,
            `SafetySnapshotRecordCount: ${safetySnapshotRecordCount}`,
            `BundleSyncBackupPath: ${bundleSyncBackupRelativePath}`,
            `RestoreStatus: ${restoreStatus}`,
            `SyncStatus: ${syncStatus}`,
            `InstallStatus: ${installStatus}`,
            `MaterializationStatus: ${materializationStatus}`,
            `SafetyRollbackStatus: ${safetyRollbackStatus}`,
            '',
            '## Version',
            `CurrentVersionBeforeRollback: ${currentVersion}`,
            `RollbackVersion: ${sourceVersion}`,
            `UpdatedVersion: ${updatedVersion}`
        ];
        fs.writeFileSync(rollbackReportPath, reportLines.join('\r\n'), 'utf8');
    }

    return {
        targetRoot: normalizedTarget,
        rollbackMode: 'version',
        targetVersion,
        sourceType: resolvedSourceType,
        sourceReference: resolvedSourceReference,
        sourceVersion,
        currentVersion,
        snapshotVersion: sourceVersion,
        rollbackVersion: sourceVersion,
        updatedVersion,
        dryRun,
        restoreStatus,
        syncStatus,
        installStatus,
        materializationStatus,
        safetySnapshotPath: dryRun ? 'not-created-in-dry-run' : safetySnapshotRelativePath,
        safetySnapshotRecordsPath: dryRun ? 'not-created-in-dry-run' : safetySnapshotRecordsRelativePath,
        safetySnapshotCreated,
        safetySnapshotRecordCount,
        safetyRollbackStatus,
        bundleSyncBackupPath: dryRun ? 'not-created-in-dry-run' : bundleSyncBackupRelativePath,
        rollbackReportPath: dryRun ? 'not-generated-in-dry-run' : rollbackReportRelativePath,
        previewAffectedItems: dryRun ? previewAffectedItems : []
    };
}

function runSnapshotRollbackUnjournaled(options: RunSnapshotRollbackOptions) {
    const {
        targetRoot,
        bundleRoot,
        snapshotPath = null,
        dryRun = false
    } = options;

    const normalizedTarget = validateTargetRoot(targetRoot, bundleRoot);
    const deployedBundleRoot = path.join(normalizedTarget, resolveBundleName());
    const normalizedSnapshotPath = resolveRollbackSnapshotPath(normalizedTarget, snapshotPath);
    assertNoLinkedPathComponents(normalizedTarget, normalizedSnapshotPath);

    if (!pathExists(normalizedSnapshotPath)) {
        throw new Error(`Rollback snapshot not found: ${normalizedSnapshotPath}`);
    }

    const snapshotRecordsPath = getRollbackRecordsPath(normalizedSnapshotPath);
    if (!pathExists(snapshotRecordsPath)) {
        throw new Error(
            `Rollback snapshot metadata is missing: ${snapshotRecordsPath}. ` +
            'This snapshot was likely created before rollback records were persisted.'
        );
    }

    const rollbackRecords = readRollbackRecords(normalizedSnapshotPath);
    const versionRelativePath = `${resolveBundleName()}/VERSION`;
    if (!rollbackRecords.some((record) => record.relativePath.replace(/\\/g, '/') === versionRelativePath
        && record.existed && record.pathType === 'file')) {
        throw new Error(`Rollback snapshot does not contain an authenticated ${versionRelativePath}.`);
    }
    const currentVersion = readVersionOrFallback(path.join(deployedBundleRoot, 'VERSION'));
    const snapshotVersion = readVersionOrFallback(path.join(normalizedSnapshotPath, resolveBundleName(), 'VERSION'));
    const timestamp = getTimestamp();
    const rollbackReportRelativePath = `${resolveBundleName()}/runtime/update-reports/rollback-${timestamp}.md`;
    const rollbackReportPath = path.join(normalizedTarget, rollbackReportRelativePath);
    const safetySnapshotRelativePath = `${resolveBundleName()}/runtime/update-rollbacks/rollback-${timestamp}`;
    const safetySnapshotPath = path.join(normalizedTarget, safetySnapshotRelativePath);
    const safetySnapshotRecordsRelativePath = `${safetySnapshotRelativePath}/${path.basename(getRollbackRecordsPath(safetySnapshotPath))}`;

    let safetySnapshotCreated = false;
    let safetySnapshotRecordCount = 0;
    let restoreStatus = 'NOT_RUN';
    let bundleRestoreStatus = 'FROM_SELECTED_SNAPSHOT';
    let safetyRollbackStatus = 'NOT_NEEDED';

    if (!dryRun) {
        fs.mkdirSync(path.dirname(safetySnapshotPath), { recursive: true });
        const safetyRecords = createRollbackSnapshot(
            normalizedTarget,
            safetySnapshotPath,
            rollbackRecords.map((record) => record.relativePath)
        );
        writeRollbackRecords(safetySnapshotPath, safetyRecords);
        safetySnapshotCreated = true;
        safetySnapshotRecordCount = safetyRecords.length;
    }

    try {
        if (!dryRun) {
            readRollbackRecords(normalizedSnapshotPath);
            restoreRollbackSnapshot(normalizedTarget, normalizedSnapshotPath, rollbackRecords);
            verifyRestoredRollbackSnapshot(normalizedTarget, normalizedSnapshotPath, rollbackRecords);
            restoreStatus = 'SUCCESS';
            safetyRollbackStatus = 'NOT_TRIGGERED';
        } else {
            restoreStatus = 'SKIPPED_DRY_RUN';
            bundleRestoreStatus = 'SKIPPED_DRY_RUN';
            safetyRollbackStatus = 'SKIPPED_DRY_RUN';
        }
    } catch (error: unknown) {
        const errorMessage = getErrorMessage(error);
        restoreStatus = `FAILED: ${errorMessage}`;
        if (!String(bundleRestoreStatus).startsWith('FAILED')) {
            bundleRestoreStatus = `FAILED: ${errorMessage}`;
        }

        if (dryRun || !safetySnapshotCreated) {
            throw new Error(`Rollback failed. Error: ${errorMessage}`);
        }

        try {
            const safetyRecords = readRollbackRecords(safetySnapshotPath);
            restoreRollbackSnapshot(normalizedTarget, safetySnapshotPath, safetyRecords);
            verifyRestoredRollbackSnapshot(normalizedTarget, safetySnapshotPath, safetyRecords);
            safetyRollbackStatus = 'SUCCESS';
        } catch (safetyRollbackError: unknown) {
            const safetyRollbackMessage = getErrorMessage(safetyRollbackError);
            safetyRollbackStatus = `FAILED: ${safetyRollbackMessage}`;
            throw new Error(
                `Rollback failed. Original error: ${errorMessage}. ` +
                `Safety rollback failed: ${safetyRollbackMessage}`
            );
        }

        throw new Error(`Rollback failed and safety rollback completed successfully. Original error: ${errorMessage}`);
    }

    const updatedVersion = readVersionOrFallback(path.join(deployedBundleRoot, 'VERSION'));

    if (!dryRun) {
        fs.mkdirSync(path.dirname(rollbackReportPath), { recursive: true });
        const reportLines = [
            '# Rollback Report',
            '',
            `GeneratedAt: ${new Date().toISOString()}`,
            `TargetRoot: ${normalizedTarget}`,
            `RollbackMode: snapshot`,
            `RollbackSnapshotPath: ${getRelativeRollbackPath(normalizedTarget, normalizedSnapshotPath)}`,
            `RollbackSnapshotRecordCount: ${rollbackRecords.length}`,
            'BundleBackupPath: not-used',
            'BundleBackupMetadataPath: not-used',
            `SafetySnapshotPath: ${safetySnapshotRelativePath}`,
            `SafetySnapshotRecordsPath: ${safetySnapshotRecordsRelativePath}`,
            `SafetySnapshotRecordCount: ${safetySnapshotRecordCount}`,
            `RestoreStatus: ${restoreStatus}`,
            `BundleRestoreStatus: ${bundleRestoreStatus}`,
            `SafetyRollbackStatus: ${safetyRollbackStatus}`,
            '',
            '## Version',
            `CurrentVersionBeforeRollback: ${currentVersion}`,
            `SnapshotVersion: ${snapshotVersion}`,
            `RollbackVersion: ${snapshotVersion}`,
            `UpdatedVersion: ${updatedVersion}`
        ];
        fs.writeFileSync(rollbackReportPath, reportLines.join('\r\n'), 'utf8');
    }

    return {
        targetRoot: normalizedTarget,
        rollbackMode: 'snapshot',
        snapshotPath: getRelativeRollbackPath(normalizedTarget, normalizedSnapshotPath),
        rollbackRecordsPath: getRelativeRollbackPath(normalizedTarget, snapshotRecordsPath),
        rollbackRecordCount: rollbackRecords.length,
        currentVersion,
        snapshotVersion,
        rollbackVersion: snapshotVersion,
        bundleBackupVersion: 'not-used',
        updatedVersion,
        dryRun,
        restoreStatus,
        bundleBackupPath: 'not-used',
        bundleBackupMetadataPath: 'not-used',
        bundleRestoreStatus,
        safetySnapshotPath: dryRun ? 'not-created-in-dry-run' : safetySnapshotRelativePath,
        safetySnapshotRecordsPath: dryRun ? 'not-created-in-dry-run' : safetySnapshotRecordsRelativePath,
        safetySnapshotCreated,
        safetySnapshotRecordCount,
        safetyRollbackStatus,
        rollbackReportPath: dryRun ? 'not-generated-in-dry-run' : rollbackReportRelativePath,
        previewAffectedItems: dryRun
            ? rollbackRecords.map((record) => record.relativePath)
            : []
    };
}

export async function runRollbackToVersion(options: RunRollbackToVersionOptions) {
    validateTargetRoot(options.targetRoot, options.bundleRoot);
    if (options.dryRun) {
        return runRollbackToVersionUnjournaled(options);
    }
    return withLifecycleRuntimeMutationGenerationAsync(
        options.bundleRoot,
        'lifecycle-rollback-to-version',
        () => runRollbackToVersionUnjournaled(options)
    );
}

export function runSnapshotRollback(options: RunSnapshotRollbackOptions) {
    validateTargetRoot(options.targetRoot, options.bundleRoot);
    if (options.dryRun) {
        return runSnapshotRollbackUnjournaled(options);
    }
    return withLifecycleRuntimeMutationGeneration(
        options.bundleRoot,
        'lifecycle-snapshot-rollback',
        () => runSnapshotRollbackUnjournaled(options)
    );
}

export async function runRollback(options: RunRollbackOptions) {
    const normalizedTarget = validateTargetRoot(options.targetRoot, options.bundleRoot);
    return await withLifecycleOperationLockAsync(normalizedTarget, 'rollback', async () => {
        const { targetVersion = null } = options;
        if (targetVersion) {
            return await runRollbackToVersion({
                ...options,
                targetVersion
            });
        }
        return runSnapshotRollback(options);
    });
}
