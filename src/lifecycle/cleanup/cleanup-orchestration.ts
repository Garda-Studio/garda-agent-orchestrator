import * as path from 'node:path';
import { invalidateIndex as invalidateReviewsIndex } from '../../gate-runtime/reviews-index';
import { pruneAggregateLogLocked, pruneAggregateTaskRecordsLocked } from '../../gate-runtime/task-events';
import { resolveActiveTaskIds } from '../../core/active-task-state';
import { assertCanonicalTaskId, taskIdsEqualCaseInsensitive } from '../../core/task-ids';
import { pruneTimelineSummaryEntries } from '../../gate-runtime/timeline-summary';
import { pruneMetricsFile } from '../../runtime/toxin-metrics';
import { validateTargetRoot } from '../lifecycle-common';
import { withLifecycleOperationLock } from '../lock/lifecycle-lock';
import { applyForensicCompressionPolicy, applyStoragePolicy, loadStoragePolicy } from './cleanup-storage-policy';
import { buildRuntimeRetentionPreview, loadRuntimeRetentionPolicy } from '../runtime-policy/runtime-retention-policy';
import {
    buildCategorySummary,
    cleanupStaleTaskEventLocks,
    collectIsolationSandbox,
    collectRuntimeRetentionCandidates,
    type RuntimeRetentionSelectionOptions,
    collectTaskRuntimePurgeCandidates,
    collectTaskRuntimePurgeInventory,
    selectTaskRuntimeBatchPurgeTaskIds,
    collectStaleLifecycleLock,
    collectStaleTaskEventLockCandidates,
    collectStandardCandidates,
    processCleanupCandidates
} from './cleanup-removal';
import {
    GC_ALLOWLIST,
    type CleanupResult,
    type GcResult,
    type CleanupItem,
    type RetentionPolicy,
    type ReviewArtifactStoragePolicy,
    type TaskRuntimeBatchPurgeResult,
    type TaskRuntimePurgeResult
} from './cleanup-types';
import { listRuntimeCleanupSideEffectActionsForRemovedCategories } from './runtime-cleanup-ownership';
import { withLifecycleRuntimeMutationGeneration } from '../runtime-mutation-generation';

import { buildDefaultRetentionPolicy } from './cleanup-defaults';

export { buildDefaultRetentionPolicy, RETENTION_POLICY_DEFAULTS } from './cleanup-defaults';
export type { RetentionPolicyDefaultMetadata } from './cleanup-defaults';

