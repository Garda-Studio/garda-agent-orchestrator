import { normalizeBoundedJsonlTailLimits, type BoundedJsonlTailLimits } from '../../core/bounded-jsonl-tail';
import { isPlainRecord } from '../../core/records';
import { countNextStepWork } from '../../core/next-step-measurement';

export interface ReviewCadenceFacts { hasBaseline: boolean; failureCount: number; testResetPending: boolean }
export interface ReviewCadenceWindow {
    available: boolean;
    invalidJson: boolean;
    truncated: boolean;
    bytesRead: number;
    retainedLineCount: number;
    parseAttempts: number;
    ordinary: ReviewCadenceFacts;
    declaredRequired: ReviewCadenceFacts;
}
interface Row {
    ordinal: number; startByte: number;
    beforeFailures: number; beforeTests: number; failures: number; tests: number;
    ordinary: number; declared: number; unknown: number; invalid: number;
}
const EMPTY = Object.freeze({ hasBaseline: false, failureCount: 0, testResetPending: false });

/** Feed from the EXISTING verified parse loop. This class never reads/parses/replays timeline bytes. */
export class ReviewCadenceWindowAccumulator {
    private readonly limits: BoundedJsonlTailLimits;
    private readonly capacity: number;
    private readonly rows: Array<Row | undefined>;
    private count = 0;
    private lastStart = -1;
    private failures = 0;
    private tests = 0;
    private ordinary = 0;
    private declared = 0;
    private unknown = 0;
    private invalid = 0;

    constructor(limits: BoundedJsonlTailLimits,
        private readonly admittedFailure: (event: Readonly<Record<string, unknown>>) => boolean | null) {
        this.limits = normalizeBoundedJsonlTailLimits(limits);
        let capacity = 1;
        while (capacity < this.limits.maxLines) capacity *= 2;
        this.capacity = capacity;
        this.rows = new Array<Row | undefined>(capacity);
    }

    /**
     * Fused O(1) field reduction for the entry already visited by the mandatory verifier.
     * No event traversal occurs here; timeline_events accounts for that physical pass.
     * startByte comes from ORIGINAL bytes, never re-encoded text.
     */
    accept(startByte: number, record: unknown, invalidJson = false): void {
        if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte <= this.lastStart)
            throw new Error('Cadence line byte offsets must strictly increase.');
        this.lastStart = startByte;
        const ordinal = ++this.count;
        const beforeFailures = this.failures, beforeTests = this.tests;
        if (invalidJson) this.invalid = ordinal;
        else if (!isPlainRecord(record)) this.unknown = ordinal;
        else {
            const details = isPlainRecord(record.details) ? record.details : {};
            if (String(record.event_type || '') === 'QUALITY_CHECKLIST_RECORDED') {
                const status = String(details.status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
                if (status === 'PASS' || status === 'WARN') this.ordinary = this.declared = ordinal;
                else if (status === 'PENDING_VALIDATION') this.declared = ordinal;
            } else if (String(record.event_type || '') === 'REVIEW_RECORDED') {
                const failed = this.admittedFailure(record);
                if (failed === null) this.unknown = ordinal;
                else if (failed) {
                    this.failures += 1;
                    if (String(details.review_type || '').trim().toLowerCase() === 'test') this.tests += 1;
                }
            }
        }
        this.rows[(ordinal - 1) % this.capacity] = {
            ordinal, startByte, beforeFailures, beforeTests, failures: this.failures, tests: this.tests,
            ordinary: this.ordinary, declared: this.declared, unknown: this.unknown, invalid: this.invalid
        };
    }

    private at(ordinal: number): Row | undefined {
        countNextStepWork('visit:cadence_window_row');
        if (ordinal <= 0 || ordinal > this.count || ordinal <= this.count - this.capacity) return undefined;
        return this.rows[(ordinal - 1) % this.capacity];
    }

    finish(totalBytes: number, integrityAndHeadVerified: boolean): ReviewCadenceWindow {
        if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || this.lastStart >= totalBytes)
            throw new Error('Invalid cadence source byte length.');
        const oldest = Math.max(1, this.count - this.capacity + 1);
        const populated = Math.min(this.count, this.capacity);
        const bytesRead = Math.min(totalBytes, this.limits.maxBytes);
        const cutoff = totalBytes > bytesRead ? totalBytes - bytesRead : -1;
        const offset = (index: number): number => {
            countNextStepWork('visit:cadence_window_search_slot');
            return index >= populated ? Infinity : this.rows[(oldest + index - 1) % this.capacity]!.startByte;
        };
        // Fixed-capacity search: 13 narrowing probes + one boundary probe for 8192 slots.
        // The extra boundary represents the valid all-8192-lines-evicted outcome.
        let excluded = 0;
        for (let step = this.capacity / 2; step >= 1; step /= 2) {
            const candidate = excluded + step;
            if (offset(candidate) <= cutoff) excluded = candidate;
        }
        excluded = offset(0) <= cutoff ? excluded + 1 : 0;
        const firstLine = Math.max(oldest + excluded, this.count - this.limits.maxLines + 1);
        const retainedLineCount = Math.max(0, this.count - firstLine + 1);
        const budget = Math.min(this.limits.maxEvents, this.limits.maxParseAttempts);
        const firstAttempt = Math.max(firstLine, this.count - budget + 1);
        const last = this.at(this.count);
        const invalidJson = !!last && last.invalid >= firstAttempt && retainedLineCount > 0;
        const parseAttempts = invalidJson ? this.count - last!.invalid + 1 : Math.min(retainedLineCount, budget);
        const truncated = cutoff >= 0 || (totalBytes <= bytesRead && this.count > this.limits.maxLines)
            || (!invalidJson && retainedLineCount > budget);
        const first = this.at(firstAttempt);
        // Both modes perform the same bounded number of row accesses, including absent baselines.
        const ordinary = this.project(firstAttempt, first, last, this.at(last?.ordinary || 0));
        const declaredRequired = this.project(firstAttempt, first, last, this.at(last?.declared || 0));
        const unknown = !!last && last.unknown >= firstAttempt && retainedLineCount > 0;
        const available = integrityAndHeadVerified && !invalidJson && !unknown;
        return { available, invalidJson, truncated, bytesRead, retainedLineCount, parseAttempts,
            ordinary: available ? ordinary : { ...EMPTY }, declaredRequired: available ? declaredRequired : { ...EMPTY } };
    }

    private project(firstOrdinal: number, first: Row | undefined, last: Row | undefined, baseline: Row | undefined): ReviewCadenceFacts {
        if (!first || !last || firstOrdinal > this.count) return { ...EMPTY };
        const hasBaseline = !!baseline && baseline.ordinal >= firstOrdinal;
        const failuresBefore = hasBaseline ? baseline!.failures : first.beforeFailures;
        const testsBeforeBaseline = hasBaseline ? baseline!.tests - first.beforeTests : 0;
        return { hasBaseline, failureCount: last.failures - failuresBefore,
            testResetPending: last.tests > first.beforeTests && testsBeforeBaseline === 0 };
    }
}

export function selectReviewCadence(facts: ReviewCadenceFacts, interval: number) {
    return { due: !facts.hasBaseline || facts.testResetPending || facts.failureCount >= interval,
        skip: facts.hasBaseline && !facts.testResetPending && facts.failureCount > 0 && facts.failureCount < interval,
        failureCount: facts.failureCount, testResetPending: facts.testResetPending };
}
