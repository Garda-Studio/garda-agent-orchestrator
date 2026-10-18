import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runWipGit as runGit, WIP_GIT_TIMEOUT_MS, WIP_GIT_MAX_BUFFER_BYTES } from '../shared/wip-git';
import { isPlainRecord } from '../../core/records';
import {
    fileSha256,
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import { safeReadJson } from '../task-audit/task-audit-summary-collectors';

export const SPLIT_REQUIRED_WIP_SCHEMA_VERSION = 1;

export type SplitRequiredWipGuardKind = 'scope_budget' | 'review_cycle' | 'strict_decomposition';

export interface SplitRequiredWipPatchEvidence {
    path: string;
    sha256: string;
    bytes: number;
    empty: boolean;
}

export interface SplitRequiredWipTrackedFileEvidence {
    path: string;
    head_sha256: string | null;
    worktree_sha256: string | null;
    staged: boolean;
    unstaged: boolean;
}

export interface SplitRequiredWipUntrackedFileEvidence {
    path: string;
    artifact_path: string;
    sha256: string;
    bytes: number;
}

export interface SplitRequiredWipManifest {
    schema_version: 1;
    kind: 'split_required_wip';
    status: 'suspended' | 'retired';
    task_id: string;
    guard_kind: SplitRequiredWipGuardKind;
    guard_reason: string;
    created_at_utc: string;
    retired_at_utc?: string;
    retired_reason?: string;
    base_commit: string;
    preflight_path: string;
    preflight_sha256: string;
    patches: {
        staged: SplitRequiredWipPatchEvidence;
        unstaged: SplitRequiredWipPatchEvidence;
    };
    tracked_files: SplitRequiredWipTrackedFileEvidence[];
    untracked_files: SplitRequiredWipUntrackedFileEvidence[];
    unrelated_untracked_files: string[];
    ignored_runtime_artifacts: string[];
    restore_commands: {
        list: string;
        preview_full: string;
        restore_full: string;
        preview_partial_template: string;
        restore_partial_template: string;
        retire: string;
    };
}

export interface SplitRequiredWipCaptureResult {
    status: 'CAPTURED' | 'ALREADY_CAPTURED' | 'BLOCKED';
    manifest_path: string | null;
    manifest_sha256: string | null;
    tracked_files: string[];
    untracked_files: string[];
    violations: string[];
}

export interface SplitRequiredWipListEntry {
    manifest_path: string;
    manifest_sha256: string;
    task_id: string;
    guard_kind: string;
    status: string;
    base_commit: string;
    tracked_files: string[];
    untracked_files: string[];
    created_at_utc: string;
}

export interface SplitRequiredWipListResult {
    status: 'FOUND' | 'EMPTY';
    task_id: string;
    manifests: SplitRequiredWipListEntry[];
    output_lines: string[];
}

export interface SplitRequiredWipRestoreResult {
    status: 'RESTORED' | 'DRY_RUN_OK' | 'BLOCKED';
    manifest_path: string;
    restored_files: string[];
    selected_paths: string[];
    violations: string[];
    output_lines: string[];
}

export interface SplitRequiredWipRetireResult {
    status: 'RETIRED' | 'ALREADY_RETIRED' | 'BLOCKED';
    manifest_path: string;
    violations: string[];
    output_lines: string[];
}

export interface SplitRequiredWipManifestBuildParams {
    repoRoot: string;
    taskId: string;
    guardKind: SplitRequiredWipGuardKind;
    guardReason: string;
    timestampUtc: string;
    manifestPath: string;
    preflightPath: string;
    stagedPatch: SplitRequiredWipPatchEvidence;
    unstagedPatch: SplitRequiredWipPatchEvidence;
    trackedFiles: SplitRequiredWipTrackedFileEvidence[];
    untrackedFiles: SplitRequiredWipUntrackedFileEvidence[];
    unrelatedVisibleUntrackedFiles: string[];
    ignoredRuntimeArtifacts: string[];
}

export function nowIso(): string {
    return new Date().toISOString();
}

export function stableTimestampSlug(timestampUtc: string): string {
    return timestampUtc.replace(/[^0-9A-Za-z]+/gu, '-').replace(/^-|-$/gu, '');
}

export function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function sha256FileRequired(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function fileBytes(filePath: string): number {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? fs.statSync(filePath).size
        : 0;
}

export function canCaptureSplitRequiredWip(repoRoot: string): boolean {
    const result = childProcess.spawnSync('git', ['-C', path.resolve(repoRoot || '.'), 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
        timeout: WIP_GIT_TIMEOUT_MS,
        maxBuffer: WIP_GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    return !result.error && !result.signal && result.status === 0 && String(result.stdout || '').trim() === 'true';
}

export function normalizeGitPath(value: string): string {
    return value.replace(/\\/gu, '/').replace(/^\/+/u, '');
}

export function resolveRepoPath(repoRoot: string, relativePath: string): string {
    const normalized = normalizeGitPath(relativePath);
    const resolved = path.resolve(repoRoot, normalized);
    const root = path.resolve(repoRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Path escapes repo root: ${relativePath}`);
    }
    return resolved;
}

export function resolveInputPathInsideRepo(repoRoot: string, inputPath: string, label: string): string {
    const rawPath = String(inputPath || '').trim();
    if (!rawPath) {
        throw new Error(`${label} must not be empty.`);
    }
    const resolved = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(repoRoot, rawPath);
    const root = path.resolve(repoRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`${label} escapes repo root: ${inputPath}`);
    }
    return resolved;
}

export function getHeadCommit(repoRoot: string): string {
    return runGit(repoRoot, ['rev-parse', 'HEAD']).trim();
}

export function buildRestoreCommands(taskId: string, manifestPath: string): SplitRequiredWipManifest['restore_commands'] {
    const displayManifestPath = normalizePath(manifestPath);
    return {
        list: `node bin/garda.js gate list-split-required-wip --task-id "${taskId}" --repo-root "."`,
        preview_full: `node bin/garda.js gate restore-split-required-wip --task-id "${taskId}" --manifest-path "${displayManifestPath}" --dry-run --repo-root "."`,
        restore_full: `node bin/garda.js gate restore-split-required-wip --task-id "${taskId}" --manifest-path "${displayManifestPath}" --repo-root "."`,
        preview_partial_template: `node bin/garda.js gate restore-split-required-wip --task-id "${taskId}" --manifest-path "${displayManifestPath}" --include-path "<repo/path>" --dry-run --repo-root "."`,
        restore_partial_template: `node bin/garda.js gate restore-split-required-wip --task-id "${taskId}" --manifest-path "${displayManifestPath}" --include-path "<repo/path>" --repo-root "."`,
        retire: `node bin/garda.js gate retire-split-required-wip --task-id "${taskId}" --manifest-path "${displayManifestPath}" --reason "<why this WIP is no longer needed>" --repo-root "."`
    };
}

export function resolveWipRoot(repoRoot: string, taskId: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'wip', taskId, 'split-required'));
}

export function planCaptureLocation(repoRoot: string, taskId: string): {
    timestampUtc: string;
    captureRoot: string;
    manifestPath: string;
} {
    const timestampUtc = nowIso();
    const captureRoot = path.join(resolveWipRoot(repoRoot, taskId), stableTimestampSlug(timestampUtc));
    return {
        timestampUtc,
        captureRoot,
        manifestPath: path.join(captureRoot, 'manifest.json')
    };
}

export function findManifestPaths(repoRoot: string, taskId: string): string[] {
    const root = resolveWipRoot(repoRoot, taskId);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        return [];
    }
    const found: string[] = [];
    const visit = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                visit(entryPath);
                continue;
            }
            if (entry.isFile() && entry.name === 'manifest.json') {
                found.push(entryPath);
            }
        }
    };
    visit(root);
    return found.sort();
}

export function readManifest(filePath: string): SplitRequiredWipManifest | null {
    const parsed = safeReadJson(filePath);
    if (!isPlainRecord(parsed) || parsed.kind !== 'split_required_wip') {
        return null;
    }
    return parsed as unknown as SplitRequiredWipManifest;
}

export function findCurrentCapturedManifest(params: {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    guardKind: SplitRequiredWipGuardKind;
}): { path: string; manifest: SplitRequiredWipManifest } | null {
    const preflightSha256 = fileSha256(params.preflightPath) || '';
    const manifests = findManifestPaths(params.repoRoot, params.taskId)
        .map((manifestPath) => ({ path: manifestPath, manifest: readManifest(manifestPath) }))
        .filter((entry): entry is { path: string; manifest: SplitRequiredWipManifest } => Boolean(entry.manifest))
        .filter((entry) => (
            entry.manifest.task_id === params.taskId
            && entry.manifest.guard_kind === params.guardKind
            && entry.manifest.status === 'suspended'
            && entry.manifest.preflight_sha256 === preflightSha256
        ));
    return manifests.length > 0 ? manifests[manifests.length - 1] : null;
}

export function buildSplitRequiredWipManifest(
    params: SplitRequiredWipManifestBuildParams
): SplitRequiredWipManifest {
    return {
        schema_version: SPLIT_REQUIRED_WIP_SCHEMA_VERSION,
        kind: 'split_required_wip',
        status: 'suspended',
        task_id: params.taskId,
        guard_kind: params.guardKind,
        guard_reason: params.guardReason,
        created_at_utc: params.timestampUtc,
        base_commit: getHeadCommit(params.repoRoot),
        preflight_path: normalizePath(params.preflightPath),
        preflight_sha256: fileSha256(params.preflightPath) || '',
        patches: {
            staged: params.stagedPatch,
            unstaged: params.unstagedPatch
        },
        tracked_files: params.trackedFiles,
        untracked_files: params.untrackedFiles,
        unrelated_untracked_files: params.unrelatedVisibleUntrackedFiles,
        ignored_runtime_artifacts: params.ignoredRuntimeArtifacts,
        restore_commands: buildRestoreCommands(params.taskId, params.manifestPath)
    };
}
