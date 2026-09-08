import * as path from 'node:path';

import { sha256RedactedJsonPayload } from '../../../../core/redaction';
import { isPlainRecord } from '../../../../core/records';
import {
    normalizeCompatibilityReviewerExecutionMode
} from '../../../../gate-runtime/review-context';
import {
    REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE
} from '../../../../gates/review/review-evidence-contract';
import { normalizePath } from '../../../../gates/shared/helpers';
import {
    type ReviewDependencyTimelineEvent
} from '../../../../gates/review/review-dependencies';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations
} from '../../../../gates/review-context/review-context-contract';
import {
    resolvePersistedRemediationReviewExecutionAuthority
} from '../../../../gates/review-remediation/review-remediation-execution-authority';
import type {
    ReviewRemediationReviewContract
} from '../../../../gates/review-remediation/review-remediation-review-contract';
import {
    getReviewContextFullSuiteValidationViolations
} from '../../../../gates/review-context/review-context-validation-evidence';
import { resolveReviewContextRoutingIdentity } from '../../../../gates/review-context/review-context-routing';
import {
    normalizeRuntimeIdentitySource,
    resolveRuntimeReviewerIdentity
} from '../../../../gates/review/reviewer-routing';

type ReviewerExecutionMode = typeof REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE;

