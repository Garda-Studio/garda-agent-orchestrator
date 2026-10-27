import { beginPersistedQualityTimelinePass, type PersistedQualityTimelineQuery } from './task-persisted-quality-query';
import { beginClosedReviewVerifiedPass, type ClosedReviewVerifiedCapture } from './task-closed-review-query';
import { beginCadenceVerifiedPass } from './task-cadence-runtime';
import type { ReviewCadenceWindow } from '../review/review-cadence-window';
import { beginValidationTimelineQueryPass, bindValidationTimelineQuery, type ValidationTimelineQuery } from './validation-timeline-query';
import { beginNavigationTimelineQueryPass, type NavigationTimelineQuery } from './task-navigation-query';
import { beginRouteVerifiedPass, type TaskRouteQuery } from './task-route-query';
import { isInvocationReadObservationActive } from '../../core/invocation-read-observation';
import { measureNextStepPhase } from '../../core/next-step-measurement';
import {
    buildEventIntegrityHash,
    forEachTaskTimelineJsonlEntry,
    readTaskTimelineEntryStartByte,
    readTaskTimelineValidationJsonLinesCompatible,
    LEGACY_TASK_EVENT_INTEGRITY_SCHEMA_VERSION,
    TASK_EVENT_INTEGRITY_SCHEMA_VERSION,
    toTrimmedLowerCaseString,
    toTrimmedString
} from './task-events-helpers';
import {
    assertTaskTimelineReadSnapshotCurrent,
    captureTaskTimelineReadSnapshotSha256,
    captureTaskTimelineReadSnapshotByteLength,
    readTaskTimelineSnapshotByteLength,
    createTaskTimelineMemoizationKey,
    isTaskTimelineReadSnapshotActive,
    memoizeTaskTimelineSnapshot,
    readTaskTimelineFileMetadataSnapshot,
    taskTimelineAwareFileExists,
    type TaskTimelineDeepReadonly,
    type TaskTimelineMemoizedRead,
    withTaskTimelineFileReadSnapshot
} from './task-timeline-read-snapshot';

export interface InspectTaskEventResult {
    source_path: string;
    status: string;
    events_scanned: number;
    matching_events: number;
    parse_errors: number;
    task_id_mismatches: number;
    legacy_event_count: number;
    integrity_event_count: number;
    first_integrity_sequence: number | null;
    last_integrity_sequence: number | null;
    duplicate_event_hashes: string[];
    violations: string[];
}

export interface InspectTaskEventOptions {
    onIntegrityEvent?: (event: Readonly<Record<string, unknown>>, lineNumber: number) => void;
}

interface IntegrityEvent {
    event: Readonly<Record<string, unknown>>;
    lineNumber: number;
}
interface CapturedIntegrityInspection {
    persistedQualityQuery: PersistedQualityTimelineQuery | null;
    result: InspectTaskEventResult;
    events: IntegrityEvent[];
    closedReviews: ClosedReviewVerifiedCapture | null;
    cadence: ReviewCadenceWindow | null;
    validationQueries: ValidationTimelineQuery | null;
    navigationQueries: NavigationTimelineQuery | null;
    routeQueries: TaskRouteQuery | null;
}

const INTEGRITY_INSPECTION_MEMOIZATION_KEY = createTaskTimelineMemoizationKey<CapturedIntegrityInspection>(
    'integrity-inspection'
);

function isMissingPathError(error: unknown): boolean {
    const code = error && typeof error === 'object' && 'code' in error
        ? String((error as NodeJS.ErrnoException).code || '')
        : '';
    return code === 'ENOENT' || code === 'ENOTDIR';
}

