import * as path from 'node:path';
import { assertBoundContainedRemovalTree, assertContainedDestination, bindContainedDestination,
    removeBoundContainedPath } from '../../core/contained-filesystem';
import { lstatFileIdentitySync } from '../../core/file-stat';
import { getLifecycleOperationLockPath, withLifecycleOperationLock } from '../lock/lifecycle-lock';
import { withLifecycleRuntimeMutationGeneration } from '../runtime-mutation-generation';
import { buildScratchCleanupSnapshot, type ScratchCleanupSnapshot, type ScratchTreeEntry,
    type StaleScratchCleanupSelection } from './cleanup-scratch-preview';
import { assertScratchLockRecoverySafe, inspectScratchWriter, readScratchFile, SCRATCH_CLEANUP_LIMITS,
    scratchPathKey, scratchStatIdentity, withScratchWriterLock } from './scratch-writer-ownership';

export interface StaleScratchCleanupApplyOptions extends StaleScratchCleanupSelection {
    confirmed: boolean;
    ownershipDigest: string;
}

export interface StaleScratchCleanupRemovalResult {
    schema_version: 1;
    kind: 'stale_scratch_cleanup_removal';
    status: 'CONFIRMATION_REQUIRED' | 'BLOCKED' | 'INCOMPLETE' | 'REMOVED';
    removed_roots: string[];
    removed_file_count: number;
    removed_bytes: number;
    mutation_attempted: boolean;
    counts_complete: boolean;
    errors: string[];
}

interface RemainingSelection {
    removed: Set<string>;
    directoryIdentities: Map<string, string>;
}

function requireExactSnapshot(options: StaleScratchCleanupApplyOptions): ScratchCleanupSnapshot {
    const snapshot = buildScratchCleanupSnapshot(options);
    if (snapshot.preview.status !== 'READY' || snapshot.preview.ownership_digest !== options.ownershipDigest) {
        throw new Error(`Scratch selection, ownership or tree changed; obtain and confirm a fresh preview. ${snapshot.preview.blockers.join(' | ')}`);
    }
    return snapshot;
}

function assertRemainingSelection(snapshot: ScratchCleanupSnapshot, remaining: RemainingSelection, checkLocks: () => void): void {
    checkLocks();
    for (const root of snapshot.roots) {
        const entries = root.entries.filter(entry => !remaining.removed.has(scratchPathKey(entry.binding.path)));
        if (entries.length === 0) continue;
        const owner = inspectScratchWriter(root.locations);
        if (owner.state !== 'dead' || owner.file.sha256 !== root.writer.file.sha256 || owner.file.identity !== root.writer.file.identity) {
            throw new Error('Scratch writer ownership changed during removal; preserve every remaining member.');
        }
        assertBoundContainedRemovalTree(root.rootBinding, SCRATCH_CLEANUP_LIMITS.entries, entries.map(entry => entry.binding));
        for (const entry of entries) {
            assertContainedDestination(entry.binding);
            const expected = entry.directory ? remaining.directoryIdentities.get(scratchPathKey(entry.binding.path)) : entry.identity;
            if (scratchStatIdentity(lstatFileIdentitySync(entry.binding.path, { bigint: true })) !== expected) {
                throw new Error('Scratch retained member metadata changed during removal; obtain a fresh preview.');
            }
        }
    }
    checkLocks();
}

function checkLifecycleGeneration(root: string): () => void {
    const file = readScratchFile(bindContainedDestination(root, path.join(getLifecycleOperationLockPath(root), 'owner.json')),
        SCRATCH_CLEANUP_LIMITS.ownerBytes);
    return () => {
        const current = readScratchFile(file.binding, SCRATCH_CLEANUP_LIMITS.ownerBytes);
        if (current.identity !== file.identity || current.sha256 !== file.sha256) {
            throw new Error('Scratch lifecycle lock generation changed before removal.');
        }
    };
}

