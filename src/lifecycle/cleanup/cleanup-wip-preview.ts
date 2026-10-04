import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertContainedDestination, bindContainedDestination, readBoundedContainedDirectory, type ContainedDestination } from '../../core/contained-filesystem';
import { isPlainRecord } from '../../core/records';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { parseCanonicalActiveTaskQueue, parseTaskMdTableRow, type CanonicalActiveTaskQueueRow } from '../../core/task-md-table';
import { readTaskQueueStatusToken } from '../../core/task-queue/task-queue-status';
import { inspectTaskEventFile, readTaskTimelineFileSnapshot, withTaskTimelineReadSnapshot } from '../../gate-runtime/task-events';
import { joinOrchestratorPath, normalizePath } from '../../gates/shared/helpers';
import { resolveInputPathInsideRepo, resolveWipRoot } from '../../gates/split-required/split-required-wip-contracts';
import {
    readAuthenticatedWipPackage, readWipCleanupFile, WIP_CLEANUP_LIMITS,
    sameWipRestoreRuntimeGeneration, wipCleanupBindingIdentity, wipCleanupPathKey, wipCleanupSha256,
    type AuthenticatedWipPackage, type WipCleanupFile, type WipCleanupReadBudget
} from './cleanup-wip-ownership';

const MAX_GLOBAL_REVALIDATION_CHECKS = 65_536;
const LIFECYCLE_AND_QUEUE_CHECKS_PER_PASS = 2;
const MAX_REFERENCE_ALIAS_CHECKS = 128;
const MAX_REFERENCE_ALIAS_CHARACTERS = 32_768;

export interface WipCleanupSelection {
    targetRoot: string;
    taskIds: readonly string[];
    manifestPaths?: readonly string[];
}

export interface WipCleanupPackagePreview {
    task_id: string;
    manifest_path: string;
    manifest_sha256: string | null;
    tree_sha256: string | null;
    classification: 'retired-orphan' | 'referenced' | 'ambiguous';
    reference_task_ids: string[];
    file_count: number;
    total_bytes: number;
    blockers: string[];
}

export interface RetiredWipCleanupPreview {
    schema_version: 1;
    kind: 'retired_wip_cleanup_preview';
    status: 'READY' | 'BLOCKED';
    task_ids: string[];
    ownership_digest: string;
    inventory_complete: boolean;
    package_count: number;
    deletable_package_count: number;
    file_count: number;
    total_bytes: number;
    packages: WipCleanupPackagePreview[];
    blockers: string[];
}

export interface RetiredWipCleanupSnapshot {
    root: string;
    taskIds: string[];
    timelineTaskIds: string[];
    packages: AuthenticatedWipPackage[];
    authorityFiles: WipCleanupFile[];
    boundaries: ContainedDestination[];
    preview: RetiredWipCleanupPreview;
}

