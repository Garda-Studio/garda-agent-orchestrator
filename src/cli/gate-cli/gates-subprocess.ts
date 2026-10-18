import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    EXIT_GENERAL_FAILURE
} from '../exit-codes';
import {
    buildWindowsBatchCommandLine,
    createOutputCapture,
    spawnShellCommand,
    spawnStreamed,
    spawnSyncWithTimeout,
    type SpawnedProcessInfo
} from '../../core/subprocess';
import { assertDependentValidationChainReady } from '../../core/dependent-validation-chains';
import { redactSecretText } from '../../core/redaction';
import { parseCommandChain } from '../../core/command-line';
export { splitCommandLine } from '../../core/command-line';

export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 600_000;
const COMMAND_CHAIN_OUTPUT_MAX_BYTES = 40 * 1024 * 1024;
type CommandChainOutput = ReturnType<typeof createOutputCapture>;

export interface ExecuteCommandOptions {
    captureInvocations?: boolean;
    cwd?: string;
    envPath?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    signal?: AbortSignal | null;
    onSpawn?: (child: SpawnedProcessInfo) => void;
}

export interface CommandExecutionFacts {
    terminationSignal?: NodeJS.Signals;
    sinkError?: string;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    stdoutOriginalBytes?: number;
    stderrOriginalBytes?: number;
    outputTruncated?: boolean;
}

export interface AsyncCommandExecutionResult extends CommandExecutionFacts {
    invocations?: CommandInvocationExecution[];
    invocationOutput?: string;
    exitCode: number;
    outputLines: string[];
    timedOut: boolean;
    cancelled: boolean;
}

export interface CommandInvocationExecution extends CommandExecutionFacts {
    invocationIndex: number;
    executable: string;
    argv: string[];
    exitCode: number | null;
    executionError?: string;
    timedOut: boolean;
    cancelled: boolean;
}

export interface SyncCommandExecutionResult {
    exitCode: number;
    outputLines: string[];
    timedOut: boolean;
}

function splitOutputLines(text: unknown): string[] {
    if (!text) {
        return [];
    }
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

function redactOutputLines(lines: string[]): string[] {
    return splitOutputLines(redactSecretText(lines.join('\n')));
}

function buildSubprocessEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv | undefined {
    if (!overrides) {
        return undefined;
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
            env[key] = undefined;
        } else {
            env[key] = value;
        }
    }
    return env;
}

function findExecutableCandidate(candidatePath: string, extensions: string[]): string | null {
    if (path.extname(candidatePath)) {
        return fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile() ? candidatePath : null;
    }
    for (const extension of extensions) {
        const resolved = `${candidatePath}${extension}`;
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            return resolved;
        }
    }
    return null;
}

export function resolveExecutablePath(executableName: unknown, cwd?: string, envPath?: string): string {
    const requested = String(executableName || '');
    if (!requested) {
        throw new Error('Executable name must not be empty.');
    }

    const extensions = process.platform === 'win32'
        ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];

    if (path.isAbsolute(requested) || requested.includes('/') || requested.includes('\\')) {
        const absoluteCandidate = path.isAbsolute(requested)
            ? requested
            : path.resolve(cwd || process.cwd(), requested);
        const resolved = findExecutableCandidate(absoluteCandidate, extensions);
        if (resolved) {
            return resolved;
        }
        throw new Error(`Executable not found: ${requested}`);
    }

    const pathValue = envPath != null ? envPath : (process.env.PATH || '');
    for (const dirPath of String(pathValue).split(path.delimiter)) {
        if (!dirPath) {
            continue;
        }
        const resolved = findExecutableCandidate(path.join(dirPath, requested), extensions);
        if (resolved) {
            return resolved;
        }
    }

    if (process.platform !== 'win32') {
        return requested;
    }
    throw new Error(`${requested} is required but was not found in PATH.`);
}

function deferredSpawnObserver(callback: ExecuteCommandOptions['onSpawn']): ExecuteCommandOptions['onSpawn'] {
    if (!callback) return undefined;
    // Let adapters attach cancellation listeners before an observer can abort the child.
    return (child) => queueMicrotask(() => {
        try { callback(child); } catch (_error) { /* Diagnostic observers must not disrupt process cleanup. */ }
    });
}

