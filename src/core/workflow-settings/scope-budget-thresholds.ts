import { normalizeScopeBudgetGuardConfig } from '../scope-budget-guard';
import { buildDefaultWorkflowConfig } from '../workflow-config';
import { createWorkflowSettingRegistry, type WorkflowSettingManifestEntry } from '../workflow-setting-manifest';

type LegacyMaximumField = 'max_files' | 'max_changed_lines' | 'max_required_reviews' | 'max_review_tokens';

interface LegacyMaximumDefinition {
    field: LegacyMaximumField;
    id: string;
    label: string;
    description: string;
    flag: `--${string}`;
    maximum: number;
}

const MINIMUM_LEGACY_MAXIMUM = 1;
const defaults = buildDefaultWorkflowConfig().scope_budget_guard;
const definitions: readonly LegacyMaximumDefinition[] = [
    {
        field: 'max_files', id: 'scope-budget-max-files',
        label: 'Scope budget file limit',
        description: 'Maximum changed-file count before the scope budget guard reacts.',
        flag: '--scope-budget-max-files', maximum: 10000
    },
    {
        field: 'max_changed_lines', id: 'scope-budget-max-changed-lines',
        label: 'Scope budget changed-line limit',
        description: 'Maximum changed-line count before the scope budget guard reacts.',
        flag: '--scope-budget-max-changed-lines', maximum: 1_000_000
    },
    {
        field: 'max_required_reviews', id: 'scope-budget-max-required-reviews',
        label: 'Mandatory review type limit',
        description: 'Maximum number of distinct review types required by the current preflight before the scope budget guard reacts. Disabled review capabilities do not become mandatory just because matching files changed; this counts review types, not reviewers, attempts, or review cycles.',
        flag: '--scope-budget-max-required-reviews', maximum: 100
    },
    {
        field: 'max_review_tokens', id: 'scope-budget-max-review-tokens',
        label: 'Scope budget review-token forecast',
        description: 'Maximum estimated review-token budget before the scope budget guard reacts.',
        flag: '--scope-budget-max-review-tokens', maximum: 10_000_000
    }
];

function canonicalValue(field: LegacyMaximumField, value: number): number {
    return normalizeScopeBudgetGuardConfig({ ...defaults, [field]: value })[field];
}

function admitsValue(definition: LegacyMaximumDefinition, value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value)
        && value >= MINIMUM_LEGACY_MAXIMUM && value <= definition.maximum
        && canonicalValue(definition.field, value) === value;
}

function createEntry(definition: LegacyMaximumDefinition): WorkflowSettingManifestEntry<'integer'> {
    const key = `scope_budget_guard.${definition.field}`;
    return {
        id: definition.id, key,
        owner: { kind: 'workflow', section: 'scope-budget-guard' },
        value_type: 'integer', exposure: 'operator-visible',
        default_value: defaults[definition.field],
        validate: (value): value is number => admitsValue(definition, value),
        cli: { flag: definition.flag },
        ui: {
            group: 'scope-budget-guard', label: definition.label, description: definition.description,
            control: 'number', options: [], min: MINIMUM_LEGACY_MAXIMUM, max: definition.maximum
        },
        materialize: value => [{ path: key, value: canonicalValue(definition.field, value) }]
    };
}

export const SCOPE_BUDGET_THRESHOLD_SETTING_REGISTRY = createWorkflowSettingRegistry(definitions.map(createEntry));
