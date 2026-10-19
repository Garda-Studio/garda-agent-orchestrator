import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    getDefaultReviewCapabilities,
    readReviewCapabilitiesConfigFile,
    type ReviewCapabilitiesConfigMap
} from '../core/review-capabilities';
import { readReviewCatalogConfigFile } from '../core/review-catalog';
import type { ReviewDependencyGraphDeclaration } from '../core/review-dependency-graph';
import {
    resolveProfileReviewCatalogPolicy,
    type ResolvedProfileReviewCatalogPolicy
} from './profile-review-catalog-policy';
import {
    loadReviewTriggerPolicy,
    type ReviewTriggerPolicy
} from './review-trigger-policy';
import {
    resolveReviewRemediationModePolicyFromProfile,
    type ReviewRemediationModePolicy,
    type ReviewRemediationModePolicyResolution
} from './review-remediation-mode-policy';

export {
    analyzeProfileReviewCatalogPolicy,
    resolveProfileReviewCatalogPolicy
} from './profile-review-catalog-policy';
export type {
    ProfileReviewCatalogLane,
    ProfileReviewCatalogPolicyAnalysis,
    ProfileReviewCatalogState,
    ResolvedProfileReviewCatalogPolicy
} from './profile-review-catalog-policy';
import { DEFAULT_RUNTIME_ROOTS } from './default-path-regexes';

export interface ProfileReviewPolicy {
    code: boolean | 'auto';
    db: boolean | 'auto';
    security: boolean | 'auto';
    refactor: boolean | 'auto';
    [key: string]: boolean | 'auto';
}

export interface ProfileTokenEconomy {
    enabled: boolean;
    strip_examples: boolean;
    strip_code_blocks: boolean;
    scoped_diffs: boolean;
    compact_reviewer_output: boolean;
}

export interface ProfileSkills {
    auto_suggest: boolean;
    [key: string]: boolean;
}

export interface ProfileTaskDecompositionConfig {
    enabled: boolean;
}

export type ProfileTaskDecompositionProvenance =
    | 'explicit_profile_config'
    | 'legacy_strict_compatibility'
    | 'legacy_balanced_default'
    | 'legacy_disabled_default'
    | 'legacy_snapshot_strict_compatibility'
    | 'legacy_snapshot_balanced_default'
    | 'legacy_snapshot_disabled_default';

export interface ResolvedProfileTaskDecompositionPolicy {
    enabled: boolean;
    configured: boolean;
    provenance: ProfileTaskDecompositionProvenance;
    diagnostics: string[];
    valid: boolean;
}

export type ReviewFindingDispositionAction = 'fix_now' | 'create_follow_up' | 'ignore';
export type CriticalReviewFindingDispositionAction = 'fix_now';
export type ReviewFindingPolicyId = 'soft' | 'balanced' | 'strict' | 'custom';

export interface ReviewFindingPolicy {
    schema_version: 1;
    policy_id: ReviewFindingPolicyId;
    findings: {
        critical: CriticalReviewFindingDispositionAction;
        high: ReviewFindingDispositionAction;
        medium: ReviewFindingDispositionAction;
        low: ReviewFindingDispositionAction;
    };
    residual_risk: ReviewFindingDispositionAction;
}

export interface ReviewFindingPolicyResolution {
    policy: ReviewFindingPolicy;
    diagnostics: string[];
    migration_required: boolean;
}

export type ReviewFollowUpMaterializationMode = 'per_finding' | 'grouped_by_parent';
export type ReviewFollowUpTaskProfileMode = 'one_level_lighter' | 'inherit_parent' | 'fixed_profile';

export interface ReviewFollowUpTaskProfilePolicy {
    mode: ReviewFollowUpTaskProfileMode;
    fixed_profile: string | null;
}

export interface ReviewFollowUpPolicy {
    schema_version: 1;
    materialization_mode: ReviewFollowUpMaterializationMode;
    task_profile: ReviewFollowUpTaskProfilePolicy;
}

export interface ReviewFollowUpPolicyResolution {
    policy: ReviewFollowUpPolicy;
    diagnostics: string[];
}

export type ReviewFollowUpTaskProfileAssignmentSource =
    | 'one_level_lighter'
    | 'inherit_parent'
    | 'fixed_profile'
    | 'safe_inherit_parent';

export interface ReviewFollowUpTaskProfileAssignment {
    parent_profile: string;
    profile: string;
    source: ReviewFollowUpTaskProfileAssignmentSource;
    configured_mode: ReviewFollowUpTaskProfileMode;
    diagnostics: string[];
}

export interface ProfileEntry {
    description: string;
    depth: number;
    task_decomposition?: ProfileTaskDecompositionConfig;
    review_policy: ProfileReviewPolicy;
    review_finding_policy?: ReviewFindingPolicy;
    review_follow_up_policy?: ReviewFollowUpPolicy;
    review_remediation_mode_policy?: ReviewRemediationModePolicy;
    review_dependency_graph?: ReviewDependencyGraphDeclaration;
    token_economy: ProfileTokenEconomy;
    skills: ProfileSkills;
}

export interface ProfilesData {
    version: number;
    active_profile: string;
    built_in_profiles: Record<string, ProfileEntry>;
    user_profiles: Record<string, ProfileEntry>;
}

export interface TokenEconomyConfig {
    enabled: boolean;
    enabled_depths: number[];
    strip_examples: boolean;
    strip_code_blocks: boolean;
    scoped_diffs: boolean;
    compact_reviewer_output: boolean;
    fail_tail_lines: number;
}

export interface SkillPacksConfig {
    version: number;
    installed_packs: string[];
}

export interface EffectiveReviewPolicy {
    code: boolean;
    db: boolean | 'auto';
    security: boolean | 'auto';
    refactor: boolean | 'auto';
    api: boolean | 'auto';
    test: boolean | 'auto';
    performance: boolean | 'auto';
    infra: boolean | 'auto';
    dependency: boolean | 'auto';
    [key: string]: boolean | 'auto';
}

export interface PathsConfig {
    metrics_path: string;
    runtime_roots: string[];
    fast_path_roots: string[];
    fast_path_allowed_regexes: string[];
    fast_path_sensitive_regexes: string[];
    sql_or_migration_regexes: string[];
    triggers: Record<string, string[]>;
    code_like_regexes: string[];
}

export interface EffectivePolicy {
    profile_name: string;
    profile_source: 'built_in' | 'user';
    depth: number;
    task_decomposition: ResolvedProfileTaskDecompositionPolicy;
    review_policy: EffectiveReviewPolicy;
    review_catalog_policy?: ResolvedProfileReviewCatalogPolicy;
    review_finding_policy: ReviewFindingPolicy;
    review_finding_policy_diagnostics: string[];
    review_follow_up_policy: ReviewFollowUpPolicy;
    review_follow_up_policy_diagnostics: string[];
    review_remediation_mode_policy: ReviewRemediationModePolicyResolution;
    token_economy: TokenEconomyConfig;
    skills: ProfileSkills;
    installed_packs: string[];
    paths: PathsConfig;
    review_trigger_policy: ReviewTriggerPolicy;
    safety_floors_applied: string[];
    scope_category: string | null;
    guardrail_diagnostics: ProfileGuardrailResult | null;
    resolution_sources: {
        profiles: string;
        review_catalog?: string;
        review_capabilities: string;
        token_economy: string;
        skill_packs: string;
        paths: string;
    };
}

