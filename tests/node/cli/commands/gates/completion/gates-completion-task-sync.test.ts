import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeBudgetOutputFilters } from '../../gate-test-helpers';

import { handleCompletionGate } from '../../../../../../src/cli/commands/gate-task-handlers';
import {
    runCompileGateCommand,
    runDocImpactGateCommand
} from '../../../../../../src/cli/commands/gates';
import { runCliMain } from '../../../../../../src/cli/main';
import { beginValidationOutputRun, VALIDATION_REPO_ROOT_ENV, VALIDATION_TASK_ID_ENV } from '../../../../../../src/core/validation-output-retention';
import { runTaskAuditSummaryCommand } from '../../../../../../src/cli/commands/gate-flows/task/task-summary-flow';

import {
    captureExpectedAsyncError,
    createTempRepo,
    loadTaskEntryRulePack,
    loadTaskEventsIoModule,
    loadPostPreflightRulePack,
    readTaskQueueStatusFromTaskFile,
    readTaskTimelineEvents,
    runRequiredReviewsCheckCommand,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    runGit,
    seedInitAnswers,
    seedTaskQueue,
    writeCleanReviewArtifact,
    writePreflight
} from './gates-completion-fixtures';

function writeTaskQueueRows(repoRoot: string, rows: string[]): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows
    ].join('\n'), 'utf8');
}

function createFailedValidationRun(repoRoot: string, taskId: string): ReturnType<typeof beginValidationOutputRun> {
    const previousRoot = process.env[VALIDATION_REPO_ROOT_ENV];
    const previousTask = process.env[VALIDATION_TASK_ID_ENV];
    try {
        process.env[VALIDATION_REPO_ROOT_ENV] = repoRoot;
        process.env[VALIDATION_TASK_ID_ENV] = taskId;
        const run = beginValidationOutputRun(repoRoot, 'node-tests');
        fs.writeFileSync(path.join(run.scratchDir, 'failed-attempt.log'), 'previous failed attempt');
        run.finish(1);
        return run;
    } finally {
        if (previousRoot === undefined) delete process.env[VALIDATION_REPO_ROOT_ENV];
        else process.env[VALIDATION_REPO_ROOT_ENV] = previousRoot;
        if (previousTask === undefined) delete process.env[VALIDATION_TASK_ID_ENV];
        else process.env[VALIDATION_TASK_ID_ENV] = previousTask;
    }
}

async function prepareCompletionReadyTask(repoRoot: string, taskId: string, taskSummary: string): Promise<string> {
    seedInitAnswers(repoRoot);
    const preflightPath = writePreflight(repoRoot, taskId);
    const commandsPath = path.join(repoRoot, `${taskId}-commands.md`);
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
        taskSummary
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
        rationale: 'Completion task queue sync regression fixture only.',
        emitMetrics: false
    });
    assert.equal(docImpactResult.exitCode, 0);
    return preflightPath;
}

function readOptionalTaskTimelineEvents(repoRoot: string, taskId: string): Array<Record<string, unknown>> {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    if (!fs.existsSync(timelinePath)) {
        return [];
    }
    return readTaskTimelineEvents(repoRoot, taskId);
}

