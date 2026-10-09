import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertContainedDestination, bindContainedDestination, readBoundedContainedDirectory,
    type ContainedDestination } from '../../core/contained-filesystem';
import { assertCanonicalTaskId, buildExactTaskIdReferencePattern } from '../../core/task-ids';
import { parseCanonicalActiveTaskQueue, parseTaskMdTableRow, type CanonicalActiveTaskQueueRow } from '../../core/task-md-table';
import { readTaskQueueStatusToken, resolveActiveTaskIds } from '../../core/task-queue/active-task-state';
import { readWipCleanupFile, WIP_CLEANUP_LIMITS, wipCleanupBindingIdentity, wipCleanupSha256,
    type WipCleanupFile, type WipCleanupReadBudget } from './cleanup-wip-ownership';

const MAX_DIRECTORY_DEPTH = 64;

export interface TaskErasureSelection {
    targetRoot: string;
    taskIds: readonly string[];
}

export interface TaskErasureBlocker {
    code: string;
    task_id: string | null;
    detail: string;
}

export interface TaskErasureReference {
    from_task_id: string;
    to_task_id: string;
    kind: 'queue-reference' | 'child-group';
}

interface DirectorySnapshot {
    binding: ContainedDestination;
    names: string[];
    identity: string;
}

function directoryIdentity(binding: ContainedDestination): string {
    const stat = fs.lstatSync(binding.path, { bigint: true });
    if (!stat.isDirectory()) throw new Error(`Preview namespace must be a directory: ${binding.path}`);
    return wipCleanupSha256(JSON.stringify([wipCleanupBindingIdentity(binding), String(stat.mtimeNs), String(stat.ctimeNs)]));
}

/** A bounded read snapshot, never a deletion capability or persisted authority. */
export class TaskErasureReadSnapshot {
    readonly files = new Map<string, WipCleanupFile>();
    private readonly boundaries = new Map<string, ContainedDestination>();
    private readonly directories = new Map<string, DirectorySnapshot>();
    private remainingNames: number = WIP_CLEANUP_LIMITS.entries;
    private readonly budget: WipCleanupReadBudget = {
        remainingBytes: WIP_CLEANUP_LIMITS.authorityBytes, remainingEntries: WIP_CLEANUP_LIMITS.entries,
        remainingSnapshotBytes: WIP_CLEANUP_LIMITS.snapshotBytes
    };

    constructor(readonly root: string) { this.bind(root); }

    presentPaths(): string[] {
        return [...this.boundaries.values()].filter(binding => !binding.missingAt).map(binding => binding.path);
    }

    bind(candidate: string): ContainedDestination {
        const file = path.resolve(candidate), cached = this.boundaries.get(file);
        if (cached) return cached;
        if (this.boundaries.size >= WIP_CLEANUP_LIMITS.entries) throw new Error('Preview boundary budget exceeded; select a smaller workspace.');
        const binding = bindContainedDestination(this.root, file);
        this.boundaries.set(file, binding);
        return binding;
    }

    read(file: string, maximumBytes: number = WIP_CLEANUP_LIMITS.artifactBytes): Buffer {
        const observed = readWipCleanupFile(this.root, file, maximumBytes, this.budget);
        const { content, ...evidence } = observed;
        const previous = this.files.get(evidence.binding.path);
        if (previous && (previous.identity !== evidence.identity || previous.sha256 !== evidence.sha256)) {
            throw new Error(`Preview file changed between reads: ${file}`);
        }
        this.bind(file);
        this.files.set(evidence.binding.path, evidence);
        return content;
    }

    list(directory: string): string[] {
        const binding = this.bind(directory);
        if (binding.missingAt) return [];
        const before = directoryIdentity(binding);
        const names = readBoundedContainedDirectory(binding, this.remainingNames);
        if (before !== directoryIdentity(binding)) throw new Error(`Preview namespace changed while listing: ${directory}`);
        this.remainingNames -= names.length;
        const previous = this.directories.get(binding.path);
        if (previous && (previous.identity !== before || JSON.stringify(previous.names) !== JSON.stringify(names))) {
            throw new Error(`Preview namespace changed between reads: ${directory}`);
        }
        this.directories.set(binding.path, { binding, names, identity: before });
        return names;
    }

