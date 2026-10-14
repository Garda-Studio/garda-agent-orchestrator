import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspectQualityValidationPhases } from '../../../../src/gates/quality-checklist/quality-checklist-validation-phases';
import { getNativeCaseResolutionViolations } from '../../../../src/gates/review/native-case-semantics';
import { readValidationFile, validationDigest } from '../../../../src/core/project-validation-identity';
import { runClassifyChangeCommand, runIntermediateCommandCommand } from '../../../../src/cli/commands/gates';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { TRUST_BOUNDARY_ANALYSIS_RULE_ID } from '../../../../src/core/trust-boundary-analysis';
import { buildQualityChecklistAnswersTemplate } from '../../../../src/gates/quality-checklist';
import { runQualityChecklistCommand } from '../../../../src/cli/commands/gate-flows/quality-checklist/quality-checklist-flow';
import { readQualityValidationPhaseAnalysis, readReviewContextTrustBoundaryAnalysis } from '../../../../src/gates/review-context/review-context-trust-boundary-analysis';
import { buildDeclaredReviewCoverageContract } from '../../../../src/gates/review-context/review-context-coverage';
import { getValidationTerminalViolations } from '../../../../src/gates/review/validation-terminal';
import { resolveValidationSemanticReviewLanes, type EffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';
import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { executeValidationRecipe } from '../../../../src/gates/project-validation/execution';
import { evaluateValidationAttempt } from '../../../../src/gates/project-validation/result-evaluation';
import { readValidationReviewObligations } from '../../../../src/gates/review/validation-obligations';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode,
    runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, seedTaskQueue } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';
