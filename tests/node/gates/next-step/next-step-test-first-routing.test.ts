import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Executes native next-step effect plans before returning the actual routing decision.
import { resolveNextStep } from './next-step-test-support';
import { runRestartCoherentCycleCommand, runRecordStrictDecompositionDecisionCommand, runBuildReviewContextCommand, runCompileGateCommand, runFullSuiteValidationCommand, runLoadRulePackCommand } from '../../../../src/cli/commands/gates';
import { runIntermediateCommandCommand } from '../../../../src/cli/commands/gates';
import { buildFullSuiteValidationEvidence, getReviewContextFullSuiteValidationViolations } from '../../../../src/gates/review-context/review-context-validation-evidence';
import { hasReportedFailedTestCase, readReportedTestCases } from '../../../../src/cli/commands/gate-flows/command-run/intermediate-command-scope';
import { buildTestFirstExpectedFailureRoute } from '../../../../src/gates/next-step/next-step-test-first-routing';
import { requiredExpectedRedFiles } from '../../../../src/gates/test-first/expected-red-scope';
import { readExpectedRedExecutionEvidence } from '../../../../src/gates/test-first/expected-red-evidence';
import { resolveAuthoritativeReviewValidationObligations } from '../../../../src/gates/review-context/review-context-coverage';
import { getNativeCaseResolutionViolations } from '../../../../src/gates/review/native-case-semantics';
import { validationDigest } from '../../../../src/core/project-validation-identity';
import { fileSha256 } from '../../../../src/gates/shared/helpers';
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
import { readValidationResult } from '../../../../src/gates/project-validation/evidence';
import { buildQualityChecklistAnswersTemplate } from '../../../../src/gates/quality-checklist';
import { runQualityChecklistCommand } from '../../../../src/cli/commands/gate-flows/quality-checklist/quality-checklist-flow';
import { resolveValidationSemanticReviewLanes, type EffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';
import { getValidationTerminalViolations } from '../../../../src/gates/review/validation-terminal';
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
const READINESS_FIXTURE_PATH = 'garda-agent-orchestrator/runtime/tmp/readiness.fixture';
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

function buildRecipeFixture(mode = 'failed', testPath = 'specifications/case', options: {
    withRecipe?: boolean; fixtureReadiness?: boolean; nestedReport?: boolean;
    opaqueAssertion?: boolean; symbolic?: boolean; reviewSuite?: boolean; productionReadiness?: boolean; opaqueRecipe?: boolean;
    navigation?: boolean; productionOperand?: boolean; maxAttempts?: number; withChangelog?: boolean; extraTestPath?: string;
} = {}): Fixture {
    const { withRecipe = true, fixtureReadiness = false, nestedReport = false } = options;
    const repoRoot = createRecipeTempRepo(); tempRoots.push(repoRoot);
    const bundle = getOrchestratorRoot(repoRoot);
    fs.mkdirSync(path.join(bundle, 'live/config'), { recursive: true });
    const config = buildDefaultWorkflowConfig();
    if (options.navigation) {
        const router = path.join(repoRoot, '.agents/workflows/start-task.md');
        fs.mkdirSync(path.dirname(router), { recursive: true });
        fs.writeFileSync(router, '# Fixture task router\nFollow next-step.\n');
        fs.mkdirSync(path.join(bundle, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(bundle, 'bin/garda.js'), 'console.log("1.4.4 fixture");');
        fs.writeFileSync(path.join(bundle, 'VERSION'), '1.4.4\n');
        config.optional_quality_checks.enabled = false;
        config.compile_gate.command = `"${process.execPath}" --check src/app.ts`;
        config.full_suite_validation.enabled = true;
        config.full_suite_validation.placement = 'after_compile_before_reviews';
        config.full_suite_validation.command = `"${process.execPath}" opaque-checker "${testPath}"`;
        const skill = path.join(bundle, 'live/skills/code-review/SKILL.md');
        fs.mkdirSync(path.dirname(skill), { recursive: true });
        fs.writeFileSync(skill, '# Code review\nInspect the current change.\n');
    }
    if (options.reviewSuite) config.full_suite_validation = { ...config.full_suite_validation, enabled: true,
        placement: 'after_compile_before_reviews', command: `"${process.execPath}" opaque-checker "${testPath}"` };
    fs.writeFileSync(path.join(bundle, 'live/config/workflow-config.json'), JSON.stringify(config));
    fs.copyFileSync(path.join(process.cwd(), 'template/config/profiles.json'), path.join(bundle, 'live/config/profiles.json'));
    fs.writeFileSync(path.join(bundle, 'live/config/paths.json'), JSON.stringify({ triggers: { test: [withRecipe ? '(^|/)specifications/' : `(^|/)${path.dirname(testPath).replace(/\\/g, '/')}/`] },
        ...(options.productionOperand ? { file_roles: { 'src/app.ts': 'source' } } : {}) }));
    fs.mkdirSync(path.dirname(path.join(repoRoot, testPath)), {recursive: true});
    fs.writeFileSync(path.join(repoRoot, testPath), 'declared test');
    if (options.extraTestPath) {
        fs.mkdirSync(path.dirname(path.join(repoRoot, options.extraTestPath)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, options.extraTestPath), 'another declared test');
    }
    fs.writeFileSync(path.join(repoRoot, 'driver'), 'process.stdout.write(process.argv[2]==="opaque"?"opaque":"TAP version 13\\n"+(process.argv[2]==="failed"?"not ok":"ok")+" 1 - declared case\\n1..1\\n");process.exitCode=process.argv[2]==="failed"?7:0;');
    if (!withRecipe) {
        fs.writeFileSync(path.join(repoRoot, 'assertless-checker'), 'require("node:fs").readFileSync(process.argv[2],"utf8");process.exitCode=1;');
        fs.writeFileSync(path.join(repoRoot, 'opaque-checker'), 'const source=require("node:fs").readFileSync(process.argv.at(-1),"utf8");let failed=false;try{require("node:assert/strict").equal(source.trim(),"ready");}catch(error){failed=true;process.stderr.write(error.stack+"\\n");}process.stdout.write("TAP version 13\\n"+(failed?"not ok":"ok")+" 1 - source readiness\\n1..1\\n");process.exitCode=failed?7:0;');
        const wrapper = path.join(repoRoot, 'scripts/node-foundation/build-scripts.cjs');
        fs.mkdirSync(path.dirname(wrapper), {recursive:true});
        fs.writeFileSync(wrapper, 'require("../../opaque-checker");');
        if (fixtureReadiness) {
            // Harness readiness is runtime state; it is not another changed test source.
            fs.mkdirSync(path.dirname(path.join(repoRoot, READINESS_FIXTURE_PATH)), { recursive: true });
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
    if (!withRecipe && options.opaqueAssertion) fs.writeFileSync(path.join(repoRoot, 'opaque-checker'), [
        'const fs=require("node:fs"),assert=require("node:assert/strict");',
        `const source=fs.readFileSync(${options.symbolic ? JSON.stringify(testPath) : 'process.argv.at(-1)'},"utf8");`,
        `const actual=${options.productionReadiness ? 'fs.readFileSync("src/app.ts","utf8")' : 'source.trim()'};`,
        'let failed=false;try{assert.equal(actual,"ready");}',
        'catch(error){if(error.code!=="ERR_ASSERTION")throw error;failed=true;}',
        'process.stdout.write(JSON.stringify({case:"source readiness",outcome:failed?"ASSERTION_FAILED":"PASSED",actual,expected:"ready"})+"\\n");',
        'process.exitCode=failed?7:0;'
    ].join('\n'));
    if (options.productionReadiness) fs.writeFileSync(path.join(repoRoot, 'src/app.ts'), 'blocked');
    if (options.opaqueRecipe) fs.writeFileSync(path.join(repoRoot, 'driver'), [
        'const fs=require("node:fs"),assert=require("node:assert/strict");',
        `fs.readFileSync(${JSON.stringify(testPath)},"utf8");`,
        'let failed=false;try{assert.equal(fs.readFileSync("src/app.ts","utf8"),"ready");}',
        'catch(error){if(error.code!=="ERR_ASSERTION")throw error;failed=true;}',
        'process.stdout.write(JSON.stringify({case:process.argv.at(-1),outcome:failed?"ASSERTION_FAILED":"PASSED"})+"\\n");process.exitCode=failed?7:0;'
    ].join('\n'));
    fs.writeFileSync(path.join(repoRoot, 'recipes.json'), JSON.stringify({ schema_version: 1, recipes: [{ id: 'declared',
        purpose: 'test', executable: process.execPath, argv: ['driver', mode, { target: 'case' }], cwd: '.',
        inputs: [{ path: 'src/app.ts', role: 'source' }, { path: testPath, role: 'test' }, { path: 'driver', role: 'helper' }],
        targets: [{ id: 'case', source: testPath, selector: 'declared case' }], environment: {}, timeout_ms: 5000,
        max_attempts: options.maxAttempts ?? 2, max_output_bytes: 1024, max_input_bytes: 65536, required_capabilities: [], result_format: options.opaqueRecipe ? 'opaque' : 'tap' }] }));
    seedRecipeInit(repoRoot); seedRecipeTask(repoRoot, TASK_ID, 'TODO', 'default', 'Test-first: expected-red.', 'Declared recipe expected red');
    if (options.navigation) fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n');
    initializeGitRepo(repoRoot);
    if (withRecipe) handleWorkflow(['set', '--target-root', repoRoot, '--project-validation-contract', 'recipes.json', '--operator-confirmed', 'yes',
        '--operator-confirmed-at-utc', new Date().toISOString()], { name: 'garda-agent-orchestrator', version: '1.0.0' });
    runEnterTaskMode({ repoRoot, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Expected-red declared recipe', provider: 'Codex' });
    loadTaskEntryRulePack(repoRoot, TASK_ID); runHandshakeForTask(repoRoot, TASK_ID); runShellSmokeForTask(repoRoot, TASK_ID);
    if (options.navigation) {
        const decision = runRecordStrictDecompositionDecisionCommand({ repoRoot, taskId: TASK_ID, decision: 'atomic', taskProfile: 'balanced',
            taskSummary: 'Expected-red declared recipe',
            reason: 'The source readiness contract and its assertion form one indivisible behavior.',
            scopeRisk: 'One production source and one test; code and test review remain required.',
            expectedReviewTypes: ['code', 'test'], atomicityConstraints: ['The behavior and regression must land together.'] });
        assert.equal(decision.exitCode, 0, decision.outputLines.join('\n'));
    }
    fs.appendFileSync(path.join(repoRoot, testPath), '\naffected test\n');
    if (options.extraTestPath) fs.appendFileSync(path.join(repoRoot, options.extraTestPath), '\naffected extra test\n');
    if (options.withChangelog) fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '\n- Test-first behavior note.\n');
    const preflightPath = path.join(bundle, `runtime/reviews/${TASK_ID}-preflight.json`);
    runClassifyChangeCommand({ repoRoot, taskId: TASK_ID, taskIntent: 'Expected-red declared recipe',
        outputPath: preflightPath, changedFiles: [testPath, ...(options.withChangelog ? ['CHANGELOG.md'] : []), ...(options.extraTestPath ? [options.extraTestPath] : [])], emitMetrics: false });
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
    for (const reentry of [false, true]) it(`blocks ${reentry ? 'pre-entry' : 'changed'} retained RED through next-step and builds review after approved marker removal without reset`, async () => {
        const testPath = 'modules/safety/checkcase.custom';
        const fixture = buildRecipeFixture('failed', testPath, { withRecipe: false, opaqueAssertion: true,
            productionReadiness: true, navigation: true });
        const runOptions = { repoRoot: fixture.repoRoot, taskId: TASK_ID, commandSource: 'targeted-test',
            command: `"${process.execPath}" opaque-checker "${testPath}"`, preflightPath: fixture.preflightPath,
            selectedCases: [{ source: testPath, case_id: 'source readiness', selector: testPath }] };
        const red = await runIntermediateCommandCommand({ ...runOptions, expectFailure: true });
        assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
        fs.writeFileSync(path.join(fixture.repoRoot, 'src/app.ts'), 'ready');
        if (!reentry) fs.appendFileSync(path.join(fixture.repoRoot, testPath), '\nreview finding correction\n');
        runClassifyChangeCommand({ ...fixture, taskId: TASK_ID, taskIntent: 'Fix production readiness and review finding',
            outputPath: fixture.preflightPath, changedFiles: [testPath, 'src/app.ts'], emitMetrics: false });
        runLoadRulePackCommand({ ...fixture, taskId: TASK_ID, stage: 'POST_PREFLIGHT',
            loadedRuleFiles: ['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md'], emitMetrics: false });
        if (reentry) {
            const restart = await runRestartCoherentCycleCommand({ ...fixture, taskId: TASK_ID,
                taskIntent: 'Expected-red declared recipe', changedFiles: [testPath, 'src/app.ts'], emitMetrics: false });
            assert.equal(restart.exitCode, 0, restart.outputLines.join('\n'));
        }
        const green = await runIntermediateCommandCommand(runOptions);
        assert.equal(green.exitCode, 0, green.outputLines.join('\n'));
        const compile = await runCompileGateCommand({ ...fixture, taskId: TASK_ID, emitMetrics: false });
        assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
        const suite = await runFullSuiteValidationCommand({ ...fixture, taskId: TASK_ID });
        assert.equal(suite.exitCode, 0, suite.outputText);
        const next = () => resolveNextStep({ repoRoot: fixture.repoRoot, taskId: TASK_ID });
        const blocked = next();
        assert.equal(blocked.status, 'BLOCKED');
        assert.equal(blocked.next_gate, 'test-first-expected-red-stale', blocked.reason);
        assert.ok(blocked.reason.includes(testPath), blocked.reason);
        if (reentry) assert.match(blocked.reason, /predates task re-entry/u);
        assert.match(blocked.reason, /fresh RED for the current test bytes/u);
        assert.match(blocked.reason, /with operator approval remove/u);
        assert.ok(!blocked.commands.some(command => command.command.includes('task-reset')));
        const review = () => runBuildReviewContextCommand({ ...fixture, reviewType: 'code', depth: 2 });
        await assert.rejects(review, error => {
            assert.ok(String(error).includes(testPath), String(error));
            assert.match(String(error), /fresh RED for the current test bytes/u);
            assert.match(String(error), /with operator approval remove/u);
            return true;
        });
        const eventsBefore = readTaskTimelineEvents(fixture.repoRoot, TASK_ID);
        const taskPath = path.join(fixture.repoRoot, 'TASK.md');
        fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').replace('Test-first: expected-red.', 'Operator approved ordinary cycle.'));
        assert.equal(next().next_gate, 'build-review-context', next().reason);
        const context = await review();
        assert.ok(fs.existsSync(context.outputPath));
        const eventsAfter = readTaskTimelineEvents(fixture.repoRoot, TASK_ID);
        assert.equal(eventsAfter.filter(event => event.event_type === 'TASK_MODE_ENTERED').length,
            eventsBefore.filter(event => event.event_type === 'TASK_MODE_ENTERED').length);
        assert.equal(eventsAfter.filter(event => /RESET/u.test(String(event.event_type))).length, 0);
    });

    it('explains stale recipe RED through next-step and accepts fresh replacement RED', async () => {
        const testPath = 'specifications/case';
        const fixture = buildRecipeFixture('failed', testPath, { navigation: true, maxAttempts: 3 });
        const run = () => runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID, recipeId: 'declared', expectFailure: true });
        const publish = () => {
            const answers = buildQualityChecklistAnswersTemplate({ repoRoot: fixture.repoRoot, taskId: TASK_ID, preflightPath: fixture.preflightPath })
                .answers.map(answer => ({ ...answer, status: 'PASS', answer: 'Checked the declared source identity and retained recipe attempt.' }));
            const result = runQualityChecklistCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID, preflightPath: fixture.preflightPath,
                answersJson: JSON.stringify(answers), emitMetrics: false });
            assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
        };
        assert.equal((await run()).exitCode, 0);
        fs.appendFileSync(path.join(fixture.repoRoot, testPath), '\nreview correction');
        runClassifyChangeCommand({ ...fixture, taskId: TASK_ID, taskIntent: 'Expected-red declared recipe',
            outputPath: fixture.preflightPath, changedFiles: [testPath], emitMetrics: false });
        runLoadRulePackCommand({ ...fixture, taskId: TASK_ID, stage: 'POST_PREFLIGHT',
            loadedRuleFiles: ['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md'], emitMetrics: false });
        publish();
        const next = () => resolveNextStep({ repoRoot: fixture.repoRoot, taskId: TASK_ID });
        const blocked = next();
        assert.equal(blocked.status, 'BLOCKED');
        assert.ok(blocked.reason.includes(testPath), blocked.reason);
        assert.match(blocked.reason, /with operator approval remove/u);
        const resultEvent = readTaskTimelineEvents(fixture.repoRoot, TASK_ID)
            .filter(event => event.event_type === 'PROJECT_VALIDATION_RESULTS_EVALUATED').at(-1)!;
        const resultPath = path.resolve(fixture.repoRoot, String((resultEvent.details as Record<string, unknown>).artifact_path));
        const resultBytes = fs.readFileSync(resultPath);
        fs.unlinkSync(resultPath);
        assert.match(next().reason, /with operator approval remove/u, 'Missing retained recipe output must yield recovery, not throw.');
        fs.writeFileSync(resultPath, resultBytes);
        assert.equal((await run()).exitCode, 0);
        publish();
        assert.equal(next().next_gate, 'implementation', next().reason);
    });

    for (const symbolic of [false, true]) it(`retains opaque assertion facts for independent review with ${symbolic ? 'symbolic' : 'literal'} selection`, async () => {
        const testPath = 'modules/safety/checkcase.custom';
        const fixture = buildRecipeFixture('failed', testPath, { withRecipe: false, opaqueAssertion: true, symbolic, reviewSuite: true });
        const selector = symbolic ? 'source readiness' : testPath;
        const run = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', preflightPath: fixture.preflightPath, expectFailure: true,
            command: `"${process.execPath}" opaque-checker ${symbolic ? '--story=' : ''}"${selector}"`,
            selectedCases: [{ source: testPath, case_id: 'source readiness', selector }] });
        const event = readTaskTimelineEvents(fixture.repoRoot, TASK_ID).filter(item =>
            item.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED').at(-1)!;
        assert.ok(event, run.outputLines.join('\n'));
        const record = JSON.parse(fs.readFileSync(String((event.details as Record<string, unknown>).artifact_path), 'utf8'));
        assert.equal(record.exit_code, 7, 'The real assertion must fail before its independent interpretation.');
        assert.match(fs.readFileSync(record.output_artifact, 'utf8'), /"outcome":"ASSERTION_FAILED"/);
        assert.equal(record.status, 'PENDING_REVIEW');
        assert.equal(run.exitCode, 0, run.outputLines.join('\n'));
        assert.equal(resolveRoute(fixture)?.nextGate, 'implementation', 'Retain failure facts, then continue the existing implementation-before-review workflow.');
        const evidence = readExpectedRedExecutionEvidence({ ...fixture, taskId: TASK_ID,
            preflightSha256: fileSha256(fixture.preflightPath) });
        assert.equal(evidence?.obligations.length, 1, 'Actual retained failure must reach the existing independent case contract.');
        const binding = evidence!.obligations[0];
        assert.equal(binding.case_execution?.exit_code, 7);
        assert.equal(binding.case_execution?.expected_failure, true);
        const resolution = { binding_sha256: validationDigest(binding), execution_sha256: binding.case_execution!.record_sha256,
            output_sha256: binding.case_execution!.output_sha256, outcome: 'FAILED', failure_kind: 'ASSERTION',
            evidence_quote: '"outcome":"ASSERTION_FAILED"', reasoning: 'The retained assertion compares the selected source to the required ready value.' };
        const entries = [{ obligation_id: `VALIDATION-${binding.id.toUpperCase()}`, case_resolution: resolution }];
        assert.deepEqual(getNativeCaseResolutionViolations({ repoRoot: fixture.repoRoot,
            obligations: evidence!.obligations, entries, requireExpectedRed: true }), []);
        for (const failure_kind of ['PROCESS', 'DEPENDENCY', 'UNKNOWN']) {
            assert.ok(getNativeCaseResolutionViolations({ repoRoot: fixture.repoRoot, obligations: evidence!.obligations,
                entries: [{ ...entries[0], case_resolution: { ...resolution, failure_kind } }], requireExpectedRed: true }).length);
        }
        assert.ok(getNativeCaseResolutionViolations({ repoRoot: fixture.repoRoot,
            obligations: evidence!.obligations, entries, requirePassed: true }).length, 'RED semantics cannot close final GREEN.');
        assert.match(resolveRoute(fixture)?.reason ?? '', /pending the ordinary independent review after implementation/);
        const suiteOptions = { ...fixture, taskId: TASK_ID, reviewType: 'code',
            preflightSha256: fileSha256(fixture.preflightPath) };
        const suite = buildFullSuiteValidationEvidence(suiteOptions);
        assert.equal(suite?.required_for_review, true, 'Expected-red capture cannot waive the ordinary pre-review full-suite gate.');
        assert.equal(suite?.available, false);
        assert.ok(getReviewContextFullSuiteValidationViolations({ ...suiteOptions,
            reviewContext: { full_suite_validation: suite } }).length, 'Review preparation stays blocked until normal validation completes.');
    });
    for (const rejectedLast of [false, true]) it(`orders rejected and valid RED captures before ordinary review (${rejectedLast})`, async () => {
        const testPath = 'modules/safety/checkcase.custom';
        const fixture = buildRecipeFixture('failed', testPath,
            { withRecipe: false, opaqueAssertion: true, productionReadiness: true });
        const options = { repoRoot: fixture.repoRoot, taskId: TASK_ID, commandSource: 'targeted-test',
            preflightPath: fixture.preflightPath,
            selectedCases: [{ source: testPath, case_id: 'source readiness', selector: testPath }] };
        const rejected = () => runIntermediateCommandCommand({ ...options, expectFailure: true,
            command: `"${process.execPath}" --version "${testPath}"` });
        const command = `"${process.execPath}" opaque-checker "${testPath}"`;
        if (!rejectedLast) assert.notEqual((await rejected()).exitCode, 0);
        assert.equal((await runIntermediateCommandCommand({ ...options, command, expectFailure: true })).exitCode, 0);
        if (rejectedLast) assert.notEqual((await rejected()).exitCode, 0);
        fs.writeFileSync(path.join(fixture.repoRoot, 'src/app.ts'), 'ready');
        runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID, taskIntent: 'Fix production readiness',
            outputPath: fixture.preflightPath, changedFiles: [testPath, 'src/app.ts'], emitMetrics: false });
        fixture.preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        assert.equal((await runIntermediateCommandCommand({ ...options, command })).exitCode, 0);
        const obligations = () => resolveAuthoritativeReviewValidationObligations({ ...fixture,
            reviewType: resolveValidationSemanticReviewLanes(fixture.preflight.effective_review_snapshot as EffectiveReviewSnapshot)[0] });
        if (rejectedLast) assert.throws(obligations, /RED|execution|successful/i);
        else assert.equal(obligations()?.length, 2, 'An earlier rejected capture must not poison a later valid RED/GREEN pair.');
    });
    for (const symbolic of [false, true]) it(`keeps opaque RED and current GREEN in ordinary review after production changes (${symbolic})`, async () => {
        const testPath = 'modules/safety/checkcase.custom';
        const fixture = buildRecipeFixture('failed', testPath,
            { withRecipe: false, opaqueAssertion: true, symbolic, productionReadiness: true, productionOperand: symbolic });
        const selector = symbolic ? 'source readiness' : testPath;
        const command = `"${process.execPath}" opaque-checker ${symbolic ? '--input=src/app.ts --story=' : ''}"${selector}"`;
        const selectedCases = [{ source: testPath, case_id: 'source readiness', selector }];
        const runOptions = { repoRoot: fixture.repoRoot, taskId: TASK_ID, commandSource: 'targeted-test',
            command, preflightPath: fixture.preflightPath, selectedCases };
        const red = await runIntermediateCommandCommand({ ...runOptions, expectFailure: true });
        assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
        const sourceBefore = fs.readFileSync(path.join(fixture.repoRoot, testPath));
        fs.writeFileSync(path.join(fixture.repoRoot, 'src/app.ts'), 'ready');
        const classify = () => {
            runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
                taskIntent: 'Fix production readiness', outputPath: fixture.preflightPath,
                changedFiles: [testPath, 'src/app.ts'], emitMetrics: false });
            fixture.preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        };
        classify();
        const obligations = () => resolveAuthoritativeReviewValidationObligations({ ...fixture,
            reviewType: resolveValidationSemanticReviewLanes(fixture.preflight.effective_review_snapshot as EffectiveReviewSnapshot)[0] });
        assert.throws(obligations, error => {
            assert.match(String(error), /Run and record current passing focused tests/u);
            assert.doesNotMatch(String(error), /with operator approval remove/u);
            return true;
        }, 'Valid retained RED without GREEN must request GREEN, not replacement RED.');
        const green = await runIntermediateCommandCommand(runOptions);
        assert.equal(green.exitCode, 0, green.outputLines.join('\n'));
        const paired = obligations();
        assert.equal(paired?.length, 2, 'The existing ordinary review must receive both actual executions.');
        const historical = paired!.find(item => item.case_execution?.expected_failure)!;
        const current = paired!.find(item => !item.case_execution?.expected_failure)!;
        assert.equal(historical.case_execution?.exit_code, 7);
        assert.ok(current.case_execution!.event_task_sequence > historical.case_execution!.event_task_sequence);
        assert.deepEqual(historical.source_identity, current.source_identity);
        assert.deepEqual(fs.readFileSync(path.join(fixture.repoRoot, testPath)), sourceBefore);
        const helperPath = path.join(fixture.repoRoot, 'opaque-checker'), helperBefore = fs.readFileSync(helperPath);
        fs.appendFileSync(helperPath, '\n// changed helper\n');
        runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            taskIntent: 'Observe changed helper', outputPath: fixture.preflightPath,
            changedFiles: [testPath, 'src/app.ts', 'opaque-checker'], emitMetrics: false });
        fixture.preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        assert.equal((await runIntermediateCommandCommand(runOptions)).exitCode, 0);
        assert.throws(obligations, /RED|identity|input|source/i, 'Historical RED cannot reuse a changed helper.');
        fs.writeFileSync(helperPath, helperBefore); classify();
        assert.equal((await runIntermediateCommandCommand(runOptions)).exitCode, 0);
        assert.equal(obligations()?.length, 2);
        fs.writeFileSync(path.join(fixture.repoRoot, 'src/app.ts'), 'blocked'); classify();
        assert.notEqual((await runIntermediateCommandCommand(runOptions)).exitCode, 0);
        assert.throws(obligations, /successful|GREEN|execution/i, 'A later failed run must invalidate old GREEN.');
        assert.ok(getValidationTerminalViolations({ ...fixture, taskId: TASK_ID,
            requiredReviews: fixture.preflight.required_reviews as Record<string, unknown>, artifacts: {} })
            .some(message => /successful|GREEN|execution/i.test(message)), 'The terminal consumer must also reject the failed current case.');
        fs.writeFileSync(path.join(fixture.repoRoot, 'src/app.ts'), 'ready'); classify();
        assert.equal((await runIntermediateCommandCommand(runOptions)).exitCode, 0);
        assert.equal(obligations()?.length, 2);
        fs.appendFileSync(path.join(fixture.repoRoot, testPath), '\nchanged selected test\n'); classify();
        assert.equal((await runIntermediateCommandCommand(runOptions)).exitCode, 0);
        assert.throws(obligations, /source|RED|identity/i, 'A changed test must not reuse the old failure.');
    });
    for (const cancelled of [false, true]) it(`selects recipe RED by execution order despite delayed older evaluation (${cancelled})`, async () => {
        const testPath = 'modules/safety/checkcase.custom';
        const fixture = buildRecipeFixture('failed', testPath, { opaqueRecipe: true, productionReadiness: true, maxAttempts: 3 });
        const options = { repoRoot: fixture.repoRoot, taskId: TASK_ID, recipeId: 'declared' };
        const older = await executeValidationRecipe(options);
        const controller = new AbortController();
        if (cancelled) controller.abort();
        const newer = await executeValidationRecipe({ ...options, signal: controller.signal });
        assert.equal(newer.cancelled, cancelled);
        await evaluateValidationAttempt({ ...options, attemptId: newer.attempt_id, expectedFailure: true });
        await evaluateValidationAttempt({ ...options, attemptId: older.attempt_id, expectedFailure: true });
        assert.equal(resolveRoute(fixture)?.nextGate === 'implementation', !cancelled,
            'A delayed old RED result must not replace the latest execution in navigation.');
        fs.writeFileSync(path.join(fixture.repoRoot, 'src/app.ts'), 'ready');
        runClassifyChangeCommand({ ...options, taskIntent: 'Fix production readiness', outputPath: fixture.preflightPath,
            changedFiles: [testPath, 'src/app.ts'], emitMetrics: false });
        fixture.preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        const green = await executeValidationRecipe(options);
        await evaluateValidationAttempt({ ...options, attemptId: green.attempt_id });
        const answers = buildQualityChecklistAnswersTemplate({ ...fixture, taskId: TASK_ID }).answers
            .map(answer => ({ ...answer, status: 'PASS', answer: 'Checked actual recipe execution order and current source/output identities.' }));
        const quality = runQualityChecklistCommand({ ...fixture, taskId: TASK_ID, answersJson: JSON.stringify(answers), emitMetrics: false });
        assert.equal(quality.exitCode, 0, quality.outputLines.join('\n'));
        const obligations = () => resolveAuthoritativeReviewValidationObligations({ ...fixture, reviewType: 'code' });
        if (cancelled) assert.throws(obligations, /RED|nonzero|cancelled|execution/i);
        else assert.equal(obligations()?.find(item => item.case_execution?.expected_failure)?.attempt_id, newer.attempt_id);
    });
    it('retains opaque recipe RED and pairs unchanged targets with current GREEN in ordinary review', async () => {
        const testPath = 'modules/safety/checkcase.custom';
        const fixture = buildRecipeFixture('failed', testPath, { opaqueRecipe: true, productionReadiness: true });
        const red = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            recipeId: 'declared', expectFailure: true });
        assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
        assert.match(red.outputLines.join('\n'), /UNRESOLVED/, 'Execution capture must not fabricate assertion acceptance.');
        assert.equal(resolveRoute(fixture)?.nextGate, 'implementation');
        fs.writeFileSync(path.join(fixture.repoRoot, 'src/app.ts'), 'ready');
        runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            taskIntent: 'Fix production readiness', outputPath: fixture.preflightPath,
            changedFiles: [testPath, 'src/app.ts'], emitMetrics: false });
        fixture.preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        const attempt = await executeValidationRecipe({ repoRoot: fixture.repoRoot, taskId: TASK_ID, recipeId: 'declared' });
        const green = await evaluateValidationAttempt({ repoRoot: fixture.repoRoot, taskId: TASK_ID, attemptId: attempt.attempt_id });
        assert.equal(green.status, 'UNRESOLVED');
        const answers = buildQualityChecklistAnswersTemplate({ ...fixture, taskId: TASK_ID }).answers
            .map(answer => ({ ...answer, status: 'PASS', answer: 'Checked the actual isolated recipe execution and retained source/output identities.' }));
        const quality = runQualityChecklistCommand({ ...fixture, taskId: TASK_ID, answersJson: JSON.stringify(answers), emitMetrics: false });
        assert.equal(quality.exitCode, 0, quality.outputLines.join('\n'));
        const paired = resolveAuthoritativeReviewValidationObligations({ ...fixture, reviewType: 'code' });
        assert.equal(paired?.length, 2);
        assert.equal(paired!.filter(item => item.case_execution?.expected_failure).length, 1);
        assert.equal(paired!.filter(item => !item.case_execution?.expected_failure).length, 1);
        fs.appendFileSync(path.join(fixture.repoRoot, testPath), '\nchanged selected test\n');
        runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            taskIntent: 'Changed test needs a new failing execution', outputPath: fixture.preflightPath,
            changedFiles: [testPath, 'src/app.ts'], emitMetrics: false });
        fixture.preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        const redAttemptId = red.outputLines.find(line => line.startsWith('AttemptId: '))!.slice('AttemptId: '.length);
        assert.throws(() => readValidationResult({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            attemptId: redAttemptId, expectedRedHistory: true }), /source|RED|identity/i);
    });
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
        const fixture = buildRecipeFixture('failed', testPath, { withRecipe: false });
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
    it('continues unchanged test-only RED to current GREEN when the runtime fixture becomes ready and rejects tampered proof', async () => {
        const fixture = buildRecipeFixture('failed', TEST_PATH, { withRecipe: false, fixtureReadiness: true });
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
                changedFiles: [TEST_PATH], emitMetrics: false });
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
    it('requires RED for an unselected custom source added after historical RED before current GREEN', async () => {
        const fixture = buildRecipeFixture('failed', TEST_PATH, { withRecipe: false, fixtureReadiness: true });
        const command = `"${process.execPath}" opaque-checker "${TEST_PATH}"`;
        const red = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command, preflightPath: fixture.preflightPath, expectFailure: true });
        assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
        assert.equal(resolveRoute(fixture)?.nextGate, 'implementation');
        fs.writeFileSync(path.join(fixture.repoRoot, READINESS_FIXTURE_PATH), 'ready');
        const extraTestPath = 'tests/node/gates/extra.custom';
        fs.writeFileSync(path.join(fixture.repoRoot, extraTestPath), 'another changed test source');
        runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            taskIntent: 'Classify an additional test source after retained RED', outputPath: fixture.preflightPath,
            changedFiles: [TEST_PATH, extraTestPath], emitMetrics: false });
        fixture.preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        assert.equal(fixture.preflight.scope_category, 'test-only');
        const green = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command, preflightPath: fixture.preflightPath });
        assert.equal(green.exitCode, 0, green.outputLines.join('\n'));
        assert.equal(resolveRoute(fixture)?.nextGate, 'test-first-expected-failure',
            'Historical RED for one test cannot exempt another current non-document source.');
    });
    it('requires authentic RED before accepting a current test-only GREEN fixture run', async () => {
        const fixture = buildRecipeFixture('failed', TEST_PATH, { withRecipe: false, fixtureReadiness: true });
        fs.writeFileSync(path.join(fixture.repoRoot, READINESS_FIXTURE_PATH), 'ready');
        runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            taskIntent: 'Complete test-only fixture readiness', outputPath: fixture.preflightPath,
            changedFiles: [TEST_PATH], emitMetrics: false });
        fixture.preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        const green = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command: `"${process.execPath}" opaque-checker "${TEST_PATH}"`,
            preflightPath: fixture.preflightPath });
        assert.equal(green.exitCode, 0, green.outputLines.join('\n'));
        assert.equal(resolveRoute(fixture)?.nextGate, 'test-first-expected-failure');
    });
    it('requires every nested RED case to pass instead of accepting skipped or replaced children', async () => {
        const fixture = buildRecipeFixture('failed', TEST_PATH, { withRecipe: false, fixtureReadiness: true, nestedReport: true });
        const command = `"${process.execPath}" opaque-checker "${TEST_PATH}"`;
        const red = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command, preflightPath: fixture.preflightPath, expectFailure: true });
        assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
        fs.writeFileSync(path.join(fixture.repoRoot, READINESS_FIXTURE_PATH), 'ready');
        runClassifyChangeCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            taskIntent: 'Complete nested test-only fixture readiness', outputPath: fixture.preflightPath,
            changedFiles: [TEST_PATH], emitMetrics: false });
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
            const fixture = buildRecipeFixture('failed', TEST_PATH, { withRecipe: false });
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
        assert.match(route?.reason || '', /--selected-case.*ordinary independent review/u);
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
        assert.match(route?.reason || '', /--selected-case.*ordinary independent review/u);
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
        const fixture = buildRecipeFixture('failed', TEST_PATH, { withRecipe: false });
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
        assert.match(route?.reason || '', /exact source, selected cases and actual nonzero execution/u);
    });

    it('accepts recipe expected-red with ordinary CHANGELOG.md in the current scope', async () => {
        const fixture = buildRecipeFixture('failed', 'specifications/case', { withChangelog: true });
        assert.equal(fixture.preflight.scope_category, 'test-only');
        const pending = resolveRoute(fixture);
        assert.match(pending?.commands[0]?.command || '', /--recipe-id "declared"/u);
        const red = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            recipeId: 'declared', expectFailure: true });
        assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
        assert.equal(resolveRoute(fixture)?.nextGate, 'implementation');
    });

    it('requires RED for an extra custom test source rather than treating every unrecognized file as documentation', async () => {
        const testPath = 'specifications/first.custom';
        const fixture = buildRecipeFixture('failed', testPath, { withRecipe: false, opaqueAssertion: true,
            withChangelog: true, extraTestPath: 'specifications/extra.custom' });
        assert.equal(fixture.preflight.scope_category, 'test-only');
        const red = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', preflightPath: fixture.preflightPath, expectFailure: true,
            command: `"${process.execPath}" opaque-checker "${testPath}"`,
            selectedCases: [{ source: testPath, case_id: 'source readiness', selector: testPath }] });
        assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
        assert.equal(readExpectedRedExecutionEvidence({ ...fixture, taskId: TASK_ID,
            preflightSha256: fileSha256(fixture.preflightPath) }), null);
        assert.equal(resolveRoute(fixture)?.nextGate, 'test-first-expected-failure');
        assert.deepEqual(requiredExpectedRedFiles({ ...fixture.preflight,
            changed_files: ['CHANGELOG.md', 'docs/declared.md', 'extra.unknown', 1], declared_test_paths: ['docs/declared.md']
        }, fixture.repoRoot), ['docs/declared.md', 'extra.unknown', 1]);
    });

    it('accepts expected-red for the test source when the test-only scope also changes CHANGELOG.md', async () => {
        const testPath = 'modules/safety/checkcase.custom';
        const fixture = buildRecipeFixture('failed', testPath, { withRecipe: false, opaqueAssertion: true, withChangelog: true });
        assert.equal(fixture.preflight.scope_category, 'test-only', JSON.stringify(fixture.preflight.changed_files));
        assert.ok((fixture.preflight.changed_files as string[]).includes('CHANGELOG.md'));
        const run = await runIntermediateCommandCommand({ repoRoot: fixture.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', preflightPath: fixture.preflightPath, expectFailure: true,
            command: `"${process.execPath}" opaque-checker "${testPath}"`,
            selectedCases: [{ source: testPath, case_id: 'source readiness', selector: testPath }] });
        assert.equal(run.exitCode, 0, run.outputLines.join('\n'));

        const evidence = readExpectedRedExecutionEvidence({ ...fixture, taskId: TASK_ID,
            preflightSha256: fileSha256(fixture.preflightPath) });
        assert.equal(evidence?.obligations.length, 1, 'documentation in a test-only scope must not hide the test RED');
        assert.equal(evidence?.obligations[0].source_identity.path, testPath);
        assert.equal(resolveRoute(fixture)?.nextGate, 'implementation');
    });

    it('rejects modified output evidence and asks to record expected-red again', async () => {
        const fixture = buildRecipeFixture('failed', TEST_PATH, { withRecipe: false });
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