    captureTree(directory: string): void {
        const pending = [{ file: directory, depth: 0 }];
        while (pending.length) {
            const current = pending.pop()!;
            if (current.depth > MAX_DIRECTORY_DEPTH) throw new Error('Preview namespace depth limit exceeded.');
            const binding = this.bind(current.file);
            if (binding.missingAt) continue;
            const stat = fs.lstatSync(binding.path);
            if (stat.isDirectory()) {
                for (const name of this.list(binding.path)) pending.push({ file: path.join(binding.path, name), depth: current.depth + 1 });
            } else {
                this.read(binding.path);
            }
        }
    }

    assertCurrent(): void {
        for (const binding of this.boundaries.values()) assertContainedDestination(binding);
        for (const directory of this.directories.values()) {
            const names = readBoundedContainedDirectory(directory.binding, WIP_CLEANUP_LIMITS.entries);
            if (directory.identity !== directoryIdentity(directory.binding) || JSON.stringify(directory.names) !== JSON.stringify(names)) {
                throw new Error(`Preview namespace changed before completion: ${directory.binding.path}`);
            }
        }
        const budget: WipCleanupReadBudget = { remainingBytes: WIP_CLEANUP_LIMITS.authorityBytes,
            remainingEntries: WIP_CLEANUP_LIMITS.entries, remainingSnapshotBytes: WIP_CLEANUP_LIMITS.snapshotBytes };
        for (const file of this.files.values()) {
            const current = readWipCleanupFile(this.root, file.binding.path, WIP_CLEANUP_LIMITS.artifactBytes, budget);
            if (file.identity !== current.identity || file.sha256 !== current.sha256) {
                throw new Error(`Preview ownership changed before completion: ${file.binding.path}`);
            }
        }
    }

    digest(): string {
        return wipCleanupSha256(JSON.stringify({
            boundaries: [...this.boundaries.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))
                .map(binding => [binding.path, binding.missingAt, wipCleanupBindingIdentity(binding)]),
            directories: [...this.directories.values()].sort((a, b) => a.binding.path.localeCompare(b.binding.path, 'en'))
                .map(directory => [directory.binding.path, directory.identity, directory.names]),
            files: [...this.files.values()].sort((a, b) => a.binding.path.localeCompare(b.binding.path, 'en'))
                .map(file => [file.binding.path, file.identity, file.sha256, file.bytes])
        }));
    }
}

export function normalizeTaskErasureSelection(options: TaskErasureSelection): { root: string; taskIds: string[] } {
    if (!options || typeof options.targetRoot !== 'string' || !options.targetRoot.trim()
        || !Array.isArray(options.taskIds) || options.taskIds.length === 0
        || options.taskIds.length > WIP_CLEANUP_LIMITS.selectedTasks) throw new Error('An exact bounded task selection and existing target root are required.');
    const taskIds: string[] = [];
    // Array iteration includes holes, which must not silently disappear from the selection.
    for (const value of options.taskIds) {
        if (typeof value !== 'string' || value !== assertCanonicalTaskId(value)) throw new Error('Task selection requires exact canonical strings without aliases.');
        taskIds.push(value);
    }
    if (new Set(taskIds.map(id => id.toLowerCase())).size !== taskIds.length) throw new Error('Task selection contains duplicate or case-ambiguous identities.');
    const root = fs.realpathSync.native(path.resolve(options.targetRoot));
    bindContainedDestination(root, root);
    return { root, taskIds: taskIds.sort() };
}

