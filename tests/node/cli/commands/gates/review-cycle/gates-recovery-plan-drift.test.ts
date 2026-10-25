import {
    appendTaskEvent, assert, createTempRepo, fileSha256, fs, getOrchestratorRoot, getReviewsRoot, initializeGitRepo, it, loadPostPreflightRulePack,
    loadTaskEntryRulePack, path, readTaskTimelineEvents, runCompileGateCommand, runEnterTaskMode,
    runExplicitPreflight, runHandshakeForTask, runRestartCoherentCycleCommand, runRestartReviewCycleCommand,
    runShellSmokeForTask, seedInitAnswers, seedQualityChecklistIfRequired, seedRemediationRepoBase, seedTaskQueue, serializeTaskPlan,
    TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH, validateTaskPlan, writeCurrentReviewCycleValidationSource, writeSimpleCompileCommandsFile
} from './gates-review-cycle-fixtures';
import { resolveNextStep } from '../../../../gates/next-step/next-step-test-support';
import { buildQualityChecklistAnswersTemplate } from '../../../../../../src/gates/quality-checklist';
import { TRUST_BOUNDARY_ANALYSIS_RULE_ID } from '../../../../../../src/core/trust-boundary-analysis';
import { runIntermediateCommandCommand } from '../../../../../../src/cli/commands/gate-flows/command-run/command-run-flow';
import { runQualityChecklistCommand } from '../../../../../../src/cli/commands/gate-flows/quality-checklist/quality-checklist-flow';

