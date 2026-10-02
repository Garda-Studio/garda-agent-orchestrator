import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import type { TaskContextSelection } from '../../../../src/cli/commands/preprompt/preprompt-task-context-selection';
import type { PrepromptContinuation } from '../../../../src/cli/commands/preprompt/preprompt-task-commands';
import { resolveNextStep } from '../../../../src/gates/next-step/next-step';
import { resolveCanonicalTaskPlanPath } from '../../../../src/core/task-plan-read';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';
import { runEnterTaskModeCommand } from '../../../../src/cli/commands/gate-flows/task-mode/task-mode-flow';
import { buildSharedStartTaskWorkflowContent } from '../../../../src/materialization/content-builders';
import { resolveNextStep as settleFixtureEffects } from '../../gates/next-step/next-step-test-support';
import {
    TASK_ID, ALL_REVIEW_FLAGS, makeTempRepo, reviewsRoot, seedStartedTask,
    seedRulePack, seedHandshake, seedShellSmoke, writePreflight, seedCompilePass,
    writeReviewEvidence, seedReviewGatePass, seedDocImpactPass,
    seedProjectMemory, writeProjectMemoryWorkflowConfig
} from '../../gates/next-step/next-step-completion-fixtures';
import { initializeGitRepo, seedInitAnswers } from './gate-test-helpers';

type Scenario = 'implementation' | 'test_review' | 'completion' | 'docs' | 'memory'
    | 'review_failure' | 'stale_source' | 'missing_compile' | 'plan_tampering';
type ReadSource = TaskContextSelection['controller_read_set'][number];
type ResumeBrief = {
    schema_version: number;
    continuation: PrepromptContinuation;
    context_selection: TaskContextSelection;
    commands: { startup_commands: unknown[]; post_implementation_commands: unknown[] };
};
const SOURCE_ROOT = process.cwd();
const RULE_FILES = ['00-core.md', '35-strict-coding-rules.md', '40-commands.md',
    '50-structure-and-docs.md', '70-security.md', '80-task-workflow.md', '90-skill-catalog.md'];
const SCENARIOS: Record<Scenario, TaskContextSelection['phase']> = {
    implementation: 'implementation', test_review: 'review_orchestration', completion: 'completion',
    docs: 'docs_memory_closeout', memory: 'docs_memory_closeout', review_failure: 'implementation',
    stale_source: 'implementation', missing_compile: 'implementation', plan_tampering: 'implementation'
};

function hash(value: Buffer | string): string {
    return createHash('sha256').update(value).digest('hex');
}

function snapshotInputs(repoRoot: string): Record<string, string> {
    const result: Record<string, string> = {};
    const visit = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === '.git') continue;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(file);
            else result[path.relative(repoRoot, file)] = `${fs.statSync(file).mtimeMs}:${hash(fs.readFileSync(file))}`;
        }
    };
    visit(repoRoot);
    return result;
}

function seedInstructionCorpus(repoRoot: string): void {
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    fs.copyFileSync(path.join(SOURCE_ROOT, 'AGENTS.md'), path.join(repoRoot, 'AGENTS.md'));
    for (const name of RULE_FILES) {
        fs.copyFileSync(path.join(SOURCE_ROOT, 'template/docs/agent-rules', name),
            path.join(bundleRoot, 'live/docs/agent-rules', name));
    }
    const skillRoot = path.join(bundleRoot, 'live/skills/orchestration');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.copyFileSync(path.join(SOURCE_ROOT, 'template/skills/orchestration/SKILL.md'), path.join(skillRoot, 'SKILL.md'));
    const router = path.join(repoRoot, '.agents/workflows/start-task.md');
    fs.mkdirSync(path.dirname(router), { recursive: true });
    fs.writeFileSync(router, buildSharedStartTaskWorkflowContent('AGENTS.md'));
    const queue = path.join(repoRoot, 'TASK.md');
    const content = fs.readFileSync(queue, 'utf8');
    if (!content.includes('## Active Queue')) fs.writeFileSync(queue, content.replace(/^\|/m, '## Active Queue\n\n|'));
    seedProjectMemory(repoRoot);
}

function seedAttachedPlan(repoRoot: string): string {
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'garda-agent-orchestrator/runtime/\nTASK.md\n');
    initializeGitRepo(repoRoot);
    const file = resolveCanonicalTaskPlanPath(repoRoot, TASK_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeTaskPlan(validateTaskPlan({
        schema_version: 1, task_id: TASK_ID, status: 'approved', goal: 'Preserve resume behavior',
        scope_files: ['src/app.ts'], risk_level: 'low', steps: [{ id: 'one', title: 'Preserve behavior' }],
        acceptance_criteria: ['Preserve the current navigator action'],
        verification_expectations: ['Fresh-process read-only checks'], out_of_scope: ['Other tasks']
    })));
    const entry = runEnterTaskModeCommand({ repoRoot, taskId: TASK_ID,
        entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2, taskSummary: 'Preserve resume behavior',
        provider: 'Codex', emitMetrics: false });
    assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
    seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
    seedHandshake(repoRoot, TASK_ID);
    seedShellSmoke(repoRoot, TASK_ID);
    fs.writeFileSync(path.join(repoRoot, 'src/app.ts'), 'export const value = 2;\n');
    return file;
}

