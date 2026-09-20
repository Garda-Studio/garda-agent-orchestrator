import * as fs from 'node:fs';
import * as path from 'node:path';
import { withWorkflowConfigTransaction } from './workflow-command-transaction';
import type { RecoverableFileTransaction } from '../../../core/recoverable-file-transaction';

import { isRecognizedBundleName } from '../../../core/constants';
import {
    buildDefaultWorkflowConfig,
    FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX,
    MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
    OPTIONAL_QUALITY_CHECK_SCOPE_CATEGORY_TEST_ONLY,
    OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION,
    getBaselineOptionalQualityCheckRule,
    hasMaterializedWorkflowConfigBaseline,
    isBaselineOptionalQualityCheckRuleId,
    normalizeAutoBackupConfig,
    normalizeCompileGateConfig,
    normalizeOptionalQualityCheckScopeCategories,
    normalizeOptionalQualityChecksConfig,
    normalizeOrchestratorWorkPolicyConfig,
    normalizeReviewDelegationConfig,
    type OptionalQualityCheckRule,
    type WorkflowConfigData
} from '../../../core/workflow-config';
import { normalizeReviewExecutionPolicyMode } from '../../../core/review-execution-policy';
import { normalizeScopeBudgetGuardConfig } from '../../../core/scope-budget-guard';
import { normalizeReviewCycleGuardConfig } from '../../../core/review-cycle-guard';
import { validateManagedConfigByName, validateWorkflowConfig } from '../../../schemas/config-artifacts';
import {
    DEFAULT_POLICY_CONFIG,
    type CanonicalOptionalSkillSelectionPolicyMode
} from '../../../runtime/optional-skill-selection';
import {
    cloneOrchestratorWorkPolicyConfig,
    cloneAutoBackupConfig,
    cloneOptionalQualityChecksConfig,
    cloneProjectMemoryMaintenanceConfig,
    cloneReviewDelegationConfig,
    cloneTaskResetConfig,
    normalizeWorkflowFileConfig,
    readWorkflowConfigState,
    resolveWorkflowRoots
} from './workflow-command-state';
import {
    buildWorkflowShowResult,
    formatWorkflowSetSummaryOutput,
    formatWorkflowShowOutput,
    isConfiguredCompileGateCommand
} from './workflow-command-rendering';
import {
    parseBooleanText,
    parseFullSuitePlacement,
    parseIntegerText,
    parseOutOfScopeFailurePolicy,
    parseProfileList,
    parseProjectMemoryMaintenanceMode,
    parseProjectMemoryReadStrategy,
    parseReviewCycleAction,
    parseReviewTypeList,
    parseScopeBudgetAction,
    parseGardaSelfGuardMode,
    parseOptionalSkillSelectionPolicyMode,
    requireWorkflowSetOperatorConfirmation,
    resolveBooleanSettingOption,
    validateWorkflowCompileGateCommand
} from './workflow-command-parsing';
import {
    normalizeOutputPath,
    normalizeWorkflowConfigMutationSource,
    refreshWorkflowProtectedManifest,
    resolveActualChangedFields,
    writeWorkflowConfig,
    writeWorkflowConfigAuditRecord
} from './workflow-command-mutation';
import type {
    ParsedOptionsRecord,
    WorkflowFileConfigData,
    WorkflowSetResult
} from './workflow-command-types';

function resolveProtectedManifestRefreshRoot(roots: ReturnType<typeof resolveWorkflowRoots>): string {
    return isRecognizedBundleName(path.basename(roots.bundleRoot))
        ? roots.targetRoot
        : roots.bundleRoot;
}

function parseOptionalCheckRuleId(value: string, flagName: string): string {
    const id = value.trim().toLowerCase();
    if (!id) {
        throw new Error(`${flagName} must not be empty.`);
    }
    return id;
}

function parseOptionalCheckRuleText(value: unknown, flagName: string): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const text = value.trim();
    if (!text) {
        throw new Error(`${flagName} must not be empty.`);
    }
    return text;
}

