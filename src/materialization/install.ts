import * as path from 'node:path';
import * as fs from 'node:fs';
import { assertContainedDestination } from '../core/contained-filesystem';
import { pathExists, readTextFile } from '../core/filesystem';
import { readJsonFile } from '../core/json';
import { normalizeLineEndings } from '../core/line-endings';
import { resolvePathInsideRoot } from '../core/paths';
import { getRequiredReviewSkillBridgeHostEntry } from '../core/provider-registry';
import { withLifecycleOperationLock } from '../lifecycle/common';
import { validateInitAnswers } from '../schemas/init-answers';
import {
    convertActiveAgentEntrypointFilesToString,
    getActiveAgentEntrypointFiles,
    getCanonicalEntrypointFile,
    getGitHubSkillBridgeProfileDefinitions,
    getProviderOrchestratorProfileDefinitions
} from './common';
import {
    COMMIT_GUARD_END,
    COMMIT_GUARD_START,
    buildCommitGuardManagedBlock
} from './content-builders';
import { createUniqueInstallBackupRoot } from './install/install-backups';
import {
    assertCommitGuardHookMetadata,
    ensureCommitGuardHookExecutable,
    resolveCommitGuardHookDestination
} from './install/commit-guard-hook-path';
import type {
    BackupFileCallback,
    RunInstallOptions
} from './install/install-contracts';
import {
    runInstallPrimaryEntrypointStage,
    runInstallProviderEntrypointStage
} from './install/install-entrypoint-stage';
import { runInstallFinalizationStage } from './install/install-finalization-stage';
import {
    createInstallFilesystemStage,
    escapeInstallRegex
} from './install/install-filesystem-stage';
import {
    runInstallEditorSettingsStage,
    runInstallIgnoreStage
} from './install/install-settings-stage';
import { runInstallTaskStage } from './install/install-task-stage';
import { readSwitchModeState } from './switch-mode';
import {
    applyMaterializationStage,
    createWriteTextFileStage
} from './staged-side-effects';

const LEGACY_COMMIT_GUARD_BUNDLE_NAMES = Object.freeze([
    ['ai', 'agent', 'orchestrator'].join('-'),
    ['agent', 'orchestrator'].join('-')
]);

function getCommitGuardManagedBlockPattern(global = false): RegExp {
    const markerPairs = [
        [COMMIT_GUARD_START, COMMIT_GUARD_END],
        ...LEGACY_COMMIT_GUARD_BUNDLE_NAMES.map((bundleName) => [
            `# ${bundleName}:commit-guard-start`,
            `# ${bundleName}:commit-guard-end`
        ])
    ];
    return new RegExp(
        markerPairs
            .map(([startMarker, endMarker]) => (
                `${escapeInstallRegex(startMarker)}[\\s\\S]*?${escapeInstallRegex(endMarker)}`
            ))
            .join('|'),
        global ? 'gm' : 'm'
    );
}

function getOptionalStringField(
    record: Record<string, unknown> | null,
    field: string
): string | null {
    const value = record?.[field];
    return typeof value === 'string' ? value : null;
}

function replaceCommitGuardManagedBlocks(
    content: string,
    managedBlock: string
): string {
    let inserted = false;
    return content.replace(getCommitGuardManagedBlockPattern(true), function () {
        if (inserted) {
            return '';
        }
        inserted = true;
        return managedBlock;
    });
}

