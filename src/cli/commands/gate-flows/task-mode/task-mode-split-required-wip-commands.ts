import {
    listSplitRequiredWip,
    retireSplitRequiredWip
} from '../../../../gates/split-required/split-required-wip';
import {
    restoreSplitRequiredWipThroughRuntimeHandoff
} from '../../../../gates/split-required/split-required-wip-runtime-reexec';
import {
    EXIT_GATE_FAILURE,
    EXIT_SUCCESS
} from '../../../exit-codes';
import {
    expandValueList
} from '../../../gate-cli/gates-parser';

export interface SplitRequiredWipCommandResult {
    outputLines: string[];
    exitCode: number;
}

export interface ListSplitRequiredWipCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
}

export interface RestoreSplitRequiredWipCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    manifestPath?: unknown;
    includePaths?: unknown;
    dryRun?: unknown;
}

export interface RetireSplitRequiredWipCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    manifestPath?: unknown;
    reason?: unknown;
}

function requiredText(value: unknown, label: string): string {
    const text = String(value || '').trim();
    if (!text) {
        throw new Error(`${label} is required.`);
    }
    return text;
}

function parseIncludePaths(value: unknown): string[] {
    return expandValueList(value || [], { splitDelimiters: true })
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
}

export function runListSplitRequiredWipCommand(
    options: ListSplitRequiredWipCommandOptions
): SplitRequiredWipCommandResult {
    const result = listSplitRequiredWip({
        repoRoot: String(options.repoRoot || '.'),
        taskId: requiredText(options.taskId, 'TaskId')
    });
    return {
        outputLines: result.output_lines,
        exitCode: EXIT_SUCCESS
    };
}

export async function runRestoreSplitRequiredWipCommand(
    options: RestoreSplitRequiredWipCommandOptions
): Promise<SplitRequiredWipCommandResult> {
    const result = await restoreSplitRequiredWipThroughRuntimeHandoff({
        repoRoot: String(options.repoRoot || '.'),
        taskId: requiredText(options.taskId, 'TaskId'),
        manifestPath: requiredText(options.manifestPath, 'ManifestPath'),
        includePaths: parseIncludePaths(options.includePaths),
        dryRun: Boolean(options.dryRun)
    });
    return {
        outputLines: result.output_lines,
        exitCode: result.status === 'BLOCKED' ? EXIT_GATE_FAILURE : EXIT_SUCCESS
    };
}

export function runRetireSplitRequiredWipCommand(
    options: RetireSplitRequiredWipCommandOptions
): SplitRequiredWipCommandResult {
    const result = retireSplitRequiredWip({
        repoRoot: String(options.repoRoot || '.'),
        taskId: requiredText(options.taskId, 'TaskId'),
        manifestPath: requiredText(options.manifestPath, 'ManifestPath'),
        reason: requiredText(options.reason, 'Reason')
    });
    return {
        outputLines: result.output_lines,
        exitCode: result.status === 'BLOCKED' ? EXIT_GATE_FAILURE : EXIT_SUCCESS
    };
}
