import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { buildBundleRelativePath, resolveBundleName } from '../../core/constants';
import {
    getProviderEnvironmentDetectionMarkers,
    getProviderEntrypointFiles,
    getProviderBridgeRelativePaths,
    getProviderEntries,
    getRequiredReviewSkillBridgeHostEntry
} from '../../core/provider-registry';
import { getNodeBundleCliCommand, getNodeGateCommandPrefix } from '../command-constants';

export const REVIEW_LAUNCH_NAVIGATION_INSTRUCTION =
    'Use next-step review navigation output before reviewer launch: `ReviewLaunchableBatch` / `launchable_review_types` list lanes that may be launched now, `BlockedReviewLanes` / `blocked_review_lanes` list dependency reasons, `NextReview` remains legacy single-lane compatibility, failed current reviews take remediation priority, and enabled full-suite validation blocks `test` review until current full-suite PASS evidence exists.';

export const OPTIONAL_MARKDOWN_WORKING_PLAN_INSTRUCTION =
    'If `garda-agent-orchestrator/runtime/plans/<task-id>.md` exists for the selected task, read it as optional executor guidance. Missing Markdown working plans are normal: do not block, invent a waiver, pass them as `--plan-path`, or treat their absence as a reviewer/completion issue.';

export const ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION =
    'Antigravity hard stop: if mandatory independent review is required and the current runtime has no real provider sub-agent launch tool, do not write review output files, do not invent reviewer launch routing, telemetry, receipts, or review artifacts, stop and ask the operator whether to switch provider or continue without independent review under the audited gate policy.';

const ANTIGRAVITY_ENTRYPOINT_FILE = '.antigravity/rules.md';

export function getDelegationRequiredProviderLaunchLines(): readonly string[] {
    return Object.freeze(
        getProviderEntries()
            .filter((entry) => entry.reviewerCapabilityTier === 'delegation_required')
            .map((entry) => (
                `- ${entry.reviewerLaunchLabel!} (delegation-capable): ${entry.delegatedReviewerLaunchInstruction!}`
            ))
    );
}

export function getReviewSkillBridgeHost(): { bridgePath: string; providerLabel: string } {
    const hostEntry = getRequiredReviewSkillBridgeHostEntry();
    const bridgePath = hostEntry.bridge!.orchestratorRelativePath;
    return {
        bridgePath,
        providerLabel: hostEntry.displayLabel
    };
}

function getSourceGateCommandPrefix(): string {
    return 'node bin/garda.js gate';
}

export { buildBundleRelativePath };

export function isAntigravityEntrypointPath(relativePath: string): boolean {
    return relativePath.replace(/\\/g, '/') === ANTIGRAVITY_ENTRYPOINT_FILE;
}

export function addAntigravityCanonicalStopInstruction(content: string, canonicalFile: string): string {
    if (!isAntigravityEntrypointPath(canonicalFile) || content.includes(ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION)) {
        return content;
    }
    const reviewerLaunchRule = '- Mandatory required reviewer launches must spawn a new clean-context delegated reviewer for the current review context; do not create, reserve, hold, or complete a reviewer before launch input exists, and do not reuse an existing reviewer session.';
    if (content.includes(reviewerLaunchRule)) {
        return content.replace(
            reviewerLaunchRule,
            `${reviewerLaunchRule}\n- ${ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION}`
        );
    }
    return content.replace(
        MANAGED_END,
        `- ${ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION}\n${MANAGED_END}`
    );
}

function buildTaskEntryRuleFileFlags(bundleName = resolveBundleName()): string {
    return [
        `--loaded-rule-file "${buildBundleRelativePath('live/docs/agent-rules/00-core.md', bundleName)}"`,
        `--loaded-rule-file "${buildBundleRelativePath('live/docs/agent-rules/15-project-memory.md', bundleName)}"`,
        `--loaded-rule-file "${buildBundleRelativePath('live/docs/agent-rules/40-commands.md', bundleName)}"`,
        `--loaded-rule-file "${buildBundleRelativePath('live/docs/agent-rules/80-task-workflow.md', bundleName)}"`,
        `--loaded-rule-file "${buildBundleRelativePath('live/docs/agent-rules/90-skill-catalog.md', bundleName)}"`
    ].join(' ');
}

function buildEnterTaskModeSnippet(commandPrefix: string, runtimeIdentityFlag: string): string {
    return [
        `${commandPrefix} enter-task-mode`,
        '--task-id "<task-id>"',
        '--entry-mode "EXPLICIT_TASK_EXECUTION"',
        '--requested-depth "<1|2|3>"',
        '--task-summary "<task summary>"',
        runtimeIdentityFlag,
        '--repo-root "."'
    ].join(' ');
}

