import { createHash } from 'node:crypto';

import type {
    NormalizedReviewCatalog,
    NormalizedReviewTypeDefinition
} from '../core/review-catalog';
import { listKnownReviewSkillDirectories } from '../core/review-capabilities';
import {
    compileReviewDependencyGraph,
    getCompiledReviewDependencyGraphViolations,
    normalizeReviewDependencyGraphDeclaration,
    type CompiledReviewDependencyGraph,
    type ReviewDependencyGraphDeclaration
} from '../core/review-dependency-graph';
import {
    LEGACY_REVIEW_EXECUTION_POLICY_MODE,
    REVIEW_EXECUTION_POLICY_MODES,
    getReviewExecutionDependencies,
    getReviewExecutionPreparationOrder,
    type EffectiveReviewExecutionPolicyMode,
    type ReviewExecutionPolicyMode
} from '../core/review-execution-policy';
import {
    FULL_SUITE_VALIDATION_PLACEMENTS,
    type FullSuiteValidationPlacement
} from '../core/workflow-config';
import type {
    ProfileReviewCatalogLane,
    ResolvedProfileReviewCatalogPolicy
} from './profile-review-catalog-policy';

export type EffectiveReviewSelection = 'required' | 'optional' | 'inactive';

interface ConfiguredReviewSkill {
    id: string;
    directory: string;
    implemented: boolean;
}

export function collectKnownReviewSkillIds(
    configuredSkills: readonly ConfiguredReviewSkill[] = []
): string[] {
    const knownSkillIds = new Set(listKnownReviewSkillDirectories());
    for (const skill of configuredSkills) {
        if (!skill.implemented) {
            continue;
        }
        const id = skill.id.trim();
        const directory = skill.directory.trim();
        if (id) {
            knownSkillIds.add(id);
        }
        if (directory) {
            knownSkillIds.add(directory);
        }
    }
    return [...knownSkillIds].sort((left, right) => left.localeCompare(right));
}

export interface EffectiveReviewSnapshotLane {
    id: string;
    selection: EffectiveReviewSelection;
    trigger_reasons: readonly string[];
    inactive_reasons: readonly string[];
    profile: ProfileReviewCatalogLane;
    definition: NormalizedReviewTypeDefinition;
}

export interface EffectiveReviewSnapshot {
    schema_version: 1;
    catalog_sha256: string;
    profile_policy_sha256: string;
    profile_snapshot_sha256: string;
    inputs: Readonly<{
        legacy_required_reviews: Readonly<Record<string, boolean>>;
        task_required_review_ids?: readonly string[];
        scope_category: string;
        task_intent: string;
        changed_files: readonly string[];
        task_triggers: Readonly<Record<string, boolean>>;
        package_hints: readonly string[];
        optional_skill_ids: readonly string[];
        zero_diff_baseline_only: boolean;
        review_execution_policy?: Readonly<{
            mode: EffectiveReviewExecutionPolicyMode;
            review_dependency_graph: ReviewDependencyGraphDeclaration | null;
            full_suite_validation: Readonly<{
                enabled: boolean;
                placement: FullSuiteValidationPlacement;
            }>;
        }>;
    }>;
    required_review_ids: readonly string[];
    optional_review_ids: readonly string[];
    required_reviews: Readonly<Record<string, boolean>>;
    optional_reviews: Readonly<Record<string, boolean>>;
    lanes: readonly EffectiveReviewSnapshotLane[];
    review_dependency_graph?: CompiledReviewDependencyGraph;
    snapshot_sha256: string;
}

export interface BuildEffectiveReviewSnapshotOptions {
    catalog: NormalizedReviewCatalog;
    profilePolicy: ResolvedProfileReviewCatalogPolicy;
    profileSnapshotSha256: string;
    legacyRequiredReviews: Readonly<Record<string, boolean>>;
    taskRequiredReviewIds?: readonly string[];
    scopeCategory: string;
    taskIntent: string;
    changedFiles: readonly string[];
    taskTriggers: Readonly<Record<string, boolean>>;
    packageHints?: readonly string[];
    optionalSkillIds?: readonly string[];
    zeroDiffBaselineOnly?: boolean;
    reviewExecutionPolicyMode?: EffectiveReviewExecutionPolicyMode;
    reviewDependencyGraph?: ReviewDependencyGraphDeclaration | null;
    fullSuiteValidation?: {
        enabled: boolean;
        placement: FullSuiteValidationPlacement;
    };
    includeDependencyGraph?: boolean;
}

