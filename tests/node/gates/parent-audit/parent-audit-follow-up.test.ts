import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerParentCompletionContract } from '../../../../src/gates/parent-audit/parent-audit-contract';
import { prepareParentAuditReview, recordParentReviewerStarted } from '../../../../src/gates/parent-audit/parent-audit-inputs';
import { completeParentAuditReview } from '../../../../src/gates/parent-audit/parent-audit-review';
import { parentRecordDigest, readParentEvents } from '../../../../src/gates/parent-audit/parent-audit-auth';
import { inspectParentCompletion } from '../../../../src/gates/parent-audit/parent-audit-state';
import { parseTaskQueueEntriesFromContent } from '../../../../src/core/task-queue-read';
import { resolveCanonicalTaskPlanPath } from '../../../../src/core/task-plan-read';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { runRecordStrictDecompositionDecisionCommand } from '../../../../src/cli/commands/gates';
import { materializeSplitRequiredLatch } from '../../../../src/gates/next-step/next-step-split-required-latch';
import { isParentAuditFollowUp } from '../../../../src/gates/parent-audit/parent-audit-follow-up';
import { syncTaskQueueStatusDetailed } from '../../../../src/cli/commands/gate-flows/task/task-queue-sync';
import { cleanupParentFixtures, parentFixture, PARENT_ID, outputFor, publishChild, git } from './parent-audit-test-support';

afterEach(cleanupParentFixtures);

async function groupedCorrectionFixture() {
    const fixture = await parentFixture({ enabled: true });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    const input = prepareParentAuditReview(fixture.root, PARENT_ID);
    recordParentReviewerStarted(fixture.root, PARENT_ID, 'agent:correction-stability-reviewer', parentRecordDigest(input), 'collaboration.spawn_agent');
    fs.writeFileSync(input.output_path, JSON.stringify(outputFor(input, true)));
    const result = completeParentAuditReview(fixture.root, PARENT_ID, 'agent:correction-stability-reviewer');
    const followUpTaskId = result.follow_up_task_id!;
    return { ...fixture, followUpTaskId };
}

async function acceptedCorrectionFixture() {
    const fixture = await groupedCorrectionFixture();
    const { followUpTaskId } = fixture;
    const queue = path.join(fixture.root, 'TASK.md');
    fs.writeFileSync(queue, fs.readFileSync(queue, 'utf8').split('\n').map(line => {
        if (!line.startsWith('| ' + followUpTaskId + ' ')) return line;
        const cells = line.split('|'); cells[2] = ' DONE '; return cells.join('|');
    }).join('\n'));
    await publishChild(fixture.root, followUpTaskId, 'first.ts', 'export const first = 3;\n');
    return { ...fixture, followUpTaskId };
}

