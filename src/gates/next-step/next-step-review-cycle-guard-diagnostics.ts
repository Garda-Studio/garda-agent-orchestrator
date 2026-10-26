import { countNextStepWork, countNextStepArrayCopy } from '../../core/next-step-measurement';
import {
    type ReviewCycleGuardEvaluation as CoreReviewCycleGuardEvaluation
} from '../../core/review-cycle-guard';
import {
    type ReviewCycleAttemptCountSummary,
    type ReviewCycleAttemptDiagnostics,
    type ReviewCycleFreshReuseSummary,
    type ReviewCycleGuardEvaluation,
    type ReviewCycleGuardReadAttempt
} from './next-step-review-cycle-guard-types';

function createReviewCycleAttemptCountSummary(): ReviewCycleAttemptCountSummary {
    return { total: 0, failed: 0, passed: 0, pending: 0 };
}

function recordReviewCycleAttemptCount(
    summary: ReviewCycleAttemptCountSummary,
    attempt: ReviewCycleGuardReadAttempt
): void {
    summary.total += 1;
    if (attempt.failed) {
        summary.failed += 1;
    } else if (attempt.passed) {
        summary.passed += 1;
    } else {
        summary.pending += 1;
    }
}

function createReviewCycleFreshReuseSummary(): ReviewCycleFreshReuseSummary {
    return { fresh: 0, reused: 0 };
}

function recordReviewCycleFreshReuse(
    summary: ReviewCycleFreshReuseSummary,
    attempt: ReviewCycleGuardReadAttempt
): void {
    if (attempt.reused) {
        summary.reused += 1;
    } else {
        summary.fresh += 1;
    }
}

function sortReviewCycleCountRecord<T>(record: Record<string, T>): Record<string, T> {
    return Object.fromEntries(
        Object.entries(record).sort(([left], [right]) => (countNextStepWork('visit:next-step-review-cycle-guard-diagnostics:event:47'), left.localeCompare(right)))
    );
}

