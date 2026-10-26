import { countNextStepWork } from '../../core/next-step-measurement';
// Extracted from review-reuse-telemetry.ts; keep behavior changes covered by facade tests.
import { normalizePath } from '../shared/helpers';
import {
    type HistoricalReviewRecordedTelemetryMatchInput,
    type ReviewReuseTelemetryEventLike,
    type ReviewReuseTelemetryMatchInput,
    type ReviewReuseTelemetryMatchResult
} from './review-reuse-telemetry-types';
import {
    getReviewReuseTelemetryDetails,
    normalizeEventSequence,
    normalizeEventType,
    normalizeLowerString,
    normalizeTaskSequence,
    optionalTestReviewCodeScopeMatches,
    isPlainRecord
} from './review-reuse-telemetry-normalization';
import {
    reviewerProvenanceMatches,
    validateHistoricalReviewRecordedReceiptSnapshot,
    validateHistoricalReviewRecordedReviewArtifactPath,
    validateHistoricalReviewRecordedSnapshotBindings
} from './review-reuse-telemetry-diagnostics';

export function validateHistoricalReviewRecordedTelemetryEventMatch(
    input: HistoricalReviewRecordedTelemetryMatchInput
): ReviewReuseTelemetryMatchResult {
    const event = input.event;
    const integrity = isPlainRecord(event?.integrity) ? event?.integrity : {};
    const taskSequence = normalizeTaskSequence(integrity);
    const eventSha256 = normalizeLowerString(integrity.event_sha256);
    const hasIntegrity = Number.isInteger(taskSequence) && !!eventSha256 && /^[0-9a-f]{64}$/.test(eventSha256);
    const base = {
        hasIntegrity,
        taskSequence,
        eventSha256: eventSha256 || null
    };
    if (!event) {
        return { ...base, matched: false, reason: 'missing_event' };
    }
    if (normalizeEventType(event.event_type) !== 'REVIEW_RECORDED') {
        return { ...base, matched: false, reason: 'wrong_event_type' };
    }
    if (!hasIntegrity) {
        return { ...base, matched: false, reason: 'missing_integrity' };
    }
    if (input.maxTaskSequenceExclusive != null && taskSequence != null && taskSequence >= input.maxTaskSequenceExclusive) {
        return { ...base, matched: false, reason: 'after_max_task_sequence' };
    }
    const eventSequence = normalizeEventSequence(event.sequence);
    if (input.maxEventSequenceExclusive != null && eventSequence != null && eventSequence >= input.maxEventSequenceExclusive) {
        return { ...base, matched: false, reason: 'after_max_event_sequence' };
    }

    const details = isPlainRecord(event.details) ? event.details : {};
    const expectedTaskId = String(input.taskId || '').trim();
    const eventTaskId = String(details.task_id ?? details.taskId ?? '').trim();
    const expectedReviewType = normalizeLowerString(input.reviewType);
    const isTestReview = expectedReviewType === 'test';
    const expectedReceiptPath = normalizePath(input.receiptPath).toLowerCase();
    const expectedReceiptSha256 = normalizeLowerString(input.receiptSha256);
    const expectedReviewContextSha256 = normalizeLowerString(input.reviewContextSha256);
    const expectedReviewContextReuseSha256 = normalizeLowerString(input.reviewContextReuseSha256);
    const expectedReviewTreeStateSha256 = normalizeLowerString(input.reviewTreeStateSha256);
    const expectedReviewScopeSha256 = normalizeLowerString(input.reviewScopeSha256);
    const expectedCodeScopeSha256 = normalizeLowerString(input.codeScopeSha256);
    const expectedReviewArtifactSha256 = normalizeLowerString(input.reviewArtifactSha256);
    const expectedExecutionMode = normalizeLowerString(input.reviewerExecutionMode);
    const expectedReviewerIdentity = String(input.reviewerIdentity || '').trim();
    const eventReviewerIdentity = String(
        details.reviewer_identity
            ?? details.reviewerIdentity
            ?? details.reviewer_session_id
            ?? details.reviewerSessionId
            ?? ''
    ).trim();
    const eventProvenance = isPlainRecord(details.reviewer_provenance ?? details.reviewerProvenance)
        ? details.reviewer_provenance ?? details.reviewerProvenance
        : null;
    const expectedProvenance = isPlainRecord(input.reviewerProvenance)
        ? input.reviewerProvenance
        : null;
    const expectedReusedFromReceiptPath = normalizePath(input.reusedFromReceiptPath || '').toLowerCase();
    const expectedReusedFromReceiptSha256 = normalizeLowerString(input.reusedFromReceiptSha256);
    const expectedReusedFromReviewContextSha256 = normalizeLowerString(input.reusedFromReviewContextSha256);
    const expectedReusedFromReviewContextReuseSha256 = normalizeLowerString(input.reusedFromReviewContextReuseSha256);
    const expectedReusedFromReviewTreeStateSha256 = normalizeLowerString(input.reusedFromReviewTreeStateSha256);
    const expectedReusedFromReviewScopeSha256 = normalizeLowerString(input.reusedFromReviewScopeSha256);
    const expectedReusedFromCodeScopeSha256 = normalizeLowerString(input.reusedFromCodeScopeSha256);

    if (
        (expectedTaskId && eventTaskId !== expectedTaskId)
        || normalizeLowerString(details.review_type ?? details.reviewType) !== expectedReviewType
        || normalizePath(details.receipt_path ?? details.receiptPath ?? '').toLowerCase() !== expectedReceiptPath
        || (input.receiptSha256 !== undefined
            && normalizeLowerString(details.receipt_sha256 ?? details.receiptSha256) !== expectedReceiptSha256)
        || normalizeLowerString(details.review_context_sha256 ?? details.reviewContextSha256) !== expectedReviewContextSha256
        || (input.reviewContextReuseSha256 !== undefined
            && normalizeLowerString(details.review_context_reuse_sha256 ?? details.reviewContextReuseSha256) !== expectedReviewContextReuseSha256)
        || (input.reviewTreeStateSha256 !== undefined
            && normalizeLowerString(details.review_tree_state_sha256 ?? details.reviewTreeStateSha256) !== expectedReviewTreeStateSha256)
        || (input.reviewScopeSha256 !== undefined
            && normalizeLowerString(details.review_scope_sha256 ?? details.reviewScopeSha256) !== expectedReviewScopeSha256)
        || (isTestReview
            ? !optionalTestReviewCodeScopeMatches(details.code_scope_sha256 ?? details.codeScopeSha256, expectedCodeScopeSha256)
            : input.codeScopeSha256 !== undefined
                && normalizeLowerString(details.code_scope_sha256 ?? details.codeScopeSha256) !== expectedCodeScopeSha256)
        || normalizeLowerString(details.review_artifact_sha256 ?? details.reviewArtifactSha256) !== expectedReviewArtifactSha256
        || (expectedReusedFromReceiptPath
            && normalizePath(details.reused_from_receipt_path ?? details.reusedFromReceiptPath ?? '').toLowerCase() !== expectedReusedFromReceiptPath)
        || (input.reusedFromReceiptSha256 !== undefined
            && normalizeLowerString(details.reused_from_receipt_sha256 ?? details.reusedFromReceiptSha256) !== expectedReusedFromReceiptSha256)
        || (expectedReusedFromReviewContextSha256
            && normalizeLowerString(details.reused_from_review_context_sha256 ?? details.reusedFromReviewContextSha256) !== expectedReusedFromReviewContextSha256)
        || (expectedReusedFromReviewContextReuseSha256
            && normalizeLowerString(details.reused_from_review_context_reuse_sha256 ?? details.reusedFromReviewContextReuseSha256) !== expectedReusedFromReviewContextReuseSha256)
        || (expectedReusedFromReviewTreeStateSha256
            && normalizeLowerString(details.reused_from_review_tree_state_sha256 ?? details.reusedFromReviewTreeStateSha256) !== expectedReusedFromReviewTreeStateSha256)
        || (input.reusedFromReviewScopeSha256 !== undefined
            && normalizeLowerString(details.reused_from_review_scope_sha256 ?? details.reusedFromReviewScopeSha256) !== expectedReusedFromReviewScopeSha256)
        || (isTestReview
            ? !optionalTestReviewCodeScopeMatches(
                details.reused_from_code_scope_sha256 ?? details.reusedFromCodeScopeSha256,
                expectedReusedFromCodeScopeSha256
            )
            : input.reusedFromCodeScopeSha256 !== undefined
                && normalizeLowerString(details.reused_from_code_scope_sha256 ?? details.reusedFromCodeScopeSha256) !== expectedReusedFromCodeScopeSha256)
        || (expectedExecutionMode && normalizeLowerString(details.reviewer_execution_mode ?? details.reviewerExecutionMode) !== expectedExecutionMode)
        || (expectedReviewerIdentity && eventReviewerIdentity !== expectedReviewerIdentity)
    ) {
        return { ...base, matched: false, reason: 'details_mismatch' };
    }
    if (expectedProvenance && !reviewerProvenanceMatches(eventProvenance, expectedProvenance)) {
        return { ...base, matched: false, reason: 'provenance_mismatch' };
    }
    if (input.verifyReceiptSnapshot === true) {
        const reviewArtifactValidation = validateHistoricalReviewRecordedReviewArtifactPath(details, input.repoRoot, {
            taskId: expectedTaskId || eventTaskId,
            reviewType: input.reviewType
        });
        if (!reviewArtifactValidation.valid) {
            return { ...base, matched: false, reason: reviewArtifactValidation.reason };
        }
        const receiptSnapshotValidation = validateHistoricalReviewRecordedReceiptSnapshot(details, input.repoRoot, {
            taskId: expectedTaskId || eventTaskId,
            reviewType: input.reviewType
        });
        if (!receiptSnapshotValidation.valid) {
            return { ...base, matched: false, reason: receiptSnapshotValidation.reason };
        }
        const snapshotBindingValidation = validateHistoricalReviewRecordedSnapshotBindings(details);
        if (!snapshotBindingValidation.valid) {
            return { ...base, matched: false, reason: snapshotBindingValidation.reason };
        }
    }
    return { ...base, matched: true, reason: null };
}

