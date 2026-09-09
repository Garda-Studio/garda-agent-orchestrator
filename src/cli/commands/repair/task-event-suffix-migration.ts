import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    buildEventIntegrityHash,
    LEGACY_TASK_EVENT_INTEGRITY_SCHEMA_VERSION,
    MAX_TASK_TIMELINE_JSONL_LINES,
    readTaskTimelineJsonlEntries,
    TASK_EVENT_INTEGRITY_SCHEMA_VERSION,
    toTrimmedLowerCaseString,
    toTrimmedString
} from '../../../gate-runtime/timeline/task-events-helpers';
import {
    readTaskTimelineFileSnapshot,
    withTaskTimelineFileReadSnapshot,
    MAX_TASK_TIMELINE_SNAPSHOT_BYTES
} from '../../../gate-runtime/timeline/task-timeline-read-snapshot';
import { inspectTaskEventFile } from '../../../gate-runtime/timeline/task-events-integrity';
import { withFilesystemLock } from '../../../gate-runtime/timeline/task-events-locking';
import { reconcileTimelineSummaryForTask } from '../../../gate-runtime/timeline-summary';
import { assertCanonicalTaskId } from '../../../core/task-ids';
import {
    readAuthenticatedRepoFileSnapshot,
    replaceAuthenticatedRepoFile,
    writeExclusiveRepoFile,
    type AuthenticatedRepoFileSnapshot
} from '../../../gates/split-required/split-required-wip-restore-plan';

const MIGRATION_OPERATION = 'task-event-legacy-suffix-migration';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type MigrationStatus = 'READY' | 'REJECTED' | 'ALREADY_CURRENT' | 'APPLIED';

export interface TaskEventSuffixMigrationResult {
    schema_version: 1;
    operation: typeof MIGRATION_OPERATION;
    task_id: string;
    source_path: string;
    status: MigrationStatus;
    dry_run: boolean;
    changed: boolean;
    reason_code: string;
    diagnostic: string;
    source_sha256: string | null;
    source_identity_sha256: string | null;
    migrated_sha256: string | null;
    plan_sha256: string | null;
    anchor_line: number | null;
    suffix_start_line: number | null;
    suffix_event_count: number;
    backup_path: string | null;
    backup_manifest_path: string | null;
    integrity_status: string | null;
    warnings: string[];
}

export interface ApplyTaskEventSuffixMigrationOptions {
    expectedPlanSha256: string;
    beforeReplace?: () => void;
}

interface ParsedTimelineEntry {
    lineNumber: number;
    record: Record<string, unknown> | null;
}

interface TimelineAnalysis {
    status: 'READY' | 'REJECTED' | 'ALREADY_CURRENT';
    reasonCode: string;
    diagnostic: string;
    anchorLine: number | null;
    suffixStartLine: number | null;
    suffixEventCount: number;
    migratedContent: Buffer | null;
}

interface PreparedMigration {
    result: TaskEventSuffixMigrationResult;
    sourceSnapshot: AuthenticatedRepoFileSnapshot | null;
    migratedContent: Buffer | null;
    repoRelativeTimelinePath: string;
}

function sha256(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex').toLowerCase();
}

function normalizedOutputPath(filePath: string): string {
    return path.resolve(filePath).replace(/\\/gu, '/');
}

function resolveRepoRelativePath(repoRoot: string, filePath: string): string {
    const relativePath = path.relative(path.resolve(repoRoot), path.resolve(filePath));
    if (
        relativePath === ''
        || relativePath.startsWith('..')
        || path.isAbsolute(relativePath)
    ) {
        throw new Error('Task timeline path must remain inside the repository root.');
    }
    return relativePath.replace(/\\/gu, '/');
}

