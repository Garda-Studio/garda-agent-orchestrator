import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
    REVIEW_FINDINGS_SCHEMA_VERSION,
    validateReviewFindingsReport
} from '../../../../src/gates/review/review-findings-schema';
import { buildReviewRemediationReviewContract } from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import {
    attestReviewerInvocationForTest,
    buildNoFindingsJsonReviewReport,
    createTempRepo,
    runCliWithCapturedOutput,
    seedPromptBoundReviewFixture
} from '../../cli/commands/gates/review-result/gates-command-review-result-fixtures';

const TASK_ID = 'T-164-quoting';
const TARGET = 'tests/node/example.test.mjs';
const HASH = 'a'.repeat(64);
const EXECUTION_CONTRACT = buildReviewRemediationReviewContract({
    taskId: TASK_ID, reviewType: 'code', preflightSha256: HASH, fullReviewScope: ['src/example.ts']
});
const VALIDATION_OPTIONS = {
    expectedTaskId: TASK_ID,
    expectedReviewType: 'code',
    expectedReviewContextSha256: HASH,
    expectedTreeStateSha256: HASH,
    expectedChangedFilePaths: ['src/example.ts'],
    expectedCoverageObligationIds: ['FILE-001'],
    expectedReviewExecutionContract: EXECUTION_CONTRACT
};

function focusedReport(command: string, outcome = 'passed', diagnostics = 'The command selected two tests and both assertions passed.'): Record<string, any> {
    const evidence = [{
        location: 'src/example.ts:1',
        observation: `The changed command parser is covered by ${TARGET}.`
    }];
    return {
        schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
        task_id: TASK_ID,
        review_type: 'code',
        review_context_sha256: HASH,
        tree_state_sha256: HASH,
        validation_notes: [{
            id: 'N-001', topic: 'focused-self-validation',
            note: 'The reviewer attempted the one test file covering the changed parser.',
            command, command_outcome: outcome, diagnostics, evidence
        }],
        coverage_ledger: {
            coverage_contract_sha256: HASH,
            entries: [{ obligation_id: 'FILE-001', evidence, finding_ids: [] }]
        },
        review_execution: {
            mode: 'FULL', contract_sha256: EXECUTION_CONTRACT.contract_sha256,
            covered_delta_targets: [], inspected_prior_finding_ids: []
        },
        findings: { critical: [], high: [], medium: [], low: [] },
        residual_risks: [], reviewer_notes: []
    };
}

for (const selector of [
    '--test-name-pattern "command chain|loader"',
    "--test-name-pattern 'command chain|loader'",
    '--test-name-pattern="command chain contract"',
    "--test-name-pattern='command chain|loader'",
    '--test-name-pattern="^command (chain|loader)$"',
    '--test-name-pattern="[a-z]{1,2};chain&&loader"',
    '--test-name-pattern="command \\"chain\\"|loader"',
    String.raw`--test-name-pattern="\"chain|loader\""`,
    String.raw`--test-name-pattern "\"chain|loader\""`,
    '--test-name-pattern="command "chain'
]) {
    test(`focused command preserves quoted selector data: ${selector}`, () => {
        const result = validateReviewFindingsReport(focusedReport(`node --test ${selector} ${TARGET}`), VALIDATION_OPTIONS);
        assert.equal(result.valid, true, result.violations.join('\n'));
    });
}

for (const loader of [
    '--import tsx', '--import=tsx', '--import "tests/helpers/test loader.mjs"',
    '--require tests/helpers/preload.cjs', '-r tests/helpers/preload.cjs',
    '--loader=tests/helpers/loader.mjs', '--experimental-loader tests/helpers/loader.mjs',
    ...['--import', '--require', '--loader', '--experimental-loader'].flatMap((option) => [
        `${option} ./tests/helpers/loader.mjs`, `${option}=./tests/helpers/loader.mjs`,
        `${option} @scope/test-loader`, `${option}=@scope/test-loader`, `${option} "@scope/test-loader"`
    ]),
    '-r ./tests/helpers/preload.cjs', '-r @scope/test-loader', '-r "@scope/test-loader"'
]) {
    test(`focused Node test consumes the loader operand: ${loader}`, () => {
        const report = focusedReport(`node ${loader} --test --test-name-pattern="chain|loader" ${TARGET}`);
        const result = validateReviewFindingsReport(report, VALIDATION_OPTIONS);
        assert.equal(result.valid, true, result.violations.join('\n'));
    });
    test(`focused direct Node test consumes the loader operand: ${loader}`, () => {
        const result = validateReviewFindingsReport(focusedReport(`node ${loader} ${TARGET}`), VALIDATION_OPTIONS);
        assert.equal(result.valid, true, result.violations.join('\n'));
    });
}

