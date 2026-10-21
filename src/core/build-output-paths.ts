import * as fs from 'node:fs';
import * as path from 'node:path';
import { isRecognizedPackageName } from './constants';
import { joinOrchestratorPath } from './orchestrator-paths';
import { runGit } from './git-helpers';
import { splitNulRecords } from './git-path-output';
import { DEFAULT_GIT_TIMEOUT_MS } from './subprocess';

export const UNTRACKED_BUILD_OUTPUT_CONFIG_KEY = 'untracked_build_output_regexes';
export const DEFAULT_UNTRACKED_BUILD_OUTPUT_REGEXES: readonly string[] = Object.freeze([
    '(^|/)(?:target|bin|obj|build|dist|out|__pycache__|\\.venv|venv|node_modules|\\.gradle|\\.pytest_cache|\\.mypy_cache|coverage)/',
    '\\.py[co]$'
]);

const SOURCE_CHECKOUT_EXECUTABLE_PREFIX = 'dist/src/';

function isGardaSourceCheckout(repoRoot: string): boolean {
    try {
        const value: unknown = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        return value !== null && typeof value === 'object' && 'name' in value
            && isRecognizedPackageName(value.name);
    } catch {
        return false;
    }
}

export function normalizeUntrackedBuildOutputRegexes(value: unknown): string[] {
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || !entry.length))
        throw new Error(`paths.${UNTRACKED_BUILD_OUTPUT_CONFIG_KEY} must be an array of non-empty regex strings.`);
    for (const pattern of value) {
        try { new RegExp(pattern, 'i'); }
        catch (cause) { throw new Error(`Invalid paths.${UNTRACKED_BUILD_OUTPUT_CONFIG_KEY} pattern: ${pattern}`, { cause }); }
    }
    return [...value];
}

function readBuildOutputMatchers(repoRoot: string): RegExp[] {
    const configPath = joinOrchestratorPath(repoRoot, 'live/config/paths.json');
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const patterns = data[UNTRACKED_BUILD_OUTPUT_CONFIG_KEY] === undefined
        ? DEFAULT_UNTRACKED_BUILD_OUTPUT_REGEXES
        : normalizeUntrackedBuildOutputRegexes(data[UNTRACKED_BUILD_OUTPUT_CONFIG_KEY]);
    return patterns.map(pattern => new RegExp(pattern, 'i'));
}

export function filterUntrackedBuildOutputPaths(repoRoot: string, untrackedPaths: readonly string[]): string[] {
    const matchers = readBuildOutputMatchers(repoRoot);
    // The source checkout launches dist/src before any other runtime candidate.
    const retainExecutableRuntime = untrackedPaths.some(file => file.startsWith(SOURCE_CHECKOUT_EXECUTABLE_PREFIX))
        && isGardaSourceCheckout(repoRoot);
    return untrackedPaths.filter(file => (retainExecutableRuntime && file.startsWith(SOURCE_CHECKOUT_EXECUTABLE_PREFIX))
        || !matchers.some(regex => regex.test(file)));
}

/** Scope lists may include tracked files, including staged deletions; protect both. */
export function filterBuildOutputScopePaths(repoRoot: string, paths: readonly string[]): string[] {
    const retained = new Set(filterUntrackedBuildOutputPaths(repoRoot, paths));
    const candidates = paths.filter(file => !retained.has(file));
    if (!candidates.length) return [...paths];
    const pathspecs = candidates.map(file => `:(literal)${file}`);
    const options = { timeoutMs: DEFAULT_GIT_TIMEOUT_MS };
    // Both queries must return paths relative to the supplied project directory.
    const tracked = new Set([
        ...splitNulRecords(runGit(repoRoot, ['ls-files', '-z', '--cached', '--', ...pathspecs], options)),
        ...splitNulRecords(runGit(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--relative', '--cached',
            '--name-only', '-z', '--diff-filter=D', '--', ...pathspecs], options))
    ]);
    return paths.filter(file => retained.has(file) || tracked.has(file));
}
