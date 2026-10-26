import { fileSha256 } from '../../../../src/core/file-hashing';
import { buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';
import { isPlainRecord } from '../../../../src/core/records';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleRecordReviewResult } from '../../../../src/cli/commands/gate-review-handlers';
import { readReviewOutputCorrectionArtifact } from '../../../../src/gates/review/review-output-correction';
import { getReviewsRoot, getOrchestratorRoot, readTaskTimelineEvents } from '../../cli/commands/gates/review-cycle/gates-review-cycle-fixtures';
import type { AuthenticatedHistoryFixture } from './next-step-authenticated-history-fixture';

/** The real result handler rejects an unconsumed attempt and publishes its correction. */
export async function retainHistoryCorrectionAttempt(state: AuthenticatedHistoryFixture, cycle: number): Promise<void> {
    const root = getReviewsRoot(state.repoRoot), prefix = path.join(root, state.taskId + '-code');
    const contextPath = prefix + '-review-context.json';
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    const report = JSON.parse(fs.readFileSync(prefix + '.md', 'utf8'));
    report.unexpected = `cycle-${cycle}`;
    const outputPath = path.join(getOrchestratorRoot(state.repoRoot), 'runtime/tmp/reviews', state.taskId, 'code/review-output.md');
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
    const events = readTaskTimelineEvents(state.repoRoot, state.taskId);
    const invocation = [...events].reverse().find(event => event.event_type === 'REVIEWER_INVOCATION_ATTESTED' && isPlainRecord(event.details) && event.details.review_type === 'code');
    assert.ok(invocation && isPlainRecord(invocation.details) && isPlainRecord(invocation.integrity));
    const invocationDetails = invocation.details;
    const invocationIntegrity = invocation.integrity;
    const completed = new Date(String(invocationDetails.launch_completed_at_utc));
    assert.ok(completed >= new Date(String(invocationDetails.delegation_started_at_utc)));
    fs.utimesSync(outputPath, completed, completed);
    await assert.rejects(() => handleRecordReviewResult(['--repo-root', state.repoRoot, '--task-id', state.taskId,
        '--review-type', 'code', '--preflight-path', state.preflightPath, '--review-context-path', contextPath,
        '--review-output-path', outputPath, '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', String(invocationDetails.reviewer_identity)]), /findings JSON report is invalid/u);
    const correction = readReviewOutputCorrectionArtifact(prefix + '-output-correction.json');
    assert.deepEqual(correction.violations, []);
    assert.ok(correction.artifact);
    assert.equal(correction.artifact.binding.reviewer_attempt_id, invocationDetails.reviewer_launch_attempt_id);
    assert.equal(correction.artifact.binding.review_context_sha256, report.review_context_sha256);
    assert.equal(correction.artifact.binding.review_tree_state_sha256, context.tree_state.tree_state_sha256);
    const event = [...readTaskTimelineEvents(state.repoRoot, state.taskId)].reverse().find(item => item.event_type === 'REVIEW_OUTPUT_CORRECTION_REQUIRED');
    assert.ok(event && isPlainRecord(event.details));
    const eventDetails = event.details;
    assert.equal(eventDetails.reviewer_invocation_event_sha256, invocationIntegrity.event_sha256);
    assert.equal(eventDetails.provider_id, 'Codex');
    assert.equal(eventDetails.provider_invocation_id, invocationDetails.provider_invocation_id);
    assert.ok(isPlainRecord(event.integrity));
    const eventSha256 = String(event.integrity.event_sha256);
    const audit = buildTaskAuditSummary(state).review_findings_audit?.correction_transports
        ?.find(item => item.event_sha256 === eventSha256);
    assert.ok(audit?.evidence_valid, JSON.stringify(audit));
    state.correctionProofs.push(eventSha256);
    const packageSha256 = String(eventDetails.correction_package_sha256);
    const packagePath = prefix + '-output-correction-attempt-' + correction.artifact.recovery.correction_attempt + '-' + packageSha256 + '.json';
    assert.equal(fileSha256(packagePath), packageSha256);
    state.correctionPackages[packagePath] = packageSha256;
}