export interface FrozenReviewExecutionPolicyBinding {
    mode: EffectiveReviewExecutionPolicyMode;
    review_dependency_graph?: ReviewDependencyGraphDeclaration | null;
    full_suite_validation?: {
        enabled: boolean;
        placement: FullSuiteValidationPlacement;
    };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SIGNAL_TOKEN_PATTERN = /^[a-z][a-z0-9-]*$/u;
const TRIGGER_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/u;

function isEffectiveReviewExecutionPolicyMode(value: unknown): value is EffectiveReviewExecutionPolicyMode {
    return value === LEGACY_REVIEW_EXECUTION_POLICY_MODE
        || REVIEW_EXECUTION_POLICY_MODES.includes(value as ReviewExecutionPolicyMode);
}

export function resolveEffectiveReviewTaskIntent(
    explicitTaskIntent: unknown,
    currentTaskSummary: string | null | undefined
): string {
    const explicit = String(explicitTaskIntent || '').trim();
    return explicit || String(currentTaskSummary || '').trim();
}
const CONFIGURED_SIGNAL_TOKEN_PATTERN = /^[a-z][a-z0-9-]*(?:[.:][a-z0-9-]+)*$/u;
const WORKSPACE_PACKAGE_ROOTS = new Set(['apps', 'libs', 'modules', 'packages', 'plugins', 'services']);

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        return Object.keys(source).sort().reduce<Record<string, unknown>>((result, key) => {
            result[key] = canonicalize(source[key]);
            return result;
        }, {});
    }
    return value;
}

function sha256(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function deepFreeze<T>(value: T): T {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child);
    }
    return Object.freeze(value);
}

function normalizeTokenSet(values: readonly string[]): Set<string> {
    return new Set(values
        .map((value) => String(value || '').trim().toLowerCase())
        .filter((value) => SIGNAL_TOKEN_PATTERN.test(value)));
}

function tokenize(value: string): Set<string> {
    return normalizeTokenSet(String(value || '').toLowerCase().split(/[^a-z0-9-]+/u));
}

export function deriveReviewPackageHints(changedFiles: readonly string[]): string[] {
    const hints = new Set<string>();
    for (const rawPath of changedFiles) {
        const segments = String(rawPath || '').replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
        if (segments.length === 1 && /^(?:package|composer)\.json$|^(?:pom\.xml|go\.mod|cargo\.toml)$/u.test(segments[0])) {
            hints.add('root');
        }
        for (let index = 0; index < segments.length - 1; index += 1) {
            if (WORKSPACE_PACKAGE_ROOTS.has(segments[index]) && SIGNAL_TOKEN_PATTERN.test(segments[index + 1])) {
                hints.add(segments[index + 1]);
            }
        }
    }
    return [...hints].sort();
}

function matchConfiguredSignal(signalId: string, options: BuildEffectiveReviewSnapshotOptions): string | null {
    const separatorIndexes = [signalId.indexOf(':'), signalId.indexOf('.')]
        .filter((index) => index > 0);
    const separatorIndex = separatorIndexes.length > 0 ? Math.min(...separatorIndexes) : -1;
    if (separatorIndex <= 0 || separatorIndex === signalId.length - 1) {
        return null;
    }
    const namespace = signalId.slice(0, separatorIndex);
    const token = signalId.slice(separatorIndex + 1);
    if (!CONFIGURED_SIGNAL_TOKEN_PATTERN.test(token)) {
        return null;
    }
    if (namespace === 'scope') {
        if (token === options.scopeCategory.toLowerCase()) {
            return `${signalId}=scope_category`;
        }
        if (options.taskTriggers[token] === true) {
            return `${signalId}=scope_trigger`;
        }
        return null;
    }
    if (namespace === 'trigger') {
        const triggerKey = token.replace(/-/g, '_');
        return options.taskTriggers[triggerKey] === true ? `${signalId}=task_scope_trigger` : null;
    }
    if (namespace === 'task') {
        const taskTokens = tokenize(options.taskIntent);
        const configuredTokens = token.split(/[.:]/u);
        return configuredTokens.every((configuredToken) => taskTokens.has(configuredToken))
            ? `${signalId}=task_intent_token`
            : null;
    }
    if (namespace === 'path' || namespace === 'paths') {
        const pathTokens = tokenize(options.changedFiles.join('/'));
        const configuredTokens = token.split(/[.:]/u);
        return configuredTokens.every((configuredToken) => pathTokens.has(configuredToken))
            ? `${signalId}=changed_path_token`
            : null;
    }
    if (namespace === 'package') {
        const packageHints = normalizeTokenSet([
            ...deriveReviewPackageHints(options.changedFiles),
            ...(options.packageHints || [])
        ]);
        return packageHints.has(token) ? `${signalId}=package_hint` : null;
    }
    if (namespace === 'skill') {
        const optionalSkillIds = normalizeTokenSet(options.optionalSkillIds || []);
        return optionalSkillIds.has(token) ? `${signalId}=selected_optional_skill` : null;
    }
    return null;
}

