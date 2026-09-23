import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assertLaunchableReviewerSubagents,
    assertResolvedRuntimeIdentityForDependentPreflightGate,
    assertTaskModeRuntimeIdentity,
    buildTaskModeIdentitySuggestionCommand,
    resolveTaskModeReviewerRoutingFields
} from '../../../../../../src/cli/commands/gate-flows/task-mode/task-mode-runtime-identity';

const REPO_ROOT = process.cwd();
const TASK_ID = 'T-101';

function routingDecision(overrides: Record<string, unknown> = {}): never {
    return {
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        identityStatus: 'resolved',
        violations: [],
        reviewerSubagentLaunchStatus: 'launchable',
        reviewerSubagentLaunchRoute: 'AGENTS.md',
        ...overrides
    } as never;
}

test('runtime identity exposes routing policy only for a resolved provider', () => {
    assert.deepEqual(resolveTaskModeReviewerRoutingFields(null), {
        reviewerCapabilityLevel: null,
        reviewerExpectedExecutionMode: null,
        reviewerFallbackAllowed: null,
        reviewerFallbackReasonRequired: null
    });
    assert.equal(resolveTaskModeReviewerRoutingFields('Codex').reviewerExpectedExecutionMode, 'delegated_subagent');
});

test('task-mode identity allows launchable routing and blocks missing or contradictory identity', () => {
    assert.doesNotThrow(() => assertTaskModeRuntimeIdentity(REPO_ROOT, TASK_ID, routingDecision()));
    assert.throws(() => assertTaskModeRuntimeIdentity(
        REPO_ROOT,
        TASK_ID,
        routingDecision({ canonicalSourceOfTruth: null })
    ), /Canonical SourceOfTruth is missing/u);
    assert.throws(() => assertTaskModeRuntimeIdentity(
        REPO_ROOT,
        TASK_ID,
        routingDecision({ identityStatus: 'contradictory', violations: ['Provider route mismatch.'] })
    ), /Provider route mismatch/u);
    assert.throws(() => assertTaskModeRuntimeIdentity(
        REPO_ROOT,
        TASK_ID,
        routingDecision({ reviewerSubagentLaunchStatus: 'unavailable' })
    ), /Reviewer subagent launchability is 'unavailable'/u);
});

test('dependent preflight gates reject unavailable reviewer launch and retain rerun guidance', () => {
    assert.doesNotThrow(() => assertResolvedRuntimeIdentityForDependentPreflightGate(
        REPO_ROOT,
        TASK_ID,
        'compile-gate',
        routingDecision()
    ));
    assert.throws(() => assertResolvedRuntimeIdentityForDependentPreflightGate(
        REPO_ROOT,
        TASK_ID,
        'compile-gate',
        routingDecision({ reviewerSubagentLaunchStatus: 'unavailable' })
    ), /Reviewer subagent launchability is 'unavailable'.*Suggested commands:/u);
    assert.throws(() => assertLaunchableReviewerSubagents(
        REPO_ROOT,
        TASK_ID,
        'during test',
        routingDecision({ reviewerSubagentLaunchStatus: 'unavailable' })
    ), /Suggested command:/u);
});

test('contradictory identity does not copy an untrusted route into the suggested command', () => {
    const command = buildTaskModeIdentitySuggestionCommand(
        REPO_ROOT,
        TASK_ID,
        routingDecision({ identityStatus: 'contradictory', reviewerSubagentLaunchRoute: 'untrusted-route' })
    );
    assert.match(command, /--provider/u);
    assert.doesNotMatch(command, /--routed-to/u);
    assert.match(buildTaskModeIdentitySuggestionCommand(REPO_ROOT, TASK_ID, routingDecision()), /--routed-to/u);
});
