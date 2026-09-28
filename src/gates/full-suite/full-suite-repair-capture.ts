import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { lstatFileIdentitySync } from '../../core/file-stat';
import * as path from 'node:path';

import {
    runGit,
    runGitBinary,
    readGitTreeEntriesForPaths,
    splitNulList
} from '../../core/git-helpers';
import type { GitTreeEntry } from '../../core/git-helpers';
import { isPlainRecord } from '../../core/records';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    fileSha256,
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import {
    WIP_MANIFEST_SCHEMA_VERSION,
    fileBytes,
    normalizeGitPath,
    nowIso,
    resolveRepoPath,
    sha256FileRequired,
    stableTimestampSlug
} from './full-suite-repair-contracts';
import type {
    CapturedPatchEvidence,
    CapturedUntrackedFileEvidence,
    PreflightChangedFileScope,
    RepairChildScopeEvidence,
    RepairWipManifest,
    TrackedChangeFiles
} from './full-suite-repair-contracts';
import {
    assertSingleLinkIdentity,
    getHeadCommit,
    isContainedPath,
    resolveInputPathInsideRepo,
    restoreContainedUntrackedBytes,
    runGitWithInput,
    sameFileIdentity,
    sameFileSnapshot,
    validatePhysicalRepoContainment
} from './full-suite-repair-manifest';

export function collectTrackedChangeFiles(repoRoot: string): TrackedChangeFiles {
    const staged = new Set(
        splitNulList(runGitBinary(repoRoot, ['diff', '--name-only', '--no-renames', '--cached', '-z'])).map(normalizeGitPath)
    );
    const unstaged = new Set(
        splitNulList(runGitBinary(repoRoot, ['diff', '--name-only', '--no-renames', '-z'])).map(normalizeGitPath)
    );
    return {
        staged,
        unstaged,
        all: [...new Set([...staged, ...unstaged])].sort()
    };
}

export function readPreflightChangedFileScope(repoRoot: string, preflightPath: string, expectedTaskId: string): PreflightChangedFileScope {
    const artifact = safeReadJson(preflightPath);
    const violations: string[] = [];
    const allowed = new Set<string>();
    if (!isPlainRecord(artifact)) {
        return {
            allowed,
            violations: ['Preflight artifact is missing or invalid.']
        };
    }
    const artifactTaskId = typeof artifact.task_id === 'string' ? artifact.task_id.trim() : '';
    if (artifactTaskId && artifactTaskId !== expectedTaskId) {
        violations.push(`Preflight task_id mismatch: expected ${expectedTaskId}; found ${artifactTaskId}.`);
    }
    if (!Array.isArray(artifact.changed_files)) {
        violations.push('Preflight changed_files must be an array.');
        return { allowed, violations };
    }
    for (const entry of artifact.changed_files) {
        if (typeof entry !== 'string' || !entry.trim()) {
            violations.push('Preflight changed_files contains an invalid path.');
            continue;
        }
        try {
            const resolved = resolveRepoPath(repoRoot, entry.trim());
            const relativePath = normalizeGitPath(path.relative(path.resolve(repoRoot), resolved));
            if (!relativePath) {
                violations.push('Preflight changed_files contains an invalid empty path.');
                continue;
            }
            const containmentViolations = validatePhysicalRepoContainment(
                repoRoot,
                resolved,
                `Preflight changed_files path ${relativePath}`
            );
            if (containmentViolations.length > 0) {
                violations.push(...containmentViolations);
                continue;
            }
            allowed.add(relativePath);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(`Preflight changed_files path invalid: ${message}`);
        }
    }
    return { allowed, violations };
}

export function findOutOfScopeTrackedChanges(trackedChanges: TrackedChangeFiles, allowedScope: Set<string>): string[] {
    return trackedChanges.all.filter((relativePath) => !allowedScope.has(relativePath));
}