for (const selector of ['--test-name-pattern "chain|loader"', '--test-name-pattern="chain|loader"']) {
    for (const runtimeOptions of [`--import tsx ${selector}`, `${selector} --import tsx`]) {
        test(`focused Node loader accepts a selector before --test: ${runtimeOptions}`, () => {
            const result = validateReviewFindingsReport(focusedReport(`node ${runtimeOptions} --test ${TARGET}`), VALIDATION_OPTIONS);
            assert.equal(result.valid, true, result.violations.join('\n'));
        });
        test(`focused Node loader accepts a selector before the direct target: ${runtimeOptions}`, () => {
            const result = validateReviewFindingsReport(focusedReport(`node ${runtimeOptions} ${TARGET}`), VALIDATION_OPTIONS);
            assert.equal(result.valid, true, result.violations.join('\n'));
        });
    }
}

for (const value of ['--test', '--check', '--watch', '--eval', '--', '-m']) {
    for (const selector of [`--test-name-pattern "${value}"`, `--test-name-pattern="${value}"`]) {
        for (const loader of ['', '--import tsx ']) {
            test(`focused command preserves flag-looking selector data: ${loader}${selector}`, () => {
                const result = validateReviewFindingsReport(focusedReport(`node ${selector} ${loader}--test ${TARGET}`), VALIDATION_OPTIONS);
                assert.equal(result.valid, true, result.violations.join('\n'));
            });
        }
    }
}

test('rejects selector data replacing a required runtime test flag', () => {
    const sourceTarget = 'src/example.js';
    const commands = ['--test', '--check', 'ordinary selector'].flatMap((value) =>
        ['--test-name-pattern', '--testnamepattern', '--filter', '--grep'].flatMap((option) => [
            `node ${option} "${value}" ${sourceTarget}`,
            `node ${option}="${value}" ${sourceTarget}`,
            `node ${option} "${value}" --import tsx ${sourceTarget}`,
            `node ${option}="${value}" --import tsx ${sourceTarget}`
        ]));
    const results = commands.map((command) => {
        const report = focusedReport(command);
        report.validation_notes[0].evidence[0].observation = `The changed command parser is covered by ${sourceTarget}.`;
        return validateReviewFindingsReport(report, VALIDATION_OPTIONS);
    });
    assert.deepEqual(results.map(({ valid }) => valid), commands.map(() => false));
    assert.ok(results.every(({ violations }) => violations.some((entry) => /focused test or validation command|outside a focused Node test/u.test(entry))),
        results.flatMap(({ violations }) => violations).join('\n'));
});

test('rejects Node modifiers that lack a real validation mode', () => {
    const sourceTarget = 'src/example.js';
    const commands = [`node --test-only ${sourceTarget}`, `node --test-only --test-name-pattern="selector" ${sourceTarget}`,
        `node -m pytest ${sourceTarget}`];
    const results = commands.map((command) => {
        const report = focusedReport(command);
        report.validation_notes[0].evidence[0].observation = `The changed command parser is covered by ${sourceTarget}.`;
        return validateReviewFindingsReport(report, VALIDATION_OPTIONS);
    });
    assert.deepEqual(results.map(({ valid }) => valid), commands.map(() => false));
    assert.ok(results.every(({ violations }) => violations.some((entry) => /focused test or validation command/u.test(entry))),
        results.flatMap(({ violations }) => violations).join('\n'));
});

