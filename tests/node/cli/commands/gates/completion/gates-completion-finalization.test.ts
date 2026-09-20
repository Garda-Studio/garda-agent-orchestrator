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
import { runTaskAuditSummaryCommand } from '../../../../../../src/cli/commands/gate-flows/task/task-summary-flow';
import { EXIT_GATE_FAILURE } from '../../../../../../src/cli/exit-codes';
import { runCliMain } from '../../../../../../src/cli/main';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';

import {
    captureExpectedAsyncError,
    createTempRepo,
    getOrchestratorRoot,
    getReviewsRoot,
    loadTaskEntryRulePack,
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
    writePreflight,
    writeReceiptBackedReviewArtifact
} from './gates-completion-fixtures';

describe('cli/commands/gates', () => {
    test('completion-gate keeps canonical completion pass when aggregate append warns after TASK.md is already DONE', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-pass-warning-committed';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-pass-warning-committed.md');
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
            taskSummary: 'Keep canonical completion pass when aggregate append reports warnings after write'
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
            rationale: 'Completion pass derived-warning commit regression fixture only.',
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

        const baselineEvents = readTaskTimelineEvents(repoRoot, taskId);
        const baselineCompletionCount = baselineEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length;
        const baselineDoneStatusCount = baselineEvents.filter((event) => (
            event.event_type === 'STATUS_CHANGED'
            && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
            && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
        )).length;

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        const timelineSummaryPath = path.join(taskEventsRoot, '.timeline-summary.json');
        const baselineAggregateContent = fs.existsSync(aggregatePath) && fs.statSync(aggregatePath).isFile()
            ? fs.readFileSync(aggregatePath, 'utf8')
            : null;
        const baselineAggregateEntries = baselineAggregateContent === null
            ? []
            : baselineAggregateContent
                .split('\n')
                .filter((line) => line.trim().length > 0)
                .map((line) => JSON.parse(line) as Record<string, unknown>);
        const baselineTimelineSummaryContent = fs.existsSync(timelineSummaryPath) && fs.statSync(timelineSummaryPath).isFile()
            ? fs.readFileSync(timelineSummaryPath, 'utf8')
            : null;
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalAppendFileSync = fsModule.appendFileSync;
        let injectedAggregateFailure = false;

        try {
            fsModule.appendFileSync = ((filePath: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) => {
                const normalizedPath = typeof filePath === 'string' ? path.resolve(filePath) : '';
                const payload = typeof data === 'string' ? data : '';
                if (
                    !injectedAggregateFailure
                    && normalizedPath === path.resolve(aggregatePath)
                    && payload.includes('"event_type":"COMPLETION_GATE_PASSED"')
                ) {
                    injectedAggregateFailure = true;
                    throw new Error('Injected aggregate append failure');
                }
                return originalAppendFileSync(filePath, data, options);
            }) as typeof fsModule.appendFileSync;

            await handleCompletionGate([
                '--preflight-path', preflightPath,
                '--task-id', taskId,
                '--repo-root', repoRoot
            ]);
            assert.equal(injectedAggregateFailure, true, 'aggregate append failure must be injected during the derived-warning scenario');
        } finally {
            fsModule.appendFileSync = originalAppendFileSync;
        }

        const completedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            completedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            baselineCompletionCount + 1,
            'derived-index warning must not roll back the canonical completion pass from the task timeline'
        );
        assert.equal(
            completedEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            baselineDoneStatusCount,
            'derived-index warning must not duplicate the existing DONE status timeline event'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        const aggregateRestoredAsFile = fs.existsSync(aggregatePath) && fs.statSync(aggregatePath).isFile();
        assert.equal(aggregateRestoredAsFile, baselineAggregateContent !== null);
        const restoredAggregateEntries = baselineAggregateContent === null
            ? []
            : fs.readFileSync(aggregatePath, 'utf8')
                .split('\n')
                .filter((line) => line.trim().length > 0)
                .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(
            restoredAggregateEntries.length,
            baselineAggregateEntries.length,
            'derived-index warning must not append rollback or failure aggregate rows'
        );
        assert.equal(
            restoredAggregateEntries.filter((entry) => (
                String(entry.task_id || '').trim() === taskId
                && String(entry.event_type || '').trim() === 'COMPLETION_GATE_PASSED'
            )).length,
            baselineAggregateEntries.filter((entry) => (
                String(entry.task_id || '').trim() === taskId
                && String(entry.event_type || '').trim() === 'COMPLETION_GATE_PASSED'
            )).length,
            'failed aggregate append must leave the derived aggregate index at its baseline state'
        );
        assert.equal(
            restoredAggregateEntries.filter((entry) => (
                String(entry.task_id || '').trim() === taskId
                && String(entry.event_type || '').trim() === 'STATUS_CHANGED'
                && typeof entry.details === 'object'
                && !Array.isArray(entry.details)
                && String(((entry.details as Record<string, unknown>).new_status) || '').toUpperCase() === 'DONE'
            )).length,
            baselineAggregateEntries.filter((entry) => (
                String(entry.task_id || '').trim() === taskId
                && String(entry.event_type || '').trim() === 'STATUS_CHANGED'
                && typeof entry.details === 'object'
                && !Array.isArray(entry.details)
                && String(((entry.details as Record<string, unknown>).new_status) || '').toUpperCase() === 'DONE'
            )).length,
            'derived-index warning must preserve the pre-existing DONE status aggregate state'
        );
        assert.equal(
            restoredAggregateEntries.filter((entry) => (
                String(entry.task_id || '').trim() === taskId
                && String(entry.event_type || '').trim() === 'COMPLETION_GATE_FAILED'
            )).length,
            0,
            'derived-index warning must not emit a completion failure lifecycle marker'
        );
        const restoredTimelineSummary = baselineTimelineSummaryContent === null
            ? null
            : (
                fs.existsSync(timelineSummaryPath) && fs.statSync(timelineSummaryPath).isFile()
                    ? JSON.parse(fs.readFileSync(timelineSummaryPath, 'utf8')) as {
                        entries?: Record<string, { events_found?: string[]; events_missing?: string[]; completeness_status?: string }>;
                    }
                    : null
        );
        const restoredCurrentTaskSummary = restoredTimelineSummary?.entries?.[taskId];
        assert.ok(restoredCurrentTaskSummary, 'derived-index warning must keep a timeline summary entry for the current task');
        assert.equal(
            Array.isArray(restoredCurrentTaskSummary?.events_found)
                ? restoredCurrentTaskSummary.events_found.includes('COMPLETION_GATE_PASSED')
                : false,
            true,
            'derived-index warning must preserve COMPLETION_GATE_PASSED in the canonical timeline summary'
        );
        assert.equal(
            Array.isArray(restoredCurrentTaskSummary?.events_missing)
                ? restoredCurrentTaskSummary.events_missing.includes('COMPLETION_GATE_PASSED')
                : false,
            false,
            'derived-index warning must not keep COMPLETION_GATE_PASSED missing in the timeline summary'
        );
        assert.equal(
            String(restoredCurrentTaskSummary?.completeness_status || ''),
            'COMPLETE',
            'derived-index warning must keep the current task completion summary complete'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('handleCompletionGate appends COMPLETION_GATE_FAILED when finalization fails after validation PASS', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-finalization-failed-marker';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-finalization-failed-marker.md');
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
            taskSummary: 'Emit COMPLETION_GATE_FAILED when post-validation finalization fails'
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
            rationale: 'Completion finalization failure marker regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionFinalizationModule = require('../../../../../../src/cli/commands/gate-flows/completion/completion-finalization') as {
            reconcileSuccessfulCompletionFinalizationAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const originalReconcileSuccessfulCompletionFinalizationAsync =
            completionFinalizationModule.reconcileSuccessfulCompletionFinalizationAsync;
        completionFinalizationModule.reconcileSuccessfulCompletionFinalizationAsync = async () => {
            throw new Error('Injected completion finalization failure after validation PASS');
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /completion-gate finalization failed after validation PASS/i);
            assert.match(error.message, /Injected completion finalization failure after validation PASS/i);
        } finally {
            completionFinalizationModule.reconcileSuccessfulCompletionFinalizationAsync =
                originalReconcileSuccessfulCompletionFinalizationAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_FAILED').length,
            1,
            'post-validation finalization failures must emit a failure lifecycle marker'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate rolls back DONE and partial closeout artifacts when final user report materialization fails', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-closeout-rollback';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-closeout-rollback.md');
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
            taskSummary: 'Roll back DONE when final user report materialization fails'
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
            rationale: 'Completion final closeout rollback regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const finalCloseoutJsonPath = path.join(reviewsRoot, `${taskId}-final-closeout.json`);
        const finalCloseoutMarkdownPath = path.join(reviewsRoot, `${taskId}-final-closeout.md`);
        const finalUserReportPath = path.join(reviewsRoot, `${taskId}-final-user-report.md`);
        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        const readAggregateEntries = () => fs.readFileSync(aggregatePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const assertAggregateTaskProjectionMatchesTimeline = (aggregateEntries: Record<string, unknown>[]) => {
            const timelineEvents = readTaskTimelineEvents(repoRoot, taskId) as unknown as Record<string, unknown>[];
            const identityOf = (event: Record<string, unknown>) => {
                const integrity = event.integrity as Record<string, unknown> | undefined;
                return `${String(integrity?.task_sequence || '')}:${String(integrity?.event_sha256 || '')}`;
            };
            const aggregateTaskEvents = aggregateEntries.filter((entry) => entry.task_id === taskId);
            const aggregateIdentities = new Set(aggregateTaskEvents.map(identityOf));
            const replayedTimelineProjection = timelineEvents.filter((event) => aggregateIdentities.has(identityOf(event)));
            assert.deepEqual(
                aggregateTaskEvents,
                replayedTimelineProjection,
                'aggregate current-task projection must replay as an ordered subset of the canonical task timeline'
            );
        };
        const baselineAggregateEntries = readAggregateEntries();
        const baselineCompletionPassCount = baselineAggregateEntries.filter((entry) => (
            entry.task_id === taskId && entry.event_type === 'COMPLETION_GATE_PASSED'
        )).length;
        const baselineDoneCount = baselineAggregateEntries.filter((entry) => (
            entry.task_id === taskId
            && entry.event_type === 'STATUS_CHANGED'
            && typeof entry.details === 'object'
            && !Array.isArray(entry.details)
            && (entry.details as Record<string, unknown>).new_status === 'DONE'
        )).length;
        const foreignAggregateMarker = 'RETENTION_REWRITE_FOREIGN_EVENT';
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalRenameSync = fsModule.renameSync;
        const originalAppendFileSync = fsModule.appendFileSync;
        let injectedReportWriteFailure = false;
        let injectedAggregateRewrite = false;
        fsModule.appendFileSync = ((filePath: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) => {
            const result = originalAppendFileSync(filePath, data, options);
            const normalizedPath = typeof filePath === 'string' ? path.resolve(filePath) : '';
            const payload = typeof data === 'string' ? data : '';
            if (
                !injectedAggregateRewrite
                && normalizedPath === path.resolve(aggregatePath)
                && payload.includes('"event_type":"STATUS_CHANGED"')
                && payload.includes('"new_status":"DONE"')
            ) {
                originalAppendFileSync(aggregatePath, `${JSON.stringify({
                    schema_version: 2,
                    task_id: 'T-903-foreign-retention-rewrite',
                    event_type: 'FOREIGN_EVENT',
                    marker: foreignAggregateMarker
                })}\n`, 'utf8');
                const rewrittenLines = fsModule.readFileSync(aggregatePath, 'utf8')
                    .split('\n')
                    .filter((line) => line.trim().length > 0)
                    .slice(1);
                fsModule.writeFileSync(aggregatePath, `${rewrittenLines.join('\n')}\n`, 'utf8');
                injectedAggregateRewrite = true;
            }
            return result;
        }) as typeof fsModule.appendFileSync;
        fsModule.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
            if (
                !injectedReportWriteFailure
                && typeof newPath === 'string'
                && path.resolve(newPath) === path.resolve(finalUserReportPath)
            ) {
                injectedReportWriteFailure = true;
                throw new Error('Injected final user report write failure');
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
            assert.match(error.message, /mandatory final closeout materialization failed/i);
            assert.match(error.message, /Injected final user report write failure/i);
        } finally {
            fsModule.appendFileSync = originalAppendFileSync;
            fsModule.renameSync = originalRenameSync;
        }

        assert.equal(injectedReportWriteFailure, true);
        assert.equal(injectedAggregateRewrite, true);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');
        assert.equal(fs.existsSync(finalCloseoutJsonPath), false);
        assert.equal(fs.existsSync(finalCloseoutMarkdownPath), false);
        assert.equal(fs.existsSync(finalUserReportPath), false);
        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0
        );
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_FAILED').length,
            1
        );
        const failedAggregateEntries = readAggregateEntries();
        assert.equal(
            failedAggregateEntries.filter((entry) => (
                entry.task_id === taskId && entry.event_type === 'COMPLETION_GATE_PASSED'
            )).length,
            baselineCompletionPassCount,
            'aggregate rollback must remove only the failed transaction completion pass after retention rewrites the prefix'
        );
        assert.equal(
            failedAggregateEntries.filter((entry) => (
                entry.task_id === taskId
                && entry.event_type === 'STATUS_CHANGED'
                && typeof entry.details === 'object'
                && !Array.isArray(entry.details)
                && (entry.details as Record<string, unknown>).new_status === 'DONE'
            )).length,
            baselineDoneCount,
            'aggregate rollback must remove only the failed transaction DONE status after retention rewrites the prefix'
        );
        assert.equal(
            failedAggregateEntries.some((entry) => entry.marker === foreignAggregateMarker),
            true,
            'aggregate rollback must preserve unrelated rows appended around a retention rewrite'
        );
        assertAggregateTaskProjectionMatchesTimeline(failedAggregateEntries);

        // Mandatory compact deletion participates in the same completion rollback.
        const compactTaskRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime/compact', taskId);
        const compactRun = path.join(compactTaskRoot, 'a'.repeat(32));
        fs.mkdirSync(compactRun, { recursive: true });
        const compactOutput = path.join(compactRun, 'stdout.log');
        fs.writeFileSync(compactOutput, 'secret remains unfiltered');
        const originalUnlinkSync = fsModule.unlinkSync;
        let injectedCompactFailure = false;
        fsModule.unlinkSync = ((filePath: fs.PathLike) => {
            if (String(filePath) === compactOutput) {
                injectedCompactFailure = true;
                throw new Error('Injected compact deletion failure');
            }
            return originalUnlinkSync(filePath);
        }) as typeof fsModule.unlinkSync;
        try {
            await captureExpectedAsyncError(() => handleCompletionGate([
                '--preflight-path', preflightPath, '--task-id', taskId, '--repo-root', repoRoot
            ]));
        } finally { fsModule.unlinkSync = originalUnlinkSync; }
        assert.equal(injectedCompactFailure, true);
        assert.notEqual(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        assert.equal(fs.existsSync(compactOutput), true);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).filter(event => event.event_type === 'COMPLETION_GATE_PASSED').length, 0);

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        assert.equal(fs.existsSync(compactTaskRoot), false);
        assert.equal(fs.existsSync(finalCloseoutJsonPath), true);
        assert.equal(fs.existsSync(finalCloseoutMarkdownPath), true);
        assert.equal(fs.existsSync(finalUserReportPath), true);
        const completedAggregateEntries = readAggregateEntries();
        assert.equal(
            completedAggregateEntries.filter((entry) => (
                entry.task_id === taskId && entry.event_type === 'COMPLETION_GATE_PASSED'
            )).length,
            baselineCompletionPassCount + 1,
            'corrected retry must leave exactly one committed aggregate completion pass'
        );
        assert.equal(
            completedAggregateEntries.filter((entry) => (
                entry.task_id === taskId
                && entry.event_type === 'STATUS_CHANGED'
                && typeof entry.details === 'object'
                && !Array.isArray(entry.details)
                && (entry.details as Record<string, unknown>).new_status === 'DONE'
            )).length,
            baselineDoneCount + 1,
            'corrected retry must leave exactly one committed aggregate DONE status'
        );
        assertAggregateTaskProjectionMatchesTimeline(completedAggregateEntries);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate materializes canonical final closeout artifacts through the CLI handler', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-final-closeout-artifact';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-final-closeout-artifact.md');
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
            taskSummary: 'Materialize final closeout artifacts from task-audit-summary'
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
        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'test', 'TEST REVIEW PASSED');
        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);
        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'DOCS_UPDATED',
            behaviorChanged: false,
            changelogUpdated: false,
            docsUpdated: ['docs/cli-reference.md'],
            rationale: 'Final closeout artifact fixture updates workflow documentation.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        try {
            process.chdir(repoRoot);
            process.exitCode = 0;
            await runCliMain([
                'gate',
                'completion-gate',
                '--preflight-path', preflightPath,
                '--task-id', taskId,
                '--repo-root', repoRoot
            ]);
            assert.equal(process.exitCode ?? 0, 0);

            const reviewsRoot = getReviewsRoot(repoRoot);
            assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-final-closeout.json`)), true);
            assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-final-closeout.md`)), true);
            assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-final-user-report.md`)), true);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewsRoot = getReviewsRoot(repoRoot);
        const finalCloseoutJsonPath = path.join(reviewsRoot, `${taskId}-final-closeout.json`);
        const finalCloseoutMarkdownPath = path.join(reviewsRoot, `${taskId}-final-closeout.md`);
        const finalUserReportPath = path.join(reviewsRoot, `${taskId}-final-user-report.md`);
        assert.equal(fs.existsSync(finalCloseoutJsonPath), true);
        assert.equal(fs.existsSync(finalCloseoutMarkdownPath), true);
        assert.equal(fs.existsSync(finalUserReportPath), true);
        const finalCloseoutJson = JSON.parse(fs.readFileSync(finalCloseoutJsonPath, 'utf8'));
        assert.equal(finalCloseoutJson.status, 'READY');
        assert.equal(finalCloseoutJson.artifact_state, 'MATERIALIZED');
        assert.equal(finalCloseoutJson.artifact_paths.final_user_report.endsWith(`${taskId}-final-user-report.md`), true);
        assert.deepEqual(finalCloseoutJson.implementation_summary.review_verdicts, {
            code: 'REVIEW PASSED',
            test: 'TEST REVIEW PASSED'
        });
        assert.ok(fs.readFileSync(finalCloseoutMarkdownPath, 'utf8').includes(String(finalCloseoutJson.commit_question)));
        const finalUserReport = fs.readFileSync(finalUserReportPath, 'utf8');
        assert.ok(finalUserReport.includes('GARDA FINAL REPORT'));
        assert.ok(finalUserReport.includes(`Task: ${taskId}`));
        assert.ok(finalUserReport.includes('Status: DONE'));
        assert.ok(!finalUserReport.includes('Process warnings:'));
        assert.ok(!finalUserReport.includes('PathMode:'));
        assert.ok(!finalUserReport.includes('Commit Readiness:'));
        assert.ok(!finalUserReport.includes('Operator Question:'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('task-audit-summary preserves existing final closeout artifacts while completion finalization is in flight', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-task-audit-summary-inflight-finalization';
        seedTaskQueue(repoRoot, taskId, '🟧 IN_REVIEW');
        seedInitAnswers(repoRoot);
        writePreflight(repoRoot, taskId, {
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
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'COMPLETION_GATE_PASSED',
            'PASS',
            'Older completion gate passed before the current rerun.',
            {}
        );
        const lockPath = path.join(getReviewsRoot(repoRoot), `${taskId}-completion-gate.lock`);
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid }), 'utf8');
        const staleJsonPath = path.join(getReviewsRoot(repoRoot), `${taskId}-final-closeout.json`);
        const staleMarkdownPath = path.join(getReviewsRoot(repoRoot), `${taskId}-final-closeout.md`);
        fs.writeFileSync(staleJsonPath, '{}\n', 'utf8');
        fs.writeFileSync(staleMarkdownPath, 'stale\n', 'utf8');

        try {
            const auditResult = runTaskAuditSummaryCommand({
                taskId,
                repoRoot,
                asJson: true
            });
            assert.equal(auditResult.exitCode, EXIT_GATE_FAILURE);
            const rendered = JSON.parse(auditResult.rendered);
            assert.equal(rendered.status, 'INCOMPLETE');
            assert.equal(rendered.point_in_time_snapshot.status, 'FINALIZATION_IN_FLIGHT');
            assert.equal(rendered.point_in_time_snapshot.owner_pid, process.pid);
            assert.equal(rendered.point_in_time_snapshot.owner_metadata_status, 'ok');
            assert.equal(rendered.point_in_time_snapshot.acquisition_policy.timeout_ms, 5000);
            assert.match(rendered.final_report_contract.blocker, /point-in-time snapshot/i);
            assert.match(rendered.final_report_contract.blocker, /Re-run task-audit-summary sequentially/i);
            assert.equal(fs.existsSync(staleJsonPath), true);
            assert.equal(fs.existsSync(staleMarkdownPath), true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
