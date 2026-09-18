import {
    EXIT_GATE_FAILURE,
    appendTaskEvent,
    assert,
    buildDefaultRemediationImpactAnalysis,
    createTempRepo,
    describe,
    escapeRegExp,
    fileSha256,
    findLastTimelineEventIndex,
    fs,
    getCurrentWorkflowConfigFileHashes,
    getOrchestratorRoot,
    getReviewsRoot,
    initializeGitRepo,
    it,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    markAsSourceCheckout,
    normalizePath,
    os,
    path,
    readTaskTimelineEvents,
    runBuildReviewContextCommand,
    runCompileGateCommand,
    runCompletionGate,
    runEnterTaskMode,
    runExplicitPreflight,
    runGit,
    runHandshakeForTask,
    runRequiredReviewsCheckCommand,
    runRestartCoherentCycleCommand,
    runRestartReviewCycleCommand,
    runRestartReviewCycleCommandRaw,
    runShellSmokeForTask,
    seedInitAnswers,
    seedRemediationRepoBase as seedRemediationRepoBaseWithoutProfiles,
    seedNodeBackendOptionalSkillFixture,
    seedReusableReviewEvidence,
    seedTaskQueue,
    serializeTaskPlan,
    validateTaskPlan,
    writeOptionalSkillSelectionArtifact,
    writePreflight,
    writeProtectedControlPlaneManifest,
    writeReceiptBackedReviewArtifact,
    writeReviewCapabilitiesConfig,
    writeSimpleCompileCommandsFile,
    writeWorkflowConfig
} from './gates-review-cycle-fixtures';
import { writeBudgetOutputFilters } from '../../gate-test-helpers';
import {
    handleCompleteReviewerLaunch,
    handlePrepareReviewerLaunch,
    handleRecordReviewerDelegationStarted,
    handleRecordReviewResult,
    handleRecordReviewRouting
} from '../../../../../../src/cli/commands/gate-review-handlers';
import { buildEventIntegrityHash } from '../../../../../../src/gate-runtime/task-events-helpers';
import {
    runFullSuiteValidationCommand,
    runQualityChecklistCommand
} from '../../../../../../src/cli/commands/gates';
import { buildTaskProfilePolicySnapshot } from '../../../../../../src/policy/task-profile-policy-snapshot';
import { resolveNextStep } from '../../../../gates/next-step/next-step-test-support';

