import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { writeFileAtomically } from '../../core/filesystem';
import { isCanonicalTaskId, taskIdsEqualCaseInsensitive } from '../../core/task-ids';
import {
    withFilesystemLock,
    withFilesystemLockAsync,
    type AcquireLockTelemetry,
    type LockOptions
} from './task-events-locking';

export const DEFAULT_AGGREGATE_MAX_LINES = 10000;
export const AGGREGATE_BYTES_PER_LINE_ESTIMATE = 512;
const AGGREGATE_PRUNE_CHUNK_SIZE = 64 * 1024;
const AGGREGATE_COUNT_CACHE_LIMIT = 64;
const AGGREGATE_PRUNE_HEADROOM_DIVISOR = 100;
const AGGREGATE_PRUNE_HEADROOM_MAX_LINES = 100;

export type AggregateAppendMode = 'lock_free' | 'locked' | 'locked_prune' | 'skipped_low_noise';

export interface AggregateRetentionResult {
    pruned: boolean;
    lines_before: number;
    lines_after: number;
}

export interface AggregateRetentionApplyResult {
    appendMode: AggregateAppendMode;
    retention?: AggregateRetentionResult;
    telemetry?: AcquireLockTelemetry;
}

interface AggregateFileSnapshot {
    identity: string;
    fingerprint: string;
    size: number;
}

interface AggregateLineCount {
    lines: number;
    terminated: boolean;
}

interface AggregateCountCacheEntry extends AggregateLineCount {
    maxLines: number;
    snapshot: AggregateFileSnapshot;
}

const aggregateLineCounts = new Map<string, AggregateCountCacheEntry>();

function parseAggregateTaskId(line: string): string | null {
    try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const taskId = String(parsed.task_id || '').trim();
        return isCanonicalTaskId(taskId) ? taskId : null;
    } catch {
        return null;
    }
}