function buildResult(
    taskId: string,
    timelinePath: string,
    overrides: Partial<TaskEventSuffixMigrationResult>
): TaskEventSuffixMigrationResult {
    return {
        schema_version: 1,
        operation: MIGRATION_OPERATION,
        task_id: taskId,
        source_path: normalizedOutputPath(timelinePath),
        status: 'REJECTED',
        dry_run: true,
        changed: false,
        reason_code: 'timeline_invalid',
        diagnostic: 'Task timeline is not eligible for suffix migration.',
        source_sha256: null,
        source_identity_sha256: null,
        migrated_sha256: null,
        plan_sha256: null,
        anchor_line: null,
        suffix_start_line: null,
        suffix_event_count: 0,
        backup_path: null,
        backup_manifest_path: null,
        integrity_status: null,
        warnings: [],
        ...overrides
    };
}

function rejectAnalysis(reasonCode: string, diagnostic: string): TimelineAnalysis {
    return {
        status: 'REJECTED',
        reasonCode,
        diagnostic,
        anchorLine: null,
        suffixStartLine: null,
        suffixEventCount: 0,
        migratedContent: null
    };
}

function normalizePreviousHash(value: unknown): string | null {
    if (value == null || !String(value).trim()) {
        return null;
    }
    return String(value).trim().toLowerCase();
}

function cloneEventWithMigratedIntegrity(
    event: Record<string, unknown>,
    previousHash: string
): { event: Record<string, unknown>; eventHash: string } {
    const sourceIntegrity = event.integrity as Record<string, unknown>;
    const integrity: Record<string, unknown> = {
        ...sourceIntegrity,
        schema_version: TASK_EVENT_INTEGRITY_SCHEMA_VERSION,
        prev_event_sha256: previousHash
    };
    delete integrity.event_sha256;
    const migratedEvent = { ...event, integrity };
    const eventHash = buildEventIntegrityHash(migratedEvent);
    if (!eventHash) {
        throw new Error('Unable to build migrated task-event integrity hash.');
    }
    integrity.event_sha256 = eventHash;
    return { event: migratedEvent, eventHash };
}

