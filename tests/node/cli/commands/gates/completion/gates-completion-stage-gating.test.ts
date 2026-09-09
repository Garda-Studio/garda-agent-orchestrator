import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeBudgetOutputFilters } from '../../gate-test-helpers';

import {
    runCompileGateCommand,
    runDocImpactGateCommand
} from '../../../../../../src/cli/commands/gates';
import { runCompletionGate } from '../../../../../../src/gates/completion';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';

import {
    createTempRepo,
    escapeRegExp,
    getOrchestratorRoot,
    getReviewsRoot,
    initializeGitRepo,
    loadTaskEntryRulePack,
    loadPostPreflightRulePack,
    runRequiredReviewsCheckCommand,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue,
    writeCleanReviewArtifact,
    writeCompilePassEvidence,
    writePreflight
} from './gates-completion-fixtures';

describe('cli/commands/gates', () => {
    test('passes completion gate only after task mode entry, review gate, and doc impact gate', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Internal cleanup only, no public behavior change.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'PASS');
        assert.equal(completionResult.status, 'PASSED');
        assert.match(String(completionResult.task_mode_path || ''), /T-903a-task-mode\.json$/);
        // Verify stage_sequence_evidence is present.
        assert.ok(completionResult.stage_sequence_evidence);
        assert.equal(completionResult.stage_sequence_evidence.code_changed, true);
        assert.ok(completionResult.stage_sequence_evidence.observed_order.includes('PREFLIGHT_CLASSIFIED'));
        assert.ok(completionResult.stage_sequence_evidence.observed_order.includes('IMPLEMENTATION_STARTED'));
        assert.ok(completionResult.stage_sequence_evidence.observed_order.includes('REVIEW_PHASE_STARTED'));
        assert.ok(completionResult.stage_sequence_evidence.observed_order.includes('REVIEW_RECORDED'));
        assert.deepEqual(completionResult.stage_sequence_evidence.review_skill_ids, ['code-review']);
        assert.equal(completionResult.stage_sequence_evidence.review_skill_reference_paths.length, 1);
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('passes completion gate when a later coherent cycle exists despite stale early task-entry ordering noise', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-recovery';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-completion-recovery.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Record stale early startup ordering noise'
        });
        runHandshakeForTask(repoRoot, taskId);
        loadTaskEntryRulePack(repoRoot, taskId);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Recover a later coherent completion cycle'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
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
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Internal lifecycle recovery only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'PASS');
        assert.equal(completionResult.status, 'PASSED');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('fails completion gate when the latest cycle is misordered and would need compile backfill from an older cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-recovery-negative';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
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
        const commandsPath = path.join(repoRoot, 'commands-completion-recovery-negative.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject cross-cycle compile backfill in completion gate'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Initial review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const firstReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(firstReviewResult.exitCode, 0);

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'New preflight started for a later cycle.',
            { mode: 'FULL_PATH', changed_files_count: 1, changed_lines_total: 3, required_reviews: { code: true } }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for later cycle.',
            {}
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started too early for later cycle.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'COMPILE_GATE_PASSED',
            'PASS',
            'Compile gate passed too late in later cycle.',
            {}
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_GATE_PASSED',
            'PASS',
            'Later review gate appeared to pass.',
            {}
        );

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.stage_sequence_evidence.violations.some((item) => item.includes("Do not backfill 'COMPILE_GATE_PASSED' from an older execution cycle.")));
        const restartCommand = String((completionResult as Record<string, unknown>).coherent_cycle_restart_command || '');
        assert.match(restartCommand, /restart-coherent-cycle/);
        assert.match(restartCommand, new RegExp(escapeRegExp(taskId)));
        assert.match(restartCommand, new RegExp(escapeRegExp(outputFiltersPath.replace(/\\/g, '/'))));
        assert.ok(restartCommand.includes("--task-intent 'Update app flow'"), restartCommand);
        assert.ok(!restartCommand.includes("--task-intent 'Recover a later coherent completion cycle'"), restartCommand);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('protected completion coherent-cycle recovery command includes operator placeholders', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-protected-recovery-command';
        fs.writeFileSync(
            path.join(repoRoot, 'package.json'),
            JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2),
            'utf8'
        );
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'src', 'gates', 'completion'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'gates', 'completion', 'completion.ts'),
            'export const protectedCompletionFixture = true;\n',
            'utf8'
        );
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/gates/completion/completion.ts'],
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
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Protected recovery command needs operator placeholders',
            plannedChangedFiles: ['src/gates/completion/completion.ts'],
            orchestratorWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'New preflight started for a later protected cycle.',
            { mode: 'FULL_PATH', changed_files_count: 1, changed_lines_total: 3, required_reviews: { code: true } }
        );

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        const command = String((completionResult as Record<string, unknown>).coherent_cycle_restart_command || '');

        assert.equal(completionResult.outcome, 'FAIL');
        assert.match(command, /restart-coherent-cycle/);
        assert.match(command, /--operator-confirmed yes/);
        assert.match(command, /--operator-confirmed-at-utc '<ISO-8601 timestamp>'/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('fails completion gate when the latest cycle has review evidence but no same-cycle implementation or compile', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-recovery-missing-prereq';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
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
        const commandsPath = path.join(repoRoot, 'commands-completion-recovery-missing-prereq.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject missing same-cycle compile backfill in completion gate'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Initial review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const firstReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(firstReviewResult.exitCode, 0);

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'New preflight started for a later cycle.',
            { mode: 'FULL_PATH', changed_files_count: 1, changed_lines_total: 3, required_reviews: { code: true } }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Later review phase started without same-cycle implementation or compile.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_RECORDED',
            'PASS',
            'Later review recorded.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_GATE_PASSED',
            'PASS',
            'Later review gate appeared to pass.',
            {}
        );

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.stage_sequence_evidence.violations.some((item) => item.includes("Do not backfill 'IMPLEMENTATION_STARTED' from an older execution cycle.")));
        assert.ok(completionResult.stage_sequence_evidence.violations.some((item) => item.includes("Do not backfill 'COMPILE_GATE_PASSED' from an older execution cycle.")));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate rejects stale task-mode artifacts after review pass when runtime identity metadata is removed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-task-mode-identity-missing-at-completion';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject completion when pinned task-mode identity metadata is removed after review pass',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Runtime identity regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const tamperedTaskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        delete tamperedTaskMode.canonical_source_of_truth;
        delete tamperedTaskMode.execution_provider_source;
        delete tamperedTaskMode.runtime_identity_status;
        fs.writeFileSync(taskModePath, JSON.stringify(tamperedTaskMode, null, 2) + '\n', 'utf8');

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'FAILED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.violations.some((entry) => entry.includes('missing canonical_source_of_truth')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate fails when workspace canonical ownership drifts after task-mode identity was pinned', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-completion-runtime-identity-drift';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fail completion when workspace canonical SourceOfTruth drifts after task-mode entry',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Runtime identity drift regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        seedInitAnswers(repoRoot, 'Qwen');

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'FAILED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.violations.some((entry) => entry.includes('contradicts task-mode canonical_source_of_truth')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
