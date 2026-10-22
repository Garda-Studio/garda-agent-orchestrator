import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveNextStepCompileGateRoute,
    resolveNextStepPreGuardRoute,
    type NextStepPreGuardRoutingOptions
} from '../../../../src/gates/next-step/next-step-pre-review-routing';

function basePreGuardOptions(overrides?: Partial<NextStepPreGuardRoutingOptions>): NextStepPreGuardRoutingOptions {
    return {
        preflightCycleReadiness: {
            ready: true,
            reason: 'preflight cycle ready'
        },
        preflightCycleRefreshCommand: 'node bin/garda.js gate classify-change --task-id "T-1"',
        protectedControlPlane: {
            touched: false,
            taskModeHasOrchestratorWork: false,
            selfGuardDeny: false,
            selfGuardGuidance: 'operator maintenance required',
            selfGuardPolicyChangeCommand: 'node bin/garda.js workflow set --garda-self-guard off',
            orchestratorWorkRestartCommand: 'node bin/garda.js gate enter-task-mode --orchestrator-work'
        },
        workspaceReadiness: {
            ready: true,
            reason: 'workspace ready'
        },
        workspaceRefreshCommand: 'node bin/garda.js gate classify-change --changed-file src/gates/next-step/next-step.ts',
        coherentCycleReadiness: {
            ready: true,
            reason: 'coherent'
        },
        navigatorCommand: 'node bin/garda.js next-step "T-1" --repo-root "."',
        postPreflightRulePack: {
            stage: 'POST_PREFLIGHT',
            ready: true,
            reason: 'post-preflight ready',
            canBind: false,
            loadCommand: 'node bin/garda.js gate load-rule-pack --stage POST_PREFLIGHT',
            bindCommand: 'node bin/garda.js gate bind-rule-pack-to-preflight'
        },
        ...overrides
    };
}

