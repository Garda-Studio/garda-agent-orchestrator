import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFileAtomically } from '../../core/filesystem';
import { BUILT_IN_REVIEW_TYPE_IDS } from '../../core/review-catalog';
import {
    assertCanonicalTaskId,
    buildKnownReviewArtifactSuffixes,
    isCanonicalTaskId,
    KNOWN_REVIEW_ARTIFACT_SUFFIXES,
    parseKnownReviewArtifactTaskId,
    TASK_ID_MAX_LENGTH
} from '../../core/task-ids';
import { resolveEffectiveReviewLaneSetOrLegacy } from '../../policy/effective-review-lane-set';
import { inspectFilesystemLock, withFilesystemLock } from '../timeline/task-events-locking';
import { isLowNoiseRuntimeWritesEnabled } from '../derived-runtime-writes';

// Bounded metadata cache for runtime/reviews artifacts.
// Avoids full readdirSync scans growing linearly with historical
// handshake/task-mode artifacts; refreshed when the directory mtime
// changes or when the index is stale.

const INDEX_FILE_NAME = 'reviews-index.json';
const INDEX_VERSION = 4;
const DEFAULT_INDEX_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_INDEX_LOCK_RETRY_MS = 25;
const DEFAULT_INDEX_LOCK_STALE_MS = 30 * 1000;
const SELF_WRITE_MARKER_TOLERANCE_MS = 0.01;
const MAX_COMPRESSED_ARTIFACT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_REVIEW_ARTIFACT_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_REVIEWS_INDEX_BYTES = 64 * 1024 * 1024;
const REVIEW_PATTERN_CACHE_LIMIT = 64;
const immutableReviewSnapshotPatternCache = new Map<string, RegExp | null>();
const immutableReviewArtifactTypePatternCache = new Map<string, RegExp | null>();
const inProcessReviewTransactionSnapshots = new Map<string, { depth: number; index: ReviewsIndex }>();
const inProcessTaskIndexReadSnapshots = new Map<string, {
    depth: number;
    index: ReviewsIndex | null;
}>();

export const KNOWN_SUFFIXES = KNOWN_REVIEW_ARTIFACT_SUFFIXES;

export interface ReviewsIndexEntry {
    fileName: string;
    taskId: string;
    artifactType: string;
    mtimeMs: number;
    sizeBytes: number;
}

export interface ReviewsIndex {
    version: 4;
    directoryMtimeMs: number;
    directoryCtimeMs?: number;
    directoryEntryCount?: number;
    directoryUnindexedEntryCount?: number;
    generatedAtMs: number;
    entries_sha256?: string;
    entries: ReviewsIndexEntry[];
}

export interface ReviewsIndexLoadResult {
    index: ReviewsIndex;
    source: 'cache' | 'rebuilt';
}

export type ReviewsIndexMutationStatus =
    | 'updated'
    | 'skipped_unparseable_name'
    | 'skipped_missing_artifact'
    | 'skipped_low_noise'
    | 'failed';

export interface ReviewsIndexMutationResult {
    status: ReviewsIndexMutationStatus;
    index_path: string;
    file_name?: string;
    error?: string;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function cloneReviewsIndex(index: ReviewsIndex): ReviewsIndex {
    return {
        version: index.version,
        directoryMtimeMs: index.directoryMtimeMs,
        ...(typeof index.directoryCtimeMs === 'number' ? { directoryCtimeMs: index.directoryCtimeMs } : {}),
        ...(typeof index.directoryEntryCount === 'number' ? { directoryEntryCount: index.directoryEntryCount } : {}),
        ...(typeof index.directoryUnindexedEntryCount === 'number'
            ? { directoryUnindexedEntryCount: index.directoryUnindexedEntryCount }
            : {}),
        generatedAtMs: index.generatedAtMs,
        entries_sha256: index.entries_sha256 ?? computeEntriesSha256(index.entries),
        entries: index.entries.map((entry) => ({ ...entry }))
    };
}

function resolveTaskIndexReadSnapshotKey(reviewsDir: string, taskId: string): string {
    return `${path.resolve(reviewsDir)}\u0000${taskId}`;
}

function releaseTaskIndexReadSnapshot(snapshotKey: string): void {
    const snapshot = inProcessTaskIndexReadSnapshots.get(snapshotKey);
    if (!snapshot) {
        return;
    }
    snapshot.depth -= 1;
    if (snapshot.depth <= 0) {
        inProcessTaskIndexReadSnapshots.delete(snapshotKey);
    }
}

function computeEntriesSha256(entries: readonly ReviewsIndexEntry[]): string {
    return createHash('sha256')
        .update(JSON.stringify(entries), 'utf8')
        .digest('hex');
}

function getDirectoryTimestampSnapshot(dirPath: string): { mtimeMs: number; ctimeMs: number } {
    try {
        const stat = fs.statSync(dirPath);
        return {
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs
        };
    } catch {
        return {
            mtimeMs: 0,
            ctimeMs: 0
        };
    }
}

function getDirectoryEntryCount(dirPath: string): number {
    try {
        return fs.readdirSync(dirPath).filter((entryName) => (
            entryName !== INDEX_FILE_NAME
            && !entryName.endsWith('.lock')
        )).length;
    } catch {
        return 0;
    }
}

function refreshIndexDirectoryMetadata(index: ReviewsIndex, reviewsDir: string): void {
    const dirSnapshot = getDirectoryTimestampSnapshot(reviewsDir);
    index.directoryMtimeMs = dirSnapshot.mtimeMs;
    index.directoryCtimeMs = dirSnapshot.ctimeMs;
    index.directoryEntryCount = getDirectoryEntryCount(reviewsDir);
    index.directoryUnindexedEntryCount = Math.max(0, index.directoryEntryCount - index.entries.length);
    index.generatedAtMs = Date.now();
}

function timestampsMatchSelfWriteMarker(leftMs: number, rightMs: number): boolean {
    return Math.abs(leftMs - rightMs) <= SELF_WRITE_MARKER_TOLERANCE_MS;
}

function markIndexFileAsDirectorySelfWrite(indexPath: string, reviewsDir: string): void {
    try {
        const directorySnapshot = getDirectoryTimestampSnapshot(reviewsDir);
        const markerSeconds = directorySnapshot.mtimeMs / 1000;
        fs.utimesSync(indexPath, markerSeconds, markerSeconds);
    } catch {
        // Best-effort marker; a missed marker only causes a rebuild.
    }
}

function isDirectoryChangeFromIndexWrite(
    indexPath: string,
    cached: ReviewsIndex,
    currentDirSnapshot: { mtimeMs: number; ctimeMs: number }
): boolean {
    try {
        const indexStat = fs.statSync(indexPath);
        if (!indexStat.isFile()) {
            return false;
        }
        return (
            currentDirSnapshot.mtimeMs >= cached.directoryMtimeMs
            && timestampsMatchSelfWriteMarker(indexStat.mtimeMs, currentDirSnapshot.mtimeMs)
        );
    } catch {
        return false;
    }
}

function isReviewsIndexEntry(value: unknown): value is ReviewsIndexEntry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    if (
        typeof entry.fileName !== 'string'
        || typeof entry.taskId !== 'string'
        || typeof entry.artifactType !== 'string'
        || typeof entry.mtimeMs !== 'number'
        || !Number.isFinite(entry.mtimeMs)
        || typeof entry.sizeBytes !== 'number'
        || !Number.isSafeInteger(entry.sizeBytes)
        || entry.sizeBytes < 0
    ) {
        return false;
    }
    return isCanonicalTaskId(entry.taskId)
        && !entry.fileName.includes('/')
        && !entry.fileName.includes('\\')
        && entry.fileName === `${entry.taskId}-${entry.artifactType}`;
}

