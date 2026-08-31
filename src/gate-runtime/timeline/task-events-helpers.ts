import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { assertCanonicalTaskId } from '../../core/task-ids';
import { stringSha256 } from '../hash';
import {
    assertTaskTimelineReadSnapshotCurrent,
    captureTaskTimelineReadSnapshotSha256,
    createTaskTimelineMemoizationKey,
    isTaskTimelineReadSnapshotActive,
    MAX_TASK_TIMELINE_SNAPSHOT_BYTES,
    memoizeTaskTimelineSnapshot,
    withTaskTimelineFileReadSnapshot
} from './task-timeline-read-snapshot';
const JSONL_READ_CHUNK_SIZE = 64 * 1024;
export const MAX_TASK_TIMELINE_JSONL_LINES = 100_000;
export const MAX_TASK_TIMELINE_JSON_CONTAINERS = 300_000;
export const MAX_TASK_TIMELINE_JSON_DEPTH = 256;
export const MAX_TASK_TIMELINE_JSON_RECORD_BYTES = 4 * 1024 * 1024;
export const MAX_TASK_TIMELINE_JSON_STRUCTURAL_TOKENS = 500_000;
export const LEGACY_TASK_EVENT_INTEGRITY_SCHEMA_VERSION = 1;
export const TASK_EVENT_INTEGRITY_SCHEMA_VERSION = 2;

export interface TaskTimelineJsonlEntry {
    readonly rawLine: string;
    readonly lineNumber: number;
    readonly record: Readonly<Record<string, unknown>> | null;
}

interface TaskTimelineJsonlLines {
    lineCount: number;
    entries: Array<{ rawLine: string; lineNumber: number }>;
}

interface TaskTimelineParsedJsonlEntries {
    lineCount: number;
    entries: readonly TaskTimelineJsonlEntry[];
    containerCount: number;
    structuralTokenCount: number;
}

const PARSED_JSONL_ENTRIES_MEMOIZATION_KEY = createTaskTimelineMemoizationKey<
    TaskTimelineParsedJsonlEntries
>('parsed-jsonl-entries');
const JSONL_LINES_MEMOIZATION_KEY = createTaskTimelineMemoizationKey<TaskTimelineJsonlLines>('jsonl-lines');

interface TaskTimelineJsonStructureBudget {
    containerCount: number;
    structuralTokenCount: number;
}

function assertTaskTimelineJsonStructure(
    rawLine: string,
    budget: TaskTimelineJsonStructureBudget
): void {
    const byteLength = Buffer.byteLength(rawLine, 'utf8');
    if (byteLength > MAX_TASK_TIMELINE_JSON_RECORD_BYTES) {
        throw new Error(
            `Task timeline JSON record exceeds the ${MAX_TASK_TIMELINE_JSON_RECORD_BYTES} byte limit.`
        );
    }
    const containers: number[] = [];
    let inString = false;
    let escaped = false;
    for (let index = 0; index < rawLine.length; index += 1) {
        const code = rawLine.charCodeAt(index);
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (code === 0x5C) {
                escaped = true;
            } else if (code === 0x22) {
                inString = false;
            }
            continue;
        }
        if (code === 0x22) {
            inString = true;
            continue;
        }
        if (code === 0x7B || code === 0x5B) {
            containers.push(code);
            budget.containerCount += 1;
            budget.structuralTokenCount += 1;
            if (containers.length > MAX_TASK_TIMELINE_JSON_DEPTH) {
                throw new Error(
                    `Task timeline JSON exceeds the ${MAX_TASK_TIMELINE_JSON_DEPTH} level depth limit.`
                );
            }
            if (budget.containerCount > MAX_TASK_TIMELINE_JSON_CONTAINERS) {
                throw new Error(
                    `Task timeline JSON exceeds the ${MAX_TASK_TIMELINE_JSON_CONTAINERS} container limit.`
                );
            }
        } else if (code === 0x7D || code === 0x5D) {
            const expectedOpen = code === 0x7D ? 0x7B : 0x5B;
            if (containers[containers.length - 1] !== expectedOpen) {
                return;
            }
            containers.pop();
        } else if (code === 0x2C || code === 0x3A) {
            budget.structuralTokenCount += 1;
        }
        if (budget.structuralTokenCount > MAX_TASK_TIMELINE_JSON_STRUCTURAL_TOKENS) {
            throw new Error(
                'Task timeline JSON exceeds the '
                + `${MAX_TASK_TIMELINE_JSON_STRUCTURAL_TOKENS} structural token limit.`
            );
        }
    }
}

