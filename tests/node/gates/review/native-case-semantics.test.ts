import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runClassifyChangeCommand, runIntermediateCommandCommand } from '../../../../src/cli/commands/gates';
import { readValidationFile, validationDigest } from '../../../../src/core/project-validation-identity';
import { readNativeCaseObligations, getNativeCaseResolutionViolations } from '../../../../src/gates/review/native-case-semantics';
import { buildNativeCaseReviewCoverageContract } from '../../../../src/gates/review-context/review-context-coverage';
import { classifyReviewOutputCorrectionDiagnostics } from '../../../../src/gates/review/review-output-correction';
import { validateReviewFindingsContract } from '../../../../src/gates/review/review-findings-artifact-verdict';
import { validateReviewFindingsReport } from '../../../../src/gates/review/review-findings-schema';
import { buildReviewerFindingsOutputTemplateJson } from '../../../../src/gates/review/reviewer-findings-prompt-contract';
import { buildReviewRemediationReviewContract } from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import { captureIntermediateSelection, completeIntermediateSelection,
    assertCurrentIntermediateSelection } from '../../../../src/core/intermediate-selected-cases';
import { inspectValidationCommand } from '../../../../src/core/validation-command-contract';
import { runCliWithCapturedOutput } from '../../cli/commands/gate-test-cli-capture';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode,
    runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, seedTaskQueue } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';

const TASK = 'T-NATIVE-CASE', SOURCE = 'custom/Кейс.case', CASE = 'Оплата::rejectsEmptyPayment';
const XML = `<результат случай="${CASE}">успех</результат>`;
const SECOND_SOURCE = 'custom/Другой.case', SECOND_CASE = 'Возврат::rejectsInvalidRefund';
const SECOND_XML = `<результат случай="${SECOND_CASE}">успех</результат>`;