function buildTaskEntryRulePackSnippet(commandPrefix: string, bundleName = resolveBundleName()): string {
    return [
        `${commandPrefix} load-rule-pack`,
        '--task-id "<task-id>"',
        '--stage "TASK_ENTRY"',
        buildTaskEntryRuleFileFlags(bundleName),
        '--repo-root "."'
    ].join(' ');
}

export function buildSourceNextStepSnippet(): string {
    return 'node bin/garda.js next-step "<task-id>" --repo-root "."';
}

export function buildBundleNextStepSnippet(): string {
    return `${getNodeBundleCliCommand()} next-step "<task-id>" --repo-root "."`;
}

export function buildTaskStartSnippetSection(runtimeProviderLabel: string, routeTarget: string): string {
    const sourcePrefix = getSourceGateCommandPrefix();
    const bundlePrefix = getNodeGateCommandPrefix();
    const bundleName = resolveBundleName();
    return [
        '## Copy-Paste Start Commands',
        'In installed projects, never edit, stage or commit files under the Garda bundle, even with operator approval. Record Garda defects in the orchestrator problems log instead of patching Garda inside the project. Change live/config settings only through existing workflow commands. Garda source-checkout development remains supported through orchestrator-work.',
        `- First/resume command (source checkout): \`${buildSourceNextStepSnippet()}\``,
        `- First/resume command (deployed workspace): \`${buildBundleNextStepSnippet()}\``,
        '- Use the same `next-step` command before the first gate, after every suggested command, and after any gate failure. Do not start with `compile-gate`, guess flags, or read default config templates when `next-step` can inspect task evidence.',
        `- Source checkout (\`--provider\`): \`${buildEnterTaskModeSnippet(sourcePrefix, `--provider "${runtimeProviderLabel}"`)}\``,
        `- Source checkout (\`--provider\` + \`--routed-to\`, optional telemetry): \`${buildEnterTaskModeSnippet(sourcePrefix, `--provider "${runtimeProviderLabel}" --routed-to "${routeTarget}"`)}\``,
        `- Source checkout (\`TASK_ENTRY\` rules): \`${buildTaskEntryRulePackSnippet(sourcePrefix, bundleName)}\``,
        `- Deployed workspace (\`--provider\`): \`${buildEnterTaskModeSnippet(bundlePrefix, `--provider "${runtimeProviderLabel}"`)}\``,
        `- Deployed workspace (\`--provider\` + \`--routed-to\`, optional telemetry): \`${buildEnterTaskModeSnippet(bundlePrefix, `--provider "${runtimeProviderLabel}" --routed-to "${routeTarget}"`)}\``,
        `- Deployed workspace (\`TASK_ENTRY\` rules): \`${buildTaskEntryRulePackSnippet(bundlePrefix, bundleName)}\``,
        `- Required runtime identity: use \`--provider "${runtimeProviderLabel}"\`; add \`--routed-to "${routeTarget}"\` only when route telemetry must be pinned.`
    ].join('\n');
}

export const MANAGED_START = '<!-- garda-agent-orchestrator:managed-start -->';
export const MANAGED_END = '<!-- garda-agent-orchestrator:managed-end -->';
export const COMMIT_GUARD_START = '# garda-agent-orchestrator:commit-guard-start';
export const COMMIT_GUARD_END = '# garda-agent-orchestrator:commit-guard-end';
export const GITIGNORE_MANAGED_COMMENT = '# garda-agent-orchestrator managed ignores';
export const AGENTIGNORE_ACTIVE_MANAGED_COMMENT = '# Garda active-mode agent ignore';
export const AGENTIGNORE_OFF_MANAGED_COMMENT = '# Garda off-mode agent ignore';
export const UNINSTALL_BACKUP_GITIGNORE_COMMENT = '# Backup artifacts created by Garda Agent Orchestrator uninstall';
export function getUninstallBackupGitignoreEntry(): string {
    return `${resolveBundleName()}-uninstall-backups/`;
}
export function getLegacyUninstallBackupGitignoreEntry(): string {
    return `${resolveBundleName()}-uninstall-backups/**`;
}
export const COMMIT_GUARD_ENV_NAME = 'GARDA_ALLOW_COMMIT';
export const COMMIT_GUARD_EXTRA_MARKERS_ENV = 'GARDA_AGENT_ENV_MARKERS';
export const COMMIT_GUARD_AGENT_MARKERS = Object.freeze([...new Set([
    ...getProviderEnvironmentDetectionMarkers(),
    'AIDER_SESSION_ID',
])]);

