import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { cloneFrozenJson } from './immutable-json';
import { countNextStepWork, describeProcessInputs } from './next-step-measurement';
import { reduceClosedQualityAnalysis, type ClosedQualityEvidence } from './closed-quality-analysis';
import type { InvocationReadMemoKey } from './invocation-read-observation';

export interface RecordedObservation {
    readonly kind: string;
    readonly version: number;
    readonly input: Readonly<Record<string, unknown>>;
    readonly inputKey: string;
    readonly fingerprint: string;
}
export interface ObservationTrace {
    readonly observations: readonly RecordedObservation[];
    readonly nonCacheableReasons: readonly string[];
}
export type ObservationOutcome<T> = { readonly returned: true; readonly value: T }
    | { readonly returned: false; readonly error: unknown };
export interface ObservationCapture<T> {
    readonly outcome: ObservationOutcome<T>;
    readonly trace: ObservationTrace;
    readonly cacheable: boolean;
}
interface Frame {
    readonly records: Map<string, RecordedObservation>;
    readonly reasons: Set<string>;
    readonly assertRecorded: boolean;
    closed: boolean;
}
const frames = new AsyncLocalStorage<readonly Frame[]>();
const nativePermit = new AsyncLocalStorage<boolean>();
const replayers = new WeakMap<RecordedObservation, () => string>();
const publishableCaptures = new WeakSet<object>();
const closedPlanBindings = new WeakMap<object, ClosedObservationPlan>();
const kinds = new Set(['file-bytes', 'path-state', 'path-absence', 'native-realpath',
    'process-result', 'acl-verdict', 'directory-enumeration', 'timeline-query', 'workspace-auth', 'code-closure', 'process-query']);
const guardInstallFailures = new Set<string>();
let guardInstalled = false;

export class UnrecordedDerivationIoError extends Error {
    constructor(readonly operation: string) { super('Unrecorded derivation I/O: ' + operation); }
}
export function markDerivationNonCacheable(reason: string): void {
    for (const frame of frames.getStore() || []) {
        countNextStepWork('visit:derivation_reason_frame');
        if (!frame.closed) frame.reasons.add(reason);
    }
}
function nativeAccess(operation: string): void {
    if (nativePermit.getStore()) return;
    const active = (frames.getStore() || []).filter(frame => {
        countNextStepWork('visit:derivation_guard_frame');
        return !frame.closed;
    });
    if (!active.length) return;
    markDerivationNonCacheable('unrecorded:' + operation);
    if (active.some(frame => frame.assertRecorded)) throw new UnrecordedDerivationIoError(operation);
}

/** Install before application imports capture native aliases. Unknown callback closures still never publish. */
export function installDerivationIoGuard(): void {
    if (guardInstalled) return;
    guardInstalled = true;
    const wrap = (owner: object, name: string, label: string): void => {
        const descriptor = Object.getOwnPropertyDescriptor(owner, name);
        if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return;
        const original = descriptor.value as (...args: unknown[]) => unknown;
        const wrapped = function (this: unknown, ...args: unknown[]): unknown {
            nativeAccess(label);
            return Reflect.apply(original, this, args);
        };
        // Preserve realpathSync.native without invoking an accessor or touching call arguments.
        const native = Object.getOwnPropertyDescriptor(original, 'native');
        if (native) Object.defineProperty(wrapped, 'native', native);
        try { Object.defineProperty(owner, name, { ...descriptor, value: wrapped }); }
        catch { guardInstallFailures.add(label); }
        if (native) wrap(wrapped, 'native', label + '.native');
    };
    const fs = require('node:fs') as Record<string, unknown>;
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(fs))) {
        if ('value' in descriptor && typeof descriptor.value === 'function'
            && (name.endsWith('Sync') || ['watch', 'watchFile', 'createReadStream', 'createWriteStream'].includes(name)))
            wrap(fs, name, 'fs.' + name);
    }
    const directory = Object.getOwnPropertyDescriptor(fs, 'Dir')?.value as { prototype?: object } | undefined;
    if (directory?.prototype) for (const name of ['readSync', 'closeSync']) wrap(directory.prototype, name, 'fs.Dir.' + name);
    const childProcess = require('node:child_process') as object;
    for (const name of ['execSync', 'execFileSync', 'spawnSync', 'exec', 'execFile', 'spawn', 'fork'])
        wrap(childProcess, name, 'child_process.' + name);
}

