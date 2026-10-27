import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertContainedDestination, bindContainedDestination } from '../../core/contained-filesystem';
import { isPlainRecord } from '../../core/records';
import { inspectCompletedTaskEvidence, type CompletedTaskEvidence } from './completed-task-evidence';
import type { OwnedDisposableArtifactInspection } from './owned-disposable-artifact-contracts';
import { readOwnedDisposableRetirementIntent, type OwnedDisposableArtifactJournalSelection }
    from './owned-disposable-artifact-journal';
import { OWNED_DISPOSABLE_PREVIEW_LIMITS as LIMITS, type OwnedDisposableArtifactFilePreview,
    type OwnedDisposableArtifactPreviewSelection } from './owned-disposable-artifact-preview-contracts';
import { inspectOwnedDisposableArtifactOwner, type OwnedDisposableArtifactOwnerInspection }
    from './owned-disposable-artifact-registration';
import { scratchBindingIdentity, type ScratchFileSnapshot } from './scratch-writer-ownership';

const HASH = /^[0-9a-f]{64}$/u;
const INTENT_KEYS = ['policy', 'workspace_root', 'bundle_root', 'task_id', 'registration_ids', 'ownership_digest',
    'compact_evidence_sha256', 'completion_event_sha256', 'commit_sha', 'file_count', 'total_bytes', 'roots'];
const ROOT_KEYS = ['registration_id', 'run_id', 'category', 'path', 'owner_sha256', 'root_creation_identity', 'inventory'];
const MEMBER_KEYS = ['path', 'directory', 'identity', 'binding_sha256', 'bytes', 'sha256'];

export interface OwnedDisposableRecoveryRootIntent {
    registration_id: string;
    run_id: string;
    category: OwnedDisposableArtifactInspection['record']['category'];
    path: string;
    owner_sha256: string;
    root_creation_identity: string;
    parent_creation_identity?: string;
    owner_identity?: string;
    inventory: OwnedDisposableArtifactFilePreview[];
}

export interface OwnedDisposableRecoveryIntent {
    policy: string;
    workspace_root: string;
    bundle_root: string;
    task_id: string;
    registration_ids: string[];
    ownership_digest: string;
    authority_identity?: string;
    compact_evidence_sha256: string;
    completion_event_sha256: string;
    commit_sha: string;
    file_count: number;
    total_bytes: number;
    roots: OwnedDisposableRecoveryRootIntent[];
}

export interface OwnedDisposableRecoveryAuthority {
    kind: 'owned_disposable_retirement_authority';
    selection: OwnedDisposableArtifactPreviewSelection;
    journal: ScratchFileSnapshot;
    intent: OwnedDisposableRecoveryIntent;
    owners: OwnedDisposableArtifactOwnerInspection[];
    completed: CompletedTaskEvidence;
    absence_authorized: false;
}

function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
    if (!isPlainRecord(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) {
        throw new Error(`Disposable recovery ${label} has an unsupported schema.`);
    }
}

function canonicalRelative(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || !value || value.length > LIMITS.pathCharacters || /[\\\u0000-\u001f]/u.test(value)
        || /^[A-Za-z]:/u.test(value)
        || value.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error(`Disposable recovery ${label} is not a canonical bounded relative path.`);
    }
}

