import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { acquireFilesystemLock, releaseFilesystemLock } from '../../../../src/gate-runtime/task-events-locking';
import { buildNoOpArtifact } from '../../../../src/gates/task-mode/no-op';
import { fileSha256 } from '../../../../src/gates/shared/helpers';
import { runCompileGateCommand, splitCommandLine } from '../../../../src/cli/commands/gates';
import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { getTaskModeEvidence } from '../../../../src/gates/task-mode/task-mode';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';
import { captureDirtyWorkspaceBaseline, deriveProtectedDirtyWorkspaceScope, detectProtectedDirtyWorkspaceDrift } from '../../../../src/gates/workspace/dirty-worktree-protection';
import { buildEnterTaskModeCommand } from '../../../../src/gates/next-step/next-step-lifecycle-command-builders';
import { resolveNextStepStartupRoute } from '../../../../src/gates/next-step/next-step-startup-routing';

import {
    assertSingleActiveImplementationOwner,
    findOtherActiveImplementationOwners,
    findUnapprovedActiveImplementationOwners,
    withImplementationOwnershipLock
} from '../../../../src/gates/workspace/active-implementation-ownership';
import { createTempRepo, initializeGitRepo } from '../../cli/commands/gate-test-repo-bootstrap';
import { runCliWithCapturedOutput } from '../../cli/commands/gate-test-cli-capture';
import {
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue,
    writeBudgetOutputFilters,
    writePreflight
} from '../../cli/commands/gate-test-seed-helpers';

