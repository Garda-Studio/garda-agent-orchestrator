import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as containedFilesystem from '../../../../../../src/core/contained-filesystem';
import { createTempRepo, seedInitAnswers, runEnterTaskMode, removeTempRepoWithRetry, initializeGitRepo } from '../../gate-test-helpers';
import { writeProtectedControlPlaneManifest } from '../../../../../../src/gates/shared/helpers';
import { appendMandatoryTaskEvent, appendMandatoryTaskEventAsync, readTaskEventAppendState } from '../../../../../../src/gate-runtime/task-events';
import { assertTaskModeProtectedEntryAllowed } from '../../../../../../src/cli/commands/gate-flows/task-mode/task-mode-entry-protection';
import { getWorkflowConfigPreTaskBaselineState } from '../../../../../../src/gates/workflow-config/workflow-config-work';
import { runTaskResetCommand } from '../../../../../../src/cli/commands/gate-flows/task/task-reset-flow';
import { WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE } from '../../../../../../src/cli/commands/gate-flows/task-mode/task-mode-flow';

const TASK_ID = 'T-PROTECTED-CONTINUATION';
const FILES = ['src/protected-work.ts'];

function fixture(provider = 'Codex', workflowConfigWork = false) {
    const repoRoot = createTempRepo();
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }));
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/\n');
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), '# Tasks\n\n## Active Queue\n\n'
        + '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |\n'
        + '| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'
        + `| ${TASK_ID} | 🟦 TODO | P1 | orchestration | Protected continuation regression | fixture | 2026-10-11 | default | ${workflowConfigWork ? WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE : 'fixture'} |\n`);
    seedInitAnswers(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, FILES[0]), 'export const protectedWork = true;\n');
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Fixture entrypoint\n');
    initializeGitRepo(repoRoot);
    writeProtectedControlPlaneManifest(repoRoot);
    const confirmedAtUtc = new Date().toISOString();
    const base = { repoRoot, taskId: TASK_ID, taskSummary: 'Protected continuation regression',
        provider, orchestratorWork: true, workflowConfigWork,
        plannedChangedFiles: workflowConfigWork ? ['garda-agent-orchestrator/live/config/workflow-config.json'] : FILES };
    assert.equal(runEnterTaskMode({ ...base, operatorConfirmed: 'yes', operatorConfirmedAtUtc: confirmedAtUtc }).exitCode, 0);
    const artifactPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews', `${TASK_ID}-task-mode.json`);
    const grantPath = path.join(repoRoot, '.git/garda-private/protected-task-entry', `${TASK_ID}.json`);
    const keyPath = path.join(repoRoot, '.git/garda-private/protected-task-entry', `${TASK_ID}.key`);
    return { repoRoot, base, confirmedAtUtc, artifactPath, grantPath, keyPath,
        continue: (overrides: Partial<typeof base> & { operatorConfirmed?: string; operatorConfirmedAtUtc?: string } = {}) =>
            runEnterTaskMode({ ...base, upgradeExistingTaskMode: true, ...overrides }),
        cleanup: () => removeTempRepoWithRetry(repoRoot) };
}

test('authenticated unchanged protected continuation survives elapsed approval age without redating approval', t => {
    const f = fixture();
    try {
        const later = Date.now() + 11 * 60_000;
        t.mock.method(Date, 'now', () => later);
        assert.equal(f.continue().exitCode, 0);
        const grant = JSON.parse(fs.readFileSync(f.grantPath, 'utf8'));
        assert.equal(grant.operator_confirmed_at_utc, f.confirmedAtUtc);
        assert.equal(grant.task_id, TASK_ID);
    } finally { f.cleanup(); }
});

test('authorized workflow-config native repeat and upgrade retain unchanged elapsed approval', t => {
    const f = fixture('Codex', true);
    try {
        t.mock.method(Date, 'now', () => Date.parse(f.confirmedAtUtc) + 11 * 60_000);
        assert.equal(runEnterTaskMode({ ...f.base }).exitCode, 0);
        assert.equal(f.continue().exitCode, 0);
        const artifact = JSON.parse(fs.readFileSync(f.artifactPath, 'utf8'));
        assert.equal(artifact.workflow_config_work, true);
        assert.equal(artifact.orchestrator_work, true);
        assert.equal(JSON.parse(fs.readFileSync(f.grantPath, 'utf8')).operator_confirmed_at_utc, f.confirmedAtUtc);
    } finally { f.cleanup(); }
});

