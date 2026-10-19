import * as fs from 'node:fs';
import * as path from 'node:path';

import { matchAnyRegex } from '../../../../gate-runtime/text-utils';
import type { ResolvedClassificationConfig } from '../../../../gates/preflight/classify-change';
import {
    type ReviewDependencyTimelineEvent
} from '../../../../gates/review/review-dependencies';
import {
    computeReviewContextReuseHash,
    computeSchema3ReviewContextReuseCompatibilityHash,
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    isNonTestReviewScope,
    resolveReviewContextReuseContractBindings,
    resolveReviewReuseClassificationConfig
} from '../../../../gates/review-reuse/review-reuse';
import {
    describeHistoricalReviewRecordedSource,
    normalizeReceiptSha256,
    validateHistoricalReviewReuseCandidate,
    type HistoricalReviewReuseCandidate
} from '../../../../gates/review-reuse/review-reuse-validation';
import {
    materializeReusedReviewEvidence
} from '../../../../gates/review-reuse/review-reuse-materialization';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    readTimelineEventsSummary,
    type TimelineEventsSummaryResult
} from './review-context-command-binding';
import {
    serializeReviewContextTelemetry
} from './review-context-telemetry';
import { DEFAULT_REFACTOR_PATH_REGEXES } from '../../../../policy/default-path-regexes';
import {
    findLatestTimelineSequence,
    readCompileEvidenceSummary,
    tryAcceptCurrentPassReviewEvidence
} from './review-context-flow-current-pass-reuse';
import {
    getReviewTreeStateSha256FromContext,
    hasFullDiffFallbackScopedDiff,
    isRecord,
    normalizeLowerText
} from './review-context-flow-json';

export interface ReviewReuseResult {
    reused: boolean;
    receiptPath: string | null;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
    reason: string;
}

const TEST_DELTA_DOMAIN_REUSE_REVIEW_TYPES = new Set([
    'db',
    'security',
    'refactor',
    'api',
    'performance',
    'infra',
    'dependency'
]);

function getCandidateTestDeltaFiles(
    codeScopeFingerprint: ReturnType<typeof computeReviewReuseCodeScopeFingerprint>
): string[] {
    const nonTestOrDocFiles = new Set([
        ...codeScopeFingerprint.non_test_changed_files,
        ...codeScopeFingerprint.docs_only_changed_files
    ]);
    return codeScopeFingerprint.all_changed_files
        .filter((filePath) => !nonTestOrDocFiles.has(filePath))
        .sort();
}

function findSensitiveTestDeltaFiles(
    classificationConfig: ResolvedClassificationConfig,
    testDeltaFiles: readonly string[]
): string[] {
    if (testDeltaFiles.length === 0) {
        return [];
    }
    const sensitiveRegexes = [
        ...classificationConfig.db_trigger_regexes,
        ...classificationConfig.security_trigger_regexes,
        ...classificationConfig.api_trigger_regexes,
        ...classificationConfig.dependency_trigger_regexes,
        ...classificationConfig.infra_trigger_regexes,
        ...classificationConfig.performance_trigger_regexes,
        ...classificationConfig.fast_path_sensitive_regexes,
        ...DEFAULT_REFACTOR_PATH_REGEXES
    ];
    return testDeltaFiles.filter((filePath) => (
        gateHelpers.testPathPrefix(filePath, classificationConfig.protected_control_plane_roots)
        || matchAnyRegex(filePath, sensitiveRegexes, {
            skipInvalidRegex: true,
            caseInsensitive: true
        })
    ));
}

