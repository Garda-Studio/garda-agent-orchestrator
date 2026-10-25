import { resolveReviewReuseClassificationConfig } from '../review-reuse/review-reuse';
import { isSafeOrdinaryDocumentationPath } from '../preflight/classify-change-doc-safety';
import type { ResolvedClassificationConfig } from '../preflight/classify-change-config';

/** Only classifier-ordinary documentation is exempt from changed-source RED coverage. */
export function requiredExpectedRedFiles(
    preflight: Record<string, unknown>, repoRoot: string,
    config: ResolvedClassificationConfig = resolveReviewReuseClassificationConfig(preflight, repoRoot)
): unknown[] {
    const declaredTests = new Set(Array.isArray(preflight.declared_test_paths) ? preflight.declared_test_paths : []);
    const changed = Array.isArray(preflight.changed_files) ? preflight.changed_files : [];
    return changed.filter(file => typeof file !== 'string' || declaredTests.has(file)
        || !isSafeOrdinaryDocumentationPath(file, config));
}
