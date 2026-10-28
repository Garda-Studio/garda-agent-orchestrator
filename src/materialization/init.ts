import * as path from 'node:path';
import { mergeConfig } from '../core/config-merge';
import { ensureDirectory, pathExists } from '../core/filesystem';
import {
    DEFAULT_ASSISTANT_BREVITY,
    DEFAULT_ASSISTANT_LANGUAGE,
    DEFAULT_SOURCE_OF_TRUTH
} from '../core/constants';
import { PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT } from '../core/project-memory-rollout';
import {
    getActiveAgentEntrypointFiles,
    getCanonicalEntrypointFile,
    getProviderOrchestratorProfileDefinitions
} from './common';
import { getProjectDiscovery } from './project-discovery';
import { RULE_FILES } from './rule-materialization';
import { withLifecycleOperationLock } from '../lifecycle/common';
import type { RunInitOptions } from './init/init-contracts';
import { runInitConfigStage } from './init/init-config-stage';
import { runInitRuleStage } from './init/init-rule-stage';
import { runInitReportingStage } from './init/init-reporting-stage';

export { mergeConfig };
export { collectSourceInventory } from './init/init-filesystem';
export { USAGE_CONTRACT_MARKERS } from './init/init-reporting-stage';

export function runInit(options: RunInitOptions) {
    const {
        targetRoot,
        bundleRoot,
        dryRun = false,
        assistantLanguage = DEFAULT_ASSISTANT_LANGUAGE,
        assistantBrevity = DEFAULT_ASSISTANT_BREVITY,
        sourceOfTruth = DEFAULT_SOURCE_OF_TRUTH,
        enforceNoAutoCommit = false,
        claudeOrchestratorFullAccess = false,
        tokenEconomyEnabled = true,
        providerMinimalism = true,
        activeAgentFilesSeed = null,
        preserveLegacyReviewExecutionPolicyOmission = false,
        preservedCompileGateCommand = null,
        lifecycleLockAlreadyHeld = false
    } = options;

    const templateRoot = path.join(bundleRoot, 'template');
    const liveRoot = path.join(bundleRoot, 'live');
    const templateRuleRoot = path.join(templateRoot, 'docs/agent-rules');
    const liveRuleRoot = path.join(liveRoot, 'docs/agent-rules');
    const workflowConfigPath = path.join(liveRoot, 'config', 'workflow-config.json');
    const workflowConfigExistedBeforeRun = pathExists(workflowConfigPath);
    const preserveLegacyWorkflowConfigOmission = (
        preserveLegacyReviewExecutionPolicyOmission
        && !workflowConfigExistedBeforeRun
    );

    if (!pathExists(templateRoot)) {
        throw new Error(`Template directory not found: ${templateRoot}`);
    }

    const normalizedTarget = path.resolve(targetRoot);
    const normalizedBundle = path.resolve(bundleRoot);
    if (normalizedTarget.toLowerCase() === normalizedBundle.toLowerCase()) {
        throw new Error(
            `TargetRoot points to orchestrator bundle directory '${bundleRoot}'. Use the project root parent directory instead.`
        );
    }

    const runWithLock = <T>(callback: () => T): T => lifecycleLockAlreadyHeld
        ? callback()
        : withLifecycleOperationLock(normalizedTarget, 'init', callback);

    return runWithLock(() => {
        const projectName = path.basename(normalizedTarget);
        const timestampIso = new Date().toISOString();
        const lang = (
            assistantLanguage || DEFAULT_ASSISTANT_LANGUAGE
        ).trim() || DEFAULT_ASSISTANT_LANGUAGE;
        const brevity = (
            assistantBrevity || DEFAULT_ASSISTANT_BREVITY
        ).trim().toLowerCase();
        if (!['concise', 'detailed'].includes(brevity)) {
            throw new Error(
                `Unsupported AssistantBrevity value '${brevity}'. Allowed values: concise, detailed.`
            );
        }

        const trimmedSoT = (sourceOfTruth || DEFAULT_SOURCE_OF_TRUTH).trim();
        const canonicalEntrypoint = getCanonicalEntrypointFile(trimmedSoT);
        const activeEntryFiles = getActiveAgentEntrypointFiles(
            activeAgentFilesSeed,
            trimmedSoT
        );
        const resolvedActiveEntryFiles = activeEntryFiles.length > 0
            ? activeEntryFiles
            : [canonicalEntrypoint];
        const providerOrchestratorProfiles = getProviderOrchestratorProfileDefinitions()
            .filter((profile) => resolvedActiveEntryFiles.includes(profile.entrypointFile));

        if (!dryRun) {
            ensureDirectory(liveRoot);
            ensureDirectory(liveRuleRoot);
        }

        const discovery = getProjectDiscovery(targetRoot);
        const ruleStage = runInitRuleStage({
            targetRoot,
            bundleRoot,
            templateRoot,
            liveRoot,
            templateRuleRoot,
            liveRuleRoot,
            workflowConfigPath,
            dryRun,
            timestampIso,
            lang,
            brevity,
            discovery,
            preservedCompileGateCommand
        });
        const configStage = runInitConfigStage({
            targetRoot,
            templateRoot,
            liveRoot,
            workflowConfigExistedBeforeRun,
            preserveLegacyWorkflowConfigOmission,
            discovery,
            preservedCompileGateCommand,
            tokenEconomyEnabled,
            dryRun
        });
        const reportingStage = runInitReportingStage({
            targetRoot,
            normalizedTarget,
            bundleRoot,
            liveRoot,
            dryRun,
            timestampIso,
            projectName,
            resolvedActiveEntryFiles,
            providerOrchestratorProfiles,
            claudeOrchestratorFullAccess,
            providerMinimalism,
            ruleSourceMap: ruleStage.ruleSourceMap,
            copiedSupportDirs: ruleStage.copiedSupportDirs,
            configMergeStatuses: configStage.configMergeStatuses,
            lang,
            brevity,
            trimmedSoT,
            canonicalEntrypoint,
            enforceNoAutoCommit,
            tokenEconomyEnabled,
            discovery,
            projectMemoryBootstrapReport: ruleStage.projectMemoryBootstrapReport.report,
            projectMemoryMaintenanceSummaryLine: configStage.projectMemoryMaintenanceSummaryLine,
            optionalQualityChecksNotice: configStage.optionalQualityChecksNotice,
            legacyStyleGuidanceActive: ruleStage.legacyStyleGuidanceActive,
            migrationResult: ruleStage.migrationResult,
            materializedWorkflowConfig: configStage.materializedWorkflowConfig
        });

        return {
            targetRoot: normalizedTarget,
            projectName,
            liveRoot,
            assistantLanguage: lang,
            assistantBrevity: brevity,
            sourceOfTruth: trimmedSoT,
            enforceNoAutoCommit,
            claudeOrchestratorFullAccess,
            tokenEconomyEnabled,
            providerMinimalism,
            activeAgentFiles: resolvedActiveEntryFiles,
            gitignoreEntriesAdded: reportingStage.gitignoreEntriesAdded,
            agentignoreUpdated: reportingStage.agentignoreUpdated,
            ruleFilesMaterialized: RULE_FILES.length,
            supportDirectoriesSynced: ruleStage.copiedSupportDirs,
            seedOnlyDirectoriesSeeded: ruleStage.seededDirs,
            projectMemoryMigration: ruleStage.migrationResult,
            projectMemoryBootstrapReportPath: ruleStage.projectMemoryBootstrapReport.path,
            projectMemoryBootstrapReport: ruleStage.projectMemoryBootstrapReport.report,
            projectMemoryMaintenanceSummaryLine: configStage.projectMemoryMaintenanceSummaryLine,
            projectMemoryRefreshHandoffPrompt: PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT,
            optionalQualityChecksNotice: configStage.optionalQualityChecksNotice,
            projectMemoryValidation: ruleStage.projectMemoryValidation,
            reviewCapabilitiesConfigMergeStatus: configStage.configMergeStatuses['review-capabilities'] || 'n/a',
            pathsConfigMergeStatus: configStage.configMergeStatuses.paths || 'n/a',
            tokenEconomyConfigMergeStatus: configStage.configMergeStatuses['token-economy'] || 'n/a',
            outputFiltersConfigMergeStatus: configStage.configMergeStatuses['output-filters'] || 'n/a',
            skillPacksConfigMergeStatus: configStage.configMergeStatuses['skill-packs'] || 'n/a',
            optionalSkillSelectionPolicyConfigMergeStatus: (
                configStage.configMergeStatuses['optional-skill-selection-policy'] || 'n/a'
            ),
            isolationModeConfigMergeStatus: configStage.configMergeStatuses['isolation-mode'] || 'n/a',
            profilesConfigMergeStatus: configStage.configMergeStatuses.profiles || 'n/a',
            reviewArtifactStorageConfigMergeStatus: (
                configStage.configMergeStatuses['review-artifact-storage'] || 'n/a'
            ),
            runtimeRetentionConfigMergeStatus: (
                configStage.configMergeStatuses['runtime-retention'] || 'n/a'
            ),
            workflowConfigMergeStatus: configStage.configMergeStatuses['workflow-config'] || 'n/a',
            gardaConfigMergeStatus: configStage.configMergeStatuses['garda.config'] || 'n/a',
            reviewCapabilitiesSync: reportingStage.reviewCapabilitiesSync,
            skillsIndexPath: reportingStage.skillsIndexPath,
            ruleSourceMap: ruleStage.ruleSourceMap,
            ruleRefresh: ruleStage.ruleSourceMap.filter(entry => entry.backupPath || entry.warning),
            sourceInventoryPath: reportingStage.sourceInventoryPath,
            initReportPath: reportingStage.initReportPath,
            projectDiscoveryPath: reportingStage.projectDiscoveryPath,
            usagePath: reportingStage.usagePath
        };
    });
}
