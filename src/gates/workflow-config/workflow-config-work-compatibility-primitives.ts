import {
    buildDefaultWorkflowConfig
} from '../../core/workflow-config';
import {
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND
} from '../../core/constants';

export const SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE = buildDefaultWorkflowConfig();
const LEGACY_SCOPE_BUDGET_MAX_REQUIRED_REVIEWS_COMPATIBILITY_LIMIT = 6;
export const SAFE_FULL_SUITE_COMPATIBILITY_COMMANDS = new Set([
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
    'npm test'
]);
export const COMPATIBILITY_TOP_LEVEL_KEYS = [
    'compact',
    'compile_gate',
    'full_suite_validation',
    'orchestrator_work_policy',
    'auto_backup',
    'optional_quality_checks',
    'project_memory_maintenance',
    'review_cycle_guard',
    'review_delegation',
    'review_execution_policy',
    'scope_budget_guard',
    'task_reset',
    'local_commit'
];
const COMPATIBILITY_OPTIONAL_TOP_LEVEL_KEYS = [
    'compact',
    'compile_gate',
    'auto_backup',
    'optional_quality_checks',
    'orchestrator_work_policy',
    'review_delegation',
    'review_execution_policy',
    'task_reset',
    'local_commit'
];
export const COMPATIBILITY_ALLOWED_TOP_LEVEL_KEY_SETS = Array.from(
    { length: 1 << COMPATIBILITY_OPTIONAL_TOP_LEVEL_KEYS.length },
    (_entry, mask) => COMPATIBILITY_TOP_LEVEL_KEYS.filter((key) => {
        const optionalIndex = COMPATIBILITY_OPTIONAL_TOP_LEVEL_KEYS.indexOf(key);
        return optionalIndex < 0 || (mask & (1 << optionalIndex)) === 0;
    })
);
export const COMPATIBILITY_FULL_SUITE_VALIDATION_REQUIRED_KEYS = [
    'command',
    'enabled',
    'green_summary_max_lines',
    'out_of_scope_failure_policy',
    'red_failure_chunk_lines',
    'timeout_ms'
];
export const COMPATIBILITY_FULL_SUITE_VALIDATION_OPTIONAL_KEYS = [
    'placement',
    'timeout_blocker',
    'timeout_retry_count'
];
export const COMPATIBILITY_FULL_SUITE_VALIDATION_KEYS = [
    ...COMPATIBILITY_FULL_SUITE_VALIDATION_REQUIRED_KEYS,
    ...COMPATIBILITY_FULL_SUITE_VALIDATION_OPTIONAL_KEYS
];
export const COMPATIBILITY_COMPILE_GATE_KEYS = ['command'];
export const COMPATIBILITY_REVIEW_EXECUTION_POLICY_KEYS = ['mode'];
export const COMPATIBILITY_REVIEW_DELEGATION_KEYS = ['no_delegate'];
const COMPATIBILITY_LEGACY_SCOPE_BUDGET_GUARD_KEYS = [
    'action',
    'enabled',
    'max_changed_lines',
    'max_files',
    'max_required_reviews',
    'max_review_tokens',
    'profiles'
];
export const COMPATIBILITY_SCOPE_BUDGET_GUARD_KEYS = [
    ...COMPATIBILITY_LEGACY_SCOPE_BUDGET_GUARD_KEYS,
    'block_changed_lines',
    'block_files',
    'block_required_reviews',
    'block_review_tokens',
    'warn_changed_lines',
    'warn_files',
    'warn_required_reviews',
    'warn_review_tokens'
];
export const COMPATIBILITY_REVIEW_CYCLE_GUARD_KEYS = [
    'action',
    'auto_split_enabled',
    'enabled',
    'excluded_review_types',
    'max_failed_non_test_reviews',
    'max_total_non_test_reviews'
];
export const COMPATIBILITY_PROJECT_MEMORY_MAINTENANCE_KEYS = [
    'enabled',
    'impact_artifact_retention_days',
    'max_compact_summary_chars',
    'mode',
    'read_strategy',
    'require_user_approval_for_writes',
    'run_before_final_closeout'
];
export const COMPATIBILITY_TASK_RESET_KEYS = ['enabled'];
export const COMPATIBILITY_LOCAL_COMMIT_KEYS = ['enabled'];
export const COMPATIBILITY_AUTO_BACKUP_KEYS = ['enabled', 'interval_days', 'keep_latest'];
export const COMPATIBILITY_OPTIONAL_QUALITY_CHECKS_KEYS = [
    'baseline_version',
    'enabled',
    'review_failure_cadence_interval',
    'rules'
];
export const COMPATIBILITY_OPTIONAL_QUALITY_CHECK_RULE_REQUIRED_KEYS = ['enabled', 'id', 'prompt', 'title'];
export const COMPATIBILITY_OPTIONAL_QUALITY_CHECK_RULE_OPTIONAL_KEYS = [
    'excluded_scope_categories',
    'included_scope_categories',
    'included_changed_file_regexes'
];
export const COMPATIBILITY_ORCHESTRATOR_WORK_POLICY_KEYS = ['mode'];