export function collectVisibleUntrackedFiles(repoRoot: string): string[] {
    return splitNulList(runGitBinary(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']))
        .map(normalizeGitPath)
        .sort();
}

function collectUntrackedFilesForPathspecs(repoRoot: string, pathspecs: string[], includeIgnored: boolean): string[] {
    const normalizedPathspecs = [...new Set(pathspecs.map(normalizeGitPath).filter(Boolean))].sort();
    if (normalizedPathspecs.length === 0) {
        return [];
    }
    const visibleUntracked = splitNulList(runGitBinary(repoRoot, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        ...normalizedPathspecs
    ]));
    const ignoredUntracked = includeIgnored
        ? splitNulList(runGitBinary(repoRoot, [
            'ls-files',
            '--others',
            '--ignored',
            '--exclude-standard',
            '-z',
            '--',
            ...normalizedPathspecs
        ]))
        : [];
    return [...new Set([...visibleUntracked, ...ignoredUntracked].map(normalizeGitPath))].sort();
}

function collectRuntimeTmpTaskOwnedUntrackedFiles(repoRoot: string, taskId: string): string[] {
    return collectUntrackedFilesForPathspecs(
        repoRoot,
        ['garda-agent-orchestrator/runtime/tmp'],
        true
    ).filter((relativePath) => isTaskOwnedUntrackedPath(relativePath, taskId));
}

export function collectCapturedUntrackedFiles(repoRoot: string, taskId: string, allowedUntrackedFiles: Set<string>): string[] {
    return [...new Set([
        ...collectRuntimeTmpTaskOwnedUntrackedFiles(repoRoot, taskId),
        ...collectUntrackedFilesForPathspecs(repoRoot, [...allowedUntrackedFiles], true)
    ])].sort();
}

export function validateUntrackedCaptureSource(repoRoot: string, relativePath: string): string[] {
    const sourcePath = resolveRepoPath(repoRoot, relativePath);
    const label = `untracked capture source ${relativePath}`;
    const violations = validatePhysicalRepoContainment(repoRoot, sourcePath, label);
    if (violations.length > 0) {
        return violations;
    }
    try {
        const identity = lstatFileIdentitySync(sourcePath);
        if (identity.isSymbolicLink() || !identity.isFile()) {
            return [`${label} must be a regular file and must not be a symbolic-link or junction.`];
        }
        if (identity.nlink !== 1) {
            return [`${label} must not have additional hard links.`];
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`${label} cannot be inspected: ${message}`];
    }
    return [];
}

export function isTaskOwnedUntrackedPath(relativePath: string, taskId: string): boolean {
    const normalized = normalizeGitPath(relativePath);
    const taskToken = taskId.toLowerCase();
    const lower = normalized.toLowerCase();
    const hasTaskIdToken = lower.includes(`/${taskToken}/`)
        || lower.includes(`/${taskToken}-`)
        || lower.endsWith(`/${taskToken}.md`)
        || lower.endsWith(`/${taskToken}.json`)
        || lower.endsWith(`/${taskToken}.jsonl`);
    if (!hasTaskIdToken) {
        return false;
    }
    if (!lower.startsWith('garda-agent-orchestrator/runtime/tmp/')) {
        return false;
    }
    return true;
}

export interface CaptureFileSnapshot {
    path: string;
    content: Buffer;
    identity: fs.Stats;
}

interface CapturedPatchSnapshot {
    evidence: CapturedPatchEvidence;
    snapshot: CaptureFileSnapshot;
}

export function readImmutableRegularFileSnapshot(params: {
    filePath: string;
    label: string;
    repoRoot?: string;
}): CaptureFileSnapshot {
    if (params.repoRoot) {
        const containmentViolations = validatePhysicalRepoContainment(
            params.repoRoot,
            params.filePath,
            params.label
        );
        if (containmentViolations.length > 0) {
            throw new Error(containmentViolations.join(' '));
        }
    }
    const identityBeforeOpen = lstatFileIdentitySync(params.filePath);
    assertSingleLinkIdentity(identityBeforeOpen, params.label);
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(params.filePath, fs.constants.O_RDONLY | noFollowFlag);
        const openedIdentity = fs.fstatSync(descriptor);
        assertSingleLinkIdentity(openedIdentity, params.label);
        if (!sameFileIdentity(identityBeforeOpen, openedIdentity)) {
            throw new Error(`${params.label} identity changed while opening.`);
        }
        const content = fs.readFileSync(descriptor);
        const finalOpenedIdentity = fs.fstatSync(descriptor);
        const pathIdentityAfterRead = lstatFileIdentitySync(params.filePath);
        assertSingleLinkIdentity(finalOpenedIdentity, params.label);
        assertSingleLinkIdentity(pathIdentityAfterRead, params.label);
        if (!sameFileSnapshot(openedIdentity, finalOpenedIdentity)
            || !sameFileIdentity(finalOpenedIdentity, pathIdentityAfterRead)) {
            throw new Error(`${params.label} changed while reading.`);
        }
        if (params.repoRoot) {
            const finalContainmentViolations = validatePhysicalRepoContainment(
                params.repoRoot,
                params.filePath,
                params.label
            );
            if (finalContainmentViolations.length > 0) {
                throw new Error(finalContainmentViolations.join(' '));
            }
        }
        return {
            path: normalizePath(params.filePath),
            content,
            identity: finalOpenedIdentity
        };
    } finally {
        if (descriptor !== null) {
            fs.closeSync(descriptor);
        }
    }
}

