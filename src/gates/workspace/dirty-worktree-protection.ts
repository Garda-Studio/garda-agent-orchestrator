import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
    buildGitChangeClassificationEvidence,
    classifyGitChanges,
    normalizeGitChangeClassificationEvidence,
    type GitChangeClassificationEvidence
} from '../../core/git-change-classification';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import { inspectFilesystemLock, type LockHandle } from '../../gate-runtime/task-events-locking';
import {
    fileSha256,
    isPathRealpathInsideRoot,
    joinOrchestratorPath,
    normalizePath,
    stringSha256,
    toPlainRecord
} from '../shared/helpers';

export interface DirtyWorkspaceBaseline {
    detection_source: string;
    include_untracked: boolean;
    changed_files: string[];
    changed_files_sha256: string | null;
    scope_sha256: string | null;
    file_hashes: Record<string, string | null>;
    entry_authorized_files?: string[];
    staged_files?: string[];
    staged_trust?: StagedBaselineTrustEvidence | null;
    git_change_classification?: GitChangeClassificationEvidence | null;
}

export interface StagedBaselineTrustEvidence {
    schema_version: 1;
    salt: string;
    files: Record<string, StagedBaselineTrustFileEvidence>;
}

export interface StagedBaselineTrustFileEvidence {
    schema_version: 1;
    status: 'present' | 'deleted';
    mode: string;
    object_id_sha256: string | null;
    content_sha256: string | null;
    line_fingerprint_sha256: string | null;
}

export interface TaskOwnedDirtyWorkspaceScope {
    owned_files: string[];
    owned_files_sha256: string | null;
    owned_preexisting_files: string[];
    owned_new_files: string[];
    explicitly_selected_preexisting_files: string[];
    delta_changed_preexisting_files: string[];
    untouched_preexisting_files: string[];
    explicitly_authorized_preexisting_files: string[];
    baseline_file_hashes: Record<string, string | null>;
    current_file_hashes: Record<string, string | null>;
    staged_baseline_trust_status: 'NOT_APPLICABLE' | 'PASS' | 'FAIL';
    staged_baseline_trust_violations: string[];
}

export interface DeriveTaskOwnedDirtyWorkspaceScopeOptions {
    isExplicitTaskScope?: boolean;
    plannedChangedFiles?: string[];
    useStaged?: boolean;
}

export interface ProtectedDirtyWorkspaceScope {
    protected_files: string[];
    protected_files_sha256: string | null;
    protected_file_hashes: Record<string, string | null>;
}

export interface ProtectedDirtyWorkspaceDriftResult {
    status: 'NOT_APPLICABLE' | 'PASS' | 'DRIFT_DETECTED';
    assessment: 'NOT_APPLICABLE' | 'INFO_IGNORED_PROTECTED_LOCAL_BASELINE' | 'PROTECTED_LOCAL_BASELINE_DRIFT';
    protected_files: string[];
    protected_files_sha256: string | null;
    baseline_file_hashes: Record<string, string | null>;
    current_file_hashes: Record<string, string | null>;
    changed_files: string[];
    violations: string[];
}

function normalizeRelativePaths(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return [...new Set(
        values
            .map((value) => normalizePath(value))
            .filter(Boolean)
    )].sort();
}

function normalizeFileHashRecord(value: unknown, allowedPaths: string[]): Record<string, string | null> {
    const source = toPlainRecord(value) || {};
    const result: Record<string, string | null> = {};
    for (const relativePath of allowedPaths) {
        if (!Object.prototype.hasOwnProperty.call(source, relativePath)) {
            result[relativePath] = null;
            continue;
        }
        const hashValue = source[relativePath];
        if (hashValue == null || String(hashValue).trim() === '') {
            result[relativePath] = null;
            continue;
        }
        result[relativePath] = String(hashValue).trim().toLowerCase();
    }
    return result;
}

function resolveWorkspacePath(repoRoot: string, relativePath: string): string | null {
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedPath = path.resolve(resolvedRoot, relativePath);
    const relativeFromRoot = path.relative(resolvedRoot, resolvedPath);
    if (!relativeFromRoot || relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
        return null;
    }
    return resolvedPath;
}

export function normalizeWorkspaceRelativePath(repoRoot: string, value: unknown): string | null {
    const rawPath = String(value || '').trim();
    if (!rawPath || rawPath.includes('\0')) {
        return null;
    }
    const portablePath = rawPath.replace(/\\/g, '/');
    if (
        path.isAbsolute(rawPath)
        || path.win32.isAbsolute(rawPath)
        || path.posix.isAbsolute(portablePath)
        || /^[a-z]:/i.test(portablePath)
        || portablePath.split('/').some((segment) => segment === '..')
    ) {
        return null;
    }
    const normalizedPath = normalizePath(portablePath);
    if (!normalizedPath || normalizedPath === '.') {
        return null;
    }
    const resolvedPath = resolveWorkspacePath(repoRoot, normalizedPath);
    if (!resolvedPath || !isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: true })) {
        return null;
    }
    return normalizedPath;
}