export function resolveProfileTaskDecompositionPolicy(
    configInput: unknown,
    profileName: string
): ResolvedProfileTaskDecompositionPolicy {
    if (configInput === undefined) {
        const normalizedProfile = profileName.trim().toLowerCase();
        const enabledByDefault = normalizedProfile === 'strict' || normalizedProfile === 'balanced';
        return {
            enabled: enabledByDefault,
            configured: false,
            provenance: normalizedProfile === 'strict'
                ? 'legacy_strict_compatibility'
                : normalizedProfile === 'balanced'
                    ? 'legacy_balanced_default'
                    : 'legacy_disabled_default',
            diagnostics: [enabledByDefault
                ? `Profile '${profileName}' is missing task_decomposition; defaulted guarded task decomposition to enabled.`
                : `Profile '${profileName}' is missing task_decomposition; defaulted guarded task decomposition to disabled.`],
            valid: true
        };
    }
    if (
        !isPlainRecord(configInput)
        || Object.keys(configInput).length !== 1
        || !Object.hasOwn(configInput, 'enabled')
        || typeof configInput.enabled !== 'boolean'
    ) {
        return {
            enabled: false,
            configured: true,
            provenance: 'explicit_profile_config',
            diagnostics: [
                `Profile '${profileName}' has invalid task_decomposition; expected exactly { "enabled": boolean }. Resolved fail-closed to disabled.`
            ],
            valid: false
        };
    }
    return {
        enabled: configInput.enabled,
        configured: true,
        provenance: 'explicit_profile_config',
        diagnostics: [],
        valid: true
    };
}

export interface ResolveOptions {
    /** Override the profile name instead of using active_profile. */
    profileOverride?: string;
    /** Whether the task scope involves code changes (triggers safety floors). */
    isCodeChangingTask?: boolean;
    /** Scope category from preflight classification. */
    scopeCategory?: string;
    /** Domain-surface evidence from the current preflight trigger set. */
    domainSurface?: Record<string, boolean>;
    /** Explicit escape hatch for operators that intentionally want every domain review. */
    forceAllDomainReviews?: boolean;
    /** Explicit task/preflight request to keep code review enabled. */
    forceCodeReview?: boolean;
    /** Current preflight proved that only localization files remain after review-trigger filtering. */
    localizationOnlyScope?: boolean;
    /** Whether current scope touches protected orchestrator control-plane files. */
    protectedControlPlaneChanged?: boolean;
    /** Whether every protected control-plane change is documentation-only surface. */
    protectedControlPlaneDocsOnly?: boolean;
    /** Current preflight proved a clean BASELINE_ONLY scope with no reviewable diff. */
    zeroDiffBaselineOnly?: boolean;
}

/**
 * Safety floors enforced when the task scope involves code changes.
 * These reviews are mandatory regardless of profile settings.
 */
const CODE_CHANGING_SAFETY_FLOORS: ReadonlyMap<string, boolean> = new Map([
    ['code', true],
    ['security', true],
    ['db', true],
    ['refactor', true]
]);

/**
 * Scope categories that are eligible for profile-driven review lightening.
 * Only these non-code categories allow profiles to relax mandatory reviews.
 */
const LIGHTENABLE_SCOPE_CATEGORIES = new Set(['docs-only', 'test-only', 'config-only', 'audit-only']);
const TRIGGER_GATED_AUTO_REVIEW_TYPES = new Set([
    'db',
    'security',
    'refactor',
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
]);
const TEST_ONLY_SUPPRESSIBLE_REVIEW_TYPES = new Set(['code', 'security', 'refactor', 'performance']);
const DOCS_ONLY_SUPPRESSIBLE_REVIEW_TYPES = new Set(['code', 'refactor', 'test', 'performance']);
const LOCALIZATION_ONLY_SUPPRESSIBLE_REVIEW_TYPES = new Set(['code', 'security', 'refactor', 'test', 'performance']);
const REVIEW_FINDING_POLICY_SCHEMA_VERSION = 1 as const;
const REVIEW_FINDING_POLICY_ACTIONS = new Set<ReviewFindingDispositionAction>([
    'fix_now',
    'create_follow_up',
    'ignore'
]);
const REVIEW_FINDING_POLICY_IDS = new Set<ReviewFindingPolicyId>([
    'soft',
    'balanced',
    'strict',
    'custom'
]);
const REVIEW_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const REVIEW_FOLLOW_UP_MATERIALIZATION_MODES = new Set<ReviewFollowUpMaterializationMode>([
    'per_finding',
    'grouped_by_parent'
]);
const REVIEW_FOLLOW_UP_TASK_PROFILE_MODES = new Set<ReviewFollowUpTaskProfileMode>([
    'one_level_lighter',
    'inherit_parent',
    'fixed_profile'
]);
const BUILT_IN_FOLLOW_UP_PROFILE_LADDER: Readonly<Record<string, string>> = Object.freeze({
    strict: 'balanced',
    balanced: 'fast',
    fast: 'fast'
});

export const DEFAULT_REVIEW_FOLLOW_UP_POLICY: Readonly<ReviewFollowUpPolicy> = Object.freeze({
    schema_version: 1,
    materialization_mode: 'per_finding',
    task_profile: Object.freeze({
        mode: 'one_level_lighter',
        fixed_profile: null
    })
});

export const REVIEW_FINDING_POLICY_PRESETS: Readonly<Record<'soft' | 'balanced' | 'strict', ReviewFindingPolicy>> = Object.freeze({
    soft: Object.freeze({
        schema_version: REVIEW_FINDING_POLICY_SCHEMA_VERSION,
        policy_id: 'soft',
        findings: Object.freeze({
            critical: 'fix_now',
            high: 'create_follow_up',
            medium: 'ignore',
            low: 'ignore'
        }),
        residual_risk: 'ignore'
    }),
    balanced: Object.freeze({
        schema_version: REVIEW_FINDING_POLICY_SCHEMA_VERSION,
        policy_id: 'balanced',
        findings: Object.freeze({
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'fix_now',
            low: 'create_follow_up'
        }),
        residual_risk: 'create_follow_up'
    }),
    strict: Object.freeze({
        schema_version: REVIEW_FINDING_POLICY_SCHEMA_VERSION,
        policy_id: 'strict',
        findings: Object.freeze({
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'fix_now',
            low: 'fix_now'
        }),
        residual_risk: 'fix_now'
    })
});

export interface ProfileReviewDecision {
    review_type: string;
    profile_wanted: boolean | 'auto';
    effective_value: boolean;
    decision:
        | 'profile_override'
        | 'profile_forced'
        | 'safety_floor_enforced'
        | 'capability_default'
        | 'lightened_by_profile'
        | 'domain_triggered'
        | 'preflight_required'
        | 'zero_diff_no_reviewable_scope'
        | 'not_applicable_no_domain_surface';
    reason: string;
}

export interface ProfileGuardrailResult {
    scope_category: string;
    is_code_changing_task: boolean;
    profile_name: string;
    guardrails_active: boolean;
    lightening_eligible: boolean;
    zero_diff_no_reviewable_scope: boolean;
    decisions: ProfileReviewDecision[];
    safety_floors_applied: string[];
}

