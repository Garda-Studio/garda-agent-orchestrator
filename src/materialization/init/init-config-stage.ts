import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { cloneJsonValue, isPlainObject, mergeConfig } from '../../core/config-merge';
import { pathExists } from '../../core/filesystem';
import { bindContainedDestination, writeContainedFile } from '../../core/contained-filesystem';
import { readJsonFile } from '../../core/json';
import {
    buildDefaultWorkflowConfig,
    buildWorkflowConfigReviewCycleLimitDiagnostic,
    isConfiguredCompileGateCommand,
    mergeWorkflowConfigWithTemplate,
    OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE,
    readWorkflowConfigForMerge,
    shouldEmitOptionalQualityChecksEnabledNotice,
    type WorkflowConfigData,
    type WorkflowConfigReadStatus
} from '../../core/workflow-config';
import {
    buildProjectMemoryMaintenanceSummaryLine,
    normalizeProjectMemoryMaintenanceForDisplay
} from '../../core/project-memory-rollout';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../core/constants';
import { normalizeReviewCatalog } from '../../core/review-catalog';
import { validateCompileGateCommand } from '../../gates/compile';
import {
    buildDefaultReviewRemediationModePolicy,
    migrateReviewRemediationModePolicyLaneDefaults
} from '../../policy/review-remediation-mode-policy';
import { migrateLegacyManagedPathRegexes } from '../../policy/default-path-regexes';
import { resolveActiveTaskIds } from '../../core/task-queue/active-task-state';
import { isSourceCheckoutRoot } from '../../validators/workspace-layout/source-runtime';
import type { InitProjectDiscovery } from './init-contracts';

export const MANAGED_CONFIG_NAMES = [
    'review-capabilities',
    'review-catalog',
    'paths',
    'token-economy',
    'output-filters',
    'skill-packs',
    'optional-skill-selection-policy',
    'isolation-mode',
    'profiles',
    'review-artifact-storage',
    'runtime-retention',
    'workflow-config',
    'garda.config'
] as const;

export interface RunInitConfigStageOptions {
    targetRoot: string;
    templateRoot: string;
    liveRoot: string;
    workflowConfigExistedBeforeRun: boolean;
    preserveLegacyWorkflowConfigOmission: boolean;
    discovery: InitProjectDiscovery;
    preservedCompileGateCommand: string | null;
    tokenEconomyEnabled: boolean;
    dryRun: boolean;
}

export interface InitConfigStageResult {
    configMergeStatuses: Record<string, string>;
    materializedWorkflowConfig: Record<string, unknown>;
    projectMemoryMaintenanceSummaryLine: string;
    optionalQualityChecksNotice: string | null;
}

