import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanTaskEventLocks } from '../gate-runtime/task-events';
import {
    DEFAULT_METRICS_FILE_NAME,
    TOXIN_METRIC_TYPES as CONSTANT_TOXIN_METRIC_TYPES,
    isBundleRootLike,
    resolveBundleNameForTarget
} from '../core/constants';
import { isLowNoiseRuntimeWritesEnabled } from '../gate-runtime/derived-runtime-writes';
import {
    collectRuntimeToxinScanWithCache,
    RUNTIME_TOXIN_SCAN_DIRECTORIES as RUNTIME_SUBDIRS,
    type RuntimeToxinScanCacheValue
} from './toxin-snapshot-cache';

// ── Types ────────────────────────────────────────────────────────────

export type ToxinMetricType =
    | 'disk_artifact_growth'
    | 'stale_locks'
    | 'cleanup_candidates'
    | 'gate_overhead'
    | 'noisy_outputs';

export interface ToxinMetricEntry {
    timestamp_utc: string;
    metric_type: ToxinMetricType;
    value: number;
    unit: string;
    metadata: Record<string, unknown>;
}

export interface DiskArtifactSummary {
    directory: string;
    file_count: number;
    total_bytes: number;
}

export interface ToxinSnapshot {
    timestamp_utc: string;
    runtime_disk: DiskArtifactSummary[];
    runtime_total_bytes: number;
    stale_lock_count: number;
    cleanup_candidate_count: number;
    cleanup_candidate_bytes: number;
    noisy_artifact_count: number;
    noisy_artifact_bytes: number;
    gate_event_count: number;
    metrics_file_lines: number;
}

export interface ToxinStatusSummary {
    runtime_total_bytes: number;
    runtime_total_label: string;
    stale_lock_count: number;
    cleanup_candidate_count: number;
    cleanup_candidate_bytes: number;
    noisy_artifact_count: number;
    gate_event_count: number;
    metrics_file_lines: number;
    warnings: string[];
}

export interface CollectToxinSnapshotOptions {
    bundleRoot?: string;
    metricsPath?: string;
    useCache?: boolean;
    readOnly?: boolean;
    cleanupMaxAgeDays?: number;
    nowMs?: number;
}

export interface RecordToxinMetricsSnapshotOptions extends CollectToxinSnapshotOptions {
    maxLines?: number;
}

export interface ToxinMetricsSnapshotDueOptions {
    minIntervalMs?: number;
}

interface RuntimeToxinScanSummary extends RuntimeToxinScanCacheValue {
    diskSummaries: DiskArtifactSummary[];
}

interface DirectoryTally {
    bytes: number;
    count: number;
}

// ── Constants ────────────────────────────────────────────────────────

export const TOXIN_METRIC_TYPES: readonly ToxinMetricType[] = CONSTANT_TOXIN_METRIC_TYPES as readonly ToxinMetricType[];

export const DEFAULT_METRICS_MAX_LINES = 2000;

export const DEFAULT_TOXIN_SNAPSHOT_MIN_INTERVAL_MS = 60 * 1000;

const NOISY_ARTIFACT_THRESHOLD_BYTES = 512 * 1024; // 512 KB

// Average bytes per JSONL event line for estimation (avoids full-file reads)
const ESTIMATED_BYTES_PER_EVENT_LINE = 350;

// Chunk size for streaming file reads (64 KB balances syscall count vs memory)
const STREAM_CHUNK_SIZE = 64 * 1024;

const METRICS_LOCK_STALE_MS = 30 * 1000;
const METRICS_LOCK_WAIT_MS = 1000;
const METRICS_LOCK_RETRY_MS = 10;
const METRICS_LOCK_OWNER_FILE = 'owner.json';

const CLEANUP_CANDIDATE_SUBDIRS = new Set([
    'backups',
    'bundle-backups',
    'update-rollbacks',
    'update-reports'
]);

// ── Helpers ──────────────────────────────────────────────────────────

function nowUtc(): string {
    return new Date().toISOString();
}

