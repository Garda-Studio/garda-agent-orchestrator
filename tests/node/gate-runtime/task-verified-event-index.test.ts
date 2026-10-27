import { readStartupCycleReadiness } from '../../../src/gates/next-step/next-step-startup-readiness';
import { getHiddenReviewTimingTrustRemediation } from '../../../src/gates/next-step/next-step-review-evidence';
import type { ReviewArtifactState } from '../../../src/gates/next-step/next-step-review-artifact-readers';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendTaskEvent, buildEventIntegrityHash, inspectTaskEventFile } from '../../../src/gate-runtime/task-events';
import { readInvocationVerifiedEventIndex } from '../../../src/gate-runtime/timeline/task-events-integrity';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { readNavigationOrderedTaskEvents, readOrderedTaskEvents } from '../../../src/gates/task-audit/task-audit-summary-lifecycle';
import { collectImmutableTimelineEvents, findLatestTimelineEvent } from '../../../src/gates/next-step/next-step-timeline-readers';
import { readImmutableTaskTimelineEventWindow, readImmutableTaskTimelineEventLikes, readTaskTimelineEventWindow } from '../../../src/gates/next-step/next-step-review-timeline-evidence';

function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-verified-index-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const taskId = 'T-VERIFIED-INDEX', eventsRoot = path.join(root, 'runtime/task-events');
    const file = path.join(eventsRoot, taskId + '.jsonl');
    const append = (type: string, details: Record<string, unknown> = {}) => {
        assert.equal(appendTaskEvent(root, taskId, type, 'PASS', 'Index consumer regression', details,
            { passThru: true, lowNoiseRuntimeWrites: true })?.commit_status, 'committed');
    };
    return { root, taskId, eventsRoot, file, append };
}

test('real audit, quality-window and normalized navigation consumers share one frozen verified index', t => {
    const f = fixture(t);
    f.append('TASK_MODE_ENTERED'); f.append('PREFLIGHT_CLASSIFIED');
    f.append('QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED', { nested: { value: 'original' } });
    f.append('REVIEW_CYCLE_RESTARTED'); f.append('COMPILE_GATE_FAILED'); f.append('COMPILE_GATE_PASSED');
    const native = readTaskTimelineEventWindow(f.eventsRoot, f.taskId);
    let measured: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        const indexed = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
        assert.ok(indexed); assert.ok(Object.isFrozen(indexed)); assert.ok(Object.isFrozen(indexed.events[2].details));
        assert.ok(Object.isFrozen(indexed.normalizedEvents[2])); assert.ok(Object.isFrozen(indexed.normalizedEvents[2].integrity));
        assert.ok(Object.isFrozen(indexed.byType)); assert.ok(Object.isFrozen(indexed.byType.COMPILE_GATE_PASSED));
        assert.deepEqual(indexed.taskModeBoundaries, [0]); assert.deepEqual(indexed.reviewCycleBoundaries, [3]);
        assert.equal(indexed.lastIndexByType.COMPILE_GATE_FAILED, 4);
        for (let consumer = 0; consumer < 5; consumer++) {
            assert.equal(readInvocationVerifiedEventIndex(f.file, f.taskId), indexed);
            assert.equal(readNavigationOrderedTaskEvents(f.file, f.taskId).events, indexed.ordered);
            assert.deepEqual(readImmutableTaskTimelineEventWindow(f.eventsRoot, f.taskId), native);
            assert.equal(readImmutableTaskTimelineEventLikes(f.eventsRoot, f.taskId, 'QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED').length, 1);
            const normalized = collectImmutableTimelineEvents(f.file, []);
            assert.equal(normalized, indexed.normalizedEvents);
            assert.equal(findLatestTimelineEvent(normalized, 'COMPILE_GATE_FAILED')?.sequence, 4);
        }
    }), value => { measured = value; });
    assert.equal(measured!.work.timeline_verify, 1); assert.equal(measured!.work.timeline_parse, 1);
    assert.equal(measured!.work['visit:verified_timeline_index_event'], 6);
    for (const name of ['visit:timeline_cloned_event', 'visit:audit_ordered_event_copy']) assert.equal(measured!.work[name] || 0, 0, name);
    assert.equal(measured!.work['visit:next-step-timeline-readers:event:9'], 5);
});

test('public mutable windows cannot change the indexed event graph or audit array', t => {
    const f = fixture(t); f.append('TEST_EVENT', { nested: { value: 'original' } });
    withInvocationReadObservation(() => {
        const indexed = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
        const mutable = readTaskTimelineEventWindow(f.eventsRoot, f.taskId);
        (mutable.events[0].details as { nested: { value: string } }).nested.value = 'changed';
        mutable.events.length = 0;
        const audit = readOrderedTaskEvents(f.file); audit.events.length = 0;
        assert.equal(indexed.events.length, 1);
        assert.equal((indexed.events[0].details as { nested: { value: string } }).nested.value, 'original');
    });
});

