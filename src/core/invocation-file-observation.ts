import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { lstatFileIdentitySync, statFileIdentitySync } from './file-stat';
import { countNextStepWork } from './next-step-measurement';
import {
    createInvocationReadMemoKey, isInvocationReadObservationActive,
    memoizeInvocationRead, registerInvocationDependency
} from './invocation-read-observation';


export type InvocationObservedValue<T> = { readonly value: T } | { readonly error: unknown };

export interface InvocationPathObservation {
    readonly path: string;
    readonly stat: InvocationObservedValue<fs.Stats>;
    readonly identity: InvocationObservedValue<fs.BigIntStats>;
    readonly realPath: InvocationObservedValue<string>;
    readonly linkTarget: InvocationObservedValue<string | null>;
    readonly targetStat: InvocationObservedValue<fs.Stats>;
    readonly completeTargetStat: InvocationObservedValue<fs.Stats>;
    readonly targetIdentity: InvocationObservedValue<fs.BigIntStats>;
}

export interface InvocationFileContent {
    readonly sha256: string;
    readonly size: number;
    readonly identity: fs.BigIntStats;
    /** Mutable bytes never escape the retained observation. */
    copyBytes(): Buffer;
}

const PATH_OBSERVATIONS = createInvocationReadMemoKey<InvocationPathObservation>('file-path-observations');
const FILE_CONTENTS = createInvocationReadMemoKey<InvocationFileContent>('file-content-observations');
const MAX_RETAINED_FILE_BYTES = 128 * 1024 * 1024;
const FILE_HASH_BUFFER_BYTES = 64 * 1024;

function attempt<T>(read: () => T): InvocationObservedValue<T> {
    try { return Object.freeze({ value: read() }); }
    catch (error: unknown) { return Object.freeze({ error }); }
}

export function observedInvocationValue<T>(result: InvocationObservedValue<T>): T {
    if ('error' in result) throw result.error;
    return result.value;
}

function errorCode(error: unknown): string {
    return error && typeof error === 'object' && 'code' in error
        ? String(error.code) : String(error);
}