function sleepSync(ms: number): void {
    if (ms <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function metricsLockPath(metricsPath: string): string {
    return `${metricsPath}.lock`;
}

function removeDirectoryBestEffort(dirPath: string): void {
    try {
        fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
        // best-effort
    }
}

function isProcessAlive(pid: unknown): boolean {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function readMetricsLockOwner(lockPath: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(lockPath, METRICS_LOCK_OWNER_FILE), 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function isMetricsLockStale(lockPath: string): boolean {
    try {
        const owner = readMetricsLockOwner(lockPath);
        if (owner && isProcessAlive(owner.pid)) {
            return false;
        }
        let observedMtimeMs = fs.statSync(lockPath).mtimeMs;
        try {
            observedMtimeMs = Math.max(
                observedMtimeMs,
                fs.statSync(path.join(lockPath, METRICS_LOCK_OWNER_FILE)).mtimeMs
            );
        } catch {
            // owner metadata is diagnostic; the lock directory still carries staleness.
        }
        return Date.now() - observedMtimeMs > METRICS_LOCK_STALE_MS;
    } catch {
        return false;
    }
}

function acquireMetricsFileLock(metricsPath: string): string | null {
    const lockPath = metricsLockPath(metricsPath);
    const startedAt = Date.now();
    try {
        fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
    } catch {
        return null;
    }
    while (Date.now() - startedAt <= METRICS_LOCK_WAIT_MS) {
        try {
            fs.mkdirSync(lockPath);
            try {
                fs.writeFileSync(path.join(lockPath, METRICS_LOCK_OWNER_FILE), JSON.stringify({
                    pid: process.pid,
                    started_at_utc: nowUtc()
                }), 'utf8');
            } catch {
                // lock directory is the ownership primitive; owner metadata is diagnostic only
            }
            return lockPath;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST') {
                return null;
            }
            if (isMetricsLockStale(lockPath)) {
                removeDirectoryBestEffort(lockPath);
                continue;
            }
            sleepSync(METRICS_LOCK_RETRY_MS);
        }
    }
    return null;
}

function withMetricsFileLock<T>(metricsPath: string, fallback: T, callback: () => T): T {
    const lockPath = acquireMetricsFileLock(metricsPath);
    if (!lockPath) {
        return fallback;
    }
    try {
        return callback();
    } finally {
        removeDirectoryBestEffort(lockPath);
    }
}

function writeFileAtomic(filePath: string, content: string | Buffer): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
    );
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, filePath);
}

function dirSizeAndCount(dirPath: string): { bytes: number; count: number } {
    let totalBytes = 0;
    let totalCount = 0;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                const sub = dirSizeAndCount(fullPath);
                totalBytes += sub.bytes;
                totalCount += sub.count;
            } else {
                try {
                    totalBytes += fs.statSync(fullPath).size;
                    totalCount++;
                } catch {
                    // skip unreadable
                }
            }
        }
    } catch {
        // inaccessible
    }
    return { bytes: totalBytes, count: totalCount };
}

function estimateFileLineCountFromBytes(sizeBytes: number): number {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return 0;
    return Math.max(1, Math.round(sizeBytes / ESTIMATED_BYTES_PER_EVENT_LINE));
}

function estimateFileLineCount(filePath: string): number {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0) return 0;
        return estimateFileLineCountFromBytes(stat.size);
    } catch {
        return 0;
    }
}

/**
 * Count non-empty lines in a file using chunked streaming reads.
 * Avoids loading the entire file into memory.
 */
