import * as fs from 'node:fs';
import * as path from 'node:path';

import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../core/constants';
import { compactSettingsFromConfig } from '../../core/compact/setting-definitions';
import {
    isExactLegacyProjectMemoryGeneratedDefault,
    normalizeFullSuiteValidationPlacement
} from '../../core/workflow-config';
import { toPlainRecord } from '../shared/helpers';
import {
    COMPATIBILITY_ALLOWED_TOP_LEVEL_KEY_SETS,
    COMPATIBILITY_AUTO_BACKUP_KEYS,
    COMPATIBILITY_COMPILE_GATE_KEYS,
    COMPATIBILITY_FULL_SUITE_VALIDATION_KEYS,
    COMPATIBILITY_FULL_SUITE_VALIDATION_OPTIONAL_KEYS,
    COMPATIBILITY_FULL_SUITE_VALIDATION_REQUIRED_KEYS,
    COMPATIBILITY_OPTIONAL_QUALITY_CHECK_RULE_OPTIONAL_KEYS,
    COMPATIBILITY_OPTIONAL_QUALITY_CHECK_RULE_REQUIRED_KEYS,
    COMPATIBILITY_OPTIONAL_QUALITY_CHECKS_KEYS,
    COMPATIBILITY_ORCHESTRATOR_WORK_POLICY_KEYS,
    COMPATIBILITY_PROJECT_MEMORY_MAINTENANCE_KEYS,
    COMPATIBILITY_REVIEW_CYCLE_GUARD_KEYS,
    COMPATIBILITY_REVIEW_DELEGATION_KEYS,
    COMPATIBILITY_REVIEW_EXECUTION_POLICY_KEYS,
    COMPATIBILITY_SCOPE_BUDGET_GUARD_KEYS,
    COMPATIBILITY_TASK_RESET_KEYS,
    COMPATIBILITY_TOP_LEVEL_KEYS,
    SAFE_FULL_SUITE_COMPATIBILITY_COMMANDS,
    SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE,
    hasCompatibleOptionalQualityRuleScopeFilters,
    hasExactOwnKeys,
    hasOwnKey,
    hasRequiredOwnKeysAndOnlyOptionalKeys,
    hasSupportedScopeBudgetGuardKeys,
    includesEvery,
    isSubsetOf,
    normalizeStringList,
    numberAtMost,
    numberEquals,
    scopeBudgetMaxRequiredReviewsAtMostCompatibilityLimit
} from './workflow-config-work-compatibility-primitives';

function isExactDefaultOptionalQualityChecksCompatibilityBaseline(input: unknown): boolean {
    const optionalQualityChecks = toPlainRecord(input);
    const defaultOptionalQualityChecks = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.optional_quality_checks as unknown as Record<string, unknown>;
    const rules = optionalQualityChecks && Array.isArray(optionalQualityChecks.rules)
        ? optionalQualityChecks.rules
        : null;
    const defaultRules = Array.isArray(defaultOptionalQualityChecks.rules)
        ? defaultOptionalQualityChecks.rules
        : null;
    if (
        !optionalQualityChecks
        || !hasExactOwnKeys(defaultOptionalQualityChecks, COMPATIBILITY_OPTIONAL_QUALITY_CHECKS_KEYS)
        || !hasExactOwnKeys(optionalQualityChecks, COMPATIBILITY_OPTIONAL_QUALITY_CHECKS_KEYS)
        || optionalQualityChecks.enabled !== true
        || !rules
        || !defaultRules
        || optionalQualityChecks.baseline_version !== defaultOptionalQualityChecks.baseline_version
        || !numberEquals(
            optionalQualityChecks,
            'review_failure_cadence_interval',
            defaultOptionalQualityChecks.review_failure_cadence_interval
        )
        || rules.length !== defaultRules.length
    ) {
        return false;
    }
    return rules.every((rawRule, index) => {
        const rule = toPlainRecord(rawRule);
        const defaultRule = toPlainRecord(defaultRules[index]);
        return !!rule
            && !!defaultRule
            && hasRequiredOwnKeysAndOnlyOptionalKeys(
                defaultRule,
                COMPATIBILITY_OPTIONAL_QUALITY_CHECK_RULE_REQUIRED_KEYS,
                COMPATIBILITY_OPTIONAL_QUALITY_CHECK_RULE_OPTIONAL_KEYS
            )
            && hasRequiredOwnKeysAndOnlyOptionalKeys(
                rule,
                COMPATIBILITY_OPTIONAL_QUALITY_CHECK_RULE_REQUIRED_KEYS,
                COMPATIBILITY_OPTIONAL_QUALITY_CHECK_RULE_OPTIONAL_KEYS
            )
            && rule.enabled === defaultRule.enabled
            && rule.id === defaultRule.id
            && rule.title === defaultRule.title
            && rule.prompt === defaultRule.prompt
            && hasCompatibleOptionalQualityRuleScopeFilters(rule, defaultRule);
    });
}