export interface ProfileGuardrailOptions {
    domainSurface?: Record<string, boolean>;
    forceAllDomainReviews?: boolean;
    forceCodeReview?: boolean;
    localizationOnlyScope?: boolean;
    protectedControlPlaneChanged?: boolean;
    protectedControlPlaneDocsOnly?: boolean;
    zeroDiffBaselineOnly?: boolean;
}

function shouldLightenReviewForDocsOnlyScope(
    reviewType: string,
    profileValue: boolean | 'auto' | undefined,
    scopeCategory: string,
    options: ProfileGuardrailOptions
): boolean {
    if (profileValue !== true || scopeCategory !== 'docs-only') {
        return false;
    }
    if (DOCS_ONLY_SUPPRESSIBLE_REVIEW_TYPES.has(reviewType)) {
        return (
            options.protectedControlPlaneChanged !== true
            || options.protectedControlPlaneDocsOnly === true
        );
    }
    if (reviewType === 'security') {
        return options.domainSurface !== undefined && options.domainSurface.security === false;
    }
    return false;
}

function shouldLightenReviewForTestOnlyScope(
    reviewType: string,
    scopeCategory: string,
    options: ProfileGuardrailOptions
): boolean {
    if (
        scopeCategory !== 'test-only'
        || !TEST_ONLY_SUPPRESSIBLE_REVIEW_TYPES.has(reviewType)
        || options.protectedControlPlaneChanged === true
        || (reviewType === 'code' && options.forceCodeReview === true)
    ) {
        return false;
    }
    if (reviewType === 'security') {
        return options.domainSurface !== undefined && options.domainSurface.security === false;
    }
    return true;
}

function shouldLightenReviewForLocalizationOnlyScope(
    reviewType: string,
    options: ProfileGuardrailOptions
): boolean {
    return options.localizationOnlyScope === true
        && !options.forceCodeReview
        && LOCALIZATION_ONLY_SUPPRESSIBLE_REVIEW_TYPES.has(reviewType);
}

function hasAnyDomainSurface(domainSurface: Record<string, boolean> | undefined): boolean {
    if (!domainSurface) {
        return false;
    }
    return Object.values(domainSurface).some((value) => value === true);
}

function isZeroDiffNoReviewableScope(scopeCategory: string, options: ProfileGuardrailOptions): boolean {
    return scopeCategory === 'empty'
        && options.zeroDiffBaselineOnly === true
        && options.forceAllDomainReviews !== true
        && options.forceCodeReview !== true
        && options.protectedControlPlaneChanged !== true
        && options.domainSurface !== undefined
        && !hasAnyDomainSurface(options.domainSurface);
}

function readJsonFile<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
}

function cloneReviewFindingPolicy(policy: ReviewFindingPolicy): ReviewFindingPolicy {
    return {
        schema_version: policy.schema_version,
        policy_id: policy.policy_id,
        findings: { ...policy.findings },
        residual_risk: policy.residual_risk
    };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isReviewFindingDispositionAction(value: unknown): value is ReviewFindingDispositionAction {
    return typeof value === 'string'
        && REVIEW_FINDING_POLICY_ACTIONS.has(value as ReviewFindingDispositionAction);
}

export function isReviewFindingPolicyId(value: unknown): value is ReviewFindingPolicyId {
    return typeof value === 'string'
        && REVIEW_FINDING_POLICY_IDS.has(value as ReviewFindingPolicyId);
}

export function isCriticalReviewFindingDispositionAction(
    value: unknown
): value is CriticalReviewFindingDispositionAction {
    return value === 'fix_now';
}

function formatReviewFindingPolicy(policy: ReviewFindingPolicy): string {
    return [
        `policy_id=${policy.policy_id}`,
        ...REVIEW_FINDING_SEVERITIES.map((severity) => `${severity}=${policy.findings[severity]}`),
        `residual_risk=${policy.residual_risk}`
    ].join(', ');
}

function presetMismatchReason(policy: ReviewFindingPolicy): string | null {
    if (policy.policy_id === 'custom') {
        return null;
    }
    const preset = REVIEW_FINDING_POLICY_PRESETS[policy.policy_id];
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        if (policy.findings[severity] !== preset.findings[severity]) {
            return `review_finding_policy.${severity} does not match ${policy.policy_id} preset.`;
        }
    }
    if (policy.residual_risk !== preset.residual_risk) {
        return `review_finding_policy.residual_risk does not match ${policy.policy_id} preset.`;
    }
    return null;
}

export function resolveReviewFindingPolicy(
    policyInput: unknown,
    profileName: string
): ReviewFindingPolicyResolution {
    const strictPolicy = cloneReviewFindingPolicy(REVIEW_FINDING_POLICY_PRESETS.strict);
    const diagnostics: string[] = [];

    if (policyInput === undefined) {
        return {
            policy: strictPolicy,
            migration_required: true,
            diagnostics: [
                `Profile '${profileName}' is missing review_finding_policy; resolved fail-closed to strict. Add review_finding_policy to migrate this legacy profile.`
            ]
        };
    }
    if (!isPlainRecord(policyInput)) {
        return {
            policy: strictPolicy,
            migration_required: true,
            diagnostics: [
                `Profile '${profileName}' has invalid review_finding_policy; resolved fail-closed to strict.`
            ]
        };
    }

    const allowedKeys = new Set(['schema_version', 'policy_id', 'findings', 'residual_risk']);
    const unknownKeys = Object.keys(policyInput).filter((key) => !allowedKeys.has(key));
    const policyId = policyInput.policy_id;
    if (
        policyInput.schema_version !== REVIEW_FINDING_POLICY_SCHEMA_VERSION
        || !isReviewFindingPolicyId(policyId)
        || unknownKeys.length > 0
        || !isPlainRecord(policyInput.findings)
    ) {
        return {
            policy: strictPolicy,
            migration_required: true,
            diagnostics: [
                `Profile '${profileName}' has malformed review_finding_policy; resolved fail-closed to strict.`
            ]
        };
    }

    const findings: ReviewFindingPolicy['findings'] = {
        critical: 'fix_now',
        high: 'fix_now',
        medium: 'fix_now',
        low: 'fix_now'
    };
    const findingKeys = Object.keys(policyInput.findings);
    const unknownFindingKeys = findingKeys.filter((key) => !(REVIEW_FINDING_SEVERITIES as readonly string[]).includes(key));
    if (unknownFindingKeys.length > 0) {
        return {
            policy: strictPolicy,
            migration_required: true,
            diagnostics: [
                `Profile '${profileName}' has malformed review_finding_policy findings; resolved fail-closed to strict.`
            ]
        };
    }
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        const action = policyInput.findings[severity];
        if (!isReviewFindingDispositionAction(action)) {
            return {
                policy: strictPolicy,
                migration_required: true,
                diagnostics: [
                    `Profile '${profileName}' has invalid review_finding_policy.findings.${severity}; resolved fail-closed to strict.`
                ]
            };
        }
        if (severity === 'critical') {
            if (!isCriticalReviewFindingDispositionAction(action)) {
                return {
                    policy: strictPolicy,
                    migration_required: true,
                    diagnostics: [
                        `Profile '${profileName}' attempted to weaken critical finding disposition; critical is an immutable safety floor. ` +
                        'Resolved fail-closed to strict.'
                    ]
                };
            }
            findings.critical = action;
            continue;
        }
        findings[severity] = action;
    }
    if (!isReviewFindingDispositionAction(policyInput.residual_risk)) {
        return {
            policy: strictPolicy,
            migration_required: true,
            diagnostics: [
                `Profile '${profileName}' has invalid review_finding_policy.residual_risk; resolved fail-closed to strict.`
            ]
        };
    }

    const policy: ReviewFindingPolicy = {
        schema_version: REVIEW_FINDING_POLICY_SCHEMA_VERSION,
        policy_id: policyId as ReviewFindingPolicyId,
        findings,
        residual_risk: policyInput.residual_risk
    };
    const presetMismatch = presetMismatchReason(policy);
    if (presetMismatch) {
        return {
            policy: strictPolicy,
            migration_required: true,
            diagnostics: [
                `Profile '${profileName}' has inconsistent ${policy.policy_id} review_finding_policy; ${presetMismatch} Resolved fail-closed to strict.`
            ]
        };
    }

    diagnostics.push(`Profile '${profileName}' review_finding_policy resolved: ${formatReviewFindingPolicy(policy)}.`);
    return { policy, diagnostics, migration_required: false };
}