for (const flags of [{ workflowConfigWork: false }, { orchestratorWork: false }] as const) {
    test(`workflow-config continuation rejects changed permission ${Object.keys(flags)[0]} without rotating authority`, t => {
        const f = fixture('Codex', true);
        try {
            const grant = fs.readFileSync(f.grantPath);
            const key = fs.readFileSync(f.keyPath);
            t.mock.method(Date, 'now', () => Date.parse(f.confirmedAtUtc) + 11 * 60_000);
            assert.throws(() => f.continue(flags), /workflow-config-work|orchestrator-work|confirmation|authority/i);
            assert.deepEqual(fs.readFileSync(f.grantPath), grant);
            assert.deepEqual(fs.readFileSync(f.keyPath), key);
            assert.equal(f.continue().exitCode, 0);
        } finally { f.cleanup(); }
    });
}

test('authenticated continuation accepts the same supported provider alias', t => {
    const f = fixture('github-copilot-cli');
    try {
        const later = Date.now() + 11 * 60_000;
        t.mock.method(Date, 'now', () => later);
        assert.equal(f.continue().exitCode, 0);
        assert.equal(JSON.parse(fs.readFileSync(f.artifactPath, 'utf8')).provider, 'GitHubCopilot');
    } finally { f.cleanup(); }
});

test('ordinary native repeat entry retains authenticated unchanged approval after its fresh-entry lifetime', t => {
    const f = fixture();
    try {
        t.mock.method(Date, 'now', () => Date.parse(f.confirmedAtUtc) + 11 * 60_000);
        assert.equal(runEnterTaskMode({ ...f.base }).exitCode, 0);
        assert.equal(JSON.parse(fs.readFileSync(f.grantPath, 'utf8')).operator_confirmed_at_utc, f.confirmedAtUtc);
        assert.throws(() => runEnterTaskMode({ ...f.base, plannedChangedFiles: [...FILES, 'src/new-authority.ts'] }),
            /confirmation|authority|scope|continuation/i);
    } finally { f.cleanup(); }
});

for (const action of ['reopen', 'discard'] as const) {
    test(`actual native ${action} revokes admission even after restoring old public task state`, t => {
        const f = fixture();
        try {
            const timeline = path.join(f.repoRoot, 'garda-agent-orchestrator/runtime/task-events', `${TASK_ID}.jsonl`);
            const taskQueue = path.join(f.repoRoot, 'TASK.md');
            const oldTimeline = fs.readFileSync(timeline);
            const oldArtifact = fs.readFileSync(f.artifactPath);
            const oldQueue = fs.readFileSync(taskQueue);
            const result = runTaskResetCommand({ repoRoot: f.repoRoot, taskId: TASK_ID, [action]: true,
                confirm: true, oneAction: true, operatorConfirmed: 'yes', operatorConfirmedAtUtc: f.confirmedAtUtc });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            fs.writeFileSync(timeline, oldTimeline);
            fs.writeFileSync(f.artifactPath, oldArtifact);
            fs.writeFileSync(taskQueue, oldQueue);
            t.mock.method(Date, 'now', () => Date.parse(f.confirmedAtUtc) + 11 * 60_000);
            assert.throws(() => f.continue(), /confirmation|authority|continuation/i);
        } finally { f.cleanup(); }
    });
}

