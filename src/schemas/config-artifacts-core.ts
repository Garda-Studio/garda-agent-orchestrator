import { UNTRACKED_BUILD_OUTPUT_CONFIG_KEY, normalizeUntrackedBuildOutputRegexes } from '../core/build-output-paths';
import {
    cloneUnknownProperties,
    ensurePlainObject,
    normalizeBooleanLike,
    normalizeInteger,
    normalizeNonEmptyString,
    normalizeOptionalString,
    normalizeStringArray
} from './shared';
import { REVIEW_CAPABILITY_KEYS } from '../core/review-capabilities';
import { normalizeReviewCatalog } from '../core/review-catalog';
import { normalizeReviewDependencyGraphDeclaration } from '../core/review-dependency-graph';
import { validateReviewRemediationModePolicy } from '../policy/review-remediation-mode-policy';
import {
    ORDINARY_DOC_PATHS_CONFIG_KEY,
    normalizeOrdinaryDocPathPatterns
} from '../core/ordinary-doc-paths';
import {
    assertNoCaseMismatchedKnownKeys,
    assertNoUnknownKeys,
    normalizeIntegerArray
} from './config-artifacts-shared';


export function validateReviewCapabilitiesConfig(input: unknown): Record<string, boolean> {
    const raw = ensurePlainObject(input, 'review-capabilities');
    const normalized: Record<string, boolean> = {};

    for (const [key, value] of Object.entries(raw)) {
        normalized[key] = normalizeBooleanLike(value, `review-capabilities.${key}`);
    }

    for (const requiredKey of REVIEW_CAPABILITY_KEYS) {
        if (!(requiredKey in normalized)) {
            throw new Error(`review-capabilities.${requiredKey} is required.`);
        }
    }

    return normalized;
}

export function validateReviewCatalogConfig(input: unknown): Record<string, unknown> {
    return normalizeReviewCatalog(input) as unknown as Record<string, unknown>;
}

export function validatePathsConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'paths');
    const knownKeys = new Set([
        'metrics_path',
        'runtime_roots',
        'fast_path_roots',
        'fast_path_allowed_regexes',
        'fast_path_sensitive_regexes',
        'sql_or_migration_regexes',
        'test_refactor_changed_lines_threshold',
        'triggers',
        'code_like_regexes',
        UNTRACKED_BUILD_OUTPUT_CONFIG_KEY,
        ORDINARY_DOC_PATHS_CONFIG_KEY
    ]);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    if (raw[UNTRACKED_BUILD_OUTPUT_CONFIG_KEY] !== undefined)
        normalized[UNTRACKED_BUILD_OUTPUT_CONFIG_KEY] = normalizeUntrackedBuildOutputRegexes(raw[UNTRACKED_BUILD_OUTPUT_CONFIG_KEY]);

    normalized.metrics_path = normalizeNonEmptyString(raw.metrics_path, 'paths.metrics_path');
    normalized.runtime_roots = normalizeStringArray(raw.runtime_roots, 'paths.runtime_roots', { allowScalar: true });
    normalized.fast_path_roots = normalizeStringArray(raw.fast_path_roots, 'paths.fast_path_roots', { allowScalar: true });

    if (raw.fast_path_allowed_regexes !== undefined) {
        normalized.fast_path_allowed_regexes = normalizeStringArray(raw.fast_path_allowed_regexes, 'paths.fast_path_allowed_regexes', { allowScalar: true });
    }

    if (raw.fast_path_sensitive_regexes !== undefined) {
        normalized.fast_path_sensitive_regexes = normalizeStringArray(raw.fast_path_sensitive_regexes, 'paths.fast_path_sensitive_regexes', { allowScalar: true });
    }

    if (raw.sql_or_migration_regexes !== undefined) {
        normalized.sql_or_migration_regexes = normalizeStringArray(raw.sql_or_migration_regexes, 'paths.sql_or_migration_regexes', { allowScalar: true });
    }

    if (raw.test_refactor_changed_lines_threshold !== undefined) {
        normalized.test_refactor_changed_lines_threshold = normalizeInteger(
            raw.test_refactor_changed_lines_threshold,
            'paths.test_refactor_changed_lines_threshold',
            { minimum: 1 }
        );
    }

    if (raw.code_like_regexes !== undefined) {
        normalized.code_like_regexes = normalizeStringArray(raw.code_like_regexes, 'paths.code_like_regexes', { allowScalar: true });
    }

    if (raw[ORDINARY_DOC_PATHS_CONFIG_KEY] !== undefined) {
        normalized[ORDINARY_DOC_PATHS_CONFIG_KEY] = normalizeOrdinaryDocPathPatterns(
            raw[ORDINARY_DOC_PATHS_CONFIG_KEY],
            `paths.${ORDINARY_DOC_PATHS_CONFIG_KEY}`,
            { allowScalar: true }
        );
    }

    const triggers = ensurePlainObject(raw.triggers, 'paths.triggers');
    const triggersMap: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(triggers)) {
        triggersMap[key] = normalizeStringArray(value, `paths.triggers.${key}`, { allowScalar: true });
    }

    if (Object.keys(triggersMap).length === 0) {
        throw new Error('paths.triggers must not be empty.');
    }

    normalized.triggers = triggersMap;

    return normalized;
}

