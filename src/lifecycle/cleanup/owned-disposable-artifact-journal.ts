import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { assertContainedDestination, bindContainedDestination, ensureContainedDirectory,
    readBoundedContainedDirectory, type ContainedDestination } from '../../core/contained-filesystem';
import { lstatFileIdentitySync } from '../../core/file-stat';
import { fsyncDirectoryBestEffort } from '../../core/filesystem';
import { isPlainRecord } from '../../core/records';
import { getLifecycleOperationLockPath, withLifecycleOperationLock } from '../lock/lifecycle-lock';
import { withLifecycleRuntimeMutationGeneration } from '../runtime-mutation-generation';
import { inspectCompletedTaskEvidence } from './completed-task-evidence';
import { assertDisposableAuthorityCurrent, assertDisposableInventoryRemaining, disposableRemovalOrder,
    type DisposableInventoryEntry, type DisposableRemovalState } from './owned-disposable-artifact-inventory';
import { inspectOwnedDisposableArtifact } from './owned-disposable-artifact-registration';
import { assertOwnedDisposableSnapshotCurrent, buildOwnedDisposableArtifactSnapshot,
    normalizeOwnedDisposableArtifactSelection,
    type OwnedDisposableArtifactSnapshot } from './owned-disposable-artifact-preview';
import { OWNED_DISPOSABLE_PREVIEW_LIMITS as LIMITS,
    type OwnedDisposableArtifactPreviewSelection } from './owned-disposable-artifact-preview-contracts';
import { createOwnedDisposableRecoveryMutation, freezeOwnedDisposableValue, type OwnedDisposableRecoveryMutation }
    from './owned-disposable-artifact-recovery-mutation';
import { OWNED_DISPOSABLE_PROGRESS_ORDER, OWNED_DISPOSABLE_RECOVERY_MAX_ATTEMPTS }
    from './owned-disposable-artifact-recovery-progress';
import { readOwnedDisposableArtifactRecoverySnapshot } from './owned-disposable-artifact-recovery-snapshot';
import { readScratchFile, resolveScratchWriterLocations, scratchBindingIdentity, scratchSha256,
    scratchPathKey, scratchStatIdentity, withScratchWriterLock, type ScratchFileSnapshot } from './scratch-writer-ownership';

export interface OwnedDisposableArtifactJournalSelection extends OwnedDisposableArtifactPreviewSelection {
    ownershipDigest: string;
}
export interface OwnedDisposableArtifactJournalOptions extends OwnedDisposableArtifactJournalSelection {
    confirmed: boolean;
}
export interface OwnedDisposableArtifactJournalResult {
    schema_version: 1;
    kind: 'owned_disposable_artifact_retirement_intent';
    status: 'CONFIRMATION_REQUIRED' | 'BLOCKED' | 'PENDING';
    journal_path: string | null;
    journal_sha256: string | null;
    ownership_digest: string | null;
    compact_evidence_sha256: string | null;
    file_count: number;
    total_bytes: number;
    created: boolean;
    metadata_mutation_attempted: boolean;
    errors: string[];
}

const AUTHORITY_BYTES = 32;
const JOURNAL_DOMAIN = 'garda.owned-disposable-retirement-intent.v1';
const JOURNAL_KEYS = ['schema_version', 'kind', 'status', 'prepared_at_utc',
    'journal_creation_identity', 'intent', 'authentication_sha256'] as const;
const PROGRESS_DOMAIN = 'garda.owned-disposable-retirement-progress.v1';
const PROGRESS_KEYS = ['schema_version', 'kind', 'prepared_at_utc',
    'journal_creation_identity', 'progress', 'authentication_sha256'] as const;
const MAX_PROGRESS_FRAMES = LIMITS.entries * 2 + 2;
const HASH = /^[0-9a-f]{64}$/u;
const SELECTION_KEYS = 'bundleRoot|ownershipDigest|registrationIds|targetRoot|taskId';

function recoveryFrameLimit(roots: unknown): number {
    if (!Array.isArray(roots) || !roots.length || roots.length > LIMITS.selectedRoots) {
        throw new Error('Disposable progress signed inventory allowance is malformed; preserve metadata.');
    }
    let members = 0;
    for (const root of roots) {
        if (!isPlainRecord(root) || !Array.isArray(root.inventory) || !root.inventory.length
            || root.inventory.length > LIMITS.entries || (members += root.inventory.length) > LIMITS.entries) {
            throw new Error('Disposable progress signed inventory allowance is malformed or exceeded; preserve metadata.');
        }
    }
    return members * 2 + OWNED_DISPOSABLE_RECOVERY_MAX_ATTEMPTS * 2 + 2;
}

