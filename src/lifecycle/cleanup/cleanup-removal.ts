import * as fs from 'node:fs';
import * as path from 'node:path';
import { containedDirectory } from '../../core/compact/store-paths';
import { cleanupStaleTaskEventLocks, scanTaskEventLocks } from '../../gate-runtime/task-events';
import { isCanonicalTaskId, parseStructuredTaskArtifactTaskId } from '../../core/task-ids';
import { withFilesystemLock } from '../../gate-runtime/task-events-locking';
import { LIFECYCLE_OPERATION_LOCK_DIR_NAME } from '../lock/lifecycle-lock';
import { ensureWithinRoot, removePathRecursive } from '../generic-utils';
import {
    ageCutoff,
    cleanupItemSizeBytes,
    directoryEntries,
    dirSizeBytes,
    fileSizeBytes,
    isNotFoundError,
    pathStat
} from './cleanup-filesystem-utils';
import { isTaskOwnedRuntimeTmpPath, resolveRuntimeCleanupStandardPaths, resolveRuntimeTmpTaskId } from './runtime-cleanup-ownership';
import type { CleanupItem, RetentionPolicy } from './cleanup-types';
export {
    collectRuntimeRetentionCandidates,
    collectTaskRuntimePurgeCandidates,
    collectTaskRuntimePurgeInventory,
    selectTaskRuntimeBatchPurgeTaskIds
} from './cleanup-runtime-retention';
export type {
    RuntimeRetentionCandidateSelection,
    RuntimeRetentionSelectionOptions,
    TaskRuntimeBatchPurgeSelectionOptions,
    TaskRuntimeBatchPurgeTaskSelection
} from './cleanup-runtime-retention';

export interface ProcessCleanupCandidatesResult {
    removed: CleanupItem[];
    skipped: CleanupItem[];
    errors: Array<{ path: string; message: string }>;
    totalFreedBytes: number;
}

const COMPACT_CLEANUP_LOCK_TIMEOUT_MS = 50;

