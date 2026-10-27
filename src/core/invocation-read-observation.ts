import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import { captureInvocationMemoTrace, replayInvocationMemoTrace, type ObservationTrace } from './derivation-observation-recorder';

const invocationReadMemoKeyBrand: unique symbol = Symbol('invocation-read-memo-key');

export interface InvocationReadMemoKey<T> {
    readonly token: symbol;
    readonly [invocationReadMemoKeyBrand]: (value: T) => T;
}

type InvocationReadMemoEntry = ({ readonly value: unknown } | { readonly error: unknown }) & { readonly trace: ObservationTrace };

interface InvocationReadObservation {
    readonly dependencies: Map<object, () => void>;
    readonly memoized: Map<symbol, Map<string, InvocationReadMemoEntry>>;
    failure: { error: unknown } | null;
    validating: boolean;
    closed: boolean;
}

const invocationReadObservations = new AsyncLocalStorage<InvocationReadObservation>();

function activeObservation(): InvocationReadObservation | undefined {
    const observation = invocationReadObservations.getStore();
    return observation?.closed ? undefined : observation;
}

function failObservation(observation: InvocationReadObservation, error: unknown): never {
    if (!observation.failure) observation.failure = { error };
    throw observation.failure.error;
}

function throwObservedFailure(observation: InvocationReadObservation): void {
    if (observation.failure) throw observation.failure.error;
}

function assertObservationCurrent(observation: InvocationReadObservation): void {
    throwObservedFailure(observation);
    if (observation.validating) {
        failObservation(observation, new Error('Invocation dependency validation cannot be re-entered.'));
    }
    observation.validating = true;
    try {
        // A live iterator also validates dependencies registered by an earlier validator.
        for (const validate of observation.dependencies.values()) {
            validate();
            throwObservedFailure(observation);
        }
    } catch (error: unknown) {
        failObservation(observation, error);
    } finally {
        observation.validating = false;
    }
}

function closeObservation(observation: InvocationReadObservation): void {
    observation.closed = true;
    observation.dependencies.clear();
    observation.memoized.clear();
}

/** Keys are invariant and identity-based; descriptions never merge independent owners. */
export function createInvocationReadMemoKey<T>(description: string): InvocationReadMemoKey<T> {
    return Object.freeze({ token: Symbol(description) }) as InvocationReadMemoKey<T>;
}

/** Memoize the first result or error only for this invocation. Owners keep values immutable. */
export function memoizeInvocationRead<T>(
    key: InvocationReadMemoKey<T>, memoId: string, build: () => T
): { readonly active: boolean; readonly value: T } {
    const observation = activeObservation();
    if (!observation) return { active: false, value: build() };
    throwObservedFailure(observation);
    let values = observation.memoized.get(key.token);
    if (!values) { values = new Map(); observation.memoized.set(key.token, values); }
    if (!values.has(memoId)) {
        const captured = captureInvocationMemoTrace(build);
        values.set(memoId, captured.outcome.returned
            ? { value: captured.outcome.value, trace: captured.trace }
            : { error: captured.outcome.error, trace: captured.trace });
    }
    const entry = values.get(memoId)!;
    replayInvocationMemoTrace(entry.trace);
    if ('error' in entry) throw entry.error;
    return { active: true, value: entry.value as T };
}

/** Register the first validator for this observation owner; later calls cannot rebaseline it. */
export function registerInvocationDependency(owner: object, validate: () => void): void {
    const observation = activeObservation();
    if (observation && !observation.dependencies.has(owner)) observation.dependencies.set(owner, validate);
}

export function isInvocationReadObservationActive(): boolean {
    return activeObservation() !== undefined;
}

/** Check inside snapshot lifetimes and immediately before effects as well as at invocation exit. */
export function assertInvocationDependenciesCurrent(): void {
    const observation = activeObservation();
    if (observation) assertObservationCurrent(observation);
}

/** Nested calls share dependencies until the outer synchronous result or native Promise settles. */
export function withInvocationReadObservation<T>(callback: () => T): T {
    if (activeObservation()) return callback();
    const observation: InvocationReadObservation = {
        dependencies: new Map(), memoized: new Map(), failure: null, validating: false, closed: false
    };
    return invocationReadObservations.run(observation, () => {
        try {
            const result = callback();
            // Native Promise detection does not read a synchronous result's then getter or proxy traps.
            if (types.isPromise(result)) {
                return Promise.prototype.then.call(result,
                    (value: unknown) => {
                        try {
                            assertObservationCurrent(observation);
                            return value;
                        } finally {
                            closeObservation(observation);
                        }
                    },
                    (error: unknown) => {
                        closeObservation(observation);
                        throw error;
                    }
                ) as T;
            }
            try {
                assertObservationCurrent(observation);
                return result;
            } finally {
                closeObservation(observation);
            }
        } catch (error: unknown) {
            closeObservation(observation);
            throw error;
        }
    });
}
