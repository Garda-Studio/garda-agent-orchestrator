import { matchAnyRegex } from '../../gate-runtime/text-utils';
import { testPathPrefix } from '../shared/helpers';
import {
    isAuditOnlyPath,
    isConfigLikePath,
    isProtectedControlPlaneDocumentationSurfacePath,
    isRuntimeCodeLikePath,
    isSafeOrdinaryDocumentationPath,
    isSecuritySensitiveDocumentationScopePath
} from './classify-change-doc-safety';

export type ScopeCategory = 'code' | 'docs-only' | 'test-only' | 'config-only' | 'audit-only' | 'mixed' | 'empty';

interface ScopeCategoryOptions {
    declaredTestPaths?: readonly string[];
    ordinaryDocPaths?: string[];
    protectedControlPlaneRoots?: string[];
    testTriggerRegexes?: string[];
    sqlOrMigrationRegexes?: string[];
    dbTriggerRegexes?: string[];
    securityTriggerRegexes?: string[];
    apiTriggerRegexes?: string[];
    dependencyTriggerRegexes?: string[];
}

/**
 * Classify the scope category from changed files.
 *
 * Categories:
 * - `code`: at least one code-like file under runtime roots
 * - `docs-only`: all files match documentation patterns
 * - `test-only`: test-scope files, optionally accompanied by safe ordinary documentation
 * - `config-only`: all files match config/infra patterns (no code)
 * - `audit-only`: all files are orchestrator control-plane artifacts
 * - `mixed`: files from more than one category
 * - `empty`: no changed files
 */
export function classifyScopeCategory(
    normalizedFiles: string[],
    codeLikeRegexes: string[],
    runtimeRoots: string[],
    options: ScopeCategoryOptions = {}
): { category: ScopeCategory; reasons: string[] } {
    if (normalizedFiles.length === 0) {
        return { category: 'empty', reasons: ['no_changed_files'] };
    }

    let codeCount = 0;
    let docCount = 0;
    let ordinaryDocCount = 0;
    let testCount = 0;
    let configCount = 0;
    let auditCount = 0;

    for (const file of normalizedFiles) {
        const isCode = isRuntimeCodeLikePath(file, codeLikeRegexes, runtimeRoots);
        const isDeclaredTest = options.declaredTestPaths?.includes(file);
        const isTest = isDeclaredTest || matchAnyRegex(file, options.testTriggerRegexes || [], {
            skipInvalidRegex: true,
            caseInsensitive: true
        });
        const isConfig = isConfigLikePath(file);
        const isAudit = isAuditOnlyPath(file);
        const isProtectedControlPlane = testPathPrefix(file, options.protectedControlPlaneRoots || []);
        if (isCode && isProtectedControlPlane) {
            codeCount++;
            continue;
        }
        if (isProtectedControlPlane && isProtectedControlPlaneDocumentationSurfacePath(file, {
            code_like_regexes: codeLikeRegexes,
            runtime_roots: runtimeRoots,
            protected_control_plane_roots: options.protectedControlPlaneRoots || [],
            ordinary_doc_paths: options.ordinaryDocPaths || [],
            sql_or_migration_regexes: options.sqlOrMigrationRegexes || [],
            db_trigger_regexes: options.dbTriggerRegexes || [],
            security_trigger_regexes: options.securityTriggerRegexes || [],
            api_trigger_regexes: options.apiTriggerRegexes || [],
            dependency_trigger_regexes: options.dependencyTriggerRegexes || []
        })) {
            docCount++;
            continue;
        }
        if (isAudit || isProtectedControlPlane) {
            auditCount++;
            continue;
        }
        if (isDeclaredTest) {
            testCount++;
            continue;
        }
        if (isConfig) {
            configCount++;
            continue;
        }
        if (isSafeOrdinaryDocumentationPath(file, {
            code_like_regexes: codeLikeRegexes,
            runtime_roots: runtimeRoots,
            protected_control_plane_roots: options.protectedControlPlaneRoots || [],
            ordinary_doc_paths: options.ordinaryDocPaths || [],
            sql_or_migration_regexes: options.sqlOrMigrationRegexes || [],
            db_trigger_regexes: options.dbTriggerRegexes || [],
            security_trigger_regexes: options.securityTriggerRegexes || [],
            api_trigger_regexes: options.apiTriggerRegexes || [],
            dependency_trigger_regexes: options.dependencyTriggerRegexes || []
        })) {
            docCount++;
            ordinaryDocCount++;
            continue;
        }
        if (isSecuritySensitiveDocumentationScopePath(file, {
            code_like_regexes: codeLikeRegexes,
            runtime_roots: runtimeRoots,
            protected_control_plane_roots: options.protectedControlPlaneRoots || [],
            ordinary_doc_paths: options.ordinaryDocPaths || [],
            security_trigger_regexes: options.securityTriggerRegexes || []
        })) {
            docCount++;
            continue;
        }
        if (isTest) {
            testCount++;
            continue;
        }
        if (isCode) {
            codeCount++;
            continue;
        }
        codeCount++; // unknown files default to code for safety
    }

    const total = normalizedFiles.length;
    const reasons: string[] = [];

    if (codeCount > 0) {
        if (docCount > 0 || testCount > 0 || configCount > 0 || auditCount > 0) {
            reasons.push(`code=${codeCount}`, `docs=${docCount}`, `tests=${testCount}`, `config=${configCount}`, `audit=${auditCount}`);
            return { category: 'mixed', reasons };
        }
        reasons.push(`code_files=${codeCount}`);
        return { category: 'code', reasons };
    }

    if (auditCount === total) {
        reasons.push(`audit_only_files=${auditCount}`);
        return { category: 'audit-only', reasons };
    }

    if (docCount === total) {
        reasons.push(`doc_only_files=${docCount}`);
        return { category: 'docs-only', reasons };
    }

    if (testCount > 0 && testCount + ordinaryDocCount === total) {
        reasons.push(`test_only_files=${testCount}`);
        if (ordinaryDocCount > 0) reasons.push(`ordinary_doc_files=${ordinaryDocCount}`);
        return { category: 'test-only', reasons };
    }

    if (configCount === total) {
        reasons.push(`config_only_files=${configCount}`);
        return { category: 'config-only', reasons };
    }

    // Mix of non-code categories (e.g., docs + config)
    if (docCount > 0) reasons.push(`docs=${docCount}`);
    if (testCount > 0) reasons.push(`tests=${testCount}`);
    if (configCount > 0) reasons.push(`config=${configCount}`);
    if (auditCount > 0) reasons.push(`audit=${auditCount}`);
    return { category: 'mixed', reasons: [...reasons, 'mixed_non_code'] };
}
