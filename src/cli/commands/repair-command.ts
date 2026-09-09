import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    evaluateProtectedControlPlaneManifest,
    writeProtectedControlPlaneManifest
} from '../../gates/shared/helpers';
import {
    reconcileTimelineSummaryForTask,
    readTimelineSummaryIndex
} from '../../gate-runtime/timeline-summary';
import {
    loadIndex,
    rebuildAndPersistIndex
} from '../../gate-runtime/reviews-index';
import {
    cleanupStaleTaskEventLocks
} from '../../gate-runtime/task-events';
import {
    cleanupStaleReviewArtifactLocks
} from '../../gate-runtime/review-artifacts';
import {
    collectLockHealth
} from '../../validators/doctor-lock-health';
import type {
    ReviewArtifactLockHealth
} from '../../gate-runtime/review-artifacts';
import {
    PackageJsonLike,
    parseOptions,
    printBanner,
    resolveWorkspaceDisplayVersion,
    green,
    yellow
} from './cli-helpers';
import {
    ensureBundleExists,
    formatKeyValueOutput,
    ParsedOptionsRecord
} from './shared-command-utils';
import {
    handleStandardFlags,
    resolveTargetRoot
} from './workspace-helpers';
import { parseTaskIdJsonlFileName } from '../../core/task-ids';
import { RESERVED_TASK_EVENT_TIMELINE_NAMES } from '../../core/task-ids';
import {
    inspectDerivedCatalogHealth,
    rebuildDerivedSqliteCatalog,
    repairDerivedSqliteCatalog
} from '../../runtime/sqlite-catalog';
import {
    applyTaskEventSuffixMigration,
    previewTaskEventSuffixMigration,
    type TaskEventSuffixMigrationResult
} from './repair/task-event-suffix-migration';

type RepairAction = 'inspect' | 'rebuild-indexes' | 'protected-manifest' | 'locks' | 'catalog' | 'task-events';
type CatalogRepairAction = 'health' | 'drift' | 'repair' | 'rebuild';
type TaskEventsRepairAction = 'migrate-legacy-suffix';

export interface RepairInspectResult {
    targetRoot: string;
    bundleRoot: string;
    canonical_state: {
        task_events: string;
        review_artifacts: string;
        protected_manifest: string;
    };
    derived_state: {
        timeline_summary_path: string;
        timeline_summary_present: boolean;
        timeline_summary_entries: number;
        reviews_index_path: string;
        reviews_index_source: string;
        reviews_index_entries: number;
    };
    protected_manifest: {
        status: string;
        manifest_path: string;
        changed_files_count: number;
    };
    locks: {
        task_event_active: number;
        task_event_stale: number;
        review_artifact_active: number;
        review_artifact_stale: number;
        completion_finalization_active: number;
        completion_finalization_stale: number;
    };
}

export interface RepairRebuildIndexesResult {
    targetRoot: string;
    bundleRoot: string;
    dryRun: boolean;
    task_event_files: number;
    invalid_task_event_files: string[];
    invalid_task_event_file_actions: RepairInvalidTaskEventFileAction[];
    timeline_summary_path: string;
    timeline_summary_entries_before: number;
    timeline_summary_entries_after: number;
    timeline_summary_rebuilt_tasks: string[];
    timeline_summary_failed_tasks: string[];
    reviews_index_path: string;
    reviews_index_status: string;
    reviews_index_entries_after: number;
    warnings: string[];
}

export interface RepairInvalidTaskEventFileAction {
    path: string;
    action: 'ignore_invalid_task_id' | 'quarantine_candidate';
    reason: string;
}

export interface RepairProtectedManifestResult {
    targetRoot: string;
    bundleRoot: string;
    dryRun: boolean;
    status_before: string;
    manifest_path: string;
    changed_files_count: number;
    written: boolean;
}

export interface RepairLocksResult {
    targetRoot: string;
    bundleRoot: string;
    dryRun: boolean;
    cleanup_requested: boolean;
    task_event_active: number;
    task_event_stale: number;
    review_artifact_active: number;
    review_artifact_stale: number;
    completion_finalization_active: number;
    completion_finalization_stale: number;
    removed_task_event_locks: string[];
    removed_review_artifact_locks: string[];
    retained_live_locks: string[];
    warnings: string[];
}

export interface RepairTaskEventSuffixMigrationOptions {
    apply: boolean;
    expectedPlanSha256?: string;
}

function getReviewsRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'runtime', 'reviews');
}

function getTaskEventsRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'runtime', 'task-events');
}

