import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { lstatFileIdentitySync, statFileIdentitySync } from '../../core/file-stat';
import * as path from 'node:path';

import { runGit } from '../../core/git-helpers';
import { isPlainRecord } from '../../core/records';
import {
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import {
    LEGACY_WIP_MANIFEST_SCHEMA_VERSION,
    WIP_MANIFEST_SCHEMA_VERSION,
    normalizeGitPath,
    resolveRepoPath,
    stableTimestampSlug
} from './full-suite-repair-contracts';
import {
    parseRepairChildScopeEvidence
} from './full-suite-repair-child-scope';
import type {
    CapturedUntrackedFileEvidence,
    RepairWipManifest
} from './full-suite-repair-contracts';

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

export function isContainedPath(rootPath: string, candidatePath: string): boolean {
    const relativePath = path.relative(rootPath, candidatePath);
    return relativePath === ''
        || (!path.isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`));
}

export function validatePhysicalRepoContainment(repoRoot: string, absolutePath: string, label: string): string[] {
    const root = path.resolve(repoRoot);
    const target = path.resolve(absolutePath);
    if (!isContainedPath(root, target)) {
        return [`${label} escapes repo root: ${normalizePath(target)}`];
    }
    let canonicalRoot = '';
    try {
        canonicalRoot = fs.realpathSync.native(root);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`${label} cannot resolve repository root: ${message}`];
    }
    const relativePath = path.relative(root, target);
    const segments = relativePath ? relativePath.split(path.sep).filter(Boolean) : [];
    let currentPath = root;
    for (const segment of segments) {
        currentPath = path.join(currentPath, segment);
        let stat: fs.Stats;
        try {
            stat = lstatFileIdentitySync(currentPath);
        } catch (error: unknown) {
            const code = error != null && typeof error === 'object' && 'code' in error
                ? String((error as { code?: unknown }).code || '')
                : '';
            if (code === 'ENOENT') {
                break;
            }
            const message = error instanceof Error ? error.message : String(error);
            return [`${label} cannot inspect path component ${normalizePath(currentPath)}: ${message}`];
        }
        if (stat.isSymbolicLink()) {
            return [`${label} traverses a symbolic-link or junction component: ${normalizePath(currentPath)}`];
        }
        let canonicalCurrent = '';
        try {
            canonicalCurrent = fs.realpathSync.native(currentPath);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return [`${label} cannot resolve path component ${normalizePath(currentPath)}: ${message}`];
        }
        if (!isContainedPath(canonicalRoot, canonicalCurrent)) {
            return [`${label} physically escapes repo root through ${normalizePath(currentPath)}`];
        }
    }
    return [];
}

export function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.birthtimeMs === right.birthtimeMs;
}

export function sameFileSnapshot(left: fs.Stats, right: fs.Stats): boolean {
    return sameFileIdentity(left, right)
        && left.size === right.size
        && left.mode === right.mode
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}

export function assertSingleLinkIdentity(identity: fs.Stats, label: string): void {
    if (!identity.isFile()) {
        throw new Error(`${label} must be a regular file.`);
    }
    if (identity.nlink !== 1) {
        throw new Error(`${label} must not have additional hard links.`);
    }
}

export function restoreContainedUntrackedFile(params: {
    repoRoot: string;
    entry: CapturedUntrackedFileEvidence;
}): void {
    const artifactPath = resolveInputPathInsideRepo(
        params.repoRoot,
        params.entry.artifact_path,
        `untracked artifact ${params.entry.path}`
    );
    const artifactContainment = validatePhysicalRepoContainment(
        params.repoRoot,
        artifactPath,
        `untracked artifact ${params.entry.path}`
    );
    if (artifactContainment.length > 0) {
        throw new Error(artifactContainment.join(' '));
    }
    const artifactIdentityBeforeRead = statFileIdentitySync(artifactPath);
    assertSingleLinkIdentity(artifactIdentityBeforeRead, `untracked artifact ${params.entry.path}`);
    const artifactMode = artifactIdentityBeforeRead.mode & 0o777;
    if (artifactMode !== params.entry.mode) {
        throw new Error(
            `untracked artifact ${params.entry.path} mode mismatch: expected=${params.entry.mode.toString(8)}; actual=${artifactMode.toString(8)}`
        );
    }
    const artifactBytes = fs.readFileSync(artifactPath);
    const artifactIdentityAfterRead = statFileIdentitySync(artifactPath);
    if (!sameFileIdentity(artifactIdentityBeforeRead, artifactIdentityAfterRead)) {
        throw new Error(`untracked artifact identity changed while reading: ${params.entry.path}`);
    }
    assertSingleLinkIdentity(artifactIdentityAfterRead, `untracked artifact ${params.entry.path}`);
    if ((artifactIdentityAfterRead.mode & 0o777) !== params.entry.mode) {
        throw new Error(`untracked artifact mode changed while reading: ${params.entry.path}`);
    }
    const actualSha256 = createHash('sha256').update(artifactBytes).digest('hex');
    if (actualSha256 !== params.entry.sha256) {
        throw new Error(
            `untracked artifact ${params.entry.path} sha256 mismatch: expected=${params.entry.sha256}; actual=${actualSha256}`
        );
    }
    if (artifactBytes.byteLength !== params.entry.bytes) {
        throw new Error(
            `untracked artifact ${params.entry.path} byte count mismatch: expected=${params.entry.bytes}; actual=${artifactBytes.byteLength}`
        );
    }
    restoreContainedUntrackedBytes({
        repoRoot: params.repoRoot,
        entry: params.entry,
        content: artifactBytes
    });
}

export function restoreContainedUntrackedBytes(params: {
    repoRoot: string;
    entry: CapturedUntrackedFileEvidence;
    content: Buffer;
}): void {
    const targetPath = resolveRepoPath(params.repoRoot, params.entry.path);
    const targetParentPath = path.dirname(targetPath);
    let targetParentIdentity: fs.Stats;
    try {
        targetParentIdentity = lstatFileIdentitySync(targetParentPath);
    } catch (error: unknown) {
        const code = error != null && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '')
            : '';
        if (code === 'ENOENT') {
            throw new Error(
                `untracked restore target parent directory must already exist: ${params.entry.path}`
            );
        }
        throw error;
    }
    if (targetParentIdentity.isSymbolicLink() || !targetParentIdentity.isDirectory()) {
        throw new Error(
            `untracked restore target parent must be a physical directory: ${params.entry.path}`
        );
    }
    const preOpenContainment = validatePhysicalRepoContainment(
        params.repoRoot,
        targetPath,
        `untracked restore target ${params.entry.path}`
    );
    if (preOpenContainment.length > 0) {
        throw new Error(preOpenContainment.join(' '));
    }

    let targetFd: number | null = null;
    let openedIdentity: fs.Stats | null = null;
    let contentWritten = false;
    try {
        const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
        targetFd = fs.openSync(
            targetPath,
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | noFollowFlag,
            0o600
        );
        openedIdentity = fs.fstatSync(targetFd);
        const postOpenContainment = validatePhysicalRepoContainment(
            params.repoRoot,
            targetPath,
            `untracked restore target ${params.entry.path}`
        );
        if (postOpenContainment.length > 0) {
            throw new Error(postOpenContainment.join(' '));
        }
        const targetParentIdentityAfterOpen = lstatFileIdentitySync(targetParentPath);
        if (!sameFileIdentity(targetParentIdentity, targetParentIdentityAfterOpen)) {
            throw new Error(`untracked restore target parent identity changed during creation: ${params.entry.path}`);
        }
        if (targetParentIdentityAfterOpen.isSymbolicLink() || !targetParentIdentityAfterOpen.isDirectory()) {
            throw new Error(
                `untracked restore target parent changed to a non-directory or symbolic link: ${params.entry.path}`
            );
        }
        const pathIdentity = statFileIdentitySync(targetPath);
        if (!sameFileIdentity(openedIdentity, pathIdentity)) {
            throw new Error(`untracked restore target identity changed during creation: ${params.entry.path}`);
        }
        assertSingleLinkIdentity(openedIdentity, `untracked restore target ${params.entry.path}`);
        assertSingleLinkIdentity(pathIdentity, `untracked restore target ${params.entry.path}`);
        fs.writeFileSync(targetFd, params.content);
        contentWritten = true;
        fs.fchmodSync(targetFd, params.entry.mode);
        fs.fsyncSync(targetFd);
        const finalOpenedIdentity = fs.fstatSync(targetFd);
        const finalPathIdentity = statFileIdentitySync(targetPath);
        const finalContainment = validatePhysicalRepoContainment(
            params.repoRoot,
            targetPath,
            `untracked restore target ${params.entry.path}`
        );
        if (finalContainment.length > 0) {
            throw new Error(finalContainment.join(' '));
        }
        if (!sameFileIdentity(finalOpenedIdentity, finalPathIdentity)) {
            throw new Error(`untracked restore target identity changed after write: ${params.entry.path}`);
        }
        assertSingleLinkIdentity(finalOpenedIdentity, `untracked restore target ${params.entry.path}`);
        assertSingleLinkIdentity(finalPathIdentity, `untracked restore target ${params.entry.path}`);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        let cleanupViolation = '';
        if (targetFd !== null && contentWritten) {
            try {
                fs.ftruncateSync(targetFd, 0);
                fs.fsyncSync(targetFd);
            } catch (scrubError: unknown) {
                const scrubMessage = scrubError instanceof Error ? scrubError.message : String(scrubError);
                cleanupViolation = `; failed to scrub rejected restore target ${params.entry.path}: ${scrubMessage}`;
            }
        }
        if (targetFd !== null) {
            try {
                fs.closeSync(targetFd);
            } catch (closeError: unknown) {
                const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
                cleanupViolation += `; failed to close rejected restore target ${params.entry.path}: ${closeMessage}`;
            }
            targetFd = null;
        }
        if (openedIdentity) {
            try {
                const currentIdentity = statFileIdentitySync(targetPath);
                if (!sameFileIdentity(openedIdentity, currentIdentity)) {
                    cleanupViolation += `; cleanup refused because target identity changed: ${params.entry.path}`;
                } else {
                    fs.unlinkSync(targetPath);
                }
            } catch (cleanupError: unknown) {
                const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
                cleanupViolation += `; failed to clean up exclusively created target ${params.entry.path}: ${cleanupMessage}`;
            }
        }
        throw new Error(`${message}${cleanupViolation}`);
    } finally {
        if (targetFd !== null) {
            fs.closeSync(targetFd);
        }
    }
}

export function getHeadCommit(repoRoot: string): string {
    return runGit(repoRoot, ['rev-parse', 'HEAD']).trim();
}

export function runGitStatus(repoRoot: string, args: string[], input?: Buffer): {
    status: number;
    stdout: string;
    stderr: string;
} {
    const result = childProcess.spawnSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        input,
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });
    return {
        status: result.status ?? -1,
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || '')
    };
}

export function gitFailureMessage(args: string[], result: { stdout: string; stderr: string }): string {
    return `git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim() || 'unknown git error'}`;
}

export function runGitWithInput(repoRoot: string, args: string[], input: Buffer): string {
    const result = runGitStatus(repoRoot, args, input);
    if (result.status !== 0) {
        throw new Error(gitFailureMessage(args, result));
    }
    return result.stdout;
}

export function validateManifestRelativePath(repoRoot: string, value: unknown, label: string): string[] {
    const candidate = typeof value === 'string' ? value.trim() : '';
    if (!candidate) {
        return [`${label} must be a non-empty repository-relative path.`];
    }
    if (path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/u.test(candidate) || /[\u0000-\u001F\u007F]/u.test(candidate)) {
        return [`${label} must be a safe repository-relative path: ${candidate}`];
    }
    try {
        resolveRepoPath(repoRoot, candidate);
    } catch (error: unknown) {
        return [error instanceof Error ? error.message : String(error)];
    }
    return [];
}

function validateManifestArtifactPath(repoRoot: string, value: unknown, label: string): string[] {
    const rawCandidate = typeof value === 'string' ? value : '';
    const candidate = rawCandidate.trim();
    if (!candidate) {
        return [`${label} must be a non-empty repository-contained path.`];
    }
    if (candidate !== rawCandidate || /[\u0000-\u001F\u007F]/u.test(candidate)) {
        return [`${label} must not contain surrounding whitespace or control characters.`];
    }
    if (!path.isAbsolute(candidate) && candidate.startsWith('-')) {
        return [`${label} must not be an option-like relative path: ${candidate}`];
    }
    try {
        resolveInputPathInsideRepo(repoRoot, candidate, label);
    } catch (error: unknown) {
        return [error instanceof Error ? error.message : String(error)];
    }
    return [];
}

function isCanonicalIsoUtcTimestamp(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
        return false;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function isSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/iu.test(value);
}

function isGitObjectIdOrNull(value: unknown): value is string | null {
    return value === null || (typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value));
}

function sameResolvedPath(left: string, right: string): boolean {
    return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function validateManifestCaptureOwnership(
    repoRoot: string,
    manifestPath: string,
    value: Record<string, unknown>
): string[] {
    if (typeof value.task_id !== 'string'
        || !value.task_id.trim()
        || value.task_id !== value.task_id.trim()
        || /[\u0000-\u001F\u007F]/u.test(value.task_id)
        || !isCanonicalIsoUtcTimestamp(value.created_at_utc)) {
        return [];
    }
    const violations: string[] = [];
    const wipRoot = path.resolve(joinOrchestratorPath(repoRoot, path.join('runtime', 'wip')));
    const taskCaptureRoot = path.resolve(wipRoot, value.task_id, 'full-suite-repair');
    if (!isContainedPath(wipRoot, taskCaptureRoot) || taskCaptureRoot === wipRoot) {
        return ['WIP manifest task_id cannot resolve outside the canonical WIP capture root.'];
    }
    const captureLeaf = path.join(taskCaptureRoot, stableTimestampSlug(value.created_at_utc));
    const expectedManifestPath = path.join(captureLeaf, 'manifest.json');
    if (!sameResolvedPath(manifestPath, expectedManifestPath)) {
        violations.push(
            `WIP manifest path is not bound to its canonical capture leaf: expected=${normalizePath(expectedManifestPath)}.`
        );
    }
    if (isPlainRecord(value.patches)) {
        for (const [label, fileName] of [['staged', 'staged.patch'], ['unstaged', 'unstaged.patch']] as const) {
            const patch = value.patches[label];
            if (!isPlainRecord(patch) || typeof patch.path !== 'string') {
                continue;
            }
            try {
                const actualPatchPath = resolveInputPathInsideRepo(repoRoot, patch.path, `WIP manifest ${label} patch path`);
                const expectedPatchPath = path.join(captureLeaf, fileName);
                if (!sameResolvedPath(actualPatchPath, expectedPatchPath)) {
                    violations.push(
                        `WIP manifest ${label} patch path is not bound to its canonical capture artifact: expected=${normalizePath(expectedPatchPath)}.`
                    );
                }
            } catch {
                // The ordinary artifact-path validator reports malformed or escaping paths.
            }
        }
    }
    if (Array.isArray(value.untracked_files)) {
        value.untracked_files.forEach((entry, index) => {
            if (!isPlainRecord(entry)
                || typeof entry.path !== 'string'
                || typeof entry.artifact_path !== 'string'
                || validateManifestRelativePath(
                    repoRoot,
                    entry.path,
                    `WIP manifest untracked_files[${index}].path`
                ).length > 0) {
                return;
            }
            try {
                const actualArtifactPath = resolveInputPathInsideRepo(
                    repoRoot,
                    entry.artifact_path,
                    `WIP manifest untracked_files[${index}].artifact_path`
                );
                const expectedArtifactPath = path.join(
                    captureLeaf,
                    'untracked',
                    ...normalizeGitPath(entry.path).split('/')
                );
                if (!sameResolvedPath(actualArtifactPath, expectedArtifactPath)) {
                    violations.push(
                        `WIP manifest untracked_files[${index}].artifact_path is not bound to its canonical capture artifact: expected=${normalizePath(expectedArtifactPath)}.`
                    );
                }
            } catch {
                // The ordinary artifact-path validator reports malformed or escaping paths.
            }
        });
    }
    return violations;
}

export function parseRepairWipManifest(repoRoot: string, manifestPath: string, value: unknown): {
    manifest: RepairWipManifest | null;
    violations: string[];
} {
    if (!isPlainRecord(value) || value.kind !== 'full_suite_repair_wip') {
        return { manifest: null, violations: ['WIP manifest is missing or invalid.'] };
    }
    const violations: string[] = [];
    const schemaVersion = value.schema_version;
    if (
        schemaVersion !== WIP_MANIFEST_SCHEMA_VERSION
        && schemaVersion !== LEGACY_WIP_MANIFEST_SCHEMA_VERSION
    ) {
        violations.push(
            `WIP manifest schema_version must be ${WIP_MANIFEST_SCHEMA_VERSION} `
            + `or legacy ${LEGACY_WIP_MANIFEST_SCHEMA_VERSION}.`
        );
    }
    if (value.status !== 'suspended') {
        violations.push('WIP manifest status must be suspended.');
    }
    for (const fieldName of ['task_id'] as const) {
        const fieldValue = value[fieldName];
        if (typeof fieldValue !== 'string'
            || !fieldValue.trim()
            || fieldValue !== fieldValue.trim()
            || /[\u0000-\u001F\u007F]/u.test(fieldValue)) {
            violations.push(`WIP manifest ${fieldName} must be a non-empty string.`);
        }
    }
    const childTaskIds = Array.isArray(value.child_task_ids)
        ? value.child_task_ids
        : [];
    if (childTaskIds.length < 2) {
        violations.push('WIP manifest child_task_ids must contain at least two repair child task ids.');
    }
    const normalizedChildTaskIds = childTaskIds.map((entry) => (
        typeof entry === 'string' ? entry.trim() : ''
    ));
    if (normalizedChildTaskIds.some((entry, index) => (
        !entry
        || entry !== childTaskIds[index]
        || /[\u0000-\u001F\u007F]/u.test(entry)
    ))) {
        violations.push('WIP manifest child_task_ids entries must be non-empty canonical strings.');
    }
    if (new Set(normalizedChildTaskIds).size !== normalizedChildTaskIds.length) {
        violations.push('WIP manifest child_task_ids entries must be unique.');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'child_task_id')) {
        violations.push('WIP manifest child_task_id is not allowed; a repair split requires child_task_ids.');
    }
    if (schemaVersion === WIP_MANIFEST_SCHEMA_VERSION) {
        const childScopes = parseRepairChildScopeEvidence(
            repoRoot,
            value.child_scopes,
            normalizedChildTaskIds,
            'WIP manifest child_scopes'
        );
        violations.push(...childScopes.violations);
    } else if (Object.prototype.hasOwnProperty.call(value, 'child_scopes')) {
        violations.push(
            `legacy WIP manifest schema_version ${LEGACY_WIP_MANIFEST_SCHEMA_VERSION} must not claim child_scopes.`
        );
    }
    if (!isCanonicalIsoUtcTimestamp(value.created_at_utc)) {
        violations.push('WIP manifest created_at_utc must be a canonical ISO-8601 UTC timestamp.');
    }
    violations.push(...validateManifestArtifactPath(repoRoot, value.preflight_path, 'WIP manifest preflight_path'));
    violations.push(...validateManifestArtifactPath(
        repoRoot,
        value.full_suite_artifact_path,
        'WIP manifest full_suite_artifact_path'
    ));
    if (!isSha256(value.preflight_sha256)) {
        violations.push('WIP manifest preflight_sha256 must be a 64-character SHA-256 value.');
    }
    if (!isSha256(value.full_suite_artifact_sha256)) {
        violations.push('WIP manifest full_suite_artifact_sha256 must be a 64-character SHA-256 value.');
    }
    if (typeof value.base_commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value.base_commit)) {
        violations.push('WIP manifest base_commit must be a full Git object id.');
    }
    if (!isPlainRecord(value.patches) || !isPlainRecord(value.patches.staged) || !isPlainRecord(value.patches.unstaged)) {
        violations.push('WIP manifest patch references are missing or invalid.');
    } else {
        for (const [label, patch] of [['staged', value.patches.staged], ['unstaged', value.patches.unstaged]] as const) {
            violations.push(...validateManifestArtifactPath(repoRoot, patch.path, `WIP manifest ${label} patch path`));
            if (typeof patch.sha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(patch.sha256)) {
                violations.push(`WIP manifest ${label} patch sha256 is invalid.`);
            }
            if (typeof patch.bytes !== 'number' || !Number.isSafeInteger(patch.bytes) || patch.bytes < 0) {
                violations.push(`WIP manifest ${label} patch bytes must be a non-negative safe integer.`);
            }
            if (typeof patch.empty !== 'boolean') {
                violations.push(`WIP manifest ${label} patch empty flag must be boolean.`);
            }
        }
    }
    if (!Array.isArray(value.tracked_files)) {
        violations.push('WIP manifest tracked_files must be an array.');
    } else {
        const trackedPaths = new Set<string>();
        value.tracked_files.forEach((entry, index) => {
            if (!isPlainRecord(entry)) {
                violations.push(`WIP manifest tracked_files[${index}] must be an object.`);
                return;
            }
            violations.push(...validateManifestRelativePath(repoRoot, entry.path, `WIP manifest tracked_files[${index}].path`));
            if (typeof entry.staged !== 'boolean' || typeof entry.unstaged !== 'boolean') {
                violations.push(`WIP manifest tracked_files[${index}] staged and unstaged flags must be boolean.`);
            } else if (!entry.staged && !entry.unstaged) {
                violations.push(`WIP manifest tracked_files[${index}] must belong to at least one captured patch.`);
            }
            if (!isGitObjectIdOrNull(entry.head_sha256)) {
                violations.push(
                    `WIP manifest tracked_files[${index}].head_sha256 must be null or a full Git object id.`
                );
            }
            if (entry.worktree_sha256 !== null && !isSha256(entry.worktree_sha256)) {
                violations.push(
                    `WIP manifest tracked_files[${index}].worktree_sha256 must be null or a 64-character SHA-256 value.`
                );
            }
            if (entry.head_sha256 === null && entry.worktree_sha256 === null) {
                violations.push(
                    `WIP manifest tracked_files[${index}] cannot have both head_sha256 and worktree_sha256 set to null.`
                );
            }
            if (typeof entry.path === 'string') {
                const normalizedPath = normalizeGitPath(entry.path);
                if (trackedPaths.has(normalizedPath)) {
                    violations.push(`WIP manifest tracked_files contains duplicate path: ${entry.path}`);
                }
                trackedPaths.add(normalizedPath);
            }
        });
    }
    if (!Array.isArray(value.untracked_files)) {
        violations.push('WIP manifest untracked_files must be an array.');
    } else {
        const untrackedPaths = new Set<string>();
        value.untracked_files.forEach((entry, index) => {
            if (!isPlainRecord(entry)) {
                violations.push(`WIP manifest untracked_files[${index}] must be an object.`);
                return;
            }
            violations.push(...validateManifestRelativePath(repoRoot, entry.path, `WIP manifest untracked_files[${index}].path`));
            violations.push(...validateManifestArtifactPath(
                repoRoot,
                entry.artifact_path,
                `WIP manifest untracked_files[${index}].artifact_path`
            ));
            if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(entry.sha256)) {
                violations.push(`WIP manifest untracked_files[${index}].sha256 is invalid.`);
            }
            if (typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
                violations.push(`WIP manifest untracked_files[${index}].bytes must be a non-negative safe integer.`);
            }
            if (typeof entry.mode !== 'number'
                || !Number.isSafeInteger(entry.mode)
                || entry.mode < 0
                || entry.mode > 0o777) {
                violations.push(`WIP manifest untracked_files[${index}].mode must be an integer between 0 and 0777.`);
            }
            if (typeof entry.path === 'string') {
                const normalizedPath = normalizeGitPath(entry.path);
                if (untrackedPaths.has(normalizedPath)) {
                    violations.push(`WIP manifest untracked_files contains duplicate path: ${entry.path}`);
                }
                untrackedPaths.add(normalizedPath);
            }
        });
    }
    if (!Array.isArray(value.unrelated_untracked_files)) {
        violations.push('WIP manifest unrelated_untracked_files must be an array of strings.');
    } else {
        const unrelatedPaths = new Set<string>();
        value.unrelated_untracked_files.forEach((entry, index) => {
            violations.push(...validateManifestRelativePath(
                repoRoot,
                entry,
                `WIP manifest unrelated_untracked_files[${index}]`
            ));
            if (typeof entry === 'string') {
                const normalizedPath = normalizeGitPath(entry);
                if (unrelatedPaths.has(normalizedPath)) {
                    violations.push(`WIP manifest unrelated_untracked_files contains duplicate path: ${entry}`);
                }
                unrelatedPaths.add(normalizedPath);
            }
        });
    }
    violations.push(...validateManifestCaptureOwnership(repoRoot, manifestPath, value));
    return violations.length > 0
        ? { manifest: null, violations }
        : { manifest: value as unknown as RepairWipManifest, violations: [] };
}