function recordTaskTimelineReadFailure(
    result: InspectTaskEventResult,
    taskEventFile: string,
    error: unknown
): void {
    const snapshotMetadata = readTaskTimelineFileMetadataSnapshot(taskEventFile);
    if (snapshotMetadata.active && !snapshotMetadata.valid) {
        result.status = 'FAILED';
        const diagnostic = error instanceof Error ? error.message : String(error || '');
        result.violations.push(
            diagnostic.includes(' limit')
                ? `Task timeline read failed: ${diagnostic}`
                : 'Task timeline snapshot changed or became unavailable during this invocation.'
        );
        return;
    }
    if (isMissingPathError(error)) {
        result.status = 'MISSING';
        result.violations.push(`Task events file not found: ${result.source_path}`);
        return;
    }
    result.status = 'FAILED';
    result.violations.push(
        `Task timeline read failed: ${error instanceof Error ? error.message : String(error)}`
    );
}

export function normalizeIntegrityValue(value: unknown): unknown {
    if (value == null) {
        return value;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (Array.isArray(value)) {
        return value.map(normalizeIntegrityValue);
    }

    if (typeof value === 'object') {
        const sorted: Record<string, unknown> = {};
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        for (const key of keys) {
            Object.defineProperty(sorted, key, {
                configurable: true,
                enumerable: true,
                value: normalizeIntegrityValue(obj[key]),
                writable: true
            });
        }
        return sorted;
    }

    if (typeof value === 'string' && value.includes('\\')) {
        return value.replace(/\\/g, '/');
    }

    return value;
}

function inspectTaskEventFileUncached(
    taskEventFile: string,
    taskId: string,
    options: InspectTaskEventOptions = {},
    capturedEvents?: IntegrityEvent[],
    capturedQueries?: Omit<CapturedIntegrityInspection, 'result' | 'events'>
): InspectTaskEventResult {
    return measureNextStepPhase('timeline_verify', () => {
    const result: InspectTaskEventResult = {
        source_path: String(taskEventFile).replace(/\\/g, '/'),
        status: 'UNKNOWN',
        events_scanned: 0,
        matching_events: 0,
        parse_errors: 0,
        task_id_mismatches: 0,
        legacy_event_count: 0,
        integrity_event_count: 0,
        first_integrity_sequence: null,
        last_integrity_sequence: null,
        duplicate_event_hashes: [],
        violations: []
    };

    try {
        if (!taskTimelineAwareFileExists(taskEventFile)) {
            const snapshotMetadata = readTaskTimelineFileMetadataSnapshot(taskEventFile);
            if (snapshotMetadata.active && !snapshotMetadata.valid) {
                result.status = 'FAILED';
                result.violations.push('Task timeline snapshot changed or became unavailable during this invocation.');
            } else {
                result.status = 'MISSING';
                result.violations.push(`Task events file not found: ${result.source_path}`);
            }
            return result;
        }
    } catch (error: unknown) {
        recordTaskTimelineReadFailure(result, taskEventFile, error);
        return result;
    }

    let lastEventHash: string | null = null;
    let expectedSequence: number | null = null;
    let integrityStarted = false;
    let latestIntegritySchemaVersion: number | null = null;
    const seenHashes = new Set<string>();
    const validatedIntegrityEvents = capturedEvents ?? [];
    let closedReviews = capturedQueries ? beginClosedReviewVerifiedPass(taskId) : null;
    let cadence = capturedQueries ? beginCadenceVerifiedPass(taskEventFile, taskId) : null;
    let validationQueries = capturedQueries ? beginValidationTimelineQueryPass() : null;
    let navigation = capturedQueries ? beginNavigationTimelineQueryPass() : null;
    let routePass = capturedQueries ? beginRouteVerifiedPass() : null;
    let persistedQuality = capturedQueries ? beginPersistedQualityTimelinePass() : null;
    let cadenceOffsetsAvailable = true;

    try {
        forEachTaskTimelineJsonlEntry(taskEventFile, (timelineEntry) => {
            const lineNumber = timelineEntry.lineNumber;
            result.events_scanned++;

            const event = timelineEntry.record;
            try { persistedQuality?.accept(event); } catch { persistedQuality = null; }
            // These field updates are fused into the one mandatory timeline_events pass.
            // All collectors receive the same native nonempty ordinal, including malformed rows.
            const nonemptyOrdinal = result.events_scanned - 1;
            const startByte = readTaskTimelineEntryStartByte(timelineEntry);
            // Optional projection coercions must not change canonical integrity acceptance.
            // A failed collector is discarded; its consumers retain their native fallback.
            try { closedReviews?.accept(event, nonemptyOrdinal); } catch { closedReviews = null; }
            try { validationQueries?.accept(event, nonemptyOrdinal); } catch { validationQueries = null; }
            try { navigation?.accept(event); } catch { navigation = null; }
            try { routePass?.accept(event, nonemptyOrdinal, startByte); } catch { routePass = null; }
            if (cadence) {
                if (startByte === undefined) cadenceOffsetsAvailable = false;
                else { try { cadence.accept(startByte, event, !event); } catch { cadence = null; } }
            }
            if (!event) {
                result.parse_errors++;
                result.violations.push(`Task timeline contains invalid JSON at line ${lineNumber}.`);
                return;
            }

            const eventTaskId = toTrimmedString(event.task_id);
            if (eventTaskId !== taskId) {
                result.task_id_mismatches++;
                result.violations.push(
                    eventTaskId
                        ? `Task timeline contains foreign task_id '${eventTaskId}' at line ${lineNumber}.`
                        : `Task timeline is missing task_id at line ${lineNumber}.`
                );
                return;
            }

            result.matching_events++;
            const integrity = event.integrity;
            if (!integrity || typeof integrity !== 'object') {
                if (integrityStarted) {
                    result.violations.push(
                        `Task timeline contains legacy/unverified event after integrity chain start at line ${lineNumber}.`
                    );
                } else {
                    result.legacy_event_count++;
                }
                return;
            }

            const integrityRecord = integrity as Record<string, unknown>;
            const schemaVersion = integrityRecord.schema_version;
            const taskSequence = integrityRecord.task_sequence;
            let prevEventSha256 = integrityRecord.prev_event_sha256;
            const eventSha256 = toTrimmedLowerCaseString(integrityRecord.event_sha256);

            if (
                schemaVersion !== LEGACY_TASK_EVENT_INTEGRITY_SCHEMA_VERSION
                && schemaVersion !== TASK_EVENT_INTEGRITY_SCHEMA_VERSION
            ) {
                result.violations.push(
                    `Task timeline integrity schema mismatch at line ${lineNumber}: expected `
                    + `${LEGACY_TASK_EVENT_INTEGRITY_SCHEMA_VERSION} or `
                    + `${TASK_EVENT_INTEGRITY_SCHEMA_VERSION}, got '${schemaVersion}'.`
                );
                return;
            }
            if (
                latestIntegritySchemaVersion === TASK_EVENT_INTEGRITY_SCHEMA_VERSION
                && schemaVersion === LEGACY_TASK_EVENT_INTEGRITY_SCHEMA_VERSION
            ) {
                result.violations.push(
                    `Task timeline integrity schema downgrade at line ${lineNumber}: `
                    + `${TASK_EVENT_INTEGRITY_SCHEMA_VERSION} to ${LEGACY_TASK_EVENT_INTEGRITY_SCHEMA_VERSION}.`
                );
                return;
            }
            if (typeof taskSequence !== 'number' || taskSequence <= 0) {
                result.violations.push(`Task timeline has invalid task_sequence at line ${lineNumber}.`);
                return;
            }
            if (prevEventSha256 != null && !String(prevEventSha256).trim()) {
                prevEventSha256 = null;
            }
            if (!eventSha256) {
                result.violations.push(`Task timeline missing event_sha256 at line ${lineNumber}.`);
                return;
            }

            if (!integrityStarted) {
                integrityStarted = true;
                expectedSequence = result.legacy_event_count + 1;
                if (prevEventSha256 != null) {
                    result.violations.push(
                        `Task timeline first integrity event must have null prev_event_sha256 (line ${lineNumber}).`
                    );
                }
            }

            if (taskSequence !== expectedSequence) {
                result.violations.push(
                    `Task timeline sequence mismatch at line ${lineNumber}: expected ${expectedSequence}, got ${taskSequence}.`
                );
            }

            const expectedPrevHash = lastEventHash;
            const normalizedPrevHash = prevEventSha256 != null
                ? String(prevEventSha256).trim().toLowerCase()
                : null;
            if (normalizedPrevHash !== expectedPrevHash) {
                result.violations.push(`Task timeline prev_event_sha256 mismatch at line ${lineNumber}.`);
            }

            const recalculatedHash = buildEventIntegrityHash(event);
            if (recalculatedHash !== eventSha256) {
                result.violations.push(`Task timeline event_sha256 mismatch at line ${lineNumber}.`);
            }

            if (seenHashes.has(eventSha256)) {
                result.duplicate_event_hashes.push(eventSha256);
                result.violations.push(`Task timeline duplicate/replayed event detected at line ${lineNumber}.`);
            }
            seenHashes.add(eventSha256);

            if (options.onIntegrityEvent || capturedEvents) {
                validatedIntegrityEvents.push({ event, lineNumber });
            }

            result.integrity_event_count++;
            if (result.first_integrity_sequence == null) {
                result.first_integrity_sequence = taskSequence;
            }
            result.last_integrity_sequence = taskSequence;
            lastEventHash = eventSha256;
            expectedSequence = taskSequence + 1;
            latestIntegritySchemaVersion = schemaVersion;
        });
    } catch (error: unknown) {
        recordTaskTimelineReadFailure(result, taskEventFile, error);
        return result;
    }

    const delivered = deliverIntegrityEvents(result, taskEventFile, validatedIntegrityEvents, options);
    if (capturedQueries) {
        const authenticated = ['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(delivered.status);
        capturedQueries.closedReviews = closedReviews?.finish(authenticated) ?? null;
        capturedQueries.cadence = cadence && cadenceOffsetsAvailable
            ? cadence.finish(captureTaskTimelineReadSnapshotByteLength(taskEventFile), delivered.status.startsWith('PASS')) : null;
        capturedQueries.validationQueries = validationQueries?.finish(authenticated) ?? null;
        capturedQueries.navigationQueries = navigation?.finish(delivered.status.startsWith('PASS')) ?? null;
        capturedQueries.routeQueries = routePass?.finish(delivered.status, readTaskTimelineSnapshotByteLength(taskEventFile)) ?? null;
        try { capturedQueries.persistedQualityQuery = persistedQuality?.finish(delivered.status) ?? null; }
        catch { capturedQueries.persistedQualityQuery = null; } // Optional projection failure retains native verification.

    }
    return delivered;

    });
}

function deliverIntegrityEvents(
    result: InspectTaskEventResult,
    taskEventFile: string,
    validatedIntegrityEvents: readonly IntegrityEvent[],
    options: InspectTaskEventOptions
): InspectTaskEventResult {
    if (result.violations.length === 0 && options.onIntegrityEvent) {
        let expectedSnapshotSha256: string;
        try {
            expectedSnapshotSha256 = captureTaskTimelineReadSnapshotSha256(taskEventFile);
        } catch (error: unknown) {
            recordTaskTimelineReadFailure(result, taskEventFile, error);
            return result;
        }
        for (const { event, lineNumber } of validatedIntegrityEvents) {
            let observerFailed = false;
            let observerError: unknown = null;
            try {
                options.onIntegrityEvent(event, lineNumber);
            } catch (error: unknown) {
                observerFailed = true;
                observerError = error;
            }
            try {
                assertTaskTimelineReadSnapshotCurrent(taskEventFile, expectedSnapshotSha256);
            } catch (error: unknown) {
                recordTaskTimelineReadFailure(result, taskEventFile, error);
                return result;
            }
            if (observerFailed) {
                result.violations.push(
                    `Task timeline integrity-event observer failed at line ${lineNumber}: `
                    + (observerError instanceof Error ? observerError.message : String(observerError))
                );
                break;
            }
        }
    }

    if (result.violations.length > 0) {
        result.status = 'FAILED';
    } else if (result.matching_events === 0) {
        result.status = 'EMPTY';
    } else if (result.integrity_event_count === 0) {
        result.status = 'LEGACY_ONLY';
    } else if (result.legacy_event_count > 0) {
        result.status = 'PASS_WITH_LEGACY_PREFIX';
    } else {
        result.status = 'PASS';
    }

    return result;

}

function cloneInspectTaskEventResult(
    result: TaskTimelineDeepReadonly<InspectTaskEventResult>
): InspectTaskEventResult {
    return {
        ...result,
        duplicate_event_hashes: [...result.duplicate_event_hashes],
        violations: [...result.violations]
    };
}

export function inspectTaskEventFile(
    taskEventFile: string,
    taskId: string,
    options: InspectTaskEventOptions = {}
): InspectTaskEventResult {
    if (!isTaskTimelineReadSnapshotActive(taskEventFile)) {
        return withTaskTimelineFileReadSnapshot(taskEventFile, () => (
            inspectTaskEventFile(taskEventFile, taskId, options)
        ));
    }
    let memoized: TaskTimelineMemoizedRead<CapturedIntegrityInspection>;
    try {
        memoized = captureIntegrityInspection(taskEventFile, taskId);
    } catch {
        return inspectTaskEventFileUncached(taskEventFile, taskId, options);
    }
    if (!memoized.active) {
        return inspectTaskEventFileUncached(taskEventFile, taskId, options);
    }
    if (memoized.valid && memoized.exists && memoized.value) {
        const result = cloneInspectTaskEventResult(memoized.value.result);
        return options.onIntegrityEvent
            ? deliverIntegrityEvents(result, taskEventFile, memoized.value.events, options)
            : result;
    }
    const result = inspectTaskEventFileUncached(taskEventFile, taskId, options);
    if (!memoized.valid) {
        result.status = 'FAILED';
        result.violations.push('Task timeline snapshot changed or became unavailable during this invocation.');
    }
    return result;
}

function captureIntegrityInspection(taskEventFile: string, taskId: string): TaskTimelineMemoizedRead<CapturedIntegrityInspection> {
    return memoizeTaskTimelineSnapshot(
        taskEventFile,
        INTEGRITY_INSPECTION_MEMOIZATION_KEY,
        `integrity-inspection-v3:${taskId}`,
        () => {
            const events: IntegrityEvent[] = [];
            const queries: Omit<CapturedIntegrityInspection, 'result' | 'events'> = {
                persistedQualityQuery: null,
                closedReviews: null, cadence: null, validationQueries: null,
                navigationQueries: null, routeQueries: null
            };
            const result = inspectTaskEventFileUncached(taskEventFile, taskId, {}, events, queries);
            return { result, events, ...queries };
        }
    );
}

export interface InvocationVerifiedTaskEventTimeline {
    readonly sha256: string;
    readonly result: TaskTimelineDeepReadonly<InspectTaskEventResult>;
    readonly events: TaskTimelineDeepReadonly<IntegrityEvent[]>;
}

/** Internal immutable view: no observer replay or event copy, and only within A1's lifetime. */
export function readInvocationVerifiedTaskEventTimeline(
    taskEventFile: string, taskId: string
): InvocationVerifiedTaskEventTimeline | null {
    if (!isInvocationReadObservationActive()) return null;
    if (!isTaskTimelineReadSnapshotActive(taskEventFile)) {
        return withTaskTimelineFileReadSnapshot(taskEventFile, () => (
            readInvocationVerifiedTaskEventTimeline(taskEventFile, taskId)
        ));
    }
    let captured: TaskTimelineMemoizedRead<CapturedIntegrityInspection>;
    try { captured = captureIntegrityInspection(taskEventFile, taskId); }
    catch { return null; } // Retain the existing inspector's uncached fallback and rejection behavior.
    if (!captured.valid || !captured.exists || !captured.value) return null;
    return Object.freeze({
        sha256: captureTaskTimelineReadSnapshotSha256(taskEventFile),
        result: captured.value.result,
        events: captured.value.events
    });
}


export function readTaskTimelineClosedReviewQuery(taskEventFile: string, taskId: string): TaskTimelineDeepReadonly<ClosedReviewVerifiedCapture> | null {
    if (!isTaskTimelineReadSnapshotActive(taskEventFile)) {
        return withTaskTimelineFileReadSnapshot(taskEventFile, () => readTaskTimelineClosedReviewQuery(taskEventFile, taskId));
    }
    const captured = captureIntegrityInspection(taskEventFile, taskId);
    return captured.valid && captured.exists ? captured.value?.closedReviews ?? null : null;
}


export function readTaskTimelineCadenceWindow(taskEventFile: string, taskId: string): TaskTimelineDeepReadonly<ReviewCadenceWindow> | null {
    if (!isInvocationReadObservationActive()) return null;
    if (!isTaskTimelineReadSnapshotActive(taskEventFile)) {
        return withTaskTimelineFileReadSnapshot(taskEventFile, () => readTaskTimelineCadenceWindow(taskEventFile, taskId));
    }
    try {
        const captured = captureIntegrityInspection(taskEventFile, taskId);
        return captured.valid && captured.exists && captured.value?.result.status.startsWith('PASS')
            && captured.value.cadence?.available ? captured.value.cadence : null;
    } catch { return null; } // Preserve the exact native cadence reader fallback on an unusable capture.
}


export function readTaskTimelineValidationQuery(taskEventFile: string, taskId: string,
    requireLegacyJsonLines = false): { readonly sha256: string; readonly query: TaskTimelineDeepReadonly<ValidationTimelineQuery> } | null {
    if (!isTaskTimelineReadSnapshotActive(taskEventFile)) return withTaskTimelineFileReadSnapshot(taskEventFile,
        () => readTaskTimelineValidationQuery(taskEventFile, taskId, requireLegacyJsonLines));
    let captured: TaskTimelineMemoizedRead<CapturedIntegrityInspection>;
    try { captured = captureIntegrityInspection(taskEventFile, taskId); }
    catch { return null; }
    if (!captured.valid || !captured.exists || !captured.value?.validationQueries) return null;
    if (requireLegacyJsonLines && !readTaskTimelineValidationJsonLinesCompatible(taskEventFile)) return null;
    const sha256 = captureTaskTimelineReadSnapshotSha256(taskEventFile);
    bindValidationTimelineQuery(captured.value.validationQueries, taskEventFile, sha256);
    return Object.freeze({ sha256, query: captured.value.validationQueries });
}


export function readTaskTimelineNavigationQuery(taskEventFile: string, taskId: string): NavigationTimelineQuery | null {
    if (!isInvocationReadObservationActive()) return null;
    if (!isTaskTimelineReadSnapshotActive(taskEventFile)) {
        return withTaskTimelineFileReadSnapshot(taskEventFile, () => readTaskTimelineNavigationQuery(taskEventFile, taskId));
    }
    const captured = captureIntegrityInspection(taskEventFile, taskId);
    return captured.valid && captured.exists ? captured.value?.navigationQueries ?? null : null;
}


export function readTaskTimelineRouteQuery(taskEventFile: string, taskId: string): TaskRouteQuery | null {
    if (!isInvocationReadObservationActive()) return null;
    if (!isTaskTimelineReadSnapshotActive(taskEventFile)) return withTaskTimelineFileReadSnapshot(taskEventFile,
        () => readTaskTimelineRouteQuery(taskEventFile, taskId));
    try {
        const captured = captureIntegrityInspection(taskEventFile, taskId);
        return captured.valid && captured.exists ? captured.value?.routeQueries ?? null : null;
    } catch { return null; }
}

export function readTaskTimelinePersistedQualityQuery(file: string, taskId: string): PersistedQualityTimelineQuery | null {
    if (!isInvocationReadObservationActive()) return null;
    if (!isTaskTimelineReadSnapshotActive(file)) return withTaskTimelineFileReadSnapshot(file,
        () => readTaskTimelinePersistedQualityQuery(file, taskId));
    const captured = captureIntegrityInspection(file, taskId);
    return captured.valid && captured.exists ? captured.value?.persistedQualityQuery ?? null : null;
}