function emptyResult(): OwnedDisposableArtifactJournalResult {
    return { schema_version: 1, kind: 'owned_disposable_artifact_retirement_intent', status: 'BLOCKED',
        journal_path: null, journal_sha256: null, ownership_digest: null, compact_evidence_sha256: null,
        file_count: 0, total_bytes: 0, created: false, metadata_mutation_attempted: false, errors: [] };
}

function selectionInput(options: OwnedDisposableArtifactJournalSelection, preparing: boolean) {
    const expected = preparing ? `bundleRoot|confirmed|ownershipDigest|registrationIds|targetRoot|taskId` : SELECTION_KEYS;
    if (!isPlainRecord(options) || Object.keys(options).sort().join('|') !== expected
        || typeof options.ownershipDigest !== 'string' || !HASH.test(options.ownershipDigest)) {
        throw new Error('Retirement intent requires exact declared selection fields and its confirmed SHA256 preview digest.');
    }
    return { targetRoot: options.targetRoot, bundleRoot: options.bundleRoot,
        taskId: options.taskId, registrationIds: options.registrationIds };
}

function requireSnapshot(selection: OwnedDisposableArtifactPreviewSelection, digest: string) {
    const snapshot = buildOwnedDisposableArtifactSnapshot(selection);
    if (snapshot.preview.status !== 'READY' || snapshot.preview.ownership_digest !== digest) {
        throw new Error(`Retirement selection or authority changed; obtain a fresh exact preview. ${snapshot.preview.blockers.join(' | ')}`);
    }
    return snapshot;
}

function intent(snapshot: OwnedDisposableArtifactSnapshot, parentAnchors = true) {
    return { policy: snapshot.preview.policy, workspace_root: snapshot.selection.targetRoot,
        bundle_root: snapshot.selection.bundleRoot, task_id: snapshot.selection.taskId,
        registration_ids: snapshot.selection.registrationIds, ownership_digest: snapshot.preview.ownership_digest,
        ...(parentAnchors ? { authority_identity: keyIdentity(readKey(snapshot)) } : {}),
        compact_evidence_sha256: snapshot.completed!.evidence_sha256,
        completion_event_sha256: snapshot.completed!.completion_event_sha256, commit_sha: snapshot.completed!.commit_sha,
        file_count: snapshot.preview.file_count, total_bytes: snapshot.preview.total_bytes,
        roots: snapshot.roots.map(root => ({ registration_id: root.registrationId, run_id: root.owner.record.run_id,
            category: root.owner.record.category, path: path.relative(snapshot.selection.targetRoot, root.owner.rootBinding.path).replace(/\\/gu, '/'),
            owner_sha256: root.owner.ownerSha256, root_creation_identity: root.owner.record.root_creation_identity,
            ...(parentAnchors ? { parent_creation_identity: scratchBindingIdentity(bindContainedDestination(
                snapshot.selection.targetRoot, path.dirname(root.owner.rootBinding.path))),
                owner_identity: readScratchFile(bindContainedDestination(snapshot.selection.targetRoot,
                    path.join(snapshot.selection.bundleRoot, 'runtime', 'disposable-producers', snapshot.selection.taskId,
                        `${root.registrationId}.json`)), 16 * 1024).identity } : {}),
            inventory: root.entries.map(entry => entry.view) })) };
}

function retirementPath(selection: OwnedDisposableArtifactPreviewSelection, digest: string): string {
    return path.join(selection.bundleRoot, 'runtime', 'disposable-producers', 'retirements', selection.taskId, `${digest}.json`);
}

function journalPath(snapshot: OwnedDisposableArtifactSnapshot): string {
    return retirementPath(snapshot.selection, snapshot.preview.ownership_digest!);
}

function readKey(snapshot: Pick<OwnedDisposableArtifactSnapshot, 'selection'>): ScratchFileSnapshot {
    const file = readScratchFile(bindContainedDestination(snapshot.selection.targetRoot,
        path.join(snapshot.selection.bundleRoot, 'runtime', 'disposable-producers', '.authority-key')), AUTHORITY_BYTES, true);
    if (file.bytes !== AUTHORITY_BYTES || process.platform !== 'win32'
        && (fs.lstatSync(file.binding.path).mode & 0o077) !== 0) {
        throw new Error('Retirement intent requires the existing exact private producer authority; never recreate a missing key.');
    }
    return file;
}

