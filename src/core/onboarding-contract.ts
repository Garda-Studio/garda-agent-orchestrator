import { resolveBundleName } from './constants';

export const RECOMMENDED_UI_ACTIONS_COMMAND = 'garda ui --actions';

export const NOT_EVERY_REQUEST_IS_A_TASK_RULE =
    'Not every request is a task: answer questions, explanations, reviews of existing code, read-only commands, status checks and Garda setup (`agent-init`) directly, without a `TASK.md` row or task mode. '
    + 'Change code or config only through task mode for a `TASK.md` row that already exists or that the user explicitly asks to add. '
    + 'If a change is needed and no row matches, propose a row (ID, title, scope) or a `CAND-<number>` candidate and wait for the user\'s decision; never add a row and enter it without that decision.';

export function buildTaskStartNavigatorPrompt(taskId = '<task-id>'): string {
    return `Execute task ${taskId} from TASK.md strictly through the orchestrator. Use \`next-step\` as the navigator; when independent review is required, launch a sub-agent using your internal tools.`;
}

export function buildActiveProfileGuidance(activeProfile?: string | null, cliCommand = 'node bin/garda.js'): string {
    const prefix = activeProfile
        ? `Current active profile: ${activeProfile}.`
        : 'Active profile selection comes from the workspace profile config.';
    return `${prefix} Inspect, switch, or create profiles with \`${cliCommand} profile current|list|use|create --target-root "."\`.`;
}

export function buildDualCliActiveProfileGuidance(activeProfile?: string | null): string {
    const prefix = activeProfile
        ? `Current active profile: ${activeProfile}.`
        : 'Active profile selection comes from the workspace profile config.';
    return `${prefix} Inspect, switch, or create profiles with \`node bin/garda.js profile current|list|use|create --target-root "."\` in a self-hosted source checkout, or \`node ${resolveBundleName()}/bin/garda.js profile current|list|use|create --target-root "."\` inside a materialized/deployed workspace.`;
}

export function buildNextStepNavigatorGuidance(cliCommand = 'node bin/garda.js'): string {
    return `Run \`${cliCommand} next-step "<task-id>" --repo-root "."\` before the first gate, after every suggested command, and after any gate failure. Follow only the single command it prints.`;
}

export function buildFullSuiteDisabledGuidance(cliCommand = 'node bin/garda.js'): string {
    return `Full repository test validation after each task is currently disabled. Do not silently enable it; ask for explicit permission or show: \`${cliCommand} workflow set --full-suite-enabled true --full-suite-command "<project test command>" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --target-root "."\`. If a valid command is already configured, use \`${cliCommand} workflow set --full-suite-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --target-root "."\`.`;
}
