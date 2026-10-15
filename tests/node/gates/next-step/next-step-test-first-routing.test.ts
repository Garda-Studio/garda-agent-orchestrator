import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runIntermediateCommandCommand } from '../../../../src/cli/commands/gates';
import { hasReportedFailedTestCase, readReportedTestCases } from '../../../../src/cli/commands/gate-flows/command-run/intermediate-command-scope';
import { buildTestFirstExpectedFailureRoute } from '../../../../src/gates/next-step/next-step-test-first-routing';
import { resolveValidationDecisionRoute } from '../../../../src/gates/next-step/next-step-validation-routes';
import {
    getChangedTestPathsTargetedByCommandTokens,
    isFocusedIntermediateCommand
} from '../../../../src/gates/shared/focused-intermediate-command-grammar';
import { hasTestFirstExpectedRedDeclaration } from '../../../../src/gates/test-first/test-first-declaration';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { runClassifyChangeCommand } from '../../../../src/cli/commands/gates';
import { executeValidationRecipe } from '../../../../src/gates/project-validation/execution';
import { evaluateValidationAttempt } from '../../../../src/gates/project-validation/result-evaluation';
import { initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode, runHandshakeForTask,
    runShellSmokeForTask, createTempRepo as createRecipeTempRepo, seedInitAnswers as seedRecipeInit,
    seedTaskQueue as seedRecipeTask } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';
import {
    createTempRepo,
    getOrchestratorRoot,
    readTaskTimelineEvents,
    seedInitAnswers,
    seedTaskQueue
} from '../../cli/commands/gate-test-helpers';

const TASK_ID = 'T-TEST-FIRST';
const TEST_PATH = 'tests/node/gates/expected-red.test.ts';
const READINESS_FIXTURE_PATH = 'tests/node/gates/readiness.fixture';
const FORCED_RED_PATH = 'garda-agent-orchestrator/runtime/tmp/forced-red';
let tempRoots: string[] = [];

interface Fixture {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    preflightPath: string;
    preflight: Record<string, unknown>;
    taskEntry: {
        taskId: string;
        status: string;
        area: string;
        title: string;
        profile: string;
        notes: string;
    };
}

function buildFixture(options: {
    declared?: boolean;
    scopeCategory?: string;
    changedFiles?: string[];
} = {}): Fixture {
    const repoRoot = createTempRepo();
    tempRoots.push(repoRoot);
    seedTaskQueue(repoRoot, TASK_ID);
    seedInitAnswers(repoRoot);
    const declared = options.declared !== false;
    const notes = declared ? 'Test-first: expected-red.' : 'Ordinary test-only task.';
    const taskPath = path.join(repoRoot, 'TASK.md');
    fs.writeFileSync(
        taskPath,
        fs.readFileSync(taskPath, 'utf8').replace('| fixture |', `| ${notes} |`),
        'utf8'
    );
    const testPath = path.join(repoRoot, TEST_PATH);
    const wrapperPath = path.join(repoRoot, 'scripts', 'node-foundation', 'build-scripts.cjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(testPath, 'export {};\n', 'utf8');
    fs.writeFileSync(wrapperPath, 'process.exitCode = 1;\n', 'utf8');
    const reviewsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'reviews');
    const eventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
    const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
    const preflight: Record<string, unknown> = {
        task_id: TASK_ID,
        scope_category: options.scopeCategory || 'test-only',
        changed_files: options.changedFiles || [TEST_PATH],
        metrics: {
            scope_content_sha256: 'a'.repeat(64)
        }
    };
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.writeFileSync(preflightPath, `${JSON.stringify(preflight, null, 2)}\n`, 'utf8');
    return {
        repoRoot,
        reviewsRoot,
        eventsRoot,
        preflightPath,
        preflight,
        taskEntry: {
            taskId: TASK_ID,
            status: 'IN_PROGRESS',
            area: 'workflow/test-first',
            title: 'Add behavior test-first',
            profile: 'balanced',
            notes
        }
    };
}

