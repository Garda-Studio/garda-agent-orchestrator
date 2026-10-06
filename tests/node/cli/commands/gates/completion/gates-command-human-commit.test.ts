import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runHumanCommitCommand } from '../../../../../../src/cli/commands/gates';
import { handleSet } from '../../../../../../src/cli/commands/workflow/workflow-command-set';
import { buildDefaultWorkflowConfig } from '../../../../../../src/core/workflow-config';
import { buildGateHelpText } from '../../../../../../src/cli/commands/gate-command-help';
import { getNodeHumanCommitCommand } from '../../../../../../src/materialization/command-constants';
import { buildCommitGuardManagedBlock } from '../../../../../../src/materialization/content-builders';
import { buildScopeContentFingerprint } from '../../../../../../src/gates/compile/compile-gate';
import { createTempRepo, runGit } from '../../gate-test-helpers';

const TASK_ID = 'T-COMMIT-1';
const auditApi = require('../../../../../../src/gates/task-audit/task-audit-summary') as typeof import('../../../../../../src/gates/task-audit/task-audit-summary');
const closeoutApi = require('../../../../../../src/gates/task-audit/task-audit-summary-closeout-sync') as typeof import('../../../../../../src/gates/task-audit/task-audit-summary-closeout-sync');
const subprocessApi = require('../../../../../../src/core/process/subprocess') as typeof import('../../../../../../src/core/process/subprocess');

