import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint
} from '../review-reuse/review-reuse';

export function resolveReviewCoverageChangedFiles(options: {
    reviewType: string;
    preflight: Record<string, unknown>;
    repoRoot: string;
}): string[] {
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (reviewType === 'test') {
        const scope = computeReviewRelevantScopeFingerprint(
            options.preflight,
            options.repoRoot
        );
        return scope.documentation_review ? [...scope.all_changed_files].sort() : scope.review_relevant_changed_files;
    }
    const scope = computeReviewReuseCodeScopeFingerprint(
        reviewType,
        options.preflight,
        options.repoRoot
    );
    // Documentation work can include tests; fresh review evidence must cover the authored documentation.
    return scope.documentation_review ? scope.docs_only_changed_files : scope.non_test_changed_files;
}
