import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
    readBoundedJsonlTail,
    readBoundedJsonlTailBuffer
} from '../../../src/core/bounded-jsonl-tail';

const TEST_LIMITS = {
    maxBytes: 1024,
    maxLines: 8,
    maxEvents: 8,
    maxParseAttempts: 8
};

test('readBoundedJsonlTailBuffer rejects inconsistent total-size metadata', () => {
    const source = Buffer.from('{"sequence":1}\n', 'utf8');
    for (const invalidTotalSize of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, source.length - 1]) {
        assert.throws(
            () => readBoundedJsonlTailBuffer(source, invalidTotalSize, TEST_LIMITS),
            /totalSize must be a non-negative safe integer not smaller than the source buffer/
        );
    }

    const result = readBoundedJsonlTailBuffer<{ sequence: number }>(source, source.length, TEST_LIMITS);
    assert.deepEqual(result.records, [{ sequence: 1 }]);
    assert.equal(result.truncated, false);
});

test('readBoundedJsonlTailBuffer reconstructs a valid retained tail from a larger source', () => {
    const retainedTail = Buffer.from('partial-record\n{"sequence":2}\n', 'utf8');
    const result = readBoundedJsonlTailBuffer<{ sequence: number }>(
        retainedTail,
        retainedTail.length + 4096,
        TEST_LIMITS
    );

    assert.deepEqual(result.records, [{ sequence: 2 }]);
    assert.equal(result.truncated, true);
    assert.equal(result.invalidJson, false);
    assert.equal(result.bytesRead, retainedTail.length);
});

test('readBoundedJsonlTailBuffer rejects non-safe integer limits', () => {
    const source = Buffer.from('{"sequence":1}\n', 'utf8');
    for (const limitName of Object.keys(TEST_LIMITS) as Array<keyof typeof TEST_LIMITS>) {
        assert.throws(
            () => readBoundedJsonlTailBuffer(source, source.length, {
                ...TEST_LIMITS,
                [limitName]: Number.MAX_SAFE_INTEGER + 1
            }),
            new RegExp(`${limitName} must be a positive safe integer`)
        );
    }
});

test('readBoundedJsonlTail retains only the newest bounded records', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-bounded-jsonl-tail-'));
    try {
        const filePath = path.join(root, 'events.jsonl');
        fs.writeFileSync(
            filePath,
            Array.from({ length: 8 }, (_, index) => JSON.stringify({ sequence: index + 1 })).join('\n') + '\n',
            'utf8'
        );

        const result = readBoundedJsonlTail<{ sequence: number }>(filePath, {
            maxBytes: 1024,
            maxLines: 4,
            maxEvents: 2,
            maxParseAttempts: 3
        });

        assert.deepEqual(result.records.map((event) => event.sequence), [7, 8]);
        assert.equal(result.truncated, true);
        assert.equal(result.invalidJson, false);
        assert.equal(result.retainedLineCount, 4);
        assert.equal(result.parseAttempts, 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('readBoundedJsonlTail completes valid short descriptor reads', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-bounded-jsonl-short-read-'));
    const fsModule = require('node:fs') as typeof fs;
    const originalReadSync = fsModule.readSync;
    let readCalls = 0;
    try {
        const filePath = path.join(root, 'events.jsonl');
        fs.writeFileSync(
            filePath,
            Array.from({ length: 4 }, (_, index) => JSON.stringify({ sequence: index + 1 })).join('\n') + '\n',
            'utf8'
        );
        fsModule.readSync = ((
            fileDescriptor: number,
            buffer: NodeJS.ArrayBufferView,
            offset: number,
            length: number,
            position: number | null
        ) => {
            readCalls += 1;
            return originalReadSync(
                fileDescriptor,
                buffer,
                offset,
                Math.max(1, Math.ceil(length / 2)),
                position
            );
        }) as typeof fsModule.readSync;

        const result = readBoundedJsonlTail<{ sequence: number }>(filePath, TEST_LIMITS);
        assert.deepEqual(result.records.map((event) => event.sequence), [1, 2, 3, 4]);
        assert.ok(readCalls > 1);
    } finally {
        fsModule.readSync = originalReadSync;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('readBoundedJsonlTail enforces the parse-attempt ceiling independently of the event ceiling', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-bounded-jsonl-parse-limit-'));
    try {
        const filePath = path.join(root, 'events.jsonl');
        fs.writeFileSync(
            filePath,
            Array.from({ length: 6 }, (_, index) => JSON.stringify({ sequence: index + 1 })).join('\n') + '\n',
            'utf8'
        );

        const result = readBoundedJsonlTail<{ sequence: number }>(filePath, {
            maxBytes: 1024,
            maxLines: 6,
            maxEvents: 6,
            maxParseAttempts: 2
        });

        assert.deepEqual(result.records.map((event) => event.sequence), [5, 6]);
        assert.equal(result.truncated, true);
        assert.equal(result.invalidJson, false);
        assert.equal(result.parseAttempts, 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('readBoundedJsonlTail stops at malformed retained JSON instead of scanning unbounded input', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-bounded-jsonl-invalid-'));
    try {
        const filePath = path.join(root, 'events.jsonl');
        fs.writeFileSync(filePath, '{"sequence":1}\n{"sequence":\n{"sequence":3}\n', 'utf8');

        const result = readBoundedJsonlTail<{ sequence: number }>(filePath, {
            maxBytes: 1024,
            maxLines: 8,
            maxEvents: 8,
            maxParseAttempts: 8
        });

        assert.equal(result.invalidJson, true);
        assert.equal(result.parseAttempts, 2);
        assert.deepEqual(result.records.map((event) => event.sequence), [3]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