export function normalizeWorkspaceRelativePaths(repoRoot: string, values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return [...new Set(
        values
            .map((value) => normalizeWorkspaceRelativePath(repoRoot, value))
            .filter((value): value is string => !!value)
    )].sort();
}

function getGitTrackedPaths(repoRoot: string, relativePaths: string[]): Set<string> {
    const normalizedPaths = normalizeWorkspaceRelativePaths(repoRoot, relativePaths);
    if (normalizedPaths.length === 0) {
        return new Set();
    }
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            repoRoot,
            'ls-files',
            '-z',
            '--',
            ...normalizedPaths.map((relativePath) => `:(literal)${relativePath}`)
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
        });
        if (result.status !== 0) {
            return new Set();
        }
        return new Set(normalizeWorkspaceRelativePaths(repoRoot, String(result.stdout || '').split('\0')));
    } catch {
        return new Set();
    }
}

function getStagedRenameSourcePaths(repoRoot: string, currentScopeChangedFiles: string[]): string[] {
    const currentFileSet = new Set(normalizeWorkspaceRelativePaths(repoRoot, currentScopeChangedFiles));
    if (currentFileSet.size === 0) {
        return [];
    }
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            repoRoot,
            'diff',
            '--cached',
            '--name-status',
            '-z',
            '--find-renames',
            '--diff-filter=R'
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
        });
        if (result.status !== 0) {
            return [];
        }
        const entries = String(result.stdout || '').split('\0');
        const renamedSources: string[] = [];
        for (let index = 0; index < entries.length;) {
            const status = String(entries[index++] || '').trim();
            if (!/^R\d*$/.test(status)) {
                continue;
            }
            const sourcePath = normalizeWorkspaceRelativePath(repoRoot, entries[index++] || '');
            const targetPath = normalizeWorkspaceRelativePath(repoRoot, entries[index++] || '');
            if (sourcePath && targetPath && currentFileSet.has(targetPath)) {
                renamedSources.push(sourcePath);
            }
        }
        return normalizeWorkspaceRelativePaths(repoRoot, renamedSources);
    } catch {
        return [];
    }
}

function getStagedChangedFiles(repoRoot: string, relativePaths: string[]): string[] {
    const normalizedPathSet = new Set(normalizeWorkspaceRelativePaths(repoRoot, relativePaths));
    if (normalizedPathSet.size === 0) {
        return [];
    }
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            repoRoot,
            'diff',
            '--cached',
            '--name-only',
            '-z',
            '--diff-filter=ACDMRTUXB',
            '--',
            ...[...normalizedPathSet].map((relativePath) => `:(literal)${relativePath}`)
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
        });
        if (result.status !== 0) {
            return [];
        }
        return normalizeWorkspaceRelativePaths(repoRoot, String(result.stdout || '').split('\0'))
            .filter((relativePath) => normalizedPathSet.has(relativePath));
    } catch {
        return [];
    }
}

interface StagedIndexEntry {
    path: string;
    status: 'present' | 'deleted';
    mode: string;
    objectId: string;
}

function getStagedDeletedFiles(repoRoot: string, relativePaths: string[]): string[] {
    const normalizedPathSet = new Set(normalizeWorkspaceRelativePaths(repoRoot, relativePaths));
    if (normalizedPathSet.size === 0) {
        return [];
    }
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            repoRoot,
            'diff',
            '--cached',
            '--name-status',
            '-z',
            '--diff-filter=D',
            '--',
            ...[...normalizedPathSet].map((relativePath) => `:(literal)${relativePath}`)
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
        });
        if (result.status !== 0) {
            return [];
        }
        const entries = String(result.stdout || '').split('\0');
        const deletedFiles: string[] = [];
        for (let index = 0; index < entries.length;) {
            const status = String(entries[index++] || '').trim();
            const deletedPath = normalizeWorkspaceRelativePath(repoRoot, entries[index++] || '');
            if (status === 'D' && deletedPath && normalizedPathSet.has(deletedPath)) {
                deletedFiles.push(deletedPath);
            }
        }
        return normalizeWorkspaceRelativePaths(repoRoot, deletedFiles);
    } catch {
        return [];
    }
}

