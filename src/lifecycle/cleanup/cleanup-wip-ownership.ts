import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    assertBoundContainedRemovalTree, assertContainedDestination, bindContainedDestination, readBoundedContainedDirectory,
    type ContainedDestination
} from '../../core/contained-filesystem';
import { isPlainRecord } from '../../core/records';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { normalizePath } from '../../gates/shared/helpers';
import {
    normalizeGitPath, resolveInputPathInsideRepo, resolveWipRoot, stableTimestampSlug,
    type SplitRequiredWipManifest
} from '../../gates/split-required/split-required-wip-contracts';
import { readAuthenticatedRepoFileSnapshot } from '../../gates/split-required/split-required-wip-restore-plan';
import {
    buildSplitRequiredWipRestoreHandoffId, expectedRestoredFiles,
    readAuthenticatedSplitRequiredWipManifestSnapshot,
    type SplitRequiredWipRestoreHandoff, type SplitRequiredWipRuntimeGeneration
} from '../../gates/split-required/split-required-wip-runtime-handoff-contracts';

export const WIP_CLEANUP_LIMITS = Object.freeze({
    artifactBytes: 64 * 1024 * 1024, packageBytes: 256 * 1024 * 1024,
    authorityBytes: 256 * 1024 * 1024,
    snapshotBytes: 64 * 1024 * 1024,
    handoffBytes: 256 * 1024, queueBytes: 16 * 1024 * 1024,
    entries: 4096, selectedTasks: 128, queueRows: 4096
});

export interface WipCleanupReadBudget {
    remainingBytes: number;
    remainingEntries: number;
    remainingSnapshotBytes?: number;
}

// Conservative admission weights for retained identities and escaped path characters,
// rather than a measurement of the JavaScript heap.
const SNAPSHOT_IDENTITY_BYTES = 256;
const SNAPSHOT_PATH_CHARACTER_BYTES = 6;

function snapshotPathBytes(characters: number): number {
    return SNAPSHOT_IDENTITY_BYTES + characters * SNAPSHOT_PATH_CHARACTER_BYTES;
}

function bindingSnapshotBytes(root: string, candidate: string): number {
    const resolvedRoot = path.resolve(root), relative = path.relative(resolvedRoot, path.resolve(candidate));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('WIP snapshot path escapes its containment root.');
    }
    let characters = resolvedRoot.length, bytes = SNAPSHOT_IDENTITY_BYTES + snapshotPathBytes(characters);
    for (const component of relative ? relative.split(path.sep) : []) {
        characters += 1 + component.length;
        bytes += snapshotPathBytes(characters);
    }
    return bytes;
}

function reserveSnapshotBudget(local: { remainingBytes: number }, bytes: number, shared?: WipCleanupReadBudget): void {
    const sharedRemaining = shared?.remainingSnapshotBytes === undefined
        ? WIP_CLEANUP_LIMITS.snapshotBytes : shared.remainingSnapshotBytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > local.remainingBytes
        || !Number.isSafeInteger(sharedRemaining) || sharedRemaining < 0 || bytes > sharedRemaining) {
        local.remainingBytes = 0;
        if (shared) shared.remainingSnapshotBytes = 0;
        throw new Error('WIP snapshot metadata budget exceeded; select fewer packages or reduce declared ancestry.');
    }
    local.remainingBytes -= bytes;
    if (shared) shared.remainingSnapshotBytes = sharedRemaining - bytes;
}

function reserveReadBudget(budget: WipCleanupReadBudget, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0
        || !Number.isSafeInteger(budget.remainingBytes) || budget.remainingBytes < 0
        || !Number.isSafeInteger(budget.remainingEntries) || budget.remainingEntries < 1
        || bytes > budget.remainingBytes) {
        budget.remainingEntries = 0;
        throw new Error('WIP aggregate read budget exceeded; select fewer packages or reduce canonical authority.');
    }
    budget.remainingBytes -= bytes;
    budget.remainingEntries -= 1;
}

export interface WipCleanupFile {
    binding: ContainedDestination;
    bytes: number;
    sha256: string;
    identity: string;
}

