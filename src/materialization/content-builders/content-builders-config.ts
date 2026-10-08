import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { normalizeLineEndings } from '../../core/line-endings';
import { resolveBundleName } from '../../core/constants';
import { getManagedGitignoreEntries, getManagedGitignoreCleanupEntries } from '../common';
import {
    AGENTIGNORE_ACTIVE_MANAGED_COMMENT,
    escapeRegex,
    getClaudeOrchestratorAllowEntries,
    getLegacyUninstallBackupGitignoreEntry,
    getUninstallBackupGitignoreEntry,
    GITIGNORE_MANAGED_COMMENT,
    GitignoreManagedBlockSyncResult,
    isRecord,
    MANAGED_END,
    MANAGED_START,
    ManagedBlockSyncResult,
    ProviderOrchestratorProfileLike,
    SettingsBuildResult,
    SettingsParseMode,
    UNINSTALL_BACKUP_GITIGNORE_COMMENT
} from './content-builders-shared';

export function stripJsoncComments(text: string): string {
    // Pass 1: strip comments (string-aware)
    let stripped = '';
    let i = 0;
    while (i < text.length) {
        if (text[i] === '"') {
            const start = i;
            i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\') i++;
                i++;
            }
            i++;
            stripped += text.slice(start, i);
        } else if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '*') {
            i += 2;
            while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2;
        } else {
            stripped += text[i];
            i++;
        }
    }

    // Pass 2: remove trailing commas (string-aware)
    let result = '';
    i = 0;
    while (i < stripped.length) {
        if (stripped[i] === '"') {
            const start = i;
            i++;
            while (i < stripped.length && stripped[i] !== '"') {
                if (stripped[i] === '\\') i++;
                i++;
            }
            i++;
            result += stripped.slice(start, i);
        } else if (stripped[i] === ',') {
            let j = i + 1;
            while (j < stripped.length && /\s/.test(stripped[j])) j++;
            if (j < stripped.length && (stripped[j] === '}' || stripped[j] === ']')) {
                // Trailing comma — skip it, preserve whitespace
                result += stripped.slice(i + 1, j);
                i = j;
            } else {
                result += stripped[i];
                i++;
            }
        } else {
            result += stripped[i];
            i++;
        }
    }
    return result;
}

export function buildQwenSettingsContent(
    existingContent: string | null | undefined,
    requiredEntries: string[] | null | undefined
): SettingsBuildResult {
    const entries = (requiredEntries || [TASK_QUEUE_FILENAME, 'AGENTS.md']).filter((entry: string) => Boolean(entry && entry.trim()));
    const unique = [...new Set(entries)];
    let settingsMap: Record<string, unknown> = {};
    let needsUpdate = false;
    let parseMode: SettingsParseMode = 'default';

    if (existingContent && existingContent.trim()) {
        try {
            const parsed: unknown = JSON.parse(existingContent);
            if (isRecord(parsed)) {
                settingsMap = parsed;
                parseMode = 'merge-existing';
            } else {
                needsUpdate = true;
                parseMode = 'invalid-root';
            }
        } catch {
            needsUpdate = true;
            parseMode = 'invalid-json';
        }
    } else {
        needsUpdate = true;
    }

    const existingContext = settingsMap.context;
    const contextMap: Record<string, unknown> = isRecord(existingContext) ? existingContext : {};
    if (!isRecord(existingContext)) {
        settingsMap.context = contextMap;
        needsUpdate = true;
    }

    const currentEntries: string[] = [];
    const fileNameValue = contextMap.fileName;
    if (Array.isArray(fileNameValue)) {
        for (const item of fileNameValue) {
            if (item != null && String(item).trim()) {
                currentEntries.push(String(item).trim());
            }
        }
    }

    const existingSet = new Set(currentEntries.map((e) => e.toLowerCase()));
    for (const entry of unique) {
        if (!existingSet.has(entry.toLowerCase())) {
            currentEntries.push(entry);
            existingSet.add(entry.toLowerCase());
            needsUpdate = true;
        }
    }

    contextMap.fileName = currentEntries;
    return {
        content: JSON.stringify(settingsMap, null, 2),
        needsUpdate,
        parseMode
    };
}

