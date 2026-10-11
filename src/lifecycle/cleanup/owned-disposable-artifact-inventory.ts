import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertBoundContainedRemovalTree, assertContainedDestination, assertExistingPathIdentity, bindContainedDestination,
    readBoundedContainedDirectory, type ContainedDestination } from '../../core/contained-filesystem';
import { lstatFileIdentitySync } from '../../core/file-stat';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { parseCanonicalActiveTaskQueue } from '../../core/task-md-table';
import { readTaskQueueStatusToken } from '../../core/task-queue/task-queue-status';
import { inspectTaskEventFile, withTaskTimelineReadSnapshot } from '../../gate-runtime/task-events';
import { OWNED_DISPOSABLE_PREVIEW_LIMITS as LIMITS, type OwnedDisposableArtifactFilePreview }
    from './owned-disposable-artifact-preview-contracts';
import { readScratchFile, scratchBindingIdentity, scratchPathKey, scratchSha256, scratchStatIdentity,
    type ScratchFileSnapshot } from './scratch-writer-ownership';

export interface DisposableInventoryEntry {
    binding: ContainedDestination;
    view: OwnedDisposableArtifactFilePreview;
}
export interface DisposableInventoryBudget { entries: number; bytes: number; metadataBytes: number }
interface DirectorySnapshot { binding: ContainedDestination; identity: string }
export interface DisposableAuthoritySnapshot {
    files: ScratchFileSnapshot[];
    directories: DirectorySnapshot[];
    absent: ContainedDestination[];
    blockers: string[];
    bytesRemaining: number;
    entriesRemaining: number;
}

export function inventoryDisposableTree(root: string, payload: ContainedDestination,
    budget: DisposableInventoryBudget): DisposableInventoryEntry[] {
    assertBoundContainedRemovalTree(payload, budget.entries);
    const entries: DisposableInventoryEntry[] = [], pending = [payload.path];
    while (pending.length) {
        const candidate = pending.pop()!, depth = path.relative(payload.path, candidate).split(path.sep).length;
        const metadata = 256 + (depth + 1) * (128 + candidate.length * 6);
        if (--budget.entries < 0 || depth > LIMITS.pathDepth || candidate.length > LIMITS.pathCharacters
            || (budget.metadataBytes -= metadata) < 0) throw new Error('Disposable inventory entry, path or metadata allowance exceeded.');
        if (['.git', '.hg', '.svn'].includes(path.basename(candidate).toLowerCase())) {
            throw new Error('Disposable payload contains nested repository metadata; preserve the entire root.');
        }
        const binding = bindContainedDestination(root, candidate), stat = lstatFileIdentitySync(candidate, { bigint: true });
        const identity = scratchStatIdentity(stat), directory = stat.isDirectory();
        let bytes = 0, sha256: string | null = null;
        if (directory) {
            const names = readBoundedContainedDirectory(binding, budget.entries - pending.length);
            const repositoryNames = new Set(names.map(name => name.toLowerCase()));
            if (repositoryNames.has('head')
                && ['objects', 'refs', 'reftable', 'commondir'].some(name => repositoryNames.has(name))) {
                throw new Error('Disposable payload contains nested bare or linked Git repository metadata; preserve the entire root.');
            }
            for (const name of names.reverse()) pending.push(path.join(candidate, name));
        } else {
            if (stat.size > BigInt(budget.bytes)) throw new Error('Disposable aggregate byte allowance exceeded before reading.');
            const file = readScratchFile(binding, Math.min(LIMITS.fileBytes, budget.bytes));
            if (file.identity !== identity) throw new Error('Disposable file changed during inventory admission.');
            bytes = file.bytes; sha256 = file.sha256; budget.bytes -= bytes;
        }
        if (scratchStatIdentity(lstatFileIdentitySync(candidate, { bigint: true })) !== identity) {
            throw new Error('Disposable entry changed during inventory.');
        }
        entries.push({ binding, view: { path: path.relative(root, candidate).replace(/\\/gu, '/'), directory,
            identity, binding_sha256: scratchBindingIdentity(binding), bytes, sha256 } });
    }
    assertDisposableInventoryCurrent(payload, entries);
    return entries.sort((left, right) => left.view.path < right.view.path ? -1 : 1);
}

