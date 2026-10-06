import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';
import { resolveCanonicalTaskPlanPath } from '../../../../src/core/task-plan-read';
import { saveTaskPlan } from '../../../../src/core/task-plan-save';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';
import { getTaskModeEvidence } from '../../../../src/gates/task-mode';
import { runEnterTaskModeCommand } from '../../../../src/cli/commands/gate-flows/task-mode/task-mode-flow';
import { runCompileGateCommand } from '../../../../src/cli/commands/gate-flows/compile/compile-flow';
import {
    initializeGitRepo, seedInitAnswers, seedTaskQueue, loadTaskEntryRulePack,
    loadPostPreflightRulePack, runHandshakeForTask, runShellSmokeForTask, runExplicitPreflight
} from '../../cli/commands/gate-test-seed-helpers';

const TASK_ID = 'T-704';
const SUMMARY = 'Implement the widget';

function workspace(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-canonical-plan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Rules\n');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'widget.ts'), 'export const widget = true;\n');
    const rulesRoot = path.join(root, DEFAULT_BUNDLE_NAME, 'live', 'docs', 'agent-rules');
    fs.mkdirSync(rulesRoot, { recursive: true });
    for (const name of ['00-core.md', '15-project-memory.md', '30-code-style.md', '35-strict-coding-rules.md',
        '40-commands.md', '50-structure-and-docs.md', '70-security.md', '80-task-workflow.md', '90-skill-catalog.md']) {
        fs.writeFileSync(path.join(rulesRoot, name), `# ${name}\n`);
    }
    const configRoot = path.join(root, DEFAULT_BUNDLE_NAME, 'live', 'config');
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'workflow-config.json'), JSON.stringify({
        compile_gate: { command: 'node --version' }, project_memory_maintenance: { enabled: false }
    }));
    seedInitAnswers(root);
    seedTaskQueue(root, TASK_ID);
    fs.writeFileSync(path.join(root, '.gitignore'), `${DEFAULT_BUNDLE_NAME}/runtime/\n`);
    initializeGitRepo(root);
    return root;
}

function plan(overrides: Record<string, unknown> = {}): string {
    return serializeTaskPlan(validateTaskPlan({
        schema_version: 1, task_id: TASK_ID, status: 'approved', goal: SUMMARY,
        scope_files: ['src/widget.ts'], risk_level: 'low', steps: [{ id: 'one', title: 'Implement' }],
        acceptance_criteria: ['Preserve behavior'], verification_expectations: ['Focused tests'],
        out_of_scope: ['Other modules'], ...overrides
    }));
}

function writePlan(root: string, content: string): string {
    const file = resolveCanonicalTaskPlanPath(root, TASK_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function enter(root: string, planPath?: string) {
    return runEnterTaskModeCommand({
        repoRoot: root, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2, taskSummary: SUMMARY, provider: 'Codex', planPath, emitMetrics: false
    });
}

test('ordinary entry attaches the saved canonical plan and preserves its digest on re-entry', t => {
    const root = workspace(t);
    const inputPath = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'input.json');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, plan());
    const saved = saveTaskPlan(root, TASK_ID, inputPath);
    const result = enter(root);
    assert.equal(result.exitCode, 0);
    assert.ok(result.outputLines.includes('PreparedPlan: attached (canonical)'));
    const before = getTaskModeEvidence(root, TASK_ID).plan;
    assert.equal(before?.plan_path, saved.replace(/\\/g, '/'));
    assert.equal(before?.plan_sha256, JSON.parse(fs.readFileSync(saved, 'utf8')).plan_sha256);
    assert.equal(enter(root).exitCode, 0);
    assert.deepEqual(getTaskModeEvidence(root, TASK_ID).plan, before);
    assert.throws(() => saveTaskPlan(root, TASK_ID, inputPath), /existing TODO|start evidence/);
});

