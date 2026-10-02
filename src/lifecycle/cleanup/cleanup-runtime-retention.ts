import * as fs from 'node:fs';
import * as path from 'node:path';
import { containedDirectory } from '../../core/compact/store-paths';
import { resolveTaskHistoryLedgerPath } from '../../gate-runtime/task-history-ledger';
import { rebuildIndex } from '../../gate-runtime/reviews-index';
import {
    isCanonicalTaskId,
    parseStructuredTaskArtifactTaskId
} from '../../core/task-ids';
import {
    buildRuntimeRetentionPreview,
    contributesToRetentionAge,
    type RuntimeRetentionTaskPreview
} from '../runtime-policy/runtime-retention-policy';
import {
    isRuntimeCleanupTaskPurgeDeletionCategory,
    listRuntimeCleanupCollectorContracts,
    resolveRuntimeCleanupStandardPaths
} from './runtime-cleanup-ownership';
import {
    cleanupItemSizeBytes,
    directoryEntries,
    dirSizeBytes,
    fileSizeBytes,
    MS_PER_DAY,
    pathStat
} from './cleanup-filesystem-utils';
import type { CleanupItem } from './cleanup-types';
import type { RuntimeCleanupCollectorKey, RuntimeCleanupStandardPaths } from './runtime-cleanup-ownership';
import { hasConsistentReviewArtifactTaskId } from './cleanup-review-artifact-ownership';

export interface RuntimeRetentionCandidateSelection {
    previewCandidates: CleanupItem[];
    compactionCandidates: CleanupItem[];
    selectedTaskIds: Set<string>;
    boundedTaskIds: Set<string> | null;
}

export interface RuntimeRetentionSelectionOptions {
    maxEligibleTasks?: number;
    eligibleOlderThanDays?: number;
    keepLatestTasks?: number;
    now?: Date;
}

interface TaskArtifactSummary {
    taskId: string;
    newestMtimeMs: number;
    artifactCount?: number;
}

export interface TaskRuntimeBatchPurgeSelectionOptions {
    eligibleOlderThanDays?: number;
    keepLatestTasks?: number;
    now?: Date;
}

export interface TaskRuntimeBatchPurgeTaskSelection {
    candidateTaskIds: string[];
    selectedTaskIds: string[];
    selectedByAgeTaskIds: string[];
    selectedByCountTaskIds: string[];
    protectedNewestTaskIds: string[];
}

interface TaskScopedCollectorContext {
    standardPaths: RuntimeCleanupStandardPaths;
    activeTaskIds: ReadonlySet<string>;
    taskIdFilter?: ReadonlySet<string>;
}

type TaskScopedArtifactCollector = (context: TaskScopedCollectorContext) => CleanupItem[];

function isRuntimeRetentionCompactionCandidate(
    item: CleanupItem,
    compactableLedgerTaskIds: ReadonlySet<string>
): boolean {
    return Boolean(
        item.taskId
        && compactableLedgerTaskIds.has(item.taskId)
        && item.category !== 'task-ledger'
        && isRuntimeCleanupTaskPurgeDeletionCategory(item.category)
    );
}

function parseMarkdownWorkingPlanTaskId(fileName: string): string | null {
    if (!fileName.endsWith('.md')) {
        return null;
    }
    const taskId = fileName.slice(0, -'.md'.length).trim();
    return isCanonicalTaskId(taskId) ? taskId : null;
}

interface TaskArtifactInventoryCollectorOptions {
    dirPath: string;
    category: string;
    activeTaskIds: ReadonlySet<string>;
    parseTaskId: (entryName: string) => string | null;
    taskIdFilter?: ReadonlySet<string>;
    expectedKind: 'file' | 'directory';
    activeTaskMatch?: 'exact' | 'case-insensitive';
    rejectSymbolicLinks?: boolean;
}

