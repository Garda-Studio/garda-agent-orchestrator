import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReviewCycleGuardConfig } from '../../../../src/core/review-cycle-guard';
import { appendValidatedReviewOutcome, createClosedReviewProducerState, projectClosedReviewGuard,
    type ValidatedReviewOutcome } from '../../../../src/gates/review-attempts/review-closed-cycle-summary';

function fact(index: number, values: Partial<ValidatedReviewOutcome> = {}): ValidatedReviewOutcome {
    return { reviewType: 'code', reviewerIdentity: 'agent:same', reviewContextSha256: 'c'.repeat(64),
        eventSha256: index.toString(16).padStart(64, '0'), lineOrdinal: index,
        failed: false, passed: true, reused: false, scopeHash: 'a'.repeat(64), cadenceFailed: false,
        latestFailedDisplay: { review_type: 'code', event_type: 'REVIEW_RECORDED', outcome: 'PASS',
            verdict_token: null, reviewer_identity: 'agent:same', review_artifact_path: 'report.md',
            summary: 'validated failure', sequence: index, timestamp_utc: null }, ...values };
}

test('duplicate failure remains sticky while latest event outcome permits total-limit continuation', () => {
    const state = createClosedReviewProducerState('T-1');
    appendValidatedReviewOutcome(state, fact(1, { failed: true, passed: false }));
    appendValidatedReviewOutcome(state, fact(2));
    appendValidatedReviewOutcome(state, fact(3, { reviewerIdentity: 'agent:second' }));
    const result = projectClosedReviewGuard(state, normalizeReviewCycleGuardConfig({ max_failed_non_test_reviews: 10,
        max_total_non_test_reviews: 1 }), null);
    assert.equal(result.evaluation.total_non_test_review_count, 2);
    assert.equal(result.evaluation.failed_non_test_review_count, 1);
    assert.equal(result.evaluation.should_block, false);
    assert.equal(result.latestFailedReview?.sequence, 1);
    const warning = projectClosedReviewGuard(state, normalizeReviewCycleGuardConfig({ action: 'WARN_ONLY',
        max_failed_non_test_reviews: 10, max_total_non_test_reviews: 1 }), null);
    assert.equal(warning.evaluation.violations[0].metric, 'total_non_test_review_count');
});

test('reuse merges with AND and only first failure transitions update display', () => {
    const state = createClosedReviewProducerState('T-1');
    appendValidatedReviewOutcome(state, fact(1, { reused: true, failed: true, passed: false }));
    appendValidatedReviewOutcome(state, fact(2, { reused: false }));
    const result = projectClosedReviewGuard(state, normalizeReviewCycleGuardConfig({ max_failed_non_test_reviews: 1 }), null);
    assert.equal(result.evaluation.total_non_test_review_count, 1);
    assert.equal(result.evaluation.failed_non_test_review_count, 1);
    assert.equal(result.evaluation.should_block, true);
    assert.equal(result.latestFailedReview, null);
});

test('retains all scope memberships but diagnostics keep first non-null hash', () => {
    const state = createClosedReviewProducerState('T-1');
    appendValidatedReviewOutcome(state, fact(1, { scopeHash: null }));
    appendValidatedReviewOutcome(state, fact(2, { scopeHash: 'b'.repeat(64) }));
    appendValidatedReviewOutcome(state, fact(3, { scopeHash: 'c'.repeat(64) }));
    const row = Object.values(state.attempts)[0];
    assert.equal(row.firstScopeHash, 'b'.repeat(64));
    assert.deepEqual(row.seenScopeHashes, ['b'.repeat(64), 'c'.repeat(64)]);
    assert.equal(row.sawUnknownScope, true);
    assert.equal(row.lastSequence, 3);
});

test('missing identity uses original line ordinal and restart never clears cumulative rows', () => {
    const state = createClosedReviewProducerState('T-1');
    appendValidatedReviewOutcome(state, fact(5, { reviewerIdentity: '' }));
    // A restart changes publication binding only; it does not reconstruct or clear state.
    appendValidatedReviewOutcome(state, fact(10, { reviewerIdentity: '' }));
    assert.deepEqual(Object.keys(state.attempts), ['REVIEW_RECORDED:5', 'REVIEW_RECORDED:10']);
    appendValidatedReviewOutcome(state, fact(10, { reviewerIdentity: '' }));
    assert.equal(Object.keys(state.attempts).length, 2);
    assert.throws(() => appendValidatedReviewOutcome(state, fact(9)), /replay or reorder/u);
});