test('explicit plan path takes precedence over an invalid canonical plan and remains frozen', t => {
    const root = workspace(t);
    writePlan(root, '{broken');
    const explicit = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'explicit.json');
    fs.writeFileSync(explicit, plan({ goal: 'Explicit preparation' }));
    const result = enter(root, explicit);
    assert.equal(result.exitCode, 0);
    assert.ok(result.outputLines.includes('PreparedPlan: attached (explicit)'));
    const original = getTaskModeEvidence(root, TASK_ID).plan;
    assert.equal(original?.plan_summary, 'Explicit preparation');
    assert.equal(enter(root).exitCode, 0);
    const other = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'other.json');
    fs.writeFileSync(other, plan());
    assert.throws(() => enter(root, other), /attached plan path cannot change/);
    assert.deepEqual(getTaskModeEvidence(root, TASK_ID).plan, original);
});

test('missing and draft canonical plans keep ordinary execution and optional Markdown guidance', t => {
    for (const state of ['missing', 'draft']) {
        const root = workspace(t);
        if (state === 'draft') writePlan(root, plan({ status: 'draft' }));
        const markdown = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'plans', `${TASK_ID}.md`);
        fs.mkdirSync(path.dirname(markdown), { recursive: true });
        fs.writeFileSync(markdown, '# Optional guidance\n');
        const result = enter(root);
        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.includes(`PreparedPlan: ${state} (optional; freeform execution)`));
        const evidence = getTaskModeEvidence(root, TASK_ID);
        assert.equal(evidence.plan, null);
        assert.ok(evidence.markdown_working_plan);
    }
});

test('invalid canonical plans fail before entry evidence is written', t => {
    for (const content of ['{broken', plan({ task_id: 'T-999' }), plan({ status: 'superseded' }),
        JSON.stringify({ ...JSON.parse(plan()), plan_sha256: '0'.repeat(64) })]) {
        const root = workspace(t);
        writePlan(root, content);
        assert.throws(() => enter(root), /Canonical prepared plan is invalid/);
        assert.equal(fs.existsSync(path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-task-mode.json`)), false);
        assert.equal(fs.existsSync(path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'task-events', `${TASK_ID}.jsonl`)), false);
    }
});

test('canonical discovery rejects shared files and links escaping the repository', t => {
    const root = workspace(t);
    const canonical = writePlan(root, plan());
    const alias = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'alias.json');
    fs.linkSync(canonical, alias);
    assert.throws(() => enter(root), /unshared regular file/);
    fs.unlinkSync(alias);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-external-plan-'));
    t.after(() => fs.rmSync(external, { recursive: true, force: true }));
    fs.writeFileSync(path.join(external, `${TASK_ID}-task-plan.json`), plan());
    fs.unlinkSync(canonical);
    fs.rmdirSync(path.dirname(canonical));
    fs.symlinkSync(external, path.dirname(canonical), 'junction');
    assert.throws(() => enter(root), /inside repo|outside.*root|link/i);
});

test('re-entry cannot adopt a later plan for a task that started freeform', t => {
    const root = workspace(t);
    assert.equal(enter(root).exitCode, 0);
    const later = writePlan(root, plan());
    assert.equal(enter(root).exitCode, 0);
    assert.equal(getTaskModeEvidence(root, TASK_ID).plan, null);
    assert.throws(() => enter(root, later), /freeform task entry cannot attach/);
});

test('re-entry rejects plan tampering without replacing the original attachment', t => {
    const root = workspace(t);
    const canonical = writePlan(root, plan());
    assert.equal(enter(root).exitCode, 0);
    const original = getTaskModeEvidence(root, TASK_ID).plan;
    fs.writeFileSync(canonical, plan({ goal: 'Changed after start' }));
    assert.throws(() => enter(root), /Plan integrity mismatch/);
    assert.deepEqual(getTaskModeEvidence(root, TASK_ID).plan, original);
});

test('re-entry rejects cleared, malformed or replaced attachment metadata against its entry event', t => {
    const rejectedStates: string[] = [];
    for (const mutation of ['cleared', 'malformed', 'digest', 'path']) {
        const root = workspace(t);
        const canonical = writePlan(root, plan());
        assert.equal(enter(root).exitCode, 0);
        const artifact = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-task-mode.json`);
        const before = JSON.parse(fs.readFileSync(artifact, 'utf8'));
        if (mutation === 'cleared') before.plan = null;
        if (mutation === 'malformed') before.plan = { plan_path: canonical };
        if (mutation === 'digest') {
            const replacement = plan({ goal: 'Forged baseline' });
            fs.writeFileSync(canonical, replacement);
            before.plan.plan_sha256 = JSON.parse(replacement).plan_sha256;
        }
        if (mutation === 'path') {
            const other = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'other.json');
            fs.writeFileSync(other, plan());
            before.plan.plan_path = other.replace(/\\/g, '/');
        }
        const forged = JSON.stringify(before);
        fs.writeFileSync(artifact, forged);
        assert.throws(() => enter(root), /plan attachment/);
        assert.equal(fs.readFileSync(artifact, 'utf8'), forged, 'failed entry must not renew forged metadata');
        rejectedStates.push(getTaskModeEvidence(root, TASK_ID).evidence_status);
    }
    assert.deepEqual(rejectedStates, [
        'EVIDENCE_PLAN_BINDING_MISMATCH', 'EVIDENCE_PLAN_METADATA_INVALID',
        'EVIDENCE_PLAN_BINDING_MISMATCH', 'EVIDENCE_PLAN_BINDING_MISMATCH'
    ]);
});