export interface ReviewExecutionRuntimeBindings {
    review_execution_mode: 'FULL' | 'DELTA';
    review_execution_contract_sha256: string;
    review_execution_full_scope_sha256: string;
    review_execution_complete_scope_lineage_sha256: string;
    review_execution_finding_reconciliation_sha256: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function readReviewExecutionRuntimeBindings(
    artifact: Record<string, unknown> | null,
    subject: string
): ReviewExecutionRuntimeBindings {
    const mode = String(artifact?.review_execution_mode || '').trim().toUpperCase();
    const contractSha256 = String(artifact?.review_execution_contract_sha256 || '').trim().toLowerCase();
    const fullScopeSha256 = String(artifact?.review_execution_full_scope_sha256 || '').trim().toLowerCase();
    const completeScopeLineageSha256 = String(
        artifact?.review_execution_complete_scope_lineage_sha256 || ''
    ).trim().toLowerCase();
    const findingReconciliationSha256 = String(
        artifact?.review_execution_finding_reconciliation_sha256 || ''
    ).trim().toLowerCase();
    if (
        (mode !== 'FULL' && mode !== 'DELTA')
        || !SHA256_PATTERN.test(contractSha256)
        || !SHA256_PATTERN.test(fullScopeSha256)
        || !SHA256_PATTERN.test(completeScopeLineageSha256)
        || !SHA256_PATTERN.test(findingReconciliationSha256)
    ) {
        throw new Error(`${subject} is missing valid authenticated review_execution bindings.`);
    }
    return {
        review_execution_mode: mode,
        review_execution_contract_sha256: contractSha256,
        review_execution_full_scope_sha256: fullScopeSha256,
        review_execution_complete_scope_lineage_sha256: completeScopeLineageSha256,
        review_execution_finding_reconciliation_sha256: findingReconciliationSha256
    };
}

export function resolveReviewExecutionRuntimeBindings(
    reviewContext: Record<string, unknown> | null
): ReviewExecutionRuntimeBindings {
    const reviewExecution = isPlainRecord(reviewContext?.review_execution)
        ? reviewContext.review_execution
        : null;
    const mode = String(reviewExecution?.mode || '').trim().toUpperCase();
    const contractSha256 = String(reviewExecution?.contract_sha256 || '').trim().toLowerCase();
    const fullScopeSha256 = String(reviewExecution?.full_review_scope_sha256 || '').trim().toLowerCase();
    const completeScopeLineageSha256 = String(
        reviewExecution?.complete_scope_lineage_sha256 || ''
    ).trim().toLowerCase();
    const findingReconciliation = isPlainRecord(reviewExecution?.finding_reconciliation)
        ? reviewExecution.finding_reconciliation
        : null;
    if (
        (mode !== 'FULL' && mode !== 'DELTA')
        || !SHA256_PATTERN.test(contractSha256)
        || !SHA256_PATTERN.test(fullScopeSha256)
        || !SHA256_PATTERN.test(completeScopeLineageSha256)
        || !findingReconciliation
    ) {
        throw new Error(
            'Review context is missing an authenticated review_execution binding for mode, contract, scope, or finding reconciliation.'
        );
    }
    return {
        review_execution_mode: mode,
        review_execution_contract_sha256: contractSha256,
        review_execution_full_scope_sha256: fullScopeSha256,
        review_execution_complete_scope_lineage_sha256: completeScopeLineageSha256,
        review_execution_finding_reconciliation_sha256: sha256RedactedJsonPayload(findingReconciliation)
    };
}

export function assertReviewExecutionRuntimeBindings(
    artifact: Record<string, unknown> | null,
    expected: ReviewExecutionRuntimeBindings,
    subject: string
): void {
    if (!artifact) {
        throw new Error(`${subject} is missing authenticated review_execution bindings.`);
    }
    for (const [field, expectedValue] of Object.entries(expected)) {
        const actualValue = String(artifact[field] || '').trim();
        const normalizedActual = field === 'review_execution_mode'
            ? actualValue.toUpperCase()
            : actualValue.toLowerCase();
        if (normalizedActual !== expectedValue) {
            throw new Error(`${subject} ${field} does not match the current authenticated review context.`);
        }
    }
}

export function assertRoutingCompatibility(
    options: {
        reviewType: string;
        runtimeIdentity: ReturnType<typeof resolveRuntimeReviewerIdentity>;
        currentRouting: Record<string, unknown> | null;
        reviewerExecutionMode: ReviewerExecutionMode;
        reviewerFallbackReason: string | null;
    }
): void {
    const {
        reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode,
        reviewerFallbackReason
    } = options;
    const capabilityLevel = runtimeIdentity.capability_level;
    const expectedExecutionMode = runtimeIdentity.expected_execution_mode;
    const fallbackAllowed = runtimeIdentity.fallback_allowed;
    const fallbackReasonRequired = runtimeIdentity.fallback_reason_required;
    const providerLabel = runtimeIdentity.execution_provider
        || runtimeIdentity.canonical_source_of_truth
        || String(currentRouting?.execution_provider || currentRouting?.source_of_truth || 'unknown');
    if (runtimeIdentity.reviewer_subagent_launch_status !== 'launchable') {
        const launchReason = runtimeIdentity.reviewer_subagent_launch_reason
            || 'Reviewer subagent launch is not currently attested.';
        const launchRemediation = runtimeIdentity.reviewer_subagent_launch_remediation
            ? ` ${runtimeIdentity.reviewer_subagent_launch_remediation}`
            : '';
        throw new Error(
            `Review '${reviewType}' cannot route delegated reviewer evidence for provider '${providerLabel}' ` +
            `because reviewer subagent launch is '${runtimeIdentity.reviewer_subagent_launch_status}'. ` +
            `${launchReason}${launchRemediation}`
        );
    }
    if (reviewerExecutionMode !== REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE) {
        throw new Error(
            `Review '${reviewType}' must use delegated_subagent for provider '${providerLabel}'.`
        );
    }
    if (capabilityLevel !== 'delegation_required' && capabilityLevel !== 'unknown') {
        throw new Error(
            `Review '${reviewType}' resolved unexpected reviewer capability '${capabilityLevel}' ` +
            `for provider '${providerLabel}'.`
        );
    }
    if (expectedExecutionMode !== REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE || !runtimeIdentity.delegation_required) {
        throw new Error(
            `Review '${reviewType}' resolved a non-delegated reviewer routing policy for provider '${providerLabel}'. ` +
            'Mandatory reviews require delegated_subagent execution.'
        );
    }
    if (fallbackAllowed || fallbackReasonRequired || reviewerFallbackReason) {
        throw new Error(
            `Review '${reviewType}' encountered stale fallback routing metadata for provider '${providerLabel}'. ` +
            'Mandatory reviews do not permit same_agent_fallback.'
        );
    }
}

export function assertReviewContextContractOrThrow(options: {
    taskId: string;
    reviewType: string;
    contextPath: string;
    reviewContext: Record<string, unknown> | null;
    preflightPath: string;
    preflightSha256: string | null;
    preflightPayload?: Record<string, unknown> | null;
    requireStrictBindingMetadata?: boolean;
    repoRoot?: string;
}): void {
    const coverageRequired = options.preflightPayload?.review_coverage_contract_required === true;
    const reviewContextSchemaVersion = Number(options.reviewContext?.schema_version);
    if (coverageRequired && (!Number.isInteger(reviewContextSchemaVersion) || reviewContextSchemaVersion < 3)) {
        throw new Error(
            `Current generated reviewer launch and result operations require review-context schema_version 3 or newer; ` +
            `legacy contexts are read-only historical evidence and must not be used to record a new review result.`
        );
    }
    const diffExpectations = buildReviewContextPreflightDiffExpectations(options.preflightPayload, options.reviewType);
    const requireStrictBindingMetadata = options.requireStrictBindingMetadata === true
        || diffExpectations.expectedRequiredReview;
    const reviewExecution = isPlainRecord(options.reviewContext?.review_execution)
        ? options.reviewContext.review_execution as unknown as ReviewRemediationReviewContract
        : null;
    const reviewExecutionValidationAuthority = reviewExecution && options.preflightSha256
        ? resolvePersistedRemediationReviewExecutionAuthority({
            reviewsRoot: path.dirname(options.preflightPath),
            taskId: options.taskId,
            reviewType: options.reviewType,
            preflightSha256: options.preflightSha256,
            preflightPath: options.preflightPath,
            fullReviewScope: diffExpectations.expectedChangedFiles,
            reviewExecution,
            reviewContextPath: options.contextPath,
            receiptPath: resolveCanonicalReviewReceiptPath(
                options.preflightPath,
                options.taskId,
                options.reviewType
            )
        })
        : null;
    const violations = getReviewContextContractViolations({
        contextPath: options.contextPath,
        reviewContext: options.reviewContext,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedPreflightPath: options.preflightPath,
        expectedPreflightSha256: options.preflightSha256,
        requireReviewType: true,
        requireTaskId: requireStrictBindingMetadata,
        requirePreflightPath: requireStrictBindingMetadata,
        requirePreflightSha256: requireStrictBindingMetadata,
        expectedPreflightPayload: options.preflightPayload,
        repoRoot: options.repoRoot || null,
        expectedReviewExecutionValidationAuthority: reviewExecutionValidationAuthority ?? undefined,
        ...diffExpectations
    });
    if (options.repoRoot) {
        violations.push(...getReviewContextFullSuiteValidationViolations({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            preflightPath: options.preflightPath,
            preflightSha256: options.preflightSha256,
            reviewContext: options.reviewContext
        }));
    }
    if (violations.length > 0) {
        throw new Error(violations.join(' '));
    }
}

export function resolveCanonicalReviewReceiptPath(
    preflightPath: string,
    taskId: string,
    reviewType: string
): string {
    return path.join(path.dirname(preflightPath), `${taskId}-${reviewType}-receipt.json`);
}

export function assertExplicitReviewContextRuntimeIdentity(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    contextPath: string;
    reviewerRouting: Record<string, unknown> | null;
    taskModePath?: string | null;
}): ReturnType<typeof resolveRuntimeReviewerIdentity> {
    const runtimeIdentity = resolveRuntimeReviewerIdentity({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        taskModePath: String(options.taskModePath || '').trim(),
        allowLegacyFallback: true
    });
    if (runtimeIdentity.identity_status !== 'resolved') {
        throw new Error(
            `Review '${options.reviewType}' cannot be recorded because runtime reviewer identity is ` +
            `'${runtimeIdentity.identity_status}'.`
        );
    }
    if (runtimeIdentity.violations.length > 0) {
        throw new Error(runtimeIdentity.violations.join(' '));
    }
    const resolvedRoutingIdentity = resolveReviewContextRoutingIdentity({
        reviewerRouting: options.reviewerRouting,
        canonicalSourceOfTruth: runtimeIdentity.canonical_source_of_truth,
        executionProvider: runtimeIdentity.execution_provider,
        allowLegacyCompatibility: runtimeIdentity.task_mode_identity_backfilled
    });
    const reviewContextExecutionProviderSource = normalizeRuntimeIdentitySource(options.reviewerRouting?.execution_provider_source);
    if (!runtimeIdentity.canonical_source_of_truth) {
        throw new Error(
            `Review '${options.reviewType}' cannot be recorded because the active workspace is missing canonical SourceOfTruth.`
        );
    }
    if (!resolvedRoutingIdentity.canonical_source_of_truth) {
        throw new Error(
            `Review '${options.reviewType}' review-context is missing canonical_source_of_truth in ${normalizePath(options.contextPath)}.`
        );
    }
    if (resolvedRoutingIdentity.canonical_source_of_truth !== runtimeIdentity.canonical_source_of_truth) {
        throw new Error(
            `Review '${options.reviewType}' review-context canonical_source_of_truth ` +
            `(${resolvedRoutingIdentity.canonical_source_of_truth}) does not match canonical provider ` +
            `(${runtimeIdentity.canonical_source_of_truth}).`
        );
    }
    if (!runtimeIdentity.execution_provider) {
        throw new Error(
            `Review '${options.reviewType}' cannot be recorded because the active task is missing execution provider identity.`
        );
    }
    if (!resolvedRoutingIdentity.execution_provider) {
        throw new Error(
            `Review '${options.reviewType}' review-context is missing execution_provider in ${normalizePath(options.contextPath)}.`
        );
    }
    if (resolvedRoutingIdentity.execution_provider !== runtimeIdentity.execution_provider) {
        throw new Error(
            `Review '${options.reviewType}' review-context execution_provider ` +
            `(${resolvedRoutingIdentity.execution_provider}) does not match active runtime provider ` +
            `(${runtimeIdentity.execution_provider}).`
        );
    }
    if (resolvedRoutingIdentity.explicit_split_identity_present && !reviewContextExecutionProviderSource) {
        throw new Error(
            `Review '${options.reviewType}' review-context is missing execution_provider_source in ${normalizePath(options.contextPath)}.`
        );
    }
    if (
        resolvedRoutingIdentity.explicit_split_identity_present
        && runtimeIdentity.execution_provider_source
        && reviewContextExecutionProviderSource !== runtimeIdentity.execution_provider_source
    ) {
        throw new Error(
            `Review '${options.reviewType}' review-context execution_provider_source ` +
            `(${reviewContextExecutionProviderSource}) does not match active runtime source ` +
            `(${runtimeIdentity.execution_provider_source}).`
        );
    }
    if (!resolvedRoutingIdentity.identity_status) {
        throw new Error(
            `Review '${options.reviewType}' review-context is missing identity_status in ${normalizePath(options.contextPath)}.`
        );
    }
    if (resolvedRoutingIdentity.identity_status !== 'resolved') {
        throw new Error(
            `Review '${options.reviewType}' review-context runtime identity status must be 'resolved', ` +
            `got '${resolvedRoutingIdentity.identity_status}'.`
        );
    }
    return runtimeIdentity;
}

