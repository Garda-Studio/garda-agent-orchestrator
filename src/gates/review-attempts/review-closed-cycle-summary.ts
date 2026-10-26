/** Producing-gate reducer. Never load this cumulative state during navigation. */
import { evaluateReviewCycleGuard, type ReviewCycleGuardConfig } from '../../core/review-cycle-guard';
import { getReviewLaneScopeSha256, type DomainScopeFingerprints } from '../scope/domain-scope-fingerprints';
import { buildReviewCycleAttemptDiagnostics, extendReviewCycleGuardEvaluation } from '../next-step/next-step-review-cycle-guard-diagnostics';
import type { NextStepReviewCycleLatestFailedReview, ReviewCycleGuardReadAttempt,
    ReviewCycleGuardReadEvaluationResult } from '../next-step/next-step-review-cycle-guard-types';

export const CLOSED_REVIEW_SUMMARY_SCHEMA = 1;
export const CLOSED_REVIEW_REDUCER_VERSION = 'guard-attempts-v1';

/** Made only after the existing report/receipt/validation validators have run. */
export interface ValidatedReviewOutcome {
    reviewType: string;
    reviewerIdentity: string;
    reviewContextSha256: string;
    eventSha256: string;
    /** Original zero-based non-empty JSONL line ordinal, NOT integrity.task_sequence. */
    lineOrdinal: number;
    failed: boolean;
    passed: boolean;
    reused: boolean;
    /** Exact getReviewCycleAttemptScopeHash result after domain/fallback resolution. */
    scopeHash: string | null;
    latestFailedDisplay: NextStepReviewCycleLatestFailedReview;
    /** Separate semantic fact: cadence Markdown/status rule is not guard failure. */
    cadenceFailed: boolean;
}
interface CumulativeAttempt {
    reviewType: string;
    failed: boolean;
    passed: boolean;
    latestEventFailed: boolean;
    reused: boolean;
    firstScopeHash: string | null;
    seenScopeHashes: string[];
    sawUnknownScope: boolean;
    lastSequence: number;
}
export interface ClosedReviewProducerState {
    schema_version: 1;
    reducer_version: typeof CLOSED_REVIEW_REDUCER_VERSION;
    task_id: string;
    /** Includes all attempts; authenticated restart MUST NOT clear this map. */
    attempts: Record<string, CumulativeAttempt>;
    /** First failure transitions per dedupe key, retaining latest candidate per lane. */
    latestFailureTransitionByLane: Record<string, NextStepReviewCycleLatestFailedReview>;
    lastReviewLineOrdinal: number;
    lastReviewEventSha256: string | null;
}