import { removeTempRepoWithRetry } from '../../cli/commands/gate-test-repo-bootstrap';
import { buildReviewCoverageAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary-review-coverage';
import { buildReviewRemediationReviewContract } from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import { writeSchema4ReviewPackage } from './review-execution-lineage-test-fixture';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { buildReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import { buildReviewFindingsDispositionArtifact } from '../../../../src/gates/review/review-findings-disposition-artifact';
import { resolveLockedReviewFindingPolicyFromPreflight } from '../../../../src/gates/review/review-finding-disposition';
import type { ReviewFindingsReport } from '../../../../src/gates/review/review-findings-schema';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { materializeReviewFindingsFollowUpTasks } from '../../../../src/gates/review/review-findings-follow-up-tasks';
import { checkRequiredReviews } from '../../../../src/gates/required-reviews/required-reviews-check-output';
import { collectRequiredReviewEvidence } from '../../../../src/gates/completion/completion-required-review-evidence';
import { parseCanonicalActiveTaskQueue, replaceTaskMdTableCell } from '../../../../src/core/task-md-table';

const TASK = 'T-UNIVERSAL-ORDINARY', SOURCE = 'unfamiliar/RootSuite.java', CASE = 'rejectsEmptyPayment';

function matrix(source = SOURCE) {
    return [{ boundary_id: 'TB-ORDINARY', boundary: 'Project case to native retained evidence',
        authority_source: 'Current native task and preflight source identity', mutable_inputs: ['project source and output'],
        integrity_evidence: ['current source and process/output SHA256'],
        canonical_reconstruction: 'Read the current contained source and genuine task-owned command evidence.',
        toctou_replay: 'Reject changed source or superseded invocation bindings.',
        negative_paths: [{ kind: 'other', scenario: 'Пустой платёж', expected_behavior: 'Отклонить пустой платёж.',
            evidence_files: [`${source}#${CASE}`] }] }];
}

function fixture(source = SOURCE, body = 'class RootSuite { void rejectsEmptyPayment() {} }\n', profile = 'default', perFindingFollowUps = false) {
    const repoRoot = createTempRepo(); seedTaskQueue(repoRoot, TASK, 'TODO', profile); seedInitAnswers(repoRoot);
    const configRoot = path.join(repoRoot, 'garda-agent-orchestrator/live/config');
    fs.mkdirSync(configRoot, { recursive: true });
    if (profile !== 'default') {
        const profiles = JSON.parse(fs.readFileSync(path.resolve('template/config/profiles.json'), 'utf8'));
        if (perFindingFollowUps) profiles.built_in_profiles[profile].review_follow_up_policy.materialization_mode = 'per_finding';
        fs.writeFileSync(path.join(configRoot, 'profiles.json'), JSON.stringify(profiles));
    }
    fs.writeFileSync(path.join(configRoot, 'workflow-config.json'), JSON.stringify(buildDefaultWorkflowConfig()));
    fs.mkdirSync(path.join(repoRoot, 'unfamiliar'));
    fs.writeFileSync(path.join(repoRoot, source), body);
    fs.mkdirSync(path.join(repoRoot, 'src/security'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src/security/payment.ts'), 'export const payment = 1;\n');
    initializeGitRepo(repoRoot);
    const entry = runEnterTaskMode({ repoRoot, taskId: TASK, entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2, taskSummary: 'Ordinary project validation', provider: 'Codex' });
    assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
    loadTaskEntryRulePack(repoRoot, TASK); runHandshakeForTask(repoRoot, TASK); runShellSmokeForTask(repoRoot, TASK);
    fs.appendFileSync(path.join(repoRoot, source), '// Current classified source.\n');
    fs.appendFileSync(path.join(repoRoot, 'src/security/payment.ts'), 'export const changed = 1;\n');
    const preflightPath = path.join(repoRoot, `garda-agent-orchestrator/runtime/reviews/${TASK}-preflight.json`);
    const classified = runClassifyChangeCommand({ repoRoot, taskId: TASK, taskIntent: 'Ordinary project validation',
        changedFiles: [source, 'src/security/payment.ts'], outputPath: preflightPath, emitMetrics: false });
    assert.ok(fs.existsSync(preflightPath), classified.outputText);
    const bytes = fs.readFileSync(preflightPath);
    return { repoRoot, taskId: TASK, preflightPath, preflight: JSON.parse(bytes.toString('utf8')),
        preflightSha256: readValidationFile(repoRoot, path.relative(repoRoot, preflightPath).replace(/\\/gu, '/')).identity.sha256 };
}

test('ordinary Java source binds without recipe declaration while execution remains pending', t => {
    const f = fixture(); t.after(() => removeTempRepoWithRetry(f.repoRoot));
    // This deliberately does not execute the case or claim its body is assertive.
    const observation = inspectQualityValidationPhases({ ...f, matrixRequired: true, matrix: matrix() });
    assert.ok(observation, 'Ordinary source obligations must not require a separate project_validation mode.');
    assert.equal(observation.phases.structural, 'BOUND');
    assert.equal(observation.phases.execution, 'PENDING');
    assert.equal(observation.phases.semantic, 'PENDING_INDEPENDENT_REVIEW');
});

test('ordinary opaque command reaches per-case review and terminal closure without recipe opt-in', async t => {
    const source = 'unfamiliar/RootSuite.case', quote = `<result case="${CASE}">passed</result>`;
    const f = fixture(source, "const assert = require('node:assert/strict');\n"
        + `assert.equal(process.argv.at(-1), ${JSON.stringify(CASE)});\n`
        + "assert.throws(() => { throw new Error('empty payment'); }, /empty payment/);\n"
        + `console.log(${JSON.stringify(quote)});\n`);
    t.after(() => removeTempRepoWithRetry(f.repoRoot));
    const publish = () => {
        const answers = buildQualityChecklistAnswersTemplate(f).answers.map(answer => ({ ...answer,
            status: 'PASS', answer: 'Inspected current scope.', ...(answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID
                ? { trust_boundary_matrix: matrix(source) } : {}) }));
        const result = runQualityChecklistCommand({ ...f, answersJson: JSON.stringify(answers), emitMetrics: false });
        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
    };
    publish();
    assert.equal(readQualityValidationPhaseAnalysis(f).validation_phases?.execution, 'PENDING');
    assert.equal(readReviewContextTrustBoundaryAnalysis(f).status, 'invalid');
    const execution = await runIntermediateCommandCommand({ ...f, commandSource: 'targeted-test',
        command: `node ${source} --select ${CASE}` });
    assert.equal(execution.exitCode, 0, execution.outputLines.join('\n'));
    publish();
    const analysis = readReviewContextTrustBoundaryAnalysis(f);
    assert.equal(analysis.status, 'current', analysis.violations.join('\n'));
    const lanes = resolveValidationSemanticReviewLanes(f.preflight.effective_review_snapshot as EffectiveReviewSnapshot);
    const artifacts: Record<string, { content: string; receipt: unknown }> = {};
    for (const reviewType of lanes) {
        const projection = buildDeclaredReviewCoverageContract({ ...f, reviewType });
        const target = projection.validationObligations?.[0]; assert.ok(target?.case_execution);
        assert.equal(target.result_status, 'UNRESOLVED');
        const resolution = { binding_sha256: validationDigest(target), execution_sha256: target.case_execution.record_sha256,
            output_sha256: target.case_execution.output_sha256, outcome: 'PASSED', evidence_quote: quote,
            reasoning: 'The genuine Node process executed the selected assertion and emitted this exact case result.' };
        // In-memory terminal-validator inputs, not real delegated reviews or native acceptance receipts.
        const hash = projection.contract.contract_sha256;
        artifacts[reviewType] = { content: JSON.stringify({ coverage_ledger: { coverage_contract_sha256: hash,
            entries: [{ obligation_id: `VALIDATION-${target.id.toUpperCase()}`, finding_ids: [], case_resolution: resolution }] },
            residual_risks: [] }), receipt: { review_coverage: { status: 'PASS', contract_sha256: hash } } };
    }
    const options = { ...f, requiredReviews: Object.fromEntries(lanes.map(lane => [lane, true])), artifacts };
    assert.deepEqual(getValidationTerminalViolations(options), []);
    const unresolved = structuredClone(artifacts);
    const report = JSON.parse(unresolved[lanes[0]].content);
    report.coverage_ledger.entries[0].case_resolution.outcome = 'UNRESOLVED';
    unresolved[lanes[0]].content = JSON.stringify(report);
    assert.ok(getValidationTerminalViolations({ ...options, artifacts: unresolved }).some(item => item.includes('UNRESOLVED')));
    assert.ok(getValidationTerminalViolations({ ...options, skipReviews: [lanes[0]] }).length > 0);
    const sourcePath = path.join(f.repoRoot, source), originalSource = fs.readFileSync(sourcePath);
    fs.appendFileSync(sourcePath, '// changed after evidence\n');
    const changedSourceViolations = getValidationTerminalViolations(options);
    assert.ok(changedSourceViolations.some(item => /source|preflight|scope/iu.test(item)),
        'Source mutation must reject the previously successful execution independently.');
    fs.writeFileSync(sourcePath, originalSource);
    assert.deepEqual(getValidationTerminalViolations(options), []);
    const failed = await runIntermediateCommandCommand({ ...f, commandSource: 'targeted-test',
        command: `node ${source} --select missing-case` });
    assert.equal(failed.exitCode, 1);
    assert.ok(getValidationTerminalViolations(options).length > 0, 'A newer failed command cannot retain the old green case.');
});

test('passed selected case preserves satisfied frozen follow-up disposition without admitting unresolved evidence', async t => {
    const source = 'unfamiliar/RootSuite.case', quote = `<result case="${CASE}">passed</result>`;
    const f = fixture(source, "const assert = require('node:assert/strict');\n"
        + `assert.equal(process.argv.at(-1), ${JSON.stringify(CASE)});\n`
        + `console.log(${JSON.stringify(quote)});\n`, 'balanced');
    t.after(() => removeTempRepoWithRetry(f.repoRoot));
    const publish = () => {
        const answers = buildQualityChecklistAnswersTemplate(f).answers.map(answer => ({ ...answer, status: 'PASS',
            answer: 'Isolated constructor regression retains the source, execution and frozen disposition separately.',
            ...(answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID ? { trust_boundary_matrix: matrix(source) } : {}) }));
        const result = runQualityChecklistCommand({ ...f, answersJson: JSON.stringify(answers), emitMetrics: false });
        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
    };
    publish();
    const execution = await runIntermediateCommandCommand({ ...f, commandSource: 'targeted-test',
        command: `node ${source} --select ${CASE}` });
    assert.equal(execution.exitCode, 0, execution.outputLines.join('\n'));
    publish();
    const lanes = resolveValidationSemanticReviewLanes(f.preflight.effective_review_snapshot as EffectiveReviewSnapshot);
    const artifacts: Record<string, { content: string; receipt: unknown }> = {};
    const dispositionEvidence: Record<string, { valid: boolean; artifact: ReturnType<typeof buildReviewFindingsDispositionArtifact>;
        artifact_sha256: string; follow_up_artifact_path: string; violations: string[] }> = {};
    for (const reviewType of lanes) {
        const projection = buildDeclaredReviewCoverageContract({ ...f, reviewType });
        const target = projection.validationObligations?.[0]; assert.ok(target?.case_execution);
        const id = `VALIDATION-${target.id.toUpperCase()}`, hash = projection.contract.contract_sha256;
        const report: ReviewFindingsReport = { schema_version: 2, task_id: f.taskId, review_type: reviewType,
            review_context_sha256: hash, tree_state_sha256: hash, validation_notes: [], reviewer_notes: [],
            coverage_ledger: { coverage_contract_sha256: hash, entries: [{ obligation_id: id, finding_ids: ['F-001'],
                evidence: [{ location: `${source}:1`, observation: 'Unit case retains the genuine selected execution.' }],
                case_resolution: { binding_sha256: validationDigest(target), execution_sha256: target.case_execution.record_sha256,
                    output_sha256: target.case_execution.output_sha256, outcome: 'PASSED', evidence_quote: quote,
                    reasoning: 'The actual retained process output matches the selected successful assertion.' } }] },
            findings: { critical: [], high: [], medium: [], low: [{ id: 'F-001', title: 'Unit nonblocking note',
                description: 'Constructor-only low finding with the existing frozen follow-up action.',
                evidence: [{ location: 'src/security/payment.ts:1', observation: 'Unit finding inside the assigned source domain.' }],
                coverage_obligation_ids: [id] }] }, residual_risks: [] };
        // Unit constructor inputs model an already validated disposition result; they are not real reviewer or follow-up receipts.
        const validation = buildReviewFindingsValidationArtifact({ taskId: f.taskId, reviewType, coverageContract: projection.contract,
            reviewArtifactPath: 'unit/review.md', reviewArtifactSha256: hash, reviewContextPath: 'unit/context.json',
            reviewContextSha256: hash, reviewTreeStateSha256: hash, preflightPath: f.preflightPath,
            preflightSha256: f.preflightSha256, scopeSha256: hash, reviewScopeSha256: hash,
            validation: { detected: true, valid: true, violations: [], coverage_validation: null, report } });
        const disposition = buildReviewFindingsDispositionArtifact({ taskId: f.taskId, reviewType, validationArtifact: validation,
            validationArtifactSha256: sha256RedactedJsonPayload(validation), policyResolution: resolveLockedReviewFindingPolicyFromPreflight(f.preflight) });
        assert.equal(disposition.items[0].action, 'create_follow_up');
        artifacts[reviewType] = { content: JSON.stringify(report), receipt: { review_coverage: { status: 'PASS', contract_sha256: hash } } };
        dispositionEvidence[reviewType] = { valid: true, artifact: disposition, artifact_sha256: sha256RedactedJsonPayload(disposition),
            follow_up_artifact_path: 'unit/satisfied-follow-up.json', violations: [] };
    }
    const options = { ...f, requiredReviews: Object.fromEntries(lanes.map(lane => [lane, true])), artifacts, dispositionEvidence };
    assert.deepEqual(getValidationTerminalViolations(options), [], 'A passed case and satisfied frozen follow-up cannot contradict each other.');
    const missing = { ...options, dispositionEvidence: {} };
    assert.ok(getValidationTerminalViolations(missing).length > 0, 'Raw receipt claims cannot replace checked disposition evidence.');
    const invalid = structuredClone(dispositionEvidence);
    invalid[lanes[0]].valid = false;
    assert.ok(getValidationTerminalViolations({ ...options, dispositionEvidence: invalid }).length > 0);
    const changed = structuredClone(dispositionEvidence);
    changed[lanes[0]].artifact.task_id = 'T-FOREIGN';
    changed[lanes[0]].artifact_sha256 = sha256RedactedJsonPayload(changed[lanes[0]].artifact);
    assert.ok(getValidationTerminalViolations({ ...options, dispositionEvidence: changed }).length > 0);
    const fixNow = structuredClone(dispositionEvidence);
    fixNow[lanes[0]].artifact.items[0].action = 'fix_now';
    fixNow[lanes[0]].artifact_sha256 = sha256RedactedJsonPayload(fixNow[lanes[0]].artifact);
    assert.ok(getValidationTerminalViolations({ ...options, dispositionEvidence: fixNow }).length > 0);
    const unresolved = structuredClone(artifacts), report = JSON.parse(unresolved[lanes[0]].content);
    report.coverage_ledger.entries[0].case_resolution.outcome = 'UNRESOLVED';
    unresolved[lanes[0]].content = JSON.stringify(report);
    assert.ok(getValidationTerminalViolations({ ...options, artifacts: unresolved }).some(item => item.includes('UNRESOLVED')));
    report.coverage_ledger.entries[0].case_resolution.outcome = 'FAILED';
    unresolved[lanes[0]].content = JSON.stringify(report);
    assert.ok(getValidationTerminalViolations({ ...options, artifacts: unresolved }).some(item => item.includes('FAILED')));
});

test('materialized frozen follow-up closes each gate consumer and missing proof rejects them', async t => {
    const source = 'unfamiliar/RootSuite.case', quote = `<result case="${CASE}">passed</result>`;
    const f = fixture(source, `console.log(${JSON.stringify(quote)});\n`, 'balanced', true);
    t.after(() => removeTempRepoWithRetry(f.repoRoot));
    const publish = () => {
        const answers = buildQualityChecklistAnswersTemplate(f).answers.map(answer => ({ ...answer, status: 'PASS',
            answer: 'Unit consumer integration retains actual selected execution and canonical follow-up evidence.',
            ...(answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID ? { trust_boundary_matrix: matrix(source) } : {}) }));
        const result = runQualityChecklistCommand({ ...f, answersJson: JSON.stringify(answers), emitMetrics: false });
        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
    };
    publish();
    const execution = await runIntermediateCommandCommand({ ...f, commandSource: 'targeted-test', command: `node ${source} --select ${CASE}` });
    assert.equal(execution.exitCode, 0, execution.outputLines.join('\n'));
    publish();
    const orchestratorRoot = path.join(f.repoRoot, 'garda-agent-orchestrator'), reviewsRoot = path.join(orchestratorRoot, 'runtime/reviews');
    const lanes = resolveValidationSemanticReviewLanes(f.preflight.effective_review_snapshot as EffectiveReviewSnapshot);
    const requiredReviews = Object.fromEntries(lanes.map(lane => [lane, true]));
    const packages: Record<string, ReturnType<typeof writeSchema4ReviewPackage>> = {};
    const followUps: string[] = [];
    // These schema-4 packages are isolated unit fixtures, never real root delegation or acceptance evidence.
    for (const reviewType of lanes) {
        const coverage = buildDeclaredReviewCoverageContract({ ...f, reviewType });
        const targets = coverage.validationObligations!;
        const caseResolutions = Object.fromEntries(targets.map(target => [`VALIDATION-${target.id.toUpperCase()}`, {
            binding_sha256: validationDigest(target), execution_sha256: target.case_execution!.record_sha256,
            output_sha256: target.case_execution!.output_sha256, outcome: 'PASSED' as const,
            evidence_quote: quote, reasoning: 'The actual retained unit command reports the selected successful case.'
        }]));
        packages[reviewType] = writeSchema4ReviewPackage({ ...f, reviewsRoot, reviewType, coverageContract: coverage.contract,
            caseResolutions, evidenceFile: source, lowFindings: ['Recorded nonblocking unit finding.'],
            findingObligationId: `VALIDATION-${targets[0].id.toUpperCase()}`, withDispositionEvidence: true,
            reviewExecution: buildReviewRemediationReviewContract({ taskId: f.taskId, reviewType,
                preflightSha256: f.preflightSha256, fullReviewScope: coverage.changedFiles }) });
        const materialized = materializeReviewFindingsFollowUpTasks({ ...f, reviewType, reviewsRoot });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        followUps.push(materialized.artifact_path);
    }
    const reviewEvidencePath = path.join(reviewsRoot, `${f.taskId}-review-gate.json`);
    fs.writeFileSync(reviewEvidencePath, JSON.stringify({ task_id: f.taskId, status: 'PASSED', outcome: 'PASS' }));
    const reviewViolations = () => checkRequiredReviews({ repoRoot: f.repoRoot, preflightPayload: f.preflight,
        validatedPreflight: { errors: [], resolved_task_id: f.taskId, required_reviews: requiredReviews,
            preflight_path: f.preflightPath, preflight_hash: f.preflightSha256 },
        verdicts: Object.fromEntries(lanes.map(lane => [lane, lane === 'test' ? 'TEST REVIEW PASSED' : 'REVIEW PASSED'])),
        sourceOfTruth: 'Codex', canonicalSourceOfTruth: 'Codex', executionProvider: 'Codex',
        reviewArtifacts: Object.fromEntries(lanes.map(lane => { const p = packages[lane]; return [lane, {
            path: p.artifactPath, content: fs.readFileSync(p.artifactPath, 'utf8'), reviewContextPath: p.contextPath,
            reviewContext: p.context, reviewContextSha256: p.contextSha256, artifactSha256: p.artifactSha256,
            receipt: JSON.parse(fs.readFileSync(p.receiptPath, 'utf8'))
        }]; })) }).violations;
    const completionViolations = () => {
        const errors: string[] = [];
        collectRequiredReviewEvidence({ ...f, reviewsRoot, reviewEvidencePath, requiredReviews,
            scopeCategory: 'mixed', orderedEvents: [], errors });
        return errors;
    };
    const audit = () => buildReviewCoverageAuditSummary({ reviewsRoot, taskId: f.taskId, requiredReviews });
    const terminalErrors = (errors: string[]) => errors.filter(error => error.includes('Declared validation terminal'));
    // Synthetic unit provenance can produce unrelated trust diagnostics; the changed consumer boundary is asserted independently.
    assert.deepEqual(terminalErrors(reviewViolations()), [], 'Required-review consumer must forward actual canonical dispositions.');
    assert.deepEqual(terminalErrors(completionViolations()), [], 'Completion consumer must forward actual canonical dispositions.');
    assert.equal(audit().status, 'COMPLETE', JSON.stringify(audit()));
    const proof = fs.readFileSync(followUps[0]);
    fs.writeFileSync(followUps[0], '{}\n');
    assert.ok(terminalErrors(reviewViolations()).length > 0, 'Mismatched materialization must reject required-review closure.');
    assert.ok(terminalErrors(completionViolations()).length > 0, 'Mismatched materialization must reject completion closure.');
    assert.equal(audit().status, 'INCOMPLETE');
    fs.writeFileSync(followUps[0], proof);
    assert.deepEqual(terminalErrors(reviewViolations()), []);
    assert.deepEqual(terminalErrors(completionViolations()), []);
    assert.equal(audit().status, 'COMPLETE');
    // Simulate only the unit lifecycle status, preserving actual materialized F-task rows and parent links.
    const queuePath = path.join(f.repoRoot, 'TASK.md'), queue = fs.readFileSync(queuePath, 'utf8');
    const parent = parseCanonicalActiveTaskQueue(queue).rows.find(row => row.taskId === f.taskId);
    assert.ok(parent);
    const doneRow = replaceTaskMdTableCell(parent.rawLine, 1, ' 🟩 DONE '); assert.ok(doneRow);
    fs.writeFileSync(queuePath, queue.replace(parent.rawLine, doneRow));
    appendMandatoryTaskEvent(orchestratorRoot, f.taskId, 'COMPLETION_GATE_PASSED', 'PASS',
        'Retained follow-up consumer unit fixture.', { status: 'PASSED', outcome: 'PASS', preflight_path: f.preflightPath, violations: [] });
    assert.equal(audit().status, 'COMPLETE', 'Retained completed audit must retain the same materialized evidence.');
    fs.unlinkSync(followUps[0]);
    assert.equal(audit().status, 'INCOMPLETE', 'Missing proof must reject the retained completed audit too.');
    fs.writeFileSync(followUps[0], proof);
});

test('retains ordinary semantic reports in active and completed coverage audit without a declaration', async t => {
    const source = 'unfamiliar/RootSuite.case', quote = `<result case="${CASE}">passed</result>`;
    const f = fixture(source, `console.log(${JSON.stringify(quote)});\n`);
    t.after(() => removeTempRepoWithRetry(f.repoRoot));
    const execution = await runIntermediateCommandCommand({ ...f, commandSource: 'targeted-test',
        command: `node ${source} --select ${CASE}` });
    assert.equal(execution.exitCode, 0, execution.outputLines.join('\n'));
    const answers = buildQualityChecklistAnswersTemplate(f).answers.map(answer => ({ ...answer,
        status: 'PASS', answer: 'Inspected current scope.', ...(answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID
            ? { trust_boundary_matrix: matrix(source) } : {}) }));
    const published = runQualityChecklistCommand({ ...f, answersJson: JSON.stringify(answers), emitMetrics: false });
    assert.equal(published.exitCode, 0, published.outputLines.join('\n'));
    assert.equal(f.preflight.project_validation, undefined);
    const orchestratorRoot = path.join(f.repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(orchestratorRoot, 'runtime/reviews');
    const lanes = resolveValidationSemanticReviewLanes(f.preflight.effective_review_snapshot as EffectiveReviewSnapshot);
    assert.ok(lanes.length > 0, 'The fixture must retain actual selected semantic review lanes.');
    const requiredReviews = Object.fromEntries(lanes.map(lane => [lane, true]));
    // Schema-4 reports are isolated unit fixtures, not genuine delegated acceptance receipts.
    for (const reviewType of lanes) {
        const coverage = buildDeclaredReviewCoverageContract({ ...f, reviewType });
        const caseResolutions = Object.fromEntries(coverage.validationObligations!.map(target => [
            `VALIDATION-${target.id.toUpperCase()}`, {
                binding_sha256: validationDigest(target), execution_sha256: target.case_execution!.record_sha256,
                output_sha256: target.case_execution!.output_sha256, outcome: 'PASSED' as const,
                evidence_quote: quote, reasoning: 'The exact selected fixture case is present in current retained output.'
            }
        ]));
        writeSchema4ReviewPackage({ ...f, reviewsRoot, reviewType, coverageContract: coverage.contract, caseResolutions,
            evidenceFile: 'src/security/payment.ts', reviewExecution: buildReviewRemediationReviewContract({
                taskId: f.taskId, reviewType, preflightSha256: f.preflightSha256, fullReviewScope: coverage.changedFiles
            }) });
    }
    const audit = () => buildReviewCoverageAuditSummary({ reviewsRoot, taskId: f.taskId, requiredReviews });
    const active = audit();
    assert.equal(active.status, 'COMPLETE', JSON.stringify(active));
    seedTaskQueue(f.repoRoot, f.taskId, 'DONE', 'default', '', 'Ordinary retained audit unit fixture');
    appendMandatoryTaskEvent(orchestratorRoot, f.taskId, 'COMPLETION_GATE_PASSED', 'PASS',
        'Ordinary retained audit unit fixture.', { status: 'PASSED', outcome: 'PASS', preflight_path: f.preflightPath, violations: [] });
    const completed = audit();
    assert.equal(completed.status, 'COMPLETE', JSON.stringify(completed));
    fs.appendFileSync(path.join(f.repoRoot, source), '// Changed after closure.\n');
    assert.equal(audit().status, 'INCOMPLETE', 'Retained inspection must still reject changed source evidence.');
});

test('native Unicode quotation and reasoning limits match their published character bounds', () => {
    // Constructor validation only; these unit bindings are not execution or reviewer receipts.
    const binding = { id: 'a'.repeat(64), recipe_id: 'unit', target_id: 'unit', selector: 'unit',
        source_identity: { path: 'unit-source', sha256: 'b'.repeat(64), size: 1, identity: 'unit-only' },
        snapshot_sha256: 'c'.repeat(64), execution: 'OBSERVED' as const, attempt_id: 'unit-only',
        result_status: 'UNRESOLVED', result_sha256: null, case_execution: {
            record_path: 'unit-record', record_sha256: 'd'.repeat(64), output_path: 'unit-output',
            output_sha256: 'e'.repeat(64), output_size_bytes: 1, output_encoding: 'utf8' as const,
            event_task_sequence: 1, scope_content_sha256: 'f'.repeat(64) } };
    const resolution = { binding_sha256: validationDigest(binding), execution_sha256: binding.case_execution.record_sha256,
        output_sha256: binding.case_execution.output_sha256, outcome: 'UNRESOLVED',
        evidence_quote: '😀'.repeat(4096), reasoning: '😀'.repeat(8192) };
    const inspect = (value: typeof resolution) => getNativeCaseResolutionViolations({ obligations: [binding],
        entries: [{ obligation_id: `VALIDATION-${binding.id.toUpperCase()}`, case_resolution: value }] });
    assert.deepEqual(inspect(resolution), [], 'Published Unicode bounds count supplementary characters once.');
    assert.ok(inspect({ ...resolution, evidence_quote: '😀'.repeat(4097) }).length > 0);
    assert.ok(inspect({ ...resolution, reasoning: '😀'.repeat(8193) }).length > 0);
    assert.deepEqual(inspect({ ...resolution, reasoning: '😀' }), []);
    assert.ok(inspect({ ...resolution, reasoning: ' ' }).length > 0);
});

test('targetless compile keeps actual compiler facts without fabricated case obligations', async t => {
    const repoRoot = createTempRepo(), taskId = 'T-TARGETLESS-COMPILE', source = 'src/domain/product.cjs';
    t.after(() => removeTempRepoWithRetry(repoRoot));
    seedTaskQueue(repoRoot, taskId); seedInitAnswers(repoRoot);
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(buildDefaultWorkflowConfig()));
    fs.mkdirSync(path.dirname(path.join(repoRoot, source)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, source), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(repoRoot, 'recipes.json'), JSON.stringify({ schema_version: 1, recipes: [{
        id: 'syntax', purpose: 'compile', executable: process.execPath, argv: ['--check', source],
        cwd: '.', environment: {}, inputs: [{ path: source, role: 'source' }], targets: [],
        timeout_ms: 5000, max_attempts: 2, max_output_bytes: 1024, max_input_bytes: 65536,
        required_capabilities: [], result_format: 'opaque'
    }] }));
    initializeGitRepo(repoRoot);
    // These operator inputs belong to the isolated unit fixture, not the real workspace.
    handleWorkflow(['set', '--target-root', repoRoot, '--project-validation-contract', 'recipes.json',
        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()],
    { name: 'garda-agent-orchestrator', version: '1.0.0' });
    runEnterTaskMode({ repoRoot, taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Targetless compiler qualification', provider: 'Codex' });
    loadTaskEntryRulePack(repoRoot, taskId); runHandshakeForTask(repoRoot, taskId); runShellSmokeForTask(repoRoot, taskId);
    fs.writeFileSync(path.join(repoRoot, source), 'module.exports = 2;\n');
    const preflightPath = path.join(repoRoot, `garda-agent-orchestrator/runtime/reviews/${taskId}-preflight.json`);
    runClassifyChangeCommand({ repoRoot, taskId, taskIntent: 'Targetless compiler qualification',
        changedFiles: [source], outputPath: preflightPath, emitMetrics: false });
    const options = { repoRoot, taskId, preflightPath };
    const attempt = await executeValidationRecipe({ repoRoot, taskId, recipeId: 'syntax' });
    assert.equal(attempt.exit_code, 0);
    assert.equal((await evaluateValidationAttempt({ ...options, attemptId: attempt.attempt_id })).status, 'UNRESOLVED');
    const answers = buildQualityChecklistAnswersTemplate(options).answers.map(answer => ({
        ...answer, status: 'PASS', answer: 'Actual compiler execution remains separate from selected-case semantics.'
    }));
    const quality = runQualityChecklistCommand({ ...options, answersJson: JSON.stringify(answers), emitMetrics: false });
    assert.equal(quality.exitCode, 0, quality.outputLines.join('\n'));
    assert.deepEqual(readValidationReviewObligations(options).obligations, []);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    // Empty case obligations waive no ordinary required review or task completion gate.
    assert.deepEqual(getValidationTerminalViolations({ ...options, preflight,
        requiredReviews: preflight.required_reviews, artifacts: {} }), []);
    fs.writeFileSync(path.join(repoRoot, source), 'module.exports = ;\n');
    runClassifyChangeCommand({ repoRoot, taskId, taskIntent: 'Targetless compiler qualification',
        changedFiles: [source], outputPath: preflightPath, emitMetrics: false });
    const rejected = await executeValidationRecipe({ repoRoot, taskId, recipeId: 'syntax' });
    assert.notEqual(rejected.exit_code, 0);
    await evaluateValidationAttempt({ ...options, attemptId: rejected.attempt_id });
    runQualityChecklistCommand({ ...options, answersJson: JSON.stringify(answers), emitMetrics: false });
    const rejectedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    assert.ok(getValidationTerminalViolations({ ...options, preflight: rejectedPreflight,
        requiredReviews: rejectedPreflight.required_reviews, artifacts: {} }).length > 0);
});
