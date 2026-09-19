import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPlainRecord } from '../../core/records';
import { assertCanonicalTaskId } from '../../core/task-ids';
import {
    readReviewArtifactFileSha256,
    readReviewArtifactJsonSnapshot,
    readReviewArtifactTextSnapshot
} from '../../gate-runtime/review-artifacts';
import {
    entriesForTask,
    loadTaskIndex,
    type ReviewsIndexEntry
} from '../../gate-runtime/reviews-index';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface ReviewAttemptTextSnapshot {
    content: string | null;
    valid: boolean;
    sha256: string | null;
}

export interface ReviewAttemptJsonSnapshot {
    record: Record<string, unknown> | null;
    valid: boolean;
    sha256: string | null;
}

export interface ReviewAttemptArtifactIndex {
    readonly reviews_root: string;
    readonly task_id: string;
    listReceiptSnapshotFileNames(reviewType: string): readonly string[];
    readTextSnapshot(
        candidatePath: unknown,
        expectedFileName: string,
        expectedSha256: unknown
    ): ReviewAttemptTextSnapshot;
    readJsonSnapshot(
        candidatePath: unknown,
        expectedFileName: string,
        expectedSha256: unknown
    ): ReviewAttemptJsonSnapshot;
}

interface CachedSnapshotRead {
    valid: boolean;
    sha256: string | null;
}

interface ResolvedSnapshotRead extends CachedSnapshotRead {
    expectedPath: string | null;
}

function normalizeSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return SHA256_PATTERN.test(normalized) ? normalized : null;
}

function normalizeReviewType(value: string): string {
    return String(value || '').trim().toLowerCase();
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}

function indexEntryMatchesFile(entry: ReviewsIndexEntry, stat: fs.Stats): boolean {
    return stat.isFile()
        && !stat.isSymbolicLink()
        && entry.sizeBytes === stat.size
        && entry.mtimeMs === stat.mtimeMs;
}

function freezeRecord(value: Record<string, unknown>): Record<string, unknown> {
    for (const nested of Object.values(value)) {
        if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) {
            freezeRecord(nested as Record<string, unknown>);
        }
    }
    return Object.freeze(value);
}

