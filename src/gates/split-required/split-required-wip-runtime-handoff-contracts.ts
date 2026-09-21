import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runGitBinary } from '../../core/git-helpers';
import { isPlainRecord } from '../../core/records';
import { assertCanonicalTaskId } from '../../core/task-ids';
import {
    inspectTaskEventFile,
    readTaskEventAppendState,
    withTaskTimelineReadSnapshot
} from '../../gate-runtime/task-events';
import type { TaskEventAppendState, TaskEventIntegrity } from '../../gate-runtime/task-events';
import {
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import {
    normalizeGitPath,
    resolveInputPathInsideRepo,
    resolveWipRoot
} from './split-required-wip-contracts';
import type { SplitRequiredWipManifest } from './split-required-wip-contracts';
import {
    normalizeSelectedPaths,
    readAuthenticatedRepoFileSnapshot,
    replaceAuthenticatedRepoFile,
    selectedFiles,
    writeExclusiveRepoFile
} from './split-required-wip-restore-plan';

export const SPLIT_REQUIRED_WIP_RESTORE_HANDOFF_ENV = 'GARDA_SPLIT_REQUIRED_WIP_RESTORE_HANDOFF';
const HANDOFF_SCHEMA_VERSION = 1 as const;
const HANDOFF_KIND = 'split_required_wip_restore_handoff' as const;
const MAX_HANDOFF_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_RESTORED_FILE_EVIDENCE_BYTES = 64 * 1024 * 1024;

export interface SplitRequiredWipRuntimeGeneration {
    build_root: string;
    input_fingerprint_sha256: string;
    finalizer_sha256: string;
    writer_sha256: string;
}

export interface SplitRequiredWipRestoreFileEvidence {
    path: string;
    exists: boolean;
    sha256: string | null;
    bytes: number;
}

export interface SplitRequiredWipRestoreHandoff {
    schema_version: 1;
    kind: typeof HANDOFF_KIND;
    status: 'prepared' | 'pending' | 'finalized';
    handoff_id: string;
    repo_root: string;
    task_id: string;
    manifest_path: string;
    manifest_sha256: string;
    selected_paths: string[];
    restored_files: string[];
    restored_file_evidence?: SplitRequiredWipRestoreFileEvidence[];
    workspace_state_sha256?: string;
    timeline_anchor: TaskEventAppendState;
    created_at_utc: string;
    finalized_at_utc?: string;
    runtime_generation?: SplitRequiredWipRuntimeGeneration;
    event_integrity?: TaskEventIntegrity;
}

export interface SplitRequiredWipRestoreHandoffIdentity {
    repoRoot: string;
    taskId: string;
    manifestPath: string;
    manifestSha256: string;
    manifest: SplitRequiredWipManifest;
    selectedPaths: string[];
    restoredFiles: string[];
    timelineAnchor: TaskEventAppendState;
    handoffId: string;
    handoffPath: string;
}

function sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function canonicalRoot(repoRoot: string): string {
    return normalizePath(fs.realpathSync.native(path.resolve(repoRoot || '.')));
}

function samePath(left: string, right: string): boolean {
    const normalize = (value: string): string => {
        const resolved = path.resolve(value);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(left) === normalize(right);
}

function pathIsInside(candidate: string, parent: string): boolean {
    const normalize = (value: string): string => {
        const resolved = path.resolve(value);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const normalizedCandidate = normalize(candidate);
    const normalizedParent = normalize(parent);
    return normalizedCandidate === normalizedParent
        || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function readAuthenticatedManifestSnapshot(
    repoRoot: string,
    manifestPath: string,
    wipRoot: string
): { manifest: SplitRequiredWipManifest; sha256: string } {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const resolvedManifestPath = path.resolve(manifestPath);
    const resolvedWipRoot = path.resolve(wipRoot);
    if (!pathIsInside(resolvedWipRoot, resolvedRepoRoot)
        || !pathIsInside(resolvedManifestPath, resolvedWipRoot)) {
        throw new Error('WIP manifest must remain inside the task-owned split-required WIP root.');
    }
    let snapshot: ReturnType<typeof readAuthenticatedRepoFileSnapshot>;
    try {
        snapshot = readAuthenticatedRepoFileSnapshot(
            resolvedRepoRoot,
            normalizeGitPath(path.relative(resolvedRepoRoot, resolvedManifestPath)),
            MAX_MANIFEST_BYTES
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`WIP manifest changed while reading authenticated bytes: ${message}`);
    }
    if (!snapshot.exists || snapshot.content === null) {
        throw new Error('WIP manifest must remain a regular file while being authenticated.');
    }
    if (snapshot.content.length > MAX_MANIFEST_BYTES) {
        throw new Error(`WIP manifest exceeds the ${MAX_MANIFEST_BYTES}-byte limit.`);
    }
    const parsed: unknown = JSON.parse(snapshot.content.toString('utf8'));
    if (!isPlainRecord(parsed) || parsed.kind !== 'split_required_wip') {
        throw new Error('WIP manifest is missing or invalid.');
    }
    return {
        manifest: parsed as unknown as SplitRequiredWipManifest,
        sha256: sha256(snapshot.content)
    };
}

function sameTimelineAnchor(value: unknown, expected: TaskEventAppendState): boolean {
    return isPlainRecord(value)
        && value.matching_events === expected.matching_events
        && value.parse_errors === expected.parse_errors
        && value.last_integrity_sequence === expected.last_integrity_sequence
        && value.last_event_sha256 === expected.last_event_sha256;
}

function resolveRestoreTimelineAnchor(
    repoRoot: string,
    taskId: string,
    manifestPath: string,
    manifestSha256: string,
    selectedPaths: readonly string[]
): TaskEventAppendState {
    const eventsRoot = path.join(joinOrchestratorPath(repoRoot, ''), 'runtime', 'task-events');
    const eventFile = path.join(eventsRoot, `${taskId}.jsonl`);
    return withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        let anchor: TaskEventAppendState | null = null;
        let restoredAnchor: TaskEventAppendState | null = null;
        const inspection = inspectTaskEventFile(eventFile, taskId, {
            onIntegrityEvent: (record) => {
                if (record.task_id !== taskId || !isPlainRecord(record.details)) {
                    return;
                }
                if (!isPlainRecord(record.integrity)
                    || !Number.isSafeInteger(record.integrity.task_sequence)
                    || Number(record.integrity.task_sequence) < 1
                    || typeof record.integrity.event_sha256 !== 'string'
                    || !/^[0-9a-f]{64}$/u.test(record.integrity.event_sha256)) {
                    throw new Error('manifest capture event contains malformed integrity evidence.');
                }
                if (record.event_type === 'SPLIT_REQUIRED_WIP_CAPTURED'
                    && typeof record.details.manifest_path === 'string'
                    && samePath(record.details.manifest_path, manifestPath)
                    && record.details.manifest_sha256 === manifestSha256) {
                    if (anchor) {
                        throw new Error('manifest is bound to multiple canonical capture events.');
                    }
                    anchor = {
                        matching_events: Number(record.integrity.task_sequence),
                        parse_errors: 0,
                        last_integrity_sequence: Number(record.integrity.task_sequence),
                        last_event_sha256: record.integrity.event_sha256
                    };
                }
                if (record.event_type !== 'SPLIT_REQUIRED_WIP_RESTORED'
                    || typeof record.details.manifest_path !== 'string'
                    || !samePath(record.details.manifest_path, manifestPath)
                    || record.details.manifest_sha256 !== manifestSha256
                    || !Array.isArray(record.details.selected_paths)
                    || !sameStrings(record.details.selected_paths, selectedPaths)) {
                    return;
                }
                if (restoredAnchor) {
                    throw new Error('manifest selection is bound to multiple canonical restore events.');
                }
                const taskSequence = Number(record.integrity.task_sequence);
                const previousHash = record.integrity.prev_event_sha256;
                if (previousHash !== null
                    && (typeof previousHash !== 'string' || !/^[0-9a-f]{64}$/u.test(previousHash))) {
                    throw new Error('manifest restore event contains malformed predecessor integrity evidence.');
                }
                restoredAnchor = {
                    matching_events: taskSequence - 1,
                    parse_errors: 0,
                    last_integrity_sequence: previousHash === null ? null : taskSequence - 1,
                    last_event_sha256: previousHash === null ? null : String(previousHash)
                };
            }
        });
        if (inspection.status === 'FAILED'
            || inspection.parse_errors > 0
            || inspection.task_id_mismatches > 0
            || inspection.duplicate_event_hashes.length > 0
            || inspection.violations.length > 0) {
            throw new Error(
                `task timeline is not safe for restore handoff identity: status=${inspection.status}; `
                + `violations=${inspection.violations.join(' | ') || 'none'}`
            );
        }
        if (!anchor) {
            throw new Error('WIP manifest is not bound to a canonical split-required capture event.');
        }
        return restoredAnchor || readTaskEventAppendState(eventFile, taskId);
    });
}

function expectedRestoredFiles(manifest: SplitRequiredWipManifest, selectedPaths: readonly string[]): string[] {
    const selected = new Set(selectedPaths);
    return [
        ...selectedFiles(manifest.tracked_files, selected),
        ...selectedFiles(manifest.untracked_files, selected)
    ].map((entry) => normalizeGitPath(entry.path)).sort();
}

function readFileEvidence(repoRoot: string, relativePath: string): SplitRequiredWipRestoreFileEvidence {
    const snapshot = readAuthenticatedRepoFileSnapshot(
        repoRoot,
        relativePath,
        MAX_RESTORED_FILE_EVIDENCE_BYTES
    );
    if (!snapshot.exists || snapshot.content === null) {
        return { path: relativePath, exists: false, sha256: null, bytes: 0 };
    }
    return {
        path: relativePath,
        exists: true,
        sha256: sha256(snapshot.content),
        bytes: snapshot.content.length
    };
}

function assertEvidenceMatchesManifest(
    manifest: SplitRequiredWipManifest,
    evidence: readonly SplitRequiredWipRestoreFileEvidence[]
): void {
    const tracked = new Map(manifest.tracked_files.map((entry) => [normalizeGitPath(entry.path), entry]));
    const untracked = new Map(manifest.untracked_files.map((entry) => [normalizeGitPath(entry.path), entry]));
    for (const file of evidence) {
        const trackedEntry = tracked.get(file.path);
        if (trackedEntry) {
            const expectedSha256 = trackedEntry.worktree_sha256;
            if (expectedSha256 == null ? file.exists : !file.exists || file.sha256 !== expectedSha256) {
                throw new Error(
                    `restored tracked file does not match manifest worktree evidence: ${file.path}`
                );
            }
            continue;
        }
        const untrackedEntry = untracked.get(file.path);
        if (!untrackedEntry || !file.exists || file.sha256 !== untrackedEntry.sha256) {
            throw new Error(`restored untracked file does not match manifest evidence: ${file.path}`);
        }
    }
}

function workspaceStateSha256(
    repoRoot: string,
    restoredFiles: readonly string[],
    evidence: readonly SplitRequiredWipRestoreFileEvidence[]
): string {
    const status = restoredFiles.length === 0
        ? Buffer.alloc(0)
        : runGitBinary(repoRoot, [
            'status',
            '--porcelain=v2',
            '-z',
            '--untracked-files=all',
            '--',
            ...restoredFiles
        ]);
    return sha256(Buffer.concat([
        Buffer.from(JSON.stringify(evidence), 'utf8'),
        Buffer.from([0]),
        status
    ]));
}

function serializeHandoff(value: unknown): Buffer {
    const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    if (content.length > MAX_HANDOFF_BYTES) {
        throw new Error(`restore handoff exceeds the ${MAX_HANDOFF_BYTES}-byte limit.`);
    }
    return content;
}

function writeJsonExclusive(repoRoot: string, filePath: string, value: unknown): fs.Stats {
    const relativePath = normalizeGitPath(path.relative(repoRoot, filePath));
    return writeExclusiveRepoFile(repoRoot, relativePath, serializeHandoff(value));
}

export function replaceSplitRequiredWipRestoreHandoff(
    handoffPath: string,
    handoff: SplitRequiredWipRestoreHandoff,
    expectedCurrentHandoff: SplitRequiredWipRestoreHandoff
): void {
    const repoRoot = path.resolve(handoff.repo_root);
    const relativeHandoffPath = normalizeGitPath(path.relative(repoRoot, handoffPath));
    const current = readAuthenticatedRepoFileSnapshot(repoRoot, relativeHandoffPath, MAX_HANDOFF_BYTES);
    if (!current.exists || current.content === null || current.identity === null) {
        throw new Error('restore handoff path is not a regular file.');
    }
    const expectedCurrentContent = serializeHandoff(expectedCurrentHandoff);
    if (!current.content.equals(expectedCurrentContent)) {
        throw new Error('restore handoff changed after its state was verified.');
    }
    const content = serializeHandoff(handoff);
    const replacedIdentity = replaceAuthenticatedRepoFile(
        repoRoot,
        relativeHandoffPath,
        content,
        current
    );
    const replaced = readAuthenticatedRepoFileSnapshot(repoRoot, relativeHandoffPath, MAX_HANDOFF_BYTES);
    if (!replaced.exists
        || replaced.content === null
        || replaced.identity === null
        || !sameFileIdentity(replacedIdentity, replaced.identity)
        || !content.equals(replaced.content)) {
        throw new Error('restore handoff replacement did not preserve authenticated bytes.');
    }
}

export function resolveSplitRequiredWipRestoreHandoffIdentity(params: {
    repoRoot: string;
    taskId: string;
    manifestPath: string;
    includePaths?: readonly string[];
}): SplitRequiredWipRestoreHandoffIdentity {
    const repoRoot = path.resolve(params.repoRoot || '.');
    const taskId = assertCanonicalTaskId(params.taskId);
    const manifestPath = resolveInputPathInsideRepo(repoRoot, params.manifestPath, 'ManifestPath');
    const wipRoot = resolveWipRoot(repoRoot, taskId);
    if (!pathIsInside(path.resolve(manifestPath), path.resolve(wipRoot))) {
        throw new Error('WIP manifest must be a regular file inside the task-owned split-required WIP root.');
    }
    const manifestSnapshot = readAuthenticatedManifestSnapshot(repoRoot, manifestPath, wipRoot);
    const manifest = manifestSnapshot.manifest;
    if (manifest.task_id !== taskId) {
        throw new Error(`WIP manifest task_id mismatch: expected=${taskId}; actual=${manifest.task_id}.`);
    }
    if (manifest.status !== 'suspended') {
        throw new Error(`WIP manifest status must be suspended; found ${manifest.status}.`);
    }
    const selectedPaths = [...normalizeSelectedPaths(params.includePaths || [])].sort();
    const restorablePaths = new Set([
        ...manifest.tracked_files.map((entry) => normalizeGitPath(entry.path)),
        ...manifest.untracked_files.map((entry) => normalizeGitPath(entry.path))
    ]);
    for (const selectedPath of selectedPaths) {
        if (!restorablePaths.has(selectedPath)) {
            throw new Error(`selected path is not present in WIP manifest: ${selectedPath}`);
        }
    }
    const manifestSha256 = manifestSnapshot.sha256;
    const timelineAnchor = resolveRestoreTimelineAnchor(
        repoRoot,
        taskId,
        manifestPath,
        manifestSha256,
        selectedPaths
    );
    const identityPayload = JSON.stringify({
        schema_version: HANDOFF_SCHEMA_VERSION,
        repo_root: canonicalRoot(repoRoot),
        task_id: taskId,
        manifest_path: normalizePath(manifestPath),
        manifest_sha256: manifestSha256,
        selected_paths: selectedPaths,
        timeline_anchor: timelineAnchor
    });
    const handoffId = sha256(identityPayload);
    return {
        repoRoot,
        taskId,
        manifestPath,
        manifestSha256,
        manifest,
        selectedPaths,
        restoredFiles: expectedRestoredFiles(manifest, selectedPaths),
        timelineAnchor,
        handoffId,
        handoffPath: path.join(path.dirname(manifestPath), `restore-handoff-${handoffId}.json`)
    };
}

export function prepareSplitRequiredWipRestoreHandoff(
    identity: SplitRequiredWipRestoreHandoffIdentity,
    timelineAnchor: TaskEventAppendState
): SplitRequiredWipRestoreHandoff {
    if (!sameTimelineAnchor(timelineAnchor, identity.timelineAnchor)) {
        throw new Error('restore handoff timeline anchor does not match the canonical manifest capture event.');
    }
    const handoff: SplitRequiredWipRestoreHandoff = {
        schema_version: HANDOFF_SCHEMA_VERSION,
        kind: HANDOFF_KIND,
        status: 'prepared',
        handoff_id: identity.handoffId,
        repo_root: canonicalRoot(identity.repoRoot),
        task_id: identity.taskId,
        manifest_path: normalizePath(identity.manifestPath),
        manifest_sha256: identity.manifestSha256,
        selected_paths: [...identity.selectedPaths],
        restored_files: [...identity.restoredFiles],
        timeline_anchor: { ...identity.timelineAnchor },
        created_at_utc: new Date().toISOString()
    };
    writeJsonExclusive(identity.repoRoot, identity.handoffPath, handoff);
    return handoff;
}

export function promotePreparedSplitRequiredWipRestoreHandoff(
    identity: SplitRequiredWipRestoreHandoffIdentity
): SplitRequiredWipRestoreHandoff {
    const { handoff: prepared, manifest } = readAndVerifySplitRequiredWipRestoreHandoffSnapshot(identity);
    if (prepared.status !== 'prepared') {
        throw new Error(`restore handoff must be prepared before promotion; found ${prepared.status}.`);
    }
    const restoredFileEvidence = identity.restoredFiles.map((filePath) => (
        readFileEvidence(identity.repoRoot, filePath)
    ));
    assertEvidenceMatchesManifest(manifest, restoredFileEvidence);
    const pending: SplitRequiredWipRestoreHandoff = {
        ...prepared,
        status: 'pending',
        restored_file_evidence: restoredFileEvidence,
        workspace_state_sha256: workspaceStateSha256(
            identity.repoRoot,
            identity.restoredFiles,
            restoredFileEvidence
        )
    };
    replaceSplitRequiredWipRestoreHandoff(identity.handoffPath, pending, prepared);
    return pending;
}

function parseHandoff(identity: SplitRequiredWipRestoreHandoffIdentity): SplitRequiredWipRestoreHandoff {
    const relativePath = normalizeGitPath(path.relative(identity.repoRoot, identity.handoffPath));
    const snapshot = readAuthenticatedRepoFileSnapshot(
        identity.repoRoot,
        relativePath,
        MAX_HANDOFF_BYTES
    );
    if (!snapshot.exists || snapshot.content === null || snapshot.identity === null) {
        throw new Error('restore handoff must be a bounded regular file without symlink indirection.');
    }
    if (snapshot.content.length > MAX_HANDOFF_BYTES) {
        throw new Error('restore handoff identity or bounded-file contract changed while opening.');
    }
    const parsed: unknown = JSON.parse(snapshot.content.toString('utf8'));
    if (!isPlainRecord(parsed)
        || parsed.schema_version !== HANDOFF_SCHEMA_VERSION
        || parsed.kind !== HANDOFF_KIND
        || (parsed.status !== 'prepared' && parsed.status !== 'pending' && parsed.status !== 'finalized')) {
        throw new Error('restore handoff is malformed or uses an unsupported schema.');
    }
    return parsed as unknown as SplitRequiredWipRestoreHandoff;
}

export function readAndVerifySplitRequiredWipRestoreHandoff(
    identity: SplitRequiredWipRestoreHandoffIdentity
): SplitRequiredWipRestoreHandoff {
    return readAndVerifySplitRequiredWipRestoreHandoffSnapshot(identity).handoff;
}

export function readAndVerifySplitRequiredWipRestoreHandoffSnapshot(
    identity: SplitRequiredWipRestoreHandoffIdentity
): { handoff: SplitRequiredWipRestoreHandoff; manifest: SplitRequiredWipManifest } {
    const handoff = parseHandoff(identity);
    const snapshot = readAuthenticatedManifestSnapshot(
        identity.repoRoot,
        identity.manifestPath,
        resolveWipRoot(identity.repoRoot, identity.taskId)
    );
    if (snapshot.sha256 !== identity.manifestSha256) {
        throw new Error('WIP manifest changed after the runtime handoff identity was created.');
    }
    if (handoff.handoff_id !== identity.handoffId
        || handoff.task_id !== identity.taskId
        || !samePath(handoff.repo_root, canonicalRoot(identity.repoRoot))
        || !samePath(handoff.manifest_path, identity.manifestPath)
        || handoff.manifest_sha256 !== identity.manifestSha256
        || !sameStrings(handoff.selected_paths, identity.selectedPaths)
        || !sameStrings(handoff.restored_files, identity.restoredFiles)
        || !sameTimelineAnchor(handoff.timeline_anchor, identity.timelineAnchor)) {
        throw new Error(
            'restore handoff identity does not match the repository, task, manifest, selected paths, or timeline anchor.'
        );
    }
    if (handoff.status === 'prepared') {
        if (handoff.restored_file_evidence !== undefined
            || handoff.workspace_state_sha256 !== undefined) {
            throw new Error('prepared restore handoff must not claim restored workspace evidence.');
        }
        return { handoff, manifest: snapshot.manifest };
    }
    if (!Array.isArray(handoff.restored_file_evidence)
        || typeof handoff.workspace_state_sha256 !== 'string') {
        throw new Error('pending or finalized restore handoff is missing restored workspace evidence.');
    }
    const currentEvidence = identity.restoredFiles.map((filePath) => (
        readFileEvidence(identity.repoRoot, filePath)
    ));
    assertEvidenceMatchesManifest(snapshot.manifest, currentEvidence);
    if (JSON.stringify(currentEvidence) !== JSON.stringify(handoff.restored_file_evidence)
        || workspaceStateSha256(identity.repoRoot, identity.restoredFiles, currentEvidence)
            !== handoff.workspace_state_sha256) {
        throw new Error('restored workspace changed after the runtime handoff was created.');
    }
    return { handoff, manifest: snapshot.manifest };
}
