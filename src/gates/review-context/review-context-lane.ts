import { stringSha256 } from '../../gate-runtime/hash';
import {
    REVIEW_COVERAGE_CATEGORY_IDS,
    type NormalizedReviewerRole,
    type ReviewVerdictTokens
} from '../../core/review-catalog';
import {
    getEffectiveReviewSnapshotViolations,
    type EffectiveReviewSelection,
    type EffectiveReviewSnapshot,
    type EffectiveReviewSnapshotLane
} from '../../policy/effective-review-snapshot';

const STABLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
export const REVIEW_LANE_ARTIFACT_EVIDENCE_FIELDS = Object.freeze([
    'review_lane_binding_sha256',
    'review_lane_definition_sha256',
    'effective_review_snapshot_sha256',
    'review_catalog_sha256',
    'review_verdict_contract_sha256'
] as const);

export interface ReviewContextLaneBinding {
    schema_version: 1;
    review_type: string;
    selection: Exclude<EffectiveReviewSelection, 'inactive'>;
    built_in: boolean;
    catalog_sha256: string;
    profile_policy_sha256: string;
    profile_snapshot_sha256: string;
    effective_review_snapshot_sha256: string;
    lane_definition_sha256: string;
    skill_ids: string[];
    coverage_category_ids: string[];
    reviewer_role: NormalizedReviewerRole;
    verdict_tokens: ReviewVerdictTokens;
    binding_sha256: string;
}

export type ReviewLaneArtifactEvidence = Record<
    (typeof REVIEW_LANE_ARTIFACT_EVIDENCE_FIELDS)[number],
    string
>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
}

function getLaneDefinitionViolations(lane: EffectiveReviewSnapshotLane): string[] {
    const violations: string[] = [];
    if (!isPlainRecord(lane.definition)) {
        return [`Snapshot lane '${lane.id}' definition is malformed.`];
    }
    const definition = lane.definition;
    const skillIds = normalizedStringArray(definition.skill_ids);
    if (skillIds.length === 0 || skillIds.some((skillId) => !STABLE_ID_PATTERN.test(skillId))) {
        violations.push(`Snapshot lane '${lane.id}' must bind at least one normalized review skill id.`);
    }
    const coverageCategoryIds = normalizedStringArray(definition.coverage_category_ids);
    const knownCoverageCategories = new Set<string>(REVIEW_COVERAGE_CATEGORY_IDS);
    if (coverageCategoryIds.length === 0) {
        violations.push(`Snapshot lane '${lane.id}' must bind at least one coverage category.`);
    }
    for (const categoryId of coverageCategoryIds) {
        if (!knownCoverageCategories.has(categoryId)) {
            violations.push(`Snapshot lane '${lane.id}' contains unknown coverage category '${categoryId}'.`);
        }
    }
    const role = isPlainRecord(definition.reviewer_role) ? definition.reviewer_role : null;
    if (!STABLE_ID_PATTERN.test(String(role?.role_id || ''))) {
        violations.push(`Snapshot lane '${lane.id}' reviewer role id is malformed.`);
    }
    if (normalizedStringArray(role?.focus_tags).some((focusTag) => !STABLE_ID_PATTERN.test(focusTag))) {
        violations.push(`Snapshot lane '${lane.id}' reviewer focus tags are malformed.`);
    }
    if (!definition.built_in) {
        const verdictLabel = lane.id.toUpperCase().replace(/-/gu, ' ');
        const expectedPass = `${verdictLabel} REVIEW PASSED`;
        const expectedFail = `${verdictLabel} REVIEW FAILED`;
        const verdictTokens = isPlainRecord(definition.verdict_tokens) ? definition.verdict_tokens : null;
        if (verdictTokens?.pass !== expectedPass || verdictTokens?.fail !== expectedFail) {
            violations.push(
                `Snapshot lane '${lane.id}' custom verdict tokens are not the generated canonical tokens.`
            );
        }
    }
    return violations;
}

function buildLaneBinding(
    snapshot: EffectiveReviewSnapshot,
    lane: EffectiveReviewSnapshotLane
): ReviewContextLaneBinding {
    const laneDefinitionSha256 = stringSha256(JSON.stringify(lane.definition)) || '';
    const body: Omit<ReviewContextLaneBinding, 'binding_sha256'> = {
        schema_version: 1,
        review_type: lane.id,
        selection: lane.selection as Exclude<EffectiveReviewSelection, 'inactive'>,
        built_in: lane.definition.built_in,
        catalog_sha256: snapshot.catalog_sha256,
        profile_policy_sha256: snapshot.profile_policy_sha256,
        profile_snapshot_sha256: snapshot.profile_snapshot_sha256,
        effective_review_snapshot_sha256: snapshot.snapshot_sha256,
        lane_definition_sha256: laneDefinitionSha256,
        skill_ids: [...lane.definition.skill_ids],
        coverage_category_ids: [...lane.definition.coverage_category_ids],
        reviewer_role: {
            role_id: lane.definition.reviewer_role.role_id,
            focus_tags: [...lane.definition.reviewer_role.focus_tags]
        },
        verdict_tokens: { ...lane.definition.verdict_tokens }
    };
    return {
        ...body,
        binding_sha256: stringSha256(JSON.stringify(body)) || ''
    };
}

