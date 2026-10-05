import { parseCommandChain } from '../../core/command-line';

export interface FocusedCommandSyntax {
    tokens: string[];
    unquotedTokens: string[];
    unquotedText: string;
    invalidSyntaxReason: string | null;
}

function maskQuotedArguments(command: string, mask: string): string {
    return command.replace(/"(?:\\[\\"]|[^"\\]|\\(?![\\"]))*"|'[^']*'/gu, (quoted) => mask.repeat(quoted.length));
}

export function parseFocusedCommandSyntax(command: string): FocusedCommandSyntax {
    try {
        const commands = parseCommandChain(command);
        return {
            tokens: commands.length === 1 ? commands[0] : [],
            // Non-whitespace placeholders preserve argv indexes for unquoted operand checks.
            unquotedTokens: commands.length === 1 ? parseCommandChain(maskQuotedArguments(command, '~'))[0] : [],
            unquotedText: maskQuotedArguments(command, ' '),
            invalidSyntaxReason: commands.length === 1
                ? null
                : 'chain or pipe multiple commands in one focused validation attempt'
        };
    } catch {
        return {
            tokens: [],
            unquotedTokens: [],
            unquotedText: command,
            invalidSyntaxReason: 'use malformed quotes, escaping, or unsupported command syntax in a focused validation attempt'
        };
    }
}
