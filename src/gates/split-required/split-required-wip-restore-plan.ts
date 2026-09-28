import * as childProcess from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { lstatFileIdentitySync } from '../../core/file-stat';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    readGitTreeEntriesForPaths,
    runGit
} from '../../core/git-helpers';
import type { GitTreeEntry } from '../../core/git-helpers';
import { isPlainRecord } from '../../core/records';
import { normalizePath } from '../shared/helpers';
import {
    getHeadCommit,
    normalizeGitPath,
    resolveInputPathInsideRepo,
    resolveRepoPath,
    sha256FileRequired
} from './split-required-wip-contracts';
import type {
    SplitRequiredWipManifest,
    SplitRequiredWipPatchEvidence,
    SplitRequiredWipTrackedFileEvidence,
    SplitRequiredWipUntrackedFileEvidence
} from './split-required-wip-contracts';

export interface AdvancedRestorePlan {
    tempRoot: string;
    candidateIndexPath: string;
    candidateWorktreeRoot: string;
    currentHead: string;
    currentIndexSha256: string;
    targetSha256: Map<string, string | null>;
}

export interface SplitRequiredWipRestoreArtifactSnapshots {
    patches: {
        staged: Buffer;
        unstaged: Buffer;
    };
    untrackedFiles: ReadonlyMap<string, Buffer>;
}

const GIT_RESTORE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const RESTORE_BACKUP_IO_CHUNK_BYTES = 64 * 1024;
const REMOVAL_HASH_IO_CHUNK_BYTES = 64 * 1024;
const RESTORE_BACKUP_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const GIT_RESTORE_COMMAND_TIMEOUT_MS = 2 * 60 * 1_000;

interface RepoParentDirectoryIdentity {
    path: string;
    realPath: string;
    stat: fs.Stats;
}

interface RepoParentSnapshot {
    repoRoot: string;
    targetPath: string;
    directories: RepoParentDirectoryIdentity[];
}

export interface AuthenticatedRepoFileSnapshot {
    exists: boolean;
    content: Buffer | null;
    mode: number | null;
    identity: fs.Stats | null;
}

export interface AuthenticatedRepoFileRemovalHandle {
    identity: fs.Stats;
    remove(): void;
    close(): void;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: fs.Stats, right: fs.Stats): boolean {
    return sameFileIdentity(left, right)
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs
        && left.mode === right.mode;
}

function sameFileAcrossQuarantineRename(left: fs.Stats, right: fs.Stats): boolean {
    return sameFileIdentity(left, right)
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.mode === right.mode
        && left.nlink === right.nlink
        && left.uid === right.uid
        && left.gid === right.gid
        && left.birthtimeMs === right.birthtimeMs;
}

function readRemovalContentHash(descriptor: number, identity: fs.Stats): string {
    if (!Number.isSafeInteger(identity.size) || identity.size < 0
        || !sameFileSnapshot(identity, fs.fstatSync(descriptor))) {
        throw new Error('restore target changed before capturing removal bytes');
    }
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(Math.min(identity.size, REMOVAL_HASH_IO_CHUNK_BYTES));
    let offset = 0;
    while (offset < identity.size) {
        const bytesRead = fs.readSync(
            descriptor, chunk, 0, Math.min(chunk.length, identity.size - offset), offset
        );
        if (bytesRead <= 0) {
            throw new Error('restore target ended while capturing removal bytes');
        }
        hash.update(chunk.subarray(0, bytesRead));
        offset += bytesRead;
    }
    if (!sameFileSnapshot(identity, fs.fstatSync(descriptor))) {
        throw new Error('restore target changed while capturing removal bytes');
    }
    return hash.digest('hex');
}

function samePath(left: string, right: string): boolean {
    const normalize = (value: string): string => {
        const resolved = path.resolve(value);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(left) === normalize(right);
}

function pathIsInside(candidate: string, parent: string): boolean {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function captureRepoParentSnapshot(
    repoRoot: string,
    relativePath: string,
    createMissing: boolean
): RepoParentSnapshot {
    const canonicalRoot = fs.realpathSync.native(path.resolve(repoRoot));
    const normalizedPath = normalizeGitPath(relativePath);
    const targetPath = resolveRepoPath(canonicalRoot, normalizedPath);
    const parentRelativePath = path.dirname(normalizedPath);
    const segments = parentRelativePath === '.'
        ? []
        : parentRelativePath.split('/').filter(Boolean);
    const directories: RepoParentDirectoryIdentity[] = [];
    let currentPath = canonicalRoot;
    for (const segment of ['', ...segments]) {
        if (segment) {
            currentPath = path.join(currentPath, segment);
            if (createMissing) {
                try {
                    fs.mkdirSync(currentPath);
                } catch (error: unknown) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                        throw error;
                    }
                }
            }
        }
        const stat = lstatFileIdentitySync(currentPath);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(`restore parent must remain a real directory: ${relativePath}`);
        }
        const realPath = fs.realpathSync.native(currentPath);
        if (!pathIsInside(realPath, canonicalRoot)) {
            throw new Error(`restore parent escaped the repository: ${relativePath}`);
        }
        directories.push({ path: currentPath, realPath, stat });
    }
    return { repoRoot: canonicalRoot, targetPath, directories };
}

function assertRepoParentSnapshot(snapshot: RepoParentSnapshot, relativePath: string): void {
    for (const directory of snapshot.directories) {
        let current: fs.Stats;
        try {
            current = lstatFileIdentitySync(directory.path);
        } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
            throw new Error(`restore parent identity changed during access: ${relativePath}`, { cause: error });
        }
        if (current.isSymbolicLink()
            || !current.isDirectory()
            || !sameFileIdentity(directory.stat, current)
            || !samePath(directory.realPath, fs.realpathSync.native(directory.path))
            || !pathIsInside(directory.realPath, snapshot.repoRoot)) {
            throw new Error(`restore parent identity changed during access: ${relativePath}`);
        }
    }
}

function assertRepoTargetBound(
    snapshot: RepoParentSnapshot,
    relativePath: string,
    descriptorIdentity: fs.Stats
): void {
    assertRepoParentSnapshot(snapshot, relativePath);
    const current = lstatFileIdentitySync(snapshot.targetPath);
    if (current.isSymbolicLink()
        || !current.isFile()
        || !sameFileIdentity(current, descriptorIdentity)
        || !pathIsInside(fs.realpathSync.native(snapshot.targetPath), snapshot.repoRoot)) {
        throw new Error(`restore target identity changed during access: ${relativePath}`);
    }
}

interface RepoParentDescriptorTarget {
    descriptor: number;
    targetPath: string;
}

function removeEmptyDirectoryIfPresent(directoryPath: string): void {
    try {
        fs.rmdirSync(directoryPath);
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
            throw error;
        }
    }
}

function openRepoParentDescriptorTarget(
    snapshot: RepoParentSnapshot,
    relativePath: string
): RepoParentDescriptorTarget {
    const parent = snapshot.directories[snapshot.directories.length - 1];
    if (!parent) {
        throw new Error(`restore parent snapshot is empty: ${relativePath}`);
    }
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const directoryFlag = typeof fs.constants.O_DIRECTORY === 'number' ? fs.constants.O_DIRECTORY : 0;
    const descriptor = fs.openSync(parent.path, fs.constants.O_RDONLY | directoryFlag | noFollowFlag);
    try {
        const openedParent = fs.fstatSync(descriptor);
        if (!openedParent.isDirectory() || !sameFileIdentity(parent.stat, openedParent)) {
            throw new Error(`restore parent identity changed while opening for removal: ${relativePath}`);
        }
        if (process.platform === 'win32') {
            return { descriptor, targetPath: snapshot.targetPath };
        }
        for (const descriptorRoot of ['/proc/self/fd', '/dev/fd']) {
            const descriptorParentPath = path.join(descriptorRoot, String(descriptor));
            try {
                const descriptorParent = fs.statSync(descriptorParentPath);
                if (descriptorParent.isDirectory() && sameFileIdentity(openedParent, descriptorParent)) {
                    return {
                        descriptor,
                        targetPath: path.join(descriptorParentPath, path.basename(snapshot.targetPath))
                    };
                }
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
                    && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
                    throw error;
                }
            }
        }
        throw new Error(`descriptor-relative restore removal is unavailable: ${relativePath}`);
    } catch (error: unknown) {
        fs.closeSync(descriptor);
        throw error;
    }
}

function fsyncRepoParentDescriptor(descriptor: number): void {
    try {
        fs.fsyncSync(descriptor);
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || (code !== 'EINVAL' && code !== 'EPERM')) {
            throw error;
        }
        // Windows does not consistently permit FlushFileBuffers on directory handles.
    }
}