function sameStat(left: fs.Stats | fs.BigIntStats, right: fs.Stats | fs.BigIntStats): boolean {
    if (left.dev !== right.dev || left.ino !== right.ino || left.mode !== right.mode
        || left.uid !== right.uid || left.gid !== right.gid || left.rdev !== right.rdev
        || left.birthtimeMs !== right.birthtimeMs) return false;
    if ('birthtimeNs' in left && 'birthtimeNs' in right && left.birthtimeNs !== right.birthtimeNs) return false;
    // Child writes do not replace the containing directory or its permissions.
    if (left.isDirectory() && right.isDirectory()) return true;
    if (left.nlink !== right.nlink || left.size !== right.size) return false;
    return 'mtimeNs' in left && 'mtimeNs' in right
        ? left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
        : left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameResult<T>(left: InvocationObservedValue<T>, right: InvocationObservedValue<T>, equal: (a: T, b: T) => boolean): boolean {
    if ('error' in left || 'error' in right) {
        return 'error' in left && 'error' in right && errorCode(left.error) === errorCode(right.error);
    }
    return equal(left.value, right.value);
}

function capturePath(filePath: string): InvocationPathObservation {
    const stat = attempt(() => Object.freeze(fs.lstatSync(filePath)));
    const identity = attempt(() => {
        observedInvocationValue(stat);
        return Object.freeze(lstatFileIdentitySync(filePath, { bigint: true }));
    });
    const realPath = attempt(() => {
        observedInvocationValue(stat);
        return fs.realpathSync(filePath);
    });
    const linkTarget = attempt(() => observedInvocationValue(stat).isSymbolicLink() ? fs.readlinkSync(filePath) : null);
    const targetStat = attempt(() => {
        observedInvocationValue(realPath);
        return Object.freeze(fs.statSync(filePath));
    });
    const completeTargetStat = attempt(() => {
        const target = observedInvocationValue(targetStat);
        return process.platform === 'win32' && target.dev === 0 && (target.isFile() || target.isDirectory())
            ? Object.freeze(statFileIdentitySync(filePath)) : target;
    });
    const targetIdentity = attempt(() => {
        observedInvocationValue(targetStat);
        return Object.freeze(statFileIdentitySync(filePath, { bigint: true }));
    });
    return Object.freeze({ path: filePath, stat, identity, realPath, linkTarget, targetStat, completeTargetStat, targetIdentity });
}

function assertPathCurrent(original: InvocationPathObservation): void {
    const current = capturePath(original.path);
    if (!sameResult(original.stat, current.stat, sameStat)
        || !sameResult(original.identity, current.identity, sameStat)
        || !sameResult(original.realPath, current.realPath, (a, b) => a === b)
        || !sameResult(original.linkTarget, current.linkTarget, (a, b) => a === b)
        || !sameResult(original.targetStat, current.targetStat, sameStat)
        || !sameResult(original.completeTargetStat, current.completeTargetStat, sameStat)
        || !sameResult(original.targetIdentity, current.targetIdentity, sameStat)) {
        throw new Error('Invocation file observation changed: ' + original.path);
    }
}

/** Observe every lexical alias and ancestor, even when content is shared by real path. */
export function readInvocationPathObservation(filePath: string): InvocationPathObservation | null {
    if (!isInvocationReadObservationActive()) return null;
    const absolute = path.resolve(filePath);
    return memoizeInvocationRead(PATH_OBSERVATIONS, absolute, () => {
        const parent = path.dirname(absolute);
        if (parent !== absolute) readInvocationPathObservation(parent);
        const observation = capturePath(absolute);
        registerInvocationDependency(observation, () => assertPathCurrent(observation));
        return observation;
    }).value;
}

function sameExpectedIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
        && left.nlink === right.nlink && left.size === right.size
        && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function invocationExpectedStatMatches(observation: InvocationPathObservation, expected: fs.Stats): boolean {
    const observed = observedInvocationValue(observation.targetStat);
    if (sameExpectedIdentity(expected, observed)) return true;
    return process.platform === 'win32' && observed.dev === 0 && expected.dev !== 0
        && sameExpectedIdentity(expected, observedInvocationValue(observation.completeTargetStat));
}

function captureContent(observation: InvocationPathObservation): InvocationFileContent {
    const filePath = observation.path;
    const before = observedInvocationValue(observation.targetIdentity);
    if (!before.isFile()) throw new Error('Invocation input is not a regular file: ' + filePath);
    const currentPath = statFileIdentitySync(filePath, { bigint: true });
    if (!sameStat(before, currentPath)) throw new Error('Invocation file changed before read: ' + filePath);
    const descriptor = fs.openSync(filePath, 'r');
    try {
        const descriptorBefore = fs.fstatSync(descriptor, { bigint: true });
        if (!descriptorBefore.isFile() || !sameStat(before, descriptorBefore)) {
            throw new Error('Invocation descriptor does not match observed file: ' + filePath);
        }
        const retained = before.size <= BigInt(MAX_RETAINED_FILE_BYTES) ? Buffer.allocUnsafe(Number(before.size)) : null;
        const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(FILE_HASH_BUFFER_BYTES);
        let total = 0n;
        while (true) {
            const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (count === 0) break;
            if (retained) {
                if (total + BigInt(count) > before.size) throw new Error('Invocation file grew during read: ' + filePath);
                buffer.copy(retained, Number(total), 0, count);
            }
            digest.update(buffer.subarray(0, count));
            total += BigInt(count);
        }
        const descriptorAfter = fs.fstatSync(descriptor, { bigint: true });
        const pathAfter = statFileIdentitySync(filePath, { bigint: true });
        if (total !== before.size || !sameStat(descriptorBefore, descriptorAfter) || !sameStat(descriptorAfter, pathAfter)) {
            throw new Error('Invocation file changed during read: ' + filePath);
        }
        assertPathCurrent(observation);
        countNextStepWork('file_hash:' + filePath);
        return Object.freeze({
            sha256: digest.digest('hex').toLowerCase(), size: Number(total), identity: before,
            copyBytes: () => {
                if (!retained) throw new Error('Invocation file exceeds the retained byte bound: ' + filePath);
                return Buffer.from(retained);
            }
        });
    } finally {
        try { fs.closeSync(descriptor); }
        catch { /* Hash descriptor cleanup retains the existing best-effort behavior. */ }
    }
}

/** The content observation is shared across every hash entrypoint and lexical alias. */
export function readInvocationFileContent(filePath: string, maximumBytes = Infinity): InvocationFileContent | null {
    const alias = readInvocationPathObservation(filePath);
    if (!alias) return null;
    const identity = observedInvocationValue(alias.targetIdentity);
    if (!identity.isFile() || Number(identity.size) > maximumBytes) {
        throw new Error('Invalid invocation input or byte bound: ' + alias.path);
    }
    const realPath = observedInvocationValue(alias.realPath);
    const canonical = readInvocationPathObservation(realPath)!;
    if (!sameStat(identity, observedInvocationValue(canonical.targetIdentity))) {
        throw new Error('Invocation alias does not match observed target: ' + alias.path);
    }
    const memoId = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
    const content = memoizeInvocationRead(FILE_CONTENTS, memoId, () => captureContent(canonical)).value;
    if (!sameStat(identity, content.identity)) {
        throw new Error('Invocation alias does not match retained content: ' + alias.path);
    }
    return content;
}
