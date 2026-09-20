import * as path from 'node:path';
import { compactSettingsToConfig } from './compact/setting-definitions';
import {
    UNCONFIGURED_COMPILE_GATE_COMMAND,
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND
} from './constants';
import { pathExists } from './filesystem';
import { readJsonFile, writeJsonFile } from './json';
import { assertWorkflowTransactionReadable } from './workflow-transaction-state';
import { cloneJsonValue, isPlainObject, mergeConfig } from './config-merge';
import {
    buildDefaultReviewExecutionPolicyConfig,
    type ReviewExecutionPolicyConfig
} from './review-execution-policy';
import {
    DEFAULT_SCOPE_BUDGET_GUARD_CONFIG,
    normalizeScopeBudgetGuardConfig,
    type ScopeBudgetGuardConfig
} from './scope-budget-guard';
import {
    DEFAULT_REVIEW_CYCLE_GUARD_CONFIG,
    normalizeReviewCycleGuardConfig,
    type ReviewCycleGuardConfig
} from './review-cycle-guard';
import {
    buildDefaultOptionalQualityChecksConfig,
    isExactLegacyOptionalQualityChecksGeneratedDefault,
    mergeOptionalQualityChecksWithBaseline,
    normalizeOptionalQualityChecksConfig,
    type OptionalQualityChecksConfig
} from './optional-quality-checks';
import {
    DEFAULT_REVIEW_DELEGATION_CONFIG,
    type ReviewDelegationConfig
} from './review-delegation-policy';

export {
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES,
    DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
    LEGACY_OPTIONAL_QUALITY_CHECK_RULES,
    MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
    OPS_SHELL_OPTIONAL_QUALITY_CHECK_RULES,
    OPTIONAL_QUALITY_CHECK_SCOPE_CATEGORY_CONFIG_ONLY,
    OPTIONAL_QUALITY_CHECK_SCOPE_CATEGORY_TEST_ONLY,
    OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION,
    OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE,
    OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL_KEY,
    buildOptionalQualityChecksRuleSetDiagnostics,
    buildDefaultOptionalQualityChecksConfig,
    formatOptionalQualityChecksRuleSetDiagnostics,
    getBaselineOptionalQualityCheckRule,
    getOptionalQualityCheckRuleScopeSkipReason,
    isOptionalQualityCheckRuleActiveForScope,
    isOptionalQualityCheckRuleExcludedForScope,
    hasOptionalQualityCheckRuleScopeInclusion,
    isExactLegacyOptionalQualityChecksGeneratedDefault,
    isBaselineOptionalQualityCheckRuleId,
    mergeOptionalQualityChecksWithBaseline,
    normalizeOptionalQualityCheckChangedFileRegexes,
    normalizeOptionalQualityCheckScopeCategories,
    normalizeOptionalQualityChecksConfig,
    resolveOptionalQualityChecksReviewFailureCadenceInterval
} from './optional-quality-checks';
export type {
    OptionalQualityCheckRule,
    OptionalQualityChecksConfig
} from './optional-quality-checks';
export {
    GARDA_NO_DELEGATE_ENV,
    DEFAULT_REVIEW_DELEGATION_CONFIG,
    isTruthyNoDelegateEnvValue,
    normalizeReviewDelegationConfig,
    resolveReviewDelegationConfigPath,
    resolveReviewDelegationPolicy
} from './review-delegation-policy';
export type {
    ReviewDelegationConfig,
    ReviewDelegationPolicyResult,
    ReviewDelegationPolicySource
} from './review-delegation-policy';

export interface FullSuiteValidationConfig {
    enabled: boolean;
    command: string;
    timeout_ms: number;
    timeout_blocker: boolean;
    timeout_retry_count: number;
    green_summary_max_lines: number;
    red_failure_chunk_lines: number;
    out_of_scope_failure_policy: string;
    placement: FullSuiteValidationPlacement;
    [key: string]: unknown;
}

export interface CompileGateConfig {
    command: string;
    [key: string]: unknown;
}

export const FULL_SUITE_VALIDATION_PLACEMENTS = Object.freeze([
    'after_compile_before_reviews',
    'before_test_review',
    'before_completion'
] as const);
export type FullSuiteValidationPlacement = typeof FULL_SUITE_VALIDATION_PLACEMENTS[number];
export const FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX = 3;

