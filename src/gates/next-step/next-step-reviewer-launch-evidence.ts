import * as path from 'node:path';

import {
    readTaskTimelineJsonlEntries,
    type TaskTimelineJsonlEntry
} from '../../gate-runtime/timeline/task-events-helpers';

import {
    getProviderEntryById,
    normalizeProviderId
} from '../../core/provider-registry';
import {
    fileSha256,
    isPathRealpathInsideRoot,
    resolvePathInsideRepo
} from '../shared/helpers';
import {
    inspectTaskEventFile
} from '../../gate-runtime/task-events-integrity';
import {
    resolveDefaultReviewScratchPath
} from '../review/review-scratch-paths';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import type {
    ReviewArtifactState
} from './next-step-review-artifact-readers';
import {
    buildPlannedReviewerIdentity,
    reviewerIdentityMatchesDelegatedLaunchCycle
} from '../../gate-runtime/review/reviewer-identity-contract';
import type {
    DelegatedReviewLaunchArtifactState
} from './next-step-review-readiness-routing';
import {
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    PROVIDER_FAILED_ATTESTATION_STATES,
    fileExists,
    getArtifactStringField,
    getLatestTaskSequenceForEventTypes,
    isPlainRecord,
    stringSha256
} from './next-step-reviewer-launch-evidence-shared';
import {
    hasCompletedReviewerLaunchEvidence,
    hasDelegationStartedEvidence
} from './next-step-reviewer-launch-evidence-validation';
import { isAuthenticatedReviewRestartBoundary } from '../review/review-restart-boundary';
import {
    findMatchingReviewerDelegationStartedTelemetry,
    getDelegatedReviewRoutingShaAfterCompile,
    hasControllerResumeAfterSequence,
    hasMatchingReviewerDelegationStartedTelemetry,
    hasMatchingReviewerLaunchCompletedTelemetry,
    hasMatchingReviewerProviderFailureTelemetry,
    resolveReviewerLaunchArtifactPathFromTelemetry
} from './next-step-reviewer-launch-evidence-telemetry';
import { withNextStepReviewEvidenceSnapshot } from './next-step-review-timeline-evidence';

export {
    getDelegatedReviewRoutingShaAfterCompile
} from './next-step-reviewer-launch-evidence-telemetry';

export interface CurrentReviewerLaunchArtifactEvidence {
    state: DelegatedReviewLaunchArtifactState;
    path: string | null;
    sha256: string | null;
    launchInputArtifactPath: string | null;
    launchInputArtifactSha256: string | null;
    launchInputMode: 'copy_paste_prompt' | 'launch_artifact_path' | null;
    launchInputSha256: string | null;
    copyPasteReviewerLaunchPromptSha256: string | null;
    reviewOutputPath: string | null;
    reviewerIdentity: string | null;
    reviewContextSha256: string | null;
    orphanedReason: string | null;
    providerInvocationId: string | null;
    controllerInvocationId: string | null;
    attestationSource: string | null;
}

interface PreparedReviewerLaunchInputPin {
    path: string;
    sha256: string;
    eventSha256: string;
    eventTaskSequence: number;
}

function reviewerLaunchEvidencePathsEqual(left: string, right: string): boolean {
    const normalizeForComparison = (value: string): string => {
        const normalizedPath = path.normalize(path.resolve(value));
        return process.platform === 'win32'
            ? normalizedPath.toLowerCase()
            : normalizedPath;
    };
    return normalizeForComparison(left) === normalizeForComparison(right);
}

