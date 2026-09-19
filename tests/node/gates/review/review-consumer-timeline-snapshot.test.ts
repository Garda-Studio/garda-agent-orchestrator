import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Mode, OpenMode, PathLike } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { withTaskTimelineReadSnapshot } from '../../../../src/gate-runtime/timeline/task-events';
import { readReviewDependencyTimelineEvents } from '../../../../src/gates/required-reviews/required-reviews-check-dependencies';
import { getReviewLifecycleGuard } from '../../../../src/gates/review/review-lifecycle-guard';
import { collectOrderedTimelineEvents } from '../../../../src/gates/rule-pack/rule-pack-timeline';
import {
    collectTaskTimelineEventTypes,
    getTaskModeEvidence
} from '../../../../src/gates/task-mode/task-mode-evidence';

const TASK_ID = 'T-900';

function writeFixture(repoRoot: string): { artifactPath: string; eventsRoot: string; timelinePath: string } {
    const runtimeRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime');
    const eventsRoot = path.join(runtimeRoot, 'task-events');
    const reviewsRoot = path.join(runtimeRoot, 'reviews');
    const timelinePath = path.join(eventsRoot, `${TASK_ID}.jsonl`);
    const artifactPath = path.join(reviewsRoot, `${TASK_ID}-task-mode.json`);
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(artifactPath, '{}\n', 'utf8');
    fs.writeFileSync(timelinePath, [
        {
            event_type: 'TASK_MODE_ENTERED',
            details: {
                artifact_path: artifactPath.replace(/\\/gu, '/'),
                canonical_source_of_truth: 'Codex',
                execution_provider_source: 'explicit_provider',
                runtime_identity_status: 'resolved'
            }
        },
        { event_type: 'PREFLIGHT_CLASSIFIED', details: {} },
        { event_type: 'COMPILE_GATE_PASSED', details: {} },
        {
            event_type: 'REVIEWER_DELEGATION_ROUTED',
            details: {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:reviewer'
            }
        }
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
    return { artifactPath, eventsRoot, timelinePath };
}

test('review lifecycle consumers share one authenticated timeline capture', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-consumers-'));
    const fixture = writeFixture(repoRoot);
    const originalOpenSync = fs.openSync;
    let timelineOpenCount = 0;
    fs.openSync = ((targetPath: PathLike, flags: OpenMode, mode?: Mode) => {
        if (path.resolve(String(targetPath)) === path.resolve(fixture.timelinePath)) {
            timelineOpenCount += 1;
        }
        return originalOpenSync(targetPath, flags, mode);
    }) as typeof fs.openSync;

    const assertConsumers = () => {
        assert.equal(readReviewDependencyTimelineEvents(fixture.timelinePath).length, 4);
        const rulePackViolations: string[] = [];
        assert.equal(collectOrderedTimelineEvents(fixture.timelinePath, rulePackViolations).length, 4);
        assert.deepEqual(rulePackViolations, []);
        assert.equal(
            getReviewLifecycleGuard(repoRoot, TASK_ID, 'record-review-routing', 'review_phase').status,
            'ALLOW'
        );
        assert.equal(
            getTaskModeEvidence(repoRoot, TASK_ID, fixture.artifactPath).timeline_artifact_path,
            fixture.artifactPath.replace(/\\/gu, '/')
        );
        const taskModeTimelineErrors: string[] = [];
        assert.deepEqual(
            [...collectTaskTimelineEventTypes(fixture.timelinePath, taskModeTimelineErrors)],
            [
                'TASK_MODE_ENTERED',
                'PREFLIGHT_CLASSIFIED',
                'COMPILE_GATE_PASSED',
                'REVIEWER_DELEGATION_ROUTED'
            ]
        );
        assert.deepEqual(taskModeTimelineErrors, []);
    };

    try {
        withTaskTimelineReadSnapshot(fixture.eventsRoot, TASK_ID, assertConsumers);
        assert.equal(timelineOpenCount, 1);

        const assertOneTimelineOpen = (operation: () => unknown) => {
            const opensBeforeOperation = timelineOpenCount;
            operation();
            assert.equal(timelineOpenCount - opensBeforeOperation, 1);
        };
        assertOneTimelineOpen(() => readReviewDependencyTimelineEvents(fixture.timelinePath));
        assertOneTimelineOpen(() => collectOrderedTimelineEvents(fixture.timelinePath, []));
        assertOneTimelineOpen(() => getReviewLifecycleGuard(
            repoRoot,
            TASK_ID,
            'record-review-routing',
            'review_phase'
        ));
        assertOneTimelineOpen(() => getTaskModeEvidence(repoRoot, TASK_ID, fixture.artifactPath));
        assertOneTimelineOpen(() => collectTaskTimelineEventTypes(fixture.timelinePath, []));
    } finally {
        fs.openSync = originalOpenSync;
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('review lifecycle consumers reject malformed authenticated timeline entries', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-consumers-'));
    const fixture = writeFixture(repoRoot);
    try {
        fs.appendFileSync(fixture.timelinePath, '{"event_type":"REVIEW_GATE_PASSED"\n', 'utf8');

        assert.deepEqual(readReviewDependencyTimelineEvents(fixture.timelinePath), []);
        const rulePackViolations: string[] = [];
        assert.deepEqual(collectOrderedTimelineEvents(fixture.timelinePath, rulePackViolations), []);
        assert.equal(rulePackViolations.length, 1);
        assert.equal(
            getReviewLifecycleGuard(repoRoot, TASK_ID, 'record-review-routing', 'review_phase').status,
            'BLOCK'
        );
        const taskModeTimelineErrors: string[] = [];
        collectTaskTimelineEventTypes(fixture.timelinePath, taskModeTimelineErrors);
        assert.equal(taskModeTimelineErrors.length, 1);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