function assertKeyCurrent(key: ScratchFileSnapshot): void {
    const current = readScratchFile(key.binding, AUTHORITY_BYTES);
    if (current.identity !== key.identity || current.sha256 !== key.sha256) {
        throw new Error('Producer authority changed during compact intent publication.');
    }
}

function keyIdentity(key: ScratchFileSnapshot): string {
    return scratchSha256(JSON.stringify([scratchBindingIdentity(key.binding), key.identity, key.sha256]));
}

function signature(record: Record<string, unknown>, key: ScratchFileSnapshot,
    keys: readonly string[] = JOURNAL_KEYS, domain = JOURNAL_DOMAIN): Buffer {
    const unsigned = Object.fromEntries(keys.filter(name => name !== 'authentication_sha256').map(name => [name, record[name]]));
    return createHmac('sha256', key.contents!).update(JSON.stringify({ domain, record: unsigned })).digest();
}

function creationIdentity(root: string, destination: string, stat: fs.BigIntStats): string {
    const parent = bindContainedDestination(root, path.dirname(destination));
    return scratchSha256(JSON.stringify([scratchBindingIdentity(parent), destination,
        ...[stat.dev, stat.ino, stat.mode, stat.birthtimeNs].map(String)]));
}

function readJournalRecord(binding: ContainedDestination, key: ScratchFileSnapshot,
    progress = false, maximumBytes = LIMITS.metadataBytes) {
    const keys = progress ? PROGRESS_KEYS : JOURNAL_KEYS, domain = progress ? PROGRESS_DOMAIN : JOURNAL_DOMAIN;
    const file = readScratchFile(binding, maximumBytes);
    const descriptor = fs.openSync(binding.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const contents = Buffer.alloc(file.bytes + 1);
    let count = 0;
    try {
        if (scratchStatIdentity(fs.fstatSync(descriptor, { bigint: true })) !== file.identity) throw new Error('Journal changed before its bounded read.');
        while (count < contents.length) {
            const read = fs.readSync(descriptor, contents, count, contents.length - count, null);
            if (!read) break;
            count += read;
        }
        if (scratchStatIdentity(fs.fstatSync(descriptor, { bigint: true })) !== file.identity) throw new Error('Journal changed during its bounded read.');
    } finally { fs.closeSync(descriptor); }
    const current = readScratchFile(binding, maximumBytes);
    if (count !== file.bytes || scratchSha256(contents.subarray(0, count)) !== file.sha256
        || current.identity !== file.identity || current.sha256 !== file.sha256) throw new Error('Journal bytes or identity changed during inspection.');
    const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents.subarray(0, count)));
    if (!isPlainRecord(record) || Object.keys(record).sort().join('|') !== [...keys].sort().join('|')
        || record.schema_version !== 1 || record.kind !== (progress
            ? 'owned_disposable_artifact_retirement_progress' : 'owned_disposable_artifact_retirement_intent')
        || !progress && record.status !== 'PENDING' || typeof record.prepared_at_utc !== 'string'
        || !Number.isFinite(Date.parse(record.prepared_at_utc)) || new Date(record.prepared_at_utc).toISOString() !== record.prepared_at_utc
        || typeof record.authentication_sha256 !== 'string' || !HASH.test(record.authentication_sha256)
        || record.journal_creation_identity !== creationIdentity(binding.root, binding.path, lstatFileIdentitySync(binding.path, { bigint: true }))
        || !timingSafeEqual(signature(record, key, keys, domain), Buffer.from(record.authentication_sha256, 'hex'))
        || !isPlainRecord(record[progress ? 'progress' : 'intent'])) {
        throw new Error(progress
            ? 'Compact retirement progress is malformed, foreign, replaced, tampered or stale; preserve journal and payload.'
            : 'Compact retirement intent is malformed, foreign, replaced, tampered or stale; preserve journal and payload.');
    }
    assertKeyCurrent(key); assertContainedDestination(binding);
    return { file, record };
}

function readJournal(binding: ContainedDestination, snapshot: OwnedDisposableArtifactSnapshot, key: ScratchFileSnapshot) {
    const { file, record } = readJournalRecord(binding, key), encoded = JSON.stringify(record.intent);
    if (encoded !== JSON.stringify(intent(snapshot)) && encoded !== JSON.stringify(intent(snapshot, false))) {
        throw new Error('Compact retirement intent is stale; preserve journal and payload.');
    }
    assertOwnedDisposableSnapshotCurrent(snapshot); assertContainedDestination(binding);
    return file;
}

