import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { types } from 'node:util';

export interface NextStepMeasurement {
    phases_ms: Record<string, number>;
    work: Record<string, number>;
}
let active: NextStepMeasurement | null = null;

export function countNextStepWork(name: string): void {
    if (active) active.work[name] = (active.work[name] || 0) + 1;
}

export function measureNextStepPhase<T>(name: string, action: () => T): T {
    if (!active) return action();
    const measurement = active;
    const started = performance.now();
    countNextStepWork(name);
    try { return action(); } finally {
        measurement.phases_ms[name] = (measurement.phases_ms[name] || 0) + performance.now() - started;
    }
}

// Serialize data descriptors only. Diagnostics must not execute caller-controlled
// getters, proxy traps or toJSON hooks. Opaque metadata is never evidence of equality.
function describeProcessInputs(inputs: unknown): { text: string; opaque: boolean } {
    let opaque = false, remaining = 10_000;
    const ancestors = new Set<object>();
    const unknown = () => { opaque = true; return 'opaque'; };
    const encode = (value: unknown, depth: number): string => {
        if (depth > 32 || --remaining < 0) return unknown();
        if (value === null) return 'null';
        if (typeof value === 'string') return JSON.stringify(value);
        if (typeof value === 'number') return Object.is(value, -0) ? 'number:-0' : 'number:' + String(value);
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        if (typeof value === 'undefined') return 'undefined';
        if (typeof value === 'bigint') return 'bigint:' + value.toString();
        if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) return unknown();
        const prototype = Object.getPrototypeOf(value);
        // process.env has a Node-owned prototype. Its own descriptors contain its values.
        if (value !== process.env && prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
            return unknown();
        if (Object.getOwnPropertySymbols(value).length > 0) opaque = true;
        ancestors.add(value);
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const fields = Object.keys(descriptors).map(key => {
            const descriptor = descriptors[key];
            return JSON.stringify(key) + ':enumerable=' + String(descriptor.enumerable) + ':'
                + ('value' in descriptor ? encode(descriptor.value, depth + 1) : unknown());
        });
        ancestors.delete(value);
        return (Array.isArray(value) ? 'array:' : 'object:') + '{' + fields.join(',') + '}';
    };
    const text = encode(inputs, 0);
    return { text, opaque };
}

// Capture the synchronous Node boundary, including callers that bypass our Git helper.
// Navigation is synchronous; restore every function before returning or throwing.
function captureProcessWork(): () => void {
    type ProcessApi = Record<string, (...args: unknown[]) => unknown>;
    // The CommonJS builtin object is mutable; TS namespace views themselves are not.
    const native = require('node:child_process') as ProcessApi;
    const originals = new Map<string, (...args: unknown[]) => unknown>();
    const restore = () => {
        for (const [name, original] of originals) {
            try { native[name] = original; } catch { countNextStepWork('process_measurement_unavailable'); }
        }
    };
    try {
        for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
            const original = native[name]; originals.set(name, original);
            native[name] = function (this: unknown, ...args: unknown[]): unknown {
                try {
                    const metadata = describeProcessInputs({ args, cwd: process.cwd(), environment: process.env });
                    const digest = createHash('sha256').update(metadata.text).digest('hex');
                    const command = typeof args[0] === 'string' ? path.basename(args[0]).toLowerCase() : 'opaque-command';
                    if (metadata.opaque) {
                        countNextStepWork('process_metadata_opaque');
                        // Do not merge unknown inputs into a false identical-command bucket.
                        countNextStepWork('process:' + name + ':' + command + ':opaque:' + active?.work.process_metadata_opaque);
                    } else {
                        countNextStepWork('process:' + name + ':' + command + ':' + digest);
                    }
                } catch { countNextStepWork('process_measurement_unavailable'); }
                return Reflect.apply(original, this, args);
            };
        }
    } catch { restore(); countNextStepWork('process_measurement_unavailable'); }
    return restore;
}

export function withNextStepMeasurement<T>(action: () => T, receive?: (value: NextStepMeasurement) => void): T {
    if (active || (!receive && process.env.GARDA_NEXT_STEP_TIMING !== '1')) return action();
    const measurement: NextStepMeasurement = { phases_ms: {}, work: {} };
    active = measurement;
    const restoreProcessWork = captureProcessWork();
    try { return measureNextStepPhase('total', action); } finally {
        restoreProcessWork();
        active = null;
        // Diagnostics must never change a navigation result or mask its original exception.
        try {
            receive?.(measurement);
            if (process.env.GARDA_NEXT_STEP_TIMING === '1') {
                process.stderr.write('GARDA_NEXT_STEP_TIMING ' + JSON.stringify(measurement) + '\n');
            }
        } catch { /* Optional diagnostics are best effort. */ }
    }
}
