import { validateWorkflowConfig } from '../../schemas/config-artifacts-workflow';
import {
    buildDefaultWorkflowConfig, PROJECT_MEMORY_MAINTENANCE_MODES, PROJECT_MEMORY_READ_STRATEGIES
} from '../workflow-config';
import {
    createWorkflowSettingRegistry, type WorkflowSettingManifestEntry,
    type WorkflowSettingOption, type WorkflowSettingValue
} from '../workflow-setting-manifest';

type ProjectMemorySettingField = 'enabled' | 'mode' | 'run_before_final_closeout'
    | 'require_user_approval_for_writes' | 'max_compact_summary_chars' | 'read_strategy'
    | 'impact_artifact_retention_days';

interface ProjectMemorySettingDefinition {
    field: ProjectMemorySettingField;
    id: string;
    flag: `--${string}`;
    label: string;
    description: string;
    value_type: 'boolean' | 'enum' | 'integer';
    options: readonly WorkflowSettingOption[];
    min?: number;
    max?: number;
}

const workflowDefaults = buildDefaultWorkflowConfig();
const defaults = workflowDefaults.project_memory_maintenance;

function booleanOptions(onDescription: string, offDescription: string): readonly WorkflowSettingOption[] {
    return [
        { value: 'true', label: 'On', description: onDescription },
        { value: 'false', label: 'Off', description: offDescription }
    ];
}

const modePresentation = {
    off: { label: 'Off', description: 'Do not run project-memory maintenance during closeout.' },
    check: { label: 'Check', description: 'Check whether memory updates are needed without writing them.' },
    update: { label: 'Update', description: 'Allow the workflow to update focused project-memory files when needed.' },
    strict: { label: 'Strict', description: 'Require memory evidence before closeout can pass.' }
};

const definitions: readonly ProjectMemorySettingDefinition[] = [
    {
        id: 'project-memory-enabled', field: 'enabled', value_type: 'boolean',
        flag: '--project-memory-enabled',
        label: 'Project-memory maintenance',
        description: 'Controls whether closeout checks project-memory impact.',
        options: booleanOptions(
            'Closeout checks whether project-memory impact evidence is needed.',
            'Closeout does not run project-memory maintenance checks.'
        )
    },
    {
        id: 'project-memory-mode', field: 'mode', value_type: 'enum',
        flag: '--project-memory-mode',
        label: 'Project-memory mode',
        description: 'How strongly the workflow enforces project-memory impact work.',
        options: PROJECT_MEMORY_MAINTENANCE_MODES.map(value => ({ value, ...modePresentation[value] }))
    },
    {
        id: 'project-memory-run-before-final-closeout', field: 'run_before_final_closeout', value_type: 'boolean',
        flag: '--project-memory-run-before-final-closeout',
        label: 'Run memory check before final closeout',
        description: 'Runs project-memory maintenance before the final completion step.',
        options: booleanOptions(
            'Project-memory maintenance runs before the final completion step.',
            'Project-memory maintenance is not inserted before final closeout.'
        )
    },
    {
        id: 'project-memory-require-user-approval-for-writes', field: 'require_user_approval_for_writes', value_type: 'boolean',
        flag: '--project-memory-require-user-approval-for-writes',
        label: 'Require user approval for memory writes',
        description: 'Requires explicit user approval before the workflow writes project-memory files.',
        options: booleanOptions(
            'Project-memory writes require explicit user approval before the workflow writes files.',
            'Project-memory writes can proceed under the configured maintenance mode without an extra approval step.'
        )
    },
    {
        id: 'project-memory-max-compact-summary-chars', field: 'max_compact_summary_chars', value_type: 'integer',
        flag: '--project-memory-max-compact-summary-chars',
        label: 'Project-memory compact summary size',
        description: 'Maximum generated compact project-memory summary size, in characters.',
        min: 2000, max: 200000, options: []
    },
    {
        id: 'project-memory-read-strategy', field: 'read_strategy', value_type: 'enum',
        flag: '--project-memory-read-strategy',
        label: 'Project-memory read strategy',
        description: 'How agents should read durable memory at task start.',
        options: PROJECT_MEMORY_READ_STRATEGIES.map(value => ({
            value, label: value.replace(/_/gu, ' '),
            description: 'Read the memory index first and open detailed files only when the index points to them.'
        }))
    },
    {
        id: 'project-memory-impact-retention-days', field: 'impact_artifact_retention_days', value_type: 'integer',
        flag: '--project-memory-impact-artifact-retention-days',
        label: 'Project-memory impact retention',
        description: 'How many days project-memory impact artifacts are retained.',
        min: 1, max: 3650, options: []
    }
];

function canonicalFieldValue(field: ProjectMemorySettingField, value: unknown): WorkflowSettingValue {
    const validated = validateWorkflowConfig({
        ...workflowDefaults, project_memory_maintenance: { ...defaults, [field]: value }
    });
    const section = validated.project_memory_maintenance as Record<ProjectMemorySettingField, boolean | string | number>;
    return section[field];
}

function admitsTypedValue(definition: ProjectMemorySettingDefinition, value: unknown): value is WorkflowSettingValue {
    if (typeof value !== typeof defaults[definition.field]) return false;
    if (definition.value_type === 'integer'
        && (typeof value !== 'number' || !Number.isSafeInteger(value)
            || value < definition.min! || value > definition.max!)) return false;
    if (definition.value_type === 'enum' && !definition.options.some(option => option.value === value)) return false;
    try {
        return canonicalFieldValue(definition.field, value) === value;
    } catch {
        return false;
    }
}

function createEntry(definition: ProjectMemorySettingDefinition): WorkflowSettingManifestEntry {
    const key = `project_memory_maintenance.${definition.field}`;
    return {
        id: definition.id, key,
        owner: { kind: 'workflow', section: 'project-memory' },
        value_type: definition.value_type, exposure: 'operator-visible',
        default_value: defaults[definition.field],
        validate: (value): value is WorkflowSettingValue => admitsTypedValue(definition, value),
        cli: { flag: definition.flag },
        ui: {
            group: 'project-memory', label: definition.label, description: definition.description,
            control: definition.value_type === 'boolean' ? 'checkbox' : definition.value_type === 'integer' ? 'number' : 'select',
            options: definition.options,
            ...(definition.min !== undefined ? { min: definition.min } : {}),
            ...(definition.max !== undefined ? { max: definition.max } : {})
        },
        materialize: value => [{ path: key, value: canonicalFieldValue(definition.field, value) }]
    };
}

export const PROJECT_MEMORY_SETTING_REGISTRY = createWorkflowSettingRegistry(definitions.map(createEntry));
