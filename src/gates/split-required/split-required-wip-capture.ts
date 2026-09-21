import { createHash } from 'node:crypto';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import {
    readGitTreeEntriesForPaths,
    runGit,
    runGitBinary,
    splitNulList
} from '../../core/git-helpers';
import type { GitTreeEntry } from '../../core/git-helpers';
import { isPlainRecord } from '../../core/records';
import {
    appendMandatoryTaskEvent
} from '../../gate-runtime/task-events';
import {
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    buildSplitRequiredWipManifest,
    canCaptureSplitRequiredWip,
    findCurrentCapturedManifest,
    getHeadCommit,
    normalizeGitPath,
    planCaptureLocation,
    resolveInputPathInsideRepo,
    resolveRepoPath,
    resolveWipRoot
} from './split-required-wip-contracts';
import type {
    SplitRequiredWipCaptureResult,
    SplitRequiredWipGuardKind,
    SplitRequiredWipManifest,
    SplitRequiredWipPatchEvidence,
    SplitRequiredWipTrackedFileEvidence,
    SplitRequiredWipUntrackedFileEvidence
} from './split-required-wip-contracts';

const LEGACY_TASK_QUEUE_LOCK_OWNER_PATH = `${TASK_QUEUE_FILENAME}.garda-status-sync.lock/owner.json`;

interface TrackedChangeFiles {
    staged: Set<string>;
    unstaged: Set<string>;
    all: string[];
}

interface PreflightChangedFileScope {
    allowed: Set<string>;
    violations: string[];
}

interface CaptureFileSnapshot {
    path: string;
    content: Buffer;
    identity: fs.Stats;
}

interface CapturedUntrackedSnapshot {
    evidence: SplitRequiredWipUntrackedFileEvidence;
    content: Buffer;
    sourceIdentity: fs.Stats;
    artifact: CaptureFileSnapshot;
}

interface PreparedSplitRequiredWipCapture {
    captureRoot: string;
    captureRootIdentity: fs.Stats;
    baseCommit: string;
    manifestPath: string;
    manifestSha256: string;
    manifest: SplitRequiredWipManifest;
    trackedChanges: TrackedChangeFiles;
    capturedUntrackedFiles: string[];
    stagedPatch: CaptureFileSnapshot;
    unstagedPatch: CaptureFileSnapshot;
    manifestSnapshot: CaptureFileSnapshot;
    untracked: CapturedUntrackedSnapshot[];
    baseEntries: ReadonlyMap<string, GitTreeEntry>;
}

function sha256Buffer(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex');
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.birthtimeMs === right.birthtimeMs;
}

function sameFileSnapshot(left: fs.Stats, right: fs.Stats): boolean {
    return sameFileIdentity(left, right)
        && left.size === right.size
        && left.mode === right.mode
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}

function collectTrackedChangeFiles(repoRoot: string): TrackedChangeFiles {
    const staged = new Set(
        splitNulList(runGitBinary(repoRoot, ['diff', '--name-only', '--cached', '-z']))
            .map(normalizeGitPath)
    );
    const unstaged = new Set(
        splitNulList(runGitBinary(repoRoot, ['diff', '--name-only', '-z']))
            .map(normalizeGitPath)
    );
    return {
        staged,
        unstaged,
        all: [...new Set([...staged, ...unstaged])].sort()
    };
}

function excludeGateOwnedQueueFiles(changes: TrackedChangeFiles): TrackedChangeFiles {
    const isImplementationWip = (relativePath: string): boolean => (
        normalizeGitPath(relativePath) !== TASK_QUEUE_FILENAME
    );
    const staged = new Set([...changes.staged].filter(isImplementationWip));
    const unstaged = new Set([...changes.unstaged].filter(isImplementationWip));
    return {
        staged,
        unstaged,
        all: [...new Set([...staged, ...unstaged])].sort()
    };
}