function writeQueue(repoRoot: string, ownerStatus: string, targetStatus = 'TODO'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| T-101 | ${ownerStatus} | P2 | runtime | Implement owner | agent | 2026-09-23 | default | |`,
        '| T-102 | IN_PROGRESS | P2 | runtime | Waiting parent | agent | 2026-09-23 | default | |',
        `| T-103 | ${targetStatus} | P2 | runtime | Second implementation | agent | 2026-09-23 | default | |`,
        ''
    ].join('\n'), 'utf8');
}

test('task-mode entry rejects a second owner and a replaced no-op while queue-only parents remain waiting', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
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

test('confirmed entry reuses consent but detects replaced unrelated dirty files', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
    assert.equal(runEnterTaskMode({ repoRoot, taskId: 'T-101', taskSummary: 'Unfinished owner task' }).exitCode, 0);
    writeQueue(repoRoot, 'IN_PROGRESS');
    const ownerFile = path.join(repoRoot, 'src', 'owner.ts');
    fs.writeFileSync(ownerFile, 'export const owner = 1;\n');
    const options = {
        repoRoot, taskId: 'T-103', taskSummary: 'Confirmed second task',
        plannedChangedFiles: ['src/second.ts'], allowedActiveTasks: ['T-101'],
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    };
    assert.equal(runEnterTaskMode(options).exitCode, 0);
    assert.equal(fs.readFileSync(ownerFile, 'utf8'), 'export const owner = 1;\n');
    assert.deepEqual(findOtherActiveImplementationOwners(repoRoot, 'T-103'), ['T-101']);
    assert.deepEqual(findUnapprovedActiveImplementationOwners(repoRoot, 'T-103'), []);
    assert.doesNotThrow(() => assertSingleActiveImplementationOwner(repoRoot, 'T-103', 'compile gate'));
    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 11 * 60_000);
    assert.doesNotThrow(() => assertSingleActiveImplementationOwner(repoRoot, 'T-103', 'compile gate'));
    t.mock.restoreAll();
    const mode = getTaskModeEvidence(repoRoot, 'T-103');
    const protectedScope = deriveProtectedDirtyWorkspaceScope(repoRoot, mode.dirty_workspace_baseline, ['src/second.ts']);
    fs.writeFileSync(ownerFile, 'changed without ownership');
    assert.deepEqual(detectProtectedDirtyWorkspaceDrift(repoRoot, protectedScope).changed_files, ['src/owner.ts']);
});

test('task entry rejects missing or stale consent, wrong owner IDs, and missing explicit file scope', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
    assert.equal(runEnterTaskMode({ repoRoot, taskId: 'T-101', taskSummary: 'Unfinished owner task' }).exitCode, 0);
    writeQueue(repoRoot, 'IN_PROGRESS');
    const options = {
        repoRoot, taskId: 'T-103', taskSummary: 'Second implementation task',
        plannedChangedFiles: ['src/second.ts'], allowedActiveTasks: ['T-101'],
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    };
    assert.throws(() => runEnterTaskMode({ ...options, allowedActiveTasks: ['T-999'] }), /Ask the operator/u);
    assert.throws(() => runEnterTaskMode({ ...options, operatorConfirmed: 'no' }), /exact value "yes"/u);
    assert.throws(() => runEnterTaskMode({ ...options, operatorConfirmedAtUtc: '' }), /fresh operator approval/u);
    assert.throws(() => runEnterTaskMode({ ...options, operatorConfirmedAtUtc: new Date(Date.now() - 11 * 60_000).toISOString() }), /stale/u);
    assert.throws(() => runEnterTaskMode({ ...options, plannedChangedFiles: [] }), /explicit --planned-changed-file/u);
    assert.equal(fs.existsSync(path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-103-task-mode.json')), false);
});

test('confirmed entry rejects overlapping owner files, directories and physical aliases', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
    const ownerFile = path.join(repoRoot, 'src/owner.ts');
    fs.writeFileSync(ownerFile, 'export const owner = 1;\n');
    fs.linkSync(ownerFile, path.join(repoRoot, 'src/owner-link.ts'));
    fs.symlinkSync(path.join(repoRoot, 'src'), path.join(repoRoot, 'src-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(runEnterTaskMode({
        repoRoot, taskId: 'T-101', taskSummary: 'Owner with reserved files', plannedChangedFiles: ['src/owner.ts', 'src/owned-dir']
    }).exitCode, 0);
    writeQueue(repoRoot, 'IN_PROGRESS');
    const options = { repoRoot, taskId: 'T-103', taskSummary: 'Receiver with explicit scope', allowedActiveTasks: ['T-101'], operatorConfirmed: 'yes' };
    const overlappingPaths = ['src/owner.ts', './src/owner.ts', 'src\\owner.ts', 'src',
        'src/owned-dir/new.ts', 'src/owner-link.ts', 'src-alias/owner.ts', ownerFile];
    if (process.platform === 'win32') overlappingPaths.push('SRC/OWNER.TS');
    for (const plannedFile of overlappingPaths) {
        assert.throws(() => runEnterTaskMode({
            ...options, plannedChangedFiles: [plannedFile], operatorConfirmedAtUtc: new Date().toISOString()
        }), /scope overlaps unfinished task T-101/u, plannedFile);
        assert.equal(getTaskModeEvidence(repoRoot, 'T-103').evidence_status, 'EVIDENCE_FILE_MISSING');
    }
    assert.equal(runEnterTaskMode({
        ...options, plannedChangedFiles: ['src/owned-directory/independent.ts'], operatorConfirmedAtUtc: new Date().toISOString()
    }).exitCode, 0);
    assert.deepEqual(findUnapprovedActiveImplementationOwners(repoRoot, 'T-103'), []);
});

test('downstream ownership guards reject a file alias introduced after approval', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
    const ownerFile = path.join(repoRoot, 'src/owner.ts');
    fs.writeFileSync(ownerFile, 'export const owner = 1;\n');
    assert.equal(runEnterTaskMode({
        repoRoot, taskId: 'T-101', taskSummary: 'Owner with a reserved file', plannedChangedFiles: ['src/owner.ts']
    }).exitCode, 0);
    writeQueue(repoRoot, 'IN_PROGRESS');
    const options = { repoRoot, taskId: 'T-103', taskSummary: 'Receiver with its own file', plannedChangedFiles: ['src/second.ts'],
        allowedActiveTasks: ['T-101'], operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() };
    assert.equal(runEnterTaskMode(options).exitCode, 0);
    assert.deepEqual(findUnapprovedActiveImplementationOwners(repoRoot, 'T-103'), []);
    fs.linkSync(ownerFile, path.join(repoRoot, 'src/second.ts'));
    assert.deepEqual(findUnapprovedActiveImplementationOwners(repoRoot, 'T-103'), ['T-101']);
    assert.throws(() => assertSingleActiveImplementationOwner(repoRoot, 'T-103', 'compile gate'), /compile gate refused for T-103.*T-101/u);
    assert.throws(() => runEnterTaskMode({ ...options, operatorConfirmedAtUtc: new Date().toISOString() }), /scope overlaps unfinished task T-101/u);
});

test('approval rejects a replaced receiving task-mode artifact and a restarted owner', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
    assert.equal(runEnterTaskMode({ repoRoot, taskId: 'T-101', taskSummary: 'Unfinished owner task' }).exitCode, 0);
    writeQueue(repoRoot, 'IN_PROGRESS');
    assert.equal(runEnterTaskMode({
        repoRoot, taskId: 'T-103', taskSummary: 'Second implementation task',
        plannedChangedFiles: ['src/second.ts'], allowedActiveTasks: ['T-101'],
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    }).exitCode, 0);
    const modePath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-103-task-mode.json');
    const original = fs.readFileSync(modePath, 'utf8');
    const altered = JSON.parse(original);
    altered.planned_changed_files.push('src/owner.ts');
    fs.writeFileSync(modePath, JSON.stringify(altered));
    assert.throws(() => assertSingleActiveImplementationOwner(repoRoot, 'T-103', 'compile gate'), /Ask the operator/u);
    fs.writeFileSync(modePath, original);
    assert.doesNotThrow(() => assertSingleActiveImplementationOwner(repoRoot, 'T-103', 'compile gate'));
    assert.equal(runEnterTaskMode({
        repoRoot, taskId: 'T-101', taskSummary: 'Restarted original owner',
        plannedChangedFiles: ['src/owner.ts'], allowedActiveTasks: ['T-103'],
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    }).exitCode, 0);
    assert.throws(() => assertSingleActiveImplementationOwner(repoRoot, 'T-103', 'compile gate'), /Ask the operator/u);
});

test('task-mode re-entry rejects stale approval for changed scope and preserves the prior artifact', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
    assert.equal(runEnterTaskMode({ repoRoot, taskId: 'T-101', taskSummary: 'Unfinished owner task' }).exitCode, 0);
    writeQueue(repoRoot, 'IN_PROGRESS');
    const options = {
        repoRoot, taskId: 'T-103', taskSummary: 'Confirmed second task',
        plannedChangedFiles: ['src/second.ts'], allowedActiveTasks: ['T-101'],
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    };
    assert.equal(runEnterTaskMode(options).exitCode, 0);
    const modePath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-103-task-mode.json');
    const original = fs.readFileSync(modePath, 'utf8');
    const changed = { ...options, allowedActiveTasks: undefined, plannedChangedFiles: ['src/second.ts', 'src/extra.ts'] };
    assert.throws(() => runEnterTaskMode({ ...changed, operatorConfirmed: 'no' }), /exact value "yes"/u);
    assert.throws(() => runEnterTaskMode({ ...changed, operatorConfirmedAtUtc: new Date(Date.now() - 11 * 60_000).toISOString() }), /stale/u);
    assert.equal(fs.readFileSync(modePath, 'utf8'), original);
    assert.doesNotThrow(() => assertSingleActiveImplementationOwner(repoRoot, 'T-103', 'compile gate'));
    assert.equal(runEnterTaskMode({ ...changed, operatorConfirmedAtUtc: new Date().toISOString() }).exitCode, 0);
    assert.deepEqual(getTaskModeEvidence(repoRoot, 'T-103').planned_changed_files, ['src/extra.ts', 'src/second.ts']);
    assert.doesNotThrow(() => assertSingleActiveImplementationOwner(repoRoot, 'T-103', 'compile gate'));
});

test('approval renewal preserves the original baseline and detects replaced owner files', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
    assert.equal(runEnterTaskMode({ repoRoot, taskId: 'T-101', taskSummary: 'Unfinished owner task' }).exitCode, 0);
    writeQueue(repoRoot, 'IN_PROGRESS');
    const ownerFile = path.join(repoRoot, 'src/owner.ts');
    fs.writeFileSync(ownerFile, 'export const owner = 1;\n');
    const options = {
        repoRoot, taskId: 'T-103', taskSummary: 'Confirmed receiver task',
        plannedChangedFiles: ['src/second.ts'], allowedActiveTasks: ['T-101'],
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    };
    assert.equal(runEnterTaskMode(options).exitCode, 0);
    const originalBaseline = getTaskModeEvidence(repoRoot, 'T-103').dirty_workspace_baseline;
    fs.writeFileSync(ownerFile, 'export const owner = 2;\n');
    assert.equal(runEnterTaskMode({ ...options, operatorConfirmedAtUtc: new Date().toISOString() }).exitCode, 0);
    const renewed = getTaskModeEvidence(repoRoot, 'T-103');
    assert.deepEqual(renewed.dirty_workspace_baseline, originalBaseline);
    assert.deepEqual(detectProtectedDirtyWorkspaceDrift(repoRoot,
        deriveProtectedDirtyWorkspaceScope(repoRoot, renewed.dirty_workspace_baseline, options.plannedChangedFiles)
    ).changed_files, ['src/owner.ts']);
    const customPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-103-renewed-custom.json');
    assert.equal(runEnterTaskMode({ ...options, artifactPath: customPath, operatorConfirmedAtUtc: new Date().toISOString() }).exitCode, 0);
    const moved = getTaskModeEvidence(repoRoot, 'T-103', customPath);
    assert.deepEqual(moved.dirty_workspace_baseline, originalBaseline);
    assert.deepEqual(detectProtectedDirtyWorkspaceDrift(repoRoot,
        deriveProtectedDirtyWorkspaceScope(repoRoot, moved.dirty_workspace_baseline, options.plannedChangedFiles)
    ).changed_files, ['src/owner.ts']);
});

test('re-entry after the approved owner completes retains the original baseline across repeated entries', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
    assert.equal(runEnterTaskMode({ repoRoot, taskId: 'T-101', taskSummary: 'Unfinished owner task' }).exitCode, 0);
    writeQueue(repoRoot, 'IN_PROGRESS');
    const ownerFile = path.join(repoRoot, 'src/owner.ts');
    fs.writeFileSync(ownerFile, 'export const owner = 1;\n');
    const options = { repoRoot, taskId: 'T-103', taskSummary: 'Confirmed receiver task', plannedChangedFiles: ['src/second.ts'] };
    assert.equal(runEnterTaskMode({
        ...options, allowedActiveTasks: ['T-101'], operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    }).exitCode, 0);
    const originalBaseline = getTaskModeEvidence(repoRoot, 'T-103').dirty_workspace_baseline;
    fs.writeFileSync(ownerFile, 'export const owner = 2;\n');
    writeQueue(repoRoot, 'DONE', 'IN_PROGRESS');
    assert.deepEqual(findOtherActiveImplementationOwners(repoRoot, 'T-103'), []);
    for (const artifactPath of [undefined, path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-103-completed-owner.json'), undefined]) {
        assert.equal(runEnterTaskMode({ ...options, artifactPath }).exitCode, 0);
        const renewed = getTaskModeEvidence(repoRoot, 'T-103', artifactPath);
        assert.deepEqual(renewed.dirty_workspace_baseline, originalBaseline);
        assert.deepEqual(detectProtectedDirtyWorkspaceDrift(repoRoot,
            deriveProtectedDirtyWorkspaceScope(repoRoot, renewed.dirty_workspace_baseline, options.plannedChangedFiles)
        ).changed_files, ['src/owner.ts']);
    }
});

test('ordinary re-entry preserves the original baseline without applying explicit scope-upgrade completeness', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    writeQueue(repoRoot, 'TODO');
    const foreign = path.join(repoRoot, 'foreign.txt');
    fs.writeFileSync(foreign, 'original\n');
    initializeGitRepo(repoRoot);
    fs.writeFileSync(foreign, 'pre-existing user work\n');
    const options = { repoRoot, taskId: 'T-101', taskSummary: 'Ordinary resumed task', plannedChangedFiles: ['src/second.ts'] };
    assert.equal(runEnterTaskMode(options).exitCode, 0);
    const baseline = getTaskModeEvidence(repoRoot, 'T-101').dirty_workspace_baseline;
    fs.writeFileSync(path.join(repoRoot, 'late-user-attachment.txt'), 'unrelated arrival\n');
    assert.equal(runEnterTaskMode(options).exitCode, 0);
    const renewed = getTaskModeEvidence(repoRoot, 'T-101');
    assert.deepEqual(renewed.dirty_workspace_baseline, baseline);
    assert.throws(() => runEnterTaskMode({ ...options, upgradeExistingTaskMode: 'true' }), /requires every post-entry changed file/u);
    fs.writeFileSync(foreign, 'changed outside scope\n');
    assert.deepEqual(detectProtectedDirtyWorkspaceDrift(repoRoot,
        deriveProtectedDirtyWorkspaceScope(repoRoot, renewed.dirty_workspace_baseline, options.plannedChangedFiles)
    ).changed_files, ['foreign.txt']);
});

test('ordinary re-entry rejects a removed or malformed modern dirty workspace baseline', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    const options = { repoRoot, taskId: 'T-101', taskSummary: 'Reject removed ownership evidence' };
    assert.equal(runEnterTaskMode(options).exitCode, 0);
    const artifactPath = getTaskModeEvidence(repoRoot, 'T-101').evidence_path!;
    const original = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    for (const baseline of [undefined, null, 'invalid']) {
        const changed = { ...original, dirty_workspace_baseline: baseline };
        const bytes = JSON.stringify(changed);
        fs.writeFileSync(artifactPath, bytes);
        assert.throws(() => runEnterTaskMode(options), /original dirty workspace baseline is missing/u);
        assert.equal(fs.readFileSync(artifactPath, 'utf8'), bytes);
    }
});

test('navigator requests confirmation before entry and prints the existing owners', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
    assert.equal(runEnterTaskMode({ repoRoot, taskId: 'T-101', taskSummary: 'Unfinished owner task' }).exitCode, 0);
    writeQueue(repoRoot, 'IN_PROGRESS');
    const command = buildEnterTaskModeCommand(repoRoot, 'node bin/garda.js', 'T-103', null, 'Codex');
    assert.match(command, /--allow-active-task "T-101"/u);
    assert.match(command, /--operator-confirmed-at-utc/u);
    assert.match(command, /--planned-changed-file "<task-owned-file>"/u);
    const route = resolveNextStepStartupRoute({
        enterTaskModePassed: false, unapprovedActiveTaskOwners: ['T-101'],
        defaultExecutionProvider: 'Codex', enterTaskModeCommand: command,
        startupCycleReadiness: { ready: false, nextGate: null, title: '', reason: '' },
        loadRulePackPassed: false, rulePackStage: null, preflightExists: false, taskEntryRulePackCommand: '',
        handshakeDiagnosticsPassed: false, handshakeDiagnosticsCommand: '',
        shellSmokePreflightPassed: false, shellSmokePreflightCommand: ''
    });
    assert.equal(route?.nextGate, 'enter-task-mode');
    assert.match(route?.reason || '', /T-101.*Ask the operator.*preserving existing changes/u);
    assert.equal(route?.commands[0]?.command, command);
    assert.equal(runEnterTaskMode({
        repoRoot, taskId: 'T-103', taskSummary: 'Preserve the entered task policy',
        requestedDepth: 3, effectiveDepth: 1, provider: 'Codex',
        plannedChangedFiles: ['src/second.ts'], allowedActiveTasks: ['T-101'],
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    }).exitCode, 0);
    const mode = JSON.parse(fs.readFileSync(path.join(repoRoot,
        'garda-agent-orchestrator/runtime/reviews/T-103-task-mode.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(runEnterTaskMode({
        repoRoot, taskId: 'T-101', taskSummary: 'Restart the owner',
        plannedChangedFiles: ['src/owner.ts'], allowedActiveTasks: ['T-103'],
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    }).exitCode, 0);
    const renewal = buildEnterTaskModeCommand(repoRoot, 'node bin/garda.js', 'T-103', null, 'Claude', mode);
    assert.match(renewal, /--requested-depth "3"/u);
    assert.match(renewal, /--effective-depth "1"/u);
    assert.match(renewal, /--task-summary "Preserve the entered task policy"/u);
    assert.match(renewal, /--provider "Codex"/u);
    assert.match(renewal, /--start-banner "Garda captures my mind"/u);
    assert.match(renewal, /--routed-to /u);
    assert.match(renewal, /--planned-changed-file "src\/second.ts"/u);
    assert.match(renewal, /--allow-active-task "T-101"/u);
    assert.match(renewal, /--upgrade-existing-task-mode/u);
});

test('public navigator command confirms both owners through the repeated CLI flags', async (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
    assert.equal(runEnterTaskMode({ repoRoot, taskId: 'T-101', taskSummary: 'First owner' }).exitCode, 0);
    writeQueue(repoRoot, 'IN_PROGRESS');
    assert.equal(runEnterTaskMode({
        repoRoot, taskId: 'T-102', taskSummary: 'Second owner', plannedChangedFiles: ['src/owner-two.ts'],
        allowedActiveTasks: ['T-101'], operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    }).exitCode, 0);
    const navigation = await runCliWithCapturedOutput(['next-step', 'T-103', '--as-json', '--repo-root', '.'], { cwd: repoRoot });
    assert.equal(navigation.exitCode, 0, navigation.errors.join('\n'));
    const payload = JSON.parse(navigation.logs.join('\n')) as { next_gate: string; commands: Array<{ command: string }> };
    assert.equal(payload.next_gate, 'enter-task-mode');
    const command = payload.commands[0].command;
    assert.match(command, /--allow-active-task "T-101".*--allow-active-task "T-102"/u);
    const tokens = splitCommandLine(command);
    const argv = tokens.slice(tokens.indexOf('gate')).map(token => token
        .replace('<task-owned-file>', 'src/second.ts').replace('<ISO-8601 timestamp>', new Date().toISOString()));
    assert.equal(argv[0], 'gate');
    const providerIndex = argv.indexOf('--provider');
    assert.ok(providerIndex >= 0 && providerIndex + 1 < argv.length);
    argv[providerIndex + 1] = 'Codex';
    const planPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-103-task-plan.json');
    fs.writeFileSync(planPath, serializeTaskPlan(validateTaskPlan({
        schema_version: 1, task_id: 'T-103', status: 'approved', goal: 'Preserve the receiver plan',
        scope_files: ['src/second.ts'], risk_level: 'low', steps: [{ id: 'step-1', title: 'Implement the receiver' }]
    })));
    argv[argv.indexOf('--requested-depth') + 1] = '3';
    argv.push('--effective-depth', '1', '--plan-path', planPath);
    const ownerFile = path.join(repoRoot, 'src/owner.ts');
    fs.writeFileSync(ownerFile, 'export const owner = 1;\n');
    const denied = await runCliWithCapturedOutput(argv.map(token => token === 'yes' ? 'no' : token), { cwd: repoRoot });
    assert.notEqual(denied.exitCode, 0);
    assert.equal(getTaskModeEvidence(repoRoot, 'T-103').evidence_status, 'EVIDENCE_FILE_MISSING');
    const accepted = await runCliWithCapturedOutput(argv, { cwd: repoRoot });
    assert.equal(accepted.exitCode, 0, accepted.errors.join('\n'));
    assert.equal(getTaskModeEvidence(repoRoot, 'T-103').evidence_status, 'PASS');
    assert.deepEqual(findUnapprovedActiveImplementationOwners(repoRoot, 'T-103'), []);
    assert.doesNotThrow(() => assertSingleActiveImplementationOwner(repoRoot, 'T-103', 'compile gate'));
    const after = await runCliWithCapturedOutput(['next-step', 'T-103', '--as-json', '--repo-root', '.'], { cwd: repoRoot });
    assert.equal(after.exitCode, 0, after.errors.join('\n'));
    assert.notEqual((JSON.parse(after.logs.join('\n')) as { next_gate: string }).next_gate, 'enter-task-mode');
    const modePath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-103-task-mode.json');
    const originalMode = JSON.parse(fs.readFileSync(modePath, 'utf8')) as Record<string, unknown>;
    assert.ok(originalMode.plan);
    const originalBytes = fs.readFileSync(modePath, 'utf8');
    const overlappingEntry = await runCliWithCapturedOutput(argv.map(token => token === 'src/second.ts' ? 'src/owner-two.ts' : token), { cwd: repoRoot });
    assert.notEqual(overlappingEntry.exitCode, 0);
    assert.match(overlappingEntry.errors.join('\n'), /scope overlaps unfinished task T-102/u);
    assert.equal(fs.readFileSync(modePath, 'utf8'), originalBytes);
    fs.writeFileSync(ownerFile, 'export const owner = 2;\n');
    assert.equal(runEnterTaskMode({
        repoRoot, taskId: 'T-101', taskSummary: 'Restart the first owner', plannedChangedFiles: ['src/owner.ts'],
        allowedActiveTasks: ['T-102', 'T-103'], operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    }).exitCode, 0);
    const renewal = await runCliWithCapturedOutput(['next-step', 'T-103', '--as-json', '--repo-root', '.'], { cwd: repoRoot });
    assert.equal(renewal.exitCode, 0, renewal.errors.join('\n'));
    const renewalPayload = JSON.parse(renewal.logs.join('\n')) as typeof payload;
    assert.equal(renewalPayload.next_gate, 'enter-task-mode');
    const renewalTokens = splitCommandLine(renewalPayload.commands[0].command);
    assert.equal(renewalTokens[renewalTokens.indexOf('--plan-path') + 1], planPath.replace(/\\/gu, '/'));
    const renewedEntry = await runCliWithCapturedOutput(renewalTokens.slice(renewalTokens.indexOf('gate'))
        .map(token => token.replace('<ISO-8601 timestamp>', new Date().toISOString())), { cwd: repoRoot });
    assert.equal(renewedEntry.exitCode, 0, renewedEntry.errors.join('\n'));
    const renewedMode = JSON.parse(fs.readFileSync(modePath, 'utf8')) as Record<string, unknown>;
    for (const field of ['plan', 'requested_depth', 'effective_depth', 'entry_mode', 'task_summary',
        'provider', 'start_banner', 'routed_to', 'dirty_workspace_baseline']) {
        assert.deepEqual(renewedMode[field], originalMode[field], `renewal must preserve ${field}`);
    }
    assert.deepEqual(detectProtectedDirtyWorkspaceDrift(repoRoot,
        deriveProtectedDirtyWorkspaceScope(repoRoot, getTaskModeEvidence(repoRoot, 'T-103').dirty_workspace_baseline, ['src/second.ts'])
    ).changed_files, ['src/owner.ts']);
});

test('custom task-mode artifacts retain approval and a new owner requires confirmation again', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
    const reviews = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
    assert.equal(runEnterTaskMode({
        repoRoot, taskId: 'T-101', taskSummary: 'Owner with a custom artifact',
        artifactPath: path.join(reviews, 'T-101-custom-task-mode.json')
    }).exitCode, 0);
    writeQueue(repoRoot, 'IN_PROGRESS');
    assert.equal(runEnterTaskMode({
        repoRoot, taskId: 'T-103', taskSummary: 'Approved task with custom artifact',
        artifactPath: path.join(reviews, 'T-103-custom-task-mode.json'),
        plannedChangedFiles: ['src/second.ts'], allowedActiveTasks: ['T-101'],
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    }).exitCode, 0);
    assert.doesNotThrow(() => assertSingleActiveImplementationOwner(repoRoot, 'T-103', 'compile gate'));
    fs.appendFileSync(path.join(repoRoot, 'TASK.md'), '| T-104 | TODO | P2 | runtime | Third task | agent | 2026-09-27 | default | |\n');
    assert.equal(runEnterTaskMode({
        repoRoot, taskId: 'T-104', taskSummary: 'Another explicitly approved owner',
        plannedChangedFiles: ['src/third.ts'], allowedActiveTasks: ['T-101', 'T-103'],
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    }).exitCode, 0);
    assert.throws(() => assertSingleActiveImplementationOwner(repoRoot, 'T-103', 'compile gate'), /T-101, T-104.*Ask the operator/u);
});

test('custom-path owner restart rejects stale approval even when the old default artifact remains', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
    assert.equal(runEnterTaskMode({ repoRoot, taskId: 'T-101', taskSummary: 'Original default owner entry' }).exitCode, 0);
    writeQueue(repoRoot, 'IN_PROGRESS');
    assert.equal(runEnterTaskMode({
        repoRoot, taskId: 'T-103', taskSummary: 'Approved receiver task',
        plannedChangedFiles: ['src/second.ts'], allowedActiveTasks: ['T-101'],
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    }).exitCode, 0);
    const reviews = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
    assert.equal(runEnterTaskMode({
        repoRoot, taskId: 'T-101', taskSummary: 'Owner restarted through custom artifact',
        artifactPath: path.join(reviews, 'T-101-custom-task-mode.json'),
        plannedChangedFiles: ['src/owner.ts'], allowedActiveTasks: ['T-103'],
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
    }).exitCode, 0);
    assert.equal(fs.existsSync(path.join(reviews, 'T-101-task-mode.json')), true);
    assert.equal(getTaskModeEvidence(repoRoot, 'T-101').evidence_status, 'EVIDENCE_ARTIFACT_PATH_MISMATCH');
    assert.deepEqual(findUnapprovedActiveImplementationOwners(repoRoot, 'T-103'), ['T-101']);
    assert.throws(() => assertSingleActiveImplementationOwner(repoRoot, 'T-103', 'compile gate'), /Ask the operator/u);
    assert.match(buildEnterTaskModeCommand(repoRoot, 'node bin/garda.js', 'T-103', null, 'Codex'), /--allow-active-task "T-101"/u);
});

test('task entry without runtime ignores excludes its own lock and preserves unrelated runtime WIP', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\n');
    seedTaskQueue(repoRoot, 'T-103');
    initializeGitRepo(repoRoot);
    const lockMetadata = 'garda-agent-orchestrator/runtime/task-queue-locks/active-implementation.lock/owner.json';
    const foreignFile = 'garda-agent-orchestrator/runtime/task-queue-locks/foreign-work.txt';
    fs.mkdirSync(path.dirname(path.join(repoRoot, foreignFile)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, foreignFile), 'preserve this work');
    const result = runEnterTaskMode({ repoRoot, taskId: 'T-103', taskSummary: 'Enter without runtime ignores' });
    assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
    const baseline = getTaskModeEvidence(repoRoot, 'T-103').dirty_workspace_baseline;
    assert.ok(baseline);
    assert.ok(baseline.changed_files.includes(foreignFile));
    assert.equal(baseline.changed_files.includes(lockMetadata), false);
    assert.ok(baseline.git_change_classification?.untracked_files.includes(lockMetadata));
    assert.equal(fs.existsSync(path.join(repoRoot, lockMetadata)), false);
    const protectedScope = deriveProtectedDirtyWorkspaceScope(repoRoot, baseline, []);
    assert.equal(detectProtectedDirtyWorkspaceDrift(repoRoot, protectedScope).status, 'PASS');
    fs.writeFileSync(path.join(repoRoot, foreignFile), 'unexpected replacement');
    assert.deepEqual(detectProtectedDirtyWorkspaceDrift(repoRoot, protectedScope).changed_files, [foreignFile]);
});

test('baseline lock exclusion requires the current acquired entry lock and retains staged metadata', (t) => {
    const repoRoot = createTempRepo(t);
    initializeGitRepo(repoRoot);
    const lockMetadata = 'garda-agent-orchestrator/runtime/task-queue-locks/active-implementation.lock/owner.json';
    withImplementationOwnershipLock(repoRoot, lock => {
        assert.ok(captureDirtyWorkspaceBaseline(repoRoot).changed_files.includes(lockMetadata));
        assert.throws(() => captureDirtyWorkspaceBaseline(repoRoot, [], { ...lock, lockId: 'forged' }), /current implementation ownership lock/u);
        assert.throws(() => captureDirtyWorkspaceBaseline(repoRoot, [], { ...lock, lockPath: path.join(repoRoot, 'other.lock') }), /current implementation ownership lock/u);
        assert.deepEqual(captureDirtyWorkspaceBaseline(repoRoot, [], lock).changed_files, []);
        execFileSync('git', ['-C', repoRoot, 'add', '--', lockMetadata], { stdio: 'pipe' });
        const staged = captureDirtyWorkspaceBaseline(repoRoot, [], lock);
        assert.ok(staged.changed_files.includes(lockMetadata));
        assert.ok(staged.staged_files?.includes(lockMetadata));
        assert.ok(staged.staged_trust?.files[lockMetadata]);
    });
});

test('baseline capture rejects a released entry lock', (t) => {
    const repoRoot = createTempRepo(t);
    initializeGitRepo(repoRoot);
    const releasedLock = withImplementationOwnershipLock(repoRoot, lock => ({ ...lock }));
    assert.throws(() => captureDirtyWorkspaceBaseline(repoRoot, [], releasedLock), /current implementation ownership lock/u);
});

test('task-mode entry rejects a concurrent start while the ownership lock is held', (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
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

for (const approved of [false, true]) {
test(`compile gate ${approved ? 'accepts confirmed' : 'rejects unconfirmed'} unfinished task ownership`, async (t) => {
    const repoRoot = createTempRepo(t);
    seedInitAnswers(repoRoot);
    fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
    const workflowConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as {
        compile_gate: { command: string };
    };
    workflowConfig.compile_gate.command = 'node -e "require(\'node:fs\').writeFileSync(\'compile-ran.txt\', \'ran\')"';
    fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2) + '\n', 'utf8');
    const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
    seedTaskQueue(repoRoot, 'T-103');
    initializeGitRepo(repoRoot);

    assert.equal(runEnterTaskMode({
        repoRoot,
        taskId: 'T-103',
        taskSummary: 'Task attempting compile'
    }).exitCode, 0);
    seedTaskQueue(repoRoot, 'T-101');
    assert.equal(runEnterTaskMode({
        repoRoot,
        taskId: 'T-101',
        taskSummary: 'Other implementation owner'
    }).exitCode, 0);
    writeQueue(repoRoot, 'IN_PROGRESS', 'IN_PROGRESS');
    if (approved) {
        assert.equal(runEnterTaskMode({
            repoRoot, taskId: 'T-103', taskSummary: 'Task attempting compile with approval',
            plannedChangedFiles: ['src/app.ts'], allowedActiveTasks: ['T-101'],
            upgradeExistingTaskMode: true,
            operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString()
        }).exitCode, 0);
    }
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'console.log(2);\n', 'utf8');
    const preflightPath = writePreflight(repoRoot, 'T-103', {
        metrics: { changed_lines_total: 4 }
    });
    assert.equal(loadTaskEntryRulePack(repoRoot, 'T-103').exitCode, 0);
    runHandshakeForTask(repoRoot, 'T-103');
    runShellSmokeForTask(repoRoot, 'T-103');
    assert.equal(loadPostPreflightRulePack(repoRoot, 'T-103', preflightPath).exitCode, 0);

    const result = await runCompileGateCommand({
        repoRoot,
        taskId: 'T-103',
        preflightPath,
        outputFiltersPath,
        emitMetrics: false
    });
    assert.equal(result.exitCode, approved ? 0 : EXIT_GATE_FAILURE, result.outputLines.join('\n'));
    if (!approved) assert.match(result.outputLines.join('\n'), /compile gate refused for T-103.*T-101/u);
    assert.equal(fs.existsSync(path.join(repoRoot, 'compile-ran.txt')), approved);
});
}