function selectCustomLane(
    definition: NormalizedReviewTypeDefinition,
    profile: ProfileReviewCatalogLane,
    options: BuildEffectiveReviewSnapshotOptions
): Pick<EffectiveReviewSnapshotLane, 'selection' | 'trigger_reasons' | 'inactive_reasons'> {
    if (options.taskRequiredReviewIds?.includes(definition.id)) {
        return options.zeroDiffBaselineOnly
            ? { selection: 'inactive', trigger_reasons: [], inactive_reasons: ['zero_diff_no_reviewable_scope'] }
            : { selection: 'required', trigger_reasons: ['task_required_declaration'], inactive_reasons: [] };
    }
    if (!profile.active) {
        return {
            selection: 'inactive',
            trigger_reasons: [],
            inactive_reasons: [profile.inactive_reason || 'profile_or_capability_inactive']
        };
    }
    if (options.zeroDiffBaselineOnly) {
        return {
            selection: 'inactive',
            trigger_reasons: [],
            inactive_reasons: ['zero_diff_no_reviewable_scope']
        };
    }
    if (options.legacyRequiredReviews[definition.id] === true) {
        return {
            selection: 'required',
            trigger_reasons: ['task_required_declaration'],
            inactive_reasons: []
        };
    }
    if (profile.state === 'required') {
        return {
            selection: 'required',
            trigger_reasons: ['profile_state=required'],
            inactive_reasons: []
        };
    }
    if (definition.trigger.mode === 'manual') {
        return {
            selection: 'optional',
            trigger_reasons: ['catalog_trigger=manual'],
            inactive_reasons: []
        };
    }
    const matchedReasons = definition.trigger.signal_ids
        .map((signalId) => matchConfiguredSignal(signalId, options))
        .filter((reason): reason is string => Boolean(reason));
    return matchedReasons.length > 0
        ? { selection: 'required', trigger_reasons: matchedReasons, inactive_reasons: [] }
        : {
            selection: 'inactive',
            trigger_reasons: [],
            inactive_reasons: ['configured_signals_not_matched']
        };
}

function selectBuiltInLane(
    definition: NormalizedReviewTypeDefinition,
    profile: ProfileReviewCatalogLane,
    options: BuildEffectiveReviewSnapshotOptions
): Pick<EffectiveReviewSnapshotLane, 'selection' | 'trigger_reasons' | 'inactive_reasons'> {
    if (options.zeroDiffBaselineOnly) {
        return {
            selection: 'inactive',
            trigger_reasons: [],
            inactive_reasons: ['zero_diff_no_reviewable_scope']
        };
    }
    if (options.taskRequiredReviewIds?.includes(definition.id)) {
        return { selection: 'required', trigger_reasons: ['task_required_declaration'], inactive_reasons: [] };
    }
    if (!profile.active) {
        return {
            selection: 'inactive',
            trigger_reasons: [],
            inactive_reasons: [profile.inactive_reason || 'profile_or_capability_inactive']
        };
    }
    if (options.legacyRequiredReviews[definition.id] === true) {
        return {
            selection: 'required',
            trigger_reasons: ['built_in_compatibility_required'],
            inactive_reasons: []
        };
    }
    return { selection: 'optional', trigger_reasons: ['built_in_compatibility_not_required'], inactive_reasons: [] };
}

/** Extend task-specific lanes without changing the frozen profile graph or any of its edges. */
function expandTaskRequiredReviewGraph(
    declaration: ReviewDependencyGraphDeclaration | null,
    lanes: readonly EffectiveReviewSnapshotLane[],
    taskRequiredReviewIds: readonly string[] = [],
    mode: EffectiveReviewExecutionPolicyMode
): ReviewDependencyGraphDeclaration | null {
    if (!declaration) return null;
    const order = [...declaration.preparation_order];
    const dependencies = { ...declaration.dependencies };
    const required = Object.fromEntries(lanes.map(lane => [lane.id, lane.selection === 'required']));
    const compatibilityOrder = [...getReviewExecutionPreparationOrder(mode), ...lanes.map(lane => lane.id)];
    const additions = lanes.filter(lane => !lane.profile.active && lane.selection === 'required'
        && taskRequiredReviewIds.includes(lane.id) && !order.includes(lane.id))
        .sort((left, right) => compatibilityOrder.indexOf(left.id) - compatibilityOrder.indexOf(right.id));
    for (const lane of additions) {
        // Append new requirements after declared producers. Existing ordering and dependencies stay exact.
        dependencies[lane.id] = mode === 'strict_sequential'
            ? order.filter(id => required[id])
            : getReviewExecutionDependencies(lane.id, required, mode).filter(id => order.includes(id));
        order.push(lane.id);
    }
    return { preparation_order: order, dependencies };
}

