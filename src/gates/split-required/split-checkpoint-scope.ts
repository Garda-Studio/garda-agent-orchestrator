import * as path from 'node:path';

import { isTaskQueueDecomposedStatus } from '../../core/active-task-state';
import { readTaskQueueEntries, type TaskQueueEntry } from '../../core/task-queue-read';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import { parseNumstatZ, splitNulRecords } from '../../core/git-path-output';
import { extractExplicitLinkedChildTaskIds } from '../next-step/next-step-task-queue';
import {
    isPathRealpathInsideRoot,
    normalizePath,
    stringSha256
} from '../shared/helpers';

const CHECKPOINT_DETECTION_SOURCE_PREFIX = 'git_split_checkpoint:';
const CHECKPOINT_SHA_PATTERN = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const CHECKPOINT_METADATA_SHA_PATTERN = CHECKPOINT_SHA_PATTERN
    + '(?=$|[\\s\\x60.,;:!?\\]\\)])';
const CHECKPOINT_DETECTION_SOURCE_PATTERN = new RegExp(
    `^${CHECKPOINT_DETECTION_SOURCE_PREFIX}(${CHECKPOINT_SHA_PATTERN}):(${CHECKPOINT_SHA_PATTERN})$`,
    'i'
);
const CHECKPOINT_COMMIT_PATTERN = new RegExp(
    '\\bcheckpoint(?:\\s*:\\s*|\\s+slice\\s+)\\x60?(' + CHECKPOINT_METADATA_SHA_PATTERN + ')\\x60?',
    'i'
);
const PARENT_CHECKPOINT_COMMIT_PATTERN = new RegExp(
    '\\bsplit checkpoint\\s+`?(' + CHECKPOINT_METADATA_SHA_PATTERN + ')`?',
    'i'
);
const CHECKPOINT_FILES_PATTERN = /\bcheckpoint files:\s*((?:`[^`]+`\s*,?\s*)+)/iu;
const GIT_DIFF_HARDENING_ARGS = ['--no-ext-diff', '--no-textconv', '--no-color'];

export interface SplitCheckpointRange {
    base_commit: string;
    checkpoint_commit: string;
}

export interface SplitCheckpointTaskScope extends SplitCheckpointRange {
    task_id: string;
    parent_task_id: string;
    changed_files: string[];
    detection_source: string;
}

export interface SplitCheckpointScopeResolution {
    scope: SplitCheckpointTaskScope | null;
    violation: string | null;
}

export interface SplitCheckpointWorkspaceSnapshot {
    [key: string]: unknown;
    detection_source: string;
    use_staged: false;
    include_untracked: false;
    changed_files: string[];
    changed_files_count: number;
    ignored_generated_runtime_files: string[];
    ignored_generated_runtime_files_count: number;
    additions_total: number;
    deletions_total: number;
    changed_lines_total: number;
    changed_file_stats: Record<string, { additions: number; deletions: number; changed_lines: number }>;
    changed_files_sha256: string | null;
    scope_content_sha256: string | null;
    scope_sha256: string | null;
    split_checkpoint: {
        base_commit: string;
        checkpoint_commit: string;
        worktree_drift: boolean;
    };
}

function runGitText(repoRoot: string, args: string[], action: string): string {
    const result = spawnSyncWithTimeout('git', ['-C', path.resolve(repoRoot), ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024
    });
    if (result.timedOut || result.error || result.status !== 0) {
        const reason = result.timedOut
            ? `timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`
            : result.error
                ? String(result.error)
                : String(result.stderr || result.stdout || `exit status ${result.status}`).trim();
        throw new Error(`${action}: git ${args.join(' ')} failed in '${normalizePath(repoRoot)}' (${reason}).`);
    }
    return String(result.stdout || '');
}

function runGitStatus(repoRoot: string, args: string[], action: string): number | null {
    const result = spawnSyncWithTimeout('git', ['-C', path.resolve(repoRoot), ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024
    });
    if (result.timedOut || result.error) {
        const reason = result.timedOut
            ? `timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`
            : String(result.error);
        throw new Error(`${action}: git ${args.join(' ')} failed in '${normalizePath(repoRoot)}' (${reason}).`);
    }
    return result.status;
}

function resolveRepositoryObjectIdLength(repoRoot: string): number {
    const objectFormat = runGitText(
        repoRoot,
        ['rev-parse', '--show-object-format'],
        'Split checkpoint object-format validation'
    ).trim().toLowerCase();
    if (objectFormat === 'sha1') {
        return 40;
    }
    if (objectFormat === 'sha256') {
        return 64;
    }
    throw new Error(
        'Split checkpoint validation does not support repository object format '
        + (objectFormat || 'unknown') + '.'
    );
}

function resolveCanonicalCommitObjectId(repoRoot: string, value: string, action: string): string {
    const candidate = String(value || '').trim().toLowerCase();
    const expectedLength = resolveRepositoryObjectIdLength(repoRoot);
    const objectIdPattern = new RegExp('^[0-9a-f]{' + expectedLength + '}$', 'u');
    if (!objectIdPattern.test(candidate)) {
        throw new Error(
            action + ': checkpoint commit must be a full ' + expectedLength + '-character '
            + (expectedLength === 40 ? 'sha1' : 'sha256') + ' object id.'
        );
    }
    const canonical = runGitText(
        repoRoot,
        ['rev-parse', '--verify', candidate + '^{commit}'],
        action
    ).trim().toLowerCase();
    if (!objectIdPattern.test(canonical) || canonical !== candidate) {
        throw new Error(
            action + ': checkpoint commit ' + candidate
            + ' did not resolve to the same canonical commit object id.'
        );
    }
    return canonical;
}

function toLiteralGitPathspecs(changedFiles: string[]): string[] {
    return changedFiles.map((changedFile) => `:(literal)${changedFile}`);
}

function normalizeCheckpointPath(repoRoot: string, value: unknown): string | null {
    const rawPath = String(value || '').trim();
    if (!rawPath || rawPath.includes('\0') || rawPath.includes('\\')) {
        return null;
    }
    const portablePath = rawPath;
    if (
        path.isAbsolute(rawPath)
        || path.win32.isAbsolute(rawPath)
        || path.posix.isAbsolute(portablePath)
        || /^[a-z]:/iu.test(portablePath)
        || portablePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) {
        return null;
    }
    const normalizedPath = normalizePath(portablePath);
    if (!normalizedPath || normalizedPath === '.' || normalizedPath !== portablePath) {
        return null;
    }
    const resolvedPath = path.resolve(repoRoot, normalizedPath);
    const relativeFromRoot = path.relative(path.resolve(repoRoot), resolvedPath);
    if (
        !relativeFromRoot
        || relativeFromRoot.startsWith('..')
        || path.isAbsolute(relativeFromRoot)
        || !isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: true })
    ) {
        return null;
    }
    return normalizedPath;
}

function normalizeCheckpointPaths(repoRoot: string, values: readonly unknown[]): string[] {
    const normalized = values.map((value) => normalizeCheckpointPath(repoRoot, value));
    if (normalized.some((value) => value == null)) {
        return [];
    }
    return [...new Set(normalized.filter((value): value is string => !!value))].sort();
}

function parseCheckpointFiles(notes: string): string[] | null {
    const match = CHECKPOINT_FILES_PATTERN.exec(notes);
    if (!match) {
        return null;
    }
    const values = [...String(match[1] || '').matchAll(/`([^`]+)`/gu)]
        .map((entry) => String(entry[1] || '').trim())
        .filter(Boolean);
    return values.length > 0 ? values : [];
}

