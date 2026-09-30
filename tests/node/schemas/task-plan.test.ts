import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TASK_PLAN_SCHEMA_VERSION,
    taskPlanSchema,
    validateTaskPlan,
    computeTaskPlanDigest,
    serializeTaskPlan,
    isApprovedPlan,
    detectPlanDrift
} from '../../../src/schemas/task-plan';
import type { TaskPlan } from '../../../src/schemas/task-plan';

import { validateAgainstSchema } from '../../../src/schemas/config-schemas';


function minimalValidPlan(): Record<string, unknown> {
    return {
        schema_version: 1,
        task_id: 'T-099',
        status: 'draft',
        goal: 'Implement the widget',
        scope_files: ['src/widget.ts'],
        risk_level: 'low',
        steps: [
            { id: 'step-1', title: 'Create widget module' }
        ]
    };
}

function fullValidPlan(): Record<string, unknown> {
    return {
        schema_version: 1,
        task_id: 'T-100',
        status: 'approved',
        goal: 'Add optional planner support',
        scope_files: ['src/planner.ts', 'tests/planner.test.ts'],
        risk_level: 'medium',
        steps: [
            { id: 'design', title: 'Design schema', description: 'Draft the JSON schema', files: ['src/schema.ts'] },
            { id: 'implement', title: 'Implement validator', files: ['src/validator.ts'], depends_on: ['design'] },
            { id: 'test', title: 'Write tests', depends_on: ['implement'] }
        ],
        validation_strategy: {
            approach: 'Run npm test and verify schema validation',
            commands: ['npm test']
        },
        notes: 'Keep it opt-in.',
        created_by: 'planner-agent',
        created_at: '2026-04-08T12:00:00Z'
    };
}


test('taskPlanSchema is a valid JSON Schema object', () => {
    assert.equal(taskPlanSchema.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.equal(taskPlanSchema.$id, 'garda-agent-orchestrator/task-plan.schema.json');
    assert.equal(taskPlanSchema.type, 'object');

    const required = taskPlanSchema.required as string[];
    assert.ok(required.includes('schema_version'));
    assert.ok(required.includes('task_id'));
    assert.ok(required.includes('status'));
    assert.ok(required.includes('goal'));
    assert.ok(required.includes('scope_files'));
    assert.ok(required.includes('risk_level'));
    assert.ok(required.includes('steps'));
});

test('taskPlanSchema validates minimal valid plan via validateAgainstSchema', () => {
    const result = validateAgainstSchema(minimalValidPlan(), taskPlanSchema);
    assert.ok(result.valid, `Errors: ${result.errors.map((e) => e.message).join('; ')}`);
});

test('taskPlanSchema validates full valid plan via validateAgainstSchema', () => {
    const result = validateAgainstSchema(fullValidPlan(), taskPlanSchema);
    assert.ok(result.valid, `Errors: ${result.errors.map((e) => e.message).join('; ')}`);
});

test('taskPlanSchema rejects missing required fields', () => {
    const result = validateAgainstSchema({}, taskPlanSchema);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 7);
});


test('validateTaskPlan accepts minimal valid plan', () => {
    const plan = validateTaskPlan(minimalValidPlan());
    assert.equal(plan.schema_version, 1);
    assert.equal(plan.task_id, 'T-099');
    assert.equal(plan.status, 'draft');
    assert.equal(plan.goal, 'Implement the widget');
    assert.deepEqual(plan.scope_files, ['src/widget.ts']);
    assert.equal(plan.risk_level, 'low');
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].id, 'step-1');
});

