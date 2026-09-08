import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    appendTaskEvent,
    forEachJsonlLine,
    inspectTaskEventFile,
    MAX_TASK_TIMELINE_SNAPSHOT_BYTES,
    readTaskEventAppendState,
    readTaskTimelineBoundedJsonlTail,
    readTaskTimelineFileMetadataSnapshot,
    readTaskTimelineFileSnapshot,
    readTaskTimelineJsonlEntries,
    readTaskTimelineTextFile,
    withTaskTimelineReadSnapshot
} from '../../../src/gate-runtime/timeline/task-events';
import {
    appendTaskTimelineLineSync,
    createTaskTimelineMemoizationKey,
    memoizeTaskTimelineSnapshot,
    taskTimelineAppendExceedsSnapshotLimit,
    windowsAclOutputHasExplicitWriteGrant
} from '../../../src/gate-runtime/timeline/task-timeline-read-snapshot';
import {
    assertTaskTimelineJsonlAppendWithinLimits,
    forEachTaskTimelineJsonlEntry,
    MAX_TASK_TIMELINE_JSON_DEPTH,
    MAX_TASK_TIMELINE_JSON_RECORD_BYTES,
    MAX_TASK_TIMELINE_JSON_STRUCTURAL_TOKENS,
    MAX_TASK_TIMELINE_JSONL_LINES
} from '../../../src/gate-runtime/timeline/task-events-helpers';

const mutableChildProcess = require('node:child_process') as typeof childProcess & {
    spawnSync: typeof childProcess.spawnSync;
};
const tempRoots: string[] = [];

function seedTimeline(taskId: string): { orchestratorRoot: string; eventsRoot: string; timelinePath: string } {
    const orchestratorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-snapshot-'));
    tempRoots.push(orchestratorRoot);
    for (let index = 0; index < 3; index += 1) {
        const result = appendTaskEvent(
            orchestratorRoot,
            taskId,
            'TEST_EVENT',
            'PASS',
            `Event ${index + 1}`,
            { index },
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(result?.commit_status, 'committed');
    }
    const eventsRoot = path.join(orchestratorRoot, 'runtime', 'task-events');
    return {
        orchestratorRoot,
        eventsRoot,
        timelinePath: path.join(eventsRoot, `${taskId}.jsonl`)
    };
}

test.afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('reuses one immutable timeline payload read inside an invocation and releases it afterward', () => {
    const taskId = 'T-SNAPSHOT-READ';
    const { eventsRoot, timelinePath } = seedTimeline(taskId);
    const fsModule = require('node:fs') as typeof fs;
    const originalReadSync = fsModule.readSync;
    const originalOpenSync = fsModule.openSync;
    let payloadReadCount = 0;
    let descriptorOpenCount = 0;
    fsModule.openSync = ((
        targetPath: fs.PathLike,
        flags: fs.OpenMode,
        mode?: fs.Mode
    ) => {
        if (path.resolve(String(targetPath)) === path.resolve(timelinePath)) {
            descriptorOpenCount += 1;
        }
        return originalOpenSync(targetPath, flags, mode);
    }) as typeof fsModule.openSync;
    fsModule.readSync = ((...args: unknown[]) => {
        payloadReadCount += 1;
        return Reflect.apply(originalReadSync, fsModule, args) as number;
    }) as typeof fsModule.readSync;

    try {
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            const firstText = readTaskTimelineTextFile(timelinePath);
            assert.equal(readTaskTimelineTextFile(timelinePath), firstText);
            const fileSnapshot = readTaskTimelineFileSnapshot(timelinePath);
            assert.equal(fileSnapshot.active, true);
            assert.equal(fileSnapshot.valid, true);
            assert.equal(fileSnapshot.exists, true);
            assert.match(fileSnapshot.sha256 || '', /^[0-9a-f]{64}$/);
            const metadataSnapshot = readTaskTimelineFileMetadataSnapshot(timelinePath);
            assert.equal(metadataSnapshot.active, true);
            assert.equal(metadataSnapshot.valid, true);
            assert.equal(metadataSnapshot.exists, true);
            assert.equal(metadataSnapshot.sha256, fileSnapshot.sha256);
            assert.equal(Object.prototype.hasOwnProperty.call(metadataSnapshot, 'content'), false);

            const firstParsedEntries = readTaskTimelineJsonlEntries(timelinePath);
            const secondParsedEntries = readTaskTimelineJsonlEntries(timelinePath);
            assert.strictEqual(secondParsedEntries, firstParsedEntries);
            assert.equal(firstParsedEntries.length, 3);
            assert.strictEqual(secondParsedEntries[0].record, firstParsedEntries[0].record);
            assert.equal(Object.isFrozen(firstParsedEntries), true);
            assert.equal(Object.isFrozen(firstParsedEntries[0].record), true);
            assert.equal(inspectTaskEventFile(timelinePath, taskId).status, 'PASS');
            assert.equal(inspectTaskEventFile(timelinePath, taskId).status, 'PASS');

            const bounded = readTaskTimelineBoundedJsonlTail<Record<string, unknown>>(timelinePath, {
                maxBytes: 1024 * 1024,
                maxLines: 100,
                maxEvents: 100,
                maxParseAttempts: 100
            });
            assert.equal(bounded.records.length, 3);
            assert.equal(Object.isFrozen(bounded.records[0]), false);
            bounded.records[0].caller_mutation = true;
            assert.equal(bounded.records[0].caller_mutation, true);

            const isolatedBounded = readTaskTimelineBoundedJsonlTail<Record<string, unknown>>(
                timelinePath,
                {
                    maxBytes: 1024 * 1024,
                    maxLines: 100,
                    maxEvents: 100,
                    maxParseAttempts: 100
                }
            );
            assert.equal(isolatedBounded.records[0].caller_mutation, undefined);
        });

        assert.equal(descriptorOpenCount, 1);
        assert.ok(payloadReadCount >= 1);
        const firstCaptureReadCalls = payloadReadCount;
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            assert.match(readTaskTimelineTextFile(timelinePath), /TEST_EVENT/);
        });
        assert.equal(descriptorOpenCount, 2);
        assert.ok(payloadReadCount > firstCaptureReadCalls);
    } finally {
        fsModule.openSync = originalOpenSync;
        fsModule.readSync = originalReadSync;
    }
});

test('completes one authenticated payload capture across valid short read syscalls', () => {
    const taskId = 'T-SNAPSHOT-SHORT-READ';
    const { eventsRoot, timelinePath } = seedTimeline(taskId);
    const fsModule = require('node:fs') as typeof fs;
    const originalReadSync = fsModule.readSync;
    const originalOpenSync = fsModule.openSync;
    let payloadReadCalls = 0;
    let timelineReadDescriptors = 0;

    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (flags === 'r' && path.resolve(String(targetPath)) === path.resolve(timelinePath)) {
            timelineReadDescriptors += 1;
        }
        return originalOpenSync(targetPath, flags, mode);
    }) as typeof fsModule.openSync;
    fsModule.readSync = ((
        fileDescriptor: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | null
    ) => {
        payloadReadCalls += 1;
        const shortLength = Math.max(1, Math.ceil(length / 2));
        return originalReadSync(fileDescriptor, buffer, offset, shortLength, position);
    }) as typeof fsModule.readSync;

    try {
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            assert.match(readTaskTimelineTextFile(timelinePath), /TEST_EVENT/);
            assert.match(readTaskTimelineTextFile(timelinePath), /TEST_EVENT/);
        });
        assert.equal(timelineReadDescriptors, 1);
        assert.ok(payloadReadCalls > 1);
    } finally {
        fsModule.openSync = originalOpenSync;
        fsModule.readSync = originalReadSync;
    }
});