export function assertReviewContextRuntimeIdentityMetadataPresent(options: {
    reviewType: string;
    contextPath: string;
    reviewContext: Record<string, unknown> | null;
    reviewerRouting: Record<string, unknown> | null;
}): void {
    if (!options.reviewerRouting) {
        return;
    }
    const handoff = options.reviewContext?.reviewer_handoff;
    if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) {
        return;
    }
    const routing = options.reviewerRouting;
    const violations: string[] = [];
    if (routing.canonical_source_of_truth == null || String(routing.canonical_source_of_truth).trim() === '') {
        violations.push(`Review '${options.reviewType}' review-context is missing canonical_source_of_truth in ${normalizePath(options.contextPath)}.`);
    }
    if (routing.execution_provider == null || String(routing.execution_provider).trim() === '') {
        violations.push(`Review '${options.reviewType}' review-context is missing execution_provider in ${normalizePath(options.contextPath)}.`);
    }
    if (routing.identity_status == null || String(routing.identity_status).trim() === '') {
        violations.push(`Review '${options.reviewType}' review-context is missing identity_status in ${normalizePath(options.contextPath)}.`);
    }
    if (violations.length > 0) {
        throw new Error(violations.join(' '));
    }
}

function matchesRoutingEvent(
    entry: ReviewDependencyTimelineEvent,
    reviewType: string,
    reviewerExecutionMode: ReviewerExecutionMode,
    reviewerIdentity: string,
    reviewerFallbackReason: string | null
): boolean {
    const details = entry.details;
    return entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
        && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === reviewType
        && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === reviewerExecutionMode
        && String((details?.reviewer_session_id ?? details?.reviewerSessionId) || '').trim() === reviewerIdentity
        && !reviewerFallbackReason;
}