function analyzeTimeline(
    taskId: string,
    sourceContent: Buffer,
    entries: readonly ParsedTimelineEntry[]
): TimelineAnalysis {
    if (entries.length === 0) {
        return rejectAnalysis('timeline_empty', 'Task timeline contains no event records.');
    }
    if (entries.length > MAX_TASK_TIMELINE_JSONL_LINES) {
        return rejectAnalysis(
            'timeline_oversized',
            `Task timeline exceeds the ${MAX_TASK_TIMELINE_JSONL_LINES} event-line limit.`
        );
    }

    let legacyPrefixCount = 0;
    let integrityStarted = false;
    let expectedSequence: number | null = null;
    let previousHash: string | null = null;
    let sawCurrentSchema = false;
    let suffixStartIndex: number | null = null;
    const seenHashes = new Set<string>();

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const event = entry.record;
        if (!event) {
            return rejectAnalysis(
                'invalid_json',
                `Task timeline contains invalid JSON at line ${entry.lineNumber}.`
            );
        }
        if (toTrimmedString(event.task_id) !== taskId) {
            return rejectAnalysis(
                'foreign_task',
                `Task timeline contains a foreign or missing task_id at line ${entry.lineNumber}.`
            );
        }

        const integrityValue = event.integrity;
        if (!integrityValue || typeof integrityValue !== 'object' || Array.isArray(integrityValue)) {
            if (integrityStarted) {
                return rejectAnalysis(
                    'mixed_unverified_suffix',
                    `Task timeline contains an unverified event after integrity started at line ${entry.lineNumber}.`
                );
            }
            legacyPrefixCount += 1;
            continue;
        }

        integrityStarted = true;
        const integrity = integrityValue as Record<string, unknown>;
        const schemaVersion = integrity.schema_version;
        if (
            schemaVersion !== LEGACY_TASK_EVENT_INTEGRITY_SCHEMA_VERSION
            && schemaVersion !== TASK_EVENT_INTEGRITY_SCHEMA_VERSION
        ) {
            return rejectAnalysis(
                'unknown_integrity_schema',
                `Task timeline has an unsupported integrity schema at line ${entry.lineNumber}.`
            );
        }

        const taskSequence = integrity.task_sequence;
        if (!Number.isSafeInteger(taskSequence) || Number(taskSequence) <= 0) {
            return rejectAnalysis(
                'invalid_sequence',
                `Task timeline has an invalid task_sequence at line ${entry.lineNumber}.`
            );
        }
        const sequence = Number(taskSequence);
        const eventHash = toTrimmedLowerCaseString(integrity.event_sha256);
        if (!SHA256_PATTERN.test(eventHash) || buildEventIntegrityHash(event) !== eventHash) {
            return rejectAnalysis(
                'invalid_event_hash',
                `Task timeline event_sha256 mismatch at line ${entry.lineNumber}.`
            );
        }
        if (seenHashes.has(eventHash)) {
            return rejectAnalysis(
                'replayed_event',
                `Task timeline contains a duplicate or replayed event at line ${entry.lineNumber}.`
            );
        }
        if (expectedSequence == null) {
            expectedSequence = legacyPrefixCount + 1;
        }
        if (sequence !== expectedSequence) {
            return rejectAnalysis(
                'invalid_sequence',
                `Task timeline sequence mismatch at line ${entry.lineNumber}: expected ${expectedSequence}, got ${sequence}.`
            );
        }

        const prevEventHash = normalizePreviousHash(integrity.prev_event_sha256);
        if (prevEventHash !== previousHash) {
            return rejectAnalysis(
                'invalid_hash_chain',
                `Task timeline prev_event_sha256 mismatch at line ${entry.lineNumber}.`
            );
        }
        seenHashes.add(eventHash);

        if (schemaVersion === TASK_EVENT_INTEGRITY_SCHEMA_VERSION) {
            if (suffixStartIndex !== null) {
                return rejectAnalysis(
                    'mixed_legacy_suffix',
                    `Task timeline legacy suffix is non-terminal at line ${entry.lineNumber}.`
                );
            }
            sawCurrentSchema = true;
        } else if (sawCurrentSchema && suffixStartIndex === null) {
            suffixStartIndex = index;
        }

        previousHash = eventHash;
        expectedSequence = sequence + 1;
    }

    if (!sawCurrentSchema) {
        return rejectAnalysis(
            'unanchored_legacy_timeline',
            'Task timeline has no trusted current-schema event before a legacy suffix.'
        );
    }
    if (suffixStartIndex === null) {
        return {
            status: 'ALREADY_CURRENT',
            reasonCode: 'already_current',
            diagnostic: 'Task timeline has no authenticated legacy suffix to migrate.',
            anchorLine: null,
            suffixStartLine: null,
            suffixEventCount: 0,
            migratedContent: null
        };
    }

    const anchorEntry = entries[suffixStartIndex - 1];
    const anchorIntegrity = anchorEntry?.record?.integrity as Record<string, unknown> | undefined;
    if (!anchorEntry || anchorIntegrity?.schema_version !== TASK_EVENT_INTEGRITY_SCHEMA_VERSION) {
        return rejectAnalysis(
            'ambiguous_anchor',
            'Task timeline legacy suffix is not immediately anchored to a current-schema event.'
        );
    }

    const sourceText = sourceContent.toString('utf8');
    if (!Buffer.from(sourceText, 'utf8').equals(sourceContent)) {
        return rejectAnalysis('invalid_utf8', 'Task timeline is not valid UTF-8.');
    }
    const rawLines = sourceText.split('\n');
    let migratedPreviousHash = toTrimmedLowerCaseString(anchorIntegrity.event_sha256);
    for (let index = suffixStartIndex; index < entries.length; index += 1) {
        const entry = entries[index];
        const event = entry.record as Record<string, unknown>;
        const migrated = cloneEventWithMigratedIntegrity(event, migratedPreviousHash);
        rawLines[entry.lineNumber - 1] = JSON.stringify(migrated.event);
        migratedPreviousHash = migrated.eventHash;
    }

    return {
        status: 'READY',
        reasonCode: 'legacy_suffix_ready',
        diagnostic: 'Authenticated terminal legacy suffix is eligible for migration.',
        anchorLine: anchorEntry.lineNumber,
        suffixStartLine: entries[suffixStartIndex].lineNumber,
        suffixEventCount: entries.length - suffixStartIndex,
        migratedContent: Buffer.from(rawLines.join('\n'), 'utf8')
    };
}

