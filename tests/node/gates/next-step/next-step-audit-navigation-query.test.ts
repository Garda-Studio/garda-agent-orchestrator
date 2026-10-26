import '../../../../src/bin/garda/derivation-source-receipts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { readTaskTimelineNavigationQuery } from '../../../../src/gate-runtime/timeline/task-events-integrity';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { buildNavigationTaskAuditSummary, buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';
import { createAuthenticatedNextStepHistoryFixture, completeAuthenticatedHistoryFixture,
    type AuthenticatedHistoryFixture } from './next-step-authenticated-history-fixture';

function assertNativeStatus(fixture: AuthenticatedHistoryFixture) {
    const timeline = path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/task-events', fixture.taskId + '.jsonl');
    const query = withInvocationReadObservation(() => readTaskTimelineNavigationQuery(timeline, fixture.taskId));
    assert.equal(query?.ordered, true, 'The real fixture must exercise the verified ordered view.');
    const full = buildTaskAuditSummary(fixture);
    let measurement: NextStepMeasurement | undefined;
    const navigation = withNextStepMeasurement(() => withInvocationReadObservation(() => buildNavigationTaskAuditSummary(fixture)),
        value => { measurement = value; });
    for (const key of ['status', 'integrity_status', 'events_count', 'first_event_utc', 'last_event_utc', 'gates',
        'blockers', 'required_reviews', 'review_coverage_summary'] as const) {
        assert.deepEqual(navigation[key], full[key], key);
    }
    for (const key of ['review_integrity_attestation', 'orchestrator_defect_capture'] as const)
        assert.deepEqual(navigation.final_closeout[key], full.final_closeout[key], key);
    assert.equal(measurement!.work['visit:audit_ordered_event_copy'] || 0, 0);
    assert.equal(measurement!.work['visit:audit_ordered_event_comparison'] || 0, 0);
    assert.equal(measurement!.work['visit:task-audit-summary-lifecycle:582'] || 0, 0, 'ordinary leaf still validates its queue without scanning parent history');
    assert.equal(measurement!.work['visit:task-audit-summary:145'] || 0, 0);
    assert.equal(measurement!.work['visit:task-audit-summary-review-integrity:88'] || 0, 0);
    return navigation;
}

test('Q5 real active required-review and completed audits preserve complete status and eager blockers without audit history scans',
    { concurrency: false }, async t => {
        const fixture = await createAuthenticatedNextStepHistoryFixture(2, 1, active => { assertNativeStatus(active); });
        t.after(() => fs.rmSync(fixture.repoRoot, { recursive: true, force: true }));
        assertNativeStatus(fixture);
        await completeAuthenticatedHistoryFixture(fixture);
        assertNativeStatus(fixture);
        const bundle = path.join(fixture.repoRoot, 'garda-agent-orchestrator');
        appendTaskEvent(bundle, fixture.taskId, 'REVIEW_RECORDED', 'PASS', 'A later unrequired lane must still invalidate fresh attestation.',
            { review_type: 'unrequired-lane' }, { passThru: true, lowNoiseRuntimeWrites: true });
        const full = buildTaskAuditSummary(fixture);
        const navigation = withInvocationReadObservation(() => {
            assert.equal(readTaskTimelineNavigationQuery(path.join(bundle, 'runtime/task-events', fixture.taskId + '.jsonl'), fixture.taskId)?.ordered, true);
            return buildNavigationTaskAuditSummary(fixture);
        });
        assert.equal(navigation.status, 'BLOCKED');
        assert.deepEqual(navigation.final_closeout.review_integrity_attestation, full.final_closeout.review_integrity_attestation);
        assert.match(JSON.stringify(navigation.final_closeout.review_integrity_attestation?.observed_issues), /recorded after current required-reviews gate/iu);
    });
