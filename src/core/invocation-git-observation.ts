import * as path from 'node:path';
import { types } from 'node:util';
import { createInvocationReadMemoKey, isInvocationReadObservationActive, memoizeInvocationRead, registerInvocationDependency } from './invocation-read-observation';
import { describeProcessInputs } from './next-step-measurement';
import { observeDerivationInput, fingerprintObservationData } from './derivation-observation-recorder';

type NativeExec = (this: unknown, ...args: unknown[]) => unknown;
type GitValue = string | Buffer | import('node:child_process').SpawnSyncReturns<string | Buffer>;
type GitObservation = { value: GitValue; fingerprint: string } | { error: unknown; failure: string };
const GIT_RESULTS = createInvocationReadMemoKey<GitObservation>('git-command-results');
const READ_COMMANDS = new Set(['rev-parse', 'diff', 'ls-files', 'ls-tree', 'status', 'check-ignore', 'cat-file', 'merge-base', 'log', 'show', 'for-each-ref', 'rev-list']);
const READ_GLOBAL_FLAGS = new Set(['--no-optional-locks', '--no-pager', '--no-replace-objects', '--literal-pathspecs']);
const CONFIG_READ_ACTIONS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l']);
const CONFIG_READ_FLAGS = new Set(['--null', '-z', '--name-only', '--show-origin', '--show-scope', '--includes',
    '--no-includes', '--local', '--global', '--system', '--worktree', '--fixed-value']);
let installed = false;

function readonlyConfigQuery(args: string[]): boolean {
    let actions = 0;
    for (let index = 0; index < args.length; index++) {
        const value = args[index];
        if (CONFIG_READ_ACTIONS.has(value)) { actions++; continue; }
        if (CONFIG_READ_FLAGS.has(value) || value.startsWith('--type=')) continue;
        if (['--file', '-f', '--blob', '--default', '--type'].includes(value)) {
            if (++index >= args.length) return false;
            continue;
        }
        // Unknown option/action forms keep their native path, including every write form.
        if (value.startsWith('-')) return false;
    }
    return actions === 1;
}

function readonlyRefQuery(command: string, args: string[]): boolean {
    const allowed = command === 'symbolic-ref'
        ? new Set(['--quiet', '-q', '--short', '--no-recurse'])
        : new Set(['--verify', '--quiet', '-q']);
    return args.filter(value => !value.startsWith('-')).length === 1
        && args.every(value => !value.startsWith('-') || allowed.has(value));
}

function readonlyGitCommand(args: unknown[]): boolean {
    if (typeof args[0] !== 'string' || !/^git(?:\.exe)?$/iu.test(path.basename(args[0]))) return false;
    if (!Array.isArray(args[1]) || types.isProxy(args[1])) return false;
    const descriptors = Object.getOwnPropertyDescriptors(args[1]);
    const argv: string[] = [];
    for (let i = 0; i < args[1].length; i++) {
        const entry = descriptors[String(i)];
        if (!entry || !('value' in entry) || typeof entry.value !== 'string') return false;
        argv.push(entry.value);
    }
    let index = 0;
    for (; index < argv.length; index++) {
        const value = argv[index];
        if (value === '-C' || value === '-c' || value === '--git-dir' || value === '--work-tree') { index++; continue; }
        if (READ_GLOBAL_FLAGS.has(value) || value.startsWith('--git-dir=') || value.startsWith('--work-tree=')) continue;
        break;
    }
    const command = argv[index], commandArgs = argv.slice(index + 1);
    if (command === 'config') return readonlyConfigQuery(commandArgs);
    if (command === 'symbolic-ref' || command === 'show-ref') return readonlyRefQuery(command, commandArgs);
    return READ_COMMANDS.has(command) && !commandArgs.some(value => value === '--output' || value.startsWith('--output=') || value === '--ext-diff');
}

function cloneData(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    // Called only after descriptor-only inspection proves the whole graph plain and accessor-free.
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (Array.isArray(value) && key === 'length') continue;
        Object.defineProperty(result, key, { ...descriptor, value: cloneData(descriptor.value) });
    }
    return result;
}

