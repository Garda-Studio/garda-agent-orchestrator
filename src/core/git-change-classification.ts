import * as fs from 'node:fs';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';

import { isGitExitFailure, runGitBinary } from './git-helpers';
import { normalizeLineEndings } from './line-endings';
import { isPathInsideRoot, isPathRealpathInsideRoot } from './paths';
import { DEFAULT_GIT_TIMEOUT_MS } from './subprocess';

export const GIT_EOL_CHANGE_POLICY = Object.freeze({
    schemaVersion: 1,
    id: 'eol_only_is_dirty_v1',
    comparisonBasis: 'git_porcelain_v1_candidates_with_blob_comparison',
    eolOnlyTreatment: 'dirty',
    gitNormalizedCleanTreatment: 'clean',
    rationale:
        'Git-visible changes whose raw text differs only by line endings remain in effective dirty scope. ' +
        'Working-tree transformations normalized away by Git attributes or core.autocrlf remain clean.'
} as const);

export type GitChangeLayer = 'staged' | 'unstaged' | 'untracked';
export type GitChangeKind =
    | 'added'
    | 'copied'
    | 'deleted'
    | 'modified'
    | 'renamed'
    | 'type_changed'
    | 'unmerged'
    | 'untracked'
    | 'unknown';
export type GitContentClassification = 'binary' | 'content' | 'eol_only' | 'metadata';

export interface GitLayerChangeClassification {
    path: string;
    previousPath: string | null;
    layer: GitChangeLayer;
    status: string;
    changeKind: GitChangeKind;
    contentClassification: GitContentClassification;
    includedInEffectiveScope: true;
    reason: string;
}

export interface GitChangeClassificationResult {
    policy: typeof GIT_EOL_CHANGE_POLICY;
    gitConfig: {
        autocrlf: string;
        eol: string;
        safecrlf: string;
    };
    audit: {
        effectiveDirty: boolean;
        reason: string;
    };
    changes: GitLayerChangeClassification[];
    effectiveChangedFiles: string[];
    stagedFiles: string[];
    unstagedFiles: string[];
    untrackedFiles: string[];
    eolOnlyFiles: string[];
}

export interface GitChangeClassificationOptions {
    timeoutMs?: number;
    explicitUntrackedPaths?: readonly string[];
}

export interface GitChangeClassificationSnapshot {
    classification: GitChangeClassificationResult;
    trackedIndexPaths: ReadonlySet<string>;
    stagedBlobFingerprints: ReadonlyMap<string, string>;
}

export interface GitChangeLayerSelectionOptions {
    layers: readonly GitChangeLayer[];
    paths?: readonly string[];
    context?: string;
}

export interface GitChangeClassificationEvidence {
    schema_version: 1;
    policy_id: typeof GIT_EOL_CHANGE_POLICY.id;
    eol_only_treatment: typeof GIT_EOL_CHANGE_POLICY.eolOnlyTreatment;
    git_normalized_clean_treatment: typeof GIT_EOL_CHANGE_POLICY.gitNormalizedCleanTreatment;
    policy_rationale: string;
    git_config: {
        autocrlf: string;
        eol: string;
        safecrlf: string;
    };
    effective_dirty: boolean;
    normalization_rationale: string;
    effective_changed_files: string[];
    staged_files: string[];
    unstaged_files: string[];
    untracked_files: string[];
    eol_only_files: string[];
    ignored_eol_only_files: string[];
    file_classifications: Array<{
        path: string;
        previous_path: string | null;
        layer: GitChangeLayer;
        status: string;
        change_kind: GitChangeKind;
        content_classification: GitContentClassification;
        included_in_effective_scope: true;
        reason: string;
    }>;
}

interface ParsedNameStatus {
    status: string;
    path: string;
    previousPath: string | null;
    changeKind: GitChangeKind;
}

interface ParsedPorcelainStatus {
    staged: ParsedNameStatus[];
    unstaged: ParsedNameStatus[];
    untracked: string[];
}

interface ContentSnapshot {
    kind: 'file' | 'missing' | 'other' | 'symlink' | 'unavailable';
    content: Buffer | null;
}

interface GitBlobReference {
    kind: Extract<ContentSnapshot['kind'], 'file' | 'other' | 'symlink'>;
    objectId: string | null;
}

interface TrackedSnapshotLookup {
    head: Map<string, ContentSnapshot>;
    index: Map<string, ContentSnapshot>;
    trackedIndexPaths: Set<string>;
    stagedBlobFingerprints: Map<string, string>;
}