async function fixture(missingCase = false, withSecondCase = false, symbolic = false, concurrent = false) {
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, TASK); seedInitAnswers(repoRoot); initializeGitRepo(repoRoot);
    const entry = runEnterTaskMode({ repoRoot, taskId: TASK, entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2, taskSummary: 'Native case source and report', provider: 'Codex' });
    assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
    loadTaskEntryRulePack(repoRoot, TASK); runHandshakeForTask(repoRoot, TASK); runShellSmokeForTask(repoRoot, TASK);
    fs.mkdirSync(path.join(repoRoot, 'custom'));
    fs.writeFileSync(path.join(repoRoot, SOURCE), [
        "const assert = require('node:assert/strict');",
        ...(concurrent ? [
            "const fs = require('node:fs');",
            "const hold = process.argv.find(value => value === '--hold-a' || value === '--hold-b');",
            "if (hold) {",
            "  const root = 'garda-agent-orchestrator/runtime/tmp/case-overlap/';",
            "  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(root + hold + '.ready', 'ready');",
            "  const deadline = Date.now() + 30000;",
            "  while (!fs.existsSync(root + hold + '.release')) {",
            "    if (Date.now() > deadline) throw new Error('release timed out');",
            "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);",
            "  }",
            "}",
            "const report = process.argv.find(value => value.startsWith('--report='));",
            `if (report && !process.argv.includes('--skip-report')) { fs.writeFileSync(report.slice(9), ${JSON.stringify(XML)}`
                + " + (process.argv.includes('--large-report') ? ' '.repeat(9 * 1024 * 1024) : ''));",
            "  if (process.argv.includes('--delete-report')) fs.unlinkSync(report.slice(9)); }"
        ] : []),
        "function pay(value) { if (!value) throw new Error('empty payment'); return value; }",
        "function rejectsEmptyPayment() { assert.throws(() => pay(''), /empty payment/); }",
        ...(missingCase ? ["console.log('runner ready');"] : [
            `assert.equal(process.argv.at(-1), ${JSON.stringify(CASE)});`,
            'rejectsEmptyPayment();', `console.log(process.argv.includes('--file-only') ? 'runner ready' : ${JSON.stringify(XML)});`
        ]), ''
    ].join('\n'));
    if (withSecondCase) fs.writeFileSync(path.join(repoRoot, SECOND_SOURCE), [
        "const assert = require('node:assert/strict');",
        `assert.equal(process.argv.at(-1), ${JSON.stringify(SECOND_CASE)});`,
        "assert.throws(() => { throw new Error('invalid refund'); }, /invalid refund/);",
        `console.log(${JSON.stringify(SECOND_XML)});`, ''
    ].join('\n'));
    const helper = 'custom/Runner.unfamiliar';
    if (symbolic) fs.writeFileSync(path.join(repoRoot, helper), [
        "const assert = require('node:assert/strict');",
        `assert.equal(process.argv[2], ${JSON.stringify(`--история=${CASE}`)});`,
        `process.argv.push(${JSON.stringify(CASE)});`, "require('./Кейс.case');", ''
    ].join('\n'));
    const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/native-preflight.json');
    const classified = runClassifyChangeCommand({ repoRoot, taskId: TASK, taskIntent: 'Native case source and report',
        changedFiles: [SOURCE, ...(withSecondCase ? [SECOND_SOURCE] : []), ...(symbolic ? [helper] : [])], outputPath: preflightPath });
    assert.ok(fs.existsSync(preflightPath), classified.outputText);
    const preflightFile = fs.readFileSync(preflightPath);
    const preflight = JSON.parse(preflightFile.toString('utf8'));
    const command = symbolic ? `node ${helper} --история=${CASE}` : `node ${SOURCE} --select ${CASE}`;
    const selectedCases = symbolic ? [{ source: SOURCE, case_id: CASE, selector: CASE }] : undefined;
    const result = await runIntermediateCommandCommand({ repoRoot, taskId: TASK, commandSource: 'targeted-test',
        command, selectedCases, preflightPath });
    assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
    const sources = [{ source_identity: readValidationFile(repoRoot, SOURCE).identity,
        case_id: CASE, selector: CASE, syntax_status: 'UNRESOLVED' as const }];
    const obligations = readNativeCaseObligations({ repoRoot, taskId: TASK, preflightPath,
        preflightSha256: validationDigest(preflightFile), scopeContentSha256: preflight.metrics.scope_content_sha256, sources });
    return { repoRoot, obligations, preflightPath, preflight, preflightSha256: validationDigest(preflightFile), sources,
        command, selectedCases };
}