function deriveParentTaskId(taskId: string): string | null {
    const parts = String(taskId || '').trim().split('-');
    if (parts.length < 3 || !/^\d+$/u.test(parts.at(-1) || '')) {
        return null;
    }
    return parts.slice(0, -1).join('-');
}

function explicitlyLinksChild(notes: string, childTaskId: string): boolean {
    return extractExplicitLinkedChildTaskIds(notes, [childTaskId]).includes(childTaskId);
}

function parseCommitHash(notes: string, pattern: RegExp): string | null {
    const match = pattern.exec(notes);
    return match ? String(match[1] || '').trim().toLowerCase() || null : null;
}

function getCommitParents(repoRoot: string, checkpointCommit: string): string[] {
    const canonicalCheckpointCommit = resolveCanonicalCommitObjectId(
        repoRoot,
        checkpointCommit,
        'Split checkpoint validation'
    );
    const output = runGitText(
        repoRoot,
        ['rev-list', '--parents', '-n', '1', canonicalCheckpointCommit],
        'Split checkpoint validation'
    );
    const parts = output.trim().split(/\s+/u).filter(Boolean);
    if (String(parts[0] || '').toLowerCase() !== canonicalCheckpointCommit) {
        throw new Error(
            'Split checkpoint validation: canonical checkpoint commit '
            + canonicalCheckpointCommit + ' was not returned by git rev-list.'
        );
    }
    return parts.slice(1).map((entry) => entry.toLowerCase());
}

