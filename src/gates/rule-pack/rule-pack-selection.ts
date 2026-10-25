import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { selectRulePackFiles } from '../review-context/review-context-token-economy';
import { fileSha256, normalizePath, resolvePathInsideRepo } from '../shared/helpers';
import { resolveGateExecutionPath } from '../isolation/isolation-sandbox';
import {
    RULE_PACK_STAGE_KEYS,
    type RulePackStageLabel
} from './rule-pack-types';
import { isRecord } from './rule-pack-records';

export const TASK_ENTRY_FULL_RULE_FILE_NAMES = Object.freeze([
    '00-core.md',
    '15-project-memory.md',
    '40-commands.md',
    '80-task-workflow.md',
    '90-skill-catalog.md'
]);

export const TASK_ENTRY_DEPTH1_RULE_FILE_NAMES = Object.freeze([
    '00-core.md',
    '40-commands.md',
    '80-task-workflow.md'
]);

export interface TaskEntryRulePackSelectionOptions {
    effectiveDepth?: number | null;
}

export function getRulePackStageKey(stage: RulePackStageLabel): 'task_entry' | 'post_preflight' {
    return RULE_PACK_STAGE_KEYS[stage];
}

export function getRulePackRulesRoot(repoRoot: string): string {
    return resolveGateExecutionPath(repoRoot, path.join('live', 'docs', 'agent-rules'));
}

function normalizeEffectiveDepth(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    const normalized = Math.floor(value);
    return normalized >= 1 ? normalized : null;
}

export function selectTaskEntryRulePackFileNames(
    options: TaskEntryRulePackSelectionOptions = {}
): string[] {
    const effectiveDepth = normalizeEffectiveDepth(options.effectiveDepth);
    if (effectiveDepth === 1) {
        return [...TASK_ENTRY_DEPTH1_RULE_FILE_NAMES];
    }
    return [...TASK_ENTRY_FULL_RULE_FILE_NAMES];
}

export function getRulePackRequiredEntryFiles(
    repoRoot: string,
    effectiveDepth?: number | null
): string[] {
    const rulesRoot = getRulePackRulesRoot(repoRoot);
    return selectTaskEntryRulePackFileNames({ effectiveDepth }).map(function (fileName) {
        return normalizePath(path.join(rulesRoot, fileName));
    }).sort();
}

export function getLegacyTaskEntryRulePackFiles(repoRoot: string): string[] {
    const rulesRoot = getRulePackRulesRoot(repoRoot);
    return TASK_ENTRY_FULL_RULE_FILE_NAMES.map(function (fileName) {
        return normalizePath(path.join(rulesRoot, fileName));
    }).sort();
}

function hasStringSetSuperset(candidate: string[], required: string[]): boolean {
    const candidateSet = new Set(candidate.map(function (item) {
        return item.toLowerCase();
    }));
    return required.every(function (item) {
        return candidateSet.has(item.toLowerCase());
    });
}

export function isCompatibleTaskEntryRuleFileSet(
    repoRoot: string,
    recordedRuleFiles: readonly string[],
    effectiveDepth?: number | null
): boolean {
    const normalizedRecorded = [...recordedRuleFiles].map(function (item) {
        return normalizePath(item);
    }).sort();
    const requiredRuleFiles = getRulePackRequiredEntryFiles(repoRoot, effectiveDepth);
    if (sameStringSet(normalizedRecorded, requiredRuleFiles)) {
        return true;
    }

    const legacyRuleFiles = getLegacyTaskEntryRulePackFiles(repoRoot);
    return sameStringSet(normalizedRecorded, legacyRuleFiles)
        && hasStringSetSuperset(normalizedRecorded, requiredRuleFiles);
}

export function getLegacyPostPreflightRulePackFiles(
    repoRoot: string,
    requiredReviews: Record<string, boolean>,
    effectiveDepth?: number | null
): string[] {
    const depth = normalizeEffectiveDepth(effectiveDepth) || 2;
    const fileNames = new Set<string>(TASK_ENTRY_FULL_RULE_FILE_NAMES);
    for (const [reviewType, required] of Object.entries(requiredReviews)) {
        if (!required) {
            continue;
        }
        for (const fileName of selectRulePackFiles(reviewType, depth)) {
            fileNames.add(fileName);
        }
    }

    const rulesRoot = getRulePackRulesRoot(repoRoot);
    return [...fileNames].map(function (fileName) {
        return normalizePath(path.join(rulesRoot, fileName));
    }).sort();
}

export function isCompatiblePostPreflightRuleFileSet(
    repoRoot: string,
    recordedRuleFiles: readonly string[],
    requiredReviews: Record<string, boolean>,
    effectiveDepth?: number | null
): boolean {
    const depth = normalizeEffectiveDepth(effectiveDepth) || 2;
    const normalizedRecorded = [...recordedRuleFiles].map(function (item) {
        return normalizePath(item);
    }).sort();
    const requiredRuleFiles = getRulePackRequiredFilesFromPreflight(repoRoot, requiredReviews, depth);
    if (sameStringSet(normalizedRecorded, requiredRuleFiles)) {
        return true;
    }

    const legacyRuleFiles = getLegacyPostPreflightRulePackFiles(repoRoot, requiredReviews, depth);
    return sameStringSet(normalizedRecorded, legacyRuleFiles)
        && hasStringSetSuperset(normalizedRecorded, requiredRuleFiles);
}

