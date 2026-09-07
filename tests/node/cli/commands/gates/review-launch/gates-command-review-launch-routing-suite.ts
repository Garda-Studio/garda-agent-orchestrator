import {
    appendTaskEvent,
    assert,
    createHash,
    completeReviewerLaunchArtifactForTest,
    createReviewerRoutingFixture,
    createTempRepo,
    describe,
    fs,
    getOrchestratorRoot,
    getReviewsRoot,
    it as nodeIt,
    launchArtifactInputArgsForTest,
    manualReviewContextBindingFixture,
    manualReviewContextTaskScopeFixture,
    os,
    path,
    prepareCurrentReviewPhase,
    prepareReviewerLaunchForTest,
    readTaskTimelineEvents,
    recordReviewerDelegationStartedForTest,
    recordReviewRoutingViaCli,
    reviewContextScopedDiffFixture,
    runCliMainWithHandling,
    runCliWithCapturedOutput,
    seedInitAnswers,
    seedRoutedReviewerLaunchFixture,
    seedTaskQueue,
    writeManualReviewerHandoffFixture,
    writePreflight
} from './gates-command-review-launch-fixtures';
import { createPartitionedTestRegistrar } from '../../gate-test-partition';

const it = createPartitionedTestRegistrar(
    nodeIt,
    'GARDA_REVIEW_LAUNCH_ROUTING_PART',
    3
);

function appendRestartBoundary(
    repoRoot: string,
    taskId: string,
    eventType: 'COHERENT_CYCLE_RESTARTED' | 'REVIEW_CYCLE_RESTARTED',
    options: {
        invalidatedReviewTypes?: string[];
        actor?: string;
        outcome?: string;
        status?: string;
        detailsEventType?: string;
        detailsTaskId?: string;
    } = {}
): void {
    appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        eventType,
        options.outcome || 'PASS',
        'Review cycle restarted by test fixture.',
        {
            task_id: options.detailsTaskId || taskId,
            event_type: options.detailsEventType || eventType,
            status: options.status || 'PASSED',
            invalidated_review_types: options.invalidatedReviewTypes || []
        },
        { actor: options.actor || 'orchestrator' }
    );
}

async function seedCompletedUnconsumedLaunch(repoRoot: string, taskId: string) {
    const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
    await prepareReviewerLaunchForTest({
        repoRoot,
        taskId,
        reviewerIdentity: fixture.reviewerIdentity,
        launchArtifactPath: fixture.launchArtifactPath
    });
    completeReviewerLaunchArtifactForTest(fixture.launchArtifactPath);
    return fixture;
}

async function seedResolvedCompletedUnconsumedLaunch(repoRoot: string, taskId: string) {
    const plannedReviewerIdentity = `agent:pending:${taskId}-code`;
    const resolvedReviewerIdentity = `agent:/root/${taskId.toLowerCase()}-code-review`;
    const providerInvocationId = `test-invocation-${taskId.toLowerCase()}`;
    const fixture = await seedRoutedReviewerLaunchFixture({
        repoRoot,
        taskId,
        reviewerIdentity: plannedReviewerIdentity
    });
    await prepareReviewerLaunchForTest({
        repoRoot,
        taskId,
        reviewerIdentity: plannedReviewerIdentity,
        launchArtifactPath: fixture.launchArtifactPath
    });
    await recordReviewerDelegationStartedForTest({
        repoRoot,
        taskId,
        reviewerIdentity: resolvedReviewerIdentity,
        launchArtifactPath: fixture.launchArtifactPath,
        providerInvocationId
    });
    const complete = await runCliWithCapturedOutput([
        'gate',
        'complete-reviewer-launch',
        '--task-id', taskId,
        '--review-type', 'code',
        '--repo-root', repoRoot,
        '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', resolvedReviewerIdentity,
        '--reviewer-launch-artifact-path', fixture.launchArtifactPath,
        '--provider-invocation-id', providerInvocationId,
        '--attestation-source', 'test_provider_controller',
        ...launchArtifactInputArgsForTest(fixture.launchArtifactPath),
        '--fork-context', 'false'
    ], { cwd: repoRoot });
    assert.equal(complete.exitCode, 0, complete.errors.join('\n'));
    return fixture;
}

