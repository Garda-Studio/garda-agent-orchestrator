import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendTaskEvent, buildEventIntegrityHash, inspectTaskEventFile, withTaskTimelineReadSnapshot } from '../../../../src/gate-runtime/task-events';
import { resolveCurrentNoOpPreflightPath } from '../../../../src/gates/task-mode/no-op';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';

function fixture() {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-preflight-selector-'));
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const eventsRoot = path.join(bundleRoot, 'runtime', 'task-events');
    const taskId = 'T-SELECT-PREFLIGHT';
    const timeline = path.join(eventsRoot, `${taskId}.jsonl`);
    const first = path.join(repoRoot, 'first-preflight.json');
    const latest = path.join(repoRoot, 'latest-preflight.json');
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.writeFileSync(first, '{}'); fs.writeFileSync(latest, '{}');
    const append = (type: string, details: Record<string, unknown> = {}, outcome = 'PASS') => {
        const result = appendTaskEvent(bundleRoot, taskId, type, outcome, 'Selector fixture', details,
            { passThru: true, lowNoiseRuntimeWrites: true });
        assert.equal(result?.commit_status, 'committed');
    };
    const mode = (outcome = 'PASS', type = 'TASK_MODE_ENTERED') => append(type, {}, outcome);
    const classify = (output = latest, type = 'PREFLIGHT_CLASSIFIED', outcome = 'PASS') => append(type, { output_path: output }, outcome);
    const select = (explicit: unknown = '') => resolveCurrentNoOpPreflightPath(repoRoot, taskId, explicit);
    const observed = (explicit: unknown = '') => withInvocationReadObservation(() => select(explicit));
    return { repoRoot, bundleRoot, eventsRoot, taskId, timeline, first, latest, append, mode, classify, select, observed,
        cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}
type Fixture = ReturnType<typeof fixture>;
function outcome(action: () => string): { value: string } | { error: string } {
    try { return { value: action() }; } catch (error) { return { error: String(error) }; }
}
function parity(f: Fixture, explicit: unknown = '') {
    const expected = outcome(() => f.select(explicit));
    assert.deepEqual(outcome(() => f.observed(explicit)), expected);
    return expected;
}

test('latest exact task-entry/classification order and original outcome checks are unchanged', () => {
    const cases: Array<{ seed(f: Fixture): void; error?: RegExp }> = [
        { seed(f) { f.mode(); f.classify(f.first); f.append('COMPLETION_GATE_PASSED'); f.mode(); f.classify(); } },
        { seed(f) { f.classify(); f.mode(); }, error: /current task-mode cycle/ },
        { seed(f) { f.mode('FAILED'); f.classify(); }, error: /current task-mode cycle/ },
        { seed(f) { f.mode(); f.classify(); f.mode(); }, error: /current task-mode cycle/ },
        { seed(f) { f.mode(); f.classify(); f.append('PREFLIGHT_STARTED'); }, error: /superseded/ },
        { seed(f) { f.mode(); f.classify(); f.append('PREFLIGHT_FAILED'); }, error: /superseded/ },
        { seed(f) { f.mode(); f.append('PREFLIGHT_FAILED'); f.append('PREFLIGHT_STARTED'); f.classify(); } },
        // The selector historically checks entry outcome only. Do not add a new
        // classified-outcome rejection in an optimization of that selector.
        { seed(f) { f.mode(); f.classify(f.latest, 'PREFLIGHT_CLASSIFIED', 'FAILED'); } }
    ];
    for (const scenario of cases) {
        const f = fixture();
        try {
            scenario.seed(f);
            assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS');
            const actual = parity(f);
            if (scenario.error) { assert.ok('error' in actual); assert.match(actual.error, scenario.error); }
            else assert.deepEqual(actual, { value: f.latest });
        } finally { f.cleanup(); }
    }
});

test('raw event case and whitespace cannot change exact selector semantics', () => {
    const f = fixture();
    try {
        f.mode(); f.classify(f.first);
        f.mode('FAILED', ' task_mode_entered ');
        f.classify(f.latest, ' preflight_classified ');
        f.append('PREFLIGHT_FAILED '); f.append(' preflight_started');
        fs.appendFileSync(f.timeline, ' \t\r\n');
        assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS');
        assert.deepEqual(parity(f), { value: f.first });
        f.mode('pass'); f.classify();
        const actual = parity(f);
        assert.ok('error' in actual); assert.match(actual.error, /current task-mode cycle/);
    } finally { f.cleanup(); }
    const absentExact = fixture();
    try {
        absentExact.mode('PASS', 'task_mode_entered'); absentExact.classify();
        const actual = parity(absentExact);
        assert.ok('error' in actual); assert.match(actual.error, /current task-mode cycle/);
    } finally { absentExact.cleanup(); }
});

test('missing, invalid and legacy-only timelines retain authentication rejection', () => {
    for (const kind of ['missing', 'invalid', 'legacy-only'] as const) {
        const f = fixture();
        try {
            if (kind === 'invalid') {
                f.mode(); f.classify(); fs.appendFileSync(f.timeline, '{bad-json}\n');
            } else if (kind === 'legacy-only') {
                fs.writeFileSync(f.timeline, JSON.stringify({ task_id: f.taskId, event_type: 'TASK_MODE_ENTERED', outcome: 'PASS' }) + '\n');
            }
            let measured: NextStepMeasurement | undefined;
            withNextStepMeasurement(() => {
                const actual = parity(f);
                assert.ok('error' in actual); assert.match(actual.error, /authenticated native task timeline/);
            }, value => { measured = value; });
            assert.equal(measured?.work.no_op_preflight_projection_selection || 0, 0);
        } finally { f.cleanup(); }
    }
});

test('accepted legacy prefix and standalone selection retain the native fallback', () => {
    const f = fixture();
    try {
        const mode = { task_id: f.taskId, event_type: 'TASK_MODE_ENTERED', outcome: 'PASS' };
        const classified = { task_id: f.taskId, event_type: 'PREFLIGHT_CLASSIFIED', details: { output_path: f.latest } };
        const tail: Record<string, unknown> = { task_id: f.taskId, event_type: 'NATIVE_TAIL',
            integrity: { schema_version: 1, task_sequence: 3, prev_event_sha256: null } };
        (tail.integrity as Record<string, unknown>).event_sha256 = buildEventIntegrityHash(tail);
        fs.writeFileSync(f.timeline, [mode, classified, tail].map(value => JSON.stringify(value)).join('\n') + '\n');
        assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS_WITH_LEGACY_PREFIX');
        let measured: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => assert.equal(f.observed(), f.latest), value => { measured = value; });
        assert.equal(measured?.work.no_op_preflight_projection_selection || 0, 0);
        assert.equal(measured?.work['visit:no-op:112'], 3);
        assert.equal(measured?.work['visit:no-op:113'], 3);
    } finally { f.cleanup(); }
    const native = fixture();
    try {
        native.mode(); native.classify();
        let measured: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => assert.equal(native.select(), native.latest), value => { measured = value; });
        assert.equal(measured?.work.no_op_preflight_projection_selection || 0, 0);
        assert.equal(measured?.work['visit:no-op:112'], 2);
    } finally { native.cleanup(); }
});

