import { REVIEW_CYCLE_GUARD_ACTIONS, normalizeReviewCycleGuardConfig, type ReviewCycleGuardConfig } from '../review-cycle-guard';
import { buildDefaultWorkflowConfig } from '../workflow-config';
import { createWorkflowSettingRegistry, type WorkflowSettingManifestEntry } from '../workflow-setting-manifest';

export const EXCLUDED_REVIEW_TYPES_SETTING_DESCRIPTION =
    'Multiple choice: checked review types are excluded from review-cycle guard counting.';

const defaults = buildDefaultWorkflowConfig().review_cycle_guard;
const owner = { kind: 'workflow', section: 'review-cycle-guard' } as const;

function canonicalValue<T extends keyof ReviewCycleGuardConfig>(field: T, value: ReviewCycleGuardConfig[T]): ReviewCycleGuardConfig[T] {
    return normalizeReviewCycleGuardConfig({ ...defaults, [field]: value })[field];
}

function booleanEntry(
    field: 'enabled' | 'auto_split_enabled', label: string, description: string,
    onDescription: string, offDescription: string
): WorkflowSettingManifestEntry<'boolean'> {
    const id = `review-cycle-${field.replace(/_/gu, '-')}`;
    return {
        id, key: `review_cycle_guard.${field}`, owner, value_type: 'boolean',
        exposure: 'operator-visible', default_value: defaults[field],
        validate: (value): value is boolean => typeof value === 'boolean',
        cli: { flag: `--${id}` },
        ui: {
            group: owner.section, label, description, control: 'checkbox', options: [
                { value: 'true', label: 'On', description: onDescription },
                { value: 'false', label: 'Off', description: offDescription }
            ]
        },
        materialize: value => [{ path: `review_cycle_guard.${field}`, value: canonicalValue(field, value) }]
    };
}

const actionEntry: WorkflowSettingManifestEntry<'enum'> = {
    id: 'review-cycle-action', key: 'review_cycle_guard.action', owner, value_type: 'enum',
    exposure: 'operator-visible', default_value: defaults.action,
    validate: (value): value is ReviewCycleGuardConfig['action'] => typeof value === 'string'
        && REVIEW_CYCLE_GUARD_ACTIONS.some(action => action === value),
    cli: { flag: '--review-cycle-action' },
    ui: {
        group: owner.section, label: 'Review-cycle action',
        description: 'What happens when repeated review attempts exceed configured limits.',
        control: 'select', options: REVIEW_CYCLE_GUARD_ACTIONS.map(action => ({
            value: action,
            label: action === 'BLOCK_FOR_OPERATOR_DECISION' ? 'Block for operator decision' : 'Warn only',
            description: action === 'BLOCK_FOR_OPERATOR_DECISION'
                ? 'Stops repeated review loops until an operator chooses the recovery path.'
                : 'Reports review-cycle pressure but lets the workflow continue.'
        }))
    },
    materialize: value => [{ path: 'review_cycle_guard.action', value: canonicalValue('action', value as ReviewCycleGuardConfig['action']) }]
};

function limitEntry(
    field: 'max_failed_non_test_reviews' | 'max_total_non_test_reviews', label: string, description: string
): WorkflowSettingManifestEntry<'integer'> {
    const id = `review-cycle-${field.replace(/_/gu, '-')}`;
    return {
        id, key: `review_cycle_guard.${field}`, owner, value_type: 'integer',
        exposure: 'operator-visible', default_value: defaults[field],
        validate: (value): value is number => typeof value === 'number' && Number.isSafeInteger(value)
            && value >= 1 && value <= 1000 && canonicalValue(field, value) === value,
        cli: { flag: `--${id}` },
        ui: { group: owner.section, label, description, control: 'number', min: 1, max: 1000, options: [] },
        materialize: value => [{ path: `review_cycle_guard.${field}`, value: canonicalValue(field, value) }]
    };
}

const excludedTypesEntry: WorkflowSettingManifestEntry<'enum_list'> = {
    id: 'review-cycle-excluded-review-types', key: 'review_cycle_guard.excluded_review_types',
    owner, value_type: 'enum_list', exposure: 'operator-visible', default_value: defaults.excluded_review_types,
    validate: (value): value is readonly string[] => Array.isArray(value)
        && Array.from(value).every(entry => typeof entry === 'string'),
    cli: { flag: '--review-cycle-excluded-review-types' },
    ui: {
        group: owner.section, label: 'Excluded review types', description: EXCLUDED_REVIEW_TYPES_SETTING_DESCRIPTION,
        control: 'select', options: [], placeholder: 'test'
    },
    materialize: value => [{ path: 'review_cycle_guard.excluded_review_types',
        value: Object.freeze(canonicalValue('excluded_review_types', [...value])) }]
};

export const REVIEW_CYCLE_SETTING_REGISTRY = createWorkflowSettingRegistry([
    booleanEntry('enabled', 'Review-cycle guard',
        'Detects repeated non-test review loops before they consume too much work.',
        'Repeated non-test review loops are detected before closeout continues.',
        'Review-cycle pressure is not checked by this guard.'),
    actionEntry,
    limitEntry('max_failed_non_test_reviews', 'Failed non-test review limit',
        'Maximum failed non-test review attempts before the review-cycle guard reacts.'),
    limitEntry('max_total_non_test_reviews', 'Total non-test review limit',
        'Maximum total non-test review attempts before the review-cycle guard reacts.'),
    excludedTypesEntry,
    booleanEntry('auto_split_enabled', 'Automatic review-cycle split prompt',
        'Allows review-cycle pressure to emit an auto-split prompt when the action is BLOCK_FOR_OPERATOR_DECISION. It has no blocking effect while action is WARN_ONLY.',
        'Review-cycle pressure can emit the auto-split prompt when the action is BLOCK_FOR_OPERATOR_DECISION.',
        'Review-cycle pressure never emits the auto-split prompt.')
]);
