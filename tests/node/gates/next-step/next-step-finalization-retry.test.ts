import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { resolveNextStep } from './next-step-test-support';
import { isValidatedCompletionFinalizationFailure } from '../../../../src/gates/completion/completion-finalization-retry';
import {
    TASK_ID,
    ALL_REVIEW_FLAGS,
    makeTempRepo,
    reviewsRoot,
    appendEvent,
    seedStartedTask,
    writePreflight,
    seedCompilePass,
    writeReviewEvidence,
    seedReviewGatePass,
    seedDocImpactPass
} from './next-step-completion-fixtures';

function finalizationFailureDetails(repoRoot: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        status: 'PASSED',
        outcome: 'FINALIZATION_FAILED',
        preflight_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`).replace(/\\/gu, '/'),
        violations: [],
        finalization_error: "Mandatory lifecycle event 'STATUS_CHANGED' append failed: EPERM: operation not permitted",
        closeout_linkage_recovery: null,
        ...overrides
    };
}

function seedValidatedCloseout(repoRoot: string, reviewFlags: Record<string, boolean>): void {
    seedStartedTask(repoRoot, TASK_ID);
    writePreflight(repoRoot, TASK_ID, reviewFlags);
    seedCompilePass(repoRoot, TASK_ID);
    if (reviewFlags.code) writeReviewEvidence(repoRoot, TASK_ID, 'code');
    seedReviewGatePass(repoRoot, TASK_ID);
    seedDocImpactPass(repoRoot, TASK_ID);
}

describe('gates/next-step finalization retry', () => {
    it('recognizes only validated finalization failures without linkage recovery', () => {
        const base = { event_type: 'COMPLETION_GATE_FAILED', details: { status: 'PASSED', outcome: 'FINALIZATION_FAILED', violations: [] } };
        assert.equal(isValidatedCompletionFinalizationFailure(base), true);
        assert.equal(isValidatedCompletionFinalizationFailure({ ...base, details: { ...base.details, closeout_linkage_recovery: null } }), true);
        assert.equal(isValidatedCompletionFinalizationFailure({ ...base, details: { ...base.details, status: 'FAILED' } }), false);
        assert.equal(isValidatedCompletionFinalizationFailure({ ...base, details: { ...base.details, outcome: 'FAIL' } }), false);
        assert.equal(isValidatedCompletionFinalizationFailure({ ...base, details: { ...base.details, violations: ['missing review'] } }), false);
        assert.equal(isValidatedCompletionFinalizationFailure({ ...base, details: { ...base.details, violations: undefined } }), false);
        assert.equal(isValidatedCompletionFinalizationFailure({
            ...base, details: { ...base.details, closeout_linkage_recovery: { state_sha256: 'a' } }
        }), false);
        assert.equal(isValidatedCompletionFinalizationFailure({ ...base, event_type: 'COMPLETION_GATE_PASSED' }), false);
        assert.equal(isValidatedCompletionFinalizationFailure(null), false);
    });

    for (const [label, reviewFlags] of [
        ['without required reviews', { ...ALL_REVIEW_FLAGS }],
        ['after a passed code review', { ...ALL_REVIEW_FLAGS, code: true }]
    ] as const) {
        it(`routes a validated finalization failure ${label} to the exact completion retry`, () => {
            const repoRoot = makeTempRepo();
            seedValidatedCloseout(repoRoot, reviewFlags);
            const ready = resolveNextStep({ taskId: TASK_ID, repoRoot });
            assert.equal(ready.next_gate, 'completion-gate', JSON.stringify({ gate: ready.next_gate, reason: ready.reason }));

            appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', finalizationFailureDetails(repoRoot));

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
            assert.equal(result.next_gate, 'completion-gate', JSON.stringify({ gate: result.next_gate, reason: result.reason }));
            assert.ok(result.commands[0]?.command.includes('completion-gate'));
        });
    }

    it('keeps the classify-change refresh after a completion validation failure', () => {
        const repoRoot = makeTempRepo();
        seedValidatedCloseout(repoRoot, { ...ALL_REVIEW_FLAGS });
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', finalizationFailureDetails(repoRoot, {
            status: 'FAILED', outcome: 'FAIL', violations: ['Required review evidence is missing.']
        }));

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.notEqual(result.next_gate, 'completion-gate', JSON.stringify({ gate: result.next_gate, reason: result.reason }));
    });
});