export function validateReviewReuseRecordedEventMatch(
    input: ReviewReuseTelemetryMatchInput
): ReviewReuseTelemetryMatchResult {
    const event = input.event;
    const taskSequence = normalizeTaskSequence(event?.integrity);
    const integrity = isPlainRecord(event?.integrity) ? event?.integrity : {};
    const eventSha256 = normalizeLowerString(integrity.event_sha256);
    const hasIntegrity = Number.isInteger(taskSequence) && !!eventSha256 && /^[0-9a-f]{64}$/.test(eventSha256);
    const base = {
        hasIntegrity,
        taskSequence,
        eventSha256: eventSha256 || null
    };
    if (!event) {
        return { ...base, matched: false, reason: 'missing_event' };
    }
    if (normalizeEventType(event.event_type) !== 'REVIEW_RECORDED') {
        return { ...base, matched: false, reason: 'wrong_event_type' };
    }
    if (!hasIntegrity) {
        return { ...base, matched: false, reason: 'missing_integrity' };
    }
    if (input.minTaskSequenceExclusive != null && taskSequence != null && taskSequence <= input.minTaskSequenceExclusive) {
        return { ...base, matched: false, reason: 'before_min_task_sequence' };
    }
    const eventSequence = normalizeEventSequence(event.sequence);
    if (input.minEventSequenceExclusive != null && eventSequence != null && eventSequence <= input.minEventSequenceExclusive) {
        return { ...base, matched: false, reason: 'before_min_event_sequence' };
    }

    const details = isPlainRecord(event.details) ? event.details : {};
    const actual = getReviewReuseTelemetryDetails(details);
    const expectedReviewType = normalizeLowerString(input.reviewType);
    const isTestReview = expectedReviewType === 'test';
    const expectedReceiptPath = normalizePath(input.receiptPath).toLowerCase();
    const expectedReceiptSha256 = normalizeLowerString(input.receiptSha256);
    const expectedReviewContextSha256 = normalizeLowerString(input.reviewContextSha256);
    const expectedReviewContextReuseSha256 = normalizeLowerString(input.reviewContextReuseSha256);
    const expectedReviewTreeStateSha256 = normalizeLowerString(input.reviewTreeStateSha256);
    const expectedReviewScopeSha256 = normalizeLowerString(input.reviewScopeSha256);
    const expectedCodeScopeSha256 = normalizeLowerString(input.codeScopeSha256);
    const expectedReviewArtifactSha256 = normalizeLowerString(input.reviewArtifactSha256);
    const expectedReusedFromReceiptPath = normalizePath(input.reusedFromReceiptPath || '').toLowerCase();
    const expectedReusedFromReceiptSha256 = normalizeLowerString(input.reusedFromReceiptSha256);
    const expectedReusedFromReviewContextSha256 = normalizeLowerString(input.reusedFromReviewContextSha256);
    const expectedReusedFromReviewContextReuseSha256 = normalizeLowerString(input.reusedFromReviewContextReuseSha256);
    const expectedReusedFromReviewTreeStateSha256 = normalizeLowerString(input.reusedFromReviewTreeStateSha256);
    const expectedReusedFromReviewScopeSha256 = normalizeLowerString(input.reusedFromReviewScopeSha256);
    const expectedReusedFromCodeScopeSha256 = normalizeLowerString(input.reusedFromCodeScopeSha256);

    if (
        actual.reviewType !== expectedReviewType
        || actual.reusedExistingReview !== true
        || actual.receiptPath !== expectedReceiptPath
        || (input.receiptSha256 !== undefined && actual.receiptSha256 !== expectedReceiptSha256)
        || (expectedReviewContextSha256 && actual.reviewContextSha256 !== expectedReviewContextSha256)
        || (input.reviewContextReuseSha256 !== undefined && actual.reviewContextReuseSha256 !== expectedReviewContextReuseSha256)
        || (input.reviewTreeStateSha256 !== undefined && actual.reviewTreeStateSha256 !== expectedReviewTreeStateSha256)
        || (input.reviewScopeSha256 !== undefined && actual.reviewScopeSha256 !== expectedReviewScopeSha256)
        || (isTestReview
            ? !optionalTestReviewCodeScopeMatches(details.code_scope_sha256 ?? details.codeScopeSha256, expectedCodeScopeSha256)
            : input.codeScopeSha256 !== undefined && actual.codeScopeSha256 !== expectedCodeScopeSha256)
        || (expectedReviewArtifactSha256 && actual.reviewArtifactSha256 !== expectedReviewArtifactSha256)
        || (expectedReusedFromReceiptPath && actual.reusedFromReceiptPath !== expectedReusedFromReceiptPath)
        || (input.reusedFromReceiptSha256 !== undefined && actual.reusedFromReceiptSha256 !== expectedReusedFromReceiptSha256)
        || (expectedReusedFromReviewContextSha256 && actual.reusedFromReviewContextSha256 !== expectedReusedFromReviewContextSha256)
        || (expectedReusedFromReviewContextReuseSha256 && actual.reusedFromReviewContextReuseSha256 !== expectedReusedFromReviewContextReuseSha256)
        || (expectedReusedFromReviewTreeStateSha256 && actual.reusedFromReviewTreeStateSha256 !== expectedReusedFromReviewTreeStateSha256)
        || (input.reusedFromReviewScopeSha256 !== undefined
            && actual.reusedFromReviewScopeSha256 !== expectedReusedFromReviewScopeSha256)
        || (isTestReview
            ? !optionalTestReviewCodeScopeMatches(
                details.reused_from_code_scope_sha256 ?? details.reusedFromCodeScopeSha256,
                expectedReusedFromCodeScopeSha256
            )
            : input.reusedFromCodeScopeSha256 !== undefined
                && actual.reusedFromCodeScopeSha256 !== expectedReusedFromCodeScopeSha256)
    ) {
        return { ...base, matched: false, reason: 'details_mismatch' };
    }
    return { ...base, matched: true, reason: null };
}

