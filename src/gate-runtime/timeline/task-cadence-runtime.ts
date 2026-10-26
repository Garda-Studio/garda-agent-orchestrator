import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readInvocationPathObservation, observedInvocationValue } from '../../core/invocation-file-observation';
import { bindContainedDestination, assertContainedDestination, writeContainedFile } from '../../core/contained-filesystem';
import { readTransactionBytes } from '../../core/file-transaction-journal';
import { countNextStepWork } from '../../core/next-step-measurement';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { readClosedReviewBytes, resolveClosedReviewAuthentication, type ClosedReviewAuthentication } from '../../gates/review-attempts/review-closed-cycle-auth';
import { advanceCadenceHead, bootstrapCadenceHead, readCoveredReviewCadenceFailure, verifyCadenceHead } from '../../gates/review-attempts/review-cadence-admission';
import { ReviewCadenceWindowAccumulator } from '../../gates/review-attempts/review-cadence-window';
import { captureTaskTimelineReadSnapshotByteLength, readTaskTimelineFileMetadataSnapshot,
    assertTaskTimelineAppendPrecondition } from './task-timeline-read-snapshot';

export const CADENCE_WINDOW_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxLines: 8192, maxEvents: 4096, maxParseAttempts: 8192 });
const HEAD_LIMIT = 16 * 1024;
const EMPTY_SHA = createHash('sha256').digest('hex');
const digest = (bytes: Buffer | null): string | null => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');

export function taskCadenceHeadPath(timelinePath: string, taskId: string): string {
    return path.join(path.dirname(path.resolve(timelinePath)), assertCanonicalTaskId(taskId) + '.cadence-head.json');
}

function enclosingAuthentication(timelinePath: string): ClosedReviewAuthentication | null {
    let current = path.dirname(path.resolve(timelinePath));
    while (true) {
        const git = path.join(current, '.git');
        try {
            const observed = readInvocationPathObservation(git);
            if (observed) observedInvocationValue(observed.stat); else fs.lstatSync(git);
            // An existing invalid closest .git/key must not select another ancestor's authority.
            try { return resolveClosedReviewAuthentication(current, false); }
            catch { return null; }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
        }
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

export function beginCadenceVerifiedPass(timelinePath: string, taskId: string): ReviewCadenceWindowAccumulator | null {
    try {
        const headPath = taskCadenceHeadPath(timelinePath, taskId);
        const bytes = readClosedReviewBytes(path.dirname(headPath), headPath, HEAD_LIMIT);
        if (!bytes) return null;
        const auth = enclosingAuthentication(timelinePath);
        const metadata = readTaskTimelineFileMetadataSnapshot(timelinePath);
        if (!auth || !metadata.valid || !metadata.exists || !metadata.sha256) return null;
        const head = verifyCadenceHead(auth, taskId, metadata.sha256,
            captureTaskTimelineReadSnapshotByteLength(timelinePath), bytes);
        return new ReviewCadenceWindowAccumulator(CADENCE_WINDOW_LIMITS,
            event => readCoveredReviewCadenceFailure(head, event));
    } catch { return null; }
}

export interface CadenceAppendPublication {
    readonly auth: ClosedReviewAuthentication;
    readonly timelinePath: string;
    readonly taskId: string;
    readonly headPath: string;
    readonly previousFile: Buffer | null;
    readonly previousCertificate: Buffer;
    readonly beforeSha256: string;
    readonly beforeBytes: number;
    readonly appendedEvent: Readonly<Record<string, unknown>>;
}

/** Runs only inside the native task append lock; absent auth preserves the legacy append path. */
export function prepareCadenceAppend(timelinePath: string, taskId: string,
    appendedEvent: Readonly<Record<string, unknown>>): CadenceAppendPublication | null {
    try {
        const auth = enclosingAuthentication(timelinePath);
        if (!auth) return null;
        const headPath = taskCadenceHeadPath(timelinePath, taskId);
        const previousFile = readClosedReviewBytes(path.dirname(headPath), headPath, HEAD_LIMIT);
        const metadata = readTaskTimelineFileMetadataSnapshot(timelinePath);
        if (!metadata.valid) return null;
        const beforeSha256 = metadata.sha256 || EMPTY_SHA;
        const beforeBytes = captureTaskTimelineReadSnapshotByteLength(timelinePath);
        let previousCertificate = previousFile;
        try {
            if (!previousCertificate) throw new Error('No cadence head.');
            verifyCadenceHead(auth, taskId, beforeSha256, beforeBytes, previousCertificate);
        } catch {
            previousCertificate = bootstrapCadenceHead(auth, taskId, timelinePath);
        }
        return { auth, timelinePath, taskId, headPath, previousFile, previousCertificate,
            beforeSha256, beforeBytes, appendedEvent };
    } catch { return null; } // Invalid present proofs never become a new signed head.
}

/** Head publication is derived-index work AFTER the canonical append; rollback never truncates the timeline. */
export function commitCadenceAppend(publication: CadenceAppendPublication | null): void {
    if (!publication) return;
    const metadata = readTaskTimelineFileMetadataSnapshot(publication.timelinePath);
    if (!metadata.valid || !metadata.exists || !metadata.sha256) throw new Error('Cadence append snapshot is unavailable.');
    const next = advanceCadenceHead(publication.auth, publication.taskId, publication.previousCertificate, {
        beforeSha256: publication.beforeSha256, beforeBytes: publication.beforeBytes,
        afterSha256: metadata.sha256, afterBytes: captureTaskTimelineReadSnapshotByteLength(publication.timelinePath),
        appendedEvent: publication.appendedEvent
    });
    assertTaskTimelineAppendPrecondition(publication.timelinePath);
    const root = path.dirname(publication.headPath);
    try {
        writeContainedFile(root, publication.headPath, next);
        countNextStepWork('cadence_head_published');
    } catch (error) {
        try {
            const current = readTransactionBytes(root, publication.headPath, HEAD_LIMIT);
            if (digest(current) === digest(next)) {
                if (publication.previousFile !== null) writeContainedFile(root, publication.headPath, publication.previousFile);
                else {
                    const binding = bindContainedDestination(root, publication.headPath);
                    assertContainedDestination(binding);
                    fs.unlinkSync(publication.headPath);
                }
            } else if (digest(current) !== digest(publication.previousFile)) {
                throw new Error('Cadence head changed during publication rollback.');
            }
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Cadence head publication and rollback failed.');
        }
        throw error;
    }
}
