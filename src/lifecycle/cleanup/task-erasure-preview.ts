import * as path from 'node:path';

import { buildExactTaskIdReferencePattern, parseTaskIdJsonlFileName } from '../../core/task-ids';
import { isTaskQueueActiveStatus, isTaskQueueTerminalStatus } from '../../core/task-queue/active-task-state';
import { inspectTaskEventFile, readTaskTimelineFileSnapshot, withTaskTimelineReadSnapshot } from '../../gate-runtime/task-events';
import { collectTaskRuntimePurgeInventory } from './cleanup-runtime-retention';
import { previewRetiredWipCleanup, type RetiredWipCleanupPreview } from './cleanup-wip-preview';
import { WIP_CLEANUP_LIMITS, wipCleanupSha256 } from './cleanup-wip-ownership';
import { listRuntimeCleanupSideEffectActionsForRemovedCategories } from './runtime-cleanup-ownership';
import { normalizeTaskErasureSelection, readErasureQueue, resolveErasureSelection, TaskErasureReadSnapshot,
    type TaskErasureSelection, type TaskErasureBlocker, type TaskErasureReference } from './task-erasure-selection';

const INVENTORY_NAMESPACES = ['manual-validation', 'compact', 'reviews', 'task-events', 'plans', 'project-memory', 'task-ledger', 'tmp'] as const;
const SHARED_FILES = ['reviews/reviews-index.json', 'task-events/all-tasks.jsonl', 'task-events/.timeline-summary.json', 'metrics.jsonl'] as const;
const RUNTIME_RESTART_EVENTS = new Set(['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'REVIEW_PHASE_STARTED']);

export interface TaskErasureFilePreview {
    path: string;
    task_id: string;
    category: string;
    bytes: number;
    sha256: string;
}

export interface TaskErasurePreview {
    schema_version: 1;
    kind: 'task_erasure_preview';
    status: 'READY' | 'BLOCKED';
    task_ids: string[];
    queue_statuses: Array<{ task_id: string; status: string }>;
    inventory_complete: boolean;
    file_count: number;
    total_bytes: number;
    ownership_digest: string;
    items: TaskErasureFilePreview[];
    references: TaskErasureReference[];
    shared_operations: string[];
    wip: RetiredWipCleanupPreview | null;
    blockers: TaskErasureBlocker[];
    mutation_authorized: false;
    full_erasure_complete: false;
    domain: {
        covered_local_domains: string[];
        excluded_local_domains: string[];
        external_copies: string[];
    };
    composition: { required_domains: string[]; base_ownership_digest: string; task_ids: string[] };
}

function relative(root: string, file: string): string { return path.relative(root, file).split(path.sep).join('/'); }
function detail(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function validateRuntimeAuthority(snapshot: TaskErasureReadSnapshot, runtime: string): Set<string> {
    const events = path.join(runtime, 'task-events');
    const unclosedActivity = new Set<string>();
    for (const file of snapshot.files.values()) {
        if (path.dirname(file.binding.path) !== events) continue;
        const taskId = parseTaskIdJsonlFileName(path.basename(file.binding.path));
        if (!taskId) continue;
        withTaskTimelineReadSnapshot(events, taskId, () => {
            const inspected = inspectTaskEventFile(file.binding.path, taskId), current = readTaskTimelineFileSnapshot(file.binding.path);
            if (!current.valid || current.sha256 !== file.sha256 || inspected.status === 'FAILED'
                || inspected.parse_errors || inspected.task_id_mismatches || inspected.legacy_event_count
                || inspected.violations.length || inspected.duplicate_event_hashes.length
                || inspected.matching_events === 0 || inspected.matching_events !== inspected.integrity_event_count) {
                throw new Error(`Runtime activity authority is malformed, unauthenticated or changing for ${taskId}. Preserve the timeline.`);
            }
            // Erasure cannot age out a genuine restart. Classify the authenticated snapshot in event order.
            let active = false;
            for (const line of current.content!.toString('utf8').split('\n').filter(line => line.trim())) {
                const event = JSON.parse(line) as { event_type: string; details?: { new_status?: string } };
                const type = event.event_type.toUpperCase(), status = event.details?.new_status || '';
                if (RUNTIME_RESTART_EVENTS.has(type) || type === 'STATUS_CHANGED' && isTaskQueueActiveStatus(status)) active = true;
                if (type === 'COMPLETION_GATE_PASSED' || type === 'STATUS_CHANGED' && isTaskQueueTerminalStatus(status)) active = false;
            }
            if (active) unclosedActivity.add(taskId);
        });
    }
    return unclosedActivity;
}

function readWip(snapshot: TaskErasureReadSnapshot, runtime: string, taskIds: string[], blockers: TaskErasureBlocker[]): RetiredWipCleanupPreview | null {
    const present = taskIds.some(taskId => !snapshot.bind(path.join(runtime, 'wip', taskId)).missingAt);
    if (!present) return null;
    for (const taskId of taskIds) snapshot.captureTree(path.join(runtime, 'wip', taskId));
    const wip = previewRetiredWipCleanup({ targetRoot: snapshot.root, taskIds });
    for (const item of wip.packages) {
        if (item.classification === 'referenced') blockers.push({ code: 'REFERENCED_WIP', task_id: item.task_id,
            detail: `WIP is retained by surviving unfinished tasks: ${item.reference_task_ids.join(', ')}.` });
    }
    if (wip.status !== 'READY') for (const message of wip.blockers) blockers.push({ code: 'WIP_OWNERSHIP', task_id: null, detail: message });
    return wip;
}

function inventory(snapshot: TaskErasureReadSnapshot, runtime: string, taskIds: string[], queueIds: string[], blockers: TaskErasureBlocker[]): TaskErasureFilePreview[] {
    const candidates = collectTaskRuntimePurgeInventory(runtime, new Set(), new Set(taskIds));
    const owners = new Map<string, { taskId: string; category: string }>();
    const ownedUnits: string[] = [], longestQueueIds = [...queueIds].sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
        if (!candidate.taskId || !taskIds.includes(candidate.taskId)) throw new Error('Inventory crossed the exact selected-task boundary.');
        const prefix = path.resolve(candidate.path), binding = snapshot.bind(prefix);
        if (binding.missingAt) throw new Error(`Selected ownership disappeared: ${prefix}`);
        ownedUnits.push(prefix);
        const ownedFiles = [...snapshot.files.keys()].filter(file => file === prefix || file.startsWith(`${prefix}${path.sep}`));
        for (const file of ownedFiles) {
            const previous = owners.get(file);
            if (previous && previous.taskId !== candidate.taskId) throw new Error(`Inventory has conflicting ownership: ${file}`);
            owners.set(file, { taskId: candidate.taskId, category: candidate.category });
        }
    }
    // Best-effort legacy collectors must not turn unrecognized selected traces into a complete preview.
    for (const file of snapshot.presentPaths()) {
        const rel = path.relative(runtime, file).split(path.sep).join('/');
        if (rel.startsWith('wip/') || (SHARED_FILES as readonly string[]).includes(rel)) continue;
        const namedOwner = longestQueueIds.find(id => rel.toLowerCase().split('/').some(name =>
            name === id.toLowerCase() || name.startsWith(`${id.toLowerCase()}-`) || name.startsWith(`${id.toLowerCase()}.`)));
        const covered = ownedUnits.some(unit => file === unit || file.startsWith(`${unit}${path.sep}`));
        if (!covered && (namedOwner && taskIds.includes(namedOwner)
            || taskIds.some(id => buildExactTaskIdReferencePattern(id).test(rel)))) {
            blockers.push({ code: 'UNRESOLVED_ARTIFACT', task_id: null,
                detail: `Selected-task trace is outside the current purge ownership contract: ${relative(snapshot.root, file)}. Preserve it for an explicit owner.` });
        }
    }
    return [...owners.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([file, owner]) => {
        const evidence = snapshot.files.get(file)!;
        return { path: relative(snapshot.root, file), task_id: owner.taskId, category: owner.category,
            bytes: evidence.bytes, sha256: evidence.sha256 };
    });
}

/** Read-only base-domain preview. READY means this preview is consistent, never that erasure has completed. */
export function previewTaskErasure(options: TaskErasureSelection): TaskErasurePreview {
    let root = '', taskIds: string[] = [], items: TaskErasureFilePreview[] = [], wip: RetiredWipCleanupPreview | null = null;
    let references: TaskErasureReference[] = [], statuses: Array<{ task_id: string; status: string }> = [], snapshotDigest = '';
    const blockers: TaskErasureBlocker[] = [];
    try {
        ({ root, taskIds } = normalizeTaskErasureSelection(options));
        const snapshot = new TaskErasureReadSnapshot(root), rows = readErasureQueue(snapshot);
        const runtime = path.join(root, 'garda-agent-orchestrator', 'runtime');
        for (const namespace of INVENTORY_NAMESPACES) snapshot.captureTree(path.join(runtime, namespace));
        for (const file of SHARED_FILES) {
            const binding = snapshot.bind(path.join(runtime, file));
            if (!binding.missingAt && !snapshot.files.has(binding.path)) snapshot.read(binding.path);
        }
        const unclosedActivity = validateRuntimeAuthority(snapshot, runtime);
        ({ references, statuses } = resolveErasureSelection(root, taskIds, rows, blockers, unclosedActivity));
        items = inventory(snapshot, runtime, taskIds, rows.map(row => row.taskId), blockers);
        wip = readWip(snapshot, runtime, taskIds, blockers);
        snapshot.assertCurrent();
        snapshotDigest = snapshot.digest();
    } catch (error) { blockers.push({ code: 'OWNERSHIP_UNAVAILABLE', task_id: null, detail: detail(error) }); }
    const sharedOperations = ['remove-selected-queue-rows', 'prune-selected-shared-runtime-records',
        ...listRuntimeCleanupSideEffectActionsForRemovedCategories(new Set(items.map(item => item.category)))].sort();
    const domain = { covered_local_domains: ['canonical-task-queue', 'registered-task-runtime-artifacts', 'selected-retired-wip', 'shared-runtime-operation-preview'],
        excluded_local_domains: ['internal-recovery-copies', 'unregistered-runtime-ownership', 'generic-scratch'],
        external_copies: ['external-archives', 'git-history'] };
    const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0) + (wip?.total_bytes || 0);
    const fileCount = items.length + (wip?.file_count || 0);
    if (fileCount > WIP_CLEANUP_LIMITS.entries || totalBytes > WIP_CLEANUP_LIMITS.authorityBytes) {
        blockers.push({ code: 'INVENTORY_LIMIT', task_id: null, detail: 'Selected runtime and WIP inventory exceeds the bounded preview limit.' });
    }
    const ownershipDigest = wipCleanupSha256(JSON.stringify({ schema: 1, root, taskIds, snapshotDigest, statuses, items,
        references, sharedOperations, wip, blockers, domain }));
    return { schema_version: 1, kind: 'task_erasure_preview', status: blockers.length ? 'BLOCKED' : 'READY', task_ids: taskIds,
        queue_statuses: statuses, inventory_complete: !blockers.length, file_count: fileCount, total_bytes: totalBytes,
        ownership_digest: ownershipDigest, items, references, shared_operations: sharedOperations, wip, blockers,
        mutation_authorized: false, full_erasure_complete: false, domain,
        composition: { required_domains: ['internal-recovery-copies'], base_ownership_digest: ownershipDigest, task_ids: [...taskIds] } };
}
