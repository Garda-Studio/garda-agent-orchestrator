import { validateWorkflowConfig } from '../../schemas/config-artifacts-workflow';
import { buildDefaultWorkflowConfig } from '../workflow-config';
import {
    createWorkflowSettingRegistry, type WorkflowSettingManifestEntry,
    type WorkflowSettingOption, type WorkflowSettingValue
} from '../workflow-setting-manifest';

type ProtectedControlSection = 'task_reset' | 'local_commit' | 'orchestrator_work_policy';

interface ProtectedControlDefinition {
    section: ProtectedControlSection;
    field: 'enabled' | 'mode';
    id: string;
    flag: `--${string}`;
    label: string;
    description: string;
    value_type: 'boolean' | 'enum';
    options: readonly WorkflowSettingOption[];
    editable?: boolean;
}

const workflowDefaults = buildDefaultWorkflowConfig();

function booleanOptions(onDescription: string, offDescription: string): readonly WorkflowSettingOption[] {
    return [
        { value: 'true', label: 'On', description: onDescription },
        { value: 'false', label: 'Off', description: offDescription }
    ];
}

const definitions: readonly ProtectedControlDefinition[] = [
    {
        id: 'task-reset-enabled', section: 'task_reset', field: 'enabled', value_type: 'boolean',
        flag: '--task-reset-enabled', label: 'Task reset commands',
        description: 'Allows confirmed task reset/discard mutations.',
        options: booleanOptions(
            'Confirmed task reset and discard commands are available through guarded paths.',
            'Task reset and discard mutations are unavailable.'
        )
    },
    {
        id: 'local-commit-enabled', section: 'local_commit', field: 'enabled', value_type: 'boolean',
        flag: '--local-commit-enabled', label: 'Local commit permission',
        description: 'An explicit audited ON grants this workspace durable permission to commit completed and audited task scope. OFF revokes it. Reviews, tests and post-commit audit remain required; no push or CI permission is granted.',
        options: booleanOptions(
            'Allow native commits of completed and audited task scope in this workspace.',
            'Block native local commits and revoke earlier grants.'
        )
    },
    {
        id: 'garda-self-guard', section: 'orchestrator_work_policy', field: 'mode', value_type: 'enum',
        flag: '--garda-self-guard', label: 'Garda self-guard', editable: false,
        description: 'Controls whether agents may directly enter protected Garda control-plane work.',
        options: [
            {
                value: 'deny_agent_entry', label: 'On',
                description: 'Agents cannot enter protected control-plane work without the operator-owned path.'
            },
            {
                value: 'require_operator_confirmation', label: 'Operator confirmation',
                description: 'Protected control-plane entry requires explicit operator confirmation.'
            }
        ]
    }
];

function defaultValue(definition: ProtectedControlDefinition): boolean | string {
    const section = workflowDefaults[definition.section] as Record<string, boolean | string>;
    return section[definition.field];
}

function canonicalValue(definition: ProtectedControlDefinition, value: unknown): boolean | string {
    const validated = validateWorkflowConfig({
        ...workflowDefaults,
        [definition.section]: { ...workflowDefaults[definition.section], [definition.field]: value }
    });
    const section = validated[definition.section] as Record<string, boolean | string>;
    return section[definition.field];
}

function admitsTypedValue(definition: ProtectedControlDefinition, value: unknown): value is WorkflowSettingValue {
    if (typeof value !== typeof defaultValue(definition)) return false;
    try { return canonicalValue(definition, value) === value; }
    catch { return false; }
}

function createEntry(definition: ProtectedControlDefinition): WorkflowSettingManifestEntry {
    const key = `${definition.section}.${definition.field}`;
    return {
        id: definition.id, key,
        owner: { kind: 'workflow', section: definition.section.replace(/_/gu, '-') },
        value_type: definition.value_type, exposure: 'operator-visible', default_value: defaultValue(definition),
        validate: (value): value is WorkflowSettingValue => admitsTypedValue(definition, value),
        cli: { flag: definition.flag },
        ui: {
            group: 'protected-controls', label: definition.label, description: definition.description,
            control: definition.value_type === 'boolean' ? 'checkbox' : 'select', options: definition.options,
            ...(definition.editable !== undefined ? { editable: definition.editable } : {})
        },
        materialize: value => [{ path: key, value: canonicalValue(definition, value) }]
    };
}

export const PROTECTED_CONTROL_SETTING_REGISTRY = createWorkflowSettingRegistry(definitions.map(createEntry));