export interface NormalizeFullSuiteValidationPlacementOptions {
    rejectInvalidExplicit?: boolean;
    errorPath?: string;
}

export function normalizeFullSuiteValidationPlacement(
    value: unknown,
    options: NormalizeFullSuiteValidationPlacementOptions = {}
): FullSuiteValidationPlacement {
    if (value === undefined) {
        return 'after_compile_before_reviews';
    }
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (FULL_SUITE_VALIDATION_PLACEMENTS.includes(normalized as FullSuiteValidationPlacement)) {
        return normalized as FullSuiteValidationPlacement;
    }
    if (options.rejectInvalidExplicit === true) {
        const pathLabel = options.errorPath || 'full_suite_validation.placement';
        throw new Error(
            `${pathLabel} must be one of: ${[...FULL_SUITE_VALIDATION_PLACEMENTS].join(', ')}.`
        );
    }
    return 'after_compile_before_reviews';
}

export const PROJECT_MEMORY_MAINTENANCE_MODES = Object.freeze(['off', 'check', 'update', 'strict'] as const);
export type ProjectMemoryMaintenanceMode = typeof PROJECT_MEMORY_MAINTENANCE_MODES[number];

export const PROJECT_MEMORY_READ_STRATEGIES = Object.freeze(['index_first'] as const);
export type ProjectMemoryReadStrategy = typeof PROJECT_MEMORY_READ_STRATEGIES[number];

export interface ProjectMemoryMaintenanceConfig {
    enabled: boolean;
    mode: ProjectMemoryMaintenanceMode;
    run_before_final_closeout: boolean;
    require_user_approval_for_writes: boolean;
    max_compact_summary_chars: number;
    read_strategy: ProjectMemoryReadStrategy;
    impact_artifact_retention_days: number;
    [key: string]: unknown;
}

export interface TaskResetConfig {
    enabled: boolean;
    [key: string]: unknown;
}

export interface AutoBackupConfig {
    enabled: boolean;
    interval_days: number;
    keep_latest: number;
    [key: string]: unknown;
}

export const ORCHESTRATOR_WORK_POLICY_MODES = Object.freeze([
    'deny_agent_entry',
    'require_operator_confirmation'
] as const);
export type OrchestratorWorkPolicyMode = typeof ORCHESTRATOR_WORK_POLICY_MODES[number];

const GARDA_SELF_GUARD_POLICY_CHANGE_ARGUMENTS = [
    '--garda-self-guard off',
    '--operator-confirmed yes',
    '--operator-confirmed-at-utc "<ISO-8601 timestamp>"'
] as const;

export interface OrchestratorWorkPolicyConfig {
    mode: OrchestratorWorkPolicyMode;
    [key: string]: unknown;
}

export interface WorkflowConfigData {
    compile_gate: CompileGateConfig;
    full_suite_validation: FullSuiteValidationConfig;
    review_execution_policy: ReviewExecutionPolicyConfig;
    review_delegation: ReviewDelegationConfig;
    scope_budget_guard: ScopeBudgetGuardConfig;
    review_cycle_guard: ReviewCycleGuardConfig;
    project_memory_maintenance: ProjectMemoryMaintenanceConfig;
    task_reset: TaskResetConfig;
    auto_backup: AutoBackupConfig;
    optional_quality_checks: OptionalQualityChecksConfig;
    orchestrator_work_policy: OrchestratorWorkPolicyConfig;
    [key: string]: unknown;
}

export interface WorkflowConfigMergeOptions {
    preserveLegacyReviewExecutionPolicyOmission?: boolean;
    preserveMovedProjectQualityRulesAsCustom?: boolean;
}

export type WorkflowConfigReadStatus = 'present' | 'missing' | 'invalid_json' | 'non_object';

export interface WorkflowConfigReadResult {
    status: WorkflowConfigReadStatus;
    config: Record<string, unknown> | null;
}

function hasOwnCaseInsensitiveKey(record: Record<string, unknown>, expectedKey: string): boolean {
    return findOwnCaseInsensitiveKey(record, expectedKey) !== undefined;
}

function findOwnCaseInsensitiveKey(record: Record<string, unknown>, expectedKey: string): string | undefined {
    return Object.keys(record).find((candidate) => candidate.toLowerCase() === expectedKey.toLowerCase());
}