export function validateTokenEconomyConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'token-economy');
    const knownKeys = new Set([
        'enabled',
        'enabled_depths',
        'strip_examples',
        'strip_code_blocks',
        'scoped_diffs',
        'compact_reviewer_output',
        'fail_tail_lines'
    ]);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.enabled = normalizeBooleanLike(raw.enabled, 'token-economy.enabled');
    normalized.enabled_depths = normalizeIntegerArray(raw.enabled_depths, 'token-economy.enabled_depths', { allowScalar: true, minimum: 0 });
    normalized.strip_examples = normalizeBooleanLike(raw.strip_examples, 'token-economy.strip_examples');
    normalized.strip_code_blocks = normalizeBooleanLike(raw.strip_code_blocks, 'token-economy.strip_code_blocks');
    normalized.scoped_diffs = normalizeBooleanLike(raw.scoped_diffs, 'token-economy.scoped_diffs');
    normalized.compact_reviewer_output = normalizeBooleanLike(raw.compact_reviewer_output, 'token-economy.compact_reviewer_output');
    normalized.fail_tail_lines = normalizeInteger(raw.fail_tail_lines, 'token-economy.fail_tail_lines', { minimum: 1 });

    return normalized;
}

function validateContextLookupObject(input: unknown, fieldName: string): Record<string, unknown> {
    const raw = ensurePlainObject(input, fieldName);
    return {
        ...raw,
        context_key: normalizeNonEmptyString(raw.context_key, `${fieldName}.context_key`)
    };
}

