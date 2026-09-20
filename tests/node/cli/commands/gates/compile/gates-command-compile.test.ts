import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    EXIT_GATE_FAILURE
} from '../../../../../../src/cli/exit-codes';
import {
    runBindRulePackToPreflightCommand,
    runCompileGateCommand as runCompileGateCommandSource,
    runDocImpactGateCommand,
    runRequiredReviewsCheckCommand
} from '../../../../../../src/cli/commands/gates';
import { runCompletionGate } from '../../../../../../src/gates/completion';
import { writeProtectedControlPlaneManifest } from '../../../../../../src/gates/shared/helpers';
import { writeOptionalSkillSelectionArtifact } from '../../../../../../src/runtime/optional-skill-selection';
import { buildDefaultWorkflowConfig } from '../../../../../../src/core/workflow-config';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../../../../src/core/constants';
import {
    getCompileGateEvidence,
    testCompileScopeDrift
} from '../../../../../../src/cli/commands/gate-flows/review/review-flow-support';

import {
    createTempRepo,
    writeBudgetOutputFilters,
    writeBalancedProfilesConfig,
    seedTaskQueue,
    seedInitAnswers as seedBaseInitAnswers,
    getReviewsRoot,
    getOrchestratorRoot,
    runEnterTaskMode,
    writePreflight,
    writeCleanReviewArtifact,
    loadTaskEntryRulePack,
    loadPostPreflightRulePack,
    runHandshakeForTask,
    runShellSmokeForTask,
    runExplicitPreflight,
    initializeGitRepo,
    readTaskTimelineEvents,
    readTaskQueueStatusFromTaskFile,
    assertGateChainDecision
} from '../../gate-test-helpers';

function runCompileGateCommand(
    options: Parameters<typeof runCompileGateCommandSource>[0]
): ReturnType<typeof runCompileGateCommandSource> {
    const legacyOutputFiltersPath = path.resolve('live/config/output-filters.json');
    return runCompileGateCommandSource({
        ...options,
        outputFiltersPath: options.outputFiltersPath
            && path.resolve(options.outputFiltersPath) === legacyOutputFiltersPath
            ? writeBudgetOutputFilters(path.resolve(options.repoRoot || '.'))
            : options.outputFiltersPath
    });
}

function assertCompileFailureIncludesNextStepHint(outputLines: string[]): void {
    assert.ok(outputLines.some((line) => line.includes('NextStep: run') && line.includes('next-step')));
}

function writeWorkflowConfig(repoRoot: string, overrides: Record<string, unknown>): void {
    const configPath = path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'workflow-config.json');
    const config = {
        ...buildDefaultWorkflowConfig(),
        ...overrides
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function seedInitAnswers(repoRoot: string, sourceOfTruth?: string): void {
    seedBaseInitAnswers(repoRoot, sourceOfTruth);
    const configPath = path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
        compile_gate: {
            command: 'node -e "console.log(\'build ok\')"'
        },
        project_memory_maintenance: {
            enabled: false
        }
    }, null, 2), 'utf8');
}

