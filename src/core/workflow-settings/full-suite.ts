import { validateWorkflowConfig } from '../../schemas/config-artifacts-workflow';
import { OUT_OF_SCOPE_FAILURE_POLICIES } from '../full-suite-validation-config';
import {
    buildDefaultWorkflowConfig, FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX, FULL_SUITE_VALIDATION_PLACEMENTS
} from '../workflow-config';
import {
    createWorkflowSettingRegistry,
    type WorkflowSettingManifestEntry,
    type WorkflowSettingOption,
    type WorkflowSettingValue,
    type WorkflowSettingValueType
} from '../workflow-setting-manifest';

type FullSuiteSettingField =
    | 'enabled' | 'command' | 'timeout_ms' | 'timeout_blocker' | 'timeout_retry_count'
    | 'green_summary_max_lines' | 'red_failure_chunk_lines' | 'out_of_scope_failure_policy' | 'placement';

interface FullSuiteSettingDefinition {
    field: FullSuiteSettingField;
    id: string;
    label: string;
    description: string;
    flag: `--${string}`;
    value_type: Exclude<WorkflowSettingValueType, 'enum_list' | 'string_list'>;
    options: readonly WorkflowSettingOption[];
    min?: number;
    max?: number;
    placeholder?: string;
}

const defaults = buildDefaultWorkflowConfig().full_suite_validation;

function booleanOptions(onDescription: string, offDescription: string): WorkflowSettingOption[] {
    return [
        {
            value: 'true',
            label: 'On',
            description: onDescription
        },
        {
            value: 'false',
            label: 'Off',
            description: offDescription
        }
    ];
}

const fullSuitePlacementOptions: WorkflowSettingOption[] = FULL_SUITE_VALIDATION_PLACEMENTS.map((placement) => {
    switch (placement) {
        case 'after_compile_before_reviews':
            return {
                value: placement,
                label: 'After compile, before reviews',
                description: 'Runs the full suite after compile passes and before reviewer work starts.'
            };
        case 'before_test_review':
            return {
                value: placement,
                label: 'Before test review',
                description: 'Runs the full suite immediately before the test-review lane needs its evidence.'
            };
        case 'before_completion':
            return {
                value: placement,
                label: 'Before completion',
                description: 'Defers the full suite until the final completion path.'
            };
        default:
            return {
                value: placement,
                label: placement,
                description: 'Full-suite placement mode.'
            };
    }
});

const outOfScopeFailurePolicyOptions: WorkflowSettingOption[] = OUT_OF_SCOPE_FAILURE_POLICIES.map((policy) => {
    switch (policy) {
        case 'AUDIT_AND_BLOCK':
            return {
                value: policy,
                label: 'Audit and block',
                description: 'Records the out-of-scope failure and stops the workflow until it is resolved.'
            };
        case 'AUDIT_AND_WARN':
            return {
                value: policy,
                label: 'Audit and warn',
                description: 'Records the out-of-scope failure but allows the workflow to continue with a warning.'
            };
        default:
            return {
                value: policy,
                label: policy,
                description: 'Out-of-scope failure policy.'
            };
    }
});

