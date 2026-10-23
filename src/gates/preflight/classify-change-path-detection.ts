import type { OrdinaryDocPathMatch } from '../../core/ordinary-doc-paths';
import type { ResolvedClassificationConfig } from './classify-change-config';
import { hasPerformanceSensitiveCacheIntent } from './classify-change-intent';
import { matchesTriggerNameTokens } from './trigger-name-tokens';

interface MatchConfiguredRootOptions {
    allowNestedRoot?: boolean;
    semanticPackageMatch?: boolean;
}

export interface PathDetectionCallbacks {
    testMatch(pathValue: string, regexes: string[]): boolean;
    testPathPrefix(pathValue: string, prefixes: string[]): boolean;
    matchesConfiguredRoot(pathValue: string, roots: string[], options?: MatchConfiguredRootOptions): boolean;
    isProtectedControlPlaneDocumentationSurfacePath(pathValue: string, config: ResolvedClassificationConfig): boolean;
    isStrongDatabaseChangedScope(pathValue: string, sqlOrMigrationRegexes: string[], dbTriggerRegexes: string[]): boolean;
    isConfiguredWeakDatabaseSignal(pathValue: string, dbTriggerRegexes: string[]): boolean;
    isAmbientDatabaseSignal(pathValue: string, dbTriggerRegexes: string[]): boolean;
    collectDatabaseProjectEvidence(repoRoot: string | undefined, normalizedFiles: string[]): string[];
    getSafeOrdinaryDocPathMatches(normalizedFiles: string[], config: ResolvedClassificationConfig): OrdinaryDocPathMatch[];
    isOrdinaryOrchestratorCacheMaintenancePath(pathValue: string): boolean;
}

export interface PathDetectionInput {
    normalizedFiles: string[];
    repoRoot?: string;
    taskIntent: string;
    classificationConfig: ResolvedClassificationConfig;
    callbacks: PathDetectionCallbacks;
}

export interface PathDetectionResult {
    runtimeChanged: boolean;
    runtimeCodeChanged: boolean;
    protectedControlPlaneFiles: string[];
    protectedControlPlaneChanged: boolean;
    protectedControlPlaneDocsOnly: boolean;
    dbStrongChangedFiles: string[];
    dbWeakSignalFiles: string[];
    dbAmbientSignalFiles: string[];
    dbProjectEvidence: string[];
    dbDowngradeReason: string | null;
    dbTriggered: boolean;
    securityTriggered: boolean;
    apiTriggeredFiles: string[];
    apiTriggered: boolean;
    dependencyTriggered: boolean;
    infraTriggered: boolean;
    refactorPathTriggeredFiles: string[];
    ordinaryDocPathMatches: OrdinaryDocPathMatch[];
    ordinaryDocPathMatchedFiles: string[];
    safeOrdinaryDocFiles: string[];
    testOrdinaryDocSuppressedFiles: string[];
    testTriggered: boolean;
    performancePathTriggeredFiles: string[];
    ordinaryCacheMaintenanceFiles: string[];
    performanceCacheIntent: boolean;
    performanceCacheSuppressedFiles: string[];
    performancePathTriggered: boolean;
    sqlOrMigrationCount: number;
    onlySqlOrMigration: boolean;
    codeLikeCount: number;
    runtimeCodeLikeCount: number;
    allUnderFastRoots: boolean;
    allFastAllowedTypes: boolean;
    hasFastSensitiveMatch: boolean;
}