function getHeadTreeEntry(repoRoot: string, relativePath: string): StagedIndexEntry | null {
    const normalizedPath = normalizeWorkspaceRelativePath(repoRoot, relativePath);
    if (!normalizedPath) {
        return null;
    }
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            repoRoot,
            'ls-tree',
            '-z',
            'HEAD',
            '--',
            `:(literal)${normalizedPath}`
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
        });
        if (result.status !== 0) {
            return null;
        }
        const rawEntry = String(result.stdout || '').split('\0').find((entry) => entry.trim());
        const match = rawEntry ? /^(\d+)\s+\S+\s+([0-9a-f]{40,64})\t(.+)$/.exec(rawEntry.trim()) : null;
        const entryPath = normalizeWorkspaceRelativePath(repoRoot, match?.[3] || '');
        if (!match || entryPath !== normalizedPath) {
            return null;
        }
        return {
            path: normalizedPath,
            status: 'deleted',
            mode: match[1],
            objectId: String(match[2] || '').toLowerCase()
        };
    } catch {
        return null;
    }
}

function getStagedIndexEntries(repoRoot: string, relativePaths: string[]): Map<string, StagedIndexEntry> {
    const normalizedPaths = normalizeWorkspaceRelativePaths(repoRoot, relativePaths);
    const stagedChangedPathSet = new Set(getStagedChangedFiles(repoRoot, normalizedPaths));
    const stagedDeletedFiles = getStagedDeletedFiles(repoRoot, normalizedPaths);
    const entries = new Map<string, StagedIndexEntry>();
    if (normalizedPaths.length === 0 || stagedChangedPathSet.size === 0) {
        return entries;
    }
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            repoRoot,
            'ls-files',
            '-s',
            '-z',
            '--',
            ...normalizedPaths.map((relativePath) => `:(literal)${relativePath}`)
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
        });
        if (result.status !== 0) {
            return entries;
        }
        for (const rawEntry of String(result.stdout || '').split('\0')) {
            const entry = rawEntry.trim();
            if (!entry) {
                continue;
            }
            const match = /^(\d+)\s+([0-9a-f]{40,64})\s+\d+\t(.+)$/.exec(entry);
            if (!match) {
                continue;
            }
            const normalizedPath = normalizeWorkspaceRelativePath(repoRoot, match[3] || '');
            if (!normalizedPath) {
                continue;
            }
            if (!stagedChangedPathSet.has(normalizedPath)) {
                continue;
            }
            entries.set(normalizedPath, {
                path: normalizedPath,
                status: 'present',
                mode: match[1],
                objectId: String(match[2] || '').toLowerCase()
            });
        }
    } catch {
        return entries;
    }
    for (const deletedFile of stagedDeletedFiles) {
        if (entries.has(deletedFile)) {
            continue;
        }
        const headEntry = getHeadTreeEntry(repoRoot, deletedFile);
        if (headEntry) {
            entries.set(deletedFile, headEntry);
        }
    }
    return entries;
}

function readStagedBlobText(repoRoot: string, objectId: string): string | null {
    if (!/^[0-9a-f]{40,64}$/i.test(objectId)) {
        return null;
    }
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            repoRoot,
            'cat-file',
            '-p',
            objectId
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
        });
        if (result.status !== 0 || result.timedOut || result.error) {
            return null;
        }
        return String(result.stdout || '');
    } catch {
        return null;
    }
}

function buildStagedTrustFileEvidence(
    repoRoot: string,
    salt: string,
    entry: StagedIndexEntry
): StagedBaselineTrustFileEvidence {
    const blobText = readStagedBlobText(repoRoot, entry.objectId);
    const normalizedLines = blobText == null ? null : blobText.replace(/\r\n/g, '\n');
    return {
        schema_version: 1,
        status: entry.status,
        mode: entry.mode,
        object_id_sha256: stringSha256(`${salt}:object:${entry.status}:${entry.mode}:${entry.objectId}`),
        content_sha256: blobText == null ? null : stringSha256(`${salt}:content:${entry.status}:${blobText}`),
        line_fingerprint_sha256: normalizedLines == null
            ? null
            : stringSha256(`${salt}:lines:${entry.status}:${normalizedLines.split('\n').length}:${normalizedLines}`)
    };
}

function buildStagedBaselineTrustEvidence(
    repoRoot: string,
    stagedFiles: string[]
): StagedBaselineTrustEvidence | null {
    const stagedEntries = getStagedIndexEntries(repoRoot, stagedFiles);
    if (stagedEntries.size === 0) {
        return null;
    }
    const salt = randomBytes(16).toString('hex');
    const files: Record<string, StagedBaselineTrustFileEvidence> = {};
    for (const entry of [...stagedEntries.values()].sort((left, right) => left.path.localeCompare(right.path))) {
        files[entry.path] = buildStagedTrustFileEvidence(repoRoot, salt, entry);
    }
    return {
        schema_version: 1,
        salt,
        files
    };
}

