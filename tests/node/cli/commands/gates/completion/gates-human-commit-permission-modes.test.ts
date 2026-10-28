import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCompileGateCommand, runDocImpactGateCommand, runHumanCommitCommand } from '../../../../../../src/cli/commands/gates';
import { handleCompletionGate } from '../../../../../../src/cli/commands/gate-task-handlers';
import { handleSet } from '../../../../../../src/cli/commands/workflow/workflow-command-set';
import { buildTaskAuditSummary } from '../../../../../../src/gates/task-audit/task-audit-summary';
import { buildFinalReportOrder } from '../../../../../../src/gates/next-step/next-step-closeout-status-readers';
import { resolveLocalCommitAvailability } from '../../../../../../src/core/auth/local-commit-availability';
import { OPERATOR_CONFIRMATION_MAX_AGE_MS } from '../../../../../../src/core/operator-confirmation';
import { writeBudgetOutputFilters } from '../../gate-test-helpers';
import { createTempRepo, seedTaskQueue, seedInitAnswers, writePreflight, runEnterTaskMode,
    loadTaskEntryRulePack, runHandshakeForTask, runShellSmokeForTask, loadPostPreflightRulePack,
    writeCleanReviewArtifact, runRequiredReviewsCheckCommand, runGit, initializeGitRepo } from './gates-completion-fixtures';

async function completeTask(enabled: boolean) {
    const repoRoot = createTempRepo();
    const taskId = 'T-903-commit-mode';
    seedTaskQueue(repoRoot, taskId, 'TODO');
    seedInitAnswers(repoRoot);
    // Permission must be set before task entry freezes its protected configuration.
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'garda-agent-orchestrator/\nTASK.md\n');
    initializeGitRepo(repoRoot);
    fs.appendFileSync(path.join(repoRoot, 'src/app.ts'), '// Native task commit fixture.\n');
    const preflightPath = writePreflight(repoRoot, taskId);
    if (enabled) handleSet({ targetRoot: repoRoot, localCommitEnabled: 'true', json: true,
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
    const commandsPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/commit-mode-commands.md');
    fs.writeFileSync(commandsPath, '### Compile Gate (Mandatory)\n```bash\nnode -e "console.log(\'build ok\')"\n```\n');
    const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
    runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Verify native local commit permission modes' });
    loadTaskEntryRulePack(repoRoot, taskId);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
    loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
    assert.equal((await runCompileGateCommand({ repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath, emitMetrics: false })).exitCode, 0);
    writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
    assert.equal(runRequiredReviewsCheckCommand({ repoRoot, taskId, preflightPath, codeReviewVerdict: 'REVIEW PASSED', outputFiltersPath, emitMetrics: false }).exitCode, 0);
    assert.equal(runDocImpactGateCommand({ repoRoot, taskId, preflightPath, decision: 'NO_DOC_UPDATES', behaviorChanged: false,
        changelogUpdated: false, rationale: 'Native commit-mode regression fixture.', emitMetrics: false }).exitCode, 0);
    await handleCompletionGate(['--task-id', taskId, '--repo-root', repoRoot, '--preflight-path', preflightPath]);
    const audit = buildTaskAuditSummary({ taskId, repoRoot });
    assert.equal(audit.status, 'PASS', JSON.stringify(audit.blockers));
    runGit(repoRoot, ['add', '--', 'src/app.ts']);
    return { repoRoot, taskId, audit };
}

for (const enabled of [true, false]) {
    test(`real completion and native commit obey ${enabled ? 'ON' : 'OFF'} permission`, async (t) => {
        const w = await completeTask(enabled);
        t.after(() => fs.rmSync(w.repoRoot, { recursive: true, force: true }));
        const question = 'Do you want me to commit now? (yes/no)';
        const command = w.audit.final_report_contract.commit_command_suggestion;
        const order = buildFinalReportOrder(w.audit);
        assert.ok(command.includes('--task-id "' + w.taskId + '"'));
        assert.equal(w.audit.final_report_contract.commit_question, enabled ? '' : question);
        assert.equal(order.includes(question), !enabled);
        const report = fs.readFileSync(path.join(w.repoRoot, 'garda-agent-orchestrator/runtime/reviews', w.taskId + '-final-closeout.md'), 'utf8');
        assert.equal(report.includes(question), !enabled);
        assert.ok(report.includes(command));
        const args = ['--task-id', w.taskId, '--message', 'test: native commit permission mode'];
        if (!enabled) {
            assert.match(command, /--operator-confirmed yes --operator-confirmed-at-utc "/u);
            assert.ok(order.indexOf(command) < order.indexOf(question));
            const head = runGit(w.repoRoot, ['rev-parse', 'HEAD']).stdout;
            await assert.rejects(runHumanCommitCommand(args, { cwd: w.repoRoot }), /explicit operator confirmation/u);
            await assert.rejects(runHumanCommitCommand([...args, '--operator-confirmed', 'yes'], { cwd: w.repoRoot }), /--operator-confirmed-at-utc/u);
            await assert.rejects(runHumanCommitCommand([...args, '--operator-confirmed', 'yes', '--operator-confirmed-at-utc',
                new Date(Date.now() - OPERATOR_CONFIRMATION_MAX_AGE_MS - 60000).toISOString()], { cwd: w.repoRoot }), /stale/u);
            assert.equal(runGit(w.repoRoot, ['rev-parse', 'HEAD']).stdout, head);
            args.push('--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString());
        } else assert.doesNotMatch(command, /--operator-confirmed/u);
        assert.equal(await runHumanCommitCommand(args, { cwd: w.repoRoot }), 0);
        assert.equal(buildTaskAuditSummary({ taskId: w.taskId, repoRoot: w.repoRoot }).status, 'PASS');
        assert.equal(resolveLocalCommitAvailability(w.repoRoot).enabled, enabled);
        const events = fs.readFileSync(path.join(w.repoRoot, 'garda-agent-orchestrator/runtime/task-events', w.taskId + '.jsonl'), 'utf8');
        assert.match(events, /TASK_SOURCE_COMMIT_ACCEPTED/u);
    });
}