test('resolveNextStepPreGuardRoute prioritizes task-cycle preflight refresh before protected-scope routing', () => {
    const route = resolveNextStepPreGuardRoute(basePreGuardOptions({
        preflightCycleReadiness: {
            ready: false,
            reason: 'preflight is stale for latest task mode'
        },
        protectedControlPlane: {
            ...basePreGuardOptions().protectedControlPlane,
            touched: true
        }
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'classify-change');
    assert.equal(route.title, 'Refresh preflight for the current task cycle.');
    assert.equal(route.commands[0].label, 'Refresh preflight');
});

test('resolveNextStepPreGuardRoute routes protected control-plane scope through operator maintenance when self-guard denies entry', () => {
    const route = resolveNextStepPreGuardRoute(basePreGuardOptions({
        protectedControlPlane: {
            ...basePreGuardOptions().protectedControlPlane,
            touched: true,
            selfGuardDeny: true
        }
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'operator-maintenance');
    assert.equal(route.commands[0].label, 'Operator policy change');
    assert.match(route.reason, /protected Garda control-plane files/);
});

test('resolveNextStepPreGuardRoute blocks frozen deferred findings before ordinary workspace refresh', () => {
    const route = resolveNextStepPreGuardRoute(basePreGuardOptions({
        postReviewSourceMutationGuard: {
            blocked: true,
            reason: 'accepted create_follow_up evidence freezes parent source remediation'
        },
        workspaceReadiness: {
            ready: false,
            reason: 'workspace source hash changed'
        }
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'post-review-source-mutation-guard');
    assert.equal(route.title, 'Stop unauthorized post-review source mutation.');
    assert.equal(route.commands.length, 0);
    assert.match(route.reason, /freezes parent source remediation/);
});

test('resolveNextStepPreGuardRoute keeps authenticated failed-review remediation ahead of ordinary workspace refresh', () => {
    const route = resolveNextStepPreGuardRoute(basePreGuardOptions({
        postReviewSourceMutationGuard: {
            blocked: false,
            reason: 'current fix_now transition is authenticated'
        },
        workspaceReadiness: {
            ready: false,
            reason: 'workspace source hash changed'
        },
        failedReviewRemediation: {
            reviewType: 'test',
            verdictToken: 'TEST REVIEW FAILED',
            restartReviewCycleCommand: 'node bin/garda.js gate restart-review-cycle --task-id "T-1"'
        }
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'restart-review-cycle');
    assert.match(route.reason, /failed 'test' review verdict/);
});

test('resolveNextStepPreGuardRoute uses coherent restart after a closed review boundary', () => {
    const route = resolveNextStepPreGuardRoute(basePreGuardOptions({
        workspaceReadiness: {
            ready: false,
            reason: 'workspace source hash changed'
        },
        failedReviewRemediation: {
            reviewType: 'code',
            verdictToken: 'CODE REVIEW FAILED',
            restartReviewCycleCommand: 'node bin/garda.js gate restart-review-cycle --task-id "T-1"',
            closedCycleRestart: {
                boundary: 'REVIEW_GATE_PASSED',
                command: 'node bin/garda.js gate restart-coherent-cycle --task-id "T-1"'
            }
        }
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'restart-coherent-cycle');
    assert.match(route.reason, /already crossed REVIEW_GATE_PASSED/u);
    assert.match(route.commands[0]?.command || '', /gate restart-coherent-cycle/u);
    assert.doesNotMatch(route.commands[0]?.command || '', /gate restart-review-cycle/u);
});

test('resolveNextStepPreGuardRoute repairs an incoherent diagnostic prefix before stale workspace reclassification', () => {
    const command = 'node bin/garda.js gate restart-coherent-cycle --task-id "T-1"';
    const route = resolveNextStepPreGuardRoute(basePreGuardOptions({
        workspaceReadiness: { ready: false, reason: 'scope changed after the last preflight' },
        coherentCycleReadiness: { ready: false, reason: 'handshake and shell smoke are missing inside the current cycle', command }
    }));
    assert.ok(route);
    assert.equal(route.nextGate, 'restart-coherent-cycle');
    assert.equal(route.commands.length, 1);
    assert.equal(route.commands[0].command, command);
    assert.doesNotMatch(route.commands[0].command, /gate classify-change/u);
});

test('resolveNextStepPreGuardRoute preserves POST_PREFLIGHT rebind route wording and command label', () => {
    const route = resolveNextStepPreGuardRoute(basePreGuardOptions({
        postPreflightRulePack: {
            ...basePreGuardOptions().postPreflightRulePack,
            stage: 'POST_PREFLIGHT',
            ready: false,
            canBind: true,
            rebindReason: 'Rule file hashes match.'
        }
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'bind-rule-pack-to-preflight');
    assert.equal(route.title, 'Bind existing POST_PREFLIGHT rule-pack evidence to the current preflight.');
    assert.equal(route.commands[0].label, 'Bind POST_PREFLIGHT rules to current preflight');
    assert.match(route.reason, /Rule file hashes match/);
});

test('resolveNextStepCompileGateRoute returns preflight refresh for compile scope drift', () => {
    const route = resolveNextStepCompileGateRoute({
        compileGatePassed: false,
        ready: false,
        reason: 'Compile gate failed because the preflight scope is stale.',
        recoveryGate: 'classify-change',
        restartTaskModeCommand: 'node bin/garda.js gate enter-task-mode --orchestrator-work',
        refreshPreflightCommand: 'node bin/garda.js gate classify-change --changed-file src/gates/next-step/next-step.ts',
        compileCommand: 'node bin/garda.js gate compile-gate --task-id "T-1"'
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'classify-change');
    assert.equal(route.title, 'Refresh preflight after compile scope drift.');
    assert.equal(route.commands[0].label, 'Refresh preflight');
});

test('resolveNextStepCompileGateRoute returns null only when compile gate passed and readiness is current', () => {
    assert.equal(resolveNextStepCompileGateRoute({
        compileGatePassed: true,
        ready: true,
        reason: 'ready',
        restartTaskModeCommand: 'restart',
        refreshPreflightCommand: 'refresh',
        compileCommand: 'compile'
    }), null);
});
