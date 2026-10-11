import * as path from 'node:path';
import { isPlainRecord } from '../../core/records';
import type { ContainedDestination } from '../../core/contained-filesystem';
import { disposableRemovalOrder } from './owned-disposable-artifact-inventory';
import { readOwnedDisposableRetirementProgress, type OwnedDisposableArtifactJournalSelection }
    from './owned-disposable-artifact-journal';
import { OWNED_DISPOSABLE_PREVIEW_LIMITS as LIMITS, type OwnedDisposableArtifactFilePreview }
    from './owned-disposable-artifact-preview-contracts';
import { readOwnedDisposableArtifactRecoveryAuthority, type OwnedDisposableRecoveryAuthority }
    from './owned-disposable-artifact-recovery-authority';
import type { ScratchFileSnapshot } from './scratch-writer-ownership';

const HASH = /^[0-9a-f]{64}$/u;
export const OWNED_DISPOSABLE_PROGRESS_ORDER = 'files-then-deepest-directories-per-registration-v1';
const FIELDS = ['intent_sha256', 'ownership_digest', 'order', 'sequence', 'previous_sha256', 'event', 'member_path',
    'removed_member_count', 'removed_file_count', 'removed_bytes', 'error', 'parent_identity'];
const RESUME_FIELDS = [...FIELDS, 'resume_version', 'resume_attempt', 'reconciled_member_count', 'reconciled_file_count', 'reconciled_bytes'];
export const OWNED_DISPOSABLE_RECOVERY_MAX_ATTEMPTS = 64;
type ProgressTransport = ReturnType<typeof readOwnedDisposableRetirementProgress>;

export interface OwnedDisposableRecoveryProgress {
    kind: 'owned_disposable_retirement_progress_metadata';
    authority: OwnedDisposableRecoveryAuthority;
    directory: ContainedDestination;
    directoryIdentity: string | null;
    frames: readonly ScratchFileSnapshot[];
    order: readonly OwnedDisposableArtifactFilePreview[];
    status: 'UNSTARTED' | 'PENDING' | 'PARTIAL' | 'ERROR' | 'FINISHED';
    known_removed_member_count: number;
    known_removed_file_count: number;
    known_removed_bytes: number;
    retired_member_count: number;
    reconciled_member_count: number;
    reconciled_file_count: number;
    reconciled_bytes: number;
    resume_attempt_count: number;
    pending_member_path: string | null;
    parent_identities: Readonly<Record<string, string>>;
    last_error: string | null;
    absence_authorized: false;
}

function assertNativeAuthority(authority: OwnedDisposableRecoveryAuthority, transport: ProgressTransport): void {
    if (authority.journal.identity !== transport.native.file.identity || authority.journal.sha256 !== transport.native.file.sha256
        || authority.owners.some(owner => owner.authorityIdentity !== transport.native.authorityIdentity)) {
        throw new Error('Disposable progress differs from the authenticated owner, intent or private authority generation.');
    }
}