function unlinkTargetBoundToOpenedParent(
    parentTarget: RepoParentDescriptorTarget,
    _relativePath: string,
    expectedIdentity: fs.Stats,
    targetDescriptor: number,
    requireSnapshot: boolean
): boolean {
    const openedTarget = fs.fstatSync(targetDescriptor);
    if (!openedTarget.isFile()
        || !(requireSnapshot
            ? sameFileSnapshot(openedTarget, expectedIdentity)
            : sameFileIdentity(openedTarget, expectedIdentity))) {
        return false;
    }
    let boundTarget: fs.Stats;
    try {
        boundTarget = lstatFileIdentitySync(parentTarget.targetPath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
    if (boundTarget.isSymbolicLink()
        || !boundTarget.isFile()
        || !(requireSnapshot
            ? sameFileSnapshot(boundTarget, expectedIdentity)
            : sameFileIdentity(boundTarget, expectedIdentity))) {
        return false;
    }
    if (process.platform === 'win32') {
        // The open target and parent handles prevent final-component replacement on Windows.
        fs.unlinkSync(parentTarget.targetPath);
        return true;
    }
    const expectedContentHash = requireSnapshot
        ? readRemovalContentHash(targetDescriptor, expectedIdentity)
        : null;
    const quarantineDirectory = fs.mkdtempSync(
        path.join(path.dirname(parentTarget.targetPath), '.garda-restore-remove-')
    );
    fs.chmodSync(quarantineDirectory, 0o700);
    const quarantineTargetPath = path.join(
        quarantineDirectory,
        path.basename(parentTarget.targetPath)
    );
    let preserveQuarantine = false;
    try {
        if (requireSnapshot && !sameFileSnapshot(expectedIdentity, fs.fstatSync(targetDescriptor))) {
            return false;
        }
        fs.renameSync(parentTarget.targetPath, quarantineTargetPath);
        preserveQuarantine = true;
        const renamedIdentity = fs.fstatSync(targetDescriptor);
        const quarantinedTarget = lstatFileIdentitySync(quarantineTargetPath);
        // POSIX rename changes ctime. Authenticate that transition through the
        // retained descriptor, unchanged metadata and identical file bytes.
        if (quarantinedTarget.isSymbolicLink()
            || !quarantinedTarget.isFile()
            || !(requireSnapshot
                ? sameFileAcrossQuarantineRename(renamedIdentity, expectedIdentity)
                    && sameFileSnapshot(quarantinedTarget, renamedIdentity)
                    && readRemovalContentHash(targetDescriptor, renamedIdentity) === expectedContentHash
                    && sameFileSnapshot(lstatFileIdentitySync(quarantineTargetPath), renamedIdentity)
                : sameFileIdentity(quarantinedTarget, expectedIdentity))) {
            preserveQuarantine = true;
            const recoveryPath = fs.realpathSync.native(quarantineTargetPath);
            throw new Error(
                `restore target identity changed during removal; replacement preserved at ${recoveryPath}`
            );
        }
        fs.unlinkSync(quarantineTargetPath);
        preserveQuarantine = false;
    } catch (error: unknown) {
        if (preserveQuarantine) {
            const message = error instanceof Error ? error.message : String(error);
            let recoverySuffix = '; removal quarantine was preserved';
            try {
                const recoveryDirectory = fs.realpathSync.native(quarantineDirectory);
                recoverySuffix = `; removal quarantine preserved at ${path.join(
                    recoveryDirectory, path.basename(quarantineTargetPath)
                )}`;
            } catch {
                // Resolving a diagnostic path must not mask the removal failure.
            }
            throw new Error(`${message}${recoverySuffix}`, { cause: error });
        }
        throw error;
    } finally {
        if (!preserveQuarantine) {
            removeEmptyDirectoryIfPresent(quarantineDirectory);
        }
    }
    return true;
}

function unlinkRepoTargetBoundToDescriptor(
    snapshot: RepoParentSnapshot,
    relativePath: string,
    expectedIdentity: fs.Stats,
    targetDescriptor: number,
    requireSnapshot: boolean
): boolean {
    const openedTarget = fs.fstatSync(targetDescriptor);
    if (!openedTarget.isFile()
        || !(requireSnapshot
            ? sameFileSnapshot(openedTarget, expectedIdentity)
            : sameFileIdentity(openedTarget, expectedIdentity))) {
        return false;
    }
    assertRepoTargetBound(snapshot, relativePath, openedTarget);
    const parentTarget = openRepoParentDescriptorTarget(snapshot, relativePath);
    try {
        return unlinkTargetBoundToOpenedParent(
            parentTarget,
            relativePath,
            expectedIdentity,
            targetDescriptor,
            requireSnapshot
        );
    } finally {
        fs.closeSync(parentTarget.descriptor);
    }
}

function writeDescriptorBuffer(descriptor: number, content: Buffer): void {
    let offset = 0;
    while (offset < content.length) {
        const written = fs.writeSync(
            descriptor,
            content,
            offset,
            content.length - offset,
            offset
        );
        if (written <= 0) {
            throw new Error('restore descriptor write made no forward progress');
        }
        offset += written;
    }
}

function readDescriptorBuffer(
    descriptor: number,
    identity: fs.Stats,
    relativePath: string
): Buffer {
    if (!Number.isSafeInteger(identity.size)
        || identity.size < 0
        || identity.size > GIT_RESTORE_MAX_BUFFER_BYTES) {
        throw new Error(
            `restore target exceeds the ${GIT_RESTORE_MAX_BUFFER_BYTES}-byte rollback limit: ${relativePath}`
        );
    }
    const content = Buffer.alloc(identity.size);
    let offset = 0;
    while (offset < content.length) {
        const bytesRead = fs.readSync(
            descriptor,
            content,
            offset,
            content.length - offset,
            offset
        );
        if (bytesRead <= 0) {
            throw new Error(`restore target ended while capturing rollback bytes: ${relativePath}`);
        }
        offset += bytesRead;
    }
    const identityAfterRead = fs.fstatSync(descriptor);
    if (!sameFileSnapshot(identity, identityAfterRead)) {
        throw new Error(`restore target changed while capturing rollback bytes: ${relativePath}`);
    }
    return content;
}

function replaceDescriptorBytes(
    descriptor: number,
    content: Buffer,
    mode: number
): void {
    fs.ftruncateSync(descriptor, 0);
    writeDescriptorBuffer(descriptor, content);
    fs.ftruncateSync(descriptor, content.length);
    fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
}

function compensateDescriptorMutation(
    descriptor: number,
    identity: fs.Stats,
    content: Buffer,
    mode: number,
    relativePath: string
): void {
    replaceDescriptorBytes(descriptor, content, mode);
    const compensatedIdentity = fs.fstatSync(descriptor);
    if (!compensatedIdentity.isFile()
        || !sameFileIdentity(identity, compensatedIdentity)
        || compensatedIdentity.size !== content.length) {
        throw new Error(`restore descriptor compensation failed verification: ${relativePath}`);
    }
}

export function writeExclusiveRepoFileWithRemovalHandle(
    repoRoot: string,
    relativePath: string,
    content: Buffer,
    mode = 0o600
): AuthenticatedRepoFileRemovalHandle {
    const parentSnapshot = captureRepoParentSnapshot(repoRoot, relativePath, true);
    assertRepoParentSnapshot(parentSnapshot, relativePath);
    const parentTarget = openRepoParentDescriptorTarget(parentSnapshot, relativePath);
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let descriptor: number | null = null;
    let openedIdentity: fs.Stats | null = null;
    let mutationAttempted = false;
    let descriptorsRetained = false;
    try {
        descriptor = fs.openSync(
            parentTarget.targetPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
            mode
        );
        openedIdentity = fs.fstatSync(descriptor);
        if (!openedIdentity.isFile()) {
            throw new Error(`restore target must be a regular file: ${relativePath}`);
        }
        assertRepoTargetBound(parentSnapshot, relativePath, openedIdentity);
        mutationAttempted = true;
        writeDescriptorBuffer(descriptor, content);
        fs.fsyncSync(descriptor);
        const writtenIdentity = fs.fstatSync(descriptor);
        if (!writtenIdentity.isFile()
            || !sameFileIdentity(openedIdentity, writtenIdentity)
            || writtenIdentity.size !== content.length) {
            throw new Error(`restore target changed while writing: ${relativePath}`);
        }
        assertRepoTargetBound(parentSnapshot, relativePath, writtenIdentity);
        const retainedDescriptor = descriptor;
        let closed = false;
        descriptorsRetained = true;
        return {
            identity: writtenIdentity,
            remove(): void {
                if (closed) {
                    throw new Error(`restore removal handle is already closed: ${relativePath}`);
                }
                const removed = unlinkTargetBoundToOpenedParent(
                    parentTarget,
                    relativePath,
                    writtenIdentity,
                    retainedDescriptor,
                    false
                );
                if (!removed) {
                    let targetStillExists = true;
                    try {
                        lstatFileIdentitySync(parentTarget.targetPath);
                    } catch (error: unknown) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                            targetStillExists = false;
                        } else {
                            throw error;
                        }
                    }
                    if (targetStillExists) {
                        throw new Error(
                            `restore target identity changed before retained removal: ${relativePath}`
                        );
                    }
                }
            },
            close(): void {
                if (closed) {
                    return;
                }
                let closeError: unknown = null;
                try {
                    fs.closeSync(retainedDescriptor);
                } catch (error: unknown) {
                    closeError = error;
                }
                try {
                    fs.closeSync(parentTarget.descriptor);
                } catch (error: unknown) {
                    closeError ??= error;
                }
                closed = true;
                if (closeError !== null) {
                    throw closeError;
                }
            }
        };
    } catch (error: unknown) {
        let compensationError: unknown = null;
        if (descriptor !== null && openedIdentity && mutationAttempted) {
            try {
                compensateDescriptorMutation(
                    descriptor,
                    openedIdentity,
                    Buffer.alloc(0),
                    mode,
                    relativePath
                );
            } catch (caught: unknown) {
                compensationError = caught;
            }
        }
        if (descriptor !== null && openedIdentity && !compensationError) {
            try {
                unlinkTargetBoundToOpenedParent(
                    parentTarget,
                    relativePath,
                    openedIdentity,
                    descriptor,
                    false
                );
            } catch {
                // Preserve the original restore failure.
            }
        }
        if (descriptor !== null) {
            fs.closeSync(descriptor);
            descriptor = null;
        }
        if (compensationError) {
            const originalMessage = error instanceof Error ? error.message : String(error);
            const compensationMessage = compensationError instanceof Error
                ? compensationError.message
                : String(compensationError);
            throw new Error(
                `${originalMessage}; restore descriptor compensation also failed: ${compensationMessage}`
            );
        }
        throw error;
    } finally {
        if (descriptor !== null && !descriptorsRetained) {
            fs.closeSync(descriptor);
        }
        if (!descriptorsRetained) {
            fs.closeSync(parentTarget.descriptor);
        }
    }
}

export function writeExclusiveRepoFile(
    repoRoot: string,
    relativePath: string,
    content: Buffer,
    mode = 0o600
): fs.Stats {
    const handle = writeExclusiveRepoFileWithRemovalHandle(repoRoot, relativePath, content, mode);
    try {
        return handle.identity;
    } finally {
        handle.close();
    }
}

export function removeRepoFileIfIdentityMatches(
    repoRoot: string,
    relativePath: string,
    identity: fs.Stats,
    requireSnapshot = true
): void {
    let parentSnapshot: RepoParentSnapshot;
    try {
        parentSnapshot = captureRepoParentSnapshot(repoRoot, relativePath, false);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw error;
    }
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let descriptor: number;
    try {
        descriptor = fs.openSync(parentSnapshot.targetPath, fs.constants.O_RDONLY | noFollowFlag);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            assertRepoParentSnapshot(parentSnapshot, relativePath);
            return;
        }
        throw error;
    }
    try {
        unlinkRepoTargetBoundToDescriptor(
            parentSnapshot,
            relativePath,
            identity,
            descriptor,
            requireSnapshot
        );
    } finally {
        fs.closeSync(descriptor);
    }
}

