import * as path from 'node:path';

import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import type {
    ReviewRemediationReviewContract,
    ReviewRemediationReviewContractValidationAuthority
} from './review-remediation-review-contract';
import type { ReviewRemediationDecisionClassification } from './review-remediation-recovery-routing';
import { pathsEqual } from '../review-reuse/review-reuse-telemetry-normalization';
import { fileSha256 } from '../shared/helpers';

interface PersistedRemediationReviewExecutionAuthorityOptions {
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    preflightSha256: string;
    preflightPath?: string;
    fullReviewScope: readonly string[];
    reviewExecution: ReviewRemediationReviewContract;
    reviewContextPath?: string;
    receiptPath?: string;
}

function normalizeSha256(value: unknown): string {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : '';
}

function taskEventSequence(event: Readonly<Record<string, unknown>>): number {
    const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
    const sequence = Number(integrity?.task_sequence);
    return Number.isInteger(sequence) && sequence > 0 ? sequence : 0;
}

function hasAuthenticatedFreshCurrentPassReplacement(options: {
    events: readonly Readonly<Record<string, unknown>>[];
    restartIndex: number;
    restartSequence: number;
    authorityOptions: PersistedRemediationReviewExecutionAuthorityOptions;
}): boolean {
    const authorityOptions = options.authorityOptions;
    const reviewContextPath = authorityOptions.reviewContextPath || '';
    const receiptPath = authorityOptions.receiptPath || '';
    const preflightPath = authorityOptions.preflightPath || '';
    if (!reviewContextPath || !receiptPath || !preflightPath || !/-receipt\.json$/u.test(receiptPath)) {
        return false;
    }
    const reviewArtifactPath = receiptPath.replace(/-receipt\.json$/u, '.md');
    const findingsValidationArtifactPath = reviewArtifactPath.replace(/\.md$/u, '-findings-validation.json');
    const findingsDispositionArtifactPath = reviewArtifactPath.replace(/\.md$/u, '-findings-disposition.json');
    const currentHashes = {
        reviewContext: fileSha256(reviewContextPath),
        receipt: fileSha256(receiptPath),
        reviewArtifact: fileSha256(reviewArtifactPath)
    };
    if (Object.values(currentHashes).some((value) => !normalizeSha256(value))) {
        return false;
    }
    const normalizedPreflightSha256 = normalizeSha256(authorityOptions.preflightSha256);
    const normalizedDecisionSha256 = normalizeSha256(
        authorityOptions.reviewExecution.authoritative_decision_sha256
    );
    const normalizedClassificationSha256 = normalizeSha256(
        authorityOptions.reviewExecution.classification_sha256
    );
    return options.events.slice(options.restartIndex + 1).some((event) => {
        const details = isPlainRecord(event.details) ? event.details : null;
        const acceptedSequence = taskEventSequence(event);
        const reviewRecordedSequence = Number(details?.review_recorded_sequence);
        const reviewRecordedEventSha256 = normalizeSha256(details?.review_recorded_event_sha256);
        const recordedFindingsValidationPath = String(details?.findings_validation_artifact_path || '');
        const recordedFindingsValidationSha256 = normalizeSha256(
            details?.findings_validation_artifact_sha256
        );
        const recordedFindingsDispositionPath = String(details?.findings_disposition_artifact_path || '');
        const recordedFindingsDispositionSha256 = normalizeSha256(
            details?.findings_disposition_artifact_sha256
        );
        const hasFindingsArtifacts = Boolean(
            recordedFindingsValidationPath
            || recordedFindingsValidationSha256
            || recordedFindingsDispositionPath
            || recordedFindingsDispositionSha256
        );
        const findingsArtifactsMatch = hasFindingsArtifacts
            ? pathsEqual(recordedFindingsValidationPath, findingsValidationArtifactPath)
                && recordedFindingsValidationSha256
                    === normalizeSha256(fileSha256(findingsValidationArtifactPath))
                && pathsEqual(recordedFindingsDispositionPath, findingsDispositionArtifactPath)
                && recordedFindingsDispositionSha256
                    === normalizeSha256(fileSha256(findingsDispositionArtifactPath))
            : !recordedFindingsValidationPath
                && !recordedFindingsValidationSha256
                && !recordedFindingsDispositionPath
                && !recordedFindingsDispositionSha256;
        if (
            event.event_type !== 'REVIEW_CONTEXT_REUSE_ACCEPTED'
            || event.actor !== 'gate'
            || event.outcome !== 'PASS'
            || !details
            || acceptedSequence <= options.restartSequence
            || !Number.isInteger(reviewRecordedSequence)
            || reviewRecordedSequence <= options.restartSequence
            || reviewRecordedSequence >= acceptedSequence
            || !reviewRecordedEventSha256
            || details.current_pass_review_evidence !== true
            || details.review_reuse_evidence !== 'FRESH'
            || details.reused_existing_review !== false
            || details.review_type !== authorityOptions.reviewType
            || details.remediation_mode !== authorityOptions.reviewExecution.mode
            || normalizeSha256(details.remediation_authoritative_decision_sha256) !== normalizedDecisionSha256
            || normalizeSha256(details.remediation_classification_sha256) !== normalizedClassificationSha256
            || !pathsEqual(String(details.preflight_path || ''), preflightPath)
            || normalizeSha256(details.preflight_sha256) !== normalizedPreflightSha256
            || !pathsEqual(String(details.review_context_path || details.output_path || ''), reviewContextPath)
            || normalizeSha256(details.review_context_sha256) !== currentHashes.reviewContext
            || !pathsEqual(String(details.receipt_path || ''), receiptPath)
            || normalizeSha256(details.receipt_sha256) !== currentHashes.receipt
            || !pathsEqual(String(details.review_artifact_path || ''), reviewArtifactPath)
            || normalizeSha256(details.review_artifact_sha256) !== currentHashes.reviewArtifact
            || !findingsArtifactsMatch
        ) {
            return false;
        }
        const reviewRecordedEvent = options.events.find((candidate) => (
            taskEventSequence(candidate) === reviewRecordedSequence
        ));
        const reviewRecordedDetails = isPlainRecord(reviewRecordedEvent?.details)
            ? reviewRecordedEvent.details
            : null;
        const reviewRecordedIntegrity = isPlainRecord(reviewRecordedEvent?.integrity)
            ? reviewRecordedEvent.integrity
            : null;
        return reviewRecordedEvent?.event_type === 'REVIEW_RECORDED'
            && reviewRecordedEvent.actor === 'gate'
            && reviewRecordedEvent.outcome === 'PASS'
            && normalizeSha256(reviewRecordedIntegrity?.event_sha256) === reviewRecordedEventSha256
            && reviewRecordedDetails?.review_type === authorityOptions.reviewType
            && normalizeSha256(reviewRecordedDetails.preflight_sha256) === normalizedPreflightSha256
            && pathsEqual(String(reviewRecordedDetails.review_context_path || ''), reviewContextPath)
            && normalizeSha256(reviewRecordedDetails.review_context_sha256) === currentHashes.reviewContext
            && pathsEqual(String(reviewRecordedDetails.receipt_path || ''), receiptPath)
            && normalizeSha256(reviewRecordedDetails.receipt_sha256) === currentHashes.receipt
            && pathsEqual(String(reviewRecordedDetails.review_artifact_path || ''), reviewArtifactPath)
            && normalizeSha256(
                reviewRecordedDetails.review_artifact_sha256
                || reviewRecordedDetails.review_artifact_snapshot_sha256
            ) === currentHashes.reviewArtifact;
    });
}