function seedNodeBackendOptionalSkillFixture(repoRoot: string, policyMode: 'advisory' | 'required' | 'strict' | 'off' = 'advisory') {
    const configDir = path.join(getOrchestratorRoot(repoRoot), 'live', 'config');
    const skillRoot = path.join(getOrchestratorRoot(repoRoot), 'live', 'skills', 'node-backend');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'garda.config.json'),
        JSON.stringify({ version: 1, configs: { 'optional-skill-selection-policy': 'optional-skill-selection-policy.json' } }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(configDir, 'optional-skill-selection-policy.json'),
        JSON.stringify({ version: 1, mode: policyMode }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(skillRoot, 'skill.json'),
        JSON.stringify({
            id: 'node-backend',
            pack: 'node-backend',
            name: 'Node Backend',
            summary: 'Node backend API implementation helper.',
            tags: ['node', 'backend', 'api'],
            aliases: ['node-backend', 'node'],
            task_signals: ['request validation', 'api endpoint', 'node-backend'],
            changed_path_signals: ['src/api/', 'orders.ts'],
            references: [],
            cost_hint: 'low',
            priority: 50,
            autoload: 'suggest'
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Node Backend\n', 'utf8');
    return path.join(skillRoot, 'SKILL.md');
}

describe('cli/commands/gates compile and post-preflight', () => {
    it('runs compile gate and writes evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'unchanged.ts'), 'export const unchanged = true;\n', 'utf8');
        const commandsPath = path.join(repoRoot, 'commands.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\'); console.log(\'ACCESS_TOKEN=compile-secret-value\')"',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(taskModeResult.outputLines[0], 'TASK_MODE_ENTERED');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_PROGRESS');
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        initializeGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changed = true;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Compile an explicit authorized superset',
            ['src/app.ts', 'src/unchanged.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_PASSED');
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.event_source, 'compile-gate');
        assert.deepEqual(evidence.scope_authorized_files, ['src/app.ts', 'src/unchanged.ts']);
        assert.equal(evidence.scope_authorized_files_count, 2);
        assert.match(evidence.scope_authorized_files_sha256, /^[a-f0-9]{64}$/);
        assert.deepEqual(evidence.scope_changed_files, ['src/app.ts']);
        const reviewCompileEvidence = getCompileGateEvidence(
            repoRoot,
            taskId,
            preflightPath,
            createHash('sha256').update(fs.readFileSync(preflightPath)).digest('hex'),
            evidencePath
        );
        assert.equal(reviewCompileEvidence.status, 'PASS');
        assert.equal(testCompileScopeDrift(repoRoot, reviewCompileEvidence).status, 'PASS');
        const compileOutputPath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-output.log`);
        assert.equal(fs.existsSync(compileOutputPath), false);
        assert.equal(evidence.compile_output_path, null);
        assert.equal(evidence.compile_output_retention.raw_output_retained, false);
        assert.equal(evidence.compile_output_retention.retention_reason, 'SUCCESS_LOG_OMITTED');
        assert.equal(typeof evidence.compile_output_retention.raw_output_sha256, 'string');
        assert.ok(result.outputLines.some((line) => line.includes('CompileOutputRetention: retained=false reason=SUCCESS_LOG_OMITTED')));
        assert.ok(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'IMPLEMENTATION_STARTED'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('uses workflow-config compile gate command and ignores the legacy commands file block', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-configured-compile-command';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeWorkflowConfig(repoRoot, {
            compile_gate: {
                command: 'node -e "console.log(\'workflow config build ok\')"'
            }
        });
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-configured-compile.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "process.exit(17)"',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Use workflow config compile command'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.compile_command_source, 'workflow_config');
        assert.equal(evidence.compile_commands[0], 'node -e "console.log(\'workflow config build ok\')"');
        assert.equal(evidence.commands_path, null);
        assert.match(evidence.workflow_config_path, /workflow-config\.json$/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails closed instead of falling back to a legacy commands file when workflow compile gate command is unconfigured', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-unconfigured-compile-command';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeWorkflowConfig(repoRoot, {
            compile_gate: {
                command: UNCONFIGURED_COMPILE_GATE_COMMAND
            }
        });
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-legacy-fallback.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'legacy fallback must not run\')"',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fail closed for unconfigured compile command'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Compile-gate is fail-closed')));
        assert.ok(result.outputLines.some((line) => line.includes('will not read 40-commands.md as a fallback')));
        assert.ok(result.outputLines.some((line) => line.includes(`CompileSummary: FAILED`) && line.includes(`exit_code=${EXIT_GATE_FAILURE}`)));
        assert.equal(evidence.status, 'FAILED');
        assert.equal(evidence.exit_code, EXIT_GATE_FAILURE);
        assert.equal(evidence.compile_command_source, 'unconfigured');
        assert.deepEqual(evidence.compile_commands, []);
        assert.equal(evidence.commands_path, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects workflow-config compile command when it matches full-suite validation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-configured-compile-contract';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeWorkflowConfig(repoRoot, {
            compile_gate: {
                command: 'npm test'
            },
            full_suite_validation: {
                ...buildDefaultWorkflowConfig().full_suite_validation,
                enabled: true,
                command: 'npm test'
            }
        });
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-configured-contract.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'should not run\')"',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject configured compile command overlap'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => /matches the configured full-suite validation command/i.test(line)));
        assert.ok(result.outputLines.some((line) => /must not run the full test suite/i.test(line)));
        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(evidence.status, 'FAILED');
        assert.equal(evidence.compile_command_source, 'workflow_config');
        assert.deepEqual(evidence.compile_commands, []);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate before execution when command is a full-suite test command', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-compile-contract';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeWorkflowConfig(repoRoot, {
            compile_gate: {
                command: 'npm test'
            }
        });
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'npm test',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => /must not run the full test suite/i.test(line)));
        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(evidence.status, 'FAILED');
        assert.deepEqual(evidence.compile_commands, []);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when strict optional-skill selection evidence is missing for the current task cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');
        fs.mkdirSync(path.join(getOrchestratorRoot(repoRoot), 'live', 'config'), { recursive: true });
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'garda.config.json'),
            JSON.stringify({ version: 1, configs: { 'optional-skill-selection-policy': 'optional-skill-selection-policy.json' } }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'strict' }, null, 2),
            'utf8'
        );

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });

        assert.notEqual(result.exitCode, 0);
        assert.ok(result.outputLines.join('\n').includes('Optional skill selection artifact is missing for current task cycle'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when strict optional-skill selection evidence no longer matches the current TASK.md title', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-stale-task-text';
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
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['docs/landing.md'],
            required_reviews: {
                code: false,
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
        const commandsPath = path.join(repoRoot, 'commands-stale-task-text.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'strict');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement request validation for a Node.js API endpoint'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: 'Implement request validation for a Node.js API endpoint',
            changedPaths: ['docs/landing.md'],
            preflightPath
        });
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Implement request validation for a Node.js API endpoint',
                'Refresh landing-page copy for the marketing site'
            ),
            'utf8'
        );

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });

        assert.notEqual(result.exitCode, 0);
        assert.ok(result.outputLines.join('\n').includes('current task summary hash'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when the current task row disappears from TASK.md after optional-skill evidence was materialized', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-missing-task-row';
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
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['docs/landing.md'],
            required_reviews: {
                code: false,
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
        const commandsPath = path.join(repoRoot, 'commands-missing-task-row.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'strict');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement request validation for a Node.js API endpoint'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: 'Implement request validation for a Node.js API endpoint',
            changedPaths: ['docs/landing.md'],
            preflightPath
        });
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        fs.writeFileSync(
            taskPath,
            [
                '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-999 | TODO | P2 | docs | Placeholder task | unassigned | 2026-03-28 | default | fixture |'
            ].join('\n'),
            'utf8'
        );

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });

        assert.notEqual(result.exitCode, 0);
        assert.ok(result.outputLines.join('\n').includes('current task summary hash'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('applies budget tiers to compile gate telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-budget';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            budget_forecast: {
                task_id: taskId,
                requested_depth: 1,
                effective_depth: 1,
                depth_escalated: false,
                path_mode: 'FULL_PATH',
                changed_files_count: 1,
                changed_lines_total: 3,
                required_reviews: ['code'],
                review_budget_estimates: [],
                total_estimated_review_tokens: 400,
                compile_gate_estimated_tokens: 300,
                total_forecast_tokens: 700,
                token_economy_enabled: true,
                token_economy_active_for_depth: true,
                forecast_savings_estimate: 200,
                effective_forecast_tokens: 500
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-budget.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'budget ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Budget telemetry check'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(taskModeResult.outputLines[0], 'TASK_MODE_ENTERED');
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.selected_output_profile, 'compile_success_console');
        assert.equal(evidence.selected_budget_tier, 'tight');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when task mode entry evidence is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901a';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some(line => line.includes('Task-mode entry evidence missing')));
        assertCompileFailureIncludesNextStepHint(result.outputLines);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('retains raw compile output for failed compile runs', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-compile-fail-retention';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeWorkflowConfig(repoRoot, {
            compile_gate: {
                command: 'node -e "console.error(\'compile failed detail\'); process.exit(2)"'
            }
        });
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-compile-fail-retention.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.error(\'compile failed detail\'); process.exit(2)"',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Retain compile output on failed compile'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        const compileOutputPath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-output.log`);
        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.equal(evidence.status, 'FAILED');
        assert.equal(fs.existsSync(compileOutputPath), true);
        assert.equal(String(evidence.compile_output_path).replace(/\\/g, '/'), compileOutputPath.replace(/\\/g, '/'));
        assert.equal(evidence.compile_output_retention.raw_output_retained, true);
        assert.equal(evidence.compile_output_retention.retention_reason, 'FULL_OUTPUT_RETAINED');
        assert.ok(result.outputLines.some((line) => line.includes('CompileOutputRetention: retained=true reason=FULL_OUTPUT_RETAINED')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('surfaces infra recovery hints for Testcontainers Docker environment failures', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-compile-infra-hint';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeWorkflowConfig(repoRoot, {
            compile_gate: {
                command: 'node -e "console.error(\'org.testcontainers.containers.ContainerFetchException: Could not find a valid Docker environment\'); process.exit(2)"'
            }
        });
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-compile-infra-hint.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.error(\'org.testcontainers.containers.ContainerFetchException: Could not find a valid Docker environment\'); process.exit(2)"',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Show infra compile recovery hints'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.startsWith('InfraRecoveryHint:')));
        assert.ok(result.outputLines.some((line) => line.includes('Testcontainers') && line.includes('docker info')));
        assert.equal(evidence.infra_recovery_hint.kind, 'testcontainers_no_environment');
        assert.ok(String(evidence.infra_recovery_hint.hint).includes('docker info'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classifies Docker daemon, container startup, and external service compile failures', async () => {
        const cases = [
            {
                taskId: 'T-901-compile-docker-daemon-hint',
                message: 'Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine. Is the docker daemon running?',
                expectedKind: 'docker_daemon_unavailable',
                expectedText: 'Docker daemon is unavailable'
            },
            {
                taskId: 'T-901-compile-container-startup-hint',
                message: 'org.testcontainers.containers.ContainerLaunchException: Could not start container; Wait strategy timed out',
                expectedKind: 'container_startup_failure',
                expectedText: 'required container failed to start'
            },
            {
                taskId: 'T-901-compile-external-service-hint',
                message: 'connect ECONNREFUSED 127.0.0.1:5432',
                expectedKind: 'external_service_unavailable',
                expectedText: 'external service dependency was unreachable'
            }
        ] as const;

        for (const testCase of cases) {
            const repoRoot = createTempRepo();
            try {
                seedTaskQueue(repoRoot, testCase.taskId);
                seedInitAnswers(repoRoot);
                writeWorkflowConfig(repoRoot, {
                    compile_gate: {
                        command: `node -e "console.error('${testCase.message}'); process.exit(2)"`
                    }
                });
                const preflightPath = writePreflight(repoRoot, testCase.taskId);
                const commandsPath = path.join(repoRoot, `${testCase.taskId}-commands.md`);
                const outputFiltersPath = path.resolve('live/config/output-filters.json');
                fs.writeFileSync(commandsPath, [
                    '### Compile Gate (Mandatory)',
                    '```bash',
                    `node -e "console.error('${testCase.message}'); process.exit(2)"`,
                    '```'
                ].join('\n'), 'utf8');

                const taskModeResult = runEnterTaskMode({
                    repoRoot,
                    taskId: testCase.taskId,
                    taskSummary: 'Classify infra compile failure'
                });
                assert.equal(taskModeResult.exitCode, 0);
                assert.equal(loadTaskEntryRulePack(repoRoot, testCase.taskId).exitCode, 0);
                runHandshakeForTask(repoRoot, testCase.taskId);
                runShellSmokeForTask(repoRoot, testCase.taskId);
                assert.equal(loadPostPreflightRulePack(repoRoot, testCase.taskId, preflightPath).exitCode, 0);

                const result = await runCompileGateCommand({
                    repoRoot,
                    taskId: testCase.taskId,
                    preflightPath,
                    commandsPath,
                    outputFiltersPath,
                    emitMetrics: false
                });

                const evidencePath = path.join(getReviewsRoot(repoRoot), `${testCase.taskId}-compile-gate.json`);
                const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
                assert.equal(result.exitCode, EXIT_GATE_FAILURE);
                assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
                assert.equal(evidence.infra_recovery_hint.kind, testCase.expectedKind);
                assert.ok(result.outputLines.some((line) => line.startsWith('InfraRecoveryHint:') && line.includes(testCase.expectedText)));
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
    });

    it('keeps generic compile failures without infra recovery hints', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-compile-generic-failure';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeWorkflowConfig(repoRoot, {
            compile_gate: {
                command: 'node -e "console.error(\'src/app.ts(1,1): error TS1005: expected\'); process.exit(2)"'
            }
        });
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-compile-generic-failure.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.error(\'src/app.ts(1,1): error TS1005: expected\'); process.exit(2)"',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep ordinary compile failures generic'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.equal(result.outputLines.some((line) => line.startsWith('InfraRecoveryHint:')), false);
        assert.equal(evidence.infra_recovery_hint, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('explains planned explicit preflight refresh steps when compile gate detects scope drift in a clean workspace', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901scope-drift-guidance';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Clarify planned explicit preflight drift recovery'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Clarify planned explicit preflight drift recovery', ['src/app.ts']);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        fs.writeFileSync(appPath, 'const a = 10;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-scope-drift.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Preflight scope drift detected.')));
        assert.ok(result.outputLines.some((line) => line.includes('planned --changed-file inputs in a clean workspace')));
        assert.ok(result.outputLines.some((line) => line.includes('load-rule-pack --stage POST_PREFLIGHT')));
        assertCompileFailureIncludesNextStepHint(result.outputLines);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('recovers from planned explicit preflight scope drift after rerunning classify-change and POST_PREFLIGHT rule-pack', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901scope-drift-recovery';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Recover planned explicit preflight drift after real diff exists'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Recover planned explicit preflight drift after real diff exists', ['src/app.ts']);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        fs.writeFileSync(appPath, 'const a = 10;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-scope-drift-recovery.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const firstCompile = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(firstCompile.exitCode, EXIT_GATE_FAILURE);
        assert.ok(firstCompile.outputLines.some((line) => line.includes('Preflight scope drift detected.')));

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Recover planned explicit preflight drift after real diff exists',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, refreshedPreflightPath).exitCode, 0);

        const secondCompile = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(secondCompile.exitCode, 0);
        assert.equal(secondCompile.outputLines[0], 'COMPILE_GATE_PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('records sequence evidence on the successful sequential POST_PREFLIGHT and compile path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-sequence-evidence';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-sequence.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Emit sequence evidence for successful sequential compile flow'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Emit sequence evidence for successful sequential compile flow',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const rulePackArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`), 'utf8')
        );
        const compileArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        );

        assert.equal(typeof rulePackArtifact.stages.post_preflight.preflight_event_sequence, 'number');
        assert.equal(typeof compileArtifact.post_preflight_sequence.latest_preflight_sequence, 'number');
        assert.equal(typeof compileArtifact.post_preflight_sequence.latest_post_preflight_rule_pack_sequence, 'number');
        assert.ok(
            compileArtifact.post_preflight_sequence.latest_post_preflight_rule_pack_sequence
            > compileArtifact.post_preflight_sequence.latest_preflight_sequence
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses binding-equivalent POST_PREFLIGHT rule-pack evidence after an identical preflight refresh', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-binding-equivalent';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeBalancedProfilesConfig(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-binding-equivalent.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence',
            ['src/app.ts']
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);
        assert.equal(compileResult.outputLines[0], 'COMPILE_GATE_PASSED');

        const compileArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const postPreflightSequence = compileArtifact.post_preflight_sequence as Record<string, unknown>;
        const rulePackEvidence = compileArtifact.rule_pack as Record<string, unknown>;
        assert.equal(postPreflightSequence.binding_equivalent_to_current_preflight, true);
        assert.equal(rulePackEvidence.binding_equivalent_to_current_preflight, true);

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            reviewAuthorshipAttestationJson: '{"code":true}',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_PASSED');

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Equivalent preflight refresh keeps the same downstream rule-pack.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath: refreshedPreflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('binds current-cycle POST_PREFLIGHT rule-pack evidence after a changed preflight refresh without rereading rules', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-bind-refresh';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-bind-refresh.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Bind equivalent rule-pack after preflight refresh'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Bind equivalent rule-pack after preflight refresh',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        fs.writeFileSync(appPath, 'const a = 4;\nconst b = 2;\nconsole.log(a / b);\n', 'utf8');
        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Bind equivalent rule-pack after preflight refresh',
            ['src/app.ts']
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const bindResult = runBindRulePackToPreflightCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            emitMetrics: false
        });
        assert.equal(bindResult.exitCode, 0, JSON.stringify(bindResult, null, 2));
        assert.equal(bindResult.outputLines[0], 'RULE_PACK_BOUND');

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0, JSON.stringify(compileResult, null, 2));
        assert.equal(compileResult.outputLines[0], 'COMPILE_GATE_PASSED');

        const rulePackArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`), 'utf8')
        ) as Record<string, any>;
        const postPreflightStage = rulePackArtifact.stages.post_preflight;
        const refreshedPreflightSha256 = createHash('sha256').update(fs.readFileSync(refreshedPreflightPath)).digest('hex');
        assert.equal(postPreflightStage.preflight_hash_sha256, refreshedPreflightSha256);
        assert.equal(postPreflightStage.actor, 'orchestrator:rule-pack-rebind');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects POST_PREFLIGHT rebinding when no current task-mode cycle loaded the rules', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-bind-resume-reject';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale rebind after resume'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale rebind after resume',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale rebind after resume'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale rebind after resume',
            ['src/app.ts']
        );

        const bindResult = runBindRulePackToPreflightCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            emitMetrics: false
        });

        assert.equal(bindResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(bindResult.outputLines[0], 'RULE_PACK_BIND_FAILED');
        assert.ok(bindResult.outputLines.some((line) => line.includes('No POST_PREFLIGHT rule-pack evidence exists for this rule-pack artifact in the current task-mode cycle')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects POST_PREFLIGHT rebinding when current-cycle evidence belongs to another artifact', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-bind-artifact-reject';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale default rule-pack rebind after custom artifact load'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale default rule-pack rebind after custom artifact load',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale default rule-pack rebind after custom artifact load'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale default rule-pack rebind after custom artifact load',
            ['src/app.ts']
        );
        const customRulePackPath = path.join(repoRoot, 'custom-artifacts', `${taskId}-rule-pack.json`);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, refreshedPreflightPath, true, customRulePackPath).exitCode, 0);

        const bindResult = runBindRulePackToPreflightCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            emitMetrics: false
        });

        assert.equal(bindResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(bindResult.outputLines[0], 'RULE_PACK_BIND_FAILED');
        assert.ok(bindResult.outputLines.some((line) => line.includes('for this rule-pack artifact in the current task-mode cycle')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects POST_PREFLIGHT rebinding when an extra loaded rule file changed', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-bind-extra-rule-reject';
        const extraRulePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'docs',
            'agent-rules',
            'project-specific-rule.md'
        );
        fs.writeFileSync(extraRulePath, '# Project specific rule\n\nInitial content.\n', 'utf8');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale extra rule file rebind'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale extra rule file rebind',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        const rulePackPath = path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
        const artifact = JSON.parse(fs.readFileSync(rulePackPath, 'utf8')) as Record<string, any>;
        const normalizedExtraRulePath = extraRulePath.replace(/\\/g, '/');
        artifact.stages.post_preflight.loaded_rule_files.push(normalizedExtraRulePath);
        artifact.stages.post_preflight.extra_rule_files.push(normalizedExtraRulePath);
        artifact.stages.post_preflight.loaded_rule_hashes[normalizedExtraRulePath] = createHash('sha256')
            .update(fs.readFileSync(extraRulePath))
            .digest('hex');
        artifact.stages.post_preflight.loaded_rule_count = artifact.stages.post_preflight.loaded_rule_files.length;
        fs.writeFileSync(rulePackPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

        fs.writeFileSync(extraRulePath, '# Project specific rule\n\nUpdated content.\n', 'utf8');
        writeProtectedControlPlaneManifest(repoRoot);
        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale extra rule file rebind',
            ['src/app.ts']
        );

        const bindResult = runBindRulePackToPreflightCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            emitMetrics: false
        });

        assert.equal(bindResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(bindResult.outputLines[0], 'RULE_PACK_BIND_FAILED');
        assert.ok(bindResult.outputLines.some((line) => line.includes('changed or cannot be hashed')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses binding-equivalent POST_PREFLIGHT rule-pack evidence from a custom artifact path after an identical preflight refresh', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-binding-equivalent-custom-path';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-binding-equivalent-custom-path.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        const customRulePackPath = path.join(repoRoot, 'custom-artifacts', `${taskId}-rule-pack.json`);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow equivalent preflight refresh to reuse custom POST_PREFLIGHT rule-pack evidence'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse custom POST_PREFLIGHT rule-pack evidence',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, customRulePackPath).exitCode, 0);

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse custom POST_PREFLIGHT rule-pack evidence',
            ['src/app.ts']
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            rulePackPath: customRulePackPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);
        assert.equal(compileResult.outputLines[0], 'COMPILE_GATE_PASSED');

        const compileArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const postPreflightSequence = compileArtifact.post_preflight_sequence as Record<string, unknown>;
        const rulePackEvidence = compileArtifact.rule_pack as Record<string, unknown>;
        assert.equal(postPreflightSequence.binding_equivalent_to_current_preflight, true);
        assert.equal(rulePackEvidence.binding_equivalent_to_current_preflight, true);
        assert.equal(rulePackEvidence.evidence_path, customRulePackPath.replace(/\\/g, '/'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses binding-equivalent POST_PREFLIGHT rule-pack evidence with a custom task-mode path after an identical preflight refresh', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-binding-equivalent-custom-task-mode';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-binding-equivalent-custom-task-mode.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence with a custom task-mode path',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence with a custom task-mode path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath).exitCode, 0);

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence with a custom task-mode path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);
        assert.equal(compileResult.outputLines[0], 'COMPILE_GATE_PASSED');

        const compileArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const postPreflightSequence = compileArtifact.post_preflight_sequence as Record<string, unknown>;
        const rulePackEvidence = compileArtifact.rule_pack as Record<string, unknown>;
        assert.equal(postPreflightSequence.binding_equivalent_to_current_preflight, true);
        assert.equal(rulePackEvidence.binding_equivalent_to_current_preflight, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when binding-equivalent POST_PREFLIGHT evidence predates a resumed task-mode cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-binding-equivalent-resumed-cycle';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-binding-equivalent-resumed-cycle.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject binding-equivalent POST_PREFLIGHT evidence from a previous task-mode cycle'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject binding-equivalent POST_PREFLIGHT evidence from a previous task-mode cycle',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject binding-equivalent POST_PREFLIGHT evidence from a previous task-mode cycle'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Unsafe stale task-mode cycle detected')));
        assert.ok(result.outputLines.some((line) => line.includes('does not occur after the latest TASK_MODE_ENTERED')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate with explicit unsafe parallelism guidance for a custom task-mode path when a newer preflight supersedes POST_PREFLIGHT rule-pack evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-overlap-custom-task-mode';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle with a custom task-mode path',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle with a custom task-mode path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath).exitCode, 0);

        fs.writeFileSync(appPath, 'const a = 10;\nconst b = 2;\nconsole.log(a - b);\n', 'utf8');

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle with a custom task-mode path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const commandsPath = path.join(repoRoot, 'commands-post-preflight-overlap-custom-task-mode.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Unsafe same-task overlap detected')));
        assertGateChainDecision(result.outputLines, {
            edgeId: 'post-preflight-rules-to-compile',
            status: 'block',
            reason: 'Do not parallelize classify-change, load-rule-pack --stage POST_PREFLIGHT, and compile-gate',
            remediation: 'node bin/garda.js gate load-rule-pack --task-id'
        });
        assertCompileFailureIncludesNextStepHint(result.outputLines);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when explicit task-mode path differs from the timeline-recorded TASK_MODE_ENTERED artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-task-mode-artifact-path-mismatch';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const alternateTaskModePath = path.join(repoRoot, 'copied-artifacts', `${taskId}-task-mode.json`);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject copied task-mode artifacts that differ from the timeline-recorded path'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject copied task-mode artifacts that differ from the timeline-recorded path',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const canonicalTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        fs.mkdirSync(path.dirname(alternateTaskModePath), { recursive: true });
        fs.copyFileSync(canonicalTaskModePath, alternateTaskModePath);

        const commandsPath = path.join(repoRoot, 'commands-task-mode-artifact-path-mismatch.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: alternateTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Task-mode entry evidence artifact path mismatch')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when task-mode entry evidence omits pinned runtime identity metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-task-mode-identity-missing-at-compile';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject compile gate when task-mode identity metadata is missing',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject compile gate when task-mode identity metadata is missing',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const tamperedTaskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        delete tamperedTaskMode.canonical_source_of_truth;
        delete tamperedTaskMode.execution_provider_source;
        delete tamperedTaskMode.runtime_identity_status;
        fs.writeFileSync(taskModePath, JSON.stringify(tamperedTaskMode, null, 2) + '\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-task-mode-identity-missing-at-compile.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('missing canonical_source_of_truth')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when explicit POST_PREFLIGHT rule-pack path differs from the timeline-recorded artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-rule-pack-artifact-path-mismatch';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const alternateRulePackPath = path.join(repoRoot, 'copied-artifacts', `${taskId}-rule-pack.json`);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject copied POST_PREFLIGHT rule-pack artifacts that differ from the timeline-recorded path'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject copied POST_PREFLIGHT rule-pack artifacts that differ from the timeline-recorded path',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const canonicalRulePackPath = path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
        fs.mkdirSync(path.dirname(alternateRulePackPath), { recursive: true });
        fs.copyFileSync(canonicalRulePackPath, alternateRulePackPath);

        const commandsPath = path.join(repoRoot, 'commands-post-preflight-rule-pack-artifact-path-mismatch.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            rulePackPath: alternateRulePackPath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Rule-pack evidence artifact path mismatch')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate with explicit unsafe parallelism guidance when a newer preflight supersedes POST_PREFLIGHT rule-pack evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-overlap';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        fs.writeFileSync(appPath, 'const a = 10;\nconst b = 2;\nconsole.log(a - b);\n', 'utf8');

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle',
            ['src/app.ts']
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const commandsPath = path.join(repoRoot, 'commands-post-preflight-overlap.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Unsafe same-task overlap detected')));
        assertGateChainDecision(result.outputLines, {
            edgeId: 'post-preflight-rules-to-compile',
            status: 'block',
            reason: 'Do not parallelize classify-change, load-rule-pack --stage POST_PREFLIGHT, and compile-gate',
            remediation: 'node bin/garda.js gate load-rule-pack --task-id'
        });
        assertCompileFailureIncludesNextStepHint(result.outputLines);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when the latest handshake supersedes shell smoke evidence for the current task cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-handshake-shell-smoke-overlap';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-handshake-shell-smoke-overlap.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale shell smoke evidence before compile'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale shell smoke evidence before compile',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Unsafe same-task overlap detected')));
        assertGateChainDecision(result.outputLines, {
            edgeId: 'handshake-to-shell-smoke',
            status: 'block',
            reason: 'shell-smoke-preflight -> classify-change -> load-rule-pack --stage POST_PREFLIGHT -> compile-gate',
            remediation: 'node bin/garda.js gate shell-smoke-preflight --task-id'
        });

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});
