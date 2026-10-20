import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePorcelainV1Z } from '../../core/git-path-output';

import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import {
    computeProtectedSnapshotDigest,
    normalizePath,
    resolveProtectedControlPlaneManifestPath,
    toPlainRecord
} from '../shared/helpers';
import { hasUnsafeIgnoredWorkflowConfigCompatibilityBaseline } from './workflow-config-work-compatibility';
import type {
    ProtectedManifestWorkflowConfigHashes,
    WorkflowConfigPreTaskBaselineState
} from './workflow-config-work-contracts';
import {
    getCurrentWorkflowConfigFileHashes,
    getWorkflowConfigControlPlanePaths,
    normalizeWorkflowConfigSha256
} from './workflow-config-work-paths';

export function readProtectedManifestWorkflowConfigHashes(
    repoRoot: string,
    workflowConfigPaths: readonly string[]
): ProtectedManifestWorkflowConfigHashes {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    if (!fs.existsSync(manifestPath)) {
        return { status: 'missing', hashes: {} };
    }

    try {
        if (!fs.statSync(manifestPath).isFile()) {
            return { status: 'invalid', hashes: {} };
        }
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const parsedRecord = toPlainRecord(parsed);
        const snapshot = toPlainRecord(parsedRecord?.protected_snapshot);
        if (!snapshot) {
            return { status: 'invalid', hashes: {} };
        }
        const hasDigest = parsedRecord
            ? Object.prototype.hasOwnProperty.call(parsedRecord, 'protected_snapshot_sha256')
            : false;
        const expectedDigest = hasDigest
            ? normalizeWorkflowConfigSha256(parsedRecord?.protected_snapshot_sha256)
            : null;
        if (
            hasDigest
            && (!expectedDigest || computeProtectedSnapshotDigest(snapshot as Record<string, string>) !== expectedDigest)
        ) {
            return { status: 'invalid', hashes: {} };
        }
        const manifestHashes: Record<string, string | null> = {};
        for (const relativePath of workflowConfigPaths) {
            if (!Object.prototype.hasOwnProperty.call(snapshot, relativePath)) {
                continue;
            }
            const hash = normalizeWorkflowConfigSha256(snapshot[relativePath]);
            if (!hash) {
                return { status: 'invalid', hashes: {} };
            }
            manifestHashes[relativePath] = hash;
        }
        return { status: 'present', hashes: manifestHashes };
    } catch {
        return { status: 'invalid', hashes: {} };
    }
}

function readGitHeadFileSha256(repoRoot: string, relativePath: string): string | undefined {
    try {
        const result = spawnSyncWithTimeout('git', ['-C', repoRoot, 'show', `HEAD:${relativePath}`], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 20 * 1024 * 1024
        });
        if (result.status !== 0 || result.timedOut || result.error) {
            return undefined;
        }
        const stdout = Buffer.isBuffer(result.stdout)
            ? result.stdout
            : Buffer.from(String(result.stdout || ''), 'utf8');
        return crypto.createHash('sha256').update(stdout).digest('hex').toLowerCase();
    } catch {
        return undefined;
    }
}

function readGitIndexOrWorktreeStatus(repoRoot: string, relativePath: string): string[] | null {
    const normalizedRelativePath = normalizePath(relativePath);
    const targetPath = path.join(repoRoot, ...normalizedRelativePath.split('/'));
    const targetExists = fs.existsSync(targetPath);
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            repoRoot,
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
            '--ignored=matching',
            '--',
            relativePath
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS
        });
        if (result.status !== 0 || result.timedOut || result.error) {
            return null;
        }
        return parsePorcelainV1Z(String(result.stdout || ''))
            .filter((entry) => {
                const statusPath = normalizePath(entry.path);
                if (statusPath === normalizedRelativePath) {
                    return true;
                }
                const statusPathWithSlash = statusPath.endsWith('/') ? statusPath : `${statusPath}/`;
                return targetExists && normalizedRelativePath.startsWith(statusPathWithSlash);
            })
            .map((entry) => `${entry.indexStatus}${entry.worktreeStatus} ${entry.path}`);
    } catch {
        return null;
    }
}

function isIgnoredOnlyGitStatus(statusLines: readonly string[]): boolean {
    return statusLines.length > 0 && statusLines.every((line) => line.startsWith('!! '));
}

export function getWorkflowConfigPreTaskBaselineState(
    repoRoot: string,
    currentFileHashes: Record<string, string | null> = getCurrentWorkflowConfigFileHashes(repoRoot)
): WorkflowConfigPreTaskBaselineState {
    const workflowConfigPaths = [...new Set([
        ...getWorkflowConfigControlPlanePaths(repoRoot),
        ...Object.keys(currentFileHashes)
    ])].sort();
    const manifestState = readProtectedManifestWorkflowConfigHashes(repoRoot, workflowConfigPaths);
    const manifestHashes = manifestState.hashes;
    const changedFiles = new Set<string>();
    const compatibilityBaselineFiles = new Set<string>();
    const gitChangedFiles = new Set<string>();
    const protectedManifestChangedFiles = new Set<string>();

    for (const relativePath of workflowConfigPaths) {
        const currentHash = Object.prototype.hasOwnProperty.call(currentFileHashes, relativePath)
            ? currentFileHashes[relativePath]
            : null;
        if (manifestState.status === 'invalid') {
            changedFiles.add(relativePath);
            continue;
        }
        const gitHeadHash = readGitHeadFileSha256(repoRoot, relativePath);
        const hasManifestHash = manifestState.status === 'present'
            && Object.prototype.hasOwnProperty.call(manifestHashes, relativePath);
        const manifestHash = hasManifestHash ? manifestHashes[relativePath] : undefined;
        if (hasManifestHash && manifestHash === currentHash) {
            continue;
        }
        const gitStatusLines = gitHeadHash === undefined && !hasManifestHash
            ? readGitIndexOrWorktreeStatus(repoRoot, relativePath)
            : [];
        if (gitStatusLines === null && currentHash !== null) {
            changedFiles.add(relativePath);
            continue;
        }
        if (gitStatusLines === null) {
            continue;
        }

        if (gitHeadHash !== undefined && gitHeadHash !== currentHash) {
            changedFiles.add(relativePath);
            gitChangedFiles.add(relativePath);
        }
        if (hasManifestHash && manifestHash !== currentHash) {
            changedFiles.add(relativePath);
            protectedManifestChangedFiles.add(relativePath);
        }
        if (
            gitHeadHash === undefined
            && !hasManifestHash
            && currentHash !== null
            && isIgnoredOnlyGitStatus(gitStatusLines)
        ) {
            if (hasUnsafeIgnoredWorkflowConfigCompatibilityBaseline(repoRoot, relativePath)) {
                changedFiles.add(relativePath);
                gitChangedFiles.add(relativePath);
                continue;
            }
            compatibilityBaselineFiles.add(relativePath);
            continue;
        }
        if (
            gitHeadHash === undefined
            && !hasManifestHash
            && gitStatusLines.length > 0
        ) {
            changedFiles.add(relativePath);
            gitChangedFiles.add(relativePath);
        }
    }

    return {
        changed_files: [...changedFiles].sort(),
        compatibility_baseline_files: [...compatibilityBaselineFiles].sort(),
        git_changed_files: [...gitChangedFiles].sort(),
        protected_manifest_changed_files: [...protectedManifestChangedFiles].sort(),
        protected_manifest_status: manifestState.status
    };
}
