import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { runClassifyChangeCommand } from '../../../../src/cli/commands/gates';
import { executeValidationRecipe } from '../../../../src/gates/project-validation/execution';
import { evaluateValidationAttempt } from '../../../../src/gates/project-validation/result-evaluation';
import { recordValidationEvent } from '../../../../src/gates/project-validation/attempt-evidence';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode, runHandshakeForTask, runShellSmokeForTask,
    seedInitAnswers, seedTaskQueue } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';

const taskId = 'T-1';
function fixture(mode = 'passed') {
    const root = createTempRepo(), bundle = path.join(root, 'garda-agent-orchestrator');
    const config = path.join(bundle, 'live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, JSON.stringify(buildDefaultWorkflowConfig()));
    fs.mkdirSync(path.join(root, 'specifications')); fs.writeFileSync(path.join(root, 'specifications/case'), 'declared test');
    fs.writeFileSync(path.join(root, 'driver'), 'process.stdout.write(process.argv[2]==="opaque"?"unknown success":"TAP version 13\\n"+(process.argv[2]==="failed"?"not ok":"ok")+" 1 - declared case\\n1..1\\n");process.exitCode=process.argv[2]==="failed"?7:0;');
    fs.writeFileSync(path.join(root, 'recipes.json'), JSON.stringify({ schema_version: 1, recipes: [{ id: 'recipe', purpose: 'test',
        executable: process.execPath, argv: ['driver', mode, { target: 'case' }], cwd: '.',
        inputs: [{ path: 'src/app.ts', role: 'source' }, { path: 'specifications/case', role: 'test' }, { path: 'driver', role: 'helper' }],
        targets: [{ id: 'case', source: 'specifications/case', selector: 'declared case' }], environment: {}, timeout_ms: 5000,
        max_attempts: 1, max_output_bytes: 1024, max_input_bytes: 65536, required_capabilities: [], result_format: mode === 'opaque' ? 'opaque' : 'tap' }] }));
    seedInitAnswers(root); seedTaskQueue(root, taskId, 'TODO', 'default', 'Required reviews: code, security, test.', 'Read current results'); initializeGitRepo(root);
    handleWorkflow(['set', '--target-root', root, '--project-validation-contract', 'recipes.json', '--operator-confirmed', 'yes',
        '--operator-confirmed-at-utc', new Date().toISOString()], { name: 'garda-agent-orchestrator', version: '1.0.0' });
    runEnterTaskMode({ repoRoot: root, taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2, taskSummary: 'Read current results', provider: 'Codex' });
    loadTaskEntryRulePack(root, taskId); runHandshakeForTask(root, taskId); runShellSmokeForTask(root, taskId);
    fs.appendFileSync(path.join(root, 'src/app.ts'), '\nexport const value = 1;\n');
    const preflight = path.join(bundle, `runtime/reviews/${taskId}-preflight.json`);
    const classify = () => runClassifyChangeCommand({ repoRoot: root, taskId, taskIntent: 'Read current results', outputPath: preflight,
        changedFiles: ['src/app.ts'], emitMetrics: false }); classify();
    return { root, bundle, preflight, classify, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function reader() {
    return require('../../../../src/gates/project-validation/evidence') as {
        readValidationResult: (options: { repoRoot: string; taskId: string; attemptId: string }) => {
            result: { status: string; result_path: string; result_sha256: string }; snapshot: { recipe: { targets: Array<{ source: string }> } };
        };
    };
}
async function evaluated(root: string) {
    const attempt = await executeValidationRecipe({ repoRoot: root, taskId, recipeId: 'recipe' });
    const result = await evaluateValidationAttempt({ repoRoot: root, taskId, attemptId: attempt.attempt_id });
    return { attempt, result };
}
it('reads current canonical results for a declared extensionless test without publishing or changing producer facts', async () => {
    const f = fixture();
    try {
        const { attempt, result } = await evaluated(f.root), timeline = path.join(f.bundle, `runtime/task-events/${taskId}.jsonl`);
        const before = fs.readFileSync(timeline), original = fs.readFileSync(path.join(f.root, attempt.output_path));
        const read = reader().readValidationResult({ repoRoot: f.root, taskId, attemptId: attempt.attempt_id });
        assert.equal(read.result.status, 'PASSED'); assert.equal(read.result.result_sha256, result.result_sha256);
        assert.deepEqual(read.snapshot.recipe.targets.map(target => target.source), ['specifications/case']);
        assert.deepEqual(fs.readFileSync(timeline), before); assert.deepEqual(fs.readFileSync(path.join(f.root, attempt.output_path)), original);
        assert.equal(attempt.cases, null); assert.equal(attempt.expected_failure, false);
    } finally { f.clean(); }
});
it('retains actual failed and unresolved producer outcomes instead of interpreting them as focused PASS', async () => {
    const failed = fixture('failed'), opaque = fixture('opaque');
    try {
        const first = await evaluated(failed.root), second = await evaluated(opaque.root);
        assert.equal(reader().readValidationResult({ repoRoot: failed.root, taskId, attemptId: first.attempt.attempt_id }).result.status, 'FAILED');
        assert.equal(reader().readValidationResult({ repoRoot: opaque.root, taskId, attemptId: second.attempt.attempt_id }).result.status, 'UNRESOLVED');
    } finally { failed.clean(); opaque.clean(); }
});
it('rejects altered result output and source archives against canonical hashes', async () => {
    const f = fixture();
    try {
        const { attempt, result } = await evaluated(f.root);
        const resultFile = path.join(f.root, result.result_path), originalResult = fs.readFileSync(resultFile); fs.appendFileSync(resultFile, ' ');
        assert.throws(() => reader().readValidationResult({ repoRoot: f.root, taskId, attemptId: attempt.attempt_id }), /digest|binding|changed/u);
        fs.writeFileSync(resultFile, originalResult);
        for (const relative of [attempt.output_path, attempt.source_archive_path]) {
            const file = path.join(f.root, relative), before = fs.readFileSync(file); fs.appendFileSync(file, ' ');
            assert.throws(() => reader().readValidationResult({ repoRoot: f.root, taskId, attemptId: attempt.attempt_id }), /digest|binding|changed/u);
            fs.writeFileSync(file, before);
        }
    } finally { f.clean(); }
});
it('rejects missing or ambiguous native results without accepting a convenient historical event', async () => {
    const f = fixture();
    try {
        const attempt = await executeValidationRecipe({ repoRoot: f.root, taskId, recipeId: 'recipe' });
        assert.throws(() => reader().readValidationResult({ repoRoot: f.root, taskId, attemptId: attempt.attempt_id }), /result/u);
        const result = await evaluateValidationAttempt({ repoRoot: f.root, taskId, attemptId: attempt.attempt_id });
        await recordValidationEvent(f.root, taskId, 'PROJECT_VALIDATION_RESULTS_EVALUATED', { attempt_id: attempt.attempt_id,
            recipe_id: 'recipe', attempt_sha256: result.attempt_sha256, artifact_path: result.result_path, artifact_sha256: result.result_sha256, status: result.status });
        assert.throws(() => reader().readValidationResult({ repoRoot: f.root, taskId, attemptId: attempt.attempt_id }), /ambiguous/u);
    } finally { f.clean(); }
});
it('rejects changed approved helpers and source scope after result publication', async () => {
    const f = fixture();
    try {
        const { attempt } = await evaluated(f.root), options = { repoRoot: f.root, taskId, attemptId: attempt.attempt_id };
        const helper = path.join(f.root, 'driver'), before = fs.readFileSync(helper); fs.appendFileSync(helper, '\n');
        assert.throws(() => reader().readValidationResult(options), /dependency|identity/u); fs.writeFileSync(helper, before);
        fs.appendFileSync(path.join(f.root, 'src/app.ts'), '\nexport const later = 2;\n');
        assert.throws(() => reader().readValidationResult(options), /scope/u); f.classify();
        assert.throws(() => reader().readValidationResult(options), /stale|snapshot|binding/u);
    } finally { f.clean(); }
});
