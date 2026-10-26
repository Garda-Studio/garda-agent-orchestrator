import { createInvocationReadMemoKey, isInvocationReadObservationActive, memoizeInvocationRead, registerInvocationDependency } from '../../core/invocation-read-observation';
import { observedInvocationValue, readInvocationPathObservation } from '../../core/invocation-file-observation';

import { countNextStepWork } from '../../core/next-step-measurement';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { fileSha256, isPathInsideRoot, normalizePath, stringSha256 } from '../shared/helpers';

export type SafeWorktreePathStatus =
    | 'file'
    | 'directory'
    | 'special'
    | 'unreviewable'
    | 'symbolic_link'
    | 'unreviewable_symlink'
    | 'outside_repo'
    | 'missing';

export interface SafeWorktreePathState {
    status: SafeWorktreePathStatus;
    mode?: number;
    size?: number;
    sha256?: string | null;
    link_sha256?: string | null;
    link_target?: string | null;
    target_path?: string | null;
    target_status?: SafeWorktreePathStatus;
    target_mode?: number;
    target_size?: number;
    target_sha256?: string | null;
}

export interface SafeWorktreePathStateOptions {
    repoRealPath?: string;
    includeContentHashes?: boolean;
    distinguishAccessErrors?: boolean;
}

function resolveRepoRelativePath(repoRoot: string, relativeFile: string): string | null {
    const normalized = normalizePath(relativeFile);
    if (!normalized) {
        return null;
    }
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedPath = path.resolve(resolvedRoot, normalized);
    if (!isPathInsideRoot(resolvedPath, resolvedRoot)) {
        return null;
    }
    return resolvedPath;
}

function isMissingPathError(error: unknown): boolean {
    const errorCode = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
    return errorCode === 'ENOENT' || errorCode === 'ENOTDIR';
}

function samePathIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.nlink === right.nlink
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}

function symlinkStillMatches(
    linkPath: string,
    expectedStat: fs.Stats,
    expectedTarget: string,
    expectedRealPath: string
): boolean {
    try {
        const currentStat = fs.lstatSync(linkPath);
        return currentStat.isSymbolicLink()
            && samePathIdentity(expectedStat, currentStat)
            && fs.readlinkSync(linkPath) === expectedTarget
            && fs.realpathSync(linkPath) === expectedRealPath;
    } catch {
        return false;
    }
}

const SCOPE_PATH_OBSERVATIONS = createInvocationReadMemoKey<boolean>('scope-path-observation-acquisition');
const SCOPE_PATH_RESULTS = createInvocationReadMemoKey<Readonly<SafeWorktreePathState>>('scope-path-contract-results');
const SCOPE_LINK_CHECKS = createInvocationReadMemoKey<boolean>('scope-link-checks');
const SCOPE_DIRECTORY_PROJECTIONS = createInvocationReadMemoKey<boolean>('scope-directory-projections');

function scopePathStat(filePath: string): fs.Stats {
    const observation = readInvocationPathObservation(filePath);
    return observation ? observedInvocationValue(observation.stat) : fs.lstatSync(filePath);
}

function scopeTargetStat(filePath: string): fs.Stats {
    const observation = readInvocationPathObservation(filePath);
    return observation ? observedInvocationValue(observation.targetStat) : fs.statSync(filePath);
}

function scopeRealPath(filePath: string): string {
    const observation = readInvocationPathObservation(filePath);
    return observation ? observedInvocationValue(observation.realPath) : fs.realpathSync(filePath);
}

function scopeLinkTarget(filePath: string): string {
    const observation = readInvocationPathObservation(filePath);
    return observation ? observedInvocationValue(observation.linkTarget)! : fs.readlinkSync(filePath);
}

function observedSymlinkStillMatches(linkPath: string, stat: fs.Stats, target: string, realPath: string): boolean {
    return memoizeInvocationRead(SCOPE_LINK_CHECKS, path.resolve(linkPath),
        () => symlinkStillMatches(linkPath, stat, target, realPath)).value;
}

function retainDirectoryProjection(filePath: string, stat: fs.Stats, followLink = false): void {
    if (!isInvocationReadObservationActive() || !stat.isDirectory()) return;
    memoizeInvocationRead(SCOPE_DIRECTORY_PROJECTIONS, JSON.stringify([path.resolve(filePath), followLink]), () => {
        const owner = { mode: stat.mode, size: stat.size };
        registerInvocationDependency(owner, () => {
            const current = followLink ? fs.statSync(filePath) : fs.lstatSync(filePath);
            if (!current.isDirectory() || current.mode !== owner.mode || current.size !== owner.size) {
                throw new Error('Invocation directory projection changed: ' + filePath);
            }
        });

        return true;
    });
}

