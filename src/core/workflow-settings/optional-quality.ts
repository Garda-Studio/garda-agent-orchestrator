import { validateWorkflowConfig } from '../../schemas/config-artifacts-workflow';
import {
    buildDefaultWorkflowConfig, MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL
} from '../workflow-config';
import {
    createWorkflowSettingRegistry,
    type WorkflowSettingManifestEntry,
    type WorkflowSettingOption,
    type WorkflowSettingValue
} from '../workflow-setting-manifest';

type OptionalQualitySettingField = 'enabled' | 'review_failure_cadence_interval';

interface OptionalQualitySettingDefinition {
    field: OptionalQualitySettingField;
    id: string;
    label: string;
    description: string;
    flag: `--${string}`;
    value_type: 'boolean' | 'integer';
    options: readonly WorkflowSettingOption[];
    min?: number;
    max?: number;
}

const workflowDefaults = buildDefaultWorkflowConfig();
const defaults = workflowDefaults.optional_quality_checks;

const definitions: readonly OptionalQualitySettingDefinition[] = [
    {
        id: 'optional-checks-enabled',
        field: 'enabled',
        label: 'Optional quality checks',
        description: 'Controls whether advisory self-check rules run before expensive gates when next-step routes current implementation changes through quality-checklist. Rule edits below use the same audited workflow-setting path.',
        flag: '--optional-checks-enabled',
        value_type: 'boolean',
        options: [
            {
                value: 'true', label: 'On',
                description: 'Agents run the configured advisory self-check rules before compile, review, or full-suite work when checklist evidence is needed.'
            },
            {
                value: 'false', label: 'Off',
                description: 'The optional quality-checklist gate is skipped without replacing mandatory compile, review, or full-suite gates.'
            }
        ]
    },
    {
        id: 'optional-checks-review-failure-cadence-interval',
        field: 'review_failure_cadence_interval',
        label: 'Review failures between quality checks',
        description: 'Number of recorded review-failure attempts between required quality-checklist answer runs. The counter still advances only on recorded review FAIL results; repeated next-step or preflight refreshes do not advance it.',
        flag: '--optional-checks-review-failure-cadence-interval',
        value_type: 'integer',
        min: 1,
        max: MAX_OPTIONAL_QUALITY_CHECKS_REVIEW_FAILURE_CADENCE_INTERVAL,
        options: []
    }
];

function canonicalFieldValue(field: OptionalQualitySettingField, value: unknown): WorkflowSettingValue {
    const validated = validateWorkflowConfig({
        ...workflowDefaults, optional_quality_checks: { ...defaults, [field]: value }
    });
    const section = validated.optional_quality_checks as Record<OptionalQualitySettingField, boolean | number>;
    return section[field];
}

function admitsTypedValue(definition: OptionalQualitySettingDefinition, value: unknown): value is WorkflowSettingValue {
    if (typeof value !== typeof defaults[definition.field]
        || definition.value_type === 'integer' && !Number.isSafeInteger(value)) return false;
    try {
        canonicalFieldValue(definition.field, value);
        return true;
    } catch {
        return false;
    }
}

function createEntry(definition: OptionalQualitySettingDefinition): WorkflowSettingManifestEntry {
    const key = `optional_quality_checks.${definition.field}`;
    return {
        id: definition.id, key,
        owner: { kind: 'workflow', section: 'optional-quality-checks' },
        value_type: definition.value_type, exposure: 'operator-visible',
        default_value: defaults[definition.field],
        validate: (value): value is WorkflowSettingValue => admitsTypedValue(definition, value),
        cli: { flag: definition.flag },
        ui: {
            group: 'optional-quality-checks', label: definition.label, description: definition.description,
            control: definition.value_type === 'boolean' ? 'checkbox' : 'number',
            options: definition.options,
            ...(definition.min !== undefined ? { min: definition.min } : {}),
            ...(definition.max !== undefined ? { max: definition.max } : {})
        },
        materialize: value => [{ path: key, value: canonicalFieldValue(definition.field, value) }]
    };
}

export const OPTIONAL_QUALITY_SETTING_REGISTRY = createWorkflowSettingRegistry(definitions.map(createEntry));
