import { SCOPE_BUDGET_GUARD_ACTIONS, normalizeScopeBudgetGuardConfig, type ScopeBudgetGuardConfig } from '../scope-budget-guard';
import { buildDefaultWorkflowConfig } from '../workflow-config';
import { createWorkflowSettingRegistry, type WorkflowSettingManifestEntry } from '../workflow-setting-manifest';

type ThresholdField = 'warn_files' | 'block_files' | 'warn_changed_lines' | 'block_changed_lines'
    | 'warn_required_reviews' | 'block_required_reviews' | 'warn_review_tokens' | 'block_review_tokens';

interface ThresholdDefinition {
    field: ThresholdField;
    label: string;
    description: string;
    minimum: number;
    maximum: number;
}

const defaults = buildDefaultWorkflowConfig().scope_budget_guard;
const owner = { kind: 'workflow', section: 'scope-budget-guard' } as const;

function canonicalValue<T extends keyof ScopeBudgetGuardConfig>(field: T, value: ScopeBudgetGuardConfig[T]): ScopeBudgetGuardConfig[T] {
    return normalizeScopeBudgetGuardConfig({ ...defaults, [field]: value })[field];
}

const enabledEntry: WorkflowSettingManifestEntry<'boolean'> = {
    id: 'scope-budget-enabled', key: 'scope_budget_guard.enabled',
    owner, value_type: 'boolean', exposure: 'operator-visible', default_value: defaults.enabled,
    validate: (value): value is boolean => typeof value === 'boolean',
    cli: { flag: '--scope-budget-enabled' },
    ui: {
        group: owner.section, label: 'Scope budget guard',
        description: 'Warns or blocks when a task is too large for the configured profile budget.',
        control: 'checkbox', options: [
            { value: 'true', label: 'On', description: 'Scope budget checks warn or block when a task exceeds the configured profile budget.' },
            { value: 'false', label: 'Off', description: 'Scope budget limits are not enforced for task-size decisions.' }
        ]
    },
    materialize: value => [{ path: 'scope_budget_guard.enabled', value: canonicalValue('enabled', value) }]
};

const actionEntry: WorkflowSettingManifestEntry<'enum'> = {
    id: 'scope-budget-action', key: 'scope_budget_guard.action',
    owner, value_type: 'enum', exposure: 'operator-visible', default_value: defaults.action,
    validate: (value): value is ScopeBudgetGuardConfig['action'] => typeof value === 'string'
        && SCOPE_BUDGET_GUARD_ACTIONS.some(action => action === value),
    cli: { flag: '--scope-budget-action' },
    ui: {
        group: owner.section, label: 'Legacy max mapping mode',
        description: 'Compatibility-only mode for old max_* thresholds. It does not disable blocking: explicit block_* thresholds still produce BLOCK and route to split-required.',
        control: 'select', editable: false,
        options: SCOPE_BUDGET_GUARD_ACTIONS.map(action => ({
            value: action,
            label: action === 'BLOCK_FOR_SPLIT' ? 'Legacy max maps to block' : 'Legacy max maps to warn',
            description: action === 'BLOCK_FOR_SPLIT'
                ? 'Compatibility mode for legacy max_* values: max_* is interpreted as the blocking threshold. Explicit block_* thresholds still block in every mode.'
                : 'Compatibility mode for legacy max_* values: max_* is interpreted as the warning threshold. Explicit block_* thresholds still block in every mode.'
        }))
    },
    materialize: value => [{ path: 'scope_budget_guard.action', value: canonicalValue('action', value as ScopeBudgetGuardConfig['action']) }]
};

const profilesEntry: WorkflowSettingManifestEntry<'enum_list'> = {
    id: 'scope-budget-profiles', key: 'scope_budget_guard.profiles',
    owner, value_type: 'enum_list', exposure: 'operator-visible', default_value: defaults.profiles,
    validate: (value): value is readonly string[] => Array.isArray(value)
        && Array.from(value).every(profile => typeof profile === 'string'),
    cli: { flag: '--scope-budget-profiles' },
    ui: {
        group: owner.section, label: 'Scope budget profiles',
        description: 'Task profiles where the scope budget guard applies. Unknown legacy values are shown explicitly instead of being dropped.',
        control: 'select', options: [], placeholder: 'strict,balanced'
    },
    materialize: value => [{ path: 'scope_budget_guard.profiles', value: Object.freeze(canonicalValue('profiles', [...value])) }]
};

const thresholds: readonly ThresholdDefinition[] = [
    {
        field: 'warn_files', label: 'Scope budget file warning',
        description: 'Changed-file count above this value is reported as WARN and continuation remains allowed. Must stay lower than the blocking threshold.',
        minimum: 1, maximum: 10000
    },
    {
        field: 'block_files', label: 'Scope budget file block',
        description: 'Changed-file count above this value is reported as BLOCK and next-step routes to split-required.',
        minimum: 2, maximum: 10000
    },
    {
        field: 'warn_changed_lines', label: 'Scope budget changed-line warning',
        description: 'Changed-line count above this value is reported as WARN and continuation remains allowed. Must stay lower than the blocking threshold.',
        minimum: 1, maximum: 1_000_000
    },
    {
        field: 'block_changed_lines', label: 'Scope budget changed-line block',
        description: 'Changed-line count above this value is reported as BLOCK and next-step routes to split-required.',
        minimum: 2, maximum: 1_000_000
    },
    {
        field: 'warn_required_reviews', label: 'Mandatory review type warning',
        description: 'Distinct required review type count above this value is reported as WARN. Disabled review capabilities do not become mandatory just because matching files changed; this counts review types, not reviewers, attempts, or review cycles.',
        minimum: 1, maximum: 100
    },
    {
        field: 'block_required_reviews', label: 'Mandatory review type block',
        description: 'Distinct required review type count above this value is reported as BLOCK and next-step routes to split-required.',
        minimum: 2, maximum: 100
    },
    {
        field: 'warn_review_tokens', label: 'Review-token forecast warning',
        description: 'Estimated review-token budget above this value is reported as WARN and continuation remains allowed.',
        minimum: 1, maximum: 10_000_000
    },
    {
        field: 'block_review_tokens', label: 'Review-token forecast block',
        description: 'Estimated review-token budget above this value is reported as BLOCK and next-step routes to split-required.',
        minimum: 2, maximum: 10_000_000
    },
];

function admitsThreshold(definition: ThresholdDefinition, value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value)
        && value >= definition.minimum && value <= definition.maximum
        && canonicalValue(definition.field, value) === value;
}

function createThresholdEntry(definition: ThresholdDefinition): WorkflowSettingManifestEntry<'integer'> {
    const id = `scope-budget-${definition.field.replace(/_/gu, '-')}`;
    const key = `scope_budget_guard.${definition.field}`;
    return {
        id, key, owner, value_type: 'integer', exposure: 'operator-visible',
        default_value: defaults[definition.field],
        validate: (value): value is number => admitsThreshold(definition, value),
        cli: { flag: `--${id}` },
        ui: {
            group: owner.section, label: definition.label, description: definition.description,
            control: 'number', options: [], min: definition.minimum, max: definition.maximum
        },
        materialize: value => [{ path: key, value: canonicalValue(definition.field, value) }]
    };
}

export const SCOPE_BUDGET_CONTROL_SETTING_REGISTRY = createWorkflowSettingRegistry([
    enabledEntry, actionEntry, profilesEntry, ...thresholds.map(createThresholdEntry)
]);
