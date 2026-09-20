import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildBaselineOnlyPreImplementationRoute
} from '../../../../src/gates/next-step/next-step-pre-implementation-routing';

const TASK_ID = 'T-1013-2-3-1-1-2';
const IMPLEMENTATION_SUMMARY =
    '[security] Complete selection, invocation, and acceptance provenance with exact single-consumption bindings';

function buildBaselineOnlyPreflight(): Record<string, unknown> {
    return {
        changed_files: [],
        zero_diff_guard: {
            zero_diff_detected: true,
            completion_requires_audited_no_op: true
        }
    };
}

describe('next-step baseline-only pre-implementation routing', () => {
    it('routes a complete-provenance implementation task before audited no-op', () => {
        const result = buildBaselineOnlyPreImplementationRoute({
            repoRoot: process.cwd(),
            cliPrefix: 'node bin/garda.js',
            taskEntry: {
                taskId: TASK_ID,
                status: 'IN_PROGRESS',
                area: 'workflow/review-output-correction-response-provenance',
                title: IMPLEMENTATION_SUMMARY,
                profile: 'strict',
                notes: 'Bind selection, invocation, and accepted response evidence.'
            },
            taskMode: {
                task_id: TASK_ID,
                task_summary: IMPLEMENTATION_SUMMARY
            },
            preflight: buildBaselineOnlyPreflight(),
            auditedNoOpPassed: false
        });

        assert.equal(result?.nextGate, 'implementation');
        assert.match(result?.reason || '', /task has implementation intent/u);
    });

    it('routes a close-retry-continuity implementation task before audited no-op', () => {
        const taskId = 'T-1013-2-3-1-1-3';
        const taskSummary =
            '[security] Close historical retry continuity through the next rejection package and transport selection';
        const result = buildBaselineOnlyPreImplementationRoute({
            repoRoot: process.cwd(),
            cliPrefix: 'node bin/garda.js',
            taskEntry: {
                taskId,
                status: 'IN_PROGRESS',
                area: 'workflow/review-output-correction-retry-provenance',
                title: taskSummary,
                profile: 'strict',
                notes: 'Bind retry rejection to the next selection predecessor package and exact next attempt.'
            },
            taskMode: {
                task_id: taskId,
                task_summary: taskSummary
            },
            preflight: buildBaselineOnlyPreflight(),
            auditedNoOpPassed: false
        });

        assert.equal(result?.nextGate, 'implementation');
        assert.match(result?.reason || '', /task has implementation intent/u);
    });

    it('routes a backlog implementation task without a whitelisted action before audited no-op', () => {
        const taskId = 'T-1013-2-3-1-2';
        const taskSummary =
            '[security] Isolate current and historical correction artifact-chain integrity validation';
        const result = buildBaselineOnlyPreImplementationRoute({
            repoRoot: process.cwd(),
            cliPrefix: 'node bin/garda.js',
            taskEntry: {
                taskId,
                status: 'IN_PROGRESS',
                area: 'workflow/review-output-correction-artifact-integrity',
                title: taskSummary,
                profile: 'strict',
                notes: 'Keep current and historical validators independently reviewable.'
            },
            taskMode: {
                task_id: taskId,
                task_summary: taskSummary
            },
            preflight: buildBaselineOnlyPreflight(),
            auditedNoOpPassed: false
        });

        assert.equal(result?.nextGate, 'implementation');
        assert.match(result?.reason || '', /task has implementation intent/u);
    });

    it('does not treat an ordinary decomposed F child as a review follow-up', () => {
        const taskId = 'T-ORDINARY-F1';
        const taskSummary = 'Implement the first ordinary decomposed work package';
        const result = buildBaselineOnlyPreImplementationRoute({
            repoRoot: process.cwd(),
            cliPrefix: 'node bin/garda.js',
            taskEntry: {
                taskId,
                status: 'IN_PROGRESS',
                area: 'workflow/decomposition',
                title: taskSummary,
                profile: 'balanced',
                notes: 'Child work package with no review follow-up provenance.'
            },
            taskMode: {
                task_id: taskId,
                task_summary: taskSummary
            },
            preflight: buildBaselineOnlyPreflight(),
            auditedNoOpPassed: false
        });

        assert.equal(result?.nextGate, 'implementation');
    });

    it('preserves explicit audit-only metadata as a no-op candidate', () => {
        const result = buildBaselineOnlyPreImplementationRoute({
            repoRoot: process.cwd(),
            cliPrefix: 'node bin/garda.js',
            taskEntry: {
                taskId: TASK_ID,
                status: 'IN_PROGRESS',
                area: 'workflow/audit-only',
                title: 'Audit-only: validate current closeout evidence',
                profile: 'strict',
                notes: null
            },
            taskMode: {
                task_id: TASK_ID,
                task_summary: 'Audit-only: validate current closeout evidence'
            },
            preflight: buildBaselineOnlyPreflight(),
            auditedNoOpPassed: false
        });

        assert.equal(result, null);
    });
});