export function ensureContainedDirectoryPath(repoRoot: string, directoryPath: string, label: string): void {
    const root = path.resolve(repoRoot);
    const target = path.resolve(directoryPath);
    if (!isContainedPath(root, target)) {
        throw new Error(`${label} escapes repo root: ${normalizePath(target)}`);
    }
    const relativePath = path.relative(root, target);
    let currentPath = root;
    for (const segment of relativePath.split(path.sep).filter(Boolean)) {
        currentPath = path.join(currentPath, segment);
        if (!fs.existsSync(currentPath)) {
            fs.mkdirSync(currentPath);
        }
        const identity = lstatFileIdentitySync(currentPath);
        if (identity.isSymbolicLink() || !identity.isDirectory()) {
            throw new Error(`${label} traverses a non-directory or symbolic-link component: ${normalizePath(currentPath)}`);
        }
        const containmentViolations = validatePhysicalRepoContainment(repoRoot, currentPath, label);
        if (containmentViolations.length > 0) {
            throw new Error(containmentViolations.join(' '));
        }
    }
}

function createExclusiveCaptureRoot(repoRoot: string, captureRoot: string): fs.Stats {
    ensureContainedDirectoryPath(repoRoot, path.dirname(captureRoot), 'prepared WIP capture parent');
    const containmentViolations = validatePhysicalRepoContainment(
        repoRoot,
        captureRoot,
        'prepared WIP capture root'
    );
    if (containmentViolations.length > 0) {
        throw new Error(containmentViolations.join(' '));
    }
    fs.mkdirSync(captureRoot);
    const identity = lstatFileIdentitySync(captureRoot);
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
        throw new Error(`prepared WIP capture root must be a newly created directory: ${normalizePath(captureRoot)}`);
    }
    return identity;
}

export function writeExclusiveCaptureFile(
    repoRoot: string,
    filePath: string,
    content: Buffer,
    label: string
): CaptureFileSnapshot {
    ensureContainedDirectoryPath(repoRoot, path.dirname(filePath), `${label} parent`);
    const containmentViolations = validatePhysicalRepoContainment(repoRoot, filePath, label);
    if (containmentViolations.length > 0) {
        throw new Error(containmentViolations.join(' '));
    }
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(
            filePath,
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag,
            0o600
        );
        const openedIdentity = fs.fstatSync(descriptor);
        assertSingleLinkIdentity(openedIdentity, label);
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
        const finalOpenedIdentity = fs.fstatSync(descriptor);
        const pathIdentity = lstatFileIdentitySync(filePath);
        assertSingleLinkIdentity(finalOpenedIdentity, label);
        assertSingleLinkIdentity(pathIdentity, label);
        if (!sameFileIdentity(finalOpenedIdentity, pathIdentity)) {
            throw new Error(`${label} identity changed while writing.`);
        }
        const finalContainmentViolations = validatePhysicalRepoContainment(repoRoot, filePath, label);
        if (finalContainmentViolations.length > 0) {
            throw new Error(finalContainmentViolations.join(' '));
        }
        return {
            path: normalizePath(filePath),
            content: Buffer.from(content),
            identity: finalOpenedIdentity
        };
    } finally {
        if (descriptor !== null) {
            fs.closeSync(descriptor);
        }
    }
}

export function readVerifiedCaptureFile(params: {
    repoRoot: string;
    filePath: string;
    label: string;
    expectedSha256: string;
    expectedBytes: number;
    expectedIdentity?: fs.Stats;
    expectedMode?: number;
}): CaptureFileSnapshot {
    const snapshot = readImmutableRegularFileSnapshot({
        repoRoot: params.repoRoot,
        filePath: params.filePath,
        label: params.label
    });
    if (params.expectedIdentity && !sameFileSnapshot(params.expectedIdentity, snapshot.identity)) {
        throw new Error(`${params.label} changed after exclusive creation.`);
    }
    if (params.expectedMode !== undefined && (snapshot.identity.mode & 0o777) !== params.expectedMode) {
        throw new Error(
            `${params.label} mode mismatch: expected=${params.expectedMode.toString(8)}; actual=${(snapshot.identity.mode & 0o777).toString(8)}`
        );
    }
    if (snapshot.content.byteLength !== params.expectedBytes) {
        throw new Error(
            `${params.label} byte count mismatch: expected=${params.expectedBytes}; actual=${snapshot.content.byteLength}`
        );
    }
    const actualSha256 = createHash('sha256').update(snapshot.content).digest('hex');
    if (actualSha256 !== params.expectedSha256) {
        throw new Error(
            `${params.label} sha256 mismatch: expected=${params.expectedSha256}; actual=${actualSha256}`
        );
    }
    return snapshot;
}