function validateOutputFilterOperation(input: unknown, fieldName: string): Record<string, unknown> {
    const raw = ensurePlainObject(input, fieldName);
    const knownKeys = new Set(['type', 'pattern', 'replacement', 'suffix', 'max_chars']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.type = normalizeNonEmptyString(raw.type, `${fieldName}.type`);
    if (raw.pattern !== undefined) {
        normalized.pattern = normalizeNonEmptyString(raw.pattern, `${fieldName}.pattern`);
    }

    if (raw.replacement !== undefined) {
        normalized.replacement = normalizeOptionalString(raw.replacement) ?? '';
    }

    if (raw.suffix !== undefined) {
        normalized.suffix = normalizeOptionalString(raw.suffix) ?? '';
    }

    if (raw.max_chars !== undefined) {
        normalized.max_chars = normalizeInteger(raw.max_chars, `${fieldName}.max_chars`, { minimum: 1 });
    }

    return normalized;
}

function validateOutputFilterParser(input: unknown, fieldName: string): Record<string, unknown> {
    const raw = ensurePlainObject(input, fieldName);
    const knownKeys = new Set(['type', 'strategy', 'max_matches', 'tail_count', 'max_lines']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.type = normalizeNonEmptyString(raw.type, `${fieldName}.type`);

    if (raw.strategy !== undefined) {
        normalized.strategy = typeof raw.strategy === 'string'
            ? normalizeNonEmptyString(raw.strategy, `${fieldName}.strategy`)
            : validateContextLookupObject(raw.strategy, `${fieldName}.strategy`);
    }

    if (raw.max_matches !== undefined) {
        normalized.max_matches = normalizeInteger(raw.max_matches, `${fieldName}.max_matches`, { minimum: 1 });
    }

    if (raw.max_lines !== undefined) {
        normalized.max_lines = normalizeInteger(raw.max_lines, `${fieldName}.max_lines`, { minimum: 1 });
    }

    if (raw.tail_count !== undefined) {
        normalized.tail_count = (typeof raw.tail_count === 'object' && raw.tail_count !== null)
            ? validateContextLookupObject(raw.tail_count, `${fieldName}.tail_count`)
            : normalizeInteger(raw.tail_count, `${fieldName}.tail_count`, { minimum: 1 });
    }

    return normalized;
}

function validateOutputFilterProfile(input: unknown, fieldName: string): Record<string, unknown> {
    const raw = ensurePlainObject(input, fieldName);
    const knownKeys = new Set(['description', 'emit_when_empty', 'operations', 'parser']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.description = normalizeNonEmptyString(raw.description, `${fieldName}.description`);
    if (raw.emit_when_empty !== undefined) {
        normalized.emit_when_empty = normalizeOptionalString(raw.emit_when_empty) ?? '';
    }

    if (raw.operations !== undefined) {
        if (!Array.isArray(raw.operations) || raw.operations.length === 0) {
            throw new Error(`${fieldName}.operations must be a non-empty array.`);
        }

        normalized.operations = raw.operations.map((operation, index) => (
            validateOutputFilterOperation(operation, `${fieldName}.operations[${index}]`)
        ));
    }

    if (raw.parser !== undefined) {
        normalized.parser = validateOutputFilterParser(raw.parser, `${fieldName}.parser`);
    }

    if (normalized.operations === undefined && normalized.parser === undefined) {
        throw new Error(`${fieldName} must define operations, parser, or both.`);
    }

    return normalized;
}

export function validateOutputFiltersConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'output-filters');
    const knownKeys = new Set(['version', 'passthrough_ceiling', 'profiles']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.version = normalizeInteger(raw.version, 'output-filters.version', { minimum: 1 });
    if (raw.passthrough_ceiling !== undefined) {
        const passthrough = ensurePlainObject(raw.passthrough_ceiling, 'output-filters.passthrough_ceiling');
        normalized.passthrough_ceiling = {
            ...passthrough,
            max_lines: normalizeInteger(passthrough.max_lines, 'output-filters.passthrough_ceiling.max_lines', { minimum: 1 }),
            strategy: normalizeNonEmptyString(passthrough.strategy, 'output-filters.passthrough_ceiling.strategy')
        };
    }

    const profiles = ensurePlainObject(raw.profiles, 'output-filters.profiles');
    const profilesMap: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(profiles)) {
        profilesMap[key] = validateOutputFilterProfile(value, `output-filters.profiles.${key}`);
    }

    if (Object.keys(profilesMap).length === 0) {
        throw new Error('output-filters.profiles must not be empty.');
    }

    normalized.profiles = profilesMap;

    return normalized;
}

export function validateSkillPacksConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'skill-packs');
    const knownKeys = new Set(['version', 'installed_packs']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.version = normalizeInteger(raw.version, 'skill-packs.version', { minimum: 1 });

    const installedPacks = normalizeStringArray(raw.installed_packs, 'skill-packs.installed_packs', { allowScalar: true });
    normalized.installed_packs = Array.from(new Set(installedPacks));

    return normalized;
}

const VALID_OPTIONAL_SKILL_SELECTION_POLICY_MODES = new Set(['off', 'optional', 'mandatory', 'advisory', 'required', 'strict']);

export function validateOptionalSkillSelectionPolicyConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'optional-skill-selection-policy');
    const knownKeys = new Set(['version', 'mode']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.version = normalizeInteger(raw.version, 'optional-skill-selection-policy.version', { minimum: 1 });

    const mode = normalizeNonEmptyString(raw.mode, 'optional-skill-selection-policy.mode').toLowerCase();
    if (!VALID_OPTIONAL_SKILL_SELECTION_POLICY_MODES.has(mode)) {
        throw new Error(
            `optional-skill-selection-policy.mode must be one of: ${[...VALID_OPTIONAL_SKILL_SELECTION_POLICY_MODES].join(', ')}.`
        );
    }
    normalized.mode = mode;

    return normalized;
}

