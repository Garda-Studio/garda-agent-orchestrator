import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveCanonicalTaskPlanPath, TASK_PLAN_READ_MAX_BYTES } from '../../../../src/core/task-plan-read';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';
import { runEnterTaskModeCommand } from '../../../../src/cli/commands/gate-flows/task-mode/task-mode-flow';
import { resolveNextStep } from '../../../../src/gates/next-step/next-step';
import { readAttachedTaskPlanIntegrityFailure } from '../../../../src/gates/next-step/next-step-startup-readiness';
import { initializeGitRepo, seedInitAnswers } from '../../cli/commands/gate-test-helpers';
import { resolveNextStep as settleFixtureEffects } from './next-step-test-support';
import {
    TASK_ID, ALL_REVIEW_FLAGS, makeTempRepo, reviewsRoot, seedStartedTask, seedRulePack,
    seedHandshake, seedShellSmoke, writePreflight, seedCompilePass, seedReviewGatePass, seedDocImpactPass
} from './next-step-completion-fixtures';

function attachPlan(repoRoot: string): string {
    const file = resolveCanonicalTaskPlanPath(repoRoot, TASK_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeTaskPlan(validateTaskPlan({
        schema_version: 1, task_id: TASK_ID, status: 'approved', goal: 'Preserve resume behavior',
        scope_files: ['src/app.ts'], risk_level: 'low', steps: [{ id: 'one', title: 'Preserve behavior' }],
        acceptance_criteria: ['Preserve the current navigator action'],
        verification_expectations: ['Focused currentness regressions'], out_of_scope: ['Other tasks']
    })));
    const entry = runEnterTaskModeCommand({ repoRoot, taskId: TASK_ID,
        entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Preserve resume behavior', provider: 'Codex', emitMetrics: false });
    assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
    const mode = JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), 'utf8'));
    assert.equal(mode.plan.plan_path, file.replace(/\\/g, '/'));
    seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
    seedHandshake(repoRoot, TASK_ID);
    seedShellSmoke(repoRoot, TASK_ID);
    return file;
}

function workspace(t: TestContext, attached = true): { repoRoot: string; planFile: string } {
    const repoRoot = makeTempRepo();
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    seedInitAnswers(repoRoot, 'Codex');
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Rules\n');
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'garda-agent-orchestrator/runtime/\nTASK.md\n');
    initializeGitRepo(repoRoot);
    const planFile = attached ? attachPlan(repoRoot) : resolveCanonicalTaskPlanPath(repoRoot, TASK_ID);
    if (!attached) seedStartedTask(repoRoot, TASK_ID);
    fs.writeFileSync(path.join(repoRoot, 'src/app.ts'), 'export const value = 2;\n');
    writePreflight(repoRoot, TASK_ID, ALL_REVIEW_FLAGS);
    seedCompilePass(repoRoot, TASK_ID);
    seedReviewGatePass(repoRoot, TASK_ID);
    seedDocImpactPass(repoRoot, TASK_ID);
    settleFixtureEffects({ repoRoot, taskId: TASK_ID });
    assert.equal(resolveNextStep({ repoRoot, taskId: TASK_ID }).next_gate, 'completion-gate');
    return { repoRoot, planFile };
}

