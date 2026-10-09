export interface ProviderClientDeclaration {
    readonly desktopId: string;
    readonly clientId: string;
    readonly displayLabel: string;
    readonly declaredExecutable: string;
    readonly desktopManagedExecutionConstraint: string | null;
}

const MANAGED_ADAPTER_CONSTRAINT = 'Managed execution requires a dedicated invocation and permission adapter; terminal MCP integration is supported.';

const CLIENT_DECLARATIONS: readonly ProviderClientDeclaration[] = Object.freeze(([
    ['codex-cli', 'Codex', 'Codex CLI', 'codex', null],
    ['claude-cli', 'Claude', 'Claude Code CLI', 'claude', null],
    ['qwen-cli', 'Qwen', 'Qwen Code CLI', 'qwen', null],
    ['grok-cli', 'Grok', 'Grok Build CLI', 'grok', null],
    ['opencode-cli', 'OpenCode', 'OpenCode CLI', 'opencode', null],
    ['antigravity-cli', 'Antigravity', 'Antigravity CLI', 'agy', null],
    ['kimi-cli', 'Kimi', 'Kimi Code CLI', 'kimi', null],
    ['codebuddy-cli', 'CodeBuddy', 'CodeBuddy CLI', 'codebuddy', null],
    ['iflow-cli', 'IFlow', 'iFlow CLI', 'iflow', null],
    ['copilot-cli', 'GitHubCopilot', 'GitHub Copilot CLI', 'copilot', null],
    ['auggie-cli', 'Auggie', 'Augment Auggie CLI', 'auggie', MANAGED_ADAPTER_CONSTRAINT],
    ['cursor-cli', 'Cursor', 'Cursor Agent CLI', 'agent', MANAGED_ADAPTER_CONSTRAINT],
    ['junie-cli', 'Junie', 'JetBrains Junie CLI', 'junie', MANAGED_ADAPTER_CONSTRAINT],
    ['kiro-cli', 'Kiro', 'Kiro CLI', 'kiro-cli', null],
    ['goose-cli', 'Goose', 'Goose CLI', 'goose', null],
    ['cline-cli', 'Cline', 'Cline CLI', 'cline', null],
    ['generic-cli', 'generic-cli', 'Generic CLI agent', '', null]
] as const).map(([desktopId, clientId, displayLabel, declaredExecutable, desktopManagedExecutionConstraint]) => (
    Object.freeze({ desktopId, clientId, displayLabel, declaredExecutable, desktopManagedExecutionConstraint })
)));

export function getProviderClientCatalog(): readonly ProviderClientDeclaration[] {
    return CLIENT_DECLARATIONS;
}
