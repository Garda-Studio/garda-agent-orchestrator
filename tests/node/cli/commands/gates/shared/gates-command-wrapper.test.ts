import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { EXIT_GATE_FAILURE } from '../../../../../../src/cli/exit-codes';
import {
    runIntermediateCommandCommand
} from '../../../../../../src/cli/commands/gates';

import {
    createTempRepo,
    getOrchestratorRoot,
    readTaskTimelineEvents,
    seedInitAnswers,
    seedTaskQueue
} from '../../gate-test-helpers';

function seedNodeFoundationFocusedWrapperFixture(repoRoot: string): void {
    const scriptPath = path.join(repoRoot, 'scripts', 'node-foundation', 'build-scripts.cjs');
    const testPath = path.join(repoRoot, 'tests', 'node', 'gates', 'focused-command.test.ts');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, 'export {};\n', 'utf8');
    fs.writeFileSync(
        scriptPath,
        [
            "if (process.argv[2] !== 'test.js') process.exit(2);",
            "console.log('node-foundation focused wrapper executed');",
            ''
        ].join('\n'),
        'utf8'
    );
}

function seedExpectedRedPreflight(repoRoot: string, taskId: string): string {
    const taskPath = path.join(repoRoot, 'TASK.md');
    fs.writeFileSync(
        taskPath,
        fs.readFileSync(taskPath, 'utf8').replace('| fixture |', '| Test-first: expected-red. |'),
        'utf8'
    );
    const preflightPath = path.join(
        getOrchestratorRoot(repoRoot),
        'runtime',
        'reviews',
        `${taskId}-preflight.json`
    );
    fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
    fs.writeFileSync(preflightPath, `${JSON.stringify({
        task_id: taskId,
        scope_category: 'test-only',
        changed_files: ['tests/node/gates/focused-command.test.ts'],
        metrics: {
            scope_content_sha256: 'a'.repeat(64)
        }
    }, null, 2)}\n`, 'utf8');
    return preflightPath;
}