export function getRulePackRequiredFilesFromPreflight(
    repoRoot: string,
    requiredReviews: Record<string, boolean>,
    effectiveDepth: number
): string[] {
    const fileNames = new Set<string>(selectTaskEntryRulePackFileNames({ effectiveDepth }));
    for (const [reviewType, required] of Object.entries(requiredReviews)) {
        if (!required) {
            continue;
        }
        for (const fileName of selectRulePackFiles(reviewType, effectiveDepth)) {
            fileNames.add(fileName);
        }
    }

    const rulesRoot = getRulePackRulesRoot(repoRoot);
    return [...fileNames].map(function (fileName) {
        return normalizePath(path.join(rulesRoot, fileName));
    }).sort();
}

export function normalizeLoadedRuleFilePath(repoRoot: string, ruleFile: string): string {
    const rawValue = String(ruleFile || '').trim();
    if (!rawValue) {
        throw new Error('LoadedRuleFiles contains an empty value.');
    }

    const rulesRoot = getRulePackRulesRoot(repoRoot);
    const resolvedPath = (path.isAbsolute(rawValue) || rawValue.includes('/') || rawValue.includes('\\'))
        ? resolvePathInsideRepo(rawValue, repoRoot)
        : path.join(rulesRoot, rawValue);
    if (!resolvedPath) {
        throw new Error(`Loaded rule file '${rawValue}' could not be resolved.`);
    }
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        throw new Error(`Loaded rule file not found: ${resolvedPath}`);
    }

    const normalizedRulesRoot = normalizePath(rulesRoot).toLowerCase();
    const normalizedResolvedPath = normalizePath(resolvedPath);
    const normalizedResolvedLower = normalizedResolvedPath.toLowerCase();
    if (
        normalizedResolvedLower !== normalizedRulesRoot
        && !normalizedResolvedLower.startsWith(`${normalizedRulesRoot}/`)
    ) {
        throw new Error(
            `Loaded rule file must resolve inside '${normalizePath(rulesRoot)}'. Got '${normalizedResolvedPath}'.`
        );
    }

    return normalizedResolvedPath;
}

export function normalizeLoadedRuleFiles(repoRoot: string, loadedRuleFiles: string[]): string[] {
    const normalized = loadedRuleFiles.map(function (ruleFile) {
        return normalizeLoadedRuleFilePath(repoRoot, ruleFile);
    });
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const ruleFile of normalized) {
        const key = ruleFile.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(ruleFile);
        }
    }
    return unique.sort();
}

const GENERATED_PROJECT_MEMORY_RULE_SUFFIX = '/live/docs/agent-rules/15-project-memory.md';
// Latin-1 preserves byte offsets, including UTF-8 BOM/title bytes and invalid UTF-8 in the body.
const GENERATED_MEMORY_HEADER_PATTERN = /^(?:\xEF\xBB\xBF)?(?:<!--[^\r\n]*-->\r?\n\r?\n)?# 15 \xC2\xB7 Project Memory Summary\r?\n\r?\n(Generated at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)(?=\r?\n|$)/u;

/** Normalize only the generated canonical header timestamp; every other byte remains evidence.
 * The replacement is itself a valid header timestamp so malformed raw headers cannot collide.
 */
export function ruleFileContentSha256(ruleFile: string): string | null {
    const normalizedPath = normalizePath(path.resolve(ruleFile));
    const comparablePath = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
    if (!comparablePath.endsWith(GENERATED_PROJECT_MEMORY_RULE_SUFFIX)) return fileSha256(ruleFile);
    try {
        const bytes = fs.readFileSync(ruleFile);
        const header = GENERATED_MEMORY_HEADER_PATTERN.exec(bytes.toString('latin1'));
        const spanStart = header ? header[0].length - header[1].length : 0;
        const content = header ? Buffer.concat([
            bytes.subarray(0, spanStart), Buffer.from('Generated at: 1970-01-01T00:00:00.000Z', 'ascii'),
            bytes.subarray(spanStart + header[1].length)
        ]) : bytes;
        return createHash('sha256').update(content).digest('hex');
    } catch {
        return null;
    }
}

export function buildRuleFileHashes(ruleFiles: string[]): Record<string, string | null> {
    return Object.fromEntries(ruleFiles.map(function (ruleFile) {
        return [ruleFile, ruleFileContentSha256(ruleFile)];
    }));
}

export function sameStringSet(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const rightSet = new Set(right.map(function (item) {
        return item.toLowerCase();
    }));
    return left.every(function (item) {
        return rightSet.has(item.toLowerCase());
    });
}

export function normalizeRuleFileList(repoRoot: string, value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    try {
        return normalizeLoadedRuleFiles(repoRoot, value.map(function (item) { return String(item || ''); }).filter(Boolean));
    } catch {
        return [];
    }
}

export function readRuleHash(record: unknown, ruleFile: string): string | null {
    if (!isRecord(record)) {
        return null;
    }
    const exact = record[ruleFile];
    if (typeof exact === 'string' && exact.trim()) {
        return exact.trim().toLowerCase();
    }
    const normalizedRuleFile = normalizePath(ruleFile).toLowerCase();
    for (const [key, value] of Object.entries(record)) {
        if (normalizePath(key).toLowerCase() === normalizedRuleFile && typeof value === 'string' && value.trim()) {
            return value.trim().toLowerCase();
        }
    }
    return null;
}

export function findStaleLoadedRuleFile(loadedRuleHashes: unknown, loadedRuleFiles: readonly string[]): string | null {
    return loadedRuleFiles.find(function (ruleFile) {
        const previousHash = readRuleHash(loadedRuleHashes, ruleFile);
        const currentHash = ruleFileContentSha256(ruleFile);
        // Evidence recorded before timestamp normalization still matches the raw file hash.
        return !previousHash || !currentHash || (previousHash !== currentHash.toLowerCase()
            && previousHash !== String(fileSha256(ruleFile) || '').toLowerCase());
    }) || null;
}