export interface AuthenticatedWipPackage {
    taskId: string;
    manifestPath: string;
    rootBinding: ContainedDestination;
    manifest: SplitRequiredWipManifest;
    manifestSha256: string;
    files: WipCleanupFile[];
    directories: ContainedDestination[];
    treeSha256: string;
    handoffs: Array<{ path: string; value: SplitRequiredWipRestoreHandoff }>;
}

export function wipCleanupSha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

export function wipCleanupPathKey(value: string): string {
    const resolved = normalizePath(path.resolve(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function wipCleanupBindingIdentity(binding: ContainedDestination): string {
    const identity = createHash('sha256');
    for (const item of binding.existing) {
        identity.update(JSON.stringify([normalizePath(item.path), String(item.dev),
            String(item.ino), String(item.mode), String(item.birthtimeNs)])).update('\n');
    }
    return identity.digest('hex');
}

function fileSnapshotIdentity(binding: ContainedDestination, stat: fs.BigIntStats): string {
    return wipCleanupSha256(JSON.stringify([wipCleanupBindingIdentity(binding), String(stat.size),
        String(stat.mtimeNs), String(stat.ctimeNs)]));
}

function assertFileSnapshotCurrent(file: WipCleanupFile): void {
    assertContainedDestination(file.binding);
    const stat = fs.lstatSync(file.binding.path, { bigint: true });
    assertContainedDestination(file.binding);
    if (fileSnapshotIdentity(file.binding, stat) !== file.identity) {
        throw new Error(`WIP authenticated file changed before snapshot completion: ${normalizePath(file.binding.path)}`);
    }
}

function sameDirectorySnapshot(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
    return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
        && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

export function readWipCleanupFile(root: string, file: string, maxBytes: number, budget?: WipCleanupReadBudget): WipCleanupFile & { content: Buffer } {
    reserveSnapshotBudget({ remainingBytes: WIP_CLEANUP_LIMITS.snapshotBytes }, bindingSnapshotBytes(root, file), budget);
    const binding = bindContainedDestination(root, file);
    return readBoundWipCleanupFile(binding, maxBytes, budget);
}

function readBoundWipCleanupFile(
    binding: ContainedDestination, maxBytes: number, budget?: WipCleanupReadBudget, declaredBytes?: number
): WipCleanupFile & { content: Buffer } {
    const { root, path: file } = binding;
    assertContainedDestination(binding);
    const before = fs.lstatSync(file, { bigint: true }), identity = fileSnapshotIdentity(binding, before);
    const observedSize = Number(before.size);
    if (budget) reserveReadBudget(budget, observedSize);
    if (declaredBytes !== undefined && observedSize !== declaredBytes) {
        throw new Error(`WIP declared artifact bytes changed: ${normalizePath(file)}`);
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || observedSize > maxBytes) {
        throw new Error(`WIP cleanup file exceeds the ${maxBytes}-byte limit: ${normalizePath(file)}`);
    }
    const snapshot = readAuthenticatedRepoFileSnapshot(root, normalizeGitPath(path.relative(root, file)), Math.min(maxBytes, observedSize));
    if (!snapshot.exists || snapshot.content === null || snapshot.identity === null || snapshot.identity.nlink !== 1) {
        throw new Error(`WIP cleanup requires a regular unshared file: ${normalizePath(file)}`);
    }
    assertContainedDestination(binding);
    const stat = fs.lstatSync(file, { bigint: true });
    assertContainedDestination(binding);
    if (fileSnapshotIdentity(binding, stat) !== identity) {
        throw new Error(`WIP file changed while authenticating its snapshot: ${normalizePath(file)}`);
    }
    return { binding, content: snapshot.content, bytes: snapshot.content.length,
        sha256: wipCleanupSha256(snapshot.content),
        identity };
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
    if (!isPlainRecord(value)) throw new Error(`WIP ${label} must be an object.`);
}

function assertString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`WIP ${label} must be a nonempty string.`);
}

function assertHash(value: unknown, label: string): void {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`WIP ${label} must be SHA256.`);
}

function assertIsoDate(value: unknown, label: string): void {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
        throw new Error(`WIP ${label} must be a canonical UTC timestamp.`);
    }
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
    if (!Array.isArray(value) || value.length > WIP_CLEANUP_LIMITS.entries) throw new Error(`WIP ${label} is not a bounded array.`);
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
    if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`WIP ${label} contains unknown schema fields.`);
}