export function readErasureQueue(snapshot: TaskErasureReadSnapshot): CanonicalActiveTaskQueueRow[] {
    const content = snapshot.read(path.join(snapshot.root, 'TASK.md'), WIP_CLEANUP_LIMITS.queueBytes).toString('utf8');
    const queue = parseCanonicalActiveTaskQueue(content), lines = content.split(/\r?\n/u);
    const sections = lines.flatMap((line, index) => line.trim() === '## Active Queue' ? [index] : []);
    if (!queue.found || sections.length !== 1 || queue.rows.length > WIP_CLEANUP_LIMITS.queueRows) {
        throw new Error(`Canonical queue ownership is unavailable: ${queue.unavailableReason || 'ambiguous section or row limit'}`);
    }
    const start = sections[0], next = lines.findIndex((line, index) => index > start && /^#{1,2}\s/u.test(line.trim()));
    const end = next < 0 ? lines.length : next;
    const header = lines.findIndex((line, index) => index > start && index < end
        && parseTaskMdTableRow(line)[0]?.trimmed === 'ID' && parseTaskMdTableRow(line)[1]?.trimmed === 'Status');
    if (header < 0 || header + 1 >= end) throw new Error('Canonical queue header is unavailable.');
    const recognized = new Set(queue.rows.map(row => row.lineIndex)), ids = new Set<string>();
    for (let index = header + 2; index < end; index += 1) {
        if (lines[index].trim() && !recognized.has(index)) throw new Error(`Malformed or interrupted queue row at line ${index + 1}.`);
    }
    for (const row of queue.rows) {
        assertCanonicalTaskId(row.taskId);
        const key = row.taskId.toLowerCase();
        if (ids.has(key) || !readTaskQueueStatusToken(row.status)) throw new Error(`Duplicate queue identity or unknown status: ${row.taskId}`);
        ids.add(key);
    }
    return queue.rows;
}

export function resolveErasureSelection(root: string, taskIds: string[], rows: CanonicalActiveTaskQueueRow[],
    blockers: TaskErasureBlocker[], authenticatedActivity: ReadonlySet<string> = new Set()): { references: TaskErasureReference[]; statuses: Array<{ task_id: string; status: string }> } {
    const selected = new Set(taskIds), references: TaskErasureReference[] = [], statuses: Array<{ task_id: string; status: string }> = [];
    const active = resolveActiveTaskIds(root, path.join(root, 'garda-agent-orchestrator'), undefined,
        { includeAmbiguousRuntimeTasks: true, includeStaleRuntimeActiveTasks: true });
    const activeKeys = new Set([...active, ...authenticatedActivity].map(id => id.toLowerCase()));
    for (const taskId of taskIds) {
        const row = rows.find(item => item.taskId === taskId);
        if (!row) { blockers.push({ code: 'UNKNOWN_TASK', task_id: taskId, detail: 'Exact selected ID does not exist in the canonical queue.' }); continue; }
        const status = readTaskQueueStatusToken(row.status)!;
        statuses.push({ task_id: taskId, status });
        if (status === 'IN_PROGRESS' || status === 'IN_REVIEW' || activeKeys.has(taskId.toLowerCase())) {
            blockers.push({ code: 'ACTIVE_TASK', task_id: taskId, detail: 'Queued or current/stale/ambiguous runtime activity prevents task erasure.' });
        }
        const pattern = buildExactTaskIdReferencePattern(taskId);
        for (const survivor of rows.filter(item => !selected.has(item.taskId))) {
            const explicit = pattern.test(survivor.rawLine);
            const child = survivor.taskId.startsWith(`${taskId}-`);
            if (!explicit && !child) continue;
            references.push({ from_task_id: survivor.taskId, to_task_id: taskId, kind: child ? 'child-group' : 'queue-reference' });
            blockers.push({ code: 'SURVIVING_REFERENCE', task_id: taskId,
                detail: `Surviving task ${survivor.taskId} retains a ${child ? 'child-group' : 'queue'} reference; select its owning group or resolve the reference separately.` });
        }
    }
    return { references, statuses };
}
