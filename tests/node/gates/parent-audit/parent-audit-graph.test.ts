import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerParentCompletionContract } from '../../../../src/gates/parent-audit/parent-audit-contract';
import { inspectParentCompletion } from '../../../../src/gates/parent-audit/parent-audit-state';
import { transitionDecomposedParentsToDone } from '../../../../src/gates/next-step/next-step-task-queue-transitions';
import { buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { withTaskQueueTransaction } from '../../../../src/core/task-queue/task-queue-repository';
import { parentDigest } from '../../../../src/gates/parent-audit/parent-audit-auth';
import { captureParentSource } from '../../../../src/gates/parent-audit/parent-audit-graph';
import { validateNativeChildGitSource, validateNativeParentGitSource, mergeNativeChildSources } from '../../../../src/gates/task-audit/task-audit-summary-decomposed-parent-proofs';
import { withNativeParentReadScope } from '../../../../src/gates/task-audit/task-audit-summary-parent-obligation-proofs';
import { cleanupParentFixtures, parentFixture, PARENT_ID, writeQueue, git } from './parent-audit-test-support';

afterEach(cleanupParentFixtures);

async function acceptedNestedGroups(depth: number) {
    const fixture = await parentFixture({ origin: 'manual', enabled: true });
    let outer = PARENT_ID;
    writeQueue(fixture.root, `Decomposition source: manual-operator; child tasks: ${PARENT_ID}-1, ${PARENT_ID}-2;`, ['DONE', 'DONE', 'DONE']);
    for (let index = 0; index <= depth; index++) {
        if (index > 0) {
            const taskId = `T-NESTED-${index}`;
            fs.appendFileSync(path.join(fixture.root, 'TASK.md'),
                `| ${taskId} | DONE | P0 | test | Nested manual group | local | 2026-10-21 | balanced | Decomposition source: manual-operator; child tasks: ${outer}, ${PARENT_ID}-1; |\n`);
            outer = taskId;
        }
        registerParentCompletionContract(fixture.root, outer);
        // Seed queue finalization only; SOURCE publication, contract authentication and the measured inspection are real.
        appendMandatoryTaskEvent(fixture.bundle, outer, 'DECOMPOSED_PARENT_COMPLETED', 'INFO',
            'Isolated accepted grouping fixture.', {});
    }
    return { ...fixture, outer };
}

async function acceptedSharedGroups(depth: number) {
    const fixture = await acceptedNestedGroups(0);
    let children = [PARENT_ID, PARENT_ID + '-1'];
    for (let level = 1; level <= depth; level++) {
        const parents = [1, 2].map(index => `T-SHARED-${level}-${index}`);
        for (const taskId of parents) {
            fs.appendFileSync(path.join(fixture.root, 'TASK.md'),
                `| ${taskId} | DONE | P0 | test | Shared manual group | local | 2026-10-22 | balanced | Decomposition source: manual-operator; child tasks: ${children.join(', ')}; |\n`);
            registerParentCompletionContract(fixture.root, taskId);
            appendMandatoryTaskEvent(fixture.bundle, taskId, 'DECOMPOSED_PARENT_COMPLETED', 'INFO',
                'Isolated accepted shared grouping fixture.', {});
        }
        children = parents;
    }
    return { ...fixture, outer: children[0] };
}

test('shared descendant groups retain only unique SOURCE proofs in every cached parent', async () => {
    const fixture = await acceptedSharedGroups(4);
    let cachedSizes: number[] = [];
    const result = withNativeParentReadScope(fixture.root, fixture.outer, scope => {
        const inspection = inspectParentCompletion(fixture.root, fixture.outer)!;
        cachedSizes = [...scope.childSources.values()].map(entry => entry.sources.length);
        return inspection;
    }, inspection => inspection.ready);
    assert.equal(result.ready, true, result.violations.join(' | '));
    assert.deepEqual(result.childSources.map(source => source.taskId), [PARENT_ID + '-1', PARENT_ID + '-2']);
    assert.ok(cachedSizes.length > 1);
    assert.ok(cachedSizes.every(size => size === 2), JSON.stringify(cachedSizes));
    const first = result.childSources[0];
    assert.throws(() => mergeNativeChildSources([[first], [{ ...first, artifactSha256: '0'.repeat(64) }]]),
        /Conflicting native child SOURCE observations/u);
});

test('nested parent qualification keeps SOURCE reads linear in the accepted graph', async () => {
    const depth = 3, fixture = await acceptedNestedGroups(depth);
    const proofs = require('../../../../src/gates/task-audit/task-audit-summary-decomposed-parent-proofs');
    const readSource = proofs.readNativeChildSourceAcceptance;
    const reads = mock.method(proofs, 'readNativeChildSourceAcceptance', readSource);
    const result = inspectParentCompletion(fixture.root, fixture.outer)!;
    assert.equal(result.ready, true, result.violations.join(' | '));
    const edgeCount = depth + 2;
    assert.ok(reads.mock.callCount() <= edgeCount * 2,
        `Each accepted leaf edge needs its initial read and one final freshness check; observed ${reads.mock.callCount()} reads for ${edgeCount} edges.`);
});

test('a nested SOURCE revoked during the shared read still blocks parent acceptance', async () => {
    const fixture = await acceptedNestedGroups(2);
    const proofs = require('../../../../src/gates/task-audit/task-audit-summary-decomposed-parent-proofs');
    const readSource = proofs.readNativeChildSourceAcceptance;
    let revoked = false;
    mock.method(proofs, 'readNativeChildSourceAcceptance', (...args: Parameters<typeof readSource>) => {
        const source = readSource(...args);
        if (!revoked && args[1] === PARENT_ID + '-1') {
            revoked = true;
            appendMandatoryTaskEvent(fixture.bundle, PARENT_ID + '-1', 'TASK_MODE_ENTERED', 'PASS',
                'Revoke nested SOURCE after its initial authenticated read.', {});
        }
        return source;
    });
    assert.throws(() => {
        const result = inspectParentCompletion(fixture.root, fixture.outer)!;
        if (!result.ready) throw new Error(result.violations.join(' | '));
    }, /stale.*child cycle|SOURCE.*changed|nested.*accepted/iu);
    assert.equal(revoked, true);
});

test('clean merge HEAD qualifies the integrated parent without relaxing single-parent child SOURCE', async () => {
    const fixture = await parentFixture();
    registerParentCompletionContract(fixture.root, PARENT_ID);
    const branch = git(fixture.root, ['branch', '--show-current']);
    git(fixture.root, ['checkout', '-b', 'isolated-integration', 'HEAD~1']);
    fs.writeFileSync(path.join(fixture.root, 'integration.ts'), 'export const integration = true;\n');
    git(fixture.root, ['add', 'integration.ts']); git(fixture.root, ['commit', '-m', 'isolated integration change']);
    git(fixture.root, ['checkout', branch]);
    git(fixture.root, ['merge', '--no-ff', '-m', 'integrate accepted child work', 'isolated-integration']);
    const parents = git(fixture.root, ['show', '--no-patch', '--format=%P', 'HEAD']).split(' ');
    assert.equal(parents.length, 2);
    const source = captureParentSource(fixture.root);
    assert.equal(source.commitSha, git(fixture.root, ['rev-parse', 'HEAD']));
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, true);
    assert.throws(() => validateNativeChildGitSource(fixture.root, source), /parents differ/iu,
        'merge support for the integrated HEAD must not broaden authenticated single-parent child SOURCE');
    assert.throws(() => validateNativeParentGitSource(fixture.root, source, parents.slice(0, 1)), /parents differ/iu);
    assert.throws(() => validateNativeParentGitSource(fixture.root, source, [...parents].reverse()), /parents differ/iu);
});

