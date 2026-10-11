import * as path from 'node:path';
import { assertContainedDestination, bindContainedDestination, type ContainedDestination } from '../../core/contained-filesystem';
import { lstatFileIdentitySync } from '../../core/file-stat';
import { assertDisposableAuthorityCurrent, assertDisposableInventoryCurrent, type DisposableInventoryEntry }
    from './owned-disposable-artifact-inventory';
import type { OwnedDisposableArtifactJournalSelection } from './owned-disposable-artifact-journal';
import { OWNED_DISPOSABLE_PREVIEW_LIMITS as LIMITS } from './owned-disposable-artifact-preview-contracts';
import { readOwnedDisposableArtifactRecoveryAuthority, type OwnedDisposableRecoveryAuthority }
    from './owned-disposable-artifact-recovery-authority';
import { OWNED_DISPOSABLE_PROGRESS_ORDER, OWNED_DISPOSABLE_RECOVERY_MAX_ATTEMPTS }
    from './owned-disposable-artifact-recovery-progress';
import { readOwnedDisposableArtifactRecoverySnapshot, type OwnedDisposableRecoverySnapshot }
    from './owned-disposable-artifact-recovery-snapshot';
import { readScratchFile, scratchStatIdentity, type ScratchFileSnapshot } from './scratch-writer-ownership';

export interface OwnedDisposableRecoveryMutation {
    readonly snapshot: OwnedDisposableRecoverySnapshot;
    readonly journalPath: string;
    readonly journalSha256: string;
    readonly progressDirectory: string;
    check(): void;
    inspect(): OwnedDisposableRecoverySnapshot;
    pending(): DisposableInventoryEntry | null;
    removed(): void;
    reconcilePending(): void;
    finish(): void;
    fail(message: string): void;
}

type Publisher = (record: Record<string, unknown>, proof: OwnedDisposableRecoverySnapshot,
    checkProof: () => void, maximumBytes: number) => ScratchFileSnapshot;
type Parent = { binding: ContainedDestination; identity: string };
type Event = 'RESUMED' | 'PENDING' | 'REMOVED' | 'RECONCILED' | 'ERROR' | 'FINISHED';