describe('cli/commands/gates intermediate command wrapper', () => {
    it('preserves a nonzero exit and the full redacted log while showing only the last 50 lines', async (t) => {
        const repoRoot = createTempRepo();
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        const taskId = 'T-INTERMEDIATE-FAILURE';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        seedNodeFoundationFocusedWrapperFixture(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'scripts/node-foundation/build-scripts.cjs'), [
            "for (let index = 0; index < 75; index++) console.log(`failure-line-${index}`);",
            "console.log('ACCESS_TOKEN=secret-value');",
            'process.exitCode = 7;'
        ].join('\n'), 'utf8');
        const result = await runIntermediateCommandCommand({
            repoRoot, taskId, commandSource: 'targeted-test',
            command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
            timeoutMs: 60_000
        });
        assert.equal(result.exitCode, 7);
        assert.equal(result.outputLines[0], 'INTERMEDIATE_COMMAND_FAILED');
        const event = readTaskTimelineEvents(repoRoot, taskId).find((entry) => entry.event_type === 'INTERMEDIATE_COMMAND_RUN');
        assert.ok(event);
        assert.equal(event.outcome, 'FAILED');
        const details = event.details as Record<string, unknown>;
        assert.equal(details.exit_code, 7);
        const outputPath = String(details.output_artifact_path);
        const raw = fs.readFileSync(outputPath, 'utf8');
        const rawLines = raw.trimEnd().split('\n');
        assert.equal(rawLines.length, 76);
        assert.equal(rawLines[0], 'failure-line-0');
        assert.equal(rawLines[74], 'failure-line-74');
        assert.ok(!raw.includes('secret-value'));
        assert.deepEqual(result.outputLines.slice(7, 57), rawLines.slice(-50));
        assert.ok(!result.outputLines.includes('failure-line-0'));
        assert.ok(!result.outputLines.join('\n').includes('secret-value'));
        assert.equal(details.output_artifact_sha256, createHash('sha256').update(raw).digest('hex'));
        assert.equal(details.output_artifact_size_bytes, Buffer.byteLength(raw));
        const record = JSON.parse(fs.readFileSync(String(details.artifact_path), 'utf8'));
        assert.equal(record.status, 'FAILED');
        assert.equal(record.exit_code, 7);
        assert.equal(record.output_telemetry.parser_strategy, 'bounded_failure_tail');
    });

    it('records an ordinary command timeout as failure instead of a successful or expected-red run', async (t) => {
        const repoRoot = createTempRepo();
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        const taskId = 'T-INTERMEDIATE-TIMEOUT';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        seedNodeFoundationFocusedWrapperFixture(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'scripts/node-foundation/build-scripts.cjs'), 'setInterval(() => {}, 1000);\n', 'utf8');
        const result = await runIntermediateCommandCommand({
            repoRoot, taskId, commandSource: 'targeted-test',
            command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
            timeoutMs: 200
        });
        assert.notEqual(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'INTERMEDIATE_COMMAND_FAILED');
        assert.match(result.outputLines.join('\n'), /timed out|timeout/iu);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const event = events.find((entry) => entry.event_type === 'INTERMEDIATE_COMMAND_RUN');
        assert.ok(event);
        assert.equal(event.outcome, 'FAILED');
        assert.equal(events.some((entry) => entry.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'), false);
        const details = event.details as Record<string, unknown>;
        const record = JSON.parse(fs.readFileSync(String(details.artifact_path), 'utf8'));
        assert.equal(record.status, 'FAILED');
        assert.equal(record.exit_code, result.exitCode);
        assert.equal(record.expected_failure, undefined);
        assert.match(fs.readFileSync(String(details.output_artifact_path), 'utf8'), /timed out|timeout/iu);
    });

    it('propagates a failed focused command through the real CLI with persisted failure evidence', (t) => {
        const repoRoot = createTempRepo();
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        const taskId = 'T-INTERMEDIATE-CLI-FAIL';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        seedNodeFoundationFocusedWrapperFixture(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'scripts/node-foundation/build-scripts.cjs'), "console.error('focused failure'); process.exitCode = 7;\n", 'utf8');
        const result = childProcess.spawnSync(process.execPath, [
            path.join(process.cwd(), 'bin/garda.js'), 'gate', 'run-intermediate-command',
            '--task-id', taskId, '--command-source', 'targeted-test',
            '--command', 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
            '--timeout-ms', '60000', '--repo-root', repoRoot
        ], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 7, result.stderr || result.stdout);
        assert.match(result.stdout, /INTERMEDIATE_COMMAND_FAILED/u);
        assert.match(result.stdout, /focused failure/u);
        const event = readTaskTimelineEvents(repoRoot, taskId).find((entry) => entry.event_type === 'INTERMEDIATE_COMMAND_RUN');
        assert.ok(event);
        assert.equal(event.outcome, 'FAILED');
        assert.equal((event.details as Record<string, unknown>).exit_code, 7);
    });

    it('runs intermediate commands with compact audited output telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
            fs.writeFileSync(
                path.join(repoRoot, 'tests', 'intermediate-pass.test.js'),
                [
                    "const test = require('node:test');",
                    "for (let index = 0; index < 80; index += 1) {",
                    "  test(`VISIBLE_RAW_LINE_ONE verbose intermediate output line ${index} with enough padding to make compaction measurable`, () => {});",
                    "}",
                    "test('ACCESS_TOKEN=secret-value', () => {",
                    "  for (let index = 0; index < 40; index += 1) {",
                    "    console.log(`verbose intermediate output line ${index} with enough padding to make compaction measurable`);",
                    "  }",
                    '});',
                    ''
                ].join('\n'),
                'utf8'
            );

            const result = await runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'node-test',
                command: 'node --test tests/intermediate-pass.test.js',
                timeoutMs: 60_000
            });

            assert.equal(result.exitCode, 0);
            const output = result.outputLines.join('\n');
            assert.ok(output.includes('INTERMEDIATE_COMMAND_PASSED'));
            assert.ok(output.includes('CommandSource: node-test'));
            assert.ok(output.includes('OutputArtifact:'));
            assert.ok(output.includes('OutputTelemetry:'));
            assert.ok(!output.includes('VISIBLE_RAW_LINE_ONE'));
            assert.ok(!output.includes('secret-value'));

            const outputArtifactLine = result.outputLines.find((line) => line.startsWith('OutputArtifact: '));
            assert.ok(outputArtifactLine);
            const outputArtifactPath = outputArtifactLine.slice('OutputArtifact: '.length);
            const artifactOutput = fs.readFileSync(outputArtifactPath, 'utf8');
            assert.ok(artifactOutput.length > 0);
            assert.ok(!artifactOutput.includes('secret-value'));

            const events = readTaskTimelineEvents(repoRoot, taskId);
            const event = events.find((candidate) => candidate.event_type === 'INTERMEDIATE_COMMAND_RUN');
            assert.ok(event);
            assert.equal(event.outcome, 'PASSED');
            const details = event.details as Record<string, unknown>;
            assert.equal(details?.command_source, 'node-test');
            assert.match(String(details?.artifact_sha256 || ''), /^[a-f0-9]{64}$/u);
            assert.match(String(details?.output_artifact_sha256 || ''), /^[a-f0-9]{64}$/u);
            assert.ok(Number(details?.output_artifact_size_bytes) > 0);
            const telemetry = details?.output_telemetry as Record<string, unknown> | undefined;
            assert.ok(telemetry);
            assert.ok(Number(telemetry.raw_line_count) > 0);
            assert.ok(Number(telemetry.filtered_line_count) > 0);
            assert.equal(telemetry.filter_mode, 'compact_summary');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows node-foundation focused test wrapper as a targeted intermediate command', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeFoundationFocusedWrapperFixture(repoRoot);

            const result = await runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'targeted-test',
                command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
                timeoutMs: 60_000
            });

            assert.equal(result.exitCode, 0);
            const output = result.outputLines.join('\n');
            assert.ok(output.includes('INTERMEDIATE_COMMAND_PASSED'));
            assert.ok(output.includes('CommandSource: targeted-test'));

            const events = readTaskTimelineEvents(repoRoot, taskId);
            const event = events.find((candidate) => candidate.event_type === 'INTERMEDIATE_COMMAND_RUN');
            assert.ok(event);
            assert.equal((event.details as Record<string, unknown>)?.command_source, 'targeted-test');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('records a bounded nonzero focused test as explicit expected-red evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-EXPECTED-RED';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeFoundationFocusedWrapperFixture(repoRoot);
            const preflightPath = seedExpectedRedPreflight(repoRoot, taskId);
            fs.appendFileSync(
                path.join(repoRoot, 'scripts', 'node-foundation', 'build-scripts.cjs'),
                'process.exitCode = 1;\n',
                'utf8'
            );

            const result = await runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'targeted-test',
                command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
                preflightPath,
                expectFailure: true,
                timeoutMs: 60_000
            });

            assert.equal(result.exitCode, 0);
            assert.match(result.outputLines.join('\n'), /TEST_FIRST_EXPECTED_FAILURE_RECORDED/u);
            const event = readTaskTimelineEvents(repoRoot, taskId)
                .find((candidate) => candidate.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED');
            assert.ok(event);
            assert.equal(event.outcome, 'PASS');
            const details = event.details as Record<string, unknown>;
            assert.equal(details.expected_failure, true);
            assert.equal(details.recorded_status, 'EXPECTED_FAILURE');
            assert.equal(details.exit_code, 1);
            assert.equal(details.test_scope_sha256, 'a'.repeat(64));
            const artifact = JSON.parse(fs.readFileSync(String(details.artifact_path), 'utf8')) as Record<string, unknown>;
            assert.equal(artifact.status, 'EXPECTED_FAILURE');
            assert.equal(artifact.exit_code, 1);
            assert.equal(artifact.timed_out, false);
            assert.equal(artifact.cancelled, false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fails closed when an expected-red focused test unexpectedly passes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-EXPECTED-PASS';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeFoundationFocusedWrapperFixture(repoRoot);
            const preflightPath = seedExpectedRedPreflight(repoRoot, taskId);

            const result = await runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'targeted-test',
                command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
                preflightPath,
                expectFailure: true,
                timeoutMs: 60_000
            });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.match(result.outputLines.join('\n'), /TEST_FIRST_EXPECTED_FAILURE_NOT_REPRODUCED/u);
            const event = readTaskTimelineEvents(repoRoot, taskId)
                .find((candidate) => candidate.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED');
            assert.ok(event);
            assert.equal(event.outcome, 'FAIL');
            assert.equal((event.details as Record<string, unknown>).recorded_status, 'UNEXPECTED_PASS');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects expected-red mode without the exact task declaration', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-UNDECLARED-RED';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeFoundationFocusedWrapperFixture(repoRoot);
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace('| fixture |', '| TEST-FIRST : EXPECTED-RED. |'),
                'utf8'
            );
            const preflightPath = path.join(
                getOrchestratorRoot(repoRoot),
                'runtime',
                'reviews',
                `${taskId}-preflight.json`
            );
            fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
            fs.writeFileSync(preflightPath, `${JSON.stringify({
                task_id: taskId,
                scope_category: 'test-only',
                changed_files: ['tests/node/gates/focused-command.test.ts'],
                metrics: { scope_content_sha256: 'a'.repeat(64) }
            })}\n`, 'utf8');

            await assert.rejects(
                () => runIntermediateCommandCommand({
                    repoRoot,
                    taskId,
                    commandSource: 'targeted-test',
                    command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
                    preflightPath,
                    expectFailure: true,
                    timeoutMs: 60_000
                }),
                /exact TASK\.md Notes marker/u
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects foreign, non-test-only, stale, and unrelated expected-red bindings before execution', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INVALID-RED-BINDING';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeFoundationFocusedWrapperFixture(repoRoot);
            const preflightPath = seedExpectedRedPreflight(repoRoot, taskId);
            const basePreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            const command = 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts';
            const invoke = (overrides: Record<string, unknown> = {}) => runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'targeted-test',
                command,
                preflightPath,
                expectFailure: true,
                timeoutMs: 60_000,
                ...overrides
            });
            const writePreflight = (overrides: Record<string, unknown>) => {
                fs.writeFileSync(
                    preflightPath,
                    `${JSON.stringify({ ...basePreflight, ...overrides }, null, 2)}\n`,
                    'utf8'
                );
            };

            writePreflight({ task_id: 'T-FOREIGN' });
            await assert.rejects(invoke, /preflight task_id must match/u);

            writePreflight({ scope_category: 'mixed' });
            await assert.rejects(invoke, /current test-only preflight scope/u);

            writePreflight({});
            await assert.rejects(
                () => invoke({ preflightSha256: 'b'.repeat(64) }),
                /preflight-sha256 does not match/u
            );

            fs.writeFileSync(
                path.join(repoRoot, 'tests', 'node', 'gates', 'unrelated.test.ts'),
                'export {};\n',
                'utf8'
            );
            await assert.rejects(
                () => invoke({
                    command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/unrelated.test.ts'
                }),
                /concrete changed test/u
            );

            const timelinePath = path.join(
                getOrchestratorRoot(repoRoot),
                'runtime',
                'task-events',
                `${taskId}.jsonl`
            );
            const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
            assert.equal(
                events.some((candidate) => candidate.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'),
                false
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fails closed when an expected-red command times out or is cancelled', async () => {
        for (const interruption of ['timeout', 'cancelled'] as const) {
            const repoRoot = createTempRepo();
            const taskId = interruption === 'timeout' ? 'T-RED-TIMEOUT' : 'T-RED-CANCELLED';
            try {
                seedTaskQueue(repoRoot, taskId);
                seedInitAnswers(repoRoot);
                seedNodeFoundationFocusedWrapperFixture(repoRoot);
                const preflightPath = seedExpectedRedPreflight(repoRoot, taskId);
                fs.writeFileSync(
                    path.join(repoRoot, 'scripts', 'node-foundation', 'build-scripts.cjs'),
                    'setInterval(() => {}, 1_000);\n',
                    'utf8'
                );
                const abortController = new AbortController();
                const abortTimer = interruption === 'cancelled'
                    ? setTimeout(() => abortController.abort(), 100)
                    : null;
                let result: Awaited<ReturnType<typeof runIntermediateCommandCommand>>;
                try {
                    result = await runIntermediateCommandCommand({
                        repoRoot,
                        taskId,
                        commandSource: 'targeted-test',
                        command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
                        preflightPath,
                        expectFailure: true,
                        timeoutMs: interruption === 'timeout' ? 100 : 10_000,
                        signal: interruption === 'cancelled' ? abortController.signal : undefined
                    });
                } finally {
                    if (abortTimer) clearTimeout(abortTimer);
                }

                assert.equal(result.exitCode, EXIT_GATE_FAILURE, interruption);
                assert.match(result.outputLines.join('\n'), /INTERMEDIATE_COMMAND_FAILED/u);
                const event = readTaskTimelineEvents(repoRoot, taskId)
                    .find((candidate) => candidate.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED');
                assert.ok(event);
                assert.equal(event.outcome, 'FAIL');
                const details = event.details as Record<string, unknown>;
                assert.equal(details.recorded_status, 'FAILED');
                assert.equal(details.timed_out, interruption === 'timeout');
                assert.equal(details.cancelled, interruption === 'cancelled');
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
    });

    it('persists optional preflight and coverage bindings for focused evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeFoundationFocusedWrapperFixture(repoRoot);
            const preflightPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'reviews', `${taskId}-preflight.json`);
            fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
            fs.writeFileSync(preflightPath, '{"task_id":"T-INTERMEDIATE"}\n', 'utf8');
            const coverageContractSha256 = 'b'.repeat(64);

            const result = await runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'targeted-test',
                command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
                preflightPath,
                coverageContractSha256,
                timeoutMs: 60_000
            });

            assert.equal(result.exitCode, 0);
            const events = readTaskTimelineEvents(repoRoot, taskId);
            const event = events.find((candidate) => candidate.event_type === 'INTERMEDIATE_COMMAND_RUN');
            assert.ok(event);
            const details = event.details as Record<string, unknown>;
            assert.equal(String(details.preflight_path).replace(/\\/g, '/'), preflightPath.replace(/\\/g, '/'));
            assert.match(String(details.preflight_sha256), /^[a-f0-9]{64}$/u);
            assert.equal(details.coverage_contract_sha256, coverageContractSha256);
            const artifact = JSON.parse(fs.readFileSync(String(details.artifact_path), 'utf8')) as Record<string, unknown>;
            assert.equal(String(artifact.preflight_path).replace(/\\/g, '/'), preflightPath.replace(/\\/g, '/'));
            assert.equal(artifact.preflight_sha256, details.preflight_sha256);
            assert.equal(artifact.coverage_contract_sha256, coverageContractSha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects malformed optional focused evidence hash bindings before execution', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeFoundationFocusedWrapperFixture(repoRoot);

            await assert.rejects(
                () => runIntermediateCommandCommand({
                    repoRoot,
                    taskId,
                    commandSource: 'targeted-test',
                    command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
                    preflightSha256: 'not-a-sha256',
                    timeoutMs: 60_000
                }),
                /--preflight-sha256 must be a 64-character/u
            );
            await assert.rejects(
                () => runIntermediateCommandCommand({
                    repoRoot,
                    taskId,
                    commandSource: 'targeted-test',
                    command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
                    coverageContractSha256: 'not-a-sha256',
                    timeoutMs: 60_000
                }),
                /--coverage-contract-sha256 must be a 64-character/u
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows node-foundation focused test wrapper through the reviewer-facing CLI entrypoint', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeFoundationFocusedWrapperFixture(repoRoot);

            const cliPath = path.join(process.cwd(), 'bin', 'garda.js');
            const result = childProcess.spawnSync(
                process.execPath,
                [
                    cliPath,
                    'gate',
                    'run-intermediate-command',
                    '--task-id',
                    taskId,
                    '--command-source',
                    'targeted-test',
                    '--command',
                    'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
                    '--timeout-ms',
                    '60000',
                    '--repo-root',
                    repoRoot
                ],
                {
                    cwd: repoRoot,
                    encoding: 'utf8',
                    timeout: 60_000
                }
            );

            assert.equal(result.status, 0, result.stderr || result.stdout);
            const output = `${result.stdout}\n${result.stderr}`;
            assert.ok(output.includes('INTERMEDIATE_COMMAND_PASSED'));
            assert.ok(output.includes('CommandSource: targeted-test'));

            const events = readTaskTimelineEvents(repoRoot, taskId);
            const event = events.find((candidate) => candidate.event_type === 'INTERMEDIATE_COMMAND_RUN');
            assert.ok(event);
            assert.equal((event.details as Record<string, unknown>)?.command_source, 'targeted-test');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects arbitrary intermediate commands without recording token telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);

            const result = await runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'targeted-test',
                command: 'git status'
            });

            const output = result.outputLines.join('\n');
            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.ok(output.includes('INTERMEDIATE_COMMAND_REJECTED'));
            assert.ok(output.includes('CommandSource: targeted-test'));
            assert.ok(output.includes('not eligible'));
            const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
            const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
            assert.equal(events.some((event) => event.event_type === 'INTERMEDIATE_COMMAND_RUN'), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects path-qualified intermediate command shims', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);

            const npmShimResult = await runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'targeted-test',
                command: './npm test -- --runInBand'
            });
            const absoluteNodeResult = await runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'node-test',
                command: `${path.join(repoRoot, 'node.exe')} --test intermediate-pass.test.js`
            });

            assert.equal(npmShimResult.exitCode, EXIT_GATE_FAILURE);
            assert.equal(absoluteNodeResult.exitCode, EXIT_GATE_FAILURE);
            assert.ok(npmShimResult.outputLines.join('\n').includes('INTERMEDIATE_COMMAND_REJECTED'));
            assert.ok(absoluteNodeResult.outputLines.join('\n').includes('INTERMEDIATE_COMMAND_REJECTED'));
            const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
            const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
            assert.equal(events.some((event) => event.event_type === 'INTERMEDIATE_COMMAND_RUN'), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects unsafe focused test wrapper targets without recording telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeFoundationFocusedWrapperFixture(repoRoot);

            const rejectedCommands = [
                'node scripts/node-foundation/build-scripts.cjs test.js src/cli/not-a-focused-test.ts',
                'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/../secret.test.ts',
                'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates',
                'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.ts',
                'node scripts/node-foundation/build-scripts.cjs test.js --runInBand tests/node/gates/focused-command.test.ts',
                'node --test tests/node/gates/focused-command.test.ts',
                'npm test -- --help',
                'npm test -- tests/node/gates/focused-command.test.ts --runInBand',
                'npm test -- src/cli/not-a-focused-test.ts'
            ];

            for (const command of rejectedCommands) {
                const result = await runIntermediateCommandCommand({
                    repoRoot,
                    taskId,
                    commandSource: 'targeted-test',
                    command,
                    timeoutMs: 60_000
                });

                assert.equal(result.exitCode, EXIT_GATE_FAILURE, command);
                const output = result.outputLines.join('\n');
                assert.ok(output.includes('INTERMEDIATE_COMMAND_REJECTED'), command);
                assert.ok(output.includes('CommandSource: targeted-test'), command);
                assert.ok(output.includes('not eligible'), command);
            }

            const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
            const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
            assert.equal(events.some((event) => event.event_type === 'INTERMEDIATE_COMMAND_RUN'), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects unsafe node-test arguments without recording telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);

            for (const command of [
                'node --test --help',
                'node --test src/cli/not-a-focused-test.ts',
                'node --test tests/node/gates/../secret.test.ts',
                'node --test tests/node/gates/focused-command.test.ts --test-reporter spec',
                'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts'
            ]) {
                const result = await runIntermediateCommandCommand({
                    repoRoot,
                    taskId,
                    commandSource: 'node-test',
                    command,
                    timeoutMs: 60_000
                });

                assert.equal(result.exitCode, EXIT_GATE_FAILURE, command);
                assert.ok(result.outputLines.join('\n').includes('INTERMEDIATE_COMMAND_REJECTED'), command);
            }

            const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', taskId + '.jsonl');
            const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
            assert.equal(events.some((event) => event.event_type === 'INTERMEDIATE_COMMAND_RUN'), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