function scenarioWorkspace(t: TestContext, scenario: Scenario): string {
    const repoRoot = makeTempRepo();
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    seedInitAnswers(repoRoot, 'Codex');
    seedInstructionCorpus(repoRoot);
    if (scenario === 'memory') writeProjectMemoryWorkflowConfig(repoRoot, { mode: 'check' });
    const planPath = scenario === 'plan_tampering' ? seedAttachedPlan(repoRoot) : null;
    if (!planPath) seedStartedTask(repoRoot, TASK_ID);
    writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS,
        code: scenario === 'test_review' || scenario === 'review_failure', test: scenario === 'test_review' });
    if (scenario === 'implementation') return repoRoot;
    seedCompilePass(repoRoot, TASK_ID);
    if (scenario === 'test_review') writeReviewEvidence(repoRoot, TASK_ID, 'code');
    else if (scenario === 'review_failure') writeReviewEvidence(repoRoot, TASK_ID, 'code', {
        verdict: 'fail', body: '## Findings by Severity\n- High: src/app.ts:1 fails the required contract; remediation: repair the implementation.\n\n'
    });
    else {
        seedReviewGatePass(repoRoot, TASK_ID);
        if (scenario !== 'docs') seedDocImpactPass(repoRoot, TASK_ID);
    }
    settleFixtureEffects({ repoRoot, taskId: TASK_ID });
    if (scenario === 'stale_source' || scenario === 'missing_compile' || planPath) {
        const beforeMutation = resolveNextStep({ repoRoot, taskId: TASK_ID });
        assert.equal(beforeMutation.next_gate, 'completion-gate', beforeMutation.reason);
        if (scenario === 'stale_source') fs.writeFileSync(path.join(repoRoot, 'src/app.ts'), 'export const value = 999;\n');
        if (scenario === 'missing_compile') fs.rmSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`));
        if (planPath) {
            const original = fs.readFileSync(planPath, 'utf8');
            fs.writeFileSync(planPath, original.replace('Preserve resume behavior', 'Replace the frozen scope'));
        }
    }
    return repoRoot;
}

function freshCli(repoRoot: string, json: boolean): string {
    const script = 'require(process.argv[1]).runCliMainWithHandling(process.argv.slice(2))'
        + '.then(code => { if (typeof code === "number") process.exitCode = code; })'
        + '.catch(error => { console.error(error); process.exitCode = 1; });';
    const result = childProcess.spawnSync(process.execPath, ['-e', script,
        require.resolve('../../../../src/cli/main'), 'preprompt', 'task', '--task-id', TASK_ID,
        ...(json ? ['--json'] : [])], {
        cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, GARDA_UPDATE_CHECK: '0', NO_COLOR: '1', FORCE_COLOR: undefined }
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

function selectedExcerpt(content: string, sections: string[]): string | null {
    if (sections.includes('*')) return content;
    const headings = [...content.matchAll(/^#{1,6} (.+)\r?$/gm)];
    const ranges: [number, number][] = [];
    for (const section of sections) {
        const index = headings.findIndex(match => match[1] === section);
        if (index < 0) return null;
        const heading = headings[index];
        const next = headings[index + 1];
        ranges.push([heading.index, next?.index ?? content.length]);
    }
    ranges.sort((first, second) => first[0] - second[0]);
    const merged: [number, number][] = [];
    for (const range of ranges) {
        const previous = merged[merged.length - 1];
        if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
        else merged.push(range);
    }
    return merged.map(([start, end]) => content.slice(start, end)).join('');
}

function recipeFootprint(repoRoot: string, sources: ReadSource[]): { chars: number; utf8_bytes: number; missing: string[] } {
    const grouped = new Map<string, Set<string>>();
    for (const source of sources) {
        const sections = grouped.get(source.path) || new Set<string>();
        for (const section of source.sections) sections.add(section);
        grouped.set(source.path, sections);
    }
    const excerpts: string[] = [];
    const missing: string[] = [];
    for (const [relative, sections] of grouped) {
        const file = path.resolve(repoRoot, relative);
        assert.ok(file.startsWith(`${path.resolve(repoRoot)}${path.sep}`), relative);
        const excerpt = fs.existsSync(file) ? selectedExcerpt(fs.readFileSync(file, 'utf8'), [...sections]) : null;
        if (excerpt === null) missing.push(relative);
        else excerpts.push(excerpt);
    }
    const combined = excerpts.join('');
    return { chars: combined.length, utf8_bytes: Buffer.byteLength(combined), missing };
}

function runResumeScenario(t: TestContext, scenario: Scenario): ReturnType<typeof resolveNextStep> {
    const repoRoot = scenarioWorkspace(t, scenario);
    const before = snapshotInputs(repoRoot);
    const current = resolveNextStep({ repoRoot, taskId: TASK_ID });
    const json = freshCli(repoRoot, true);
    const brief = JSON.parse(json) as ResumeBrief;
    const text = freshCli(repoRoot, false);
    const selection = brief.context_selection;
    assert.equal(brief.schema_version, 3);
    assert.equal(selection.phase, SCENARIOS[scenario], brief.continuation.reason);
    assert.equal(brief.continuation.status, current.status);
    assert.equal(brief.continuation.next_gate, current.next_gate);
    assert.equal(brief.continuation.action?.command ?? null,
        current.commands.length === 1 ? current.commands[0].command : null);
    assert.deepEqual(brief.commands.startup_commands, []);
    assert.deepEqual(brief.commands.post_implementation_commands, []);
    assert.ok(!text.includes('StartupCommands:'));
    assert.equal(selection.historical_rule_pack_is_session_knowledge, false);
    assert.deepEqual(selection.reviewer_context.repository_rule_files, []);
    assert.equal(selection.reviewer_context.fresh_isolated_context, true);
    assert.equal(selection.revalidate_before_action, true);
    for (const required of ['35-strict-coding-rules.md', '40-commands.md', '50-structure-and-docs.md', '70-security.md', '90-skill-catalog.md']) {
        assert.ok(selection.before_code_edit_read_set.some(source => source.path.endsWith(required) && source.sections.includes('*')), required);
    }
    assert.match(text, /BeforeCodeEdit:.*implementation instructions/);
    if (scenario === 'test_review') {
        assert.equal(current.review.next_review_type, 'test');
        assert.match(brief.continuation.action?.command || '', /--review-type "test"/);
        assert.ok(!text.includes('gate compile-gate'));
    }
    if (scenario === 'completion') assert.equal(current.next_gate, 'completion-gate');
    if (scenario === 'docs') assert.equal(current.next_gate, 'doc-impact-gate');
    if (scenario === 'memory') assert.equal(current.next_gate, 'project-memory-impact');
    if (scenario === 'review_failure') assert.match(current.title, /Fix failed 'code' review findings/);
    if (scenario === 'stale_source' || scenario === 'missing_compile' || scenario === 'plan_tampering') {
        assert.notEqual(current.next_gate, 'completion-gate');
    }
    assert.deepEqual(snapshotInputs(repoRoot), before);
    const full = recipeFootprint(repoRoot, selection.before_code_edit_read_set);
    const selected = recipeFootprint(repoRoot, selection.controller_read_set);
    const effective = selected.missing.length ? full : selected;
    assert.deepEqual(full.missing, []);
    t.diagnostic(`GARDA_RESUME_CONTEXT_MEASUREMENT ${JSON.stringify({
        scenario, phase: selection.phase, gate: current.next_gate, fixture_root_chars: repoRoot.length,
        emitted_json: { chars: json.length, utf8_bytes: Buffer.byteLength(json), sha256: hash(json) },
        emitted_text: { chars: text.length, utf8_bytes: Buffer.byteLength(text), sha256: hash(text) },
        implementation_recipe: full, selected_recipe: selected, effective_recipe: effective
    })}`);
    return current;
}

test('fresh-process resume: implementation', t => {
    const current = runResumeScenario(t, 'implementation');
    assert.equal(current.next_gate, 'compile-gate');
});

test('fresh-process resume: test_review', t => {
    const current = runResumeScenario(t, 'test_review');
    assert.equal(current.review.next_review_type, 'test');
});

test('fresh-process resume: completion', t => {
    const current = runResumeScenario(t, 'completion');
    assert.equal(current.next_gate, 'completion-gate');
});

test('fresh-process resume: docs', t => {
    const current = runResumeScenario(t, 'docs');
    assert.equal(current.next_gate, 'doc-impact-gate');
});

test('fresh-process resume: memory', t => {
    const current = runResumeScenario(t, 'memory');
    assert.equal(current.next_gate, 'project-memory-impact');
});

test('fresh-process resume: review_failure', t => {
    const current = runResumeScenario(t, 'review_failure');
    assert.match(current.title, /Fix failed 'code' review findings/);
});

test('fresh-process resume: stale_source', t => {
    const current = runResumeScenario(t, 'stale_source');
    assert.notEqual(current.next_gate, 'completion-gate');
});

test('fresh-process resume: missing_compile', t => {
    const current = runResumeScenario(t, 'missing_compile');
    assert.notEqual(current.next_gate, 'completion-gate');
});

test('fresh-process resume: plan_tampering', t => {
    const current = runResumeScenario(t, 'plan_tampering');
    assert.notEqual(current.next_gate, 'completion-gate');
});
