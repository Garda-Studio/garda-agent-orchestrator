import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileAtomically } from '../../core/filesystem';
import { isPathRealpathInsideRoot, stringSha256, joinOrchestratorPath, normalizePath } from '../shared/helpers';
import {
    createWorkspaceSnapshotGitGeneration,
    getWorkspaceSnapshot,
    type WorkspaceSnapshotGitGeneration
} from '../compile/compile-gate';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import { normalizeGitRepoRelativePath } from '../../core/git-change-classification';
import { getSafeWorktreePathState } from './worktree-path-state';
import { normalizeGitChangeClassificationEvidence } from '../../core/git-change-classification';

const CACHE_VERSION = 6;
const CACHE_INTEGRITY_SCHEMA_VERSION = 2;
const CACHE_RELATIVE_PATH = path.join('runtime', 'cache', 'workspace-snapshot.json');
const CACHE_AUTH_KEY_RELATIVE_PATH = path.join('garda-agent-orchestrator', 'workspace-snapshot-cache.key');
const MAX_IN_PROCESS_CACHE_ENTRIES = 32;

interface InProcessSnapshotCacheEntry {
    repoKey: string;
    snapshot: WorkspaceSnapshot;
}

const inProcessSnapshotCache = new Map<string, InProcessSnapshotCacheEntry>();
const workspaceSnapshotRequestRoots = new WeakMap<WorkspaceSnapshotRequest, string>();

export type WorkspaceSnapshot = ReturnType<typeof getWorkspaceSnapshot>;

export interface WorkspaceSnapshotCacheEntry {
    cache_version: number;
    fingerprint: string;
    snapshot: WorkspaceSnapshot;
    timestamp_utc: string;
    params: {
        repo_root: string;
        detection_source: string;
        include_untracked: boolean;
        explicit_changed_files_hash: string | null;
    };
    git_state: {
        head_sha: string | null;
        index_mtime_ms: number;
        index_size: number;
    };
    integrity: {
        schema_version: number;
        snapshot_sha256: string;
        params_sha256: string;
        workspace_identity_sha256: string;
        entry_sha256: string;
        entry_hmac_sha256: string;
    };
}

export interface WorkspaceSnapshotCacheOptions {
    /** Disable cache entirely; always compute fresh. Default: false. */
    noCache?: boolean;
    /** Skip writing the cache file after a fresh computation. Default: false. */
    readOnly?: boolean;
}

export type ResolvedWorkspaceSnapshot = WorkspaceSnapshot & { cache_hit: boolean };

export interface WorkspaceSnapshotRequest {
    readonly repo_root: string;
    read(
        detectionSource: string,
        includeUntracked: boolean,
        explicitChangedFiles: string[]
    ): ResolvedWorkspaceSnapshot;
}

interface WorkspaceSnapshotRequestEntry {
    snapshot: ResolvedWorkspaceSnapshot | null;
    error: unknown;
}

type NormalizedWorkspaceSnapshotCacheParams = Omit<
    WorkspaceSnapshotCacheEntry['params'],
    'explicit_changed_files_hash'
> & {
    explicit_changed_files_hash: string;
};

interface WorkspaceSnapshotCacheGeneration {
    readonly repoKey: string;
    readonly params: NormalizedWorkspaceSnapshotCacheParams;
    readonly paramsSha256: string;
    readonly fingerprint: ReturnType<typeof computeSnapshotFingerprint>;
    readonly workspaceIdentitySha256: string;
    readonly gitGeneration: WorkspaceSnapshotGitGeneration;
}

const workspaceSnapshotCacheGenerations = new WeakSet<WorkspaceSnapshotCacheGeneration>();

function normalizeExplicitChangedFiles(explicitChangedFiles: string[]): string[] {
    return [...new Set(
        (explicitChangedFiles || [])
            .map((filePath) => normalizeGitRepoRelativePath(filePath))
            .filter((filePath): filePath is string => filePath !== null)
    )].sort();
}