export function countFileLinesStreaming(filePath: string): number {
    let fd: number;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0) return 0;
        fd = fs.openSync(filePath, 'r');
    } catch {
        return 0;
    }
    try {
        const buf = Buffer.alloc(STREAM_CHUNK_SIZE);
        let count = 0;
        let lineHasContent = false;
        let position = 0;
        while (true) {
            const bytesRead = fs.readSync(fd, buf, 0, buf.length, position);
            if (bytesRead === 0) break;
            for (let i = 0; i < bytesRead; i++) {
                if (buf[i] === 0x0A) {
                    if (lineHasContent) count++;
                    lineHasContent = false;
                } else {
                    lineHasContent = true;
                }
            }
            position += bytesRead;
        }
        if (lineHasContent) count++;
        return count;
    } finally {
        fs.closeSync(fd);
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function looksLikeRuntimeBundleRoot(candidateRoot: string): boolean {
    try {
        const runtimePath = path.join(candidateRoot, 'runtime');
        return fs.existsSync(runtimePath) && fs.statSync(runtimePath).isDirectory();
    } catch {
        return false;
    }
}

function resolveToxinPaths(
    repoRoot: string,
    options: CollectToxinSnapshotOptions = {}
): { orchestratorRoot: string; runtimeRoot: string; metricsPath: string } {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const explicitBundleRoot = String(options.bundleRoot || '').trim();

    let orchestratorRoot = normalizedRepoRoot;
    if (explicitBundleRoot) {
        const resolvedBundleRoot = path.resolve(explicitBundleRoot);
        if (isBundleRootLike(resolvedBundleRoot) || looksLikeRuntimeBundleRoot(resolvedBundleRoot)) {
            orchestratorRoot = resolvedBundleRoot;
        }
    } else if (!(isBundleRootLike(normalizedRepoRoot) || looksLikeRuntimeBundleRoot(normalizedRepoRoot))) {
        orchestratorRoot = path.join(normalizedRepoRoot, resolveBundleNameForTarget(normalizedRepoRoot));
    }

    const runtimeRoot = path.join(orchestratorRoot, 'runtime');
    const metricsPath = String(options.metricsPath || '').trim()
        ? path.resolve(String(options.metricsPath))
        : path.join(runtimeRoot, DEFAULT_METRICS_FILE_NAME);
    return {
        orchestratorRoot,
        runtimeRoot,
        metricsPath
    };
}

function scanRuntimeTreeForToxins(
    runtimeRoot: string,
    maxAgeDays: number = 30,
    nowMs: number = Date.now()
): RuntimeToxinScanSummary {
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoffMs = nowMs - maxAgeMs;
    const diskSummaries: DiskArtifactSummary[] = [];
    let runtimeTotalBytes = 0;
    let cleanupCandidateCount = 0;
    let cleanupCandidateBytes = 0;
    let noisyArtifactCount = 0;
    let noisyArtifactBytes = 0;
    let gateEventCount = 0;
    let nextRetentionTransitionAtMs: number | null = null;

    const recordRetentionState = (mtimeMs: number, bytes: number): void => {
        if (mtimeMs < cutoffMs) {
            cleanupCandidateCount++;
            cleanupCandidateBytes += bytes;
            return;
        }
        const eligibleAtMs = Math.floor(mtimeMs + maxAgeMs) + 1;
        nextRetentionTransitionAtMs = nextRetentionTransitionAtMs === null
            ? eligibleAtMs
            : Math.min(nextRetentionTransitionAtMs, eligibleAtMs);
    };

    const walkDirectory = (
        currentDir: string,
        options: {
            topLevelOnlyNoisy: boolean;
            topLevelOnlyGateEvents: boolean;
            topLevelOnlyCleanupCandidates: boolean;
            depth: number;
        }
    ): DirectoryTally => {
        let totalBytes = 0;
        let totalCount = 0;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return { bytes: 0, count: 0 };
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                const child = walkDirectory(fullPath, {
                    ...options,
                    depth: options.depth + 1,
                    topLevelOnlyNoisy: false,
                    topLevelOnlyGateEvents: false,
                    topLevelOnlyCleanupCandidates: false
                });
                totalBytes += child.bytes;
                totalCount += child.count;

                if (options.topLevelOnlyCleanupCandidates && options.depth === 0) {
                    try {
                        const stat = fs.statSync(fullPath);
                        recordRetentionState(stat.mtimeMs, child.bytes);
                    } catch {
                        // skip unreadable top-level entry
                    }
                }
                continue;
            }

            try {
                const stat = fs.statSync(fullPath);
                if (!stat.isFile()) continue;

                totalBytes += stat.size;
                totalCount++;

                if (options.topLevelOnlyNoisy && options.depth === 0 && stat.size > NOISY_ARTIFACT_THRESHOLD_BYTES) {
                    noisyArtifactCount++;
                    noisyArtifactBytes += stat.size;
                }

                if (
                    options.topLevelOnlyGateEvents
                    && options.depth === 0
                    && entry.name.endsWith('.jsonl')
                    && entry.name !== 'all-tasks.jsonl'
                ) {
                    gateEventCount += estimateFileLineCountFromBytes(stat.size);
                }

                if (options.topLevelOnlyCleanupCandidates && options.depth === 0 && stat.mtimeMs < cutoffMs) {
                    recordRetentionState(stat.mtimeMs, stat.size);
                } else if (options.topLevelOnlyCleanupCandidates && options.depth === 0) {
                    recordRetentionState(stat.mtimeMs, stat.size);
                }
            } catch {
                // skip unreadable file
            }
        }

        return { bytes: totalBytes, count: totalCount };
    };

    for (const subdir of RUNTIME_SUBDIRS) {
        const dirPath = path.join(runtimeRoot, subdir);
        if (!fs.existsSync(dirPath)) continue;

        const tally = walkDirectory(dirPath, {
            topLevelOnlyNoisy: subdir === 'reviews',
            topLevelOnlyGateEvents: subdir === 'task-events',
            topLevelOnlyCleanupCandidates: CLEANUP_CANDIDATE_SUBDIRS.has(subdir),
            depth: 0
        });
        runtimeTotalBytes += tally.bytes;
        diskSummaries.push({
            directory: subdir,
            file_count: tally.count,
            total_bytes: tally.bytes
        });
    }

    return {
        diskSummaries,
        runtimeTotalBytes,
        cleanupCandidateCount,
        cleanupCandidateBytes,
        noisyArtifactCount,
        noisyArtifactBytes,
        gateEventCount,
        nextRetentionTransitionAtMs
    };
}

