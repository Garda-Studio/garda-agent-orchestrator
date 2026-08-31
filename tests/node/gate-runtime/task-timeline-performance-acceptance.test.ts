import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
    appendTaskEvent,
    buildEventIntegrityHash,
    inspectTaskEventFile,
    readTaskTimelineBoundedJsonlTail,
    readTaskTimelineJsonlEntries,
    readTaskTimelineTextFile,
    withTaskTimelineReadSnapshot
} from '../../../src/gate-runtime/timeline/task-events';

const MULTI_MEGABYTE_FIXTURE_BYTES = 2 * 1024 * 1024;
const LATENCY_SAMPLE_COUNT = 20;
const MAX_ACCEPTANCE_SCENARIO_P95_LATENCY_MS = 5_000;
const MAX_ACCEPTANCE_SCENARIO_P95_MEDIAN_SPREAD_MS = 1_000;
const SCENARIO_HEAP_GROWTH_SAMPLE_BUDGET_BYTES = 2 * 1024 * 1024;
const SCENARIO_HEAP_GROWTH_PAYLOAD_MULTIPLIER = 32;
const tempRoots: string[] = [];

interface TimelineFixture {
    orchestratorRoot: string;
    eventsRoot: string;
    timelinePath: string;
}

interface TimelineReadMetrics {
    descriptorOpenCount: number;
    readCallCount: number;
    requestedBytes: number;
    returnedBytes: number;
    largestRequestedRead: number;
    pathLstatCount: number;
    pathStatCount: number;
    descriptorStatCount: number;
    pathRealpathCount: number;
    pathExistsCount: number;
    pathAccessCount: number;
    pathReadlinkCount: number;
    directoryEnumerationCount: number;
    directFileReadCount: number;
}

interface TimelineReadProbe {
    metrics: TimelineReadMetrics;
    withoutRecording: <T>(callback: () => T) => T;
    restore: () => void;
}

interface HeapUsageProbe {
    sample: () => void;
    maxGrowthBytes: () => number;
}

interface BufferAllocationProbe {
    fullPayloadAllocationCount: () => number;
    fullPayloadAllocationSizes: () => number[];
    fullPayloadConcatCount: () => number;
    fullPayloadStringConversionCount: () => number;
    restore: () => void;
}