function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function stableDescription(value: unknown): string | null {
    const result = describeProcessInputs(value, kind => countNextStepWork('visit:derivation_descriptor_' + kind));
    return result.opaque ? null : result.text;
}
export function fingerprintObservationData(value: unknown): string {
    const described = stableDescription(value);
    if (described === null) throw new Error('Opaque observation data cannot be fingerprinted.');
    return digest(described);
}
function failureFingerprint(error: unknown): string | null {
    if (error === null || typeof error !== 'object') {
        const text = stableDescription(error);
        return text === null ? null : digest('threw:' + text);
    }
    if (types.isProxy(error)) return null;
    const values: Record<string, unknown> = {};
    for (const name of Object.getOwnPropertyNames(error)) {
        countNextStepWork('visit:derivation_error_field');
        if (name === 'stack') continue;
        const descriptor = Object.getOwnPropertyDescriptor(error, name)!;
        if (!('value' in descriptor)) return null;
        const value: unknown = descriptor.value;
        values[name] = Buffer.isBuffer(value) ? { bytes: value.toString('base64') } : value;
    }
    const text = stableDescription(values);
    return text === null ? null : digest('threw:' + text);
}
function record(observation: RecordedObservation): void {
    const key = observation.kind + ':' + observation.version + ':' + observation.inputKey;
    for (const frame of frames.getStore() || []) {
        countNextStepWork('visit:derivation_record_frame');
        if (frame.closed) continue;
        const previous = frame.records.get(key);
        if (previous && previous.fingerprint !== observation.fingerprint) frame.reasons.add('conflicting-observation:' + key);
        else frame.records.set(key, observation);
    }
}

/** Trusted observation adapters only. Never wrap an entire arbitrary derivation in this native permit. */
export function observeDerivationInput<T>(
    kind: string, version: number, input: Record<string, unknown>, capture: () => T, fingerprint: (value: T) => string,
    replay: () => T = capture
): T {
    const inputKey = stableDescription(input);
    const recognized = kinds.has(kind) && version === 1;
    if (!recognized) markDerivationNonCacheable('unknown-observation:' + kind + ':' + version);
    if (inputKey === null) markDerivationNonCacheable('opaque-observation-input:' + kind);
    const frozenInput = inputKey === null ? null : cloneFrozenJson(input);
    let outcome: ObservationOutcome<T>;
    try { outcome = { returned: true, value: nativePermit.run(true, capture) }; }
    catch (error: unknown) { outcome = { returned: false, error }; }
    let observedFingerprint: string | null = null;
    try { observedFingerprint = outcome.returned ? 'returned:' + fingerprint(outcome.value) : failureFingerprint(outcome.error); }
    catch { markDerivationNonCacheable('opaque-observation-output:' + kind); }
    if (observedFingerprint === null) markDerivationNonCacheable('opaque-observation-output:' + kind);
    if (recognized && inputKey !== null && frozenInput && observedFingerprint !== null) {
        const observation = Object.freeze({ kind, version, input: frozenInput, inputKey, fingerprint: observedFingerprint });
        replayers.set(observation, () => {
            let replayed: ObservationOutcome<T>;
            try { replayed = { returned: true, value: nativePermit.run(true, replay) }; }
            catch (error: unknown) { replayed = { returned: false, error }; }
            const result = replayed.returned ? 'returned:' + fingerprint(replayed.value) : failureFingerprint(replayed.error);
            if (result === null) throw new Error('Observation replay returned opaque evidence.');
            return result;
        });
        record(observation);
    }
    if (!outcome.returned) throw outcome.error;
    return outcome.value;
}

export function replayInvocationMemoTrace(trace: ObservationTrace): void {
    for (const reason of trace.nonCacheableReasons) {
        countNextStepWork('visit:derivation_trace_reason');
        markDerivationNonCacheable(reason);
    }
    for (const observation of trace.observations) {
        countNextStepWork('visit:derivation_trace_observation');
        record(observation);
    }
}
/** Memo traces are not publishable captures; a sealed root must still own the complete call closure. */
export function captureInvocationMemoTrace<T>(callback: () => T): { outcome: ObservationOutcome<T>; trace: ObservationTrace } {
    return captureTrace(callback, false);
}
function captureTrace<T>(callback: () => T, assertRecorded: boolean): { outcome: ObservationOutcome<T>; trace: ObservationTrace } {
    installDerivationIoGuard();
    const frame: Frame = { records: new Map(), reasons: new Set(), assertRecorded, closed: false };
    for (const failure of guardInstallFailures) frame.reasons.add('guard-install-failed:' + failure);
    return frames.run([...(frames.getStore() || []), frame], () => {
        let outcome: ObservationOutcome<T>;
        try { outcome = { returned: true, value: callback() }; }
        catch (error: unknown) { outcome = { returned: false, error }; }
        if (outcome.returned && types.isPromise(outcome.value)) markDerivationNonCacheable('asynchronous-result');
        frame.closed = true;
        return { outcome, trace: Object.freeze({ observations: Object.freeze(Array.from(frame.records.values(), value => {
            countNextStepWork('visit:derivation_trace_copy_observation'); return value;
        })), nonCacheableReasons: Object.freeze(Array.from(frame.reasons, value => {
            countNextStepWork('visit:derivation_trace_copy_reason'); return value;
        })) }) };
    });
}

