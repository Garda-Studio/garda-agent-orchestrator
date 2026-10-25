import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { resolveNextStep } from './next-step-test-support';
import { isValidatedCompletionFinalizationFailure, isRetryableCompletionFinalizationError } from '../../../../src/gates/completion/completion-finalization-retry';
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
        finalization_retryable: true,
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
        const base = { event_type: 'COMPLETION_GATE_FAILED', details: { status: 'PASSED', outcome: 'FINALIZATION_FAILED', finalization_retryable: true, violations: [] } };
        assert.equal(isValidatedCompletionFinalizationFailure(base), true);
        assert.equal(isValidatedCompletionFinalizationFailure({ ...base, details: { ...base.details, finalization_retryable: undefined } }), false);
        assert.equal(isValidatedCompletionFinalizationFailure({ ...base, details: { ...base.details, finalization_retryable: false } }), false);
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

    it('marks only native environment failures retryable, including wrapped append errors', () => {
        for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOSPC', 'EMFILE', 'EAGAIN', 'EIO']) {
            const nativeError = Object.assign(new Error('Native write failure'), { code });
            assert.equal(isRetryableCompletionFinalizationError(nativeError), true, code);
            assert.equal(isRetryableCompletionFinalizationError(new Error('Mandatory lifecycle append failed', { cause: nativeError })), true, code);
            assert.equal(isRetryableCompletionFinalizationError(new Error(`Mandatory lifecycle append failed: ${code}: native write failure`)), false, code);
        }
        assert.equal(isRetryableCompletionFinalizationError(new Error('Wrapper', { cause: Object.assign(new Error('write'), { code: 'EBUSY' }) })), true);
        for (const error of [new Error('final closeout materialization did not produce a READY report: audit_status=FAIL'),
            new Error('Closeout metadata recovery bindings changed before finalization'),
            new Error('The report mentioned EPERM in a finding'), Object.assign(new Error('invalid data'), { code: 'EINVAL' })]) {
            assert.equal(isRetryableCompletionFinalizationError(error), false);
        }
    });

    it('does not promote secondary diagnostics or wrapper codes over the primary semantic failure', () => {
        const primary = new Error('final closeout materialization did not produce a READY report: audit_status=BLOCKED');
        const repairMessage = `${primary.message}. Rollback failed: final-user-report restore failed: EPERM: access denied`;
        assert.equal(isRetryableCompletionFinalizationError(new Error(repairMessage, { cause: primary })), false);
        assert.equal(isRetryableCompletionFinalizationError(Object.assign(new Error(repairMessage, { cause: primary }), { code: 'EPERM' })), false);
        assert.equal(isRetryableCompletionFinalizationError(new AggregateError([
            primary, Object.assign(new Error('secondary restore failure'), { code: 'EPERM' })
        ], repairMessage)), false);
    });

    it('fails closed on cause cycles and unstructured primary errors', () => {
        const cyclicError = Object.assign(new Error('cyclic wrapper'), { code: 'EPERM', cause: undefined as unknown });
        cyclicError.cause = cyclicError;
        assert.equal(isRetryableCompletionFinalizationError(cyclicError), false);
        for (const cause of [null, 'EPERM: unstructured primary error', 1, {}]) {
            assert.equal(isRetryableCompletionFinalizationError(Object.assign(new Error('wrapper', { cause }), { code: 'EPERM' })), false);
        }
    });

    it('treats a latest retryable failure as no failure instead of falling back to an older validation failure', () => {
        const repoRoot = makeTempRepo();
        seedValidatedCloseout(repoRoot, { ...ALL_REVIEW_FLAGS, code: true });
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', finalizationFailureDetails(repoRoot, {
            status: 'FAILED', outcome: 'FAIL', violations: ['Earlier missing review.'], finalization_retryable: false
        }));
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', finalizationFailureDetails(repoRoot));
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(result.next_gate, 'completion-gate', JSON.stringify(result));
    });

    for (const error of ['final closeout audit_status=FAIL', 'Closeout metadata recovery bindings changed']) {
        it(`keeps semantic finalization failures out of the retry route: ${error}`, () => {
            const repoRoot = makeTempRepo();
            seedValidatedCloseout(repoRoot, { ...ALL_REVIEW_FLAGS });
            appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', finalizationFailureDetails(repoRoot, {
                finalization_error: error, finalization_retryable: false
            }));
            assert.notEqual(resolveNextStep({ taskId: TASK_ID, repoRoot }).next_gate, 'completion-gate');
        });
    }

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