function findPreparedReviewerLaunchInputPin(options: {
    repoRoot: string;
    lines: readonly TaskTimelineJsonlEntry[];
    preparedEventIndex: number;
    preparedLaunchEventSha256: string;
    launchArtifactPath: string;
    preparedInputArtifactPath: unknown;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    plannedReviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    launchBindingSha256: string;
    reviewerLaunchAttemptId: string;
}): PreparedReviewerLaunchInputPin | null {
    const preparedInputArtifactPath = resolveReviewerLaunchArtifactPathFromTelemetry(
        options.repoRoot,
        options.preparedInputArtifactPath
    );
    if (!preparedInputArtifactPath) {
        return null;
    }
    for (let index = options.preparedEventIndex + 1; index < options.lines.length; index += 1) {
        try {
            const event = options.lines[index].record;
            if (!event) {
                continue;
            }
            if (isAuthenticatedReviewRestartBoundary(event, options.taskId, options.reviewType)) {
                return null;
            }
            if (String(event.event_type || '').trim() !== 'REVIEWER_LAUNCH_INPUT_PINNED') {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
            const inputArtifactPath = resolveReviewerLaunchArtifactPathFromTelemetry(
                options.repoRoot,
                getArtifactStringField(
                    details,
                    'reviewer_launch_input_artifact_path',
                    'reviewerLaunchInputArtifactPath'
                )
            );
            const pinnedLaunchArtifactPath = resolveReviewerLaunchArtifactPathFromTelemetry(
                options.repoRoot,
                getArtifactStringField(
                    details,
                    'reviewer_launch_artifact_path',
                    'reviewerLaunchArtifactPath'
                )
            );
            const inputArtifactSha256 = getArtifactStringField(
                details,
                'reviewer_launch_input_artifact_sha256',
                'reviewerLaunchInputArtifactSha256'
            ).toLowerCase();
            const eventSha256 = getArtifactStringField(integrity, 'event_sha256').toLowerCase();
            const eventTaskSequence = Number(integrity.task_sequence);
            if (
                getArtifactStringField(details, 'task_id', 'taskId') !== options.taskId
                || getArtifactStringField(details, 'review_type', 'reviewType') !== options.reviewType
                || getArtifactStringField(details, 'reviewer_execution_mode', 'reviewerExecutionMode') !== 'delegated_subagent'
                || !reviewerIdentityMatchesDelegatedLaunchCycle({
                    observedIdentity: getArtifactStringField(
                        details,
                        'reviewer_identity',
                        'reviewerIdentity',
                        'reviewer_session_id',
                        'reviewerSessionId'
                    ),
                    expectedIdentity: options.reviewerIdentity,
                    taskId: options.taskId,
                    reviewType: options.reviewType,
                    plannedReviewerIdentity: options.plannedReviewerIdentity
                })
                || getArtifactStringField(details, 'review_context_sha256', 'reviewContextSha256').toLowerCase()
                    !== options.reviewContextSha256
                || getArtifactStringField(details, 'routing_event_sha256', 'routingEventSha256').toLowerCase()
                    !== options.routingEventSha256
                || getArtifactStringField(details, 'launch_binding_sha256', 'launchBindingSha256').toLowerCase()
                    !== options.launchBindingSha256
                || getArtifactStringField(details, 'reviewer_launch_attempt_id', 'reviewerLaunchAttemptId')
                    !== options.reviewerLaunchAttemptId
                || getArtifactStringField(details, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256').toLowerCase()
                    !== options.preparedLaunchEventSha256
                || !inputArtifactPath
                || !reviewerLaunchEvidencePathsEqual(inputArtifactPath, preparedInputArtifactPath)
                || !pinnedLaunchArtifactPath
                || !reviewerLaunchEvidencePathsEqual(pinnedLaunchArtifactPath, options.launchArtifactPath)
                || !/^[0-9a-f]{64}$/.test(inputArtifactSha256)
                || !/^[0-9a-f]{64}$/.test(eventSha256)
                || !Number.isInteger(eventTaskSequence)
                || eventTaskSequence < 1
            ) {
                continue;
            }
            return {
                path: inputArtifactPath,
                sha256: inputArtifactSha256,
                eventSha256,
                eventTaskSequence
            };
        } catch {
            // Timeline integrity is verified before prepared launch evidence is inspected.
        }
    }
    return null;
}

function resolveLaunchArtifactPathForPreparedEvent(options: {
    repoRoot: string;
    lines: readonly TaskTimelineJsonlEntry[];
    preparedEventIndex: number;
    preparedLaunchEventSha256: string;
    preparedArtifactPath: unknown;
    taskId: string;
    reviewType: string;
    reviewContextSha256: string;
    routingEventSha256: string;
}): string {
    const candidates: string[] = [];
    const addCandidate = (rawPath: unknown): void => {
        const resolved = resolveReviewerLaunchArtifactPathFromTelemetry(options.repoRoot, rawPath);
        if (resolved && !candidates.some((candidate) => reviewerLaunchEvidencePathsEqual(candidate, resolved))) {
            candidates.push(resolved);
        }
    };
    for (let index = options.lines.length - 1; index > options.preparedEventIndex; index -= 1) {
        try {
            const event = options.lines[index].record;
            if (!event) {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            if (
                getArtifactStringField(details, 'task_id', 'taskId') === options.taskId
                && getArtifactStringField(details, 'review_type', 'reviewType') === options.reviewType
                && getArtifactStringField(
                    details,
                    'review_context_sha256',
                    'reviewContextSha256'
                ).toLowerCase() === options.reviewContextSha256
                && getArtifactStringField(
                    details,
                    'routing_event_sha256',
                    'routingEventSha256'
                ).toLowerCase() === options.routingEventSha256
            ) {
                addCandidate(getArtifactStringField(
                    details,
                    'reviewer_launch_artifact_path',
                    'reviewerLaunchArtifactPath'
                ));
            }
        } catch {
            // Timeline integrity is verified before this helper is called.
        }
    }
    addCandidate(options.preparedArtifactPath);
    addCandidate(resolveDefaultReviewScratchPath(
        options.repoRoot,
        options.taskId,
        options.reviewType,
        'reviewer-launch.json'
    ));
    return candidates.find((candidate) => {
        const artifact = safeReadJson(candidate);
        return artifact != null
            && getArtifactStringField(
                artifact,
                'prepared_launch_event_sha256',
                'preparedLaunchEventSha256'
            ).toLowerCase() === options.preparedLaunchEventSha256;
    }) || candidates[0] || resolveDefaultReviewScratchPath(
        options.repoRoot,
        options.taskId,
        options.reviewType,
        'reviewer-launch.json'
    );
}

function authenticateFindingsValidationArtifact(
    repoRoot: string,
    launchArtifact: Record<string, unknown>
): { path: string; sha256: string } | null {
    const claimedPath = getArtifactStringField(
        launchArtifact,
        'review_findings_validation_artifact_path',
        'reviewFindingsValidationArtifactPath'
    );
    const claimedSha256 = getArtifactStringField(
        launchArtifact,
        'review_findings_validation_artifact_sha256',
        'reviewFindingsValidationArtifactSha256'
    ).toLowerCase();
    try {
        const resolvedPath = resolvePathInsideRepo(claimedPath, repoRoot, {
            allowMissing: false,
            enforceInside: true
        });
        if (
            !resolvedPath
            || !/^[0-9a-f]{64}$/.test(claimedSha256)
            || !isPathRealpathInsideRoot(resolvedPath, repoRoot)
            || fileSha256(resolvedPath)?.toLowerCase() !== claimedSha256
        ) {
            return null;
        }
        return { path: resolvedPath, sha256: claimedSha256 };
    } catch {
        return null;
    }
}

function getReviewContextSha256CandidatesForInvocationMatching(
    state: ReviewArtifactState,
    contextPath: string
): string[] {
    const candidates: string[] = [];
    const currentSha256 = fileSha256(contextPath);
    if (currentSha256) {
        candidates.push(currentSha256);
    }
    const receiptReviewContextSha256 = String(state.receiptReviewContextSha256 || '').trim().toLowerCase();
    for (const candidate of [
        receiptReviewContextSha256 === currentSha256 ? receiptReviewContextSha256 : ''
    ]) {
        if (/^[0-9a-f]{64}$/.test(candidate) && !candidates.includes(candidate)) {
            candidates.push(candidate);
        }
    }
    return candidates;
}

function timelineHasMatchingReviewerRoutingEventSha(options: {
    lines: readonly TaskTimelineJsonlEntry[];
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    plannedReviewerIdentity: string;
    routingEventSha256: string;
}): boolean {
    return options.lines.some((line) => {
        try {
            const event = line.record;
            if (!event) {
                return false;
            }
            if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
                return false;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
            const details = isPlainRecord(event.details) ? event.details : {};
            return String(integrity.event_sha256 || '').trim().toLowerCase() === options.routingEventSha256
                && String(details.review_type || '').trim() === options.reviewType
                && String(details.reviewer_execution_mode || '').trim() === 'delegated_subagent'
                && reviewerIdentityMatchesDelegatedLaunchCycle({
                    observedIdentity: String(details.reviewer_session_id || details.reviewer_identity || '').trim(),
                    expectedIdentity: options.reviewerIdentity,
                    taskId: options.taskId,
                    reviewType: options.reviewType,
                    plannedReviewerIdentity: options.plannedReviewerIdentity
                });
        } catch {
            return false;
        }
    });
}

function findReviewerRoutingEventIndexBySha(
    lines: readonly TaskTimelineJsonlEntry[],
    reviewType: string,
    routingEventSha256: string
): number {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = lines[index].record;
            if (!event) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
            const details = isPlainRecord(event.details) ? event.details : {};
            if (
                String(event.event_type || '').trim() === 'REVIEWER_DELEGATION_ROUTED'
                && String(integrity.event_sha256 || '').trim().toLowerCase() === routingEventSha256
                && String(details.review_type || '').trim() === reviewType
            ) {
                return index;
            }
        } catch {
            // Timeline integrity is verified by the caller.
        }
    }
    return -1;
}

export function timelineHasDelegatedReviewRoutingAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string
): boolean {
    return withNextStepReviewEvidenceSnapshot(eventsRoot, taskId, () => {
        const routingEventSha256 = getDelegatedReviewRoutingShaAfterCompile(
            eventsRoot,
            taskId,
            reviewType,
            reviewerIdentity
        );
        if (!routingEventSha256) {
            return false;
        }
        const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
        if (!fileExists(timelinePath)) {
            return false;
        }
        const timelineIntegrityStatus = inspectTaskEventFile(timelinePath, taskId).status;
        if (timelineIntegrityStatus !== 'PASS' && timelineIntegrityStatus !== 'PASS_WITH_LEGACY_PREFIX') {
            return false;
        }
        const lines = readTaskTimelineJsonlEntries(timelinePath);
        const routingEventIndex = findReviewerRoutingEventIndexBySha(lines, reviewType, routingEventSha256);
        for (let index = lines.length - 1; index > routingEventIndex; index -= 1) {
            try {
                const event = lines[index].record;
                if (!event) {
                    continue;
                }
                if (isAuthenticatedReviewRestartBoundary(event, taskId, reviewType)) {
                    return false;
                }
            } catch {
                // Timeline integrity is verified above.
            }
        }
        return routingEventIndex >= 0;
    });
}