export function buildClaudeLocalSettingsContent(
    existingContent: string | null | undefined,
    enableOrchestratorAccess: boolean
): SettingsBuildResult {
    const requiredAllowEntries = enableOrchestratorAccess ? [...getClaudeOrchestratorAllowEntries()] : [];
    let settingsMap: Record<string, unknown> = {};
    let needsUpdate = false;
    let parseMode: SettingsParseMode = 'default';

    if (existingContent && existingContent.trim()) {
        try {
            const parsed: unknown = JSON.parse(existingContent);
            if (isRecord(parsed)) {
                settingsMap = parsed;
                parseMode = 'merge-existing';
            } else {
                needsUpdate = true;
                parseMode = 'invalid-root';
            }
        } catch {
            needsUpdate = true;
            parseMode = 'invalid-json';
        }
    } else {
        needsUpdate = true;
    }

    const existingPermissions = settingsMap.permissions;
    const permissionsMap: Record<string, unknown> = isRecord(existingPermissions) ? existingPermissions : {};
    if (!isRecord(existingPermissions)) {
        settingsMap.permissions = permissionsMap;
        needsUpdate = true;
    }

    const allowEntries: string[] = [];
    const allowValue = permissionsMap.allow;
    if (Array.isArray(allowValue)) {
        for (const item of allowValue) {
            if (item != null && String(item).trim()) {
                allowEntries.push(String(item).trim());
            }
        }
    }

    const existingSet = new Set(allowEntries.map((e) => e.toLowerCase()));
    for (const entry of requiredAllowEntries) {
        if (!existingSet.has(entry.toLowerCase())) {
            allowEntries.push(entry);
            existingSet.add(entry.toLowerCase());
            needsUpdate = true;
        }
    }

    permissionsMap.allow = allowEntries;
    return {
        content: JSON.stringify(settingsMap, null, 2),
        needsUpdate,
        parseMode
    };
}

/**
 * Computes the set of .gitignore entries needed for a given configuration.
 *
 * When `providerMinimalism` is true, the base set is scoped to active providers only
 * instead of the full superset of all known providers.
 */
export function buildGitignoreEntries(
    activeEntryFiles: string[],
    providerOrchestratorProfiles: ProviderOrchestratorProfileLike[],
    enableClaudeOrchestratorFullAccess: boolean,
    includeQwenDirectory = false,
    providerMinimalism = false
): string[] {
    const scopedActiveFiles = providerMinimalism ? activeEntryFiles : undefined;
    const entries = new Set<string>(getManagedGitignoreEntries(enableClaudeOrchestratorFullAccess, scopedActiveFiles));

    if (includeQwenDirectory) {
        entries.add('.qwen/');
    }

    for (const entryFile of activeEntryFiles) {
        const normalized = entryFile.replace(/\\/g, '/');
        entries.add(normalized);
    }

    for (const profile of providerOrchestratorProfiles) {
        for (const entry of profile.gitignoreEntries) {
            entries.add(entry);
        }
    }

    return [...entries].sort();
}

export function buildManagedGitignoreBlock(entries: string[] | null | undefined, newline = '\n'): string {
    const normalizedEntries = [...new Set((entries || []).filter((entry) => Boolean(entry && String(entry).trim())).map((entry) => String(entry)))].sort();
    return [GITIGNORE_MANAGED_COMMENT, ...normalizedEntries].join(newline);
}

export function getManagedAgentignoreActiveEntries(bundleName = resolveBundleName()): string[] {
    return [
        `${bundleName}/dist/`,
        `${bundleName}/src/`,
        `${bundleName}/template/`,
        `${bundleName}/runtime/update-rollbacks/`,
        `${bundleName}/runtime/tmp/`,
        `${bundleName}/runtime/metrics/`,
        `${bundleName}/runtime/full-suite/`,
        `${bundleName}/runtime/scoped-diffs/`,
        `${bundleName}/runtime/reviews/*-review-context.md`,
        `${bundleName}/runtime/reviews/*-review-input.md`,
        `${bundleName}/runtime/reviews/*-review-scratch.md`,
        `${bundleName}/runtime/task-events/index*.json`,
        `${bundleName}/runtime/task-events/*-aggregate.json`,
        `${bundleName}/runtime/timeline-summaries/`
    ];
}

function countMarkerOccurrences(content: string, marker: string): number {
    return content.split(marker).length - 1;
}

function getManagedBlockRegex(flags = 'gm'): RegExp {
    return new RegExp(`${escapeRegex(MANAGED_START)}[\\s\\S]*?${escapeRegex(MANAGED_END)}`, flags);
}

function assertCompleteManagedMarkers(content: string, relativePath: string): void {
    const startCount = countMarkerOccurrences(content, MANAGED_START);
    const endCount = countMarkerOccurrences(content, MANAGED_END);
    if (startCount !== endCount) {
        throw new Error(`${relativePath}: managed block markers are incomplete`);
    }
}

function buildManagedAgentignoreActiveBlock(bundleName: string, newline: string): string {
    return [
        MANAGED_START,
        AGENTIGNORE_ACTIVE_MANAGED_COMMENT,
        ...getManagedAgentignoreActiveEntries(bundleName),
        MANAGED_END
    ].join(newline);
}