function buildAuthority(
    options: PersistedRemediationReviewExecutionAuthorityOptions,
    decision: Record<string, unknown>,
    classification: ReviewRemediationDecisionClassification,
    acceptedCurrentPassReplacement = false
): ReviewRemediationReviewContractValidationAuthority {
    const decisionSha256 = normalizeSha256(decision.decision_sha256);
    return {
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: options.preflightSha256.trim().toLowerCase(),
        mode: options.reviewExecution.mode,
        fullReviewScope: options.fullReviewScope,
        persistedDecisionSha256: decisionSha256,
        authoritativeDecisionSha256: decisionSha256,
        authoritativeClassificationSha256: normalizeSha256(decision.classification_sha256),
        authoritativeDecision: decision as unknown as ReviewRemediationReviewContractValidationAuthority['authoritativeDecision'],
        authoritativeClassification: classification,
        acceptedCurrentPassReplacement
    };
}

export function resolvePersistedRemediationReviewExecutionAuthority(
    options: PersistedRemediationReviewExecutionAuthorityOptions
): ReviewRemediationReviewContractValidationAuthority | null {
    if (options.reviewExecution.source === 'initial_full') {
        return null;
    }
    const timelinePath = path.join(
        path.dirname(options.reviewsRoot),
        'task-events',
        `${options.taskId}.jsonl`
    );
    const events: Readonly<Record<string, unknown>>[] = [];
    const inspection = inspectTaskEventFile(timelinePath, options.taskId, {
        onIntegrityEvent: (event) => events.push(event)
    });
    if (!inspection.status.startsWith('PASS')) {
        return null;
    }
    const normalizedPreflightSha256 = options.preflightSha256.trim().toLowerCase();
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const details = isPlainRecord(event.details) ? event.details : null;
        if (
            event.event_type !== 'REVIEW_CYCLE_RESTARTED'
            || !details
            || details.task_id !== options.taskId
            || details.event_type !== 'REVIEW_CYCLE_RESTARTED'
            || details.status !== 'PASSED'
            || String(details.preflight_sha256 || '').trim().toLowerCase() !== normalizedPreflightSha256
            || !isPlainRecord(details.authoritative_review_decision)
            || !isPlainRecord(details.authoritative_review_classification)
        ) {
            continue;
        }
        const decision = details.authoritative_review_decision;
        const classification = details.authoritative_review_classification as unknown as ReviewRemediationDecisionClassification;
        const lane = Array.isArray(decision.lane_decisions)
            ? decision.lane_decisions.find((value) => (
                isPlainRecord(value) && value.review_type === options.reviewType
            ))
            : null;
        if (!isPlainRecord(lane) || lane.mode !== options.reviewExecution.mode
            || decision.preflight_sha256 !== normalizedPreflightSha256) {
            return null;
        }
        if (
            normalizeSha256(options.reviewExecution.authoritative_decision_sha256)
                === normalizeSha256(decision.decision_sha256)
            && normalizeSha256(options.reviewExecution.classification_sha256)
                === normalizeSha256(decision.classification_sha256)
        ) {
            return buildAuthority(
                options,
                decision,
                classification,
                hasAuthenticatedFreshCurrentPassReplacement({
                    events,
                    restartIndex: index,
                    restartSequence: taskEventSequence(event),
                    authorityOptions: options
                })
            );
        }

        const preservedPending = lane.mode === 'FULL'
            && lane.reuse_eligible === true
            && lane.invalidated === false
            && lane.satisfied === false
            && lane.reason_code === 'authoritative_reuse_pending';
        const reviewContextSha256 = options.reviewContextPath ? fileSha256(options.reviewContextPath) : null;
        const receiptSha256 = options.receiptPath ? fileSha256(options.receiptPath) : null;
        const acceptedAfterRestart = preservedPending && reviewContextSha256 && receiptSha256
            ? events.slice(index + 1).some((candidate) => {
                const accepted = isPlainRecord(candidate.details) ? candidate.details : null;
                return candidate.event_type === 'REVIEW_CONTEXT_REUSE_ACCEPTED'
                    && candidate.actor === 'gate'
                    && candidate.outcome === 'PASS'
                    && accepted?.current_pass_review_evidence === true
                    && accepted.review_type === options.reviewType
                    && pathsEqual(String(accepted.preflight_path || ''), options.preflightPath || '')
                    && normalizeSha256(accepted.preflight_sha256) === normalizedPreflightSha256
                    && pathsEqual(
                        String(accepted.review_context_path || accepted.output_path || ''),
                        options.reviewContextPath || ''
                    )
                    && normalizeSha256(accepted.review_context_sha256) === reviewContextSha256
                    && pathsEqual(String(accepted.receipt_path || ''), options.receiptPath || '')
                    && normalizeSha256(accepted.receipt_sha256) === receiptSha256;
            })
            : false;
        if (!acceptedAfterRestart) {
            return null;
        }

        for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
            const priorEvent = events[priorIndex];
            const priorDetails = isPlainRecord(priorEvent.details) ? priorEvent.details : null;
            const priorDecision = isPlainRecord(priorDetails?.authoritative_review_decision)
                ? priorDetails.authoritative_review_decision
                : null;
            const priorClassification = priorDetails?.authoritative_review_classification;
            const priorLane = priorDecision && Array.isArray(priorDecision.lane_decisions)
                ? priorDecision.lane_decisions.find((value) => (
                    isPlainRecord(value) && value.review_type === options.reviewType
                ))
                : null;
            if (
                priorEvent.event_type === 'REVIEW_CYCLE_RESTARTED'
                && priorDetails?.task_id === options.taskId
                && priorDetails.event_type === 'REVIEW_CYCLE_RESTARTED'
                && priorDetails.status === 'PASSED'
                && normalizeSha256(priorDetails.preflight_sha256) === normalizedPreflightSha256
                && priorDecision
                && isPlainRecord(priorClassification)
                && isPlainRecord(priorLane)
                && priorLane.mode === options.reviewExecution.mode
                && normalizeSha256(priorDecision.decision_sha256)
                    === normalizeSha256(options.reviewExecution.authoritative_decision_sha256)
                && normalizeSha256(priorDecision.classification_sha256)
                    === normalizeSha256(options.reviewExecution.classification_sha256)
            ) {
                return buildAuthority(
                    options,
                    priorDecision,
                    priorClassification as unknown as ReviewRemediationDecisionClassification
                );
            }
        }
        return null;
    }
    return null;
}