function sourcePath(value: unknown): string {
    assertString(value, 'source path');
    let depth = 1;
    for (const character of value) {
        if (character === '/' && ++depth > WIP_CLEANUP_LIMITS.entries) {
            throw new Error('WIP source path depth limit exceeded.');
        }
    }
    const normalized = normalizeGitPath(value);
    if (normalized !== value || path.posix.isAbsolute(normalized)
        || normalized.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/u.test(part)
            || /[. ]$/u.test(part))) throw new Error(`WIP source path is not canonical: ${value}`);
    return normalized;
}

function assertByteCount(value: unknown): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > WIP_CLEANUP_LIMITS.artifactBytes) {
        throw new Error('WIP artifact byte count exceeds the supported bound.');
    }
}

function validatePatch(root: string, packageRoot: string, value: unknown, name: string): void {
    assertRecord(value, `${name} patch`);
    assertKnownKeys(value, ['path', 'sha256', 'bytes', 'empty'], `${name} patch`);
    assertString(value.path, `${name} patch path`);
    assertHash(value.sha256, `${name} patch hash`);
    assertByteCount(value.bytes);
    if (value.empty !== (value.bytes === 0)
        || wipCleanupPathKey(resolveInputPathInsideRepo(root, value.path, 'PatchPath'))
            !== wipCleanupPathKey(path.join(packageRoot, `${name}.patch`))) {
        throw new Error(`WIP ${name} patch identity or empty flag is invalid.`);
    }
}

function validateFileDeclarations(manifest: Record<string, unknown>, root: string, packageRoot: string): void {
    const sources = new Set<string>();
    for (const field of ['tracked_files', 'untracked_files'] as const) {
        assertArray(manifest[field], field);
        for (const value of manifest[field]) {
            assertRecord(value, field);
            const source = sourcePath(value.path), key = wipCleanupPathKey(path.resolve(root, source));
            if (sources.has(key)) throw new Error(`WIP source file is declared more than once: ${source}`);
            sources.add(key);
            if (field === 'untracked_files') {
                assertKnownKeys(value, ['path', 'artifact_path', 'sha256', 'bytes'], field);
                assertString(value.artifact_path, 'untracked artifact path');
                assertHash(value.sha256, 'untracked hash');
                assertByteCount(value.bytes);
                if (wipCleanupPathKey(resolveInputPathInsideRepo(root, value.artifact_path, 'ArtifactPath'))
                    !== wipCleanupPathKey(path.join(packageRoot, 'untracked', source))) {
                    throw new Error(`WIP artifact does not match its declared source: ${source}`);
                }
            } else {
                assertKnownKeys(value, ['path', 'head_sha256', 'worktree_sha256', 'staged', 'unstaged'], field);
                if (value.head_sha256 !== null && (typeof value.head_sha256 !== 'string'
                    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.head_sha256))) {
                    throw new Error('WIP head_sha256 must be a Git object identity.');
                }
                if (value.worktree_sha256 !== null) assertHash(value.worktree_sha256, 'worktree_sha256');
                if (typeof value.staged !== 'boolean' || typeof value.unstaged !== 'boolean') {
                    throw new Error('WIP tracked-file flags must be booleans.');
                }
            }
        }
    }
}

