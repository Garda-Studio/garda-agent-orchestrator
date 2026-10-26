import {
    EXIT_GATE_FAILURE,
    assert,
    createTempRepo,
    describe,
    formatCompletionGateResult,
    fs,
    initializeGitRepo,
    it,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    markAsSourceCheckout,
    path,
    readTaskTimelineEvents,
    runBuildReviewContextCommand,
    prepareCurrentReviewCycleValidation,
    runCompileGateCommand,
    runCompletionGate,
    runEnterTaskMode,
    runExplicitPreflight,
    runHandshakeForTask,
    runRestartReviewCycleCommand,
    runShellSmokeForTask,
    seedInitAnswers,
    seedRemediationRepoBase,
    seedTaskQueue,
    writePreflight,
    writeReviewCapabilitiesConfig,
    writeSimpleCompileCommandsFile
} from './gates-review-cycle-fixtures';
import { resolveNextStep } from '../../../../../../src/gates/next-step/next-step';

describe('cli/commands/gates – review-cycle recovery suite', () => {
    it('restart-review-cycle refuses to rebuild from a fresh task-mode cycle that never restored TASK_ENTRY rule-pack evidence', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        markAsSourceCheckout(repoRoot);
        const taskId = 'T-903b-restart-review-cycle-missing-task-entry';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 5;\nconsole.log(a + b);\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-missing-task-entry');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject review-cycle restart when the latest task-mode cycle never restored task-entry rule-pack evidence',
            plannedChangedFiles: [
                'commands-restart-review-cycle-missing-task-entry.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts'
            ]
        });

        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts'],
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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, restartResult.outputLines.join('\n'));
        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTART_FAILED/);
        assert.match(output, /TASK_MODE_ENTERED without matching RULE_PACK_LOADED for TASK_ENTRY/);
        assert.match(output, /restart-coherent-cycle/);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const handshakeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const shellSmokeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        assert.equal(handshakeIndexes.length, 0);
        assert.equal(shellSmokeIndexes.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion diagnostics surface restart-review-cycle when review evidence is incomplete without a stage-sequence failure', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-recovery-command';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'review-recovery-command');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Surface a narrow review-cycle recovery command from completion diagnostics'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Surface a narrow review-cycle recovery command from completion diagnostics',
            ['src/app.ts']
        );
        await prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
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

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);
        assert.match(
            String((completionResult as Record<string, unknown>).review_cycle_restart_command || ''),
            /restart-review-cycle/
        );
        assert.match(
            formatCompletionGateResult(completionResult as Record<string, unknown>),
            /RecoveryCommand: .*restart-review-cycle/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle remains usable after COMPLETION_GATE_FAILED when completion diagnostics advertise that narrow recovery path', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-recovery-command-after-completion-fail';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it(\"works\", () => {});\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'review-recovery-command-after-completion-fail');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep restart-review-cycle usable after completion diagnostics surface it as the recovery command'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Keep restart-review-cycle usable after completion diagnostics surface it as the recovery command',
            ['src/app.ts', 'tests/app.test.ts']
        );
        await prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
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

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);
        assert.match(
            String((completionResult as Record<string, unknown>).review_cycle_restart_command || ''),
            /restart-review-cycle/
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_CYCLE_RESTARTED/);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const eventSequence = (event: Record<string, unknown>): number => {
            const integrity = event.integrity && typeof event.integrity === 'object'
                ? event.integrity as Record<string, unknown>
                : {};
            return Number(event.sequence ?? integrity.task_sequence ?? 0);
        };
        const latestRefreshedPreflight = [...events].reverse().find(
            (event) => event.event_type === 'PREFLIGHT_CLASSIFIED'
        );
        assert.ok(latestRefreshedPreflight);
        const latestRefreshedPreflightSequence = eventSequence(latestRefreshedPreflight);
        const latestRecoveryBoundary = [...events].reverse().find(
            (event) => (
                [
                    'REVIEW_PHASE_STARTED',
                    'COMPLETION_GATE_FAILED'
                ].includes(String(event.event_type || ''))
                && eventSequence(event) < latestRefreshedPreflightSequence
            )
        );
        assert.ok(latestRecoveryBoundary, 'test fixture must contain a review-cycle recovery boundary before refreshed preflight');
        const latestRecoveryBoundarySequence = eventSequence(latestRecoveryBoundary);
        const freshHandshake = events.find(
            (event) => (
                event.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED'
                && eventSequence(event) > latestRecoveryBoundarySequence
                && eventSequence(event) < latestRefreshedPreflightSequence
            )
        );
        const freshShellSmoke = events.find(
            (event) => (
                event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
                && eventSequence(event) > latestRecoveryBoundarySequence
                && eventSequence(event) < latestRefreshedPreflightSequence
            )
        );
        assert.ok(freshHandshake, 'restart-review-cycle must refresh handshake diagnostics after recovery boundary and before refreshed preflight');
        assert.ok(freshShellSmoke, 'restart-review-cycle must refresh shell smoke after recovery boundary and before refreshed preflight');
        assert.ok(eventSequence(freshHandshake) < eventSequence(freshShellSmoke));
        assert.ok(eventSequence(freshShellSmoke) < latestRefreshedPreflightSequence);
        const nextStep = resolveNextStep({ taskId, repoRoot });
        assert.notEqual(nextStep.next_gate, 'restart-coherent-cycle', nextStep.reason);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle fails after a fresh TASK_MODE_ENTERED when TASK_ENTRY was not restored for that new cycle', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-recovery-missing-task-entry';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'review-recovery-missing-task-entry');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject restart-review-cycle when a fresh task-mode cycle did not reload task-entry rules'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject restart-review-cycle when a fresh task-mode cycle did not reload task-entry rules',
            ['src/app.ts', 'tests/app.test.ts']
        );
        await prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
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

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fresh task-mode cycle without task-entry reload must not use restart-review-cycle'
        });

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, restartResult.outputLines.join('\n'));
        assert.match(
            restartResult.outputLines.join('\n'),
            /TASK_MODE_ENTERED without matching RULE_PACK_LOADED for TASK_ENTRY/
        );
        assert.match(restartResult.outputLines.join('\n'), /Run restart-coherent-cycle/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle remains usable after a fresh TASK_MODE_ENTERED when TASK_ENTRY is restored for that new cycle', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-recovery-restored-task-entry';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'review-recovery-restored-task-entry');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep restart-review-cycle usable when a fresh task-mode cycle reloads task-entry rules'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Keep restart-review-cycle usable when a fresh task-mode cycle reloads task-entry rules',
            ['src/app.ts', 'tests/app.test.ts']
        );
        await prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
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

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fresh task-mode cycle with task-entry reload should keep restart-review-cycle available'
        });
        loadTaskEntryRulePack(repoRoot, taskId);

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_CYCLE_RESTARTED/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
