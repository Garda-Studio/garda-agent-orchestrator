import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import type { ValidationAttempt } from '../../../../src/core/project-validation-contract';
import { validationDigest } from '../../../../src/core/project-validation-identity';
import { readValidationAttemptFacts, evaluateValidationAttempt } from '../../../../src/gates/project-validation/result-evaluation';
import { pathListSha256 } from '../../../../src/gates/shared/canonical-path-list';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { runClassifyChangeCommand } from '../../../../src/cli/commands/gates';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode, runHandshakeForTask, runShellSmokeForTask,
    seedInitAnswers, seedTaskQueue } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';

const taskId = 'T-1';
type Execute = (options: { repoRoot: string; taskId: string; recipeId: string; signal?: AbortSignal }) => Promise<ValidationAttempt>;
function execute(root: string, signal?: AbortSignal): Promise<ValidationAttempt> {
    const run = (require('../../../../src/gates/project-validation/execution') as { executeValidationRecipe: Execute }).executeValidationRecipe;
    return run({ repoRoot: root, taskId, recipeId: 'recipe', signal });
}
function fixture(mode = 'ok', capability = false, alternateTool = false, reports = false) {
    const root = createTempRepo(), bundle = path.join(root, 'garda-agent-orchestrator');
    const config = path.join(bundle, 'live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify(buildDefaultWorkflowConfig()));
    fs.mkdirSync(path.join(root, 'work')); fs.mkdirSync(path.join(root, 'specifications'));
    fs.writeFileSync(path.join(root, 'specifications/case.unknown'), 'declared case');
    fs.writeFileSync(path.join(root, 'tool.bin'), 'ordinary executable identity fixture');
    fs.writeFileSync(path.join(root, 'driver.cjs'), [
        'const fs=require("node:fs"),mode=process.argv[2];',
        'if(mode==="wait")setInterval(()=>{},1000);',
        'else if(mode==="signal")process.kill(process.pid,"SIGTERM");',
        'else if(mode==="mutate")fs.writeFileSync("../src/app.ts","changed during execution");',
        'else if(mode==="large")process.stdout.write("x".repeat(4096));',
        'else if(mode==="report")fs.writeFileSync("purchase.result",JSON.stringify({case:"purchase",outcome:"PASSED",actual:125}));',
        'else {process.stdout.write(JSON.stringify({argv:process.argv.slice(2),value:process.env.EXPLICIT}));process.exitCode=mode==="fail"?7:0;}'
    ].join('\n'));
    const declaration = { schema_version: 1, recipes: [{ id: 'recipe', purpose: 'validation',
        executable: alternateTool ? path.join(root, 'tool.bin') : process.execPath,
        argv: ['../driver.cjs', mode, { target: 'case' }], cwd: 'work',
        inputs: [{ path: 'src/app.ts', role: 'source' }, { path: 'specifications/case.unknown', role: 'test' }, { path: 'driver.cjs', role: 'helper' }],
        targets: [{ id: 'case', source: 'specifications/case.unknown', selector: 'literal selector' }], environment: { EXPLICIT: 'value' },
        timeout_ms: mode === 'wait' ? 150 : 5000, max_attempts: 1, max_output_bytes: 1024, max_input_bytes: 65536,
        required_capabilities: capability ? ['offline'] : [], result_format: 'opaque',
        ...(reports ? { report_files: [{ path: 'work/purchase.result', max_bytes: 4096 }] } : {}) }] };
    fs.writeFileSync(path.join(root, 'recipes.json'), JSON.stringify(declaration));
    seedInitAnswers(root); seedTaskQueue(root, taskId, 'TODO', 'default', 'Required reviews: code, security, test.', 'Change validation source');
    initializeGitRepo(root);
    handleWorkflow(['set', '--target-root', root, '--project-validation-contract', 'recipes.json', '--operator-confirmed', 'yes',
        '--operator-confirmed-at-utc', new Date().toISOString()], { name: 'garda-agent-orchestrator', version: '1.0.0' });
    runEnterTaskMode({ repoRoot: root, taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Change validation source', provider: 'Codex' });
    loadTaskEntryRulePack(root, taskId); runHandshakeForTask(root, taskId); runShellSmokeForTask(root, taskId);
    fs.appendFileSync(path.join(root, 'src/app.ts'), '\nexport const value = 1;\n');
    const preflight = path.join(bundle, `runtime/reviews/${taskId}-preflight.json`);
    const classify = (changedFiles = ['src/app.ts'], useStaged = false) => runClassifyChangeCommand({ repoRoot: root, taskId, taskIntent: 'Change validation source',
        outputPath: preflight, changedFiles: useStaged ? undefined : changedFiles, useStaged, emitMetrics: false });
    classify();
    return { root, bundle, preflight, classify, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
it('retains actual declared file output bound to its recipe start with independent semantics pending', async () => {
    const f = fixture('report', false, false, true);
    try {
        const attempt = await execute(f.root);
        assert.equal(attempt.exit_code, 0); assert.deepEqual(attempt.violations, []);
        const facts = readValidationAttemptFacts(f.root, taskId, attempt.attempt_id);
        assert.equal(facts.decoded[0].length, 0);
        assert.match(facts.reports.texts[0], /"case":"purchase","outcome":"PASSED","actual":125/);
        assert.equal((await evaluateValidationAttempt({ repoRoot: f.root, taskId, attemptId: attempt.attempt_id })).status, 'UNRESOLVED');
        fs.writeFileSync(path.join(f.root, 'work/purchase.result'), 'changed after the native execution');
        assert.deepEqual(readValidationAttemptFacts(f.root, taskId, attempt.attempt_id).reports, facts.reports);
        fs.appendFileSync(path.join(f.root, attempt.output_path), 'changed');
        assert.throws(() => readValidationAttemptFacts(f.root, taskId, attempt.attempt_id), /digest changed/);
    } finally { f.clean(); }
});

it('records missing and stale declared reports as actual failed attempts even when the child exits zero', async () => {
    for (const stale of [false, true]) {
        const f = fixture('ok', false, false, true);
        try {
            if (stale) fs.writeFileSync(path.join(f.root, 'work/purchase.result'), 'old success');
            const attempt = await execute(f.root);
            assert.equal(attempt.exit_code, 0); assert.equal(attempt.violations.length, 1);
            const result = await evaluateValidationAttempt({ repoRoot: f.root, taskId, attemptId: attempt.attempt_id });
            assert.equal(result.status, 'FAILED');
            assert.equal(readValidationAttemptFacts(f.root, taskId, attempt.attempt_id).reports.texts.length, 0);
        } finally { f.clean(); }
    }
});
function retained(root: string, attempt: ValidationAttempt) {
    const output = fs.readFileSync(path.join(root, attempt.output_path));
    const sources = fs.readFileSync(path.join(root, attempt.source_archive_path));
    assert.equal(validationDigest(output), attempt.output_sha256); assert.equal(validationDigest(sources), attempt.source_archive_sha256);
    return { output: JSON.parse(output.toString()) as { stdout_base64: string; stderr_base64: string }, sources: JSON.parse(sources.toString()) as Array<{ path: string; content_base64: string }> };
}
it('retains actual admitted argv execution and immutable source output facts without semantic acceptance', async () => {
    const f = fixture();
    try {
        const attempt = await execute(f.root), data = retained(f.root, attempt);
        assert.equal(attempt.exit_code, 0); assert.equal(attempt.cases, null); assert.deepEqual(attempt.violations, []);
        assert.equal(attempt.cancelled, false); assert.equal(attempt.timed_out, false);
        assert.deepEqual(JSON.parse(Buffer.from(data.output.stdout_base64, 'base64').toString()), { argv: ['ok', 'literal selector'], value: 'value' });
        const events = fs.readFileSync(path.join(f.bundle, `runtime/task-events/${taskId}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(events.filter(e => e.event_type === 'PROJECT_VALIDATION_STARTED').length, 1);
        assert.equal(events.filter(e => e.event_type === 'PROJECT_VALIDATION_COMPLETED').at(-1).details.attempt_id, attempt.attempt_id);
        assert.ok(data.sources.some(s => s.path === 'src/app.ts'));
    } finally { f.clean(); }
});
it('preserves failed attempts and serialized budget across a native preflight refresh', async () => {
    const f = fixture('fail');
    try {
        const pending = execute(f.root); await assert.rejects(execute(f.root), /lock|budget/u);
        const attempt = await pending, before = fs.readFileSync(path.join(f.root, attempt.output_path));
        assert.equal(attempt.exit_code, 7); retained(f.root, attempt); f.classify();
        await assert.rejects(execute(f.root), /budget/u); assert.deepEqual(fs.readFileSync(path.join(f.root, attempt.output_path)), before);
    } finally { f.clean(); }
});
it('rejects successful case claims for actual timeout and prelaunch cancellation', async () => {
    const timed = fixture('wait'), cancelled = fixture();
    try {
        const timeout = await execute(timed.root), controller = new AbortController(); controller.abort();
        const cancellation = await execute(cancelled.root, controller.signal);
        assert.equal(timeout.timed_out, true); assert.equal(cancellation.cancelled, true);
        assert.equal(timeout.cases, null); assert.equal(cancellation.cases, null); retained(timed.root, timeout); retained(cancelled.root, cancellation);
    } finally { timed.clean(); cancelled.clean(); }
});
it('preserves only the termination signal actually observed from the current platform child', async () => {
    const f = fixture('signal'), mutable = require('node:child_process') as typeof childProcess, original = mutable.spawn;
    let observed: NodeJS.Signals | null = null;
    mutable.spawn = ((command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
        const child = original(command, args, options); child.once('close', (_code, signal) => { observed = signal; }); return child;
    }) as typeof original;
    try { const attempt = await execute(f.root); assert.equal((attempt as ValidationAttempt & { termination_signal: string | null }).termination_signal, observed); }
    finally { mutable.spawn = original; f.clean(); }
});
it('rejects foreign or altered native preflight bindings before launch', async () => {
    const f = fixture();
    try {
        const original = JSON.parse(fs.readFileSync(f.preflight, 'utf8'));
        fs.writeFileSync(f.preflight, JSON.stringify({ ...original, task_id: 'T-FOREIGN' }));
        await assert.rejects(execute(f.root), /preflight|Foreign/u);
        fs.writeFileSync(f.preflight, JSON.stringify({ ...original, changed_files: [] }));
        await assert.rejects(execute(f.root), /scope|preflight/u);
    } finally { f.clean(); }
});
it('rejects paired preflight file-list and digest tampering without native classification', async () => {
    const f = fixture();
    try {
        fs.writeFileSync(path.join(f.root, 'src/other.ts'), 'task-owned source outside recipe inputs');
        f.classify(['src/app.ts', 'src/other.ts']);
        const original = JSON.parse(fs.readFileSync(f.preflight, 'utf8')), changedFiles = ['src/app.ts'];
        fs.writeFileSync(f.preflight, JSON.stringify({ ...original, changed_files: changedFiles,
            metrics: { ...original.metrics, changed_files_sha256: pathListSha256(changedFiles) } }));
        await assert.rejects(execute(f.root), /scope|preflight/u);
    } finally { f.clean(); }
});
it('rejects staged-to-worktree source mutation before launch and permits matching bytes', async () => {
    const matching = fixture(), changed = fixture();
    try {
        for (const f of [matching, changed]) {
            childProcess.execFileSync('git', ['-C', f.root, 'add', '--', 'src/app.ts']);
            f.classify(undefined, true);
        }
        fs.appendFileSync(path.join(changed.root, 'src/app.ts'), '\nexport const unclassified = 2;\n');
        assert.equal((await execute(matching.root)).exit_code, 0);
        await assert.rejects(execute(changed.root), /scope|preflight/u);
    } finally { matching.clean(); changed.clean(); }
});
it('rejects changed approved executable and replaced helper identities before launch', async () => {
    const tool = fixture('ok', false, true), helper = fixture();
    try {
        fs.appendFileSync(path.join(tool.root, 'tool.bin'), 'changed');
        await assert.rejects(execute(tool.root), /executable|identity/u);
        const file = path.join(helper.root, 'driver.cjs'); fs.renameSync(file, file + '.original'); fs.copyFileSync(file + '.original', file);
        await assert.rejects(execute(helper.root), /dependency|identity/u);
    } finally { tool.clean(); helper.clean(); }
});
it('rejects unenforced capabilities and replaced cwd containment before launch', async () => {
    const capability = fixture('ok', true), cwd = fixture();
    try {
        await assert.rejects(execute(capability.root), /enforc|capabilit/u);
        fs.rmdirSync(path.join(cwd.root, 'work')); fs.symlinkSync(path.join(cwd.root, 'specifications'), path.join(cwd.root, 'work'), 'junction');
        await assert.rejects(execute(cwd.root), /symlink|junction|contain/u);
    } finally { capability.clean(); cwd.clean(); }
});
it('rejects unchanged source identity after mutation during actual execution', async () => {
    const f = fixture('mutate');
    try {
        const before = fs.readFileSync(path.join(f.root, 'src/app.ts')), attempt = await execute(f.root), data = retained(f.root, attempt);
        assert.ok(attempt.violations.some(v => /identit|changed/u.test(v)));
        assert.deepEqual(Buffer.from(data.sources.find(s => s.path === 'src/app.ts')!.content_base64, 'base64'), before);
    } finally { f.clean(); }
});
it('rejects verified cases for over-budget output while preserving bounded bytes', async () => {
    const f = fixture('large');
    try {
        const attempt = await execute(f.root), data = retained(f.root, attempt);
        assert.equal(attempt.truncated, true); assert.equal(attempt.cases, null);
        assert.ok(Buffer.from(data.output.stdout_base64, 'base64').length + Buffer.from(data.output.stderr_base64, 'base64').length <= 1024);
    } finally { f.clean(); }
});