function collectVisibleUntrackedFiles(repoRoot: string): string[] {
    return splitNulList(runGitBinary(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']))
        .map(normalizeGitPath)
        .filter((relativePath) => relativePath !== LEGACY_TASK_QUEUE_LOCK_OWNER_PATH)
        .sort();
}

function collectUntrackedFilesForPathspecs(
    repoRoot: string,
    pathspecs: string[],
    includeIgnored: boolean
): string[] {
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

function isIgnoredRuntimeArtifactPath(relativePath: string): boolean {
    const lower = normalizeGitPath(relativePath).toLowerCase();
    return lower.startsWith('garda-agent-orchestrator/runtime/reviews/')
        || lower.startsWith('garda-agent-orchestrator/runtime/task-events/')
        || lower.startsWith('garda-agent-orchestrator/runtime/task-ledger/')
        || lower.startsWith('garda-agent-orchestrator/runtime/project-memory/')
        || lower.startsWith('garda-agent-orchestrator/runtime/wip/')
        || lower.startsWith('garda-agent-orchestrator/runtime/metrics');
}

function isTaskOwnedUntrackedPath(relativePath: string, taskId: string): boolean {
    const normalized = normalizeGitPath(relativePath);
    if (isIgnoredRuntimeArtifactPath(normalized)) {
        return false;
    }
    const taskToken = taskId.toLowerCase();
    const lower = normalized.toLowerCase();
    const hasTaskIdToken = lower.includes(`/${taskToken}/`)
        || lower.includes(`/${taskToken}-`)
        || lower.endsWith(`/${taskToken}.md`)
        || lower.endsWith(`/${taskToken}.json`)
        || lower.endsWith(`/${taskToken}.jsonl`);
    return hasTaskIdToken && lower.startsWith('garda-agent-orchestrator/runtime/tmp/');
}

function collectRuntimeTmpTaskOwnedUntrackedFiles(repoRoot: string, taskId: string): string[] {
    return collectUntrackedFilesForPathspecs(
        repoRoot,
        ['garda-agent-orchestrator/runtime/tmp'],
        true
    ).filter((relativePath) => isTaskOwnedUntrackedPath(relativePath, taskId));
}

function readPreflightChangedFileScope(
    repoRoot: string,
    preflightPath: string,
    expectedTaskId: string
): PreflightChangedFileScope {
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
    if (!artifactTaskId) {
        violations.push('Preflight task_id must be a non-empty string.');
    } else if (artifactTaskId !== expectedTaskId) {
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
            allowed.add(relativePath);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(`Preflight changed_files path invalid: ${message}`);
        }
    }
    return { allowed, violations };
}

function writeExclusiveCaptureFile(filePath: string, content: Buffer): CaptureFileSnapshot {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, { flag: 'wx' });
    return {
        path: filePath,
        content,
        identity: fs.lstatSync(filePath)
    };
}

function buildPatchEvidence(snapshot: CaptureFileSnapshot): SplitRequiredWipPatchEvidence {
    return {
        path: normalizePath(snapshot.path),
        sha256: sha256Buffer(snapshot.content),
        bytes: snapshot.content.byteLength,
        empty: snapshot.content.byteLength === 0
    };
}

function writeScopedPatchFile(
    repoRoot: string,
    diffArgs: string[],
    relativePaths: Set<string>,
    outputPath: string
): CaptureFileSnapshot {
    const sortedPaths = [...relativePaths].sort();
    const output = sortedPaths.length === 0
        ? Buffer.alloc(0)
        : runGitBinary(repoRoot, [...diffArgs, '--', ...sortedPaths]);
    return writeExclusiveCaptureFile(outputPath, output);
}

function readStableRepoFile(
    repoRoot: string,
    relativePath: string,
    label: string
): { content: Buffer; identity: fs.Stats } {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const sourcePath = resolveRepoPath(repoRoot, relativePath);
    const parentRelative = path.relative(normalizedRepoRoot, path.dirname(sourcePath));
    let current = normalizedRepoRoot;
    for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const ancestorIdentity = fs.lstatSync(current);
        if (!ancestorIdentity.isDirectory() || ancestorIdentity.isSymbolicLink()) {
            throw new Error(
                `${label} path ancestry contains a symbolic link, junction, or non-directory: ${normalizePath(current)}`
            );
        }
    }
    const identity = fs.lstatSync(sourcePath);
    if (!identity.isFile() || identity.isSymbolicLink()) {
        throw new Error(`${label} must be a regular file: ${relativePath}`);
    }
    const realRepoRoot = fs.realpathSync.native(normalizedRepoRoot);
    const realSourcePath = fs.realpathSync.native(sourcePath);
    if (!pathIsInside(realRepoRoot, realSourcePath)) {
        throw new Error(`${label} resolved outside repository root: ${relativePath}`);
    }
    const content = fs.readFileSync(sourcePath);
    const afterRead = fs.lstatSync(sourcePath);
    if (!sameFileSnapshot(identity, afterRead)) {
        throw new Error(`${label} changed while reading: ${relativePath}`);
    }
    return { content, identity };
}

function copyUntrackedTaskFile(
    repoRoot: string,
    captureRoot: string,
    relativePath: string
): CapturedUntrackedSnapshot {
    const source = readStableRepoFile(repoRoot, relativePath, 'untracked capture source');
    const content = source.content;
    const artifactPath = path.join(captureRoot, 'untracked', normalizeGitPath(relativePath));
    const artifact = writeExclusiveCaptureFile(artifactPath, content);
    return {
        evidence: {
            path: normalizeGitPath(relativePath),
            artifact_path: normalizePath(artifactPath),
            sha256: sha256Buffer(content),
            bytes: content.byteLength
        },
        content,
        sourceIdentity: source.identity,
        artifact
    };
}

function removeFileIfExists(filePath: string): void {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
    }
}

function assertRepositoryHead(repoRoot: string, expectedBaseCommit: string): void {
    const currentHead = getHeadCommit(repoRoot);
    if (currentHead !== expectedBaseCommit) {
        throw new Error(
            `repository HEAD changed during split-required WIP capture: expected ${expectedBaseCommit}; found ${currentHead}`
        );
    }
}

function suspendTrackedChanges(
    repoRoot: string,
    changedFiles: string[],
    expectedBaseCommit: string,
    baseEntries: ReadonlyMap<string, GitTreeEntry>
): void {
    assertRepositoryHead(repoRoot, expectedBaseCommit);
    if (changedFiles.length === 0) {
        return;
    }
    runGit(repoRoot, ['reset', '--quiet', expectedBaseCommit, '--', ...changedFiles]);
    assertRepositoryHead(repoRoot, expectedBaseCommit);
    const headTrackedFiles = changedFiles.filter((relativePath) => baseEntries.has(relativePath));
    if (headTrackedFiles.length > 0) {
        runGit(repoRoot, ['checkout', '--quiet', expectedBaseCommit, '--', ...headTrackedFiles]);
        assertRepositoryHead(repoRoot, expectedBaseCommit);
    }
    for (const relativePath of changedFiles) {
        if (!baseEntries.has(relativePath)) {
            removeFileIfExists(resolveRepoPath(repoRoot, relativePath));
        }
    }
}