export function createReviewAttemptArtifactIndex(
    reviewsRoot: string,
    taskId: string
): ReviewAttemptArtifactIndex {
    const resolvedReviewsRoot = path.resolve(reviewsRoot);
    const safeTaskId = assertCanonicalTaskId(taskId);
    const loadedIndex = loadTaskIndex(resolvedReviewsRoot, safeTaskId);
    const taskEntries = entriesForTask(loadedIndex.index, safeTaskId);
    const entriesByFileName = new Map<string, ReviewsIndexEntry>();
    const duplicateFileNames = new Set<string>();
    for (const entry of taskEntries) {
        if (entriesByFileName.has(entry.fileName)) {
            duplicateFileNames.add(entry.fileName);
        } else {
            entriesByFileName.set(entry.fileName, entry);
        }
    }

    const cachedReads = new Map<string, CachedSnapshotRead>();

    const readSnapshot = (
        candidatePath: unknown,
        expectedFileName: string,
        expectedSha256: unknown
    ): ResolvedSnapshotRead => {
        const normalizedExpectedSha256 = normalizeSha256(expectedSha256);
        const normalizedCandidate = String(candidatePath || '').trim();
        if (
            !normalizedExpectedSha256
            || !normalizedCandidate
            || path.basename(expectedFileName) !== expectedFileName
        ) {
            return { expectedPath: null, valid: false, sha256: null };
        }
        const expectedPath = path.resolve(resolvedReviewsRoot, expectedFileName);
        const candidateResolvedPath = path.isAbsolute(normalizedCandidate)
            ? path.resolve(normalizedCandidate)
            : path.resolve(resolvedReviewsRoot, normalizedCandidate);
        if (candidateResolvedPath !== expectedPath) {
            return { expectedPath: null, valid: false, sha256: null };
        }
        const cacheKey = `${expectedFileName}|${normalizedExpectedSha256}`;
        const cached = cachedReads.get(cacheKey);
        if (cached) {
            if (cached.valid) {
                const currentSha256 = readReviewArtifactFileSha256(expectedPath);
                if (currentSha256 !== cached.sha256) {
                    const divergent = { valid: false, sha256: null };
                    cachedReads.set(cacheKey, divergent);
                    return { expectedPath, ...divergent };
                }
            }
            return { expectedPath, ...cached };
        }
        const indexEntry = entriesByFileName.get(expectedFileName);
        if (!indexEntry || duplicateFileNames.has(expectedFileName)) {
            const missing = { valid: false, sha256: null };
            cachedReads.set(cacheKey, missing);
            return { expectedPath, ...missing };
        }
        try {
            const beforeRead = fs.lstatSync(expectedPath);
            if (!indexEntryMatchesFile(indexEntry, beforeRead)) {
                const divergent = { valid: false, sha256: null };
                cachedReads.set(cacheKey, divergent);
                return { expectedPath, ...divergent };
            }
            const actualSha256 = readReviewArtifactFileSha256(expectedPath);
            if (!actualSha256) {
                const unreadable = { valid: false, sha256: null };
                cachedReads.set(cacheKey, unreadable);
                return { expectedPath, ...unreadable };
            }
            const afterRead = fs.lstatSync(expectedPath);
            const valid = sameFileIdentity(beforeRead, afterRead)
                && actualSha256 === normalizedExpectedSha256;
            const result: CachedSnapshotRead = {
                valid,
                sha256: actualSha256
            };
            cachedReads.set(cacheKey, result);
            return { expectedPath, ...result };
        } catch {
            const unreadable = { valid: false, sha256: null };
            cachedReads.set(cacheKey, unreadable);
            return { expectedPath, ...unreadable };
        }
    };

    return Object.freeze({
        reviews_root: resolvedReviewsRoot,
        task_id: safeTaskId,
        listReceiptSnapshotFileNames(reviewType: string): readonly string[] {
            const normalizedReviewType = normalizeReviewType(reviewType);
            const prefix = `${safeTaskId}-${normalizedReviewType}-receipt-`;
            return Object.freeze(taskEntries
                .map((entry) => entry.fileName)
                .filter((fileName) => (
                    fileName.startsWith(prefix)
                    && fileName.endsWith('.json')
                    && SHA256_PATTERN.test(fileName.slice(prefix.length, -'.json'.length))
                ))
                .sort());
        },
        readTextSnapshot(
            candidatePath: unknown,
            expectedFileName: string,
            expectedSha256: unknown
        ): ReviewAttemptTextSnapshot {
            const result = readSnapshot(candidatePath, expectedFileName, expectedSha256);
            if (!result.valid || !result.expectedPath || !result.sha256) {
                return { content: null, valid: false, sha256: result.sha256 };
            }
            const sharedSnapshot = readReviewArtifactTextSnapshot(result.expectedPath);
            if (sharedSnapshot.active) {
                const valid = sharedSnapshot.valid
                    && sharedSnapshot.value !== null
                    && sharedSnapshot.sha256 === result.sha256;
                return {
                    content: valid ? sharedSnapshot.value : null,
                    valid,
                    sha256: valid ? result.sha256 : null
                };
            }
            try {
                const content = fs.readFileSync(result.expectedPath);
                const actualSha256 = createHash('sha256').update(content).digest('hex');
                const valid = actualSha256 === result.sha256;
                return {
                    content: valid ? content.toString('utf8') : null,
                    valid,
                    sha256: valid ? actualSha256 : null
                };
            } catch {
                return { content: null, valid: false, sha256: null };
            }
        },
        readJsonSnapshot(
            candidatePath: unknown,
            expectedFileName: string,
            expectedSha256: unknown
        ): ReviewAttemptJsonSnapshot {
            const result = readSnapshot(candidatePath, expectedFileName, expectedSha256);
            if (!result.valid || !result.expectedPath || !result.sha256) {
                return { record: null, valid: false, sha256: result.sha256 };
            }
            const sharedSnapshot = readReviewArtifactJsonSnapshot(result.expectedPath);
            if (sharedSnapshot.active) {
                const record = sharedSnapshot.valid
                    && sharedSnapshot.sha256 === result.sha256
                    && isPlainRecord(sharedSnapshot.value)
                    ? sharedSnapshot.value
                    : null;
                return {
                    record,
                    valid: record !== null,
                    sha256: record === null ? null : result.sha256
                };
            }
            try {
                const content = fs.readFileSync(result.expectedPath);
                const actualSha256 = createHash('sha256').update(content).digest('hex');
                const parsed = actualSha256 === result.sha256
                    ? JSON.parse(content.toString('utf8')) as unknown
                    : null;
                const record = isPlainRecord(parsed) ? freezeRecord(parsed) : null;
                return {
                    record,
                    valid: record !== null,
                    sha256: record === null ? null : actualSha256
                };
            } catch {
                return { record: null, valid: false, sha256: null };
            }
        }
    });
}
