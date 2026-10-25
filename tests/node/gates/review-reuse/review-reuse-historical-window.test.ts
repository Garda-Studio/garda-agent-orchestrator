import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { readTimelineEventsSummary } from '../../../../src/cli/commands/gate-flows/review-context/review-context-command-binding';
import {
    resolveHistoricalGroupedReuseWindow,
    type HistoricalGroupedReuseWindowOptions
} from '../../../../src/gates/review-reuse/review-reuse-historical-window';

const taskId = 'T-77';
const originalHash = '0'.repeat(64);
const preflightHash = '1'.repeat(64);
const receiptHash = '2'.repeat(64);
const foreignHash = 'f'.repeat(64);
interface NativeEvent {
    type: string;
    actor?: string;
    outcome?: string;
    details: Record<string, unknown>;
}
type MutateEvents = (events: NativeEvent[]) => void;

function fixture(t: TestContext, mutate: MutateEvents = () => {}): {
    options: HistoricalGroupedReuseWindowOptions; timelinePath: string;
} {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-historical-window-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const preflightPath = path.join(orchestratorRoot, 'runtime', 'preflight.json');
    const events: NativeEvent[] = [
        { type: 'REVIEW_RECORDED', details: { task_id: taskId, review_type: 'code', receipt_sha256: originalHash } },
        { type: 'PREFLIGHT_CLASSIFIED', outcome: 'INFO', details: { output_path: preflightPath } },
        { type: 'COMPILE_GATE_PASSED', details: {
            task_id: taskId, preflight_path: preflightPath, preflight_hash_sha256: preflightHash
        } },
        { type: 'REVIEW_RECORDED', details: {
            task_id: taskId, review_type: 'code', receipt_sha256: receiptHash, preflight_sha256: preflightHash
        } },
        { type: 'COMPILE_GATE_PASSED', details: {
            task_id: taskId, preflight_path: preflightPath, preflight_hash_sha256: foreignHash
        } }
    ];
    mutate(events);
    for (const event of events) {
        appendTaskEvent(orchestratorRoot, taskId, event.type, event.outcome || 'PASS',
            'Native historical-window fixture.', event.details, { actor: event.actor || 'gate' });
    }
    const timelinePath = path.join(orchestratorRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
    const timelineEvents = readTimelineEventsSummary(timelinePath).events;
    const sourceEvent = timelineEvents.find(event => event.details?.receipt_sha256 === receiptHash);
    assert.ok(sourceEvent, 'fixture must retain the candidate source event');
    const currentCompile = [...timelineEvents].reverse().find(event => event.event_type === 'COMPILE_GATE_PASSED');
    assert.ok(currentCompile);
    return {
        timelinePath,
        options: {
            repoRoot, taskId, reviewType: 'code', receiptSha256: receiptHash,
            receipt: { preflight_sha256: preflightHash, reused_from_receipt_sha256: originalHash, review_execution_mode: 'FULL' },
            sourceEvent, timelineEvents, latestCompilePassSequence: currentCompile.sequence
        }
    };
}

function restart(mode = 'FULL', invalidated = false): NativeEvent {
    return { type: 'REVIEW_CYCLE_RESTARTED', details: {
        authoritative_review_decision: { lane_decisions: [{ review_type: 'code', mode, invalidated }] }
    } };
}

test('historical grouped reuse selects its native compile and excludes later telemetry', t => {
    const { options } = fixture(t, events => events.push({
        type: 'REVIEW_RECORDED', details: { task_id: taskId, review_type: 'code', receipt_sha256: foreignHash }
    }));
    const result = resolveHistoricalGroupedReuseWindow(options);
    assert.ok(result);
    assert.equal(result.compileSequence, 2);
    assert.deepEqual(result.events, options.timelineEvents.slice(0, 4));
    assert.ok(result.events.every(event => event.sequence <= options.sourceEvent.sequence));
});

test('historical grouped reuse accepts a noninvalidating restart preserving the lane mode', t => {
    const { options } = fixture(t, events => events.splice(1, 0, restart()));
    assert.ok(resolveHistoricalGroupedReuseWindow(options));
});

const nativeFailures: Array<[string, MutateEvents]> = [
    ['missing historical compile', events => { events.splice(2, 1); }],
    ['nearest foreign preflight despite an older matching compile', events => {
        events.splice(3, 0, { ...events[2], details: { ...events[2].details, preflight_hash_sha256: foreignHash } });
    }],
    ['compile missing preflight hash', events => { delete events[2].details.preflight_hash_sha256; }],
    ['compile from another actor', events => { events[2].actor = 'agent'; }],
    ['compile with failed outcome', events => { events[2].outcome = 'FAIL'; }],
    ['compile for another task', events => { events[2].details.task_id = 'T-88'; }],
    ['current compile for another task', events => { events[4].details.task_id = 'T-88'; }],
    ['missing classified preflight', events => { events.splice(1, 1); }],
    ['nearest foreign classified path despite an older matching one', events => {
        events.splice(2, 0, { type: 'PREFLIGHT_CLASSIFIED', outcome: 'INFO', details: { output_path: 'foreign.json' } });
    }],
    ['classified preflight from another actor', events => { events[1].actor = 'agent'; }],
    ['classified preflight failed', events => { events[1].outcome = 'FAIL'; }],
    ['compile path outside the repository', events => { events[2].details.preflight_path = '../outside.json'; }],
    ['source from another actor', events => { events[3].actor = 'agent'; }],
    ['source with failed outcome', events => { events[3].outcome = 'FAIL'; }],
    ['source for another task', events => { events[3].details.task_id = 'T-88'; }],
    ['source for another lane', events => { events[3].details.review_type = 'test'; }],
    ['source with foreign preflight hash', events => { events[3].details.preflight_sha256 = foreignHash; }],
    ['missing original source', events => { events.splice(0, 1); }],
    ['invalidating restart before source', events => { events.splice(1, 0, restart('FULL', true)); }],
    ['lane mode drift before source', events => { events.splice(1, 0, restart('DELTA')); }],
    ['restart lacking lane authority', events => { events.splice(1, 0, { type: 'REVIEW_CYCLE_RESTARTED', details: {} }); }],
    ['preserving restart after source', events => { events.splice(4, 0, restart()); }],
    ['late preserving restart after current compile', events => { events.push(restart()); }],
    ['invalidating restart after source', events => { events.splice(4, 0, restart('FULL', true)); }],
    ['late invalidating restart after current compile', events => { events.push(restart('FULL', true)); }],
    ['late lane mode drift after current compile', events => { events.push(restart('DELTA')); }]
];
for (const [name, mutate] of nativeFailures) {
    test(`historical grouped reuse rejects ${name}`, t => {
        const { options } = fixture(t, mutate);
        assert.equal(resolveHistoricalGroupedReuseWindow(options), null);
    });
}

for (const missing of [true, false]) {
    test(`historical grouped reuse rejects ${missing ? 'missing' : 'foreign'} source integrity`, t => {
        const { options } = fixture(t);
        options.sourceEvent = {
            ...options.sourceEvent,
            integrity: missing ? null : { ...options.sourceEvent.integrity!, event_sha256: foreignHash }
        };
        assert.equal(resolveHistoricalGroupedReuseWindow(options), null);
    });
}

test('historical grouped reuse rejects native timeline tampering', t => {
    const { options, timelinePath } = fixture(t);
    fs.writeFileSync(timelinePath, fs.readFileSync(timelinePath, 'utf8').replace('Native historical-window fixture.', 'Tampered.'));
    assert.equal(resolveHistoricalGroupedReuseWindow(options), null);
});

test('historical grouped reuse rejects a source absent from the native timeline', t => {
    const { options, timelinePath } = fixture(t);
    fs.writeFileSync(timelinePath, fs.readFileSync(timelinePath, 'utf8').split('\n').slice(0, 3).join('\n') + '\n');
    assert.equal(resolveHistoricalGroupedReuseWindow(options), null);
});

test('historical grouped reuse cannot use later telemetry when prior compile proof is missing', t => {
    const { options } = fixture(t, events => {
        events.splice(2, 1);
        events.push({ type: 'REVIEW_RECORDED', details: {
            task_id: taskId, review_type: 'code', receipt_sha256: receiptHash, preflight_sha256: preflightHash
        } });
    });
    assert.equal(resolveHistoricalGroupedReuseWindow(options), null);
});