test('rejects bounded-tail evidence when the timeline changes during parsing', () => {
    const taskId = 'T-SNAPSHOT-BOUNDED-MUTATION';
    const { timelinePath } = seedTimeline(taskId);
    let mutated = false;
    const limits = {
        maxBytes: 1024 * 1024,
        maxLines: 100,
        maxEvents: 100,
        maxParseAttempts: 100
    };
    const originalJsonParse = JSON.parse;
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
        if (!mutated) {
            mutated = true;
            fs.appendFileSync(timelinePath, '\n', 'utf8');
        }
        return Reflect.apply(originalJsonParse, JSON, args) as unknown;
    }) as typeof JSON.parse;

    try {
        assert.throws(
            () => readTaskTimelineBoundedJsonlTail(timelinePath, limits),
            /snapshot changed while reading/
        );
        assert.equal(mutated, true);
    } finally {
        JSON.parse = originalJsonParse;
    }
});

test('reads only the requested authenticated tail when no full snapshot is active', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-bounded-direct-'));
    tempRoots.push(root);
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const taskId = 'T-BOUNDED-DIRECT';
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const content = Array.from(
        { length: 8192 },
        (_, index) => JSON.stringify({ task_id: taskId, sequence: index, payload: 'x'.repeat(64) })
    ).join('\n') + '\n';
    fs.writeFileSync(timelinePath, content, 'utf8');

    const fsModule = require('node:fs') as typeof fs;
    const originalOpenSync = fsModule.openSync;
    const originalReadSync = fsModule.readSync;
    let timelineDescriptor: number | null = null;
    let largestRequestedRead = 0;
    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const descriptor = originalOpenSync(targetPath, flags, mode);
        if (flags === 'r' && path.resolve(String(targetPath)) === path.resolve(timelinePath)) {
            timelineDescriptor = descriptor;
        }
        return descriptor;
    }) as typeof fsModule.openSync;
    fsModule.readSync = ((
        fileDescriptor: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | null
    ) => {
        if (fileDescriptor === timelineDescriptor) {
            largestRequestedRead = Math.max(largestRequestedRead, length);
        }
        return originalReadSync(fileDescriptor, buffer, offset, length, position);
    }) as typeof fsModule.readSync;

    try {
        const result = readTaskTimelineBoundedJsonlTail<Record<string, unknown>>(timelinePath, {
            maxBytes: 1024,
            maxLines: 16,
            maxEvents: 8,
            maxParseAttempts: 8
        });
        assert.equal(result.bytesRead, 1024);
        assert.ok(result.records.length > 0);
        assert.ok(largestRequestedRead <= 1024);
    } finally {
        fsModule.openSync = originalOpenSync;
        fsModule.readSync = originalReadSync;
    }
});

test('validates bounded-tail limits before consulting the active-snapshot cache', () => {
    const taskId = 'T-SNAPSHOT-BOUNDED-LIMIT-CACHE';
    const { eventsRoot, timelinePath } = seedTimeline(taskId);
    const validLimits = {
        maxBytes: 1024 * 1024,
        maxLines: 100,
        maxEvents: 100,
        maxParseAttempts: 100
    };

    withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        const primed = readTaskTimelineBoundedJsonlTail(timelinePath, validLimits);
        assert.equal(primed.records.length, 3);

        const deceptiveMaxBytes = {
            toString: () => String(validLimits.maxBytes)
        } as unknown as number;
        assert.throws(
            () => readTaskTimelineBoundedJsonlTail(timelinePath, {
                ...validLimits,
                maxBytes: deceptiveMaxBytes
            }),
            /maxBytes must be a positive safe integer/
        );
    });
});

test('validates bounded-tail limits before snapshot root or timeline I/O', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-limit-order-'));
    tempRoots.push(root);
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const timelinePath = path.join(eventsRoot, 'T-LIMIT-ORDER.jsonl');
    const fsModule = require('node:fs') as { lstatSync: typeof fs.lstatSync };
    const originalLstatSync = fsModule.lstatSync;
    let lstatCalls = 0;
    fsModule.lstatSync = ((targetPath: fs.PathLike) => {
        lstatCalls += 1;
        return originalLstatSync(targetPath);
    }) as typeof fsModule.lstatSync;

    try {
        assert.throws(
            () => readTaskTimelineBoundedJsonlTail(timelinePath, {
                maxBytes: 0,
                maxLines: 8,
                maxEvents: 8,
                maxParseAttempts: 8
            }),
            /maxBytes must be a positive safe integer/
        );
        assert.equal(lstatCalls, 0);
    } finally {
        fsModule.lstatSync = originalLstatSync;
    }
});

test('isolates memoized values by invariant typed keys instead of caller strings', () => {
    const taskId = 'T-SNAPSHOT-TYPED-MEMO';
    const { eventsRoot, timelinePath } = seedTimeline(taskId);
    const stringKey = createTaskTimelineMemoizationKey<string>('same-description');
    const numberKey = createTaskTimelineMemoizationKey<number>('same-description');
    let stringBuildCount = 0;
    let numberBuildCount = 0;

    withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        const firstString = memoizeTaskTimelineSnapshot(timelinePath, stringKey, 'same-entry', () => {
            stringBuildCount += 1;
            return 'string-value';
        });
        const firstNumber = memoizeTaskTimelineSnapshot(timelinePath, numberKey, 'same-entry', () => {
            numberBuildCount += 1;
            return 42;
        });
        const secondString = memoizeTaskTimelineSnapshot(timelinePath, stringKey, 'same-entry', () => {
            stringBuildCount += 1;
            return 'unexpected';
        });

        assert.equal(firstString.value, 'string-value');
        assert.equal(firstNumber.value, 42);
        assert.equal(secondString.value, 'string-value');
        assert.equal(stringBuildCount, 1);
        assert.equal(numberBuildCount, 1);
    });
});

test('returns an invalid memoized result when nested work invalidates the snapshot during the build', () => {
    const taskId = 'T-SNAPSHOT-MEMO-INVALIDATION';
    const { eventsRoot, timelinePath } = seedTimeline(taskId);
    const memoKey = createTaskTimelineMemoizationKey<string>('nested-invalidation');

    withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        let nestedReadFailed = false;
        const result = memoizeTaskTimelineSnapshot(timelinePath, memoKey, 'default', () => {
            fs.appendFileSync(timelinePath, '\n', 'utf8');
            try {
                readTaskTimelineJsonlEntries(timelinePath);
            } catch {
                nestedReadFailed = true;
            }
            return 'must-not-escape';
        });

        assert.equal(nestedReadFailed, true);
        assert.equal(result.active, true);
        assert.equal(result.valid, false);
        assert.equal(result.value, null);
    });
});

test('reports the visited line count when snapshot iteration stops early', () => {
    const taskId = 'T-SNAPSHOT-EARLY-STOP';
    const { eventsRoot, timelinePath } = seedTimeline(taskId);
    const outsideSnapshotCount = forEachJsonlLine(timelinePath, () => false);
    assert.equal(outsideSnapshotCount, 1);

    withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        const insideSnapshotCount = forEachJsonlLine(timelinePath, () => false);
        assert.equal(insideSnapshotCount, outsideSnapshotCount);
    });
});

