import { validateWorkflowConfig } from '../../schemas/config-artifacts-workflow';
import { buildDefaultWorkflowConfig } from '../workflow-config';
import { createWorkflowSettingRegistry, type WorkflowSettingManifestEntry } from '../workflow-setting-manifest';

const workflowDefaults = buildDefaultWorkflowConfig();

function canonicalCommand(value: string): string {
    const config = validateWorkflowConfig({
        ...workflowDefaults, compile_gate: { command: value }
    });
    return (config.compile_gate as { command: string }).command;
}

function admitsCommand(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
        canonicalCommand(value);
        return true;
    } catch {
        return false;
    }
}

const commandEntry: WorkflowSettingManifestEntry<'string'> = {
    id: 'compile-gate-command',
    key: 'compile_gate.command',
    owner: { kind: 'workflow', section: 'compile-gate' },
    value_type: 'string',
    exposure: 'operator-visible',
    default_value: workflowDefaults.compile_gate.command,
    validate: admitsCommand,
    cli: { flag: '--compile-gate-command' },
    ui: {
        group: 'compile-gate',
        label: 'Compile-gate command',
        description: 'Executable compile/build/type-check command used by compile-gate. Local UI edits use the same audited `garda workflow set` path as full-suite settings and require explicit confirmation. When the value is __COMPILE_GATE_COMMAND_UNCONFIGURED__, compile-gate fails closed and never falls back to 40-commands.md.',
        control: 'text',
        options: [],
        placeholder: 'compile/build/type-check command'
    },
    materialize: value => [{ path: 'compile_gate.command', value: canonicalCommand(value) }]
};

export const COMPILE_SETTING_REGISTRY = createWorkflowSettingRegistry([commandEntry]);