function createTaskScopedIndexView(index: ReviewsIndex, taskId: string): ReviewsIndex {
    const entries = index.entries.filter((entry) => entry.taskId === taskId);
    return {
        version: index.version,
        directoryMtimeMs: index.directoryMtimeMs,
        ...(typeof index.directoryCtimeMs === 'number' ? { directoryCtimeMs: index.directoryCtimeMs } : {}),
        directoryEntryCount: entries.length,
        directoryUnindexedEntryCount: 0,
        generatedAtMs: index.generatedAtMs,
        entries_sha256: computeEntriesSha256(entries),
        entries
    };
}

function readIndexFile(
    indexPath: string,
    entriesPendingRemoval: ReadonlySet<string> = new Set(),
    taskId: string | null = null
): ReviewsIndex | null {
    try {
        if (!fs.existsSync(indexPath)) return null;
        const indexStat = fs.statSync(indexPath);
        if (!indexStat.isFile() || indexStat.size > MAX_REVIEWS_INDEX_BYTES) {
            return null;
        }
        const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
        if (
            raw?.version !== INDEX_VERSION
            || typeof raw.directoryMtimeMs !== 'number'
            || !Number.isFinite(raw.directoryMtimeMs)
            || raw.directoryMtimeMs < 0
            || (
                raw.directoryCtimeMs !== undefined
                && (
                    typeof raw.directoryCtimeMs !== 'number'
                    || !Number.isFinite(raw.directoryCtimeMs)
                    || raw.directoryCtimeMs < 0
                )
            )
            || typeof raw.generatedAtMs !== 'number'
            || !Number.isSafeInteger(raw.generatedAtMs)
            || raw.generatedAtMs < 0
            || raw.generatedAtMs > Date.now()
            || typeof raw.entries_sha256 !== 'string'
            || !/^[0-9a-f]{64}$/u.test(raw.entries_sha256)
            || !Array.isArray(raw.entries)
            || typeof raw.directoryEntryCount !== 'number'
            || !Number.isSafeInteger(raw.directoryEntryCount)
            || raw.directoryEntryCount < 0
            || typeof raw.directoryUnindexedEntryCount !== 'number'
            || !Number.isSafeInteger(raw.directoryUnindexedEntryCount)
            || raw.directoryUnindexedEntryCount < 0
            || raw.directoryEntryCount !== raw.entries.length + raw.directoryUnindexedEntryCount
            || !raw.entries.every(isReviewsIndexEntry)
        ) {
            return null;
        }
        const entries = raw.entries as ReviewsIndexEntry[];
        if (raw.entries_sha256 !== computeEntriesSha256(entries)) {
            return null;
        }
        const fileNames = new Set(entries.map((entry) => entry.fileName));
        if (fileNames.size !== entries.length) {
            return null;
        }
        const scopedEntries = taskId === null
            ? entries
            : entries.filter((entry) => entry.taskId === taskId);
        const entriesRequiringDiskAuthorization = scopedEntries.filter((entry) => (
            !entriesPendingRemoval.has(entry.fileName)
            && parseKnownReviewArtifactTaskId(entry.fileName, KNOWN_SUFFIXES) !== entry.taskId
        ));
        if (entriesRequiringDiskAuthorization.length === 0) {
            const index = raw as unknown as ReviewsIndex;
            return taskId === null ? index : createTaskScopedIndexView(index, taskId);
        }
        const reviewsDir = path.dirname(indexPath);
        const reviewsRootRealPath = resolveReviewsRootRealPath(reviewsDir);
        if (!reviewsRootRealPath) {
            return null;
        }
        const reviewTypeIdsByTask = collectSnapshotBackedReviewTypeIdsFromFileNames(
            reviewsDir,
            entries
                .filter((entry) => (
                    !entriesPendingRemoval.has(entry.fileName)
                    && (
                        taskId === null
                        || (
                            entry.artifactType === 'preflight.json'
                            && taskIdsShareHierarchy(taskId, entry.taskId)
                        )
                    )
                ))
                .map((entry) => entry.fileName),
            reviewsRootRealPath
        );
        const entriesAreAuthorized = entriesRequiringDiskAuthorization.every((entry) => {
            if (!resolveContainedRegularReviewArtifact(reviewsDir, entry.fileName, reviewsRootRealPath)) {
                return false;
            }
            const parsed = parseSnapshotAuthorizedReviewArtifactFromDisk(
                entry.fileName,
                reviewTypeIdsByTask,
                reviewsDir,
                reviewsRootRealPath
            );
            if (
                parsed?.taskId === entry.taskId
                && parsed.artifactType === entry.artifactType
            ) {
                return true;
            }
            return false;
        });
        if (!entriesAreAuthorized) {
            return null;
        }
        const index = raw as unknown as ReviewsIndex;
        return taskId === null ? index : createTaskScopedIndexView(index, taskId);
    } catch {
        return null;
    }
}

