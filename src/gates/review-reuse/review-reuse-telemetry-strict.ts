// Extracted from review-reuse-telemetry.ts; keep behavior changes covered by facade tests.
import * as path from 'node:path';
import {
    buildReviewVerdictTokenSet,
    extractReviewVerdictSectionTokenMatch
} from '../../gate-runtime/review-context';
import {
    readReviewArtifactFileSha256,
    readReviewArtifactTextFile
} from '../../gate-runtime/review-artifacts';
import {
    normalizeReviewFindingsValidationReceiptReference,
    validateReviewFindingsValidationArtifactForReceipt
} from '../review/review-findings-validation-artifact';
import {
    resolveLockedReviewFindingPolicyFromReceiptDisposition,
    reviewFindingsValidationArtifactHasBlockingFindings
} from '../review/review-finding-disposition';
import { joinOrchestratorPath, normalizePath } from '../shared/helpers';
import {
    type ReviewReuseTelemetryMatchResult,
    type StrictEventEvidence,
    type StrictReusedReviewEvidenceValidationInput,
    type StrictReusedReviewEvidenceValidationResult
} from './review-reuse-telemetry-types';
import {
    validateHistoricalReviewRecordedTelemetryEventMatch,
    validateReviewReuseRecordedEventMatch
} from './review-reuse-telemetry-events';
import {
    reviewerProvenanceMatches,
    validateHistoricalReviewRecordedReceiptSnapshot,
    validateHistoricalReviewRecordedReviewArtifactPath,
    validateHistoricalReviewRecordedRuntimeReviewPath,
    validateHistoricalReviewRecordedSnapshotBindings
} from './review-reuse-telemetry-diagnostics';
import {
    getReviewPassVerdict,
    isPlainRecord,
    isSha256,
    normalizeArtifactSegment,
    normalizeEventSequence,
    normalizeEventType,
    normalizeLowerString,
    normalizeTaskSequence,
    optionalTestReviewCodeScopeMatches
} from './review-reuse-telemetry-normalization';

export function validateStrictReusedReviewEvidence(
    input: StrictReusedReviewEvidenceValidationInput
): StrictReusedReviewEvidenceValidationResult {
    const inputError = validateStrictReusedReviewInput(input);
    if (inputError) {
        return { valid: false, reason: inputError };
    }
    const currentReceiptSha256 = resolveStrictCurrentReceiptSha256(input);
    if (!currentReceiptSha256.valid) {
        return { valid: false, reason: currentReceiptSha256.reason };
    }
    const currentReviewArtifactSha256 = resolveStrictCurrentReviewArtifactSha256(input);
    if (!currentReviewArtifactSha256.valid) {
        return { valid: false, reason: currentReviewArtifactSha256.reason };
    }
    const normalizedInput = {
        ...input,
        receiptSha256: currentReceiptSha256.sha256,
        reviewArtifactSha256: currentReviewArtifactSha256.sha256
    };
    const currentReuseEvent = findStrictCurrentReuseRecordedEvent(normalizedInput);
    if (!currentReuseEvent.valid) {
        return currentReuseEvent;
    }
    const historicalReviewRecordedEvent = findStrictHistoricalReviewRecordedSourceEvent(normalizedInput);
    if (!historicalReviewRecordedEvent.valid) {
        return historicalReviewRecordedEvent;
    }
    const historicalReviewerInvocationEvent = findStrictHistoricalReviewerInvocationEvent(normalizedInput);
    if (!historicalReviewerInvocationEvent.valid) {
        return historicalReviewerInvocationEvent;
    }
    return {
        valid: true,
        reason: null,
        currentReuseEventTaskSequence: currentReuseEvent.taskSequence,
        currentReuseEventSha256: currentReuseEvent.eventSha256,
        historicalReviewRecordedTaskSequence: historicalReviewRecordedEvent.taskSequence,
        historicalReviewRecordedEventSha256: historicalReviewRecordedEvent.eventSha256,
        historicalReviewRecordedDetails: historicalReviewRecordedEvent.details,
        historicalReviewerInvocationTaskSequence: historicalReviewerInvocationEvent.taskSequence,
        historicalReviewerInvocationEventSha256: historicalReviewerInvocationEvent.eventSha256
    };
}

