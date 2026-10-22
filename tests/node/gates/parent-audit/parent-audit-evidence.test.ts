import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerParentCompletionContract, readParentCompletionContract } from '../../../../src/gates/parent-audit/parent-audit-contract';
import {
    parentRecordDigest, parentRecordVersionPath, readParentEvents, readParentRecord
} from '../../../../src/gates/parent-audit/parent-audit-auth';
import { parseParentAuditOutput } from '../../../../src/gates/parent-audit/parent-audit-evidence';
import { prepareParentAuditReview, recordParentReviewerStarted } from '../../../../src/gates/parent-audit/parent-audit-inputs';
import { completeParentAuditReview } from '../../../../src/gates/parent-audit/parent-audit-review';
import { inspectParentCompletion } from '../../../../src/gates/parent-audit/parent-audit-state';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { withReviewArtifactReadBarrier } from '../../../../src/gate-runtime/review/review-artifacts';
import { assertGenericTaskEventAdmission } from '../../../../src/gate-runtime/timeline/task-event-generic-admission';
import { cleanupParentFixtures, parentFixture, PARENT_ID, outputFor } from './parent-audit-test-support';

afterEach(cleanupParentFixtures);

test('native parent publication participates in the review read barrier without changing signed bytes', async () => {
    const fixture = await parentFixture({ origin: 'manual', children: false });
    const contract = withReviewArtifactReadBarrier(fixture.reviews, () =>
        registerParentCompletionContract(fixture.root, PARENT_ID));
    assert.deepEqual(readParentCompletionContract(fixture.root, PARENT_ID), contract);
    assert.equal(fs.readFileSync(parentRecordVersionPath(fixture.root, contract), 'utf8'),
        JSON.stringify(contract, null, 2) + '\n');
});

test('native parent publication does not absorb an unrelated review-directory mutation', async () => {
    const fixture = await parentFixture({ origin: 'manual', children: false });
    assert.throws(() => withReviewArtifactReadBarrier(fixture.reviews, () => {
        fs.writeFileSync(path.join(fixture.reviews, 'unrelated-publication.json'), '{}');
        registerParentCompletionContract(fixture.root, PARENT_ID);
    }), /invalidated by a concurrent review publication/u);
    assert.equal(readParentRecord(fixture.root, PARENT_ID, 'contract'), null);
});

test('parent registration rejects an existing legacy task-plan lock without removing it', async () => {
    const fixture = await parentFixture({ origin: 'manual', children: false });
    const legacyLock = path.join(fixture.reviews, `${PARENT_ID}-task-plan.lock`);
    fs.mkdirSync(legacyLock);
    assert.throws(() => registerParentCompletionContract(fixture.root, PARENT_ID), /legacy task-plan lock/u);
    assert.ok(fs.statSync(legacyLock).isDirectory());
    assert.equal(readParentRecord(fixture.root, PARENT_ID, 'contract'), null);
});

test('aggregate coverage preserves unexecuted verification requirements from the approved parent plan', async () => {
    const verification = 'Verify both child changes together on the final source.';
    const approach = 'Inspect integration evidence and record any missing check as a finding.';
    const command = 'node parent-check.cjs';
    const fixture = await parentFixture({ enabled: true, plan: {
        acceptance_criteria: ['Both original child requirements are satisfied.'],
        verification_expectations: [verification], validation_strategy: { approach, commands: [command] },
        out_of_scope: ['Do not add a new runtime.']
    } });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.deepEqual(contract.original_commands, [], 'no command ran before the split');
    const input = prepareParentAuditReview(fixture.root, PARENT_ID);
    const descriptions = input.obligations.map(row => row.description);
    for (const requirement of [verification, approach, command]) {
        assert.ok(contract.requirements.some(value => value.includes(requirement)), `frozen requirement: ${requirement}`);
        assert.ok(descriptions.some(value => value.includes(requirement)), `aggregate coverage: ${requirement}`);
    }
    assert.ok(descriptions.every(value => !value.includes('node unrelated-previous-task.js')));
    recordParentReviewerStarted(fixture.root, PARENT_ID, 'agent:explicit-plan-reviewer', parentRecordDigest(input), 'collaboration.spawn_agent');
    for (const requirement of [verification, approach, command]) {
        const omitted = input.obligations.find(row => row.description.includes(requirement))!;
        const output = outputFor(input);
        output.requirements = output.requirements.filter(row => row.id !== omitted.id);
        fs.writeFileSync(input.output_path, JSON.stringify(output));
        assert.throws(() => completeParentAuditReview(fixture.root, PARENT_ID, 'agent:explicit-plan-reviewer'), /complete obligations/iu);
        assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
    }
});