export function buildEffectiveReviewSnapshot(options: BuildEffectiveReviewSnapshotOptions): EffectiveReviewSnapshot {
    if (options.catalog.catalog_sha256 !== options.profilePolicy.catalog_sha256) {
        throw new Error('Effective review snapshot catalog hash does not match the resolved profile review policy.');
    }
    if (!SHA256_PATTERN.test(options.profileSnapshotSha256)) {
        throw new Error('Effective review snapshot profileSnapshotSha256 must be a SHA-256 hex string.');
    }
    const taskRequiredReviewIds = [...(options.taskRequiredReviewIds || [])].sort();
    if (new Set(taskRequiredReviewIds).size !== taskRequiredReviewIds.length) {
        throw new Error('Effective review snapshot task-required review ids must be unique.');
    }
    for (const id of taskRequiredReviewIds) {
        const profile = options.profilePolicy.lanes.find(lane => lane.id === id);
        if (!options.catalog.review_types.some(definition => definition.id === id) || !profile?.capability_enabled) {
            throw new Error(`Effective review snapshot task-required lane '${id}' is unknown or capability-disabled.`);
        }
    }
    const includeDependencyGraph = options.includeDependencyGraph !== false;
    const normalizedDependencyGraph = options.reviewDependencyGraph == null
        ? null
        : normalizeReviewDependencyGraphDeclaration(options.reviewDependencyGraph);
    const inputs: EffectiveReviewSnapshot['inputs'] = {
        legacy_required_reviews: Object.fromEntries(
            options.catalog.review_types.map((definition) => [
                definition.id,
                options.legacyRequiredReviews[definition.id] === true
            ])
        ),
        ...(taskRequiredReviewIds.length > 0 ? { task_required_review_ids: taskRequiredReviewIds } : {}),
        scope_category: String(options.scopeCategory || '').trim().toLowerCase(),
        task_intent: String(options.taskIntent || '').trim(),
        changed_files: options.changedFiles.map((changedFile) => String(changedFile).replace(/\\/g, '/')),
        task_triggers: Object.fromEntries(
            Object.entries(options.taskTriggers)
                .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
        ),
        package_hints: [...normalizeTokenSet([
            ...deriveReviewPackageHints(options.changedFiles),
            ...(options.packageHints || [])
        ])].sort(),
        optional_skill_ids: [...normalizeTokenSet(options.optionalSkillIds || [])].sort(),
        zero_diff_baseline_only: options.zeroDiffBaselineOnly === true,
        ...(includeDependencyGraph
            ? {
                review_execution_policy: {
                    mode: options.reviewExecutionPolicyMode || LEGACY_REVIEW_EXECUTION_POLICY_MODE,
                    review_dependency_graph: normalizedDependencyGraph,
                    full_suite_validation: {
                        enabled: options.fullSuiteValidation?.enabled === true,
                        placement: options.fullSuiteValidation?.placement || 'after_compile_before_reviews'
                    }
                }
            }
            : {})
    };
    const normalizedOptions: BuildEffectiveReviewSnapshotOptions = {
        ...options,
        legacyRequiredReviews: inputs.legacy_required_reviews,
        taskRequiredReviewIds: inputs.task_required_review_ids,
        scopeCategory: inputs.scope_category,
        taskIntent: inputs.task_intent,
        changedFiles: inputs.changed_files,
        taskTriggers: inputs.task_triggers,
        packageHints: inputs.package_hints,
        optionalSkillIds: inputs.optional_skill_ids,
        zeroDiffBaselineOnly: inputs.zero_diff_baseline_only
    };
    const profilesById = new Map(options.profilePolicy.lanes.map((lane) => [lane.id, lane]));
    const lanes = options.catalog.review_types.map((definition): EffectiveReviewSnapshotLane => {
        const profile = profilesById.get(definition.id);
        if (!profile) {
            throw new Error(`Effective review snapshot is missing profile policy for catalog lane '${definition.id}'.`);
        }
        const decision = definition.built_in
            ? selectBuiltInLane(definition, profile, normalizedOptions)
            : selectCustomLane(definition, profile, normalizedOptions);
        return { id: definition.id, ...decision, profile, definition };
    });
    const requiredReviewIds = lanes.filter((lane) => lane.selection === 'required').map((lane) => lane.id);
    const optionalReviewIds = lanes.filter((lane) => lane.selection === 'optional').map((lane) => lane.id);
    const requiredReviews = Object.fromEntries(lanes.map((lane) => [lane.id, lane.selection === 'required']));
    const optionalReviews = Object.fromEntries(lanes.map((lane) => [lane.id, lane.selection === 'optional']));
    const reviewDependencyGraph = includeDependencyGraph
        ? compileReviewDependencyGraph({
            catalogLaneIds: lanes.map((lane) => lane.id),
            activeLaneIds: lanes.filter((lane) => lane.profile.active || lane.selection === 'required').map((lane) => lane.id),
            requiredReviewIds,
            mode: inputs.review_execution_policy!.mode,
            declaration: expandTaskRequiredReviewGraph(
                inputs.review_execution_policy!.review_dependency_graph, lanes,
                inputs.task_required_review_ids, inputs.review_execution_policy!.mode
            ),
            fullSuiteValidation: inputs.review_execution_policy!.full_suite_validation
        })
        : null;
    const body: Omit<EffectiveReviewSnapshot, 'snapshot_sha256'> = {
        schema_version: 1,
        catalog_sha256: options.catalog.catalog_sha256,
        profile_policy_sha256: options.profilePolicy.policy_sha256,
        profile_snapshot_sha256: options.profileSnapshotSha256,
        inputs,
        required_review_ids: requiredReviewIds,
        optional_review_ids: optionalReviewIds,
        required_reviews: requiredReviews,
        optional_reviews: optionalReviews,
        lanes,
        ...(reviewDependencyGraph ? { review_dependency_graph: reviewDependencyGraph } : {})
    };
    return deepFreeze({ ...body, snapshot_sha256: sha256(body) });
}