function normalizeStagedTrustEvidence(
    value: unknown,
    allowedPaths: string[]
): StagedBaselineTrustEvidence | null {
    const evidence = toPlainRecord(value);
    if (!evidence || evidence.schema_version !== 1) {
        return null;
    }
    const salt = String(evidence.salt || '').trim();
    const rawFiles = toPlainRecord(evidence.files);
    if (!salt || !rawFiles) {
        return null;
    }
    const allowedPathSet = new Set(allowedPaths);
    const files: Record<string, StagedBaselineTrustFileEvidence> = {};
    for (const [filePath, rawEntry] of Object.entries(rawFiles)) {
        if (!allowedPathSet.has(filePath)) {
            continue;
        }
        const entry = toPlainRecord(rawEntry);
        if (!entry || entry.schema_version !== 1) {
            continue;
        }
        files[filePath] = {
            schema_version: 1,
            status: entry.status === 'deleted' ? 'deleted' : 'present',
            mode: String(entry.mode || '').trim(),
            object_id_sha256: String(entry.object_id_sha256 || '').trim().toLowerCase() || null,
            content_sha256: String(entry.content_sha256 || '').trim().toLowerCase() || null,
            line_fingerprint_sha256: String(entry.line_fingerprint_sha256 || '').trim().toLowerCase() || null
        };
    }
    return {
        schema_version: 1,
        salt,
        files
    };
}

function verifyStagedBaselineTrust(
    repoRoot: string,
    baseline: DirtyWorkspaceBaseline,
    relevantBaselineFiles: string[]
): { status: 'NOT_APPLICABLE' | 'PASS' | 'FAIL'; violations: string[] } {
    const relevantFileSet = new Set(normalizeWorkspaceRelativePaths(repoRoot, relevantBaselineFiles));
    const baselineStagedFiles = normalizeWorkspaceRelativePaths(repoRoot, [
        ...(baseline.staged_files || []),
        ...Object.keys(baseline.staged_trust?.files || {})
    ]);
    const baselineStagedRelevantFiles = baselineStagedFiles.filter((relativePath) => relevantFileSet.has(relativePath));
    if (baselineStagedRelevantFiles.length === 0) {
        return { status: 'NOT_APPLICABLE', violations: [] };
    }
    const evidence = baseline.staged_trust || null;
    if (!evidence) {
        return {
            status: 'FAIL',
            violations: [
                `Missing staged dirty-baseline trust evidence for staged baseline files: ${baselineStagedRelevantFiles.join(', ')}.`
            ]
        };
    }
    const stagedEntries = getStagedIndexEntries(repoRoot, baselineStagedRelevantFiles);
    const violations: string[] = [];
    for (const relativePath of baselineStagedRelevantFiles) {
        const entry = stagedEntries.get(relativePath);
        if (!entry) {
            violations.push(`Missing current staged index entry for staged baseline file '${relativePath}'.`);
            continue;
        }
        const expected = evidence.files[relativePath];
        if (!expected) {
            violations.push(`Missing staged trust fingerprint for '${relativePath}'.`);
            continue;
        }
        const actual = buildStagedTrustFileEvidence(repoRoot, evidence.salt, entry);
        if (expected.status !== actual.status) {
            violations.push(`Staged trust status mismatch for '${relativePath}'.`);
        }
        if (expected.mode !== actual.mode) {
            violations.push(`Staged trust mode mismatch for '${relativePath}'.`);
        }
        if (!expected.object_id_sha256 || expected.object_id_sha256 !== actual.object_id_sha256) {
            violations.push(`Staged trust object fingerprint mismatch for '${relativePath}'.`);
        }
        if (!expected.content_sha256 || expected.content_sha256 !== actual.content_sha256) {
            violations.push(`Staged trust content fingerprint mismatch for '${relativePath}'.`);
        }
        if (!expected.line_fingerprint_sha256 || expected.line_fingerprint_sha256 !== actual.line_fingerprint_sha256) {
            violations.push(`Staged trust line fingerprint mismatch for '${relativePath}'.`);
        }
    }
    return {
        status: violations.length > 0 ? 'FAIL' : 'PASS',
        violations
    };
}

function collectExplicitlyAuthorizedDirtyPaths(
    repoRoot: string,
    changedFiles: string[],
    plannedChangedFiles: string[]
): string[] {
    const changedFileSet = new Set(normalizeWorkspaceRelativePaths(repoRoot, changedFiles));
    const normalizedPlannedFiles = normalizeWorkspaceRelativePaths(repoRoot, plannedChangedFiles);
    const trackedFileSet = getGitTrackedPaths(repoRoot, normalizedPlannedFiles);
    const result: string[] = [];
    for (const relativePath of normalizedPlannedFiles) {
        if (changedFileSet.has(relativePath) || trackedFileSet.has(relativePath)) {
            continue;
        }
        const absolutePath = resolveWorkspacePath(repoRoot, relativePath);
        if (!absolutePath) {
            continue;
        }
        try {
            const stat = fs.lstatSync(absolutePath);
            if (stat.isFile() || stat.isSymbolicLink()) {
                result.push(relativePath);
            }
        } catch {
            // A missing planned path is not a pre-task dirty baseline entry.
        }
    }
    return [...new Set(result)].sort();
}