function parseTaskTimelineJsonObject(rawLine: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(rawLine) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

export function parseTaskTimelineJsonObjectLine(rawLine: string): Record<string, unknown> | null {
    const structureBudget: TaskTimelineJsonStructureBudget = {
        containerCount: 0,
        structuralTokenCount: 0
    };
    assertTaskTimelineJsonStructure(rawLine, structureBudget);
    return parseTaskTimelineJsonObject(rawLine);
}

function parseTaskTimelineJsonlEntry(
    rawLine: string,
    lineNumber: number,
    structureBudget: TaskTimelineJsonStructureBudget
): TaskTimelineJsonlEntry {
    assertTaskTimelineJsonStructure(rawLine, structureBudget);
    return { rawLine, lineNumber, record: parseTaskTimelineJsonObject(rawLine) };
}

function splitTaskTimelineJsonlLines(content: string): string[] {
    let newlineCount = 0;
    for (let index = 0; index < content.length; index += 1) {
        if (content.charCodeAt(index) === 0x0A) {
            newlineCount += 1;
            if (newlineCount > MAX_TASK_TIMELINE_JSONL_LINES) {
                throw new Error(
                    `Task timeline exceeds the ${MAX_TASK_TIMELINE_JSONL_LINES} line limit.`
                );
            }
        }
    }
    const rawLines = content.split('\n');
    if (rawLines.length > 0 && !rawLines[rawLines.length - 1].trim()) {
        rawLines.pop();
    }
    if (rawLines.length > MAX_TASK_TIMELINE_JSONL_LINES) {
        throw new Error(`Task timeline exceeds the ${MAX_TASK_TIMELINE_JSONL_LINES} line limit.`);
    }
    return rawLines;
}

function buildTaskTimelineJsonlEntries(content: string): TaskTimelineParsedJsonlEntries {
    const rawLines = splitTaskTimelineJsonlLines(content);
    const entries: TaskTimelineJsonlEntry[] = [];
    const structureBudget: TaskTimelineJsonStructureBudget = {
        containerCount: 0,
        structuralTokenCount: 0
    };
    for (let index = 0; index < rawLines.length; index += 1) {
        const rawLine = rawLines[index];
        if (rawLine.trim()) {
            entries.push(parseTaskTimelineJsonlEntry(rawLine, index + 1, structureBudget));
        }
    }
    return {
        lineCount: rawLines.length,
        entries,
        containerCount: structureBudget.containerCount,
        structuralTokenCount: structureBudget.structuralTokenCount
    };
}

export function assertTaskTimelineJsonlAppendWithinLimits(
    filePath: string,
    rawLine: string
): void {
    if (!isTaskTimelineReadSnapshotActive(filePath)) {
        return withTaskTimelineFileReadSnapshot(filePath, () => (
            assertTaskTimelineJsonlAppendWithinLimits(filePath, rawLine)
        ));
    }
    if (rawLine.includes('\n') || rawLine.includes('\r')) {
        throw new Error('Task timeline append must contain exactly one JSONL record.');
    }

    const memoized = memoizeTaskTimelineSnapshot(
        filePath,
        PARSED_JSONL_ENTRIES_MEMOIZATION_KEY,
        'default',
        buildTaskTimelineJsonlEntries,
        MAX_TASK_TIMELINE_SNAPSHOT_BYTES
    );
    if (!memoized.active || !memoized.valid) {
        throw new Error(`Task timeline snapshot changed while reading: ${filePath}`);
    }

    const existing = memoized.exists ? memoized.value : null;
    const existingLineCount = existing?.lineCount || 0;
    if (existingLineCount >= MAX_TASK_TIMELINE_JSONL_LINES) {
        throw new Error(`Task timeline exceeds the ${MAX_TASK_TIMELINE_JSONL_LINES} line limit.`);
    }
    const structureBudget: TaskTimelineJsonStructureBudget = {
        containerCount: existing?.containerCount || 0,
        structuralTokenCount: existing?.structuralTokenCount || 0
    };
    assertTaskTimelineJsonStructure(rawLine, structureBudget);
    if (!parseTaskTimelineJsonObject(rawLine)) {
        throw new Error('Task timeline append must be a valid JSON object record.');
    }
}

function buildTaskTimelineJsonlLines(content: string): TaskTimelineJsonlLines {
    const rawLines = splitTaskTimelineJsonlLines(content);
    const entries: TaskTimelineJsonlLines['entries'] = [];
    for (let index = 0; index < rawLines.length; index += 1) {
        const rawLine = rawLines[index];
        if (rawLine.trim()) {
            entries.push({ rawLine, lineNumber: index + 1 });
        }
    }
    return {
        lineCount: rawLines.length,
        entries
    };
}

function normalizeTaskTimelineReadLimit(maxBytes: number): number {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error('maxBytes must be a positive safe integer.');
    }
    return maxBytes;
}

