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

export function getSafeWorktreePathState(
    repoRoot: string,
    relativeFile: string,
    options: SafeWorktreePathStateOptions = {}
): SafeWorktreePathState {
    const resolvedPath = resolveRepoRelativePath(repoRoot, relativeFile);
    if (!resolvedPath) {
        return normalizePath(relativeFile) ? { status: 'outside_repo' } : { status: 'missing' };
    }
    try {
        const stat = fs.lstatSync(resolvedPath);
        const repoRealPath = options.repoRealPath || fs.realpathSync(repoRoot);
        const includeContentHashes = options.includeContentHashes !== false;
        if (stat.isSymbolicLink()) {
            const linkTarget = fs.readlinkSync(resolvedPath);
            const linkBase = {
                mode: stat.mode,
                size: stat.size,
                link_sha256: stringSha256(linkTarget) || null,
                link_target: linkTarget
            };
            try {
                const worktreeRealPath = fs.realpathSync(resolvedPath);
                if (!isPathInsideRoot(worktreeRealPath, repoRealPath)) {
                    return { status: 'outside_repo' };
                }
                const targetStat = fs.statSync(resolvedPath);
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
                        || !symlinkStillMatches(resolvedPath, stat, linkTarget, worktreeRealPath)
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
                if (!symlinkStillMatches(resolvedPath, stat, linkTarget, worktreeRealPath)) {
                    return {
                        ...targetBase,
                        status: 'unreviewable_symlink',
                        target_status: 'unreviewable'
                    };
                }
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
        const worktreeRealPath = fs.realpathSync(resolvedPath);
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
