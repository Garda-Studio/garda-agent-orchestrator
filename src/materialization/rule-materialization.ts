import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists, readTextFile } from '../core/filesystem';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../core/constants';
import {
    DEFAULT_PROJECT_MEMORY_GENERATED_SUMMARY_MAX_CHARS,
    PROJECT_MEMORY_FILE_DEFINITIONS,
    PROJECT_MEMORY_MAP_READ_GUIDANCE,
    PROJECT_MEMORY_MAP_WRITE_CONTRACT,
    PROJECT_MEMORY_REQUIRED_FILE_NAMES,
    buildProjectMemorySourceRelativePath,
    getProjectMemoryMeaningfulLines,
    normalizeProjectMemoryMarkdown,
    sha256Hex
} from '../core/project-memory';

export { OPTIONAL_RULE_SUPPORT_FILES } from './rule-support-files';

interface SelectRuleSourceOptions {
    targetRoot: string;
    liveRuleRoot: string;
    templateRuleRoot: string;
}

interface RuleSourceSelection {
    path: string;
    origin: 'template' | 'live-existing' | 'legacy-docs';
}

interface ProjectMemorySummarySection {
    heading: string;
    content: string;
}

interface ProjectMemorySummaryOptions {
    maxSummaryChars?: number;
}

interface ProjectMemoryFileSnapshot {
    fileName: string;
    sourcePath: string;
    purpose: string;
    exists: boolean;
    status: 'missing' | 'unreadable' | 'empty' | 'template_seed' | 'placeholder_only' | 'content';
    sha256: string | null;
    charCount: number | null;
    sections: ProjectMemorySummarySection[];
    meaningfulLines: string[];
}

export const RULE_FILES = Object.freeze([
    '00-core.md', '10-project-context.md', '15-project-memory.md',
    '20-architecture.md', '30-code-style.md', '35-strict-coding-rules.md',
    '40-commands.md', '50-structure-and-docs.md', '60-operating-rules.md',
    '70-security.md', '80-task-workflow.md', '90-skill-catalog.md'
]);

export const GENERATED_RULE_FILES = Object.freeze(['15-project-memory.md']);

export const CONTEXT_RULE_FILES = Object.freeze([
    '10-project-context.md', '20-architecture.md', '30-code-style.md',
    '40-commands.md', '50-structure-and-docs.md', '60-operating-rules.md'
]);

export const DISCOVERY_AUGMENTED_RULE_FILES = CONTEXT_RULE_FILES;

export const LANGUAGE_PLACEHOLDER = '{{ASSISTANT_RESPONSE_LANGUAGE}}';
export const BREVITY_PLACEHOLDER = '{{ASSISTANT_RESPONSE_BREVITY}}';
export const MEANINGFUL_DIFF_THRESHOLD = 5;

export const LEGACY_BOOTSTRAP_CODE_STYLE_TEMPLATE = [
    '# Code Style',
    '',
    'Primary entry point: selected source-of-truth entrypoint for this workspace.',
    '',
    '## Purpose',
    'Define style rules for languages that actually exist in this repository.',
    '',
    '## Global Rules',
    '- Prefer small, testable functions and explicit naming.',
    '- Keep public APIs stable and documented.',
    '- Follow explicit project rules first, not vague habit or local drift.',
    '- If formatter or linter exists, treat it as source of truth.',
    '- Do not copy inconsistent, legacy, or obviously low-quality patterns just because they already exist in the repository.',
    '',
    '## Style Priority Order',
    '- Rules written in this file are the primary source of truth.',
    '- Formatter, linter, and static-analysis configs come next.',
    '- Strong, consistent patterns from high-quality project modules may refine local style decisions.',
    '- Common best practices are the fallback when project-specific guidance is missing.',
    '',
    '## Bootstrap Policy When Repository Is Empty',
    '- If there is little or no real project code yet, do not invent a silent style policy.',
    '- Ask the user a mandatory question: accept the default policy of explicit rules + tooling + common best practices, or provide custom project-specific style rules now.',
    '- Record that answer here before broad implementation starts.',
    '- If the default policy is accepted, state it explicitly instead of leaving the section vague.',
    '- As soon as stable project-specific rules exist, replace this bootstrap policy with concrete repository-specific guidance.',
    '',
    '## Language-Specific Rules (Fill Only Relevant Sections)',
    '',
    '### Java or Kotlin (if present)',
    '- DTO and domain mapping style: `TODO`',
    '- Null-safety and error handling approach: `TODO`',
    '- Transaction and persistence conventions: `TODO`',
    '',
    '### TypeScript or JavaScript (if present)',
    '- Type strictness level and runtime validation strategy: `TODO`',
    '- Component and state management conventions: `TODO`',
    '- API contract and schema handling: `TODO`',
    '',
    '### Python (if present)',
    '- Type hinting policy and linting rules: `TODO`',
    '- Async patterns and dependency management: `TODO`',
    '- Framework-specific conventions: `TODO`',
    '',
    '### Go (if present)',
    '- Package boundaries and interface patterns: `TODO`',
    '- Error wrapping and logging rules: `TODO`',
    '',
    '### Rust (if present)',
    '- Ownership and error handling conventions: `TODO`',
    '- Module and crate organization rules: `TODO`',
    '',
    '## Definition of Done for Style',
    '- Rules above must match actual stack from `live/project-discovery.md`.',
    '- Outdated language sections must be removed or explicitly marked as not applicable.'
].join('\n');

