import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_REVIEW_TRIGGER_POLICY,
    normalizeReviewTriggerPolicyFromPaths,
    validateReviewTriggerPolicy
} from '../../../src/policy/review-trigger-policy';

test('preserves exact role declarations in the frozen review policy without changing legacy policy shape', () => {
    const policy = normalizeReviewTriggerPolicyFromPaths({ file_roles: {
        'src/view.mdx': 'source', 'specifications/purchase.case': 'test'
    } });
    assert.deepEqual(validateReviewTriggerPolicy(policy), policy);
    assert.deepEqual(policy.file_roles, { 'specifications/purchase.case': 'test', 'src/view.mdx': 'source' });
    assert.equal(Object.hasOwn(normalizeReviewTriggerPolicyFromPaths({}), 'file_roles'), false);
    assert.equal(Object.hasOwn(validateReviewTriggerPolicy(DEFAULT_REVIEW_TRIGGER_POLICY), 'file_roles'), false);
    assert.throws(() => normalizeReviewTriggerPolicyFromPaths({ file_roles: { '../source.md': 'source' } }));
    assert.throws(() => validateReviewTriggerPolicy({ ...policy, file_roles: { 'src/view.mdx': 'docs' } }));
});

test('normalizes legacy paths trigger values into one deterministic review-trigger policy', () => {
    const policy = normalizeReviewTriggerPolicyFromPaths({
        test_refactor_changed_lines_threshold: 37,
        triggers: {
            refactor: '(^|/)src/special\\.ts$',
            test: ['(^|/)quality/'],
            test_refactor_structural: ['(^|/)quality/helpers?/']
        }
    });

    assert.deepEqual(policy, {
        schema_version: 1,
        refactor_path_regexes: ['(^|/)src/special\\.ts$'],
        test_path_regexes: ['(^|/)quality/'],
        test_refactor_structural_path_regexes: ['(^|/)quality/helpers?/'],
        test_refactor_changed_lines_threshold: 37
    });
});

test('migrates missing legacy test-refactor values to the conservative shipped defaults', () => {
    const policy = normalizeReviewTriggerPolicyFromPaths({ triggers: {} });

    assert.deepEqual(policy, DEFAULT_REVIEW_TRIGGER_POLICY);
    assert.equal(policy.refactor_path_regexes.some((pattern) => new RegExp(pattern, 'iu').test('src/ordinary.ts')), false);
    assert.equal(policy.refactor_path_regexes.some((pattern) => new RegExp(pattern, 'iu').test('src/config/settings.ts')), true);
});

test('preserves explicit empty legacy trigger arrays as disabled trigger lists', () => {
    const policy = normalizeReviewTriggerPolicyFromPaths({
        triggers: {
            refactor: [],
            test: [],
            test_refactor_structural: []
        }
    });

    assert.deepEqual(policy.refactor_path_regexes, []);
    assert.deepEqual(policy.test_path_regexes, []);
    assert.deepEqual(policy.test_refactor_structural_path_regexes, []);
    assert.deepEqual(validateReviewTriggerPolicy(policy), policy);
});

test('rejects invalid review-trigger regexes and thresholds fail closed', () => {
    assert.throws(
        () => normalizeReviewTriggerPolicyFromPaths({ triggers: { refactor: ['['] } }),
        /paths\.triggers\.refactor contains invalid regex/iu
    );
    assert.throws(
        () => normalizeReviewTriggerPolicyFromPaths({ test_refactor_changed_lines_threshold: 0 }),
        /positive safe integer/iu
    );
    assert.throws(
        () => validateReviewTriggerPolicy({
            schema_version: 1,
            refactor_path_regexes: ['(^|/)src/'],
            test_path_regexes: ['(^|/)tests/'],
            test_refactor_changed_lines_threshold: 20
        }),
        /test_refactor_structural_path_regexes is required/iu
    );
});