export function syncManagedAgentignoreActiveBlockInContent(
    content: string | null | undefined,
    bundleName = resolveBundleName()
): ManagedBlockSyncResult {
    const originalContent = content || '';
    const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
    assertCompleteManagedMarkers(originalContent, '.agentignore');

    const block = buildManagedAgentignoreActiveBlock(bundleName, newline);
    const managedBlockRegex = getManagedBlockRegex('gm');
    const activeBlockCount = [...originalContent.matchAll(managedBlockRegex)]
        .filter((match) => match[0].includes(AGENTIGNORE_ACTIVE_MANAGED_COMMENT))
        .length;
    if (activeBlockCount > 1) {
        throw new Error('.agentignore: multiple Garda active-mode managed blocks found');
    }

    let updatedContent: string;
    if (!originalContent.trim()) {
        updatedContent = `${block}${newline}`;
    } else if (activeBlockCount === 1) {
        updatedContent = originalContent.replace(
            getManagedBlockRegex('gm'),
            (existingBlock) => existingBlock.includes(AGENTIGNORE_ACTIVE_MANAGED_COMMENT) ? block : existingBlock
        );
        if (!updatedContent.endsWith(newline)) {
            updatedContent += newline;
        }
    } else {
        const prefix = originalContent.endsWith(newline) ? originalContent : `${originalContent}${newline}`;
        updatedContent = `${prefix}${block}${newline}`;
    }

    return {
        content: updatedContent,
        changed: updatedContent !== originalContent
    };
}

function normalizeUninstallBackupGitignoreLines(lines: string[]): string[] {
    const normalizedLines: string[] = [];
    let emittedBackupEntry = false;

    for (const line of lines) {
        const trimmed = line.trim();
        const isBackupLine = trimmed === UNINSTALL_BACKUP_GITIGNORE_COMMENT ||
            trimmed === getUninstallBackupGitignoreEntry() ||
            trimmed === getLegacyUninstallBackupGitignoreEntry();
        if (!isBackupLine) {
            normalizedLines.push(line);
            continue;
        }

        if (!emittedBackupEntry) {
            normalizedLines.push(UNINSTALL_BACKUP_GITIGNORE_COMMENT, getUninstallBackupGitignoreEntry());
            emittedBackupEntry = true;
        }
    }

    return normalizedLines;
}

function normalizeGitignoreComparableEntry(entry: string | null | undefined): string | null {
    if (!entry) {
        return null;
    }

    const trimmed = entry.trim();
    if (!trimmed || trimmed.startsWith('#')) {
        return null;
    }
    return trimmed;
}

export function hasManagedGitignoreEntry(existingEntries: ReadonlySet<string>, entry: string): boolean {
    if (existingEntries.has(entry)) {
        return true;
    }

    // Managed control paths require root coverage; global globs retain their original scope.
    const segments = entry.replace(/\/$/, '').split('/');
    const literalRootPath = Boolean(entry) && !entry.startsWith('/') &&
        !entry.startsWith('#') && !entry.startsWith('!') && !/[\\*?[\]\s]/.test(entry) &&
        !segments.some(segment => !segment || segment === '.' || segment === '..');
    return literalRootPath && existingEntries.has(`/${entry}`);
}