export function validateIsolationModeConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'isolation-mode');
    const knownKeys = new Set([
        'enabled',
        'enforcement',
        'require_manifest_match_before_task',
        'refuse_on_preflight_drift',
        'use_sandbox',
        'same_user_limitation_notice'
    ]);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.enabled = normalizeBooleanLike(raw.enabled, 'isolation-mode.enabled');
    normalized.enforcement = normalizeNonEmptyString(raw.enforcement, 'isolation-mode.enforcement');
    if (normalized.enforcement !== 'STRICT' && normalized.enforcement !== 'LOG_ONLY') {
        throw new Error("isolation-mode.enforcement must be 'STRICT' or 'LOG_ONLY'.");
    }
    normalized.require_manifest_match_before_task = normalizeBooleanLike(
        raw.require_manifest_match_before_task,
        'isolation-mode.require_manifest_match_before_task'
    );
    normalized.refuse_on_preflight_drift = normalizeBooleanLike(
        raw.refuse_on_preflight_drift,
        'isolation-mode.refuse_on_preflight_drift'
    );
    normalized.use_sandbox = normalizeBooleanLike(raw.use_sandbox, 'isolation-mode.use_sandbox');

    if (raw.same_user_limitation_notice !== undefined) {
        normalized.same_user_limitation_notice = normalizeNonEmptyString(
            raw.same_user_limitation_notice,
            'isolation-mode.same_user_limitation_notice'
        );
    }

    return normalized;
}



function normalizeReviewPolicyValue(value: unknown, fieldName: string): boolean | 'auto' {
    if (value === 'auto') {
        return 'auto';
    }
    return normalizeBooleanLike(value, fieldName);
}

const REVIEW_FINDING_POLICY_ACTIONS = new Set(['fix_now', 'create_follow_up', 'ignore']);
const REVIEW_FINDING_POLICY_IDS = new Set(['soft', 'balanced', 'strict', 'custom']);
const REVIEW_FINDING_POLICY_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const REVIEW_FINDING_POLICY_PRESETS = {
    soft: {
        findings: {
            critical: 'fix_now',
            high: 'create_follow_up',
            medium: 'ignore',
            low: 'ignore'
        },
        residual_risk: 'ignore'
    },
    balanced: {
        findings: {
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'fix_now',
            low: 'create_follow_up'
        },
        residual_risk: 'create_follow_up'
    },
    strict: {
        findings: {
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'fix_now',
            low: 'fix_now'
        },
        residual_risk: 'fix_now'
    }
} as const;

function normalizeReviewFindingPolicyAction(value: unknown, fieldName: string): string {
    const action = normalizeNonEmptyString(value, fieldName);
    if (!REVIEW_FINDING_POLICY_ACTIONS.has(action)) {
        throw new Error(`${fieldName} must be one of: fix_now, create_follow_up, ignore.`);
    }
    return action;
}

function validateReviewFindingPolicy(input: unknown, fieldName: string): Record<string, unknown> {
    const raw = ensurePlainObject(input, fieldName);
    const knownKeys = ['schema_version', 'policy_id', 'findings', 'residual_risk'] as const;
    assertNoUnknownKeys(raw, knownKeys, fieldName);
    const normalized = cloneUnknownProperties(raw, new Set<string>(knownKeys));

    normalized.schema_version = normalizeInteger(raw.schema_version, `${fieldName}.schema_version`, { minimum: 1, maximum: 1 });
    const policyId = normalizeNonEmptyString(raw.policy_id, `${fieldName}.policy_id`);
    if (!REVIEW_FINDING_POLICY_IDS.has(policyId)) {
        throw new Error(`${fieldName}.policy_id must be one of: soft, balanced, strict, custom.`);
    }
    normalized.policy_id = policyId;

    const findingsRaw = ensurePlainObject(raw.findings, `${fieldName}.findings`);
    assertNoUnknownKeys(findingsRaw, REVIEW_FINDING_POLICY_SEVERITIES, `${fieldName}.findings`);
    const findings: Record<string, string> = {};
    for (const severity of REVIEW_FINDING_POLICY_SEVERITIES) {
        findings[severity] = normalizeReviewFindingPolicyAction(
            findingsRaw[severity],
            `${fieldName}.findings.${severity}`
        );
    }
    if (findings.critical !== 'fix_now') {
        throw new Error(`${fieldName}.findings.critical is immutable and must be fix_now.`);
    }
    normalized.findings = findings;
    normalized.residual_risk = normalizeReviewFindingPolicyAction(raw.residual_risk, `${fieldName}.residual_risk`);
    if (policyId !== 'custom') {
        const preset = REVIEW_FINDING_POLICY_PRESETS[policyId as keyof typeof REVIEW_FINDING_POLICY_PRESETS];
        for (const severity of REVIEW_FINDING_POLICY_SEVERITIES) {
            if (findings[severity] !== preset.findings[severity]) {
                throw new Error(`${fieldName}.findings.${severity} must match ${policyId} preset.`);
            }
        }
        if (normalized.residual_risk !== preset.residual_risk) {
            throw new Error(`${fieldName}.residual_risk must match ${policyId} preset.`);
        }
    }

    return normalized;
}

