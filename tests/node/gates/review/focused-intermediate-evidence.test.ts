import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { readTaskOwnedFocusedIntermediateEvidence } from '../../../../src/gates/review/focused-intermediate-evidence';
import * as intermediateEvidence from '../../../../src/gates/review/focused-intermediate-evidence';
import { runClassifyChangeCommand, runIntermediateCommandCommand } from '../../../../src/cli/commands/gates';
import { inspectReviewerFocusedValidationCommand } from '../../../../src/gates/review/review-findings-schema';
import { readNativeCaseObligations } from '../../../../src/gates/review/native-case-semantics';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode,
    runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, seedTaskQueue } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';

const TASK_ID = 'T-979-4';
const TEST_PATH = 'tests/node/gates/review/focused-intermediate-evidence.test.ts';

async function symbolicFixture(options: { bare?: boolean; bareExecutable?: string; sourceSpelling?: string } = {}) {
    const bare = options.bare === true;
    const executable = bare ? options.bareExecutable ?? 'zephyr-check' : 'node';
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, TASK_ID); seedInitAnswers(repoRoot); initializeGitRepo(repoRoot);
    const entry = runEnterTaskMode({ repoRoot, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2, taskSummary: 'Ordinary symbolic focused evidence', provider: 'Codex' });
    assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
    loadTaskEntryRulePack(repoRoot, TASK_ID); runHandshakeForTask(repoRoot, TASK_ID); runShellSmokeForTask(repoRoot, TASK_ID);
    const source = 'checks/Возврат.case', selector = 'refund-empty';
    fs.mkdirSync(path.join(repoRoot, 'checks'));
    fs.writeFileSync(path.join(repoRoot, source), "require('node:assert/strict').throws(() => { throw Error('refund empty'); }, /refund empty/);\n");
    fs.writeFileSync(path.join(repoRoot, 'checks/driver'), "require('./Возврат.case'); console.log('<case id=refund-empty>passed</case>'); if (process.argv.includes('--fail')) process.exitCode = 7;\n");
    const tools = path.join(repoRoot, 'tools');
    if (bare) {
        fs.mkdirSync(tools); fs.copyFileSync(process.execPath, path.join(tools, process.platform === 'win32' ? `${executable}.exe` : executable));
        if (process.platform !== 'win32') fs.chmodSync(path.join(tools, executable), 0o700);
    }
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime/reviews'), eventsRoot = path.join(bundleRoot, 'runtime/task-events');
    const preflightPath = path.join(reviewsRoot, 'symbolic-preflight.json');
    const classified = runClassifyChangeCommand({ repoRoot, taskId: TASK_ID, taskIntent: 'Ordinary symbolic focused evidence',
        changedFiles: [source], outputPath: preflightPath });
    assert.ok(fs.existsSync(preflightPath), classified.outputText);
    const command = `${executable} checks/driver --neoteric-option=${selector}`;
    const run = async (value = command) => {
        const originalPath = process.env.PATH;
        try {
            if (bare) process.env.PATH = `${tools}${path.delimiter}${originalPath ?? ''}`;
            return await runIntermediateCommandCommand({ repoRoot, taskId: TASK_ID,
                commandSource: 'targeted-test', command: value, preflightPath,
                selectedCases: [{ source: options.sourceSpelling ?? source, case_id: selector, selector }] });
        } finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; }
    };
    const execution = await run(); assert.equal(execution.exitCode, 0, execution.outputLines.join('\n'));
    const selected = () => readTaskOwnedFocusedIntermediateEvidence({ repoRoot, reviewsRoot, eventsRoot,
        taskId: TASK_ID, changedFiles: [source], requiredTestPath: source,
        expectedPreflightPath: preflightPath, expectedPreflightSha256: sha256(preflightPath) });
    return { repoRoot, reviewsRoot, eventsRoot, source, command, preflightPath, selected, run };
}