function validateStrictReusedReviewInput(input: StrictReusedReviewEvidenceValidationInput): string | null {
    const requiredShaFields: Array<[unknown, string]> = [
        [input.reviewContextSha256, 'current review_context_sha256'],
        [input.reviewContextReuseSha256, 'current review_context_reuse_sha256'],
        [input.reviewTreeStateSha256, 'current review_tree_state_sha256'],
        [input.reviewScopeSha256, 'current review_scope_sha256'],
        [input.reviewArtifactSha256, 'current review_artifact_sha256'],
        [input.reusedFromReceiptSha256, 'historical reused_from_receipt_sha256'],
        [input.reusedFromReviewContextSha256, 'historical reused_from_review_context_sha256'],
        [input.reusedFromReviewContextReuseSha256, 'historical reused_from_review_context_reuse_sha256'],
        [input.reusedFromReviewTreeStateSha256, 'historical reused_from_review_tree_state_sha256'],
        [input.reusedFromReviewScopeSha256, 'historical reused_from_review_scope_sha256']
    ];
    if (normalizeLowerString(input.reviewType) !== 'test') {
        requiredShaFields.push(
            [input.codeScopeSha256, 'current code_scope_sha256'],
            [input.reusedFromCodeScopeSha256, 'historical reused_from_code_scope_sha256']
        );
    }
    for (const [value, label] of requiredShaFields) {
        if (!isSha256(value)) {
            return `strict reused review evidence is missing ${label}`;
        }
    }
    if (input.receiptSha256 !== undefined && input.receiptSha256 !== null && !isSha256(input.receiptSha256)) {
        return 'strict reused review evidence has invalid current receipt_sha256';
    }
    if (
        normalizeLowerString(input.reviewType) !== 'test'
        && input.codeScopeSha256 !== undefined
        && input.codeScopeSha256 !== null
        && !isSha256(input.codeScopeSha256)
    ) {
        return 'strict reused review evidence has invalid current code_scope_sha256';
    }
    if (
        normalizeLowerString(input.reviewType) !== 'test'
        && input.reusedFromCodeScopeSha256 !== undefined
        && input.reusedFromCodeScopeSha256 !== null
        && !isSha256(input.reusedFromCodeScopeSha256)
    ) {
        return 'strict reused review evidence has invalid historical reused_from_code_scope_sha256';
    }
    if (!String(input.receiptPath || '').trim()) {
        return 'strict reused review evidence is missing current receipt_path';
    }
    if (!String(input.reusedFromReceiptPath || '').trim()) {
        return 'strict reused review evidence is missing historical reused_from_receipt_path';
    }
    if (normalizeLowerString(input.reviewerExecutionMode) !== 'delegated_subagent') {
        return 'strict reused review evidence requires delegated_subagent reviewer execution mode';
    }
    const reviewerIdentity = String(input.reviewerIdentity || '').trim();
    if (!reviewerIdentity || !reviewerIdentity.startsWith('agent:')) {
        return 'strict reused review evidence requires delegated reviewer identity';
    }
    const provenance = isPlainRecord(input.reviewerProvenance) ? input.reviewerProvenance : null;
    if (!provenance) {
        return 'strict reused review evidence is missing preserved reviewer_provenance';
    }
    const provenanceReviewContextSha256 = normalizeLowerString(provenance.review_context_sha256);
    if (
        normalizeLowerString(provenance.attestation_type) !== 'reviewer_invocation_attestation'
        || normalizeEventType(provenance.controller_event_type) !== 'REVIEWER_INVOCATION_ATTESTED'
        || String(provenance.task_id || '').trim() !== String(input.taskId || '').trim()
        || normalizeLowerString(provenance.review_type) !== normalizeLowerString(input.reviewType)
        || normalizeLowerString(provenance.reviewer_execution_mode) !== 'delegated_subagent'
        || String(provenance.reviewer_identity || '').trim() !== reviewerIdentity
        || !isSha256(provenanceReviewContextSha256)
        || normalizeLowerString(provenance.review_tree_state_sha256) !== normalizeLowerString(input.reusedFromReviewTreeStateSha256)
        || !isSha256(provenance.routing_event_sha256)
        || !isSha256(provenance.event_sha256)
        || !Number.isInteger(normalizeEventSequence(provenance.task_sequence))
    ) {
        return 'strict reused review evidence reviewer_provenance does not bind to the historical delegated invocation';
    }
    return null;
}

