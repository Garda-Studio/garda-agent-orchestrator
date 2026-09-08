import * as path from 'node:path';
import { isPlainRecord } from '../../core/records';
import { readReviewArtifactFileSha256 } from '../../gate-runtime/review-artifacts';
import {
    inspectTaskEventFile,
    readTaskTimelineJsonlEntries,
    withTaskTimelineReadSnapshot
} from '../../gate-runtime/task-events';
import { isAuthenticatedReviewRestartBoundary } from '../review/review-restart-boundary';

export function reviewCorrectionWasSuperseded(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    correctionPath: string
): boolean {
    try {
        const correctionSha256 = readReviewArtifactFileSha256(correctionPath);
        if (!correctionSha256) {
            return false;
        }
        return withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
            const status = inspectTaskEventFile(timelinePath, taskId).status;
            if (status !== 'PASS' && status !== 'PASS_WITH_LEGACY_PREFIX') {
                return false;
            }
            let correctionSequence = 0;
            let superseded = false;
            for (const { record: event } of readTaskTimelineJsonlEntries(timelinePath)) {
                if (!event) {
                    continue;
                }
                const details = isPlainRecord(event.details) ? event.details : {};
                const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
                if (
                    event.event_type === 'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED'
                    && event.task_id === taskId
                    && event.actor === 'orchestrator'
                    && event.outcome === 'FAIL'
                    && details.task_id === taskId
                    && details.review_type === reviewType
                    && details.correction_package_sha256 === correctionSha256
                    && path.resolve(String(details.correction_artifact_path || '')) === path.resolve(correctionPath)
                ) {
                    correctionSequence = Number(integrity.task_sequence);
                    superseded = false;
                } else if (
                    correctionSequence > 0
                    && isAuthenticatedReviewRestartBoundary(event, taskId, reviewType, correctionSequence)
                ) {
                    superseded = true;
                }
            }
            return superseded;
        });
    } catch {
        return false;
    }
}
