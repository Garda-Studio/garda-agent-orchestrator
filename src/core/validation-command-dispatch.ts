import * as path from 'node:path';
import { parseCommandChain } from './command-line';

const PROCESS_WRAPPERS = new Set(['npx', 'bunx', 'pnpx', 'pnx', 'corepack', 'env', 'nice', 'time', 'busybox', 'toybox']);
export const PACKAGE_MANAGER_EXECUTABLES = new Set(['npm', 'pnpm', 'yarn', 'bun']);
export const PACKAGE_MANAGER_VALUE_OPTIONS = new Set([
    '--prefix', '--cwd', '--dir', '--filter', '-F', '--workspace', '-w', '--package', '-p', '-c', '-C',
    '--cache', '--registry', '--userconfig', '--node-options'
]);
export const NPM_VALUE_OPTIONS = new Set([
    ...[...PACKAGE_MANAGER_VALUE_OPTIONS].filter((option) => !['-p', '-C', '-F'].includes(option)),
    '--call', '--script-shell', '--loglevel'
]);
const NPX_VALUE_OPTIONS = new Set([...NPM_VALUE_OPTIONS, '-p', '--shell']);
const NPM_CALL_SHORT_OPTION = /^-[fglyp]*c$/u;
export const PNPM_EXEC_VALUE_OPTIONS = new Set([
    ...[...PACKAGE_MANAGER_VALUE_OPTIONS].filter((option) => !['-c', '-p', '-w'].includes(option)), '--allow-build'
]);
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
    npx: NPX_VALUE_OPTIONS,
    bunx: new Set([...PACKAGE_MANAGER_VALUE_OPTIONS].filter((option) => option !== '-c')),
    pnpx: PNPM_EXEC_VALUE_OPTIONS,
    pnx: PNPM_EXEC_VALUE_OPTIONS,
    env: new Set(['-u', '--unset', '-C', '--chdir', '-a', '--argv0']),
    nice: new Set(['-n', '--adjustment']),
    time: new Set(['-f', '--format', '-o', '--output'])
};

const SHELL_BUILTIN_DISPATCHERS = new Set(['exec', 'command', 'eval', 'source', '.']);
export const VALIDATION_POSIX_SHELL_EXECUTABLES = new Set(['ash', 'bash', 'csh', 'dash', 'elvish', 'es', 'fish',
    'ksh', 'mksh', 'nu', 'osh', 'pdksh', 'rc', 'sh', 'tcsh', 'xonsh', 'yash', 'ysh', 'zsh']);
const POWERSHELL_VALUE_OPTIONS = new Set([
    '-executionpolicy', '-ex', '-ep', '-inputformat', '-inp', '-if', '-outputformat', '-o', '-of',
    '-workingdirectory', '-wd', '-configurationname', '-config', '-configurationfile', '-custompipename',
    '-settingsfile', '-version', '-v'
]);
const WSL_VALUE_OPTIONS = new Set([
    '-d', '--distribution', '--distribution-id', '-u', '--user', '--cd', '--shell-type'
]);

function wslDelegatedTokens(tokens: readonly string[], start: number): string[] {
    for (let index = start; index < tokens.length; index += 1) {
        const option = tokens[index];
        if (option === '--exec' || option === '-e') {
            const delegated = tokens.slice(index + 1);
            if (delegated[0] && delegated[0] !== '~') return delegated;
            break;
        }
        if (WSL_VALUE_OPTIONS.has(option)) {
            if (!tokens[++index]) break;
        } else if (option !== '--system') {
            break;
        }
    }
    throw new Error('Unsupported WSL execution boundary. Use wsl --exec <program> <args> '
        + 'with supported host options as separate values, or a trusted wrapper script.');
}

function rejectValidationCommandDispatch(executable: string): never {
    throw new Error(`Unsupported executable command dispatch through '${executable}'. `
        + 'Native shell command text and env split-string execution require a trusted wrapper script for validation commands.');
}

function skipProcessWrapperOptions(tokens: readonly string[], start: number, executable: string): number {
    const valueOptions = WRAPPER_VALUE_OPTIONS[executable];
    let index = start;
    while (index < tokens.length && tokens[index].startsWith('-')) {
        const token = tokens[index++];
        if (token === '--') return index;
        if (token.startsWith('--')) {
            const option = token.split('=')[0];
            if (executable === 'env' && '--split-string'.startsWith(option)) rejectValidationCommandDispatch(executable);
            if (!token.includes('=') && [...valueOptions].some((valueOption) =>
                valueOption.startsWith('--') && valueOption.startsWith(option))) index += 1;
            continue;
        }
        for (let cursor = 1; cursor < token.length; cursor += 1) {
            const option = token[cursor];
            if (executable === 'env' && option === 'S') rejectValidationCommandDispatch(executable);
            if (valueOptions.has('-' + option)) {
                if (cursor === token.length - 1) index += 1;
                break; // The remainder is an attached operand, not more short options.
            }
        }
    }
    return index;
}

