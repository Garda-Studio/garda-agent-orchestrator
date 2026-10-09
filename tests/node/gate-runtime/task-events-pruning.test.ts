import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    appendTaskEvent,
    appendTaskEventAsync,
    inspectTaskEventFile,
    pruneAggregateLog,
    pruneAggregateLogLocked
} from '../../../src/gate-runtime/task-events';
import {
    resolveTaskEventsModulePath,
    runConcurrentAppendWorker,
    runConcurrentPruneWorker
} from './task-events-test-helpers';
import {
    appendAggregateEventSync,
    appendAggregateEventAsync,
    applyAggregateRetentionSync,
    applyAggregateRetentionAsync
} from '../../../src/gate-runtime/timeline/task-events-retention';


test('appendTaskEvent preserves integrity under concurrent process writes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-concurrent-'));
    const modulePath = resolveTaskEventsModulePath();
    const startSignalPath = path.join(tempDir, 'start.signal');
    const workerCount = 3;
    const attemptsPerWorker = 3;

    try {
        const workers = [];
        for (let index = 0; index < workerCount; index += 1) {
            workers.push(
                runConcurrentAppendWorker(
                    modulePath,
                    tempDir,
                    startSignalPath,
                    attemptsPerWorker,
                    10
                )
            );
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
        fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
        await Promise.all(workers);

        const expectedCount = workerCount * attemptsPerWorker;
        const eventFile = path.join(tempDir, 'runtime', 'task-events', 'T-CONCURRENT.jsonl');
        const allTasksFile = path.join(tempDir, 'runtime', 'task-events', 'all-tasks.jsonl');
        const result = inspectTaskEventFile(eventFile, 'T-CONCURRENT');
        const aggregateLines = fs.readFileSync(allTasksFile, 'utf8').split('\n').filter((line) => line.trim());

        assert.equal(result.status, 'PASS');
        assert.equal(result.matching_events, expectedCount);
        assert.equal(result.integrity_event_count, expectedCount);
        assert.equal(result.violations.length, 0);
        assert.equal(aggregateLines.length, expectedCount);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('appendTaskEvent triggers locked prune when aggregate log exceeds size threshold', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-locked-prune-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        fs.mkdirSync(eventsRoot, { recursive: true });
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');

        // Pre-fill the aggregate log with enough data to exceed the prune threshold
        // aggregateMaxLines=5 means threshold ~ 5 * 512 = 2560 bytes
        const bigLine = JSON.stringify({
            timestamp_utc: new Date().toISOString(),
            task_id: 'T-FILL',
            event_type: 'filler',
            outcome: 'PASS',
            actor: 'test',
            message: 'x'.repeat(400),
            details: null
        });
        const lines = [];
        for (let i = 0; i < 20; i++) {
            lines.push(bigLine);
        }
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-PRUNE-TRIGGER',
            'test',
            'PASS',
            'Should trigger pruning with locked mode',
            null,
            {
                passThru: true,
                aggregateMaxLines: 5
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0, 'append should succeed');
        assert.equal(result!.lock_telemetry!.aggregate_append_mode, 'locked_prune',
            'should report locked_prune when pruning was triggered');
        assert.ok(result!.aggregate_retention != null, 'aggregate_retention should be present');
        assert.ok(result!.aggregate_retention!.pruned, 'should have pruned');
        assert.ok(
            result!.aggregate_retention!.lines_after <= 5,
            `pruned lines should be at most 5 (got ${result!.aggregate_retention!.lines_after})`
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('appendTaskEventAsync preserves concurrent aggregate entries when each append triggers locked pruning', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-concurrent-prune-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
        const modulePath = resolveTaskEventsModulePath();
        const startSignalPath = path.join(tempDir, 'start.signal');
        const workerCount = 4;
        const attemptsPerWorker = 10;
        const aggregateMaxLines = 260;
        fs.mkdirSync(eventsRoot, { recursive: true });

        const fillerLines = Array.from({ length: 320 }, (_, index) =>
            JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: `T-FILL-${index}`,
                event_type: 'filler',
                outcome: 'PASS',
                actor: 'test',
                message: 'y'.repeat(700),
                details: { index }
            })
        );
        fs.writeFileSync(allTasksPath, fillerLines.join('\n') + '\n', 'utf8');

        const workers = Array.from({ length: workerCount }, () =>
            runConcurrentAppendWorker(
                modulePath,
                tempDir,
                startSignalPath,
                attemptsPerWorker,
                1,
                aggregateMaxLines
            )
        );

        fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
        await Promise.all(workers);

        const expectedAppends = workerCount * attemptsPerWorker;
        const taskFile = path.join(eventsRoot, 'T-CONCURRENT.jsonl');
        const taskLines = fs.readFileSync(taskFile, 'utf8')
            .split('\n')
            .filter((line) => line.trim());
        assert.equal(taskLines.length, expectedAppends, 'per-task log should retain every concurrent append');

        const aggregateEntries = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as { task_id?: string });
        const concurrentEntries = aggregateEntries.filter((entry) => entry.task_id === 'T-CONCURRENT');
        assert.equal(
            concurrentEntries.length,
            expectedAppends,
            'aggregate log should retain every concurrent append even while pruning'
        );
        assert.ok(
            aggregateEntries.length <= aggregateMaxLines,
            `aggregate log should remain pruned to ${aggregateMaxLines} lines (got ${aggregateEntries.length})`
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEventAsync preserves concurrent aggregate entries while pruneAggregateLogLocked runs in parallel', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-append-vs-prune-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
        const modulePath = resolveTaskEventsModulePath();
        const startSignalPath = path.join(tempDir, 'start-prune.signal');
        const workerCount = 4;
        const attemptsPerWorker = 10;
        const pruneAttempts = 8;
        const aggregateMaxLines = 260;
        fs.mkdirSync(eventsRoot, { recursive: true });

        const fillerLines = Array.from({ length: 320 }, (_, index) =>
            JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: `T-PRUNE-FILL-${index}`,
                event_type: 'filler',
                outcome: 'PASS',
                actor: 'test',
                message: 'z'.repeat(900),
                details: { index }
            })
        );
        fs.writeFileSync(allTasksPath, fillerLines.join('\n') + '\n', 'utf8');

        const appendWorkers = Array.from({ length: workerCount }, () =>
            runConcurrentAppendWorker(
                modulePath,
                tempDir,
                startSignalPath,
                attemptsPerWorker,
                1,
                aggregateMaxLines
            )
        );
        const pruneWorker = runConcurrentPruneWorker(
            modulePath,
            eventsRoot,
            startSignalPath,
            pruneAttempts,
            aggregateMaxLines
        );

        fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
        await Promise.all([...appendWorkers, pruneWorker]);

        const expectedAppends = workerCount * attemptsPerWorker;
        const taskFile = path.join(eventsRoot, 'T-CONCURRENT.jsonl');
        const taskLines = fs.readFileSync(taskFile, 'utf8')
            .split('\n')
            .filter((line) => line.trim());
        assert.equal(taskLines.length, expectedAppends, 'per-task log should retain every append during prune overlap');

        const aggregateEntries = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as { task_id?: string });
        const concurrentEntries = aggregateEntries.filter((entry) => entry.task_id === 'T-CONCURRENT');
        assert.equal(
            concurrentEntries.length,
            expectedAppends,
            'aggregate log should retain every append even when pruneAggregateLogLocked runs in parallel'
        );
        assert.ok(
            aggregateEntries.length <= aggregateMaxLines,
            `aggregate log should remain pruned to ${aggregateMaxLines} lines (got ${aggregateEntries.length})`
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// pruneAggregateLog — unit tests

test('pruneAggregateLog returns no-op for missing file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-missing-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        const result = pruneAggregateLog(allTasksPath, 100);
        assert.equal(result.pruned, false);
        assert.equal(result.lines_before, 0);
        assert.equal(result.lines_after, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog returns no-op for empty file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-empty-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        fs.writeFileSync(allTasksPath, '', 'utf8');
        const result = pruneAggregateLog(allTasksPath, 100);
        assert.equal(result.pruned, false);
        assert.equal(result.lines_before, 0);
        assert.equal(result.lines_after, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog returns no-op when lines are within limit', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-noop-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 5 }, (_, i) =>
            JSON.stringify({ task_id: `T-${i}`, event: 'test' })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');
        const result = pruneAggregateLog(allTasksPath, 10);
        assert.equal(result.pruned, false);
        assert.equal(result.lines_before, 5);
        assert.equal(result.lines_after, 5);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog keeps most recent lines when over limit', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-trim-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 20 }, (_, i) =>
            JSON.stringify({ seq: i, task_id: `T-${i}` })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneAggregateLog(allTasksPath, 5);
        assert.equal(result.pruned, true);
        assert.equal(result.lines_before, 20);
        assert.equal(result.lines_after, 5);

        // Verify retained lines are the last 5
        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 5);
        for (let i = 0; i < 5; i++) {
            const parsed = JSON.parse(remaining[i]);
            assert.equal(parsed.seq, 15 + i, `retained line ${i} should be seq ${15 + i}`);
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog prunes protected aggregate lines without full-file reads', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-protected-streaming-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 1200 }, (_, i) =>
            JSON.stringify({
                seq: i,
                task_id: i % 100 === 0 ? 'T-999-1' : `T-${String(i).padStart(3, '0')}`,
                message: 'x'.repeat(80)
            })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const realFs = require('node:fs');
        const originalReadFileSync = realFs.readFileSync;
        try {
            realFs.readFileSync = function (...args: any[]) {
                if (args[0] === allTasksPath) {
                    throw new Error('protected aggregate prune must not read the whole aggregate file');
                }
                return originalReadFileSync.apply(realFs, args);
            };

            const result = pruneAggregateLog(allTasksPath, 50, undefined, new Set(['T-999-1']));
            assert.equal(result.pruned, true);
            assert.equal(result.lines_before, 1200);
            assert.ok(result.lines_after >= 50, 'protected lines can make retained output exceed maxLines');
        } finally {
            realFs.readFileSync = originalReadFileSync;
        }

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim())
            .map((line) => JSON.parse(line) as { seq: number; task_id: string });
        assert.ok(
            remaining.filter((entry) => entry.task_id === 'T-999-1').length >= 12,
            'all protected task lines should remain'
        );
        assert.ok(
            remaining.some((entry) => entry.seq >= 1150),
            'recent unprotected lines should remain after pruning'
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog preserves the aggregate when final rename fails', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-rename-failure-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 20 }, (_, i) =>
            JSON.stringify({ seq: i, task_id: `T-${i}` })
        );
        const originalContent = lines.join('\n') + '\n';
        fs.writeFileSync(allTasksPath, originalContent, 'utf8');

        const realFs = require('node:fs');
        const originalRenameSync = realFs.renameSync;
        try {
            realFs.renameSync = function (...args: any[]) {
                if (args[1] === allTasksPath) {
                    throw new Error('simulated aggregate rename failure');
                }
                return originalRenameSync.apply(realFs, args);
            };

            const result = pruneAggregateLog(allTasksPath, 5);
            assert.equal(result.pruned, false);
            assert.equal(result.lines_before, 20);
            assert.equal(result.lines_after, 20);
        } finally {
            realFs.renameSync = originalRenameSync;
        }

        assert.equal(fs.readFileSync(allTasksPath, 'utf8'), originalContent);
        assert.deepStrictEqual(
            fs.readdirSync(tempDir).filter((entry) => entry.includes('.tmp-')),
            []
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog accepts knownLineCount to skip counting', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-known-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 10 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneAggregateLog(allTasksPath, 3, 10);
        assert.equal(result.pruned, true);
        assert.equal(result.lines_before, 10);
        assert.equal(result.lines_after, 3);

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 3);
        assert.equal(JSON.parse(remaining[0]).seq, 7);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog with maxLines=0 disables pruning', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-disabled-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        fs.writeFileSync(allTasksPath, '{"line":1}\n{"line":2}\n', 'utf8');
        const result = pruneAggregateLog(allTasksPath, 0);
        assert.equal(result.pruned, false);
        assert.equal(result.lines_before, 0);
        assert.equal(result.lines_after, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog handles file with only newlines gracefully', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-newlines-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        fs.writeFileSync(allTasksPath, '\n\n\n', 'utf8');
        const result = pruneAggregateLog(allTasksPath, 5);
        assert.equal(result.pruned, false);
        assert.equal(result.lines_before, 0);
        assert.equal(result.lines_after, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('pruneAggregateLogLocked prunes under filesystem lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-locked-'));
    try {
        const eventsRoot = path.join(tempDir, 'task-events');
        fs.mkdirSync(eventsRoot, { recursive: true });
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
        const lines = Array.from({ length: 15 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneAggregateLogLocked(eventsRoot, 5);
        assert.equal(result.pruned, true);
        assert.equal(result.lines_before, 15);
        assert.equal(result.lines_after, 5);

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 5);
        assert.equal(JSON.parse(remaining[0]).seq, 10);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLogLocked no-op when file is within limit', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-locked-noop-'));
    try {
        const eventsRoot = path.join(tempDir, 'task-events');
        fs.mkdirSync(eventsRoot, { recursive: true });
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
        fs.writeFileSync(allTasksPath, '{"a":1}\n{"a":2}\n', 'utf8');

        const result = pruneAggregateLogLocked(eventsRoot, 100);
        assert.equal(result.pruned, false);
        assert.equal(result.lines_before, 2);
        assert.equal(result.lines_after, 2);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});


test('appendTaskEvent prunes aggregate when aggregateMaxLines exceeded', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-append-prune-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        fs.mkdirSync(eventsRoot, { recursive: true });
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');

        // Pre-populate with lines whose total size exceeds the size trigger (4MB).
        const bigPayload = 'x'.repeat(600);
        const preLines = Array.from({ length: 8000 }, (_, i) =>
            JSON.stringify({ seq: i, data: bigPayload })
        );
        fs.writeFileSync(allTasksPath, preLines.join('\n') + '\n', 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-AGG-PRUNE',
            'test',
            'PASS',
            'trigger prune',
            {},
            { passThru: true, eventsRoot, aggregateMaxLines: 5000 }
        );

        assert.ok(result !== null, 'append result must not be null');
        if (result!.aggregate_retention) {
            assert.equal(result!.aggregate_retention.pruned, true, 'aggregate should be pruned');
            assert.ok(result!.aggregate_retention.lines_after <= 5000,
                `lines_after should be <= 5000 (got ${result!.aggregate_retention.lines_after})`);
        }

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.ok(remaining.length <= 5001, `aggregate should have at most 5001 lines (got ${remaining.length})`);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent does not prune when aggregateMaxLines is 0 (disabled)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-noprune-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        fs.mkdirSync(eventsRoot, { recursive: true });
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
        const preLines = Array.from({ length: 100 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, preLines.join('\n') + '\n', 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-AGG-NOPRUNE',
            'test',
            'PASS',
            'no prune',
            {},
            { passThru: true, eventsRoot, aggregateMaxLines: 0 }
        );

        assert.ok(result !== null);
        assert.equal(result!.aggregate_retention, undefined, 'no retention info when disabled');

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 101, 'all original lines plus new append');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEventAsync prunes aggregate when aggregateMaxLines exceeded', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-async-prune-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        fs.mkdirSync(eventsRoot, { recursive: true });
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');

        const bigPayload = 'x'.repeat(600);
        const preLines = Array.from({ length: 8000 }, (_, i) =>
            JSON.stringify({ seq: i, data: bigPayload })
        );
        fs.writeFileSync(allTasksPath, preLines.join('\n') + '\n', 'utf8');

        const result = await appendTaskEventAsync(
            tempDir,
            'T-AGG-ASYNC-PRUNE',
            'test',
            'PASS',
            'trigger async prune',
            {},
            { passThru: true, eventsRoot, aggregateMaxLines: 5000 }
        );

        assert.ok(result !== null, 'async append result must not be null');
        if (result!.aggregate_retention) {
            assert.equal(result!.aggregate_retention.pruned, true, 'aggregate should be pruned');
            assert.ok(result!.aggregate_retention.lines_after <= 5000,
                `lines_after should be <= 5000 (got ${result!.aggregate_retention.lines_after})`);
        }

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.ok(remaining.length <= 5001, `aggregate should have at most 5001 lines (got ${remaining.length})`);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// pruneAggregateLog — JSON integrity on retained lines

test('pruneAggregateLog preserves valid JSON on each retained line', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-json-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 30 }, (_, i) =>
            JSON.stringify({ timestamp_utc: new Date().toISOString(), task_id: `T-${i}`, event_type: 'test', outcome: 'PASS', actor: 'gate', message: `Event ${i}`, details: { num: i } })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneAggregateLog(allTasksPath, 10);
        assert.equal(result.pruned, true);
        assert.equal(result.lines_after, 10);

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());

        for (let i = 0; i < remaining.length; i++) {
            let parsed: unknown;
            assert.doesNotThrow(() => { parsed = JSON.parse(remaining[i]); },
                `Line ${i} must be valid JSON`);
            const obj = parsed as Record<string, unknown>;
            assert.ok(obj.task_id, `Line ${i} must have task_id`);
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

for (const mode of ['sync', 'async'] as const) {
    test(`automatic aggregate ${mode} append bounds repeated pruning for large records at the cap`, async (t) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-batched-'));
        const aggregate = path.join(tempDir, 'all-tasks.jsonl');
        const lock = path.join(tempDir, '.all-tasks.lock');
        const maxLines = 1000;
        const appends = 64;
        const payload = 'x'.repeat(2048);
        const mutableFs = require('node:fs') as typeof fs;
        try {
            const seed = Array.from({ length: maxLines }, (_, index) => JSON.stringify({ task_id: 'T-BATCH', index, payload }));
            fs.writeFileSync(aggregate, seed.join('\n') + '\n', 'utf8');
            const initialBytes = fs.statSync(aggregate).size;
            const reads = t.mock.method(mutableFs, 'readSync');
            const replacements = t.mock.method(mutableFs, 'renameSync');
            for (let index = maxLines; index < maxLines + appends; index += 1) {
                const line = JSON.stringify({ task_id: 'T-BATCH', index, payload });
                if (mode === 'sync') appendAggregateEventSync(aggregate, lock, line, maxLines);
                else await appendAggregateEventAsync(aggregate, lock, line, maxLines);
            }
            const bytesRead = reads.mock.calls.reduce((sum, call) => sum + Number(call.result || 0), 0);
            const pruneCount = replacements.mock.calls.filter(call => String(call.arguments[1]) === aggregate).length;
            t.mock.restoreAll();
            const retained = fs.readFileSync(aggregate, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { index: number });
            assert.ok(retained.length <= maxLines && retained.length >= maxLines * 0.99, 'retain the newest history within the cap and bounded headroom');
            assert.deepEqual(retained.slice(-appends).map(row => row.index), Array.from({ length: appends }, (_, step) => maxLines + step));
            assert.ok(pruneCount <= 8, `64 appends should not rewrite the entire aggregate each time (got ${pruneCount})`);
            assert.ok(bytesRead <= initialBytes * 12, `bounded observed readSync work expected; got ${bytesRead} bytes for ${initialBytes}-byte history`);
        } finally {
            t.mock.restoreAll();
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test(`automatic aggregate ${mode} retention avoids rescanning unchanged large history at the cap`, async (t) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-retention-noop-'));
        const aggregate = path.join(tempDir, 'all-tasks.jsonl');
        const lock = path.join(tempDir, '.all-tasks.lock');
        const mutableFs = require('node:fs') as typeof fs;
        try {
            const original = Array.from({ length: 1000 }, (_, index) => JSON.stringify({ task_id: 'T-NOOP', index, payload: 'x'.repeat(2048) })).join('\n') + '\n';
            fs.writeFileSync(aggregate, original, 'utf8');
            const reads = t.mock.method(mutableFs, 'readSync');
            for (let attempt = 0; attempt < 64; attempt += 1) {
                if (mode === 'sync') applyAggregateRetentionSync(aggregate, lock, 1000);
                else await applyAggregateRetentionAsync(aggregate, lock, 1000);
            }
            const bytesRead = reads.mock.calls.reduce((sum, call) => sum + Number(call.result || 0), 0);
            t.mock.restoreAll();
            assert.equal(fs.readFileSync(aggregate, 'utf8'), original);
            assert.ok(bytesRead <= Buffer.byteLength(original) * 2, `unchanged history should require one bounded scan, got ${bytesRead} bytes`);
        } finally {
            t.mock.restoreAll();
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
}

for (const mutation of ['same-inode-rewrite', 'replacement'] as const) {
    test(`automatic aggregate retention recounts a same-size ${mutation} and a decreased cap`, () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-count-drift-'));
        const aggregate = path.join(tempDir, 'all-tasks.jsonl');
        const lock = path.join(tempDir, '.all-tasks.lock');
        try {
            const seed = Array.from({ length: 200 }, (_, index) => JSON.stringify({ task_id: 'T-DRIFT', index, payload: 'x'.repeat(2048) }));
            fs.writeFileSync(aggregate, seed.join('\n') + '\n', 'utf8');
            appendAggregateEventSync(aggregate, lock, JSON.stringify({ task_id: 'T-DRIFT', index: 200 }), 200);
            const before = fs.statSync(aggregate);
            const changed = Array.from({ length: 201 }, (_, index) => JSON.stringify({ task_id: 'T-DRIFT', index, payload: '' }));
            const padding = before.size - Buffer.byteLength(changed.join('\n') + '\n');
            assert.ok(padding > 0);
            changed[200] = JSON.stringify({ task_id: 'T-DRIFT', index: 200, payload: 'x'.repeat(padding) });
            const contents = changed.join('\n') + '\n';
            assert.equal(Buffer.byteLength(contents), before.size);
            if (mutation === 'replacement') {
                fs.writeFileSync(`${aggregate}.replacement`, contents, 'utf8');
                fs.renameSync(`${aggregate}.replacement`, aggregate);
                assert.notEqual(fs.statSync(aggregate).ino, before.ino);
            } else {
                fs.writeFileSync(aggregate, contents, 'utf8');
                assert.equal(fs.statSync(aggregate).ino, before.ino);
            }
            appendAggregateEventSync(aggregate, lock, JSON.stringify({ task_id: 'T-DRIFT', index: 201 }), 200);
            let retained = fs.readFileSync(aggregate, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { index: number });
            assert.ok(retained.length <= 200, 'recount changed content rather than use stale advisory state');
            assert.equal(retained.at(-1)?.index, 201);
            applyAggregateRetentionSync(aggregate, lock, 50);
            retained = fs.readFileSync(aggregate, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { index: number });
            assert.equal(retained.length, 50, 'a smaller configured cap takes effect immediately');
            assert.equal(retained.at(-1)?.index, 201);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
}

test('automatic aggregate retention preserves a failed-prune append and retries after atomic replacement recovers', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-retry-'));
    const aggregate = path.join(tempDir, 'all-tasks.jsonl');
    const lock = path.join(tempDir, '.all-tasks.lock');
    const mutableFs = require('node:fs') as typeof fs;
    try {
        const seed = Array.from({ length: 200 }, (_, index) => JSON.stringify({ task_id: 'T-RETRY', index, payload: 'x'.repeat(2048) }));
        fs.writeFileSync(aggregate, seed.join('\n') + '\n', 'utf8');
        const rename = mutableFs.renameSync;
        t.mock.method(mutableFs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
            if (String(destination) === aggregate) throw new Error('injected aggregate final rename failure');
            return rename(source, destination);
        });
        const failed = appendAggregateEventSync(aggregate, lock, JSON.stringify({ task_id: 'T-RETRY', index: 200 }), 200);
        assert.equal(failed.retention?.pruned, false);
        assert.equal(fs.readFileSync(aggregate, 'utf8').trim().split('\n').length, 201);
        t.mock.restoreAll();
        appendAggregateEventSync(aggregate, lock, JSON.stringify({ task_id: 'T-RETRY', index: 201 }), 200);
        const retained = fs.readFileSync(aggregate, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { index: number });
        assert.ok(retained.length <= 200);
        assert.deepEqual(retained.slice(-2).map(row => row.index), [200, 201]);
    } finally {
        t.mock.restoreAll();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