function evaluateTestOnlyDeltaReuseEligibility(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    currentReviewContext: Record<string, unknown>;
    codeScopeFingerprint: ReturnType<typeof computeReviewReuseCodeScopeFingerprint>;
    classificationConfig: ResolvedClassificationConfig;
    timelineEventsSummary?: TimelineEventsSummaryResult | null;
}): { allowed: boolean; reason: string } {
    const reviewType = normalizeLowerText(options.reviewType);
    if (!TEST_DELTA_DOMAIN_REUSE_REVIEW_TYPES.has(reviewType)) {
        return { allowed: false, reason: 'review type is not eligible for test-only delta domain reuse' };
    }
    if (!hasFullDiffFallbackScopedDiff(options.currentReviewContext)) {
        return { allowed: false, reason: 'current review context is not a full-diff fallback scoped context' };
    }
    if (options.codeScopeFingerprint.non_test_changed_files.length === 0) {
        return { allowed: false, reason: 'current preflight has no non-test code scope to compare with prior review evidence' };
    }
    const testDeltaFiles = getCandidateTestDeltaFiles(options.codeScopeFingerprint);
    if (testDeltaFiles.length === 0) {
        return { allowed: false, reason: 'current preflight has no test-only delta files' };
    }
    const sensitiveTestDeltaFiles = findSensitiveTestDeltaFiles(options.classificationConfig, testDeltaFiles);
    if (sensitiveTestDeltaFiles.length > 0) {
        return {
            allowed: false,
            reason: `test-only delta includes sensitive path(s): ${sensitiveTestDeltaFiles.slice(0, 8).join(', ')}`
        };
    }
    const reviewsRoot = path.dirname(options.preflightPath);
    const codeReviewContextPath = path.join(reviewsRoot, `${options.taskId}-code-review-context.json`);
    const currentCodeReviewEvidence = tryAcceptCurrentPassReviewEvidence({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: 'code',
        preflightPath: options.preflightPath,
        preflightPayload: options.preflightPayload,
        reviewContextPath: codeReviewContextPath,
        timelineEventsSummary: options.timelineEventsSummary
    });
    if (!currentCodeReviewEvidence.accepted) {
        return {
            allowed: false,
            reason: `current-cycle code review reuse evidence is not accepted: ${currentCodeReviewEvidence.reason}`
        };
    }
    if (!currentCodeReviewEvidence.reusedExistingReview) {
        return {
            allowed: false,
            reason: 'current-cycle code review evidence is fresh rather than reused'
        };
    }
    return {
        allowed: true,
        reason: `only test files changed after accepted code scope; current code reuse receipt=${currentCodeReviewEvidence.receiptPath || 'unknown'}; test files=${testDeltaFiles.join(', ')}`
    };
}

function resolveHistoricalArtifactPath(repoRoot: string, rawPath: unknown, fallbackPath: string): string {
    const text = String(rawPath || '').trim();
    if (!text) {
        return fallbackPath;
    }
    return path.isAbsolute(text) ? text : path.resolve(repoRoot, text);
}

function collectHistoricalReviewReuseCandidates(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    receiptPath: string;
    artifactPath: string;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    latestCompilePassSequence: number;
}): { candidates: HistoricalReviewReuseCandidate[]; latestReceiptReadFailure: string | null } {
    const candidates: HistoricalReviewReuseCandidate[] = [];
    let latestReceiptReadFailure: string | null = null;
    if (fs.existsSync(options.receiptPath) && fs.statSync(options.receiptPath).isFile()) {
        try {
            candidates.push({
                telemetryReceiptPath: options.receiptPath,
                sourceReceiptPath: options.receiptPath,
                sourceReceiptSha256: String(gateHelpers.fileSha256(options.receiptPath) || '').trim().toLowerCase() || null,
                sourceArtifactPath: options.artifactPath,
                sourceKind: 'latest_receipt',
                sourceEvent: null,
                sourceDescription: `latest mutable receipt ${gateHelpers.normalizePath(options.receiptPath)}`
            });
        } catch {
            latestReceiptReadFailure = 'latest mutable receipt is not valid JSON';
        }
    } else {
        latestReceiptReadFailure = 'no prior review receipt exists for this review type';
    }

    for (let index = options.timelineEvents.length - 1; index >= 0; index -= 1) {
        const event = options.timelineEvents[index];
        if (
            event.sequence >= options.latestCompilePassSequence
            || event.event_type !== 'REVIEW_RECORDED'
            || !isRecord(event.details)
        ) {
            continue;
        }
        const details = event.details;
        if (
            normalizeLowerText(details.review_type ?? details.reviewType) !== normalizeLowerText(options.reviewType)
            || (String(details.task_id ?? details.taskId ?? '').trim()
                && String(details.task_id ?? details.taskId).trim() !== options.taskId)
        ) {
            continue;
        }
        candidates.push({
            telemetryReceiptPath: resolveHistoricalArtifactPath(
                options.repoRoot,
                details.receipt_path ?? details.receiptPath,
                options.receiptPath
            ),
            sourceReceiptPath: resolveHistoricalArtifactPath(
                options.repoRoot,
                details.receipt_snapshot_path ?? details.receiptSnapshotPath,
                ''
            ),
            sourceReceiptSha256: normalizeReceiptSha256(
                details.receipt_snapshot_sha256 ?? details.receiptSnapshotSha256
            ),
            sourceArtifactPath: resolveHistoricalArtifactPath(
                options.repoRoot,
                details.review_artifact_snapshot_path ?? details.reviewArtifactSnapshotPath,
                options.artifactPath
            ),
            sourceKind: 'historical_review_recorded',
            sourceEvent: event,
            sourceDescription: describeHistoricalReviewRecordedSource(event)
        });
    }

    return { candidates, latestReceiptReadFailure };
}

