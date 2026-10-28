import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { compileReviewDependencyGraph, getReviewDependencyTimelineOrderViolations } from '../../../../src/core/review-dependency-graph';
import { buildEventIntegrityHash } from '../../../../src/gate-runtime/task-events';
import { withTaskTimelineFileReadSnapshot } from '../../../../src/gate-runtime/timeline/task-timeline-read-snapshot';
import { readTaskTimelineNavigationQuery } from '../../../../src/gate-runtime/timeline/task-events-integrity';
import { beginNavigationTimelineQueryPass, navigationDependencyWitnesses, navigationHasCoverageBinding,
    navigationAcknowledgements } from '../../../../src/gate-runtime/timeline/task-navigation-query';
import { readOrderedTaskEvents, readNavigationOrderedTaskEvents, buildLifecycleGateOutcomes, getLifecycleGates,
    hasCurrentCycleReviewProgress, hasCurrentCycleProjectMemoryImpactEvent, buildCompletionReviewOrderBlocker,
    resolveFullSuiteValidationRequirementForCurrentCycle, readNativeDecomposedParentFacts } from '../../../../src/gates/task-audit/task-audit-summary-lifecycle';
import { buildOrchestratorDefectCaptureSummary } from '../../../../src/gates/task-audit/task-audit-summary-orchestrator-defects';
import { collectRequiredReviewBlockers } from '../../../../src/gates/task-audit/task-audit-summary-review-evidence';
import type { TaskCycleBindingSnapshot } from '../../../../src/gates/task-events-summary/task-events-summary';

type Event = Record<string, unknown>;
const event = (type: string, details: Record<string, unknown> = {}): Event => ({ event_type: type, details });
const graph = () => compileReviewDependencyGraph({ catalogLaneIds: ['code', 'test'], activeLaneIds: ['code', 'test'],
    requiredReviewIds: ['code', 'test'], mode: 'test_after_code' });
function fixture(t: TestContext, inputs: Event[]) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-audit-query-')), taskId = 'T-AUDIT-QUERY';
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const bundle = path.join(repoRoot, 'garda-agent-orchestrator'), timeline = path.join(bundle, 'runtime/task-events', taskId + '.jsonl');
    fs.mkdirSync(path.dirname(timeline), { recursive: true });
    let previous: string | null = null;
    const records = inputs.map((input, index) => {
        const record: Event = { schema_version: 2, event_source: 'task-events', task_id: taskId, actor: 'gate', outcome: 'PASS',
            message: 'Native timeline fixture.', timestamp_utc: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(), ...input,
            integrity: { schema_version: 2, task_sequence: index + 1, prev_event_sha256: previous } };
        const integrity = record.integrity as Record<string, unknown>;
        integrity.event_sha256 = buildEventIntegrityHash(record); previous = String(integrity.event_sha256);
        return record;
    });
    fs.writeFileSync(timeline, records.map(value => JSON.stringify(value)).join('\n') + '\n');
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), '# Tasks\n\n| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |\n|---|---|---|---|---|---|---|---|---|\n| ' + taskId + ' | DOING | P1 | test | Ordinary leaf | codex | 2026-01-01 | balanced | |\n');
    const native = () => withTaskTimelineFileReadSnapshot(timeline, () => readOrderedTaskEvents(timeline));
    const projected = () => readNavigationOrderedTaskEvents(timeline, taskId);
    return { repoRoot, taskId, timeline, records, native, projected };
}
function lifecycle(events: Event[], repoRoot: string, cycle: TaskCycleBindingSnapshot | null) {
    return { gates: buildLifecycleGateOutcomes(getLifecycleGates(true, true), events, cycle, repoRoot),
        progress: hasCurrentCycleReviewProgress(events), memory: hasCurrentCycleProjectMemoryImpactEvent(events, cycle, repoRoot),
        fullSuite: resolveFullSuiteValidationRequirementForCurrentCycle(events, cycle, repoRoot, true),
        order: buildCompletionReviewOrderBlocker({ code: true, test: true }, events, cycle, repoRoot, graph()) };
}

test('monotonic native timelines share an immutable internal view while public arrays stay fresh and mutable', t => {
    const f = fixture(t, [event('TASK_MODE_ENTERED'), event('COMPILE_GATE_PASSED'), event('REVIEW_PHASE_STARTED', { review_type: 'code' })]);
    const expected = f.native();
    withInvocationReadObservation(() => {
        const first = f.projected(), second = f.projected();
        assert.equal(first.events, second.events); assert.deepEqual(first, expected);
        assert.throws(() => first.events.push({}), TypeError);
        const publicResult = readOrderedTaskEvents(f.timeline);
        publicResult.events.push({ public: true });
        assert.equal(f.projected().count, expected.count); assert.equal(f.projected().events.length, expected.count);
    });
});