for (const large of [false, true]) test(`ordinary command file reports ${large ? 'above 8 MiB' : 'small'} retain case quotations and reject stale or missing reports`, async t => {
    const f = await fixture(false, false, false, true);
    t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const report = 'garda-agent-orchestrator/runtime/tmp/ordinary-case-report.xml';
    fs.mkdirSync(path.dirname(path.join(f.repoRoot, report)), { recursive: true });
    const run = async (extra = '') => {
        const result = await runCliWithCapturedOutput(['gate', 'run-intermediate-command', '--repo-root', f.repoRoot,
            '--task-id', TASK, '--command-source', 'targeted-test', '--preflight-path', f.preflightPath,
            '--command', `node ${SOURCE} --file-only --report=${report} ${large ? '--large-report ' : ''}${extra} ${CASE}`,
            '--report-file', JSON.stringify({ path: report, max_bytes: large ? 10 * 1024 * 1024 : 4096 })]);
        return { exitCode: result.exitCode, outputLines: [...result.logs, ...result.errors] };
    };
    const inspect = () => readNativeCaseObligations({ repoRoot: f.repoRoot, taskId: TASK,
        preflightPath: f.preflightPath, preflightSha256: f.preflightSha256,
        scopeContentSha256: f.preflight.metrics.scope_content_sha256, sources: f.sources });
    const result = await run();
    assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
    const obligations = inspect(), binding = obligations[0], execution = binding.case_execution!;
    assert.equal(execution.output_encoding, 'base64-streams');
    const retained = JSON.parse(fs.readFileSync(execution.output_path, 'utf8'));
    assert.equal(Buffer.from(retained.stdout_base64, 'base64').toString().includes(XML), false);
    assert.equal(Buffer.from(retained.report_capture.reports[0].content_base64, 'base64').toString().trimEnd(), XML);
    if (large) assert.ok(execution.output_size_bytes > 8 * 1024 * 1024);
    const entries = [{ obligation_id: `VALIDATION-${binding.id.toUpperCase()}`, case_resolution: {
        binding_sha256: validationDigest(binding), execution_sha256: execution.record_sha256,
        output_sha256: execution.output_sha256, outcome: 'PASSED', evidence_quote: XML,
        reasoning: 'The selected assertion and its actual retained XML establish this case result.' } }];
    assert.deepEqual(getNativeCaseResolutionViolations({ repoRoot: f.repoRoot, obligations, entries, requirePassed: true }), []);
    fs.writeFileSync(path.join(f.repoRoot, report), 'unrelated subsequent report');
    assert.deepEqual(getNativeCaseResolutionViolations({ repoRoot: f.repoRoot, obligations, entries, requirePassed: true }), []);
    const refreshed = await run();
    assert.equal(refreshed.exitCode, 0, refreshed.outputLines.join('\n'));
    assert.equal(inspect().length, 1, 'A declared output operand may be overwritten without weakening captured input checks.');
    for (const extra of ['--skip-report', '--delete-report']) {
        const failed = await run(extra);
        assert.notEqual(failed.exitCode, 0, failed.outputLines.join('\n'));
        assert.match(failed.outputLines.join('\n'), /INTERMEDIATE_COMMAND_FAILED/);
        assert.throws(inspect, /latest matching|successful execution/u);
    }
});

test('newer overlapping failed or unfinished attempts supersede an older late successful completion', async t => {
    const f = await fixture(false, false, false, true);
    t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const root = path.join(f.repoRoot, 'garda-agent-orchestrator/runtime/tmp/case-overlap');
    const ready = async (name: string) => {
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(path.join(root, name + '.ready'))) {
            assert.ok(Date.now() < deadline, 'Real child must publish readiness before overlap assertions.');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    };
    const release = (name: string) => fs.writeFileSync(path.join(root, name + '.release'), 'release');
    const run = (argument: string) => runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK,
        commandSource: 'targeted-test', command: `node ${SOURCE} ${argument} ${CASE}`, preflightPath: f.preflightPath });
    const inspect = () => readNativeCaseObligations({ repoRoot: f.repoRoot, taskId: TASK,
        preflightPath: f.preflightPath, preflightSha256: f.preflightSha256,
        scopeContentSha256: f.preflight.metrics.scope_content_sha256, sources: f.sources });
    for (const scenario of ['failed', 'unfinished']) await t.test(scenario, async () => {
        fs.rmSync(root, { recursive: true, force: true });
        const earlier = run('--hold-a'); let later: ReturnType<typeof run> | undefined;
        try {
            await ready('--hold-a');
            if (scenario === 'failed') {
                const failed = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK,
                    commandSource: 'targeted-test', command: `node ${SOURCE} --select invalid`, preflightPath: f.preflightPath });
                assert.equal(failed.exitCode, 1);
            } else { later = run('--hold-b'); await ready('--hold-b'); }
            release('--hold-a');
            assert.equal((await earlier).exitCode, 0);
            assert.throws(inspect, /latest matching|successful execution/u);
            if (later) { release('--hold-b'); assert.equal((await later).exitCode, 0); assert.equal(inspect().length, 1); }
        } finally {
            fs.mkdirSync(root, { recursive: true }); release('--hold-a'); release('--hold-b');
            await Promise.allSettled([earlier, ...(later ? [later] : [])]);
        }
    });
});