test('prepared preview and refused native reset leave admission standing', t => {
    const f = fixture();
    try {
        const base = { repoRoot: f.repoRoot, taskId: TASK_ID, reopen: true };
        const originalKey = fs.readFileSync(f.keyPath);
        assert.equal(runTaskResetCommand({ ...base, dryRun: true }).outcome, 'DRY_RUN');
        assert.equal(runTaskResetCommand(base).outcome, 'CONFIRMATION_REQUIRED');
        assert.equal(runTaskResetCommand({ ...base, prepareOneAction: true, operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: f.confirmedAtUtc }).outcome, 'ONE_ACTION_AUTHORITY_PREPARED');
        assert.deepEqual(fs.readFileSync(f.keyPath), originalKey);
        t.mock.method(Date, 'now', () => Date.parse(f.confirmedAtUtc) + 11 * 60_000);
        assert.equal(f.continue().exitCode, 0);
    } finally { f.cleanup(); }
});

test('actual native custom-store reset cannot revive canonical admission after public rollback', t => {
    const f = fixture();
    try {
        const oldArtifact = fs.readFileSync(f.artifactPath);
        const oldQueue = fs.readFileSync(path.join(f.repoRoot, 'TASK.md'));
        assert.equal(runTaskResetCommand({ repoRoot: f.repoRoot, taskId: TASK_ID, reopen: true,
            eventsRoot: path.join(f.repoRoot, 'custom-events'), confirm: true, oneAction: true,
            operatorConfirmed: 'yes', operatorConfirmedAtUtc: f.confirmedAtUtc }).outcome, 'RESET_COMPLETE');
        fs.writeFileSync(f.artifactPath, oldArtifact);
        fs.writeFileSync(path.join(f.repoRoot, 'TASK.md'), oldQueue);
        t.mock.method(Date, 'now', () => Date.parse(f.confirmedAtUtc) + 11 * 60_000);
        assert.throws(() => f.continue(), /confirmation|authority|continuation/i);
    } finally { f.cleanup(); }
});

test('native Windows reset accepts a case alias of the already held canonical event lock',
    { skip: process.platform !== 'win32' }, () => {
    const f = fixture();
    try {
        assert.equal(runTaskResetCommand({ repoRoot: f.repoRoot, taskId: TASK_ID, reopen: true,
            eventsRoot: path.join(f.repoRoot, 'garda-agent-orchestrator/runtime/task-events').toUpperCase(),
            confirm: true, oneAction: true, operatorConfirmed: 'yes', operatorConfirmedAtUtc: f.confirmedAtUtc }).outcome,
        'RESET_COMPLETE');
    } finally { f.cleanup(); }
});

test('private revocation failure prevents native reset from deleting public task state', () => {
    const f = fixture();
    try {
        const timeline = path.join(f.repoRoot, 'garda-agent-orchestrator/runtime/task-events', `${TASK_ID}.jsonl`);
        const originalTimeline = fs.readFileSync(timeline);
        const originalArtifact = fs.readFileSync(f.artifactPath);
        const originalQueue = fs.readFileSync(path.join(f.repoRoot, 'TASK.md'));
        fs.linkSync(f.keyPath, `${f.keyPath}.copy`);
        assert.throws(() => runTaskResetCommand({ repoRoot: f.repoRoot, taskId: TASK_ID, reopen: true,
            confirm: true, oneAction: true, operatorConfirmed: 'yes', operatorConfirmedAtUtc: f.confirmedAtUtc }));
        assert.deepEqual(fs.readFileSync(timeline), originalTimeline);
        assert.deepEqual(fs.readFileSync(f.artifactPath), originalArtifact);
        assert.deepEqual(fs.readFileSync(path.join(f.repoRoot, 'TASK.md')), originalQueue);
    } finally { f.cleanup(); }
});

test('restoring pre-terminal runtime history cannot revive protected admission', t => {
    const f = fixture();
    try {
        const timeline = path.join(f.repoRoot, 'garda-agent-orchestrator/runtime/task-events', `${TASK_ID}.jsonl`);
        const oldTimeline = fs.readFileSync(timeline);
        const oldArtifact = fs.readFileSync(f.artifactPath);
        appendMandatoryTaskEvent(path.join(f.repoRoot, 'garda-agent-orchestrator'), TASK_ID,
            'TASK_DONE', 'PASS', 'Fixture genuine terminal event precedes ordinary runtime rollback.', {});
        fs.writeFileSync(timeline, oldTimeline);
        fs.writeFileSync(f.artifactPath, oldArtifact);
        const later = Date.now() + 11 * 60_000;
        t.mock.method(Date, 'now', () => later);
        assert.throws(() => f.continue(), /confirmation|authority|continuation/i);
    } finally { f.cleanup(); }
});

