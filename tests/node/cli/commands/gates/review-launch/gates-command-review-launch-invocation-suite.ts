import {
    assert,
    appendTaskEvent,
    completeReviewerLaunchArtifactForTest,
    createReviewerRoutingFixture,
    createTempRepo,
    describe,
    fileSha256ForTest,
    fs,
    getOrchestratorRoot,
    getReviewsRoot,
    it as nodeIt,
    launchArtifactInputArgsForTest,
    manualReviewContextBindingFixture,
    manualReviewContextTaskScopeFixture,
    path,
    prepareCurrentReviewPhase,
    prepareReviewerLaunchForTest,
    readTaskTimelineEvents,
    recordReviewerDelegationStartedForTest,
    reviewerLaunchInputArtifactForTest,
    reviewContextScopedDiffFixture,
    runCliMainWithHandling,
    runCliWithCapturedOutput,
    seedInitAnswers,
    seedPromptBoundReviewFixture,
    seedRoutedReviewerLaunchFixture,
    seedTaskQueue,
    writeManualReviewerHandoffFixture,
    writePreflight
} from './gates-command-review-launch-fixtures';
import { createPartitionedTestRegistrar } from '../../gate-test-partition';

const TEST_LAUNCH_COMPLETED_AT_UTC = '2026-04-28T00:00:12.000Z';
const it = createPartitionedTestRegistrar(
    nodeIt,
    'GARDA_REVIEW_LAUNCH_INVOCATION_PART',
    3
);

function appendReviewerLaunchCompletedForTest(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    launchArtifactPath: string;
    providerInvocationId: string;
    delegationStartedAtUtc: string;
    launchCompletedAtUtc?: string;
}): void {
    const launchCompletedAtUtc = options.launchCompletedAtUtc || TEST_LAUNCH_COMPLETED_AT_UTC;
    const launchArtifact = JSON.parse(fs.readFileSync(options.launchArtifactPath, 'utf8')) as Record<string, unknown>;
    const reviewerLaunchAttemptId = String(
        launchArtifact.reviewer_launch_attempt_id || launchArtifact.reviewerLaunchAttemptId || ''
    ).trim();
    appendTaskEvent(
        getOrchestratorRoot(options.repoRoot),
        options.taskId,
        'REVIEWER_LAUNCH_COMPLETED',
        'INFO',
        'Reviewer launch completed by test controller fixture.',
        {
            task_id: options.taskId,
            review_type: options.reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: options.reviewerIdentity,
            reviewer_identity: options.reviewerIdentity,
            review_context_sha256: options.reviewContextSha256,
            routing_event_sha256: options.routingEventSha256,
            reviewer_launch_attempt_id: reviewerLaunchAttemptId,
            reviewer_launch_artifact_path: options.launchArtifactPath.replace(/\\/g, '/'),
            reviewer_launch_artifact_sha256: fileSha256ForTest(options.launchArtifactPath),
            provider_invocation_id: options.providerInvocationId,
            delegation_started_at_utc: options.delegationStartedAtUtc,
            launched_at_utc: options.delegationStartedAtUtc,
            launch_completed_at_utc: launchCompletedAtUtc
        }
    );
}