function captureParsedTimeline(
    timelinePath: string
): { content: Buffer; entries: ParsedTimelineEntry[] } | null {
    return withTaskTimelineFileReadSnapshot(timelinePath, () => {
        const snapshot = readTaskTimelineFileSnapshot(timelinePath);
        if (!snapshot.valid) {
            throw new Error('Task timeline is unsafe or changed while it was being authenticated.');
        }
        if (!snapshot.exists || !snapshot.content) {
            return null;
        }
        const entries = readTaskTimelineJsonlEntries(timelinePath).map((entry) => ({
            lineNumber: entry.lineNumber,
            record: entry.record
        }));
        return { content: snapshot.content, entries };
    });
}

function identitySha256(identity: fs.Stats): string {
    return sha256(JSON.stringify({
        dev: identity.dev,
        ino: identity.ino,
        size: identity.size,
        mode: identity.mode,
        mtime_ms: identity.mtimeMs,
        ctime_ms: identity.ctimeMs,
        birthtime_ms: identity.birthtimeMs
    }));
}

function prepareMigration(repoRoot: string, bundleRoot: string, rawTaskId: string): PreparedMigration {
    const taskId = assertCanonicalTaskId(rawTaskId);
    const timelinePath = path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
    const repoRelativeTimelinePath = resolveRepoRelativePath(repoRoot, timelinePath);
    try {
        const sourceSnapshot = readAuthenticatedRepoFileSnapshot(
            repoRoot,
            repoRelativeTimelinePath,
            MAX_TASK_TIMELINE_SNAPSHOT_BYTES
        );
        if (!sourceSnapshot.exists) {
            return {
                result: buildResult(taskId, timelinePath, {
                    reason_code: 'timeline_missing',
                    diagnostic: 'Task timeline does not exist.'
                }),
                sourceSnapshot: null,
                migratedContent: null,
                repoRelativeTimelinePath
            };
        }
        if (!sourceSnapshot.content || !sourceSnapshot.identity) {
            throw new Error('Task timeline became unavailable while it was being authenticated.');
        }
        if (sourceSnapshot.identity.nlink !== 1) {
            throw new Error('Task timeline must be a uniquely linked regular file.');
        }
        const parsed = captureParsedTimeline(timelinePath);
        if (!parsed) {
            throw new Error('Task timeline became unavailable while it was being authenticated.');
        }
        if (!sourceSnapshot.content.equals(parsed.content)) {
            throw new Error('Task timeline changed while the migration preview was being prepared.');
        }

        const analysis = analyzeTimeline(taskId, parsed.content, parsed.entries);
        const sourceSha256 = sha256(parsed.content);
        const sourceIdentitySha256 = identitySha256(sourceSnapshot.identity);
        if (analysis.status !== 'READY' || !analysis.migratedContent) {
            return {
                result: buildResult(taskId, timelinePath, {
                    status: analysis.status,
                    reason_code: analysis.reasonCode,
                    diagnostic: analysis.diagnostic,
                    source_sha256: sourceSha256,
                    source_identity_sha256: sourceIdentitySha256,
                    anchor_line: analysis.anchorLine,
                    suffix_start_line: analysis.suffixStartLine,
                    suffix_event_count: analysis.suffixEventCount
                }),
                sourceSnapshot,
                migratedContent: null,
                repoRelativeTimelinePath
            };
        }

        const migratedSha256 = sha256(analysis.migratedContent);
        const planBody = {
            schema_version: 1,
            operation: MIGRATION_OPERATION,
            task_id: taskId,
            source_path: repoRelativeTimelinePath,
            source_sha256: sourceSha256,
            source_identity_sha256: sourceIdentitySha256,
            migrated_sha256: migratedSha256,
            anchor_line: analysis.anchorLine,
            suffix_start_line: analysis.suffixStartLine,
            suffix_event_count: analysis.suffixEventCount
        };
        const planSha256 = sha256(JSON.stringify(planBody));
        return {
            result: buildResult(taskId, timelinePath, {
                status: 'READY',
                changed: true,
                reason_code: analysis.reasonCode,
                diagnostic: analysis.diagnostic,
                source_sha256: sourceSha256,
                source_identity_sha256: sourceIdentitySha256,
                migrated_sha256: migratedSha256,
                plan_sha256: planSha256,
                anchor_line: analysis.anchorLine,
                suffix_start_line: analysis.suffixStartLine,
                suffix_event_count: analysis.suffixEventCount
            }),
            sourceSnapshot,
            migratedContent: analysis.migratedContent,
            repoRelativeTimelinePath
        };
    } catch (error: unknown) {
        const diagnostic = error instanceof Error ? error.message : String(error);
        const reasonCode = diagnostic.includes('exceeds the') && diagnostic.includes('byte')
            ? 'timeline_oversized'
            : diagnostic.includes('JSON exceeds') || diagnostic.includes('line limit')
                ? 'timeline_oversized'
                : 'timeline_unsafe_or_changed';
        return {
            result: buildResult(taskId, timelinePath, {
                reason_code: reasonCode,
                diagnostic
            }),
            sourceSnapshot: null,
            migratedContent: null,
            repoRelativeTimelinePath
        };
    }
}

