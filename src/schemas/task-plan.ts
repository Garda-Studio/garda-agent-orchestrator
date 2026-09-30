/**
 * Optional task-plan artifact schema, validator, and helpers.
 *
 * A task-plan is a planner-generated execution brief that an executor agent
 * can follow.  The planner/executor split is fully opt-in:
 *   - If a validated plan artifact exists, the executor should follow it.
 *   - If no plan exists, task execution continues exactly as today.
 *
 * Artifact path convention:
 *   `<bundle>/runtime/reviews/<task-id>-task-plan.json`
 */

import { createHash } from 'node:crypto';
import {
    ensurePlainObject,
    normalizeNonEmptyString,
    normalizeOptionalString,
    normalizeStringArray,
    normalizeEnum,
    normalizeInteger
} from './shared';

export const TASK_PLAN_SCHEMA_VERSION = 1;

const PLAN_STATUS_VALUES = ['draft', 'approved', 'superseded'] as const;
export type TaskPlanStatus = (typeof PLAN_STATUS_VALUES)[number];

const RISK_LEVEL_VALUES = ['low', 'medium', 'high'] as const;
export type TaskPlanRiskLevel = (typeof RISK_LEVEL_VALUES)[number];

export interface TaskPlanStep {
    id: string;
    title: string;
    description?: string;
    files?: string[];
    depends_on?: string[];
}

export interface TaskPlanValidationStrategy {
    approach: string;
    commands?: string[];
}

export interface TaskPlan {
    schema_version: number;
    task_id: string;
    status: TaskPlanStatus;
    goal: string;
    scope_files: string[];
    risk_level: TaskPlanRiskLevel;
    steps: TaskPlanStep[];
    acceptance_criteria?: string[];
    verification_expectations?: string[];
    out_of_scope?: string[];
    validation_strategy?: TaskPlanValidationStrategy;
    notes?: string;
    created_by?: string;
    created_at?: string;
    plan_sha256?: string;
}

export const taskPlanSchema: Record<string, unknown> = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'garda-agent-orchestrator/task-plan.schema.json',
    title: 'Task Plan',
    description: 'Optional planner-generated execution brief for the planner/executor split workflow.',
    type: 'object',
    properties: {
        schema_version: { type: 'integer', minimum: 1, description: 'Schema version of this plan artifact.' },
        task_id: { type: 'string', minLength: 1, description: 'Task identifier.' },
        status: {
            type: 'string',
            enum: [...PLAN_STATUS_VALUES],
            description: 'Plan lifecycle status: draft, approved, or superseded.'
        },
        goal: { type: 'string', minLength: 1, description: 'High-level goal the plan addresses.' },
        scope_files: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            description: 'Files the plan expects to create or modify.',
            minItems: 1
        },
        risk_level: {
            type: 'string',
            enum: [...RISK_LEVEL_VALUES],
            description: 'Overall risk assessment for the planned change.'
        },
        acceptance_criteria: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            description: 'Explicit acceptance criteria the implementation and reviewers should evaluate.'
        },
        verification_expectations: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            description: 'Expected verification evidence or intentionally limited validation scope.'
        },
        out_of_scope: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            description: 'Explicit exclusions that reviewers should not treat as active defects by default.'
        },
        steps: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string', minLength: 1, description: 'Step identifier (unique within the plan).' },
                    title: { type: 'string', minLength: 1, description: 'Short step title.' },
                    description: { type: 'string', description: 'Detailed step description.' },
                    files: {
                        type: 'array',
                        items: { type: 'string', minLength: 1 },
                        description: 'Files affected by this step.'
                    },
                    depends_on: {
                        type: 'array',
                        items: { type: 'string', minLength: 1 },
                        description: 'Step ids this step depends on.'
                    }
                },
                required: ['id', 'title']
            },
            description: 'Ordered execution steps.',
            minItems: 1
        },
        validation_strategy: {
            type: 'object',
            properties: {
                approach: { type: 'string', minLength: 1, description: 'Description of the validation approach.' },
                commands: {
                    type: 'array',
                    items: { type: 'string', minLength: 1 },
                    description: 'Optional validation commands.'
                }
            },
            required: ['approach'],
            description: 'How the executor should validate the implementation.'
        },
        notes: { type: 'string', description: 'Free-form planner notes.' },
        created_by: { type: 'string', description: 'Identity of the planner agent or user.' },
        created_at: { type: 'string', description: 'ISO 8601 timestamp of plan creation.' },
        plan_sha256: { type: 'string', description: 'SHA-256 digest of the canonical plan content for drift detection.' }
    },
    required: ['schema_version', 'task_id', 'status', 'goal', 'scope_files', 'risk_level', 'steps'],
    additionalProperties: true
});

