import '../../../../src/bin/garda/derivation-source-receipts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectAuthenticatedHistorySamples, type HistorySample } from './next-step-authenticated-samples-fixture';
import { assertStableAuthenticatedArtifactWork, comparableHistoryCounters, measureHistoryRoute } from './next-step-authenticated-budget-fixture';
import { createAuthenticatedNextStepHistoryFixture } from './next-step-authenticated-history-fixture';
import { buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';
import { readReviewCycleGuardEvaluation } from '../../../../src/gates/next-step/next-step-review-cycle-guard-evaluation';

interface CounterDifference { mode: HistorySample['mode']; route: string; counter: string; short: number; long: number; }
function differences(short: HistorySample, long: HistorySample): CounterDifference[] {
    assert.equal(short.mode, long.mode);
    return short.routes.flatMap((route, index) => {
        assert.equal(long.routes[index].route, route.route);
        assert.equal(long.routes[index].nextGate, route.nextGate);
        assert.equal(long.routes[index].status, route.status);
        assert.equal(long.routes[index].auditStatus, route.auditStatus);
        const a = comparableHistoryCounters(route), b = comparableHistoryCounters(long.routes[index]);
        return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(counter =>
            (a[counter] || 0) === (b[counter] || 0) ? [] : [{ mode: short.mode, route: route.route, counter,
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
    for (const sample of await collectAuthenticatedHistorySamples(1, lanes)) {
        retainSample(sample);
        const route = sample.routes.find(route => route.route === 'required-reviews-check')!;
        const checks = route.counters['scope_path_state:scope'] || 0, hashes = route.counters['file_hash:scope'] || 0;
        await context.test(sample.mode + ': scope checks and hashes equal 64 files', () => { assert.equal(checks, 64); assert.equal(hashes, 64); });
    }
});

test('Q1 authenticated history budget uses real navigation routes', { timeout: 3_600_000 }, async context => {
    for (const cycles of process.env.GARDA_Q1_INCLUDE_MIDPOINT === '1' ? [2, 8, 16] : [2, 16]) {
        for (const sample of await collectAuthenticatedHistorySamples(cycles, 3, cycles === 2)) {
            retainSample(sample);
            context.diagnostic(JSON.stringify({ cycles, lanes: 3, mode: sample.mode, routes: sample.routes.map(route => ({ route: route.route,
                elapsed_ms: route.elapsedMs, phases_ms: route.phasesMs })) }));
        }
    }
    const mode = 'navigation';
    const short = samples.find(sample => sample.cycles === 2 && sample.mode === mode)!;
    const long = samples.find(sample => sample.cycles === 16 && sample.mode === mode)!;
    await context.test(mode + ': indexed route selectors retain constant work on real authenticated history', () => {
        for (let index = 0; index < short.routes.length; index++) {
            const a = short.routes[index], b = long.routes[index];
            for (const key of ['visit:next-step-reviewer-launch-evidence-shared:35',
                'visit:next-step-review-invocation-evidence:50', 'visit:next-step-review-evidence:187',
                'visit:next-step-review-evidence:632', 'visit:next-step-reviewer-launch-evidence:event:1181']) {
                assert.equal(a.counters[key] || 0, 0, a.route + ':' + key);
                assert.equal(b.counters[key] || 0, 0, b.route + ':' + key);
            }
            for (const key of ['visit:route_query_preflight_witness', 'visit:route_query_preflight_prefix_witness',
                'visit:route_query_witness_comparison', 'visit:route_query_attestation_candidate'])
                assert.equal(b.counters[key] || 0, a.counters[key] || 0, b.route + ':' + key);
        }
    });
    await context.test(mode + ': Q7 terminal report object projections are flat on the existing 2/16-cycle fixtures', () => {
        for (const route of ['DONE', 'post-done-drift']) {
            const a = short.routes.find(sample => sample.route === route)!;
            const b = long.routes.find(sample => sample.route === route)!;
            assert.equal(b.counters['visit:terminal-materialized:parsed-value'], a.counters['visit:terminal-materialized:parsed-value'], route);
            context.diagnostic(JSON.stringify({ route, samples: [short, long].map(sample => ({
                cycles: sample.cycles, file_bytes: sample.materializedBytes,
                bytes_hashed: sample.routes.find(value => value.route === route)!.counters.terminal_materialized_bytes_hashed,
                parsed_values: sample.routes.find(value => value.route === route)!.counters['visit:terminal-materialized:parsed-value']
            })) }));
        }
    });
    // Retain every measured difference, including mandatory current-file byte work.
    // The operator prioritizes correct navigation and removal of redundant work over literal zero differences.
    const changed = differences(short, long);
    const growing = [...new Set(changed.filter(entry => entry.long > entry.short).map(entry => entry.counter))];
    context.diagnostic('Q1 ' + mode + ' growing counters: ' + JSON.stringify(growing));
    context.diagnostic('Q1 ' + mode + ' remaining counter differences: ' + JSON.stringify(changed));
    await context.test(mode + ': consumers share one verified index without duplicate timeline parsing or copies', () => {
        for (const sample of samples) for (const route of sample.routes) {
            assert.equal(route.counters.timeline_verify, 1, route.route + ': full integrity verification remains live');
            assert.ok(route.counters.timeline_events > 0, route.route + ': real history was visited');
            assert.equal(route.counters['visit:verified_timeline_index_event'], route.counters.timeline_events,
                route.route + ': canonical fixture events enter the shared index exactly once');
            for (const key of ['visit:validation_timeline_parse_event', 'visit:timeline_cloned_event',
                'visit:audit_ordered_event_copy']) assert.equal(route.counters[key] || 0, 0, route.route + ':' + key);
        }
    });
    await context.test(mode + ': authenticated artifact reads and parsing do not multiply with closed cycles', () => {
        for (let index = 0; index < short.routes.length; index++)
            assertStableAuthenticatedArtifactWork(short.routes[index], long.routes[index]);
        for (const sample of samples.filter(sample => sample.mode === mode)) for (const route of sample.routes) {
            assert.equal(route.counters['timeline_payload_read:task'], 1);
            assert.equal(route.counters.timeline_parse, 1);
        }
    });
    context.diagnostic('Full per-path/per-cycle counters: ' + reportPath);
});


test('Q1 archived receipt corruption preserves navigation but blocks full audit', { timeout: 600_000 }, async context => {
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
        assert.equal(changed.nextGate, before.nextGate,
            'Unused closed archive corruption is rejected by the full audit under A8.');
        assert.equal(changed.auditStatus, before.auditStatus);
        const audit = buildTaskAuditSummary(fixture);
        assert.equal(audit.status, 'BLOCKED');
        assert.ok(audit.blockers.some(blocker => /history integrity|committed receipt|snapshot/iu.test(blocker.reason)));
        context.diagnostic(JSON.stringify({ before: { nextGate: before.nextGate, auditStatus: before.auditStatus },
            tampered: { nextGate: changed.nextGate, status: changed.status, auditStatus: changed.auditStatus,
                reason: changed.reason }, violations: guard.evaluation.violations }));
    } finally { fs.writeFileSync(oldReceiptPath, original); }
    assert.equal(measureHistoryRoute(fixture, 'restored').nextGate, before.nextGate);
});