export function runInstall(options: RunInstallOptions) {
    const {
        targetRoot,
        bundleRoot,
        dryRun = false,
        preserveExisting = true,
        alignExisting = true,
        runInit = true,
        answerDependentOnly = false,
        skipBackups = false,
        assistantLanguage,
        assistantBrevity,
        sourceOfTruth,
        initAnswersPath,
        preserveLegacyReviewExecutionPolicyOmission = false,
        lifecycleLockAlreadyHeld = false,
        initRunner
    } = options;
    const sourceRoot = path.join(bundleRoot, 'template');

    if (!pathExists(sourceRoot)) {
        throw new Error(`Template directory not found: ${sourceRoot}`);
    }

    const normalizedTarget = path.resolve(targetRoot);
    const normalizedBundle = path.resolve(bundleRoot);
    if (normalizedTarget.toLowerCase() === normalizedBundle.toLowerCase()) {
        throw new Error(
            `TargetRoot points to orchestrator bundle directory '${bundleRoot}'. Use the project root parent directory instead.`
        );
    }

    const trimmedLanguage = (assistantLanguage || '').trim();
    if (!trimmedLanguage) {
        throw new Error('AssistantLanguage must not be empty.');
    }
    const trimmedBrevity = (assistantBrevity || '').trim().toLowerCase();
    const trimmedSourceOfTruth = (sourceOfTruth || '').trim();
    const runWithLock = <T>(callback: () => T): T => lifecycleLockAlreadyHeld
        ? callback()
        : withLifecycleOperationLock(normalizedTarget, 'install', callback);

    return runWithLock(() => {
        const resolvedInitPath = resolvePathInsideRoot(targetRoot, initAnswersPath);
        if (!pathExists(resolvedInitPath)) {
            throw new Error(`Init answers file not found: ${resolvedInitPath}`);
        }
        const initAnswers = validateInitAnswers(readJsonFile(resolvedInitPath));

        if (
            initAnswers.AssistantLanguage.toLowerCase()
            !== trimmedLanguage.toLowerCase()
        ) {
            throw new Error(
                `AssistantLanguage parameter '${trimmedLanguage}' does not match init answers artifact value '${initAnswers.AssistantLanguage}'.`
            );
        }
        if (initAnswers.AssistantBrevity !== trimmedBrevity) {
            throw new Error(
                `AssistantBrevity parameter '${trimmedBrevity}' does not match init answers artifact value '${initAnswers.AssistantBrevity}'.`
            );
        }
        if (
            initAnswers.SourceOfTruth.toUpperCase().replace(/\s+/g, '')
            !== trimmedSourceOfTruth.toUpperCase().replace(/\s+/g, '')
        ) {
            throw new Error(
                `SourceOfTruth parameter '${trimmedSourceOfTruth}' does not match init answers artifact value '${initAnswers.SourceOfTruth}'.`
            );
        }

        const enforceNoAutoCommit = initAnswers.EnforceNoAutoCommit;
        const enableClaudeOrchestratorFullAccess =
            initAnswers.ClaudeOrchestratorFullAccess;
        const tokenEconomyEnabled = initAnswers.TokenEconomyEnabled;
        const providerMinimalism = initAnswers.ProviderMinimalism;
        const switchModeBeforeInstall = readSwitchModeState(targetRoot, bundleRoot);
        const canonicalEntryFile = getCanonicalEntrypointFile(
            initAnswers.SourceOfTruth
        );
        const activeEntryFilesSeed = initAnswers.ActiveAgentFiles
            ? initAnswers.ActiveAgentFiles.join(', ')
            : null;
        let activeEntryFiles = getActiveAgentEntrypointFiles(
            activeEntryFilesSeed,
            initAnswers.SourceOfTruth
        );
        if (activeEntryFiles.length === 0) {
            activeEntryFiles = [canonicalEntryFile];
        }
        const redirectEntryFiles = activeEntryFiles.filter(
            (entrypointFile) => entrypointFile !== canonicalEntryFile
        );
        const providerOrchestratorProfiles =
            getProviderOrchestratorProfileDefinitions().filter(
                (profile) => activeEntryFiles.includes(profile.entrypointFile)
            );
        const reviewSkillBridgeHostEntrypoint =
            getRequiredReviewSkillBridgeHostEntry().entrypointFile;
        const githubSkillBridgeProfiles = activeEntryFiles.includes(
            reviewSkillBridgeHostEntrypoint
        )
            ? getGitHubSkillBridgeProfileDefinitions()
            : [];
        const providerBridgePaths = providerOrchestratorProfiles.map(
            (profile) => profile.orchestratorRelativePath
        );

        const backupLocation = createUniqueInstallBackupRoot(bundleRoot);
        const { timestamp, backupRoot } = backupLocation;
        const deploymentDate = new Date().toISOString().slice(0, 10);
        const bundleVersionPath = path.join(bundleRoot, 'VERSION');
        const liveVersionPath = path.join(bundleRoot, 'live', 'version.json');
        if (!pathExists(bundleVersionPath)) {
            throw new Error(`Bundle version file not found: ${bundleVersionPath}`);
        }
        const bundleVersion = readTextFile(bundleVersionPath).trim();
        if (!bundleVersion) {
            throw new Error(`Bundle version file is empty: ${bundleVersionPath}`);
        }

        const filesystem = createInstallFilesystemStage({
            targetRoot,
            backupRoot,
            dryRun,
            skipBackups,
            deploymentDate,
            canonicalEntryFile
        });
        filesystem.writeBackupManifest(timestamp);

        runInstallTaskStage({
            sourceRoot,
            targetRoot,
            dryRun,
            preserveExisting,
            answerDependentOnly,
            filesystem
        });
        runInstallPrimaryEntrypointStage({
            sourceRoot,
            canonicalEntryFile,
            redirectEntryFiles,
            providerBridgePaths,
            filesystem
        });
        const editorSettings = runInstallEditorSettingsStage({
            targetRoot,
            dryRun,
            preserveExisting,
            canonicalEntryFile,
            enableClaudeOrchestratorFullAccess,
            filesystem
        });
        const providerEntrypoints = runInstallProviderEntrypointStage({
            targetRoot,
            canonicalEntryFile,
            redirectEntryFiles,
            providerOrchestratorProfiles,
            githubSkillBridgeProfiles,
            providerMinimalism,
            reviewSkillBridgeHostEntrypoint,
            providerBridgePaths,
            filesystem
        });
        const ignoreSettings = runInstallIgnoreStage({
            targetRoot,
            bundleRoot,
            dryRun,
            activeEntryFiles,
            providerOrchestratorProfiles,
            enableClaudeOrchestratorFullAccess,
            providerMinimalism,
            qwenExists: editorSettings.qwenExists,
            filesystem
        });
        const commitGuardHookUpdated = applyCommitGuardHook(
            targetRoot,
            enforceNoAutoCommit,
            dryRun,
            filesystem.backupFile
        );
        const finalization = runInstallFinalizationStage({
            targetRoot,
            normalizedTarget,
            liveVersionPath,
            dryRun,
            switchModeBeforeInstall,
            bundleVersion,
            resolvedInitPath,
            sourceOfTruth: initAnswers.SourceOfTruth,
            canonicalEntryFile,
            activeEntryFiles,
            assistantLanguage: trimmedLanguage,
            assistantBrevity: trimmedBrevity,
            enforceNoAutoCommit,
            enableClaudeOrchestratorFullAccess,
            tokenEconomyEnabled,
            providerMinimalism,
            runInit,
            initRunner,
            activeEntryFilesSeed,
            preserveLegacyReviewExecutionPolicyOmission
        });
        const { metrics } = filesystem;

        return {
            targetRoot: normalizedTarget,
            templateRoot: sourceRoot,
            preserveExisting,
            alignExisting,
            runInit,
            answerDependentOnly,
            skipBackups,
            initAnswersPath: resolvedInitPath,
            deploymentDate,
            bundleVersion,
            assistantLanguage: trimmedLanguage,
            assistantBrevity: trimmedBrevity,
            sourceOfTruth: initAnswers.SourceOfTruth,
            enforceNoAutoCommit,
            claudeOrchestratorFullAccess: enableClaudeOrchestratorFullAccess,
            tokenEconomyEnabled,
            providerMinimalism,
            canonicalEntrypoint: canonicalEntryFile,
            activeAgentFiles:
                convertActiveAgentEntrypointFilesToString(activeEntryFiles),
            filesDeployed: metrics.deployed,
            filesForcedOverwrite: metrics.forcedOverwrites,
            filesSkippedExisting: metrics.skippedExisting,
            filesAligned: metrics.aligned,
            filesPreserved: providerEntrypoints.preserved,
            filesBackedUp: metrics.backedUp,
            gitignoreEntriesAdded: ignoreSettings.gitignoreEntriesAdded,
            agentignoreUpdated: ignoreSettings.agentignoreUpdated,
            qwenSettingsParseMode: editorSettings.qwenSettingsParseMode,
            qwenSettingsNeedsUpdate: editorSettings.qwenSettingsNeedsUpdate,
            qwenSettingsUpdated: editorSettings.qwenSettingsUpdated,
            claudeLocalSettingsParseMode:
                editorSettings.claudeLocalSettingsParseMode,
            claudeLocalSettingsNeedsUpdate:
                editorSettings.claudeLocalSettingsNeedsUpdate,
            claudeLocalSettingsUpdated:
                editorSettings.claudeLocalSettingsUpdated,
            vscodeSettingsUpdated: editorSettings.vscodeSettingsUpdated,
            initInvoked: finalization.initInvoked,
            preCommitHookUpdated: commitGuardHookUpdated,
            liveVersionWritten: finalization.liveVersionWritten,
            protectedControlPlaneManifestWritten:
                finalization.protectedControlPlaneManifestWritten,
            workflowConfigMergeStatus: getOptionalStringField(
                finalization.initResult,
                'workflowConfigMergeStatus'
            ),
            optionalQualityChecksNotice: getOptionalStringField(
                finalization.initResult,
                'optionalQualityChecksNotice'
            ),
            projectMemoryMaintenanceSummaryLine: getOptionalStringField(
                finalization.initResult,
                'projectMemoryMaintenanceSummaryLine'
            ),
            projectMemoryRefreshHandoffPrompt: getOptionalStringField(
                finalization.initResult,
                'projectMemoryRefreshHandoffPrompt'
            ),
            backupRoot: dryRun ? null : backupRoot
        };
    });
}