interface IndexBlobReferenceSnapshot {
    references: Map<string, GitBlobReference>;
    trackedPaths: Set<string>;
    stagedBlobFingerprints: Map<string, string>;
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_CLASSIFICATION_CONTENT_BYTES = 64 * 1024 * 1024;
const GIT_CONTENT_MAX_BUFFER_BYTES = MAX_CLASSIFICATION_CONTENT_BYTES + 1024;
const GIT_STATUS_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const LAYER_ORDER: Record<GitChangeLayer, number> = {
    staged: 0,
    unstaged: 1,
    untracked: 2
};
const UNMERGED_STATUS_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

interface GitCommandBudget {
    deadlineMs: number | null;
    configuredTimeoutMs: number | null;
}

function createGitCommandBudget(options: GitChangeClassificationOptions): GitCommandBudget {
    const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Git change classification timeoutMs must be a positive integer.');
    }
    return {
        deadlineMs: Date.now() + timeoutMs,
        configuredTimeoutMs: timeoutMs
    };
}

function remainingGitCommandTimeoutMs(budget: GitCommandBudget): number | undefined {
    if (budget.deadlineMs === null || budget.configuredTimeoutMs === null) {
        return undefined;
    }
    const remainingMs = budget.deadlineMs - Date.now();
    if (remainingMs <= 0) {
        throw new Error(
            `Git change classification exceeded its ${budget.configuredTimeoutMs}ms command budget.`
        );
    }
    return remainingMs;
}
const EVIDENCE_LAYERS = new Set<GitChangeLayer>(['staged', 'unstaged', 'untracked']);
const EVIDENCE_CHANGE_KINDS = new Set<GitChangeKind>([
    'added',
    'copied',
    'deleted',
    'modified',
    'renamed',
    'type_changed',
    'unmerged',
    'untracked',
    'unknown'
]);
const EVIDENCE_CONTENT_CLASSIFICATIONS = new Set<GitContentClassification>([
    'binary',
    'content',
    'eol_only',
    'metadata'
]);

function compareOrdinal(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: Iterable<string>): string[] {
    return [...new Set(values)].sort(compareOrdinal);
}

export function normalizeGitRepoRelativePath(filePath: string): string | null {
    const normalizedInput = String(filePath || '')
        .replace(/\\/gu, '/')
        .replace(/^\.\/+/u, '')
        .replace(/\/+/gu, '/')
        .trim();
    const normalized = path.posix.normalize(normalizedInput);
    if (
        !normalized
        || normalized === '.'
        || normalized.includes('\0')
        || normalized === '..'
        || normalized.startsWith('../')
        || path.posix.isAbsolute(normalized)
        || path.win32.isAbsolute(normalized)
    ) {
        return null;
    }
    return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEvidenceStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return uniqueSorted(
        value
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
    );
}

function mapChangeKind(status: string): GitChangeKind {
    switch (status.charAt(0).toUpperCase()) {
        case 'A':
            return 'added';
        case 'C':
            return 'copied';
        case 'D':
            return 'deleted';
        case 'M':
            return 'modified';
        case 'R':
            return 'renamed';
        case 'T':
            return 'type_changed';
        case 'U':
            return 'unmerged';
        default:
            return 'unknown';
    }
}

function parsePorcelainStatus(output: Buffer): ParsedPorcelainStatus {
    const fields = output.toString('utf8').split('\0');
    const staged: ParsedNameStatus[] = [];
    const unstaged: ParsedNameStatus[] = [];
    const untracked: string[] = [];
    let index = 0;
    while (index < fields.length) {
        const record = String(fields[index++] || '');
        if (!record) {
            continue;
        }
        if (record.length < 4 || record.charAt(2) !== ' ') {
            throw new Error(`Git porcelain output contains a malformed record: '${record.slice(0, 20)}'.`);
        }
        const xStatus = record.charAt(0);
        const yStatus = record.charAt(1);
        const filePath = record.slice(3);
        if (!filePath) {
            throw new Error(`Git porcelain output omitted the path for status '${xStatus}${yStatus}'.`);
        }
        if (xStatus === '?' && yStatus === '?') {
            untracked.push(filePath);
            continue;
        }
        const statusPair = `${xStatus}${yStatus}`;
        if (UNMERGED_STATUS_PAIRS.has(statusPair)) {
            staged.push({
                status: statusPair,
                path: filePath,
                previousPath: null,
                changeKind: 'unmerged'
            });
            unstaged.push({
                status: statusPair,
                path: filePath,
                previousPath: null,
                changeKind: 'unmerged'
            });
            continue;
        }
        const renameOrCopy = /[RC]/u.test(xStatus) || /[RC]/u.test(yStatus);
        const previousPath = renameOrCopy ? String(fields[index++] || '') : null;
        if (renameOrCopy && !previousPath) {
            throw new Error(`Git porcelain output omitted the source path for status '${xStatus}${yStatus}'.`);
        }
        if (xStatus !== ' ' && xStatus !== '?') {
            staged.push({
                status: xStatus,
                path: filePath,
                previousPath: /[RC]/u.test(xStatus) ? previousPath : null,
                changeKind: mapChangeKind(xStatus)
            });
        }
        if (yStatus !== ' ' && yStatus !== '?') {
            unstaged.push({
                status: yStatus,
                path: filePath,
                previousPath: /[RC]/u.test(yStatus) ? previousPath : null,
                changeKind: mapChangeKind(yStatus)
            });
        }
    }
    return { staged, unstaged, untracked };
}

