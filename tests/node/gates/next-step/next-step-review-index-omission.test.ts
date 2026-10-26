import '../../../../src/bin/garda/derivation-source-receipts';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { loadTaskIndex, rebuildIndex, resolveIndexPath, writeIndex, invalidateIndex } from '../../../../src/gate-runtime/reviews-index';
import { createReviewAttemptArtifactIndex, createCurrentReviewAttemptArtifactIndex } from '../../../../src/gates/review-attempts/review-attempt-artifact-index';
import { createAuthenticatedNextStepHistoryFixture } from './next-step-authenticated-history-fixture';
import { measureHistoryRoute } from './next-step-authenticated-budget-fixture';
import { getReviewsRoot, readTaskTimelineEvents } from '../../cli/commands/gates/review-cycle/gates-review-cycle-fixtures';

test('self-consistent derived-index omission preserves a real navigator rejection', { timeout: 600_000 }, async () => {
    const fixture = await createAuthenticatedNextStepHistoryFixture(1, 1);
    const before = measureHistoryRoute(fixture, 'before-index-omission');
    assert.equal(before.nextGate, 'required-reviews-check', before.reason);
    const review = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId)
        .filter(event => event.event_type === 'REVIEW_RECORDED').at(-1)!;
    const details = review.details as Record<string, unknown>;
    const snapshotPath = String(details.receipt_snapshot_path);
    const digest = String(details.receipt_snapshot_sha256);
    const fileName = path.basename(snapshotPath);
    const reviewsRoot = getReviewsRoot(fixture.repoRoot);
    const index = rebuildIndex(reviewsRoot);
    assert.equal(index.entries.filter(entry => entry.fileName === fileName).length, 1);
    index.entries = index.entries.filter(entry => entry.fileName !== fileName);
    index.directoryUnindexedEntryCount = (index.directoryUnindexedEntryCount || 0) + 1;
    writeIndex(resolveIndexPath(reviewsRoot), index);
    try {
        assert.equal(loadTaskIndex(reviewsRoot, fixture.taskId).source, 'cache');
        assert.equal(createReviewAttemptArtifactIndex(reviewsRoot, fixture.taskId)
            .readJsonSnapshot(snapshotPath, fileName, digest).valid, false);
        assert.equal(createCurrentReviewAttemptArtifactIndex(reviewsRoot, fixture.taskId), null,
            'Exact-current lookup must retain the native path for a valid derived index.');
        const rejected = measureHistoryRoute(fixture, 'self-consistent-index-omission');
        assert.notEqual(rejected.nextGate, before.nextGate,
            'An unconditional disk lookup would silently remove this existing navigator rejection.');
    } finally { invalidateIndex(reviewsRoot); }
    assert.equal(loadTaskIndex(reviewsRoot, fixture.taskId).source, 'rebuilt');
    assert.equal(createReviewAttemptArtifactIndex(reviewsRoot, fixture.taskId)
        .readJsonSnapshot(snapshotPath, fileName, digest).valid, true);
    assert.equal(measureHistoryRoute(fixture, 'restored-index-membership').nextGate, before.nextGate);
});
