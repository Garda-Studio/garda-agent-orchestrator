import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeBudgetOutputFilters } from '../../gate-test-helpers';

import { syncTaskQueueStatus } from '../../../../../../src/cli/commands/gate-flows/task/task-queue-sync';
import { handleCompletionGate } from '../../../../../../src/cli/commands/gate-task-handlers';
import {
    runCompileGateCommand,
    runDocImpactGateCommand
} from '../../../../../../src/cli/commands/gates';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import type {
    AcquireLockTelemetry,
    LockOptions
} from '../../../../../../src/gate-runtime/timeline/task-events-locking-types';

import {
    captureExpectedAsyncError,
    createTempRepo,
    getOrchestratorRoot,
    loadTaskEntryRulePack,
    loadTaskEventsIoModule,
    loadTimelineSummaryModule,
    loadPostPreflightRulePack,
    readTaskQueueStatusFromTaskFile,
    readTaskTimelineEvents,
    runRequiredReviewsCheckCommand,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue,
    writeCleanReviewArtifact,
    writePreflight
} from './gates-completion-fixtures';

describe('cli/commands/gates', () => {
    test('completion-gate rolls back queue and status telemetry when COMPLETION_GATE_PASSED append fails', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-pass-rollback';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-pass-rollback.md');
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
            taskSummary: 'Roll back queue and status telemetry when completion pass append fails'
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
            rationale: 'Completion pass rollback regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        const lockingModule = require('../../../../../../src/gate-runtime/timeline/task-events-locking-acquire') as typeof import('../../../../../../src/gate-runtime/timeline/task-events-locking-acquire');
        const originalWithFilesystemLock = lockingModule.withFilesystemLock;
        const taskLockName = `.${taskId}.lock`;
        const aggregateLockName = '.all-tasks.lock';
        const rollbackLockOrder: string[] = [];
        const activeRollbackLocks: string[] = [];
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                throw new Error('Injected COMPLETION_GATE_PASSED append failure');
            }
            return originalAppendTaskEventAsync(...args);
        };
        lockingModule.withFilesystemLock = function instrumentedWithFilesystemLock<T>(
            lockPath: string,
            options: LockOptions,
            callback: () => T
        ): { result: T; telemetry: AcquireLockTelemetry } {
            const lockName = path.basename(lockPath);
            if (lockName !== taskLockName && lockName !== aggregateLockName) {
                return originalWithFilesystemLock(lockPath, options, callback);
            }
            return originalWithFilesystemLock(lockPath, options, () => {
                if (lockName === aggregateLockName) {
                    assert.deepEqual(
                        activeRollbackLocks,
                        [taskLockName],
                        'completion rollback must enter aggregate while holding the task lock'
                    );
                }
                rollbackLockOrder.push(lockName);
                activeRollbackLocks.push(lockName);
                try {
                    return callback();
                } finally {
                    assert.equal(activeRollbackLocks.pop(), lockName);
                }
            });
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /gate completion-gate/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
            lockingModule.withFilesystemLock = originalWithFilesystemLock;
        }

        assert.deepEqual(rollbackLockOrder, [taskLockName, aggregateLockName]);
        assert.deepEqual(activeRollbackLocks, []);

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must not be recorded when completion event append fails'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0,
            'DONE status transition must not remain durable when completion append fails'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        const repairedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            repairedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            1
        );
        const latestRepairedStatusTransition = [...repairedEvents]
            .reverse()
            .find((event) => event.event_type === 'STATUS_CHANGED');
        assert.equal(
            String((latestRepairedStatusTransition?.details as Record<string, unknown> | undefined)?.new_status || '').toUpperCase(),
            'DONE'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate rollback preserves foreign aggregate and summary updates appended after the current task write', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-pass-cross-task-rollback';
        const foreignTaskId = 'T-903-foreign-summary-preserved';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-pass-cross-task-rollback.md');
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
            taskSummary: 'Preserve foreign aggregate and summary updates during completion rollback'
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
            rationale: 'Cross-task completion rollback regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        const timelineSummaryPath = path.join(taskEventsRoot, '.timeline-summary.json');
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                await originalAppendTaskEventAsync(...args);
                appendTaskEvent(
                    getOrchestratorRoot(repoRoot),
                    foreignTaskId,
                    'PLAN_CREATED',
                    'INFO',
                    'Foreign task event during completion rollback regression fixture.',
                    {
                        task_summary: 'Foreign task event must survive rollback'
                    }
                );
                throw new Error('Injected post-append failure after foreign task event');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /Injected post-append failure after foreign task event/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'current task completion pass must be removed during rollback'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0,
            'current task DONE status transition must be removed during rollback'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');

        const foreignTaskEvents = readTaskTimelineEvents(repoRoot, foreignTaskId);
        assert.equal(
            foreignTaskEvents.filter((event) => event.event_type === 'PLAN_CREATED').length,
            1,
            'foreign task timeline event must survive current-task rollback'
        );

        const aggregateLines = fs.readFileSync(aggregatePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(
            aggregateLines.filter((entry) => (
                String(entry.task_id || '').trim() === taskId
                && String(entry.event_type || '').trim() === 'COMPLETION_GATE_PASSED'
            )).length,
            0,
            'current task completion aggregate entry must be removed during rollback'
        );
        assert.equal(
            aggregateLines.filter((entry) => (
                String(entry.task_id || '').trim() === foreignTaskId
                && String(entry.event_type || '').trim() === 'PLAN_CREATED'
            )).length,
            1,
            'foreign aggregate entry must survive current-task rollback'
        );

        const timelineSummaryIndex = JSON.parse(fs.readFileSync(timelineSummaryPath, 'utf8')) as {
            entries?: Record<string, { events_found?: string[]; integrity_event_count?: number }>;
        };
        assert.equal(
            Array.isArray(timelineSummaryIndex.entries?.[taskId]?.events_found)
                ? timelineSummaryIndex.entries?.[taskId]?.events_found?.includes('COMPLETION_GATE_PASSED')
                : false,
            false,
            'current task timeline summary must be reconciled back to the pre-completion state'
        );
        assert.ok(timelineSummaryIndex.entries?.[foreignTaskId], 'foreign task timeline summary entry must survive current-task rollback');
        assert.equal(
            Number(timelineSummaryIndex.entries?.[foreignTaskId]?.integrity_event_count || 0) >= 1,
            true,
            'foreign task timeline summary entry must retain the recorded foreign event state'
        );

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        const repairedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            repairedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            1
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate refuses destructive rollback when a same-task event lands after the partial finalization write', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-pass-same-task-guard';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-pass-same-task-guard.md');
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
            taskSummary: 'Detect same-task concurrent append before destructive completion rollback'
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
            rationale: 'Same-task concurrent rollback guard regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const baselinePlanCreatedCount = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'PLAN_CREATED').length;
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                await originalAppendTaskEventAsync(...args);
                appendTaskEvent(
                    getOrchestratorRoot(repoRoot),
                    taskId,
                    'PLAN_CREATED',
                    'INFO',
                    'Same-task event appended after partial completion write.',
                    {
                        task_summary: 'Same-task concurrency guard fixture'
                    }
                );
                throw new Error('Injected post-append failure after same-task event');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /same-task concurrent append detected before rollback/i);
            assert.match(error.message, /Injected post-append failure after same-task event/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'PLAN_CREATED').length,
            baselinePlanCreatedCount + 1,
            'same-task guard must not erase the concurrently appended task event'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate refuses destructive rollback when a same-task unsequenced line lands after the partial finalization write', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-pass-unsequenced-same-task-guard';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-pass-unsequenced-same-task-guard.md');
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
            taskSummary: 'Detect same-task unsequenced append before destructive completion rollback'
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
            rationale: 'Same-task unsequenced rollback guard regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskTimelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                await originalAppendTaskEventAsync(...args);
                fs.appendFileSync(taskTimelinePath, `${JSON.stringify({
                    task_id: taskId,
                    event_type: 'PLAN_CREATED',
                    details: {
                        task_summary: 'Same-task unsequenced concurrency guard fixture'
                    },
                    marker: 'NO_SEQUENCE'
                })}\n`, 'utf8');
                throw new Error('Injected post-append failure after same-task unsequenced event');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /same-task concurrent append detected before rollback/i);
            assert.match(error.message, /Injected post-append failure after same-task unsequenced event/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        assert.equal(
            fs.readFileSync(taskTimelinePath, 'utf8').includes('"marker":"NO_SEQUENCE"'),
            true,
            'same-task rollback guard must not erase the concurrently appended unsequenced timeline line'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate refuses destructive rollback when a same-task event lands after a partial STATUS_CHANGED write', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-status-same-task-guard';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-status-same-task-guard.md');
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
            taskSummary: 'Detect same-task concurrent append before destructive rollback after STATUS_CHANGED'
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
            rationale: 'Same-task concurrent STATUS_CHANGED rollback guard regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const baselinePlanCreatedCount = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'PLAN_CREATED').length;
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'STATUS_CHANGED') {
                await originalAppendTaskEventAsync(...args);
                appendTaskEvent(
                    getOrchestratorRoot(repoRoot),
                    taskId,
                    'PLAN_CREATED',
                    'INFO',
                    'Same-task event appended after partial STATUS_CHANGED write.',
                    {
                        task_summary: 'Same-task STATUS_CHANGED concurrency guard fixture'
                    }
                );
                throw new Error('Injected post-append failure after same-task STATUS_CHANGED event');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /same-task concurrent append detected before rollback/i);
            assert.match(error.message, /Injected post-append failure after same-task STATUS_CHANGED event/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'PLAN_CREATED').length,
            baselinePlanCreatedCount + 1,
            'same-task STATUS_CHANGED guard must not erase the concurrently appended task event'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must not be appended when STATUS_CHANGED finalization already failed'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate refuses destructive rollback when a foreign STATUS_CHANGED event matches the allowed type', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-status-same-type-guard';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-status-same-type-guard.md');
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
            taskSummary: 'Detect foreign STATUS_CHANGED event even when the event type matches the allowed rollback tail'
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
            rationale: 'Foreign STATUS_CHANGED same-type rollback guard regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'STATUS_CHANGED') {
                appendTaskEvent(
                    getOrchestratorRoot(repoRoot),
                    taskId,
                    'STATUS_CHANGED',
                    'INFO',
                    'Task status changed: IN_REVIEW → BLOCKED.',
                    {
                        previous_status: 'IN_REVIEW',
                        new_status: 'BLOCKED'
                    }
                );
                throw new Error('Injected failure before STATUS_CHANGED append after foreign same-type event');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /same-task concurrent append detected before rollback/i);
            assert.match(error.message, /Injected failure before STATUS_CHANGED append after foreign same-type event/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'BLOCKED'
            )).length,
            1,
            'foreign STATUS_CHANGED event must survive when its details do not match the expected finalization transition'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate refuses destructive rollback when a same-task event lands before COMPLETION_GATE_PASSED writes anything', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-pre-pass-same-task-guard';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-pre-pass-same-task-guard.md');
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
            taskSummary: 'Detect same-task concurrent append before COMPLETION_GATE_PASSED writes'
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
            rationale: 'Same-task concurrent append before completion pass write regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const baselinePlanCreatedCount = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'PLAN_CREATED').length;
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                appendTaskEvent(
                    getOrchestratorRoot(repoRoot),
                    taskId,
                    'PLAN_CREATED',
                    'INFO',
                    'Same-task event appended before COMPLETION_GATE_PASSED could write.',
                    {
                        task_summary: 'Same-task pre-pass concurrency guard fixture'
                    }
                );
                throw new Error('Injected failure before COMPLETION_GATE_PASSED append after same-task event');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /same-task concurrent append detected before rollback/i);
            assert.match(error.message, /Injected failure before COMPLETION_GATE_PASSED append after same-task event/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'PLAN_CREATED').length,
            baselinePlanCreatedCount + 1,
            'same-task pre-pass guard must not erase the concurrently appended task event'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must remain absent when the failure happened before the append'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate rollback preserves foreign summary entries when the existing summary index is version-skewed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-version-skew-summary-rollback';
        const foreignTaskId = 'T-903-version-skew-summary-foreign';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-version-skew-summary-rollback.md');
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
            taskSummary: 'Preserve foreign summary entries when rollback sees a version-skewed summary index'
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
            rationale: 'Version-skewed summary rollback regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const timelineSummaryPath = path.join(taskEventsRoot, '.timeline-summary.json');
        const currentSummaryIndex = JSON.parse(fs.readFileSync(timelineSummaryPath, 'utf8')) as {
            entries: Record<string, unknown>;
            updated_at_utc: string;
        };
        const currentTaskSummaryEntry = currentSummaryIndex.entries[taskId] as Record<string, unknown> | undefined;
        assert.ok(currentTaskSummaryEntry, 'current task summary entry must exist before synthesizing a version-skewed foreign entry');
        fs.writeFileSync(timelineSummaryPath, JSON.stringify({
            version: 1,
            updated_at_utc: currentSummaryIndex.updated_at_utc,
            entries: {
                ...currentSummaryIndex.entries,
                [foreignTaskId]: {
                    ...currentTaskSummaryEntry,
                    task_id: foreignTaskId
                }
            }
        }, null, 2) + '\n', 'utf8');
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                await originalAppendTaskEventAsync(...args);
                throw new Error('Injected post-append failure on version-skewed summary rollback fixture');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /Injected post-append failure on version-skewed summary rollback fixture/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const restoredSummaryIndex = JSON.parse(fs.readFileSync(timelineSummaryPath, 'utf8')) as {
            version: number;
            entries?: Record<string, { task_id?: string }>;
        };
        assert.equal(restoredSummaryIndex.version, 2, 'rollback reconcile should normalize the summary index back to the canonical version');
        assert.ok(restoredSummaryIndex.entries?.[foreignTaskId], 'foreign summary entry must survive rollback on a version-skewed index');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate aggregate rollback keeps the original aggregate log intact when the rollback temp write fails', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-aggregate-rollback-temp-write-failure';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-aggregate-rollback-temp-write-failure.md');
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
            taskSummary: 'Keep aggregate log intact when rollback temp write fails'
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
            rationale: 'Aggregate rollback temp-write failure regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        const baselineAggregateContent = fs.readFileSync(aggregatePath, 'utf8');
        const fsModule = require('node:fs') as typeof import('node:fs');
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        const originalRenameSync = fsModule.renameSync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                await originalAppendTaskEventAsync(...args);
                throw new Error('Injected post-append failure before aggregate rollback atomic promotion failure');
            }
            return originalAppendTaskEventAsync(...args);
        };
        fsModule.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
            if (path.resolve(String(newPath)) === path.resolve(aggregatePath)) {
                throw new Error('Injected aggregate rollback atomic promotion failure');
            }
            return originalRenameSync(oldPath, newPath);
        }) as typeof fsModule.renameSync;

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /Injected aggregate rollback atomic promotion failure/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
            fsModule.renameSync = originalRenameSync;
        }

        const aggregateContentAfterFailure = fs.readFileSync(aggregatePath, 'utf8');
        assert.equal(
            aggregateContentAfterFailure.startsWith(baselineAggregateContent),
            true,
            'aggregate rollback atomic promotion failure must not corrupt or replace the original aggregate log content'
        );
        assert.equal(
            aggregateContentAfterFailure.includes('"event_type":"COMPLETION_GATE_PASSED"'),
            true,
            'aggregate log must retain the pre-rollback partial completion entry when the rollback temp write fails'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate rollback drops current-task aggregate rows that are missing integrity metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-aggregate-missing-integrity-rollback';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-aggregate-missing-integrity-rollback.md');
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
            taskSummary: 'Drop current-task aggregate rows that are missing integrity metadata during rollback'
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
            rationale: 'Aggregate missing-integrity rollback regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                await originalAppendTaskEventAsync(...args);
                fs.appendFileSync(aggregatePath, `${JSON.stringify({
                    task_id: taskId,
                    event_type: 'PLAN_CREATED',
                    corrupt_marker: 'NO_INTEGRITY'
                })}\n`, 'utf8');
                throw new Error('Injected post-append failure after adding a current-task aggregate row without integrity');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /without integrity/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const aggregateContentAfterFailure = fs.readFileSync(aggregatePath, 'utf8');
        assert.equal(
            aggregateContentAfterFailure.includes('"corrupt_marker":"NO_INTEGRITY"'),
            false,
            'rollback must prune current-task aggregate rows that cannot be trusted because integrity metadata is missing'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate rollback preserves baseline aggregate rows that already lack integrity metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-aggregate-baseline-missing-integrity-preserved';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-aggregate-baseline-missing-integrity-preserved.md');
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
            taskSummary: 'Preserve baseline aggregate rows without integrity metadata during rollback'
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
            rationale: 'Baseline aggregate missing-integrity preservation regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        fs.appendFileSync(aggregatePath, `${JSON.stringify({
            task_id: taskId,
            event_type: 'PLAN_CREATED',
            legacy_marker: 'BASELINE_NO_INTEGRITY'
        })}\n`, 'utf8');
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                await originalAppendTaskEventAsync(...args);
                fs.appendFileSync(aggregatePath, `${JSON.stringify({
                    task_id: taskId,
                    event_type: 'PLAN_CREATED',
                    corrupt_marker: 'NO_INTEGRITY'
                })}\n`, 'utf8');
                throw new Error('Injected post-append failure after adding a current-task aggregate row without integrity');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /without integrity/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const aggregateContentAfterFailure = fs.readFileSync(aggregatePath, 'utf8');
        assert.equal(
            aggregateContentAfterFailure.includes('"legacy_marker":"BASELINE_NO_INTEGRITY"'),
            true,
            'rollback must preserve baseline aggregate rows that already lacked integrity metadata before finalization'
        );
        assert.equal(
            aggregateContentAfterFailure.includes('"corrupt_marker":"NO_INTEGRITY"'),
            false,
            'rollback must still prune the newly appended current-task aggregate row without integrity metadata'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate does not duplicate DONE status when the existing current-cycle STATUS_CHANGED event is missing sequence metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-missing-sequence-status-dedup';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-missing-sequence-status-dedup.md');
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
            taskSummary: 'Avoid duplicate DONE status writes when STATUS_CHANGED sequence metadata is missing'
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
            rationale: 'Missing-sequence STATUS_CHANGED dedup regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        syncTaskQueueStatus(repoRoot, taskId, 'DONE');
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'STATUS_CHANGED',
            'INFO',
            'Task status changed: IN_REVIEW → DONE.',
            {
                previous_status: 'IN_REVIEW',
                new_status: 'DONE'
            }
        );

        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const timelineLines = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const doneStatusIndex = [...timelineLines]
            .reverse()
            .findIndex((entry) => (
                String(entry.event_type || '').trim() === 'STATUS_CHANGED'
                && typeof entry.details === 'object'
                && !Array.isArray(entry.details)
                && String(((entry.details as Record<string, unknown>).new_status) || '').toUpperCase() === 'DONE'
            ));
        assert.notEqual(doneStatusIndex, -1, 'fixture must contain a current-cycle DONE status event before sequence stripping');
        const actualDoneStatusIndex = timelineLines.length - 1 - doneStatusIndex;
        delete timelineLines[actualDoneStatusIndex].sequence;
        fs.writeFileSync(timelinePath, `${timelineLines.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        const repairedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            repairedEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            1,
            'missing sequence metadata on the existing DONE transition must not trigger a duplicate STATUS_CHANGED append'
        );
        assert.equal(
            repairedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            1,
            'completion finalization must still record the missing completion pass evidence'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate restores TASK.md when timeline rollback succeeded but summary reconciliation fails afterwards', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-summary-rollback-failure';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-summary-rollback-failure.md');
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
            taskSummary: 'Restore TASK.md after rollback summary reconciliation failure'
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
            rationale: 'Rollback summary reconcile failure regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        const timelineSummaryModule = loadTimelineSummaryModule();
        const originalReconcileTimelineSummaryForTask = timelineSummaryModule.reconcileTimelineSummaryForTask;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                await originalAppendTaskEventAsync(...args);
                throw new Error('Injected post-append failure before summary reconcile');
            }
            return originalAppendTaskEventAsync(...args);
        };
        timelineSummaryModule.reconcileTimelineSummaryForTask = (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId) {
                throw new Error('Injected timeline summary reconcile failure');
            }
            return originalReconcileTimelineSummaryForTask(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /Injected timeline summary reconcile failure/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
            timelineSummaryModule.reconcileTimelineSummaryForTask = originalReconcileTimelineSummaryForTask;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must still be removed when the task timeline rollback succeeded'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0,
            'DONE status transition must still be removed when the task timeline rollback succeeded'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
