import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { initializeGitRepo } from './gate-test-helpers';

import {
    runGateCliHandler
} from '../../../../src/cli/commands/gate-cli-handler';
import {
    handleCompletionGate,
    handleFullSuiteValidation,
    handleHumanCommit,
    handleLogTaskEvent,
    handleNextStep,
    handleTaskAuditSummary,
    handleTaskEventsSummary,
    handleTaskReset
} from '../../../../src/cli/commands/gate-task-handlers';
import type {
    ParsedOptionsRecord
} from '../../../../src/cli/commands/shared-command-utils';

async function captureHandler(
    action: () => Promise<void>,
    initialExitCode = 0
): Promise<{ output: string; exitCode: number }> {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    const previousExitCode = process.exitCode;
    process.exitCode = initialExitCode;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        chunks.push(String(chunk));
        return true;
    }) as typeof process.stdout.write;
    try {
        await action();
        return {
            output: chunks.join(''),
            exitCode: Number(process.exitCode ?? 0)
        };
    } finally {
        process.stdout.write = originalWrite;
        process.exitCode = previousExitCode;
    }
}

test('runGateCliHandler parses options, writes line output, and propagates failure exit codes', async () => {
    let receivedOptions: ParsedOptionsRecord | undefined;
    const observed = await captureHandler(() => runGateCliHandler(
        ['--task-id', 'T-919-3', '--changed-file', 'one.ts', '--changed-file=two.ts'],
        {
            '--task-id': { key: 'taskId', type: 'string' },
            '--changed-file': { key: 'changedFiles', type: 'string[]' }
        },
        (options: ParsedOptionsRecord) => {
            receivedOptions = options;
            return {
                outputLines: ['STATUS: BLOCKED', 'TaskId: T-919-3'],
                exitCode: 2
            };
        }
    ));

    assert.deepEqual(receivedOptions, {
        taskId: 'T-919-3',
        changedFiles: ['one.ts', 'two.ts']
    });
    assert.equal(observed.output, 'STATUS: BLOCKED\nTaskId: T-919-3\n');
    assert.equal(observed.exitCode, 2);
});

test('runGateCliHandler supports positional mapping and custom output without clearing an existing exit code', async () => {
    const observed = await captureHandler(() => runGateCliHandler(
        ['T-919-3', '--as-json'],
        {
            '--as-json': { key: 'asJson', type: 'boolean' }
        },
        async (input: { taskId: string; asJson: boolean }) => ({
            rendered: JSON.stringify(input)
        }),
        {
            parseConfig: { allowPositionals: true, maxPositionals: 1 },
            mapOptions: ({ options, positionals }) => ({
                taskId: positionals[0],
                asJson: options.asJson === true
            }),
            formatOutput: (result) => `${result.rendered}\n`,
            resolveExitCode: () => 0
        }
    ), 7);

    assert.equal(observed.output, '{"taskId":"T-919-3","asJson":true}\n');
    assert.equal(observed.exitCode, 7);
});

test('runGateCliHandler can pass raw argv and reports command errors before rejecting', async () => {
    const expectedError = new Error('command failed');
    let reportedError: unknown;
    let receivedArgv: string[] | undefined;

    await assert.rejects(
        captureHandler(() => runGateCliHandler(
            ['--message', 'value'],
            {},
            (argv: string[]) => {
                receivedArgv = argv;
                throw expectedError;
            },
            {
                skipParsing: true,
                mapOptions: ({ argv }) => [...argv],
                formatOutput: () => '',
                resolveExitCode: () => 0,
                onCommandError: (error) => {
                    reportedError = error;
                }
            }
        )),
        expectedError
    );
    assert.deepEqual(receivedArgv, ['--message', 'value']);
    assert.equal(reportedError, expectedError);

    const asynchronousError = new Error('async command failed');
    reportedError = undefined;
    await assert.rejects(
        runGateCliHandler(
            [],
            {},
            async (_options: ParsedOptionsRecord) => {
                throw asynchronousError;
            },
            {
                onCommandError: (error) => {
                    reportedError = error;
                }
            }
        ),
        asynchronousError
    );
    assert.equal(reportedError, asynchronousError);
});

test('runGateCliHandler rejects unknown options before invoking the command', async () => {
    let commandInvoked = false;

    await assert.rejects(
        runGateCliHandler(
            ['--unexpected', 'value'],
            {
                '--task-id': { key: 'taskId', type: 'string' }
            },
            (_options: ParsedOptionsRecord) => {
                commandInvoked = true;
                return { outputLines: ['UNREACHABLE'], exitCode: 0 };
            }
        ),
        /Unknown option: --unexpected/
    );
    assert.equal(commandInvoked, false);
});

