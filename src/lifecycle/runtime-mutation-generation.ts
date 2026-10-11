import {
    beginRuntimeMutationGeneration,
    commitRuntimeMutationGeneration,
    resolveOrchestratorRootFromRuntimePath,
    type RuntimeMutationGenerationTicket
} from '../gate-runtime/runtime-mutation-generation';

export const CANONICAL_RUNTIME_MUTATION_SUBTREES = Object.freeze([
    'reviews',
    'task-events',
    'backups',
    'bundle-backups',
    'update-reports',
    'update-rollbacks'
] as const);

export type CanonicalRuntimeMutationSubtree = typeof CANONICAL_RUNTIME_MUTATION_SUBTREES[number];

function commitLifecycleMutationWithRetry(ticket: RuntimeMutationGenerationTicket): void {
    try {
        commitRuntimeMutationGeneration(ticket);
    } catch (firstSettlementError: unknown) {
        // Retry the same ticket once; the persisted operation must never execute again.
        try {
            commitRuntimeMutationGeneration(ticket);
        } catch (retryError: unknown) {
            throw new AggregateError(
                [firstSettlementError, retryError],
                `Lifecycle mutation '${ticket.mutation_kind}' generation settlement failed after one recovery retry.`
            );
        }
    }
}

function settlePersistedLifecycleMutation(
    ticket: RuntimeMutationGenerationTicket,
    operationError?: unknown
): void {
    try {
        commitLifecycleMutationWithRetry(ticket);
    } catch (settlementError: unknown) {
        if (operationError !== undefined) {
            throw new AggregateError(
                [operationError, settlementError],
                `Lifecycle mutation '${ticket.mutation_kind}' failed and its generation could not be settled.`
            );
        }
        throw settlementError;
    }
    if (operationError !== undefined) {
        throw operationError;
    }
}

export function resolveLifecycleRuntimeMutationOwner(targetPath: string): string | null {
    for (const subtree of CANONICAL_RUNTIME_MUTATION_SUBTREES) {
        const owner = resolveOrchestratorRootFromRuntimePath(targetPath, subtree);
        if (owner) {
            return owner;
        }
    }
    return null;
}

export function withLifecycleRuntimeMutationGeneration<T>(
    orchestratorRoot: string,
    mutationKind: string,
    callback: () => T
): T {
    const ticket = beginRuntimeMutationGeneration(orchestratorRoot, mutationKind);
    let result: T;
    try {
        result = callback();
    } catch (error: unknown) {
        settlePersistedLifecycleMutation(ticket, error);
        throw error;
    }
    settlePersistedLifecycleMutation(ticket);
    return result;
}

export async function withLifecycleRuntimeMutationGenerationAsync<T>(
    orchestratorRoot: string,
    mutationKind: string,
    callback: () => Promise<T>
): Promise<T> {
    const ticket = beginRuntimeMutationGeneration(orchestratorRoot, mutationKind);
    let result: T;
    try {
        result = await callback();
    } catch (error: unknown) {
        settlePersistedLifecycleMutation(ticket, error);
        throw error;
    }
    settlePersistedLifecycleMutation(ticket);
    return result;
}

export function withLifecycleRuntimeMutationGenerationForPath<T>(
    targetPath: string,
    mutationKind: string,
    callback: () => T
): T {
    const owner = resolveLifecycleRuntimeMutationOwner(targetPath);
    return owner
        ? withLifecycleRuntimeMutationGeneration(owner, mutationKind, callback)
        : callback();
}

export async function withLifecycleRuntimeMutationGenerationForPathAsync<T>(
    targetPath: string,
    mutationKind: string,
    callback: () => Promise<T>
): Promise<T> {
    const owner = resolveLifecycleRuntimeMutationOwner(targetPath);
    return owner
        ? withLifecycleRuntimeMutationGenerationAsync(owner, mutationKind, callback)
        : callback();
}