export function readTaskTimelineJsonlEntries(filePath: string): readonly TaskTimelineJsonlEntry[] {
    if (!isTaskTimelineReadSnapshotActive(filePath)) {
        return withTaskTimelineFileReadSnapshot(filePath, () => readTaskTimelineJsonlEntries(filePath));
    }
    const memoized = memoizeTaskTimelineSnapshot(
        filePath,
        PARSED_JSONL_ENTRIES_MEMOIZATION_KEY,
        'default',
        buildTaskTimelineJsonlEntries,
        MAX_TASK_TIMELINE_SNAPSHOT_BYTES
    );
    if (memoized.active) {
        if (!memoized.valid) {
            throw new Error(`Task timeline snapshot changed while reading: ${filePath}`);
        }
        return memoized.exists && memoized.value ? memoized.value.entries : [];
    }

    const entries: TaskTimelineJsonlEntry[] = [];
    const structureBudget: TaskTimelineJsonStructureBudget = {
        containerCount: 0,
        structuralTokenCount: 0
    };
    forEachJsonlLine(filePath, (rawLine, lineNumber) => {
        entries.push(parseTaskTimelineJsonlEntry(rawLine, lineNumber, structureBudget));
    }, MAX_TASK_TIMELINE_SNAPSHOT_BYTES);
    return entries;
}

export function forEachTaskTimelineJsonlEntry(
    filePath: string,
    callback: (entry: TaskTimelineJsonlEntry) => void | false,
    maxBytes = MAX_TASK_TIMELINE_SNAPSHOT_BYTES
): number {
    if (!isTaskTimelineReadSnapshotActive(filePath)) {
        return withTaskTimelineFileReadSnapshot(filePath, () => (
            forEachTaskTimelineJsonlEntry(filePath, callback, maxBytes)
        ));
    }
    const normalizedMaxBytes = normalizeTaskTimelineReadLimit(maxBytes);
    const memoized = memoizeTaskTimelineSnapshot(
        filePath,
        PARSED_JSONL_ENTRIES_MEMOIZATION_KEY,
        'default',
        buildTaskTimelineJsonlEntries,
        normalizedMaxBytes
    );
    if (memoized.active) {
        if (!memoized.valid) {
            throw new Error(`Task timeline snapshot changed while reading: ${filePath}`);
        }
        if (!memoized.exists || !memoized.value) {
            return 0;
        }
        const expectedSha256 = captureTaskTimelineReadSnapshotSha256(filePath);
        let visitedLineCount = 0;
        for (const entry of memoized.value.entries) {
            visitedLineCount = entry.lineNumber;
            if (callback(entry) === false) {
                assertTaskTimelineReadSnapshotCurrent(filePath, expectedSha256);
                return visitedLineCount;
            }
        }
        assertTaskTimelineReadSnapshotCurrent(filePath, expectedSha256);
        return memoized.value.lineCount;
    }

    const structureBudget: TaskTimelineJsonStructureBudget = {
        containerCount: 0,
        structuralTokenCount: 0
    };
    return forEachJsonlLine(filePath, (rawLine, lineNumber) => (
        callback(parseTaskTimelineJsonlEntry(rawLine, lineNumber, structureBudget))
    ), normalizedMaxBytes);
}

export function toTrimmedString(value: unknown): string {
    return value ? String(value).trim() : '';
}

export function toTrimmedLowerCaseString(value: unknown): string {
    return value ? String(value).trim().toLowerCase() : '';
}

export function assertValidTaskId(value: unknown): string {
    return assertCanonicalTaskId(value);
}

function copyEnumerableRecord(
    source: Readonly<Record<string, unknown>>,
    excludedKey?: string
): Record<string, unknown> {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
        if (key === excludedKey) {
            continue;
        }
        Object.defineProperty(copy, key, {
            configurable: true,
            enumerable: true,
            value: source[key],
            writable: true
        });
    }
    return copy;
}

