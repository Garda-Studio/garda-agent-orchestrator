import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE,
    createAuthenticatedNextStepStateProjection,
    selectNextStepDecision,
    type AuthenticatedNextStepStateProjection,
    type NextStepDecisionCandidate,
    type NextStepDecisionCheckpoint,
    type NextStepDecisionKind
} from '../../../../src/gates/next-step/next-step-decision-engine';

interface TestRoute {
    nextGate: string;
    commands: readonly string[];
}

const binding = Object.freeze({
    source: 'authenticated-resolution-context' as const,
    taskId: 'T-028',
    taskModePath: 'garda-agent-orchestrator/runtime/reviews/T-028-task-mode.json',
    preflightSha256: 'current-preflight-sha256'
});

function candidate(
    checkpoint: NextStepDecisionCheckpoint,
    kind: NextStepDecisionKind,
    nextGate: string,
    commands: readonly string[]
): NextStepDecisionCandidate<TestRoute> {
    return {
        checkpoint,
        kind,
        evaluation: 'evaluated',
        route: { nextGate, commands }
    };
}

function projectionThrough(
    evaluatedThrough: NextStepDecisionCheckpoint,
    resolved: Partial<Record<NextStepDecisionCheckpoint, NextStepDecisionCandidate<TestRoute>>> = {}
): AuthenticatedNextStepStateProjection<TestRoute> {
    const frontierIndex = NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE.indexOf(evaluatedThrough);
    return createAuthenticatedNextStepStateProjection({
        binding,
        candidates: NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE.map((checkpoint, index) => {
            if (index > frontierIndex) {
                return { checkpoint, kind: 'normal', evaluation: 'pending', route: null };
            }
            return resolved[checkpoint] ?? {
                checkpoint,
                kind: 'normal',
                evaluation: 'evaluated',
                route: null
            };
        })
    });
}

describe('next-step pure decision engine', () => {
    it('freezes a complete authenticated state projection without reading external state', () => {
        const projection = projectionThrough('validation', {
            validation: candidate('validation', 'normal', 'compile-gate', ['compile', 'next-step'])
        });

        assert.equal(projection.evidenceStatus, 'AUTHENTICATED');
        assert.equal(projection.candidates.length, NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE.length);
        assert.equal(Object.isFrozen(projection), true);
        assert.equal(Object.isFrozen(projection.binding), true);
        assert.equal(Object.isFrozen(projection.candidates), true);
        assert.equal(Object.isFrozen(projection.candidates[0]), true);
        assert.equal(Object.isFrozen(projection.candidates[14].route), true);
        assert.equal(Object.isFrozen(projection.candidates[14].route?.commands), true);
        assert.equal(projection.candidates[15].evaluation, 'pending');
    });

    it('records the coordinator checkpoint order before route selection', () => {
        assert.deepEqual(NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE, [
            'task-metadata-validation',
            'task-id-casing',
            'full-suite-repair-child',
            'task-queue-terminal',
            'completed-closeout',
            'startup',
            'classify',
            'optional-skill-selection',
            'protected-scope',
            'pre-guard',
            'scope-budget-guard',
            'review-cycle-guard',
            'strict-decomposition',
            'optional-skill-activation',
            'validation',
            'review-boundary',
            'active-review',
            'post-review'
        ]);
    });

    it('selects an earlier normal checkpoint before a later split checkpoint', () => {
        const startup = candidate('startup', 'normal', 'handshake-diagnostics', ['handshake']);
        const split = candidate('strict-decomposition', 'split', 'child-task', ['child']);
        const decision = selectNextStepDecision(projectionThrough('strict-decomposition', {
            startup,
            'strict-decomposition': split
        }));

        assert.equal(decision?.checkpoint, 'startup');
        assert.equal(decision?.kind, 'normal');
        assert.deepEqual(decision?.route, startup.route);
    });

    it('characterizes split, audited no-op, failed-review, and normal route progression', () => {
        const scenarios: Array<{
            frontier: NextStepDecisionCheckpoint;
            route: NextStepDecisionCandidate<TestRoute>;
            expectedKind: NextStepDecisionKind;
        }> = [
            {
                frontier: 'strict-decomposition',
                route: candidate('strict-decomposition', 'split', 'child-task', ['child-one', 'child-two']),
                expectedKind: 'split'
            },
            {
                frontier: 'validation',
                route: candidate('validation', 'audited-no-op', 'record-no-op', ['record-no-op']),
                expectedKind: 'audited-no-op'
            },
            {
                frontier: 'active-review',
                route: candidate('active-review', 'failed-review', 'review-remediation', ['fix', 'review']),
                expectedKind: 'failed-review'
            },
            {
                frontier: 'post-review',
                route: candidate('post-review', 'normal', 'doc-impact-gate', ['docs']),
                expectedKind: 'normal'
            }
        ];

        for (const scenario of scenarios) {
            const decision = selectNextStepDecision(projectionThrough(scenario.frontier, {
                [scenario.route.checkpoint]: scenario.route
            }));
            assert.equal(decision?.kind, scenario.expectedKind);
        }
    });

    it('snapshots the selected route and preserves command order', () => {
        const mutableRoute = {
            nextGate: 'review-remediation',
            commands: ['record-disposition', 'restart-review-cycle', 'next-step']
        };
        const projection = projectionThrough('active-review', {
            'active-review': {
                checkpoint: 'active-review',
                kind: 'failed-review',
                evaluation: 'evaluated',
                route: mutableRoute
            }
        });
        mutableRoute.nextGate = 'tampered';
        mutableRoute.commands.push('tampered');
        const decision = selectNextStepDecision(projection);

        assert.notStrictEqual(decision?.route, mutableRoute);
        assert.equal(decision?.route.nextGate, 'review-remediation');
        assert.deepEqual(decision?.route.commands, [
            'record-disposition',
            'restart-review-cycle',
            'next-step'
        ]);
    });

    it('rejects incomplete or non-contiguous checkpoint projections', () => {
        assert.throws(() => createAuthenticatedNextStepStateProjection<TestRoute>({
            binding,
            candidates: []
        }), /include every checkpoint exactly once/);
        assert.throws(() => createAuthenticatedNextStepStateProjection({
            binding,
            candidates: NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE.map((checkpoint, index) => ({
                checkpoint,
                kind: 'normal' as const,
                evaluation: index === 0 || index === 2 ? 'evaluated' as const : 'pending' as const,
                route: null
            }))
        }), /follows a pending checkpoint/);
    });

    it('fails closed when every evaluated route is absent', () => {
        assert.equal(selectNextStepDecision(projectionThrough('post-review')), null);
    });
});