function applyTaskPurgeSharedSideEffects(
    runtimeDir: string,
    removed: CleanupItem[],
    dryRun: boolean,
    taskIdsForSharedPrune?: readonly string[]
): Array<{ path: string; message: string }> {
    const errors: Array<{ path: string; message: string }> = [];
    const taskIdsToPrune = Array.from(new Set(
        taskIdsForSharedPrune ?? removed.map((item) => item.taskId).filter((taskId): taskId is string => Boolean(taskId))
    ));
    if (dryRun || (removed.length === 0 && taskIdsToPrune.length === 0)) {
        return errors;
    }
    const actions = listRuntimeCleanupSideEffectActionsForRemovedCategories(
        new Set(removed.map((item) => item.category))
    );
    const effectiveActions = new Set(actions);
    if (taskIdsForSharedPrune && taskIdsToPrune.length > 0) {
        effectiveActions.add('prune-all-tasks-aggregate');
        effectiveActions.add('prune-timeline-summary');
    }
    if (taskIdsToPrune.length === 0) {
        effectiveActions.delete('prune-all-tasks-aggregate');
    }
    for (const action of effectiveActions) {
        const targetPath = action === 'invalidate-reviews-index'
            ? path.join(runtimeDir, 'reviews')
            : path.join(runtimeDir, 'task-events');
        try {
            if (action === 'invalidate-reviews-index') {
                invalidateReviewsIndex(targetPath);
            } else if (action === 'prune-timeline-summary') {
                pruneTimelineSummaryEntries(targetPath);
            } else if (action === 'prune-all-tasks-aggregate') {
                for (const taskId of taskIdsToPrune) {
                    pruneAggregateTaskRecordsLocked(targetPath, taskId);
                }
            }
        } catch (error: unknown) {
            errors.push({
                path: targetPath,
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }
    return errors;
}

function collectTaskIdsWithoutRemainingPurgeCandidates(runtimeDir: string, taskIds: readonly string[]): string[] {
    const taskIdsWithoutRemainingArtifacts: string[] = [];
    for (const taskId of Array.from(new Set(taskIds)).sort()) {
        const remainingCandidates = collectTaskRuntimePurgeInventory(runtimeDir, new Set<string>(), new Set([taskId]));
        if (remainingCandidates.length === 0) {
            taskIdsWithoutRemainingArtifacts.push(taskId);
        }
    }
    return taskIdsWithoutRemainingArtifacts;
}

export interface CleanupOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
    now?: Date;
    retentionPolicy?: Partial<RetentionPolicy>;
    activeTaskIds?: string[];
    runtimeRetentionTaskLimit?: number;
    runtimeRetentionSelection?: Omit<RuntimeRetentionSelectionOptions, 'maxEligibleTasks' | 'now'>;
}

function buildRuntimeRetentionSelectionOptions(
    bundleRoot: string,
    now: Date,
    taskLimit: number | undefined,
    overrides: Omit<RuntimeRetentionSelectionOptions, 'maxEligibleTasks' | 'now'> | undefined
): RuntimeRetentionSelectionOptions {
    const policy = loadRuntimeRetentionPolicy(bundleRoot);
    if (overrides) {
        return {
            maxEligibleTasks: taskLimit,
            eligibleOlderThanDays: overrides.eligibleOlderThanDays,
            keepLatestTasks: overrides.keepLatestTasks,
            now
        };
    }

    return {
        maxEligibleTasks: taskLimit,
        eligibleOlderThanDays: policy.dailyMaintenance.eligibleOlderThanDays,
        keepLatestTasks: policy.dailyMaintenance.keepLatestTasks,
        now
    };
}

function runCleanupUnjournaled(options: CleanupOptions): CleanupResult {
    const { targetRoot, bundleRoot, dryRun = false } = options;
    validateTargetRoot(targetRoot, bundleRoot);

    const policy: RetentionPolicy = {
        ...buildDefaultRetentionPolicy(),
        ...options.retentionPolicy
    };

    const runtimeDir = path.join(bundleRoot, 'runtime');
    const now = options.now ?? new Date();
    const activeTaskIds = resolveActiveTaskIds(targetRoot, bundleRoot, options.activeTaskIds);
    const runtimeRetentionCandidates = collectRuntimeRetentionCandidates(
        targetRoot,
        bundleRoot,
        activeTaskIds,
        buildRuntimeRetentionSelectionOptions(bundleRoot, now, options.runtimeRetentionTaskLimit, options.runtimeRetentionSelection)
    );
    const candidates = [
        ...collectStandardCandidates(runtimeDir, policy, now, activeTaskIds),
        ...runtimeRetentionCandidates.compactionCandidates
    ];
    const runtimeRetentionPreview = buildRuntimeRetentionPreview(
        targetRoot,
        bundleRoot,
        runtimeRetentionCandidates.previewCandidates.map((item) => ({ path: item.path, category: item.category }))
    );
    const { removed, skipped, errors, totalFreedBytes } = processCleanupCandidates(candidates, dryRun, runtimeDir);
    applyTaskPurgeSharedSideEffects(runtimeDir, removed, dryRun);

    let aggregateRetention: CleanupResult['aggregateRetention'];
    if (!dryRun && policy.maxAggregateLines > 0) {
        try {
            aggregateRetention = pruneAggregateLogLocked(path.join(runtimeDir, 'task-events'), policy.maxAggregateLines, {}, activeTaskIds);
        } catch {
            // Best-effort cleanup.
        }
    }

    let metricsRetention: CleanupResult['metricsRetention'];
    if (!dryRun && policy.maxMetricsLines > 0) {
        try {
            const pruned = pruneMetricsFile(path.join(runtimeDir, 'metrics.jsonl'), policy.maxMetricsLines);
            metricsRetention = {
                pruned: pruned.pruned,
                lines_before: pruned.linesBefore,
                lines_after: pruned.linesAfter
            };
        } catch {
            // Best-effort cleanup.
        }
    }

    return {
        targetRoot,
        dryRun,
        retentionPolicy: policy,
        removed,
        skipped,
        errors,
        totalFreedBytes,
        result: errors.length > 0 ? 'PARTIAL' : 'SUCCESS',
        aggregateRetention,
        metricsRetention,
        runtimeRetentionPreview
    };
}

export function runCleanup(options: CleanupOptions): CleanupResult {
    validateTargetRoot(options.targetRoot, options.bundleRoot);
    return options.dryRun === true
        ? runCleanupUnjournaled(options)
        : withLifecycleRuntimeMutationGeneration(
            options.bundleRoot,
            'lifecycle-runtime-cleanup',
            () => runCleanupUnjournaled(options)
        );
}

export function runCleanupWithLock(options: CleanupOptions): CleanupResult {
    return withLifecycleOperationLock(options.targetRoot, 'cleanup', () => runCleanup(options));
}

export interface TaskRuntimePurgeOptions {
    targetRoot: string;
    bundleRoot: string;
    taskId: string;
    confirm?: boolean;
    activeTaskIds?: string[];
}

function findActiveTaskIdMatch(activeTaskIds: ReadonlySet<string>, taskId: string): string | null {
    for (const activeTaskId of activeTaskIds) {
        if (taskIdsEqualCaseInsensitive(activeTaskId, taskId)) {
            return activeTaskId;
        }
    }
    return null;
}

function runTaskRuntimePurgeUnjournaled(options: TaskRuntimePurgeOptions): TaskRuntimePurgeResult {
    const { targetRoot, bundleRoot, confirm = false } = options;
    validateTargetRoot(targetRoot, bundleRoot);

    const taskId = assertCanonicalTaskId(options.taskId);
    const runtimeDir = path.join(bundleRoot, 'runtime');
    const dryRun = !confirm;
    const activeTaskIds = resolveActiveTaskIds(targetRoot, bundleRoot, options.activeTaskIds, {
        includeAmbiguousRuntimeTasks: false
    });
    const activeTaskIdMatch = findActiveTaskIdMatch(activeTaskIds, taskId);
    if (activeTaskIdMatch) {
        return {
            targetRoot,
            taskId,
            dryRun,
            removed: [],
            skipped: [],
            errors: [{
                path: runtimeDir,
                message: `Task '${taskId}' is active as '${activeTaskIdMatch}'; task runtime purge is blocked.`
            }],
            totalFreedBytes: 0,
            result: 'BLOCKED',
            activeTaskProtected: true
        };
    }

    const candidates = collectTaskRuntimePurgeCandidates(runtimeDir, taskId);
    const { removed, skipped, errors, totalFreedBytes } = processCleanupCandidates(candidates, dryRun, runtimeDir);
    const taskIdsForSharedPrune = dryRun
        ? [taskId]
        : collectTaskIdsWithoutRemainingPurgeCandidates(runtimeDir, [taskId]);
    errors.push(...applyTaskPurgeSharedSideEffects(runtimeDir, removed, dryRun, taskIdsForSharedPrune));

    return {
        targetRoot,
        taskId,
        dryRun,
        removed,
        skipped,
        errors,
        totalFreedBytes,
        result: errors.length > 0 ? 'PARTIAL' : 'SUCCESS',
        activeTaskProtected: false
    };
}

export function runTaskRuntimePurge(options: TaskRuntimePurgeOptions): TaskRuntimePurgeResult {
    validateTargetRoot(options.targetRoot, options.bundleRoot);
    return options.confirm === true
        ? withLifecycleRuntimeMutationGeneration(
            options.bundleRoot,
            'lifecycle-task-runtime-purge',
            () => runTaskRuntimePurgeUnjournaled(options)
        )
        : runTaskRuntimePurgeUnjournaled(options);
}

export function runTaskRuntimePurgeWithLock(options: TaskRuntimePurgeOptions): TaskRuntimePurgeResult {
    return withLifecycleOperationLock(options.targetRoot, 'task-runtime-purge', () => runTaskRuntimePurge(options));
}

export interface TaskRuntimeBatchPurgeOptions {
    targetRoot: string;
    bundleRoot: string;
    confirm?: boolean;
    activeTaskIds?: string[];
    eligibleOlderThanDays?: number;
    keepLatestTasks?: number;
    includeProblematicTasks?: boolean;
    now?: Date;
}

function buildTaskPurgeSharedIndexOperations(removed: readonly CleanupItem[], explicitTaskIds: readonly string[]): string[] {
    const actions = listRuntimeCleanupSideEffectActionsForRemovedCategories(
        new Set(removed.map((item) => item.category))
    );
    const effectiveActions = new Set(actions);
    if (explicitTaskIds.length > 0) {
        effectiveActions.add('prune-all-tasks-aggregate');
        effectiveActions.add('prune-timeline-summary');
    } else {
        effectiveActions.delete('prune-all-tasks-aggregate');
    }
    return Array.from(effectiveActions).sort();
}

function runTaskRuntimeBatchPurgeUnjournaled(options: TaskRuntimeBatchPurgeOptions): TaskRuntimeBatchPurgeResult {
    const { targetRoot, bundleRoot, confirm = false } = options;
    validateTargetRoot(targetRoot, bundleRoot);

    const runtimeDir = path.join(bundleRoot, 'runtime');
    const dryRun = !confirm;
    const activeTaskIds = resolveActiveTaskIds(targetRoot, bundleRoot, options.activeTaskIds, {
        includeAmbiguousRuntimeTasks: false,
        includeStaleRuntimeActiveTasks: options.includeProblematicTasks !== true
    });
    const allInventory = collectTaskRuntimePurgeInventory(runtimeDir, new Set<string>());
    const taskSelection = selectTaskRuntimeBatchPurgeTaskIds(allInventory, {
        eligibleOlderThanDays: options.eligibleOlderThanDays,
        keepLatestTasks: options.keepLatestTasks,
        now: options.now
    });
    const activeTaskSkips: string[] = [];
    const selectedTaskIds: string[] = [];
    for (const taskId of taskSelection.selectedTaskIds) {
        const activeTaskIdMatch = findActiveTaskIdMatch(activeTaskIds, taskId);
        if (activeTaskIdMatch) {
            activeTaskSkips.push(activeTaskIdMatch);
            continue;
        }
        selectedTaskIds.push(taskId);
    }

    const selectedTaskIdSet = new Set(selectedTaskIds);
    const candidates = selectedTaskIds.length > 0
        ? collectTaskRuntimePurgeInventory(runtimeDir, new Set<string>(), selectedTaskIdSet)
        : [];
    const { removed, skipped, errors, totalFreedBytes } = processCleanupCandidates(candidates, dryRun, runtimeDir);
    const taskIdsForSharedPrune = dryRun
        ? selectedTaskIds
        : collectTaskIdsWithoutRemainingPurgeCandidates(runtimeDir, selectedTaskIds);
    const sharedIndexOperations = buildTaskPurgeSharedIndexOperations(dryRun ? skipped : removed, taskIdsForSharedPrune);
    errors.push(...applyTaskPurgeSharedSideEffects(runtimeDir, removed, dryRun, taskIdsForSharedPrune));

    return {
        targetRoot,
        dryRun,
        filters: {
            eligibleOlderThanDays: options.eligibleOlderThanDays ?? null,
            keepLatestTasks: options.keepLatestTasks ?? null,
            includeProblematicTasks: options.includeProblematicTasks === true
        },
        candidateTaskIds: taskSelection.candidateTaskIds,
        matchedTaskIds: taskSelection.selectedTaskIds,
        selectedTaskIds,
        activeTaskSkips: Array.from(new Set(activeTaskSkips)).sort(),
        protectedNewestTaskIds: taskSelection.protectedNewestTaskIds,
        selectedByAgeTaskIds: taskSelection.selectedByAgeTaskIds,
        selectedByCountTaskIds: taskSelection.selectedByCountTaskIds,
        sharedIndexOperations,
        removed,
        skipped,
        errors,
        totalFreedBytes,
        result: errors.length > 0 || activeTaskSkips.length > 0 ? 'PARTIAL' : 'SUCCESS'
    };
}

export function runTaskRuntimeBatchPurge(options: TaskRuntimeBatchPurgeOptions): TaskRuntimeBatchPurgeResult {
    validateTargetRoot(options.targetRoot, options.bundleRoot);
    return options.confirm === true
        ? withLifecycleRuntimeMutationGeneration(
            options.bundleRoot,
            'lifecycle-task-runtime-batch-purge',
            () => runTaskRuntimeBatchPurgeUnjournaled(options)
        )
        : runTaskRuntimeBatchPurgeUnjournaled(options);
}

export function runTaskRuntimeBatchPurgeWithLock(options: TaskRuntimeBatchPurgeOptions): TaskRuntimeBatchPurgeResult {
    return withLifecycleOperationLock(options.targetRoot, 'task-runtime-batch-purge', () => runTaskRuntimeBatchPurge(options));
}

export interface GcOptions {
    targetRoot: string;
    bundleRoot: string;
    confirm?: boolean;
    now?: Date;
    retentionPolicy?: Partial<RetentionPolicy>;
    categories?: string[];
    storagePolicy?: ReviewArtifactStoragePolicy;
    activeTaskIds?: string[];
    runtimeRetentionTaskLimit?: number;
    runtimeRetentionOnly?: boolean;
    runtimeRetentionSelection?: Omit<RuntimeRetentionSelectionOptions, 'maxEligibleTasks' | 'now'>;
}

export function validateGcCategories(categories: string[]): void {
    for (const cat of categories) {
        if (!GC_ALLOWLIST.includes(cat)) {
            throw new Error(`Unknown gc category '${cat}'. Allowed: ${GC_ALLOWLIST.join(', ')}`);
        }
    }
}

function runGcUnjournaled(options: GcOptions): GcResult {
    const { targetRoot, bundleRoot, confirm = false, runtimeRetentionOnly = false } = options;
    validateTargetRoot(targetRoot, bundleRoot);

    if (options.categories && options.categories.length > 0) {
        validateGcCategories(options.categories);
    }

    const policy: RetentionPolicy = {
        ...buildDefaultRetentionPolicy(),
        ...options.retentionPolicy
    };

    const dryRun = !confirm;
    const filterCategories = options.categories && options.categories.length > 0
        ? new Set(options.categories)
        : null;

    const runtimeDir = path.join(bundleRoot, 'runtime');
    const now = options.now ?? new Date();
    const activeTaskIds = resolveActiveTaskIds(targetRoot, bundleRoot, options.activeTaskIds);
    const runtimeRetentionCandidates = collectRuntimeRetentionCandidates(
        targetRoot,
        bundleRoot,
        activeTaskIds,
        buildRuntimeRetentionSelectionOptions(bundleRoot, now, options.runtimeRetentionTaskLimit, options.runtimeRetentionSelection)
    );
    const standardCandidates = runtimeRetentionOnly
        ? [...runtimeRetentionCandidates.compactionCandidates]
        : [
            ...collectStandardCandidates(runtimeDir, policy, now, activeTaskIds),
            ...runtimeRetentionCandidates.compactionCandidates
        ];
    const isolationItems = runtimeRetentionOnly ? [] : collectIsolationSandbox(runtimeDir, policy.maxAgeDays, now);
    const staleLockItems = runtimeRetentionOnly ? [] : collectStaleLifecycleLock(runtimeDir);
    const shouldCleanTaskEventLocks = !runtimeRetentionOnly && (!filterCategories || filterCategories.has('task-events'));
    const taskEventLockCandidates = shouldCleanTaskEventLocks
        ? collectStaleTaskEventLockCandidates(bundleRoot)
        : [];

    let allCandidates = [...standardCandidates, ...isolationItems, ...staleLockItems];
    if (filterCategories) {
        allCandidates = allCandidates.filter((item) => filterCategories.has(item.category));
    }
    const runtimeRetentionPreview = buildRuntimeRetentionPreview(
        targetRoot,
        bundleRoot,
        runtimeRetentionCandidates.previewCandidates.map((item) => ({ path: item.path, category: item.category }))
    );

    const {
        removed,
        skipped,
        errors,
        totalFreedBytes: standardFreedBytes
    } = processCleanupCandidates(allCandidates, dryRun, runtimeDir);
    let totalFreedBytes = standardFreedBytes;
    applyTaskPurgeSharedSideEffects(runtimeDir, removed, dryRun);

    let staleLocksCleaned = 0;
    if (shouldCleanTaskEventLocks) {
        try {
            const lockResult = cleanupStaleTaskEventLocks(bundleRoot, { dryRun });
            const taskEventLockItems = new Map(taskEventLockCandidates.map((item) => [path.basename(item.path), item]));
            const effectiveTaskEventLocks = (dryRun ? lockResult.removable_stale_locks : lockResult.removed_locks)
                .map((lockName) => taskEventLockItems.get(lockName))
                .filter((item): item is NonNullable<typeof item> => item != null);

            staleLocksCleaned = dryRun ? lockResult.removable_stale_locks.length : lockResult.removed_locks.length;
            totalFreedBytes += effectiveTaskEventLocks.reduce((sum, item) => sum + item.sizeBytes, 0);
            if (dryRun) {
                skipped.push(...effectiveTaskEventLocks);
            } else {
                removed.push(...effectiveTaskEventLocks);
            }
        } catch {
            // Best-effort cleanup.
        }
    }

    const actionItems = dryRun ? skipped : removed;
    const isolationSandboxCleaned = actionItems.some((item) => item.category === 'isolation-sandbox');

    const shouldApplyStoragePolicy = !filterCategories || filterCategories.has('reviews');
    let storagePolicyResult: GcResult['storagePolicyResult'];
    if (shouldApplyStoragePolicy && confirm) {
        const storagePolicy = options.storagePolicy ?? loadStoragePolicy(bundleRoot);
        const retentionPolicyConfig = loadRuntimeRetentionPolicy(bundleRoot);
        const protectedReviewTaskIds = new Set(activeTaskIds);
        const forensicCompressionTaskIds = new Set<string>();
        for (const task of runtimeRetentionPreview.tasks) {
            const selectedByBoundedMaintenance = runtimeRetentionCandidates.selectedTaskIds.has(task.task_id);
            const compactableHealthyDone = task.health_state === 'healthy_done'
                && task.retention_tier === 'compact_ledger_candidate'
                && task.ledger_status === 'VERIFIED'
                && task.eligible_now;
            const compressableForensic = task.retention_tier === 'compressed_forensic_candidate'
                && task.eligible_now;
            if (
                compressableForensic
                && selectedByBoundedMaintenance
                && !retentionPolicyConfig.problemTasks.preserveDetailedEvidence
            ) {
                forensicCompressionTaskIds.add(task.task_id);
            }
            if (!(compactableHealthyDone && selectedByBoundedMaintenance)) {
                protectedReviewTaskIds.add(task.task_id);
            }
        }
        storagePolicyResult = applyStoragePolicy(
            path.join(runtimeDir, 'reviews'),
            storagePolicy,
            protectedReviewTaskIds,
            runtimeDir,
            runtimeRetentionCandidates.boundedTaskIds ?? undefined
        );
        const forensicCompressionResult = applyForensicCompressionPolicy(
            path.join(runtimeDir, 'reviews'),
            forensicCompressionTaskIds,
            runtimeDir
        );
        const forensicCompressed = new Set(forensicCompressionResult.compressed);
        storagePolicyResult.preserved = storagePolicyResult.preserved.filter((entry) => !forensicCompressed.has(entry));
        storagePolicyResult.compressed.push(...forensicCompressionResult.compressed);
        storagePolicyResult.preserved.push(...forensicCompressionResult.preserved);
    }

    const shouldPruneAggregate = !runtimeRetentionOnly && (!filterCategories || filterCategories.has('task-events'));
    let aggregateRetention: GcResult['aggregateRetention'];
    if (shouldPruneAggregate && policy.maxAggregateLines > 0) {
        try {
            if (confirm) {
                aggregateRetention = pruneAggregateLogLocked(path.join(runtimeDir, 'task-events'), policy.maxAggregateLines, {}, activeTaskIds);
            }
        } catch {
            // Best-effort cleanup.
        }
    }

    const shouldPruneMetrics = !runtimeRetentionOnly && (!filterCategories || filterCategories.has('metrics'));
    let metricsRetention: GcResult['metricsRetention'];
    if (shouldPruneMetrics && policy.maxMetricsLines > 0) {
        try {
            if (confirm) {
                const pruned = pruneMetricsFile(path.join(runtimeDir, 'metrics.jsonl'), policy.maxMetricsLines);
                metricsRetention = {
                    pruned: pruned.pruned,
                    lines_before: pruned.linesBefore,
                    lines_after: pruned.linesAfter
                };
            }
        } catch {
            // Best-effort cleanup.
        }
    }

    return {
        targetRoot,
        dryRun,
        retentionPolicy: policy,
        removed,
        skipped,
        errors,
        totalFreedBytes,
        result: errors.length > 0 ? 'PARTIAL' : 'SUCCESS',
        staleLocksCleaned,
        isolationSandboxCleaned,
        categories: buildCategorySummary(actionItems),
        storagePolicyResult,
        aggregateRetention,
        metricsRetention,
        runtimeRetentionPreview
    };
}

export function runGc(options: GcOptions): GcResult {
    validateTargetRoot(options.targetRoot, options.bundleRoot);
    return options.confirm === true
        ? withLifecycleRuntimeMutationGeneration(
            options.bundleRoot,
            'lifecycle-runtime-gc',
            () => runGcUnjournaled(options)
        )
        : runGcUnjournaled(options);
}

export function runGcWithLock(options: GcOptions): GcResult {
    return withLifecycleOperationLock(options.targetRoot, 'gc', () => runGc(options));
}
