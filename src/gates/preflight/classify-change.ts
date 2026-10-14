import { buildReviewExecutionPolicySummaryLine } from '../../core/review-execution-policy';
import { matchAnyRegex } from '../../gate-runtime/text-utils';
import {
    buildGeneratedRuntimeArtifactHygieneWarnings,
    splitGeneratedRuntimeControlPlaneArtifacts
} from '../shared/generated-runtime-artifacts';
import type {
    BudgetForecast,
    DepthEscalationRecord,
    RiskAwareDepthResult
} from '../../gate-runtime/budget-preflight';
import type { ReviewCapabilities } from '../../core/review-capabilities';
import type { TaskProfilePolicySnapshotSummary } from '../../policy/task-profile-policy-snapshot';
import type { EffectiveReviewSnapshot } from '../../policy/effective-review-snapshot';
import { testPathPrefix } from '../shared/helpers';
import {
    type ClassifyChangeOptions,
    matchesConfiguredRoot
} from './classify-change-config';
import {
    collectDatabaseProjectEvidence,
    isAmbientDatabaseSignal,
    isConfiguredWeakDatabaseSignal,
    isStrongDatabaseChangedScope
} from './classify-change-db-evidence';
import {
    getSafeOrdinaryDocPathMatches,
    isOrdinaryOrchestratorCacheMaintenancePath,
    isProtectedControlPlaneDocumentationSurfacePath
} from './classify-change-doc-safety';
import {
    buildRefactorHeuristicReasons,
    isPerformanceHeuristicTriggered
} from './classify-change-heuristics';
import {
    hasApiReviewIntent,
    hasPerformanceReviewIntent,
    hasRefactorIntent,
    classifySecurityReviewIntent,
    type SecurityReviewIntentReason
} from './classify-change-intent';
import { detectPathTriggers } from './classify-change-path-detection';
import { buildRequiredReviews } from './classify-change-required-reviews';
import { classifyScopeCategory, type ScopeCategory } from './classify-change-scope-category';
import { analyzeUiI18nCompanionScope } from './classify-change-i18n-companion';
import type { TaskRequiredReviewDeclaration } from './classify-change-task-required-reviews';

export type {
    ClassificationConfig,
    ClassifyChangeOptions,
    ResolvedClassificationConfig
} from './classify-change-config';
export {
    getClassificationConfig,
    getDefaultClassificationConfig,
    getReviewCapabilities,
    matchesConfiguredRoot
} from './classify-change-config';
export {
    isConfigLikePath,
    isDocumentationLikePath,
    isRuntimeCodeLikePath,
    isSafeOrdinaryDocumentationPath
} from './classify-change-doc-safety';
export type { ScopeCategory } from './classify-change-scope-category';
export { classifyScopeCategory } from './classify-change-scope-category';

/**
 * Pure-logic classification of changed files.
 * Produces the canonical classify-change output shape.
 */
export interface ClassifyChangeMetrics {
    classification_config_source: string;
    classification_config_path: string;
    changed_files_count: number;
    ignored_generated_runtime_files_count: number;
    changed_lines_total: number;
    additions_total: number;
    deletions_total: number;
    rename_count: number;
    code_like_changed_count: number;
    runtime_code_like_changed_count: number;
    review_capabilities: Partial<ReviewCapabilities>;
    fast_path_max_files: number;
    fast_path_max_changed_lines: number;
    performance_heuristic_min_lines: number;
    review_trigger_effective_changed_files_count?: number;
    review_trigger_effective_changed_lines_total?: number | null;
    review_trigger_suppressed_files_count?: number;
    companion_scope_kind?: string;
    companion_scope_effective_changed_files_count?: number;
    companion_scope_effective_changed_lines_total?: number | null;
    companion_scope_exempted_files_count?: number;
    changed_files_sha256?: string | null;
    scope_content_sha256?: string | null;
    scope_sha256?: string | null;
    domain_scope_fingerprints?: unknown;
}

