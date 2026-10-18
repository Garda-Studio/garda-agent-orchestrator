import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import { buildReviewerFindingsPromptContractMarkdown, buildReviewerFindingsOutputTemplateJson } from '../../../../src/gates/review/reviewer-findings-prompt-contract';
import { validateReviewFindingsReport } from '../../../../src/gates/review/review-findings-schema';

test('generated residual-risk example matches the strict accepted element schema', () => {
    const coverage = buildReviewCoverageContract({ reviewType: 'code', changedFiles: ['src/example.ts'] });
    const options = { taskId: 'T-EXAMPLE', reviewType: 'code', reviewContextSha256: 'a'.repeat(64), treeStateSha256: 'b'.repeat(64), coverageContract: coverage };
    const prompt = buildReviewerFindingsPromptContractMarkdown(options);
    const encoded = prompt.match(/Residual risk object shape: (\{.+\})\. No severity/u)?.[1];
    assert.ok(encoded);
    const risk = JSON.parse(encoded.replace('<in-scope-file>:<line>', 'src/example.ts:1')
        .replace('<concrete remaining risk>', 'The remote service was unavailable during the retained check.')
        .replace('<observed evidence supporting this risk>', 'The recorded command reports connection refused.'));
    const report = JSON.parse(buildReviewerFindingsOutputTemplateJson(options));
    report.residual_risks = [risk];
    const validate = () => validateReviewFindingsReport(report, { expectedTaskId: options.taskId, expectedReviewType: options.reviewType,
        expectedCoverageObligationIds: coverage.obligations.map(item => item.id), allowStructuralOnlyReviewExecution: true });
    assert.deepEqual(validate().violations.filter(item => item.includes('residual_risks')), []);
    risk.severity = 'low';
    assert.ok(validate().violations.some(item => item.includes('residual_risks') && item.includes('severity')));
    assert.match(prompt, /Use \[\] when no risk remains/);
});
