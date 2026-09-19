import test from 'node:test';
import assert from 'node:assert/strict';
import type { Mode, OpenMode, PathLike } from 'node:fs';

import {
    readReviewArtifactState
} from '../../../../src/gates/next-step/next-step-review-artifact-readers';
import {
    timelineHasDelegatedReviewInvocationAttestation,
    timelineHasHistoricalDelegatedReviewInvocationAttestation
} from '../../../../src/gates/next-step/next-step-review-invocation-evidence';
import {
    findDownstreamReviewNeedingDependencyRebind,
    findReviewGateStaleContextPrecheckRecovery,
    findReviewGateStaleUpstreamRecovery,
    findStrictSequentialUpstreamNeedingCurrentCycleReuse,
    getHiddenReviewTimingTrustRemediation,
    reviewStateHasCurrentRecordedEvidence,
    reviewStateHasSatisfiedEvidence,
    timelineHasReviewContextPreparedAfterCompile
} from '../../../../src/gates/next-step/next-step-review-evidence';
import {
    getLatestTaskSequenceForEventTypes as getLatestBoundedTaskSequence,
    withNextStepReviewEvidenceSnapshot
} from '../../../../src/gates/next-step/next-step-review-timeline-evidence';
import {
    getLatestTaskSequenceForEventTypes as getLatestAuthenticatedTaskSequence
} from '../../../../src/gates/next-step/next-step-reviewer-launch-evidence-shared';
import {
    getDelegatedReviewRoutingShaAfterCompile
} from '../../../../src/gates/next-step/next-step-reviewer-launch-evidence-telemetry';
import {
    buildReviewerReadinessChainSummary,
    timelineHasDelegatedReviewRoutingAfterCompile
} from '../../../../src/gates/next-step/next-step-reviewer-launch-evidence';
import {
    ALL_REVIEW_FLAGS,
    eventsRoot,
    fileSha256,
    fs,
    makeTempRepo,
    path,
    reviewsRoot,
    seedCompilePass,
    seedStartedTask,
    TASK_ID,
    writePreflight,
    writeReviewEvidence
} from './next-step-review-reuse-fixtures';

function readState(repoRoot: string, reviewType: string) {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
    return readReviewArtifactState(
        reviewsRoot(repoRoot),
        TASK_ID,
        reviewType,
        preflightPath,
        fileSha256(preflightPath),
        JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
        repoRoot
    );
}

function seedReviewedRepo(options: { includeLaunchArtifact?: boolean } = {}): string {
    const repoRoot = makeTempRepo();
    seedStartedTask(repoRoot, TASK_ID);
    writePreflight(repoRoot, TASK_ID, {
        ...ALL_REVIEW_FLAGS,
        code: true
    }, {
        includeDomainScopeFingerprints: true
    });
    seedCompilePass(repoRoot, TASK_ID);
    writeReviewEvidence(repoRoot, TASK_ID, 'code', options);
    return repoRoot;
}

test('current delegated review invocation evidence requires the launched reviewer artifact binding', () => {
    const repoRoot = seedReviewedRepo();
    const state = readState(repoRoot, 'code');

    assert.equal(
        timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot(repoRoot), TASK_ID, state),
        true
    );
    assert.equal(
        timelineHasHistoricalDelegatedReviewInvocationAttestation(eventsRoot(repoRoot), TASK_ID, state),
        true
    );
});

test('historical delegated review invocation evidence does not stand in for current launch binding', () => {
    const repoRoot = seedReviewedRepo({ includeLaunchArtifact: false });
    const state = readState(repoRoot, 'code');

    assert.equal(
        timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot(repoRoot), TASK_ID, state),
        false
    );
    assert.equal(
        timelineHasHistoricalDelegatedReviewInvocationAttestation(eventsRoot(repoRoot), TASK_ID, state),
        true
    );
});