export interface ClassifyChangeTriggers {
    runtime_changed: boolean;
    runtime_code_changed: boolean;
    protected_control_plane_changed: boolean;
    protected_control_plane_docs_only: boolean;
    changed_protected_files: string[];
    db: boolean;
    db_strong_changed_files: string[];
    db_weak_signal_files: string[];
    db_ambient_signal_files: string[];
    db_project_evidence: string[];
    db_downgrade_reason: string | null;
    security: boolean;
    api: boolean;
    api_intent: boolean;
    api_path_changed_files: string[];
    api_test_only_suppressed_files: string[];
    test: boolean;
    performance: boolean;
    performance_intent: boolean;
    infra: boolean;
    dependency: boolean;
    security_intent: boolean;
    security_intent_reasons: SecurityReviewIntentReason[];
    refactor: boolean;
    refactor_path: boolean;
    refactor_path_changed_files: string[];
    refactor_intent: boolean;
    refactor_heuristic: boolean;
    refactor_heuristic_reasons: string[];
    ordinary_doc_path_matches: unknown[];
    ordinary_doc_path_matched_files: string[];
    ordinary_doc_path_patterns: string[];
    test_ordinary_doc_suppressed_files: string[];
    performance_path_changed_files: string[];
    performance_test_only_suppressed_files: string[];
    performance_test_only_suppressed_heuristic: boolean;
    performance_cache_candidate_files: string[];
    performance_cache_intent: boolean;
    performance_cache_suppressed_files: string[];
    performance_heuristic: boolean;
    fast_path_eligible: boolean;
    fast_path_sensitive_match: boolean;
    ui_i18n_companion_scope: boolean;
    ui_i18n_companion_reason: string;
    ui_i18n_companion_files: string[];
    ui_i18n_companion_driver_files: string[];
    ui_i18n_review_trigger_suppressed: boolean;
    ui_i18n_review_trigger_files: string[];
    ui_i18n_review_trigger_suppressed_files: string[];
    ignored_generated_runtime_files: string[];
    protected_control_plane_snapshot_sha256?: string;
    protected_control_plane_manifest_status?: string;
    protected_control_plane_manifest_path?: string | null;
    protected_control_plane_manifest_changed_files?: string[];
    protected_control_plane_manifest_assessment?: string | null;
    isolation_mode_enabled?: boolean;
    isolation_mode_enforcement?: string;
    isolation_mode_use_sandbox?: boolean;
    isolation_sandbox_active?: boolean;
    isolation_sandbox_resolved_root?: string;
    isolation_sandbox_reason?: string;
    isolation_mode_pre_task_warning?: string;
    changed_workflow_config_files?: string[];
    workflow_config_file_hashes?: Record<string, string | null>;
    workflow_config_audit_provenance?: unknown;
    workflow_config_workspace_scan_error?: string;
    dirty_workspace_baseline_changed_files?: string[];
    dirty_workspace_baseline_changed_files_sha256?: string | null;
    dirty_workspace_task_owned_files?: string[];
    dirty_workspace_task_owned_files_sha256?: string | null;
    dirty_workspace_untouched_baseline_files?: string[];
    dirty_workspace_staged_baseline_trust_status?: string;
    dirty_workspace_staged_baseline_trust_violations?: string[];
    dirty_workspace_staged_baseline_trust_input_sha256?: string | null;
    dirty_workspace_protected_files?: string[];
    dirty_workspace_protected_files_sha256?: string | null;
    dirty_workspace_protected_file_hashes?: Record<string, string | null>;
    dirty_workspace_protection_status?: string;
    dirty_workspace_protection_assessment?: string;
    dirty_workspace_protection_changed_files?: string[];
    protected_control_plane_manifest_baseline_allowance_status?: string;
}