test('runGateCliHandler normalizes mapping and synchronous finalization errors to Promise rejections', async () => {
    const mappingError = new Error('mapping failed');
    let mappingPromise: Promise<void> | undefined;
    assert.doesNotThrow(() => {
        mappingPromise = runGateCliHandler(
            [],
            {},
            (_options: ParsedOptionsRecord) => ({ outputLines: ['UNREACHABLE'], exitCode: 0 }),
            {
                mapOptions: () => {
                    throw mappingError;
                }
            }
        );
    });
    assert.ok(mappingPromise);
    await assert.rejects(mappingPromise, mappingError);

    const formattingError = new Error('formatting failed');
    let formattingPromise: Promise<void> | undefined;
    assert.doesNotThrow(() => {
        formattingPromise = runGateCliHandler(
            [],
            {},
            (_options: ParsedOptionsRecord) => ({ rendered: 'unused' }),
            {
                formatOutput: () => {
                    throw formattingError;
                },
                resolveExitCode: () => 0
            }
        );
    });
    assert.ok(formattingPromise);
    await assert.rejects(formattingPromise, formattingError);
});

test('migrated public handlers preserve representative output, positional, raw-argv, and async contracts', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-handler-parity-'));
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-900 | TODO | P1 | cli | Handler parity fixture | Codex | 2026-07-25 | balanced | Test fixture. |',
        ''
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'), { recursive: true });

    try {
        const standard = await captureHandler(() => handleTaskReset([
            '--task-id', 'T-900',
            '--reopen',
            '--dry-run',
            '--repo-root', repoRoot
        ]));
        assert.match(standard.output, /^ALREADY_RESET\nTaskId: T-900\n/);
        assert.match(standard.output, /TargetStatus: TODO\nNote: Task already TODO with no remaining artifacts\.\n$/);
        assert.equal(standard.exitCode, 0);

        const positional = await captureHandler(() => handleNextStep([
            'T-987654321',
            '--as-json',
            '--repo-root', repoRoot
        ]), 7);
        const nextStepResult = JSON.parse(positional.output) as Record<string, unknown>;
        assert.equal(nextStepResult.task_id, 'T-987654321');
        assert.equal(nextStepResult.next_gate, 'enter-task-mode');
        assert.equal(positional.exitCode, 7);

        const logged = await captureHandler(() => handleLogTaskEvent([
            '--task-id', 'T-900',
            '--event-type', 'HANDLER_PARITY_NOTE',
            '--outcome', 'PASS',
            '--message', 'Handler parity event.',
            '--repo-root', repoRoot
        ]), 5);
        const loggedResult = JSON.parse(logged.output) as Record<string, unknown>;
        assert.equal(loggedResult.task_id, 'T-900');
        assert.equal(loggedResult.event_type, 'HANDLER_PARITY_NOTE');
        assert.equal(logged.exitCode, 5);

        const eventsSummary = await captureHandler(() => handleTaskEventsSummary([
            '--task-id', 'T-900',
            '--repo-root', repoRoot,
            '--as-json'
        ]), 6);
        const eventsResult = JSON.parse(eventsSummary.output) as {
            task_id?: string;
            timeline?: unknown[];
        };
        assert.equal(eventsResult.task_id, 'T-900');
        assert.ok((eventsResult.timeline?.length ?? 0) >= 1);
        assert.equal(eventsSummary.exitCode, 6);

        const auditSummary = await captureHandler(() => handleTaskAuditSummary([
            '--task-id', 'T-900',
            '--repo-root', repoRoot,
            '--as-json'
        ]));
        assert.equal((JSON.parse(auditSummary.output) as Record<string, unknown>).task_id, 'T-900');
        assert.ok(auditSummary.exitCode >= 0);

        initializeGitRepo(repoRoot);
        const configPath = path.join(repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(buildDefaultWorkflowConfig(), null, 2) + '\n');
        handleSet({ targetRoot: repoRoot, localCommitEnabled: 'true', json: true,
            operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
        await assert.rejects(
            captureHandler(() => handleHumanCommit(['--repo-root', repoRoot, '-m', 'test: handler parity'])),
            /Native local commits require --task-id for completed, audited task scope/u
        );
        await assert.rejects(
            handleFullSuiteValidation(['--unexpected']),
            /Unknown option: --unexpected/
        );
        await assert.rejects(
            captureHandler(() => handleCompletionGate([
                '--task-id', 'T-900',
                '--repo-root', repoRoot
            ])),
            /PreflightPath must not be empty/
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