test('concurrent native terminal publication cannot be overwritten by admission publication', async t => {
    const f = fixture();
    let child: ReturnType<typeof spawn> | undefined;
    let childExit: Promise<number | null> | undefined;
    try {
        const orchestrator = path.join(f.repoRoot, 'garda-agent-orchestrator');
        const timeline = path.join(orchestrator, 'runtime/task-events', `${TASK_ID}.jsonl`);
        const lock = path.join(path.dirname(timeline), `.${TASK_ID}.lock`);
        const marker = path.join(orchestrator, 'runtime/terminal-worker-state');
        let oldTimeline: Buffer | undefined;
        let oldArtifact: Buffer | undefined;
        const write = containedFilesystem.writeContainedFile;
        let injected = false;
        t.mock.method(containedFilesystem, 'writeContainedFile', (...args: Parameters<typeof write>) => {
            if (!injected && path.resolve(args[1]) === path.resolve(f.keyPath)) {
                injected = true;
                oldTimeline = fs.readFileSync(timeline);
                oldArtifact = fs.readFileSync(f.artifactPath);
                const worker = `
                    const fs = require('node:fs');
                    const path = require('node:path');
                    const mkdir = fs.mkdirSync;
                    fs.mkdirSync = function(...args) {
                        try { return mkdir.apply(fs, args); } catch (error) {
                            if (error.code === 'EEXIST' && path.resolve(args[0]) === process.argv[3])
                                fs.writeFileSync(process.argv[4], 'waiting');
                            throw error;
                        }
                    };
                    require(process.argv[1]).appendMandatoryTaskEvent(process.argv[2], process.argv[5],
                        'TASK_DONE', 'PASS', 'Genuine concurrent terminal publication.', {},
                        { lockTimeoutMs: 5000, lockRetryMs: 10 });
                    fs.writeFileSync(process.argv[4], 'done');
                `;
                child = spawn(process.execPath, ['-e', worker,
                    require.resolve('../../../../../../src/gate-runtime/task-events'), orchestrator, lock, marker, TASK_ID],
                { stdio: 'ignore' });
                childExit = new Promise((resolve, reject) => {
                    child!.once('error', reject);
                    child!.once('exit', resolve);
                });
                const deadline = Date.now() + 5000;
                while (!fs.existsSync(marker) && Date.now() < deadline)
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                assert.equal(fs.existsSync(marker), true, 'worker must publish or reach the actual held native lock');
            }
            return write(...args);
        });
        assert.equal(f.continue().exitCode, 0);
        assert.equal(await childExit, 0);
        assert.equal(fs.readFileSync(marker, 'utf8'), 'done');
        fs.writeFileSync(timeline, oldTimeline!);
        fs.writeFileSync(f.artifactPath, oldArtifact!);
        t.mock.method(Date, 'now', () => Date.parse(f.confirmedAtUtc) + 11 * 60_000);
        assert.throws(() => f.continue(), /confirmation|authority|continuation/i);
    } finally {
        if (child?.exitCode === null) child.kill();
        if (childExit) await childExit.catch(() => undefined);
        f.cleanup();
    }
});

test('asynchronous native terminal append revokes admission before runtime rollback', async t => {
    const f = fixture();
    try {
        const orchestrator = path.join(f.repoRoot, 'garda-agent-orchestrator');
        const timeline = path.join(orchestrator, 'runtime/task-events', `${TASK_ID}.jsonl`);
        const oldTimeline = fs.readFileSync(timeline);
        const oldArtifact = fs.readFileSync(f.artifactPath);
        await appendMandatoryTaskEventAsync(orchestrator, TASK_ID, 'STATUS_CHANGED', 'PASS',
            'Fixture native terminal transition.', { new_status: 'DONE' });
        fs.writeFileSync(timeline, oldTimeline);
        fs.writeFileSync(f.artifactPath, oldArtifact);
        t.mock.method(Date, 'now', () => Date.parse(f.confirmedAtUtc) + 11 * 60_000);
        assert.throws(() => f.continue(), /confirmation|authority|continuation/i);
    } finally { f.cleanup(); }
});