export interface ClassifyChangeResult {
    detection_source: string;
    review_coverage_contract_required: true;
    mode: string;
    scope_category: ScopeCategory;
    scope_category_reasons: string[];
    metrics: ClassifyChangeMetrics;
    triggers: ClassifyChangeTriggers;
    required_reviews: Record<string, boolean>;
    review_execution_policy?: {
        mode: string;
        visible_summary_line: string;
        dependency_graph?: EffectiveReviewSnapshot['review_dependency_graph'];
    };
    zero_diff_guard: {
        zero_diff_detected: boolean;
        status: 'BASELINE_ONLY' | 'DIFF_PRESENT';
        completion_requires_audited_no_op: boolean;
        no_op_artifact_suffix: string | null;
        rationale: string;
    };
    workspace_hygiene_warnings: string[];
    changed_files: string[];
    git_change_classification?: unknown;
    task_id?: string;
    isolation_mode_violation?: string;
    profile_selection?: unknown;
    profile_guardrails?: unknown;
    profile_policy_snapshot?: TaskProfilePolicySnapshotSummary;
    effective_review_snapshot?: EffectiveReviewSnapshot;
    budget_forecast?: BudgetForecast;
    depth_escalation?: DepthEscalationRecord;
    risk_aware_depth?: RiskAwareDepthResult;
    optional_skill_selection?: Record<string, unknown>;
    task_required_review_declaration?: TaskRequiredReviewDeclaration;
    split_checkpoint_scope?: {
        task_id: string;
        parent_task_id: string;
        base_commit: string;
        checkpoint_commit: string;
        changed_files: string[];
        detection_source: string;
    };
}