test('keeps entry iteration counts identical inside and outside a snapshot for blank lines', () => {
    const cases = [
        { suffix: 'TRAILING', content: '{"value":1}\n\n' },
        { suffix: 'BLANK-ONLY', content: '\n\n' }
    ];
    for (const testCase of cases) {
        const taskId = `T-SNAPSHOT-ENTRY-COUNT-${testCase.suffix}`;
        const orchestratorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-snapshot-'));
        tempRoots.push(orchestratorRoot);
        const eventsRoot = path.join(orchestratorRoot, 'runtime', 'task-events');
        const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
        fs.mkdirSync(eventsRoot, { recursive: true });
        fs.writeFileSync(timelinePath, testCase.content, 'utf8');

        const outsideCount = forEachTaskTimelineJsonlEntry(timelinePath, () => undefined);
        let insideCount = -1;
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            insideCount = forEachTaskTimelineJsonlEntry(timelinePath, () => undefined);
        });
        assert.equal(insideCount, outsideCount, testCase.suffix);
    }
});

test('enforces the same caller byte limit inside and outside a snapshot', () => {
    const taskId = 'T-SNAPSHOT-CALLER-BYTE-LIMIT';
    const { eventsRoot, timelinePath } = seedTimeline(taskId);
    const maxBytes = fs.statSync(timelinePath).size - 1;

    assert.throws(
        () => forEachJsonlLine(timelinePath, () => undefined, maxBytes),
        /exceeds the .* byte read limit/
    );
    withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        assert.throws(
            () => forEachJsonlLine(timelinePath, () => undefined, maxBytes),
            /exceeds the .* byte read limit/
        );
    });
});

test('fails closed when the timeline changes during an invocation and refreshes on the next invocation', () => {
    const taskId = 'T-SNAPSHOT-FRESHNESS';
    const { eventsRoot, timelinePath } = seedTimeline(taskId);
    const originalSize = fs.statSync(timelinePath).size;
    let failedClosedAfterExternalAppend = false;

    withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        assert.equal(Buffer.byteLength(readTaskTimelineTextFile(timelinePath)), originalSize);
        fs.appendFileSync(timelinePath, '\n', 'utf8');
        assert.throws(
            () => readTaskTimelineTextFile(timelinePath),
            /snapshot is unavailable/
        );
        const inspection = inspectTaskEventFile(timelinePath, taskId);
        assert.equal(inspection.status, 'FAILED');
        assert.match(inspection.violations.join(' '), /snapshot changed or became unavailable/);
        failedClosedAfterExternalAppend = true;
    });

    withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        assert.equal(Buffer.byteLength(readTaskTimelineTextFile(timelinePath)), originalSize + 1);
    });
    assert.equal(failedClosedAfterExternalAppend, true);
});

test('keeps the snapshot active until an asynchronous callback settles', async () => {
    const taskId = 'T-SNAPSHOT-ASYNC';
    const { eventsRoot, timelinePath } = seedTimeline(taskId);

    await withTaskTimelineReadSnapshot(eventsRoot, taskId, async () => {
        const firstText = readTaskTimelineTextFile(timelinePath);
        await Promise.resolve();
        const metadata = readTaskTimelineFileMetadataSnapshot(timelinePath);
        assert.equal(metadata.active, true);
        assert.equal(metadata.valid, true);
        assert.equal(readTaskTimelineTextFile(timelinePath), firstText);
    });

    assert.equal(readTaskTimelineFileMetadataSnapshot(timelinePath).active, false);
});

test('isolates overlapping asynchronous invocations for the same timeline', async () => {
    const taskId = 'T-SNAPSHOT-ASYNC-ISOLATION';
    const { orchestratorRoot, eventsRoot, timelinePath } = seedTimeline(taskId);
    let releaseFirst!: () => void;
    let signalFirstReady!: () => void;
    const firstReady = new Promise<void>((resolve) => {
        signalFirstReady = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });

    const firstInvocation = withTaskTimelineReadSnapshot(eventsRoot, taskId, async () => {
        readTaskTimelineTextFile(timelinePath);
        signalFirstReady();
        await firstRelease;
        assert.throws(
            () => readTaskTimelineTextFile(timelinePath),
            /snapshot is unavailable/
        );
    });
    await firstReady;

    await withTaskTimelineReadSnapshot(eventsRoot, taskId, async () => {
        const appendResult = appendTaskEvent(
            orchestratorRoot,
            taskId,
            'OVERLAPPING_INVOCATION_APPEND',
            'PASS',
            'Independent overlapping append',
            {},
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(appendResult?.commit_status, 'committed');
        assert.match(readTaskTimelineTextFile(timelinePath), /OVERLAPPING_INVOCATION_APPEND/);
    });

    releaseFirst();
    await firstInvocation;
});

test('rejects an oversized timeline before reading its payload', () => {
    const taskId = 'T-SNAPSHOT-SIZE-BOUND';
    const { eventsRoot, timelinePath } = seedTimeline(taskId);
    fs.truncateSync(timelinePath, MAX_TASK_TIMELINE_SNAPSHOT_BYTES + 1);
    const fsModule = require('node:fs') as typeof fs;
    const originalReadSync = fsModule.readSync;
    let payloadReadCount = 0;
    fsModule.readSync = ((...args: unknown[]) => {
        payloadReadCount += 1;
        return Reflect.apply(originalReadSync, fsModule, args) as number;
    }) as typeof fsModule.readSync;

    try {
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            const metadata = readTaskTimelineFileMetadataSnapshot(timelinePath);
            assert.equal(metadata.active, true);
            assert.equal(metadata.exists, false);
            assert.equal(metadata.valid, false);
            const inspection = inspectTaskEventFile(timelinePath, taskId);
            assert.equal(inspection.status, 'FAILED');
            assert.doesNotMatch(inspection.violations.join(' '), /file not found/);
        });
        assert.throws(
            () => readTaskTimelineTextFile(timelinePath),
            /exceeds the .* byte read limit/
        );
        assert.equal(payloadReadCount, 0);
    } finally {
        fsModule.readSync = originalReadSync;
    }
    assert.throws(
        () => readTaskTimelineJsonlEntries(timelinePath),
        /exceeds the .* byte read limit/
    );
    const directInspection = inspectTaskEventFile(timelinePath, taskId);
    assert.equal(directInspection.status, 'FAILED');
    assert.match(directInspection.violations.join(' '), /exceeds the .* byte read limit/);
    assert.doesNotMatch(directInspection.violations.join(' '), /file not found/);
});

test('rejects direct reads through a hard-linked timeline alias', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-direct-hard-link-'));
    tempRoots.push(root);
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const outsidePath = path.join(root, 'outside.jsonl');
    const timelinePath = path.join(eventsRoot, 'T-DIRECT-HARD-LINK.jsonl');
    fs.writeFileSync(outsidePath, '{"task_id":"T-DIRECT-HARD-LINK","event_type":"OUTSIDE"}\n', 'utf8');
    fs.linkSync(outsidePath, timelinePath);

    assert.throws(() => readTaskTimelineTextFile(timelinePath), /snapshot is unavailable/);
    assert.throws(
        () => readTaskTimelineBoundedJsonlTail(timelinePath, {
            maxBytes: 1024,
            maxLines: 8,
            maxEvents: 8,
            maxParseAttempts: 8
        }),
        /snapshot is unavailable/
    );
    assert.throws(() => forEachJsonlLine(timelinePath, () => undefined), /snapshot changed|snapshot is unavailable/);
    const inspection = inspectTaskEventFile(timelinePath, 'T-DIRECT-HARD-LINK');
    assert.equal(inspection.status, 'FAILED');
    assert.match(
        inspection.violations.join(' '),
        /snapshot (?:is unavailable|changed or became unavailable)/
    );
});

