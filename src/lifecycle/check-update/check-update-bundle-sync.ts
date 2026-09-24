import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    bindContainedDestination,
    copyContainedFile,
    ensureContainedDirectory,
    removeContainedPath,
    writeContainedFile
} from '../../core/contained-filesystem';
import { pathExists, readTextFile } from '../../core/filesystem';
import {
    BUNDLE_SYNC_ITEMS,
    assertCopySourceTree,
    compareVersionStrings,
    copyDirectoryContentMerge,
    copyPathRecursive,
    getUpdateSentinelPath,
    getSyncBackupMetadataPath,
    removeUpdateSentinel,
    readdirRecursiveFiles,
    restoreSyncedItemsFromBackup,
    type UpdateSentinelMetadata,
    writeSyncBackupMetadata,
    writeUpdateSentinel,
    withLifecycleOperationLockAsync
} from '../common';
import { assertNoRuntimeLocksBeforeUpdateApply } from '../lock/runtime-lock-preflight';
import { withLifecycleRuntimeMutationGenerationAsync } from '../runtime-mutation-generation';
import { createLifecycleDiagnosticError } from '../update/update-diagnostics';
import { getAgentInitializationReadinessSnapshot } from '../../validators/status';
import { buildAgentInitializationRecoveryGuidance } from '../../validators/status/status-recommendations';
import {
    type AcquiredUpdateSource,
    type CheckUpdateResult,
    type CheckUpdateRunnerOptions,
    type CheckUpdateTestHooks,
    type UpdateAvailabilitySnapshot
} from './check-update-types';
import { getErrorMessage, toObjectRecord } from './check-update-utils';

const DEFERRED_VERSION_ITEM = 'VERSION';
const DEFERRED_LIVE_VERSION_PAYLOAD_ITEM = 'live/version.json';
const SYNC_ROLLBACK_EVIDENCE_FILE_NAME = 'sync-rollback-result.json';

type UpdateSentinelPhase = 'syncing' | 'lifecycle' | 'version_deferred' | 'complete';

interface PlannedBundleSyncItem {
    item: string;
    sourcePath: string;
    destinationPath: string;
    sourceIsDirectory: boolean;
    isNodeRuntimeDir: boolean;
}

interface ApplyAvailableUpdateOptions {
    normalizedTarget: string;
    deployedBundleRoot: string;
    source: AcquiredUpdateSource;
    result: CheckUpdateResult;
    initAnswersPath: string;
    noPrompt: boolean;
    dryRun: boolean;
    skipVerify: boolean;
    skipManifestValidation: boolean;
    runningScriptPath: string | null;
    updateRunner: ((options: CheckUpdateRunnerOptions) => void) | null;
    testHooks: CheckUpdateTestHooks | null;
    effectiveDiagnosticSource: string;
    effectiveDiagnosticTool: string;
    syncBackupRoot: string;
}

function syncDeferredLiveVersionPayload(bundleRoot: string, version: string): void {
    const liveVersionPath = path.join(bundleRoot, 'live', 'version.json');
    if (bindContainedDestination(bundleRoot, liveVersionPath).missingAt) {
        return;
    }

    let parsed: Record<string, unknown>;
    try {
        parsed = toObjectRecord(JSON.parse(readTextFile(liveVersionPath))) || {};
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Keep update success path stable when historical live/version.json is malformed.
        // Verification will still surface the malformed payload if it remains unreadable.
        return;
    }
    parsed.Version = version;
    parsed.UpdatedAt = new Date().toISOString();
    writeContainedFile(bundleRoot, liveVersionPath, JSON.stringify(parsed, null, 2) + '\n');
}

function listRelativeFiles(directoryPath: string): string[] {
    return readdirRecursiveFiles(directoryPath)
        .map((filePath) => path.relative(directoryPath, filePath).replace(/\\/g, '/'))
        .sort();
}

