import { getReviewsRoot } from '../../cli/commands/gates/review-cycle/gates-review-cycle-fixtures';
import { isPlainRecord } from '../../../../src/core/records';
import { fileSha256 } from '../../../../src/core/file-hashing';
import { readTaskTimelineEvents } from '../../cli/commands/gates/review-cycle/gates-review-cycle-fixtures';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';
import { createAuthenticatedNextStepHistoryFixture, completeAuthenticatedHistoryFixture } from './next-step-authenticated-history-fixture';
import { measureHistoryRoute, type HistoryRouteMeasurement } from './next-step-authenticated-budget-fixture';

export interface HistorySample {
    cycles: number;
    lanes: number;
    mode: 'disabled';
    routes: HistoryRouteMeasurement[];
    materializedBytes: Record<string, number>;
}

function assertNoReportHistory(route: HistoryRouteMeasurement): void {
    for (const name of ['closeout', 'review-attempts', 'review-findings', 'review-timing', 'change-metrics'])
        assert.equal(route.counters['report_projection:' + name] || 0, 0, route.route + ':' + name);
    assert.equal(route.counters['visit:audit_review_attempt_event'] || 0, 0, route.route + ':attempt-history');
}

/** Construction/assertions stay outside TODO, so malformed evidence cannot count as RED. */
export async function collectAuthenticatedHistorySample(cycles: number, lanes = 3, proveHistory = false): Promise<HistorySample> {
    const routes: HistoryRouteMeasurement[] = [];
    const fixture = await createAuthenticatedNextStepHistoryFixture(cycles, lanes, active => {
        const measured = measureHistoryRoute(active, 'active-review');
        assert.equal(measured.nextGate, 'record-review-result');
        assertNoReportHistory(measured);
        routes.push(measured);
    });
    const required = measureHistoryRoute(fixture, 'required-reviews-check');
    assert.equal(required.nextGate, 'required-reviews-check', required.reason);
    assertNoReportHistory(required);
    routes.push(required);
    if (lanes === 3) {
        assert.ok(fixture.testBaselinePath);
        const relative = path.relative(fixture.repoRoot, fixture.testBaselinePath).replace(/\\/gu, '/');
        assert.ok(required.artifactsByPath['payload_read:' + relative] > 0,
            'Current DELTA review must consume its authenticated retained baseline.');
    }
    if (proveHistory) {
        const audit = buildTaskAuditSummary(fixture);
        const corrections = audit.review_findings_audit?.correction_transports || [];
        assert.equal(corrections.length, cycles);
        assert.equal(fixture.correctionProofs.length, cycles);
        for (const [file, digest] of Object.entries(fixture.correctionPackages)) assert.equal(fileSha256(file), digest);
        assert.ok(corrections.every(item => fixture.correctionProofs.includes(item.event_sha256 || '')));
        assert.equal(corrections.at(-1)?.evidence_valid, true);
        const missing = () => buildTaskAuditSummary(fixture).review_attempt_summary?.review_types
            .reduce((sum, lane) => sum + lane.missing_or_invalid_count, 0) || 0;
        const before = missing();
        const oldReceiptPath = fixture.historicalArtifacts[0], original = fs.readFileSync(oldReceiptPath);
        try {
            fs.appendFileSync(oldReceiptPath, ' ');
            assert.ok(missing() > before, 'Explicit audit must reject the altered closed-cycle receipt.');
        } finally { fs.writeFileSync(oldReceiptPath, original); }
    }
    await completeAuthenticatedHistoryFixture(fixture);
    if (proveHistory) {
        const corrections = buildTaskAuditSummary(fixture).review_findings_audit?.correction_transports || [];
        const compile = [...readTaskTimelineEvents(fixture.repoRoot, fixture.taskId)].reverse().find(event => event.event_type === 'COMPILE_GATE_PASSED');
        assert.ok(isPlainRecord(compile?.integrity));
        const compileSha256 = String(compile.integrity.event_sha256);
        assert.match(compileSha256 || '', /^[a-f0-9]{64}$/u);
        assert.ok(corrections.every(item => item.audit_scope === 'SUPERSEDED_CYCLE'
            && item.superseded_by_compile_event_sha256 === compileSha256), JSON.stringify(corrections));
    }
    const reviewsRoot = getReviewsRoot(fixture.repoRoot), prefix = path.join(reviewsRoot, fixture.taskId);
    const materializedFiles = {
        json: prefix + '-final-closeout.json', markdown: prefix + '-final-closeout.md',
        report: prefix + '-final-user-report.md', projection: prefix + '-final-navigation.json',
        ledger: path.join(path.dirname(reviewsRoot), 'task-ledger', fixture.taskId + '.json')
    };
    assert.ok(fs.existsSync(materializedFiles.projection), 'Q7 real native owner must publish terminal acceleration');
    const materializedBytes = Object.fromEntries(Object.entries(materializedFiles).map(([name, file]) => [name, fs.statSync(file).size]));
    const done = measureHistoryRoute(fixture, 'DONE');
    assert.equal(done.status, 'DONE');
    assertNoReportHistory(done);
    assert.equal(done.counters.terminal_materialized_projection_selected, 1, 'DONE selects the native owner projection');
    routes.push(done);
    fs.appendFileSync(path.join(fixture.repoRoot, fixture.files[0]), 'export const drift = true;\n');
    const drift = measureHistoryRoute(fixture, 'post-done-drift');
    assert.equal(drift.nextGate, 'post-done-drift');
    assertNoReportHistory(drift);
    assert.equal(drift.counters.terminal_materialized_projection_selected, 1, 'drift selects the native owner projection');
    const mandatoryBytes = materializedBytes.json + materializedBytes.markdown + materializedBytes.report + materializedBytes.ledger;
    for (const route of [done, drift]) assert.equal(route.counters.terminal_materialized_bytes_hashed, mandatoryBytes,
        route.route + ': every current materialized byte remains authenticated');
    routes.push(drift);
    return { cycles, lanes, mode: 'disabled', routes, materializedBytes };
}