function getCurrentReviewerLaunchArtifactEvidenceForInvocationFromSnapshot(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): CurrentReviewerLaunchArtifactEvidence {
    const missing: CurrentReviewerLaunchArtifactEvidence = {
        state: 'missing_or_invalid',
        path: null,
        sha256: null,
        launchInputArtifactPath: null,
        launchInputArtifactSha256: null,
        launchInputMode: null,
        launchInputSha256: null,
        copyPasteReviewerLaunchPromptSha256: null,
        reviewOutputPath: null,
        reviewerIdentity: null,
        reviewContextSha256: null,
        orphanedReason: null,
        providerInvocationId: null,
        controllerInvocationId: null,
        attestationSource: null
    };
    const contextReviewerIdentity = String(state.contextReviewerIdentity || '').trim();
    const reviewerIdentity = contextReviewerIdentity || buildPlannedReviewerIdentity(taskId, state.reviewType);
    if (!reviewerIdentity.startsWith('agent:') || !state.contextExists || !state.contextCurrent) {
        return missing;
    }
    const plannedReviewerIdentity = buildPlannedReviewerIdentity(taskId, state.reviewType);
    const reviewContextSha256Candidates = getReviewContextSha256CandidatesForInvocationMatching(
        state,
        state.contextPath
    );
    const currentRoutingEventSha256 = getDelegatedReviewRoutingShaAfterCompile(
        eventsRoot,
        taskId,
        state.reviewType,
        reviewerIdentity
    );
    if (reviewContextSha256Candidates.length === 0) {
        return missing;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return missing;
    }
    const timelineIntegrityStatus = inspectTaskEventFile(timelinePath, taskId).status;
    if (timelineIntegrityStatus !== 'PASS' && timelineIntegrityStatus !== 'PASS_WITH_LEGACY_PREFIX') {
        return missing;
    }
    const lines = readTaskTimelineJsonlEntries(timelinePath);
    let latestRestartBoundaryIndex = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = lines[index].record;
            if (!event) {
                continue;
            }
            if (isAuthenticatedReviewRestartBoundary(event, taskId, state.reviewType)) {
                latestRestartBoundaryIndex = index;
                break;
            }
        } catch {
            // Timeline integrity is verified above.
        }
    }
    const currentRoutingEventIndex = currentRoutingEventSha256
        ? findReviewerRoutingEventIndexBySha(lines, state.reviewType, currentRoutingEventSha256)
        : -1;
    const currentRoutingIsAfterRestartBoundary = currentRoutingEventIndex > latestRestartBoundaryIndex;
    const invocationCandidates: Array<{
        reviewContextSha256: string;
        routingEventSha256: string;
        stale: boolean;
    }> = currentRoutingEventSha256 && currentRoutingIsAfterRestartBoundary
        ? reviewContextSha256Candidates.map((reviewContextSha256) => ({
            reviewContextSha256,
            routingEventSha256: currentRoutingEventSha256,
            stale: false
        }))
        : [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = lines[index].record;
            if (!event) {
                continue;
            }
            if (isAuthenticatedReviewRestartBoundary(event, taskId, state.reviewType)) {
                break;
            }
            if (String(event.event_type || '').trim() !== 'REVIEWER_LAUNCH_PREPARED') {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            const reviewContextSha256 = getArtifactStringField(
                details,
                'review_context_sha256',
                'reviewContextSha256'
            ).toLowerCase();
            const routingEventSha256 = getArtifactStringField(
                details,
                'routing_event_sha256',
                'routingEventSha256'
            ).toLowerCase();
            const routingEventIndex = findReviewerRoutingEventIndexBySha(
                lines,
                state.reviewType,
                routingEventSha256
            );
            if (
                !/^[0-9a-f]{64}$/.test(reviewContextSha256)
                || !/^[0-9a-f]{64}$/.test(routingEventSha256)
                || routingEventIndex <= latestRestartBoundaryIndex
                || (
                    reviewContextSha256Candidates.includes(reviewContextSha256)
                    && routingEventSha256 === currentRoutingEventSha256
                )
                || invocationCandidates.some((candidate) => (
                    candidate.reviewContextSha256 === reviewContextSha256
                    && candidate.routingEventSha256 === routingEventSha256
                ))
            ) {
                continue;
            }
            invocationCandidates.push({
                reviewContextSha256,
                routingEventSha256,
                stale: true
            });
        } catch {
            // Timeline integrity is verified above.
        }
    }
    for (const invocationCandidate of invocationCandidates) {
        const { reviewContextSha256, routingEventSha256 } = invocationCandidate;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = lines[index].record;
            if (!event) {
                continue;
            }
            if (String(event.event_type || '').trim() !== 'REVIEWER_LAUNCH_PREPARED') {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const details = isPlainRecord(event.details) ? event.details : {};
            const preparedLaunchEventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
            const launchArtifactPath = resolveLaunchArtifactPathForPreparedEvent({
                repoRoot,
                lines,
                preparedEventIndex: index,
                preparedLaunchEventSha256,
                preparedArtifactPath: details.reviewer_launch_artifact_path,
                taskId,
                reviewType: state.reviewType,
                reviewContextSha256,
                routingEventSha256
            });
            const launchArtifact = safeReadJson(launchArtifactPath);
            if (!launchArtifact) {
                continue;
            }
            const artifactPlannedReviewerIdentity = getArtifactStringField(
                launchArtifact,
                'planned_reviewer_identity',
                'plannedReviewerIdentity'
            );
            const artifactReviewerIdentity = getArtifactStringField(
                launchArtifact,
                'reviewer_identity',
                'reviewerIdentity',
                'reviewer_session_id',
                'reviewerSessionId'
            );
            const artifactReviewContextSha256 = getArtifactStringField(
                launchArtifact,
                'review_context_sha256',
                'reviewContextSha256'
            ).toLowerCase();
            const preparedEventReviewContextSha256 = String(
                details.review_context_sha256 || details.reviewContextSha256 || ''
            ).trim().toLowerCase();
            const currentContextShaMatches = artifactReviewContextSha256 === reviewContextSha256
                && preparedEventReviewContextSha256 === reviewContextSha256;
            const matchedReviewContextSha256 = currentContextShaMatches
                ? artifactReviewContextSha256
                : '';
            const launchBindingSha256 = getArtifactStringField(
                launchArtifact,
                'launch_binding_sha256',
                'launchBindingSha256'
            ).toLowerCase();
            const reviewerLaunchAttemptId = getArtifactStringField(
                launchArtifact,
                'reviewer_launch_attempt_id',
                'reviewerLaunchAttemptId'
            );
            const preparedEventReviewerLaunchAttemptId = getArtifactStringField(
                details,
                'reviewer_launch_attempt_id',
                'reviewerLaunchAttemptId'
            );
            if (
                !/^[0-9a-f]{64}$/.test(preparedLaunchEventSha256)
                || !/^[0-9a-f]{64}$/.test(launchBindingSha256)
                || getArtifactStringField(launchArtifact, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256').toLowerCase() !== preparedLaunchEventSha256
                || getArtifactStringField(launchArtifact, 'task_id', 'taskId') !== taskId
                || getArtifactStringField(launchArtifact, 'review_type', 'reviewType') !== state.reviewType
                || getArtifactStringField(launchArtifact, 'reviewer_execution_mode', 'reviewerExecutionMode') !== 'delegated_subagent'
                || !reviewerIdentityMatchesDelegatedLaunchCycle({
                    observedIdentity: artifactReviewerIdentity,
                    expectedIdentity: reviewerIdentity,
                    taskId,
                    reviewType: state.reviewType,
                    plannedReviewerIdentity,
                    artifactPlannedReviewerIdentity,
                    artifactResolvedReviewerIdentity: artifactReviewerIdentity
                })
                || !timelineHasMatchingReviewerRoutingEventSha({
                    lines,
                    taskId,
                    reviewType: state.reviewType,
                    reviewerIdentity: artifactReviewerIdentity,
                    plannedReviewerIdentity,
                    routingEventSha256
                })
                || findReviewerRoutingEventIndexBySha(
                    lines,
                    state.reviewType,
                    routingEventSha256
                ) <= latestRestartBoundaryIndex
                || !matchedReviewContextSha256
                || getArtifactStringField(launchArtifact, 'routing_event_sha256', 'routingEventSha256').toLowerCase() !== routingEventSha256
                || String(details.review_type || '').trim() !== state.reviewType
                || String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent'
                || !reviewerIdentityMatchesDelegatedLaunchCycle({
                    observedIdentity: String(details.reviewer_session_id || details.reviewer_identity || '').trim(),
                    expectedIdentity: reviewerIdentity,
                    taskId,
                    reviewType: state.reviewType,
                    plannedReviewerIdentity
                })
                || String(details.routing_event_sha256 || '').trim().toLowerCase() !== routingEventSha256
                || String(details.launch_binding_sha256 || '').trim().toLowerCase() !== launchBindingSha256
                || (
                    reviewerLaunchAttemptId
                    && preparedEventReviewerLaunchAttemptId
                    && preparedEventReviewerLaunchAttemptId !== reviewerLaunchAttemptId
                )
            ) {
                continue;
            }
            const evidenceType = getArtifactStringField(launchArtifact, 'evidence_type', 'artifact_type');
            const attestationState = getArtifactStringField(launchArtifact, 'attestation_state', 'attestationState');
            const findingsValidationFailure = evidenceType === COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE
                && attestationState === 'launch_failed'
                && getArtifactStringField(
                    launchArtifact,
                    'launch_failure_stage',
                    'launchFailureStage'
                ) === 'review_findings_validation';
            const authenticatedFindingsValidationArtifact = findingsValidationFailure
                ? authenticateFindingsValidationArtifact(repoRoot, launchArtifact)
                : null;
            const artifactDeclaresProviderFailure = (
                evidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE
                || findingsValidationFailure
            )
                && PROVIDER_FAILED_ATTESTATION_STATES.has(attestationState)
                && hasDelegationStartedEvidence(launchArtifact);
            const launchArtifactSha256 = fileSha256(launchArtifactPath);
            let artifactState: DelegatedReviewLaunchArtifactState = 'missing_or_invalid';
            if (evidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE && attestationState === 'prepared') {
                artifactState = 'prepared';
            } else if (
                evidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE
                && attestationState === 'delegation_started'
                && hasDelegationStartedEvidence(launchArtifact)
            ) {
                artifactState = 'delegation_started';
            } else if (artifactDeclaresProviderFailure) {
                artifactState = 'delegation_started';
            } else if (
                evidenceType === COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE
                && attestationState === 'launched'
                && hasCompletedReviewerLaunchEvidence(launchArtifact)
                && launchArtifactSha256
                && hasMatchingReviewerDelegationStartedTelemetry({
                    lines,
                    taskId,
                    reviewType: state.reviewType,
                    reviewerIdentity,
                    plannedReviewerIdentity,
                    reviewContextSha256: matchedReviewContextSha256,
                    routingEventSha256,
                    launchBindingSha256,
                    preparedLaunchEventSha256,
                    reviewerLaunchAttemptId,
                    providerInvocationId: getArtifactStringField(
                        launchArtifact,
                        'provider_invocation_id',
                        'providerInvocationId',
                        'controller_invocation_id',
                        'controllerInvocationId'
                    ),
                    delegationStartedAtUtc: getArtifactStringField(
                        launchArtifact,
                        'delegation_started_at_utc',
                        'delegationStartedAtUtc'
                    )
                })
            ) {
                artifactState = hasMatchingReviewerLaunchCompletedTelemetry({
                    lines,
                    taskId,
                    reviewType: state.reviewType,
                    reviewerIdentity,
                    plannedReviewerIdentity,
                    reviewContextSha256: matchedReviewContextSha256,
                    routingEventSha256,
                    launchArtifactSha256,
                    providerInvocationId: getArtifactStringField(
                        launchArtifact,
                        'provider_invocation_id',
                        'providerInvocationId',
                        'controller_invocation_id',
                        'controllerInvocationId'
                    ),
                    delegationStartedAtUtc: getArtifactStringField(
                        launchArtifact,
                        'delegation_started_at_utc',
                        'delegationStartedAtUtc'
                    ),
                    launchCompletedAtUtc: getArtifactStringField(
                        launchArtifact,
                        'launch_completed_at_utc',
                        'launchCompletedAtUtc'
                    ),
                    reviewerLaunchAttemptId
                })
                    ? 'launched'
                    : 'completion_recovery';
            }
            if (artifactState === 'missing_or_invalid') {
                continue;
            }
            if (invocationCandidate.stale && artifactState !== 'launched') {
                continue;
            }
            const reviewOutputPath = resolveReviewerLaunchArtifactPathFromTelemetry(
                repoRoot,
                getArtifactStringField(launchArtifact, 'review_output_path', 'reviewOutputPath')
            );
            let orphanedReason: string | null = null;
            const delegationStartedAtUtc = getArtifactStringField(
                launchArtifact,
                'delegation_started_at_utc',
                'delegationStartedAtUtc'
            );
            const matchingDelegationStarted = artifactState === 'delegation_started'
                ? findMatchingReviewerDelegationStartedTelemetry({
                    lines,
                    taskId,
                    reviewType: state.reviewType,
                    reviewerIdentity,
                    plannedReviewerIdentity,
                    reviewContextSha256: matchedReviewContextSha256,
                    routingEventSha256,
                    launchBindingSha256,
                    preparedLaunchEventSha256,
                    reviewerLaunchAttemptId,
                    providerInvocationId: getArtifactStringField(
                        launchArtifact,
                        'provider_invocation_id',
                        'providerInvocationId',
                        'controller_invocation_id',
                        'controllerInvocationId'
                    ),
                    delegationStartedAtUtc
                })
                : null;
            if (artifactState === 'delegation_started' && !matchingDelegationStarted) {
                artifactState = 'delegation_start_recovery';
            }
            const hasMatchingProviderFailure = artifactState === 'delegation_started'
                && (!findingsValidationFailure || authenticatedFindingsValidationArtifact != null)
                && hasMatchingReviewerProviderFailureTelemetry({
                    timelineIntegrityVerified: true,
                    lines,
                    taskId,
                    reviewType: state.reviewType,
                    reviewerIdentity,
                    plannedReviewerIdentity,
                    reviewContextSha256: matchedReviewContextSha256,
                    routingEventSha256,
                    providerInvocationId: getArtifactStringField(
                        launchArtifact,
                        'provider_invocation_id',
                        'providerInvocationId',
                        'controller_invocation_id',
                        'controllerInvocationId'
                    ),
                    delegationStartedAtUtc,
                    delegationStartedSequence: matchingDelegationStarted?.taskSequence ?? null,
                    reviewerLaunchAttemptId,
                    ...(findingsValidationFailure && authenticatedFindingsValidationArtifact
                        ? {
                            reviewerLaunchArtifactSha256: launchArtifactSha256 || '',
                            rejectedReviewerLaunchArtifactSha256: getArtifactStringField(
                                launchArtifact,
                                'rejected_reviewer_launch_artifact_sha256',
                                'rejectedReviewerLaunchArtifactSha256'
                            ),
                            launchFailureStage: 'review_findings_validation',
                            reviewFindingsValidationArtifactPath: authenticatedFindingsValidationArtifact.path,
                            reviewFindingsValidationArtifactSha256: authenticatedFindingsValidationArtifact.sha256
                        }
                        : {})
                })
                && (!findingsValidationFailure || hasMatchingReviewerLaunchCompletedTelemetry({
                    lines,
                    taskId,
                    reviewType: state.reviewType,
                    reviewerIdentity,
                    plannedReviewerIdentity,
                    reviewContextSha256: matchedReviewContextSha256,
                    routingEventSha256,
                    launchArtifactSha256: getArtifactStringField(
                        launchArtifact,
                        'rejected_reviewer_launch_artifact_sha256',
                        'rejectedReviewerLaunchArtifactSha256'
                    ),
                    providerInvocationId: getArtifactStringField(
                        launchArtifact,
                        'provider_invocation_id',
                        'providerInvocationId',
                        'controller_invocation_id',
                        'controllerInvocationId'
                    ),
                    delegationStartedAtUtc,
                    launchCompletedAtUtc: getArtifactStringField(
                        launchArtifact,
                        'launch_completed_at_utc',
                        'launchCompletedAtUtc'
                    ),
                    reviewerLaunchAttemptId
                }));
            if (
                artifactState === 'delegation_started'
                && hasMatchingProviderFailure
            ) {
                artifactState = 'provider_failed';
            } else if (artifactDeclaresProviderFailure) {
                continue;
            }
            if (artifactState === 'delegation_started' && reviewOutputPath && !fileExists(reviewOutputPath)) {
                if (hasControllerResumeAfterSequence(lines, matchingDelegationStarted?.taskSequence ?? null)) {
                    artifactState = 'orphaned';
                    orphanedReason = 'controller_resume_after_delegation_start_with_missing_review_output';
                }
            } else if (
                artifactState === 'launched'
                && reviewOutputPath
                && !fileExists(reviewOutputPath)
                && !(state.artifactExists && state.receiptExists)
            ) {
                artifactState = 'orphaned';
                orphanedReason = 'completed_launch_missing_review_output';
            }
            if (invocationCandidate.stale && artifactState !== 'orphaned') {
                continue;
            }
            if (artifactState === 'provider_failed') {
                const hasStartedTelemetry = matchingDelegationStarted != null;
                if (!hasStartedTelemetry) {
                    continue;
                }
            }
            let launchInputArtifactPath: string | null = null;
            let launchInputArtifactSha256: string | null = null;
            let launchInputMode: 'copy_paste_prompt' | 'launch_artifact_path' | null = null;
            let launchInputSha256: string | null = null;
            const controlInputArtifactPath = resolveReviewerLaunchArtifactPathFromTelemetry(
                repoRoot,
                getArtifactStringField(
                    launchArtifact,
                    'reviewer_launch_input_artifact_path',
                    'reviewerLaunchInputArtifactPath'
                )
            );
            const authenticatedInputPin = findPreparedReviewerLaunchInputPin({
                repoRoot,
                lines,
                preparedEventIndex: index,
                preparedLaunchEventSha256,
                launchArtifactPath,
                preparedInputArtifactPath: getArtifactStringField(
                    details,
                    'reviewer_launch_input_artifact_path',
                    'reviewerLaunchInputArtifactPath'
                ),
                taskId,
                reviewType: state.reviewType,
                reviewerIdentity,
                plannedReviewerIdentity,
                reviewContextSha256: matchedReviewContextSha256,
                routingEventSha256,
                launchBindingSha256,
                reviewerLaunchAttemptId
            });
            if (
                !authenticatedInputPin
                || !controlInputArtifactPath
                || !reviewerLaunchEvidencePathsEqual(controlInputArtifactPath, authenticatedInputPin.path)
                || !fileExists(authenticatedInputPin.path)
            ) {
                continue;
            }
            const controlInputArtifactSha256 = getArtifactStringField(
                launchArtifact,
                'reviewer_launch_input_artifact_sha256',
                'reviewerLaunchInputArtifactSha256'
            ).toLowerCase();
            const controlInputPinnedEventSha256 = getArtifactStringField(
                launchArtifact,
                'reviewer_launch_input_pinned_event_sha256',
                'reviewerLaunchInputPinnedEventSha256'
            ).toLowerCase();
            const controlInputPinnedEventTaskSequence = Number(
                launchArtifact.reviewer_launch_input_pinned_event_task_sequence
                ?? launchArtifact.reviewerLaunchInputPinnedEventTaskSequence
            );
            launchInputArtifactPath = authenticatedInputPin.path;
            launchInputArtifactSha256 = fileSha256(authenticatedInputPin.path);
            const authenticatedInputArtifact = safeReadJson(authenticatedInputPin.path);
            const authenticatedCopyPastePrompt = authenticatedInputArtifact
                ? getArtifactStringField(
                    authenticatedInputArtifact,
                    'copy_paste_reviewer_launch_prompt',
                    'copyPasteReviewerLaunchPrompt'
                )
                : '';
            const authenticatedCopyPastePromptSha256 = authenticatedInputArtifact
                ? getArtifactStringField(
                    authenticatedInputArtifact,
                    'copy_paste_reviewer_launch_prompt_sha256',
                    'copyPasteReviewerLaunchPromptSha256'
                ).toLowerCase()
                : '';
            const controlCopyPastePromptSha256 = getArtifactStringField(
                launchArtifact,
                'copy_paste_reviewer_launch_prompt_sha256',
                'copyPasteReviewerLaunchPromptSha256'
            ).toLowerCase();
            if (
                !launchInputArtifactSha256
                || controlInputArtifactSha256 !== authenticatedInputPin.sha256
                || launchInputArtifactSha256 !== authenticatedInputPin.sha256
                || controlInputPinnedEventSha256 !== authenticatedInputPin.eventSha256
                || controlInputPinnedEventTaskSequence !== authenticatedInputPin.eventTaskSequence
                || !/^[0-9a-f]{64}$/.test(authenticatedCopyPastePromptSha256)
                || stringSha256(authenticatedCopyPastePrompt) !== authenticatedCopyPastePromptSha256
                || controlCopyPastePromptSha256 !== authenticatedCopyPastePromptSha256
            ) {
                continue;
            }
            if (artifactState !== 'prepared') {
                const persistedLaunchInputMode = getArtifactStringField(
                    launchArtifact,
                    'launch_input_mode',
                    'launchInputMode'
                ).toLowerCase();
                if (persistedLaunchInputMode === 'launch_artifact_path') {
                    const attestedLaunchInputArtifactPath = resolveReviewerLaunchArtifactPathFromTelemetry(
                        repoRoot,
                        getArtifactStringField(
                            launchArtifact,
                            'launch_input_artifact_path',
                            'launchInputArtifactPath'
                        )
                    );
                    const attestedLaunchInputSha256 = getArtifactStringField(
                        launchArtifact,
                        'launch_input_sha256',
                        'launchInputSha256'
                    ).toLowerCase();
                    const attestedLaunchInputArtifactSha256 = getArtifactStringField(
                        launchArtifact,
                        'launch_input_artifact_sha256',
                        'launchInputArtifactSha256'
                    ).toLowerCase();
                    if (
                        !attestedLaunchInputArtifactPath
                        || !reviewerLaunchEvidencePathsEqual(
                            attestedLaunchInputArtifactPath,
                            authenticatedInputPin.path
                        )
                        || attestedLaunchInputSha256 !== authenticatedInputPin.sha256
                        || attestedLaunchInputArtifactSha256 !== authenticatedInputPin.sha256
                    ) {
                        continue;
                    }
                    launchInputMode = 'launch_artifact_path';
                    launchInputSha256 = attestedLaunchInputSha256;
                } else if (persistedLaunchInputMode === 'copy_paste_prompt') {
                    const attestedLaunchInputSha256 = getArtifactStringField(
                        launchArtifact,
                        'launch_input_sha256',
                        'launchInputSha256'
                    ).toLowerCase();
                    const copyPastePromptSha256 = getArtifactStringField(
                        launchArtifact,
                        'copy_paste_reviewer_launch_prompt_sha256',
                        'copyPasteReviewerLaunchPromptSha256'
                    ).toLowerCase();
                    if (
                        !/^[0-9a-f]{64}$/.test(attestedLaunchInputSha256)
                        || attestedLaunchInputSha256 !== copyPastePromptSha256
                        || copyPastePromptSha256 !== authenticatedCopyPastePromptSha256
                    ) {
                        continue;
                    }
                    launchInputMode = 'copy_paste_prompt';
                    launchInputSha256 = attestedLaunchInputSha256;
                    launchInputArtifactPath = null;
                    launchInputArtifactSha256 = null;
                } else {
                    continue;
                }
            }
            return {
                state: artifactState,
                path: launchArtifactPath,
                sha256: launchArtifactSha256 || null,
                launchInputArtifactPath,
                launchInputArtifactSha256,
                launchInputMode,
                launchInputSha256,
                copyPasteReviewerLaunchPromptSha256: authenticatedCopyPastePromptSha256,
                reviewOutputPath,
                reviewerIdentity: artifactReviewerIdentity || null,
                reviewContextSha256: matchedReviewContextSha256 || null,
                orphanedReason,
                providerInvocationId: getArtifactStringField(
                    launchArtifact,
                    'provider_invocation_id',
                    'providerInvocationId'
                ) || null,
                controllerInvocationId: getArtifactStringField(
                    launchArtifact,
                    'controller_invocation_id',
                    'controllerInvocationId'
                ) || null,
                attestationSource: artifactState === 'prepared'
                    ? null
                    : getArtifactStringField(
                        launchArtifact,
                        'attestation_source',
                        'attestationSource'
                    ) || null
            };
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    }
    return missing;
}

export function getCurrentReviewerLaunchArtifactEvidenceForInvocation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): CurrentReviewerLaunchArtifactEvidence {
    return withNextStepReviewEvidenceSnapshot(eventsRoot, taskId, () => (
        getCurrentReviewerLaunchArtifactEvidenceForInvocationFromSnapshot(
            repoRoot,
            eventsRoot,
            taskId,
            state
        )
    ));
}