function canonicalJson(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('Workspace snapshot cache binding contains a non-finite number.');
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
            .join(',')}}`;
    }
    throw new Error('Workspace snapshot cache binding contains an unsupported value.');
}

function hashCanonicalJson(value: unknown): string {
    return stringSha256(canonicalJson(value)) || '';
}

function resolveGitMetadataDirectory(repoRoot: string): string | null {
    try {
        const dotGitPath = path.join(path.resolve(repoRoot), '.git');
        const dotGitStat = fs.lstatSync(dotGitPath);
        if (dotGitStat.isDirectory() && !dotGitStat.isSymbolicLink()) {
            return fs.realpathSync.native(dotGitPath);
        }
        if (!dotGitStat.isFile() || dotGitStat.isSymbolicLink()) return null;
        const match = fs.readFileSync(dotGitPath, 'utf8').trim().match(/^gitdir:\s*(.+)$/u);
        if (!match) return null;
        const gitDirectory = path.resolve(path.dirname(dotGitPath), match[1]);
        const gitDirectoryStat = fs.lstatSync(gitDirectory);
        return gitDirectoryStat.isDirectory() && !gitDirectoryStat.isSymbolicLink()
            ? fs.realpathSync.native(gitDirectory)
            : null;
    } catch {
        return null;
    }
}

function resolveWorkspaceSnapshotCacheAuthKeyPath(repoRoot: string): {
    gitDirectory: string;
    keyPath: string;
} | null {
    const gitDirectory = resolveGitMetadataDirectory(repoRoot);
    if (!gitDirectory) return null;
    const keyPath = path.join(gitDirectory, CACHE_AUTH_KEY_RELATIVE_PATH);
    return isPathRealpathInsideRoot(keyPath, gitDirectory, { allowMissing: true })
        ? { gitDirectory, keyPath }
        : null;
}

function readWorkspaceSnapshotCacheAuthKeyFile(keyPath: string, gitDirectory: string): Buffer | null {
    try {
        const keyStat = fs.lstatSync(keyPath);
        if (!keyStat.isFile() || keyStat.isSymbolicLink()) return null;
        const keyRealPath = fs.realpathSync.native(keyPath);
        if (!isPathRealpathInsideRoot(keyRealPath, gitDirectory)) return null;
        const encodedKey = fs.readFileSync(keyRealPath, 'utf8').trim().toLowerCase();
        return /^[0-9a-f]{64}$/u.test(encodedKey) ? Buffer.from(encodedKey, 'hex') : null;
    } catch {
        return null;
    }
}

function readWorkspaceSnapshotCacheAuthKey(repoRoot: string, createIfMissing: boolean): Buffer | null {
    const resolved = resolveWorkspaceSnapshotCacheAuthKeyPath(repoRoot);
    if (!resolved) return null;
    const existingKey = readWorkspaceSnapshotCacheAuthKeyFile(resolved.keyPath, resolved.gitDirectory);
    if (existingKey || !createIfMissing || fs.existsSync(resolved.keyPath)) return existingKey;

    const keyDirectory = path.dirname(resolved.keyPath);
    try {
        if (fs.existsSync(keyDirectory)) {
            const directoryStat = fs.lstatSync(keyDirectory);
            if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null;
        } else {
            fs.mkdirSync(keyDirectory, { mode: 0o700 });
        }
        if (!isPathRealpathInsideRoot(keyDirectory, resolved.gitDirectory)) return null;
        const candidateKey = randomBytes(32);
        let descriptor: number | undefined;
        try {
            descriptor = fs.openSync(resolved.keyPath, 'wx', 0o600);
            fs.writeFileSync(descriptor, `${candidateKey.toString('hex')}\n`, 'utf8');
            fs.fsyncSync(descriptor);
        } finally {
            if (descriptor !== undefined) fs.closeSync(descriptor);
        }
        return candidateKey;
    } catch (error: unknown) {
        if (String((error as NodeJS.ErrnoException | undefined)?.code || '').toUpperCase() !== 'EEXIST') {
            return null;
        }
        return readWorkspaceSnapshotCacheAuthKeyFile(resolved.keyPath, resolved.gitDirectory);
    }
}

function normalizeCacheParams(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean,
    explicitChangedFiles: string[]
): NormalizedWorkspaceSnapshotCacheParams {
    const normalizedSource = String(detectionSource || 'git_auto').trim().toLowerCase() || 'git_auto';
    const normalizedExplicit = normalizeExplicitChangedFiles(explicitChangedFiles);
    return {
        repo_root: normalizeRepoCacheKey(repoRoot),
        detection_source: normalizedSource,
        include_untracked: normalizedSource === 'git_staged_only' ? false : !!includeUntracked,
        explicit_changed_files_hash: stringSha256(normalizedExplicit.join('\n')) || ''
    };
}

function buildWorkspaceIdentitySha256(
    repoKey: string,
    fingerprint: string
): string {
    return hashCanonicalJson({
        repo_root: repoKey,
        fingerprint
    });
}

function buildCacheEntrySha256(entry: Omit<WorkspaceSnapshotCacheEntry, 'integrity'>, integrity: {
    snapshot_sha256: string;
    params_sha256: string;
    workspace_identity_sha256: string;
}): string {
    return hashCanonicalJson({
        cache_version: entry.cache_version,
        fingerprint: entry.fingerprint,
        timestamp_utc: entry.timestamp_utc,
        params: entry.params,
        git_state: entry.git_state,
        snapshot_sha256: integrity.snapshot_sha256,
        params_sha256: integrity.params_sha256,
        workspace_identity_sha256: integrity.workspace_identity_sha256
    });
}

function buildCacheEntryHmacSha256(
    entry: Omit<WorkspaceSnapshotCacheEntry, 'integrity'>,
    integrity: Omit<WorkspaceSnapshotCacheEntry['integrity'], 'entry_hmac_sha256'>,
    authenticationKey: Buffer
): string {
    return createHmac('sha256', authenticationKey)
        .update(canonicalJson({ entry, integrity }), 'utf8')
        .digest('hex');
}

function sealWorkspaceSnapshotCacheEntry(
    entry: Omit<WorkspaceSnapshotCacheEntry, 'integrity'>,
    authenticationKey: Buffer
): WorkspaceSnapshotCacheEntry {
    const hashes = {
        snapshot_sha256: hashCanonicalJson(entry.snapshot),
        params_sha256: hashCanonicalJson(entry.params),
        workspace_identity_sha256: buildWorkspaceIdentitySha256(
            normalizeRepoCacheKey(entry.params.repo_root),
            entry.fingerprint
        )
    };
    const integrityWithoutHmac = {
        schema_version: CACHE_INTEGRITY_SCHEMA_VERSION,
        ...hashes,
        entry_sha256: buildCacheEntrySha256(entry, hashes)
    };
    return {
        ...entry,
        integrity: {
            ...integrityWithoutHmac,
            entry_hmac_sha256: buildCacheEntryHmacSha256(entry, integrityWithoutHmac, authenticationKey)
        }
    };
}

function hasValidCacheEntryIntegrity(entry: WorkspaceSnapshotCacheEntry): boolean {
    const integrity = entry.integrity;
    if (
        !integrity
        || integrity.schema_version !== CACHE_INTEGRITY_SCHEMA_VERSION
        || ![
            integrity.snapshot_sha256,
            integrity.params_sha256,
            integrity.workspace_identity_sha256,
            integrity.entry_sha256,
            integrity.entry_hmac_sha256
        ]
            .every((value) => /^[0-9a-f]{64}$/u.test(String(value || '')))
    ) {
        return false;
    }
    const unsealedEntry: Omit<WorkspaceSnapshotCacheEntry, 'integrity'> = {
        cache_version: entry.cache_version,
        fingerprint: entry.fingerprint,
        snapshot: entry.snapshot,
        timestamp_utc: entry.timestamp_utc,
        params: entry.params,
        git_state: entry.git_state
    };
    return integrity.snapshot_sha256 === hashCanonicalJson(entry.snapshot)
        && integrity.params_sha256 === hashCanonicalJson(entry.params)
        && integrity.workspace_identity_sha256 === buildWorkspaceIdentitySha256(
            normalizeRepoCacheKey(entry.params.repo_root),
            entry.fingerprint
        )
        && integrity.entry_sha256 === buildCacheEntrySha256(unsealedEntry, integrity);
}

function hasValidCacheEntryAuthentication(
    entry: WorkspaceSnapshotCacheEntry,
    authenticationKey: Buffer
): boolean {
    if (!hasValidCacheEntryIntegrity(entry)) return false;
    const unsealedEntry: Omit<WorkspaceSnapshotCacheEntry, 'integrity'> = {
        cache_version: entry.cache_version,
        fingerprint: entry.fingerprint,
        snapshot: entry.snapshot,
        timestamp_utc: entry.timestamp_utc,
        params: entry.params,
        git_state: entry.git_state
    };
    const integrityWithoutHmac = {
        schema_version: entry.integrity.schema_version,
        snapshot_sha256: entry.integrity.snapshot_sha256,
        params_sha256: entry.integrity.params_sha256,
        workspace_identity_sha256: entry.integrity.workspace_identity_sha256,
        entry_sha256: entry.integrity.entry_sha256
    };
    const expected = Buffer.from(
        buildCacheEntryHmacSha256(unsealedEntry, integrityWithoutHmac, authenticationKey),
        'hex'
    );
    const actual = Buffer.from(entry.integrity.entry_hmac_sha256, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function normalizeSnapshotRequestKey(
    detectionSource: string,
    includeUntracked: boolean,
    explicitChangedFiles: string[]
): string {
    const normalizedSource = String(detectionSource || 'git_auto').trim().toLowerCase() || 'git_auto';
    const effectiveIncludeUntracked = normalizedSource === 'git_staged_only' ? false : includeUntracked;
    return JSON.stringify([
        normalizedSource,
        effectiveIncludeUntracked,
        normalizeExplicitChangedFiles(explicitChangedFiles)
    ]);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function authenticateWorkspaceSnapshot(
    snapshot: WorkspaceSnapshot,
    params?: NormalizedWorkspaceSnapshotCacheParams
): void {
    const changedFiles = normalizeExplicitChangedFiles(snapshot.changed_files);
    const authorizedFiles = normalizeExplicitChangedFiles(snapshot.authorized_files);
    const ignoredGeneratedRuntimeFiles = normalizeExplicitChangedFiles(snapshot.ignored_generated_runtime_files);
    if (
        !sameStringList(changedFiles, snapshot.changed_files)
        || snapshot.changed_files_count !== changedFiles.length
        || snapshot.changed_files_sha256 !== stringSha256(changedFiles.join('\n'))
    ) {
        throw new Error('Workspace snapshot authentication failed: changed-file binding is inconsistent.');
    }
    if (
        !sameStringList(authorizedFiles, snapshot.authorized_files)
        || snapshot.authorized_files_count !== authorizedFiles.length
        || snapshot.authorized_files_sha256 !== stringSha256(authorizedFiles.join('\n'))
    ) {
        throw new Error('Workspace snapshot authentication failed: authorized-file binding is inconsistent.');
    }
    if (
        !sameStringList(ignoredGeneratedRuntimeFiles, snapshot.ignored_generated_runtime_files)
        || snapshot.ignored_generated_runtime_files_count !== ignoredGeneratedRuntimeFiles.length
    ) {
        throw new Error('Workspace snapshot authentication failed: ignored generated-file binding is inconsistent.');
    }
    const normalizedClassification = normalizeGitChangeClassificationEvidence(snapshot.git_change_classification);
    if (
        snapshot.git_change_classification != null
        && (
            !normalizedClassification
            || !sameStringList(normalizedClassification.effective_changed_files, changedFiles)
        )
    ) {
        throw new Error('Workspace snapshot authentication failed: canonical Git classification is inconsistent.');
    }
    for (const hash of [snapshot.changed_files_sha256, snapshot.scope_content_sha256, snapshot.scope_sha256]) {
        if (!/^[0-9a-f]{64}$/u.test(String(hash || '').trim().toLowerCase())) {
            throw new Error('Workspace snapshot authentication failed: scope hash is invalid.');
        }
    }
    const changedFileStats = snapshot.changed_file_stats;
    if (!changedFileStats || typeof changedFileStats !== 'object' || Array.isArray(changedFileStats)) {
        throw new Error('Workspace snapshot authentication failed: changed-file stats are missing.');
    }
    const statPaths = Object.keys(changedFileStats).sort();
    if (!sameStringList(statPaths, changedFiles)) {
        throw new Error('Workspace snapshot authentication failed: changed-file stats scope is inconsistent.');
    }
    let additionsTotal = 0;
    let deletionsTotal = 0;
    for (const relativePath of statPaths) {
        const stats = changedFileStats[relativePath];
        if (
            !stats
            || !Number.isSafeInteger(stats.additions)
            || stats.additions < 0
            || !Number.isSafeInteger(stats.deletions)
            || stats.deletions < 0
            || !Number.isSafeInteger(stats.changed_lines)
            || stats.changed_lines !== stats.additions + stats.deletions
        ) {
            throw new Error('Workspace snapshot authentication failed: changed-file stats are inconsistent.');
        }
        additionsTotal += stats.additions;
        deletionsTotal += stats.deletions;
    }
    if (
        snapshot.additions_total !== additionsTotal
        || snapshot.deletions_total !== deletionsTotal
        || snapshot.changed_lines_total !== additionsTotal + deletionsTotal
    ) {
        throw new Error('Workspace snapshot authentication failed: aggregate line totals are inconsistent.');
    }
    const normalizedSource = String(snapshot.detection_source || '').trim().toLowerCase();
    const expectedUseStaged = ['git_staged_only', 'git_staged_plus_untracked'].includes(normalizedSource);
    const expectedScopeSha256 = normalizedSource === 'explicit_changed_files'
        ? stringSha256(
            `${normalizedSource}|false|${snapshot.include_untracked}|${authorizedFiles.length}|${snapshot.authorized_files_sha256}|`
            + `${changedFiles.length}|${snapshot.changed_lines_total}|${snapshot.changed_files_sha256}|${snapshot.scope_content_sha256}`
        )
        : stringSha256(
            `${normalizedSource}|${expectedUseStaged}|${snapshot.include_untracked}|${changedFiles.length}|`
            + `${snapshot.changed_lines_total}|${snapshot.changed_files_sha256}|${snapshot.scope_content_sha256}`
        );
    if (snapshot.use_staged !== expectedUseStaged || snapshot.scope_sha256 !== expectedScopeSha256) {
        throw new Error('Workspace snapshot authentication failed: scope binding is inconsistent.');
    }
    if (!params) return;
    const expectedAuthorizedFilesHash = params.detection_source === 'explicit_changed_files'
        ? params.explicit_changed_files_hash
        : snapshot.changed_files_sha256;
    if (
        normalizedSource !== params.detection_source
        || snapshot.include_untracked !== params.include_untracked
        || snapshot.authorized_files_sha256 !== expectedAuthorizedFilesHash
    ) {
        throw new Error('Workspace snapshot authentication failed: request parameter binding is inconsistent.');
    }
}

function deepFreezeSnapshot<T>(value: T): T {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }
    for (const nested of Object.values(value as Record<string, unknown>)) {
        deepFreezeSnapshot(nested);
    }
    return Object.freeze(value);
}

/**
 * Build a request-local, parameter-keyed reader for fresh canonical workspace
 * snapshots. Equivalent consumers receive the same authenticated immutable
 * object, including the same cached failure, while a later request starts from
 * a new workspace generation.
 */
export function createWorkspaceSnapshotRequest(repoRoot: string): WorkspaceSnapshotRequest {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const entries = new Map<string, WorkspaceSnapshotRequestEntry>();
    const gitGeneration = createWorkspaceSnapshotGitGeneration(resolvedRepoRoot);
    const request = Object.freeze({
        repo_root: normalizePath(resolvedRepoRoot),
        read(
            detectionSource: string,
            includeUntracked: boolean,
            explicitChangedFiles: string[]
        ): ResolvedWorkspaceSnapshot {
            const key = normalizeSnapshotRequestKey(detectionSource, includeUntracked, explicitChangedFiles);
            const existing = entries.get(key);
            if (existing) {
                if (existing.snapshot) return existing.snapshot;
                throw existing.error;
            }
            try {
                const freshSnapshot = getWorkspaceSnapshot(
                    resolvedRepoRoot,
                    detectionSource,
                    includeUntracked,
                    explicitChangedFiles,
                    gitGeneration
                );
                const snapshot: ResolvedWorkspaceSnapshot = {
                    ...freshSnapshot,
                    cache_hit: false
                };
                authenticateWorkspaceSnapshot(snapshot);
                const immutableSnapshot = deepFreezeSnapshot(snapshot);
                entries.set(key, { snapshot: immutableSnapshot, error: null });
                return immutableSnapshot;
            } catch (error: unknown) {
                entries.set(key, { snapshot: null, error });
                throw error;
            }
        }
    });
    workspaceSnapshotRequestRoots.set(request, normalizeRepoCacheKey(resolvedRepoRoot));
    return request;
}

/**
 * Reuse only factory-created requests that are bound to the same repository.
 * This prevents public audit/report injection points from accepting a foreign
 * workspace generation or a structurally compatible forged reader.
 */
export function resolveWorkspaceSnapshotRequest(
    repoRoot: string,
    request?: WorkspaceSnapshotRequest
): WorkspaceSnapshotRequest {
    if (!request) {
        return createWorkspaceSnapshotRequest(repoRoot);
    }
    const expectedRepoRoot = normalizeRepoCacheKey(repoRoot);
    const registeredRepoRoot = typeof request === 'object' && request !== null
        ? workspaceSnapshotRequestRoots.get(request)
        : undefined;
    const declaredRepoRoot = typeof request?.repo_root === 'string'
        ? normalizeRepoCacheKey(request.repo_root)
        : null;
    if (registeredRepoRoot !== expectedRepoRoot || declaredRepoRoot !== expectedRepoRoot) {
        throw new Error('Workspace snapshot request is not factory-authenticated for the requested repository root.');
    }
    return request;
}

function normalizeRepoCacheKey(repoRoot: string): string {
    const resolved = normalizePath(path.resolve(repoRoot));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function createWorkspaceSnapshotCacheGeneration(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean,
    explicitChangedFiles: string[]
): WorkspaceSnapshotCacheGeneration {
    const params = normalizeCacheParams(repoRoot, detectionSource, includeUntracked, explicitChangedFiles);
    const fingerprint = computeSnapshotFingerprint(
        repoRoot,
        params.detection_source,
        params.include_untracked,
        explicitChangedFiles
    );
    const generation = Object.freeze({
        repoKey: normalizeRepoCacheKey(repoRoot),
        params: Object.freeze(params),
        paramsSha256: hashCanonicalJson(params),
        fingerprint,
        workspaceIdentitySha256: buildWorkspaceIdentitySha256(
            normalizeRepoCacheKey(repoRoot),
            fingerprint.fingerprint
        ),
        gitGeneration: createWorkspaceSnapshotGitGeneration(repoRoot)
    });
    workspaceSnapshotCacheGenerations.add(generation);
    return generation;
}

function assertWorkspaceSnapshotCacheGenerationStable(
    repoRoot: string,
    explicitChangedFiles: string[],
    generation: WorkspaceSnapshotCacheGeneration
): void {
    const verifiedFingerprint = computeSnapshotFingerprint(
        repoRoot,
        generation.params.detection_source,
        generation.params.include_untracked,
        explicitChangedFiles
    );
    if (verifiedFingerprint.fingerprint !== generation.fingerprint.fingerprint) {
        throw new Error(
            'Workspace snapshot cache generation changed during authenticated snapshot resolution; retry the invocation.'
        );
    }
}

function authenticateWorkspaceSnapshotCacheGeneration(
    repoRoot: string,
    generation: WorkspaceSnapshotCacheGeneration
): void {
    if (
        !workspaceSnapshotCacheGenerations.has(generation)
        || generation.repoKey !== normalizeRepoCacheKey(repoRoot)
        || generation.workspaceIdentitySha256 !== buildWorkspaceIdentitySha256(
            generation.repoKey,
            generation.fingerprint.fingerprint
        )
    ) {
        throw new Error('Workspace snapshot cache generation is not factory-authenticated for the requested repository root.');
    }
}

function makeInProcessCacheKey(repoRoot: string, fingerprint: string): string {
    return `${normalizeRepoCacheKey(repoRoot)}|${fingerprint}`;
}

function cloneWorkspaceSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
    return JSON.parse(JSON.stringify(snapshot)) as WorkspaceSnapshot;
}

function rememberInProcessSnapshot(repoRoot: string, fingerprint: string, snapshot: WorkspaceSnapshot): void {
    const cacheKey = makeInProcessCacheKey(repoRoot, fingerprint);
    inProcessSnapshotCache.delete(cacheKey);
    inProcessSnapshotCache.set(cacheKey, {
        repoKey: normalizeRepoCacheKey(repoRoot),
        snapshot: cloneWorkspaceSnapshot(snapshot)
    });
    while (inProcessSnapshotCache.size > MAX_IN_PROCESS_CACHE_ENTRIES) {
        const oldestKey = inProcessSnapshotCache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        inProcessSnapshotCache.delete(oldestKey);
    }
}

function forgetInProcessSnapshots(repoRoot: string): boolean {
    const repoKey = normalizeRepoCacheKey(repoRoot);
    let removed = false;
    for (const [cacheKey, entry] of inProcessSnapshotCache) {
        if (entry.repoKey === repoKey) {
            inProcessSnapshotCache.delete(cacheKey);
            removed = true;
        }
    }
    return removed;
}

/**
 * Read HEAD SHA cheaply via git rev-parse.
 * Returns null on any failure (no-commit repo, not a git repo, etc.).
 */
export function readHeadSha(repoRoot: string): string | null {
    try {
        const result = spawnSyncWithTimeout('git', ['-C', String(repoRoot), 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS
        });
        if (result.status !== 0 || result.timedOut || result.error) return null;
        return String(result.stdout || '').trim() || null;
    } catch {
        return null;
    }
}

/**
 * Stat the git index file (.git/index) to detect staged-state changes.
 * Returns mtime (ms floor) and byte size.  Falls back to zeros on error.
 */
export function statGitIndex(repoRoot: string): { mtime_ms: number; size: number } {
    try {
        const gitDir = path.join(path.resolve(repoRoot), '.git');
        // Handle gitdir files (submodules, worktrees)
        let indexPath: string;
        const gitDirStat = fs.statSync(gitDir);
        if (gitDirStat.isFile()) {
            const content = fs.readFileSync(gitDir, 'utf8').trim();
            const match = content.match(/^gitdir:\s*(.+)$/);
            if (match) {
                indexPath = path.resolve(path.dirname(gitDir), match[1], 'index');
            } else {
                return { mtime_ms: 0, size: 0 };
            }
        } else {
            indexPath = path.join(gitDir, 'index');
        }
        const stat = fs.statSync(indexPath);
        return { mtime_ms: Math.floor(stat.mtimeMs), size: stat.size };
    } catch {
        return { mtime_ms: 0, size: 0 };
    }
}

/**
 * Compute the parameters component of the cache fingerprint.
 */
function computeParamsHash(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean,
    explicitChangedFiles: string[]
): string {
    return hashCanonicalJson(normalizeCacheParams(
        repoRoot,
        detectionSource,
        includeUntracked,
        explicitChangedFiles
    ));
}

interface GitFingerprintStatusEntry {
    statusCode: string;
    path: string;
    previousPath: string | null;
    untracked: boolean;
}

/**
 * Read only the porcelain candidates required for cache invalidation.
 * This intentionally avoids the canonical content classifier: a cache hit
 * must not pay the full snapshot-discovery cost that the cache exists to skip.
 */
function readGitFingerprintStatusEntries(
    repoRoot: string,
    includeUntracked: boolean
): GitFingerprintStatusEntry[] {
    const args = [
        '-C',
        String(repoRoot),
        '--no-pager',
        'status',
        '--porcelain=v1',
        '-z',
        `--untracked-files=${includeUntracked ? 'all' : 'no'}`,
        '--ignore-submodules=none',
        '--renames'
    ];
    const result = spawnSyncWithTimeout('git', args, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
    });
    if (result.status !== 0 || result.timedOut || result.error) {
        throw new Error(formatGitFingerprintProbeFailure(repoRoot, args, result));
    }

    const fields = String(result.stdout || '').split('\0');
    const entries: GitFingerprintStatusEntry[] = [];
    let index = 0;
    while (index < fields.length) {
        const record = String(fields[index++] || '');
        if (!record) continue;
        if (record.length < 4 || record.charAt(2) !== ' ') {
            throw new Error('Unable to compute workspace snapshot cache fingerprint: malformed git porcelain record.');
        }
        const xStatus = record.charAt(0);
        const yStatus = record.charAt(1);
        const currentPath = normalizeGitRepoRelativePath(record.slice(3));
        if (!currentPath) {
            throw new Error('Unable to compute workspace snapshot cache fingerprint: git porcelain path is invalid.');
        }
        const renameOrCopy = /[RC]/u.test(xStatus) || /[RC]/u.test(yStatus);
        const previousPath = renameOrCopy
            ? normalizeGitRepoRelativePath(String(fields[index++] || ''))
            : null;
        if (renameOrCopy && !previousPath) {
            throw new Error('Unable to compute workspace snapshot cache fingerprint: git porcelain rename source is invalid.');
        }
        entries.push({
            statusCode: `${xStatus}${yStatus}`,
            path: currentPath,
            previousPath,
            untracked: xStatus === '?' && yStatus === '?'
        });
    }
    return entries;
}

function resolveSnapshotCacheRepoRelativePath(repoRoot: string): string {
    return normalizePath(path.relative(repoRoot, resolveSnapshotCachePath(repoRoot)));
}

function isInternalSnapshotCachePath(repoRoot: string, relativePath: string | null | undefined): boolean {
    const normalized = normalizePath(relativePath || '');
    if (!normalized) return false;
    return normalized === resolveSnapshotCacheRepoRelativePath(repoRoot);
}

function readRepoRealPath(repoRoot: string): string | null {
    try {
        return fs.realpathSync(repoRoot);
    } catch {
        return null;
    }
}

function buildPathStateToken(repoRoot: string, relativePath: string, repoRealPath: string | null): string {
    const normalized = normalizePath(relativePath);
    if (!normalized) return 'missing';
    const state = getSafeWorktreePathState(
        repoRoot,
        normalized,
        repoRealPath ? { repoRealPath } : undefined
    );
    if (state.status === 'file') {
        return `file|${state.size ?? 0}|${state.sha256 || ''}`;
    }
    if (state.status === 'symbolic_link') {
        return [
            'symlink',
            state.size ?? 0,
            state.link_sha256 || '',
            state.target_status || 'unknown',
            state.target_path || '',
            state.target_mode ?? 0,
            state.target_size ?? 0,
            state.target_sha256 || ''
        ].join('|');
    }
    if (state.status === 'unreviewable_symlink') {
        return [
            'unreviewable_symlink',
            state.size ?? 0,
            state.link_sha256 || '',
            state.target_status || 'unknown',
            state.target_path || '',
            state.target_mode ?? 0,
            state.target_size ?? 0
        ].join('|');
    }
    if (state.status === 'directory') {
        try {
            const fullPath = path.join(repoRoot, normalized);
            const entries = fs.readdirSync(fullPath, { withFileTypes: true })
                .map((entry) => `${entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other'}:${entry.name}`)
                .sort();
            return `dir|${stringSha256(entries.join('\n')) || ''}`;
        } catch {
            return 'missing';
        }
    }
    if (state.status === 'special') {
        return `other|${state.mode ?? 0}|${state.size ?? 0}`;
    }
    return state.status;
}

