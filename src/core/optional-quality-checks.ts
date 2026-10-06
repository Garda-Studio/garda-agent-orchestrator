import { cloneJsonValue, isPlainObject } from './config-merge';
import {
    TRUST_BOUNDARY_ANALYSIS_RULE_ID,
    TRUST_BOUNDARY_ANALYSIS_RULE_PROMPT,
    TRUST_BOUNDARY_ANALYSIS_RULE_TITLE,
    TRUST_BOUNDARY_SENSITIVE_CHANGED_FILE_REGEXES
} from './trust-boundary-analysis';

export interface OptionalQualityCheckRule {
    id: string;
    title: string;
    prompt: string;
    enabled: boolean;
    included_scope_categories?: string[];
    included_changed_file_regexes?: string[];
    excluded_scope_categories?: string[];
    [key: string]: unknown;
}

export interface OptionalQualityChecksConfig {
    enabled: boolean;
    baseline_version: string;
    review_failure_cadence_interval: number;
    rules: OptionalQualityCheckRule[];
    [key: string]: unknown;
}

export interface OptionalQualityChecksReviewFailureCadenceIntervalResolution {
    value: number;
    violation: string | null;
}

export interface OptionalQualityChecksMergeOptions {
    preserveMovedProjectRulesAsCustom?: boolean;
}

export interface OptionalQualityChecksRuleSetDiagnostics {
    hasMismatch: boolean;
    staleBaselineVersion: boolean;
    installedBaselineVersion: string;
    shippedBaselineVersion: string;
    rawEnabledRuleIds: string[];
    canonicalEnabledRuleIds: string[];
    droppedEnabledRuleIds: string[];
    movedEnabledRuleIds: string[];
    suggestedCustomRuleIds: string[];
}

export const OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE = 'Optional quality checks are enabled. Review their settings in the Garda UI before starting.';
export const OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION = '2026-07-21.t969';
export const DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL = 3;
export const MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL = 100;
export const OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL_KEY = 'review_failure_cadence_interval';
export const OPTIONAL_QUALITY_CHECK_SCOPE_CATEGORY_TEST_ONLY = 'test-only';
export const OPTIONAL_QUALITY_CHECK_SCOPE_CATEGORY_CONFIG_ONLY = 'config-only';

const OPS_SHELL_CHANGED_FILE_REGEXES = Object.freeze([
    '(^|/)[^/]+\\.(?:sh|bash|zsh|ps1|cmd|bat)$',
    '(^|/)(?:scripts|ops|operations|bin|tools|ci|deploy|deployment|backup|restore)(?:/|$).+\\.(?:sh|bash|zsh|ps1|cmd|bat|js|mjs|cjs|ts|tsx|py|ya?ml|json|conf)$',
    '(^|/)(?:[^/]*[._-])?(?:deploy|deployment|backup|restore|ops)(?:[._-][^/]*)?\\.(?:sh|bash|zsh|ps1|cmd|bat|js|mjs|cjs|ts|tsx|py|ya?ml|json|conf)$',
    '(^|/)\\.github/workflows/.*(?:deploy|deployment|backup|restore|release|ops).*\\.ya?ml$'
] as const);

