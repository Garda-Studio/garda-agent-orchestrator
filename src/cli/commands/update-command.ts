import { assertExplicitCliTrustOverride } from '../../lifecycle/update-trust';
import { runCheckUpdate } from '../../lifecycle/check-update';
import { runUpdateFromGit } from '../../lifecycle/update-git';
import { runRollback } from '../../lifecycle/rollback';
import {
    bold,
    cyan,
    dim,
    green,
    ensureDirectoryExists,
    normalizePathValue,
    PackageJsonLike,
    parseOptions,
    printHelp,
    red,
    supportsColor,
    yellow
} from './cli-helpers';
import {
    buildUpdateLifecycleRunner,
    ensureBundleExists,
    finalizeAppliedUpdateOutput,
    formatKeyValueOutput,
    getDefaultInitAnswersPath,
    markRuntimeRestartRequired,
    mergeUpdateLifecycleOutput,
    printUpdateAnnouncementSections,
    ParsedOptionsRecord,
    toKeyValueRecord,
    UpdateLifecycleResult
} from './shared-command-utils';

type UpdateStatusTone = 'success' | 'attention' | 'failure';

async function runWithRestartOnFailure<T>(operation: () => Promise<T>, mutationPossible: boolean): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (mutationPossible) {
            markRuntimeRestartRequired();
        }
        throw error;
    }
}

function resolveUpdateStatusBanner(result: Record<string, unknown>): {
    title: string;
    detail: string;
    tone: UpdateStatusTone;
} | null {
    const rawResult = String(result.checkUpdateResult || '').trim().toUpperCase();

    if (rawResult === 'UPDATED' || result.updateApplied === true) {
        return {
            title: 'Updated successfully',
            detail: 'The available update was applied to this workspace.',
            tone: 'success'
        };
    }
    if (rawResult === 'UP_TO_DATE' || (result.updateAvailable === false && result.updateApplied !== true)) {
        return {
            title: 'Already up to date',
            detail: 'No update was needed for this workspace.',
            tone: 'success'
        };
    }
    if (rawResult === 'DRY_RUN_UPDATE_AVAILABLE') {
        return {
            title: 'Dry run: update available',
            detail: 'A newer version is available, but dry-run did not apply it.',
            tone: 'attention'
        };
    }
    if (rawResult === 'UPDATE_AVAILABLE' || result.updateAvailable === true) {
        return {
            title: 'Update available',
            detail: 'A newer version is available for this workspace.',
            tone: 'attention'
        };
    }
    return null;
}

function printUpdateStatusBanner(result: Record<string, unknown>): void {
    const banner = resolveUpdateStatusBanner(result);
    if (!banner) {
        return;
    }
    const statusColor = getToneColor(banner.tone);
    console.log(bold('UPDATE STATUS'));
    console.log(statusColor(banner.title));
    console.log(dim(banner.detail));
    console.log('');
}

function getToneColor(tone: UpdateStatusTone): (text: string) => string {
    if (tone === 'success') return green;
    if (tone === 'failure') return red;
    return yellow;
}

function getUpdateVersionDelta(result: Record<string, unknown>): { fromVersion: string; toVersion: string; applied: boolean } | null {
    const applied = result.updateApplied === true || String(result.checkUpdateResult || '').trim().toUpperCase() === 'UPDATED';
    const fromVersion = String(result.previousVersion || result.currentVersion || '').trim();
    const toVersion = String(
        applied
            ? result.updatedVersion || result.latestVersion || ''
            : result.latestVersion || result.updatedVersion || ''
    ).trim();
    if (!fromVersion || !toVersion || fromVersion === toVersion) {
        return null;
    }
    return { fromVersion, toVersion, applied };
}

function printColoredVersionDelta(result: Record<string, unknown>): void {
    if (!supportsColor()) {
        return;
    }
    const delta = getUpdateVersionDelta(result);
    if (!delta) {
        return;
    }
    const toColor = delta.applied ? green : cyan;
    const label = delta.applied ? 'Version applied' : 'Version available';
    console.log(`${bold(label)} ${yellow(delta.fromVersion)} ${dim('->')} ${toColor(delta.toVersion)}`);
    console.log('');
}