interface WipAuthority {
    rows: CanonicalActiveTaskQueueRow[];
    records: Map<string, Readonly<Record<string, unknown>>[]>;
    files: WipCleanupFile[];
    boundaries: ContainedDestination[];
    blockers: string[];
    timelineTaskIds: string[];
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function normalizeSelection(options: WipCleanupSelection): { root: string; taskIds: string[] } {
    if (!options || typeof options.targetRoot !== 'string' || !options.targetRoot.trim()
        || !Array.isArray(options.taskIds) || options.taskIds.length === 0
        || options.taskIds.length > WIP_CLEANUP_LIMITS.selectedTasks) throw new Error('WIP cleanup requires an exact bounded task selection and target root.');
    const root = fs.realpathSync.native(path.resolve(options.targetRoot));
    bindContainedDestination(root, root);
    const taskIds = options.taskIds.map(id => assertCanonicalTaskId(id));
    if (new Set(taskIds).size !== taskIds.length) throw new Error('WIP task selection contains duplicate identities.');
    return { root, taskIds: taskIds.sort() };
}

function readQueue(root: string, budget: WipCleanupReadBudget): { rows: CanonicalActiveTaskQueueRow[]; file: WipCleanupFile } {
    const file = readWipCleanupFile(root, path.join(root, 'TASK.md'), WIP_CLEANUP_LIMITS.queueBytes, budget);
    const content = file.content.toString('utf8'), queue = parseCanonicalActiveTaskQueue(content);
    if (!queue.found || queue.rows.length > WIP_CLEANUP_LIMITS.queueRows) throw new Error(`WIP queue ownership is unavailable: ${queue.unavailableReason || 'row limit exceeded'}`);
    const lines = content.split(/\r?\n/u), start = lines.findIndex(line => line.trim() === '## Active Queue');
    if (start < 0 || lines.filter(line => line.trim() === '## Active Queue').length !== 1) {
        throw new Error('WIP queue requires one unambiguous canonical Active Queue section.');
    }
    const nextHeading = lines.findIndex((line, index) => index > start && /^#{1,2}\s/u.test(line.trim()));
    const sectionEnd = nextHeading < 0 ? lines.length : nextHeading;
    const header = lines.findIndex((line, index) => index > start && parseTaskMdTableRow(line)[0]?.trimmed === 'ID'
        && parseTaskMdTableRow(line)[1]?.trimmed === 'Status');
    if (header < 0 || header + 1 >= sectionEnd) throw new Error('WIP queue canonical header is outside its Active Queue section.');
    const recognized = new Set(queue.rows.map(row => row.lineIndex));
    for (let index = header + 2; index < sectionEnd; index += 1) {
        if (lines[index].trim() && !recognized.has(index)) {
            throw new Error(`WIP queue has a malformed or interrupted active row at line ${index + 1}.`);
        }
    }
    const ids = new Set<string>();
    for (const row of queue.rows) {
        assertCanonicalTaskId(row.taskId);
        if (ids.has(row.taskId) || !readTaskQueueStatusToken(row.status)) throw new Error(`WIP queue has duplicate identity or unknown status: ${row.taskId}`);
        ids.add(row.taskId);
    }
    const { content: ignored, ...evidence } = file;
    void ignored;
    return { rows: queue.rows, file: evidence };
}

function readTimeline(root: string, taskId: string, required: boolean, authority: WipAuthority, budget: WipCleanupReadBudget): void {
    const eventsRoot = joinOrchestratorPath(root, 'runtime/task-events'), filePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const binding = bindContainedDestination(root, filePath);
    authority.boundaries.push(binding);
    if (binding.missingAt) {
        if (required) throw new Error(`Unfinished task ${taskId} has missing canonical timeline evidence; preserve its WIP references.`);
        authority.records.set(taskId, []);
        return;
    }
    const file = readWipCleanupFile(root, filePath, WIP_CLEANUP_LIMITS.artifactBytes, budget);
    const records: Readonly<Record<string, unknown>>[] = [];
    withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        const inspected = inspectTaskEventFile(filePath, taskId, { onIntegrityEvent: record => {
            if (record.task_id !== taskId || typeof record.event_type !== 'string' || !record.event_type.trim()) {
                throw new Error(`Canonical WIP timeline ${taskId} has malformed task identity or event type.`);
            }
            records.push(record);
        } });
        const snapshot = readTaskTimelineFileSnapshot(filePath);
        if (!snapshot.valid || snapshot.sha256 !== file.sha256 || inspected.status === 'FAILED'
            || inspected.parse_errors || inspected.task_id_mismatches || inspected.legacy_event_count
            || inspected.violations.length || inspected.duplicate_event_hashes.length
            || inspected.matching_events !== inspected.integrity_event_count
            || required && inspected.matching_events === 0) {
            throw new Error(`Canonical WIP timeline ${taskId} is malformed, unreadable or changed: ${inspected.violations.join(' | ')}`);
        }
    });
    const { content: ignored, ...evidence } = file;
    void ignored;
    authority.files.push(evidence);
    authority.records.set(taskId, records);
}