test('validateTaskPlan accepts full valid plan with optional fields', () => {
    const plan = validateTaskPlan(fullValidPlan());
    assert.equal(plan.status, 'approved');
    assert.equal(plan.steps.length, 3);
    assert.deepEqual(plan.steps[1].depends_on, ['design']);
    assert.ok(plan.validation_strategy);
    assert.equal(plan.validation_strategy!.approach, 'Run npm test and verify schema validation');
    assert.deepEqual(plan.validation_strategy!.commands, ['npm test']);
    assert.equal(plan.notes, 'Keep it opt-in.');
    assert.equal(plan.created_by, 'planner-agent');
    assert.equal(plan.created_at, '2026-04-08T12:00:00Z');
});

test('validateTaskPlan rejects non-object input', () => {
    assert.throws(() => validateTaskPlan('string'), /must be a JSON object/);
    assert.throws(() => validateTaskPlan(null), /must be a JSON object/);
    assert.throws(() => validateTaskPlan(42), /must be a JSON object/);
});

test('validateTaskPlan rejects missing task_id', () => {
    const input = minimalValidPlan();
    delete input.task_id;
    assert.throws(() => validateTaskPlan(input), /task_id/);
});

test('validateTaskPlan rejects empty goal', () => {
    const input = minimalValidPlan();
    input.goal = '  ';
    assert.throws(() => validateTaskPlan(input), /goal/);
});

test('validateTaskPlan rejects invalid status', () => {
    const input = minimalValidPlan();
    input.status = 'completed';
    assert.throws(() => validateTaskPlan(input), /status/);
});

test('validateTaskPlan rejects invalid risk_level', () => {
    const input = minimalValidPlan();
    input.risk_level = 'critical';
    assert.throws(() => validateTaskPlan(input), /risk_level/);
});

test('validateTaskPlan rejects empty scope_files', () => {
    const input = minimalValidPlan();
    input.scope_files = [];
    assert.throws(() => validateTaskPlan(input), /scope_files/);
});

test('validateTaskPlan rejects empty steps', () => {
    const input = minimalValidPlan();
    input.steps = [];
    assert.throws(() => validateTaskPlan(input), /steps/);
});

test('validateTaskPlan rejects duplicate step ids', () => {
    const input = minimalValidPlan();
    input.steps = [
        { id: 'dup', title: 'First' },
        { id: 'dup', title: 'Second' }
    ];
    assert.throws(() => validateTaskPlan(input), /Duplicate step id/);
});

test('validateTaskPlan rejects unknown depends_on reference', () => {
    const input = minimalValidPlan();
    input.steps = [
        { id: 'a', title: 'Step A', depends_on: ['nonexistent'] }
    ];
    assert.throws(() => validateTaskPlan(input), /depends on unknown step/);
});

test('validateTaskPlan rejects a self-dependency with its cycle path', () => {
    const input = minimalValidPlan();
    input.steps = [{ id: 'a', title: 'Step A', depends_on: ['a'] }];
    assert.throws(() => validateTaskPlan(input), {
        message: 'Step dependency cycle: a -> a.'
    });
});

test('validateTaskPlan rejects two-step and longer dependency cycles', () => {
    for (const ids of [['a', 'b'], ['a', 'b', 'c', 'd']]) {
        const input = minimalValidPlan();
        input.steps = ids.map((id, index) => ({
            id,
            title: id,
            depends_on: [ids[(index + 1) % ids.length]]
        }));
        assert.throws(() => validateTaskPlan(input), {
            message: `Step dependency cycle: ${[...ids, ids[0]].join(' -> ')}.`
        });
    }
});

test('validateTaskPlan reports the first cycle in step and dependency order', () => {
    const input = minimalValidPlan();
    input.steps = [
        { id: 'root', title: 'Root', depends_on: ['leaf', 'b', 'a'] },
        { id: 'a', title: 'A', depends_on: ['a'] },
        { id: 'b', title: 'B', depends_on: ['c'] },
        { id: 'c', title: 'C', depends_on: ['b'] },
        { id: 'leaf', title: 'Leaf' }
    ];
    assert.throws(() => validateTaskPlan(input), {
        message: 'Step dependency cycle: b -> c -> b.'
    });
});

