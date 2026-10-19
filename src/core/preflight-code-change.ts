import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    ALL_BUNDLE_NAMES,
    isBundleRootLike,
    isRecognizedPackageName,
    resolveBundleNameForTarget
} from './constants';
import {
    DEFAULT_ORDINARY_DOC_PATHS,
    matchOrdinaryDocPathPattern
} from './ordinary-doc-paths';
import {
    joinOrchestratorPath,
    normalizePath,
    testPathPrefix
} from './orchestrator-paths';
import { DEFAULT_CODE_LIKE_REGEXES, DEFAULT_RUNTIME_ROOTS } from '../policy/default-path-regexes';

export type LegacyScopeClassifier = (
    changedFiles: string[],
    repoRoot: string
) => 'code' | 'mixed' | 'docs-only' | 'config-only' | 'audit-only' | 'empty' | string;

const DOC_LIKE_REGEXES = [
    '\\.(md|mdx|txt|rst|adoc|asciidoc|textile)$',
    '(^|/)docs?/',
    '(^|/)README',
    '(^|/)CHANGELOG',
    '(^|/)LICENSE',
    '(^|/)CONTRIBUTING',
    '(^|/)SECURITY\\.md$',
    '(^|/)NOTICE$',
    '(^|/)TRADEMARKS',
    '(^|/)CODEOWNERS$'
];
const CONFIG_LIKE_REGEXES = [
    '\\.(json|ya?ml|toml|ini|cfg|conf|env|properties|xml)$',
    '(^|/)\\.editorconfig$',
    '(^|/)tsconfig',
    '(^|/)jest\\.config',
    '(^|/)vitest\\.config',
    '(^|/)eslint',
    '(^|/)prettier',
    '(^|/)\\.github/workflows/',
    '(^|/)Dockerfile',
    '(^|/)docker-compose'
];
const AUDIT_ONLY_REGEXES = [
    '(^|/)TASK\\.md$',
    '(^|/)garda-agent-orchestrator/runtime/',
    '(^|/)\\.agents/',
    '(^|/)garda-agent-orchestrator/live/docs/agent-rules/',
    '(^|/)garda-agent-orchestrator/live/config/',
    '(^|/)garda-agent-orchestrator/live/docs/changes/'
];

interface LegacyClassificationConfig {
    codeLikeRegexes: string[];
    runtimeRoots: string[];
    ordinaryDocPaths: string[];
    protectedControlPlaneRoots: string[];
    sqlOrMigrationRegexes: string[];
    dbTriggerRegexes: string[];
    securityTriggerRegexes: string[];
    apiTriggerRegexes: string[];
    dependencyTriggerRegexes: string[];
}

const legacyClassificationConfigCache = new Map<string, LegacyClassificationConfig>();

function toStringArray(value: unknown, fallback: readonly string[]): string[] {
    return Array.isArray(value)
        ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [...fallback];
}

