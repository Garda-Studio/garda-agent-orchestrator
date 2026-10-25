import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { withTaskTimelineFileReadSnapshot } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import type { ReviewReceipt } from '../../gate-runtime/review-context';
import type { ReviewDependencyTimelineEvent } from '../review/review-dependencies';
import { isPlainRecord } from '../../core/records';
import { joinOrchestratorPath, normalizePath, resolvePathInsideRepo } from '../shared/helpers';

export interface HistoricalGroupedReuseWindowOptions {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    receipt: Pick<ReviewReceipt, 'preflight_sha256' | 'reused_from_receipt_sha256' | 'review_execution_mode'>;
    receiptSha256: string;
    sourceEvent: ReviewDependencyTimelineEvent;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    latestCompilePassSequence: number;
}

function hash(value: unknown): string | null {
    const text = typeof value === 'string' ? value.toLowerCase() : '';
    return /^[0-9a-f]{64}$/u.test(text) ? text : null;
}

function eventHash(event: Readonly<Record<string, unknown>> | undefined): string | null {
    return hash(isPlainRecord(event?.integrity) ? event.integrity.event_sha256 : null);
}

function detailsOf(event: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> | null {
    return isPlainRecord(event?.details) ? event.details : null;
}

/** Only historical candidate validation may use this window; current-cycle gates retain their current compile boundary. */
export function resolveHistoricalGroupedReuseWindow(options: HistoricalGroupedReuseWindowOptions): {
    events: readonly ReviewDependencyTimelineEvent[];
    compileSequence: number;
} | null {
    try {
        const timelinePath = joinOrchestratorPath(options.repoRoot, `runtime/task-events/${options.taskId}.jsonl`);
        return withTaskTimelineFileReadSnapshot(timelinePath, () => resolveNativeWindow(options, timelinePath));
    } catch {
        return null;
    }
}

function resolveNativeWindow(options: HistoricalGroupedReuseWindowOptions, timelinePath: string): {
    events: readonly ReviewDependencyTimelineEvent[];
    compileSequence: number;
} | null {
    const nativeEvents: Readonly<Record<string, unknown>>[] = [];
    const inspection = inspectTaskEventFile(timelinePath, options.taskId, {
        onIntegrityEvent: event => nativeEvents.push(event)
    });
    if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status)) return null;
    const sourceHash = hash(options.sourceEvent.integrity?.event_sha256);
    const currentCompileHash = hash(options.timelineEvents.find(event => (
        event.sequence === options.latestCompilePassSequence
    ))?.integrity?.event_sha256);
    if (!sourceHash || !currentCompileHash || !hash(options.receiptSha256)) return null;
    const sourceIndex = nativeEvents.findIndex(event => eventHash(event) === sourceHash);
    const currentCompileIndex = nativeEvents.findIndex(event => eventHash(event) === currentCompileHash);
    const source = nativeEvents[sourceIndex];
    const sourceDetails = detailsOf(source);
    const currentCompile = nativeEvents[currentCompileIndex];
    if (!source || source.actor !== 'gate' || source.outcome !== 'PASS' || source.event_type !== 'REVIEW_RECORDED'
        || sourceDetails?.task_id !== options.taskId || sourceDetails.review_type !== options.reviewType
        || hash(sourceDetails.receipt_sha256) !== hash(options.receiptSha256)
        || currentCompileIndex <= sourceIndex || currentCompile?.actor !== 'gate'
        || currentCompile.event_type !== 'COMPILE_GATE_PASSED' || currentCompile.outcome !== 'PASS'
        || detailsOf(currentCompile)?.task_id !== options.taskId) return null;

    // Select the nearest compile first. An older matching compile cannot repair a foreign or failed intervening one.
    let compileIndex = sourceIndex - 1;
    while (compileIndex >= 0 && nativeEvents[compileIndex].event_type !== 'COMPILE_GATE_PASSED') compileIndex -= 1;
    const compile = nativeEvents[compileIndex];
    const compileDetails = detailsOf(compile);
    const receiptPreflightHash = hash(options.receipt.preflight_sha256);
    if (!compile || compile.actor !== 'gate' || compile.outcome !== 'PASS'
        || compileDetails?.task_id !== options.taskId || !receiptPreflightHash
        || hash(compileDetails.preflight_hash_sha256) !== receiptPreflightHash
        || hash(sourceDetails.preflight_sha256) !== receiptPreflightHash) return null;
    let preflightIndex = compileIndex - 1;
    while (preflightIndex >= 0 && nativeEvents[preflightIndex].event_type !== 'PREFLIGHT_CLASSIFIED') preflightIndex -= 1;
    const preflight = nativeEvents[preflightIndex];
    const preflightDetails = detailsOf(preflight);
    if (!preflight || preflight.actor !== 'gate' || !['INFO', 'PASS'].includes(String(preflight.outcome))
        || typeof compileDetails.preflight_path !== 'string' || typeof preflightDetails?.output_path !== 'string') return null;
    const compilePath = resolvePathInsideRepo(compileDetails.preflight_path, options.repoRoot, { allowMissing: true });
    const classifiedPath = resolvePathInsideRepo(preflightDetails.output_path, options.repoRoot, { allowMissing: true });
    if (!compilePath || !classifiedPath) return null;
    const pathKey = (value: string): string => process.platform === 'win32'
        ? normalizePath(value).toLowerCase() : normalizePath(value);
    if (pathKey(compilePath) !== pathKey(classifiedPath)) return null;
    const compileHash = eventHash(compile);
    const normalizedCompile = options.timelineEvents.find(event => hash(event.integrity?.event_sha256) === compileHash);
    if (!normalizedCompile || normalizedCompile.sequence >= options.sourceEvent.sequence) return null;

    const originalReceiptHash = hash(options.receipt.reused_from_receipt_sha256);
    if (!originalReceiptHash) return null;
    let originalIndex = compileIndex - 1;
    while (originalIndex >= 0) {
        const event = nativeEvents[originalIndex];
        const details = detailsOf(event);
        if (event.actor === 'gate' && event.event_type === 'REVIEW_RECORDED' && event.outcome === 'PASS'
            && details?.task_id === options.taskId && details.review_type === options.reviewType
            && hash(details.receipt_sha256) === originalReceiptHash) break;
        originalIndex -= 1;
    }
    if (originalIndex < 0) return null;
    for (let index = originalIndex + 1; index < nativeEvents.length; index += 1) {
        const event = nativeEvents[index];
        if (event.event_type !== 'REVIEW_CYCLE_RESTARTED' || event.actor !== 'gate') continue;
        // A newer restart requires newer review evidence even when it preserves the lane mode.
        if (index > sourceIndex) return null;
        const details = detailsOf(event);
        const decision = isPlainRecord(details?.authoritative_review_decision) ? details.authoritative_review_decision : null;
        const lane = Array.isArray(decision?.lane_decisions)
            ? decision.lane_decisions.find(value => isPlainRecord(value) && value.review_type === options.reviewType) : null;
        if (!isPlainRecord(lane) || lane.invalidated === true || lane.mode !== options.receipt.review_execution_mode) return null;
    }
    return {
        events: options.timelineEvents.filter(event => event.sequence <= options.sourceEvent.sequence),
        compileSequence: normalizedCompile.sequence
    };
}
