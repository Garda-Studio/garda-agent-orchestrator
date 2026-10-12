import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { runClassifyChangeCommand } from '../../../../src/cli/commands/gates';
import { executeValidationRecipe } from '../../../../src/gates/project-validation/execution';
import { evaluateValidationAttempt } from '../../../../src/gates/project-validation/result-evaluation';
import { inspectReviewerFocusedValidationCommand, validateReviewFindingsReport, REVIEW_FINDINGS_SCHEMA_VERSION } from '../../../../src/gates/review/review-findings-schema';
import { readTaskOwnedFocusedIntermediateEvidence } from '../../../../src/gates/review/focused-intermediate-evidence';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode, runHandshakeForTask, runShellSmokeForTask,
    seedInitAnswers, seedTaskQueue } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';

const taskId = 'T-1';
async function fixture(mode = 'passed', maxAttempts = 1, options: { selector?: string; unrelatedRecipe?: boolean; variableExecutable?: boolean; executableDirectory?: string; executableName?: string; argv?: (string | { target: string })[]; cwd?: string; environment?: Record<string, string> } = {}) {
    const root = createTempRepo(), bundle = path.join(root, 'garda-agent-orchestrator');
    const config = path.join(bundle, 'live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, JSON.stringify(buildDefaultWorkflowConfig()));
    fs.mkdirSync(path.join(root, 'specifications')); fs.writeFileSync(path.join(root, 'specifications/case'), 'declared test');
    const cwd = options.cwd ?? '.', driver = cwd === '.' ? 'driver' : `${cwd}/driver`;
    fs.mkdirSync(path.dirname(path.join(root, driver)), { recursive: true });
    fs.writeFileSync(path.join(root, driver), 'process.stdout.write(process.argv[2]==="opaque"?"unknown success":"TAP version 13\\n"+(process.argv[2]==="failed"?"not ok":"ok")+" 1 - declared case\\n1..1\\n");process.exitCode=process.argv[2]==="failed"?7:0;');
    const selector = options.selector ?? 'declared case';
    const directory = options.variableExecutable ? '$HOME' : options.executableDirectory;
    const executable = directory ? path.join(root, 'tools', directory, options.executableName ?? path.basename(process.execPath)) : process.execPath;
    if (directory) {
        fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.copyFileSync(process.execPath, executable);
        fs.appendFileSync(path.join(root, '.gitignore'), '\ntools/\n');
    }
    fs.writeFileSync(path.join(root, 'other-driver'), 'unrelated helper');
    const recipe = { id: 'recipe', purpose: 'test',
        executable, argv: options.argv ?? ['driver', mode, { target: 'case' }], cwd,
        inputs: [{ path: 'src/app.ts', role: 'source' }, { path: 'specifications/case', role: 'test' }, { path: driver, role: 'helper' }],
        targets: [{ id: 'case', source: 'specifications/case', selector }], environment: options.environment ?? {}, timeout_ms: 5000,
        max_attempts: maxAttempts, max_output_bytes: 1024, max_input_bytes: 65536, required_capabilities: [], result_format: mode === 'opaque' ? 'opaque' : 'tap' };
    const unrelated = { ...recipe, id: 'other', argv: ['other-driver', mode, { target: 'case' }],
        inputs: [...recipe.inputs.filter(input => input.role !== 'helper'), { path: 'other-driver', role: 'helper' }] };
    fs.writeFileSync(path.join(root, 'recipes.json'), JSON.stringify({ schema_version: 1, recipes: options.unrelatedRecipe ? [recipe, unrelated] : [recipe] }));
    seedInitAnswers(root); seedTaskQueue(root, taskId, 'TODO', 'default', 'Required reviews: code, security, test.', 'Focused recipe evidence'); initializeGitRepo(root);
    handleWorkflow(['set', '--target-root', root, '--project-validation-contract', 'recipes.json', '--operator-confirmed', 'yes',
        '--operator-confirmed-at-utc', new Date().toISOString()], { name: 'garda-agent-orchestrator', version: '1.0.0' });
    runEnterTaskMode({ repoRoot: root, taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2, taskSummary: 'Focused recipe evidence', provider: 'Codex' });
    loadTaskEntryRulePack(root, taskId); runHandshakeForTask(root, taskId); runShellSmokeForTask(root, taskId);
    fs.appendFileSync(path.join(root, 'src/app.ts'), '\nexport const value = 1;\n');
    fs.appendFileSync(path.join(root, 'specifications/case'), '\naffected declared case\n');
    runClassifyChangeCommand({ repoRoot: root, taskId, taskIntent: 'Focused recipe evidence',
        outputPath: path.join(bundle, `runtime/reviews/${taskId}-preflight.json`), changedFiles: ['src/app.ts', 'specifications/case'], emitMetrics: false });
    const attempt = await executeValidationRecipe({ repoRoot: root, taskId, recipeId: 'recipe' });
    const result = await evaluateValidationAttempt({ repoRoot: root, taskId, attemptId: attempt.attempt_id });
    const command = [attempt.snapshot.tool.path, ...recipe.argv.map(argument => typeof argument === 'string' ? argument : selector)].map(token => JSON.stringify(token)).join(' ');
    const selected = () => readTaskOwnedFocusedIntermediateEvidence({ repoRoot: root, reviewsRoot: path.join(bundle, 'runtime/reviews'),
        eventsRoot: path.join(bundle, 'runtime/task-events'), taskId, changedFiles: ['specifications/case'],
        expectedPreflightSha256: attempt.snapshot.preflight_sha256 });
    const inspect = inspectReviewerFocusedValidationCommand as (command: string, root?: string, task?: string) => ReturnType<typeof inspectReviewerFocusedValidationCommand>;
    return { root, bundle, attempt, result, command, selected, inspect: (value = command) => inspect(value, root, taskId), clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
it('admits exact current recipes using declared test roles rather than extensions or the first source input', async () => {
    const f = await fixture();
    try {
        assert.deepEqual(f.inspect(), { syntax_supported: true, target: 'specifications/case', violations: [] });
        const entries = f.selected().entries;
        assert.equal(entries.length, 1); assert.deepEqual(entries[0].focused_test_paths, ['specifications/case']);
        assert.equal(entries[0].artifact_sha256, f.result.result_sha256); assert.equal(entries[0].command_source, 'project-recipe');
        assert.equal(entries[0].output_artifact_sha256, f.attempt.output_sha256);
    } finally { f.clean(); }
});
it('rejects modified argv foreign tasks and changed helper bytes for declared recipe commands', async () => {
    const f = await fixture();
    try {
        assert.equal(f.inspect(f.command.replace('declared case', 'other case')).syntax_supported, false);
        assert.equal(inspectReviewerFocusedValidationCommand(f.command, f.root).syntax_supported, false);
        fs.appendFileSync(path.join(f.root, 'driver'), '\n');
        assert.equal(f.inspect().syntax_supported, false); assert.equal(f.selected().entries.length, 0);
    } finally { f.clean(); }
});
it('never emits focused PASS from failed unresolved or altered retained recipe results', async () => {
    const failed = await fixture('failed'), opaque = await fixture('opaque'), altered = await fixture();
    try {
        fs.appendFileSync(path.join(altered.root, altered.result.result_path), ' ');
        assert.equal(failed.selected().entries.length, 0);
        assert.equal(opaque.selected().entries.length, 0);
        assert.equal(altered.selected().entries.length, 0);
    } finally { failed.clean(); opaque.clean(); altered.clean(); }
});
it('rejects malformed recipe review notes and admits only current authenticated PASSED results', async () => {
    const passed = await fixture(), opaque = await fixture('opaque');
    const note = (f: typeof passed, marker = false) => validateReviewFindingsReport({ schema_version: REVIEW_FINDINGS_SCHEMA_VERSION, task_id: taskId, review_type: 'code',
        review_context_sha256: 'a'.repeat(64), tree_state_sha256: 'b'.repeat(64),
        validation_notes: [{ id: 'N-001', topic: 'focused-self-validation', note: 'Inspected the current declared recipe result.',
            command: f.command, command_outcome: marker ? 'unavailable' : 'passed', diagnostics: 'The declared case passed in the current native recipe result.',
            finding_ids: marker ? ['F-000'] : [],
            evidence: [{ location: 'src/app.ts:1', observation: 'T-1 changed src/app.ts is validated by specifications/case declared test.' }] }],
        coverage_ledger: { coverage_contract_sha256: 'c'.repeat(64), entries: [{ obligation_id: 'FILE-001', finding_ids: [],
            evidence: [{ location: 'src/app.ts:1', observation: 'Inspected the current changed source and declared test relationship.' }] }] },
        review_execution: { mode: 'FULL', contract_sha256: 'd'.repeat(64), covered_delta_targets: [], inspected_prior_finding_ids: [] },
        findings: { critical: [], high: [], medium: [], low: marker ? [{ id: 'F-000',
            title: '[garda:evidence-only:missing-focused-validation] target=specifications/case; action=run-and-record-focused-validation',
            description: 'Focused command unavailable.', coverage_obligation_ids: ['FILE-001'],
            evidence: [{ location: 'src/app.ts:1', observation: 'specifications/case validates T-1 changed source.' }] }] : [] },
        residual_risks: [], reviewer_notes: ['Schema regression fixture only.']
    }, { expectedTaskId: taskId, expectedReviewType: 'code', expectedCoverageObligationIds: ['FILE-001'],
        repoRoot: f.root, allowStructuralOnlyReviewExecution: true });
    try {
        assert.equal(note(passed).valid, true, note(passed).violations.join('\n'));
        assert.equal(note(opaque).valid, false);
        assert.ok(note(opaque).violations.some(violation => violation.includes('authenticated PASSED')));
        const malformed = { ...passed, command: 'node "unterminated' };
        assert.doesNotThrow(() => note(malformed)); assert.equal(note(malformed).valid, false);
        assert.doesNotThrow(() => note(malformed, true)); assert.equal(note(malformed, true).valid, false);
    } finally { passed.clean(); opaque.clean(); }
});
it('rejects unsafe original shell syntax for exact declared recipe arguments', async () => {
    const f = await fixture('passed', 1, { selector: 'case;echo' });
    try {
        assert.equal(f.inspect().syntax_supported, true);
        assert.equal(f.inspect(f.command.replace('"case;echo"', 'case;echo')).syntax_supported, false);
        assert.equal(f.inspect(f.command.replace('"case;echo"', "'case;echo'")).syntax_supported, false);
    } finally { f.clean(); }
});
it('rejects unrelated helper failures without rejecting the valid selected recipe', async () => {
    const f = await fixture('passed', 1, { unrelatedRecipe: true });
    try {
        fs.appendFileSync(path.join(f.root, 'other-driver'), '\nchanged');
        assert.equal(f.inspect().syntax_supported, true); assert.equal(f.selected().entries.length, 1);
    } finally { f.clean(); }
});
it('rejects shell variable expansion in an otherwise authenticated executable path', async () => {
    const f = await fixture('passed', 1, { variableExecutable: true });
    try {
        assert.equal(f.result.status, 'PASSED');
        assert.equal(f.inspect().syntax_supported, false);
    } finally { f.clean(); }
});
it('rejects unquoted shell syntax in authenticated executable directories', async () => {
    const caret = await fixture('passed', 1, { executableDirectory: 'tools^suffix' });
    const bracket = await fixture('passed', 1, { executableDirectory: 'tools[ab]' });
    const unquoted = (f: typeof caret) => f.command.replace(/^"(?:\\.|[^"])*"/u, f.attempt.snapshot.tool.path);
    try {
        assert.equal(caret.result.status, 'PASSED'); assert.equal(bracket.result.status, 'PASSED');
        assert.equal(caret.inspect().syntax_supported, true); assert.equal(bracket.inspect().syntax_supported, true);
        assert.equal(caret.inspect(unquoted(caret)).syntax_supported, false);
        assert.equal(bracket.inspect(unquoted(bracket)).syntax_supported, false);
    } finally { caret.clean(); bracket.clean(); }
});
it('rejects executable aliases and quoted service recipe subcommands', async () => {
    const f = await fixture('passed', 1, { executableDirectory: 'windows-alias', executableName: 'git.exe',
        argv: ['clone', 'https://example.invalid/source', { target: 'case' }] });
    const service = await fixture('passed', 1, { executableDirectory: 'service-alias', executableName: 'docker.exe',
        argv: ['compose', 'up', { target: 'case' }] });
    try {
        assert.notEqual(f.result.status, 'PASSED'); assert.notEqual(service.result.status, 'PASSED');
        assert.equal(f.inspect().syntax_supported, false);
        assert.equal(service.inspect().syntax_supported, false);
    } finally { f.clean(); service.clean(); }
});
it('rejects context-free commands while retaining authenticated recipe results with cwd and environment', async () => {
    const cwd = await fixture('passed', 1, { cwd: 'packages/app' });
    const environment = await fixture('passed', 1, { environment: { FOCUSED_CASE: 'declared' } });
    try {
        assert.equal(cwd.result.status, 'PASSED'); assert.equal(environment.result.status, 'PASSED');
        assert.equal(cwd.inspect().syntax_supported, false); assert.equal(environment.inspect().syntax_supported, false);
        const cwdEntry = cwd.selected().entries[0], envEntry = environment.selected().entries[0];
        assert.ok('recipe_context' in cwdEntry); assert.ok('recipe_context' in envEntry);
        assert.deepEqual(JSON.parse(JSON.stringify(cwdEntry.recipe_context)), { cwd: 'packages/app', environment: {} });
        assert.deepEqual(JSON.parse(JSON.stringify(envEntry.recipe_context)), { cwd: '.', environment: { FOCUSED_CASE: 'declared' } });
    } finally { cwd.clean(); environment.clean(); }
});
it('rejects a previous PASS after a later native attempt completed without an evaluated result', async () => {
    const f = await fixture('passed', 2);
    try {
        const controller = new AbortController(); controller.abort();
        const canceled = await executeValidationRecipe({ repoRoot: f.root, taskId, recipeId: 'recipe', signal: controller.signal });
        assert.equal(canceled.cancelled, true);
        assert.equal(f.selected().entries.length, 0);
    } finally { f.clean(); }
});