function assertCheckpointRange(repoRoot: string, range: SplitCheckpointRange): void {
    const canonicalBaseCommit = resolveCanonicalCommitObjectId(
        repoRoot,
        range.base_commit,
        'Split checkpoint validation'
    );
    const canonicalCheckpointCommit = resolveCanonicalCommitObjectId(
        repoRoot,
        range.checkpoint_commit,
        'Split checkpoint validation'
    );
    const parents = getCommitParents(repoRoot, canonicalCheckpointCommit);
    if (parents.length !== 1 || parents[0] !== canonicalBaseCommit) {
        throw new Error(
            `Split checkpoint '${range.checkpoint_commit}' must have exactly one direct parent '${range.base_commit}'.`
        );
    }
    const ancestorStatus = runGitStatus(
        repoRoot,
        ['merge-base', '--is-ancestor', range.checkpoint_commit, 'HEAD'],
        'Split checkpoint validation'
    );
    if (ancestorStatus !== 0) {
        throw new Error(
            `Split checkpoint '${range.checkpoint_commit}' is not reachable from current HEAD; restore the recorded checkpoint branch before child execution.`
        );
    }
}

function getCheckpointChangedFiles(repoRoot: string, range: SplitCheckpointRange): string[] {
    const output = runGitText(
        repoRoot,
        [
            'diff',
            ...GIT_DIFF_HARDENING_ARGS,
            '--name-only',
            '-z',
            '--no-renames',
            '--diff-filter=ACDMRTUXB',
            range.base_commit,
            range.checkpoint_commit,
            '--'
        ],
        'Split checkpoint validation'
    );
    return [...new Set(
        splitNulRecords(output)
            .map((entry) => normalizeCheckpointPath(repoRoot, entry))
            .filter((entry): entry is string => !!entry)
    )].sort();
}

function getCheckpointRawDiff(repoRoot: string, range: SplitCheckpointRange, changedFiles: string[]): string {
    return runGitText(
        repoRoot,
        [
            'diff',
            ...GIT_DIFF_HARDENING_ARGS,
            '--raw',
            '--no-renames',
            '--diff-filter=ACDMRTUXB',
            range.base_commit,
            range.checkpoint_commit,
            '--',
            ...toLiteralGitPathspecs(changedFiles)
        ],
        'Split checkpoint snapshot'
    );
}

function getCheckpointWorktreeRawDiff(repoRoot: string, range: SplitCheckpointRange, changedFiles: string[]): string {
    return runGitText(
        repoRoot,
        [
            'diff',
            ...GIT_DIFF_HARDENING_ARGS,
            '--raw',
            '--no-renames',
            range.checkpoint_commit,
            '--',
            ...toLiteralGitPathspecs(changedFiles)
        ],
        'Split checkpoint worktree validation'
    );
}

function getCheckpointNumstat(
    repoRoot: string,
    range: SplitCheckpointRange,
    changedFiles: string[]
): Record<string, { additions: number; deletions: number; changed_lines: number }> {
    const output = runGitText(
        repoRoot,
        [
            'diff',
            ...GIT_DIFF_HARDENING_ARGS,
            '--numstat',
            '-z',
            '--no-renames',
            '--diff-filter=ACDMRTUXB',
            range.base_commit,
            range.checkpoint_commit,
            '--',
            ...toLiteralGitPathspecs(changedFiles)
        ],
        'Split checkpoint snapshot'
    );
    const stats: Record<string, { additions: number; deletions: number; changed_lines: number }> = {};
    for (const entry of parseNumstatZ(output)) {
        const changedFile = normalizeCheckpointPath(repoRoot, entry.path);
        if (!changedFile || !changedFiles.includes(changedFile)) {
            continue;
        }
        const additions = entry.additions ?? 0;
        const deletions = entry.deletions ?? 0;
        stats[changedFile] = {
            additions,
            deletions,
            changed_lines: additions + deletions
        };
    }
    return stats;
}

