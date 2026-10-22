import {
    assert, createTempRepo, fs, getReviewsRoot, initializeGitRepo, it, loadPostPreflightRulePack,
    loadTaskEntryRulePack, path, readTaskTimelineEvents, runCompileGateCommand, runEnterTaskMode,
    runExplicitPreflight, runHandshakeForTask, runRestartCoherentCycleCommand, runRestartReviewCycleCommand,
    runShellSmokeForTask, seedInitAnswers, seedRemediationRepoBase, seedTaskQueue, serializeTaskPlan,
    validateTaskPlan, writeSimpleCompileCommandsFile
} from './gates-review-cycle-fixtures';

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
