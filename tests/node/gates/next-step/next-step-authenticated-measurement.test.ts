import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectAuthenticatedHistorySample, type HistorySample } from './next-step-authenticated-samples-fixture';
import { comparableHistoryCounters, measureHistoryRoute } from './next-step-authenticated-budget-fixture';
import { createAuthenticatedNextStepHistoryFixture } from './next-step-authenticated-history-fixture';
import { readReviewCycleGuardEvaluation } from '../../../../src/gates/next-step/next-step-review-cycle-guard-evaluation';

interface CounterDifference { route: string; counter: string; short: number; long: number; }
function differences(short: HistorySample, long: HistorySample): CounterDifference[] {
    return short.routes.flatMap((route, index) => {
        assert.equal(long.routes[index].route, route.route);
        assert.equal(long.routes[index].nextGate, route.nextGate);
        assert.equal(long.routes[index].status, route.status);
        assert.equal(long.routes[index].auditStatus, route.auditStatus);
        const a = comparableHistoryCounters(route), b = comparableHistoryCounters(long.routes[index]);
        return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(counter =>
            (a[counter] || 0) === (b[counter] || 0) ? [] : [{ route: route.route, counter,
                short: a[counter] || 0, long: b[counter] || 0 }]);
    });
}

const samples: HistorySample[] = [];
const reportPath = process.env.GARDA_Q1_REPORT_PATH || path.join(os.tmpdir(), 'garda-q1-history-' + process.pid + '.json');
function retainSample(sample: HistorySample): void {
    samples.push(sample);
    fs.writeFileSync(reportPath, JSON.stringify({ schema_version: 1, samples }, null, 2) + '\n');
}

for (const lanes of [1, 5]) test('Q1 scope observation at ' + lanes + ' lanes', { timeout: 600_000 }, async context => {
    const sample = await collectAuthenticatedHistorySample(1, lanes);
    retainSample(sample);
    const route = sample.routes.find(route => route.route === 'required-reviews-check')!;
    const checks = route.counters['scope_path_state:scope'] || 0, hashes = route.counters['file_hash:scope'] || 0;
    await context.test('scope checks and hashes equal 64 files', () => { assert.equal(checks, 64); assert.equal(hashes, 64); });
});

test('Q1 authenticated history budget uses real navigation routes', { timeout: 3_600_000 }, async context => {
    for (const cycles of process.env.GARDA_Q1_INCLUDE_MIDPOINT === '1' ? [2, 8, 16] : [2, 16]) {
        const sample = await collectAuthenticatedHistorySample(cycles, 3, cycles === 2);
        retainSample(sample);
        context.diagnostic(JSON.stringify({ cycles, lanes: 3, routes: sample.routes.map(route => ({ route: route.route,
            elapsed_ms: route.elapsedMs, phases_ms: route.phasesMs })) }));
    }
    const short = samples.find(sample => sample.cycles === 2)!;
    const long = samples.find(sample => sample.cycles === 16)!;
    const changed = differences(short, long);
    const growing = [...new Set(changed.filter(entry => entry.long > entry.short).map(entry => entry.counter))];
    context.diagnostic('Q1 growing counters: ' + JSON.stringify(growing));
    await context.test('history counters are identical at 2 and 16 cycles', {
        todo: 'Round 6b RED on pre-Q2 HEAD; growing counters: ' + growing.join(', ')
    }, () => {
        assert.deepEqual(changed, []);
        for (const sample of samples) for (const route of sample.routes) {
            assert.equal(route.counters['timeline_payload_read:task'], 1);
            assert.equal(route.counters.timeline_parse, 1);
        }
    });
    context.diagnostic('Full per-path/per-cycle counters: ' + reportPath);
});


test('Q1 closed-cycle receipt integrity still changes the real navigation route', { timeout: 600_000 }, async context => {
    const fixture = await createAuthenticatedNextStepHistoryFixture(2, 3);
    const before = measureHistoryRoute(fixture, 'required-reviews-check');
    assert.equal(before.nextGate, 'required-reviews-check', before.reason);
    const eventsRoot = path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/task-events');
    const beforeGuard = readReviewCycleGuardEvaluation(fixture.repoRoot, eventsRoot, fixture.taskId);
    assert.equal(beforeGuard.evaluation.should_block, false);
    const oldReceiptPath = fixture.historicalArtifacts[0];
    assert.equal(fixture.artifactCycles[path.resolve(oldReceiptPath)], 0);
    const original = fs.readFileSync(oldReceiptPath);
    const currentReceiptPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/reviews',
        fixture.taskId + '-code-receipt.json');
    assert.equal(original.equals(fs.readFileSync(currentReceiptPath)), false,
        'The changed receipt belongs to an earlier cycle, not the accepted current code review.');
    try {
        fs.appendFileSync(oldReceiptPath, ' ');
        const guard = readReviewCycleGuardEvaluation(fixture.repoRoot, eventsRoot, fixture.taskId);
        assert.equal(guard.evaluation.should_block, true);
        assert.ok(guard.evaluation.violations.some(violation => violation.metric === 'timeline_integrity'));
        const changed = measureHistoryRoute(fixture, 'tampered-closed-receipt');
        assert.notEqual(changed.nextGate, before.nextGate,
            'Removing the closed receipt read would remove an existing navigation rejection.');
        context.diagnostic(JSON.stringify({ before: { nextGate: before.nextGate, auditStatus: before.auditStatus },
            tampered: { nextGate: changed.nextGate, status: changed.status, auditStatus: changed.auditStatus,
                reason: changed.reason }, violations: guard.evaluation.violations }));
    } finally { fs.writeFileSync(oldReceiptPath, original); }
    assert.equal(measureHistoryRoute(fixture, 'restored').nextGate, before.nextGate);
});
