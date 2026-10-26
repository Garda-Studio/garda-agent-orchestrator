import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { appendTaskEvent, inspectTaskEventFile, withTaskTimelineReadSnapshot } from '../../../src/gate-runtime/task-events';
import { readTaskTimelineValidationQuery } from '../../../src/gate-runtime/timeline/task-events-integrity';
import { readValidationAttemptMultiplicity, type ValidationTimelineQuery } from '../../../src/gate-runtime/timeline/validation-timeline-query';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-validation-query-'));
    const taskId = 'T-query', eventsRoot = path.join(root, 'runtime', 'task-events');
    const timeline = path.join(eventsRoot, taskId + '.jsonl');
    const append = (type: string, details: Record<string, unknown> = {}) => {
        const result = appendTaskEvent(root, taskId, type, 'PASS', type, details,
            { passThru: true, lowNoiseRuntimeWrites: true });
        assert.equal(result?.commit_status, 'committed');
    };
    return { root, taskId, eventsRoot, timeline, append, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('real canonical query preserves global duplicate counts and capability through snapshot freezing', () => {
    const f = fixture();
    try {
        f.append('TASK_MODE_ENTERED'); f.append('PREFLIGHT_CLASSIFIED');
        f.append('PROJECT_VALIDATION_STARTED', { attempt_id: 'same', recipe_id: 'r' });
        f.append('COMPLETION_GATE_PASSED', { status: 'PASSED', outcome: 'PASS' });
        f.append('TASK_MODE_ENTERED'); f.append('PREFLIGHT_CLASSIFIED');
        f.append('PROJECT_VALIDATION_STARTED', { attempt_id: 'same', recipe_id: 'r' });
        f.append('PROJECT_VALIDATION_COMPLETED', { attempt_id: 'same' });
        f.append('PROJECT_VALIDATION_RESULTS_EVALUATED', { attempt_id: 'same' });
        let retained: ValidationTimelineQuery | undefined, measured: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => withInvocationReadObservation(() => withTaskTimelineReadSnapshot(f.eventsRoot, f.taskId, () => {
            assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS');
            const first = readTaskTimelineValidationQuery(f.timeline, f.taskId, true)!;
            const second = readTaskTimelineValidationQuery(f.timeline, f.taskId, true)!;
            assert.equal(first.query, second.query);
            retained = first.query;
            const found = readValidationAttemptMultiplicity(first.query, 'same')!;
            assert.equal(found.started.count, 2);
            assert.equal(found.started.first?.ordinal, 2); assert.equal(found.started.last?.ordinal, 6);
            assert.equal(found.completed.count, 1); assert.equal(found.evaluated.count, 1);
            assert.equal(first.query.modeIndex, 4); assert.equal(first.query.classifiedIndex, 5);
            assert.equal(readValidationAttemptMultiplicity(structuredClone(first.query), 'same'), null);
        })), value => { measured = value; });
        assert.equal(measured?.work.timeline_verify, 1, 'Query getters must not start another verifier walk.');
        assert.equal(readValidationAttemptMultiplicity(retained!, 'same'), null, 'A receipt must not escape its invocation.');
    } finally { f.cleanup(); }
});

test('authorized append replaces query capability and invalidates old multiplicity without poisoning new snapshot', () => {
    const f = fixture();
    try {
        f.append('TASK_MODE_ENTERED'); f.append('PREFLIGHT_CLASSIFIED');
        f.append('PROJECT_VALIDATION_STARTED', { attempt_id: 'one', recipe_id: 'r' });
        withInvocationReadObservation(() => withTaskTimelineReadSnapshot(f.eventsRoot, f.taskId, () => {
            const before = readTaskTimelineValidationQuery(f.timeline, f.taskId, true)!;
            assert.equal(readValidationAttemptMultiplicity(before.query, 'one')?.started.count, 1);
            f.append('PROJECT_VALIDATION_STARTED', { attempt_id: 'one', recipe_id: 'r' });
            assert.equal(readValidationAttemptMultiplicity(before.query, 'one'), null);
            const after = readTaskTimelineValidationQuery(f.timeline, f.taskId, true)!;
            assert.notEqual(after.sha256, before.sha256);
            assert.equal(readValidationAttemptMultiplicity(after.query, 'one')?.started.count, 2);
            assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS');
        }));
    } finally { f.cleanup(); }
});

test('whitespace-only legacy JSON lines use fallback while canonical integrity remains unchanged', () => {
    const f = fixture();
    try {
        f.append('TASK_MODE_ENTERED'); f.append('PREFLIGHT_CLASSIFIED');
        fs.appendFileSync(f.timeline, ' \t\r\n');
        const source = fs.readFileSync(f.timeline, 'utf8');
        assert.throws(() => source.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)));
        withInvocationReadObservation(() => withTaskTimelineReadSnapshot(f.eventsRoot, f.taskId, () => {
            assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS');
            assert.ok(readTaskTimelineValidationQuery(f.timeline, f.taskId));
            assert.equal(readTaskTimelineValidationQuery(f.timeline, f.taskId, true), null);
        }));
    } finally { f.cleanup(); }
});

test('failed integrity never exposes authenticated current queries', () => {
    const f = fixture();
    try {
        f.append('TASK_MODE_ENTERED'); f.append('PREFLIGHT_CLASSIFIED');
        const lines = fs.readFileSync(f.timeline, 'utf8').trimEnd().split('\n');
        const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
        last.details = { forged: true }; lines[lines.length - 1] = JSON.stringify(last);
        fs.writeFileSync(f.timeline, lines.join('\n') + '\n');
        withInvocationReadObservation(() => withTaskTimelineReadSnapshot(f.eventsRoot, f.taskId, () => {
            assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'FAILED');
            assert.equal(readTaskTimelineValidationQuery(f.timeline, f.taskId), null);
        }));
    } finally { f.cleanup(); }
});

test('current recipe head uses file order and original cross-recipe attempt matching', () => {
    const f = fixture();
    try {
        f.append('TASK_MODE_ENTERED'); f.append('PREFLIGHT_CLASSIFIED');
        f.append('PROJECT_VALIDATION_STARTED', { attempt_id: 'shared', recipe_id: 'first' });
        f.append('PROJECT_VALIDATION_RESULTS_EVALUATED', { attempt_id: 'shared', recipe_id: 'foreign' });
        f.append('QUALITY_CHECKLIST_RECORDED', { artifact_hash: 'old' });
        f.append('QUALITY_CHECKLIST_RECORDED', { artifact_hash: 'last' });
        f.append('COMPLETION_GATE_PASSED'); f.append('COMPLETION_GATE_PASSED');
        withInvocationReadObservation(() => withTaskTimelineReadSnapshot(f.eventsRoot, f.taskId, () => {
            const query = readTaskTimelineValidationQuery(f.timeline, f.taskId, true)!.query;
            assert.equal(query.recipeAttemptsAfterMode.first.event_type, 'PROJECT_VALIDATION_RESULTS_EVALUATED');
            assert.equal((query.recipeAttemptsAfterMode.first.details as Record<string, unknown>).recipe_id, 'foreign');
            assert.equal((query.latestQuality!.event.details as Record<string, unknown>).artifact_hash, 'last');
            assert.equal(query.completionCount, 2);
            assert.equal(query.latestTaskMode?.ordinal, 0);
        }));
    } finally { f.cleanup(); }
});
