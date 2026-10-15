import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';
import { readReviewOutputCorrectionArtifact } from '../../../../../../src/gates/review/review-output-correction';
import {
    createTempRepo, seedPromptBoundReviewFixture, prepareReviewerLaunchForTest,
    recordReviewerDelegationStartedForTest, launchArtifactInputArgsForTest,
    runCliWithCapturedOutput, readTaskTimelineEvents
} from '../review-launch/gates-command-review-launch-fixtures';
import { buildNoFindingsJsonReviewReport } from './gates-command-review-result-fixtures';

it('preserves the attested controller invocation when a Codex report requires correction', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-CONTROLLER-CORRECTION';
    // These launches are isolated CLI fixtures, never production review evidence.
    const controllerId = '/root/unit-controller-correction';
    try {
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId, provider: 'Codex' });
        const { launchArtifactPath, reviewerIdentity } = fixture;
        await prepareReviewerLaunchForTest({ repoRoot, taskId, reviewerIdentity, launchArtifactPath });
        await recordReviewerDelegationStartedForTest({
            repoRoot, taskId, reviewerIdentity, launchArtifactPath,
            controllerInvocationId: controllerId, attestationSource: 'collaboration.spawn_agent'
        });
        const prepared = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        const outputPath = String(prepared.review_output_path);
        assert.ok(path.isAbsolute(outputPath));
        const report = buildNoFindingsJsonReviewReport(fixture.reviewContextPath, taskId);
        report.unexpected = true;
        const rejectedBytes = `${JSON.stringify(report, null, 2)}\n`;
        fs.writeFileSync(outputPath, rejectedBytes, 'utf8');
        const complete = await runCliWithCapturedOutput([
            'gate', 'complete-reviewer-launch', '--task-id', taskId, '--review-type', 'code',
            '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity, '--reviewer-launch-artifact-path', launchArtifactPath,
            '--controller-invocation-id', controllerId, '--attestation-source', 'collaboration.spawn_agent',
            ...launchArtifactInputArgsForTest(launchArtifactPath), '--fork-context', 'false', '--record-invocation'
        ], { cwd: repoRoot });
        assert.equal(complete.exitCode, 0, complete.errors.join('\n'));
        const launch = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(launch.controller_invocation_id, controllerId);
        assert.equal(launch.provider_invocation_id, undefined);
        const invocation = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse().find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
        assert.equal((invocation?.details as Record<string, unknown>).provider_invocation_id, controllerId);
        const rejected = await runCliWithCapturedOutput([
            'gate', 'record-review-result', '--task-id', taskId, '--review-type', 'code',
            '--preflight-path', fixture.preflightPath, '--review-output-path', outputPath,
            '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ], { cwd: repoRoot });
        assert.notEqual(rejected.exitCode, 0);
        const correction = readReviewOutputCorrectionArtifact(
            path.join(fixture.reviewsRoot, `${taskId}-code-output-correction.json`)
        );
        assert.ok(correction.artifact, [...rejected.errors, ...rejected.logs].join('\n'));
        assert.deepEqual(correction.violations, []);
        assert.equal(correction.artifact?.transport_binding?.provider_invocation_id, controllerId);
        assert.equal(correction.artifact?.transport_binding?.session_availability, 'stateless');
        assert.equal(correction.artifact?.recovery.selected_transport, 'correction_only_invocation');
        assert.equal(correction.artifact?.recovery.available_transports.includes('live_reviewer_continuation'), false);
        assert.equal(fs.readFileSync(outputPath, 'utf8'), rejectedBytes);
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
