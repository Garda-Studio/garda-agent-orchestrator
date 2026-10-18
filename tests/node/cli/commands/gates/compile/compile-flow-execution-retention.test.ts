import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildCompileOutputPresentation,
    executeCompileCommands,
    formatCompileOutputRetentionLine
} from '../../../../../../src/cli/commands/gate-flows/compile/compile-flow-execution-retention';
import {
    EXIT_GENERAL_FAILURE
} from '../../../../../../src/cli/exit-codes';
import { executeCommandAsync } from '../../../../../../src/cli/gate-cli/gates-subprocess';

describe('compile-flow execution and retention helpers', () => {
    it('retains completed invocation evidence when a later executable cannot be discovered', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-compile-discovery-'));
        try {
            fs.writeFileSync(path.join(repoRoot, 'build.cjs'), "console.log('completed build');\n");
            const result = await executeCompileCommands({ repoRoot,
                commands: ['node build.cjs && ./missing-builder && node --version'] });
            assert.equal(result.exitCode, EXIT_GENERAL_FAILURE);
            assert.equal(result.selectedInvocationIndex, 2);
            assert.equal(result.selectedInvocationExecutable, './missing-builder');
            assert.deepEqual(result.invocationExecutions.map(invocation => invocation.exitCode), [0, null]);
            assert.match(result.invocationExecutions[1].executionError ?? '', /not found/);
            assert.equal(result.outputLines[0], 'completed build');
            assert.match(result.outputChunks.join(''), /INVOCATION 1\/3[\s\S]*completed build[\s\S]*EXIT_CODE: 0/);
            assert.match(result.outputChunks.join(''), /INVOCATION 2\/3[\s\S]*EXECUTION_ERROR: .*not found/);
            assert.doesNotMatch(result.outputChunks.join(''), /INVOCATION 3\/3/);
            await assert.rejects(executeCommandAsync('./missing-builder', { cwd: repoRoot }), /not found/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('attributes first and later mixed-runner chain failures to their actual invocation', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-compile-attribution-'));
        const previousPath = process.env.PATH;
        try {
            fs.writeFileSync(path.join(repoRoot, 'driver.cjs'),
                "console.log(process.argv[2] + ' log'); process.exit(Number(process.argv[3]));\n");
            for (const tool of ['npm', 'mvn']) {
                if (process.platform === 'win32') {
                    fs.writeFileSync(path.join(repoRoot, `${tool}.cmd`),
                        `@echo off\r\n"${process.execPath}" "${path.join(repoRoot, 'driver.cjs')}" ${tool} %*\r\n`);
                } else {
                    const executable = path.join(repoRoot, tool);
                    fs.writeFileSync(executable,
                        `#!/usr/bin/env node\nprocess.argv.splice(2, 0, '${tool}'); require('./driver.cjs');\n`);
                    fs.chmodSync(executable, 0o755);
                }
            }
            process.env.PATH = repoRoot + path.delimiter + (previousPath || '');
            for (const [command, strategy, count] of [
                ['npm 7 && mvn 0 && npm 0', 'node', 1],
                ['npm 0 && mvn 7 && npm 0', 'maven', 2]
            ] as const) {
                const result = await executeCompileCommands({ repoRoot, commands: [command] });
                assert.equal(result.exitCode, 7);
                assert.equal(result.selectedCommandProfile?.strategy, strategy);
                assert.equal(result.selectedInvocationIndex, count);
                assert.equal(result.invocationExecutions.length, count);
                assert.equal(result.outputLines.length, count);
                assert.match(result.outputChunks.join(''), new RegExp(`INVOCATION ${count}/3`));
                assert.match(result.outputChunks.join(''), /EXIT_CODE: 7/);
            }
        } finally {
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('executes compile commands sequentially and stops at the first failure', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-compile-exec-'));
        const markerPath = path.join(repoRoot, 'should-not-run.txt');

        const result = await executeCompileCommands({
            repoRoot,
            commands: [
                'node -e "console.log(\'first ok\')"',
                'node -e "console.error(\'second failed\'); process.exit(7)"',
                `node -e "require('fs').writeFileSync('${markerPath.replace(/\\/g, '\\\\')}', 'ran')"`
            ]
        });

        assert.equal(result.exitCode, 7);
        assert.equal(result.exceptionMessage, 'Compile command #2 exited with code 7.');
        assert.equal(result.selectedCommandIndex, 2);
        assert.equal(result.commandAudits.length, 2);
        assert.equal(fs.existsSync(markerPath), false);
        assert.deepEqual(result.outputLines, ['first ok', 'second failed']);
        assert.equal(result.warningCount, 0);
        assert.equal(result.errorCount, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps invocation diagnostics redacted and records only actually executed segments', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-compile-redaction-'));
        try {
            const result = await executeCompileCommands({ repoRoot, commands: [
                'node -e "console.log(\'password=direct-secret\'); process.exit(2)" && node --version'
            ] });
            assert.equal(result.exitCode, 2);
            assert.equal(result.invocationExecutions.length, 1);
            assert.equal(result.invocationExecutions[0].exitCode, 2);
            assert.equal(result.invocationExecutions[0].invocationIndex, 1);
            assert.equal(result.outputChunks.join('').includes('direct-secret'), false);
            assert.equal(result.outputLines.join('').includes('direct-secret'), false);
            assert.match(result.outputChunks.join(''), /INVOCATION 1\/2/);
            assert.doesNotMatch(result.outputChunks.join(''), /INVOCATION 2\/2/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('retains failed compile output and formats retention evidence consistently', () => {
        const presentation = buildCompileOutputPresentation({
            budgetTokensForOutputFilters: null,
            compileCommands: ['node -e "console.error(\'boom\'); process.exit(1)"'],
            errorCount: 1,
            exceptionMessage: 'Compile command #1 exited with code 1.',
            failTailLines: 20,
            outputChunks: ['==== COMMAND 1/1 ====\nboom\n'],
            outputFiltersPath: path.join(os.tmpdir(), 'missing-output-filters.json'),
            outputLines: ['boom'],
            selectedCommandProfile: null,
            warningCount: 0
        });

        assert.equal(presentation.retainCompileOutput, true);
        assert.equal(presentation.compileOutputRetention.raw_output_retained, true);
        assert.equal(presentation.compileOutputRetention.retention_reason, 'FULL_OUTPUT_RETAINED');
        assert.match(
            formatCompileOutputRetentionLine(presentation.compileOutputRetention),
            /^CompileOutputRetention: retained=true reason=FULL_OUTPUT_RETAINED sha256=[a-f0-9]{64} lines=2 chars=\d+$/
        );
        assert.equal(presentation.selectedOutputProfile, 'compile_failure_console_generic');
    });

    it('omits clean success logs while preserving telemetry and retention hashes', () => {
        const presentation = buildCompileOutputPresentation({
            budgetTokensForOutputFilters: null,
            compileCommands: ['node -e "console.log(\'ok\')"'],
            errorCount: 0,
            exceptionMessage: null,
            failTailLines: 20,
            outputChunks: ['==== COMMAND 1/1 ====\nok\n'],
            outputFiltersPath: path.join(os.tmpdir(), 'missing-output-filters.json'),
            outputLines: ['ok'],
            selectedCommandProfile: null,
            warningCount: 0
        });

        assert.equal(presentation.retainCompileOutput, false);
        assert.equal(presentation.compileOutputRetention.raw_output_retained, false);
        assert.equal(presentation.compileOutputRetention.retention_reason, 'SUCCESS_LOG_OMITTED');
        assert.match(
            formatCompileOutputRetentionLine(presentation.compileOutputRetention),
            /^CompileOutputRetention: retained=false reason=SUCCESS_LOG_OMITTED sha256=[a-f0-9]{64} lines=2 chars=\d+$/
        );
        assert.equal(presentation.selectedOutputProfile, 'compile_success_console');
        assert.equal(presentation.telemetrySummary.original_lines, 1);
    });

    it('surfaces timeout output through the same failed-command path', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-compile-timeout-'));
        const result = await executeCompileCommands({
            repoRoot,
            timeoutMs: 50,
            commands: ['node -e "setTimeout(() => {}, 500)"']
        });

        assert.equal(result.exitCode, EXIT_GENERAL_FAILURE);
        assert.equal(result.exceptionMessage, `Compile command #1 exited with code ${EXIT_GENERAL_FAILURE}.`);
        assert.ok(result.outputLines.some((line) => line.includes('Process timed out after 50 ms.')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