function buildScopeFingerprint(
    detectionSource: string,
    changedFiles: string[],
    changedLinesTotal: number,
    contentFingerprint: string | null
): string | null {
    const changedFilesFingerprint = stringSha256(changedFiles.join('\n'));
    return stringSha256(
        `${detectionSource}|false|false|${changedFiles.length}|${changedLinesTotal}|${changedFilesFingerprint || ''}|${contentFingerprint || ''}`
    );
}

export function buildSplitCheckpointDetectionSource(range: SplitCheckpointRange): string {
    return `${CHECKPOINT_DETECTION_SOURCE_PREFIX}${range.base_commit.toLowerCase()}:${range.checkpoint_commit.toLowerCase()}`;
}

export function parseSplitCheckpointDetectionSource(value: unknown): SplitCheckpointRange | null {
    const match = CHECKPOINT_DETECTION_SOURCE_PATTERN.exec(String(value || '').trim());
    if (!match) {
        return null;
    }
    return {
        base_commit: String(match[1] || '').toLowerCase(),
        checkpoint_commit: String(match[2] || '').toLowerCase()
    };
}

export function isSplitCheckpointDetectionSource(value: unknown): boolean {
    return parseSplitCheckpointDetectionSource(value) !== null;
}

export function getSplitCheckpointWorkspaceSnapshot(
    repoRoot: string,
    detectionSource: unknown,
    changedFiles: readonly unknown[]
): SplitCheckpointWorkspaceSnapshot {
    const range = parseSplitCheckpointDetectionSource(detectionSource);
    if (!range) {
        throw new Error(`Invalid split checkpoint detection source '${String(detectionSource || '')}'.`);
    }
    const normalizedChangedFiles = normalizeCheckpointPaths(repoRoot, changedFiles);
    if (normalizedChangedFiles.length === 0) {
        throw new Error('Split checkpoint scope must name at least one safe repository-relative file.');
    }
    assertCheckpointRange(repoRoot, range);
    const checkpointChangedFiles = new Set(getCheckpointChangedFiles(repoRoot, range));
    const outsideCheckpoint = normalizedChangedFiles.filter((changedFile) => !checkpointChangedFiles.has(changedFile));
    if (outsideCheckpoint.length > 0) {
        throw new Error(
            `Split checkpoint scope names files outside checkpoint '${range.checkpoint_commit}': ${outsideCheckpoint.join(', ')}.`
        );
    }
    const changedFileStats = getCheckpointNumstat(repoRoot, range, normalizedChangedFiles);
    const additionsTotal = Object.values(changedFileStats).reduce((total, entry) => total + entry.additions, 0);
    const deletionsTotal = Object.values(changedFileStats).reduce((total, entry) => total + entry.deletions, 0);
    const changedLinesTotal = additionsTotal + deletionsTotal;
    const checkpointRawDiff = getCheckpointRawDiff(repoRoot, range, normalizedChangedFiles);
    const worktreeRawDiff = getCheckpointWorktreeRawDiff(repoRoot, range, normalizedChangedFiles);
    const worktreeDrift = worktreeRawDiff.trim().length > 0;
    const contentFingerprint = stringSha256(
        worktreeDrift
            ? `${checkpointRawDiff}\n--worktree-drift--\n${worktreeRawDiff}`
            : checkpointRawDiff
    );
    const changedFilesFingerprint = stringSha256(normalizedChangedFiles.join('\n'));
    return {
        detection_source: buildSplitCheckpointDetectionSource(range),
        use_staged: false,
        include_untracked: false,
        changed_files: normalizedChangedFiles,
        changed_files_count: normalizedChangedFiles.length,
        ignored_generated_runtime_files: [],
        ignored_generated_runtime_files_count: 0,
        additions_total: additionsTotal,
        deletions_total: deletionsTotal,
        changed_lines_total: changedLinesTotal,
        changed_file_stats: changedFileStats,
        changed_files_sha256: changedFilesFingerprint,
        scope_content_sha256: contentFingerprint,
        scope_sha256: buildScopeFingerprint(
            buildSplitCheckpointDetectionSource(range),
            normalizedChangedFiles,
            changedLinesTotal,
            contentFingerprint
        ),
        split_checkpoint: {
            base_commit: range.base_commit,
            checkpoint_commit: range.checkpoint_commit,
            worktree_drift: worktreeDrift
        }
    };
}

