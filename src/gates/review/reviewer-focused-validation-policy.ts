export const REVIEWER_INLINE_INTERPRETER_REASON =
    'run inline interpreter code with unauditable side effects';

export const REVIEWER_INLINE_INTERPRETER_COMMAND_PATTERN =
    /^\s*(?:(?:node|deno|bun|python(?:3)?|ruby|perl|php)\s+(?:-e|-c|-p|--eval|--print)\b|php\s+-r\b|(?:powershell|pwsh)\s+(?:-command|-encodedcommand)\b|(?:bash|sh|zsh|cmd)\s+(?:-c|\/c)\b)/iu;

export const REVIEWER_INLINE_INTERPRETER_EXAMPLES = [
    'node -e', 'node --eval', 'python -c', 'ruby -e', 'perl -e', 'php -r',
    'pwsh -Command', 'powershell -EncodedCommand', 'bash -c', 'cmd /c'
] as const;

export function hasReviewerInlineInterpreterOption(firstToken: string, tokens: readonly string[]): boolean {
    if (/^(?:node(?:\.exe)?|deno|bun|python(?:3)?|ruby|perl|php)$/iu.test(firstToken)) {
        return tokens.slice(1).some((token) => (
            /^(?:-e|-c|-p|--eval|--print)(?:$|=|[^a-z0-9-])/iu.test(token)
            || (/^php$/iu.test(firstToken) && /^-r(?:$|=|[^a-z0-9-])/iu.test(token))
        ));
    }
    if (/^(?:powershell|pwsh)$/iu.test(firstToken)) {
        return tokens.slice(1).some((token) => /^(?:-command|-encodedcommand)(?:$|=)/iu.test(token));
    }
    if (/^(?:bash|sh|zsh|cmd(?:\.exe)?)$/iu.test(firstToken)) {
        return tokens.slice(1).some((token) => /^(?:-c|\/c)$/iu.test(token));
    }
    return false;
}

export function buildReviewerFocusedRunnerPolicyLines(): string[] {
    return [
        '- Use the project-configured focused runner and its existing configuration for one exact repository target. Do not create temporary runner scripts or substitute custom compilation, transpilation, dynamic module loading, or an in-memory runner for that configured invocation.',
        `- Never ${REVIEWER_INLINE_INTERPRETER_REASON}. Prohibited invocation examples: ${REVIEWER_INLINE_INTERPRETER_EXAMPLES.map((example) => `\`${example}\``).join(', ')}. This reviewer rule applies to every stack; these examples are not an exhaustive list of interpreters.`,
        '- Normal runtime compilation or transformation inside the configured test tool is permitted. This rule does not prohibit a configured TypeScript loader, Python assertion rewriting, or ordinary runtime compilation by the project toolchain.',
        '- The focused evidence handoff includes validator-compatible command hints only when an exact current authenticated command is available. Hints describe existing evidence, do not authorize automatic execution, and must not be used to duplicate current gate-owned validation.',
        '- An absent command hint is not proof of missing or unavailable execution. If the project-configured focused invocation cannot be executed, record its exact attempted command and concrete unavailable/prohibited diagnostics; never invent a substitute compiler or relax a mandatory gate.'
    ];
}