export function createClosedReviewProducerState(taskId: string): ClosedReviewProducerState {
    return { schema_version: CLOSED_REVIEW_SUMMARY_SCHEMA, reducer_version: CLOSED_REVIEW_REDUCER_VERSION,
        task_id: taskId, attempts: {}, latestFailureTransitionByLane: {},
        lastReviewLineOrdinal: -1, lastReviewEventSha256: null };
}
function own<T>(record: Record<string, T>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
function put<T>(record: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Mutable producer-private working copy; caller authenticates state and serializes once. */
export function appendValidatedReviewOutcome(state: ClosedReviewProducerState, fact: ValidatedReviewOutcome): void {
    if (!fact.reviewType || !Number.isSafeInteger(fact.lineOrdinal) || fact.lineOrdinal < 0
        || !/^[a-f0-9]{64}$/u.test(fact.eventSha256) || (fact.failed && fact.passed))
        throw new Error('Invalid validated review outcome.');
    if (fact.lineOrdinal === state.lastReviewLineOrdinal && fact.eventSha256 === state.lastReviewEventSha256) return;
    if (fact.lineOrdinal <= state.lastReviewLineOrdinal) throw new Error('Review outcome would replay or reorder the prefix.');
    const key = fact.reviewerIdentity && fact.reviewContextSha256
        ? `${fact.reviewType}|${fact.reviewerIdentity}|${fact.reviewContextSha256}`
        : `REVIEW_RECORDED:${fact.lineOrdinal}`;
    const previous = own(state.attempts, key);
    const failed = Boolean(previous?.failed || fact.failed);
    const hashes = previous?.seenScopeHashes ?? [];
    if (fact.scopeHash && !hashes.includes(fact.scopeHash)) hashes.push(fact.scopeHash);
    put(state.attempts, key, {
        reviewType: fact.reviewType,
        failed,
        passed: !failed && Boolean(previous?.passed || fact.passed),
        latestEventFailed: fact.failed,
        reused: previous ? previous.reused && fact.reused : fact.reused,
        firstScopeHash: previous?.firstScopeHash || fact.scopeHash,
        seenScopeHashes: hashes,
        sawUnknownScope: Boolean(previous?.sawUnknownScope || !fact.scopeHash),
        lastSequence: fact.lineOrdinal
    });
    // Exactly the old condition: use THIS EVENT's reused bit, not the merged bit.
    if (!previous?.failed && failed && !fact.reused)
        put(state.latestFailureTransitionByLane, fact.reviewType, { ...fact.latestFailedDisplay });
    state.lastReviewLineOrdinal = fact.lineOrdinal;
    state.lastReviewEventSha256 = fact.eventSha256;
}

/** Gate-only projection. Its input may grow; its navigation result is bounded by lanes/top-five. */
export function projectClosedReviewGuard(state: ClosedReviewProducerState, config: ReviewCycleGuardConfig,
    currentFingerprints: DomainScopeFingerprints | null): ReviewCycleGuardReadEvaluationResult {
    if (!config.enabled) {
        const empty = evaluateReviewCycleGuard(config, { attempts: [], timelineValid: true });
        return { evaluation: extendReviewCycleGuardEvaluation(empty, empty,
            buildReviewCycleAttemptDiagnostics([], config.excluded_review_types), false), latestFailedReview: null };
    }
    const attempts: ReviewCycleGuardReadAttempt[] = Object.values(state.attempts).map(attempt => {
        const expected = getReviewLaneScopeSha256(attempt.reviewType, currentFingerprints);
        return { reviewType: attempt.reviewType, failed: attempt.failed, passed: attempt.passed,
            latestEventFailed: attempt.latestEventFailed, reused: attempt.reused,
            scopeHash: attempt.firstScopeHash,
            currentScope: !expected || attempt.sawUnknownScope || attempt.seenScopeHashes.includes(expected),
            lastSequence: attempt.lastSequence };
    }).sort((a, b) => a.lastSequence - b.lastSequence);
    const all = evaluateReviewCycleGuard(config, { attempts, timelineValid: true });
    const current = evaluateReviewCycleGuard(config, { attempts: attempts.filter(attempt => attempt.currentScope), timelineValid: true });
    const diagnostics = buildReviewCycleAttemptDiagnostics(attempts, config.excluded_review_types);
    const excluded = new Set(config.excluded_review_types.map(value => value.trim().toLowerCase()).filter(Boolean));
    const failures = Object.entries(state.latestFailureTransitionByLane).filter(([lane]) => !excluded.has(lane))
        .map(([, failure]) => failure).sort((a, b) => a.sequence - b.sequence);
    return { evaluation: extendReviewCycleGuardEvaluation(all, current, diagnostics,
        all.violations.length > 0 || current.violations.length > 0), latestFailedReview: failures.at(-1) ?? null };
}

export interface ClosedReviewNavigationBinding {
    task_id: string;
    repo_realpath: string;
    git_directory_realpath: string;
    producer_bundle_sha256: string;
    producer_policy_sha256: string;
    task_mode_sha256: string;
    preflight_sha256: string;
    preflight_domain_fingerprints_sha256: string;
    normalized_guard_config_sha256: string;
    /** Null before first restart; never inferred from a filename or event order alone. */
    authenticated_restart_event_sha256: string | null;
    covered_review_event_sha256: string | null;
    covered_review_line_ordinal: number;
    /** Latest verified query-head identity, independent of irrelevant later events. */
    semantic_query_sha256: string;
}
export interface ClosedReviewNavigationSummary {
    schema_version: 1;
    reducer_version: typeof CLOSED_REVIEW_REDUCER_VERSION;
    binding: ClosedReviewNavigationBinding;
    result: ReviewCycleGuardReadEvaluationResult;
    /** Current-cycle commitments only, authenticated again by navigation. */
    current_review_commitments: Array<{ event_sha256: string; review_type: string;
        details: Record<string, unknown> }>;
}
