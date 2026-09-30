import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_BUNDLE_NAME } from '../../../src/core/constants';
import { saveTaskPlan } from '../../../src/core/task-plan-save';
import { computeTaskPlanDigest, serializeTaskPlan, validateTaskPlan } from '../../../src/schemas/task-plan';
import { runEnterTaskModeCommand } from '../../../src/cli/commands/gate-flows/task-mode/task-mode-flow';
import { getTaskModeEvidence } from '../../../src/gates/task-mode';
import { createTempRepo } from '../cli/commands/gate-test-repo-bootstrap';
import { initializeGitRepo, seedInitAnswers, seedTaskQueue } from '../cli/commands/gate-test-seed-helpers';

const guide = fs.readFileSync(path.join(process.cwd(), 'docs/task-plan-workflow.md'), 'utf8');
const planningInstructions = fs.readFileSync(path.join(process.cwd(), 'template/skills/orchestration/SKILL.md'), 'utf8');

function example() {
    const match = /### Complete Ready JSON Example\s+```json\s+([\s\S]*?)```/u.exec(guide);
    assert.ok(match, 'The guide must contain one complete ready JSON example.');
    return validateTaskPlan(JSON.parse(match[1]));
}

function enter(root: string, taskId: string) {
    return runEnterTaskModeCommand({
        repoRoot: root, taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Use the documented task-plan example', provider: 'Codex', emitMetrics: false
    });
}

function workspace(t: TestContext, taskId: string): string {
    const root = createTempRepo(t);
    seedInitAnswers(root);
    seedTaskQueue(root, taskId);
    fs.writeFileSync(path.join(root, '.gitignore'), `${DEFAULT_BUNDLE_NAME}/runtime/\n`);
    initializeGitRepo(root);
    return root;
}

test('the documented ready example validates criteria, real scope and focused verification targets', () => {
    const plan = example();
    assert.equal(plan.status, 'approved');
    assert.ok(plan.acceptance_criteria!.length > 0);
    assert.ok(plan.verification_expectations!.length > 0);
    assert.ok(plan.out_of_scope!.length > 0);
    for (const file of plan.scope_files) assert.ok(fs.existsSync(path.join(process.cwd(), file)), file);
    for (const step of plan.steps) {
        for (const file of step.files || []) assert.ok(plan.scope_files.includes(file), file);
    }
    const commands = plan.validation_strategy!.commands!;
    assert.deepEqual(commands, ['node scripts/node-foundation/build-scripts.cjs test.js tests/node/schemas/task-plan.test.ts']);
    assert.ok(fs.existsSync(path.join(process.cwd(), commands[0].split(' ').at(-1)!)));
    const serialized = validateTaskPlan(JSON.parse(serializeTaskPlan(plan)));
    assert.equal(serialized.plan_sha256, computeTaskPlanDigest(serialized));
});

test('the documented save and ordinary entry flow attaches the example and refuses replacement after start', t => {
    const plan = example();
    const root = workspace(t, plan.task_id);
    const input = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'plan-input.json');
    fs.writeFileSync(input, JSON.stringify(plan));
    const saved = saveTaskPlan(root, plan.task_id, input);
    assert.equal(path.basename(saved), `${plan.task_id}-task-plan.json`);
    const stored = validateTaskPlan(JSON.parse(fs.readFileSync(saved, 'utf8')));
    assert.equal(stored.plan_sha256, computeTaskPlanDigest(stored));
    const result = enter(root, plan.task_id);
    assert.equal(result.exitCode, 0);
    assert.equal(getTaskModeEvidence(root, plan.task_id).plan?.plan_sha256, stored.plan_sha256);
    assert.ok(result.outputLines.includes('TaskPlanState: attached_json'));
    fs.writeFileSync(input, JSON.stringify({ ...plan, notes: 'A newly discovered incompatible requirement needs an explicit follow-up.' }));
    assert.throws(() => saveTaskPlan(root, plan.task_id, input), /existing TODO|start evidence|lifecycle history/u);
    assert.equal(fs.readFileSync(saved, 'utf8'), serializeTaskPlan(stored));
});

test('documented assumption examples use existing notes and preserve schema and digest compatibility', () => {
    const headings = ['No Assumptions', 'Ordinary Implementation Assumption', 'Unresolved Product Decision'];
    const expectedNotes = [/Assumptions: none/u, /extend the existing focused test file/u, /Resolve with the operator before implementing that behavior/u];
    for (const [index, heading] of headings.entries()) {
        const match = new RegExp('#### ' + heading + '\\s+```json\\s+([\\s\\S]*?)```', 'u').exec(guide);
        assert.ok(match, `Missing assumption example: ${heading}`);
        const fragment = JSON.parse(match[1]);
        assert.deepEqual(Object.keys(fragment), ['notes']);
        assert.equal(typeof fragment.notes, 'string');
        const plan = validateTaskPlan({ ...example(), ...fragment });
        assert.equal(plan.notes, fragment.notes);
        assert.match(plan.notes!, expectedNotes[index]);
        const stored = validateTaskPlan(JSON.parse(serializeTaskPlan(plan)));
        assert.deepEqual(stored.notes, plan.notes);
        assert.equal(stored.plan_sha256, computeTaskPlanDigest(stored));
    }
    assert.match(planningInstructions, /Record assumptions as `none` or a concise list in existing plan `notes` or the brief/u);
    assert.match(planningInstructions, /Make ordinary implementation choices within authorized scope/u);
    assert.match(planningInstructions, /before dependent work; independent investigation or work may continue/u);
    assert.match(planningInstructions, /needs an explicit follow-up/u);
    assert.match(guide, /After entry, the attached plan is frozen/u);
    assert.match(guide, /do not silently rewrite the active plan/u);
});

test('documented legacy and no-plan execution remain compatible without a criteria artifact', t => {
    const legacy = example();
    delete legacy.acceptance_criteria;
    delete legacy.verification_expectations;
    delete legacy.out_of_scope;
    const validated = validateTaskPlan(legacy);
    const legacyRoot = workspace(t, validated.task_id);
    assert.equal(validated.acceptance_criteria, undefined);
    const legacyPath = path.join(legacyRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${validated.task_id}-task-plan.json`);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, serializeTaskPlan(validated));
    assert.equal(enter(legacyRoot, validated.task_id).exitCode, 0);
    assert.ok(getTaskModeEvidence(legacyRoot, validated.task_id).plan);
    const freeformRoot = workspace(t, validated.task_id);
    const freeform = enter(freeformRoot, validated.task_id);
    assert.equal(freeform.exitCode, 0);
    assert.ok(freeform.outputLines.includes('TaskPlanState: none'));
    assert.equal(getTaskModeEvidence(freeformRoot, validated.task_id).plan, null);
});

test('canonical planning guidance reuses attached criteria and separates intent from completion evidence', () => {
    assert.match(guide, /goal:[^\n]+\n+done_when:[^\n]+\n+verification:/u);
    assert.match(guide, /No separate file is required/u);
    assert.match(guide, /schema still accepts legacy plans/u);
    assert.match(planningInstructions, /read and reuse its `goal`, `acceptance_criteria`, `verification_expectations`, `out_of_scope`, `scope_files` and `validation_strategy`/u);
    assert.match(planningInstructions, /Actual command outcomes and accepted review receipts establish completion evidence/u);
    assert.doesNotMatch(planningInstructions, /Do not move to implementation without plan\./u);
    assert.doesNotMatch(guide, /Enforced only when passed|No configuration changes[^\n]*default|Mark the task as `BLOCKED`/u);
});