test('rejects newline-dense timelines before materializing unbounded line arrays', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-line-bound-'));
    tempRoots.push(root);
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const timelinePath = path.join(eventsRoot, 'T-LINE-BOUND.jsonl');
    fs.writeFileSync(timelinePath, ' \n'.repeat(MAX_TASK_TIMELINE_JSONL_LINES + 1), 'utf8');

    assert.throws(
        () => forEachTaskTimelineJsonlEntry(timelinePath, () => undefined),
        new RegExp(`${MAX_TASK_TIMELINE_JSONL_LINES} line limit`)
    );
    const inspection = inspectTaskEventFile(timelinePath, 'T-LINE-BOUND');
    assert.equal(inspection.status, 'FAILED');
    assert.match(inspection.violations.join(' '), /line limit/);
});

test('rejects oversized individual JSON records before parsing them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-record-bound-'));
    tempRoots.push(root);
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const timelinePath = path.join(eventsRoot, 'T-RECORD-BOUND.jsonl');
    const oversizedMessage = 'x'.repeat(MAX_TASK_TIMELINE_JSON_RECORD_BYTES);
    fs.writeFileSync(
        timelinePath,
        `${JSON.stringify({ task_id: 'T-RECORD-BOUND', message: oversizedMessage })}\n`,
        'utf8'
    );

    assert.throws(
        () => readTaskTimelineJsonlEntries(timelinePath),
        new RegExp(`${MAX_TASK_TIMELINE_JSON_RECORD_BYTES} byte limit`)
    );
});

test('rejects structurally dense JSON before materializing its value graph', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-token-bound-'));
    tempRoots.push(root);
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const timelinePath = path.join(eventsRoot, 'T-TOKEN-BOUND.jsonl');
    const denseArray = `[${'0,'.repeat(MAX_TASK_TIMELINE_JSON_STRUCTURAL_TOKENS)}0]`;
    fs.writeFileSync(
        timelinePath,
        `{"task_id":"T-TOKEN-BOUND","details":${denseArray}}\n`,
        'utf8'
    );

    assert.throws(
        () => readTaskTimelineJsonlEntries(timelinePath),
        new RegExp(`${MAX_TASK_TIMELINE_JSON_STRUCTURAL_TOKENS} structural token limit`)
    );
});

test('rejects deeply nested timeline records without recursive freeze overflow', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-depth-bound-'));
    tempRoots.push(root);
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const timelinePath = path.join(eventsRoot, 'T-DEPTH-BOUND.jsonl');
    const nestedValue = `${'{"child":'.repeat(300)}null${'}'.repeat(300)}`;
    fs.writeFileSync(
        timelinePath,
        `{"task_id":"T-DEPTH-BOUND","event_type":"NESTED","details":${nestedValue}}\n`,
        'utf8'
    );

    assert.throws(() => readTaskTimelineJsonlEntries(timelinePath), /depth limit/);
    const inspection = inspectTaskEventFile(timelinePath, 'T-DEPTH-BOUND');
    assert.equal(inspection.status, 'FAILED');
    assert.match(inspection.violations.join(' '), /depth limit/);
});

test('rejects appends that would exceed authenticated reader resource budgets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-append-bounds-'));
    tempRoots.push(root);
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const taskId = 'T-APPEND-BOUNDS';
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    fs.writeFileSync(timelinePath, ' \n'.repeat(MAX_TASK_TIMELINE_JSONL_LINES), 'utf8');

    withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        assert.throws(
            () => assertTaskTimelineJsonlAppendWithinLimits(timelinePath, '{}'),
            new RegExp(`${MAX_TASK_TIMELINE_JSONL_LINES} line limit`)
        );
    });

    fs.writeFileSync(timelinePath, '', 'utf8');
    withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        const oversizedRecord = JSON.stringify({ message: 'x'.repeat(MAX_TASK_TIMELINE_JSON_RECORD_BYTES) });
        assert.throws(
            () => assertTaskTimelineJsonlAppendWithinLimits(timelinePath, oversizedRecord),
            new RegExp(`${MAX_TASK_TIMELINE_JSON_RECORD_BYTES} byte limit`)
        );

        const denseArray = `[${'0,'.repeat(MAX_TASK_TIMELINE_JSON_STRUCTURAL_TOKENS)}0]`;
        assert.throws(
            () => assertTaskTimelineJsonlAppendWithinLimits(timelinePath, `{"details":${denseArray}}`),
            new RegExp(`${MAX_TASK_TIMELINE_JSON_STRUCTURAL_TOKENS} structural token limit`)
        );

        const nestedValue = `${'['.repeat(MAX_TASK_TIMELINE_JSON_DEPTH + 1)}`
            + `null${']'.repeat(MAX_TASK_TIMELINE_JSON_DEPTH + 1)}`;
        assert.throws(
            () => assertTaskTimelineJsonlAppendWithinLimits(timelinePath, `{"details":${nestedValue}}`),
            /depth limit/
        );
    });
});

test('bounds descriptor payload reads to the authenticated pre-read size', () => {
    const taskId = 'T-SNAPSHOT-GROWTH-BOUND';
    const { eventsRoot, timelinePath } = seedTimeline(taskId);
    const authenticatedSize = fs.statSync(timelinePath).size;
    const fsModule = require('node:fs') as typeof fs;
    const originalReadSync = fsModule.readSync;
    let growthInjected = false;
    let largestRequestedRead = 0;
    fsModule.readSync = ((...args: unknown[]) => {
        largestRequestedRead = Math.max(largestRequestedRead, Number(args[3] || 0));
        if (!growthInjected) {
            growthInjected = true;
            fs.truncateSync(timelinePath, MAX_TASK_TIMELINE_SNAPSHOT_BYTES + 1);
        }
        return Reflect.apply(originalReadSync, fsModule, args) as number;
    }) as typeof fsModule.readSync;

    try {
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            const metadata = readTaskTimelineFileMetadataSnapshot(timelinePath);
            assert.equal(metadata.active, true);
            assert.equal(metadata.exists, false);
            assert.equal(metadata.valid, false);
        });
        assert.equal(growthInjected, true);
        assert.ok(largestRequestedRead <= authenticatedSize);
    } finally {
        fsModule.readSync = originalReadSync;
    }
});

test('rejects a projected append that would exceed the snapshot payload limit', () => {
    assert.equal(
        taskTimelineAppendExceedsSnapshotLimit(MAX_TASK_TIMELINE_SNAPSHOT_BYTES - 1, 1),
        false
    );
    assert.equal(
        taskTimelineAppendExceedsSnapshotLimit(MAX_TASK_TIMELINE_SNAPSHOT_BYTES - 1, 2),
        true
    );
    assert.equal(taskTimelineAppendExceedsSnapshotLimit(-1, 1), true);
});

test('creates canonical timeline files with owner-only requested permissions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-create-mode-'));
    tempRoots.push(root);
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const directPath = path.join(eventsRoot, 'T-MODE-DIRECT.jsonl');
    const snapshotPath = path.join(eventsRoot, 'T-MODE-SNAPSHOT.jsonl');
    const fsModule = require('node:fs') as typeof fs;
    const originalOpenSync = fsModule.openSync;
    const createModes: number[] = [];
    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (
            typeof flags === 'number'
            && (flags & fs.constants.O_CREAT) !== 0
            && [directPath, snapshotPath].some((candidate) => (
                path.resolve(candidate) === path.resolve(String(targetPath))
            ))
        ) {
            createModes.push(Number(mode));
        }
        return originalOpenSync(targetPath, flags, mode);
    }) as typeof fsModule.openSync;

    try {
        appendTaskTimelineLineSync(directPath, '{"task_id":"T-MODE-DIRECT"}');
        withTaskTimelineReadSnapshot(eventsRoot, 'T-MODE-SNAPSHOT', () => {
            appendTaskTimelineLineSync(snapshotPath, '{"task_id":"T-MODE-SNAPSHOT"}');
        });
    } finally {
        fsModule.openSync = originalOpenSync;
    }

    assert.deepEqual(createModes, [0o600, 0o600]);
});