function formatGitFingerprintProbeFailure(repoRoot: string, args: string[], result: ReturnType<typeof spawnSyncWithTimeout>): string {
    const displayArgs = args[0] === '-C' ? args.slice(2) : args;
    const reason = result.timedOut
        ? `timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`
        : result.error
            ? String(result.error)
            : String(result.stderr || result.stdout || `exit status ${result.status}`).trim();
    return `Unable to compute workspace snapshot cache fingerprint: git ${displayArgs.join(' ')} failed in '${normalizePath(repoRoot)}' (${reason}).`;
}

function readGitCachedRawDiff(repoRoot: string): string {
    const args = [
        '-C',
        String(repoRoot),
        'diff',
        '--cached',
        '--raw',
        '--find-renames',
        '--abbrev=40',
        '--diff-filter=ACDMRTUXB'
    ];
    const result = spawnSyncWithTimeout('git', args, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
    });
    if (result.status !== 0 || result.timedOut || result.error) {
        throw new Error(formatGitFingerprintProbeFailure(repoRoot, args, result));
    }
    return String(result.stdout || '').trimEnd();
}

export function parseGitCachedRawDiffDeletedPaths(repoRoot: string, rawDiff: string): string[] {
    const deletedPaths = new Set<string>();
    for (const rawLine of String(rawDiff || '').split('\n')) {
        const line = rawLine.trimEnd();
        if (!line) continue;
        const tabParts = line.split('\t');
        if (tabParts.length < 2) continue;
        const metadataFields = tabParts[0].trim().split(/\s+/);
        const statusToken = metadataFields[metadataFields.length - 1] || '';
        if (!statusToken.startsWith('D')) continue;
        const deletedPath = normalizePath(tabParts[1]);
        if (!deletedPath || isInternalSnapshotCachePath(repoRoot, deletedPath)) continue;
        deletedPaths.add(deletedPath);
    }
    return [...deletedPaths].sort();
}