export function syncManagedGitignoreBlockInContent(
    content: string | null | undefined,
    entries: string[],
    enableClaudeOrchestratorFullAccess: boolean
): GitignoreManagedBlockSyncResult {
    const originalContent = content || '';
    const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
    const normalizedContent = normalizeLineEndings(originalContent, '\n');
    const rawLines = normalizedContent.length > 0 ? normalizedContent.split('\n') : [];
    const lines = normalizeUninstallBackupGitignoreLines(rawLines);
    const cleanupEntrySet = new Set(getManagedGitignoreCleanupEntries(enableClaudeOrchestratorFullAccess));
    const canonicalEntries = [...new Set(entries)].sort();
    const canonicalComparableEntries = canonicalEntries
        .map((entry) => ({ entry, normalized: normalizeGitignoreComparableEntry(entry) }))
        .filter((item): item is { entry: string; normalized: string } => Boolean(item.normalized));

    let existingManagedEntries: string[] = [];
    const preservedLines: string[] = [];
    let insertionIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === GITIGNORE_MANAGED_COMMENT) {
            if (insertionIndex < 0) {
                insertionIndex = preservedLines.length;
            }
            let j = i + 1;
            while (j < lines.length && cleanupEntrySet.has(lines[j])) {
                existingManagedEntries.push(lines[j]);
                j++;
            }
            i = j - 1;
            continue;
        }
        preservedLines.push(lines[i]);
    }

    const userOwnedComparableEntries = new Set<string>();
    for (const line of preservedLines) {
        const normalized = normalizeGitignoreComparableEntry(line);
        if (normalized) {
            userOwnedComparableEntries.add(normalized);
        }
    }

    const userOwnedRawEntries = new Set(preservedLines);
    const managedEntries = canonicalComparableEntries
        .filter((item) => !userOwnedComparableEntries.has(item.normalized) &&
            !hasManagedGitignoreEntry(userOwnedRawEntries, item.entry))
        .map((item) => item.entry);

    const canonicalBlockLines = [GITIGNORE_MANAGED_COMMENT, ...managedEntries];
    const existingManagedComparableEntries = new Set(
        existingManagedEntries
            .map((entry) => normalizeGitignoreComparableEntry(entry))
            .filter((entry): entry is string => Boolean(entry))
    );
    const addedEntries = managedEntries.filter((entry) => {
        const normalized = normalizeGitignoreComparableEntry(entry);
        return normalized ? !existingManagedComparableEntries.has(normalized) : false;
    }).length;

    let updatedLines: string[];
    if (insertionIndex >= 0) {
        updatedLines = [
            ...preservedLines.slice(0, insertionIndex),
            ...canonicalBlockLines,
            ...preservedLines.slice(insertionIndex)
        ];
    } else if (lines.length === 0) {
        updatedLines = canonicalBlockLines;
    } else {
        updatedLines = [...preservedLines];
        if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] !== '') {
            updatedLines.push('');
        }
        updatedLines.push(...canonicalBlockLines);
    }

    let updatedContent = updatedLines.join('\n');
    updatedContent = normalizeLineEndings(updatedContent, newline);
    if (updatedContent && !updatedContent.endsWith(newline)) {
        updatedContent += newline;
    }

    return {
        content: updatedContent,
        changed: updatedContent !== originalContent,
        addedEntries
    };
}

/**
 * Synchronizes a managed block into a file's content.
 * If the file already contains a managed block, replace it in place.
 * If the file has unrelated legacy content and no managed block, replace the file
 * entirely so the previous content lives only in install backups instead of being
 * merged with the new orchestrator contract.
 */
export function syncManagedBlockInContent(content: string | null | undefined, managedBlock: string): ManagedBlockSyncResult {
    const pattern = new RegExp(
        `${escapeRegex(MANAGED_START)}[\\s\\S]*?${escapeRegex(MANAGED_END)}`, 'm'
    );

    let newContent;
    if (pattern.test(content || '')) {
        newContent = (content || '').replace(pattern, managedBlock);
    } else if (!content || !content.trim()) {
        newContent = managedBlock + '\r\n';
    } else {
        newContent = managedBlock + '\r\n';
    }

    return { content: newContent, changed: newContent !== (content || '') };
}

/**
 * Directories that IDEs and language services should not index in workspaces
 * where Garda Agent Orchestrator is present.
 */
export const IDE_EXCLUDED_DIRECTORIES: readonly string[] = Object.freeze([
    resolveBundleName(),
    'dist',
    '.node-build',
    '.scripts-build',
    'node_modules',
    'runtime'
]);

/**
 * Merges IDE exclude patterns into VS Code settings JSON.
 * Adds entries under files.exclude, search.exclude, and files.watcherExclude
 * so generated/heavy directories do not degrade IDE responsiveness.
 */
export function buildVscodeSettingsContent(
    existingContent: string | null | undefined
): SettingsBuildResult {
    let settingsMap: Record<string, unknown> = {};
    let needsUpdate = false;
    let parseMode: SettingsParseMode = 'default';

    if (existingContent && existingContent.trim()) {
        try {
            const stripped = stripJsoncComments(existingContent);
            const parsed: unknown = JSON.parse(stripped);
            if (isRecord(parsed)) {
                settingsMap = parsed;
                parseMode = 'merge-existing';
            } else {
                needsUpdate = true;
                parseMode = 'invalid-root';
            }
        } catch {
            needsUpdate = true;
            parseMode = 'invalid-json';
        }
    } else {
        needsUpdate = true;
    }

    const excludeKeys = ['files.exclude', 'search.exclude', 'files.watcherExclude'] as const;
    for (const key of excludeKeys) {
        const existing = settingsMap[key];
        const map: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
        for (const dir of IDE_EXCLUDED_DIRECTORIES) {
            const pattern = `**/${dir}`;
            if (map[pattern] !== true) {
                map[pattern] = true;
                needsUpdate = true;
            }
        }
        settingsMap[key] = map;
    }

    return {
        content: JSON.stringify(settingsMap, null, 2),
        needsUpdate,
        parseMode
    };
}