test('rejects POSIX timeline roots and files writable by other principals', {
    skip: typeof process.getuid !== 'function'
        ? 'POSIX owner and mode metadata are unavailable on this platform.'
        : false
}, () => {
    const orchestratorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-authority-'));
    tempRoots.push(orchestratorRoot);
    const eventsRoot = path.join(orchestratorRoot, 'runtime', 'task-events');
    const timelinePath = path.join(eventsRoot, 'T-POSIX-AUTHORITY.jsonl');
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.writeFileSync(timelinePath, '{}\n', { encoding: 'utf8', mode: 0o600 });

    fs.chmodSync(eventsRoot, 0o770);
    assert.throws(
        () => readTaskTimelineTextFile(timelinePath),
        /events root must retain trusted owner\/DACL write authority and not be writable/
    );

    fs.chmodSync(eventsRoot, 0o700);
    fs.chmodSync(timelinePath, 0o660);
    assert.throws(
        () => readTaskTimelineTextFile(timelinePath),
        /snapshot is unavailable/
    );
    assert.throws(
        () => appendTaskTimelineLineSync(timelinePath, '{}'),
        /append authority changed before write/
    );

    fs.chmodSync(timelinePath, 0o600);
    assert.equal(readTaskTimelineTextFile(timelinePath), '{}\n');
});

test('Windows ACL parsing rejects explicit writable ACEs but accepts inherited or deny-only entries', () => {
    const inheritedAndDenied = [
        'timeline BUILTIN\\Administrators:(I)(F)',
        '         S-1-5-21-100:(DENY)(W,D,DC)',
        '         S-1-5-21-200:(R)',
        '         S-1-5-21-300:(IO)(M)'
    ].join('\r\n');
    assert.equal(windowsAclOutputHasExplicitWriteGrant(inheritedAndDenied), false);
    assert.equal(
        windowsAclOutputHasExplicitWriteGrant('timeline S-1-5-21-400:(OI)(CI)(M)'),
        true
    );
    assert.equal(
        windowsAclOutputHasExplicitWriteGrant('timeline S-1-5-21-500:(D)'),
        true
    );
});

test('Windows ACL cache invalidates a trusted decision when file metadata changes', {
    skip: process.platform !== 'win32' ? 'Windows ACL metadata is unavailable on this platform.' : false
}, () => {
    const orchestratorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-acl-cache-'));
    tempRoots.push(orchestratorRoot);
    const eventsRoot = path.join(orchestratorRoot, 'runtime', 'task-events');
    const timelinePath = path.join(eventsRoot, 'T-ACL-CACHE.jsonl');
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.writeFileSync(timelinePath, '{}\n', 'utf8');

    assert.equal(readTaskTimelineTextFile(timelinePath), '{}\n');
    const grant = childProcess.spawnSync(
        'icacls.exe',
        [timelinePath, '/grant', '*S-1-1-0:(W)'],
        { encoding: 'utf8', windowsHide: true, timeout: 1_000 }
    );
    assert.equal(grant.status, 0, String(grant.stderr || grant.stdout || grant.error || 'icacls grant failed'));
    try {
        fs.appendFileSync(timelinePath, '{}\n', 'utf8');
        assert.throws(
            () => readTaskTimelineTextFile(timelinePath),
            /snapshot is unavailable/
        );
    } finally {
        childProcess.spawnSync(
            'icacls.exe',
            [timelinePath, '/remove:g', '*S-1-1-0'],
            { encoding: 'utf8', windowsHide: true, timeout: 1_000 }
        );
    }
});

test('Windows ACL inspection retries a transient timeout without caching an indeterminate result', {
    skip: process.platform !== 'win32' ? 'Windows ACL metadata is unavailable on this platform.' : false
}, () => {
    const orchestratorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-acl-retry-'));
    tempRoots.push(orchestratorRoot);
    const eventsRoot = path.join(orchestratorRoot, 'runtime', 'task-events');
    const timelinePath = path.join(eventsRoot, 'T-ACL-RETRY.jsonl');
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.writeFileSync(timelinePath, '{}\n', 'utf8');

    const originalSpawnSync = mutableChildProcess.spawnSync;
    const attempts = new Map<string, number>();
    try {
        mutableChildProcess.spawnSync = ((
            command: string,
            args: readonly string[] = [],
            options?: childProcess.SpawnSyncOptions
        ) => {
            assert.equal(command, 'icacls.exe');
            assert.equal(options?.timeout, 1_000);
            const targetPath = path.resolve(String(args[0] || ''));
            const attempt = (attempts.get(targetPath) || 0) + 1;
            attempts.set(targetPath, attempt);
            if (targetPath === path.resolve(eventsRoot) && attempt === 1) {
                return {
                    pid: 0,
                    status: null,
                    signal: 'SIGTERM',
                    stdout: '',
                    stderr: '',
                    output: [null, '', ''],
                    error: Object.assign(new Error('spawnSync icacls.exe ETIMEDOUT'), { code: 'ETIMEDOUT' })
                } as childProcess.SpawnSyncReturns<string>;
            }
            return {
                pid: 0,
                status: 0,
                signal: null,
                stdout: `${targetPath} BUILTIN\\Administrators:(I)(F)\r\n`,
                stderr: '',
                output: [null, `${targetPath} BUILTIN\\Administrators:(I)(F)\r\n`, '']
            } as childProcess.SpawnSyncReturns<string>;
        }) as typeof childProcess.spawnSync;

        assert.equal(readTaskTimelineTextFile(timelinePath), '{}\n');
        assert.equal(readTaskTimelineTextFile(timelinePath), '{}\n');
        assert.equal(attempts.get(path.resolve(eventsRoot)), 2);
        assert.equal(attempts.get(path.resolve(timelinePath)), 1);
    } finally {
        mutableChildProcess.spawnSync = originalSpawnSync;
    }
});

test('Windows ACL inspection caches an indeterminate fail-closed decision', {
    skip: process.platform !== 'win32' ? 'Windows ACL metadata is unavailable on this platform.' : false
}, () => {
    const orchestratorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-acl-negative-cache-'));
    tempRoots.push(orchestratorRoot);
    const eventsRoot = path.join(orchestratorRoot, 'runtime', 'task-events');
    const timelinePath = path.join(eventsRoot, 'T-ACL-NEGATIVE-CACHE.jsonl');
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.writeFileSync(timelinePath, '{}\n', 'utf8');

    const originalSpawnSync = mutableChildProcess.spawnSync;
    let attempts = 0;
    try {
        mutableChildProcess.spawnSync = ((
            command: string,
            _args: readonly string[] = [],
            options?: childProcess.SpawnSyncOptions
        ) => {
            assert.equal(command, 'icacls.exe');
            assert.equal(options?.timeout, 1_000);
            attempts += 1;
            return {
                pid: 0,
                status: null,
                signal: 'SIGTERM',
                stdout: '',
                stderr: '',
                output: [null, '', ''],
                error: Object.assign(new Error('spawnSync icacls.exe ETIMEDOUT'), { code: 'ETIMEDOUT' })
            } as childProcess.SpawnSyncReturns<string>;
        }) as typeof childProcess.spawnSync;

        for (let read = 0; read < 2; read += 1) {
            assert.throws(
                () => readTaskTimelineTextFile(timelinePath),
                /must retain trusted owner\/DACL write authority/u
            );
        }
        assert.equal(attempts, 2);
    } finally {
        mutableChildProcess.spawnSync = originalSpawnSync;
    }
});

