const UNSUPPORTED_UNQUOTED_SYNTAX = '|&;<>\r\n';

interface CommandToken {
    value: string;
    conjunction: boolean;
    assignment: boolean;
}

function readQuotedArgument(text: string, start: number): { value: string; end: number } {
    const quote = text[start];
    let value = '';
    for (let index = start + 1; index < text.length; index += 1) {
        const character = text[index];
        if (character === quote) return { value, end: index };
        if (quote === '"' && character === '\\' && ['"', '\\'].includes(text[index + 1])) {
            value += text[index + 1];
            index += 1;
        } else {
            value += character;
        }
    }
    throw new Error('Command contains unterminated escaping or quotes.');
}

function unsupportedSyntax(character: string, position: number): never {
    throw new Error('Unsupported command syntax ' + JSON.stringify(character) + ' at position ' + position
        + '. Use executable arguments joined by unquoted &&; quote literal operators. Shell expressions are not supported.');
}

function tokenizeCommandLine(commandText: unknown, parseOperators: boolean): CommandToken[] {
    const text = String(commandText ?? '');
    if (text.includes('\0')) unsupportedSyntax('\0', text.indexOf('\0'));
    const tokens: CommandToken[] = [];
    let current = '';
    let started = false;
    let quoted = false;
    let assignment = false;
    const flushArgument = () => {
        if (started) tokens.push({ value: current, conjunction: false, assignment });
        current = '';
        started = false;
        quoted = false;
        assignment = false;
    };

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === '"' || character === "'") {
            const argument = readQuotedArgument(text, index);
            current += argument.value;
            started = quoted = true;
            index = argument.end;
        } else if (parseOperators && text.startsWith('&&', index)) {
            flushArgument();
            tokens.push({ value: '&&', conjunction: true, assignment: false });
            index += 1;
        } else if (parseOperators && UNSUPPORTED_UNQUOTED_SYNTAX.includes(character)) {
            unsupportedSyntax(character, index);
        } else if (/\s/u.test(character)) {
            flushArgument();
        } else {
            if (!quoted && character === '=' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(current)) assignment = true;
            current += character;
            started = true;
        }
    }
    flushArgument();
    return tokens;
}

export function splitCommandLine(commandText: unknown): string[] {
    return tokenizeCommandLine(commandText, false).map((token) => token.value);
}

function appendCommand(commands: string[][], tokens: CommandToken[]): void {
    if (tokens.length === 0 || tokens[0].value === '') {
        throw new Error('Command chain contains an empty command before or after &&.');
    }
    if (tokens[0].assignment) {
        throw new Error('Unsupported command syntax: environment assignment before an executable. Use subprocess environment options or a trusted wrapper script.');
    }
    commands.push(tokens.map((token) => token.value));
}

export function parseCommandChain(commandText: string): string[][] {
    const tokens = tokenizeCommandLine(commandText, true);
    if (tokens.length === 0) throw new Error('Command must not be empty.');
    const commands: string[][] = [];
    let current: CommandToken[] = [];
    for (const token of tokens) {
        if (token.conjunction) {
            appendCommand(commands, current);
            current = [];
        } else {
            current.push(token);
        }
    }
    appendCommand(commands, current);
    return commands;
}

