import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_BUNDLE_NAME, SOURCE_OF_TRUTH_VALUES } from '../../../src/core/constants';
import { listTaskPlans, readTaskPlan } from '../../../src/core/task-plan-read';
import { buildCommandHelpText } from '../../../src/cli/commands/cli-help-output';
import { getCanonicalEntrypointFile, getProviderOrchestratorProfileDefinitions } from '../../../src/materialization/common';
import { buildCanonicalManagedBlock, buildProviderOrchestratorAgentContent } from '../../../src/materialization/content-builders';
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

test('explicit and multiple-plan preparation select the documented tasks without changing statuses', t => {
    const root = workspace(t, 'T-048');
    const queuePath = path.join(root, 'TASK.md');
    const queue = [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| T-048 | TODO | P1 | docs | First plan | unassigned | 2026-09-30 | default | [plan] Prepare first |',
        '| T-049 | TODO | P1 | docs | Second plan | unassigned | 2026-09-30 | default | [plan] Prepare second |',
        '| T-050 | TODO | P1 | docs | Ordinary task | unassigned | 2026-09-30 | default | No requested plan |',
        '| T-051 | DONE | P1 | docs | Finished task | unassigned | 2026-09-30 | default | [plan] Historical request |'
    ].join('\n');
    fs.writeFileSync(queuePath, queue);
    assert.deepEqual(listTaskPlans(root, true).map(plan => plan.task_id), ['T-048', 'T-049']);
    for (const taskId of ['T-048', 'T-049']) {
        const input = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', `plan-input-${taskId}.json`);
        fs.writeFileSync(input, JSON.stringify({ ...example(), task_id: taskId }));
        saveTaskPlan(root, taskId, input);
        const prepared = readTaskPlan(root, taskId);
        assert.equal(prepared.state, 'ready');
        const edited = validateTaskPlan(JSON.parse(prepared.content!));
        edited.notes = 'Assumptions: none; updated before task entry.';
        fs.writeFileSync(input, JSON.stringify(edited));
        saveTaskPlan(root, taskId, input);
        const updated = validateTaskPlan(JSON.parse(readTaskPlan(root, taskId).content!));
        assert.equal(updated.notes, edited.notes);
        assert.equal(updated.plan_sha256, computeTaskPlanDigest(updated));
        assert.equal(fs.readFileSync(queuePath, 'utf8'), queue);
    }
    const explicitInput = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'plan-input-T-050.json');
    const incomplete = { ...example(), task_id: 'T-050', acceptance_criteria: [] };
    fs.writeFileSync(explicitInput, JSON.stringify(incomplete));
    assert.throws(() => saveTaskPlan(root, 'T-050', explicitInput), /nonempty acceptance_criteria/u);
    fs.writeFileSync(explicitInput, JSON.stringify({ ...example(), task_id: 'T-050' }));
    saveTaskPlan(root, 'T-050', explicitInput);
    assert.equal(readTaskPlan(root, 'T-050').state, 'ready');
    assert.equal(fs.readFileSync(queuePath, 'utf8'), queue);
    assert.deepEqual(listTaskPlans(root, true), []);
    assert.deepEqual(listTaskPlans(root).map(plan => plan.state), ['ready', 'ready']);
});

test('generated provider surfaces route requested planning to canonical guidance without command copies', () => {
    const index = fs.readFileSync(path.join(process.cwd(), 'template/entrypoints/canonical-rule-index.md'), 'utf8');
    const rules = fs.readFileSync(path.join(process.cwd(), 'template/docs/agent-rules/80-task-workflow.md'), 'utf8');
    assert.equal(rules.match(/garda task plan --help/gu)?.length, 1);
    for (const provider of SOURCE_OF_TRUTH_VALUES) {
        const surface = buildCanonicalManagedBlock(getCanonicalEntrypointFile(provider), index);
        assert.ok(surface.includes('80-task-workflow.md'), provider);
        assert.doesNotMatch(surface, /task plan (?:list|show|save)/u);
    }
    for (const profile of getProviderOrchestratorProfileDefinitions()) {
        const surface = buildProviderOrchestratorAgentContent(profile.providerLabel, 'AGENTS.md', profile.orchestratorRelativePath);
        assert.ok(surface.includes('live/skills/orchestration/SKILL.md'), profile.providerLabel);
        assert.doesNotMatch(surface, /task plan (?:list|show|save)/u);
    }
    const help = buildCommandHelpText('task');
    assert.ok(help.includes('docs/task-plan-workflow.md'));
    const packageManifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    assert.ok(packageManifest.files.includes('docs/task-plan-workflow.md'));
    assert.match(planningInstructions, /prepare a ready structured plan before `enter-task-mode`/u);
    assert.match(planningInstructions, /Saving leaves statuses untouched and does not execute planned tasks/u);
    assert.match(planningInstructions, /load full details only on demand/iu);
    assert.match(guide, /--missing` selects only absent JSON plans/u);
    assert.match(guide, /explicit request for one task can prepare that task without changing its Notes token/u);
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