test('native retirement preserves every post-decision WIP capture and rejects missing archive bytes', async () => {
    const fixture = await parentFixture();
    const directory = path.join(fixture.bundle, 'runtime/wip', PARENT_ID, 'split-required/capture');
    fs.mkdirSync(directory, { recursive: true });
    const patch = path.join(directory, 'staged.patch'), manifestPath = path.join(directory, 'manifest.json');
    fs.writeFileSync(patch, '');
    const reference = { path: patch, sha256: parentDigest('') };
    const manifest = { schema_version: 1, kind: 'split_required_wip', task_id: PARENT_ID, status: 'suspended',
        base_commit: git(fixture.root, ['rev-parse', 'HEAD']), tracked_files: [], untracked_files: [], patches: { staged: reference, unstaged: reference } };
    const original = JSON.stringify(manifest, null, 2) + '\n'; fs.writeFileSync(manifestPath, original);
    appendMandatoryTaskEvent(fixture.bundle, PARENT_ID, 'SPLIT_REQUIRED_WIP_CAPTURED', 'BLOCKED', 'Isolated native custody capture after decision.',
        { manifest_path: manifestPath, manifest_sha256: parentDigest(original) });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, true);
    const retired = { ...manifest, status: 'retired', retired_at_utc: new Date().toISOString(), retired_reason: 'Explicit isolated operator retirement.' };
    fs.writeFileSync(manifestPath, JSON.stringify(retired, null, 2) + '\n');
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false, 'retired text alone is not custody authority');
    appendMandatoryTaskEvent(fixture.bundle, PARENT_ID, 'SPLIT_REQUIRED_WIP_RETIRED', 'INFO', 'Isolated native retirement.',
        { manifest_path: manifestPath, manifest_sha256: parentDigest(fs.readFileSync(manifestPath)), reason: retired.retired_reason });
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, true);
    fs.unlinkSync(patch);
    const missing = inspectParentCompletion(fixture.root, PARENT_ID)!;
    assert.equal(missing.ready, false);
    assert.match(missing.violations.join(' '), /WIP archive/iu);
});