function collectTaskArtifactInventoryEntries(options: TaskArtifactInventoryCollectorOptions): CleanupItem[] {
    const {
        dirPath,
        category,
        activeTaskIds,
        parseTaskId,
        taskIdFilter,
        expectedKind,
        activeTaskMatch = 'exact',
        rejectSymbolicLinks = false
    } = options;
    const items: CleanupItem[] = [];
    const activeTaskIdsLower = activeTaskMatch === 'case-insensitive'
        ? new Set(Array.from(activeTaskIds).map((taskId) => taskId.toLowerCase()))
        : null;

    for (const entry of directoryEntries(dirPath)) {
        const taskId = parseTaskId(entry);
        if (!taskId || !isCanonicalTaskId(taskId)) {
            continue;
        }
        const isActiveTask = activeTaskIdsLower
            ? activeTaskIdsLower.has(taskId.toLowerCase())
            : activeTaskIds.has(taskId);
        if (isActiveTask) {
            continue;
        }
        if (taskIdFilter && !taskIdFilter.has(taskId)) {
            continue;
        }
        const entryPath = path.join(dirPath, entry);
        let stat: fs.Stats | null;
        if (rejectSymbolicLinks) {
            try {
                stat = fs.lstatSync(entryPath);
            } catch {
                continue;
            }
            if (stat.isSymbolicLink()) continue;
        } else {
            stat = pathStat(entryPath);
        }
        if (!stat) {
            continue;
        }
        if (expectedKind === 'file' && !stat.isFile()) {
            continue;
        }
        if (expectedKind === 'directory' && !stat.isDirectory()) {
            continue;
        }
        items.push({
            path: entryPath,
            category,
            reason: 'retention-inventory',
            sizeBytes: cleanupItemSizeBytes(entryPath, stat),
            taskId
        });
    }

    return items;
}

function collectTaskReviewArtifactsInventory(
    reviewsDir: string,
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    if (!fs.existsSync(reviewsDir)) return [];
    const items: CleanupItem[] = [];

    let entries: string[];
    try {
        entries = fs.readdirSync(reviewsDir).sort();
    } catch {
        return [];
    }
    const indexedTaskIdsByFileName = new Map(
        rebuildIndex(reviewsDir).entries.map((entry) => [entry.fileName, entry.taskId])
    );
    const activeTaskIdsLower = new Set(Array.from(activeTaskIds, (taskId) => taskId.toLowerCase()));

    for (const entry of entries) {
        const entryPath = path.join(reviewsDir, entry);
        const taskId = indexedTaskIdsByFileName.get(entry) || null;
        if (!taskId || activeTaskIdsLower.has(taskId.toLowerCase())) {
            continue;
        }
        if (taskIdFilter && !taskIdFilter.has(taskId)) {
            continue;
        }
        if (!hasConsistentReviewArtifactTaskId(entryPath, taskId)) {
            continue;
        }
        try {
            if (!fs.statSync(entryPath).isFile()) {
                continue;
            }
        } catch {
            continue;
        }
        items.push({
            path: entryPath,
            category: 'reviews',
            reason: 'retention-inventory',
            sizeBytes: fileSizeBytes(entryPath),
            taskId
        });
    }

    return items;
}

function collectTaskTimelineArtifactsInventory(
    eventsDir: string,
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    if (!fs.existsSync(eventsDir)) return [];
    const items: CleanupItem[] = [];

    let entries: string[];
    try {
        entries = fs.readdirSync(eventsDir).sort();
    } catch {
        return [];
    }

    for (const entry of entries) {
        if (!entry.endsWith('.jsonl') || entry === 'all-tasks.jsonl') {
            continue;
        }
        const taskId = entry.replace(/\.jsonl$/, '');
        if (!isCanonicalTaskId(taskId) || activeTaskIds.has(taskId)) {
            continue;
        }
        if (taskIdFilter && !taskIdFilter.has(taskId)) {
            continue;
        }
        const entryPath = path.join(eventsDir, entry);
        try {
            if (!fs.statSync(entryPath).isFile()) {
                continue;
            }
        } catch {
            continue;
        }
        items.push({
            path: entryPath,
            category: 'task-events',
            reason: 'retention-inventory',
            sizeBytes: fileSizeBytes(entryPath),
            taskId
        });

        const cachePath = path.join(eventsDir, `${taskId}.completeness.json`);
        if (fs.existsSync(cachePath)) {
            items.push({
                path: cachePath,
                category: 'task-events',
                reason: 'retention-inventory',
                sizeBytes: fileSizeBytes(cachePath),
                taskId
            });
        }
    }

    if (taskIdFilter) {
        const existingCandidatePaths = new Set(items.map((item) => path.resolve(item.path)));
        for (const taskId of taskIdFilter) {
            if (!isCanonicalTaskId(taskId) || activeTaskIds.has(taskId)) {
                continue;
            }
            const cachePath = path.join(eventsDir, `${taskId}.completeness.json`);
            if (!fs.existsSync(cachePath) || existingCandidatePaths.has(path.resolve(cachePath))) {
                continue;
            }
            items.push({
                path: cachePath,
                category: 'task-events',
                reason: 'retention-inventory',
                sizeBytes: fileSizeBytes(cachePath),
                taskId
            });
        }
    }

    return items;
}

