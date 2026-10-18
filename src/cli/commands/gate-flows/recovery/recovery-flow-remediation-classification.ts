import { DEFAULT_REVIEW_TRIGGER_POLICY } from '../../../../policy/review-trigger-policy';
import {
    resolveReviewDependencyDownstreamReachability,
    type CompiledReviewDependencyGraph
} from '../../../../core/review-dependency-graph';
import { normalizeChangedFiles } from './recovery-flow-shared';
import {
    getReviewRemediationSemanticSignals,
    groupReviewRemediationFiles
} from './recovery-flow-remediation-semantics';
import type {
    ReviewRemediationFixClassification,
    ReviewRemediationImpactAnalysis,
    ReviewRemediationScopeBoundary,
    ReviewRemediationScopeCategory
} from './recovery-flow-types';

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pathsReferToSameRelativeFile(left: string, right: string): boolean {
    return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function getPreflightReuseBlockReason(
    preflightPayload?: unknown,
    remediationChangedFiles: readonly string[] = []
): string | null {
    if (!isRecord(preflightPayload) || !isRecord(preflightPayload.triggers)) {
        return null;
    }
    const changedProtectedFiles = Array.isArray(preflightPayload.triggers.changed_protected_files)
        ? normalizeChangedFiles(preflightPayload.triggers.changed_protected_files)
        : [];
    if (preflightPayload.triggers.protected_control_plane_changed === true || changedProtectedFiles.length > 0) {
        const remediationFileSet = new Set(normalizeChangedFiles(remediationChangedFiles));
        if (remediationFileSet.size > 0 && changedProtectedFiles.length > 0) {
            const protectedRemediationFiles = changedProtectedFiles.filter((protectedFile) => (
                [...remediationFileSet].some((remediationFile) => (
                    pathsReferToSameRelativeFile(protectedFile, remediationFile)
                ))
            ));
            if (protectedRemediationFiles.length === 0) {
                return null;
            }
            return `remediation delta includes protected-control-plane changes: ${protectedRemediationFiles.join(', ')}`;
        }
        return changedProtectedFiles.length > 0
            ? `refreshed preflight includes protected-control-plane changes: ${changedProtectedFiles.join(', ')}`
            : 'refreshed preflight includes protected-control-plane changes';
    }
    return null;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1
        ? value
        : fallback;
}

function getPreflightChangedFileStats(
    preflightPayload?: unknown,
    changedFileStatsOverride?: unknown
): Record<string, { changed_lines: number }> {
    const stats: Record<string, { changed_lines: number }> = {};
    for (const statsSource of [
        isRecord(preflightPayload) && isRecord(preflightPayload.metrics)
            ? preflightPayload.metrics.changed_file_stats
            : undefined,
        changedFileStatsOverride
    ]) {
        if (!isRecord(statsSource)) {
            continue;
        }
        for (const [rawPath, rawStats] of Object.entries(statsSource)) {
            if (!isRecord(rawStats)) {
                continue;
            }
            const [normalizedPath] = normalizeChangedFiles([rawPath]);
            if (!normalizedPath) {
                continue;
            }
            const changedLines = Number(rawStats.changed_lines);
            if (Number.isFinite(changedLines) && changedLines >= 0) {
                stats[normalizedPath] = { changed_lines: changedLines };
            }
        }
    }
    return stats;
}

function getChangedLinesForFiles(
    preflightPayload: unknown,
    files: readonly string[],
    changedFileStatsOverride?: unknown
): number | null {
    const stats = getPreflightChangedFileStats(preflightPayload, changedFileStatsOverride);
    const normalizedFiles = normalizeChangedFiles(files);
    let matchedStats = 0;
    let changedLinesTotal = 0;
    for (const file of normalizedFiles) {
        const directStats = stats[file];
        const relatedStats = directStats
            ?? Object.entries(stats).find(([statsFile]) => pathsReferToSameRelativeFile(statsFile, file))?.[1];
        if (!relatedStats) {
            continue;
        }
        matchedStats += 1;
        changedLinesTotal += relatedStats.changed_lines;
    }
    return matchedStats > 0 ? changedLinesTotal : null;
}

function getStructuralTestDomainFiles(files: readonly string[], patterns: readonly string[]): string[] {
    const compiledPatterns = patterns.map((pattern) => new RegExp(pattern, 'iu'));
    return normalizeChangedFiles(files).filter((file) => compiledPatterns.some((pattern) => pattern.test(file)));
}

function orderRequiredReviewTypes(
    requiredReviewTypes: readonly string[],
    dependencyGraph?: CompiledReviewDependencyGraph | null
): string[] {
    const normalized = [...new Set(
        requiredReviewTypes.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    )];
    if (!dependencyGraph) {
        return normalized.sort();
    }
    const requiredSet = new Set(normalized);
    const missingFromGraph = normalized.filter((reviewType) => !dependencyGraph.nodes.includes(reviewType));
    if (missingFromGraph.length > 0) {
        throw new Error(
            `Required remediation review lanes are missing from the frozen dependency graph: ${missingFromGraph.join(', ')}.`
        );
    }
    return dependencyGraph.preparation_order.filter((reviewType) => requiredSet.has(reviewType));
}

function expandInvalidatedReviewTypes(
    seedReviewTypes: readonly string[],
    requiredReviewTypes: readonly string[],
    dependencyGraph?: CompiledReviewDependencyGraph | null
): string[] {
    const requiredSet = new Set(requiredReviewTypes);
    const normalizedSeeds = [...new Set(
        seedReviewTypes.map((entry) => String(entry || '').trim().toLowerCase()).filter((entry) => requiredSet.has(entry))
    )];
    if (!dependencyGraph || normalizedSeeds.length === 0) {
        return normalizedSeeds.sort();
    }
    return resolveReviewDependencyDownstreamReachability(
        dependencyGraph,
        normalizedSeeds
    ).affected_review_ids.filter((reviewType) => requiredSet.has(reviewType));
}

function assessTestRefactorInvalidation(options: {
    semanticChangedFiles: readonly string[];
    scopeBoundary: ReviewRemediationScopeBoundary;
    preflightPayload?: unknown;
    changedLinesThreshold?: number;
    structuralPathRegexes?: readonly string[];
    changedFileStats?: unknown;
}): {
    invalidatesRefactor: boolean;
    reason: string | null;
    triggerFiles: string[];
    changedLinesThreshold: number;
    changedLinesTotal: number | null;
} {
    const changedLinesThreshold = normalizePositiveInteger(
        options.changedLinesThreshold,
        DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_changed_lines_threshold
    );
    const semanticChangedFiles = normalizeChangedFiles(options.semanticChangedFiles);
    const expandedTestFiles = normalizeChangedFiles(options.scopeBoundary.allowedTestOnlyExpansionFiles)
        .filter((file) => semanticChangedFiles.some((semanticFile) => pathsReferToSameRelativeFile(file, semanticFile)));
    if (expandedTestFiles.length > 0) {
        return {
            invalidatesRefactor: true,
            reason: 'new_test_file',
            triggerFiles: expandedTestFiles,
            changedLinesThreshold,
            changedLinesTotal: getChangedLinesForFiles(options.preflightPayload, semanticChangedFiles, options.changedFileStats)
        };
    }
    const structuralTestFiles = getStructuralTestDomainFiles(
        semanticChangedFiles,
        options.structuralPathRegexes || DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_structural_path_regexes
    );
    if (structuralTestFiles.length > 0) {
        return {
            invalidatesRefactor: true,
            reason: 'structural_test_domain_file',
            triggerFiles: structuralTestFiles,
            changedLinesThreshold,
            changedLinesTotal: getChangedLinesForFiles(options.preflightPayload, semanticChangedFiles, options.changedFileStats)
        };
    }
    const changedLinesTotal = getChangedLinesForFiles(options.preflightPayload, semanticChangedFiles, options.changedFileStats);
    if (changedLinesTotal !== null && changedLinesTotal > changedLinesThreshold) {
        return {
            invalidatesRefactor: true,
            reason: 'test_domain_changed_lines_threshold',
            triggerFiles: semanticChangedFiles,
            changedLinesThreshold,
            changedLinesTotal
        };
    }
    return {
        invalidatesRefactor: false,
        reason: null,
        triggerFiles: [],
        changedLinesThreshold,
        changedLinesTotal
    };
}

export function classifyReviewRemediationFix(
    scopeBoundary: ReviewRemediationScopeBoundary,
    requiredReviewTypes: readonly string[] = [],
    impactAnalysis?: ReviewRemediationImpactAnalysis,
    testTriggerRegexes: readonly string[] = [],
    preflightPayload?: unknown,
    options: {
        testRefactorChangedLinesThreshold?: number;
        testRefactorStructuralPathRegexes?: readonly string[];
        changedFileStats?: unknown;
        reviewEvidenceOnly?: boolean;
        remediationReviewType?: string;
        reviewDependencyGraph?: CompiledReviewDependencyGraph | null;
    } = {}
): ReviewRemediationFixClassification {
    const normalizedRequiredReviewTypes = orderRequiredReviewTypes(
        requiredReviewTypes,
        options.reviewDependencyGraph
    );
    const nonTestReviewTypes = normalizedRequiredReviewTypes.filter((entry) => entry !== 'test');
    const scopeCategory: ReviewRemediationScopeCategory = scopeBoundary.status === 'BLOCKED'
        ? 'expanded_non_test_blocked'
        : scopeBoundary.allowedTestOnlyExpansionFiles.length > 0
            ? 'test_only_expansion'
            : 'previous_scope_only';
    const remediationReviewType = String(options.remediationReviewType || '').trim().toLowerCase();
    const semantic = options.reviewEvidenceOnly === true
        ? {
            category: 'review_evidence_only' as const,
            matchedSignals: ['provider review evidence only'],
            rationale: `delegated reviewer evidence failed for '${remediationReviewType || 'unknown'}' without a source remediation delta`,
            changedFiles: [] as string[],
            scopeSource: 'current_changed_files' as const
        }
        : getReviewRemediationSemanticSignals(scopeBoundary, impactAnalysis, testTriggerRegexes);
    const affectedFileGroups = groupReviewRemediationFiles(scopeBoundary.currentChangedFiles, testTriggerRegexes, scopeBoundary.fileRoles);
    const preflightReuseBlockReason = getPreflightReuseBlockReason(
        preflightPayload,
        semantic.category === 'test_coverage_only' ? semantic.changedFiles : []
    );
    const failClosed = !!preflightReuseBlockReason
        || semantic.category === 'unknown'
        || semantic.category === 'security_sensitive'
        || semantic.category === 'api_surface'
        || semantic.category === 'runtime_behavior'
        || scopeBoundary.status === 'BLOCKED';
    const classificationReason = preflightReuseBlockReason
        ? `${semantic.rationale}; ${preflightReuseBlockReason}; fail closed before reuse`
        : semantic.rationale;
    const impactAnalysisSource: ReviewRemediationFixClassification['evidence']['impact_analysis_source'] =
        impactAnalysis?.source || 'missing';
    const testRefactorInvalidation = assessTestRefactorInvalidation({
        semanticChangedFiles: semantic.category === 'test_coverage_only' ? semantic.changedFiles : [],
        scopeBoundary,
        preflightPayload,
        changedLinesThreshold: options.testRefactorChangedLinesThreshold,
        structuralPathRegexes: options.testRefactorStructuralPathRegexes,
        changedFileStats: options.changedFileStats
    });
    const base = {
        status: 'CLASSIFIED' as const,
        category: semantic.category,
        scope_category: scopeCategory,
        rationale: classificationReason,
        reason: classificationReason,
        affected_file_groups: affectedFileGroups,
        evidence: {
            scope_boundary_status: scopeBoundary.status,
            impact_analysis_source: impactAnalysisSource,
            matched_signals: semantic.matchedSignals,
            semantic_changed_files: semantic.changedFiles,
            semantic_scope_source: semantic.scopeSource,
            test_refactor_trigger_reason: testRefactorInvalidation.reason,
            test_refactor_trigger_files: testRefactorInvalidation.triggerFiles,
            test_refactor_changed_lines_threshold: testRefactorInvalidation.changedLinesThreshold,
            test_refactor_changed_lines_total: testRefactorInvalidation.changedLinesTotal
        },
        review_reuse_decision_order: 'classification_before_reuse' as const
    };
    if (scopeBoundary.status === 'BLOCKED') {
        return {
            ...base,
            rationale: `${semantic.rationale}; remediation changed non-test files outside the failed-review scope`,
            reason: `${semantic.rationale}; remediation changed non-test files outside the failed-review scope`,
            non_test_review_reuse_candidate: false,
            test_review_reuse_candidate: false,
            blocked_before_reuse: true,
            invalidated_review_types: normalizedRequiredReviewTypes,
            preserved_review_types: []
        };
    }
    if (semantic.category === 'review_evidence_only') {
        const targetReviewType = normalizedRequiredReviewTypes.includes(remediationReviewType)
            ? remediationReviewType
            : '';
        const invalidatedReviewTypes = targetReviewType
            ? expandInvalidatedReviewTypes(
                [targetReviewType],
                normalizedRequiredReviewTypes,
                options.reviewDependencyGraph
            )
            : normalizedRequiredReviewTypes;
        return {
            ...base,
            rationale: targetReviewType
                ? semantic.rationale
                : `${semantic.rationale}; review type is missing or not required, so fail closed`,
            reason: targetReviewType
                ? semantic.rationale
                : `${semantic.rationale}; review type is missing or not required, so fail closed`,
            non_test_review_reuse_candidate: Boolean(targetReviewType),
            test_review_reuse_candidate: Boolean(targetReviewType),
            blocked_before_reuse: false,
            invalidated_review_types: invalidatedReviewTypes,
            preserved_review_types: targetReviewType
                ? normalizedRequiredReviewTypes.filter((entry) => !invalidatedReviewTypes.includes(entry))
                : []
        };
    }
    if (scopeBoundary.allowedTestOnlyExpansionFiles.length > 0 || semantic.category === 'test_coverage_only') {
        const testRefactorInvalidatedReviewTypes = !failClosed
            && testRefactorInvalidation.invalidatesRefactor
            && normalizedRequiredReviewTypes.includes('refactor')
            ? ['refactor']
            : [];
        const invalidatedReviewTypes = failClosed
            ? normalizedRequiredReviewTypes
            : expandInvalidatedReviewTypes(
                [
                    ...(normalizedRequiredReviewTypes.includes('test') ? ['test'] : []),
                    ...testRefactorInvalidatedReviewTypes
                ],
                normalizedRequiredReviewTypes,
                options.reviewDependencyGraph
            );
        return {
            ...base,
            non_test_review_reuse_candidate: !failClosed,
            test_review_reuse_candidate: false,
            blocked_before_reuse: false,
            invalidated_review_types: invalidatedReviewTypes,
            preserved_review_types: failClosed
                ? []
                : nonTestReviewTypes.filter((entry) => !invalidatedReviewTypes.includes(entry))
        };
    }
    if (semantic.category === 'test_hook_isolation' && !failClosed) {
        const invalidatedReviewTypes = expandInvalidatedReviewTypes(
            normalizedRequiredReviewTypes.includes('code') ? ['code'] : [],
            normalizedRequiredReviewTypes,
            options.reviewDependencyGraph
        );
        return {
            ...base,
            non_test_review_reuse_candidate: true,
            test_review_reuse_candidate: true,
            blocked_before_reuse: false,
            invalidated_review_types: invalidatedReviewTypes,
            preserved_review_types: normalizedRequiredReviewTypes.filter((entry) => !invalidatedReviewTypes.includes(entry))
        };
    }
    if (semantic.category === 'refactor_structure' && !failClosed) {
        const invalidatedReviewTypes = expandInvalidatedReviewTypes(
            normalizedRequiredReviewTypes.includes('refactor') ? ['refactor'] : [],
            normalizedRequiredReviewTypes,
            options.reviewDependencyGraph
        );
        return {
            ...base,
            non_test_review_reuse_candidate: true,
            test_review_reuse_candidate: true,
            blocked_before_reuse: false,
            invalidated_review_types: invalidatedReviewTypes,
            preserved_review_types: normalizedRequiredReviewTypes.filter((entry) => !invalidatedReviewTypes.includes(entry))
        };
    }
    return {
        ...base,
        non_test_review_reuse_candidate: !failClosed,
        test_review_reuse_candidate: !failClosed,
        blocked_before_reuse: false,
        invalidated_review_types: failClosed ? normalizedRequiredReviewTypes : [],
        preserved_review_types: failClosed ? [] : normalizedRequiredReviewTypes
    };
}