test('selected-file changes and explicit-path checks remain live with a retained query', () => {
    const f = fixture();
    try {
        f.mode(); f.classify();
        assert.deepEqual(parity(f, f.latest), { value: f.latest });
        const foreign = parity(f, f.first);
        assert.ok('error' in foreign); assert.match(foreign.error, /must match the latest native classification/);
        // This selector has never authenticated preflight bytes. Preserve that
        // contract; downstream validators still own content authentication.
        fs.writeFileSync(f.latest, '{"changed":true}');
        assert.deepEqual(parity(f), { value: f.latest });
        withTaskTimelineReadSnapshot(f.eventsRoot, f.taskId, () => {
            assert.equal(f.observed(), f.latest);
            fs.unlinkSync(f.latest); fs.mkdirSync(f.latest);
            const actual = parity(f);
            assert.ok('error' in actual); assert.match(actual.error, /regular file|directory|file/i);
        });
        fs.rmdirSync(f.latest);
        const missing = parity(f);
        assert.ok('error' in missing);
    } finally { f.cleanup(); }
});

test('2 and 16 real cycles use constant selector work after mandatory verification', () => {
    const totals: number[] = [];
    for (const cycles of [2, 16]) {
        const f = fixture();
        try {
            for (let cycle = 0; cycle < cycles; cycle += 1) {
                f.mode(); f.classify(cycle === cycles - 1 ? f.latest : f.first);
                f.append('COMPLETION_GATE_PASSED');
            }
            let measured: NextStepMeasurement | undefined;
            withNextStepMeasurement(() => withInvocationReadObservation(() => withTaskTimelineReadSnapshot(f.eventsRoot, f.taskId, () => {
                for (let selection = 0; selection < 3; selection += 1) assert.equal(f.select(), f.latest);
            })), value => { measured = value; });
            assert.equal(measured?.work.timeline_verify, 1);
            assert.equal(measured?.work['visit:no-op:112'] || 0, 0);
            assert.equal(measured?.work['visit:no-op:113'] || 0, 0);
            assert.equal(measured?.work.no_op_preflight_projection_selection, 3);
            totals.push(measured!.work.no_op_preflight_projection_selection);
        } finally { f.cleanup(); }
    }
    assert.deepEqual(totals, [3, 3]);
});
