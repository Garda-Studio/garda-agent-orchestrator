import type { ReviewRemediationScopeBoundary } from '../../../../gates/review-remediation/review-remediation-scope-boundary';
export type { ReviewRemediationScopeBoundary } from '../../../../gates/review-remediation/review-remediation-scope-boundary';

export interface RestartCoherentCycleCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    taskModePath?: string;
    preflightPath?: string;
    preflightOutputPath?: string;
    changedFiles?: unknown;
    includeUntracked?: unknown;
    useStaged?: boolean;
    taskIntent?: unknown;
    commandsPath?: string;
    outputFiltersPath?: string;
    failTailLines?: unknown;
    emitMetrics?: unknown;
    operatorConfirmed?: unknown;
    operatorConfirmedAtUtc?: unknown;
}

export interface RestartReviewCycleCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    taskModePath?: string;
    preflightPath?: string;
    preflightOutputPath?: string;
    changedFiles?: unknown;
    includeUntracked?: unknown;
    useStaged?: boolean;
    taskIntent?: unknown;
    impactAnalysis?: unknown;
    impactAnalysisPath?: string;
    reviewType?: unknown;
    reviewEvidenceOnly?: unknown;
    commandsPath?: string;
    outputFiltersPath?: string;
    failTailLines?: unknown;
    emitMetrics?: unknown;
}

export interface ResolvedReplayScope {
    plannedChangedFiles: string[];
    changedFiles?: string[];
    useStaged?: boolean;
    includeUntracked?: boolean;
    detectionSource: string;
}

export interface ReviewRemediationImpactAnalysis {
    status: 'RECORDED';
    source: 'inline' | 'file';
    summary: string;
    required_topics: string[];
    affected_files: string[];
    ignored_remediation_targets?: Array<{
        path: string;
        sha256?: string | null;
        reason?: string | null;
        source?: string | null;
    }>;
}

export type ReviewRemediationSemanticCategory =
    | 'review_evidence_only'
    | 'test_coverage_only'
    | 'test_hook_isolation'
    | 'api_surface'
    | 'runtime_behavior'
    | 'security_sensitive'
    | 'refactor_structure'
    | 'unknown';

export type ReviewRemediationScopeCategory =
    | 'previous_scope_only'
    | 'test_only_expansion'
    | 'expanded_non_test_blocked';

export interface ReviewRemediationFixClassification {
    status: 'CLASSIFIED';
    category: ReviewRemediationSemanticCategory;
    scope_category: ReviewRemediationScopeCategory;
    rationale: string;
    reason: string;
    affected_file_groups: Record<string, string[]>;
    evidence: {
        scope_boundary_status: ReviewRemediationScopeBoundary['status'];
        impact_analysis_source: ReviewRemediationImpactAnalysis['source'] | 'missing';
        matched_signals: string[];
        semantic_changed_files: string[];
        semantic_scope_source: 'expanded_files' | 'impact_analysis_files' | 'current_changed_files';
        test_refactor_trigger_reason: string | null;
        test_refactor_trigger_files: string[];
        test_refactor_changed_lines_threshold: number;
        test_refactor_changed_lines_total: number | null;
    };
    review_reuse_decision_order: 'classification_before_reuse';
    non_test_review_reuse_candidate: boolean;
    test_review_reuse_candidate: boolean;
    blocked_before_reuse: boolean;
    invalidated_review_types: string[];
    preserved_review_types: string[];
}