export function findMatchingHistoricalReviewRecordedTelemetryEvent<T extends ReviewReuseTelemetryEventLike>(
    events: readonly T[],
    options: Omit<HistoricalReviewRecordedTelemetryMatchInput, 'event'>
): T | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        countNextStepWork('visit:review-reuse-telemetry-events:event:246');
        const event = events[index];
        const taskSequence = normalizeTaskSequence(event.integrity);
        if (options.maxTaskSequenceExclusive != null && taskSequence != null && taskSequence >= options.maxTaskSequenceExclusive) {
            continue;
        }
        const eventSequence = normalizeEventSequence(event.sequence);
        if (options.maxEventSequenceExclusive != null && eventSequence != null && eventSequence >= options.maxEventSequenceExclusive) {
            continue;
        }
        if (validateHistoricalReviewRecordedTelemetryEventMatch({ ...options, event }).matched) {
            return event;
        }
    }
    return null;
}

export function findMatchingReviewReuseRecordedTelemetryEvent<T extends ReviewReuseTelemetryEventLike>(
    events: readonly T[],
    options: Omit<ReviewReuseTelemetryMatchInput, 'event'>
): T | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        countNextStepWork('visit:review-reuse-telemetry-events:event:267');
        const event = events[index];
        const eventSequence = normalizeEventSequence(event.sequence);
        if (options.minEventSequenceExclusive != null && eventSequence != null && eventSequence <= options.minEventSequenceExclusive) {
            break;
        }
        if (validateReviewReuseRecordedEventMatch({ ...options, event }).matched) {
            return event;
        }
    }
    return null;
}