function validateReviewFollowUpPolicy(input: unknown, fieldName: string): Record<string, unknown> {
    const raw = ensurePlainObject(input, fieldName);
    const knownKeys = ['schema_version', 'materialization_mode', 'task_profile'] as const;
    assertNoUnknownKeys(raw, knownKeys, fieldName);
    const mode = normalizeNonEmptyString(raw.materialization_mode, `${fieldName}.materialization_mode`);
    if (mode !== 'per_finding' && mode !== 'grouped_by_parent') {
        throw new Error(`${fieldName}.materialization_mode must be one of: per_finding, grouped_by_parent.`);
    }
    const taskProfileRaw = raw.task_profile === undefined
        ? { mode: 'one_level_lighter', fixed_profile: null }
        : ensurePlainObject(raw.task_profile, `${fieldName}.task_profile`);
    assertNoUnknownKeys(taskProfileRaw, ['mode', 'fixed_profile'], `${fieldName}.task_profile`);
    const taskProfileMode = normalizeNonEmptyString(taskProfileRaw.mode, `${fieldName}.task_profile.mode`);
    if (!['one_level_lighter', 'inherit_parent', 'fixed_profile'].includes(taskProfileMode)) {
        throw new Error(
            `${fieldName}.task_profile.mode must be one of: one_level_lighter, inherit_parent, fixed_profile.`
        );
    }
    const fixedProfile = taskProfileRaw.fixed_profile === null || taskProfileRaw.fixed_profile === undefined
        ? null
        : normalizeNonEmptyString(taskProfileRaw.fixed_profile, `${fieldName}.task_profile.fixed_profile`).toLowerCase();
    if (taskProfileMode === 'fixed_profile' && fixedProfile === null) {
        throw new Error(`${fieldName}.task_profile.fixed_profile is required when mode is fixed_profile.`);
    }
    if (taskProfileMode !== 'fixed_profile' && fixedProfile !== null) {
        throw new Error(`${fieldName}.task_profile.fixed_profile must be null unless mode is fixed_profile.`);
    }
    return {
        schema_version: normalizeInteger(raw.schema_version, `${fieldName}.schema_version`, { minimum: 1, maximum: 1 }),
        materialization_mode: mode,
        task_profile: {
            mode: taskProfileMode,
            fixed_profile: fixedProfile
        }
    };
}