// ── Snapshot Collection ──────────────────────────────────────────────

export function collectDiskArtifactSummaries(runtimeRoot: string): DiskArtifactSummary[] {
    const summaries: DiskArtifactSummary[] = [];
    for (const subdir of RUNTIME_SUBDIRS) {
        const dirPath = path.join(runtimeRoot, subdir);
        if (!fs.existsSync(dirPath)) continue;
        const result = dirSizeAndCount(dirPath);
        summaries.push({
            directory: subdir,
            file_count: result.count,
            total_bytes: result.bytes
        });
    }
    return summaries;
}

export function countStaleLocks(orchestratorRoot: string): number {
    try {
        const scanResult = scanTaskEventLocks(orchestratorRoot);
        return scanResult.stale_count;
    } catch {
        return 0;
    }
}

export function collectNoisyArtifacts(runtimeRoot: string): { count: number; bytes: number } {
    const reviewsDir = path.join(runtimeRoot, 'reviews');
    if (!fs.existsSync(reviewsDir)) return { count: 0, bytes: 0 };
    let count = 0;
    let bytes = 0;
    try {
        const entries = fs.readdirSync(reviewsDir);
        for (const entry of entries) {
            const fullPath = path.join(reviewsDir, entry);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isFile() && stat.size > NOISY_ARTIFACT_THRESHOLD_BYTES) {
                    count++;
                    bytes += stat.size;
                }
            } catch {
                // skip
            }
        }
    } catch {
        // ignore
    }
    return { count, bytes };
}

export function estimateGateEventCount(runtimeRoot: string): number {
    const eventsDir = path.join(runtimeRoot, 'task-events');
    if (!fs.existsSync(eventsDir)) return 0;
    let total = 0;
    try {
        const entries = fs.readdirSync(eventsDir);
        for (const entry of entries) {
            if (entry.endsWith('.jsonl') && entry !== 'all-tasks.jsonl') {
                const filePath = path.join(eventsDir, entry);
                total += estimateFileLineCount(filePath);
            }
        }
    } catch {
        // ignore
    }
    return total;
}

export function countCleanupCandidates(runtimeRoot: string, maxAgeDays: number = 30): { count: number; bytes: number } {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let count = 0;
    let bytes = 0;

    for (const subdir of ['backups', 'bundle-backups', 'update-rollbacks', 'update-reports']) {
        const dirPath = path.join(runtimeRoot, subdir);
        if (!fs.existsSync(dirPath)) continue;
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.mtimeMs < cutoff) {
                        count++;
                        bytes += entry.isDirectory() ? dirSizeAndCount(fullPath).bytes : stat.size;
                    }
                } catch {
                    // skip
                }
            }
        } catch {
            // ignore
        }
    }
    return { count, bytes };
}