function buildGitStatusFingerprintHash(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean
): string {
    const normalizedSource = (detectionSource || 'git_auto').trim().toLowerCase();
    const stagedOnly = normalizedSource === 'git_staged_only' || normalizedSource === 'git_staged_plus_untracked';
    const repoRealPath = readRepoRealPath(repoRoot);
    const descriptors: string[] = [];
    let hasStagedChanges = false;

    for (const entry of readGitFingerprintStatusEntries(repoRoot, includeUntracked)) {
        if (
            isInternalSnapshotCachePath(repoRoot, entry.path)
            || isInternalSnapshotCachePath(repoRoot, entry.previousPath)
        ) {
            continue;
        }

        if (entry.untracked) {
            if (includeUntracked) {
                descriptors.push(`U|${entry.path}|${buildPathStateToken(repoRoot, entry.path, repoRealPath)}`);
            }
            continue;
        }

        const indexStatus = entry.statusCode.charAt(0) || ' ';
        const worktreeStatus = entry.statusCode.charAt(1) || ' ';
        if (indexStatus !== ' ' && indexStatus !== '?') {
            hasStagedChanges = true;
            descriptors.push(`S|${indexStatus}|${entry.previousPath || ''}|${entry.path}`);
        }
        if (!stagedOnly && worktreeStatus !== ' ' && worktreeStatus !== '?') {
            descriptors.push(
                `W|${worktreeStatus}|${entry.previousPath || ''}|${entry.path}|${buildPathStateToken(repoRoot, entry.path, repoRealPath)}`
            );
        }
    }

    if (stagedOnly || hasStagedChanges) {
        const cachedRawDiff = readGitCachedRawDiff(repoRoot);
        descriptors.unshift(cachedRawDiff);
        for (const deletedPath of parseGitCachedRawDiffDeletedPaths(repoRoot, cachedRawDiff)) {
            descriptors.push(`D|${deletedPath}|${buildPathStateToken(repoRoot, deletedPath, repoRealPath)}`);
        }
    }

    return stringSha256(descriptors.join('\n')) || '';
}