function resolveLegacyRuntimeRoot(runtimeRoot: string): string {
    try {
        const realRuntimeRoot = fs.realpathSync(runtimeRoot);
        const bundleRoot = path.dirname(realRuntimeRoot);
        if (path.relative(containedDirectory(bundleRoot, 'runtime'), realRuntimeRoot) !== '') {
            throw new Error('The root must be the contained runtime directory of a bundle.');
        }
        const version = fs.lstatSync(path.join(bundleRoot, 'VERSION'));
        if (!version.isFile() || version.isSymbolicLink() || version.nlink !== 1) {
            throw new Error('The bundle VERSION marker must be an unshared regular file.');
        }
        for (const marker of ['VERSION', 'TASK.md']) {
            try {
                fs.lstatSync(path.join(realRuntimeRoot, marker));
                throw new Error(`The runtime root has an ambiguous ${marker} role marker.`);
            } catch (error: unknown) {
                if (!isNotFoundError(error)) throw error;
            }
        }
        for (let ancestor = path.dirname(realRuntimeRoot); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
            const name = path.basename(ancestor);
            if ((process.platform === 'win32' ? name.toLowerCase() : name) === 'runtime'
                && isScratchCleanupNamespace(ancestor, realRuntimeRoot)) {
                throw new Error('The runtime root is nested in a protected scratch namespace.');
            }
        }
        return realRuntimeRoot;
    } catch (error: unknown) {
        throw new Error(`Legacy cleanup requires a canonical bundle runtime root: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function isScratchCleanupNamespace(runtimeRoot: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(runtimeRoot), candidate);
    const first = relative.split(path.sep)[0];
    const namespace = process.platform === 'win32' ? first.toLowerCase() : first;
    return relative === '' || namespace === 'tmp' || namespace === 'scratch-writers'
        || namespace === '.scratch-writers.lock'
        || /\.(?:tmp|partial)$/u.test(namespace);
}

function removeCleanupCandidate(item: CleanupItem, safePath: string, runtimeRoot?: string): void {
    if (!runtimeRoot) throw new Error('Legacy cleanup mutation requires an explicit runtime root.');
    const realRuntimeRoot = resolveLegacyRuntimeRoot(runtimeRoot), realPath = fs.realpathSync(safePath);
    const scratchNamespace = isScratchCleanupNamespace(runtimeRoot, safePath)
        || isScratchCleanupNamespace(realRuntimeRoot, realPath);
    if ((item.category === 'tmp' || scratchNamespace)
        && (!isTaskOwnedRuntimeTmpPath(runtimeRoot, safePath) || !isTaskOwnedRuntimeTmpPath(realRuntimeRoot, realPath))) {
        throw new Error('Legacy cleanup cannot remove generic scratch or writer ownership metadata.');
    }
    const remove = (): void => {
        const stat = fs.statSync(safePath);
        if (stat.isDirectory()) removePathRecursive(safePath);
        else fs.unlinkSync(safePath);
    };
    if (item.category !== 'compact') {
        remove();
        return;
    }
    if (path.dirname(safePath) !== path.resolve(runtimeRoot, 'compact') || !isCanonicalTaskId(path.basename(safePath))) {
        throw new Error('Compact cleanup requires an exact task subtree inside the runtime compact root.');
    }
    withFilesystemLock(path.join(runtimeRoot, 'compact.lock'), {
        timeoutMs: COMPACT_CLEANUP_LOCK_TIMEOUT_MS,
        requireKnownDeadOwner: true,
        allowForeignHostStaleRecovery: false,
        ownerLabel: 'cleanup-compact'
    }, () => {
        containedDirectory(runtimeRoot, 'compact');
        ensureWithinRoot(path.join(runtimeRoot, 'compact'), safePath, 'Compact cleanup candidate');
        const stat = fs.lstatSync(safePath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Compact cleanup candidate is no longer an unlinked directory.');
        remove();
    });
}

export function processCleanupCandidates(
    candidates: CleanupItem[],
    dryRun: boolean,
    runtimeRoot?: string
): ProcessCleanupCandidatesResult {
    const removed: CleanupItem[] = [];
    const skipped: CleanupItem[] = [];
    const errors: Array<{ path: string; message: string }> = [];
    let totalFreedBytes = 0;

    for (const item of candidates) {
        let safePath = path.resolve(item.path);
        if (runtimeRoot) {
            try {
                safePath = ensureWithinRoot(runtimeRoot, item.path, 'Cleanup candidate');
            } catch (error: unknown) {
                errors.push({
                    path: item.path,
                    message: error instanceof Error ? error.message : String(error)
                });
                continue;
            }
        }
        if (dryRun) {
            skipped.push(item);
            totalFreedBytes += item.sizeBytes;
            continue;
        }

        if (!fs.existsSync(safePath)) {
            continue;
        }

        try {
            removeCleanupCandidate(item, safePath, runtimeRoot);
            removed.push(item);
            totalFreedBytes += item.sizeBytes;
        } catch (error: unknown) {
            if (isNotFoundError(error)) continue;
            errors.push({
                path: item.path,
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }

    return { removed, skipped, errors, totalFreedBytes };
}

function parseTimestampName(name: string): Date | null {
    const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/.exec(name);
    if (!match) return null;
    const [, year, month, day, hour, minute, second, ms] = match;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(ms));
}

function parseUpdateTimestampName(name: string): Date | null {
    const match = /^update-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

function collectCountOrAgeNamedEntries(
    dirPath: string,
    category: string,
    maxCount: number,
    maxAgeDays: number,
    now: Date,
    parseEntryDate: (name: string) => Date | null
): CleanupItem[] {
    const entries = directoryEntries(dirPath);
    const items: CleanupItem[] = [];
    const cutoff = ageCutoff(now, maxAgeDays);
    const excessCount = Math.max(0, entries.length - maxCount);

    for (let i = 0; i < entries.length; i += 1) {
        const entryName = entries[i];
        const entryPath = path.join(dirPath, entryName);
        const entryDate = parseEntryDate(entryName);

        let reason: string | null = null;
        if (i < excessCount) {
            reason = 'count';
        } else if (entryDate && entryDate < cutoff) {
            reason = 'age';
        }

        if (reason) {
            const stat = pathStat(entryPath);
            const sizeBytes = stat ? cleanupItemSizeBytes(entryPath, stat) : fileSizeBytes(entryPath);
            items.push({ path: entryPath, category, reason, sizeBytes });
        }
    }

    return items;
}

function collectTimestampedDirs(dirPath: string, category: string, maxCount: number, maxAgeDays: number, now: Date): CleanupItem[] {
    return collectCountOrAgeNamedEntries(dirPath, category, maxCount, maxAgeDays, now, parseTimestampName);
}

function collectUpdateNamedDirs(dirPath: string, category: string, maxCount: number, maxAgeDays: number, now: Date): CleanupItem[] {
    return collectCountOrAgeNamedEntries(dirPath, category, maxCount, maxAgeDays, now, parseUpdateTimestampName);
}

function collectAgedEntries(dirPath: string, category: string, maxAgeDays: number, now: Date,
    includeEntry: (name: string) => boolean = () => true): CleanupItem[] {
    const entries = directoryEntries(dirPath);
    const items: CleanupItem[] = [];
    const cutoff = ageCutoff(now, maxAgeDays);

    for (const entryName of entries) {
        if (!includeEntry(entryName)) continue;
        const entryPath = path.join(dirPath, entryName);
        const stat = pathStat(entryPath);
        if (!stat) {
            // Skip unreadable entries.
            continue;
        }
        if (stat.mtime >= cutoff) {
            continue;
        }
        items.push({
            path: entryPath,
            category,
            reason: 'age',
            sizeBytes: cleanupItemSizeBytes(entryPath, stat)
        });
    }

    return items;
}

function isActiveTaskScratchName(name: string, activeTaskIdsLower: ReadonlySet<string>): boolean {
    const owner = parseStructuredTaskArtifactTaskId(name) ?? resolveRuntimeTmpTaskId(name);
    return owner !== null && activeTaskIdsLower.has(owner.toLowerCase());
}

function collectRuntimeRootTempFiles(runtimeDir: string, maxAgeDays: number, now: Date,
    activeTaskIdsLower: ReadonlySet<string>): CleanupItem[] {
    const entries = directoryEntries(runtimeDir);
    const items: CleanupItem[] = [];
    const cutoff = ageCutoff(now, maxAgeDays);
    for (const entry of entries) {
        if (!entry.endsWith('.tmp') && !entry.endsWith('.partial')) {
            continue;
        }
        if (!resolveRuntimeTmpTaskId(entry) || isActiveTaskScratchName(entry, activeTaskIdsLower)) continue;
        const entryPath = path.join(runtimeDir, entry);
        const stat = pathStat(entryPath);
        if (!stat) {
            // Skip unreadable temp files.
            continue;
        }
        if (!stat.isFile() || stat.mtime >= cutoff) {
            continue;
        }
        items.push({
            path: entryPath,
            category: 'tmp',
            reason: 'orphaned-temp-file',
            sizeBytes: stat.size
        });
    }
    return items;
}

function collectRuntimeTmp(tmpDir: string, maxAgeDays: number, now: Date, activeTaskIdsLower: ReadonlySet<string>): CleanupItem[] {
    const items = collectAgedEntries(tmpDir, 'tmp', maxAgeDays, now,
        name => name !== 'reviews' && resolveRuntimeTmpTaskId(name) !== null && !isActiveTaskScratchName(name, activeTaskIdsLower));
    const reviewScratchDir = path.join(tmpDir, 'reviews');
    const cutoff = ageCutoff(now, maxAgeDays);

    for (const entry of directoryEntries(reviewScratchDir)) {
        if (!resolveRuntimeTmpTaskId(entry) || isActiveTaskScratchName(entry, activeTaskIdsLower)) continue;
        const entryPath = path.join(reviewScratchDir, entry);
        const stat = pathStat(entryPath);
        if (!stat) {
            // Skip unreadable scratch entries.
            continue;
        }
        if (!stat.isDirectory()) {
            if (stat.mtime < cutoff) {
                items.push({ path: entryPath, category: 'tmp', reason: 'age', sizeBytes: stat.size });
            }
            continue;
        }
        items.push({
            path: entryPath,
            category: 'tmp',
            reason: 'inactive-reviewer-scratch',
            sizeBytes: dirSizeBytes(entryPath),
            taskId: isCanonicalTaskId(entry) ? entry : undefined
        });
    }

    return items;
}

function collectOrphanedCompletenessCaches(
    eventsDir: string,
    activeTaskIds: ReadonlySet<string>
): CleanupItem[] {
    if (!fs.existsSync(eventsDir)) return [];
    const items: CleanupItem[] = [];

    let cacheEntries: string[];
    try {
        cacheEntries = fs.readdirSync(eventsDir).filter((entry) => entry.endsWith('.completeness.json')).sort();
    } catch {
        return [];
    }

    for (const cacheName of cacheEntries) {
        const taskId = cacheName.replace(/\.completeness\.json$/, '');
        if (!isCanonicalTaskId(taskId) || activeTaskIds.has(taskId)) {
            continue;
        }
        const timelinePath = path.join(eventsDir, `${taskId}.jsonl`);
        if (fs.existsSync(timelinePath)) {
            continue;
        }
        const cachePath = path.join(eventsDir, cacheName);
        items.push({
            path: cachePath,
            category: 'task-events',
            reason: 'orphaned-cache',
            sizeBytes: fileSizeBytes(cachePath),
            taskId
        });
    }

    return items;
}

export function collectIsolationSandbox(runtimeDir: string, maxAgeDays: number, now: Date): CleanupItem[] {
    const sandboxDir = resolveRuntimeCleanupStandardPaths(runtimeDir).isolationSandboxDir;
    if (!fs.existsSync(sandboxDir)) return [];

    const items: CleanupItem[] = [];
    const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);

    let entries: string[];
    try {
        entries = fs.readdirSync(sandboxDir);
    } catch {
        return [];
    }

    for (const entry of entries) {
        const entryPath = path.join(sandboxDir, entry);
        try {
            const stat = fs.statSync(entryPath);
            if (stat.mtime < cutoff) {
                const sizeBytes = stat.isDirectory() ? dirSizeBytes(entryPath) : stat.size;
                items.push({ path: entryPath, category: 'isolation-sandbox', reason: 'age', sizeBytes });
            }
        } catch {
            // Skip unreadable entries.
        }
    }

    return items;
}

export function collectStaleLifecycleLock(runtimeDir: string): CleanupItem[] {
    const items: CleanupItem[] = [];
    if (!fs.existsSync(runtimeDir)) return items;

    let siblings: string[];
    try {
        siblings = fs.readdirSync(runtimeDir);
    } catch {
        return items;
    }

    const staleLockPattern = new RegExp(`^${LIFECYCLE_OPERATION_LOCK_DIR_NAME.replace(/\./g, '\\.')}\\.stale-`);

    for (const sibling of siblings) {
        if (!staleLockPattern.test(sibling)) continue;
        const stalePath = path.join(runtimeDir, sibling);
        try {
            const stat = fs.statSync(stalePath);
            const sizeBytes = stat.isDirectory() ? dirSizeBytes(stalePath) : stat.size;
            items.push({ path: stalePath, category: 'stale-locks', reason: 'orphaned', sizeBytes });
        } catch {
            // Skip unreadable files.
        }
    }

    return items;
}

export function collectStaleTaskEventLockCandidates(bundleRoot: string): CleanupItem[] {
    const taskEventsDir = resolveRuntimeCleanupStandardPaths(path.join(bundleRoot, 'runtime')).taskEventsDir;
    const inspection = scanTaskEventLocks(bundleRoot);

    return inspection.locks
        .filter((lock) => lock.status === 'STALE')
        .map((lock) => {
            const lockPath = path.join(taskEventsDir, lock.lock_name);
            let sizeBytes = 0;
            try {
                const stat = fs.statSync(lockPath);
                sizeBytes = stat.isDirectory() ? dirSizeBytes(lockPath) : stat.size;
            } catch {
                // leave at zero
            }
            return { path: lockPath, category: 'task-events', reason: 'stale-lock', sizeBytes };
        });
}

export function buildCategorySummary(items: CleanupItem[]): Record<string, { count: number; bytes: number }> {
    const summary: Record<string, { count: number; bytes: number }> = {};
    for (const item of items) {
        const entry = summary[item.category] || { count: 0, bytes: 0 };
        entry.count += 1;
        entry.bytes += item.sizeBytes;
        summary[item.category] = entry;
    }
    return summary;
}

export function collectStandardCandidates(
    runtimeDir: string,
    policy: RetentionPolicy,
    now: Date,
    activeTaskIds: ReadonlySet<string> = new Set<string>()
): CleanupItem[] {
    const standardPaths = resolveRuntimeCleanupStandardPaths(runtimeDir);
    const activeTaskIdsLower = new Set(Array.from(activeTaskIds, taskId => taskId.toLowerCase()));

    return [
        ...collectTimestampedDirs(standardPaths.backupsDir, 'backups', policy.maxBackups, policy.maxAgeDays, now),
        ...collectTimestampedDirs(standardPaths.bundleBackupsDir, 'bundle-backups', policy.maxBundleBackups, policy.maxAgeDays, now),
        ...collectOrphanedCompletenessCaches(standardPaths.taskEventsDir, activeTaskIds),
        ...collectRuntimeRootTempFiles(runtimeDir, policy.maxAgeDays, now, activeTaskIdsLower),
        ...collectRuntimeTmp(standardPaths.tmpDir, policy.maxAgeDays, now, activeTaskIdsLower),
        ...collectAgedEntries(standardPaths.testScratchDir, 'test-scratch', policy.maxAgeDays, now),
        ...collectAgedEntries(standardPaths.cacheDir, 'cache', policy.maxAgeDays, now),
        ...collectAgedEntries(standardPaths.reportsDir, 'reports', policy.maxAgeDays, now),
        ...collectAgedEntries(standardPaths.updateTempDir, 'update-temp', policy.maxAgeDays, now),
        ...collectUpdateNamedDirs(standardPaths.updateRollbacksDir, 'update-rollbacks', policy.maxUpdateRollbacks, policy.maxAgeDays, now),
        ...collectUpdateNamedDirs(standardPaths.updateReportsDir, 'update-reports', policy.maxUpdateReports, policy.maxAgeDays, now)
    ];
}

export { cleanupStaleTaskEventLocks };
