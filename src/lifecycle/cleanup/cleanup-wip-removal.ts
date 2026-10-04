import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    assertBoundContainedRemovalTree, assertContainedDestination, bindContainedDestination,
    removeBoundContainedPath, type ContainedDestination
} from '../../core/contained-filesystem';
import { isPlainRecord } from '../../core/records';
import { withTaskQueueTransaction } from '../../core/task-queue/task-queue-repository';
import { acquireFilesystemLock, inspectFilesystemLock, releaseFilesystemLock, type LockHandle } from '../../gate-runtime/task-events-locking';
import { joinOrchestratorPath, normalizePath } from '../../gates/shared/helpers';
import { getLifecycleOperationLockPath, withLifecycleOperationLock } from '../lock/lifecycle-lock';
import { assertWipCleanupFileCurrent, readWipCleanupFile, WIP_CLEANUP_LIMITS, wipCleanupBindingIdentity,
    wipCleanupPathKey, wipCleanupSha256, type AuthenticatedWipPackage, type WipCleanupFile } from './cleanup-wip-ownership';
import { prepareRetiredWipCleanupSnapshot, type RetiredWipCleanupSnapshot, type WipCleanupSelection } from './cleanup-wip-preview';

export interface RetiredWipCleanupApplyOptions extends WipCleanupSelection {
    ownershipDigest: string;
    confirmed: boolean;
}

export interface RetiredWipCleanupRemovalResult {
    schema_version: 1;
    kind: 'retired_wip_cleanup_removal';
    status: 'REMOVED' | 'BLOCKED' | 'INCOMPLETE' | 'CONFIRMATION_REQUIRED';
    removed_packages: string[];
    removed_file_count: number;
    removed_bytes: number;
    mutation_attempted: boolean;
    counts_complete: boolean;
    errors: string[];
}

interface DirectoryWatch {
    binding: ContainedDestination;
    stamp: string;
}

function directoryStamp(binding: ContainedDestination): string {
    assertContainedDestination(binding);
    const stat = fs.lstatSync(binding.path, { bigint: true });
    return JSON.stringify([String(stat.mtimeNs), String(stat.ctimeNs)]);
}

function fileIdentityCurrent(file: WipCleanupFile): void {
    assertContainedDestination(file.binding);
    const stat = fs.lstatSync(file.binding.path, { bigint: true });
    assertContainedDestination(file.binding);
    const identity = wipCleanupSha256(JSON.stringify([wipCleanupBindingIdentity(file.binding), String(stat.size),
        String(stat.mtimeNs), String(stat.ctimeNs)]));
    if (identity !== file.identity) throw new Error(`WIP authority changed before removal: ${normalizePath(file.binding.path)}`);
}

function lockGeneration(root: string): { owner: ContainedDestination; lockId: string } {
    const ownerPath = path.join(getLifecycleOperationLockPath(root), 'owner.json');
    const file = readWipCleanupFile(root, ownerPath, WIP_CLEANUP_LIMITS.handoffBytes);
    const parsed: unknown = JSON.parse(file.content.toString('utf8'));
    if (!isPlainRecord(parsed) || typeof parsed.lock_id !== 'string' || parsed.pid !== process.pid) {
        throw new Error('WIP cleanup requires the current lifecycle lock generation.');
    }
    return { owner: file.binding, lockId: parsed.lock_id };
}

function assertLockGeneration(root: string, expected: ReturnType<typeof lockGeneration>, handles: readonly LockHandle[]): void {
    assertContainedDestination(expected.owner);
    if (lockGeneration(root).lockId !== expected.lockId) throw new Error('WIP lifecycle lock ownership changed before removal.');
    for (const handle of handles) {
        const owner = bindContainedDestination(root, path.join(handle.lockPath, 'owner.json'));
        assertContainedDestination(owner);
        const inspection = inspectFilesystemLock(handle.lockPath);
        if (inspection.metadata.lock_id !== handle.lockId || inspection.metadata.pid !== process.pid) {
            throw new Error('WIP canonical timeline lock ownership changed before removal.');
        }
    }
    withTaskQueueTransaction(path.join(root, 'TASK.md'), message => { throw new Error(message); }, () => undefined);
}

function acquireTimelineLocks(snapshot: RetiredWipCleanupSnapshot, handles: LockHandle[]): void {
    const eventsRoot = joinOrchestratorPath(snapshot.root, 'runtime/task-events');
    bindContainedDestination(snapshot.root, eventsRoot);
    for (const taskId of snapshot.timelineTaskIds) {
        const lockPath = path.join(eventsRoot, `.${taskId}.lock`);
        bindContainedDestination(snapshot.root, lockPath);
        const { handle } = acquireFilesystemLock(lockPath, { timeoutMs: 1,
            requireKnownDeadOwner: true, allowForeignHostStaleRecovery: false });
        handles.push(handle);
        bindContainedDestination(snapshot.root, path.join(lockPath, 'owner.json'));
    }
}

function watchDirectories(snapshot: RetiredWipCleanupSnapshot): Map<string, DirectoryWatch> {
    const watches = new Map<string, DirectoryWatch>();
    const bindings = [...snapshot.boundaries.filter(binding => !binding.missingAt
        && fs.lstatSync(binding.path).isDirectory()), ...snapshot.packages.flatMap(item => item.directories)];
    for (const binding of bindings) watches.set(wipCleanupPathKey(binding.path), { binding, stamp: directoryStamp(binding) });
    return watches;
}