const definitions: readonly FullSuiteSettingDefinition[] = [
    {
        id: 'full-suite-enabled',
        field: 'enabled',
        label: 'Mandatory full-suite validation',
        description: 'Controls whether the configured full-suite test command is part of the task lifecycle.',
        flag: '--full-suite-enabled',
        value_type: 'boolean',
        options: booleanOptions(
            'The configured full-suite command is required in the task lifecycle.',
            'The full-suite gate is skipped unless another workflow path requires it.'
        )
    },
    {
        id: 'full-suite-command',
        field: 'command',
        label: 'Full-suite command',
        description: 'Command the full-suite gate runs when mandatory full-suite validation is enabled. Local UI edits use the same audited `garda workflow set` path and require explicit confirmation.',
        flag: '--full-suite-command',
        value_type: 'string',
        options: [],
        placeholder: 'npm test'
    },
    {
        id: 'full-suite-timeout-ms',
        field: 'timeout_ms',
        label: 'Full-suite timeout',
        description: 'Maximum runtime for the full-suite command, in milliseconds.',
        flag: '--full-suite-timeout-ms',
        value_type: 'integer',
        min: 1000,
        max: 86_400_000,
        options: []
    },
    {
        id: 'full-suite-timeout-blocker',
        field: 'timeout_blocker',
        label: 'Full-suite timeout blocker',
        description: 'Controls whether repeated full-suite timeouts block the task and propose a repair task, or continue as a final warning.',
        flag: '--full-suite-timeout-blocker',
        value_type: 'boolean',
        options: booleanOptions(
            'Repeated full-suite timeouts block task completion and propose a repair task.',
            'Repeated full-suite timeouts are reported as a warning and do not block completion.'
        )
    },
    {
        id: 'full-suite-timeout-retry-count',
        field: 'timeout_retry_count',
        label: 'Full-suite timeout retries',
        description: 'How many times the full-suite command is retried after a timeout before timeout policy is applied.',
        flag: '--full-suite-timeout-retry-count',
        value_type: 'integer',
        min: 0,
        max: FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX,
        options: []
    },
    {
        id: 'full-suite-green-summary-max-lines',
        field: 'green_summary_max_lines',
        label: 'Green full-suite summary length',
        description: 'How many successful full-suite output lines stay visible in compact task evidence.',
        flag: '--full-suite-green-summary-max-lines',
        value_type: 'integer',
        min: 1,
        max: 200,
        options: []
    },
    {
        id: 'full-suite-red-failure-chunk-lines',
        field: 'red_failure_chunk_lines',
        label: 'Failure output chunk length',
        description: 'How many failing full-suite lines are kept per compact failure chunk.',
        flag: '--full-suite-red-failure-chunk-lines',
        value_type: 'integer',
        min: 10,
        max: 1000,
        options: []
    },
    {
        id: 'full-suite-out-of-scope-failure-policy',
        field: 'out_of_scope_failure_policy',
        label: 'Out-of-scope failure handling',
        description: 'What the workflow does when full-suite output shows a failure outside the current task scope.',
        flag: '--full-suite-out-of-scope-failure-policy',
        value_type: 'enum',
        options: outOfScopeFailurePolicyOptions
    },
    {
        id: 'full-suite-placement',
        field: 'placement',
        label: 'Full-suite placement',
        description: 'Where the mandatory full-suite gate runs in the task lifecycle.',
        flag: '--full-suite-placement',
        value_type: 'enum',
        options: fullSuitePlacementOptions
    },
];

function canonicalFieldValue(field: FullSuiteSettingField, value: unknown): WorkflowSettingValue {
    const validated = validateWorkflowConfig({ full_suite_validation: { ...defaults, [field]: value } });
    const section = validated.full_suite_validation as Record<FullSuiteSettingField, WorkflowSettingValue>;
    return section[field];
}

function admitsTypedValue(definition: FullSuiteSettingDefinition, value: unknown): value is WorkflowSettingValue {
    if (typeof value !== typeof defaults[definition.field]
        || definition.value_type === 'integer' && !Number.isSafeInteger(value)) return false;
    try {
        canonicalFieldValue(definition.field, value);
        return true;
    } catch {
        return false;
    }
}

function createEntry(definition: FullSuiteSettingDefinition): WorkflowSettingManifestEntry {
    const key = `full_suite_validation.${definition.field}`;
    return {
        id: definition.id, key,
        owner: { kind: 'workflow', section: 'full-suite-validation' },
        value_type: definition.value_type, exposure: 'operator-visible',
        default_value: defaults[definition.field],
        validate: (value): value is WorkflowSettingValue => admitsTypedValue(definition, value),
        cli: { flag: definition.flag },
        ui: {
            group: 'full-suite', label: definition.label, description: definition.description,
            control: definition.value_type === 'boolean' ? 'checkbox'
                : definition.value_type === 'integer' ? 'number'
                    : definition.value_type === 'enum' ? 'select' : 'text',
            options: definition.options,
            ...(definition.min !== undefined ? { min: definition.min } : {}),
            ...(definition.max !== undefined ? { max: definition.max } : {}),
            ...(definition.placeholder !== undefined ? { placeholder: definition.placeholder } : {})
        },
        materialize: value => [{ path: key, value: canonicalFieldValue(definition.field, value) }]
    };
}

export const FULL_SUITE_SETTING_REGISTRY = createWorkflowSettingRegistry(definitions.map(createEntry));