describe('cli/commands/gates – review-cycle restart suite', () => {
    const OPTIONAL_SKILL_HEADLINES_PATH = 'garda-agent-orchestrator/live/config/skills-headlines.json';
    const TRUST_BOUNDARY_QUALITY_RULE_IDS = [
        'code_simplification',
        'project_style_fit',
        'unnecessary_abstraction',
        'size_growth',
        'hardcoded_values_contracts',
        'duplicated_logic_contracts',
        'test_verification_scope',
        'trust_boundary_adversarial_analysis'
    ];

    function seedRemediationRepoBase(repoRoot: string): void {
        seedRemediationRepoBaseWithoutProfiles(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'tests', 'trust-boundary-recovery.test.ts'),
            'it("rejects stale review recovery evidence", () => { assert.equal(true, true); });\n',
            'utf8'
        );
    }

    function runPassingTrustBoundaryQualityChecklist(options: {
        repoRoot: string;
        taskId: string;
        preflightPath: string;
        evidenceFiles: string[];
    }): void {
        const result = runQualityChecklistCommand({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            preflightPath: options.preflightPath,
            answersJson: JSON.stringify(TRUST_BOUNDARY_QUALITY_RULE_IDS.map((ruleId) => ({
                rule_id: ruleId,
                status: 'PASS',
                answer: `Reviewed ${ruleId} for the focused restart-recovery fixture; no action is required.`,
                evidence_files: options.evidenceFiles,
                actions_taken: [],
                actions_required: [],
                ...(ruleId === 'trust_boundary_adversarial_analysis'
                    ? {
                        trust_boundary_matrix: [{
                            boundary_id: 'review-recovery-evidence',
                            boundary: 'Review recovery evidence',
                            authority_source: 'Gate-owned task timeline and authenticated preflight',
                            mutable_inputs: ['Reviewer output', 'Remediation impact analysis'],
                            integrity_evidence: ['Preflight hash', 'Quality-checklist timeline binding'],
                            canonical_reconstruction: 'Recompute current preflight and checklist hashes from repository state.',
                            toctou_replay: 'Reject stale or replayed evidence before review-context preparation.',
                            negative_paths: [{
                                kind: 'stale',
                                scenario: 'rejects stale review recovery evidence',
                                expected_behavior: 'Reject stale review recovery evidence before preparing review contexts.',
                                evidence_files: [
                                    'tests/trust-boundary-recovery.test.ts#rejects stale review recovery evidence'
                                ]
                            }]
                        }]
                    }
                    : {})
            }))),
            emitMetrics: false
        });
        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
    }

    function copyWorkflowConfig(repoRoot: string, sourcePath: string, targetRelativePath: string): void {
        const targetPath = path.join(repoRoot, ...targetRelativePath.split('/'));
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
    }

    function setWorkflowConfigReviewExecutionMode(
        repoRoot: string,
        relativePath: string,
        mode: 'parallel_all' | 'strict_sequential' | 'code_first_optional'
    ): void {
        const configPath = path.join(repoRoot, ...relativePath.split('/'));
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
            review_execution_policy?: { mode?: string };
        };
        config.review_execution_policy = {
            ...(config.review_execution_policy || {}),
            mode
        };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    }

    function prepareProtectedCoherentRestartFixture(taskId: string): {
        repoRoot: string;
        taskId: string;
        preflightPath: string;
        commandsPath: string;
        outputFiltersPath: string;
    } {
        const repoRoot = createTempRepo();
        seedRemediationRepoBase(repoRoot);
        markAsSourceCheckout(repoRoot);
        writeProtectedControlPlaneManifest(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            `${taskId}-protected-restart`
        );

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart a protected coherent cycle after recovery routing',
            orchestratorWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
        });
        assert.equal(taskModeResult.exitCode, 0, taskModeResult.outputLines.join('\n'));
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts']
        });
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        return {
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath
        };
    }

    async function prepareApprovedWorkflowConfigRestartFixture(options: {
        taskId: string;
        workflowConfigPath: string;
        extraWorkflowConfigPaths?: string[];
    }): Promise<{
        repoRoot: string;
        taskId: string;
        taskModePath: string;
        preflightPath: string;
        commandsPath: string;
        outputFiltersPath: string;
        workflowConfigPath: string;
        originalWorkflowConfigHash: string | null | undefined;
        approvedWorkflowConfigHash: string | null | undefined;
    }> {
        const repoRoot = createTempRepo();
        const taskSummary = 'Restart approved workflow-config policy changes after a closed cycle';
        seedRemediationRepoBase(repoRoot);
        markAsSourceCheckout(repoRoot);
        const bundledWorkflowConfigPath = writeWorkflowConfig(repoRoot);
        for (const relativePath of [
            options.workflowConfigPath,
            ...(options.extraWorkflowConfigPaths || [])
        ]) {
            if (relativePath !== 'garda-agent-orchestrator/live/config/workflow-config.json') {
                copyWorkflowConfig(repoRoot, bundledWorkflowConfigPath, relativePath);
            }
        }
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
            `| ${options.taskId} | TODO | P1 | workflow | Update workflow-config policy changes | unassigned | 2026-03-28 | default | Owns workflow-config policy changes. |`
        ].join('\n'), 'utf8');
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);
        writeProtectedControlPlaneManifest(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            `${options.taskId}-workflow-config`
        );

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId: options.taskId,
            taskSummary,
            orchestratorWork: true,
            workflowConfigWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            plannedChangedFiles: [options.workflowConfigPath]
        });
        assert.equal(taskModeResult.exitCode, 0, taskModeResult.outputLines.join('\n'));
        const taskModePath = path.join(getReviewsRoot(repoRoot), `${options.taskId}-task-mode.json`);
        const initialTaskModeArtifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as {
            workflow_config_file_hashes?: Record<string, string | null>;
        };
        const originalWorkflowConfigHash = initialTaskModeArtifact.workflow_config_file_hashes?.[options.workflowConfigPath];

        loadTaskEntryRulePack(repoRoot, options.taskId);
        runHandshakeForTask(repoRoot, options.taskId);
        runShellSmokeForTask(repoRoot, options.taskId);

        setWorkflowConfigReviewExecutionMode(repoRoot, options.workflowConfigPath, 'strict_sequential');
        const approvedWorkflowConfigHash = getCurrentWorkflowConfigFileHashes(repoRoot)[options.workflowConfigPath];
        assert.notEqual(approvedWorkflowConfigHash, originalWorkflowConfigHash);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            options.taskId,
            taskSummary,
            [options.workflowConfigPath],
            `${options.taskId}-preflight.json`,
            taskModePath
        );
        loadPostPreflightRulePack(repoRoot, options.taskId, preflightPath, true, '', taskModePath);
        const initialCompileResult = await runCompileGateCommand({
            repoRoot,
            taskId: options.taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(initialCompileResult.exitCode, 0, initialCompileResult.outputLines.join('\n'));
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            options.taskId,
            'REVIEW_GATE_PASSED',
            'PASS',
            'Review gate passed before coherent restart.',
            {}
        );

        return {
            repoRoot,
            taskId: options.taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            workflowConfigPath: options.workflowConfigPath,
            originalWorkflowConfigHash,
            approvedWorkflowConfigHash
        };
    }

    it('restarts the latest coherent cycle on a dirty tree while reusing the previous explicit preflight scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        markAsSourceCheckout(repoRoot);
        writeProtectedControlPlaneManifest(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), [
            'const a = 1;',
            'const b = 2;',
            'console.log(a + b);',
            'export const value = 1;',
            'export const enabled = true;',
            'export const label = "restart";'
        ].join('\n') + '\n', 'utf8');
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
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle.md');
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
            taskSummary: 'Restart the latest coherent cycle after misordered recovery noise',
            startBanner: 'Garda rewrites my code',
            orchestratorWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
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

        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED', undefined, {
            allowLegacyManualReviewContext: true
        });

        const firstReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            reviewAuthorshipAttestationJson: '{"code":true}',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(firstReviewResult.exitCode, 0, firstReviewResult.outputLines.join('\n'));

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

        const failedCompletion = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(failedCompletion.outcome, 'FAIL');

        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'noise.md'), 'unrelated dirty file\n', 'utf8');

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const restartOutput = restartResult.outputLines.join('\n');
        assert.equal(restartResult.outputLines[0], 'Next action:');
        assert.match(restartOutput, /COHERENT_CYCLE_RESTARTED/);
        assert.match(restartOutput, /^  Command: node bin\/garda\.js next-step "T-903a-restart-coherent-cycle" --repo-root "\."$/mu);
        assert.match(restartOutput, /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts']);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const restartEvent = [...events].reverse().find((event) => event.event_type === 'COHERENT_CYCLE_RESTARTED') as Record<string, unknown> | undefined;
        assert.ok(restartEvent, 'coherent-cycle restart must persist a task event after compile pass');
        const restartDetails = restartEvent.details as Record<string, unknown>;
        const restartArtifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-coherent-cycle-restart.json`);
        const compileEvidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        assert.match(restartOutput, new RegExp(`DetailsPath: ${escapeRegExp(normalizePath(restartArtifactPath))}`, 'u'));
        assert.equal(restartDetails.restart_event_schema_version, 1);
        assert.equal(restartDetails.task_id, taskId);
        assert.equal(restartDetails.event_type, 'COHERENT_CYCLE_RESTARTED');
        assert.equal(restartDetails.task_mode_sha256, fileSha256(taskModePath));
        assert.equal(restartDetails.preflight_sha256, fileSha256(preflightPath));
        assert.equal(restartDetails.compile_evidence_sha256, fileSha256(compileEvidencePath));
        assert.equal(restartDetails.restart_artifact_sha256, fileSha256(restartArtifactPath));
        assert.equal(restartDetails.detected_changed_files_count, 1);
        assert.ok(Number(restartDetails.elapsed_ms) >= 0);
        assert.equal(fs.existsSync(restartArtifactPath), true);

        const lastTaskModeIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'TASK_MODE_ENTERED');
        const lastHandshakeIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED');
        const lastShellSmokeIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED');
        const lastPreflightIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'PREFLIGHT_CLASSIFIED');
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        assert.ok(lastTaskModeIndex >= 0);
        assert.ok(lastHandshakeIndex > lastTaskModeIndex);
        assert.ok(lastShellSmokeIndex > lastHandshakeIndex);
        assert.ok(lastPreflightIndex > lastShellSmokeIndex);
        assert.ok(lastCompileIndex > lastPreflightIndex);
        const lastTaskModeEvent = events[lastTaskModeIndex] as Record<string, unknown>;
        assert.equal(
            String((lastTaskModeEvent.details as Record<string, unknown>).start_banner || ''),
            'Garda rewrites my code'
        );
        const refreshedTaskModeArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(refreshedTaskModeArtifact.start_banner, 'Garda rewrites my code');
        assert.equal(refreshedTaskModeArtifact.orchestrator_work, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-coherent-cycle rebinds mandatory optional-skill activation into the refreshed recovery cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-942-restart-coherent-optional-skill-rebind';
        const taskSummary = 'Implement request validation for a Node.js API endpoint';
        seedRemediationRepoBase(repoRoot);
        markAsSourceCheckout(repoRoot);
        writeProtectedControlPlaneManifest(repoRoot);
        seedNodeBackendOptionalSkillFixture(repoRoot, 'strict');
        seedTaskQueue(repoRoot, taskId);
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace('Update app flow', taskSummary),
            'utf8'
        );
        seedInitAnswers(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const validate = () => true;\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'api', 'orders.ts'),
            'export const validate = (input: unknown) => Boolean(input);\n',
            'utf8'
        );
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            'restart-coherent-optional-skill-rebind'
        );
        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary,
            plannedChangedFiles: ['src/api/orders.ts'],
            orchestratorWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
        });
        assert.equal(taskModeResult.exitCode, 0, taskModeResult.outputLines.join('\n'));
        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        loadTaskEntryRulePack(repoRoot, taskId, taskModePath);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            taskSummary,
            ['src/api/orders.ts'],
            `${taskId}-preflight.json`,
            taskModePath
        );
        const artifact = writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: taskSummary,
            changedPaths: ['src/api/orders.ts'],
            preflightPath,
            preflightSha256: fileSha256(preflightPath)
        });
        assert.equal(artifact.payload.decision, 'selected_installed_skills');
        assert.equal(artifact.payload.selected_installed_skills[0]?.id, 'node-backend');
        const skillsHeadlinesStatus = runGit(repoRoot, ['status', '--short', '--', OPTIONAL_SKILL_HEADLINES_PATH]).stdout.trim();
        if (skillsHeadlinesStatus) {
            runGit(repoRoot, ['add', OPTIONAL_SKILL_HEADLINES_PATH]);
            runGit(repoRoot, ['commit', '-m', 'test: baseline optional skill headlines']);
        }
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', taskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: node-backend',
            {
                skill_id: 'node-backend',
                pack_id: 'node-backend',
                trigger_reason: 'optional_skill_selection',
                optional_skill_selection_fingerprint_sha256: artifact.payload.selection_fingerprint_sha256
            }
        );

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0, compileResult.outputLines.join('\n'));

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);

        const refreshedOptionalSkillArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-optional-skill-selection.json`),
            'utf8'
        )) as Record<string, unknown>;
        const refreshedSelectionFingerprintSha256 = String(
            refreshedOptionalSkillArtifact.selection_fingerprint_sha256 || ''
        );
        assert.ok(refreshedSelectionFingerprintSha256);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const lastPreflightIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'PREFLIGHT_CLASSIFIED');
        const reboundSkillIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'SKILL_SELECTED'
            && (event.details as Record<string, unknown> | null)?.skill_id === 'node-backend'
            && (event.details as Record<string, unknown> | null)?.trigger_reason === 'optional_skill_selection'
            && (event.details as Record<string, unknown> | null)?.optional_skill_selection_fingerprint_sha256 === refreshedSelectionFingerprintSha256
        ));
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        assert.ok(lastPreflightIndex >= 0);
        assert.ok(reboundSkillIndex > lastPreflightIndex);
        assert.ok(lastCompileIndex > reboundSkillIndex);
        const restartEvent = [...events].reverse().find((event) => event.event_type === 'COHERENT_CYCLE_RESTARTED') as Record<string, unknown> | undefined;
        assert.ok(restartEvent, 'coherent restart must persist a passed restart event');
        assert.deepEqual(
            (restartEvent.details as Record<string, unknown>).optional_skill_activation_rebound_skill_ids,
            ['node-backend']
        );
        assert.equal(
            (restartEvent.details as Record<string, unknown>).optional_skill_activation_rebind_fingerprint_sha256,
            refreshedSelectionFingerprintSha256
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-coherent-cycle rebinds advisory optional-skill declines into the refreshed recovery cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-937-restart-coherent-optional-skill-decline-rebind';
        const taskSummary = 'Implement request validation for a Node.js API endpoint';
        seedRemediationRepoBase(repoRoot);
        markAsSourceCheckout(repoRoot);
        writeProtectedControlPlaneManifest(repoRoot);
        seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
        seedTaskQueue(repoRoot, taskId);
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace('Update app flow', taskSummary),
            'utf8'
        );
        seedInitAnswers(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const validate = () => true;\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'api', 'orders.ts'),
            'export const validate = (input: unknown) => Boolean(input);\n',
            'utf8'
        );
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            'restart-coherent-optional-skill-decline-rebind'
        );
        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary,
            plannedChangedFiles: ['src/api/orders.ts'],
            orchestratorWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
        });
        assert.equal(taskModeResult.exitCode, 0, taskModeResult.outputLines.join('\n'));
        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        loadTaskEntryRulePack(repoRoot, taskId, taskModePath);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            taskSummary,
            ['src/api/orders.ts'],
            `${taskId}-preflight.json`,
            taskModePath
        );
        const artifact = writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: taskSummary,
            changedPaths: ['src/api/orders.ts'],
            preflightPath,
            preflightSha256: fileSha256(preflightPath)
        });
        assert.equal(artifact.payload.decision, 'selected_installed_skills');
        assert.equal(artifact.payload.selected_installed_skills[0]?.id, 'node-backend');
        const skillsHeadlinesStatus = runGit(repoRoot, ['status', '--short', '--', OPTIONAL_SKILL_HEADLINES_PATH]).stdout.trim();
        if (skillsHeadlinesStatus) {
            runGit(repoRoot, ['add', OPTIONAL_SKILL_HEADLINES_PATH]);
            runGit(repoRoot, ['commit', '-m', 'test: baseline optional skill headlines']);
        }
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', taskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_DECLINED',
            'INFO',
            'Optional skill declined: node-backend',
            {
                skill_id: 'node-backend',
                pack_id: 'node-backend',
                trigger_reason: 'optional_skill_selection',
                optional_skill_selection_fingerprint_sha256: artifact.payload.selection_fingerprint_sha256,
                reason: 'older sequence with later timestamp'
            }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_DECLINED',
            'INFO',
            'Optional skill declined again: node-backend',
            {
                skill_id: 'node-backend',
                pack_id: 'node-backend',
                trigger_reason: 'optional_skill_selection',
                optional_skill_selection_fingerprint_sha256: artifact.payload.selection_fingerprint_sha256,
                reason: 'newer sequence with earlier timestamp'
            }
        );

        const taskEventsPath = path.join(
            getOrchestratorRoot(repoRoot),
            'runtime',
            'task-events',
            `${taskId}.jsonl`
        );
        const taskEvents = fs.readFileSync(taskEventsPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const declineEvents = taskEvents.filter((event) => (
            event.event_type === 'SKILL_DECLINED'
            && (event.details as Record<string, unknown> | null)?.skill_id === 'node-backend'
        ));
        assert.equal(declineEvents.length, 2);
        declineEvents[0].timestamp_utc = new Date(Date.parse(artifact.payload.timestamp_utc) + 20_000).toISOString();
        declineEvents[1].timestamp_utc = new Date(Date.parse(artifact.payload.timestamp_utc) + 10_000).toISOString();

        let previousEventSha256: string | null = null;
        for (const event of taskEvents) {
            const integrity = event.integrity as Record<string, unknown>;
            integrity.prev_event_sha256 = previousEventSha256;
            integrity.event_sha256 = '';
            const eventSha256 = buildEventIntegrityHash(event);
            assert.ok(eventSha256);
            integrity.event_sha256 = eventSha256;
            previousEventSha256 = eventSha256;
        }
        fs.writeFileSync(
            taskEventsPath,
            taskEvents.map((event) => JSON.stringify(event)).join('\n') + '\n',
            'utf8'
        );

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0, compileResult.outputLines.join('\n'));

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);

        const refreshedOptionalSkillArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-optional-skill-selection.json`),
            'utf8'
        )) as Record<string, unknown>;
        const refreshedSelectionFingerprintSha256 = String(
            refreshedOptionalSkillArtifact.selection_fingerprint_sha256 || ''
        );
        assert.ok(refreshedSelectionFingerprintSha256);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const lastPreflightIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'PREFLIGHT_CLASSIFIED');
        const reboundDeclineIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'SKILL_DECLINED'
            && (event.details as Record<string, unknown> | null)?.skill_id === 'node-backend'
            && (event.details as Record<string, unknown> | null)?.trigger_reason === 'optional_skill_selection'
            && (event.details as Record<string, unknown> | null)?.optional_skill_selection_fingerprint_sha256 === refreshedSelectionFingerprintSha256
        ));
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        assert.ok(lastPreflightIndex >= 0);
        assert.ok(reboundDeclineIndex > lastPreflightIndex);
        assert.ok(lastCompileIndex > reboundDeclineIndex);
        assert.equal(
            (events[reboundDeclineIndex].details as Record<string, unknown>).reason,
            'newer sequence with earlier timestamp'
        );
        const restartEvent = [...events].reverse().find((event) => event.event_type === 'COHERENT_CYCLE_RESTARTED') as Record<string, unknown> | undefined;
        assert.ok(restartEvent, 'coherent restart must persist a passed restart event');
        assert.deepEqual(
            (restartEvent.details as Record<string, unknown>).optional_skill_decline_rebound_skill_ids,
            ['node-backend']
        );
        assert.equal(
            (restartEvent.details as Record<string, unknown>).optional_skill_decline_rebind_fingerprint_sha256,
            refreshedSelectionFingerprintSha256
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rebinds advisory optional-skill declines into the refreshed recovery cycle', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-937-restart-review-optional-skill-decline-rebind';
        const taskSummary = 'Implement request validation for a Node.js API endpoint';
        seedRemediationRepoBase(repoRoot);
        markAsSourceCheckout(repoRoot);
        writeProtectedControlPlaneManifest(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
        seedTaskQueue(repoRoot, taskId);
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace('Update app flow', taskSummary),
            'utf8'
        );
        seedInitAnswers(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const validate = () => true;\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'api', 'orders.ts'),
            'export const validate = (input: unknown) => Boolean(input);\n',
            'utf8'
        );
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            'restart-review-optional-skill-decline-rebind'
        );
        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary,
            plannedChangedFiles: ['src/api/orders.ts'],
            orchestratorWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
        });
        assert.equal(taskModeResult.exitCode, 0, taskModeResult.outputLines.join('\n'));
        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        loadTaskEntryRulePack(repoRoot, taskId, taskModePath);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            taskSummary,
            ['src/api/orders.ts'],
            `${taskId}-preflight.json`,
            taskModePath
        );
        const artifact = writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: taskSummary,
            changedPaths: ['src/api/orders.ts'],
            preflightPath,
            preflightSha256: fileSha256(preflightPath)
        });
        assert.equal(artifact.payload.decision, 'selected_installed_skills');
        assert.equal(artifact.payload.selected_installed_skills[0]?.id, 'node-backend');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', taskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_DECLINED',
            'INFO',
            'Optional skill declined: node-backend',
            {
                skill_id: 'node-backend',
                pack_id: 'node-backend',
                trigger_reason: 'optional_skill_selection',
                optional_skill_selection_fingerprint_sha256: artifact.payload.selection_fingerprint_sha256,
                reason: 'not needed for current implementation'
            }
        );

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0, compileResult.outputLines.join('\n'));
        const postCompileSkillsHeadlinesStatus = runGit(repoRoot, ['status', '--short', '--', OPTIONAL_SKILL_HEADLINES_PATH]).stdout.trim();
        if (postCompileSkillsHeadlinesStatus) {
            runGit(repoRoot, ['add', OPTIONAL_SKILL_HEADLINES_PATH]);
            runGit(repoRoot, ['commit', '-m', 'test: baseline refreshed optional skill headlines']);
        }

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysis: [
                'Reviewer finding: failed review blocker requires a same-task remediation pass for src/api/orders.ts.',
                'Intended fix: refresh the existing request validation file without changing product behavior.',
                'Affected files/contracts: src/api/orders.ts is the affected file; existing contracts stay unchanged.',
                'API/runtime/artifact/test impact: implementation and review evidence must be refreshed for this cycle.',
                'Possible side effects: optional-skill decline evidence must stay bound to the refreshed selection.',
                'Required targeted checks: compile gate and review-cycle optional-skill rebind assertions cover the fix.',
                'Scope or review-type changes: code review must be prepared again for this cycle.',
                'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_CYCLE_RESTARTED/);

        const refreshedOptionalSkillArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-optional-skill-selection.json`),
            'utf8'
        )) as Record<string, unknown>;
        const refreshedSelectionFingerprintSha256 = String(
            refreshedOptionalSkillArtifact.selection_fingerprint_sha256 || ''
        );
        assert.ok(refreshedSelectionFingerprintSha256);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const lastPreflightIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'PREFLIGHT_CLASSIFIED');
        const reboundDeclineIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'SKILL_DECLINED'
            && (event.details as Record<string, unknown> | null)?.skill_id === 'node-backend'
            && (event.details as Record<string, unknown> | null)?.trigger_reason === 'optional_skill_selection'
            && (event.details as Record<string, unknown> | null)?.optional_skill_selection_fingerprint_sha256 === refreshedSelectionFingerprintSha256
        ));
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        assert.ok(lastPreflightIndex >= 0);
        assert.ok(reboundDeclineIndex > lastPreflightIndex);
        assert.ok(lastCompileIndex > reboundDeclineIndex);
        const restartEvent = [...events].reverse().find((event) => event.event_type === 'REVIEW_CYCLE_RESTARTED') as Record<string, unknown> | undefined;
        assert.ok(restartEvent, 'review-cycle restart must persist a passed restart event');
        assert.deepEqual(
            (restartEvent.details as Record<string, unknown>).optional_skill_decline_rebound_skill_ids,
            ['node-backend']
        );
        assert.equal(
            (restartEvent.details as Record<string, unknown>).optional_skill_decline_rebind_fingerprint_sha256,
            refreshedSelectionFingerprintSha256
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not persist coherent-cycle restart success when compile fails', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-compile-failed';
        seedRemediationRepoBase(repoRoot);
        markAsSourceCheckout(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const workflowConfigPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'config',
            'workflow-config.json'
        );
        writeWorkflowConfig(repoRoot);
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as {
            compile_gate?: { command?: string };
        };
        workflowConfig.compile_gate = {
            ...(workflowConfig.compile_gate || {}),
            command: 'node -e "process.exit(1)"'
        };
        fs.writeFileSync(workflowConfigPath, `${JSON.stringify(workflowConfig, null, 2)}\n`, 'utf8');
        writeProtectedControlPlaneManifest(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            `${taskId}-compile-failed`
        );

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart a coherent cycle but fail compile',
            orchestratorWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
        });
        assert.equal(taskModeResult.exitCode, 0, taskModeResult.outputLines.join('\n'));
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts']
        });
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            emitMetrics: false
        });
        const output = restartResult.outputLines.join('\n');
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, output);
        assert.match(output, /COHERENT_CYCLE_RESTART_FAILED/);
        assert.match(output, /compile-gate failed during coherent-cycle restart/);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'COHERENT_CYCLE_RESTARTED'), false);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-coherent-cycle-restart.json`)),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('finalizes an interrupted shell-smoke restart without replaying task mode or compile', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-resume-interrupted-shell-smoke';
        seedRemediationRepoBase(repoRoot);
        markAsSourceCheckout(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            `${taskId}-compile`
        );

        const enterInitial = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed lifecycle boundary before interrupted coherent restart',
            plannedChangedFiles: ['src/app.ts']
        });
        assert.equal(enterInitial.exitCode, 0, enterInitial.outputLines.join('\n'));
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const initialPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Seed lifecycle boundary before interrupted coherent restart',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, initialPreflightPath);
        const initialCompile = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: initialPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(initialCompile.exitCode, 0, initialCompile.outputLines.join('\n'));

        const enterRestart = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Resume interrupted coherent restart',
            plannedChangedFiles: ['src/app.ts']
        });
        assert.equal(enterRestart.exitCode, 0, enterRestart.outputLines.join('\n'));
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SHELL_SMOKE_PREFLIGHT_RECORDED',
            'FAIL',
            'Shell smoke failed during coherent-cycle restart.',
            { passed: false },
            { actor: 'gate' }
        );
        runShellSmokeForTask(repoRoot, taskId);
        const recoveredPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Resume interrupted coherent restart',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, recoveredPreflightPath);
        const recoveredCompile = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: recoveredPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(recoveredCompile.exitCode, 0, recoveredCompile.outputLines.join('\n'));

        const beforeFinalize = readTaskTimelineEvents(repoRoot, taskId);
        const taskModeCount = beforeFinalize.filter((event) => event.event_type === 'TASK_MODE_ENTERED').length;
        const compileCount = beforeFinalize.filter((event) => event.event_type === 'COMPILE_GATE_PASSED').length;

        const finalizeResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath: recoveredPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(finalizeResult.exitCode, 0, finalizeResult.outputLines.join('\n'));
        assert.match(finalizeResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/u);
        const afterFinalize = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            afterFinalize.filter((event) => event.event_type === 'TASK_MODE_ENTERED').length,
            taskModeCount,
            'finalization must not enter task mode again'
        );
        assert.equal(
            afterFinalize.filter((event) => event.event_type === 'COMPILE_GATE_PASSED').length,
            compileCount,
            'finalization must not compile again'
        );
        const restartEvent = [...afterFinalize].reverse().find(
            (event) => event.event_type === 'COHERENT_CYCLE_RESTARTED'
        ) as Record<string, unknown> | undefined;
        assert.ok(restartEvent);
        const restartDetails = restartEvent.details as Record<string, unknown>;
        assert.equal(restartDetails.resumed_interrupted_restart, true);
        assert.equal(
            restartDetails.restart_reason,
            'coherent_cycle_restart_resumed_after_interrupted_shell_smoke'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restarts an ordinary cycle when compile regenerates only the source-checkout publish manifest', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-compile-publish-manifest';
        const taskFile = 'scripts/task-input.ts';
        const manifestFile = 'dist/publish-runtime-manifest.json';
        const manifestPath = path.join(repoRoot, ...manifestFile.split('/'));
        const compileScript =
            "require('node:fs').writeFileSync('dist/publish-runtime-manifest.json', JSON.stringify({version:2})+'\\n')";

        seedRemediationRepoBase(repoRoot);
        markAsSourceCheckout(repoRoot);
        const workflowConfigPath = writeWorkflowConfig(repoRoot);
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as {
            compile_gate: { command: string };
        };
        workflowConfig.compile_gate.command = `node -e "${compileScript}"`;
        fs.writeFileSync(workflowConfigPath, `${JSON.stringify(workflowConfig, null, 2)}\n`, 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, ...taskFile.split('/')), 'export const value = 1;\n', 'utf8');
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(manifestPath, '{"version":1}\n', 'utf8');
        writeProtectedControlPlaneManifest(repoRoot);
        fs.writeFileSync(
            path.join(repoRoot, '.gitignore'),
            'TASK.md\ngarda-agent-orchestrator/runtime/\n',
            'utf8'
        );
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            `${taskId}-ordinary`
        );

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart ordinary compile-generated manifest cycle'
        });
        assert.equal(taskModeResult.exitCode, 0, taskModeResult.outputLines.join('\n'));
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.writeFileSync(path.join(repoRoot, ...taskFile.split('/')), 'export const value = 2;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart ordinary compile-generated manifest cycle',
            [taskFile]
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/u);
        const compileEvidence = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        ) as Record<string, any>;
        assert.deepEqual(
            compileEvidence.compile_generated_protected_artifacts?.changed_files,
            [manifestFile]
        );
        assert.equal(
            compileEvidence.compile_generated_protected_artifacts?.entries?.[0]?.after_sha256,
            fileSha256(manifestPath)
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects protected coherent-cycle restart without operator confirmation', async () => {
        const fixture = prepareProtectedCoherentRestartFixture('T-903a-restart-coherent-cycle-missing-approval');

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot: fixture.repoRoot,
            taskId: fixture.taskId,
            preflightPath: fixture.preflightPath,
            commandsPath: fixture.commandsPath,
            outputFiltersPath: fixture.outputFiltersPath,
            emitMetrics: false
        });
        const output = restartResult.outputLines.join('\n');
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, output);
        assert.match(output, /COHERENT_CYCLE_RESTART_FAILED/);
        assert.match(output, /enter-task-mode --orchestrator-work requires explicit operator confirmation/);
        assert.match(output, /--operator-confirmed yes/);
        assert.match(output, /--operator-confirmed-at-utc "<ISO-8601 timestamp>"/);

        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    });

    it('rejects protected coherent-cycle restart with stale operator confirmation', async () => {
        const fixture = prepareProtectedCoherentRestartFixture('T-903a-restart-coherent-cycle-stale-approval');
        const staleConfirmation = new Date(Date.now() - 11 * 60 * 1000).toISOString();

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot: fixture.repoRoot,
            taskId: fixture.taskId,
            preflightPath: fixture.preflightPath,
            commandsPath: fixture.commandsPath,
            outputFiltersPath: fixture.outputFiltersPath,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: staleConfirmation,
            emitMetrics: false
        });
        const output = restartResult.outputLines.join('\n');
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, output);
        assert.match(output, /COHERENT_CYCLE_RESTART_FAILED/);
        assert.match(output, /enter-task-mode --orchestrator-work operator confirmation is stale/);

        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    });

    it('restarts a coherent cycle for same-task workflow-config work without laundering the baseline hash', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-workflow-config';
        const workflowConfigPath = 'garda-agent-orchestrator/live/config/workflow-config.json';
        const taskSummary = 'Restart approved workflow-config policy changes after a closed cycle';
        seedRemediationRepoBase(repoRoot);
        markAsSourceCheckout(repoRoot);
        writeWorkflowConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
            `| ${taskId} | TODO | P1 | workflow | Update workflow-config policy changes | unassigned | 2026-03-28 | default | Owns workflow-config policy changes. |`
        ].join('\n'), 'utf8');
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);
        writeProtectedControlPlaneManifest(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            'restart-coherent-cycle-workflow-config'
        );

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary,
            orchestratorWork: true,
            workflowConfigWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            plannedChangedFiles: [workflowConfigPath]
        });
        assert.equal(taskModeResult.exitCode, 0);
        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const initialTaskModeArtifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as {
            workflow_config_file_hashes?: Record<string, string | null>;
        };
        const originalWorkflowConfigHash = initialTaskModeArtifact.workflow_config_file_hashes?.[workflowConfigPath];
        assert.equal(typeof originalWorkflowConfigHash, 'string');

        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const workflowConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, workflowConfigPath), 'utf8')) as {
            review_execution_policy: { mode: string };
        };
        workflowConfig.review_execution_policy.mode = 'strict_sequential';
        fs.writeFileSync(path.join(repoRoot, workflowConfigPath), JSON.stringify(workflowConfig, null, 2) + '\n', 'utf8');
        const currentWorkflowConfigHash = getCurrentWorkflowConfigFileHashes(repoRoot)[workflowConfigPath];
        assert.notEqual(currentWorkflowConfigHash, originalWorkflowConfigHash);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            taskSummary,
            [workflowConfigPath],
            `${taskId}-preflight.json`,
            taskModePath
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', taskModePath);
        const initialCompileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(initialCompileResult.exitCode, 0, initialCompileResult.outputLines.join('\n'));
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_GATE_PASSED',
            'PASS',
            'Review gate passed before coherent restart.',
            {}
        );

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);

        const refreshedTaskModeArtifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as {
            workflow_config_file_hashes?: Record<string, string | null>;
        };
        assert.equal(refreshedTaskModeArtifact.workflow_config_file_hashes?.[workflowConfigPath], originalWorkflowConfigHash);
        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as {
            triggers?: { changed_workflow_config_files?: string[] };
        };
        assert.deepEqual(refreshedPreflight.triggers?.changed_workflow_config_files, [workflowConfigPath]);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restarts source template workflow-config work only when the previous preflight hash still matches', async () => {
        const workflowConfigPath = 'template/config/workflow-config.json';
        const fixture = await prepareApprovedWorkflowConfigRestartFixture({
            taskId: 'T-903a-restart-coherent-cycle-source-template-config',
            workflowConfigPath
        });

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot: fixture.repoRoot,
            taskId: fixture.taskId,
            taskModePath: fixture.taskModePath,
            preflightPath: fixture.preflightPath,
            commandsPath: fixture.commandsPath,
            outputFiltersPath: fixture.outputFiltersPath,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);

        const refreshedTaskModeArtifact = JSON.parse(fs.readFileSync(fixture.taskModePath, 'utf8')) as {
            workflow_config_file_hashes?: Record<string, string | null>;
        };
        assert.equal(refreshedTaskModeArtifact.workflow_config_file_hashes?.[workflowConfigPath], fixture.originalWorkflowConfigHash);
        const refreshedPreflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as {
            triggers?: { changed_workflow_config_files?: string[] };
        };
        assert.deepEqual(refreshedPreflight.triggers?.changed_workflow_config_files, [workflowConfigPath]);

        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    });

    it('rejects restart when same-task workflow-config content changed after the previous preflight binding', async () => {
        const workflowConfigPath = 'template/config/workflow-config.json';
        const fixture = await prepareApprovedWorkflowConfigRestartFixture({
            taskId: 'T-903a-restart-coherent-cycle-stale-template-config',
            workflowConfigPath
        });
        setWorkflowConfigReviewExecutionMode(fixture.repoRoot, workflowConfigPath, 'parallel_all');
        assert.notEqual(getCurrentWorkflowConfigFileHashes(fixture.repoRoot)[workflowConfigPath], fixture.approvedWorkflowConfigHash);

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot: fixture.repoRoot,
            taskId: fixture.taskId,
            taskModePath: fixture.taskModePath,
            preflightPath: fixture.preflightPath,
            commandsPath: fixture.commandsPath,
            outputFiltersPath: fixture.outputFiltersPath,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            emitMetrics: false
        });
        const output = restartResult.outputLines.join('\n');
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, output);
        assert.match(output, /COHERENT_CYCLE_RESTART_FAILED/);
        assert.match(output, /Workspace already contains workflow config changes before task-mode entry/);
        assert.match(output, /template\/config\/workflow-config\.json/);

        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    });

    it('rejects restart when a foreign workflow-config file drifts outside the previous preflight binding', async () => {
        const workflowConfigPath = 'template/config/workflow-config.json';
        const foreignWorkflowConfigPath = 'garda-agent-orchestrator/template/config/workflow-config.json';
        const fixture = await prepareApprovedWorkflowConfigRestartFixture({
            taskId: 'T-903a-restart-coherent-cycle-foreign-template-config',
            workflowConfigPath,
            extraWorkflowConfigPaths: [foreignWorkflowConfigPath]
        });
        setWorkflowConfigReviewExecutionMode(fixture.repoRoot, foreignWorkflowConfigPath, 'parallel_all');

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot: fixture.repoRoot,
            taskId: fixture.taskId,
            taskModePath: fixture.taskModePath,
            preflightPath: fixture.preflightPath,
            commandsPath: fixture.commandsPath,
            outputFiltersPath: fixture.outputFiltersPath,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            emitMetrics: false
        });
        const output = restartResult.outputLines.join('\n');
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, output);
        assert.match(output, /COHERENT_CYCLE_RESTART_FAILED/);
        assert.match(output, /Workspace already contains workflow config changes before task-mode entry/);
        assert.match(output, /garda-agent-orchestrator\/template\/config\/workflow-config\.json/);

        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    });

    it('restarts a coherent cycle from a false-DONE legacy task-mode artifact without forcing a new start banner', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-legacy-task-mode';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'DONE');
        seedInitAnswers(repoRoot);

        fs.mkdirSync(getReviewsRoot(repoRoot), { recursive: true });
        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const profilePolicySnapshot = buildTaskProfilePolicySnapshot(
            getOrchestratorRoot(repoRoot),
            'balanced',
            {
                reviewExecutionPolicyMode: 'code_first_optional',
                reviewExecutionPolicyConfigured: true,
                lockTimestampUtc: '2026-04-16T09:00:00.000Z'
            }
        );
        fs.writeFileSync(taskModePath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Restart a coherent cycle from a legacy task-mode artifact after upgrade',
            workflow_config_file_hashes: getCurrentWorkflowConfigFileHashes(repoRoot),
            profile_policy_snapshot_required: true,
            profile_policy_snapshot: profilePolicySnapshot,
            provider: 'Codex',
            routed_to: 'AGENTS.md'
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Legacy task-mode entry before restart.', {
            artifact_path: taskModePath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Restart a coherent cycle from a legacy task-mode artifact after upgrade',
            provider: 'Codex',
            routed_to: 'AGENTS.md',
            profile_policy_snapshot_required: true,
            profile_policy_snapshot_hash: profilePolicySnapshot.snapshot_hash,
            profile_policy_snapshot_config_hash: profilePolicySnapshot.config_hash
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
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle-legacy.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const taskModeEnteredEvents = events.filter((event) => event.event_type === 'TASK_MODE_ENTERED');
        assert.equal(taskModeEnteredEvents.length, 2);
        const latestTaskModeEvent = taskModeEnteredEvents[taskModeEnteredEvents.length - 1];
        assert.equal(String((latestTaskModeEvent.details as Record<string, unknown> | undefined)?.start_banner || ''), '');

        const refreshedTaskModeArtifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        assert.equal(String(refreshedTaskModeArtifact.start_banner || ''), '');
        const taskQueueText = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        assert.match(taskQueueText, new RegExp(`\\| ${escapeRegExp(taskId)} \\| [^|]*IN_PROGRESS`));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle reuses the latest coherent restart floor for legacy task-mode artifacts after an older review pass', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-legacy-coherent-floor';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-legacy-coherent-floor');
        writeProtectedControlPlaneManifest(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        fs.mkdirSync(getReviewsRoot(repoRoot), { recursive: true });
        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const profilePolicySnapshot = buildTaskProfilePolicySnapshot(
            getOrchestratorRoot(repoRoot),
            'balanced',
            {
                reviewExecutionPolicyMode: 'legacy_test_downstream',
                reviewExecutionPolicyConfigured: false,
                lockTimestampUtc: '2026-04-16T09:00:00.000Z'
            }
        );
        fs.writeFileSync(taskModePath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Restart the review cycle after a coherent restart from a legacy task-mode artifact',
            workflow_config_file_hashes: getCurrentWorkflowConfigFileHashes(repoRoot),
            profile_policy_snapshot_required: true,
            profile_policy_snapshot: profilePolicySnapshot,
            provider: 'Codex',
            routed_to: 'AGENTS.md'
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Legacy task-mode entry before restart.', {
            artifact_path: taskModePath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Restart the review cycle after a coherent restart from a legacy task-mode artifact',
            provider: 'Codex',
            routed_to: 'AGENTS.md',
            profile_policy_snapshot_required: true,
            profile_policy_snapshot_hash: profilePolicySnapshot.snapshot_hash,
            profile_policy_snapshot_config_hash: profilePolicySnapshot.config_hash
        });

        loadTaskEntryRulePack(repoRoot, taskId, taskModePath);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the review cycle after a coherent restart from a legacy task-mode artifact',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            taskModePath
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', taskModePath);

        const initialCompileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(initialCompileResult.exitCode, 0);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_GATE_PASSED',
            'PASS',
            'Legacy review gate passed before coherent restart.',
            {}
        );

        const coherentRestartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(coherentRestartResult.exitCode, 0, coherentRestartResult.outputLines.join('\n'));
        assert.match(coherentRestartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);

        const reviewRestartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewRestartResult.exitCode, 0, reviewRestartResult.outputLines.join('\n'));
        const output = reviewRestartResult.outputLines.join('\n');
        assert.equal(reviewRestartResult.outputLines[0], 'Next action:');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /PreparedReviewTypes: none/);
        assert.match(output, /LaunchRequiredReviewTypes: none/);
        assert.match(output, /PendingReviewTypes: code/);
        assert.match(output, /PendingReason: Review context cannot be built because required trust-boundary analysis is/);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const taskModeEnteredEvents = events.filter((event) => event.event_type === 'TASK_MODE_ENTERED');
        const taskEntryRulePackIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (
                event.event_type === 'RULE_PACK_LOADED'
                && String((event.details as Record<string, unknown> | undefined)?.stage || '').toUpperCase() === 'TASK_ENTRY'
            ) {
                indexes.push(index);
            }
            return indexes;
        }, []);
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
        const reviewGateIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'REVIEW_GATE_PASSED');
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCodeReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.equal(taskModeEnteredEvents.length, 2);
        assert.equal(taskEntryRulePackIndexes.length, 2);
        assert.equal(handshakeIndexes.length, 2);
        assert.equal(shellSmokeIndexes.length, 2);
        assert.ok(reviewGateIndex > taskEntryRulePackIndexes[0]);
        assert.ok(taskEntryRulePackIndexes[1] > reviewGateIndex);
        assert.ok(lastCompileIndex > shellSmokeIndexes[1]);
        assert.equal(lastCodeReviewPhaseIndex, -1);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('replays a prior git_auto scope as explicit changed files during coherent-cycle restart', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-git-auto';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'noise.md'), 'unrelated dirty file\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_auto',
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
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle-git-auto.md');
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
            taskSummary: 'Replay prior git_auto scope as explicit changed files during cycle restart'
        });

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0);
        const restartOutput = restartResult.outputLines.join('\n');
        assert.match(restartOutput, /^  Command: node garda-agent-orchestrator\/bin\/garda\.js next-step "T-903a-restart-coherent-cycle-git-auto" --repo-root "\."$/mu);
        assert.match(restartOutput, /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('preserves git-auto zero-diff no-review classification during coherent-cycle restart', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-git-auto-zero';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.mkdirSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'skills', 'code-review'),
            { recursive: true }
        );
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'skills', 'code-review', 'SKILL.md'),
            '# code-review fixture\n',
            'utf8'
        );
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const preflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_auto',
            metrics: { changed_lines_total: 0, changed_files_count: 0 },
            changed_files: [],
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
            },
            zero_diff_guard: {
                zero_diff_detected: true,
                status: 'BASELINE_ONLY',
                completion_requires_audited_no_op: true,
                no_op_artifact_suffix: '-no-op.json',
                rationale: 'Preflight on a clean workspace is baseline-only.'
            }
        });
        const commandsPath = path.join(
            getOrchestratorRoot(repoRoot),
            'runtime',
            'commands-restart-coherent-cycle-git-auto-zero.md'
        );
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
            taskSummary: 'Replay zero-diff git_auto scope during cycle restart'
        });

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: git_auto_current_workspace/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.equal(refreshedPreflight.detection_source, 'git_auto');
        assert.deepEqual(refreshedPreflight.changed_files, []);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).code, false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('preserves approved task-plan metadata when coherent-cycle restart re-enters task mode', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-plan';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_auto',
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
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle-plan.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const plan = validateTaskPlan({
            schema_version: 1,
            task_id: taskId,
            status: 'approved',
            goal: 'Restart the latest coherent task cycle safely',
            scope_files: ['src/app.ts'],
            risk_level: 'low',
            steps: [{ id: 'step-1', title: 'Replay the coherent cycle', files: ['src/app.ts'] }]
        });
        const planPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-plan.json`);
        fs.writeFileSync(planPath, serializeTaskPlan(plan), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart the latest coherent cycle with approved plan metadata preserved',
            planPath,
            emitMetrics: false
        });

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0);

        const taskModeArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`), 'utf8')
        ) as Record<string, unknown>;
        const planMetadata = taskModeArtifact.plan as Record<string, unknown> | null;
        assert.ok(planMetadata);
        assert.equal(planMetadata?.plan_path, planPath.replace(/\\/g, '/'));
        assert.equal(typeof planMetadata?.plan_sha256, 'string');
        assert.equal(planMetadata?.plan_summary, 'Restart the latest coherent task cycle safely');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle refreshes the current diff and prepares only upstream reviews when downstream test review is still blocked', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-code-only';
        seedRemediationRepoBase(repoRoot);
        markAsSourceCheckout(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-code-only');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart only the review cycle after a failed code review',
            plannedChangedFiles: [
                'commands-restart-review-cycle-code-only.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart only the review cycle after a failed code review',
            ['src/app.ts', 'tests/app.test.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        runPassingTrustBoundaryQualityChecklist({
            repoRoot,
            taskId,
            preflightPath,
            evidenceFiles: ['src/app.ts', 'tests/app.test.ts']
        });

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);
        const fullSuiteResult = await runFullSuiteValidationCommand({
            repoRoot,
            taskId,
            preflightPath
        });
        assert.equal(fullSuiteResult.exitCode, 0, fullSuiteResult.outputText);
        const codeReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        const initialContextResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.equal(initialContextResult.reusedReviewEvidence, false);
        const reviewerLaunchArtifactPath = path.join(
            getOrchestratorRoot(repoRoot),
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            'reviewer-launch.json'
        );
        await handleRecordReviewRouting([
            '--task-id', taskId,
            '--review-type', 'code',
            '--review-context-path', codeReviewContextPath,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--repo-root', repoRoot
        ]);
        await handlePrepareReviewerLaunch([
            '--task-id', taskId,
            '--review-type', 'code',
            '--review-context-path', codeReviewContextPath,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-launch-artifact-path', reviewerLaunchArtifactPath,
            '--repo-root', repoRoot
        ]);
        const preparedLaunchArtifact = JSON.parse(
            fs.readFileSync(reviewerLaunchArtifactPath, 'utf8')
        ) as Record<string, unknown>;
        const rejectedReviewerLaunchAttemptId = String(preparedLaunchArtifact.reviewer_launch_attempt_id || '');
        const rejectedReviewOutputPath = String(preparedLaunchArtifact.review_output_path || '');
        const reviewerLaunchInputArtifactPath = String(
            preparedLaunchArtifact.reviewer_launch_input_artifact_path || ''
        );
        const reviewerLaunchInputArtifactSha256 = fileSha256(reviewerLaunchInputArtifactPath);
        assert.ok(
            reviewerLaunchInputArtifactSha256,
            'prepared reviewer launch input artifact must exist before delegation starts'
        );
        const rejectedReviewerIdentity = 'agent:integration-code-reviewer';
        const rejectedProviderInvocationId = 'multi_agent_v1:integration-code-reviewer';
        const launchAttestationArgs = [
            '--task-id', taskId,
            '--review-type', 'code',
            '--review-context-path', codeReviewContextPath,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', rejectedReviewerIdentity,
            '--reviewer-launch-artifact-path', reviewerLaunchArtifactPath,
            '--provider-invocation-id', rejectedProviderInvocationId,
            '--attestation-source', 'multi_agent_v1.spawn_agent',
            '--launch-input-mode', 'launch_artifact_path',
            '--launch-input-artifact-path', reviewerLaunchInputArtifactPath,
            '--launch-input-sha256', reviewerLaunchInputArtifactSha256,
            '--fork-context', 'false',
            '--repo-root', repoRoot
        ];
        await handleRecordReviewerDelegationStarted(launchAttestationArgs);
        fs.writeFileSync(rejectedReviewOutputPath, '{ malformed reviewer output\n', 'utf8');
        await handleCompleteReviewerLaunch([...launchAttestationArgs, '--record-invocation']);
        await assert.rejects(
            () => handleRecordReviewResult([
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-context-path', codeReviewContextPath,
                '--review-output-path', rejectedReviewOutputPath,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', rejectedReviewerIdentity,
                '--repo-root', repoRoot
            ]),
            /Verdict-free findings JSON report is invalid/u
        );
        const rejectedLaunchArtifact = JSON.parse(
            fs.readFileSync(reviewerLaunchArtifactPath, 'utf8')
        ) as Record<string, unknown>;
        assert.equal(rejectedLaunchArtifact.attestation_state, 'launched');
        assert.equal(rejectedLaunchArtifact.launch_failure_stage, undefined);
        const reportCorrectionRoute = resolveNextStep({ taskId, repoRoot });
        assert.equal(reportCorrectionRoute.next_gate, 'restart-review-cycle', reportCorrectionRoute.reason);
        assert.match(reportCorrectionRoute.reason, /cannot safely continue/u);

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysis: [
                'Reviewer finding: failed review blocker requires a same-task remediation pass for src/app.ts and tests/app.test.ts.',
                'Intended fix: refresh the changed implementation and test files without changing product behavior.',
                'Affected files/contracts: src/app.ts and tests/app.test.ts are the affected files; existing contracts stay unchanged.',
                'API/runtime/artifact/test impact: implementation and test evidence must be refreshed for this cycle.',
                'Possible side effects: review reuse must fail closed if unrelated behavior changes appear.',
                'Required targeted checks: compile gate and upstream code review context assertions cover the fix.',
                'Scope or review-type changes: test review stays blocked until code review passes for this cycle.',
                'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.equal(restartResult.outputLines[0], 'Next action:');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /PreparedReviewTypes: none/);
        assert.match(output, /LaunchRequiredReviewTypes: none/);
        assert.match(output, /PendingReviewTypes: code, security, refactor, test/);
        assert.match(output, /PendingReason: Review context cannot be built because required trust-boundary analysis is/);

        runPassingTrustBoundaryQualityChecklist({
            repoRoot,
            taskId,
            preflightPath,
            evidenceFiles: ['src/app.ts', 'tests/app.test.ts']
        });
        const refreshedContextResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.equal(refreshedContextResult.reusedReviewEvidence, false);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            true
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            false
        );

        await handleRecordReviewRouting([
            '--task-id', taskId,
            '--review-type', 'code',
            '--review-context-path', codeReviewContextPath,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--repo-root', repoRoot
        ]);
        await handlePrepareReviewerLaunch([
            '--task-id', taskId,
            '--review-type', 'code',
            '--review-context-path', codeReviewContextPath,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-launch-artifact-path', reviewerLaunchArtifactPath,
            '--repo-root', repoRoot
        ]);
        const freshLaunchArtifact = JSON.parse(
            fs.readFileSync(reviewerLaunchArtifactPath, 'utf8')
        ) as Record<string, unknown>;
        assert.equal(freshLaunchArtifact.attestation_state, 'prepared');
        assert.notEqual(
            freshLaunchArtifact.reviewer_launch_attempt_id,
            rejectedReviewerLaunchAttemptId,
            'restart recovery must prepare one fresh attempt instead of reusing the rejected output'
        );
        assert.notEqual(
            freshLaunchArtifact.review_output_path,
            rejectedReviewOutputPath,
            'restart recovery must not route the fresh attempt back to the rejected output path'
        );

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
        const firstCompileIndex = events.findIndex((event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCodeReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        const lastTestReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        ));
        const lastHandshakeIndex = handshakeIndexes.at(-1) ?? -1;
        const lastShellSmokeIndex = shellSmokeIndexes.at(-1) ?? -1;
        assert.ok(lastCompileIndex >= 0);
        assert.equal(handshakeIndexes.length, 2);
        assert.equal(shellSmokeIndexes.length, 2);
        assert.ok(firstCompileIndex >= 0);
        assert.ok(firstCompileIndex > handshakeIndexes[0]);
        assert.ok(shellSmokeIndexes[0] > handshakeIndexes[0]);
        assert.ok(lastShellSmokeIndex > lastHandshakeIndex);
        assert.ok(lastCompileIndex > lastShellSmokeIndex);
        assert.ok(lastCodeReviewPhaseIndex === -1 || lastCodeReviewPhaseIndex > lastCompileIndex);
        assert.equal(lastTestReviewPhaseIndex, -1);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle blocks API review behind code under an explicit code_first_optional policy', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-api-after-code';
        seedRemediationRepoBase(repoRoot);
        writeWorkflowConfig(repoRoot, 'code_first_optional');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'routes'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'routes', 'app.ts'), 'export function handleAppRoute() { return "ok"; }\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-api-after-code');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle with API review blocked behind code by explicit policy',
            plannedChangedFiles: [
                'commands-restart-review-cycle-api-after-code.md',
                'src/routes/app.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle with API review blocked behind code by explicit policy',
            ['src/routes/app.ts']
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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysis: [
                'Reviewer finding: failed review blocker changes the public API surface in src/routes/app.ts.',
                'Intended fix: update the exported route API contract in src/routes/app.ts and refresh review evidence.',
                'Affected files/contracts: src/routes/app.ts is the affected file and its public API contract changes.',
                'API/runtime/artifact/test impact: public API surface changes require code review before API review.',
                'Possible side effects: downstream route callers may rely on the previous exported contract.',
                'Required targeted checks: compile gate and review-cycle dependency assertions cover the fix.',
                'Scope or review-type changes: API review remains blocked until code review passes in this policy.',
                'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /ReviewExecutionPolicy: code_first_optional/);
        assert.match(output, /PreparedReviewTypes: none/);
        assert.match(output, /LaunchRequiredReviewTypes: none/);
        assert.match(output, /PendingReviewTypes: code, security, refactor, api/);
        assert.match(output, /PendingReason: Review context cannot be built because required trust-boundary analysis is/);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            false
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-api-review-context.json`)),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle keeps legacy compatibility when review_execution_policy is still omitted', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-legacy-compat';
        seedRemediationRepoBase(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            JSON.stringify({
                compile_gate: {
                    command: 'node -e "console.log(\'build ok\')"'
                },
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }, null, 2) + '\n',
            'utf8'
        );
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'routes'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'routes', 'app.ts'), 'export function handleAppRoute() { return "ok"; }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-legacy-compat');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle with legacy compatibility while review_execution_policy is still omitted',
            plannedChangedFiles: [
                'commands-restart-review-cycle-legacy-compat.md',
                'src/routes/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle with legacy compatibility while review_execution_policy is still omitted',
            ['src/routes/app.ts', 'tests/app.test.ts']
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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /ReviewExecutionPolicy: legacy_test_downstream/);
        assert.match(output, /PreparedReviewTypes: none/);
        assert.match(output, /LaunchRequiredReviewTypes: none/);
        assert.match(output, /PendingReviewTypes: code, security, refactor, test/);
        assert.match(output, /PendingReason: Review context cannot be built because required trust-boundary analysis is/);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            false
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-api-review-context.json`)),
            false
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle defers code, API, and test preparation until trust-boundary analysis under parallel_all policy', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-parallel-all';
        seedRemediationRepoBase(repoRoot);
        writeWorkflowConfig(repoRoot, 'parallel_all');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'routes'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'routes', 'app.ts'), 'export function handleAppRoute() { return "ok"; }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-parallel-all');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle with all required reviews independent under parallel_all',
            plannedChangedFiles: [
                'commands-restart-review-cycle-parallel-all.md',
                'src/routes/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle with all required reviews independent under parallel_all',
            ['src/routes/app.ts', 'tests/app.test.ts']
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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /ReviewExecutionPolicy: parallel_all/);
        assert.match(output, /PreparedReviewTypes: none/);
        assert.match(output, /LaunchRequiredReviewTypes: none/);
        assert.match(output, /PendingReviewTypes: code, security, refactor, test/);
        assert.match(output, /PendingReason: Review context cannot be built because required trust-boundary analysis is/);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            false
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-api-review-context.json`)),
            false
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            false
        );
        const timelineEvents = readTaskTimelineEvents(repoRoot, taskId);
        const reviewPhaseEvents = timelineEvents.filter((event) => event.event_type === 'REVIEW_PHASE_STARTED');
        const selectedEvents = timelineEvents.filter((event) => event.event_type === 'SKILL_SELECTED');
        const referenceEvents = timelineEvents.filter((event) => event.event_type === 'SKILL_REFERENCE_LOADED');
        assert.deepEqual(reviewPhaseEvents, []);
        assert.deepEqual(selectedEvents, []);
        assert.equal(
            referenceEvents.filter((event) => (
                String((event.details as Record<string, unknown>).trigger_reason) === 'review_context_artifact'
            )).length,
            0
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle defers performance review preparation until trust-boundary analysis under parallel_all', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-parallel-all-performance';
        seedRemediationRepoBase(repoRoot);
        writeWorkflowConfig(repoRoot, 'parallel_all');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'routes'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'routes', 'heavy.ts'),
            Array.from({ length: 160 }, (_, index) => `export const route_${index} = ${index};`).join('\n') + '\n',
            'utf8'
        );
        fs.writeFileSync(path.join(repoRoot, 'tests', 'heavy.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-parallel-all-performance');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle with performance required under parallel_all',
            plannedChangedFiles: [
                'commands-restart-review-cycle-parallel-all-performance.md',
                'src/routes/heavy.ts',
                'tests/heavy.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle with performance required under parallel_all',
            ['src/routes/heavy.ts', 'tests/heavy.test.ts']
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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /ReviewExecutionPolicy: parallel_all/);
        assert.match(output, /PreparedReviewTypes: none/);
        assert.match(output, /LaunchRequiredReviewTypes: none/);
        assert.match(output, /PendingReviewTypes: code, security, refactor, performance, test/);
        assert.match(output, /PendingReason: Review context cannot be built because required trust-boundary analysis is/);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-performance-review-context.json`)),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle keeps test downstream of code while leaving API independent under test_after_code policy', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-test-after-code';
        seedRemediationRepoBase(repoRoot);
        writeWorkflowConfig(repoRoot, 'test_after_code');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'routes'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'routes', 'app.ts'), 'export function handleAppRoute() { return "ok"; }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-test-after-code');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle with test blocked only behind code under test_after_code',
            plannedChangedFiles: [
                'commands-restart-review-cycle-test-after-code.md',
                'src/routes/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle with test blocked only behind code under test_after_code',
            ['src/routes/app.ts', 'tests/app.test.ts']
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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /ReviewExecutionPolicy: test_after_code/);
        assert.match(output, /PreparedReviewTypes: none/);
        assert.match(output, /LaunchRequiredReviewTypes: none/);
        assert.match(output, /PendingReviewTypes: code, security, refactor, test/);
        assert.match(output, /PendingReason: Review context cannot be built because required trust-boundary analysis is/);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            false
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-api-review-context.json`)),
            false
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle serializes downstream review preparation under strict_sequential policy', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-strict-sequential';
        seedRemediationRepoBase(repoRoot);
        writeWorkflowConfig(repoRoot, 'strict_sequential');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'routes'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'routes', 'app.ts'), 'export function handleAppRoute() { return "ok"; }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-strict-sequential');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle with downstream reviews serialized under strict_sequential',
            plannedChangedFiles: [
                'commands-restart-review-cycle-strict-sequential.md',
                'src/routes/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle with downstream reviews serialized under strict_sequential',
            ['src/routes/app.ts', 'tests/app.test.ts']
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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /ReviewExecutionPolicy: strict_sequential/);
        assert.match(output, /PreparedReviewTypes: none/);
        assert.match(output, /LaunchRequiredReviewTypes: none/);
        assert.match(output, /PendingReviewTypes: code, security, refactor, test/);
        assert.match(output, /PendingReason: Review context cannot be built because required trust-boundary analysis is/);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            false
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-api-review-context.json`)),
            false
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle persists recovery before a stale mandatory trust-boundary checklist is refreshed', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-969-restart-review-cycle-trust-prerequisite';
        const taskSummary = 'Require trust-boundary analysis for reviewer security controls';
        seedRemediationRepoBase(repoRoot);
        writeWorkflowConfig(repoRoot, 'strict_sequential');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'gates'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'gates', 'review-control.ts'), 'export const reviewControl = true;\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            'restart-review-cycle-trust-prerequisite'
        );

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary,
            plannedChangedFiles: [
                'commands-restart-review-cycle-trust-prerequisite.md',
                'src/gates/review-control.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            taskSummary,
            ['src/gates/review-control.ts']
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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/u);
        assert.match(output, /review_contexts=partially_prepared_prerequisite_blocked/u);
        assert.match(output, /mandatory trust-boundary checklist/u);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-review-cycle-restart.json`)),
            true
        );
        const nextStep = resolveNextStep({ taskId, repoRoot });
        assert.notEqual(nextStep.next_gate, 'restart-coherent-cycle', nextStep.reason);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restarts the latest coherent cycle with a custom task-mode artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-custom-task-mode';
        const customTaskModePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'custom-artifacts',
            `${taskId}-task-mode.json`
        );
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle-custom-task-mode.md');
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
            artifactPath: customTaskModePath,
            taskSummary: 'Restart the latest coherent cycle with a custom task-mode artifact path'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the latest coherent cycle with a custom task-mode artifact path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const output = restartResult.outputLines.join('\n');
        assert.match(output, /COHERENT_CYCLE_RESTARTED/);
        assert.match(
            output,
            new RegExp(escapeRegExp(customTaskModePath.replace(/\\/g, '/')))
        );
        assert.match(output, /PreflightSummary: mode=/);
        assert.match(output, /scope_category=/);
        assert.match(output, /changed_files=1/);
        assert.match(output, /required_reviews=/);
        assert.match(output, /\(full detail: see PreflightPath\)/);
        assert.doesNotMatch(output, /PreflightSummary: \{/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle refreshes the current diff with a custom task-mode artifact path', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-custom-task-mode';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-custom-task-mode');

        runEnterTaskMode({
            repoRoot,
            taskId,
            artifactPath: customTaskModePath,
            taskSummary: 'Restart the review cycle with a custom task-mode artifact path',
            provider: 'Codex',
            plannedChangedFiles: [
                'commands-restart-review-cycle-custom-task-mode.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the review cycle with a custom task-mode artifact path',
            ['src/app.ts', 'tests/app.test.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /PreparedReviewTypes: none/);
        assert.match(output, /LaunchRequiredReviewTypes: none/);
        assert.match(output, /PendingReviewTypes: code, security, refactor, test/);
        assert.match(output, /PendingReason: Review context cannot be built because required trust-boundary analysis is/);
        assert.match(output, /PreflightSummary: mode=/);
        assert.match(output, /scope_category=/);
        assert.match(output, /changed_files=2/);
        assert.match(output, /required_reviews=code, refactor, security, test/);
        assert.match(output, /\(full detail: see PreflightPath\)/);
        assert.doesNotMatch(output, /PreflightSummary: \{/);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const restartEvent = [...events].reverse().find((event) => event.event_type === 'REVIEW_CYCLE_RESTARTED') as Record<string, unknown> | undefined;
        assert.ok(restartEvent, 'review-cycle restart must persist a task event after compile pass');
        const restartDetails = restartEvent.details as Record<string, unknown>;
        const restartArtifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-review-cycle-restart.json`);
        const compileEvidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const remediationArtifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`);
        assert.match(output, new RegExp(`DetailsPath: ${escapeRegExp(normalizePath(restartArtifactPath))}`, 'u'));
        assert.equal(restartDetails.restart_event_schema_version, 1);
        assert.equal(restartDetails.task_id, taskId);
        assert.equal(restartDetails.event_type, 'REVIEW_CYCLE_RESTARTED');
        assert.equal(restartDetails.task_mode_sha256, fileSha256(customTaskModePath));
        assert.equal(restartDetails.preflight_sha256, fileSha256(preflightPath));
        assert.equal(restartDetails.compile_evidence_sha256, fileSha256(compileEvidencePath));
        assert.equal(restartDetails.restart_artifact_sha256, fileSha256(restartArtifactPath));
        assert.equal(restartDetails.remediation_artifact_sha256, fileSha256(remediationArtifactPath));
        assert.deepEqual(restartDetails.prepared_review_types, []);
        assert.deepEqual(restartDetails.launch_required_review_types, []);
        assert.equal(fs.existsSync(restartArtifactPath), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle escalates to restart-coherent-cycle after a prior review gate closed the latest cycle', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-after-review-gate';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 4;\nconsole.log(a + b);\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-after-review-gate');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart the review cycle after a prior review gate already closed the last cycle',
            plannedChangedFiles: [
                'commands-restart-review-cycle-after-review-gate.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the review cycle after a prior review gate already closed the last cycle',
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

        runPassingTrustBoundaryQualityChecklist({
            repoRoot,
            taskId,
            preflightPath,
            evidenceFiles: ['src/app.ts']
        });

        const codeReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            codeReviewContextPath,
            'agent:code-reviewer'
        );
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'security',
            'SECURITY REVIEW PASSED',
            preflightPath,
            path.join(getReviewsRoot(repoRoot), `${taskId}-security-review-context.json`),
            'agent:security-reviewer'
        );
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'refactor',
            'REFACTOR REVIEW PASSED',
            preflightPath,
            path.join(getReviewsRoot(repoRoot), `${taskId}-refactor-review-context.json`),
            'agent:refactor-reviewer'
        );

        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            securityReviewVerdict: 'SECURITY REVIEW PASSED',
            refactorReviewVerdict: 'REFACTOR REVIEW PASSED',
            reviewAuthorshipAttestationJson: '{"code":true,"security":true,"refactor":true}',
            emitMetrics: false
        });
        assert.equal(reviewGateResult.exitCode, 0, reviewGateResult.outputLines.join('\n'));

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_CYCLE_RESTART_FAILED/);
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_GATE_PASSED/);
        assert.match(restartResult.outputLines.join('\n'), /restart-coherent-cycle/);

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
        const reviewGateIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'REVIEW_GATE_PASSED');
        const lastHandshakeIndex = handshakeIndexes.at(-1) ?? -1;
        const lastShellSmokeIndex = shellSmokeIndexes.at(-1) ?? -1;
        assert.equal(handshakeIndexes.length, 1);
        assert.equal(shellSmokeIndexes.length, 1);
        assert.ok(reviewGateIndex >= 0);
        assert.ok(reviewGateIndex > lastShellSmokeIndex);
        assert.ok(lastShellSmokeIndex > lastHandshakeIndex);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle defaults to the current workspace diff instead of silently reusing the old explicit preflight scope', { concurrency: false }, async (t) => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-current-diff';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-current-diff');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle from the latest workspace diff after a failed review',
            plannedChangedFiles: [
                'src/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle from the latest workspace diff after a failed review',
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

        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');

        const missingImpactResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(missingImpactResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(missingImpactResult.outputLines.join('\n'), /requires main-agent remediation impact analysis/);
        const blockedImpactArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(blockedImpactArtifact.status, 'BLOCKED');
        assert.equal(blockedImpactArtifact.reason, 'missing_or_incomplete_remediation_impact_analysis');
        assert.equal((blockedImpactArtifact.impact_analysis as Record<string, unknown>).status, 'BLOCKED');
        assert.equal(
            (blockedImpactArtifact.remediation_fix_classification as Record<string, unknown>).category,
            'unknown'
        );
        assert.equal(
            (blockedImpactArtifact.remediation_fix_classification as Record<string, unknown>).scope_category,
            'test_only_expansion'
        );
        assert.deepEqual(
            (blockedImpactArtifact.remediation_fix_classification as Record<string, unknown>).invalidated_review_types,
            []
        );

        const boilerplateImpactResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysis: [
                'Reviewer finding: reviewer finding.',
                'Intended fix: intended fix.',
                'Affected files/contracts: affected files and contracts.',
                'API/runtime/artifact/test impact: api runtime artifact test impact.',
                'Possible side effects: possible side effects.',
                'Required targeted checks: required targeted checks.',
                'Scope or review impact: scope or review impact.',
                'Related blockers/follow-up: related blocker or follow-up decision.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(boilerplateImpactResult.exitCode, EXIT_GATE_FAILURE);
        const boilerplateOutput = boilerplateImpactResult.outputLines.join('\n');
        assert.match(boilerplateOutput, /needs task-specific detail|must mention at least one affected file/);

        const validImpactAnalysis = buildDefaultRemediationImpactAnalysis(
            ['src/app.ts', 'tests/app.test.ts'],
            preflightPath
        );
        const outsideImpactPath = path.join(os.tmpdir(), `${taskId}-outside-impact-analysis.md`);
        fs.writeFileSync(outsideImpactPath, validImpactAnalysis, 'utf8');
        const outsideImpactResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysisPath: outsideImpactPath,
            emitMetrics: false
        });
        assert.equal(outsideImpactResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(outsideImpactResult.outputLines.join('\n'), /must stay inside the repository root/);
        fs.rmSync(outsideImpactPath, { force: true });

        const outsideLargeImpactPath = path.join(os.tmpdir(), `${taskId}-outside-large-impact-analysis.md`);
        fs.writeFileSync(outsideLargeImpactPath, `${validImpactAnalysis}\n${'x'.repeat(70 * 1024)}`, 'utf8');
        const outsideLargeImpactResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysisPath: outsideLargeImpactPath,
            emitMetrics: false
        });
        assert.equal(outsideLargeImpactResult.exitCode, EXIT_GATE_FAILURE);
        const outsideLargeOutput = outsideLargeImpactResult.outputLines.join('\n');
        assert.match(outsideLargeOutput, /must stay inside the repository root/);
        assert.doesNotMatch(outsideLargeOutput, /must be <= 65536 bytes/);
        fs.rmSync(outsideLargeImpactPath, { force: true });

        const outsideSymlinkTarget = path.join(os.tmpdir(), `${taskId}-outside-symlink-impact-analysis.md`);
        const symlinkImpactPath = path.join(repoRoot, 'symlink-impact-analysis.md');
        await t.test('restart-review-cycle rejects repo-local symlinked impact analysis paths outside repo', async (symlinkTest) => {
            try {
                fs.writeFileSync(outsideSymlinkTarget, validImpactAnalysis, 'utf8');
                fs.symlinkSync(outsideSymlinkTarget, symlinkImpactPath, 'file');
                const symlinkImpactResult = await runRestartReviewCycleCommandRaw({
                    repoRoot,
                    taskId,
                    preflightPath,
                    commandsPath,
                    outputFiltersPath,
                    impactAnalysisPath: 'symlink-impact-analysis.md',
                    emitMetrics: false
                });
                assert.equal(symlinkImpactResult.exitCode, EXIT_GATE_FAILURE);
                assert.match(symlinkImpactResult.outputLines.join('\n'), /must stay inside the repository root/);
            } catch (error: unknown) {
                const code = (error as { code?: string }).code;
                if (code !== 'EPERM' && code !== 'EACCES') {
                    throw error;
                }
                symlinkTest.skip('file symlink creation is not permitted in this environment');
            } finally {
                fs.rmSync(symlinkImpactPath, { force: true });
                fs.rmSync(outsideSymlinkTarget, { force: true });
            }
        });

        const largeImpactPath = path.join(repoRoot, 'large-impact-analysis.md');
        fs.writeFileSync(largeImpactPath, `${validImpactAnalysis}\n${'x'.repeat(70 * 1024)}`, 'utf8');
        const largeImpactResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysisPath: 'large-impact-analysis.md',
            emitMetrics: false
        });
        assert.equal(largeImpactResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(largeImpactResult.outputLines.join('\n'), /must be <= 65536 bytes/);
        fs.rmSync(largeImpactPath, { force: true });

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /DetectionSource: git_auto_current_workspace/);
        assert.match(output, /ReviewRemediationCycleArtifact:/);
        assert.match(output, /RemediationFixClassification: test_coverage_only; invalidated_review_types=refactor, test; preserved_review_types=code, security/);
        assert.match(output, /ScopeBoundary: OK; previous=1; current=2; expanded_non_test=none/);
        assert.match(output, /RefreshPoints: preflight=refreshed; post_preflight_rule_pack=reloaded; compile=rerun/);
        assert.match(output, /ReuseBoundaries: non_test_changes_must_stay_within_previous_preflight_scope/);
        assert.match(output, /PendingReviewTypes: code, security, refactor, test/);
        assert.match(output, /PendingReason: Review context cannot be built because required trust-boundary analysis is/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts', 'tests/app.test.ts']);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).test, true);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(remediationArtifact.status, 'PASSED');
        assert.equal((remediationArtifact.impact_analysis as Record<string, unknown>).status, 'RECORDED');
        assert.equal((remediationArtifact.impact_analysis as Record<string, unknown>).source, 'inline');
        assert.equal(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).category,
            'test_coverage_only'
        );
        assert.equal(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).scope_category,
            'test_only_expansion'
        );
        assert.deepEqual(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).invalidated_review_types,
            ['refactor', 'test']
        );
        assert.deepEqual(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).preserved_review_types,
            ['code', 'security']
        );
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).allowed_test_only_expansion_files,
            ['tests/app.test.ts']
        );
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).expanded_non_test_files,
            []
        );

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 3;\nconst b = 4;\nconsole.log(a + b);\n', 'utf8');
        const fileImpactAnalysisPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'impact-analysis.md');
        fs.writeFileSync(fileImpactAnalysisPath, validImpactAnalysis, 'utf8');
        const fileImpactRestartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysisPath: 'garda-agent-orchestrator/runtime/impact-analysis.md',
            emitMetrics: false
        });
        assert.equal(fileImpactRestartResult.exitCode, 0, fileImpactRestartResult.outputLines.join('\n'));
        const fileImpactArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(fileImpactArtifact.status, 'PASSED');
        assert.equal((fileImpactArtifact.impact_analysis as Record<string, unknown>).status, 'RECORDED');
        assert.equal((fileImpactArtifact.impact_analysis as Record<string, unknown>).source, 'file');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects out-of-repo preflight artifacts before remediation replay', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-external-preflight';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            'restart-review-cycle-external-preflight'
        );
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject review-cycle restart from an external preflight artifact',
            plannedChangedFiles: ['src/app.ts']
        });

        const outsideReviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${taskId}-outside-reviews-`));
        const outsidePreflightPath = path.join(outsideReviewsRoot, `${taskId}-preflight.json`);
        fs.writeFileSync(outsidePreflightPath, JSON.stringify({
            task_id: taskId,
            changed_files: ['src/app.ts'],
            required_reviews: { code: true, security: true }
        }, null, 2), 'utf8');

        try {
            await assert.rejects(
                () => runRestartReviewCycleCommand({
                    repoRoot,
                    taskId,
                    preflightPath: outsidePreflightPath,
                    commandsPath,
                    outputFiltersPath,
                    emitMetrics: false
                }),
                /PreflightPath must resolve inside repo root without symlink or junction escape/
            );
        } finally {
            fs.rmSync(outsideReviewsRoot, { recursive: true, force: true });
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