function isSafeIgnoredWorkflowConfigCompatibilityBaseline(config: Record<string, unknown>): boolean {
    if (
        !hasExactOwnKeys(SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE as unknown as Record<string, unknown>, COMPATIBILITY_TOP_LEVEL_KEYS)
        || !COMPATIBILITY_ALLOWED_TOP_LEVEL_KEY_SETS.some((keySet) => hasExactOwnKeys(config, keySet))
    ) {
        return false;
    }

    if (hasOwnKey(config, 'compact')) {
        try {
            compactSettingsFromConfig(config.compact);
        } catch {
            return false;
        }
    }

    const fullSuiteValidation = toPlainRecord(config.full_suite_validation);
    if (!fullSuiteValidation) {
        return false;
    }
    const outOfScopeFailurePolicy = String(
        fullSuiteValidation.out_of_scope_failure_policy || ''
    ).trim().toUpperCase();
    const command = String(fullSuiteValidation.command || '').trim();
    const defaultFullSuiteValidation = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.full_suite_validation as unknown as Record<string, unknown>;
    if (
        !hasExactOwnKeys(defaultFullSuiteValidation, COMPATIBILITY_FULL_SUITE_VALIDATION_KEYS)
        || !hasRequiredOwnKeysAndOnlyOptionalKeys(
            fullSuiteValidation,
            COMPATIBILITY_FULL_SUITE_VALIDATION_REQUIRED_KEYS,
            COMPATIBILITY_FULL_SUITE_VALIDATION_OPTIONAL_KEYS
        )
        || typeof fullSuiteValidation.enabled !== 'boolean'
        || outOfScopeFailurePolicy !== 'AUDIT_AND_BLOCK'
        || !numberEquals(fullSuiteValidation, 'timeout_ms', defaultFullSuiteValidation.timeout_ms)
        || !numberEquals(fullSuiteValidation, 'green_summary_max_lines', defaultFullSuiteValidation.green_summary_max_lines)
        || !numberEquals(fullSuiteValidation, 'red_failure_chunk_lines', defaultFullSuiteValidation.red_failure_chunk_lines)
    ) {
        return false;
    }
    if (!SAFE_FULL_SUITE_COMPATIBILITY_COMMANDS.has(command)) {
        return false;
    }
    if (hasOwnKey(fullSuiteValidation, 'placement')) {
        try {
            const placement = normalizeFullSuiteValidationPlacement(fullSuiteValidation.placement, {
                rejectInvalidExplicit: true
            });
            if (placement !== defaultFullSuiteValidation.placement) {
                return false;
            }
        } catch {
            return false;
        }
    }
    if (
        hasOwnKey(fullSuiteValidation, 'timeout_blocker')
        && fullSuiteValidation.timeout_blocker !== defaultFullSuiteValidation.timeout_blocker
    ) {
        return false;
    }
    if (
        hasOwnKey(fullSuiteValidation, 'timeout_retry_count')
        && !numberEquals(fullSuiteValidation, 'timeout_retry_count', defaultFullSuiteValidation.timeout_retry_count)
    ) {
        return false;
    }
    if (fullSuiteValidation.enabled === true && command !== 'npm test') {
        return false;
    }

    if (hasOwnKey(config, 'compile_gate')) {
        const compileGate = toPlainRecord(config.compile_gate);
        const defaultCompileGate = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.compile_gate as unknown as Record<string, unknown>;
        if (
            !compileGate
            || !hasExactOwnKeys(defaultCompileGate, COMPATIBILITY_COMPILE_GATE_KEYS)
            || !hasExactOwnKeys(compileGate, COMPATIBILITY_COMPILE_GATE_KEYS)
            || String(compileGate.command || '').trim() !== UNCONFIGURED_COMPILE_GATE_COMMAND
        ) {
            return false;
        }
    }

    if (hasOwnKey(config, 'review_execution_policy')) {
        const reviewExecutionPolicy = toPlainRecord(config.review_execution_policy);
        const reviewExecutionMode = String(reviewExecutionPolicy?.mode || '').trim().toLowerCase();
        const defaultReviewExecutionPolicy = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.review_execution_policy as unknown as Record<string, unknown>;
        if (
            !reviewExecutionPolicy
            || !hasExactOwnKeys(defaultReviewExecutionPolicy, COMPATIBILITY_REVIEW_EXECUTION_POLICY_KEYS)
            || !hasExactOwnKeys(reviewExecutionPolicy, COMPATIBILITY_REVIEW_EXECUTION_POLICY_KEYS)
            || !['code_first_optional', 'strict_sequential'].includes(reviewExecutionMode)
        ) {
            return false;
        }
    }

    if (hasOwnKey(config, 'review_delegation')) {
        const reviewDelegation = toPlainRecord(config.review_delegation);
        const defaultReviewDelegation = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.review_delegation as unknown as Record<string, unknown>;
        if (
            !reviewDelegation
            || !hasExactOwnKeys(defaultReviewDelegation, COMPATIBILITY_REVIEW_DELEGATION_KEYS)
            || !hasExactOwnKeys(reviewDelegation, COMPATIBILITY_REVIEW_DELEGATION_KEYS)
            || reviewDelegation.no_delegate !== false
        ) {
            return false;
        }
    }

    const scopeBudgetGuard = toPlainRecord(config.scope_budget_guard);
    const defaultScopeBudgetGuard = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.scope_budget_guard as unknown as Record<string, unknown>;
    const scopeBudgetGuardAction = String(scopeBudgetGuard?.action || '').trim().toUpperCase();
    if (
        !scopeBudgetGuard
        || !hasExactOwnKeys(defaultScopeBudgetGuard, COMPATIBILITY_SCOPE_BUDGET_GUARD_KEYS)
        || !hasSupportedScopeBudgetGuardKeys(scopeBudgetGuard)
        || scopeBudgetGuard.enabled !== true
        || !['WARN_ONLY', 'BLOCK_FOR_SPLIT'].includes(scopeBudgetGuardAction)
        || !includesEvery(
            normalizeStringList(scopeBudgetGuard.profiles),
            normalizeStringList(defaultScopeBudgetGuard.profiles)
        )
        || !numberAtMost(scopeBudgetGuard, 'max_files', defaultScopeBudgetGuard.max_files)
        || !numberAtMost(scopeBudgetGuard, 'max_changed_lines', defaultScopeBudgetGuard.max_changed_lines)
        || !scopeBudgetMaxRequiredReviewsAtMostCompatibilityLimit(scopeBudgetGuard)
        || !numberAtMost(scopeBudgetGuard, 'max_review_tokens', defaultScopeBudgetGuard.max_review_tokens)
    ) {
        return false;
    }
    if (hasExactOwnKeys(scopeBudgetGuard, COMPATIBILITY_SCOPE_BUDGET_GUARD_KEYS)) {
        if (
            !numberAtMost(scopeBudgetGuard, 'warn_files', defaultScopeBudgetGuard.warn_files)
            || !numberAtMost(scopeBudgetGuard, 'block_files', defaultScopeBudgetGuard.block_files)
            || !numberAtMost(scopeBudgetGuard, 'warn_changed_lines', defaultScopeBudgetGuard.warn_changed_lines)
            || !numberAtMost(scopeBudgetGuard, 'block_changed_lines', defaultScopeBudgetGuard.block_changed_lines)
            || !numberAtMost(scopeBudgetGuard, 'warn_required_reviews', defaultScopeBudgetGuard.warn_required_reviews)
            || !numberAtMost(scopeBudgetGuard, 'block_required_reviews', defaultScopeBudgetGuard.block_required_reviews)
            || !numberAtMost(scopeBudgetGuard, 'warn_review_tokens', defaultScopeBudgetGuard.warn_review_tokens)
            || !numberAtMost(scopeBudgetGuard, 'block_review_tokens', defaultScopeBudgetGuard.block_review_tokens)
        ) {
            return false;
        }
    }

    const reviewCycleGuard = toPlainRecord(config.review_cycle_guard);
    const defaultReviewCycleGuard = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.review_cycle_guard as unknown as Record<string, unknown>;
    if (
        !reviewCycleGuard
        || !hasExactOwnKeys(defaultReviewCycleGuard, COMPATIBILITY_REVIEW_CYCLE_GUARD_KEYS)
        || !hasExactOwnKeys(reviewCycleGuard, COMPATIBILITY_REVIEW_CYCLE_GUARD_KEYS)
        || reviewCycleGuard.enabled !== true
        || String(reviewCycleGuard.action || '').trim().toUpperCase() !== 'BLOCK_FOR_OPERATOR_DECISION'
        || !numberAtMost(reviewCycleGuard, 'max_failed_non_test_reviews', defaultReviewCycleGuard.max_failed_non_test_reviews)
        || !numberAtMost(reviewCycleGuard, 'max_total_non_test_reviews', defaultReviewCycleGuard.max_total_non_test_reviews)
        || !isSubsetOf(
            normalizeStringList(reviewCycleGuard.excluded_review_types),
            normalizeStringList(defaultReviewCycleGuard.excluded_review_types)
        )
        || typeof reviewCycleGuard.auto_split_enabled !== 'boolean'
    ) {
        return false;
    }

    const projectMemoryMaintenance = toPlainRecord(config.project_memory_maintenance);
    const defaultProjectMemoryMaintenance = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.project_memory_maintenance as unknown as Record<string, unknown>;
    const hasCurrentProjectMemoryMaintenance = !!projectMemoryMaintenance
        && projectMemoryMaintenance.enabled === true
        && String(projectMemoryMaintenance.mode || '').trim().toLowerCase() === 'update';
    const hasLegacyProjectMemoryMaintenance = isExactLegacyProjectMemoryGeneratedDefault(projectMemoryMaintenance);
    if (
        !projectMemoryMaintenance
        || !hasExactOwnKeys(defaultProjectMemoryMaintenance, COMPATIBILITY_PROJECT_MEMORY_MAINTENANCE_KEYS)
        || !hasExactOwnKeys(projectMemoryMaintenance, COMPATIBILITY_PROJECT_MEMORY_MAINTENANCE_KEYS)
        || (!hasCurrentProjectMemoryMaintenance && !hasLegacyProjectMemoryMaintenance)
        || projectMemoryMaintenance.run_before_final_closeout !== true
        || projectMemoryMaintenance.require_user_approval_for_writes !== true
        || !numberEquals(
            projectMemoryMaintenance,
            'max_compact_summary_chars',
            defaultProjectMemoryMaintenance.max_compact_summary_chars
        )
        || String(projectMemoryMaintenance.read_strategy || '').trim().toLowerCase()
            !== String(defaultProjectMemoryMaintenance.read_strategy || '').trim().toLowerCase()
        || !numberEquals(
            projectMemoryMaintenance,
            'impact_artifact_retention_days',
            defaultProjectMemoryMaintenance.impact_artifact_retention_days
        )
    ) {
        return false;
    }

    if (hasOwnKey(config, 'task_reset')) {
        const taskReset = toPlainRecord(config.task_reset);
        const defaultTaskReset = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.task_reset as unknown as Record<string, unknown>;
        if (
            !taskReset
            || !hasExactOwnKeys(defaultTaskReset, COMPATIBILITY_TASK_RESET_KEYS)
            || !hasExactOwnKeys(taskReset, COMPATIBILITY_TASK_RESET_KEYS)
            || taskReset.enabled !== false
        ) {
            return false;
        }
    }

    if (hasOwnKey(config, 'auto_backup')) {
        const autoBackup = toPlainRecord(config.auto_backup);
        const defaultAutoBackup = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.auto_backup as unknown as Record<string, unknown>;
        if (
            !autoBackup
            || !hasExactOwnKeys(defaultAutoBackup, COMPATIBILITY_AUTO_BACKUP_KEYS)
            || !hasExactOwnKeys(autoBackup, COMPATIBILITY_AUTO_BACKUP_KEYS)
            || autoBackup.enabled !== false
            || !numberEquals(autoBackup, 'interval_days', defaultAutoBackup.interval_days)
            || !numberEquals(autoBackup, 'keep_latest', defaultAutoBackup.keep_latest)
        ) {
            return false;
        }
    }

    if (
        hasOwnKey(config, 'optional_quality_checks')
        && !isExactDefaultOptionalQualityChecksCompatibilityBaseline(config.optional_quality_checks)
    ) {
        return false;
    }

    if (hasOwnKey(config, 'orchestrator_work_policy')) {
        const orchestratorWorkPolicy = toPlainRecord(config.orchestrator_work_policy);
        const defaultOrchestratorWorkPolicy = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.orchestrator_work_policy as unknown as Record<string, unknown>;
        if (
            !orchestratorWorkPolicy
            || !hasExactOwnKeys(defaultOrchestratorWorkPolicy, COMPATIBILITY_ORCHESTRATOR_WORK_POLICY_KEYS)
            || !hasExactOwnKeys(orchestratorWorkPolicy, COMPATIBILITY_ORCHESTRATOR_WORK_POLICY_KEYS)
            || String(orchestratorWorkPolicy.mode || '').trim().toLowerCase() !== 'deny_agent_entry'
        ) {
            return false;
        }
    }

    return true;
}

export function hasUnsafeIgnoredWorkflowConfigCompatibilityBaseline(
    repoRoot: string,
    relativePath: string
): boolean {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, ...relativePath.split('/')), 'utf8'));
        const config = toPlainRecord(parsed);
        if (!config) {
            return true;
        }
        return !isSafeIgnoredWorkflowConfigCompatibilityBaseline(config);
    } catch {
        return true;
    }
}