export function buildEventIntegrityHash(eventObj: Readonly<Record<string, unknown>>): string | null {
    const normalizedEvent = copyEnumerableRecord(eventObj);
    const integrity = normalizedEvent.integrity;
    let integritySchemaVersion: unknown;
    if (integrity && typeof integrity === 'object') {
        const normalizedIntegrity = copyEnumerableRecord(
            integrity as Readonly<Record<string, unknown>>,
            'event_sha256'
        );
        integritySchemaVersion = normalizedIntegrity.schema_version;
        normalizedEvent.integrity = normalizedIntegrity;
    }

    const canonicalPayload = JSON.stringify(normalizeIntegrityHashValue(
        normalizedEvent,
        integritySchemaVersion === LEGACY_TASK_EVENT_INTEGRITY_SCHEMA_VERSION
    ));
    return stringSha256(canonicalPayload);
}

export function forEachJsonlLine(
    filePath: string,
    callback: (line: string, lineNumber: number) => void | false,
    maxBytes?: number
): number {
    if (!isTaskTimelineReadSnapshotActive(filePath)) {
        return withTaskTimelineFileReadSnapshot(filePath, () => (
            forEachJsonlLine(filePath, callback, maxBytes)
        ));
    }
    const normalizedMaxBytes = maxBytes == null ? null : normalizeTaskTimelineReadLimit(maxBytes);
    const memoized = memoizeTaskTimelineSnapshot(
        filePath,
        JSONL_LINES_MEMOIZATION_KEY,
        'default',
        buildTaskTimelineJsonlLines,
        normalizedMaxBytes ?? undefined
    );
    if (memoized.active) {
        if (!memoized.valid) {
            throw new Error(`Task timeline snapshot changed while reading: ${filePath}`);
        }
        if (!memoized.exists || !memoized.value) {
            return 0;
        }
        const expectedSha256 = captureTaskTimelineReadSnapshotSha256(filePath);
        let visitedLineCount = 0;
        for (const entry of memoized.value.entries) {
            visitedLineCount = entry.lineNumber;
            if (callback(entry.rawLine, entry.lineNumber) === false) {
                assertTaskTimelineReadSnapshotCurrent(filePath, expectedSha256);
                return visitedLineCount;
            }
        }
        assertTaskTimelineReadSnapshotCurrent(filePath, expectedSha256);
        return memoized.value.lineCount;
    }

    let fd: number | null = null;
    try {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(filePath);
        } catch {
            return 0;
        }
        if (!stat.isFile() || stat.size === 0) {
            return 0;
        }
        if (normalizedMaxBytes != null && stat.size > normalizedMaxBytes) {
            throw new Error(`Task timeline exceeds the ${normalizedMaxBytes} byte read limit: ${filePath}`);
        }

        fd = fs.openSync(filePath, 'r');
        const fileSize = stat.size;
        const buf = Buffer.alloc(Math.min(JSONL_READ_CHUNK_SIZE, fileSize));
        const decoder = new StringDecoder('utf8');
        let offset = 0;
        let remainder = '';
        let lineIndex = 0;
        let stopped = false;

        while (offset < fileSize && !stopped) {
            const toRead = Math.min(buf.length, fileSize - offset);
            const bytesRead = fs.readSync(fd, buf, 0, toRead, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;

            const decoded = decoder.write(buf.subarray(0, bytesRead));
            const chunk = remainder + decoded;
            const lines = chunk.split('\n');
            remainder = lines.pop() || '';

            for (const rawLine of lines) {
                lineIndex++;
                if (!rawLine.trim()) continue;
                if (callback(rawLine, lineIndex) === false) {
                    stopped = true;
                    break;
                }
            }
        }

        if (!stopped) {
            const flushed = decoder.end();
            if (flushed) {
                remainder += flushed;
            }
        }

        if (!stopped && remainder.trim()) {
            lineIndex++;
            callback(remainder, lineIndex);
        }

        return lineIndex;
    } finally {
        if (fd != null) {
            try { fs.closeSync(fd); } catch { /* best-effort */ }
        }
    }
}

function normalizeIntegrityHashValue(value: unknown, normalizeLegacyPathSeparators: boolean): unknown {
    if (value == null) {
        return value;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (Array.isArray(value)) {
        return value.map((entry) => normalizeIntegrityHashValue(entry, normalizeLegacyPathSeparators));
    }

    if (typeof value === 'object') {
        const sorted: Record<string, unknown> = {};
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        for (const key of keys) {
            Object.defineProperty(sorted, key, {
                configurable: true,
                enumerable: true,
                value: normalizeIntegrityHashValue(obj[key], normalizeLegacyPathSeparators),
                writable: true
            });
        }
        return sorted;
    }

    if (normalizeLegacyPathSeparators && typeof value === 'string' && value.includes('\\')) {
        return value.replace(/\\/g, '/');
    }

    return value;
}