function buildFileHashMap(repoRoot: string, relativePaths: string[]): Record<string, string | null> {
    const normalizedPaths = normalizeWorkspaceRelativePaths(repoRoot, relativePaths);
    const fileHashes: Record<string, string | null> = {};
    for (const relativePath of normalizedPaths) {
        const absolutePath = resolveWorkspacePath(repoRoot, relativePath);
        fileHashes[relativePath] = absolutePath ? fileSha256(absolutePath) : null;
    }
    return fileHashes;
}

function resolveOwnedEntryLockMetadataPath(repoRoot: string, lock: LockHandle): string {
    const expectedLockPath = joinOrchestratorPath(repoRoot, 'runtime/task-queue-locks/active-implementation.lock');
    const metadataPath = path.join(expectedLockPath, 'owner.json');
    const relativePath = normalizeWorkspaceRelativePath(repoRoot, path.relative(repoRoot, metadataPath));
    const inspection = inspectFilesystemLock(expectedLockPath);
    if (path.resolve(lock.lockPath) !== path.resolve(expectedLockPath) || !relativePath
        || !lock.lockId || inspection.metadata.lock_id !== lock.lockId
        || inspection.metadata.pid !== process.pid || inspection.ownerHostMatchesCurrent !== true
        || !fs.lstatSync(expectedLockPath).isDirectory() || fs.lstatSync(expectedLockPath).isSymbolicLink()
        || !fs.lstatSync(metadataPath).isFile() || fs.lstatSync(metadataPath).isSymbolicLink()) {
        throw new Error('Cannot capture the task-entry baseline without its current implementation ownership lock.');
    }
    return relativePath;
}

export function captureDirtyWorkspaceBaseline(
    repoRoot: string,
    plannedChangedFiles: string[] = [],
    ownershipLock?: LockHandle
): DirtyWorkspaceBaseline {
    const ownedLockMetadataPath = ownershipLock ? resolveOwnedEntryLockMetadataPath(repoRoot, ownershipLock) : null;
    const gitChangeClassification = buildGitChangeClassificationEvidence(classifyGitChanges(repoRoot, {
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    }));
    const snapshotChangedFiles = normalizeWorkspaceRelativePaths(
        repoRoot,
        gitChangeClassification.effective_changed_files
    );
    // Preserve the raw Git evidence; only the untracked metadata of this entry's
    // acquired lock is temporary. Tracked metadata and neighbouring WIP remain protected.
    const temporaryLockMetadataPath = ownedLockMetadataPath
        && gitChangeClassification.untracked_files.includes(ownedLockMetadataPath)
        && !gitChangeClassification.staged_files.includes(ownedLockMetadataPath)
        ? ownedLockMetadataPath : null;
    const changedFiles = [...new Set([
        ...snapshotChangedFiles,
        ...collectExplicitlyAuthorizedDirtyPaths(repoRoot, snapshotChangedFiles, plannedChangedFiles)
    ])].filter(relativePath => relativePath !== temporaryLockMetadataPath).sort();
    if (ownershipLock) resolveOwnedEntryLockMetadataPath(repoRoot, ownershipLock);
    const changedFileSet = new Set(changedFiles);
    const entryAuthorizedFiles = normalizeWorkspaceRelativePaths(repoRoot, plannedChangedFiles)
        .filter((relativePath) => changedFileSet.has(relativePath));
    const stagedFiles = normalizeWorkspaceRelativePaths(repoRoot, gitChangeClassification.staged_files)
        .filter((relativePath) => changedFileSet.has(relativePath));
    const classificationScopeSha256 = stringSha256(JSON.stringify(gitChangeClassification));
    return {
        detection_source: 'git_auto',
        include_untracked: true,
        changed_files: changedFiles,
        changed_files_sha256: stringSha256(changedFiles.join('\n')),
        scope_sha256: !temporaryLockMetadataPath && changedFiles.length === snapshotChangedFiles.length
            ? classificationScopeSha256
            : stringSha256(`${classificationScopeSha256 || ''}|${changedFiles.join('\n')}`),
        file_hashes: buildFileHashMap(repoRoot, changedFiles),
        entry_authorized_files: entryAuthorizedFiles,
        staged_files: stagedFiles,
        staged_trust: buildStagedBaselineTrustEvidence(repoRoot, stagedFiles),
        git_change_classification: gitChangeClassification
    };
}

