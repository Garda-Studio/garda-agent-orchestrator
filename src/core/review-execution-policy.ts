import * as path from 'node:path';
import { resolveBundleName } from './constants';
import { pathExists } from './filesystem';
import { readJsonFile } from './json';
import { assertWorkflowTransactionReadable } from './workflow-transaction-state';
import { isPlainRecord } from './records';
import type { CompiledReviewDependencyGraph } from './review-dependency-graph';

export const REVIEW_EXECUTION_POLICY_MODES = Object.freeze([
    'parallel_all',
    'test_after_code',
    'code_first_optional',
    'strict_sequential'
] as const);

export type ReviewExecutionPolicyMode = typeof REVIEW_EXECUTION_POLICY_MODES[number];
export const LEGACY_REVIEW_EXECUTION_POLICY_MODE = 'legacy_test_downstream' as const;
export type EffectiveReviewExecutionPolicyMode =
    | ReviewExecutionPolicyMode
    | typeof LEGACY_REVIEW_EXECUTION_POLICY_MODE;

export interface ReviewExecutionPolicyConfig {
    mode: ReviewExecutionPolicyMode;
}

export interface ResolvedReviewExecutionPolicyConfig {
    mode: EffectiveReviewExecutionPolicyMode;
    configured: boolean;
}

export interface ReviewLaunchEvidenceState {
    review_type: string;
    satisfied: boolean;
    failed_current?: boolean;
}

export interface ReviewLaunchBlockedLane {
    review_type: string;
    blocked_by: string[];
}

export interface ReviewLaunchPlan {
    launchable_review_types: string[];
    blocked_review_lanes: ReviewLaunchBlockedLane[];
    failed_review_type: string | null;
    next_review_type: string | null;
    blocked_review_dependencies: string[];
}

export const DEFAULT_REVIEW_EXECUTION_POLICY_MODE: ReviewExecutionPolicyMode = 'strict_sequential';

const REVIEW_TYPES_THAT_WAIT_FOR_CODE = new Set([
    'api',
    'performance',
    'infra',
    'dependency'
]);

const REVIEW_TYPES_DOWNSTREAM_OF_TEST = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'performance',
    'infra',
    'dependency'
]);

const REVIEW_EXECUTION_PREPARATION_ORDER = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'performance',
    'infra',
    'dependency',
    'test'
]);

function normalizeReviewType(value: string): string {
    return String(value || '').trim().toLowerCase();
}

function hasOwnExactKey(record: Record<string, unknown>, expectedKey: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, expectedKey);
}

export function buildDefaultReviewExecutionPolicyConfig(): ReviewExecutionPolicyConfig {
    return {
        mode: DEFAULT_REVIEW_EXECUTION_POLICY_MODE
    };
}

export function normalizeReviewExecutionPolicyMode(
    value: unknown,
    fieldName = 'review_execution_policy.mode'
): ReviewExecutionPolicyMode {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    if (!REVIEW_EXECUTION_POLICY_MODES.includes(normalized as ReviewExecutionPolicyMode)) {
        throw new Error(
            `${fieldName} must be one of: ${REVIEW_EXECUTION_POLICY_MODES.join(', ')}.`
        );
    }
    return normalized as ReviewExecutionPolicyMode;
}

export function buildReviewExecutionPolicySummaryLine(mode: EffectiveReviewExecutionPolicyMode): string {
    if (mode === LEGACY_REVIEW_EXECUTION_POLICY_MODE) {
        return 'Review execution policy: legacy_test_downstream (implicit compatibility mode)';
    }
    return `Review execution policy: ${mode}`;
}

export function describeReviewExecutionPolicy(mode: EffectiveReviewExecutionPolicyMode): string {
    switch (mode) {
        case LEGACY_REVIEW_EXECUTION_POLICY_MODE:
            return 'Implicit compatibility fallback for legacy repos: non-test reviews stay independent while test waits for every required upstream review.';
        case 'parallel_all':
            return 'All review types may be prepared independently; no upstream launch dependencies apply.';
        case 'test_after_code':
            return 'Only test waits for a current-cycle code PASS; other review types stay independent.';
        case 'code_first_optional':
            return 'API, performance, infra, and dependency wait for code PASS; test remains downstream of all required upstream reviews.';
        case 'strict_sequential':
            return 'All required reviews follow the canonical review order one by one for the current cycle.';
        default:
            return 'Review launch ordering follows the configured repo-local policy.';
    }
}