test('legacy prefixes retain native timestamp order and malformed histories never publish an index', t => {
    const f = fixture(t);
    fs.mkdirSync(f.eventsRoot, { recursive: true });
    fs.writeFileSync(f.file, JSON.stringify({ task_id: f.taskId, event_type: 'LEGACY', timestamp_utc: '2099-01-01T00:00:00Z' }) + '\n', { mode: 0o600 });
    f.append('TASK_MODE_ENTERED');
    const native = readOrderedTaskEvents(f.file);
    withInvocationReadObservation(() => {
        assert.equal(inspectTaskEventFile(f.file, f.taskId).status, 'PASS_WITH_LEGACY_PREFIX');
        assert.deepEqual(readNavigationOrderedTaskEvents(f.file, f.taskId), native);
        assert.equal(collectImmutableTimelineEvents(f.file, [])[0].event_type, 'LEGACY');
    });
    fs.appendFileSync(f.file, '{invalid}\n');
    withInvocationReadObservation(() => {
        assert.equal(readInvocationVerifiedEventIndex(f.file, f.taskId), null);
        assert.equal(inspectTaskEventFile(f.file, f.taskId).status, 'FAILED');
        const errors: string[] = []; collectImmutableTimelineEvents(f.file, errors); assert.equal(errors.length, 1);
    });
});

test('indexed bounded-tail selection retains native byte truncation and selected-type filtering', t => {
    const f = fixture(t); f.append('QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED', { payload: 'x'.repeat(2 * 1024 * 1024) });
    f.append('TASK_MODE_ENTERED');
    const native = readTaskTimelineEventWindow(f.eventsRoot, f.taskId);
    assert.equal(native.truncated, true); assert.equal(native.events.length, 1);
    withInvocationReadObservation(() => {
        assert.deepEqual(readImmutableTaskTimelineEventWindow(f.eventsRoot, f.taskId), native);
        assert.deepEqual(readImmutableTaskTimelineEventLikes(f.eventsRoot, f.taskId, 'QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED'), []);
    });
});

test('A1 still rejects mutation after several indexed consumers', t => {
    const f = fixture(t); f.append('TASK_MODE_ENTERED');
    assert.throws(() => withInvocationReadObservation(() => {
        readNavigationOrderedTaskEvents(f.file, f.taskId); collectImmutableTimelineEvents(f.file, []);
        fs.appendFileSync(f.file, ' ');
    }), /changed|unavailable/i);
});

test('verified coercion does not turn legacy array event types into strict validation boundaries', t => {
    const f = fixture(t); fs.mkdirSync(f.eventsRoot, { recursive: true });
    fs.writeFileSync(f.file, JSON.stringify({ task_id: f.taskId, event_type: ['TASK_MODE_ENTERED'],
        timestamp_utc: 'invalid timestamp' }) + '\n', { mode: 0o600 });
    f.append('PREFLIGHT_CLASSIFIED');
    const native = readOrderedTaskEvents(f.file);
    withInvocationReadObservation(() => {
        const indexed = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
        assert.ok(indexed); assert.equal(indexed.lastIndexByType.TASK_MODE_ENTERED, undefined);
        assert.deepEqual(indexed.taskModeBoundaries, []);
        assert.deepEqual(readNavigationOrderedTaskEvents(f.file, f.taskId), native);
        assert.equal(findLatestTimelineEvent(collectImmutableTimelineEvents(f.file, []), 'TASK_MODE_ENTERED')?.sequence, 0);
    });
});