function resolveStrictCurrentReceiptSha256(
    input: StrictReusedReviewEvidenceValidationInput
): { valid: true; sha256: string } | { valid: false; reason: string } {
    const taskId = normalizeArtifactSegment(input.taskId);
    const reviewType = normalizeArtifactSegment(input.reviewType).toLowerCase();
    const pathValidation = validateHistoricalReviewRecordedRuntimeReviewPath({
        repoRoot: input.repoRoot,
        rawPath: input.receiptPath,
        taskId,
        reviewType,
        expectedFileName: `${taskId}-${reviewType}-receipt.json`,
        artifactLabel: 'current reused review receipt',
        missingReason: 'current_receipt_path'
    });
    if (!pathValidation.valid) {
        return { valid: false, reason: pathValidation.message };
    }
    const actualSha256 = normalizeLowerString(readReviewArtifactFileSha256(pathValidation.resolvedPath));
    if (!isSha256(actualSha256)) {
        return { valid: false, reason: 'current reused review receipt hash is unavailable' };
    }
    const expectedSha256 = normalizeLowerString(input.receiptSha256);
    if (expectedSha256 && expectedSha256 !== actualSha256) {
        return {
            valid: false,
            reason: `current reused review receipt hash no longer matches telemetry (expected=${expectedSha256}, current=${actualSha256})`
        };
    }
    return { valid: true, sha256: actualSha256 };
}

function resolveStrictCurrentReviewArtifactSha256(
    input: StrictReusedReviewEvidenceValidationInput
): { valid: true; sha256: string } | { valid: false; reason: string } {
    const taskId = normalizeArtifactSegment(input.taskId);
    const reviewType = normalizeArtifactSegment(input.reviewType).toLowerCase();
    const artifactPath = joinOrchestratorPath(input.repoRoot, path.join('runtime', 'reviews', `${taskId}-${reviewType}.md`));
    const pathValidation = validateHistoricalReviewRecordedRuntimeReviewPath({
        repoRoot: input.repoRoot,
        rawPath: artifactPath,
        taskId,
        reviewType,
        expectedFileName: `${taskId}-${reviewType}.md`,
        artifactLabel: 'current reused review artifact',
        missingReason: 'current_review_artifact_path'
    });
    if (!pathValidation.valid) {
        return { valid: false, reason: pathValidation.message };
    }
    const actualSha256 = normalizeLowerString(readReviewArtifactFileSha256(pathValidation.resolvedPath));
    if (!isSha256(actualSha256)) {
        return { valid: false, reason: 'current reused review artifact hash is unavailable' };
    }
    const expectedSha256 = normalizeLowerString(input.reviewArtifactSha256);
    if (expectedSha256 && expectedSha256 !== actualSha256) {
        return {
            valid: false,
            reason: `current reused review artifact hash no longer matches telemetry (expected=${expectedSha256}, current=${actualSha256})`
        };
    }
    return { valid: true, sha256: actualSha256 };
}