test('Node runtime authority retains real test and syntax-check modes', () => {
    const sourceTarget = 'src/example.js';
    const commands = [`node --test ${sourceTarget}`, `node --test-only --test ${sourceTarget}`, `node --check ${sourceTarget}`];
    const results = commands.map((command) => {
        const report = focusedReport(command);
        report.validation_notes[0].evidence[0].observation = `The changed command parser is covered by ${sourceTarget}.`;
        return validateReviewFindingsReport(report, VALIDATION_OPTIONS);
    });
    assert.deepEqual(results.map(({ valid }) => valid), commands.map(() => true),
        results.flatMap(({ violations }) => violations).join('\n'));
    const pythonResult = validateReviewFindingsReport(focusedReport(`python -m pytest ${TARGET}`), VALIDATION_OPTIONS);
    assert.equal(pythonResult.valid, true, pythonResult.violations.join('\n'));
});

test('rejects real unsafe flags after consumed selector data', () => {
    const commands = ['-m', '--grep', '--test-name-pattern'].flatMap((value) => [
        '--inspect', '--watch', '--eval', '--fix', '--test-reporter-destination=output.log'
    ].map((option) => `node --test --test-name-pattern "${value}" ${option} ${TARGET}`));
    const results = commands.map((command) => validateReviewFindingsReport(focusedReport(command), VALIDATION_OPTIONS));
    assert.deepEqual(results.map(({ valid }) => valid), commands.map(() => false));
    assert.ok(results.every(({ violations }) => violations.some((entry) => /interactive|inline interpreter|mutate source|write output/u.test(entry))),
        results.flatMap(({ violations }) => violations).join('\n'));
});

test('rejects a test-looking argument after a different runtime script', () => {
    const commands = [`node -- --test ${TARGET}`, `node --import tsx -- --test ${TARGET}`];
    const results = commands.map((command) => validateReviewFindingsReport(focusedReport(command), VALIDATION_OPTIONS));
    assert.deepEqual(results.map(({ valid }) => valid), commands.map(() => false));
    assert.ok(results.every(({ violations }) => violations.some((entry) => /focused test or validation command|outside a focused Node test/u.test(entry))),
        results.flatMap(({ violations }) => violations).join('\n'));
});

test('focused Node commands retain the direct test target after a real terminator', () => {
    const commands = [`node -- ${TARGET}`, `node --import tsx -- ${TARGET}`];
    const results = commands.map((command) => validateReviewFindingsReport(focusedReport(command), VALIDATION_OPTIONS));
    assert.deepEqual(results.map(({ valid }) => valid), commands.map(() => true));
});

test('rejects selector-looking arguments hiding extra targets after a real terminator', () => {
    const otherTarget = 'tests/node/other.test.mjs';
    const commands = ['', '--import tsx '].flatMap((loader) => [
        `node ${loader}--test -- --test-name-pattern ${otherTarget} ${TARGET}`,
        `node ${loader}--test -- ${TARGET} --grep ${otherTarget}`,
        `node ${loader}--test -- --test-name-pattern ${TARGET}`
    ]);
    const results = commands.map((command) => validateReviewFindingsReport(focusedReport(command), VALIDATION_OPTIONS));
    assert.deepEqual(results.map(({ valid }) => valid), commands.map(() => false));
    assert.ok(results.every(({ violations }) => violations.some((entry) => /focused test or validation command/u.test(entry))),
        results.flatMap(({ violations }) => violations).join('\n'));
});

test('focused direct terminator commands retain unavailable and prohibited F-000 attempts', () => {
    const commands = [`node -- ${TARGET}`, `node --import tsx -- ${TARGET}`];
    const reports = ['unavailable', 'prohibited'].flatMap((outcome) => commands.map((command) => {
        const report = focusedReport(command, outcome, 'The local runtime cannot access the fixture test file in this environment.');
        report.findings.medium = [{
            id: 'F-000',
            title: `[garda:evidence-only:missing-focused-validation] test=${TARGET}; action=run-and-record-focused-test`,
            description: 'The focused attempt cannot execute in the current fixture environment.',
            evidence: report.validation_notes[0].evidence,
            coverage_obligation_ids: ['FILE-001']
        }];
        report.coverage_ledger.entries[0].finding_ids = ['F-000'];
        return report;
    }));
    const results = reports.map((report) => validateReviewFindingsReport(report, VALIDATION_OPTIONS));
    assert.deepEqual(results.map(({ valid }) => valid), reports.map(() => true),
        results.flatMap(({ violations }) => violations).join('\n'));
    assert.deepEqual(results.map(({ report }) => report?.validation_notes[0].command), reports.map((report) => report.validation_notes[0].command));
    assert.deepEqual(results.map(({ report }) => report?.validation_notes[0].command_outcome), reports.map((report) => report.validation_notes[0].command_outcome));
    assert.deepEqual(results.map(({ report }) => report?.validation_notes[0].diagnostics), reports.map((report) => report.validation_notes[0].diagnostics));
});

