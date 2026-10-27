import { inheritParentInvocationLeafMemo } from './invocation-read-observation';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { observeDerivationInput, fingerprintObservationData, markDerivationNonCacheable } from './derivation-observation-recorder';
import { countNextStepWork } from './next-step-measurement';
import { observedInvocationValue, readInvocationPathObservation, type InvocationObservedValue } from './invocation-file-observation';
import { createInvocationReadMemoKey, isInvocationReadObservationActive, memoizeInvocationRead, registerInvocationDependency } from './invocation-read-observation';

const NATIVE_REALPATH_OBSERVATIONS = createInvocationReadMemoKey<InvocationObservedValue<string>>('native-realpath-containment');

function captureNativeRealpath(pathValue: string): InvocationObservedValue<string> {
    try { return Object.freeze({ value: fs.realpathSync.native(pathValue) }); }
    catch (error: unknown) { return Object.freeze({ error }); }
}

function nativeRealpathErrorCode(error: unknown): string {
    return String((error as NodeJS.ErrnoException)?.code || error);
}

/** Native realpath has its own result and error semantics; never substitute Q2's JS realpath. */
export function readNativeRealpath(pathValue: string): string {
    if (!isInvocationReadObservationActive()) return fs.realpathSync.native(pathValue);
    const resolved = path.resolve(pathValue);
    inheritParentInvocationLeafMemo(NATIVE_REALPATH_OBSERVATIONS, resolved);
    const observation = memoizeInvocationRead(NATIVE_REALPATH_OBSERVATIONS, resolved, () => {
        readInvocationPathObservation(resolved);
        countNextStepWork('native_realpath_observation:' + resolved);
        const original = observeDerivationInput('native-realpath', 1, { path: resolved },
            () => captureNativeRealpath(pathValue), result => {
                if ('value' in result) return fingerprintObservationData({ value: result.value });
                const code = result.error && typeof result.error === 'object'
                    ? Object.getOwnPropertyDescriptor(result.error, 'code') : null;
                if (!code || !('value' in code) || typeof code.value !== 'string') {
                    markDerivationNonCacheable('opaque-native-realpath-error');
                    return fingerprintObservationData({ error: null });
                }
                return fingerprintObservationData({ error: code.value });
            });
        registerInvocationDependency(original, () => {
            countNextStepWork('native_realpath_final_validation:' + resolved);
            const current = captureNativeRealpath(pathValue);
            const unchanged = 'error' in original || 'error' in current
                ? 'error' in original && 'error' in current
                    && nativeRealpathErrorCode(original.error) === nativeRealpathErrorCode(current.error)
                : original.value === current.value;
            if (!unchanged) throw new Error('Invocation native realpath changed: ' + resolved);
        });
        return original;
    }).value;
    return observedInvocationValue(observation);
}


export interface RealpathContainmentOptions {
    allowMissing?: boolean;
}

export function getPathModule(platform: string = process.platform): typeof path.win32 | typeof path.posix {
    return platform === 'win32' ? path.win32 : path.posix;
}

export function normalizeRelativePath(value: string): string {
    return String(value).trim().replace(/[\\/]+/g, '/').replace(/^\.\//, '');
}

function normalizeComparisonPath(value: string, platform: string, includeTrailingSeparator: boolean = false): string {
    const pathModule = getPathModule(platform);
    let normalized = pathModule.normalize(pathModule.resolve(String(value)));
    if (includeTrailingSeparator && !normalized.endsWith(pathModule.sep)) {
        normalized += pathModule.sep;
    }

    return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathEntryExists(pathValue: string): boolean {
    try {
        const observation = readInvocationPathObservation(pathValue);
        if (observation) observedInvocationValue(observation.stat);
        else fs.lstatSync(pathValue);
        return true;
    } catch (error: unknown) {
        const errorCode = String((error as NodeJS.ErrnoException)?.code || '');
        return errorCode !== 'ENOENT' && errorCode !== 'ENOTDIR';
    }
}

export function isPathInsideRoot(rootPath: string, candidatePath: string, platform: string = process.platform): boolean {
    const pathModule = getPathModule(platform);
    const resolvedRoot = pathModule.resolve(String(rootPath));
    const resolvedCandidate = pathModule.resolve(String(candidatePath));
    const comparableRoot = normalizeComparisonPath(resolvedRoot, platform, true);
    const comparableCandidate = normalizeComparisonPath(resolvedCandidate, platform, false);

    return comparableCandidate === comparableRoot.slice(0, -1) || comparableCandidate.startsWith(comparableRoot);
}

export function isPathRealpathInsideRoot(
    rootPath: string,
    candidatePath: string,
    options: RealpathContainmentOptions = {}
): boolean {
    const resolvedRoot = path.resolve(rootPath);
    const resolvedCandidate = path.resolve(candidatePath);
    if (!isPathInsideRoot(resolvedRoot, resolvedCandidate)) {
        return false;
    }
    if (!pathEntryExists(resolvedRoot)) {
        return options.allowMissing === true && !pathEntryExists(resolvedCandidate);
    }

    let rootRealPath: string;
    try {
        rootRealPath = readNativeRealpath(resolvedRoot);
    } catch {
        return false;
    }

    let existingAncestor = resolvedCandidate;
    while (!pathEntryExists(existingAncestor)) {
        if (options.allowMissing !== true) {
            return false;
        }
        if (path.resolve(existingAncestor) === resolvedRoot) {
            return true;
        }
        const parentPath = path.dirname(existingAncestor);
        if (parentPath === existingAncestor) {
            return false;
        }
        existingAncestor = parentPath;
    }

    try {
        return isPathInsideRoot(rootRealPath, readNativeRealpath(existingAncestor));
    } catch {
        return false;
    }
}

export function resolvePathInsideRoot(rootPath: string, candidatePath: string, platform: string = process.platform): string {
    const pathModule = getPathModule(platform);
    const resolvedCandidate = pathModule.resolve(String(rootPath), String(candidatePath));

    if (!isPathInsideRoot(rootPath, resolvedCandidate, platform)) {
        throw new Error(`Resolved path escapes root '${rootPath}': ${candidatePath}`);
    }
    if (platform === process.platform && !isPathRealpathInsideRoot(rootPath, resolvedCandidate, { allowMissing: true })) {
        throw new Error(`Resolved path escapes root through a filesystem link '${rootPath}': ${candidatePath}`);
    }

    return resolvedCandidate;
}
