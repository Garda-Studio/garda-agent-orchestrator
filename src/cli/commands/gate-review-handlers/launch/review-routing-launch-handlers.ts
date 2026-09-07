import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    applyReviewerRoutingMetadata,
    assertValidTaskId,
    assertRequiredUpstreamReviewDependencies,
    assertReviewLifecycleGuard,
    assertReviewTreeStateFresh,
    emitReviewerDelegationRoutedEventAsync,
    fileSha256,
    gateHelpers,
    normalizePath,
    resolveCanonicalReviewContextPath,
    restoreReviewerRoutingMetadata,
    taskEventAppendHasBlockingFailure
} from './review-launch-entrypoints';
import { parseOptions, normalizePathValue } from '../../cli-helpers';
import {
    type ParsedOptionsRecord
} from '../../shared-command-utils';
import { readDependencyTimelineEvents } from '../result/review-dependency-timeline';
import { inspectTaskEventFile } from '../../../../gate-runtime/task-events-integrity';
import { createPrepareReviewerLaunchHandler } from './review-launch-prepare-handler';
import { createCompleteReviewerLaunchHandler } from './review-launch-complete-handler';
import { createReviewerDelegationStartedHandler } from './review-launch-delegation-started-handler';
import { createReviewerLaunchFailedHandler } from './review-launch-failed-handler';
import {
    isCompletedReviewerLaunchAttemptConsumed,
    isReviewerLaunchAttemptSupersededByAuthenticatedRestart
} from './reviewer-handoff-support';
import {
    getReviewerLaunchLaneReservationPath,
    getReviewerLaunchSemanticPathKey,
    REVIEWER_LAUNCH_LANE_RESERVATION_EVIDENCE_TYPE,
    withReviewerLaunchLaneTransaction
} from './reviewer-launch-lane-transaction';
import {
    parseReviewerIdentity,
    resolveReviewerIdentityOption
} from './reviewer-identity-options';
import { buildOperatorNextActionBlock } from '../../../../gates/shared/operator-action-output';
import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleNameForTarget
} from '../../../../core/constants';

