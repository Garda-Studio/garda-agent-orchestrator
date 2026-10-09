export const KNOWN_REVIEW_TYPE_IDS = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
] as const);

export type KnownReviewTypeId = typeof KNOWN_REVIEW_TYPE_IDS[number];

export const EXCLUDED_REVIEW_TYPE_SETTING_ID = 'review-cycle-excluded-review-types';

const KNOWN_REVIEW_TYPE_LABELS: Readonly<Record<KnownReviewTypeId, string>> = Object.freeze({
    code: 'Code review',
    db: 'Database review',
    security: 'Security review',
    refactor: 'Refactor review',
    api: 'API review',
    test: 'Test review',
    performance: 'Performance review',
    infra: 'Infrastructure review',
    dependency: 'Dependency review'
});

export { EXCLUDED_REVIEW_TYPES_SETTING_DESCRIPTION } from '../core/workflow-settings/review-cycle';

export const EXCLUDED_REVIEW_TYPE_LEGACY_OPTION_DESCRIPTION =
    'Unknown legacy review type preserved from the current config.';

export function getKnownReviewTypeLabel(reviewType: string): string {
    const normalized = reviewType.trim().toLowerCase();
    return KNOWN_REVIEW_TYPE_LABELS[normalized as KnownReviewTypeId] || reviewType;
}

export function isKnownReviewTypeId(reviewType: string): reviewType is KnownReviewTypeId {
    return (KNOWN_REVIEW_TYPE_IDS as readonly string[]).includes(reviewType.trim().toLowerCase());
}
