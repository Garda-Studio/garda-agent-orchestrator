import * as fs from 'node:fs';

export interface BoundedJsonlTailLimits {
    maxBytes: number;
    maxLines: number;
    maxEvents: number;
    maxParseAttempts: number;
}

export interface BoundedJsonlTailResult<T> {
    records: T[];
    truncated: boolean;
    invalidJson: boolean;
    bytesRead: number;
    retainedLineCount: number;
    parseAttempts: number;
    limits: BoundedJsonlTailLimits;
}

function positiveInteger(value: number, name: keyof BoundedJsonlTailLimits): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive safe integer.`);
    }
    return value;
}

export function normalizeBoundedJsonlTailLimits(
    limits: BoundedJsonlTailLimits
): BoundedJsonlTailLimits {
    return {
        maxBytes: positiveInteger(limits.maxBytes, 'maxBytes'),
        maxLines: positiveInteger(limits.maxLines, 'maxLines'),
        maxEvents: positiveInteger(limits.maxEvents, 'maxEvents'),
        maxParseAttempts: positiveInteger(limits.maxParseAttempts, 'maxParseAttempts')
    };
}

function normalizeTotalSize(totalSize: number, sourceLength: number): number {
    if (!Number.isSafeInteger(totalSize) || totalSize < sourceLength) {
        throw new Error('totalSize must be a non-negative safe integer not smaller than the source buffer.');
    }
    return totalSize;
}

export function readBoundedJsonlTail<T>(
    filePath: string,
    requestedLimits: BoundedJsonlTailLimits
): BoundedJsonlTailResult<T> {
    const limits = normalizeBoundedJsonlTailLimits(requestedLimits);
    const stats = fs.statSync(filePath);
    const bytesRead = Math.min(stats.size, limits.maxBytes);
    const start = Math.max(0, stats.size - bytesRead);
    const buffer = Buffer.alloc(bytesRead);
    const handle = fs.openSync(filePath, 'r');
    try {
        let offset = 0;
        while (offset < bytesRead) {
            const chunkSize = fs.readSync(
                handle,
                buffer,
                offset,
                bytesRead - offset,
                start + offset
            );
            if (chunkSize <= 0) {
                throw new Error(`Bounded JSONL tail changed while reading: ${filePath}`);
            }
            offset += chunkSize;
        }
    } finally {
        fs.closeSync(handle);
    }

    return readBoundedJsonlTailBuffer(buffer, stats.size, limits);
}

export function readBoundedJsonlTailBuffer<T>(
    source: Buffer,
    totalSize: number,
    requestedLimits: BoundedJsonlTailLimits
): BoundedJsonlTailResult<T> {
    const limits = normalizeBoundedJsonlTailLimits(requestedLimits);
    const normalizedTotalSize = normalizeTotalSize(totalSize, source.length);
    const bytesRead = Math.min(source.length, limits.maxBytes);
    const start = Math.max(0, source.length - bytesRead);
    const buffer = source.subarray(start);

    let text = buffer.toString('utf8');
    const sourceStart = normalizedTotalSize - bytesRead;
    let truncated = sourceStart > 0;
    if (sourceStart > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    let lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    if (lines.length > limits.maxLines) {
        truncated = true;
        lines = lines.slice(-limits.maxLines);
    }

    const recordsNewestFirst: T[] = [];
    let parseAttempts = 0;
    let invalidJson = false;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (recordsNewestFirst.length >= limits.maxEvents || parseAttempts >= limits.maxParseAttempts) {
            truncated = true;
            break;
        }
        parseAttempts += 1;
        try {
            recordsNewestFirst.push(JSON.parse(lines[index]) as T);
        } catch {
            invalidJson = true;
            break;
        }
    }

    return {
        records: recordsNewestFirst.reverse(),
        truncated,
        invalidJson,
        bytesRead,
        retainedLineCount: lines.length,
        parseAttempts,
        limits
    };
}