const DEFAULT_WORKFLOW_CONFIG: WorkflowConfigData = Object.freeze({
    compact: compactSettingsToConfig(),
    compile_gate: Object.freeze({
        command: UNCONFIGURED_COMPILE_GATE_COMMAND
    }),
    full_suite_validation: Object.freeze({
        enabled: false,
        command: UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
        timeout_ms: 900_000,
        timeout_blocker: true,
        timeout_retry_count: 1,
        green_summary_max_lines: 5,
        red_failure_chunk_lines: 50,
        out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
        placement: 'after_compile_before_reviews'
    }),
    review_execution_policy: Object.freeze(buildDefaultReviewExecutionPolicyConfig()),
    review_delegation: DEFAULT_REVIEW_DELEGATION_CONFIG,
    scope_budget_guard: DEFAULT_SCOPE_BUDGET_GUARD_CONFIG,
    review_cycle_guard: DEFAULT_REVIEW_CYCLE_GUARD_CONFIG,
    project_memory_maintenance: Object.freeze({
        enabled: true,
        mode: 'update',
        run_before_final_closeout: true,
        require_user_approval_for_writes: true,
        max_compact_summary_chars: 12000,
        read_strategy: 'index_first',
        impact_artifact_retention_days: 30
    }),
    task_reset: Object.freeze({
        enabled: false
    }),
    auto_backup: Object.freeze({
        enabled: false,
        interval_days: 1,
        keep_latest: 10
    }),
    optional_quality_checks: Object.freeze(buildDefaultOptionalQualityChecksConfig()),
    orchestrator_work_policy: Object.freeze({
        mode: 'deny_agent_entry'
    })
});

const LEGACY_PROJECT_MEMORY_MAINTENANCE_GENERATED_DEFAULT: ProjectMemoryMaintenanceConfig = Object.freeze({
    enabled: false,
    mode: 'check',
    run_before_final_closeout: true,
    require_user_approval_for_writes: true,
    max_compact_summary_chars: 12000,
    read_strategy: 'index_first',
    impact_artifact_retention_days: 30
});

const LEGACY_SCOPE_BUDGET_GUARD_GENERATED_DEFAULT = Object.freeze({
    enabled: true,
    profiles: ['strict'],
    action: 'BLOCK_FOR_SPLIT',
    max_files: 12,
    max_changed_lines: 1200,
    max_required_reviews: 5,
    max_review_tokens: 50000
} as const);

const LEGACY_REVIEW_CYCLE_GUARD_GENERATED_DEFAULT: ReviewCycleGuardConfig = Object.freeze({
    enabled: true,
    action: 'BLOCK_FOR_OPERATOR_DECISION',
    max_failed_non_test_reviews: 15,
    max_total_non_test_reviews: 15,
    excluded_review_types: ['test'],
    auto_split_enabled: false
});

const PREVIOUS_REVIEW_CYCLE_GUARD_GENERATED_DEFAULT: ReviewCycleGuardConfig = Object.freeze({
    enabled: true,
    action: 'BLOCK_FOR_OPERATOR_DECISION',
    max_failed_non_test_reviews: 15,
    max_total_non_test_reviews: 30,
    excluded_review_types: ['test'],
    auto_split_enabled: true
});

export function buildDefaultWorkflowConfig(): WorkflowConfigData {
    return cloneJsonValue(DEFAULT_WORKFLOW_CONFIG);
}

export function isConfiguredCompileGateCommand(command: unknown): command is string {
    const value = typeof command === 'string' ? command.trim() : '';
    return Boolean(value) && value !== UNCONFIGURED_COMPILE_GATE_COMMAND;
}

export function normalizeCompileGateConfig(input: unknown): CompileGateConfig {
    if (!isPlainObject(input)) {
        return cloneJsonValue(DEFAULT_WORKFLOW_CONFIG.compile_gate);
    }
    const command = typeof input.command === 'string'
        ? input.command.trim()
        : DEFAULT_WORKFLOW_CONFIG.compile_gate.command;
    return {
        ...cloneJsonValue(input),
        command: command || DEFAULT_WORKFLOW_CONFIG.compile_gate.command
    };
}

