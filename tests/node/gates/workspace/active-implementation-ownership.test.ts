import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { acquireFilesystemLock, releaseFilesystemLock } from '../../../../src/gate-runtime/task-events-locking';
import { buildNoOpArtifact } from '../../../../src/gates/task-mode/no-op';
import { fileSha256 } from '../../../../src/gates/shared/helpers';

import {
    assertSingleActiveImplementationOwner,
    findOtherActiveImplementationOwners
} from '../../../../src/gates/workspace/active-implementation-ownership';
import { createTempRepo } from '../../cli/commands/gate-test-repo-bootstrap';
import { runEnterTaskMode, seedInitAnswers } from '../../cli/commands/gate-test-seed-helpers';

function writeQueue(repoRoot: string, ownerStatus: string): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| T-101 | ${ownerStatus} | P2 | runtime | Implement owner | agent | 2026-09-23 | default | |`,
        '| T-102 | IN_PROGRESS | P2 | runtime | Waiting parent | agent | 2026-09-23 | default | |',
        '| T-103 | TODO | P2 | runtime | Second implementation | agent | 2026-09-23 | default | |',
        ''
    ].join('\n'), 'utf8');
}

test('task-mode entry rejects a second owner and a replaced no-op while queue-only parents remain waiting', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    const first = runEnterTaskMode({
        repoRoot,
        taskId: 'T-101',
        taskSummary: 'Implement the owner task'
    });
    assert.equal(first.exitCode, 0, first.outputLines.join('\n'));
    writeQueue(repoRoot, 'IN_PROGRESS');

    assert.deepEqual(findOtherActiveImplementationOwners(repoRoot, 'T-103'), ['T-101']);
    assert.throws(
        () => assertSingleActiveImplementationOwner(repoRoot, 'T-103', 'compile gate'),
        /compile gate refused for T-103.*T-101/u
    );
    assert.throws(
        () => runEnterTaskMode({
            repoRoot,
            taskId: 'T-103',
            taskSummary: 'Implement another task'
        }),
        /task-mode entry refused for T-103.*T-101/u
    );
    assert.doesNotThrow(() => assertSingleActiveImplementationOwner(repoRoot, 'T-101', 'compile gate'));

    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    appendTaskEvent(orchestratorRoot, 'T-101', 'PREFLIGHT_CLASSIFIED', 'PASS', 'No code changes.', {
        code_changed: false
    });
    const noOpPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-101-no-op.json');
    const noOp = buildNoOpArtifact({
        taskId: 'T-101',
        classification: 'AUDIT_ONLY',
        reason: 'The owner task requires no code changes.'
    });
    fs.writeFileSync(noOpPath, JSON.stringify(noOp), 'utf8');
    appendTaskEvent(orchestratorRoot, 'T-101', 'NO_OP_RECORDED', 'INFO', 'Audited no-op.', {
        artifact_path: noOpPath.replace(/\\/gu, '/'),
        artifact_sha256: fileSha256(noOpPath),
        classification: noOp.classification,
        reason: noOp.reason,
        preflight_path: noOp.preflight_path,
        preflight_sha256: noOp.preflight_sha256
    });
    assert.deepEqual(findOtherActiveImplementationOwners(repoRoot, 'T-103'), []);
    fs.writeFileSync(noOpPath, JSON.stringify({ ...noOp, reason: 'Tampered after receipt.' }), 'utf8');
    assert.deepEqual(findOtherActiveImplementationOwners(repoRoot, 'T-103'), ['T-101']);
    fs.writeFileSync(noOpPath, JSON.stringify(noOp), 'utf8');

    writeQueue(repoRoot, 'DONE');
    assert.deepEqual(findOtherActiveImplementationOwners(repoRoot, 'T-103'), []);
});

test('task-mode entry rejects a concurrent start while the ownership lock is held', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    const lockPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-queue-locks', 'active-implementation.lock');
    const { handle } = acquireFilesystemLock(lockPath);
    try {
        assert.throws(
            () => runEnterTaskMode({
                repoRoot,
                taskId: 'T-103',
                taskSummary: 'Concurrent task entry'
            }),
            /active-implementation\.lock/u
        );
    } finally {
        releaseFilesystemLock(handle);
    }
});
