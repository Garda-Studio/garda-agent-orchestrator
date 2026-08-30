import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPlainRecord } from '../../core/records';
import { assertCanonicalTaskId } from '../../core/task-ids';
import {
    readReviewArtifactFileSnapshot,
    readReviewArtifactJsonSnapshot
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
    content: string | null;
    parsedRecord: Record<string, unknown> | null | undefined;
    valid: boolean;
    sha256: string | null;
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
    ): CachedSnapshotRead => {
        const normalizedExpectedSha256 = normalizeSha256(expectedSha256);
        const normalizedCandidate = String(candidatePath || '').trim();
        if (
            !normalizedExpectedSha256
            || !normalizedCandidate
            || path.basename(expectedFileName) !== expectedFileName
        ) {
            return { content: null, parsedRecord: null, valid: false, sha256: null };
        }
        const expectedPath = path.resolve(resolvedReviewsRoot, expectedFileName);
        const candidateResolvedPath = path.isAbsolute(normalizedCandidate)
            ? path.resolve(normalizedCandidate)
            : path.resolve(resolvedReviewsRoot, normalizedCandidate);
        if (candidateResolvedPath !== expectedPath) {
            return { content: null, parsedRecord: null, valid: false, sha256: null };
        }
        const cacheKey = `${expectedFileName}|${normalizedExpectedSha256}`;
        const cached = cachedReads.get(cacheKey);
        if (cached) {
            if (cached.valid) {
                const sharedSnapshot = readReviewArtifactFileSnapshot(expectedPath);
                if (
                    sharedSnapshot.active
                    && (
                        !sharedSnapshot.valid
                        || !sharedSnapshot.content
                        || sharedSnapshot.sha256 !== cached.sha256
                    )
                ) {
                    const divergent = { content: null, parsedRecord: null, valid: false, sha256: null };
                    cachedReads.set(cacheKey, divergent);
                    return divergent;
                }
            }
            return cached;
        }
        const indexEntry = entriesByFileName.get(expectedFileName);
        if (!indexEntry || duplicateFileNames.has(expectedFileName)) {
            const missing = { content: null, parsedRecord: null, valid: false, sha256: null };
            cachedReads.set(cacheKey, missing);
            return missing;
        }
        try {
            const beforeRead = fs.lstatSync(expectedPath);
            if (!indexEntryMatchesFile(indexEntry, beforeRead)) {
                const divergent = { content: null, parsedRecord: null, valid: false, sha256: null };
                cachedReads.set(cacheKey, divergent);
                return divergent;
            }
            const sharedSnapshot = readReviewArtifactFileSnapshot(expectedPath);
            const contentBuffer = sharedSnapshot.active
                ? sharedSnapshot.content
                : fs.readFileSync(expectedPath);
            if (!contentBuffer || (sharedSnapshot.active && !sharedSnapshot.valid)) {
                const unreadable = { content: null, parsedRecord: null, valid: false, sha256: null };
                cachedReads.set(cacheKey, unreadable);
                return unreadable;
            }
            const afterRead = fs.lstatSync(expectedPath);
            const actualSha256 = createHash('sha256').update(contentBuffer).digest('hex');
            const valid = sameFileIdentity(beforeRead, afterRead)
                && actualSha256 === normalizedExpectedSha256;
            const result: CachedSnapshotRead = {
                content: valid ? contentBuffer.toString('utf8') : null,
                parsedRecord: valid ? undefined : null,
                valid,
                sha256: actualSha256
            };
            cachedReads.set(cacheKey, result);
            return result;
        } catch {
            const unreadable = { content: null, parsedRecord: null, valid: false, sha256: null };
            cachedReads.set(cacheKey, unreadable);
            return unreadable;
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
            return {
                content: result.content,
                valid: result.valid,
                sha256: result.sha256
            };
        },
        readJsonSnapshot(
            candidatePath: unknown,
            expectedFileName: string,
            expectedSha256: unknown
        ): ReviewAttemptJsonSnapshot {
            const result = readSnapshot(candidatePath, expectedFileName, expectedSha256);
            if (!result.valid || result.content === null) {
                return { record: null, valid: false, sha256: result.sha256 };
            }
            if (result.parsedRecord === undefined) {
                const sharedJsonSnapshot = readReviewArtifactJsonSnapshot(
                    path.resolve(resolvedReviewsRoot, expectedFileName)
                );
                if (sharedJsonSnapshot.active) {
                    result.parsedRecord = sharedJsonSnapshot.valid && isPlainRecord(sharedJsonSnapshot.value)
                        ? sharedJsonSnapshot.value
                        : null;
                } else {
                    try {
                        const parsed = JSON.parse(result.content) as unknown;
                        result.parsedRecord = isPlainRecord(parsed) ? freezeRecord(parsed) : null;
                    } catch {
                        result.parsedRecord = null;
                    }
                }
            }
            return {
                record: result.parsedRecord,
                valid: result.parsedRecord !== null,
                sha256: result.sha256
            };
        }
    });
}