test('validateTaskPlan accepts independent steps and a branching DAG with forward references', () => {
    const input = minimalValidPlan();
    input.steps = [
        { id: 'root', title: 'Root', depends_on: ['a', 'b'] },
        { id: 'independent', title: 'Independent' },
        { id: 'a', title: 'A', depends_on: ['leaf'] },
        { id: 'b', title: 'B', depends_on: ['leaf'] },
        { id: 'leaf', title: 'Leaf' }
    ];
    assert.deepEqual(validateTaskPlan(input).steps, input.steps);
});

test('validateTaskPlan retains duplicate and unknown-reference error precedence over cycles', () => {
    const input = minimalValidPlan();
    input.steps = [
        { id: 'a', title: 'A', depends_on: ['a'] },
        { id: 'b', title: 'B', depends_on: ['missing'] }
    ];
    assert.throws(() => validateTaskPlan(input), {
        message: "Step 'b' depends on unknown step 'missing'."
    });
    input.steps = [
        { id: 'a', title: 'A', depends_on: ['a'] },
        { id: 'a', title: 'Duplicate A' }
    ];
    assert.throws(() => validateTaskPlan(input), { message: "Duplicate step id 'a'." });
});

test('validateTaskPlan handles deep acyclic plans and deep cycles without recursive stack overflow', () => {
    const input = minimalValidPlan();
    const steps = Array.from({ length: 15000 }, (_, index) => ({
        id: `step-${index}`,
        title: `Step ${index}`,
        depends_on: index === 14999 ? [] : [`step-${index + 1}`]
    }));
    input.steps = steps;
    assert.equal(validateTaskPlan(input).steps.length, steps.length);
    steps[14999].depends_on = ['step-14998'];
    assert.throws(() => validateTaskPlan(input), {
        message: 'Step dependency cycle: step-14998 -> step-14999 -> step-14998.'
    });
});

test('validateTaskPlan rejects unsupported schema_version', () => {
    const input = minimalValidPlan();
    input.schema_version = 999;
    assert.throws(() => validateTaskPlan(input), /Unsupported task-plan schema_version/);
});

test('validateTaskPlan rejects non-integer schema_version', () => {
    const input = minimalValidPlan();
    input.schema_version = 'one';
    assert.throws(() => validateTaskPlan(input), /schema_version/);
});

test('validateTaskPlan accepts superseded status', () => {
    const input = minimalValidPlan();
    input.status = 'superseded';
    const plan = validateTaskPlan(input);
    assert.equal(plan.status, 'superseded');
});

test('validateTaskPlan accepts high risk_level', () => {
    const input = minimalValidPlan();
    input.risk_level = 'high';
    const plan = validateTaskPlan(input);
    assert.equal(plan.risk_level, 'high');
});

test('validateTaskPlan normalizes whitespace in string fields', () => {
    const input = minimalValidPlan();
    input.task_id = '  T-099  ';
    input.goal = '  Implement the widget  ';
    const plan = validateTaskPlan(input);
    assert.equal(plan.task_id, 'T-099');
    assert.equal(plan.goal, 'Implement the widget');
});

test('validateTaskPlan preserves plan_sha256 when present', () => {
    const input = { ...fullValidPlan(), plan_sha256: 'abc123' };
    const plan = validateTaskPlan(input);
    assert.equal(plan.plan_sha256, 'abc123');
});


test('computeTaskPlanDigest returns a 64-char hex string', () => {
    const plan = validateTaskPlan(minimalValidPlan());
    const digest = computeTaskPlanDigest(plan);
    assert.equal(digest.length, 64);
    assert.match(digest, /^[0-9a-f]{64}$/);
});

test('computeTaskPlanDigest is stable across calls', () => {
    const plan = validateTaskPlan(minimalValidPlan());
    const d1 = computeTaskPlanDigest(plan);
    const d2 = computeTaskPlanDigest(plan);
    assert.equal(d1, d2);
});