export function resolveReviewContextLaneBinding(
    preflight: Record<string, unknown>,
    reviewType: string
): ReviewContextLaneBinding {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const rawSnapshot = preflight.effective_review_snapshot;
    const violations = getEffectiveReviewSnapshotViolations(rawSnapshot);
    const snapshot = isPlainRecord(rawSnapshot)
        ? rawSnapshot as unknown as EffectiveReviewSnapshot
        : null;
    const lanes = snapshot && Array.isArray(snapshot.lanes) ? snapshot.lanes : [];
    const lane = lanes.find((candidate) => (
        isPlainRecord(candidate) && candidate.id === normalizedReviewType
    )) as EffectiveReviewSnapshotLane | undefined;
    if (!lane) {
        violations.push(
            `Review type '${normalizedReviewType || '<missing>'}' is unknown to the immutable effective review snapshot.`
        );
    } else {
        violations.push(...getLaneDefinitionViolations(lane));
        if (lane.selection === 'inactive') {
            violations.push(
                `Review lane '${lane.id}' is inactive in the immutable effective review snapshot ` +
                `(${normalizedStringArray(lane.inactive_reasons).join(', ') || 'no active selection reason'}).`
            );
        }
        const requiredReviews = isPlainRecord(preflight.required_reviews) ? preflight.required_reviews : null;
        const expectedRequired = lane.selection === 'required';
        if (!requiredReviews || requiredReviews[lane.id] !== expectedRequired) {
            violations.push(
                `Preflight required_reviews.${lane.id} does not match immutable lane selection '${lane.selection}'.`
            );
        }
        const taskRequired = lane.selection === 'required'
            && isPlainRecord(lane.profile) && lane.profile.capability_enabled === true
            && Array.isArray(snapshot?.inputs?.task_required_review_ids)
            && snapshot.inputs.task_required_review_ids.includes(lane.id);
        if (!isPlainRecord(lane.profile) || (lane.profile.active !== true && !taskRequired)) {
            violations.push(`Review lane '${lane.id}' profile is not active in the immutable snapshot.`);
        }
    }
    if (violations.length > 0 || !snapshot || !lane || lane.selection === 'inactive') {
        throw new Error(`Review context lane binding is invalid. ${violations.join(' ')}`);
    }
    return buildLaneBinding(snapshot, lane);
}

export function buildReviewLaneArtifactEvidence(
    binding: ReviewContextLaneBinding
): ReviewLaneArtifactEvidence | Record<string, never> {
    if (binding.built_in) {
        return {};
    }
    return {
        review_lane_binding_sha256: binding.binding_sha256,
        review_lane_definition_sha256: binding.lane_definition_sha256,
        effective_review_snapshot_sha256: binding.effective_review_snapshot_sha256,
        review_catalog_sha256: binding.catalog_sha256,
        review_verdict_contract_sha256: stringSha256(JSON.stringify(binding.verdict_tokens)) || ''
    };
}

export function getReviewLaneArtifactEvidenceViolations(options: {
    artifact: Record<string, unknown>;
    preflight: Record<string, unknown>;
    reviewType: string;
    label: string;
}): string[] {
    const binding = resolveReviewContextLaneBinding(options.preflight, options.reviewType);
    if (binding.built_in) {
        return [];
    }
    const expected = buildReviewLaneArtifactEvidence(binding);
    return Object.entries(expected).flatMap(([field, expectedValue]) => {
        const actualValue = typeof options.artifact[field] === 'string'
            ? String(options.artifact[field])
            : '';
        return actualValue === expectedValue
            ? []
            : [`${options.label} ${field} must match the immutable custom review lane binding.`];
    });
}

export function resolveReviewCoverageCategoryIdsFromPreflight(
    preflight: Record<string, unknown> | null | undefined,
    reviewType: string
): readonly string[] | undefined {
    if (!preflight || preflight.effective_review_snapshot === undefined) {
        return undefined;
    }
    const binding = resolveReviewContextLaneBinding(preflight, reviewType);
    return binding.built_in ? undefined : binding.coverage_category_ids;
}

export function isCustomReviewLaneInSnapshot(
    preflight: Record<string, unknown> | null | undefined,
    reviewType: string
): boolean {
    const snapshot = isPlainRecord(preflight?.effective_review_snapshot)
        ? preflight?.effective_review_snapshot as Record<string, unknown>
        : null;
    const lanes = Array.isArray(snapshot?.lanes) ? snapshot.lanes : [];
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const lane = lanes.find((candidate) => (
        isPlainRecord(candidate) && candidate.id === normalizedReviewType
    ));
    return isPlainRecord(lane)
        && isPlainRecord(lane.definition)
        && lane.definition.built_in === false;
}
