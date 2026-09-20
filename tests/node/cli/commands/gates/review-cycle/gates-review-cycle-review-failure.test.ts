import {
    EXIT_GATE_FAILURE,
    appendTaskEvent,
    assert,
    createTempRepo,
    describe,
    fileSha256,
    fs,
    getOrchestratorRoot,
    getReviewsRoot,
    getTaskModeEvidence,
    initializeGitRepo,
    it,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    normalizePath,
    path,
    readTaskTimelineEvents,
    readTimelineEventsSummary,
    resolveRuntimeReviewerIdentity,
    runBuildReviewContextCommand,
    runCompileGateCommand,
    runEnterTaskMode,
    runExplicitPreflight,
    runHandshakeForTask,
    runRequiredReviewsCheckCommand,
    runShellSmokeForTask,
    seedInitAnswers,
    seedNodeBackendOptionalSkillFixture,
    seedRemediationRepoBase,
    seedReusableReviewEvidence,
    seedTaskQueue,
    withFilesystemLockAsync,
    writeCompilePassEvidence,
    writeOptionalSkillSelectionArtifact,
    writePreflight,
    writeReviewCapabilitiesConfig,
    writeSimpleCompileCommandsFile
} from './gates-review-cycle-fixtures';
import { assertRequiredUpstreamReviewDependencies } from '../../../../../../src/gates/review/review-dependencies';
import { readDependencyTimelineEvents } from '../../../../../../src/cli/commands/gate-review-handlers/result/review-dependency-timeline';
import { readReviewDependencyTimelineEvents } from '../../../../../../src/gates/required-reviews/required-reviews-check-dependencies';

