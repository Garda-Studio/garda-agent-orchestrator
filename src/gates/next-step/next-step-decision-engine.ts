export const NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE = Object.freeze([
    'task-metadata-validation',
    'task-id-casing',
    'full-suite-repair-child',
    'task-queue-terminal',
    'completed-closeout',
    'startup',
    'classify',
    'optional-skill-selection',
    'protected-scope',
    'pre-guard',
    'scope-budget-guard',
    'review-cycle-guard',
    'strict-decomposition',
    'optional-skill-activation',
    'validation',
    'review-boundary',
    'active-review',
    'post-review'
] as const);

export type NextStepDecisionCheckpoint = typeof NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE[number];

export const NEXT_STEP_DECISION_KIND_PRECEDENCE = Object.freeze([
    'split',
    'audited-no-op',
    'failed-review',
    'normal'
] as const);

export type NextStepDecisionKind = typeof NEXT_STEP_DECISION_KIND_PRECEDENCE[number];

export interface AuthenticatedNextStepDecisionBinding {
    readonly source: 'authenticated-resolution-context';
    readonly taskId: string;
    readonly taskModePath: string;
    readonly preflightSha256: string | null;
}

export interface NextStepDecisionCandidate<TRoute> {
    readonly checkpoint: NextStepDecisionCheckpoint;
    readonly kind: NextStepDecisionKind;
    readonly evaluation: 'evaluated' | 'pending';
    readonly route: TRoute | null;
}

export interface AuthenticatedNextStepStateProjection<TRoute> {
    readonly schemaVersion: 1;
    readonly evidenceStatus: 'AUTHENTICATED';
    readonly binding: AuthenticatedNextStepDecisionBinding;
    readonly candidates: readonly NextStepDecisionCandidate<TRoute>[];
}

export interface NextStepTypedDecision<TRoute> {
    readonly checkpoint: NextStepDecisionCheckpoint;
    readonly kind: NextStepDecisionKind;
    readonly route: TRoute;
}

function cloneAndFreezeProjectionValue<T>(value: T, ancestors: readonly object[] = []): T {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'function' || typeof value === 'symbol') {
            throw new Error('Next-step decision routes must contain immutable data values only.');
        }
        return value;
    }
    if (ancestors.includes(value)) {
        throw new Error('Next-step decision routes must not contain circular references.');
    }
    const nextAncestors = [...ancestors, value];
    if (Array.isArray(value)) {
        return Object.freeze(value.map((entry) => cloneAndFreezeProjectionValue(entry, nextAncestors))) as T;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Next-step decision routes must contain plain objects and arrays only.');
    }
    const snapshot = Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, cloneAndFreezeProjectionValue(entry, nextAncestors)])
    );
    return Object.freeze(snapshot) as T;
}

export function createAuthenticatedNextStepStateProjection<TRoute>(options: {
    binding: AuthenticatedNextStepDecisionBinding;
    candidates: readonly NextStepDecisionCandidate<TRoute>[];
}): AuthenticatedNextStepStateProjection<TRoute> {
    if (options.candidates.length !== NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE.length) {
        throw new Error('Next-step decision projection must include every checkpoint exactly once.');
    }
    let pendingReached = false;
    for (const [index, candidate] of options.candidates.entries()) {
        const expectedCheckpoint = NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE[index];
        if (candidate.checkpoint !== expectedCheckpoint) {
            throw new Error(
                `Next-step decision projection checkpoint ${candidate.checkpoint} is out of order; expected ${expectedCheckpoint}.`
            );
        }
        if (candidate.evaluation === 'pending') {
            pendingReached = true;
            if (candidate.route !== null) {
                throw new Error(`Pending next-step checkpoint ${candidate.checkpoint} must not contain a route.`);
            }
        } else if (pendingReached) {
            throw new Error(`Evaluated next-step checkpoint ${candidate.checkpoint} follows a pending checkpoint.`);
        }
    }
    const binding = Object.freeze({ ...options.binding });
    const candidates = Object.freeze(options.candidates.map((candidate) => Object.freeze({
        ...candidate,
        route: candidate.route === null ? null : cloneAndFreezeProjectionValue(candidate.route)
    })));
    return Object.freeze({
        schemaVersion: 1 as const,
        evidenceStatus: 'AUTHENTICATED' as const,
        binding,
        candidates
    });
}

export function selectNextStepDecision<TRoute>(
    projection: AuthenticatedNextStepStateProjection<TRoute>
): NextStepTypedDecision<TRoute> | null {
    for (const checkpoint of NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE) {
        for (const kind of NEXT_STEP_DECISION_KIND_PRECEDENCE) {
            const candidate = projection.candidates.find((entry) => (
                entry.checkpoint === checkpoint
                && entry.kind === kind
                && entry.evaluation === 'evaluated'
                && entry.route !== null
            ));
            if (candidate && candidate.route !== null) {
                return Object.freeze({
                    checkpoint,
                    kind,
                    route: candidate.route
                });
            }
        }
    }
    return null;
}