// ── Full Snapshot ────────────────────────────────────────────────────

export function collectToxinSnapshot(repoRoot: string, options: CollectToxinSnapshotOptions = {}): ToxinSnapshot {
    const { orchestratorRoot, runtimeRoot, metricsPath } = resolveToxinPaths(repoRoot, options);
    const cleanupMaxAgeDays = options.cleanupMaxAgeDays ?? 30;
    const nowMs = options.nowMs ?? Date.now();
    const runtimeScan = collectRuntimeToxinScanWithCache({
        orchestratorRoot,
        runtimeRoot,
        cleanupMaxAgeDays,
        nowMs,
        cacheEnabled: options.useCache !== false,
        readOnly: options.readOnly,
        collectFresh: () => scanRuntimeTreeForToxins(runtimeRoot, cleanupMaxAgeDays, nowMs)
    });
    const staleLocks = countStaleLocks(orchestratorRoot);
    const metricsLines = countFileLinesStreaming(metricsPath);

    return {
        timestamp_utc: new Date(nowMs).toISOString(),
        runtime_disk: runtimeScan.diskSummaries,
        runtime_total_bytes: runtimeScan.runtimeTotalBytes,
        stale_lock_count: staleLocks,
        cleanup_candidate_count: runtimeScan.cleanupCandidateCount,
        cleanup_candidate_bytes: runtimeScan.cleanupCandidateBytes,
        noisy_artifact_count: runtimeScan.noisyArtifactCount,
        noisy_artifact_bytes: runtimeScan.noisyArtifactBytes,
        gate_event_count: runtimeScan.gateEventCount,
        metrics_file_lines: metricsLines
    };
}

// ── Status Summary ───────────────────────────────────────────────────

export function buildToxinStatusSummary(snapshot: ToxinSnapshot): ToxinStatusSummary {
    const warnings: string[] = [];

    if (snapshot.stale_lock_count > 0) {
        warnings.push(`${snapshot.stale_lock_count} stale lock(s) detected; run garda gc to preview, then rerun with --confirm to clean`);
    }
    if (snapshot.cleanup_candidate_count > 0) {
        warnings.push(
            `${snapshot.cleanup_candidate_count} cleanup candidate(s) (${formatBytes(snapshot.cleanup_candidate_bytes)}); run garda gc to preview retention tiers before --confirm`
        );
    }
    if (snapshot.noisy_artifact_count > 0) {
        warnings.push(
            `${snapshot.noisy_artifact_count} oversized artifact(s) (>${formatBytes(NOISY_ARTIFACT_THRESHOLD_BYTES)} each, ${formatBytes(snapshot.noisy_artifact_bytes)} total)`
        );
    }
    if (snapshot.metrics_file_lines > DEFAULT_METRICS_MAX_LINES) {
        warnings.push(
            `metrics.jsonl has ${snapshot.metrics_file_lines} lines (limit ${DEFAULT_METRICS_MAX_LINES}); run garda gc to prune`
        );
    }

    return {
        runtime_total_bytes: snapshot.runtime_total_bytes,
        runtime_total_label: formatBytes(snapshot.runtime_total_bytes),
        stale_lock_count: snapshot.stale_lock_count,
        cleanup_candidate_count: snapshot.cleanup_candidate_count,
        cleanup_candidate_bytes: snapshot.cleanup_candidate_bytes,
        noisy_artifact_count: snapshot.noisy_artifact_count,
        gate_event_count: snapshot.gate_event_count,
        metrics_file_lines: snapshot.metrics_file_lines,
        warnings
    };
}