function validateStep(input: unknown, index: number): TaskPlanStep {
    const raw = ensurePlainObject(input, `steps[${index}]`);
    const step: TaskPlanStep = {
        id: normalizeNonEmptyString(raw.id, `steps[${index}].id`),
        title: normalizeNonEmptyString(raw.title, `steps[${index}].title`)
    };

    const description = normalizeOptionalString(raw.description);
    if (description) {
        step.description = description;
    }

    if (raw.files !== undefined) {
        step.files = normalizeStringArray(raw.files, `steps[${index}].files`, { allowScalar: true });
    }

    if (raw.depends_on !== undefined) {
        step.depends_on = normalizeStringArray(raw.depends_on, `steps[${index}].depends_on`, { allowScalar: true });
    }

    return step;
}

function validateValidationStrategy(input: unknown): TaskPlanValidationStrategy {
    const raw = ensurePlainObject(input, 'validation_strategy');
    const strategy: TaskPlanValidationStrategy = {
        approach: normalizeNonEmptyString(raw.approach, 'validation_strategy.approach')
    };

    if (raw.commands !== undefined) {
        strategy.commands = normalizeStringArray(raw.commands, 'validation_strategy.commands', { allowScalar: true });
    }

    return strategy;
}

/** Check the validated references with an iterative DFS, preserving input order. */
function validateAcyclicStepDependencies(steps: TaskPlanStep[]): void {
    const dependencies = new Map(steps.map((step) => [step.id, step.depends_on ?? []]));
    const completed = new Set<string>();
    const activePositions = new Map<string, number>();
    const stack: { id: string; nextDependency: number }[] = [];

    for (const step of steps) {
        if (completed.has(step.id)) {
            continue;
        }
        activePositions.set(step.id, 0);
        stack.push({ id: step.id, nextDependency: 0 });

        while (stack.length > 0) {
            const current = stack[stack.length - 1];
            const currentDependencies = dependencies.get(current.id) ?? [];
            if (current.nextDependency === currentDependencies.length) {
                completed.add(current.id);
                activePositions.delete(current.id);
                stack.pop();
                continue;
            }

            const dependency = currentDependencies[current.nextDependency++];
            const cycleStart = activePositions.get(dependency);
            if (cycleStart !== undefined) {
                const cycle = stack.slice(cycleStart).map((frame) => frame.id);
                cycle.push(dependency);
                throw new Error(`Step dependency cycle: ${cycle.join(' -> ')}.`);
            }
            if (!completed.has(dependency)) {
                activePositions.set(dependency, stack.length);
                stack.push({ id: dependency, nextDependency: 0 });
            }
        }
    }
}