export function getReviewExecutionPreparationOrder(
    _mode: EffectiveReviewExecutionPolicyMode
): readonly string[] {
    return REVIEW_EXECUTION_PREPARATION_ORDER;
}

export function getReviewExecutionPreparationBatches(
    requiredReviewRecord: Record<string, boolean>,
    mode: EffectiveReviewExecutionPolicyMode,
    dependencyGraph?: CompiledReviewDependencyGraph | null
): string[][] {
    if (dependencyGraph) {
        return dependencyGraph.preparation_batches.map((batch) => [...batch]);
    }
    const orderedRequiredReviewTypes = Object.entries(requiredReviewRecord)
        .filter(([, required]) => required)
        .map(([reviewType]) => normalizeReviewType(reviewType))
        .sort((left, right) => {
            const reviewOrder = getReviewExecutionPreparationOrder(mode);
            const leftRank = reviewOrder.indexOf(left);
            const rightRank = reviewOrder.indexOf(right);
            if (leftRank !== rightRank) {
                return leftRank - rightRank;
            }
            return left.localeCompare(right);
        });
    const remaining = new Set(orderedRequiredReviewTypes);
    const batches: string[][] = [];

    while (remaining.size > 0) {
        const nextBatch = orderedRequiredReviewTypes.filter((reviewType) => (
            remaining.has(reviewType)
            && getReviewExecutionDependencies(reviewType, requiredReviewRecord, mode).every((dependency) => !remaining.has(dependency))
        ));
        if (nextBatch.length === 0) {
            const [fallbackReviewType] = orderedRequiredReviewTypes.filter((reviewType) => remaining.has(reviewType));
            batches.push([fallbackReviewType]);
            remaining.delete(fallbackReviewType);
            continue;
        }
        batches.push(nextBatch);
        for (const reviewType of nextBatch) {
            remaining.delete(reviewType);
        }
    }

    return batches;
}