function parseIndexBlobReferences(output: Buffer, wantedPaths: ReadonlySet<string>): IndexBlobReferenceSnapshot {
    const references = new Map<string, GitBlobReference>();
    const trackedPaths = new Set<string>();
    const stagedBlobFingerprints = new Map<string, string>();
    for (const record of output.toString('utf8').split('\0')) {
        if (!record) continue;
        const tabIndex = record.indexOf('\t');
        if (tabIndex < 0) continue;
        const filePath = record.slice(tabIndex + 1);
        const [mode, objectId, stage] = record.slice(0, tabIndex).split(/\s+/u);
        trackedPaths.add(filePath);
        if (!stagedBlobFingerprints.has(filePath) && /^\d+$/u.test(mode) && /^[0-9a-f]{40,64}$/iu.test(objectId)) {
            stagedBlobFingerprints.set(filePath, `staged:${mode}:${objectId.toLowerCase()}`);
        }
        if (!wantedPaths.has(filePath)) continue;
        if (stage !== '0') continue;
        const kind = mode === '120000' ? 'symlink' : mode.startsWith('100') ? 'file' : 'other';
        references.set(filePath, {
            kind,
            objectId: kind === 'other' ? null : objectId
        });
    }
    return { references, trackedPaths, stagedBlobFingerprints };
}

function parseHeadBlobReferences(output: Buffer, wantedPaths: ReadonlySet<string>): Map<string, GitBlobReference> {
    const references = new Map<string, GitBlobReference>();
    for (const record of output.toString('utf8').split('\0')) {
        if (!record) continue;
        const tabIndex = record.indexOf('\t');
        if (tabIndex < 0) continue;
        const filePath = record.slice(tabIndex + 1);
        if (!wantedPaths.has(filePath)) continue;
        const [mode, type, objectId] = record.slice(0, tabIndex).split(/\s+/u);
        const kind = type !== 'blob'
            ? 'other'
            : mode === '120000'
                ? 'symlink'
                : 'file';
        references.set(filePath, {
            kind,
            objectId: kind === 'other' ? null : objectId
        });
    }
    return references;
}

function readIndexBlobReferences(
    repoRoot: string,
    wantedPaths: ReadonlySet<string>,
    budget: GitCommandBudget
): IndexBlobReferenceSnapshot {
    const output = runGitBinary(repoRoot, ['ls-files', '--stage', '-z'], {
        maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
        timeoutMs: remainingGitCommandTimeoutMs(budget)
    });
    return parseIndexBlobReferences(output, wantedPaths);
}

function hasUnbornHead(repoRoot: string, budget: GitCommandBudget): boolean {
    const reference = runGitBinary(repoRoot, ['symbolic-ref', '--quiet', 'HEAD'], {
        allowFailure: true,
        allowedFailureExitCodes: [1],
        maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
        timeoutMs: remainingGitCommandTimeoutMs(budget)
    }).toString('utf8').trim();
    if (!reference.startsWith('refs/heads/')) return false;
    try {
        runGitBinary(repoRoot, ['show-ref', '--verify', '--quiet', reference], {
            maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
            timeoutMs: remainingGitCommandTimeoutMs(budget)
        });
        return false;
    } catch (error: unknown) {
        if (isGitExitFailure(error, 1)) return true;
        throw error;
    }
}

function readHeadBlobReferences(
    repoRoot: string,
    wantedPaths: ReadonlySet<string>,
    budget: GitCommandBudget
): Map<string, GitBlobReference> {
    if (wantedPaths.size === 0) return new Map();
    try {
        const output = runGitBinary(repoRoot, ['ls-tree', '-r', '-z', 'HEAD'], {
            maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
            timeoutMs: remainingGitCommandTimeoutMs(budget)
        });
        return parseHeadBlobReferences(output, wantedPaths);
    } catch (error: unknown) {
        if (isGitExitFailure(error, 128) && hasUnbornHead(repoRoot, budget)) return new Map();
        throw error;
    }
}