function buildPatchEvidence(filePath: string, content: Buffer): CapturedPatchEvidence {
    return {
        path: normalizePath(filePath),
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: content.byteLength,
        empty: content.byteLength === 0
    };
}

function writePatchFile(repoRoot: string, args: string[], outputPath: string): CapturedPatchSnapshot {
    const output = runGitBinary(repoRoot, args);
    return {
        evidence: buildPatchEvidence(outputPath, output),
        snapshot: writeExclusiveCaptureFile(repoRoot, outputPath, output, 'captured WIP patch')
    };
}

function writeEmptyPatchFile(repoRoot: string, outputPath: string): CapturedPatchSnapshot {
    const output = Buffer.alloc(0);
    return {
        evidence: buildPatchEvidence(outputPath, output),
        snapshot: writeExclusiveCaptureFile(repoRoot, outputPath, output, 'captured empty WIP patch')
    };
}

function writeScopedPatchFile(
    repoRoot: string,
    diffArgs: string[],
    relativePaths: Set<string>,
    outputPath: string
): CapturedPatchSnapshot {
    const sortedPaths = [...relativePaths].sort();
    if (sortedPaths.length === 0) {
        return writeEmptyPatchFile(repoRoot, outputPath);
    }
    return writePatchFile(repoRoot, [...diffArgs, '--', ...sortedPaths], outputPath);
}