function validateValidationCommandDispatch(executable: string, rawArgs: readonly string[]): void {
    if (SHELL_BUILTIN_DISPATCHERS.has(executable)) rejectValidationCommandDispatch(executable);
    if (executable === 'cmd') {
        if (rawArgs.some((arg) => /^\/[ck]/iu.test(arg))) rejectValidationCommandDispatch(executable);
        return;
    }
    const powershell = executable === 'powershell' || executable === 'pwsh';
    if (!powershell && !VALIDATION_POSIX_SHELL_EXECUTABLES.has(executable)) return;
    for (let index = 0; index < rawArgs.length; index += 1) {
        const rawOption = rawArgs[index];
        const option = powershell ? rawOption.toLowerCase().replace(/^\//u, '-') : rawOption;
        if (option === '--' || (powershell && ['-file', '-f'].includes(option))) return;
        if (!option.startsWith('-') && (powershell || !option.startsWith('+'))) return;
        // A POSIX +option is still an option; it cannot hide later executable command text.
        if (powershell) {
            if (['-c', '-cwa', '-e', '-ec'].includes(option)
                || '-command'.startsWith(option) || '-commandwithargs'.startsWith(option)
                || '-encodedcommand'.startsWith(option)) rejectValidationCommandDispatch(executable);
            if ([...POWERSHELL_VALUE_OPTIONS].some((valueOption) => valueOption.startsWith(option))) index += 1;
        } else {
            if (/^[-+][^-+]*c/u.test(option) || /^--commands?(?:=|$)/u.test(option)
                || (executable === 'fish' && (/^-[^-]*C/u.test(option) || /^--init-command(?:=|$)/u.test(option)))) {
                rejectValidationCommandDispatch(executable);
            }
            if (/^[-+][^-+]*[oO]$/u.test(option) || ['--rcfile', '--init-file'].includes(option)) index += 1;
        }
    }
}

export function skipValidationCommandOptions(tokens: readonly string[], start: number, valueOptions?: ReadonlySet<string>): number {
    let index = start;
    while (index < tokens.length && tokens[index].startsWith('-')) {
        if (tokens[index] === '--') return index + 1;
        const takesValue = valueOptions?.has(tokens[index])
            || (valueOptions?.has('--call') && NPM_CALL_SHORT_OPTION.test(tokens[index]));
        index += takesValue ? 2 : 1;
    }
    return index;
}

function npmCallCommand(tokens: readonly string[], start: number, npx: boolean): string | undefined {
    let command: string | undefined;
    const valueOptions = npx ? NPX_VALUE_OPTIONS : NPM_VALUE_OPTIONS;
    for (let index = start; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--' || (npx && !token.startsWith('-'))) break;
        const equals = token.indexOf('=');
        const option = equals < 0 ? token : token.slice(0, equals);
        if (option === '--call' || NPM_CALL_SHORT_OPTION.test(option)) {
            command = equals < 0 ? tokens[++index] : token.slice(equals + 1);
        } else if (equals < 0 && valueOptions.has(option)) {
            index += 1;
        }
    }
    return command || undefined;
}

function pnpmShellCommand(tokens: readonly string[], start: number, commandIndex: number, optionsEnd = commandIndex): string | undefined {
    let shellMode = false;
    for (let index = start; index < optionsEnd; index += 1) {
        const token = tokens[index];
        if (token === '--') break;
        if (PNPM_EXEC_VALUE_OPTIONS.has(token)) index += 1;
        else if (token === '--shell-mode' || token === '--shell-mode=true' || /^-[rs]*c[rs]*$/u.test(token)) shellMode = true;
        else if (token === '--shell-mode=false' || token === '--no-shell-mode') shellMode = false;
    }
    return shellMode ? tokens.slice(commandIndex).join(' ') : undefined;
}

export function parseValidationRunnerCommandText(commandText: string): string[][] {
    // Native shell quote, escape and expansion rules differ from direct argv.
    // Keep an explicit portable subset; direct argv operands retain their literals.
    let withinDoubleQuotes = false;
    let atWordStart = true;
    for (const character of commandText) {
        if (character === '"') withinDoubleQuotes = !withinDoubleQuotes;
        if ("$`%!^\\*?[]{}~'\r\n".includes(character)
            || (!withinDoubleQuotes && ('()'.includes(character) || (character === '#' && atWordStart)))) {
            throw new Error('Unsupported executable command-string syntax ' + JSON.stringify(character)
                + '. Shell expansion, native escaping, single-quote syntax, unquoted grouping and shell comments require a trusted wrapper script.');
        }
        atWordStart = !withinDoubleQuotes && ' \t&'.includes(character);
    }
    return parseCommandChain(commandText);
}

export function resolveValidationCommandDispatch(tokens: readonly string[], rawTokens: readonly string[] = tokens): {
    executableIndex: number; executableIndexes: number[]; executable: string; args: string[]; rawArgs: string[];
    commandText?: string; delegatedTokens?: string[]
} {
    let executableIndex = 0;
    const executableIndexes: number[] = [];
    while (executableIndex < tokens.length) {
        executableIndexes.push(executableIndex);
        const executableToken = path.posix.basename(tokens[executableIndex]).replace(/\.(?:cmd|exe)$/u, '');
        const executable = executableToken === 'yarnpkg' ? 'yarn' : executableToken === 'pn' ? 'pnpm' : executableToken;
        let argumentIndex = executableIndex + 1;
        validateValidationCommandDispatch(executable, rawTokens.slice(argumentIndex));
        if (executable === 'wsl') {
            return { executableIndex, executableIndexes, executable, args: [], rawArgs: [],
                delegatedTokens: wslDelegatedTokens(rawTokens, argumentIndex) };
        } else if (PACKAGE_MANAGER_EXECUTABLES.has(executable)) {
            const valueOptions = executable === 'npm' ? NPM_VALUE_OPTIONS
                : executable === 'pnpm' ? PNPM_EXEC_VALUE_OPTIONS : PACKAGE_MANAGER_VALUE_OPTIONS;
            argumentIndex = skipValidationCommandOptions(rawTokens, argumentIndex, valueOptions);
            const delegatesExecutable = ['exec', 'dlx'].includes(tokens[argumentIndex])
                || (['npm', 'bun'].includes(executable) && tokens[argumentIndex] === 'x');
            if (!delegatesExecutable) {
                return { executableIndex, executableIndexes, executable, args: tokens.slice(argumentIndex), rawArgs: rawTokens.slice(argumentIndex) };
            }
            const delegatedIndex = skipValidationCommandOptions(rawTokens, argumentIndex + 1,
                executable === 'pnpm' ? PNPM_EXEC_VALUE_OPTIONS : valueOptions);
            const commandText = executable === 'npm' ? npmCallCommand(rawTokens, executableIndex + 1, false)
                : executable === 'pnpm' ? pnpmShellCommand(rawTokens, executableIndex + 1, delegatedIndex,
                    tokens[argumentIndex] === 'exec' ? argumentIndex : delegatedIndex) : undefined;
            if (commandText !== undefined) return { executableIndex: tokens.length, executableIndexes, executable: '', args: [], rawArgs: [], commandText };
            executableIndex = delegatedIndex;
        } else if (PROCESS_WRAPPERS.has(executable)) {
            argumentIndex = ['env', 'nice', 'time'].includes(executable) ? skipProcessWrapperOptions(rawTokens, argumentIndex, executable)
                : skipValidationCommandOptions(rawTokens, argumentIndex, WRAPPER_VALUE_OPTIONS[executable]);
            const commandText = executable === 'npx' ? npmCallCommand(rawTokens, executableIndex + 1, true)
                : ['pnpx', 'pnx'].includes(executable) ? pnpmShellCommand(rawTokens, executableIndex + 1, argumentIndex) : undefined;
            if (commandText !== undefined) return { executableIndex: tokens.length, executableIndexes, executable: '', args: [], rawArgs: [], commandText };
            while (executable === 'env' && /^[a-z_][a-z0-9_]*=/u.test(tokens[argumentIndex] || '')) argumentIndex += 1;
            executableIndex = argumentIndex;
        } else {
            return { executableIndex, executableIndexes, executable, args: tokens.slice(argumentIndex), rawArgs: rawTokens.slice(argumentIndex) };
        }
    }
    return { executableIndex, executableIndexes, executable: '', args: [], rawArgs: [] };
}

