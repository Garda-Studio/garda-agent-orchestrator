import { createWorkflowSettingRegistry, type WorkflowSettingManifestEntry } from '../workflow-setting-manifest';

const entry: WorkflowSettingManifestEntry<'boolean'> = {
    id: 'parent-audit-enabled', key: 'parent_audit.enabled',
    owner: { kind: 'workflow', section: 'parent-audit' },
    value_type: 'boolean', exposure: 'operator-visible', default_value: false,
    validate: (value): value is boolean => typeof value === 'boolean',
    cli: { flag: '--parent-audit-enabled' },
    ui: {
        group: 'review-execution-policy', label: 'Full parent audit and review',
        description: 'For tasks split during execution, audit the combined result once after all children are accepted. Findings become one F-task; its acceptance completes the parent. Manual decomposition at creation always completes automatically. Applies to future decompositions.',
        control: 'checkbox', options: [
            { value: 'true', label: 'On', description: 'Audit and independently review the combined result once.' },
            { value: 'false', label: 'Off', description: 'Complete automatically after every child is accepted.' }
        ]
    },
    materialize: value => [{ path: 'parent_audit.enabled', value }]
};

export const PARENT_AUDIT_SETTING_REGISTRY = createWorkflowSettingRegistry([entry]);
