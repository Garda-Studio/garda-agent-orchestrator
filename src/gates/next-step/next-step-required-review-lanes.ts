import {
    getReviewExecutionPreparationOrder,
    LEGACY_REVIEW_EXECUTION_POLICY_MODE
} from '../../core/review-execution-policy';
import { resolveEffectiveReviewLaneSetOrLegacy } from '../../policy/effective-review-lane-set';

/** Presentation order is separate from the immutable dependency graph's launch order. */
export function resolveNextStepRequiredReviewTypes(preflight: Record<string, unknown> | null): string[] {
    const laneSet = resolveEffectiveReviewLaneSetOrLegacy(preflight);
    const required = new Set(laneSet.required_review_ids);
    const builtInOrder = getReviewExecutionPreparationOrder(LEGACY_REVIEW_EXECUTION_POLICY_MODE);
    const builtInIds = new Set(builtInOrder);
    return [
        ...builtInOrder.filter(id => required.has(id)),
        ...laneSet.required_review_ids.filter(id => !builtInIds.has(id)).sort()
    ];
}