describe('cli/commands/gates review launch invocation', () => {
    it('record-review-invocation accepts completed launch metadata after current preparation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-invocation';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const reviewerHandoff = writeManualReviewerHandoffFixture(repoRoot, taskId, 'code');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_handoff: reviewerHandoff,
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const previousRoutingExitCode = process.exitCode;
        const previousRoutingCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousRoutingCwd);
            process.exitCode = previousRoutingExitCode;
        }
        let events = readTaskTimelineEvents(repoRoot, taskId);
        const invocationEventsBefore = events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length;
        const routingEvent = events.find((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED');
        const routingIntegrity = routingEvent?.integrity as Record<string, unknown> | undefined;
        assert.ok(routingIntegrity?.event_sha256);
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');
        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer',
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: 'agent:test-reviewer',
            launchArtifactPath,
            providerInvocationId: 'test-invocation-123',
            attestationSource: 'test_provider_controller'
        });
        const preparedLaunchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        const launchInputArtifact = reviewerLaunchInputArtifactForTest(launchArtifactPath, preparedLaunchArtifact);
        fs.writeFileSync(launchArtifactPath, JSON.stringify({
            ...preparedLaunchArtifact,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            attestation_source: 'test_provider_controller',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            launch_input_mode: 'launch_artifact_path',
            launch_input_artifact_path: launchInputArtifact.normalizedPath,
            launch_input_sha256: launchInputArtifact.sha256,
            launch_input_artifact_sha256: launchInputArtifact.sha256,
            prepared_reviewer_launch_artifact_sha256: launchInputArtifact.sha256,
            launch_input_copy_paste_reviewer_launch_prompt_sha256: preparedLaunchArtifact.copy_paste_reviewer_launch_prompt_sha256,
            delegation_started_at_utc: preparedLaunchArtifact.delegation_started_at_utc,
            launched_at_utc: preparedLaunchArtifact.delegation_started_at_utc,
            launch_completed_at_utc: TEST_LAUNCH_COMPLETED_AT_UTC,
            fork_context: false
        }, null, 2) + '\n', 'utf8');
        appendReviewerLaunchCompletedForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: 'agent:test-reviewer',
            reviewContextSha256: fileSha256ForTest(reviewContextPath),
            routingEventSha256: String(routingIntegrity.event_sha256),
            launchArtifactPath,
            providerInvocationId: 'test-invocation-123',
            delegationStartedAtUtc: String(preparedLaunchArtifact.delegation_started_at_utc)
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-invocation',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer',
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, invocationEventsBefore + 1);
        const invocationEvent = [...events].reverse().find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
        const invocationDetails = invocationEvent?.details as Record<string, unknown> | undefined;
        assert.equal(invocationDetails?.review_type, 'code');
        assert.equal(invocationDetails?.reviewer_session_id, 'agent:test-reviewer');
        assert.equal(invocationDetails?.execution_provider, 'Antigravity');
        assert.equal(invocationDetails?.execution_provider_source, 'provider_bridge');
        assert.equal(invocationDetails?.canonical_source_of_truth, 'Antigravity');
        assert.equal(invocationDetails?.reviewer_launch_tool, 'test-subagent-spawn');
        assert.equal(invocationDetails?.provider_invocation_id, 'test-invocation-123');
        assert.equal(invocationDetails?.reviewer_launch_attempt_id, preparedLaunchArtifact.reviewer_launch_attempt_id);
        assert.equal(invocationDetails?.launch_input_mode, 'launch_artifact_path');
        assert.equal(invocationDetails?.launch_input_sha256, launchInputArtifact.sha256);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects stale reviewer prompt artifacts after preparation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-stale-prompt-invocation';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath
        });
        completeReviewerLaunchArtifactForTest(fixture.launchArtifactPath);

        fs.writeFileSync(fixture.reviewerPromptPath, 'stale reviewer prompt payload before invocation\n', 'utf8');
        const invocation = await runCliWithCapturedOutput([
            'gate',
            'record-review-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(invocation.exitCode, 0);
        assert.ok(
            invocation.errors.some((line) => line.includes('record-review-invocation cannot continue because reviewer prompt artifact is stale')),
            invocation.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects completed launch artifacts that use launcher control metadata as launch input', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-958-invocation-control-input';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = fixture.launchArtifactPath;
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath
        });
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-control-input',
            attestationSource: 'test_provider_controller'
        });
        const preparedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        const reviewerInputSha256 = String(preparedArtifact.reviewer_launch_input_artifact_sha256);
        fs.writeFileSync(launchArtifactPath, JSON.stringify({
            ...preparedArtifact,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            attestation_source: 'test_provider_controller',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-control-input',
            launch_input_mode: 'launch_artifact_path',
            launch_input_artifact_path: launchArtifactPath.replace(/\\/g, '/'),
            launch_input_sha256: reviewerInputSha256,
            launch_input_artifact_sha256: reviewerInputSha256,
            prepared_reviewer_launch_artifact_sha256: reviewerInputSha256,
            launch_input_copy_paste_reviewer_launch_prompt_sha256: preparedArtifact.copy_paste_reviewer_launch_prompt_sha256,
            delegation_started_at_utc: preparedArtifact.delegation_started_at_utc,
            launched_at_utc: preparedArtifact.delegation_started_at_utc,
            launch_completed_at_utc: TEST_LAUNCH_COMPLETED_AT_UTC,
            fork_context: false
        }, null, 2) + '\n', 'utf8');
        appendReviewerLaunchCompletedForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextSha256: fixture.reviewContextSha256,
            routingEventSha256: fixture.routingEventSha256,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-control-input',
            delegationStartedAtUtc: String(preparedArtifact.delegation_started_at_utc)
        });

        const invocation = await runCliWithCapturedOutput([
            'gate',
            'record-review-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(invocation.exitCode, 0);
        assert.ok(
            invocation.errors.some((line) => line.includes('ReviewerLaunchArtifactPath control metadata is not valid reviewer launch input')),
            invocation.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects launched metadata without delegation-started evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-776-F6-invocation-no-delegation-start';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath
        });
        const preparedArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
        const launchInputArtifact = reviewerLaunchInputArtifactForTest(fixture.launchArtifactPath, preparedArtifact);
        fs.writeFileSync(fixture.launchArtifactPath, JSON.stringify({
            ...preparedArtifact,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            attestation_source: 'test_provider_controller',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-no-delegation-start',
            launch_input_mode: 'launch_artifact_path',
            launch_input_artifact_path: launchInputArtifact.normalizedPath,
            launch_input_sha256: launchInputArtifact.sha256,
            launch_input_artifact_sha256: launchInputArtifact.sha256,
            prepared_reviewer_launch_artifact_sha256: launchInputArtifact.sha256,
            launch_input_copy_paste_reviewer_launch_prompt_sha256: preparedArtifact.copy_paste_reviewer_launch_prompt_sha256,
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            fork_context: false
        }, null, 2) + '\n', 'utf8');

        const invocation = await runCliWithCapturedOutput([
            'gate',
            'record-review-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(invocation.exitCode, 0);
        assert.ok(
            invocation.errors.some((line) => line.includes('delegation_started_at_utc is required')),
            invocation.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects review contexts without tree_state binding after preparation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-invocation-no-tree-state';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath
        });
        completeReviewerLaunchArtifactForTest(fixture.launchArtifactPath);
        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as Record<string, unknown>;
        delete reviewContext.tree_state;
        delete reviewContext.schema_version;
        fs.writeFileSync(fixture.reviewContextPath, JSON.stringify(reviewContext, null, 2) + '\n', 'utf8');

        const invocation = await runCliWithCapturedOutput([
            'gate',
            'record-review-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(invocation.exitCode, 0);
        assert.ok(
            invocation.errors.some((line) => line.includes('record-review-invocation requires review context tree_state binding')),
            invocation.errors.join('\n')
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects prepared-only launch metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-prepared-not-attested';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-invocation',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('prepared reviewer launch metadata cannot satisfy REVIEWER_INVOCATION_ATTESTED')));
        assert.ok(capturedErrors.some((line) => line.includes('Completion hint:')));
        assert.ok(capturedErrors.some((line) => line.includes("evidence_type='delegated_reviewer_launch'")));
        assert.ok(capturedErrors.some((line) => line.includes('provider_invocation_id or controller_invocation_id=<actual delegated reviewer invocation id>')));
        assert.ok(capturedErrors.some((line) => line.includes('not non-forgeable proof')));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects hand-authored completed launch artifacts without prepared telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-launch-without-prepared-event';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');
        fs.mkdirSync(path.dirname(launchArtifactPath), { recursive: true });
        fs.writeFileSync(launchArtifactPath, JSON.stringify({
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: taskId,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: fixture.reviewerIdentity,
            review_context_sha256: fixture.reviewContextSha256,
            routing_event_sha256: fixture.routingEventSha256,
            attestation_source: 'test_provider_controller',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            fork_context: false
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-invocation',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('launch_binding_sha256 is required')));
        assert.ok(capturedErrors.some((line) => line.includes('prepared_launch_event_sha256 is required')));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation accepts completed launch artifacts that extend prepared metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-launch-from-prepared-metadata';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-123',
            attestationSource: 'test_provider_controller'
        });
        const preparedLaunchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        const launchInputArtifact = reviewerLaunchInputArtifactForTest(launchArtifactPath, preparedLaunchArtifact);
        fs.writeFileSync(launchArtifactPath, JSON.stringify({
            ...preparedLaunchArtifact,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            attestation_source: 'test_provider_controller',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            launch_input_mode: 'launch_artifact_path',
            launch_input_artifact_path: launchInputArtifact.normalizedPath,
            launch_input_sha256: launchInputArtifact.sha256,
            launch_input_artifact_sha256: launchInputArtifact.sha256,
            prepared_reviewer_launch_artifact_sha256: launchInputArtifact.sha256,
            launch_input_copy_paste_reviewer_launch_prompt_sha256: preparedLaunchArtifact.copy_paste_reviewer_launch_prompt_sha256,
            delegation_started_at_utc: preparedLaunchArtifact.delegation_started_at_utc,
            launched_at_utc: preparedLaunchArtifact.delegation_started_at_utc,
            launch_completed_at_utc: TEST_LAUNCH_COMPLETED_AT_UTC,
            fork_context: false
        }, null, 2) + '\n', 'utf8');
        appendReviewerLaunchCompletedForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewerIdentity: fixture.reviewerIdentity,
            reviewContextSha256: fixture.reviewContextSha256,
            routingEventSha256: fixture.routingEventSha256,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-123',
            delegationStartedAtUtc: String(preparedLaunchArtifact.delegation_started_at_utc)
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-invocation',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 1);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects completed launch evidence whose immutable input pin event is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-invocation-missing-input-pin';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath
        });
        completeReviewerLaunchArtifactForTest(fixture.launchArtifactPath);
        const timelinePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'task-events',
            `${taskId}.jsonl`
        );
        const retainedTimelineLines = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .filter((line) => (
                (JSON.parse(line) as Record<string, unknown>).event_type
                !== 'REVIEWER_LAUNCH_INPUT_PINNED'
            ));
        fs.writeFileSync(timelinePath, `${retainedTimelineLines.join('\n')}\n`, 'utf8');

        const invocation = await runCliWithCapturedOutput([
            'gate',
            'record-review-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(invocation.exitCode, 0);
        assert.ok(
            invocation.errors.join('\n').includes('must reference current REVIEWER_LAUNCH_INPUT_PINNED telemetry'),
            invocation.errors.join('\n') || invocation.logs.join('\n')
        );
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .some((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED'),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects completed launch artifacts without parent completion telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-794-invocation-no-launch-completed-event';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath
        });
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-123',
            attestationSource: 'test_provider_controller'
        });
        const preparedLaunchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        const launchInputArtifact = reviewerLaunchInputArtifactForTest(launchArtifactPath, preparedLaunchArtifact);
        fs.writeFileSync(launchArtifactPath, JSON.stringify({
            ...preparedLaunchArtifact,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            attestation_source: 'test_provider_controller',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            launch_input_mode: 'launch_artifact_path',
            launch_input_artifact_path: launchInputArtifact.normalizedPath,
            launch_input_sha256: launchInputArtifact.sha256,
            launch_input_artifact_sha256: launchInputArtifact.sha256,
            prepared_reviewer_launch_artifact_sha256: launchInputArtifact.sha256,
            launch_input_copy_paste_reviewer_launch_prompt_sha256: preparedLaunchArtifact.copy_paste_reviewer_launch_prompt_sha256,
            delegation_started_at_utc: preparedLaunchArtifact.delegation_started_at_utc,
            launched_at_utc: preparedLaunchArtifact.delegation_started_at_utc,
            launch_completed_at_utc: TEST_LAUNCH_COMPLETED_AT_UTC,
            fork_context: false
        }, null, 2) + '\n', 'utf8');

        const invocation = await runCliWithCapturedOutput([
            'gate',
            'record-review-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(invocation.exitCode, 0);
        assert.ok(
            invocation.errors.some((line) => line.includes('launch_completed_at_utc must reference current REVIEWER_LAUNCH_COMPLETED telemetry')),
            invocation.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects mixed-case forbidden source and malformed launch timestamp', async () => {
        const cases = [
            {
                taskId: 'T-257-launch-mixed-case-source',
                artifactUpdates: { attestation_source: 'Manual' },
                expectedError: 'attestation_source must be provider/controller-owned completed launch evidence'
            },
            {
                taskId: 'T-257-launch-invalid-timestamp',
                artifactUpdates: { launched_at_utc: 'not-a-date' },
                expectedError: 'launched_at_utc must be a valid UTC ISO-8601 timestamp'
            },
            {
                taskId: 'T-564-1-launch-invalid-prepared-timestamp',
                artifactUpdates: { launch_prepared_at_utc: 'not-a-date' },
                expectedError: 'launch_prepared_at_utc must be a valid UTC ISO-8601 timestamp'
            },
            {
                taskId: 'T-564-1-launch-invalid-completed-timestamp',
                artifactUpdates: { launch_completed_at_utc: 'not-a-date' },
                expectedError: 'launch_completed_at_utc must be a valid UTC ISO-8601 timestamp'
            }
        ];

        for (const testCase of cases) {
            const repoRoot = createTempRepo();
            try {
                const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId: testCase.taskId });
                const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', testCase.taskId, 'code', 'reviewer-launch.json');

                const previousPrepareExitCode = process.exitCode;
                const previousPrepareCwd = process.cwd();
                process.exitCode = 0;
                try {
                    process.chdir(repoRoot);
                    await runCliMainWithHandling([
                        'gate',
                        'prepare-reviewer-launch',
                        '--task-id', testCase.taskId,
                        '--review-type', 'code',
                        '--repo-root', repoRoot,
                        '--reviewer-execution-mode', 'delegated_subagent',
                        '--reviewer-identity', fixture.reviewerIdentity
                    ]);
                    assert.equal(process.exitCode ?? 0, 0);
                } finally {
                    process.chdir(previousPrepareCwd);
                    process.exitCode = previousPrepareExitCode;
                }

                const preparedLaunchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
                const launchInputArtifact = reviewerLaunchInputArtifactForTest(launchArtifactPath, preparedLaunchArtifact);
                fs.writeFileSync(launchArtifactPath, JSON.stringify({
                    ...preparedLaunchArtifact,
                    evidence_type: 'delegated_reviewer_launch',
                    attestation_state: 'launched',
                    attestation_source: 'test_provider_controller',
                    launch_tool: 'test-subagent-spawn',
                    provider_invocation_id: 'test-invocation-123',
                    launch_input_mode: 'launch_artifact_path',
                    launch_input_artifact_path: launchInputArtifact.normalizedPath,
                    launch_input_sha256: launchInputArtifact.sha256,
                    launch_input_artifact_sha256: launchInputArtifact.sha256,
                    prepared_reviewer_launch_artifact_sha256: launchInputArtifact.sha256,
                    launch_input_copy_paste_reviewer_launch_prompt_sha256: preparedLaunchArtifact.copy_paste_reviewer_launch_prompt_sha256,
                    launched_at_utc: '2026-04-28T00:00:00.000Z',
                    fork_context: false,
                    ...testCase.artifactUpdates
                }, null, 2) + '\n', 'utf8');

                const previousExitCode = process.exitCode;
                const previousCwd = process.cwd();
                const originalConsoleError = console.error;
                const capturedErrors: string[] = [];
                process.exitCode = 0;
                let observedExitCode = 0;
                console.error = (...args: unknown[]) => {
                    capturedErrors.push(args.map((value) => String(value)).join(' '));
                };
                try {
                    process.chdir(repoRoot);
                    await runCliMainWithHandling([
                        'gate',
                        'record-review-invocation',
                        '--task-id', testCase.taskId,
                        '--review-type', 'code',
                        '--repo-root', repoRoot,
                        '--reviewer-execution-mode', 'delegated_subagent',
                        '--reviewer-identity', fixture.reviewerIdentity,
                        '--reviewer-launch-artifact-path', launchArtifactPath
                    ]);
                    observedExitCode = process.exitCode ?? 0;
                } finally {
                    console.error = originalConsoleError;
                    process.chdir(previousCwd);
                    process.exitCode = previousExitCode;
                }

                assert.ok(observedExitCode !== 0, `Expected non-zero exit code for ${testCase.taskId}, got ${observedExitCode}`);
                assert.ok(capturedErrors.some((line) => line.includes(testCase.expectedError)), capturedErrors.join('\n'));
                const events = readTaskTimelineEvents(repoRoot, testCase.taskId);
                assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
    });

    it('record-review-invocation rejects completed-looking launch artifacts without provider invocation provenance', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-launch-missing-provider-proof';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');
        fs.mkdirSync(path.dirname(launchArtifactPath), { recursive: true });
        fs.writeFileSync(launchArtifactPath, JSON.stringify({
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: taskId,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: fixture.reviewerIdentity,
            review_context_sha256: fixture.reviewContextSha256,
            routing_event_sha256: fixture.routingEventSha256,
            attestation_source: 'provider_controller',
            launch_tool: 'test-subagent-spawn',
            fork_context: false
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-invocation',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('provider_invocation_id or controller_invocation_id is required')));
        assert.ok(capturedErrors.some((line) => line.includes('launched_at_utc is required')));
        assert.ok(capturedErrors.some((line) => line.includes('Completion hint:')));
        assert.ok(capturedErrors.some((line) => line.includes('fresh_context=true, isolated_context=true, or fork_context=false')));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects completed launch artifacts stripped of launch input fidelity fields', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-677-launch-input-stripped';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = fixture.launchArtifactPath;
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath
        });
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-677-stripped',
            attestationSource: 'codex_spawn_agent'
        });

        const complete = await runCliWithCapturedOutput([
            'gate',
            'complete-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            '--provider-invocation-id', 'test-invocation-677-stripped',
            '--attestation-source', 'codex_spawn_agent',
            ...launchArtifactInputArgsForTest(launchArtifactPath),
            '--fork-context', 'false'
        ], { cwd: repoRoot });
        assert.equal(complete.exitCode, 0, complete.errors.join('\n'));

        const strippedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        for (const key of [
            'copy_paste_reviewer_launch_prompt',
            'copy_paste_reviewer_launch_prompt_sha256',
            'launch_input_mode',
            'launch_input_sha256',
            'launch_input_artifact_path',
            'launch_input_artifact_sha256',
            'prepared_reviewer_launch_artifact_sha256',
            'launch_input_copy_paste_reviewer_launch_prompt_sha256'
        ]) {
            delete strippedArtifact[key];
        }
        fs.writeFileSync(launchArtifactPath, `${JSON.stringify(strippedArtifact, null, 2)}\n`, 'utf8');

        const invocation = await runCliWithCapturedOutput([
            'gate',
            'record-review-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(invocation.exitCode, 0);
        assert.ok(
            invocation.errors.some((line) => line.includes('copy_paste_reviewer_launch_prompt is required for launch input fidelity')),
            invocation.errors.join('\n')
        );
        assert.ok(invocation.errors.some((line) => line.includes('launch_input_mode is required')), invocation.errors.join('\n'));
        assert.ok(invocation.errors.some((line) => line.includes('launch_input_sha256 is required')), invocation.errors.join('\n'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