function printableValue(value: unknown): string {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry)).filter((entry) => entry.trim().length > 0).join(', ');
    }
    if (typeof value === 'boolean') {
        return value ? 'yes' : 'no';
    }
    return String(value ?? '').trim();
}

function hasPrintableValue(value: unknown): boolean {
    return printableValue(value).length > 0;
}

function formatUpdateVersionSummary(result: Record<string, unknown>): string {
    const fromVersion = printableValue(result.previousVersion || result.currentVersion);
    const toVersion = printableValue(result.updatedVersion || result.latestVersion);
    if (fromVersion && toVersion && fromVersion !== toVersion) {
        return `${fromVersion} -> ${toVersion}`;
    }
    return toVersion || fromVersion || 'unknown';
}

function formatProvenanceSummary(result: Record<string, unknown>): string {
    const status = printableValue(result.releaseProvenanceStatus);
    if (!status) {
        return '';
    }
    if (status === 'TRUSTED_GIT_NO_RELEASE_SIGNATURE') {
        return 'trusted git source; no release signature for git sources (details in update report)';
    }
    if (status === 'TRUST_OVERRIDE_UNVERIFIED') {
        return 'trust override used; source not allowlist-verified (details in update report)';
    }
    if (status === 'NPM_REGISTRY_INTEGRITY_RECORDED') {
        return 'npm registry integrity recorded (details in update report)';
    }
    return `${status} (details in update report)`;
}

function colorUpdateValue(label: string, value: string): string {
    const normalized = value.trim().toUpperCase();
    if (label === 'Status') {
        if (normalized === 'UPDATED' || normalized === 'UP_TO_DATE') return green(value);
        if (normalized.includes('AVAILABLE') || normalized.includes('DRY_RUN')) return yellow(value);
        if (normalized.includes('FAILED') || normalized.includes('ERROR')) return red(value);
    }
    if (label === 'Applied' || label === 'Update available' || label === 'Content drift') {
        return normalized === 'YES' ? green(value) : dim(value);
    }
    if (label === 'Version' && value.includes('->')) {
        const [fromVersion, toVersion] = value.split('->').map((part) => part.trim());
        return `${yellow(fromVersion)} ${dim('->')} ${green(toVersion)}`;
    }
    if (label === 'Report' || label === 'Rollback snapshot') {
        return cyan(value);
    }
    return value;
}

function printUpdateSection(title: string, rows: Array<[string, unknown]>): void {
    const printableRows = rows
        .map(([label, value]) => [label, printableValue(value)] as const)
        .filter(([, value]) => value.length > 0);
    if (printableRows.length === 0) {
        return;
    }

    console.log(bold(title));
    for (const [label, value] of printableRows) {
        console.log(`  ${bold(`${label}:`)} ${colorUpdateValue(label, value)}`);
    }
    console.log('');
}

function formatHumanUpdateOutput(result: Record<string, unknown>): void {
    printUpdateSection('Result', [
        ['Status', result.checkUpdateResult],
        ['Applied', result.updateApplied],
        ['Update available', result.updateAvailable],
        ['Version', formatUpdateVersionSummary(result)],
        ['Optional checks notice', result.optionalQualityChecksNotice],
        ['Content drift', result.contentDriftDetected],
        ['Drifted items', result.driftedSyncItems]
    ]);

    printUpdateSection('Source', [
        ['Type', result.sourceType],
        ['Reference', result.sourceReference],
        ['Package', result.exactPackageSpec || result.requestedPackageSpec || result.packageSpec],
        ['Integrity', result.resolvedPackageIntegrity],
        ['Repo', result.repoUrl],
        ['Branch', result.branch],
        ['Git commit', result.gitCommitSha],
        ['Target', result.targetRoot]
    ]);

    printUpdateSection('Safety', [
        ['Trust policy', result.trustPolicy],
        ['Trust override', result.trustOverrideUsed],
        ['Override source', result.trustOverrideSource],
        ['Provenance', formatProvenanceSummary(result)]
    ]);

    printUpdateSection('Recovery', [
        ['Rollback status', result.rollbackStatus],
        ['Rollback snapshot', result.rollbackSnapshotPath],
        ['Report', result.updateReportPath]
    ]);

    if (hasPrintableValue(result.updateReportPath)) {
        console.log(dim('Detailed diagnostics are available in the update report and with --json.'));
    } else {
        console.log(dim('Detailed diagnostics are available with --json.'));
    }
}

