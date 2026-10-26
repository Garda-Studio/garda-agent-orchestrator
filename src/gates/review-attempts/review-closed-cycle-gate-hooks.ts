import { countNextStepWork } from '../../core/next-step-measurement';
import { prepareClosedReviewCurrentIndex } from './review-closed-cycle-capture';
import type { AppendTaskEventResult } from '../../gate-runtime/task-events';
import { closedReviewDigest } from './review-closed-cycle-auth';
import { publishClosedReviewHistory, type PublishClosedReviewInput, type VerifiedClosedReviewQuery } from './review-closed-cycle-storage';
import type { ClosedReviewNavigationBinding } from './review-closed-cycle-summary';
import type { ReviewCycleGuardConfig } from '../../core/review-cycle-guard';
import type { DomainScopeFingerprints } from '../scope/domain-scope-fingerprints';

/** Capture actual source bytes, not parsed/reformatted task-mode or preflight JSON.
 * Missing bytes are domain-separated from an empty file. Inputs originate in the
 * native gate, with a final assertInputsCurrent closure over these exact observations.
 */
export function makeClosedReviewBinding(input: {
    taskId: string; repoRealpath: string; gitDirectoryRealpath: string;
    producerBundleSha256: string; producerPolicySha256: string;
    taskModeBytes: Buffer | null; preflightBytes: Buffer | null;
    config: ReviewCycleGuardConfig; fingerprints: DomainScopeFingerprints | null;
    restartEventSha256: string | null; query: VerifiedClosedReviewQuery;
}): ClosedReviewNavigationBinding {
    const sourceBytes = (bytes: Buffer | null): string => closedReviewDigest(bytes === null
        ? Buffer.from('garda.review-history.missing.v1')
        : Buffer.concat([Buffer.from('garda.review-history.bytes.v1\0'), bytes]));
    return { task_id: input.taskId, repo_realpath: input.repoRealpath, git_directory_realpath: input.gitDirectoryRealpath,
        producer_bundle_sha256: input.producerBundleSha256, producer_policy_sha256: input.producerPolicySha256,
        task_mode_sha256: sourceBytes(input.taskModeBytes), preflight_sha256: sourceBytes(input.preflightBytes),
        normalized_guard_config_sha256: closedReviewDigest(JSON.stringify(input.config)),
        preflight_domain_fingerprints_sha256: closedReviewDigest(JSON.stringify(input.fingerprints)),
        authenticated_restart_event_sha256: input.restartEventSha256,
        covered_review_event_sha256: input.query.latestReview?.sha256 ?? null,
        covered_review_line_ordinal: input.query.latestReview?.lineOrdinal ?? -1,
        semantic_query_sha256: input.query.semanticQuerySha256 };
}

export type ClosedReviewGateKind = 'record' | 'reuse' | 'restart' | 'preflight' | 'task-mode';
export interface ClosedReviewGateCaptureRequest { repoRoot: string; taskId: string; kind: ClosedReviewGateKind; sourceEventSha256: string; }
/** Native producer boundary: the canonical verified pass supplies query/append state,
 * plus source authentication via validateClosedReviewOutcome and full gate-only replay.
 * MUST be wired as a required native dependency (not an optional test-only callback).
 * The capture may use an already verified producer prefix, never an unchecked tail.
 */
export type ClosedReviewGateCapture = (request: ClosedReviewGateCaptureRequest) => PublishClosedReviewInput;
/** The native owner has already completed all of its original checks and effects.
 * This boundary contains only NEW optional acceleration work; never wrap native admission in it.
 */
export function publishClosedReviewAfterGate(capture: ClosedReviewGateCapture, request: Omit<ClosedReviewGateCaptureRequest, 'sourceEventSha256'>,
    admitted: AppendTaskEventResult): AppendTaskEventResult | null {
    try {
        const sourceEventSha256 = admitted.integrity?.event_sha256;
        if (!admitted.canonical_committed || !sourceEventSha256) return null;
        const input = capture({ ...request, sourceEventSha256 });
        if (input.repoRoot !== request.repoRoot || input.binding.task_id !== request.taskId || input.query.source.sha256 !== sourceEventSha256)
            throw new Error('Native review-history source capture selected another gate event.');
        const expectedTypes: Record<ClosedReviewGateKind, readonly string[]> = { record: ['REVIEW_RECORDED'], reuse: ['REVIEW_RECORDED'],
            restart: ['REVIEW_CYCLE_RESTARTED', 'COHERENT_CYCLE_RESTARTED'], preflight: ['PREFLIGHT_CLASSIFIED'],
            'task-mode': ['TASK_MODE_ENTERED', 'TASK_RESET', 'TASK_DISCARDED'] };
        if (!expectedTypes[request.kind].includes(input.query.sourceEventType)) throw new Error('Native history source event has wrong kind.');
        const published = publishClosedReviewHistory(input);
        prepareClosedReviewCurrentIndex(request.repoRoot);
        return published;
    } catch {
        // Storage retains its transaction rollback and canonical append preconditions.
        // No proof/result is fabricated: current query/file/HMAC checks decide any future read.
        countNextStepWork('closed-review-summary:publication-unavailable');
        return null;
    }
}