test('focused selectors retain package forwarding and post-target runner options', () => {
    const commands = [`npm test -- --grep "chain|loader" ${TARGET}`, `pytest ${TARGET} -k "chain|loader"`];
    const results = commands.map((command) => validateReviewFindingsReport(focusedReport(command), VALIDATION_OPTIONS));
    assert.deepEqual(results.map(({ valid }) => valid), commands.map(() => true),
        results.flatMap(({ violations }) => violations).join('\n'));
});

for (const suffix of [
    ' | node tools/check.js', ' || node tools/check.js', ' && node tools/check.js',
    '; node tools/check.js', '\nnode tools/check.js', ' > result.log', ' &'
]) {
    test(`focused command rejects a real unquoted operator: ${JSON.stringify(suffix)}`, () => {
        const report = focusedReport(`node --test --test-name-pattern="chain|loader" ${TARGET}${suffix}`);
        const result = validateReviewFindingsReport(report, VALIDATION_OPTIONS);
        assert.equal(result.valid, false);
        assert.ok(result.violations.some((entry) => /chain or pipe|mutate source|redirection|background/u.test(entry)), result.violations.join('\n'));
    });
}

for (const command of [
    `node --test --test-name-pattern="chain|loader ${TARGET}`,
    `node --test --test-name-pattern="$(touch marker)" ${TARGET}`,
    `node --test --test-name-pattern="$TEST_TARGET" ${TARGET}`,
    `node --test --test-name-pattern="chain|loader" --watch ${TARGET}`,
    `node --test --test-reporter-destination=result.log ${TARGET}`,
    `node --import --test ${TARGET}`,
    `node --test ${TARGET} --import`,
    `node --import= --test ${TARGET}`,
    `node --import https://example.test/loader.mjs --test ${TARGET}`,
    `node --import ../loader.mjs --test ${TARGET}`,
    `node --import=../loader.mjs --test ${TARGET}`,
    `node --import=./../loader.mjs --test ${TARGET}`,
    `node --import @scope/../loader --test ${TARGET}`,
    `node --import /tmp/loader.mjs --test ${TARGET}`,
    `node --import tsx --test`,
    `node --import tsx -- --test ${TARGET}`,
    `node --check --require src/preload.js src/example.js`,
    `pytest --import tsx ${TARGET}`,
    `node --test --unknown-option ${TARGET}`,
    `node --test ${TARGET} tests/node/other.test.mjs`
]) {
    test(`focused command retains safety rejection: ${command}`, () => {
        const result = validateReviewFindingsReport(focusedReport(command), VALIDATION_OPTIONS);
        assert.equal(result.valid, false, command);
    });
}

test('rejects focused loader operands replacing the required test target', () => {
    const result = validateReviewFindingsReport(focusedReport(`node --import ${TARGET} --test`), VALIDATION_OPTIONS);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('must execute a focused test or validation command')));
});

test('rejects response-file arguments outside contextual Node loader operands', () => {
    const commands = [
        `node --import @response-file --test ${TARGET}`,
        `node --import @scope/test-loader --test ${TARGET} @scope/other`,
        `node --import @scope/test-loader --test --test-name-pattern @scope/other ${TARGET}`,
        `node --test --test-name-pattern @scope/test-loader ${TARGET}`,
        `pytest --import @scope/test-loader ${TARGET}`
    ];
    const results = commands.map((command) => validateReviewFindingsReport(focusedReport(command), VALIDATION_OPTIONS));
    assert.deepEqual(results.map(({ valid }) => valid), commands.map(() => false));
    assert.ok(results.every(({ violations }) => violations.some((entry) => entry.includes('response-file expansion'))),
        results.flatMap(({ violations }) => violations).join('\n'));
});