export function assertDisposableInventoryCurrent(payload: ContainedDestination, entries: readonly DisposableInventoryEntry[]): void {
    assertBoundContainedRemovalTree(payload, LIMITS.entries, entries.map(entry => entry.binding));
    for (const entry of entries) {
        assertContainedDestination(entry.binding);
        if (scratchStatIdentity(lstatFileIdentitySync(entry.binding.path, { bigint: true })) !== entry.view.identity) {
            throw new Error('Disposable tree changed before preview publication.');
        }
    }
}

export interface DisposableRemovalState {
    removed: Set<string>;
    directoryIdentities: Map<string, string>;
}

export function disposableRemovalOrder<T extends { view: Pick<OwnedDisposableArtifactFilePreview, 'directory' | 'path'> }>(
    entries: readonly T[]): T[] {
    return [...entries.filter(entry => !entry.view.directory), ...entries.filter(entry => entry.view.directory)
        .sort((left, right) => right.view.path.length - left.view.path.length
            || (left.view.path < right.view.path ? -1 : left.view.path > right.view.path ? 1 : 0))];
}

export function assertDisposableInventoryRemaining(payload: ContainedDestination,
    entries: readonly DisposableInventoryEntry[], state: DisposableRemovalState): void {
    const remaining = entries.filter(entry => !state.removed.has(scratchPathKey(entry.binding.path)));
    if (remaining.length) assertBoundContainedRemovalTree(payload, LIMITS.entries, remaining.map(entry => entry.binding));
    for (const entry of entries) {
        if (state.removed.has(scratchPathKey(entry.binding.path))) {
            const current = bindContainedDestination(entry.binding.root, entry.binding.path);
            assertExistingPathIdentity({ ...entry.binding,
                existing: entry.binding.existing.filter(identity => !state.removed.has(scratchPathKey(identity.path))) });
            if (current.missingAt === null || !state.removed.has(scratchPathKey(current.missingAt))) {
                throw new Error('A removed disposable member or its ancestor was replaced; preserve the remaining selection.');
            }
            continue;
        }
        assertContainedDestination(entry.binding);
        const expected = entry.view.directory ? state.directoryIdentities.get(scratchPathKey(entry.binding.path)) : entry.view.identity;
        if (scratchStatIdentity(lstatFileIdentitySync(entry.binding.path, { bigint: true })) !== expected) {
            throw new Error('Remaining disposable member identity changed; preserve the remaining selection.');
        }
        if (!entry.view.directory) {
            const file = readScratchFile(entry.binding, entry.view.bytes);
            if (file.identity !== entry.view.identity || file.sha256 !== entry.view.sha256) {
                throw new Error('Remaining disposable file bytes changed; preserve the remaining selection.');
            }
        }
    }
}

function readAuthorityFile(root: string, candidate: string, snapshot: DisposableAuthoritySnapshot): string {
    if (snapshot.files.length >= LIMITS.authorityFiles) throw new Error('Disposable authority file allowance exceeded.');
    const maximum = Math.min(LIMITS.authorityFileBytes, snapshot.bytesRemaining);
    const file = readScratchFile(bindContainedDestination(root, candidate), maximum);
    snapshot.bytesRemaining -= file.bytes;
    const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const contents = Buffer.alloc(file.bytes + 1);
    let count = 0;
    try {
        if (scratchStatIdentity(fs.fstatSync(descriptor, { bigint: true })) !== file.identity) {
            throw new Error('Disposable authority changed before its bounded read.');
        }
        while (count < contents.length) {
            const read = fs.readSync(descriptor, contents, count, contents.length - count, null);
            if (!read) break;
            count += read;
        }
    } finally { fs.closeSync(descriptor); }
    const current = readScratchFile(file.binding, maximum);
    if (count !== file.bytes || scratchSha256(contents.subarray(0, count)) !== file.sha256
        || current.identity !== file.identity || current.sha256 !== file.sha256) {
        throw new Error('Disposable authority changed during its bounded read.');
    }
    snapshot.files.push(file);
    return new TextDecoder('utf-8', { fatal: true }).decode(contents.subarray(0, count));
}