function planDriftWorkspace(context: Parameters<typeof createTempRepo>[0], suffix: string) {
    const repoRoot = createTempRepo(context), taskId = `T-DRIFT-${suffix}`;
    seedRemediationRepoBase(repoRoot);
    writeCurrentReviewCycleValidationSource(repoRoot);
    const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, `drift-${suffix}`);
    initializeGitRepo(repoRoot);
    seedTaskQueue(repoRoot, taskId); seedInitAnswers(repoRoot, 'Codex');
    fs.writeFileSync(path.join(repoRoot, 'src/app.ts'), 'export const changed = true;\n');
    const planPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-plan.json`);
    const plan = validateTaskPlan({ schema_version: 1, task_id: taskId, status: 'approved',
        goal: 'Bind plan drift recovery to the current task entry and preflight', scope_files: ['src/planned.ts'],
        risk_level: 'low', steps: [{ id: 'one', title: 'Implement the planned file', files: ['src/planned.ts'] }] });
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, serializeTaskPlan(plan));
    const entered = runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Bind plan drift recovery to current evidence', planPath });
    assert.equal(entered.exitCode, 0, entered.outputLines.join('\n'));
    loadTaskEntryRulePack(repoRoot, taskId); runHandshakeForTask(repoRoot, taskId); runShellSmokeForTask(repoRoot, taskId);
    const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Recover the current plan drift failure', ['src/app.ts']);
    loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
    return { repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath, emitMetrics: false };
}

async function bindCurrentPlanDriftQuality(options: ReturnType<typeof planDriftWorkspace>): Promise<void> {
    const testContext = process.env.NODE_TEST_CONTEXT;
    let execution: Awaited<ReturnType<typeof runIntermediateCommandCommand>>;
    try {
        delete process.env.NODE_TEST_CONTEXT;
        execution = await runIntermediateCommandCommand({ ...options,
            commandSource: 'targeted-test',
            command: `node --experimental-strip-types --test --test-reporter=tap ${TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH}` });
    } finally {
        if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
        else process.env.NODE_TEST_CONTEXT = testContext;
    }
    assert.equal(execution.exitCode, 0, execution.outputLines.join('\n'));
    const artifactPath = path.join(getReviewsRoot(options.repoRoot), `${options.taskId}-quality-checklist.json`);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as { answers: Array<Record<string, unknown>> };
    const trustAnswer = artifact.answers.find(answer => answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID);
    assert.ok(trustAnswer);
    const answers = buildQualityChecklistAnswersTemplate(options).answers.map(answer => ({
        ...answer,
        status: 'PASS',
        answer: 'The current focused fixture execution checks replacement rejection and retains its authenticated result.',
        evidence_files: [TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH],
        actions_taken: [], actions_required: [],
        ...(answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID
            ? { trust_boundary_matrix: trustAnswer.trust_boundary_matrix } : {})
    }));
    const recorded = runQualityChecklistCommand({ ...options, answersJson: JSON.stringify(answers) });
    assert.equal(recorded.exitCode, 0, recorded.outputLines.join('\n'));
    const current = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.equal(current.status, 'PENDING_VALIDATION');
    assert.equal(current.validation_phases.structural, 'BOUND');
    assert.equal(current.validation_phases.execution, 'OBSERVED', JSON.stringify(current.validation_phases.execution_diagnostics));
}

async function rejectedPlanDrift(options: ReturnType<typeof planDriftWorkspace>) {
    await bindCurrentPlanDriftQuality(options);
    const compile = await runCompileGateCommand(options);
    assert.notEqual(compile.exitCode, 0, compile.outputLines.join('\n'));
    const artifactPath = path.join(getReviewsRoot(options.repoRoot), `${options.taskId}-compile-gate.json`);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.equal(artifact.plan_drift?.status, 'REPLAN_REQUIRED', compile.outputLines.join('\n'));
    const preflightSha256 = fileSha256(options.preflightPath);
    assert.ok(preflightSha256);
    assert.equal(artifact.preflight_hash_sha256, preflightSha256, 'plan-drift failures must retain their current preflight hash');
    const failure = [...readTaskTimelineEvents(options.repoRoot, options.taskId)].reverse()
        .find(event => event.event_type === 'COMPILE_GATE_FAILED')!;
    assert.equal((failure.details as Record<string, unknown>).preflight_hash_sha256, preflightSha256,
        'the native compile failure event must bind the same current preflight');
    const next = resolveNextStep(options);
    assert.equal(next.next_gate, 'compile-gate', next.reason);
    assert.equal(next.title, 'Resolve plan drift before compile.', next.reason);
    assert.match(next.commands[0].command, /--allow-plan-drift --allow-plan-drift-reason/u);
    return { artifactPath, artifact };
}

function assertPlainCompileRoute(options: ReturnType<typeof planDriftWorkspace>, description: string): void {
    const next = resolveNextStep(options);
    assert.equal(next.next_gate, 'compile-gate', `${description}: ${next.reason}`);
    assert.equal(next.title, 'Run compile gate.', `${description}: ${next.reason}`);
    assert.doesNotMatch(next.commands[0].command, /--allow-plan-drift/u, description);
}

it('compile rejects the Navigator plan-drift reason placeholder and retains an actionable current failure', async context => {
    const options = planDriftWorkspace(context, 'placeholder');
    const { artifactPath } = await rejectedPlanDrift(options);
    const compile = await runCompileGateCommand({ ...options, allowPlanDrift: true,
        allowPlanDriftReason: '<why these files belong to this task>' });
    assert.notEqual(compile.exitCode, 0, compile.outputLines.join('\n'));
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.equal(artifact.plan_drift.status, 'REPLAN_REQUIRED');
    assert.match(artifact.error, /no <\.\.\.> placeholders/u);
    assert.equal(resolveNextStep(options).title, 'Resolve plan drift before compile.');
});

it('Navigator ignores plan-drift artifacts with foreign current-evidence bindings', async context => {
    const options = planDriftWorkspace(context, 'bindings');
    const { artifactPath, artifact } = await rejectedPlanDrift(options);
    const replacements = [
        { name: 'preflight path', update: (copy: typeof artifact) => { copy.preflight_path = path.join(getReviewsRoot(options.repoRoot), 'foreign-preflight.json'); } },
        { name: 'outside preflight path', update: (copy: typeof artifact) => { copy.preflight_path = path.resolve(options.repoRoot, '../outside-preflight.json'); } },
        { name: 'malformed preflight path', update: (copy: typeof artifact) => { copy.preflight_path = '\u0000invalid-preflight.json'; } },
        { name: 'preflight hash', update: (copy: typeof artifact) => { copy.preflight_hash_sha256 = '0'.repeat(64); } },
        { name: 'task-mode path', update: (copy: typeof artifact) => { copy.task_mode.evidence_path = path.join(getReviewsRoot(options.repoRoot), 'foreign-task-mode.json'); } },
        { name: 'outside task-mode path', update: (copy: typeof artifact) => { copy.task_mode.evidence_path = path.resolve(options.repoRoot, '../outside-task-mode.json'); } },
        { name: 'malformed task-mode path', update: (copy: typeof artifact) => { copy.task_mode.evidence_path = '\u0000invalid-task-mode.json'; } },
        { name: 'task-mode evidence hash', update: (copy: typeof artifact) => { copy.task_mode.evidence_hash = '0'.repeat(64); } },
        { name: 'frozen task-mode plan digest', update: (copy: typeof artifact) => { copy.task_mode.plan.plan_sha256 = '0'.repeat(64); } },
        { name: 'drift plan digest', update: (copy: typeof artifact) => { copy.plan_drift.plan_sha256 = '0'.repeat(64); } },
        { name: 'task identity', update: (copy: typeof artifact) => { copy.task_id = 'T-FOREIGN'; } },
        { name: 'gate source', update: (copy: typeof artifact) => { copy.event_source = 'foreign-gate'; } }
    ];
    for (const replacement of replacements) {
        const copy = JSON.parse(JSON.stringify(artifact));
        replacement.update(copy);
        fs.writeFileSync(artifactPath, JSON.stringify(copy));
        assertPlainCompileRoute(options, replacement.name);
    }
    fs.writeFileSync(artifactPath, JSON.stringify(artifact));
    assert.equal(resolveNextStep(options).title, 'Resolve plan drift before compile.');
});

it('Navigator ignores a drift failure after preflight is refreshed with the same changed files', async context => {
    const options = planDriftWorkspace(context, 'preflight');
    await rejectedPlanDrift(options);
    runExplicitPreflight(options.repoRoot, options.taskId, 'Refresh the plan drift cycle without changing its files', ['src/app.ts']);
    loadPostPreflightRulePack(options.repoRoot, options.taskId, options.preflightPath);
    await bindCurrentPlanDriftQuality(options);
    assertPlainCompileRoute(options, 'refreshed preflight');
});

it('Navigator rejects an integrity-bound compile-failure clone recorded by a non-gate actor', async context => {
    const options = planDriftWorkspace(context, 'actor');
    await rejectedPlanDrift(options);
    const failure = [...readTaskTimelineEvents(options.repoRoot, options.taskId)].reverse()
        .find(event => event.event_type === 'COMPILE_GATE_FAILED')!;
    appendTaskEvent(getOrchestratorRoot(options.repoRoot), options.taskId, 'COMPILE_GATE_FAILED', 'FAIL',
        'Replay the same compile bindings through an agent-owned event.', failure.details as Record<string, unknown>, { actor: 'agent' });
    const clonedFailure = readTaskTimelineEvents(options.repoRoot, options.taskId).at(-1)!;
    assert.equal(clonedFailure.actor, 'agent');
    assertPlainCompileRoute(options, 'non-gate compile event');
});

it('Navigator ignores a compile failure before the latest task entry even with identical artifact bindings', async context => {
    const options = planDriftWorkspace(context, 'sequence');
    await rejectedPlanDrift(options);
    const events = readTaskTimelineEvents(options.repoRoot, options.taskId);
    const entry = events.find(event => event.event_type === 'TASK_MODE_ENTERED')!;
    const classification = [...events].reverse().find(event => event.event_type === 'PREFLIGHT_CLASSIFIED')!;
    appendTaskEvent(getOrchestratorRoot(options.repoRoot), options.taskId, 'TASK_MODE_ENTERED', 'PASS',
        'Resume the same task-mode artifact for a fresh task entry.', entry.details as Record<string, unknown>, { actor: 'gate' });
    loadTaskEntryRulePack(options.repoRoot, options.taskId);
    runHandshakeForTask(options.repoRoot, options.taskId); runShellSmokeForTask(options.repoRoot, options.taskId);
    appendTaskEvent(getOrchestratorRoot(options.repoRoot), options.taskId, 'PREFLIGHT_CLASSIFIED', 'INFO',
        'Rebind the unchanged preflight after the resumed task entry.', classification.details as Record<string, unknown>, { actor: 'gate' });
    loadPostPreflightRulePack(options.repoRoot, options.taskId, options.preflightPath, false);
    fs.rmSync(path.join(getReviewsRoot(options.repoRoot), `${options.taskId}-quality-checklist.json`), { force: true });
    seedQualityChecklistIfRequired(options.repoRoot, options.taskId);
    await bindCurrentPlanDriftQuality(options);
    assertPlainCompileRoute(options, 'later task entry');
});

for (const kind of ['coherent', 'review'] as const) {
    it(`${kind} restart preserves explicit plan-drift approval and rejects its absence`, async (context) => {
        const repoRoot = createTempRepo(context), taskId = `T-DRIFT-${kind}`;
        seedRemediationRepoBase(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, `drift-${kind}`);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId); seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'src/app.ts'), 'export const changed = true;\n');
        const plan = validateTaskPlan({ schema_version: 1, task_id: taskId, status: 'approved',
            goal: 'Keep compile plan drift explicit during native recovery', scope_files: ['src/planned.ts'],
            risk_level: 'low', steps: [{ id: 'one', title: 'Implement the planned file', files: ['src/planned.ts'] }] });
        const planPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-plan.json`);
        fs.mkdirSync(path.dirname(planPath), { recursive: true });
        fs.writeFileSync(planPath, serializeTaskPlan(plan));
        const planHash = fs.readFileSync(planPath);
        runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Preserve explicit compile plan drift during recovery', planPath });
        loadTaskEntryRulePack(repoRoot, taskId); runHandshakeForTask(repoRoot, taskId); runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Recover native compile evidence', ['src/app.ts']);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const options = { repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath, emitMetrics: false };
        const approved = { ...options, allowPlanDrift: true, allowPlanDriftReason: 'Operator approved this exact supporting file beyond the immutable fixture plan.' };
        const compile = await runCompileGateCommand(approved);
        assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
        const restart = kind === 'coherent' ? runRestartCoherentCycleCommand : runRestartReviewCycleCommand;
        const rejected = await restart(options);
        assert.notEqual(rejected.exitCode, 0, 'restart must never silently waive plan scope');
        assert.match(rejected.outputLines.join('\n'), /plan|scope|drift/iu);
        const accepted = await restart(approved);
        assert.equal(accepted.exitCode, 0, accepted.outputLines.join('\n'));
        const compileEvidence = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8'));
        assert.equal(compileEvidence.status, 'PASSED');
        assert.ok(JSON.stringify(compileEvidence.plan_drift).includes(approved.allowPlanDriftReason));
        assert.deepEqual(fs.readFileSync(planPath), planHash, 'native recovery must preserve the immutable plan');
        assert.ok(readTaskTimelineEvents(repoRoot, taskId).some(event => event.event_type === (kind === 'coherent' ? 'COHERENT_CYCLE_RESTARTED' : 'REVIEW_CYCLE_RESTARTED')));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        if (kind === 'review') {
            assert.equal(events.filter(event => event.event_type === 'TASK_MODE_ENTERED').length, 1, 'review recovery must preserve task entry');
        }
        const preflightIndex = events.map(event => event.event_type).lastIndexOf('PREFLIGHT_CLASSIFIED');
        const boundaryIndex = events.slice(0, preflightIndex).reduce((latest, event, index) =>
            ['IMPLEMENTATION_STARTED', 'REVIEW_PHASE_STARTED', 'COMPLETION_GATE_FAILED'].includes(String(event.event_type)) ? index : latest, -1);
        const prefix = events.slice(boundaryIndex + 1, preflightIndex).map(event => event.event_type);
        assert.ok(prefix.includes('HANDSHAKE_DIAGNOSTICS_RECORDED'), 'reclassification needs handshake after the latest execution boundary');
        assert.ok(prefix.indexOf('SHELL_SMOKE_PREFLIGHT_RECORDED') > prefix.indexOf('HANDSHAKE_DIAGNOSTICS_RECORDED'), 'shell smoke must follow the refreshed handshake');
    });
}