function copyUntrackedTaskFile(repoRoot: string, captureRoot: string, relativePath: string): CapturedUntrackedFileEvidence {
    const sourcePath = resolveRepoPath(repoRoot, relativePath);
    const artifactPath = path.join(captureRoot, 'untracked', normalizeGitPath(relativePath));
    const sourceViolations = validateUntrackedCaptureSource(repoRoot, relativePath);
    if (sourceViolations.length > 0) {
        throw new Error(sourceViolations.join(' '));
    }
    const sourceIdentityBeforeCopy = lstatFileIdentitySync(sourcePath);
    assertSingleLinkIdentity(sourceIdentityBeforeCopy, `untracked capture source ${relativePath}`);
    const sourceMode = sourceIdentityBeforeCopy.mode & 0o777;
    ensureContainedDirectoryPath(repoRoot, path.dirname(artifactPath), `untracked capture artifact ${relativePath} parent`);
    const artifactContainment = validatePhysicalRepoContainment(
        repoRoot,
        artifactPath,
        `untracked capture artifact ${relativePath}`
    );
    if (artifactContainment.length > 0) {
        throw new Error(artifactContainment.join(' '));
    }
    fs.copyFileSync(sourcePath, artifactPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(artifactPath, sourceMode);
    const sourceContainmentAfterCopy = validatePhysicalRepoContainment(
        repoRoot,
        sourcePath,
        `untracked capture source ${relativePath}`
    );
    if (sourceContainmentAfterCopy.length > 0) {
        throw new Error(sourceContainmentAfterCopy.join(' '));
    }
    const sourceIdentityAfterCopy = lstatFileIdentitySync(sourcePath);
    assertSingleLinkIdentity(sourceIdentityAfterCopy, `untracked capture source ${relativePath}`);
    if (!sameFileSnapshot(sourceIdentityBeforeCopy, sourceIdentityAfterCopy)) {
        throw new Error(`untracked capture source changed while copying: ${relativePath}`);
    }
    const artifactContainmentAfterCopy = validatePhysicalRepoContainment(
        repoRoot,
        artifactPath,
        `untracked capture artifact ${relativePath}`
    );
    if (artifactContainmentAfterCopy.length > 0) {
        throw new Error(artifactContainmentAfterCopy.join(' '));
    }
    const artifactIdentity = lstatFileIdentitySync(artifactPath);
    assertSingleLinkIdentity(artifactIdentity, `untracked capture artifact ${relativePath}`);
    if ((artifactIdentity.mode & 0o777) !== sourceMode || artifactIdentity.size !== sourceIdentityBeforeCopy.size) {
        throw new Error(`untracked capture artifact metadata mismatch: ${relativePath}`);
    }
    return {
        path: normalizeGitPath(relativePath),
        artifact_path: normalizePath(artifactPath),
        sha256: sha256FileRequired(artifactPath),
        bytes: fileBytes(artifactPath),
        mode: sourceMode
    };
}

function removeFileIfExists(filePath: string): void {
    if (!fs.existsSync(filePath)) {
        return;
    }
    const identity = lstatFileIdentitySync(filePath);
    assertSingleLinkIdentity(identity, `file removal target ${normalizePath(filePath)}`);
    fs.unlinkSync(filePath);
}

function assertRepositoryHead(repoRoot: string, expectedBaseCommit: string): void {
    const currentHead = getHeadCommit(repoRoot);
    if (currentHead !== expectedBaseCommit) {
        throw new Error(
            `repository HEAD changed during full-suite repair WIP suspension: expected ${expectedBaseCommit}; found ${currentHead}`
        );
    }
}

function suspendTrackedChanges(
    repoRoot: string,
    changedFiles: string[],
    baseCommit: string,
    baseEntries: ReadonlyMap<string, GitTreeEntry>
): void {
    assertRepositoryHead(repoRoot, baseCommit);
    if (changedFiles.length === 0) {
        return;
    }
    runGit(repoRoot, ['reset', '--quiet', baseCommit, '--', ...changedFiles]);
    assertRepositoryHead(repoRoot, baseCommit);
    const headTrackedFiles = changedFiles.filter((relativePath) => baseEntries.has(relativePath));
    if (headTrackedFiles.length > 0) {
        runGit(repoRoot, ['checkout', '--quiet', baseCommit, '--', ...headTrackedFiles]);
        assertRepositoryHead(repoRoot, baseCommit);
    }
    for (const relativePath of changedFiles) {
        if (baseEntries.has(relativePath)) {
            continue;
        }
        removeFileIfExists(resolveRepoPath(repoRoot, relativePath));
    }
}

export interface PreparedWipCapture {
    manifest: RepairWipManifest;
    capturedUntrackedFiles: string[];
    captureRoot: string;
    captureRootIdentity: fs.Stats;
    manifestSnapshot: CaptureFileSnapshot;
    patchSnapshots: {
        staged: CaptureFileSnapshot;
        unstaged: CaptureFileSnapshot;
    };
    untrackedSnapshots: Array<{
        entry: CapturedUntrackedFileEvidence;
        snapshot: CaptureFileSnapshot;
    }>;
    baseEntries: ReadonlyMap<string, GitTreeEntry>;
}

export function prepareWipCapture(params: {
    repoRoot: string;
    taskId: string;
    childTaskIds: string[];
    childScopes: RepairChildScopeEvidence[];
    captureRoot: string;
    timestampUtc: string;
    preflightPath: string;
    fullSuiteArtifactPath: string;
    trackedChanges: TrackedChangeFiles;
    allowedUntrackedFiles: Set<string>;
    unrelatedVisibleUntrackedFiles: string[];
}): PreparedWipCapture {
    const timestampUtc = params.timestampUtc;
    const captureRoot = params.captureRoot;
    let captureRootCreated = false;
    try {
        const baseCommit = getHeadCommit(params.repoRoot);
        const baseEntries = readGitTreeEntriesForPaths(
            params.repoRoot,
            baseCommit,
            params.trackedChanges.all
        );
        const captureRootIdentity = createExclusiveCaptureRoot(params.repoRoot, captureRoot);
        captureRootCreated = true;

        const capturedUntrackedFiles = collectCapturedUntrackedFiles(
            params.repoRoot,
            params.taskId,
            params.allowedUntrackedFiles
        );

        const stagedPatch = writeScopedPatchFile(
            params.repoRoot,
            ['diff', '--binary', '--no-renames', '--cached'],
            params.trackedChanges.staged,
            path.join(captureRoot, 'staged.patch')
        );
        const unstagedPatch = writeScopedPatchFile(
            params.repoRoot,
            ['diff', '--binary', '--no-renames'],
            params.trackedChanges.unstaged,
            path.join(captureRoot, 'unstaged.patch')
        );
        const untracked = capturedUntrackedFiles.map(
            (relativePath) => copyUntrackedTaskFile(params.repoRoot, captureRoot, relativePath)
        );
        const trackedFiles = params.trackedChanges.all.map((relativePath) => {
            const absolutePath = resolveRepoPath(params.repoRoot, relativePath);
            return {
                path: relativePath,
                head_sha256: baseEntries.get(relativePath)?.objectId || null,
                worktree_sha256: fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()
                    ? sha256FileRequired(absolutePath)
                    : null,
                staged: params.trackedChanges.staged.has(relativePath),
                unstaged: params.trackedChanges.unstaged.has(relativePath)
            };
        });

        const manifest: RepairWipManifest = {
            schema_version: WIP_MANIFEST_SCHEMA_VERSION,
            kind: 'full_suite_repair_wip',
            status: 'suspended',
            task_id: params.taskId,
            child_task_ids: [...params.childTaskIds],
            child_scopes: params.childScopes.map((scope) => ({
                task_id: scope.task_id,
                paths: [...scope.paths]
            })),
            created_at_utc: timestampUtc,
            base_commit: baseCommit,
            preflight_path: normalizePath(params.preflightPath),
            preflight_sha256: fileSha256(params.preflightPath) || '',
            full_suite_artifact_path: normalizePath(params.fullSuiteArtifactPath),
            full_suite_artifact_sha256: fileSha256(params.fullSuiteArtifactPath) || '',
            patches: {
                staged: stagedPatch.evidence,
                unstaged: unstagedPatch.evidence
            },
            tracked_files: trackedFiles,
            untracked_files: untracked,
            unrelated_untracked_files: params.unrelatedVisibleUntrackedFiles
        };
        const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        const manifestSnapshot = writeExclusiveCaptureFile(
            params.repoRoot,
            path.join(captureRoot, 'manifest.json'),
            manifestContent,
            'captured WIP manifest'
        );
        const preparedCapture: PreparedWipCapture = {
            manifest,
            capturedUntrackedFiles,
            captureRoot,
            captureRootIdentity,
            manifestSnapshot,
            patchSnapshots: {
                staged: stagedPatch.snapshot,
                unstaged: unstagedPatch.snapshot
            },
            untrackedSnapshots: [],
            baseEntries
        };
        return verifyPreparedWipCapture(params.repoRoot, preparedCapture);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const cleanupViolations = captureRootCreated
            ? removePreparedWipCapture(params.repoRoot, captureRoot)
            : [];
        throw new Error([message, ...cleanupViolations].join(' '));
    }
}

export function verifyPreparedWipCapture(repoRoot: string, preparedCapture: PreparedWipCapture): PreparedWipCapture {
    const rootContainmentViolations = validatePhysicalRepoContainment(
        repoRoot,
        preparedCapture.captureRoot,
        'prepared WIP capture verification'
    );
    if (rootContainmentViolations.length > 0) {
        throw new Error(rootContainmentViolations.join(' '));
    }
    const captureRootIdentity = lstatFileIdentitySync(preparedCapture.captureRoot);
    if (!captureRootIdentity.isDirectory()
        || captureRootIdentity.isSymbolicLink()
        || !sameFileIdentity(preparedCapture.captureRootIdentity, captureRootIdentity)) {
        throw new Error('prepared WIP capture root identity changed after exclusive creation.');
    }
    const staged = readVerifiedCaptureFile({
        repoRoot,
        filePath: preparedCapture.manifest.patches.staged.path,
        label: 'captured staged WIP patch',
        expectedSha256: preparedCapture.manifest.patches.staged.sha256,
        expectedBytes: preparedCapture.manifest.patches.staged.bytes,
        expectedIdentity: preparedCapture.patchSnapshots.staged.identity
    });
    const unstaged = readVerifiedCaptureFile({
        repoRoot,
        filePath: preparedCapture.manifest.patches.unstaged.path,
        label: 'captured unstaged WIP patch',
        expectedSha256: preparedCapture.manifest.patches.unstaged.sha256,
        expectedBytes: preparedCapture.manifest.patches.unstaged.bytes,
        expectedIdentity: preparedCapture.patchSnapshots.unstaged.identity
    });
    const manifest = readVerifiedCaptureFile({
        repoRoot,
        filePath: preparedCapture.manifestSnapshot.path,
        label: 'captured WIP manifest',
        expectedSha256: createHash('sha256').update(preparedCapture.manifestSnapshot.content).digest('hex'),
        expectedBytes: preparedCapture.manifestSnapshot.content.byteLength,
        expectedIdentity: preparedCapture.manifestSnapshot.identity
    });
    if (!manifest.content.equals(preparedCapture.manifestSnapshot.content)) {
        throw new Error('captured WIP manifest content changed after exclusive creation.');
    }
    const untrackedSnapshots = preparedCapture.manifest.untracked_files.map((entry) => ({
        entry,
        snapshot: readVerifiedCaptureFile({
            repoRoot,
            filePath: resolveInputPathInsideRepo(repoRoot, entry.artifact_path, `untracked artifact ${entry.path}`),
            label: `captured untracked WIP artifact ${entry.path}`,
            expectedSha256: entry.sha256,
            expectedBytes: entry.bytes,
            expectedMode: entry.mode
        })
    }));
    return {
        ...preparedCapture,
        manifestSnapshot: manifest,
        patchSnapshots: { staged, unstaged },
        untrackedSnapshots
    };
}

function buildCurrentScopedPatch(
    repoRoot: string,
    diffArgs: string[],
    relativePaths: Set<string>
): Buffer {
    const sortedPaths = [...relativePaths].sort();
    return sortedPaths.length === 0
        ? Buffer.alloc(0)
        : runGitBinary(repoRoot, [...diffArgs, '--', ...sortedPaths]);
}

function validateCurrentUntrackedSnapshot(
    repoRoot: string,
    entry: CapturedUntrackedFileEvidence,
    expectedContent: Buffer
): string[] {
    const targetPath = resolveRepoPath(repoRoot, entry.path);
    const containmentViolations = validatePhysicalRepoContainment(
        repoRoot,
        targetPath,
        `prepared WIP source ${entry.path}`
    );
    if (containmentViolations.length > 0) {
        return containmentViolations;
    }
    if (!fs.existsSync(targetPath)) {
        return [`prepared WIP source is missing: ${entry.path}`];
    }
    try {
        const identity = lstatFileIdentitySync(targetPath);
        assertSingleLinkIdentity(identity, `prepared WIP source ${entry.path}`);
        const content = fs.readFileSync(targetPath);
        if ((identity.mode & 0o777) !== entry.mode) {
            return [`prepared WIP source mode changed: ${entry.path}`];
        }
        if (!content.equals(expectedContent)) {
            return [`prepared WIP source content changed: ${entry.path}`];
        }
        return [];
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`prepared WIP source validation failed for ${entry.path}: ${message}`];
    }
}