export interface ReviewRoutingLaunchHandlerDependencies {
    assertExplicitReviewContextRuntimeIdentity: typeof import('../index').assertExplicitReviewContextRuntimeIdentity;
    assertNoCurrentCycleReviewRecordedBeforeRouting: typeof import('../index').assertNoCurrentCycleReviewRecordedBeforeRouting;
    assertPreparedReviewerLaunchArtifact: typeof import('../index').assertPreparedReviewerLaunchArtifact;
    assertReviewContextContractOrThrow: typeof import('../index').assertReviewContextContractOrThrow;
    assertRoutingCompatibility: typeof import('../index').assertRoutingCompatibility;
    buildCopyPasteReviewerLaunchPrompt: typeof import('../index').buildCopyPasteReviewerLaunchPrompt;
    buildRecordReviewInvocationCommand: typeof import('../index').buildRecordReviewInvocationCommand;
    buildReviewerLaunchBindingSha256: typeof import('../index').buildReviewerLaunchBindingSha256;
    buildReviewerLaunchInputHandoffArtifact: typeof import('../index').buildReviewerLaunchInputHandoffArtifact;
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE: typeof import('../index').COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE;
    findMatchingReviewerLaunchInputPinnedEvent: typeof import('../index').findMatchingReviewerLaunchInputPinnedEvent;
    findMatchingReviewerLaunchPreparedEvent: typeof import('../index').findMatchingReviewerLaunchPreparedEvent;
    findRecoverableReviewerLaunchPreparedEvent: typeof import('../index').findRecoverableReviewerLaunchPreparedEvent;
    findMatchingRoutingEvent: typeof import('../index').findMatchingRoutingEvent;
    getCurrentPreparedReviewerLaunchMismatches: typeof import('../index').getCurrentPreparedReviewerLaunchMismatches;
    getReviewTreeStateLaunchSummary: typeof import('../index').getReviewTreeStateLaunchSummary;
    getReviewTreeStateSha256: typeof import('../index').getReviewTreeStateSha256;
    getReviewerScopedDiffHandoffPaths: typeof import('../index').getReviewerScopedDiffHandoffPaths;
    getStringField: typeof import('../index').getStringField;
    handleRecordReviewInvocation: typeof import('../index').handleRecordReviewInvocation;
    handleRecordReviewInvocationWithLaneHeld: (gateArgv: string[]) => Promise<void>;
    isCurrentCompletedReviewerLaunchArtifact: typeof import('../index').isCurrentCompletedReviewerLaunchArtifact;
    isForbiddenReviewerLaunchAttestationSource: typeof import('../index').isForbiddenReviewerLaunchAttestationSource;
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY: typeof import('../index').LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY;
    normalizeReviewerLaunchAttestationSource: typeof import('../index').normalizeReviewerLaunchAttestationSource;
    parseReviewerIdentity: typeof import('../index').parseReviewerIdentity;
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE: typeof import('../index').PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE;
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE: typeof import('../index').PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE;
    printCopyPasteReviewerLaunchPrompt: typeof import('../index').printCopyPasteReviewerLaunchPrompt;
    readJsonFile: typeof import('../index').readJsonFile;
    readJsonObjectIfPresent: typeof import('../index').readJsonObjectIfPresent;
    resolveCanonicalPreflightArtifactPath: typeof import('../index').resolveCanonicalPreflightArtifactPath;
    resolveProviderLaunchMetadata: typeof import('../index').resolveProviderLaunchMetadata;
    resolveReviewerHandoffBindings: typeof import('../index').resolveReviewerHandoffBindings;
    resolveReviewerDraftOutputPath: typeof import('../index').resolveReviewerDraftOutputPath;
    resolveReviewerLaunchArtifactPathForWrite: typeof import('../index').resolveReviewerLaunchArtifactPathForWrite;
    resolveReviewerLaunchInputArtifactPath: typeof import('../index').resolveReviewerLaunchInputArtifactPath;
    resolveReviewerLaunchInputAttestation: typeof import('../index').resolveReviewerLaunchInputAttestation;
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS: typeof import('../index').REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS;
    snapshotSupersededReviewerLaunchArtifact: typeof import('../index').snapshotSupersededReviewerLaunchArtifact;
    stringSha256: typeof import('../index').stringSha256;
    toReviewerHandoffAbsolutePath: typeof import('../index').toReviewerHandoffAbsolutePath;
}

function buildCliPrefix(repoRoot: string): string {
    return fs.existsSync(path.join(path.resolve(repoRoot), 'bin', 'garda.js'))
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(repoRoot));
}

function buildNavigatorCommand(repoRoot: string, taskId: string): string {
    return `${buildCliPrefix(repoRoot)} next-step "${taskId}" --repo-root "."`;
}

function isCleanedLaunchConsumptionAuthenticated(
    timelinePath: string,
    taskId: string,
    timelineEvents: ReturnType<typeof readDependencyTimelineEvents>,
    completionSequence: number,
    launchDetails: Record<string, unknown>
): boolean {
    if (!inspectTaskEventFile(timelinePath, taskId).status.startsWith('PASS')) return false;
    const authenticatedHashes = new Set<string>();
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n').filter((entry) => entry.trim())) {
        const event = JSON.parse(line);
        if (event.task_id === taskId && event.actor === 'orchestrator' && event.details?.task_id === taskId
            && event.integrity?.event_sha256) {
            authenticatedHashes.add(event.integrity.event_sha256);
        }
    }
    const authenticatedEvents = timelineEvents.filter((event) => event.sequence >= completionSequence
        && event.integrity?.event_sha256 && authenticatedHashes.has(event.integrity.event_sha256));
    return authenticatedEvents.some((event) => event.sequence === completionSequence)
        && isCompletedReviewerLaunchAttemptConsumed(authenticatedEvents, launchDetails);
}