export function normalizeOrchestratorWorkPolicyConfig(input: unknown): OrchestratorWorkPolicyConfig {
    if (!isPlainObject(input)) {
        return cloneJsonValue(DEFAULT_WORKFLOW_CONFIG.orchestrator_work_policy);
    }
    const rawMode = typeof input.mode === 'string'
        ? input.mode.trim().toLowerCase()
        : DEFAULT_WORKFLOW_CONFIG.orchestrator_work_policy.mode;
    const mode = ORCHESTRATOR_WORK_POLICY_MODES.includes(rawMode as OrchestratorWorkPolicyMode)
        ? rawMode as OrchestratorWorkPolicyMode
        : DEFAULT_WORKFLOW_CONFIG.orchestrator_work_policy.mode;
    return {
        ...cloneJsonValue(input),
        mode
    };
}

export function normalizeAutoBackupConfig(input: unknown): AutoBackupConfig {
    if (!isPlainObject(input)) {
        return cloneJsonValue(DEFAULT_WORKFLOW_CONFIG.auto_backup);
    }
    const intervalDays = typeof input.interval_days === 'number' && Number.isInteger(input.interval_days) && input.interval_days >= 1
        ? input.interval_days
        : DEFAULT_WORKFLOW_CONFIG.auto_backup.interval_days;
    const keepLatest = typeof input.keep_latest === 'number' && Number.isInteger(input.keep_latest) && input.keep_latest >= 1
        ? input.keep_latest
        : DEFAULT_WORKFLOW_CONFIG.auto_backup.keep_latest;
    return {
        ...cloneJsonValue(input),
        enabled: input.enabled === true,
        interval_days: intervalDays,
        keep_latest: keepLatest
    };
}

export function shouldEmitOptionalQualityChecksEnabledNotice(options: {
    readStatus: WorkflowConfigReadStatus;
    existingConfig: Record<string, unknown> | null;
    materializedConfig: Record<string, unknown>;
}): boolean {
    const optionalQualityChecks = normalizeOptionalQualityChecksConfig(options.materializedConfig.optional_quality_checks);
    if (!optionalQualityChecks.enabled) {
        return false;
    }
    if (options.readStatus !== 'present' || !isPlainObject(options.existingConfig)) {
        return true;
    }
    return !hasOwnCaseInsensitiveKey(options.existingConfig, 'optional_quality_checks');
}

export function readOrchestratorWorkPolicyModeForBundle(bundleRoot: string): OrchestratorWorkPolicyMode {
    assertWorkflowTransactionReadable(bundleRoot);
    const workflowConfigPath = getWorkflowConfigPath(bundleRoot);
    if (!pathExists(workflowConfigPath)) {
        return DEFAULT_WORKFLOW_CONFIG.orchestrator_work_policy.mode;
    }
    try {
        const parsed = readJsonFile(workflowConfigPath);
        if (!isPlainObject(parsed)) {
            return DEFAULT_WORKFLOW_CONFIG.orchestrator_work_policy.mode;
        }
        return normalizeOrchestratorWorkPolicyConfig(parsed.orchestrator_work_policy).mode;
    } catch {
        return DEFAULT_WORKFLOW_CONFIG.orchestrator_work_policy.mode;
    }
}

export function isGardaSelfGuardDenyAgentEntryForBundle(
    isOrchestratorSourceCheckout: boolean,
    bundleRoot: string
): boolean {
    return !isOrchestratorSourceCheckout
        && readOrchestratorWorkPolicyModeForBundle(bundleRoot) === 'deny_agent_entry';
}

export function buildGardaSelfGuardPolicyChangeCommand(cliPrefix: string, includeTargetRoot = true): string {
    return [
        `${cliPrefix} workflow set`,
        ...GARDA_SELF_GUARD_POLICY_CHANGE_ARGUMENTS,
        ...(includeTargetRoot ? ['--target-root "."'] : [])
    ].join(' ');
}

export function buildGardaSelfGuardPolicyChangeReference(): string {
    return [
        'workflow set',
        ...GARDA_SELF_GUARD_POLICY_CHANGE_ARGUMENTS
    ].join(' ');
}

export function formatGardaSelfGuardProtectedControlPlaneGuidance(options: {
    protectedFiles?: readonly string[];
    includeWorkflowConfigWork?: boolean;
    policyChangeReference?: string;
} = {}): string {
    const protectedFiles = options.protectedFiles || [];
    const protectedFileText = protectedFiles.length > 0
        ? ` Planned protected files: ${protectedFiles.join(', ')}.`
        : '';
    const protectedModes = options.includeWorkflowConfigWork
        ? '--orchestrator-work or --workflow-config-work'
        : '--orchestrator-work';
    const policyChangeReference = options.policyChangeReference || buildGardaSelfGuardPolicyChangeReference();

    return (
        `Garda self-guard is on for this application workspace: agents cannot enter ${protectedModes} for protected Garda control-plane edits.` +
        protectedFileText +
        ` Route this to an operator-owned update, repair, or maintenance flow, or have the operator deliberately relax the policy with ${policyChangeReference}.`
    );
}