export function validateWorkspaceMatchesPreparedCapture(
    repoRoot: string,
    trackedChanges: TrackedChangeFiles,
    preparedCapture: PreparedWipCapture
): string[] {
    const violations: string[] = [];
    const currentTrackedChanges = collectTrackedChangeFiles(repoRoot);
    const expectedStaged = [...trackedChanges.staged].sort();
    const expectedUnstaged = [...trackedChanges.unstaged].sort();
    const currentStaged = [...currentTrackedChanges.staged].sort();
    const currentUnstaged = [...currentTrackedChanges.unstaged].sort();
    if (JSON.stringify(currentStaged) !== JSON.stringify(expectedStaged)) {
        violations.push(
            `staged WIP path set changed after capture: expected=${expectedStaged.join(',')}; actual=${currentStaged.join(',')}`
        );
    }
    if (JSON.stringify(currentUnstaged) !== JSON.stringify(expectedUnstaged)) {
        violations.push(
            `unstaged WIP path set changed after capture: expected=${expectedUnstaged.join(',')}; actual=${currentUnstaged.join(',')}`
        );
    }
    const currentStagedPatch = buildCurrentScopedPatch(
        repoRoot,
        ['diff', '--binary', '--no-renames', '--cached'],
        trackedChanges.staged
    );
    if (!currentStagedPatch.equals(preparedCapture.patchSnapshots.staged.content)) {
        violations.push('staged WIP content changed after capture.');
    }
    const currentUnstagedPatch = buildCurrentScopedPatch(
        repoRoot,
        ['diff', '--binary', '--no-renames'],
        trackedChanges.unstaged
    );
    if (!currentUnstagedPatch.equals(preparedCapture.patchSnapshots.unstaged.content)) {
        violations.push('unstaged WIP content changed after capture.');
    }
    for (const { entry, snapshot } of preparedCapture.untrackedSnapshots) {
        violations.push(...validateCurrentUntrackedSnapshot(repoRoot, entry, snapshot.content));
    }
    return violations;
}