test('rejects changed undeclared captured operands while retaining unobserved operand diagnostics', async t => {
    const f = await fixture(false, false, false, true);
    t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const report = 'garda-agent-orchestrator/runtime/tmp/generated-case-report.xml';
    fs.mkdirSync(path.dirname(path.join(f.repoRoot, report)), { recursive: true });
    for (const { explicit, large } of [{ explicit: false, large: false }, { explicit: true, large: false },
        { explicit: true, large: true }]) for (const remove of [false, true]) {
        fs.writeFileSync(path.join(f.repoRoot, report), large ? Buffer.alloc(8 * 1024 * 1024 + 1) : 'previous report');
        const result = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK,
            commandSource: 'targeted-test',
            command: `node ${SOURCE} --report=${report} ${remove ? '--delete-report ' : ''}--select ${CASE}`,
            selectedCases: explicit ? [{ source: SOURCE, case_id: CASE, selector: CASE }] : undefined,
            preflightPath: f.preflightPath });
        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
        assert.equal(fs.existsSync(path.join(f.repoRoot, report)), !remove);
        if (!remove) assert.equal(fs.readFileSync(path.join(f.repoRoot, report), 'utf8'), XML);
        const inspect = () => readNativeCaseObligations({ repoRoot: f.repoRoot, taskId: TASK,
            preflightPath: f.preflightPath, preflightSha256: f.preflightSha256,
            scopeContentSha256: f.preflight.metrics.scope_content_sha256, sources: f.sources });
        if (!large) {
            assert.throws(inspect, /latest matching|successful execution/u,
                'An undeclared changed captured operand cannot become an output merely because its option is named --report.');
            continue;
        }
        const obligations = inspect();
        assert.equal(obligations.length, 1);
        assert.equal(obligations[0].result_status, 'UNRESOLVED');
        assert.ok(fs.readFileSync(obligations[0].case_execution!.output_path, 'utf8').includes(XML));
        const record = JSON.parse(fs.readFileSync(obligations[0].case_execution!.record_path, 'utf8'));
        assert.ok(record.selected_case_binding.before.unobserved_operands.includes(report));
        assert.ok(!record.selected_case_binding.before.sources.some((source: { path: string }) => source.path === report));
    }
});

test('retains stdout case evidence with an explicitly declared mutable side report and rejects its deletion', async t => {
    const f = await fixture(false, false, false, true);
    t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const report = 'garda-agent-orchestrator/runtime/tmp/declared-side-report.xml';
    fs.mkdirSync(path.dirname(path.join(f.repoRoot, report)), { recursive: true });
    const inspect = () => readNativeCaseObligations({ repoRoot: f.repoRoot, taskId: TASK,
        preflightPath: f.preflightPath, preflightSha256: f.preflightSha256,
        scopeContentSha256: f.preflight.metrics.scope_content_sha256, sources: f.sources });
    for (const remove of [false, true]) {
        fs.writeFileSync(path.join(f.repoRoot, report), 'previous report');
        const result = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK,
            commandSource: 'targeted-test', preflightPath: f.preflightPath,
            command: `node ${SOURCE} --report=${report} ${remove ? '--delete-report ' : ''}--select ${CASE}`,
            reportFiles: [{ path: report, max_bytes: 4096 }] });
        if (remove) {
            assert.notEqual(result.exitCode, 0);
            assert.throws(inspect, /latest matching|successful execution/u);
        } else {
            assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
            const obligations = inspect(), execution = obligations[0].case_execution!;
            assert.equal(obligations[0].result_status, 'UNRESOLVED');
            const retained = JSON.parse(fs.readFileSync(execution.output_path, 'utf8'));
            assert.ok(Buffer.from(retained.stdout_base64, 'base64').toString().includes(XML));
            assert.equal(Buffer.from(retained.report_capture.reports[0].content_base64, 'base64').toString(), XML);
        }
    }
});

