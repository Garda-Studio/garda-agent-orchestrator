import * as path from 'node:path';

import { assertCanonicalTaskId } from '../../core/task-ids';
import {
    assertTaskTimelineJsonlAppendWithinLimits,
    buildEventIntegrityHash,
    TASK_EVENT_INTEGRITY_SCHEMA_VERSION
} from './task-events-helpers';
import { readTaskEventAppendReadiness, refreshTaskEventAppendIndexAfterAppend } from './task-events-io-index';
import {
    appendTaskTimelineLineSync,
    assertTaskTimelinePathMatchesTaskId,
    captureTaskTimelineAppendAuthority,
    isTaskTimelineReadSnapshotActive,
    withTaskTimelineReadSnapshot
} from './task-timeline-read-snapshot';
import type { TaskEvent, TaskEventAppendState } from './task-events-io-types';

function sleepMsAsync(milliseconds: number): Promise<void> {
    if (!milliseconds || milliseconds <= 0) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

function assignEventIntegrity(event: TaskEvent, matchingEvents: number, previousSequence: number | null, previousHash: string | null): void {
    const nextSequence = typeof previousSequence === 'number'
        ? previousSequence + 1
        : matchingEvents + 1;

    event.integrity = {
        schema_version: TASK_EVENT_INTEGRITY_SCHEMA_VERSION,
        task_sequence: nextSequence,
        prev_event_sha256: previousHash
    };

    const eventSha256 = buildEventIntegrityHash({ ...event });
    if (eventSha256 == null) {
        throw new Error('Failed to build event integrity hash.');
    }

    event.integrity.event_sha256 = eventSha256;
}

export function toPositiveInteger(value: unknown, fallback: number): number {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function assertTaskEventPayloadMatchesTaskId(event: TaskEvent, taskId: string): void {
    const eventTaskId = assertCanonicalTaskId(event.task_id);
    if (eventTaskId !== taskId) {
        throw new Error(
            `Task event payload task_id '${eventTaskId}' does not match canonical task ID '${taskId}'.`
        );
    }
}

function validateCanonicalAppendSynchronously(validate?: () => void): void {
    const result: unknown = validate?.();
    if (result != null
        && (typeof result === 'object' || typeof result === 'function')
        && typeof (result as { then?: unknown }).then === 'function') {
        // Reject async validation before publication while observing any later rejection.
        void Promise.resolve(result).catch(() => undefined);
        throw new Error('Canonical append validator must complete synchronously; promise-returning validators are unsupported.');
    }
}

function assertExpectedPreviousState(
    actual: TaskEventAppendState,
    expected: TaskEventAppendState | undefined
): void {
    if (!expected) {
        return;
    }
    const matches = actual.matching_events === expected.matching_events
        && actual.parse_errors === expected.parse_errors
        && actual.last_integrity_sequence === expected.last_integrity_sequence
        && actual.last_event_sha256 === expected.last_event_sha256;
    if (!matches) {
        throw new Error(
            'Task timeline changed before conditional append: '
            + `expected_events=${expected.matching_events}; actual_events=${actual.matching_events}; `
            + `expected_sequence=${expected.last_integrity_sequence ?? 'none'}; `
            + `actual_sequence=${actual.last_integrity_sequence ?? 'none'}; `
            + `expected_hash=${expected.last_event_sha256 ?? 'none'}; `
            + `actual_hash=${actual.last_event_sha256 ?? 'none'}; `
            + `expected_parse_errors=${expected.parse_errors}; actual_parse_errors=${actual.parse_errors}.`
        );
    }
}

export function appendTaskEventLineSync(
    taskFilePath: string,
    taskId: string,
    event: TaskEvent,
    emitOnce: boolean,
    onCanonicalAppend?: () => void,
    expectedPreviousState?: TaskEventAppendState,
    validateBeforeCanonicalAppend?: () => void
): string | null {
    const safeTaskId = assertTaskTimelinePathMatchesTaskId(taskFilePath, taskId);
    assertTaskEventPayloadMatchesTaskId(event, safeTaskId);
    if (!isTaskTimelineReadSnapshotActive(taskFilePath)) {
        return withTaskTimelineReadSnapshot(path.dirname(taskFilePath), safeTaskId, () => (
            appendTaskEventLineSync(
                taskFilePath,
                safeTaskId,
                event,
                emitOnce,
                onCanonicalAppend,
                expectedPreviousState,
                validateBeforeCanonicalAppend
            )
        ));
    }
    const appendAuthority = captureTaskTimelineAppendAuthority(taskFilePath);
    const readiness = readTaskEventAppendReadiness(taskFilePath, safeTaskId, event.event_type, emitOnce);
    if (readiness.duplicate) {
        return null;
    }
    assertExpectedPreviousState(readiness.state, expectedPreviousState);

    const appendState = readiness.state;
    assignEventIntegrity(
        event,
        appendState.matching_events,
        appendState.last_integrity_sequence,
        appendState.last_event_sha256
    );

    const serializedLine = JSON.stringify(event);
    assertTaskTimelineJsonlAppendWithinLimits(taskFilePath, serializedLine);
    validateCanonicalAppendSynchronously(validateBeforeCanonicalAppend);
    appendTaskTimelineLineSync(taskFilePath, serializedLine, appendAuthority);
    onCanonicalAppend?.();
    refreshTaskEventAppendIndexAfterAppend(taskFilePath, safeTaskId, event);
    return serializedLine;
}

export async function appendTaskEventLineAsync(
    taskFilePath: string,
    taskId: string,
    event: TaskEvent,
    preWriteDelayMs: number,
    emitOnce: boolean,
    onCanonicalAppend?: () => void,
    expectedPreviousState?: TaskEventAppendState,
    validateBeforeCanonicalAppend?: () => void
): Promise<string | null> {
    const safeTaskId = assertTaskTimelinePathMatchesTaskId(taskFilePath, taskId);
    assertTaskEventPayloadMatchesTaskId(event, safeTaskId);
    if (!isTaskTimelineReadSnapshotActive(taskFilePath)) {
        return withTaskTimelineReadSnapshot(path.dirname(taskFilePath), safeTaskId, () => (
            appendTaskEventLineAsync(
                taskFilePath,
                safeTaskId,
                event,
                preWriteDelayMs,
                emitOnce,
                onCanonicalAppend,
                expectedPreviousState,
                validateBeforeCanonicalAppend
            )
        ));
    }
    const appendAuthority = captureTaskTimelineAppendAuthority(taskFilePath);
    const readiness = readTaskEventAppendReadiness(taskFilePath, safeTaskId, event.event_type, emitOnce);
    if (readiness.duplicate) {
        return null;
    }
    assertExpectedPreviousState(readiness.state, expectedPreviousState);

    const appendState = readiness.state;
    assignEventIntegrity(
        event,
        appendState.matching_events,
        appendState.last_integrity_sequence,
        appendState.last_event_sha256
    );

    const serializedLine = JSON.stringify(event);
    assertTaskTimelineJsonlAppendWithinLimits(taskFilePath, serializedLine);
    if (preWriteDelayMs > 0) {
        await sleepMsAsync(preWriteDelayMs);
    }
    validateCanonicalAppendSynchronously(validateBeforeCanonicalAppend);
    appendTaskTimelineLineSync(taskFilePath, serializedLine, appendAuthority);
    onCanonicalAppend?.();
    refreshTaskEventAppendIndexAfterAppend(taskFilePath, safeTaskId, event);
    return serializedLine;
}
