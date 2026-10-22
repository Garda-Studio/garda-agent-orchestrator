import { afterEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerParentCompletionContract, readParentQueue } from '../../../../src/gates/parent-audit/parent-audit-contract';
import { resolveParentAuditNavigation } from '../../../../src/gates/parent-audit/parent-audit-navigation';
import { prepareParentAuditReview, recordParentReviewerStarted, recordParentReviewerFailed } from '../../../../src/gates/parent-audit/parent-audit-inputs';
import { completeParentAuditReview } from '../../../../src/gates/parent-audit/parent-audit-review';
import { parentRecordDigest, readParentRecord } from '../../../../src/gates/parent-audit/parent-audit-auth';
import * as parentEvidence from '../../../../src/gates/parent-audit/parent-audit-evidence';
import { inspectParentCompletion } from '../../../../src/gates/parent-audit/parent-audit-state';
import { cleanupParentFixtures, parentFixture, PARENT_ID, outputFor, git } from './parent-audit-test-support';

afterEach(cleanupParentFixtures);

async function assertSourceDriftRejectsFirstObservation(context: TestContext, findings: boolean): Promise<void> {
    const fixture = await parentFixture({ enabled: true }); registerParentCompletionContract(fixture.root, PARENT_ID);
    const input = prepareParentAuditReview(fixture.root, PARENT_ID), identity = 'agent:source-read-reviewer';
    recordParentReviewerStarted(fixture.root, PARENT_ID, identity, parentRecordDigest(input), 'collaboration.spawn_agent');
    fs.writeFileSync(input.output_path, JSON.stringify(outputFor(input, findings)));
    const readOutput = parentEvidence.readParentOutput;
    let outputRead = false;
    context.mock.method(parentEvidence, 'readParentOutput', (root: string, prepared: typeof input) => {
        const result = readOutput(root, prepared);
        outputRead = true;
        fs.writeFileSync(path.join(root, 'first.ts'), 'export const first = 99;\n');
        git(root, ['add', 'first.ts']); git(root, ['commit', '-m', 'advance source during aggregate output read']);
        return result;
    });
    assert.throws(() => completeParentAuditReview(fixture.root, PARENT_ID, identity), /source changed/iu);
    assert.equal(outputRead, true);
    assert.equal(readParentRecord(fixture.root, PARENT_ID, 'review-observation'), null);
    assert.equal(readParentRecord(fixture.root, PARENT_ID, 'result'), null);
    assert.equal(readParentQueue(fixture.root).entries.has(PARENT_ID + '-F1'), false);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
}

test('first aggregate observation rejects source drift while reading finding-free output', context =>
    assertSourceDriftRejectsFirstObservation(context, false));

test('first aggregate observation rejects source drift while reading output findings', context =>
    assertSourceDriftRejectsFirstObservation(context, true));

test('one fresh aggregate review covers the combined diff and completes a finding-free parent', async () => {
    const fixture = await parentFixture({ enabled: true }); registerParentCompletionContract(fixture.root, PARENT_ID);
    const input = prepareParentAuditReview(fixture.root, PARENT_ID);
    assert.deepEqual(input.changed_files, ['first.ts', 'second.ts']);
    assert.match(fs.readFileSync(input.diff_path, 'utf8'), /first = 1/u);
    assert.throws(() => completeParentAuditReview(fixture.root, PARENT_ID, 'agent:isolated-reviewer'), /independent reviewer/iu);
    recordParentReviewerStarted(fixture.root, PARENT_ID, 'agent:isolated-reviewer', parentRecordDigest(input), 'collaboration.spawn_agent');
    fs.writeFileSync(input.output_path, JSON.stringify(outputFor(input)));
    assert.equal(completeParentAuditReview(fixture.root, PARENT_ID, 'agent:isolated-reviewer').follow_up_task_id, null);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, true);
    assert.throws(() => prepareParentAuditReview(fixture.root, PARENT_ID), /already completed/iu);
});

test('incomplete transport attempts can retry with a fresh reviewer without consuming the one audit', async () => {
    const fixture = await parentFixture({ enabled: true }); registerParentCompletionContract(fixture.root, PARENT_ID);
    const input = prepareParentAuditReview(fixture.root, PARENT_ID);
    recordParentReviewerStarted(fixture.root, PARENT_ID, 'agent:failed-isolated-reviewer', parentRecordDigest(input), 'collaboration.spawn_agent');
    recordParentReviewerFailed(fixture.root, PARENT_ID, 'agent:failed-isolated-reviewer', 'The isolated transport did not return a review.');
    assert.throws(() => recordParentReviewerStarted(fixture.root, PARENT_ID, 'agent:another-on-failed-input', parentRecordDigest(input), 'collaboration.spawn_agent'), /fresh aggregate input/iu);
    const retry = prepareParentAuditReview(fixture.root, PARENT_ID);
    assert.notEqual(retry.attempt_id, input.attempt_id);
    assert.notEqual(retry.diff_path, input.diff_path);
    assert.notEqual(retry.output_path, input.output_path);
    assert.equal(prepareParentAuditReview(fixture.root, PARENT_ID).attempt_id, retry.attempt_id, 'an unstarted retry stays stable');
    assert.throws(() => recordParentReviewerFailed(fixture.root, PARENT_ID, 'agent:failed-isolated-reviewer', 'An earlier reviewer cannot fail the current prepared input.'), /current incomplete/iu);
    assert.ok(fs.existsSync(input.diff_path), 'failed attempt artifacts remain available');
    assert.throws(() => recordParentReviewerStarted(fixture.root, PARENT_ID, 'agent:failed-isolated-reviewer', parentRecordDigest(retry), 'collaboration.spawn_agent'), /fresh reviewer/iu);
    recordParentReviewerStarted(fixture.root, PARENT_ID, 'agent:fresh-isolated-reviewer', parentRecordDigest(retry), 'collaboration.spawn_agent');
    fs.writeFileSync(retry.output_path, JSON.stringify(outputFor(input)));
    assert.throws(() => completeParentAuditReview(fixture.root, PARENT_ID, 'agent:fresh-isolated-reviewer'), /current task, input, attempt/iu);
});