function findLatestTimelineSequence(
    events: readonly ReviewDependencyTimelineEvent[],
    predicate: (entry: ReviewDependencyTimelineEvent) => boolean
): number | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (predicate(events[index])) {
            return events[index].sequence;
        }
    }
    return null;
}

export function findMatchingRoutingEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    reviewType: string,
    reviewerExecutionMode: ReviewerExecutionMode,
    reviewerIdentity: string,
    reviewerFallbackReason: string | null
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const cycleFloorSequence = resolveReviewCycleFloorSequence(timelineEvents, normalizedReviewType);
    if (cycleFloorSequence == null) {
        return null;
    }
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        if (entry.sequence <= cycleFloorSequence) {
            break;
        }
        if (
            entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
            && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && matchesRoutingEvent(
                entry,
                normalizedReviewType,
                reviewerExecutionMode,
                reviewerIdentity,
                reviewerFallbackReason
            )
        ) {
            return entry;
        }
    }
    return null;
}

function resolveReviewCycleFloorSequence(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    reviewType: string
): number | null {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const latestCompilePassSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    const latestReviewPhaseSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => (
            entry.event_type === 'REVIEW_PHASE_STARTED'
            && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
        )
    );
    if (latestCompilePassSequence == null) {
        return latestReviewPhaseSequence;
    }
    if (latestReviewPhaseSequence == null) {
        return latestCompilePassSequence;
    }
    return Math.max(latestCompilePassSequence, latestReviewPhaseSequence);
}