function buildExplicitPathFingerprintHash(repoRoot: string, explicitChangedFiles: string[]): string {
    const repoRealPath = readRepoRealPath(repoRoot);
    const normalizedExplicit = normalizeExplicitChangedFiles(explicitChangedFiles)
        .filter((relativePath: string) => !isInternalSnapshotCachePath(repoRoot, relativePath))
        .sort();

    const descriptors = normalizedExplicit.map((relativePath: string) => (
        `${relativePath}|${buildPathStateToken(repoRoot, relativePath, repoRealPath)}`
    ));

    return stringSha256(descriptors.join('\n')) || '';
}

/**
 * Compute a cheap fingerprint representing the current workspace state
 * combined with the call parameters. The fingerprint changes when:
 *   - HEAD moves (commit, reset, checkout)
 *   - staged/index changes move staged-only snapshots
 *   - relevant tracked or untracked worktree content changes
 *   - call parameters differ (detection source, untracked flag, explicit files)
 */
export function computeSnapshotFingerprint(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean,
    explicitChangedFiles: string[]
): { fingerprint: string; headSha: string | null; indexMtimeMs: number; indexSize: number } {
    const params = normalizeCacheParams(repoRoot, detectionSource, includeUntracked, explicitChangedFiles);
    const normalizedSource = params.detection_source;
    const headSha = readHeadSha(repoRoot);
    const indexStat = statGitIndex(repoRoot);
    const paramsHash = computeParamsHash(
        repoRoot,
        normalizedSource,
        params.include_untracked,
        explicitChangedFiles
    );
    const stateHash = normalizedSource === 'explicit_changed_files'
        ? buildExplicitPathFingerprintHash(repoRoot, explicitChangedFiles)
        : buildGitStatusFingerprintHash(repoRoot, normalizedSource, params.include_untracked);
    const raw = [
        `v${CACHE_VERSION}`,
        normalizedSource,
        headSha || 'null',
        stateHash,
        '0',
        '0',
        paramsHash
    ].join('|');
    const fingerprint = stringSha256(raw) || '';

    return {
        fingerprint,
        headSha,
        indexMtimeMs: indexStat.mtime_ms,
        indexSize: indexStat.size
    };
}

