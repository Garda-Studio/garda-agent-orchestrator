import * as path from 'node:path';
import { parseCommandChain } from './command-line';
import { inspectValidationProgramBoundary } from './project-validation-command';
import { parseValidationRunnerCommandText, resolveValidationCommandDispatch, VALIDATION_POSIX_SHELL_EXECUTABLES } from './validation-command-dispatch';

export type ValidationCommandPurpose = 'compile' | 'test' | 'validation';
export interface ValidationCommandDescriptor {
    schema_version: 1;
    purpose: ValidationCommandPurpose;
    invocations: Array<{ executable: string; argv: string[] }>;
}
export interface ValidationCommandAdmission {
    supported: boolean;
    descriptor: ValidationCommandDescriptor | null;
    rejection_reason: 'SHELL_CONTROL_OPERATOR' | 'SHELL_INTERPRETER' | 'INVALID_ARGUMENT_SYNTAX' | null;
    detected_syntax: string | null;
    violation: string | null;
}
const MAXIMUM_COMMAND_BYTES = 64 * 1024;
const MAXIMUM_ARGUMENTS = 256;
const MAXIMUM_COMMAND_INVOCATIONS = 32;
const SHELL_NAMES = new Set([...VALIDATION_POSIX_SHELL_EXECUTABLES, 'powershell', 'pwsh', 'cmd', 'command.com']);

function rejectCommand(reason: Exclude<ValidationCommandAdmission['rejection_reason'], null>, detail: string, message: string): ValidationCommandAdmission {
    return { supported: false, descriptor: null, rejection_reason: reason, detected_syntax: detail, violation: message };
}

function assertLiteralInvocation(tokens: string[], remaining: { count: number }): void {
    if (--remaining.count < 0 || tokens.length > MAXIMUM_ARGUMENTS) throw new Error('Validation command exceeds its invocation or argument bounds.');
    const normalized = tokens.map(token => token.replace(/\\/gu, '/').toLowerCase());
    const dispatch = resolveValidationCommandDispatch(normalized, tokens);
    if (dispatch.commandText !== undefined) {
        for (const delegated of parseValidationRunnerCommandText(dispatch.commandText)) assertLiteralInvocation(delegated, remaining);
        return;
    }
    if (dispatch.delegatedTokens) {
        assertLiteralInvocation(dispatch.delegatedTokens, remaining);
        return;
    }
    const executable = tokens[dispatch.executableIndex];
    if (!executable) return;
    const boundary = inspectValidationProgramBoundary(executable.trim(), dispatch.rawArgs);
    const tool = path.win32.basename(path.posix.basename(executable.trim())).replace(/\.exe$/iu, '').toLowerCase();
    if (!SHELL_NAMES.has(tool)) return;
    const firstArgument = dispatch.rawArgs[0];
    // Unknown interpreter options cannot prove where the file operand begins.
    const literalProgram = firstArgument === '--' ? dispatch.rawArgs[1] ?? null
        : firstArgument && !/^[-+]/u.test(firstArgument) ? firstArgument : null;
    const program = boundary.program ?? literalProgram;
    if (['cmd', 'command.com'].includes(tool) || !program || program === '-') {
        throw new Error(`Unsupported executable command dispatch through '${tool}'. Use a source-file runner or trusted wrapper script.`);
    }
}

// Existing command slots declare purpose. This projection grants no execution authority.
export function inspectValidationCommand(
    command: string, purpose: ValidationCommandPurpose, options: { allowConjunction?: boolean } = {}
): ValidationCommandAdmission {
    if (!['compile', 'test', 'validation'].includes(purpose) || Buffer.byteLength(command) > MAXIMUM_COMMAND_BYTES) {
        return rejectCommand('INVALID_ARGUMENT_SYNTAX', 'command bounds or purpose', 'Validation command exceeds its literal bounds or has an invalid purpose.');
    }
    let commands: string[][];
    try {
        commands = command.trim() ? parseCommandChain(command) : [];
    } catch (error) {
        const rawMessage = error instanceof Error ? error.message : 'invalid argument syntax';
        const message = rawMessage.includes('unterminated') ? 'unterminated quoting or escaping' : rawMessage;
        const control = /Unsupported command syntax "([|&;<>\\rn]+)"/u.exec(message);
        return rejectCommand(control ? 'SHELL_CONTROL_OPERATOR' : 'INVALID_ARGUMENT_SYNTAX', control?.[1] ?? message,
            'Configured validation command has invalid argument syntax: ' + message + ' Use a source-file runner or trusted wrapper script.');
    }
    if (commands.length > 1 && options.allowConjunction !== true) {
        return rejectCommand('SHELL_CONTROL_OPERATOR', '&&', 'Use one source-file runner or trusted wrapper script for this validation command.');
    }
    try {
        const remaining = { count: MAXIMUM_COMMAND_INVOCATIONS };
        for (const tokens of commands) assertLiteralInvocation(tokens, remaining);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid executable dispatch';
        return rejectCommand('SHELL_INTERPRETER', message,
            'Configured validation command invokes an inline or interactive program outside the direct argv execution contract. ' + message);
    }
    return { supported: true, descriptor: { schema_version: 1, purpose,
        invocations: commands.map(([executable, ...argv]) => ({ executable, argv })) },
        rejection_reason: null, detected_syntax: null, violation: null };
}
