import * as path from 'node:path';

import { readJsonFile } from '../../core/json';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import type {
    ReviewRemediationReviewContract,
    ReviewRemediationReviewContractValidationAuthority
} from './review-remediation-review-contract';
import { reviewEvidenceRequiresFindingsValidation } from './review-remediation-review-contract';
import type { ReviewRemediationDecisionClassification } from './review-remediation-recovery-routing';
import { pathsEqual } from '../review-reuse/review-reuse-telemetry-normalization';
import { fileSha256 } from '../shared/helpers';
import { readRestartReviewClassification } from './review-remediation-classification-evidence';

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

function readJsonRecord(filePath: string): Readonly<Record<string, unknown>> | null {
    try {
        const value = readJsonFile(filePath);
        return isPlainRecord(value) ? value : null;
    } catch {
        return null;
    }
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
    const receipt = readJsonRecord(receiptPath);
    const reviewContext = readJsonRecord(reviewContextPath);
    if (!receipt || !reviewContext) {
        return false;
    }
    const findingsValidationRequired = reviewEvidenceRequiresFindingsValidation(receipt, reviewContext);
    const currentHashes = {
        reviewContext: fileSha256(reviewContextPath),
        receipt: fileSha256(receiptPath),
        reviewArtifact: fileSha256(reviewArtifactPath),
        findingsValidation: findingsValidationRequired
            ? fileSha256(findingsValidationArtifactPath)
            : null,
        findingsDisposition: findingsValidationRequired
            ? fileSha256(findingsDispositionArtifactPath)
            : null
    };
    if (
        !normalizeSha256(currentHashes.reviewContext)
        || !normalizeSha256(currentHashes.receipt)
        || !normalizeSha256(currentHashes.reviewArtifact)
        || (findingsValidationRequired && (
            !normalizeSha256(currentHashes.findingsValidation)
            || !normalizeSha256(currentHashes.findingsDisposition)
        ))
    ) {
        return false;
    }
    const normalizedPreflightSha256 = normalizeSha256(authorityOptions.preflightSha256);
    const normalizedDecisionSha256 = normalizeSha256(
        authorityOptions.reviewExecution.authoritative_decision_sha256
    );
    const normalizedClassificationSha256 = normalizeSha256(
        authorityOptions.reviewExecution.classification_sha256
    );
    const reviewRecordedEventsBySequence = new Map<number, Readonly<Record<string, unknown>>>();
    for (let eventIndex = options.restartIndex + 1; eventIndex < options.events.length; eventIndex += 1) {
        const event = options.events[eventIndex];
        const details = isPlainRecord(event.details) ? event.details : null;
        const acceptedSequence = taskEventSequence(event);
        if (event.event_type === 'REVIEW_RECORDED' && acceptedSequence > options.restartSequence) {
            reviewRecordedEventsBySequence.set(acceptedSequence, event);
            continue;
        }
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
        const findingsArtifactsMatch = findingsValidationRequired
            ? pathsEqual(recordedFindingsValidationPath, findingsValidationArtifactPath)
                && recordedFindingsValidationSha256
                    === normalizeSha256(currentHashes.findingsValidation)
                && pathsEqual(recordedFindingsDispositionPath, findingsDispositionArtifactPath)
                && recordedFindingsDispositionSha256
                    === normalizeSha256(currentHashes.findingsDisposition)
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
            || details.findings_validation_required !== findingsValidationRequired
            || details.review_reuse_evidence !== 'FRESH'
            || details.reused_existing_review !== false
            || details.remediation_authority_eligible !== true
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
            continue;
        }
        const reviewRecordedEvent = reviewRecordedEventsBySequence.get(reviewRecordedSequence);
        const reviewRecordedDetails = isPlainRecord(reviewRecordedEvent?.details)
            ? reviewRecordedEvent.details
            : null;
        const reviewRecordedIntegrity = isPlainRecord(reviewRecordedEvent?.integrity)
            ? reviewRecordedEvent.integrity
            : null;
        if (reviewRecordedEvent?.event_type === 'REVIEW_RECORDED'
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
            ) === currentHashes.reviewArtifact) {
            return true;
        }
    }
    return false;
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
        ) {
            continue;
        }
        const decision = details.authoritative_review_decision;
        let classification: unknown;
        try {
            classification = readRestartReviewClassification({ reviewsRoot: options.reviewsRoot, taskId: options.taskId, details });
        } catch { return null; }
        if (!isPlainRecord(classification)) continue;
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
                classification as unknown as ReviewRemediationDecisionClassification,
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
        const acceptedAfterRestart = preservedPending && hasAuthenticatedFreshCurrentPassReplacement({
            events,
            restartIndex: index,
            restartSequence: taskEventSequence(event),
            authorityOptions: options
        });
        if (!acceptedAfterRestart) {
            return null;
        }

        for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
            const priorEvent = events[priorIndex];
            const priorDetails = isPlainRecord(priorEvent.details) ? priorEvent.details : null;
            const priorDecision = isPlainRecord(priorDetails?.authoritative_review_decision)
                ? priorDetails.authoritative_review_decision
                : null;
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
                && isPlainRecord(priorLane)
                && priorLane.mode === options.reviewExecution.mode
                && normalizeSha256(priorDecision.decision_sha256)
                    === normalizeSha256(options.reviewExecution.authoritative_decision_sha256)
                && normalizeSha256(priorDecision.classification_sha256)
                    === normalizeSha256(options.reviewExecution.classification_sha256)
            ) {
                let priorClassification: unknown;
                try {
                    priorClassification = readRestartReviewClassification({
                        reviewsRoot: options.reviewsRoot, taskId: options.taskId, details: priorDetails
                    });
                } catch { return null; }
                if (!isPlainRecord(priorClassification)) return null;
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