test('failed private revocation blocks canonical terminal publication', () => {
    const f = fixture();
    try {
        const orchestrator = path.join(f.repoRoot, 'garda-agent-orchestrator');
        const timeline = path.join(orchestrator, 'runtime/task-events', `${TASK_ID}.jsonl`);
        const original = fs.readFileSync(timeline);
        fs.linkSync(f.keyPath, `${f.keyPath}.copy`);
        assert.throws(() => appendMandatoryTaskEvent(orchestrator, TASK_ID, 'TASK_DONE', 'PASS',
            'Fixture terminal publication must reject linked private authority.', {}));
        assert.deepEqual(fs.readFileSync(timeline), original);
    } finally { f.cleanup(); }
});

test('failed conditional terminal append retains the unchanged grant', t => {
    const f = fixture();
    try {
        const orchestrator = path.join(f.repoRoot, 'garda-agent-orchestrator');
        const events = path.join(orchestrator, 'runtime/task-events');
        const expectedPreviousState = readTaskEventAppendState(path.join(events, `${TASK_ID}.jsonl`), TASK_ID);
        appendMandatoryTaskEvent(orchestrator, TASK_ID, 'VALIDATION_FAILED', 'FAIL', 'Fixture intervening diagnostic.', {});
        const previousKey = fs.readFileSync(f.keyPath);
        assert.throws(() => appendMandatoryTaskEvent(orchestrator, TASK_ID, 'TASK_DONE', 'PASS',
            'Fixture stale conditional terminal append.', {}, { expectedPreviousState }));
        assert.deepEqual(fs.readFileSync(f.keyPath), previousKey);
        t.mock.method(Date, 'now', () => Date.parse(f.confirmedAtUtc) + 11 * 60_000);
        assert.equal(f.continue().exitCode, 0);
    } finally { f.cleanup(); }
});

test('reset confirmation diagnostics do not end the unchanged admission', t => {
    const f = fixture();
    try {
        appendMandatoryTaskEvent(path.join(f.repoRoot, 'garda-agent-orchestrator'), TASK_ID,
            'TASK_RESET_CONFIRMATION_REQUIRED', 'BLOCKED', 'Fixture reset was refused before execution.', {});
        t.mock.method(Date, 'now', () => Date.parse(f.confirmedAtUtc) + 11 * 60_000);
        assert.equal(f.continue().exitCode, 0);
    } finally { f.cleanup(); }
});

for (const scenario of ['expanded files', 'changed provider', 'explicit refusal', 'modified artifact',
    'missing grant', 'modified grant', 'revoked key', 'linked key', 'configuration drift', 'terminal task', 'changed task intent'] as const) {
    test(`protected continuation rejects ${scenario}`, t => {
        const f = fixture();
        try {
            const overrides: Parameters<typeof f.continue>[0] = {};
            if (scenario === 'expanded files') overrides.plannedChangedFiles = [...FILES, 'src/new-authority.ts'];
            if (scenario === 'changed provider') overrides.provider = 'Gemini';
            if (scenario === 'explicit refusal') overrides.operatorConfirmed = 'no';
            if (scenario === 'changed task intent') overrides.taskSummary = 'Different protected implementation intent';
            if (scenario === 'modified artifact') {
                const mode = JSON.parse(fs.readFileSync(f.artifactPath, 'utf8'));
                mode.task_summary = 'Forged protected task intent';
                overrides.taskSummary = mode.task_summary;
                fs.writeFileSync(f.artifactPath, JSON.stringify(mode));
            }
            if (scenario === 'missing grant') fs.unlinkSync(f.grantPath);
            if (scenario === 'revoked key') fs.unlinkSync(f.keyPath);
            if (scenario === 'linked key') fs.linkSync(f.keyPath, `${f.keyPath}.copy`);
            if (scenario === 'configuration drift') {
                const config = path.join(f.repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json');
                const value = JSON.parse(fs.readFileSync(config, 'utf8'));
                value.full_suite_validation.timeout_ms += 1;
                fs.writeFileSync(config, JSON.stringify(value));
            }
            if (scenario === 'modified grant') {
                const grant = JSON.parse(fs.readFileSync(f.grantPath, 'utf8'));
                grant.operator_confirmed_at_utc = '2000-01-01T00:00:00Z';
                fs.writeFileSync(f.grantPath, JSON.stringify(grant));
            }
            if (scenario === 'terminal task') {
                const file = path.join(f.repoRoot, 'TASK.md');
                fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('🟨 IN_PROGRESS', '🟩 DONE'));
            }
            const later = Date.now() + 11 * 60_000;
            t.mock.method(Date, 'now', () => later);
            assert.throws(() => f.continue(overrides), /protected|workflow|operator-confirmed|confirmation|authority|upgrade|provider|permission|continuation|runtime/i);
        } finally { f.cleanup(); }
    });
}