function createTimelineFixture(taskId: string): TimelineFixture {
    const orchestratorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-timeline-performance-'));
    tempRoots.push(orchestratorRoot);
    const eventsRoot = path.join(orchestratorRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    return {
        orchestratorRoot,
        eventsRoot,
        timelinePath: path.join(eventsRoot, `${taskId}.jsonl`)
    };
}

function seedSmallTimeline(taskId: string, eventCount = 3): TimelineFixture {
    const fixture = createTimelineFixture(taskId);
    for (let index = 0; index < eventCount; index += 1) {
        const result = appendTaskEvent(
            fixture.orchestratorRoot,
            taskId,
            'PERFORMANCE_ACCEPTANCE_SEED',
            'PASS',
            `Seed event ${index + 1}`,
            { index },
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(result?.commit_status, 'committed');
    }
    return fixture;
}

function seedLargeIntegrityTimeline(taskId: string): TimelineFixture & { eventCount: number; byteLength: number } {
    const fixture = createTimelineFixture(taskId);
    const lines: string[] = [];
    let byteLength = 0;
    let previousHash: string | null = null;

    while (byteLength < MULTI_MEGABYTE_FIXTURE_BYTES) {
        const taskSequence = lines.length + 1;
        const event: Record<string, unknown> = {
            timestamp_utc: '2026-01-01T00:00:00.000Z',
            task_id: taskId,
            event_type: 'PERFORMANCE_ACCEPTANCE',
            outcome: 'PASS',
            actor: 'test',
            message: `Large timeline event ${taskSequence}`,
            details: {
                payload: 'x'.repeat(2048),
                task_sequence: taskSequence
            },
            integrity: {
                schema_version: 2,
                task_sequence: taskSequence,
                prev_event_sha256: previousHash
            }
        };
        const eventHash = buildEventIntegrityHash(event);
        if (!eventHash) {
            throw new Error('Failed to build large timeline fixture integrity hash.');
        }
        (event.integrity as Record<string, unknown>).event_sha256 = eventHash;
        previousHash = eventHash;
        const line = JSON.stringify(event);
        lines.push(line);
        byteLength += Buffer.byteLength(line) + 1;
    }

    fs.writeFileSync(fixture.timelinePath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    return { ...fixture, eventCount: lines.length, byteLength };
}

function installTimelineReadProbe(timelinePath: string): TimelineReadProbe {
    const fsModule = require('node:fs') as typeof fs;
    const mutableStatFs = fsModule as unknown as {
        lstatSync: typeof fs.lstatSync;
        statSync: typeof fs.statSync;
    };
    const originalOpenSync = fsModule.openSync;
    const originalReadSync = fsModule.readSync;
    const originalCloseSync = fsModule.closeSync;
    const originalLstatSync = fsModule.lstatSync;
    const originalStatSync = fsModule.statSync;
    const originalFstatSync = fsModule.fstatSync;
    const originalRealpathSyncNative = fsModule.realpathSync.native;
    const originalExistsSync = fsModule.existsSync;
    const originalAccessSync = fsModule.accessSync;
    const originalReadlinkSync = fsModule.readlinkSync;
    const originalReaddirSync = fsModule.readdirSync;
    const originalReadFileSync = fsModule.readFileSync;
    const trackedDescriptors = new Set<number>();
    const allTimelineDescriptors = new Set<number>();
    const resolvedTimelinePath = path.resolve(timelinePath);
    const resolvedEventsRoot = path.dirname(resolvedTimelinePath);
    let recording = true;
    const metrics: TimelineReadMetrics = {
        descriptorOpenCount: 0,
        readCallCount: 0,
        requestedBytes: 0,
        returnedBytes: 0,
        largestRequestedRead: 0,
        pathLstatCount: 0,
        pathStatCount: 0,
        descriptorStatCount: 0,
        pathRealpathCount: 0,
        pathExistsCount: 0,
        pathAccessCount: 0,
        pathReadlinkCount: 0,
        directoryEnumerationCount: 0,
        directFileReadCount: 0
    };

    const isTrackedPath = (targetPath: unknown): boolean => {
        if (typeof targetPath === 'number') return false;
        try {
            const resolved = path.resolve(String(targetPath));
            return resolved === resolvedTimelinePath || resolved === resolvedEventsRoot;
        } catch {
            return false;
        }
    };

    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const fileDescriptor = originalOpenSync(targetPath, flags, mode);
        if (path.resolve(String(targetPath)) === resolvedTimelinePath) {
            allTimelineDescriptors.add(fileDescriptor);
            if (recording && flags === 'r') {
                metrics.descriptorOpenCount += 1;
                trackedDescriptors.add(fileDescriptor);
            }
        }
        return fileDescriptor;
    }) as typeof fsModule.openSync;
    fsModule.readSync = ((
        fileDescriptor: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | null
    ) => {
        const bytesRead = originalReadSync(fileDescriptor, buffer, offset, length, position);
        if (recording && trackedDescriptors.has(fileDescriptor)) {
            metrics.readCallCount += 1;
            metrics.requestedBytes += length;
            metrics.returnedBytes += bytesRead;
            metrics.largestRequestedRead = Math.max(metrics.largestRequestedRead, length);
        }
        return bytesRead;
    }) as typeof fsModule.readSync;
    fsModule.closeSync = ((fileDescriptor: number) => {
        try {
            originalCloseSync(fileDescriptor);
        } finally {
            trackedDescriptors.delete(fileDescriptor);
            allTimelineDescriptors.delete(fileDescriptor);
        }
    }) as typeof fsModule.closeSync;
    mutableStatFs.lstatSync = ((...args: unknown[]) => {
        if (recording && isTrackedPath(args[0])) metrics.pathLstatCount += 1;
        return Reflect.apply(originalLstatSync, fsModule, args);
    }) as typeof fsModule.lstatSync;
    mutableStatFs.statSync = ((...args: unknown[]) => {
        if (recording && isTrackedPath(args[0])) metrics.pathStatCount += 1;
        return Reflect.apply(originalStatSync, fsModule, args);
    }) as typeof fsModule.statSync;
    fsModule.fstatSync = ((...args: unknown[]) => {
        if (recording && allTimelineDescriptors.has(args[0] as number)) {
            metrics.descriptorStatCount += 1;
        }
        return Reflect.apply(originalFstatSync, fsModule, args);
    }) as typeof fsModule.fstatSync;
    fsModule.realpathSync.native = ((...args: unknown[]) => {
        if (recording && isTrackedPath(args[0])) metrics.pathRealpathCount += 1;
        return Reflect.apply(originalRealpathSyncNative, fsModule.realpathSync, args);
    }) as typeof fsModule.realpathSync.native;
    fsModule.existsSync = ((targetPath: fs.PathLike) => {
        if (recording && isTrackedPath(targetPath)) metrics.pathExistsCount += 1;
        return originalExistsSync(targetPath);
    }) as typeof fsModule.existsSync;
    fsModule.accessSync = ((...args: unknown[]) => {
        if (recording && isTrackedPath(args[0])) metrics.pathAccessCount += 1;
        return Reflect.apply(originalAccessSync, fsModule, args);
    }) as typeof fsModule.accessSync;
    fsModule.readlinkSync = ((...args: unknown[]) => {
        if (recording && isTrackedPath(args[0])) metrics.pathReadlinkCount += 1;
        return Reflect.apply(originalReadlinkSync, fsModule, args);
    }) as typeof fsModule.readlinkSync;
    fsModule.readdirSync = ((...args: unknown[]) => {
        if (recording && path.resolve(String(args[0])) === resolvedEventsRoot) {
            metrics.directoryEnumerationCount += 1;
        }
        return Reflect.apply(originalReaddirSync, fsModule, args);
    }) as typeof fsModule.readdirSync;
    fsModule.readFileSync = ((...args: unknown[]) => {
        if (recording && path.resolve(String(args[0])) === resolvedTimelinePath) {
            metrics.directFileReadCount += 1;
        }
        return Reflect.apply(originalReadFileSync, fsModule, args);
    }) as typeof fsModule.readFileSync;

    return {
        metrics,
        withoutRecording: <T>(callback: () => T): T => {
            const previousRecording = recording;
            recording = false;
            try {
                return callback();
            } finally {
                recording = previousRecording;
            }
        },
        restore: () => {
            fsModule.openSync = originalOpenSync;
            fsModule.readSync = originalReadSync;
            fsModule.closeSync = originalCloseSync;
            mutableStatFs.lstatSync = originalLstatSync;
            mutableStatFs.statSync = originalStatSync;
            fsModule.fstatSync = originalFstatSync;
            fsModule.realpathSync.native = originalRealpathSyncNative;
            fsModule.existsSync = originalExistsSync;
            fsModule.accessSync = originalAccessSync;
            fsModule.readlinkSync = originalReadlinkSync;
            fsModule.readdirSync = originalReaddirSync;
            fsModule.readFileSync = originalReadFileSync;
        }
    };
}

function installBufferAllocationProbe(fullPayloadThreshold: number): BufferAllocationProbe {
    const bufferModule = Buffer as typeof Buffer;
    const bufferPrototype = Buffer.prototype;
    const originalAlloc = bufferModule.alloc;
    const originalAllocUnsafe = bufferModule.allocUnsafe;
    const originalAllocUnsafeSlow = bufferModule.allocUnsafeSlow;
    const originalConcat = bufferModule.concat;
    const originalFrom = bufferModule.from;
    const originalToString = bufferPrototype.toString;
    let fullPayloadAllocations = 0;
    const fullPayloadAllocationSizes: number[] = [];
    let fullPayloadConcats = 0;
    let fullPayloadStringConversions = 0;

    bufferModule.alloc = ((size: number, fill?: string | number | Uint8Array, encoding?: BufferEncoding) => {
        if (size >= fullPayloadThreshold) {
            fullPayloadAllocations += 1;
            fullPayloadAllocationSizes.push(size);
        }
        return originalAlloc(size, fill as string, encoding);
    }) as typeof Buffer.alloc;

    bufferModule.allocUnsafe = ((size: number) => {
        if (size >= fullPayloadThreshold) {
            fullPayloadAllocations += 1;
            fullPayloadAllocationSizes.push(size);
        }
        return originalAllocUnsafe(size);
    }) as typeof Buffer.allocUnsafe;
    bufferModule.allocUnsafeSlow = ((size: number) => {
        if (size >= fullPayloadThreshold) {
            fullPayloadAllocations += 1;
            fullPayloadAllocationSizes.push(size);
        }
        return originalAllocUnsafeSlow(size);
    }) as typeof Buffer.allocUnsafeSlow;
    bufferModule.concat = ((list: readonly Uint8Array[], totalLength?: number) => {
        const resolvedLength = totalLength ?? list.reduce((total, entry) => total + entry.byteLength, 0);
        if (resolvedLength >= fullPayloadThreshold) {
            fullPayloadConcats += 1;
        }
        return originalConcat(list, totalLength);
    }) as typeof Buffer.concat;
    bufferModule.from = ((...args: unknown[]) => {
        const result = Reflect.apply(originalFrom, bufferModule, args) as Buffer;
        if (result.byteLength >= fullPayloadThreshold) {
            fullPayloadAllocations += 1;
            fullPayloadAllocationSizes.push(result.byteLength);
        }
        return result;
    }) as typeof Buffer.from;
    bufferPrototype.toString = function (this: Buffer, ...args: unknown[]) {
        if (this.byteLength >= fullPayloadThreshold) {
            fullPayloadStringConversions += 1;
        }
        return Reflect.apply(originalToString, this, args) as string;
    } as typeof Buffer.prototype.toString;

    return {
        fullPayloadAllocationCount: () => fullPayloadAllocations,
        fullPayloadAllocationSizes: () => [...fullPayloadAllocationSizes],
        fullPayloadConcatCount: () => fullPayloadConcats,
        fullPayloadStringConversionCount: () => fullPayloadStringConversions,
        restore: () => {
            bufferModule.alloc = originalAlloc;
            bufferModule.allocUnsafe = originalAllocUnsafe;
            bufferModule.allocUnsafeSlow = originalAllocUnsafeSlow;
            bufferModule.concat = originalConcat;
            bufferModule.from = originalFrom;
            bufferPrototype.toString = originalToString;
        }
    };
}

function createHeapUsageProbe(): HeapUsageProbe {
    const baselineHeapUsed = process.memoryUsage().heapUsed;
    let maximumHeapUsed = baselineHeapUsed;
    return {
        sample: () => {
            maximumHeapUsed = Math.max(maximumHeapUsed, process.memoryUsage().heapUsed);
        },
        maxGrowthBytes: () => Math.max(0, maximumHeapUsed - baselineHeapUsed)
    };
}

function assertHeapUsageBounded(probe: HeapUsageProbe, payloadBytes: number): void {
    probe.sample();
    const budgetBytes = Math.max(
        LATENCY_SAMPLE_COUNT * SCENARIO_HEAP_GROWTH_SAMPLE_BUDGET_BYTES,
        payloadBytes * SCENARIO_HEAP_GROWTH_PAYLOAD_MULTIPLIER
    );
    assert.ok(
        probe.maxGrowthBytes() <= budgetBytes,
        `Scenario heap growth exceeded ${budgetBytes} bytes: ${probe.maxGrowthBytes()} bytes.`
    );
}

function authorityCallMetrics(metrics: TimelineReadMetrics): Record<string, number> {
    return {
        pathLstatCount: metrics.pathLstatCount,
        pathStatCount: metrics.pathStatCount,
        descriptorStatCount: metrics.descriptorStatCount,
        pathRealpathCount: metrics.pathRealpathCount,
        pathExistsCount: metrics.pathExistsCount,
        pathAccessCount: metrics.pathAccessCount,
        pathReadlinkCount: metrics.pathReadlinkCount,
        directoryEnumerationCount: metrics.directoryEnumerationCount,
        directFileReadCount: metrics.directFileReadCount
    };
}

function assertStableScenarioLatency(samplesMs: number[]): void {
    assert.equal(samplesMs.length, LATENCY_SAMPLE_COUNT);
    assert.ok(LATENCY_SAMPLE_COUNT >= 20, 'A p95 order statistic requires at least 20 measured samples.');
    const sortedSamples = [...samplesMs].sort((left, right) => left - right);
    const medianUpperIndex = Math.floor(sortedSamples.length / 2);
    const medianMs = sortedSamples.length % 2 === 0
        ? (sortedSamples[medianUpperIndex - 1] + sortedSamples[medianUpperIndex]) / 2
        : sortedSamples[medianUpperIndex];
    const p95Ms = sortedSamples[Math.ceil(sortedSamples.length * 0.95) - 1];
    assert.ok(
        p95Ms <= MAX_ACCEPTANCE_SCENARIO_P95_LATENCY_MS,
        `Acceptance scenario p95 exceeded ${MAX_ACCEPTANCE_SCENARIO_P95_LATENCY_MS} ms: ${p95Ms.toFixed(1)} ms.`
    );
    assert.ok(
        p95Ms - medianMs <= MAX_ACCEPTANCE_SCENARIO_P95_MEDIAN_SPREAD_MS,
        `Acceptance scenario p95-to-median spread exceeded ${MAX_ACCEPTANCE_SCENARIO_P95_MEDIAN_SPREAD_MS} ms: ${(p95Ms - medianMs).toFixed(1)} ms.`
    );
}

test.afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('multi-megabyte read-only invocation captures and allocates the canonical payload once', () => {
    const taskId = 'T-PERFORMANCE-LARGE-READ';
    const fixture = seedLargeIntegrityTimeline(taskId);
    withTaskTimelineReadSnapshot(fixture.eventsRoot, taskId, () => {
        assert.equal(inspectTaskEventFile(fixture.timelinePath, taskId).status, 'PASS');
    });
    const ioProbe = installTimelineReadProbe(fixture.timelinePath);
    const allocationProbe = installBufferAllocationProbe(fixture.byteLength);
    const heapProbe = createHeapUsageProbe();
    const originalJsonParse = JSON.parse;
    let jsonParseCalls = 0;
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
        jsonParseCalls += 1;
        return originalJsonParse(text, reviver);
    }) as typeof JSON.parse;

    try {
        const latencySamplesMs: number[] = [];
        for (let sampleIndex = 0; sampleIndex < LATENCY_SAMPLE_COUNT; sampleIndex += 1) {
            const startedAt = performance.now();
            withTaskTimelineReadSnapshot(fixture.eventsRoot, taskId, () => {
                const firstInspection = inspectTaskEventFile(fixture.timelinePath, taskId);
                assert.equal(firstInspection.status, 'PASS');
                assert.equal(firstInspection.integrity_event_count, fixture.eventCount);
                const parseCallsAfterFirstInspection = jsonParseCalls;

                assert.equal(inspectTaskEventFile(fixture.timelinePath, taskId).status, 'PASS');
                assert.equal(readTaskTimelineJsonlEntries(fixture.timelinePath).length, fixture.eventCount);
                assert.equal(readTaskTimelineTextFile(fixture.timelinePath).length, fixture.byteLength);
                assert.equal(readTaskTimelineTextFile(fixture.timelinePath).length, fixture.byteLength);
                assert.equal(jsonParseCalls, parseCallsAfterFirstInspection);
                heapProbe.sample();
            });
            latencySamplesMs.push(performance.now() - startedAt);
        }
        assertStableScenarioLatency(latencySamplesMs);

        const expectedBytes = fixture.byteLength * LATENCY_SAMPLE_COUNT;
        assert.equal(ioProbe.metrics.descriptorOpenCount, LATENCY_SAMPLE_COUNT);
        assert.equal(ioProbe.metrics.readCallCount, LATENCY_SAMPLE_COUNT);
        assert.equal(ioProbe.metrics.requestedBytes, expectedBytes);
        assert.equal(ioProbe.metrics.returnedBytes, expectedBytes);
        assert.equal(ioProbe.metrics.largestRequestedRead, fixture.byteLength);
        assert.equal(allocationProbe.fullPayloadAllocationCount(), LATENCY_SAMPLE_COUNT);
        assert.deepEqual(
            allocationProbe.fullPayloadAllocationSizes(),
            Array.from({ length: LATENCY_SAMPLE_COUNT }, () => fixture.byteLength)
        );
        assert.equal(allocationProbe.fullPayloadConcatCount(), 0);
        assert.equal(allocationProbe.fullPayloadStringConversionCount(), LATENCY_SAMPLE_COUNT);
        assert.deepEqual(authorityCallMetrics(ioProbe.metrics), {
            pathLstatCount: 32 * LATENCY_SAMPLE_COUNT,
            pathStatCount: 0,
            descriptorStatCount: 2 * LATENCY_SAMPLE_COUNT,
            pathRealpathCount: 32 * LATENCY_SAMPLE_COUNT,
            pathExistsCount: 0,
            pathAccessCount: 0,
            pathReadlinkCount: 0,
            directoryEnumerationCount: 0,
            directFileReadCount: 0
        });
        assertHeapUsageBounded(heapProbe, fixture.byteLength);
    } finally {
        JSON.parse = originalJsonParse;
        allocationProbe.restore();
        ioProbe.restore();
    }
});

