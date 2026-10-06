import * as path from 'node:path';
import { assertBoundContainedRemovalTree, assertContainedDestination, bindContainedDestination,
    readBoundedContainedDirectory, type ContainedDestination } from '../../core/contained-filesystem';
import { lstatFileIdentitySync } from '../../core/file-stat';
import { isProtectedGenericScratchName } from './runtime-cleanup-ownership';
import { inspectScratchWriter, readScratchFile, resolveScratchWriterLocations, SCRATCH_CLEANUP_LIMITS,
    scratchBindingIdentity, scratchPathKey, scratchSha256, scratchStatIdentity,
    type ScratchFileSnapshot, type ScratchWriterInspection, type ScratchWriterLocations } from './scratch-writer-ownership';

export interface StaleScratchCleanupSelection {
    targetRoot: string;
    bundleRoot: string;
    scratchNames: readonly string[];
    cutoffUtc: string;
}

export interface ScratchCleanupItemPreview {
    path: string;
    state: 'eligible' | 'protected';
    owner_state: ScratchWriterInspection['state'] | 'unverifiable';
    newest_mtime_utc: string | null;
    file_count: number;
    bytes: number;
    diagnostic: string | null;
}

export interface StaleScratchCleanupPreview {
    schema_version: 1;
    kind: 'stale_scratch_cleanup_preview';
    status: 'READY' | 'BLOCKED';
    policy: { id: 'known-dead-local-scratch-v1'; cutoff_utc: string };
    selected_paths: string[];
    items: ScratchCleanupItemPreview[];
    ownership_digest: string | null;
    blockers: string[];
}

export interface ScratchTreeEntry {
    binding: ContainedDestination;
    directory: boolean;
    identity: string;
    mtimeNs: bigint;
    file?: ScratchFileSnapshot;
}

export interface ScratchRootSnapshot {
    locations: ScratchWriterLocations;
    rootBinding: ContainedDestination;
    writer: ScratchWriterInspection;
    entries: ScratchTreeEntry[];
}

export interface ScratchCleanupSnapshot {
    selection: StaleScratchCleanupSelection;
    preview: StaleScratchCleanupPreview;
    roots: ScratchRootSnapshot[];
}

interface SnapshotBudget { entries: number; bytes: number; metadataBytes: number }

function normalizeSelection(options: StaleScratchCleanupSelection): StaleScratchCleanupSelection {
    if (!options || !Array.isArray(options.scratchNames) || options.scratchNames.length === 0
        || options.scratchNames.length > SCRATCH_CLEANUP_LIMITS.selectedRoots) {
        throw new Error('Select an explicit nonempty bounded set of generic scratch root names.');
    }
    if (typeof options.cutoffUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(options.cutoffUtc)
        || !Number.isFinite(Date.parse(options.cutoffUtc)) || new Date(options.cutoffUtc).toISOString() !== options.cutoffUtc
        || Date.parse(options.cutoffUtc) > Date.now()) {
        throw new Error('Scratch preview requires an explicit valid UTC cutoff in the past.');
    }
    const keys = new Set<string>();
    for (const scratchName of options.scratchNames) {
        const locations = resolveScratchWriterLocations({ ...options, scratchName }), key = scratchPathKey(locations.scratchPath);
        if (keys.has(key)) throw new Error('Scratch selection contains duplicate roots or case aliases.');
        keys.add(key);
    }
    return { targetRoot: path.resolve(options.targetRoot), bundleRoot: path.resolve(options.bundleRoot),
        scratchNames: options.scratchNames.map(name => process.platform === 'win32' ? name.toLowerCase() : name).sort(),
        cutoffUtc: new Date(options.cutoffUtc).toISOString() };
}

function reserveEntry(budget: SnapshotBudget, root: string, candidate: string): void {
    const depth = path.relative(root, candidate).split(path.sep).length + 1;
    const metadataBytes = 256 + depth * (128 + candidate.length * 6);
    if (budget.entries < 1 || depth > SCRATCH_CLEANUP_LIMITS.pathDepth
        || candidate.length > SCRATCH_CLEANUP_LIMITS.pathCharacters || metadataBytes > budget.metadataBytes) {
        throw new Error('Scratch tree entry, depth or snapshot metadata allowance exceeded; select smaller roots.');
    }
    budget.entries -= 1; budget.metadataBytes -= metadataBytes;
}