function getTimelineSummaryPath(eventsRoot: string): string {
    return path.join(eventsRoot, '.timeline-summary.json');
}

function listTaskEventTaskIds(eventsRoot: string): string[] {
    try {
        if (!fs.existsSync(eventsRoot) || !fs.statSync(eventsRoot).isDirectory()) {
            return [];
        }
        return fs.readdirSync(eventsRoot)
            .map((entry) => parseTaskIdJsonlFileName(entry))
            .filter((taskId): taskId is string => taskId !== null)
            .sort();
    } catch {
        return [];
    }
}

function isReservedTaskEventJsonlFile(fileName: string): boolean {
    if (!fileName.endsWith('.jsonl')) {
        return false;
    }
    const stem = fileName.slice(0, -'.jsonl'.length).trim().toLowerCase();
    return RESERVED_TASK_EVENT_TIMELINE_NAMES.has(stem);
}

function listInvalidTaskEventJsonlFiles(eventsRoot: string): string[] {
    try {
        if (!fs.existsSync(eventsRoot) || !fs.statSync(eventsRoot).isDirectory()) {
            return [];
        }
        return fs.readdirSync(eventsRoot)
            .filter((entry) =>
                entry.endsWith('.jsonl')
                && !isReservedTaskEventJsonlFile(entry)
                && parseTaskIdJsonlFileName(entry) === null
            )
            .sort();
    } catch {
        return [];
    }
}

function buildInvalidTaskEventFileActions(eventsRoot: string, fileNames: string[]): RepairInvalidTaskEventFileAction[] {
    return fileNames.map((fileName) => ({
        path: path.join(eventsRoot, fileName).replace(/\\/g, '/'),
        action: 'quarantine_candidate',
        reason: `Invalid task-event timeline filename '${fileName}' does not map to a canonical task id; repair rebuild-indexes ignores it so valid histories remain untouched.`
    }));
}

function readTimelineEntryCount(eventsRoot: string): number {
    return Object.keys(readTimelineSummaryIndex(eventsRoot)?.entries || {}).length;
}

function readReviewsIndexEntryCount(reviewsRoot: string): number {
    try {
        return loadIndex(reviewsRoot, { readOnly: true }).index.entries.length;
    } catch {
        return 0;
    }
}

function countReviewArtifactLocks(
    locks: ReviewArtifactLockHealth[],
    status: 'ACTIVE' | 'STALE'
): number {
    return locks.filter((lock) => lock.status === status && lock.artifact_type !== 'completion-gate').length;
}

export function runRepairInspect(targetRoot: string): RepairInspectResult {
    const resolvedTargetRoot = path.resolve(targetRoot);
    const bundleRoot = ensureBundleExists(resolvedTargetRoot, 'repair inspect');
    const eventsRoot = getTaskEventsRoot(bundleRoot);
    const reviewsRoot = getReviewsRoot(bundleRoot);
    const timelineSummary = readTimelineSummaryIndex(eventsRoot);
    const reviewsIndex = loadIndex(reviewsRoot, { readOnly: true });
    const protectedManifest = evaluateProtectedControlPlaneManifest(resolvedTargetRoot, null, true);
    const lockHealth = collectLockHealth({ bundlePath: bundleRoot });

    return {
        targetRoot: resolvedTargetRoot,
        bundleRoot,
        canonical_state: {
            task_events: path.join(eventsRoot, '<task-id>.jsonl').replace(/\\/g, '/'),
            review_artifacts: reviewsRoot.replace(/\\/g, '/'),
            protected_manifest: protectedManifest.manifest_path
        },
        derived_state: {
            timeline_summary_path: getTimelineSummaryPath(eventsRoot).replace(/\\/g, '/'),
            timeline_summary_present: timelineSummary !== null,
            timeline_summary_entries: Object.keys(timelineSummary?.entries || {}).length,
            reviews_index_path: path.join(reviewsRoot, 'reviews-index.json').replace(/\\/g, '/'),
            reviews_index_source: reviewsIndex.source,
            reviews_index_entries: reviewsIndex.index.entries.length
        },
        protected_manifest: {
            status: protectedManifest.status,
            manifest_path: protectedManifest.manifest_path,
            changed_files_count: protectedManifest.changed_files.length
        },
        locks: {
            task_event_active: lockHealth.lockHealth.active_count,
            task_event_stale: lockHealth.lockHealth.stale_count,
            review_artifact_active: countReviewArtifactLocks(lockHealth.reviewLockHealth.locks, 'ACTIVE'),
            review_artifact_stale: countReviewArtifactLocks(lockHealth.reviewLockHealth.locks, 'STALE'),
            completion_finalization_active: lockHealth.completionFinalizationLockHealth.active_count,
            completion_finalization_stale: lockHealth.completionFinalizationLockHealth.stale_count
        }
    };
}