function areFilesEquivalent(leftPath: string, rightPath: string): boolean {
    const leftStats = fs.lstatSync(leftPath);
    const rightStats = fs.lstatSync(rightPath);

    if (leftStats.isSymbolicLink() || rightStats.isSymbolicLink()) {
        return leftStats.isSymbolicLink()
            && rightStats.isSymbolicLink()
            && fs.readlinkSync(leftPath) === fs.readlinkSync(rightPath);
    }

    if (!leftStats.isFile() || !rightStats.isFile()) {
        return false;
    }

    if (leftStats.size !== rightStats.size) {
        return false;
    }

    return fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath));
}

function areDirectoriesEquivalent(
    sourceDirectory: string,
    destinationDirectory: string,
    options: { allowExtraDestinationFiles: boolean }
): boolean {
    if (!fs.existsSync(destinationDirectory) || !fs.lstatSync(destinationDirectory).isDirectory()) {
        return false;
    }

    const sourceFiles = listRelativeFiles(sourceDirectory);
    const destinationFiles = listRelativeFiles(destinationDirectory);
    const destinationFileSet = new Set(destinationFiles);

    for (const relativeFile of sourceFiles) {
        if (!destinationFileSet.has(relativeFile)) {
            return false;
        }

        if (!areFilesEquivalent(
            path.join(sourceDirectory, relativeFile),
            path.join(destinationDirectory, relativeFile)
        )) {
            return false;
        }
    }

    return options.allowExtraDestinationFiles || sourceFiles.length === destinationFiles.length;
}

function isDirectoryEquivalentAllowingOnlyExtraFiles(
    sourceDirectory: string,
    destinationDirectory: string,
    allowedExtraDestinationFiles: readonly string[]
): boolean {
    if (!fs.existsSync(destinationDirectory) || !fs.lstatSync(destinationDirectory).isDirectory()) {
        return false;
    }

    const sourceFiles = listRelativeFiles(sourceDirectory);
    const destinationFiles = listRelativeFiles(destinationDirectory);
    const sourceFileSet = new Set(sourceFiles);
    const allowedExtraSet = new Set(allowedExtraDestinationFiles.map((filePath) => filePath.replace(/\\/g, '/')));

    for (const relativeFile of sourceFiles) {
        if (!destinationFiles.includes(relativeFile)) {
            return false;
        }

        if (!areFilesEquivalent(
            path.join(sourceDirectory, relativeFile),
            path.join(destinationDirectory, relativeFile)
        )) {
            return false;
        }
    }

    for (const relativeFile of destinationFiles) {
        if (!sourceFileSet.has(relativeFile) && !allowedExtraSet.has(relativeFile)) {
            return false;
        }
    }

    return true;
}

function doesSyncItemMatchSource(sourceRoot: string, deployedBundleRoot: string, item: string): boolean {
    const sourceItemPath = path.join(sourceRoot, item);
    if (!fs.existsSync(sourceItemPath)) {
        return true;
    }

    const deployedItemPath = path.join(deployedBundleRoot, item);
    if (!fs.existsSync(deployedItemPath)) {
        return false;
    }

    const sourceStats = fs.lstatSync(sourceItemPath);
    const deployedStats = fs.lstatSync(deployedItemPath);
    if (sourceStats.isDirectory() !== deployedStats.isDirectory()) {
        return false;
    }

    if (sourceStats.isDirectory()) {
        return areDirectoriesEquivalent(sourceItemPath, deployedItemPath, {
            allowExtraDestinationFiles: item.toLowerCase() === 'src'
        });
    }

    return areFilesEquivalent(sourceItemPath, deployedItemPath);
}