function writeRepoFileReplacingRegular(
    repoRoot: string,
    relativePath: string,
    content: Buffer,
    mode: number,
    onMutated: (
        identity: fs.Stats,
        removalHandle?: AuthenticatedRepoFileRemovalHandle
    ) => void,
    expectedExistingIdentity?: fs.Stats | null,
    requireExpectedSnapshot = false,
    expectedExistingContent?: Buffer | null,
    expectedExistingMode?: number | null,
    onCompensated: () => void = () => undefined
): fs.Stats {
    const parentSnapshot = captureRepoParentSnapshot(repoRoot, relativePath, true);
    let identityBeforeOpen: fs.Stats;
    try {
        identityBeforeOpen = lstatFileIdentitySync(parentSnapshot.targetPath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
        if (expectedExistingIdentity !== undefined && expectedExistingIdentity !== null) {
            throw new Error(`restore target disappeared before replacement: ${relativePath}`);
        }
        const removalHandle = writeExclusiveRepoFileWithRemovalHandle(
            repoRoot,
            relativePath,
            content,
            mode
        );
        try {
            onMutated(removalHandle.identity, removalHandle);
            return removalHandle.identity;
        } catch (error: unknown) {
            try {
                removalHandle.remove();
            } finally {
                removalHandle.close();
            }
            throw error;
        }
    }
    if (identityBeforeOpen.isSymbolicLink() || !identityBeforeOpen.isFile()) {
        throw new Error(`restore target must remain a regular file: ${relativePath}`);
    }
    if (expectedExistingIdentity === null
        || (expectedExistingIdentity !== undefined
            && !(requireExpectedSnapshot
                ? sameFileSnapshot(identityBeforeOpen, expectedExistingIdentity)
                : sameFileIdentity(identityBeforeOpen, expectedExistingIdentity)))) {
        throw new Error(`restore target identity changed before replacement: ${relativePath}`);
    }
    assertRepoParentSnapshot(parentSnapshot, relativePath);
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let descriptor: number | null = null;
    let openedIdentity: fs.Stats | null = null;
    let rollbackContent: Buffer | null = null;
    let mutationAttempted = false;
    try {
        descriptor = fs.openSync(parentSnapshot.targetPath, fs.constants.O_RDWR | noFollowFlag);
        openedIdentity = fs.fstatSync(descriptor);
        if (!openedIdentity.isFile()
            || !sameFileSnapshot(identityBeforeOpen, openedIdentity)
            || (expectedExistingIdentity !== undefined
                && expectedExistingIdentity !== null
                && requireExpectedSnapshot
                && !sameFileSnapshot(expectedExistingIdentity, openedIdentity))) {
            throw new Error(`restore target identity changed while opening: ${relativePath}`);
        }
        assertRepoTargetBound(parentSnapshot, relativePath, openedIdentity);
        if (expectedExistingContent !== undefined && expectedExistingContent !== null) {
            if (expectedExistingContent.length !== openedIdentity.size) {
                throw new Error(`restore rollback bytes do not match the expected target size: ${relativePath}`);
            }
            rollbackContent = expectedExistingContent;
        } else {
            rollbackContent = readDescriptorBuffer(descriptor, openedIdentity, relativePath);
        }
        assertRepoTargetBound(parentSnapshot, relativePath, openedIdentity);
        onMutated(openedIdentity);
        mutationAttempted = true;
        replaceDescriptorBytes(descriptor, content, mode);
        const writtenIdentity = fs.fstatSync(descriptor);
        if (!writtenIdentity.isFile()
            || !sameFileIdentity(openedIdentity, writtenIdentity)
            || writtenIdentity.size !== content.length) {
            throw new Error(`restore target changed while replacing bytes: ${relativePath}`);
        }
        assertRepoTargetBound(parentSnapshot, relativePath, writtenIdentity);
        return writtenIdentity;
    } catch (error: unknown) {
        if (descriptor !== null && openedIdentity && rollbackContent && mutationAttempted) {
            try {
                compensateDescriptorMutation(
                    descriptor,
                    openedIdentity,
                    rollbackContent,
                    expectedExistingMode ?? (openedIdentity.mode & 0o777),
                    relativePath
                );
                onCompensated();
            } catch (compensationError: unknown) {
                const originalMessage = error instanceof Error ? error.message : String(error);
                const compensationMessage = compensationError instanceof Error
                    ? compensationError.message
                    : String(compensationError);
                throw new Error(
                    `${originalMessage}; restore descriptor compensation also failed: ${compensationMessage}`
                );
            }
        }
        throw error;
    } finally {
        if (descriptor !== null) {
            fs.closeSync(descriptor);
        }
    }
}

function assertAuthenticatedLinkSource(
    sourcePath: string,
    sourceDescriptor: number,
    expectedIdentity: fs.Stats,
    expectedContent: Buffer,
    relativePath: string,
    sourceLabel: string
): void {
    const descriptorIdentity = fs.fstatSync(sourceDescriptor);
    const pathIdentity = lstatFileIdentitySync(sourcePath);
    if (!descriptorIdentity.isFile()
        || pathIdentity.isSymbolicLink()
        || !pathIdentity.isFile()
        || !sameFileSnapshot(expectedIdentity, descriptorIdentity)
        || !sameFileSnapshot(descriptorIdentity, pathIdentity)) {
        throw new Error(
            `restore ${sourceLabel} changed before authenticated no-clobber link: ${relativePath}`
        );
    }
    const sourceContent = readDescriptorBuffer(
        sourceDescriptor,
        descriptorIdentity,
        relativePath
    );
    if (!sourceContent.equals(expectedContent)) {
        throw new Error(
            `restore ${sourceLabel} bytes changed before authenticated no-clobber link: ${relativePath}`
        );
    }
}

// Node links by pathname, not by the retained descriptor. These checks detect
// substitutions but cannot prevent transient publication between link and check.
// Callers require exclusive operational access to targets and restore working files.
function linkAuthenticatedSourceNoClobber(
    parentTarget: RepoParentDescriptorTarget,
    sourcePath: string,
    sourceDescriptor: number,
    expectedIdentity: fs.Stats,
    expectedContent: Buffer,
    relativePath: string,
    sourceLabel: string
): fs.Stats {
    assertAuthenticatedLinkSource(
        sourcePath,
        sourceDescriptor,
        expectedIdentity,
        expectedContent,
        relativePath,
        sourceLabel
    );
    fs.linkSync(sourcePath, parentTarget.targetPath);
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let targetDescriptor: number | null = null;
    try {
        targetDescriptor = fs.openSync(
            parentTarget.targetPath,
            fs.constants.O_RDONLY | noFollowFlag
        );
        const linkedIdentity = fs.fstatSync(targetDescriptor);
        const descriptorIdentity = fs.fstatSync(sourceDescriptor);
        const sourcePathMatches = authenticatedLinkSourcePathMatches(
            sourcePath,
            sourceDescriptor,
            expectedIdentity,
            expectedContent,
            relativePath,
            sourceLabel
        );
        let sourceContentMatches = false;
        try {
            sourceContentMatches = readDescriptorBuffer(
                sourceDescriptor,
                descriptorIdentity,
                relativePath
            ).equals(expectedContent);
        } catch {
            sourceContentMatches = false;
        }
        if (linkedIdentity.isFile()
            && sameFileIdentity(expectedIdentity, linkedIdentity)
            && descriptorIdentity.isFile()
            && sameFileIdentity(expectedIdentity, descriptorIdentity)
            && linkedIdentity.size === expectedContent.length
            && descriptorIdentity.size === expectedContent.length
            && linkedIdentity.mode === descriptorIdentity.mode
            && descriptorIdentity.mode === expectedIdentity.mode
            && sourceContentMatches
            && sourcePathMatches) {
            return linkedIdentity;
        }

        const targetIsAuthenticatedSource = linkedIdentity.isFile()
            && sameFileIdentity(expectedIdentity, linkedIdentity);
        if (!targetIsAuthenticatedSource && sourcePathMatches) {
            throw new Error(
                `restore target changed after authenticated no-clobber link: ${relativePath}`
            );
        }
        if (!unlinkTargetBoundToOpenedParent(
            parentTarget,
            relativePath,
            linkedIdentity,
            targetDescriptor,
            false
        )) {
            throw new Error(`restore target changed before failed authenticated link cleanup: ${relativePath}`);
        }
        throw new Error(
            `restore ${sourceLabel} changed during authenticated no-clobber link: ${relativePath}`
        );
    } finally {
        if (targetDescriptor !== null) {
            fs.closeSync(targetDescriptor);
        }
    }
}

function authenticatedLinkSourcePathMatches(
    sourcePath: string,
    sourceDescriptor: number,
    expectedIdentity: fs.Stats,
    expectedContent: Buffer,
    relativePath: string,
    _sourceLabel: string
): boolean {
    try {
        const descriptorIdentity = fs.fstatSync(sourceDescriptor);
        const pathIdentity = lstatFileIdentitySync(sourcePath);
        return descriptorIdentity.isFile()
            && !pathIdentity.isSymbolicLink()
            && pathIdentity.isFile()
            && sameFileIdentity(expectedIdentity, descriptorIdentity)
            && sameFileIdentity(descriptorIdentity, pathIdentity)
            && descriptorIdentity.size === expectedContent.length
            && descriptorIdentity.mode === expectedIdentity.mode
            && readDescriptorBuffer(
                sourceDescriptor,
                descriptorIdentity,
                relativePath
            ).equals(expectedContent);
    } catch {
        return false;
    }
}

function removeAuthenticatedLinkSourceIfMatches(
    sourcePath: string,
    sourceDescriptor: number,
    expectedIdentity: fs.Stats,
    relativePath: string
): boolean {
    return unlinkTargetBoundToOpenedParent(
        { descriptor: -1, targetPath: sourcePath },
        relativePath,
        expectedIdentity,
        sourceDescriptor,
        false
    );
}

interface ReplacementCleanupArtifact {
    path: string | null;
    descriptor: number | null;
    identity: fs.Stats | null;
    exists: boolean;
    preserve?: boolean;
    directory?: string | null;
}

function cleanupReplacementResources(options: {
    artifacts: ReplacementCleanupArtifact[];
    relativePath: string;
    parentDescriptor: number;
    primaryFailure: unknown;
}): void {
    const failures: unknown[] = [];
    const attempt = (action: () => void): void => {
        try {
            action();
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(error);
        }
    };
    for (const artifact of options.artifacts) {
        if (artifact.descriptor !== null) {
            const descriptor = artifact.descriptor;
            attempt(() => {
                if (!artifact.exists || artifact.preserve || artifact.path === null) return;
                if (artifact.identity === null || !removeAuthenticatedLinkSourceIfMatches(
                    artifact.path, descriptor, artifact.identity, options.relativePath
                )) {
                    // lstat also detects dangling symlinks; only ENOENT means cleanup is complete.
                    lstatFileIdentitySync(artifact.path);
                    throw new Error(`restore cleanup identity is unverified; artifact preserved at ${artifact.path}`);
                }
            });
            // A removal failure must not prevent this close or the remaining resource releases.
            attempt(() => fs.closeSync(descriptor));
        }
        if (artifact.directory && !artifact.preserve) {
            const directory = artifact.directory;
            attempt(() => removeEmptyDirectoryIfPresent(directory));
        }
    }
    attempt(() => fs.closeSync(options.parentDescriptor));
    if (failures.length > 0) {
        const errors = options.primaryFailure === undefined ? failures : [options.primaryFailure, ...failures];
        const message = errors.map((error) => error instanceof Error ? error.message : String(error)).join('; ');
        throw new AggregateError(errors, message, { cause: options.primaryFailure });
    }
}

export function replaceAuthenticatedRepoFile(
    repoRoot: string,
    relativePath: string,
    content: Buffer,
    expected: AuthenticatedRepoFileSnapshot,
    mode = 0o600
): fs.Stats {
    if (!expected.exists
        || expected.content === null
        || expected.mode === null
        || expected.identity === null) {
        throw new Error(`restore target must exist before authenticated replacement: ${relativePath}`);
    }
    const parentSnapshot = captureRepoParentSnapshot(repoRoot, relativePath, false);
    const parentTarget = openRepoParentDescriptorTarget(parentSnapshot, relativePath);
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const lockPath = `${parentTarget.targetPath}.garda-replace.lock`;
    const temporaryPath = `${parentTarget.targetPath}.garda-replace-${randomBytes(16).toString('hex')}`;
    const rollbackPath = `${parentTarget.targetPath}.garda-rollback-${randomBytes(16).toString('hex')}`;
    let lockDescriptor: number | null = null;
    let lockIdentity: fs.Stats | null = null;
    let lockExists = false;
    let temporaryDescriptor: number | null = null;
    let temporaryIdentity: fs.Stats | null = null;
    let temporaryExists = false;
    let rollbackDescriptor: number | null = null;
    let rollbackIdentity: fs.Stats | null = null;
    let rollbackExists = false;
    let displacedDirectory: string | null = null;
    let displacedPath: string | null = null;
    let displacedDescriptor: number | null = null;
    let displacedIdentity: fs.Stats | null = null;
    let displacedExists = false;
    let displacedMatchesExpected = false;
    let preserveDisplaced = false;
    let replacementCommitted = false;
    let replacementComplete = false;
    let preserveRollback = false;
    let replacementFailure: unknown;
    try {
        try {
            lockDescriptor = fs.openSync(
                lockPath,
                fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
                0o600
            );
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                throw new Error(`restore target replacement is already in progress: ${relativePath}`);
            }
            throw error;
        }
        lockExists = true;
        lockIdentity = fs.fstatSync(lockDescriptor);
        if (!lockIdentity.isFile()) {
            throw new Error(`restore replacement lock is not a regular file: ${relativePath}`);
        }
        writeDescriptorBuffer(
            lockDescriptor,
            Buffer.from(`${process.pid}:${randomBytes(16).toString('hex')}\n`, 'utf8')
        );
        fs.fsyncSync(lockDescriptor);
        const identityBeforeCommit = lstatFileIdentitySync(parentTarget.targetPath);
        if (identityBeforeCommit.isSymbolicLink()
            || !identityBeforeCommit.isFile()
            || !sameFileSnapshot(identityBeforeCommit, expected.identity)) {
            throw new Error(`restore target identity changed before replacement: ${relativePath}`);
        }

        rollbackDescriptor = fs.openSync(
            rollbackPath,
            fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
            expected.mode & 0o777
        );
        rollbackExists = true;
        rollbackIdentity = fs.fstatSync(rollbackDescriptor);
        if (!rollbackIdentity.isFile()) {
            throw new Error(`restore rollback staging target is not a regular file: ${relativePath}`);
        }
        writeDescriptorBuffer(rollbackDescriptor, expected.content);
        fs.ftruncateSync(rollbackDescriptor, expected.content.length);
        fs.fchmodSync(rollbackDescriptor, expected.mode & 0o777);
        fs.fsyncSync(rollbackDescriptor);
        const stagedRollbackIdentity = fs.fstatSync(rollbackDescriptor);
        if (!stagedRollbackIdentity.isFile()
            || !sameFileIdentity(rollbackIdentity, stagedRollbackIdentity)
            || stagedRollbackIdentity.size !== expected.content.length) {
            throw new Error(`restore rollback staging target changed while writing: ${relativePath}`);
        }
        rollbackIdentity = stagedRollbackIdentity;

        temporaryDescriptor = fs.openSync(
            temporaryPath,
            fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
            mode
        );
        temporaryExists = true;
        temporaryIdentity = fs.fstatSync(temporaryDescriptor);
        if (!temporaryIdentity.isFile()) {
            throw new Error(`restore replacement staging target is not a regular file: ${relativePath}`);
        }
        writeDescriptorBuffer(temporaryDescriptor, content);
        fs.ftruncateSync(temporaryDescriptor, content.length);
        fs.fchmodSync(temporaryDescriptor, mode);
        fs.fsyncSync(temporaryDescriptor);
        const stagedIdentity = fs.fstatSync(temporaryDescriptor);
        if (!stagedIdentity.isFile()
            || !sameFileIdentity(temporaryIdentity, stagedIdentity)
            || stagedIdentity.size !== content.length) {
            throw new Error(`restore replacement staging target changed while writing: ${relativePath}`);
        }
        temporaryIdentity = stagedIdentity;
        assertRepoParentSnapshot(parentSnapshot, relativePath);
        const currentIdentity = lstatFileIdentitySync(parentTarget.targetPath);
        if (currentIdentity.isSymbolicLink()
            || !currentIdentity.isFile()
            || !sameFileSnapshot(currentIdentity, expected.identity)) {
            throw new Error(`restore target identity changed before replacement: ${relativePath}`);
        }
        displacedDirectory = fs.mkdtempSync(
            path.join(path.dirname(parentTarget.targetPath), '.garda-replace-displaced-')
        );
        fs.chmodSync(displacedDirectory, 0o700);
        displacedPath = path.join(displacedDirectory, path.basename(parentTarget.targetPath));
        fs.renameSync(parentTarget.targetPath, displacedPath);
        displacedExists = true;
        preserveDisplaced = true;
        displacedDescriptor = fs.openSync(
            displacedPath,
            fs.constants.O_RDONLY | noFollowFlag
        );
        const displacedIdentityBeforeRead = fs.fstatSync(displacedDescriptor);
        const displacedContent = readDescriptorBuffer(
            displacedDescriptor,
            displacedIdentityBeforeRead,
            relativePath
        );
        const displacedIdentityAfterRead = fs.fstatSync(displacedDescriptor);
        displacedIdentity = displacedIdentityAfterRead;
        displacedMatchesExpected = displacedIdentityBeforeRead.isFile()
            && sameFileIdentity(displacedIdentityBeforeRead, expected.identity)
            && sameFileSnapshot(displacedIdentityBeforeRead, displacedIdentityAfterRead)
            && (displacedIdentityAfterRead.mode & 0o777) === (expected.mode & 0o777)
            && displacedContent.equals(expected.content);
        if (!displacedMatchesExpected) {
            const recoveryPath = fs.realpathSync.native(displacedPath);
            throw new Error(
                `restore target identity changed during replacement; replacement preserved at ${recoveryPath}`
            );
        }
        preserveDisplaced = false;
        try {
            const linkedIdentity = linkAuthenticatedSourceNoClobber(
                parentTarget,
                temporaryPath,
                temporaryDescriptor,
                temporaryIdentity,
                content,
                relativePath,
                'replacement staging source'
            );
            temporaryIdentity = linkedIdentity;
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                preserveDisplaced = true;
                const recoveryPath = fs.realpathSync.native(displacedPath);
                throw new Error(
                    `restore target appeared during replacement; authenticated preimage preserved at ${recoveryPath}`
                );
            }
            throw error;
        }
        replacementCommitted = true;
        fsyncRepoParentDescriptor(parentTarget.descriptor);
        const replacedIdentity = lstatFileIdentitySync(parentTarget.targetPath);
        if (!replacedIdentity.isFile()
            || !sameFileIdentity(stagedIdentity, replacedIdentity)
            || replacedIdentity.size !== content.length) {
            throw new Error(`restore target changed during atomic replacement: ${relativePath}`);
        }
        if (!removeAuthenticatedLinkSourceIfMatches(
            temporaryPath,
            temporaryDescriptor,
            temporaryIdentity,
            relativePath
        )) {
            throw new Error(`restore replacement staging source changed before cleanup: ${relativePath}`);
        }
        temporaryExists = false;
        fs.closeSync(temporaryDescriptor);
        temporaryDescriptor = null;
        if (!removeAuthenticatedLinkSourceIfMatches(
            displacedPath,
            displacedDescriptor,
            displacedIdentity,
            relativePath
        )) {
            throw new Error(`restore displaced preimage source changed before cleanup: ${relativePath}`);
        }
        displacedExists = false;
        fs.closeSync(displacedDescriptor);
        displacedDescriptor = null;
        removeEmptyDirectoryIfPresent(displacedDirectory);
        displacedDirectory = null;
        assertRepoParentSnapshot(parentSnapshot, relativePath);
        if (!removeAuthenticatedLinkSourceIfMatches(
            lockPath,
            lockDescriptor,
            lockIdentity,
            relativePath
        )) {
            throw new Error(`restore replacement lock changed before release: ${relativePath}`);
        }
        lockExists = false;
        fs.closeSync(lockDescriptor);
        lockDescriptor = null;
        if (!removeAuthenticatedLinkSourceIfMatches(
            rollbackPath,
            rollbackDescriptor,
            rollbackIdentity,
            relativePath
        )) {
            throw new Error(`restore rollback staging target changed before cleanup: ${relativePath}`);
        }
        rollbackExists = false;
        fs.closeSync(rollbackDescriptor);
        rollbackDescriptor = null;
        replacementComplete = true;
        return replacedIdentity;
    } catch (error: unknown) {
        replacementFailure = error;
        if (!replacementCommitted
            && displacedExists
            && displacedMatchesExpected
            && displacedPath !== null
            && displacedIdentity !== null
            && displacedDescriptor !== null) {
            try {
                linkAuthenticatedSourceNoClobber(
                    parentTarget,
                    displacedPath,
                    displacedDescriptor,
                    displacedIdentity,
                    expected.content,
                    relativePath,
                    'displaced preimage source'
                );
                if (!removeAuthenticatedLinkSourceIfMatches(
                    displacedPath,
                    displacedDescriptor,
                    displacedIdentity,
                    relativePath
                )) {
                    throw new Error(
                        `restore displaced preimage source changed before compensation cleanup: ${relativePath}`
                    );
                }
                displacedExists = false;
                fs.closeSync(displacedDescriptor);
                displacedDescriptor = null;
                if (displacedDirectory !== null) {
                    removeEmptyDirectoryIfPresent(displacedDirectory);
                    displacedDirectory = null;
                }
                fsyncRepoParentDescriptor(parentTarget.descriptor);
            } catch (compensationError: unknown) {
                preserveDisplaced = displacedExists
                    && displacedDescriptor !== null
                    && authenticatedLinkSourcePathMatches(
                        displacedPath,
                        displacedDescriptor,
                        displacedIdentity,
                        expected.content,
                        relativePath,
                        'displaced preimage source'
                    );
                preserveRollback = rollbackExists
                    && rollbackDescriptor !== null
                    && rollbackIdentity !== null
                    && authenticatedLinkSourcePathMatches(
                        rollbackPath,
                        rollbackDescriptor,
                        rollbackIdentity,
                        expected.content,
                        relativePath,
                        'rollback staging source'
                    );
                const originalMessage = error instanceof Error ? error.message : String(error);
                const compensationMessage = compensationError instanceof Error
                    ? compensationError.message
                    : String(compensationError);
                let recoverySuffix = '';
                if (preserveDisplaced && displacedPath !== null) {
                    try {
                        recoverySuffix = `; authenticated preimage preserved at ${fs.realpathSync.native(displacedPath)}`;
                    } catch {
                        recoverySuffix = '; authenticated preimage quarantine was preserved';
                    }
                } else if (preserveRollback) {
                    try {
                        recoverySuffix = `; rollback preserved at ${fs.realpathSync.native(rollbackPath)}`;
                    } catch {
                        recoverySuffix = '; authenticated rollback staging artifact was preserved';
                    }
                }
                replacementFailure = new Error(
                    `${originalMessage}; pre-commit replacement compensation also failed: ${compensationMessage}${recoverySuffix}`
                );
                throw replacementFailure;
            }
        }
        if (replacementCommitted
            && !replacementComplete
            && rollbackExists
            && rollbackIdentity !== null
            && rollbackDescriptor !== null
            && temporaryIdentity !== null) {
            try {
                let committedDescriptor: number | null = null;
                try {
                    committedDescriptor = fs.openSync(
                        parentTarget.targetPath,
                        fs.constants.O_RDONLY | noFollowFlag
                    );
                    const committedIdentity = fs.fstatSync(committedDescriptor);
                    if (!committedIdentity.isFile()
                        || !sameFileIdentity(temporaryIdentity, committedIdentity)
                        || !unlinkTargetBoundToOpenedParent(
                            parentTarget,
                            relativePath,
                            temporaryIdentity,
                            committedDescriptor,
                            false
                        )) {
                        throw new Error(
                            `restore target changed before atomic replacement compensation: ${relativePath}`
                        );
                    }
                } catch (openError: unknown) {
                    if ((openError as NodeJS.ErrnoException).code !== 'ENOENT') {
                        throw openError;
                    }
                } finally {
                    if (committedDescriptor !== null) {
                        fs.closeSync(committedDescriptor);
                    }
                }
                linkAuthenticatedSourceNoClobber(
                    parentTarget,
                    rollbackPath,
                    rollbackDescriptor,
                    rollbackIdentity,
                    expected.content,
                    relativePath,
                    'rollback staging source'
                );
                fsyncRepoParentDescriptor(parentTarget.descriptor);
                const restoredIdentity = lstatFileIdentitySync(parentTarget.targetPath);
                if (!restoredIdentity.isFile()
                    || !sameFileIdentity(rollbackIdentity, restoredIdentity)
                    || restoredIdentity.size !== expected.content.length) {
                    throw new Error(
                        `restore target changed during atomic replacement compensation: ${relativePath}`
                    );
                }
                if (!removeAuthenticatedLinkSourceIfMatches(
                    rollbackPath,
                    rollbackDescriptor,
                    rollbackIdentity,
                    relativePath
                )) {
                    throw new Error(
                        `restore rollback staging source changed before compensation cleanup: ${relativePath}`
                    );
                }
                rollbackExists = false;
                fs.closeSync(rollbackDescriptor);
                rollbackDescriptor = null;
                if (displacedExists
                    && displacedPath !== null
                    && displacedIdentity !== null) {
                    if (displacedDescriptor === null
                        || !removeAuthenticatedLinkSourceIfMatches(
                            displacedPath,
                            displacedDescriptor,
                            displacedIdentity,
                            relativePath
                        )) {
                        throw new Error(
                            `restore displaced target changed during atomic replacement compensation: ${relativePath}`
                        );
                    }
                    displacedExists = false;
                    fs.closeSync(displacedDescriptor);
                    displacedDescriptor = null;
                    if (displacedDirectory !== null) {
                        removeEmptyDirectoryIfPresent(displacedDirectory);
                        displacedDirectory = null;
                    }
                }
            } catch (compensationError: unknown) {
                preserveRollback = rollbackExists
                    && rollbackDescriptor !== null
                    && rollbackIdentity !== null
                    && authenticatedLinkSourcePathMatches(
                        rollbackPath,
                        rollbackDescriptor,
                        rollbackIdentity,
                        expected.content,
                        relativePath,
                        'rollback staging source'
                    );
                preserveDisplaced = displacedExists
                    && displacedPath !== null
                    && displacedIdentity !== null
                    && displacedDescriptor !== null
                    && authenticatedLinkSourcePathMatches(
                        displacedPath,
                        displacedDescriptor,
                        displacedIdentity,
                        expected.content,
                        relativePath,
                        'displaced preimage source'
                    );
                const originalMessage = error instanceof Error ? error.message : String(error);
                const compensationMessage = compensationError instanceof Error
                    ? compensationError.message
                    : String(compensationError);
                let recoverySuffix = '';
                if (preserveRollback) {
                    try {
                        recoverySuffix = `; rollback preserved at ${fs.realpathSync.native(rollbackPath)}`;
                    } catch {
                        recoverySuffix = '; rollback staging artifact was preserved';
                    }
                } else if (preserveDisplaced && displacedPath !== null) {
                    try {
                        recoverySuffix = `; authenticated preimage preserved at ${fs.realpathSync.native(displacedPath)}`;
                    } catch {
                        recoverySuffix = '; authenticated preimage quarantine was preserved';
                    }
                }
                replacementFailure = new Error(
                    `${originalMessage}; atomic replacement compensation also failed: ${compensationMessage}${recoverySuffix}`
                );
                throw replacementFailure;
            }
        }
        throw error;
    } finally {
        cleanupReplacementResources({
            relativePath,
            parentDescriptor: parentTarget.descriptor,
            primaryFailure: replacementFailure,
            artifacts: [
                { path: temporaryPath, descriptor: temporaryDescriptor, identity: temporaryIdentity, exists: temporaryExists },
                { path: rollbackPath, descriptor: rollbackDescriptor, identity: rollbackIdentity, exists: rollbackExists, preserve: preserveRollback },
                { path: displacedPath, descriptor: displacedDescriptor, identity: displacedIdentity, exists: displacedExists, preserve: preserveDisplaced, directory: displacedDirectory },
                { path: lockPath, descriptor: lockDescriptor, identity: lockIdentity, exists: lockExists }
            ]
        });
    }
}