function listAuthorityDirectory(root: string, candidate: string, snapshot: DisposableAuthoritySnapshot): string[] {
    const binding = bindContainedDestination(root, candidate);
    if (binding.missingAt) { snapshot.absent.push(binding); return []; }
    if (--snapshot.entriesRemaining < 0) throw new Error('Disposable authority entry allowance exceeded.');
    const identity = scratchStatIdentity(lstatFileIdentitySync(candidate, { bigint: true }));
    const names = readBoundedContainedDirectory(binding, snapshot.entriesRemaining);
    snapshot.entriesRemaining -= names.length;
    snapshot.directories.push({ binding, identity });
    return names;
}

function canonicalAuthorityText(candidate: string, text: string): string {
    const extension = path.extname(candidate).toLowerCase();
    if (extension === '.json') return JSON.stringify(JSON.parse(text));
    if (extension === '.jsonl') return text.split(/\r?\n/u).filter(Boolean)
        .map(line => JSON.stringify(JSON.parse(line))).join('\n');
    return text;
}

type AuthorityPayload = readonly Pick<DisposableInventoryEntry, 'view'>[];

function referencesPayload(text: string, root: string, payloads: readonly AuthorityPayload[]): boolean {
    const normalized = text.replace(/\\\//gu, '/').replace(/\\\\/gu, '/').replace(/\\/gu, '/').toLowerCase();
    return payloads.some(entries => entries.some(entry => normalized.includes(entry.view.path.toLowerCase())
        || normalized.includes(scratchPathKey(path.join(root, entry.view.path)).toLowerCase())
        || entry.view.sha256 !== null && normalized.includes(entry.view.sha256)))
        || payloads.some(entries => normalized.includes(path.relative(path.join(root, 'garda-agent-orchestrator', 'runtime'),
            path.join(root, entries[0]!.view.path)).replace(/\\/gu, '/').toLowerCase()));
}

function mentionsTask(text: string, taskId: string): boolean {
    return new RegExp(`(?:^|[^a-z0-9-])${taskId}(?=$|[^a-z0-9-])`, 'iu').test(text);
}

function inspectAuthorityTree(root: string, directory: string, snapshot: DisposableAuthoritySnapshot,
    inspect: (candidate: string, text: string) => void, selected?: string): void {
    const pending = [{ directory, depth: 0 }];
    while (pending.length) {
        const next = pending.pop()!;
        if (next.depth > LIMITS.pathDepth || next.directory.length > LIMITS.pathCharacters) {
            throw new Error('Disposable authority path allowance exceeded.');
        }
        for (const name of listAuthorityDirectory(root, next.directory, snapshot)) {
            const candidate = path.join(next.directory, name);
            const stat = lstatFileIdentitySync(candidate, { bigint: true });
            if (stat.isSymbolicLink()) throw new Error('Linked disposable authority must be preserved.');
            if (stat.isDirectory()) pending.push({ directory: candidate, depth: next.depth + 1 });
            else if (!selected || path.relative(directory, candidate).split(path.sep)
                .some(part => part === selected || part.startsWith(`${selected}-`) || part.startsWith(`${selected}.`))) {
                inspect(candidate, readAuthorityFile(root, candidate, snapshot));
            }
        }
    }
}

export function inspectDisposableAuthority(root: string, bundle: string, taskId: string,
    payloads: readonly AuthorityPayload[]): DisposableAuthoritySnapshot {
    const snapshot: DisposableAuthoritySnapshot = { files: [], directories: [], absent: [], blockers: [],
        bytesRemaining: LIMITS.authorityBytes, entriesRemaining: LIMITS.entries };
    const queue = readAuthorityFile(root, path.join(root, 'TASK.md'), snapshot);
    const parsed = parseCanonicalActiveTaskQueue(queue), ids = new Set<string>();
    if (!parsed.found || parsed.rows.length > LIMITS.queueRows
        || queue.split(/\r?\n/u).filter(line => line.trim() === '## Active Queue').length !== 1) {
        throw new Error('Disposable dependency queue is missing, ambiguous or exceeds its allowance.');
    }
    const lines = queue.split(/\r?\n/u), start = lines.findIndex(line => line.trim() === '## Active Queue');
    const end = lines.findIndex((line, index) => index > start && /^#{1,2}\s/u.test(line.trim()));
    const header = lines.findIndex((line, index) => index > start && /^\|\s*ID\s*\|\s*Status\s*\|/u.test(line.trim()));
    const recognized = new Set(parsed.rows.map(row => row.lineIndex));
    if (header < 0 || header + 1 >= (end < 0 ? lines.length : end)) throw new Error('Disposable queue header is outside its canonical section.');
    for (let index = header + 2; index < (end < 0 ? lines.length : end); index += 1) {
        if (lines[index].trim() && !recognized.has(index)) throw new Error('Disposable dependency queue has a malformed or interrupted row.');
    }
    for (const row of parsed.rows) {
        if (assertCanonicalTaskId(row.taskId) !== row.taskId || ids.has(row.taskId) || !readTaskQueueStatusToken(row.status)) {
            throw new Error('Disposable dependency queue has duplicate identities or unknown status.');
        }
        ids.add(row.taskId);
        if (readTaskQueueStatusToken(row.status) === 'DONE') continue;
        if (row.taskId.startsWith(`${taskId}-`) || mentionsTask(row.notes, taskId)
            || referencesPayload(row.rawLine, root, payloads)) snapshot.blockers.push(`Unfinished task/follow-up ${row.taskId} depends on selected disposable artifacts.`);
        const timeline = path.join(bundle, 'runtime', 'task-events', `${row.taskId}.jsonl`);
        const binding = bindContainedDestination(root, timeline);
        if (binding.missingAt) {
            snapshot.absent.push(binding);
            if (readTaskQueueStatusToken(row.status) !== 'TODO') throw new Error(`Unfinished dependency ${row.taskId} has no native timeline.`);
            continue;
        }
        readAuthorityFile(root, timeline, snapshot);
        withTaskTimelineReadSnapshot(path.dirname(timeline), row.taskId, () => {
            const integrity = inspectTaskEventFile(timeline, row.taskId, { onIntegrityEvent: event => {
                const details = JSON.stringify(event.details);
                if (mentionsTask(details, taskId) || referencesPayload(details, root, payloads)) {
                    snapshot.blockers.push(`Unfinished task/worker ${row.taskId} retains a native disposable reference.`);
                }
            } });
            if (integrity.status !== 'PASS') throw new Error(`Unfinished dependency ${row.taskId} has an unverifiable native timeline.`);
        });
    }
    const runtime = path.join(bundle, 'runtime');
    for (const namespace of ['reviews', 'task-ledger', 'project-memory', 'task-events']) {
        inspectAuthorityTree(root, path.join(runtime, namespace), snapshot, (candidate, text) => {
            const canonical = canonicalAuthorityText(candidate, text);
            if (referencesPayload(canonical, root, payloads)) snapshot.blockers.push(`Native evidence references selected raw bytes: ${path.relative(root, candidate)}. A compact ledger or self-declared migration cannot release hash-bound raw evidence.`);
        }, taskId);
    }
    inspectAuthorityTree(root, path.join(runtime, 'wip'), snapshot, (candidate, text) => {
        const canonical = canonicalAuthorityText(candidate, text);
        if (path.relative(path.join(runtime, 'wip'), candidate).split(path.sep)[0] === taskId
            || mentionsTask(canonical, taskId) || referencesPayload(canonical, root, payloads)) {
            snapshot.blockers.push(`WIP dependency requires explicit authenticated retirement/recovery: ${path.relative(root, candidate)}.`);
        }
    });
    if (listAuthorityDirectory(root, path.join(runtime, 'workers'), snapshot).length) {
        snapshot.blockers.push('Separate worker inventory is not authenticated by this preview policy; preserve selected payloads.');
    }
    assertDisposableAuthorityCurrent(snapshot);
    return snapshot;
}

export function assertDisposableAuthorityCurrent(snapshot: DisposableAuthoritySnapshot): void {
    for (const binding of snapshot.absent) assertContainedDestination(binding);
    for (const directory of snapshot.directories) {
        assertContainedDestination(directory.binding);
        if (scratchStatIdentity(lstatFileIdentitySync(directory.binding.path, { bigint: true })) !== directory.identity) {
            throw new Error('Disposable dependency directory changed before publication.');
        }
    }
    for (const file of snapshot.files) {
        const current = readScratchFile(file.binding, LIMITS.authorityFileBytes);
        if (current.identity !== file.identity || current.sha256 !== file.sha256) {
            throw new Error('Disposable dependency evidence changed before publication.');
        }
    }
}
