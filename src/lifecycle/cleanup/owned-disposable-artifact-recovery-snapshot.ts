import * as path from 'node:path';
import { assertContainedDestination, bindContainedDestination, type ContainedDestination } from '../../core/contained-filesystem';
import { lstatFileIdentitySync } from '../../core/file-stat';
import { assertDisposableAuthorityCurrent, assertDisposableInventoryCurrent, inspectDisposableAuthority,
    inventoryDisposableTree, type DisposableAuthoritySnapshot, type DisposableInventoryBudget,
    type DisposableInventoryEntry } from './owned-disposable-artifact-inventory';
import type { OwnedDisposableArtifactJournalSelection } from './owned-disposable-artifact-journal';
import { digestOwnedDisposableArtifactSnapshot } from './owned-disposable-artifact-preview';
import { OWNED_DISPOSABLE_PREVIEW_LIMITS as LIMITS } from './owned-disposable-artifact-preview-contracts';
import type { OwnedDisposableRecoveryRootIntent } from './owned-disposable-artifact-recovery-authority';
import { readOwnedDisposableArtifactRecoveryProgress, type OwnedDisposableRecoveryProgress }
    from './owned-disposable-artifact-recovery-progress';
import { scratchStatIdentity } from './scratch-writer-ownership';

interface RecoveryRoot {
    registrationId: string;
    entries: readonly DisposableInventoryEntry[];
    absent: readonly ContainedDestination[];
}
interface ParentSnapshot { binding: ContainedDestination; identity: string }

export interface OwnedDisposableRecoverySnapshot {
    kind: 'owned_disposable_retirement_recovery_snapshot';
    progress: OwnedDisposableRecoveryProgress;
    dependencies: DisposableAuthoritySnapshot;
    roots: readonly RecoveryRoot[];
    parents: readonly ParentSnapshot[];
    remaining_file_count: number;
    remaining_bytes: number;
    pending_absent_path: string | null;
    absence_authorized: false;
}

function pendingAbsence(progress: OwnedDisposableRecoveryProgress): string | null {
    const pending = progress.pending_member_path;
    if (pending === null) return null;
    const root = progress.authority.selection.targetRoot, binding = bindContainedDestination(root, path.join(root, pending));
    assertContainedDestination(binding);
    if (binding.missingAt === null) return null;
    if (binding.missingAt !== binding.path) throw new Error('Disposable recovery pending member has unknown absence at an ancestor.');
    return pending;
}

function inspectRoot(progress: OwnedDisposableRecoveryProgress, intent: OwnedDisposableRecoveryRootIntent,
    removed: ReadonlySet<string>, pending: string | null, budget: DisposableInventoryBudget): RecoveryRoot {
    const root = progress.authority.selection.targetRoot, payload = bindContainedDestination(root, path.join(root, intent.path));
    assertContainedDestination(payload);
    const entries = payload.missingAt === null ? inventoryDisposableTree(root, payload, budget) : [];
    const original = new Map(intent.inventory.map(view => [view.path, view])), current = new Map(entries.map(entry => [entry.view.path, entry]));
    if (entries.some(entry => !original.has(entry.view.path))) throw new Error('Disposable recovery remaining membership contains an unknown path.');
    const absent: ContainedDestination[] = [];
    for (const view of intent.inventory) {
        const entry = current.get(view.path), allowed = removed.has(view.path) || view.path === pending;
        if (removed.has(view.path) && entry) throw new Error('Disposable recovery signed removed member was replaced.');
        if (entry) continue;
        const binding = bindContainedDestination(root, path.join(root, view.path));
        assertContainedDestination(binding);
        const missing = binding.missingAt === null ? null : path.relative(root, binding.missingAt).replace(/\\/gu, '/');
        if (!allowed || missing === null || !removed.has(missing) && missing !== pending) {
            throw new Error('Disposable recovery remaining member has unknown absence; preserve the entire selection.');
        }
        absent.push(binding);
    }
    for (const entry of entries) {
        const view = entry.view, expected = original.get(view.path)!;
        const uncertainParent = pending !== null && view.path === path.posix.dirname(pending);
        const identity = view.directory ? progress.parent_identities[view.path] ?? expected.identity : expected.identity;
        if (view.binding_sha256 !== expected.binding_sha256 || view.directory !== expected.directory
            || !uncertainParent && view.identity !== identity || view.bytes !== expected.bytes || view.sha256 !== expected.sha256) {
            throw new Error('Disposable recovery remaining member creation, stat identity or bytes changed.');
        }
    }
    return { registrationId: intent.registration_id, entries, absent };
}