function validateManifest(value: unknown, root: string, taskId: string, manifestPath: string): SplitRequiredWipManifest {
    assertRecord(value, 'manifest');
    assertKnownKeys(value, ['schema_version', 'kind', 'status', 'task_id', 'guard_kind', 'guard_reason',
        'created_at_utc', 'retired_at_utc', 'retired_reason', 'base_commit', 'preflight_path', 'preflight_sha256',
        'patches', 'tracked_files', 'untracked_files', 'unrelated_untracked_files', 'ignored_runtime_artifacts',
        'restore_commands'], 'manifest');
    if (value.schema_version !== 1 || value.kind !== 'split_required_wip'
        || typeof value.status !== 'string' || !['suspended', 'retired'].includes(value.status) || value.task_id !== taskId
        || typeof value.guard_kind !== 'string' || !['scope_budget', 'review_cycle', 'strict_decomposition'].includes(value.guard_kind)) {
        throw new Error('WIP manifest schema, task identity, status or guard kind is invalid.');
    }
    assertCanonicalTaskId(taskId);
    assertString(value.guard_reason, 'guard reason');
    assertIsoDate(value.created_at_utc, 'creation date');
    const packageRoot = path.dirname(manifestPath);
    if (wipCleanupPathKey(manifestPath) !== wipCleanupPathKey(path.join(packageRoot, 'manifest.json'))
        || wipCleanupPathKey(path.dirname(packageRoot)) !== wipCleanupPathKey(resolveWipRoot(root, taskId))
        || path.basename(packageRoot) !== stableTimestampSlug(String(value.created_at_utc))) {
        throw new Error('WIP manifest is outside its exact canonical capture package.');
    }
    if (typeof value.base_commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.base_commit)) {
        throw new Error('WIP base commit is invalid.');
    }
    assertString(value.preflight_path, 'preflight path');
    resolveInputPathInsideRepo(root, value.preflight_path, 'PreflightPath');
    assertHash(value.preflight_sha256, 'preflight hash');
    assertRecord(value.patches, 'patches');
    assertKnownKeys(value.patches, ['staged', 'unstaged'], 'patches');
    validatePatch(root, packageRoot, value.patches.staged, 'staged');
    validatePatch(root, packageRoot, value.patches.unstaged, 'unstaged');
    validateFileDeclarations(value, root, packageRoot);
    for (const field of ['unrelated_untracked_files', 'ignored_runtime_artifacts']) {
        assertArray(value[field], field);
        for (const item of value[field]) {
            sourcePath(field === 'ignored_runtime_artifacts' && typeof item === 'string' && item.endsWith('/')
                ? item.slice(0, -1) : item);
        }
    }
    assertRecord(value.restore_commands, 'restore commands');
    const restoreCommandFields = ['list', 'preview_full', 'restore_full', 'preview_partial_template', 'restore_partial_template', 'retire'];
    assertKnownKeys(value.restore_commands, restoreCommandFields, 'restore commands');
    for (const field of restoreCommandFields) {
        assertString(value.restore_commands[field], `restore command ${field}`);
    }
    if (value.status === 'retired') {
        assertIsoDate(value.retired_at_utc, 'retirement date');
        assertString(value.retired_reason, 'retirement reason');
    } else if ('retired_at_utc' in value || 'retired_reason' in value) {
        throw new Error('WIP suspended manifest claims retirement metadata.');
    }
    return value as unknown as SplitRequiredWipManifest;
}

function declaredArtifacts(root: string, manifestPath: string, manifest: SplitRequiredWipManifest): Map<string, { sha256: string; bytes: number } | null> {
    return new Map<string, { sha256: string; bytes: number } | null>([
        [wipCleanupPathKey(manifestPath), null],
        ...[manifest.patches.staged, manifest.patches.unstaged].map(item => [
            wipCleanupPathKey(resolveInputPathInsideRepo(root, item.path, 'PatchPath')), item
        ] as const),
        ...manifest.untracked_files.map(item => [
            wipCleanupPathKey(resolveInputPathInsideRepo(root, item.artifact_path, 'ArtifactPath')), item
        ] as const)
    ]);
}

interface DeclaredDirectory {
    children: Map<string, DeclaredDirectory>;
    pathCharacters: number;
    ancestryBytes: number;
}

function directoryNameKey(value: string): string {
    return process.platform === 'win32' ? value.toLowerCase() : value;
}