function removeRepoRegularFile(
    repoRoot: string,
    relativePath: string,
    expectedExistingIdentity: fs.Stats | null,
    onMutated: (identity: fs.Stats) => void
): boolean {
    let parentSnapshot: RepoParentSnapshot;
    try {
        parentSnapshot = captureRepoParentSnapshot(repoRoot, relativePath, false);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
    let identity: fs.Stats;
    try {
        identity = lstatFileIdentitySync(parentSnapshot.targetPath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            assertRepoParentSnapshot(parentSnapshot, relativePath);
            if (expectedExistingIdentity !== null) {
                throw new Error(`restore target disappeared before removal: ${relativePath}`);
            }
            return false;
        }
        throw error;
    }
    if (identity.isSymbolicLink() || !identity.isFile()) {
        throw new Error(`restore target must remain a regular file before removal: ${relativePath}`);
    }
    if (expectedExistingIdentity === null
        || !sameFileSnapshot(identity, expectedExistingIdentity)) {
        throw new Error(`restore target identity changed before removal: ${relativePath}`);
    }
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const descriptor = fs.openSync(parentSnapshot.targetPath, fs.constants.O_RDONLY | noFollowFlag);
    try {
        const openedIdentity = fs.fstatSync(descriptor);
        if (!openedIdentity.isFile()
            || !sameFileSnapshot(identity, openedIdentity)
            || !sameFileSnapshot(expectedExistingIdentity, openedIdentity)) {
            throw new Error(`restore target identity changed before removal: ${relativePath}`);
        }
        assertRepoTargetBound(parentSnapshot, relativePath, openedIdentity);
        onMutated(openedIdentity);
        if (!unlinkRepoTargetBoundToDescriptor(
            parentSnapshot,
            relativePath,
            expectedExistingIdentity,
            descriptor,
            true
        )) {
            throw new Error(`restore target identity changed before removal: ${relativePath}`);
        }
        return true;
    } finally {
        fs.closeSync(descriptor);
    }
}

export function readAuthenticatedRepoFileSnapshot(
    repoRoot: string,
    relativePath: string,
    maxBytes?: number
): AuthenticatedRepoFileSnapshot {
    let parentSnapshot: RepoParentSnapshot;
    try {
        parentSnapshot = captureRepoParentSnapshot(repoRoot, relativePath, false);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { exists: false, content: null, mode: null, identity: null };
        }
        throw error;
    }
    let identityBeforeOpen: fs.Stats;
    try {
        identityBeforeOpen = lstatFileIdentitySync(parentSnapshot.targetPath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
        assertRepoParentSnapshot(parentSnapshot, relativePath);
        try {
            lstatFileIdentitySync(parentSnapshot.targetPath);
            throw new Error(`restore target appeared while authenticating absence: ${relativePath}`);
        } catch (finalError: unknown) {
            if ((finalError as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw finalError;
            }
        }
        return { exists: false, content: null, mode: null, identity: null };
    }
    if (identityBeforeOpen.isSymbolicLink() || !identityBeforeOpen.isFile()) {
        throw new Error(`restored path must be a regular file without symlink indirection: ${relativePath}`);
    }
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(parentSnapshot.targetPath, fs.constants.O_RDONLY | noFollowFlag);
        const openedIdentity = fs.fstatSync(descriptor);
        if (!openedIdentity.isFile() || !sameFileIdentity(identityBeforeOpen, openedIdentity)) {
            throw new Error(`restore target identity changed while opening: ${relativePath}`);
        }
        if (maxBytes !== undefined
            && (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || openedIdentity.size > maxBytes)) {
            throw new Error(`restore target exceeds the ${maxBytes}-byte limit: ${relativePath}`);
        }
        assertRepoTargetBound(parentSnapshot, relativePath, openedIdentity);
        const content = readDescriptorBuffer(descriptor, openedIdentity, relativePath);
        const identityAfterRead = fs.fstatSync(descriptor);
        if (!sameFileSnapshot(openedIdentity, identityAfterRead)) {
            throw new Error(`restore target changed while reading: ${relativePath}`);
        }
        assertRepoTargetBound(parentSnapshot, relativePath, identityAfterRead);
        return {
            exists: true,
            content,
            mode: identityAfterRead.mode,
            identity: identityAfterRead
        };
    } finally {
        if (descriptor !== null) {
            fs.closeSync(descriptor);
        }
    }
}

function removeFileIfExists(filePath: string): void {
    try {
        const stat = lstatFileIdentitySync(filePath);
        if (!stat.isSymbolicLink() && stat.isFile()) {
            fs.unlinkSync(filePath);
        }
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

export function hasPatchContent(patch: SplitRequiredWipPatchEvidence): boolean {
    return patch.bytes > 0 && !patch.empty;
}

export function normalizeSelectedPaths(paths: readonly string[]): Set<string> {
    return new Set(paths.map((entry) => normalizeGitPath(entry)).filter(Boolean));
}

export function selectedFiles<T extends { path: string }>(
    entries: readonly T[],
    selectedPaths: Set<string>
): T[] {
    if (selectedPaths.size === 0) {
        return [...entries];
    }
    return entries.filter((entry) => selectedPaths.has(normalizeGitPath(entry.path)));
}

export function buildGitApplyIncludeArgs(selectedPaths: Set<string>): string[] {
    if (selectedPaths.size === 0) {
        return [];
    }
    return [...selectedPaths]
        .sort()
        .map((entry) => `--include=${entry.replace(/([\\*?\[\]])/gu, '\\$1')}`);
}

export function runGitStatus(
    repoRoot: string,
    args: string[],
    environment: NodeJS.ProcessEnv = process.env,
    input?: string | Buffer
): {
    status: number;
    stdout: string;
    stderr: string;
} {
    const result = childProcess.spawnSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        env: environment,
        input,
        maxBuffer: GIT_RESTORE_MAX_BUFFER_BYTES,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        timeout: GIT_RESTORE_COMMAND_TIMEOUT_MS
    });
    return {
        status: result.status ?? -1,
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || '')
    };
}