function removeAggregateTaskRecords(allTasksPath: string, taskId: string): AggregateRetentionResult {
    if (!fs.existsSync(allTasksPath)) {
        return { pruned: false, lines_before: 0, lines_after: 0 };
    }

    const tempPath = `${allTasksPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let readFd: number | null = null;
    let writeFd: number | null = null;
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let linesBefore = 0;
    let linesAfter = 0;
    let pruned = false;

    function processLine(line: string): void {
        if (line.trim().length === 0) {
            return;
        }
        linesBefore += 1;
        const lineTaskId = parseAggregateTaskId(line);
        if (lineTaskId && taskIdsEqualCaseInsensitive(lineTaskId, taskId)) {
            pruned = true;
            return;
        }
        fs.writeSync(writeFd!, `${line}\n`, undefined, 'utf8');
        linesAfter += 1;
    }

    try {
        const stat = fs.statSync(allTasksPath);
        if (!stat.isFile() || stat.size === 0) {
            return { pruned: false, lines_before: 0, lines_after: 0 };
        }
        readFd = fs.openSync(allTasksPath, 'r');
        writeFd = fs.openSync(tempPath, 'wx');
        const buf = Buffer.alloc(AGGREGATE_PRUNE_CHUNK_SIZE);
        let position = 0;
        while (true) {
            const bytesRead = fs.readSync(readFd, buf, 0, buf.length, position);
            if (bytesRead === 0) break;
            pending += decoder.write(buf.subarray(0, bytesRead));
            let newlineIndex = pending.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
                processLine(line);
                pending = pending.slice(newlineIndex + 1);
                newlineIndex = pending.indexOf('\n');
            }
            position += bytesRead;
        }
        pending += decoder.end();
        if (pending.length > 0) {
            processLine(pending.replace(/\r$/, ''));
        }
        fs.closeSync(readFd);
        readFd = null;
        fs.closeSync(writeFd);
        writeFd = null;

        if (!pruned) {
            fs.rmSync(tempPath, { force: true });
            return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
        }

        fs.renameSync(tempPath, allTasksPath);
        return { pruned: true, lines_before: linesBefore, lines_after: linesAfter };
    } catch (error) {
        if (readFd !== null) {
            try { fs.closeSync(readFd); } catch { /* ignore cleanup failure */ }
        }
        if (writeFd !== null) {
            try { fs.closeSync(writeFd); } catch { /* ignore cleanup failure */ }
        }
        try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore cleanup failure */ }
        throw error;
    }
}

function toNonNegativeInteger(value: unknown, fallback: number): number {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function inspectAggregateLineCount(filePath: string): AggregateLineCount | null {
    let fd: number;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0) return { lines: 0, terminated: true };
        fd = fs.openSync(filePath, 'r');
    } catch {
        return null;
    }
    try {
        const buf = Buffer.alloc(AGGREGATE_PRUNE_CHUNK_SIZE);
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
        return { lines: count, terminated: !lineHasContent };
    } finally {
        fs.closeSync(fd);
    }
}

function countLinesStreaming(filePath: string): number {
    return inspectAggregateLineCount(filePath)?.lines ?? 0;
}

function pruneAggregateLogWithProtectedTasksStreaming(
    allTasksPath: string,
    maxLines: number,
    linesBefore: number,
    protectedTaskIds: ReadonlySet<string>
): AggregateRetentionResult {
    const removableTarget = linesBefore - maxLines;
    if (removableTarget <= 0) {
        return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
    }

    const tempPath = `${allTasksPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let readFd: number | null = null;
    let writeFd: number | null = null;
    let removable = removableTarget;
    let keptLines = 0;
    let pruned = false;
    const decoder = new StringDecoder('utf8');
    let pending = '';

    function processLine(line: string): void {
        if (line.trim().length === 0) {
            return;
        }
        const taskId = parseAggregateTaskId(line);
        const protectedLine = taskId ? protectedTaskIds.has(taskId) : true;
        if (!protectedLine && removable > 0) {
            removable -= 1;
            pruned = true;
            return;
        }
        fs.writeSync(writeFd!, `${line}\n`, undefined, 'utf8');
        keptLines += 1;
    }

    try {
        readFd = fs.openSync(allTasksPath, 'r');
        writeFd = fs.openSync(tempPath, 'wx');
        const buf = Buffer.alloc(AGGREGATE_PRUNE_CHUNK_SIZE);
        let position = 0;
        while (true) {
            const bytesRead = fs.readSync(readFd, buf, 0, buf.length, position);
            if (bytesRead === 0) break;
            pending += decoder.write(buf.subarray(0, bytesRead));
            let newlineIndex = pending.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
                processLine(line);
                pending = pending.slice(newlineIndex + 1);
                newlineIndex = pending.indexOf('\n');
            }
            position += bytesRead;
        }
        pending += decoder.end();
        if (pending.length > 0) {
            processLine(pending.replace(/\r$/, ''));
        }
        fs.closeSync(readFd);
        readFd = null;
        fs.closeSync(writeFd);
        writeFd = null;

        if (!pruned) {
            fs.rmSync(tempPath, { force: true });
            return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
        }

        fs.renameSync(tempPath, allTasksPath);
        return { pruned: true, lines_before: linesBefore, lines_after: keptLines };
    } catch {
        if (readFd !== null) {
            try { fs.closeSync(readFd); } catch { /* ignore cleanup failure */ }
        }
        if (writeFd !== null) {
            try { fs.closeSync(writeFd); } catch { /* ignore cleanup failure */ }
        }
        try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore cleanup failure */ }
        return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
    }
}

export function pruneAggregateLog(
    allTasksPath: string,
    maxLines: number = DEFAULT_AGGREGATE_MAX_LINES,
    knownLineCount?: number,
    protectedTaskIds: ReadonlySet<string> = new Set<string>()
): AggregateRetentionResult {
    if (maxLines <= 0) {
        return { pruned: false, lines_before: 0, lines_after: 0 };
    }

    if (!fs.existsSync(allTasksPath)) {
        return { pruned: false, lines_before: 0, lines_after: 0 };
    }

    const linesBefore = knownLineCount ?? countLinesStreaming(allTasksPath);
    if (linesBefore <= maxLines) {
        return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
    }

    if (protectedTaskIds.size > 0) {
        return pruneAggregateLogWithProtectedTasksStreaming(allTasksPath, maxLines, linesBefore, protectedTaskIds);
    }

    const linesToSkip = linesBefore - maxLines;

    let fd: number;
    try {
        fd = fs.openSync(allTasksPath, 'r');
    } catch {
        return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
    }

    try {
        const fileSize = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(AGGREGATE_PRUNE_CHUNK_SIZE);
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
                writeFileAtomically(allTasksPath, '', { encoding: 'utf8' });
            } catch {
                return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
            }
            return { pruned: true, lines_before: linesBefore, lines_after: 0 };
        }

        const tail = Buffer.alloc(tailSize);
        fs.readSync(fd, tail, 0, tailSize, cutOffset);
        fs.closeSync(fd);

        try {
            writeFileAtomically(allTasksPath, tail);
        } catch {
            return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
        }

        return { pruned: true, lines_before: linesBefore, lines_after: maxLines };
    } catch {
        try { fs.closeSync(fd); } catch { /* already closed or invalid */ }
        return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
    }
}

