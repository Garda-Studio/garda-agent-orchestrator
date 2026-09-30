import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';
import { resolveCanonicalTaskPlanPath, TASK_PLAN_READ_MAX_BYTES } from '../../../../src/core/task-plan-read';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';
import { getTaskModeEvidence } from '../../../../src/gates/task-mode';
import { buildTaskPlanDiagnostics } from '../../../../src/gates/diagnostics/task-plan-diagnostics';
import { formatHandshakeDiagnosticsResult, getHandshakeEvidence, type HandshakeDiagnosticsArtifact } from '../../../../src/gates/diagnostics/handshake-diagnostics';
import { runEnterTaskModeCommand } from '../../../../src/cli/commands/gate-flows/task-mode/task-mode-flow';
import { runHandshakeDiagnosticsCommand } from '../../../../src/cli/commands/gate-flows/task-mode/task-mode-diagnostics-commands';
import { createTempRepo, initializeGitRepo } from '../../cli/commands/gate-test-repo-bootstrap';
import { seedInitAnswers, seedTaskQueue, loadTaskEntryRulePack } from '../../cli/commands/gate-test-seed-helpers';

const TASK_ID = 'T-715';
const SECRET = 'PLAN_BODY_MUST_NOT_APPEAR';

function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
}

function workspace(t: TestContext): string {
    const root = createTempRepo(t);
    write(path.join(root, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }));
    write(path.join(root, 'MANIFEST.md'), '# Source checkout\n');
    write(path.join(root, 'VERSION'), '1.4.4\n');
    write(path.join(root, DEFAULT_BUNDLE_NAME, 'MANIFEST.md'), '# Materialized bundle\n');
    write(path.join(root, DEFAULT_BUNDLE_NAME, 'VERSION'), '1.4.4\n');
    write(path.join(root, 'AGENTS.md'), '# Rules\n');
    write(path.join(root, '.agents', 'workflows', 'start-task.md'), '# Start Task\n');
    write(path.join(root, 'bin', 'garda.js'), '// fixture\n');
    write(path.join(root, '.gitignore'), `${DEFAULT_BUNDLE_NAME}/runtime/\n`);
    seedInitAnswers(root);
    seedTaskQueue(root, TASK_ID);
    initializeGitRepo(root);
    return root;
}

function plan(goal = SECRET, status = 'approved'): string {
    return serializeTaskPlan(validateTaskPlan({
        schema_version: 1, task_id: TASK_ID, status, goal, scope_files: ['src/app.ts'],
        risk_level: 'low', steps: [{ id: 'one', title: 'Implement' }],
        acceptance_criteria: ['Compact diagnostics'], verification_expectations: ['Focused tests'], out_of_scope: ['New gates']
    }));
}

function enter(root: string, planPath?: string, artifactPath?: string) {
    const result = runEnterTaskModeCommand({
        repoRoot: root, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Inspect plan diagnostics', provider: 'Codex', planPath, artifactPath, emitMetrics: false
    });
    assert.equal(result.exitCode, 0);
    assert.equal(loadTaskEntryRulePack(root, TASK_ID, artifactPath).exitCode, 0);
    return result;
}

function handshake(root: string, taskModePath?: string) {
    const result = runHandshakeDiagnosticsCommand({ repoRoot: root, taskId: TASK_ID, taskModePath, emitMetrics: false });
    const artifact = JSON.parse(fs.readFileSync(path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-handshake.json`), 'utf8')) as HandshakeDiagnosticsArtifact;
    return { ...result, artifact };
}

function planLines(lines: string[]): string[] {
    return lines.filter(line => /^(TaskPlan|ReadPlanHint:)/u.test(line));
}

test('entry and handshake share compact JSON, Markdown-only and no-plan diagnostics', t => {
    for (const state of ['attached_json', 'markdown_guidance', 'none']) {
        const root = workspace(t);
        if (state === 'attached_json') write(resolveCanonicalTaskPlanPath(root, TASK_ID), plan());
        if (state === 'markdown_guidance') write(path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'plans', `${TASK_ID}.md`), `# ${SECRET}\n`);
        const entry = enter(root);
        const result = handshake(root);
        assert.equal(result.exitCode, 0);
        assert.equal(result.artifact.schema_version, 1);
        assert.equal(result.artifact.task_plan?.state, state);
        assert.equal(result.artifact.task_plan?.editable, false);
        assert.deepEqual(planLines(result.outputLines), planLines(entry.outputLines));
        assert.equal(result.outputLines.join('\n').includes(SECRET), false);
        assert.equal(JSON.stringify(result.artifact).includes(SECRET), false);
        assert.equal(getHandshakeEvidence(root, TASK_ID).evidence_status, 'PASS');
        const legacy = { ...result.artifact };
        delete legacy.task_plan;
        assert.deepEqual(planLines(formatHandshakeDiagnosticsResult(legacy)), []);
    }
});