export function resolveReviewFollowUpPolicy(
    policyInput: unknown,
    profileName: string
): ReviewFollowUpPolicyResolution {
    const legacyDefault: ReviewFollowUpPolicy = {
        ...DEFAULT_REVIEW_FOLLOW_UP_POLICY,
        task_profile: { ...DEFAULT_REVIEW_FOLLOW_UP_POLICY.task_profile }
    };
    if (policyInput === undefined) {
        return {
            policy: legacyDefault,
            diagnostics: [
                `Profile '${profileName}' is missing review_follow_up_policy; defaulted compatibly to per_finding ` +
                'with one_level_lighter follow-up task profiles.'
            ]
        };
    }
    if (!isPlainRecord(policyInput)) {
        return {
            policy: legacyDefault,
            diagnostics: [`Profile '${profileName}' has invalid review_follow_up_policy; defaulted to per_finding.`]
        };
    }
    const allowedKeys = new Set(['schema_version', 'materialization_mode', 'task_profile']);
    const mode = policyInput.materialization_mode;
    if (
        policyInput.schema_version !== 1
        || typeof mode !== 'string'
        || !REVIEW_FOLLOW_UP_MATERIALIZATION_MODES.has(mode as ReviewFollowUpMaterializationMode)
        || Object.keys(policyInput).some((key) => !allowedKeys.has(key))
    ) {
        return {
            policy: legacyDefault,
            diagnostics: [
                `Profile '${profileName}' has malformed review_follow_up_policy; defaulted to per_finding ` +
                'with one_level_lighter follow-up task profiles.'
            ]
        };
    }
    const taskProfileInput = policyInput.task_profile;
    if (taskProfileInput === undefined) {
        return {
            policy: {
                schema_version: 1,
                materialization_mode: mode as ReviewFollowUpMaterializationMode,
                task_profile: { ...DEFAULT_REVIEW_FOLLOW_UP_POLICY.task_profile }
            },
            diagnostics: [
                `Profile '${profileName}' resolved a legacy review_follow_up_policy; ` +
                `materialization_mode=${mode}, task_profile.mode=one_level_lighter by default.`
            ]
        };
    }
    const safeTaskProfile: ReviewFollowUpTaskProfilePolicy = {
        mode: 'inherit_parent',
        fixed_profile: null
    };
    if (!isPlainRecord(taskProfileInput)) {
        return {
            policy: { schema_version: 1, materialization_mode: mode as ReviewFollowUpMaterializationMode, task_profile: safeTaskProfile },
            diagnostics: [
                `Profile '${profileName}' has invalid review_follow_up_policy.task_profile; ` +
                'resolved fail-closed to inherit_parent.'
            ]
        };
    }
    const taskProfileMode = taskProfileInput.mode;
    const fixedProfile = taskProfileInput.fixed_profile === null || taskProfileInput.fixed_profile === undefined
        ? null
        : (typeof taskProfileInput.fixed_profile === 'string' ? taskProfileInput.fixed_profile.trim().toLowerCase() : '');
    const taskProfileKeys = new Set(['mode', 'fixed_profile']);
    const taskProfileMalformed = typeof taskProfileMode !== 'string'
        || !REVIEW_FOLLOW_UP_TASK_PROFILE_MODES.has(taskProfileMode as ReviewFollowUpTaskProfileMode)
        || Object.keys(taskProfileInput).some((key) => !taskProfileKeys.has(key))
        || (taskProfileMode === 'fixed_profile' && !fixedProfile)
        || (taskProfileMode !== 'fixed_profile' && fixedProfile !== null);
    if (taskProfileMalformed) {
        return {
            policy: { schema_version: 1, materialization_mode: mode as ReviewFollowUpMaterializationMode, task_profile: safeTaskProfile },
            diagnostics: [
                `Profile '${profileName}' has malformed review_follow_up_policy.task_profile; ` +
                'resolved fail-closed to inherit_parent.'
            ]
        };
    }
    const taskProfile: ReviewFollowUpTaskProfilePolicy = {
        mode: taskProfileMode as ReviewFollowUpTaskProfileMode,
        fixed_profile: fixedProfile
    };
    return {
        policy: { schema_version: 1, materialization_mode: mode as ReviewFollowUpMaterializationMode, task_profile: taskProfile },
        diagnostics: [
            `Profile '${profileName}' review_follow_up_policy resolved: materialization_mode=${mode}, ` +
            `task_profile.mode=${taskProfile.mode}` +
            `${taskProfile.fixed_profile ? `, task_profile.fixed_profile=${taskProfile.fixed_profile}` : ''}.`
        ]
    };
}

export function resolveReviewFollowUpTaskProfileAssignment(
    policy: ReviewFollowUpPolicy,
    parentProfile: string,
    availableProfiles: readonly string[]
): ReviewFollowUpTaskProfileAssignment {
    const normalizedParent = parentProfile.trim().toLowerCase();
    const available = new Set(availableProfiles.map((profile) => profile.trim().toLowerCase()).filter(Boolean));
    const configuredMode = policy.task_profile.mode;
    if (configuredMode === 'inherit_parent') {
        return {
            parent_profile: normalizedParent,
            profile: normalizedParent,
            source: 'inherit_parent',
            configured_mode: configuredMode,
            diagnostics: [`Follow-up task profile inherited parent profile '${normalizedParent}'.`]
        };
    }
    if (configuredMode === 'fixed_profile') {
        const fixedProfile = policy.task_profile.fixed_profile;
        if (fixedProfile && available.has(fixedProfile)) {
            return {
                parent_profile: normalizedParent,
                profile: fixedProfile,
                source: 'fixed_profile',
                configured_mode: configuredMode,
                diagnostics: [`Follow-up task profile fixed to '${fixedProfile}'.`]
            };
        }
        return {
            parent_profile: normalizedParent,
            profile: normalizedParent,
            source: 'safe_inherit_parent',
            configured_mode: configuredMode,
            diagnostics: [
                `Configured fixed follow-up task profile '${fixedProfile || '<missing>'}' is unavailable; ` +
                `resolved fail-closed to parent profile '${normalizedParent}'.`
            ]
        };
    }
    const lighterProfile = BUILT_IN_FOLLOW_UP_PROFILE_LADDER[normalizedParent];
    if (lighterProfile && available.has(lighterProfile)) {
        return {
            parent_profile: normalizedParent,
            profile: lighterProfile,
            source: 'one_level_lighter',
            configured_mode: configuredMode,
            diagnostics: [`Follow-up task profile lowered from '${normalizedParent}' to '${lighterProfile}'.`]
        };
    }
    return {
        parent_profile: normalizedParent,
        profile: normalizedParent,
        source: 'safe_inherit_parent',
        configured_mode: configuredMode,
        diagnostics: [
            `Profile '${normalizedParent}' has no canonical lighter built-in profile; ` +
            'follow-up task profile inherited the parent instead of guessing an order.'
        ]
    };
}

