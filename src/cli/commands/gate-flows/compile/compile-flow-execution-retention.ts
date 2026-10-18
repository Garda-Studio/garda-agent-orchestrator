import {
    DEFAULT_COMPILE_TIMEOUT_MS
} from '../../../../core/subprocess';
import {
    getCompileCommandProfile,
    getCompileInvocationProfile,
    getOutputStats
} from '../../../../gates/compile/compile-gate';
import {
    auditGateCommand,
    type CommandCompactnessAudit
} from '../../../../gates/task-events-summary/task-events-summary';
import {
    buildOutputTelemetry,
    formatVisibleSavingsLine
} from '../../../../gate-runtime/token-telemetry';
import {
    buildRawOutputRetentionEvidence,
    type RawOutputRetentionEvidence
} from '../../../../gate-runtime/output-log-retention';
import {
    applyOutputFilterProfile,
    type FilterProfileResult
} from '../../../../gate-runtime/output-filters';
import {
    executeCommandAsync,
    type CommandInvocationExecution
} from '../../../gate-cli/gates-subprocess';
import {
    formatCompileOutputEntry,
    type OutputTelemetrySummary
} from '../../../gate-cli/gates-formatter';

type CompileCommandProfile = ReturnType<typeof getCompileCommandProfile>;

export interface CompileCommandExecutionSummary {
    invocationExecutions: Array<CommandInvocationExecution & { commandIndex: number }>;
    selectedInvocationIndex: number | null;
    selectedInvocationExecutable: string | null;
    commandAudits: CommandCompactnessAudit[];
    errorCount: number;
    exceptionMessage: string | null;
    exitCode: number;
    outputChunks: string[];
    outputLines: string[];
    selectedCommandIndex: number;
    selectedCommandProfile: CompileCommandProfile | null;
    warningCount: number;
}

export interface CompileOutputPresentation {
    compileOutputRetention: RawOutputRetentionEvidence;
    compileOutputText: string;
    effectiveProfile: CompileCommandProfile;
    filteredOutput: FilterProfileResult;
    outputTelemetry: Record<string, unknown>;
    retainCompileOutput: boolean;
    selectedOutputProfile: string;
    telemetrySummary: OutputTelemetrySummary;
    visibleSavingsLine: string | null;
}

export async function executeCompileCommands(params: {
    commands: string[];
    repoRoot: string;
    timeoutMs?: number;
}): Promise<CompileCommandExecutionSummary> {
    const outputLines: string[] = [];
    const outputChunks: string[] = [];
    const commandAudits: CommandCompactnessAudit[] = [];
    let warningCount = 0;
    let errorCount = 0;
    let exitCode = 0;
    let exceptionMessage: string | null = null;
    let selectedCommandProfile: CompileCommandProfile | null = null;
    let selectedCommandIndex = 0;
    let selectedInvocationIndex: number | null = null;
    let selectedInvocationExecutable: string | null = null;
    const invocationExecutions: CompileCommandExecutionSummary['invocationExecutions'] = [];
    const timeoutMs = params.timeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS;

    for (let index = 0; index < params.commands.length; index += 1) {
        const compileCommand = params.commands[index];
        const execution = await executeCommandAsync(compileCommand, {
            cwd: params.repoRoot,
            timeoutMs,
            captureInvocations: true
        });
        const invocations = execution.invocations || [];
        invocationExecutions.push(...invocations.map(invocation => ({ commandIndex: index + 1, ...invocation })));
        const selected = execution.exitCode === 0 ? invocations[0]
            : invocations.find(invocation => invocation.exitCode !== 0 || invocation.timedOut || invocation.cancelled);
        const commandProfile = selected ? getCompileInvocationProfile([selected.executable, ...selected.argv])
            : getCompileCommandProfile(compileCommand);
        const stats = getOutputStats(execution.outputLines);
        commandAudits.push(auditGateCommand(compileCommand, 'compile-gate'));

        outputLines.push(...execution.outputLines);
        warningCount += stats.warningLines;
        errorCount += stats.errorLines;
        outputChunks.push(
            formatCompileOutputEntry(index + 1, params.commands.length, compileCommand,
                execution.invocationOutput?.split(/\r?\n/u) || execution.outputLines)
        );

        if (execution.exitCode !== 0) {
            exitCode = execution.exitCode;
            exceptionMessage = `Compile command #${index + 1} exited with code ${execution.exitCode}.`;
            selectedCommandProfile = commandProfile;
            selectedCommandIndex = index + 1;
            selectedInvocationIndex = selected?.invocationIndex ?? null;
            selectedInvocationExecutable = selected?.executable ?? null;
            break;
        }

        if (index === 0) {
            selectedCommandProfile = commandProfile;
            selectedCommandIndex = 1;
            selectedInvocationIndex = selected?.invocationIndex ?? null;
            selectedInvocationExecutable = selected?.executable ?? null;
        }
    }

    return {
        invocationExecutions,
        selectedInvocationIndex,
        selectedInvocationExecutable,
        commandAudits,
        errorCount,
        exceptionMessage,
        exitCode,
        outputChunks,
        outputLines,
        selectedCommandIndex,
        selectedCommandProfile,
        warningCount
    };
}