test('standalone bounded-tail capture reads and allocates only its configured window', () => {
    const taskId = 'T-PERFORMANCE-BOUNDED-TAIL';
    const fixture = createTimelineFixture(taskId);
    const record = JSON.stringify({ task_id: taskId, sequence: 1, payload: 'x'.repeat(512) });
    const recordCount = Math.ceil((3 * 1024 * 1024) / (Buffer.byteLength(record) + 1));
    fs.writeFileSync(fixture.timelinePath, `${Array.from({ length: recordCount }, () => record).join('\n')}\n`, {
        encoding: 'utf8',
        mode: 0o600
    });
    const configuredWindowBytes = 4096;
    const tailOptions = {
        maxBytes: configuredWindowBytes,
        maxLines: 32,
        maxEvents: 16,
        maxParseAttempts: 16
    };
    readTaskTimelineBoundedJsonlTail<Record<string, unknown>>(fixture.timelinePath, tailOptions);
    const ioProbe = installTimelineReadProbe(fixture.timelinePath);
    const allocationProbe = installBufferAllocationProbe(configuredWindowBytes + 1);
    const heapProbe = createHeapUsageProbe();

    try {
        const latencySamplesMs: number[] = [];
        for (let sampleIndex = 0; sampleIndex < LATENCY_SAMPLE_COUNT; sampleIndex += 1) {
            const startedAt = performance.now();
            const result = readTaskTimelineBoundedJsonlTail<Record<string, unknown>>(
                fixture.timelinePath,
                tailOptions
            );
            latencySamplesMs.push(performance.now() - startedAt);
            assert.equal(result.bytesRead, configuredWindowBytes);
            assert.ok(result.records.length > 0);
            heapProbe.sample();
        }
        assertStableScenarioLatency(latencySamplesMs);

        const expectedBytes = configuredWindowBytes * LATENCY_SAMPLE_COUNT;
        assert.equal(ioProbe.metrics.descriptorOpenCount, LATENCY_SAMPLE_COUNT);
        assert.equal(ioProbe.metrics.readCallCount, LATENCY_SAMPLE_COUNT);
        assert.equal(ioProbe.metrics.requestedBytes, expectedBytes);
        assert.equal(ioProbe.metrics.returnedBytes, expectedBytes);
        assert.equal(ioProbe.metrics.largestRequestedRead, configuredWindowBytes);
        assert.equal(allocationProbe.fullPayloadAllocationCount(), 0);
        assert.deepEqual(allocationProbe.fullPayloadAllocationSizes(), []);
        assert.equal(allocationProbe.fullPayloadConcatCount(), 0);
        assert.equal(allocationProbe.fullPayloadStringConversionCount(), 0);
        assert.deepEqual(authorityCallMetrics(ioProbe.metrics), {
            pathLstatCount: 6 * LATENCY_SAMPLE_COUNT,
            pathStatCount: 0,
            descriptorStatCount: 2 * LATENCY_SAMPLE_COUNT,
            pathRealpathCount: 6 * LATENCY_SAMPLE_COUNT,
            pathExistsCount: 0,
            pathAccessCount: 0,
            pathReadlinkCount: 0,
            directoryEnumerationCount: 0,
            directFileReadCount: 0
        });
        assertHeapUsageBounded(heapProbe, configuredWindowBytes);
    } finally {
        allocationProbe.restore();
        ioProbe.restore();
    }
});

