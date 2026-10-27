import { countNextStepWork } from './next-step-measurement';
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
    readonly parent?: InvocationReadObservation;
    readonly publications: Set<{ publish(): void; dispose(): void }>;
    readonly dependencies: Map<object, () => void>;
    readonly memoized: Map<symbol, Map<string, InvocationReadMemoEntry>>;
    readonly immutableLeafKeys: Set<symbol>;
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
    for (const publication of observation.publications) {
        countNextStepWork('visit:q4_publication_dispose');
        try { publication.dispose(); } catch { /* Optional state cannot replace the native outcome. */ }
    }
    observation.publications.clear();
    observation.dependencies.clear();
    observation.memoized.clear();
    observation.immutableLeafKeys.clear();
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
        publications: new Set(), dependencies: new Map(), memoized: new Map(), immutableLeafKeys: new Set(), failure: null, validating: false, closed: false
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
                            publishObservation(observation);
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
                publishObservation(observation);
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

/** Q4-only tentative reads. A rejected candidate cannot poison the parent decision. */
export function probeOptionalInvocationReads<T>(read: () => T): { value: T; validate(): boolean; select(): void; discard(): void } | null {
    const parent = activeObservation();
    if (!parent) return null;
    const child: InvocationReadObservation = { parent, publications: new Set(), dependencies: new Map(), memoized: new Map(), immutableLeafKeys: new Set(), failure: null,
        validating: false, closed: false };
    let value: T;
    try {
        value = invocationReadObservations.run(child, () => {
            const value = read();
            if (types.isPromise(value)) throw new Error('Optional derivation probes are synchronous.');
            assertObservationCurrent(child);
            return value;
        });
    } catch { closeObservation(child); return null; }
    let settled = false;
    return { value,
        validate() {
            if (settled) return false;
            try { invocationReadObservations.run(child, () => assertObservationCurrent(child)); return true; }
            catch { return false; }
        },
        select() {
            if (settled || activeObservation() !== parent) throw new Error('Optional dependency promotion is out of scope.');
            settled = true;
            try {
                // Promotion is irrevocable. Changes after this point reject, never fall back.
                for (const [owner, validate] of child.dependencies) {
                    countNextStepWork('visit:q4_promoted_dependency');
                    if (!parent.dependencies.has(owner)) parent.dependencies.set(owner, validate);
                }
                // Share only immutable observations explicitly marked by native leaf owners.
                // All existing child, selection, parent and final validations remain in place.
                for (const token of child.immutableLeafKeys) {
                    const entries = child.memoized.get(token);
                    if (!entries) continue;
                    let destination = parent.memoized.get(token);
                    if (!destination) { destination = new Map(); parent.memoized.set(token, destination); }
                    for (const [id, entry] of entries) if (!destination.has(id)) destination.set(id, entry);
                    if (parent.parent) parent.immutableLeafKeys.add(token);
                }
            } finally { closeObservation(child); }
            assertObservationCurrent(parent);
        },
        discard() { if (!settled) { settled = true; closeObservation(child); } }
    };
}
/** Storage publication is an explicit post-check native effect, never an observed derivation. */
export function outsideInvocationReadObservation<T>(publish: () => T): T {
    return invocationReadObservations.exit(publish);
}

/** Only immutable Q2 leaf owners call this; no builder, external truth flag or publication capability. */
export function inheritParentInvocationLeafMemo<T>(key: InvocationReadMemoKey<T>, memoId: string): void {
    const child = activeObservation();
    if (!child?.parent) return;
    child.immutableLeafKeys.add(key.token);
    if (child.memoized.get(key.token)?.has(memoId)) return;
    const previous = child.parent.memoized.get(key.token)?.get(memoId);
    if (!previous) return;
    let target = child.memoized.get(key.token);
    if (!target) { target = new Map(); child.memoized.set(key.token, target); }
    target.set(memoId, previous); // Immutable observation/result/error plus its complete recorder trace.
}

/** Scheduling never grants eligibility: the store independently checks both private seals. */
export function enqueueInvocationOptionalPublication(publish: () => void, dispose: () => void): boolean {
    const observation = activeObservation();
    if (!observation || observation.parent || observation.validating) return false;
    observation.publications.add({ publish, dispose }); return true;
}
function publishObservation(observation: InvocationReadObservation): void {
    // Called only after the successful outermost final A1 check, before returning output.
    for (const publication of observation.publications) {
        countNextStepWork('visit:q4_publication');
        try { invocationReadObservations.exit(() => publication.publish()); }
        catch { countNextStepWork('q4_publish_unavailable'); }
    }
}