function snapshotTree(locations: ScratchWriterLocations, budget: SnapshotBudget): ScratchTreeEntry[] {
    const rootBinding = bindContainedDestination(locations.root, locations.scratchPath);
    assertBoundContainedRemovalTree(rootBinding, budget.entries);
    const entries: ScratchTreeEntry[] = [], pending = [locations.scratchPath];
    while (pending.length > 0) {
        const candidate = pending.pop()!;
        reserveEntry(budget, locations.root, candidate);
        if (isProtectedGenericScratchName(path.basename(candidate))) {
            throw new Error('Scratch tree contains protected task, review, writer or durable-state descendants; preserve the entire root.');
        }
        const binding = bindContainedDestination(locations.root, candidate);
        const stat = lstatFileIdentitySync(candidate, { bigint: true });
        const identity = scratchStatIdentity(stat), directory = stat.isDirectory();
        if (directory) {
            const names = readBoundedContainedDirectory(binding, budget.entries - pending.length);
            for (const name of names.reverse()) pending.push(path.join(candidate, name));
            if (scratchStatIdentity(lstatFileIdentitySync(candidate, { bigint: true })) !== identity) {
                throw new Error('Scratch directory changed during enumeration; obtain a fresh preview.');
            }
            entries.push({ binding, directory, identity, mtimeNs: stat.mtimeNs });
        } else {
            if (stat.size > BigInt(budget.bytes)) throw new Error('Scratch aggregate byte allowance exceeded before reading.');
            const maximumBytes = Math.min(SCRATCH_CLEANUP_LIMITS.fileBytes, budget.bytes);
            budget.bytes -= Number(stat.size);
            const file = readScratchFile(binding, maximumBytes);
            if (file.identity !== identity) throw new Error('Scratch file changed between admission and read.');
            entries.push({ binding, directory, identity, mtimeNs: stat.mtimeNs, file });
        }
    }
    assertBoundContainedRemovalTree(rootBinding, SCRATCH_CLEANUP_LIMITS.entries, entries.map(entry => entry.binding));
    for (const entry of entries) {
        assertContainedDestination(entry.binding);
        if (scratchStatIdentity(lstatFileIdentitySync(entry.binding.path, { bigint: true })) !== entry.identity) {
            throw new Error('Scratch tree changed before snapshot completion; obtain a fresh preview.');
        }
    }
    return entries.sort((left, right) => scratchPathKey(left.binding.path) < scratchPathKey(right.binding.path) ? -1 : 1);
}

function snapshotRoot(locations: ScratchWriterLocations, cutoffUtc: string, budget: SnapshotBudget): ScratchRootSnapshot {
    const writer = inspectScratchWriter(locations);
    if (writer.state !== 'dead') {
        throw new Error(`Scratch writer is ${writer.state}; only a positively known-dead local owner permits cleanup.`);
    }
    const rootBinding = bindContainedDestination(locations.root, locations.scratchPath), entries = snapshotTree(locations, budget);
    const cutoffNs = BigInt(Date.parse(cutoffUtc)) * 1000000n;
    for (const entry of entries) {
        if (entry.mtimeNs >= cutoffNs) {
            throw new Error('Scratch has a root or descendant newer than the cutoff; preserve fresh writer output.');
        }
    }
    const closingOwner = inspectScratchWriter(locations);
    if (closingOwner.state !== 'dead' || closingOwner.file.identity !== writer.file.identity
        || closingOwner.file.sha256 !== writer.file.sha256) {
        throw new Error('Scratch ownership changed during preview; obtain a fresh preview after the writer is known dead.');
    }
    return { locations, rootBinding, writer, entries };
}

export function newestScratchMtimeUtc(entries: readonly Pick<ScratchTreeEntry, 'mtimeNs'>[]): string {
    const first = entries[0];
    if (!first) throw new Error('Scratch timestamp summary requires a nonempty retained tree.');
    let newest = first.mtimeNs;
    for (const entry of entries) {
        const mtime = entry.mtimeNs;
        if (mtime > newest) newest = mtime;
    }
    return new Date(Number(newest / 1000000n)).toISOString();
}

function protectedOwnerState(locations: ScratchWriterLocations): ScratchCleanupItemPreview['owner_state'] {
    try { return inspectScratchWriter(locations).state; }
    catch { return 'unverifiable'; }
}