test('repeated canonical appends perform one authenticated payload capture per generation', () => {
    const taskId = 'T-PERFORMANCE-REPEATED-APPEND';
    const fixture = seedSmallTimeline(taskId);
    const initialByteLength = fs.statSync(fixture.timelinePath).size;
    const ioProbe = installTimelineReadProbe(fixture.timelinePath);
    const allocationProbe = installBufferAllocationProbe(initialByteLength);
    const heapProbe = createHeapUsageProbe();
    const generationByteLengths = [initialByteLength];

    try {
        const latencySamplesMs: number[] = [];
        withTaskTimelineReadSnapshot(fixture.eventsRoot, taskId, () => {
            assert.match(readTaskTimelineTextFile(fixture.timelinePath), /PERFORMANCE_ACCEPTANCE_SEED/);
            for (let index = 0; index < LATENCY_SAMPLE_COUNT; index += 1) {
                const startedAt = performance.now();
                const result = appendTaskEvent(
                    fixture.orchestratorRoot,
                    taskId,
                    `PERFORMANCE_ACCEPTANCE_APPEND_${index + 1}`,
                    'PASS',
                    `Measured append ${index + 1}`,
                    { index },
                    { passThru: true, lowNoiseRuntimeWrites: true }
                );
                assert.equal(result?.commit_status, 'committed');
                generationByteLengths.push(ioProbe.withoutRecording(() => fs.statSync(fixture.timelinePath).size));
                assert.match(readTaskTimelineTextFile(fixture.timelinePath), /PERFORMANCE_ACCEPTANCE_APPEND_/);
                heapProbe.sample();
                latencySamplesMs.push(performance.now() - startedAt);
            }

            const parseCallsBeforeInspection = ioProbe.metrics.readCallCount;
            assert.equal(inspectTaskEventFile(fixture.timelinePath, taskId).status, 'PASS');
            assert.equal(inspectTaskEventFile(fixture.timelinePath, taskId).status, 'PASS');
            assert.equal(ioProbe.metrics.readCallCount, parseCallsBeforeInspection);
        });
        assertStableScenarioLatency(latencySamplesMs);

        const expectedGenerationBytes = generationByteLengths.reduce((total, byteLength) => total + byteLength, 0);
        assert.equal(ioProbe.metrics.descriptorOpenCount, generationByteLengths.length);
        assert.equal(ioProbe.metrics.readCallCount, generationByteLengths.length);
        assert.equal(ioProbe.metrics.requestedBytes, expectedGenerationBytes);
        assert.equal(ioProbe.metrics.returnedBytes, expectedGenerationBytes);
        assert.equal(ioProbe.metrics.largestRequestedRead, generationByteLengths.at(-1));
        assert.equal(allocationProbe.fullPayloadAllocationCount(), generationByteLengths.length);
        assert.deepEqual(allocationProbe.fullPayloadAllocationSizes(), generationByteLengths);
        assert.equal(allocationProbe.fullPayloadConcatCount(), 0);
        assert.equal(allocationProbe.fullPayloadStringConversionCount(), generationByteLengths.length);
        assert.deepEqual(authorityCallMetrics(ioProbe.metrics), {
            pathLstatCount: (32 * LATENCY_SAMPLE_COUNT) + 4,
            pathStatCount: 2 * LATENCY_SAMPLE_COUNT,
            descriptorStatCount: (5 * LATENCY_SAMPLE_COUNT) + 2,
            pathRealpathCount: (31 * LATENCY_SAMPLE_COUNT) + 4,
            pathExistsCount: 0,
            pathAccessCount: 0,
            pathReadlinkCount: 0,
            directoryEnumerationCount: 0,
            directFileReadCount: 0
        });
        assertHeapUsageBounded(heapProbe, generationByteLengths.at(-1) || initialByteLength);
    } finally {
        allocationProbe.restore();
        ioProbe.restore();
    }
});