export function computeReviewLaunchPlan(params: {
    requiredReviewTypes: readonly string[];
    requiredReviews: Record<string, boolean>;
    policyMode: EffectiveReviewExecutionPolicyMode;
    dependencyGraph?: CompiledReviewDependencyGraph | null;
    reviewStates: readonly ReviewLaunchEvidenceState[];
}): ReviewLaunchPlan {
    const normalizedRequiredReviewTypes = params.requiredReviewTypes.map(normalizeReviewType);
    const requiredReviewTypeSet = new Set(normalizedRequiredReviewTypes);
    const graphOrderedReviewTypes = params.dependencyGraph?.preparation_order
        .map(normalizeReviewType)
        .filter((reviewType) => requiredReviewTypeSet.has(reviewType)) || [];
    const graphOrderedReviewTypeSet = new Set(graphOrderedReviewTypes);
    const requiredReviewTypes = [
        ...graphOrderedReviewTypes,
        ...normalizedRequiredReviewTypes.filter((reviewType) => !graphOrderedReviewTypeSet.has(reviewType))
    ];
    const stateByType = new Map(
        params.reviewStates.map((state) => [normalizeReviewType(state.review_type), state])
    );
    const satisfiedReviews = new Set(
        requiredReviewTypes.filter((reviewType) => stateByType.get(reviewType)?.satisfied === true)
    );
    const dependenciesByReviewType = new Map<string, string[]>();
    const getBlockedBy = (reviewType: string): string[] => {
        const cached = dependenciesByReviewType.get(reviewType);
        if (cached) {
            return cached;
        }
        const blockedBy = getReviewExecutionDependencies(
            reviewType,
            params.requiredReviews,
            params.policyMode,
            params.dependencyGraph
        )
            .filter((dependency) => !satisfiedReviews.has(normalizeReviewType(dependency)))
            .map(normalizeReviewType);
        dependenciesByReviewType.set(reviewType, blockedBy);
        return blockedBy;
    };
    const failedReviewType = requiredReviewTypes.find((reviewType) => {
        const state = stateByType.get(reviewType);
        return state?.failed_current === true
            && !satisfiedReviews.has(reviewType)
            && getBlockedBy(reviewType).length === 0;
    }) || null;
    const blockedReviewLanes: ReviewLaunchBlockedLane[] = [];
    const launchableReviewTypes: string[] = [];

    for (const reviewType of requiredReviewTypes) {
        if (satisfiedReviews.has(reviewType)) {
            continue;
        }
        const blockedBy = getBlockedBy(reviewType);
        if (blockedBy.length > 0) {
            blockedReviewLanes.push({
                review_type: reviewType,
                blocked_by: blockedBy
            });
            continue;
        }
        if (!failedReviewType) {
            launchableReviewTypes.push(reviewType);
        }
    }

    if (failedReviewType) {
        return {
            launchable_review_types: [],
            blocked_review_lanes: blockedReviewLanes,
            failed_review_type: failedReviewType,
            next_review_type: failedReviewType,
            blocked_review_dependencies:
                blockedReviewLanes.find((lane) => lane.review_type === failedReviewType)?.blocked_by || []
        };
    }

    const [nextLaunchableReviewType] = launchableReviewTypes;
    if (nextLaunchableReviewType) {
        return {
            launchable_review_types: launchableReviewTypes,
            blocked_review_lanes: blockedReviewLanes,
            failed_review_type: null,
            next_review_type: nextLaunchableReviewType,
            blocked_review_dependencies: []
        };
    }

    const [firstBlockedLane] = blockedReviewLanes;
    return {
        launchable_review_types: [],
        blocked_review_lanes: blockedReviewLanes,
        failed_review_type: null,
        next_review_type: firstBlockedLane?.review_type || null,
        blocked_review_dependencies: firstBlockedLane?.blocked_by || []
    };
}

function hasOwnCaseInsensitiveKey(record: Record<string, unknown>, expectedKey: string): boolean {
    return Object.keys(record).some((candidate) => candidate.toLowerCase() === expectedKey.toLowerCase());
}

function ensureExactKeyOrThrow(
    record: Record<string, unknown>,
    expectedKey: string,
    fieldName: string
): boolean {
    if (hasOwnExactKey(record, expectedKey)) {
        return true;
    }
    if (hasOwnCaseInsensitiveKey(record, expectedKey)) {
        throw new Error(`${fieldName} must use the exact key '${expectedKey}'.`);
    }
    return false;
}

function validateConfiguredReviewExecutionPolicySection(
    section: unknown,
    fieldName = 'review_execution_policy'
): ReviewExecutionPolicyConfig {
    if (!isPlainRecord(section)) {
        throw new Error(`${fieldName} must be a JSON object.`);
    }

    for (const key of Object.keys(section)) {
        if (key !== 'mode') {
            throw new Error(`${fieldName}.${key} is not allowed.`);
        }
    }

    if (!ensureExactKeyOrThrow(section, 'mode', fieldName)) {
        throw new Error(`${fieldName}.mode is required.`);
    }

    return {
        mode: normalizeReviewExecutionPolicyMode(section.mode, `${fieldName}.mode`)
    };
}