function findStrictCurrentReuseRecordedEvent(input: StrictReusedReviewEvidenceValidationInput): StrictEventEvidence {
    let lastReason: string | null = null;
    for (let index = input.events.length - 1; index >= 0; index -= 1) {
        const event = input.events[index];
        if (
            normalizeEventType(event.event_type) === 'REVIEW_RECORDED'
            && normalizeLowerString(event.outcome) !== 'pass'
        ) {
            lastReason = 'non_pass_outcome';
            continue;
        }
        const match = validateReviewReuseRecordedEventMatch({
            event,
            reviewType: input.reviewType,
            receiptPath: input.receiptPath,
            receiptSha256: input.receiptSha256,
            reviewContextSha256: input.reviewContextSha256,
            reviewContextReuseSha256: input.reviewContextReuseSha256,
            reviewTreeStateSha256: input.reviewTreeStateSha256,
            reviewScopeSha256: input.reviewScopeSha256,
            codeScopeSha256: input.codeScopeSha256,
            reviewArtifactSha256: input.reviewArtifactSha256,
            reusedFromReceiptPath: input.reusedFromReceiptPath,
            reusedFromReceiptSha256: input.reusedFromReceiptSha256,
            reusedFromReviewContextSha256: input.reusedFromReviewContextSha256,
            reusedFromReviewContextReuseSha256: input.reusedFromReviewContextReuseSha256,
            reusedFromReviewTreeStateSha256: input.reusedFromReviewTreeStateSha256,
            reusedFromReviewScopeSha256: input.reusedFromReviewScopeSha256,
            reusedFromCodeScopeSha256: input.reusedFromCodeScopeSha256,
            minTaskSequenceExclusive: input.latestCompileTaskSequence,
            minEventSequenceExclusive: input.latestCompileEventSequence
        });
        if (!match.matched) {
            if (match.reason === 'before_min_task_sequence' || match.reason === 'before_min_event_sequence') {
                break;
            }
            if (match.reason && match.reason !== 'wrong_event_type') {
                lastReason = match.reason;
            }
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const snapshotBindingValidation = validateHistoricalReviewRecordedSnapshotBindings(details);
        if (!snapshotBindingValidation.valid) {
            return {
                valid: false,
                reason: `current-cycle REVIEW_RECORDED reuse telemetry has invalid snapshot bindings (${snapshotBindingValidation.reason})`
            };
        }
        const receiptSnapshotValidation = validateHistoricalReviewRecordedReceiptSnapshot(details, input.repoRoot, {
            taskId: input.taskId,
            reviewType: input.reviewType
        });
        if (!receiptSnapshotValidation.valid) {
            return {
                valid: false,
                reason: `current-cycle REVIEW_RECORDED reuse telemetry has invalid receipt snapshot (${receiptSnapshotValidation.reason})`
            };
        }
        const reviewArtifactValidation = validateHistoricalReviewRecordedReviewArtifactPath(details, input.repoRoot, {
            taskId: input.taskId,
            reviewType: input.reviewType
        });
        if (!reviewArtifactValidation.valid) {
            return {
                valid: false,
                reason: `current-cycle REVIEW_RECORDED reuse telemetry has invalid review artifact snapshot (${reviewArtifactValidation.reason})`
            };
        }
        return strictEventEvidenceFromMatch(match, 'current-cycle REVIEW_RECORDED reuse telemetry has invalid integrity');
    }
    return {
        valid: false,
        reason: `current-cycle REVIEW_RECORDED reuse telemetry is missing or does not match reused receipt evidence${lastReason ? ` (${lastReason})` : ''}`
    };
}

function findStrictHistoricalReviewRecordedSourceEvent(
    input: StrictReusedReviewEvidenceValidationInput
): StrictEventEvidence & ({ valid: true; details: Record<string, unknown> } | { valid: false }) {
    let lastReason: string | null = null;
    for (let index = input.events.length - 1; index >= 0; index -= 1) {
        const event = input.events[index];
        if (normalizeEventType(event.event_type) !== 'REVIEW_RECORDED') {
            continue;
        }
        if (normalizeLowerString(event.outcome) !== 'pass') {
            lastReason = 'non_pass_outcome';
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        if (!strictHistoricalRecordedEventCanRepresentSource(details, input)) {
            continue;
        }
        const sourceIsReusedReview = details.reused_existing_review === true;
        const match = validateHistoricalReviewRecordedTelemetryEventMatch({
            event,
            repoRoot: input.repoRoot,
            taskId: input.taskId,
            reviewType: input.reviewType,
            receiptPath: input.reusedFromReceiptPath || '',
            receiptSha256: input.reusedFromReceiptSha256,
            reviewContextSha256: details.review_context_sha256 as string | null,
            reviewContextReuseSha256: details.review_context_reuse_sha256 as string | null,
            reviewTreeStateSha256: details.review_tree_state_sha256 as string | null,
            reviewScopeSha256: details.review_scope_sha256 as string | null,
            codeScopeSha256: details.code_scope_sha256 as string | null,
            reviewArtifactSha256: input.reviewArtifactSha256,
            reusedFromReceiptPath: sourceIsReusedReview ? input.reusedFromReceiptPath : undefined,
            reusedFromReceiptSha256: sourceIsReusedReview ? input.reusedFromReceiptSha256 : undefined,
            reusedFromReviewContextSha256: sourceIsReusedReview ? input.reusedFromReviewContextSha256 : undefined,
            reusedFromReviewContextReuseSha256: sourceIsReusedReview ? input.reusedFromReviewContextReuseSha256 : undefined,
            reusedFromReviewTreeStateSha256: sourceIsReusedReview ? input.reusedFromReviewTreeStateSha256 : undefined,
            reusedFromReviewScopeSha256: sourceIsReusedReview ? input.reusedFromReviewScopeSha256 : undefined,
            reusedFromCodeScopeSha256: sourceIsReusedReview ? input.reusedFromCodeScopeSha256 : undefined,
            reviewerExecutionMode: input.reviewerExecutionMode,
            reviewerIdentity: input.reviewerIdentity,
            reviewerProvenance: input.reviewerProvenance,
            maxTaskSequenceExclusive: input.latestCompileTaskSequence,
            maxEventSequenceExclusive: input.latestCompileEventSequence,
            verifyReceiptSnapshot: true
        });
        if (!match.matched) {
            if (match.reason && match.reason !== 'wrong_event_type') {
                lastReason = match.reason;
            }
            continue;
        }
        const strictDetailsError = validateStrictReviewRecordedDetails(details, input, 'historical REVIEW_RECORDED source telemetry');
        if (strictDetailsError) {
            return { valid: false, reason: strictDetailsError };
        }
        const evidence = strictEventEvidenceFromMatch(match, 'historical REVIEW_RECORDED source telemetry has invalid integrity');
        return evidence.valid
            ? { ...evidence, details }
            : evidence;
    }
    return {
        valid: false,
        reason: `historical REVIEW_RECORDED telemetry source is missing or does not match reused receipt evidence${lastReason ? ` (${lastReason})` : ''}`
    };
}

function strictHistoricalRecordedEventCanRepresentSource(
    details: Record<string, unknown>,
    input: StrictReusedReviewEvidenceValidationInput
): boolean {
    const receiptPath = normalizePath(details.receipt_path ?? details.receiptPath ?? '').toLowerCase();
    const isTestReview = normalizeLowerString(input.reviewType) === 'test';
    if (
        String(details.task_id ?? details.taskId ?? '').trim() !== String(input.taskId || '').trim()
        || normalizeLowerString(details.review_type ?? details.reviewType) !== normalizeLowerString(input.reviewType)
        || receiptPath !== normalizePath(input.reusedFromReceiptPath || '').toLowerCase()
        || normalizeLowerString(details.receipt_sha256 ?? details.receiptSha256) !== normalizeLowerString(input.reusedFromReceiptSha256)
        || normalizeLowerString(details.review_artifact_sha256 ?? details.reviewArtifactSha256) !== normalizeLowerString(input.reviewArtifactSha256)
    ) {
        return false;
    }
    if (details.reused_existing_review === true) {
        return normalizeLowerString(details.reused_from_receipt_path ?? details.reusedFromReceiptPath)
                === normalizeLowerString(input.reusedFromReceiptPath)
            && normalizeLowerString(details.reused_from_receipt_sha256 ?? details.reusedFromReceiptSha256)
                === normalizeLowerString(input.reusedFromReceiptSha256)
            && normalizeLowerString(details.reused_from_review_context_sha256 ?? details.reusedFromReviewContextSha256)
                === normalizeLowerString(input.reusedFromReviewContextSha256)
            && normalizeLowerString(details.reused_from_review_context_reuse_sha256 ?? details.reusedFromReviewContextReuseSha256)
                === normalizeLowerString(input.reusedFromReviewContextReuseSha256)
            && normalizeLowerString(details.reused_from_review_tree_state_sha256 ?? details.reusedFromReviewTreeStateSha256)
                === normalizeLowerString(input.reusedFromReviewTreeStateSha256)
            && normalizeLowerString(details.reused_from_review_scope_sha256 ?? details.reusedFromReviewScopeSha256)
                === normalizeLowerString(input.reusedFromReviewScopeSha256)
            && (
                isTestReview
                    ? optionalTestReviewCodeScopeMatches(
                        details.reused_from_code_scope_sha256 ?? details.reusedFromCodeScopeSha256,
                        input.reusedFromCodeScopeSha256
                    )
                    : normalizeLowerString(details.reused_from_code_scope_sha256 ?? details.reusedFromCodeScopeSha256)
                    === normalizeLowerString(input.reusedFromCodeScopeSha256)
            );
    }
    return normalizeLowerString(details.review_context_sha256 ?? details.reviewContextSha256)
            === normalizeLowerString(input.reusedFromReviewContextSha256)
        && normalizeLowerString(details.review_context_reuse_sha256 ?? details.reviewContextReuseSha256)
            === normalizeLowerString(input.reusedFromReviewContextReuseSha256)
        && normalizeLowerString(details.review_tree_state_sha256 ?? details.reviewTreeStateSha256)
            === normalizeLowerString(input.reusedFromReviewTreeStateSha256)
        && normalizeLowerString(details.review_scope_sha256 ?? details.reviewScopeSha256)
            === normalizeLowerString(input.reusedFromReviewScopeSha256)
        && (
            isTestReview
                ? optionalTestReviewCodeScopeMatches(
                    details.code_scope_sha256 ?? details.codeScopeSha256,
                    input.reusedFromCodeScopeSha256
                )
                : normalizeLowerString(details.code_scope_sha256 ?? details.codeScopeSha256)
                === normalizeLowerString(input.reusedFromCodeScopeSha256)
        );
}

function findStrictHistoricalReviewerInvocationEvent(input: StrictReusedReviewEvidenceValidationInput): StrictEventEvidence {
    const provenance = isPlainRecord(input.reviewerProvenance) ? input.reviewerProvenance : {};
    const expectedTaskSequence = normalizeEventSequence(provenance.task_sequence);
    const expectedEventSha256 = normalizeLowerString(provenance.event_sha256);
    const expectedPrevEventSha256 = normalizeLowerString(provenance.prev_event_sha256) || null;
    const expectedInvocationContextSha256 = normalizeLowerString(provenance.review_context_sha256);
    for (let index = input.events.length - 1; index >= 0; index -= 1) {
        const event = input.events[index];
        if (normalizeEventType(event.event_type) !== 'REVIEWER_INVOCATION_ATTESTED') {
            continue;
        }
        const taskSequence = normalizeTaskSequence(event.integrity);
        const eventSha256 = normalizeLowerString(isPlainRecord(event.integrity) ? event.integrity.event_sha256 : null);
        const prevEventSha256 = normalizeLowerString(isPlainRecord(event.integrity) ? event.integrity.prev_event_sha256 : null) || null;
        if (
            input.latestCompileTaskSequence != null
            && taskSequence != null
            && taskSequence >= input.latestCompileTaskSequence
        ) {
            continue;
        }
        const eventSequence = normalizeEventSequence(event.sequence);
        if (
            input.latestCompileEventSequence != null
            && eventSequence != null
            && eventSequence >= input.latestCompileEventSequence
        ) {
            continue;
        }
        if (
            taskSequence !== expectedTaskSequence
            || eventSha256 !== expectedEventSha256
            || prevEventSha256 !== expectedPrevEventSha256
        ) {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const detailsReviewerIdentity = String(
            details.reviewer_identity
                ?? details.reviewerIdentity
                ?? details.reviewer_session_id
                ?? details.reviewerSessionId
                ?? ''
        ).trim();
        if (
            String(details.task_id ?? details.taskId ?? '').trim() !== String(input.taskId || '').trim()
            || normalizeLowerString(details.review_type ?? details.reviewType) !== normalizeLowerString(input.reviewType)
            || normalizeLowerString(details.reviewer_execution_mode ?? details.reviewerExecutionMode) !== 'delegated_subagent'
            || detailsReviewerIdentity !== String(input.reviewerIdentity || '').trim()
            || normalizeLowerString(details.review_context_sha256 ?? details.reviewContextSha256)
                !== expectedInvocationContextSha256
            || normalizeLowerString(details.review_tree_state_sha256 ?? details.reviewTreeStateSha256)
                !== normalizeLowerString(input.reusedFromReviewTreeStateSha256)
            || normalizeLowerString(details.routing_event_sha256 ?? details.routingEventSha256)
                !== normalizeLowerString(provenance.routing_event_sha256)
        ) {
            continue;
        }
        if (taskSequence == null || !eventSha256) {
            return { valid: false, reason: 'historical REVIEWER_INVOCATION_ATTESTED telemetry has invalid integrity' };
        }
        return { valid: true, taskSequence, eventSha256 };
    }
    return {
        valid: false,
        reason: 'historical REVIEWER_INVOCATION_ATTESTED telemetry is missing or does not match preserved reviewer_provenance'
    };
}

function validateStrictReviewRecordedDetails(
    details: Record<string, unknown>,
    input: StrictReusedReviewEvidenceValidationInput,
    label: string
): string | null {
    const pathError = validateReviewRecordedCanonicalPaths(details, input, label);
    if (pathError) {
        return pathError;
    }
    const snapshotError = validateReviewRecordedSnapshots(details, input, label);
    if (snapshotError) {
        return snapshotError;
    }
    const reviewerError = validateReviewRecordedReviewerBinding(details, input, label);
    if (reviewerError) {
        return reviewerError;
    }
    const verdictError = validateReviewRecordedPassVerdict(details, input, label);
    if (verdictError) {
        return verdictError;
    }
    return null;
}

function validateReviewRecordedCanonicalPaths(
    details: Record<string, unknown>,
    input: StrictReusedReviewEvidenceValidationInput,
    label: string
): string | null {
    const taskId = String(input.taskId || '').trim();
    const reviewType = normalizeLowerString(input.reviewType);
    const receiptPathValidation = validateHistoricalReviewRecordedRuntimeReviewPath({
        repoRoot: input.repoRoot,
        rawPath: details.receipt_path ?? details.receiptPath,
        taskId,
        reviewType,
        expectedFileName: `${taskId}-${reviewType}-receipt.json`,
        artifactLabel: `${label} receipt`,
        missingReason: 'receipt_path'
    });
    if (!receiptPathValidation.valid) {
        return `${label}: ${receiptPathValidation.message}`;
    }
    const reviewArtifactPathValidation = validateHistoricalReviewRecordedRuntimeReviewPath({
        repoRoot: input.repoRoot,
        rawPath: details.review_artifact_path ?? details.reviewArtifactPath,
        taskId,
        reviewType,
        expectedFileName: `${taskId}-${reviewType}.md`,
        artifactLabel: `${label} review artifact`,
        missingReason: 'review_artifact_path'
    });
    if (!reviewArtifactPathValidation.valid) {
        return `${label}: ${reviewArtifactPathValidation.message}`;
    }
    return null;
}

function validateReviewRecordedSnapshots(
    details: Record<string, unknown>,
    input: StrictReusedReviewEvidenceValidationInput,
    label: string
): string | null {
    const identity = { taskId: input.taskId, reviewType: input.reviewType };
    const artifactValidation = validateHistoricalReviewRecordedReviewArtifactPath(details, input.repoRoot, identity);
    if (!artifactValidation.valid) {
        return `${label}: ${artifactValidation.message}`;
    }
    const receiptValidation = validateHistoricalReviewRecordedReceiptSnapshot(details, input.repoRoot, identity);
    if (!receiptValidation.valid) {
        return `${label}: ${receiptValidation.message}`;
    }
    return null;
}

function validateReviewRecordedReviewerBinding(
    details: Record<string, unknown>,
    input: StrictReusedReviewEvidenceValidationInput,
    label: string
): string | null {
    const reviewerIdentity = String(
        details.reviewer_identity
            ?? details.reviewerIdentity
            ?? details.reviewer_session_id
            ?? details.reviewerSessionId
            ?? ''
    ).trim();
    if (
        normalizeLowerString(details.reviewer_execution_mode ?? details.reviewerExecutionMode) !== 'delegated_subagent'
        || reviewerIdentity !== String(input.reviewerIdentity || '').trim()
    ) {
        return `${label}: reviewer identity or execution mode does not match reused receipt`;
    }
    const eventProvenance = isPlainRecord(details.reviewer_provenance ?? details.reviewerProvenance)
        ? details.reviewer_provenance ?? details.reviewerProvenance
        : null;
    if (!isPlainRecord(input.reviewerProvenance) || !reviewerProvenanceMatches(eventProvenance, input.reviewerProvenance)) {
        return `${label}: reviewer_provenance does not match preserved historical invocation provenance`;
    }
    return null;
}

function validateReviewRecordedPassVerdict(
    details: Record<string, unknown>,
    input: StrictReusedReviewEvidenceValidationInput,
    label: string
): string | null {
    const artifactValidation = validateHistoricalReviewRecordedReviewArtifactPath(
        details,
        input.repoRoot,
        { taskId: input.taskId, reviewType: input.reviewType }
    );
    if (!artifactValidation.valid) {
        return `${label}: ${artifactValidation.message}`;
    }
    const outputContractCandidate = details.review_output_contract ?? details.reviewOutputContract;
    const outputContract: Record<string, unknown> | null = isPlainRecord(outputContractCandidate)
        ? outputContractCandidate as Record<string, unknown>
        : null;
    const outputFormat = String(
        details.review_output_format
        ?? details.reviewOutputFormat
        ?? outputContract?.format
        ?? ''
    ).trim().toLowerCase();
    const validationReference = normalizeReviewFindingsValidationReceiptReference(
        details.review_findings_validation ?? details.reviewFindingsValidation
    );
    if (outputFormat === 'findings_json' || validationReference) {
        const reusedExistingReview = details.reused_existing_review === true || details.reusedExistingReview === true;
        const sourceReviewArtifactPath = String(
            details.review_artifact_path
            ?? details.reviewArtifactPath
            ?? ''
        ).trim();
        if (!sourceReviewArtifactPath) {
            return `${label}: findings JSON review artifact path is missing from REVIEW_RECORDED telemetry`;
        }
        const getString = (key: string, alias?: string): string | null => {
            const value = details[key] ?? (alias ? details[alias] : undefined);
            return typeof value === 'string' && value.trim() ? value.trim() : null;
        };
        const getContractString = (key: string): string | null => {
            const value = outputContract?.[key];
            return typeof value === 'string' && value.trim() ? value.trim() : null;
        };
        const validation = validateReviewFindingsValidationArtifactForReceipt({
            receipt: details,
            reviewArtifactPath: sourceReviewArtifactPath,
            expectedTaskId: input.taskId,
            expectedReviewType: input.reviewType,
            expectedReviewOutputSha256: getString('review_output_sha256', 'reviewOutputSha256')
                || getContractString('raw_output_sha256'),
            expectedReviewArtifactSha256: artifactValidation.expectedSha256,
            expectedReviewContextSha256: reusedExistingReview
                ? getString('reused_from_review_context_sha256', 'reusedFromReviewContextSha256')
                : getString('review_context_sha256', 'reviewContextSha256'),
            expectedPreflightSha256: reusedExistingReview
                ? null
                : getString('preflight_sha256', 'preflightSha256'),
            expectedScopeSha256: reusedExistingReview
                ? null
                : getString('scope_sha256', 'scopeSha256'),
            expectedReviewScopeSha256: reusedExistingReview
                ? getString('reused_from_review_scope_sha256', 'reusedFromReviewScopeSha256')
                : getString('review_scope_sha256', 'reviewScopeSha256'),
            expectedCodeScopeSha256: reusedExistingReview
                ? getString('reused_from_code_scope_sha256', 'reusedFromCodeScopeSha256')
                : getString('code_scope_sha256', 'codeScopeSha256'),
            expectedReviewTreeStateSha256: reusedExistingReview
                ? getString('reused_from_review_tree_state_sha256', 'reusedFromReviewTreeStateSha256')
                : getString('review_tree_state_sha256', 'reviewTreeStateSha256'),
            expectedCoverageContractSha256: getContractString('coverage_contract_sha256'),
            requireAccepted: true,
            preferSnapshot: true
        });
        if (!validation.valid) {
            return `${label}: findings validation artifact is invalid: ${validation.violations.join(' ')}`;
        }
        if (reviewFindingsValidationArtifactHasBlockingFindings(
            validation.artifact,
            resolveLockedReviewFindingPolicyFromReceiptDisposition(details)
        )) {
            return `${label}: findings validation artifact contains policy-blocking active findings or residual risks`;
        }
        return null;
    }
    const artifactText = readReviewArtifactTextFile(artifactValidation.resolvedPath);
    const verdict = extractReviewVerdictSectionTokenMatch(
        artifactText,
        buildReviewVerdictTokenSet(input.reviewType, getReviewPassVerdict(input.reviewType))
    );
    if (verdict?.outcome !== 'pass') {
        return `${label}: review artifact snapshot does not contain a PASS verdict`;
    }
    return null;
}

function strictEventEvidenceFromMatch(match: ReviewReuseTelemetryMatchResult, reason: string): StrictEventEvidence {
    if (match.taskSequence == null || !match.eventSha256) {
        return { valid: false, reason };
    }
    return {
        valid: true,
        taskSequence: match.taskSequence,
        eventSha256: match.eventSha256
    };
}
