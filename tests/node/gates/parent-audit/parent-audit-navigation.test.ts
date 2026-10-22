import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerParentCompletionContract, readParentQueue } from '../../../../src/gates/parent-audit/parent-audit-contract';
import { resolveParentAuditNavigation } from '../../../../src/gates/parent-audit/parent-audit-navigation';
import { createNextStepEffectPlanner } from '../../../../src/gates/next-step/next-step-effects';
import { transitionDecomposedParentsToDone } from '../../../../src/gates/next-step/next-step-task-queue-transitions';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { buildStrictDecompositionDecisionArtifact } from '../../../../src/gates/task-mode/strict-decomposition-decision';
import { parentDigest, readParentEvents } from '../../../../src/gates/parent-audit/parent-audit-auth';
import { cleanupParentFixtures, parentFixture, PARENT_ID } from './parent-audit-test-support';

afterEach(cleanupParentFixtures);

async function retainedNestedFixture() {
    const fixture = await parentFixture({ legacy: true, children: false });
    const outer = 'T-PARENT';
    fs.appendFileSync(path.join(fixture.root, 'TASK.md'),
        `| ${outer} | DECOMPOSED | P0 | test | Retained outer parent | local | 2026-10-21 | balanced | Decomposition source: orchestrator; child tasks: ${PARENT_ID}, ${outer}-2; |\n`
        + `| ${outer}-2 | DONE | P0 | test | Retained outer leaf | local | 2026-10-21 | balanced | Completed leaf. |\n`);
    appendMandatoryTaskEvent(fixture.bundle, outer, 'TASK_MODE_ENTERED', 'PASS', 'Isolated retained outer entry.', { dirty_workspace_baseline_count: 0 });
    const decision = buildStrictDecompositionDecisionArtifact({ taskId: outer, decision: 'split-required', taskProfile: 'balanced',
        taskSummary: 'Retained outer parent', reason: 'Two isolated child packages preserve the retained graph.', scopeRisk: 'Nested native parent acceptance.',
        expectedReviewTypes: ['code'], atomicityConstraints: ['Keep the original graph.'],
        workPackageContract: { schema_version: 2, finding_obligations: [], work_packages: [1, 2].map(index => ({
            task_id: `${outer}-${index}`, profile: 'balanced', root_cause_area: `retained-${index}`, objective: `Complete retained child ${index}.`,
            scope_obligations: [`Preserve child ${index}.`], validation_contract: ['Run native gates.'], finding_obligation_ids: [], required_review_types: ['code']
        })) } });
    const file = path.join(fixture.reviews, outer + '-strict-decomposition-decision.json');
    fs.writeFileSync(file, JSON.stringify(decision));
    appendMandatoryTaskEvent(fixture.bundle, outer, 'STRICT_DECOMPOSITION_DECISION_RECORDED', 'INFO', 'Isolated retained outer decision.', {
        artifact_path: file.replace(/\\/gu, '/'), artifact_sha256: parentDigest(fs.readFileSync(file)), decision: 'split-required', task_profile: 'balanced',
        task_summary_sha256: decision.task_summary_sha256, proposed_child_task_ids: decision.proposed_children.map(child => child.task_id),
        work_package_contract_sha256: decision.work_package_contract_sha256
    });
    return { ...fixture, outer };
}

test('retained nested runtime parents route compatibility before publishing DONE', async () => {
    const fixture = await retainedNestedFixture(), queue = readParentQueue(fixture.root), effects = createNextStepEffectPlanner();
    const route = resolveParentAuditNavigation({ repoRoot: fixture.root, taskId: fixture.outer, taskEntry: queue.entries.get(fixture.outer)!,
        taskEntries: queue.entries, cliPrefix: 'node bin/garda.js', eventsRoot: fixture.bundle + '/runtime/task-events', effects });
    assert.equal(route?.nextGate, 'child-task');
    assert.match(route!.commands[0].command, new RegExp(`next-step "${PARENT_ID}"`, 'u'));
    assert.equal(effects.pendingPlan(), null, 'unregistered native parents cannot schedule a DONE effect');
    const nested = resolveParentAuditNavigation({ repoRoot: fixture.root, taskId: PARENT_ID, taskEntry: queue.entries.get(PARENT_ID)!,
        taskEntries: queue.entries, cliPrefix: 'node bin/garda.js', eventsRoot: fixture.bundle + '/runtime/task-events' });
    assert.equal(nested!.nextGate, 'parent-audit');
    assert.match(nested!.commands[0].command, /--phase register.*--audit-enabled/u);
});