test('binds a symbolic selector without runner, option or source-extension grammar and supersedes a metadata-omitting cancellation', async t => {
    const f = await fixture(false, false, true);
    t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const execution = f.obligations[0].case_execution!;
    const record = JSON.parse(fs.readFileSync(execution.record_path, 'utf8'));
    assert.equal(record.command, f.command);
    assert.equal(record.invocations[0].argv.at(-1), `--история=${CASE}`);
    assert.deepEqual(record.selected_case_binding.before.cases, f.selectedCases);
    assert.deepEqual(record.selected_case_binding.before.sources, record.selected_case_binding.after);
    const inspect = () => readNativeCaseObligations({ repoRoot: f.repoRoot, taskId: TASK,
        preflightPath: f.preflightPath, preflightSha256: f.preflightSha256,
        scopeContentSha256: f.preflight.metrics.scope_content_sha256, sources: f.sources });
    const controller = new AbortController(); controller.abort();
    const repeatedCommand = `node  "custom/Runner.unfamiliar" "--история=${CASE}"`;
    assert.deepEqual(inspectValidationCommand(repeatedCommand, 'test').descriptor,
        inspectValidationCommand(f.command, 'test').descriptor);
    const cancelled = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK,
        commandSource: 'targeted-test', command: repeatedCommand, preflightPath: f.preflightPath, signal: controller.signal });
    assert.notEqual(cancelled.exitCode, 0);
    assert.throws(inspect, /latest matching|successful execution/u);
    const unavailable = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK,
        commandSource: 'targeted-test', command: `garda-missing-runner-t3261 --история=${CASE}`,
        selectedCases: f.selectedCases, preflightPath: f.preflightPath });
    assert.notEqual(unavailable.exitCode, 0);
    const unavailableRecord = unavailable.outputLines.find(line => line.startsWith('ArtifactPath: '))!.slice(14);
    const retained = JSON.parse(fs.readFileSync(unavailableRecord, 'utf8'));
    assert.equal(retained.invocations[0].exitCode, null);
    assert.equal(typeof retained.invocations[0].executionError, 'string');
    assert.ok(fs.readFileSync(retained.output_artifact, 'utf8').trim());
    assert.throws(inspect, /latest matching|successful execution/u);
});

test('selected-source metadata rejects foreign, duplicate, oversized and linked inputs before any execution claim', t => {
    const repoRoot = createTempRepo(); t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(repoRoot, 'custom')); fs.writeFileSync(path.join(repoRoot, SOURCE), 'source bytes\n');
    const descriptor = inspectValidationCommand(`widget-check --чужая-опция=${CASE}`, 'test').descriptor!;
    const claim = { source: SOURCE, case_id: CASE, selector: CASE };
    const capture = (input: unknown) => captureIntermediateSelection(repoRoot, descriptor, input);
    const selection = capture([claim]);
    assert.equal(selection.sources[0].path, SOURCE);
    assertCurrentIntermediateSelection(repoRoot, completeIntermediateSelection(repoRoot, selection));
    // A partial selector stays rejected, and the error names the exact token that would satisfy it.
    assert.throws(() => capture([{ ...claim, selector: CASE.slice(1) }]), (error: Error) =>
        /selector is absent/u.test(error.message) && error.message.includes(`Use the full token instead: ${JSON.stringify(CASE)}`));
    assert.throws(() => capture([{ ...claim, selector: 'unrelated-selector' }]), /exactly as the selector value/u);
    assert.throws(() => capture([{ ...claim, source: '../outside.case' }]), /contained/u);
    assert.throws(() => capture([{ ...claim, source: 'custom/missing.case' }]));
    assert.throws(() => capture([{ ...claim, extra: true }]), /requires/u);
    assert.throws(() => capture([claim, claim]), /ambiguous/u);
    assert.throws(() => capture(Array.from({ length: 129 }, () => claim)), /bound/u);
    fs.appendFileSync(path.join(repoRoot, SOURCE), 'changed\n');
    assert.throws(() => assertCurrentIntermediateSelection(repoRoot,
        completeIntermediateSelection(repoRoot, selection)), /changed/u);
    const linked = path.join(repoRoot, 'custom/linked.case'); fs.linkSync(path.join(repoRoot, SOURCE), linked);
    assert.throws(() => capture([claim]), /identity|regular|link/u);
});