export function createReviewRoutingLaunchHandlers(deps: ReviewRoutingLaunchHandlerDependencies) {
    const {
        assertExplicitReviewContextRuntimeIdentity,
        assertNoCurrentCycleReviewRecordedBeforeRouting,
        assertReviewContextContractOrThrow,
        assertRoutingCompatibility,
        getStringField,
        readJsonObjectIfPresent,
        resolveCanonicalPreflightArtifactPath,
        resolveReviewerLaunchArtifactPathForWrite,
        toReviewerHandoffAbsolutePath
    } = deps;


async function handleRecordReviewRouting(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-routing', 'review_phase');
    const canonicalLaunchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
        repoRoot,
        taskId,
        reviewType,
        artifactPathValue: undefined
    });
    return await withReviewerLaunchLaneTransaction(canonicalLaunchArtifactPath, async () => {
    const reviewsRoot = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const contextPath = resolveCanonicalReviewContextPath({
        reviewsRoot,
        taskId,
        reviewType,
        explicitPath: options.reviewContextPath ? String(options.reviewContextPath) : '',
        repoRoot
    });
    if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
        throw new Error(`Review context artifact not found: ${normalizePath(contextPath)}.`);
    }

    const reviewerIdentity = resolveReviewerIdentityOption(options, taskId, reviewType);
    const { reviewerExecutionMode, reviewerFallbackReason } = parseReviewerIdentity(
        {
            ...options,
            reviewerIdentity
        },
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'.",
        { allowPlannedIdentity: true }
    );
    const preflightPath = resolveCanonicalPreflightArtifactPath(repoRoot, taskId);
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(preflightPath);
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const launchArtifactPaths = new Set<string>([
        canonicalLaunchArtifactPath
    ]);
    const latestLaunchEventByArtifactPath = new Map<string, {
        eventType: string;
        attemptId: string;
        sequence: number;
        details: Record<string, unknown>;
    }>();
    const laneReservationPath = getReviewerLaunchLaneReservationPath(canonicalLaunchArtifactPath);
    const laneReservationExists = fs.existsSync(laneReservationPath);
    const laneReservation = readJsonObjectIfPresent(laneReservationPath);
    if (laneReservationExists && !laneReservation) {
        throw new Error(
            `Reviewer launch lane reservation must contain valid JSON object metadata: ` +
            `${normalizePath(laneReservationPath)}.`
        );
    }
    if (laneReservation) {
        const reservedTaskId = getStringField(laneReservation, 'task_id', 'taskId');
        const reservedReviewType = getStringField(laneReservation, 'review_type', 'reviewType').toLowerCase();
        const reservedEvidenceType = getStringField(laneReservation, 'evidence_type', 'evidenceType');
        const reservedArtifactPathValue = getStringField(
            laneReservation,
            'reviewer_launch_artifact_path',
            'reviewerLaunchArtifactPath'
        );
        if (
            Number(laneReservation.schema_version) !== 1
            || reservedEvidenceType !== REVIEWER_LAUNCH_LANE_RESERVATION_EVIDENCE_TYPE
            || reservedTaskId !== taskId
            || reservedReviewType !== reviewType
            || !reservedArtifactPathValue
        ) {
            throw new Error(
                `Reviewer launch lane reservation is malformed or belongs to another lane: ` +
                `${normalizePath(laneReservationPath)}.`
            );
        }
        launchArtifactPaths.add(resolveReviewerLaunchArtifactPathForWrite({
            repoRoot,
            taskId,
            reviewType,
            artifactPathValue: reservedArtifactPathValue
        }));
    }
    for (const timelineEvent of timelineEvents) {
        if (
            timelineEvent.event_type !== 'REVIEWER_LAUNCH_PREPARED'
            && timelineEvent.event_type !== 'REVIEWER_DELEGATION_STARTED'
            && timelineEvent.event_type !== 'REVIEWER_LAUNCH_COMPLETED'
            && timelineEvent.event_type !== 'REVIEWER_LAUNCH_FAILED'
        ) {
            continue;
        }
        const details = timelineEvent.details;
        if (getStringField(details || {}, 'review_type', 'reviewType').toLowerCase() !== reviewType) {
            continue;
        }
        if (getStringField(details || {}, 'invocation_role', 'invocationRole') === 'review_output_correction') {
            continue;
        }
        const artifactPathValue = getStringField(
            details || {},
            'reviewer_launch_artifact_path',
            'reviewerLaunchArtifactPath'
        );
        if (artifactPathValue) {
            const resolvedArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
                repoRoot,
                taskId,
                reviewType,
                artifactPathValue
            });
            launchArtifactPaths.add(resolvedArtifactPath);
            latestLaunchEventByArtifactPath.set(getReviewerLaunchSemanticPathKey(resolvedArtifactPath), {
                eventType: timelineEvent.event_type,
                sequence: timelineEvent.sequence,
                details: details || {},
                attemptId: getStringField(
                    details || {},
                    'reviewer_launch_attempt_id',
                    'reviewerLaunchAttemptId'
                ) || 'legacy-unidentified'
            });
        }
    }
    for (const launchArtifactPath of launchArtifactPaths) {
        const launchArtifactExists = fs.existsSync(launchArtifactPath);
        const currentLaunchArtifact = readJsonObjectIfPresent(launchArtifactPath);
        if (!currentLaunchArtifact) {
            const latestLaunchEvent = latestLaunchEventByArtifactPath.get(
                getReviewerLaunchSemanticPathKey(launchArtifactPath)
            );
            // Terminal cleanup can remove control files after the result has consumed the launch.
            if (!launchArtifactExists
                && latestLaunchEvent?.eventType === 'REVIEWER_LAUNCH_COMPLETED'
                && isCleanedLaunchConsumptionAuthenticated(
                    timelinePath, taskId, timelineEvents, latestLaunchEvent.sequence, latestLaunchEvent.details
                )) {
                continue;
            }
            if (launchArtifactExists || (
                latestLaunchEvent
                && latestLaunchEvent.eventType !== 'REVIEWER_LAUNCH_FAILED'
            )) {
                throw new Error(
                    `Reviewer launch control artifact is ${launchArtifactExists ? 'malformed' : 'missing'} for ` +
                    `recorded ${latestLaunchEvent?.eventType || 'lane reservation'} attempt ` +
                    `'${latestLaunchEvent?.attemptId || 'unknown'}': ${normalizePath(launchArtifactPath)}. ` +
                    'Restore or fail the recorded attempt before rerouting.'
                );
            }
            continue;
        }
        if (isReviewerLaunchAttemptSupersededByAuthenticatedRestart(
            timelinePath,
            taskId,
            reviewType,
            launchArtifactPath,
            currentLaunchArtifact
        )) {
            continue;
        }
        const launchState = getStringField(currentLaunchArtifact, 'attestation_state', 'attestationState');
        const completedAttemptIsConsumed = launchState === 'launched'
            && isCompletedReviewerLaunchAttemptConsumed(timelineEvents, currentLaunchArtifact);
        if (
            launchState === 'prepared'
            || launchState === 'delegation_started'
            || (launchState === 'launched' && !completedAttemptIsConsumed)
        ) {
            const attemptId = getStringField(
                currentLaunchArtifact,
                'reviewer_launch_attempt_id',
                'reviewerLaunchAttemptId'
            ) || 'legacy-unidentified';
            throw new Error(
                `The immutable reviewer launch attempt is already ${launchState} for '${reviewType}' ` +
                `(attempt '${attemptId}'). Complete the current attempt or record-reviewer-launch-failed before rerouting.`
            );
        }
    }
    assertRequiredUpstreamReviewDependencies({
        taskId,
        preflightPath,
        preflightPayload,
        reviewType,
        timelineEvents,
        taskModePath: String(options.taskModePath || '').trim()
    });
    assertNoCurrentCycleReviewRecordedBeforeRouting(timelineEvents, reviewType);

    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    assertReviewContextContractOrThrow({
        taskId,
        reviewType,
        contextPath,
        reviewContext: parsedReviewContext,
        preflightPath,
        preflightSha256,
        preflightPayload,
        requireStrictBindingMetadata: !!options.reviewContextPath,
        repoRoot
    });
    assertReviewTreeStateFresh({
        repoRoot,
        reviewContext: parsedReviewContext,
        contextPath,
        gateName: 'record-review-routing'
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const runtimeIdentity = assertExplicitReviewContextRuntimeIdentity({
        repoRoot,
        taskId,
        reviewType,
        contextPath,
        reviewerRouting: currentRouting,
        taskModePath: String(options.taskModePath || '').trim()
    });
    assertRoutingCompatibility({
        reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode,
        reviewerFallbackReason
    });

    const previousRoutingUpdate = {
        actualExecutionMode: currentRouting?.actual_execution_mode != null
            ? String(currentRouting.actual_execution_mode).trim() || null
            : null,
        reviewerSessionId: currentRouting?.reviewer_session_id != null
            ? String(currentRouting.reviewer_session_id).trim() || null
            : null,
        fallbackReason: currentRouting?.fallback_reason != null
            ? String(currentRouting.fallback_reason).trim() || null
            : null
    };
    let routingUpdate = {
        updated: false,
        contextSha256: null as string | null
    };
    const orchestratorRoot = gateHelpers.joinOrchestratorPath(repoRoot, '');
    let routingError: unknown = null;
    try {
        routingUpdate = applyReviewerRoutingMetadata(contextPath, {
            actualExecutionMode: reviewerExecutionMode,
            reviewerSessionId: reviewerIdentity,
            fallbackReason: reviewerFallbackReason
        });
        const routedEvent = await emitReviewerDelegationRoutedEventAsync(
            orchestratorRoot,
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewerFallbackReason
        );
        if (!routedEvent || taskEventAppendHasBlockingFailure(routedEvent, false)) {
            routingError = new Error(
                `Review routing requires REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}'. ` +
                'The lifecycle event could not be persisted.'
            );
        }
    } catch (error: unknown) {
        routingError = error;
    }
    if (routingError !== null) {
        try {
            restoreReviewerRoutingMetadata(contextPath, previousRoutingUpdate);
        } catch {
            // Best-effort rollback only.
        }
        throw routingError;
    }
    console.log(buildOperatorNextActionBlock({
        status: 'PASSED',
        gate: 'record-review-routing',
        action: 'Record fresh delegated review routing',
        reason: `Routing telemetry recorded for '${reviewType}'.`,
        command: buildNavigatorCommand(repoRoot, taskId),
        detailsPath: contextPath,
        detailsHint: 'Review routing details and context hashes are listed below.'
    }).join('\n'));
    console.log('');
    console.log(
        `REVIEW_ROUTING_RECORDED: ${reviewType} ` +
        `(Context: ${toReviewerHandoffAbsolutePath(repoRoot, contextPath)}, ` +
        `Sha256: ${routingUpdate.contextSha256 || 'n/a'}, ` +
        `RoutedReviewContextSha256: ${routingUpdate.contextSha256 || 'n/a'})`
    );
    });
}




    const handlePrepareReviewerLaunch = createPrepareReviewerLaunchHandler(deps);
    const handleCompleteReviewerLaunch = createCompleteReviewerLaunchHandler(deps);
    const handleRecordReviewerDelegationStarted = createReviewerDelegationStartedHandler(deps);
    const handleRecordReviewerLaunchFailed = createReviewerLaunchFailedHandler(deps);

    return {
        handleRecordReviewRouting,
        handlePrepareReviewerLaunch,
        handleRecordReviewerDelegationStarted,
        handleRecordReviewerLaunchFailed,
        handleCompleteReviewerLaunch
    };
}
