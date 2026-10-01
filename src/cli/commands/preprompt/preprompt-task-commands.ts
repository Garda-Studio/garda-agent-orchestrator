import { resolveNextStep, type NextStepResult } from '../../../gates/next-step/next-step';
import { buildCliPrefix } from '../../../gates/next-step/next-step-resolution-context';
import { buildNavigatorCommand } from '../../../gates/next-step/next-step-command-formatters';
import { getGateHelpEntry } from '../gate-command-help';

export interface PrepromptContinuation {
    schema_version: 1;
    task_id: string;
    generated_utc: string;
    source: 'next-step';
    advisory_only: true;
    revalidate_before_action: true;
    navigator_command: string;
    status: NextStepResult['status'] | 'UNKNOWN';
    next_gate: string | null;
    title: string;
    reason: string;
    action: {
        label: string;
        command: string | null;
        command_selection_required: boolean;
    } | null;
}

export function buildTaskContinuation(repoRoot: string, taskId: string): PrepromptContinuation {
    try {
        return projectTaskContinuation(resolveNextStep({ repoRoot, taskId }));
    } catch {
        return {
            schema_version: 1,
            task_id: taskId,
            generated_utc: new Date().toISOString(),
            source: 'next-step',
            advisory_only: true,
            revalidate_before_action: true,
            navigator_command: buildNavigatorCommand(buildCliPrefix(repoRoot), taskId),
            status: 'UNKNOWN',
            next_gate: null,
            title: 'Inspect the navigator diagnostics before acting.',
            reason: 'The current navigator query failed; artifact presence and historical events cannot authorize a continuation action.',
            action: null
        };
    }
}

export function projectTaskContinuation(route: NextStepResult): PrepromptContinuation {
    const command = route.commands.length === 1 ? route.commands[0] : null;
    return {
        schema_version: 1,
        task_id: route.task_id,
        generated_utc: route.generated_utc,
        source: 'next-step',
        advisory_only: true,
        revalidate_before_action: true,
        navigator_command: route.navigator_command,
        status: route.status,
        next_gate: route.next_gate,
        title: route.title,
        reason: route.reason,
        action: route.next_gate || route.commands.length > 0 ? {
            label: command?.label || route.title,
            command: command?.command || null,
            command_selection_required: route.commands.length > 1
        } : null
    };
}

export function quoteCliToken(value: string): string {
    const text = String(value || '');
    if (/["$`]/.test(text)) {
        if (process.platform === 'win32') {
            return `'${text.replace(/'/g, "''")}'`;
        }
        return `'${text.replace(/'/g, "'\\''")}'`;
    }
    return `"${text.replace(/\\/g, '\\\\')}"`;
}

export function buildStartupScopeBlocker(
    changedFiles: string[],
    workspaceChangedFilesCount: number,
    stagedWorkspaceChangedFilesCount: number
): string | null {
    if (changedFiles.length > 0 || workspaceChangedFilesCount <= 0 || stagedWorkspaceChangedFilesCount > 0) {
        return null;
    }
    return 'Workspace is already dirty and has no staged task scope. Select explicit --changed-file entries or stage only the intended task diff, then ask next-step to validate the current action.';
}

export function buildOptionalSkillActivationCommand(repoRoot: string, taskId: string, skillId: string): string {
    return getGateHelpEntry('activate-optional-skill', repoRoot).usage[0]
        .split('"<task-id>"').join(quoteCliToken(taskId))
        .split('"<selected-skill-id>"').join(quoteCliToken(skillId));
}

export function buildOptionalSkillDeclineCommand(repoRoot: string, taskId: string, skillId: string): string {
    return getGateHelpEntry('decline-optional-skill', repoRoot).usage[0]
        .split('"<task-id>"').join(quoteCliToken(taskId))
        .split('"<selected-skill-id>"').join(quoteCliToken(skillId))
        .split('"<why-not-used>"').join('"not_used_for_current_implementation"');
}