function gitEnvironment(indexPath: string, worktreePath?: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        GIT_INDEX_FILE: indexPath,
        ...(worktreePath ? { GIT_WORK_TREE: worktreePath } : {})
    };
}

export function gitFailureMessage(
    args: string[],
    result: { stdout: string; stderr: string }
): string {
    return `git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim() || 'unknown git error'}`;
}

function currentIndexPath(repoRoot: string): string {
    const gitPath = runGit(
        repoRoot,
        ['rev-parse', '--git-path', 'index'],
        { timeoutMs: GIT_RESTORE_COMMAND_TIMEOUT_MS }
    ).trim();
    return path.isAbsolute(gitPath) ? path.resolve(gitPath) : path.resolve(repoRoot, gitPath);
}

function writeIndexTree(repoRoot: string, indexPath: string): string {
    const args = ['write-tree'];
    const result = runGitStatus(repoRoot, args, gitEnvironment(indexPath));
    if (result.status !== 0) {
        throw new Error(gitFailureMessage(args, result));
    }
    const treeObjectId = result.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/iu.test(treeObjectId)) {
        throw new Error('git write-tree returned malformed tree evidence.');
    }
    return treeObjectId;
}

interface UnmergedIndexEntry {
    mode: string;
    objectId: string;
    stage: 1 | 2 | 3;
}

interface IndexSnapshot {
    treeObjectId: string;
    unmergedEntries: Map<string, UnmergedIndexEntry[]>;
}

interface SelectedIndexState {
    entries: Map<string, GitTreeEntry>;
    unmergedPaths: Set<string>;
}

function readUnmergedIndexEntries(repoRoot: string, indexPath: string): Map<string, UnmergedIndexEntry[]> {
    const args = ['ls-files', '--unmerged', '--stage', '-z'];
    const result = runGitStatus(repoRoot, args, gitEnvironment(indexPath));
    if (result.status !== 0) {
        throw new Error(gitFailureMessage(args, result));
    }
    const entries = new Map<string, UnmergedIndexEntry[]>();
    for (const record of result.stdout.split('\0')) {
        if (!record) continue;
        const separatorIndex = record.indexOf('\t');
        const metadata = separatorIndex >= 0 ? record.slice(0, separatorIndex).split(' ') : [];
        const relativePath = separatorIndex >= 0 ? normalizeGitPath(record.slice(separatorIndex + 1)) : '';
        const [mode, objectId, stageText] = metadata;
        if (!/^[0-7]{6}$/u.test(mode || '')
            || !/^[0-9a-f]{40,64}$/iu.test(objectId || '')
            || !/^[123]$/u.test(stageText || '')
            || !relativePath) {
            throw new Error('git ls-files returned malformed unmerged index evidence.');
        }
        const pathEntries = entries.get(relativePath) || [];
        pathEntries.push({
            mode,
            objectId,
            stage: Number(stageText) as 1 | 2 | 3
        });
        entries.set(relativePath, pathEntries);
    }
    for (const pathEntries of entries.values()) {
        pathEntries.sort((left, right) => left.stage - right.stage);
    }
    return entries;
}

function snapshotIndex(repoRoot: string, indexPath: string): IndexSnapshot {
    try {
        return {
            treeObjectId: writeIndexTree(repoRoot, indexPath),
            unmergedEntries: new Map()
        };
    } catch (writeTreeError: unknown) {
        const unmergedEntries = readUnmergedIndexEntries(repoRoot, indexPath);
        if (unmergedEntries.size === 0) {
            throw writeTreeError;
        }
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-index-snapshot-'));
        const snapshotIndexPath = path.join(tempRoot, 'index');
        try {
            fs.copyFileSync(indexPath, snapshotIndexPath);
            const objectIdLength = [...unmergedEntries.values()][0][0].objectId.length;
            const zeroObjectId = '0'.repeat(objectIdLength);
            const removalInput = [...unmergedEntries.keys()]
                .sort()
                .map((relativePath) => `0 ${zeroObjectId}\t${relativePath}\0`)
                .join('');
            const removeArgs = ['update-index', '-z', '--index-info'];
            const removed = runGitStatus(
                repoRoot,
                removeArgs,
                gitEnvironment(snapshotIndexPath),
                Buffer.from(removalInput, 'utf8')
            );
            if (removed.status !== 0) {
                throw new Error(gitFailureMessage(removeArgs, removed));
            }
            return {
                treeObjectId: writeIndexTree(repoRoot, snapshotIndexPath),
                unmergedEntries
            };
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    }
}

function selectedIndexState(
    repoRoot: string,
    indexPath: string,
    selectedPaths: Iterable<string>
): SelectedIndexState {
    const normalizedPaths = [...new Set([...selectedPaths].map(normalizeGitPath).filter(Boolean))];
    const snapshot = snapshotIndex(repoRoot, indexPath);
    return {
        entries: readGitTreeEntriesForPaths(repoRoot, snapshot.treeObjectId, normalizedPaths),
        unmergedPaths: new Set(normalizedPaths.filter((relativePath) => snapshot.unmergedEntries.has(relativePath)))
    };
}

function selectedIndexEntries(
    repoRoot: string,
    indexPath: string,
    selectedPaths: Iterable<string>
): Map<string, GitTreeEntry> {
    return selectedIndexState(repoRoot, indexPath, selectedPaths).entries;
}

function fileStateSha256(filePath: string): string | null {
    let stat: fs.Stats;
    try {
        stat = lstatFileIdentitySync(filePath);
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return null;
        }
        throw error;
    }
    if (!stat.isFile()) {
        return `non-file:${stat.mode}`;
    }
    return sha256FileRequired(filePath);
}