describe('cli/commands/gates – review-cycle review failure suite', () => {
    it('runBuildReviewContextCommand reuses supplied task-mode evidence and runtime identity without rereading the artifact', { concurrency: false }, async (t) => {
        const repoRoot = createTempRepo(t);
        const taskId = 'T-903b-restart-review-cycle-task-mode-cache';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-task-mode-cache');
        const taskModeArtifactPath = path.join(
            getOrchestratorRoot(repoRoot),
            'runtime',
            'reviews',
            `${taskId}-task-mode.json`
        );

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse supplied task-mode evidence during build-review-context command execution'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reuse supplied task-mode evidence during build-review-context command execution',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId, '');
        const runtimeReviewerIdentity = resolveRuntimeReviewerIdentity({
            repoRoot,
            taskId,
            taskModePath: String(taskModeEvidence.evidence_path || ''),
            taskModeEvidence,
            allowLegacyFallback: true
        });
        fs.rmSync(taskModeArtifactPath, { force: true });

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath,
            taskModePath: String(taskModeEvidence.evidence_path || ''),
            taskModeEvidence,
            runtimeReviewerIdentity
        });

        assert.equal(fs.existsSync(taskModeArtifactPath), false);
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));
        assert.equal(buildResult.reusedReviewEvidence, false);
    });

    it('runBuildReviewContextCommand preserves the public key-value output contract', { concurrency: false }, async (t) => {
        const repoRoot = createTempRepo(t);
        const taskId = 'T-903b-build-review-context-output-contract';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'build-review-context-output-contract');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Preserve build-review-context output formatting contract'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Preserve build-review-context output formatting contract',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const expectedReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        fs.mkdirSync(path.dirname(expectedReviewContextPath), { recursive: true });
        fs.writeFileSync(expectedReviewContextPath, '{"stale":true}\n', 'utf8');

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        const expectedReviewContextSha256 = fileSha256(expectedReviewContextPath);
        const expectedReviewContextDisplayPath = normalizePath(expectedReviewContextPath);
        assert.equal(fs.existsSync(expectedReviewContextPath), true);
        assert.equal(buildResult.outputLines.includes(`ReviewContextPath: ${expectedReviewContextDisplayPath}`), true);
        assert.equal(buildResult.outputLines.includes(`ReviewContextSha256: ${expectedReviewContextSha256}`), true);
        assert.equal(buildResult.outputLines.includes('ReviewContextSha256Stage: generated_pre_routing'), true);
        assert.equal(buildResult.outputLines.includes(`OutputPath: ${expectedReviewContextDisplayPath}`), true);
        assert.ok(buildResult.outputLines.some((line) => line.startsWith(
            'CurrentPassReviewEvidenceReason: Prior review-context reuse candidate rejected before the ReviewContextSha256 shown above was generated:'
        )));
        assert.ok(buildResult.outputLines.some((line) => /^TokenEconomyActive: (True|False)$/.test(line)));
        const reviewContext = JSON.parse(fs.readFileSync(expectedReviewContextPath, 'utf8')) as Record<string, unknown>;
        assert.equal(reviewContext.stale, undefined);
        assert.equal(reviewContext.task_id, taskId);
        assert.equal(reviewContext.review_type, 'code');

    });

    it('runBuildReviewContextCommand fails closed when required review telemetry cannot be appended', { concurrency: false }, async (t) => {
        const repoRoot = createTempRepo(t);
        const taskId = 'T-903b-build-review-context-telemetry-lock';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'build-review-context-telemetry-lock');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fail closed when review-context telemetry cannot be appended'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Fail closed when review-context telemetry cannot be appended',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const taskEventLockPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `.${taskId}.lock`);
        fs.mkdirSync(path.dirname(taskEventLockPath), { recursive: true });
        await withFilesystemLockAsync(taskEventLockPath, { timeoutMs: 30000, retryMs: 1 }, async () => {
            await assert.rejects(
                () => runBuildReviewContextCommand({
                    repoRoot,
                    reviewType: 'code',
                    depth: '2',
                    preflightPath,
                    telemetryLockTimeoutMs: 20,
                    telemetryLockRetryMs: 1
                }),
                /Mandatory lifecycle event 'REVIEW_PHASE_STARTED' append failed/
            );
        });

        const timelineEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            timelineEvents.some((event) => event.event_type === 'REVIEW_PHASE_STARTED'),
            false
        );

    });

    it('runBuildReviewContextCommand reuses the supplied timeline summary for code-review reuse', { concurrency: false }, async (t) => {
        const repoRoot = createTempRepo(t);
        const taskId = 'T-903b-build-review-context-reuse-timeline-cache';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'build-review-context-reuse-timeline-cache');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse supplied timeline summary when recycling current-cycle code review evidence'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reuse supplied timeline summary when recycling current-cycle code review evidence',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            reviewContextPath
        );
        const refreshedCompileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(refreshedCompileResult.exitCode, 0);
        const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId, '');
        const runtimeReviewerIdentity = resolveRuntimeReviewerIdentity({
            repoRoot,
            taskId,
            taskModePath: String(taskModeEvidence.evidence_path || ''),
            taskModeEvidence,
            allowLegacyFallback: true
        });
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const timelineSummary = readTimelineEventsSummary(timelinePath);

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath,
            timelineEventsSummary: timelineSummary,
            taskModePath: String(taskModeEvidence.evidence_path || ''),
            taskModeEvidence,
            runtimeReviewerIdentity
        });

        assert.equal(buildResult.reusedReviewEvidence, true);
        assert.ok(buildResult.reusedReceiptPath);

        const refreshedTimelineSummary = readTimelineEventsSummary(timelinePath);
        const latestCodeReview = [...refreshedTimelineSummary.events].reverse().find(
            (event) => event.event_type === 'REVIEW_RECORDED'
                && event.details?.review_type === 'code'
        );
        assert.equal(latestCodeReview?.outcome, 'PASS');
        assert.doesNotThrow(() => assertRequiredUpstreamReviewDependencies({
            taskId,
            preflightPath,
            preflightPayload: JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
            reviewType: 'test',
            timelineEvents: refreshedTimelineSummary.events,
            taskModePath: String(taskModeEvidence.evidence_path || ''),
            runtimeReviewerIdentity
        }));
        const routingTimelineEvents = readDependencyTimelineEvents(timelinePath);
        const routingCodeReview = [...routingTimelineEvents].reverse().find(
            (event) => event.event_type === 'REVIEW_RECORDED'
                && event.details?.review_type === 'code'
        );
        assert.equal(routingCodeReview?.outcome, 'PASS');
        assert.doesNotThrow(() => assertRequiredUpstreamReviewDependencies({
            taskId,
            preflightPath,
            preflightPayload: JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
            reviewType: 'test',
            timelineEvents: routingTimelineEvents,
            taskModePath: String(taskModeEvidence.evidence_path || ''),
            runtimeReviewerIdentity
        }));
        const reviewGateTimelineEvents = readReviewDependencyTimelineEvents(timelinePath);
        const reviewGateCodeReview = [...reviewGateTimelineEvents].reverse().find(
            (event) => event.event_type === 'REVIEW_RECORDED'
                && event.details?.review_type === 'code'
        );
        assert.equal(reviewGateCodeReview?.outcome, 'PASS');
        assert.doesNotThrow(() => assertRequiredUpstreamReviewDependencies({
            taskId,
            preflightPath,
            preflightPayload: JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
            reviewType: 'test',
            timelineEvents: reviewGateTimelineEvents,
            taskModePath: String(taskModeEvidence.evidence_path || ''),
            runtimeReviewerIdentity
        }));

    });

    it('required-reviews-check rejects optional skill loads when policy mode is off', (t) => {
        const repoRoot = createTempRepo(t);
        const taskId = 'T-149-review-off-mode';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const order = 1;\n', 'utf8');
        const optionalSkillPath = seedNodeBackendOptionalSkillFixture(repoRoot, 'off');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject optional skill loads at review gate when policy mode is off'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3 },
            changed_files: ['src/api/orders.ts'],
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const crypto = require('node:crypto');
        const preflightSha256 = crypto.createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
        writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts'],
            preflightPath,
            preflightSha256
        });
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            reviewContextPath,
            'agent:code-reviewer'
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Optional skill loaded after an off-mode selection.',
            {
                skill_id: 'node-backend',
                reference_path: optionalSkillPath,
                trigger_reason: 'manual'
            }
        );

        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });

        assert.equal(reviewGateResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewGateResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewGateResult.outputLines.some((line) => line.includes("policy mode is 'off'")));

    });

    it('required-reviews-check rejects stale strict optional-skill artifacts when the current TASK.md title changes', (t) => {
        const repoRoot = createTempRepo(t);
        const taskId = 'T-149-review-stale-task-text';
        seedTaskQueue(repoRoot, taskId);
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'landing.md'), 'hello\n', 'utf8');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'strict');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement request validation for a Node.js API endpoint'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3 },
            changed_files: ['docs/landing.md'],
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const crypto = require('node:crypto');
        const preflightSha256 = crypto.createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
        writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: 'Implement request validation for a Node.js API endpoint',
            changedPaths: ['docs/landing.md'],
            preflightPath,
            preflightSha256
        });
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Implement request validation for a Node.js API endpoint',
                'Refresh landing-page copy for the marketing site'
            ),
            'utf8'
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            reviewContextPath,
            'agent:code-reviewer'
        );

        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });

        assert.equal(reviewGateResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewGateResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewGateResult.outputLines.some((line) => line.includes('current task summary hash')));

    });

    it('required-reviews-check rejects strict optional-skill artifacts when the task row disappears from TASK.md', (t) => {
        const repoRoot = createTempRepo(t);
        const taskId = 'T-149-review-missing-task-row';
        seedTaskQueue(repoRoot, taskId);
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'landing.md'), 'hello\n', 'utf8');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'strict');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement request validation for a Node.js API endpoint'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3 },
            changed_files: ['docs/landing.md'],
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const crypto = require('node:crypto');
        const preflightSha256 = crypto.createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
        writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: 'Implement request validation for a Node.js API endpoint',
            changedPaths: ['docs/landing.md'],
            preflightPath,
            preflightSha256
        });
        fs.writeFileSync(
            taskPath,
            [
                '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-999 | TODO | P2 | docs | Placeholder task | unassigned | 2026-03-28 | default | fixture |'
            ].join('\n'),
            'utf8'
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            reviewContextPath,
            'agent:code-reviewer'
        );

        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });

        assert.equal(reviewGateResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewGateResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewGateResult.outputLines.some((line) => line.includes('current task summary hash')));

    });
});
