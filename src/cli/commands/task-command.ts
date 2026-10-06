import { assertValidTaskId } from '../../gate-runtime/task-events';
import { PackageJsonLike, buildCommandHelpText, parseOptions } from './cli-helpers';
import { handleStats } from './debug-command';
import { handleGate } from './gate-command';
import { ParsedOptionsRecord } from './shared-command-utils';
import { handleTaskPlan } from './task-plan-command';

function shouldPrintTaskHelp(commandArgv: string[]): boolean {
    return commandArgv.length === 0
        || commandArgv[0] === 'help'
        || commandArgv.some((argument) => argument === '--help' || argument === '-h')
        || String(commandArgv[1] || '').toLowerCase() === 'help';
}

function normalizeTaskStatsArgs(taskId: string, actionArgv: string[]): string[] {
    const normalized = [taskId];
    for (let index = 0; index < actionArgv.length; index += 1) {
        const argument = actionArgv[index];
        if (argument === '--repo-root') {
            normalized.push('--target-root');
            if (index + 1 < actionArgv.length) {
                index += 1;
                normalized.push(actionArgv[index]);
            }
            continue;
        }
        if (argument.startsWith('--repo-root=')) {
            normalized.push(`--target-root=${argument.slice('--repo-root='.length)}`);
            continue;
        }
        normalized.push(argument);
    }
    return normalized;
}

function normalizeTaskEventsArgs(taskId: string, actionArgv: string[]): string[] {
    const eventDefinitions = {
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--target-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--as-json': { key: 'asJson', type: 'boolean' },
        '--json': { key: 'asJson', type: 'boolean' },
        '--include-details': { key: 'includeDetails', type: 'boolean' },
        '--compact-latest-cycle': { key: 'compactLatestCycle', type: 'boolean' }
    };
    const { options } = parseOptions(actionArgv, eventDefinitions);
    const parsed = options as ParsedOptionsRecord;
    const normalized = ['task-events-summary', '--task-id', taskId];
    if (parsed.repoRoot) normalized.push('--repo-root', String(parsed.repoRoot));
    if (parsed.eventsRoot) normalized.push('--events-root', String(parsed.eventsRoot));
    if (parsed.reviewsRoot) normalized.push('--reviews-root', String(parsed.reviewsRoot));
    if (parsed.asJson === true) normalized.push('--as-json');
    if (parsed.includeDetails === true) normalized.push('--include-details');
    if (parsed.compactLatestCycle === true) normalized.push('--compact-latest-cycle');
    return normalized;
}

export async function handleTask(commandArgv: string[], packageJson: PackageJsonLike): Promise<void> {
    if (shouldPrintTaskHelp(commandArgv)) {
        console.log(buildCommandHelpText('task'));
        return;
    }

    if (commandArgv[0] === 'plan') {
        handleTaskPlan(commandArgv.slice(1));
        return;
    }

    const taskId = assertValidTaskId(commandArgv[0]);
    const action = String(commandArgv[1] || '').trim().toLowerCase();
    const actionArgv = commandArgv.slice(2);

    if (action === 'stats') {
        handleStats(normalizeTaskStatsArgs(taskId, actionArgv), packageJson);
        return;
    }

    if (action === 'events') {
        await handleGate(normalizeTaskEventsArgs(taskId, actionArgv));
        return;
    }

    throw new Error(`Unsupported task action: ${action || '(empty)'}. Supported actions: stats, events.`);
}