test('rejects absent selectors and replaced symbolic source identities while preserving actual successful process facts', async t => {
    const f = await fixture(false, false, true);
    t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    await assert.rejects(runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK,
        commandSource: 'targeted-test', command: f.command, preflightPath: f.preflightPath,
        selectedCases: [{ source: SOURCE, case_id: CASE, selector: 'not-in-argv' }] }), /selector.*absent/u);
    const execution = f.obligations[0].case_execution!;
    const before = fs.readFileSync(path.join(f.repoRoot, SOURCE));
    fs.unlinkSync(path.join(f.repoRoot, SOURCE)); fs.writeFileSync(path.join(f.repoRoot, SOURCE), before);
    assert.throws(() => readNativeCaseObligations({ repoRoot: f.repoRoot, taskId: TASK,
        preflightPath: f.preflightPath, preflightSha256: f.preflightSha256,
        scopeContentSha256: f.preflight.metrics.scope_content_sha256, sources: f.sources }), /execution|source|identity/u);
    const record = JSON.parse(fs.readFileSync(execution.record_path, 'utf8'));
    assert.equal(record.exit_code, 0);
    assert.equal(record.status, 'PASSED');
    assert.ok(fs.readFileSync(execution.output_path, 'utf8').includes(XML));
});

test('binds each case to its latest matching native execution and preserves unrelated successful cases after failure', async t => {
    const f = await fixture(false, true);
    t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const firstRecord = f.obligations[0].case_execution!.record_path;
    const second = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK,
        commandSource: 'targeted-test', command: `node ${SECOND_SOURCE} --select ${SECOND_CASE}`,
        preflightPath: f.preflightPath });
    assert.equal(second.exitCode, 0, second.outputLines.join('\n'));
    const secondSource = { source_identity: readValidationFile(f.repoRoot, SECOND_SOURCE).identity,
        case_id: SECOND_CASE, selector: SECOND_CASE, syntax_status: 'UNRESOLVED' as const };
    const read = (sources = [...f.sources, secondSource]) => readNativeCaseObligations({
        repoRoot: f.repoRoot, taskId: TASK, preflightPath: f.preflightPath,
        preflightSha256: f.preflightSha256, scopeContentSha256: f.preflight.metrics.scope_content_sha256, sources });
    const obligations = read();
    assert.equal(obligations[0].case_execution!.record_path, firstRecord);
    assert.notEqual(obligations[1].case_execution!.record_path, firstRecord);
    const entries = obligations.map((binding, index) => ({
        obligation_id: `VALIDATION-${binding.id.toUpperCase()}`, case_resolution: {
            binding_sha256: validationDigest(binding), execution_sha256: binding.case_execution!.record_sha256,
            output_sha256: binding.case_execution!.output_sha256, outcome: 'PASSED',
            evidence_quote: index === 0 ? XML : SECOND_XML,
            reasoning: 'The exact selected source and case assertion completed in its own retained native invocation.'
        }
    }));
    assert.deepEqual(getNativeCaseResolutionViolations({ repoRoot: f.repoRoot, obligations, entries,
        requirePassed: true }), []);
    const failed = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK,
        commandSource: 'targeted-test', command: `node ${SOURCE} --select invalid-selection`,
        preflightPath: f.preflightPath });
    assert.notEqual(failed.exitCode, 0);
    const timeline = fs.readFileSync(path.join(f.repoRoot,
        `garda-agent-orchestrator/runtime/task-events/${TASK}.jsonl`), 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line));
    const failure = timeline.at(-1);
    assert.equal(failure.event_type, 'INTERMEDIATE_COMMAND_RUN');
    assert.equal(failure.details.exit_code, 1);
    assert.equal(failure.details.command, `node ${SOURCE} --select invalid-selection`);
    assert.equal(read([secondSource])[0].case_execution!.record_path, obligations[1].case_execution!.record_path);
    assert.throws(() => read(f.sources), /latest|failed|successful|execution/iu);
});

