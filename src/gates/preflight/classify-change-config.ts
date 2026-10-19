import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeFileRoleBindings, type FileRoleBindings } from '../../core/file-role-bindings';
import { readProjectValidationFileRoles } from '../../core/project-validation-authority';

import {
    DEFAULT_ORDINARY_DOC_PATHS,
    ORDINARY_DOC_PATHS_CONFIG_KEY,
    normalizeOrdinaryDocPathPatterns
} from '../../core/ordinary-doc-paths';
import {
    getDefaultReviewCapabilities,
    readReviewCapabilitiesConfigFile,
    type ReviewCapabilities
} from '../../core/review-capabilities';
import type { EffectiveReviewExecutionPolicyMode } from '../../core/review-execution-policy';
import {
    DEFAULT_REVIEW_TRIGGER_POLICY,
    normalizeReviewTriggerPolicyFromPaths,
    type ReviewTriggerPolicy
} from '../../policy/review-trigger-policy';
import {
    DEFAULT_API_TRIGGER_REGEXES,
    DEFAULT_CODE_LIKE_REGEXES,
    DEFAULT_DB_TRIGGER_REGEXES,
    DEFAULT_DEPENDENCY_TRIGGER_REGEXES,
    DEFAULT_PERFORMANCE_TRIGGER_REGEXES
} from '../../policy/default-path-regexes';
import { resolveGateExecutionPath } from '../isolation/isolation-sandbox';
import {
    getProtectedControlPlaneRoots,
    normalizePath,
    normalizeProtectedControlPlaneRoots,
    normalizeRootPrefixes,
    orchestratorRelativePath,
    testPathPrefix,
    toPosix,
    toStringArray
} from '../shared/helpers';

interface TriggerConfig {
    db: string[];
    security: string[];
    api: string[];
    dependency: string[];
    infra: string[];
    refactor: string[];
    test: string[];
    performance: string[];
}

export interface ClassificationConfig {
    metrics_path: string;
    runtime_roots: string[];
    fast_path_roots: string[];
    fast_path_allowed_regexes: string[];
    fast_path_sensitive_regexes: string[];
    sql_or_migration_regexes: string[];
    test_refactor_changed_lines_threshold: number;
    triggers: TriggerConfig;
    code_like_regexes: string[];
    protected_control_plane_roots: string[];
    ordinary_doc_paths: string[];
}

export interface ResolvedClassificationConfig {
    file_roles?: FileRoleBindings;
    source: string;
    config_path: string;
    metrics_path: string;
    runtime_roots: string[];
    fast_path_roots: string[];
    fast_path_allowed_regexes: string[];
    fast_path_sensitive_regexes: string[];
    sql_or_migration_regexes: string[];
    test_refactor_changed_lines_threshold: number;
    db_trigger_regexes: string[];
    security_trigger_regexes: string[];
    api_trigger_regexes: string[];
    dependency_trigger_regexes: string[];
    infra_trigger_regexes: string[];
    refactor_trigger_regexes: string[];
    test_trigger_regexes: string[];
    test_refactor_structural_trigger_regexes: string[];
    performance_trigger_regexes: string[];
    code_like_regexes: string[];
    protected_control_plane_roots: string[];
    ordinary_doc_paths: string[];
}

interface MatchConfiguredRootOptions {
    allowNestedRoot?: boolean;
    semanticPackageMatch?: boolean;
}

export interface ClassifyChangeOptions {
    declaredTestPaths?: readonly string[];
    normalizedFiles?: string[];
    repoRoot?: string;
    isSourceCheckout?: boolean;
    taskIntent?: string;
    fastPathMaxFiles?: number;
    fastPathMaxChangedLines?: number;
    performanceHeuristicMinLines?: number;
    changedLinesTotal?: number;
    additionsTotal?: number;
    deletionsTotal?: number;
    changedFileStats?: Record<string, { additions: number; deletions: number; changed_lines: number }>;
    renameCount?: number;
    detectionSource?: string;
    classificationConfig: ResolvedClassificationConfig;
    reviewCapabilities?: Partial<ReviewCapabilities>;
    reviewExecutionPolicyMode?: EffectiveReviewExecutionPolicyMode;
}

export interface GetClassificationConfigOptions {
    reviewTriggerPolicy?: ReviewTriggerPolicy;
}

/**
 * Default classification config for the Node gate runtime.
 */