function resolveRoute(fixture: Fixture) {
    return buildTestFirstExpectedFailureRoute({
        ...fixture,
        taskId: TASK_ID,
        preflightCommandPath: `garda-agent-orchestrator/runtime/reviews/${TASK_ID}-preflight.json`,
        cliPrefix: 'node bin/garda.js',
        workspaceReady: true,
        currentChangedFiles: fixture.preflight.changed_files as string[]
    });
}

function buildRecipeFixture(mode = 'failed', testPath = 'specifications/case', withRecipe = true,
    fixtureReadiness = false, nestedReport = false): Fixture {
    const repoRoot = createRecipeTempRepo(); tempRoots.push(repoRoot);
    const bundle = getOrchestratorRoot(repoRoot);
    fs.mkdirSync(path.join(bundle, 'live/config'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'live/config/workflow-config.json'), JSON.stringify(buildDefaultWorkflowConfig()));
    fs.copyFileSync(path.join(process.cwd(), 'template/config/profiles.json'), path.join(bundle, 'live/config/profiles.json'));
    fs.writeFileSync(path.join(bundle, 'live/config/paths.json'), JSON.stringify({ triggers: { test: [withRecipe ? '(^|/)specifications/' : `(^|/)${path.dirname(testPath).replace(/\\/g, '/')}/`] } }));
    fs.mkdirSync(path.dirname(path.join(repoRoot, testPath)), {recursive: true});
    fs.writeFileSync(path.join(repoRoot, testPath), 'declared test');
    fs.writeFileSync(path.join(repoRoot, 'driver'), 'process.stdout.write(process.argv[2]==="opaque"?"opaque":"TAP version 13\\n"+(process.argv[2]==="failed"?"not ok":"ok")+" 1 - declared case\\n1..1\\n");process.exitCode=process.argv[2]==="failed"?7:0;');
    if (!withRecipe) {
        fs.writeFileSync(path.join(repoRoot, 'assertless-checker'), 'require("node:fs").readFileSync(process.argv[2],"utf8");process.exitCode=1;');
        fs.writeFileSync(path.join(repoRoot, 'opaque-checker'), 'const source=require("node:fs").readFileSync(process.argv.at(-1),"utf8");let failed=false;try{require("node:assert/strict").equal(source.trim(),"ready");}catch(error){failed=true;process.stderr.write(error.stack+"\\n");}process.stdout.write("TAP version 13\\n"+(failed?"not ok":"ok")+" 1 - source readiness\\n1..1\\n");process.exitCode=failed?7:0;');
        const wrapper = path.join(repoRoot, 'scripts/node-foundation/build-scripts.cjs');
        fs.mkdirSync(path.dirname(wrapper), {recursive:true});
        fs.writeFileSync(wrapper, 'require("../../opaque-checker");');
        if (fixtureReadiness) {
            fs.writeFileSync(path.join(repoRoot, READINESS_FIXTURE_PATH), 'blocked');
            fs.writeFileSync(path.join(repoRoot, 'opaque-checker'), [
                'const fs=require("node:fs"),assert=require("node:assert/strict");',
                'fs.readFileSync(process.argv.at(-1),"utf8");',
                `const reportMode=fs.existsSync(${JSON.stringify(FORCED_RED_PATH)})?fs.readFileSync(${JSON.stringify(FORCED_RED_PATH)},"utf8"):"normal";`,
                `let failed=false;try{if(reportMode!=="skip"){assert.equal(fs.readFileSync(${JSON.stringify(READINESS_FIXTURE_PATH)},"utf8"),"ready");assert.equal(["normal","replace"].includes(reportMode),true);}}`,
                'catch(error){failed=true;process.stderr.write(error.stack+"\\n");}',
                nestedReport
                    ? 'process.stdout.write("TAP version 13\\n# Subtest: suite\\n    "+(failed?"not ok":"ok")+" 1 - "+(reportMode==="replace"?"replacement case":"source readiness")+(reportMode==="skip"?" # SKIP fixture disabled":"")+"\\n    1..1\\n"+(failed?"not ok":"ok")+" 1 - suite\\n1..1\\n");'
                    : 'process.stdout.write("TAP version 13\\n"+(failed?"not ok":"ok")+" 1 - source readiness\\n1..1\\n");',
                'process.exitCode=failed?7:0;'
            ].join('\n'));
        }
    }
    fs.writeFileSync(path.join(repoRoot, 'recipes.json'), JSON.stringify({ schema_version: 1, recipes: [{ id: 'declared',
        purpose: 'test', executable: process.execPath, argv: ['driver', mode, { target: 'case' }], cwd: '.',
        inputs: [{ path: 'src/app.ts', role: 'source' }, { path: testPath, role: 'test' }, { path: 'driver', role: 'helper' }],
        targets: [{ id: 'case', source: testPath, selector: 'declared case' }], environment: {}, timeout_ms: 5000,
        max_attempts: 2, max_output_bytes: 1024, max_input_bytes: 65536, required_capabilities: [], result_format: 'tap' }] }));
    seedRecipeInit(repoRoot); seedRecipeTask(repoRoot, TASK_ID, 'TODO', 'default', 'Test-first: expected-red.', 'Declared recipe expected red');
    initializeGitRepo(repoRoot);
    if (withRecipe) handleWorkflow(['set', '--target-root', repoRoot, '--project-validation-contract', 'recipes.json', '--operator-confirmed', 'yes',
        '--operator-confirmed-at-utc', new Date().toISOString()], { name: 'garda-agent-orchestrator', version: '1.0.0' });
    runEnterTaskMode({ repoRoot, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Expected-red declared recipe', provider: 'Codex' });
    loadTaskEntryRulePack(repoRoot, TASK_ID); runHandshakeForTask(repoRoot, TASK_ID); runShellSmokeForTask(repoRoot, TASK_ID);
    fs.appendFileSync(path.join(repoRoot, testPath), '\naffected test\n');
    const preflightPath = path.join(bundle, `runtime/reviews/${TASK_ID}-preflight.json`);
    runClassifyChangeCommand({ repoRoot, taskId: TASK_ID, taskIntent: 'Expected-red declared recipe',
        outputPath: preflightPath, changedFiles: [testPath], emitMetrics: false });
    return { repoRoot, reviewsRoot: path.join(bundle, 'runtime/reviews'), eventsRoot: path.join(bundle, 'runtime/task-events'),
        preflightPath, preflight: JSON.parse(fs.readFileSync(preflightPath, 'utf8')),
        taskEntry: { taskId: TASK_ID, status: 'IN_PROGRESS', area: 'workflow/test-first', title: 'Declared recipe expected red',
            profile: 'balanced', notes: 'Test-first: expected-red.' } };
}

afterEach(() => {
    for (const repoRoot of tempRoots.splice(0)) {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

describe('next-step test-first expected-red routing', () => {
    it('rejects TAP bailout records after the complete failed-case prefix', () => {
        const result = 'not ok 1 - source readiness';
        assert.equal(hasReportedFailedTestCase(`TAP version 13\n${result}\n1..1\n`), true);
        assert.equal(hasReportedFailedTestCase(`TAP version 13\n${result}\n1..1\nAssertionError: source is not ready\n    at checker\n`), true);
        for (const report of [`${result}\n1..1`, `1..1\n${result}`]) {
            assert.equal(hasReportedFailedTestCase(`TAP version 13\n${report}\nBail out! runner aborted\n`), false);
        }
        for (const outcome of ['not ok', 'ok']) {
            assert.equal(readReportedTestCases(`TAP version 13\n${outcome} 1 - case\n  ---\nBail out! aborted\n  ...\n1..1\n`), null);
            assert.equal(readReportedTestCases(`TAP version 13\n    ${outcome} 1 - child\n  ---\n    Bail out! aborted\n  ...\n    1..1\n${outcome} 1 - suite\n1..1\n`), null);
        }
    });

    it('preserves nested report identities and plans without treating YAML diagnostics as cases', () => {
        const siblings = 'TAP version 13\n    ok 1 - same child\n    1..1\nok 1 - first\n    ok 1 - same child\n    1..1\nok 2 - second\n1..2\n';
        const cases = readReportedTestCases(siblings)!;
        assert.equal(cases.length, 4);
        assert.equal(new Set(cases.map(item => item.id)).size, 4);
        assert.equal(readReportedTestCases('TAP version 13\n        ok 1 - leaf\n        1..1\n    ok 1 - inner\n    1..1\nok 1 - outer\n1..1\n')?.length, 3);
        assert.equal(readReportedTestCases(siblings.replace('    1..1', '    1..2')), null);
        assert.equal(readReportedTestCases(siblings.replace('    1..1', '    1..1\n    Bail out! aborted')), null);
        assert.equal(hasReportedFailedTestCase('TAP version 13\n    not ok 1 - child\n      ---\n        not ok 1 - diagnostic text\n      ...\n    1..1\nnot ok 1 - suite\n1..1\n'), true);
    });
    it('uses the authenticated explicit test role for expected red outside conventional source layouts', async () => {
        const fixture = buildRecipeFixture('failed', 'modules/safety/checkcase.custom');
        assert.equal(fixture.preflight.scope_category, 'test-only');
        const pending = resolveRoute(fixture);
        assert.equal(pending?.nextGate, 'test-first-expected-failure');
        assert.match(pending?.commands[0]?.command || '', /--recipe-id ["']declared["']/u);
        const attempt = await executeValidationRecipe({repoRoot: fixture.repoRoot, taskId: TASK_ID, recipeId: 'declared'});
        const result = await evaluateValidationAttempt({repoRoot: fixture.repoRoot, taskId: TASK_ID, attemptId: attempt.attempt_id, expectedFailure: true});
        assert.equal(result.status, 'EXPECTED_FAILURE');
        assert.equal(resolveRoute(fixture)?.nextGate, 'implementation');
    });

    it('accepts actual current native expected-red command facts without a known runner grammar and rejects modified output', async () => {
        const testPath = 'modules/safety/checkcase.custom';
        const fixture = buildRecipeFixture('failed', testPath, false);
        const command = `"${process.execPath}" opaque-checker "${testPath}"`;
        const run = await runIntermediateCommandCommand({repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command, preflightPath: fixture.preflightPath, expectFailure: true});
        assert.equal(run.exitCode, 0);
        const route = resolveRoute(fixture);
        assert.equal(route?.nextGate, 'implementation');
        const event = readTaskTimelineEvents(fixture.repoRoot, TASK_ID)
            .find(item => item.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED');
        assert.ok(event);
        fs.appendFileSync(String((event.details as Record<string, unknown>).output_artifact_path), 'modified output');
        assert.equal(resolveRoute(fixture)?.nextGate, 'test-first-expected-failure');
    });
    it('continues unchanged test-only RED to current GREEN after fixture implementation and rejects tampered proof', async () => {
        const fixture = buildRecipeFixture('failed', TEST_PATH, false, true);
        const command = `"${process.execPath}" opaque-checker "${TEST_PATH}"`;
        const red = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command, preflightPath: fixture.preflightPath, expectFailure: true });
        assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
        assert.equal(resolveRoute(fixture)?.nextGate, 'implementation');
        const testedBytes = fs.readFileSync(path.join(fixture.repoRoot, TEST_PATH));
        fs.writeFileSync(path.join(fixture.repoRoot, READINESS_FIXTURE_PATH), 'ready');
        const classify = () => {
            runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
                taskIntent: 'Complete test-only fixture readiness', outputPath: fixture.preflightPath,
                changedFiles: [TEST_PATH, READINESS_FIXTURE_PATH], emitMetrics: false });
            fixture.preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
            assert.equal(fixture.preflight.scope_category, 'test-only');
        };
        classify();
        assert.equal(resolveRoute(fixture)?.nextGate, 'test-first-expected-failure', 'A current GREEN is required.');
        const green = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command, preflightPath: fixture.preflightPath });
        assert.equal(green.exitCode, 0, green.outputLines.join('\n'));
        assert.deepEqual(fs.readFileSync(path.join(fixture.repoRoot, TEST_PATH)), testedBytes);
        assert.equal(resolveRoute(fixture), null, 'Authenticated RED and current GREEN permit ordinary gates.');
        for (let index = 0; index < 8; index += 1) {
            const unrelated = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
                commandSource: 'targeted-test', command: `"${process.execPath}" opaque-checker --other-${index} "${TEST_PATH}"`, preflightPath: fixture.preflightPath });
            assert.equal(unrelated.exitCode, 0, unrelated.outputLines.join('\n'));
        }
        assert.equal(resolveRoute(fixture), null, 'Unrelated successes must not evict the latest matching GREEN.');
        const forcedRed = path.join(fixture.repoRoot, FORCED_RED_PATH);
        fs.mkdirSync(path.dirname(forcedRed), { recursive: true });
        fs.writeFileSync(forcedRed, 'external test state');
        const laterExpectedRed = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command, preflightPath: fixture.preflightPath, expectFailure: true });
        assert.equal(laterExpectedRed.exitCode, 0, laterExpectedRed.outputLines.join('\n'));
        assert.equal(resolveRoute(fixture)?.nextGate, 'implementation', 'Latest authentic RED supersedes older GREEN.');
        fs.unlinkSync(forcedRed);
        const greenAfterRed = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command, preflightPath: fixture.preflightPath });
        assert.equal(greenAfterRed.exitCode, 0);
        assert.equal(resolveRoute(fixture), null);
        fs.writeFileSync(path.join(fixture.repoRoot, READINESS_FIXTURE_PATH), 'blocked');
        classify();
        const laterFailure = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command, preflightPath: fixture.preflightPath });
        assert.notEqual(laterFailure.exitCode, 0);
        assert.equal(resolveRoute(fixture)?.nextGate, 'test-first-expected-failure');
        fs.writeFileSync(path.join(fixture.repoRoot, READINESS_FIXTURE_PATH), 'ready');
        classify();
        const restoredGreen = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command, preflightPath: fixture.preflightPath });
        assert.equal(restoredGreen.exitCode, 0);
        assert.equal(resolveRoute(fixture), null);
        const event = readTaskTimelineEvents(fixture.repoRoot, TASK_ID)
            .filter(item => item.event_type === 'INTERMEDIATE_COMMAND_RUN').at(-1)!;
        const output = String((event.details as Record<string, unknown>).output_artifact_path);
        const originalOutput = fs.readFileSync(output);
        fs.appendFileSync(output, 'changed output');
        assert.equal(resolveRoute(fixture)?.nextGate, 'test-first-expected-failure');
        fs.writeFileSync(output, originalOutput);
        fs.appendFileSync(path.join(fixture.repoRoot, TEST_PATH), '\nchanged tested source\n');
        classify();
        const changedTestGreen = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command, preflightPath: fixture.preflightPath });
        assert.equal(changedTestGreen.exitCode, 0, changedTestGreen.outputLines.join('\n'));
        assert.equal(resolveRoute(fixture)?.nextGate, 'test-first-expected-failure', 'Changed tested source needs new RED.');
    });
    it('requires authentic RED before accepting a current test-only GREEN fixture run', async () => {
        const fixture = buildRecipeFixture('failed', TEST_PATH, false, true);
        fs.writeFileSync(path.join(fixture.repoRoot, READINESS_FIXTURE_PATH), 'ready');
        runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            taskIntent: 'Complete test-only fixture readiness', outputPath: fixture.preflightPath,
            changedFiles: [TEST_PATH, READINESS_FIXTURE_PATH], emitMetrics: false });
        fixture.preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        const green = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command: `"${process.execPath}" opaque-checker "${TEST_PATH}"`,
            preflightPath: fixture.preflightPath });
        assert.equal(green.exitCode, 0, green.outputLines.join('\n'));
        assert.equal(resolveRoute(fixture)?.nextGate, 'test-first-expected-failure');
    });
    it('requires every nested RED case to pass instead of accepting skipped or replaced children', async () => {
        const fixture = buildRecipeFixture('failed', TEST_PATH, false, true, true);
        const command = `"${process.execPath}" opaque-checker "${TEST_PATH}"`;
        const red = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command, preflightPath: fixture.preflightPath, expectFailure: true });
        assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
        fs.writeFileSync(path.join(fixture.repoRoot, READINESS_FIXTURE_PATH), 'ready');
        runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            taskIntent: 'Complete nested test-only fixture readiness', outputPath: fixture.preflightPath,
            changedFiles: [TEST_PATH, READINESS_FIXTURE_PATH], emitMetrics: false });
        fixture.preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        const externalState = path.join(fixture.repoRoot, FORCED_RED_PATH);
        fs.mkdirSync(path.dirname(externalState), { recursive: true });
        for (const mode of ['skip', 'replace', 'normal']) {
            fs.writeFileSync(externalState, mode);
            const green = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
                commandSource: 'targeted-test', command, preflightPath: fixture.preflightPath });
            assert.equal(green.exitCode, 0, green.outputLines.join('\n'));
            if (mode === 'normal') assert.equal(resolveRoute(fixture), null);
            else assert.equal(resolveRoute(fixture)?.nextGate, 'test-first-expected-failure', mode);
        }
    });
    for (const failure of ['missing runner', 'assertless process'] as const) {
        it(`does not mistake ${failure} failure for a reported failed test case`, async () => {
            const fixture = buildRecipeFixture('failed', TEST_PATH, false);
            const program = failure === 'missing runner' ? 'missing-runner.cjs' : 'assertless-checker';
            const run = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
                commandSource: 'targeted-test', command: `"${process.execPath}" ${program} ${TEST_PATH}`,
                preflightPath: fixture.preflightPath, expectFailure: true });
            assert.notEqual(run.exitCode, 0, 'A failed process alone cannot establish a failed test case.');
            assert.equal(resolveRoute(fixture)?.nextGate, 'test-first-expected-failure');
        });
    }

    it('routes extensionless declared recipe targets and rejects altered expected-failure evidence', async () => {
        const fixture = buildRecipeFixture();
        assert.equal(fixture.preflight.scope_category, 'test-only');
        const before = resolveRoute(fixture);
        assert.equal(before?.commands.length, 1);
        assert.match(before?.commands[0].command || '', /--recipe-id "declared"/u);
        assert.doesNotMatch(before?.commands[0].command || '', /--command-source/u);
        const attempt = await executeValidationRecipe({ repoRoot: fixture.repoRoot, taskId: TASK_ID, recipeId: 'declared' });
        const result = await evaluateValidationAttempt({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            attemptId: attempt.attempt_id, expectedFailure: true });
        assert.equal(result.status, 'EXPECTED_FAILURE');
        assert.equal(resolveRoute(fixture)?.nextGate, 'implementation');
        fs.appendFileSync(path.join(fixture.repoRoot, result.result_path), ' ');
        assert.equal(resolveRoute(fixture)?.nextGate, 'test-first-expected-failure');
    });

    it('rejects unexpected pass opaque output and superseded expected-red recipe results', async () => {
        const routes: Array<string | undefined> = [];
        for (const mode of ['passed', 'opaque', 'failed']) {
            const fixture = buildRecipeFixture(mode);
            const attempt = await executeValidationRecipe({ repoRoot: fixture.repoRoot, taskId: TASK_ID, recipeId: 'declared' });
            const result = await evaluateValidationAttempt({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
                attemptId: attempt.attempt_id, expectedFailure: true });
            if (mode === 'failed') {
                assert.equal(result.status, 'EXPECTED_FAILURE');
                const controller = new AbortController(); controller.abort();
                const later = await executeValidationRecipe({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
                    recipeId: 'declared', signal: controller.signal });
                assert.equal(later.cancelled, true);
                const canceledResult = await evaluateValidationAttempt({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
                    attemptId: later.attempt_id, expectedFailure: true });
                assert.notEqual(canceledResult.status, 'EXPECTED_FAILURE');
            } else assert.notEqual(result.status, 'EXPECTED_FAILURE');
            routes.push(resolveRoute(fixture)?.nextGate);
        }
        assert.deepEqual(routes, ['test-first-expected-failure', 'test-first-expected-failure', 'test-first-expected-failure']);
    });

    it('rejects changed recipe identities without falling back to a guessed runner', () => {
        const fixture = buildRecipeFixture();
        fs.appendFileSync(path.join(fixture.repoRoot, 'driver'), '\n');
        const route = resolveRoute(fixture);
        assert.equal(route?.nextGate, 'test-first-expected-failure');
        assert.deepEqual(route?.commands, []);
    });
    it('requires the exact case-sensitive expected-red Notes marker', () => {
        assert.equal(hasTestFirstExpectedRedDeclaration({ notes: 'Test-first: expected-red.' }), true);
        assert.equal(hasTestFirstExpectedRedDeclaration({ notes: 'Prefix; Test-first: expected-red; suffix.' }), true);
        for (const notes of [
            'test-first: expected-red.',
            'TEST-FIRST: EXPECTED-RED.',
            'Test-first : expected-red.',
            'Test-first:  expected-red.',
            'Test-first: expected-red-extra.'
        ]) {
            assert.equal(hasTestFirstExpectedRedDeclaration({ notes }), false, notes);
        }
    });

    it('selects expected-red before compile and full-suite validation in the lifecycle route', () => {
        const evaluated: string[] = [];
        const result = resolveValidationDecisionRoute({
            lifecycleGateIds: ['compile-gate', 'full-suite-validation'],
            resolveQualityChecklistRoute: () => null,
            resolveBaselineOnlyPreImplementationRoute: () => {
                evaluated.push('baseline');
                return null;
            },
            resolveTestFirstExpectedFailureRoute: () => {
                evaluated.push('expected-red');
                return {
                    nextGate: 'test-first-expected-failure',
                    title: 'Record bounded expected-red failure.',
                    reason: 'Expected-red evidence is required before implementation.',
                    commands: []
                };
            },
            resolveCompileGateRoute: () => {
                evaluated.push('compile');
                return null;
            },
            resolveAuditedNoOpState: () => {
                evaluated.push('no-op');
                return {
                    required: false,
                    passed: false,
                    evidenceStatus: 'NOT_REQUIRED',
                    command: 'record-no-op'
                };
            },
            resolveFullSuiteValidationRoute: () => {
                evaluated.push('full-suite');
                return null;
            }
        });

        assert.equal(result?.nextGate, 'test-first-expected-failure');
        assert.deepEqual(evaluated, ['baseline', 'expected-red']);
    });

    it('requires the actual reporter-capable project command instead of guessing a runner', () => {
        const fixture = buildFixture();

        const route = resolveRoute(fixture);

        assert.equal(route?.nextGate, 'test-first-expected-failure');
        assert.deepEqual(route?.commands, []);
        assert.match(route?.reason || '', /actual project --command/u);
        assert.match(route?.reason || '', /complete TAP 13\/14 report/u);
        assert.match(route?.reason || '', /admitted recipe/u);
    });

    it('does not suggest a default Maven command whose output cannot establish expected red', () => {
        const javaTestPath = 'service/src/test/java/com/example/ExpectedBehaviorTest.java';
        const fixture = buildFixture({ changedFiles: [javaTestPath] });
        fs.mkdirSync(path.join(fixture.repoRoot, 'service', 'src', 'test', 'java', 'com', 'example'), {
            recursive: true
        });
        fs.writeFileSync(path.join(fixture.repoRoot, javaTestPath), 'class ExpectedBehaviorTest {}\n', 'utf8');
        fs.writeFileSync(path.join(fixture.repoRoot, 'pom.xml'), '<project/>\n', 'utf8');

        const route = resolveRoute(fixture);

        assert.equal(route?.nextGate, 'test-first-expected-failure');
        assert.deepEqual(route?.commands, []);
        assert.match(route?.reason || '', /complete TAP 13\/14 report/u);
        assert.match(route?.reason || '', /admitted recipe/u);
    });

    it('authenticates bounded focused targets for every supported project runner family', () => {
        const cases: Array<{ path: string; tokens: string[] }> = [
            { path: 'tests/test_auth.py', tokens: ['pytest', 'tests/test_auth.py'] },
            {
                path: 'service/src/test/java/com/example/AuthTest.java',
                tokens: ['mvn', '-q', '-Dtest=com.example.AuthTest', 'test']
            },
            {
                path: 'service/src/test/kotlin/com/example/AuthSpec.kt',
                tokens: ['gradle', 'test', '--tests', 'com.example.AuthSpec', '--console=plain']
            },
            { path: 'internal/auth/auth_test.go', tokens: ['go', 'test', './internal/auth'] },
            { path: 'tests/auth_flow.rs', tokens: ['cargo', 'test', '--test', 'auth_flow'] },
            {
                path: 'tests/AuthServiceTests.cs',
                tokens: ['dotnet', 'test', '--filter', 'FullyQualifiedName~AuthServiceTests', '--verbosity', 'quiet']
            },
            { path: 'spec/auth_service_spec.rb', tokens: ['bundle', 'exec', 'rspec', 'spec/auth_service_spec.rb'] },
            { path: 'tests/AuthServiceTest.php', tokens: ['phpunit', 'tests/AuthServiceTest.php'] }
        ];

        for (const candidate of cases) {
            assert.equal(
                isFocusedIntermediateCommand('targeted-test', candidate.tokens),
                true,
                candidate.path
            );
            assert.deepEqual(
                getChangedTestPathsTargetedByCommandTokens(candidate.tokens, [candidate.path]),
                [candidate.path],
                candidate.path
            );
        }
    });

    it('routes authenticated bounded expected-red evidence to implementation', async () => {
        const fixture = buildRecipeFixture('failed', TEST_PATH, false);
        const runResult = await runIntermediateCommandCommand({
            repoRoot: fixture.repoRoot,
            taskId: TASK_ID,
            commandSource: 'targeted-test',
            command: `node scripts/node-foundation/build-scripts.cjs test.js ${TEST_PATH}`,
            preflightPath: fixture.preflightPath,
            expectFailure: true
        });
        assert.equal(runResult.exitCode, 0);

        const route = resolveRoute(fixture);

        assert.equal(route?.nextGate, 'implementation');
        assert.deepEqual(route?.commands, []);
        assert.match(route?.reason || '', /authenticated against the exact test-only preflight/u);
    });

    it('rejects modified output evidence and asks to record expected-red again', async () => {
        const fixture = buildRecipeFixture('failed', TEST_PATH, false);
        await runIntermediateCommandCommand({
            repoRoot: fixture.repoRoot,
            taskId: TASK_ID,
            commandSource: 'targeted-test',
            command: `node scripts/node-foundation/build-scripts.cjs test.js ${TEST_PATH}`,
            preflightPath: fixture.preflightPath,
            expectFailure: true
        });
        const event = readTaskTimelineEvents(fixture.repoRoot, TASK_ID)
            .find((candidate) => candidate.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED');
        assert.ok(event);
        fs.appendFileSync(String((event.details as Record<string, unknown>).output_artifact_path), 'tampered\n', 'utf8');

        const route = resolveRoute(fixture);

        assert.equal(route?.nextGate, 'test-first-expected-failure');
        assert.deepEqual(route?.commands, []);
    });

    it('keeps undeclared and non-test-only scopes on the ordinary fail-closed path', () => {
        const undeclared = buildFixture({ declared: false });
        const mixed = buildFixture({ scopeCategory: 'mixed', changedFiles: [TEST_PATH, 'src/app.ts'] });

        assert.equal(resolveRoute(undeclared), null);
        assert.equal(resolveRoute(mixed), null);
    });

    it('does not reuse expected-red routing after the current workspace scope changes', () => {
        const fixture = buildFixture();
        const route = buildTestFirstExpectedFailureRoute({
            ...fixture,
            taskId: TASK_ID,
            preflightCommandPath: `garda-agent-orchestrator/runtime/reviews/${TASK_ID}-preflight.json`,
            cliPrefix: 'node bin/garda.js',
            workspaceReady: false,
            currentChangedFiles: [TEST_PATH, 'src/app.ts']
        });

        assert.equal(route, null);
    });
});
