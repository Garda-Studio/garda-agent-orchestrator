import { routeLatestReviewRestartIndex, routeFirstReviewRestartAfter, routeLaunchDiscoveryIndices,
    routeLaunchInputPinIndices } from '../../../src/gate-runtime/timeline/task-route-query';
import { isAuthenticatedReviewRestartBoundary } from '../../../src/gates/review/review-restart-boundary';
import { readTaskTimelineJsonlEntries } from '../../../src/gate-runtime/timeline/task-events-helpers';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beginRouteVerifiedPass, routeLatestSequence, routeLatestLane, routeExactEvent,
    routePreflightWitnesses, routeSplitWitnesses, routeInvocationCandidates, routePreparedLaunchIndices, routeTelemetryIndices, routeArtifactBindingIndices } from '../../../src/gate-runtime/timeline/task-route-query';
import { readTaskTimelineRouteQuery, inspectTaskEventFile } from '../../../src/gate-runtime/timeline/task-events-integrity';
import { appendMandatoryTaskEvent } from '../../../src/gate-runtime/task-events';
import { joinOrchestratorPath } from '../../../src/core/orchestrator-paths';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { withTaskTimelineFileReadSnapshot } from '../../../src/gate-runtime/timeline/task-timeline-read-snapshot';
import { getLatestTaskSequenceForEventTypes, readTaskTimelineEventLikes } from '../../../src/gates/next-step/next-step-review-timeline-evidence';
import { collectOrderedTimelineEvents } from '../../../src/gates/completion/completion-evidence';
import { readRouteOrderedWitnesses } from '../../../src/gates/next-step/next-step-route-query-readers';
import { readPendingPreflightRefresh, readCoherentCycleReadiness } from '../../../src/gates/next-step/next-step-preflight-recovery';

function fixture(t: TestContext) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-route-query-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const bundle = joinOrchestratorPath(repoRoot, ''), taskId = 'T-route';
    const eventsRoot = path.join(bundle, 'runtime/task-events'), timeline = path.join(eventsRoot, taskId + '.jsonl');
    const append = (type: string, details: Record<string, unknown> = {}) =>
        appendMandatoryTaskEvent(bundle, taskId, type, 'PASS', 'Route query test.', details);
    const observe = <T>(fn: () => T) => withInvocationReadObservation(() => withTaskTimelineFileReadSnapshot(timeline, fn));
    return { repoRoot, bundle, taskId, timeline, eventsRoot, append, observe };
}
function record(sequence: number, type: string, details: Record<string, unknown> = {}) {
    return { event_type: type, details, integrity: { schema_version: 2, task_sequence: sequence,
        event_sha256: sequence.toString(16).padStart(64, '0'), prev_event_sha256: null } };
}

test('route query is acquired from the native verifier and exact sequence/hash cannot alias', t => {
    const f = fixture(t); f.append('REVIEWER_INVOCATION_ATTESTED', { review_type: 'code' });
    assert.equal(readTaskTimelineRouteQuery(f.timeline, f.taskId), null);
    f.observe(() => {
        assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS');
        const q = readTaskTimelineRouteQuery(f.timeline, f.taskId); assert.ok(q);
        assert.equal(q, readTaskTimelineRouteQuery(f.timeline, f.taskId));
        const native = JSON.parse(fs.readFileSync(f.timeline, 'utf8').trim());
        assert.equal(routeExactEvent(q, native.integrity.task_sequence, native.integrity.event_sha256)?.event_type,
            'REVIEWER_INVOCATION_ATTESTED');
        assert.equal(routeExactEvent(q, native.integrity.task_sequence + 1, native.integrity.event_sha256), null);
        assert.equal(routeExactEvent(q, native.integrity.task_sequence, 'f'.repeat(64)), null);
    });
});

test('4096-event selector never imports an old full-history compile into the bounded window', () => {
    const pass = beginRouteVerifiedPass();
    for (let i = 0; i < 4097; i++) pass.accept(record(i + 1, i ? 'NOISE' : 'COMPILE_GATE_PASSED'), i, i * 100);
    const q = pass.finish('PASS', 409700); assert.ok(q);
    assert.equal(routeLatestSequence(q, ['COMPILE_GATE_PASSED']), 1);
    assert.equal(routeLatestSequence(q, ['COMPILE_GATE_PASSED'], true), null);
});

