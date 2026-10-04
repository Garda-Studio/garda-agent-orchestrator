import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import * as containedFilesystem from '../../../src/core/contained-filesystem';
import * as wipPreview from '../../../src/lifecycle/cleanup/cleanup-wip-preview';
import { removeRetiredWipPackages } from '../../../src/lifecycle/cleanup/cleanup-wip-removal';
import { getLifecycleOperationLockPath } from '../../../src/lifecycle/lock/lifecycle-lock';
import { resolveTaskQueueTransactionLockPath } from '../../../src/core/task-queue/task-queue-repository';
import { retireSplitRequiredWip } from '../../../src/gates/split-required/split-required-wip-operations';
import { createCapturedWip, createWip, event, makeWipRepo, preview, remove, treeSnapshot, writeQueue } from './cleanup-wip-fixtures';

describe('confirmed retired WIP removal', () => {
    let root: string;
    beforeEach(() => { root = makeWipRepo(); });
    afterEach(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });

    it('removes a package produced by real capture and retirement while preserving restored baseline source', () => {
        const captured = createCapturedWip(root);
        assert.equal(fs.existsSync(path.join(captured.packageRoot, 'suspended-untracked/src')), true);
        assert.equal(retireSplitRequiredWip({ repoRoot: root, taskId: 'T-CLEAN-1',
            manifestPath: captured.manifestPath, reason: 'Captured source explicitly retired.' }).status, 'RETIRED');
        writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'DONE' }]);
        const selection = { targetRoot: root, taskIds: ['T-CLEAN-1'] }, planned = preview(selection);
        assert.equal(planned.status, 'READY', planned.blockers.join('\n'));
        assert.equal(remove(selection, planned.ownership_digest).status, 'REMOVED');
        assert.equal(fs.existsSync(captured.packageRoot), false);
        assert.equal(fs.readFileSync(path.join(root, 'src/tracked.ts'), 'utf8'), 'export const tracked = 1;\n');
        assert.equal(fs.existsSync(path.join(root, 'src/generated.ts')), false);
    });

    it('rejects missing confirmation and forged digest before any filesystem mutation', () => {
        createWip(root);
        const selection = { targetRoot: root, taskIds: ['T-CLEAN-1'] };
        const planned = preview(selection), before = treeSnapshot(root);
        assert.equal(remove(selection, planned.ownership_digest, false).status, 'CONFIRMATION_REQUIRED');
        assert.equal(treeSnapshot(root), before);
        assert.equal(remove(selection, '0'.repeat(64)).status, 'BLOCKED');
        assert.equal(treeSnapshot(root), before);
    });

    it('blocks over-budget multiplied revalidation work before acquiring removal locks', () => {
        const packages = Array.from({ length: 32 }, (_, index) => createWip(root, { ordinal: index + 1 }));
        const unfinished = Array.from({ length: 64 }, (_, index) => ({ taskId: `T-SURVIVOR-${index + 1}`, status: 'TODO' }));
        for (const row of unfinished) event(root, row.taskId, 'TASK_CREATED', { reason: 'Unrelated unfinished work.' });
        writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'DONE' }, ...unfinished]);
        const selection = { targetRoot: root, taskIds: ['T-CLEAN-1'] }, before = treeSnapshot(root);
        const planned = preview(selection);
        assert.equal(planned.package_count, packages.length);
        assert.equal(planned.file_count, 128);
        assert.ok(planned.packages.every(item => item.classification === 'retired-orphan'));
        assert.equal(planned.status, 'BLOCKED');
        assert.match(planned.blockers.join('\n'), /revalidation.*budget/iu);
        assert.equal(treeSnapshot(root), before);
        const original = fs.mkdirSync, eventsRoot = path.join(root, 'garda-agent-orchestrator/runtime/task-events');
        let removalLockAttempts = 0;
        mock.method(fs, 'mkdirSync', (...args: unknown[]) => {
            const directory = String(args[0]);
            if (directory === getLifecycleOperationLockPath(root)
                || directory === resolveTaskQueueTransactionLockPath(path.join(root, 'TASK.md'))
                || directory.startsWith(`${eventsRoot}${path.sep}`) && path.basename(directory).endsWith('.lock')) {
                removalLockAttempts += 1;
            }
            return Reflect.apply(original, fs, args);
        });
        const blocked = remove(selection, planned.ownership_digest);
        assert.equal(blocked.status, 'BLOCKED');
        assert.equal(blocked.removed_file_count, 0);
        assert.deepEqual(blocked.removed_packages, []);
        assert.equal(removalLockAttempts, 0);
        assert.equal(treeSnapshot(root), before);
        mock.restoreAll();
        const smaller = { ...selection, manifestPaths: packages.slice(0, 16).map(item => item.manifestPath) };
        const smallerPreview = preview(smaller), unselected = packages.slice(16).map(item => treeSnapshot(item.packageRoot));
        assert.equal(smallerPreview.status, 'READY', smallerPreview.blockers.join('\n'));
        const removed = remove(smaller, smallerPreview.ownership_digest);
        assert.equal(removed.status, 'REMOVED', removed.errors.join('\n'));
        assert.equal(removed.removed_file_count, smallerPreview.file_count);
        assert.equal(removed.removed_packages.length, 16);
        assert.deepEqual(packages.slice(16).map(item => treeSnapshot(item.packageRoot)), unselected);
    });

    it('removes only exact confirmed retired packages and preserves unrelated source and evidence', () => {
        const selected = createWip(root);
        const child = createWip(root, { taskId: 'T-CLEAN-1-F1', ordinal: 2, retired: false });
        const outside = path.join(root, 'keep.txt');
        fs.writeFileSync(outside, 'keep');
        const queue = fs.readFileSync(path.join(root, 'TASK.md'));
        const timeline = fs.readFileSync(path.join(root, 'garda-agent-orchestrator/runtime/task-events/T-CLEAN-1.jsonl'));
        const selection = { targetRoot: root, taskIds: ['T-CLEAN-1'] };
        const planned = preview(selection), result = remove(selection, planned.ownership_digest);
        assert.equal(result.status, 'REMOVED', result.errors.join('\n'));
        assert.deepEqual(result.removed_packages, [selected.manifestPath.replace(/\\/gu, '/')]);
        assert.equal(result.removed_file_count, planned.file_count);
        assert.equal(result.removed_bytes, planned.total_bytes);
        assert.equal(fs.existsSync(selected.packageRoot), false);
        assert.equal(fs.existsSync(child.artifactPath), true);
        assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
        assert.deepEqual(fs.readFileSync(path.join(root, 'TASK.md')), queue);
        assert.deepEqual(fs.readFileSync(path.join(root, 'garda-agent-orchestrator/runtime/task-events/T-CLEAN-1.jsonl')), timeline);
    });

    it('preserves foreign suspended siblings when binding manifest selection', () => {
        const retired = createWip(root), suspended = createWip(root, { ordinal: 2, retired: false });
        const selection = { targetRoot: root, taskIds: ['T-CLEAN-1'], manifestPaths: [retired.manifestPath] };
        const planned = preview(selection);
        assert.equal(planned.status, 'READY', planned.blockers.join('\n'));
        assert.equal(remove(selection, planned.ownership_digest).status, 'REMOVED');
        assert.equal(fs.existsSync(suspended.artifactPath), true);
    });

    it('rejects queue status and new cross-task references after preview before first deletion', () => {
        const wip = createWip(root), selection = { targetRoot: root, taskIds: ['T-CLEAN-1'] };
        const planned = preview(selection);
        writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'DONE' }, { taskId: 'T-SURVIVOR', status: 'TODO' }]);
        assert.equal(remove(selection, planned.ownership_digest).status, 'BLOCKED');
        const refreshed = preview(selection);
        event(root, 'T-SURVIVOR', 'FULL_SUITE_REPAIR_TASK_MATERIALIZED', { wip_manifest_path: wip.manifestPath });
        const result = remove(selection, refreshed.ownership_digest);
        assert.equal(result.status, 'BLOCKED');
        assert.deepEqual(result.removed_packages, []);
        assert.equal(fs.existsSync(wip.artifactPath), true);
    });

    it('rejects manifest tree parent and root identity drift after preview', () => {
        const wip = createWip(root), selection = { targetRoot: root, taskIds: ['T-CLEAN-1'] };
        const planned = preview(selection), original = fs.readFileSync(wip.manifestPath);
        fs.appendFileSync(wip.manifestPath, ' ');
        assert.equal(remove(selection, planned.ownership_digest).status, 'BLOCKED');
        fs.writeFileSync(wip.manifestPath, original);
        const sameBytesPlan = preview(selection), artifact = fs.readFileSync(wip.artifactPath);
        fs.unlinkSync(wip.artifactPath);
        fs.writeFileSync(wip.artifactPath, artifact);
        assert.equal(remove(selection, sameBytesPlan.ownership_digest).status, 'BLOCKED');
        const replacedPlan = preview(selection), parent = path.dirname(wip.packageRoot);
        fs.renameSync(parent, `${parent}-old`);
        fs.mkdirSync(parent);
        fs.renameSync(path.join(`${parent}-old`, path.basename(wip.packageRoot)), wip.packageRoot);
        assert.equal(remove(selection, replacedPlan.ownership_digest).status, 'BLOCKED');
        assert.equal(fs.existsSync(wip.artifactPath), true);
    });

    it('blocks the complete selected set before deleting any conflicting package', () => {
        const first = createWip(root), second = createWip(root, { ordinal: 2 });
        const selection = { targetRoot: root, taskIds: ['T-CLEAN-1'] }, planned = preview(selection);
        fs.writeFileSync(path.join(second.packageRoot, 'new.tmp'), 'foreign');
        const result = remove(selection, planned.ownership_digest);
        assert.equal(result.status, 'BLOCKED');
        assert.deepEqual(result.removed_packages, []);
        assert.equal(fs.existsSync(first.artifactPath), true);
        assert.equal(fs.existsSync(second.artifactPath), true);
    });

    it('blocks late payload conflicts in the whole locked selection before any removal', () => {
        const first = createWip(root), second = createWip(root, { ordinal: 2 });
        const selection = { targetRoot: root, taskIds: ['T-CLEAN-1'] }, planned = preview(selection);
        assert.equal(planned.status, 'READY', planned.blockers.join('\n'));
        assert.deepEqual(planned.packages.map(item => item.manifest_path),
            [first.manifestPath, second.manifestPath].map(file => file.replace(/\\/gu, '/')));
        const firstBefore = treeSnapshot(first.packageRoot), payload = fs.readFileSync(second.artifactPath);
        const conflictingPayload = Buffer.from(payload);
        assert.ok(conflictingPayload.length > 0);
        conflictingPayload[0] ^= 0xff;
        const owners = [getLifecycleOperationLockPath(root),
            resolveTaskQueueTransactionLockPath(path.join(root, 'TASK.md')),
            path.join(root, 'garda-agent-orchestrator/runtime/task-events/.T-CLEAN-1.lock')]
            .map(lockPath => path.join(lockPath, 'owner.json'));
        const ownedLocks = () => owners.every(owner => fs.existsSync(owner)
            && (JSON.parse(fs.readFileSync(owner, 'utf8')) as { pid: number }).pid === process.pid);
        const originalSnapshot = wipPreview.prepareRetiredWipCleanupSnapshot;
        let lockedSnapshotReady = false;
        mock.method(wipPreview, 'prepareRetiredWipCleanupSnapshot', (...args: Parameters<typeof originalSnapshot>) => {
            const snapshot = originalSnapshot(...args);
            if (ownedLocks() && snapshot.preview.status === 'READY'
                && snapshot.preview.ownership_digest === planned.ownership_digest) lockedSnapshotReady = true;
            return snapshot;
        });
        const original = containedFilesystem.assertBoundContainedRemovalTree;
        let injected = false, locksHeld = false, secondConflicted = '';
        mock.method(containedFilesystem, 'assertBoundContainedRemovalTree', (...args: unknown[]) => {
            if (lockedSnapshotReady && !injected && (args[0] as { path: string }).path === first.packageRoot) {
                locksHeld = ownedLocks();
                injected = true;
                fs.writeFileSync(second.artifactPath, conflictingPayload);
                secondConflicted = treeSnapshot(second.packageRoot);
            }
            return Reflect.apply(original, containedFilesystem, args);
        });
        const result = removeRetiredWipPackages({ ...selection, ownershipDigest: planned.ownership_digest, confirmed: true });
        assert.equal(lockedSnapshotReady, true, 'A ready snapshot must return under all three owned locks.');
        assert.equal(injected, true, 'The late conflict must occur during whole-selection tree validation.');
        assert.equal(locksHeld, true, 'Lifecycle, queue and canonical timeline locks must belong to this process.');
        assert.equal(result.status, 'BLOCKED', result.errors.join('\n'));
        assert.equal(result.mutation_attempted, false);
        assert.equal(result.counts_complete, true);
        assert.equal(result.removed_file_count, 0);
        assert.equal(result.removed_bytes, 0);
        assert.deepEqual(result.removed_packages, []);
        assert.equal(treeSnapshot(first.packageRoot), firstBefore);
        assert.equal(treeSnapshot(second.packageRoot), secondConflicted);
        assert.deepEqual(fs.readFileSync(second.artifactPath), conflictingPayload);
    });

    it('blocks lifecycle and queue lock ownership loss before first mutation', () => {
        const wip = createWip(root), selection = { targetRoot: root, taskIds: ['T-CLEAN-1'] };
        for (const lockPath of [getLifecycleOperationLockPath(root), resolveTaskQueueTransactionLockPath(path.join(root, 'TASK.md'))]) {
            const planned = preview(selection), original = fs.opendirSync;
            let injected = false;
            mock.method(fs, 'opendirSync', (...args: unknown[]) => {
                const result = Reflect.apply(original, fs, args);
                const owner = path.join(lockPath, 'owner.json');
                if (!injected && String(args[0]) === wip.packageRoot && fs.existsSync(owner)) {
                    injected = true;
                    const metadata = JSON.parse(fs.readFileSync(owner, 'utf8')) as Record<string, unknown>;
                    fs.writeFileSync(owner, JSON.stringify({ ...metadata, lock_id: 'foreign-generation' }));
                }
                return result;
            });
            const result = remove(selection, planned.ownership_digest);
            assert.equal(injected, true, 'The foreign lock generation must be injected during package inspection.');
            assert.equal(result.status, 'BLOCKED');
            assert.deepEqual(result.removed_packages, []);
            assert.equal(fs.existsSync(wip.artifactPath), true);
            mock.restoreAll();
            fs.rmSync(lockPath, { recursive: true, force: true });
        }
        assert.equal(fs.existsSync(wip.manifestPath), true);
    });

    it('reports partial failure as incomplete and retries safely without deleting residual unknown data', () => {
        const wip = createWip(root), selection = { targetRoot: root, taskIds: ['T-CLEAN-1'] };
        const planned = preview(selection), original = fs.unlinkSync;
        let removed = 0;
        mock.method(fs, 'unlinkSync', (...args: unknown[]) => {
            if (String(args[0]).startsWith(`${wip.packageRoot}${path.sep}`)) {
                if (removed === 1) throw Object.assign(new Error('Injected partial removal failure'), { code: 'EACCES' });
                removed += 1;
            }
            return Reflect.apply(original, fs, args);
        });
        const result = remove(selection, planned.ownership_digest);
        assert.equal(result.status, 'INCOMPLETE');
        assert.deepEqual(result.removed_packages, []);
        assert.ok(result.removed_file_count > 0);
        assert.equal(fs.existsSync(wip.manifestPath), true);
        mock.restoreAll();
        const residual = treeSnapshot(wip.packageRoot);
        assert.equal(remove(selection, planned.ownership_digest).status, 'BLOCKED');
        assert.equal(treeSnapshot(wip.packageRoot), residual);
    });
});
