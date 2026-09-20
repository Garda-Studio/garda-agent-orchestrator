import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertWorkflowTransactionReadable } from '../../../core/workflow-transaction-state';

import { resolveBundleName } from '../../../core/constants';
import {
    buildDefaultWorkflowConfig,
    hasMaterializedWorkflowConfigBaseline,
    normalizeAutoBackupConfig,
    normalizeCompileGateConfig,
    normalizeOptionalQualityChecksConfig,
    normalizeOrchestratorWorkPolicyConfig,
    normalizeReviewDelegationConfig,
    type AutoBackupConfig,
    type OrchestratorWorkPolicyConfig,
    type OptionalQualityChecksConfig,
    type ProjectMemoryMaintenanceConfig,
    type ReviewDelegationConfig,
    type TaskResetConfig,
    type WorkflowConfigData
} from '../../../core/workflow-config';
import { normalizeScopeBudgetGuardConfig } from '../../../core/scope-budget-guard';
import { normalizeReviewCycleGuardConfig } from '../../../core/review-cycle-guard';
import { validateWorkflowConfig } from '../../../schemas/config-artifacts';
import { normalizePathValue } from '../cli-helpers';
import type {
    ParsedOptionsRecord,
    WorkflowCommandRoots,
    WorkflowConfigState,
    WorkflowFileConfigData
} from './workflow-command-types';

export function resolveWorkflowRoots(options: ParsedOptionsRecord): WorkflowCommandRoots {
    const explicitBundleRoot = typeof options.bundleRoot === 'string'
        ? normalizePathValue(options.bundleRoot)
        : null;
    const targetRoot = typeof options.targetRoot === 'string'
        ? normalizePathValue(options.targetRoot)
        : explicitBundleRoot
            ? path.dirname(explicitBundleRoot)
            : normalizePathValue('.');
    const bundleRoot = explicitBundleRoot ?? path.join(targetRoot, resolveBundleName());
    return {
        targetRoot,
        bundleRoot,
        configPath: path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
        optionalSkillSelectionPolicyPath: path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json')
    };
}

export function cloneProjectMemoryMaintenanceConfig(
    config: ProjectMemoryMaintenanceConfig
): ProjectMemoryMaintenanceConfig {
    return JSON.parse(JSON.stringify(config)) as ProjectMemoryMaintenanceConfig;
}

export function cloneTaskResetConfig(config: TaskResetConfig): TaskResetConfig {
    return JSON.parse(JSON.stringify(config)) as TaskResetConfig;
}

export function cloneReviewDelegationConfig(config: ReviewDelegationConfig): ReviewDelegationConfig {
    return JSON.parse(JSON.stringify(config)) as ReviewDelegationConfig;
}

export function cloneAutoBackupConfig(config: AutoBackupConfig): AutoBackupConfig {
    return JSON.parse(JSON.stringify(config)) as AutoBackupConfig;
}

export function cloneOptionalQualityChecksConfig(
    config: OptionalQualityChecksConfig
): OptionalQualityChecksConfig {
    return JSON.parse(JSON.stringify(config)) as OptionalQualityChecksConfig;
}

export function cloneOrchestratorWorkPolicyConfig(
    config: OrchestratorWorkPolicyConfig
): OrchestratorWorkPolicyConfig {
    return JSON.parse(JSON.stringify(config)) as OrchestratorWorkPolicyConfig;
}

export function normalizeWorkflowFileConfig(config: WorkflowFileConfigData): WorkflowFileConfigData {
    const defaultConfig = buildDefaultWorkflowConfig() as WorkflowConfigData;
    return {
        ...config,
        compile_gate: normalizeCompileGateConfig(config.compile_gate ?? defaultConfig.compile_gate),
        full_suite_validation: config.full_suite_validation,
        review_delegation: cloneReviewDelegationConfig(
            normalizeReviewDelegationConfig(config.review_delegation ?? defaultConfig.review_delegation)
        ),
        scope_budget_guard: normalizeScopeBudgetGuardConfig(config.scope_budget_guard ?? defaultConfig.scope_budget_guard),
        review_cycle_guard: normalizeReviewCycleGuardConfig(config.review_cycle_guard ?? defaultConfig.review_cycle_guard),
        project_memory_maintenance: cloneProjectMemoryMaintenanceConfig(
            config.project_memory_maintenance ?? defaultConfig.project_memory_maintenance
        ),
        task_reset: cloneTaskResetConfig(config.task_reset ?? defaultConfig.task_reset),
        auto_backup: cloneAutoBackupConfig(
            normalizeAutoBackupConfig(config.auto_backup ?? defaultConfig.auto_backup)
        ),
        optional_quality_checks: cloneOptionalQualityChecksConfig(
            normalizeOptionalQualityChecksConfig(config.optional_quality_checks ?? defaultConfig.optional_quality_checks)
        ),
        orchestrator_work_policy: cloneOrchestratorWorkPolicyConfig(
            normalizeOrchestratorWorkPolicyConfig(config.orchestrator_work_policy ?? defaultConfig.orchestrator_work_policy)
        )
    };
}

export function readWorkflowConfigState(configPath: string, bundleRoot: string): WorkflowConfigState {
    assertWorkflowTransactionReadable(bundleRoot);
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        const defaultConfig = buildDefaultWorkflowConfig() as WorkflowConfigData;
        return {
            rawConfig: null,
            config: normalizeWorkflowFileConfig({
                compile_gate: defaultConfig.compile_gate,
                full_suite_validation: defaultConfig.full_suite_validation,
                review_delegation: defaultConfig.review_delegation,
                scope_budget_guard: defaultConfig.scope_budget_guard,
                project_memory_maintenance: defaultConfig.project_memory_maintenance,
                task_reset: defaultConfig.task_reset,
                auto_backup: defaultConfig.auto_backup,
                optional_quality_checks: defaultConfig.optional_quality_checks,
                orchestrator_work_policy: defaultConfig.orchestrator_work_policy
            }),
            exists: false,
            missingReviewExecutionPolicyMode: hasMaterializedWorkflowConfigBaseline(bundleRoot)
                ? 'legacy_test_downstream'
                : defaultConfig.review_execution_policy.mode
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error: unknown) {
        throw new Error(
            `Workflow config at '${configPath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    try {
        const validated = normalizeWorkflowFileConfig(validateWorkflowConfig(parsed) as WorkflowFileConfigData);
        return {
            rawConfig: validated,
            config: validated,
            exists: true,
            missingReviewExecutionPolicyMode: null
        };
    } catch (error: unknown) {
        throw new Error(
            `Workflow config at '${configPath}' is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