export function validateTaskPlan(input: unknown): TaskPlan {
    const raw = ensurePlainObject(input, 'task-plan');

    const schemaVersion = normalizeInteger(raw.schema_version, 'schema_version', { minimum: 1 });
    if (schemaVersion > TASK_PLAN_SCHEMA_VERSION) {
        throw new Error(`Unsupported task-plan schema_version ${schemaVersion}; max supported is ${TASK_PLAN_SCHEMA_VERSION}.`);
    }

    const taskId = normalizeNonEmptyString(raw.task_id, 'task_id');
    const status = normalizeEnum(raw.status, [...PLAN_STATUS_VALUES], 'status') as TaskPlanStatus;
    const goal = normalizeNonEmptyString(raw.goal, 'goal');
    const scopeFiles = normalizeStringArray(raw.scope_files, 'scope_files');
    if (scopeFiles.length === 0) {
        throw new Error('scope_files must contain at least one entry.');
    }

    const riskLevel = normalizeEnum(raw.risk_level, [...RISK_LEVEL_VALUES], 'risk_level') as TaskPlanRiskLevel;

    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
        throw new Error('steps must be a non-empty array.');
    }

    const steps = raw.steps.map((step: unknown, index: number) => validateStep(step, index));

    // Validate step id uniqueness.
    const stepIds = new Set<string>();
    for (const step of steps) {
        if (stepIds.has(step.id)) {
            throw new Error(`Duplicate step id '${step.id}'.`);
        }
        stepIds.add(step.id);
    }

    // Validate depends_on references.
    for (const step of steps) {
        if (step.depends_on) {
            for (const dep of step.depends_on) {
                if (!stepIds.has(dep)) {
                    throw new Error(`Step '${step.id}' depends on unknown step '${dep}'.`);
                }
            }
        }
    }

    validateAcyclicStepDependencies(steps);

    const plan: TaskPlan = {
        schema_version: schemaVersion,
        task_id: taskId,
        status,
        goal,
        scope_files: scopeFiles,
        risk_level: riskLevel,
        steps
    };

    if (raw.acceptance_criteria !== undefined) {
        plan.acceptance_criteria = normalizeStringArray(raw.acceptance_criteria, 'acceptance_criteria', { allowScalar: true });
    }

    if (raw.verification_expectations !== undefined) {
        plan.verification_expectations = normalizeStringArray(raw.verification_expectations, 'verification_expectations', { allowScalar: true });
    }

    if (raw.out_of_scope !== undefined) {
        plan.out_of_scope = normalizeStringArray(raw.out_of_scope, 'out_of_scope', { allowScalar: true });
    }

    if (raw.validation_strategy !== undefined) {
        plan.validation_strategy = validateValidationStrategy(raw.validation_strategy);
    }

    const notes = normalizeOptionalString(raw.notes);
    if (notes) {
        plan.notes = notes;
    }

    const createdBy = normalizeOptionalString(raw.created_by);
    if (createdBy) {
        plan.created_by = createdBy;
    }

    const createdAt = normalizeOptionalString(raw.created_at);
    if (createdAt) {
        plan.created_at = createdAt;
    }

    const planSha256 = normalizeOptionalString(raw.plan_sha256);
    if (planSha256) {
        plan.plan_sha256 = planSha256;
    }

    return plan;
}

/**
 * Replacer that sorts object keys at every nesting level for deterministic
 * serialization.  Array order is preserved.
 */
function deterministicReplacer(_key: string, value: unknown): unknown {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
            sorted[k] = (value as Record<string, unknown>)[k];
        }
        return sorted;
    }
    return value;
}

/**
 * Compute a SHA-256 digest of the canonical plan content (excluding the
 * `plan_sha256` field itself) for downstream drift detection.
 */
