import { buildWorkflowSettingMetadata } from '../core/workflow-setting-metadata';
import { WORKFLOW_SETTING_REGISTRY } from '../core/workflow-settings/registry';
import { compactSettingMinimum, compactSettingMaximum } from '../core/compact/setting-definitions';
import { CANONICAL_OPTIONAL_SKILL_SELECTION_POLICY_MODES } from '../runtime/optional-skill-selection';

export type WorkflowSettingValueType = 'boolean' | 'enum' | 'enum_list' | 'integer' | 'string' | 'string_list';

export interface WorkflowSettingOption {
    value: string;
    label: string;
    description: string;
}

export interface WorkflowSettingDefinition {
    id: string;
    key: string;
    label: string;
    description: string;
    flag: string;
    value_type: WorkflowSettingValueType;
    options: WorkflowSettingOption[];
    min?: number;
    max?: number;
    placeholder?: string;
    editable?: boolean;
}

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

const canonicalOptionalSkillSelectionPolicyOptions: WorkflowSettingOption[] = CANONICAL_OPTIONAL_SKILL_SELECTION_POLICY_MODES.map((mode) => {
    switch (mode) {
        case 'off':
            return {
                value: mode,
                label: 'Off',
                description: 'Do not suggest or require specialist skills at task start.'
            };
        case 'mandatory':
            return {
                value: mode,
                label: 'Mandatory',
                description: 'Require a selected installed optional or custom live specialist skill before implementation starts when policy matching selects one.'
            };
        default:
            return {
                value: mode,
                label: 'Optional',
                description: 'Show installed optional, custom live specialist-skill, and recommended pack suggestions without blocking ordinary task work.'
            };
    }
});

const legacyOptionalSkillSelectionPolicyOptions: WorkflowSettingOption[] = [
    {
        value: 'advisory',
        label: 'Legacy: advisory -> optional',
        description: 'Compatibility alias for optional; saving rewrites this value to optional.'
    },
    {
        value: 'required',
        label: 'Legacy: required -> mandatory',
        description: 'Compatibility alias for mandatory; saving rewrites this value to mandatory.'
    },
    {
        value: 'strict',
        label: 'Legacy: strict -> mandatory',
        description: 'Compatibility alias for mandatory; saving rewrites this value to mandatory.'
    }
];

const optionalSkillSelectionPolicyOptions: WorkflowSettingOption[] = [
    ...canonicalOptionalSkillSelectionPolicyOptions,
    ...legacyOptionalSkillSelectionPolicyOptions
];

const optionalSkillSelectionDefinition: WorkflowSettingDefinition = {
    id: 'optional-skill-selection-mode',
    key: 'optional_skill_selection_policy.mode',
    label: 'Specialist-skill selection mode',
    description: 'Controls whether task start keeps installed optional and custom live specialist-skill matching off, optional, or mandatory. Legacy advisory/required/strict values remain read-compatible and are rewritten to canonical modes when saved.',
    flag: '--optional-skill-selection-mode',
    value_type: 'enum',
    options: optionalSkillSelectionPolicyOptions
};

function decorateCompactPresentation(definition: WorkflowSettingDefinition): WorkflowSettingDefinition {
    const entry = WORKFLOW_SETTING_REGISTRY.require(definition.id);
    if (entry.owner.kind !== 'workflow' || entry.owner.section !== 'compact') return definition;
    return {
        ...definition,
        options: entry.value_type === 'boolean'
            ? booleanOptions('Enabled for compact inspections.', 'Disabled for compact inspections.') : [],
        ...(entry.value_type === 'integer'
            ? { min: compactSettingMinimum(entry.id), max: compactSettingMaximum(entry.id) } : {})
    };
}

export const WORKFLOW_SETTING_DEFINITIONS: readonly WorkflowSettingDefinition[] = Object.freeze(
    buildWorkflowSettingMetadata(WORKFLOW_SETTING_REGISTRY).flatMap(definition => {
        const compatible = decorateCompactPresentation(definition);
        return definition.id === 'optional-checks-review-failure-cadence-interval'
            ? [compatible, optionalSkillSelectionDefinition] : [compatible];
    })
);

export function getWorkflowSettingDefinition(key: string): WorkflowSettingDefinition | null {
    return WORKFLOW_SETTING_DEFINITIONS.find((definition) => definition.key === key) || null;
}