export function getEffectiveReviewSnapshotViolations(value: unknown): string[] {
    if (!isJsonRecord(value)) {
        return ['Effective review snapshot must be a JSON object.'];
    }
    const snapshot = value;
    const violations: string[] = [];
    if (snapshot.schema_version !== 1) {
        violations.push('Effective review snapshot schema_version must be 1.');
    }
    for (const key of ['catalog_sha256', 'profile_policy_sha256', 'profile_snapshot_sha256', 'snapshot_sha256']) {
        if (!SHA256_PATTERN.test(String(snapshot[key] || ''))) {
            violations.push(`Effective review snapshot ${key} must be a SHA-256 hex string.`);
        }
    }
    const inputs = snapshot.inputs;
    if (!isJsonRecord(inputs) || !isJsonRecord(inputs.legacy_required_reviews) ||
        typeof inputs.scope_category !== 'string' || typeof inputs.task_intent !== 'string' ||
        !isStringArray(inputs.changed_files) || !isJsonRecord(inputs.task_triggers) ||
        !isStringArray(inputs.package_hints) || !isStringArray(inputs.optional_skill_ids) ||
        typeof inputs.zero_diff_baseline_only !== 'boolean') {
        violations.push('Effective review snapshot inputs must contain normalized decision inputs.');
    } else {
        if (inputs.task_required_review_ids !== undefined && (
            !isStringArray(inputs.task_required_review_ids)
            || new Set(inputs.task_required_review_ids).size !== inputs.task_required_review_ids.length
            || inputs.task_required_review_ids.some(id => !SIGNAL_TOKEN_PATTERN.test(id))
        )) {
            violations.push('Effective review snapshot task_required_review_ids must contain unique stable review ids.');
        }
        for (const [reviewId, required] of Object.entries(inputs.legacy_required_reviews)) {
            if (!SIGNAL_TOKEN_PATTERN.test(reviewId) || typeof required !== 'boolean') {
                violations.push('Effective review snapshot inputs.legacy_required_reviews must be a boolean review map.');
                break;
            }
        }
        for (const [triggerId, active] of Object.entries(inputs.task_triggers)) {
            if (!TRIGGER_KEY_PATTERN.test(triggerId) || typeof active !== 'boolean') {
                violations.push('Effective review snapshot inputs.task_triggers must be a boolean trigger map.');
                break;
            }
        }
        if (inputs.review_execution_policy !== undefined) {
            if (!isJsonRecord(inputs.review_execution_policy) ||
                !isEffectiveReviewExecutionPolicyMode(inputs.review_execution_policy.mode) ||
                !isJsonRecord(inputs.review_execution_policy.full_suite_validation) ||
                typeof inputs.review_execution_policy.full_suite_validation.enabled !== 'boolean' ||
                !FULL_SUITE_VALIDATION_PLACEMENTS.includes(
                    inputs.review_execution_policy.full_suite_validation.placement as FullSuiteValidationPlacement
                )) {
                violations.push('Effective review snapshot inputs.review_execution_policy is invalid.');
            } else if (inputs.review_execution_policy.review_dependency_graph !== null) {
                try {
                    normalizeReviewDependencyGraphDeclaration(
                        inputs.review_execution_policy.review_dependency_graph,
                        'effective_review_snapshot.inputs.review_execution_policy.review_dependency_graph'
                    );
                } catch (error) {
                    violations.push(error instanceof Error ? error.message : String(error));
                }
            }
        }
    }
    const lanes = Array.isArray(snapshot.lanes) ? snapshot.lanes : [];
    if (!Array.isArray(snapshot.lanes)) {
        violations.push('Effective review snapshot lanes must be an array.');
    }
    const laneIds: string[] = [];
    const requiredLaneIds: string[] = [];
    const optionalLaneIds: string[] = [];
    const seenLaneIds = new Set<string>();
    for (const [index, rawLane] of lanes.entries()) {
        if (!isJsonRecord(rawLane)) {
            violations.push(`Effective review snapshot lanes[${index}] must be a JSON object.`);
            continue;
        }
        const id = typeof rawLane.id === 'string' ? rawLane.id : '';
        if (!SIGNAL_TOKEN_PATTERN.test(id)) {
            violations.push(`Effective review snapshot lanes[${index}].id must be a stable review id.`);
        } else if (seenLaneIds.has(id)) {
            violations.push(`Effective review snapshot lane id '${id}' is duplicated.`);
        } else {
            seenLaneIds.add(id);
            laneIds.push(id);
        }
        const selection = rawLane.selection;
        if (selection !== 'required' && selection !== 'optional' && selection !== 'inactive') {
            violations.push(`Effective review snapshot lane '${id || index}' has invalid selection.`);
        } else if (id) {
            if (selection === 'required') requiredLaneIds.push(id);
            if (selection === 'optional') optionalLaneIds.push(id);
        }
        if (!isStringArray(rawLane.trigger_reasons) || !isStringArray(rawLane.inactive_reasons)) {
            violations.push(`Effective review snapshot lane '${id || index}' reasons must be string arrays.`);
        } else if (selection === 'inactive') {
            if (rawLane.trigger_reasons.length > 0 || rawLane.inactive_reasons.length === 0) {
                violations.push(`Effective review snapshot inactive lane '${id || index}' has inconsistent reasons.`);
            }
        } else if (selection === 'required' || selection === 'optional') {
            if (rawLane.trigger_reasons.length === 0 || rawLane.inactive_reasons.length > 0) {
                violations.push(`Effective review snapshot selected lane '${id || index}' has inconsistent reasons.`);
            }
        }
        const profile = rawLane.profile;
        const definition = rawLane.definition;
        if (!isJsonRecord(profile)) {
            violations.push(`Effective review snapshot lane '${id || index}' profile must be a JSON object.`);
        } else {
            if (profile.id !== id || typeof profile.built_in !== 'boolean' || typeof profile.active !== 'boolean' ||
                typeof profile.capability_enabled !== 'boolean' ||
                (profile.state !== 'disabled' && profile.state !== 'auto' && profile.state !== 'required')) {
                violations.push(`Effective review snapshot lane '${id || index}' profile binding is invalid.`);
            }
            const expectedActive = profile.capability_enabled === true && profile.state !== 'disabled';
            if (profile.active !== expectedActive) {
                violations.push(`Effective review snapshot lane '${id || index}' profile activity is inconsistent.`);
            }
            const taskRequired = isJsonRecord(inputs)
                && isStringArray(inputs.task_required_review_ids)
                && inputs.task_required_review_ids.includes(id);
            if (taskRequired && profile.capability_enabled !== true) {
                violations.push(`Effective review snapshot task-required lane '${id || index}' is capability-disabled.`);
            }
            if (profile.active === false && selection !== 'inactive' && !taskRequired) {
                violations.push(`Effective review snapshot inactive profile lane '${id || index}' must be inactive.`);
            }
            const zeroDiffRequiredSuppression = isJsonRecord(inputs)
                && inputs.zero_diff_baseline_only === true
                && selection === 'inactive'
                && Array.isArray(rawLane.inactive_reasons)
                && rawLane.inactive_reasons.length === 1
                && rawLane.inactive_reasons[0] === 'zero_diff_no_reviewable_scope';
            const builtInCompatibilityRequired = isJsonRecord(definition)
                && definition.built_in === true
                && isJsonRecord(inputs)
                && isJsonRecord(inputs.legacy_required_reviews)
                && inputs.legacy_required_reviews[id] === true;
            const customProfileRequired = isJsonRecord(definition)
                && definition.built_in === false
                && profile.state === 'required';
            if ((taskRequired || (profile.active === true && (builtInCompatibilityRequired || customProfileRequired)))
                && selection !== 'required'
                && !zeroDiffRequiredSuppression) {
                violations.push(`Effective review snapshot required profile lane '${id || index}' must be required.`);
            }
        }
        if (!isJsonRecord(definition)) {
            violations.push(`Effective review snapshot lane '${id || index}' definition must be a JSON object.`);
        } else {
            if (definition.id !== id || typeof definition.built_in !== 'boolean' ||
                (isJsonRecord(profile) && definition.built_in !== profile.built_in)) {
                violations.push(`Effective review snapshot lane '${id || index}' definition binding is invalid.`);
            }
            if (typeof definition.display_label !== 'string' || typeof definition.enabled_by_default !== 'boolean' ||
                !isStringArray(definition.skill_ids) || !isStringArray(definition.coverage_category_ids)) {
                violations.push(`Effective review snapshot lane '${id || index}' definition shape is invalid.`);
            }
            if (!isJsonRecord(definition.trigger) || !isStringArray(definition.trigger.signal_ids) ||
                (definition.trigger.mode !== 'compatibility' && definition.trigger.mode !== 'manual' &&
                    definition.trigger.mode !== 'signals')) {
                violations.push(`Effective review snapshot lane '${id || index}' trigger definition is invalid.`);
            }
            if (!isJsonRecord(definition.reviewer_role) || typeof definition.reviewer_role.role_id !== 'string' ||
                !isStringArray(definition.reviewer_role.focus_tags) || !isJsonRecord(definition.verdict_tokens) ||
                typeof definition.verdict_tokens.pass !== 'string' || typeof definition.verdict_tokens.fail !== 'string') {
                violations.push(`Effective review snapshot lane '${id || index}' reviewer definition is invalid.`);
            }
        }
    }

    const validateProjection = (
        fieldName: 'required_reviews' | 'optional_reviews',
        selectedIds: readonly string[],
        expectedSelection: EffectiveReviewSelection
    ): void => {
        const projection = snapshot[fieldName];
        if (!isJsonRecord(projection)) {
            violations.push(`Effective review snapshot ${fieldName} must be a JSON object.`);
            return;
        }
        const projectionKeys = Object.keys(projection).sort();
        const expectedKeys = [...laneIds].sort();
        if (!arraysEqual(projectionKeys, expectedKeys)) {
            violations.push(`Effective review snapshot ${fieldName} keys must match lane ids exactly.`);
        }
        const selected = new Set(selectedIds);
        for (const laneId of laneIds) {
            if (typeof projection[laneId] !== 'boolean') {
                violations.push(`Effective review snapshot ${fieldName}.${laneId} must be boolean.`);
            } else if (projection[laneId] !== selected.has(laneId)) {
                violations.push(
                    `Effective review snapshot ${fieldName}.${laneId} does not match lane selection '${expectedSelection}'.`
                );
            }
        }
    };
    if (isJsonRecord(inputs) && isStringArray(inputs.task_required_review_ids)
        && inputs.task_required_review_ids.some(id => !seenLaneIds.has(id))) {
        violations.push('Effective review snapshot task_required_review_ids contains an unknown lane.');
    }
    validateProjection('required_reviews', requiredLaneIds, 'required');
    validateProjection('optional_reviews', optionalLaneIds, 'optional');

    if (!isStringArray(snapshot.required_review_ids) || !arraysEqual(snapshot.required_review_ids, requiredLaneIds)) {
        violations.push('Effective review snapshot required_review_ids must match required lanes in catalog order.');
    }
    if (!isStringArray(snapshot.optional_review_ids) || !arraysEqual(snapshot.optional_review_ids, optionalLaneIds)) {
        violations.push('Effective review snapshot optional_review_ids must match optional lanes in catalog order.');
    }
    const hasFrozenReviewExecutionPolicy = isJsonRecord(inputs)
        && inputs.review_execution_policy !== undefined;
    const hasCompiledReviewDependencyGraph = snapshot.review_dependency_graph !== undefined;
    if (hasFrozenReviewExecutionPolicy !== hasCompiledReviewDependencyGraph) {
        violations.push(
            'Effective review snapshot frozen review_execution_policy and compiled dependency graph must be present together.'
        );
    }
    if (snapshot.review_dependency_graph !== undefined) {
        violations.push(...getCompiledReviewDependencyGraphViolations(snapshot.review_dependency_graph));
        if (isJsonRecord(snapshot.review_dependency_graph)) {
            const graphNodes = Array.isArray(snapshot.review_dependency_graph.nodes)
                ? snapshot.review_dependency_graph.nodes.filter((entry): entry is string => typeof entry === 'string')
                : [];
            if (!arraysEqual([...graphNodes].sort(), [...requiredLaneIds].sort())) {
                violations.push('Effective review snapshot dependency graph nodes must match required_review_ids.');
            }
        }
        if (!isJsonRecord(inputs) || inputs.review_execution_policy === undefined) {
            violations.push('Effective review snapshot dependency graph requires frozen review_execution_policy inputs.');
        }
    }
    const { snapshot_sha256: actualHash, ...body } = snapshot;
    const expectedHash = sha256(body);
    if (actualHash !== expectedHash) {
        violations.push(`Effective review snapshot hash mismatch. Expected ${expectedHash}, got ${String(actualHash || 'missing')}.`);
    }
    return violations;
}