function assertExpectedPlanSha256(value: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (!SHA256_PATTERN.test(normalized)) {
        throw new Error('--expected-plan-sha256 must be a 64-character lowercase SHA-256 value.');
    }
    return normalized;
}

function verifyRepoFile(
    repoRoot: string,
    relativePath: string,
    expectedContent: Buffer,
    label: string
): AuthenticatedRepoFileSnapshot {
    const snapshot = readAuthenticatedRepoFileSnapshot(repoRoot, relativePath, expectedContent.length);
    if (
        !snapshot.exists
        || !snapshot.content
        || !snapshot.identity
        || snapshot.identity.nlink !== 1
        || !snapshot.content.equals(expectedContent)
    ) {
        throw new Error(`${label} could not be verified after write.`);
    }
    return snapshot;
}

function backupRelativePaths(
    repoRoot: string,
    bundleRoot: string,
    taskId: string,
    planSha256: string
): { backupRelativePath: string; manifestRelativePath: string } {
    const bundleRelativePath = resolveRepoRelativePath(repoRoot, bundleRoot);
    const backupRelativePath = path.posix.join(
        bundleRelativePath,
        'runtime',
        'task-event-migration-backups',
        taskId,
        `${planSha256}.jsonl`
    );
    return {
        backupRelativePath,
        manifestRelativePath: `${backupRelativePath}.manifest.json`
    };
}

function writeOrVerifyExclusiveBackup(
    repoRoot: string,
    bundleRoot: string,
    prepared: PreparedMigration
): { backupPath: string; manifestPath: string } {
    const { result, sourceSnapshot } = prepared;
    if (!sourceSnapshot?.content || !result.plan_sha256 || !result.source_sha256) {
        throw new Error('Task-event migration backup requires a complete current preview.');
    }
    const { backupRelativePath, manifestRelativePath } = backupRelativePaths(
        repoRoot,
        bundleRoot,
        result.task_id,
        result.plan_sha256
    );
    const manifestContent = Buffer.from(`${JSON.stringify({
        schema_version: 1,
        event_source: 'task-event-legacy-suffix-migration-backup',
        task_id: result.task_id,
        source_path: prepared.repoRelativeTimelinePath,
        source_sha256: result.source_sha256,
        source_identity_sha256: result.source_identity_sha256,
        migrated_sha256: result.migrated_sha256,
        plan_sha256: result.plan_sha256,
        bytes: sourceSnapshot.content.length
    }, null, 2)}\n`, 'utf8');

    const writeOrVerify = (relativePath: string, content: Buffer, label: string): void => {
        const existing = readAuthenticatedRepoFileSnapshot(repoRoot, relativePath, content.length);
        if (!existing.exists) {
            try {
                writeExclusiveRepoFile(repoRoot, relativePath, content, 0o600);
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw error;
                }
            }
        }
        verifyRepoFile(repoRoot, relativePath, content, label);
    };

    writeOrVerify(backupRelativePath, sourceSnapshot.content, 'Task-event migration backup');
    writeOrVerify(manifestRelativePath, manifestContent, 'Task-event migration backup manifest');
    return {
        backupPath: normalizedOutputPath(path.join(repoRoot, backupRelativePath)),
        manifestPath: normalizedOutputPath(path.join(repoRoot, manifestRelativePath))
    };
}