test('a stale unstarted aggregate input can be prepared again without reset or accepting old output', async () => {
    const fixture = await parentFixture({ enabled: true }); registerParentCompletionContract(fixture.root, PARENT_ID);
    const input = prepareParentAuditReview(fixture.root, PARENT_ID);
    fs.writeFileSync(path.join(fixture.root, 'first.ts'), 'export const first = 99;\n');
    git(fixture.root, ['add', 'first.ts']); git(fixture.root, ['commit', '-m', 'advance clean source before delegation']);
    const queue = readParentQueue(fixture.root);
    const route = resolveParentAuditNavigation({ repoRoot: fixture.root, taskId: PARENT_ID, taskEntry: queue.entries.get(PARENT_ID)!,
        taskEntries: queue.entries, cliPrefix: 'node bin/garda.js', eventsRoot: fixture.bundle + '/runtime/task-events' });
    assert.match(route!.commands[0].command, /--phase prepare/u);
    const retry = prepareParentAuditReview(fixture.root, PARENT_ID);
    assert.notEqual(retry.attempt_id, input.attempt_id);
    assert.equal(prepareParentAuditReview(fixture.root, PARENT_ID).attempt_id, retry.attempt_id);
    assert.equal(retry.preparation_recovery!.previous_input_sha256, parentRecordDigest(input));
    assert.ok(fs.existsSync(input.diff_path));
    assert.throws(() => recordParentReviewerStarted(fixture.root, PARENT_ID, 'agent:stale-unstarted', parentRecordDigest(input), 'collaboration.spawn_agent'), /current prepared input/iu);
    recordParentReviewerStarted(fixture.root, PARENT_ID, 'agent:reprepared-input', parentRecordDigest(retry), 'collaboration.spawn_agent');
    fs.writeFileSync(retry.output_path, JSON.stringify(outputFor(input)));
    assert.throws(() => completeParentAuditReview(fixture.root, PARENT_ID, 'agent:reprepared-input'), /current task, input, attempt/iu);
    fs.writeFileSync(retry.output_path, JSON.stringify(outputFor(retry)));
    assert.equal(completeParentAuditReview(fixture.root, PARENT_ID, 'agent:reprepared-input').follow_up_task_id, null);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, true);
});

test('reviewer prose cannot invent source evidence or source lines', async () => {
    const fixture = await parentFixture({ enabled: true }); registerParentCompletionContract(fixture.root, PARENT_ID);
    const input = prepareParentAuditReview(fixture.root, PARENT_ID);
    recordParentReviewerStarted(fixture.root, PARENT_ID, 'agent:source-evidence-reviewer', parentRecordDigest(input), 'collaboration.spawn_agent');
    const output = outputFor(input); output.requirements[0].evidence = ['first.ts:99999'];
    fs.writeFileSync(input.output_path, JSON.stringify(output));
    assert.throws(() => completeParentAuditReview(fixture.root, PARENT_ID, 'agent:source-evidence-reviewer'), /line does not exist/iu);
    output.requirements[0].evidence = ['../outside.ts:1'];
    fs.writeFileSync(input.output_path, JSON.stringify(output));
    assert.throws(() => completeParentAuditReview(fixture.root, PARENT_ID, 'agent:source-evidence-reviewer'), /outside canonical/iu);
});

test('source changes during an unfinished review reject stale output', async () => {
    const fixture = await parentFixture({ enabled: true }); registerParentCompletionContract(fixture.root, PARENT_ID);
    const input = prepareParentAuditReview(fixture.root, PARENT_ID);
    recordParentReviewerStarted(fixture.root, PARENT_ID, 'agent:isolated-reviewer', parentRecordDigest(input), 'collaboration.spawn_agent');
    fs.writeFileSync(input.output_path, JSON.stringify(outputFor(input)));
    fs.writeFileSync(path.join(fixture.root, 'first.ts'), 'export const first = 99;\n'); git(fixture.root, ['add', 'first.ts']); git(fixture.root, ['commit', '-m', 'changed source']);
    assert.throws(() => completeParentAuditReview(fixture.root, PARENT_ID, 'agent:isolated-reviewer'), /source changed/iu);
});