export function loadProfilesData(profilesPath: string): ProfilesData {
    const data = readJsonFile<ProfilesData>(profilesPath);
    if (!data) throw new Error(`Profiles config not found: ${profilesPath}`);
    if (!data.active_profile || !data.built_in_profiles) {
        throw new Error(`Invalid profiles config at: ${profilesPath}`);
    }
    return data;
}

export type ReviewCapabilities = ReviewCapabilitiesConfigMap;

export function loadReviewCapabilities(configPath: string): ReviewCapabilities {
    try {
        return readReviewCapabilitiesConfigFile(configPath);
    } catch {
        return getDefaultReviewCapabilities();
    }
}

export function loadTokenEconomyConfig(configPath: string): TokenEconomyConfig {
    const defaults: TokenEconomyConfig = {
        enabled: true,
        enabled_depths: [1, 2],
        strip_examples: true,
        strip_code_blocks: true,
        scoped_diffs: true,
        compact_reviewer_output: true,
        fail_tail_lines: 50
    };
    const data = readJsonFile<Record<string, unknown>>(configPath);
    if (!data) return defaults;
    if (typeof data.enabled === 'boolean') defaults.enabled = data.enabled;
    if (Array.isArray(data.enabled_depths)) {
        defaults.enabled_depths = data.enabled_depths.filter((v): v is number => typeof v === 'number');
    }
    if (typeof data.strip_examples === 'boolean') defaults.strip_examples = data.strip_examples;
    if (typeof data.strip_code_blocks === 'boolean') defaults.strip_code_blocks = data.strip_code_blocks;
    if (typeof data.scoped_diffs === 'boolean') defaults.scoped_diffs = data.scoped_diffs;
    if (typeof data.compact_reviewer_output === 'boolean') defaults.compact_reviewer_output = data.compact_reviewer_output;
    if (typeof data.fail_tail_lines === 'number' && data.fail_tail_lines >= 1) defaults.fail_tail_lines = data.fail_tail_lines;
    return defaults;
}

export function loadSkillPacksConfig(configPath: string): SkillPacksConfig {
    const defaults: SkillPacksConfig = { version: 1, installed_packs: [] };
    const data = readJsonFile<Record<string, unknown>>(configPath);
    if (!data) return defaults;
    if (typeof data.version === 'number') defaults.version = data.version;
    if (Array.isArray(data.installed_packs)) {
        defaults.installed_packs = data.installed_packs.filter((v): v is string => typeof v === 'string');
    }
    return defaults;
}

const DEFAULT_PATHS_CONFIG: PathsConfig = {
    metrics_path: '',
    runtime_roots: [...DEFAULT_RUNTIME_ROOTS],
    fast_path_roots: ['frontend/', 'web/', 'ui/', 'mobile/', 'apps/'],
    fast_path_allowed_regexes: [],
    fast_path_sensitive_regexes: [],
    sql_or_migration_regexes: [],
    triggers: {},
    code_like_regexes: []
};

export function loadPathsConfig(configPath: string): PathsConfig {
    const defaults: PathsConfig = { ...DEFAULT_PATHS_CONFIG, triggers: { ...DEFAULT_PATHS_CONFIG.triggers } };
    const data = readJsonFile<Record<string, unknown>>(configPath);
    if (!data) return defaults;
    if (typeof data.metrics_path === 'string') defaults.metrics_path = data.metrics_path;
    for (const arrayKey of [
        'runtime_roots', 'fast_path_roots', 'fast_path_allowed_regexes',
        'fast_path_sensitive_regexes', 'sql_or_migration_regexes', 'code_like_regexes'
    ] as const) {
        if (Array.isArray(data[arrayKey])) {
            defaults[arrayKey] = (data[arrayKey] as unknown[]).filter((v): v is string => typeof v === 'string');
        }
    }
    if (data.triggers && typeof data.triggers === 'object' && !Array.isArray(data.triggers)) {
        const rawTriggers = data.triggers as Record<string, unknown>;
        const triggers: Record<string, string[]> = {};
        for (const [key, value] of Object.entries(rawTriggers)) {
            if (Array.isArray(value)) {
                triggers[key] = value.filter((v): v is string => typeof v === 'string');
            }
        }
        defaults.triggers = triggers;
    }
    return defaults;
}

export function getProfileEntry(data: ProfilesData, name: string): ProfileEntry | null {
    if (Object.hasOwn(data.built_in_profiles, name)) return data.built_in_profiles[name];
    if (Object.hasOwn(data.user_profiles, name)) return data.user_profiles[name];
    return null;
}

export function getProfileSource(data: ProfilesData, name: string): 'built_in' | 'user' | null {
    if (Object.hasOwn(data.built_in_profiles, name)) return 'built_in';
    if (Object.hasOwn(data.user_profiles, name)) return 'user';
    return null;
}

/**
 * Merge profile review_policy overlay onto review-capabilities config.
 *
 * Resolution rules:
 * - Profile `true` / `false` overrides the capability-level default.
 * - Profile `"auto"` defers to the review-capabilities config value.
 * - Capabilities not mentioned in the profile are passed through unchanged.
 * - After merge, safety floors are applied for code-changing tasks.
 *
 * Safety floors for code-changing tasks enforce:
 * - `code: true` — mandatory code review
 * - `security: true` — mandatory when trigger fires (enforced via 'auto' floor)
 * - `db: true` — mandatory when trigger fires (enforced via 'auto' floor)
 * - `refactor: true` — mandatory when trigger fires (enforced via 'auto' floor)
 *
 * For non-code scopes (docs-only, config-only, audit-only), profiles may relax
 * reviews freely.
 */
export function mergeReviewPolicy(
    profilePolicy: ProfileReviewPolicy,
    capabilities: ReviewCapabilities,
    isCodeChangingTask: boolean
): { merged: EffectiveReviewPolicy; floorsApplied: string[] } {
    const merged: EffectiveReviewPolicy = {} as EffectiveReviewPolicy;
    const floorsApplied: string[] = [];

    for (const key of Object.keys(capabilities)) {
        const profileValue = key in profilePolicy ? profilePolicy[key] : undefined;
        if (profileValue === 'auto' || profileValue === undefined) {
            merged[key] = capabilities[key] ? capabilities[key] : false;
        } else {
            merged[key] = profileValue;
        }
    }

    // Include any extra profile keys not in capabilities
    for (const key of Object.keys(profilePolicy)) {
        if (!(key in merged)) {
            merged[key] = profilePolicy[key];
        }
    }

    if (isCodeChangingTask) {
        for (const [floorKey, floorValue] of CODE_CHANGING_SAFETY_FLOORS) {
            const currentValue = merged[floorKey];
            if (currentValue !== floorValue) {
                merged[floorKey] = floorValue;
                floorsApplied.push(`${floorKey}: profile wanted ${String(currentValue)}, safety floor enforced ${String(floorValue)}`);
            }
        }
    }

    return { merged, floorsApplied };
}

