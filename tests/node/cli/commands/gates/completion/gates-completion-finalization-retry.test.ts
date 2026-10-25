import { authenticateCurrentReviewLaunch } from '../../gate-test-authenticated-review-helpers';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleCompletionGate } from '../../../../../../src/cli/commands/gate-task-handlers';
import { runClassifyChangeCommand, runCompileGateCommand, runDocImpactGateCommand } from '../../../../../../src/cli/commands/gates';
import * as filesystem from '../../../../../../src/core/filesystem';
import * as taskQueueRepository from '../../../../../../src/core/task-queue/task-queue-repository';
import { resolveNextStep } from '../../../../../../src/gates/next-step/next-step';
import * as taskEventWrites from '../../../../../../src/gate-runtime/timeline/task-events-io-write';
import * as queueLocking from '../../../../../../src/gate-runtime/timeline/task-events-locking-acquire';
import { appendMandatoryTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { buildTaskAuditSummary } from '../../../../../../src/gates/task-audit/task-audit-summary';
import * as closeoutSync from '../../../../../../src/gates/task-audit/task-audit-summary-closeout-sync';
import * as gateArtifacts from '../../../../../../src/cli/gate-cli/gates-artifacts';
import { writeBudgetOutputFilters } from '../../gate-test-helpers';
import {
    createTempRepo, initializeGitRepo, seedTaskQueue, seedInitAnswers,
    runEnterTaskMode, loadTaskEntryRulePack, runHandshakeForTask, runShellSmokeForTask,
    loadPostPreflightRulePack, writeCleanReviewArtifact, runRequiredReviewsCheckCommand,
    getReviewsRoot, readTaskQueueStatusFromTaskFile, readTaskTimelineEvents
} from './gates-completion-fixtures';

const taskId = 'T-905-finalization-retry';

async function prepareValidatedCompletion(repoRoot: string, parentTaskId?: string): Promise<string> {
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/\n');
    initializeGitRepo(repoRoot);
    seedTaskQueue(repoRoot, taskId);
    if (parentTaskId) {
        fs.appendFileSync(path.join(repoRoot, 'TASK.md'),
            `\n| ${parentTaskId} | DECOMPOSED | P1 | test | Parent | unassigned | 2026-03-28 | default | Execute child tasks \`${taskId}\` through normal gates. |\n`);
    }
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
    authenticateCurrentReviewLaunch(repoRoot, taskId, 'code');
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as { required_reviews: Record<string, boolean> };
    if (preflight.required_reviews.test) {
        writeCleanReviewArtifact(repoRoot, taskId, 'test', 'TEST REVIEW PASSED');
        authenticateCurrentReviewLaunch(repoRoot, taskId, 'test');
    }
    const reviews = runRequiredReviewsCheckCommand({ repoRoot, taskId, preflightPath, outputFiltersPath, emitMetrics: false });
    assert.equal(reviews.exitCode, 0, reviews.outputLines.join('\n'));
    assert.equal(runDocImpactGateCommand({ repoRoot, taskId, preflightPath,
        decision: 'NO_DOC_UPDATES', behaviorChanged: false, changelogUpdated: false,
        rationale: 'No public behavior changes in this isolated lifecycle fixture.', emitMetrics: false }).exitCode, 0);
    return preflightPath;
}

for (const scenario of [
    { failurePoint: 'status event', label: 'native permission failure', code: 'EPERM', semanticCause: false, retryable: true },
    { failurePoint: 'TASK.md publication', label: 'native permission failure', code: 'EPERM', semanticCause: false, retryable: true },
    { failurePoint: 'TASK.md publication', label: 'native permission failure plus EPERM rollback failure', code: 'EPERM', semanticCause: false, secondaryRollbackCode: 'EPERM', retryable: true },
    { failurePoint: 'TASK.md publication', label: 'native permission failure plus EIO rollback failure', code: 'EPERM', semanticCause: false, secondaryRollbackCode: 'EIO', retryable: true },
    { failurePoint: 'TASK.md publication', label: 'semantic failure plus EPERM rollback failure', code: 'EINVAL', semanticCause: false, secondaryRollbackCode: 'EPERM', retryable: false },
    { failurePoint: 'TASK.md lock', label: 'native permission failure', code: 'EPERM', semanticCause: false, retryable: true },
    { failurePoint: 'TASK.md lock', label: 'structural failure', code: 'EINVAL', semanticCause: false, retryable: false },
    { failurePoint: 'TASK.md lock', label: 'permission-coded wrapper over semantic failure', code: 'EPERM', semanticCause: true, retryable: false }
] as const) {
test(`completion-gate classifies child ${scenario.failurePoint} ${scenario.label} from its primary cause`, async () => {
    const repoRoot = createTempRepo();
    try {
        const preflightPath = await prepareValidatedCompletion(repoRoot);
        const taskPath = path.join(repoRoot, 'TASK.md');
        const queueSnapshot = fs.readFileSync(taskPath, 'utf8');
        const secondaryRollbackCode = 'secondaryRollbackCode' in scenario ? scenario.secondaryRollbackCode : null;

        let injected = false;
        let rollbackFailureInjected = false;
        const primaryError = Object.assign(new Error('child finalization operation failed', scenario.semanticCause
            ? { cause: new Error('queue ownership binding changed') } : undefined), { code: scenario.code });
        if (scenario.failurePoint === 'status event') {
            const originalAppend = taskEventWrites.appendTaskEventLineAsync;
            mock.method(taskEventWrites, 'appendTaskEventLineAsync', async (...args: Parameters<typeof originalAppend>) => {
                if (!injected && args[2].event_type === 'STATUS_CHANGED') {
                    injected = true;
                    throw primaryError;
                }
                return originalAppend(...args);
            });
        } else if (scenario.failurePoint === 'TASK.md publication') {
            const originalWrite = taskQueueRepository.writeTaskQueueFile;
            mock.method(taskQueueRepository, 'writeTaskQueueFile', (...args: Parameters<typeof originalWrite>) => {
                if (!injected && path.resolve(args[0]) === path.join(repoRoot, 'TASK.md')) {
                    injected = true;
                    throw primaryError;
                }
                return originalWrite(...args);
            });
        } else {
            const originalAcquire = queueLocking.acquireFilesystemLock;
            mock.method(queueLocking, 'acquireFilesystemLock', (...args: Parameters<typeof originalAcquire>) => {
                if (!injected && path.resolve(args[0]) === path.join(repoRoot, 'TASK.md.garda-status-sync.lock')) {
                    injected = true;
                    throw primaryError;
                }
                return originalAcquire(...args);
            });
        }
        if (secondaryRollbackCode) {
            const originalWrite = filesystem.writeFileAtomically;
            mock.method(filesystem, 'writeFileAtomically', (...args: Parameters<typeof originalWrite>) => {
                if (!rollbackFailureInjected && injected && path.resolve(args[0]) === taskPath && args[1] === queueSnapshot) {
                    rollbackFailureInjected = true;
                    throw Object.assign(new Error(`${secondaryRollbackCode}: secondary TASK.md snapshot restore failed`), { code: secondaryRollbackCode });
                }
                return originalWrite(...args);
            });
        }
        try {
            await assert.rejects(handleCompletionGate(['--task-id', taskId, '--preflight-path', preflightPath, '--repo-root', repoRoot]),
                /finalization failed after validation PASS/);
        } finally {
            mock.restoreAll();
        }
        assert.equal(injected, true);
        assert.equal(rollbackFailureInjected, secondaryRollbackCode !== null);
        const before = readTaskTimelineEvents(repoRoot, taskId);
        const failure = [...before].reverse().find(event => event.event_type === 'COMPLETION_GATE_FAILED');
        assert.equal((failure?.details as Record<string, unknown>)?.outcome, 'FINALIZATION_FAILED');
        assert.equal((failure?.details as Record<string, unknown>)?.finalization_retryable, scenario.retryable, JSON.stringify(failure?.details));
        if (secondaryRollbackCode) {
            assert.match(String((failure?.details as Record<string, unknown>)?.finalization_error),
                /Rollback failed: TASK\.md restore failed: (?:EPERM|EIO): secondary TASK\.md snapshot restore failed/);
            assert.equal(fs.readFileSync(taskPath, 'utf8'), queueSnapshot);
        }
        assert.notEqual(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        const navigation = resolveNextStep({ repoRoot, taskId });
        if (!scenario.retryable) {
            assert.notEqual(navigation.next_gate, 'completion-gate', JSON.stringify(navigation));
            return;
        }
        assert.equal(navigation.next_gate, 'completion-gate', JSON.stringify(navigation));

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
}

for (const scenario of [
    { label: 'native parent STATUS_CHANGED failure', failurePoint: 'status event', primaryCode: 'EPERM', secondaryRollbackFailure: false, retryable: true },
    { label: 'native parent STATUS_CHANGED failure plus rollback failure', failurePoint: 'status event', primaryCode: 'EPERM', secondaryRollbackFailure: true, retryable: true },
    { label: 'semantic parent append failure plus native rollback failure', failurePoint: 'status event', primaryCode: 'EINVAL', secondaryRollbackFailure: true, retryable: false },
    { label: 'native parent TASK.md publication failure', failurePoint: 'publication', primaryCode: 'EPERM', secondaryRollbackFailure: false, retryable: true },
    { label: 'native parent TASK.md publication failure plus rollback failure', failurePoint: 'publication', primaryCode: 'EPERM', secondaryRollbackFailure: true, retryable: true },
    { label: 'semantic parent publication failure plus native rollback failure', failurePoint: 'publication', primaryCode: 'EINVAL', secondaryRollbackFailure: true, retryable: false },
    { label: 'native parent TASK.md lock failure', failurePoint: 'lock', primaryCode: 'EPERM', secondaryRollbackFailure: false, retryable: true }
] as const) {
test(`completion-gate classifies ${scenario.label} from the primary cause`, async () => {
    const repoRoot = createTempRepo();
    const parentTaskId = 'T-905-parent-finalization-retry';
    try {
        const preflightPath = await prepareValidatedCompletion(repoRoot, parentTaskId);
        const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        appendMandatoryTaskEvent(orchestratorRoot, parentTaskId, 'PARENT_RETRY_FIXTURE', 'INFO',
            'Parent timeline existed before the final child completed.', {});
        const parentTimelinePath = path.join(orchestratorRoot, 'runtime', 'task-events', `${parentTaskId}.jsonl`);
        const parentTimelineSnapshot = fs.readFileSync(parentTimelinePath, 'utf8');
        const reviewLaunchSnapshots = ['reviewer-launch.json', 'reviewer-launch-input.json'].map(name => {
            const filePath = path.join(orchestratorRoot, 'runtime', 'tmp', 'reviews', taskId, 'code', name);
            return { path: filePath, bytes: fs.readFileSync(filePath) };
        });
        let primaryFailureInjected = false;
        let rollbackFailureInjected = false;
        const primaryError = Object.assign(new Error(`primary parent ${scenario.failurePoint} failed`), { code: scenario.primaryCode });
        if (scenario.failurePoint === 'status event') {
            const originalAppend = taskEventWrites.appendTaskEventLineSync;
            mock.method(taskEventWrites, 'appendTaskEventLineSync', (...args: Parameters<typeof originalAppend>) => {
                if (!primaryFailureInjected && args[2].task_id === parentTaskId && args[2].event_type === 'STATUS_CHANGED') {
                    primaryFailureInjected = true;
                    throw primaryError;
                }
                return originalAppend(...args);
            });
        } else if (scenario.failurePoint === 'publication') {
            const originalWrite = taskQueueRepository.writeTaskQueueFile;
            const parentDoneRow = new RegExp(`^\\|\\s*${parentTaskId}\\s*\\|[^|]*\\bDONE\\b`, 'mu');
            mock.method(taskQueueRepository, 'writeTaskQueueFile', (...args: Parameters<typeof originalWrite>) => {
                if (!primaryFailureInjected && path.resolve(args[0]) === path.join(repoRoot, 'TASK.md') && parentDoneRow.test(String(args[1]))) {
                    primaryFailureInjected = true;
                    throw primaryError;
                }
                return originalWrite(...args);
            });
        } else {
            const originalAcquire = queueLocking.acquireFilesystemLock;
            mock.method(queueLocking, 'acquireFilesystemLock', (...args: Parameters<typeof originalAcquire>) => {
                if (!primaryFailureInjected && path.resolve(args[0]) === path.join(repoRoot, 'TASK.md.garda-status-sync.lock')
                    && readTaskQueueStatusFromTaskFile(repoRoot, taskId) === 'DONE') {
                    primaryFailureInjected = true;
                    throw primaryError;
                }
                return originalAcquire(...args);
            });
        }
        if (scenario.secondaryRollbackFailure) {
            const originalWrite = filesystem.writeFileAtomically;
            mock.method(filesystem, 'writeFileAtomically', (...args: Parameters<typeof originalWrite>) => {
                if (!rollbackFailureInjected && primaryFailureInjected
                    && path.resolve(args[0]) === parentTimelinePath && args[1] === parentTimelineSnapshot) {
                    rollbackFailureInjected = true;
                    throw Object.assign(new Error('EIO: secondary parent timeline restore failed'), { code: 'EIO' });
                }
                return originalWrite(...args);
            });
        }
        try {
            await assert.rejects(handleCompletionGate(['--task-id', taskId, '--preflight-path', preflightPath, '--repo-root', repoRoot]),
                /mandatory decomposed parent auto-close failed/);
        } finally {
            mock.restoreAll();
        }

        assert.equal(primaryFailureInjected, true);
        assert.equal(rollbackFailureInjected, scenario.secondaryRollbackFailure);
        const before = readTaskTimelineEvents(repoRoot, taskId);
        const failure = [...before].reverse().find(event => event.event_type === 'COMPLETION_GATE_FAILED');
        const details = failure?.details as Record<string, unknown>;
        assert.equal(details.outcome, 'FINALIZATION_FAILED');
        assert.equal(details.finalization_retryable, scenario.retryable, JSON.stringify(details));
        assert.equal(details.closeout_linkage_recovery, null);
        if (scenario.secondaryRollbackFailure) {
            assert.match(String(details.finalization_error), /Parent auto-close rollback failed: .*EIO: secondary parent timeline restore failed/);
        }
        assert.notEqual(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, parentTaskId), 'DECOMPOSED');
        for (const snapshot of reviewLaunchSnapshots) {
            assert.deepEqual(fs.readFileSync(snapshot.path), snapshot.bytes, 'rollback must preserve the original authenticated launch evidence');
        }
        const navigation = resolveNextStep({ repoRoot, taskId });
        if (!scenario.retryable) {
            assert.notEqual(navigation.next_gate, 'completion-gate', JSON.stringify(navigation));
            return;
        }
        assert.equal(navigation.next_gate, 'completion-gate', JSON.stringify(navigation));

        await handleCompletionGate(['--task-id', taskId, '--preflight-path', preflightPath, '--repo-root', repoRoot]);

        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, parentTaskId), 'DONE');
        assert.ok(reviewLaunchSnapshots.every(snapshot => !fs.existsSync(snapshot.path)), 'successful finalization may clean up review launch scratch');
        assert.ok(readTaskTimelineEvents(repoRoot, parentTaskId).some(event => event.event_type === 'DECOMPOSED_PARENT_COMPLETED'));
        const summary = buildTaskAuditSummary({ repoRoot, taskId });
        assert.equal(summary.status, 'PASS', JSON.stringify(summary.blockers));
        const after = readTaskTimelineEvents(repoRoot, taskId);
        for (const eventType of ['PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'REVIEW_GATE_PASSED']) {
            assert.equal(after.filter(event => event.event_type === eventType).length,
                before.filter(event => event.event_type === eventType).length, eventType);
        }
    } finally {
        mock.restoreAll();
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
}

test('completion-gate keeps committed child and parent success when deferred cleanup partially deletes scratch and fails', async () => {
    const repoRoot = createTempRepo();
    const parentTaskId = 'T-905-parent-cleanup-failure';
    try {
        const preflightPath = await prepareValidatedCompletion(repoRoot, parentTaskId);
        const launchInputPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch-input.json');
        let cleanupReached = false;
        mock.method(gateArtifacts, 'cleanupTerminalReviewTempOutputs', () => {
            cleanupReached = true;
            assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
            assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, parentTaskId), 'DONE');
            assert.ok(readTaskTimelineEvents(repoRoot, parentTaskId).some(event => event.event_type === 'DECOMPOSED_PARENT_COMPLETED'));
            fs.rmSync(launchInputPath);
            throw Object.assign(new Error('EPERM: partial terminal scratch cleanup failed'), { code: 'EPERM' });
        });
        try {
            await handleCompletionGate(['--task-id', taskId, '--preflight-path', preflightPath, '--repo-root', repoRoot]);
        } finally {
            mock.restoreAll();
        }
        assert.equal(cleanupReached, true);
        assert.equal(fs.existsSync(launchInputPath), false);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, parentTaskId), 'DONE');
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some(event => event.event_type === 'COMPLETION_GATE_FAILED'), false);
        const summary = buildTaskAuditSummary({ repoRoot, taskId });
        assert.equal(summary.status, 'PASS', JSON.stringify(summary.blockers));
    } finally {
        mock.restoreAll();
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('completion-gate keeps a semantic closeout failure non-retryable when final-report rollback also gets EPERM', async () => {
    const repoRoot = createTempRepo();
    try {
        const preflightPath = await prepareValidatedCompletion(repoRoot);
        const finalUserReportPath = path.join(getReviewsRoot(repoRoot), `${taskId}-final-user-report.md`);
        const reportSnapshot = 'Previous final-user-report snapshot\n';
        fs.writeFileSync(finalUserReportPath, reportSnapshot, 'utf8');
        let semanticFailureInjected = false;
        let rollbackFailureInjected = false;
        const originalSynchronize = closeoutSync.synchronizeFinalCloseoutArtifacts;
        mock.method(closeoutSync, 'synchronizeFinalCloseoutArtifacts', (summary: Parameters<typeof originalSynchronize>[0]) => {
            assert.equal(summary.status, 'PASS', JSON.stringify(summary.blockers));
            semanticFailureInjected = true;
            summary.status = 'BLOCKED';
            summary.final_closeout.audit_status = 'BLOCKED';
            summary.final_closeout.status = 'NOT_READY';
            return originalSynchronize(summary);
        });
        const originalWrite = filesystem.writeFileAtomically;
        mock.method(filesystem, 'writeFileAtomically', (...args: Parameters<typeof originalWrite>) => {
            if (!rollbackFailureInjected && path.resolve(args[0]) === finalUserReportPath && args[1] === reportSnapshot) {
                rollbackFailureInjected = true;
                throw Object.assign(new Error('EPERM: operation not permitted, restore final report'), { code: 'EPERM' });
            }
            return originalWrite(...args);
        });
        try {
            await assert.rejects(handleCompletionGate(['--task-id', taskId, '--preflight-path', preflightPath, '--repo-root', repoRoot]),
                /finalization failed after validation PASS/);
        } finally {
            mock.restoreAll();
        }

        assert.equal(semanticFailureInjected, true);
        assert.equal(rollbackFailureInjected, true);
        const failure = readTaskTimelineEvents(repoRoot, taskId).reverse().find(event => event.event_type === 'COMPLETION_GATE_FAILED');
        const details = failure?.details as Record<string, unknown>;
        assert.equal(details.outcome, 'FINALIZATION_FAILED');
        assert.match(String(details.finalization_error), /audit_status=BLOCKED/);
        assert.match(String(details.finalization_error), /Rollback failed: .*final-user-report\.md restore failed: EPERM:/);
        assert.equal(details.finalization_retryable, false, JSON.stringify(details));
        assert.equal(details.closeout_linkage_recovery, null);
        assert.notEqual(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        const navigation = resolveNextStep({ repoRoot, taskId });
        assert.notEqual(navigation.next_gate, 'completion-gate', JSON.stringify(navigation));
    } finally {
        mock.restoreAll();
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
