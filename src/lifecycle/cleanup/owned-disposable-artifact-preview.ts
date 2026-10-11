import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPlainRecord } from '../../core/records';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { inspectCompletedTaskEvidence, type CompletedTaskEvidence } from './completed-task-evidence';
import { inspectOwnedDisposableArtifact } from './owned-disposable-artifact-registration';
import type { OwnedDisposableArtifactInspection } from './owned-disposable-artifact-contracts';
import { OWNED_DISPOSABLE_PREVIEW_LIMITS as LIMITS, type OwnedDisposableArtifactItemPreview,
    type OwnedDisposableArtifactPreview, type OwnedDisposableArtifactPreviewSelection } from './owned-disposable-artifact-preview-contracts';
import { assertDisposableAuthorityCurrent, assertDisposableInventoryCurrent, inspectDisposableAuthority,
    inventoryDisposableTree, type DisposableAuthoritySnapshot, type DisposableInventoryEntry } from './owned-disposable-artifact-inventory';
import { resolveScratchWriterLocations, scratchBindingIdentity, scratchPathKey, scratchSha256 } from './scratch-writer-ownership';

export interface DisposableRootSnapshot {
    registrationId: string;
    owner: OwnedDisposableArtifactInspection;
    entries: DisposableInventoryEntry[];
}
export interface OwnedDisposableArtifactSnapshot {
    selection: OwnedDisposableArtifactPreviewSelection;
    roots: DisposableRootSnapshot[];
    completed: CompletedTaskEvidence | null;
    authority: DisposableAuthoritySnapshot | null;
    preview: OwnedDisposableArtifactPreview;
}

export function normalizeOwnedDisposableArtifactSelection(options: OwnedDisposableArtifactPreviewSelection): OwnedDisposableArtifactPreviewSelection {
    if (!isPlainRecord(options) || Object.keys(options).sort().join('|') !== 'bundleRoot|registrationIds|targetRoot|taskId'
        || !Array.isArray(options.registrationIds) || !options.registrationIds.length
        || options.registrationIds.length > LIMITS.selectedRoots
        || ![...options.registrationIds].every(id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id))
        || new Set(options.registrationIds).size !== options.registrationIds.length) {
        throw new Error('Disposable preview requires exact declared fields and an explicit nonempty bounded unique native registration selection.');
    }
    if (assertCanonicalTaskId(options.taskId) !== options.taskId) throw new Error('Disposable preview task id must be canonical.');
    const locations = resolveScratchWriterLocations({ targetRoot: options.targetRoot, bundleRoot: options.bundleRoot,
        scratchName: 'disposable-producer-registry' });
    if (scratchPathKey(fs.realpathSync.native(locations.root)) !== scratchPathKey(locations.root)) {
        throw new Error('Disposable preview requires the canonical workspace root.');
    }
    return { targetRoot: locations.root, bundleRoot: locations.bundleRoot, taskId: options.taskId,
        registrationIds: [...options.registrationIds].sort() };
}

function inspectSealedDeadOwner(selection: OwnedDisposableArtifactPreviewSelection, registrationId: string) {
    const owner = inspectOwnedDisposableArtifact({ targetRoot: selection.targetRoot,
        bundleRoot: selection.bundleRoot, taskId: selection.taskId, registrationId });
    if (!owner.record.sealed_at_utc || owner.producerState !== 'dead') {
        throw new Error(`Disposable producer is ${owner.producerState}, ${owner.record.sealed_at_utc ? 'sealed' : 'unsealed'}; only sealed positively known-dead local ownership permits preview.`);
    }
    return owner;
}

function completedEvidence(selection: OwnedDisposableArtifactPreviewSelection): CompletedTaskEvidence {
    const evidence = inspectCompletedTaskEvidence({ repoRoot: selection.targetRoot, taskId: selection.taskId });
    if (!evidence.eligible || !evidence.evidence_sha256 || !evidence.completion_event_sha256 || !evidence.commit_sha) {
        throw new Error(`Disposable cleanup requires current authenticated committed native closeout and compact ledger: ${evidence.reasons.join('; ')}.`);
    }
    return evidence;
}

export function assertOwnedDisposableSnapshotCurrent(snapshot: OwnedDisposableArtifactSnapshot): void {
    const completed = completedEvidence(snapshot.selection);
    if (completed.evidence_sha256 !== snapshot.completed?.evidence_sha256) {
        throw new Error('Native completed task/compact evidence changed before preview publication.');
    }
    for (const root of snapshot.roots) {
        const owner = inspectSealedDeadOwner(snapshot.selection, root.registrationId);
        if (owner.ownerSha256 !== root.owner.ownerSha256
            || scratchBindingIdentity(owner.rootBinding) !== scratchBindingIdentity(root.owner.rootBinding)) {
            throw new Error('Disposable ownership or native run changed before preview publication.');
        }
        assertDisposableInventoryCurrent(root.owner.rootBinding, root.entries);
    }
    if (!snapshot.authority) throw new Error('Disposable dependency authority is missing.');
    assertDisposableAuthorityCurrent(snapshot.authority);
}