export async function handleUpdate(commandArgv: string[], packageJson: PackageJsonLike): Promise<void> {
    if (commandArgv.length > 0 && String(commandArgv[0] || '').trim().toLowerCase() === 'git') {
        await handleUpdateGit(commandArgv.slice(1), packageJson);
        return;
    }

    const updateDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--package-spec': { key: 'packageSpec', type: 'string' },
        '--source-path': { key: 'sourcePath', type: 'string' },
        '--no-prompt': { key: 'noPrompt', type: 'boolean' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--skip-verify': { key: 'skipVerify', type: 'boolean' },
        '--skip-manifest-validation': { key: 'skipManifestValidation', type: 'boolean' },
        '--trust-override': { key: 'trustOverride', type: 'boolean' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, updateDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) {
        printHelp(packageJson);
        return;
    }
    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    const bundlePath = ensureBundleExists(targetRoot, 'update');
    assertExplicitCliTrustOverride('update', {
        trustOverride: options.trustOverride === true,
        noPrompt: options.noPrompt === true
    });

    let lifecycleResult: UpdateLifecycleResult | null = null;
    const updateResult = await runWithRestartOnFailure(() => runCheckUpdate({
        targetRoot,
        bundleRoot: bundlePath,
        initAnswersPath: typeof options.initAnswersPath === 'string'
            ? options.initAnswersPath
            : getDefaultInitAnswersPath(targetRoot, bundlePath),
        packageSpec: typeof options.packageSpec === 'string' ? options.packageSpec : undefined,
        sourcePath: typeof options.sourcePath === 'string' ? options.sourcePath : undefined,
        apply: true,
        noPrompt: options.noPrompt === true,
        dryRun: options.dryRun === true,
        skipVerify: options.skipVerify === true,
        skipManifestValidation: options.skipManifestValidation === true,
        trustOverride: options.trustOverride === true,
        updateRunner(runnerOptions) {
            lifecycleResult = buildUpdateLifecycleRunner(bundlePath, options.dryRun === true)(runnerOptions);
        }
    }), options.dryRun !== true);
    if (updateResult.updateApplied) {
        markRuntimeRestartRequired();
    }
    const mergedUpdateResultBase = mergeUpdateLifecycleOutput(toKeyValueRecord(updateResult), lifecycleResult);
    const mergedUpdateResult = updateResult.updateApplied
        ? finalizeAppliedUpdateOutput(mergedUpdateResultBase, bundlePath)
        : mergedUpdateResultBase;
    if (options.json === true) {
        console.log(JSON.stringify(mergedUpdateResult, null, 2));
    } else {
        printUpdateStatusBanner(mergedUpdateResult);
        printColoredVersionDelta(mergedUpdateResult);
        formatHumanUpdateOutput(mergedUpdateResult);
        printUpdateAnnouncementSections(mergedUpdateResult);
    }
}

export async function handleUpdateGit(commandArgv: string[], packageJson: PackageJsonLike): Promise<void> {
    const updateGitDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--repo-url': { key: 'repoUrl', type: 'string' },
        '--branch': { key: 'branch', type: 'string' },
        '--check-only': { key: 'checkOnly', type: 'boolean' },
        '--no-prompt': { key: 'noPrompt', type: 'boolean' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--skip-verify': { key: 'skipVerify', type: 'boolean' },
        '--skip-manifest-validation': { key: 'skipManifestValidation', type: 'boolean' },
        '--trust-override': { key: 'trustOverride', type: 'boolean' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, updateGitDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) {
        printHelp(packageJson);
        return;
    }
    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    const bundlePath = ensureBundleExists(targetRoot, 'update git');
    assertExplicitCliTrustOverride('update git', {
        trustOverride: options.trustOverride === true,
        noPrompt: options.noPrompt === true
    });

    let lifecycleResult: UpdateLifecycleResult | null = null;
    const updateResult = await runWithRestartOnFailure(() => runUpdateFromGit({
        targetRoot,
        bundleRoot: bundlePath,
        initAnswersPath: typeof options.initAnswersPath === 'string'
            ? options.initAnswersPath
            : getDefaultInitAnswersPath(targetRoot, bundlePath),
        repoUrl: typeof options.repoUrl === 'string' ? options.repoUrl : undefined,
        branch: typeof options.branch === 'string' ? options.branch : undefined,
        checkOnly: options.checkOnly === true,
        noPrompt: options.noPrompt === true,
        dryRun: options.dryRun === true,
        skipVerify: options.skipVerify === true,
        skipManifestValidation: options.skipManifestValidation === true,
        trustOverride: options.trustOverride === true,
        updateRunner(runnerOptions) {
            lifecycleResult = buildUpdateLifecycleRunner(bundlePath, options.dryRun === true)(runnerOptions);
        }
    }), options.checkOnly !== true && options.dryRun !== true) as Record<string, unknown>;
    if (updateResult.updateApplied === true) {
        markRuntimeRestartRequired();
    }
    const mergedUpdateGitResultBase = mergeUpdateLifecycleOutput(updateResult, lifecycleResult);
    const mergedUpdateGitResult = updateResult.updateApplied === true
        ? finalizeAppliedUpdateOutput(mergedUpdateGitResultBase, bundlePath)
        : mergedUpdateGitResultBase;
    if (options.json === true) {
        console.log(JSON.stringify(mergedUpdateGitResult, null, 2));
    } else {
        printUpdateStatusBanner(mergedUpdateGitResult);
        printColoredVersionDelta(mergedUpdateGitResult);
        formatHumanUpdateOutput(mergedUpdateGitResult);
        printUpdateAnnouncementSections(mergedUpdateGitResult);
    }
}

export async function handleCheckUpdate(commandArgv: string[], packageJson: PackageJsonLike): Promise<void> {
    const checkUpdateDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--package-spec': { key: 'packageSpec', type: 'string' },
        '--source-path': { key: 'sourcePath', type: 'string' },
        '--apply': { key: 'apply', type: 'boolean' },
        '--no-prompt': { key: 'noPrompt', type: 'boolean' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--skip-verify': { key: 'skipVerify', type: 'boolean' },
        '--skip-manifest-validation': { key: 'skipManifestValidation', type: 'boolean' },
        '--trust-override': { key: 'trustOverride', type: 'boolean' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, checkUpdateDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) {
        printHelp(packageJson);
        return;
    }
    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    const bundlePath = ensureBundleExists(targetRoot, 'check-update');
    assertExplicitCliTrustOverride('check-update', {
        trustOverride: options.trustOverride === true,
        noPrompt: options.noPrompt === true
    });

    let lifecycleResult: UpdateLifecycleResult | null = null;
    const checkResult = await runWithRestartOnFailure(() => runCheckUpdate({
        targetRoot,
        bundleRoot: bundlePath,
        initAnswersPath: typeof options.initAnswersPath === 'string'
            ? options.initAnswersPath
            : getDefaultInitAnswersPath(targetRoot, bundlePath),
        packageSpec: typeof options.packageSpec === 'string' ? options.packageSpec : undefined,
        sourcePath: typeof options.sourcePath === 'string' ? options.sourcePath : undefined,
        apply: options.apply === true,
        noPrompt: options.noPrompt === true,
        dryRun: options.dryRun === true,
        skipVerify: options.skipVerify === true,
        skipManifestValidation: options.skipManifestValidation === true,
        trustOverride: options.trustOverride === true,
        updateRunner(runnerOptions) {
            lifecycleResult = buildUpdateLifecycleRunner(bundlePath, options.dryRun === true)(runnerOptions);
        }
    }), options.apply === true && options.dryRun !== true);
    if (checkResult.updateApplied) {
        markRuntimeRestartRequired();
    }
    const mergedCheckResultBase = mergeUpdateLifecycleOutput(toKeyValueRecord(checkResult), lifecycleResult);
    const mergedCheckResult = checkResult.updateApplied
        ? finalizeAppliedUpdateOutput(mergedCheckResultBase, bundlePath)
        : mergedCheckResultBase;
    if (options.json === true) {
        console.log(JSON.stringify(mergedCheckResult, null, 2));
    } else {
        printUpdateStatusBanner(mergedCheckResult);
        printColoredVersionDelta(mergedCheckResult);
        formatHumanUpdateOutput(mergedCheckResult);
        printUpdateAnnouncementSections(mergedCheckResult);
    }
}

export async function handleRollback(commandArgv: string[], packageJson: PackageJsonLike): Promise<void> {
    const rollbackDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--snapshot-path': { key: 'snapshotPath', type: 'string' },
        '--to-version': { key: 'toVersion', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--source-path': { key: 'sourcePath', type: 'string' },
        '--package-spec': { key: 'packageSpec', type: 'string' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, rollbackDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) {
        printHelp(packageJson);
        return;
    }
    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    const bundlePath = ensureBundleExists(targetRoot, 'rollback');

    const rollbackResult = await runWithRestartOnFailure(() => runRollback({
        targetRoot,
        bundleRoot: bundlePath,
        snapshotPath: typeof options.snapshotPath === 'string' ? options.snapshotPath : undefined,
        targetVersion: typeof options.toVersion === 'string' ? options.toVersion : undefined,
        sourcePath: typeof options.sourcePath === 'string' ? options.sourcePath : undefined,
        packageSpec: typeof options.packageSpec === 'string' ? options.packageSpec : undefined,
        initAnswersPath: typeof options.initAnswersPath === 'string'
            ? options.initAnswersPath
            : getDefaultInitAnswersPath(targetRoot, bundlePath),
        dryRun: options.dryRun === true
    }), options.dryRun !== true) as Record<string, unknown>;
    if (options.dryRun !== true) {
        markRuntimeRestartRequired();
    }

    if (options.json === true) {
        console.log(JSON.stringify(rollbackResult, null, 2));
    } else if (rollbackResult.rollbackMode === 'version') {
        formatKeyValueOutput(rollbackResult, [
            'targetRoot', 'rollbackMode', 'targetVersion',
            'sourceType', 'sourceReference', 'sourceVersion',
            'currentVersion', 'rollbackVersion', 'updatedVersion',
            'restoreStatus', 'syncStatus', 'installStatus', 'materializationStatus',
            'safetySnapshotPath', 'safetySnapshotRecordsPath', 'safetyRollbackStatus',
            'bundleSyncBackupPath', 'rollbackReportPath'
        ]);
    } else {
        formatKeyValueOutput(rollbackResult, [
            'targetRoot', 'rollbackMode', 'snapshotPath', 'rollbackRecordsPath', 'rollbackRecordCount',
            'currentVersion', 'snapshotVersion', 'rollbackVersion', 'updatedVersion', 'restoreStatus',
            'bundleBackupPath', 'bundleBackupMetadataPath', 'bundleRestoreStatus',
            'safetySnapshotPath', 'safetySnapshotRecordsPath', 'safetyRollbackStatus',
            'rollbackReportPath'
        ]);
    }

}