export function getWorkflowConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
}

export function hasMaterializedWorkflowConfigBaseline(bundleRoot: string): boolean {
    return pathExists(path.join(bundleRoot, 'live', 'version.json'));
}

function getWorkflowConfigTemplatePath(bundleRoot: string): string {
    return path.join(bundleRoot, 'template', 'config', 'workflow-config.json');
}

function warnWorkflowConfigTemplateFallback(templatePath: string, reason: string): void {
    process.stderr.write(
        `WARNING: WORKFLOW_CONFIG_TEMPLATE_FALLBACK: path=${templatePath.replace(/\\/g, '/')}; reason=${reason}; using built-in defaults.\n`
    );
}

function readWorkflowConfigTemplate(bundleRoot: string): WorkflowConfigData {
    const templatePath = getWorkflowConfigTemplatePath(bundleRoot);
    if (!pathExists(templatePath)) {
        return buildDefaultWorkflowConfig();
    }

    try {
        const parsed = readJsonFile(templatePath);
        if (!isPlainObject(parsed)) {
            warnWorkflowConfigTemplateFallback(templatePath, 'non_object_template');
            return buildDefaultWorkflowConfig();
        }
        return mergeConfig(buildDefaultWorkflowConfig(), parsed) as WorkflowConfigData;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        warnWorkflowConfigTemplateFallback(templatePath, `invalid_json_template:${message}`);
        return buildDefaultWorkflowConfig();
    }
}

export function isExactLegacyProjectMemoryGeneratedDefault(input: unknown): boolean {
    if (!isPlainObject(input)) {
        return false;
    }

    const expected = LEGACY_PROJECT_MEMORY_MAINTENANCE_GENERATED_DEFAULT as Record<string, unknown>;
    const actualKeys = Object.keys(input).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.length !== expectedKeys.length) {
        return false;
    }

    return expectedKeys.every((key, index) => actualKeys[index] === key && input[key] === expected[key]);
}

export function isExactLegacyScopeBudgetGuardGeneratedDefault(input: unknown): boolean {
    if (!isPlainObject(input)) {
        return false;
    }

    const expected = LEGACY_SCOPE_BUDGET_GUARD_GENERATED_DEFAULT as unknown as Record<string, unknown>;
    const actualKeys = Object.keys(input).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.length !== expectedKeys.length) {
        return false;
    }
    if (!expectedKeys.every((key, index) => actualKeys[index] === key)) {
        return false;
    }

    return input.enabled === expected.enabled
        && input.action === expected.action
        && input.max_files === expected.max_files
        && input.max_changed_lines === expected.max_changed_lines
        && input.max_required_reviews === expected.max_required_reviews
        && input.max_review_tokens === expected.max_review_tokens
        && Array.isArray(input.profiles)
        && input.profiles.length === 1
        && input.profiles[0] === 'strict';
}

export function isExactLegacyReviewCycleGuardGeneratedDefault(input: unknown): boolean {
    if (!isPlainObject(input)) {
        return false;
    }

    return [
        LEGACY_REVIEW_CYCLE_GUARD_GENERATED_DEFAULT,
        PREVIOUS_REVIEW_CYCLE_GUARD_GENERATED_DEFAULT
    ].some((candidate) => {
        const expected = candidate as unknown as Record<string, unknown>;
        const actualKeys = Object.keys(input).sort();
        const expectedKeys = Object.keys(expected).sort();
        return actualKeys.length === expectedKeys.length
            && expectedKeys.every((key, index) => actualKeys[index] === key)
            && input.enabled === expected.enabled
            && input.action === expected.action
            && input.max_failed_non_test_reviews === expected.max_failed_non_test_reviews
            && input.max_total_non_test_reviews === expected.max_total_non_test_reviews
            && Array.isArray(input.excluded_review_types)
            && input.excluded_review_types.length === 1
            && input.excluded_review_types[0] === 'test'
            && input.auto_split_enabled === expected.auto_split_enabled;
    });
}

