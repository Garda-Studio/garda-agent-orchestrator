import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runClassifyChangeCommand, runIntermediateCommandCommand } from '../../../../src/cli/commands/gates';
import { readValidationFile, validationDigest } from '../../../../src/core/project-validation-identity';
import { readNativeCaseObligations, getNativeCaseResolutionViolations } from '../../../../src/gates/review/native-case-semantics';
import { buildNativeCaseReviewCoverageContract } from '../../../../src/gates/review-context/review-context-coverage';
import { validateReviewFindingsReport } from '../../../../src/gates/review/review-findings-schema';
import { buildReviewerFindingsOutputTemplateJson } from '../../../../src/gates/review/reviewer-findings-prompt-contract';
import { buildReviewRemediationReviewContract } from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode,
    runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, seedTaskQueue } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';

const TASK = 'T-NATIVE-CASE', SOURCE = 'custom/Кейс.case', CASE = 'Оплата::rejectsEmptyPayment';
const XML = `<результат случай="${CASE}">успех</результат>`;

async function fixture(missingCase = false) {
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, TASK); seedInitAnswers(repoRoot); initializeGitRepo(repoRoot);
    const entry = runEnterTaskMode({ repoRoot, taskId: TASK, entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2, taskSummary: 'Native case source and report', provider: 'Codex' });
    assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
    loadTaskEntryRulePack(repoRoot, TASK); runHandshakeForTask(repoRoot, TASK); runShellSmokeForTask(repoRoot, TASK);
    fs.mkdirSync(path.join(repoRoot, 'custom'));
    fs.writeFileSync(path.join(repoRoot, SOURCE), [
        "const assert = require('node:assert/strict');",
        "function pay(value) { if (!value) throw new Error('empty payment'); return value; }",
        "function rejectsEmptyPayment() { assert.throws(() => pay(''), /empty payment/); }",
        ...(missingCase ? ["console.log('runner ready');"] : [
            `assert.equal(process.argv.at(-1), ${JSON.stringify(CASE)});`,
            'rejectsEmptyPayment();', `console.log(${JSON.stringify(XML)});`
        ]), ''
    ].join('\n'));
    const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/native-preflight.json');
    const classified = runClassifyChangeCommand({ repoRoot, taskId: TASK, taskIntent: 'Native case source and report',
        changedFiles: [SOURCE], outputPath: preflightPath });
    assert.ok(fs.existsSync(preflightPath), classified.outputText);
    const preflightFile = fs.readFileSync(preflightPath);
    const preflight = JSON.parse(preflightFile.toString('utf8'));
    const result = await runIntermediateCommandCommand({ repoRoot, taskId: TASK, commandSource: 'targeted-test',
        command: `node ${SOURCE} --select ${CASE}`, preflightPath });
    assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
    const sources = [{ source_identity: readValidationFile(repoRoot, SOURCE).identity,
        case_id: CASE, selector: CASE, syntax_status: 'UNRESOLVED' as const }];
    const obligations = readNativeCaseObligations({ repoRoot, taskId: TASK, preflightPath,
        preflightSha256: validationDigest(preflightFile), scopeContentSha256: preflight.metrics.scope_content_sha256, sources });
    return { repoRoot, obligations, preflightPath, preflight, preflightSha256: validationDigest(preflightFile), sources };
}

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
