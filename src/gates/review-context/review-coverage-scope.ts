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
        return scope.docs_only ? scope.docs_only_changed_files : scope.review_relevant_changed_files;
    }
    const scope = computeReviewReuseCodeScopeFingerprint(
        reviewType,
        options.preflight,
        options.repoRoot
    );
    // Reuse fingerprints omit ordinary documentation; a fresh docs-only review still needs an evidence domain.
    return scope.docs_only ? scope.docs_only_changed_files : scope.non_test_changed_files;
}