export function getReviewExecutionDependencies(
    reviewType: string,
    requiredReviewRecord: Record<string, boolean>,
    mode: EffectiveReviewExecutionPolicyMode,
    dependencyGraph?: CompiledReviewDependencyGraph | null
): string[] {
    const normalizedReviewType = normalizeReviewType(reviewType);
    if (dependencyGraph) {
        return [...(dependencyGraph.dependencies[normalizedReviewType] || [])];
    }
    switch (mode) {
        case LEGACY_REVIEW_EXECUTION_POLICY_MODE:
            return normalizedReviewType === 'test'
                ? REVIEW_TYPES_DOWNSTREAM_OF_TEST.filter((candidate) => requiredReviewRecord[candidate] === true)
                : [];
        case 'parallel_all':
            return [];
        case 'test_after_code':
            return normalizedReviewType === 'test' && requiredReviewRecord.code === true
                ? ['code']
                : [];
        case 'code_first_optional':
            if (normalizedReviewType === 'test') {
                return REVIEW_TYPES_DOWNSTREAM_OF_TEST.filter((candidate) => requiredReviewRecord[candidate] === true);
            }
            if (REVIEW_TYPES_THAT_WAIT_FOR_CODE.has(normalizedReviewType) && requiredReviewRecord.code === true) {
                return ['code'];
            }
            return [];
        case 'strict_sequential': {
            const reviewOrder = getReviewExecutionPreparationOrder(mode);
            const reviewIndex = reviewOrder.indexOf(normalizedReviewType);
            if (reviewIndex <= 0) {
                return [];
            }
            return reviewOrder
                .slice(0, reviewIndex)
                .filter((candidate) => requiredReviewRecord[candidate] === true);
        }
        default:
            return [];
    }
}

export function resolveReviewExecutionPolicyConfigFromWorkflowConfig(
    workflowConfig: unknown,
    fallbackMode: ReviewExecutionPolicyMode = DEFAULT_REVIEW_EXECUTION_POLICY_MODE
): ReviewExecutionPolicyConfig {
    if (!isPlainRecord(workflowConfig)) {
        return { mode: fallbackMode };
    }

    if (!ensureExactKeyOrThrow(workflowConfig, 'review_execution_policy', 'workflow-config')) {
        return { mode: fallbackMode };
    }

    return validateConfiguredReviewExecutionPolicySection(
        workflowConfig.review_execution_policy,
        'workflow-config.review_execution_policy'
    );
}

export function resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig(
    workflowConfig: unknown,
    missingSectionMode: EffectiveReviewExecutionPolicyMode = LEGACY_REVIEW_EXECUTION_POLICY_MODE
): ResolvedReviewExecutionPolicyConfig {
    if (!isPlainRecord(workflowConfig)) {
        return {
            mode: missingSectionMode,
            configured: false
        };
    }
    if (!ensureExactKeyOrThrow(workflowConfig, 'review_execution_policy', 'workflow-config')) {
        return {
            mode: missingSectionMode,
            configured: false
        };
    }

    return {
        mode: validateConfiguredReviewExecutionPolicySection(
            workflowConfig.review_execution_policy,
            'workflow-config.review_execution_policy'
        ).mode,
        configured: true
    };
}

export function resolveReviewExecutionPolicyModeFromPreflight(
    preflightPayload: unknown,
    fallbackMode: EffectiveReviewExecutionPolicyMode = LEGACY_REVIEW_EXECUTION_POLICY_MODE
): EffectiveReviewExecutionPolicyMode {
    if (!isPlainRecord(preflightPayload)) {
        return fallbackMode;
    }
    const rawSection = preflightPayload.review_execution_policy;
    if (!isPlainRecord(rawSection) || !hasOwnExactKey(rawSection, 'mode')) {
        return fallbackMode;
    }

    const rawMode = String(rawSection.mode || '').trim().toLowerCase();
    if (rawMode === LEGACY_REVIEW_EXECUTION_POLICY_MODE) {
        return LEGACY_REVIEW_EXECUTION_POLICY_MODE;
    }

    return normalizeReviewExecutionPolicyMode(rawSection.mode, 'preflight.review_execution_policy.mode');
}

export function loadReviewExecutionPolicyConfig(repoRoot: string): ResolvedReviewExecutionPolicyConfig {
    const configPath = path.join(repoRoot, resolveBundleName(), 'live', 'config', 'workflow-config.json');
    assertWorkflowTransactionReadable(path.dirname(path.dirname(path.dirname(configPath))));
    if (!pathExists(configPath)) {
        return {
            mode: LEGACY_REVIEW_EXECUTION_POLICY_MODE,
            configured: false
        };
    }

    const parsed = readJsonFile(configPath);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Workflow config at '${configPath}' must be a JSON object.`);
    }
    return resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig(
        parsed,
        LEGACY_REVIEW_EXECUTION_POLICY_MODE
    );
}