export function formatToxinSummaryLines(summary: ToxinStatusSummary): string[] {
    const lines: string[] = [];
    lines.push(`RuntimeDisk: ${summary.runtime_total_label}`);
    lines.push(`  GateEvents: ~${summary.gate_event_count} | StaleLocks: ${summary.stale_lock_count} | CleanupCandidates: ${summary.cleanup_candidate_count} | NoisyArtifacts: ${summary.noisy_artifact_count}`);
    lines.push(`  MetricsLines: ${summary.metrics_file_lines}/${DEFAULT_METRICS_MAX_LINES}`);
    for (const warning of summary.warnings) {
        lines.push(`  Warning: ${warning}`);
    }
    return lines;
}

/**
 * Prune metrics JSONL file to retain at most `maxLines` recent non-empty lines.
 * Uses streaming reads to avoid loading the entire file into memory.
 * When `knownLineCount` is provided (e.g. from a prior streaming count plus
 * appended entries), the re-count is skipped entirely.
 */
function pruneMetricsFileUnlocked(
    metricsPath: string,
    maxLines: number = DEFAULT_METRICS_MAX_LINES,
    knownLineCount?: number
): { pruned: boolean; linesBefore: number; linesAfter: number } {
    if (!fs.existsSync(metricsPath)) {
        return { pruned: false, linesBefore: 0, linesAfter: 0 };
    }

    const linesBefore = knownLineCount ?? countFileLinesStreaming(metricsPath);

    if (linesBefore <= maxLines) {
        return { pruned: false, linesBefore, linesAfter: linesBefore };
    }

    const linesToSkip = linesBefore - maxLines;

    let fd: number;
    try {
        fd = fs.openSync(metricsPath, 'r');
    } catch {
        return { pruned: false, linesBefore, linesAfter: linesBefore };
    }

    try {
        const fileSize = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(STREAM_CHUNK_SIZE);
        let skipped = 0;
        let position = 0;
        let cutOffset = 0;
        let lineHasContent = false;

        outer:
        while (position < fileSize) {
            const bytesRead = fs.readSync(fd, buf, 0, buf.length, position);
            if (bytesRead === 0) break;
            for (let i = 0; i < bytesRead; i++) {
                if (buf[i] === 0x0A) {
                    if (lineHasContent) {
                        skipped++;
                        if (skipped >= linesToSkip) {
                            cutOffset = position + i + 1;
                            break outer;
                        }
                    }
                    lineHasContent = false;
                } else {
                    lineHasContent = true;
                }
            }
            position += bytesRead;
        }

        const tailSize = fileSize - cutOffset;
        if (tailSize <= 0) {
            fs.closeSync(fd);
            try {
            writeFileAtomic(metricsPath, Buffer.from('', 'utf8'));
            } catch {
                return { pruned: false, linesBefore, linesAfter: linesBefore };
            }
            return { pruned: true, linesBefore, linesAfter: 0 };
        }

        const tail = Buffer.alloc(tailSize);
        fs.readSync(fd, tail, 0, tailSize, cutOffset);
        fs.closeSync(fd);

        try {
            writeFileAtomic(metricsPath, tail);
        } catch {
            return { pruned: false, linesBefore, linesAfter: linesBefore };
        }
        return { pruned: true, linesBefore, linesAfter: maxLines };
    } catch {
        try { fs.closeSync(fd); } catch { /* already closed or invalid */ }
        return { pruned: false, linesBefore, linesAfter: linesBefore };
    }
}

export function pruneMetricsFile(
    metricsPath: string,
    maxLines: number = DEFAULT_METRICS_MAX_LINES,
    knownLineCount?: number
): { pruned: boolean; linesBefore: number; linesAfter: number } {
    if (!fs.existsSync(metricsPath)) {
        return { pruned: false, linesBefore: 0, linesAfter: 0 };
    }

    return withMetricsFileLock(
        metricsPath,
        { pruned: false, linesBefore: 0, linesAfter: 0 },
        () => pruneMetricsFileUnlocked(metricsPath, maxLines, knownLineCount)
    );
}

// ── Toxin Snapshot as Metric Entry ───────────────────────────────────

