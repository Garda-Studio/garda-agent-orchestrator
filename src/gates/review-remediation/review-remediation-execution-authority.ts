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

function buildAuthority(
    options: PersistedRemediationReviewExecutionAuthorityOptions,
    decision: Record<string, unknown>,
    classification: ReviewRemediationDecisionClassification
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
        authoritativeClassification: classification
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
            return buildAuthority(options, decision, classification);
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