// Authenticated metadata transport only. Recovery callers reconstruct native owner/evidence and progress separately.
export function readOwnedDisposableRetirementIntent(options: OwnedDisposableArtifactJournalSelection) {
    const selection = normalizeOwnedDisposableArtifactSelection(selectionInput(options, false));
    const key = readKey({ selection }), binding = bindContainedDestination(selection.targetRoot,
        retirementPath(selection, options.ownershipDigest));
    const result = readJournalRecord(binding, key);
    assertKeyCurrent(key);
    return { selection, file: result.file, intent: result.record.intent as Record<string, unknown>,
        authorityIdentity: keyIdentity(key) };
}

// Native metadata transport only: callers cannot supply a path, record, key or prior snapshot.
export function readOwnedDisposableRetirementProgress(options: OwnedDisposableArtifactJournalSelection) {
    const native = readOwnedDisposableRetirementIntent(options), key = readKey({ selection: native.selection });
    if (keyIdentity(key) !== native.authorityIdentity) throw new Error('Disposable progress private authority generation changed.');
    const directory = bindContainedDestination(native.selection.targetRoot, native.file.binding.path.replace(/\.json$/u, '.progress'));
    assertContainedDestination(directory);
    const directoryIdentity = directory.missingAt === null
        ? scratchStatIdentity(lstatFileIdentitySync(directory.path, { bigint: true })) : null;
    const frameLimit = recoveryFrameLimit(native.intent.roots);
    const names = directoryIdentity === null ? [] : readBoundedContainedDirectory(directory, frameLimit);
    if (names.some((name, index) => name !== `${String(index).padStart(8, '0')}.json`)) {
        throw new Error('Disposable progress contains unknown, interrupted, missing or nonsequential metadata; preserve all members.');
    }
    let remainingBytes = LIMITS.metadataBytes;
    const frames = names.map(name => {
        const result = readJournalRecord(bindContainedDestination(native.selection.targetRoot,
            path.join(directory.path, name)), key, true, remainingBytes);
        remainingBytes -= result.file.bytes;
        return result;
    });
    function checkDirectory(): void {
        assertContainedDestination(directory);
        const current = bindContainedDestination(native.selection.targetRoot, directory.path);
        if (directoryIdentity === null ? current.missingAt !== directory.path
            : current.missingAt !== null || scratchStatIdentity(lstatFileIdentitySync(directory.path, { bigint: true })) !== directoryIdentity
                || JSON.stringify(readBoundedContainedDirectory(directory, frameLimit)) !== JSON.stringify(names)) {
            throw new Error('Disposable progress directory or membership changed during inspection.');
        }
    }
    checkDirectory();
    for (const frame of frames) {
        const current = readScratchFile(frame.file.binding, LIMITS.metadataBytes);
        if (current.identity !== frame.file.identity || current.sha256 !== frame.file.sha256) {
            throw new Error('Disposable progress frame changed during inspection.');
        }
    }
    assertKeyCurrent(key);
    const current = readOwnedDisposableRetirementIntent(options);
    if (current.file.identity !== native.file.identity || current.file.sha256 !== native.file.sha256
        || current.authorityIdentity !== native.authorityIdentity) {
        throw new Error('Disposable progress intent or private authority generation changed during inspection.');
    }
    checkDirectory(); assertKeyCurrent(key);
    return { native, directory, directoryIdentity, frames };
}

function locksCurrent(root: string): () => void {
    const owner = readScratchFile(bindContainedDestination(root, path.join(getLifecycleOperationLockPath(root), 'owner.json')), 16 * 1024);
    return () => {
        const current = readScratchFile(owner.binding, 16 * 1024);
        if (current.identity !== owner.identity || current.sha256 !== owner.sha256) throw new Error('Lifecycle lock generation changed during intent publication.');
    };
}

function publish(snapshot: OwnedDisposableArtifactSnapshot, key: ScratchFileSnapshot, destination: string,
    check: () => void, progress?: undefined, maximumBytes?: number): ScratchFileSnapshot;
function publish(snapshot: Pick<OwnedDisposableArtifactSnapshot, 'selection'>, key: ScratchFileSnapshot, destination: string,
    check: () => void, progress: Record<string, unknown>, maximumBytes?: number): ScratchFileSnapshot;