test('retained native parent cannot bypass SOURCE by erasing queue provenance before DONE', async () => {
    const fixture = await retainedNestedFixture(), file = path.join(fixture.root, 'TASK.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('Decomposition source: orchestrator; ', ''));
    const before = fs.readFileSync(file);
    const result = transitionDecomposedParentsToDone({ repoRoot: fixture.root, eventsRoot: fixture.bundle + '/runtime/task-events',
        rootTaskId: fixture.outer, taskIds: [PARENT_ID, fixture.outer] });
    assert.equal(result.outcome, 'write_failed');
    assert.match(result.error_message || '', /contract|SOURCE|compatibility/iu);
    assert.deepEqual(fs.readFileSync(file), before);
    for (const taskId of [PARENT_ID, fixture.outer]) {
        assert.equal(readParentEvents(fixture.root, taskId).some(event => event.event_type === 'DECOMPOSED_PARENT_COMPLETED'), false);
    }
});

test('outer grouping cannot skip a nested parent whose leaves are DONE but audit is pending', async () => {
    const fixture = await parentFixture({ enabled: true }); registerParentCompletionContract(fixture.root, PARENT_ID);
    const outer = 'T-GROUP-1';
    fs.appendFileSync(path.join(fixture.root, 'TASK.md'),
        `| ${outer} | DECOMPOSED | P0 | test | Outer manual group | local | 2026-10-21 | balanced | Decomposition source: manual-operator; child tasks: ${PARENT_ID}, ${PARENT_ID}-1; |\n`);
    const queue = readParentQueue(fixture.root);
    const route = resolveParentAuditNavigation({ repoRoot: fixture.root, taskId: outer, taskEntry: queue.entries.get(outer)!,
        taskEntries: queue.entries, cliPrefix: 'node bin/garda.js', eventsRoot: fixture.bundle + '/runtime/task-events' });
    assert.equal(route!.nextGate, 'child-task');
    assert.match(route!.commands[0].command, new RegExp(`next-step "${PARENT_ID}"`, 'u'));
    assert.doesNotMatch(route!.commands[0].command, /complete-decomposed-parents/u);
});

test('manual grouping plans automatic completion without launching an aggregate reviewer', async () => {
    const fixture = await parentFixture({ origin: 'manual', enabled: true }); registerParentCompletionContract(fixture.root, PARENT_ID);
    const queue = readParentQueue(fixture.root), effects = createNextStepEffectPlanner();
    const route = resolveParentAuditNavigation({ repoRoot: fixture.root, taskId: PARENT_ID, taskEntry: queue.entries.get(PARENT_ID)!,
        taskEntries: queue.entries, cliPrefix: 'node bin/garda.js', eventsRoot: fixture.bundle + '/runtime/task-events', effects });
    assert.equal(route!.nextGate, null);
    assert.deepEqual(route!.commands, []);
    assert.equal(effects.pendingPlan()!.effects[0].kind, 'complete-accepted-parent');
});

test('runtime grouping with audit enabled routes directly to one aggregate review', async () => {
    const fixture = await parentFixture({ enabled: true }); registerParentCompletionContract(fixture.root, PARENT_ID);
    const queue = readParentQueue(fixture.root);
    const route = resolveParentAuditNavigation({ repoRoot: fixture.root, taskId: PARENT_ID, taskEntry: queue.entries.get(PARENT_ID)!,
        taskEntries: queue.entries, cliPrefix: 'node bin/garda.js', eventsRoot: fixture.bundle + '/runtime/task-events' });
    assert.equal(route!.nextGate, 'parent-audit');
    assert.match(route!.commands[0].command, /--phase prepare/u);
    assert.doesNotMatch(route!.commands[0].command, /unrelated-previous-task/u);
});
