import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { runGitBinary } from '../../core/git-helpers';
import { isPlainRecord } from '../../core/records';
import { readTaskTimelineJsonlEntries } from '../../gate-runtime/task-events';
import { joinOrchestratorPath, normalizePath } from '../shared/helpers';
import {
    findCurrentCapturedManifest, getHeadCommit, normalizeGitPath
} from './split-required-wip-contracts';
import type {
    SplitRequiredWipCaptureResult, SplitRequiredWipGuardKind, SplitRequiredWipManifest
} from './split-required-wip-contracts';
import { readAuthenticatedRepoFileSnapshot, validateSequentialRestoreWorkspace } from './split-required-wip-restore-plan';
import type { AuthenticatedRepoFileSnapshot } from './split-required-wip-restore-plan';
import { assertTaskTimelineAnchorUnchanged, captureHealthyTaskTimelineAnchor } from './split-required-wip-runtime-handoff';

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 256 * 1024 * 1024;

interface AuthenticatedCapture {
    manifestSha256: string;
    stagedPatchSnapshot: Buffer;
    artifactIdentities: string[];
}

function digest(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex');
}

function authenticateArtifact(repoRoot: string, artifact: { path: string; sha256: string; bytes: number }): AuthenticatedRepoFileSnapshot & { content: Buffer } {
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > MAX_ARTIFACT_BYTES) {
        throw new Error('retained WIP artifact exceeds its byte limit: ' + artifact.path);
    }
    const relativePath = normalizeGitPath(path.relative(repoRoot, path.resolve(repoRoot, artifact.path)));
    const snapshot = readAuthenticatedRepoFileSnapshot(repoRoot, relativePath, MAX_ARTIFACT_BYTES);
    if (!snapshot.content || snapshot.content.length !== artifact.bytes || digest(snapshot.content) !== artifact.sha256) {
        throw new Error('retained WIP artifact bytes or hash changed: ' + artifact.path);
    }
    return { ...snapshot, content: snapshot.content };
}

function authenticateCapture(repoRoot: string, manifestPath: string, manifest: SplitRequiredWipManifest): AuthenticatedCapture {
    const relativePath = normalizeGitPath(path.relative(repoRoot, manifestPath));
    const snapshot = readAuthenticatedRepoFileSnapshot(repoRoot, relativePath, MAX_ARTIFACT_BYTES);
    if (!snapshot.content || JSON.stringify(JSON.parse(snapshot.content.toString('utf8'))) !== JSON.stringify(manifest)) {
        throw new Error('retained WIP manifest changed during inspection.');
    }
    const manifestSha256 = digest(snapshot.content);
    const eventFile = path.join(joinOrchestratorPath(repoRoot, ''), 'runtime/task-events', manifest.task_id + '.jsonl');
    const bound = readTaskTimelineJsonlEntries(eventFile).some(({ record }) => (
        record?.task_id === manifest.task_id && record.event_type === 'SPLIT_REQUIRED_WIP_CAPTURED'
        && isPlainRecord(record.details)
        && record.details.manifest_sha256 === manifestSha256
        && normalizePath(path.resolve(repoRoot, String(record.details.manifest_path))) === normalizePath(manifestPath)
    ));
    if (!bound) throw new Error('retained WIP manifest is not bound to its healthy capture event.');
    const artifacts = [manifest.patches.staged, manifest.patches.unstaged,
        ...manifest.untracked_files.map(entry => ({ path: entry.artifact_path, sha256: entry.sha256, bytes: entry.bytes }))];
    const totalBytes = artifacts.reduce((total, artifact) => total + artifact.bytes, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_AGGREGATE_BYTES) {
        throw new Error('retained WIP artifacts exceed their aggregate byte limit.');
    }
    const snapshots = artifacts.map(artifact => authenticateArtifact(repoRoot, artifact));
    return {
        manifestSha256,
        stagedPatchSnapshot: snapshots[0].content,
        artifactIdentities: snapshots.map(({ identity }) => JSON.stringify(identity && [
            identity.dev, identity.ino, identity.mode, identity.size, identity.mtimeMs, identity.ctimeMs
        ]))
    };
}

