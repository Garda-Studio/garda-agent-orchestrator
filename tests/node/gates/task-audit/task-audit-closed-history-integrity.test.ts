import '../../../../src/bin/garda/derivation-source-receipts';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { handleTaskAuditSummary } from '../../../../src/cli/commands/gate-task-handlers';
import { buildTaskAuditSummary, type TaskAuditSummaryResult } from '../../../../src/gates/task-audit/task-audit-summary';
import { getReviewHistoryIntegrityViolations } from '../../../../src/gates/review-attempts/review-history-integrity';
import { createAuthenticatedNextStepHistoryFixture, completeAuthenticatedHistoryFixture,
    type AuthenticatedHistoryFixture } from '../next-step/next-step-authenticated-history-fixture';
import { getReviewsRoot, readTaskTimelineEvents } from '../../cli/commands/gates/review-cycle/gates-review-cycle-fixtures';

async function auditThroughHandler(fixture: AuthenticatedHistoryFixture): Promise<{
    exitCode: number; summary: TaskAuditSummaryResult;
}> {
    const outputPath = path.join(getReviewsRoot(fixture.repoRoot), 'closed-history-audit-output.json');
    const previousExitCode = process.exitCode;
    try {
        process.exitCode = 0;
        await handleTaskAuditSummary(['--repo-root', fixture.repoRoot, '--task-id', fixture.taskId,
            '--as-json', '--output-path', outputPath]);
        return { exitCode: Number(process.exitCode),
            summary: JSON.parse(fs.readFileSync(outputPath, 'utf8')) as TaskAuditSummaryResult };
    } finally {
        process.exitCode = previousExitCode;
    }
}

test('A8 explicit audit blocks a corrupted closed receipt and restores PASS after repair', { timeout: 600_000 }, async () => {
    const fixture = await createAuthenticatedNextStepHistoryFixture(2, 1);
    await completeAuthenticatedHistoryFixture(fixture);
    const accepted = await auditThroughHandler(fixture);
    assert.equal(accepted.exitCode, 0);
    assert.equal(accepted.summary.status, 'PASS', JSON.stringify(accepted.summary.blockers));
    assert.equal(accepted.summary.final_closeout.status, 'READY');

    const receiptPath = fixture.historicalArtifacts[0];
    assert.equal(fixture.artifactCycles[path.resolve(receiptPath)], 0);
    const events = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId);
    const recorded = events.findIndex(event => event.event_type === 'REVIEW_RECORDED'
        && path.resolve(String((event.details as Record<string, unknown>)?.receipt_snapshot_path || '')) === path.resolve(receiptPath));
    assert.ok(recorded >= 0, 'The corrupted receipt must be bound by the actual authenticated timeline.');
    assert.ok(events.slice(recorded + 1).some(event => event.event_type === 'REVIEW_CYCLE_RESTARTED'),
        'The receipt must belong to a cycle closed by a real restart.');
    const original = fs.readFileSync(receiptPath);
    try {
        fs.appendFileSync(receiptPath, ' ');
        const blockedSummary = buildTaskAuditSummary(fixture);
        assert.equal(blockedSummary.status, 'BLOCKED');
        assert.equal(blockedSummary.final_closeout.status, 'NOT_READY');
        assert.equal(blockedSummary.final_closeout.artifact_state, 'NOT_READY');
        assert.ok(blockedSummary.blockers.some(blocker => blocker.gate === 'review-history-integrity'));
        const blocked = await auditThroughHandler(fixture);
        assert.notEqual(blocked.exitCode, 0, 'Reporting missing/invalid without a failing command is insufficient.');
        assert.equal(blocked.summary.status, 'BLOCKED');
        assert.equal(blocked.summary.final_closeout.status, 'NOT_READY');
        assert.ok(['REMOVED', 'NOT_READY'].includes(blocked.summary.final_closeout.artifact_state));
        assert.equal(fs.existsSync(accepted.summary.final_closeout.artifact_paths.json), false,
            'Explicit audit must not leave the previously materialized READY closeout behind.');
    } finally {
        fs.writeFileSync(receiptPath, original);
    }
    const restored = await auditThroughHandler(fixture);
    assert.equal(restored.exitCode, 0);
    assert.equal(restored.summary.status, 'PASS', JSON.stringify(restored.summary.blockers));
    assert.equal(restored.summary.final_closeout.status, 'READY');
    assert.equal(restored.summary.final_closeout.artifact_state, 'MATERIALIZED');

    // Historical FAIL outcomes and old diagnostic-only attempts are not integrity failures.
    const historyViolations = getReviewHistoryIntegrityViolations({ ...fixture,
        reviewsRoot: getReviewsRoot(fixture.repoRoot),
        timelineEvents: [...events, { event_type: 'REVIEW_RECORDED', details: { review_type: 'code' } }] });
    assert.deepEqual(historyViolations, []);
});