function readIntent(value: unknown, selection: OwnedDisposableArtifactPreviewSelection,
    digest: string, authorityIdentity: string): OwnedDisposableRecoveryIntent {
    const anchoredAuthority = isPlainRecord(value) && Object.hasOwn(value, 'authority_identity');
    exactKeys(value, anchoredAuthority ? [...INTENT_KEYS, 'authority_identity'] : INTENT_KEYS, 'intent');
    if (value.policy !== 'sealed-dead-local-authenticated-closeout-v1'
        || value.workspace_root !== selection.targetRoot || value.bundle_root !== selection.bundleRoot
        || value.task_id !== selection.taskId || value.ownership_digest !== digest
        || anchoredAuthority && value.authority_identity !== authorityIdentity
        || JSON.stringify(value.registration_ids) !== JSON.stringify(selection.registrationIds)
        || !['compact_evidence_sha256', 'completion_event_sha256'].every(field => typeof value[field] === 'string'
            && HASH.test(value[field] as string))
        || typeof value.commit_sha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.commit_sha)
        || typeof value.file_count !== 'number' || !Number.isSafeInteger(value.file_count) || value.file_count < 0
        || typeof value.total_bytes !== 'number' || !Number.isSafeInteger(value.total_bytes) || value.total_bytes < 0
        || value.total_bytes > LIMITS.treeBytes || !Array.isArray(value.roots)
        || value.roots.length !== selection.registrationIds.length) {
        throw new Error('Disposable recovery intent does not match the exact native selection or bounded counters.');
    }
    let entries = 0, files = 0, bytes = 0, anchoredRoots = 0;
    const allPaths = new Set<string>();
    for (const [index, root] of value.roots.entries()) {
        const anchored = isPlainRecord(root) && Object.hasOwn(root, 'parent_creation_identity');
        exactKeys(root, anchored ? [...ROOT_KEYS, 'parent_creation_identity', 'owner_identity'] : ROOT_KEYS, 'root');
        if (root.registration_id !== selection.registrationIds[index]
            || !['run_id', 'owner_sha256', 'root_creation_identity'].every(field => typeof root[field] === 'string'
                && HASH.test(root[field] as string))
            || anchored && (typeof root.parent_creation_identity !== 'string' || !HASH.test(root.parent_creation_identity))
            || anchored && (typeof root.owner_identity !== 'string' || !HASH.test(root.owner_identity))
            || !Array.isArray(root.inventory) || !root.inventory.length || root.inventory.length > LIMITS.entries) {
            throw new Error('Disposable recovery root has invalid selection, identity or bounded inventory.');
        }
        anchoredRoots += Number(anchored); canonicalRelative(root.path, 'root path');
        const members = new Map<string, boolean>();
        let previous = '';
        for (const member of root.inventory) {
            exactKeys(member, MEMBER_KEYS, 'member'); canonicalRelative(member.path, 'member path');
            if (++entries > LIMITS.entries || member.path <= previous || allPaths.has(member.path)
                || member.path !== root.path && !member.path.startsWith(root.path + '/')
                || path.relative(root.path, member.path).split(path.sep).length > LIMITS.pathDepth
                || typeof member.directory !== 'boolean' || typeof member.identity !== 'string' || !HASH.test(member.identity)
                || typeof member.binding_sha256 !== 'string' || !HASH.test(member.binding_sha256)
                || typeof member.bytes !== 'number' || !Number.isSafeInteger(member.bytes) || member.bytes < 0
                || member.bytes > LIMITS.fileBytes || member.directory && (member.bytes !== 0 || member.sha256 !== null)
                || !member.directory && (typeof member.sha256 !== 'string' || !HASH.test(member.sha256))) {
                throw new Error('Disposable recovery member has unverifiable order, containment, identity or byte accounting.');
            }
            previous = member.path; allPaths.add(member.path); members.set(member.path, member.directory);
            if (!member.directory) files += 1;
            bytes += member.bytes;
            if (bytes > LIMITS.treeBytes) throw new Error('Disposable recovery aggregate byte allowance exceeded.');
        }
        if (members.get(root.path) !== true || [...members.keys()].some(member => member !== root.path
            && members.get(path.posix.dirname(member)) !== true)) {
            throw new Error('Disposable recovery inventory lacks its exact root or a declared directory ancestor.');
        }
    }
    if (files !== value.file_count || bytes !== value.total_bytes
        || anchoredRoots !== (anchoredAuthority ? value.roots.length : 0)) {
        throw new Error('Disposable recovery intent counters or parent-anchor format are inconsistent.');
    }
    return value as unknown as OwnedDisposableRecoveryIntent;
}

function completedCurrent(selection: OwnedDisposableArtifactPreviewSelection, intent: OwnedDisposableRecoveryIntent) {
    const completed = inspectCompletedTaskEvidence({ repoRoot: selection.targetRoot, taskId: selection.taskId });
    if (!completed.eligible || completed.evidence_sha256 !== intent.compact_evidence_sha256
        || completed.completion_event_sha256 !== intent.completion_event_sha256 || completed.commit_sha !== intent.commit_sha) {
        throw new Error('Disposable recovery committed native compact evidence changed or is ineligible.');
    }
    return completed;
}