/**
 * Resolve the on-disk cache file path.
 */
export function resolveSnapshotCachePath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, CACHE_RELATIVE_PATH);
}

function isSnapshotCachePathSafe(repoRoot: string, cachePath: string): boolean {
    const cacheRoot = path.dirname(resolveSnapshotCachePath(repoRoot));
    return isPathRealpathInsideRoot(cachePath, repoRoot, { allowMissing: true })
        && isPathRealpathInsideRoot(cachePath, cacheRoot, { allowMissing: true });
}

/**
 * Read the persisted snapshot cache from disk.
 * Returns null if the file is missing, corrupt, or schema-incompatible.
 */
export function readSnapshotCache(cachePath: string): WorkspaceSnapshotCacheEntry | null {
    try {
        const resolved = path.resolve(cachePath);
        if (!fs.existsSync(resolved)) return null;
        const raw = fs.readFileSync(resolved, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.cache_version !== CACHE_VERSION) return null;
        if (!/^[0-9a-f]{64}$/u.test(String(parsed.fingerprint || ''))) return null;
        if (!parsed.snapshot || typeof parsed.snapshot !== 'object') return null;
        const snapshot = parsed.snapshot as Record<string, unknown>;
        if (!snapshot.changed_file_stats || typeof snapshot.changed_file_stats !== 'object') return null;
        if (!parsed.params || typeof parsed.params !== 'object') return null;
        if (!parsed.git_state || typeof parsed.git_state !== 'object') return null;
        if (!parsed.integrity || typeof parsed.integrity !== 'object') return null;
        const entry = parsed as unknown as WorkspaceSnapshotCacheEntry;
        if (!hasValidCacheEntryIntegrity(entry)) return null;
        return entry;
    } catch {
        return null;
    }
}