test('task-mode evidence rejects a forged plan on an originally freeform entry', t => {
    const root = workspace(t);
    assert.equal(enter(root).exitCode, 0);
    const canonical = writePlan(root, plan());
    const artifact = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-task-mode.json`);
    const forged = JSON.parse(fs.readFileSync(artifact, 'utf8'));
    forged.plan = { plan_path: canonical.replace(/\\/g, '/'), plan_sha256: JSON.parse(plan()).plan_sha256, plan_summary: SUMMARY };
    fs.writeFileSync(artifact, JSON.stringify(forged));
    assert.equal(getTaskModeEvidence(root, TASK_ID).evidence_status, 'EVIDENCE_PLAN_BINDING_MISMATCH');
    assert.throws(() => enter(root), /plan attachment/);
});

test('compile validates an automatically attached plan and rejects subsequent content tampering', async t => {
    const root = workspace(t);
    const canonical = writePlan(root, plan());
    assert.equal(enter(root).exitCode, 0);
    assert.equal(loadTaskEntryRulePack(root, TASK_ID).exitCode, 0);
    runHandshakeForTask(root, TASK_ID);
    runShellSmokeForTask(root, TASK_ID);
    const preflightPath = runExplicitPreflight(root, TASK_ID, SUMMARY, ['src/widget.ts']);
    assert.equal(loadPostPreflightRulePack(root, TASK_ID, preflightPath, false).exitCode, 0);
    const valid = await runCompileGateCommand({ repoRoot: root, taskId: TASK_ID, preflightPath, emitMetrics: false });
    assert.equal(valid.exitCode, 0, valid.outputLines.join('\n'));
    fs.writeFileSync(canonical, plan({ goal: 'Tampered but self-consistent digest' }));
    const invalid = await runCompileGateCommand({ repoRoot: root, taskId: TASK_ID, preflightPath, emitMetrics: false });
    assert.notEqual(invalid.exitCode, 0);
    assert.ok(invalid.outputLines.some(line => line.includes('Plan integrity mismatch')), invalid.outputLines.join('\n'));
    const artifact = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-task-mode.json`);
    const forged = JSON.parse(fs.readFileSync(artifact, 'utf8'));
    forged.plan.plan_sha256 = JSON.parse(fs.readFileSync(canonical, 'utf8')).plan_sha256;
    fs.writeFileSync(artifact, JSON.stringify(forged));
    const forgedResult = await runCompileGateCommand({ repoRoot: root, taskId: TASK_ID, preflightPath, emitMetrics: false });
    assert.notEqual(forgedResult.exitCode, 0);
    assert.ok(forgedResult.outputLines.some(line => line.includes('plan attachment')), forgedResult.outputLines.join('\n'));
});