export const LEGACY_OPTIONAL_QUALITY_CHECK_RULES: readonly OptionalQualityCheckRule[] = Object.freeze([
    Object.freeze({
        id: 'code_simplification',
        title: 'Code simplification',
        prompt: 'Check whether the changed code can be simplified without weakening behavior, validation, or diagnostics.',
        enabled: true,
        excluded_scope_categories: [OPTIONAL_QUALITY_CHECK_SCOPE_CATEGORY_TEST_ONLY]
    }),
    Object.freeze({
        id: 'project_style_fit',
        title: 'Project style fit',
        prompt: 'Check whether the change follows the local project style, naming, module boundaries, and existing helper patterns.',
        enabled: true
    }),
    Object.freeze({
        id: 'unnecessary_abstraction',
        title: 'Unnecessary abstraction',
        prompt: 'Check whether the change introduced abstractions that do not remove real duplication, risk, or complexity.',
        enabled: true,
        excluded_scope_categories: [OPTIONAL_QUALITY_CHECK_SCOPE_CATEGORY_TEST_ONLY]
    }),
    Object.freeze({
        id: 'size_growth',
        title: 'Class/function/file growth',
        prompt: 'Check whether touched classes, functions, or files grew enough to need local extraction or clearer ownership.',
        enabled: true,
        excluded_scope_categories: [OPTIONAL_QUALITY_CHECK_SCOPE_CATEGORY_TEST_ONLY]
    }),
    Object.freeze({
        id: 'hardcoded_values_contracts',
        title: 'Hardcoded values and contracts',
        prompt: 'Check whether new literals, paths, statuses, or messages should be named constants, schema fields, or shared contracts.',
        enabled: true
    }),
    Object.freeze({
        id: 'duplicated_logic_contracts',
        title: 'Duplicated logic and contracts',
        prompt: 'Check whether the change duplicates logic, validation, or contract strings that should stay defined in one place.',
        enabled: true
    }),
    Object.freeze({
        id: 'test_verification_scope',
        title: 'Test and verification scope',
        prompt: 'Check whether the focused tests and mandatory gates cover the behavioral risk without adding unrelated slow coverage.',
        enabled: true
    })
]);

export const OPS_SHELL_OPTIONAL_QUALITY_CHECK_RULES: readonly OptionalQualityCheckRule[] = Object.freeze([
    Object.freeze({
        id: 'ops_shell_strict_error_handling',
        title: 'Ops shell strict error handling',
        prompt: 'For shell or ops-script changes, check strict shell behavior, error propagation, exit-code handling, traps or cleanup paths, and cross-shell or platform portability.',
        enabled: true,
        included_changed_file_regexes: [...OPS_SHELL_CHANGED_FILE_REGEXES]
    }),
    Object.freeze({
        id: 'ops_deploy_backup_idempotency',
        title: 'Ops deploy and backup idempotency',
        prompt: 'For deploy, backup, restore, or operations scripts, check idempotency, safe retries, dry-run or confirmation semantics, rollback or cleanup behavior, and restore verification where backup data is involved.',
        enabled: true,
        included_changed_file_regexes: [...OPS_SHELL_CHANGED_FILE_REGEXES]
    }),
    Object.freeze({
        id: 'ops_secret_env_loading',
        title: 'Ops secrets and environment loading',
        prompt: 'For shell or ops changes, check secret handling, log redaction, env-file loading safety, and whether duplicated environment-loading snippets should reuse or extract a shared helper.',
        enabled: true,
        included_changed_file_regexes: [...OPS_SHELL_CHANGED_FILE_REGEXES]
    })
]);

export const DEFAULT_OPTIONAL_QUALITY_CHECK_RULES: readonly OptionalQualityCheckRule[] = Object.freeze([
    ...LEGACY_OPTIONAL_QUALITY_CHECK_RULES,
    ...OPS_SHELL_OPTIONAL_QUALITY_CHECK_RULES,
    Object.freeze({
        id: TRUST_BOUNDARY_ANALYSIS_RULE_ID,
        title: TRUST_BOUNDARY_ANALYSIS_RULE_TITLE,
        prompt: TRUST_BOUNDARY_ANALYSIS_RULE_PROMPT,
        enabled: true,
        included_changed_file_regexes: [...TRUST_BOUNDARY_SENSITIVE_CHANGED_FILE_REGEXES]
    })
]);

const DEFAULT_OPTIONAL_QUALITY_CHECK_RULE_BY_ID = new Map(
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => [rule.id, rule])
);

const DEPRECATED_OPTIONAL_QUALITY_CHECK_BASELINE_RULE_IDS = new Set([
    'preflight_review_scope_regressions',
    'trust_artifact_identity',
    'doc_impact_closeout_parity',
    'task_queue_parser_state',
    'review_cycle_scope_freshness',
    'zero_diff_noop_preemption',
    'classifier_intent_edge_cases',
    'config_materialization_parity',
    'control_plane_action_safety',
    'artifact_evidence_binding',
    'gate_routing_self_regression'
]);

