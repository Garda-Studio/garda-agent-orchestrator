export interface ValidationInterpreterPrefix {
    readonly options: readonly string[];
    readonly programIndex: number;
    readonly literalValueIndices: readonly number[];
}
const VALUE_OPTIONS: Record<string, readonly string[]> = {
    node: ['-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '-C', '--openssl-config'],
    python: ['-W', '-X', '--check-hash-based-pycs'],
    bash: ['-o', '+o', '-O', '+O', '--rcfile', '--init-file'], sh: ['-o', '+o'], zsh: ['-o', '+o']
};
const SHELL_FILE_SWITCHES = /^[+-][efnuvx]+$/u;
const SWITCHES: Record<string, RegExp> = {
    node: /^(?:--test|--no-warnings|--trace-warnings|--enable-source-maps)$/u,
    python: /^-[bBdEiIOPqRsSuv]+$/u, ruby: /^-[acdlnpsvwSyU]+$/u,
    php: /^-[CeHlnqsw]+$/u, perl: /^-[acfnpstTuUWwX0]+$/u,
    bash: SHELL_FILE_SWITCHES, sh: SHELL_FILE_SWITCHES, zsh: SHELL_FILE_SWITCHES,
    powershell: /^-(?:noprofile|nologo|noninteractive|sta|mta)$/iu,
    pwsh: /^-(?:noprofile|nologo|noninteractive|sta|mta)$/iu, 'deno-run': /^(?!)$/u, bun: /^(?!)$/u
};
export function normalizeValidationInterpreterOption(tool: string, argument: string): string {
    if (tool === 'ruby') return argument.replace(/0[0-7]{0,3}|W[0-7]?|K(?:.|$)/gu, 'v');
    if (tool === 'perl') return argument.replace(/0x[0-9a-fA-F]+|(?:0|l)[0-7]*/gu, '0');
    return argument;
}
function resolveClusterValue(tool: string, argv: readonly string[], index: number): { lastIndex: number; literal: boolean } | null {
    const argument = argv[index];
    const normalized = normalizeValidationInterpreterOption(tool, argument);
    const match = tool === 'ruby' ? /^-[acdlnpsvwSyU]*([rICF])([\s\S]*)$/u.exec(normalized)
        : tool === 'perl' ? /^-[acfnpstTuUWwX0]*([IFimM])([\s\S]*)$/u.exec(normalized) : null;
    if (!match) return null;
    const attached = argument.slice(argument.indexOf(match[1], 1) + 1);
    const separate = !attached && (tool === 'ruby' || ['I', 'm', 'M'].includes(match[1]));
    const lastIndex = separate ? index + 1 : index;
    const operand = separate ? argv[lastIndex] ?? '' : attached;
    if (lastIndex < argv.length && tool === 'perl' && /[mM]/u.test(match[1]) && !/^-?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*(?:=[^;\s{}]*)?$/u.test(operand)) {
        throw new Error('Inline validation programs are not admissible; use a pinned source file');
    }
    return { lastIndex, literal: tool !== 'ruby' || match[1] !== 'r' };
}
// This parser reports argument roles only; even a recognized boundary grants no execution authority.
export function parseValidationInterpreterPrefix(tool: string, argv: readonly string[]): ValidationInterpreterPrefix {
    const literalValueIndices: number[] = [];
    const conservative = { options: [...argv], programIndex: argv.length, literalValueIndices };
    if (tool === 'deno' && argv[0] === 'run') {
        const prefix = parseValidationInterpreterPrefix('deno-run', argv.slice(1));
        return { options: prefix.options, programIndex: prefix.programIndex + 1,
            literalValueIndices: prefix.literalValueIndices.map((index) => index + 1) };
    }
    if (!Object.hasOwn(SWITCHES, tool)) return conservative;
    const options: string[] = [];
    const isShell = ['bash', 'sh', 'zsh'].includes(tool);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--') return argv[index + 1] === '-' || ['powershell', 'pwsh'].includes(tool)
            ? conservative : { options, programIndex: index + 1, literalValueIndices };
        if (!argument.startsWith('-') && !(isShell && argument.startsWith('+'))) {
            return ['powershell', 'pwsh'].includes(tool) ? conservative : { options, programIndex: index, literalValueIndices };
        }
        if (tool === 'python' && /^-[bBdEiIOPqRsSuv]*m/u.test(argument)) {
            const moduleIndex = /^-[bBdEiIOPqRsSuv]*m$/u.test(argument) ? index + 1 : index;
            return moduleIndex < argv.length ? { options, programIndex: moduleIndex, literalValueIndices } : conservative;
        }
        const clusterValue = resolveClusterValue(tool, argv, index);
        if (clusterValue) {
            if (clusterValue.lastIndex >= argv.length) return conservative;
            options.push(argument);
            index = clusterValue.lastIndex;
            if (clusterValue.literal) literalValueIndices.push(index);
            continue;
        }
        if (['powershell', 'pwsh'].includes(tool) && /^-file$/iu.test(argument)) {
            return index + 1 >= argv.length || argv[index + 1] === '-' ? conservative : { options, programIndex: index + 1, literalValueIndices };
        }
        const flag = argument.split('=')[0];
        const pythonValue = tool === 'python' && /^-[bBdEiIOPqRsSuv]*[WX]$/u.test(argument);
        const shellOption = isShell ? /^[+-][efnuvx]*([oO])([\s\S]*)$/u.exec(argument) : null;
        const knownShellValue = shellOption && VALUE_OPTIONS[tool].includes(argument[0] + shellOption[1]);
        const shellValue = knownShellValue && !shellOption[2];
        const registeredValue = Object.hasOwn(VALUE_OPTIONS, tool) && VALUE_OPTIONS[tool].includes(flag) && !(isShell && argument.includes('='));
        const programValue = tool === 'node' && ['-r', '--require', '--import', '--loader', '--experimental-loader'].includes(flag);
        if ((pythonValue || shellValue || registeredValue) && !argument.includes('=') && index + 1 >= argv.length) return conservative;
        if (tool === 'python' && /^-[bBdEiIOPqRsSuv]*[WX]./u.test(argument) || tool === 'zsh' && knownShellValue && shellOption[2] && !shellOption[2].startsWith('=')) {
            options.push(argument);
            literalValueIndices.push(index);
            continue;
        }
        if ((pythonValue || shellValue || registeredValue) && !programValue) literalValueIndices.push(argument.includes('=') ? index : index + 1);
        if (isShell && /^-[A-Za-z]*[cs][A-Za-z]*$/u.test(argument)) return conservative;
        options.push(argument);
        if (pythonValue || shellValue || Object.hasOwn(VALUE_OPTIONS, tool) && VALUE_OPTIONS[tool].includes(argument)) { index++; continue; }
        // Unknown options may consume operands: retain the unresolved suffix instead of guessing a file.
        if (!(argument.includes('=') && registeredValue) && !SWITCHES[tool].test(normalizeValidationInterpreterOption(tool, argument))) {
            return { options: [...options, ...argv.slice(index + 1)], programIndex: argv.length, literalValueIndices };
        }
    }
    return { options, programIndex: argv.length, literalValueIndices };
}