test('byte window drops the line starting exactly at a nonzero tail cut', () => {
    const pass = beginRouteVerifiedPass();
    pass.accept(record(1, 'COMPILE_GATE_PASSED'), 0, 10);
    pass.accept(record(2, 'REVIEW_RECORDED', { review_type: ' CoDe ' }), 1, 20);
    const q = pass.finish('PASS', 2 * 1024 * 1024 + 10); assert.ok(q);
    assert.equal(routeLatestSequence(q, ['COMPILE_GATE_PASSED'], true), null);
    assert.equal(routeLatestLane(q, 'review_recorded', 'CODE'), 2);
});

test('lane nullish aliases differ from prepared-context truthy aliases', () => {
    const pass = beginRouteVerifiedPass();
    pass.accept(record(1, 'REVIEW_RECORDED', { review_type: '', reviewType: 'code' }), 0, 0);
    const q = pass.finish('PASS', 100); assert.ok(q);
    assert.equal(routeLatestLane(q, 'REVIEW_RECORDED', 'code'), null);
    assert.equal(routeLatestLane(q, 'REVIEW_RECORDED', ''), 1);
});

test('invalid, legacy and opaque-coercion captures cannot change canonical acceptance', t => {
    const f = fixture(t); f.append('REVIEW_PHASE_STARTED', { output_path: { toString: null } });
    f.observe(() => {
        assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS');
        assert.equal(readTaskTimelineRouteQuery(f.timeline, f.taskId), null);
    });
    const pass = beginRouteVerifiedPass(); pass.accept(record(1, 'TEST'), 0, 0);
    assert.equal(pass.finish('PASS_WITH_LEGACY_PREFIX', 100), null);
    const duplicate = beginRouteVerifiedPass(); duplicate.accept(record(1, 'TEST'), 0, 0); duplicate.accept(record(1, 'TEST'), 1, 10);
    assert.equal(duplicate.finish('PASS', 100), null);
    const broken = beginRouteVerifiedPass(); broken.accept(null, 0, 0);
    assert.equal(broken.finish('FAILED', 100), null);
});

test('split and attestation candidates preserve duplicates and global order', () => {
    const pass = beginRouteVerifiedPass();
    for (let i = 0; i < 4; i++) pass.accept(record(i + 1, i < 2 ? 'SPLIT_REQUIRED_LATCHED' : 'REVIEWER_INVOCATION_ATTESTED',
        { review_type: 'code', routing_event_sha256: 'a'.repeat(64) }), i, i * 100);
    const q = pass.finish('PASS', 400); assert.ok(q);
    assert.deepEqual(routeSplitWitnesses(q).map(e => e.sequence), [0, 1]);
    assert.equal(routeInvocationCandidates(q, 'code', 'a'.repeat(64)).length, 2);
});