function inspectParents(progress: OwnedDisposableRecoveryProgress, removed: ReadonlySet<string>, pending: string | null): ParentSnapshot[] {
    const root = progress.authority.selection.targetRoot, parents: ParentSnapshot[] = [];
    for (const [relative, expected] of Object.entries(progress.parent_identities)) {
        if (removed.has(relative) || relative === pending) continue;
        const binding = bindContainedDestination(root, path.join(root, relative));
        assertContainedDestination(binding);
        if (binding.missingAt !== null) throw new Error('Disposable recovery signed parent identity has unknown absence.');
        const stat = lstatFileIdentitySync(binding.path, { bigint: true }), identity = scratchStatIdentity(stat);
        if (!stat.isDirectory() || identity !== expected && (pending === null || relative !== path.posix.dirname(pending))) {
            throw new Error('Disposable recovery signed parent identity changed outside the unresolved pending parent.');
        }
        parents.push({ binding, identity });
    }
    return parents;
}

function nativeDependencies(progress: OwnedDisposableRecoveryProgress): DisposableAuthoritySnapshot {
    const { selection, owners, intent, completed } = progress.authority;
    const payloads = intent.roots.map(root => root.inventory.map(view => ({ view })));
    const dependencies = inspectDisposableAuthority(selection.targetRoot, selection.bundleRoot, selection.taskId, payloads);
    if (dependencies.blockers.length) throw new Error(dependencies.blockers.join('; '));
    const digest = digestOwnedDisposableArtifactSnapshot({ selection, completed, authority: dependencies,
        preview: { policy: 'sealed-dead-local-authenticated-closeout-v1' },
        roots: intent.roots.map((root, index) => ({ owner: owners[index], entries: root.inventory.map(view => ({ view })) })) });
    if (digest !== intent.ownership_digest) throw new Error('Disposable recovery original ownership digest differs from current native dependencies.');
    return dependencies;
}

function assertProgressCurrent(previous: OwnedDisposableRecoveryProgress, current: OwnedDisposableRecoveryProgress): void {
    if (previous.authority.journal.identity !== current.authority.journal.identity
        || previous.authority.journal.sha256 !== current.authority.journal.sha256
        || previous.authority.owners.some((owner, index) => owner.ownerFile.identity !== current.authority.owners[index].ownerFile.identity
            || owner.ownerSha256 !== current.authority.owners[index].ownerSha256
            || owner.authorityIdentity !== current.authority.owners[index].authorityIdentity)
        || previous.directoryIdentity !== current.directoryIdentity || previous.frames.length !== current.frames.length
        || previous.frames.some((frame, index) => frame.identity !== current.frames[index].identity || frame.sha256 !== current.frames[index].sha256)) {
        throw new Error('Disposable recovery native intent, owner, private authority or progress changed before publication.');
    }
}

function assertRemainingCurrent(progress: OwnedDisposableRecoveryProgress, roots: readonly RecoveryRoot[], parents: readonly ParentSnapshot[]): void {
    const root = progress.authority.selection.targetRoot;
    for (const [index, snapshot] of roots.entries()) {
        for (const binding of snapshot.absent) assertContainedDestination(binding);
        if (snapshot.entries.length) assertDisposableInventoryCurrent(bindContainedDestination(root,
            path.join(root, progress.authority.intent.roots[index].path)), snapshot.entries);
    }
    for (const parent of parents) {
        assertContainedDestination(parent.binding);
        if (scratchStatIdentity(lstatFileIdentitySync(parent.binding.path, { bigint: true })) !== parent.identity) {
            throw new Error('Disposable recovery surviving parent changed before publication.');
        }
    }
}

// Selection-only, read-only proof. Mutation must reconstruct it under the native lifecycle and producer locks.
export function readOwnedDisposableArtifactRecoverySnapshot(options: OwnedDisposableArtifactJournalSelection): OwnedDisposableRecoverySnapshot {
    const progress = readOwnedDisposableArtifactRecoveryProgress(options), dependencies = nativeDependencies(progress);
    const removed = new Set(progress.order.slice(0, progress.retired_member_count).map(view => view.path));
    const pending = pendingAbsence(progress), budget = { entries: LIMITS.entries, bytes: LIMITS.treeBytes, metadataBytes: LIMITS.metadataBytes };
    const roots = progress.authority.intent.roots.map(intent => inspectRoot(progress, intent, removed, pending, budget));
    const parents = inspectParents(progress, removed, pending);
    assertProgressCurrent(progress, readOwnedDisposableArtifactRecoveryProgress(options));
    assertRemainingCurrent(progress, roots, parents); assertDisposableAuthorityCurrent(dependencies);
    const remaining = roots.flatMap(root => root.entries).filter(entry => !entry.view.directory);
    return { kind: 'owned_disposable_retirement_recovery_snapshot', progress, dependencies, roots, parents,
        remaining_file_count: remaining.length, remaining_bytes: remaining.reduce((sum, entry) => sum + entry.view.bytes, 0),
        pending_absent_path: pending, absence_authorized: false };
}