function digestSnapshot(snapshot: ScratchCleanupSnapshot): string {
    return scratchSha256(JSON.stringify({ root: scratchPathKey(snapshot.selection.targetRoot),
        bundle: scratchPathKey(snapshot.selection.bundleRoot), policy: snapshot.preview.policy, limits: SCRATCH_CLEANUP_LIMITS,
        selected: snapshot.preview.selected_paths, roots: snapshot.roots.map(root => ({
            path: scratchPathKey(root.locations.scratchPath), owner: root.writer.owner,
            owner_identity: root.writer.file.identity, owner_sha256: root.writer.file.sha256,
            owner_binding: scratchBindingIdentity(root.writer.file.binding),
            tree: root.entries.map(entry => ({ path: scratchPathKey(entry.binding.path),
                binding: scratchBindingIdentity(entry.binding), directory: entry.directory,
                identity: entry.identity, file_sha256: entry.file?.sha256 ?? null }))
        })) }));
}

function checkRevalidationBudget(roots: readonly ScratchRootSnapshot[]): void {
    const entries = roots.reduce((total, root) => total + root.entries.length, 0);
    const ownerBytes = roots.reduce((total, root) => total + root.writer.file.bytes, 0);
    if (4 * entries * (entries + 2) > SCRATCH_CLEANUP_LIMITS.revalidationChecks
        || ownerBytes * (entries + 4) > SCRATCH_CLEANUP_LIMITS.treeBytes) {
        throw new Error('Scratch whole-selection revalidation allowance exceeded; select fewer or smaller roots.');
    }
}

function assertPreviewCurrent(roots: readonly ScratchRootSnapshot[]): void {
    for (const root of roots) {
        const owner = inspectScratchWriter(root.locations);
        if (owner.state !== 'dead' || owner.file.identity !== root.writer.file.identity || owner.file.sha256 !== root.writer.file.sha256) {
            throw new Error('Scratch ownership changed before whole-selection preview completion.');
        }
        assertBoundContainedRemovalTree(root.rootBinding, SCRATCH_CLEANUP_LIMITS.entries, root.entries.map(entry => entry.binding));
        for (const entry of root.entries) {
            if (scratchStatIdentity(lstatFileIdentitySync(entry.binding.path, { bigint: true })) !== entry.identity) {
                throw new Error('Scratch tree changed before whole-selection preview completion.');
            }
        }
    }
}

export function buildScratchCleanupSnapshot(options: StaleScratchCleanupSelection): ScratchCleanupSnapshot {
    const preview: StaleScratchCleanupPreview = { schema_version: 1, kind: 'stale_scratch_cleanup_preview',
        status: 'BLOCKED', policy: { id: 'known-dead-local-scratch-v1', cutoff_utc: '' },
        selected_paths: [], items: [], ownership_digest: null, blockers: [] };
    const snapshot: ScratchCleanupSnapshot = { selection: options, preview, roots: [] };
    try {
        snapshot.selection = normalizeSelection(options);
        preview.policy.cutoff_utc = snapshot.selection.cutoffUtc;
        const budget: SnapshotBudget = { entries: SCRATCH_CLEANUP_LIMITS.entries,
            bytes: SCRATCH_CLEANUP_LIMITS.treeBytes, metadataBytes: SCRATCH_CLEANUP_LIMITS.snapshotBytes };
        for (const scratchName of snapshot.selection.scratchNames) {
            const locations = resolveScratchWriterLocations({ ...snapshot.selection, scratchName });
            const relative = path.relative(locations.root, locations.scratchPath).replace(/\\/gu, '/');
            preview.selected_paths.push(process.platform === 'win32' ? relative.toLowerCase() : relative);
            try {
                const root = snapshotRoot(locations, snapshot.selection.cutoffUtc, budget);
                snapshot.roots.push(root);
                preview.items.push({ path: relative, state: 'eligible', owner_state: 'dead',
                    newest_mtime_utc: newestScratchMtimeUtc(root.entries), file_count: root.entries.filter(entry => !entry.directory).length,
                    bytes: root.entries.reduce((total, entry) => total + (entry.file?.bytes ?? 0), 0), diagnostic: null });
            } catch (error) {
                const diagnostic = error instanceof Error ? error.message : String(error);
                preview.blockers.push(`${relative}: ${diagnostic}`);
                preview.items.push({ path: relative, state: 'protected', owner_state: protectedOwnerState(locations),
                    newest_mtime_utc: null, file_count: 0, bytes: 0, diagnostic });
            }
        }
        if (preview.blockers.length === 0) {
            checkRevalidationBudget(snapshot.roots);
            assertPreviewCurrent(snapshot.roots);
            preview.ownership_digest = digestSnapshot(snapshot); preview.status = 'READY';
        }
    } catch (error) { preview.blockers.push(error instanceof Error ? error.message : String(error)); }
    return snapshot;
}

export function previewStaleScratchCleanup(options: StaleScratchCleanupSelection): StaleScratchCleanupPreview {
    return buildScratchCleanupSnapshot(options).preview;
}