function validateProfileEntry(input: unknown, profilePath: string): Record<string, unknown> {
    const raw = ensurePlainObject(input, profilePath);
    const knownKeys = new Set([
        'description',
        'depth',
        'task_decomposition',
        'review_policy',
        'review_finding_policy',
        'review_follow_up_policy',
        'review_remediation_mode_policy',
        'review_dependency_graph',
        'token_economy',
        'skills'
    ]);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.description = normalizeNonEmptyString(raw.description, `${profilePath}.description`);
    normalized.depth = normalizeInteger(raw.depth, `${profilePath}.depth`, { minimum: 1, maximum: 3 });

    if (raw.task_decomposition !== undefined) {
        const taskDecompositionRaw = ensurePlainObject(
            raw.task_decomposition,
            `${profilePath}.task_decomposition`
        );
        const taskDecompositionKeys = Object.keys(taskDecompositionRaw);
        if (taskDecompositionKeys.length !== 1 || taskDecompositionKeys[0] !== 'enabled') {
            throw new Error(`${profilePath}.task_decomposition must be exactly { "enabled": boolean }.`);
        }
        if (typeof taskDecompositionRaw.enabled !== 'boolean') {
            throw new Error(`${profilePath}.task_decomposition.enabled must be a boolean.`);
        }
        normalized.task_decomposition = { enabled: taskDecompositionRaw.enabled };
    }

    const reviewPolicyRaw = ensurePlainObject(raw.review_policy, `${profilePath}.review_policy`);
    const reviewPolicy: Record<string, boolean | 'auto'> = {};
    for (const [key, value] of Object.entries(reviewPolicyRaw)) {
        reviewPolicy[key] = normalizeReviewPolicyValue(value, `${profilePath}.review_policy.${key}`);
    }
    normalized.review_policy = reviewPolicy;

    if (raw.review_finding_policy !== undefined) {
        normalized.review_finding_policy = validateReviewFindingPolicy(
            raw.review_finding_policy,
            `${profilePath}.review_finding_policy`
        );
    }
    if (raw.review_follow_up_policy !== undefined) {
        normalized.review_follow_up_policy = validateReviewFollowUpPolicy(
            raw.review_follow_up_policy,
            `${profilePath}.review_follow_up_policy`
        );
    }
    if (raw.review_remediation_mode_policy !== undefined) {
        normalized.review_remediation_mode_policy = validateReviewRemediationModePolicy(
            raw.review_remediation_mode_policy
        );
    }
    if (raw.review_dependency_graph !== undefined) {
        normalized.review_dependency_graph = normalizeReviewDependencyGraphDeclaration(
            raw.review_dependency_graph,
            `${profilePath}.review_dependency_graph`
        );
    }

    const ALLOWED_TOKEN_ECONOMY_KEYS = new Set(['enabled', 'strip_examples', 'strip_code_blocks', 'scoped_diffs', 'compact_reviewer_output']);
    const tokenEconomyRaw = ensurePlainObject(raw.token_economy, `${profilePath}.token_economy`);
    const tokenEconomy: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(tokenEconomyRaw)) {
        if (!ALLOWED_TOKEN_ECONOMY_KEYS.has(key)) {
            throw new Error(`${profilePath}.token_economy.${key} is not a recognized token_economy key.`);
        }
        tokenEconomy[key] = normalizeBooleanLike(value, `${profilePath}.token_economy.${key}`);
    }
    normalized.token_economy = tokenEconomy;

    const ALLOWED_SKILLS_KEYS = new Set(['auto_suggest']);
    const skillsRaw = ensurePlainObject(raw.skills, `${profilePath}.skills`);
    const skills: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(skillsRaw)) {
        if (!ALLOWED_SKILLS_KEYS.has(key)) {
            throw new Error(`${profilePath}.skills.${key} is not a recognized skills key.`);
        }
        skills[key] = normalizeBooleanLike(value, `${profilePath}.skills.${key}`);
    }
    normalized.skills = skills;

    return normalized;
}

export function validateProfilesConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'profiles');
    const knownKeys = new Set(['version', 'active_profile', 'built_in_profiles', 'user_profiles']);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.version = normalizeInteger(raw.version, 'profiles.version', { minimum: 1 });
    normalized.active_profile = normalizeNonEmptyString(raw.active_profile, 'profiles.active_profile');

    const builtInRaw = ensurePlainObject(raw.built_in_profiles, 'profiles.built_in_profiles');
    const builtIn: Record<string, Record<string, unknown>> = {};
    for (const [name, entry] of Object.entries(builtInRaw)) {
        builtIn[name] = validateProfileEntry(entry, `profiles.built_in_profiles.${name}`);
    }
    if (Object.keys(builtIn).length === 0) {
        throw new Error('profiles.built_in_profiles must contain at least one profile.');
    }
    normalized.built_in_profiles = builtIn;

    const userRaw = ensurePlainObject(raw.user_profiles, 'profiles.user_profiles');
    const user: Record<string, Record<string, unknown>> = {};
    for (const [name, entry] of Object.entries(userRaw)) {
        if (name in builtIn) {
            throw new Error(`profiles.user_profiles.${name} conflicts with a built-in profile name.`);
        }
        user[name] = validateProfileEntry(entry, `profiles.user_profiles.${name}`);
    }
    normalized.user_profiles = user;

    const allProfileNames = new Set([...Object.keys(builtIn), ...Object.keys(user)]);
    if (!allProfileNames.has(normalized.active_profile as string)) {
        throw new Error(
            `profiles.active_profile '${normalized.active_profile}' does not match any built-in or user profile.`
        );
    }

    return normalized;
}