function normalizeSeedMarkdown(content: string): string {
    return String(content || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
}

function removeSectionByHeading(markdown: string, sectionHeading: string): string {
    const lines = markdown.split(/\r?\n/);
    const result: string[] = [];
    let skipping = false;

    for (const line of lines) {
        const h2 = line.match(/^## (.+)$/);
        if (h2) {
            skipping = h2[1].trim() === sectionHeading;
        }
        if (!skipping) {
            result.push(line);
        }
    }

    return result.join('\n');
}

export function getMeaningfulLines(text: string): string[] {
    let cleaned = stripHtmlComments(text);
    cleaned = removeSectionByHeading(cleaned, 'Project Discovery Snapshot');

    return cleaned
        .split(/\r?\n/)
        .map((line: string) => line.trim())
        .filter((line: string) =>
            line.length > 0 &&
            !line.match(/^#+\s/) &&
            line !== '```' &&
            line !== '```text' &&
            line !== '```bash' &&
            !line.match(/^\|[-:\s|]+\|$/) &&
            line !== '---' &&
            line !== '`TODO`' &&
            line !== 'TODO'
        );
}

export function countMeaningfulAddedLines(liveContent: string, templateContent: string): number {
    const templateSet = new Set(getMeaningfulLines(templateContent));
    const liveLines = getMeaningfulLines(liveContent);
    return liveLines.filter((line: string) => !templateSet.has(line)).length;
}

export function countLegacyBootstrapNovelLines(content: string, templateContent: string): number {
    const meaningfulLines = getMeaningfulLines(content);
    const knownBootstrapLines = new Set([
        ...getMeaningfulLines(LEGACY_BOOTSTRAP_CODE_STYLE_TEMPLATE),
        ...getMeaningfulLines(templateContent)
    ]);
    return meaningfulLines.filter((line) => !knownBootstrapLines.has(line)).length;
}

export function isBootstrapOnlyLegacyCodeStyleRule(content: string, templateContent: string): boolean {
    const normalized = normalizeSeedMarkdown(content);
    if (!normalized) {
        return false;
    }

    const stillLooksLikeLegacyBootstrap = normalized.includes('## Bootstrap Policy When Repository Is Empty')
        && normalized.includes('## Language-Specific Rules (Fill Only Relevant Sections)');

    return stillLooksLikeLegacyBootstrap
        && countLegacyBootstrapNovelLines(normalized, templateContent) <= MEANINGFUL_DIFF_THRESHOLD;
}

export function resolveTemplateProjectMemoryDir(projectMemoryDir: string): string | null {
    const templateDir = path.resolve(projectMemoryDir, '..', '..', '..', 'template', 'docs', 'project-memory');
    return pathExists(templateDir) ? templateDir : null;
}

export function isTemplateSeedProjectMemoryFile(projectMemoryDir: string, fileName: string, content: string): boolean {
    const templateDir = resolveTemplateProjectMemoryDir(projectMemoryDir);
    if (!templateDir) {
        return false;
    }
    const templatePath = path.join(templateDir, fileName);
    if (!pathExists(templatePath)) {
        return false;
    }

    const templateContent = readTextFile(templatePath);
    return normalizeProjectMemoryMarkdown(content) === normalizeProjectMemoryMarkdown(templateContent);
}

function resolveExistingRuleSourceCandidates(ruleFile: string, options: SelectRuleSourceOptions): RuleSourceSelection[] {
    const { targetRoot, liveRuleRoot, templateRuleRoot } = options;

    const legacyCandidate = path.join(targetRoot, 'docs/agent-rules', ruleFile);
    const liveCandidate = path.join(liveRuleRoot, ruleFile);
    const templateCandidate = path.join(templateRuleRoot, ruleFile);
    const isContextRule = CONTEXT_RULE_FILES.includes(ruleFile);
    const candidates: RuleSourceSelection[] = [];

    if (ruleFile === '00-core.md') {
        candidates.push(
            { path: templateCandidate, origin: 'template' },
            { path: liveCandidate, origin: 'live-existing' },
            { path: legacyCandidate, origin: 'legacy-docs' }
        );
    } else if (isContextRule) {
        candidates.push(
            { path: legacyCandidate, origin: 'legacy-docs' },
            { path: liveCandidate, origin: 'live-existing' },
            { path: templateCandidate, origin: 'template' }
        );
    } else {
        candidates.push(
            { path: liveCandidate, origin: 'live-existing' },
            { path: templateCandidate, origin: 'template' },
            { path: legacyCandidate, origin: 'legacy-docs' }
        );
    }

    return candidates.filter((candidate) => pathExists(candidate.path));
}

function resolveRuleSourceCandidates(ruleFile: string, options: SelectRuleSourceOptions): RuleSourceSelection[] {
    const { templateRuleRoot } = options;
    const templateCandidate = path.join(templateRuleRoot, ruleFile);
    const existingCandidates = resolveExistingRuleSourceCandidates(ruleFile, options);
    if (ruleFile !== '30-code-style.md' || !pathExists(templateCandidate)) {
        return existingCandidates;
    }

    const templateContent = readTextFile(templateCandidate);
    return existingCandidates.filter((candidate) => candidate.origin === 'template' || !isBootstrapOnlyLegacyCodeStyleRule(
        readTextFile(candidate.path),
        templateContent
    ));
}

/**
 * Selects the best source for a rule file following priority rules:
 * - 00-core.md: template > live > legacy
 * - Context rules (10-60): legacy > live > template
 * - Other rules: live > template > legacy
 */
export function selectRuleSource(ruleFile: string, options: SelectRuleSourceOptions): RuleSourceSelection | null {
    return resolveRuleSourceCandidates(ruleFile, options)[0] ?? null;
}

/**
 * Returns all existing source candidates for a rule file in the same priority
 * order used by selectRuleSource().
 */
export function selectRuleSources(ruleFile: string, options: SelectRuleSourceOptions): RuleSourceSelection[] {
    return resolveRuleSourceCandidates(ruleFile, options);
}

/**
 * Returns all existing source candidates for a rule file in priority order
 * without applying bootstrap-only legacy filtering. Use this when the caller
 * needs to inspect potentially disposable legacy content before deciding.
 */
export function selectRuleSourceCandidates(ruleFile: string, options: SelectRuleSourceOptions): RuleSourceSelection[] {
    return resolveExistingRuleSourceCandidates(ruleFile, options);
}

export function applyContextDefaults(content: string, ruleFile: string, discoveryOverlay: string | null | undefined): string {
    if (!DISCOVERY_AUGMENTED_RULE_FILES.includes(ruleFile) || !discoveryOverlay) {
        return content;
    }

    let updated = content.trimEnd();
    const overlayPattern = /^## Project Discovery Snapshot[\s\S]*?(?=^## |\z)/m;
    if (overlayPattern.test(updated)) {
        updated = updated.replace(overlayPattern, discoveryOverlay);
        return updated + '\r\n';
    }

    return updated + '\r\n\r\n' + discoveryOverlay + '\r\n';
}

function isReplaceableCompileGatePlaceholder(command: string): boolean {
    const normalized = command.trim();
    return normalized === UNCONFIGURED_COMPILE_GATE_COMMAND
        || /^<[^>]+>$/.test(normalized);
}

export function applyCompileGateCommandDefaults(content: string, ruleFile: string, suggestedCompileGateCommands: readonly string[]): string {
    if (ruleFile !== '40-commands.md') {
        return content;
    }

    const command = String(suggestedCompileGateCommands[0] || '').trim() || UNCONFIGURED_COMPILE_GATE_COMMAND;
    if (!command) {
        return content;
    }

    const sectionPattern = /(^### Compile Gate \(Mandatory\)[\s\S]*?```[^\r\n]*(?:\r?\n))([\s\S]*?)(\r?\n```)/m;
    const match = sectionPattern.exec(content);
    if (!match) {
        return content;
    }

    const bodyLines = match[2].split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const firstCommand = bodyLines.find((line) => !line.startsWith('#')) || '';
    if (firstCommand && !isReplaceableCompileGatePlaceholder(firstCommand)) {
        return content;
    }

    return content.replace(sectionPattern, `$1${command}$3`);
}

export function migrateLegacyOutputCompactionGuidance(content: string, templateContent: string): string {
    const legacyLine = '- At `depth=1` and `depth=2`, the implementation summary must include an output-compaction line; at `depth=3` it is optional. Use chars as the primary unit, keep approximate percentage when baseline is known, keep spaced breakdown formatting, and include token estimate only as a secondary note when available: `Suppressed output: ~3528 chars (~67%) (code review context ~3296 chars + DB review context ~100 chars + compile gate output ~132 chars). Token estimate: ~882.`';
    if (!content.includes(legacyLine)) return content;

    const replacement = templateContent.split(/\r?\n/).find((line) => (
        line.startsWith('- Do not add an agent-authored output-compaction line ')
    ));
    if (!replacement) return content;

    // Replace only the exact shipped legacy line; retain user wording and line endings.
    return content.replace(new RegExp(`^${escapeRegex(legacyLine)}(?=\\r?$)`, 'gm'), () => replacement);
}

export function migrateLegacyTaskTestSelectionGuidance(content: string, templateContent: string): string {
    const legacyLine = '- `garda workflow set` is a guarded workflow-config mutation surface and requires separate explicit operator approval with `--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`; agents must not approve workflow-config mutations for themselves.';
    const lines = templateContent.split(/\r?\n/u);
    const general = lines.find(line => line.startsWith('- Ordinary `garda workflow set` mutations '));
    const selection = lines.find(line => line.startsWith('- `task_test_selection.require_operator_confirmation` defaults '));
    if (!general || !selection) return content;
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    return content.replace(new RegExp(`^${escapeRegex(legacyLine)}(?=\\r?$)`, 'gm'), () => general + newline + selection);
}

export function applyAssistantDefaults(content: string, ruleFile: string, assistantLanguage: string, assistantBrevity: string): string {
    if (ruleFile !== '00-core.md') return content;

    let updated = content
        .replace(new RegExp(escapeRegex(LANGUAGE_PLACEHOLDER), 'g'), assistantLanguage)
        .replace(new RegExp(escapeRegex(BREVITY_PLACEHOLDER), 'g'), assistantBrevity);

    updated = updated.replace(
        /^Respond in .+ for explanations and assistance\.$/m,
        `Respond in ${assistantLanguage} for explanations and assistance.`
    );
    updated = updated.replace(
        /^1\. Respond in .+\.$/m,
        `1. Respond in ${assistantLanguage}.`
    );
    updated = updated.replace(
        /^Default response brevity: .+\.$/m,
        `Default response brevity: ${assistantBrevity}.`
    );
    updated = updated.replace(
        /^2\. Keep responses .+ unless the user explicitly asks for more or less detail\.$/m,
        `2. Keep responses ${assistantBrevity} unless the user explicitly asks for more or less detail.`
    );

    return updated;
}

function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function getProjectMemoryPurpose(fileName: string): string {
    return PROJECT_MEMORY_FILE_DEFINITIONS.find((definition) => definition.fileName === fileName)?.purpose
        || 'Custom durable project-memory file.';
}

function getSummaryFileNames(entries: fs.Dirent[]): string[] {
    const required = new Set<string>(PROJECT_MEMORY_REQUIRED_FILE_NAMES);
    const extraFiles = entries
        .filter((entry) => {
            const lowerName = entry.name.toLowerCase();
            return entry.isFile()
                && lowerName.endsWith('.md')
                && !lowerName.endsWith('.template.md')
                && !required.has(entry.name);
        })
        .map((entry) => entry.name)
        .sort();

    return [...PROJECT_MEMORY_REQUIRED_FILE_NAMES, ...extraFiles];
}

function snapshotProjectMemoryFile(projectMemoryDir: string, fileName: string): ProjectMemoryFileSnapshot {
    const sourcePath = buildProjectMemorySourceRelativePath(fileName);
    const filePath = path.join(projectMemoryDir, fileName);
    if (!pathExists(filePath)) {
        return {
            fileName,
            sourcePath,
            purpose: getProjectMemoryPurpose(fileName),
            exists: false,
            status: 'missing',
            sha256: null,
            charCount: null,
            sections: [],
            meaningfulLines: []
        };
    }

    let raw: string;
    try {
        raw = readTextFile(filePath);
    } catch {
        return {
            fileName,
            sourcePath,
            purpose: getProjectMemoryPurpose(fileName),
            exists: true,
            status: 'unreadable',
            sha256: null,
            charCount: null,
            sections: [],
            meaningfulLines: []
        };
    }

    if (isTemplateSeedProjectMemoryFile(projectMemoryDir, fileName, raw)) {
        return {
            fileName,
            sourcePath,
            purpose: getProjectMemoryPurpose(fileName),
            exists: true,
            status: 'template_seed',
            sha256: sha256Hex(raw),
            charCount: raw.length,
            sections: [],
            meaningfulLines: []
        };
    }

    const sections = extractNonEmptySections(raw);
    const meaningfulLines = getProjectMemoryMeaningfulLines(raw);
    const status = raw.trim().length === 0
        ? 'empty'
        : meaningfulLines.length === 0
            ? 'placeholder_only'
            : 'content';

    return {
        fileName,
        sourcePath,
        purpose: getProjectMemoryPurpose(fileName),
        exists: true,
        status,
        sha256: sha256Hex(raw),
        charCount: raw.length,
        sections,
        meaningfulLines
    };
}

function truncateSummaryText(text: string, maxLength = 180): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function isTaskIdMemoryHeading(heading: string): boolean {
    return /^T-\d+(?:[-\w]*)?\b/i.test(heading);
}

function formatProjectMemorySectionList(sections: ProjectMemorySummarySection[]): string {
    const mapSections = sections.filter((section) => !isTaskIdMemoryHeading(section.heading));
    const taskHeadingCount = sections.length - mapSections.length;
    if (mapSections.length > 0) {
        return [
            mapSections.map((section) => section.heading).join(', '),
            taskHeadingCount > 0 ? `${taskHeadingCount} task-id provenance heading(s) hidden` : ''
        ].filter(Boolean).join('; ');
    }
    if (taskHeadingCount > 0) {
        return `${taskHeadingCount} task-id provenance heading(s) hidden`;
    }
    return 'n/a';
}

function buildSectionPreviewLines(snapshot: ProjectMemoryFileSnapshot): string[] {
    const lines: string[] = [];
    const taskHeadingCount = snapshot.sections
        .filter((section) => isTaskIdMemoryHeading(section.heading))
        .length;
    const mapSections = snapshot.sections
        .filter((section) => !isTaskIdMemoryHeading(section.heading));
    const previewSections = mapSections.slice(0, 3);
    for (const section of previewSections) {
        const meaningfulLines = getProjectMemoryMeaningfulLines(section.content);
        const firstLine = meaningfulLines[0];
        if (!firstLine) {
            continue;
        }
        lines.push(`- ${section.heading}: ${truncateSummaryText(firstLine)}`);
    }
    if (taskHeadingCount > 0) {
        lines.push('- Task-id headings detected in source memory; treat them as provenance/history and prefer domain map headings.');
    }
    if (mapSections.length > 3) {
        lines.push(`- Additional sections: ${mapSections.length - 3}`);
    }
    if (lines.length === 0 && snapshot.meaningfulLines.length > 0) {
        for (const line of snapshot.meaningfulLines.slice(0, 3)) {
            lines.push(`- ${truncateSummaryText(line)}`);
        }
        if (snapshot.meaningfulLines.length > 3) {
            lines.push(`- Additional meaningful lines: ${snapshot.meaningfulLines.length - 3}`);
        }
    }
    return lines;
}

function formatHash(hash: string | null): string {
    return hash ? `\`${hash}\`` : '`n/a`';
}

interface BoundedLineState {
    lines: string[];
    usedChars: number;
    maxChars: number;
    truncated: boolean;
}

function createBoundedLineState(maxChars: number): BoundedLineState {
    return {
        lines: [],
        usedChars: 0,
        maxChars,
        truncated: false
    };
}

function pushBoundedLine(state: BoundedLineState, line: string): boolean {
    const separatorLength = state.lines.length === 0 ? 0 : 2;
    const nextLength = state.usedChars + separatorLength + line.length;
    if (nextLength > state.maxChars) {
        state.truncated = true;
        return false;
    }
    state.lines.push(line);
    state.usedChars = nextLength;
    return true;
}

function pushBoundedLines(state: BoundedLineState, lines: string[]): void {
    for (const line of lines) {
        if (!pushBoundedLine(state, line)) {
            return;
        }
    }
}

/**
 * Generates a read-only, bounded, link-first summary of project-memory sources for agent-rules.
 * If the directory is absent or has no substantive content, returns a status-oriented stub.
 */
export function generateProjectMemorySummary(
    projectMemoryDir: string,
    timestampIso: string,
    options: ProjectMemorySummaryOptions = {}
): string {
    const HEADER = '<!-- DO NOT EDIT — regenerated from project-memory/ -->';
    const TITLE = '# 15 · Project Memory Summary';
    const maxSummaryChars = Math.max(500, options.maxSummaryChars ?? DEFAULT_PROJECT_MEMORY_GENERATED_SUMMARY_MAX_CHARS);
    const lines = createBoundedLineState(maxSummaryChars);

    pushBoundedLines(lines, [
        HEADER, '',
        TITLE, '',
        `Generated at: ${timestampIso}`, '',
        '> Auto-generated from `docs/project-memory/`. Edit source files there;',
        '> this summary regenerates on every init, reinit, and update.',
        '> This is a link-first orientation index, not a full copy of project memory.', '',
        '## Map Contract', '',
        `- ${PROJECT_MEMORY_MAP_READ_GUIDANCE}`,
        `- ${PROJECT_MEMORY_MAP_WRITE_CONTRACT}`, ''
    ]);

    if (!pathExists(projectMemoryDir)) {
        pushBoundedLines(lines, [
            '## Status', '',
            'No `docs/project-memory/` directory found.',
            'Populate it with project knowledge files to enable this summary.', '',
            'Run init or reinit to seed the default category templates.'
        ]);
        return lines.lines.join('\r\n');
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(projectMemoryDir, { withFileTypes: true });
    } catch {
        pushBoundedLines(lines, [
            '## Status', '',
            'Could not read `docs/project-memory/` directory.'
        ]);
        return lines.lines.join('\r\n');
    }

    const mdFiles = getSummaryFileNames(entries);
    const snapshots = mdFiles.map((fileName) => snapshotProjectMemoryFile(projectMemoryDir, fileName));
    const existingMarkdownCount = snapshots.filter((snapshot) => snapshot.exists).length;
    const contentSnapshots = snapshots.filter((snapshot) => snapshot.status === 'content');

    if (existingMarkdownCount === 0) {
        pushBoundedLines(lines, [
            '## Status', '',
            '`docs/project-memory/` contains no content files yet.',
            'Populate it with project knowledge to enable this summary.', '',
            'Read-first files: `README.md`, then `compact.md`.',
            'Available category templates: `context.md`, `stack.md`, `architecture.md`, `module-map.md`, `commands.md`, `conventions.md`, `decisions.md`, `risks.md`.'
        ]);
        return lines.lines.join('\r\n');
    }

    pushBoundedLines(lines, [
        '## Read Order', '',
        '1. Read `docs/project-memory/README.md`.',
        '2. Read `docs/project-memory/compact.md`.',
        '3. Read only focused memory files relevant to the task.',
        '4. Verify memory facts against source, tests, config, and docs before changing behavior.', '',
        '## Source Index', '',
        '| File | Purpose | Status | Chars | Sections |',
        '|---|---|---|---:|---|'
    ]);

    for (const snapshot of snapshots) {
        const sectionList = formatProjectMemorySectionList(snapshot.sections);
        pushBoundedLine(lines, `| \`${snapshot.sourcePath}\` | ${escapeMarkdownTableCell(snapshot.purpose)} | ${snapshot.status} | ${snapshot.charCount ?? 0} | ${escapeMarkdownTableCell(sectionList)} |`);
    }

    if (contentSnapshots.length === 0) {
        pushBoundedLines(lines, [
            '',
            '## Status', '',
            'All `docs/project-memory/` files exist but contain only placeholder templates.',
            'Fill in the sections with real project knowledge to enable this summary.', '',
            'Read-first files: `README.md`, then `compact.md`.',
            'Available category templates: `context.md`, `stack.md`, `architecture.md`, `module-map.md`, `commands.md`, `conventions.md`, `decisions.md`, `risks.md`.'
        ]);
    } else {
        pushBoundedLines(lines, ['', '## Content Highlights', '']);
        for (const snapshot of contentSnapshots) {
            pushBoundedLines(lines, [
                `### \`${snapshot.fileName}\``,
                `- Source: \`${snapshot.sourcePath}\``,
                `- SHA-256: ${formatHash(snapshot.sha256)}`,
                `- Sections: ${formatProjectMemorySectionList(snapshot.sections)}`
            ]);
            const previewLines = buildSectionPreviewLines(snapshot);
            if (previewLines.length > 0) {
                pushBoundedLines(lines, previewLines);
            }
            pushBoundedLine(lines, '');
        }
    }

    pushBoundedLines(lines, [
        '---', '',
        '## Provenance', '',
        '| File | Source | SHA-256 | Status |',
        '|---|---|---|---|'
    ]);
    for (const snapshot of snapshots) {
        pushBoundedLine(lines, `| \`${snapshot.fileName}\` | \`${snapshot.sourcePath}\` | ${formatHash(snapshot.sha256)} | ${snapshot.status} |`);
    }

    if (lines.truncated) {
        pushBoundedLine(lines, '');
        pushBoundedLine(lines, '> Summary truncated to the configured generated project-memory budget. Read source files directly for details.');
    }

    return lines.lines.join('\r\n');
}

/**
 * Extracts level-2 heading sections that have non-empty content after stripping HTML comments.
 * Comments are stripped from the full text first so headings inside comments are ignored.
 */
export function extractNonEmptySections(markdown: string): ProjectMemorySummarySection[] {
    const cleaned = stripHtmlComments(markdown);
    const lines = cleaned.split(/\r?\n/);
    const sections: ProjectMemorySummarySection[] = [];
    let currentHeading: string | null = null;
    let currentLines: string[] = [];

    for (const line of lines) {
        const h2Match = line.match(/^##\s+(.+)$/);
        if (h2Match) {
            if (currentHeading !== null) {
                const content = currentLines.join('\n').trim();
                if (content) {
                    sections.push({ heading: currentHeading, content });
                }
            }
            currentHeading = h2Match[1].trim();
            currentLines = [];
        } else if (currentHeading !== null) {
            currentLines.push(line);
        }
    }

    if (currentHeading !== null) {
        const content = currentLines.join('\n').trim();
        if (content) {
            sections.push({ heading: currentHeading, content });
        }
    }

    return sections;
}

export function stripHtmlComments(text: string): string {
    return text.replace(/<!--[\s\S]*?-->/g, '');
}
