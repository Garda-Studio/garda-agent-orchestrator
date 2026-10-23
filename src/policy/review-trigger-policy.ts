import * as fs from 'node:fs';
import { normalizeFileRoleBindings, type FileRoleBindings } from '../core/file-role-bindings';
import { DEFAULT_REFACTOR_PATH_REGEXES, DEFAULT_TEST_PATH_REGEXES } from './default-path-regexes';

export const REVIEW_TRIGGER_POLICY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_TEST_REFACTOR_CHANGED_LINES_THRESHOLD = 50;

export interface ReviewTriggerPolicy {
    schema_version: typeof REVIEW_TRIGGER_POLICY_SCHEMA_VERSION;
    refactor_path_regexes: string[];
    test_path_regexes: string[];
    test_refactor_structural_path_regexes: string[];
    test_refactor_changed_lines_threshold: number;
    file_roles?: FileRoleBindings;
}

const DEFAULT_TEST_REFACTOR_STRUCTURAL_PATH_REGEXES = Object.freeze([
    '(^|/)(?:__fixtures__|fixtures?|__mocks__|mocks?|helpers?|harness|support|setup|factories|factory|snapshots?)(?:/|\\.|-|_|$)',
    '(?:test|spec)[-_]?(?:helpers?|fixtures?|harness|support|setup|factories?|mocks?)',
    '(?:helpers?|fixtures?|harness|support|setup|factories?|mocks?)[-_]?(?:test|spec)'
]);

export const DEFAULT_REVIEW_TRIGGER_POLICY: Readonly<ReviewTriggerPolicy> = Object.freeze({
    schema_version: REVIEW_TRIGGER_POLICY_SCHEMA_VERSION,
    refactor_path_regexes: [...DEFAULT_REFACTOR_PATH_REGEXES],
    test_path_regexes: [...DEFAULT_TEST_PATH_REGEXES],
    test_refactor_structural_path_regexes: [...DEFAULT_TEST_REFACTOR_STRUCTURAL_PATH_REGEXES],
    test_refactor_changed_lines_threshold: DEFAULT_TEST_REFACTOR_CHANGED_LINES_THRESHOLD
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneDefaultPolicy(): ReviewTriggerPolicy {
    return {
        schema_version: REVIEW_TRIGGER_POLICY_SCHEMA_VERSION,
        refactor_path_regexes: [...DEFAULT_REVIEW_TRIGGER_POLICY.refactor_path_regexes],
        test_path_regexes: [...DEFAULT_REVIEW_TRIGGER_POLICY.test_path_regexes],
        test_refactor_structural_path_regexes: [...DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_structural_path_regexes],
        test_refactor_changed_lines_threshold: DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_changed_lines_threshold
    };
}

function normalizeRegexList(value: unknown, label: string, fallback: readonly string[]): string[] {
    if (value === undefined) return [...fallback];
    const candidates = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(candidates)) {
        throw new Error(`${label} must be a string or string array.`);
    }
    const normalized: string[] = [];
    for (const candidate of candidates) {
        if (typeof candidate !== 'string' || !candidate.trim()) {
            throw new Error(`${label} must contain only non-empty regex strings.`);
        }
        const pattern = candidate.trim();
        try {
            new RegExp(pattern, 'iu');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${label} contains invalid regex '${pattern}': ${message}`);
        }
        if (!normalized.includes(pattern)) normalized.push(pattern);
    }
    return normalized;
}

function normalizeThreshold(value: unknown, label: string, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || Number(value) < 1) {
        throw new Error(`${label} must be a positive safe integer.`);
    }
    return Number(value);
}

export function normalizeReviewTriggerPolicyFromPaths(pathsConfig: unknown): ReviewTriggerPolicy {
    if (pathsConfig === undefined || pathsConfig === null) return cloneDefaultPolicy();
    if (!isPlainRecord(pathsConfig)) {
        throw new Error('paths review-trigger configuration must be a JSON object.');
    }
    const rawTriggers = pathsConfig.triggers;
    if (rawTriggers !== undefined && !isPlainRecord(rawTriggers)) {
        throw new Error('paths.triggers must be a JSON object.');
    }
    const triggers = isPlainRecord(rawTriggers) ? rawTriggers : {};
    const fileRoles = normalizeFileRoleBindings(pathsConfig.file_roles, 'paths.file_roles');
    return {
        schema_version: REVIEW_TRIGGER_POLICY_SCHEMA_VERSION,
        ...(Object.keys(fileRoles).length > 0 ? { file_roles: fileRoles } : {}),
        refactor_path_regexes: normalizeRegexList(
            triggers.refactor,
            'paths.triggers.refactor',
            DEFAULT_REVIEW_TRIGGER_POLICY.refactor_path_regexes
        ),
        test_path_regexes: normalizeRegexList(
            triggers.test,
            'paths.triggers.test',
            DEFAULT_REVIEW_TRIGGER_POLICY.test_path_regexes
        ),
        test_refactor_structural_path_regexes: normalizeRegexList(
            triggers.test_refactor_structural,
            'paths.triggers.test_refactor_structural',
            DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_structural_path_regexes
        ),
        test_refactor_changed_lines_threshold: normalizeThreshold(
            pathsConfig.test_refactor_changed_lines_threshold,
            'paths.test_refactor_changed_lines_threshold',
            DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_changed_lines_threshold
        )
    };
}

export function loadReviewTriggerPolicy(pathsConfigPath: string): ReviewTriggerPolicy {
    if (!fs.existsSync(pathsConfigPath)) return cloneDefaultPolicy();
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8')) as unknown;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not parse review-trigger configuration '${pathsConfigPath}': ${message}`);
    }
    return normalizeReviewTriggerPolicyFromPaths(parsed);
}

export function validateReviewTriggerPolicy(value: unknown): ReviewTriggerPolicy {
    if (!isPlainRecord(value)) {
        throw new Error('review_trigger_policy must be a JSON object.');
    }
    if (value.schema_version !== REVIEW_TRIGGER_POLICY_SCHEMA_VERSION) {
        throw new Error(`review_trigger_policy.schema_version must be ${REVIEW_TRIGGER_POLICY_SCHEMA_VERSION}.`);
    }
    for (const requiredKey of [
        'refactor_path_regexes',
        'test_path_regexes',
        'test_refactor_structural_path_regexes',
        'test_refactor_changed_lines_threshold'
    ] as const) {
        if (!Object.hasOwn(value, requiredKey)) {
            throw new Error(`review_trigger_policy.${requiredKey} is required.`);
        }
    }
    const fileRoles = normalizeFileRoleBindings(value.file_roles, 'review_trigger_policy.file_roles');
    return {
        schema_version: REVIEW_TRIGGER_POLICY_SCHEMA_VERSION,
        ...(Object.keys(fileRoles).length > 0 ? { file_roles: fileRoles } : {}),
        refactor_path_regexes: normalizeRegexList(
            value.refactor_path_regexes,
            'review_trigger_policy.refactor_path_regexes',
            []
        ),
        test_path_regexes: normalizeRegexList(
            value.test_path_regexes,
            'review_trigger_policy.test_path_regexes',
            []
        ),
        test_refactor_structural_path_regexes: normalizeRegexList(
            value.test_refactor_structural_path_regexes,
            'review_trigger_policy.test_refactor_structural_path_regexes',
            []
        ),
        test_refactor_changed_lines_threshold: normalizeThreshold(
            value.test_refactor_changed_lines_threshold,
            'review_trigger_policy.test_refactor_changed_lines_threshold',
            0
        )
    };
}
