import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildReviewCoverageContract
} from '../../../../src/gates/review/review-coverage-ledger';
import {
    validateReviewFindingsContract,
    type ReviewFindingsContractValidationOptions
} from '../../../../src/gates/review/review-findings-artifact-verdict';
import {
    reviewFindingsReportJsonSchema
} from '../../../../src/gates/review/review-findings-schema';
import {
    buildReviewerFindingsOutputTemplateJson,
    buildReviewerFindingsPromptContractMarkdown
} from '../../../../src/gates/review/reviewer-findings-prompt-contract';
import {
    buildReviewRemediationReviewContract
} from '../../../../src/gates/review-remediation/review-remediation-review-contract';

const TASK_ID = 'T-969-3';
const CONTEXT_HASH = 'a'.repeat(64);
const TREE_HASH = 'b'.repeat(64);
const PREFLIGHT_HASH = 'c'.repeat(64);

function createReviewFixture(changedFiles: string[] = [], reviewType = 'code') {
    const coverageContract = buildReviewCoverageContract({ reviewType, changedFiles });
    const reviewExecutionContract = buildReviewRemediationReviewContract({
        taskId: TASK_ID,
        reviewType,
        preflightSha256: PREFLIGHT_HASH,
        fullReviewScope: changedFiles
    });
    const templateOptions = {
        taskId: TASK_ID,
        reviewType,
        reviewContextSha256: CONTEXT_HASH,
        treeStateSha256: TREE_HASH,
        coverageContract,
        reviewExecutionContract
    };
    const report = JSON.parse(buildReviewerFindingsOutputTemplateJson(templateOptions));
    report.validation_notes = [{
        id: 'N-001',
        topic: 'empty-scope-review',
        note: 'The authenticated source scope is empty; supporting records were inspected without claiming source coverage.',
        evidence: []
    }];
    report.coverage_ledger.entries = [];
    report.reviewer_notes = [];
    const authority: Omit<ReviewFindingsContractValidationOptions, 'content'> = {
        expectedTaskId: TASK_ID,
        expectedReviewType: reviewType,
        expectedReviewContextSha256: CONTEXT_HASH,
        expectedTreeStateSha256: TREE_HASH,
        coverageContract,
        expectedReviewExecutionContract: reviewExecutionContract
    };
    return {
        coverageContract,
        reviewExecutionContract,
        templateOptions,
        report,
        validate(overrides: Partial<ReviewFindingsContractValidationOptions> = {}) {
            return validateReviewFindingsContract({
                ...authority,
                content: JSON.stringify(report),
                ...overrides
            });
        }
    };
}

for (const reviewType of ['code', 'refactor', 'api', 'test', 'security', 'db', 'performance', 'infra', 'dependency']) {
    test(`empty ${reviewType} scope has no source coverage obligations`, () => {
        const contract = buildReviewCoverageContract({ reviewType, changedFiles: [] });
        assert.equal(contract.required, false);
        assert.equal(contract.obligation_count, 0);
        assert.deepEqual(contract.obligations, []);
        assert.match(contract.contract_sha256, /^[a-f0-9]{64}$/u);
    });
}

test('authenticated empty scope accepts an observation without invented location evidence', () => {
    const fixture = createReviewFixture();
    const result = fixture.validate();
    assert.equal(result.valid, true, result.violations.join('\n'));
    assert.deepEqual(result.report?.validation_notes[0].evidence, []);
    assert.equal(result.coverage_validation?.status, 'PASS');
    assert.equal(result.coverage_validation?.required, false);
    assert.equal(result.coverage_validation?.obligation_count, 0);
    assert.equal(result.coverage_validation?.completed_obligation_count, 0);
});

test('empty scope handoff provides a truthful template and no changed-file placeholders', () => {
    const fixture = createReviewFixture();
    const templateText = buildReviewerFindingsOutputTemplateJson(fixture.templateOptions);
    const template = JSON.parse(templateText);
    assert.equal(template.validation_notes[0].topic, 'empty-scope-review');
    assert.deepEqual(template.validation_notes[0].evidence, []);
    assert.deepEqual(template.coverage_ledger.entries, []);
    assert.doesNotMatch(templateText, /<changed-file>/u);
    const prompt = buildReviewerFindingsPromptContractMarkdown(fixture.templateOptions);
    assert.match(prompt, /authenticated.*empty|empty.*authenticated/iu);
    assert.match(prompt, /no source coverage|do not claim source coverage/iu);
    assert.doesNotMatch(prompt, /Fill every coverage_ledger.entries item with concrete path:line evidence/u);
});

