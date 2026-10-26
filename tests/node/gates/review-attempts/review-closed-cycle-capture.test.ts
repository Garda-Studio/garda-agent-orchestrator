import '../../../../src/bin/garda/derivation-source-receipts';
import { publishClosedReviewAfterGate } from '../../../../src/gates/review-attempts/review-closed-cycle-gate-hooks';
/** Native verifier and real producing-gate integration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendMandatoryTaskEvent, inspectTaskEventFile } from '../../../../src/gate-runtime/task-events';
import { readTaskTimelineClosedReviewQuery } from '../../../../src/gate-runtime/timeline/task-events-integrity';
import { withTaskTimelineFileReadSnapshot } from '../../../../src/gate-runtime/timeline/task-timeline-read-snapshot';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { beginClosedReviewVerifiedPass } from '../../../../src/gate-runtime/timeline/task-closed-review-query';
import { joinOrchestratorPath } from '../../../../src/core/orchestrator-paths';
import { resolveNextStep } from '../../../../src/gates/next-step';
import { captureClosedReviewGate } from '../../../../src/gates/review-attempts/review-closed-cycle-capture';
import { publishClosedReviewHistory, closedReviewPaths } from '../../../../src/gates/review-attempts/review-closed-cycle-storage';
import { createAuthenticatedNextStepHistoryFixture } from '../next-step/next-step-authenticated-history-fixture';
import { buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';

function unitTask(t: { after(fn: () => void): void }) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-query-capture-')), taskId = 'T-query';
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const bundle = joinOrchestratorPath(repoRoot, ''), timeline = path.join(bundle, 'runtime/task-events', taskId + '.jsonl');
    return { repoRoot, taskId, bundle, timeline };
}
function sample(repoRoot: string, taskId: string) {
    let measure!: NextStepMeasurement;
    const result = withNextStepMeasurement(() => resolveNextStep({ repoRoot, taskId }), value => { measure = value; });
    return { result, work: measure.work };
}

test('Q5 query heads share the mandatory native verifier pass and have no lookup event replay', t => {
    const f = unitTask(t);
    appendMandatoryTaskEvent(f.bundle, f.taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Unit query event.', {});
    let measure!: NextStepMeasurement;
    withNextStepMeasurement(() => withInvocationReadObservation(() => withTaskTimelineFileReadSnapshot(f.timeline, () => {
        assert.equal(inspectTaskEventFile(f.timeline, f.taskId).status, 'PASS');
        const first = readTaskTimelineClosedReviewQuery(f.timeline, f.taskId);
        const second = readTaskTimelineClosedReviewQuery(f.timeline, f.taskId);
        assert.ok(first); assert.equal(first, second);
        assert.equal(first.query.source.lineOrdinal, 0);
        assert.equal(first.query.appendState.matching_events, 1);
        assert.equal(first.query.appendState.last_event_sha256, first.query.source.sha256);
    })), value => { measure = value; });
    assert.equal(measure.work.timeline_verify, 1);
    assert.equal(measure.work.timeline_events, 1);
});

test('Q5 invalid canonical hash discards every tentative query fact', t => {
    const f = unitTask(t);
    appendMandatoryTaskEvent(f.bundle, f.taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'original', {});
    fs.writeFileSync(f.timeline, fs.readFileSync(f.timeline, 'utf8').replace('original', 'modified'));
    assert.equal(readTaskTimelineClosedReviewQuery(f.timeline, f.taskId), null);
});

test('Q5 query digest binds legacy content and nonempty ordinals; publication is not a semantic cancellation', () => {
    const preflight = { task_id: 'T', event_type: 'PREFLIGHT_CLASSIFIED', outcome: 'INFO', details: { scope: 'a' } };
    const first = beginClosedReviewVerifiedPass('T'); first.accept(preflight, 0);
    const a = first.finish(true)!;
    const second = beginClosedReviewVerifiedPass('T'); second.accept(preflight, 0);
    second.accept({ task_id: 'T', event_type: 'REVIEW_HISTORY_SUMMARY_PUBLISHED', details: {} }, 1);
    assert.equal(second.finish(true)!.query.semanticQuerySha256, a.query.semanticQuerySha256);
    const edited = beginClosedReviewVerifiedPass('T'); edited.accept({ ...preflight, details: { scope: 'b' } }, 0);
    assert.notEqual(edited.finish(true)!.query.semanticQuerySha256, a.query.semanticQuerySha256);
    const cancelled = beginClosedReviewVerifiedPass('T'); cancelled.accept(preflight, 0);
    cancelled.accept({ task_id: 'T', event_type: 'REVIEW_CYCLE_RESTARTED', outcome: 'PASS' }, 1);
    const b = cancelled.finish(true)!;
    assert.notEqual(b.query.semanticQuerySha256, a.query.semanticQuerySha256);
    assert.equal(b.latestRestart!.lineOrdinal, 1);
});

test('Q5 real record/preflight/restart hooks publish a compact result and a same-source retry is idempotent', async t => {
    const fixture = await createAuthenticatedNextStepHistoryFixture(2, 3);
    t.after(() => fs.rmSync(fixture.repoRoot, { recursive: true, force: true }));
    const paths = closedReviewPaths(fixture.repoRoot, fixture.taskId);
    assert.ok(fs.existsSync(paths.state)); assert.ok(fs.existsSync(paths.navigation));
    const fresh = sample(fixture.repoRoot, fixture.taskId);
    assert.equal(fresh.result.next_gate, 'required-reviews-check');
    assert.ok(fresh.work['closed-review-summary:accepted'] > 0, 'real navigation must consume producer publication');
    assert.equal(fresh.work['visit:closed-review-capture:producer-bootstrap-event'] || 0, 0);
    const timeline = joinOrchestratorPath(fixture.repoRoot, 'runtime/task-events/' + fixture.taskId + '.jsonl');
    const query = readTaskTimelineClosedReviewQuery(timeline, fixture.taskId)!;
    const before = fs.readFileSync(timeline);
    const input = captureClosedReviewGate({ repoRoot: fixture.repoRoot, taskId: fixture.taskId, kind: 'record', sourceEventSha256: query.query.source.sha256 });
    assert.equal(publishClosedReviewHistory(input), null);
    assert.deepEqual(fs.readFileSync(timeline), before);
    assert.throws(() => captureClosedReviewGate({ repoRoot: fixture.repoRoot, taskId: fixture.taskId, kind: 'record', sourceEventSha256: '0'.repeat(64) }), /source|superseded/u);
});

test('Q5 real source binding stays fresh and full audit still authenticates every closed immutable report', async t => {
    const fixture = await createAuthenticatedNextStepHistoryFixture(2, 3);
    t.after(() => fs.rmSync(fixture.repoRoot, { recursive: true, force: true }));
    const root = path.dirname(fixture.preflightPath), timeline = joinOrchestratorPath(fixture.repoRoot, 'runtime/task-events/' + fixture.taskId + '.jsonl');
    const query = readTaskTimelineClosedReviewQuery(timeline, fixture.taskId)!;
    const originalPreflight = fs.readFileSync(fixture.preflightPath);
    const input = captureClosedReviewGate({ repoRoot: fixture.repoRoot, taskId: fixture.taskId, kind: 'record', sourceEventSha256: query.query.source.sha256 });
    try {
        fs.appendFileSync(fixture.preflightPath, ' ');
        assert.throws(() => input.assertInputsCurrent(), /changed/u);
        assert.equal(sample(fixture.repoRoot, fixture.taskId).work['closed-review-summary:accepted'] || 0, 0);
    } finally { fs.writeFileSync(fixture.preflightPath, originalPreflight); }
    const oldReport = fixture.historicalArtifacts.find(file => /-[a-f0-9]{64}\.md$/u.test(file));
    assert.ok(oldReport);
    const bytes = fs.readFileSync(oldReport);
    try {
        fs.appendFileSync(oldReport, '\ninvalidated archived immutable bytes\n');
        const audit = buildTaskAuditSummary({ repoRoot: fixture.repoRoot, taskId: fixture.taskId });
        assert.notEqual(audit.status, 'PASS');
        assert.ok(audit.blockers.some(blocker => /history integrity|committed report|snapshot/iu.test(blocker.reason)));
    } finally { fs.writeFileSync(oldReport, bytes); }
    assert.ok(fs.existsSync(path.join(root, fixture.taskId + '-review-history-navigation.json')));
});


test('Q5 acceleration unavailable after real native admission preserves the admitted operation', t => {
    const f = unitTask(t); // Deliberately no Git repository/key; native append supports this.
    const admitted = appendMandatoryTaskEvent(f.bundle, f.taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Native admission remains successful.', {});
    assert.equal(admitted.canonical_committed, true);
    const before = fs.readFileSync(f.timeline);
    assert.equal(publishClosedReviewAfterGate(captureClosedReviewGate,
        { repoRoot: f.repoRoot, taskId: f.taskId, kind: 'preflight' }, admitted), null);
    assert.deepEqual(fs.readFileSync(f.timeline), before);
    assert.equal(fs.existsSync(closedReviewPaths(f.repoRoot, f.taskId).navigation), false);
    assert.equal(publishClosedReviewAfterGate(() => { throw new Error('Unqualifiable legacy bootstrap.'); },
        { repoRoot: f.repoRoot, taskId: f.taskId, kind: 'preflight' }, admitted), null);
    assert.deepEqual(fs.readFileSync(f.timeline), before);
});

test('Q5 original native admission errors remain outside optional acceleration catch', t => {
    const f = unitTask(t);
    let reachedOptionalHook = false;
    assert.throws(() => {
        const admitted = appendMandatoryTaskEvent(f.bundle, '../invalid-task', 'PREFLIGHT_CLASSIFIED', 'INFO', 'Must fail natively.', {});
        reachedOptionalHook = true;
        publishClosedReviewAfterGate(captureClosedReviewGate, { repoRoot: f.repoRoot, taskId: f.taskId, kind: 'preflight' }, admitted);
    });
    assert.equal(reachedOptionalHook, false);
});


test('Q5 cold preflight producer loads and authenticates its policy closure before publication', t => {
    const f = unitTask(t);
    execFileSync('git', ['init', '-q', f.repoRoot]);
    const reviews = path.join(f.bundle, 'runtime/reviews');
    fs.mkdirSync(reviews, { recursive: true });
    const mode = path.join(reviews, f.taskId + '-task-mode.json');
    const preflight = path.join(reviews, f.taskId + '-preflight.json');
    fs.writeFileSync(mode, JSON.stringify({ task_id: f.taskId }));
    fs.writeFileSync(preflight, JSON.stringify({ task_id: f.taskId, metrics: { scope_sha256: null, scope_content_sha256: null } }));
    const script = [
        'const taskEvents = require(' + JSON.stringify(require.resolve('../../../../src/gate-runtime/task-events')) + ');',
        'const capture = require(' + JSON.stringify(require.resolve('../../../../src/gates/review-attempts/review-closed-cycle-capture')) + ');',
        'const store = require(' + JSON.stringify(require.resolve('../../../../src/gates/review-attempts/review-closed-cycle-storage')) + ');',
        'const f = ' + JSON.stringify({ ...f, mode, preflight }) + ';',
        'taskEvents.appendMandatoryTaskEvent(f.bundle,f.taskId,"TASK_MODE_ENTERED","PASS","Cold producer entry",{artifact_path:f.mode});',
        'const admitted=taskEvents.appendMandatoryTaskEvent(f.bundle,f.taskId,"PREFLIGHT_CLASSIFIED","INFO","Cold producer classification",{output_path:f.preflight,scope_sha256:null,scope_content_sha256:null});',
        'const input=capture.captureClosedReviewGate({repoRoot:f.repoRoot,taskId:f.taskId,kind:"preflight",sourceEventSha256:admitted.integrity.event_sha256});',
        'store.publishClosedReviewHistory(input);'
    ].join('\n');
    const result = spawnSync(process.execPath, ['-r', require.resolve('../../../../src/bin/garda/derivation-source-receipts'), '-e', script], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(closedReviewPaths(f.repoRoot, f.taskId).navigation), true);
});

test('Q5 restart publishes its authenticated outcome before active review', async t => {
    const captureModule = require('../../../../src/gates/review-attempts/review-closed-cycle-capture') as { captureClosedReviewGate: typeof captureClosedReviewGate };
    const storageModule = require('../../../../src/gates/review-attempts/review-closed-cycle-storage') as { publishClosedReviewHistory: typeof publishClosedReviewHistory };
    const originalCapture = captureModule.captureClosedReviewGate, originalPublish = storageModule.publishClosedReviewHistory;
    const failures: string[] = [];
    captureModule.captureClosedReviewGate = request => {
        try { return originalCapture(request); }
        catch (error) { failures.push(request.kind + ': ' + String(error)); throw error; }
    };
    storageModule.publishClosedReviewHistory = input => {
        try { return originalPublish(input); }
        catch (error) { failures.push(input.query.sourceEventType + ': ' + String(error)); throw error; }
    };
    t.after(() => { captureModule.captureClosedReviewGate = originalCapture; storageModule.publishClosedReviewHistory = originalPublish; });
    const fixture = await createAuthenticatedNextStepHistoryFixture(1, 1, active => {
        const timeline = joinOrchestratorPath(active.repoRoot, 'runtime/task-events/' + active.taskId + '.jsonl');
        const query = readTaskTimelineClosedReviewQuery(timeline, active.taskId)!.query;
        assert.equal(query.sourceEventType, 'REVIEW_CYCLE_RESTARTED');
        assert.equal(query.latestPublication?.details.source_event_sha256, query.source.sha256, failures.join('\n'));
        assert.equal(sample(active.repoRoot, active.taskId).work['closed-review-summary:accepted'], 1);
    });
    t.after(() => fs.rmSync(fixture.repoRoot, { recursive: true, force: true }));
});


test('Q5 native publisher rejects loaded reducer A after its executable becomes B', t => {
    const f = unitTask(t);
    execFileSync('git', ['init', '-q', f.repoRoot]);
    const reviews = path.join(f.bundle, 'runtime/reviews'), runtime = path.join(f.repoRoot, 'copied-runtime');
    fs.mkdirSync(reviews, { recursive: true });
    fs.cpSync(path.resolve(__dirname, '../../../../src'), runtime, { recursive: true });
    const mode = path.join(reviews, f.taskId + '-task-mode.json'), preflight = path.join(reviews, f.taskId + '-preflight.json');
    fs.writeFileSync(mode, JSON.stringify({ task_id: f.taskId }));
    fs.writeFileSync(preflight, JSON.stringify({ task_id: f.taskId, metrics: { scope_sha256: null, scope_content_sha256: null } }));
    const script = [
        'const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");',
        'const f=' + JSON.stringify({ ...f, runtime, mode, preflight }) + ';',
        'const taskEvents=require(path.join(f.runtime,"gate-runtime/task-events.js"));',
        'const capture=require(path.join(f.runtime,"gates/review-attempts/review-closed-cycle-capture.js"));',
        'const store=require(path.join(f.runtime,"gates/review-attempts/review-closed-cycle-storage.js"));',
        'const reducerFile=path.join(f.runtime,"gates/review-attempts/review-closed-cycle-summary.js");',
        'const reducer=require(reducerFile); assert.equal(reducer.createClosedReviewProducerState(f.taskId).lastReviewLineOrdinal,-1);',
        'const source=fs.readFileSync(reducerFile,"utf8"); assert.ok(source.includes("lastReviewLineOrdinal: -1"));',
        'fs.writeFileSync(reducerFile,source.replace("lastReviewLineOrdinal: -1","lastReviewLineOrdinal: 0"));',
        'assert.equal(reducer.createClosedReviewProducerState(f.taskId).lastReviewLineOrdinal,-1);',
        'taskEvents.appendMandatoryTaskEvent(f.bundle,f.taskId,"TASK_MODE_ENTERED","PASS","Producer entry",{artifact_path:f.mode});',
        'const admitted=taskEvents.appendMandatoryTaskEvent(f.bundle,f.taskId,"PREFLIGHT_CLASSIFIED","INFO","Classification",{output_path:f.preflight,scope_sha256:null,scope_content_sha256:null});',
        'assert.throws(()=>store.publishClosedReviewHistory(capture.captureClosedReviewGate({repoRoot:f.repoRoot,taskId:f.taskId,kind:"preflight",sourceEventSha256:admitted.integrity.event_sha256})),/Loaded code differs from current executable bytes/);',
        'assert.equal(fs.existsSync(store.closedReviewPaths(f.repoRoot,f.taskId).navigation),false);'
    ].join('\n');
    const result = spawnSync(process.execPath, ['-r', require.resolve('../../../../src/bin/garda/derivation-source-receipts'), '-e', script],
        { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});