function collectTaskProjectMemoryArtifactsInventory(
    projectMemoryDir: string,
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    return collectTaskArtifactInventoryEntries({
        dirPath: projectMemoryDir,
        category: 'project-memory',
        activeTaskIds,
        taskIdFilter,
        parseTaskId: parseProjectMemoryArtifactTaskId,
        expectedKind: 'file'
    });
}

function parseProjectMemoryArtifactTaskId(fileName: string): string | null {
    for (const suffix of ['-impact.json', '-update.json']) {
        if (!fileName.endsWith(suffix)) {
            continue;
        }
        const taskId = fileName.slice(0, -suffix.length);
        return isCanonicalTaskId(taskId) ? taskId : null;
    }
    return null;
}

function collectTaskWorkingPlanArtifactsInventory(
    plansDir: string,
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    return collectTaskArtifactInventoryEntries({
        dirPath: plansDir,
        category: 'plans',
        activeTaskIds,
        taskIdFilter,
        parseTaskId: parseMarkdownWorkingPlanTaskId,
        expectedKind: 'file',
        activeTaskMatch: 'case-insensitive'
    });
}

function collectTaskManualValidationArtifactsInventory(
    manualValidationDir: string,
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    return collectTaskArtifactInventoryEntries({
        dirPath: manualValidationDir,
        category: 'manual-validation',
        activeTaskIds,
        taskIdFilter,
        parseTaskId: (entry) => entry,
        expectedKind: 'directory',
        activeTaskMatch: 'case-insensitive'
    });
}

function collectTaskCompactArtifactsInventory(
    compactDir: string,
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    try {
        containedDirectory(path.dirname(compactDir), 'compact');
    } catch {
        return [];
    }
    return collectTaskArtifactInventoryEntries({
        dirPath: compactDir,
        category: 'compact',
        activeTaskIds,
        taskIdFilter,
        parseTaskId: (entry) => entry,
        expectedKind: 'directory',
        activeTaskMatch: 'case-insensitive',
        rejectSymbolicLinks: true
    });
}

function collectTaskLedgerArtifactsInventory(
    taskLedgerDir: string,
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    return collectTaskArtifactInventoryEntries({
        dirPath: taskLedgerDir,
        category: 'task-ledger',
        activeTaskIds,
        taskIdFilter,
        parseTaskId: (entry) => entry.endsWith('.json') ? entry.slice(0, -'.json'.length) : null,
        expectedKind: 'file'
    });
}

function collectTaskTmpArtifactsInventory(
    tmpDir: string,
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    if (!fs.existsSync(tmpDir)) return [];
    const items: CleanupItem[] = [];
    const activeTaskIdsLower = new Set(Array.from(activeTaskIds).map((taskId) => taskId.toLowerCase()));
    const addCandidate = (entryPath: string, taskId: string, sizeBytes: number): void => {
        if (!isCanonicalTaskId(taskId) || activeTaskIdsLower.has(taskId.toLowerCase())) {
            return;
        }
        if (taskIdFilter && !taskIdFilter.has(taskId)) {
            return;
        }
        items.push({
            path: entryPath,
            category: 'tmp',
            reason: 'retention-inventory',
            sizeBytes,
            taskId
        });
    };

    const reviewScratchDir = path.join(tmpDir, 'reviews');
    for (const entry of directoryEntries(reviewScratchDir)) {
        const entryPath = path.join(reviewScratchDir, entry);
        try {
            const stat = fs.statSync(entryPath);
            if (!stat.isDirectory()) {
                continue;
            }
            addCandidate(entryPath, entry, dirSizeBytes(entryPath));
        } catch {
            // Skip unreadable scratch entries.
        }
    }

    for (const entry of directoryEntries(tmpDir)) {
        if (entry === 'reviews') {
            continue;
        }
        const taskId = isCanonicalTaskId(entry) ? entry : parseStructuredTaskArtifactTaskId(entry);
        if (!taskId) {
            continue;
        }
        const entryPath = path.join(tmpDir, entry);
        try {
            const stat = fs.statSync(entryPath);
            addCandidate(entryPath, taskId, stat.isDirectory() ? dirSizeBytes(entryPath) : stat.size);
        } catch {
            // Skip unreadable tmp entries.
        }
    }

    return items;
}