function readLegacyClassificationConfig(repoRoot: string): LegacyClassificationConfig {
    const defaultTriggers = {
        db: [
            '(^|/)(db|database|migrations?|schema)(/|$)',
            '\\.sql$'
        ],
        security: [
            '(^|/)(auth|security|oauth|jwt|token|rbac|acl|keycloak|okta|saml|openid|mfa|crypt|encryption|certificate|secret|vault|webhook|payment|checkout|billing)(/|\\.|$)'
        ],
        api: [
            '(^|/)(controllers?|routes?|handlers?|endpoints?|graphql)(/|\\.|$)',
            '(^|/)(openapi|swagger)\\.(ya?ml|json)$'
        ],
        dependency: [
            '(^|/)package(-lock)?\\.json$',
            '(^|/)pnpm-lock\\.yaml$',
            '(^|/)yarn\\.lock$',
            '(^|/)pom\\.xml$',
            '(^|/)build\\.gradle(\\.kts)?$'
        ]
    };
    const fallback: LegacyClassificationConfig = {
        codeLikeRegexes: [...DEFAULT_CODE_LIKE_REGEXES],
        runtimeRoots: [...DEFAULT_RUNTIME_ROOTS],
        ordinaryDocPaths: [...DEFAULT_ORDINARY_DOC_PATHS],
        protectedControlPlaneRoots: getDefaultProtectedControlPlaneRoots(repoRoot),
        sqlOrMigrationRegexes: ['\\.sql$', '(^|/)(db|database|migrations?|schema)(/|$)'],
        dbTriggerRegexes: defaultTriggers.db,
        securityTriggerRegexes: defaultTriggers.security,
        apiTriggerRegexes: defaultTriggers.api,
        dependencyTriggerRegexes: defaultTriggers.dependency
    };
    try {
        const configPath = joinOrchestratorPath(repoRoot, 'live/config/paths.json');
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
        const triggers = parsed.triggers && typeof parsed.triggers === 'object' && !Array.isArray(parsed.triggers)
            ? parsed.triggers as Record<string, unknown>
            : {};
        return {
            codeLikeRegexes: toStringArray(parsed.code_like_regexes, DEFAULT_CODE_LIKE_REGEXES),
            runtimeRoots: toStringArray(parsed.runtime_roots, DEFAULT_RUNTIME_ROOTS)
                .map((root) => normalizePath(root).replace(/\/?$/u, '/')),
            ordinaryDocPaths: toStringArray(parsed.ordinary_doc_paths, DEFAULT_ORDINARY_DOC_PATHS),
            protectedControlPlaneRoots: toStringArray(
                parsed.protected_control_plane_roots,
                fallback.protectedControlPlaneRoots
            ).map((root) => normalizePath(root)),
            sqlOrMigrationRegexes: toStringArray(
                parsed.sql_or_migration_regexes,
                fallback.sqlOrMigrationRegexes
            ),
            dbTriggerRegexes: toStringArray(triggers.db, fallback.dbTriggerRegexes),
            securityTriggerRegexes: toStringArray(
                triggers.security,
                fallback.securityTriggerRegexes
            ),
            apiTriggerRegexes: toStringArray(triggers.api, fallback.apiTriggerRegexes),
            dependencyTriggerRegexes: toStringArray(
                triggers.dependency,
                fallback.dependencyTriggerRegexes
            )
        };
    } catch {
        return fallback;
    }
}

function getLegacyClassificationConfig(repoRoot: string): LegacyClassificationConfig {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const cached = legacyClassificationConfigCache.get(resolvedRepoRoot);
    if (cached) {
        return cached;
    }
    const loaded = readLegacyClassificationConfig(resolvedRepoRoot);
    legacyClassificationConfigCache.set(resolvedRepoRoot, loaded);
    return loaded;
}

function getDefaultProtectedControlPlaneRoots(repoRoot: string): string[] {
    const effectiveBundleName = resolveBundleNameForTarget(repoRoot);
    const bundleNames = [...new Set([effectiveBundleName, ...ALL_BUNDLE_NAMES])];
    const roots = bundleNames.flatMap((bundleName) => [
        `${bundleName}/src/bin/`,
        `${bundleName}/src/cli/`,
        `${bundleName}/src/gates/`,
        `${bundleName}/src/gate-runtime/`,
        `${bundleName}/src/lifecycle/`,
        `${bundleName}/src/materialization/`,
        `${bundleName}/bin/`,
        `${bundleName}/dist/`,
        `${bundleName}/live/docs/agent-rules/`
    ]);
    let sourceCheckout = isBundleRootLike(repoRoot);
    try {
        const packageJson = JSON.parse(
            fs.readFileSync(joinOrchestratorPath(repoRoot, 'package.json'), 'utf8')
        ) as Record<string, unknown>;
        sourceCheckout ||= isRecognizedPackageName(packageJson.name);
    } catch {
        // A deployed workspace only needs the bundle-prefixed roots above.
    }
    if (sourceCheckout) {
        roots.push(
            'src/bin/',
            'src/cli/',
            'src/gates/',
            'src/gate-runtime/',
            'src/lifecycle/',
            'src/materialization/',
            'bin/',
            'dist/',
            'live/docs/agent-rules/'
        );
    }
    return roots.map((root) => normalizePath(root));
}

function matchesAnyRegex(value: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => {
        try {
            return new RegExp(pattern, 'i').test(value);
        } catch {
            return false;
        }
    });
}

function matchesRuntimeRoot(value: string, roots: readonly string[]): boolean {
    return roots.some((root) => {
        const normalizedRoot = normalizePath(root).replace(/^\/+|\/+$/gu, '');
        return normalizedRoot
            ? value === normalizedRoot
                || value.startsWith(`${normalizedRoot}/`)
                || value.includes(`/${normalizedRoot}/`)
            : false;
    });
}