export function normalizeDirtyWorkspaceBaseline(value: unknown, repoRoot?: string): DirtyWorkspaceBaseline | null {
    const baseline = toPlainRecord(value);
    if (!baseline) {
        return null;
    }
    const changedFiles = repoRoot
        ? normalizeWorkspaceRelativePaths(repoRoot, baseline.changed_files)
        : normalizeRelativePaths(baseline.changed_files);
    return {
        detection_source: String(baseline.detection_source || 'git_auto').trim() || 'git_auto',
        include_untracked: baseline.include_untracked == null ? true : !!baseline.include_untracked,
        changed_files: changedFiles,
        changed_files_sha256: String(
            baseline.changed_files_sha256 || stringSha256(changedFiles.join('\n')) || ''
        ).trim().toLowerCase() || null,
        scope_sha256: String(baseline.scope_sha256 || '').trim().toLowerCase() || null,
        file_hashes: normalizeFileHashRecord(baseline.file_hashes, changedFiles),
        entry_authorized_files: (repoRoot
            ? normalizeWorkspaceRelativePaths(repoRoot, baseline.entry_authorized_files)
            : normalizeRelativePaths(baseline.entry_authorized_files))
            .filter((relativePath) => changedFiles.includes(relativePath)),
        staged_files: (repoRoot
            ? normalizeWorkspaceRelativePaths(repoRoot, baseline.staged_files)
            : normalizeRelativePaths(baseline.staged_files))
            .filter((relativePath) => changedFiles.includes(relativePath)),
        staged_trust: normalizeStagedTrustEvidence(baseline.staged_trust, changedFiles),
        git_change_classification: normalizeGitChangeClassificationEvidence(
            baseline.git_change_classification
        )
    };
}

export function buildStagedBaselineTrustInputFingerprint(
    baseline: DirtyWorkspaceBaseline | null,
    repoRoot?: string
): string | null {
    const normalizedBaseline = normalizeDirtyWorkspaceBaseline(baseline, repoRoot);
    if (!normalizedBaseline) {
        return null;
    }
    const stagedFiles = [...new Set([
        ...(normalizedBaseline.staged_files || []),
        ...Object.keys(normalizedBaseline.staged_trust?.files || {})
    ])].sort();
    if (stagedFiles.length === 0 && !normalizedBaseline.staged_trust) {
        return null;
    }
    const trustFiles = normalizedBaseline.staged_trust?.files || {};
    return stringSha256(JSON.stringify({
        schema_version: 1,
        staged_files: stagedFiles,
        staged_trust: normalizedBaseline.staged_trust
            ? {
                schema_version: normalizedBaseline.staged_trust.schema_version,
                salt: normalizedBaseline.staged_trust.salt,
                files: Object.fromEntries(
                    Object.entries(trustFiles)
                        .sort(([left], [right]) => left.localeCompare(right))
                        .map(([relativePath, evidence]) => [relativePath, {
                            schema_version: evidence.schema_version,
                            status: evidence.status,
                            mode: evidence.mode,
                            object_id_sha256: evidence.object_id_sha256,
                            content_sha256: evidence.content_sha256,
                            line_fingerprint_sha256: evidence.line_fingerprint_sha256
                        }])
                )
            }
            : null
    })) || null;
}