/**
 * Write the snapshot cache to disk atomically (write-rename).
 */
export function writeSnapshotCache(cachePath: string, entry: WorkspaceSnapshotCacheEntry): void {
    const resolved = path.resolve(cachePath);
    writeFileAtomically(resolved, JSON.stringify(entry, null, 2) + '\n', { encoding: 'utf8', fsync: false });
}

/**
 * Remove the snapshot cache file.
 */
export function invalidateSnapshotCache(repoRoot: string): boolean {
    const removedFromMemory = forgetInProcessSnapshots(repoRoot);
    try {
        const cachePath = resolveSnapshotCachePath(repoRoot);
        if (!isSnapshotCachePathSafe(repoRoot, cachePath)) {
            return removedFromMemory;
        }
        if (fs.existsSync(cachePath)) {
            fs.unlinkSync(cachePath);
            return true;
        }
        return removedFromMemory;
    } catch {
        return removedFromMemory;
    }
}

/**
 * Get a workspace snapshot, returning a cached result when the relevant
 * workspace state and call parameters have not changed.
 *
 * On cache miss the full snapshot is computed via `getWorkspaceSnapshot`
 * and persisted for subsequent calls. Correctness is preserved because the
 * fingerprint covers:
 *   - HEAD changes
 *   - staged/index changes for staged-only snapshots
 *   - worktree file metadata for the relevant tracked/untracked paths
 *   - different parameters / explicit file lists
 *
 * Callers in hot paths (compile-gate, required-reviews-check) benefit
 * when the workspace is stable between sequential gate invocations.
 */
