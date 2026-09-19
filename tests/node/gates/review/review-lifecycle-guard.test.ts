import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { withTaskTimelineReadSnapshot } from '../../../../src/gate-runtime/timeline/task-events';
import { getReviewLifecycleGuard } from '../../../../src/gates/review/review-lifecycle-guard';

function writeTimeline(root: string, taskId: string, eventTypes: string[]): string {
    const timelinePath = path.join(root, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.writeFileSync(
        timelinePath,
        eventTypes.map((eventType, index) => JSON.stringify({
            event_type: eventType,
            timestamp_utc: `2026-04-13T18:00:${String(index).padStart(2, '0')}.000Z`
        })).join('\n') + '\n',
        'utf8'
    );
    return timelinePath;
}

describe('gates/review-lifecycle-guard', () => {
    it('blocks late rerun when no newer lifecycle restart exists', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-guard-'));
        const taskId = 'T-guard-1';
        try {
            writeTimeline(repoRoot, taskId, [
                'TASK_MODE_ENTERED',
                'PREFLIGHT_CLASSIFIED',
                'COMPILE_GATE_PASSED',
                'REVIEW_GATE_PASSED'
            ]);

            const result = getReviewLifecycleGuard(repoRoot, taskId, 'required-reviews-check', 'review_gate');
            assert.equal(result.status, 'BLOCK');
            assert.equal(result.blocking_event, 'REVIEW_GATE_PASSED');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows rerun after a newer compile pass starts a fresh review cycle', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-guard-'));
        const taskId = 'T-guard-2';
        try {
            writeTimeline(repoRoot, taskId, [
                'TASK_MODE_ENTERED',
                'PREFLIGHT_CLASSIFIED',
                'COMPILE_GATE_PASSED',
                'REVIEW_GATE_PASSED',
                'PREFLIGHT_CLASSIFIED',
                'COMPILE_GATE_PASSED'
            ]);

            const result = getReviewLifecycleGuard(repoRoot, taskId, 'required-reviews-check', 'review_gate');
            assert.equal(result.status, 'ALLOW');
            assert.equal(result.blocking_event, null);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows review-phase telemetry after a newer REVIEW_PHASE_STARTED event', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-guard-'));
        const taskId = 'T-guard-3';
        try {
            writeTimeline(repoRoot, taskId, [
                'TASK_MODE_ENTERED',
                'PREFLIGHT_CLASSIFIED',
                'COMPILE_GATE_PASSED',
                'COMPLETION_GATE_PASSED',
                'TASK_MODE_ENTERED',
                'PREFLIGHT_CLASSIFIED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED'
            ]);

            const result = getReviewLifecycleGuard(repoRoot, taskId, 'record-review-routing', 'review_phase');
            assert.equal(result.status, 'ALLOW');
            assert.equal(result.blocking_event, null);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fails closed when a captured timeline is removed before lifecycle evaluation', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-guard-'));
        const taskId = 'T-guard-removed';
        try {
            const timelinePath = writeTimeline(repoRoot, taskId, [
                'TASK_MODE_ENTERED',
                'PREFLIGHT_CLASSIFIED',
                'COMPILE_GATE_PASSED'
            ]);
            const eventsRoot = path.dirname(timelinePath);

            withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
                assert.equal(
                    getReviewLifecycleGuard(repoRoot, taskId, 'record-review-routing', 'review_phase').status,
                    'ALLOW'
                );
                fs.rmSync(timelinePath);
                assert.throws(
                    () => getReviewLifecycleGuard(repoRoot, taskId, 'record-review-routing', 'review_phase'),
                    /snapshot is unavailable/
                );
            });
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