/**
 * Apply profile guardrails with full diagnostics.
 *
 * Produces a decision record for each review type showing:
 * - what the profile wanted
 * - what the effective value is
 * - why (safety floor, profile override, capability default, or lightened)
 */
export function applyProfileGuardrails(
    profilePolicy: ProfileReviewPolicy,
    capabilities: ReviewCapabilities,
    scopeCategory: string,
    profileName: string,
    options: ProfileGuardrailOptions = {}
): ProfileGuardrailResult {
    const zeroDiffNoReviewableScope = isZeroDiffNoReviewableScope(scopeCategory, options);
    const isCodeChangingTask = zeroDiffNoReviewableScope
        ? false
        : !LIGHTENABLE_SCOPE_CATEGORIES.has(scopeCategory);
    const lightEligible = zeroDiffNoReviewableScope || LIGHTENABLE_SCOPE_CATEGORIES.has(scopeCategory);

    const { merged, floorsApplied } = mergeReviewPolicy(profilePolicy, capabilities, isCodeChangingTask);

    const decisions: ProfileReviewDecision[] = [];

    for (const key of Object.keys(merged)) {
        const profileValue = key in profilePolicy ? profilePolicy[key] : undefined;
        const capabilityValue = capabilities[key] ?? false;
        const hasDomainSurfaceEvidence = options.domainSurface !== undefined;
        const domainSurfacePresent = hasDomainSurfaceEvidence
            ? options.domainSurface![key] === true
            : true;
        const isTriggerGatedAutoReview = TRIGGER_GATED_AUTO_REVIEW_TYPES.has(key);
        const mergedWantsReview = merged[key] === true;
        const needsDomainSurface = (
            isTriggerGatedAutoReview
            && mergedWantsReview
            && profileValue !== true
            && options.forceAllDomainReviews !== true
            && hasDomainSurfaceEvidence
        );
        const domainSurfaceMissing = needsDomainSurface && !domainSurfacePresent;
        const scopeLightenedExplicitReview = shouldLightenReviewForDocsOnlyScope(
            key,
            profileValue,
            scopeCategory,
            options
        ) || shouldLightenReviewForTestOnlyScope(key, scopeCategory, options)
            || shouldLightenReviewForLocalizationOnlyScope(key, options);
        const codeReviewExplicitlyForced = key === 'code' && options.forceCodeReview === true;
        const effectiveValue = zeroDiffNoReviewableScope
            ? false
            : codeReviewExplicitlyForced || (domainSurfaceMissing || scopeLightenedExplicitReview ? false : mergedWantsReview);
        const forcedDomainWithoutSurface = isTriggerGatedAutoReview
            && mergedWantsReview
            && options.forceAllDomainReviews === true
            && hasDomainSurfaceEvidence
            && !domainSurfacePresent
            && effectiveValue;

        let decision: ProfileReviewDecision['decision'];
        let reason: string;

        const wasFloored = floorsApplied.some((f) => f.startsWith(`${key}:`));

        if (zeroDiffNoReviewableScope) {
            decision = 'zero_diff_no_reviewable_scope';
            reason = `${key} review suppressed because current preflight is BASELINE_ONLY with no reviewable diff; audited no-op evidence is required before completion`;
        } else if (codeReviewExplicitlyForced) {
            decision = 'profile_forced';
            reason = `${key} review explicitly forced by task preflight override`;
        } else if (scopeLightenedExplicitReview) {
            decision = 'lightened_by_profile';
            reason = options.localizationOnlyScope === true
                ? `${key} review suppressed because scope is localization-only and no source/security/control-plane trigger requires it`
                : scopeCategory === 'test-only'
                ? `${key} review suppressed because scope is test-only and no source/security/control-plane trigger requires it`
                : `${key} review lightened by profile '${profileName}' for true ${scopeCategory} scope`;
        } else if (domainSurfaceMissing) {
            decision = 'not_applicable_no_domain_surface';
            reason = `${key} review requested by profile '${profileName}', but no ${key} trigger or project surface evidence was found`;
        } else if (forcedDomainWithoutSurface) {
            decision = 'profile_forced';
            reason = `${key} review explicitly forced by profile '${profileName}' even though no ${key} domain surface evidence was found`;
        } else if (
            isTriggerGatedAutoReview
            && mergedWantsReview
            && profileValue !== true
            && hasDomainSurfaceEvidence
            && domainSurfacePresent
            && effectiveValue
        ) {
            decision = 'domain_triggered';
            reason = `${key} review requested by profile '${profileName}' and kept because ${key} domain surface evidence is present`;
        } else if (wasFloored) {
            decision = 'safety_floor_enforced';
            reason = `${key} review is mandatory for code-changing tasks; profile '${profileName}' wanted ${String(profileValue ?? 'auto')} but safety floor enforced true`;
        } else if (profileValue === 'auto' || profileValue === undefined) {
            decision = 'capability_default';
            reason = `${key} review deferred to review-capabilities.json (${String(capabilityValue)})`;
        } else if (profileValue === false && lightEligible && !effectiveValue) {
            decision = 'lightened_by_profile';
            reason = `${key} review lightened by profile '${profileName}' for ${scopeCategory} scope`;
        } else if (profileValue === true && effectiveValue) {
            decision = 'profile_forced';
            reason = `${key} review forced by profile '${profileName}'`;
        } else {
            decision = 'profile_override';
            reason = `${key} review set to ${String(profileValue)} by profile '${profileName}'`;
        }

        decisions.push({
            review_type: key,
            profile_wanted: profileValue ?? 'auto',
            effective_value: effectiveValue,
            decision,
            reason
        });
    }

    return {
        scope_category: scopeCategory,
        is_code_changing_task: isCodeChangingTask,
        profile_name: profileName,
        guardrails_active: isCodeChangingTask,
        lightening_eligible: lightEligible,
        zero_diff_no_reviewable_scope: zeroDiffNoReviewableScope,
        decisions,
        safety_floors_applied: floorsApplied
    };
}

export function formatProfileGuardrailDiagnostics(result: ProfileGuardrailResult): string {
    const lines: string[] = [];
    lines.push('PROFILE_REVIEW_DECISIONS');
    lines.push(`Profile: ${result.profile_name}`);
    lines.push(`ScopeCategory: ${result.scope_category}`);
    lines.push(`CodeChangingTask: ${result.is_code_changing_task}`);
    lines.push(`GuardrailsActive: ${result.guardrails_active}`);
    lines.push(`LighteningEligible: ${result.lightening_eligible}`);
    lines.push(`ZeroDiffNoReviewableScope: ${result.zero_diff_no_reviewable_scope}`);
    lines.push('');
    lines.push('Decisions:');
    for (const d of result.decisions) {
        const marker = d.decision === 'safety_floor_enforced' ? '[!]'
            : d.decision === 'lightened_by_profile' || d.decision === 'not_applicable_no_domain_surface' ? '[-]'
                : d.decision === 'domain_triggered' || d.decision === 'preflight_required' ? '[+]'
                    : '[=]';
        lines.push(`  ${marker} ${d.review_type}: ${d.effective_value} (${d.decision}) — ${d.reason}`);
    }
    if (result.safety_floors_applied.length > 0) {
        lines.push('');
        lines.push('SafetyFloors:');
        for (const floor of result.safety_floors_applied) {
            lines.push(`  - ${floor}`);
        }
    }
    return lines.join('\n');
}