export function resolveSplitCheckpointTaskScope(
    repoRoot: string,
    taskId: string,
    taskQueueEntries?: ReadonlyMap<string, TaskQueueEntry>
): SplitCheckpointScopeResolution {
    const taskEntries = taskQueueEntries || readTaskQueueEntries(repoRoot);
    const childTask = taskEntries.get(taskId);
    const notes = String(childTask?.notes || '');
    const checkpointCommit = parseCommitHash(notes, CHECKPOINT_COMMIT_PATTERN);
    const checkpointFiles = parseCheckpointFiles(notes);
    const hasCheckpointCommitMetadata = /\bcheckpoint(?:\s*:|\s+slice\b)/iu.test(notes);
    const hasCheckpointFilesMetadata = /\bcheckpoint files\s*:/iu.test(notes);
    if (!hasCheckpointCommitMetadata && !hasCheckpointFilesMetadata) {
        return { scope: null, violation: null };
    }
    if (!checkpointCommit || checkpointFiles === null) {
        return {
            scope: null,
            violation: `Task '${taskId}' must declare both \`Checkpoint: <sha>\` and \`Checkpoint files: \`path\`\` metadata before it can review a split checkpoint.`
        };
    }
    const parentTaskId = deriveParentTaskId(taskId);
    const parentTask = parentTaskId ? taskEntries.get(parentTaskId) : null;
    if (!parentTaskId || !parentTask || !isTaskQueueDecomposedStatus(parentTask.status)) {
        return {
            scope: null,
            violation: `Task '${taskId}' can use split checkpoint evidence only as a linked child of a DECOMPOSED parent task.`
        };
    }
    if (!explicitlyLinksChild(String(parentTask.notes || ''), taskId)) {
        return {
            scope: null,
            violation: `Parent task '${parentTaskId}' does not explicitly link split-checkpoint child '${taskId}'.`
        };
    }
    const parentCheckpointCommit = parseCommitHash(String(parentTask.notes || ''), PARENT_CHECKPOINT_COMMIT_PATTERN);
    if (!parentCheckpointCommit) {
        return {
            scope: null,
            violation: `Split checkpoint '${checkpointCommit}' for task '${taskId}' is not bound to parent task '${parentTaskId}'.`
        };
    }
    const changedFiles = normalizeCheckpointPaths(repoRoot, checkpointFiles);
    if (changedFiles.length !== checkpointFiles.length) {
        return {
            scope: null,
            violation: `Task '${taskId}' contains unsafe split-checkpoint file metadata.`
        };
    }
    try {
        const canonicalCheckpointCommit = resolveCanonicalCommitObjectId(
            repoRoot,
            checkpointCommit,
            'Split checkpoint validation'
        );
        const canonicalParentCheckpointCommit = resolveCanonicalCommitObjectId(
            repoRoot,
            parentCheckpointCommit,
            'Split checkpoint validation'
        );
        if (canonicalParentCheckpointCommit !== canonicalCheckpointCommit) {
            return {
                scope: null,
                violation: 'Split checkpoint ' + canonicalCheckpointCommit + ' for task ' + taskId
                    + ' is not bound to parent task ' + parentTaskId + '.'
            };
        }
        const parents = getCommitParents(repoRoot, canonicalCheckpointCommit);
        if (parents.length !== 1) {
            return {
                scope: null,
                violation: `Split checkpoint '${checkpointCommit}' must have exactly one parent.`
            };
        }
        const subject = runGitText(
            repoRoot,
            ['show', '-s', '--format=%s', canonicalCheckpointCommit],
            'Split checkpoint validation'
        ).trim();
        let checkpointOwnerTaskId = parentTaskId;
        let expectedSubject = `checkpoint(split): preserve ${checkpointOwnerTaskId} dirty diff before decomposition`;
        while (subject !== expectedSubject) {
            const ancestorTaskId = deriveParentTaskId(checkpointOwnerTaskId);
            const ancestorTask = ancestorTaskId ? taskEntries.get(ancestorTaskId) : null;
            if (
                !ancestorTaskId
                || !ancestorTask
                || !isTaskQueueDecomposedStatus(ancestorTask.status)
                || !explicitlyLinksChild(String(ancestorTask.notes || ''), checkpointOwnerTaskId)
            ) {
                break;
            }
            const ancestorCheckpointCommit = parseCommitHash(
                String(ancestorTask.notes || ''),
                PARENT_CHECKPOINT_COMMIT_PATTERN
            );
            if (!ancestorCheckpointCommit || resolveCanonicalCommitObjectId(
                repoRoot,
                ancestorCheckpointCommit,
                'Split checkpoint validation'
            ) !== canonicalCheckpointCommit) {
                break;
            }
            checkpointOwnerTaskId = ancestorTaskId;
            expectedSubject = `checkpoint(split): preserve ${checkpointOwnerTaskId} dirty diff before decomposition`;
        }
        if (subject !== expectedSubject) {
            return {
                scope: null,
                violation: `Split checkpoint '${checkpointCommit}' subject must be '${expectedSubject}'.`
            };
        }
        const range = {
            base_commit: parents[0],
            checkpoint_commit: canonicalCheckpointCommit
        };
        assertCheckpointRange(repoRoot, range);
        const checkpointChangedFiles = new Set(getCheckpointChangedFiles(repoRoot, range));
        const outsideCheckpoint = changedFiles.filter((changedFile) => !checkpointChangedFiles.has(changedFile));
        if (outsideCheckpoint.length > 0) {
            return {
                scope: null,
                violation: `Task '${taskId}' assigns files outside split checkpoint '${checkpointCommit}': ${outsideCheckpoint.join(', ')}.`
            };
        }
        if (getCheckpointWorktreeRawDiff(repoRoot, range, changedFiles).trim()) {
            return {
                scope: null,
                violation: `Split checkpoint files for task '${taskId}' differ from checkpoint '${checkpointCommit}'. Reclassify the current remediation diff instead of reusing checkpoint scope.`
            };
        }
        return {
            scope: {
                task_id: taskId,
                parent_task_id: parentTaskId,
                base_commit: range.base_commit,
                checkpoint_commit: canonicalCheckpointCommit,
                changed_files: changedFiles,
                detection_source: buildSplitCheckpointDetectionSource(range)
            },
            violation: null
        };
    } catch (error: unknown) {
        return {
            scope: null,
            violation: error instanceof Error ? error.message : String(error)
        };
    }
}

