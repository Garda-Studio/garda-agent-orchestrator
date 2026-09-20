import { createWorkflowSettingRegistry, type WorkflowSettingManifestEntry } from '../workflow-setting-manifest';
import { DEFAULT_COMPACT_SETTINGS, validateCompactSettings, type CompactSettings } from './contract';

const FIELDS = [
    ['enabled', 'enabled', 'Compact output', 'Use bounded inspection output with selective retrieval.'],
    ['git', 'git', 'Compact Git', 'Allow the shipped Git status and scoped diff adapter.'],
    ['file', 'file', 'Compact files', 'Allow the shipped source file inspection adapter.'],
    ['rg', 'rg', 'Compact search', 'Allow the shipped repository search adapter.'],
    ['previewLines', 'preview_lines', 'Preview lines', 'Maximum preview lines per stream.'],
    ['previewChars', 'preview_chars', 'Preview characters', 'Maximum preview characters per stream.'],
    ['runBytes', 'run_bytes', 'Capture byte limit', 'Maximum bytes per capture including metadata.'],
    ['taskBytes', 'task_bytes', 'Task cache byte limit', 'Maximum compact cache bytes per task.'],
    ['workspaceBytes', 'workspace_bytes', 'Workspace cache byte limit', 'Maximum compact cache bytes in this workspace.'],
    ['maxRuns', 'max_runs', 'Capture count limit', 'Maximum number of retained captures in this workspace.']
] as const;

export function compactSettingMinimum(id: string): number {
    return id === 'compact-preview-lines' ? 3 : id === 'compact-preview-chars' ? 128
        : ['compact-run-bytes', 'compact-task-bytes', 'compact-workspace-bytes'].includes(id) ? 9216 : 1;
}

export const COMPACT_SETTING_REGISTRY = createWorkflowSettingRegistry(FIELDS.map(([internal, key, label, description]): WorkflowSettingManifestEntry => {
    const value = DEFAULT_COMPACT_SETTINGS[internal];
    const boolean = typeof value === 'boolean';
    return {
        id: `compact-${key.replace(/_/g, '-')}`, key: `compact.${key}`, owner: { kind: 'workflow', section: 'compact' },
        value_type: boolean ? 'boolean' : 'integer', exposure: 'operator-visible', default_value: value,
        validate: (candidate): candidate is boolean | number => boolean ? typeof candidate === 'boolean' : Number.isSafeInteger(candidate) && Number(candidate) >= compactSettingMinimum(`compact-${key.replace(/_/g, '-')}`) && Number(candidate) <= Number(value),
        cli: { flag: `--compact-${key.replace(/_/g, '-')}` },
        ui: { group: 'compact', label, description, control: boolean ? 'checkbox' : 'number' },
        materialize: candidate => [{ path: `compact.${key}`, value: candidate }]
    };
}));

export const COMPACT_CLI_OPTIONS = Object.fromEntries(COMPACT_SETTING_REGISTRY.entries.map(entry => [entry.cli.flag, { key: entry.id, type: 'string' as const }]));

export function compactSettingsToConfig(settings: Readonly<CompactSettings> = DEFAULT_COMPACT_SETTINGS): Record<string, boolean | number> {
    return Object.fromEntries(FIELDS.map(([internal, key]) => [key, settings[internal]]));
}

export function compactSettingsFromConfig(input: unknown): CompactSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid compact configuration.');
    const internal: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        const field = FIELDS.find(entry => entry[1] === key);
        if (!field) throw new Error(`Unknown compact setting: ${key}`);
        internal[field[0]] = value;
    }
    return validateCompactSettings(internal);
}

export function applyCompactSettingOptions(current: unknown, options: Record<string, unknown>): { config: Record<string, boolean | number>; changed: string[] } {
    const config = compactSettingsToConfig(compactSettingsFromConfig(current ?? {}));
    const changed: string[] = [];
    for (const entry of COMPACT_SETTING_REGISTRY.entries) {
        const option = options[entry.id];
        if (option === undefined) continue;
        if (entry.value_type === 'boolean' && option !== 'true' && option !== 'false') throw new Error(`${entry.cli.flag} requires true or false.`);
        const value = entry.value_type === 'boolean' ? option === 'true' : Number(option);
        COMPACT_SETTING_REGISTRY.validate(entry.id, value);
        config[entry.key.split('.')[1]] = value;
        changed.push(entry.key);
    }
    compactSettingsFromConfig(config);
    return { config, changed };
}