export function assertNoCurrentCycleReviewRecordedBeforeRouting(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    reviewType: string
): void {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const cycleFloorSequence = resolveReviewCycleFloorSequence(timelineEvents, normalizedReviewType);
    if (cycleFloorSequence == null) {
        return;
    }
    const recordedReview = [...timelineEvents].reverse().find((entry) => (
        entry.sequence > cycleFloorSequence
        && entry.event_type === 'REVIEW_RECORDED'
        && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
    ));
    if (!recordedReview) {
        return;
    }
    throw new Error(
        `Review routing for '${normalizedReviewType}' is locked because current-cycle REVIEW_RECORDED telemetry already exists. ` +
        'Do not record a new REVIEWER_DELEGATION_ROUTED event after a review result has been recorded for the same review type. ' +
        'If a fresh reviewer is required, run restart-review-cycle or restart-coherent-cycle first so downstream review evidence is explicitly invalidated; this does not require a full task reset.'
    );
}

export function findMatchingReviewerInvocationAttestationEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    options: {
        taskId: string;
        reviewType: string;
        reviewerExecutionMode: ReviewerExecutionMode;
        reviewerIdentity: string;
        reviewContextSha256: string;
        reviewTreeStateSha256?: string | null;
        routingEventSha256: string;
    }
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(options.reviewType || '').trim().toLowerCase();
    const normalizedTaskId = String(options.taskId || '').trim();
    const normalizedReviewContextSha256 = String(options.reviewContextSha256 || '').trim().toLowerCase();
    const normalizedReviewTreeStateSha256 = String(options.reviewTreeStateSha256 || '').trim().toLowerCase();
    const normalizedRoutingEventSha256 = String(options.routingEventSha256 || '').trim().toLowerCase();
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        const details = entry.details;
        const detailsTaskId = String(details?.task_id || details?.taskId || '').trim();
        const detailsReviewContextSha256 = String(details?.review_context_sha256 || details?.reviewContextSha256 || '')
            .trim()
            .toLowerCase();
        const detailsReviewTreeStateSha256 = String(details?.review_tree_state_sha256 || details?.reviewTreeStateSha256 || '')
            .trim()
            .toLowerCase();
        const detailsRoutingEventSha256 = String(details?.routing_event_sha256 || details?.routingEventSha256 || '')
            .trim()
            .toLowerCase();
        const detailsReviewerIdentity = String(
            (details?.reviewer_session_id ?? details?.reviewerSessionId ?? details?.reviewer_identity ?? details?.reviewerIdentity) || ''
        ).trim();
        if (
            entry.event_type === 'REVIEWER_INVOCATION_ATTESTED'
            && (!detailsTaskId || detailsTaskId === normalizedTaskId)
            && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === options.reviewerExecutionMode
            && detailsReviewerIdentity === options.reviewerIdentity
            && detailsReviewContextSha256 === normalizedReviewContextSha256
            && (!normalizedReviewTreeStateSha256 || detailsReviewTreeStateSha256 === normalizedReviewTreeStateSha256)
            && detailsRoutingEventSha256 === normalizedRoutingEventSha256
            && entry.integrity
        ) {
            return entry;
        }
    }
    return null;
}