function migrateLegacyProjectMemoryGeneratedDefault(
    existingConfig: Record<string, unknown> | null
): Record<string, unknown> | null {
    if (!isPlainObject(existingConfig)) {
        return existingConfig;
    }

    const projectMemoryKey = findOwnCaseInsensitiveKey(existingConfig, 'project_memory_maintenance');
    if (
        projectMemoryKey === undefined
        || !isExactLegacyProjectMemoryGeneratedDefault(existingConfig[projectMemoryKey])
    ) {
        return existingConfig;
    }

    const migrated = cloneJsonValue(existingConfig);
    delete migrated[projectMemoryKey];
    return migrated;
}

function migrateLegacyScopeBudgetGuardGeneratedDefault(
    existingConfig: Record<string, unknown> | null
): Record<string, unknown> | null {
    if (!isPlainObject(existingConfig)) {
        return existingConfig;
    }

    const scopeBudgetKey = findOwnCaseInsensitiveKey(existingConfig, 'scope_budget_guard');
    if (
        scopeBudgetKey === undefined
        || !isExactLegacyScopeBudgetGuardGeneratedDefault(existingConfig[scopeBudgetKey])
    ) {
        return existingConfig;
    }

    const migrated = cloneJsonValue(existingConfig);
    delete migrated[scopeBudgetKey];
    return migrated;
}

function hasTieredScopeBudgetGuardKeys(input: Record<string, unknown>): boolean {
    return [
        'warn_files',
        'block_files',
        'warn_changed_lines',
        'block_changed_lines',
        'warn_required_reviews',
        'block_required_reviews',
        'warn_review_tokens',
        'block_review_tokens'
    ].some((key) => Object.prototype.hasOwnProperty.call(input, key));
}

function migrateLegacyScopeBudgetGuardShape(
    existingConfig: Record<string, unknown> | null
): Record<string, unknown> | null {
    if (!isPlainObject(existingConfig)) {
        return existingConfig;
    }

    const scopeBudgetKey = findOwnCaseInsensitiveKey(existingConfig, 'scope_budget_guard');
    if (scopeBudgetKey === undefined || !isPlainObject(existingConfig[scopeBudgetKey])) {
        return existingConfig;
    }
    const scopeBudgetGuard = existingConfig[scopeBudgetKey] as Record<string, unknown>;
    if (hasTieredScopeBudgetGuardKeys(scopeBudgetGuard)) {
        return existingConfig;
    }

    const migrated = cloneJsonValue(existingConfig);
    migrated[scopeBudgetKey] = normalizeScopeBudgetGuardConfig(scopeBudgetGuard);
    return migrated;
}

function migrateLegacyReviewCycleGuardGeneratedDefault(
    existingConfig: Record<string, unknown> | null
): Record<string, unknown> | null {
    if (!isPlainObject(existingConfig)) {
        return existingConfig;
    }

    const reviewCycleKey = findOwnCaseInsensitiveKey(existingConfig, 'review_cycle_guard');
    if (
        reviewCycleKey === undefined
        || !isExactLegacyReviewCycleGuardGeneratedDefault(existingConfig[reviewCycleKey])
    ) {
        return existingConfig;
    }

    const migrated = cloneJsonValue(existingConfig);
    delete migrated[reviewCycleKey];
    return migrated;
}

function migrateLegacyOptionalQualityChecksGeneratedDefault(
    existingConfig: Record<string, unknown> | null
): Record<string, unknown> | null {
    if (!isPlainObject(existingConfig)) {
        return existingConfig;
    }

    const optionalChecksKey = findOwnCaseInsensitiveKey(existingConfig, 'optional_quality_checks');
    if (
        optionalChecksKey === undefined
        || !isExactLegacyOptionalQualityChecksGeneratedDefault(existingConfig[optionalChecksKey])
    ) {
        return existingConfig;
    }

    const migrated = cloneJsonValue(existingConfig);
    const migratedOptionalChecks = cloneJsonValue(migrated[optionalChecksKey]);
    if (isPlainObject(migratedOptionalChecks)) {
        delete migratedOptionalChecks.rules;
        delete migratedOptionalChecks.baseline_version;
        migrated[optionalChecksKey] = migratedOptionalChecks;
    }
    return migrated;
}