function installHook(root: string, name: string, script: string) {
    const hooks = path.join(root, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

function fixture(enabled = true, initialCommit = true) {
    const root = createTempRepo();
    runGit(root, ['init']);
    runGit(root, ['config', 'user.name', 'Garda Tests']);
    runGit(root, ['config', 'user.email', 'garda-tests@example.com']);
    fs.writeFileSync(path.join(root, '.gitignore'), 'garda-agent-orchestrator/\n');
    if (initialCommit) {
        runGit(root, ['add', '.']);
        runGit(root, ['commit', '-m', 'test: baseline']);
    }
    const configPath = path.join(root, 'garda-agent-orchestrator/live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(buildDefaultWorkflowConfig(), null, 2) + '\n');
    if (enabled) handleSet({ targetRoot: root, localCommitEnabled: 'true', json: true,
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
    fs.writeFileSync(path.join(root, 'accepted.txt'), 'accepted task content\n');
    runGit(root, ['add', 'accepted.txt']);
    return root;
}

function auditFixture(t: TestContext, root: string, status: 'PASS' | 'BLOCKED' = 'PASS', postStatus = status, staged = false, files = ['accepted.txt']) {
    let calls = 0;
    const source = staged ? 'git_staged_only' : 'explicit_changed_files';
    const acceptedHash = buildScopeContentFingerprint(root, source, files);
    // Boundary tests mock the audit service, never its production evidence writer.
    // The task's native completion and post-commit flow provide integration acceptance.
    const audit = t.mock.method(auditApi, 'buildTaskAuditSummary', () => ({ status: calls++ ? postStatus : status,
        integrity_status: 'PASS', final_closeout: { implementation_summary: { changed_files: files,
            scope_content_sha256: acceptedHash, audited_scope_provenance: { use_staged: staged, detection_source: source } } } }));
    const synchronize = t.mock.method(closeoutApi, 'synchronizeFinalCloseoutArtifacts', (summary: unknown) => summary);
    return { audit, synchronize };
}

test('authenticated ON supplies durable permission without another confirmation question', async (t) => {
    const root = fixture();
    try {
        auditFixture(t, root);
        assert.equal(await runHumanCommitCommand(['--task-id', TASK_ID, '--message', 'test: accepted native commit'], { cwd: root }), 0);
        assert.match(runGit(root, ['log', '--format=%s', '-1']).stdout, /accepted native commit/);
        assert.equal(runGit(root, ['diff', '--cached', '--name-only']).stdout.trim(), '');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native publication digest checks retain buffers only for the initial index comparison', async (t) => {
    const root = fixture();
    const mapSet = Map.prototype.set;
    let retainedAcceptedBuffers = 0;
    try {
        auditFixture(t, root);
        t.mock.method(Map.prototype, 'set', function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
            if (key === 'accepted.txt' && Buffer.isBuffer(value)) retainedAcceptedBuffers++;
            return mapSet.call(this, key, value);
        });
        assert.equal(await runHumanCommitCommand(['--task-id', TASK_ID, '--message', 'test: bounded publication memory'], { cwd: root }), 0);
        assert.equal(retainedAcceptedBuffers, 1, 'digest-only hook/signing publication checks must not retain accepted buffers');
        assert.match(runGit(root, ['show', 'HEAD:accepted.txt']).stdout, /accepted task content/);
    } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('native task commit excludes unrelated Git entries and treats accepted filenames literally', async (t) => {
    const root = fixture();
    const files = ['accepted.txt', 'accepted[1].txt', '--accepted.txt', 'deleted.txt'];
    const listings = new Map<string, string[]>();
    const originalSpawn = subprocessApi.spawnSyncWithTimeout;
    try {
        runGit(root, ['reset', '--', 'accepted.txt']);
        fs.mkdirSync(path.join(root, 'unrelated'));
        for (let index = 0; index < 500; index++) fs.writeFileSync(path.join(root, 'unrelated', `${index}.txt`), 'unchanged\n');
        for (const file of ['accepted[1].txt', 'accepted1.txt', '--accepted.txt', 'deleted.txt']) fs.writeFileSync(path.join(root, file), 'baseline\n');
        runGit(root, ['--literal-pathspecs', 'add', '--', 'unrelated', 'accepted[1].txt', 'accepted1.txt', '--accepted.txt', 'deleted.txt']);
        runGit(root, ['commit', '-m', 'test: unrelated repository baseline']);
        fs.writeFileSync(path.join(root, 'accepted[1].txt'), 'accepted bracket content\n');
        fs.writeFileSync(path.join(root, '--accepted.txt'), 'accepted leading dash content\n');
        fs.unlinkSync(path.join(root, 'deleted.txt'));
        runGit(root, ['--literal-pathspecs', 'add', '--', ...files]);
        auditFixture(t, root, 'PASS', 'PASS', false, files);
        t.mock.method(subprocessApi, 'spawnSyncWithTimeout', (...args: Parameters<typeof originalSpawn>) => {
            const result = originalSpawn(...args);
            const listing = args[1].find((argument) => argument === 'ls-files' || argument === 'ls-tree');
            if (args[0] === 'git' && listing) listings.set(listing, result.stdout.split('\0').filter(Boolean).map((record) => record.slice(record.indexOf('\t') + 1)));
            return result;
        });
        assert.equal(await runHumanCommitCommand(['--task-id', TASK_ID, '--message', 'test: literal scoped commit'], { cwd: root }), 0);
        assert.deepEqual(listings.get('ls-files')?.sort(), ['--accepted.txt', 'accepted.txt', 'accepted[1].txt']);
        assert.deepEqual(listings.get('ls-tree')?.sort(), ['--accepted.txt', 'accepted[1].txt', 'deleted.txt']);
        assert.equal(runGit(root, ['show', 'HEAD:accepted[1].txt']).stdout, 'accepted bracket content\n');
        assert.equal(runGit(root, ['show', 'HEAD:accepted1.txt']).stdout, 'baseline\n');
        assert.equal(runGit(root, ['show', 'HEAD:unrelated/499.txt']).stdout, 'unchanged\n');
    } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('OFF blocks native commit even with fresh legacy operator confirmation', async () => {
    const root = fixture(false);
    try {
        const head = runGit(root, ['rev-parse', 'HEAD']).stdout;
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '--operator-confirmed', 'yes',
            '--operator-confirmed-at-utc', new Date().toISOString(), '-m', 'test: forbidden'], { cwd: root }), /permission is disabled/);
        assert.equal(runGit(root, ['rev-parse', 'HEAD']).stdout, head);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('authenticated ON permits the first native commit in an unborn Git workspace', async (t) => {
    const root = fixture(true, false);
    try {
        auditFixture(t, root);
        assert.equal(await runHumanCommitCommand(['--task-id', TASK_ID, '--message', 'test: initial accepted task'], { cwd: root }), 0);
        assert.equal(runGit(root, ['rev-list', '--parents', '-n', '1', 'HEAD']).stdout.trim().split(/\s+/u).length, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit rejects missing task identity, index and hook bypass arguments', async () => {
    const root = fixture();
    try {
        await assert.rejects(() => runHumanCommitCommand(['-m', 'test: no task'], { cwd: root }), /--task-id/);
        for (const argument of ['--amend', '--no-verify', '--all', '--only', '--', 'accepted.txt']) {
            await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: bypass', argument], { cwd: root }), /forbidden/);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit blocks failed audit and unrelated staged scope', async (t) => {
    const root = fixture();
    try {
        auditFixture(t, root, 'BLOCKED');
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: audit blocked'], { cwd: root }), /task audit PASS/);
        t.mock.restoreAll();
        auditFixture(t, root);
        fs.writeFileSync(path.join(root, 'unrelated.txt'), 'another task\n');
        runGit(root, ['add', 'unrelated.txt']);
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: extra scope'], { cwd: root }), /unrelated staged scope/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit rejects a rename hiding an unrelated staged deletion', async (t) => {
    const root = fixture();
    try {
        runGit(root, ['reset', '--', 'accepted.txt']);
        fs.writeFileSync(path.join(root, 'unrelated.txt'), 'accepted task content\n');
        runGit(root, ['add', 'unrelated.txt']);
        runGit(root, ['commit', '-m', 'test: unrelated baseline']);
        runGit(root, ['config', 'diff.renames', 'true']);
        runGit(root, ['add', 'accepted.txt']);
        runGit(root, ['rm', '--cached', 'unrelated.txt']);
        assert.equal(runGit(root, ['diff', '--cached', '--name-only']).stdout.trim(), 'accepted.txt');
        auditFixture(t, root);
        const head = runGit(root, ['rev-parse', 'HEAD']).stdout;
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: hidden deletion'], { cwd: root }), /unrelated staged scope/);
        assert.equal(runGit(root, ['rev-parse', 'HEAD']).stdout, head);
        assert.equal(fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8'), 'accepted task content\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit accepts a rename whose source and destination are both audited', async (t) => {
    const root = fixture();
    try {
        runGit(root, ['reset', '--', 'accepted.txt']);
        fs.writeFileSync(path.join(root, 'previous.txt'), 'accepted task content\n');
        runGit(root, ['add', 'previous.txt']);
        runGit(root, ['commit', '-m', 'test: rename baseline']);
        runGit(root, ['config', 'diff.renames', 'true']);
        runGit(root, ['add', 'accepted.txt']);
        runGit(root, ['rm', 'previous.txt']);
        auditFixture(t, root, 'PASS', 'PASS', false, ['accepted.txt', 'previous.txt']);
        assert.equal(await runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: audited rename'], { cwd: root }), 0);
        assert.equal(runGit(root, ['ls-tree', '--name-only', 'HEAD', 'previous.txt']).stdout.trim(), '');
        assert.equal(runGit(root, ['show', 'HEAD:accepted.txt']).stdout, 'accepted task content\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed post-commit audit preserves the real commit and reports blocked acceptance', async (t) => {
    const root = fixture();
    try {
        auditFixture(t, root, 'PASS', 'BLOCKED');
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: preserve failed acceptance'], { cwd: root }), /Post-commit task audit failed/);
        assert.match(runGit(root, ['log', '--format=%s', '-1']).stdout, /preserve failed acceptance/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit rejects a pre-commit hook changing accepted content before publishing HEAD', async (t) => {
    const root = fixture();
    try {
        auditFixture(t, root);
        installHook(root, 'pre-commit', "printf 'unreviewed hook content\\n' > accepted.txt\ngit add -- accepted.txt");
        const head = runGit(root, ['rev-parse', 'HEAD']).stdout;
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: hook mutation'], { cwd: root }), /hook|accepted|readiness/i);
        assert.equal(runGit(root, ['rev-parse', 'HEAD']).stdout, head);
        assert.equal(runGit(root, ['diff', '--cached', '--name-only']).stdout.trim(), 'accepted.txt');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit rejects a pre-commit hook changing unrelated scope before publishing HEAD', async (t) => {
    const root = fixture();
    try {
        auditFixture(t, root);
        installHook(root, 'pre-commit', "printf 'unreviewed hook content\\n' > unrelated.txt\ngit add -- unrelated.txt");
        const head = runGit(root, ['rev-parse', 'HEAD']).stdout;
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: hook mutation'], { cwd: root }), /hook|accepted|readiness/i);
        assert.equal(runGit(root, ['rev-parse', 'HEAD']).stdout, head);
        assert.equal(runGit(root, ['diff', '--cached', '--name-only']).stdout.trim(), 'accepted.txt');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit runs all configured commit hooks and preserves message edits', async (t) => {
    const root = fixture();
    try {
        auditFixture(t, root);
        for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
            const messageCheck = hook === 'prepare-commit-msg' ? '[ "$2" = message ] || exit 4\n' : '';
            const messageEdit = hook === 'commit-msg' ? 'printf "test: message normalized by hook\\n" > "$1"\n' : '';
            installHook(root, hook, `[ "$GIT_EDITOR" = : ] || exit 3\n${messageCheck}${messageEdit}printf '${hook}\\n' >> hook-order.log`);
        }
        assert.equal(await runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: original message'], { cwd: root }), 0);
        assert.equal(fs.readFileSync(path.join(root, 'hook-order.log'), 'utf8'), 'pre-commit\nprepare-commit-msg\ncommit-msg\npost-commit\n');
        assert.equal(runGit(root, ['log', '--format=%s', '-1']).stdout.trim(), 'test: message normalized by hook');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function failedSubprocessFixture(t: TestContext, failure: 'nonzero' | 'timeout' | 'throw') {
    const root = fixture();
    const evidence = auditFixture(t, root);
    const head = runGit(root, ['rev-parse', 'HEAD']).stdout;
    const originalSpawn = subprocessApi.spawnStreamed;
    t.mock.method(subprocessApi, 'spawnStreamed', async (...args: Parameters<typeof originalSpawn>) => {
        const result = await originalSpawn(...args);
        if (runGit(root, ['rev-parse', 'HEAD']).stdout === head) return result;
        if (failure === 'throw') throw new Error('post-commit subprocess failure');
        return { ...result, exitCode: 3, timedOut: failure === 'timeout' };
    });
    return { root, head, evidence };
}

test('native commit audits a real commit after failed subprocess nonzero', async (t) => {
    const { root, head, evidence } = failedSubprocessFixture(t, 'nonzero');
    try {
        assert.equal(await runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: audit after failure'], { cwd: root }), 3);
        assert.notEqual(runGit(root, ['rev-parse', 'HEAD']).stdout, head);
        assert.equal(evidence.audit.mock.callCount(), 2);
        assert.equal(evidence.synchronize.mock.callCount(), 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit audits a real commit after failed subprocess timeout', async (t) => {
    const { root, head, evidence } = failedSubprocessFixture(t, 'timeout');
    try {
        assert.equal(await runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: audit after failure'], { cwd: root }), 3);
        assert.notEqual(runGit(root, ['rev-parse', 'HEAD']).stdout, head);
        assert.equal(evidence.audit.mock.callCount(), 2);
        assert.equal(evidence.synchronize.mock.callCount(), 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit audits a real commit after failed subprocess throw', async (t) => {
    const { root, head, evidence } = failedSubprocessFixture(t, 'throw');
    try {
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: audit after failure'], { cwd: root }), /subprocess failure/);
        assert.notEqual(runGit(root, ['rev-parse', 'HEAD']).stdout, head);
        assert.equal(evidence.audit.mock.callCount(), 2);
        assert.equal(evidence.synchronize.mock.callCount(), 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit preserves configured signing and fails before publishing when signing is unavailable', async (t) => {
    const root = fixture();
    try {
        auditFixture(t, root);
        runGit(root, ['config', 'commit.gpgSign', 'true']);
        runGit(root, ['config', 'gpg.program', path.join(root, 'missing-signing-program')]);
        const head = runGit(root, ['rev-parse', 'HEAD']).stdout;
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: required signing'], { cwd: root }), /gpg|sign/i);
        assert.equal(runGit(root, ['rev-parse', 'HEAD']).stdout, head);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit rejects inherited Git index overrides', async (t) => {
    const root = fixture();
    const previous = process.env.GIT_INDEX_FILE;
    try {
        auditFixture(t, root);
        process.env.GIT_INDEX_FILE = path.join(root, 'foreign.index');
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: foreign index'], { cwd: root }), /inherited Git/);
    } finally {
        if (previous === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = previous;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('native commit rejects index replacement during audit before Git launch', async (t) => {
    const root = fixture();
    try {
        t.mock.method(auditApi, 'buildTaskAuditSummary', () => {
            fs.writeFileSync(path.join(root, 'accepted.txt'), 'changed after approval\n');
            runGit(root, ['add', 'accepted.txt']);
            return { status: 'PASS', integrity_status: 'PASS', final_closeout: { implementation_summary: { changed_files: ['accepted.txt'],
                scope_content_sha256: buildScopeContentFingerprint(root, 'explicit_changed_files', ['accepted.txt']) } } };
        });
        const head = runGit(root, ['rev-parse', 'HEAD']).stdout;
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: raced index'], { cwd: root }), /readiness changed/);
        assert.equal(runGit(root, ['rev-parse', 'HEAD']).stdout, head);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit rejects a preexisting staged blob that differs from accepted working content', async (t) => {
    const root = fixture();
    try {
        fs.writeFileSync(path.join(root, 'accepted.txt'), 'reviewed newer working content\n');
        auditFixture(t, root);
        const head = runGit(root, ['rev-parse', 'HEAD']).stdout;
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: stale staged blob'], { cwd: root }), /staged content differs/);
        assert.equal(runGit(root, ['rev-parse', 'HEAD']).stdout, head);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit rejects restored unaccepted working content after the audit', async (t) => {
    const root = fixture();
    try {
        fs.writeFileSync(path.join(root, 'accepted.txt'), 'reviewed newer working content\n');
        const acceptedHash = buildScopeContentFingerprint(root, 'explicit_changed_files', ['accepted.txt']);
        t.mock.method(auditApi, 'buildTaskAuditSummary', () => {
            fs.writeFileSync(path.join(root, 'accepted.txt'), 'accepted task content\n');
            return { status: 'PASS', integrity_status: 'PASS', final_closeout: { implementation_summary: {
                changed_files: ['accepted.txt'], scope_content_sha256: acceptedHash } } };
        });
        const head = runGit(root, ['rev-parse', 'HEAD']).stdout;
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: restored unaccepted blob'], { cwd: root }), /captured content differs/);
        assert.equal(runGit(root, ['rev-parse', 'HEAD']).stdout, head);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native working-tree commit rejects unaudited staged-only executable mode changes', async (t) => {
    const root = fixture();
    try {
        runGit(root, ['config', 'core.filemode', 'false']);
        runGit(root, ['update-index', '--chmod=+x', 'accepted.txt']);
        auditFixture(t, root);
        const head = runGit(root, ['rev-parse', 'HEAD']).stdout;
        await assert.rejects(() => runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: changed staged mode'], { cwd: root }), /staged mode differs/);
        assert.equal(runGit(root, ['rev-parse', 'HEAD']).stdout, head);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native commit preserves Git EOL normalization of authenticated working bytes', async (t) => {
    const root = fixture();
    try {
        runGit(root, ['config', 'core.autocrlf', 'true']);
        fs.writeFileSync(path.join(root, 'accepted.txt'), 'accepted task content\r\n');
        runGit(root, ['add', 'accepted.txt']);
        auditFixture(t, root);
        assert.equal(await runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: accepted EOL normalization'], { cwd: root }), 0);
        assert.equal(runGit(root, ['show', 'HEAD:accepted.txt']).stdout, 'accepted task content\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native staged validation preserves accepted blob identity when working content differs', async (t) => {
    const root = fixture();
    try {
        fs.writeFileSync(path.join(root, 'accepted.txt'), 'unaccepted unstaged changes\n');
        auditFixture(t, root, 'PASS', 'PASS', true);
        assert.equal(await runHumanCommitCommand(['--task-id', TASK_ID, '-m', 'test: accepted staged scope'], { cwd: root }), 0);
        assert.equal(runGit(root, ['show', 'HEAD:accepted.txt']).stdout, 'accepted task content\n');
        assert.equal(fs.readFileSync(path.join(root, 'accepted.txt'), 'utf8'), 'unaccepted unstaged changes\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native surfaces advertise task-bound commit authority and no repeated confirmation', () => {
    for (const text of [getNodeHumanCommitCommand(), buildCommitGuardManagedBlock(), buildGateHelpText('human-commit', path.resolve('.'))]) {
        assert.match(text, /human-commit.*--task-id/);
        assert.match(text, /--message/);
    }
});

test('legacy timestamp arguments cannot forge fresh confirmation', async () => {
    await assert.rejects(() => runHumanCommitCommand(['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', 'not-a-time', '-m', 'test: invalid']), /valid ISO-8601/);
    await assert.rejects(() => runHumanCommitCommand(['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date(Date.now() - 11 * 60_000).toISOString(), '-m', 'test: stale']), /confirmation is stale/);
});