export function rollbackPreparedWipSuspension(
    repoRoot: string,
    trackedChanges: TrackedChangeFiles,
    preparedCapture: PreparedWipCapture
): string[] {
    const violations: string[] = [];
    try {
        suspendTrackedChanges(
            repoRoot,
            trackedChanges.all,
            preparedCapture.manifest.base_commit,
            preparedCapture.baseEntries
        );
        if (hasPatchContent(preparedCapture.manifest.patches.staged)) {
            runGitWithInput(
                repoRoot,
                ['apply', '--check', '--index', '-'],
                preparedCapture.patchSnapshots.staged.content
            );
            runGitWithInput(
                repoRoot,
                ['apply', '--index', '-'],
                preparedCapture.patchSnapshots.staged.content
            );
        }
        if (hasPatchContent(preparedCapture.manifest.patches.unstaged)) {
            runGitWithInput(
                repoRoot,
                ['apply', '--check', '-'],
                preparedCapture.patchSnapshots.unstaged.content
            );
            runGitWithInput(
                repoRoot,
                ['apply', '-'],
                preparedCapture.patchSnapshots.unstaged.content
            );
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`failed to restore tracked WIP after suspension failure: ${message}`);
    }
    for (const { entry, snapshot } of preparedCapture.untrackedSnapshots) {
        const targetPath = resolveRepoPath(repoRoot, entry.path);
        if (fs.existsSync(targetPath)) {
            violations.push(...validateCurrentUntrackedSnapshot(repoRoot, entry, snapshot.content));
            continue;
        }
        try {
            restoreContainedUntrackedBytes({
                repoRoot,
                entry,
                content: snapshot.content
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(`failed to restore untracked WIP after suspension failure for ${entry.path}: ${message}`);
        }
    }
    if (violations.length === 0) {
        violations.push(...validateWorkspaceMatchesPreparedCapture(repoRoot, trackedChanges, preparedCapture));
    }
    return violations;
}

export function suspendPreparedWip(
    repoRoot: string,
    trackedChanges: TrackedChangeFiles,
    preparedCapture: PreparedWipCapture
): void {
    suspendTrackedChanges(
        repoRoot,
        trackedChanges.all,
        preparedCapture.manifest.base_commit,
        preparedCapture.baseEntries
    );
    for (const relativePath of preparedCapture.capturedUntrackedFiles) {
        removeFileIfExists(resolveRepoPath(repoRoot, relativePath));
    }
}

export function validatePreparedWipSuspended(
    repoRoot: string,
    preparedCapture: PreparedWipCapture
): string[] {
    const violations: string[] = [];
    const remainingTrackedChanges = collectTrackedChangeFiles(repoRoot);
    if (remainingTrackedChanges.all.length > 0) {
        violations.push(`tracked WIP remains after suspension: ${remainingTrackedChanges.all.join(', ')}`);
    }
    for (const relativePath of preparedCapture.capturedUntrackedFiles) {
        if (fs.existsSync(resolveRepoPath(repoRoot, relativePath))) {
            violations.push(`untracked WIP remains after suspension: ${relativePath}`);
        }
    }
    return violations;
}

export function planWipCaptureLocation(repoRoot: string, taskId: string): { timestampUtc: string; captureRoot: string; manifestPath: string } {
    const timestampUtc = nowIso();
    const captureRoot = joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'wip', taskId, 'full-suite-repair', stableTimestampSlug(timestampUtc))
    );
    return {
        timestampUtc,
        captureRoot,
        manifestPath: path.join(captureRoot, 'manifest.json')
    };
}