async function executeCommandSegmentAsync(tokens: string[], options: ExecuteCommandOptions): Promise<AsyncCommandExecutionResult> {
    const cwd = options.cwd || process.cwd();
    assertDependentValidationChainReady(tokens, cwd);

    const executablePath = resolveExecutablePath(tokens[0], cwd, options.envPath);
    const args = tokens.slice(1);
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_SUBPROCESS_TIMEOUT_MS;
    const env = buildSubprocessEnv(options.env);

    const result = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executablePath)
        ? await spawnShellCommand(executablePath, args, {
            cwd,
            env,
            timeoutMs,
            signal: options.signal ?? undefined,
            onSpawn: deferredSpawnObserver(options.onSpawn)
        })
        : await spawnStreamed(executablePath, args, {
            cwd,
            env,
            timeoutMs,
            signal: options.signal ?? undefined,
            onSpawn: deferredSpawnObserver(options.onSpawn)
        });

    const facts: CommandExecutionFacts = {
        ...(result.terminationSignal ? { terminationSignal: result.terminationSignal } : {}),
        ...(result.sinkError !== undefined ? { sinkError: result.sinkError } : {}),
        stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated,
        stdoutOriginalBytes: result.stdoutOriginalBytes, stderrOriginalBytes: result.stderrOriginalBytes,
        outputTruncated: result.stdoutTruncated || result.stderrTruncated
    };
    if (result.timedOut) {
        return {
            ...facts,
            exitCode: EXIT_GENERAL_FAILURE,
            outputLines: redactOutputLines([
                ...splitOutputLines(result.stdout),
                ...splitOutputLines(result.stderr),
                `Process timed out after ${timeoutMs} ms.`
            ]),
            timedOut: true,
            cancelled: false
        };
    }

    if (result.cancelled) {
        return {
            ...facts,
            exitCode: EXIT_GENERAL_FAILURE,
            outputLines: redactOutputLines([
                ...splitOutputLines(result.stdout),
                ...splitOutputLines(result.stderr),
                'Process was cancelled.'
            ]),
            timedOut: false,
            cancelled: true
        };
    }

    return {
        ...facts,
        exitCode: result.exitCode,
        outputLines: redactOutputLines([
            ...splitOutputLines(result.stdout),
            ...splitOutputLines(result.stderr)
        ]),
        timedOut: false,
        cancelled: false
    };
}

function executeCommandSegment(tokens: string[], options: ExecuteCommandOptions): SyncCommandExecutionResult {
    const cwd = options.cwd || process.cwd();
    assertDependentValidationChainReady(tokens, cwd);

    const executablePath = resolveExecutablePath(tokens[0], cwd, options.envPath);
    const args = tokens.slice(1);
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_SUBPROCESS_TIMEOUT_MS;
    const env = buildSubprocessEnv(options.env);

    const result = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executablePath)
        ? spawnSyncWithTimeout(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', buildWindowsBatchCommandLine(executablePath, args)], {
            cwd,
            env,
            windowsHide: true,
            windowsVerbatimArguments: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs
        })
        : spawnSyncWithTimeout(executablePath, args, {
            cwd,
            env,
            windowsHide: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs
        });

    const outputLines = redactOutputLines([
        ...splitOutputLines(result.stdout),
        ...splitOutputLines(result.stderr)
    ]);

    if (result.timedOut) {
        return {
            exitCode: EXIT_GENERAL_FAILURE,
            outputLines: [...outputLines, `Process timed out after ${timeoutMs} ms.`],
            timedOut: true
        };
    }

    if (result.error) {
        const errorCode = 'code' in result.error ? (result.error as NodeJS.ErrnoException).code : undefined;
        if (errorCode === 'ENOENT') {
            throw new Error(`${tokens[0]} is required but was not found in PATH.`);
        }
        throw result.error;
    }

    return {
        exitCode: result.status == null ? EXIT_GENERAL_FAILURE : result.status,
        outputLines,
        timedOut: false
    };
}

function commandChainDeadline(timeoutMs: number): number {
    return timeoutMs > 0 ? performance.now() + timeoutMs : Number.POSITIVE_INFINITY;
}

function remainingChainTimeout(deadline: number): number {
    return Number.isFinite(deadline) ? Math.max(1, Math.ceil(deadline - performance.now())) : 0;
}

function getCommandChainInterruption(
    options: ExecuteCommandOptions,
    deadline: number,
    timeoutMs: number,
    output: CommandChainOutput
): AsyncCommandExecutionResult | null {
    const cancelled = options.signal?.aborted === true;
    const timedOut = !cancelled && performance.now() >= deadline;
    if (!cancelled && !timedOut) return null;
    output.append(cancelled ? 'Process was cancelled.\n' : 'Process timed out after ' + timeoutMs + ' ms.\n');
    return {
        exitCode: EXIT_GENERAL_FAILURE,
        outputLines: finishCommandChainOutput(output),
        timedOut,
        cancelled
    };
}

function appendCommandChainOutput(
    output: CommandChainOutput,
    result: SyncCommandExecutionResult,
    timeoutMs: number
): void {
    const lines = result.timedOut
        ? [...result.outputLines.slice(0, -1), 'Process timed out after ' + timeoutMs + ' ms.']
        : result.outputLines;
    if (lines.length > 0) output.append(lines.join('\n') + '\n');
}

function finishCommandChainOutput(output: CommandChainOutput): string[] {
    return redactOutputLines(splitOutputLines(output.finish().text));
}