export function resolveAuthenticatedSplitCheckpointPreflightScope(
    repoRoot: string,
    taskId: unknown,
    detectionSource: unknown,
    changedFiles: readonly unknown[]
): SplitCheckpointTaskScope {
    const requestedRange = parseSplitCheckpointDetectionSource(detectionSource);
    if (!requestedRange) {
        throw new Error('Split checkpoint preflight detection source is invalid.');
    }
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
        throw new Error('Split checkpoint preflight task_id is required.');
    }
    const resolution = resolveSplitCheckpointTaskScope(repoRoot, normalizedTaskId);
    if (resolution.violation) {
        throw new Error('Split checkpoint preflight authentication failed: ' + resolution.violation);
    }
    if (!resolution.scope) {
        throw new Error(
            'Split checkpoint preflight authentication failed: task '
            + normalizedTaskId + ' has no authenticated split checkpoint scope.'
        );
    }
    const requestedDetectionSource = buildSplitCheckpointDetectionSource(requestedRange);
    if (resolution.scope.detection_source !== requestedDetectionSource) {
        throw new Error(
            'Split checkpoint preflight range does not match the authenticated task checkpoint scope.'
        );
    }
    const normalizedChangedFiles = normalizeCheckpointPaths(repoRoot, changedFiles);
    if (
        normalizedChangedFiles.length !== changedFiles.length
        || normalizedChangedFiles.length !== resolution.scope.changed_files.length
        || normalizedChangedFiles.some((changedFile, index) => changedFile !== resolution.scope?.changed_files[index])
    ) {
        throw new Error(
            'Split checkpoint preflight changed_files do not match the authenticated task checkpoint scope.'
        );
    }
    return resolution.scope;
}
