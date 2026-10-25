import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { initGitRepo } from '../git-fixtures';
import { resolveNextStep } from './next-step-test-support';
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

function routeFor(parentStatus: string, linkedChildren = true) {
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
        [TASK_ID, entry(TASK_ID, parentStatus, linkedChildren ? `Child tasks: ${childIds.join(', ')}` : 'Awaiting child task publication')],
        [childIds[0], entry(childIds[0], 'IN_PROGRESS', `Parent: ${TASK_ID}`)],
        [childIds[1], entry(childIds[1], 'TODO', `Parent: ${TASK_ID}`)]
    ]);
    if (!linkedChildren) for (const childId of childIds) taskEntries.delete(childId);
    const kinds: string[] = [];
    const route = resolveStrictDecompositionContinuationRoute({
        repoRoot, eventsRoot: eventsRoot(repoRoot), taskEntries, taskId: TASK_ID, cliPrefix: 'node bin/garda.js',
        requirement: { required: true, taskSummary: 'Seeded next-step task', taskProfile: 'strict',
            taskDecompositionProvenance: 'profile', riskSignals: [] },
        requiredReviewTypes: ['code'], baseMissingArtifacts: [], basePresentArtifacts: [],
        effects: recordingEffects(kinds)
    });
    return { route, kinds, repoRoot, childIds };
}

describe('gates/next-step strict decomposition after the split', () => {
    it('does not offer parent WIP capture or a second DECOMPOSED transition once the parent is decomposed', () => {
        const { route, kinds } = routeFor('DECOMPOSED');
        assert.ok(route, 'the split route continues to the child');
        assert.ok(!kinds.includes('suspend-strict-decomposition-wip'), JSON.stringify(kinds));
        assert.ok(!kinds.includes('transition-strict-decomposition-parent-to-decomposed'), JSON.stringify(kinds));
    });

    it('resolveNextStep leaves active child changes untouched when the terminal route sees a decomposed parent', () => {
        const { repoRoot, childIds } = routeFor('DECOMPOSED');
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
            `| ${TASK_ID} | DECOMPOSED | P1 | workflow | Parent | agent | 2026-10-25 | strict | Child tasks: ${childIds.join(', ')} |`,
            `| ${childIds[0]} | IN_PROGRESS | P1 | workflow | Active child | agent | 2026-10-25 | strict | Parent: ${TASK_ID} |`,
            `| ${childIds[1]} | TODO | P1 | workflow | Next child | agent | 2026-10-25 | strict | Parent: ${TASK_ID} |`, ''
        ].join('\n'));
        initGitRepo(repoRoot, { gitignoreContent: 'TASK.md\ngarda-agent-orchestrator/runtime/\n' });
        const childFile = path.join(repoRoot, 'src/app.ts');
        const childBytes = 'export const childImplementation = 2;\n';
        fs.writeFileSync(childFile, childBytes);
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(result.next_gate, 'child-task', JSON.stringify(result));
        assert.ok(result.commands[0]?.command.includes(childIds[0]), JSON.stringify(result.commands));
        assert.ok(!JSON.stringify(result).includes('suspend-strict-decomposition-wip'), JSON.stringify(result));
        assert.equal(fs.readFileSync(childFile, 'utf8'), childBytes);
    });

    it('still offers the guarded parent WIP capture before child links are published', () => {
        const { kinds } = routeFor('IN_PROGRESS', false);
        assert.ok(kinds.includes('suspend-strict-decomposition-wip'), JSON.stringify(kinds));
    });
});
