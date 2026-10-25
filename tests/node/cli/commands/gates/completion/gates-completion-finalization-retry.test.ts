import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleCompletionGate } from '../../../../../../src/cli/commands/gate-task-handlers';
import { runClassifyChangeCommand, runCompileGateCommand, runDocImpactGateCommand } from '../../../../../../src/cli/commands/gates';
import * as taskEvents from '../../../../../../src/gate-runtime/timeline/task-events-io';
import { buildTaskAuditSummary } from '../../../../../../src/gates/task-audit/task-audit-summary';
import { writeBudgetOutputFilters } from '../../gate-test-helpers';
import {
    createTempRepo, initializeGitRepo, seedTaskQueue, seedInitAnswers,
    runEnterTaskMode, loadTaskEntryRulePack, runHandshakeForTask, runShellSmokeForTask,
    loadPostPreflightRulePack, writeCleanReviewArtifact, runRequiredReviewsCheckCommand,
    getReviewsRoot, readTaskQueueStatusFromTaskFile, readTaskTimelineEvents
} from './gates-completion-fixtures';

const taskId = 'T-905-finalization-retry';

test('completion-gate retry after a finalization permission failure completes without a new cycle', async () => {
    const repoRoot = createTempRepo();
    try {
        fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/\n');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Finalization retry regression', plannedChangedFiles: ['src/app.ts'] });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.appendFileSync(path.join(repoRoot, 'src/app.ts'), '\nexport const reviewedChange = 1;\n');
        runClassifyChangeCommand({ repoRoot, taskId, taskIntent: 'Finalization retry regression',
            changedFiles: ['src/app.ts'], outputPath: preflightPath, emitMetrics: false });
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        const compile = await runCompileGateCommand({ repoRoot, taskId, preflightPath, outputFiltersPath, emitMetrics: false });
        assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as { required_reviews: Record<string, boolean> };
        if (preflight.required_reviews.test) writeCleanReviewArtifact(repoRoot, taskId, 'test', 'TEST REVIEW PASSED');
        const reviews = runRequiredReviewsCheckCommand({ repoRoot, taskId, preflightPath, outputFiltersPath, emitMetrics: false });
        assert.equal(reviews.exitCode, 0, reviews.outputLines.join('\n'));
        assert.equal(runDocImpactGateCommand({ repoRoot, taskId, preflightPath,
            decision: 'NO_DOC_UPDATES', behaviorChanged: false, changelogUpdated: false,
            rationale: 'No public behavior changes in this isolated lifecycle fixture.', emitMetrics: false }).exitCode, 0);

        const originalAppend = taskEvents.appendMandatoryTaskEventAsync;
        let injected = false;
        mock.method(taskEvents, 'appendMandatoryTaskEventAsync', async (...args: Parameters<typeof originalAppend>) => {
            if (!injected && args[2] === 'STATUS_CHANGED') {
                injected = true;
                throw Object.assign(new Error('EPERM: operation not permitted, open protected task-entry key'), { code: 'EPERM' });
            }
            return originalAppend(...args);
        });
        try {
            await assert.rejects(handleCompletionGate(['--task-id', taskId, '--preflight-path', preflightPath, '--repo-root', repoRoot]),
                /finalization failed after validation PASS/);
        } finally {
            mock.restoreAll();
        }
        assert.equal(injected, true);
        const before = readTaskTimelineEvents(repoRoot, taskId);
        const failure = [...before].reverse().find(event => event.event_type === 'COMPLETION_GATE_FAILED');
        assert.equal((failure?.details as Record<string, unknown>)?.outcome, 'FINALIZATION_FAILED');
        assert.notEqual(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        await handleCompletionGate(['--task-id', taskId, '--preflight-path', preflightPath, '--repo-root', repoRoot]);

        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        const summary = buildTaskAuditSummary({ repoRoot, taskId });
        assert.equal(summary.status, 'PASS', JSON.stringify(summary.blockers));
        const after = readTaskTimelineEvents(repoRoot, taskId);
        for (const eventType of ['PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'REVIEW_GATE_PASSED']) {
            assert.equal(after.filter(event => event.event_type === eventType).length,
                before.filter(event => event.event_type === eventType).length, eventType);
        }
        assert.ok(after.some(event => event.event_type === 'COMPLETION_GATE_PASSED'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