export const INSTALL_BACKUP_CANDIDATE_PATHS = Object.freeze([
    ...getProviderEntrypointFiles(), TASK_QUEUE_FILENAME,
    '.qwen/settings.json', '.claude/settings.local.json',
    '.vscode/settings.json',
    '.git/hooks/pre-commit', '.gitignore', '.agentignore',
    '.agents/workflows/start-task.md',
    ...getProviderBridgeRelativePaths(),
    '.github/agents/reviewer.md', '.github/agents/code-review.md',
    '.github/agents/db-review.md', '.github/agents/security-review.md',
    '.github/agents/refactor-review.md', '.github/agents/api-review.md',
    '.github/agents/test-review.md', '.github/agents/performance-review.md',
    '.github/agents/infra-review.md', '.github/agents/dependency-review.md'
]);

export function getClaudeOrchestratorAllowEntries(): readonly string[] {
    return Object.freeze([
    `Bash(${getNodeBundleCliCommand()} *:*)`,
    `Bash(cd * && ${getNodeBundleCliCommand()} *:*)`,
    'Bash(npx garda-agent-orchestrator *:*)',
    'Bash(cd * && npx garda-agent-orchestrator *:*)',
    'Bash(cd * && git diff *:*)',
    'Bash(cd * && git log *:*)',
    'Bash(grep -n * | head * && echo * && grep -n * | head *:*)',
    'Bash(cd * && grep -n * | head * && echo * && grep -n * | head *:*)'
    ]);
}

function getEntrypointRuleLinks(): readonly (readonly [string, string])[] {
    const bn = resolveBundleName();
    return Object.freeze([
    [`${bn}/live/docs/agent-rules/00-core.md`, 'Core Rules'],
    [`${bn}/live/docs/agent-rules/10-project-context.md`, 'Project Context'],
    [`${bn}/live/docs/agent-rules/15-project-memory.md`, 'Project Memory Summary'],
    [`${bn}/live/docs/agent-rules/20-architecture.md`, 'Architecture'],
    [`${bn}/live/docs/agent-rules/30-code-style.md`, 'Code Style'],
    [`${bn}/live/docs/agent-rules/35-strict-coding-rules.md`, 'Strict Coding Rules'],
    [`${bn}/live/docs/agent-rules/40-commands.md`, 'Commands'],
    [`${bn}/live/docs/agent-rules/50-structure-and-docs.md`, 'Structure and Documentation'],
    [`${bn}/live/docs/agent-rules/60-operating-rules.md`, 'Operating Rules'],
    [`${bn}/live/docs/agent-rules/70-security.md`, 'Security'],
    [`${bn}/live/docs/agent-rules/80-task-workflow.md`, 'Task Workflow'],
    [`${bn}/live/docs/agent-rules/90-skill-catalog.md`, 'Skill Catalog']
    ] as const);
}

export interface TaskQueueTableRange {
    lines: string[];
    activeQueueIndex: number;
    headerIndex: number;
    rowsStartIndex: number;
    rowsEndIndex: number;
}

export interface ProviderOrchestratorProfileLike {
    gitignoreEntries: string[];
}

export type SettingsParseMode = 'default' | 'merge-existing' | 'invalid-root' | 'invalid-json';

export interface SettingsBuildResult {
    content: string;
    needsUpdate: boolean;
    parseMode: SettingsParseMode;
}

export interface ManagedBlockSyncResult {
    content: string;
    changed: boolean;
}

export interface GitignoreManagedBlockSyncResult extends ManagedBlockSyncResult {
    addedEntries: number;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function restoreEntrypointRuleLinks(content: string): string {
    let restored = String(content || '');
    for (const [rulePath, label] of getEntrypointRuleLinks()) {
        const plainBullet = new RegExp('^\\- \\`' + escapeRegex(rulePath) + '\\`$', 'gm');
        restored = restored.replace(plainBullet, () => `- [${label}](./${rulePath})`);
    }
    return restored;
}

export function extractManagedBlockFromContent(
    content: string | null | undefined,
    startMarker: string,
    endMarker: string
): string | null {
    if (!content || !content.trim()) return null;
    const pattern = new RegExp(
        `${escapeRegex(startMarker)}[\\s\\S]*?${escapeRegex(endMarker)}`, 'm'
    );
    const match = content.match(pattern);
    return match ? match[0] : null;
}