function pathIsInside(parentPath: string, childPath: string): boolean {
    const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function ensureDirectoryTreeWithoutLinks(repoRoot: string, directoryPath: string): void {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const normalizedDirectory = path.resolve(directoryPath);
    if (!pathIsInside(normalizedRepoRoot, normalizedDirectory)) {
        throw new Error(
            `split-required WIP directory must stay inside repository root: ${normalizePath(normalizedDirectory)}`
        );
    }
    const relative = path.relative(normalizedRepoRoot, normalizedDirectory);
    let current = normalizedRepoRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        if (!fs.existsSync(current)) {
            fs.mkdirSync(current);
        }
        const identity = fs.lstatSync(current);
        if (!identity.isDirectory() || identity.isSymbolicLink()) {
            throw new Error(
                `split-required WIP directory ancestry contains a symbolic link, junction, or non-directory: ${normalizePath(current)}`
            );
        }
    }
}

function validateCaptureRootLocation(
    repoRoot: string,
    taskId: string,
    captureRoot: string,
    expectedIdentity?: fs.Stats
): fs.Stats {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const taskWipRoot = path.resolve(resolveWipRoot(repoRoot, taskId));
    const normalizedCaptureRoot = path.resolve(captureRoot);
    if (!pathIsInside(taskWipRoot, normalizedCaptureRoot)) {
        throw new Error(
            `split-required WIP capture path must stay inside task capture root: ${normalizePath(normalizedCaptureRoot)}`
        );
    }
    ensureDirectoryTreeWithoutLinks(normalizedRepoRoot, normalizedCaptureRoot);
    const identity = fs.lstatSync(normalizedCaptureRoot);
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
        throw new Error(
            `split-required WIP capture root must be a regular directory: ${normalizePath(normalizedCaptureRoot)}`
        );
    }
    if (expectedIdentity && !sameFileIdentity(expectedIdentity, identity)) {
        throw new Error(
            `split-required WIP capture root identity changed: ${normalizePath(normalizedCaptureRoot)}`
        );
    }
    const realRepoRoot = fs.realpathSync.native(normalizedRepoRoot);
    const realTaskWipRoot = fs.realpathSync.native(taskWipRoot);
    const realCaptureRoot = fs.realpathSync.native(normalizedCaptureRoot);
    if (!pathIsInside(realRepoRoot, realTaskWipRoot)
        || !pathIsInside(realTaskWipRoot, realCaptureRoot)) {
        throw new Error(
            `split-required WIP capture root resolved outside repository-owned task storage: ${normalizePath(realCaptureRoot)}`
        );
    }
    return identity;
}

function createExclusiveCaptureRoot(
    repoRoot: string,
    taskId: string,
    captureRoot: string
): fs.Stats {
    ensureDirectoryTreeWithoutLinks(repoRoot, path.dirname(captureRoot));
    fs.mkdirSync(captureRoot);
    return validateCaptureRootLocation(repoRoot, taskId, captureRoot);
}

function verifyCaptureFile(snapshot: CaptureFileSnapshot, label: string): void {
    const identity = fs.lstatSync(snapshot.path);
    if (!identity.isFile()
        || identity.isSymbolicLink()
        || !sameFileIdentity(snapshot.identity, identity)) {
        throw new Error(`${label} must remain a regular file after exclusive creation.`);
    }
    const current = fs.readFileSync(snapshot.path);
    if (!current.equals(snapshot.content)) {
        throw new Error(`${label} changed after exclusive creation.`);
    }
}

function removePreparedCapture(
    repoRoot: string,
    taskId: string,
    captureRoot: string,
    expectedIdentity?: fs.Stats
): string[] {
    const normalizedRoot = path.resolve(captureRoot);
    const taskWipRoot = path.resolve(resolveWipRoot(repoRoot, taskId));
    if (!pathIsInside(taskWipRoot, normalizedRoot)) {
        return [`split-required WIP capture cleanup refused path outside task capture root: ${normalizePath(normalizedRoot)}`];
    }
    try {
        if (fs.existsSync(normalizedRoot)) {
            validateCaptureRootLocation(repoRoot, taskId, normalizedRoot, expectedIdentity);
            fs.rmSync(normalizedRoot, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 50
            });
        }
        return [];
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`split-required WIP capture cleanup failed: ${message}`];
    }
}