test('foreign protected grant copied from another checkout gives no authority', t => {
    const first = fixture();
    const second = fixture();
    try {
        fs.copyFileSync(first.grantPath, second.grantPath);
        const later = Date.now() + 11 * 60_000;
        t.mock.method(Date, 'now', () => later);
        assert.throws(() => second.continue(), /confirmation|authority|continuation/i);
    } finally { first.cleanup(); second.cleanup(); }
});

test('an older signed admission cannot replay after a successful continuation', t => {
    const f = fixture();
    try {
        const oldGrant = fs.readFileSync(f.grantPath);
        const oldArtifact = fs.readFileSync(f.artifactPath);
        const later = Date.now() + 11 * 60_000;
        t.mock.method(Date, 'now', () => later);
        assert.equal(f.continue().exitCode, 0);
        fs.writeFileSync(f.grantPath, oldGrant);
        fs.writeFileSync(f.artifactPath, oldArtifact);
        assert.throws(() => f.continue(), /confirmation|authority|continuation/i);
    } finally { f.cleanup(); }
});

test('a failed validation does not revoke unchanged protected task permission', t => {
    const f = fixture();
    try {
        appendMandatoryTaskEvent(path.join(f.repoRoot, 'garda-agent-orchestrator'), TASK_ID,
            'TASK_BLOCKED', 'BLOCKED', 'Fixture validation failed; permission was not revoked.', {});
        const later = Date.now() + 11 * 60_000;
        t.mock.method(Date, 'now', () => later);
        assert.equal(f.continue().exitCode, 0);
    } finally { f.cleanup(); }
});

test('failed protected authority publication leaves no usable task-mode artifact', () => {
    const f = fixture();
    try {
        fs.linkSync(f.keyPath, `${f.keyPath}.copy`);
        assert.throws(() => f.continue({ operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() }), /Unsafe transaction path/);
        assert.equal(fs.existsSync(f.artifactPath), false);
    } finally { f.cleanup(); }
});

test('forged serialized verification flags and copied records cannot authorize the protected guard', () => {
    const f = fixture();
    try {
        const untrusted = JSON.parse(JSON.stringify({ repoRoot: f.repoRoot,
            orchestratorRoot: path.join(f.repoRoot, 'garda-agent-orchestrator'), taskId: TASK_ID,
            options: f.base, plannedChangedFiles: FILES, protectedPlannedFiles: FILES,
            workflowConfigPlannedFiles: [], dirtyWorkflowConfigFiles: [],
            workflowConfigPreTaskBaseline: getWorkflowConfigPreTaskBaselineState(f.repoRoot),
            orchestratorWork: true, workflowConfigWork: false, taskQueueMetadata: null,
            protectedContinuationVerified: true, protectedContinuation: JSON.parse(fs.readFileSync(f.grantPath, 'utf8')) }));
        assert.throws(() => assertTaskModeProtectedEntryAllowed(untrusted), /operator confirmation/);
    } finally { f.cleanup(); }
});
