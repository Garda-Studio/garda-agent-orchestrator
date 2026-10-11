import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DecomposedParentAuditRequirements } from '../../../../src/gates/task-audit/task-audit-summary-types';

// The test-first cycle can exercise the new API before its module exists.
function planner(): (facts: Record<string, unknown>) => DecomposedParentAuditRequirements {
    let module: Record<string, unknown> = {};
    try {
        module = require('../../../../src/gates/task-audit/task-audit-summary-decomposed-parent');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    }
    assert.equal(typeof module.deriveDecomposedParentAuditRequirements, 'function',
        'decomposed parent requirements API must exist without generating a PASS');
    return module.deriveDecomposedParentAuditRequirements as ReturnType<typeof planner>;
}

function facts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        taskId: 'T-241-2', taskStatus: 'DONE',
        childTaskIds: ['T-241-2-R1', 'T-241-2-A1'],
        completedChildTaskIds: ['T-241-2-A1', 'T-241-2-R1'], childGraphComplete: true,
        decomposition: { taskId: 'T-241-2', sequence: 24, sha256: 'd'.repeat(64) },
        completion: { taskId: 'T-241-2', sequence: 30, sha256: 'e'.repeat(64) },
        historicalFailures: ['full-suite-validation'], fullSuiteRequired: true,
        projectMemoryRequired: true, ...overrides
    };
}

describe('decomposed parent audit requirements', () => {
    it('rejects forged acceptance from terminal queue rows by requiring proof', () => {
        const input = facts();
        const before = JSON.stringify(input);
        const result = planner()(input);
        assert.equal(result.status, 'REQUIRES_PROOF');
        assert.deepEqual(result.childTaskIds, ['T-241-2-R1', 'T-241-2-A1']);
        assert.deepEqual(result.requiredProofs, ['authenticated-decomposition',
            'source-qualified-child-acceptance', 'preserved-parent-wip',
            'full-suite-composition', 'parent-memory-impact', 'historical-failure-resolution']);
        assert.deepEqual(result.historicalFailures, ['full-suite-validation']);
        assert.equal(JSON.stringify(input), before);
        assert.equal(Object.values(result).includes('PASS'), false);
    });

    it('leaves an ordinary leaf audit unchanged', () => {
        const result = planner()(facts({ childTaskIds: [], completedChildTaskIds: [],
            decomposition: null, completion: null, childGraphComplete: false }));
        assert.equal(result.status, 'NOT_APPLICABLE');
        assert.deepEqual(result.historicalFailures, ['full-suite-validation']);
    });

    it('blocks a leaf projection with contradictory completed children', () => {
        const result = planner()(facts({ childTaskIds: [], completedChildTaskIds: ['T-241-2-R1'],
            decomposition: null, completion: null, childGraphComplete: false }));
        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.length > 0);
    });

    it('blocks sparse identity and failure projections without returning undefined entries', () => {
        for (const override of [{ childTaskIds: Array<string>(1), completedChildTaskIds: Array<string>(1) },
            { completedChildTaskIds: Array<string>(2) }, { historicalFailures: Array<string>(1) }]) {
            const result = planner()(facts(override));
            assert.equal(result.status, 'BLOCKED');
            assert.ok(result.violations.length > 0);
            assert.ok(result.childTaskIds.every((id) => typeof id === 'string'));
            assert.ok(result.historicalFailures.every((failure) => typeof failure === 'string'));
        }
    });

    it('rejects missing foreign or stale aggregate event projections', () => {
        assert.equal(planner()(facts({ decomposition: null })).status, 'BLOCKED');
        assert.equal(planner()(facts({ decomposition:
            { taskId: 'T-209', sequence: 24, sha256: 'd'.repeat(64) } })).status, 'BLOCKED');
        assert.equal(planner()(facts({ completion:
            { taskId: 'T-241-2', sequence: 23, sha256: 'e'.repeat(64) } })).status, 'BLOCKED');
    });

    const invalid = [
        { decomposition: null }, { completion: null },
        { decomposition: { taskId: 'T-209', sequence: 24, sha256: 'd'.repeat(64) } },
        { completion: { taskId: 'T-241-2', sequence: 23, sha256: 'e'.repeat(64) } },
        { completion: { taskId: 'T-241-2', sequence: 30, sha256: 'corrupt' } },
        { completedChildTaskIds: ['T-241-2-R1'] },
        { completedChildTaskIds: ['T-241-2-R1', 'T-209-1'] },
        { childTaskIds: ['T-241-2-R1', 'T-241-2-R1'] },
        { childTaskIds: ['T-241-2', 'T-241-2-A1'] },
        { childGraphComplete: false }, { taskStatus: 'DECOMPOSED' },
        { fullSuiteRequired: 'false' }, { projectMemoryRequired: 'false' }
    ];
    for (const [index, override] of invalid.entries()) {
        it(`blocks inconsistent aggregate facts ${index}`, () => {
            const result = planner()(facts(override));
            assert.equal(result.status, 'BLOCKED');
            assert.ok(result.violations.length > 0);
            assert.deepEqual(result.historicalFailures, ['full-suite-validation']);
        });
    }

    it('preserves a historical failed suite when the current suite is disabled', () => {
        const result = planner()(facts({ fullSuiteRequired: false, projectMemoryRequired: null }));
        assert.ok(result.requiredProofs.includes('full-suite-composition'));
        assert.ok(result.requiredProofs.includes('parent-memory-impact'));
    });

    it('requires no extra suite/memory proof only for an explicitly inapplicable obligation', () => {
        const result = planner()(facts({ historicalFailures: [], fullSuiteRequired: false,
            projectMemoryRequired: false }));
        assert.equal(result.status, 'REQUIRES_PROOF');
        assert.deepEqual(result.requiredProofs, ['authenticated-decomposition',
            'source-qualified-child-acceptance', 'preserved-parent-wip']);
    });
});