function allowedDirectories(rootBinding: ContainedDestination, files: ReadonlyMap<string, unknown>, manifest: SplitRequiredWipManifest): {
    declaration: DeclaredDirectory; snapshotBytes: number;
} {
    const packageRoot = rootBinding.path;
    const allowed: DeclaredDirectory = { children: new Map(), pathCharacters: packageRoot.length,
        ancestryBytes: rootBinding.existing.reduce((bytes, item) => bytes + snapshotPathBytes(item.path.length), 0) };
    let snapshotBytes = 0;
    let directoryCount = 1;
    // Each payload admits its original and suspended directory tree.
    const directoryLimit = WIP_CLEANUP_LIMITS.entries * 2;
    const paths = [...files.keys(), ...manifest.untracked_files.map(item =>
        path.join(packageRoot, 'suspended-untracked', item.path))];
    for (const file of paths) {
        const components = normalizePath(path.relative(packageRoot, file)).split('/');
        const filename = components.pop()!;
        let directory = allowed;
        for (const component of components) {
            const key = directoryNameKey(component);
            let child = directory.children.get(key);
            if (!child) {
                if (directoryCount >= directoryLimit) throw new Error('WIP declared directory limit exceeded.');
                const pathCharacters = directory.pathCharacters + 1 + component.length;
                child = { children: new Map(), pathCharacters,
                    ancestryBytes: directory.ancestryBytes + snapshotPathBytes(pathCharacters) };
                directory.children.set(key, child);
                directoryCount += 1;
                snapshotBytes += SNAPSHOT_IDENTITY_BYTES + child.ancestryBytes;
            }
            directory = child;
        }
        if (files.has(file)) snapshotBytes += SNAPSHOT_IDENTITY_BYTES + directory.ancestryBytes
            + snapshotPathBytes(directory.pathCharacters + 1 + filename.length);
    }
    return { declaration: allowed, snapshotBytes };
}

function assertHandoffPaths(value: unknown, label: string): asserts value is string[] {
    assertArray(value, label);
    const paths = value.map(sourcePath);
    const sorted = [...paths].sort();
    if (new Set(paths).size !== paths.length || paths.some((item, index) => item !== sorted[index])) {
        throw new Error(`WIP ${label} must contain unique sorted source paths.`);
    }
}

function assertHandoffAnchor(value: unknown): asserts value is SplitRequiredWipRestoreHandoff['timeline_anchor'] {
    assertRecord(value, 'restore timeline anchor');
    assertKnownKeys(value, ['matching_events', 'parse_errors', 'last_integrity_sequence', 'last_event_sha256'], 'restore timeline anchor');
    if (!Number.isSafeInteger(value.matching_events) || Number(value.matching_events) < 1
        || value.parse_errors !== 0 || value.last_integrity_sequence !== value.matching_events) {
        throw new Error('WIP restore timeline anchor is malformed.');
    }
    assertHash(value.last_event_sha256, 'restore timeline anchor hash');
}

function assertRestoredEvidence(value: Record<string, unknown>, manifest: SplitRequiredWipManifest, restoredFiles: string[]): void {
    assertArray(value.restored_file_evidence, 'restored file evidence');
    if (value.restored_file_evidence.length !== restoredFiles.length) throw new Error('WIP restored evidence does not cover the exact restored files.');
    const declared = new Map([...manifest.tracked_files.map(file => [file.path, file.worktree_sha256] as const),
        ...manifest.untracked_files.map(file => [file.path, file.sha256] as const)]);
    const untrackedBytes = new Map(manifest.untracked_files.map(file => [file.path, file.bytes]));
    for (const [index, file] of value.restored_file_evidence.entries()) {
        assertRecord(file, 'restored file evidence');
        assertKnownKeys(file, ['path', 'exists', 'sha256', 'bytes'], 'restored file evidence');
        const expectedHash = declared.get(restoredFiles[index]);
        assertByteCount(file.bytes);
        if (file.path !== restoredFiles[index] || typeof file.exists !== 'boolean'
            || file.exists !== (expectedHash !== null) || file.sha256 !== expectedHash
            || untrackedBytes.has(restoredFiles[index]) && file.bytes !== untrackedBytes.get(restoredFiles[index])
            || !file.exists && file.bytes !== 0) throw new Error('WIP restored evidence conflicts with declared source work.');
    }
    assertHash(value.workspace_state_sha256, 'restored workspace state hash');
}