export function buildReviewCycleAttemptDiagnostics(
    attempts: ReviewCycleGuardReadAttempt[],
    excludedReviewTypes: string[]
): ReviewCycleAttemptDiagnostics {
    const excluded = new Set(excludedReviewTypes.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
    const currentScopeCountsByType = new Map<string, ReviewCycleAttemptCountSummary>();
    const freshReusedByType = new Map<string, ReviewCycleFreshReuseSummary>();
    const scopeHashCountsByType = new Map<string, Map<string, {
        total: number;
        failed: number;
        passed: number;
        pending: number;
        fresh: number;
        reused: number;
    }>>();
    let freshNonTestReviewCount = 0;
    let reusedNonTestReviewCount = 0;
    let cumulativeTotalNonTestReviewCount = 0;
    let cumulativeFailedNonTestReviewCount = 0;
    let currentScopeTotalAttemptCount = 0;
    let currentScopeTotalNonTestReviewCount = 0;
    let currentScopeFailedNonTestReviewCount = 0;

    for (const attempt of attempts) {
        countNextStepWork('visit:next-step-review-cycle-guard-diagnostics:event:74');
        const reviewType = attempt.reviewType.trim().toLowerCase();
        if (!reviewType) {
            continue;
        }
        const countsTowardGuard = !excluded.has(reviewType);
        const freshReused = freshReusedByType.get(reviewType) || createReviewCycleFreshReuseSummary();
        recordReviewCycleFreshReuse(freshReused, attempt);
        freshReusedByType.set(reviewType, freshReused);
        if (countsTowardGuard) {
            if (attempt.reused) {
                reusedNonTestReviewCount += 1;
            } else {
                cumulativeTotalNonTestReviewCount += 1;
                freshNonTestReviewCount += 1;
                if (attempt.failed) {
                    cumulativeFailedNonTestReviewCount += 1;
                }
            }
        }

        if (!attempt.scopeHash) {
            if (attempt.currentScope) {
                currentScopeTotalAttemptCount += 1;
                if (countsTowardGuard && !attempt.reused) {
                    const currentScopeCounts = currentScopeCountsByType.get(reviewType) || createReviewCycleAttemptCountSummary();
                    recordReviewCycleAttemptCount(currentScopeCounts, attempt);
                    currentScopeCountsByType.set(reviewType, currentScopeCounts);
                    currentScopeTotalNonTestReviewCount += 1;
                    if (attempt.failed) {
                        currentScopeFailedNonTestReviewCount += 1;
                    }
                }
            }
            continue;
        }
        let scopeHashCounts = scopeHashCountsByType.get(reviewType);
        if (!scopeHashCounts) {
            scopeHashCounts = new Map();
            scopeHashCountsByType.set(reviewType, scopeHashCounts);
        }
        const scopeCounts = scopeHashCounts.get(attempt.scopeHash) || {
            total: 0,
            failed: 0,
            passed: 0,
            pending: 0,
            fresh: 0,
            reused: 0
        };
        scopeCounts.total += 1;
        if (attempt.failed) {
            scopeCounts.failed += 1;
        } else if (attempt.passed) {
            scopeCounts.passed += 1;
        } else {
            scopeCounts.pending += 1;
        }
        if (attempt.reused) {
            scopeCounts.reused += 1;
        } else {
            scopeCounts.fresh += 1;
        }
        scopeHashCounts.set(attempt.scopeHash, scopeCounts);

        if (attempt.currentScope) {
            currentScopeTotalAttemptCount += 1;
            if (countsTowardGuard && !attempt.reused) {
                const currentScopeCounts = currentScopeCountsByType.get(reviewType) || createReviewCycleAttemptCountSummary();
                recordReviewCycleAttemptCount(currentScopeCounts, attempt);
                currentScopeCountsByType.set(reviewType, currentScopeCounts);
                currentScopeTotalNonTestReviewCount += 1;
                if (attempt.failed) {
                    currentScopeFailedNonTestReviewCount += 1;
                }
            }
        }
    }

    const sortedScopeHashCountEntries = countNextStepArrayCopy('visit:next-step-review-cycle-guard-diagnostics:copy:152', [...scopeHashCountsByType.entries()])
        .sort(([left], [right]) => (countNextStepWork('visit:next-step-review-cycle-guard-diagnostics:event:152'), left.localeCompare(right)));
    const scopeHashCountByReviewType = Object.fromEntries(
        sortedScopeHashCountEntries.map(([reviewType, scopeHashCounts]) => (countNextStepWork('visit:next-step-review-cycle-guard-diagnostics:event:155'), [reviewType, scopeHashCounts.size]))
    );
    const topScopeHashesByReviewType = Object.fromEntries(
        sortedScopeHashCountEntries
            .map(([reviewType, scopeHashCounts]) => (countNextStepWork('visit:next-step-review-cycle-guard-diagnostics:event:158'), [
                reviewType,
                countNextStepArrayCopy('visit:next-step-review-cycle-guard-diagnostics:copy:161', countNextStepArrayCopy('visit:next-step-review-cycle-guard-diagnostics:copy:161', [...scopeHashCounts.entries()])
                    .sort(([leftHash, leftCounts], [rightHash, rightCounts]) =>
                        (countNextStepWork('visit:next-step-review-cycle-guard-diagnostics:event:161'), rightCounts.total - leftCounts.total || leftHash.localeCompare(rightHash))
                    )
                    .slice(0, 5))
                    .map(([scopeHash, counts]) => (countNextStepWork('visit:next-step-review-cycle-guard-diagnostics:event:161'), ({
                        scope_hash: scopeHash,
                        total: counts.total,
                        failed: counts.failed,
                        passed: counts.passed,
                        pending: counts.pending,
                        fresh: counts.fresh,
                        reused: counts.reused,
                        current_scope: attempts.some((attempt) =>
                            (countNextStepWork('visit:next-step-review-cycle-guard-diagnostics:event:174'), attempt.reviewType.trim().toLowerCase() === reviewType
                            && attempt.scopeHash === scopeHash
                            && attempt.currentScope)
                        )
                    })))
            ]))
    );

    return {
        cumulative_total_attempt_count: attempts.length,
        cumulative_total_non_test_review_count: cumulativeTotalNonTestReviewCount,
        cumulative_failed_non_test_review_count: cumulativeFailedNonTestReviewCount,
        current_scope_total_attempt_count: currentScopeTotalAttemptCount,
        current_scope_total_non_test_review_count: currentScopeTotalNonTestReviewCount,
        current_scope_failed_non_test_review_count: currentScopeFailedNonTestReviewCount,
        fresh_non_test_review_count: freshNonTestReviewCount,
        reused_non_test_review_count: reusedNonTestReviewCount,
        current_scope_counts_by_review_type: sortReviewCycleCountRecord(Object.fromEntries(currentScopeCountsByType.entries())),
        fresh_reused_by_review_type: sortReviewCycleCountRecord(Object.fromEntries(freshReusedByType.entries())),
        scope_hash_count_by_review_type: scopeHashCountByReviewType,
        top_scope_hashes_by_review_type: topScopeHashesByReviewType
    };
}

function formatReviewCycleAttemptDiagnosticsSummary(diagnostics: ReviewCycleAttemptDiagnostics): string | null {
    if (diagnostics.cumulative_total_attempt_count === 0) {
        return null;
    }
    const freshReusedText = Object.entries(diagnostics.fresh_reused_by_review_type)
        .map(([reviewType, counts]) => (countNextStepWork('visit:next-step-review-cycle-guard-diagnostics:event:203'), `${reviewType}:fresh=${counts.fresh},reused=${counts.reused}`))
        .join('|');
    const scopeHashText = Object.entries(diagnostics.top_scope_hashes_by_review_type)
        .map(([reviewType, scopeHashes]) => {
            countNextStepWork('visit:next-step-review-cycle-guard-diagnostics:event:206');
            const topScopeHashes = scopeHashes
                .map((counts) =>
                    `${counts.scope_hash}:total=${counts.total},failed=${counts.failed},passed=${counts.passed},pending=${counts.pending},fresh=${counts.fresh},reused=${counts.reused},current_scope=${counts.current_scope}`
                )
                .join('|');
            const uniqueCount = diagnostics.scope_hash_count_by_review_type[reviewType] ?? scopeHashes.length;
            return `${reviewType}:unique=${uniqueCount}${topScopeHashes ? `[top=${topScopeHashes}]` : ''}`;
        })
        .join('; ');

    return [
        `cumulative_total_attempts=${diagnostics.cumulative_total_attempt_count}`,
        `cumulative_non_test_reviews=${diagnostics.cumulative_total_non_test_review_count}`,
        `current_scope_non_test_reviews=${diagnostics.current_scope_total_non_test_review_count}`,
        `fresh_non_test_reviews=${diagnostics.fresh_non_test_review_count}`,
        `reused_non_test_reviews=${diagnostics.reused_non_test_review_count}`,
        freshReusedText ? `fresh_reused_by_type=${freshReusedText}` : null,
        scopeHashText ? `top_scope_hashes_by_type=${scopeHashText}` : null
    ].filter((entry): entry is string => (countNextStepWork('visit:next-step-review-cycle-guard-diagnostics:event:218'), Boolean(entry))).join('; ');
}

export function extendReviewCycleGuardEvaluation(
    evaluation: CoreReviewCycleGuardEvaluation,
    currentScopeEvaluation: CoreReviewCycleGuardEvaluation,
    diagnostics: ReviewCycleAttemptDiagnostics,
    appendDiagnosticsSummary: boolean
): ReviewCycleGuardEvaluation {
    const diagnosticsSummary = appendDiagnosticsSummary
        ? formatReviewCycleAttemptDiagnosticsSummary(diagnostics)
        : null;
    return {
        ...evaluation,
        should_block: evaluation.should_block || currentScopeEvaluation.should_block,
        summary_line: diagnosticsSummary
            ? `${evaluation.summary_line}; ${diagnosticsSummary}`
            : evaluation.summary_line,
        current_scope_total_non_test_review_count: diagnostics.current_scope_total_non_test_review_count,
        current_scope_failed_non_test_review_count: diagnostics.current_scope_failed_non_test_review_count,
        current_scope_counts_by_review_type: diagnostics.current_scope_counts_by_review_type,
        attempt_diagnostics: diagnostics
    };
}
