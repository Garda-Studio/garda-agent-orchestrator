import test from 'node:test';
import assert from 'node:assert/strict';
import { assessReviewRemediationScopeBoundary } from '../../../../../../src/gates/review-remediation/review-remediation-scope-boundary';
import { groupReviewRemediationFiles } from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-remediation-semantics';

test('remediation preserves exact declared source/test roles instead of inferring them from names', () => {
    const fileRoles = { 'specifications/purchase.case': 'test' as const, 'tests/processor.yaml': 'source' as const };
    const boundary = assessReviewRemediationScopeBoundary(['src/app.ts'],
        ['src/app.ts', ...Object.keys(fileRoles)], [], ['(^|/)tests/'], fileRoles);
    assert.equal(boundary.status, 'BLOCKED');
    assert.deepEqual(boundary.allowedTestOnlyExpansionFiles, ['specifications/purchase.case']);
    assert.deepEqual(boundary.expandedNonTestFiles, ['tests/processor.yaml']);
    assert.deepEqual(groupReviewRemediationFiles(Object.keys(fileRoles), ['(^|/)tests/'], fileRoles), {
        source: ['tests/processor.yaml'], test: ['specifications/purchase.case']
    });
});

process.env.GARDA_REVIEW_CYCLE_REMEDIATION_PART = 'scope-expansion';
require('./gates-review-cycle-remediation-suite');
