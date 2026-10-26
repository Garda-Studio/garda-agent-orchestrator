import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runClassifyChangeCommand, runIntermediateCommandCommand } from '../../../../../../src/cli/commands/gates';
import { readTaskOwnedIntermediateExecutionEvidence } from '../../../../../../src/gates/review/focused-intermediate-evidence';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode,
    runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, seedTaskQueue } from '../preflight/gates-preflight-fixtures';

const TASK_ID = 'T-UNIVERSAL-COMMAND';
const SOURCE = 'custom/Оплата.case';
const RUNNER = 'custom/check.cjs';
const EXECUTION_MARKER = 'garda-agent-orchestrator/runtime/tmp/universal-command-executed.txt';

function fixture(mutate = false, markExecution = false) {
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, TASK_ID); seedInitAnswers(repoRoot); initializeGitRepo(repoRoot);
    const entry = runEnterTaskMode({ repoRoot, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2, taskSummary: 'Native command proof', provider: 'Codex' });
    assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
    loadTaskEntryRulePack(repoRoot, TASK_ID);
    runHandshakeForTask(repoRoot, TASK_ID); runShellSmokeForTask(repoRoot, TASK_ID);
    fs.mkdirSync(path.join(repoRoot, 'custom'));
    fs.writeFileSync(path.join(repoRoot, SOURCE), 'rejectsEmptyPayment\n');
    fs.writeFileSync(path.join(repoRoot, RUNNER), [
        "const fs = require('node:fs');",
        `const value = fs.readFileSync(${JSON.stringify(SOURCE)}, 'utf8');`,
        "console.log('observed:' + value.trim());",
        ...(markExecution ? [
            `fs.mkdirSync(${JSON.stringify(path.posix.dirname(EXECUTION_MARKER))}, { recursive: true });`,
            `fs.writeFileSync(${JSON.stringify(EXECUTION_MARKER)}, 'executed');`
        ] : []),
        ...(mutate ? [`fs.appendFileSync(${JSON.stringify(SOURCE)}, 'changed');`] : []), ''
    ].join('\n'));
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
    const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
    const classified = runClassifyChangeCommand({ repoRoot, taskId: TASK_ID, taskIntent: 'Native command proof',
        changedFiles: [SOURCE, RUNNER], outputPath: preflightPath });
    assert.ok(fs.existsSync(preflightPath), classified.outputText);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    const read = (requestedHash?: string) => readTaskOwnedIntermediateExecutionEvidence({ repoRoot, reviewsRoot,
        eventsRoot: path.join(repoRoot, 'garda-agent-orchestrator/runtime/task-events'), taskId: TASK_ID,
        expectedPreflightPath: preflightPath.replace(/\\/g, '/'),
        expectedPreflightSha256: requestedHash ?? createHash('sha256').update(fs.readFileSync(preflightPath)).digest('hex'),
        expectedScopeContentSha256: preflight.metrics.scope_content_sha256 });
    return { repoRoot, preflightPath, read };
}

it('round-trips actual custom project execution through the native proof reader without a recipe declaration', async t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const result = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
        commandSource: 'targeted-test', command: `node ${RUNNER} --select rejectsEmptyPayment`, preflightPath: f.preflightPath });
    assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
    const recordPath = result.outputLines.find(line => line.startsWith('ArtifactPath: '))?.slice('ArtifactPath: '.length);
    assert.ok(recordPath);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.deepEqual(record.command_descriptor, { schema_version: 1, purpose: 'test',
        invocations: [{ executable: 'node', argv: [RUNNER, '--select', 'rejectsEmptyPayment'] }] });
    const proof = f.read();
    assert.equal(proof.entries.length, 1, proof.warnings.join('\n'));
    assert.match(fs.readFileSync(proof.entries[0].output_artifact_path, 'utf8'), /observed:rejectsEmptyPayment/u);
    assert.equal(proof.entries[0].execution, 'OBSERVED');
    assert.equal(proof.entries[0].semantic_status, 'PENDING_INDEPENDENT_REVIEW');
    assert.equal('cases' in proof.entries[0], false);
});

it('retains the real process output but rejects source mutation as current execution proof', async t => {
    const f = fixture(true); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const result = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
        commandSource: 'targeted-test', command: `node ${RUNNER} --select rejectsEmptyPayment`, preflightPath: f.preflightPath });
    assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
    const proof = f.read();
    assert.equal(proof.entries.length, 0);
    assert.ok(proof.warnings.some(warning => warning.includes('source-content binding')));
});

it('rejects an unfamiliar invocation when no current native preflight authorizes its source scope', async t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const result = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
        commandSource: 'targeted-test', command: `node ${RUNNER} --select rejectsEmptyPayment` });
    assert.notEqual(result.exitCode, 0);
    assert.equal(f.read().entries.length, 0);
});

it('rejects a supplied preflight digest that differs from the actually observed native document', async t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const fabricatedHash = '0'.repeat(64);
    const result = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
        commandSource: 'targeted-test', command: `node ${RUNNER} --select rejectsEmptyPayment`,
        preflightPath: f.preflightPath, preflightSha256: fabricatedHash });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.outputLines.join('\n'), /preflight/iu);
    assert.equal(f.read(fabricatedHash).entries.length, 0);
});

it('rejects retained old preflight evidence after same-cycle classification publishes a new canonical path', async t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const run = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
        commandSource: 'targeted-test', command: `node ${RUNNER} --select rejectsEmptyPayment`,
        preflightPath: f.preflightPath });
    assert.equal(run.exitCode, 0, run.outputLines.join('\n'));
    assert.equal(f.read().entries.length, 1);
    const original = fs.readFileSync(f.preflightPath);
    const newPath = f.preflightPath + '.next.json';
    const classified = runClassifyChangeCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
        taskIntent: 'Native command proof', changedFiles: [SOURCE, RUNNER], outputPath: newPath });
    assert.ok(fs.existsSync(newPath), classified.outputText);
    assert.deepEqual(fs.readFileSync(f.preflightPath), original);
    assert.equal(f.read().entries.length, 0);
});

for (const failure of ['stale', 'missing'] as const) {
    it(`explains a supplied ${failure} preflight and how to refresh it without running the command`, async t => {
        const f = fixture(false, true); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        const preflightHash = createHash('sha256').update(fs.readFileSync(f.preflightPath)).digest('hex');
        if (failure === 'stale') fs.appendFileSync(path.join(f.repoRoot, SOURCE), 'changed source\n');
        else fs.unlinkSync(f.preflightPath);
        const result = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK_ID,
            commandSource: 'targeted-test', command: `node ${RUNNER} --select rejectsEmptyPayment`, preflightPath: f.preflightPath });
        const text = result.outputLines.join('\n');
        assert.notEqual(result.exitCode, 0, text);
        assert.doesNotMatch(text, /Add --preflight-path/u);
        assert.match(text, failure === 'stale' ? /scope|content|changed/iu : /Supplied preflight is missing \(ENOENT\)/u);
        assert.match(text, /next-step "T-UNIVERSAL-COMMAND" --repo-root "."/u);
        assert.equal(f.read(preflightHash).entries.length, 0);
        assert.equal(fs.existsSync(path.join(f.repoRoot, EXECUTION_MARKER)), false);
    });
}