function resolveOptionalQualityChecksForMerge(existingConfig: Record<string, unknown> | null): unknown {
    if (!isPlainObject(existingConfig)) {
        return undefined;
    }
    const optionalChecksKey = findOwnCaseInsensitiveKey(existingConfig, 'optional_quality_checks');
    return optionalChecksKey === undefined
        ? undefined
        : existingConfig[optionalChecksKey];
}

export function buildWorkflowConfigReviewCycleLimitDiagnostic(
    readStatus: WorkflowConfigReadStatus,
    existingConfig: Record<string, unknown> | null,
    materializedConfig: Record<string, unknown>
): string {
    const reviewCycleGuard = normalizeReviewCycleGuardConfig(materializedConfig.review_cycle_guard);
    let limitStatus = 'template_default_applied';
    if (readStatus === 'present' && isPlainObject(existingConfig)) {
        const reviewCycleKey = findOwnCaseInsensitiveKey(existingConfig, 'review_cycle_guard');
        if (reviewCycleKey === undefined) {
            limitStatus = 'missing_keys_filled_from_template';
        } else if (isExactLegacyReviewCycleGuardGeneratedDefault(existingConfig[reviewCycleKey])) {
            limitStatus = 'migrated_from_old_default';
        } else {
            limitStatus = 'custom_preserved';
        }
    }

    return [
        `review_cycle_guard.max_failed_non_test_reviews=${reviewCycleGuard.max_failed_non_test_reviews}`,
        `review_cycle_guard.max_total_non_test_reviews=${reviewCycleGuard.max_total_non_test_reviews}`,
        `review_cycle_guard.limit_status=${limitStatus}`
    ].join(' ');
}

export function mergeWorkflowConfigWithTemplate(
    templateConfig: WorkflowConfigData,
    existingConfig: Record<string, unknown> | null,
    options: WorkflowConfigMergeOptions = {}
): Record<string, unknown> {
    const existingConfigForMerge = migrateLegacyOptionalQualityChecksGeneratedDefault(
        migrateLegacyReviewCycleGuardGeneratedDefault(
            migrateLegacyScopeBudgetGuardShape(
                migrateLegacyScopeBudgetGuardGeneratedDefault(
                    migrateLegacyProjectMemoryGeneratedDefault(existingConfig)
                )
            )
        )
    );
    const nextConfig = mergeConfig(templateConfig, existingConfigForMerge);
    const existingConfigOmittedReviewExecutionPolicy = isPlainObject(existingConfig)
        && !hasOwnCaseInsensitiveKey(existingConfig, 'review_execution_policy');
    const preserveMissingConfigLegacyOmission = existingConfig === null
        && options.preserveLegacyReviewExecutionPolicyOmission === true;

    if (existingConfigOmittedReviewExecutionPolicy || preserveMissingConfigLegacyOmission) {
        delete nextConfig.review_execution_policy;
    }
    nextConfig.optional_quality_checks = mergeOptionalQualityChecksWithBaseline(
        templateConfig.optional_quality_checks,
        resolveOptionalQualityChecksForMerge(existingConfigForMerge),
        {
            preserveMovedProjectRulesAsCustom: options.preserveMovedProjectQualityRulesAsCustom === true
        }
    );
    return nextConfig;
}

export function readWorkflowConfigForMerge(workflowConfigPath: string): WorkflowConfigReadResult {
    assertWorkflowTransactionReadable(path.dirname(path.dirname(path.dirname(workflowConfigPath))));
    if (!pathExists(workflowConfigPath)) {
        return { status: 'missing', config: null };
    }

    try {
        const parsed = readJsonFile(workflowConfigPath);
        if (!isPlainObject(parsed)) {
            return { status: 'non_object', config: null };
        }
        return { status: 'present', config: parsed };
    } catch {
        return { status: 'invalid_json', config: null };
    }
}

export function syncWorkflowConfigWithTemplate(
    bundleRoot: string,
    options: WorkflowConfigMergeOptions = {}
): Record<string, unknown> {
    const workflowConfigPath = getWorkflowConfigPath(bundleRoot);
    const templateConfig = readWorkflowConfigTemplate(bundleRoot);
    const existingConfig = readWorkflowConfigForMerge(workflowConfigPath).config;

    const nextConfig = mergeWorkflowConfigWithTemplate(templateConfig, existingConfig, options);
    writeJsonFile(workflowConfigPath, nextConfig);
    return nextConfig;
}