test('preflight original-entry global rejection survives task-mode reset and prefix projection', t => {
    const f = fixture(t);
    for (const type of ['TASK_MODE_ENTERED', 'IMPLEMENTATION_STARTED', 'REVIEW_GATE_PASSED',
        'TASK_MODE_ENTERED', 'IMPLEMENTATION_STARTED', 'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'SHELL_SMOKE_PREFLIGHT_RECORDED', 'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED']) f.append(type);
    const expected = readPendingPreflightRefresh(f.eventsRoot, f.taskId);
    assert.equal(expected?.nextGate, 'restart-coherent-cycle');
    f.observe(() => {
        assert.deepEqual(readPendingPreflightRefresh(f.eventsRoot, f.taskId), expected);
        const q = readTaskTimelineRouteQuery(f.timeline, f.taskId); assert.ok(q);
        assert.ok(routePreflightWitnesses(q).some(e => e.event_type === 'REVIEW_GATE_PASSED'));
    });
    const reviews = path.join(f.bundle, 'runtime/reviews');
    const readiness = () => readCoherentCycleReadiness(f.repoRoot, f.eventsRoot, reviews, f.taskId,
        path.join(reviews, f.taskId + '-preflight.json'), null);
    const before = readiness(); f.observe(() => assert.deepEqual(readiness(), before));
});

test('preflight witnesses remain private fresh mutable copies and public bounded array remains native', t => {
    const f = fixture(t); f.append('TASK_MODE_ENTERED', { artifact_path: 'task.json' });
    f.observe(() => {
        const first = readRouteOrderedWitnesses(f.timeline, [], 'preflight'); first[0].details!.artifact_path = 'poison';
        assert.equal(readRouteOrderedWitnesses(f.timeline, [], 'preflight')[0].details!.artifact_path, 'task.json');
        const publicEvents = readTaskTimelineEventLikes(f.eventsRoot, f.taskId); publicEvents.length = 0;
        assert.equal(readTaskTimelineEventLikes(f.eventsRoot, f.taskId).length, 1);
        assert.equal(getLatestTaskSequenceForEventTypes(f.eventsRoot, f.taskId, ['TASK_MODE_ENTERED']), 1);
    });
    assert.equal(collectOrderedTimelineEvents(f.timeline, []).length, 1);
});

test('tampered canonical bytes disable derived route results', t => {
    const f = fixture(t); f.append('COMPILE_GATE_PASSED');
    fs.writeFileSync(f.timeline, fs.readFileSync(f.timeline, 'utf8').replace('COMPILE_GATE_PASSED', 'COMPILE_GATE_FAILED'));
    f.observe(() => {
        assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'FAILED');
        assert.equal(readTaskTimelineRouteQuery(f.timeline, f.taskId), null);
    });
});

test('prepared launch buckets retain old exact matches and duplicate attempts without reading unrelated artifacts', () => {
    const pass = beginRouteVerifiedPass();
    const detail = { review_type: 'code', reviewer_execution_mode: 'delegated_subagent',
        review_context_sha256: 'a'.repeat(64), routing_event_sha256: 'b'.repeat(64) };
    pass.accept(record(1, 'REVIEWER_LAUNCH_PREPARED', detail), 0, 0);
    pass.accept(record(2, 'COHERENT_CYCLE_RESTARTED'), 1, 100);
    pass.accept(record(3, 'REVIEWER_LAUNCH_PREPARED', { ...detail, review_context_sha256: 'c'.repeat(64) }), 2, 200);
    pass.accept(record(4, 'REVIEWER_LAUNCH_PREPARED', detail), 3, 300);
    const q = pass.finish('PASS', 400); assert.ok(q);
    assert.deepEqual([...routePreparedLaunchIndices(q, 'code', 'a'.repeat(64), 'b'.repeat(64))], [3, 0]);
});

test('telemetry candidates preserve all matching attempts and artifact paths use first-string alias semantics', () => {
    const pass = beginRouteVerifiedPass();
    const details = { task_id: 12, taskId: 'T-route', review_type: 'code',
        review_context_sha256: 'a'.repeat(64), routing_event_sha256: 'b'.repeat(64) };
    pass.accept(record(1, 'REVIEWER_LAUNCH_COMPLETED', details), 0, 0);
    pass.accept(record(2, 'REVIEWER_LAUNCH_COMPLETED', { ...details, routing_event_sha256: 'c'.repeat(64) }), 1, 100);
    pass.accept(record(3, 'REVIEWER_LAUNCH_COMPLETED', details), 2, 200);
    const q = pass.finish('PASS', 300); assert.ok(q);
    assert.deepEqual([...routeTelemetryIndices(q, ['REVIEWER_LAUNCH_COMPLETED'], 'code', 'a'.repeat(64), 'b'.repeat(64))], [2, 0]);
    assert.deepEqual([...routeArtifactBindingIndices(q, 'T-route', 'code', 'a'.repeat(64), 'b'.repeat(64), -1)], [2, 0]);
    assert.deepEqual([...routeArtifactBindingIndices(q, '12', 'code', 'a'.repeat(64), 'b'.repeat(64), -1)], []);
});

test('optional query coercion cannot turn valid canonical evidence into an integrity failure', t => {
    const f = fixture(t);
    f.append('REVIEW_RECORDED', { review_type: { toString: null } });
    f.observe(() => assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS'));
});


test('native preflight readers preserve decisions and append order without consumer sorting at 2 and 16 cycles', t => {
    for (const cycles of [2, 16]) {
        const f = fixture(t);
        for (let cycle = 0; cycle < cycles; cycle++) {
            for (const type of ['TASK_MODE_ENTERED', 'IMPLEMENTATION_STARTED', 'REVIEW_GATE_PASSED',
                'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'NOISE']) f.append(type);
        }
        const native = readPendingPreflightRefresh(f.eventsRoot, f.taskId);
        let measured: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => f.observe(() => {
            assert.deepEqual(readPendingPreflightRefresh(f.eventsRoot, f.taskId), native);
            const rows = readRouteOrderedWitnesses(f.timeline, [], 'preflight');
            const ordinals = rows.map(row => row.sequence);
            // Earliest global boundaries, the previous preflight prefix, current latest slots and final row.
            const last = 6 * (cycles - 1), previous = last - 6;
            assert.deepEqual(ordinals, [...new Set([1, 2, previous + 3, previous + 4,
                last, last + 1, last + 2, last + 3, last + 4, last + 5])].sort((a, b) => a - b));
        }), value => { measured = value; });
        assert.equal(measured!.work['visit:route_query_witness_comparison'] || 0, 0);
    }
});

test('native restart and pin indexes keep first-boundary order, duplicates and preserved lanes', t => {
    const f = fixture(t);
    const details = { task_id: f.taskId, review_type: 'code', prepared_launch_event_sha256: 'a'.repeat(64) };
    f.append('REVIEWER_LAUNCH_PREPARED');
    f.append('REVIEWER_LAUNCH_INPUT_PINNED', details);
    const restart = (lanes: string[], type = 'REVIEW_CYCLE_RESTARTED') => appendMandatoryTaskEvent(f.bundle,
        f.taskId, type, 'PASS', 'Restart selector test.', { task_id: f.taskId, event_type: type,
            status: 'PASSED', invalidated_review_types: lanes }, { actor: 'orchestrator' });
    restart(['test']);
    f.append('REVIEWER_LAUNCH_INPUT_PINNED', details);
    restart(['code']);
    f.append('REVIEWER_LAUNCH_INPUT_PINNED', details);
    f.append('REVIEWER_LAUNCH_PREPARED');
    restart([], 'COHERENT_CYCLE_RESTARTED');
    f.append('REVIEWER_LAUNCH_PREPARED');
    f.observe(() => {
        assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS');
        const query = readTaskTimelineRouteQuery(f.timeline, f.taskId); assert.ok(query);
        const entries = readTaskTimelineJsonlEntries(f.timeline);
        for (const lane of ['code', 'test', 'unseen']) {
            const nativeBoundaries = entries.flatMap((entry, ordinal) => entry.record
                && isAuthenticatedReviewRestartBoundary(entry.record, f.taskId, lane) ? [ordinal] : []);
            assert.equal(routeLatestReviewRestartIndex(query, f.taskId, lane), nativeBoundaries.at(-1) ?? -1);
            for (const after of [-1, 0, 2, 4, 7, 8]) assert.equal(
                routeFirstReviewRestartAfter(query, f.taskId, lane, after),
                nativeBoundaries.find(ordinal => ordinal > after) ?? -1);
        }
        assert.deepEqual([...routeLaunchInputPinIndices(query, f.taskId, 'code', 'a'.repeat(64), 0)], [1, 3]);
        assert.deepEqual([...routeLaunchInputPinIndices(query, f.taskId, 'code', 'a'.repeat(64), 4)], [5]);
        assert.deepEqual([...routeLaunchDiscoveryIndices(query, 4)], [8, 6]);
        assert.deepEqual([...routeLaunchDiscoveryIndices(query, -1)], [8, 6, 0]);
    });
});
