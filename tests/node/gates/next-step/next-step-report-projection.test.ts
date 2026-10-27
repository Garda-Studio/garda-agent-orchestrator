import '../../../../src/bin/garda/derivation-source-receipts';
/** Real next-step and native authenticated history/completion fixtures. */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { formatFinalCloseoutMarkdown, formatFinalUserReport } from '../../../../src/gates/task-audit/task-audit-summary-renderers';
import { synchronizeFinalCloseoutArtifacts } from '../../../../src/gates/task-audit/task-audit-summary-closeout-sync';
import { resolveNextStep, type NextStepResult } from '../../../../src/gates/next-step';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { createAuthenticatedNextStepHistoryFixture, completeAuthenticatedHistoryFixture,
    type AuthenticatedHistoryFixture } from './next-step-authenticated-history-fixture';
import { getReviewsRoot } from '../../cli/commands/gates/review-cycle/gates-review-cycle-fixtures';
import { readMaterializedTerminalProjection, publishMaterializedTerminalProjection } from '../../../../src/gates/task-audit/task-audit-materialized-terminal';
import { buildNavigationTaskAuditSummary, buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';

const terminalModule = require('../../../../src/gates/task-audit/task-audit-materialized-terminal') as {
    publishMaterializedTerminalProjection: typeof publishMaterializedTerminalProjection;
};
const auditModule = require('../../../../src/gates/task-audit/task-audit-summary') as {
    buildNavigationTaskAuditSummary: typeof buildNavigationTaskAuditSummary;
};
function fullAuditNextStep(fixture: AuthenticatedHistoryFixture): NextStepResult {
    const original = auditModule.buildNavigationTaskAuditSummary;
    auditModule.buildNavigationTaskAuditSummary = buildTaskAuditSummary;
    try { return resolveNextStep(fixture); } finally { auditModule.buildNavigationTaskAuditSummary = original; }
}
const stable = (result: NextStepResult) => ({ ...result, generated_utc: '<generated>' });
function measured(fixture: AuthenticatedHistoryFixture) {
    let measurement: NextStepMeasurement | undefined;
    const result = withNextStepMeasurement(() => resolveNextStep(fixture), value => { measurement = value; });
    assert.ok(measurement);
    return { result, work: measurement.work };
}
function assertEquivalent(fixture: AuthenticatedHistoryFixture) {
    let nativeMeasurement: NextStepMeasurement | undefined;
    const expected = withNextStepMeasurement(() => fullAuditNextStep(fixture), value => { nativeMeasurement = value; });
    const actual = measured(fixture);
    assert.ok(nativeMeasurement);
    assert.deepEqual(stable(actual.result), stable(expected));
    return { ...actual, nativeWork: nativeMeasurement.work };
}
const historicalReportBuilders = ['closeout', 'review-attempts', 'review-findings', 'review-timing', 'change-metrics'];
function assertNoReportHistory(work: Record<string, number>) {
    for (const name of historicalReportBuilders) assert.equal(work['report_projection:' + name] || 0, 0, name);
    assert.equal(work['visit:audit_review_attempt_event'] || 0, 0);
}
function paths(fixture: AuthenticatedHistoryFixture) {
    const root = getReviewsRoot(fixture.repoRoot), prefix = path.join(root, fixture.taskId);
    return { json: prefix + '-final-closeout.json', markdown: prefix + '-final-closeout.md', report: prefix + '-final-user-report.md',
        projection: prefix + '-final-navigation.json', ledger: path.join(path.dirname(root), 'task-ledger', fixture.taskId + '.json') };
}

// Serial because the native-vs-navigation comparison replaces one module export temporarily.
test('Q7 real active, required-review, DONE and drift routes preserve complete next-step output', { concurrency: false }, async t => {
    const fixture = await createAuthenticatedNextStepHistoryFixture(2, 3, active => {
        const sample = assertEquivalent(active);
        assert.equal(sample.result.next_gate, 'record-review-result');
        assert.ok((sample.nativeWork['visit:audit_review_attempt_event'] || 0) > 0, 'the real eager path rebuilds history');
        assertNoReportHistory(sample.work);
        assert.equal(sample.work['report_projection:task-cycle-status'] || 0, 0, 'active status does not consume report commit presentation');
    });
    t.after(() => fs.rmSync(fixture.repoRoot, { recursive: true, force: true }));
    const required = assertEquivalent(fixture);
    assert.equal(required.result.next_gate, 'required-reviews-check');
    assert.ok((required.nativeWork['visit:audit_review_attempt_event'] || 0) > 0, 'the real eager path rebuilds history');
    assertNoReportHistory(required.work);
    const navigation = buildNavigationTaskAuditSummary(fixture), full = buildTaskAuditSummary(fixture);
    assert.equal(navigation.status, full.status); assert.deepEqual(navigation.blockers, full.blockers);
    assert.deepEqual(navigation.gates, full.gates); assert.deepEqual(navigation.review_coverage_summary, full.review_coverage_summary);
    await t.test('only consumed report fields derive once inside their original invocation', () => {
        let measured: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => withInvocationReadObservation(() => {
            const lazy = buildNavigationTaskAuditSummary(fixture);
            assert.equal(lazy.status, full.status);
            assert.deepEqual(lazy.blockers, full.blockers);
            const attempts = lazy.review_attempt_summary;
            assert.strictEqual(lazy.review_attempt_summary, attempts);
        }), value => { measured = value; });
        assert.equal(measured?.work['report_projection:review-attempts'], 1);
        for (const name of ['closeout', 'review-findings', 'change-metrics', 'task-cycle-status'])
            assert.equal(measured?.work['report_projection:' + name] || 0, 0, name);
        // Public standalone snapshots remain mutable data, with no delayed filesystem reads.
        assert.equal(Object.getOwnPropertyDescriptor(navigation, 'final_closeout')?.get, undefined);
        assert.equal(Object.getOwnPropertyDescriptor(full, 'final_closeout')?.get, undefined);
        const original = navigation.changed_lines_total;
        navigation.changed_lines_total = original + 1;
        assert.equal(navigation.changed_lines_total, original + 1);
        navigation.changed_lines_total = original;
        const escaped = withInvocationReadObservation(() => buildNavigationTaskAuditSummary(fixture));
        assert.throws(() => escaped.review_attempt_summary, /escaped its invocation/);
    });
    await completeAuthenticatedHistoryFixture(fixture);
    assert.ok(fs.existsSync(paths(fixture).projection), 'real completion must publish the optional terminal acceleration for Q1');
    const done = assertEquivalent(fixture); assert.equal(done.result.status, 'DONE'); assertNoReportHistory(done.work);
    assert.ok(done.work.terminal_materialized_bytes_hashed > 0, 'all retained materialized bytes remain authenticated');
    assert.equal(done.work.terminal_materialized_projection_selected, 1, 'native published projection is selected');
    const retained = Object.values(paths(fixture)).concat(path.join(fixture.repoRoot, fixture.files[0]))
        .map(file => ({ file, bytes: fs.readFileSync(file) }));
    const restore = () => {
        for (const { file, bytes } of retained) {
            if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) fs.writeFileSync(file, bytes);
        }
    };
    fs.appendFileSync(path.join(fixture.repoRoot, fixture.files[0]), 'export const q7drift = true;\n');
    const drift = assertEquivalent(fixture); assert.equal(drift.result.next_gate, 'post-done-drift'); assertNoReportHistory(drift.work);
    restore();
    await t.test('Q7 cold terminal navigation preserves native results with present or missing projection', () => {
        try {
            for (const projectionPresent of [true, false]) {
                for (const drifted of [false, true]) {
                    restore();
                    if (!projectionPresent) fs.rmSync(paths(fixture).projection);
                    if (drifted) fs.appendFileSync(path.join(fixture.repoRoot, fixture.files[0]), 'export const coldDrift = true;\n');
                    const expected = resolveNextStep(fixture);
                    assert.equal(drifted ? expected.next_gate : expected.status, drifted ? 'post-done-drift' : 'DONE');
                    const script = [
                        'const {resolveNextStep}=require(' + JSON.stringify(require.resolve('../../../../src/gates/next-step')) + ');',
                        'const {withNextStepMeasurement}=require(' + JSON.stringify(require.resolve('../../../../src/core/next-step-measurement')) + ');',
                        'let work;const result=withNextStepMeasurement(()=>resolveNextStep(' + JSON.stringify({ repoRoot: fixture.repoRoot, taskId: fixture.taskId }) + '),value=>work=value.work);',
                        'process.stdout.write(JSON.stringify({result,selected:work.terminal_materialized_projection_selected||0}));'
                    ].join('\n');
                    const child = spawnSync(process.execPath, ['-r', require.resolve('../../../../src/bin/garda/derivation-source-receipts'), '-e', script],
                        { encoding: 'utf8', timeout: 60_000, windowsHide: true });
                    assert.equal(child.status, 0, child.stdout + child.stderr);
                    const actual = JSON.parse(child.stdout) as { result: NextStepResult; selected: number };
                    assert.deepEqual(stable(actual.result), stable(expected));
                    assert.equal(actual.selected, projectionPresent ? 1 : 0, 'fresh process selects the native projection when present');
                }
            }
        } finally { restore(); }
    });
    await t.test('Q7 materialized old ledger without new projection uses existing checks without history rebuild', () => {
        try {
            fs.rmSync(paths(fixture).projection, { force: true });
            const done = assertEquivalent(fixture);
            assert.equal(done.result.status, 'DONE'); assertNoReportHistory(done.work);
            assert.equal(done.work.terminal_legacy_without_materialized_result || 0, 0, 'missing accelerator is NOT A6 legacy');
            assert.ok(Object.entries(done.work).some(([key, value]) => key.includes('task-audit-summary-renderers') && value > 0),
                'existing materialized Markdown comparison still runs');
        } finally { restore(); }
    });
    await t.test('Q7 report-only old materialization retains exact native fallback and rejects changed report', () => {
        try {
            const file = paths(fixture);
            fs.rmSync(file.projection, { force: true }); fs.rmSync(file.ledger);
            const done = assertEquivalent(fixture);
            assert.equal(done.result.status, 'DONE', 'formerly accepted valid materialized report stays accepted without ledger');
            assert.ok((done.work['report_projection:closeout'] || 0) > 0, 'exact-match fallback is preserved, not silently waived');
            assert.equal(done.work.terminal_legacy_without_materialized_result || 0, 0);
            const originalCloseout = fs.readFileSync(file.json, 'utf8');
            const tamperedCloseout = { ...JSON.parse(originalCloseout), q7_tampered_report: true };
            fs.writeFileSync(file.json, JSON.stringify(tamperedCloseout, null, 2) + '\n');
            // All old renderer comparisons still match: only exact current-summary authority
            // can reject the added field when both the ledger and signed proof are absent.
            assert.equal(fs.readFileSync(file.markdown, 'utf8'), formatFinalCloseoutMarkdown(tamperedCloseout) + '\n');
            assert.equal(fs.readFileSync(file.report, 'utf8'), formatFinalUserReport(tamperedCloseout) + '\n');
            const changedCloseout = assertEquivalent(fixture);
            assert.notEqual(changedCloseout.result.status, 'DONE'); assert.equal(changedCloseout.result.final_report, null);
            assert.ok((changedCloseout.work['report_projection:closeout'] || 0) > 0, 'old exact-current-summary comparison rejects altered materialized JSON');
            fs.writeFileSync(file.json, originalCloseout);
            fs.appendFileSync(file.report, '\nchanged report\n');
            const rejected = assertEquivalent(fixture);
            assert.notEqual(rejected.result.status, 'DONE'); assert.equal(rejected.result.final_report, null);
        } finally { restore(); }
    });
    await t.test('Q7 actual A6 legacy case has no materialized result and retains the old full computation', () => {
        try {
            for (const file of Object.values(paths(fixture))) fs.rmSync(file, { force: true });
            const legacy = assertEquivalent(fixture);
            assert.equal(legacy.work.terminal_legacy_without_materialized_result, 1);
            assert.ok((legacy.work['report_projection:closeout'] || 0) > 0);
            assert.notEqual(legacy.result.status, 'DONE');
        } finally { restore(); }
    });
    await t.test('native renderer timezone changes invalidate the materialized proof', context => {
        const previous = process.env.TZ;
        const originalZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
        try {
            process.env.TZ = originalZone === 'Pacific/Honolulu' ? 'UTC' : 'Pacific/Honolulu';
            if (new Intl.DateTimeFormat().resolvedOptions().timeZone === originalZone) {
                context.skip('This runtime does not apply TZ changes during the process.'); return;
            }
            const file = paths(fixture);
            assert.equal(readMaterializedTerminalProjection(fixture.repoRoot, file.json, fixture.taskId), null);
            assertEquivalent(fixture); // Native rendering remains authoritative after a context change.
        } finally {
            // Node on Windows keeps the last timezone when an absent TZ is only deleted.
            process.env.TZ = previous ?? originalZone;
            if (previous === undefined) delete process.env.TZ;
            assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, originalZone);
        }
    });
    await t.test('terminal current bytes remain final invocation dependencies and public projections are isolated', () => {
        try {
            const file = paths(fixture);
            withInvocationReadObservation(() => {
                const first = readMaterializedTerminalProjection(fixture.repoRoot, file.json, fixture.taskId);
                assert.ok(first);
                first.projection.implementation_summary.q7_caller_mutation = true;
                const second = readMaterializedTerminalProjection(fixture.repoRoot, file.json, fixture.taskId);
                assert.ok(second);
                assert.equal(Object.hasOwn(second.projection.implementation_summary, 'q7_caller_mutation'), false);
            });
            assert.throws(() => withInvocationReadObservation(() => {
                assert.ok(readMaterializedTerminalProjection(fixture.repoRoot, file.json, fixture.taskId));
                fs.appendFileSync(file.report, 'changed during invocation');
                assert.ok(readMaterializedTerminalProjection(fixture.repoRoot, file.json, fixture.taskId),
                    'same invocation retains the original observation until final validation');
            }), /changed|unavailable/iu);
        } finally { restore(); }
    });
    await t.test('optional terminal publication failure preserves native owner materialization', () => {
        const failure = mock.method(terminalModule, 'publishMaterializedTerminalProjection', () => {
            throw new Error('Q7 optional publication unavailable');
        });
        try {
            const summary = buildTaskAuditSummary(fixture);
            const actual = synchronizeFinalCloseoutArtifacts(summary, { deferTerminalCleanup: true });
            assert.strictEqual(actual, summary);
            assert.equal(actual.final_closeout.artifact_state, 'MATERIALIZED');
            const file = paths(fixture);
            for (const target of [file.json, file.markdown, file.report, file.ledger]) assert.ok(fs.existsSync(target));
            assert.equal(assertEquivalent(fixture).result.status, 'DONE');
        } finally { failure.mock.restore(); restore(); }
    });
    await t.test('Q7 signed terminal projection never skips altered current JSON, Markdown, report or ledger bytes', () => {
        try {
            const file = paths(fixture);
            for (const target of [file.json, file.markdown, file.report, file.ledger]) {
                const before = fs.readFileSync(target);
                try {
                    fs.appendFileSync(target, ' ');
                    assert.equal(readMaterializedTerminalProjection(fixture.repoRoot, file.json, fixture.taskId), null, target);
                    // Native fallback may still accept a merely reformatted ledger; exact output must match.
                    assertEquivalent(fixture);
                } finally { fs.writeFileSync(target, before); }
            }
        } finally { restore(); }
    });
});