test('indexed windows ignore blank and whitespace rows exactly as the native bounded parser does', t => {
    const f = fixture(t); f.append('TASK_MODE_ENTERED'); f.append('QUALITY_CHECKLIST_RECORDED');
    const lines = fs.readFileSync(f.file, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(f.file, '\r\n  \n' + lines.join('\n\n \r\n') + '\n \r\n   ');
    const native = readTaskTimelineEventWindow(f.eventsRoot, f.taskId);
    withInvocationReadObservation(() => {
        assert.ok(readInvocationVerifiedEventIndex(f.file, f.taskId));
        assert.deepEqual(readImmutableTaskTimelineEventWindow(f.eventsRoot, f.taskId), native);
    });
});

test('optional index wrappers do not tighten the canonical event depth budget', t => {
    const f = fixture(t); f.append('TASK_MODE_ENTERED');
    const original = JSON.parse(fs.readFileSync(f.file, 'utf8')) as Record<string, unknown>;
    for (const depth of [252, 253]) {
        let details: Record<string, unknown> = {};
        for (let level = 0; level < depth; level++) details = { nested: details };
        const event = { ...original, details, integrity: { ...original.integrity as Record<string, unknown> } };
        event.integrity.event_sha256 = buildEventIntegrityHash(event);
        fs.writeFileSync(f.file, JSON.stringify(event) + '\n');
        const native = inspectTaskEventFile(f.file, f.taskId);
        assert.equal(native.status, depth === 252 ? 'PASS' : 'FAILED');
        withInvocationReadObservation(() => {
            assert.equal(inspectTaskEventFile(f.file, f.taskId).status, native.status);
            const indexed = readInvocationVerifiedEventIndex(f.file, f.taskId);
            if (depth === 252) {
                assert.ok(indexed);
                assert.equal(readNavigationOrderedTaskEvents(f.file, f.taskId).events, indexed.ordered);
            } else assert.equal(indexed, null);
        });
    }
});


test('normalized bounded selectors preserve native coercion and original event identity', t => {
    const f = fixture(t); fs.mkdirSync(f.eventsRoot, { recursive: true });
    fs.writeFileSync(f.file, [
        { task_id: f.taskId, event_type: ' reviewer_invocation_attested ', details: { id: 1 } },
        { task_id: f.taskId, event_type: ['reviewer_invocation_attested'], details: { id: 2 } },
        { task_id: f.taskId, event_type: 'UNRELATED', details: { id: 3 } }
    ].map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
    f.append('TASK_MODE_ENTERED');
    const native = readTaskTimelineEventWindow(f.eventsRoot, f.taskId).events
        .filter(event => String(event.event_type || '').trim().toUpperCase() === 'REVIEWER_INVOCATION_ATTESTED');
    withInvocationReadObservation(() => {
        const index = readInvocationVerifiedEventIndex(f.file, f.taskId)!;
        const selected = readImmutableTaskTimelineEventLikes(f.eventsRoot, f.taskId, 'REVIEWER_INVOCATION_ATTESTED', 'normalized');
        assert.deepEqual(selected, native);
        assert.equal(selected[0], index.events[0]); assert.equal(selected[1], index.events[1]);
        assert.equal(readImmutableTaskTimelineEventLikes(f.eventsRoot, f.taskId, 'REVIEWER_INVOCATION_ATTESTED').length, 0);
        assert.ok(Object.isFrozen(selected[0].details));
    });
});


test('timing consumers share verified events without cloning a full timeline per lane', t => {
    const f = fixture(t); f.append('TASK_MODE_ENTERED'); f.append('COMPILE_GATE_PASSED'); f.append('UNRELATED');
    let measured: NextStepMeasurement | undefined;
    const state = { reviewType: 'code', reusedExistingReview: false, reviewerProvenance: null } as ReviewArtifactState;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        for (let lane = 0; lane < 5; lane++) assert.equal(getHiddenReviewTimingTrustRemediation(f.eventsRoot, f.taskId, state), null);
    }), value => { measured = value; });
    assert.equal(measured!.work.timeline_verify, 1);
    assert.equal(measured!.work['visit:verified_timeline_index_event'], 3);
    assert.equal(measured!.work['visit:timeline_cloned_event'] || 0, 0);
});


test('real startup readiness queries event types without revisiting unrelated history', t => {
    const samples: { output: ReturnType<typeof readStartupCycleReadiness>; visits: number }[] = [];
    for (const cycles of [2, 16]) {
        const f = fixture(t);
        f.append('TASK_MODE_ENTERED');
        f.append('RULE_PACK_LOADED', { stage: 'TASK_ENTRY' });
        f.append('TASK_MODE_ENTERED');
        f.append('RULE_PACK_LOADED', { stage: 'POST_PREFLIGHT' });
        for (let cycle = 0; cycle < cycles; cycle++) f.append('TEST_EVENT', { cycle });
        const taskModePath = path.join(f.root, 'missing-task-mode.json');
        const native = readStartupCycleReadiness(f.root, f.eventsRoot, f.taskId, taskModePath);
        assert.equal(native.nextGate, 'load-rule-pack');
        let measured: NextStepMeasurement | undefined;
        const output = withNextStepMeasurement(() => withInvocationReadObservation(() =>
            readStartupCycleReadiness(f.root, f.eventsRoot, f.taskId, taskModePath)
        ), value => { measured = value; });
        assert.deepEqual(output, native);
        assert.equal(measured!.work.timeline_verify, 1);
        assert.equal(measured!.work['visit:verified_timeline_index_event'], cycles + 4);
        samples.push({ output, visits: measured!.work['visit:next-step-timeline-readers:event:9'] || 0 });
    }
    assert.deepEqual(samples[0].output, samples[1].output);
    assert.equal(samples[0].visits, samples[1].visits);
});
