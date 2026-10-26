import { countNextStepWork, countNextStepArrayCopy } from '../../core/next-step-measurement';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    normalizeReviewCycleGuardConfig
} from '../../core/review-cycle-guard';
import {
    extractReviewVerdictToken
} from '../../gate-runtime/review-context';
import {
    validateReviewFindingsValidationArtifactForReceipt
} from '../review/review-findings-validation-artifact';
import {
    resolveLockedReviewFindingPolicyFromReceiptDisposition,
    reviewFindingsValidationArtifactHasBlockingFindings
} from '../review/review-finding-disposition';
import {
    type TimelineEventEntry
} from '../completion/completion-evidence';
import {
    REVIEW_CONTRACTS
} from '../required-reviews/required-reviews-check';
import {
    getReviewLaneScopeSha256,
    normalizeDomainScopeFingerprints,
    type DomainScopeFingerprints
} from '../scope/domain-scope-fingerprints';
import {
    joinOrchestratorPath
} from '../shared/helpers';
import {
    reviewCycleAttemptMatchesCurrentScope
} from './next-step-review-cycle-scope';
import {
    type NextStepReviewCycleLatestFailedReview,
    type ReviewCycleArtifactVerdictResult,
    type ReviewCycleGuardReadResult
} from './next-step-review-cycle-guard-types';
import { withReviewArtifactReadBarrier } from '../../gate-runtime/review-artifacts';
import {
    createReviewAttemptArtifactIndex,
    type ReviewAttemptArtifactIndex
} from '../review-attempts/review-attempt-artifact-index';

type ReviewCycleGuardConfig = ReturnType<typeof normalizeReviewCycleGuardConfig>;

const REVIEW_VERDICT_PASS_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(REVIEW_CONTRACTS));
const REVIEW_VERDICT_FAIL_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(
    REVIEW_CONTRACTS.map(([reviewType, passToken]) => [reviewType, passToken.replace(/\bPASSED\b/g, 'FAILED')])
));