function selectedTargetState(repoRoot: string, selectedPaths: Set<string>): Map<string, string | null> {
    return new Map([...selectedPaths].map((relativePath) => [
        relativePath,
        fileStateSha256(resolveRepoPath(repoRoot, relativePath))
    ]));
}

export function validateTrackedTargetObstructions(
    repoRoot: string,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[]
): string[] {
    try {
        const selectedPaths = selectedTrackedFiles.map((entry) => normalizeGitPath(entry.path));
        const currentIndexState = selectedIndexState(repoRoot, currentIndexPath(repoRoot), selectedPaths);
        return selectedPaths
            .filter((relativePath) => fileStateSha256(resolveRepoPath(repoRoot, relativePath)) !== null)
            .filter((relativePath) => (
                !currentIndexState.entries.has(relativePath)
                && !currentIndexState.unmergedPaths.has(relativePath)
            ))
            .sort()
            .map((relativePath) => `selected tracked restore target has an untracked obstruction: ${relativePath}`);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`failed to inspect selected restore targets in the current index: ${message}`];
    }
}

function unauthorizedIndexChanges(
    repoRoot: string,
    beforeIndexPath: string,
    afterIndexPath: string,
    selectedPaths: Set<string>
): string[] {
    const beforeSnapshot = snapshotIndex(repoRoot, beforeIndexPath);
    const afterSnapshot = snapshotIndex(repoRoot, afterIndexPath);
    const unauthorized = new Set<string>();
    const unmergedPaths = new Set([
        ...beforeSnapshot.unmergedEntries.keys(),
        ...afterSnapshot.unmergedEntries.keys()
    ]);
    for (const relativePath of unmergedPaths) {
        const beforeEntries = beforeSnapshot.unmergedEntries.get(relativePath) || [];
        const afterEntries = afterSnapshot.unmergedEntries.get(relativePath) || [];
        if (!selectedPaths.has(relativePath)
            && JSON.stringify(beforeEntries) !== JSON.stringify(afterEntries)) {
            unauthorized.add(relativePath);
        }
    }
    const args = [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '--no-renames',
        '-r',
        '-z',
        beforeSnapshot.treeObjectId,
        afterSnapshot.treeObjectId
    ];
    const result = runGitStatus(repoRoot, args);
    if (result.status !== 0) {
        throw new Error(gitFailureMessage(args, result));
    }
    for (const relativePath of result.stdout.split('\0')
        .map(normalizeGitPath)
        .filter(Boolean)
        .filter((entry) => !selectedPaths.has(entry))) {
        unauthorized.add(relativePath);
    }
    return [...unauthorized].sort();
}

function trackedDiffPaths(repoRoot: string, cached: boolean): string[] {
    const args = ['diff', '--name-only', '--no-renames', '-z', ...(cached ? ['--cached'] : [])];
    const result = runGitStatus(repoRoot, args);
    if (result.status !== 0) {
        throw new Error(gitFailureMessage(args, result));
    }
    return result.stdout
        .split('\0')
        .map(normalizeGitPath)
        .filter(Boolean);
}

function indexEntriesEqual(
    left: GitTreeEntry | undefined,
    right: GitTreeEntry | undefined
): boolean {
    return JSON.stringify(left || null) === JSON.stringify(right || null);
}

