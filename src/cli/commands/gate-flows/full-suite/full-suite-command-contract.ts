import * as path from 'node:path';
import type { FullSuiteCommandProvenance } from '../../../../gates/full-suite/full-suite-validation';
import { parseCommandChain } from '../../../../core/command-line';

export interface FullSuiteCommandContractResult {
    supported: boolean;
    provenance: FullSuiteCommandProvenance;
    violation: string | null;
}

const SHELL_CONTROL_OPERATORS = ['&&', '||', '>>', '<<', '|', '&', ';', '>', '<'] as const;
const POSIX_SHELL_NAMES = [
    'ash', 'bash', 'csh', 'dash', 'elvish', 'es', 'fish', 'ksh', 'mksh', 'nu',
    'osh', 'pdksh', 'rc', 'sh', 'tcsh', 'xonsh', 'yash', 'ysh', 'zsh'
] as const;
const POSIX_SHELL_EXECUTABLES = new Set(
    POSIX_SHELL_NAMES.flatMap((name) => [name, `${name}.exe`])
);
const WINDOWS_COMMAND_EXECUTABLES = new Set(['cmd', 'cmd.exe', 'command', 'command.com']);
const POWERSHELL_EXECUTABLES = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
const ENV_EXECUTABLES = new Set(['env', 'env.exe']);
const WSL_EXECUTABLES = new Set(['wsl', 'wsl.exe']);
const SHELL_MULTIPLEXER_EXECUTABLES = new Set(['busybox', 'busybox.exe', 'toybox', 'toybox.exe']);
const NICE_EXECUTABLES = new Set(['nice', 'nice.exe']);
const SHELL_SCRIPT_EXTENSIONS = new Set([
    ...POSIX_SHELL_NAMES.map((name) => `.${name}`),
    '.bat', '.cmd', '.command', '.ps1'
]);
const ENV_OPTIONS_WITH_VALUE = new Set(['-a', '-C', '-u', '--argv0', '--chdir', '--unset']);
const WSL_OPTIONS_WITH_VALUE = new Set([
    '-d', '-u', '--cd', '--distribution', '--shell-type', '--user'
]);
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/u;

interface DelegatedCommandCursor {
    executable: string;
    argumentIndex: number;
}

function buildProvenance(
    validationStatus: FullSuiteCommandProvenance['validation_status'],
    rejectionReason: FullSuiteCommandProvenance['rejection_reason'],
    detectedSyntax: string | null
): FullSuiteCommandProvenance {
    return {
        schema_version: 1,
        source: 'workflow_config.full_suite_validation.command',
        execution_mode: 'DIRECT_ARGV',
        validation_status: validationStatus,
        rejection_reason: rejectionReason,
        detected_syntax: detectedSyntax
    };
}

function findUnquotedShellControlOperator(command: string): string | null {
    let quote: '"' | '\'' | null = null;
    let escaping = false;

    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        if (escaping) {
            escaping = false;
            continue;
        }
        if (quote) {
            if (quote === '"' && character === '\\') {
                const nextCharacter = command[index + 1];
                if (nextCharacter === '"' || nextCharacter === '\\') {
                    escaping = true;
                }
                continue;
            }
            if (character === quote) {
                quote = null;
            }
            continue;
        }
        if (character === '"' || character === '\'') {
            quote = character;
            continue;
        }
        if (character === '\r' || character === '\n') {
            return 'newline';
        }
        const operator = SHELL_CONTROL_OPERATORS.find((candidate) => command.startsWith(candidate, index));
        if (operator) {
            return operator;
        }
    }
    return null;
}

function getExecutableBasename(token: string): string {
    return path.win32.basename(path.posix.basename(token.trim())).toLowerCase();
}

function isShellBackedExecutable(executable: string): boolean {
    return SHELL_SCRIPT_EXTENSIONS.has(path.extname(executable))
        || POSIX_SHELL_EXECUTABLES.has(executable)
        || WINDOWS_COMMAND_EXECUTABLES.has(executable)
        || POWERSHELL_EXECUTABLES.has(executable);
}