function removeEntry(entry: ScratchTreeEntry, remaining: RemainingSelection, result: StaleScratchCleanupRemovalResult,
    checkAuthority: () => void): void {
    if (entry.file) {
        const current = readScratchFile(entry.binding, entry.file.bytes);
        if (current.identity !== entry.file.identity || current.sha256 !== entry.file.sha256) {
            throw new Error('Scratch file bytes changed before removal; preserve the remaining selection.');
        }
    }
    checkAuthority();
    result.mutation_attempted = true;
    removeBoundContainedPath(entry.binding, false, () => {
        remaining.removed.add(scratchPathKey(entry.binding.path));
        if (entry.file) { result.removed_file_count += 1; result.removed_bytes += entry.file.bytes; }
    });
    const parent = path.dirname(entry.binding.path), parentKey = scratchPathKey(parent);
    if (remaining.directoryIdentities.has(parentKey) && !remaining.removed.has(parentKey)) {
        remaining.directoryIdentities.set(parentKey, scratchStatIdentity(lstatFileIdentitySync(parent, { bigint: true })));
    }
}

function applyLocked(options: StaleScratchCleanupApplyOptions, result: StaleScratchCleanupRemovalResult,
    checkLocks: () => void): void {
    checkLocks();
    const snapshot = requireExactSnapshot(options);
    const remaining: RemainingSelection = { removed: new Set(), directoryIdentities: new Map() };
    for (const root of snapshot.roots) for (const entry of root.entries) {
        if (entry.directory) remaining.directoryIdentities.set(scratchPathKey(entry.binding.path), entry.identity);
    }
    // The entire exact selection is authenticated under both locks before the first member can be removed.
    assertRemainingSelection(snapshot, remaining, checkLocks);
    withLifecycleRuntimeMutationGeneration(snapshot.selection.bundleRoot, 'stale-scratch-cleanup', () => {
        for (const root of snapshot.roots) {
            const files = root.entries.filter(entry => !entry.directory);
            const directories = root.entries.filter(entry => entry.directory)
                .sort((left, right) => right.binding.path.length - left.binding.path.length);
            for (const entry of [...files, ...directories]) {
                assertRemainingSelection(snapshot, remaining, checkLocks);
                checkLocks(); removeEntry(entry, remaining, result, () => assertRemainingSelection(snapshot, remaining, checkLocks));
            }
            result.removed_roots.push(path.relative(snapshot.selection.targetRoot, root.locations.scratchPath).replace(/\\/gu, '/'));
        }
        checkLocks();
    });
    result.status = 'REMOVED';
}

export function removeStaleScratch(options: StaleScratchCleanupApplyOptions): StaleScratchCleanupRemovalResult {
    const result: StaleScratchCleanupRemovalResult = { schema_version: 1, kind: 'stale_scratch_cleanup_removal',
        status: 'BLOCKED', removed_roots: [], removed_file_count: 0, removed_bytes: 0,
        mutation_attempted: false, counts_complete: true, errors: [] };
    if (!options || options.confirmed !== true) { result.status = 'CONFIRMATION_REQUIRED'; return result; }
    if (typeof options.ownershipDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(options.ownershipDigest)) {
        result.errors.push('Scratch apply requires the exact SHA256 digest from its confirmed preview.'); return result;
    }
    try {
        const initial = requireExactSnapshot(options), locations = initial.roots[0].locations;
        assertScratchLockRecoverySafe(locations.root, getLifecycleOperationLockPath(locations.root), true);
        withLifecycleOperationLock(locations.root, 'stale-scratch-cleanup', () => {
            const checkLifecycle = checkLifecycleGeneration(locations.root);
            withScratchWriterLock(locations, checkWriter => {
                applyLocked(options, result, () => { checkLifecycle(); checkWriter(); });
            });
        }, { allowForeignHostStaleRecovery: false });
    } catch (error) {
        result.status = 'INCOMPLETE'; result.counts_complete = !result.mutation_attempted;
        result.errors.push(error instanceof Error ? error.message : String(error));
    }
    return result;
}