test('handshake preserves freeform entry when a ready plan appears after missing or draft preparation', t => {
    for (const prepared of ['missing', 'draft']) {
        const root = workspace(t);
        const canonical = resolveCanonicalTaskPlanPath(root, TASK_ID);
        if (prepared === 'draft') write(canonical, plan(SECRET, 'draft'));
        const entry = enter(root);
        assert.ok(entry.outputLines.includes(`PreparedPlan: ${prepared} (optional; freeform execution)`));
        const before = getTaskModeEvidence(root, TASK_ID);
        write(canonical, plan('Later preparation'));
        const bytes = fs.readFileSync(canonical);
        const result = handshake(root);
        assert.equal(result.exitCode, 0);
        assert.equal(result.artifact.task_plan?.state, 'none');
        assert.deepEqual(fs.readFileSync(canonical), bytes);
        assert.equal(getTaskModeEvidence(root, TASK_ID).evidence_hash, before.evidence_hash);
        assert.equal(getTaskModeEvidence(root, TASK_ID).plan, null);
    }
});

test('explicit attachment and custom entry artifact remain the source of handshake diagnostics', t => {
    const root = workspace(t);
    const canonical = resolveCanonicalTaskPlanPath(root, TASK_ID);
    write(canonical, '{invalid canonical');
    const explicit = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'explicit.json');
    const customEntry = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'custom-entry.json');
    write(explicit, plan());
    const entry = enter(root, explicit, customEntry);
    write(canonical, plan('Unattached replacement'));
    write(explicit, JSON.stringify(JSON.parse(plan()), null, 4));
    const before = fs.readFileSync(customEntry);
    const result = handshake(root, customEntry);
    assert.equal(result.exitCode, 0);
    assert.equal(result.artifact.task_plan?.state, 'attached_json');
    assert.match(result.artifact.task_plan!.path, /runtime\/explicit\.json$/u);
    assert.ok(result.artifact.task_plan!.read_before_implementation.includes(result.artifact.task_plan!.path));
    assert.deepEqual(planLines(result.outputLines), planLines(entry.outputLines));
    assert.deepEqual(fs.readFileSync(customEntry), before);
});

test('changed, missing or malformed attached JSON is observational and preserves handshake readiness', t => {
    for (const failure of ['attachment_changed', 'attachment_missing', 'attachment_invalid']) {
        const root = workspace(t);
        const canonical = resolveCanonicalTaskPlanPath(root, TASK_ID);
        write(canonical, plan());
        enter(root);
        const before = getTaskModeEvidence(root, TASK_ID);
        if (failure === 'attachment_changed') write(canonical, plan('Changed goal'));
        else if (failure === 'attachment_missing') fs.unlinkSync(canonical);
        else write(canonical, `{broken ${SECRET}`);
        const result = handshake(root);
        assert.equal(result.exitCode, 0);
        assert.equal(result.artifact.outcome, 'PASS');
        assert.deepEqual(result.artifact.violations, []);
        assert.equal(result.artifact.task_plan?.state, 'invalid');
        assert.equal(result.artifact.task_plan?.evidence, failure);
        assert.equal(result.outputLines.join('\n').includes(SECRET), false);
        assert.equal(getTaskModeEvidence(root, TASK_ID).evidence_hash, before.evidence_hash);
        assert.equal(getHandshakeEvidence(root, TASK_ID).evidence_status, 'PASS');
    }
});

