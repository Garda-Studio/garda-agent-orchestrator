import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveBundleNameForTarget } from '../../core/constants';
import { runGit, runGitBinary } from '../../core/git-helpers';
import { splitNulRecords } from '../../core/git-path-output';
import {
    PROJECT_MEMORY_FILE_DEFINITIONS,
    PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH
} from '../../core/project-memory';
import { DEFAULT_GIT_TIMEOUT_MS } from '../../core/subprocess';
import { getBackupSnapshotsRoot } from '../../lifecycle/backups';
import { statFingerprint } from './shared';

const MAX_RUNTIME_FINGERPRINT_SCAN_ENTRIES = 512;

interface SnapshotFingerprint {
    value: string;
    complete: boolean;
}

function worktreePathMetadata(repoRoot: string, relativePath: string): string {
    const filePath = path.join(repoRoot, relativePath);
    try {
        const stat = fs.lstatSync(filePath);
        const target = stat.isSymbolicLink() ? fs.statSync(filePath, { throwIfNoEntry: false }) : undefined;
        if (target?.isDirectory()) throw new Error('Symbolic-link directory state requires a fresh report.');
        return JSON.stringify([
            relativePath, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
            ...(stat.isSymbolicLink() ? [fs.readlinkSync(filePath), target
                ? [target.mode, target.size, target.mtimeMs, target.ctimeMs] : 'missing'] : [])
        ]);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${relativePath}:missing`;
        throw error;
    }
}

function worktreeFingerprint(repoRoot: string): SnapshotFingerprint {
    try {
        const inWorktree = runGit(repoRoot, ['rev-parse', '--is-inside-work-tree'], {
            allowFailure: true,
            allowedFailureExitCodes: [128],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS
        }).trim() === 'true';
        if (!inWorktree) return { value: `${repoRoot}:not_git_worktree`, complete: true };
        const options = { timeoutMs: DEFAULT_GIT_TIMEOUT_MS };
        // Git metadata and filesystem stats avoid hashing worktree file contents.
        const staged = runGit(repoRoot, ['ls-files', '--stage', '-v', '-z'], options);
        const trackedPaths = splitNulRecords(staged).map((record) => {
            const match = record.match(/^[HSMhsm] [0-7]{6} [0-9a-f]{40,64} [0-3]\t([\s\S]+)$/u);
            const filePath = match?.[1];
            if (!filePath) throw new Error('Git returned an invalid index path record.');
            // A directory stat cannot observe changes inside a submodule.
            if (record.slice(2).startsWith('160000 ')) throw new Error('Submodule state requires a fresh report.');
            return filePath;
        });
        const fsmonitorFlags = runGit(repoRoot, ['ls-files', '-f', '-z'], options);
        const untrackedPaths = splitNulRecords(runGit(
            repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'], options
        ));
        const head = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], {
            ...options, allowFailure: true, allowedFailureExitCodes: [128]
        });
        const paths = [...new Set([...trackedPaths, ...untrackedPaths])].sort();
        const configuration = runGit(repoRoot, ['config', '--null', '--list'], options);
        const attributes = paths.length === 0 ? '' : runGitBinary(repoRoot, ['check-attr', '--all', '-z', '--stdin'], {
            ...options, input: `${paths.join('\0')}\0`
        }).toString('utf8');
        const metadata = paths.map((filePath) => worktreePathMetadata(repoRoot, filePath));
        const value = createHash('sha256').update(JSON.stringify([
            head, staged, fsmonitorFlags, configuration, attributes, metadata
        ])).digest('hex');
        return { value, complete: true };
    } catch {
        // Unobservable Git state must bypass the report cache.
        return { value: `${repoRoot}:git_unavailable`, complete: false };
    }
}

function treeFingerprint(rootPath: string, fileNamePattern: RegExp | null = null): SnapshotFingerprint {
    if (!fs.existsSync(rootPath)) {
        return { value: `${rootPath}:missing`, complete: true };
    }
    const entries: string[] = [];
    const stack = [rootPath];
    let visited = 0;
    let truncated = false;
    while (stack.length > 0 && visited < MAX_RUNTIME_FINGERPRINT_SCAN_ENTRIES) {
        const current = stack.pop() as string;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            visited += 1;
            if (visited > MAX_RUNTIME_FINGERPRINT_SCAN_ENTRIES) {
                truncated = true;
                break;
            }
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(entryPath);
                continue;
            }
            if (fileNamePattern && !fileNamePattern.test(entry.name)) {
                continue;
            }
            entries.push(statFingerprint(entryPath));
        }
    }
    if (stack.length > 0) {
        truncated = true;
    }
    const body = entries.sort().join(';') || `${rootPath}:empty`;
    return {
        value: truncated
            ? `${body};${rootPath}:scan_truncated:${MAX_RUNTIME_FINGERPRINT_SCAN_ENTRIES}`
            : body,
        complete: !truncated
    };
}

function buildReportSnapshot(repoRoot: string): SnapshotFingerprint {
    const resolvedRoot = path.resolve(repoRoot);
    const bundleRoot = path.join(resolvedRoot, resolveBundleNameForTarget(resolvedRoot));
    const runtimeRoot = path.join(bundleRoot, 'runtime');
    const runtimeTrees = [
        treeFingerprint(path.join(runtimeRoot, 'task-events'), /\.lock(?:\.json)?$/iu),
        treeFingerprint(path.join(runtimeRoot, 'task-events'), /\.jsonl$/iu),
        treeFingerprint(path.join(runtimeRoot, 'reviews'), /(?:-quality-checklist|-preflight)\.json$/iu),
        treeFingerprint(path.join(runtimeRoot, 'full-suite'), /\.lock(?:\.json)?$/iu),
        treeFingerprint(path.join(runtimeRoot, 'locks'), /\.lock(?:\.json)?$/iu)
    ];
    const worktree = worktreeFingerprint(resolvedRoot);
    const value = [
        statFingerprint(path.join(resolvedRoot, TASK_QUEUE_FILENAME)),
        statFingerprint(path.join(resolvedRoot, 'AGENTS.md')),
        statFingerprint(path.join(bundleRoot, 'live', 'config', 'workflow-config.json')),
        statFingerprint(path.join(bundleRoot, 'live', 'config', 'profiles.json')),
        statFingerprint(path.join(bundleRoot, 'template', 'config', 'profiles.json')),
        statFingerprint(path.join(bundleRoot, 'runtime', 'workflow-config-audit.jsonl')),
        statFingerprint(path.join(bundleRoot, 'runtime', 'profile-finding-policy-audit.jsonl')),
        statFingerprint(path.join(bundleRoot, 'live', 'config', 'task-reset-enablement-receipt.json')),
        statFingerprint(path.join(bundleRoot, 'runtime', 'protected-control-plane-manifest.json')),
        statFingerprint(path.join(bundleRoot, 'live', 'config', 'paths.json')),
        statFingerprint(path.join(bundleRoot, 'runtime', 'init-answers.json')),
        statFingerprint(path.join(bundleRoot, 'runtime', 'agent-init-state.json')),
        ...PROJECT_MEMORY_FILE_DEFINITIONS.map(({ fileName }) => statFingerprint(
            path.join(bundleRoot, PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH, fileName)
        )),
        statFingerprint(path.join(runtimeRoot, 'metrics', 'full-suite-validation-duration-history.json')),
        statFingerprint(path.join(runtimeRoot, 'switch', 'state.json')),
        statFingerprint(path.join(runtimeRoot, 'switch', 'off', 'AGENTS.md')),
        ...runtimeTrees.map((tree) => tree.value),
        worktree.value,
        statFingerprint(getBackupSnapshotsRoot(resolvedRoot))
    ].join('|');
    return { value, complete: worktree.complete && runtimeTrees.every((tree) => tree.complete) };
}

export function buildReportSnapshotFingerprint(repoRoot: string): string {
    return buildReportSnapshot(repoRoot).value;
}

export function buildReportSnapshotCacheKey(repoRoot: string): string | null {
    const snapshot = buildReportSnapshot(repoRoot);
    // An incomplete scan cannot rule out changes in files outside the scan budget.
    return snapshot.complete ? snapshot.value : null;
}
