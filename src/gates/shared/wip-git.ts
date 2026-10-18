import { readGitTreeEntriesForPaths, runGit, runGitBinary } from '../../core/git-helpers';

// Match the existing restore-plan budget; failed or partial probes never become evidence.
export const WIP_GIT_TIMEOUT_MS = 2 * 60 * 1_000;
export const WIP_GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const WIP_GIT_OPTIONS = { timeoutMs: WIP_GIT_TIMEOUT_MS, maxBuffer: WIP_GIT_MAX_BUFFER_BYTES };

export function runWipGit(repoRoot: string, args: string[]): string {
    return runGit(repoRoot, args, WIP_GIT_OPTIONS);
}

export function runWipGitBinary(repoRoot: string, args: string[]): Buffer {
    return runGitBinary(repoRoot, args, WIP_GIT_OPTIONS);
}

export function readWipGitTreeEntries(repoRoot: string, treeish: string, paths: Iterable<string>) {
    return readGitTreeEntriesForPaths(repoRoot, treeish, paths, { timeoutMs: WIP_GIT_TIMEOUT_MS });
}