test('cleared entry attachment is reported as invalid evidence through existing task-mode validation', t => {
    const root = workspace(t);
    write(resolveCanonicalTaskPlanPath(root, TASK_ID), plan());
    enter(root);
    const evidence = getTaskModeEvidence(root, TASK_ID);
    const artifact = JSON.parse(fs.readFileSync(evidence.evidence_path!, 'utf8'));
    artifact.plan = null;
    write(evidence.evidence_path!, JSON.stringify(artifact));
    assert.notEqual(getTaskModeEvidence(root, TASK_ID).evidence_status, 'PASS');
    const result = handshake(root);
    assert.equal(result.artifact.task_plan?.state, 'invalid');
    assert.equal(result.artifact.task_plan?.evidence, 'entry_invalid');
});

test('replaced Markdown guidance remains observational when an unattached JSON plan appears', t => {
    const root = workspace(t);
    const markdown = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'plans', `${TASK_ID}.md`);
    write(markdown, `# ${SECRET}\n`);
    enter(root);
    const before = getTaskModeEvidence(root, TASK_ID);
    write(resolveCanonicalTaskPlanPath(root, TASK_ID), plan('Later unattached JSON'));
    write(markdown, '# Replaced guidance\n');
    const changed = handshake(root);
    assert.equal(changed.exitCode, 0);
    assert.equal(changed.artifact.task_plan?.evidence, 'attachment_changed');
    assert.match(changed.artifact.task_plan!.path, /runtime\/plans\/T-715\.md$/u);
    fs.unlinkSync(markdown);
    const missing = handshake(root);
    assert.equal(missing.exitCode, 0);
    assert.equal(missing.artifact.task_plan?.evidence, 'attachment_missing');
    assert.equal(getTaskModeEvidence(root, TASK_ID).evidence_hash, before.evidence_hash);
    assert.equal(getTaskModeEvidence(root, TASK_ID).plan, null);
});

test('foreign JSON task identity and forged embedded digest are rejected as diagnostic evidence', t => {
    const root = workspace(t);
    const canonical = resolveCanonicalTaskPlanPath(root, TASK_ID);
    write(canonical, plan());
    enter(root);
    const entry = getTaskModeEvidence(root, TASK_ID);
    write(canonical, serializeTaskPlan(validateTaskPlan({ ...JSON.parse(plan()), task_id: 'T-716', plan_sha256: undefined })));
    assert.equal(buildTaskPlanDiagnostics(root, TASK_ID, entry).evidence, 'attachment_invalid');
    write(canonical, JSON.stringify({ ...JSON.parse(plan()), plan_sha256: '0'.repeat(64) }));
    assert.equal(buildTaskPlanDiagnostics(root, TASK_ID, entry).evidence, 'attachment_invalid');
    assert.equal(handshake(root).exitCode, 0);
});

test('attachment inspection is bounded and repository confined without printing untrusted content', t => {
    const root = workspace(t);
    const canonical = resolveCanonicalTaskPlanPath(root, TASK_ID);
    write(canonical, plan());
    enter(root);
    const entry = getTaskModeEvidence(root, TASK_ID);
    write(canonical, 'x'.repeat(TASK_PLAN_READ_MAX_BYTES + 1));
    assert.equal(buildTaskPlanDiagnostics(root, TASK_ID, entry).evidence, 'attachment_invalid');
    const outside = workspace(t);
    const file = path.join(outside, 'foreign.json');
    write(file, plan());
    const escaped = buildTaskPlanDiagnostics(root, TASK_ID, { ...entry, plan: { ...entry.plan!, plan_path: file } });
    assert.equal(escaped.state, 'invalid');
    assert.equal(escaped.path.includes('..'), false);
    assert.equal(JSON.stringify(escaped).includes(SECRET), false);
});
