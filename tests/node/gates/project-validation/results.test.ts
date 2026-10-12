import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { ValidationAttempt, ValidationCase, ValidationRecipe } from '../../../../src/core/project-validation-contract';

type Facts = Pick<ValidationAttempt, 'exit_code' | 'timed_out' | 'cancelled' | 'truncated' | 'violations' | 'termination_signal'>;
const recipe = { purpose: 'test', result_format: 'tap', targets: [{ id: 'target', source: 'spec/case.custom', selector: 'declared case' }] } as ValidationRecipe;
const facts: Facts = { exit_code: 0, timed_out: false, cancelled: false, truncated: false, violations: [], termination_signal: null };
const green = 'TAP version 13\nok 1 - declared case\n1..1\n';
const red = 'TAP version 13\nnot ok 1 - declared case\n  ---\n  message: actual failure\n  ...\n1..1\n';
function adapter() {
    return require('../../../../src/core/project-validation-results') as {
        parseValidationTap: (output: string) => ValidationCase[];
        summarizeValidationResults: (recipe: ValidationRecipe, facts: Facts, output: string, expectedFailure?: boolean) => { status: string; cases: ValidationCase[] | null };
    };
}
it('maps an exact declared TAP case and requires both case and host success', () => {
    const summarize = adapter().summarizeValidationResults;
    assert.deepEqual(summarize(recipe, facts, green), { status: 'PASSED', cases: [{ id: 'declared case', outcome: 'passed' }] });
    assert.equal(summarize(recipe, { ...facts, exit_code: 7 }, green).status, 'FAILED');
    assert.equal(summarize(recipe, facts, red).status, 'FAILED');
    assert.equal(summarize(recipe, facts, green.replace('declared case', 'another case')).status, 'FAILED');
});
it('rejects malformed zero duplicate skipped and opaque case claims', () => {
    const { parseValidationTap, summarizeValidationResults } = adapter();
    for (const output of ['1..0', 'ok 2 - declared case\n1..1', 'ok 1 - declared case\nok 2 - declared case\n1..2', 'ok 1 - declared case\n1..1\n1..1', 'unknown success']) {
        assert.throws(() => parseValidationTap(output));
        assert.equal(summarizeValidationResults(recipe, facts, output, true).status, 'UNRESOLVED');
    }
    assert.equal(summarizeValidationResults(recipe, facts, green.replace('declared case', 'declared case # SKIP disabled')).status, 'FAILED');
    assert.equal(summarizeValidationResults({ ...recipe, result_format: 'opaque' }, facts, green).status, 'UNRESOLVED');
});
it('expected red requires actual target failure and cannot accept interrupted or invalid attempts', () => {
    const summarize = adapter().summarizeValidationResults;
    assert.equal(summarize(recipe, { ...facts, exit_code: 7 }, red, true).status, 'EXPECTED_FAILURE');
    assert.equal(summarize(recipe, facts, green, true).status, 'UNEXPECTED_PASS');
    for (const stopped of [{ timed_out: true }, { cancelled: true }, { truncated: true }, { violations: ['changed source'] }, { termination_signal: 'SIGTERM' }]) {
        assert.equal(summarize(recipe, { ...facts, exit_code: 7, ...stopped }, red, true).status, 'FAILED');
    }
    assert.equal(summarize(recipe, { ...facts, exit_code: 7 }, green, true).status, 'FAILED');
});