function snapshot(repoRoot: string): Record<string, string> {
    const result: Record<string, string> = {};
    const visit = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === '.git') continue;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(file);
            else result[path.relative(repoRoot, file)] = `${fs.statSync(file).mtimeMs}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
        }
    };
    visit(repoRoot);
    return result;
}

function blockedPlan(repoRoot: string): ReturnType<typeof resolveNextStep> {
    const before = snapshot(repoRoot);
    const result = resolveNextStep({ repoRoot, taskId: TASK_ID });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.next_gate, 'task-plan-integrity', result.reason);
    assert.deepEqual(result.commands, []);
    assert.match(result.reason, /frozen attached JSON task plan/i);
    assert.deepEqual(snapshot(repoRoot), before);
    return result;
}

test('next-step rejects changed frozen plan bytes with unchanged size and mtime', t => {
    const { repoRoot, planFile } = workspace(t);
    const original = fs.readFileSync(planFile, 'utf8');
    const timestamp = new Date('2026-04-25T00:00:00.000Z');
    fs.utimesSync(planFile, timestamp, timestamp);
    assert.equal(resolveNextStep({ repoRoot, taskId: TASK_ID }).next_gate, 'completion-gate');
    fs.writeFileSync(planFile, original.replace('Preserve resume behavior', 'Alteredx resume behavior'));
    fs.utimesSync(planFile, timestamp, timestamp);
    assert.equal(fs.statSync(planFile).size, Buffer.byteLength(original));
    assert.equal(fs.statSync(planFile).mtimeMs, timestamp.getTime());
    assert.equal(blockedPlan(repoRoot).next_gate, 'task-plan-integrity');
    fs.writeFileSync(planFile, original);
    assert.equal(resolveNextStep({ repoRoot, taskId: TASK_ID }).next_gate, 'completion-gate');
});

test('next-step rejects a recomputed digest that differs from the frozen plan', t => {
    const { repoRoot, planFile } = workspace(t);
    const changed = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    changed.goal = 'Replace the frozen scope';
    delete changed.plan_sha256;
    fs.writeFileSync(planFile, serializeTaskPlan(validateTaskPlan(changed)));
    assert.equal(blockedPlan(repoRoot).next_gate, 'task-plan-integrity');
});

test('next-step rejects a missing frozen JSON attachment without writing lifecycle files', t => {
    const { repoRoot, planFile } = workspace(t);
    fs.rmSync(planFile);
    assert.equal(blockedPlan(repoRoot).next_gate, 'task-plan-integrity');
});

test('next-step rejects a foreign task in the frozen JSON attachment', t => {
    const { repoRoot, planFile } = workspace(t);
    const changed = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    changed.task_id = 'T-FOREIGN';
    delete changed.plan_sha256;
    fs.writeFileSync(planFile, serializeTaskPlan(validateTaskPlan(changed)));
    assert.equal(blockedPlan(repoRoot).next_gate, 'task-plan-integrity');
});

test('next-step rejects malformed and oversized frozen JSON attachments', t => {
    const { repoRoot, planFile } = workspace(t);
    fs.writeFileSync(planFile, '{broken');
    assert.equal(blockedPlan(repoRoot).next_gate, 'task-plan-integrity');
    fs.writeFileSync(planFile, ' '.repeat(TASK_PLAN_READ_MAX_BYTES + 1));
    assert.equal(blockedPlan(repoRoot).next_gate, 'task-plan-integrity');
});

test('next-step rejects a shared hard-linked frozen JSON attachment', t => {
    const { repoRoot, planFile } = workspace(t);
    fs.linkSync(planFile, path.join(repoRoot, 'shared-plan.json'));
    assert.equal(blockedPlan(repoRoot).next_gate, 'task-plan-integrity');
});

test('attached-plan integrity rejects escaped metadata without reading outside the repository', t => {
    const { repoRoot } = workspace(t);
    const before = snapshot(repoRoot);
    const escapedFile = path.resolve(repoRoot, '../outside-plan.json');
    const opened: string[] = [];
    const originalOpen = fs.openSync;
    t.mock.method(require('node:fs'), 'openSync', (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        opened.push(String(file));
        return originalOpen(file, flags, mode);
    });
    const failure = readAttachedTaskPlanIntegrityFailure(repoRoot, TASK_ID, {
        plan: { plan_path: escapedFile, plan_sha256: '0'.repeat(64) }
    });
    assert.match(failure || '', /attachment_invalid/);
    assert.ok(!opened.includes(escapedFile));
    assert.deepEqual(snapshot(repoRoot), before);
});

test('attached-plan integrity rejects missing frozen JSON metadata', t => {
    const { repoRoot } = workspace(t);
    assert.match(readAttachedTaskPlanIntegrityFailure(repoRoot, TASK_ID, { plan_guided: true }) || '', /metadata is missing/);
});

test('next-step preserves legacy no-plan continuation and ignores unattached plan discovery', t => {
    const { repoRoot, planFile } = workspace(t, false);
    fs.writeFileSync(planFile, '{invalid unattached plan');
    const before = snapshot(repoRoot);
    assert.equal(resolveNextStep({ repoRoot, taskId: TASK_ID }).next_gate, 'completion-gate');
    assert.deepEqual(snapshot(repoRoot), before);
});

test('next-step preserves optional Markdown guidance behavior', t => {
    const { repoRoot } = workspace(t, false);
    const directory = path.join(repoRoot, 'garda-agent-orchestrator/runtime/plans');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${TASK_ID}.md`);
    fs.writeFileSync(file, '# Optional executor guidance\n');
    const initial = resolveNextStep({ repoRoot, taskId: TASK_ID });
    fs.writeFileSync(file, '# Updated optional executor guidance\n');
    assert.equal(resolveNextStep({ repoRoot, taskId: TASK_ID }).next_gate, initial.next_gate);
    assert.equal(readAttachedTaskPlanIntegrityFailure(repoRoot, TASK_ID, { markdown_working_plan: { working_plan_path: file } }), null);
});
