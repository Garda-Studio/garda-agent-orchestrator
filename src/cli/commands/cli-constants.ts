type CommandSummaryEntry = readonly [command: string, summary: string];

export const DEFAULT_REPO_URL = 'https://github.com/Shubchynskyi/garda-agent-orchestrator.git';

export const SKIPPED_ENTRY_NAMES = new Set<string>([
    '__pycache__',
    '.pytest_cache'
]);

export const SKIPPED_FILE_SUFFIXES = Object.freeze([
    '.pyc',
    '.pyo',
    '.pyd'
]);

export const DEPLOY_ITEMS = Object.freeze([
    '.gitattributes',
    'bin',
    'template',
    'AGENT_INIT_PROMPT.md',
    'CHANGELOG.md',
    'HOW_TO.md',
    'LICENSE',
    'MANIFEST.md',
    'README.md',
    'VERSION',
    'package.json'
]);

export const OPTIONAL_DEPLOY_ITEMS = Object.freeze([
    'src'
]);

export const COMPILED_RUNTIME_DEPLOY_CANDIDATES = Object.freeze([
    'dist'
]);

export const FORBIDDEN_COMPILED_RUNTIME_DEPLOY_PATHS = Object.freeze([
    '.node-build'
]);

export const COMMAND_SUMMARY = Object.freeze<readonly CommandSummaryEntry[]>([
    ['setup', 'First-run onboarding'],
    ['agent-init', 'Finalize mandatory agent onboarding'],
    ['preprompt', 'Read-only task bootstrap context and exact next commands'],
    ['next-step', 'Show the deterministic next command for a task'],
    ['compact', 'Bounded Git/file/search inspection with retained-output retrieval'],
    ['status', 'Show workspace status'],
    ['doctor', 'Run verify + manifest validation'],
    ['debug env', 'Show environment triage snapshot'],
    ['stats', 'Token-overhead and runtime analytics'],
    ['task', 'Inspect one task via stats or event timeline'],
    ['html', 'Write a static read-only HTML report and optional snapshots'],
    ['ui', 'Start a localhost UI with lazy task details'],
    ['off', 'Hide Garda root agent instructions without uninstalling'],
    ['on', 'Restore Garda root agent instructions after off mode'],
    ['bootstrap', 'Deploy bundle only'],
    ['install', 'Deploy or refresh the bundle and run the Node install pipeline'],
    ['init', 'Re-materialize live/ from an existing deployed bundle'],
    ['reinit', 'Change init answers'],
    ['update', 'Check/apply updates'],
    ['update git', 'Apply update from git source'],
    ['rollback', 'Rollback to a specific or previous version'],
    ['backup', 'Create manual backup snapshots'],
    ['uninstall', 'Remove orchestrator'],
    ['cleanup', 'Remove retained runtime artifacts and manage review-artifact storage policy'],
    ['repair', 'Inspect and repair runtime indexes, task timelines, protected manifests, and stale locks'],
    ['gc', 'Extended cleanup with dry-run default and alias clean'],
    ['verify', 'Verify workspace layout'],
    ['check-update', 'Check for available updates'],
    ['skills', 'List, suggest, and manage optional skill packs'],
    ['review-capabilities', 'Show, enable, and disable repo-local optional review capabilities'],
    ['review-catalog', 'Inspect and safely manage review lanes, profiles, and dependencies'],
    ['templates', 'Show, validate, and manage user message template overrides'],
    ['workflow', 'Show and set repo-local workflow config'],
    ['profile', 'List, use, create, delete, and validate workspace profiles'],
    ['diff-managed', 'Show managed vs user-owned block ownership'],
    ['gate', 'Run an agent gate (gate <name>)']
]);