/**
 * Merge profile token_economy overlay onto token-economy.json config.
 *
 * Profile can override boolean flags. Numeric settings (enabled_depths, fail_tail_lines)
 * always come from the config file; profiles do not control them.
 */
export function mergeTokenEconomy(
    profileTokenEconomy: ProfileTokenEconomy,
    configTokenEconomy: TokenEconomyConfig
): TokenEconomyConfig {
    return {
        enabled: profileTokenEconomy.enabled,
        enabled_depths: configTokenEconomy.enabled_depths,
        strip_examples: profileTokenEconomy.strip_examples,
        strip_code_blocks: profileTokenEconomy.strip_code_blocks,
        scoped_diffs: profileTokenEconomy.scoped_diffs,
        compact_reviewer_output: profileTokenEconomy.compact_reviewer_output,
        fail_tail_lines: configTokenEconomy.fail_tail_lines
    };
}

/**
 * Merge profile skills overlay onto installed skill packs.
 * The installed_packs list is always authoritative from skill-packs.json;
 * profiles only control behavioral flags like auto_suggest.
 */
export function mergeSkills(
    profileSkills: ProfileSkills,
    _skillPacks: SkillPacksConfig
): { skills: ProfileSkills; installed_packs: string[] } {
    return {
        skills: { ...profileSkills },
        installed_packs: [..._skillPacks.installed_packs]
    };
}

export function resolveConfigPaths(bundleRoot: string): {
    profiles: string;
    reviewCatalog: string;
    reviewCapabilities: string;
    tokenEconomy: string;
    skillPacks: string;
    paths: string;
} {
    const configDir = path.join(bundleRoot, 'live', 'config');
    return {
        profiles: path.join(configDir, 'profiles.json'),
        reviewCatalog: path.join(configDir, 'review-catalog.json'),
        reviewCapabilities: path.join(configDir, 'review-capabilities.json'),
        tokenEconomy: path.join(configDir, 'token-economy.json'),
        skillPacks: path.join(configDir, 'skill-packs.json'),
        paths: path.join(configDir, 'paths.json')
    };
}

/**
 * Resolve the effective task policy by merging the active profile overlays
 * with the existing config files. Config files are never modified.
 *
 * Safety floors:
 * - For code-changing tasks, `code`, `security`, and `refactor`
 *   reviews are always `true` regardless of profile.
 * - `db` remains a legacy safety floor when no domain-surface input is
 *   supplied; domain-aware callers may filter it to false when no DB surface
 *   evidence exists, unless the explicit all-domain override is set.
 * - For non-code scopes (docs-only, config-only, audit-only), profiles
 *   may relax reviews.
 */
export function resolveEffectivePolicy(
    bundleRoot: string,
    options: ResolveOptions = {}
): EffectivePolicy {
    const configPaths = resolveConfigPaths(bundleRoot);

    const profilesData = loadProfilesData(configPaths.profiles);
    const profileName = options.profileOverride || profilesData.active_profile;

    const entry = getProfileEntry(profilesData, profileName);
    if (!entry) {
        const allNames = [
            ...Object.keys(profilesData.built_in_profiles),
            ...Object.keys(profilesData.user_profiles)
        ];
        throw new Error(
            `Profile '${profileName}' not found. Available: ${allNames.join(', ')}`
        );
    }

    const profileSource = getProfileSource(profilesData, profileName)!;

    // Determine code-changing status from scope category or explicit flag
    const scopeCategory = options.scopeCategory || null;
    const zeroDiffNoReviewableScope = scopeCategory
        ? isZeroDiffNoReviewableScope(scopeCategory, options)
        : false;
    const scopeIsCodeChangingTask = scopeCategory
        ? !LIGHTENABLE_SCOPE_CATEGORIES.has(scopeCategory)
        : options.isCodeChangingTask !== false;
    const isCodeChangingTask = zeroDiffNoReviewableScope ? false : scopeIsCodeChangingTask;

    const capabilities = loadReviewCapabilities(configPaths.reviewCapabilities);
    const reviewCatalog = readReviewCatalogConfigFile(configPaths.reviewCatalog);
    const reviewCatalogPolicy = resolveProfileReviewCatalogPolicy(
        profileName,
        entry.review_policy,
        capabilities,
        reviewCatalog
    );
    const tokenEconomyConfig = loadTokenEconomyConfig(configPaths.tokenEconomy);
    const skillPacksConfig = loadSkillPacksConfig(configPaths.skillPacks);

    const { merged: reviewPolicy, floorsApplied } = mergeReviewPolicy(
        entry.review_policy,
        capabilities,
        isCodeChangingTask
    );
    for (const lane of reviewCatalogPolicy.lanes) {
        if (lane.built_in) {
            continue;
        }
        // T-729-2 records custom-lane profile intent in review_catalog_policy.
        // Task/scope selection and immutable lifecycle snapshots are owned by
        // T-729-3, so the compatibility effective policy must not expose a
        // custom lane as selected before that boundary exists.
        reviewPolicy[lane.id] = false;
    }
    const reviewFindingPolicyResolution = resolveReviewFindingPolicy(
        entry.review_finding_policy,
        profileName
    );
    const reviewFollowUpPolicyResolution = resolveReviewFollowUpPolicy(
        entry.review_follow_up_policy,
        profileName
    );
    const reviewRemediationModePolicy = resolveReviewRemediationModePolicyFromProfile(
        entry.review_remediation_mode_policy,
        profileName,
        { allowedReviewTypeIds: reviewCatalog.review_types.map(({ id }) => id) }
    );
    const taskDecompositionPolicy = resolveProfileTaskDecompositionPolicy(
        entry.task_decomposition,
        profileName
    );
    if (!taskDecompositionPolicy.valid) {
        throw new Error(taskDecompositionPolicy.diagnostics.join(' '));
    }

    const tokenEconomy = mergeTokenEconomy(entry.token_economy, tokenEconomyConfig);

    const { skills, installed_packs } = mergeSkills(entry.skills, skillPacksConfig);

    const pathsConfig = loadPathsConfig(configPaths.paths);
    const reviewTriggerPolicy = loadReviewTriggerPolicy(configPaths.paths);

    // Build guardrail diagnostics when scope category is available
    let guardrailDiagnostics: ProfileGuardrailResult | null = null;
    if (scopeCategory) {
        guardrailDiagnostics = applyProfileGuardrails(
            entry.review_policy,
            capabilities,
            scopeCategory,
            profileName,
            {
                domainSurface: options.domainSurface,
                forceAllDomainReviews: options.forceAllDomainReviews,
                forceCodeReview: options.forceCodeReview,
                localizationOnlyScope: options.localizationOnlyScope,
                protectedControlPlaneChanged: options.protectedControlPlaneChanged,
                protectedControlPlaneDocsOnly: options.protectedControlPlaneDocsOnly,
                zeroDiffBaselineOnly: options.zeroDiffBaselineOnly
            }
        );
        for (const decision of guardrailDiagnostics.decisions) {
            if (Object.hasOwn(reviewPolicy, decision.review_type)) {
                reviewPolicy[decision.review_type] = decision.effective_value;
            }
        }
    }

    return {
        profile_name: profileName,
        profile_source: profileSource,
        depth: entry.depth,
        task_decomposition: taskDecompositionPolicy,
        review_policy: reviewPolicy,
        review_catalog_policy: reviewCatalogPolicy,
        review_finding_policy: reviewFindingPolicyResolution.policy,
        review_finding_policy_diagnostics: reviewFindingPolicyResolution.diagnostics,
        review_follow_up_policy: reviewFollowUpPolicyResolution.policy,
        review_follow_up_policy_diagnostics: reviewFollowUpPolicyResolution.diagnostics,
        review_remediation_mode_policy: reviewRemediationModePolicy,
        token_economy: tokenEconomy,
        skills,
        installed_packs,
        paths: pathsConfig,
        review_trigger_policy: reviewTriggerPolicy,
        safety_floors_applied: floorsApplied,
        scope_category: scopeCategory,
        guardrail_diagnostics: guardrailDiagnostics,
        resolution_sources: {
            profiles: configPaths.profiles,
            review_catalog: configPaths.reviewCatalog,
            review_capabilities: configPaths.reviewCapabilities,
            token_economy: configPaths.tokenEconomy,
            skill_packs: configPaths.skillPacks,
            paths: configPaths.paths
        }
    };
}