function assertSnapshotAuthority(snapshot: RetiredWipCleanupSnapshot, watches: ReadonlyMap<string, DirectoryWatch>): void {
    for (const file of snapshot.authorityFiles) fileIdentityCurrent(file);
    for (const binding of snapshot.boundaries) assertContainedDestination(binding);
    for (const watch of watches.values()) {
        if (directoryStamp(watch.binding) !== watch.stamp) throw new Error('WIP directory membership changed before removal.');
    }
}

function refreshParentWatch(file: string, watches: Map<string, DirectoryWatch>): void {
    const watch = watches.get(wipCleanupPathKey(path.dirname(file)));
    if (watch) watch.stamp = directoryStamp(watch.binding);
}

function removePackage(item: AuthenticatedWipPackage, snapshot: RetiredWipCleanupSnapshot,
    watches: Map<string, DirectoryWatch>, checkLocks: () => void, result: RetiredWipCleanupRemovalResult): void {
    const files = [...item.files].sort((left, right) => {
        const leftManifest = wipCleanupPathKey(left.binding.path) === wipCleanupPathKey(item.manifestPath);
        const rightManifest = wipCleanupPathKey(right.binding.path) === wipCleanupPathKey(item.manifestPath);
        return Number(leftManifest) - Number(rightManifest) || left.binding.path.localeCompare(right.binding.path, 'en');
    });
    const manifest = item.files.find(file => wipCleanupPathKey(file.binding.path) === wipCleanupPathKey(item.manifestPath))!;
    for (const file of files) {
        checkLocks();
        assertSnapshotAuthority(snapshot, watches);
        fileIdentityCurrent(manifest);
        assertWipCleanupFileCurrent(snapshot.root, file);
        result.mutation_attempted = true;
        removeBoundContainedPath(file.binding, true);
        result.removed_file_count += 1;
        result.removed_bytes += file.bytes;
        refreshParentWatch(file.binding.path, watches);
    }
    const directories = [...item.directories].sort((left, right) => right.path.length - left.path.length);
    for (const binding of directories) {
        checkLocks();
        assertSnapshotAuthority(snapshot, watches);
        result.mutation_attempted = true;
        removeBoundContainedPath(binding);
        watches.delete(wipCleanupPathKey(binding.path));
        refreshParentWatch(binding.path, watches);
    }
    if (fs.existsSync(item.rootBinding.path)) throw new Error('WIP package remains after removal.');
    result.removed_packages.push(normalizePath(item.manifestPath));
}

function applyLocked(options: RetiredWipCleanupApplyOptions, result: RetiredWipCleanupRemovalResult,
    generation: ReturnType<typeof lockGeneration>): void {
    const initial = prepareRetiredWipCleanupSnapshot(options);
    if (initial.preview.status !== 'READY' || initial.preview.ownership_digest !== options.ownershipDigest) {
        throw new Error(`WIP preview is blocked or stale; obtain and confirm a fresh preview. ${initial.preview.blockers.join(' | ')}`);
    }
    const handles: LockHandle[] = [];
    try {
        acquireTimelineLocks(initial, handles);
        const snapshot = prepareRetiredWipCleanupSnapshot(options);
        if (snapshot.preview.status !== 'READY' || snapshot.preview.ownership_digest !== options.ownershipDigest) {
            throw new Error(`WIP ownership changed while acquiring canonical timeline locks. ${snapshot.preview.blockers.join(' | ')}`);
        }
        const checkLocks = () => assertLockGeneration(snapshot.root, generation, handles);
        const watches = watchDirectories(snapshot);
        checkLocks();
        assertSnapshotAuthority(snapshot, watches);
        for (const item of snapshot.packages) {
            assertBoundContainedRemovalTree(item.rootBinding, WIP_CLEANUP_LIMITS.entries,
                [...item.directories, ...item.files.map(file => file.binding)]);
            for (const file of item.files) assertWipCleanupFileCurrent(snapshot.root, file);
        }
        for (const item of snapshot.packages) removePackage(item, snapshot, watches, checkLocks, result);
        result.status = 'REMOVED';
    } finally {
        for (const handle of handles.reverse()) releaseFilesystemLock(handle);
    }
}

export function removeRetiredWipPackages(options: RetiredWipCleanupApplyOptions): RetiredWipCleanupRemovalResult {
    const result: RetiredWipCleanupRemovalResult = { schema_version: 1, kind: 'retired_wip_cleanup_removal',
        status: 'BLOCKED', removed_packages: [], removed_file_count: 0, removed_bytes: 0,
        mutation_attempted: false, counts_complete: true, errors: [] };
    if (!options || options.confirmed !== true) { result.status = 'CONFIRMATION_REQUIRED'; return result; }
    if (typeof options.ownershipDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(options.ownershipDigest)) {
        result.errors.push('WIP apply requires the exact SHA256 ownership digest from preview.'); return result;
    }
    try {
        const checked = prepareRetiredWipCleanupSnapshot(options);
        if (checked.preview.status !== 'READY' || checked.preview.ownership_digest !== options.ownershipDigest) {
            throw new Error(`WIP preview is blocked or stale; obtain and confirm a fresh preview. ${checked.preview.blockers.join(' | ')}`);
        }
        withLifecycleOperationLock(checked.root, 'retired-wip-cleanup', () => {
            const generation = lockGeneration(checked.root);
            withTaskQueueTransaction(path.join(checked.root, 'TASK.md'), message => { throw new Error(message); },
                () => applyLocked(options, result, generation));
        }, { allowForeignHostStaleRecovery: false });
    } catch (error) {
        result.status = result.mutation_attempted ? 'INCOMPLETE' : 'BLOCKED';
        result.counts_complete = !result.mutation_attempted;
        result.errors.push(error instanceof Error ? error.message : String(error));
    }
    return result;
}