test('reports observer-mode snapshot invalidation as failed integrity', () => {
    for (const mutation of ['append', 'remove'] as const) {
        const taskId = `T-SNAPSHOT-OBSERVER-${mutation.toUpperCase()}`;
        const { eventsRoot, timelinePath } = seedTimeline(taskId);

        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            readTaskTimelineTextFile(timelinePath);
            if (mutation === 'append') {
                fs.appendFileSync(timelinePath, '\n', 'utf8');
            } else {
                fs.rmSync(timelinePath);
            }
            const inspection = inspectTaskEventFile(timelinePath, taskId, {
                onIntegrityEvent: () => undefined
            });
            assert.equal(inspection.status, 'FAILED', mutation);
            assert.match(
                inspection.violations.join(' '),
                /snapshot changed or became unavailable/,
                mutation
            );
            assert.doesNotMatch(inspection.violations.join(' '), /file not found/, mutation);
        });
    }
});

test('reports timeline mutation performed inside an integrity observer as failed integrity', () => {
    const taskId = 'T-SNAPSHOT-OBSERVER-IN-CALLBACK';
    const { timelinePath } = seedTimeline(taskId);
    let mutated = false;

    const inspection = inspectTaskEventFile(timelinePath, taskId, {
        onIntegrityEvent: () => {
            if (!mutated) {
                mutated = true;
                fs.appendFileSync(timelinePath, '\n', 'utf8');
            }
        }
    });

    assert.equal(mutated, true);
    assert.equal(inspection.status, 'FAILED');
    assert.match(inspection.violations.join(' '), /snapshot changed or became unavailable/);
});

test('does not recreate a removed captured timeline while preparing an append', () => {
    const taskId = 'T-SNAPSHOT-REMOVED-BEFORE-APPEND';
    const { orchestratorRoot, eventsRoot, timelinePath } = seedTimeline(taskId);

    withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        assert.equal(readTaskEventAppendState(timelinePath, taskId).matching_events, 3);
        fs.rmSync(timelinePath);
        const appendResult = appendTaskEvent(
            orchestratorRoot,
            taskId,
            'MUST_NOT_BE_WRITTEN',
            'PASS',
            'Append after removal',
            {},
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(appendResult?.canonical_committed, false);
        assert.match(
            appendResult?.warnings.join(' ') || '',
            /snapshot (?:is unavailable|changed while reading|changed or became unavailable)/
        );
        assert.equal(fs.existsSync(timelinePath), false);
    });
});

test('does not append after an emit-once snapshot timeline is removed or replaced before write', () => {
    for (const mode of ['removed', 'replaced'] as const) {
        const taskId = `T-SNAPSHOT-PREWRITE-${mode.toUpperCase()}`;
        const { orchestratorRoot, eventsRoot, timelinePath } = seedTimeline(taskId);
        const originalContent = fs.readFileSync(timelinePath, 'utf8');
        const fsModule = require('node:fs') as { lstatSync: typeof fs.lstatSync };
        const originalLstatSync = fsModule.lstatSync;
        let mutationInjected = false;
        let armed = false;
        fsModule.lstatSync = ((targetPath: fs.PathLike) => {
            if (armed && !mutationInjected && path.resolve(String(targetPath)) === path.resolve(timelinePath)) {
                mutationInjected = true;
                fs.rmSync(timelinePath);
                if (mode === 'replaced') {
                    fs.writeFileSync(timelinePath, originalContent.replace('Event 3', 'Replacement'), 'utf8');
                }
            }
            return originalLstatSync(targetPath);
        }) as typeof fsModule.lstatSync;

        try {
            withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
                readTaskTimelineTextFile(timelinePath);
                armed = true;
                const result = appendTaskEvent(
                    orchestratorRoot,
                    taskId,
                    'MUST_NOT_BE_WRITTEN',
                    'PASS',
                    'Append after pre-write timeline race',
                    {},
                    { passThru: true, emitOnce: true, lowNoiseRuntimeWrites: true }
                );
                assert.equal(result?.canonical_committed, false, mode);
                assert.match(
                    result?.warnings.join(' ') || '',
                    /snapshot (?:is unavailable|changed while reading|changed or became unavailable)/,
                    mode
                );
                assert.equal(mutationInjected, true, mode);
                const finalContent = fs.existsSync(timelinePath)
                    ? fs.readFileSync(timelinePath, 'utf8')
                    : '';
                assert.equal(finalContent.includes('MUST_NOT_BE_WRITTEN'), false, mode);
            });
        } finally {
            fsModule.lstatSync = originalLstatSync;
        }
    }
});

test('rejects a replaced path between append precondition and descriptor open', () => {
    const taskId = 'T-SNAPSHOT-PREOPEN-REPLACEMENT';
    const { orchestratorRoot, eventsRoot, timelinePath } = seedTimeline(taskId);
    const originalContent = fs.readFileSync(timelinePath, 'utf8');
    const fsModule = require('node:fs') as typeof fs;
    const originalOpenSync = fsModule.openSync;
    let replacementInjected = false;
    let armed = false;
    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (armed && !replacementInjected && path.resolve(String(targetPath)) === path.resolve(timelinePath)) {
            replacementInjected = true;
            fs.rmSync(timelinePath);
            fs.writeFileSync(timelinePath, originalContent.replace('Event 3', 'Replacement'), 'utf8');
        }
        return originalOpenSync(targetPath, flags, mode);
    }) as typeof fsModule.openSync;

    try {
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            readTaskTimelineTextFile(timelinePath);
            armed = true;
            const result = appendTaskEvent(
                orchestratorRoot,
                taskId,
                'MUST_NOT_BE_WRITTEN',
                'PASS',
                'Append after precondition/open replacement race',
                {},
                { passThru: true, lowNoiseRuntimeWrites: true }
            );
            assert.equal(result?.canonical_committed, false);
            assert.match(result?.warnings.join(' ') || '', /snapshot changed while reading/);
            assert.equal(replacementInjected, true);
            assert.equal(fs.readFileSync(timelinePath, 'utf8').includes('MUST_NOT_BE_WRITTEN'), false);
        });
    } finally {
        fsModule.openSync = originalOpenSync;
    }
    assert.equal(replacementInjected, true);
});

test('authenticates the append descriptor without an explicit read snapshot', () => {
    const taskId = 'T-SNAPSHOT-DEFAULT-APPEND-AUTH';
    const { orchestratorRoot, timelinePath } = seedTimeline(taskId);
    const originalContent = fs.readFileSync(timelinePath, 'utf8');
    const fsModule = require('node:fs') as typeof fs;
    const originalOpenSync = fsModule.openSync;
    let replacementInjected = false;
    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (
            !replacementInjected
            && flags !== 'r'
            && path.resolve(String(targetPath)) === path.resolve(timelinePath)
        ) {
            replacementInjected = true;
            fs.rmSync(timelinePath);
            fs.writeFileSync(timelinePath, originalContent.replace('Event 3', 'Replacement'), 'utf8');
        }
        return originalOpenSync(targetPath, flags, mode);
    }) as typeof fsModule.openSync;

    try {
        const result = appendTaskEvent(
            orchestratorRoot,
            taskId,
            'MUST_NOT_BE_WRITTEN',
            'PASS',
            'Default append descriptor race',
            {},
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(result?.canonical_committed, false);
        assert.match(
            result?.warnings.join(' ') || '',
            /(?:append authority changed|snapshot changed while reading)/
        );
        assert.equal(replacementInjected, true);
        assert.equal(fs.readFileSync(timelinePath, 'utf8').includes('MUST_NOT_BE_WRITTEN'), false);
    } finally {
        fsModule.openSync = originalOpenSync;
    }
});

