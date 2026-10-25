import * as path from 'node:path';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { withTaskTimelineFileReadSnapshot } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import { readReviewArtifactFileSha256, readReviewArtifactJsonFile } from '../../gate-runtime/review-artifacts';
import { isPathRealpathInsideRoot, joinOrchestratorPath, resolvePathInsideRepo } from '../shared/helpers';
import { normalizeReviewReceiptEvidenceFields } from './review-evidence-contract';
import { pathsEqual } from '../review-reuse/review-reuse-telemetry-normalization';
import { validateHistoricalReviewRecordedTelemetryEventMatch } from '../review-reuse/review-reuse-telemetry';

interface IntermediateGroupedReceiptSourceOptions {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    receipt: Record<string, unknown>;
    receiptPath: string;
    receiptSha256: string | null;
    sourceReceiptPath: string;
    sourceReceiptSha256: string | null;
}

function sha(value: unknown): string {
    const valueText = typeof value === 'string' ? value.toLowerCase() : '';
    return /^[0-9a-f]{64}$/u.test(valueText) ? valueText : '';
}

/** Authenticate a materialized intermediate reused receipt without granting review authority. */
export function hasAuthenticatedIntermediateGroupedReceiptSource(options: IntermediateGroupedReceiptSourceOptions): boolean {
    try {
        return authenticateIntermediateGroupedReceiptSource(options);
    } catch {
        return false;
    }
}

function authenticateIntermediateGroupedReceiptSource(options: IntermediateGroupedReceiptSourceOptions): boolean {
    const current = options.receipt;
    const sourceSha = sha(options.sourceReceiptSha256);
    const currentSha = sha(options.receiptSha256);
    const reused = current.reused_existing_review === true;
    const originalSha = reused ? sha(current.reused_from_receipt_sha256) : currentSha;
    if (!sourceSha || !currentSha || !originalSha
        || sourceSha === currentSha || sourceSha === originalSha
        || !pathsEqual(options.sourceReceiptPath, options.receiptPath)) return false;
    const timeline = joinOrchestratorPath(options.repoRoot, path.join('runtime/task-events', `${options.taskId}.jsonl`));
    return withTaskTimelineFileReadSnapshot(timeline, () => {
        const events: Readonly<Record<string, unknown>>[] = [];
        const inspection = inspectTaskEventFile(timeline, options.taskId, { onIntegrityEvent: event => events.push(event) });
        if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status)) return false;
        const matches = (event: Readonly<Record<string, unknown>>, hash: string): boolean => {
            const details = isPlainRecord(event.details) ? event.details : null;
            return event.actor === 'gate' && event.event_type === 'REVIEW_RECORDED' && event.outcome === 'PASS'
                && details?.task_id === options.taskId && details.review_type === options.reviewType
                && sha(details.receipt_sha256) === hash
                && typeof details.receipt_path === 'string' && pathsEqual(details.receipt_path, options.receiptPath);
        };
        let currentIndex = -1;
        let sourceIndex = -1;
        for (let index = events.length - 1; index >= 0; index -= 1) {
            if (currentIndex < 0 && matches(events[index], currentSha)) currentIndex = index;
            if (sourceIndex < 0 && matches(events[index], sourceSha)) sourceIndex = index;
        }
        if (sourceIndex < 0 || currentIndex < 0 || sourceIndex >= currentIndex) return false;
        for (const event of events.slice(sourceIndex + 1, currentIndex)) {
            if (event.event_type !== 'REVIEW_CYCLE_RESTARTED' || event.actor !== 'gate') continue;
            const details = isPlainRecord(event.details) ? event.details : null;
            const decision = isPlainRecord(details?.authoritative_review_decision) ? details.authoritative_review_decision : null;
            const lane = Array.isArray(decision?.lane_decisions)
                ? decision.lane_decisions.find(value => isPlainRecord(value) && value.review_type === options.reviewType) : null;
            if (!isPlainRecord(lane) || lane.invalidated === true || lane.mode !== current.review_execution_mode) return false;
        }
        const details = events[sourceIndex].details as Record<string, unknown>;
        let snapshot: unknown;
        try {
            const snapshotPath = typeof details.receipt_snapshot_path === 'string'
                ? resolvePathInsideRepo(details.receipt_snapshot_path, options.repoRoot, { allowMissing: false }) : null;
            if (!snapshotPath || !isPathRealpathInsideRoot(snapshotPath, options.repoRoot)
                || sha(details.receipt_snapshot_sha256) !== sourceSha || readReviewArtifactFileSha256(snapshotPath) !== sourceSha) return false;
            snapshot = readReviewArtifactJsonFile(snapshotPath);
        } catch { return false; }
        if (!isPlainRecord(snapshot) || snapshot.task_id !== options.taskId || snapshot.review_type !== options.reviewType
            || snapshot.reused_existing_review !== true || sha(snapshot.reused_from_receipt_sha256) !== originalSha
            || typeof snapshot.reused_from_receipt_path !== 'string'
            || !pathsEqual(snapshot.reused_from_receipt_path, reused ? String(current.reused_from_receipt_path || '') : options.receiptPath)) return false;
        const admittedDetails = events[currentIndex].details as Record<string, unknown>;
        try {
            const admittedPath = typeof admittedDetails.receipt_snapshot_path === 'string'
                ? resolvePathInsideRepo(admittedDetails.receipt_snapshot_path, options.repoRoot, { allowMissing: false }) : null;
            if (!admittedPath || !isPathRealpathInsideRoot(admittedPath, options.repoRoot)
                || sha(admittedDetails.receipt_snapshot_sha256) !== currentSha
                || readReviewArtifactFileSha256(admittedPath) !== currentSha) return false;
            if (JSON.stringify(readReviewArtifactJsonFile(admittedPath)) !== JSON.stringify(current)) return false;
        } catch { return false; }
        // Both receipts must carry the same original findings and independent review provenance.
        for (const key of ['reused_from_review_context_sha256', 'reused_from_review_context_reuse_sha256',
            'reused_from_review_tree_state_sha256', 'reused_from_review_scope_sha256', 'reused_from_code_scope_sha256',
            'review_findings_validation', 'review_findings_disposition_artifact', 'review_findings_report_sha256',
            'review_output_sha256', 'reviewer_identity', 'reviewer_provenance']) {
            const currentKey = !reused && key.startsWith('reused_from_') ? key.slice('reused_from_'.length) : key;
            if (JSON.stringify(snapshot[key] ?? null) !== JSON.stringify(current[currentKey] ?? null)) return false;
        }
        const fields = normalizeReviewReceiptEvidenceFields(snapshot);
        return validateHistoricalReviewRecordedTelemetryEventMatch({
            event: events[sourceIndex], repoRoot: options.repoRoot, taskId: options.taskId, reviewType: options.reviewType,
            receiptPath: options.receiptPath, receiptSha256: sourceSha,
            reviewContextSha256: fields.reviewContextSha256, reviewArtifactSha256: fields.reviewArtifactSha256,
            reviewerExecutionMode: fields.reviewerExecutionMode, reviewerIdentity: fields.reviewerIdentity,
            reviewerProvenance: fields.reviewerProvenance as unknown as Record<string, unknown> | null
        }).matched;
    });
}