describe('cli/commands/gates', () => {
    test('completion-gate updates the TASK.md row to DONE through the CLI handler', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-status-sync';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-status-sync.md');
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
            taskSummary: 'Sync TASK.md status to DONE from completion-gate'
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
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), /\|\s*T-903-completion-status-sync\s*\|\s*🟧 IN_REVIEW\s*\|/);

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Completion status sync regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const validationRun = createFailedValidationRun(repoRoot, taskId);
        const validationResultPath = path.join(validationRun.reportsDir, 'result.json');
        const validationResultBefore = fs.readFileSync(validationResultPath, 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMain([
                'gate',
                'completion-gate',
                '--preflight-path', preflightPath,
                '--task-id', taskId,
                '--repo-root', repoRoot
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), /\|\s*T-903-completion-status-sync\s*\|\s*🟩 DONE\s*\|/);
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-final-closeout.json`)), true);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-final-closeout.md`)), true);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-final-user-report.md`)), true);
        assert.equal(fs.existsSync(validationRun.scratchDir), false, 'canonical completion must clean earlier failed test scratch');
        assert.equal(fs.readFileSync(validationResultPath, 'utf8'), validationResultBefore);
        const stage = runGit(repoRoot, ['add', '--', 'src/app.ts', 'TASK.md']);
        assert.equal(stage.status, 0, `${stage.stdout}\n${stage.stderr}`);
        const commit = runGit(repoRoot, ['commit', '-m', 'Close the validation retention fixture task']);
        assert.equal(commit.status, 0, `${commit.stdout}\n${commit.stderr}`);
        const audit = runTaskAuditSummaryCommand({ repoRoot, taskId, asJson: true });
        assert.equal(audit.exitCode, 0, audit.rendered);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate auto-completes a linked decomposed parent when the final child closes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-parent-auto-close-child';
        const parentTaskId = 'T-903-parent-auto-close';
        writeTaskQueueRows(repoRoot, [
            `| ${parentTaskId} | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | default | Execute child tasks \`${taskId}\` through normal gates. |`,
            `| ${taskId} | 🟦 TODO | P1 | workflow | Child | gpt-5.5 | 2026-05-06 | default | Complete the child. |`
        ]);
        const preflightPath = await prepareCompletionReadyTask(
            repoRoot,
            taskId,
            'Auto-close linked decomposed parent after child completion'
        );

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, parentTaskId), 'DONE');
        const parentEvents = readTaskTimelineEvents(repoRoot, parentTaskId);
        assert.equal(
            parentEvents.some((event) => event.event_type === 'DECOMPOSED_PARENT_COMPLETED'),
            true
        );
        assert.equal(
            parentEvents.some((event) => (
                event.event_type === 'STATUS_CHANGED'
                && String((event.details as Record<string, unknown> | undefined)?.new_status || '').toUpperCase() === 'DONE'
            )),
            true
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate leaves a linked decomposed parent open when another explicit child is not DONE', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-parent-incomplete-child';
        const siblingTaskId = 'T-903-parent-incomplete-sibling';
        const parentTaskId = 'T-903-parent-incomplete';
        writeTaskQueueRows(repoRoot, [
            `| ${parentTaskId} | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | default | Execute child tasks \`${taskId}\` and \`${siblingTaskId}\` through normal gates. |`,
            `| ${taskId} | 🟦 TODO | P1 | workflow | Child | gpt-5.5 | 2026-05-06 | default | Complete the child. |`,
            `| ${siblingTaskId} | 🟦 TODO | P1 | workflow | Sibling child | gpt-5.5 | 2026-05-06 | default | Still pending. |`
        ]);
        const preflightPath = await prepareCompletionReadyTask(
            repoRoot,
            taskId,
            'Keep parent decomposed while a sibling child remains open'
        );

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, siblingTaskId), 'TODO');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, parentTaskId), 'DECOMPOSED');
        assert.equal(
            readOptionalTaskTimelineEvents(repoRoot, parentTaskId)
                .some((event) => event.event_type === 'DECOMPOSED_PARENT_COMPLETED'),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate auto-completes nested decomposed parents after the leaf child closes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-nested-leaf';
        const nestedParentTaskId = 'T-903-nested-parent';
        const rootParentTaskId = 'T-903-root-parent';
        writeTaskQueueRows(repoRoot, [
            `| ${rootParentTaskId} | 🟪 DECOMPOSED | P1 | workflow | Root parent | gpt-5.5 | 2026-05-06 | default | Execute child tasks \`${nestedParentTaskId}\` through normal gates. |`,
            `| ${nestedParentTaskId} | 🟪 DECOMPOSED | P1 | workflow | Nested parent | gpt-5.5 | 2026-05-06 | default | Execute child tasks \`${taskId}\` through normal gates. |`,
            `| ${taskId} | 🟦 TODO | P1 | workflow | Leaf child | gpt-5.5 | 2026-05-06 | default | Complete the leaf child. |`
        ]);
        const preflightPath = await prepareCompletionReadyTask(
            repoRoot,
            taskId,
            'Auto-close nested decomposed parents after leaf completion'
        );

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, nestedParentTaskId), 'DONE');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, rootParentTaskId), 'DONE');
        for (const parentTaskId of [nestedParentTaskId, rootParentTaskId]) {
            assert.equal(
                readTaskTimelineEvents(repoRoot, parentTaskId)
                    .some((event) => event.event_type === 'DECOMPOSED_PARENT_COMPLETED'),
                true
            );
        }

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate rolls back child finalization when decomposed parent auto-close cannot append mandatory evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-parent-auto-close-rollback-child';
        const parentTaskId = 'T-903-parent-auto-close-rollback';
        writeTaskQueueRows(repoRoot, [
            `| ${parentTaskId} | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | default | Execute child tasks \`${taskId}\` through normal gates. |`,
            `| ${taskId} | 🟦 TODO | P1 | workflow | Child | gpt-5.5 | 2026-05-06 | default | Complete the child. |`
        ]);
        const preflightPath = await prepareCompletionReadyTask(
            repoRoot,
            taskId,
            'Rollback child completion when parent auto-close evidence fails'
        );
        const validationRun = createFailedValidationRun(repoRoot, taskId);
        const parentValidationRun = createFailedValidationRun(repoRoot, parentTaskId);
        const validationResultPath = path.join(validationRun.reportsDir, 'result.json');
        const validationResultBefore = fs.readFileSync(validationResultPath, 'utf8');
        const parentTimelinePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'task-events',
            `${parentTaskId}.jsonl`
        );
        const mutableFs = require('node:fs') as typeof fs;
        const originalOpenSync = mutableFs.openSync;
        mutableFs.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode): number => {
            const opensForAppend = typeof flags === 'number'
                ? (flags & fs.constants.O_APPEND) !== 0
                : String(flags).includes('a');
            if (opensForAppend && typeof filePath === 'string' && path.resolve(filePath) === path.resolve(parentTimelinePath)) {
                throw new Error('Injected decomposed parent event append failure');
            }
            return originalOpenSync(filePath, flags, mode);
        }) as typeof fs.openSync;

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory decomposed parent auto-close failed/i);
        } finally {
            mutableFs.openSync = originalOpenSync;
        }

        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, parentTaskId), 'DECOMPOSED');
        assert.equal(fs.existsSync(validationRun.scratchDir), true, 'rollback must preserve failed validation scratch');
        assert.equal(fs.existsSync(parentValidationRun.scratchDir), true);
        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.some((event) => event.event_type === 'COMPLETION_GATE_PASSED'),
            false
        );

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, parentTaskId), 'DONE');
        assert.equal(fs.existsSync(validationRun.scratchDir), false);
        assert.equal(fs.existsSync(parentValidationRun.scratchDir), false);
        assert.equal(fs.readFileSync(validationResultPath, 'utf8'), validationResultBefore);
        assert.equal(
            readTaskTimelineEvents(repoRoot, parentTaskId)
                .some((event) => event.event_type === 'DECOMPOSED_PARENT_COMPLETED'),
            true
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate rolls back earlier nested parent evidence when a later parent auto-close fails', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-nested-rollback-leaf';
        const nestedParentTaskId = 'T-903-nested-rollback-parent';
        const rootParentTaskId = 'T-903-root-rollback-parent';
        writeTaskQueueRows(repoRoot, [
            `| ${rootParentTaskId} | 🟪 DECOMPOSED | P1 | workflow | Root parent | gpt-5.5 | 2026-05-06 | default | Execute child tasks \`${nestedParentTaskId}\` through normal gates. |`,
            `| ${nestedParentTaskId} | 🟪 DECOMPOSED | P1 | workflow | Nested parent | gpt-5.5 | 2026-05-06 | default | Execute child tasks \`${taskId}\` through normal gates. |`,
            `| ${taskId} | 🟦 TODO | P1 | workflow | Leaf child | gpt-5.5 | 2026-05-06 | default | Complete the leaf child. |`
        ]);
        const preflightPath = await prepareCompletionReadyTask(
            repoRoot,
            taskId,
            'Rollback nested parent evidence when root parent auto-close fails'
        );
        const rootParentTimelinePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'task-events',
            `${rootParentTaskId}.jsonl`
        );
        const mutableFs = require('node:fs') as typeof fs;
        const originalOpenSync = mutableFs.openSync;
        mutableFs.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode): number => {
            const opensForAppend = typeof flags === 'number'
                ? (flags & fs.constants.O_APPEND) !== 0
                : String(flags).includes('a');
            if (opensForAppend && typeof filePath === 'string' && path.resolve(filePath) === path.resolve(rootParentTimelinePath)) {
                throw new Error('Injected root parent event append failure');
            }
            return originalOpenSync(filePath, flags, mode);
        }) as typeof fs.openSync;

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory decomposed parent auto-close failed/i);
        } finally {
            mutableFs.openSync = originalOpenSync;
        }

        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, nestedParentTaskId), 'DECOMPOSED');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, rootParentTaskId), 'DECOMPOSED');
        assert.equal(
            readOptionalTaskTimelineEvents(repoRoot, nestedParentTaskId)
                .some((event) => event.event_type === 'DECOMPOSED_PARENT_COMPLETED'),
            false,
            'nested parent completion evidence must be removed when the later root parent close fails'
        );
        assert.equal(
            readOptionalTaskTimelineEvents(repoRoot, rootParentTaskId)
                .some((event) => event.event_type === 'STATUS_CHANGED'),
            false,
            'root parent status evidence must not survive the failed close attempt'
        );

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, nestedParentTaskId), 'DONE');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, rootParentTaskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate rerun repairs missing STATUS_CHANGED finalization without duplicating completion pass evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-status-event-repair';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-status-event-repair.md');
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
            taskSummary: 'Repair missing STATUS_CHANGED finalization on completion rerun'
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
            rationale: 'Completion finalization repair regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[2] || '') === 'STATUS_CHANGED') {
                throw new Error('Injected STATUS_CHANGED append failure');
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
            assert.match(error.message, /mandatory STATUS_CHANGED append failed/i);
            assert.match(error.message, /gate completion-gate/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must not be recorded before finalization reconciliation succeeds'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0,
            'DONE status transition must not be recorded when STATUS_CHANGED append failed'
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
        assert.equal(
            repairedEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            1
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate rerun repairs missing TASK.md DONE sync without duplicating STATUS_CHANGED telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-task-queue-repair';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-task-queue-repair.md');
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
            taskSummary: 'Repair missing TASK.md DONE sync on completion rerun'
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
            rationale: 'Completion task queue repair regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
        ].join('\n'), 'utf8');

        const error = await captureExpectedAsyncError(async () => {
            await handleCompletionGate([
                '--preflight-path', preflightPath,
                '--task-id', taskId,
                '--repo-root', repoRoot
            ]);
        });
        assert.match(error.message, /TASK\.md queue state could not be reconciled to DONE/i);
        assert.match(error.message, /gate completion-gate/i);

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must not be recorded before TASK.md queue reconciliation succeeds'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0,
            'STATUS_CHANGED to DONE must not be recorded before TASK.md queue reconciliation succeeds'
        );

        seedTaskQueue(repoRoot, taskId, '🟧 IN_REVIEW');
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
        assert.equal(
            repairedEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            1,
            'repair rerun must reuse the existing DONE status transition instead of appending a duplicate'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate restores the TASK.md snapshot after a partial write failure during DONE sync', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-task-queue-write-rollback';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-task-queue-write-rollback.md');
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
            taskSummary: 'Restore TASK.md snapshot after a partial queue write failure'
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
            rationale: 'Completion TASK.md write rollback regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskPath = path.join(repoRoot, 'TASK.md');
        const baselineTaskContent = fs.readFileSync(taskPath, 'utf8');
        const fsModule = require('node:fs') as {
            renameSync: typeof fs.renameSync;
        };
        const originalRenameSync = fsModule.renameSync;
        let injectedWriteFailureConsumed = false;
        fsModule.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
            if (
                !injectedWriteFailureConsumed
                && path.resolve(String(newPath)) === path.resolve(taskPath)
            ) {
                injectedWriteFailureConsumed = true;
                originalRenameSync(oldPath, newPath);
                throw new Error('Injected TASK.md write failure');
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
            assert.match(error.message, /TASK\.md queue state could not be reconciled to DONE/i);
        } finally {
            fsModule.renameSync = originalRenameSync;
        }

        assert.equal(
            fs.readFileSync(taskPath, 'utf8'),
            baselineTaskContent,
            'TASK.md must be restored to its pre-finalization snapshot after a partial write failure'
        );

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
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