test('rejects a canonical timeline inode that has an out-of-root hard-link alias', () => {
    const taskId = 'T-SNAPSHOT-HARD-LINK-AUTHORITY';
    const { orchestratorRoot, timelinePath } = seedTimeline(taskId);
    const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-hard-link-alias-'));
    tempRoots.push(aliasRoot);
    const aliasPath = path.join(aliasRoot, 'outside-events-root.jsonl');
    fs.linkSync(timelinePath, aliasPath);
    const contentBeforeAppend = fs.readFileSync(timelinePath, 'utf8');

    const result = appendTaskEvent(
        orchestratorRoot,
        taskId,
        'MUST_NOT_BE_WRITTEN',
        'PASS',
        'Hard-linked canonical timeline',
        {},
        { passThru: true, lowNoiseRuntimeWrites: true }
    );

    assert.equal(result?.canonical_committed, false);
    assert.match(result?.warnings.join(' ') || '', /append authority changed/);
    assert.equal(fs.readFileSync(timelinePath, 'utf8'), contentBeforeAppend);
    assert.equal(fs.readFileSync(aliasPath, 'utf8'), contentBeforeAppend);
});

test('fails a default append when the canonical path is replaced during descriptor write', () => {
    const taskId = 'T-SNAPSHOT-DEFAULT-POSTWRITE-AUTH';
    const { orchestratorRoot, timelinePath } = seedTimeline(taskId);
    const originalContent = fs.readFileSync(timelinePath, 'utf8');
    const fsModule = require('node:fs') as typeof fs;
    const originalOpenSync = fsModule.openSync;
    const originalWriteSync = fsModule.writeSync;
    let timelineFileDescriptor: number | null = null;
    let replacementInjected = false;
    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const fileDescriptor = originalOpenSync(targetPath, flags, mode);
        if (
            flags !== 'r'
            && path.resolve(String(targetPath)) === path.resolve(timelinePath)
        ) {
            timelineFileDescriptor = fileDescriptor;
        }
        return fileDescriptor;
    }) as typeof fsModule.openSync;
    fsModule.writeSync = ((
        fileDescriptor: number,
        data: Uint8Array | string,
        offset?: number,
        length?: number,
        position?: number | null
    ) => {
        if (!replacementInjected && fileDescriptor === timelineFileDescriptor) {
            fs.rmSync(timelinePath);
            fs.writeFileSync(timelinePath, originalContent, 'utf8');
            replacementInjected = true;
        }
        return originalWriteSync(fileDescriptor, data as never, offset, length, position);
    }) as typeof fsModule.writeSync;

    try {
        const result = appendTaskEvent(
            orchestratorRoot,
            taskId,
            'MUST_NOT_BE_WRITTEN',
            'PASS',
            'Default append post-write race',
            {},
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(result?.canonical_committed, false);
        assert.match(
            result?.warnings.join(' ') || '',
            /(?:append authority changed|snapshot changed while reading)/
        );
        assert.equal(replacementInjected, true);
        assert.equal(fs.readFileSync(timelinePath, 'utf8').includes('MUST_NOT_BE_WRITTEN'), false);
    } finally {
        fsModule.openSync = originalOpenSync;
        fsModule.writeSync = originalWriteSync;
    }
});

test('fails a default append after same-inode same-size content tampering during descriptor write', () => {
    const taskId = 'T-SNAPSHOT-DEFAULT-CONTENT-AUTH';
    const { orchestratorRoot, timelinePath } = seedTimeline(taskId);
    const fsModule = require('node:fs') as typeof fs;
    const originalOpenSync = fsModule.openSync;
    const originalWriteSync = fsModule.writeSync;
    let appendFileDescriptor: number | null = null;
    let mutationInjected = false;

    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const fileDescriptor = originalOpenSync(targetPath, flags, mode);
        if (
            flags !== 'r'
            && path.resolve(String(targetPath)) === path.resolve(timelinePath)
        ) {
            appendFileDescriptor = fileDescriptor;
        }
        return fileDescriptor;
    }) as typeof fsModule.openSync;
    fsModule.writeSync = ((
        fileDescriptor: number,
        data: Uint8Array | string,
        offset?: number,
        length?: number,
        position?: number | null
    ) => {
        if (!mutationInjected && fileDescriptor === appendFileDescriptor) {
            const original = fs.readFileSync(timelinePath, 'utf8');
            const mutated = `${original.startsWith('{') ? '[' : '{'}${original.slice(1)}`;
            assert.equal(Buffer.byteLength(mutated), Buffer.byteLength(original));
            mutationInjected = true;
            fs.writeFileSync(timelinePath, mutated, 'utf8');
        }
        return originalWriteSync(fileDescriptor, data as never, offset, length, position);
    }) as typeof fsModule.writeSync;

    try {
        const result = appendTaskEvent(
            orchestratorRoot,
            taskId,
            'MUST_NOT_BE_CANONICAL',
            'PASS',
            'Default append content authentication',
            {},
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(result?.canonical_committed, false);
        assert.match(result?.warnings.join(' ') || '', /snapshot changed while reading/);
        assert.equal(mutationInjected, true);
    } finally {
        fsModule.openSync = originalOpenSync;
        fsModule.writeSync = originalWriteSync;
    }
});

test('rejects an events root redirected outside its configured boundary', () => {
    const taskId = 'T-SNAPSHOT-REDIRECTED-ROOT';
    const orchestratorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-snapshot-'));
    const redirectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-redirect-'));
    tempRoots.push(orchestratorRoot, redirectedRoot);
    const eventsRoot = path.join(orchestratorRoot, 'runtime', 'task-events');
    fs.mkdirSync(path.dirname(eventsRoot), { recursive: true });
    fs.symlinkSync(redirectedRoot, eventsRoot, process.platform === 'win32' ? 'junction' : 'dir');

    const result = appendTaskEvent(
        orchestratorRoot,
        taskId,
        'MUST_NOT_BE_WRITTEN',
        'PASS',
        'Redirected events root',
        {},
        { passThru: true, lowNoiseRuntimeWrites: true }
    );
    assert.equal(result?.canonical_committed, false);
    assert.match(result?.warnings.join(' ') || '', /non-redirected directory/);
    assert.equal(fs.existsSync(path.join(redirectedRoot, `${taskId}.jsonl`)), false);
});

test('reauthenticates a lock-protected in-process append before extending the snapshot', () => {
    const taskId = 'T-SNAPSHOT-SELF-APPEND';
    const { orchestratorRoot, eventsRoot, timelinePath } = seedTimeline(taskId);
    const fsModule = require('node:fs') as typeof fs;
    const originalReadSync = fsModule.readSync;
    let physicalReadCount = 0;
    fsModule.readSync = ((...args: unknown[]) => {
        physicalReadCount += 1;
        return Reflect.apply(originalReadSync, fsModule, args) as number;
    }) as typeof fsModule.readSync;

    try {
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            const beforeAppend = readTaskTimelineTextFile(timelinePath);
            const appendResult = appendTaskEvent(
                orchestratorRoot,
                taskId,
                'SELF_APPENDED_EVENT',
                'PASS',
                'Self append',
                {},
                { passThru: true, lowNoiseRuntimeWrites: true }
            );
            assert.equal(appendResult?.commit_status, 'committed');

            const afterAppend = readTaskTimelineTextFile(timelinePath);
            assert.ok(afterAppend.length > beforeAppend.length);
            assert.match(afterAppend, /SELF_APPENDED_EVENT/);
            assert.equal(inspectTaskEventFile(timelinePath, taskId).status, 'PASS');
        });
        assert.equal(physicalReadCount, 2);
    } finally {
        fsModule.readSync = originalReadSync;
    }
});

