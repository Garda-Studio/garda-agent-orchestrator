import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    validateStageSequence,
    STAGE_SEQUENCE_ORDER,
    NON_CODE_STAGE_SEQUENCE_ORDER
} from '../../../../src/gates/completion';

import { makeTimelineEvents } from './completion-stage-evidence-fixtures';

describe('gates/completion — stage and evidence validation', () => {
    describe('validateStageSequence', () => {
        it('passes when stages are in correct order for code-changing task', () => {
            const events = makeTimelineEvents(
                'TASK_MODE_ENTERED', 'RULE_PACK_LOADED', 'HANDSHAKE_DIAGNOSTICS_RECORDED', 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED', 'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED', 'REVIEW_RECORDED', 'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.equal(result.violations.some((entry) => entry.includes('single-agent providers')), false);
        });

        it('requires canonical preflight and implementation stages for non-code tasks too', () => {
            const events = makeTimelineEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, false, '/timeline.jsonl');
            assert.equal(result.violations.some((entry) => entry.includes('single-agent providers')), false);
            assert.deepEqual(result.observed_order, [...NON_CODE_STAGE_SEQUENCE_ORDER]);
        });

        it('rejects non-code latest-cycle review evidence when preflight and implementation only exist in an older cycle', () => {
            const events = makeTimelineEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, false, '/timeline.jsonl');
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'PREFLIGHT_CLASSIFIED' from an older execution cycle.")));
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'IMPLEMENTATION_STARTED' from an older execution cycle.")));
        });

        it('does not require REVIEW_RECORDED when the current code-changing cycle required zero reviews', () => {
            const events = makeTimelineEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl', false);
            assert.equal(result.violations.length, 0);
            assert.deepEqual(result.expected_order, [...NON_CODE_STAGE_SEQUENCE_ORDER]);
        });

        it('allows an authenticated audited no-op cycle to omit compile evidence', () => {
            const events = makeTimelineEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, false, '/timeline.jsonl', false, false);
            assert.equal(result.violations.length, 0);
            assert.equal(result.expected_order.includes('IMPLEMENTATION_STARTED'), false);
            assert.equal(result.expected_order.includes('COMPILE_GATE_PASSED'), false);
            assert.deepEqual(result.observed_order, result.expected_order);
        });

        it('still requires REVIEW_RECORDED when the current code-changing cycle required reviews', () => {
            const events = makeTimelineEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl', true);
            assert.ok(result.violations.some((item) => item.includes("latest 'REVIEW_GATE_PASSED' evidence")));
            assert.ok(result.violations.some((item) => item.includes("'REVIEW_RECORDED'")));
        });

        it('uses the latest coherent cycle instead of the first stale stage occurrences', () => {
            const events = makeTimelineEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'REVIEW_PHASE_STARTED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_RECORDED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.equal(result.violations.length, 0);
            assert.deepEqual(result.observed_order, [...STAGE_SEQUENCE_ORDER]);
        });

        it('does not let an early task-entry rule-pack misorder poison a later valid cycle', () => {
            const events = makeTimelineEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                { type: 'RULE_PACK_LOADED', details: { stage: 'TASK_ENTRY' } },
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_RECORDED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.equal(result.violations.some(v =>
                v.includes('receipt cannot use delegated_subagent') && v.includes('Gemini')
            ), false);
        });

        it('rejects backfilling compile evidence from an older cycle when the latest cycle is misordered', () => {
            const events = makeTimelineEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'REVIEW_PHASE_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_RECORDED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'COMPILE_GATE_PASSED' from an older execution cycle.")));
        });

        it('rejects latest-cycle review evidence when compile and implementation only exist in an older cycle', () => {
            const events = makeTimelineEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED',
                'PREFLIGHT_CLASSIFIED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_RECORDED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'IMPLEMENTATION_STARTED' from an older execution cycle.")));
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'COMPILE_GATE_PASSED' from an older execution cycle.")));
        });
    });
});