function decode(authority: OwnedDisposableRecoveryAuthority, transport: ProgressTransport): OwnedDisposableRecoveryProgress {
    const order = authority.intent.roots.flatMap(root => disposableRemovalOrder(root.inventory.map(view => ({ view }))))
        .map(entry => entry.view);
    if (transport.frames.length > order.length * 2 + OWNED_DISPOSABLE_RECOVERY_MAX_ATTEMPTS * 2 + 2) {
        throw new Error('Disposable progress frame allowance exceeded.');
    }
    let members = 0, removed = 0, files = 0, bytes = 0, reconciled = 0, reconciledFiles = 0, reconciledBytes = 0,
        attempts = 0, activeAttempt = false, reconcileCandidate: string | null = null,
        pending: string | null = null, error: string | null = null;
    let status: OwnedDisposableRecoveryProgress['status'] = 'UNSTARTED';
    const parents: Record<string, string> = Object.create(null);
    for (const [index, frame] of transport.frames.entries()) {
        const value = frame.record.progress;
        const extended = isPlainRecord(value) && value.resume_version === 1;
        if (!isPlainRecord(value) || Object.keys(value).sort().join('|') !== [...(extended ? RESUME_FIELDS : FIELDS)].sort().join('|')
            || value.intent_sha256 !== authority.journal.sha256 || value.ownership_digest !== authority.intent.ownership_digest
            || value.order !== OWNED_DISPOSABLE_PROGRESS_ORDER || value.sequence !== index
            || value.previous_sha256 !== (index ? transport.frames[index - 1].file.sha256 : null)
            || status === 'FINISHED' || status === 'ERROR' && (!extended || value.event !== 'RESUMED')
            || !extended && attempts > 0 || extended && !activeAttempt && value.event !== 'RESUMED') {
            throw new Error('Disposable progress has an unsupported schema, chain, order or settled-state transition.');
        }
        const member = order[members];
        if (value.event === 'RESUMED') {
            if (!extended || value.member_path !== pending || value.error !== null || value.parent_identity !== null
                || ++attempts > OWNED_DISPOSABLE_RECOVERY_MAX_ATTEMPTS) {
                throw new Error('Disposable progress resume attempt is unsupported, ambiguous or exceeds its allowance.');
            }
            activeAttempt = true; reconcileCandidate = pending; error = null;
            status = pending === null ? members ? 'PARTIAL' : 'UNSTARTED' : 'PENDING';
        } else if (value.event === 'PENDING') {
            if (pending !== null || !member || value.member_path !== member.path || value.error !== null
                || value.parent_identity !== null) throw new Error('Disposable progress pending member is ambiguous or out of order.');
            pending = member.path; status = 'PENDING';
        } else if (value.event === 'REMOVED' || value.event === 'RECONCILED') {
            if (!member || pending !== member.path || value.member_path !== pending || value.error !== null
                || typeof value.parent_identity !== 'string' || !HASH.test(value.parent_identity)
                || value.event === 'RECONCILED' && (!extended || member.path !== reconcileCandidate)) {
                throw new Error('Disposable progress removed member lacks its exact pending record or signed parent identity.');
            }
            parents[path.posix.dirname(member.path)] = value.parent_identity;
            members += 1;
            if (value.event === 'REMOVED') { removed += 1; files += Number(!member.directory); bytes += member.bytes; }
            else { reconciled += 1; reconciledFiles += Number(!member.directory); reconciledBytes += member.bytes; }
            pending = null; reconcileCandidate = null; status = 'PARTIAL';
        } else if (value.event === 'ERROR') {
            if (value.member_path !== pending || typeof value.error !== 'string' || value.error.length > 1000
                || value.parent_identity !== null) throw new Error('Disposable progress error does not match its unresolved state.');
            error = value.error; status = 'ERROR'; activeAttempt = false;
        } else if (value.event === 'FINISHED') {
            if (pending !== null || members !== order.length || value.member_path !== null || value.error !== null
                || value.parent_identity !== null) throw new Error('Disposable progress finished before exact completion.');
            status = 'FINISHED';
        } else throw new Error('Disposable progress event is unsupported.');
        if (value.removed_member_count !== removed || value.removed_file_count !== files || value.removed_bytes !== bytes
            || extended && (value.resume_attempt !== attempts || value.reconciled_member_count !== reconciled
                || value.reconciled_file_count !== reconciledFiles || value.reconciled_bytes !== reconciledBytes)) {
            throw new Error('Disposable progress counters do not equal the signed successful member prefix.');
        }
    }
    if (transport.frames.length > order.length * 2 + attempts * 2 + 2) throw new Error('Disposable progress frame allowance exceeded.');
    return { kind: 'owned_disposable_retirement_progress_metadata', authority, directory: transport.directory,
        directoryIdentity: transport.directoryIdentity, frames: transport.frames.map(frame => frame.file), order, status,
        known_removed_member_count: removed, known_removed_file_count: files, known_removed_bytes: bytes,
        retired_member_count: members, reconciled_member_count: reconciled, reconciled_file_count: reconciledFiles,
        reconciled_bytes: reconciledBytes, resume_attempt_count: attempts,
        pending_member_path: pending, parent_identities: parents, last_error: error, absence_authorized: false };
}

function assertTransportCurrent(previous: ProgressTransport, current: ProgressTransport): void {
    if (previous.native.file.identity !== current.native.file.identity || previous.native.file.sha256 !== current.native.file.sha256
        || previous.native.authorityIdentity !== current.native.authorityIdentity
        || previous.directoryIdentity !== current.directoryIdentity || previous.frames.length !== current.frames.length
        || previous.frames.some((frame, index) => frame.file.identity !== current.frames[index].file.identity
            || frame.file.sha256 !== current.frames[index].file.sha256)) {
        throw new Error('Disposable progress native metadata changed before publication.');
    }
}

// This describes signed metadata only; surviving payload/dependency validation remains a separate requirement.
export function readOwnedDisposableArtifactRecoveryProgress(options: OwnedDisposableArtifactJournalSelection): OwnedDisposableRecoveryProgress {
    const authority = readOwnedDisposableArtifactRecoveryAuthority(options), transport = readOwnedDisposableRetirementProgress(options);
    assertNativeAuthority(authority, transport);
    const progress = decode(authority, transport), currentAuthority = readOwnedDisposableArtifactRecoveryAuthority(options);
    const current = readOwnedDisposableRetirementProgress(options);
    assertNativeAuthority(currentAuthority, current); assertTransportCurrent(transport, current);
    if (authority.owners.some((owner, index) => owner.ownerFile.identity !== currentAuthority.owners[index].ownerFile.identity
        || owner.ownerSha256 !== currentAuthority.owners[index].ownerSha256)) {
        throw new Error('Disposable progress native owner changed before publication.');
    }
    if (progress.order.length > LIMITS.entries) throw new Error('Disposable progress inventory allowance exceeded.');
    return progress;
}