function readAuthority(root: string, taskIds: string[]): WipAuthority {
    const authority: WipAuthority = { rows: [], files: [], records: new Map(), boundaries: [], blockers: [], timelineTaskIds: [] };
    const budget: WipCleanupReadBudget = { remainingBytes: WIP_CLEANUP_LIMITS.authorityBytes,
        remainingEntries: WIP_CLEANUP_LIMITS.queueRows + WIP_CLEANUP_LIMITS.selectedTasks + 1 };
    try {
        const queue = readQueue(root, budget);
        authority.rows = queue.rows;
        authority.files.push(queue.file);
    } catch (error) { authority.blockers.push(message(error)); return authority; }
    const unfinished = authority.rows.filter(row => readTaskQueueStatusToken(row.status) !== 'DONE');
    authority.timelineTaskIds = [...new Set([...taskIds, ...unfinished.map(row => row.taskId)])].sort();
    for (const taskId of authority.timelineTaskIds) {
        const row = unfinished.find(item => item.taskId === taskId);
        try { readTimeline(root, taskId, Boolean(row && readTaskQueueStatusToken(row.status) !== 'TODO'), authority, budget); }
        catch (error) { authority.blockers.push(message(error)); }
    }
    return authority;
}

function listBoundDirectory(root: string, directory: string, boundaries: ContainedDestination[],
    maximumEntries: number = WIP_CLEANUP_LIMITS.entries): string[] {
    const binding = bindContainedDestination(root, directory);
    boundaries.push(binding);
    if (binding.missingAt) return [];
    const before = fs.lstatSync(directory, { bigint: true });
    if (!before.isDirectory()) throw new Error(`WIP namespace must remain a directory: ${normalizePath(directory)}`);
    const entries = readBoundedContainedDirectory(binding, maximumEntries);
    const after = fs.lstatSync(directory, { bigint: true });
    assertContainedDestination(binding);
    if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || entries.length > maximumEntries) throw new Error('WIP namespace changed or exceeded its entry limit.');
    return entries;
}

function selectManifestPaths(options: WipCleanupSelection, root: string, taskIds: string[], boundaries: ContainedDestination[], blockers: string[]): Array<{ taskId: string; file: string }> {
    if (options.manifestPaths !== undefined) {
        if (!Array.isArray(options.manifestPaths) || options.manifestPaths.length === 0 || options.manifestPaths.length > WIP_CLEANUP_LIMITS.entries) throw new Error('WIP manifest selection must be a nonempty bounded array.');
        const entries = options.manifestPaths.map(input => {
            if (typeof input !== 'string') throw new Error('WIP manifest path must be a string.');
            const file = resolveInputPathInsideRepo(root, input, 'ManifestPath');
            const taskId = taskIds.find(id => wipCleanupPathKey(path.dirname(path.dirname(file))) === wipCleanupPathKey(resolveWipRoot(root, id)));
            if (!taskId || path.basename(file) !== 'manifest.json') throw new Error('WIP manifest selection crosses the exact selected task boundary.');
            return { taskId, file };
        });
        if (new Set(entries.map(entry => wipCleanupPathKey(entry.file))).size !== entries.length) throw new Error('WIP manifest selection contains duplicate package identities.');
        return entries.sort((left, right) => wipCleanupPathKey(left.file).localeCompare(wipCleanupPathKey(right.file), 'en'));
    }
    const entries: Array<{ taskId: string; file: string }> = [];
    for (const taskId of taskIds) {
        const splitRoot = resolveWipRoot(root, taskId), ownerRoot = path.dirname(splitRoot);
        try {
            for (const name of listBoundDirectory(root, ownerRoot, boundaries)) {
                if (name !== 'split-required') blockers.push(`WIP namespace ${taskId}/${name} has unsupported ownership; preserve it for explicit recovery.`);
            }
            for (const name of listBoundDirectory(root, splitRoot, boundaries, WIP_CLEANUP_LIMITS.entries - entries.length)) {
                entries.push({ taskId, file: path.join(splitRoot, name, 'manifest.json') });
            }
        } catch (error) { blockers.push(message(error)); }
    }
    if (entries.length > WIP_CLEANUP_LIMITS.entries) throw new Error('Selected WIP package limit exceeded.');
    return entries;
}

function exactManifestReference(root: string, value: unknown, manifestPath: string): boolean {
    if (typeof value !== 'string' || !value.trim()) return false;
    return wipCleanupPathKey(path.resolve(root, value)) === wipCleanupPathKey(manifestPath);
}