export function detectPathTriggers(input: PathDetectionInput): PathDetectionResult {
    const { normalizedFiles, classificationConfig, callbacks } = input;
    const runtimeRoots = classificationConfig.runtime_roots;
    const fastPathRoots = classificationConfig.fast_path_roots;
    const fastPathAllowed = classificationConfig.fast_path_allowed_regexes;
    const fastPathSensitive = classificationConfig.fast_path_sensitive_regexes;
    const sqlOrMigration = classificationConfig.sql_or_migration_regexes;
    const codeLike = classificationConfig.code_like_regexes;

    const runtimeChanged = normalizedFiles.some((p: string) => callbacks.matchesConfiguredRoot(p, runtimeRoots, {
        allowNestedRoot: true
    }));
    const runtimeCodeChanged = normalizedFiles.some((p: string) => callbacks.matchesConfiguredRoot(p, runtimeRoots, {
        allowNestedRoot: true
    }) && callbacks.testMatch(p, codeLike) && !callbacks.testMatch(p, classificationConfig.test_trigger_regexes));

    const protectedControlPlaneFiles = normalizedFiles.filter((p: string) => callbacks.testPathPrefix(p, classificationConfig.protected_control_plane_roots));
    const protectedControlPlaneChanged = protectedControlPlaneFiles.length > 0;
    const protectedControlPlaneDocsOnly = normalizedFiles.length > 0
        && protectedControlPlaneFiles.length === normalizedFiles.length
        && protectedControlPlaneFiles.every((p: string) => callbacks.isProtectedControlPlaneDocumentationSurfacePath(p, classificationConfig));

    const dbStrongChangedFiles = normalizedFiles.filter((p: string) => (
        callbacks.isStrongDatabaseChangedScope(p, sqlOrMigration, classificationConfig.db_trigger_regexes)
    ));
    // Name words apply to code files only, so documentation such as payment-flow.md keeps its own routing.
    const nameTokenCodeFile = (p: string) => callbacks.testMatch(p, codeLike) && !callbacks.testMatch(p, classificationConfig.test_trigger_regexes);
    const dbWeakSignalFiles = normalizedFiles.filter((p: string) => (
        dbStrongChangedFiles.indexOf(p) === -1
        && (callbacks.isConfiguredWeakDatabaseSignal(p, classificationConfig.db_trigger_regexes)
            || (nameTokenCodeFile(p) && matchesTriggerNameTokens(p, classificationConfig.db_trigger_name_tokens)))
    ));
    const dbAmbientSignalFiles = normalizedFiles.filter((p: string) => (
        dbStrongChangedFiles.indexOf(p) === -1
        && dbWeakSignalFiles.indexOf(p) === -1
        && callbacks.isAmbientDatabaseSignal(p, classificationConfig.db_trigger_regexes)
    ));
    const dbProjectEvidence = callbacks.collectDatabaseProjectEvidence(input.repoRoot, normalizedFiles);
    const dbTriggered = dbStrongChangedFiles.length > 0
        || (dbWeakSignalFiles.length > 0 && dbProjectEvidence.length > 0);
    const dbDowngradeReason = !dbTriggered && dbProjectEvidence.length > 0
        ? (
            dbAmbientSignalFiles.length > 0
                ? 'ambient_project_db_evidence_with_non_db_changed_scope'
                : 'project_db_evidence_without_db_changed_scope'
        )
        : null;
    const securityTriggered = normalizedFiles.some((p: string) => callbacks.testMatch(p, classificationConfig.security_trigger_regexes)
        || (nameTokenCodeFile(p) && matchesTriggerNameTokens(p, classificationConfig.security_trigger_name_tokens)));
    const apiTriggeredFiles = normalizedFiles.filter((p: string) => callbacks.testMatch(p, classificationConfig.api_trigger_regexes));
    const apiTriggered = apiTriggeredFiles.length > 0;
    const dependencyTriggered = normalizedFiles.some((p: string) => callbacks.testMatch(p, classificationConfig.dependency_trigger_regexes));
    const infraTriggered = normalizedFiles.some((p: string) => callbacks.testMatch(p, classificationConfig.infra_trigger_regexes));
    const refactorPathTriggeredFiles = normalizedFiles.filter((p: string) => (
        callbacks.testMatch(p, classificationConfig.refactor_trigger_regexes)
        && !callbacks.testMatch(p, classificationConfig.test_trigger_regexes)
    ));

    const ordinaryDocPathMatches = callbacks.getSafeOrdinaryDocPathMatches(normalizedFiles, classificationConfig);
    const ordinaryDocPathMatchedFiles = [...new Set(ordinaryDocPathMatches.map((entry) => entry.path))].sort();
    const safeOrdinaryDocFiles = ordinaryDocPathMatchedFiles;
    const testOrdinaryDocSuppressedFiles = safeOrdinaryDocFiles.filter((p: string) => callbacks.testMatch(p, classificationConfig.test_trigger_regexes));
    const testTriggered = normalizedFiles.some((p: string) => (
        callbacks.testMatch(p, classificationConfig.test_trigger_regexes)
        && !safeOrdinaryDocFiles.includes(p)
    ));

    const performancePathMatchedFiles = normalizedFiles.filter((p: string) => callbacks.testMatch(p, classificationConfig.performance_trigger_regexes));
    const ordinaryCacheMaintenanceFiles = performancePathMatchedFiles.filter(callbacks.isOrdinaryOrchestratorCacheMaintenancePath);
    const performanceCacheIntent = ordinaryCacheMaintenanceFiles.length > 0 && hasPerformanceSensitiveCacheIntent(input.taskIntent);
    const performancePathTriggeredFiles = performancePathMatchedFiles.filter((p: string) => (
        !callbacks.isOrdinaryOrchestratorCacheMaintenancePath(p) || performanceCacheIntent
    ));
    const performanceCacheSuppressedFiles = performanceCacheIntent
        ? []
        : ordinaryCacheMaintenanceFiles;
    const performancePathTriggered = performancePathTriggeredFiles.length > 0;

    const sqlOrMigrationCount = normalizedFiles.filter((p: string) => callbacks.testMatch(p, sqlOrMigration)).length;
    const onlySqlOrMigration = normalizedFiles.length > 0 && sqlOrMigrationCount === normalizedFiles.length;
    const codeLikeCount = normalizedFiles.filter((p: string) => callbacks.testMatch(p, codeLike)).length;
    const runtimeCodeLikeCount = normalizedFiles.filter(
        (p: string) => callbacks.matchesConfiguredRoot(p, runtimeRoots, { allowNestedRoot: true })
            && callbacks.testMatch(p, codeLike)
            && !callbacks.testMatch(p, classificationConfig.test_trigger_regexes)
    ).length;

    const allUnderFastRoots = normalizedFiles.length > 0 && normalizedFiles.every((p: string) => callbacks.matchesConfiguredRoot(p, fastPathRoots, {
        semanticPackageMatch: true
    }));
    const allFastAllowedTypes = normalizedFiles.length > 0 && normalizedFiles.every((p: string) => callbacks.testMatch(p, fastPathAllowed));
    const hasFastSensitiveMatch = normalizedFiles.some((p: string) => callbacks.testMatch(p, fastPathSensitive));

    return {
        runtimeChanged,
        runtimeCodeChanged,
        protectedControlPlaneFiles,
        protectedControlPlaneChanged,
        protectedControlPlaneDocsOnly,
        dbStrongChangedFiles,
        dbWeakSignalFiles,
        dbAmbientSignalFiles,
        dbProjectEvidence,
        dbDowngradeReason,
        dbTriggered,
        securityTriggered,
        apiTriggeredFiles,
        apiTriggered,
        dependencyTriggered,
        infraTriggered,
        refactorPathTriggeredFiles,
        ordinaryDocPathMatches,
        ordinaryDocPathMatchedFiles,
        safeOrdinaryDocFiles,
        testOrdinaryDocSuppressedFiles,
        testTriggered,
        performancePathTriggeredFiles,
        ordinaryCacheMaintenanceFiles,
        performanceCacheIntent,
        performanceCacheSuppressedFiles,
        performancePathTriggered,
        sqlOrMigrationCount,
        onlySqlOrMigration,
        codeLikeCount,
        runtimeCodeLikeCount,
        allUnderFastRoots,
        allFastAllowedTypes,
        hasFastSensitiveMatch
    };
}