function parseBatchObjectSizes(output: Buffer): Map<string, number> {
    const sizes = new Map<string, number>();
    for (const line of output.toString('utf8').split('\n')) {
        const [objectId, type, rawSize] = line.trim().split(/\s+/u);
        const size = Number.parseInt(rawSize, 10);
        if (
            /^[0-9a-f]{40,64}$/iu.test(objectId)
            && type === 'blob'
            && Number.isSafeInteger(size)
            && size >= 0
            && size <= MAX_CLASSIFICATION_CONTENT_BYTES
        ) {
            sizes.set(objectId, size);
        }
    }
    return sizes;
}

function splitBlobObjectBatches(objectIds: string[], sizes: ReadonlyMap<string, number>): string[][] {
    const batches: string[][] = [];
    let current: string[] = [];
    let currentBytes = 0;
    for (const objectId of objectIds) {
        const size = sizes.get(objectId);
        if (size === undefined) continue;
        const responseBytes = size + objectId.length + 32;
        if (current.length > 0 && currentBytes + responseBytes > GIT_CONTENT_MAX_BUFFER_BYTES) {
            batches.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(objectId);
        currentBytes += responseBytes;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

function parseBatchBlobContents(output: Buffer, expectedObjectIds: readonly string[]): Map<string, Buffer> {
    const contents = new Map<string, Buffer>();
    let offset = 0;
    for (const expectedObjectId of expectedObjectIds) {
        const headerEnd = output.indexOf(0x0a, offset);
        if (headerEnd < 0) {
            throw new Error('git cat-file --batch returned a truncated object header.');
        }
        const [objectId, type, rawSize] = output.subarray(offset, headerEnd).toString('utf8').split(/\s+/u);
        const size = Number.parseInt(rawSize, 10);
        if (objectId !== expectedObjectId || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
            throw new Error('git cat-file --batch returned an unexpected object header.');
        }
        const contentStart = headerEnd + 1;
        const contentEnd = contentStart + size;
        if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
            throw new Error('git cat-file --batch returned truncated object content.');
        }
        contents.set(objectId, Buffer.from(output.subarray(contentStart, contentEnd)));
        offset = contentEnd + 1;
    }
    return contents;
}

function readBlobContents(
    repoRoot: string,
    objectIds: Iterable<string>,
    budget: GitCommandBudget
): Map<string, Buffer> {
    const uniqueObjectIds = uniqueSorted(
        [...objectIds].filter((objectId) => /^[0-9a-f]{40,64}$/iu.test(objectId))
    );
    if (uniqueObjectIds.length === 0) return new Map();

    const batchInput = `${uniqueObjectIds.join('\n')}\n`;
    const sizes = parseBatchObjectSizes(runGitBinary(repoRoot, ['cat-file', '--batch-check'], {
        input: batchInput,
        maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
        timeoutMs: remainingGitCommandTimeoutMs(budget)
    }));
    const contents = new Map<string, Buffer>();
    for (const batch of splitBlobObjectBatches(uniqueObjectIds, sizes)) {
        const output = runGitBinary(repoRoot, ['cat-file', '--batch'], {
            input: `${batch.join('\n')}\n`,
            maxBuffer: GIT_CONTENT_MAX_BUFFER_BYTES,
            timeoutMs: remainingGitCommandTimeoutMs(budget)
        });
        for (const [objectId, content] of parseBatchBlobContents(output, batch)) {
            contents.set(objectId, content);
        }
    }
    return contents;
}

function materializeTrackedSnapshots(
    wantedPaths: ReadonlySet<string>,
    references: ReadonlyMap<string, GitBlobReference>,
    blobContents: ReadonlyMap<string, Buffer>
): Map<string, ContentSnapshot> {
    const snapshots = new Map<string, ContentSnapshot>();
    for (const filePath of wantedPaths) {
        const reference = references.get(filePath);
        if (!reference) {
            snapshots.set(filePath, { kind: 'missing', content: null });
        } else if (reference.kind === 'other') {
            snapshots.set(filePath, { kind: 'other', content: null });
        } else if (!reference.objectId || !blobContents.has(reference.objectId)) {
            snapshots.set(filePath, { kind: 'unavailable', content: null });
        } else {
            snapshots.set(filePath, {
                kind: reference.kind,
                content: blobContents.get(reference.objectId) || null
            });
        }
    }
    return snapshots;
}

function buildTrackedSnapshotLookup(
    repoRoot: string,
    porcelain: ParsedPorcelainStatus,
    budget: GitCommandBudget
): TrackedSnapshotLookup {
    const headPaths = new Set<string>();
    const indexPaths = new Set<string>();
    for (const change of porcelain.staged) {
        if (change.changeKind === 'type_changed' || change.changeKind === 'unmerged') continue;
        headPaths.add(change.previousPath || change.path);
        indexPaths.add(change.path);
    }
    for (const change of porcelain.unstaged) {
        if (change.changeKind === 'type_changed' || change.changeKind === 'unmerged') continue;
        indexPaths.add(change.previousPath || change.path);
    }

    const headReferences = readHeadBlobReferences(repoRoot, headPaths, budget);
    const indexSnapshot = readIndexBlobReferences(repoRoot, indexPaths, budget);
    const objectIds = [...headReferences.values(), ...indexSnapshot.references.values()]
        .map((reference) => reference.objectId)
        .filter((objectId): objectId is string => objectId !== null);
    const blobContents = readBlobContents(repoRoot, objectIds, budget);
    return {
        head: materializeTrackedSnapshots(headPaths, headReferences, blobContents),
        index: materializeTrackedSnapshots(indexPaths, indexSnapshot.references, blobContents),
        trackedIndexPaths: indexSnapshot.trackedPaths,
        stagedBlobFingerprints: indexSnapshot.stagedBlobFingerprints
    };
}

function readWorktreeSnapshot(repoRoot: string, filePath: string): ContentSnapshot {
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedPath = path.resolve(resolvedRoot, filePath);
    if (!isPathInsideRoot(resolvedRoot, resolvedPath)) {
        return { kind: 'unavailable', content: null };
    }
    try {
        const stat = fs.lstatSync(resolvedPath);
        if (stat.isSymbolicLink()) {
            return { kind: 'symlink', content: Buffer.from(fs.readlinkSync(resolvedPath), 'utf8') };
        }
        if (!isPathRealpathInsideRoot(resolvedRoot, resolvedPath)) {
            return { kind: 'unavailable', content: null };
        }
        if (!stat.isFile()) {
            return { kind: 'other', content: null };
        }
        if (stat.size > MAX_CLASSIFICATION_CONTENT_BYTES) {
            return { kind: 'unavailable', content: null };
        }
        const content = fs.readFileSync(resolvedPath);
        return content.length <= MAX_CLASSIFICATION_CONTENT_BYTES
            ? { kind: 'file', content }
            : { kind: 'unavailable', content: null };
    } catch (error: unknown) {
        const code = String((error as NodeJS.ErrnoException)?.code || '');
        return code === 'ENOENT' || code === 'ENOTDIR'
            ? { kind: 'missing', content: null }
            : { kind: 'unavailable', content: null };
    }
}

function decodeText(content: Buffer): string | null {
    if (content.includes(0)) {
        return null;
    }
    try {
        return UTF8_DECODER.decode(content);
    } catch {
        return null;
    }
}

function classifySnapshots(
    before: ContentSnapshot,
    after: ContentSnapshot
): Pick<GitLayerChangeClassification, 'contentClassification' | 'reason'> {
    if (before.kind === 'unavailable' || after.kind === 'unavailable') {
        return {
            contentClassification: 'metadata',
            reason: 'Content comparison is unavailable or would cross the repository realpath boundary; the Git-visible change stays dirty.'
        };
    }
    if (before.kind === 'other' || after.kind === 'other' || before.kind === 'symlink' || after.kind === 'symlink') {
        return {
            contentClassification: 'metadata',
            reason: 'The change involves a non-regular file or symbolic link; EOL classification is not applicable.'
        };
    }

    const beforeContent = before.content;
    const afterContent = after.content;
    const existingContent = beforeContent || afterContent;
    if (!beforeContent || !afterContent) {
        const binary = existingContent ? decodeText(existingContent) === null : false;
        return binary
            ? {
                contentClassification: 'binary',
                reason: `A binary file was ${beforeContent ? 'deleted' : 'added'}; it remains in effective dirty scope.`
            }
            : {
                contentClassification: 'content',
                reason: `A text file was ${beforeContent ? 'deleted' : 'added'}; it remains in effective dirty scope.`
            };
    }
    if (beforeContent.equals(afterContent)) {
        return {
            contentClassification: 'metadata',
            reason: 'Git reports a path or metadata change while the compared bytes are identical.'
        };
    }

    const beforeText = decodeText(beforeContent);
    const afterText = decodeText(afterContent);
    if (beforeText === null || afterText === null) {
        return {
            contentClassification: 'binary',
            reason: 'At least one compared version is binary or invalid UTF-8; EOL-only classification is not applied.'
        };
    }
    if (normalizeLineEndings(beforeText) === normalizeLineEndings(afterText)) {
        return {
            contentClassification: 'eol_only',
            reason: 'Raw text differs only by line endings; policy eol_only_is_dirty_v1 keeps the change in effective dirty scope.'
        };
    }
    return {
        contentClassification: 'content',
        reason: 'Text content still differs after line-ending normalization.'
    };
}

function classifyLayerChange(
    repoRoot: string,
    layer: Exclude<GitChangeLayer, 'untracked'>,
    change: ParsedNameStatus,
    snapshots: TrackedSnapshotLookup
): GitLayerChangeClassification {
    const changeKind = change.changeKind;
    const classificationBase = {
        path: change.path,
        previousPath: change.previousPath,
        layer,
        status: change.status,
        changeKind,
        includedInEffectiveScope: true as const
    };
    if (changeKind === 'type_changed' || changeKind === 'unmerged') {
        return {
            ...classificationBase,
            contentClassification: 'metadata',
            reason: `Git reports a ${changeKind.replace('_', ' ')} change; byte-level EOL classification is not applicable.`
        };
    }

    const beforePath = change.previousPath || change.path;
    const before = layer === 'staged'
        ? snapshots.head.get(beforePath) || { kind: 'missing', content: null }
        : snapshots.index.get(beforePath) || { kind: 'missing', content: null };
    const after = layer === 'staged'
        ? snapshots.index.get(change.path) || { kind: 'missing', content: null }
        : readWorktreeSnapshot(repoRoot, change.path);
    return {
        ...classificationBase,
        ...classifySnapshots(before, after)
    };
}

function readPorcelainStatus(repoRoot: string, budget: GitCommandBudget): ParsedPorcelainStatus {
    return parsePorcelainStatus(runGitBinary(repoRoot, [
        '--no-pager',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
        '--renames'
    ], {
        maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
        timeoutMs: remainingGitCommandTimeoutMs(budget)
    }));
}

function readRelevantGitConfig(
    repoRoot: string,
    budget: GitCommandBudget
): GitChangeClassificationResult['gitConfig'] {
    const values = new Map<string, string>();
    const output = runGitBinary(repoRoot, [
        'config',
        '--null',
        '--get-regexp',
        '^core\.(autocrlf|eol|safecrlf)$'
    ], {
        allowFailure: true,
        allowedFailureExitCodes: [1],
        timeoutMs: remainingGitCommandTimeoutMs(budget)
    });
    for (const record of output.toString('utf8').split('\0')) {
        if (!record) continue;
        const separatorIndex = record.indexOf('\n');
        if (separatorIndex < 0) continue;
        values.set(record.slice(0, separatorIndex).toLowerCase(), record.slice(separatorIndex + 1));
    }
    return {
        autocrlf: values.get('core.autocrlf') || 'unset',
        eol: values.get('core.eol') || 'unset',
        safecrlf: values.get('core.safecrlf') || 'unset'
    };
}

function classifyUntrackedPath(repoRoot: string, filePath: string): GitLayerChangeClassification {
    return {
        path: filePath,
        previousPath: null,
        layer: 'untracked',
        status: '?',
        changeKind: 'untracked',
        includedInEffectiveScope: true,
        ...classifySnapshots(
            { kind: 'missing', content: null },
            readWorktreeSnapshot(repoRoot, filePath)
        )
    };
}

function buildGitChangeClassificationResult(
    gitConfig: GitChangeClassificationResult['gitConfig'],
    changes: GitLayerChangeClassification[]
): GitChangeClassificationResult {
    const staged = changes.filter((change) => change.layer === 'staged');
    const unstaged = changes.filter((change) => change.layer === 'unstaged');
    const untracked = changes.filter((change) => change.layer === 'untracked');
    return {
        policy: GIT_EOL_CHANGE_POLICY,
        gitConfig,
        audit: {
            effectiveDirty: changes.length > 0,
            reason: changes.length > 0
                ? `Git porcelain reported ${changes.length} staged, unstaged, or untracked layer change(s); all remain in effective dirty scope.`
                : `Git porcelain reported no effective changes under core.autocrlf=${gitConfig.autocrlf}, core.eol=${gitConfig.eol}, core.safecrlf=${gitConfig.safecrlf}.`
        },
        changes,
        effectiveChangedFiles: uniqueSorted(changes.map((change) => change.path)),
        stagedFiles: uniqueSorted(staged.map((change) => change.path)),
        unstagedFiles: uniqueSorted(unstaged.map((change) => change.path)),
        untrackedFiles: uniqueSorted(untracked.map((change) => change.path)),
        eolOnlyFiles: uniqueSorted(
            changes
                .filter((change) => change.contentClassification === 'eol_only')
                .map((change) => change.path)
        )
    };
}

export function collectGitChangeClassificationSnapshot(
    repoRoot: string,
    options: Pick<GitChangeClassificationOptions, 'timeoutMs'> = {}
): GitChangeClassificationSnapshot {
    const budget = createGitCommandBudget(options);
    const porcelain = readPorcelainStatus(repoRoot, budget);
    const snapshots = buildTrackedSnapshotLookup(repoRoot, porcelain, budget);
    const staged = porcelain.staged
        .map((change) => classifyLayerChange(repoRoot, 'staged', change, snapshots));
    const unstaged = porcelain.unstaged
        .map((change) => classifyLayerChange(repoRoot, 'unstaged', change, snapshots));
    const untracked = porcelain.untracked.map((filePath) => classifyUntrackedPath(repoRoot, filePath));
    const changes = [...staged, ...unstaged, ...untracked].sort((left, right) =>
        compareOrdinal(left.path, right.path) || LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer]
    );
    const gitConfig = readRelevantGitConfig(repoRoot, budget);

    return {
        classification: buildGitChangeClassificationResult(gitConfig, changes),
        trackedIndexPaths: snapshots.trackedIndexPaths,
        stagedBlobFingerprints: snapshots.stagedBlobFingerprints
    };
}

export function deriveGitChangeClassification(
    repoRoot: string,
    snapshot: GitChangeClassificationSnapshot,
    explicitPaths: readonly string[] = []
): GitChangeClassificationResult {
    const explicitUntrackedPaths = uniqueSorted(
        explicitPaths
            .map(normalizeGitRepoRelativePath)
            .filter((filePath): filePath is string => filePath !== null)
    );
    if (explicitUntrackedPaths.length === 0) {
        return snapshot.classification;
    }
    const changes = [...snapshot.classification.changes];
    const classifiedUntrackedPaths = new Set(snapshot.classification.untrackedFiles);
    for (const filePath of explicitUntrackedPaths) {
        if (snapshot.trackedIndexPaths.has(filePath) || classifiedUntrackedPaths.has(filePath)) {
            continue;
        }
        const worktree = readWorktreeSnapshot(repoRoot, filePath);
        if (worktree.kind !== 'file') {
            continue;
        }
        changes.push({
            path: filePath,
            previousPath: null,
            layer: 'untracked',
            status: '?',
            changeKind: 'untracked',
            includedInEffectiveScope: true,
            ...classifySnapshots(
                { kind: 'missing', content: null },
                worktree
            )
        });
    }
    changes.sort((left, right) =>
        compareOrdinal(left.path, right.path) || LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer]
    );
    return buildGitChangeClassificationResult(snapshot.classification.gitConfig, changes);
}