test('generic events cannot replay native parent publication authority', () => {
    assert.throws(() => assertGenericTaskEventAdmission('PARENT_AUDIT_RECORD_PUBLISHED'), /reserved/iu);
});

test('private-key creation rejects redirected Git custody without writing a key', async () => {
    const fixture = await parentFixture({ origin: 'manual', children: false });
    const external = path.join(fixture.root, 'redirected-private'); fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(fixture.root, '.git/garda-private'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => registerParentCompletionContract(fixture.root, PARENT_ID), /symbolic|symlink|reparse/iu);
    assert.equal(fs.existsSync(path.join(external, 'parent-audit-key')), false);
});

test('modified immutable contract bytes and later native attempts cannot reuse acceptance', async () => {
    const fixture = await parentFixture({ origin: 'manual', children: false });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    const file = parentRecordVersionPath(fixture.root, contract), original = fs.readFileSync(file);
    fs.writeFileSync(file, original.toString('utf8').replace('manual-at-creation', 'runtime'));
    assert.throws(() => readParentCompletionContract(fixture.root, PARENT_ID), /evidence binding/iu);
    fs.writeFileSync(file, original);
    appendMandatoryTaskEvent(fixture.bundle, PARENT_ID, 'TASK_MODE_ENTERED', 'PASS', 'Isolated next parent attempt.', {});
    assert.throws(() => readParentRecord(fixture.root, PARENT_ID, 'contract'), /earlier task cycle/iu);
});

test('copied authentication keys and parent artifacts do not grant another workspace authority', async () => {
    const first = await parentFixture({ origin: 'manual', children: false });
    const contract = registerParentCompletionContract(first.root, PARENT_ID);
    assert.deepEqual(readParentRecord(first.root, PARENT_ID, 'contract'), contract);
    const second = await parentFixture({ origin: 'manual', children: false });
    const ownContract = registerParentCompletionContract(second.root, PARENT_ID);
    assert.deepEqual(readParentRecord(second.root, PARENT_ID, 'contract'), ownContract);
    fs.copyFileSync(path.join(first.root, '.git/garda-private/parent-audit-key'), path.join(second.root, '.git/garda-private/parent-audit-key'));
    const original = parentRecordVersionPath(first.root, contract);
    const replay = parentRecordVersionPath(second.root, contract);
    fs.copyFileSync(original, replay);
    const publication = { kind: 'contract', artifact_path: replay, artifact_sha256: parentRecordDigest(contract) };
    appendMandatoryTaskEvent(second.bundle, PARENT_ID, 'PARENT_AUDIT_RECORD_PUBLISHED', 'PASS',
        'Replay the copied signed record under a valid destination publication.', publication, { actor: 'orchestrator' });
    const publications = readParentEvents(second.root, PARENT_ID).filter(event => event.event_type === 'PARENT_AUDIT_RECORD_PUBLISHED');
    assert.deepEqual(publications.at(-1)?.details, publication);
    assert.deepEqual(fs.readFileSync(replay), fs.readFileSync(original));
    assert.deepEqual(readParentRecord(first.root, PARENT_ID, 'contract'), contract);
    assert.throws(() => readParentRecord(second.root, PARENT_ID, 'contract'), /another workspace/iu);
});

test('review coverage cannot omit obligations, invent findings or dismiss a failed native validation', async () => {
    const fixture = await parentFixture({ enabled: true }); registerParentCompletionContract(fixture.root, PARENT_ID);
    const input = prepareParentAuditReview(fixture.root, PARENT_ID);
    const output = outputFor(input);
    assert.equal(parseParentAuditOutput(output, input).findings.length, 0);
    assert.throws(() => parseParentAuditOutput({ ...output, requirements: output.requirements.slice(1) }, input), /complete obligations/iu);
    const duplicate = structuredClone(output); duplicate.requirements[1] = duplicate.requirements[0];
    assert.throws(() => parseParentAuditOutput(duplicate, input), /duplicate/iu);
    const failedInput = { ...input, obligations: input.obligations.map((item, index) => ({ ...item, required_finding: index === 0 })) };
    assert.throws(() => parseParentAuditOutput(outputFor(failedInput), failedInput), /failed native checks/iu);
});