it('admits unfamiliar bare focused commands and arbitrary literal options from authenticated execution', async () => {
    const f = await symbolicFixture({ bare: true });
    try {
        assert.equal(inspectReviewerFocusedValidationCommand('zephyr-check checks/driver refund-empty', f.repoRoot, TASK_ID).syntax_supported, false);
        for (const command of ['zephyr-check checks/driver refund-empty',
            'zephyr-check checks/driver --neoteric-option=refund-empty',
            'zephyr-check checks/driver --neoteric-option=refund-empty --context .',
            'zephyr-check checks/driver --neoteric-option=refund-empty --context checks']) {
            const result = await f.run(command); assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
            assert.deepEqual(inspectReviewerFocusedValidationCommand(command, f.repoRoot, TASK_ID),
                { syntax_supported: true, target: f.source, violations: [] });
        }
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

it('rejects superseded symbolic focused success and modified retained source or output', async () => {
    const f = await symbolicFixture();
    try {
        assert.equal(f.selected().entries.length, 1);
        const failed = await f.run(`${f.command} --fail`); assert.notEqual(failed.exitCode, 0);
        assert.equal(f.selected().entries.length, 0);
        assert.equal(inspectReviewerFocusedValidationCommand(f.command, f.repoRoot, TASK_ID).syntax_supported, false);
        const recovered = await f.run(); assert.equal(recovered.exitCode, 0);
        const entry = f.selected().entries[0], output = fs.readFileSync(entry.output_artifact_path);
        fs.appendFileSync(entry.output_artifact_path, 'forged result');
        assert.equal(f.selected().entries.length, 0);
        fs.writeFileSync(entry.output_artifact_path, output);
        assert.equal(f.selected().entries.length, 1);
        fs.appendFileSync(path.join(f.repoRoot, f.source), 'changed source');
        assert.equal(f.selected().entries.length, 0);
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

it('projects actual symbolic focused execution from the shared source relation without runner grammar', async () => {
    const f = await symbolicFixture();
    try {
        assert.deepEqual(inspectReviewerFocusedValidationCommand(f.command, f.repoRoot, TASK_ID),
            { syntax_supported: true, target: f.source, violations: [] });
        const selected = f.selected();
        assert.equal(selected.entries.length, 1, selected.warnings.join('\n'));
        assert.deepEqual(selected.entries[0].focused_test_paths, [f.source]);
        assert.equal(selected.entries[0].selected_case_binding?.before.cases[0].selector, 'refund-empty');
        assert.ok(fs.readFileSync(selected.entries[0].output_artifact_path, 'utf8').includes('<case id=refund-empty>passed</case>'));
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});
for (const duringExecution of [false, true]) it(`rejects captured helper changes ${duringExecution ? 'during' : 'after'} native execution`, async () => {
    const f = await symbolicFixture();
    try {
        const original = f.selected().entries[0];
        const preflight = JSON.parse(fs.readFileSync(f.preflightPath, 'utf8'));
        const source = original.selected_case_binding!.before.sources.find(item => item.path === f.source)!;
        const obligations = () => readNativeCaseObligations({ repoRoot: f.repoRoot, taskId: TASK_ID,
            preflightPath: f.preflightPath, preflightSha256: sha256(f.preflightPath),
            scopeContentSha256: preflight.metrics.scope_content_sha256,
            sources: [{ source_identity: source, case_id: 'refund-empty', selector: 'refund-empty', syntax_status: 'UNRESOLVED' }] });
        assert.equal(obligations().length, 1);
        const helper = path.join(f.repoRoot, 'checks/driver');
        if (duringExecution) {
            fs.appendFileSync(helper, '\nrequire("node:fs").appendFileSync(__filename, "\\n// changed during execution\\n");');
            await f.run();
        } else fs.writeFileSync(helper, 'process.exitCode=7;process.stdout.write("dependency broken");');
        assert.equal(f.selected().entries.length, 0);
        assert.equal(inspectReviewerFocusedValidationCommand(f.command, f.repoRoot, TASK_ID).syntax_supported, false);
        assert.throws(obligations, /source|identity|successful|unavailable/i);
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

it('admits a source-bound runner whose name overlaps legacy grammar', async () => {
    const f = await symbolicFixture({ bare: true, bareExecutable: 'mvn' });
    try {
        assert.equal(f.selected().entries.length, 1);
        assert.deepEqual(inspectReviewerFocusedValidationCommand(f.command, f.repoRoot, TASK_ID),
            { syntax_supported: true, target: f.source, violations: [] });
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

function sha256(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeFixture(): { repoRoot: string; bundleRoot: string; reviewsRoot: string; eventsRoot: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-focused-evidence-'));
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
    const eventsRoot = path.join(bundleRoot, 'runtime', 'task-events');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.mkdirSync(eventsRoot, { recursive: true });
    return { repoRoot, bundleRoot, reviewsRoot, eventsRoot };
}

function nativeFixture(options: { source?: string; content?: string; baselineFiles?: Record<string, string> } = {}) {
    const repoRoot = createTempRepo();
    for (const [file, content] of Object.entries(options.baselineFiles ?? {})) {
        fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, file), content);
    }
    seedTaskQueue(repoRoot, TASK_ID); seedInitAnswers(repoRoot); initializeGitRepo(repoRoot);
    const entry = runEnterTaskMode({ repoRoot, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2, taskSummary: 'Native execution evidence', provider: 'Codex' });
    assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
    loadTaskEntryRulePack(repoRoot, TASK_ID);
    runHandshakeForTask(repoRoot, TASK_ID); runShellSmokeForTask(repoRoot, TASK_ID);
    const source = options.source ?? 'custom/source.case';
    fs.mkdirSync(path.dirname(path.join(repoRoot, source)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, source), options.content ?? 'opaque test source\n');
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime/reviews');
    const eventsRoot = path.join(bundleRoot, 'runtime/task-events');
    const preflightPath = path.join(reviewsRoot, 'preflight.json').replace(/\\/g, '/');
    const classified = runClassifyChangeCommand({ repoRoot, taskId: TASK_ID, taskIntent: 'Native execution evidence',
        changedFiles: [source], outputPath: preflightPath });
    assert.ok(fs.existsSync(preflightPath), classified.outputText);
    const scopeContentSha256 = JSON.parse(fs.readFileSync(preflightPath, 'utf8')).metrics.scope_content_sha256 as string;
    return { repoRoot, bundleRoot, reviewsRoot, eventsRoot, preflightPath, preflightSha256: sha256(preflightPath), scopeContentSha256 };
}

it('rejects native multi-target focused authority before filtering to changed source scope', async () => {
    const source = 'tests/changed.test.cjs', unrelated = 'tests/unrelated.test.cjs';
    const testBody = (name: string) => `require('node:test')(${JSON.stringify(name)}, () => require('node:assert/strict').equal(1, 1));\n`;
    const f = nativeFixture({ source, content: testBody('changed assertion'),
        baselineFiles: { [unrelated]: testBody('unrelated assertion') } });
    try {
        const command = `node --test ${source} ${unrelated}`;
        for (const selectedCases of [undefined, [{ source, case_id: 'changed assertion', selector: source }]]) {
            const run = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
                commandSource: 'targeted-test', command, preflightPath: f.preflightPath, selectedCases });
            assert.equal(run.exitCode, 0, run.outputLines.join('\n'));
            const observations = readTaskOwnedFocusedIntermediateEvidence({ ...f, taskId: TASK_ID,
                changedFiles: [source], expectedPreflightPath: f.preflightPath, expectedPreflightSha256: f.preflightSha256 });
            const preflight = JSON.parse(fs.readFileSync(f.preflightPath, 'utf8'));
            assert.equal(inspectReviewerFocusedValidationCommand(command, f.repoRoot, TASK_ID).syntax_supported, false,
                JSON.stringify({ explicitCases: selectedCases?.length ?? 0,
                    policy: preflight.profile_policy_snapshot?.review_trigger_policy ?? null,
                    captured: observations.entries[0]?.selected_case_binding?.before.sources.map(item => item.path) }));
        }
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

it('retains current selected typecheck observations for focused validation', async () => {
    const source = 'tests/changed.test.cjs';
    const f = nativeFixture({ source, content: 'const value = 1;\n' });
    try {
        const command = `node --check ${source}`;
        const run = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
            commandSource: 'typecheck', command, preflightPath: f.preflightPath });
        assert.equal(run.exitCode, 0, run.outputLines.join('\n'));
        const observed = readTaskOwnedFocusedIntermediateEvidence({ ...f, taskId: TASK_ID,
            changedFiles: [source], expectedPreflightPath: f.preflightPath,
            expectedPreflightSha256: f.preflightSha256 });
        assert.equal(observed.entries.length, 1, observed.warnings.join('\n'));
        assert.deepEqual(inspectReviewerFocusedValidationCommand(command, f.repoRoot, TASK_ID),
            { syntax_supported: true, target: source, violations: [] });
        const failed = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
            commandSource: 'typecheck', command: `node --garda-no-such-option --check ${source}`, preflightPath: f.preflightPath });
        assert.notEqual(failed.exitCode, 0);
        assert.equal(readTaskOwnedFocusedIntermediateEvidence({ ...f, taskId: TASK_ID,
            changedFiles: [source], expectedPreflightPath: f.preflightPath,
            expectedPreflightSha256: f.preflightSha256 }).entries.length, 0);
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

it('rejects a directory suite operand hidden beside one selected test file', async () => {
    const source = 'tests/changed.test.cjs', directory = 'tests/extra';
    const body = (name: string) => `require('node:test')(${JSON.stringify(name)}, () => require('node:assert/strict').equal(1, 1));\n`;
    const f = nativeFixture({ source, content: body('changed assertion'),
        baselineFiles: { [`${directory}/index.js`]: body('unrelated directory assertion') } });
    try {
        const command = `node --test ${source} ${directory}`;
        for (const selectedCases of [undefined, [{ source, case_id: 'changed assertion', selector: source }],
            [{ source, case_id: 'changed assertion', selector: '--test' }]]) {
            const run = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
                commandSource: 'targeted-test', command, preflightPath: f.preflightPath, selectedCases });
            assert.equal(run.exitCode, 0, run.outputLines.join('\n'));
            assert.equal(inspectReviewerFocusedValidationCommand(command, f.repoRoot, TASK_ID).syntax_supported, false);
        }
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

it('rejects actual source inspection as native focused self-validation', async () => {
    const source = 'tests/changed.test.cjs';
    const f = nativeFixture({ source, content: 'const changed = 2;\n',
        baselineFiles: { [source]: 'const changed = 1;\n' } });
    try {
        const command = `git diff -- ${source}`;
        const run = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command, preflightPath: f.preflightPath });
        assert.equal(run.exitCode, 0, run.outputLines.join('\n'));
        const observed = readTaskOwnedFocusedIntermediateEvidence({ ...f, taskId: TASK_ID,
            changedFiles: [source], expectedPreflightPath: f.preflightPath,
            expectedPreflightSha256: f.preflightSha256 });
        assert.equal(observed.entries.length, 1, observed.warnings.join('\n'));
        assert.equal(inspectReviewerFocusedValidationCommand(command, f.repoRoot, TASK_ID).syntax_supported, false);
        const check = `git diff --check -- ${source}`;
        const validation = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command: check, preflightPath: f.preflightPath });
        assert.equal(validation.exitCode, 0, validation.outputLines.join('\n'));
        assert.deepEqual(inspectReviewerFocusedValidationCommand(check, f.repoRoot, TASK_ID),
            { syntax_supported: true, target: source, violations: [] });
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

it('preserves canonical focused source spelling for Windows case-insensitive selected identities',
    { skip: process.platform !== 'win32' }, async () => {
        const f = await symbolicFixture({ sourceSpelling: 'CHECKS/ВОЗВРАТ.CASE' });
        try {
            const selected = f.selected();
            assert.equal(selected.entries.length, 1, selected.warnings.join('\n'));
            assert.deepEqual(selected.entries[0].focused_test_paths, [f.source]);
            assert.deepEqual(inspectReviewerFocusedValidationCommand(f.command, f.repoRoot, TASK_ID),
                { syntax_supported: true, target: f.source, violations: [] });
        } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
    });

it('rejects mutating executable spellings despite authenticated native focused evidence', async () => {
    const source = 'tests/changed.test.cjs';
    const f = nativeFixture({ source, content: 'opaque selected test source\n' });
    try {
        const executable = process.platform === 'win32' ? 'git.exe' : 'git';
        for (const runner of [executable, `"${executable}"`, `${executable} --literal-pathspecs`,
            `"${executable}" -c core.autocrlf=false`]) {
            const command = `${runner} add ${source}`;
            const run = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
                commandSource: 'targeted-test', command, preflightPath: f.preflightPath });
            assert.equal(run.exitCode, 0, run.outputLines.join('\n'));
            const observed = readTaskOwnedFocusedIntermediateEvidence({ ...f, taskId: TASK_ID,
                changedFiles: [source], expectedPreflightPath: f.preflightPath,
                expectedPreflightSha256: f.preflightSha256 });
            assert.equal(observed.entries.length, 1, observed.warnings.join('\n'));
            const inspection = inspectReviewerFocusedValidationCommand(command, f.repoRoot, TASK_ID);
            assert.equal(inspection.syntax_supported, false, command);
            assert.ok(inspection.violations.some(reason => reason.includes('mutate source')), inspection.violations.join('\n'));
        }
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

function appendEvidence(options: {
    bundleRoot: string;
    reviewsRoot: string;
    taskId?: string;
    command?: string;
    status?: 'PASSED' | 'FAILED';
    mutateOutput?: boolean;
    artifactTaskId?: string;
    omitEventExitCode?: boolean;
    omitEventOutputArtifactPath?: boolean;
    preflightPath?: string;
    preflightSha256?: string;
    coverageContractSha256?: string;
    eventPreflightSha256?: string;
    scopeContentSha256?: string;
    afterScopeContentSha256?: string;
}): void {
    const taskId = options.taskId ?? TASK_ID;
    const command = options.command
        ?? `node scripts/node-foundation/build-scripts.cjs test.js ${TEST_PATH}`;
    const suffix = crypto.randomBytes(4).toString('hex');
    const outputPath = path.join(options.reviewsRoot, `${taskId}-${suffix}.log`);
    const artifactPath = path.join(options.reviewsRoot, `${taskId}-${suffix}.json`);
    const status = options.status ?? 'PASSED';
    fs.writeFileSync(outputPath, 'focused validation passed\n', 'utf8');
    const outputSha256 = sha256(outputPath);
    const outputSize = fs.statSync(outputPath).size;
    fs.writeFileSync(artifactPath, JSON.stringify({
        schema_version: 1,
        task_id: options.artifactTaskId ?? taskId,
        command_source: 'targeted-test',
        command,
        status,
        exit_code: status === 'PASSED' ? 0 : 1,
        timed_out: false,
        cancelled: false,
        output_artifact: outputPath,
        output_artifact_sha256: outputSha256,
        output_artifact_size_bytes: outputSize,
        ...(options.preflightPath ? { preflight_path: options.preflightPath } : {}),
        ...(options.preflightSha256 ? { preflight_sha256: options.preflightSha256 } : {}),
        ...(options.coverageContractSha256 ? { coverage_contract_sha256: options.coverageContractSha256 } : {}),
        ...(options.scopeContentSha256 ? {
            scope_content_sha256_before: options.scopeContentSha256,
            scope_content_sha256_after: options.afterScopeContentSha256 ?? options.scopeContentSha256
        } : {})
    }), 'utf8');
    const eventDetails: Record<string, unknown> = {
        command_source: 'targeted-test',
        command,
        artifact_path: artifactPath,
        artifact_sha256: sha256(artifactPath),
        output_artifact_sha256: outputSha256,
        output_artifact_size_bytes: outputSize
    };
    if (options.preflightPath) {
        eventDetails.preflight_path = options.preflightPath;
    }
    if (options.preflightSha256) {
        eventDetails.preflight_sha256 = options.eventPreflightSha256 ?? options.preflightSha256;
    }
    if (options.coverageContractSha256) {
        eventDetails.coverage_contract_sha256 = options.coverageContractSha256;
    }
    if (options.scopeContentSha256) {
        eventDetails.scope_content_sha256_before = options.scopeContentSha256;
        eventDetails.scope_content_sha256_after = options.afterScopeContentSha256 ?? options.scopeContentSha256;
    }
    if (!options.omitEventOutputArtifactPath) {
        eventDetails.output_artifact_path = outputPath;
    }
    if (!options.omitEventExitCode) {
        eventDetails.exit_code = status === 'PASSED' ? 0 : 1;
    }
    appendTaskEvent(options.bundleRoot, taskId, 'INTERMEDIATE_COMMAND_RUN', status, 'Focused command.', eventDetails);
    if (options.mutateOutput) {
        fs.appendFileSync(outputPath, 'tampered\n', 'utf8');
    }
}

describe('task-owned focused intermediate evidence', () => {
    it('round-trips Maven and Gradle selectors without requiring a literal test filename in argv', () => {
        const fixture = makeFixture();
        const source = 'component/src/test/java/shop/CheckoutTest.java';
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({ ...fixture, command: 'mvn -q -Dtest=shop.CheckoutTest test' });
            appendEvidence({ ...fixture, command: 'gradle test --tests shop.CheckoutTest --console=plain' });
            const result = readTaskOwnedFocusedIntermediateEvidence({ ...fixture, taskId: TASK_ID, changedFiles: [source] });
            assert.equal(result.entries.length, 2);
            assert.ok(result.entries.every(entry => entry.focused_test_paths.includes(source)));
        } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
    });

    it('keeps unrelated JVM selectors outside the supplied source scope', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({ ...fixture, command: 'mvn -q -Dtest=shop.OtherTest test' });
            const result = readTaskOwnedFocusedIntermediateEvidence({ ...fixture, taskId: TASK_ID,
                changedFiles: ['component/src/test/java/shop/CheckoutTest.java'] });
            assert.equal(result.entries.length, 0);
        } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
    });

    it('authenticates an opaque native command as process evidence without claiming case success', () => {
        const fixture = nativeFixture();
        const { preflightPath, preflightSha256, scopeContentSha256 } = fixture;
        try {
            appendEvidence({ ...fixture, command: 'unfamiliar-runner --select "Оплата::rejectsEmpty"',
                preflightPath, preflightSha256, scopeContentSha256 });
            const read = (intermediateEvidence as unknown as { readTaskOwnedIntermediateExecutionEvidence:
                (options: Record<string, unknown>) => { entries: Array<Record<string, unknown>> } }).readTaskOwnedIntermediateExecutionEvidence;
            const result = read({ ...fixture, taskId: TASK_ID, expectedPreflightPath: preflightPath,
                expectedPreflightSha256: preflightSha256, expectedScopeContentSha256: scopeContentSha256 });
            assert.equal(result.entries.length, 1);
            assert.equal(result.entries[0].execution, 'OBSERVED');
            assert.equal(result.entries[0].semantic_status, 'PENDING_INDEPENDENT_REVIEW');
            assert.equal(result.entries[0].cases, undefined);
        } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
    });

    it('rejects altered output and changed native source scope for opaque command evidence', () => {
        const fixture = nativeFixture();
        const { preflightPath, preflightSha256, scopeContentSha256 } = fixture;
        try {
            appendEvidence({ ...fixture, command: 'custom-runner --case selected', preflightPath,
                preflightSha256, scopeContentSha256, mutateOutput: true });
            appendEvidence({ ...fixture, command: 'custom-runner --case selected', preflightPath,
                preflightSha256, scopeContentSha256, afterScopeContentSha256: 'c'.repeat(64) });
            const read = (intermediateEvidence as unknown as { readTaskOwnedIntermediateExecutionEvidence:
                (options: Record<string, unknown>) => { entries: unknown[] } }).readTaskOwnedIntermediateExecutionEvidence;
            assert.equal(read({ ...fixture, taskId: TASK_ID, expectedPreflightPath: preflightPath,
                expectedPreflightSha256: preflightSha256, expectedScopeContentSha256: scopeContentSha256 }).entries.length, 0);
        } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
    });

    it('rejects a fabricated preflight digest despite matching record and expected bindings', () => {
        const fixture = nativeFixture();
        const { preflightPath, scopeContentSha256 } = fixture;
        const fabricatedHash = 'a'.repeat(64);
        try {
            appendEvidence({ ...fixture, command: 'custom-runner --case selected', preflightPath,
                preflightSha256: fabricatedHash, scopeContentSha256 });
            const result = intermediateEvidence.readTaskOwnedIntermediateExecutionEvidence({ ...fixture,
                taskId: TASK_ID, expectedPreflightPath: preflightPath,
                expectedPreflightSha256: fabricatedHash, expectedScopeContentSha256: scopeContentSha256 });
            assert.equal(result.entries.length, 0);
            assert.ok(result.warnings.some(warning => /preflight/iu.test(warning)));
        } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
    });

    it('selects only current-cycle, PASS, scope-matched evidence with bounded metadata', () => {
        const fixture = makeFixture();
        try {
            appendEvidence(fixture);
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            for (let index = 0; index < 10; index += 1) {
                appendEvidence(fixture);
            }

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxEntries: 3
            });

            assert.equal(selection.entries.length, 3);
            assert.equal(selection.truncated, true);
            assert.equal(selection.candidate_count, 11);
            assert.equal(selection.rejected_candidate_count, 1);
            assert.ok(selection.entries.every((entry) => entry.status === 'PASSED' && entry.exit_code === 0));
            assert.ok(selection.entries.every((entry) => entry.focused_test_paths.includes(TEST_PATH)));
            assert.ok(selection.warnings.some((warning) => warning.includes('stale or foreign task/cycle binding')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects failed, foreign, scope-mismatched, and tampered evidence with actionable warnings', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({ ...fixture, status: 'FAILED' });
            appendEvidence({ ...fixture, omitEventExitCode: true });
            appendEvidence({ ...fixture, omitEventOutputArtifactPath: true });
            appendEvidence({ ...fixture, artifactTaskId: 'T-FOREIGN' });
            appendEvidence({
                ...fixture,
                command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/other.test.ts'
            });
            appendEvidence({ ...fixture, mutateOutput: true });

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH]
            });

            assert.equal(selection.entries.length, 0);
            assert.equal(selection.rejected_candidate_count, 6);
            assert.ok(selection.warnings.some((warning) => warning.includes('not a gate-owned PASSED command')));
            assert.ok(selection.warnings.some((warning) => warning.includes('binding is inconsistent')));
            assert.ok(selection.warnings.some((warning) => warning.includes('outside the current review scope')));
            assert.ok(selection.warnings.some((warning) => warning.includes('size or sha256')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('requires focused evidence to match expected preflight and coverage bindings when provided', () => {
        const fixture = makeFixture();
        const preflightPath = path.join(fixture.reviewsRoot, 'T-979-4-preflight.json').replace(/\\/g, '/');
        const preflightSha256 = 'a'.repeat(64);
        const coverageContractSha256 = 'b'.repeat(64);
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({
                ...fixture,
                preflightPath,
                preflightSha256: 'c'.repeat(64),
                coverageContractSha256
            });
            appendEvidence({
                ...fixture,
                preflightPath,
                preflightSha256,
                coverageContractSha256
            });

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                expectedPreflightPath: preflightPath,
                expectedPreflightSha256: preflightSha256,
                expectedCoverageContractSha256: coverageContractSha256,
                maxEntries: 2
            });

            assert.equal(selection.entries.length, 1);
            assert.equal(selection.entries[0].preflight_sha256, preflightSha256);
            assert.equal(selection.entries[0].coverage_contract_sha256, coverageContractSha256);
            assert.equal(selection.rejected_candidate_count, 1);
            assert.ok(selection.warnings.some((warning) => warning.includes('does not match the current review context')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects focused evidence when event and artifact scope bindings disagree', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({
                ...fixture,
                preflightPath: path.join(fixture.reviewsRoot, 'T-979-4-preflight.json').replace(/\\/g, '/'),
                preflightSha256: 'a'.repeat(64),
                eventPreflightSha256: 'b'.repeat(64),
                coverageContractSha256: 'c'.repeat(64)
            });

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH]
            });

            assert.equal(selection.entries.length, 0);
            assert.equal(selection.rejected_candidate_count, 1);
            assert.ok(selection.warnings.some((warning) => warning.includes('artifact and event preflight')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects malformed focused evidence hash bindings even without expected bindings', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({
                ...fixture,
                preflightPath: path.join(fixture.reviewsRoot, 'T-979-4-preflight.json').replace(/\\/g, '/'),
                preflightSha256: 'not-a-sha256',
                coverageContractSha256: 'b'.repeat(64)
            });

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH]
            });

            assert.equal(selection.entries.length, 0);
            assert.equal(selection.rejected_candidate_count, 1);
            assert.ok(selection.warnings.some((warning) => warning.includes('not a valid SHA-256 hex binding')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('does not bind surplus focused artifacts after the entry limit is reached', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence({ ...fixture, mutateOutput: true });
            for (let index = 0; index < 10; index += 1) {
                appendEvidence(fixture);
            }

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxEntries: 3
            });

            assert.equal(selection.entries.length, 3);
            assert.equal(selection.candidate_count, 11);
            assert.equal(selection.rejected_candidate_count, 0);
            assert.equal(selection.truncated, true);
            assert.equal(selection.warnings.some((warning) => warning.includes('size or sha256')), false);
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects focused evidence when the task timeline exceeds bounded read limits', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            appendEvidence(fixture);

            const byteBoundSelection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxTimelineBytes: 1
            });

            assert.equal(byteBoundSelection.entries.length, 0);
            assert.equal(byteBoundSelection.truncated, true);
            assert.ok(byteBoundSelection.warnings.some((warning) => warning.includes('byte read bound')));

            const eventBoundSelection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxTimelineEvents: 1
            });

            assert.equal(eventBoundSelection.entries.length, 0);
            assert.equal(eventBoundSelection.truncated, true);
            assert.ok(eventBoundSelection.warnings.some((warning) => warning.includes('event read bound')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('caps intermediate candidate scanning even when more surplus evidence exists', () => {
        const fixture = makeFixture();
        try {
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current cycle.', {});
            for (let index = 0; index < 8; index += 1) {
                appendEvidence(fixture);
            }

            const selection = readTaskOwnedFocusedIntermediateEvidence({
                repoRoot: fixture.repoRoot,
                reviewsRoot: fixture.reviewsRoot,
                eventsRoot: fixture.eventsRoot,
                taskId: TASK_ID,
                changedFiles: [TEST_PATH],
                maxEntries: 3,
                maxIntermediateCandidatesScanned: 4
            });

            assert.equal(selection.entries.length, 3);
            assert.equal(selection.candidate_count, 4);
            assert.equal(selection.truncated, true);
            assert.ok(selection.warnings.some((warning) => warning.includes('surplus scan stopped after 4 intermediate candidates')));
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });
});