export function freezeOwnedDisposableValue(value: object, seen = new Set<object>()): void {
    if (seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') freezeOwnedDisposableValue(child, seen);
    Object.freeze(value);
}

function assertAuthority(previous: OwnedDisposableRecoveryAuthority, current: OwnedDisposableRecoveryAuthority): void {
    if (previous.journal.identity !== current.journal.identity || previous.journal.sha256 !== current.journal.sha256
        || previous.owners.length !== current.owners.length
        || previous.owners.some((owner, index) => owner.ownerFile.identity !== current.owners[index].ownerFile.identity
            || owner.ownerSha256 !== current.owners[index].ownerSha256
            || owner.authorityIdentity !== current.owners[index].authorityIdentity)) {
        throw new Error('Disposable recovery native intent, owner or private authority changed during metadata mutation.');
    }
}

function assertMetadata(previous: OwnedDisposableRecoverySnapshot, current: OwnedDisposableRecoverySnapshot,
    appended?: ScratchFileSnapshot): void {
    const before = previous.progress, after = current.progress;
    assertAuthority(before.authority, after.authority); assertContainedDestination(before.directory);
    if ((!appended && before.directoryIdentity !== after.directoryIdentity)
        || after.frames.length !== before.frames.length + Number(Boolean(appended))
        || before.frames.some((frame, index) => frame.identity !== after.frames[index].identity || frame.sha256 !== after.frames[index].sha256)
        || appended && (after.frames.at(-1)!.identity !== appended.identity || after.frames.at(-1)!.sha256 !== appended.sha256)) {
        throw new Error('Disposable recovery native progress generation, membership or frame changed.');
    }
}

function assertPublicationProof(selection: OwnedDisposableArtifactJournalSelection, proof: OwnedDisposableRecoverySnapshot,
    parent: Parent | null): void {
    const root = proof.progress.authority.selection.targetRoot;
    assertAuthority(proof.progress.authority, readOwnedDisposableArtifactRecoveryAuthority(selection));
    for (const [index, snapshot] of proof.roots.entries()) {
        for (const binding of snapshot.absent) assertContainedDestination(binding);
        if (snapshot.entries.length) assertDisposableInventoryCurrent(bindContainedDestination(root,
            path.join(root, proof.progress.authority.intent.roots[index].path)), snapshot.entries);
    }
    for (const item of parent ? [...proof.parents, parent] : proof.parents) {
        assertContainedDestination(item.binding);
        if (scratchStatIdentity(lstatFileIdentitySync(item.binding.path, { bigint: true })) !== item.identity) {
            throw new Error('Disposable recovery parent changed during metadata publication.');
        }
    }
    assertContainedDestination(proof.progress.directory);
    for (const frame of proof.progress.frames) {
        const current = readScratchFile(frame.binding, LIMITS.metadataBytes);
        if (current.identity !== frame.identity || current.sha256 !== frame.sha256) {
            throw new Error('Disposable recovery retained progress changed during metadata publication.');
        }
    }
    assertDisposableAuthorityCurrent(proof.dependencies);
}

function parentSnapshot(root: string, member: string): Parent {
    const binding = bindContainedDestination(root, path.dirname(path.join(root, member)));
    assertContainedDestination(binding);
    const stat = lstatFileIdentitySync(binding.path, { bigint: true });
    if (!stat.isDirectory()) throw new Error('Disposable recovery pending parent is not an ordinary directory.');
    return { binding, identity: scratchStatIdentity(stat) };
}

// Internal state machine: only the native journal gateway supplies the private authenticated publisher and lock guard.
export function createOwnedDisposableRecoveryMutation(selection: OwnedDisposableArtifactJournalSelection,
    publish: Publisher, checkLocks: () => void): OwnedDisposableRecoveryMutation {
    let current = readOwnedDisposableArtifactRecoverySnapshot(selection), issued: DisposableInventoryEntry | null = null;
    const initial = current, inheritedPending = current.progress.pending_member_path;
    freezeOwnedDisposableValue(initial);
    let settled = current.progress.status === 'FINISHED';
    function inspect(): OwnedDisposableRecoverySnapshot {
        checkLocks();
        const proof = readOwnedDisposableArtifactRecoverySnapshot(selection);
        assertMetadata(current, proof); checkLocks(); freezeOwnedDisposableValue(proof);
        return proof;
    }
    function append(event: Event, member: string | null = null, error: string | null = null): void {
        const proof = inspect(), progress = proof.progress, view = progress.order[progress.retired_member_count];
        const removed = event === 'REMOVED', reconciled = event === 'RECONCILED';
        if (settled || event === 'RESUMED' && progress.resume_attempt_count >= OWNED_DISPOSABLE_RECOVERY_MAX_ATTEMPTS) {
            throw new Error('Disposable recovery is settled or exceeds its resume attempt allowance.');
        }
        const parent = (removed || reconciled) && member !== null
            ? parentSnapshot(progress.authority.selection.targetRoot, member) : null;
        const record = { intent_sha256: progress.authority.journal.sha256, ownership_digest: selection.ownershipDigest,
            order: OWNED_DISPOSABLE_PROGRESS_ORDER, sequence: progress.frames.length,
            previous_sha256: progress.frames.at(-1)?.sha256 ?? null, event, member_path: member,
            removed_member_count: progress.known_removed_member_count + Number(removed),
            removed_file_count: progress.known_removed_file_count + Number(removed && !view.directory),
            removed_bytes: progress.known_removed_bytes + (removed ? view.bytes : 0),
            error, parent_identity: parent?.identity ?? null, resume_version: 1,
            resume_attempt: progress.resume_attempt_count + Number(event === 'RESUMED'),
            reconciled_member_count: progress.reconciled_member_count + Number(reconciled),
            reconciled_file_count: progress.reconciled_file_count + Number(reconciled && !view.directory),
            reconciled_bytes: progress.reconciled_bytes + (reconciled ? view.bytes : 0) };
        const remainingBytes = LIMITS.metadataBytes - progress.frames.reduce((sum, frame) => sum + frame.bytes, 0);
        const frame = publish(record, proof, () => {
            checkLocks(); assertPublicationProof(selection, proof, parent); checkLocks();
        }, remainingBytes);
        const after = readOwnedDisposableArtifactRecoverySnapshot(selection);
        assertMetadata(proof, after, frame); checkLocks(); freezeOwnedDisposableValue(after); current = after;
    }
    if (!settled) append('RESUMED', current.progress.pending_member_path);
    return Object.freeze({ snapshot: initial, journalPath: initial.progress.authority.journal.binding.path,
        journalSha256: initial.progress.authority.journal.sha256, progressDirectory: initial.progress.directory.path,
        inspect, check: () => { inspect(); },
        pending: () => {
            if (issued || settled && current.progress.status !== 'FINISHED') throw new Error('Disposable recovery has unresolved or settled current mutation.');
            const proof = inspect(), member = proof.progress.order[proof.progress.retired_member_count];
            if (!member) return null;
            if (proof.pending_absent_path !== null) throw new Error('Disposable recovery signed pending absence requires explicit reconciliation, never current removal accounting.');
            const entry = proof.roots.flatMap(root => root.entries).find(candidate => candidate.view.path === member.path);
            if (!entry) throw new Error('Disposable recovery current member has no exact retained native entry.');
            if (proof.progress.pending_member_path === null) append('PENDING', member.path);
            if (inspect().pending_absent_path !== null) throw new Error('Disposable recovery pending member disappeared before current mutation authorization.');
            freezeOwnedDisposableValue(entry); issued = entry; return entry;
        },
        removed: () => {
            const proof = inspect();
            if (!issued || settled || proof.progress.pending_member_path !== issued.view.path
                || proof.pending_absent_path !== issued.view.path) throw new Error('Disposable recovery current removal lacks its issued member and exact pending absence.');
            append('REMOVED', issued.view.path); issued = null;
        },
        reconcilePending: () => {
            const proof = inspect();
            if (issued || settled || proof.pending_absent_path === null
                || proof.pending_absent_path !== proof.progress.pending_member_path
                || proof.pending_absent_path !== inheritedPending) {
                throw new Error('Disposable recovery reconciliation requires only the one unissued signed pending absence captured at resume.');
            }
            append('RECONCILED', proof.pending_absent_path);
        },
        finish: () => {
            const proof = inspect();
            if (proof.progress.status === 'FINISHED') return;
            if (issued || proof.progress.pending_member_path !== null || proof.progress.retired_member_count !== proof.progress.order.length) {
                throw new Error('Disposable recovery cannot finish with unresolved or remaining members.');
            }
            append('FINISHED'); settled = true;
        },
        fail: (message: string) => {
            const proof = inspect();
            if (typeof message !== 'string') throw new Error('Disposable recovery error must be a bounded string.');
            append('ERROR', proof.progress.pending_member_path, message.slice(0, 1000)); settled = true;
        }
    });
}