function failedResult(error: unknown): string | null {
    if (!error || typeof error !== 'object' || types.isProxy(error)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(error);
    const fields: unknown[] = [];
    for (const key of ['status', 'signal', 'code', 'stdout', 'stderr']) {
        const entry = descriptors[key];
        if (entry && !('value' in entry)) return null;
        const value: unknown = entry?.value;
        if (Buffer.isBuffer(value)) fields.push([key, value.toString('base64')]);
        else if (value === null || ['undefined', 'string', 'number'].includes(typeof value)) fields.push([key, value]);
        else return null;
    }
    return JSON.stringify(fields);
}

function cloneResult<T>(value: T, copies = new Map<object, unknown>()): T {
    if (value === null || typeof value !== 'object') return value;
    if (copies.has(value)) return copies.get(value) as T;
    if (Buffer.isBuffer(value)) { const copy = Buffer.from(value); copies.set(value, copy); return copy as T; }
    const copy: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value)) as object;
    copies.set(value, copy);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (Array.isArray(value) && key === 'length') continue;
        Object.defineProperty(copy, key, 'value' in descriptor ? { ...descriptor, value: cloneResult(descriptor.value, copies) } : descriptor);
    }
    return copy as T;
}

function resultFingerprint(value: unknown): string | null {
    if (typeof value === 'string') return 'text:' + value;
    if (Buffer.isBuffer(value)) return 'bytes:' + value.toString('base64');
    if (!value || typeof value !== 'object' || types.isProxy(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!['status', 'signal', 'output', 'stdout', 'stderr', 'pid'].every(key => descriptors[key] && 'value' in descriptors[key])) return null;
    const spawned = value as import('node:child_process').SpawnSyncReturns<string | Buffer>;
    if (!Array.isArray(spawned.output) || types.isProxy(spawned.output)) return null;
    const output = spawned.output.map(entry => entry === null ? null : resultFingerprint(entry));
    const errorDescriptor = descriptors.error;
    if (errorDescriptor && !('value' in errorDescriptor)) return null;
    const failure = spawned.error ? failedResult(spawned.error) : null;
    if (spawned.error && failure === null) return null;
    // PID identifies the observed process; freshness is its command result (status, signals and every output stream).
    return JSON.stringify([spawned.status, spawned.signal, output, resultFingerprint(spawned.stdout), resultFingerprint(spawned.stderr), failure]);
}

function capture(read: () => unknown): GitObservation | null {
    try {
        const value = read();
        const fingerprint = resultFingerprint(value);
        return fingerprint === null ? null : { value: cloneResult(value as GitValue), fingerprint };
    } catch (error: unknown) {
        const failure = failedResult(error);
        if (failure === null) throw error;
        return { error, failure };
    }
}

function sameResult(left: GitObservation, right: GitObservation | null): boolean {
    if (!right) return false;
    if ('error' in left || 'error' in right) return 'error' in left && 'error' in right && left.failure === right.failure;
    return left.fingerprint === right.fingerprint;
}

/** Only the synchronous, read-only navigator installs this boundary. Action gates retain live Git reads. */
export function withInvocationGitReadObservation<T>(callback: () => T): T {
    if (installed) return callback();
    const native = require('node:child_process') as Record<string, NativeExec>;
    const originals = new Map<string, NativeExec>();
    installed = true;
    try {
        for (const name of ['execFileSync', 'spawnSync']) {
            const original = native[name]; originals.set(name, original);
            native[name] = function (this: unknown, ...args: unknown[]): unknown {
                if (!isInvocationReadObservationActive()) return Reflect.apply(original, this, args);
                const input = describeProcessInputs({ name, args, cwd: process.cwd(), environment: process.env });
                if (input.opaque || !readonlyGitCommand(args)) return Reflect.apply(original, this, args);
                const self = this;
                const observation = memoizeInvocationRead(GIT_RESULTS, input.text, () => {
                    const savedArgs = cloneData(args) as unknown[];
                    const entry = observeDerivationInput('process-result', 1, { command: input.text },
                        () => capture(() => Reflect.apply(original, self, args)),
                        result => fingerprintObservationData(result === null ? null
                            : 'error' in result ? { failure: result.failure } : { output: result.fingerprint }),
                        () => {
                            const current = describeProcessInputs({ name, args: savedArgs, cwd: process.cwd(), environment: process.env });
                            if (current.opaque || current.text !== input.text) throw new Error('Recorded Git command inputs changed.');
                            return capture(() => Reflect.apply(original, self, savedArgs));
                        });
                    if (!entry) throw new Error('Git observation did not return a native command result.');
                    registerInvocationDependency(entry, () => {
                        const current = describeProcessInputs({ name, args: savedArgs, cwd: process.cwd(), environment: process.env });
                        if (current.opaque || current.text !== input.text || !sameResult(entry, capture(() => Reflect.apply(original, self, savedArgs)))) {
                            throw new Error('Invocation Git observation changed: ' + String(savedArgs[0]));
                        }
                    });
                    return entry;
                }).value;
                if ('error' in observation) throw cloneResult(observation.error);
                return cloneResult(observation.value);
            };
        }
        return callback();
    } finally {
        for (const [name, original] of originals) native[name] = original;
        installed = false;
    }
}