test('does not signal canonical commit before same-size post-write authentication succeeds', () => {
    const taskId = 'T-SNAPSHOT-SELF-APPEND-RACE';
    const { orchestratorRoot, eventsRoot, timelinePath } = seedTimeline(taskId);
    const fsModule = require('node:fs') as typeof fs;
    const originalOpenSync = fsModule.openSync;
    const originalWriteSync = fsModule.writeSync;
    let mutationInjected = false;
    let timelineFileDescriptor: number | null = null;

    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const fileDescriptor = originalOpenSync(targetPath, flags, mode);
        if (path.resolve(String(targetPath)) === path.resolve(timelinePath)) {
            timelineFileDescriptor = fileDescriptor;
        }
        return fileDescriptor;
    }) as typeof fsModule.openSync;

    fsModule.writeSync = ((fileDescriptor: number, data: Uint8Array | string, offset?: number, length?: number, position?: number | null) => {
        if (!mutationInjected && fileDescriptor === timelineFileDescriptor) {
            const original = fs.readFileSync(timelinePath, 'utf8');
            const mutated = `${original.startsWith('{') ? '[' : '{'}${original.slice(1)}`;
            assert.equal(Buffer.byteLength(mutated), Buffer.byteLength(original));
            fs.writeFileSync(timelinePath, mutated, 'utf8');
            mutationInjected = true;
        }
        return originalWriteSync(fileDescriptor, data as never, offset, length, position);
    }) as typeof fsModule.writeSync;

    try {
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            readTaskTimelineTextFile(timelinePath);
            const result = appendTaskEvent(
                orchestratorRoot,
                taskId,
                'SELF_APPENDED_EVENT',
                'PASS',
                'Self append with an external race',
                {},
                { passThru: true, lowNoiseRuntimeWrites: true }
            );
            assert.equal(result?.canonical_committed, false);
            assert.match(result?.warnings.join(' ') || '', /snapshot changed while reading/);
            assert.equal(mutationInjected, true);
            assert.throws(
                () => readTaskTimelineTextFile(timelinePath),
                /snapshot is unavailable/
            );
        });
    } finally {
        fsModule.openSync = originalOpenSync;
        fsModule.writeSync = originalWriteSync;
    }
});

test('rejects an expected-content replacement inode after an active-snapshot descriptor write', () => {
    const taskId = 'T-SNAPSHOT-EXPECTED-CONTENT-REPLACEMENT';
    const { orchestratorRoot, eventsRoot, timelinePath } = seedTimeline(taskId);
    const originalContent = fs.readFileSync(timelinePath);
    const fsModule = require('node:fs') as {
        lstatSync: typeof fs.lstatSync;
        writeSync: typeof fs.writeSync;
    };
    const originalLstatSync = fsModule.lstatSync;
    const originalWriteSync = fsModule.writeSync;
    let appendedBytes: Buffer | null = null;
    let replacementInjected = false;

    fsModule.writeSync = ((
        fileDescriptor: number,
        data: Uint8Array | string,
        offset?: number,
        length?: number,
        position?: number | null
    ) => {
        const written = originalWriteSync(fileDescriptor, data as never, offset, length, position);
        if (appendedBytes == null && typeof data !== 'string') {
            assert.equal(written, length);
            const source = Buffer.from(data);
            const start = offset || 0;
            appendedBytes = Buffer.from(source.subarray(start, start + written));
        }
        return written;
    }) as typeof fsModule.writeSync;
    fsModule.lstatSync = ((targetPath: fs.PathLike) => {
        if (
            appendedBytes
            && !replacementInjected
            && path.resolve(String(targetPath)) === path.resolve(timelinePath)
        ) {
            replacementInjected = true;
            fs.rmSync(timelinePath);
            fs.writeFileSync(
                timelinePath,
                Buffer.concat([originalContent, appendedBytes]),
                { mode: 0o600 }
            );
        }
        return originalLstatSync(targetPath);
    }) as typeof fsModule.lstatSync;

    try {
        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            readTaskTimelineTextFile(timelinePath);
            const result = appendTaskEvent(
                orchestratorRoot,
                taskId,
                'MUST_NOT_BE_CANONICAL',
                'PASS',
                'Exact-content replacement inode',
                {},
                { passThru: true, lowNoiseRuntimeWrites: true }
            );
            assert.equal(result?.canonical_committed, false);
            assert.match(result?.warnings.join(' ') || '', /snapshot changed while reading/);
            assert.equal(replacementInjected, true);
            assert.match(fs.readFileSync(timelinePath, 'utf8'), /MUST_NOT_BE_CANONICAL/);
        });
    } finally {
        fsModule.lstatSync = originalLstatSync;
        fsModule.writeSync = originalWriteSync;
    }
});

test('keeps malformed, broken-chain, and replayed timelines fail-closed inside a snapshot', () => {
    const observedStatuses: string[] = [];
    for (const failureMode of ['malformed', 'broken-chain', 'replay'] as const) {
        const taskId = `T-SNAPSHOT-${failureMode.toUpperCase()}`;
        const { eventsRoot, timelinePath } = seedTimeline(taskId);
        const lines = fs.readFileSync(timelinePath, 'utf8').trim().split('\n');

        if (failureMode === 'malformed') {
            lines.push('{not-json');
        } else if (failureMode === 'broken-chain') {
            const event = JSON.parse(lines[1]) as Record<string, unknown>;
            const integrity = event.integrity as Record<string, unknown>;
            integrity.prev_event_sha256 = 'f'.repeat(64);
            lines[1] = JSON.stringify(event);
        } else {
            lines.push(lines[0]);
        }
        fs.writeFileSync(timelinePath, `${lines.join('\n')}\n`, 'utf8');

        withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            const inspection = inspectTaskEventFile(timelinePath, taskId);
            assert.equal(inspection.status, 'FAILED', failureMode);
            assert.ok(inspection.violations.length > 0, failureMode);
            observedStatuses.push(inspection.status);
        });
    }
    assert.deepEqual(observedStatuses, ['FAILED', 'FAILED', 'FAILED']);
});

test('rejects canonical append and emit-once decisions for corrupted timelines', () => {
    for (const failureMode of ['malformed', 'broken-chain', 'replay'] as const) {
        const taskId = `T-SNAPSHOT-APPEND-REJECT-${failureMode.toUpperCase()}`;
        const { orchestratorRoot, timelinePath } = seedTimeline(taskId);
        const lines = fs.readFileSync(timelinePath, 'utf8').trim().split('\n');
        if (failureMode === 'malformed') {
            lines.push('{not-json');
        } else if (failureMode === 'broken-chain') {
            const event = JSON.parse(lines[1]) as Record<string, unknown>;
            const integrity = event.integrity as Record<string, unknown>;
            integrity.prev_event_sha256 = 'f'.repeat(64);
            lines[1] = JSON.stringify(event);
        } else {
            lines.push(lines[0]);
        }
        const corruptedContent = `${lines.join('\n')}\n`;
        fs.writeFileSync(timelinePath, corruptedContent, 'utf8');

        const result = appendTaskEvent(
            orchestratorRoot,
            taskId,
            'TEST_EVENT',
            'PASS',
            'Must reject corrupt emit-once state',
            {},
            { passThru: true, lowNoiseRuntimeWrites: true, emitOnce: true }
        );

        assert.equal(result?.canonical_committed, false, failureMode);
        assert.match(result?.warnings.join(' ') || '', /integrity validation failed before append/, failureMode);
        assert.equal(fs.readFileSync(timelinePath, 'utf8'), corruptedContent, failureMode);
    }
});