function workspaceSnapshot(repoRoot: string, manifest: SplitRequiredWipManifest): Map<string, string | null> {
    const snapshots = new Map<string, string | null>();
    for (const entry of [...manifest.tracked_files, ...manifest.untracked_files]) {
        const snapshot = readAuthenticatedRepoFileSnapshot(repoRoot, entry.path, MAX_ARTIFACT_BYTES);
        snapshots.set(entry.path, snapshot.content ? digest(snapshot.content) : null);
    }
    for (const entry of manifest.untracked_files) {
        const actual = snapshots.get(entry.path);
        if (actual !== null && actual !== entry.sha256) {
            throw new Error('previously restored untracked file differs from captured WIP: ' + entry.path);
        }
    }
    return snapshots;
}

function indexSnapshot(repoRoot: string): string {
    return digest(runGitBinary(repoRoot, ['ls-files', '--stage', '-z'], { timeoutMs: 30_000, maxBuffer: MAX_ARTIFACT_BYTES }));
}

/** Reuse preserved parent evidence; selected child-owned restoration is not a new capture. */
export function reuseRetainedWipForDecomposition(params: {
    repoRoot: string; taskId: string; preflightPath: string; guardKind: SplitRequiredWipGuardKind
}): SplitRequiredWipCaptureResult | null {
    const repoRoot = path.resolve(params.repoRoot);
    const current = findCurrentCapturedManifest({ ...params, repoRoot });
    if (!current) return null;
    let manifestSha256: string | null = null;
    try {
        const anchor = captureHealthyTaskTimelineAnchor(repoRoot, params.taskId);
        const authenticated = authenticateCapture(repoRoot, current.path, current.manifest);
        manifestSha256 = authenticated.manifestSha256;
        const head = getHeadCommit(repoRoot);
        if (head !== current.manifest.base_commit) throw new Error('retained WIP HEAD identity changed.');
        const before = workspaceSnapshot(repoRoot, current.manifest);
        const indexBefore = indexSnapshot(repoRoot);
        const violations = validateSequentialRestoreWorkspace(repoRoot, current.manifest, {
            allowUnrelatedTrackedChanges: true,
            validateSuspendedTrackedFiles: true,
            stagedPatchSnapshot: authenticated.stagedPatchSnapshot
        });
        if (violations.length) throw new Error(violations.join('; '));
        const after = workspaceSnapshot(repoRoot, current.manifest);
        if (JSON.stringify([...before]) !== JSON.stringify([...after]) || indexBefore !== indexSnapshot(repoRoot)) {
            throw new Error('retained WIP workspace or index changed during inspection.');
        }
        if (getHeadCommit(repoRoot) !== head) throw new Error('retained WIP HEAD identity changed during inspection.');
        assertTaskTimelineAnchorUnchanged(repoRoot, params.taskId, anchor);
        const finalManifest = readAuthenticatedRepoFileSnapshot(repoRoot, normalizeGitPath(path.relative(repoRoot, current.path)), MAX_ARTIFACT_BYTES);
        if (!finalManifest.content || digest(finalManifest.content) !== manifestSha256) throw new Error('retained WIP manifest changed during inspection.');
        // Close retained evidence after the workspace, index, HEAD and timeline inspections.
        const closing = authenticateCapture(repoRoot, current.path, current.manifest);
        if (closing.manifestSha256 !== manifestSha256
            || JSON.stringify(closing.artifactIdentities) !== JSON.stringify(authenticated.artifactIdentities)) {
            throw new Error('retained WIP manifest or artifact identity changed during inspection.');
        }
        return {
            status: 'ALREADY_CAPTURED', manifest_path: normalizePath(current.path), manifest_sha256: manifestSha256,
            tracked_files: current.manifest.tracked_files.map(entry => entry.path).sort(),
            untracked_files: current.manifest.untracked_files.map(entry => entry.path).sort(), violations: []
        };
    } catch (error: unknown) {
        return {
            status: 'BLOCKED', manifest_path: normalizePath(current.path), manifest_sha256: manifestSha256,
            tracked_files: [], untracked_files: [], violations: [error instanceof Error ? error.message : String(error)]
        };
    }
}