export function validateSequentialRestoreWorkspace(
    repoRoot: string,
    manifest: SplitRequiredWipManifest
): string[] {
    const violations: string[] = [];
    let unstagedPaths: string[];
    let stagedPaths: string[];
    try {
        unstagedPaths = trackedDiffPaths(repoRoot, false);
        stagedPaths = trackedDiffPaths(repoRoot, true);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`failed to inspect tracked workspace changes: ${message}`];
    }

    const manifestEntries = new Map(manifest.tracked_files.map((entry) => [
        normalizeGitPath(entry.path),
        entry
    ]));
    const unauthorizedUnstaged = unstagedPaths.filter((relativePath) => !manifestEntries.has(relativePath));
    const unauthorizedStaged = stagedPaths.filter((relativePath) => !manifestEntries.has(relativePath));
    if (unauthorizedUnstaged.length > 0) {
        violations.push(`unstaged tracked changes exist: ${unauthorizedUnstaged.join(', ')}`);
    }
    if (unauthorizedStaged.length > 0) {
        violations.push(`staged changes exist: ${unauthorizedStaged.join(', ')}`);
    }

    const restoredPaths = new Set([...unstagedPaths, ...stagedPaths]
        .filter((relativePath) => manifestEntries.has(relativePath)));
    if (restoredPaths.size === 0) {
        return violations;
    }

    for (const relativePath of [...restoredPaths].sort()) {
        const expected = manifestEntries.get(relativePath);
        const actualSha256 = fileStateSha256(resolveRepoPath(repoRoot, relativePath));
        if (actualSha256 !== expected?.worktree_sha256) {
            violations.push(`previously restored tracked file differs from captured WIP: ${relativePath}`);
        }
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-sequential-restore-'));
    const expectedIndexPath = path.join(tempRoot, 'index');
    try {
        const readTreeArgs = ['read-tree', manifest.base_commit];
        const readTree = runGitStatus(repoRoot, readTreeArgs, gitEnvironment(expectedIndexPath));
        if (readTree.status !== 0) {
            throw new Error(gitFailureMessage(readTreeArgs, readTree));
        }
        if (hasPatchContent(manifest.patches.staged)) {
            const stagedPatchPath = resolveInputPathInsideRepo(
                repoRoot,
                manifest.patches.staged.path,
                'staged patch'
            );
            const applyArgs = [
                'apply',
                '--cached',
                ...buildGitApplyIncludeArgs(restoredPaths),
                stagedPatchPath
            ];
            const applied = runGitStatus(repoRoot, applyArgs, gitEnvironment(expectedIndexPath));
            if (applied.status !== 0) {
                throw new Error(gitFailureMessage(applyArgs, applied));
            }
        }
        const currentState = selectedIndexState(repoRoot, currentIndexPath(repoRoot), restoredPaths);
        const expectedState = selectedIndexState(repoRoot, expectedIndexPath, restoredPaths);
        for (const relativePath of [...restoredPaths].sort()) {
            if (currentState.unmergedPaths.has(relativePath)
                || !indexEntriesEqual(
                    currentState.entries.get(relativePath),
                    expectedState.entries.get(relativePath)
                )) {
                violations.push(`previously restored tracked file index differs from captured WIP: ${relativePath}`);
            }
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`failed to validate previously restored tracked files: ${message}`);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    return violations;
}

export function validateSelectedTargetsClean(repoRoot: string, selectedPaths: Set<string>): string[] {
    if (selectedPaths.size === 0) {
        return [];
    }
    const violations: string[] = [];
    const dirtyPaths = new Set<string>();
    const normalizedPaths = new Set([...selectedPaths].map(normalizeGitPath));
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-selected-index-'));
    const selectedIndexPath = path.join(tempRoot, 'index');
    try {
        const currentIndexState = selectedIndexState(repoRoot, currentIndexPath(repoRoot), normalizedPaths);
        const currentEntries = currentIndexState.entries;
        const headEntries = readGitTreeEntriesForPaths(repoRoot, getHeadCommit(repoRoot), normalizedPaths);
        for (const relativePath of normalizedPaths) {
            if (currentIndexState.unmergedPaths.has(relativePath)
                || JSON.stringify(currentEntries.get(relativePath) || null) !== JSON.stringify(headEntries.get(relativePath) || null)) {
                dirtyPaths.add(relativePath);
            }
        }

        const emptyArgs = ['read-tree', '--empty'];
        const emptyIndex = runGitStatus(repoRoot, emptyArgs, gitEnvironment(selectedIndexPath));
        if (emptyIndex.status !== 0) {
            throw new Error(gitFailureMessage(emptyArgs, emptyIndex));
        }
        if (currentEntries.size > 0) {
            const indexInfo = [...currentEntries]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([relativePath, entry]) => `${entry.mode} ${entry.objectId}\t${relativePath}\0`)
                .join('');
            const updateArgs = ['update-index', '-z', '--index-info'];
            const updated = runGitStatus(
                repoRoot,
                updateArgs,
                gitEnvironment(selectedIndexPath),
                Buffer.from(indexInfo, 'utf8')
            );
            if (updated.status !== 0) {
                throw new Error(gitFailureMessage(updateArgs, updated));
            }
        }
        const refreshArgs = ['update-index', '--refresh'];
        const refreshed = runGitStatus(repoRoot, refreshArgs, gitEnvironment(selectedIndexPath));
        if (refreshed.status !== 0 && refreshed.status !== 1) {
            throw new Error(gitFailureMessage(refreshArgs, refreshed));
        }
        const diffArgs = ['diff-files', '--name-only', '--no-renames', '-z'];
        const diff = runGitStatus(repoRoot, diffArgs, gitEnvironment(selectedIndexPath));
        if (diff.status !== 0) {
            throw new Error(gitFailureMessage(diffArgs, diff));
        }
        for (const entry of diff.stdout.split('\0')) {
            if (entry) dirtyPaths.add(normalizeGitPath(entry));
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`failed to inspect selected restore targets: ${message}`);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    for (const relativePath of [...normalizedPaths].sort()) {
        if (dirtyPaths.has(relativePath)) {
            violations.push(`selected restore target is dirty: ${relativePath}`);
        }
    }
    return violations;
}

export function validateNoSymlinkPaths(repoRoot: string, relativePaths: Iterable<string>): string[] {
    const violations: string[] = [];
    const root = path.resolve(repoRoot);
    const normalizedPaths = [...new Set([...relativePaths].map(normalizeGitPath))].sort();
    for (const relativePath of normalizedPaths) {
        const target = resolveRepoPath(root, relativePath);
        let cursor = target;
        while (cursor !== root) {
            try {
                if (lstatFileIdentitySync(cursor).isSymbolicLink()) {
                    violations.push(`selected restore path contains a symbolic link: ${relativePath}`);
                    break;
                }
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
            cursor = path.dirname(cursor);
        }
    }
    if (normalizedPaths.length === 0) {
        return violations;
    }
    let headEntries: ReadonlyMap<string, GitTreeEntry>;
    try {
        headEntries = readGitTreeEntriesForPaths(repoRoot, 'HEAD', normalizedPaths);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`failed to inspect selected restore targets in HEAD: ${message}`);
        return violations;
    }
    for (const relativePath of normalizedPaths) {
        if (headEntries.get(relativePath)?.mode === '120000') {
            violations.push(`selected restore target is a symbolic link in HEAD: ${relativePath}`);
        }
    }
    return violations;
}

export function validateNoSymlinkPath(repoRoot: string, relativePath: string): string[] {
    return validateNoSymlinkPaths(repoRoot, [relativePath]);
}

export function validateAdvancedManifestBlobs(
    repoRoot: string,
    manifest: SplitRequiredWipManifest,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[]
): string[] {
    const violations: string[] = [];
    if (selectedTrackedFiles.length === 0) {
        const commitCheck = runGitStatus(repoRoot, ['cat-file', '-e', `${manifest.base_commit}^{commit}`]);
        return commitCheck.status === 0
            ? []
            : [`manifest base commit is missing or invalid: ${manifest.base_commit}`];
    }

    let baseEntries: ReadonlyMap<string, GitTreeEntry>;
    try {
        baseEntries = readGitTreeEntriesForPaths(
            repoRoot,
            manifest.base_commit,
            selectedTrackedFiles.map((entry) => entry.path)
        );
    } catch {
        return [`manifest base commit is missing or invalid: ${manifest.base_commit}`];
    }

    const expectedObjectIds = [...new Set(
        selectedTrackedFiles
            .map((entry) => entry.head_sha256)
            .filter((objectId): objectId is string => Boolean(objectId))
    )].sort();
    const objectTypes = new Map<string, string>();
    if (expectedObjectIds.length > 0) {
        const args = ['cat-file', '--batch-check=%(objectname) %(objecttype)'];
        const checked = runGitStatus(
            repoRoot,
            args,
            process.env,
            `${expectedObjectIds.join('\n')}\n`
        );
        if (checked.status !== 0) {
            return [gitFailureMessage(args, checked)];
        }
        for (const line of checked.stdout.split(/\r?\n/gu)) {
            const [objectId, objectType] = line.trim().split(/\s+/u);
            if (objectId && objectType) {
                objectTypes.set(objectId, objectType);
            }
        }
    }

    for (const entry of selectedTrackedFiles) {
        const normalizedPath = normalizeGitPath(entry.path);
        const baseEntry = baseEntries.get(normalizedPath);
        if (!entry.head_sha256) {
            if (baseEntry) {
                violations.push(`manifest base blob evidence is missing for tracked path: ${entry.path}`);
            }
            continue;
        }
        if (objectTypes.get(entry.head_sha256) !== 'blob') {
            violations.push(`manifest base blob is missing: path=${entry.path}; blob=${entry.head_sha256}`);
            continue;
        }
        if (baseEntry?.type !== 'blob' || baseEntry.objectId !== entry.head_sha256) {
            violations.push(`manifest base blob does not match base commit: path=${entry.path}; blob=${entry.head_sha256}`);
        }
    }
    return violations;
}

interface RestorePlanWorkspace {
    tempRoot: string;
    indexPath: string;
    candidateIndexPath: string;
    unstagedIndexPath: string;
    candidateWorktreeRoot: string;
}

function createRestorePlanWorkspace(repoRoot: string): RestorePlanWorkspace {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-wip-restore-'));
    return {
        tempRoot,
        indexPath: currentIndexPath(repoRoot),
        candidateIndexPath: path.join(tempRoot, 'candidate.index'),
        unstagedIndexPath: path.join(tempRoot, 'unstaged.index'),
        candidateWorktreeRoot: path.join(tempRoot, 'worktree')
    };
}

function applyPatchToCandidateIndex(params: {
    repoRoot: string;
    patch: SplitRequiredWipPatchEvidence;
    label: 'staged' | 'unstaged';
    beforeIndexPath: string;
    targetIndexPath: string;
    includeArgs: string[];
    selectedPaths: Set<string>;
    patchContent?: Buffer;
}): string | null {
    if (!hasPatchContent(params.patch)) {
        return null;
    }
    const useSnapshot = params.patchContent !== undefined;
    const args = ['apply', '--3way', '--cached', ...params.includeArgs, useSnapshot ? '-' : params.patch.path];
    const applied = runGitStatus(
        params.repoRoot,
        args,
        gitEnvironment(params.targetIndexPath),
        params.patchContent
    );
    if (applied.status !== 0) {
        return gitFailureMessage(args, applied);
    }
    const unauthorized = unauthorizedIndexChanges(
        params.repoRoot,
        params.beforeIndexPath,
        params.targetIndexPath,
        params.selectedPaths
    );
    return unauthorized.length > 0
        ? `${params.label} patch changed unauthorized paths: ${unauthorized.join(', ')}`
        : null;
}

function buildCandidateIndexes(
    repoRoot: string,
    workspace: RestorePlanWorkspace,
    manifest: SplitRequiredWipManifest,
    selectedPaths: Set<string>,
    artifactSnapshots?: SplitRequiredWipRestoreArtifactSnapshots
): string | null {
    const includeArgs = buildGitApplyIncludeArgs(selectedPaths);
    fs.copyFileSync(workspace.indexPath, workspace.candidateIndexPath);
    const stagedFailure = applyPatchToCandidateIndex({
        repoRoot,
        patch: manifest.patches.staged,
        label: 'staged',
        beforeIndexPath: workspace.indexPath,
        targetIndexPath: workspace.candidateIndexPath,
        includeArgs,
        selectedPaths,
        patchContent: artifactSnapshots?.patches.staged
    });
    if (stagedFailure) {
        return stagedFailure;
    }
    fs.copyFileSync(workspace.candidateIndexPath, workspace.unstagedIndexPath);
    return applyPatchToCandidateIndex({
        repoRoot,
        patch: manifest.patches.unstaged,
        label: 'unstaged',
        beforeIndexPath: workspace.candidateIndexPath,
        targetIndexPath: workspace.unstagedIndexPath,
        includeArgs,
        selectedPaths,
        patchContent: artifactSnapshots?.patches.unstaged
    });
}

function materializeCandidateWorktree(
    repoRoot: string,
    workspace: RestorePlanWorkspace,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[]
): string | null {
    const environment = gitEnvironment(workspace.unstagedIndexPath);
    let indexEntries: Map<string, GitTreeEntry>;
    try {
        indexEntries = selectedIndexEntries(
            repoRoot,
            workspace.unstagedIndexPath,
            selectedTrackedFiles.map((entry) => normalizeGitPath(entry.path))
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return `failed to inspect candidate index targets: ${message}`;
    }
    const checkoutPaths: string[] = [];
    for (const entry of selectedTrackedFiles) {
        const relativePath = normalizeGitPath(entry.path);
        const stageZeroEntry = indexEntries.get(relativePath);
        if (!stageZeroEntry) {
            continue;
        }
        if (stageZeroEntry.mode === '120000') {
            return `candidate index target is a symbolic link: ${entry.path}`;
        }
        if (!stageZeroEntry.mode.startsWith('100')) {
            return `candidate index target is not a regular file: ${entry.path}`;
        }
        checkoutPaths.push(relativePath);
    }
    if (checkoutPaths.length > 0) {
        const args = [
            'checkout-index',
            '--force',
            `--prefix=${normalizePath(workspace.candidateWorktreeRoot)}/`,
            '-z',
            '--stdin'
        ];
        const checkedOut = runGitStatus(
            repoRoot,
            args,
            environment,
            Buffer.from(`${checkoutPaths.join('\0')}\0`, 'utf8')
        );
        if (checkedOut.status !== 0) {
            return gitFailureMessage(args, checkedOut);
        }
    }
    return null;
}

function validateCandidateTrackedFiles(
    workspace: RestorePlanWorkspace,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[]
): string | null {
    for (const entry of selectedTrackedFiles) {
        const candidatePath = resolveRepoPath(workspace.candidateWorktreeRoot, entry.path);
        try {
            if (lstatFileIdentitySync(candidatePath).isSymbolicLink()) {
                return `candidate restore target is a symbolic link: ${entry.path}`;
            }
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }
    return null;
}

export function planAdvancedRestore(
    repoRoot: string,
    manifest: SplitRequiredWipManifest,
    selectedPaths: Set<string>,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[],
    artifactSnapshots?: SplitRequiredWipRestoreArtifactSnapshots
): { plan: AdvancedRestorePlan | null; violations: string[] } {
    const workspace = createRestorePlanWorkspace(repoRoot);
    const fail = (message: string): { plan: null; violations: string[] } => {
        fs.rmSync(workspace.tempRoot, { recursive: true, force: true });
        return { plan: null, violations: [`three-way restore failed: ${message}`] };
    };
    try {
        fs.mkdirSync(workspace.candidateWorktreeRoot, { recursive: true });
        const failure = buildCandidateIndexes(
            repoRoot,
            workspace,
            manifest,
            selectedPaths,
            artifactSnapshots
        )
            || materializeCandidateWorktree(repoRoot, workspace, selectedTrackedFiles)
            || validateCandidateTrackedFiles(workspace, selectedTrackedFiles);
        if (failure) {
            return fail(failure);
        }
        return {
            plan: {
                tempRoot: workspace.tempRoot,
                candidateIndexPath: workspace.candidateIndexPath,
                candidateWorktreeRoot: workspace.candidateWorktreeRoot,
                currentHead: getHeadCommit(repoRoot),
                currentIndexSha256: sha256FileRequired(workspace.indexPath),
                targetSha256: selectedTargetState(repoRoot, selectedPaths)
            },
            violations: []
        };
    } catch (error: unknown) {
        return fail(error instanceof Error ? error.message : String(error));
    }
}

function replaceFileFromCandidate(
    repoRoot: string,
    relativePath: string,
    candidate: AuthenticatedRepoFileSnapshot,
    expectedExistingIdentity: fs.Stats | null,
    expectedExistingContent: Buffer | null,
    expectedExistingMode: number | null,
    onMutated: (
        identity: fs.Stats,
        removalHandle?: AuthenticatedRepoFileRemovalHandle
    ) => void,
    onCompensated: () => void
): fs.Stats {
    if (!candidate.exists || candidate.content === null || candidate.mode === null) {
        throw new Error(`candidate restore target disappeared before replacement: ${relativePath}`);
    }
    return writeRepoFileReplacingRegular(
        repoRoot,
        relativePath,
        candidate.content,
        candidate.mode & 0o777,
        onMutated,
        expectedExistingIdentity,
        true,
        expectedExistingContent,
        expectedExistingMode,
        onCompensated
    );
}

interface OriginalFileState {
    exists: boolean;
    preimage: { offset: number; bytes: number; sha256: string } | null;
    mode: number | null;
    identity: fs.Stats | null;
}

interface RestoreBackupStore {
    descriptor: number;
    identity: fs.Stats;
    bytes: number;
}

interface RestoreBackup {
    store: RestoreBackupStore;
    originalFiles: Map<string, OriginalFileState>;
    mutatedPaths: Map<string, RestoreMutationState>;
    transientPaths: Set<string>;
}

interface RestoreMutationState {
    identity: fs.Stats | null;
    stableSnapshot: boolean;
    removalHandle: AuthenticatedRepoFileRemovalHandle | null;
}

function selectedRestorePaths(
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[],
    selectedUntrackedFiles: SplitRequiredWipUntrackedFileEvidence[]
): Set<string> {
    return new Set([
        ...selectedTrackedFiles.map((entry) => normalizeGitPath(entry.path)),
        ...selectedUntrackedFiles.map((entry) => normalizeGitPath(entry.path))
    ]);
}

function validateRestorePlanFreshness(
    repoRoot: string,
    indexPath: string,
    plan: AdvancedRestorePlan,
    selectedPaths: Set<string>
): string | null {
    if (getHeadCommit(repoRoot) !== plan.currentHead
        || sha256FileRequired(indexPath) !== plan.currentIndexSha256) {
        return 'three-way restore failed: repository HEAD or index changed after validation.';
    }
    const currentTargets = selectedTargetState(repoRoot, selectedPaths);
    for (const [relativePath, expected] of plan.targetSha256) {
        if (currentTargets.get(relativePath) !== expected) {
            return `three-way restore failed: selected target changed after validation: ${relativePath}`;
        }
    }
    return null;
}

function createRestoreBackupStore(repoRoot: string): RestoreBackupStore {
    const relativePath = `.garda-restore-backup-${randomBytes(16).toString('hex')}`;
    const handle = writeExclusiveRepoFileWithRemovalHandle(repoRoot, relativePath, Buffer.alloc(0));
    let descriptor: number | null = null;
    try {
        const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
        descriptor = fs.openSync(path.join(repoRoot, relativePath), fs.constants.O_RDWR | noFollowFlag);
        const identity = fs.fstatSync(descriptor);
        if (!identity.isFile() || !sameFileSnapshot(identity, handle.identity) || identity.nlink !== 1) {
            throw new Error('restore backup identity changed before detachment');
        }
        // Detach the empty inode before storing secrets: readback and cleanup never reopen a pathname.
        handle.remove();
        handle.close();
        const detached = fs.fstatSync(descriptor);
        if (!sameFileIdentity(identity, detached) || detached.nlink !== 0 || detached.size !== 0) {
            throw new Error('restore backup could not be detached safely');
        }
        return { descriptor, identity: detached, bytes: 0 };
    } catch (error: unknown) {
        if (descriptor !== null) fs.closeSync(descriptor);
        throw error;
    } finally {
        handle.close();
    }
}

function spoolRestorePreimage(store: RestoreBackupStore, content: Buffer): NonNullable<OriginalFileState['preimage']> {
    if (!Number.isSafeInteger(store.bytes + content.length)
        || store.bytes + content.length > RESTORE_BACKUP_MAX_BYTES) {
        throw new Error(`restore backup exceeds the ${RESTORE_BACKUP_MAX_BYTES}-byte disk limit`);
    }
    const preimage = {
        offset: store.bytes,
        bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex')
    };
    let offset = 0;
    while (offset < content.length) {
        const written = fs.writeSync(
            store.descriptor, content, offset,
            Math.min(RESTORE_BACKUP_IO_CHUNK_BYTES, content.length - offset), preimage.offset + offset
        );
        if (written <= 0) throw new Error('restore backup write made no forward progress');
        offset += written;
    }
    store.bytes += content.length;
    return preimage;
}

function readRestorePreimage(store: RestoreBackupStore, original: OriginalFileState, relativePath: string): Buffer | null {
    if (!original.exists) return null;
    const preimage = original.preimage;
    if (preimage === null) throw new Error(`restore rollback snapshot is missing bytes: ${relativePath}`);
    const before = fs.fstatSync(store.descriptor);
    if (!sameFileSnapshot(before, store.identity) || before.nlink !== 0 || before.size !== store.bytes) {
        throw new Error(`restore backup identity changed before readback: ${relativePath}`);
    }
    const content = Buffer.alloc(preimage.bytes);
    let offset = 0;
    while (offset < content.length) {
        const bytesRead = fs.readSync(
            store.descriptor, content, offset,
            Math.min(RESTORE_BACKUP_IO_CHUNK_BYTES, content.length - offset), preimage.offset + offset
        );
        if (bytesRead <= 0) throw new Error(`restore backup ended during readback: ${relativePath}`);
        offset += bytesRead;
    }
    if (!sameFileSnapshot(before, fs.fstatSync(store.descriptor))
        || createHash('sha256').update(content).digest('hex') !== preimage.sha256) {
        throw new Error(`restore backup digest mismatch: ${relativePath}`);
    }
    return content;
}

function captureRestoreBackup(
    repoRoot: string,
    selectedPaths: Set<string>
): RestoreBackup {
    const store = createRestoreBackupStore(repoRoot);
    const originalFiles = new Map<string, OriginalFileState>();
    try {
        for (const relativePath of selectedPaths) {
            const snapshot = readAuthenticatedRepoFileSnapshot(repoRoot, relativePath, GIT_RESTORE_MAX_BUFFER_BYTES);
            originalFiles.set(relativePath, {
                exists: snapshot.exists,
                preimage: snapshot.content === null ? null : spoolRestorePreimage(store, snapshot.content),
                mode: snapshot.mode,
                identity: snapshot.identity
            });
        }
        fs.fsyncSync(store.descriptor);
        const sealed = fs.fstatSync(store.descriptor);
        if (!sameFileIdentity(sealed, store.identity) || sealed.nlink !== 0 || sealed.size !== store.bytes) {
            throw new Error('restore backup identity changed while sealing');
        }
        store.identity = sealed;
    } catch (error: unknown) {
        fs.closeSync(store.descriptor);
        throw error;
    }
    return {
        store,
        originalFiles,
        mutatedPaths: new Map<string, RestoreMutationState>(),
        transientPaths: new Set<string>()
    };
}

function restoreFromBackup(
    repoRoot: string,
    backup: RestoreBackup
): void {
    for (const [relativePath, original] of backup.originalFiles) {
        const mutation = backup.mutatedPaths.get(relativePath);
        if (mutation === undefined) {
            continue;
        }
        if (!original.exists) {
            if (mutation.identity !== null) {
                if (mutation.removalHandle !== null) {
                    mutation.removalHandle.remove();
                } else {
                    removeRepoFileIfIdentityMatches(
                        repoRoot,
                        relativePath,
                        mutation.identity,
                        mutation.stableSnapshot
                    );
                }
            }
            continue;
        }
        const content = readRestorePreimage(backup.store, original, relativePath);
        if (content === null) {
            throw new Error(`restore rollback snapshot is missing bytes: ${relativePath}`);
        }
        writeRepoFileReplacingRegular(
            repoRoot,
            relativePath,
            content,
            original.mode ?? 0o600,
            () => undefined,
            mutation.identity,
            mutation.stableSnapshot
        );
    }
    closeRestoreBackupHandles(backup);
    backup.mutatedPaths.clear();
    for (const transientPath of backup.transientPaths) {
        removeFileIfExists(transientPath);
    }
    backup.transientPaths.clear();
}

function closeRestoreBackupHandles(backup: RestoreBackup): void {
    let closeError: unknown = null;
    for (const mutation of backup.mutatedPaths.values()) {
        try {
            mutation.removalHandle?.close();
        } catch (error: unknown) {
            closeError ??= error;
        }
    }
    if (closeError !== null) {
        throw closeError;
    }
}

function applyCandidateFiles(
    repoRoot: string,
    plan: AdvancedRestorePlan,
    backup: RestoreBackup,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[],
    selectedUntrackedFiles: SplitRequiredWipUntrackedFileEvidence[],
    artifactSnapshots?: SplitRequiredWipRestoreArtifactSnapshots
): void {
    for (const entry of selectedTrackedFiles) {
        const normalizedPath = normalizeGitPath(entry.path);
        const original = backup.originalFiles.get(normalizedPath);
        if (!original) {
            throw new Error(`restore backup is missing selected tracked path: ${normalizedPath}`);
        }
        const candidate = readAuthenticatedRepoFileSnapshot(
            plan.candidateWorktreeRoot,
            normalizedPath,
            GIT_RESTORE_MAX_BUFFER_BYTES
        );
        if (candidate.exists) {
            const originalContent = readRestorePreimage(backup.store, original, normalizedPath);
            let removalHandle: AuthenticatedRepoFileRemovalHandle | null = null;
            const writtenIdentity = replaceFileFromCandidate(
                repoRoot,
                normalizedPath,
                candidate,
                original.identity,
                originalContent,
                original.mode,
                (identity, createdRemovalHandle) => {
                    removalHandle = createdRemovalHandle ?? null;
                    backup.mutatedPaths.set(normalizedPath, {
                        identity,
                        stableSnapshot: false,
                        removalHandle
                    });
                },
                () => backup.mutatedPaths.delete(normalizedPath)
            );
            backup.mutatedPaths.set(normalizedPath, {
                identity: writtenIdentity,
                stableSnapshot: true,
                removalHandle
            });
        } else {
            const removed = removeRepoRegularFile(
                repoRoot,
                normalizedPath,
                original.identity,
                (identity) => {
                    backup.mutatedPaths.set(normalizedPath, {
                        identity,
                        stableSnapshot: false,
                        removalHandle: null
                    });
                }
            );
            if (!removed && original.exists) {
                throw new Error(`tracked restore target disappeared before removal: ${normalizedPath}`);
            }
            if (removed) {
                backup.mutatedPaths.set(normalizedPath, {
                    identity: null,
                    stableSnapshot: true,
                    removalHandle: null
                });
            }
        }
    }
    for (const entry of selectedUntrackedFiles) {
        const snapshot = artifactSnapshots?.untrackedFiles.get(normalizeGitPath(entry.path));
        if (snapshot === undefined) {
            throw new Error(`authenticated untracked artifact snapshot is missing: ${entry.path}`);
        }
        const normalizedPath = normalizeGitPath(entry.path);
        const removalHandle = writeExclusiveRepoFileWithRemovalHandle(
            repoRoot,
            normalizedPath,
            snapshot
        );
        backup.mutatedPaths.set(normalizedPath, {
            identity: removalHandle.identity,
            stableSnapshot: true,
            removalHandle
        });
    }
}

function promoteCandidateIndex(
    indexPath: string,
    candidateIndexPath: string,
    transientPaths: Set<string>,
    expectedCurrentIndexSha256: string
): void {
    const indexLockPath = `${indexPath}.lock`;
    fs.copyFileSync(candidateIndexPath, indexLockPath, fs.constants.COPYFILE_EXCL);
    transientPaths.add(indexLockPath);
    if (sha256FileRequired(indexPath) !== expectedCurrentIndexSha256) {
        throw new Error('repository index changed before candidate index promotion');
    }
    fs.renameSync(indexLockPath, indexPath);
    transientPaths.delete(indexLockPath);
}

export function applyAdvancedRestorePlan(
    repoRoot: string,
    plan: AdvancedRestorePlan,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[],
    selectedUntrackedFiles: SplitRequiredWipUntrackedFileEvidence[],
    artifactSnapshots?: SplitRequiredWipRestoreArtifactSnapshots
): string[] {
    const indexPath = currentIndexPath(repoRoot);
    const selectedPaths = selectedRestorePaths(selectedTrackedFiles, selectedUntrackedFiles);
    const freshnessViolation = validateRestorePlanFreshness(repoRoot, indexPath, plan, selectedPaths);
    if (freshnessViolation) {
        return [freshnessViolation];
    }
    let backup: RestoreBackup;
    try {
        backup = captureRestoreBackup(repoRoot, selectedPaths);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`three-way restore failed before mutation: ${message}`];
    }
    try {
        const postBackupFreshnessViolation = validateRestorePlanFreshness(repoRoot, indexPath, plan, selectedPaths);
        if (postBackupFreshnessViolation) return [postBackupFreshnessViolation];
        applyCandidateFiles(
            repoRoot,
            plan,
            backup,
            selectedTrackedFiles,
            selectedUntrackedFiles,
            artifactSnapshots
        );
        promoteCandidateIndex(
            indexPath,
            plan.candidateIndexPath,
            backup.transientPaths,
            plan.currentIndexSha256
        );
        return [];
    } catch (error: unknown) {
        try {
            restoreFromBackup(repoRoot, backup);
        } catch (rollbackError: unknown) {
            const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            return [`three-way restore failed and rollback failed: ${message}`];
        }
        const message = error instanceof Error ? error.message : String(error);
        return [`three-way restore failed without retained mutations: ${message}`];
    } finally {
        try {
            closeRestoreBackupHandles(backup);
        } finally {
            fs.closeSync(backup.store.descriptor);
        }
    }
}

function validateArtifactHash(
    repoRoot: string,
    label: string,
    artifactPath: string,
    expectedSha256: string
): string | null {
    if (!expectedSha256) {
        return `${label} sha256 is missing.`;
    }
    const relativePath = normalizeGitPath(path.relative(repoRoot, artifactPath));
    const snapshot = readAuthenticatedRepoFileSnapshot(
        repoRoot,
        relativePath,
        GIT_RESTORE_MAX_BUFFER_BYTES
    );
    if (!snapshot.exists || snapshot.content === null) {
        return `${label} artifact is missing: ${normalizePath(artifactPath)}`;
    }
    const actualSha256 = createHash('sha256').update(snapshot.content).digest('hex');
    return actualSha256 === expectedSha256
        ? null
        : `${label} sha256 mismatch: expected=${expectedSha256}; actual=${actualSha256}`;
}

function validateReferencedArtifact(
    repoRoot: string,
    label: string,
    inputPath: string,
    expectedSha256: string
): string | null {
    try {
        const artifactPath = resolveInputPathInsideRepo(repoRoot, inputPath, label);
        return validateArtifactHash(repoRoot, label, artifactPath, expectedSha256);
    } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
    }
}

export function validateManifestFileReferences(
    repoRoot: string,
    manifest: SplitRequiredWipManifest
): string[] {
    if (!isPlainRecord(manifest.patches)
        || !isPlainRecord(manifest.patches.staged)
        || !isPlainRecord(manifest.patches.unstaged)) {
        return ['WIP manifest patch references are missing or invalid.'];
    }
    const violations: string[] = [];
    for (const [label, patch] of [
        ['staged patch', manifest.patches.staged],
        ['unstaged patch', manifest.patches.unstaged]
    ] as const) {
        const violation = validateReferencedArtifact(repoRoot, label, patch.path, patch.sha256);
        if (violation) {
            violations.push(violation);
        }
    }
    for (const entry of manifest.untracked_files || []) {
        const label = `untracked artifact ${entry.path}`;
        const violation = validateReferencedArtifact(repoRoot, label, entry.artifact_path, entry.sha256);
        if (violation) {
            violations.push(violation);
        }
    }
    return violations;
}