const TASK_SCOPED_ARTIFACT_COLLECTORS = Object.freeze({
    'manual-validation-task-root': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskManualValidationArtifactsInventory(standardPaths.manualValidationDir, activeTaskIds, taskIdFilter),
    'compact-task-root': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskCompactArtifactsInventory(standardPaths.compactDir, activeTaskIds, taskIdFilter),
    'reviews-task-artifacts': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskReviewArtifactsInventory(standardPaths.reviewsDir, activeTaskIds, taskIdFilter),
    'task-events-task-artifacts': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskTimelineArtifactsInventory(standardPaths.taskEventsDir, activeTaskIds, taskIdFilter),
    'plans-task-markdown': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskWorkingPlanArtifactsInventory(standardPaths.plansDir, activeTaskIds, taskIdFilter),
    'project-memory-task-artifacts': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskProjectMemoryArtifactsInventory(standardPaths.projectMemoryDir, activeTaskIds, taskIdFilter),
    'task-ledger-files': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskLedgerArtifactsInventory(standardPaths.taskLedgerDir, activeTaskIds, taskIdFilter),
    'tmp-task-artifacts': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskTmpArtifactsInventory(standardPaths.tmpDir, activeTaskIds, taskIdFilter)
} satisfies Record<RuntimeCleanupCollectorKey, TaskScopedArtifactCollector>);

function collectTaskScopedArtifactInventory(
    runtimeDir: string,
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    const standardPaths = resolveRuntimeCleanupStandardPaths(runtimeDir);
    const context: TaskScopedCollectorContext = { standardPaths, activeTaskIds, taskIdFilter };
    const items: CleanupItem[] = [];
    for (const contract of listRuntimeCleanupCollectorContracts()) {
        items.push(...TASK_SCOPED_ARTIFACT_COLLECTORS[contract.key](context));
    }
    return items;
}

export function collectTaskRuntimePurgeCandidates(runtimeDir: string, taskId: string): CleanupItem[] {
    const taskIdFilter = new Set([taskId]);
    return collectTaskRuntimePurgeInventory(runtimeDir, new Set<string>(), taskIdFilter)
        .filter((item) => item.taskId === taskId);
}

export function collectTaskRuntimePurgeInventory(
    runtimeDir: string,
    activeTaskIds: ReadonlySet<string> = new Set<string>(),
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    return collectTaskScopedArtifactInventory(runtimeDir, activeTaskIds, taskIdFilter)
        .filter((item) => item.taskId && isRuntimeCleanupTaskPurgeDeletionCategory(item.category))
        .map((item) => ({ ...item, reason: 'task-runtime-purge' }));
}

function normalizePositiveIntegerLimit(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return null;
    }
    return Math.floor(value);
}

function normalizeNonNegativeIntegerLimit(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return null;
    }
    return Math.floor(value);
}

function contributesToTaskRuntimeBatchPurgeSelectionAge(category: string): boolean {
    return isRuntimeCleanupTaskPurgeDeletionCategory(category);
}

function updateTaskArtifactSummary(
    summaries: Map<string, TaskArtifactSummary>,
    item: CleanupItem,
    contributesToAge: (category: string) => boolean = contributesToRetentionAge
): void {
    if (!item.taskId || !contributesToAge(item.category)) {
        return;
    }
    let newestMtimeMs = 0;
    try {
        newestMtimeMs = fs.statSync(item.path).mtimeMs;
    } catch {
        // Keep unreadable artifacts eligible for preview with the lowest age priority.
    }
    const existing = summaries.get(item.taskId);
    if (!existing) {
        summaries.set(item.taskId, { taskId: item.taskId, newestMtimeMs, artifactCount: 1 });
        return;
    }
    existing.artifactCount = (existing.artifactCount || 0) + 1;
    if (newestMtimeMs > existing.newestMtimeMs) {
        existing.newestMtimeMs = newestMtimeMs;
    }
}

