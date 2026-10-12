import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { buildDefaultWorkflowConfig } from '../../../../../../src/core/workflow-config';
import { handleWorkflow } from '../../../../../../src/cli/commands/workflow-command';
import { runClassifyChangeCommand } from '../../../../../../src/cli/commands/gates';
import { validationDigest } from '../../../../../../src/core/project-validation-identity';
import { evaluateValidationAttempt } from '../../../../../../src/gates/project-validation/result-evaluation';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode, runHandshakeForTask, runShellSmokeForTask,
    seedInitAnswers, seedTaskQueue } from '../preflight/gates-preflight-fixtures';

const taskId = 'T-1';
function fixture(mode = 'ok', expectedRed = false, customPolicy = false) {
    const root = createTempRepo(), bundle = path.join(root, 'garda-agent-orchestrator'), test = expectedRed && !customPolicy ? 'tests/case.test.ts' : 'specifications/case.custom';
    fs.mkdirSync(path.join(bundle, 'live/config'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'live/config/workflow-config.json'), JSON.stringify(buildDefaultWorkflowConfig()));
    if (customPolicy) {
        fs.copyFileSync(path.join(process.cwd(), 'template/config/profiles.json'), path.join(bundle, 'live/config/profiles.json'));
        fs.writeFileSync(path.join(bundle, 'live/config/paths.json'), JSON.stringify({ triggers: { test: ['(^|/)specifications/'] } }));
    }
    fs.mkdirSync(path.dirname(path.join(root, test)), { recursive: true }); fs.writeFileSync(path.join(root, test), 'export {};\n');
    fs.writeFileSync(path.join(root, 'driver.cjs'), [
        'const mode=process.argv[2],target=process.argv[3];',
        'if(mode==="wait")setInterval(()=>{},1000);',
        'else {const text=mode==="zero"?"1..0":mode==="malformed"?"success":`TAP version 13\\n${mode==="fail"?"not ok":"ok"} 1 - ${mode==="missing"?"other case":target}${mode==="skip"?" # SKIP disabled":""}\\n1..1\\n`;process.stdout.write(text);process.exitCode=mode==="fail"?7:0;}'
    ].join('\n'));
    const contract = { schema_version: 1, recipes: [{ id: 'recipe', purpose: 'test', executable: process.execPath,
        argv: ['driver.cjs', mode, { target: 'case' }], cwd: '.', inputs: [{ path: 'src/app.ts', role: 'source' }, { path: test, role: 'test' }, { path: 'driver.cjs', role: 'helper' }],
        targets: [{ id: 'case', source: test, selector: 'declared custom case' }], environment: {}, timeout_ms: mode === 'wait' ? 150 : 5000,
        max_attempts: 1, max_output_bytes: 1024, max_input_bytes: 65536, required_capabilities: [], result_format: 'tap' }] };
    fs.writeFileSync(path.join(root, 'recipes.json'), JSON.stringify(contract));
    seedInitAnswers(root); seedTaskQueue(root, taskId, 'TODO', 'default', expectedRed ? 'Test-first: expected-red.' : 'Required reviews: code, security, test.', 'Validate admitted recipe');
    initializeGitRepo(root);
    handleWorkflow(['set', '--target-root', root, '--project-validation-contract', 'recipes.json', '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()], { name: 'garda-agent-orchestrator', version: '1.0.0' });
    runEnterTaskMode({ repoRoot: root, taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2, taskSummary: 'Validate admitted recipe', provider: 'Codex' });
    loadTaskEntryRulePack(root, taskId); runHandshakeForTask(root, taskId); runShellSmokeForTask(root, taskId);
    if (customPolicy) fs.writeFileSync(path.join(bundle, 'live/config/paths.json'), JSON.stringify({ triggers: { test: ['(^|/)other-tests/'] } }));
    const changed = expectedRed ? test : 'src/app.ts'; fs.appendFileSync(path.join(root, changed), '\nexport const changed = 1;\n');
    runClassifyChangeCommand({ repoRoot: root, taskId, taskIntent: 'Validate admitted recipe', changedFiles: [changed], outputPath: path.join(bundle, `runtime/reviews/${taskId}-preflight.json`), emitMetrics: false });
    const events = () => fs.readFileSync(path.join(bundle, `runtime/task-events/${taskId}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const run = (...flags: string[]) => childProcess.spawnSync(process.execPath, [path.join(process.cwd(), 'bin/garda.js'), 'gate', 'run-intermediate-command', '--task-id', taskId, '--recipe-id', 'recipe', '--repo-root', root, ...flags], { cwd: root, encoding: 'utf8', timeout: 90_000 });
    return { root, events, run, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
it('runs an admitted custom target through the actual CLI and rejects altered retained facts', async () => {
    const f = fixture();
    try {
        const run = f.run(); assert.equal(run.error, undefined); assert.equal(run.status, 0, run.stderr || run.stdout); assert.match(run.stdout, /PROJECT_VALIDATION_PASSED/u);
        const events = f.events(), completed = events.find(e => e.event_type === 'PROJECT_VALIDATION_COMPLETED'), evaluated = events.find(e => e.event_type === 'PROJECT_VALIDATION_RESULTS_EVALUATED');
        assert.ok(completed); assert.ok(evaluated);
        const original = fs.readFileSync(path.join(f.root, completed.details.artifact_path)), attempt = JSON.parse(original.toString());
        const resultBytes = fs.readFileSync(path.join(f.root, evaluated.details.artifact_path)), result = JSON.parse(resultBytes.toString());
        assert.equal(validationDigest(original), completed.details.artifact_sha256); assert.equal(validationDigest(resultBytes), evaluated.details.artifact_sha256);
        assert.equal(attempt.cases, null); assert.equal(attempt.expected_failure, false); assert.equal(result.attempt_sha256, completed.details.artifact_sha256);
        assert.deepEqual(result.cases, [{ id: 'declared custom case', outcome: 'passed' }]);
        for (const relative of [attempt.output_path, attempt.source_archive_path, completed.details.artifact_path]) {
            const p = path.join(f.root, relative), bytes = fs.readFileSync(p); fs.appendFileSync(p, 'changed');
            await assert.rejects(evaluateValidationAttempt({ repoRoot: f.root, taskId, attemptId: attempt.attempt_id }), /digest changed/u); fs.writeFileSync(p, bytes);
        }
    } finally { f.clean(); }
});
it('rejects recipe command output timeout and scope overrides before any execution', () => {
    const f = fixture();
    try {
        for (const flags of [['--command', 'echo widened'], ['--command-source', 'targeted-test'], ['--output-path', 'other.log'], ['--timeout-ms', '60000'], ['--preflight-path', 'other.json'], ['--expect-failure']]) {
            const run = f.run(...flags); assert.equal(run.error, undefined); assert.notEqual(run.status, 0); assert.match(run.stderr + run.stdout, /forbids|requires current native test-only/u);
        }
        assert.equal(f.events().filter(e => e.event_type === 'PROJECT_VALIDATION_STARTED').length, 0);
    } finally { f.clean(); }
});
it('retains real failed attempts without accepting malformed zero missing or skipped targets', () => {
    for (const mode of ['fail', 'malformed', 'zero', 'missing', 'skip']) {
        const f = fixture(mode);
        try {
            const run = f.run(); assert.equal(run.error, undefined); assert.notEqual(run.status, 0); assert.match(run.stdout, /PROJECT_VALIDATION_(FAILED|UNRESOLVED)/u);
            const completed = f.events().find(e => e.event_type === 'PROJECT_VALIDATION_COMPLETED'); assert.ok(completed);
            assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, completed.details.artifact_path), 'utf8')).exit_code, mode === 'fail' ? 7 : 0);
        } finally { f.clean(); }
    }
});
it('expected red accepts an actual declared target failure but never a timed-out attempt', () => {
    const observed: Array<number | null> = [];
    for (const mode of ['fail', 'wait']) {
        const f = fixture(mode, true);
        try {
            const run = f.run('--expect-failure'); assert.equal(run.error, undefined); assert.equal(run.status, mode === 'fail' ? 0 : 3, run.stderr || run.stdout);
            observed.push(run.status);
            assert.match(run.stdout, mode === 'fail' ? /PROJECT_VALIDATION_EXPECTED_FAILURE/u : /PROJECT_VALIDATION_FAILED/u);
        } finally { f.clean(); }
    }
    assert.deepEqual(observed, [0, 3]);
});
it('expected red retains the native frozen custom test-path policy after global policy changes', () => {
    const f = fixture('fail', true, true);
    try {
        const run = f.run('--expect-failure');
        assert.equal(run.error, undefined); assert.equal(run.status, 0, run.stderr || run.stdout);
        assert.match(run.stdout, /PROJECT_VALIDATION_EXPECTED_FAILURE/u);
        assert.equal(f.events().filter(e => e.event_type === 'PROJECT_VALIDATION_STARTED').length, 1);
    } finally { f.clean(); }
});