for (const field of ['expectedReviewContextSha256', 'expectedTreeStateSha256', 'expectedReviewExecutionContract', 'coverageContract'] as const) {
    test(`empty evidence stays fail-closed without ${field} authority`, () => {
        const result = createReviewFixture().validate({ [field]: undefined });
        assert.equal(result.valid, false);
        assert.ok(result.violations.length > 0);
    });
}

test('nonempty authenticated execution scope rejects empty coverage authority', () => {
    const fixture = createReviewFixture();
    const nonemptyExecution = buildReviewRemediationReviewContract({
        taskId: TASK_ID,
        reviewType: 'code',
        preflightSha256: PREFLIGHT_HASH,
        fullReviewScope: ['src/unchanged.ts']
    });
    fixture.report.review_execution.contract_sha256 = nonemptyExecution.contract_sha256;
    assert.equal(fixture.validate({ expectedReviewExecutionContract: nonemptyExecution }).valid, false);
});

test('empty scope rejects supporting artifacts as location evidence', () => {
    const fixture = createReviewFixture();
    fixture.report.validation_notes[0].evidence = [{
        location: 'garda-agent-orchestrator/runtime/reviews/T-969-3-compile-gate.json:1',
        observation: 'The compile record reports a successful check.'
    }];
    const result = fixture.validate();
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('outside the code review evidence domain')));
});

test('empty scope rejects category coverage claims and a report-owned waiver', () => {
    const fixture = createReviewFixture();
    fixture.report.coverage_ledger.entries = [{
        obligation_id: 'CATEGORY-CORRECTNESS-EDGE-CASES',
        evidence: [],
        finding_ids: []
    }];
    assert.equal(fixture.validate().valid, false);
    fixture.report.coverage_ledger.entries = [];
    fixture.report.allow_empty_scope = true;
    assert.equal(fixture.validate().valid, false);
});

test('empty scope rejects findings, residual risks and focused command claims', () => {
    const fixture = createReviewFixture();
    fixture.report.findings.high = [{
        id: 'F-001', title: 'Unsubstantiated defect', description: 'No assigned source file supports this claim.',
        evidence: [], coverage_obligation_ids: []
    }];
    assert.equal(fixture.validate().valid, false);
    fixture.report.findings.high = [];
    fixture.report.residual_risks = [{ id: 'R-001', description: 'No assigned source evidence.', evidence: [] }];
    assert.equal(fixture.validate().valid, false);
    fixture.report.residual_risks = [];
    Object.assign(fixture.report.validation_notes[0], {
        topic: 'focused-self-validation', command: 'node --test tests/node/example.test.ts',
        command_outcome: 'passed', diagnostics: 'No assigned target authorizes this focused command.'
    });
    assert.equal(fixture.validate().valid, false);
});

test('empty scope requires a substantive note and exact task, context, tree and coverage bindings', () => {
    for (const mutate of [
        (report: any) => { report.validation_notes = []; },
        (report: any) => { report.validation_notes[0].note = ''; },
        (report: any) => { report.task_id = 'T-foreign'; },
        (report: any) => { report.review_context_sha256 = 'd'.repeat(64); },
        (report: any) => { report.tree_state_sha256 = 'd'.repeat(64); },
        (report: any) => { report.coverage_ledger.coverage_contract_sha256 = 'd'.repeat(64); },
        (report: any) => { report.review_execution.contract_sha256 = 'd'.repeat(64); }
    ]) {
        const fixture = createReviewFixture();
        mutate(fixture.report);
        assert.equal(fixture.validate().valid, false);
    }
});

test('nonempty scope rejects missing file, boundary and category evidence', () => {
    const fixture = createReviewFixture(['src/example.ts']);
    assert.equal(fixture.coverageContract.required, true);
    assert.ok(fixture.coverageContract.obligations.some((entry) => entry.kind === 'file'));
    assert.ok(fixture.coverageContract.obligations.some((entry) => entry.kind === 'boundary'));
    assert.ok(fixture.coverageContract.obligations.some((entry) => entry.kind === 'category'));
    const result = fixture.validate();
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('at least one concrete evidence item')));
    assert.ok(result.violations.some((entry) => entry.includes('Expected coverage obligation')));
});

test('structural schema permits empty observation evidence while source claims remain concrete', () => {
    const definitions = reviewFindingsReportJsonSchema.definitions;
    assert.equal(definitions.validation_note.properties.evidence.minItems, 0);
    assert.equal(definitions.coverage_entry.properties.evidence.minItems, 1);
    assert.equal(definitions.finding.properties.evidence.minItems, 1);
    assert.equal(definitions.residual_risk.properties.evidence.minItems, 1);
});