export function formatEffectivePolicy(policy: EffectivePolicy): string {
    const lines: string[] = [];
    lines.push('EFFECTIVE_POLICY');
    lines.push(`Profile: ${policy.profile_name} (${policy.profile_source})`);
    lines.push(`Depth: ${policy.depth}`);
    lines.push(
        `TaskDecomposition: enabled=${String(policy.task_decomposition.enabled)}, ` +
        `configured=${String(policy.task_decomposition.configured)}, provenance=${policy.task_decomposition.provenance}`
    );
    lines.push(
        `ReviewRemediationModePolicy: configured=${String(!policy.review_remediation_mode_policy.legacy_fallback)}, ` +
        `legacy_full_only=${String(policy.review_remediation_mode_policy.legacy_fallback)}, ` +
        `policy_id=${policy.review_remediation_mode_policy.policy.policy_id}`
    );
    if (policy.scope_category) {
        lines.push(`ScopeCategory: ${policy.scope_category}`);
    }
    lines.push('');

    lines.push('ReviewPolicy:');
    for (const [key, value] of Object.entries(policy.review_policy)) {
        lines.push(`  ${key}: ${String(value)}`);
    }
    lines.push('');

    if (policy.review_catalog_policy) {
        lines.push('ReviewCatalogPolicy:');
        lines.push(`  catalog_sha256: ${policy.review_catalog_policy.catalog_sha256}`);
        lines.push(`  policy_sha256: ${policy.review_catalog_policy.policy_sha256}`);
        for (const lane of policy.review_catalog_policy.lanes) {
            const activity = lane.active ? 'active' : `inactive:${lane.inactive_reason}`;
            lines.push(`  ${lane.id}: ${lane.state} (${activity})`);
        }
        lines.push('');
    }

    lines.push('ReviewTriggerPolicy:');
    lines.push(`  refactor_path_regexes: ${policy.review_trigger_policy.refactor_path_regexes.length}`);
    lines.push(`  test_path_regexes: ${policy.review_trigger_policy.test_path_regexes.length}`);
    lines.push(`  test_refactor_structural_path_regexes: ${policy.review_trigger_policy.test_refactor_structural_path_regexes.length}`);
    lines.push(`  test_refactor_changed_lines_threshold: ${policy.review_trigger_policy.test_refactor_changed_lines_threshold}`);
    lines.push('');

    lines.push('ReviewFindingPolicy:');
    lines.push(`  policy_id: ${policy.review_finding_policy.policy_id}`);
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        lines.push(`  ${severity}: ${policy.review_finding_policy.findings[severity]}`);
    }
    lines.push(`  residual_risk: ${policy.review_finding_policy.residual_risk}`);
    if (policy.review_finding_policy_diagnostics.length > 0) {
        lines.push('  diagnostics:');
        for (const diagnostic of policy.review_finding_policy_diagnostics) {
            lines.push(`    - ${diagnostic}`);
        }
    }
    lines.push('');

    lines.push('ReviewFollowUpPolicy:');
    lines.push(`  materialization_mode: ${policy.review_follow_up_policy.materialization_mode}`);
    lines.push(`  task_profile.mode: ${policy.review_follow_up_policy.task_profile.mode}`);
    lines.push(
        `  task_profile.fixed_profile: ${policy.review_follow_up_policy.task_profile.fixed_profile || '<none>'}`
    );
    if (policy.review_follow_up_policy_diagnostics.length > 0) {
        lines.push('  diagnostics:');
        for (const diagnostic of policy.review_follow_up_policy_diagnostics) {
            lines.push(`    - ${diagnostic}`);
        }
    }
    lines.push('');

    lines.push('TokenEconomy:');
    lines.push(`  enabled: ${policy.token_economy.enabled}`);
    lines.push(`  enabled_depths: [${policy.token_economy.enabled_depths.join(', ')}]`);
    lines.push(`  strip_examples: ${policy.token_economy.strip_examples}`);
    lines.push(`  strip_code_blocks: ${policy.token_economy.strip_code_blocks}`);
    lines.push(`  scoped_diffs: ${policy.token_economy.scoped_diffs}`);
    lines.push(`  compact_reviewer_output: ${policy.token_economy.compact_reviewer_output}`);
    lines.push(`  fail_tail_lines: ${policy.token_economy.fail_tail_lines}`);
    lines.push('');

    lines.push('Skills:');
    for (const [key, value] of Object.entries(policy.skills)) {
        lines.push(`  ${key}: ${String(value)}`);
    }
    if (policy.installed_packs.length > 0) {
        lines.push(`  installed_packs: [${policy.installed_packs.join(', ')}]`);
    }
    lines.push('');

    lines.push('Paths:');
    lines.push(`  runtime_roots: [${policy.paths.runtime_roots.join(', ')}]`);
    lines.push(`  fast_path_roots: [${policy.paths.fast_path_roots.join(', ')}]`);
    lines.push(`  trigger_categories: [${Object.keys(policy.paths.triggers).join(', ')}]`);

    if (policy.safety_floors_applied.length > 0) {
        lines.push('');
        lines.push('SafetyFloors:');
        for (const floor of policy.safety_floors_applied) {
            lines.push(`  - ${floor}`);
        }
    }

    if (policy.guardrail_diagnostics) {
        lines.push('');
        lines.push(formatProfileGuardrailDiagnostics(policy.guardrail_diagnostics));
    }

    return lines.join('\n');
}

export function formatEffectivePolicyJson(policy: EffectivePolicy): string {
    return JSON.stringify(policy, null, 2);
}