test('six next-step evidence readers share one authenticated timeline payload capture', () => {
    const repoRoot = seedReviewedRepo();
    const taskEventsRoot = eventsRoot(repoRoot);
    const timelinePath = path.join(taskEventsRoot, `${TASK_ID}.jsonl`);
    const state = readState(repoRoot, 'code');
    const reviewerIdentity = state.contextReviewerIdentity || '';
    const mutableFs = require('node:fs') as typeof fs;
    const originalOpenSync = mutableFs.openSync;
    const originalReadSync = mutableFs.readSync;
    const originalCloseSync = mutableFs.closeSync;
    const timelineDescriptors = new Set<number>();
    let timelineOpenCount = 0;
    let timelineReadCount = 0;

    mutableFs.openSync = ((targetPath: PathLike, flags: OpenMode, mode?: Mode) => {
        const descriptor = originalOpenSync(targetPath, flags, mode);
        if (path.resolve(String(targetPath)) === path.resolve(timelinePath)) {
            timelineOpenCount += 1;
            timelineDescriptors.add(descriptor);
        }
        return descriptor;
    }) as typeof mutableFs.openSync;
    mutableFs.readSync = ((...args: unknown[]) => {
        if (typeof args[0] === 'number' && timelineDescriptors.has(args[0])) {
            timelineReadCount += 1;
        }
        return Reflect.apply(originalReadSync, mutableFs, args) as number;
    }) as typeof mutableFs.readSync;
    mutableFs.closeSync = ((descriptor: number) => {
        timelineDescriptors.delete(descriptor);
        return originalCloseSync(descriptor);
    }) as typeof mutableFs.closeSync;

    try {
        withNextStepReviewEvidenceSnapshot(taskEventsRoot, TASK_ID, () => {
            assert.equal(
                timelineHasReviewContextPreparedAfterCompile(
                    taskEventsRoot,
                    TASK_ID,
                    'code',
                    state.contextPath
                ),
                false,
                'the fixture has no REVIEW_PHASE_STARTED event'
            );
            assert.equal(
                timelineHasHistoricalDelegatedReviewInvocationAttestation(taskEventsRoot, TASK_ID, state),
                true
            );
            assert.ok(getLatestBoundedTaskSequence(taskEventsRoot, TASK_ID, ['COMPILE_GATE_PASSED']));
            assert.ok(getLatestAuthenticatedTaskSequence(taskEventsRoot, TASK_ID, ['COMPILE_GATE_PASSED']));
            assert.match(
                getDelegatedReviewRoutingShaAfterCompile(
                    taskEventsRoot,
                    TASK_ID,
                    'code',
                    reviewerIdentity
                ) || '',
                /^[0-9a-f]{64}$/
            );
            assert.equal(
                timelineHasDelegatedReviewRoutingAfterCompile(
                    taskEventsRoot,
                    TASK_ID,
                    'code',
                    reviewerIdentity
                ),
                true
            );
        });
        assert.equal(timelineOpenCount, 1);
        assert.ok(timelineReadCount >= 1);

        const opensBeforeReadiness = timelineOpenCount;
        assert.match(
            buildReviewerReadinessChainSummary(
                repoRoot,
                taskEventsRoot,
                TASK_ID,
                'code',
                state,
                () => true
            ),
            /^Reviewer readiness chain:/
        );
        assert.equal(timelineOpenCount - opensBeforeReadiness, 1);

        const opensBeforeSatisfiedEvidence = timelineOpenCount;
        assert.equal(
            reviewStateHasSatisfiedEvidence(repoRoot, taskEventsRoot, TASK_ID, state),
            true
        );
        assert.equal(timelineOpenCount - opensBeforeSatisfiedEvidence, 1);

        const assertOneTimelineOpen = (operation: () => unknown) => {
            const opensBeforeOperation = timelineOpenCount;
            operation();
            assert.equal(timelineOpenCount - opensBeforeOperation, 1);
        };
        assertOneTimelineOpen(() => getHiddenReviewTimingTrustRemediation(taskEventsRoot, TASK_ID, state));
        assertOneTimelineOpen(() => reviewStateHasCurrentRecordedEvidence(
            repoRoot,
            taskEventsRoot,
            TASK_ID,
            state
        ));
        assertOneTimelineOpen(() => findStrictSequentialUpstreamNeedingCurrentCycleReuse({
            repoRoot,
            eventsRoot: taskEventsRoot,
            taskId: TASK_ID,
            targetReviewType: 'test',
            requiredReviews: ALL_REVIEW_FLAGS,
            policyMode: 'strict_sequential',
            reviewStates: [state]
        }));
        assertOneTimelineOpen(() => findReviewGateStaleUpstreamRecovery({
            repoRoot,
            eventsRoot: taskEventsRoot,
            taskId: TASK_ID,
            requiredReviewTypes: ['code'],
            requiredReviews: ALL_REVIEW_FLAGS,
            policyMode: 'strict_sequential',
            reviewStates: [state]
        }));
        assertOneTimelineOpen(() => findReviewGateStaleContextPrecheckRecovery({
            repoRoot,
            eventsRoot: taskEventsRoot,
            taskId: TASK_ID,
            requiredReviewTypes: ['code'],
            reviewStates: [state]
        }));
        assertOneTimelineOpen(() => findDownstreamReviewNeedingDependencyRebind({
            eventsRoot: taskEventsRoot,
            taskId: TASK_ID,
            requiredReviewTypes: ['code'],
            requiredReviews: ALL_REVIEW_FLAGS,
            policyMode: 'strict_sequential',
            reviewStates: [state]
        }));
    } finally {
        mutableFs.openSync = originalOpenSync;
        mutableFs.readSync = originalReadSync;
        mutableFs.closeSync = originalCloseSync;
    }
});