export function classifyGitChanges(
    repoRoot: string,
    options: GitChangeClassificationOptions = {}
): GitChangeClassificationResult {
    const snapshot = collectGitChangeClassificationSnapshot(repoRoot, {
        timeoutMs: options.timeoutMs
    });
    return deriveGitChangeClassification(repoRoot, snapshot, options.explicitUntrackedPaths);
}

export function selectGitChangeClassificationLayers(
    classification: GitChangeClassificationResult,
    options: GitChangeLayerSelectionOptions
): GitChangeClassificationResult {
    const selectedLayers = new Set(options.layers);
    const selectedPaths = options.paths ? new Set(options.paths) : null;
    const changes = classification.changes.filter((change) =>
        selectedLayers.has(change.layer)
        && (
            !selectedPaths
            || selectedPaths.has(change.path)
            || (change.previousPath !== null && selectedPaths.has(change.previousPath))
        )
    );
    const staged = changes.filter((change) => change.layer === 'staged');
    const unstaged = changes.filter((change) => change.layer === 'unstaged');
    const untracked = changes.filter((change) => change.layer === 'untracked');
    const layerSummary = [...selectedLayers].sort(
        (left, right) => LAYER_ORDER[left] - LAYER_ORDER[right]
    ).join(', ') || 'none';
    const context = String(options.context || 'selected Git scope').trim() || 'selected Git scope';

    return {
        policy: classification.policy,
        gitConfig: { ...classification.gitConfig },
        audit: {
            effectiveDirty: changes.length > 0,
            reason: changes.length > 0
                ? `${context} selected ${changes.length} canonical Git layer change(s) from layers ${layerSummary}; all remain in effective dirty scope.`
                : `${context} selected no canonical Git changes from layers ${layerSummary} under core.autocrlf=${classification.gitConfig.autocrlf}, core.eol=${classification.gitConfig.eol}, core.safecrlf=${classification.gitConfig.safecrlf}.`
        },
        changes,
        effectiveChangedFiles: uniqueSorted(changes.map((change) => change.path)),
        stagedFiles: uniqueSorted(staged.map((change) => change.path)),
        unstagedFiles: uniqueSorted(unstaged.map((change) => change.path)),
        untrackedFiles: uniqueSorted(untracked.map((change) => change.path)),
        eolOnlyFiles: uniqueSorted(
            changes
                .filter((change) => change.contentClassification === 'eol_only')
                .map((change) => change.path)
        )
    };
}