test('manual grouping completes through SOURCE qualification even when the audit switch is enabled', async () => {
    const fixture = await parentFixture({ origin: 'manual', enabled: true });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, true);
    const result = transitionDecomposedParentsToDone({ repoRoot: fixture.root, eventsRoot: path.join(fixture.bundle, 'runtime/task-events'), rootTaskId: PARENT_ID, taskIds: [PARENT_ID] });
    assert.equal(result.outcome, 'updated', result.error_message || '');
    assert.equal(buildTaskAuditSummary({ repoRoot: fixture.root, taskId: PARENT_ID }).status, 'PASS');
});

test('runtime grouping with the flag off does not inherit an unrelated configured suite', async () => {
    const fixture = await parentFixture({ enabled: false });
    const contract = registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.deepEqual(contract.original_commands, []);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, true);
});

test('runtime aggregate review blocks the status writer until accepted', async () => {
    const fixture = await parentFixture({ enabled: true });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
    const result = transitionDecomposedParentsToDone({ repoRoot: fixture.root, eventsRoot: path.join(fixture.bundle, 'runtime/task-events'), rootTaskId: PARENT_ID, taskIds: [PARENT_ID] });
    assert.equal(result.outcome, 'write_failed');
    assert.match(fs.readFileSync(path.join(fixture.root, 'TASK.md'), 'utf8'), /DECOMPOSED/u);
});

test('DONE text without authenticated SOURCE never completes a registered parent', async () => {
    const fixture = await parentFixture({ origin: 'manual', children: false });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    const result = inspectParentCompletion(fixture.root, PARENT_ID)!;
    assert.equal(result.ready, false);
    assert.match(result.violations.join(' '), /source|authority/iu);
});

test('a later child entry and unfinished child status revoke aggregate eligibility', async () => {
    const fixture = await parentFixture({ origin: 'manual' });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    appendMandatoryTaskEvent(fixture.bundle, PARENT_ID + '-1', 'TASK_MODE_ENTERED', 'PASS', 'Isolated next child attempt.', {});
    assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, false);
    writeQueue(fixture.root, `Decomposition source: manual-operator; child tasks: ${PARENT_ID}-1, ${PARENT_ID}-2;`, ['DECOMPOSED', 'TODO', 'DONE']);
    assert.match(inspectParentCompletion(fixture.root, PARENT_ID)!.violations.join(' '), /has not completed/iu);
});

test('an owned queue lock never hides an actual product source change', async () => {
    const fixture = await parentFixture({ origin: 'manual' });
    registerParentCompletionContract(fixture.root, PARENT_ID);
    withTaskQueueTransaction(path.join(fixture.root, 'TASK.md'), message => { throw new Error(message); }, () => {
        assert.equal(inspectParentCompletion(fixture.root, PARENT_ID)!.ready, true);
        fs.writeFileSync(path.join(fixture.root, 'first.ts'), 'export const first = 999;\n');
        const result = inspectParentCompletion(fixture.root, PARENT_ID)!;
        assert.equal(result.ready, false);
        assert.match(result.violations.join(' '), /clean Git source/iu);
    });
});