test('two and sixteen cycles have identical lifecycle query work and native outcomes across five consumers', t => {
    const samples: Record<string, number>[] = [];
    for (const cycles of [2, 16]) {
        const inputs = [event('TASK_MODE_ENTERED')];
        for (let cycle = 0; cycle < cycles; cycle += 1) inputs.push(event('COMPILE_GATE_PASSED'),
            event('REVIEW_RECORDED', { review_type: 'code' }), event('REVIEW_PHASE_STARTED', { review_type: 'test' }),
            event('REVIEW_RECORDED', { review_type: 'test' }), event('REVIEW_GATE_PASSED'), event('FULL_SUITE_VALIDATION_SKIPPED'));
        const f = fixture(t, inputs), expected = lifecycle(f.native().events, f.repoRoot, null);
        let measured: NextStepMeasurement | undefined;
        withInvocationReadObservation(() => {
            const observed = f.projected();
            withNextStepMeasurement(() => {
                for (let consumer = 0; consumer < 5; consumer += 1) assert.deepEqual(lifecycle(observed.events, f.repoRoot, null), expected);
            }, value => { measured = value; });
        });
        samples.push(measured!.work);
        assert.equal(measured!.work['visit:task-audit-summary-lifecycle:181'] || 0, 0);
        assert.equal(measured!.work['visit:task-audit-summary-lifecycle:320'] || 0, 0);
    }
    assert.deepEqual(samples[0], samples[1]);
});

test('nonmonotonic and missing timestamp cases retain native timestamp ordering and fallback work', t => {
    for (const timestamp of ['2025-01-01T00:00:00.000Z', null]) {
        const f = fixture(t, [event('TASK_MODE_ENTERED'), { ...event('COMPILE_GATE_PASSED'), timestamp_utc: timestamp }, event('REVIEW_GATE_PASSED')]);
        const expected = f.native(); let measured: NextStepMeasurement | undefined;
        const actual = withNextStepMeasurement(() => withInvocationReadObservation(f.projected), value => { measured = value; });
        assert.deepEqual(actual, expected); assert.ok(measured!.work['visit:audit_ordered_event_comparison'] > 0);
    }
});

test('dependency first-violation witnesses preserve historical typed phases, earliest phases, and valid reuse', t => {
    const cases = [
        [event('COMPILE_GATE_PASSED'), event('REVIEW_PHASE_STARTED', { review_type: 'test' }), event('REVIEW_RECORDED', { review_type: 'code' }), event('REVIEW_PHASE_STARTED', { review_type: 'test' })],
        [event('COMPILE_GATE_PASSED'), event('REVIEW_RECORDED', { review_type: 'code' }), event('REVIEW_PHASE_STARTED', { review_type: 'test' }), event('REVIEW_RECORDED', { review_type: 'code', verdict: 'FAILED' })],
        [event('COMPILE_GATE_PASSED'), event('REVIEW_RECORDED', { review_type: 'code' }), event('REVIEW_PHASE_STARTED', { review_type: 'test' }), event('REVIEW_RECORDED', { review_type: 'code', reused_existing_review: true })],
        [event('REVIEW_PHASE_STARTED', { review_type: 'test' }), event('COMPILE_GATE_PASSED'), event('REVIEW_PHASE_STARTED')],
        [event('COMPILE_GATE_PASSED'), event('REVIEW_PHASE_STARTED', { review_type: 'test' }), event('REVIEW_CYCLE_RESTARTED'), event('REVIEW_RECORDED', { review_type: 'code' }), event('REVIEW_PHASE_STARTED', { review_type: 'test' })]
    ];
    for (const inputs of cases) {
        const f = fixture(t, inputs), dependencyGraph = graph();
        const native = f.native().events.map((value, index) => ({ event_type: String(value.event_type), sequence: index + 1, details: value.details as Record<string, unknown> }));
        withInvocationReadObservation(() => {
            const query = readTaskTimelineNavigationQuery(f.timeline, f.taskId)!;
            assert.deepEqual(getReviewDependencyTimelineOrderViolations(dependencyGraph, navigationDependencyWitnesses(query, dependencyGraph))[0],
                getReviewDependencyTimelineOrderViolations(dependencyGraph, native)[0]);
            assert.deepEqual(buildCompletionReviewOrderBlocker({ code: true, test: true }, f.projected().events, null, f.repoRoot, dependencyGraph),
                buildCompletionReviewOrderBlocker({ code: true, test: true }, f.native().events, null, f.repoRoot, dependencyGraph));
        });
    }
});