export function runRepairRebuildIndexes(targetRoot: string, confirm: boolean): RepairRebuildIndexesResult {
    const resolvedTargetRoot = path.resolve(targetRoot);
    const bundleRoot = ensureBundleExists(resolvedTargetRoot, 'repair rebuild-indexes');
    const eventsRoot = getTaskEventsRoot(bundleRoot);
    const reviewsRoot = getReviewsRoot(bundleRoot);
    const taskIds = listTaskEventTaskIds(eventsRoot);
    const invalidTaskEventFiles = listInvalidTaskEventJsonlFiles(eventsRoot);
    const invalidTaskEventFileActions = buildInvalidTaskEventFileActions(eventsRoot, invalidTaskEventFiles);
    const beforeTimelineEntries = readTimelineEntryCount(eventsRoot);
    const rebuiltTasks: string[] = [];
    const failedTasks: string[] = [];
    const warnings: string[] = [];

    if (confirm) {
        for (const taskId of taskIds) {
            try {
                reconcileTimelineSummaryForTask(eventsRoot, taskId);
                rebuiltTasks.push(taskId);
            } catch (error: unknown) {
                failedTasks.push(taskId);
                warnings.push(`timeline-summary rebuild failed for ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    const reviewsIndexResult = confirm
        ? rebuildAndPersistIndex(reviewsRoot)
        : {
            status: 'dry_run',
            index_path: path.join(reviewsRoot, 'reviews-index.json')
        };

    return {
        targetRoot: resolvedTargetRoot,
        bundleRoot,
        dryRun: !confirm,
        task_event_files: taskIds.length,
        invalid_task_event_files: invalidTaskEventFiles,
        invalid_task_event_file_actions: invalidTaskEventFileActions,
        timeline_summary_path: getTimelineSummaryPath(eventsRoot).replace(/\\/g, '/'),
        timeline_summary_entries_before: beforeTimelineEntries,
        timeline_summary_entries_after: confirm ? readTimelineEntryCount(eventsRoot) : beforeTimelineEntries,
        timeline_summary_rebuilt_tasks: rebuiltTasks,
        timeline_summary_failed_tasks: failedTasks,
        reviews_index_path: String(reviewsIndexResult.index_path).replace(/\\/g, '/'),
        reviews_index_status: String(reviewsIndexResult.status),
        reviews_index_entries_after: confirm ? readReviewsIndexEntryCount(reviewsRoot) : readReviewsIndexEntryCount(reviewsRoot),
        warnings
    };
}

export function runRepairProtectedManifest(targetRoot: string, confirm: boolean): RepairProtectedManifestResult {
    const resolvedTargetRoot = path.resolve(targetRoot);
    const bundleRoot = ensureBundleExists(resolvedTargetRoot, 'repair protected-manifest');
    const before = evaluateProtectedControlPlaneManifest(resolvedTargetRoot, null, true);
    const manifestPath = confirm ? writeProtectedControlPlaneManifest(resolvedTargetRoot) : before.manifest_path;

    return {
        targetRoot: resolvedTargetRoot,
        bundleRoot,
        dryRun: !confirm,
        status_before: before.status,
        manifest_path: manifestPath.replace(/\\/g, '/'),
        changed_files_count: before.changed_files.length,
        written: confirm
    };
}

export function runRepairLocks(targetRoot: string, options: { cleanupStale: boolean; confirm: boolean }): RepairLocksResult {
    const resolvedTargetRoot = path.resolve(targetRoot);
    const bundleRoot = ensureBundleExists(resolvedTargetRoot, 'repair locks');
    const before = collectLockHealth({ bundlePath: bundleRoot });
    const dryRun = !options.confirm;
    const taskCleanup = options.cleanupStale
        ? cleanupStaleTaskEventLocks(bundleRoot, { dryRun })
        : null;
    const reviewCleanup = options.cleanupStale
        ? cleanupStaleReviewArtifactLocks(bundleRoot, { dryRun, excludeCompletionFinalizationLocks: true })
        : null;
    const retainedLiveLocks = [
        ...(taskCleanup?.retained_live_locks || []),
        ...(reviewCleanup?.retained_live_locks || [])
    ];

    return {
        targetRoot: resolvedTargetRoot,
        bundleRoot,
        dryRun,
        cleanup_requested: options.cleanupStale,
        task_event_active: before.lockHealth.active_count,
        task_event_stale: before.lockHealth.stale_count,
        review_artifact_active: countReviewArtifactLocks(before.reviewLockHealth.locks, 'ACTIVE'),
        review_artifact_stale: countReviewArtifactLocks(before.reviewLockHealth.locks, 'STALE'),
        completion_finalization_active: before.completionFinalizationLockHealth.active_count,
        completion_finalization_stale: before.completionFinalizationLockHealth.stale_count,
        removed_task_event_locks: taskCleanup?.removed_locks || [],
        removed_review_artifact_locks: reviewCleanup?.removed_locks || [],
        retained_live_locks: retainedLiveLocks,
        warnings: [
            ...(taskCleanup?.warnings || []),
            ...(reviewCleanup?.warnings || [])
        ]
    };
}

function printJson(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
}

function printInspectResult(result: RepairInspectResult): void {
    console.log('GARDA_REPAIR_INSPECT');
    formatKeyValueOutput(result as unknown as Record<string, unknown>, ['targetRoot', 'bundleRoot']);
    console.log('CanonicalState: task-events=jsonl; review-artifacts=runtime/reviews; protected-manifest=trusted lifecycle baseline');
    console.log(`TimelineSummary: path=${result.derived_state.timeline_summary_path} present=${result.derived_state.timeline_summary_present} entries=${result.derived_state.timeline_summary_entries}`);
    console.log(`ReviewsIndex: path=${result.derived_state.reviews_index_path} source=${result.derived_state.reviews_index_source} entries=${result.derived_state.reviews_index_entries}`);
    console.log(`ProtectedManifest: status=${result.protected_manifest.status} changed_files=${result.protected_manifest.changed_files_count}`);
    console.log(`Locks: task-event active=${result.locks.task_event_active} stale=${result.locks.task_event_stale}; review-artifact active=${result.locks.review_artifact_active} stale=${result.locks.review_artifact_stale}; completion-finalization active=${result.locks.completion_finalization_active} stale=${result.locks.completion_finalization_stale}`);
}

function printRebuildIndexesResult(result: RepairRebuildIndexesResult): void {
    console.log('GARDA_REPAIR_REBUILD_INDEXES');
    if (result.dryRun) {
        console.log(yellow('Dry run (default) - no derived indexes were rebuilt. Pass --confirm to apply.'));
    }
    formatKeyValueOutput(result as unknown as Record<string, unknown>, [
        'targetRoot',
        'dryRun',
        'task_event_files',
        'timeline_summary_entries_before',
        'timeline_summary_entries_after',
        'reviews_index_status',
        'reviews_index_entries_after'
    ]);
    if (result.invalid_task_event_file_actions.length > 0) {
        console.log(yellow(`Invalid task-event timeline proposals: ${result.invalid_task_event_file_actions.length}`));
        for (const action of result.invalid_task_event_file_actions) {
            console.log(`  - ${action.action}: ${action.path} (${action.reason})`);
        }
    }
    if (result.warnings.length > 0) {
        console.log(yellow(`Warnings: ${result.warnings.length}`));
        for (const warning of result.warnings) {
            console.log(`  - ${warning}`);
        }
    }
    if (!result.dryRun) {
        console.log(green('Derived indexes rebuilt.'));
    }
}

function printProtectedManifestResult(result: RepairProtectedManifestResult): void {
    console.log('GARDA_REPAIR_PROTECTED_MANIFEST');
    if (result.dryRun) {
        console.log(yellow('Dry run (default) - protected manifest was not rewritten. Pass --confirm to apply.'));
    }
    formatKeyValueOutput(result as unknown as Record<string, unknown>, [
        'targetRoot',
        'dryRun',
        'status_before',
        'changed_files_count',
        'manifest_path',
        'written'
    ]);
}

function printLocksResult(result: RepairLocksResult): void {
    console.log('GARDA_REPAIR_LOCKS');
    if (result.cleanup_requested && result.dryRun) {
        console.log(yellow('Dry run (default) - stale lock cleanup was only previewed. Pass --confirm to remove proven-stale locks.'));
    }
    formatKeyValueOutput(result as unknown as Record<string, unknown>, [
        'targetRoot',
        'dryRun',
        'cleanup_requested',
        'task_event_active',
        'task_event_stale',
        'review_artifact_active',
        'review_artifact_stale',
        'completion_finalization_active',
        'completion_finalization_stale'
    ]);
    if (result.retained_live_locks.length > 0) {
        console.log(yellow(`Retained live locks: ${result.retained_live_locks.length}`));
        for (const lockPath of result.retained_live_locks) {
            console.log(`  - ${lockPath}`);
        }
    }
    if (result.warnings.length > 0) {
        console.log(yellow(`Warnings: ${result.warnings.length}`));
        for (const warning of result.warnings) {
            console.log(`  - ${warning}`);
        }
    }
}

function runCatalogRepairAction(
    targetRoot: string,
    action: CatalogRepairAction,
    confirm: boolean
): unknown {
    if (action === 'health' || action === 'drift') {
        return inspectDerivedCatalogHealth(targetRoot);
    }
    if (action === 'repair') {
        return repairDerivedSqliteCatalog(targetRoot, { apply: confirm });
    }
    if (!confirm) {
        const health = inspectDerivedCatalogHealth(targetRoot);
        return {
            status: 'dry_run',
            canonicalReadable: health.canonicalReadable,
            catalogPath: health.catalogPath,
            canonicalSnapshotSha256: health.canonicalSnapshotSha256,
            generation: health.generation,
            diagnostic: `Rebuild preview: catalog status is ${health.status}; no files were changed.`
        };
    }
    return rebuildDerivedSqliteCatalog(targetRoot, {
        onProgress: (event) => {
            if (process.stdout.isTTY) {
                process.stderr.write(
                    `Catalog rebuild ${event.phase}: ${event.completedRows}/${event.totalRows}\n`
                );
            }
        }
    });
}

function printCatalogResult(action: CatalogRepairAction, result: unknown): void {
    console.log(`GARDA_CATALOG_${action.toUpperCase()}`);
    const record = result as Record<string, unknown>;
    if (record.status === 'dry_run') {
        console.log(yellow('Dry run (default) - no catalog files were changed. Pass --confirm to apply.'));
    }
    formatKeyValueOutput(record, [
        'status',
        'canonicalReadable',
        'parity',
        'generation',
        'catalogPath',
        'canonicalSnapshotSha256',
        'catalogSnapshotSha256',
        'quarantinePath',
        'diagnostic'
    ]);
    const changedSources = Array.isArray(record.changedSources) ? record.changedSources : [];
    if (changedSources.length > 0) {
        console.log(yellow(`Changed canonical sources: ${changedSources.length}`));
        for (const sourcePath of changedSources) console.log(`  - ${String(sourcePath)}`);
    }
}

export function runRepairTaskEventSuffixMigration(
    targetRoot: string,
    taskId: string,
    options: RepairTaskEventSuffixMigrationOptions
): TaskEventSuffixMigrationResult {
    const resolvedTargetRoot = path.resolve(targetRoot);
    const bundleRoot = ensureBundleExists(resolvedTargetRoot, 'repair task-events migrate-legacy-suffix');
    if (!options.apply) {
        return previewTaskEventSuffixMigration(resolvedTargetRoot, bundleRoot, taskId);
    }
    return applyTaskEventSuffixMigration(resolvedTargetRoot, bundleRoot, taskId, {
        expectedPlanSha256: options.expectedPlanSha256 || ''
    });
}

function printTaskEventSuffixMigrationResult(result: TaskEventSuffixMigrationResult): void {
    console.log('GARDA_REPAIR_TASK_EVENT_LEGACY_SUFFIX');
    if (result.dry_run && result.status === 'READY') {
        console.log(yellow(
            'Preview only - pass --apply with --expected-plan-sha256 from this preview to migrate.'
        ));
    }
    formatKeyValueOutput(result as unknown as Record<string, unknown>, [
        'task_id',
        'status',
        'dry_run',
        'changed',
        'reason_code',
        'source_path',
        'source_sha256',
        'source_identity_sha256',
        'migrated_sha256',
        'plan_sha256',
        'anchor_line',
        'suffix_start_line',
        'suffix_event_count',
        'backup_path',
        'backup_manifest_path',
        'integrity_status',
        'diagnostic'
    ]);
    if (result.warnings.length > 0) {
        console.log(yellow(`Warnings: ${result.warnings.length}`));
        for (const warning of result.warnings) console.log(`  - ${warning}`);
    }
    if (result.status === 'APPLIED') {
        console.log(green('Authenticated legacy task-event suffix migrated.'));
    }
}

export function handleRepair(commandArgv: string[], packageJson: PackageJsonLike): void {
    const firstArg = String(commandArgv[0] || '').trim();
    const hasExplicitAction = firstArg.length > 0 && !firstArg.startsWith('-') && firstArg !== 'help';
    const action = (hasExplicitAction ? firstArg : 'inspect') as RepairAction;
    let actionArgv = hasExplicitAction ? commandArgv.slice(1) : commandArgv;
    if (!['inspect', 'rebuild-indexes', 'protected-manifest', 'locks', 'catalog', 'task-events'].includes(action)) {
        throw new Error(`Unknown repair action: ${action}. Allowed values: inspect, rebuild-indexes, protected-manifest, locks, catalog, task-events.`);
    }

    const catalogActionText = action === 'catalog'
        ? String(actionArgv[0] || 'health').trim().toLowerCase()
        : 'health';
    if (action === 'catalog') actionArgv = actionArgv.slice(actionArgv.length > 0 ? 1 : 0);
    if (action === 'catalog' && !['health', 'drift', 'repair', 'rebuild'].includes(catalogActionText)) {
        throw new Error(
            `Unknown repair catalog action: ${catalogActionText}. Allowed values: health, drift, repair, rebuild.`
        );
    }
    const catalogAction = catalogActionText as CatalogRepairAction;

    const taskEventsActionText = action === 'task-events'
        ? String(actionArgv[0] || '').trim().toLowerCase()
        : 'migrate-legacy-suffix';
    if (action === 'task-events') actionArgv = actionArgv.slice(actionArgv.length > 0 ? 1 : 0);
    if (action === 'task-events' && taskEventsActionText !== 'migrate-legacy-suffix') {
        throw new Error(
            `Unknown repair task-events action: ${taskEventsActionText || '<missing>'}. `
            + 'Allowed value: migrate-legacy-suffix.'
        );
    }
    const taskEventsAction = taskEventsActionText as TaskEventsRepairAction;

    const definitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--json': { key: 'json', type: 'boolean' },
        '--confirm': { key: 'confirm', type: 'boolean' },
        '--cleanup-stale': { key: 'cleanupStale', type: 'boolean' },
        '--task-id': { key: 'taskId', type: 'string' },
        '--apply': { key: 'apply', type: 'boolean' },
        '--expected-plan-sha256': { key: 'expectedPlanSha256', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(actionArgv, definitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (handleStandardFlags(options, packageJson)) return;

    const targetRoot = resolveTargetRoot(options.targetRoot);
    const json = options.json === true;

    if (!json) {
        printBanner(packageJson, 'Runtime repair', targetRoot, {
            versionOverride: resolveWorkspaceDisplayVersion(targetRoot, packageJson.version)
        });
    }

    if (action === 'inspect') {
        const result = runRepairInspect(targetRoot);
        json ? printJson(result) : printInspectResult(result);
        return;
    }

    if (action === 'rebuild-indexes') {
        const result = runRepairRebuildIndexes(targetRoot, options.confirm === true);
        json ? printJson(result) : printRebuildIndexesResult(result);
        return;
    }

    if (action === 'protected-manifest') {
        const result = runRepairProtectedManifest(targetRoot, options.confirm === true);
        json ? printJson(result) : printProtectedManifestResult(result);
        return;
    }

    if (action === 'catalog') {
        const result = runCatalogRepairAction(targetRoot, catalogAction, options.confirm === true);
        json ? printJson(result) : printCatalogResult(catalogAction, result);
        return;
    }

    if (action === 'task-events' && taskEventsAction === 'migrate-legacy-suffix') {
        const taskId = String(options.taskId || '').trim();
        if (!taskId) {
            throw new Error('repair task-events migrate-legacy-suffix requires --task-id.');
        }
        if (options.confirm === true) {
            throw new Error(
                'repair task-events migrate-legacy-suffix uses --apply with a preview plan hash; --confirm is unsupported.'
            );
        }
        if (options.apply !== true && options.expectedPlanSha256) {
            throw new Error('--expected-plan-sha256 is only valid together with --apply.');
        }
        const result = runRepairTaskEventSuffixMigration(targetRoot, taskId, {
            apply: options.apply === true,
            expectedPlanSha256: String(options.expectedPlanSha256 || '')
        });
        json ? printJson(result) : printTaskEventSuffixMigrationResult(result);
        return;
    }

    const result = runRepairLocks(targetRoot, {
        cleanupStale: options.cleanupStale === true,
        confirm: options.confirm === true
    });
    json ? printJson(result) : printLocksResult(result);
}
