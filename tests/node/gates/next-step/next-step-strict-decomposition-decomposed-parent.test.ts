import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import type { TaskQueueEntry } from '../../../../src/core/task-queue-read';
import type { NextStepEffectController } from '../../../../src/gates/next-step/next-step-effects';
import { resolveStrictDecompositionContinuationRoute } from '../../../../src/gates/next-step/next-step-strict-decomposition-routing';
import { buildStrictDecompositionDecisionArtifact } from '../../../../src/gates/task-mode/strict-decomposition-decision';
import { TASK_ID, makeTempRepo, eventsRoot, reviewsRoot, writeJson, seedStartedTask } from './next-step-completion-fixtures';

function recordingEffects(kinds: string[]): NextStepEffectController {
    return {
        run(definition) {
            kinds.push(definition.kind);
            return definition.preview();
        },
        pendingPlan: () => null,
        executedCount: () => 0
    };
}

function routeFor(parentStatus: string) {
    const repoRoot = makeTempRepo();
    seedStartedTask(repoRoot, TASK_ID);
    const childIds = [`${TASK_ID}-1`, `${TASK_ID}-2`];
    writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-strict-decomposition-decision.json`), buildStrictDecompositionDecisionArtifact({
        taskId: TASK_ID, decision: 'split-required', taskProfile: 'strict', taskSummary: 'Seeded next-step task',
        reason: 'Two independent root causes need separate child tasks.',
        scopeRisk: 'Each child keeps its own review gates.', expectedReviewTypes: ['code'],
        atomicityConstraints: ['Each package lands with its own regression.'],
        proposedChildTaskIds: childIds,
        workPackageContract: {
            schema_version: 1,
            finding_obligations: [],
            work_packages: childIds.map((taskId, index) => ({
                task_id: taskId, profile: 'strict', root_cause_area: `root-cause-${index + 1}`,
                objective: `Implement independently executable root-cause package ${index + 1}.`,
                scope_obligations: [`Preserve bounded parent scope obligation ${index + 1}.`],
                validation_contract: [`Validate root-cause package ${index + 1} independently.`],
                finding_obligation_ids: [], required_review_types: ['code']
            }))
        }
    } as Parameters<typeof buildStrictDecompositionDecisionArtifact>[0]));
    const entry = (taskId: string, status: string, notes: string): TaskQueueEntry => ({
        taskId, status, area: 'workflow', title: taskId, profile: 'strict', notes
    });
    const taskEntries = new Map<string, TaskQueueEntry>([
        [TASK_ID, entry(TASK_ID, parentStatus, `Child tasks: ${childIds.join(', ')}`)],
        [childIds[0], entry(childIds[0], 'IN_PROGRESS', `Parent: ${TASK_ID}`)],
        [childIds[1], entry(childIds[1], 'TODO', `Parent: ${TASK_ID}`)]
    ]);
    const kinds: string[] = [];
    const route = resolveStrictDecompositionContinuationRoute({
        repoRoot, eventsRoot: eventsRoot(repoRoot), taskEntries, taskId: TASK_ID, cliPrefix: 'node bin/garda.js',
        requirement: { required: true, taskSummary: 'Seeded next-step task', taskProfile: 'strict',
            taskDecompositionProvenance: 'profile', riskSignals: [] },
        requiredReviewTypes: ['code'], baseMissingArtifacts: [], basePresentArtifacts: [],
        effects: recordingEffects(kinds)
    });
    return { route, kinds };
}

describe('gates/next-step strict decomposition after the split', () => {
    it('does not offer parent WIP capture or a second DECOMPOSED transition once the parent is decomposed', () => {
        const { route, kinds } = routeFor('DECOMPOSED');
        assert.ok(route, 'the split route continues to the child');
        assert.ok(!kinds.includes('suspend-strict-decomposition-wip'), JSON.stringify(kinds));
        assert.ok(!kinds.includes('transition-strict-decomposition-parent-to-decomposed'), JSON.stringify(kinds));
    });

    it('still offers the guarded parent WIP capture before the split', () => {
        const { kinds } = routeFor('IN_PROGRESS');
        assert.ok(kinds.includes('suspend-strict-decomposition-wip'), JSON.stringify(kinds));
    });
});