function prepareCapture(params: {
    repoRoot: string;
    taskId: string;
    guardKind: SplitRequiredWipGuardKind;
    guardReason: string;
    preflightPath: string;
    baseCommit: string;
    captureRoot: string;
    manifestPath: string;
    timestampUtc: string;
    trackedChanges: TrackedChangeFiles;
    capturedUntrackedFiles: string[];
    unrelatedVisibleUntrackedFiles: string[];
    ignoredRuntimeArtifacts: string[];
}): PreparedSplitRequiredWipCapture {
    let captureRootCreated = false;
    let captureRootIdentity: fs.Stats | undefined;
    try {
        captureRootIdentity = createExclusiveCaptureRoot(
            params.repoRoot,
            params.taskId,
            params.captureRoot
        );
        captureRootCreated = true;
        const stagedPatch = writeScopedPatchFile(
            params.repoRoot,
            ['diff', '--binary', '--cached'],
            params.trackedChanges.staged,
            path.join(params.captureRoot, 'staged.patch')
        );
        const unstagedPatch = writeScopedPatchFile(
            params.repoRoot,
            ['diff', '--binary'],
            params.trackedChanges.unstaged,
            path.join(params.captureRoot, 'unstaged.patch')
        );
        const untracked = params.capturedUntrackedFiles.map((relativePath) => (
            copyUntrackedTaskFile(params.repoRoot, params.captureRoot, relativePath)
        ));
        const baseEntries = readGitTreeEntriesForPaths(
            params.repoRoot,
            params.baseCommit,
            params.trackedChanges.all
        );
        const trackedFiles: SplitRequiredWipTrackedFileEvidence[] = params.trackedChanges.all.map(
            (relativePath) => {
                let worktreeSha256: string | null = null;
                try {
                    worktreeSha256 = sha256Buffer(
                        readStableRepoFile(
                            params.repoRoot,
                            relativePath,
                            'tracked capture source'
                        ).content
                    );
                } catch (error: unknown) {
                    const code = error instanceof Error
                        ? (error as NodeJS.ErrnoException).code
                        : undefined;
                    if (code !== 'ENOENT') {
                        throw error;
                    }
                }
                return {
                    path: relativePath,
                    head_sha256: baseEntries.get(relativePath)?.objectId || null,
                    worktree_sha256: worktreeSha256,
                    staged: params.trackedChanges.staged.has(relativePath),
                    unstaged: params.trackedChanges.unstaged.has(relativePath)
                };
            }
        );
        const manifest = buildSplitRequiredWipManifest({
            repoRoot: params.repoRoot,
            taskId: params.taskId,
            guardKind: params.guardKind,
            guardReason: params.guardReason,
            timestampUtc: params.timestampUtc,
            manifestPath: params.manifestPath,
            preflightPath: params.preflightPath,
            stagedPatch: buildPatchEvidence(stagedPatch),
            unstagedPatch: buildPatchEvidence(unstagedPatch),
            trackedFiles,
            untrackedFiles: untracked.map((entry) => entry.evidence),
            unrelatedVisibleUntrackedFiles: params.unrelatedVisibleUntrackedFiles,
            ignoredRuntimeArtifacts: params.ignoredRuntimeArtifacts
        });
        if (manifest.base_commit !== params.baseCommit) {
            throw new Error(
                `repository HEAD changed while preparing split-required WIP capture: expected ${params.baseCommit}; found ${manifest.base_commit}`
            );
        }
        const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        const manifestSnapshot = writeExclusiveCaptureFile(params.manifestPath, manifestContent);
        verifyCaptureFile(stagedPatch, 'captured staged WIP patch');
        verifyCaptureFile(unstagedPatch, 'captured unstaged WIP patch');
        for (const entry of untracked) {
            const resolvedArtifactPath = resolveInputPathInsideRepo(
                params.repoRoot,
                entry.evidence.artifact_path,
                `untracked artifact ${entry.evidence.path}`
            );
            if (path.resolve(resolvedArtifactPath) !== path.resolve(entry.artifact.path)) {
                throw new Error(`captured untracked WIP artifact path changed: ${entry.evidence.path}`);
            }
            verifyCaptureFile(entry.artifact, `captured untracked WIP artifact ${entry.evidence.path}`);
        }
        verifyCaptureFile(manifestSnapshot, 'captured WIP manifest');
        return {
            captureRoot: params.captureRoot,
            captureRootIdentity,
            baseCommit: params.baseCommit,
            manifestPath: params.manifestPath,
            manifestSha256: sha256Buffer(manifestContent),
            manifest,
            trackedChanges: params.trackedChanges,
            capturedUntrackedFiles: params.capturedUntrackedFiles,
            stagedPatch,
            unstagedPatch,
            manifestSnapshot,
            untracked,
            baseEntries
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const cleanupViolations = captureRootCreated
            ? removePreparedCapture(
                params.repoRoot,
                params.taskId,
                params.captureRoot,
                captureRootIdentity
            )
            : [];
        throw new Error([message, ...cleanupViolations].join(' '));
    }
}

function buildCurrentPatch(
    repoRoot: string,
    diffArgs: string[],
    relativePaths: Set<string>
): Buffer {
    const sortedPaths = [...relativePaths].sort();
    return sortedPaths.length === 0
        ? Buffer.alloc(0)
        : runGitBinary(repoRoot, [...diffArgs, '--', ...sortedPaths]);
}

function validateWorkspaceMatchesPreparedCapture(
    repoRoot: string,
    prepared: PreparedSplitRequiredWipCapture,
    requireOriginalUntrackedIdentity = true
): string[] {
    const violations: string[] = [];
    try {
        assertRepositoryHead(repoRoot, prepared.baseCommit);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(message);
    }
    try {
        verifyCaptureFile(prepared.stagedPatch, 'captured staged WIP patch');
        verifyCaptureFile(prepared.unstagedPatch, 'captured unstaged WIP patch');
        verifyCaptureFile(prepared.manifestSnapshot, 'captured WIP manifest');
        for (const entry of prepared.untracked) {
            verifyCaptureFile(entry.artifact, `captured untracked WIP artifact ${entry.evidence.path}`);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`captured WIP evidence verification failed: ${message}`);
    }
    const currentTracked = excludeGateOwnedQueueFiles(collectTrackedChangeFiles(repoRoot));
    const expectedStaged = [...prepared.trackedChanges.staged].sort();
    const expectedUnstaged = [...prepared.trackedChanges.unstaged].sort();
    if (JSON.stringify([...currentTracked.staged].sort()) !== JSON.stringify(expectedStaged)) {
        violations.push('staged WIP path set changed after capture.');
    }
    if (JSON.stringify([...currentTracked.unstaged].sort()) !== JSON.stringify(expectedUnstaged)) {
        violations.push('unstaged WIP path set changed after capture.');
    }
    const stagedPatch = buildCurrentPatch(
        repoRoot,
        ['diff', '--binary', '--cached'],
        prepared.trackedChanges.staged
    );
    if (!stagedPatch.equals(prepared.stagedPatch.content)) {
        violations.push('staged WIP content changed after capture.');
    }
    const unstagedPatch = buildCurrentPatch(
        repoRoot,
        ['diff', '--binary'],
        prepared.trackedChanges.unstaged
    );
    if (!unstagedPatch.equals(prepared.unstagedPatch.content)) {
        violations.push('unstaged WIP content changed after capture.');
    }
    for (const entry of prepared.untracked) {
        const sourcePath = resolveRepoPath(repoRoot, entry.evidence.path);
        if (!fs.existsSync(sourcePath)) {
            violations.push(`captured untracked WIP source is missing: ${entry.evidence.path}`);
            continue;
        }
        try {
            const currentSource = readStableRepoFile(
                repoRoot,
                entry.evidence.path,
                'captured untracked WIP source'
            );
            const identity = currentSource.identity;
            if (requireOriginalUntrackedIdentity
                && !sameFileIdentity(entry.sourceIdentity, identity)) {
                violations.push(`captured untracked WIP source identity changed after capture: ${entry.evidence.path}`);
                continue;
            }
            if (!currentSource.content.equals(entry.content)) {
                violations.push(`captured untracked WIP source changed after capture: ${entry.evidence.path}`);
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(`captured untracked WIP source validation failed for ${entry.evidence.path}: ${message}`);
        }
    }
    return violations;
}

function validatePreparedCaptureSuspended(
    repoRoot: string,
    prepared: PreparedSplitRequiredWipCapture
): string[] {
    const violations: string[] = [];
    const remainingTracked = excludeGateOwnedQueueFiles(collectTrackedChangeFiles(repoRoot));
    if (remainingTracked.all.length > 0) {
        violations.push(`tracked WIP remains after suspension: ${remainingTracked.all.join(', ')}`);
    }
    for (const relativePath of prepared.capturedUntrackedFiles) {
        if (fs.existsSync(resolveRepoPath(repoRoot, relativePath))) {
            violations.push(`untracked WIP remains after suspension: ${relativePath}`);
        }
    }
    return violations;
}

function runGitWithInput(repoRoot: string, args: string[], input: Buffer): void {
    childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
        input,
        stdio: ['pipe', 'pipe', 'pipe']
    });
}

