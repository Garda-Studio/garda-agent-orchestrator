import {
    describe,
    it,
    assert,
    fs,
    os,
    path,
    gateReviewHandlers,
    runCliMainWithHandling,
    appendTaskEvent,
    createTempRepo,
    seedTaskQueue,
    seedInitAnswers,
    getReviewsRoot,
    getOrchestratorRoot,
    createReviewerRoutingFixture,
    writePreflight,
    prepareCurrentReviewPhase,
    readTaskTimelineEvents,
    runCliWithCapturedOutput,
    TEST_REVIEW_LAUNCH_PREPARED_AT_UTC,
    TEST_REVIEW_LAUNCHED_AT_UTC,
    TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC,
    TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC,
    manualReviewContextTaskScopeFixture,
    manualReviewContextBindingFixture,
    reviewContextScopedDiffFixture,
    recordReviewRoutingViaCli,
    attestReviewerInvocationForTest,
    seedPromptBoundReviewFixture
} from './gates-command-review-result-fixtures';
import { createHash } from 'node:crypto';

describe('gates command review result - review output', () => {

    function removeInvocationDelegationTimestamps(repoRoot: string, taskId: string): void {
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const lines = fs.readFileSync(timelinePath, 'utf8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
                const event = JSON.parse(line) as Record<string, unknown>;
                if (event.event_type === 'REVIEWER_INVOCATION_ATTESTED') {
                    const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                        ? event.details as Record<string, unknown>
                        : {};
                    delete details.delegation_started_at_utc;
                    delete details.launched_at_utc;
                    event.details = details;
                }
                return JSON.stringify(event);
            });
        fs.writeFileSync(timelinePath, `${lines.join('\n')}\n`, 'utf8');
    }

    it('record-review-result rejects review output paths that escape through symlinked directories', async (t) => {
        const repoRoot = createTempRepo();
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-output-outside-'));
        const taskId = 'T-265-review-output-link';
        try {
            const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath: fixture.reviewContextPath,
                reviewerIdentity: fixture.reviewerIdentity
            });
            const linkedDirPath = path.join(repoRoot, 'linked-review-output');
            try {
                fs.symlinkSync(outsideRoot, linkedDirPath, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error) {
                t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
            fs.writeFileSync(path.join(outsideRoot, 'review-output.md'), [
                '# Review',
                '',
                'External reviewer output must not be materialized through a repo-looking symlink path.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');

            const result = await runCliWithCapturedOutput([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', fixture.preflightPath,
                '--review-output-path', path.join(linkedDirPath, 'review-output.md'),
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ], { cwd: repoRoot });

            assert.notEqual(result.exitCode, 0);
            assert.ok(
                result.errors.some((line) => line.includes('ReviewOutputPath must resolve inside repo root without symlink or junction escape')),
                result.errors.join('\n')
            );
            assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code.md`)), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    it('record-review-result rejects repo-local aliases into another task review-temp output', async (t) => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-review-output-alias';
        try {
            const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath: fixture.reviewContextPath,
                reviewerIdentity: fixture.reviewerIdentity
            });
            const foreignOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', 'T-265-foreign-output', 'code');
            fs.mkdirSync(foreignOutputDir, { recursive: true });
            fs.writeFileSync(path.join(foreignOutputDir, 'review-output.md'), [
                '# Review',
                '',
                'Foreign task reviewer output must not be materialized through a repo-local alias.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');
            const aliasDirPath = path.join(repoRoot, 'review-output-alias');
            try {
                fs.symlinkSync(foreignOutputDir, aliasDirPath, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error) {
                t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const result = await runCliWithCapturedOutput([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', fixture.preflightPath,
                '--review-output-path', path.join(aliasDirPath, 'review-output.md'),
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ], { cwd: repoRoot });

            assert.notEqual(result.exitCode, 0);
            assert.ok(
                result.errors.some((line) => line.includes('ReviewOutputPath must not traverse symlinks or junctions')),
                result.errors.join('\n')
            );
            assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code.md`)), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('record-review-result preserves --review-output-path compatibility while materializing canonical raw artifacts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated `src/app.ts` and the delegated review ingestion path with concrete routing, receipt, and artifact persistence details so this reviewer output is realistic and non-trivial.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        const expectedReviewOutputSourceMtimeUtc = fs.statSync(reviewOutputPath).mtime.toISOString();
        const expectedRawOutput = fs.readFileSync(reviewOutputPath, 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Delegated review routed by controller.', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:code-reviewer',
            delegation_used: true
        });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath,
            reviewerIdentity: 'agent:code-reviewer'
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.equal(fs.existsSync(reviewOutputPath), false);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.equal(rawReviewContent, expectedRawOutput);
        assert.ok(artifactContent.includes('## Verdict\nREVIEW PASSED'));
        assert.ok(rawReviewContent.includes('## Verdict\nREVIEW PASSED'));
        assert.equal(artifactContent.trimEnd(), rawReviewContent.trimEnd());

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');

        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, 'agent:code-reviewer');
        assert.equal(receipt.trust_level, 'INDEPENDENT_AUDITED');
        assert.equal(receipt.reviewer_provenance?.attestation_type, 'reviewer_invocation_attestation');
        assert.equal(receipt.reviewer_provenance?.controller_event_type, 'REVIEWER_INVOCATION_ATTESTED');
        assert.equal(receipt.reviewer_provenance?.launch_prepared_at_utc, TEST_REVIEW_LAUNCH_PREPARED_AT_UTC);
        assert.equal(receipt.reviewer_provenance?.delegation_started_at_utc, TEST_REVIEW_LAUNCHED_AT_UTC);
        assert.equal(receipt.reviewer_provenance?.launched_at_utc, TEST_REVIEW_LAUNCHED_AT_UTC);
        assert.equal(receipt.reviewer_provenance?.launch_completed_at_utc, TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC);
        assert.equal(receipt.reviewer_provenance?.invocation_attested_at_utc, TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC);
        assert.equal(typeof receipt.review_result_recorded_at_utc, 'string');
        assert.equal(Number.isNaN(Date.parse(receipt.review_result_recorded_at_utc)), false);
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.equal(receipt.review_materialization_fidelity, 'exact');
        assert.equal(receipt.review_output_sha256, createHash('sha256').update(expectedRawOutput).digest('hex'));
        assert.equal(receipt.review_artifact_sha256, createHash('sha256').update(artifactContent).digest('hex'));
        assert.equal(typeof receipt.review_output_sha256, 'string');
        assert.ok(receipt.review_output_sha256.length > 0);
        assert.equal(typeof receipt.review_output_source_mtime_utc, 'string');
        assert.equal(Number.isNaN(Date.parse(receipt.review_output_source_mtime_utc)), false);
        assert.equal(receipt.review_output_source_mtime_utc, expectedReviewOutputSourceMtimeUtc);
        assert.equal(typeof receipt.review_artifact_sha256, 'string');
        assert.ok(receipt.review_artifact_sha256.length > 0);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEW_RECORDED').length, 1);
        const invocationEvent = events.find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED') as Record<string, unknown> | undefined;
        const invocationIntegrity = invocationEvent?.integrity as Record<string, unknown> | undefined;
        assert.equal(receipt.reviewer_provenance?.task_sequence, invocationIntegrity?.task_sequence);
        assert.equal(receipt.reviewer_provenance?.event_sha256, invocationIntegrity?.event_sha256);
        assert.equal(receipt.reviewer_provenance?.prev_event_sha256 ?? null, invocationIntegrity?.prev_event_sha256 ?? null);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewOutputMode: path')));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewOutputPath: ${rawReviewOutputPath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes('VerdictToken: REVIEW PASSED')));
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: exact')));
        assert.ok(capturedLogs.some((line) => line.includes('ReviewerCleanup: After the review receipt is persisted')));
        assert.ok(capturedLogs.some((line) => line.includes('close or release the reviewer sub-agent session')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects path-mode output written before delegation-start evidence with stdin recovery', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-742-early-output';
        try {
            const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath: fixture.reviewContextPath,
                reviewerIdentity: fixture.reviewerIdentity
            });
            const reviewOutputDir = path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                'reviews',
                taskId,
                'code'
            );
            const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
            fs.mkdirSync(reviewOutputDir, { recursive: true });
            fs.writeFileSync(reviewOutputPath, [
                '# Review',
                '',
                '## Validation Notes',
                'Validated `src/cli/commands/gate-review-handlers/result/review-result-handlers.ts` and the delegated reviewer ordering recovery path with concrete receipt timing, provenance, path-mode mtime, and stdin-rematerialization checks so this fixture is substantive.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Deferred Findings',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');
            const beforeDelegationStarted = new Date(Date.parse(TEST_REVIEW_LAUNCHED_AT_UTC) - 1000);
            fs.utimesSync(reviewOutputPath, beforeDelegationStarted, beforeDelegationStarted);

            const result = await runCliWithCapturedOutput([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', fixture.preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ], { cwd: repoRoot });

            assert.notEqual(result.exitCode, 0);
            const errors = result.errors.join('\n');
            assert.match(errors, /Review output path-mode timing is impossible/);
            assert.match(errors, /review_output_source_mtime_utc .* is earlier than delegation_started_at_utc/);
            assert.match(errors, /Safe recovery: rerun record-review-result by piping the same delegated reviewer output through stdin/);
            assert.match(errors, /PowerShell-safe command:/);
            assert.match(errors, /Get-Content -Raw -LiteralPath/);
            assert.match(errors, /review-output\.md' \| node/);
            assert.match(errors, /node (?:bin\/garda\.js|garda-agent-orchestrator\/bin\/garda\.js) gate record-review-result/);
            assert.match(errors, /--review-output-stdin/);
            assert.match(errors, /--reviewer-identity 'agent:T-742-early-output-reviewer'/);
            assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code.md`)), false);
            assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
            assert.equal(fs.existsSync(reviewOutputPath), true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('record-review-result rejects path-mode output when delegation-start timing is ambiguous', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-742-ambiguous-output';
        try {
            const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath: fixture.reviewContextPath,
                reviewerIdentity: fixture.reviewerIdentity
            });
            removeInvocationDelegationTimestamps(repoRoot, taskId);
            const reviewOutputDir = path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                'reviews',
                taskId,
                'code'
            );
            const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
            fs.mkdirSync(reviewOutputDir, { recursive: true });
            fs.writeFileSync(reviewOutputPath, [
                '# Review',
                '',
                '## Validation Notes',
                'Validated `src/cli/commands/gate-review-handlers/result/review-result-handlers.ts` for ambiguous delegated timing rejection, receipt rollback, and stdin recovery guidance.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Deferred Findings',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');

            const result = await runCliWithCapturedOutput([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', fixture.preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ], { cwd: repoRoot });

            assert.notEqual(result.exitCode, 0);
            const errors = result.errors.join('\n');
            assert.match(errors, /Review output path-mode timing is ambiguous/);
            assert.match(errors, /delegation_started_at_utc is missing or invalid/);
            assert.match(errors, /Get-Content -Raw -LiteralPath/);
            assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code.md`)), false);
            assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('record-review-result prints stdin pipe recovery for canonical raw output paths too', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-742-canonical-early-output';
        try {
            const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath: fixture.reviewContextPath,
                reviewerIdentity: fixture.reviewerIdentity
            });
            const reviewOutputPath = path.join(fixture.reviewsRoot, `${taskId}-code-review-output.md`);
            fs.writeFileSync(reviewOutputPath, [
                '# Review',
                '',
                '## Validation Notes',
                'Validated `src/cli/commands/gate-review-handlers/result/review-result-handlers.ts` and canonical raw review output path recovery for delegated review timing, stdin rematerialization, and receipt rollback behavior with concrete path-mode mtime evidence.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Deferred Findings',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');
            const beforeDelegationStarted = new Date(Date.parse(TEST_REVIEW_LAUNCHED_AT_UTC) - 1000);
            fs.utimesSync(reviewOutputPath, beforeDelegationStarted, beforeDelegationStarted);

            const result = await runCliWithCapturedOutput([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', fixture.preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ], { cwd: repoRoot });

            assert.notEqual(result.exitCode, 0);
            const errors = result.errors.join('\n');
            assert.match(errors, /Review output path-mode timing is impossible/);
            assert.match(errors, /Get-Content -Raw -LiteralPath/);
            assert.match(errors, new RegExp(`${taskId}-code-review-output\\.md' \\| node`));
            assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code.md`)), false);
            assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('record-review-result accepts stdin reviewer output only through the same audited raw-artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-stdin';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const stdinReviewOutput = [
            '# Review',
            '',
            'Validated direct stdin ingestion while keeping `src/cli/commands/gate-review-handlers.ts` and `garda-agent-orchestrator/runtime/reviews/*-review-output.md` on the same audited raw-artifact path, with concrete receipt and routing persistence details. Reviewed the raw artifact rewrite, verdict extraction, context binding, and receipt emission flow so this fixture remains realistic and non-trivial.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');

        const mutableGateReviewHandlers = gateReviewHandlers as typeof gateReviewHandlers & {
            readReviewOutputFromStdin: typeof gateReviewHandlers.readReviewOutputFromStdin;
        };
        const originalReadReviewOutputFromStdin = mutableGateReviewHandlers.readReviewOutputFromStdin;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        mutableGateReviewHandlers.readReviewOutputFromStdin = async () => stdinReviewOutput;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-stdin',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            mutableGateReviewHandlers.readReviewOutputFromStdin = originalReadReviewOutputFromStdin;
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.equal(fs.readFileSync(rawReviewOutputPath, 'utf8'), stdinReviewOutput);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewOutputMode: stdin')));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewOutputPath: ${rawReviewOutputPath.replace(/\\/g, '/')}`)));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result keeps existing raw output when stdin is empty', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-empty-stdin-preserves-raw';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const existingRawOutput = [
            '# Previous Review Output',
            '',
            'This existing reviewer output must not be destroyed by a later empty stdin attempt.',
            '',
            '## Verdict',
            'REVIEW PASSED',
            ''
        ].join('\n');
        fs.writeFileSync(rawReviewOutputPath, existingRawOutput, 'utf8');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const mutableGateReviewHandlers = gateReviewHandlers as typeof gateReviewHandlers & {
            readReviewOutputFromStdin: typeof gateReviewHandlers.readReviewOutputFromStdin;
        };
        const originalReadReviewOutputFromStdin = mutableGateReviewHandlers.readReviewOutputFromStdin;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        mutableGateReviewHandlers.readReviewOutputFromStdin = async () => '   \n';
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-stdin',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            mutableGateReviewHandlers.readReviewOutputFromStdin = originalReadReviewOutputFromStdin;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.readFileSync(rawReviewOutputPath, 'utf8'), existingRawOutput);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-code.md`)), false);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`)), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects dual review-output sources to avoid a weaker ingestion path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-dual-input';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, '# Review\n\n## Verdict\nREVIEW PASSED\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--review-output-stdin',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects reviewer scratch sources that do not encode the current task id', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-review-temp-orphan';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', 'session-42');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated reviewer materialization input ownership enforcement and confirmed that a reviewer scratch source path without the current task identifier is rejected before canonical artifact persistence or receipt materialization can occur.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), false);
        assert.equal(fs.existsSync(reviewOutputPath), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects non-canonical preflight paths before materialization', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-preflight';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId);
        const customPreflightPath = path.join(repoRoot, 'custom-preflight.json');
        fs.writeFileSync(customPreflightPath, JSON.stringify({
            task_id: taskId,
            required_reviews: { code: true }
        }, null, 2) + '\n', 'utf8');

        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, '# Review\n\n## Verdict\nREVIEW PASSED\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', customPreflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects pass review through stdin when required lifecycle sections are missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-199-stdin-normalization';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const existingRawOutput = '# Previous Review Output\n\n## Verdict\nREVIEW PASSED\n';
        fs.writeFileSync(rawReviewOutputPath, existingRawOutput, 'utf8');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        // Review content missing ## Findings by Severity and ## Residual Risks, but has PASS verdict.
        // Needs at least 100 characters and enough words/references to pass the triviality check.
        const stdinReviewOutput = [
            '# Review',
            '',
            'Focused regression for T-199. This review is missing required lifecycle sections but carries a PASS verdict.',
            'It contains enough implementation details and qualitative analysis to pass the triviality filter used by the materialization gate.',
            'The changes in `src/cli/commands/gate-review-handlers/index.ts` properly handle the transition from raw input to normalized artifact.',
            'By including backticks and more than sixty words of descriptive text, this artifact should be considered meaningful by the `isTrivialReview` validator.',
            'This ensures that the lossless normalization path is properly exercised for stdin-based review ingestion as well.',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const originalReadReviewOutputFromStdin = gateReviewHandlers.readReviewOutputFromStdin;
        const mutableGateReviewHandlers = gateReviewHandlers as { readReviewOutputFromStdin: () => Promise<string> };
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        mutableGateReviewHandlers.readReviewOutputFromStdin = async () => stdinReviewOutput;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-stdin',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            mutableGateReviewHandlers.readReviewOutputFromStdin = originalReadReviewOutputFromStdin;
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');

        assert.equal(rawReviewContent, existingRawOutput);
        assert.ok(capturedErrors.some((line) => line.includes("missing required section '## Findings by Severity'")));
        assert.ok(capturedErrors.some((line) => line.includes("missing required section '## Residual Risks'")));
        assert.ok(capturedErrors.some((line) => line.includes('Safe recovery:')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
