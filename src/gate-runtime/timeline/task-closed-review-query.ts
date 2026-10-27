/** Compact query projection fed only inside the canonical full integrity pass. */
import { isAuthenticatedReviewRestartEvent } from '../review/review-restart-boundary';
import { createHash } from 'node:crypto';
import type { TaskEventAppendState } from './task-events-io-types';
export interface ReviewSourceIdentity { sha256: string; lineOrdinal: number; }
export type ClosedReviewSourceType = 'REVIEW_RECORDED' | 'REVIEW_CYCLE_RESTARTED' | 'COHERENT_CYCLE_RESTARTED'
    | 'PREFLIGHT_CLASSIFIED' | 'TASK_MODE_ENTERED' | 'TASK_RESET' | 'TASK_DISCARDED';
export interface ClosedReviewPublication {
    eventSha256: string; lineOrdinal: number; taskId: string; actor: 'orchestrator'; outcome: 'PASS';
    details: { schema_version: 1; event_source: 'closed-review-history'; task_id: string;
        source_event_sha256: string; source_line_ordinal: number; semantic_query_sha256: string;
        state_path: string; state_sha256: string | null; navigation_path: string; navigation_sha256: string };
}
export interface VerifiedClosedReviewQuery {
    timelineValid: boolean; taskId: string; semanticQuerySha256: string; source: ReviewSourceIdentity;
    sourceEventType: ClosedReviewSourceType; latestReview: ReviewSourceIdentity | null;
    previousReview: ReviewSourceIdentity | null; latestPublication: ClosedReviewPublication | null;
    appendState: TaskEventAppendState;
}
export interface CapturedClosedReviewEvent extends ReviewSourceIdentity { record: Readonly<Record<string, unknown>>; }
export interface ClosedReviewVerifiedCapture {
    query: VerifiedClosedReviewQuery; sourceEvent: CapturedClosedReviewEvent;
    latestRestart: CapturedClosedReviewEvent | null;
    latestTaskMode: CapturedClosedReviewEvent | null;
    currentReviews: Record<string, CapturedClosedReviewEvent>;
    /** Earlier corrections/re-records remain current until an authenticated native restart. */
    unclosedReviews: CapturedClosedReviewEvent[];
}
const relevant = new Set<ClosedReviewSourceType>(['REVIEW_RECORDED', 'REVIEW_CYCLE_RESTARTED', 'COHERENT_CYCLE_RESTARTED',
    'PREFLIGHT_CLASSIFIED', 'TASK_MODE_ENTERED', 'TASK_RESET', 'TASK_DISCARDED']);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
/** Tentative facts become available only if the complete canonical pass verifies. */
export function beginClosedReviewVerifiedPass(taskId: string) {
    const hash = createHash('sha256').update('garda.closed-review-query.v1\0');
    let sourceEvent: CapturedClosedReviewEvent | null = null, sourceType: ClosedReviewSourceType | null = null;
    let latestReview: ReviewSourceIdentity | null = null, previousReview: ReviewSourceIdentity | null = null;
    let latestRestart: CapturedClosedReviewEvent | null = null, publication: ClosedReviewPublication | null = null;
    const currentReviews: Record<string, CapturedClosedReviewEvent> = Object.create(null);
    const unclosedReviews: CapturedClosedReviewEvent[] = [];
    let latestTaskMode: CapturedClosedReviewEvent | null = null;
    let unsupported = false;
    const appendState: TaskEventAppendState = { matching_events: 0, parse_errors: 0, last_integrity_sequence: null, last_event_sha256: null };
    return {
        accept(record: Readonly<Record<string, unknown>> | null, lineOrdinal: number): void {
            if (!record) { appendState.parse_errors++; return; }
            if (String(record.task_id || '').trim() !== taskId) return;
            appendState.matching_events++;
            const integrity = isRecord(record.integrity) ? record.integrity : null;
            const nativeSha = typeof integrity?.event_sha256 === 'string' ? integrity.event_sha256.trim().toLowerCase() : '';
            if (typeof integrity?.task_sequence === 'number' && integrity.task_sequence > 0 && nativeSha) {
                appendState.last_integrity_sequence = integrity.task_sequence; appendState.last_event_sha256 = nativeSha;
            }
            const eventType = String(record.event_type || '').trim().toUpperCase();
            const details = isRecord(record.details) ? record.details : null;
            if (eventType === 'REVIEW_HISTORY_SUMMARY_PUBLISHED' && sha(nativeSha) && details) {
                publication = { eventSha256: nativeSha, lineOrdinal, taskId,
                    actor: record.actor as 'orchestrator', outcome: record.outcome as 'PASS',
                    details: details as unknown as ClosedReviewPublication['details'] };
            }
            if (!relevant.has(eventType as ClosedReviewSourceType)) return;
            const identity = sha(nativeSha) ? nativeSha : createHash('sha256').update(JSON.stringify(record)).digest('hex');
            hash.update(JSON.stringify([lineOrdinal, identity, eventType]) + '\n');
            const captured: CapturedClosedReviewEvent = { sha256: identity, lineOrdinal, record };
            sourceEvent = captured; sourceType = eventType as ClosedReviewSourceType;
            if (eventType === 'TASK_MODE_ENTERED') latestTaskMode = captured;
            if (eventType === 'REVIEW_RECORDED') {
                unclosedReviews.push(captured);
                previousReview = latestReview; latestReview = { sha256: identity, lineOrdinal };
                const lane = String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
                if (!lane) unsupported = true;
                else {
                    Object.defineProperty(currentReviews, lane, { value: captured, enumerable: true, writable: true, configurable: true });
                }
            } else if (eventType === 'REVIEW_CYCLE_RESTARTED' || eventType === 'COHERENT_CYCLE_RESTARTED') {
                latestRestart = captured;
                if (record.event_type === eventType && sha(nativeSha) && record.actor === 'orchestrator' && record.outcome === 'PASS'
                    && isAuthenticatedReviewRestartEvent(record, taskId)) unclosedReviews.length = 0;
            }
        },
        finish(verified: boolean): ClosedReviewVerifiedCapture | null {
            if (!verified || unsupported || !sourceEvent || !sourceType) return null;
            return { query: { timelineValid: true, taskId, semanticQuerySha256: hash.digest('hex'),
                source: { sha256: sourceEvent.sha256, lineOrdinal: sourceEvent.lineOrdinal }, sourceEventType: sourceType,
                latestReview, previousReview, latestPublication: publication, appendState }, sourceEvent, latestRestart, latestTaskMode, currentReviews, unclosedReviews };
        }
    };
}
