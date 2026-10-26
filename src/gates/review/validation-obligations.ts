import { countNextStepWork } from '../../core/next-step-measurement';
import * as path from 'node:path';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { resolveValidationSemanticReviewLanes, type EffectiveReviewSnapshot } from '../../policy/effective-review-snapshot';
import { validatePreflightForReview } from '../required-reviews/required-reviews-check-contracts';
import { assertReviewContextTrustBoundaryAnalysisReady, readReviewContextTrustBoundaryAnalysis } from '../review-context/review-context-trust-boundary-analysis';
import type { QualityValidationObligation } from '../quality-checklist/quality-checklist-validation-phases';
import { resolveCurrentNoOpPreflightPath } from '../task-mode/no-op';
import type { ValidationEvidenceInspection } from '../project-validation/attempt-evidence';
import { createInvocationReadMemoKey } from '../../core/invocation-read-observation';
import { readReviewValidationNode } from '../review-context/review-validation-invocation';

export interface ValidationReviewObligations {
    preflight_sha256: string;
    validation_phases_sha256: string | null;
    semantic_review_lanes: Array<'code' | 'test'>;
    obligations: QualityValidationObligation[];
}

const VALIDATION_OBLIGATIONS = createInvocationReadMemoKey<ValidationReviewObligations>('validation-review-obligations-v1');

export function readValidationReviewObligations(options: {
    repoRoot: string; taskId: string; preflightPath: string; taskModePath?: string;
    inspection?: ValidationEvidenceInspection;
}): ValidationReviewObligations {
    const preflightPath = resolveCurrentNoOpPreflightPath(options.repoRoot, options.taskId, options.preflightPath);
    const retained = readValidationFile(options.repoRoot,
        path.relative(path.resolve(options.repoRoot), preflightPath).replace(/\\/gu, '/'));
    // This facade synchronizes REVIEW_CONTRACTS as well as checking live policy.
    // Keep that call at the consumer boundary; never hide it inside a result memo.
    const validated = validatePreflightForReview(preflightPath, options.taskId, options.taskModePath);
    if (validated.errors.length > 0) throw new Error(`Declared validation preflight rejected: ${validated.errors.join(' ')}`);
    if (validated.preflight_hash !== retained.identity.sha256
        || validationDigest(validated.preflight) !== validationDigest(JSON.parse(retained.bytes.toString('utf8'))))
        throw new Error('Declared validation preflight changed during projection.');
    return readReviewValidationNode(VALIDATION_OBLIGATIONS, () => [
        path.resolve(options.repoRoot), options.taskId, preflightPath, retained.identity.sha256,
        options.taskModePath?.trim() ? path.resolve(options.repoRoot, options.taskModePath.trim())
            : path.join(path.dirname(preflightPath), `${options.taskId}-task-mode.json`),
        validated.preflight, options.inspection ?? 'active'
    ], () => {
        countNextStepWork('derive:readValidationReviewObligations');
        const analysis = readReviewContextTrustBoundaryAnalysis({ repoRoot: options.repoRoot, taskId: options.taskId,
            preflight: validated.preflight, preflightSha256: retained.identity.sha256, inspection: options.inspection });
        assertReviewContextTrustBoundaryAnalysisReady(analysis);
        return deriveValidationReviewObligations(validated.preflight, retained.identity.sha256, analysis.validation_phases);
    });
}

function deriveValidationReviewObligations(preflight: Record<string, unknown>, preflightSha256: string,
    phases: ReturnType<typeof readReviewContextTrustBoundaryAnalysis>['validation_phases']): ValidationReviewObligations {
    return {
        preflight_sha256: preflightSha256,
        validation_phases_sha256: phases?.sha256 ?? null,
        semantic_review_lanes: phases ? resolveValidationSemanticReviewLanes(
            preflight.effective_review_snapshot as EffectiveReviewSnapshot) : [],
        obligations: structuredClone(phases?.obligations ?? [])
    };
}