export function applyCommitGuardHook(
    targetRoot: string,
    enabled: boolean,
    dryRun: boolean,
    backupFile?: BackupFileCallback
): boolean {
    const gitDirPath = path.join(targetRoot, '.git');
    if (!fs.existsSync(gitDirPath)) {
        if (enabled) {
            throw new Error(
                `EnforceNoAutoCommit=true but .git directory is missing at '${gitDirPath}'. Initialize git or set EnforceNoAutoCommit=false in init answers.`
            );
        }
        return false;
    }

    const destination = resolveCommitGuardHookDestination(targetRoot);
    const { hookPath } = destination;
    const managedBlock = buildCommitGuardManagedBlock();
    const pattern = getCommitGuardManagedBlockPattern();

    function writeHook(content: string): void {
        assertCommitGuardHookMetadata(destination);
        assertContainedDestination(destination.binding);
        const stage = createWriteTextFileStage(hookPath, content, destination.root);
        applyMaterializationStage({
            label: stage.label,
            apply: () => {
                assertCommitGuardHookMetadata(destination);
                stage.apply();
                if (enabled) ensureCommitGuardHookExecutable(destination);
            },
            rollback: stage.rollback
        }, { dryRun });
    }

    if (!pathExists(hookPath)) {
        if (!enabled) return false;
        if (!dryRun) {
            const hookContent = `#!/usr/bin/env bash\n\n${managedBlock}\n`;
            writeHook(hookContent);
        }
        return true;
    }

    let content = normalizeLineEndings(readTextFile(hookPath), '\n');
    let updatedContent: string;

    if (enabled) {
        if (pattern.test(content)) {
            updatedContent = replaceCommitGuardManagedBlocks(
                content,
                managedBlock
            );
        } else if (!content.trim()) {
            updatedContent = `#!/usr/bin/env bash\n\n${managedBlock}\n`;
        } else {
            updatedContent = `${content.trimEnd()}\n\n${managedBlock}\n`;
        }
    } else if (pattern.test(content)) {
        updatedContent = `${content.replace(pattern, '').trimEnd()}\n`;
    } else {
        return false;
    }

    const needsExecutableMode = enabled && process.platform !== 'win32'
        && (fs.statSync(hookPath).mode & 0o111) !== 0o111;
    if (updatedContent === content && !needsExecutableMode) return false;
    if (backupFile) {
        backupFile(hookPath, '.git/hooks/pre-commit');
    }
    if (!dryRun) {
        writeHook(updatedContent);
    }
    return true;
}