export function hasCurrentReviewDependencyGraphContract(
    value: FrozenReviewExecutionPolicyBinding
): boolean {
    return Object.prototype.hasOwnProperty.call(value, 'review_dependency_graph')
        || Object.prototype.hasOwnProperty.call(value, 'full_suite_validation');
}

export function assertEffectiveReviewSnapshotExecutionPolicyBinding(
    snapshot: EffectiveReviewSnapshot,
    frozenPolicy: FrozenReviewExecutionPolicyBinding
): CompiledReviewDependencyGraph | null {
    if (!hasCurrentReviewDependencyGraphContract(frozenPolicy)) {
        return null;
    }
    if (!isEffectiveReviewExecutionPolicyMode(frozenPolicy.mode)) {
        throw new Error('Frozen review execution policy mode is invalid.');
    }
    if (!frozenPolicy.full_suite_validation ||
        typeof frozenPolicy.full_suite_validation.enabled !== 'boolean' ||
        !FULL_SUITE_VALIDATION_PLACEMENTS.includes(frozenPolicy.full_suite_validation.placement)) {
        throw new Error('Frozen review execution policy full-suite binding is invalid.');
    }
    const normalizedDeclaration = frozenPolicy.review_dependency_graph == null
        ? null
        : normalizeReviewDependencyGraphDeclaration(
            frozenPolicy.review_dependency_graph,
            'frozen_review_execution_policy.review_dependency_graph'
        );
    const expectedInputs = {
        mode: frozenPolicy.mode,
        review_dependency_graph: normalizedDeclaration,
        full_suite_validation: {
            enabled: frozenPolicy.full_suite_validation.enabled,
            placement: frozenPolicy.full_suite_validation.placement
        }
    };
    if (sha256(snapshot.inputs.review_execution_policy ?? null) !== sha256(expectedInputs)) {
        throw new Error(
            'Effective review snapshot review execution policy does not match the frozen task profile policy.'
        );
    }
    const expectedGraph = compileReviewDependencyGraph({
        catalogLaneIds: snapshot.lanes.map((lane) => lane.id),
        activeLaneIds: snapshot.lanes.filter((lane) => lane.profile.active || lane.selection === 'required').map((lane) => lane.id),
        requiredReviewIds: snapshot.required_review_ids,
        mode: frozenPolicy.mode,
        declaration: expandTaskRequiredReviewGraph(
            normalizedDeclaration, snapshot.lanes, snapshot.inputs.task_required_review_ids, frozenPolicy.mode
        ),
        fullSuiteValidation: expectedInputs.full_suite_validation
    });
    if (!snapshot.review_dependency_graph ||
        sha256(snapshot.review_dependency_graph) !== sha256(expectedGraph)) {
        throw new Error(
            'Effective review snapshot dependency graph does not match the canonical frozen task profile graph.'
        );
    }
    return expectedGraph;
}