function compareTaskIds(left: string, right: string): number {
    return left.localeCompare(right);
}

export function selectTaskRuntimeBatchPurgeTaskIds(
    inventory: readonly CleanupItem[],
    options: TaskRuntimeBatchPurgeSelectionOptions = {}
): TaskRuntimeBatchPurgeTaskSelection {
    const summaries = new Map<string, TaskArtifactSummary>();
    for (const item of inventory) {
        updateTaskArtifactSummary(summaries, item, contributesToTaskRuntimeBatchPurgeSelectionAge);
    }
    const candidates = Array.from(summaries.values());
    const candidateTaskIds = candidates.map((summary) => summary.taskId).sort(compareTaskIds);
    const protectedNewestTaskIds = new Set<string>();
    const keepLatestTasks = normalizeNonNegativeIntegerLimit(options.keepLatestTasks);
    if (keepLatestTasks !== null && keepLatestTasks > 0) {
        for (const summary of [...candidates].sort(compareTaskArtifactsByNewestFirst).slice(0, keepLatestTasks)) {
            protectedNewestTaskIds.add(summary.taskId);
        }
    }

    const selectedByAgeTaskIds = new Set<string>();
    const eligibleOlderThanDays = normalizeNonNegativeIntegerLimit(options.eligibleOlderThanDays);
    if (eligibleOlderThanDays !== null) {
        const cutoffMs = (options.now ?? new Date()).getTime() - eligibleOlderThanDays * MS_PER_DAY;
        for (const summary of candidates) {
            if (summary.newestMtimeMs <= cutoffMs) {
                selectedByAgeTaskIds.add(summary.taskId);
            }
        }
    }

    const selectedByCountTaskIds = new Set<string>();
    if (eligibleOlderThanDays === null && keepLatestTasks !== null && keepLatestTasks > 0) {
        for (const summary of candidates) {
            if (!protectedNewestTaskIds.has(summary.taskId)) {
                selectedByCountTaskIds.add(summary.taskId);
            }
        }
    }

    const selectedTaskIds = eligibleOlderThanDays !== null
        ? new Set(Array.from(selectedByAgeTaskIds).filter((taskId) => !protectedNewestTaskIds.has(taskId)))
        : new Set(selectedByCountTaskIds);
    return {
        candidateTaskIds,
        selectedTaskIds: Array.from(selectedTaskIds).sort(compareTaskIds),
        selectedByAgeTaskIds: Array.from(selectedByAgeTaskIds).sort(compareTaskIds),
        selectedByCountTaskIds: Array.from(selectedByCountTaskIds).sort(compareTaskIds),
        protectedNewestTaskIds: Array.from(protectedNewestTaskIds).sort(compareTaskIds)
    };
}

function compareTaskArtifactsByNewestFirst(left: TaskArtifactSummary, right: TaskArtifactSummary): number {
    if (right.newestMtimeMs !== left.newestMtimeMs) {
        return right.newestMtimeMs - left.newestMtimeMs;
    }
    return left.taskId.localeCompare(right.taskId);
}

function compareTaskArtifactsByOldestFirst(left: TaskArtifactSummary, right: TaskArtifactSummary): number {
    if (left.newestMtimeMs !== right.newestMtimeMs) {
        return left.newestMtimeMs - right.newestMtimeMs;
    }
    return left.taskId.localeCompare(right.taskId);
}

function compareRuntimeRetentionTasksByOldestArtifactFirst(
    left: RuntimeRetentionTaskPreview,
    right: RuntimeRetentionTaskPreview
): number {
    const leftMtimeMs = left.latest_artifact_mtime_ms ?? 0;
    const rightMtimeMs = right.latest_artifact_mtime_ms ?? 0;
    if (leftMtimeMs !== rightMtimeMs) {
        return leftMtimeMs - rightMtimeMs;
    }
    return left.task_id.localeCompare(right.task_id);
}