export function deriveTaskOwnedDirtyWorkspaceScope(
    repoRoot: string,
    baseline: DirtyWorkspaceBaseline | null,
    currentScopeChangedFiles: string[],
    options: DeriveTaskOwnedDirtyWorkspaceScopeOptions = {}
): TaskOwnedDirtyWorkspaceScope | null {
    const normalizedBaseline = normalizeDirtyWorkspaceBaseline(baseline, repoRoot);
    if (!normalizedBaseline) {
        return null;
    }

    const currentFiles = normalizeWorkspaceRelativePaths(repoRoot, currentScopeChangedFiles);
    const baselineFileSet = new Set(normalizedBaseline.changed_files);
    const currentFileSet = new Set(currentFiles);
    const stagedRenameSourceSet = new Set(
        options.useStaged === true
            ? getStagedRenameSourcePaths(repoRoot, currentFiles)
            : []
    );
    const explicitlyAuthorizedPreexistingFiles = normalizeWorkspaceRelativePaths(repoRoot, [
        ...(normalizedBaseline.entry_authorized_files || []),
        ...(options.plannedChangedFiles || [])
    ]).filter((relativePath) => baselineFileSet.has(relativePath));
    const explicitlyAuthorizedPreexistingSet = new Set(explicitlyAuthorizedPreexistingFiles);
    const candidateFiles = [...new Set([
        ...normalizedBaseline.changed_files,
        ...currentFiles,
        ...explicitlyAuthorizedPreexistingFiles
    ])].sort();
    const currentFileHashes = buildFileHashMap(repoRoot, candidateFiles);
    const relevantStagedBaselineFiles = normalizedBaseline.changed_files.filter((relativePath) => (
        currentFileSet.has(relativePath)
            || explicitlyAuthorizedPreexistingSet.has(relativePath)
            || stagedRenameSourceSet.has(relativePath)
    ));
    const stagedTrust = options.useStaged === true
        ? verifyStagedBaselineTrust(repoRoot, normalizedBaseline, relevantStagedBaselineFiles)
        : { status: 'NOT_APPLICABLE' as const, violations: [] };
    if (stagedTrust.status === 'FAIL') {
        return {
            owned_files: [],
            owned_files_sha256: stringSha256(''),
            owned_preexisting_files: [],
            owned_new_files: [],
            explicitly_selected_preexisting_files: [],
            delta_changed_preexisting_files: [],
            untouched_preexisting_files: normalizedBaseline.changed_files,
            explicitly_authorized_preexisting_files: explicitlyAuthorizedPreexistingFiles,
            baseline_file_hashes: normalizeFileHashRecord(normalizedBaseline.file_hashes, normalizedBaseline.changed_files),
            current_file_hashes: currentFileHashes,
            staged_baseline_trust_status: 'FAIL',
            staged_baseline_trust_violations: stagedTrust.violations
        };
    }
    const deltaChangedPreexistingFiles = normalizedBaseline.changed_files.filter((relativePath) => {
        if (
            !currentFileSet.has(relativePath)
            && !explicitlyAuthorizedPreexistingSet.has(relativePath)
            && !stagedRenameSourceSet.has(relativePath)
        ) {
            return false;
        }
        return normalizedBaseline.file_hashes[relativePath] !== currentFileHashes[relativePath];
    });
    const explicitlySelectedPreexistingFiles = normalizedBaseline.changed_files.filter((relativePath) => {
        if (!currentFileSet.has(relativePath)) {
            return false;
        }
        return options.isExplicitTaskScope === true || explicitlyAuthorizedPreexistingSet.has(relativePath);
    });
    const ownedPreexistingFiles = [...new Set([
        ...deltaChangedPreexistingFiles,
        ...explicitlySelectedPreexistingFiles
    ])].sort();
    const ownedPreexistingSet = new Set(ownedPreexistingFiles);
    const ownedNewFiles = currentFiles.filter((relativePath) => !baselineFileSet.has(relativePath));
    const ownedFiles = [...new Set([
        ...ownedPreexistingFiles,
        ...ownedNewFiles
    ])].sort();

    return {
        owned_files: ownedFiles,
        owned_files_sha256: stringSha256(ownedFiles.join('\n')),
        owned_preexisting_files: ownedPreexistingFiles,
        owned_new_files: ownedNewFiles,
        explicitly_selected_preexisting_files: explicitlySelectedPreexistingFiles,
        delta_changed_preexisting_files: deltaChangedPreexistingFiles,
        untouched_preexisting_files: normalizedBaseline.changed_files
            .filter((relativePath) => !ownedPreexistingSet.has(relativePath)),
        explicitly_authorized_preexisting_files: explicitlyAuthorizedPreexistingFiles,
        baseline_file_hashes: normalizeFileHashRecord(normalizedBaseline.file_hashes, normalizedBaseline.changed_files),
        current_file_hashes: currentFileHashes,
        staged_baseline_trust_status: stagedTrust.status,
        staged_baseline_trust_violations: stagedTrust.violations
    };
}

export function deriveProtectedDirtyWorkspaceScope(
    repoRoot: string,
    baseline: DirtyWorkspaceBaseline | null,
    taskScopeChangedFiles: string[]
): ProtectedDirtyWorkspaceScope | null {
    const normalizedBaseline = normalizeDirtyWorkspaceBaseline(baseline, repoRoot);
    if (!normalizedBaseline) {
        return null;
    }
    const scopeFiles = new Set(normalizeWorkspaceRelativePaths(repoRoot, taskScopeChangedFiles));
    const protectedFiles = normalizedBaseline.changed_files.filter((relativePath) => !scopeFiles.has(relativePath)).sort();
    return {
        protected_files: protectedFiles,
        protected_files_sha256: stringSha256(protectedFiles.join('\n')),
        protected_file_hashes: normalizeFileHashRecord(normalizedBaseline.file_hashes, protectedFiles)
    };
}

export function normalizeProtectedDirtyWorkspaceScope(
    value: unknown,
    repoRoot?: string
): ProtectedDirtyWorkspaceScope | null {
    const scope = toPlainRecord(value);
    if (!scope) {
        return null;
    }
    const protectedFiles = repoRoot
        ? normalizeWorkspaceRelativePaths(repoRoot, scope.protected_files)
        : normalizeRelativePaths(scope.protected_files);
    return {
        protected_files: protectedFiles,
        protected_files_sha256: String(
            scope.protected_files_sha256 || stringSha256(protectedFiles.join('\n')) || ''
        ).trim().toLowerCase() || null,
        protected_file_hashes: normalizeFileHashRecord(scope.protected_file_hashes, protectedFiles)
    };
}