export function removePreparedWipCapture(repoRoot: string, captureRoot: string): string[] {
    const normalizedCaptureRoot = path.resolve(captureRoot);
    const wipRoot = path.resolve(joinOrchestratorPath(repoRoot, path.join('runtime', 'wip')));
    if (!isContainedPath(wipRoot, normalizedCaptureRoot) || normalizedCaptureRoot === wipRoot) {
        return [`prepared WIP capture cleanup refused path outside task capture root: ${normalizePath(normalizedCaptureRoot)}`];
    }
    const containmentViolations = validatePhysicalRepoContainment(
        repoRoot,
        normalizedCaptureRoot,
        'prepared WIP capture cleanup'
    );
    if (containmentViolations.length > 0) {
        return containmentViolations;
    }
    try {
        if (fs.existsSync(normalizedCaptureRoot)) {
            const identity = lstatFileIdentitySync(normalizedCaptureRoot);
            if (identity.isSymbolicLink() || !identity.isDirectory()) {
                return [`prepared WIP capture cleanup refused non-directory target: ${normalizePath(normalizedCaptureRoot)}`];
            }
            fs.rmSync(normalizedCaptureRoot, { recursive: true, force: true });
        }
        return [];
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`prepared WIP capture cleanup failed: ${message}`];
    }
}

export function hasPatchContent(patch: CapturedPatchEvidence): boolean {
    return patch.bytes > 0 && !patch.empty;
}
