import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { lstatFileIdentitySync } from '../../core/file-stat';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { isCanonicalTaskId, parseTaskIdJsonlFileName } from '../../core/task-ids';
import { parseCanonicalActiveTaskQueue } from '../../core/task-md-table';
import { inspectTaskEventFile } from '../../gate-runtime/task-events-integrity';
import {
    readRuntimeMutationGeneration,
    RuntimeMutationGenerationError,
    type RuntimeMutationGenerationSnapshot
} from '../../gate-runtime/runtime-mutation-generation';
import type {
    CatalogArtifact,
    CatalogCanonicalSource,
    CatalogLifecycleEvent,
    CatalogMetricSample,
    CatalogRetentionState,
    CatalogReviewAttempt,
    CatalogReviewReceipt,
    CatalogRowProvenance,
    CatalogTaskLedger,
    CatalogTaskRow,
    DerivedCatalogProjection
} from './sqlite-catalog-contracts';
import { validateCatalogProjection } from './sqlite-catalog-validation';

const MAX_REVIEW_ARTIFACT_CANDIDATES = 4096;
const MAX_REVIEW_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_ARTIFACT_TOTAL_BYTES = 128 * 1024 * 1024;

interface CanonicalSourceSnapshot {
    readonly kind: string;
    readonly path: string;
    readonly fullPath: string;
    readonly content: Buffer;
    readonly contentSha256: string;
    readonly observedAtUtc: string;
}

interface ContainedFileSnapshot {
    readonly relativePath: string;
    readonly content: Buffer;
    readonly stat: fs.Stats;
}

interface JsonlRecord {
    readonly text: string;
    readonly lineNumber: number;
    readonly offset: number;
}

interface ArtifactCandidate {
    readonly taskId: string;
    readonly reviewAttemptId: string | null;
    readonly kind: string;
    readonly fullPath: string;
    readonly expectedContentSha256: string;
    readonly provenance: CatalogRowProvenance;
}

type MutableReviewAttempt = {
    -readonly [Key in keyof CatalogReviewAttempt]: CatalogReviewAttempt[Key];
};

export type CanonicalCatalogSourceFingerprint = CatalogCanonicalSource;

export interface CanonicalCatalogBuildOptions {
    readonly clock?: () => string;
}

export interface CanonicalCatalogBuildResult {
    readonly projection: DerivedCatalogProjection;
    readonly sourcePaths: readonly string[];
    readonly sourceFingerprints: readonly CanonicalCatalogSourceFingerprint[];
    readonly diagnostics: readonly string[];
}

export class CanonicalCatalogInputError extends Error {
    readonly sourcePath: string;

    constructor(sourcePath: string, message: string) {
        super(`${sourcePath}: ${message}`);
        this.name = 'CanonicalCatalogInputError';
        this.sourcePath = sourcePath;
    }
}

function sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function nonEmptyText(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function shaOrNull(value: unknown): string | null {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function utcOrNull(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
        return null;
    }
    return value;
}

function nonNegativeInteger(value: unknown): number {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function portableRelativePath(repoRoot: string, fullPath: string): string {
    const relative = path.relative(path.resolve(repoRoot), path.resolve(fullPath)).replace(/\\/gu, '/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        throw new Error(`Catalog source must stay inside the workspace: ${fullPath}`);
    }
    return relative;
}

function assertResolvedPathInsideWorkspace(
    workspaceRealPath: string,
    resolvedPath: string,
    sourcePath: string
): void {
    const relative = path.relative(workspaceRealPath, resolvedPath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new CanonicalCatalogInputError(sourcePath, 'resolved canonical source escapes the workspace.');
    }
}

function assertRealParentDirectories(repoRoot: string, fullPath: string, sourcePath: string): void {
    const relative = portableRelativePath(repoRoot, fullPath);
    const components = relative.split('/');
    let currentPath = path.resolve(repoRoot);
    for (const component of components.slice(0, -1)) {
        currentPath = path.join(currentPath, component);
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(currentPath);
        } catch {
            throw new CanonicalCatalogInputError(sourcePath, 'canonical source parent directory is missing.');
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new CanonicalCatalogInputError(
                sourcePath,
                'canonical source parent components must be real non-symlink directories.'
            );
        }
    }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.birthtimeMs === right.birthtimeMs;
}

function sameFileContentMetadata(left: fs.Stats, right: fs.Stats): boolean {
    return sameFileIdentity(left, right)
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}

function readContainedRegularFile(
    repoRoot: string,
    workspaceRealPath: string,
    fullPath: string,
    maxBytes: number | null = null
): ContainedFileSnapshot {
    const sourcePath = portableRelativePath(repoRoot, fullPath);
    assertRealParentDirectories(repoRoot, fullPath, sourcePath);
    let initialStat: fs.Stats;
    let initialRealPath: string;
    try {
        initialStat = lstatFileIdentitySync(fullPath);
        initialRealPath = fs.realpathSync.native(fullPath);
    } catch {
        throw new CanonicalCatalogInputError(sourcePath, 'canonical source is missing.');
    }
    if (initialStat.isSymbolicLink() || !initialStat.isFile()) {
        throw new CanonicalCatalogInputError(sourcePath, 'canonical source must be a regular non-symlink file.');
    }
    if (maxBytes !== null && initialStat.size > maxBytes) {
        throw new CanonicalCatalogInputError(
            sourcePath,
            `canonical source exceeds the bounded artifact read limit of ${maxBytes} bytes.`
        );
    }
    assertResolvedPathInsideWorkspace(workspaceRealPath, initialRealPath, sourcePath);

    const noFollowFlag = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(fullPath, fs.constants.O_RDONLY | noFollowFlag);
        const openedStat = fs.fstatSync(descriptor);
        const openedRealPath = fs.realpathSync.native(fullPath);
        assertResolvedPathInsideWorkspace(workspaceRealPath, openedRealPath, sourcePath);
        if (
            openedRealPath !== initialRealPath
            || !openedStat.isFile()
            || !sameFileContentMetadata(initialStat, openedStat)
        ) {
            throw new CanonicalCatalogInputError(sourcePath, 'canonical source changed while it was being opened.');
        }
        if (maxBytes !== null && openedStat.size > maxBytes) {
            throw new CanonicalCatalogInputError(
                sourcePath,
                `canonical source exceeds the bounded artifact read limit of ${maxBytes} bytes.`
            );
        }
        const content = fs.readFileSync(descriptor);
        const finalStat = fs.fstatSync(descriptor);
        const finalPathStat = lstatFileIdentitySync(fullPath);
        const finalRealPath = fs.realpathSync.native(fullPath);
        assertResolvedPathInsideWorkspace(workspaceRealPath, finalRealPath, sourcePath);
        if (
            finalRealPath !== openedRealPath
            || !sameFileContentMetadata(openedStat, finalStat)
            || !sameFileContentMetadata(finalStat, finalPathStat)
            || finalStat.size !== content.byteLength
        ) {
            throw new CanonicalCatalogInputError(sourcePath, 'canonical source changed while it was being read.');
        }
        return { relativePath: sourcePath, content, stat: finalStat };
    } catch (error: unknown) {
        if (error instanceof CanonicalCatalogInputError) throw error;
        throw new CanonicalCatalogInputError(
            sourcePath,
            `canonical source cannot be read safely: ${error instanceof Error ? error.message : String(error)}`
        );
    } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
    }
}

function readSource(
    repoRoot: string,
    workspaceRealPath: string,
    fullPath: string,
    kind: string,
    observedAtUtc: string
): CanonicalSourceSnapshot {
    const snapshot = readContainedRegularFile(repoRoot, workspaceRealPath, fullPath);
    return {
        kind,
        path: snapshot.relativePath,
        fullPath,
        content: snapshot.content,
        contentSha256: sha256(snapshot.content),
        observedAtUtc
    };
}

function provenance(
    source: CanonicalSourceSnapshot,
    recordContentSha256: string,
    options: {
        sequence?: number | null;
        offset?: number | null;
        timestampUtc?: string | null;
    } = {}
): CatalogRowProvenance {
    return {
        sourceKind: source.kind,
        sourcePath: source.path,
        sourceContentSha256: source.contentSha256,
        sourceObservedAtUtc: source.observedAtUtc,
        sourceSequence: options.sequence ?? null,
        sourceOffset: options.offset ?? null,
        sourceTimestampUtc: options.timestampUtc ?? null,
        recordContentSha256
    };
}

function readJsonlRecords(source: CanonicalSourceSnapshot): JsonlRecord[] {
    const records: JsonlRecord[] = [];
    let start = 0;
    let lineNumber = 0;
    for (let cursor = 0; cursor <= source.content.length; cursor += 1) {
        if (cursor < source.content.length && source.content[cursor] !== 0x0a) continue;
        lineNumber += 1;
        let end = cursor;
        if (end > start && source.content[end - 1] === 0x0d) end -= 1;
        const text = source.content.subarray(start, end).toString('utf8');
        if (text.trim()) records.push({ text, lineNumber, offset: start });
        start = cursor + 1;
    }
    return records;
}