export function computeTaskPlanDigest(plan: TaskPlan): string {
    const { plan_sha256: _excluded, ...canonical } = plan;
    const json = JSON.stringify(canonical, deterministicReplacer);
    return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * Serialize a validated plan to a JSON string (pretty-printed).
 * Automatically computes and embeds `plan_sha256`.
 */
export function serializeTaskPlan(plan: TaskPlan): string {
    const digest = computeTaskPlanDigest(plan);
    const serialized: TaskPlan = { ...plan, plan_sha256: digest };
    return `${JSON.stringify(serialized, null, 2)}\n`;
}

export function isApprovedPlan(plan: TaskPlan): boolean {
    return plan.status === 'approved';
}

export type PlanDriftStatus = 'NO_DRIFT' | 'PLAN_DRIFT' | 'REPLAN_REQUIRED' | 'NO_PLAN';

export interface PlanDriftFile {
    path: string;
    in_plan: boolean;
}

export interface PlanDriftResult {
    status: PlanDriftStatus;
    plan_guided: boolean;
    plan_sha256: string | null;
    extra_files: string[];
    missing_files: string[];
    matched_files: string[];
    violations: string[];
}

export interface DetectPlanDriftOptions {
    plan: TaskPlan | null;
    actualFiles: string[];
    allowPlanDrift?: boolean;
    allowPlanDriftReason?: string;
}

function normalizeFilePath(filePath: string): string {
    let text = filePath.trim().replace(/\\/g, '/');
    text = text.replace(/^\.\//, '');
    text = text.replace(/\/+/g, '/');
    return text;
}

/**
 * Compare actual changed files against the plan's `scope_files`.
 *
 * When no plan is attached (`plan` is null) the result is `NO_PLAN` and
 * today's freeform behavior is fully preserved.
 *
 * When a plan is attached:
 * - Files in `actualFiles` not in plan `scope_files` → drift.
 * - `PLAN_DRIFT` when `allowPlanDrift` is true (override accepted).
 * - `REPLAN_REQUIRED` when drift is detected without override.
 * - `NO_DRIFT` when actual scope is a subset of plan scope.
 */
export function detectPlanDrift(options: DetectPlanDriftOptions): PlanDriftResult {
    const { plan, actualFiles, allowPlanDrift = false, allowPlanDriftReason } = options;

    if (!plan) {
        return {
            status: 'NO_PLAN',
            plan_guided: false,
            plan_sha256: null,
            extra_files: [],
            missing_files: [],
            matched_files: [],
            violations: []
        };
    }

    const planScope = new Set(plan.scope_files.map(normalizeFilePath));
    const actualNormalized = [...new Set(actualFiles.map(normalizeFilePath).filter(Boolean))];

    const extra: string[] = [];
    const matched: string[] = [];
    for (const file of actualNormalized) {
        if (planScope.has(file)) {
            matched.push(file);
        } else {
            extra.push(file);
        }
    }

    const actualSet = new Set(actualNormalized);
    const missing: string[] = [];
    for (const planned of planScope) {
        if (!actualSet.has(planned)) {
            missing.push(planned);
        }
    }

    extra.sort();
    missing.sort();
    matched.sort();

    const digest = plan.plan_sha256 || computeTaskPlanDigest(plan);
    const violations: string[] = [];

    if (extra.length === 0) {
        return {
            status: 'NO_DRIFT',
            plan_guided: true,
            plan_sha256: digest,
            extra_files: [],
            missing_files: missing,
            matched_files: matched,
            violations: []
        };
    }

    if (allowPlanDrift) {
        const reason = (allowPlanDriftReason || '').trim();
        if (!reason || reason.length < 12) {
            violations.push(
                'Plan drift override requires --allow-plan-drift-reason with a concrete justification (>= 12 chars).'
            );
            return {
                status: 'REPLAN_REQUIRED',
                plan_guided: true,
                plan_sha256: digest,
                extra_files: extra,
                missing_files: missing,
                matched_files: matched,
                violations
            };
        }
        violations.push(
            `Plan drift overridden: ${extra.length} file(s) outside plan scope. Reason: ${reason}`
        );
        return {
            status: 'PLAN_DRIFT',
            plan_guided: true,
            plan_sha256: digest,
            extra_files: extra,
            missing_files: missing,
            matched_files: matched,
            violations
        };
    }

    violations.push(
        `Plan drift detected: ${extra.length} file(s) outside plan scope_files: ${extra.join(', ')}. ` +
        'Replan the task or pass --allow-plan-drift with --allow-plan-drift-reason to override.'
    );

    return {
        status: 'REPLAN_REQUIRED',
        plan_guided: true,
        plan_sha256: digest,
        extra_files: extra,
        missing_files: missing,
        matched_files: matched,
        violations
    };
}