export function getDefaultClassificationConfig(repoRoot: string): ClassificationConfig {
    return {
        metrics_path: orchestratorRelativePath(repoRoot, 'runtime/metrics.jsonl'),
        runtime_roots: ['src/', 'app/', 'apps/', 'backend/', 'frontend/', 'web/', 'api/', 'services/', 'packages/'],
        fast_path_roots: ['frontend/', 'web/', 'ui/', 'mobile/', 'apps/'],
        fast_path_allowed_regexes: [
            '^.+\\.(ts|tsx|js|jsx|vue|svelte|css|scss|sass|less|html)$',
            '^.+\\.(svg|png|jpg|jpeg|webp|ico)$'
        ],
        fast_path_sensitive_regexes: [
            '(^|/)(auth|security|payment|checkout|webhook|token|jwt|guard|middleware|service|repository|query|migration|sql|datasource)(/|\\.|$)'
        ],
        sql_or_migration_regexes: ['\\.sql$', '(^|/)(db|database|migrations?|schema)(/|$)'],
        test_refactor_changed_lines_threshold: DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_changed_lines_threshold,
        triggers: {
            db: [...DEFAULT_DB_TRIGGER_REGEXES],
            security: [
                '(^|/)(auth|security|oauth|jwt|token|rbac|acl|keycloak|okta|saml|openid|mfa|crypt|encryption|certificate|secret|vault|webhook|payment|checkout|billing)(/|\\.|$)'
            ],
            api: [...DEFAULT_API_TRIGGER_REGEXES],
            dependency: [...DEFAULT_DEPENDENCY_TRIGGER_REGEXES],
            infra: [
                '(^|/)Dockerfile(\\..+)?$',
                '(^|/)docker-compose(\\.[^/]+)?\\.ya?ml$',
                '(^|/)(terraform|infra|infrastructure|helm|k8s|kubernetes)(/|$)',
                '(^|/)\\.github/workflows/'
            ],
            refactor: [...DEFAULT_REVIEW_TRIGGER_POLICY.refactor_path_regexes],
            test: [...DEFAULT_REVIEW_TRIGGER_POLICY.test_path_regexes],
            performance: [...DEFAULT_PERFORMANCE_TRIGGER_REGEXES]
        },
        code_like_regexes: [...DEFAULT_CODE_LIKE_REGEXES],
        protected_control_plane_roots: getProtectedControlPlaneRoots(repoRoot),
        ordinary_doc_paths: [...DEFAULT_ORDINARY_DOC_PATHS]
    };
}

/**
 * Load classification config from paths.json with defaults.
 */
export function getClassificationConfig(
    repoRoot: string,
    options: GetClassificationConfigOptions = {}
): ResolvedClassificationConfig {
    const defaults = getDefaultClassificationConfig(repoRoot);
    const configPath = resolveGateExecutionPath(repoRoot, 'live/config/paths.json');
    let source = 'defaults';
    let rawPathsConfig: Record<string, unknown> = {};

    if (fs.existsSync(configPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
            rawPathsConfig = raw;
            for (const key of [
                'metrics_path', 'runtime_roots', 'fast_path_roots',
                'fast_path_allowed_regexes', 'fast_path_sensitive_regexes',
                'sql_or_migration_regexes', 'code_like_regexes', 'protected_control_plane_roots',
                'test_refactor_changed_lines_threshold', ORDINARY_DOC_PATHS_CONFIG_KEY
            ] as const) {
                if (key in raw) (defaults as unknown as Record<string, unknown>)[key] = raw[key];
            }
            if (raw.triggers && typeof raw.triggers === 'object') {
                const rawTriggers = raw.triggers as Record<string, unknown>;
                for (const triggerKey of ['db', 'security', 'api', 'dependency', 'infra', 'refactor', 'test', 'performance'] as const) {
                    if (triggerKey in rawTriggers) {
                        defaults.triggers[triggerKey] = rawTriggers[triggerKey] as string[];
                    }
                }
            }
            source = 'paths_json';
        } catch (error: unknown) {
            if (!options.reviewTriggerPolicy) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`Could not parse classification config '${configPath}': ${message}`);
            }
            source = 'defaults_with_config_parse_error';
        }
    }

    const reviewTriggerPolicy = options.reviewTriggerPolicy
        ? validateClassificationReviewTriggerPolicy(options.reviewTriggerPolicy)
        : normalizeReviewTriggerPolicyFromPaths(rawPathsConfig);

    const ordinaryDocPaths = normalizeOrdinaryDocPathPatterns(
        defaults.ordinary_doc_paths,
        `paths.${ORDINARY_DOC_PATHS_CONFIG_KEY}`,
        { allowScalar: true }
    );
    const fileRoles = mergeFileRoleBindings(reviewTriggerPolicy.file_roles ?? {}, readProjectValidationFileRoles(repoRoot));
    const protectedControlPlaneRoots = normalizeProtectedControlPlaneRoots(toStringArray(defaults.protected_control_plane_roots));
    for (const [file, role] of Object.entries(fileRoles)) {
        if (role === 'test' && testPathPrefix(file, protectedControlPlaneRoots)) {
            throw new Error(`Declared test role cannot downgrade protected control-plane scope: ${file}`);
        }
    }

    return {
        ...(Object.keys(fileRoles).length > 0 ? { file_roles: fileRoles } : {}),
        source: options.reviewTriggerPolicy ? 'task_profile_policy_snapshot' : source,
        config_path: toPosix(path.resolve(configPath)),
        metrics_path: String(defaults.metrics_path),
        runtime_roots: normalizeRootPrefixes(toStringArray(defaults.runtime_roots)),
        fast_path_roots: normalizeRootPrefixes(toStringArray(defaults.fast_path_roots)),
        fast_path_allowed_regexes: toStringArray(defaults.fast_path_allowed_regexes),
        fast_path_sensitive_regexes: toStringArray(defaults.fast_path_sensitive_regexes),
        sql_or_migration_regexes: toStringArray(defaults.sql_or_migration_regexes),
        test_refactor_changed_lines_threshold: reviewTriggerPolicy.test_refactor_changed_lines_threshold,
        db_trigger_regexes: toStringArray(defaults.triggers.db),
        security_trigger_regexes: toStringArray(defaults.triggers.security),
        api_trigger_regexes: toStringArray(defaults.triggers.api),
        dependency_trigger_regexes: toStringArray(defaults.triggers.dependency),
        infra_trigger_regexes: toStringArray(defaults.triggers.infra),
        refactor_trigger_regexes: [...reviewTriggerPolicy.refactor_path_regexes],
        test_trigger_regexes: [...reviewTriggerPolicy.test_path_regexes],
        test_refactor_structural_trigger_regexes: [...reviewTriggerPolicy.test_refactor_structural_path_regexes],
        performance_trigger_regexes: toStringArray(defaults.triggers.performance),
        code_like_regexes: toStringArray(defaults.code_like_regexes),
        protected_control_plane_roots: protectedControlPlaneRoots,
        ordinary_doc_paths: ordinaryDocPaths
    };
}