export function buildCompileOutputPresentation(params: {
    budgetTokensForOutputFilters: number | null;
    compileCommands: string[];
    errorCount: number;
    exceptionMessage: string | null;
    outputChunks: string[];
    outputFiltersPath: string;
    outputLines: string[];
    failTailLines: number;
    selectedCommandProfile: CompileCommandProfile | null;
    warningCount: number;
}): CompileOutputPresentation {
    const fallbackProfile = params.compileCommands.length > 0
        ? getCompileCommandProfile(params.compileCommands[0])
        : {
            kind: 'compile',
            strategy: 'generic',
            label: 'compile',
            failure_profile: 'compile_failure_console_generic',
            success_profile: 'compile_success_console'
        };
    const effectiveProfile = params.selectedCommandProfile || fallbackProfile;
    const selectedOutputProfile = params.exceptionMessage ? effectiveProfile.failure_profile : effectiveProfile.success_profile;
    const filteredOutput = applyOutputFilterProfile(params.outputLines, params.outputFiltersPath, selectedOutputProfile, {
        budgetTokens: params.budgetTokensForOutputFilters,
        context: {
            fail_tail_lines: params.failTailLines,
            command_filter_strategy: effectiveProfile.strategy,
            command_kind: effectiveProfile.kind
        }
    });
    const outputTelemetry = buildOutputTelemetry(params.outputLines, filteredOutput.lines, {
        filterMode: filteredOutput.filter_mode,
        fallbackMode: filteredOutput.fallback_mode,
        parserMode: filteredOutput.parser_mode,
        parserName: filteredOutput.parser_name ?? undefined,
        parserStrategy: filteredOutput.parser_strategy ?? undefined
    });
    const telemetrySummary: OutputTelemetrySummary = {
        filter_mode: filteredOutput.filter_mode,
        fallback_mode: filteredOutput.fallback_mode,
        parser_mode: filteredOutput.parser_mode ?? 'NONE',
        parser_name: filteredOutput.parser_name ?? null,
        parser_strategy: filteredOutput.parser_strategy ?? null,
        original_lines: params.outputLines.length,
        filtered_lines: filteredOutput.lines.length
    };
    const visibleSavingsLine = formatVisibleSavingsLine(outputTelemetry);
    const compileOutputText = params.outputChunks.join('');
    const retainCompileOutput = !!params.exceptionMessage || params.warningCount > 0 || params.errorCount > 0;
    const compileOutputRetention = buildRawOutputRetentionEvidence(compileOutputText, retainCompileOutput);

    return {
        compileOutputRetention,
        compileOutputText,
        effectiveProfile,
        filteredOutput,
        outputTelemetry,
        retainCompileOutput,
        selectedOutputProfile,
        telemetrySummary,
        visibleSavingsLine
    };
}

export function formatCompileOutputRetentionLine(retention: RawOutputRetentionEvidence): string {
    return `CompileOutputRetention: retained=${String(retention.raw_output_retained)} `
        + `reason=${retention.retention_reason} `
        + `sha256=${retention.raw_output_sha256 || 'null'} `
        + `lines=${retention.raw_output_line_count} `
        + `chars=${retention.raw_output_char_count}`;
}