test('rejects forged and changed native case evidence for opaque XML and Unicode sources', async t => {
    const f = await fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    assert.equal(f.obligations.length, 1);
    const binding = f.obligations[0], execution = binding.case_execution!;
    assert.equal(binding.result_status, 'UNRESOLVED');
    const projected = buildNativeCaseReviewCoverageContract({ ...f, reviewType: 'test' });
    assert.deepEqual(projected.contract.obligations.find(item => item.kind === 'validation')?.validation_binding, binding);
    assert.throws(() => buildNativeCaseReviewCoverageContract({ ...f, reviewType: 'test',
        preflight: { ...f.preflight, changed_files: [] } }), /actual retained classification/u);
    // In-memory resolution input only; this is not a delegated review or accepted task receipt.
    const resolution = { binding_sha256: validationDigest(binding), execution_sha256: execution.record_sha256,
        output_sha256: execution.output_sha256, outcome: 'PASSED', evidence_quote: XML,
        reasoning: 'The retained XML identifies the exact selected case after its actual empty-payment assertion ran.' };
    const inspect = (case_resolution: unknown) => getNativeCaseResolutionViolations({ repoRoot: f.repoRoot,
        obligations: f.obligations, entries: [{ obligation_id: `VALIDATION-${binding.id.toUpperCase()}`, case_resolution }], requirePassed: true });
    assert.deepEqual(inspect(resolution), []);
    for (const outcome of [['PASSED'], { toString: null }]) {
        assert.notEqual(getNativeCaseResolutionViolations({ repoRoot: f.repoRoot, obligations: f.obligations,
            entries: [{ obligation_id: `VALIDATION-${binding.id.toUpperCase()}`,
                case_resolution: { ...resolution, outcome } }] }).length, 0);
    }
    const hash = 'e'.repeat(64), contract = projected.contract;
    const reviewExecution = buildReviewRemediationReviewContract({ taskId: TASK, reviewType: 'test',
        preflightSha256: f.preflightSha256, fullReviewScope: projected.changedFiles });
    // A complete validator input backed by the actual process, not a reviewer receipt.
    const report = JSON.parse(buildReviewerFindingsOutputTemplateJson({ taskId: TASK, reviewType: 'test',
        reviewContextSha256: hash, treeStateSha256: hash, coverageContract: contract,
        reviewExecutionContract: reviewExecution }));
    const evidence = [{ location: `${SOURCE}:1`, observation: 'Inspected the selected empty-payment assertion and actual retained XML.' }];
    report.validation_notes = [{ id: 'N-001', topic: 'complete-scope-sweep',
        note: 'Complete native-case report validator input; no delegated acceptance is claimed.', evidence }];
    report.coverage_ledger.entries = contract.obligations.map(item => ({ obligation_id: item.id, evidence,
        finding_ids: [], ...(item.kind === 'validation' ? { case_resolution: resolution } : {}) }));
    report.reviewer_notes = ['Validator input only; no task verdict or native receipt.'];
    const validateReport = (value: unknown) => validateReviewFindingsReport(value, { repoRoot: f.repoRoot,
        expectedTaskId: TASK, expectedReviewType: 'test', expectedCoverageContract: contract,
        expectedCoverageObligationIds: contract.obligations.map(item => item.id),
        expectedChangedFilePaths: projected.changedFiles, expectedReviewContextSha256: hash,
        expectedTreeStateSha256: hash, expectedReviewExecutionContract: reviewExecution });
    const accepted = validateReport(report);
    assert.equal(accepted.valid, true, accepted.violations.join('\n'));
    for (const quote of ['invented result', 'x'.repeat(4097), '😀'.repeat(4097)]) {
        const rejectedReport = structuredClone(report);
        const entry = rejectedReport.coverage_ledger.entries.find((item: { case_resolution?: unknown }) => item.case_resolution);
        entry.case_resolution.evidence_quote = quote;
        const rejected = validateReviewFindingsContract({ content: JSON.stringify(rejectedReport), repoRoot: f.repoRoot,
            expectedTaskId: TASK, expectedReviewType: 'test', coverageContract: contract,
            expectedReviewContextSha256: hash, expectedTreeStateSha256: hash,
            expectedReviewExecutionContract: reviewExecution });
        assert.equal(rejected.valid, false);
        if (quote === 'invented result') {
            const violations = rejected.violations.filter(item => item.includes('quotation is absent'));
            assert.equal(violations.length, 1, rejected.violations.join('\n'));
            const diagnostic = classifyReviewOutputCorrectionDiagnostics(violations)[0];
            assert.equal(diagnostic.code, 'EVIDENCE_QUOTE_NOT_FOUND');
            assert.match(diagnostic.message, /one contiguous excerpt/u);
            assert.equal(diagnostic.mechanically_correctable, false);
            assert.equal(diagnostic.category, 'semantic');
        } else {
            assert.ok(rejected.violations.some(item => /evidence_quote.*4097.*4096/u.test(item)), rejected.violations.join('\n'));
        }
    }
    assert.equal(validateReport({ ...report, outcome: 'PASSED' }).valid, false);
    assert.equal(validateReport({ ...report, reviewer_notes: [{ outcome: 'PASSED' }] }).valid, false);
    const foreignResolution = structuredClone(report);
    foreignResolution.coverage_ledger.entries[0].case_resolution = resolution;
    assert.equal(validateReport(foreignResolution).valid, false);
    assert.notEqual(getNativeCaseResolutionViolations({ obligations: f.obligations,
        entries: [{ obligation_id: `VALIDATION-${binding.id.toUpperCase()}`, case_resolution: resolution }],
        requirePassed: true }).length, 0);
    const nativeFs = require('node:fs') as typeof fs;
    const originalRead = nativeFs.readSync;
    let reads = 0;
    const spy = t.mock.method(nativeFs, 'readSync', (...args: unknown[]) => {
        reads += 1; return Reflect.apply(originalRead, nativeFs, args);
    });
    inspect(resolution); const singleReads = reads; reads = 0;
    // Replicated constructor bindings measure batch I/O only, not twenty native cases or reviews.
    const replicas = Array.from({ length: 20 }, (_, index) => ({ ...binding, id: validationDigest([binding.id, index]) }));
    assert.deepEqual(getNativeCaseResolutionViolations({ repoRoot: f.repoRoot, obligations: replicas,
        entries: replicas.map(item => ({ obligation_id: `VALIDATION-${item.id.toUpperCase()}`,
            case_resolution: { ...resolution, binding_sha256: validationDigest(item) } })), requirePassed: true }), []);
    assert.ok(singleReads > 0); assert.equal(reads, singleReads);
    spy.mock.restore();
    assert.notEqual(inspect({ ...resolution, evidence_quote: 'invented result' }).length, 0);
    assert.notEqual(inspect({ ...resolution, binding_sha256: 'a'.repeat(64) }).length, 0);
    assert.notEqual(inspect({ ...resolution, outcome: 'SKIPPED' }).length, 0);
    const record = fs.readFileSync(execution.record_path);
    fs.appendFileSync(execution.record_path, '\nchanged record');
    assert.notEqual(inspect(resolution).length, 0);
    fs.writeFileSync(execution.record_path, record);
    fs.appendFileSync(path.join(f.repoRoot, SOURCE), '// changed source\n');
    assert.notEqual(inspect(resolution).length, 0);
});

test('rejects missing selected-case execution despite exit zero', async t => {
    const f = await fixture(true); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const binding = f.obligations[0], execution = binding.case_execution!;
    const result = getNativeCaseResolutionViolations({ repoRoot: f.repoRoot, obligations: f.obligations,
        entries: [{ obligation_id: `VALIDATION-${binding.id.toUpperCase()}`, case_resolution: {
            binding_sha256: validationDigest(binding), execution_sha256: execution.record_sha256,
            output_sha256: execution.output_sha256, outcome: 'UNRESOLVED', evidence_quote: '',
            reasoning: 'The process printed readiness only; the selected assertion was not executed.'
        } }], requirePassed: true });
    assert.ok(result.some(item => item.includes('UNRESOLVED')));
    assert.equal(binding.result_status, 'UNRESOLVED');
});