function isPathInsideDirectory(directoryPath: string, candidatePath: string): boolean {
    const relative = path.relative(path.resolve(directoryPath), path.resolve(candidatePath));
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function verifySyncedItemsRestoredFromBackup(
    deployedBundleRoot: string,
    syncBackupRoot: string,
    preexistingMap: Record<string, boolean>,
    runningScriptPath: string | null
): void {
    for (const item of Object.keys(preexistingMap)) {
        const destinationPath = path.join(deployedBundleRoot, item);
        const existedBeforeSync = Boolean(preexistingMap[item]);

        if (!existedBeforeSync) {
            if (fs.existsSync(destinationPath)) {
                throw new Error(`Synced item '${item}' still exists after rollback`);
            }
            continue;
        }

        const backupPath = path.join(syncBackupRoot, item);
        if (!fs.existsSync(backupPath)) {
            throw new Error(`Missing backup entry for '${item}': ${backupPath}`);
        }
        if (!fs.existsSync(destinationPath)) {
            throw new Error(`Synced item '${item}' was not restored`);
        }

        const backupStats = fs.lstatSync(backupPath);
        const destinationStats = fs.lstatSync(destinationPath);
        if (backupStats.isDirectory() !== destinationStats.isDirectory()) {
            throw new Error(`Synced item '${item}' restored with mismatched path type`);
        }

        if (backupStats.isDirectory()) {
            const allowedExtraDestinationFiles = item.toLowerCase() === 'src'
                && runningScriptPath !== null
                && isPathInsideDirectory(destinationPath, runningScriptPath)
                ? [path.relative(destinationPath, runningScriptPath).replace(/\\/g, '/')]
                : [];
            if (!isDirectoryEquivalentAllowingOnlyExtraFiles(
                backupPath,
                destinationPath,
                allowedExtraDestinationFiles
            )) {
                throw new Error(`Synced item '${item}' differs from rollback backup after restore`);
            }
            continue;
        }

        if (!areFilesEquivalent(backupPath, destinationPath)) {
            throw new Error(`Synced item '${item}' differs from rollback backup after restore`);
        }
    }
}

function writeSyncRollbackEvidence(
    syncBackupRoot: string,
    evidence: Record<string, unknown>
): void {
    try {
        writeContainedFile(
            path.parse(path.resolve(syncBackupRoot)).root,
            path.join(syncBackupRoot, SYNC_ROLLBACK_EVIDENCE_FILE_NAME),
            JSON.stringify({
                writtenAt: new Date().toISOString(),
                ...evidence
            }, null, 2) + '\n'
        );
    } catch (_error) {
        // The sync backup metadata is the primary recovery evidence.
    }
}

function removeUpdateSentinelAfterVerifiedRollback(deployedBundleRoot: string): void {
    removeUpdateSentinel(deployedBundleRoot);
    const sentinelPath = getUpdateSentinelPath(deployedBundleRoot);
    if (fs.existsSync(sentinelPath)) {
        throw new Error(`Update sentinel was not removed after verified rollback: ${sentinelPath}`);
    }
}

function syncDeferredVersionFile(
    versionSourcePath: string, versionDestPath: string, targetRoot: string
): void {
    bindContainedDestination(targetRoot, versionDestPath);
    const previousVersionContent = fs.existsSync(versionDestPath)
        ? fs.readFileSync(versionDestPath)
        : null;
    try {
        copyContainedFile(targetRoot, versionSourcePath, versionDestPath);
    } catch (versionSyncError) {
        if (previousVersionContent !== null) {
            try {
                writeContainedFile(targetRoot, versionDestPath, previousVersionContent);
            } catch (_restoreErr) {
                // Best-effort restore; the outer apply catch handles rollback.
            }
        }
        throw versionSyncError;
    }
}

function collectExistingSourceSyncItems(sourceRoot: string): string[] {
    return BUNDLE_SYNC_ITEMS.filter((item) => {
        try {
            fs.lstatSync(path.join(sourceRoot, item));
            return true;
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
        }
    });
}

function preflightBundleSyncPlan(
    targetRoot: string, deployedBundleRoot: string, sourceRoot: string,
    syncBackupRoot: string, plannedSyncItems: PlannedBundleSyncItem[], rollbackSyncItems: string[]
): void {
    bindContainedDestination(targetRoot, syncBackupRoot);
    bindContainedDestination(targetRoot, getSyncBackupMetadataPath(syncBackupRoot));
    bindContainedDestination(deployedBundleRoot, getUpdateSentinelPath(deployedBundleRoot));
    bindContainedDestination(deployedBundleRoot, path.join(deployedBundleRoot, 'live', 'version.json'));
    const versionSourcePath = path.join(sourceRoot, DEFERRED_VERSION_ITEM);
    bindContainedDestination(sourceRoot, versionSourcePath);
    if (fs.existsSync(versionSourcePath)) assertCopySourceTree(versionSourcePath);

    for (const plan of plannedSyncItems) {
        assertCopySourceTree(plan.sourcePath);
        bindContainedDestination(targetRoot, plan.destinationPath);
        if (fs.existsSync(plan.destinationPath)) assertCopySourceTree(plan.destinationPath);
    }
    for (const item of rollbackSyncItems) {
        const destinationPath = path.join(deployedBundleRoot, item);
        const backupPath = path.join(syncBackupRoot, item);
        bindContainedDestination(targetRoot, destinationPath);
        bindContainedDestination(targetRoot, backupPath);
        if (fs.existsSync(destinationPath)) assertCopySourceTree(destinationPath);
        if (fs.existsSync(backupPath)) assertCopySourceTree(backupPath);
    }
}

function collectRollbackSyncItems(sourceSyncItems: string[], deployedBundleRoot: string): string[] {
    const rollbackItems = [...sourceSyncItems];
    if (fs.existsSync(path.join(deployedBundleRoot, DEFERRED_LIVE_VERSION_PAYLOAD_ITEM)) &&
        !rollbackItems.includes(DEFERRED_LIVE_VERSION_PAYLOAD_ITEM)) {
        rollbackItems.push(DEFERRED_LIVE_VERSION_PAYLOAD_ITEM);
    }
    return rollbackItems;
}

function assertAgentInitReadyBeforeDestructiveApply(normalizedTarget: string, initAnswersPath: string): void {
    const readiness = getAgentInitializationReadinessSnapshot(normalizedTarget, initAnswersPath);
    if (!readiness.primaryInitializationComplete || readiness.agentInitializationPendingReason === null) {
        return;
    }

    const recoveryGuidance = buildAgentInitializationRecoveryGuidance({
        bundlePath: readiness.bundlePath,
        resolvedTargetRoot: normalizedTarget,
        agentInitializationPendingReason: readiness.agentInitializationPendingReason
    });
    const lines = [
        'GARDA_UPDATE_AGENT_INIT_REQUIRED: update apply cannot apply before agent initialization is complete.',
        `TargetRoot: ${normalizedTarget}`,
        `PendingReason: ${readiness.agentInitializationPendingReason}`,
        `Next: ${recoveryGuidance.primary}, then rerun update.`,
        'Safety: update apply stopped before bundle sync; no rollback was needed.'
    ];
    if (readiness.missingProjectCommands.length > 0) {
        lines.splice(3, 0, `MissingProjectCommands: ${readiness.missingProjectCommands.join(', ')}`);
        for (const alternative of recoveryGuidance.alternatives) {
            lines.splice(5, 0, `Alternative: ${alternative}`);
        }
    }

    throw new Error(lines.join('\n'));
}

function planBundleSyncItems(
    sourceRoot: string,
    deployedBundleRoot: string,
    sourceSyncItems: string[]
): PlannedBundleSyncItem[] {
    return sourceSyncItems
        .filter((item) => item !== DEFERRED_VERSION_ITEM)
        .map((item) => {
            const sourcePath = path.join(sourceRoot, item);
            const destinationPath = path.join(deployedBundleRoot, item);
            const sourceIsDirectory = fs.lstatSync(sourcePath).isDirectory();

            return {
                item,
                sourcePath,
                destinationPath,
                sourceIsDirectory,
                isNodeRuntimeDir: item.toLowerCase() === 'src'
            };
        });
}

function buildUpdateSentinelMetadata(
    source: AcquiredUpdateSource,
    currentVersion: string,
    latestVersion: string,
    syncBackupRoot: string,
    syncBackupMetadataPath: string,
    plannedSyncItems: string[]
): UpdateSentinelMetadata {
    return {
        startedAt: new Date().toISOString(),
        fromVersion: currentVersion,
        toVersion: latestVersion,
        sourceType: source.sourceType,
        sourceReference: source.sourceReference,
        packageSpec: source.packageSpec,
        requestedPackageSpec: source.requestedPackageSpec,
        exactPackageSpec: source.exactPackageSpec,
        resolvedPackageVersion: source.resolvedPackageVersion,
        resolvedPackageIntegrity: source.resolvedPackageIntegrity,
        releaseProvenanceStatus: source.releaseProvenanceStatus,
        releaseProvenanceSummary: source.releaseProvenanceSummary,
        releaseProvenanceRecommendation: source.releaseProvenanceRecommendation,
        syncBackupRoot,
        syncBackupMetadataPath,
        plannedSyncItems
    };
}

function writeUpdateSentinelPhase(
    deployedBundleRoot: string,
    metadata: UpdateSentinelMetadata,
    phase: UpdateSentinelPhase
): void {
    writeUpdateSentinel(
        deployedBundleRoot,
        {
            ...metadata,
            phase
        }
    );
}

function syncPlannedBundleItem(
    plan: PlannedBundleSyncItem, runningScriptPath: string | null, targetRoot: string
): void {
    assertCopySourceTree(plan.sourcePath);
    if (plan.sourceIsDirectory) {
        if (plan.isNodeRuntimeDir) {
            if (!fs.existsSync(plan.destinationPath) || !fs.lstatSync(plan.destinationPath).isDirectory()) {
                removeContainedPath(targetRoot, plan.destinationPath, true);
                ensureContainedDirectory(targetRoot, plan.destinationPath);
            }
            const skipPaths = runningScriptPath ? [path.resolve(runningScriptPath)] : [];
            copyDirectoryContentMerge(plan.sourcePath, plan.destinationPath, skipPaths);
        } else {
            removeContainedPath(targetRoot, plan.destinationPath, true);
            copyPathRecursive(plan.sourcePath, plan.destinationPath, targetRoot);
        }
        return;
    }

    copyContainedFile(targetRoot, plan.sourcePath, plan.destinationPath);
}

function detectSyncSurfaceDrift(sourceRoot: string, deployedBundleRoot: string): string[] {
    const driftedItems: string[] = [];

    for (const item of BUNDLE_SYNC_ITEMS) {
        if (!doesSyncItemMatchSource(sourceRoot, deployedBundleRoot, item)) {
            driftedItems.push(item);
        }
    }

    return driftedItems;
}

export function readCurrentBundleVersionOrThrow(deployedBundleRoot: string): string {
    const currentVersionPath = path.join(deployedBundleRoot, 'VERSION');
    if (!pathExists(currentVersionPath)) {
        throw new Error(`Current VERSION file not found: ${currentVersionPath}`);
    }

    const currentVersion = readTextFile(currentVersionPath).trim();
    if (!currentVersion) {
        throw new Error(`Current VERSION file is empty: ${currentVersionPath}`);
    }

    return currentVersion;
}

export function readLatestSourceVersionOrThrow(
    sourceRoot: string,
    effectiveDiagnosticSource: string,
    effectiveDiagnosticTool: string
): string {
    const latestVersionPath = path.join(sourceRoot, 'VERSION');
    if (!pathExists(latestVersionPath)) {
        throw createLifecycleDiagnosticError({
            message: `Latest VERSION file not found in update source '${effectiveDiagnosticSource}'.`,
            tool: effectiveDiagnosticTool,
            code: 'UPDATE_SOURCE_VERSION_MISSING',
            sourceReference: effectiveDiagnosticSource,
            detailText: latestVersionPath
        });
    }

    const latestVersion = readTextFile(latestVersionPath).trim();
    if (!latestVersion) {
        throw createLifecycleDiagnosticError({
            message: `Latest VERSION file is empty in update source '${effectiveDiagnosticSource}'.`,
            tool: effectiveDiagnosticTool,
            code: 'UPDATE_SOURCE_VERSION_EMPTY',
            sourceReference: effectiveDiagnosticSource,
            detailText: latestVersionPath
        });
    }

    return latestVersion;
}

export function evaluateUpdateAvailability(
    currentVersion: string,
    latestVersion: string,
    sourceType: AcquiredUpdateSource['sourceType'],
    sourceRoot: string,
    deployedBundleRoot: string
): UpdateAvailabilitySnapshot {
    const comparison = compareVersionStrings(currentVersion, latestVersion);
    const versionDiffDetected = comparison < 0;
    const driftedSyncItems = comparison === 0 && sourceType === 'path'
        ? detectSyncSurfaceDrift(sourceRoot, deployedBundleRoot)
        : [];
    const contentDriftDetected = driftedSyncItems.length > 0;
    const updateAvailable = versionDiffDetected || contentDriftDetected;

    return {
        currentVersion,
        versionDiffDetected,
        contentDriftDetected,
        driftedSyncItems,
        updateAvailable,
        checkUpdateResult: updateAvailable ? 'UPDATE_AVAILABLE' : 'UP_TO_DATE'
    };
}

export function applyUpdateAvailabilitySnapshot(
    result: CheckUpdateResult,
    snapshot: UpdateAvailabilitySnapshot
): void {
    result.currentVersion = snapshot.currentVersion;
    result.versionDiffDetected = snapshot.versionDiffDetected;
    result.contentDriftDetected = snapshot.contentDriftDetected;
    result.driftedSyncItems = snapshot.driftedSyncItems;
    result.updateAvailable = snapshot.updateAvailable;
    result.checkUpdateResult = snapshot.checkUpdateResult;
}

async function applyAvailableUpdateUnjournaled(options: ApplyAvailableUpdateOptions): Promise<void> {
    const {
        normalizedTarget,
        deployedBundleRoot,
        source,
        result,
        initAnswersPath,
        noPrompt,
        dryRun,
        skipVerify,
        skipManifestValidation,
        runningScriptPath,
        updateRunner,
        testHooks,
        effectiveDiagnosticSource,
        effectiveDiagnosticTool,
        syncBackupRoot
    } = options;

    await withLifecycleOperationLockAsync(normalizedTarget, 'update', async () => {
        const currentVersion = readCurrentBundleVersionOrThrow(deployedBundleRoot);
        const latestVersion = readLatestSourceVersionOrThrow(source.sourceRoot, effectiveDiagnosticSource, effectiveDiagnosticTool);
        result.latestVersion = latestVersion;
        applyUpdateAvailabilitySnapshot(
            result,
            evaluateUpdateAvailability(currentVersion, latestVersion, source.sourceType, source.sourceRoot, deployedBundleRoot)
        );

        if (!result.updateAvailable) {
            return;
        }

        if (!dryRun) {
            assertNoRuntimeLocksBeforeUpdateApply(deployedBundleRoot);
            if (String(effectiveDiagnosticTool || '').toLowerCase() === 'git') {
                assertAgentInitReadyBeforeDestructiveApply(
                    normalizedTarget,
                    initAnswersPath
                );
            }
        }

        const sourceSyncItems = collectExistingSourceSyncItems(source.sourceRoot);
        const plannedSyncItems = planBundleSyncItems(source.sourceRoot, deployedBundleRoot, sourceSyncItems);
        const plannedSyncItemNames = plannedSyncItems.map((plan) => plan.item);
        const rollbackSyncItemNames = collectRollbackSyncItems(sourceSyncItems, deployedBundleRoot);
        const syncPreexistingMap = Object.fromEntries(
            rollbackSyncItemNames.map((item) => [item, fs.existsSync(path.join(deployedBundleRoot, item))])
        ) as Record<string, boolean>;
        if (!dryRun) {
            preflightBundleSyncPlan(normalizedTarget, deployedBundleRoot, source.sourceRoot,
                syncBackupRoot, plannedSyncItems, rollbackSyncItemNames);
        }
        let syncPreparationCompleted = false;
        let destructiveSyncStarted = false;

        try {
            result.syncItemsDetected += sourceSyncItems.length;

            if (dryRun) {
                result.syncedItems.push(...sourceSyncItems);
                result.checkUpdateResult = 'DRY_RUN_UPDATE_AVAILABLE';
            } else {
                for (const item of rollbackSyncItemNames) {
                    if (!syncPreexistingMap[item]) {
                        continue;
                    }
                    const destinationPath = path.join(deployedBundleRoot, item);
                    const backupPath = path.join(syncBackupRoot, item);
                    ensureContainedDirectory(normalizedTarget, path.dirname(backupPath));
                    copyPathRecursive(destinationPath, backupPath, normalizedTarget);
                    result.syncItemsBackedUp++;
                    result.syncBackupRoot = syncBackupRoot;
                }

                const syncMetadataPath = writeSyncBackupMetadata(syncBackupRoot, {
                    createdAt: new Date().toISOString(),
                    sourceType: source.sourceType,
                    sourceReference: source.sourceReference,
                    packageSpec: source.packageSpec,
                    requestedPackageSpec: source.requestedPackageSpec,
                    exactPackageSpec: source.exactPackageSpec,
                    resolvedPackageVersion: source.resolvedPackageVersion,
                    resolvedPackageIntegrity: source.resolvedPackageIntegrity,
                    releaseProvenanceStatus: source.releaseProvenanceStatus,
                    releaseProvenanceSummary: source.releaseProvenanceSummary,
                    releaseProvenanceRecommendation: source.releaseProvenanceRecommendation,
                    plannedSyncItems: plannedSyncItemNames,
                    preexistingMap: syncPreexistingMap
                });
                result.syncBackupRoot = syncBackupRoot;
                result.syncBackupMetadataPath = syncMetadataPath;
                const updateSentinelMetadata = buildUpdateSentinelMetadata(
                    source,
                    currentVersion,
                    latestVersion,
                    syncBackupRoot,
                    syncMetadataPath,
                    plannedSyncItemNames
                );

                writeUpdateSentinelPhase(
                    deployedBundleRoot,
                    updateSentinelMetadata,
                    'syncing'
                );

                syncPreparationCompleted = true;
                destructiveSyncStarted = plannedSyncItems.length > 0;
                for (let index = 0; index < plannedSyncItems.length; index++) {
                    const plan = plannedSyncItems[index];
                    testHooks?.beforeSyncItemFaultInjector?.(plan.item, index);
                    syncPlannedBundleItem(plan, runningScriptPath, normalizedTarget);
                    result.syncItemsUpdated++;
                    result.syncedItems.push(plan.item);
                    testHooks?.syncItemFaultInjector?.(plan.item, index);
                }

                writeUpdateSentinelPhase(
                    deployedBundleRoot,
                    updateSentinelMetadata,
                    'lifecycle'
                );

                if (updateRunner) {
                    updateRunner({
                        targetRoot: normalizedTarget,
                        initAnswersPath,
                        noPrompt,
                        skipVerify,
                        skipManifestValidation,
                        trustPolicy: result.trustPolicy,
                        trustOverrideUsed: result.trustOverrideUsed,
                        trustOverrideSource: result.trustOverrideSource,
                        sourceType: result.sourceType,
                        sourceReference: result.sourceReference,
                        requestedPackageSpec: result.requestedPackageSpec,
                        exactPackageSpec: result.exactPackageSpec,
                        resolvedPackageVersion: result.resolvedPackageVersion,
                        resolvedPackageIntegrity: result.resolvedPackageIntegrity,
                        releaseProvenanceStatus: result.releaseProvenanceStatus,
                        releaseProvenanceSummary: result.releaseProvenanceSummary,
                        releaseProvenanceRecommendation: result.releaseProvenanceRecommendation,
                        lifecycleLockAlreadyHeld: true
                    });
                }

                writeUpdateSentinelPhase(
                    deployedBundleRoot,
                    updateSentinelMetadata,
                    'version_deferred'
                );

                // Sync deferred VERSION only after lifecycle has completed successfully.
                // This ensures the workspace version does not advance until the full
                // lifecycle (materialization, verify, etc.) is finished.
                const versionSourcePath = path.join(source.sourceRoot, DEFERRED_VERSION_ITEM);
                if (fs.existsSync(versionSourcePath)) {
                    const versionDestPath = path.join(deployedBundleRoot, DEFERRED_VERSION_ITEM);
                    destructiveSyncStarted = true;
                    syncDeferredVersionFile(versionSourcePath, versionDestPath, normalizedTarget);
                    result.syncItemsUpdated++;
                    result.syncedItems.push(DEFERRED_VERSION_ITEM);
                    syncDeferredLiveVersionPayload(deployedBundleRoot, readTextFile(versionDestPath).trim());
                    testHooks?.afterDeferredVersionSync?.();
                }

                writeUpdateSentinelPhase(
                    deployedBundleRoot,
                    updateSentinelMetadata,
                    'complete'
                );
                removeUpdateSentinel(deployedBundleRoot);

                result.updateApplied = true;
                result.checkUpdateResult = 'UPDATED';
                if (Object.keys(syncPreexistingMap).length > 0 && result.syncRollbackStatus === 'NOT_NEEDED') {
                    result.syncRollbackStatus = 'NOT_TRIGGERED';
                }
            }
        } catch (applyError) {
            const originalError = getErrorMessage(applyError);
            if (!dryRun && syncPreparationCompleted && destructiveSyncStarted &&
                Object.keys(syncPreexistingMap).length > 0) {
                result.syncRollbackStatus = 'ATTEMPTED';
                try {
                    restoreSyncedItemsFromBackup(deployedBundleRoot, syncBackupRoot, syncPreexistingMap, runningScriptPath);
                    verifySyncedItemsRestoredFromBackup(
                        deployedBundleRoot,
                        syncBackupRoot,
                        syncPreexistingMap,
                        runningScriptPath
                    );
                    writeSyncRollbackEvidence(syncBackupRoot, {
                        status: 'SUCCESS',
                        originalError,
                        restoredItems: Object.keys(syncPreexistingMap),
                        syncBackupMetadataPath: result.syncBackupMetadataPath
                    });
                    removeUpdateSentinelAfterVerifiedRollback(deployedBundleRoot);
                    result.syncRollbackStatus = 'SUCCESS';
                } catch (rollbackError: unknown) {
                    const rollbackMsg = getErrorMessage(rollbackError);
                    result.syncRollbackStatus = `FAILED: ${rollbackMsg}`;
                    writeSyncRollbackEvidence(syncBackupRoot, {
                        status: 'FAILED',
                        originalError,
                        rollbackError: rollbackMsg,
                        restoredItems: Object.keys(syncPreexistingMap),
                        syncBackupMetadataPath: result.syncBackupMetadataPath
                    });
                    throw new Error(`Update apply failed. Original error: ${originalError}. Sync rollback failed: ${rollbackMsg}`);
                }
                throw new Error(`Update apply failed and sync rollback completed. Original error: ${originalError}`);
            }
            throw new Error(`Update apply failed. Error: ${originalError}`);
        }
    });
}

export async function applyAvailableUpdate(options: ApplyAvailableUpdateOptions): Promise<void> {
    if (options.dryRun) {
        return applyAvailableUpdateUnjournaled(options);
    }
    return withLifecycleRuntimeMutationGenerationAsync(
        options.deployedBundleRoot,
        'lifecycle-bundle-update-apply',
        () => applyAvailableUpdateUnjournaled(options)
    );
}