const VALID_RETENTION_MODES = new Set(['none', 'summary', 'full']);
const VALID_COMPRESSION_FORMATS = new Set(['gzip']);

export function validateReviewArtifactStorageConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'review-artifact-storage');
    const knownKeys = new Set([
        'version',
        'retention_mode',
        'compress_after_days',
        'compression_format',
        'preserve_gate_receipts',
        'gate_receipt_suffixes',
        'privacy_notice'
    ]);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.version = normalizeInteger(raw.version, 'review-artifact-storage.version', { minimum: 1 });

    const mode = normalizeNonEmptyString(raw.retention_mode, 'review-artifact-storage.retention_mode').toLowerCase();
    if (!VALID_RETENTION_MODES.has(mode)) {
        throw new Error(
            `review-artifact-storage.retention_mode must be one of: ${[...VALID_RETENTION_MODES].join(', ')}.`
        );
    }
    normalized.retention_mode = mode;

    normalized.compress_after_days = normalizeInteger(
        raw.compress_after_days,
        'review-artifact-storage.compress_after_days',
        { minimum: 0 }
    );

    const format = normalizeNonEmptyString(
        raw.compression_format,
        'review-artifact-storage.compression_format'
    ).toLowerCase();
    if (!VALID_COMPRESSION_FORMATS.has(format)) {
        throw new Error(
            `review-artifact-storage.compression_format must be one of: ${[...VALID_COMPRESSION_FORMATS].join(', ')}.`
        );
    }
    normalized.compression_format = format;

    normalized.preserve_gate_receipts = normalizeBooleanLike(
        raw.preserve_gate_receipts,
        'review-artifact-storage.preserve_gate_receipts'
    );

    const suffixes = normalizeStringArray(
        raw.gate_receipt_suffixes,
        'review-artifact-storage.gate_receipt_suffixes',
        { allowScalar: true }
    );

    if (suffixes.length === 0) {
        throw new Error('review-artifact-storage.gate_receipt_suffixes must not be empty.');
    }

    normalized.gate_receipt_suffixes = suffixes;

    if (raw.privacy_notice !== undefined) {
        normalized.privacy_notice = normalizeOptionalString(raw.privacy_notice) ?? '';
    }

    return normalized;
}