const MOVED_GARDA_OPTIONAL_QUALITY_CHECK_CUSTOM_RULES: readonly Readonly<{
    movedRuleId: string;
    customRule: OptionalQualityCheckRule;
}>[] = Object.freeze([
    Object.freeze({
        movedRuleId: 'classifier_intent_edge_cases',
        customRule: Object.freeze({
            id: 'custom_garda_classifier_intent_edge_cases',
            title: 'Garda classifier intent edge cases',
            prompt: 'For Garda classifier keyword or regex changes, check acceptance wording, hyphen and space variants, standalone forms, and protocol or numeric suffixes such as OAuth2.',
            enabled: true
        })
    }),
    Object.freeze({
        movedRuleId: 'config_materialization_parity',
        customRule: Object.freeze({
            id: 'custom_garda_config_materialization_parity',
            title: 'Garda config materialization parity',
            prompt: 'For Garda config, default, template, materialization, schema, install, and update changes, check parity while preserving explicit local user choices.',
            enabled: true
        })
    }),
    Object.freeze({
        movedRuleId: 'control_plane_action_safety',
        customRule: Object.freeze({
            id: 'custom_garda_control_plane_action_safety',
            title: 'Garda control-plane action safety',
            prompt: 'For Garda UI, CLI, or control-plane mutations, check audited and validated action paths with confirmation, boundary checks, compact success output, and preserved failure diagnostics.',
            enabled: true
        })
    }),
    Object.freeze({
        movedRuleId: 'artifact_evidence_binding',
        customRule: Object.freeze({
            id: 'custom_garda_artifact_evidence_binding',
            title: 'Garda artifact evidence binding',
            prompt: 'For Garda artifact, history, cache, or telemetry evidence, check identity, freshness, scope or worktree binding, path ownership, and stale or forged negative cases before trust.',
            enabled: true
        })
    }),
    Object.freeze({
        movedRuleId: 'gate_routing_self_regression',
        customRule: Object.freeze({
            id: 'custom_garda_gate_routing_self_regression',
            title: 'Garda gate routing self-regression',
            prompt: 'For Garda gate, guard, or routing changes, check self-regression fixtures where blocking states preempt expensive work, pass states continue, and warning-only states do not block.',
            enabled: true
        })
    })
]);

const MOVED_GARDA_OPTIONAL_QUALITY_CHECK_CUSTOM_RULE_BY_OLD_ID = new Map(
    MOVED_GARDA_OPTIONAL_QUALITY_CHECK_CUSTOM_RULES.map((entry) => [entry.movedRuleId, entry.customRule])
);