function selectRuntimeRetentionPreviewTaskIds(
    inventory: CleanupItem[],
    options: RuntimeRetentionSelectionOptions
): Set<string> | null {
    const eligibleOlderThanDays = normalizeNonNegativeIntegerLimit(options.eligibleOlderThanDays);
    const keepLatestTasks = normalizeNonNegativeIntegerLimit(options.keepLatestTasks) ?? 0;
    const needsBoundedSelection = eligibleOlderThanDays !== null || keepLatestTasks > 0;
    if (!needsBoundedSelection) {
        return null;
    }

    const summaries = new Map<string, TaskArtifactSummary>();
    for (const item of inventory) {
        updateTaskArtifactSummary(summaries, item);
    }

    let candidates = Array.from(summaries.values());
    if (keepLatestTasks > 0) {
        const protectedTaskIds = new Set(
            [...candidates]
                .sort(compareTaskArtifactsByNewestFirst)
                .slice(0, keepLatestTasks)
                .map((summary) => summary.taskId)
        );
        candidates = candidates.filter((summary) => !protectedTaskIds.has(summary.taskId));
    }

    if (eligibleOlderThanDays !== null) {
        const cutoffMs = (options.now ?? new Date()).getTime() - eligibleOlderThanDays * MS_PER_DAY;
        candidates = candidates.filter((summary) => summary.newestMtimeMs <= cutoffMs);
    }

    candidates.sort(compareTaskArtifactsByOldestFirst);
    return new Set(candidates.map((summary) => summary.taskId));
}

export function collectRuntimeRetentionCandidates(
    targetRoot: string,
    bundleRoot: string,
    activeTaskIds: ReadonlySet<string>,
    options: RuntimeRetentionSelectionOptions = {}
): RuntimeRetentionCandidateSelection {
    const runtimeDir = path.join(bundleRoot, 'runtime');
    const maxEligibleTasks = normalizePositiveIntegerLimit(options.maxEligibleTasks);
    const allPreviewCandidates = collectTaskScopedArtifactInventory(runtimeDir, activeTaskIds);
    const boundedTaskIds = selectRuntimeRetentionPreviewTaskIds(allPreviewCandidates, options);
    const previewCandidates = boundedTaskIds === null
        ? allPreviewCandidates
        : allPreviewCandidates.filter((item) => item.taskId && boundedTaskIds.has(item.taskId));
    const preview = buildRuntimeRetentionPreview(
        targetRoot,
        bundleRoot,
        previewCandidates.map((item) => ({ path: item.path, category: item.category }))
    );
    const eligibleTaskIds = preview.tasks
            .filter((task) =>
                task.eligible_now
                && (
                    (
                        task.health_state === 'healthy_done'
                        && task.retention_tier === 'compact_ledger_candidate'
                        && task.ledger_status === 'VERIFIED'
                    )
                    || task.retention_tier === 'compressed_forensic_candidate'
                )
            )
            .sort(compareRuntimeRetentionTasksByOldestArtifactFirst)
            .map((task) => task.task_id);
    const selectedTaskIds = new Set(
        maxEligibleTasks !== null
            ? eligibleTaskIds.slice(0, maxEligibleTasks)
            : eligibleTaskIds
    );
    const compactableLedgerTaskIds = new Set(
        preview.tasks
            .filter((task) =>
                selectedTaskIds.has(task.task_id)
                && task.health_state === 'healthy_done'
                && task.retention_tier === 'compact_ledger_candidate'
                && task.ledger_status === 'VERIFIED'
                && task.eligible_now
            )
            .map((task) => task.task_id)
    );
    return {
        previewCandidates,
        selectedTaskIds,
        boundedTaskIds,
        compactionCandidates: previewCandidates
            .filter((item) => isRuntimeRetentionCompactionCandidate(item, compactableLedgerTaskIds))
            .map((item) => ({
                ...item,
                reason: 'ledger-compaction',
                retainedLedgerPath: item.taskId ? resolveTaskHistoryLedgerPath(bundleRoot, item.taskId) : null,
                retentionDisposition: 'ledger-only'
            }))
    };
}