test('rejected latest full-suite binding preserves an older matching preserved-scope native result', t => {
    const cycle: TaskCycleBindingSnapshot = { preflight_path: null, preflight_sha256: 'a'.repeat(64), compile_gate_timestamp: '2026-01-01T00:00:00.000Z' };
    const f = fixture(t, [event('COMPILE_GATE_PASSED'), event('FULL_SUITE_VALIDATION_PASSED', { cycle_binding: cycle }),
        event('FULL_SUITE_VALIDATION_PASSED', { cycle_binding: { ...cycle, preflight_sha256: 'b'.repeat(64) } })]);
    const expected = lifecycle(f.native().events, f.repoRoot, cycle);
    withInvocationReadObservation(() => assert.deepEqual(lifecycle(f.projected().events, f.repoRoot, cycle), expected));
});

test('ordinary parent marker absence still reads and validates the canonical queue before returning', t => {
    const f = fixture(t, [event('TASK_MODE_ENTERED'), event('COMPILE_GATE_PASSED')]);
    assert.equal(withInvocationReadObservation(() => readNativeDecomposedParentFacts(f.repoRoot, f.taskId)), null);
    fs.writeFileSync(path.join(f.repoRoot, 'TASK.md'), '# No parent entry\n');
    assert.throws(() => withInvocationReadObservation(() => readNativeDecomposedParentFacts(f.repoRoot, f.taskId)), /missing from the canonical queue/iu);
    fs.unlinkSync(path.join(f.repoRoot, 'TASK.md'));
    assert.throws(() => withInvocationReadObservation(() => readNativeDecomposedParentFacts(f.repoRoot, f.taskId)), /missing/iu);
});

test('legacy coverage membership and defect failures remain global across unrelated closed cycles', t => {
    const f = fixture(t, [event('REVIEW_RECORDED', { review_type: 'code', review_context_sha256: 'old-context', preflight_sha256: 'old-preflight' }),
        event('ORCHESTRATOR_DEFECT_ACKNOWLEDGED', { defect_id: 'old', summary: 'unresolved old defect' }),
        event('COMPILE_GATE_PASSED'), event('REVIEW_CYCLE_RESTARTED'), event('REVIEW_RECORDED', { review_type: 'code' })]);
    const expected = buildOrchestratorDefectCaptureSummary({ ...f, events: f.native().events });
    assert.equal(expected.status, 'INVALID');
    withInvocationReadObservation(() => {
        const query = readTaskTimelineNavigationQuery(f.timeline, f.taskId)!;
        assert.equal(navigationHasCoverageBinding(query, 'code', 'old-context', 'old-preflight'), true);
        const values = navigationAcknowledgements(query); (values[0] as { index: number }).index = 999;
        assert.notEqual(navigationAcknowledgements(query)[0].index, 999);
        assert.deepEqual(buildOrchestratorDefectCaptureSummary({ ...f, events: f.projected().events }), expected);
    });
});

test('required-review artifact selection retains current and pre-compile absence semantics', t => {
    const f = fixture(t, [event('REVIEW_RECORDED', { review_type: 'code' }), event('COMPILE_GATE_PASSED'), event('REVIEW_RECORDED', { review_type: 'test' })]);
    const cycle = { preflight_path: null, preflight_sha256: null, compile_gate_timestamp: String(f.records[1].timestamp_utc) };
    const reviewsRoot = path.join(f.repoRoot, 'garda-agent-orchestrator/runtime/reviews');
    const read = (events: Event[]) => collectRequiredReviewBlockers({ code: true, test: true }, f.taskId, reviewsRoot, events, cycle);
    const expected = read(f.native().events);
    withInvocationReadObservation(() => assert.deepEqual(read(f.projected().events), expected));
});

test('collector failure cannot turn a native JSON value into a new integrity rejection and closed state cannot be changed', () => {
    const invalid = beginNavigationTimelineQueryPass();
    invalid.accept({ event_type: { toString: 'not callable' } });
    assert.equal(invalid.finish(true), null);
    const closed = beginNavigationTimelineQueryPass(); closed.accept({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-01-01', integrity: { task_sequence: 1 } });
    const first = closed.finish(true); assert.ok(first);
    assert.throws(() => closed.accept({}), /closed/iu); assert.equal(closed.finish(true), first);
});

test('A1 rejects replacing the observed timeline after lifecycle selection', t => {
    const f = fixture(t, [event('TASK_MODE_ENTERED'), event('COMPILE_GATE_PASSED')]);
    let lifecycleSelected = false;
    assert.throws(() => withInvocationReadObservation(() => {
        f.projected(); lifecycleSelected = true; const replacement = f.timeline + '.replacement';
        fs.writeFileSync(replacement, fs.readFileSync(f.timeline)); fs.renameSync(replacement, f.timeline);
    }), (error: unknown) => error instanceof Error && (/changed|authority/iu.test(error.message)
        || error.message === 'Task timeline snapshot is unavailable: ' + f.timeline));
    assert.equal(lifecycleSelected, true);
});