export function mergeProfilesConfigWithTemplate(
    templateConfig: Record<string, unknown>,
    existingConfig: Record<string, unknown> | null,
    options: { allowedReviewTypeIds?: readonly string[] } = {}
): Record<string, unknown> {
    const merged = mergeConfig(templateConfig, existingConfig);
    for (const groupName of ['built_in_profiles', 'user_profiles']) {
        const existingGroupName = existingConfig && Object.keys(existingConfig)
            .find((candidate) => candidate.toLowerCase() === groupName);
        const existingGroupValue = existingGroupName
            ? existingConfig?.[existingGroupName]
            : undefined;
        const existingGroup = isPlainObject(existingGroupValue)
            ? existingGroupValue as Record<string, unknown>
            : {};
        const mergedGroup = isPlainObject(merged[groupName])
            ? merged[groupName] as Record<string, unknown>
            : {};
        const existingNamesByLowercase = new Map<string, string>();
        for (const candidate of Object.keys(existingGroup)) {
            const normalizedName = candidate.toLowerCase();
            if (!existingNamesByLowercase.has(normalizedName)) {
                existingNamesByLowercase.set(normalizedName, candidate);
            }
        }
        for (const [mergedName, mergedProfileValue] of Object.entries(mergedGroup)) {
            if (!isPlainObject(mergedProfileValue)) {
                continue;
            }
            const mergedProfile = mergedProfileValue as Record<string, unknown>;
            const existingName = existingNamesByLowercase.get(mergedName.toLowerCase());
            if (!existingName) {
                if (Object.hasOwn(mergedProfile, 'review_remediation_mode_policy')) {
                    const templatePolicy = mergedProfile.review_remediation_mode_policy;
                    if (isPlainObject(templatePolicy) && templatePolicy.schema_version === 2) {
                        const catalogDefault = buildDefaultReviewRemediationModePolicy(options);
                        const configuredEligible = Array.isArray(templatePolicy.delta_eligible_review_types)
                            ? templatePolicy.delta_eligible_review_types
                            : [];
                        mergedProfile.review_remediation_mode_policy = {
                            ...templatePolicy,
                            delta_eligible_review_types: [...new Set([
                                ...configuredEligible,
                                ...catalogDefault.delta_eligible_review_types
                            ])].sort()
                        };
                    }
                }
                continue;
            }
            const existingProfile = existingGroup[existingName];
            if (!isPlainObject(existingProfile)) {
                continue;
            }
            if (!Object.hasOwn(existingProfile, 'review_remediation_mode_policy')) {
                delete mergedProfile.review_remediation_mode_policy;
                continue;
            }
            mergedProfile.review_remediation_mode_policy = migrateReviewRemediationModePolicyLaneDefaults(
                existingProfile.review_remediation_mode_policy,
                options
            );
        }
    }
    return merged;
}

export function getFullSuiteEnabledDiagnostic(config: Record<string, unknown>): string {
    const fullSuiteSection = isPlainObject(config.full_suite_validation)
        ? config.full_suite_validation
        : null;
    return typeof fullSuiteSection?.enabled === 'boolean'
        ? String(fullSuiteSection.enabled)
        : 'invalid';
}

function getProjectMemoryMaintenanceDiagnostic(
    config: Record<string, unknown>
): { enabled: string; mode: string } {
    const projectMemorySection = isPlainObject(config.project_memory_maintenance)
        ? normalizeProjectMemoryMaintenanceForDisplay(config.project_memory_maintenance)
        : null;
    return {
        enabled: projectMemorySection ? String(projectMemorySection.enabled) : 'invalid',
        mode: projectMemorySection ? String(projectMemorySection.enabled ? projectMemorySection.mode : 'off') : 'invalid'
    };
}

function buildWorkflowConfigMergeStatus(
    targetRoot: string,
    workflowConfigPath: string,
    readStatus: WorkflowConfigReadStatus,
    existingConfig: Record<string, unknown> | null,
    materializedConfig: Record<string, unknown>
): string {
    const relativePath = path.relative(targetRoot, workflowConfigPath).replace(/\\/g, '/');
    const enabledDiagnostic = getFullSuiteEnabledDiagnostic(materializedConfig);
    const projectMemoryDiagnostic = getProjectMemoryMaintenanceDiagnostic(materializedConfig);
    const reviewCycleDiagnostic = buildWorkflowConfigReviewCycleLimitDiagnostic(
        readStatus,
        existingConfig,
        materializedConfig
    );
    const suffix = [
        `path=${relativePath}`,
        `full_suite_validation.enabled=${enabledDiagnostic}`,
        `project_memory_maintenance.enabled=${projectMemoryDiagnostic.enabled}`,
        `project_memory_maintenance.mode=${projectMemoryDiagnostic.mode}`,
        reviewCycleDiagnostic
    ].join(' ');
    if (readStatus === 'present') {
        return `existing_values_preserved_and_missing_keys_filled ${suffix}`;
    }
    return `live_config_${readStatus}_template_applied ${suffix}`;
}

function normalizeCompileGateCommandCandidate(command: unknown, sourceLabel: string): string | null {
    const normalized = String(command || '').trim();
    if (!normalized || normalized === UNCONFIGURED_COMPILE_GATE_COMMAND) {
        return null;
    }
    try {
        validateCompileGateCommand(normalized, sourceLabel);
        return normalized;
    } catch {
        return null;
    }
}