function analyzeEnvShortOptions(token: string): 'split-string' | 'consume-next-argument' | 'none' {
    if (!token.startsWith('-') || token.startsWith('--')) {
        return 'none';
    }
    const options = token.slice(1);
    for (let index = 0; index < options.length; index += 1) {
        const option = options[index];
        if (option === 'S') {
            return 'split-string';
        }
        if (option === 'a' || option === 'C' || option === 'u') {
            return index === options.length - 1 ? 'consume-next-argument' : 'none';
        }
    }
    return 'none';
}

function buildDelegatedCommandCursor(tokens: string[], executableIndex: number): DelegatedCommandCursor | null {
    const executable = tokens[executableIndex];
    return executable
        ? { executable, argumentIndex: executableIndex + 1 }
        : null;
}

function buildWslDelegatedCommandCursor(
    tokens: string[],
    executableIndex: number
): DelegatedCommandCursor | 'wsl default shell' | null {
    return tokens[executableIndex] === '~'
        ? 'wsl default shell'
        : buildDelegatedCommandCursor(tokens, executableIndex);
}

function findEnvDelegatedCommand(
    tokens: string[],
    argumentIndex: number
): DelegatedCommandCursor | 'env -S' | null {
    for (let index = argumentIndex; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--') {
            for (let delegatedIndex = index + 1; delegatedIndex < tokens.length; delegatedIndex += 1) {
                if (ENV_ASSIGNMENT_PATTERN.test(tokens[delegatedIndex])) {
                    continue;
                }
                return buildDelegatedCommandCursor(tokens, delegatedIndex);
            }
            return null;
        }
        if (
            token === '-S'
            || token === '--split-string'
            || token.startsWith('-S')
            || token.startsWith('--split-string=')
        ) {
            return 'env -S';
        }
        if (ENV_OPTIONS_WITH_VALUE.has(token)) {
            index += 1;
            continue;
        }
        const shortOptions = analyzeEnvShortOptions(token);
        if (shortOptions === 'split-string') {
            return 'env -S';
        }
        if (shortOptions === 'consume-next-argument') {
            index += 1;
            continue;
        }
        if (
            token.startsWith('--argv0=')
            || token.startsWith('--chdir=')
            || token.startsWith('--unset=')
            || ENV_ASSIGNMENT_PATTERN.test(token)
            || token.startsWith('-')
        ) {
            continue;
        }
        return buildDelegatedCommandCursor(tokens, index);
    }
    return null;
}

function findWslDelegatedCommand(
    tokens: string[],
    argumentIndex: number
): DelegatedCommandCursor | 'wsl default shell' | null {
    for (let index = argumentIndex; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '-e' || token === '--exec') {
            return buildWslDelegatedCommandCursor(tokens, index + 1) ?? 'wsl default shell';
        }
        if (token.startsWith('--exec=')) {
            const executable = token.slice('--exec='.length);
            if (executable === '~') {
                return 'wsl default shell';
            }
            return executable
                ? { executable, argumentIndex: index + 1 }
                : 'wsl default shell';
        }
        if (WSL_OPTIONS_WITH_VALUE.has(token)) {
            index += 1;
            continue;
        }
        if (
            token.startsWith('--cd=')
            || token.startsWith('--distribution=')
            || token.startsWith('--shell-type=')
            || token.startsWith('--user=')
        ) {
            continue;
        }
        if (token.startsWith('-')) {
            continue;
        }
        return 'wsl default shell';
    }
    return 'wsl default shell';
}

function findNiceDelegatedCommand(tokens: string[], argumentIndex: number): DelegatedCommandCursor | null {
    for (let index = argumentIndex; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--') {
            return buildDelegatedCommandCursor(tokens, index + 1);
        }
        if (token === '-n' || token === '--adjustment') {
            index += 1;
            continue;
        }
        if (token.startsWith('--adjustment=') || /^-\d+$/u.test(token) || token.startsWith('-')) {
            continue;
        }
        return buildDelegatedCommandCursor(tokens, index);
    }
    return null;
}

