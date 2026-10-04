import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    executeCommand,
    executeCommandAsync,
    resolveExecutablePath,
    type ExecuteCommandOptions
} from '../../../../../../src/cli/gate-cli/gates-subprocess';

import { EXIT_GATE_FAILURE } from '../../../../../../src/cli/exit-codes';
import { runRequiredReviewsCheckCommand, runCompileGateCommand } from '../../../../../../src/cli/commands/gates';
import {
    createTempRepo, seedTaskQueue, seedInitAnswers, getOrchestratorRoot, getReviewsRoot,
    runEnterTaskMode, loadTaskEntryRulePack, runHandshakeForTask, runShellSmokeForTask,
    initializeGitRepo, runExplicitPreflight, loadPostPreflightRulePack, writeBudgetOutputFilters
} from '../../gate-test-helpers';

function quoteArgument(value: string): string {
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function nodeCommand(source: string): string {
    return quoteArgument(process.execPath) + ' -e ' + quoteArgument(source);
}

function markerCommand(markerPath: string): string {
    return nodeCommand('require("node:fs").writeFileSync(' + JSON.stringify(markerPath) + ', "ran")');
}

function createToolFixtures(cwd: string, toolNames: string[]): string[] {
    const toolSourcePath = path.join(cwd, 'tool fixture.js');
    fs.writeFileSync(toolSourcePath,
        'console.log(JSON.stringify(process.argv.slice(2)));'
        + 'if (process.argv.includes("--fail")) process.exit(23);', 'utf8');
    return toolNames.map((toolName) => {
        const toolPath = path.join(cwd, toolName + (process.platform === 'win32' ? '.cmd' : ''));
        const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
        fs.writeFileSync(toolPath, process.platform === 'win32'
            ? '@echo off\r\n"' + process.execPath + '" "' + toolSourcePath + '" %*\r\n'
            : '#!/bin/sh\nexec ' + shellQuote(process.execPath) + ' '
                + shellQuote(toolSourcePath) + ' "$@"\n', { mode: 0o755 });
        return toolPath;
    });
}

const runners = [
    { name: 'sync', execute: async (command: string, options?: ExecuteCommandOptions) => executeCommand(command, options) },
    { name: 'async', execute: executeCommandAsync }
];

describe('gates command chains', () => {
    it('blocks review completion after a chained compile command fails', async (t) => {
        const repoRoot = createTempRepo();
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        const taskId = 'T-901-command-chain';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const configPath = path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'workflow-config.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            project_memory_maintenance: { enabled: false },
            compile_gate: {
                command: 'node -e "console.log(\'first command\')" && '
                    + 'node -e "console.error(\'child failed\'); process.exit(29)" && '
                    + 'node -e "require(\'node:fs\').writeFileSync(\'must-not-run\', \'ran\')"'
            }
        }, null, 2), 'utf8');
        assert.equal(runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Update app flow' }).exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        initializeGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changed = true;\n', 'utf8');
        const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Update app flow', ['src/app.ts']);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({ repoRoot, taskId, preflightPath, outputFiltersPath: writeBudgetOutputFilters(repoRoot), emitMetrics: false });
        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const evidence = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(repoRoot), taskId + '-compile-gate.json'), 'utf8'));
        assert.equal(evidence.status, 'FAILED');
        assert.equal(evidence.exit_code, 29);
        assert.equal(fs.existsSync(path.join(repoRoot, 'must-not-run')), false);
        assert.ok(result.outputLines.join('\n').includes('child failed'));
        const review = runRequiredReviewsCheckCommand({ repoRoot, taskId, preflightPath, emitMetrics: false });
        assert.equal(review.exitCode, EXIT_GATE_FAILURE);
        assert.ok(review.outputLines.join('\n').includes('Compile gate did not pass'));
        assert.equal(fs.existsSync(path.join(getReviewsRoot(repoRoot), taskId + '-code-review-context.json')), false);
    });

    for (const runner of runners) {
        describe(runner.name, () => {
            it('executes successful commands in order, including adjacent conjunctions', async () => {
                const result = await runner.execute(
                    nodeCommand('console.log("FIRST")') + '&&' + nodeCommand('console.log("SECOND")')
                );
                assert.equal(result.exitCode, 0);
                assert.equal(result.timedOut, false);
                assert.deepEqual(result.outputLines, ['FIRST', 'SECOND']);
            });

            for (const failedIndex of [0, 1]) {
                it('preserves failure code and short-circuits at command ' + (failedIndex + 1), async (t) => {
                    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'garda chain failure '));
                    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
                    const markerPath = path.join(cwd, 'should not run');
                    const commands = [
                        ...(failedIndex === 1 ? [nodeCommand('console.log("FIRST")')] : []),
                        nodeCommand('console.error("FAILED"); process.exit(37)'),
                        markerCommand(markerPath)
                    ];
                    const result = await runner.execute(commands.join(' && '), { cwd });
                    assert.equal(result.exitCode, 37);
                    assert.equal(result.timedOut, false);
                    assert.deepEqual(result.outputLines, failedIndex === 1 ? ['FIRST', 'FAILED'] : ['FAILED']);
                    assert.equal(fs.existsSync(markerPath), false);
                });
            }

            it('preserves unquoted literal punctuation in single commands and chains', async () => {
                const values = ['$NAME', 'folder(name)', '`value`', '$(value)'];
                const command = nodeCommand('console.log(JSON.stringify(process.argv.slice(1)))')
                    + ' -- ' + values.join(' ');
                const single = await runner.execute(command);
                assert.equal(single.exitCode, 0);
                assert.deepEqual(JSON.parse(single.outputLines[0]), values);
                const chain = await runner.execute(command + ' && ' + command);
                assert.equal(chain.exitCode, 0);
                assert.equal(chain.outputLines.length, 2);
                assert.deepEqual(chain.outputLines.map((line) => JSON.parse(line)), [values, values]);
            });

            it('preserves quoted conjunctions, spaces, empty arguments and quote escapes', async () => {
                const argumentsToForward = ['&&', '', 'path with spaces', 'a"b', 'C:\\tools\\file'];
                const command = nodeCommand('console.log(JSON.stringify(process.argv.slice(1)))')
                    + ' -- ' + argumentsToForward.map(quoteArgument).join(' ')
                    + ' && ' + nodeCommand('console.log("LAST")');
                const result = await runner.execute(command);
                assert.equal(result.exitCode, 0);
                assert.deepEqual(JSON.parse(result.outputLines[0]), argumentsToForward);
                assert.equal(result.outputLines[1], 'LAST');
            });

            it('preserves single-quoted literal operators and concatenated quoted words', async () => {
                const result = await runner.execute(
                    nodeCommand('console.log(JSON.stringify(process.argv.slice(1)))')
                    + " -- '&&' pre' spaced 'post && " + nodeCommand('console.log("LAST")')
                );
                assert.equal(result.exitCode, 0);
                assert.deepEqual(JSON.parse(result.outputLines[0]), ['&&', 'pre spaced post']);
                assert.equal(result.outputLines[1], 'LAST');
            });

            it('keeps npm --prefix and Maven -f arguments in their own invocations', async (t) => {
                const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'garda tool chain '));
                t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
                const toolPaths = createToolFixtures(cwd, ['npm', 'mvn']);
                const npmCommand = quoteArgument(toolPaths[0]) + ' --prefix "store frontend" run build';
                const mavenCommand = quoteArgument(toolPaths[1]) + ' -f "service backend/pom.xml" -DskipTests compile';
                const result = await runner.execute(npmCommand + ' && ' + mavenCommand, { cwd });
                assert.equal(result.exitCode, 0);
                assert.deepEqual(result.outputLines.map((line) => JSON.parse(line)), [
                    ['--prefix', 'store frontend', 'run', 'build'],
                    ['-f', 'service backend/pom.xml', '-DskipTests', 'compile']
                ]);

                const markerPath = path.join(cwd, 'third-command');
                const failed = await runner.execute(
                    npmCommand + ' && ' + mavenCommand + ' --fail && ' + markerCommand(markerPath), { cwd }
                );
                assert.equal(failed.exitCode, 23);
                assert.equal(fs.existsSync(markerPath), false);
            });

            it('executes arbitrary program names resolved through PATH with literal argv', async (t) => {
                const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'garda arbitrary tools '));
                t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
                createToolFixtures(cwd, ['garda-build-probe', 'garda-check-probe']);
                const first = 'garda-build-probe --destination "output folder" "&&"';
                const second = 'garda-check-probe --style arbitrary';
                const result = await runner.execute(first + ' && ' + second, { cwd, envPath: cwd });
                assert.equal(result.exitCode, 0);
                assert.deepEqual(result.outputLines.map((line) => JSON.parse(line)), [
                    ['--destination', 'output folder', '&&'], ['--style', 'arbitrary']
                ]);
                const markerPath = path.join(cwd, 'must not run');
                const failure = await runner.execute(
                    first + ' && ' + second + ' --fail && ' + markerCommand(markerPath), { cwd, envPath: cwd }
                );
                assert.equal(failure.exitCode, 23);
                assert.equal(failure.outputLines.length, 2);
                assert.equal(fs.existsSync(markerPath), false);
            });

            it('uses a single timeout budget for the entire chain', async (t) => {
                const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'garda chain timeout '));
                t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
                const markerPath = path.join(cwd, 'third-command');
                const delay = nodeCommand('console.log("STARTED"); setTimeout(() => {}, 700)');
                const result = await runner.execute(delay + ' && ' + delay + ' && ' + markerCommand(markerPath), {
                    cwd, timeoutMs: 1150
                });
                assert.equal(result.timedOut, true);
                assert.notEqual(result.exitCode, 0);
                assert.equal(fs.existsSync(markerPath), false);
                assert.ok(result.outputLines.includes('STARTED'));
            });

            it('preserves large child output and the failing exit code without starting the next command', async () => {
                const output = 'process.stdout.write("x\\n".repeat(200000));';
                const successful = await runner.execute(nodeCommand(output));
                assert.equal(successful.exitCode, 0);
                assert.equal(successful.outputLines.length, 200000);
                assert.equal(successful.outputLines[0], 'x');
                assert.equal(successful.outputLines[199999], 'x');
                const failure = await runner.execute(nodeCommand(output + 'process.exitCode = 41;')
                    + ' && ' + nodeCommand('console.log("MUST NOT RUN")'));
                assert.equal(failure.exitCode, 41);
                assert.equal(failure.outputLines.length, 200000);
                assert.equal(failure.outputLines.includes('MUST NOT RUN'), false);
            });

            it('keeps quoted executable whitespace literal instead of launching a trimmed alias', async (t) => {
                const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'garda literal executable '));
                t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
                createToolFixtures(cwd, ['garda-literal-probe']);
                const markerPath = path.join(cwd, 'must not run');
                for (const padded of ['garda-literal-probe ', ' garda-literal-probe']) {
                    if (process.platform === 'win32') {
                        assert.throws(() => resolveExecutablePath(padded, cwd, cwd), /not found in PATH/);
                    } else {
                        assert.equal(resolveExecutablePath(padded, cwd, cwd), padded);
                    }
                    try {
                        const result = await runner.execute(quoteArgument(padded) + ' && ' + markerCommand(markerPath), { cwd, envPath: cwd });
                        assert.notEqual(result.exitCode, 0);
                    } catch (error) {
                        assert.match(String(error), /not found|ENOENT/i);
                    }
                    assert.equal(fs.existsSync(markerPath), false);
                }
            });

            for (const operator of ['||', '|', ';', '&', '>', '<', '\n']) {
                it('rejects unsupported unquoted syntax before any child starts: ' + JSON.stringify(operator), async (t) => {
                    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'garda chain syntax '));
                    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
                    const markerPath = path.join(cwd, 'must not run');
                    await assert.rejects(
                        () => runner.execute(markerCommand(markerPath) + ' ' + operator + ' node ignored', { cwd }),
                        /Unsupported command syntax/i
                    );
                    assert.equal(fs.existsSync(markerPath), false);
                });
            }

            for (const invalid of [
                '&& ' + nodeCommand('process.exit(0)'),
                nodeCommand('process.exit(0)') + ' &&',
                nodeCommand('process.exit(0)') + ' && && ' + nodeCommand('process.exit(0)')
            ]) {
                it('rejects empty chain segments: ' + invalid.slice(0, 40), async () => {
                    await assert.rejects(() => runner.execute(invalid), /empty command/i);
                });
            }

            it('rejects an environment assignment as the executable with an actionable error', async () => {
                await assert.rejects(
                    () => runner.execute('GARDA_CHAIN_VALUE=1 ' + nodeCommand('process.exit(0)')),
                    /Unsupported command syntax.*environment assignment/i
                );
            });

            it('rejects quoted environment values before earlier chain children can run', async (t) => {
                const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'garda quoted assignment '));
                t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
                const markerPath = path.join(cwd, 'must not run');
                for (const assignment of ['FOO="bar"', "FOO='bar'", 'FOO=pre" spaced "post', 'FOO=""']) {
                    await assert.rejects(() => runner.execute(markerCommand(markerPath) + ' && '
                        + assignment + ' ' + nodeCommand('process.exit(0)'), { cwd }), /environment assignment/i);
                    assert.equal(fs.existsSync(markerPath), false);
                }
            });

            it('runs fully quoted assignment-shaped executable names as literal programs', async (t) => {
                const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'garda literal assignment executable '));
                t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
                createToolFixtures(cwd, ['GARDA_CHAIN_PROBE=bar']);
                const result = await runner.execute('"GARDA_CHAIN_PROBE=bar" --style custom && '
                    + nodeCommand('console.log("LAST")'), { cwd, envPath: cwd });
                assert.equal(result.exitCode, 0);
                assert.deepEqual(JSON.parse(result.outputLines[0]), ['--style', 'custom']);
                assert.equal(result.outputLines[1], 'LAST');
            });

            it('redacts output from every command in a successful chain', async () => {
                const result = await runner.execute(
                    nodeCommand('console.log("NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz123456")')
                    + ' && ' + nodeCommand('console.error("ACCESS_TOKEN=chain-secret-value")')
                );
                assert.equal(result.exitCode, 0);
                assert.equal(result.outputLines.length, 2);
                assert.ok(result.outputLines.every((line) => line.includes('<redacted>')));
                assert.ok(result.outputLines.every((line) => !line.includes('chain-secret-value')));
            });
        });
    }

    it('prevents unbounded output across noisy chain children and retains the failing tail', async () => {
        const chainBudgetBytes = 40 * 1024 * 1024;
        const noisyCommand = nodeCommand('process.stdout.write("CHUNK\\n" + "Я".repeat(450000) + "\\n")');
        const commandCount = Math.floor(chainBudgetBytes / 900000) + 1;
        const commands = [
            nodeCommand('console.log("CHAIN FIRST")'),
            ...new Array<string>(commandCount).fill(noisyCommand),
            nodeCommand('console.error("CHAIN FAILURE ACCESS_TOKEN=chain-secret-value"); process.exit(47)'),
            nodeCommand('console.log("MUST NOT RUN")')
        ];
        const results = [];
        for (const runner of runners) results.push(await runner.execute(commands.join(' && ')));
        const outputs = results.map((result) => result.outputLines.join('\n'));
        assert.deepEqual(results.map((result) => result.exitCode), [47, 47]);
        assert.ok(outputs.every((output) => Buffer.byteLength(output, 'utf8') <= chainBudgetBytes + 256),
            'aggregate output must have one byte budget plus its truncation marker');
        assert.ok(outputs.every((output) => output.includes('output truncated')));
        assert.ok(outputs.every((output) => output.startsWith('CHAIN FIRST\n')));
        assert.ok(outputs.every((output) => output.includes('CHAIN FAILURE ACCESS_TOKEN=<redacted>')));
        assert.ok(outputs.every((output) => !output.includes('chain-secret-value')));
        assert.ok(outputs.every((output) => !output.includes('MUST NOT RUN')));
        assert.ok(outputs.every((output) => !output.includes('\uFFFD')), 'UTF-8 truncation must retain complete characters');
    });

    it('rejects a pipeline before either command executes', async (t) => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'garda chain pipeline '));
        t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
        const markerPath = path.join(cwd, 'must not run');
        const command = markerCommand(markerPath) + ' | ' + nodeCommand('process.exit(0)');
        assert.throws(() => executeCommand(command, { cwd }), /Unsupported command syntax/i);
        assert.equal(fs.existsSync(markerPath), false);
        await assert.rejects(() => executeCommandAsync(command, { cwd }), /Unsupported command syntax/i);
        assert.equal(fs.existsSync(markerPath), false);
    });

    it('reports each async child through onSpawn', async () => {
        const spawned: string[] = [];
        const result = await executeCommandAsync(
            nodeCommand('process.exit(0)') + ' && ' + nodeCommand('process.exit(0)'), {
                onSpawn: (child) => spawned.push(child.command)
            }
        );
        assert.equal(result.exitCode, 0);
        assert.equal(spawned.length, 2);
    });

    it('cancels the active async child and does not start the next command', async (t) => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'garda chain cancel '));
        t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
        const markerPath = path.join(cwd, 'must not run');
        const controller = new AbortController();
        const result = await executeCommandAsync(
            nodeCommand('setTimeout(() => {}, 10000)') + ' && ' + markerCommand(markerPath), {
                cwd,
                signal: controller.signal,
                onSpawn: () => controller.abort(),
                timeoutMs: 5000
            }
        );
        assert.equal(result.cancelled, true);
        assert.notEqual(result.exitCode, 0);
        assert.equal(fs.existsSync(markerPath), false);
    });

    it('does not spawn an async child when cancellation was already requested', async () => {
        const controller = new AbortController();
        controller.abort();
        let spawnedChildren = 0;
        const result = await executeCommandAsync(
            nodeCommand('process.exit(0)') + ' && ' + nodeCommand('process.exit(0)'), {
                signal: controller.signal,
                onSpawn: () => { spawnedChildren += 1; }
            }
        );
        assert.equal(result.cancelled, true);
        assert.notEqual(result.exitCode, 0);
        assert.equal(spawnedChildren, 0, 'a cancelled chain must not spawn a child');
    });
});