function restoreUntrackedSnapshot(
    repoRoot: string,
    snapshot: CapturedUntrackedSnapshot
): string[] {
    const targetPath = resolveRepoPath(repoRoot, snapshot.evidence.path);
    try {
        if (fs.existsSync(targetPath)) {
            const identity = fs.lstatSync(targetPath);
            if (!identity.isFile()
                || identity.isSymbolicLink()
                || !fs.readFileSync(targetPath).equals(snapshot.content)) {
                return [`failed to restore untracked WIP after suspension failure: target changed for ${snapshot.evidence.path}`];
            }
            return [];
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, snapshot.content, { flag: 'wx' });
        return [];
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`failed to restore untracked WIP after suspension failure for ${snapshot.evidence.path}: ${message}`];
    }
}

function rollbackSuspension(
    repoRoot: string,
    prepared: PreparedSplitRequiredWipCapture
): string[] {
    const violations: string[] = [];
    try {
        suspendTrackedChanges(
            repoRoot,
            prepared.trackedChanges.all,
            prepared.baseCommit,
            prepared.baseEntries
        );
        if (prepared.stagedPatch.content.byteLength > 0) {
            runGitWithInput(repoRoot, ['apply', '--check', '--index', '-'], prepared.stagedPatch.content);
            runGitWithInput(repoRoot, ['apply', '--index', '-'], prepared.stagedPatch.content);
        }
        if (prepared.unstagedPatch.content.byteLength > 0) {
            runGitWithInput(repoRoot, ['apply', '--check', '-'], prepared.unstagedPatch.content);
            runGitWithInput(repoRoot, ['apply', '-'], prepared.unstagedPatch.content);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`failed to restore tracked WIP after suspension failure: ${message}`);
    }
    for (const snapshot of prepared.untracked) {
        violations.push(...restoreUntrackedSnapshot(repoRoot, snapshot));
    }
    if (violations.length === 0) {
        try {
            violations.push(...validateWorkspaceMatchesPreparedCapture(repoRoot, prepared, false));
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(`failed to verify restored WIP after suspension failure: ${message}`);
        }
    }
    return violations;
}