function findShellInterpreterInvocation(tokens: string[]): string | null {
    if (tokens.length === 0) {
        return null;
    }
    let cursor: DelegatedCommandCursor = {
        executable: tokens[0],
        argumentIndex: 1
    };
    while (cursor.executable) {
        const configuredExecutable = getExecutableBasename(cursor.executable);
        if (isShellBackedExecutable(configuredExecutable)) {
            return configuredExecutable;
        }
        if (SHELL_MULTIPLEXER_EXECUTABLES.has(configuredExecutable)) {
            const delegatedCommand = buildDelegatedCommandCursor(tokens, cursor.argumentIndex);
            if (!delegatedCommand) {
                return null;
            }
            cursor = delegatedCommand;
            continue;
        }
        if (NICE_EXECUTABLES.has(configuredExecutable)) {
            const delegatedCommand = findNiceDelegatedCommand(tokens, cursor.argumentIndex);
            if (!delegatedCommand) {
                return null;
            }
            cursor = delegatedCommand;
            continue;
        }
        if (WSL_EXECUTABLES.has(configuredExecutable)) {
            const delegatedCommand = findWslDelegatedCommand(tokens, cursor.argumentIndex);
            if (delegatedCommand === 'wsl default shell') {
                return configuredExecutable;
            }
            if (!delegatedCommand) {
                return null;
            }
            cursor = delegatedCommand;
            continue;
        }
        if (ENV_EXECUTABLES.has(configuredExecutable)) {
            const delegatedCommand = findEnvDelegatedCommand(tokens, cursor.argumentIndex);
            if (delegatedCommand === 'env -S') {
                return delegatedCommand;
            }
            if (!delegatedCommand) {
                return null;
            }
            cursor = delegatedCommand;
            continue;
        }
        return null;
    }
    return null;
}

export function validateFullSuiteCommandContract(command: string): FullSuiteCommandContractResult {
    const detectedOperator = findUnquotedShellControlOperator(command);
    if (detectedOperator) {
        return {
            supported: false,
            provenance: buildProvenance('REJECTED', 'SHELL_CONTROL_OPERATOR', detectedOperator),
            violation:
                `Configured full-suite command contains shell control syntax '${detectedOperator}', `
                + 'but full-suite commands use direct argv execution. Move the compound command into a trusted '
                + 'wrapper npm script and configure workflow_config.full_suite_validation.command as '
                + '`npm run <wrapper-script>`.'
        };
    }

    let tokens: string[];
    try {
        tokens = command.trim() ? parseCommandChain(command)[0] : [];
    } catch (error) {
        const detail = error instanceof Error && error.message.includes('unterminated')
            ? 'unterminated quoting or escaping' : error instanceof Error ? error.message : 'invalid argument syntax';
        return {
            supported: false,
            provenance: buildProvenance('REJECTED', 'INVALID_ARGUMENT_SYNTAX', detail),
            violation:
                'Configured full-suite command has invalid argument syntax. '
                + detail + '. '
                + 'Quote literal punctuation or use a directly executable command or a trusted wrapper npm script.'
        };
    }

    const shellInvocation = findShellInterpreterInvocation(tokens);
    if (shellInvocation) {
        return {
            supported: false,
            provenance: buildProvenance('REJECTED', 'SHELL_INTERPRETER', shellInvocation),
            violation:
                `Configured full-suite command invokes a shell interpreter ('${shellInvocation}'), `
                + 'which is outside the direct argv execution contract. Move the command into a trusted wrapper '
                + 'npm script and configure workflow_config.full_suite_validation.command as '
                + '`npm run <wrapper-script>`.'
        };
    }

    return {
        supported: true,
        provenance: buildProvenance('PASSED', null, null),
        violation: null
    };
}
