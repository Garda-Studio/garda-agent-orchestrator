/** Authentication boundary: facts are produced only after exact native report/receipt/validation authentication. */
import { extractReviewVerdictToken } from '../../gate-runtime/review-context';
import { REVIEW_CONTRACTS } from '../required-reviews/required-reviews-check';
import { getReviewLaneScopeSha256, normalizeDomainScopeFingerprints } from '../scope/domain-scope-fingerprints';
import { resolveValidatedReviewCycleArtifactForVerdict, getReviewCycleValidationArtifactVerdict } from './review-history-integrity';
import type { ReviewAttemptSnapshotReader } from './review-attempt-artifact-index';
import type { TimelineEventEntry } from '../completion/completion-evidence';
import type { ValidatedReviewOutcome } from './review-closed-cycle-summary';

const passTokens: Record<string, string> = Object.fromEntries(REVIEW_CONTRACTS);
const text = (details: Record<string, unknown> | null, names: string[]): string | null => {
    for (const name of names) { const value = details?.[name]; if (typeof value === 'string' && value.trim()) return value.trim(); }
    return null;
};
const sha = (value: unknown): string | null => {
    const result = String(value || '').trim().toLowerCase(); return /^[a-f0-9]{64}$/u.test(result) ? result : null;
};

export function validateClosedReviewOutcome(input: { repoRoot: string; taskId: string;
    artifactIndex: ReviewAttemptSnapshotReader; event: TimelineEventEntry; eventSha256: string;
    /** Cadence uses its separate native status/Markdown rule, never this guard's richer result. */
    cadenceFailed: boolean }): ValidatedReviewOutcome {
    const { event } = input, details = event.details ?? null;
    if (event.event_type !== 'REVIEW_RECORDED') throw new Error('Expected admitted review source event.');
    const reviewType = String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('Review source has no lane.');
    let artifactFailed: boolean | null = null;
    const hasEvidence = Boolean(text(details, ['review_artifact_snapshot_path', 'reviewArtifactSnapshotPath', 'review_artifact_path', 'reviewArtifactPath']));
    const pass = passTokens[reviewType] || '', fail = pass.replace(/\bPASSED\b/g, 'FAILED');
    if (hasEvidence) {
        const options = { artifactIndex: input.artifactIndex, repoRoot: input.repoRoot, taskId: input.taskId, reviewType, details };
        const artifact = resolveValidatedReviewCycleArtifactForVerdict(options);
        if (artifact.invalidSnapshot) throw new Error('Closed review source artifact authentication failed.');
        if (artifact.resolvedPath) {
            const digest = sha(details?.review_artifact_snapshot_sha256 ?? details?.reviewArtifactSnapshotSha256);
            const validation = digest ? getReviewCycleValidationArtifactVerdict({ ...options, reviewArtifactSha256: digest }) : null;
            if (validation?.invalidSnapshot) throw new Error('Closed review source receipt/findings authentication failed.');
            if (validation) artifactFailed = validation.failed;
            else {
                const content = artifact.content || '';
                if (pass && fail && !content.trimStart().startsWith('{') && (content.includes(pass) || content.includes(fail))) {
                    const token = extractReviewVerdictToken(content, pass, fail, reviewType);
                    artifactFailed = token === fail ? true : token === pass ? false : null;
                }
            }
        }
    }
    const token = String(details?.verdict_token || details?.verdictToken || '').trim().toUpperCase();
    const outcome = String(event.outcome || '').trim().toUpperCase();
    // Preserve original native precedence, including explicit timeline tokens.
    const timelineFailed = token.endsWith('FAILED') ? true : token.endsWith('PASSED') ? false
        : outcome === 'FAIL' ? true
        : String(details?.review_artifact_snapshot_path || details?.reviewArtifactSnapshotPath || '').trim() ? null
        : outcome === 'PASS' ? false : null;
    const failed = timelineFailed ?? artifactFailed ?? false;
    const passed = !failed && (timelineFailed === false || artifactFailed === false
        || (outcome === 'PASS' && !text(details, ['review_artifact_path', 'reviewArtifactPath'])));
    const domain = normalizeDomainScopeFingerprints(details?.domain_scope_fingerprints);
    const reviewScope = sha(details?.review_scope_sha256 ?? details?.reviewScopeSha256);
    const codeScope = sha(details?.code_scope_sha256 ?? details?.codeScopeSha256);
    return { reviewType, reviewerIdentity: String(details?.reviewer_identity || details?.reviewerIdentity || '').trim(),
        reviewContextSha256: String(details?.review_context_sha256 || details?.reviewContextSha256 || '').trim().toLowerCase(),
        eventSha256: input.eventSha256, lineOrdinal: event.sequence, failed, passed,
        reused: details?.reused_existing_review === true || details?.reusedExistingReview === true,
        scopeHash: getReviewLaneScopeSha256(reviewType, domain) || (reviewType === 'test' ? reviewScope : codeScope || reviewScope),
        cadenceFailed: input.cadenceFailed,
        latestFailedDisplay: { review_type: reviewType, event_type: event.event_type, outcome: event.outcome || null,
            verdict_token: text(details, ['verdict_token', 'verdictToken']),
            reviewer_identity: String(details?.reviewer_identity || details?.reviewerIdentity || '').trim() || null,
            review_artifact_path: text(details, ['review_artifact_path', 'reviewArtifactPath']),
            summary: text(details, ['summary', 'finding_summary', 'findingSummary', 'reason', 'message']),
            sequence: event.sequence, timestamp_utc: event.timestamp_utc || null } };
}