function selectDiscoveredCompileGateCommand(commands: readonly string[]): string | null {
    for (const candidate of commands) {
        const command = normalizeCompileGateCommandCandidate(candidate, 'project-discovery compile-gate suggestion');
        if (command) {
            return command;
        }
    }
    return null;
}

function isDiscoveredCompileGateCommand(
    command: string,
    discovery: InitProjectDiscovery
): boolean {
    return discovery.suggestedCompileGateCommands.some((candidate) => (
        normalizeCompileGateCommandCandidate(candidate, 'project-discovery compile-gate suggestion') === command
    ));
}

function selectCompileGateCommand(
    existingCommand: string | null,
    discovery: InitProjectDiscovery,
    preservedCompileGateCommand: string | null
): string {
    const preservedCommand = normalizeCompileGateCommandCandidate(
        preservedCompileGateCommand,
        'preserved compile-gate command'
    );
    if (preservedCommand && (!existingCommand || isDiscoveredCompileGateCommand(existingCommand, discovery))) {
        return preservedCommand;
    }
    if (existingCommand) {
        return existingCommand;
    }
    return preservedCommand
        || selectDiscoveredCompileGateCommand(discovery.suggestedCompileGateCommands)
        || UNCONFIGURED_COMPILE_GATE_COMMAND;
}

function readConfiguredCompileGateCommandForGuidance(workflowConfigPath: string): string | null {
    if (!pathExists(workflowConfigPath)) {
        return null;
    }
    try {
        const parsed = readJsonFile(workflowConfigPath);
        if (!isPlainObject(parsed) || !isPlainObject(parsed.compile_gate)) {
            return null;
        }
        return normalizeCompileGateCommandCandidate(
            parsed.compile_gate.command,
            'existing workflow-config compile-gate command'
        );
    } catch {
        return null;
    }
}

export function selectCompileGateCommandForGuidance(
    workflowConfigPath: string,
    discovery: InitProjectDiscovery,
    preservedCompileGateCommand: string | null
): string {
    const existingCommand = readConfiguredCompileGateCommandForGuidance(workflowConfigPath);
    return selectCompileGateCommand(existingCommand, discovery, preservedCompileGateCommand);
}

function applyDiscoveredCompileGateCommand(
    workflowConfig: Record<string, unknown>,
    discovery: InitProjectDiscovery,
    preservedCompileGateCommand: string | null
): Record<string, unknown> {
    const compileGate = isPlainObject(workflowConfig.compile_gate)
        ? { ...workflowConfig.compile_gate }
        : {};
    const existingCommand = normalizeCompileGateCommandCandidate(
        compileGate.command,
        'existing workflow-config compile-gate command'
    );
    const selectedCommand = selectCompileGateCommand(existingCommand, discovery, preservedCompileGateCommand);
    if (existingCommand === selectedCommand && isConfiguredCompileGateCommand(compileGate.command)) {
        return workflowConfig;
    }

    compileGate.command = selectedCommand;
    return {
        ...workflowConfig,
        compile_gate: compileGate
    };
}

function readExistingInitConfigs(
    targetRoot: string,
    templateRoot: string,
    liveRoot: string
): Map<string, Record<string, unknown> | null> {
    const configs = new Map<string, Record<string, unknown> | null>();
    // Reject any invalid existing input before this stage writes even an earlier config.
    for (const configName of MANAGED_CONFIG_NAMES) {
        if (!pathExists(path.join(templateRoot, `config/${configName}.json`))) continue;
        const configPath = path.join(liveRoot, `config/${configName}.json`);
        const binding = bindContainedDestination(targetRoot, configPath);
        if (binding.missingAt !== null) {
            configs.set(configName, null);
            continue;
        }
        let config: Record<string, unknown> | null = null;
        try {
            if (configName === 'workflow-config') {
                const result = readWorkflowConfigForMerge(configPath);
                if (result.status === 'present') config = result.config;
            } else {
                const parsed = readJsonFile(configPath);
                if (isPlainObject(parsed)) config = parsed;
            }
        } catch {
            // Report the failed input without exposing JSON contents or parser diagnostics.
        }
        if (config === null) {
            throw new Error(
                `Existing ${configName} configuration cannot be read as a JSON object. `
                + 'Repair the existing configuration before retrying; its contents have been preserved.'
            );
        }
        configs.set(configName, config);
    }
    return configs;
}