function publish(snapshot: Pick<OwnedDisposableArtifactSnapshot, 'selection'>, key: ScratchFileSnapshot, destination: string,
    check: () => void, progress?: Record<string, unknown>, maximumBytes = LIMITS.metadataBytes): ScratchFileSnapshot {
    const root = snapshot.selection.targetRoot, initial = bindContainedDestination(root, destination);
    if (initial.missingAt === null) throw new Error('Retirement journal publication cannot overwrite existing metadata.');
    ensureContainedDirectory(root, path.dirname(destination), created => fsyncDirectoryBestEffort(path.dirname(created.path)));
    const final = bindContainedDestination(root, destination), parent = bindContainedDestination(root, path.dirname(destination));
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.intent-${randomUUID()}`);
    const temporaryBefore = bindContainedDestination(root, temporary);
    check(); assertContainedDestination(final); assertContainedDestination(temporaryBefore);
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    let descriptorOpen = true;
    try {
        const temporaryBinding = bindContainedDestination(root, temporary), stat = fs.fstatSync(descriptor, { bigint: true });
        if (stat.dev !== lstatFileIdentitySync(temporary, { bigint: true }).dev
            || stat.ino !== lstatFileIdentitySync(temporary, { bigint: true }).ino || stat.nlink !== 1n) throw new Error('Compact intent temporary file identity changed.');
        const record: Record<string, unknown> = { schema_version: 1,
            kind: progress ? 'owned_disposable_artifact_retirement_progress' : 'owned_disposable_artifact_retirement_intent',
            prepared_at_utc: new Date().toISOString(), journal_creation_identity: creationIdentity(root, destination, stat),
            ...(progress ? { progress } : { status: 'PENDING', intent: intent(snapshot as OwnedDisposableArtifactSnapshot) }), authentication_sha256: '' };
        record.authentication_sha256 = signature(record, key, progress ? PROGRESS_KEYS : JOURNAL_KEYS,
            progress ? PROGRESS_DOMAIN : JOURNAL_DOMAIN).toString('hex');
        const bytes = Buffer.from(JSON.stringify(record) + '\n');
        if (bytes.length > maximumBytes) throw new Error('Compact retirement metadata exceeds its bounded allowance.');
        fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor);
        check(); assertKeyCurrent(key);
        if (!progress) assertOwnedDisposableSnapshotCurrent(snapshot as OwnedDisposableArtifactSnapshot);
        assertContainedDestination(temporaryBinding); assertContainedDestination(final); assertContainedDestination(parent);
        if (scratchStatIdentity(fs.fstatSync(descriptor, { bigint: true }))
            !== scratchStatIdentity(lstatFileIdentitySync(temporary, { bigint: true }))) throw new Error('Compact intent changed before publication.');
        fs.closeSync(descriptor); descriptorOpen = false;
        fs.renameSync(temporary, destination);
        fsyncDirectoryBestEffort(path.dirname(destination));
        check(); assertContainedDestination(parent);
        const file = readScratchFile(bindContainedDestination(root, destination), LIMITS.metadataBytes);
        if (file.sha256 !== scratchSha256(bytes)
            || creationIdentity(root, destination, lstatFileIdentitySync(destination, { bigint: true })) !== record.journal_creation_identity) {
            throw new Error('Published compact metadata bytes or creation identity changed.');
        }
        return file;
    } finally { if (descriptorOpen) fs.closeSync(descriptor); }
    // Interrupted metadata stays protected for diagnostics; this operation never removes payload bytes.
}

function accepted(result: OwnedDisposableArtifactJournalResult, snapshot: OwnedDisposableArtifactSnapshot, file: ScratchFileSnapshot): void {
    result.status = 'PENDING'; result.journal_path = file.binding.path; result.journal_sha256 = file.sha256;
    result.ownership_digest = snapshot.preview.ownership_digest; result.compact_evidence_sha256 = snapshot.preview.compact_evidence_sha256;
    result.file_count = snapshot.preview.file_count; result.total_bytes = snapshot.preview.total_bytes;
}

export function prepareOwnedDisposableArtifactRetirement(options: OwnedDisposableArtifactJournalOptions): OwnedDisposableArtifactJournalResult {
    const result = emptyResult();
    if (!options || options.confirmed !== true) { result.status = 'CONFIRMATION_REQUIRED'; return result; }
    try {
        const selection = selectionInput(options, true), digest = options.ownershipDigest;
        const initial = requireSnapshot(selection, digest), locations = resolveScratchWriterLocations({
            targetRoot: initial.selection.targetRoot, bundleRoot: initial.selection.bundleRoot, scratchName: 'disposable-producer-registry' });
        withLifecycleOperationLock(locations.root, 'disposable-retirement-intent', () => {
            const checkLifecycle = locksCurrent(locations.root);
            withScratchWriterLock(locations, checkWriter => {
                const check = () => { checkLifecycle(); checkWriter(); };
                check();
                const snapshot = requireSnapshot(initial.selection, digest), key = readKey(snapshot), destination = journalPath(snapshot);
                const before = bindContainedDestination(locations.root, destination);
                if (before.missingAt !== null) {
                    result.metadata_mutation_attempted = true; result.journal_path = destination;
                    withLifecycleRuntimeMutationGeneration(locations.bundleRoot, 'disposable-retirement-intent', () => publish(snapshot, key, destination, check));
                    result.created = true;
                }
                check(); accepted(result, snapshot, readJournal(bindContainedDestination(locations.root, destination), snapshot, key));
            });
        }, { allowForeignHostStaleRecovery: false });
    } catch (error) { result.status = 'BLOCKED'; result.errors.push(error instanceof Error ? error.message : String(error)); }
    return result;
}

export function inspectOwnedDisposableArtifactRetirement(options: OwnedDisposableArtifactJournalSelection): OwnedDisposableArtifactJournalResult {
    const result = emptyResult();
    try {
        const snapshot = requireSnapshot(selectionInput(options, false), options.ownershipDigest), key = readKey(snapshot);
        accepted(result, snapshot, readJournal(bindContainedDestination(snapshot.selection.targetRoot, journalPath(snapshot)), snapshot, key));
    } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); }
    return result;
}

export interface OwnedDisposableRetirementMutation {
    readonly snapshot: OwnedDisposableArtifactSnapshot;
    readonly journalPath: string;
    readonly journalSha256: string;
    readonly progressDirectory: string;
    check(): void;
    pending(): DisposableInventoryEntry | null;
    removed(): void;
    finish(): void;
    fail(message: string): void;
}

function createMutation(snapshot: OwnedDisposableArtifactSnapshot, key: ScratchFileSnapshot,
    journal: ScratchFileSnapshot, checkLocks: () => void): OwnedDisposableRetirementMutation {
    const root = snapshot.selection.targetRoot, progressDirectory = journal.binding.path.replace(/\.json$/u, '.progress');
    const before = bindContainedDestination(root, progressDirectory);
    if (before.missingAt === null) throw new Error('Existing disposable progress requires explicit authenticated recovery; never adopt or overwrite it.');
    assertContainedDestination(before); fs.mkdirSync(progressDirectory); fsyncDirectoryBestEffort(path.dirname(progressDirectory));
    const directory = bindContainedDestination(root, progressDirectory);
    const state: DisposableRemovalState = { removed: new Set(), directoryIdentities: new Map() };
    const owners = snapshot.roots.map(item => readScratchFile(bindContainedDestination(root,
        path.join(snapshot.selection.bundleRoot, 'runtime', 'disposable-producers', snapshot.selection.taskId,
            `${item.registrationId}.json`)), 16 * 1024));
    const order = snapshot.roots.flatMap(item => disposableRemovalOrder(item.entries)), frames: ScratchFileSnapshot[] = [];
    for (const item of snapshot.roots) for (const entry of item.entries) if (entry.view.directory) {
        state.directoryIdentities.set(scratchPathKey(entry.binding.path), entry.view.identity);
    }
    for (const item of snapshot.roots) {
        const parent = bindContainedDestination(root, path.dirname(item.owner.rootBinding.path));
        assertContainedDestination(parent);
        state.directoryIdentities.set(scratchPathKey(parent.path), scratchStatIdentity(lstatFileIdentitySync(parent.path, { bigint: true })));
    }
    let index = 0, pendingEntry: DisposableInventoryEntry | null = null, removedFiles = 0, removedBytes = 0,
        progressBytes = 0, settled = false;
    function assertFile(file: ScratchFileSnapshot, maximum: number): void {
        const current = readScratchFile(file.binding, maximum);
        if (current.identity !== file.identity || current.sha256 !== file.sha256) throw new Error('Disposable compact or owner authority changed during removal.');
    }
    function checkCore(): void {
        checkLocks(); assertKeyCurrent(key); assertFile(journal, LIMITS.metadataBytes);
        const completed = inspectCompletedTaskEvidence({ repoRoot: root, taskId: snapshot.selection.taskId });
        if (!completed.eligible || completed.evidence_sha256 !== snapshot.completed!.evidence_sha256
            || completed.completion_event_sha256 !== snapshot.completed!.completion_event_sha256
            || completed.commit_sha !== snapshot.completed!.commit_sha) throw new Error('Disposable committed compact evidence changed during removal.');
        assertDisposableAuthorityCurrent(snapshot.authority!);
        for (let ownerIndex = 0; ownerIndex < snapshot.roots.length; ownerIndex += 1) {
            const item = snapshot.roots[ownerIndex]; assertFile(owners[ownerIndex], 16 * 1024);
            if (owners[ownerIndex].sha256 !== item.owner.ownerSha256) throw new Error('Disposable owner differs from its confirmed preview.');
            if (item.entries.some(entry => !state.removed.has(scratchPathKey(entry.binding.path)))) {
                const current = inspectOwnedDisposableArtifact({ targetRoot: root, bundleRoot: snapshot.selection.bundleRoot,
                    taskId: snapshot.selection.taskId, registrationId: item.registrationId });
                if (!current.record.sealed_at_utc || current.producerState !== 'dead'
                    || current.ownerSha256 !== item.owner.ownerSha256) throw new Error('Disposable producer or native run changed during removal.');
            }
            assertDisposableInventoryRemaining(item.owner.rootBinding, item.entries, state);
        }
        checkLocks(); assertContainedDestination(directory);
    }
    function checkFrames(membership: boolean): void {
        for (const file of frames) {
            assertContainedDestination(file.binding);
            if (scratchStatIdentity(lstatFileIdentitySync(file.binding.path, { bigint: true })) !== file.identity) {
                throw new Error('Disposable compact progress identity changed during removal.');
            }
        }
        if (frames.length) assertFile(frames[frames.length - 1], LIMITS.metadataBytes);
        if (membership) {
            const names = readBoundedContainedDirectory(directory, MAX_PROGRESS_FRAMES);
            const expected = frames.map(file => path.basename(file.binding.path)).sort();
            if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('Disposable compact progress contains unknown or missing members.');
        }
    }
    function check(): void { checkCore(); checkFrames(true); }
    function append(event: 'PENDING' | 'REMOVED' | 'ERROR' | 'FINISHED', member: string | null, error: string | null): void {
        check();
        if (settled || frames.length >= MAX_PROGRESS_FRAMES) throw new Error('Disposable compact progress is settled or exceeds its allowance.');
        const progress = { intent_sha256: journal.sha256, ownership_digest: snapshot.preview.ownership_digest,
            order: OWNED_DISPOSABLE_PROGRESS_ORDER, sequence: frames.length, previous_sha256: frames.at(-1)?.sha256 ?? null,
            event, member_path: member, removed_member_count: index, removed_file_count: removedFiles,
            removed_bytes: removedBytes, error,
            parent_identity: event === 'REMOVED' && member !== null
                ? state.directoryIdentities.get(scratchPathKey(path.dirname(path.join(root, member)))) ?? null : null };
        const destination = path.join(progressDirectory, `${String(frames.length).padStart(8, '0')}.json`);
        const file = publish(snapshot, key, destination, () => { checkCore(); checkFrames(false); }, progress,
            LIMITS.metadataBytes - progressBytes);
        frames.push(file); progressBytes += file.bytes;
        check();
    }
    freezeOwnedDisposableValue(snapshot);
    return Object.freeze({ snapshot, journalPath: journal.binding.path, journalSha256: journal.sha256, progressDirectory, check,
        pending: () => {
            if (pendingEntry || settled) throw new Error('Disposable removal has unresolved progress or is already settled.');
            const entry = order[index];
            if (!entry) return null;
            append('PENDING', entry.view.path, null); pendingEntry = entry; return entry;
        },
        removed: () => {
            checkLocks();
            if (!pendingEntry || settled) throw new Error('Disposable removal requires its durable pending member.');
            const current = bindContainedDestination(root, pendingEntry.binding.path);
            if (current.missingAt !== pendingEntry.binding.path) throw new Error('Pending disposable removal has no exact confirmed absence.');
            state.removed.add(scratchPathKey(pendingEntry.binding.path));
            if (!pendingEntry.view.directory) { removedFiles += 1; removedBytes += pendingEntry.view.bytes; }
            const parent = path.dirname(pendingEntry.binding.path), parentKey = scratchPathKey(parent);
            if (state.directoryIdentities.has(parentKey) && !state.removed.has(parentKey)) {
                assertContainedDestination(bindContainedDestination(root, parent));
                state.directoryIdentities.set(parentKey, scratchStatIdentity(lstatFileIdentitySync(parent, { bigint: true })));
            }
            index += 1; append('REMOVED', pendingEntry.view.path, null); pendingEntry = null;
        },
        finish: () => {
            if (pendingEntry || index !== order.length) throw new Error('Disposable removal has unresolved or remaining members.');
            append('FINISHED', null, null); settled = true;
        },
        fail: (message: string) => { append('ERROR', pendingEntry?.view.path ?? null, message.slice(0, 1000)); settled = true; }
    });
}

export function withOwnedDisposableRetirementMutation<T>(options: OwnedDisposableArtifactJournalOptions,
    action: (mutation: OwnedDisposableRetirementMutation) => T): T {
    if (!options || options.confirmed !== true) throw new Error('Disposable removal requires explicit confirmation.');
    const selection = selectionInput(options, true), digest = options.ownershipDigest;
    const initial = requireSnapshot(selection, digest), locations = resolveScratchWriterLocations({
        targetRoot: initial.selection.targetRoot, bundleRoot: initial.selection.bundleRoot, scratchName: 'disposable-producer-registry' });
    return withLifecycleOperationLock(locations.root, 'disposable-retirement-removal', () => {
        const checkLifecycle = locksCurrent(locations.root);
        return withScratchWriterLock(locations, checkWriter => {
            const check = () => { checkLifecycle(); checkWriter(); };
            check();
            const snapshot = requireSnapshot(initial.selection, digest), key = readKey(snapshot), destination = journalPath(snapshot);
            return withLifecycleRuntimeMutationGeneration(locations.bundleRoot, 'disposable-retirement-removal', () => {
                if (bindContainedDestination(locations.root, destination).missingAt !== null) publish(snapshot, key, destination, check);
                const journal = readJournal(bindContainedDestination(locations.root, destination), snapshot, key);
                check(); return action(createMutation(snapshot, key, journal, check));
            });
        });
    }, { allowForeignHostStaleRecovery: false });
}

// The public recovery contract accepts native selection and confirmation only, never signing material or a caller proof.
export function withOwnedDisposableRecoveryMutation<T>(options: OwnedDisposableArtifactJournalOptions,
    action: (mutation: OwnedDisposableRecoveryMutation) => T): T {
    if (!options || options.confirmed !== true) throw new Error('Disposable recovery metadata requires explicit confirmation.');
    const selection = { ...normalizeOwnedDisposableArtifactSelection(selectionInput(options, true)), ownershipDigest: options.ownershipDigest };
    const initial = readOwnedDisposableArtifactRecoverySnapshot(selection), locations = resolveScratchWriterLocations({
        targetRoot: initial.progress.authority.selection.targetRoot,
        bundleRoot: initial.progress.authority.selection.bundleRoot, scratchName: 'disposable-producer-registry' });
    return withLifecycleOperationLock(locations.root, 'disposable-retirement-recovery', () => {
        const checkLifecycle = locksCurrent(locations.root);
        return withScratchWriterLock(locations, checkWriter => {
            let active = true;
            const check = () => {
                if (!active) throw new Error('Disposable recovery mutation handle is outside its native lock scope.');
                checkLifecycle(); checkWriter();
            };
            check();
            const current = readOwnedDisposableArtifactRecoverySnapshot(selection), key = readKey({ selection: current.progress.authority.selection });
            if (keyIdentity(key) !== current.progress.authority.owners[0].authorityIdentity) {
                throw new Error('Disposable recovery private authority generation changed under native locks.');
            }
            try {
                return withLifecycleRuntimeMutationGeneration(locations.bundleRoot, 'disposable-retirement-recovery', () => {
                    const directory = current.progress.directory.path;
                    if (current.progress.status !== 'FINISHED') {
                        ensureContainedDirectory(locations.root, directory, created => fsyncDirectoryBestEffort(path.dirname(created.path)));
                    }
                    const mutation = createOwnedDisposableRecoveryMutation(selection, (record, proof, checkProof, maximumBytes) => {
                        if (proof.progress.frames.length >= recoveryFrameLimit(proof.progress.authority.intent.roots)) {
                            throw new Error('Disposable recovery progress frame allowance exceeded.');
                        }
                        const destination = path.join(directory, `${String(proof.progress.frames.length).padStart(8, '0')}.json`);
                        return publish({ selection: proof.progress.authority.selection }, key, destination,
                            () => { check(); assertKeyCurrent(key); checkProof(); }, record, maximumBytes);
                    }, check);
                    return action(mutation);
                });
            } finally { active = false; }
        });
    }, { allowForeignHostStaleRecovery: false });
}