/**
 * Determine whether the cached index is still valid.
 *
 * The index is stale when:
 * - it doesn't exist or is unreadable
 * - the reviews directory mtime changed for a reason other than our own index rewrite
 * - the index is older than `maxStalenessMs` (guard against mtime quirks)
 */
export function isIndexStale(
    indexPath: string,
    reviewsDir: string,
    maxStalenessMs: number = 60_000
): boolean {
    const cached = readIndexFile(indexPath);
    if (!cached) return true;

    return isLoadedIndexStale(indexPath, reviewsDir, cached, maxStalenessMs);
}

function isLoadedIndexStale(
    indexPath: string,
    reviewsDir: string,
    cached: ReviewsIndex,
    maxStalenessMs: number
): boolean {

    const currentDirSnapshot = getDirectoryTimestampSnapshot(reviewsDir);
    const directoryMetadataChanged = currentDirSnapshot.mtimeMs !== cached.directoryMtimeMs
        || (
            typeof cached.directoryCtimeMs === 'number'
            && currentDirSnapshot.ctimeMs !== cached.directoryCtimeMs
        );
    if (
        directoryMetadataChanged
        && !isDirectoryChangeFromIndexWrite(indexPath, cached, currentDirSnapshot)
    ) {
        return true;
    }

    return Date.now() - cached.generatedAtMs > maxStalenessMs;
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function resolveContainedRegularReviewArtifact(
    reviewsDir: string,
    fileName: string,
    reviewsRootRealPath: string | null = null
): { artifactPath: string; stat: fs.Stats } | null {
    const artifactPath = path.join(reviewsDir, fileName);
    try {
        const stat = fs.lstatSync(artifactPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            return null;
        }
        const reviewsRoot = reviewsRootRealPath || fs.realpathSync(reviewsDir);
        const artifactRealPath = fs.realpathSync(artifactPath);
        const relativePath = path.relative(reviewsRoot, artifactRealPath);
        if (
            relativePath === '..'
            || relativePath.startsWith(`..${path.sep}`)
            || path.isAbsolute(relativePath)
        ) {
            return null;
        }
        return { artifactPath: artifactRealPath, stat };
    } catch {
        return null;
    }
}

function resolveReviewsRootRealPath(reviewsDir: string): string | null {
    try {
        return fs.realpathSync(reviewsDir);
    } catch {
        return null;
    }
}

function readReviewArtifactText(
    reviewsDir: string,
    fileName: string,
    reviewsRootRealPath: string | null = null
): string {
    const artifact = resolveContainedRegularReviewArtifact(reviewsDir, fileName, reviewsRootRealPath);
    if (!artifact) {
        throw new Error(`Review artifact must be a regular file inside the reviews root: ${fileName}`);
    }
    if (artifact.stat.size > MAX_REVIEW_ARTIFACT_INPUT_BYTES) {
        throw new Error(`Review artifact exceeds the bounded input size: ${fileName}`);
    }
    if (!fileName.endsWith('.gz')) {
        return fs.readFileSync(artifact.artifactPath, 'utf8');
    }
    return zlib.gunzipSync(fs.readFileSync(artifact.artifactPath), {
        maxOutputLength: MAX_COMPRESSED_ARTIFACT_OUTPUT_BYTES
    }).toString('utf8');
}

function buildReviewTypePatternAlternatives(reviewTypeIds: readonly string[]): string[] {
    return [...new Set(reviewTypeIds)]
        .filter((reviewType) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(reviewType))
        .sort((left, right) => right.length - left.length || left.localeCompare(right))
        .map(escapeRegex);
}

function setBoundedPatternCache(
    cache: Map<string, RegExp | null>,
    key: string,
    value: RegExp | null
): RegExp | null {
    if (cache.size >= REVIEW_PATTERN_CACHE_LIMIT) {
        const oldestKey = cache.keys().next().value;
        if (typeof oldestKey === 'string') {
            cache.delete(oldestKey);
        }
    }
    cache.set(key, value);
    return value;
}

function buildImmutableReviewSnapshotPattern(reviewTypeIds: readonly string[]): RegExp | null {
    const alternatives = buildReviewTypePatternAlternatives(reviewTypeIds);
    const cacheKey = alternatives.join('\u0000');
    if (immutableReviewSnapshotPatternCache.has(cacheKey)) {
        return immutableReviewSnapshotPatternCache.get(cacheKey) || null;
    }
    if (alternatives.length === 0) {
        return setBoundedPatternCache(immutableReviewSnapshotPatternCache, cacheKey, null);
    }
    return setBoundedPatternCache(immutableReviewSnapshotPatternCache, cacheKey, new RegExp(
        `^(T-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)-(${alternatives.join('|')})-`
        + '(artifact|receipt|findings-validation|findings-disposition|remediation-baseline)-([0-9a-f]{64})\\.(json|md)(\\.gz)?$',
        'u'
    ));
}

function buildImmutableReviewArtifactTypePattern(reviewTypeIds: readonly string[]): RegExp | null {
    const alternatives = buildReviewTypePatternAlternatives(reviewTypeIds);
    const cacheKey = alternatives.join('\u0000');
    if (immutableReviewArtifactTypePatternCache.has(cacheKey)) {
        return immutableReviewArtifactTypePatternCache.get(cacheKey) || null;
    }
    if (alternatives.length === 0) {
        return setBoundedPatternCache(immutableReviewArtifactTypePatternCache, cacheKey, null);
    }
    return setBoundedPatternCache(immutableReviewArtifactTypePatternCache, cacheKey, new RegExp(
        `^(${alternatives.join('|')})-`
        + '(artifact|receipt|findings-validation|findings-disposition|remediation-baseline)-([0-9a-f]{64})\\.(json|md)(\\.gz)?$',
        'u'
    ));
}

function collectSnapshotBackedReviewTypeIdsFromFileNames(
    reviewsDir: string,
    fileNames: readonly string[],
    reviewsRootRealPath: string | null = null
): ReadonlyMap<string, readonly string[]> {
    const reviewTypeIdsByTask = new Map<string, readonly string[]>();
    for (const fileName of fileNames) {
        const taskId = parseKnownReviewArtifactTaskId(fileName, ['-preflight.json']);
        if (!taskId) {
            continue;
        }
        try {
            const preflight = JSON.parse(
                readReviewArtifactText(reviewsDir, fileName, reviewsRootRealPath)
            ) as Record<string, unknown>;
            if (String(preflight.task_id || '').trim() !== taskId) {
                continue;
            }
            reviewTypeIdsByTask.set(
                taskId,
                Object.freeze([...resolveEffectiveReviewLaneSetOrLegacy(preflight).all_review_ids])
            );
        } catch {
            // Invalid snapshots are not authority for custom artifact parsing.
        }
    }
    return reviewTypeIdsByTask;
}

export function collectSnapshotBackedReviewTypeIdsByTask(
    reviewsDir: string
): ReadonlyMap<string, readonly string[]> {
    let fileNames: string[];
    try {
        fileNames = fs.readdirSync(reviewsDir);
    } catch {
        return new Map<string, readonly string[]>();
    }
    return collectSnapshotBackedReviewTypeIdsFromFileNames(
        reviewsDir,
        fileNames,
        resolveReviewsRootRealPath(reviewsDir)
    );
}

function parseReviewArtifactForKnownTask(
    fileName: string,
    taskId: string,
    reviewTypeIds: readonly string[]
): { taskId: string; artifactType: string } | null {
    const prefix = `${taskId}-`;
    if (!fileName.startsWith(prefix)) {
        return null;
    }
    const artifactType = fileName.slice(prefix.length);
    const immutableSnapshotMatch = buildImmutableReviewArtifactTypePattern(reviewTypeIds)
        ?.exec(artifactType) || null;
    if (immutableSnapshotMatch) {
        const [, , snapshotType, , extension] = immutableSnapshotMatch;
        const expectedExtension = snapshotType === 'artifact' ? 'md' : 'json';
        if (extension === expectedExtension) {
            return { taskId, artifactType };
        }
    }
    for (const suffix of buildKnownReviewArtifactSuffixes(reviewTypeIds)) {
        const expectedArtifactType = suffix.slice(1);
        if (artifactType === expectedArtifactType || artifactType === `${expectedArtifactType}.gz`) {
            return { taskId, artifactType };
        }
    }
    return null;
}

export function parseSnapshotAuthorizedReviewArtifactFileName(
    fileName: string,
    reviewTypeIdsByTask: ReadonlyMap<string, readonly string[]>,
    declaredTaskId: string | null = null
): { taskId: string; artifactType: string } | null {
    return parseSnapshotAuthorizedReviewArtifactFileNameDetails(
        fileName,
        reviewTypeIdsByTask,
        declaredTaskId
    ).parsed;
}

function collectMatchingTaskIds(
    fileName: string,
    reviewTypeIdsByTask: ReadonlyMap<string, readonly string[]>
): string[] {
    if (!fileName.startsWith('T-')) {
        return [];
    }
    const matchingTaskIds: string[] = [];
    let separatorIndex = fileName.indexOf('-', 2);
    while (separatorIndex > 0 && separatorIndex <= TASK_ID_MAX_LENGTH) {
        const candidateTaskId = fileName.slice(0, separatorIndex);
        if (reviewTypeIdsByTask.has(candidateTaskId)) {
            matchingTaskIds.push(candidateTaskId);
        }
        separatorIndex = fileName.indexOf('-', separatorIndex + 1);
    }
    return matchingTaskIds.reverse();
}

function parseSnapshotAuthorizedReviewArtifactFileNameDetails(
    fileName: string,
    reviewTypeIdsByTask: ReadonlyMap<string, readonly string[]>,
    declaredTaskId: string | null = null
): {
    parsed: { taskId: string; artifactType: string } | null;
    requiresTaskBinding: boolean;
} {
    const matchingTaskIds = collectMatchingTaskIds(fileName, reviewTypeIdsByTask);
    const interpretations = new Map<string, { taskId: string; artifactType: string }>();
    for (const taskId of matchingTaskIds) {
        const parsed = parseReviewArtifactForKnownTask(
            fileName,
            taskId,
            reviewTypeIdsByTask.get(taskId) || BUILT_IN_REVIEW_TYPE_IDS
        );
        if (parsed) {
            interpretations.set(`${parsed.taskId}\u0000${parsed.artifactType}`, parsed);
        }
    }

    const legacyParsed = parseReviewArtifactFileNameFromKnownSuffixes(
        fileName,
        BUILT_IN_REVIEW_TYPE_IDS
    );
    if (legacyParsed) {
        interpretations.set(`${legacyParsed.taskId}\u0000${legacyParsed.artifactType}`, legacyParsed);
    }
    if (matchingTaskIds.length === 0) {
        return { parsed: legacyParsed, requiresTaskBinding: false };
    }
    const candidates = [...interpretations.values()];
    if (declaredTaskId) {
        const declaredCandidates = candidates.filter((candidate) => candidate.taskId === declaredTaskId);
        if (declaredCandidates.length === 1) {
            return { parsed: declaredCandidates[0], requiresTaskBinding: false };
        }
    }
    const interpretedTaskIds = new Set(candidates.map((candidate) => candidate.taskId));
    if (candidates.length > 0 && interpretedTaskIds.size === 1) {
        return { parsed: candidates[0], requiresTaskBinding: false };
    }
    // A filename that is valid for multiple tasks is not ownership evidence.
    // Current custom artifacts are resolved through their own task_id or a
    // task-bound companion artifact. Leave an unbound collision unindexed so
    // cleanup and retention cannot act on it under the wrong task lifecycle.
    return {
        parsed: null,
        requiresTaskBinding: candidates.length > 0
    };
}

function parseReviewArtifactFileNameFromKnownSuffixes(
    fileName: string,
    reviewTypeIds: readonly string[]
): { taskId: string; artifactType: string } | null {
    if (!fileName.startsWith('T-')) return null;

    const immutableSnapshotMatch = buildImmutableReviewSnapshotPattern(reviewTypeIds)?.exec(fileName) || null;
    if (immutableSnapshotMatch) {
        const [, taskId, , snapshotType, , extension] = immutableSnapshotMatch;
        const expectedExtension = snapshotType === 'artifact' ? 'md' : 'json';
        if (extension === expectedExtension && isCanonicalTaskId(taskId)) {
            return {
                taskId,
                artifactType: fileName.slice(taskId.length + 1)
            };
        }
    }

    // Try known suffixes first for deterministic parsing
    for (const suffix of buildKnownReviewArtifactSuffixes(reviewTypeIds)) {
        if (fileName.endsWith(suffix)) {
            const taskId = fileName.slice(0, fileName.length - suffix.length);
            if (taskId.length > 2) {
                return { taskId, artifactType: suffix.slice(1) };
            }
        }
        // Also match compressed variants of the same artifact suffix.
        const gzSuffix = `${suffix}.gz`;
        if (fileName.endsWith(gzSuffix)) {
            const taskId = fileName.slice(0, fileName.length - gzSuffix.length);
            if (taskId.length > 2) {
                return { taskId, artifactType: gzSuffix.slice(1) };
            }
        }
    }

    return null;
}

export function parseReviewArtifactFileName(
    fileName: string,
    reviewTypeIds: readonly string[] = BUILT_IN_REVIEW_TYPE_IDS
): { taskId: string; artifactType: string } | null {
    const knownSuffixMatch = parseReviewArtifactFileNameFromKnownSuffixes(fileName, reviewTypeIds);
    if (knownSuffixMatch) {
        return knownSuffixMatch;
    }

    // Fallback for simple task IDs (T-NNN-artifactType): split at
    // second `-` after the `T-` prefix. Only reliable for `T-\d+-`
    // formatted IDs; multi-segment IDs need a known suffix above.
    const match = /^(T-\d+)-(.+)$/.exec(fileName);
    if (match) {
        return { taskId: match[1], artifactType: match[2] };
    }

    return null;
}

function buildArtifactTaskBindingCandidates(fileName: string): readonly string[] {
    const normalizedFileName = fileName.endsWith('.gz') ? fileName.slice(0, -3) : fileName;
    const prefersGzip = fileName.endsWith('.gz');
    const candidateBaseNames = new Set<string>([normalizedFileName]);
    const scopedMetadataFileName = normalizedFileName.endsWith('-scoped.diff')
        ? normalizedFileName.replace(/-scoped\.diff$/u, '-scoped.json')
        : null;
    if (scopedMetadataFileName) {
        candidateBaseNames.add(scopedMetadataFileName);
    }
    if (normalizedFileName.endsWith('-review-context.md')) {
        candidateBaseNames.add(normalizedFileName.replace(/-review-context\.md$/u, '-review-context.json'));
    }
    if (/-(?:role-prompt|prompt-template|output-template)\.md$/u.test(normalizedFileName)) {
        candidateBaseNames.add(normalizedFileName.replace(
            /-(?:role-prompt|prompt-template|output-template)\.md$/u,
            '-review-context.json'
        ));
        candidateBaseNames.add(normalizedFileName.replace(
            /-(?:role-prompt|prompt-template|output-template)\.md$/u,
            '-evidence-manifest.json'
        ));
    }
    if (normalizedFileName.endsWith('-review-output.md')) {
        candidateBaseNames.add(normalizedFileName.replace(/-review-output\.md$/u, '-receipt.json'));
    }
    const hashedArtifactMatch = /^(.*)-artifact-([0-9a-f]{64})\.md$/u.exec(normalizedFileName);
    if (hashedArtifactMatch) {
        candidateBaseNames.add(`${hashedArtifactMatch[1]}-receipt-${hashedArtifactMatch[2]}.json`);
    }
    if (normalizedFileName.endsWith('.md')) {
        candidateBaseNames.add(`${normalizedFileName.slice(0, -3)}-receipt.json`);
    }

    const candidateFileNames: string[] = [];
    for (const candidateBaseName of candidateBaseNames) {
        const variants = prefersGzip
            ? [`${candidateBaseName}.gz`, candidateBaseName]
            : [candidateBaseName, `${candidateBaseName}.gz`];
        for (const variant of variants) {
            if (!candidateFileNames.includes(variant)) {
                candidateFileNames.push(variant);
            }
        }
    }
    return candidateFileNames;
}

function readDeclaredArtifactTaskId(
    reviewsDir: string,
    fileName: string,
    reviewsRootRealPath: string | null = null
): string | null {
    const candidateFileNames = buildArtifactTaskBindingCandidates(fileName);
    for (const candidateFileName of candidateFileNames) {
        const candidateNameWithoutGzip = candidateFileName.endsWith('.gz')
            ? candidateFileName.slice(0, -3)
            : candidateFileName;
        if (!candidateNameWithoutGzip.endsWith('.json') && !candidateNameWithoutGzip.endsWith('.md')) {
            continue;
        }
        try {
            const payload = JSON.parse(
                readReviewArtifactText(reviewsDir, candidateFileName, reviewsRootRealPath)
            ) as Record<string, unknown>;
            const taskId = String(payload.task_id || '').trim();
            if (isCanonicalTaskId(taskId)) {
                return taskId;
            }
        } catch {
            // Legacy markdown and missing scoped metadata do not carry task binding.
        }
    }
    return null;
}

function parseSnapshotAuthorizedReviewArtifactFromDisk(
    fileName: string,
    reviewTypeIdsByTask: ReadonlyMap<string, readonly string[]>,
    reviewsDir: string,
    reviewsRootRealPath: string | null = null
): { taskId: string; artifactType: string } | null {
    const unbound = parseSnapshotAuthorizedReviewArtifactFileNameDetails(
        fileName,
        reviewTypeIdsByTask
    );
    if (unbound.parsed || !unbound.requiresTaskBinding) {
        return unbound.parsed;
    }
    const declaredTaskId = readDeclaredArtifactTaskId(
        reviewsDir,
        fileName,
        reviewsRootRealPath
    );
    if (!declaredTaskId) {
        return null;
    }
    return parseSnapshotAuthorizedReviewArtifactFileNameDetails(
        fileName,
        reviewTypeIdsByTask,
        declaredTaskId
    ).parsed;
}

/**
 * Perform a full directory scan and build a fresh index.
 */
function taskIdsShareHierarchy(leftTaskId: string, rightTaskId: string): boolean {
    return leftTaskId === rightTaskId
        || leftTaskId.startsWith(`${rightTaskId}-`)
        || rightTaskId.startsWith(`${leftTaskId}-`);
}

function rebuildIndexScope(reviewsDir: string, taskId: string | null): ReviewsIndex {
    const entries: ReviewsIndexEntry[] = [];
    const dirSnapshot = getDirectoryTimestampSnapshot(reviewsDir);

    let fileNames: string[];
    try {
        fileNames = fs.readdirSync(reviewsDir);
    } catch {
        return {
            version: INDEX_VERSION,
            directoryMtimeMs: dirSnapshot.mtimeMs,
            directoryCtimeMs: dirSnapshot.ctimeMs,
            directoryEntryCount: 0,
            directoryUnindexedEntryCount: 0,
            generatedAtMs: Date.now(),
            entries_sha256: computeEntriesSha256(entries),
            entries
        };
    }

    const indexedCandidates = fileNames.filter((fileName) => (
        fileName !== INDEX_FILE_NAME && !fileName.endsWith('.lock')
    ));
    const scopedCandidates = taskId === null
        ? indexedCandidates
        : indexedCandidates.filter((fileName) => fileName.startsWith(`${taskId}-`));
    const snapshotAuthorityFileNames = taskId === null
        ? fileNames
        : fileNames.filter((fileName) => {
            const snapshotTaskId = parseKnownReviewArtifactTaskId(fileName, ['-preflight.json']);
            return snapshotTaskId !== null && taskIdsShareHierarchy(taskId, snapshotTaskId);
        });
    const reviewsRootRealPath = resolveReviewsRootRealPath(reviewsDir);
    const reviewTypeIdsByTask = collectSnapshotBackedReviewTypeIdsFromFileNames(
        reviewsDir,
        snapshotAuthorityFileNames,
        reviewsRootRealPath
    );
    for (const fileName of scopedCandidates) {
        const parsed = parseSnapshotAuthorizedReviewArtifactFromDisk(
            fileName,
            reviewTypeIdsByTask,
            reviewsDir,
            reviewsRootRealPath
        );
        if (!parsed || (taskId !== null && parsed.taskId !== taskId)) continue;

        try {
            const artifact = resolveContainedRegularReviewArtifact(
                reviewsDir,
                fileName,
                reviewsRootRealPath
            );
            if (!artifact) continue;
            entries.push({
                fileName,
                taskId: parsed.taskId,
                artifactType: parsed.artifactType,
                mtimeMs: artifact.stat.mtimeMs,
                sizeBytes: artifact.stat.size
            });
        } catch {
            // Skip unreadable files
        }
    }

    return {
        version: INDEX_VERSION,
        directoryMtimeMs: dirSnapshot.mtimeMs,
        directoryCtimeMs: dirSnapshot.ctimeMs,
        directoryEntryCount: scopedCandidates.length,
        directoryUnindexedEntryCount: Math.max(0, scopedCandidates.length - entries.length),
        generatedAtMs: Date.now(),
        entries_sha256: computeEntriesSha256(entries),
        entries
    };
}

/**
 * Perform a full directory scan and build a fresh global index.
 */
export function rebuildIndex(reviewsDir: string): ReviewsIndex {
    return rebuildIndexScope(reviewsDir, null);
}

/**
 * Build a current index view for one task without authorizing or statting
 * unrelated historical review artifacts.
 */
export function rebuildTaskIndex(reviewsDir: string, taskId: string): ReviewsIndex {
    return rebuildIndexScope(reviewsDir, assertCanonicalTaskId(taskId));
}

/**
 * Write the index atomically to avoid partial reads.
 */
export function writeIndex(indexPath: string, index: ReviewsIndex): void {
    const dir = path.dirname(indexPath);
    index.entries_sha256 = computeEntriesSha256(index.entries);
    writeFileAtomically(indexPath, JSON.stringify(index, null, 2) + '\n', { encoding: 'utf8', fsync: false });
    markIndexFileAsDirectorySelfWrite(indexPath, dir);
}

export function resolveIndexPath(reviewsDir: string): string {
    return path.join(reviewsDir, INDEX_FILE_NAME);
}

export function resolveIndexLockPath(reviewsDir: string): string {
    return path.join(path.dirname(reviewsDir), '.reviews-index.lock');
}

export function resolveReviewTransactionLockPath(reviewsDir: string): string {
    return path.join(path.dirname(reviewsDir), '.reviews-transaction.lock');
}

export function beginInProcessReviewTransactionSnapshot(reviewsDir: string): () => void {
    const lockPath = resolveReviewTransactionLockPath(reviewsDir);
    const existing = inProcessReviewTransactionSnapshots.get(lockPath);
    if (existing) {
        existing.depth += 1;
        return () => {
            const current = inProcessReviewTransactionSnapshots.get(lockPath);
            if (!current) return;
            current.depth -= 1;
            if (current.depth <= 0) {
                inProcessReviewTransactionSnapshots.delete(lockPath);
            }
        };
    }

    inProcessReviewTransactionSnapshots.set(lockPath, {
        depth: 1,
        index: rebuildIndex(reviewsDir)
    });
    return () => {
        const current = inProcessReviewTransactionSnapshots.get(lockPath);
        if (!current) return;
        current.depth -= 1;
        if (current.depth <= 0) {
            inProcessReviewTransactionSnapshots.delete(lockPath);
        }
    };
}

function getInProcessReviewTransactionSnapshot(reviewsDir: string): ReviewsIndex | null {
    const snapshot = inProcessReviewTransactionSnapshots.get(resolveReviewTransactionLockPath(reviewsDir));
    return snapshot ? cloneReviewsIndex(snapshot.index) : null;
}

export function currentProcessOwnsReviewTransactionLock(reviewsDir: string): boolean {
    const inspection = inspectFilesystemLock(resolveReviewTransactionLockPath(reviewsDir), {
        staleMs: DEFAULT_INDEX_LOCK_STALE_MS
    });
    return inspection.exists
        && inspection.metadata.pid === process.pid
        && inspection.ownerHostMatchesCurrent !== false
        && inspection.ownerAlive !== false;
}

function withIndexUpdateLock<T>(reviewsDir: string, callback: () => T): T {
    const { result } = withFilesystemLock(resolveIndexLockPath(reviewsDir), {
        timeoutMs: DEFAULT_INDEX_LOCK_TIMEOUT_MS,
        retryMs: DEFAULT_INDEX_LOCK_RETRY_MS,
        staleMs: DEFAULT_INDEX_LOCK_STALE_MS,
        ownerLabel: 'reviews-index'
    }, callback);
    return result;
}

function withReviewTransactionReadBarrier<T>(
    reviewsDir: string,
    callback: () => T,
    options: { readOnly?: boolean } = {}
): T {
    if (currentProcessOwnsReviewTransactionLock(reviewsDir)) {
        return callback();
    }
    const lockPath = resolveReviewTransactionLockPath(reviewsDir);
    if (options.readOnly && !fs.existsSync(lockPath)) {
        return callback();
    }
    const { result } = withFilesystemLock(resolveReviewTransactionLockPath(reviewsDir), {
        timeoutMs: DEFAULT_INDEX_LOCK_TIMEOUT_MS,
        retryMs: DEFAULT_INDEX_LOCK_RETRY_MS,
        staleMs: DEFAULT_INDEX_LOCK_STALE_MS,
        ownerLabel: 'reviews-index-read-barrier'
    }, callback);
    return result;
}

/**
 * Load the reviews index, rebuilding from disk only when stale.
 *
 * Returns the index and whether it came from cache or was rebuilt.
 * The caller can use `source === 'rebuilt'` to know a full scan was done.
 */
export function loadIndex(
    reviewsDir: string,
    options: { maxStalenessMs?: number; forceRebuild?: boolean; readOnly?: boolean } = {}
): ReviewsIndexLoadResult {
    if (currentProcessOwnsReviewTransactionLock(reviewsDir)) {
        const transactionSnapshot = getInProcessReviewTransactionSnapshot(reviewsDir);
        if (transactionSnapshot) {
            return {
                index: transactionSnapshot,
                source: 'cache'
            };
        }
    }

    return withReviewTransactionReadBarrier(reviewsDir, () => {
        const indexPath = resolveIndexPath(reviewsDir);

        if (!options.forceRebuild) {
            const cached = readIndexFile(indexPath);
            if (
                cached
                && !isLoadedIndexStale(
                    indexPath,
                    reviewsDir,
                    cached,
                    options.maxStalenessMs ?? 60_000
                )
            ) {
                return { index: cached, source: 'cache' };
            }
        }

        if (options.readOnly || isLowNoiseRuntimeWritesEnabled()) {
            return {
                index: rebuildIndex(reviewsDir),
                source: 'rebuilt' as const
            };
        }

        return withIndexUpdateLock(reviewsDir, () => {
            if (!options.forceRebuild) {
                const cached = readIndexFile(indexPath);
                if (
                    cached
                    && !isLoadedIndexStale(
                        indexPath,
                        reviewsDir,
                        cached,
                        options.maxStalenessMs ?? 60_000
                    )
                ) {
                    return { index: cached, source: 'cache' as const };
                }
            }

            const index = rebuildIndex(reviewsDir);
            try {
                writeIndex(indexPath, index);
            } catch {
                // Non-fatal: return the fresh index even if we can't persist it
            }
            return { index, source: 'rebuilt' as const };
        });
    }, { readOnly: options.readOnly === true });
}

/**
 * Load a current task-only view of review artifacts. Task-scoped consumers
 * must not pay the authorization cost of every historical custom review
 * artifact merely to locate snapshots owned by one task.
 */
export function loadTaskIndex(reviewsDir: string, taskId: string): ReviewsIndexLoadResult {
    const safeTaskId = assertCanonicalTaskId(taskId);
    const snapshotKey = resolveTaskIndexReadSnapshotKey(reviewsDir, safeTaskId);
    const activeReadSnapshot = inProcessTaskIndexReadSnapshots.get(snapshotKey);
    if (activeReadSnapshot?.index) {
        return {
            index: cloneReviewsIndex(activeReadSnapshot.index),
            source: 'cache'
        };
    }

    const result = loadTaskIndexUncached(reviewsDir, safeTaskId);
    if (activeReadSnapshot) {
        activeReadSnapshot.index = cloneReviewsIndex(result.index);
    }
    return result;
}

function loadTaskIndexUncached(reviewsDir: string, safeTaskId: string): ReviewsIndexLoadResult {
    if (currentProcessOwnsReviewTransactionLock(reviewsDir)) {
        const transactionSnapshot = getInProcessReviewTransactionSnapshot(reviewsDir);
        if (transactionSnapshot) {
            const entries = entriesForTask(transactionSnapshot, safeTaskId);
            return {
                index: {
                    ...transactionSnapshot,
                    directoryEntryCount: entries.length,
                    directoryUnindexedEntryCount: 0,
                    entries_sha256: computeEntriesSha256(entries),
                    entries
                },
                source: 'cache'
            };
        }
    }

    return withReviewTransactionReadBarrier(reviewsDir, () => {
        const indexPath = resolveIndexPath(reviewsDir);
        const cached = readIndexFile(indexPath, new Set(), safeTaskId);
        if (
            cached
            && !isLoadedIndexStale(
                indexPath,
                reviewsDir,
                cached,
                Number.POSITIVE_INFINITY
            )
        ) {
            return { index: cached, source: 'cache' as const };
        }
        return {
            index: rebuildTaskIndex(reviewsDir, safeTaskId),
            source: 'rebuilt' as const
        };
    }, { readOnly: true });
}

/**
 * Reuse one fully validated task-scoped index during a synchronous read-only
 * operation. The snapshot is always released at the invocation boundary.
 */
export function withTaskIndexReadSnapshot<T>(
    reviewsDir: string,
    taskId: string,
    callback: () => T
): T {
    const safeTaskId = assertCanonicalTaskId(taskId);
    const snapshotKey = resolveTaskIndexReadSnapshotKey(reviewsDir, safeTaskId);
    const existing = inProcessTaskIndexReadSnapshots.get(snapshotKey);
    if (existing) {
        existing.depth += 1;
    } else {
        inProcessTaskIndexReadSnapshots.set(snapshotKey, { depth: 1, index: null });
    }
    try {
        return callback();
    } finally {
        releaseTaskIndexReadSnapshot(snapshotKey);
    }
}

export function rebuildAndPersistIndex(reviewsDir: string): ReviewsIndexMutationResult {
    const indexPath = resolveIndexPath(reviewsDir);
    try {
        return withIndexUpdateLock(reviewsDir, () => {
            const index = rebuildIndex(reviewsDir);
            writeIndex(indexPath, index);
            return {
                status: 'updated' as const,
                index_path: indexPath
            };
        });
    } catch (error: unknown) {
        return {
            status: 'failed',
            index_path: indexPath,
            error: getErrorMessage(error)
        };
    }
}

/**
 * Add or update a single entry in the index without a full rebuild.
 * If the index doesn't exist or is corrupt, a full rebuild is triggered.
 */
export function upsertEntry(reviewsDir: string, fileName: string): ReviewsIndexMutationResult {
    const indexPath = resolveIndexPath(reviewsDir);
    const reviewsRootRealPath = resolveReviewsRootRealPath(reviewsDir);
    const parsed = parseSnapshotAuthorizedReviewArtifactFromDisk(
        fileName,
        collectSnapshotBackedReviewTypeIdsByTask(reviewsDir),
        reviewsDir,
        reviewsRootRealPath
    );
    if (!parsed) {
        return {
            status: 'skipped_unparseable_name',
            index_path: indexPath,
            file_name: fileName
        };
    }

    try {
        return withIndexUpdateLock(reviewsDir, () => {
            let stat: fs.Stats;
            try {
                const artifact = resolveContainedRegularReviewArtifact(
                    reviewsDir,
                    fileName,
                    reviewsRootRealPath
                );
                if (!artifact) {
                    return {
                        status: 'skipped_missing_artifact' as const,
                        index_path: indexPath,
                        file_name: fileName
                    };
                }
                stat = artifact.stat;
            } catch {
                return {
                    status: 'skipped_missing_artifact' as const,
                    index_path: indexPath,
                    file_name: fileName
                };
            }

            let index = readIndexFile(indexPath);

            if (!index) {
                index = rebuildIndex(reviewsDir);
            } else {
                const existingIdx = index.entries.findIndex(e => e.fileName === fileName);
                const entry: ReviewsIndexEntry = {
                    fileName,
                    taskId: parsed.taskId,
                    artifactType: parsed.artifactType,
                    mtimeMs: stat.mtimeMs,
                    sizeBytes: stat.size
                };

                if (existingIdx >= 0) {
                    index.entries[existingIdx] = entry;
                } else {
                    index.entries.push(entry);
                }

                refreshIndexDirectoryMetadata(index, reviewsDir);
            }

            writeIndex(indexPath, index);
            return {
                status: 'updated' as const,
                index_path: indexPath,
                file_name: fileName
            };
        });
    } catch (error: unknown) {
        return {
            status: 'failed',
            index_path: indexPath,
            file_name: fileName,
            error: getErrorMessage(error)
        };
    }
}

/**
 * Remove entries for the given file names from the index.
 * If none of the names are in the index, this is a no-op.
 */
export function removeEntries(reviewsDir: string, fileNames: string[]): void {
    if (fileNames.length === 0) return;

    withIndexUpdateLock(reviewsDir, () => {
        const indexPath = resolveIndexPath(reviewsDir);
        const removeSet = new Set(fileNames);
        const index = readIndexFile(indexPath, removeSet);
        if (!index) return;

        const originalLength = index.entries.length;
        index.entries = index.entries.filter(e => !removeSet.has(e.fileName));

        if (index.entries.length === originalLength) return;

        refreshIndexDirectoryMetadata(index, reviewsDir);

        try {
            writeIndex(indexPath, index);
        } catch {
            // Non-fatal
        }
    });
}

/**
 * Invalidate (delete) the index file, forcing a full rebuild on next load.
 */
export function invalidateIndex(reviewsDir: string): void {
    withIndexUpdateLock(reviewsDir, () => {
        const indexPath = resolveIndexPath(reviewsDir);
        try {
            fs.rmSync(indexPath, { force: true });
        } catch {
            // Non-fatal
        }
    });
}

/**
 * Get all entries for a specific task id.
 */
export function entriesForTask(index: ReviewsIndex, taskId: string): ReviewsIndexEntry[] {
    return index.entries.filter(e => e.taskId === taskId);
}

/**
 * Get all entries matching a specific artifact type suffix (e.g. 'handshake.json').
 */
export function entriesByArtifactSuffix(
    index: ReviewsIndex,
    suffix: string
): ReviewsIndexEntry[] {
    return index.entries.filter(e => e.artifactType.endsWith(suffix));
}

/**
 * Get unique task IDs present in the index.
 */
export function taskIds(index: ReviewsIndex): string[] {
    return [...new Set(index.entries.map(e => e.taskId))];
}

/**
 * Group entries by task id.
 */
export function groupByTask(index: ReviewsIndex): Map<string, ReviewsIndexEntry[]> {
    const groups = new Map<string, ReviewsIndexEntry[]>();
    for (const entry of index.entries) {
        const group = groups.get(entry.taskId) || [];
        group.push(entry);
        groups.set(entry.taskId, group);
    }
    return groups;
}