test('computeTaskPlanDigest changes when plan content changes', () => {
    const planA = validateTaskPlan(minimalValidPlan());
    const planB = validateTaskPlan({ ...minimalValidPlan(), goal: 'Different goal' });
    assert.notEqual(computeTaskPlanDigest(planA), computeTaskPlanDigest(planB));
});

test('computeTaskPlanDigest excludes plan_sha256 from computation', () => {
    const plan = validateTaskPlan(minimalValidPlan());
    const d1 = computeTaskPlanDigest(plan);
    const planWithHash = { ...plan, plan_sha256: 'ignored' };
    const d2 = computeTaskPlanDigest(planWithHash);
    assert.equal(d1, d2);
});

test('computeTaskPlanDigest detects nested step title change', () => {
    const inputA = fullValidPlan();
    const inputB = JSON.parse(JSON.stringify(fullValidPlan()));
    (inputB.steps as Array<Record<string, string>>)[0].title = 'Completely different title';
    const planA = validateTaskPlan(inputA);
    const planB = validateTaskPlan(inputB);
    assert.notEqual(computeTaskPlanDigest(planA), computeTaskPlanDigest(planB));
});

test('computeTaskPlanDigest detects nested validation_strategy change', () => {
    const inputA = fullValidPlan();
    const inputB = JSON.parse(JSON.stringify(fullValidPlan()));
    (inputB.validation_strategy as Record<string, string>).approach = 'Different approach';
    const planA = validateTaskPlan(inputA);
    const planB = validateTaskPlan(inputB);
    assert.notEqual(computeTaskPlanDigest(planA), computeTaskPlanDigest(planB));
});

test('computeTaskPlanDigest detects step depends_on change', () => {
    const inputA = fullValidPlan();
    const inputB = JSON.parse(JSON.stringify(fullValidPlan()));
    (inputB.steps as Array<Record<string, unknown>>)[2].depends_on = ['design'];
    const planA = validateTaskPlan(inputA);
    const planB = validateTaskPlan(inputB);
    assert.notEqual(computeTaskPlanDigest(planA), computeTaskPlanDigest(planB));
});

test('serializeTaskPlan produces valid JSON with embedded plan_sha256', () => {
    const plan = validateTaskPlan(fullValidPlan());
    const json = serializeTaskPlan(plan);
    const parsed = JSON.parse(json);
    assert.equal(parsed.task_id, 'T-100');
    assert.ok(parsed.plan_sha256);
    assert.equal(parsed.plan_sha256.length, 64);
});

test('serializeTaskPlan JSON can be round-tripped through validateTaskPlan', () => {
    const plan = validateTaskPlan(fullValidPlan());
    const json = serializeTaskPlan(plan);
    const roundTripped = validateTaskPlan(JSON.parse(json));
    assert.equal(roundTripped.task_id, plan.task_id);
    assert.equal(roundTripped.status, plan.status);
    assert.equal(roundTripped.steps.length, plan.steps.length);
    assert.ok(roundTripped.plan_sha256);
});


test('isApprovedPlan returns true for approved status', () => {
    const plan = validateTaskPlan(fullValidPlan());
    assert.ok(isApprovedPlan(plan));
});

test('isApprovedPlan returns false for draft status', () => {
    const plan = validateTaskPlan(minimalValidPlan());
    assert.equal(isApprovedPlan(plan), false);
});

test('isApprovedPlan returns false for superseded status', () => {
    const plan = validateTaskPlan({ ...minimalValidPlan(), status: 'superseded' });
    assert.equal(isApprovedPlan(plan), false);
});


test('TASK_PLAN_SCHEMA_VERSION is 1', () => {
    assert.equal(TASK_PLAN_SCHEMA_VERSION, 1);
});