describe('cli/commands/gates review launch routing', () => {
    it('record-review-routing rejects required canonical contexts without current preflight binding', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-missing-binding';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.notEqual(observedExitCode, 0);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects schema-less review contexts without tree_state binding', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-schema-less-tree-state-bypass';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const preflightSha256 = createHash('sha256').update(fs.readFileSync(preflightPath)).digest('hex');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            task_id: taskId,
            review_type: 'code',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: preflightSha256,
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const reviewerIdentity = 'agent:test-schema-less-tree-state-reviewer';
        const routing = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ], { cwd: repoRoot });

        assert.notEqual(routing.exitCode, 0);
        assert.ok(
            routing.errors.some((line) => line.includes('record-review-routing requires review context tree_state binding')),
            routing.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing keeps canonical routing when aggregate telemetry index fails', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-routing-aggregate-warning';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_handoff: writeManualReviewerHandoffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        fs.rmSync(aggregatePath, { force: true });
        fs.mkdirSync(aggregatePath, { recursive: true });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:test-reviewer');
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);
        assert.equal(fs.statSync(path.join(taskEventsRoot, 'all-tasks.jsonl')).isDirectory(), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rolls back review-context routing metadata when delegated telemetry cannot be recorded', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-routing-lock';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        fs.mkdirSync(taskEventsRoot, { recursive: true });
        const lockPath = path.join(taskEventsRoot, `.${taskId}.lock`);
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(taskEventsRoot, `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects same-agent fallback when direct Codex runtime remains delegation-required', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-routing-policy-tamper';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'tampered review-context policy'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        assert.equal(reviewContext.reviewer_routing.fallback_reason, null);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects delegated_subagent with a self-scoped reviewer identity', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-routing-self-identity';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', `self:${taskId}`
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects late routing after the review gate already passed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-late-routing';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Required reviews gate passed.', {});

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects late reroute after the same review type has recorded a result', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z-late-reroute';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_handoff: writeManualReviewerHandoffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let rerouteExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:first-code-reviewer'
            });
            const launchArtifactPath = path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                'reviews',
                taskId,
                'code',
                'reviewer-launch.json'
            );
            await prepareReviewerLaunchForTest({
                repoRoot,
                taskId,
                reviewerIdentity: 'agent:first-code-reviewer',
                launchArtifactPath
            });
            await recordReviewerDelegationStartedForTest({
                repoRoot,
                taskId,
                reviewerIdentity: 'agent:first-code-reviewer',
                launchArtifactPath,
                providerInvocationId: 'test-late-reroute-reviewer'
            });
            const completed = await runCliWithCapturedOutput([
                'gate',
                'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:first-code-reviewer',
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-late-reroute-reviewer',
                '--attestation-source', 'test_provider_controller',
                ...launchArtifactInputArgsForTest(launchArtifactPath),
                '--fork-context', 'false',
                '--record-invocation'
            ], { cwd: repoRoot });
            assert.equal(completed.exitCode, 0, completed.errors.join('\n'));
            fs.writeFileSync(artifactPath, [
                '# Code Review T-904z-late-reroute',
                '## Summary',
                'Verified delegated reviewer routing with concrete implementation detail and realistic wording.',
                '## Findings by Severity',
                'none',
                '## Residual Risks',
                'none',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:first-code-reviewer'
            ]);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:late-code-reviewer'
            ]);
            rerouteExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(rerouteExitCode !== 0, `Expected non-zero exit code, got ${rerouteExitCode}`);
        assert.ok(
            capturedErrors.some((line) => line.includes("Review routing for 'code' is locked")),
            capturedErrors.join('\n')
        );
        assert.ok(capturedErrors.some((line) => line.includes('restart-review-cycle')));
        assert.ok(capturedErrors.some((line) => line.includes('does not require a full task reset')));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:first-code-reviewer');
        const routingEvents = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED');
        assert.equal(routingEvents.length, 1);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing cannot supersede an immutable delegation-started attempt', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-22-routing-inflight';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath
        });
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath,
            providerInvocationId: 'test-invocation-routing-inflight'
        });
        const contextTextBefore = fs.readFileSync(fixture.reviewContextPath, 'utf8');
        const routedEventCountBefore = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length;

        const reroute = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', 'agent:unrelated-reviewer'
        ], { cwd: repoRoot });

        assert.notEqual(reroute.exitCode, 0);
        assert.ok(
            reroute.errors.some((line) => line.includes('immutable reviewer launch attempt is already delegation_started')),
            reroute.errors.join('\n')
        );
        assert.equal(fs.readFileSync(fixture.reviewContextPath, 'utf8'), contextTextBefore);
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length,
            routedEventCountBefore
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    for (const controlArtifactState of ['missing', 'malformed'] as const) {
        it(`record-review-routing fails closed when current prepared telemetry has a ${controlArtifactState} control artifact`, async () => {
            const repoRoot = createTempRepo();
            const taskId = `T-979-routing-${controlArtifactState}-prepared-control`;
            const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
            await prepareReviewerLaunchForTest({
                repoRoot,
                taskId,
                reviewerIdentity: fixture.reviewerIdentity,
                launchArtifactPath: fixture.launchArtifactPath
            });
            if (controlArtifactState === 'missing') {
                fs.rmSync(fixture.launchArtifactPath, { force: true });
            } else {
                fs.writeFileSync(fixture.launchArtifactPath, '{ malformed\n', 'utf8');
            }
            const routingEventCountBefore = readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length;

            const reroute = await runCliWithCapturedOutput([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:replacement-code-reviewer'
            ], { cwd: repoRoot });

            assert.notEqual(reroute.exitCode, 0);
            assert.ok(
                reroute.errors.join('\n').includes(`control artifact is ${controlArtifactState}`),
                reroute.errors.join('\n') || reroute.logs.join('\n')
            );
            assert.equal(
                readTaskTimelineEvents(repoRoot, taskId)
                    .filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length,
                routingEventCountBefore
            );

            fs.rmSync(repoRoot, { recursive: true, force: true });
        });
    }

    for (const resultState of ['consumed', 'unconsumed', 'wrong-reviewer', 'corrupt-integrity', 'wrong-actor', 'wrong-latest-actor']) {
        it(`reroutes a cleaned completed control file only when ${resultState} result evidence permits it`, async () => {
            const repoRoot = createTempRepo();
            const taskId = `T-cleaned-launch-${resultState}`;
            const fixture = await seedResolvedCompletedUnconsumedLaunch(repoRoot, taskId);
            const previousArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8'));
            if (resultState !== 'unconsumed') {
                appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_RECORDED', 'PASS', 'Consume completed review.', {
                    task_id: taskId,
                    review_type: 'code',
                    reviewer_identity: resultState === 'wrong-reviewer' ? 'agent:other-reviewer' : previousArtifact.reviewer_identity,
                    review_context_sha256: previousArtifact.review_context_sha256
                }, { actor: resultState === 'wrong-actor' ? 'reviewer' : 'orchestrator' });
            }
            if (resultState === 'wrong-latest-actor') {
                const completed = readTaskTimelineEvents(repoRoot, taskId).find((event) => event.event_type === 'REVIEWER_LAUNCH_COMPLETED');
                appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_LAUNCH_COMPLETED', 'PASS', 'Duplicate completion under wrong actor.',
                    completed?.details || {}, { actor: 'reviewer' });
            }
            appendRestartBoundary(repoRoot, taskId, 'REVIEW_CYCLE_RESTARTED', { invalidatedReviewTypes: ['code'] });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Rebuild code context after restart.', {
                task_id: taskId, review_type: 'code'
            }, { actor: 'orchestrator' });
            const cleanup = await runCliWithCapturedOutput([
                'gate', 'log-task-event', '--task-id', taskId, '--event-type', 'TASK_BLOCKED',
                '--outcome', 'BLOCKED', '--message', 'Pause before recovery.', '--actor', 'orchestrator', '--repo-root', repoRoot
            ], { cwd: repoRoot });
            assert.equal(cleanup.exitCode, 0, cleanup.errors.join('\n'));
            assert.equal(fs.existsSync(fixture.launchArtifactPath), false);
            if (resultState === 'corrupt-integrity') {
                const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
                const timeline = fs.readFileSync(timelinePath, 'utf8');
                fs.writeFileSync(timelinePath, timeline.replace('Consume completed review.', 'Tampered completed review.'));
            }
            const reviewerIdentity = 'agent:replacement-after-cleanup';
            const reroute = await runCliWithCapturedOutput([
                'gate', 'record-review-routing', '--task-id', taskId, '--review-type', 'code',
                '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent', '--reviewer-identity', reviewerIdentity
            ], { cwd: repoRoot });
            if (resultState === 'consumed') {
                assert.equal(reroute.exitCode, 0, reroute.errors.join('\n'));
                await prepareReviewerLaunchForTest({ repoRoot, taskId, reviewerIdentity, launchArtifactPath: fixture.launchArtifactPath });
                const replacement = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8'));
                assert.notEqual(replacement.reviewer_launch_attempt_id, previousArtifact.reviewer_launch_attempt_id);
            } else {
                assert.notEqual(reroute.exitCode, 0);
                assert.match(reroute.errors.join('\n'), /control artifact is missing/);
            }
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });
    }

    it('record-review-routing and prepare-reviewer-launch replace a launched attempt invalidated by an authenticated review restart', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-57-invalidated';
        const fixture = await seedResolvedCompletedUnconsumedLaunch(repoRoot, taskId);
        const previousArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
        appendRestartBoundary(repoRoot, taskId, 'REVIEW_CYCLE_RESTARTED', {
            invalidatedReviewTypes: ['code']
        });

        const reviewerIdentity = 'agent:replacement-code-reviewer';
        const reroute = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ], { cwd: repoRoot });
        assert.equal(reroute.exitCode, 0, reroute.errors.join('\n'));

        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });
        assert.equal(prepare.exitCode, 0, prepare.errors.join('\n'));

        const currentArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.notEqual(
            currentArtifact.reviewer_launch_attempt_id,
            previousArtifact.reviewer_launch_attempt_id
        );
        const supersededArtifact = currentArtifact.superseded_launch_artifact as Record<string, unknown> | null;
        assert.ok(supersededArtifact?.snapshot_path);
        assert.ok(fs.existsSync(String(supersededArtifact?.snapshot_path)));
        assert.deepEqual(
            JSON.parse(fs.readFileSync(String(supersededArtifact?.snapshot_path), 'utf8')),
            previousArtifact
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    for (const launchState of ['prepared', 'delegation_started'] as const) {
        it(`record-review-routing and prepare-reviewer-launch replace a ${launchState} attempt invalidated by an authenticated review restart`, async () => {
            const repoRoot = createTempRepo();
            const taskId = `T-979-57-invalidated-${launchState.replace('_', '-')}`;
            const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
            await prepareReviewerLaunchForTest({
                repoRoot,
                taskId,
                reviewerIdentity: fixture.reviewerIdentity,
                launchArtifactPath: fixture.launchArtifactPath
            });
            if (launchState === 'delegation_started') {
                await recordReviewerDelegationStartedForTest({
                    repoRoot,
                    taskId,
                    reviewerIdentity: fixture.reviewerIdentity,
                    launchArtifactPath: fixture.launchArtifactPath,
                    providerInvocationId: 'test-invocation-invalidated-inflight'
                });
            }
            const previousArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
            appendRestartBoundary(repoRoot, taskId, 'REVIEW_CYCLE_RESTARTED', {
                invalidatedReviewTypes: ['code']
            });

            const reviewerIdentity = `agent:replacement-${launchState}-reviewer`;
            const reroute = await runCliWithCapturedOutput([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', reviewerIdentity
            ], { cwd: repoRoot });
            assert.equal(reroute.exitCode, 0, reroute.errors.join('\n'));

            const prepare = await runCliWithCapturedOutput([
                'gate',
                'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', reviewerIdentity,
                '--reviewer-launch-artifact-path', fixture.launchArtifactPath
            ], { cwd: repoRoot });
            assert.equal(prepare.exitCode, 0, prepare.errors.join('\n'));

            const currentArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
            assert.notEqual(currentArtifact.reviewer_launch_attempt_id, previousArtifact.reviewer_launch_attempt_id);
            const supersededArtifact = currentArtifact.superseded_launch_artifact as Record<string, unknown> | null;
            assert.ok(supersededArtifact?.snapshot_path);
            assert.deepEqual(
                JSON.parse(fs.readFileSync(String(supersededArtifact.snapshot_path), 'utf8')),
                previousArtifact
            );

            fs.rmSync(repoRoot, { recursive: true, force: true });
        });
    }

    it('record-review-routing replaces a launched attempt after an authenticated coherent restart', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-57-coherent';
        const fixture = await seedCompletedUnconsumedLaunch(repoRoot, taskId);
        const previousArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
        appendRestartBoundary(repoRoot, taskId, 'COHERENT_CYCLE_RESTARTED');

        const reviewerIdentity = 'agent:replacement-code-reviewer';
        const reroute = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ], { cwd: repoRoot });
        assert.equal(reroute.exitCode, 0, reroute.errors.join('\n'));

        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });
        assert.equal(prepare.exitCode, 0, prepare.errors.join('\n'));

        const currentArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.notEqual(currentArtifact.reviewer_launch_attempt_id, previousArtifact.reviewer_launch_attempt_id);
        const supersededArtifact = currentArtifact.superseded_launch_artifact as Record<string, unknown> | null;
        assert.ok(supersededArtifact?.snapshot_path);
        assert.ok(fs.existsSync(String(supersededArtifact.snapshot_path)));
        assert.deepEqual(
            JSON.parse(fs.readFileSync(String(supersededArtifact.snapshot_path), 'utf8')),
            previousArtifact
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing does not supersede a current attempt whose artifact was rewritten with pre-restart provenance', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-57-rewritten-provenance';
        const fixture = await seedCompletedUnconsumedLaunch(repoRoot, taskId);
        const staleArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
        appendRestartBoundary(repoRoot, taskId, 'REVIEW_CYCLE_RESTARTED', {
            invalidatedReviewTypes: ['code']
        });

        const reviewerIdentity = 'agent:current-code-reviewer';
        const reroute = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ], { cwd: repoRoot });
        assert.equal(reroute.exitCode, 0, reroute.errors.join('\n'));
        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });
        assert.equal(prepare.exitCode, 0, prepare.errors.join('\n'));

        const currentArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
        for (const field of [
            'reviewer_launch_attempt_id',
            'prepared_launch_event_sha256',
            'prepared_launch_event_task_sequence',
            'reviewer_execution_mode',
            'reviewer_identity',
            'review_context_sha256',
            'routing_event_sha256',
            'reviewer_prompt_sha256',
            'launch_binding_sha256'
        ]) {
            currentArtifact[field] = staleArtifact[field];
        }
        fs.writeFileSync(fixture.launchArtifactPath, JSON.stringify(currentArtifact, null, 2) + '\n', 'utf8');

        const blockedReroute = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', 'agent:unexpected-third-reviewer'
        ], { cwd: repoRoot });
        assert.notEqual(blockedReroute.exitCode, 0);
        assert.ok(
            blockedReroute.errors.some((line) => line.includes('immutable reviewer launch attempt is already prepared')),
            blockedReroute.errors.join('\n')
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    for (const scenario of [
        { name: 'no restart boundary', appendBoundary: false },
        { name: 'a preserved review lane', appendBoundary: true, invalidatedReviewTypes: ['test'] },
        { name: 'an untrusted restart actor', appendBoundary: true, invalidatedReviewTypes: ['code'], actor: 'gate' },
        { name: 'a failed restart outcome', appendBoundary: true, invalidatedReviewTypes: ['code'], outcome: 'FAIL' },
        { name: 'a failed restart status', appendBoundary: true, invalidatedReviewTypes: ['code'], status: 'FAILED' },
        { name: 'a foreign restart details task id', appendBoundary: true, invalidatedReviewTypes: ['code'], detailsTaskId: 'T-foreign' },
        {
            name: 'a mismatched restart details event type',
            appendBoundary: true,
            invalidatedReviewTypes: ['code'],
            detailsEventType: 'COHERENT_CYCLE_RESTARTED'
        }
    ]) {
        it(`record-review-routing preserves an immutable launched attempt with ${scenario.name}`, async () => {
            const repoRoot = createTempRepo();
            const taskId = `T-979-57-blocked-${scenario.name.replace(/[^a-z]+/g, '-').replace(/-$/g, '')}`;
            const fixture = await seedCompletedUnconsumedLaunch(repoRoot, taskId);
            if (scenario.appendBoundary) {
                appendRestartBoundary(repoRoot, taskId, 'REVIEW_CYCLE_RESTARTED', {
                    invalidatedReviewTypes: scenario.invalidatedReviewTypes,
                    actor: scenario.actor,
                    outcome: scenario.outcome,
                    status: scenario.status,
                    detailsEventType: scenario.detailsEventType,
                    detailsTaskId: scenario.detailsTaskId
                });
            }

            const reroute = await runCliWithCapturedOutput([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:replacement-code-reviewer'
            ], { cwd: repoRoot });
            assert.notEqual(reroute.exitCode, 0);
            assert.ok(
                reroute.errors.some((line) => line.includes('immutable reviewer launch attempt is already launched')),
                reroute.errors.join('\n')
            );

            const prepare = await runCliWithCapturedOutput([
                'gate',
                'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', fixture.launchArtifactPath
            ], { cwd: repoRoot });
            assert.notEqual(prepare.exitCode, 0);
            assert.ok(
                prepare.errors.some((line) => line.includes('immutable reviewer launch attempt is already launched')),
                prepare.errors.join('\n')
            );

            fs.rmSync(repoRoot, { recursive: true, force: true });
        });
    }

    it('record-review-routing allows rerouting before a review result is recorded', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z-pre-result-reroute';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        await recordReviewRoutingViaCli({
            taskId,
            reviewType: 'code',
            repoRoot,
            reviewerExecutionMode: 'delegated_subagent',
            reviewerIdentity: 'agent:first-code-reviewer'
        });
        const routing = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', 'agent:replacement-code-reviewer'
        ], { cwd: repoRoot });

        assert.equal(routing.exitCode, 0, routing.errors.join('\n'));
        const routingOutput = routing.logs.join('\n');
        assert.ok(routing.logs[0]?.startsWith('Next action:\n'));
        assert.ok(routingOutput.includes('  Gate: record-review-routing'));
        assert.ok(routingOutput.includes(`  Command: node garda-agent-orchestrator/bin/garda.js next-step "${taskId}" --repo-root "."`));
        assert.equal(routing.logs.some((line) => line.startsWith('NextAction:')), false);
        assert.ok(routing.logs.some((line) => line.includes('REVIEW_ROUTING_RECORDED: code')));
        const routedReviewContextSha256 = createHash('sha256').update(fs.readFileSync(reviewContextPath)).digest('hex');
        assert.ok(routingOutput.includes(`RoutedReviewContextSha256: ${routedReviewContextSha256}`));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:replacement-code-reviewer');
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 2);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing ignores review-output correction launch artifacts from prior attempts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z-correction-launch';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');
        const correctionLaunchArtifactPath = path.join(
            reviewsRoot,
            `${taskId}-code-output-correction-launch.json`
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEWER_DELEGATION_STARTED',
            'INFO',
            'Review-output correction delegation started by test fixture.',
            {
                task_id: taskId,
                review_type: 'code',
                invocation_role: 'review_output_correction',
                reviewer_launch_attempt_id: 'agent:code-correction-reviewer',
                reviewer_launch_artifact_path: correctionLaunchArtifactPath.replace(/\\/g, '/')
            },
            { actor: 'orchestrator' }
        );

        const routing = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', 'agent:fresh-code-reviewer'
        ], { cwd: repoRoot });

        assert.equal(routing.exitCode, 0, routing.errors.join('\n'));
        assert.ok(routing.logs.some((line) => line.includes('REVIEW_ROUTING_RECORDED: code')));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:fresh-code-reviewer');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing keeps different review types independent after a review result is recorded', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z-cross-type-reroute';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const codeArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const securityReviewContextPath = path.join(reviewsRoot, `${taskId}-security-review-context.json`);
        fs.writeFileSync(codeArtifactPath, [
            '# Code Review T-904z-cross-type-reroute',
            '## Summary',
            'Verified delegated reviewer routing with concrete implementation detail and realistic wording.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(codeReviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(securityReviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'security'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'security'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let securityRoutingExitCode = 0;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer',
                reviewContextPath: codeReviewContextPath
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'security',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:security-reviewer'
            ]);
            securityRoutingExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(securityRoutingExitCode, 0);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.ok(events.some((event) => (
            event.event_type === 'REVIEWER_DELEGATION_ROUTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '') === 'code'
        )));
        assert.ok(events.some((event) => (
            event.event_type === 'REVIEWER_DELEGATION_ROUTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '') === 'security'
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing accepts delegated_subagent for Qwen after fallback removal', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904za';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Qwen')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:test-reviewer');
        assert.equal(reviewContext.reviewer_routing.expected_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.fallback_allowed, false);
        assert.equal(reviewContext.reviewer_routing.fallback_reason_required, false);
        assert.equal(reviewContext.reviewer_routing.fallback_reason, null);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const routingEvents = fs.existsSync(timelinePath)
            ? readTaskTimelineEvents(repoRoot, taskId).filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED')
            : [];
        assert.equal(routingEvents.length, 1);
        assert.equal((routingEvents[0]?.details as Record<string, unknown> | undefined)?.reviewer_fallback_reason ?? null, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