function getCurrentReviewerLaunchArtifactStateForInvocation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): DelegatedReviewLaunchArtifactState {
    return getCurrentReviewerLaunchArtifactEvidenceForInvocation(repoRoot, eventsRoot, taskId, state).state;
}

function timelineHasDelegatedReviewInvocationForCurrentContextFromSnapshot(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    const reviewerIdentity = state.contextReviewerIdentity;
    if (!reviewerIdentity?.startsWith('agent:') || !state.contextExists || !state.contextCurrent) {
        return false;
    }
    const plannedReviewerIdentity = buildPlannedReviewerIdentity(taskId, state.reviewType);
    const reviewContextSha256Candidates = getReviewContextSha256CandidatesForInvocationMatching(
        state,
        state.contextPath
    );
    const reviewTreeStateSha256 = state.contextReviewTreeStateSha256;
    if (reviewContextSha256Candidates.length === 0 || !reviewTreeStateSha256) {
        return false;
    }
    const reviewerLaunchArtifactEvidence = getCurrentReviewerLaunchArtifactEvidenceForInvocation(
        repoRoot,
        eventsRoot,
        taskId,
        state
    );
    if (reviewerLaunchArtifactEvidence.state !== 'launched' || !reviewerLaunchArtifactEvidence.sha256) {
        return false;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null) {
        return false;
    }
    const routingEventSha256 = getDelegatedReviewRoutingShaAfterCompile(
        eventsRoot,
        taskId,
        state.reviewType,
        reviewerIdentity
    );
    if (!routingEventSha256) {
        return false;
    }
    const events = readTaskTimelineJsonlEntries(timelinePath)
        .flatMap((entry) => entry.record ? [entry.record] : []);
    let routingSequence: number | null = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
            continue;
        }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
        const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
        if (eventSha256 !== routingEventSha256) {
            continue;
        }
        const taskSequence = typeof integrity?.task_sequence === 'number'
            ? integrity.task_sequence
            : Number(integrity?.task_sequence);
        if (!Number.isInteger(taskSequence) || taskSequence <= latestCompileSequence) {
            continue;
        }
        routingSequence = taskSequence;
        break;
    }
    if (!routingSequence) {
        return false;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'REVIEWER_INVOCATION_ATTESTED') {
            continue;
        }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
        const taskSequence = typeof integrity?.task_sequence === 'number'
            ? integrity.task_sequence
            : Number(integrity?.task_sequence);
        if (!Number.isInteger(taskSequence) || taskSequence <= routingSequence) {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventReviewerIdentity = String(details.reviewer_identity || details.reviewer_session_id || '').trim();
        if (
            String(details.task_id || '').trim() !== taskId
            || String(details.review_type || '').trim() !== state.reviewType
            || String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent'
            || !reviewerIdentityMatchesDelegatedLaunchCycle({
                observedIdentity: eventReviewerIdentity,
                expectedIdentity: reviewerIdentity,
                taskId,
                reviewType: state.reviewType,
                plannedReviewerIdentity,
                artifactResolvedReviewerIdentity: reviewerLaunchArtifactEvidence.reviewerIdentity
            })
            || !reviewContextSha256Candidates.includes(
                String(details.review_context_sha256 || '').trim().toLowerCase()
            ) && String(details.review_context_sha256 || '').trim().toLowerCase() !== reviewerLaunchArtifactEvidence.reviewContextSha256
            || String(details.review_tree_state_sha256 || '').trim().toLowerCase() !== reviewTreeStateSha256
            || String(details.routing_event_sha256 || '').trim().toLowerCase() !== routingEventSha256
            || String(details.reviewer_launch_artifact_sha256 || '').trim().toLowerCase() !== reviewerLaunchArtifactEvidence.sha256
        ) {
            continue;
        }
        return true;
    }
    return false;
}