export function assertEffectiveReviewSnapshotCurrent(
    snapshot: EffectiveReviewSnapshot,
    catalogOrSha256: NormalizedReviewCatalog | string,
    profileSnapshotSha256: string,
    profilePolicy?: ResolvedProfileReviewCatalogPolicy,
    frozenReviewExecutionPolicy?: FrozenReviewExecutionPolicyBinding
): void {
    const violations = getEffectiveReviewSnapshotViolations(snapshot);
    const frozenPolicyHasCurrentGraphContract = !!frozenReviewExecutionPolicy
        && hasCurrentReviewDependencyGraphContract(frozenReviewExecutionPolicy);
    if (frozenPolicyHasCurrentGraphContract) {
        try {
            assertEffectiveReviewSnapshotExecutionPolicyBinding(snapshot, frozenReviewExecutionPolicy!);
        } catch (error) {
            violations.push(error instanceof Error ? error.message : String(error));
        }
    }
    const catalogSha256 = typeof catalogOrSha256 === 'string'
        ? catalogOrSha256
        : catalogOrSha256.catalog_sha256;
    if (snapshot.catalog_sha256 !== catalogSha256) {
        violations.push('Effective review snapshot catalog drift detected; run a fresh classify-change preflight.');
    }
    if (snapshot.profile_snapshot_sha256 !== profileSnapshotSha256) {
        violations.push('Effective review snapshot profile drift detected; run a fresh classify-change preflight.');
    }
    if (typeof catalogOrSha256 !== 'string') {
        const snapshotDefinitions = snapshot.lanes.map((lane) => lane.definition);
        if (sha256(snapshotDefinitions) !== sha256(catalogOrSha256.review_types)) {
            violations.push('Effective review snapshot definitions do not match the current normalized catalog.');
        }
    }
    if (profilePolicy) {
        if (snapshot.profile_policy_sha256 !== profilePolicy.policy_sha256 ||
            sha256(snapshot.lanes.map((lane) => lane.profile)) !== sha256(profilePolicy.lanes)) {
            violations.push('Effective review snapshot profile policy does not match the frozen active profile.');
        }
        if (typeof catalogOrSha256 === 'string') {
            violations.push('Effective review snapshot canonical reconstruction requires the normalized catalog.');
        } else if (getEffectiveReviewSnapshotViolations(snapshot).length === 0) {
            const rebuilt = buildEffectiveReviewSnapshot({
                catalog: catalogOrSha256,
                profilePolicy,
                profileSnapshotSha256,
                legacyRequiredReviews: snapshot.inputs.legacy_required_reviews,
                taskRequiredReviewIds: snapshot.inputs.task_required_review_ids,
                scopeCategory: snapshot.inputs.scope_category,
                taskIntent: snapshot.inputs.task_intent,
                changedFiles: snapshot.inputs.changed_files,
                taskTriggers: snapshot.inputs.task_triggers,
                packageHints: snapshot.inputs.package_hints,
                optionalSkillIds: snapshot.inputs.optional_skill_ids,
                zeroDiffBaselineOnly: snapshot.inputs.zero_diff_baseline_only,
                reviewExecutionPolicyMode:
                    (frozenPolicyHasCurrentGraphContract ? frozenReviewExecutionPolicy?.mode : undefined)
                    ?? snapshot.inputs.review_execution_policy?.mode,
                reviewDependencyGraph:
                    (frozenPolicyHasCurrentGraphContract
                        ? frozenReviewExecutionPolicy?.review_dependency_graph
                        : undefined)
                    ?? snapshot.inputs.review_execution_policy?.review_dependency_graph,
                fullSuiteValidation:
                    (frozenPolicyHasCurrentGraphContract
                        ? frozenReviewExecutionPolicy?.full_suite_validation
                        : undefined)
                    ?? snapshot.inputs.review_execution_policy?.full_suite_validation,
                includeDependencyGraph: frozenPolicyHasCurrentGraphContract
                    ? true
                    : snapshot.inputs.review_execution_policy !== undefined
            });
            if (rebuilt.snapshot_sha256 !== snapshot.snapshot_sha256) {
                violations.push(
                    'Effective review snapshot canonical reconstruction mismatch; run a fresh classify-change preflight.'
                );
            }
        }
    }
    if (violations.length > 0) {
        throw new Error(violations.join(' '));
    }
}
