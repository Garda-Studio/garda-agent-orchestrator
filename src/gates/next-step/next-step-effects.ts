import { createHash } from 'node:crypto';

export interface NextStepEffectDefinition<T> {
    kind: string;
    summary: string;
    input: Record<string, unknown>;
    preview: () => T;
    execute: () => T;
}

export interface NextStepEffectPlanEntry {
    kind: string;
    summary: string;
    input_sha256: string;
    plan_sha256: string;
}

export interface NextStepEffectPlan {
    schema_version: 1;
    effects: NextStepEffectPlanEntry[];
    plan_sha256: string;
}

export interface NextStepEffectController {
    run<T>(definition: NextStepEffectDefinition<T>): T;
    pendingPlan(): NextStepEffectPlan | null;
    executedCount(): number;
}

export class NextStepEffectPlanStaleError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NextStepEffectPlanStaleError';
    }
}

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : String(value);
    }
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, entry]) => entry !== undefined)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, canonicalize(entry)])
        );
    }
    return String(value);
}

function sha256Json(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function buildPlanEntry(definition: NextStepEffectDefinition<unknown>): NextStepEffectPlanEntry {
    const inputSha256 = sha256Json(definition.input);
    return {
        kind: definition.kind,
        summary: definition.summary,
        input_sha256: inputSha256,
        plan_sha256: sha256Json({
            schema_version: 1,
            kind: definition.kind,
            input_sha256: inputSha256
        })
    };
}

function buildPlan(entries: readonly NextStepEffectPlanEntry[]): NextStepEffectPlan | null {
    if (entries.length === 0) {
        return null;
    }
    const effects = entries.map((entry) => ({ ...entry }));
    return {
        schema_version: 1,
        effects,
        plan_sha256: sha256Json({
            schema_version: 1,
            effects: effects.map((entry) => ({
                kind: entry.kind,
                input_sha256: entry.input_sha256,
                plan_sha256: entry.plan_sha256
            }))
        })
    };
}

function samePlanEntry(left: NextStepEffectPlanEntry, right: NextStepEffectPlanEntry): boolean {
    return left.kind === right.kind
        && left.input_sha256 === right.input_sha256
        && left.plan_sha256 === right.plan_sha256;
}

export function createNextStepEffectPlanner(): NextStepEffectController {
    const pending: NextStepEffectPlanEntry[] = [];
    return {
        run<T>(definition: NextStepEffectDefinition<T>): T {
            pending.push(buildPlanEntry(definition));
            return definition.preview();
        },
        pendingPlan: () => buildPlan(pending),
        executedCount: () => 0
    };
}

export function createNextStepEffectExecutor(
    expectedPlan: NextStepEffectPlan
): NextStepEffectController {
    let expectedIndex = 0;
    let executed = 0;
    const pending: NextStepEffectPlanEntry[] = [];
    return {
        run<T>(definition: NextStepEffectDefinition<T>): T {
            const actualEntry = buildPlanEntry(definition);
            const expectedEntry = expectedPlan.effects[expectedIndex];
            if (!expectedEntry) {
                pending.push(actualEntry);
                return definition.preview();
            }
            if (!samePlanEntry(actualEntry, expectedEntry)) {
                throw new NextStepEffectPlanStaleError(
                    `Next-step effect plan is stale at effect ${expectedIndex + 1}: ` +
                    `expected ${expectedEntry.kind}/${expectedEntry.plan_sha256}, ` +
                    `found ${actualEntry.kind}/${actualEntry.plan_sha256}. Rerun next-step inspection.`
                );
            }
            expectedIndex += 1;
            const result = definition.execute();
            executed += 1;
            return result;
        },
        pendingPlan: () => buildPlan(pending),
        executedCount: () => executed
    };
}

export function assertNextStepEffectExecutionComplete(
    controller: NextStepEffectController,
    expectedPlan: NextStepEffectPlan
): void {
    const executed = controller.executedCount();
    const unexpectedPlan = controller.pendingPlan();
    if (executed === expectedPlan.effects.length && !unexpectedPlan) {
        return;
    }
    throw new NextStepEffectPlanStaleError(
        `Next-step effect plan became stale during execution: ` +
        `executed ${executed} of ${expectedPlan.effects.length} expected effects` +
        `${unexpectedPlan ? ` and encountered ${unexpectedPlan.effects.length} unexpected effects` : ''}. ` +
        'Rerun next-step inspection.'
    );
}

export function assertNextStepEffectPlanHash(
    plan: NextStepEffectPlan | null,
    expectedPlanSha256: string
): asserts plan is NextStepEffectPlan {
    const expected = String(expectedPlanSha256 || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(expected)) {
        throw new NextStepEffectPlanStaleError(
            'NextStepEffectPlanSha256 must be a 64-character lowercase SHA-256 value.'
        );
    }
    if (!plan || plan.plan_sha256 !== expected) {
        throw new NextStepEffectPlanStaleError(
            `Next-step effect plan is stale: expected ${expected}, ` +
            `found ${plan?.plan_sha256 || '<none>'}. Rerun next-step inspection.`
        );
    }
}