function assertFinalizedHandoffShape(value: Record<string, unknown>, root: string): void {
    assertIsoDate(value.finalized_at_utc, 'restore finalization date');
    if (String(value.finalized_at_utc) < String(value.created_at_utc)) throw new Error('WIP restore finalization precedes handoff creation.');
    assertRecord(value.runtime_generation, 'restore runtime generation');
    const generation = value.runtime_generation;
    assertKnownKeys(generation, ['build_root', 'input_fingerprint_sha256', 'finalizer_sha256', 'writer_sha256'], 'restore runtime generation');
    if (typeof generation.build_root !== 'string'
        || wipCleanupPathKey(generation.build_root) !== wipCleanupPathKey(path.join(root, 'dist'))) {
        throw new Error('WIP restore runtime generation has a foreign build root.');
    }
    for (const field of ['input_fingerprint_sha256', 'finalizer_sha256', 'writer_sha256']) assertHash(generation[field], `restore runtime ${field}`);
    assertRecord(value.event_integrity, 'restore event integrity');
    const integrity = value.event_integrity;
    assertKnownKeys(integrity, ['schema_version', 'task_sequence', 'prev_event_sha256', 'event_sha256'], 'restore event integrity');
    if ((integrity.schema_version !== 1 && integrity.schema_version !== 2)
        || !Number.isSafeInteger(integrity.task_sequence) || Number(integrity.task_sequence) < 2) {
        throw new Error('WIP restore event integrity is malformed.');
    }
    assertHash(integrity.prev_event_sha256, 'restore event predecessor');
    assertHash(integrity.event_sha256, 'restore event hash');
}

export function sameWipRestoreRuntimeGeneration(value: unknown, expected: SplitRequiredWipRuntimeGeneration): boolean {
    return isPlainRecord(value) && Object.keys(value).length === 4
        && value.build_root === expected.build_root
        && value.input_fingerprint_sha256 === expected.input_fingerprint_sha256
        && value.finalizer_sha256 === expected.finalizer_sha256
        && value.writer_sha256 === expected.writer_sha256;
}

function readHandoff(root: string, file: string, manifest: SplitRequiredWipManifest,
    manifestPath: string, manifestSha256: string, content: Buffer): SplitRequiredWipRestoreHandoff {
    const parsed: unknown = JSON.parse(content.toString('utf8'));
    assertRecord(parsed, 'restore handoff');
    assertKnownKeys(parsed, ['schema_version', 'kind', 'status', 'handoff_id', 'repo_root', 'task_id',
        'manifest_path', 'manifest_sha256', 'selected_paths', 'restored_files', 'restored_file_evidence',
        'workspace_state_sha256', 'timeline_anchor', 'created_at_utc', 'finalized_at_utc',
        'runtime_generation', 'event_integrity'], 'restore handoff');
    if (parsed.schema_version !== 1 || parsed.kind !== 'split_required_wip_restore_handoff'
        || typeof parsed.status !== 'string' || !['prepared', 'pending', 'finalized'].includes(parsed.status) || parsed.task_id !== manifest.task_id
        || typeof parsed.manifest_path !== 'string' || wipCleanupPathKey(resolveInputPathInsideRepo(root, parsed.manifest_path, 'HandoffManifestPath')) !== wipCleanupPathKey(manifestPath)
        || path.basename(file) !== `restore-handoff-${parsed.handoff_id}.json`) {
        throw new Error('WIP restore handoff has malformed or conflicting ownership.');
    }
    assertHash(parsed.handoff_id, 'restore handoff ID');
    assertHash(parsed.manifest_sha256, 'restore manifest hash');
    if (manifest.status === 'suspended' && parsed.manifest_sha256 !== manifestSha256) {
        throw new Error('WIP restore handoff does not match the authenticated suspended manifest digest.');
    }
    if (typeof parsed.repo_root !== 'string' || wipCleanupPathKey(parsed.repo_root) !== wipCleanupPathKey(root)) {
        throw new Error('WIP restore handoff has a foreign repository root.');
    }
    assertIsoDate(parsed.created_at_utc, 'restore handoff creation date');
    assertHandoffPaths(parsed.selected_paths, 'restore selected paths');
    assertHandoffPaths(parsed.restored_files, 'restore restored files');
    const restorable = new Set([...manifest.tracked_files, ...manifest.untracked_files].map(item => item.path));
    if (parsed.selected_paths.some(item => !restorable.has(item))
        || JSON.stringify(parsed.restored_files) !== JSON.stringify(expectedRestoredFiles(manifest, parsed.selected_paths))) {
        throw new Error('WIP restore handoff conflicts with its exact manifest source selection.');
    }
    assertHandoffAnchor(parsed.timeline_anchor);
    if (parsed.handoff_id !== buildSplitRequiredWipRestoreHandoffId({ repoRoot: root, taskId: manifest.task_id,
        manifestPath: parsed.manifest_path, manifestSha256: String(parsed.manifest_sha256), selectedPaths: parsed.selected_paths,
        timelineAnchor: parsed.timeline_anchor })) throw new Error('WIP restore handoff ID does not bind its immutable ownership.');
    if (parsed.status !== 'prepared') assertRestoredEvidence(parsed, manifest, parsed.restored_files);
    else if (parsed.restored_file_evidence !== undefined || parsed.workspace_state_sha256 !== undefined) {
        throw new Error('WIP prepared restore handoff claims restored workspace evidence.');
    }
    if (parsed.status === 'finalized') assertFinalizedHandoffShape(parsed, root);
    else if (parsed.runtime_generation !== undefined || parsed.event_integrity !== undefined || parsed.finalized_at_utc !== undefined) {
        throw new Error('WIP unfinished restore handoff claims finalized restore authority.');
    }
    return parsed as unknown as SplitRequiredWipRestoreHandoff;
}