export function getSafeWorktreePathState(
    repoRoot: string,
    relativeFile: string,
    options: SafeWorktreePathStateOptions = {}
): SafeWorktreePathState {
    if (!isInvocationReadObservationActive()) return captureSafeWorktreePathState(repoRoot, relativeFile, options);
    const resolvedPath = resolveRepoRelativePath(repoRoot, relativeFile);
    const resolvedRoot = path.resolve(repoRoot);
    const observationKey = JSON.stringify([resolvedRoot, resolvedPath || relativeFile]);
    memoizeInvocationRead(SCOPE_PATH_OBSERVATIONS, observationKey, () => {
        readInvocationPathObservation(resolvedRoot);
        if (resolvedPath) readInvocationPathObservation(resolvedPath);
        countNextStepWork('scope_path_state:' + (resolvedPath || relativeFile));
        return true;
    });
    const contractKey = JSON.stringify([observationKey, options.repoRealPath || null,
        options.includeContentHashes !== false, options.distinguishAccessErrors === true]);
    const state = memoizeInvocationRead(SCOPE_PATH_RESULTS, contractKey, () =>
        Object.freeze(captureSafeWorktreePathState(repoRoot, relativeFile, options))).value;
    return { ...state };
}

function captureSafeWorktreePathState(
    repoRoot: string, relativeFile: string, options: SafeWorktreePathStateOptions
): SafeWorktreePathState {
    const resolvedPath = resolveRepoRelativePath(repoRoot, relativeFile);
    if (!isInvocationReadObservationActive()) countNextStepWork('scope_path_state:' + (resolvedPath || relativeFile));
    if (!resolvedPath) {
        return normalizePath(relativeFile) ? { status: 'outside_repo' } : { status: 'missing' };
    }
    try {
        const stat = scopePathStat(resolvedPath);
        const repoRealPath = options.repoRealPath || scopeRealPath(repoRoot);
        const includeContentHashes = options.includeContentHashes !== false;
        if (stat.isSymbolicLink()) {
            const linkTarget = scopeLinkTarget(resolvedPath);
            const linkBase = {
                mode: stat.mode,
                size: stat.size,
                link_sha256: stringSha256(linkTarget) || null,
                link_target: linkTarget
            };
            try {
                const worktreeRealPath = scopeRealPath(resolvedPath);
                if (!isPathInsideRoot(worktreeRealPath, repoRealPath)) {
                    return { status: 'outside_repo' };
                }
                const targetStat = scopeTargetStat(resolvedPath);
                const targetPath = normalizePath(path.relative(repoRealPath, worktreeRealPath)) || null;
                const targetBase = {
                    ...linkBase,
                    target_path: targetPath,
                    target_mode: targetStat.mode,
                    target_size: targetStat.size
                };
                if (targetStat.isFile()) {
                    const targetSha256 = includeContentHashes
                        ? fileSha256(worktreeRealPath, targetStat)
                        : null;
                    if (
                        (includeContentHashes && !targetSha256)
                        || !observedSymlinkStillMatches(resolvedPath, stat, linkTarget, worktreeRealPath)
                    ) {
                        return {
                            ...targetBase,
                            status: 'unreviewable_symlink',
                            target_status: 'unreviewable'
                        };
                    }
                    return {
                        ...targetBase,
                        status: 'symbolic_link',
                        target_status: 'file',
                        target_sha256: targetSha256
                    };
                }
                if (!observedSymlinkStillMatches(resolvedPath, stat, linkTarget, worktreeRealPath)) {
                    return {
                        ...targetBase,
                        status: 'unreviewable_symlink',
                        target_status: 'unreviewable'
                    };
                }
                retainDirectoryProjection(resolvedPath, targetStat, true);
                return {
                    ...targetBase,
                    status: 'unreviewable_symlink',
                    target_status: targetStat.isDirectory() ? 'directory' : 'special'
                };
            } catch (error: unknown) {
                // Keep the link text reviewable while distinguishing absent targets from
                // targets whose state could not be inspected by fail-closed callers.
                return {
                    ...linkBase,
                    status: 'symbolic_link',
                    target_status: isMissingPathError(error) || !options.distinguishAccessErrors
                        ? 'missing'
                        : 'unreviewable'
                };
            }
        }
        const worktreeRealPath = scopeRealPath(resolvedPath);
        if (!isPathInsideRoot(worktreeRealPath, repoRealPath)) {
            return { status: 'outside_repo' };
        }
        const base = {
            mode: stat.mode,
            size: stat.size
        };
        if (stat.isFile()) {
            const sha256 = includeContentHashes
                ? fileSha256(resolvedPath, stat)
                : null;
            if (includeContentHashes && !sha256) {
                return { ...base, status: 'unreviewable' };
            }
            return {
                ...base,
                status: 'file',
                sha256
            };
        }
        if (stat.isDirectory()) {
            retainDirectoryProjection(resolvedPath, stat);
            return { ...base, status: 'directory' };
        }
        return { ...base, status: 'special' };
    } catch (error: unknown) {
        if (isMissingPathError(error)) {
            return { status: 'missing' };
        }
        return options.distinguishAccessErrors
            ? { status: 'unreviewable' }
            : { status: 'missing' };
    }
}