function createInvocationCapture(enabled: boolean, timeoutMs: number, total: number) {
    const output = enabled ? createOutputCapture(COMMAND_CHAIN_OUTPUT_MAX_BYTES) : null;
    const invocations: CommandInvocationExecution[] = [];
    return {
        record(tokens: string[], index: number, result: AsyncCommandExecutionResult): void {
            if (!output) return;
            invocations.push({ invocationIndex: index, executable: tokens[0], argv: tokens.slice(1),
                exitCode: result.exitCode, timedOut: result.timedOut, cancelled: result.cancelled,
                ...(result.terminationSignal ? { terminationSignal: result.terminationSignal } : {}),
                ...(result.sinkError !== undefined ? { sinkError: result.sinkError } : {}),
                stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated,
                stdoutOriginalBytes: result.stdoutOriginalBytes, stderrOriginalBytes: result.stderrOriginalBytes,
                outputTruncated: result.outputTruncated });
            output.append(`==== INVOCATION ${index}/${total} ====\nARGV: ${redactSecretText(JSON.stringify(tokens))}\n`);
            appendCommandChainOutput(output, result, timeoutMs);
            output.append(`EXIT_CODE: ${result.exitCode}\n`);
        },
        recordError(tokens: string[], index: number, message: string): void {
            if (!output) return;
            // No child exit was observed: retain the attempted segment without inventing one.
            invocations.push({ invocationIndex: index, executable: tokens[0], argv: tokens.slice(1),
                exitCode: null, executionError: message, timedOut: false, cancelled: false });
            output.append(`==== INVOCATION ${index}/${total} ====\nARGV: ${redactSecretText(JSON.stringify(tokens))}\n`);
            output.append(`EXECUTION_ERROR: ${message}\n`);
        },
        finish(result: AsyncCommandExecutionResult): AsyncCommandExecutionResult {
            if (output && (result.timedOut || result.cancelled)
                && !invocations.some(invocation => invocation.timedOut || invocation.cancelled)) {
                output.append(result.cancelled ? 'Process was cancelled.\n' : `Process timed out after ${timeoutMs} ms.\n`);
            }
            if (!output) return result;
            const retained = output.finish();
            return { ...result, invocations, invocationOutput: redactSecretText(retained.text),
                outputTruncated: result.outputTruncated === true || retained.truncated };
        }
    };
}

export async function executeCommandAsync(
    commandText: string,
    options: ExecuteCommandOptions = {}
): Promise<AsyncCommandExecutionResult> {
    const commands = parseCommandChain(commandText);
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_SUBPROCESS_TIMEOUT_MS;
    const deadline = commandChainDeadline(timeoutMs);
    const output = createOutputCapture(COMMAND_CHAIN_OUTPUT_MAX_BYTES);
    const capture = createInvocationCapture(options.captureInvocations === true, timeoutMs, commands.length);
    let childOutputTruncated = false;
    const finish = (result: AsyncCommandExecutionResult): AsyncCommandExecutionResult => {
        const retained = output.finish();
        return capture.finish({ ...result, outputLines: redactOutputLines(splitOutputLines(retained.text)),
            outputTruncated: childOutputTruncated || result.outputTruncated === true || retained.truncated });
    };
    for (const [index, tokens] of commands.entries()) {
        const interruption = getCommandChainInterruption(options, deadline, timeoutMs, output);
        if (interruption) return finish(interruption);
        let result: AsyncCommandExecutionResult;
        try {
            result = await executeCommandSegmentAsync(tokens, {
                ...options,
                timeoutMs: remainingChainTimeout(deadline)
            });
        } catch (error) {
            if (options.captureInvocations !== true) throw error;
            const message = redactSecretText(error instanceof Error ? error.message : String(error));
            capture.recordError(tokens, index + 1, message);
            const failure = { exitCode: EXIT_GENERAL_FAILURE, outputLines: [message], timedOut: false, cancelled: false };
            appendCommandChainOutput(output, failure, timeoutMs);
            return finish(failure);
        }
        childOutputTruncated ||= result.outputTruncated === true;
        capture.record(tokens, index + 1, result);
        appendCommandChainOutput(output, result, timeoutMs);
        if (result.exitCode !== 0 || result.timedOut || result.cancelled) return finish(result);
    }
    return finish({ exitCode: 0, outputLines: [], timedOut: false, cancelled: false });
}

export function executeCommand(commandText: string, options: ExecuteCommandOptions = {}): SyncCommandExecutionResult {
    const commands = parseCommandChain(commandText);
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_SUBPROCESS_TIMEOUT_MS;
    const deadline = commandChainDeadline(timeoutMs);
    const output = createOutputCapture(COMMAND_CHAIN_OUTPUT_MAX_BYTES);
    for (const tokens of commands) {
        const interruption = getCommandChainInterruption(options, deadline, timeoutMs, output);
        if (interruption) {
            return { exitCode: interruption.exitCode, outputLines: interruption.outputLines, timedOut: interruption.timedOut };
        }
        const result = executeCommandSegment(tokens, {
            ...options,
            timeoutMs: remainingChainTimeout(deadline)
        });
        appendCommandChainOutput(output, result, timeoutMs);
        if (result.exitCode !== 0 || result.timedOut) return { ...result, outputLines: finishCommandChainOutput(output) };
    }
    return { exitCode: 0, outputLines: finishCommandChainOutput(output), timedOut: false };
}