function getPreflightTriggers(preflight: unknown): Record<string, unknown> | null {
    const preflightObject = toPlainRecord(preflight);
    return preflightObject ? toPlainRecord(preflightObject.triggers) : null;
}

export function getTaskOwnedDirtyWorkspaceFilesFromPreflight(repoRoot: string, preflight: unknown): string[] {
    const triggers = getPreflightTriggers(preflight);
    return triggers ? normalizeWorkspaceRelativePaths(repoRoot, triggers.dirty_workspace_task_owned_files) : [];
}

export function getUntouchedDirtyWorkspaceBaselineFilesFromPreflight(repoRoot: string, preflight: unknown): string[] {
    const triggers = getPreflightTriggers(preflight);
    return triggers ? normalizeWorkspaceRelativePaths(repoRoot, triggers.dirty_workspace_untouched_baseline_files) : [];
}

export interface TaskOwnedPreflightScope {
    changed_files: string[];
    task_owned_files: string[];
    excluded_untouched_baseline_files: string[];
}

export function getTaskOwnedPreflightScopeFromPreflight(repoRoot: string, preflight: unknown): TaskOwnedPreflightScope {
    const preflightObject = toPlainRecord(preflight);
    const changedFiles = preflightObject
        ? normalizeWorkspaceRelativePaths(repoRoot, preflightObject.changed_files)
        : [];
    const taskOwnedFiles = getTaskOwnedDirtyWorkspaceFilesFromPreflight(repoRoot, preflight);
    const excludedUntouchedBaselineFiles = getUntouchedDirtyWorkspaceBaselineFilesFromPreflight(repoRoot, preflight);
    if (taskOwnedFiles.length === 0 && excludedUntouchedBaselineFiles.length === 0) {
        return {
            changed_files: changedFiles,
            task_owned_files: [],
            excluded_untouched_baseline_files: []
        };
    }

    const excludedSet = new Set(excludedUntouchedBaselineFiles);
    return {
        changed_files: [...new Set([
            ...changedFiles.filter((relativePath) => !excludedSet.has(relativePath)),
            ...taskOwnedFiles
        ])].sort(),
        task_owned_files: taskOwnedFiles,
        excluded_untouched_baseline_files: excludedUntouchedBaselineFiles
    };
}

export function getProtectedDirtyWorkspaceScopeFromPreflight(preflight: unknown): ProtectedDirtyWorkspaceScope | null {
    const triggers = getPreflightTriggers(preflight);
    if (!triggers) {
        return null;
    }
    return normalizeProtectedDirtyWorkspaceScope({
        protected_files: triggers.dirty_workspace_protected_files,
        protected_files_sha256: triggers.dirty_workspace_protected_files_sha256,
        protected_file_hashes: triggers.dirty_workspace_protected_file_hashes
    });
}

export function detectProtectedDirtyWorkspaceDrift(
    repoRoot: string,
    scope: ProtectedDirtyWorkspaceScope | null
): ProtectedDirtyWorkspaceDriftResult {
    const protectedFiles = scope
        ? normalizeWorkspaceRelativePaths(repoRoot, scope.protected_files)
        : [];
    if (protectedFiles.length === 0) {
        return {
            status: 'NOT_APPLICABLE',
            assessment: 'NOT_APPLICABLE',
            protected_files: [],
            protected_files_sha256: null,
            baseline_file_hashes: {},
            current_file_hashes: {},
            changed_files: [],
            violations: []
        };
    }

    const protectedFileHashes = normalizeFileHashRecord(scope?.protected_file_hashes, protectedFiles);
    const currentFileHashes = buildFileHashMap(repoRoot, protectedFiles);
    const changedFiles = protectedFiles.filter((relativePath) => {
        return protectedFileHashes[relativePath] !== currentFileHashes[relativePath];
    });
    const violations = changedFiles.length > 0
        ? [
            `Protected pre-existing workspace edits changed outside task scope: ${changedFiles.join(', ')}. ` +
            'These files were already dirty at task-mode entry, were not included in the explicit task scope, ' +
            'and no longer match the task-mode baseline. Clean/stash the local baseline drift or restart task mode ' +
            'with the intended files in scope before continuing.'
        ]
        : [];

    return {
        status: changedFiles.length > 0 ? 'DRIFT_DETECTED' : 'PASS',
        assessment: changedFiles.length > 0
            ? 'PROTECTED_LOCAL_BASELINE_DRIFT'
            : 'INFO_IGNORED_PROTECTED_LOCAL_BASELINE',
        protected_files: protectedFiles,
        protected_files_sha256: stringSha256(protectedFiles.join('\n')),
        baseline_file_hashes: protectedFileHashes,
        current_file_hashes: currentFileHashes,
        changed_files: changedFiles,
        violations
    };
}