export function readAuthenticatedWipPackage(root: string, taskId: string, manifestPath: string, budget?: WipCleanupReadBudget): AuthenticatedWipPackage {
    const snapshotBudget = { remainingBytes: WIP_CLEANUP_LIMITS.snapshotBytes };
    reserveSnapshotBudget(snapshotBudget, bindingSnapshotBytes(root, path.dirname(manifestPath)), budget);
    const rootBinding = bindContainedDestination(root, path.dirname(manifestPath));
    if (rootBinding.missingAt) throw new Error('WIP package directory is missing.');
    reserveSnapshotBudget(snapshotBudget, bindingSnapshotBytes(root, manifestPath), budget);
    const manifestBytes = fs.lstatSync(manifestPath).size;
    if (budget) reserveReadBudget(budget, manifestBytes);
    const snapshot = readAuthenticatedSplitRequiredWipManifestSnapshot(root, manifestPath, resolveWipRoot(root, taskId), manifestBytes);
    const manifest = validateManifest(snapshot.manifest, root, taskId, manifestPath);
    const expected = declaredArtifacts(root, manifestPath, manifest), allowed = allowedDirectories(rootBinding, expected, manifest);
    reserveSnapshotBudget(snapshotBudget, allowed.snapshotBytes, budget);
    const files: WipCleanupFile[] = [], directories: ContainedDestination[] = [], handoffs: AuthenticatedWipPackage['handoffs'] = [];
    const directorySnapshots: Array<{ binding: ContainedDestination; stat: fs.BigIntStats }> = [];
    const pending = [{ binding: rootBinding, declaration: allowed.declaration }], tree: string[] = [];
    let bytes = 0;
    while (pending.length) {
        const { binding: directory, declaration: declaredDirectory } = pending.pop()!;
        assertContainedDestination(directory);
        const before = fs.lstatSync(directory.path, { bigint: true });
        if (budget) reserveReadBudget(budget, 0);
        directories.push(directory);
        tree.push(`directory:${wipCleanupBindingIdentity(directory)}`);
        const remainingEntries = WIP_CLEANUP_LIMITS.entries - files.length - directories.length - pending.length;
        const sharedEntries = budget ? budget.remainingEntries - pending.length : remainingEntries;
        const names = readBoundedContainedDirectory(directory, Math.min(remainingEntries, sharedEntries));
        for (const name of names) {
            if (files.length + directories.length + pending.length >= WIP_CLEANUP_LIMITS.entries) throw new Error('WIP package entry limit exceeded.');
            const file = path.join(directory.path, name);
            const stat = fs.lstatSync(file);
            if (stat.isDirectory()) {
                const childDeclaration = declaredDirectory.children.get(directoryNameKey(name));
                if (!childDeclaration) throw new Error(`WIP contains an undeclared directory: ${normalizePath(file)}`);
                pending.push({ binding: bindContainedDestination(root, file), declaration: childDeclaration });
                continue;
            }
            const handoff = /^restore-handoff-[0-9a-f]{64}\.json$/u.test(name) && path.dirname(file) === rootBinding.path;
            const declaration = expected.get(wipCleanupPathKey(file));
            if (declaration === undefined && !handoff) throw new Error(`WIP contains an undeclared file: ${normalizePath(file)}`);
            if (handoff) reserveSnapshotBudget(snapshotBudget, bindingSnapshotBytes(root, file), budget);
            const binding = bindContainedDestination(root, file);
            const memberLimit = handoff ? WIP_CLEANUP_LIMITS.handoffBytes : WIP_CLEANUP_LIMITS.artifactBytes;
            const current = readBoundWipCleanupFile(binding,
                Math.min(memberLimit, WIP_CLEANUP_LIMITS.packageBytes - bytes), budget, declaration?.bytes);
            bytes += current.bytes;
            if (bytes > WIP_CLEANUP_LIMITS.packageBytes) throw new Error('WIP package aggregate byte limit exceeded.');
            if (declaration && (declaration.sha256 !== current.sha256 || declaration.bytes !== current.bytes)) throw new Error(`WIP declared artifact bytes changed: ${normalizePath(file)}`);
            if (wipCleanupPathKey(file) === wipCleanupPathKey(manifestPath) && current.sha256 !== snapshot.sha256) throw new Error('WIP manifest changed while validating its package.');
            files.push({ binding, bytes: current.bytes, sha256: current.sha256, identity: current.identity });
            tree.push(`file:${current.identity}:${current.sha256}`);
            if (handoff) handoffs.push({ path: file,
                value: readHandoff(root, file, manifest, manifestPath, snapshot.sha256, current.content) });
        }
        const after = fs.lstatSync(directory.path, { bigint: true });
        if (!sameDirectorySnapshot(before, after)) throw new Error('WIP package directory changed while being enumerated.');
        assertContainedDestination(directory);
        directorySnapshots.push({ binding: directory, stat: after });
    }
    const present = new Set(files.map(file => wipCleanupPathKey(file.binding.path)));
    if ([...expected.keys()].some(key => !present.has(key))) throw new Error('WIP contains missing declared artifacts.');
    assertBoundContainedRemovalTree(rootBinding, WIP_CLEANUP_LIMITS.entries,
        [...directories, ...files.map(file => file.binding)]);
    for (const file of files) assertFileSnapshotCurrent(file);
    for (let index = directorySnapshots.length - 1; index >= 0; index -= 1) {
        const { binding, stat } = directorySnapshots[index];
        assertContainedDestination(binding);
        const current = fs.lstatSync(binding.path, { bigint: true });
        assertContainedDestination(binding);
        if (!sameDirectorySnapshot(stat, current)) throw new Error('WIP package directory changed before snapshot completion.');
    }
    const treeHash = createHash('sha256');
    for (const item of tree.sort()) treeHash.update(item).update('\n');
    return { taskId, manifestPath, rootBinding, manifest, manifestSha256: snapshot.sha256, files, directories,
        handoffs, treeSha256: treeHash.digest('hex') };
}

export function assertWipCleanupFileCurrent(root: string, file: WipCleanupFile): void {
    assertContainedDestination(file.binding);
    const current = readWipCleanupFile(root, file.binding.path, WIP_CLEANUP_LIMITS.artifactBytes);
    if (current.identity !== file.identity || current.sha256 !== file.sha256) throw new Error(`WIP file changed before removal: ${normalizePath(file.binding.path)}`);
}