function validateClassificationReviewTriggerPolicy(policy: ReviewTriggerPolicy): ReviewTriggerPolicy {
    return normalizeReviewTriggerPolicyFromPaths({
        file_roles: policy.file_roles,
        test_refactor_changed_lines_threshold: policy.test_refactor_changed_lines_threshold,
        triggers: {
            refactor: policy.refactor_path_regexes,
            test: policy.test_path_regexes,
            test_refactor_structural: policy.test_refactor_structural_path_regexes
        }
    });
}

/**
 * Load review capabilities from config file.
 */
export function getReviewCapabilities(repoRoot: string): ReviewCapabilities {
    const configPath = resolveGateExecutionPath(repoRoot, 'live/config/review-capabilities.json');
    try {
        return readReviewCapabilitiesConfigFile(configPath);
    } catch {
        return getDefaultReviewCapabilities();
    }
}

const GROUPED_PACKAGE_ROOTS = Object.freeze(['apps', 'packages', 'services', 'workspaces', 'projects']);

function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getRootTokens(roots: string[]): string[] {
    return normalizeRootPrefixes(toStringArray(roots))
        .map((root: string) => root.replace(/\/+$/, '').toLowerCase())
        .filter(Boolean);
}

function matchesSemanticRoot(segment: string, rootTokens: string[]): boolean {
    const normalizedSegment = String(segment || '').trim().toLowerCase();
    if (!normalizedSegment) {
        return false;
    }

    return rootTokens.some((token: string) => {
        if (!token || token === 'src') {
            return false;
        }
        const pattern = new RegExp(`(^|[-_.])${escapeRegex(token)}($|[-_.])`, 'i');
        return pattern.test(normalizedSegment);
    });
}

export function matchesConfiguredRoot(pathValue: string, roots: string[], options: MatchConfiguredRootOptions = {}): boolean {
    const normalizedPath = normalizePath(pathValue).toLowerCase();
    if (!normalizedPath) {
        return false;
    }

    if (testPathPrefix(normalizedPath, roots)) {
        return true;
    }

    const segments = normalizedPath.split('/').filter(Boolean);
    if (segments.length < 2) {
        return false;
    }

    const rootTokens = getRootTokens(roots);
    if (options.allowNestedRoot && rootTokens.includes(segments[1])) {
        return true;
    }

    if (!options.semanticPackageMatch) {
        return false;
    }

    const semanticCandidates = [segments[0]];
    if (GROUPED_PACKAGE_ROOTS.includes(segments[0]) && segments[1]) {
        semanticCandidates.push(segments[1]);
    }

    return semanticCandidates.some((candidate) => matchesSemanticRoot(candidate, rootTokens));
}