export async function tryReuseReviewEvidence(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    reviewContextPath: string;
    previousReviewContextReuseSha256?: string | null;
    timelineEventsSummary?: TimelineEventsSummaryResult | null;
    remediationPreservedScopeMismatchReason?: string | null;
}): Promise<ReviewReuseResult> {
    const reject = (reason: string): ReviewReuseResult => ({
        reused: false,
        receiptPath: null,
        reviewerExecutionMode: null,
        reviewerIdentity: null,
        reason
    });
    const nonTestReviewScope = isNonTestReviewScope(options.reviewType);
    const classificationConfig = resolveReviewReuseClassificationConfig(
        options.preflightPayload,
        options.repoRoot
    );
    const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint(
        options.reviewType,
        options.preflightPayload,
        options.repoRoot,
        classificationConfig
    );
    if (codeScopeFingerprint.missing_non_test_files.length > 0) {
        return reject(`missing non-test scope file(s): ${codeScopeFingerprint.missing_non_test_files.join(', ')}`);
    }
    const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(
        options.preflightPayload,
        options.repoRoot,
        classificationConfig
    );
    if (reviewScopeFingerprint.missing_review_relevant_files.length > 0) {
        return reject(`missing review-relevant scope file(s): ${reviewScopeFingerprint.missing_review_relevant_files.join(', ')}`);
    }

    const reviewsRoot = path.dirname(options.preflightPath);
    const artifactPath = path.join(reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    const compileEvidence = readCompileEvidenceSummary(options.repoRoot, options.taskId);
    const currentPreflightHash = String(gateHelpers.fileSha256(options.preflightPath) || '').trim().toLowerCase() || null;
    const normalizedPreflightPath = gateHelpers.normalizePath(options.preflightPath);
    if (
        compileEvidence.status !== 'PASSED'
        || compileEvidence.preflightPath !== normalizedPreflightPath
        || compileEvidence.preflightHashSha256 !== currentPreflightHash
    ) {
        return reject('compile evidence is missing, failed, or bound to a different preflight artifact');
    }

    const timelinePath = gateHelpers.joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events', `${options.taskId}.jsonl`));
    const timelineEvents = options.timelineEventsSummary?.events || readTimelineEventsSummary(timelinePath).events;
    const latestCompilePassSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    if (latestCompilePassSequence == null) {
        return reject('task timeline has no compile pass before the current review cycle');
    }
    const hasFreshCurrentCycleReviewEvidence = timelineEvents.some((entry) => {
        if (
            entry.sequence <= latestCompilePassSequence
            || (
                entry.event_type !== 'REVIEWER_DELEGATION_ROUTED'
                && entry.event_type !== 'REVIEW_RECORDED'
            )
            || String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() !== options.reviewType
        ) {
            return false;
        }
        return entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
            || entry.details?.reused_existing_review !== true;
    });
    if (hasFreshCurrentCycleReviewEvidence) {
        return reject('current review cycle already has fresh routing or review-recorded evidence for this review type');
    }

    const { candidates, latestReceiptReadFailure } = collectHistoricalReviewReuseCandidates({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        receiptPath,
        artifactPath,
        timelineEvents,
        latestCompilePassSequence
    });
    if (candidates.length === 0) {
        return reject(latestReceiptReadFailure || 'no historical review evidence exists for this review type');
    }

    const requiredReviews = options.preflightPayload.required_reviews
        && typeof options.preflightPayload.required_reviews === 'object'
        && !Array.isArray(options.preflightPayload.required_reviews)
        ? options.preflightPayload.required_reviews as Record<string, unknown>
        : {};
    const performanceSupportFiles = codeScopeFingerprint.performance_support_changed_files || [];
    const delegatesPerformanceSupportToPerformanceReview = (
        options.reviewType === 'code'
        && performanceSupportFiles.length > 0
        && requiredReviews.performance === true
    );
    if (
        options.reviewType === 'code'
        && performanceSupportFiles.length > 0
        && requiredReviews.performance !== true
    ) {
        return reject(
            'code review reuse saw non-runtime performance support file(s), but performance review is not required: ' +
            `${performanceSupportFiles.join(', ')}`
        );
    }
    const currentCodeScopeSha256 = normalizeReceiptSha256(codeScopeFingerprint.code_scope_sha256);
    const hasCurrentCodeScope = codeScopeFingerprint.non_test_changed_files.length > 0;
    const hasCurrentReviewScope = reviewScopeFingerprint.review_relevant_changed_files.length > 0;
    const currentReviewContext = JSON.parse(fs.readFileSync(options.reviewContextPath, 'utf8')) as Record<string, unknown>;
    const currentReviewContextSha256 = String(gateHelpers.fileSha256(options.reviewContextPath) || '').trim().toLowerCase() || null;
    const currentReviewTreeStateSha256 = getReviewTreeStateSha256FromContext(currentReviewContext);
    const currentContextReuseSha256 = String(computeReviewContextReuseHash(currentReviewContext) || '').trim().toLowerCase() || null;
    const currentSchema3ContextReuseSha256 = String(
        computeSchema3ReviewContextReuseCompatibilityHash(currentReviewContext) || ''
    ).trim().toLowerCase() || null;
    const currentReviewContextContractBindings = resolveReviewContextReuseContractBindings(currentReviewContext);
    const testOnlyDeltaReuseEligibility = evaluateTestOnlyDeltaReuseEligibility({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightPath: options.preflightPath,
        preflightPayload: options.preflightPayload,
        currentReviewContext,
        codeScopeFingerprint,
        classificationConfig,
        timelineEventsSummary: options.timelineEventsSummary
    });

    const candidateRejections: string[] = [];
    for (const candidate of candidates) {
        const validation = validateHistoricalReviewReuseCandidate({
            candidate,
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            preflightPayload: options.preflightPayload,
            previousReviewContextReuseSha256: options.previousReviewContextReuseSha256,
            timelineEvents,
            latestCompilePassSequence,
            nonTestReviewScope,
            codeScopeFingerprint,
            reviewScopeFingerprint,
            hasCurrentCodeScope,
            hasCurrentReviewScope,
            currentCodeScopeSha256,
            currentReviewContextSha256,
            currentContextReuseSha256,
            currentSchema3ContextReuseSha256,
            currentReviewContextContractBindings,
            allowTestOnlyDeltaContextMismatch: testOnlyDeltaReuseEligibility.allowed,
            remediationPreservedScopeMismatchReason: options.remediationPreservedScopeMismatchReason || null
        });
        if (!validation.accepted) {
            candidateRejections.push(`${candidate.sourceDescription}: ${validation.reason}`);
            continue;
        }
        const evidence = validation.evidence;
        const materialized = await serializeReviewContextTelemetry(
            gateHelpers.joinOrchestratorPath(options.repoRoot, ''),
            options.taskId,
            () => materializeReusedReviewEvidence({
                repoRoot: options.repoRoot,
                taskId: options.taskId,
                reviewType: options.reviewType,
                preflightPath: options.preflightPath,
                preflightPayload: options.preflightPayload,
                reviewContextPath: options.reviewContextPath,
                artifactPath,
                receiptPath,
                nonTestReviewScope,
                codeScopeFingerprint,
                reviewScopeFingerprint,
                currentPreflightHash,
                currentReviewContextSha256,
                currentReviewTreeStateSha256,
                currentContextReuseSha256,
                candidate,
                reusedFromReceiptPath: evidence.reusedFromReceiptPath,
                reusedFromReceiptSha256: evidence.reusedFromReceiptSha256,
                receipt: evidence.receipt,
                reviewerExecutionMode: evidence.reviewerExecutionMode,
                reviewerIdentity: evidence.reviewerIdentity,
                historicalReviewerProvenance: evidence.historicalReviewerProvenance,
                expectedContextSha256: evidence.expectedContextSha256,
                expectedContextReuseSha256: evidence.expectedContextReuseSha256,
                historicalSchema3ContextReuseHashMatches:
                    evidence.historicalSchema3ContextReuseHashMatches,
                expectedReviewTreeStateSha256: evidence.expectedReviewTreeStateSha256,
                expectedReviewScopeSha256: evidence.expectedReviewScopeSha256,
                expectedCodeScopeSha256: evidence.expectedCodeScopeSha256,
                contextContractBindingsRequired:
                    !evidence.contextHashMatches && !evidence.receiptContextReuseHashMatches,
                currentReviewContextContractBindings,
                historicalReviewArtifactSha256: evidence.historicalReviewArtifactSha256,
                artifactText: evidence.artifactText
            })
        );
        if (!materialized.materialized) {
            candidateRejections.push(
                `${candidate.sourceDescription}: ${materialized.reason || 'current-cycle review reuse evidence could not be materialized'}`
            );
            continue;
        }
        const latestReceiptRejection = candidate.sourceKind === 'historical_review_recorded'
            ? candidateRejections.find((entry) => entry.startsWith('latest mutable receipt '))
            : null;
        return {
            reused: true,
            receiptPath: gateHelpers.normalizePath(receiptPath),
            reviewerExecutionMode: evidence.reviewerExecutionMode,
            reviewerIdentity: evidence.reviewerIdentity,
            reason: (
                evidence.testOnlyDeltaContextMismatch
                    ? `accepted: non-test review reused because ${testOnlyDeltaReuseEligibility.reason}; review context changed only by test delta, but non-test code scope matches prior independent PASS review`
                    : evidence.remediationPreservedScopeMismatch
                    ? `accepted: non-test review reused because ${evidence.remediationPreservedScopeMismatchReason}; classified remediation preserved this review type despite context/scope hash changes`
                    : evidence.contextHashMatches
                    ? 'accepted: exact review context hash and scope evidence match prior independent PASS review'
                    : 'accepted: review context reuse hash and scope evidence match prior independent PASS review'
            ) + `; matched ${candidate.sourceDescription} from ${gateHelpers.normalizePath(evidence.verifiedReceiptPath || candidate.sourceReceiptPath)}` + (
                latestReceiptRejection
                    ? `; rejected latest mutable receipt: ${latestReceiptRejection}`
                    : ''
            ) + (
                delegatesPerformanceSupportToPerformanceReview
                    ? `; non-runtime performance support file(s) delegated to required performance review: ${performanceSupportFiles.join(', ')}`
                    : ''
            )
        };
    }
    const rejectionSummary = candidateRejections.slice(0, 4).join('; ');
    return reject(
        `no reusable historical PASS review evidence matched current scope` +
        (latestReceiptReadFailure ? `; latest receipt: ${latestReceiptReadFailure}` : '') +
        (rejectionSummary ? `; checked candidates: ${rejectionSummary}` : '')
    );
}