function hasOwn(value: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeScopeCategory(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

export function normalizeOptionalQualityCheckScopeCategories(value: unknown): string[] {
    const rawValues = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(',')
            : [];
    return [...new Set(rawValues
        .map(normalizeScopeCategory)
        .filter(Boolean))].sort();
}

function normalizeOptionalQualityCheckChangedFileRegex(value: unknown): string {
    return String(value || '').trim();
}

export function normalizeOptionalQualityCheckChangedFileRegexes(value: unknown): string[] {
    const rawValues = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(',')
            : [];
    return [...new Set(rawValues
        .map(normalizeOptionalQualityCheckChangedFileRegex)
        .filter(Boolean))].sort();
}

export function isOptionalQualityCheckRuleExcludedForScope(
    rule: Pick<OptionalQualityCheckRule, 'excluded_scope_categories'>,
    scopeCategory: unknown
): boolean {
    const normalizedScopeCategory = normalizeScopeCategory(scopeCategory);
    if (!normalizedScopeCategory) {
        return false;
    }
    return normalizeOptionalQualityCheckScopeCategories(rule.excluded_scope_categories)
        .includes(normalizedScopeCategory);
}

export function hasOptionalQualityCheckRuleScopeInclusion(rule: Pick<OptionalQualityCheckRule, 'included_scope_categories' | 'included_changed_file_regexes'>): boolean {
    return normalizeOptionalQualityCheckScopeCategories(rule.included_scope_categories).length > 0
        || normalizeOptionalQualityCheckChangedFileRegexes(rule.included_changed_file_regexes).length > 0;
}

function normalizeChangedFilePath(value: unknown): string {
    return String(value || '').replace(/\\/g, '/').trim();
}

function matchesRegex(value: string, pattern: string): boolean {
    try {
        return new RegExp(pattern, 'i').test(value);
    } catch {
        return false;
    }
}

function isOptionalQualityCheckRuleIncludedByScopeCategory(
    rule: Pick<OptionalQualityCheckRule, 'included_scope_categories'>,
    scopeCategory: unknown
): boolean {
    const normalizedScopeCategory = normalizeScopeCategory(scopeCategory);
    const includedScopeCategories = normalizeOptionalQualityCheckScopeCategories(rule.included_scope_categories);
    return includedScopeCategories.length > 0
        && Boolean(normalizedScopeCategory)
        && includedScopeCategories.includes(normalizedScopeCategory);
}

function isOptionalQualityCheckRuleIncludedByChangedFiles(
    rule: Pick<OptionalQualityCheckRule, 'included_changed_file_regexes'>,
    changedFiles: readonly unknown[]
): boolean {
    const includedChangedFileRegexes = normalizeOptionalQualityCheckChangedFileRegexes(rule.included_changed_file_regexes);
    if (includedChangedFileRegexes.length === 0) {
        return false;
    }
    const normalizedChangedFiles = changedFiles
        .map(normalizeChangedFilePath)
        .filter(Boolean);
    return normalizedChangedFiles.some((changedFile) => (
        includedChangedFileRegexes.some((pattern) => matchesRegex(changedFile, pattern))
    ));
}

export function getOptionalQualityCheckRuleScopeSkipReason(
    rule: Pick<OptionalQualityCheckRule, 'enabled' | 'included_scope_categories' | 'included_changed_file_regexes' | 'excluded_scope_categories'>,
    scopeCategory: unknown,
    changedFiles: readonly unknown[] = []
): string | null {
    if (rule.enabled === false) {
        return null;
    }
    if (hasOptionalQualityCheckRuleScopeInclusion(rule)) {
        const includedByScopeCategory = isOptionalQualityCheckRuleIncludedByScopeCategory(rule, scopeCategory);
        const includedByChangedFiles = isOptionalQualityCheckRuleIncludedByChangedFiles(rule, changedFiles);
        if (!includedByScopeCategory && !includedByChangedFiles) {
            const includedScopeCategories = normalizeOptionalQualityCheckScopeCategories(rule.included_scope_categories);
            const includedChangedFileRegexes = normalizeOptionalQualityCheckChangedFileRegexes(rule.included_changed_file_regexes);
            const inclusionParts = [
                includedScopeCategories.length > 0 ? `scope categories: ${includedScopeCategories.join(', ')}` : '',
                includedChangedFileRegexes.length > 0 ? 'changed-file patterns' : ''
            ].filter(Boolean);
            return `Rule included only for ${inclusionParts.join(' or ')}; current preflight scope_category '${normalizeScopeCategory(scopeCategory) || 'unknown'}' did not match.`;
        }
    }
    if (isOptionalQualityCheckRuleExcludedForScope(rule, scopeCategory)) {
        return `Rule excluded for preflight scope_category '${normalizeScopeCategory(scopeCategory) || 'unknown'}'.`;
    }
    return null;
}

export function isOptionalQualityCheckRuleActiveForScope(
    rule: Pick<OptionalQualityCheckRule, 'enabled' | 'included_scope_categories' | 'included_changed_file_regexes' | 'excluded_scope_categories'>,
    scopeCategory: unknown,
    changedFiles: readonly unknown[] = []
): boolean {
    return rule.enabled !== false
        && getOptionalQualityCheckRuleScopeSkipReason(rule, scopeCategory, changedFiles) === null;
}

function applyRuleScopeFilters(
    rule: OptionalQualityCheckRule,
    source: Record<string, unknown>
): OptionalQualityCheckRule {
    let normalizedRule = rule;
    if (hasOwn(source, 'included_scope_categories')) {
        normalizedRule = {
            ...normalizedRule,
            included_scope_categories: normalizeOptionalQualityCheckScopeCategories(source.included_scope_categories)
        };
    }
    if (hasOwn(source, 'included_changed_file_regexes')) {
        normalizedRule = {
            ...normalizedRule,
            included_changed_file_regexes: normalizeOptionalQualityCheckChangedFileRegexes(source.included_changed_file_regexes)
        };
    }
    if (hasOwn(source, 'excluded_scope_categories')) {
        normalizedRule = {
            ...normalizedRule,
            excluded_scope_categories: normalizeOptionalQualityCheckScopeCategories(source.excluded_scope_categories)
        };
    }
    return normalizedRule;
}

function appendMissingMovedProjectCustomRules(
    mergedRules: OptionalQualityCheckRule[],
    mergedRuleIds: Set<string>
): void {
    for (const { customRule } of MOVED_GARDA_OPTIONAL_QUALITY_CHECK_CUSTOM_RULES) {
        if (mergedRuleIds.has(customRule.id)) {
            continue;
        }
        mergedRules.push(cloneJsonValue(customRule) as OptionalQualityCheckRule);
        mergedRuleIds.add(customRule.id);
    }
}

function getOptionalQualityCheckBaselineRuleById(ruleId: string): OptionalQualityCheckRule | null {
    return DEFAULT_OPTIONAL_QUALITY_CHECK_RULE_BY_ID.get(ruleId.trim().toLowerCase()) || null;
}

export function isBaselineOptionalQualityCheckRuleId(ruleId: string): boolean {
    return getOptionalQualityCheckBaselineRuleById(ruleId) !== null;
}

export function getBaselineOptionalQualityCheckRule(ruleId: string): OptionalQualityCheckRule | null {
    const baselineRule = getOptionalQualityCheckBaselineRuleById(ruleId);
    return baselineRule ? cloneJsonValue(baselineRule) as OptionalQualityCheckRule : null;
}

export function buildDefaultOptionalQualityChecksConfig(): OptionalQualityChecksConfig {
    return {
        enabled: true,
        baseline_version: OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION,
        review_failure_cadence_interval: DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
        rules: cloneJsonValue(DEFAULT_OPTIONAL_QUALITY_CHECK_RULES) as OptionalQualityCheckRule[]
    };
}

function normalizeOptionalQualityCheckRule(input: unknown): OptionalQualityCheckRule | null {
    if (!isPlainObject(input)) {
        return null;
    }
    const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!id || !title || !prompt) {
        return null;
    }
    const baselineRule = getOptionalQualityCheckBaselineRuleById(id);
    if (baselineRule) {
        const normalizedRule = {
            ...cloneJsonValue(baselineRule),
            ...cloneJsonValue(input),
            id,
            title,
            prompt,
            enabled: input.enabled === undefined ? baselineRule.enabled : input.enabled === true
        } as OptionalQualityCheckRule;
        return applyRuleScopeFilters(normalizedRule, input);
    }
    const customRule = {
        ...cloneJsonValue(input),
        id,
        title,
        prompt,
        enabled: input.enabled === undefined ? true : input.enabled === true
    };
    return applyRuleScopeFilters(customRule, input);
}

function normalizeOptionalQualityCheckRules(input: unknown): OptionalQualityCheckRule[] {
    if (!Array.isArray(input)) {
        return [];
    }
    return input
        .map((rule) => normalizeOptionalQualityCheckRule(rule))
        .filter((rule): rule is OptionalQualityCheckRule => rule !== null);
}

function normalizeRawEnabledRuleIds(input: unknown): string[] {
    if (!isPlainObject(input) || !Array.isArray(input.rules)) {
        return [];
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (const rule of input.rules) {
        if (!isPlainObject(rule) || rule.enabled === false) {
            continue;
        }
        const id = typeof rule.id === 'string' ? rule.id.trim().toLowerCase() : '';
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        result.push(id);
    }
    return result;
}

function formatRuleIdList(ruleIds: readonly string[], maxItems = 20): string {
    const preview = ruleIds.slice(0, maxItems).join(', ');
    const remainder = ruleIds.length > maxItems
        ? `, +${ruleIds.length - maxItems} more`
        : '';
    return preview ? `${preview}${remainder}` : '<none>';
}

function parseReviewFailureCadenceInterval(value: unknown): number | null {
    if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
    }
    return null;
}

export function resolveOptionalQualityChecksReviewFailureCadenceInterval(
    input: unknown
): OptionalQualityChecksReviewFailureCadenceIntervalResolution {
    const key = OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL_KEY;
    if (!isPlainObject(input) || !hasOwn(input, key) || input[key] === undefined) {
        return {
            value: DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
            violation: null
        };
    }
    const parsed = parseReviewFailureCadenceInterval(input[key]);
    if (
        parsed === null
        || parsed < 1
        || parsed > MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL
    ) {
        return {
            value: DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
            violation:
                `workflow-config.optional_quality_checks.${key} must be an integer from 1 to ` +
                `${MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL}; omit it to use default ` +
                `${DEFAULT_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL}.`
        };
    }
    return {
        value: parsed,
        violation: null
    };
}

function mergeOptionalQualityCheckRulesWithBaseline(
    existingRules: readonly OptionalQualityCheckRule[],
    baselineRules: readonly OptionalQualityCheckRule[],
    staleBaselineVersion: boolean,
    options: OptionalQualityChecksMergeOptions = {}
): OptionalQualityCheckRule[] {
    const baselineRuleById = new Map(baselineRules.map((rule) => [rule.id, rule]));
    const existingRuleIds = new Set(existingRules.map((rule) => rule.id));
    const mergedRuleIds = new Set<string>();
    const mergedRules: OptionalQualityCheckRule[] = [];

    for (const existingRule of existingRules) {
        if (staleBaselineVersion && DEPRECATED_OPTIONAL_QUALITY_CHECK_BASELINE_RULE_IDS.has(existingRule.id)) {
            const movedCustomRule = options.preserveMovedProjectRulesAsCustom
                ? MOVED_GARDA_OPTIONAL_QUALITY_CHECK_CUSTOM_RULE_BY_OLD_ID.get(existingRule.id)
                : null;
            if (movedCustomRule && !existingRuleIds.has(movedCustomRule.id) && !mergedRuleIds.has(movedCustomRule.id)) {
                mergedRules.push({
                    ...cloneJsonValue(movedCustomRule),
                    enabled: existingRule.enabled !== false
                });
                mergedRuleIds.add(movedCustomRule.id);
            }
            continue;
        }
        const baselineRule = baselineRuleById.get(existingRule.id);
        if (baselineRule) {
            if (!mergedRuleIds.has(existingRule.id)) {
                const canonicalRule = cloneJsonValue(baselineRule) as OptionalQualityCheckRule;
                const preservedRule = staleBaselineVersion
                    ? {
                        ...canonicalRule,
                        enabled: existingRule.enabled !== false
                    }
                    : {
                        ...canonicalRule,
                        ...cloneJsonValue(existingRule),
                        id: existingRule.id,
                        title: existingRule.title,
                        prompt: existingRule.prompt,
                        enabled: existingRule.enabled !== false
                    };
                mergedRules.push(applyRuleScopeFilters(preservedRule, existingRule));
                mergedRuleIds.add(existingRule.id);
            }
            continue;
        }
        if (!mergedRuleIds.has(existingRule.id)) {
            mergedRules.push(cloneJsonValue(existingRule) as OptionalQualityCheckRule);
            mergedRuleIds.add(existingRule.id);
        }
    }

    for (const baselineRule of baselineRules) {
        if (!mergedRuleIds.has(baselineRule.id)) {
            mergedRules.push(cloneJsonValue(baselineRule) as OptionalQualityCheckRule);
            mergedRuleIds.add(baselineRule.id);
        }
    }

    if (options.preserveMovedProjectRulesAsCustom) {
        appendMissingMovedProjectCustomRules(mergedRules, mergedRuleIds);
    }

    return mergedRules;
}

function isExactOptionalQualityCheckRule(rule: unknown, expected: OptionalQualityCheckRule): boolean {
    if (!isPlainObject(rule)) {
        return false;
    }
    return typeof rule.id === 'string'
        && rule.id.trim().toLowerCase() === expected.id
        && rule.title === expected.title
        && rule.prompt === expected.prompt
        && (rule.enabled === undefined ? true : rule.enabled === true) === expected.enabled
        && Object.keys(rule).sort().join('\n') === Object.keys(expected).sort().join('\n');
}

function getOptionalQualityChecksBaselineVersion(input: Record<string, unknown>): string {
    return typeof input.baseline_version === 'string'
        ? input.baseline_version.trim()
        : '';
}

export function isExactLegacyOptionalQualityChecksGeneratedDefault(input: unknown): boolean {
    if (!isPlainObject(input)) {
        return false;
    }
    if (typeof input.baseline_version === 'string' && input.baseline_version.trim()) {
        return false;
    }
    const rules = input.rules;
    if (!Array.isArray(rules) || rules.length !== LEGACY_OPTIONAL_QUALITY_CHECK_RULES.length) {
        return false;
    }
    return LEGACY_OPTIONAL_QUALITY_CHECK_RULES.every((expected, index) => (
        isExactOptionalQualityCheckRule(rules[index], expected)
    ));
}

export function normalizeOptionalQualityChecksConfig(input: unknown): OptionalQualityChecksConfig {
    const defaultConfig = buildDefaultOptionalQualityChecksConfig();
    if (!isPlainObject(input)) {
        return defaultConfig;
    }
    const cadenceInterval = resolveOptionalQualityChecksReviewFailureCadenceInterval(input).value;
    const rawBaselineVersion = getOptionalQualityChecksBaselineVersion(input);
    const baselineVersion = rawBaselineVersion || defaultConfig.baseline_version;
    const baselineRules = cloneJsonValue(defaultConfig.rules) as OptionalQualityCheckRule[];
    const normalizedRules = Array.isArray(input.rules)
        ? mergeOptionalQualityCheckRulesWithBaseline(
            normalizeOptionalQualityCheckRules(input.rules),
            baselineRules,
            rawBaselineVersion !== defaultConfig.baseline_version
        )
        : baselineRules;
    return {
        ...cloneJsonValue(input),
        enabled: input.enabled === undefined
            ? defaultConfig.enabled
            : input.enabled === true,
        baseline_version: baselineVersion,
        review_failure_cadence_interval: cadenceInterval,
        rules: normalizedRules.length > 0
            ? normalizedRules
            : cloneJsonValue(defaultConfig.rules)
    };
}

export function buildOptionalQualityChecksRuleSetDiagnostics(input: unknown): OptionalQualityChecksRuleSetDiagnostics {
    const defaultConfig = buildDefaultOptionalQualityChecksConfig();
    const rawBaselineVersion = isPlainObject(input)
        ? getOptionalQualityChecksBaselineVersion(input)
        : '';
    const installedBaselineVersion = rawBaselineVersion || defaultConfig.baseline_version;
    const normalized = normalizeOptionalQualityChecksConfig(input);
    const rawEnabledRuleIds = normalizeRawEnabledRuleIds(input);
    const canonicalEnabledRuleIds = normalized.rules
        .filter((rule) => rule.enabled)
        .map((rule) => rule.id);
    const canonicalEnabledRuleIdSet = new Set(canonicalEnabledRuleIds);
    const droppedEnabledRuleIds = rawEnabledRuleIds
        .filter((ruleId) => !canonicalEnabledRuleIdSet.has(ruleId));
    const movedEnabledRuleIds = droppedEnabledRuleIds
        .filter((ruleId) => DEPRECATED_OPTIONAL_QUALITY_CHECK_BASELINE_RULE_IDS.has(ruleId));
    const suggestedCustomRuleIds = [...new Set(movedEnabledRuleIds
        .map((ruleId) => MOVED_GARDA_OPTIONAL_QUALITY_CHECK_CUSTOM_RULE_BY_OLD_ID.get(ruleId)?.id)
        .filter((ruleId): ruleId is string => Boolean(ruleId)))];
    const staleBaselineVersion = Boolean(rawBaselineVersion)
        && rawBaselineVersion !== defaultConfig.baseline_version;

    return {
        hasMismatch: staleBaselineVersion
            || droppedEnabledRuleIds.length > 0
            || rawEnabledRuleIds.length !== canonicalEnabledRuleIds.length,
        staleBaselineVersion,
        installedBaselineVersion,
        shippedBaselineVersion: defaultConfig.baseline_version,
        rawEnabledRuleIds,
        canonicalEnabledRuleIds,
        droppedEnabledRuleIds,
        movedEnabledRuleIds,
        suggestedCustomRuleIds
    };
}

export function formatOptionalQualityChecksRuleSetDiagnostics(input: unknown): string | null {
    const diagnostics = buildOptionalQualityChecksRuleSetDiagnostics(input);
    if (!diagnostics.hasMismatch) {
        return null;
    }
    const parts: string[] = [];
    if (diagnostics.staleBaselineVersion) {
        parts.push(
            `Quality-checklist workflow config baseline_version '${diagnostics.installedBaselineVersion}' differs from shipped '${diagnostics.shippedBaselineVersion}'.`
        );
    }
    if (diagnostics.droppedEnabledRuleIds.length > 0) {
        parts.push(
            `Enabled rule ids that normalize away from the current rule set: ${formatRuleIdList(diagnostics.droppedEnabledRuleIds)}.`
        );
    }
    if (diagnostics.suggestedCustomRuleIds.length > 0) {
        parts.push(
            `Use canonical custom rule ids instead of moved baseline ids: ${formatRuleIdList(diagnostics.suggestedCustomRuleIds)}.`
        );
    }
    parts.push(
        `Canonical enabled quality-check rule ids: ${formatRuleIdList(diagnostics.canonicalEnabledRuleIds)}.`
    );
    parts.push(
        'Run Garda update/materialization to refresh live workflow-config, or answer using only the canonical enabled rule ids; deprecated or moved ids are not accepted as current answers.'
    );
    return parts.join(' ');
}

export function mergeOptionalQualityChecksWithBaseline(
    templateInput: unknown,
    existingInput: unknown,
    options: OptionalQualityChecksMergeOptions = {}
): OptionalQualityChecksConfig {
    const templateConfig = normalizeOptionalQualityChecksConfig(templateInput);
    if (!isPlainObject(existingInput)) {
        const templateClone = cloneJsonValue(templateConfig);
        const mergedRules = mergeOptionalQualityCheckRulesWithBaseline(
            [],
            templateClone.rules,
            false,
            options
        );
        return {
            ...templateClone,
            rules: mergedRules
        };
    }

    const existingConfig = cloneJsonValue(existingInput);
    const existingRules = normalizeOptionalQualityCheckRules(existingConfig.rules);
    const baselineRules = cloneJsonValue(templateConfig.rules);
    const staleBaselineVersion = getOptionalQualityChecksBaselineVersion(existingConfig) !== templateConfig.baseline_version;
    const cadenceInterval = resolveOptionalQualityChecksReviewFailureCadenceInterval(existingConfig).value;
    const mergedRules = mergeOptionalQualityCheckRulesWithBaseline(
        existingRules,
        baselineRules,
        staleBaselineVersion,
        options
    );

    return {
        ...cloneJsonValue(templateConfig),
        ...existingConfig,
        enabled: existingConfig.enabled === undefined
            ? templateConfig.enabled
            : existingConfig.enabled === true,
        baseline_version: templateConfig.baseline_version,
        review_failure_cadence_interval: cadenceInterval,
        rules: mergedRules.length > 0
            ? mergedRules
            : baselineRules
    };
}