export function validateRuntimeRetentionConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'runtime-retention');
    const knownKeys = new Set([
        'version',
        'active_tasks',
        'healthy_done',
        'problem_tasks',
        'purge',
        'daily_maintenance'
    ]);
    const normalized = cloneUnknownProperties(raw, knownKeys);

    normalized.version = normalizeInteger(raw.version, 'runtime-retention.version', { minimum: 1 });

    const activeTasks = ensurePlainObject(raw.active_tasks, 'runtime-retention.active_tasks');
    assertNoCaseMismatchedKnownKeys(
        activeTasks,
        ['protect_runtime_grace_days', 'protect_current_cycle_artifacts'],
        'runtime-retention.active_tasks'
    );
    assertNoUnknownKeys(
        activeTasks,
        ['protect_runtime_grace_days', 'protect_current_cycle_artifacts'],
        'runtime-retention.active_tasks'
    );
    normalized.active_tasks = {
        protect_runtime_grace_days: normalizeInteger(
            activeTasks.protect_runtime_grace_days,
            'runtime-retention.active_tasks.protect_runtime_grace_days',
            { minimum: 0 }
        ),
        protect_current_cycle_artifacts: normalizeBooleanLike(
            activeTasks.protect_current_cycle_artifacts,
            'runtime-retention.active_tasks.protect_current_cycle_artifacts'
        )
    };

    const healthyDone = ensurePlainObject(raw.healthy_done, 'runtime-retention.healthy_done');
    assertNoCaseMismatchedKnownKeys(
        healthyDone,
        ['compact_after_days', 'require_ledger', 'retain_task_events_until_ledger_verified'],
        'runtime-retention.healthy_done'
    );
    assertNoUnknownKeys(
        healthyDone,
        ['compact_after_days', 'require_ledger', 'retain_task_events_until_ledger_verified'],
        'runtime-retention.healthy_done'
    );
    normalized.healthy_done = {
        compact_after_days: normalizeInteger(
            healthyDone.compact_after_days,
            'runtime-retention.healthy_done.compact_after_days',
            { minimum: 0 }
        ),
        require_ledger: normalizeBooleanLike(
            healthyDone.require_ledger,
            'runtime-retention.healthy_done.require_ledger'
        ),
        retain_task_events_until_ledger_verified: normalizeBooleanLike(
            healthyDone.retain_task_events_until_ledger_verified,
            'runtime-retention.healthy_done.retain_task_events_until_ledger_verified'
        )
    };

    const problemTasks = ensurePlainObject(raw.problem_tasks, 'runtime-retention.problem_tasks');
    assertNoCaseMismatchedKnownKeys(
        problemTasks,
        ['compress_after_days', 'preserve_detailed_evidence'],
        'runtime-retention.problem_tasks'
    );
    assertNoUnknownKeys(
        problemTasks,
        ['compress_after_days', 'preserve_detailed_evidence'],
        'runtime-retention.problem_tasks'
    );
    normalized.problem_tasks = {
        compress_after_days: normalizeInteger(
            problemTasks.compress_after_days,
            'runtime-retention.problem_tasks.compress_after_days',
            { minimum: 0 }
        ),
        preserve_detailed_evidence: normalizeBooleanLike(
            problemTasks.preserve_detailed_evidence,
            'runtime-retention.problem_tasks.preserve_detailed_evidence'
        )
    };

    const purge = ensurePlainObject(raw.purge, 'runtime-retention.purge');
    assertNoCaseMismatchedKnownKeys(
        purge,
        ['require_confirm'],
        'runtime-retention.purge'
    );
    assertNoUnknownKeys(
        purge,
        ['require_confirm'],
        'runtime-retention.purge'
    );
    normalized.purge = {
        require_confirm: normalizeBooleanLike(
            purge.require_confirm,
            'runtime-retention.purge.require_confirm'
        )
    };

    const dailyMaintenance = ensurePlainObject(raw.daily_maintenance, 'runtime-retention.daily_maintenance');
    assertNoCaseMismatchedKnownKeys(
        dailyMaintenance,
        ['enabled', 'max_tasks_per_run', 'eligible_older_than_days', 'keep_latest_tasks', 'dry_run'],
        'runtime-retention.daily_maintenance'
    );
    assertNoUnknownKeys(
        dailyMaintenance,
        ['enabled', 'max_tasks_per_run', 'eligible_older_than_days', 'keep_latest_tasks', 'dry_run'],
        'runtime-retention.daily_maintenance'
    );
    normalized.daily_maintenance = {
        enabled: normalizeBooleanLike(
            dailyMaintenance.enabled,
            'runtime-retention.daily_maintenance.enabled'
        ),
        max_tasks_per_run: normalizeInteger(
            dailyMaintenance.max_tasks_per_run,
            'runtime-retention.daily_maintenance.max_tasks_per_run',
            { minimum: 1 }
        ),
        eligible_older_than_days: dailyMaintenance.eligible_older_than_days === undefined
            ? 30
            : normalizeInteger(
                dailyMaintenance.eligible_older_than_days,
                'runtime-retention.daily_maintenance.eligible_older_than_days',
                { minimum: 0 }
            ),
        keep_latest_tasks: dailyMaintenance.keep_latest_tasks === undefined
            ? 0
            : normalizeInteger(
                dailyMaintenance.keep_latest_tasks,
                'runtime-retention.daily_maintenance.keep_latest_tasks',
                { minimum: 0 }
            ),
        dry_run: dailyMaintenance.dry_run === undefined
            ? true
            : normalizeBooleanLike(
                dailyMaintenance.dry_run,
                'runtime-retention.daily_maintenance.dry_run'
            )
    };

    return normalized;
}