function approvedPlan(scopeFiles: string[]): TaskPlan {
    return validateTaskPlan({
        schema_version: 1,
        task_id: 'T-099',
        status: 'approved',
        goal: 'Test plan drift detection',
        scope_files: scopeFiles,
        risk_level: 'low',
        steps: [{ id: 'step-1', title: 'Implement' }]
    });
}

test('detectPlanDrift returns NO_PLAN when plan is null', () => {
    const result = detectPlanDrift({ plan: null, actualFiles: ['src/foo.ts'] });
    assert.equal(result.status, 'NO_PLAN');
    assert.equal(result.plan_guided, false);
    assert.equal(result.plan_sha256, null);
    assert.deepEqual(result.extra_files, []);
    assert.deepEqual(result.violations, []);
});

test('detectPlanDrift returns NO_DRIFT when actual files are subset of plan scope', () => {
    const plan = approvedPlan(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const result = detectPlanDrift({ plan, actualFiles: ['src/a.ts', 'src/b.ts'] });
    assert.equal(result.status, 'NO_DRIFT');
    assert.equal(result.plan_guided, true);
    assert.ok(result.plan_sha256);
    assert.deepEqual(result.extra_files, []);
    assert.deepEqual(result.matched_files, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(result.missing_files, ['src/c.ts']);
    assert.deepEqual(result.violations, []);
});

test('detectPlanDrift returns NO_DRIFT when actual files match plan scope exactly', () => {
    const plan = approvedPlan(['src/a.ts', 'src/b.ts']);
    const result = detectPlanDrift({ plan, actualFiles: ['src/a.ts', 'src/b.ts'] });
    assert.equal(result.status, 'NO_DRIFT');
    assert.deepEqual(result.extra_files, []);
    assert.deepEqual(result.missing_files, []);
    assert.deepEqual(result.matched_files, ['src/a.ts', 'src/b.ts']);
});

test('detectPlanDrift returns REPLAN_REQUIRED when extra files without override', () => {
    const plan = approvedPlan(['src/a.ts']);
    const result = detectPlanDrift({ plan, actualFiles: ['src/a.ts', 'src/extra.ts'] });
    assert.equal(result.status, 'REPLAN_REQUIRED');
    assert.equal(result.plan_guided, true);
    assert.deepEqual(result.extra_files, ['src/extra.ts']);
    assert.deepEqual(result.matched_files, ['src/a.ts']);
    assert.ok(result.violations.length > 0);
    assert.ok(result.violations[0].includes('Plan drift detected'));
    assert.ok(result.violations[0].includes('src/extra.ts'));
});

test('detectPlanDrift returns PLAN_DRIFT when extra files with valid override', () => {
    const plan = approvedPlan(['src/a.ts']);
    const result = detectPlanDrift({
        plan,
        actualFiles: ['src/a.ts', 'src/extra.ts'],
        allowPlanDrift: true,
        allowPlanDriftReason: 'Required for dependency update cascade'
    });
    assert.equal(result.status, 'PLAN_DRIFT');
    assert.equal(result.plan_guided, true);
    assert.deepEqual(result.extra_files, ['src/extra.ts']);
    assert.ok(result.violations.length > 0);
    assert.ok(result.violations[0].includes('Plan drift overridden'));
});

test('detectPlanDrift returns REPLAN_REQUIRED when override reason is too short', () => {
    const plan = approvedPlan(['src/a.ts']);
    const result = detectPlanDrift({
        plan,
        actualFiles: ['src/a.ts', 'src/extra.ts'],
        allowPlanDrift: true,
        allowPlanDriftReason: 'short'
    });
    assert.equal(result.status, 'REPLAN_REQUIRED');
    assert.ok(result.violations[0].includes('>= 12 chars'));
});

test('detectPlanDrift returns REPLAN_REQUIRED when override reason is missing', () => {
    const plan = approvedPlan(['src/a.ts']);
    const result = detectPlanDrift({
        plan,
        actualFiles: ['src/a.ts', 'src/extra.ts'],
        allowPlanDrift: true
    });
    assert.equal(result.status, 'REPLAN_REQUIRED');
    assert.ok(result.violations[0].includes('>= 12 chars'));
});

test('detectPlanDrift normalizes backslashes in paths', () => {
    const plan = approvedPlan(['src/a.ts']);
    const result = detectPlanDrift({ plan, actualFiles: ['src\\a.ts'] });
    assert.equal(result.status, 'NO_DRIFT');
    assert.deepEqual(result.matched_files, ['src/a.ts']);
});

test('detectPlanDrift deduplicates actual files', () => {
    const plan = approvedPlan(['src/a.ts']);
    const result = detectPlanDrift({ plan, actualFiles: ['src/a.ts', 'src/a.ts'] });
    assert.equal(result.status, 'NO_DRIFT');
    assert.deepEqual(result.matched_files, ['src/a.ts']);
});

test('detectPlanDrift handles empty actual files', () => {
    const plan = approvedPlan(['src/a.ts']);
    const result = detectPlanDrift({ plan, actualFiles: [] });
    assert.equal(result.status, 'NO_DRIFT');
    assert.deepEqual(result.matched_files, []);
    assert.deepEqual(result.missing_files, ['src/a.ts']);
    assert.deepEqual(result.extra_files, []);
});

test('detectPlanDrift reports multiple extra files sorted', () => {
    const plan = approvedPlan(['src/a.ts']);
    const result = detectPlanDrift({ plan, actualFiles: ['src/z.ts', 'src/a.ts', 'src/m.ts'] });
    assert.equal(result.status, 'REPLAN_REQUIRED');
    assert.deepEqual(result.extra_files, ['src/m.ts', 'src/z.ts']);
});

test('detectPlanDrift uses embedded plan_sha256 when available', () => {
    const plan = approvedPlan(['src/a.ts']);
    const digest = computeTaskPlanDigest(plan);
    plan.plan_sha256 = digest;
    const result = detectPlanDrift({ plan, actualFiles: ['src/a.ts'] });
    assert.equal(result.plan_sha256, digest);
});

test('detectPlanDrift computes digest when plan_sha256 is missing', () => {
    const plan = approvedPlan(['src/a.ts']);
    const planAny = plan as unknown as Record<string, unknown>;
    delete planAny.plan_sha256;
    const result = detectPlanDrift({ plan, actualFiles: ['src/a.ts'] });
    assert.ok(result.plan_sha256);
    assert.equal(result.plan_sha256!.length, 64);
});

test('detectPlanDrift filters empty paths from actual files', () => {
    const plan = approvedPlan(['src/a.ts']);
    const result = detectPlanDrift({ plan, actualFiles: ['', '  ', 'src/a.ts'] });
    assert.equal(result.status, 'NO_DRIFT');
    assert.deepEqual(result.matched_files, ['src/a.ts']);
});

test('detectPlanDrift normalizes leading ./ in plan scope_files', () => {
    const plan = approvedPlan(['./src/a.ts']);
    const result = detectPlanDrift({ plan, actualFiles: ['src/a.ts'] });
    assert.equal(result.status, 'NO_DRIFT');
    assert.deepEqual(result.matched_files, ['src/a.ts']);
});

test('detectPlanDrift normalizes leading ./ in actual files', () => {
    const plan = approvedPlan(['src/a.ts']);
    const result = detectPlanDrift({ plan, actualFiles: ['./src/a.ts'] });
    assert.equal(result.status, 'NO_DRIFT');
    assert.deepEqual(result.matched_files, ['src/a.ts']);
});

test('detectPlanDrift collapses duplicate slashes', () => {
    const plan = approvedPlan(['src//a.ts']);
    const result = detectPlanDrift({ plan, actualFiles: ['src/a.ts'] });
    assert.equal(result.status, 'NO_DRIFT');
    assert.deepEqual(result.matched_files, ['src/a.ts']);
});
