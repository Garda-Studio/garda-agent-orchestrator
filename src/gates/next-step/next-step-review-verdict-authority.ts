import { getEffectiveReviewLaneContract } from '../../policy/effective-review-lane-set';
import { resolveReviewContextLaneBinding } from '../review-context/review-context-lane';

export interface NextStepReviewVerdictAuthority {
    passToken: string;
    failToken: string;
    violations: string[];
}

export function resolveNextStepReviewVerdictAuthority(
    preflight: Record<string, unknown> | null,
    reviewType: string
): NextStepReviewVerdictAuthority {
    try {
        const lane = getEffectiveReviewLaneContract(preflight, reviewType, { allowLegacyBuiltInFallback: true });
        const tokens = preflight?.effective_review_snapshot !== undefined
            ? resolveReviewContextLaneBinding(preflight, reviewType).verdict_tokens
            : { pass: lane.pass_token, fail: lane.fail_token };
        return {
            passToken: tokens.pass,
            // Retain the reader's historical code-failure spelling; the shared parser accepts both aliases.
            failToken: lane.id === 'code' && tokens.fail === 'REVIEW FAILED' ? 'CODE REVIEW FAILED' : tokens.fail,
            violations: []
        };
    } catch (error: unknown) {
        return {
            passToken: '',
            failToken: '',
            violations: [`Review verdict authority is invalid: ${error instanceof Error ? error.message : String(error)}`]
        };
    }
}