export function hasExactOwnKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
    const actualKeys = Object.keys(record).sort();
    const sortedExpectedKeys = [...expectedKeys].sort();
    return actualKeys.length === sortedExpectedKeys.length
        && sortedExpectedKeys.every((key, index) => actualKeys[index] === key);
}

export function hasRequiredOwnKeysAndOnlyOptionalKeys(
    record: Record<string, unknown>,
    requiredKeys: readonly string[],
    optionalKeys: readonly string[]
): boolean {
    const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
    const actualKeys = Object.keys(record);
    return requiredKeys.every((key) => hasOwnKey(record, key))
        && actualKeys.every((key) => allowedKeys.has(key));
}

export function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function getPositiveInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

export function numberAtMost(record: Record<string, unknown>, key: string, limit: unknown): boolean {
    const actual = getPositiveInteger(record[key]);
    const maximum = getPositiveInteger(limit);
    return actual !== null && maximum !== null && actual <= maximum;
}

export function scopeBudgetMaxRequiredReviewsAtMostCompatibilityLimit(
    scopeBudgetGuard: Record<string, unknown>
): boolean {
    const defaultScopeBudgetGuard = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.scope_budget_guard as unknown as Record<string, unknown>;
    const currentDefault = getPositiveInteger(defaultScopeBudgetGuard.max_required_reviews);
    const compatibilityLimit = currentDefault === null
        ? LEGACY_SCOPE_BUDGET_MAX_REQUIRED_REVIEWS_COMPATIBILITY_LIMIT
        : Math.max(currentDefault, LEGACY_SCOPE_BUDGET_MAX_REQUIRED_REVIEWS_COMPATIBILITY_LIMIT);
    return numberAtMost(scopeBudgetGuard, 'max_required_reviews', compatibilityLimit);
}

export function hasSupportedScopeBudgetGuardKeys(scopeBudgetGuard: Record<string, unknown>): boolean {
    return hasExactOwnKeys(scopeBudgetGuard, COMPATIBILITY_SCOPE_BUDGET_GUARD_KEYS)
        || hasExactOwnKeys(scopeBudgetGuard, COMPATIBILITY_LEGACY_SCOPE_BUDGET_GUARD_KEYS);
}

export function numberEquals(record: Record<string, unknown>, key: string, expected: unknown): boolean {
    const actual = getPositiveInteger(record[key]);
    const expectedNumber = getPositiveInteger(expected);
    return actual !== null && expectedNumber !== null && actual === expectedNumber;
}

export function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(value.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean))].sort();
}

export function includesEvery(actual: readonly string[], expected: readonly string[]): boolean {
    const actualSet = new Set(actual);
    return expected.every((entry) => actualSet.has(entry));
}

export function isSubsetOf(actual: readonly string[], allowed: readonly string[]): boolean {
    const allowedSet = new Set(allowed);
    return actual.every((entry) => allowedSet.has(entry));
}

function hasCompatibleOptionalQualityRuleScopeExclusions(
    rule: Record<string, unknown>,
    defaultRule: Record<string, unknown>
): boolean {
    const defaultHasExclusions = hasOwnKey(defaultRule, 'excluded_scope_categories');
    const ruleHasExclusions = hasOwnKey(rule, 'excluded_scope_categories');
    if (!defaultHasExclusions) {
        return !ruleHasExclusions;
    }
    if (!ruleHasExclusions) {
        return true;
    }
    const defaultExclusions = normalizeStringList(defaultRule.excluded_scope_categories);
    return defaultExclusions.length > 0
        && arraysEqual(normalizeStringList(rule.excluded_scope_categories), defaultExclusions);
}

function hasCompatibleOptionalQualityRuleStrictScopeList(
    rule: Record<string, unknown>,
    defaultRule: Record<string, unknown>,
    key: 'included_scope_categories' | 'included_changed_file_regexes'
): boolean {
    const defaultHasList = hasOwnKey(defaultRule, key);
    const ruleHasList = hasOwnKey(rule, key);
    if (!defaultHasList) {
        return !ruleHasList;
    }
    if (!ruleHasList) {
        return false;
    }
    const defaultList = normalizeStringList(defaultRule[key]);
    return defaultList.length > 0
        && arraysEqual(normalizeStringList(rule[key]), defaultList);
}

export function hasCompatibleOptionalQualityRuleScopeFilters(
    rule: Record<string, unknown>,
    defaultRule: Record<string, unknown>
): boolean {
    return hasCompatibleOptionalQualityRuleScopeExclusions(rule, defaultRule)
        && hasCompatibleOptionalQualityRuleStrictScopeList(rule, defaultRule, 'included_scope_categories')
        && hasCompatibleOptionalQualityRuleStrictScopeList(rule, defaultRule, 'included_changed_file_regexes');
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