function suspendUntrackedSnapshot(
    repoRoot: string,
    prepared: PreparedSplitRequiredWipCapture,
    snapshot: CapturedUntrackedSnapshot
): void {
    const sourcePath = resolveRepoPath(repoRoot, snapshot.evidence.path);
    const currentSource = readStableRepoFile(
        repoRoot,
        snapshot.evidence.path,
        'captured untracked WIP source'
    );
    if (!sameFileIdentity(snapshot.sourceIdentity, currentSource.identity)
        || !currentSource.content.equals(snapshot.content)) {
        throw new Error(`captured untracked WIP source changed before suspension: ${snapshot.evidence.path}`);
    }
    const quarantinePath = path.join(
        prepared.captureRoot,
        'suspended-untracked',
        normalizeGitPath(snapshot.evidence.path)
    );
    fs.mkdirSync(path.dirname(quarantinePath), { recursive: true });
    if (fs.existsSync(quarantinePath)) {
        throw new Error(`untracked WIP quarantine target already exists: ${snapshot.evidence.path}`);
    }
    fs.renameSync(sourcePath, quarantinePath);
    const quarantinedIdentity = fs.lstatSync(quarantinePath);
    if (!quarantinedIdentity.isFile()
        || quarantinedIdentity.isSymbolicLink()
        || !sameFileIdentity(snapshot.sourceIdentity, quarantinedIdentity)
        || !fs.readFileSync(quarantinePath).equals(snapshot.content)) {
        if (!fs.existsSync(sourcePath)) {
            fs.renameSync(quarantinePath, sourcePath);
        }
        throw new Error(`captured untracked WIP source changed before suspension: ${snapshot.evidence.path}`);
    }
    fs.unlinkSync(quarantinePath);
}

function blockedCaptureResult(params: {
    prepared?: PreparedSplitRequiredWipCapture | null;
    trackedFiles: string[];
    untrackedFiles: string[];
    violations: string[];
    retainCapture?: boolean;
    checkoutState?: SplitRequiredWipCheckoutState;
}): SplitRequiredWipCaptureResult {
    const retainCapture = Boolean(params.retainCapture && params.prepared);
    return {
        status: 'BLOCKED',
        checkout_state: params.checkoutState || 'restored',
        manifest_path: retainCapture ? normalizePath(params.prepared!.manifestPath) : null,
        manifest_sha256: retainCapture ? params.prepared!.manifestSha256 : null,
        tracked_files: params.trackedFiles,
        untracked_files: params.untrackedFiles,
        violations: params.violations
    } as SplitRequiredWipCaptureResult;
}

type SplitRequiredWipCheckoutState = 'suspended' | 'restored' | 'indeterminate';

function inspectCapturedWorkspaceSuspension(
    repoRoot: string,
    manifest: SplitRequiredWipManifest
): {
    checkoutState: SplitRequiredWipCheckoutState;
    violations: string[];
} {
    try {
        const currentHead = getHeadCommit(repoRoot);
        if (currentHead !== manifest.base_commit) {
            return {
                checkoutState: 'indeterminate',
                violations: [
                    `split-required WIP checkout state identity mismatch: expected HEAD ${manifest.base_commit}; found ${currentHead}`
                ]
            };
        }
        const currentTracked = excludeGateOwnedQueueFiles(collectTrackedChangeFiles(repoRoot));
        const trackedChanges = currentTracked.all;
        const visibleUntrackedFiles = collectVisibleUntrackedFiles(repoRoot);
        const capturedUntrackedAbsent = manifest.untracked_files.every((entry) => (
            isRepoPathAbsent(repoRoot, entry.path)
        ));
        if (trackedChanges.length === 0
            && visibleUntrackedFiles.length === 0
            && capturedUntrackedAbsent) {
            const finalHead = getHeadCommit(repoRoot);
            if (finalHead !== currentHead) {
                return {
                    checkoutState: 'indeterminate',
                    violations: [
                        `split-required WIP checkout state identity changed during inspection: expected HEAD ${currentHead}; found ${finalHead}`
                    ]
                };
            }
            return {
                checkoutState: 'suspended',
                violations: []
            };
        }

        const restoredViolations: string[] = [];
        const expectedTrackedPaths = manifest.tracked_files.map((entry) => entry.path).sort();
        if (JSON.stringify(trackedChanges) !== JSON.stringify(expectedTrackedPaths)) {
            restoredViolations.push('tracked WIP path set does not match the retained capture.');
        }
        const expectedStaged = new Set(
            manifest.tracked_files.filter((entry) => entry.staged).map((entry) => entry.path)
        );
        const expectedUnstaged = new Set(
            manifest.tracked_files.filter((entry) => entry.unstaged).map((entry) => entry.path)
        );
        if (JSON.stringify([...currentTracked.staged].sort()) !== JSON.stringify([...expectedStaged].sort())) {
            restoredViolations.push('staged WIP path set does not match the retained capture.');
        }
        if (JSON.stringify([...currentTracked.unstaged].sort()) !== JSON.stringify([...expectedUnstaged].sort())) {
            restoredViolations.push('unstaged WIP path set does not match the retained capture.');
        }
        const stagedPatch = buildCurrentPatch(repoRoot, ['diff', '--binary', '--cached'], expectedStaged);
        const unstagedPatch = buildCurrentPatch(repoRoot, ['diff', '--binary'], expectedUnstaged);
        if (sha256Buffer(stagedPatch) !== manifest.patches.staged.sha256
            || stagedPatch.byteLength !== manifest.patches.staged.bytes) {
            restoredViolations.push('staged WIP content does not match the retained capture.');
        }
        if (sha256Buffer(unstagedPatch) !== manifest.patches.unstaged.sha256
            || unstagedPatch.byteLength !== manifest.patches.unstaged.bytes) {
            restoredViolations.push('unstaged WIP content does not match the retained capture.');
        }
        for (const entry of manifest.tracked_files) {
            if (entry.worktree_sha256 === null) {
                if (!isRepoPathAbsent(repoRoot, entry.path)) {
                    restoredViolations.push(`restored tracked WIP path should be absent: ${entry.path}`);
                }
                continue;
            }
            const currentSource = readStableRepoFile(repoRoot, entry.path, 'restored tracked WIP source');
            if (sha256Buffer(currentSource.content) !== entry.worktree_sha256) {
                restoredViolations.push(`restored tracked WIP content changed: ${entry.path}`);
            }
        }
        const expectedUntrackedPaths = new Set(manifest.untracked_files.map((entry) => entry.path));
        if (visibleUntrackedFiles.some((relativePath) => !expectedUntrackedPaths.has(relativePath))) {
            restoredViolations.push('visible untracked WIP path set does not match the retained capture.');
        }
        for (const entry of manifest.untracked_files) {
            const currentSource = readStableRepoFile(repoRoot, entry.path, 'restored untracked WIP source');
            if (currentSource.content.byteLength !== entry.bytes
                || sha256Buffer(currentSource.content) !== entry.sha256) {
                restoredViolations.push(`restored untracked WIP content changed: ${entry.path}`);
            }
        }
        const finalHead = getHeadCommit(repoRoot);
        if (finalHead !== currentHead) {
            restoredViolations.push(
                `split-required WIP checkout state identity changed during inspection: expected HEAD ${currentHead}; found ${finalHead}`
            );
        }
        return restoredViolations.length === 0
            ? { checkoutState: 'restored', violations: [] }
            : {
                checkoutState: 'indeterminate',
                violations: [
                    'retained split-required WIP checkout is neither verified suspended nor restored.',
                    ...restoredViolations
                ]
            };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            checkoutState: 'indeterminate',
            violations: [`split-required WIP checkout state inspection failed: ${message}`]
        };
    }
}