async function assertCorrectionDecomposition(producer: 'strict' | 'guard') {
    const fixture = await groupedCorrectionFixture();
    const taskId = fixture.followUpTaskId;
    assert.equal(JSON.parse(fs.readFileSync(fixture.config, 'utf8')).parent_audit.enabled, true);
    assert.equal(isParentAuditFollowUp(fixture.root, taskId), true);
    let artifactPath: string;
    if (producer === 'strict') {
        const contractPath = path.join(fixture.reviews, taskId + '-work-packages.json');
        fs.writeFileSync(contractPath, JSON.stringify({ schema_version: 2, finding_obligations: [],
            work_packages: [1, 2].map(index => ({ task_id: `${taskId}-${index}`, profile: 'strict',
                root_cause_area: `correction-${index}`, objective: `Correct frozen finding area ${index}.`,
                scope_obligations: [`Preserve original correction obligation ${index}.`],
                validation_contract: ['Run ordinary tests and independent reviews.'],
                finding_obligation_ids: [], required_review_types: ['code'] })) }));
        const result = runRecordStrictDecompositionDecisionCommand({ repoRoot: fixture.root, taskId,
            decision: 'split-required', taskProfile: 'strict', taskSummary: 'Resolve both frozen finding areas.',
            reason: 'Two independent correction areas require separate children.', scopeRisk: 'Keep the consumed aggregate audit closed.',
            expectedReviewTypes: ['code'], atomicityConstraints: ['Preserve all original frozen findings.'],
            workPackageContractPath: contractPath });
        assert.equal(result.exitCode, 0);
        artifactPath = path.join(fixture.reviews, taskId + '-strict-decomposition-decision.json');
    } else {
        assert.equal(syncTaskQueueStatusDetailed(fixture.root, taskId, 'IN_PROGRESS').outcome, 'updated');
        const preflightPath = path.join(fixture.reviews, taskId + '-preflight.json');
        fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId, changed_files: [],
            metrics: { changed_files_count: 0, changed_lines_total: 0, actual_changed_files: [] } }));
        const result = materializeSplitRequiredLatch({ repoRoot: fixture.root,
            eventsRoot: path.join(fixture.bundle, 'runtime/task-events'), reviewsRoot: fixture.reviews,
            taskId, guardKind: 'scope_budget', guardReason: 'Correction requires bounded child work.',
            rawGuardSummary: 'Correction requires bounded child work.', preflightPath, guardDetails: {} });
        assert.equal(result.latch_event_recorded, true, JSON.stringify(result));
        artifactPath = result.artifact_path;
    }
    const frozen = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.deepEqual(frozen.parent_completion_policy, { schema_version: 1, origin: 'runtime', audit_enabled: false });
    assert.equal(readParentEvents(fixture.root, PARENT_ID).filter(event => event.event_type === 'PARENT_AUDIT_RECORD_PUBLISHED'
        && (event.details as Record<string, unknown>).kind === 'review-observation').length, 1);
    assert.throws(() => prepareParentAuditReview(fixture.root, PARENT_ID), /already completed/iu);
}

test('strict decomposition of an authenticated grouped F-task disables recursive audit with the global switch enabled', async () => {
    await assertCorrectionDecomposition('strict');
});

test('guard decomposition of an authenticated grouped F-task disables recursive audit with the global switch enabled', async () => {
    await assertCorrectionDecomposition('guard');
});

test('final parent stability requalifies grouped correction SOURCE after its initial read', async () => {
    const fixture = await acceptedCorrectionFixture();
    const graph = require('../../../../src/gates/parent-audit/parent-audit-graph');
    const readAccepted = graph.readAcceptedParentChildren;
    let revoked = false;
    mock.method(graph, 'readAcceptedParentChildren', (root: string, contract: { child_task_ids: string[] }) => {
        const sources = readAccepted(root, contract);
        if (!revoked && contract.child_task_ids.includes(fixture.followUpTaskId)) {
            revoked = true;
            appendMandatoryTaskEvent(fixture.bundle, fixture.followUpTaskId, 'TASK_MODE_ENTERED', 'PASS', 'Revoke correction SOURCE during final parent stability qualification.', {});
        }
        return sources;
    });
    assert.throws(() => inspectParentCompletion(fixture.root, PARENT_ID), /stale.*child cycle|SOURCE changed/iu);
    assert.equal(revoked, true);
});

test('final parent stability rejects a changed clean HEAD after child SOURCE qualification', async () => {
    const fixture = await acceptedCorrectionFixture();
    const graph = require('../../../../src/gates/parent-audit/parent-audit-graph');
    const capture = graph.captureParentSource;
    let captures = 0;
    mock.method(graph, 'captureParentSource', (root: string) => {
        if (++captures === 2) {
            const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
            const unrelated = git(root, ['commit-tree', tree, '-m', 'isolated unrelated root with identical source tree']);
            git(root, ['update-ref', 'HEAD', unrelated]);
        }
        return capture(root);
    });
    assert.throws(() => inspectParentCompletion(fixture.root, PARENT_ID), /Git.*source.*changed|HEAD.*changed/iu);
    assert.equal(captures, 2);
});