export function timelineHasDelegatedReviewInvocationForCurrentContext(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    return withNextStepReviewEvidenceSnapshot(eventsRoot, taskId, () => (
        timelineHasDelegatedReviewInvocationForCurrentContextFromSnapshot(
            repoRoot,
            eventsRoot,
            taskId,
            state
        )
    ));
}

function buildReviewerReadinessChainSummaryFromSnapshot(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    state: ReviewArtifactState | undefined,
    reviewStateHasSatisfiedEvidence: (state: ReviewArtifactState) => boolean
): string {
    const contextStatus = !state || !state.contextExists
        ? 'missing'
        : state.contextCurrent
            ? 'current'
            : 'stale';
    const reviewerIdentity = state?.contextReviewerIdentity || '';
    const routingCurrent = Boolean(
        state
        && contextStatus === 'current'
        && reviewerIdentity.startsWith('agent:')
        && timelineHasDelegatedReviewRoutingAfterCompile(eventsRoot, taskId, reviewType, reviewerIdentity)
    );
    const routingStatus = routingCurrent
        ? 'current'
        : contextStatus !== 'current'
            ? 'blocked until current context'
            : reviewerIdentity
                ? 'missing current-cycle telemetry'
                : 'missing reviewer identity';
    const launchArtifactState = routingCurrent && state
        ? getCurrentReviewerLaunchArtifactStateForInvocation(repoRoot, eventsRoot, taskId, state)
        : 'missing_or_invalid';
    const launchStatus = !routingCurrent
        ? 'blocked until routing'
        : launchArtifactState === 'prepared'
            ? 'prepared'
        : launchArtifactState === 'delegation_start_recovery'
            ? 'delegation start telemetry recovery'
        : launchArtifactState === 'delegation_started'
            ? 'delegation started'
            : launchArtifactState === 'completion_recovery'
                ? 'completion telemetry recovery'
            : launchArtifactState === 'provider_failed'
                ? 'provider failed'
                : launchArtifactState === 'orphaned'
                    ? 'orphaned'
                    : launchArtifactState === 'launched'
                        ? 'launched'
                        : 'missing or stale';
    const invocationCurrent = Boolean(
        state
        && timelineHasDelegatedReviewInvocationForCurrentContext(repoRoot, eventsRoot, taskId, state)
    );
    const invocationStatus = invocationCurrent
        ? 'attested'
        : launchArtifactState === 'launched'
            ? 'missing current-cycle attestation'
            : launchArtifactState === 'completion_recovery'
                ? 'blocked until completion telemetry recovery'
            : launchArtifactState === 'provider_failed'
                ? 'blocked until launch recovery'
            : launchArtifactState === 'orphaned'
                ? 'blocked until launch recovery'
                : launchArtifactState === 'delegation_started'
                    ? 'blocked until launch completion'
                : launchArtifactState === 'delegation_start_recovery'
                    ? 'blocked until delegation start telemetry recovery'
            : launchArtifactState === 'prepared'
                ? 'blocked until launch completion'
                : 'blocked until launch artifact';
    let resultStatus = 'blocked until invocation';
    if (invocationCurrent && state) {
        if (!state.artifactExists && !state.receiptExists) {
            resultStatus = 'review output and receipt missing';
        } else if (!state.artifactExists) {
            resultStatus = 'review output missing';
        } else if (!state.receiptExists) {
            resultStatus = 'receipt missing';
        } else if (!state.ready) {
            resultStatus = 'receipt invalid or stale';
        } else if (!reviewStateHasSatisfiedEvidence(state)) {
            resultStatus = 'receipt missing current-cycle provenance';
        } else {
            resultStatus = 'ready';
        }
    }
    return `Reviewer readiness chain: ${[
        'preflight scope=current',
        `review context=${contextStatus}`,
        `routing=${routingStatus}`,
        `launch artifact=${launchStatus}`,
        `invocation=${invocationStatus}`,
        `review output/receipt=${resultStatus}.`
    ].join(' -> ')}`;
}

export function buildReviewerReadinessChainSummary(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    state: ReviewArtifactState | undefined,
    reviewStateHasSatisfiedEvidence: (state: ReviewArtifactState) => boolean
): string {
    return withNextStepReviewEvidenceSnapshot(eventsRoot, taskId, () => (
        buildReviewerReadinessChainSummaryFromSnapshot(
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            state,
            reviewStateHasSatisfiedEvidence
        )
    ));
}

export function buildProviderNativeReviewerLaunchTargetSummary(taskMode: Record<string, unknown> | null): string {
    const provider = normalizeProviderId(taskMode?.provider);
    const providerEntry = provider ? getProviderEntryById(provider) : null;
    if (!providerEntry) {
        return 'ProviderLaunchTarget: unresolved; launch a provider-native/internal delegated reviewer subagent with a fresh isolated context.';
    }
    return (
        `ProviderLaunchTarget: ${providerEntry.reviewerLaunchLabel || providerEntry.displayLabel}; ` +
        `${providerEntry.delegatedReviewerLaunchInstruction || 'launch a clean-context delegated reviewer subagent with isolated context.'}`
    );
}