export function pruneAggregateLogLocked(
    eventsRoot: string,
    maxLines: number = DEFAULT_AGGREGATE_MAX_LINES,
    lockOptions: LockOptions = {},
    protectedTaskIds: ReadonlySet<string> = new Set<string>()
): AggregateRetentionResult {
    const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
    const aggregateLockPath = path.join(eventsRoot, '.all-tasks.lock');
    const lockResult = withFilesystemLock(aggregateLockPath, lockOptions, function (): AggregateRetentionResult {
        return pruneAggregateLog(allTasksPath, maxLines, undefined, protectedTaskIds);
    });
    return lockResult.result;
}

export function pruneAggregateTaskRecordsLocked(
    eventsRoot: string,
    taskId: string,
    lockOptions: LockOptions = {}
): AggregateRetentionResult {
    const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
    const aggregateLockPath = path.join(eventsRoot, '.all-tasks.lock');
    const lockResult = withFilesystemLock(aggregateLockPath, lockOptions, function (): AggregateRetentionResult {
        return removeAggregateTaskRecords(allTasksPath, taskId);
    });
    return lockResult.result;
}

function readAggregateFileSnapshot(filePath: string): AggregateFileSnapshot | null {
    try {
        const stat = fs.lstatSync(filePath, { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || stat.ino <= 0n
            || stat.birthtimeNs <= 0n || stat.mtimeNs <= 0n || stat.ctimeNs <= 0n) return null;
        const identity = [stat.dev, stat.ino, stat.birthtimeNs].join(':');
        return { identity, fingerprint: [identity, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'), size: Number(stat.size) };
    } catch {
        return null;
    }
}

function readCachedAggregateCount(filePath: string, maxLines: number, snapshot: AggregateFileSnapshot | null): AggregateCountCacheEntry | undefined {
    const cached = aggregateLineCounts.get(path.resolve(filePath));
    return cached?.maxLines === maxLines && cached.snapshot.fingerprint === snapshot?.fingerprint ? cached : undefined;
}

function rememberAggregateCount(filePath: string, maxLines: number, count: AggregateLineCount, snapshot: AggregateFileSnapshot | null): void {
    const key = path.resolve(filePath);
    aggregateLineCounts.delete(key);
    if (!snapshot || !count.terminated || count.lines <= 0) return;
    aggregateLineCounts.set(key, { ...count, maxLines, snapshot });
    if (aggregateLineCounts.size > AGGREGATE_COUNT_CACHE_LIMIT) {
        const oldest = aggregateLineCounts.keys().next().value;
        if (oldest) aggregateLineCounts.delete(oldest);
    }
}

function isAggregateAboveSizeTrigger(filePath: string, maxLines: number): boolean {
    if (maxLines <= 0) return false;
    try {
        return fs.statSync(filePath).size > maxLines * AGGREGATE_BYTES_PER_LINE_ESTIMATE;
    } catch {
        return false;
    }
}

function applyAutomaticAggregateRetention(
    filePath: string,
    maxLines: number,
    appendedCount?: AggregateCountCacheEntry
): AggregateRetentionResult | null {
    if (!isAggregateAboveSizeTrigger(filePath, maxLines)) return null;
    const snapshot = readAggregateFileSnapshot(filePath);
    if (!snapshot) {
        aggregateLineCounts.delete(path.resolve(filePath));
        return pruneAggregateLog(filePath, maxLines);
    }
    const cached = appendedCount?.snapshot.fingerprint === snapshot.fingerprint
        ? appendedCount : readCachedAggregateCount(filePath, maxLines, snapshot);
    const count = cached ?? inspectAggregateLineCount(filePath);
    if (!count || readAggregateFileSnapshot(filePath)?.fingerprint !== snapshot.fingerprint) {
        aggregateLineCounts.delete(path.resolve(filePath));
        return pruneAggregateLog(filePath, maxLines);
    }
    if (count.lines <= maxLines) {
        rememberAggregateCount(filePath, maxLines, count, snapshot);
        return null;
    }
    const headroom = Math.min(AGGREGATE_PRUNE_HEADROOM_MAX_LINES, Math.floor(maxLines / AGGREGATE_PRUNE_HEADROOM_DIVISOR));
    const result = pruneAggregateLog(filePath, maxLines - headroom, count.lines);
    const after = readAggregateFileSnapshot(filePath);
    const knownOutput = result.pruned
        ? after?.identity !== snapshot.identity
        : after?.fingerprint === snapshot.fingerprint;
    rememberAggregateCount(filePath, maxLines, { lines: result.lines_after, terminated: count.terminated }, knownOutput ? after : null);
    return result;
}

function appendAggregateLine(filePath: string, line: string, maxLines: number): AggregateRetentionResult | null {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const before = maxLines > 0 ? readAggregateFileSnapshot(filePath) : null;
    const cached = readCachedAggregateCount(filePath, maxLines, before);
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
    const after = cached ? readAggregateFileSnapshot(filePath) : null;
    const appendedCount = cached && before && after && after.identity === before.identity
        && after.size === before.size + Buffer.byteLength(line, 'utf8') + 1
        ? { ...cached, lines: cached.lines + line.split('\n').filter(part => part.length > 0).length, snapshot: after }
        : undefined;
    return applyAutomaticAggregateRetention(filePath, maxLines, appendedCount);
}

export function appendAggregateEventSync(
    allTasksPath: string,
    aggregateLockPath: string,
    line: string,
    maxLines: unknown,
    lockOptions: LockOptions = {}
): AggregateRetentionApplyResult {
    const resolvedMaxLines = toNonNegativeInteger(maxLines, DEFAULT_AGGREGATE_MAX_LINES);
    const lockResult = withFilesystemLock(
        aggregateLockPath,
        lockOptions,
        () => appendAggregateLine(allTasksPath, line, resolvedMaxLines)
    );

    const retention = lockResult.result ?? undefined;
    return {
        appendMode: retention ? 'locked_prune' : 'locked',
        retention,
        telemetry: lockResult.telemetry
    };
}

export async function appendAggregateEventAsync(
    allTasksPath: string,
    aggregateLockPath: string,
    line: string,
    maxLines: unknown,
    lockOptions: LockOptions = {}
): Promise<AggregateRetentionApplyResult> {
    const resolvedMaxLines = toNonNegativeInteger(maxLines, DEFAULT_AGGREGATE_MAX_LINES);
    const lockResult = await withFilesystemLockAsync(
        aggregateLockPath,
        lockOptions,
        async () => appendAggregateLine(allTasksPath, line, resolvedMaxLines)
    );

    const retention = lockResult.result ?? undefined;
    return {
        appendMode: retention ? 'locked_prune' : 'locked',
        retention,
        telemetry: lockResult.telemetry
    };
}

export function applyAggregateRetentionSync(
    allTasksPath: string,
    aggregateLockPath: string,
    maxLines: unknown,
    lockOptions: LockOptions = {}
): AggregateRetentionApplyResult {
    const resolvedMaxLines = toNonNegativeInteger(maxLines, DEFAULT_AGGREGATE_MAX_LINES);
    if (resolvedMaxLines <= 0) {
        return { appendMode: 'lock_free' };
    }

    if (!isAggregateAboveSizeTrigger(allTasksPath, resolvedMaxLines)) {
        return { appendMode: 'lock_free' };
    }

    const lockResult = withFilesystemLock(aggregateLockPath, lockOptions, () => applyAutomaticAggregateRetention(allTasksPath, resolvedMaxLines));
    return {
        appendMode: lockResult.result ? 'locked_prune' : 'locked',
        retention: lockResult.result ?? undefined,
        telemetry: lockResult.telemetry
    };
}

export async function applyAggregateRetentionAsync(
    allTasksPath: string,
    aggregateLockPath: string,
    maxLines: unknown,
    lockOptions: LockOptions = {}
): Promise<AggregateRetentionApplyResult> {
    const resolvedMaxLines = toNonNegativeInteger(maxLines, DEFAULT_AGGREGATE_MAX_LINES);
    if (resolvedMaxLines <= 0) {
        return { appendMode: 'lock_free' };
    }

    if (!isAggregateAboveSizeTrigger(allTasksPath, resolvedMaxLines)) {
        return { appendMode: 'lock_free' };
    }

    const lockResult = await withFilesystemLockAsync(aggregateLockPath, lockOptions, async () => applyAutomaticAggregateRetention(allTasksPath, resolvedMaxLines));
    return {
        appendMode: lockResult.result ? 'locked_prune' : 'locked',
        retention: lockResult.result ?? undefined,
        telemetry: lockResult.telemetry
    };
}