export function hasAnyActiveTask(targetRoot: string, bundleRoot: string): boolean {
    try {
        return resolveActiveTaskIds(targetRoot, bundleRoot).size > 0;
    } catch {
        // An unreadable queue or runtime cannot prove that no task depends on the current config.
        return true;
    }
}

export function runInitConfigStage(
    options: RunInitConfigStageOptions
): InitConfigStageResult {
    const {
        targetRoot,
        templateRoot,
        liveRoot,
        workflowConfigExistedBeforeRun,
        preserveLegacyWorkflowConfigOmission,
        discovery,
        preservedCompileGateCommand,
        tokenEconomyEnabled,
        dryRun
    } = options;
    const existingConfigs = readExistingInitConfigs(targetRoot, templateRoot, liveRoot);
    const configMergeStatuses: Record<string, string> = {};
    let projectMemoryMaintenanceSummaryLine = buildProjectMemoryMaintenanceSummaryLine(
        buildDefaultWorkflowConfig().project_memory_maintenance
    );
    let materializedWorkflowConfig: Record<string, unknown> = buildDefaultWorkflowConfig();
    let optionalQualityChecksNotice: string | null = null;
    let catalogReviewTypeIds: string[] | undefined;

    for (const configName of MANAGED_CONFIG_NAMES) {
        const templateConfigPath = path.join(templateRoot, `config/${configName}.json`);
        const destConfigPath = path.join(liveRoot, `config/${configName}.json`);
        let pendingWrite: string | null = null;
        let preserveExistingConfig = false;

        if (!pathExists(templateConfigPath)) {
            configMergeStatuses[configName] = 'template_missing_preservation_skipped';
            continue;
        }

        try {
            const templateConfig = cloneJsonValue(readJsonFile(templateConfigPath) as Record<string, unknown>);
            let existingConfig: Record<string, unknown> | null = null;
            let workflowConfigReadStatus: WorkflowConfigReadStatus = 'missing';
            const treatWorkflowConfigAsMissingBeforeRun = (
                configName === 'workflow-config'
                && preserveLegacyWorkflowConfigOmission
            );
            const hadExistingConfig = treatWorkflowConfigAsMissingBeforeRun
                ? false
                : (existingConfigs.get(configName) ?? null) !== null;

            if (configName === 'workflow-config') {
                if (treatWorkflowConfigAsMissingBeforeRun || !workflowConfigExistedBeforeRun) {
                    workflowConfigReadStatus = 'missing';
                    existingConfig = null;
                } else {
                    existingConfig = existingConfigs.get(configName) ?? null;
                    workflowConfigReadStatus = existingConfig === null ? 'missing' : 'present';
                }
            } else if (hadExistingConfig) {
                existingConfig = existingConfigs.get(configName) ?? null;
            }

            const replaceWithCanonicalTemplate = configName === 'garda.config';
            const deferPathsMigration = configName === 'paths' && existingConfig !== null
                && hasAnyActiveTask(targetRoot, path.dirname(liveRoot));
            const materializedConfig = replaceWithCanonicalTemplate
                ? cloneJsonValue(templateConfig)
                : configName === 'workflow-config'
                    ? applyDiscoveredCompileGateCommand(mergeWorkflowConfigWithTemplate(
                        templateConfig as WorkflowConfigData,
                        existingConfig,
                        {
                            preserveLegacyReviewExecutionPolicyOmission: preserveLegacyWorkflowConfigOmission,
                            preserveMovedProjectQualityRulesAsCustom: isSourceCheckoutRoot(targetRoot)
                        }
                    ), discovery, preservedCompileGateCommand)
                    : configName === 'profiles'
                        ? mergeProfilesConfigWithTemplate(templateConfig, existingConfig, {
                            allowedReviewTypeIds: catalogReviewTypeIds
                        })
                        : deferPathsMigration && existingConfig !== null
                            ? cloneJsonValue(existingConfig)
                            : mergeConfig(templateConfig, existingConfig);

            if (configName === 'paths' && hadExistingConfig) {
                // Uncustomized legacy stack-specific defaults follow the current template. Active
                // tasks keep the exact classification config they started with; a later init migrates.
                if (!deferPathsMigration) {
                    migrateLegacyManagedPathRegexes(materializedConfig, templateConfig);
                } else if (!dryRun) {
                    const pendingConfig = mergeConfig(templateConfig, existingConfig);
                    migrateLegacyManagedPathRegexes(pendingConfig, templateConfig);
                    if (!isDeepStrictEqual(materializedConfig, pendingConfig)) {
                        process.stderr.write('NOTICE: Stack-neutral default path patterns were not applied to '
                            + 'live/config/paths.json because a task is active. After active tasks finish, run '
                            + '"garda init --target-root . --init-answers-path garda-agent-orchestrator/runtime/init-answers.json" '
                            + 'to apply them; customized patterns are never replaced.\n');
                    }
                }
            }

            if (configName === 'runtime-retention' && hadExistingConfig) {
                const existingDaily = existingConfig?.daily_maintenance;
                const existingPurge = existingConfig?.purge;
                // Missing legacy mode fields meant preview; new defaults apply only to new installations.
                if (isPlainObject(materializedConfig.daily_maintenance)
                    && (!isPlainObject(existingDaily) || !Object.hasOwn(existingDaily, 'dry_run'))) {
                    materializedConfig.daily_maintenance.dry_run = true;
                }
                if (isPlainObject(materializedConfig.purge)
                    && (!isPlainObject(existingPurge) || !Object.hasOwn(existingPurge, 'require_confirm'))) {
                    materializedConfig.purge.require_confirm = true;
                }
            }

            if (configName === 'review-catalog') {
                catalogReviewTypeIds = normalizeReviewCatalog(materializedConfig)
                    .review_types.map(({ id }) => id);
            }

            if (configName === 'token-economy') {
                materializedConfig.enabled = tokenEconomyEnabled;
            }
            if (configName === 'workflow-config') {
                materializedWorkflowConfig = materializedConfig;
                projectMemoryMaintenanceSummaryLine = buildProjectMemoryMaintenanceSummaryLine(
                    normalizeProjectMemoryMaintenanceForDisplay(materializedConfig.project_memory_maintenance)
                );
                optionalQualityChecksNotice = shouldEmitOptionalQualityChecksEnabledNotice({
                    readStatus: workflowConfigReadStatus,
                    existingConfig,
                    materializedConfig
                })
                    ? OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE
                    : null;
            }

            if (!dryRun) {
                preserveExistingConfig = !replaceWithCanonicalTemplate
                    && existingConfig !== null
                    && isDeepStrictEqual(existingConfig, materializedConfig);
                if (!preserveExistingConfig) {
                    pendingWrite = JSON.stringify(materializedConfig, null, 2);
                }
            }

            configMergeStatuses[configName] = configName === 'workflow-config'
                ? buildWorkflowConfigMergeStatus(
                    targetRoot,
                    destConfigPath,
                    workflowConfigReadStatus,
                    existingConfig,
                    materializedConfig
                )
                : replaceWithCanonicalTemplate
                    ? (hadExistingConfig
                        ? 'canonical_template_reapplied_existing_values_replaced'
                        : 'canonical_template_applied')
                    : (existingConfig
                        ? 'existing_values_preserved_and_missing_keys_filled'
                        : 'no_existing_live_config_template_applied');
        } catch {
            configMergeStatuses[configName] = 'merge_failed_template_applied';
        }
        if (preserveExistingConfig) {
            bindContainedDestination(targetRoot, destConfigPath);
        } else if (pendingWrite !== null) {
            writeContainedFile(targetRoot, destConfigPath, pendingWrite);
        }
    }

    return {
        configMergeStatuses,
        materializedWorkflowConfig,
        projectMemoryMaintenanceSummaryLine,
        optionalQualityChecksNotice
    };
}