function legacyPathCountsAsCode(filePath: string, config: LegacyClassificationConfig): boolean {
    const isRuntimeCode = matchesAnyRegex(filePath, config.codeLikeRegexes)
        && matchesRuntimeRoot(filePath, config.runtimeRoots);
    if (isRuntimeCode) {
        return true;
    }
    if (testPathPrefix(filePath, config.protectedControlPlaneRoots)
        || matchesAnyRegex(filePath, AUDIT_ONLY_REGEXES)
        || matchesAnyRegex(filePath, CONFIG_LIKE_REGEXES)) {
        return false;
    }

    const isDocumentation = matchesAnyRegex(filePath, DOC_LIKE_REGEXES)
        || matchOrdinaryDocPathPattern(filePath, config.ordinaryDocPaths) !== null;
    if (!isDocumentation) {
        return true;
    }

    const nonSecuritySensitiveRegexes = [
        ...config.sqlOrMigrationRegexes,
        ...config.dbTriggerRegexes,
        ...config.apiTriggerRegexes,
        ...config.dependencyTriggerRegexes
    ];
    if (matchesAnyRegex(filePath, nonSecuritySensitiveRegexes)) {
        return true;
    }

    // The canonical classifier keeps security-sensitive documentation in the
    // documentation scope while separately requiring security review.
    return false;
}

function classifyLegacyScopeWithoutGates(changedFiles: string[], repoRoot: string): string {
    if (changedFiles.length === 0) return 'empty';
    const config = getLegacyClassificationConfig(repoRoot);
    return changedFiles.some((filePath) => legacyPathCountsAsCode(filePath, config))
        ? 'code'
        : 'docs-only';
}

export function preflightRequiresAnyReview(preflight: Record<string, unknown> | null): boolean {
    if (!preflight) return false;
    const requiredReviews = preflight.required_reviews;
    if (requiredReviews && typeof requiredReviews === 'object' && !Array.isArray(requiredReviews)) {
        for (const value of Object.values(requiredReviews)) {
            if (value === true) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Detect whether preflight evidence represents a code change.
 *
 * Modern preflight artifacts are resolved entirely from their own metrics, triggers,
 * and scope category. Gate-level callers may inject the legacy workspace classifier.
 */
export function detectCodeChanged(
    preflight: Record<string, unknown> | null,
    repoRoot = '.',
    classifyLegacyScope?: LegacyScopeClassifier
): boolean {
    if (!preflight) return false;
    const metrics = preflight.metrics as Record<string, unknown> | undefined;
    const runtimeCodeLikeChangedCount = metrics?.runtime_code_like_changed_count;
    if (typeof runtimeCodeLikeChangedCount === 'number' && runtimeCodeLikeChangedCount > 0) {
        return true;
    }
    const codeLikeChangedCount = metrics?.code_like_changed_count;
    if (typeof codeLikeChangedCount === 'number' && codeLikeChangedCount > 0) {
        return true;
    }

    if (preflightRequiresAnyReview(preflight)) {
        return true;
    }

    const triggers = preflight.triggers;
    if (triggers && typeof triggers === 'object' && !Array.isArray(triggers)) {
        const triggerRecord = triggers as Record<string, unknown>;
        if (triggerRecord.runtime_code_changed === true) {
            return true;
        }
    }

    const scopeCategory = typeof preflight.scope_category === 'string'
        ? preflight.scope_category.trim().toLowerCase()
        : '';
    if (scopeCategory === 'code' || scopeCategory === 'mixed') {
        return true;
    }
    if (scopeCategory === 'docs-only'
        || scopeCategory === 'config-only'
        || scopeCategory === 'audit-only'
        || scopeCategory === 'empty') {
        return false;
    }

    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files
            .map((value) => normalizePath(String(value || '')).replace(/^[A-Za-z]:/i, ''))
            .filter((value) => value.length > 0)
        : [];
    if (changedFiles.length > 0) {
        const fallbackScope = classifyLegacyScope
            ? classifyLegacyScope(changedFiles, repoRoot)
            : classifyLegacyScopeWithoutGates(changedFiles, repoRoot);
        if (fallbackScope === 'docs-only'
            || fallbackScope === 'config-only'
            || fallbackScope === 'audit-only'
            || fallbackScope === 'empty') {
            return false;
        }
        if (fallbackScope === 'code' || fallbackScope === 'mixed') {
            return true;
        }
    }

    const changedLinesTotal = metrics?.changed_lines_total;
    if (typeof changedLinesTotal === 'number' && changedLinesTotal > 0) {
        return true;
    }
    return changedFiles.length > 0;
}