function parseJsonRecord(source: CanonicalSourceSnapshot, record: JsonlRecord): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(record.text);
        if (!isRecord(parsed)) throw new Error('expected a JSON object');
        return parsed;
    } catch (error: unknown) {
        throw new CanonicalCatalogInputError(
            source.path,
            `invalid JSON at line ${record.lineNumber}: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function parseTaskRows(source: CanonicalSourceSnapshot): CatalogTaskRow[] {
    const parsed = parseCanonicalActiveTaskQueue(source.content.toString('utf8'));
    if (!parsed.found) {
        throw new CanonicalCatalogInputError(source.path, parsed.unavailableReason || 'canonical task queue is unavailable.');
    }
    return parsed.rows.map((row, queuePosition) => ({
        taskId: row.taskId,
        status: row.status || null,
        priority: row.priority || null,
        area: row.area || null,
        title: row.title || null,
        owner: row.owner || null,
        updatedText: row.updated || null,
        profile: row.profile || null,
        notes: row.notes || null,
        queuePosition,
        provenance: provenance(source, sha256(row.rawLine), {
            sequence: queuePosition,
            offset: row.lineIndex
        })
    }));
}

function eventDetails(event: Record<string, unknown>): Record<string, unknown> {
    return isRecord(event.details) ? event.details : {};
}

function storeArtifactCandidate(
    candidates: Map<string, ArtifactCandidate>,
    artifactPath: string,
    candidate: ArtifactCandidate
): void {
    const existing = candidates.get(artifactPath);
    if (existing) {
        const exactDuplicate = existing.taskId === candidate.taskId
            && existing.reviewAttemptId === candidate.reviewAttemptId
            && existing.kind === candidate.kind
            && existing.fullPath === candidate.fullPath
            && existing.expectedContentSha256 === candidate.expectedContentSha256;
        if (exactDuplicate) return;
        throw new CanonicalCatalogInputError(
            candidate.provenance.sourcePath,
            `artifact '${artifactPath}' has conflicting canonical ownership or integrity declarations.`
        );
    }
    if (candidates.size >= MAX_REVIEW_ARTIFACT_CANDIDATES) {
        throw new CanonicalCatalogInputError(
            candidate.provenance.sourcePath,
            `review artifact candidate count exceeds the limit of ${MAX_REVIEW_ARTIFACT_CANDIDATES}.`
        );
    }
    candidates.set(artifactPath, candidate);
}

function eventProvenance(
    source: CanonicalSourceSnapshot,
    record: JsonlRecord,
    event: Record<string, unknown>
): CatalogRowProvenance {
    const integrity = isRecord(event.integrity) ? event.integrity : {};
    const sequence = Number(integrity.task_sequence);
    return provenance(source, sha256(record.text), {
        sequence: Number.isSafeInteger(sequence) && sequence > 0 ? sequence : record.lineNumber,
        offset: record.offset,
        timestampUtc: utcOrNull(event.timestamp_utc)
    });
}

function lifecycleRow(
    taskId: string,
    source: CanonicalSourceSnapshot,
    record: JsonlRecord,
    event: Record<string, unknown>
): CatalogLifecycleEvent {
    const integrity = isRecord(event.integrity) ? event.integrity : {};
    const publicMetadata = isRecord(event.public_metadata) ? event.public_metadata : {};
    const recordHash = sha256(record.text);
    const sequence = Number(integrity.task_sequence);
    const taskSequence = Number.isSafeInteger(sequence) && sequence > 0 ? sequence : record.lineNumber;
    return {
        taskId,
        taskSequence,
        eventType: nonEmptyText(event.event_type, 'UNKNOWN'),
        outcome: nonEmptyText(event.outcome, 'UNKNOWN'),
        actor: nonEmptyText(event.actor, 'unknown'),
        message: nonEmptyText(event.message, '(no message)'),
        lifecyclePhase: textOrNull(publicMetadata.lifecycle_phase),
        statusSignal: textOrNull(publicMetadata.status_signal),
        healthState: textOrNull(publicMetadata.health_state),
        terminalOutcome: textOrNull(publicMetadata.terminal_outcome),
        previousEventSha256: shaOrNull(integrity.prev_event_sha256),
        eventSha256: shaOrNull(integrity.event_sha256) || recordHash,
        provenance: eventProvenance(source, record, event)
    };
}

function createReviewAttempt(
    taskId: string,
    reviewType: string,
    attemptId: string,
    attemptNumber: number,
    source: CanonicalSourceSnapshot,
    record: JsonlRecord,
    event: Record<string, unknown>
): MutableReviewAttempt {
    const details = eventDetails(event);
    return {
        attemptId,
        taskId,
        reviewType,
        attemptNumber,
        status: 'prepared',
        verdict: null,
        reviewerIdentity: textOrNull(details.reviewer_identity),
        executionMode: textOrNull(details.reviewer_execution_mode),
        startedAtUtc: utcOrNull(details.launch_prepared_at_utc) || utcOrNull(event.timestamp_utc),
        completedAtUtc: null,
        reviewContextSha256: shaOrNull(details.review_context_sha256),
        reviewTreeStateSha256: shaOrNull(details.review_tree_state_sha256),
        reviewScopeSha256: shaOrNull(details.review_scope_sha256),
        codeScopeSha256: shaOrNull(details.code_scope_sha256),
        provenance: eventProvenance(source, record, event)
    };
}

function updateReviewAttempt(
    attempt: MutableReviewAttempt,
    source: CanonicalSourceSnapshot,
    record: JsonlRecord,
    event: Record<string, unknown>
): void {
    const details = eventDetails(event);
    const eventType = nonEmptyText(event.event_type, 'UNKNOWN');
    attempt.reviewerIdentity = textOrNull(details.reviewer_identity) || attempt.reviewerIdentity;
    attempt.executionMode = textOrNull(details.reviewer_execution_mode) || attempt.executionMode;
    attempt.reviewContextSha256 = shaOrNull(details.review_context_sha256) || attempt.reviewContextSha256;
    attempt.reviewTreeStateSha256 = shaOrNull(details.review_tree_state_sha256) || attempt.reviewTreeStateSha256;
    attempt.reviewScopeSha256 = shaOrNull(details.review_scope_sha256) || attempt.reviewScopeSha256;
    attempt.codeScopeSha256 = shaOrNull(details.code_scope_sha256) || attempt.codeScopeSha256;
    if (eventType === 'REVIEWER_DELEGATION_STARTED') {
        attempt.status = 'running';
        attempt.startedAtUtc = utcOrNull(details.delegation_started_at_utc)
            || utcOrNull(event.timestamp_utc)
            || attempt.startedAtUtc;
    } else if (eventType === 'REVIEWER_LAUNCH_COMPLETED' || eventType === 'REVIEWER_INVOCATION_ATTESTED') {
        attempt.status = 'launched';
    } else if (eventType === 'REVIEW_RECORDED') {
        attempt.status = 'completed';
        attempt.verdict = nonEmptyText(event.outcome, 'UNKNOWN');
        attempt.completedAtUtc = utcOrNull(details.recorded_at_utc) || utcOrNull(event.timestamp_utc);
    }
    attempt.provenance = eventProvenance(source, record, event);
}

function addArtifactCandidates(
    candidates: Map<string, ArtifactCandidate>,
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    attemptId: string | null,
    source: CanonicalSourceSnapshot,
    record: JsonlRecord,
    event: Record<string, unknown>
): void {
    const details = eventDetails(event);
    for (const [key, value] of Object.entries(details)) {
        if (!key.endsWith('_path') || typeof value !== 'string' || !value.trim()) continue;
        const kind = key.slice(0, -'_path'.length);
        const expectedContentSha256 = shaOrNull(details[`${kind}_sha256`]);
        if (!expectedContentSha256) continue;
        const fullPath = path.isAbsolute(value) ? path.resolve(value) : path.resolve(repoRoot, value);
        const relativeToReviews = path.relative(reviewsRoot, fullPath);
        if (
            relativeToReviews === '..'
            || relativeToReviews.startsWith(`..${path.sep}`)
            || path.isAbsolute(relativeToReviews)
        ) {
            continue;
        }
        try {
            const stat = fs.lstatSync(fullPath);
            if (stat.isSymbolicLink() || !stat.isFile()) continue;
        } catch {
            continue;
        }
        const artifactPath = portableRelativePath(repoRoot, fullPath);
        storeArtifactCandidate(candidates, artifactPath, {
            taskId,
            reviewAttemptId: attemptId,
            kind,
            fullPath,
            expectedContentSha256,
            provenance: eventProvenance(source, record, event)
        });
    }
}

function parseTaskEvents(
    repoRoot: string,
    reviewsRoot: string,
    source: CanonicalSourceSnapshot,
    taskId: string
): {
    lifecycleEvents: CatalogLifecycleEvent[];
    reviewAttempts: CatalogReviewAttempt[];
    reviewReceipts: CatalogReviewReceipt[];
    artifactCandidates: Map<string, ArtifactCandidate>;
} {
    const integrity = inspectTaskEventFile(source.fullPath, taskId);
    if (integrity.status !== 'PASS' && integrity.status !== 'EMPTY') {
        throw new CanonicalCatalogInputError(
            source.path,
            integrity.violations[0] || `task timeline integrity status is ${integrity.status}.`
        );
    }

    const lifecycleEvents: CatalogLifecycleEvent[] = [];
    const attempts = new Map<string, MutableReviewAttempt>();
    const latestAttemptByType = new Map<string, MutableReviewAttempt>();
    const attemptCounts = new Map<string, number>();
    const reviewReceipts: CatalogReviewReceipt[] = [];
    const artifactCandidates = new Map<string, ArtifactCandidate>();

    for (const record of readJsonlRecords(source)) {
        const event = parseJsonRecord(source, record);
        if (event.task_id !== taskId) {
            throw new CanonicalCatalogInputError(
                source.path,
                `foreign task_id '${String(event.task_id || '')}' at line ${record.lineNumber}.`
            );
        }
        lifecycleEvents.push(lifecycleRow(taskId, source, record, event));
        const eventType = nonEmptyText(event.event_type, 'UNKNOWN');
        const details = eventDetails(event);
        const reviewType = nonEmptyText(details.review_type, '');
        let attempt: MutableReviewAttempt | undefined;
        if (reviewType) {
            const declaredAttemptId = nonEmptyText(details.reviewer_launch_attempt_id, '');
            if (eventType === 'REVIEWER_LAUNCH_PREPARED') {
                const attemptNumber = (attemptCounts.get(reviewType) || 0) + 1;
                const attemptId = declaredAttemptId || `${taskId}:${reviewType}:${attemptNumber}`;
                attempt = attempts.get(attemptId);
                if (!attempt) {
                    attempt = createReviewAttempt(
                        taskId,
                        reviewType,
                        attemptId,
                        attemptNumber,
                        source,
                        record,
                        event
                    );
                    attempts.set(attemptId, attempt);
                    attemptCounts.set(reviewType, attemptNumber);
                }
                latestAttemptByType.set(reviewType, attempt);
            } else {
                attempt = declaredAttemptId ? attempts.get(declaredAttemptId) : latestAttemptByType.get(reviewType);
                if (!attempt && eventType === 'REVIEW_RECORDED') {
                    const attemptNumber = (attemptCounts.get(reviewType) || 0) + 1;
                    const attemptId = declaredAttemptId || `${taskId}:${reviewType}:${attemptNumber}`;
                    attempt = createReviewAttempt(
                        taskId,
                        reviewType,
                        attemptId,
                        attemptNumber,
                        source,
                        record,
                        event
                    );
                    attempts.set(attemptId, attempt);
                    attemptCounts.set(reviewType, attemptNumber);
                    latestAttemptByType.set(reviewType, attempt);
                }
            }
            if (attempt) updateReviewAttempt(attempt, source, record, event);
        }

        if (eventType === 'REVIEW_RECORDED' && reviewType) {
            const receiptId = shaOrNull(details.receipt_sha256)
                || shaOrNull(isRecord(event.integrity) ? event.integrity.event_sha256 : null)
                || sha256(`${source.path}\0${record.offset}`);
            const recordedAtUtc = utcOrNull(details.recorded_at_utc) || utcOrNull(event.timestamp_utc);
            if (!recordedAtUtc) {
                throw new CanonicalCatalogInputError(
                    source.path,
                    `review receipt at line ${record.lineNumber} has no valid timestamp.`
                );
            }
            reviewReceipts.push({
                receiptId,
                attemptId: attempt?.attemptId || null,
                taskId,
                reviewType,
                verdict: nonEmptyText(event.outcome, 'UNKNOWN'),
                trustLevel: textOrNull(details.trust_level),
                reviewerIdentity: textOrNull(details.reviewer_identity),
                reviewerExecutionMode: textOrNull(details.reviewer_execution_mode),
                reusedExistingReview: details.reused_existing_review === true,
                recordedAtUtc,
                preflightSha256: shaOrNull(details.preflight_sha256),
                scopeSha256: shaOrNull(details.scope_sha256),
                reviewContextSha256: shaOrNull(details.review_context_sha256),
                reviewTreeStateSha256: shaOrNull(details.review_tree_state_sha256),
                reviewArtifactSha256: shaOrNull(details.review_artifact_sha256),
                provenance: eventProvenance(source, record, event)
            });
        }
        addArtifactCandidates(
            artifactCandidates,
            repoRoot,
            reviewsRoot,
            taskId,
            attempt?.attemptId || null,
            source,
            record,
            event
        );
    }
    return {
        lifecycleEvents,
        reviewAttempts: [...attempts.values()],
        reviewReceipts,
        artifactCandidates
    };
}

function materializeArtifacts(
    repoRoot: string,
    workspaceRealPath: string,
    candidates: Map<string, ArtifactCandidate>
): CatalogArtifact[] {
    let remainingBytes = MAX_REVIEW_ARTIFACT_TOTAL_BYTES;
    return [...candidates.entries()].map(([artifactPath, candidate]) => {
        const snapshot = readContainedRegularFile(
            repoRoot,
            workspaceRealPath,
            candidate.fullPath,
            Math.min(MAX_REVIEW_ARTIFACT_BYTES, remainingBytes)
        );
        remainingBytes -= snapshot.stat.size;
        const contentSha256 = sha256(snapshot.content);
        if (contentSha256 !== candidate.expectedContentSha256) {
            throw new CanonicalCatalogInputError(
                candidate.provenance.sourcePath,
                `artifact '${snapshot.relativePath}' does not match event-declared SHA-256.`
            );
        }
        return {
            artifactId: sha256(`${artifactPath}\0${contentSha256}`),
            taskId: candidate.taskId,
            reviewAttemptId: candidate.reviewAttemptId,
            kind: candidate.kind,
            path: snapshot.relativePath,
            contentSha256,
            sizeBytes: snapshot.stat.size,
            modifiedAtUtc: snapshot.stat.mtime.toISOString(),
            provenance: {
                sourceKind: 'review_artifact',
                sourcePath: snapshot.relativePath,
                sourceContentSha256: contentSha256,
                sourceObservedAtUtc: candidate.provenance.sourceObservedAtUtc,
                sourceSequence: null,
                sourceOffset: null,
                sourceTimestampUtc: null,
                recordContentSha256: contentSha256
            }
        };
    });
}

function parseLedger(source: CanonicalSourceSnapshot, expectedTaskId: string): {
    ledger: CatalogTaskLedger;
    retention: CatalogRetentionState;
} {
    let parsed: unknown;
    try {
        parsed = JSON.parse(source.content.toString('utf8'));
    } catch (error: unknown) {
        throw new CanonicalCatalogInputError(
            source.path,
            `invalid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (!isRecord(parsed) || parsed.task_id !== expectedTaskId || parsed.event_source !== 'task-history-ledger') {
        throw new CanonicalCatalogInputError(source.path, 'task ledger identity is invalid.');
    }
    const verification = isRecord(parsed.verification) ? parsed.verification : {};
    const lifecycle = isRecord(parsed.lifecycle) ? parsed.lifecycle : {};
    const timing = isRecord(parsed.timing) ? parsed.timing : {};
    const scope = isRecord(parsed.scope) ? parsed.scope : {};
    const generatedAtUtc = utcOrNull(parsed.generated_utc);
    if (!generatedAtUtc) {
        throw new CanonicalCatalogInputError(source.path, 'generated_utc is invalid.');
    }
    const rowProvenance = provenance(source, sha256(source.content), {
        timestampUtc: generatedAtUtc
    });
    const retentionTier = textOrNull(lifecycle.retention_tier);
    const queueStatus = textOrNull(lifecycle.queue_status);
    return {
        ledger: {
            taskId: expectedTaskId,
            auditStatus: nonEmptyText(parsed.audit_status, 'UNKNOWN'),
            verificationStatus: nonEmptyText(verification.status, 'UNKNOWN'),
            queueStatus,
            healthState: textOrNull(lifecycle.health_state),
            retentionTier,
            integrityStatus: nonEmptyText(lifecycle.integrity_status, 'UNKNOWN'),
            pointInTimeStatus: nonEmptyText(lifecycle.point_in_time_status, 'UNKNOWN'),
            blockerCount: nonNegativeInteger(lifecycle.blocker_count),
            firstEventUtc: utcOrNull(timing.first_event_utc),
            lastEventUtc: utcOrNull(timing.last_event_utc),
            changedFilesCount: nonNegativeInteger(scope.changed_files_count),
            changedLinesTotal: nonNegativeInteger(scope.changed_lines_total),
            generatedAtUtc,
            provenance: rowProvenance
        },
        retention: {
            retentionId: `task:${expectedTaskId}`,
            taskId: expectedTaskId,
            artifactId: null,
            state: queueStatus === 'DONE' ? 'retained' : 'active',
            tier: retentionTier,
            eligibleAtUtc: null,
            reason: 'Projected from canonical task ledger.',
            policySha256: null,
            provenance: rowProvenance
        }
    };
}

function scalarMetricLabels(value: unknown): Readonly<Record<string, string>> {
    if (!isRecord(value)) return {};
    const labels: Record<string, string> = {};
    for (const [key, rawValue] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
        if (!key.trim() || Object.keys(labels).length >= 32) break;
        if (!['string', 'number', 'boolean'].includes(typeof rawValue)) continue;
        const normalized = String(rawValue).trim();
        if (!normalized) continue;
        labels[key] = normalized.slice(0, 512);
    }
    return labels;
}

function parseMetrics(source: CanonicalSourceSnapshot): CatalogMetricSample[] {
    const samples: CatalogMetricSample[] = [];
    for (const record of readJsonlRecords(source)) {
        const parsed = parseJsonRecord(source, record);
        const recordedAtUtc = utcOrNull(parsed.timestamp_utc);
        if (!recordedAtUtc) {
            throw new CanonicalCatalogInputError(
                source.path,
                `metric at line ${record.lineNumber} has no valid timestamp_utc.`
            );
        }
        const name = nonEmptyText(parsed.metric_type, nonEmptyText(parsed.event_type, 'runtime_event'));
        const numericValue = typeof parsed.value === 'number' && Number.isFinite(parsed.value)
            ? parsed.value
            : null;
        const textValue = numericValue === null
            ? nonEmptyText(parsed.status, nonEmptyText(parsed.event_type, 'observed'))
            : null;
        const recordContentSha256 = sha256(record.text);
        const taskId = isCanonicalTaskId(parsed.task_id) ? String(parsed.task_id) : null;
        samples.push({
            metricId: sha256(`${source.path}\0${record.offset}\0${recordContentSha256}`),
            taskId,
            name,
            valueNumeric: numericValue,
            valueText: textValue,
            unit: textOrNull(parsed.unit),
            labels: scalarMetricLabels(parsed.metadata),
            recordedAtUtc,
            provenance: provenance(source, recordContentSha256, {
                sequence: record.lineNumber,
                offset: record.offset,
                timestampUtc: recordedAtUtc
            })
        });
    }
    return samples;
}

function listRegularFiles(
    repoRoot: string,
    workspaceRealPath: string,
    directory: string,
    predicate: (name: string) => boolean
): string[] {
    const sourcePath = portableRelativePath(repoRoot, directory);
    let initialStat: fs.Stats;
    try {
        initialStat = lstatFileIdentitySync(directory);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    if (initialStat.isSymbolicLink() || !initialStat.isDirectory()) {
        throw new CanonicalCatalogInputError(
            sourcePath,
            'canonical source directory must be a real non-symlink directory.'
        );
    }
    assertRealParentDirectories(repoRoot, path.join(directory, '.catalog-probe'), sourcePath);
    const initialRealPath = fs.realpathSync.native(directory);
    assertResolvedPathInsideWorkspace(workspaceRealPath, initialRealPath, sourcePath);
    try {
        const matchingEntries = fs.readdirSync(directory, { withFileTypes: true })
            .filter((entry) => predicate(entry.name));
        for (const entry of matchingEntries) {
            if (entry.isSymbolicLink() || !entry.isFile()) {
                throw new CanonicalCatalogInputError(
                    portableRelativePath(repoRoot, path.join(directory, entry.name)),
                    'canonical source must be a regular non-symlink file.'
                );
            }
        }
        const files = matchingEntries
            .map((entry) => path.join(directory, entry.name))
            .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
        const finalStat = lstatFileIdentitySync(directory);
        const finalRealPath = fs.realpathSync.native(directory);
        assertResolvedPathInsideWorkspace(workspaceRealPath, finalRealPath, sourcePath);
        if (
            finalStat.isSymbolicLink()
            || !finalStat.isDirectory()
            || finalRealPath !== initialRealPath
            || !sameFileIdentity(initialStat, finalStat)
        ) {
            throw new CanonicalCatalogInputError(
                sourcePath,
                'canonical source directory changed while it was being enumerated.'
            );
        }
        return files;
    } catch (error: unknown) {
        if (error instanceof CanonicalCatalogInputError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new CanonicalCatalogInputError(
                sourcePath,
                'canonical source directory changed while it was being enumerated.'
            );
        }
        throw error;
    }
}

function snapshotHash(fingerprints: readonly CanonicalCatalogSourceFingerprint[]): string {
    const normalized = [...fingerprints]
        .sort((left, right) => (
            left.sourcePath.localeCompare(right.sourcePath)
            || left.sourceKind.localeCompare(right.sourceKind)
        ))
        .map((source) => ({
            sourceKind: source.sourceKind,
            sourcePath: source.sourcePath,
            contentSha256: source.contentSha256
        }));
    return sha256(JSON.stringify(normalized));
}

type RuntimeGenerationCheckpoint =
    | { readonly status: 'available'; readonly snapshot: RuntimeMutationGenerationSnapshot }
    | { readonly status: 'missing'; readonly diagnostic: string };

function readRuntimeGenerationCheckpoint(orchestratorRoot: string): RuntimeGenerationCheckpoint {
    try {
        return {
            status: 'available',
            snapshot: readRuntimeMutationGeneration(orchestratorRoot)
        };
    } catch (error: unknown) {
        if (error instanceof RuntimeMutationGenerationError && error.code === 'MISSING') {
            return { status: 'missing', diagnostic: error.message };
        }
        throw new CanonicalCatalogInputError(
            'runtime/.runtime-mutation-generation',
            `cannot establish a stable canonical snapshot: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function assertStableRuntimeGeneration(
    before: RuntimeGenerationCheckpoint,
    after: RuntimeGenerationCheckpoint
): number | null {
    if (before.status !== after.status) {
        throw new CanonicalCatalogInputError(
            'runtime/.runtime-mutation-generation',
            'canonical mutation tracking changed while the catalog snapshot was being built; retry reconciliation.'
        );
    }
    if (before.status === 'missing' || after.status === 'missing') return null;
    if (
        before.snapshot.generation !== after.snapshot.generation
        || before.snapshot.transition_sequence !== after.snapshot.transition_sequence
        || before.snapshot.state_sha256 !== after.snapshot.state_sha256
    ) {
        throw new CanonicalCatalogInputError(
            'runtime/.runtime-mutation-generation',
            'canonical sources changed while the catalog snapshot was being built; retry reconciliation.'
        );
    }
    return after.snapshot.generation;
}

export function buildCanonicalCatalogProjection(
    repoRoot: string,
    options: CanonicalCatalogBuildOptions = {}
): CanonicalCatalogBuildResult {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const workspaceRealPath = fs.realpathSync.native(resolvedRepoRoot);
    const orchestratorRoot = joinOrchestratorPath(resolvedRepoRoot, '');
    const runtimeRoot = path.join(orchestratorRoot, 'runtime');
    const reviewsRoot = path.join(runtimeRoot, 'reviews');
    const generationBeforeScan = readRuntimeGenerationCheckpoint(orchestratorRoot);
    const observedAtUtc = (options.clock || (() => new Date().toISOString()))();
    if (!utcOrNull(observedAtUtc)) throw new Error('Catalog build clock must return a UTC ISO-8601 timestamp.');

    const sources: CanonicalSourceSnapshot[] = [];
    const taskSource = readSource(
        resolvedRepoRoot,
        workspaceRealPath,
        path.join(resolvedRepoRoot, 'TASK.md'),
        'task_queue',
        observedAtUtc
    );
    sources.push(taskSource);
    const tasks = parseTaskRows(taskSource);

    const lifecycleEvents: CatalogLifecycleEvent[] = [];
    const reviewAttempts: CatalogReviewAttempt[] = [];
    const reviewReceipts: CatalogReviewReceipt[] = [];
    const artifactCandidates = new Map<string, ArtifactCandidate>();
    const eventFiles = listRegularFiles(
        resolvedRepoRoot,
        workspaceRealPath,
        path.join(runtimeRoot, 'task-events'),
        (name) => parseTaskIdJsonlFileName(name) !== null
    );
    for (const eventFile of eventFiles) {
        const taskId = parseTaskIdJsonlFileName(path.basename(eventFile));
        if (!taskId) continue;
        const source = readSource(resolvedRepoRoot, workspaceRealPath, eventFile, 'task_events', observedAtUtc);
        sources.push(source);
        const parsed = parseTaskEvents(resolvedRepoRoot, reviewsRoot, source, taskId);
        lifecycleEvents.push(...parsed.lifecycleEvents);
        reviewAttempts.push(...parsed.reviewAttempts);
        reviewReceipts.push(...parsed.reviewReceipts);
        for (const [artifactPath, candidate] of parsed.artifactCandidates) {
            storeArtifactCandidate(artifactCandidates, artifactPath, candidate);
        }
    }

    const taskLedgers: CatalogTaskLedger[] = [];
    const retentionStates: CatalogRetentionState[] = [];
    const ledgerFiles = listRegularFiles(
        resolvedRepoRoot,
        workspaceRealPath,
        path.join(runtimeRoot, 'task-ledger'),
        (name) => name.endsWith('.json')
    );
    for (const ledgerFile of ledgerFiles) {
        const taskId = path.basename(ledgerFile, '.json');
        if (!isCanonicalTaskId(taskId)) continue;
        const source = readSource(resolvedRepoRoot, workspaceRealPath, ledgerFile, 'task_ledger', observedAtUtc);
        sources.push(source);
        const parsed = parseLedger(source, taskId);
        taskLedgers.push(parsed.ledger);
        retentionStates.push(parsed.retention);
    }

    const metricSamples: CatalogMetricSample[] = [];
    const metricsPath = path.join(runtimeRoot, 'metrics.jsonl');
    if (fs.existsSync(metricsPath)) {
        const source = readSource(resolvedRepoRoot, workspaceRealPath, metricsPath, 'metrics', observedAtUtc);
        sources.push(source);
        metricSamples.push(...parseMetrics(source));
    }

    const artifacts = materializeArtifacts(resolvedRepoRoot, workspaceRealPath, artifactCandidates)
        .sort((left, right) => left.path.localeCompare(right.path));
    const sourceFingerprints = [
        ...sources.map((source) => ({
            sourceKind: source.kind,
            sourcePath: source.path,
            contentSha256: source.contentSha256,
            observedAtUtc: source.observedAtUtc
        })),
        ...artifacts.map((artifact) => ({
            sourceKind: artifact.provenance.sourceKind,
            sourcePath: artifact.provenance.sourcePath,
            contentSha256: artifact.provenance.sourceContentSha256,
            observedAtUtc: artifact.provenance.sourceObservedAtUtc
        }))
    ];
    const generationAfterScan = readRuntimeGenerationCheckpoint(orchestratorRoot);
    const canonicalGeneration = assertStableRuntimeGeneration(generationBeforeScan, generationAfterScan);
    const diagnostics = generationBeforeScan.status === 'missing'
        ? [`Runtime mutation generation is unavailable: ${generationBeforeScan.diagnostic}`]
        : [];
    const projection: DerivedCatalogProjection = {
        generatedAtUtc: observedAtUtc,
        snapshotSha256: snapshotHash(sourceFingerprints),
        canonicalGeneration,
        canonicalSources: sourceFingerprints,
        tasks,
        lifecycleEvents: lifecycleEvents.sort((left, right) => (
            left.taskId.localeCompare(right.taskId) || left.taskSequence - right.taskSequence
        )),
        reviewAttempts: reviewAttempts.sort((left, right) => left.attemptId.localeCompare(right.attemptId)),
        reviewReceipts: reviewReceipts.sort((left, right) => left.receiptId.localeCompare(right.receiptId)),
        artifacts,
        taskLedgers: taskLedgers.sort((left, right) => left.taskId.localeCompare(right.taskId)),
        retentionStates: retentionStates.sort((left, right) => left.retentionId.localeCompare(right.retentionId)),
        metricSamples
    };
    validateCatalogProjection(projection);
    return {
        projection,
        sourcePaths: sourceFingerprints.map((source) => source.sourcePath),
        sourceFingerprints,
        diagnostics
    };
}