function cacheEntryMatchesGeneration(
    entry: WorkspaceSnapshotCacheEntry,
    generation: WorkspaceSnapshotCacheGeneration,
    authenticationKey: Buffer
): boolean {
    if (
        !hasValidCacheEntryAuthentication(entry, authenticationKey)
        ||
        entry.fingerprint !== generation.fingerprint.fingerprint
        || entry.integrity.params_sha256 !== generation.paramsSha256
        || entry.integrity.workspace_identity_sha256 !== generation.workspaceIdentitySha256
        || hashCanonicalJson(entry.params) !== generation.paramsSha256
    ) {
        return false;
    }
    try {
        authenticateWorkspaceSnapshot(entry.snapshot, generation.params);
        return true;
    } catch {
        return false;
    }
}

function getWorkspaceSnapshotCachedFromGeneration(
    repoRoot: string,
    explicitChangedFiles: string[],
    options: WorkspaceSnapshotCacheOptions,
    generation: WorkspaceSnapshotCacheGeneration
): ResolvedWorkspaceSnapshot {
    authenticateWorkspaceSnapshotCacheGeneration(repoRoot, generation);
    if (options.noCache) {
        const fresh = getWorkspaceSnapshot(
            repoRoot,
            generation.params.detection_source,
            generation.params.include_untracked,
            explicitChangedFiles,
            generation.gitGeneration
        );
        authenticateWorkspaceSnapshot(fresh, generation.params);
        assertWorkspaceSnapshotCacheGenerationStable(repoRoot, explicitChangedFiles, generation);
        return { ...fresh, cache_hit: false };
    }
    const cachePath = resolveSnapshotCachePath(repoRoot);
    const cachePathSafe = isSnapshotCachePathSafe(repoRoot, cachePath);
    const inProcessCacheKey = makeInProcessCacheKey(repoRoot, generation.fingerprint.fingerprint);

    const inProcessCached = cachePathSafe ? inProcessSnapshotCache.get(inProcessCacheKey) : null;
    if (inProcessCached) {
        authenticateWorkspaceSnapshot(inProcessCached.snapshot, generation.params);
        assertWorkspaceSnapshotCacheGenerationStable(repoRoot, explicitChangedFiles, generation);
        inProcessSnapshotCache.delete(inProcessCacheKey);
        inProcessSnapshotCache.set(inProcessCacheKey, inProcessCached);
        return { ...cloneWorkspaceSnapshot(inProcessCached.snapshot), cache_hit: true };
    }

    // Attempt cache hit
    const cached = cachePathSafe ? readSnapshotCache(cachePath) : null;
    const authenticationKey = cached
        ? readWorkspaceSnapshotCacheAuthKey(repoRoot, false)
        : null;
    if (cached && authenticationKey && cacheEntryMatchesGeneration(cached, generation, authenticationKey)) {
        assertWorkspaceSnapshotCacheGenerationStable(repoRoot, explicitChangedFiles, generation);
        rememberInProcessSnapshot(repoRoot, generation.fingerprint.fingerprint, cached.snapshot);
        return { ...cloneWorkspaceSnapshot(cached.snapshot), cache_hit: true };
    }

    // Cache miss — compute fresh
    const fresh = getWorkspaceSnapshot(
        repoRoot,
        generation.params.detection_source,
        generation.params.include_untracked,
        explicitChangedFiles,
        generation.gitGeneration
    );
    authenticateWorkspaceSnapshot(fresh, generation.params);
    assertWorkspaceSnapshotCacheGenerationStable(repoRoot, explicitChangedFiles, generation);
    if (cachePathSafe) {
        rememberInProcessSnapshot(repoRoot, generation.fingerprint.fingerprint, fresh);
    }

    if (!options.readOnly && cachePathSafe) {
        const writeAuthenticationKey = readWorkspaceSnapshotCacheAuthKey(repoRoot, true);
        if (writeAuthenticationKey) {
            const entry = sealWorkspaceSnapshotCacheEntry({
                cache_version: CACHE_VERSION,
                fingerprint: generation.fingerprint.fingerprint,
                snapshot: fresh,
                timestamp_utc: new Date().toISOString(),
                params: generation.params,
                git_state: {
                    head_sha: generation.fingerprint.headSha,
                    index_mtime_ms: generation.fingerprint.indexMtimeMs,
                    index_size: generation.fingerprint.indexSize
                }
            }, writeAuthenticationKey);

            try {
                writeSnapshotCache(cachePath, entry);
            } catch {
                // Best-effort write; cache failure must not break the gate
            }
        }
    }

    return { ...fresh, cache_hit: false };
}

export function getWorkspaceSnapshotCached(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean,
    explicitChangedFiles: string[],
    options: WorkspaceSnapshotCacheOptions = {}
): ResolvedWorkspaceSnapshot {
    const generation = createWorkspaceSnapshotCacheGeneration(
        repoRoot,
        detectionSource,
        includeUntracked,
        explicitChangedFiles
    );
    return getWorkspaceSnapshotCachedFromGeneration(
        repoRoot,
        explicitChangedFiles,
        options,
        generation
    );
}
