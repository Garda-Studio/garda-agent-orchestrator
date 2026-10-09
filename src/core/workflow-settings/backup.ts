import { buildDefaultWorkflowConfig, normalizeAutoBackupConfig } from '../workflow-config';
import {
    createWorkflowSettingRegistry, type WorkflowSettingManifestEntry,
    type WorkflowSettingOption, type WorkflowSettingValue
} from '../workflow-setting-manifest';

type BackupField = 'enabled' | 'interval_days' | 'keep_latest';

type BackupDefinition = {
    field: BackupField;
    id: string;
    flag: `--${string}`;
    label: string;
    description: string;
} & (
    | { value_type: 'boolean'; options: readonly WorkflowSettingOption[] }
    | { value_type: 'integer'; maximum: number }
);

const MINIMUM_BACKUP_INTEGER = 1;
const defaults = buildDefaultWorkflowConfig().auto_backup;
const definitions: readonly BackupDefinition[] = [
    {
        id: 'auto-backup-enabled', field: 'enabled', value_type: 'boolean',
        flag: '--auto-backup-enabled', label: 'Scheduled auto-backups',
        description: 'Allows the daily maintenance trigger to create scheduled rollback backups when due.',
        options: [
            { value: 'true', label: 'On', description: 'Daily maintenance may create scheduled rollback backups when the interval is due.' },
            { value: 'false', label: 'Off', description: 'Daily maintenance will not create scheduled rollback backups.' }
        ]
    },
    {
        id: 'auto-backup-interval-days', field: 'interval_days', value_type: 'integer',
        flag: '--auto-backup-interval-days', label: 'Auto-backup interval',
        description: 'Minimum number of days between successful scheduled backups.', maximum: 3650
    },
    {
        id: 'auto-backup-keep-latest', field: 'keep_latest', value_type: 'integer',
        flag: '--auto-backup-keep-latest', label: 'Auto-backup retention',
        description: 'Number of latest backups to keep after a scheduled backup is created.', maximum: 1000
    }
];

function canonicalValue(definition: BackupDefinition, value: unknown): boolean | number {
    return normalizeAutoBackupConfig({ ...defaults, [definition.field]: value })[definition.field];
}

function admitsTypedValue(definition: BackupDefinition, value: unknown): value is WorkflowSettingValue {
    if (typeof value !== typeof defaults[definition.field]) return false;
    if (definition.value_type === 'integer'
        && (typeof value !== 'number' || !Number.isSafeInteger(value)
            || value < MINIMUM_BACKUP_INTEGER || value > definition.maximum)) return false;
    return canonicalValue(definition, value) === value;
}

function createEntry(definition: BackupDefinition): WorkflowSettingManifestEntry {
    const key = `auto_backup.${definition.field}`;
    return {
        id: definition.id, key, owner: { kind: 'workflow', section: 'auto-backup' },
        value_type: definition.value_type, exposure: 'operator-visible', default_value: defaults[definition.field],
        validate: (value): value is WorkflowSettingValue => admitsTypedValue(definition, value),
        cli: { flag: definition.flag },
        ui: {
            group: 'auto-backup', label: definition.label, description: definition.description,
            control: definition.value_type === 'boolean' ? 'checkbox' : 'number',
            options: definition.value_type === 'boolean' ? definition.options : [],
            ...(definition.value_type === 'integer' ? { min: MINIMUM_BACKUP_INTEGER, max: definition.maximum } : {})
        },
        materialize: value => [{ path: key, value: canonicalValue(definition, value) }]
    };
}

export const BACKUP_SETTING_REGISTRY = createWorkflowSettingRegistry(definitions.map(createEntry));
