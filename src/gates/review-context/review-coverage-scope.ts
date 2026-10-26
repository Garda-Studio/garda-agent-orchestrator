import { createInvocationReadMemoKey } from '../../core/invocation-read-observation';
import { countNextStepWork } from '../../core/next-step-measurement';
import { readReviewValidationNode } from './review-validation-invocation';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewRelevantScopeWithoutCloseout,
    computeReviewReuseCodeScopeFingerprint
} from '../review-reuse/review-reuse';

interface CoverageChangedFileOptions {
    reviewType: string;
    preflight: Record<string, unknown>;
    repoRoot: string;
}
const COVERAGE_CHANGED_FILES = createInvocationReadMemoKey<string[]>('review-coverage-changed-files');

export function resolveReviewCoverageChangedFiles(options: CoverageChangedFileOptions): string[] {
    return readReviewValidationNode(COVERAGE_CHANGED_FILES, () => options, () => {
        countNextStepWork('derive:review_coverage_changed_files');
        const files = deriveReviewCoverageChangedFiles(options);
        countNextStepWork('visit:review_coverage_selected_file', files.length);
        return files;
    });
}

function deriveReviewCoverageChangedFiles(options: CoverageChangedFileOptions): string[] {
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
    if (scope.documentation_review) {
        return scope.docs_only_changed_files;
    }
    if (scope.test_only && scope.all_changed_files.length > 0) {
        return computeReviewRelevantScopeWithoutCloseout(options.preflight, options.repoRoot).review_relevant_changed_files;
    }
    return scope.non_test_changed_files;
}
