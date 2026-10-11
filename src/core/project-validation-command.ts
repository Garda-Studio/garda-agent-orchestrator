import * as path from 'node:path';
import { normalizeValidationInterpreterOption, parseValidationInterpreterPrefix } from './project-validation-interpreter-options';
import { rejectInlineValidationProgramUrl } from './project-validation-program-url';

const INLINE_PROGRAM_MESSAGE = 'Inline validation programs are not admissible; use a pinned source file';
const INLINE_OPTIONS: Record<string, RegExp> = {
    node: /^(?:-[ep]|--(?:eval|print)(?:$|=))/u,
    python: /^-[A-Za-z]*c/u, ruby: /^-[acdlnpsvwSyU]*e/u, perl: /^-[A-Za-z0-9]*[eE]/u,
    php: /^(?:-[aCeHhilmnqsvw?]*[rBRE]|--(?:run|process-begin|process-code|process-end)(?:=|$))/u,
    bash: /^-[A-Za-z]*c[A-Za-z]*$/u, sh: /^-[A-Za-z]*c[A-Za-z]*$/u, zsh: /^-[A-Za-z]*c[A-Za-z]*$/u,
    cmd: /^\/[ck]/iu, deno: /^eval$/u, bun: /^(?:-[ep]|--(?:eval|print)(?:$|=))/u
};
const POWERSHELL_INLINE_OPTIONS = ['command', 'commandwithargs', 'cwa', 'encodedcommand', 'encodedarguments', 'ec', 'ea'];
const POWERSHELL_PARAMETER_NAMES = [...POWERSHELL_INLINE_OPTIONS, 'file', 'noprofile', 'nologo', 'noninteractive', 'sta', 'mta',
    'configurationname', 'configurationfile', 'custompipename', 'executionpolicy', 'inputformat', 'outputformat', 'noexit',
    'login', 'interactive', 'noprofileloadtime', 'settingsfile', 'sshservermode', 'socketservermode', 'servermode',
    'namedpipeservermode', 'removeworkingdirectorytrailingcharacter', 'version', 'windowstyle', 'workingdirectory', 'help', 'ep', 'if', 'of', 'wd'];
const POWERSHELL_ZERO_VALUE_PARAMETERS = [['noprofile', 'nop'], ['nologo', 'nol'], ['noninteractive', 'noni'],
    ['sta', 'sta'], ['mta', 'mta']] as const;

function normalizePowerShellParameter(argument: string): string {
    const match = /^(?:([-\u2013\u2014\u2015])\1?|\/)([a-z]+)$/iu.exec(argument.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ''));
    const option = match?.[2].toLowerCase();
    if (!option || !POWERSHELL_PARAMETER_NAMES.some((name) => name.startsWith(option))) return argument;
    const zeroValue = POWERSHELL_ZERO_VALUE_PARAMETERS.find(([name, minimum]) =>
        option.length >= minimum.length && name.startsWith(option))?.[0];
    return 'file'.startsWith(option) ? '-File' : `-${zeroValue ?? option}`;
}

// Rejection-only argument inspection: a normal return never authorizes a tool or validation recipe.
export function rejectInlineValidationProgram(executable: string, argv: readonly string[]): void {
    const basename = path.posix.basename(executable.replace(/\\/gu, '/')).replace(/\.exe$/iu, '').toLowerCase();
    const tool = /^python(?:\d+(?:\.\d+)*)?$/u.test(basename) ? 'python' : basename === 'nodejs' ? 'node' : basename;
    const isPowerShell = ['powershell', 'pwsh'].includes(tool);
    const inspectionArgv = tool === 'bun' && argv[0] === 'run' ? argv.slice(1) : argv;
    const explicitFileIndex = isPowerShell ? inspectionArgv.findIndex((argument) => normalizePowerShellParameter(argument) === '-File') : -1;
    const parameterEnd = explicitFileIndex < 0 ? inspectionArgv.length : explicitFileIndex + 1;
    const parameterArgv = isPowerShell ? [...inspectionArgv.slice(0, parameterEnd).map(normalizePowerShellParameter)
        .filter((argument) => /[^\p{White_Space}]/u.test(argument)), ...inspectionArgv.slice(parameterEnd)] : inspectionArgv;
    let fileIndex = 0;
    while (tool === 'pwsh' && fileIndex < parameterArgv.length &&
        POWERSHELL_ZERO_VALUE_PARAMETERS.some(([name]) => parameterArgv[fileIndex].toLowerCase() === `-${name}`)) fileIndex += 1;
    const commandArgv = tool === 'pwsh' && parameterArgv[fileIndex] && !/^[-\u2013\u2014\u2015]/u.test(parameterArgv[fileIndex])
        ? [...parameterArgv.slice(0, fileIndex), '-File', ...parameterArgv.slice(fileIndex)] : parameterArgv;
    const prefix = parseValidationInterpreterPrefix(tool, commandArgv);
    const hasFile = prefix.programIndex < commandArgv.length &&
        /^-file$/iu.test(commandArgv[prefix.programIndex - 1] ?? '');
    const stdinProgram = commandArgv.slice(0, prefix.programIndex + 1).some((argument, index) =>
        argument === '-' && !prefix.literalValueIndices.includes(index));
    if (tool === 'bun' && argv[0] !== 'run' && commandArgv[prefix.programIndex] === 'repl' || isPowerShell && (stdinProgram ||
        tool === 'powershell' && !hasFile || prefix.options.some((argument) => {
            const option = argument.startsWith('-') ? argument.slice(1).split(':')[0].toLowerCase() : '';
            return option.length > 0 && POWERSHELL_INLINE_OPTIONS.some((name) => name.startsWith(option));
        }))) throw new Error(INLINE_PROGRAM_MESSAGE);
    if (Object.hasOwn(INLINE_OPTIONS, tool) && commandArgv.slice(0, prefix.programIndex).some((argument, index) =>
        !prefix.literalValueIndices.includes(index) && INLINE_OPTIONS[tool].test(normalizeValidationInterpreterOption(tool, argument)))) {
        throw new Error(INLINE_PROGRAM_MESSAGE);
    }
    commandArgv.slice(0, prefix.programIndex + 1).forEach((argument, index) => {
        if (!prefix.literalValueIndices.includes(index)) rejectInlineValidationProgramUrl(argument, index === prefix.programIndex);
    });
    if (/\.(?:cmd|bat)$/iu.test(executable)) {
        throw new Error('Shell wrappers require an explicit pinned interpreter and file invocation');
    }
}