/** Arbitrary callbacks run once, but cannot prove absence of pre-captured aliases/native extensions. */
export function captureDerivationObservations<T>(callback: () => T, options: { assertRecorded?: boolean } = {}): ObservationCapture<T> {
    const captured = captureTrace(() => {
        markDerivationNonCacheable('unsealed-call-closure');
        return callback();
    }, options.assertRecorded === true);
    let outcome = captured.outcome;
    if (options.assertRecorded && outcome.returned && captured.trace.nonCacheableReasons.length)
        outcome = { returned: false, error: new UnrecordedDerivationIoError(captured.trace.nonCacheableReasons.join(', ')) };
    return Object.freeze({ ...captured, outcome, cacheable: false });
}
export function unwrapObservationCapture<T>(capture: ObservationCapture<T>): T {
    if (!capture.outcome.returned) throw capture.outcome.error;
    return capture.outcome.value;
}
export function replayDerivationObservations(trace: ObservationTrace): boolean {
    if (trace.nonCacheableReasons.length) return false;
    try {
        for (const observation of trace.observations) {
            countNextStepWork('visit:derivation_replay_observation');
            if (!kinds.has(observation.kind) || observation.version !== 1) return false;
            const replay = replayers.get(observation);
            if (!replay || replay() !== observation.fingerprint) return false;
        }
        return true;
    } catch { return false; }
}
export function isPublishableObservationCapture(capture: unknown): boolean {
    return capture !== null && typeof capture === 'object' && publishableCaptures.has(capture);
}

// Closed operation plans are implemented below. They receive validated data, never callbacks.
export type ClosedObservationPlan = { readonly operation: 'json-parse'; readonly text: string }
    | { readonly operation: 'copy-json'; readonly value: unknown }
    | { readonly operation: 'quality-artifact-json'; readonly path: string; readonly text: string; readonly sha256: string }
    | { readonly operation: 'quality-analysis'; readonly evidence: ClosedQualityEvidence; readonly requireObservedExecution: boolean };

let closedPlanMemo: InvocationReadMemoKey<unknown> | undefined;

function runClosedPlan(input: ClosedObservationPlan, key: string,
    registry: typeof import('./invocation-read-observation'),
    files: typeof import('./invocation-file-observation')): unknown {
    if (input.operation === 'quality-artifact-json') {
        const bytes = files.readInvocationFileContent(input.path);
        if (!bytes) markDerivationNonCacheable('quality-json-outside-observation');
        else if (bytes.sha256 !== input.sha256) throw new Error('Quality JSON bytes differ from the captured artifact.');
        // Keep the legacy unbounded parse contract. The supplied text was obtained by
        // the original reader; files over the retained limit are not reread or rejected.
        if (bytes && bytes.size > 128 * 1024 * 1024) markDerivationNonCacheable('quality-json-unretained-bytes');
    }
    closedPlanMemo ??= registry.createInvocationReadMemoKey<unknown>('closed-observation-plan-v1');
    return registry.memoizeInvocationRead(closedPlanMemo, key, () => {
        if (input.operation === 'json-parse' || input.operation === 'quality-artifact-json') {
            countNextStepWork('derive:closed_quality_json_parse');
            return cloneFrozenJson(JSON.parse(input.text) as unknown);
        }
        if (input.operation === 'copy-json') return cloneFrozenJson(input.value);
        if (input.operation === 'quality-analysis') return cloneFrozenJson(
            reduceClosedQualityAnalysis(input.evidence, input.requireObservedExecution));
        throw new Error('Unknown closed observation plan.');
    }).value;
}

/** Minimal sealed pure-data nodes. Further nodes need module-owned implementations, not a trust flag. */
export function executeClosedObservationPlan(plan: ClosedObservationPlan): ObservationCapture<unknown> {
    const description = stableDescription(plan);
    if (description === null) return Object.freeze({ cacheable: false,
        outcome: { returned: false as const, error: new Error('Closed observation plans require data-only inputs.') },
        trace: { observations: [], nonCacheableReasons: ['opaque-plan'] } });
    const input = cloneFrozenJson(plan);
    // Resolve only these fixed code modules before entering the closed operation;
    // the first require may perform loader I/O. Neither path comes from input.
    const registry = require('./invocation-read-observation') as typeof import('./invocation-read-observation');
    const files = require('./invocation-file-observation') as typeof import('./invocation-file-observation');
    const captured = captureTrace(() => runClosedPlan(input, description, registry, files), true);
    const cacheable = captured.outcome.returned && captured.trace.nonCacheableReasons.length === 0;
    const outcome = captured.outcome.returned
        ? Object.freeze({ returned: true as const, value: cloneFrozenJson(captured.outcome.value) })
        : Object.freeze(captured.outcome);
    const result = Object.freeze({ ...captured, outcome, cacheable });
    if (cacheable) { publishableCaptures.add(result); closedPlanBindings.set(result, input); }
    return result;
}

// Persistent wrappers make late recorder entry unable to hide ordinary module-property calls.
// Pre-install aliases and unsupported callback closures still fail the publication seal above.
installDerivationIoGuard();

/** Read-only identity from the actual sealed execution; decoded/copied captures cannot forge it. */
export function readSealedObservationPlan(capture: unknown): ClosedObservationPlan | null {
    return capture !== null && typeof capture === 'object' ? closedPlanBindings.get(capture) ?? null : null;
}

/** Deterministic loader edges for the fixed operations, before a cross-process code identity is captured. */
export function prepareClosedObservationPlanModules(): void {
    require('./invocation-read-observation');
    require('./invocation-file-observation');
}