type DisposableDigestInput = Pick<OwnedDisposableArtifactSnapshot, 'selection' | 'completed' | 'authority'> & {
    preview: Pick<OwnedDisposableArtifactPreview, 'policy'>;
    roots: readonly { owner: Pick<OwnedDisposableArtifactInspection, 'record' | 'ownerSha256'>;
        entries: readonly Pick<DisposableInventoryEntry, 'view'>[] }[];
};

export function digestOwnedDisposableArtifactSnapshot(snapshot: DisposableDigestInput): string {
    return scratchSha256(JSON.stringify({ policy: snapshot.preview.policy, limits: LIMITS,
        root: scratchPathKey(snapshot.selection.targetRoot), bundle: scratchPathKey(snapshot.selection.bundleRoot),
        task: snapshot.selection.taskId, registrations: snapshot.selection.registrationIds,
        compact: snapshot.completed, roots: snapshot.roots.map(root => ({ registration: root.owner.record,
            owner_sha256: root.owner.ownerSha256, tree: root.entries.map(entry => entry.view) })),
        dependencies: snapshot.authority!.files.map(file => ({ path: scratchPathKey(file.binding.path),
            binding: scratchBindingIdentity(file.binding), identity: file.identity, sha256: file.sha256, bytes: file.bytes }))
            .sort((left, right) => left.path < right.path ? -1 : 1),
        directories: snapshot.authority!.directories.map(directory => ({ path: scratchPathKey(directory.binding.path),
            binding: scratchBindingIdentity(directory.binding), identity: directory.identity })),
        absent: snapshot.authority!.absent.map(binding => ({ path: scratchPathKey(binding.path), binding: scratchBindingIdentity(binding) })) }));
}

export function buildOwnedDisposableArtifactSnapshot(options: OwnedDisposableArtifactPreviewSelection): OwnedDisposableArtifactSnapshot {
    const preview: OwnedDisposableArtifactPreview = { schema_version: 1, kind: 'owned_disposable_artifact_preview',
        policy: 'sealed-dead-local-authenticated-closeout-v1', status: 'BLOCKED', task_id: '', registration_ids: [],
        items: [], file_count: 0, total_bytes: 0, compact_evidence_sha256: null, ownership_digest: null, blockers: [] };
    const snapshot: OwnedDisposableArtifactSnapshot = { selection: options, preview, roots: [], completed: null, authority: null };
    try {
        snapshot.selection = normalizeOwnedDisposableArtifactSelection(options);
        preview.task_id = snapshot.selection.taskId; preview.registration_ids = [...snapshot.selection.registrationIds];
        snapshot.completed = completedEvidence(snapshot.selection);
        preview.compact_evidence_sha256 = snapshot.completed.evidence_sha256;
        const budget = { entries: LIMITS.entries, bytes: LIMITS.treeBytes, metadataBytes: LIMITS.metadataBytes };
        for (const registrationId of snapshot.selection.registrationIds) {
            const item: OwnedDisposableArtifactItemPreview = { registration_id: registrationId, category: null, path: null,
                run_id: null, owner_sha256: null, state: 'protected', file_count: 0, bytes: 0, inventory: [], blockers: [] };
            preview.items.push(item);
            try {
                const owner = inspectSealedDeadOwner(snapshot.selection, registrationId);
                item.category = owner.record.category; item.run_id = owner.record.run_id; item.owner_sha256 = owner.ownerSha256;
                item.path = path.relative(snapshot.selection.targetRoot, owner.rootBinding.path).replace(/\\/gu, '/');
                const entries = inventoryDisposableTree(snapshot.selection.targetRoot, owner.rootBinding, budget);
                item.inventory = entries.map(entry => entry.view); item.file_count = entries.filter(entry => !entry.view.directory).length;
                item.bytes = entries.reduce((sum, entry) => sum + entry.view.bytes, 0);
                snapshot.roots.push({ registrationId, owner, entries });
            } catch (error) { item.blockers.push(error instanceof Error ? error.message : String(error)); }
        }
        for (const item of preview.items) preview.blockers.push(...item.blockers.map(blocker => `${item.registration_id}: ${blocker}`));
        preview.file_count = preview.items.reduce((sum, item) => sum + item.file_count, 0);
        preview.total_bytes = preview.items.reduce((sum, item) => sum + item.bytes, 0);
        if (!preview.blockers.length) {
            snapshot.authority = inspectDisposableAuthority(snapshot.selection.targetRoot, snapshot.selection.bundleRoot,
                snapshot.selection.taskId, snapshot.roots.map(root => root.entries));
            preview.blockers.push(...snapshot.authority.blockers);
        }
        if (!preview.blockers.length) {
            assertOwnedDisposableSnapshotCurrent(snapshot);
            preview.ownership_digest = digestOwnedDisposableArtifactSnapshot(snapshot); preview.status = 'READY';
            for (const item of preview.items) item.state = 'eligible';
        }
    } catch (error) { preview.blockers.push(error instanceof Error ? error.message : String(error)); }
    return snapshot;
}

export function previewOwnedDisposableArtifacts(options: OwnedDisposableArtifactPreviewSelection): OwnedDisposableArtifactPreview {
    return buildOwnedDisposableArtifactSnapshot(options).preview;
}
