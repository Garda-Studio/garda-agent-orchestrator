import type { WorkflowSettingOption, WorkflowSettingRegistry, WorkflowSettingValueType } from './workflow-setting-manifest';

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

export function buildWorkflowSettingMetadata(
    registry: WorkflowSettingRegistry
): readonly WorkflowSettingDefinition[] {
    return Object.freeze(registry.entries.map(entry => {
        const ui = entry.ui;
        const editable = entry.owner.kind === 'workflow' ? ui.editable : false;
        return {
            id: entry.id,
            key: entry.key,
            label: ui.label,
            description: ui.description,
            flag: entry.cli.flag,
            value_type: entry.value_type,
            options: (ui.options ?? []).map(option => ({
                value: option.value, label: option.label, description: option.description
            })),
            ...(ui.min !== undefined ? { min: ui.min } : {}),
            ...(ui.max !== undefined ? { max: ui.max } : {}),
            ...(ui.placeholder !== undefined ? { placeholder: ui.placeholder } : {}),
            ...(editable !== undefined ? { editable } : {})
        };
    }));
}