function verifyAppliedMigrationReceipt(
    repoRoot: string,
    bundleRoot: string,
    prepared: PreparedMigration,
    expectedPlanSha256: string
): { backupPath: string; manifestPath: string; migratedSha256: string } {
    const currentSha256 = prepared.result.source_sha256;
    if (!currentSha256) {
        throw new Error('Already-current task timeline could not be authenticated.');
    }
    const { backupRelativePath, manifestRelativePath } = backupRelativePaths(
        repoRoot,
        bundleRoot,
        prepared.result.task_id,
        expectedPlanSha256
    );
    const manifestSnapshot = readAuthenticatedRepoFileSnapshot(
        repoRoot,
        manifestRelativePath,
        64 * 1024
    );
    if (!manifestSnapshot.content || !manifestSnapshot.identity || manifestSnapshot.identity.nlink !== 1) {
        throw new Error('Already-current timeline has no verified receipt for the expected migration plan.');
    }
    let manifest: Record<string, unknown>;
    try {
        const parsed = JSON.parse(manifestSnapshot.content.toString('utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('not an object');
        }
        manifest = parsed as Record<string, unknown>;
    } catch {
        throw new Error('Already-current timeline migration receipt is invalid JSON.');
    }
    const sourceSha256 = toTrimmedLowerCaseString(manifest.source_sha256);
    const migratedSha256 = toTrimmedLowerCaseString(manifest.migrated_sha256);
    if (
        manifest.schema_version !== 1
        || manifest.event_source !== 'task-event-legacy-suffix-migration-backup'
        || manifest.task_id !== prepared.result.task_id
        || manifest.source_path !== prepared.repoRelativeTimelinePath
        || toTrimmedLowerCaseString(manifest.plan_sha256) !== expectedPlanSha256
        || !SHA256_PATTERN.test(sourceSha256)
        || migratedSha256 !== currentSha256
    ) {
        throw new Error('Already-current timeline does not match the expected migration receipt.');
    }
    const backupSnapshot = readAuthenticatedRepoFileSnapshot(
        repoRoot,
        backupRelativePath,
        MAX_TASK_TIMELINE_SNAPSHOT_BYTES
    );
    if (
        !backupSnapshot.content
        || !backupSnapshot.identity
        || backupSnapshot.identity.nlink !== 1
        || sha256(backupSnapshot.content) !== sourceSha256
    ) {
        throw new Error('Already-current timeline migration backup could not be verified.');
    }
    return {
        backupPath: normalizedOutputPath(path.join(repoRoot, backupRelativePath)),
        manifestPath: normalizedOutputPath(path.join(repoRoot, manifestRelativePath)),
        migratedSha256
    };
}

function rollbackMigratedTimeline(
    repoRoot: string,
    prepared: PreparedMigration
): void {
    const sourceContent = prepared.sourceSnapshot?.content;
    const sourceMode = prepared.sourceSnapshot?.mode;
    const migratedContent = prepared.migratedContent;
    if (!sourceContent || sourceMode == null || !migratedContent) {
        throw new Error('Task-event migration rollback is missing authenticated source bytes.');
    }
    const current = readAuthenticatedRepoFileSnapshot(
        repoRoot,
        prepared.repoRelativeTimelinePath,
        MAX_TASK_TIMELINE_SNAPSHOT_BYTES
    );
    if (!current.content || !current.content.equals(migratedContent)) {
        throw new Error('Task-event migration rollback preserved a concurrent timeline change.');
    }
    replaceAuthenticatedRepoFile(
        repoRoot,
        prepared.repoRelativeTimelinePath,
        sourceContent,
        current,
        sourceMode & 0o777
    );
}

export function previewTaskEventSuffixMigration(
    repoRoot: string,
    bundleRoot: string,
    taskId: string
): TaskEventSuffixMigrationResult {
    return prepareMigration(repoRoot, bundleRoot, taskId).result;
}

export function applyTaskEventSuffixMigration(
    repoRoot: string,
    bundleRoot: string,
    taskId: string,
    options: ApplyTaskEventSuffixMigrationOptions
): TaskEventSuffixMigrationResult {
    const safeTaskId = assertCanonicalTaskId(taskId);
    const expectedPlanSha256 = assertExpectedPlanSha256(options.expectedPlanSha256);
    const timelinePath = path.join(bundleRoot, 'runtime', 'task-events', `${safeTaskId}.jsonl`);
    const taskLockPath = path.join(path.dirname(timelinePath), `.${safeTaskId}.lock`);

    return withFilesystemLock(taskLockPath, {
        ownerLabel: `task-event-suffix-migration:${safeTaskId}`
    }, () => {
        const prepared = prepareMigration(repoRoot, bundleRoot, safeTaskId);
        if (prepared.result.status === 'ALREADY_CURRENT') {
            const receipt = verifyAppliedMigrationReceipt(
                repoRoot,
                bundleRoot,
                prepared,
                expectedPlanSha256
            );
            const integrity = inspectTaskEventFile(timelinePath, safeTaskId);
            if (integrity.status !== 'PASS' && integrity.status !== 'PASS_WITH_LEGACY_PREFIX') {
                throw new Error('Already-current task timeline failed integrity verification.');
            }
            return {
                ...prepared.result,
                dry_run: false,
                plan_sha256: expectedPlanSha256,
                migrated_sha256: receipt.migratedSha256,
                backup_path: receipt.backupPath,
                backup_manifest_path: receipt.manifestPath,
                integrity_status: integrity.status
            };
        }
        if (
            prepared.result.status !== 'READY'
            || !prepared.result.plan_sha256
            || !prepared.sourceSnapshot
            || !prepared.migratedContent
        ) {
            throw new Error(
                `Task timeline is not eligible for migration: ${prepared.result.reason_code}: `
                + prepared.result.diagnostic
            );
        }
        if (prepared.result.plan_sha256 !== expectedPlanSha256) {
            throw new Error('Task timeline changed after preview; the migration plan is stale.');
        }

        const backup = writeOrVerifyExclusiveBackup(repoRoot, bundleRoot, prepared);
        options.beforeReplace?.();
        replaceAuthenticatedRepoFile(
            repoRoot,
            prepared.repoRelativeTimelinePath,
            prepared.migratedContent,
            prepared.sourceSnapshot,
            (prepared.sourceSnapshot.mode ?? 0o600) & 0o777
        );

        try {
            verifyRepoFile(
                repoRoot,
                prepared.repoRelativeTimelinePath,
                prepared.migratedContent,
                'Migrated task timeline'
            );
            const integrity = inspectTaskEventFile(timelinePath, safeTaskId);
            if (integrity.status !== 'PASS' && integrity.status !== 'PASS_WITH_LEGACY_PREFIX') {
                throw new Error(
                    `Migrated task timeline integrity verification failed: ${integrity.violations.join('; ')}`
                );
            }
            const warnings: string[] = [];
            try {
                reconcileTimelineSummaryForTask(path.dirname(timelinePath), safeTaskId);
            } catch (error: unknown) {
                warnings.push(
                    `Timeline summary refresh failed: ${error instanceof Error ? error.message : String(error)}`
                );
            }
            return {
                ...prepared.result,
                status: 'APPLIED' as const,
                dry_run: false,
                backup_path: backup.backupPath,
                backup_manifest_path: backup.manifestPath,
                integrity_status: integrity.status,
                warnings
            };
        } catch (error: unknown) {
            try {
                rollbackMigratedTimeline(repoRoot, prepared);
            } catch (rollbackError: unknown) {
                throw new AggregateError(
                    [error, rollbackError],
                    'Task-event suffix migration failed and rollback could not be completed safely.'
                );
            }
            throw new Error(
                `Task-event suffix migration failed and was rolled back: `
                + (error instanceof Error ? error.message : String(error))
            );
        }
    }).result;
}