test('overlapping invocations keep independent bounded generations without a recovery reread', async () => {
    const taskId = 'T-PERFORMANCE-OVERLAPPING';
    const fixture = seedSmallTimeline(taskId);
    const initialByteLength = fs.statSync(fixture.timelinePath).size;
    withTaskTimelineReadSnapshot(fixture.eventsRoot, taskId, () => {
        readTaskTimelineTextFile(fixture.timelinePath);
    });
    const ioProbe = installTimelineReadProbe(fixture.timelinePath);
    const allocationProbe = installBufferAllocationProbe(initialByteLength);
    const heapProbe = createHeapUsageProbe();

    try {
        const latencySamplesMs: number[] = [];
        const generationByteLengths: number[] = [];
        for (let index = 0; index < LATENCY_SAMPLE_COUNT; index += 1) {
            const beforeAppendByteLength = ioProbe.withoutRecording(() => fs.statSync(fixture.timelinePath).size);
            let releaseFirst!: () => void;
            let signalFirstReady!: () => void;
            const firstReady = new Promise<void>((resolve) => {
                signalFirstReady = resolve;
            });
            const firstRelease = new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
            const startedAt = performance.now();
            const firstInvocation = withTaskTimelineReadSnapshot(fixture.eventsRoot, taskId, async () => {
                readTaskTimelineTextFile(fixture.timelinePath);
                signalFirstReady();
                await firstRelease;
                assert.throws(() => readTaskTimelineTextFile(fixture.timelinePath), /snapshot is unavailable/);
            });
            await firstReady;

            await withTaskTimelineReadSnapshot(fixture.eventsRoot, taskId, async () => {
                const result = appendTaskEvent(
                    fixture.orchestratorRoot,
                    taskId,
                    `PERFORMANCE_ACCEPTANCE_OVERLAP_${index + 1}`,
                    'PASS',
                    `Measured overlapping append ${index + 1}`,
                    { index },
                    { passThru: true, lowNoiseRuntimeWrites: true }
                );
                assert.equal(result?.commit_status, 'committed');
                assert.match(readTaskTimelineTextFile(fixture.timelinePath), /PERFORMANCE_ACCEPTANCE_OVERLAP_/);
                heapProbe.sample();
            });
            const appendedByteLength = ioProbe.withoutRecording(() => fs.statSync(fixture.timelinePath).size);
            generationByteLengths.push(beforeAppendByteLength, beforeAppendByteLength, appendedByteLength);

            releaseFirst();
            await firstInvocation;
            heapProbe.sample();
            latencySamplesMs.push(performance.now() - startedAt);
        }
        assertStableScenarioLatency(latencySamplesMs);

        const expectedGenerationBytes = generationByteLengths.reduce((total, byteLength) => total + byteLength, 0);
        assert.equal(ioProbe.metrics.descriptorOpenCount, generationByteLengths.length);
        assert.equal(ioProbe.metrics.readCallCount, generationByteLengths.length);
        assert.equal(ioProbe.metrics.requestedBytes, expectedGenerationBytes);
        assert.equal(ioProbe.metrics.returnedBytes, expectedGenerationBytes);
        assert.equal(ioProbe.metrics.largestRequestedRead, generationByteLengths.at(-1));
        assert.equal(allocationProbe.fullPayloadAllocationCount(), generationByteLengths.length);
        assert.deepEqual(allocationProbe.fullPayloadAllocationSizes(), generationByteLengths);
        assert.equal(allocationProbe.fullPayloadConcatCount(), 0);
        assert.equal(allocationProbe.fullPayloadStringConversionCount(), generationByteLengths.length);
        assert.deepEqual(authorityCallMetrics(ioProbe.metrics), {
            pathLstatCount: 41 * LATENCY_SAMPLE_COUNT,
            pathStatCount: 2 * LATENCY_SAMPLE_COUNT,
            descriptorStatCount: 9 * LATENCY_SAMPLE_COUNT,
            pathRealpathCount: 40 * LATENCY_SAMPLE_COUNT,
            pathExistsCount: 0,
            pathAccessCount: 0,
            pathReadlinkCount: 0,
            directoryEnumerationCount: 0,
            directFileReadCount: 0
        });
        assertHeapUsageBounded(heapProbe, generationByteLengths.at(-1) || initialByteLength);
    } finally {
        allocationProbe.restore();
        ioProbe.restore();
    }
});