function ownerCurrent(selection: OwnedDisposableArtifactPreviewSelection, intent: OwnedDisposableRecoveryRootIntent,
    authorityIdentity: string) {
    const owner = inspectOwnedDisposableArtifactOwner({ targetRoot: selection.targetRoot, bundleRoot: selection.bundleRoot,
        taskId: selection.taskId, registrationId: intent.registration_id });
    if (owner.authorityIdentity !== authorityIdentity) {
        throw new Error('Disposable recovery owner used a changed private authority generation.');
    }
    if (!owner.record.sealed_at_utc || owner.producerState !== 'dead' || owner.ownerSha256 !== intent.owner_sha256
        || intent.owner_identity && owner.ownerFile.identity !== intent.owner_identity
        || owner.record.run_id !== intent.run_id || owner.record.category !== intent.category
        || owner.record.root_creation_identity !== intent.root_creation_identity
        || path.relative(selection.targetRoot, owner.rootBinding.path).replace(/\\/gu, '/') !== intent.path) {
        throw new Error('Disposable recovery requires the same signed sealed positively known-dead local owner and native run.');
    }
    const parent = bindContainedDestination(selection.targetRoot, path.dirname(owner.rootBinding.path));
    assertContainedDestination(parent);
    if (parent.missingAt !== null || !fs.lstatSync(parent.path).isDirectory()
        || intent.parent_creation_identity && scratchBindingIdentity(parent) !== intent.parent_creation_identity) {
        throw new Error('Disposable recovery surviving payload parent creation identity changed or is missing.');
    }
    if (owner.rootBinding.missingAt !== null && !intent.parent_creation_identity) {
        throw new Error('Legacy disposable intent lacks the surviving-parent anchor required to inspect an absent payload.');
    }
    return owner;
}

/** Recheck native owner and journal after a completed audit and immediately before removal. */
export function assertOwnedDisposableRecoveryOwnerCurrent(options: OwnedDisposableArtifactJournalSelection,
    previous: OwnedDisposableRecoveryAuthority): void {
    const native = readOwnedDisposableRetirementIntent(options);
    if (native.file.identity !== previous.journal.identity || native.file.sha256 !== previous.journal.sha256
        || previous.owners.some(owner => owner.authorityIdentity !== native.authorityIdentity)) {
        throw new Error('Disposable recovery intent or private authority changed before removal.');
    }
    const intent = readIntent(native.intent, native.selection, options.ownershipDigest, native.authorityIdentity);
    if (intent.roots.length !== previous.owners.length) throw new Error('Disposable recovery owner membership changed before removal.');
    for (const [index, root] of intent.roots.entries()) {
        const owner = ownerCurrent(native.selection, root, native.authorityIdentity), expected = previous.owners[index];
        if (owner.ownerFile.identity !== expected.ownerFile.identity || owner.ownerSha256 !== expected.ownerSha256
            || scratchBindingIdentity(owner.ownerFile.binding) !== scratchBindingIdentity(expected.ownerFile.binding)) {
            throw new Error('Disposable recovery owner changed before removal.');
        }
    }
    const current = readOwnedDisposableRetirementIntent(options);
    if (current.file.identity !== native.file.identity || current.file.sha256 !== native.file.sha256
        || current.authorityIdentity !== native.authorityIdentity) {
        throw new Error('Disposable recovery intent changed before removal.');
    }
}

// This authenticates metadata only: remaining-tree validation and signed progress are still required before recovery.
export function readOwnedDisposableArtifactRecoveryAuthority(options: OwnedDisposableArtifactJournalSelection): OwnedDisposableRecoveryAuthority {
    const native = readOwnedDisposableRetirementIntent(options), intent = readIntent(native.intent, native.selection,
        options.ownershipDigest, native.authorityIdentity);
    const completed = completedCurrent(native.selection, intent), owners = intent.roots.map(root =>
        ownerCurrent(native.selection, root, native.authorityIdentity));
    completedCurrent(native.selection, intent);
    for (const [index, root] of intent.roots.entries()) {
        const owner = ownerCurrent(native.selection, root, native.authorityIdentity);
        if (owner.ownerFile.identity !== owners[index].ownerFile.identity
            || scratchBindingIdentity(owner.ownerFile.binding) !== scratchBindingIdentity(owners[index].ownerFile.binding)) {
            throw new Error('Disposable recovery owner identity changed during native authority reconstruction.');
        }
    }
    const current = readOwnedDisposableRetirementIntent(options);
    if (current.file.identity !== native.file.identity || current.file.sha256 !== native.file.sha256
        || current.authorityIdentity !== native.authorityIdentity) {
        throw new Error('Disposable recovery intent changed during native authority reconstruction.');
    }
    return { kind: 'owned_disposable_retirement_authority', selection: native.selection, journal: native.file,
        intent, owners, completed, absence_authorized: false };
}