test('scoped loader context preserves quoted runtime and argument positions', () => {
    for (const command of [
        `"node" --import @scope/test-loader --test ${TARGET}`,
        `n"od"e --im"port" @scope/test-loader --test ${TARGET}`,
        `node --test --test-name-pattern="two word selector" --import @scope/test-loader ${TARGET}`,
        `node --test --test-name-pattern "two word selector" --import @scope/test-loader ${TARGET}`
    ]) {
        const result = validateReviewFindingsReport(focusedReport(command), VALIDATION_OPTIONS);
        assert.equal(result.valid, true, result.violations.join('\n'));
    }
});

test('focused reports retain foreign task context and tree rejection', () => {
    const report = focusedReport(`node --test --test-name-pattern="chain|loader" ${TARGET}`);
    report.task_id = 'T-164-foreign';
    report.review_context_sha256 = 'b'.repeat(64);
    report.tree_state_sha256 = 'b'.repeat(64);
    const result = validateReviewFindingsReport(report, VALIDATION_OPTIONS);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('does not match expected task')));
    assert.ok(result.violations.some((entry) => entry.includes('does not match the current review context')));
    assert.ok(result.violations.some((entry) => entry.includes('does not match the current review tree state')));
});

test('focused quoted Node command executes and preserves unavailable loader diagnostics', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-quoted-node-'));
    try {
        fs.mkdirSync(path.join(repoRoot, 'tests/node'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'src'));
        fs.writeFileSync(path.join(repoRoot, 'src/example.ts'), 'export {};\n');
        fs.writeFileSync(path.join(repoRoot, 'src/preload.mjs'), 'export {};\n');
        fs.writeFileSync(path.join(repoRoot, TARGET), [
            "import test from 'node:test';",
            "test('command chain contract', () => {});",
            "test('loader contract', () => {});",
            "test('--check', () => {});"
        ].join('\n'));
        const command = `node --test --test-name-pattern="command chain|loader" ${TARGET}`;
        const execution = spawnSync(process.execPath, ['--test', '--test-name-pattern=command chain|loader', TARGET], {
            cwd: repoRoot, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined }
        });
        assert.equal(execution.status, 0, execution.stderr);
        const report = focusedReport(command, 'passed', execution.stdout);
        const result = validateReviewFindingsReport(report, { ...VALIDATION_OPTIONS, repoRoot });
        assert.equal(result.valid, true, result.violations.join('\n'));

        const flagSelector = spawnSync(process.execPath, ['--test-name-pattern=--check', '--import', './src/preload.mjs', '--test', TARGET], {
            cwd: repoRoot, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined }
        });
        assert.equal(flagSelector.status, 0, flagSelector.stderr);
        assert.match(flagSelector.stdout, /(?:# )?pass 1\b/u);
        const flagReport = focusedReport(`node --test-name-pattern="--check" --import ./src/preload.mjs --test ${TARGET}`, 'passed', flagSelector.stdout);
        const flagResult = validateReviewFindingsReport(flagReport, { ...VALIDATION_OPTIONS, repoRoot });
        assert.equal(flagResult.valid, true, flagResult.violations.join('\n'));

        const unavailable = spawnSync(process.execPath, ['--import', '@garda-uninstalled/test-loader', '--test', '--test-name-pattern="chain|loader"', TARGET], {
            cwd: repoRoot, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined }
        });
        assert.notEqual(unavailable.status, 0);
        const unavailableDiagnostics = unavailable.stdout + unavailable.stderr;
        assert.match(unavailableDiagnostics, /ERR_MODULE_NOT_FOUND/u);
        const attempted = focusedReport(String.raw`node --import @garda-uninstalled/test-loader --test --test-name-pattern="\"chain|loader\"" ${TARGET}`, 'unavailable', unavailableDiagnostics);
        attempted.findings.medium = [{
            id: 'F-000',
            title: `[garda:evidence-only:missing-focused-validation] test=${TARGET}; action=run-and-record-focused-test`,
            description: 'The attempted local loader is absent from the fixture environment.',
            evidence: attempted.validation_notes[0].evidence,
            coverage_obligation_ids: ['FILE-001']
        }];
        attempted.coverage_ledger.entries[0].finding_ids = ['F-000'];
        const missingResult = validateReviewFindingsReport(attempted, { ...VALIDATION_OPTIONS, repoRoot });
        assert.equal(missingResult.valid, true, missingResult.violations.join('\n'));
        assert.equal(missingResult.report?.validation_notes[0].command_outcome, 'unavailable');
        assert.equal(missingResult.report?.validation_notes[0].diagnostics, unavailableDiagnostics.trim());
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('failed focused loader checks retain linked finding diagnostics', () => {
    const diagnostics = 'The command-chain assertion failed because the parser split one quoted regex into two targets.';
    const report = focusedReport(String.raw`node --import tsx --test --test-name-pattern="\"chain|loader\"" ${TARGET}`, 'failed', diagnostics);
    report.findings.medium = [{
        id: 'F-001', title: 'Quoted selector split', description: diagnostics,
        evidence: report.validation_notes[0].evidence, coverage_obligation_ids: ['FILE-001']
    }];
    report.validation_notes[0].finding_ids = ['F-001'];
    report.coverage_ledger.entries[0].finding_ids = ['F-001'];
    const result = validateReviewFindingsReport(report, VALIDATION_OPTIONS);
    assert.equal(result.valid, true, result.violations.join('\n'));
    assert.equal(result.report?.validation_notes[0].diagnostics, diagnostics);
    assert.equal(result.report?.validation_notes[0].command_outcome, 'failed');
});

test('native review-result ingestion accepts quoted regex data and rejects a real pipeline', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-164-native-quoting';
    try {
        fs.mkdirSync(path.join(repoRoot, 'tests/node'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, TARGET), String.raw`import test from 'node:test';
test('"command chain"', () => {});
test('"loader"', () => {});
`);
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot, taskId, reviewType: 'code', reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const execution = spawnSync(process.execPath, ['--test', '--test-name-pattern="command chain|loader"', TARGET], {
            cwd: repoRoot, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined }
        });
        assert.equal(execution.status, 0, execution.stderr);
        assert.match(execution.stdout, /\bpass 2\b/u);
        const command = String.raw`node --test --test-name-pattern="\"command chain|loader\"" ${TARGET}`;
        const report = buildNoFindingsJsonReviewReport(fixture.reviewContextPath, taskId);
        report.validation_notes = [{
            id: 'N-001', topic: 'focused-self-validation',
            note: 'The reviewer ran the single regression file for the changed app parser.',
            command: `${command} | node tools/check.js`, command_outcome: 'passed', diagnostics: execution.stdout,
            evidence: [{ location: 'src/app.ts:1', observation: `The changed app parser is covered by ${TARGET}.` }]
        }];
        const outputPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/tmp/reviews', taskId, 'code/review-output.md');
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const cliArguments = [
            'gate', 'record-review-result', '--task-id', taskId, '--review-type', 'code',
            '--preflight-path', fixture.preflightPath, '--review-output-path', outputPath,
            '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ];
        const rejectedText = JSON.stringify(report);
        fs.writeFileSync(outputPath, rejectedText);
        const rejected = await runCliWithCapturedOutput(cliArguments, { cwd: repoRoot });
        assert.notEqual(rejected.exitCode, 0);
        assert.match(rejected.errors.join('\n'), /chain or pipe/u);
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
        assert.equal(fs.readFileSync(outputPath, 'utf8'), rejectedText);

        (report.validation_notes as Array<Record<string, unknown>>)[0].command = command;
        fs.writeFileSync(outputPath, JSON.stringify(report));
        const accepted = await runCliWithCapturedOutput(cliArguments, { cwd: repoRoot });
        assert.equal(accepted.exitCode, 0, accepted.errors.join('\n'));
        const canonical = fs.readFileSync(path.join(fixture.reviewsRoot, `${taskId}-code-review-output.md`), 'utf8');
        assert.equal(JSON.parse(canonical).validation_notes[0].command, command);
        assert.equal(JSON.parse(canonical).validation_notes[0].diagnostics, execution.stdout);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