export function snapshotToMetricEntries(snapshot: ToxinSnapshot): ToxinMetricEntry[] {
    const ts = snapshot.timestamp_utc;
    return [
        {
            timestamp_utc: ts,
            metric_type: 'disk_artifact_growth',
            value: snapshot.runtime_total_bytes,
            unit: 'bytes',
            metadata: {
                directories: snapshot.runtime_disk
            }
        },
        {
            timestamp_utc: ts,
            metric_type: 'stale_locks',
            value: snapshot.stale_lock_count,
            unit: 'count',
            metadata: {}
        },
        {
            timestamp_utc: ts,
            metric_type: 'cleanup_candidates',
            value: snapshot.cleanup_candidate_count,
            unit: 'count',
            metadata: {
                total_bytes: snapshot.cleanup_candidate_bytes
            }
        },
        {
            timestamp_utc: ts,
            metric_type: 'gate_overhead',
            value: snapshot.gate_event_count,
            unit: 'events',
            metadata: {}
        },
        {
            timestamp_utc: ts,
            metric_type: 'noisy_outputs',
            value: snapshot.noisy_artifact_count,
            unit: 'count',
            metadata: {
                total_bytes: snapshot.noisy_artifact_bytes
            }
        }
    ];
}

function appendMetricLinesUnlocked(metricsPath: string, lines: string[]): boolean {
    if (!metricsPath || lines.length === 0) return true;
    try {
        fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
        fs.appendFileSync(metricsPath, lines.join('\n') + '\n', 'utf8');
        return true;
    } catch {
        // best-effort
        return false;
    }
}

export function appendMetricJsonLines(metricsPath: string, entries: readonly Record<string, unknown>[]): boolean {
    if (!metricsPath || entries.length === 0) return true;
    if (isLowNoiseRuntimeWritesEnabled()) return true;
    const lines = entries.map(entry => JSON.stringify(entry));
    return withMetricsFileLock(metricsPath, false, () => appendMetricLinesUnlocked(metricsPath, lines));
}

export function appendToxinMetrics(metricsPath: string, entries: ToxinMetricEntry[]): void {
    appendMetricJsonLines(metricsPath, entries as unknown as readonly Record<string, unknown>[]);
}

function toxinSnapshotStatePath(metricsPath: string): string {
    return `${metricsPath}.toxin-snapshot-state.json`;
}

function readLastToxinSnapshotRecordedAtMs(statePath: string): number {
    try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
        const timestamp = Date.parse(String(parsed.last_recorded_at_utc || ''));
        return Number.isFinite(timestamp) ? timestamp : 0;
    } catch {
        return 0;
    }
}

export function shouldRecordToxinMetricsSnapshot(
    metricsPath: string,
    options: ToxinMetricsSnapshotDueOptions = {}
): boolean {
    if (!metricsPath) return false;
    if (isLowNoiseRuntimeWritesEnabled()) return false;
    const minIntervalMs = options.minIntervalMs ?? DEFAULT_TOXIN_SNAPSHOT_MIN_INTERVAL_MS;
    if (minIntervalMs <= 0) return true;
    return withMetricsFileLock(metricsPath, false, () => {
        const statePath = toxinSnapshotStatePath(metricsPath);
        const now = Date.now();
        const previous = readLastToxinSnapshotRecordedAtMs(statePath);
        if (previous > 0 && now - previous < minIntervalMs) {
            return false;
        }
        writeFileAtomic(statePath, JSON.stringify({
            last_recorded_at_utc: new Date(now).toISOString(),
            min_interval_ms: minIntervalMs
        }) + '\n');
        return true;
    });
}

export function recordToxinMetricsSnapshot(
    repoRoot: string,
    options: RecordToxinMetricsSnapshotOptions = {}
): ToxinSnapshot {
    const resolvedPaths = resolveToxinPaths(repoRoot, options);
    const snapshot = collectToxinSnapshot(repoRoot, options);
    if (isLowNoiseRuntimeWritesEnabled()) {
        return snapshot;
    }
    const entries = snapshotToMetricEntries(snapshot);
    const maxLines = options.maxLines ?? DEFAULT_METRICS_MAX_LINES;
    withMetricsFileLock(resolvedPaths.metricsPath, undefined, () => {
        appendMetricLinesUnlocked(resolvedPaths.metricsPath, entries.map(entry => JSON.stringify(entry)));
        pruneMetricsFileUnlocked(resolvedPaths.metricsPath, maxLines);
    });
    return snapshot;
}