function isRepoPathAbsent(repoRoot: string, relativePath: string): boolean {
    try {
        fs.lstatSync(resolveRepoPath(repoRoot, relativePath));
        return false;
    } catch (error: unknown) {
        return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
    }
}

export function captureAndSuspendSplitRequiredWip(params: {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    guardKind: SplitRequiredWipGuardKind;
    guardReason: string;
}): SplitRequiredWipCaptureResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    const preflightPath = resolveInputPathInsideRepo(repoRoot, params.preflightPath, 'PreflightPath');
    const taskId = String(params.taskId || '').trim();
    if (!canCaptureSplitRequiredWip(repoRoot)) {
        return blockedCaptureResult({
            trackedFiles: [],
            untrackedFiles: [],
            violations: ['split-required WIP capture requires a git worktree.']
        });
    }
    const current = findCurrentCapturedManifest({
        repoRoot,
        taskId,
        preflightPath,
        guardKind: params.guardKind
    });
    if (current) {
        const inspection = inspectCapturedWorkspaceSuspension(repoRoot, current.manifest);
        if (inspection.checkoutState === 'suspended') {
            return {
                status: 'ALREADY_CAPTURED',
                checkout_state: 'suspended',
                manifest_path: normalizePath(current.path),
                manifest_sha256: sha256Buffer(fs.readFileSync(current.path)),
                tracked_files: current.manifest.tracked_files.map((entry) => entry.path).sort(),
                untracked_files: current.manifest.untracked_files.map((entry) => entry.path).sort(),
                violations: []
            } as SplitRequiredWipCaptureResult;
        }
        if (inspection.checkoutState === 'indeterminate') {
            return {
                status: 'BLOCKED',
                checkout_state: 'indeterminate',
                manifest_path: normalizePath(current.path),
                manifest_sha256: sha256Buffer(fs.readFileSync(current.path)),
                tracked_files: current.manifest.tracked_files.map((entry) => entry.path).sort(),
                untracked_files: current.manifest.untracked_files.map((entry) => entry.path).sort(),
                violations: inspection.violations
            } as SplitRequiredWipCaptureResult;
        }
    }

    const preflightScope = readPreflightChangedFileScope(repoRoot, preflightPath, taskId);
    const baseCommit = getHeadCommit(repoRoot);
    const trackedChanges = excludeGateOwnedQueueFiles(collectTrackedChangeFiles(repoRoot));
    const outOfScopeTrackedChanges = trackedChanges.all.filter(
        (relativePath) => !preflightScope.allowed.has(relativePath)
    );
    const visibleUntracked = collectVisibleUntrackedFiles(repoRoot);
    const unrelatedVisibleUntrackedFiles = visibleUntracked.filter((relativePath) => (
        !isTaskOwnedUntrackedPath(relativePath, taskId)
        && !preflightScope.allowed.has(relativePath)
    ));
    const scopeViolations = [...preflightScope.violations];
    if (outOfScopeTrackedChanges.length > 0) {
        scopeViolations.push(
            `tracked changes outside current preflight scope: ${outOfScopeTrackedChanges.join(', ')}`
        );
    }
    if (unrelatedVisibleUntrackedFiles.length > 0) {
        scopeViolations.push(
            `unrelated untracked files would keep split child scope dirty: ${unrelatedVisibleUntrackedFiles.join(', ')}`
        );
    }
    if (scopeViolations.length > 0) {
        return blockedCaptureResult({
            trackedFiles: trackedChanges.all,
            untrackedFiles: [],
            violations: scopeViolations
        });
    }

    const scopedUntrackedFiles = collectUntrackedFilesForPathspecs(
        repoRoot,
        [...preflightScope.allowed],
        true
    );
    const ignoredRuntimeArtifacts = scopedUntrackedFiles.filter(isIgnoredRuntimeArtifactPath);
    const capturedUntrackedFiles = [...new Set([
        ...collectRuntimeTmpTaskOwnedUntrackedFiles(repoRoot, taskId),
        ...scopedUntrackedFiles.filter((relativePath) => !isIgnoredRuntimeArtifactPath(relativePath))
    ])].sort();
    const capturePlan = planCaptureLocation(repoRoot, taskId);
    let prepared: PreparedSplitRequiredWipCapture | null = null;
    try {
        prepared = prepareCapture({
            repoRoot,
            taskId,
            guardKind: params.guardKind,
            guardReason: params.guardReason,
            preflightPath,
            baseCommit,
            captureRoot: capturePlan.captureRoot,
            manifestPath: capturePlan.manifestPath,
            timestampUtc: capturePlan.timestampUtc,
            trackedChanges,
            capturedUntrackedFiles,
            unrelatedVisibleUntrackedFiles,
            ignoredRuntimeArtifacts
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return blockedCaptureResult({
            trackedFiles: trackedChanges.all,
            untrackedFiles: capturedUntrackedFiles,
            violations: [`split-required WIP capture preparation failed: ${message}`]
        });
    }

    let preSuspensionViolations: string[] = [];
    try {
        preSuspensionViolations = validateWorkspaceMatchesPreparedCapture(repoRoot, prepared);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        preSuspensionViolations = [`split-required WIP pre-suspension verification failed: ${message}`];
    }
    if (preSuspensionViolations.length > 0) {
        const cleanupViolations = removePreparedCapture(
            repoRoot,
            taskId,
            prepared.captureRoot,
            prepared.captureRootIdentity
        );
        return blockedCaptureResult({
            prepared,
            trackedFiles: trackedChanges.all,
            untrackedFiles: capturedUntrackedFiles,
            violations: [...preSuspensionViolations, ...cleanupViolations],
            retainCapture: cleanupViolations.length > 0
        });
    }

    let suspensionStarted = false;
    try {
        assertRepositoryHead(repoRoot, prepared.baseCommit);
        suspensionStarted = true;
        suspendTrackedChanges(
            repoRoot,
            trackedChanges.all,
            prepared.baseCommit,
            prepared.baseEntries
        );
        for (const snapshot of prepared.untracked) {
            suspendUntrackedSnapshot(repoRoot, prepared, snapshot);
        }
        const suspensionViolations = validatePreparedCaptureSuspended(repoRoot, prepared);
        if (suspensionViolations.length > 0) {
            throw new Error(suspensionViolations.join(' '));
        }

        appendMandatoryTaskEvent(
            joinOrchestratorPath(repoRoot, ''),
            taskId,
            'SPLIT_REQUIRED_WIP_CAPTURED',
            'BLOCKED',
            'Split-required parent WIP captured into task-owned artifacts and suspended.',
            {
                manifest_path: normalizePath(prepared.manifestPath),
                manifest_sha256: prepared.manifestSha256,
                guard_kind: params.guardKind,
                tracked_files: prepared.manifest.tracked_files.map((entry) => entry.path).sort(),
                untracked_files: prepared.manifest.untracked_files.map((entry) => entry.path).sort(),
                ignored_runtime_artifacts: ignoredRuntimeArtifacts
            },
            { actor: 'orchestrator' }
        );

        return {
            status: 'CAPTURED',
            checkout_state: 'suspended',
            manifest_path: normalizePath(prepared.manifestPath),
            manifest_sha256: prepared.manifestSha256,
            tracked_files: prepared.manifest.tracked_files.map((entry) => entry.path).sort(),
            untracked_files: prepared.manifest.untracked_files.map((entry) => entry.path).sort(),
            violations: []
        } as SplitRequiredWipCaptureResult;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const rollbackViolations = suspensionStarted
            ? rollbackSuspension(repoRoot, prepared)
            : [];
        const cleanupViolations = rollbackViolations.length === 0
            ? removePreparedCapture(
                repoRoot,
                taskId,
                prepared.captureRoot,
                prepared.captureRootIdentity
            )
            : [];
        const suspensionInspection = rollbackViolations.length > 0
            ? inspectCapturedWorkspaceSuspension(repoRoot, prepared.manifest)
            : null;
        const violations = [
            `split-required WIP capture transaction failed: ${message}`,
            ...rollbackViolations,
            ...cleanupViolations,
            ...(suspensionInspection?.violations || [])
        ];
        const checkoutState: SplitRequiredWipCheckoutState = rollbackViolations.length === 0
            ? 'restored'
            : suspensionInspection!.checkoutState;
        return blockedCaptureResult({
            prepared,
            trackedFiles: trackedChanges.all,
            untrackedFiles: capturedUntrackedFiles,
            violations,
            retainCapture: rollbackViolations.length > 0 || cleanupViolations.length > 0,
            checkoutState
        });
    }
}