export function buildGitChangeClassificationEvidence(
    classification: GitChangeClassificationResult
): GitChangeClassificationEvidence {
    return {
        schema_version: 1,
        policy_id: classification.policy.id,
        eol_only_treatment: classification.policy.eolOnlyTreatment,
        git_normalized_clean_treatment: classification.policy.gitNormalizedCleanTreatment,
        policy_rationale: classification.policy.rationale,
        git_config: { ...classification.gitConfig },
        effective_dirty: classification.audit.effectiveDirty,
        normalization_rationale: classification.audit.reason,
        effective_changed_files: [...classification.effectiveChangedFiles],
        staged_files: [...classification.stagedFiles],
        unstaged_files: [...classification.unstagedFiles],
        untracked_files: [...classification.untrackedFiles],
        eol_only_files: [...classification.eolOnlyFiles],
        ignored_eol_only_files: [],
        file_classifications: classification.changes.map((change) => ({
            path: change.path,
            previous_path: change.previousPath,
            layer: change.layer,
            status: change.status,
            change_kind: change.changeKind,
            content_classification: change.contentClassification,
            included_in_effective_scope: change.includedInEffectiveScope,
            reason: change.reason
        }))
    };
}

export function normalizeGitChangeClassificationEvidence(
    value: unknown
): GitChangeClassificationEvidence | null {
    if (!isRecord(value) || value.schema_version !== 1) {
        return null;
    }
    if (
        value.policy_id !== GIT_EOL_CHANGE_POLICY.id
        || value.eol_only_treatment !== GIT_EOL_CHANGE_POLICY.eolOnlyTreatment
        || value.git_normalized_clean_treatment !== GIT_EOL_CHANGE_POLICY.gitNormalizedCleanTreatment
    ) {
        return null;
    }
    const gitConfig = isRecord(value.git_config) ? value.git_config : {};
    const fileClassifications = Array.isArray(value.file_classifications)
        ? value.file_classifications.flatMap((entry) => {
            if (!isRecord(entry)) {
                return [];
            }
            const layer = String(entry.layer || '') as GitChangeLayer;
            const changeKind = String(entry.change_kind || '') as GitChangeKind;
            const contentClassification = String(entry.content_classification || '') as GitContentClassification;
            const filePath = String(entry.path || '').trim();
            if (
                !filePath
                || !EVIDENCE_LAYERS.has(layer)
                || !EVIDENCE_CHANGE_KINDS.has(changeKind)
                || !EVIDENCE_CONTENT_CLASSIFICATIONS.has(contentClassification)
                || entry.included_in_effective_scope !== true
            ) {
                return [];
            }
            const previousPath = entry.previous_path == null
                ? null
                : String(entry.previous_path || '').trim() || null;
            return [{
                path: filePath,
                previous_path: previousPath,
                layer,
                status: String(entry.status || '').trim(),
                change_kind: changeKind,
                content_classification: contentClassification,
                included_in_effective_scope: true as const,
                reason: String(entry.reason || '').trim()
            }];
        })
        : [];
    const ignoredEolOnlyFiles = normalizeEvidenceStringList(value.ignored_eol_only_files);
    if (ignoredEolOnlyFiles.length > 0) {
        return null;
    }

    return {
        schema_version: 1,
        policy_id: GIT_EOL_CHANGE_POLICY.id,
        eol_only_treatment: GIT_EOL_CHANGE_POLICY.eolOnlyTreatment,
        git_normalized_clean_treatment: GIT_EOL_CHANGE_POLICY.gitNormalizedCleanTreatment,
        policy_rationale: String(value.policy_rationale || GIT_EOL_CHANGE_POLICY.rationale).trim(),
        git_config: {
            autocrlf: String(gitConfig.autocrlf || 'unset').trim() || 'unset',
            eol: String(gitConfig.eol || 'unset').trim() || 'unset',
            safecrlf: String(gitConfig.safecrlf || 'unset').trim() || 'unset'
        },
        effective_dirty: value.effective_dirty === true,
        normalization_rationale: String(value.normalization_rationale || '').trim(),
        effective_changed_files: normalizeEvidenceStringList(value.effective_changed_files),
        staged_files: normalizeEvidenceStringList(value.staged_files),
        unstaged_files: normalizeEvidenceStringList(value.unstaged_files),
        untracked_files: normalizeEvidenceStringList(value.untracked_files),
        eol_only_files: normalizeEvidenceStringList(value.eol_only_files),
        ignored_eol_only_files: [],
        file_classifications: fileClassifications
    };
}