test('one grouped F-task covers every finding and accepted SOURCE closes the parent without another audit', async () => {
    const fixture = await parentFixture({ enabled: true }); registerParentCompletionContract(fixture.root, PARENT_ID);
    const input = prepareParentAuditReview(fixture.root, PARENT_ID);
    recordParentReviewerStarted(fixture.root, PARENT_ID, 'agent:isolated-reviewer', parentRecordDigest(input), 'collaboration.spawn_agent');
    const output = outputFor(input, true);
    output.findings.push({ ...output.findings[0], id: 'F-002', title: 'A second mandatory correction' });
    output.requirements.forEach(row => row.finding_ids.push('F-002'));
    fs.writeFileSync(input.output_path, JSON.stringify(output));
    const result = completeParentAuditReview(fixture.root, PARENT_ID, 'agent:isolated-reviewer');
    assert.equal(result.follow_up_task_id, PARENT_ID + '-F1');
    assert.equal(completeParentAuditReview(fixture.root, PARENT_ID, 'agent:isolated-reviewer').follow_up_task_id, result.follow_up_task_id);
    const queue = path.join(fixture.root, 'TASK.md');
    const entries = parseTaskQueueEntriesFromContent(fs.readFileSync(queue, 'utf8'));
    assert.equal([...entries.keys()].filter(id => /-F[0-9]+$/u.test(id)).length, 1);
    assert.equal(entries.get(result.follow_up_task_id!)!.profile, 'strict', 'ordinary correction findings must be fixed in the same F-task');
    const plan = JSON.parse(fs.readFileSync(resolveCanonicalTaskPlanPath(fixture.root, result.follow_up_task_id!), 'utf8'));
    assert.equal(plan.acceptance_criteria.length, 2);
    assert.match(plan.acceptance_criteria.join(' '), /F-001.*F-002/u);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
    // Isolated queue finalization fixture; native SOURCE still has to be published and authenticated below.
    fs.writeFileSync(queue, fs.readFileSync(queue, 'utf8').split('\n').map(line => {
        if (!line.startsWith('| ' + result.follow_up_task_id + ' ')) return line;
        const cells = line.split('|'); cells[2] = ' DONE '; return cells.join('|');
    }).join('\n'));
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false, 'DONE text alone is insufficient for the F-task too');
    await publishChild(fixture.root, result.follow_up_task_id!, 'first.ts', 'export const first = 3;\n');
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, true);
    assert.equal(readParentEvents(fixture.root, PARENT_ID).filter(event => event.event_type === 'PARENT_AUDIT_RECORD_PUBLISHED'
        && (event.details as Record<string, unknown>).kind === 'review-observation').length, 1);
    assert.throws(() => prepareParentAuditReview(fixture.root, PARENT_ID), /already completed/iu);
});

test('editing the frozen F-task acceptance plan blocks parent completion', async () => {
    const fixture = await parentFixture({ enabled: true }); registerParentCompletionContract(fixture.root, PARENT_ID);
    const input = prepareParentAuditReview(fixture.root, PARENT_ID);
    recordParentReviewerStarted(fixture.root, PARENT_ID, 'agent:isolated-reviewer', parentRecordDigest(input), 'collaboration.spawn_agent');
    fs.writeFileSync(input.output_path, JSON.stringify(outputFor(input, true)));
    const result = completeParentAuditReview(fixture.root, PARENT_ID, 'agent:isolated-reviewer');
    fs.writeFileSync(resolveCanonicalTaskPlanPath(fixture.root, result.follow_up_task_id!), '{}');
    const inspection = inspectParentCompletion(fixture.root, PARENT_ID)!;
    assert.equal(inspection.ready, false);
    assert.match(inspection.violations.join(' '), /evidence binding/iu);
});