function hasOwn(value: Record<string, unknown> | null, key: string): boolean {
    return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function applyOptionalCheckRuleScopeOptions(
    rule: OptionalQualityCheckRule,
    existing: OptionalQualityCheckRule | null,
    options: ParsedOptionsRecord
): OptionalQualityCheckRule {
    let nextRule = rule;
    if (existing) {
        nextRule = { ...nextRule };
        if (hasOwn(existing, 'excluded_scope_categories')) {
            nextRule.excluded_scope_categories = normalizeOptionalQualityCheckScopeCategories(existing.excluded_scope_categories);
        }
    }
    if (typeof options.optionalCheckRuleExcludeTestOnly !== 'string') {
        return nextRule;
    }
    const excludedScopeCategories = new Set(
        normalizeOptionalQualityCheckScopeCategories(nextRule.excluded_scope_categories)
    );
    const excludeTestOnly = parseBooleanText(
        options.optionalCheckRuleExcludeTestOnly,
        '--optional-check-rule-exclude-test-only'
    );
    if (excludeTestOnly) {
        excludedScopeCategories.add(OPTIONAL_QUALITY_CHECK_SCOPE_CATEGORY_TEST_ONLY);
    } else {
        excludedScopeCategories.delete(OPTIONAL_QUALITY_CHECK_SCOPE_CATEGORY_TEST_ONLY);
    }
    return {
        ...nextRule,
        excluded_scope_categories: [...excludedScopeCategories].sort()
    };
}

function upsertOptionalCheckRule(
    rules: OptionalQualityCheckRule[],
    options: ParsedOptionsRecord
): OptionalQualityCheckRule[] {
    if (typeof options.optionalCheckRuleId !== 'string') {
        return rules;
    }
    const id = parseOptionalCheckRuleId(options.optionalCheckRuleId, '--optional-check-rule-id');
    const existingIndex = rules.findIndex((rule) => rule.id.toLowerCase() === id);
    const existing = existingIndex >= 0 ? rules[existingIndex] : null;
    const baselineRule = getBaselineOptionalQualityCheckRule(id);
    if (baselineRule) {
        const requestedTitle = parseOptionalCheckRuleText(options.optionalCheckRuleTitle, '--optional-check-rule-title');
        const requestedPrompt = parseOptionalCheckRuleText(options.optionalCheckRulePrompt, '--optional-check-rule-prompt');
        const currentTitle = existing?.title || baselineRule.title;
        const currentPrompt = existing?.prompt || baselineRule.prompt;
        if (
            (requestedTitle !== null && requestedTitle !== currentTitle)
            || (requestedPrompt !== null && requestedPrompt !== currentPrompt)
        ) {
            throw new Error(`Baseline optional quality-check rule '${id}' can only change enabled state and scope exclusions.`);
        }
        const enabled = typeof options.optionalCheckRuleEnabled === 'string'
            ? parseBooleanText(options.optionalCheckRuleEnabled, '--optional-check-rule-enabled')
            : existing?.enabled !== false;
        const nextRule = applyOptionalCheckRuleScopeOptions({
            ...baselineRule,
            ...(existing || {}),
            id,
            title: currentTitle,
            prompt: currentPrompt,
            enabled
        }, existing, options);
        if (existingIndex >= 0) {
            return rules.map((rule, index) => index === existingIndex ? nextRule : rule);
        }
        return [...rules, nextRule];
    }
    const title = parseOptionalCheckRuleText(options.optionalCheckRuleTitle, '--optional-check-rule-title')
        ?? existing?.title;
    const prompt = parseOptionalCheckRuleText(options.optionalCheckRulePrompt, '--optional-check-rule-prompt')
        ?? existing?.prompt;
    if (!title) {
        throw new Error('--optional-check-rule-title is required when adding a new optional quality-check rule.');
    }
    if (!prompt) {
        throw new Error('--optional-check-rule-prompt is required when adding a new optional quality-check rule.');
    }
    const enabled = typeof options.optionalCheckRuleEnabled === 'string'
        ? parseBooleanText(options.optionalCheckRuleEnabled, '--optional-check-rule-enabled')
        : existing?.enabled !== false;
    const nextRule = applyOptionalCheckRuleScopeOptions({
        ...(existing || {}),
        id,
        title,
        prompt,
        enabled
    }, existing, options);
    if (existingIndex >= 0) {
        return rules.map((rule, index) => index === existingIndex ? nextRule : rule);
    }
    return [...rules, nextRule];
}

function deleteOptionalCheckRule(
    rules: OptionalQualityCheckRule[],
    options: ParsedOptionsRecord
): OptionalQualityCheckRule[] {
    if (typeof options.optionalCheckRuleDelete !== 'string') {
        return rules;
    }
    const id = parseOptionalCheckRuleId(options.optionalCheckRuleDelete, '--optional-check-rule-delete');
    if (isBaselineOptionalQualityCheckRuleId(id)) {
        throw new Error(`Baseline optional quality-check rule '${id}' cannot be deleted. Disable it instead.`);
    }
    const nextRules = rules.filter((rule) => rule.id.toLowerCase() !== id);
    if (nextRules.length === rules.length) {
        throw new Error(`Optional quality-check rule '${id}' does not exist.`);
    }
    if (nextRules.length === 0) {
        throw new Error('optional_quality_checks.rules must contain at least one rule.');
    }
    return nextRules;
}

function serializeManagedConfig(config: Record<string, unknown>): string {
    return JSON.stringify(config, null, 2) + '\n';
}

function readOptionalSkillSelectionPolicyForSet(policyPath: string): {
    exists: boolean;
    validatedConfig: Record<string, unknown> | null;
    serializedConfig: string | null;
} {
    if (!fs.existsSync(policyPath) || !fs.statSync(policyPath).isFile()) {
        return {
            exists: false,
            validatedConfig: null,
            serializedConfig: null
        };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    } catch (error: unknown) {
        throw new Error(
            `Optional skill selection policy at '${policyPath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    try {
        const validatedConfig = validateManagedConfigByName(
            'optional-skill-selection-policy',
            parsed
        ) as Record<string, unknown>;
        return {
            exists: true,
            validatedConfig,
            serializedConfig: serializeManagedConfig(validatedConfig)
        };
    } catch (error: unknown) {
        throw new Error(
            `Optional skill selection policy at '${policyPath}' is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function buildNextOptionalSkillSelectionPolicyConfig(
    currentConfig: Record<string, unknown> | null,
    mode: CanonicalOptionalSkillSelectionPolicyMode
): Record<string, unknown> {
    const baseConfig = currentConfig
        ? JSON.parse(JSON.stringify(currentConfig)) as Record<string, unknown>
        : { ...DEFAULT_POLICY_CONFIG };
    if (!Number.isInteger(Number(baseConfig.version))) {
        baseConfig.version = DEFAULT_POLICY_CONFIG.version;
    }
    baseConfig.mode = mode;
    return validateManagedConfigByName('optional-skill-selection-policy', baseConfig) as Record<string, unknown>;
}

function applyLegacyScopeBudgetLimit(
    guard: ReturnType<typeof normalizeScopeBudgetGuardConfig>,
    metric: {
        legacyKey: 'max_files' | 'max_changed_lines' | 'max_required_reviews' | 'max_review_tokens';
        warningKey: 'warn_files' | 'warn_changed_lines' | 'warn_required_reviews' | 'warn_review_tokens';
        blockingKey: 'block_files' | 'block_changed_lines' | 'block_required_reviews' | 'block_review_tokens';
    },
    value: number
): void {
    guard[metric.legacyKey] = value;
    if (guard.action === 'BLOCK_FOR_SPLIT') {
        guard[metric.blockingKey] = value;
        if (guard[metric.warningKey] >= value && value > 1) {
            guard[metric.warningKey] = value - 1;
        }
        return;
    }
    guard[metric.warningKey] = value;
    if (guard[metric.blockingKey] <= value) {
        guard[metric.blockingKey] = value + 1;
    }
}

export function handleSet(options: ParsedOptionsRecord): WorkflowSetResult {
    const roots = resolveWorkflowRoots(options);
    const result = withWorkflowConfigTransaction(roots, resolveProtectedManifestRefreshRoot(roots), (transaction) => (
        handleSetLocked(options, transaction)
    ));
    console.log(formatWorkflowShowOutput(result, options.json === true));
    if (options.json !== true) console.log(formatWorkflowSetSummaryOutput(result));
    return result;
}

function handleSetLocked(options: ParsedOptionsRecord, transaction: RecoverableFileTransaction): WorkflowSetResult {
    const roots = resolveWorkflowRoots(options);
    const state = readWorkflowConfigState(roots.configPath, roots.bundleRoot);
    const preserveLegacyMissingReviewExecutionPolicy = !state.exists
        && hasMaterializedWorkflowConfigBaseline(roots.bundleRoot)
        && typeof options.reviewExecutionPolicy !== 'string';
    const mutableBaseConfig = state.rawConfig
        ?? (preserveLegacyMissingReviewExecutionPolicy
            ? { full_suite_validation: state.config.full_suite_validation }
            : buildDefaultWorkflowConfig());
    const nextConfig = normalizeWorkflowFileConfig(JSON.parse(JSON.stringify(
        mutableBaseConfig
    )) as WorkflowFileConfigData);
    const nextFullSuiteValidation = JSON.parse(
        JSON.stringify(state.config.full_suite_validation)
    ) as WorkflowConfigData['full_suite_validation'];
    const nextCompileGate = normalizeCompileGateConfig(nextConfig.compile_gate);
    const changedFields: string[] = [];
    const optionalSkillSelectionPolicyFields: string[] = [];
    let optionalSkillSelectionPolicyExists = false;
    let optionalSkillSelectionPolicyCurrentSerialized: string | null = null;
    let optionalSkillSelectionPolicyNextConfig: Record<string, unknown> | null = null;
    let optionalSkillSelectionPolicyNextSerialized: string | null = null;
    const fullSuiteEnabledSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'fullSuiteEnabled',
        aliasKey: 'fullSuiteAlias',
        canonicalFlag: '--full-suite-enabled',
        aliasFlag: '--full-suite'
    });
    const scopeBudgetEnabledSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'scopeBudgetEnabled',
        aliasKey: 'scopeBudgetAlias',
        canonicalFlag: '--scope-budget-enabled',
        aliasFlag: '--scope-budget'
    });
    const noDelegateSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'reviewDelegationNoDelegate',
        aliasKey: 'noDelegateAlias',
        canonicalFlag: '--review-delegation-no-delegate',
        aliasFlag: '--no-delegate'
    });
    const reviewCycleEnabledSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'reviewCycleEnabled',
        aliasKey: 'reviewCycleAlias',
        canonicalFlag: '--review-cycle-enabled',
        aliasFlag: '--review-cycle'
    });
    const reviewCycleAutoSplitSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'reviewCycleAutoSplitEnabled',
        aliasKey: 'reviewCycleAutoSplitAlias',
        canonicalFlag: '--review-cycle-auto-split-enabled',
        aliasFlag: '--review-cycle-auto-split'
    });
    const projectMemoryEnabledSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'projectMemoryEnabled',
        aliasKey: 'projectMemoryAlias',
        canonicalFlag: '--project-memory-enabled',
        aliasFlag: '--project-memory'
    });
    const taskResetEnabledSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'taskResetEnabled',
        aliasKey: 'taskResetAlias',
        canonicalFlag: '--task-reset-enabled',
        aliasFlag: '--task-reset'
    });
    const autoBackupEnabledSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'autoBackupEnabled',
        aliasKey: 'autoBackupAlias',
        canonicalFlag: '--auto-backup-enabled',
        aliasFlag: '--auto-backup'
    });
    const optionalChecksEnabledSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'optionalChecksEnabled',
        aliasKey: 'optionalChecksAlias',
        canonicalFlag: '--optional-checks-enabled',
        aliasFlag: '--optional-checks'
    });

    if (fullSuiteEnabledSetting) {
        nextFullSuiteValidation.enabled = parseBooleanText(
            fullSuiteEnabledSetting.value,
            fullSuiteEnabledSetting.flagName
        );
        changedFields.push('full_suite_validation.enabled');
    }
    if (typeof options.fullSuiteCommand === 'string') {
        const command = options.fullSuiteCommand.trim();
        if (!command) {
            throw new Error('--full-suite-command must not be empty.');
        }
        nextFullSuiteValidation.command = command;
        changedFields.push('full_suite_validation.command');
    }
    if (typeof options.compileGateCommand === 'string') {
        const command = options.compileGateCommand.trim();
        if (!command) {
            throw new Error('--compile-gate-command must not be empty.');
        }
        validateWorkflowCompileGateCommand(command, nextFullSuiteValidation.command);
        nextCompileGate.command = command;
        changedFields.push('compile_gate.command');
    }
    if (typeof options.fullSuiteTimeoutMs === 'string') {
        nextFullSuiteValidation.timeout_ms = parseIntegerText(
            options.fullSuiteTimeoutMs,
            '--full-suite-timeout-ms',
            1000
        );
        changedFields.push('full_suite_validation.timeout_ms');
    }
    if (typeof options.fullSuiteTimeoutBlocker === 'string') {
        nextFullSuiteValidation.timeout_blocker = parseBooleanText(
            options.fullSuiteTimeoutBlocker,
            '--full-suite-timeout-blocker'
        );
        changedFields.push('full_suite_validation.timeout_blocker');
    }
    if (typeof options.fullSuiteTimeoutRetryCount === 'string') {
        nextFullSuiteValidation.timeout_retry_count = parseIntegerText(
            options.fullSuiteTimeoutRetryCount,
            '--full-suite-timeout-retry-count',
            0,
            FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX
        );
        changedFields.push('full_suite_validation.timeout_retry_count');
    }
    if (typeof options.fullSuiteGreenSummaryMaxLines === 'string') {
        nextFullSuiteValidation.green_summary_max_lines = parseIntegerText(
            options.fullSuiteGreenSummaryMaxLines,
            '--full-suite-green-summary-max-lines',
            1
        );
        changedFields.push('full_suite_validation.green_summary_max_lines');
    }
    if (typeof options.fullSuiteRedFailureChunkLines === 'string') {
        nextFullSuiteValidation.red_failure_chunk_lines = parseIntegerText(
            options.fullSuiteRedFailureChunkLines,
            '--full-suite-red-failure-chunk-lines',
            10
        );
        changedFields.push('full_suite_validation.red_failure_chunk_lines');
    }
    if (typeof options.fullSuiteOutOfScopeFailurePolicy === 'string') {
        nextFullSuiteValidation.out_of_scope_failure_policy = parseOutOfScopeFailurePolicy(
            options.fullSuiteOutOfScopeFailurePolicy
        );
        changedFields.push('full_suite_validation.out_of_scope_failure_policy');
    }
    if (typeof options.fullSuitePlacement === 'string') {
        nextFullSuiteValidation.placement = parseFullSuitePlacement(options.fullSuitePlacement);
        changedFields.push('full_suite_validation.placement');
    }
    if (isConfiguredCompileGateCommand(nextCompileGate.command)) {
        validateWorkflowCompileGateCommand(nextCompileGate.command, nextFullSuiteValidation.command);
    }
    nextConfig.compile_gate = nextCompileGate;
    nextConfig.full_suite_validation = nextFullSuiteValidation;
    if (typeof options.reviewExecutionPolicy === 'string') {
        nextConfig.review_execution_policy = {
            mode: normalizeReviewExecutionPolicyMode(
                options.reviewExecutionPolicy,
                '--review-execution-policy'
            )
        };
        changedFields.push('review_execution_policy.mode');
    }
    const nextReviewDelegation = cloneReviewDelegationConfig(
        normalizeReviewDelegationConfig(nextConfig.review_delegation ?? buildDefaultWorkflowConfig().review_delegation)
    );
    if (noDelegateSetting) {
        nextReviewDelegation.no_delegate = parseBooleanText(
            noDelegateSetting.value,
            noDelegateSetting.flagName
        );
        changedFields.push('review_delegation.no_delegate');
    }
    nextConfig.review_delegation = nextReviewDelegation;
    const nextScopeBudgetGuard = normalizeScopeBudgetGuardConfig(nextConfig.scope_budget_guard);
    if (scopeBudgetEnabledSetting) {
        nextScopeBudgetGuard.enabled = parseBooleanText(
            scopeBudgetEnabledSetting.value,
            scopeBudgetEnabledSetting.flagName
        );
        changedFields.push('scope_budget_guard.enabled');
    }
    if (typeof options.scopeBudgetAction === 'string') {
        nextScopeBudgetGuard.action = parseScopeBudgetAction(options.scopeBudgetAction);
        changedFields.push('scope_budget_guard.action');
    }
    if (typeof options.scopeBudgetProfiles === 'string') {
        nextScopeBudgetGuard.profiles = parseProfileList(options.scopeBudgetProfiles);
        changedFields.push('scope_budget_guard.profiles');
    }
    if (typeof options.scopeBudgetMaxFiles === 'string') {
        applyLegacyScopeBudgetLimit(nextScopeBudgetGuard, {
            legacyKey: 'max_files',
            warningKey: 'warn_files',
            blockingKey: 'block_files'
        }, parseIntegerText(options.scopeBudgetMaxFiles, '--scope-budget-max-files', 1));
        changedFields.push('scope_budget_guard.max_files');
    }
    if (typeof options.scopeBudgetMaxChangedLines === 'string') {
        applyLegacyScopeBudgetLimit(nextScopeBudgetGuard, {
            legacyKey: 'max_changed_lines',
            warningKey: 'warn_changed_lines',
            blockingKey: 'block_changed_lines'
        }, parseIntegerText(options.scopeBudgetMaxChangedLines, '--scope-budget-max-changed-lines', 1));
        changedFields.push('scope_budget_guard.max_changed_lines');
    }
    if (typeof options.scopeBudgetMaxRequiredReviews === 'string') {
        applyLegacyScopeBudgetLimit(nextScopeBudgetGuard, {
            legacyKey: 'max_required_reviews',
            warningKey: 'warn_required_reviews',
            blockingKey: 'block_required_reviews'
        }, parseIntegerText(options.scopeBudgetMaxRequiredReviews, '--scope-budget-max-required-reviews', 1));
        changedFields.push('scope_budget_guard.max_required_reviews');
    }
    if (typeof options.scopeBudgetMaxReviewTokens === 'string') {
        applyLegacyScopeBudgetLimit(nextScopeBudgetGuard, {
            legacyKey: 'max_review_tokens',
            warningKey: 'warn_review_tokens',
            blockingKey: 'block_review_tokens'
        }, parseIntegerText(options.scopeBudgetMaxReviewTokens, '--scope-budget-max-review-tokens', 1));
        changedFields.push('scope_budget_guard.max_review_tokens');
    }
    if (typeof options.scopeBudgetWarnFiles === 'string') {
        nextScopeBudgetGuard.warn_files = parseIntegerText(options.scopeBudgetWarnFiles, '--scope-budget-warn-files', 1);
        nextScopeBudgetGuard.max_files = nextScopeBudgetGuard.warn_files;
        changedFields.push('scope_budget_guard.warn_files');
    }
    if (typeof options.scopeBudgetBlockFiles === 'string') {
        nextScopeBudgetGuard.block_files = parseIntegerText(options.scopeBudgetBlockFiles, '--scope-budget-block-files', 1);
        changedFields.push('scope_budget_guard.block_files');
    }
    if (typeof options.scopeBudgetWarnChangedLines === 'string') {
        nextScopeBudgetGuard.warn_changed_lines = parseIntegerText(options.scopeBudgetWarnChangedLines, '--scope-budget-warn-changed-lines', 1);
        nextScopeBudgetGuard.max_changed_lines = nextScopeBudgetGuard.warn_changed_lines;
        changedFields.push('scope_budget_guard.warn_changed_lines');
    }
    if (typeof options.scopeBudgetBlockChangedLines === 'string') {
        nextScopeBudgetGuard.block_changed_lines = parseIntegerText(options.scopeBudgetBlockChangedLines, '--scope-budget-block-changed-lines', 1);
        changedFields.push('scope_budget_guard.block_changed_lines');
    }
    if (typeof options.scopeBudgetWarnRequiredReviews === 'string') {
        nextScopeBudgetGuard.warn_required_reviews = parseIntegerText(options.scopeBudgetWarnRequiredReviews, '--scope-budget-warn-required-reviews', 1);
        nextScopeBudgetGuard.max_required_reviews = nextScopeBudgetGuard.warn_required_reviews;
        changedFields.push('scope_budget_guard.warn_required_reviews');
    }
    if (typeof options.scopeBudgetBlockRequiredReviews === 'string') {
        nextScopeBudgetGuard.block_required_reviews = parseIntegerText(options.scopeBudgetBlockRequiredReviews, '--scope-budget-block-required-reviews', 1);
        changedFields.push('scope_budget_guard.block_required_reviews');
    }
    if (typeof options.scopeBudgetWarnReviewTokens === 'string') {
        nextScopeBudgetGuard.warn_review_tokens = parseIntegerText(options.scopeBudgetWarnReviewTokens, '--scope-budget-warn-review-tokens', 1);
        nextScopeBudgetGuard.max_review_tokens = nextScopeBudgetGuard.warn_review_tokens;
        changedFields.push('scope_budget_guard.warn_review_tokens');
    }
    if (typeof options.scopeBudgetBlockReviewTokens === 'string') {
        nextScopeBudgetGuard.block_review_tokens = parseIntegerText(options.scopeBudgetBlockReviewTokens, '--scope-budget-block-review-tokens', 1);
        changedFields.push('scope_budget_guard.block_review_tokens');
    }
    nextConfig.scope_budget_guard = nextScopeBudgetGuard;
    const nextReviewCycleGuard = normalizeReviewCycleGuardConfig(nextConfig.review_cycle_guard);
    if (reviewCycleEnabledSetting) {
        nextReviewCycleGuard.enabled = parseBooleanText(
            reviewCycleEnabledSetting.value,
            reviewCycleEnabledSetting.flagName
        );
        changedFields.push('review_cycle_guard.enabled');
    }
    if (typeof options.reviewCycleAction === 'string') {
        nextReviewCycleGuard.action = parseReviewCycleAction(options.reviewCycleAction);
        changedFields.push('review_cycle_guard.action');
    }
    if (typeof options.reviewCycleMaxFailedNonTestReviews === 'string') {
        nextReviewCycleGuard.max_failed_non_test_reviews = parseIntegerText(
            options.reviewCycleMaxFailedNonTestReviews,
            '--review-cycle-max-failed-non-test-reviews',
            1
        );
        changedFields.push('review_cycle_guard.max_failed_non_test_reviews');
    }
    if (typeof options.reviewCycleMaxTotalNonTestReviews === 'string') {
        nextReviewCycleGuard.max_total_non_test_reviews = parseIntegerText(
            options.reviewCycleMaxTotalNonTestReviews,
            '--review-cycle-max-total-non-test-reviews',
            1
        );
        changedFields.push('review_cycle_guard.max_total_non_test_reviews');
    }
    if (typeof options.reviewCycleExcludedReviewTypes === 'string') {
        nextReviewCycleGuard.excluded_review_types = parseReviewTypeList(
            options.reviewCycleExcludedReviewTypes,
            '--review-cycle-excluded-review-types'
        );
        changedFields.push('review_cycle_guard.excluded_review_types');
    }
    if (reviewCycleAutoSplitSetting) {
        nextReviewCycleGuard.auto_split_enabled = parseBooleanText(
            reviewCycleAutoSplitSetting.value,
            reviewCycleAutoSplitSetting.flagName
        );
        changedFields.push('review_cycle_guard.auto_split_enabled');
    }
    nextConfig.review_cycle_guard = nextReviewCycleGuard;

    const nextProjectMemoryMaintenance = cloneProjectMemoryMaintenanceConfig(
        nextConfig.project_memory_maintenance ?? buildDefaultWorkflowConfig().project_memory_maintenance
    );
    if (projectMemoryEnabledSetting) {
        nextProjectMemoryMaintenance.enabled = parseBooleanText(
            projectMemoryEnabledSetting.value,
            projectMemoryEnabledSetting.flagName
        );
        changedFields.push('project_memory_maintenance.enabled');
    }
    if (typeof options.projectMemoryMode === 'string') {
        nextProjectMemoryMaintenance.mode = parseProjectMemoryMaintenanceMode(options.projectMemoryMode);
        changedFields.push('project_memory_maintenance.mode');
    }
    if (typeof options.projectMemoryRunBeforeFinalCloseout === 'string') {
        nextProjectMemoryMaintenance.run_before_final_closeout = parseBooleanText(
            options.projectMemoryRunBeforeFinalCloseout,
            '--project-memory-run-before-final-closeout'
        );
        changedFields.push('project_memory_maintenance.run_before_final_closeout');
    }
    if (typeof options.projectMemoryRequireUserApprovalForWrites === 'string') {
        nextProjectMemoryMaintenance.require_user_approval_for_writes = parseBooleanText(
            options.projectMemoryRequireUserApprovalForWrites,
            '--project-memory-require-user-approval-for-writes'
        );
        changedFields.push('project_memory_maintenance.require_user_approval_for_writes');
    }
    if (typeof options.projectMemoryMaxCompactSummaryChars === 'string') {
        nextProjectMemoryMaintenance.max_compact_summary_chars = parseIntegerText(
            options.projectMemoryMaxCompactSummaryChars,
            '--project-memory-max-compact-summary-chars',
            2000
        );
        changedFields.push('project_memory_maintenance.max_compact_summary_chars');
    }
    if (typeof options.projectMemoryReadStrategy === 'string') {
        nextProjectMemoryMaintenance.read_strategy = parseProjectMemoryReadStrategy(options.projectMemoryReadStrategy);
        changedFields.push('project_memory_maintenance.read_strategy');
    }
    if (typeof options.projectMemoryImpactArtifactRetentionDays === 'string') {
        nextProjectMemoryMaintenance.impact_artifact_retention_days = parseIntegerText(
            options.projectMemoryImpactArtifactRetentionDays,
            '--project-memory-impact-artifact-retention-days',
            1
        );
        changedFields.push('project_memory_maintenance.impact_artifact_retention_days');
    }
    nextConfig.project_memory_maintenance = nextProjectMemoryMaintenance;

    const nextTaskReset = cloneTaskResetConfig(
        nextConfig.task_reset ?? buildDefaultWorkflowConfig().task_reset
    );
    if (taskResetEnabledSetting) {
        nextTaskReset.enabled = parseBooleanText(
            taskResetEnabledSetting.value,
            taskResetEnabledSetting.flagName
        );
        changedFields.push('task_reset.enabled');
    }
    nextConfig.task_reset = nextTaskReset;

    const nextAutoBackup = cloneAutoBackupConfig(
        normalizeAutoBackupConfig(nextConfig.auto_backup ?? buildDefaultWorkflowConfig().auto_backup)
    );
    if (autoBackupEnabledSetting) {
        nextAutoBackup.enabled = parseBooleanText(
            autoBackupEnabledSetting.value,
            autoBackupEnabledSetting.flagName
        );
        changedFields.push('auto_backup.enabled');
    }
    if (typeof options.autoBackupIntervalDays === 'string') {
        nextAutoBackup.interval_days = parseIntegerText(
            options.autoBackupIntervalDays,
            '--auto-backup-interval-days',
            1
        );
        changedFields.push('auto_backup.interval_days');
    }
    if (typeof options.autoBackupKeepLatest === 'string') {
        nextAutoBackup.keep_latest = parseIntegerText(
            options.autoBackupKeepLatest,
            '--auto-backup-keep-latest',
            1
        );
        changedFields.push('auto_backup.keep_latest');
    }
    nextConfig.auto_backup = nextAutoBackup;

    const nextOptionalQualityChecks = cloneOptionalQualityChecksConfig(
        normalizeOptionalQualityChecksConfig(
            nextConfig.optional_quality_checks ?? buildDefaultWorkflowConfig().optional_quality_checks
        )
    );
    if (typeof options.optionalCheckRuleId === 'string' && typeof options.optionalCheckRuleDelete === 'string') {
        throw new Error('--optional-check-rule-id cannot be combined with --optional-check-rule-delete.');
    }
    if (optionalChecksEnabledSetting) {
        nextOptionalQualityChecks.enabled = parseBooleanText(
            optionalChecksEnabledSetting.value,
            optionalChecksEnabledSetting.flagName
        );
        changedFields.push('optional_quality_checks.enabled');
    }
    if (typeof options.optionalChecksReviewFailureCadenceInterval === 'string') {
        nextOptionalQualityChecks.review_failure_cadence_interval = parseIntegerText(
            options.optionalChecksReviewFailureCadenceInterval,
            '--optional-checks-review-failure-cadence-interval',
            1,
            MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL
        );
        changedFields.push('optional_quality_checks.review_failure_cadence_interval');
    }
    const optionalRulesBefore = JSON.stringify(nextOptionalQualityChecks.rules);
    nextOptionalQualityChecks.rules = deleteOptionalCheckRule(
        upsertOptionalCheckRule(nextOptionalQualityChecks.rules, options),
        options
    );
    if (JSON.stringify(nextOptionalQualityChecks.rules) !== optionalRulesBefore) {
        changedFields.push('optional_quality_checks.rules');
    }
    if (nextOptionalQualityChecks.baseline_version !== OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION) {
        nextOptionalQualityChecks.baseline_version = OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION;
        changedFields.push('optional_quality_checks.baseline_version');
    }
    nextConfig.optional_quality_checks = nextOptionalQualityChecks;

    if (typeof options.optionalSkillSelectionMode === 'string') {
        const mode = parseOptionalSkillSelectionPolicyMode(options.optionalSkillSelectionMode);
        const currentPolicy = readOptionalSkillSelectionPolicyForSet(roots.optionalSkillSelectionPolicyPath);
        optionalSkillSelectionPolicyExists = currentPolicy.exists;
        optionalSkillSelectionPolicyCurrentSerialized = currentPolicy.serializedConfig;
        optionalSkillSelectionPolicyNextConfig = buildNextOptionalSkillSelectionPolicyConfig(
            currentPolicy.validatedConfig,
            mode
        );
        optionalSkillSelectionPolicyNextSerialized = serializeManagedConfig(optionalSkillSelectionPolicyNextConfig);
        optionalSkillSelectionPolicyFields.push('optional_skill_selection_policy.mode');
    }

    const nextOrchestratorWorkPolicy = cloneOrchestratorWorkPolicyConfig(
        normalizeOrchestratorWorkPolicyConfig(
            nextConfig.orchestrator_work_policy ?? buildDefaultWorkflowConfig().orchestrator_work_policy
        )
    );
    if (typeof options.gardaSelfGuard === 'string') {
        nextOrchestratorWorkPolicy.mode = parseGardaSelfGuardMode(options.gardaSelfGuard);
        changedFields.push('orchestrator_work_policy.mode');
    }
    nextConfig.orchestrator_work_policy = nextOrchestratorWorkPolicy;

    if (changedFields.length === 0 && optionalSkillSelectionPolicyFields.length === 0) {
        throw new Error(
            "Workflow setting flags are required for 'workflow set'. "
            + 'Use --compile-gate-command, --full-suite-enabled, --full-suite-command, --full-suite-timeout-ms, '
            + '--full-suite-timeout-blocker, --full-suite-timeout-retry-count, '
            + '--full-suite-green-summary-max-lines, --full-suite-red-failure-chunk-lines, '
            + '--full-suite-out-of-scope-failure-policy, --full-suite-placement, --review-execution-policy, '
            + '--no-delegate or --review-delegation-no-delegate, '
            + '--scope-budget-* flags, --review-cycle-* flags, --project-memory-* flags, '
            + '--task-reset-enabled, --auto-backup-* flags, --optional-checks-enabled, '
            + '--optional-checks-review-failure-cadence-interval, '
            + '--optional-check-rule-* flags, --optional-skill-selection-mode, '
            + 'their short on/off aliases, or --garda-self-guard.'
        );
    }

    const currentValidated = normalizeWorkflowFileConfig(validateWorkflowConfig(state.rawConfig ?? {
            compile_gate: state.config.compile_gate,
            full_suite_validation: state.config.full_suite_validation,
            review_delegation: state.config.review_delegation,
            scope_budget_guard: state.config.scope_budget_guard,
            review_cycle_guard: state.config.review_cycle_guard,
            project_memory_maintenance: state.config.project_memory_maintenance,
            task_reset: state.config.task_reset,
            auto_backup: state.config.auto_backup,
            optional_quality_checks: state.config.optional_quality_checks,
            orchestrator_work_policy: state.config.orchestrator_work_policy
        }) as WorkflowFileConfigData);
    const currentSerialized = JSON.stringify(currentValidated, null, 2) + '\n';
    const nextValidated = normalizeWorkflowFileConfig(validateWorkflowConfig(nextConfig) as WorkflowFileConfigData);
    const nextSerialized = JSON.stringify(nextValidated, null, 2) + '\n';
    const workflowConfigChanged = changedFields.length > 0 && (!state.exists || nextSerialized !== currentSerialized);
    const optionalSkillSelectionPolicyChanged = optionalSkillSelectionPolicyFields.length > 0
        && (!optionalSkillSelectionPolicyExists || optionalSkillSelectionPolicyNextSerialized !== optionalSkillSelectionPolicyCurrentSerialized);
    const changed = workflowConfigChanged || optionalSkillSelectionPolicyChanged;
    const requestedFields = [...changedFields, ...optionalSkillSelectionPolicyFields];
    const actualWorkflowConfigChangedFields = workflowConfigChanged
        ? resolveActualChangedFields(changedFields, currentValidated, nextValidated, state.exists)
        : [];
    const actualChangedFields = [
        ...actualWorkflowConfigChangedFields,
        ...(optionalSkillSelectionPolicyChanged ? optionalSkillSelectionPolicyFields : [])
    ];
    const actualChangedFieldSet = new Set(actualChangedFields);
    const noopFields = requestedFields.filter((field) => !actualChangedFieldSet.has(field));

    const taskResetAuditRepairRequested = !changed
        && requestedFields.includes('task_reset.enabled')
        && nextValidated.task_reset?.enabled === true
        && String(options.operatorConfirmed || '').trim() === 'yes';

    let auditPath: string | null = null;
    let protectedManifestPath: string | null = null;
    const auditWriteOptions = {
        transaction,
        mutationSource: normalizeWorkflowConfigMutationSource(options.mutationSource),
        targetRoot: roots.targetRoot
    };
    if (changed) {
        const safeSelfGuardHardening = requestedFields.length === 1
            && requestedFields[0] === 'orchestrator_work_policy.mode'
            && nextValidated.orchestrator_work_policy?.mode === 'deny_agent_entry';
        if (!safeSelfGuardHardening) {
            requireWorkflowSetOperatorConfirmation(options);
        }
        if (workflowConfigChanged) {
            writeWorkflowConfig(roots.configPath, nextValidated, transaction);
            auditPath = writeWorkflowConfigAuditRecord(
                roots.bundleRoot,
                roots.configPath,
                actualWorkflowConfigChangedFields,
                currentSerialized,
                nextSerialized,
                auditWriteOptions
            );
        }
        if (optionalSkillSelectionPolicyChanged && optionalSkillSelectionPolicyNextConfig && optionalSkillSelectionPolicyNextSerialized) {
            transaction.write(roots.optionalSkillSelectionPolicyPath, serializeManagedConfig(optionalSkillSelectionPolicyNextConfig));
            auditPath = writeWorkflowConfigAuditRecord(
                roots.bundleRoot,
                roots.optionalSkillSelectionPolicyPath,
                optionalSkillSelectionPolicyFields,
                optionalSkillSelectionPolicyCurrentSerialized ?? '',
                optionalSkillSelectionPolicyNextSerialized,
                auditWriteOptions
            );
        }
        protectedManifestPath = refreshWorkflowProtectedManifest(resolveProtectedManifestRefreshRoot(roots), transaction);
    } else if (taskResetAuditRepairRequested) {
        requireWorkflowSetOperatorConfirmation(options);
        const currentFileText = fs.readFileSync(roots.configPath, 'utf8');
        auditPath = writeWorkflowConfigAuditRecord(
            roots.bundleRoot,
            roots.configPath,
            ['task_reset.enabled'],
            currentFileText,
            currentFileText,
            auditWriteOptions
        );
        protectedManifestPath = refreshWorkflowProtectedManifest(resolveProtectedManifestRefreshRoot(roots), transaction);
    }

    const result: WorkflowSetResult = {
        ...buildWorkflowShowResult(roots, {
            rawConfig: nextValidated,
            config: nextValidated,
            exists: state.exists || workflowConfigChanged,
            missingReviewExecutionPolicyMode: null
        }),
        action: 'set',
        status: changed ? 'CHANGED' : 'NO_CHANGE',
        changed,
        requested_fields: requestedFields,
        changed_fields: actualChangedFields,
        noop_fields: noopFields,
        audit_path: auditPath ? normalizeOutputPath(auditPath) : null,
        protected_manifest_path: protectedManifestPath ? normalizeOutputPath(protectedManifestPath) : null
    };
    return result;
}