export function classifyChange(options: ClassifyChangeOptions): ClassifyChangeResult {
    const normalizedInputFiles = options.normalizedFiles || [];
    const generatedRuntimeSplit = splitGeneratedRuntimeControlPlaneArtifacts(normalizedInputFiles, {
        isSourceCheckout: options.isSourceCheckout === true
    });
    const normalizedFiles = generatedRuntimeSplit.reviewableFiles;
    const ignoredGeneratedRuntimeFiles = generatedRuntimeSplit.ignoredGeneratedRuntimeFiles;
    const taskIntent = options.taskIntent || '';
    const fastPathMaxFiles = options.fastPathMaxFiles || 2;
    const fastPathMaxChangedLines = options.fastPathMaxChangedLines || 40;
    const performanceHeuristicMinLines = options.performanceHeuristicMinLines || 120;
    const changedLinesTotal = options.changedLinesTotal || 0;
    const additionsTotal = options.additionsTotal || 0;
    const deletionsTotal = options.deletionsTotal || 0;
    const renameCount = options.renameCount || 0;
    const detectionSource = options.detectionSource || 'explicit_changed_files';
    const classificationConfig = options.classificationConfig;
    const reviewCapabilities = options.reviewCapabilities || {};
    const reviewExecutionPolicyMode = options.reviewExecutionPolicyMode;

    const runtimeRoots = classificationConfig.runtime_roots;
    const codeLike = classificationConfig.code_like_regexes;

    const testMatch = (p: string, regexes: string[]) => matchAnyRegex(p, regexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });

    const detectedUiI18nScope = analyzeUiI18nCompanionScope({
        normalizedFiles,
        classificationConfig,
        changedFileStats: options.changedFileStats,
        maxDriverFiles: fastPathMaxFiles,
        maxDriverChangedLines: fastPathMaxChangedLines
    });
    const uiI18nCompanionScope = normalizedFiles.some(file => options.declaredTestPaths?.includes(file))
        ? { ...detectedUiI18nScope, eligible: false, reviewTriggerSuppressionEligible: false,
            reason: 'explicit_test_scope' }
        : detectedUiI18nScope;
    const reviewTriggerFiles = uiI18nCompanionScope.reviewTriggerSuppressionEligible
        ? uiI18nCompanionScope.reviewTriggerFiles
        : normalizedFiles;
    const pathTriggers = detectPathTriggers({
        normalizedFiles: reviewTriggerFiles,
        repoRoot: options.repoRoot,
        taskIntent,
        classificationConfig,
        callbacks: {
            testMatch,
            testPathPrefix,
            matchesConfiguredRoot,
            isProtectedControlPlaneDocumentationSurfacePath,
            isStrongDatabaseChangedScope,
            isConfiguredWeakDatabaseSignal,
            isAmbientDatabaseSignal,
            collectDatabaseProjectEvidence,
            getSafeOrdinaryDocPathMatches,
            isOrdinaryOrchestratorCacheMaintenancePath
        }
    });
    const companionEffectiveChangedFilesCount = uiI18nCompanionScope.reviewTriggerSuppressionEligible
        ? uiI18nCompanionScope.effectiveChangedFilesCount
        : normalizedFiles.length;
    const companionEffectiveChangedLinesTotal = uiI18nCompanionScope.reviewTriggerSuppressionEligible && uiI18nCompanionScope.effectiveChangedLinesTotal !== null
        ? uiI18nCompanionScope.effectiveChangedLinesTotal
        : changedLinesTotal;

    const scopeCategoryOptions = {
        declaredTestPaths: options.declaredTestPaths,
        ordinaryDocPaths: classificationConfig.ordinary_doc_paths,
        protectedControlPlaneRoots: classificationConfig.protected_control_plane_roots,
        testTriggerRegexes: classificationConfig.test_trigger_regexes,
        sqlOrMigrationRegexes: classificationConfig.sql_or_migration_regexes,
        dbTriggerRegexes: classificationConfig.db_trigger_regexes,
        securityTriggerRegexes: classificationConfig.security_trigger_regexes,
        apiTriggerRegexes: classificationConfig.api_trigger_regexes,
        dependencyTriggerRegexes: classificationConfig.dependency_trigger_regexes
    };
    const rawScopeClassification = classifyScopeCategory(normalizedFiles, codeLike, runtimeRoots, scopeCategoryOptions);
    const testTriggered = pathTriggers.testTriggered || reviewTriggerFiles.some((file) => (
        options.declaredTestPaths?.includes(file)
        && classifyScopeCategory([file], codeLike, runtimeRoots, scopeCategoryOptions).category === 'test-only'
    ));
    const reviewableCodeChanged = reviewTriggerFiles.some((file) => (
        classifyScopeCategory([file], codeLike, runtimeRoots, scopeCategoryOptions).category === 'code'
    ));
    const scopeClassification = uiI18nCompanionScope.eligible
        ? {
            category: 'code' as ScopeCategory,
            reasons: [
                `ui_i18n_driver_files=${uiI18nCompanionScope.driverFiles.length}`,
                `ui_i18n_companion_files=${uiI18nCompanionScope.i18nFiles.length}`
            ]
        }
        : rawScopeClassification;
    const testOnlyDomainReviewSuppressed = scopeClassification.category === 'test-only';
    const runtimeIntentReviewEligible = (pathTriggers.runtimeCodeChanged || reviewableCodeChanged) && !testOnlyDomainReviewSuppressed;

    const securityIntentClassification = runtimeIntentReviewEligible
        ? classifySecurityReviewIntent(taskIntent)
        : { triggered: false, reasons: [] };
    const securityIntentTriggered = securityIntentClassification.triggered;
    const apiIntentTriggered = runtimeIntentReviewEligible && hasApiReviewIntent(taskIntent);
    const performanceIntentTriggered = runtimeIntentReviewEligible && hasPerformanceReviewIntent(taskIntent);
    const securityTriggered = pathTriggers.securityTriggered || securityIntentTriggered;
    const refactorIntentReviewEligible = runtimeIntentReviewEligible || testOnlyDomainReviewSuppressed;
    const refactorIntentTriggered = refactorIntentReviewEligible && hasRefactorIntent(taskIntent);
    const refactorPathTriggeredFiles = testOnlyDomainReviewSuppressed
        ? []
        : pathTriggers.refactorPathTriggeredFiles;
    const refactorPathTriggered = refactorPathTriggeredFiles.length > 0;
    const refactorHeuristicReasons = buildRefactorHeuristicReasons({
        runtimeChanged: pathTriggers.runtimeChanged,
        normalizedFilesCount: normalizedFiles.length,
        renameCount,
        additionsTotal,
        deletionsTotal,
        runtimeCodeLikeCount: pathTriggers.runtimeCodeLikeCount,
        dbTriggered: pathTriggers.dbTriggered,
        securityTriggered
    });
    const refactorHeuristicTriggered = refactorHeuristicReasons.length > 0;
    const refactorTriggered = refactorPathTriggered || refactorIntentTriggered || refactorHeuristicTriggered;

    const performanceHeuristicTriggered = isPerformanceHeuristicTriggered({
        performancePathTriggered: pathTriggers.performancePathTriggered,
        apiTriggered: pathTriggers.apiTriggered,
        dbTriggered: pathTriggers.dbTriggered,
        runtimeCodeChanged: pathTriggers.runtimeCodeChanged,
        onlySqlOrMigration: pathTriggers.onlySqlOrMigration,
        changedLinesTotal: companionEffectiveChangedLinesTotal,
        performanceHeuristicMinLines
    });
    const rawPerformanceTriggered = pathTriggers.performancePathTriggered || performanceHeuristicTriggered || performanceIntentTriggered;
    const apiTriggered = (pathTriggers.apiTriggered || apiIntentTriggered) && !testOnlyDomainReviewSuppressed;
    const performanceTriggered = rawPerformanceTriggered && !testOnlyDomainReviewSuppressed;

    const fastPathEligible = (
        pathTriggers.runtimeChanged
        && (pathTriggers.allUnderFastRoots || uiI18nCompanionScope.eligible)
        && (pathTriggers.allFastAllowedTypes || uiI18nCompanionScope.eligible)
        && !pathTriggers.hasFastSensitiveMatch
        && companionEffectiveChangedFilesCount <= fastPathMaxFiles
        && companionEffectiveChangedLinesTotal <= fastPathMaxChangedLines
    );

    let mode = 'FULL_PATH';
    if (fastPathEligible && !pathTriggers.dbTriggered && !securityTriggered && !refactorTriggered
        && !apiTriggered && !pathTriggers.dependencyTriggered && !pathTriggers.infraTriggered && !performanceTriggered) {
        mode = 'FAST_PATH';
    }

    const requiredReviews = buildRequiredReviews({
        runtimeCodeChanged: pathTriggers.runtimeCodeChanged || reviewableCodeChanged,
        mode,
        dbTriggered: pathTriggers.dbTriggered,
        securityTriggered,
        refactorTriggered,
        apiTriggered,
        testTriggered,
        performanceTriggered,
        infraTriggered: pathTriggers.infraTriggered,
        dependencyTriggered: pathTriggers.dependencyTriggered,
        reviewCapabilities
    });
    const zeroDiffDetected = normalizedFiles.length === 0 && changedLinesTotal === 0;

    return {
        detection_source: detectionSource,
        review_coverage_contract_required: true,
        mode,
        scope_category: scopeClassification.category,
        scope_category_reasons: scopeClassification.reasons,
        metrics: {
            classification_config_source: classificationConfig.source,
            classification_config_path: classificationConfig.config_path,
            changed_files_count: normalizedFiles.length,
            ignored_generated_runtime_files_count: ignoredGeneratedRuntimeFiles.length,
            changed_lines_total: changedLinesTotal,
            additions_total: additionsTotal,
            deletions_total: deletionsTotal,
            rename_count: renameCount,
            code_like_changed_count: pathTriggers.codeLikeCount,
            runtime_code_like_changed_count: pathTriggers.runtimeCodeLikeCount,
            review_capabilities: reviewCapabilities,
            fast_path_max_files: fastPathMaxFiles,
            fast_path_max_changed_lines: fastPathMaxChangedLines,
            performance_heuristic_min_lines: performanceHeuristicMinLines,
            ...(uiI18nCompanionScope.reviewTriggerSuppressionEligible
                ? {
                    review_trigger_effective_changed_files_count: uiI18nCompanionScope.effectiveChangedFilesCount,
                    review_trigger_effective_changed_lines_total: uiI18nCompanionScope.effectiveChangedLinesTotal,
                    review_trigger_suppressed_files_count: uiI18nCompanionScope.i18nFiles.length,
                    companion_scope_kind: 'ui-i18n',
                    companion_scope_effective_changed_files_count: uiI18nCompanionScope.effectiveChangedFilesCount,
                    companion_scope_effective_changed_lines_total: uiI18nCompanionScope.effectiveChangedLinesTotal,
                    companion_scope_exempted_files_count: uiI18nCompanionScope.i18nFiles.length
                }
                : {})
        },
        triggers: {
            runtime_changed: pathTriggers.runtimeChanged,
            runtime_code_changed: pathTriggers.runtimeCodeChanged,
            protected_control_plane_changed: pathTriggers.protectedControlPlaneChanged,
            protected_control_plane_docs_only: pathTriggers.protectedControlPlaneDocsOnly,
            changed_protected_files: pathTriggers.protectedControlPlaneFiles,
            db: pathTriggers.dbTriggered,
            db_strong_changed_files: pathTriggers.dbStrongChangedFiles,
            db_weak_signal_files: pathTriggers.dbWeakSignalFiles,
            db_ambient_signal_files: pathTriggers.dbAmbientSignalFiles,
            db_project_evidence: pathTriggers.dbProjectEvidence,
            db_downgrade_reason: pathTriggers.dbDowngradeReason,
            security: securityTriggered,
            api: apiTriggered,
            api_intent: apiIntentTriggered,
            api_path_changed_files: pathTriggers.apiTriggeredFiles,
            api_test_only_suppressed_files: testOnlyDomainReviewSuppressed ? pathTriggers.apiTriggeredFiles : [],
            test: testTriggered,
            performance: performanceTriggered,
            performance_intent: performanceIntentTriggered,
            infra: pathTriggers.infraTriggered,
            dependency: pathTriggers.dependencyTriggered,
            security_intent: securityIntentTriggered,
            security_intent_reasons: securityIntentClassification.reasons,
            refactor: refactorTriggered,
            refactor_path: refactorPathTriggered,
            refactor_path_changed_files: refactorPathTriggeredFiles,
            refactor_intent: refactorIntentTriggered,
            refactor_heuristic: refactorHeuristicTriggered,
            refactor_heuristic_reasons: refactorHeuristicReasons,
            ordinary_doc_path_matches: pathTriggers.ordinaryDocPathMatches,
            ordinary_doc_path_matched_files: pathTriggers.ordinaryDocPathMatchedFiles,
            ordinary_doc_path_patterns: classificationConfig.ordinary_doc_paths,
            test_ordinary_doc_suppressed_files: pathTriggers.testOrdinaryDocSuppressedFiles,
            performance_path_changed_files: pathTriggers.performancePathTriggeredFiles,
            performance_test_only_suppressed_files: testOnlyDomainReviewSuppressed ? pathTriggers.performancePathTriggeredFiles : [],
            performance_test_only_suppressed_heuristic: testOnlyDomainReviewSuppressed && performanceHeuristicTriggered,
            performance_cache_candidate_files: pathTriggers.ordinaryCacheMaintenanceFiles,
            performance_cache_intent: pathTriggers.performanceCacheIntent,
            performance_cache_suppressed_files: pathTriggers.performanceCacheSuppressedFiles,
            performance_heuristic: performanceHeuristicTriggered,
            fast_path_eligible: fastPathEligible,
            fast_path_sensitive_match: pathTriggers.hasFastSensitiveMatch,
            ui_i18n_companion_scope: uiI18nCompanionScope.eligible,
            ui_i18n_companion_reason: uiI18nCompanionScope.reason,
            ui_i18n_companion_files: uiI18nCompanionScope.i18nFiles,
            ui_i18n_companion_driver_files: uiI18nCompanionScope.driverFiles,
            ui_i18n_review_trigger_suppressed: uiI18nCompanionScope.reviewTriggerSuppressionEligible,
            ui_i18n_review_trigger_files: reviewTriggerFiles,
            ui_i18n_review_trigger_suppressed_files: uiI18nCompanionScope.reviewTriggerSuppressionEligible
                ? uiI18nCompanionScope.i18nFiles
                : [],
            ignored_generated_runtime_files: ignoredGeneratedRuntimeFiles
        },
        required_reviews: requiredReviews,
        review_execution_policy: reviewExecutionPolicyMode
            ? {
                mode: reviewExecutionPolicyMode,
                visible_summary_line: buildReviewExecutionPolicySummaryLine(reviewExecutionPolicyMode)
            }
            : undefined,
        zero_diff_guard: {
            zero_diff_detected: zeroDiffDetected,
            status: zeroDiffDetected ? 'BASELINE_ONLY' : 'DIFF_PRESENT',
            completion_requires_audited_no_op: zeroDiffDetected,
            no_op_artifact_suffix: zeroDiffDetected ? '-no-op.json' : null,
            rationale: zeroDiffDetected
                ? 'Preflight on a clean workspace is baseline-only. Task completion requires a produced diff or an audited no-op artifact.'
                : 'Workspace diff detected.'
        },
        workspace_hygiene_warnings: buildGeneratedRuntimeArtifactHygieneWarnings(ignoredGeneratedRuntimeFiles),
        changed_files: normalizedFiles
    };
}