function getTimelineDetailText(details: Record<string, unknown> | null, fieldNames: string[]): string | null {
    for (const fieldName of fieldNames) {
        const value = details?.[fieldName];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return null;
}

function getTimelineReviewType(details: Record<string, unknown> | null): string {
    return String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
}

function getTimelineReviewerIdentity(details: Record<string, unknown> | null): string {
    return String(details?.reviewer_identity || details?.reviewerIdentity || '').trim();
}

function getTimelineReviewContextSha256(details: Record<string, unknown> | null): string {
    return String(details?.review_context_sha256 || details?.reviewContextSha256 || '').trim().toLowerCase();
}

function normalizeReviewCycleScopeHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function getTimelineReviewScopeHash(details: Record<string, unknown> | null): string | null {
    return normalizeReviewCycleScopeHash(details?.review_scope_sha256 ?? details?.reviewScopeSha256);
}

function getTimelineCodeScopeHash(details: Record<string, unknown> | null): string | null {
    return normalizeReviewCycleScopeHash(details?.code_scope_sha256 ?? details?.codeScopeSha256);
}

function getReviewCycleAttemptScopeHash(
    reviewType: string,
    details: Record<string, unknown> | null
): string | null {
    const normalizedReviewType = reviewType.trim().toLowerCase();
    const detailFingerprints = normalizeDomainScopeFingerprints(details?.domain_scope_fingerprints);
    return getReviewLaneScopeSha256(normalizedReviewType, detailFingerprints)
        || (normalizedReviewType === 'test'
        ? getTimelineReviewScopeHash(details)
        : getTimelineCodeScopeHash(details) || getTimelineReviewScopeHash(details));
}

function getTimelineReviewFailure(eventType: string, details: Record<string, unknown> | null, outcome: string | null): boolean | null {
    const verdictToken = String(details?.verdict_token || details?.verdictToken || '').trim().toUpperCase();
    if (verdictToken.endsWith('FAILED')) {
        return true;
    }
    if (verdictToken.endsWith('PASSED')) {
        return false;
    }
    const normalizedOutcome = String(outcome || '').trim().toUpperCase();
    if (normalizedOutcome === 'FAIL') {
        return true;
    }
    if (
        eventType === 'REVIEW_RECORDED'
        && String(details?.review_artifact_snapshot_path || details?.reviewArtifactSnapshotPath || '').trim()
    ) {
        return null;
    }
    if (normalizedOutcome === 'PASS') {
        return false;
    }
    return null;
}

function normalizeReviewCycleSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function resolveReviewCycleReviewsRoot(repoRoot: string): string {
    return path.resolve(joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews')));
}

function validateReviewCycleReceiptSnapshotBinding(
    artifactIndex: ReviewAttemptArtifactIndex,
    taskId: string,
    reviewType: string,
    details: Record<string, unknown> | null,
    reviewArtifactSnapshotSha256: string
): boolean {
    const receiptSnapshotPath = details?.receipt_snapshot_path ?? details?.receiptSnapshotPath;
    const receiptSnapshotSha256 = normalizeReviewCycleSha256(details?.receipt_snapshot_sha256 ?? details?.receiptSnapshotSha256);
    const hasReceiptSnapshotEvidence = Boolean(String(receiptSnapshotPath || '').trim() || receiptSnapshotSha256);
    if (!hasReceiptSnapshotEvidence) {
        return true;
    }
    if (!receiptSnapshotSha256) {
        return false;
    }
    const receiptResult = artifactIndex.readJsonSnapshot(
        receiptSnapshotPath,
        `${taskId}-${reviewType}-receipt-${receiptSnapshotSha256}.json`,
        receiptSnapshotSha256
    );
    const receipt = receiptResult.record;
    if (!receipt || receipt.task_id !== taskId || receipt.review_type !== reviewType) {
        return false;
    }
    return normalizeReviewCycleSha256(receipt.review_artifact_sha256) === reviewArtifactSnapshotSha256;
}

function resolveValidatedReviewCycleArtifactForVerdict(options: {
    artifactIndex: ReviewAttemptArtifactIndex;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    details: Record<string, unknown> | null;
}): { content: string | null; resolvedPath: string | null; invalidSnapshot: boolean } {
    const snapshotPathText = String(
        options.details?.review_artifact_snapshot_path
        || options.details?.reviewArtifactSnapshotPath
        || ''
    ).trim();
    if (!snapshotPathText) {
        return { content: null, resolvedPath: null, invalidSnapshot: false };
    }
    const snapshotSha256 = normalizeReviewCycleSha256(
        options.details?.review_artifact_snapshot_sha256
        ?? options.details?.reviewArtifactSnapshotSha256
    );
    if (!snapshotSha256) {
        return { content: null, resolvedPath: null, invalidSnapshot: true };
    }
    const recordedArtifactSha256 = normalizeReviewCycleSha256(
        options.details?.review_artifact_sha256
        ?? options.details?.reviewArtifactSha256
    );
    if (recordedArtifactSha256 && recordedArtifactSha256 !== snapshotSha256) {
        return { content: null, resolvedPath: null, invalidSnapshot: true };
    }
    const expectedFileName = `${options.taskId}-${options.reviewType}-artifact-${snapshotSha256}.md`;
    const snapshotResult = options.artifactIndex.readTextSnapshot(
        snapshotPathText,
        expectedFileName,
        snapshotSha256
    );
    if (!snapshotResult.valid || snapshotResult.content === null) {
        return { content: null, resolvedPath: null, invalidSnapshot: true };
    }
    if (!validateReviewCycleReceiptSnapshotBinding(
        options.artifactIndex,
        options.taskId,
        options.reviewType,
        options.details,
        snapshotSha256
    )) {
        return { content: null, resolvedPath: null, invalidSnapshot: true };
    }
    return {
        content: snapshotResult.content,
        resolvedPath: path.resolve(resolveReviewCycleReviewsRoot(options.repoRoot), expectedFileName),
        invalidSnapshot: false
    };
}

function readValidatedReviewCycleReceiptSnapshot(options: {
    artifactIndex: ReviewAttemptArtifactIndex;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    details: Record<string, unknown> | null;
    reviewArtifactSha256: string;
}): { receipt: Record<string, unknown> | null; invalidSnapshot: boolean } {
    const receiptSnapshotSha256 = normalizeReviewCycleSha256(
        options.details?.receipt_snapshot_sha256 ?? options.details?.receiptSnapshotSha256
    );
    const receiptSnapshotPath = options.details?.receipt_snapshot_path ?? options.details?.receiptSnapshotPath;
    if (!receiptSnapshotSha256 && !String(receiptSnapshotPath || '').trim()) {
        return { receipt: null, invalidSnapshot: false };
    }
    if (!receiptSnapshotSha256) {
        return { receipt: null, invalidSnapshot: true };
    }
    const receiptResult = options.artifactIndex.readJsonSnapshot(
        receiptSnapshotPath,
        `${options.taskId}-${options.reviewType}-receipt-${receiptSnapshotSha256}.json`,
        receiptSnapshotSha256
    );
    const receipt = receiptResult.record;
    if (!receipt || receipt.task_id !== options.taskId || receipt.review_type !== options.reviewType) {
        return { receipt: null, invalidSnapshot: true };
    }
    if (normalizeReviewCycleSha256(receipt.review_artifact_sha256) !== options.reviewArtifactSha256) {
        return { receipt: null, invalidSnapshot: true };
    }
    return { receipt, invalidSnapshot: false };
}

function getReviewCycleValidationArtifactVerdict(options: {
    artifactIndex: ReviewAttemptArtifactIndex;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    details: Record<string, unknown> | null;
    reviewArtifactSha256: string;
}): ReviewCycleArtifactVerdictResult | null {
    const receiptResult = readValidatedReviewCycleReceiptSnapshot(options);
    if (receiptResult.invalidSnapshot) {
        return { failed: null, invalidSnapshot: true };
    }
    if (!receiptResult.receipt || !receiptResult.receipt.review_findings_validation) {
        return null;
    }
    const reusedExistingReview = receiptResult.receipt.reused_existing_review === true;
    const validationResult = validateReviewFindingsValidationArtifactForReceipt({
        receipt: receiptResult.receipt,
        reviewArtifactPath: String(options.details?.review_artifact_path ?? options.details?.reviewArtifactPath ?? ''),
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewOutputSha256: typeof receiptResult.receipt.review_output_sha256 === 'string'
            ? receiptResult.receipt.review_output_sha256
            : null,
        expectedReviewArtifactSha256: options.reviewArtifactSha256,
        expectedReviewContextPath: reusedExistingReview
            ? null
            : String(options.details?.review_context_path ?? options.details?.reviewContextPath ?? '').trim() || null,
        expectedReviewContextSha256: reusedExistingReview
            ? normalizeReviewCycleSha256(receiptResult.receipt.reused_from_review_context_sha256)
            : normalizeReviewCycleSha256(options.details?.review_context_sha256 ?? options.details?.reviewContextSha256),
        expectedPreflightSha256: reusedExistingReview
            ? null
            : normalizeReviewCycleSha256(options.details?.preflight_sha256 ?? options.details?.preflightSha256),
        expectedScopeSha256: reusedExistingReview
            ? null
            : normalizeReviewCycleSha256(options.details?.scope_sha256 ?? options.details?.scopeSha256),
        expectedReviewScopeSha256: reusedExistingReview
            ? normalizeReviewCycleSha256(receiptResult.receipt.reused_from_review_scope_sha256)
            : normalizeReviewCycleSha256(options.details?.review_scope_sha256 ?? options.details?.reviewScopeSha256),
        expectedCodeScopeSha256: reusedExistingReview
            ? normalizeReviewCycleSha256(receiptResult.receipt.reused_from_code_scope_sha256)
            : normalizeReviewCycleSha256(options.details?.code_scope_sha256 ?? options.details?.codeScopeSha256),
        expectedReviewTreeStateSha256: reusedExistingReview
            ? normalizeReviewCycleSha256(receiptResult.receipt.reused_from_review_tree_state_sha256)
            : normalizeReviewCycleSha256(options.details?.review_tree_state_sha256 ?? options.details?.reviewTreeStateSha256),
        requireAccepted: true,
        preferSnapshot: true
    });
    if (!validationResult.valid) {
        return { failed: null, invalidSnapshot: true };
    }
    const policyResolution = resolveLockedReviewFindingPolicyFromReceiptDisposition(receiptResult.receipt);
    return {
        failed: reviewFindingsValidationArtifactHasBlockingFindings(validationResult.artifact, policyResolution),
        invalidSnapshot: false
    };
}

function getReviewCycleArtifactVerdict(
    artifactIndex: ReviewAttemptArtifactIndex,
    repoRoot: string,
    taskId: string,
    reviewType: string,
    details: Record<string, unknown> | null,
    verdictCache: Map<string, ReviewCycleArtifactVerdictResult>
): ReviewCycleArtifactVerdictResult {
    const passToken = REVIEW_VERDICT_PASS_TOKENS[reviewType] || '';
    const failToken = REVIEW_VERDICT_FAIL_TOKENS[reviewType] || '';
    if (!passToken || !failToken) {
        return { failed: null, invalidSnapshot: false };
    }
    const cacheKey = JSON.stringify([
        reviewType,
        details?.review_artifact_snapshot_path ?? details?.reviewArtifactSnapshotPath ?? null,
        details?.review_artifact_snapshot_sha256 ?? details?.reviewArtifactSnapshotSha256 ?? null,
        details?.receipt_snapshot_path ?? details?.receiptSnapshotPath ?? null,
        details?.receipt_snapshot_sha256 ?? details?.receiptSnapshotSha256 ?? null,
        details?.review_artifact_path ?? details?.reviewArtifactPath ?? null,
        details?.review_context_path ?? details?.reviewContextPath ?? null,
        details?.review_context_sha256 ?? details?.reviewContextSha256 ?? null,
        details?.preflight_sha256 ?? details?.preflightSha256 ?? null,
        details?.scope_sha256 ?? details?.scopeSha256 ?? null,
        details?.review_scope_sha256 ?? details?.reviewScopeSha256 ?? null,
        details?.code_scope_sha256 ?? details?.codeScopeSha256 ?? null,
        details?.review_tree_state_sha256 ?? details?.reviewTreeStateSha256 ?? null
    ]);
    const cached = verdictCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }
    const artifactResolution = resolveValidatedReviewCycleArtifactForVerdict({
        artifactIndex,
        repoRoot,
        taskId,
        reviewType,
        details
    });
    if (artifactResolution.invalidSnapshot) {
        const result = { failed: null, invalidSnapshot: true };
        verdictCache.set(cacheKey, result);
        return result;
    }
    const resolvedArtifactPath = artifactResolution.resolvedPath;
    if (!resolvedArtifactPath) {
        return { failed: null, invalidSnapshot: false };
    }
    const snapshotSha256 = normalizeReviewCycleSha256(
        details?.review_artifact_snapshot_sha256 ?? details?.reviewArtifactSnapshotSha256
    );
    if (snapshotSha256) {
        const validationArtifactVerdict = getReviewCycleValidationArtifactVerdict({
            artifactIndex,
            repoRoot,
            taskId,
            reviewType,
            details,
            reviewArtifactSha256: snapshotSha256
        });
        if (validationArtifactVerdict) {
            verdictCache.set(cacheKey, validationArtifactVerdict);
            return validationArtifactVerdict;
        }
    }
    const content = artifactResolution.content || '';
    if (content.trimStart().startsWith('{')) {
        const result = { failed: null, invalidSnapshot: false };
        verdictCache.set(cacheKey, result);
        return result;
    }
    if (!content.includes(passToken) && !content.includes(failToken)) {
        const result = { failed: null, invalidSnapshot: false };
        verdictCache.set(cacheKey, result);
        return result;
    }
    const verdictToken = extractReviewVerdictToken(content, passToken, failToken, reviewType);
    const result = {
        failed: verdictToken === failToken
            ? true
            : verdictToken === passToken
                ? false
                : null,
        invalidSnapshot: false
    };
    verdictCache.set(cacheKey, result);
    return result;
}

function parseReviewCycleTimelineLine(line: string, sequence: number): TimelineEventEntry | null {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const eventType = String(parsed.event_type || '').trim().toUpperCase();
    if (!eventType) {
        return null;
    }
    const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
        ? parsed.details as Record<string, unknown>
        : null;
    return {
        event_type: eventType,
        outcome: String(parsed.outcome || '').trim().toUpperCase() || undefined,
        timestamp_utc: String(parsed.timestamp_utc || '').trim(),
        sequence,
        details
    };
}

function buildLatestFailedReviewSummary(
    event: TimelineEventEntry,
    reviewType: string,
    details: Record<string, unknown> | null
): NextStepReviewCycleLatestFailedReview {
    return {
        review_type: reviewType,
        event_type: event.event_type,
        outcome: event.outcome || null,
        verdict_token: getTimelineDetailText(details, ['verdict_token', 'verdictToken']),
        reviewer_identity: getTimelineReviewerIdentity(details) || null,
        review_artifact_path: getTimelineDetailText(details, ['review_artifact_path', 'reviewArtifactPath']),
        summary: getTimelineDetailText(details, ['summary', 'finding_summary', 'findingSummary', 'reason', 'message']),
        sequence: event.sequence,
        timestamp_utc: event.timestamp_utc || null
    };
}

function readReviewCycleGuardAttemptsUnlocked(
    repoRoot: string,
    timelinePath: string,
    taskId: string,
    reviewCycleGuardConfig: ReviewCycleGuardConfig,
    currentPreflightFingerprints: DomainScopeFingerprints | null,
    artifactIndex: ReviewAttemptArtifactIndex
): ReviewCycleGuardReadResult {
    const resolvedPath = path.resolve(String(timelinePath || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return {
            attempts: [],
            timelineValid: false,
            latestFailedReview: null
        };
    }

    const attemptsByKey = new Map<string, {
        reviewType: string;
        failed: boolean;
        passed: boolean;
        latestEventFailed: boolean;
        reused: boolean;
        scopeHash: string | null;
        currentScope: boolean;
        lastSequence: number;
    }>();
    const verdictCache = new Map<string, ReviewCycleArtifactVerdictResult>();
    const excludedReviewTypes = new Set(reviewCycleGuardConfig.excluded_review_types.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
    let malformedReviewCycleEvent = false;
    let latestFailedReview: NextStepReviewCycleLatestFailedReview | null = null;
    let sequence = 0;
    let pending = '';
    const file = fs.openSync(resolvedPath, 'r');
    const buffer = Buffer.alloc(64 * 1024);

    const handleLine = (rawLine: string): boolean => {
        const line = rawLine.trim();
        if (!line) {
            return false;
        }
        let event: TimelineEventEntry | null = null;
        try {
            event = parseReviewCycleTimelineLine(line, sequence);
        } catch {
            malformedReviewCycleEvent = true;
            return reviewCycleGuardConfig.action === 'BLOCK_FOR_OPERATOR_DECISION';
        } finally {
            sequence += 1;
        }
        if (!event || event.event_type !== 'REVIEW_RECORDED') {
            return false;
        }
        const reviewType = getTimelineReviewType(event.details);
        if (!reviewType) {
            malformedReviewCycleEvent = true;
            return reviewCycleGuardConfig.action === 'BLOCK_FOR_OPERATOR_DECISION';
        }
        const reviewerIdentity = getTimelineReviewerIdentity(event.details);
        const reviewContextSha256 = getTimelineReviewContextSha256(event.details);
        const key = reviewerIdentity && reviewContextSha256
            ? `${reviewType}|${reviewerIdentity}|${reviewContextSha256}`
            : `${event.event_type}:${event.sequence}`;
        const timelineFailure = getTimelineReviewFailure(event.event_type, event.details, event.outcome || null);
        const hasArtifactEvidence = Boolean(getTimelineDetailText(event.details, [
            'review_artifact_snapshot_path',
            'reviewArtifactSnapshotPath',
            'review_artifact_path',
            'reviewArtifactPath'
        ]));
        const artifactVerdict = event.event_type === 'REVIEW_RECORDED' && hasArtifactEvidence
            ? getReviewCycleArtifactVerdict(artifactIndex, repoRoot, taskId, reviewType, event.details, verdictCache)
            : { failed: null, invalidSnapshot: false };
        if (artifactVerdict.invalidSnapshot) {
            malformedReviewCycleEvent = true;
        }
        const failed = timelineFailure ?? artifactVerdict.failed ?? false;
        const hasReviewArtifactPath = Boolean(getTimelineDetailText(event.details, ['review_artifact_path', 'reviewArtifactPath']));
        const passed = !failed && (
            timelineFailure === false
            || artifactVerdict.failed === false
            || (event.outcome === 'PASS' && !hasReviewArtifactPath)
        );
        const reused = event.details?.reused_existing_review === true || event.details?.reusedExistingReview === true;
        const scopeHash = getReviewCycleAttemptScopeHash(reviewType, event.details);
        const currentScope = reviewCycleAttemptMatchesCurrentScope(reviewType, event.details, currentPreflightFingerprints);
        const existing = attemptsByKey.get(key);
        const existingFailed = Boolean(existing?.failed);
        const existingPassed = Boolean(existing?.passed);
        const nextFailed = Boolean(existingFailed || failed);
        const nextPassed = Boolean(!nextFailed && (existingPassed || passed));
        attemptsByKey.set(key, {
            reviewType,
            failed: nextFailed,
            passed: nextPassed,
            latestEventFailed: Boolean(failed),
            reused: existing ? Boolean(existing.reused && reused) : reused,
            scopeHash: existing?.scopeHash || scopeHash,
            currentScope: Boolean(existing?.currentScope || currentScope),
            lastSequence: event.sequence
        });
        const countedReviewType = reviewType.trim().toLowerCase();
        const countsTowardGuard = countedReviewType && !excludedReviewTypes.has(countedReviewType);
        if (!existingFailed && nextFailed && countsTowardGuard && !reused) {
            latestFailedReview = buildLatestFailedReviewSummary(event, countedReviewType, event.details);
        }
        return false;
    };

    try {
        let bytesRead = 0;
        do {
            bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
            if (bytesRead <= 0) {
                break;
            }
            pending += buffer.subarray(0, bytesRead).toString('utf8');
            let newlineIndex = pending.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
                pending = pending.slice(newlineIndex + 1);
                if (handleLine(line)) {
                    return {
                        attempts: countNextStepArrayCopy('visit:next-step-review-cycle-guard-attempts:copy:554', [...attemptsByKey.values()]).sort((left, right) => (countNextStepWork('visit:next-step-review-cycle-guard-attempts:event:554'), left.lastSequence - right.lastSequence)),
                        timelineValid: !malformedReviewCycleEvent,
                        latestFailedReview
                    };
                }
                newlineIndex = pending.indexOf('\n');
            }
        } while (bytesRead > 0);
        if (pending.trim() && handleLine(pending.replace(/\r$/, ''))) {
            return {
                attempts: countNextStepArrayCopy('visit:next-step-review-cycle-guard-attempts:copy:564', [...attemptsByKey.values()]).sort((left, right) => (countNextStepWork('visit:next-step-review-cycle-guard-attempts:event:564'), left.lastSequence - right.lastSequence)),
                timelineValid: !malformedReviewCycleEvent,
                latestFailedReview
            };
        }
    } finally {
        fs.closeSync(file);
    }

    return {
        attempts: countNextStepArrayCopy('visit:next-step-review-cycle-guard-attempts:copy:574', [...attemptsByKey.values()]).sort((left, right) => (countNextStepWork('visit:next-step-review-cycle-guard-attempts:event:574'), left.lastSequence - right.lastSequence)),
        timelineValid: !malformedReviewCycleEvent,
        latestFailedReview
    };
}

export function readReviewCycleGuardAttempts(
    repoRoot: string,
    timelinePath: string,
    taskId: string,
    reviewCycleGuardConfig: ReviewCycleGuardConfig,
    currentPreflightFingerprints: DomainScopeFingerprints | null
): ReviewCycleGuardReadResult {
    const reviewsRoot = resolveReviewCycleReviewsRoot(repoRoot);
    return withReviewArtifactReadBarrier(reviewsRoot, () => readReviewCycleGuardAttemptsUnlocked(
        repoRoot,
        timelinePath,
        taskId,
        reviewCycleGuardConfig,
        currentPreflightFingerprints,
        createReviewAttemptArtifactIndex(reviewsRoot, taskId)
    ));
}