function containsPackagePath(root: string, reference: string, packagePath: string): boolean {
    const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const candidate = comparable(reference);
    return [normalizePath(packagePath), normalizePath(path.relative(root, packagePath))].some(value => {
        const packageReference = comparable(value);
        let offset = -1;
        while ((offset = candidate.indexOf(packageReference, offset + 1)) !== -1) {
            const before = candidate[offset - 1], after = candidate.slice(offset + packageReference.length);
            if ((offset === 0 || /[\s<>()\[\]`"'=:,;]/u.test(before))
                && (!after || /^(?:\/|[\s<>()\[\]`"'=:,;!?]|\.(?=$|[\s<>()\[\]`"'.,;!?]))/u.test(after))) return true;
        }
        return false;
    });
}

function containsResolvedPackagePath(root: string, reference: string, packagePath: string): boolean {
    return containsPackagePath(root, path.posix.normalize(reference), packagePath)
        || containsPackagePath(root, normalizePath(path.resolve(root, reference)), packagePath);
}

function containsDelimitedRelativeReference(root: string, reference: string, packagePath: string): boolean {
    const relative = normalizePath(path.relative(root, packagePath)).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const occurrences = new RegExp(relative, process.platform === 'win32' ? 'giu' : 'gu');
    let remainingChecks = MAX_REFERENCE_ALIAS_CHECKS;
    for (const occurrence of reference.matchAll(occurrences)) {
        const offset = occurrence.index, end = offset + occurrence[0].length;
        if (reference[offset - 1] !== '/' || !containsPackagePath(root, reference.slice(offset, end + 2), packagePath)) continue;
        if (remainingChecks-- === 0) throw new Error('WIP reference alias exceeds its bounded resolution budget.');
        const earliest = Math.max(0, end - MAX_REFERENCE_ALIAS_CHARACTERS);
        // Resolve complete candidates; delimiters inside a directory name remain intact.
        for (let start = offset - 1; start >= earliest; start -= 1) {
            if (start > 0 && !/[\s<>()\[\]`"'=:,;!?]/u.test(reference[start - 1])) continue;
            if (remainingChecks-- === 0) throw new Error('WIP reference alias exceeds its bounded resolution budget.');
            const candidate = reference.slice(start, end);
            if (!path.isAbsolute(candidate) && containsResolvedPackagePath(root, candidate, packagePath)) return true;
        }
        if (earliest > 0) throw new Error('WIP reference alias exceeds its bounded path length.');
    }
    return false;
}

function containsReference(root: string, value: unknown, packagePath: string, depth = 0,
    selfReferenceFields: readonly string[] = []): boolean {
    if (depth > 32) throw new Error('WIP reference nesting exceeds the supported bound.');
    if (typeof value === 'string') {
        const reference = value.replace(/\\/gu, '/');
        if (containsPackagePath(root, reference, packagePath)
            || containsPackagePath(root, path.posix.normalize(reference), packagePath)) return true;
        for (const candidate of reference.matchAll(/[^\s<>()\[\]`"']+/gu)) {
            if (containsResolvedPackagePath(root, candidate[0], packagePath)) return true;
        }
        for (const candidate of reference.matchAll(/[^<>()\[\]`"'\r\n=:,;!?]+/gu)) {
            const candidatePath = candidate[0].trim();
            if (candidatePath && containsResolvedPackagePath(root, candidatePath, packagePath)) return true;
        }
        return containsDelimitedRelativeReference(root, reference, packagePath);
    }
    if (Array.isArray(value)) return value.some(item => containsReference(root, item, packagePath, depth + 1));
    if (!isPlainRecord(value)) return false;
    return Object.entries(value).some(([key, item]) => {
        if (selfReferenceFields.includes(key)) return false;
        if ((key === 'manifest_path' || key === 'wip_manifest_path') && item !== null && item !== undefined) {
            if (typeof item !== 'string') throw new Error('Canonical WIP reference path is malformed.');
            if (exactManifestReference(root, item, path.join(packagePath, 'manifest.json'))) return true;
        }
        return containsReference(root, item, packagePath, depth + 1);
    });
}

function lifecycleSelfReferenceFields(root: string, item: AuthenticatedWipPackage,
    record: Readonly<Record<string, unknown>>, records: readonly Readonly<Record<string, unknown>>[]): readonly string[] {
    const type = record.event_type;
    if (typeof type !== 'string' || !['SPLIT_REQUIRED_WIP_CAPTURED', 'SPLIT_REQUIRED_WIP_RETIRED', 'SPLIT_REQUIRED_WIP_RESTORED'].includes(type)) return [];
    const details = record.details;
    const outcome = type === 'SPLIT_REQUIRED_WIP_RETIRED' ? 'INFO' : 'PASS';
    if (!isPlainRecord(details) || typeof details.manifest_path !== 'string' || !details.manifest_path.trim()
        || typeof details.manifest_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(details.manifest_sha256)
        || record.actor !== 'orchestrator'
        || (type !== 'SPLIT_REQUIRED_WIP_CAPTURED' && record.outcome !== outcome)) {
        throw new Error('Canonical WIP lifecycle reference details are malformed.');
    }
    const lists = type === 'SPLIT_REQUIRED_WIP_RESTORED' ? ['selected_paths', 'restored_files'] : [];
    for (const key of lists) {
        if (!Array.isArray(details[key]) || !details[key].every(value => typeof value === 'string')) {
            throw new Error('Canonical WIP lifecycle source selection is malformed.');
        }
    }
    if (type === 'SPLIT_REQUIRED_WIP_RETIRED' && (typeof details.reason !== 'string' || !details.reason.trim())) {
        throw new Error('Canonical WIP retirement reason is malformed.');
    }
    if (type === 'SPLIT_REQUIRED_WIP_RESTORED'
        && (typeof details.handoff_id !== 'string' || !/^[0-9a-f]{64}$/u.test(details.handoff_id)
            || typeof details.handoff_path !== 'string' || !details.handoff_path.trim() || !isPlainRecord(details.runtime_generation))) {
        throw new Error('Canonical WIP restore reference details are malformed.');
    }
    if (!exactManifestReference(root, details.manifest_path, item.manifestPath)) return [];
    if (type === 'SPLIT_REQUIRED_WIP_RETIRED') authenticateRetirement(root, item, records);
    if (type === 'SPLIT_REQUIRED_WIP_RESTORED') {
        const handoff = item.handoffs.find(value => value.value.status === 'finalized' && value.value.handoff_id === details.handoff_id);
        if (!handoff) throw new Error('Canonical WIP restore self-reference lacks its authenticated finalized handoff.');
        assertFinalizedHandoff(root, item, handoff, records);
        return ['manifest_path', 'handoff_path'];
    }
    return ['manifest_path'];
}

function referenceTasks(root: string, item: AuthenticatedWipPackage, authority: WipAuthority): string[] {
    const owners = new Set<string>();
    const packagePath = path.dirname(item.manifestPath);
    for (const row of authority.rows.filter(row => readTaskQueueStatusToken(row.status) !== 'DONE')) {
        if (containsReference(root, row.notes, packagePath)) owners.add(row.taskId);
        const records = authority.records.get(row.taskId) || [];
        for (const record of records) {
            const selfReferences = row.taskId === item.taskId ? lifecycleSelfReferenceFields(root, item, record, records) : [];
            if (containsReference(root, record.details, packagePath, 0, selfReferences)) owners.add(row.taskId);
        }
    }
    return [...owners].sort();
}

function authenticateRetirement(root: string, item: AuthenticatedWipPackage, records: readonly Readonly<Record<string, unknown>>[]): void {
    const retirements = records.filter(record => record.event_type === 'SPLIT_REQUIRED_WIP_RETIRED'
        && isPlainRecord(record.details) && exactManifestReference(root, record.details.manifest_path, item.manifestPath));
    if (retirements.length !== 1) throw new Error('WIP requires exactly one canonical retirement event for its exact manifest path.');
    const record = retirements[0], details = record.details;
    if (record.actor !== 'orchestrator' || record.outcome !== 'INFO' || !isPlainRecord(details)
        || details.manifest_sha256 !== item.manifestSha256 || details.reason !== item.manifest.retired_reason) {
        throw new Error('WIP retirement evidence conflicts with the current manifest hash, author, outcome or reason.');
    }
}

function assertFinalizedHandoff(root: string, item: AuthenticatedWipPackage, handoff: AuthenticatedWipPackage['handoffs'][number], records: readonly Readonly<Record<string, unknown>>[]): void {
    const value = handoff.value;
    const matches = records.filter(record => record.event_type === 'SPLIT_REQUIRED_WIP_RESTORED'
        && isPlainRecord(record.details) && record.details.handoff_id === value.handoff_id);
    if (matches.length !== 1 || !isPlainRecord(value.event_integrity) || typeof value.repo_root !== 'string'
        || wipCleanupPathKey(value.repo_root) !== wipCleanupPathKey(root)) throw new Error('Finalized WIP restore handoff lacks unique canonical restore authority.');
    const record = matches[0], details = record.details;
    if (!isPlainRecord(details) || !isPlainRecord(record.integrity) || record.actor !== 'orchestrator' || record.outcome !== 'PASS'
        || !exactManifestReference(root, details.manifest_path, item.manifestPath)
        || details.manifest_sha256 !== value.manifest_sha256 || typeof details.handoff_path !== 'string'
        || wipCleanupPathKey(path.resolve(root, details.handoff_path)) !== wipCleanupPathKey(handoff.path)
        || record.integrity.event_sha256 !== value.event_integrity.event_sha256
        || record.integrity.schema_version !== value.event_integrity.schema_version
        || record.integrity.task_sequence !== value.event_integrity.task_sequence
        || record.integrity.prev_event_sha256 !== value.event_integrity.prev_event_sha256
        || record.integrity.task_sequence !== value.timeline_anchor.last_integrity_sequence! + 1
        || record.integrity.prev_event_sha256 !== value.timeline_anchor.last_event_sha256
        || !value.runtime_generation || !sameWipRestoreRuntimeGeneration(details.runtime_generation, value.runtime_generation)
        || JSON.stringify(details.selected_paths) !== JSON.stringify(value.selected_paths)
        || JSON.stringify(details.restored_files) !== JSON.stringify(value.restored_files)) {
        throw new Error('Finalized WIP restore handoff conflicts with its canonical restore event.');
    }
    const captures = records.filter(record => record.event_type === 'SPLIT_REQUIRED_WIP_CAPTURED'
        && record.actor === 'orchestrator' && record.outcome === 'BLOCKED' && isPlainRecord(record.details)
        && exactManifestReference(root, record.details.manifest_path, item.manifestPath)
        && record.details.manifest_sha256 === value.manifest_sha256);
    const anchor = records.find(record => isPlainRecord(record.integrity)
        && record.integrity.task_sequence === value.timeline_anchor.last_integrity_sequence
        && record.integrity.event_sha256 === value.timeline_anchor.last_event_sha256);
    if (captures.length !== 1 || !anchor) throw new Error('Finalized WIP restore handoff lacks canonical capture or predecessor authority.');
}

function classifyPackage(root: string, item: AuthenticatedWipPackage, authority: WipAuthority): WipCleanupPackagePreview {
    const result: WipCleanupPackagePreview = { task_id: item.taskId, manifest_path: normalizePath(item.manifestPath),
        manifest_sha256: item.manifestSha256, tree_sha256: item.treeSha256, classification: 'retired-orphan',
        reference_task_ids: referenceTasks(root, item, authority), file_count: item.files.length,
        total_bytes: item.files.reduce((sum, file) => sum + file.bytes, 0), blockers: [] };
    if (item.manifest.status === 'suspended') {
        result.reference_task_ids.push(item.taskId);
        result.blockers.push('Suspended WIP is required source work; queue status does not authorize removal. Retire it explicitly when it is no longer required.');
    }
    for (const handoff of item.handoffs) {
        if (handoff.value.status === 'finalized') assertFinalizedHandoff(root, item, handoff, authority.records.get(item.taskId) || []);
        else { result.reference_task_ids.push(item.taskId); result.blockers.push(`WIP restore handoff is ${handoff.value.status}; finalize or explicitly recover it before cleanup.`); }
    }
    result.reference_task_ids = [...new Set(result.reference_task_ids)].sort();
    if (result.reference_task_ids.length) {
        result.classification = 'referenced';
        result.blockers.push(`WIP is referenced by unfinished source work or restore handoffs: ${result.reference_task_ids.join(', ')}.`);
    } else authenticateRetirement(root, item, authority.records.get(item.taskId) || []);
    if (authority.blockers.length && result.classification !== 'referenced') {
        result.classification = 'ambiguous';
        result.blockers.push('Canonical task authority is incomplete; inspect shared preview blockers before cleanup.');
    }
    return result;
}

export function prepareRetiredWipCleanupSnapshot(options: WipCleanupSelection): RetiredWipCleanupSnapshot {
    const packages: AuthenticatedWipPackage[] = [], previews: WipCleanupPackagePreview[] = [], boundaries: ContainedDestination[] = [], blockers: string[] = [];
    let root = '', taskIds: string[] = [], authority: WipAuthority = { rows: [], records: new Map(), files: [], boundaries: [], blockers: [], timelineTaskIds: [] };
    try {
        ({ root, taskIds } = normalizeSelection(options));
        authority = readAuthority(root, taskIds);
        blockers.push(...authority.blockers);
        const selected = selectManifestPaths(options, root, taskIds, boundaries, blockers);
        const budget: WipCleanupReadBudget = { remainingBytes: WIP_CLEANUP_LIMITS.packageBytes, remainingEntries: WIP_CLEANUP_LIMITS.entries };
        for (const { taskId, file } of selected) {
            try {
                if (budget.remainingEntries < 1) throw new Error('Selected WIP aggregate entry budget exceeded; select fewer packages.');
                const item = readAuthenticatedWipPackage(root, taskId, file, budget), classified = classifyPackage(root, item, authority);
                packages.push(item); previews.push(classified);
            } catch (error) {
                previews.push({ task_id: taskId, manifest_path: normalizePath(file), manifest_sha256: null,
                    tree_sha256: null, classification: 'ambiguous', reference_task_ids: [], file_count: 0,
                    total_bytes: 0, blockers: [message(error)] });
            }
        }
    } catch (error) { blockers.push(message(error)); }
    const inventoryComplete = !blockers.length && previews.every(item => item.classification !== 'ambiguous');
    blockers.push(...previews.flatMap(item => item.blockers));
    const fileCount = previews.reduce((sum, item) => sum + item.file_count, 0), totalBytes = previews.reduce((sum, item) => sum + item.total_bytes, 0);
    if (fileCount > WIP_CLEANUP_LIMITS.entries || totalBytes > WIP_CLEANUP_LIMITS.packageBytes) blockers.push('Selected WIP aggregate exceeds the bounded entry or byte limit; select fewer packages.');
    const allBoundaries = [...authority.boundaries, ...boundaries];
    const directoryCount = packages.reduce((sum, item) => sum + item.directories.length, 0);
    const mutationCount = packages.reduce((sum, item) => sum + item.files.length, directoryCount);
    // Directory watches are a subset of retained boundaries plus package directories.
    const checksPerPass = authority.files.length + authority.timelineTaskIds.length + allBoundaries.length
        + allBoundaries.length + directoryCount + LIFECYCLE_AND_QUEUE_CHECKS_PER_PASS;
    if ((mutationCount + 1) * checksPerPass > MAX_GLOBAL_REVALIDATION_CHECKS) {
        blockers.push('Selected WIP global revalidation exceeds its operation budget; select fewer packages or defer cleanup until fewer tasks remain unfinished.');
    }
    const uniqueBlockers = [...new Set(blockers)];
    const digest = wipCleanupSha256(JSON.stringify({ schema_version: 1, root: normalizePath(root), taskIds,
        packages: previews, authority: authority.files.map(file => [file.identity, file.sha256]),
        boundaries: allBoundaries.map(binding => [wipCleanupBindingIdentity(binding), binding.missingAt]), blockers: uniqueBlockers }));
    const preview: RetiredWipCleanupPreview = { schema_version: 1, kind: 'retired_wip_cleanup_preview',
        status: uniqueBlockers.length ? 'BLOCKED' : 'READY', task_ids: taskIds, ownership_digest: digest,
        inventory_complete: inventoryComplete,
        package_count: previews.length, deletable_package_count: previews.filter(item => item.classification === 'retired-orphan').length,
        file_count: fileCount, total_bytes: totalBytes, packages: previews, blockers: uniqueBlockers };
    return { root, taskIds, timelineTaskIds: authority.timelineTaskIds, packages,
        authorityFiles: authority.files, boundaries: allBoundaries, preview };
}

export function previewRetiredWipCleanup(options: WipCleanupSelection): RetiredWipCleanupPreview {
    return prepareRetiredWipCleanupSnapshot(options).preview;
}
