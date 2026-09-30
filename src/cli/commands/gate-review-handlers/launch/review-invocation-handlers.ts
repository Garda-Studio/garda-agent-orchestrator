import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildReviewReceiptReviewerProvenance,
    assertValidTaskId,
    assertReviewLifecycleGuard,
    assertReviewTreeStateFresh,
    emitReviewerInvocationAttestedEventAsync,
    fileSha256,
    gateHelpers,
    normalizeCompatibilityReviewerExecutionMode,
    normalizePath,
    resolveCanonicalReviewContextPath,
    resolveReviewerPromptArtifactBinding,
    taskEventAppendHasBlockingFailure
} from './review-launch-entrypoints';
import {
    parseOptions,
    normalizePathValue
} from '../../cli-helpers';
import {
    type ParsedOptionsRecord
} from '../../shared-command-utils';
import {
    readDependencyTimelineEvents
} from '../result/review-dependency-timeline';
import {
    validateReviewerLaunchArtifact
} from './review-launch-artifact-validation';
import {
    isPlannedReviewerIdentity,
    isResolvedReviewerIdentity
} from '../../../../gate-runtime/review/reviewer-identity-contract';
import {
    getStringField,
    readJsonFile
} from './review-launch-artifact-fields';
import { resolveReviewerLaunchArtifactPathForWrite } from './review-artifact-path-support';
import {
    withReviewerLaunchLaneTransaction
} from './reviewer-launch-lane-transaction';

const RECORD_REVIEW_INVOCATION_OPTION_DEFINITIONS = {
    '--task-id': { key: 'taskId', type: 'string' },
    '--review-type': { key: 'reviewType', type: 'string' },
    '--review-context-path': { key: 'reviewContextPath', type: 'string' },
    '--task-mode-path': { key: 'taskModePath', type: 'string' },
    '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
    '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
    '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
    '--reviewer-launch-artifact-path': { key: 'reviewerLaunchArtifactPath', type: 'string' },
    '--repo-root': { key: 'repoRoot', type: 'string' }
} as const;

export interface ReviewInvocationHandlerDependencies {
    assertExplicitReviewContextRuntimeIdentity: typeof import('../index').assertExplicitReviewContextRuntimeIdentity;
    assertReviewContextContractOrThrow: typeof import('../index').assertReviewContextContractOrThrow;
    assertRoutingCompatibility: typeof import('../index').assertRoutingCompatibility;
    findMatchingRoutingEvent: typeof import('../index').findMatchingRoutingEvent;
    getReviewTreeStateSha256: typeof import('../index').getReviewTreeStateSha256;
    parseReviewerIdentity: typeof import('../index').parseReviewerIdentity;
    resolveCanonicalPreflightArtifactPath: typeof import('../index').resolveCanonicalPreflightArtifactPath;
    resolveReviewerHandoffBindings: typeof import('../index').resolveReviewerHandoffBindings;
}

export function createReviewInvocationHandlers(deps: ReviewInvocationHandlerDependencies) {
    const {
        assertExplicitReviewContextRuntimeIdentity,
        assertReviewContextContractOrThrow,
        assertRoutingCompatibility,
        findMatchingRoutingEvent,
        getReviewTreeStateSha256,
        parseReviewerIdentity,
        resolveCanonicalPreflightArtifactPath,
        resolveReviewerHandoffBindings
    } = deps;

    async function handleRecordReviewInvocationUnlocked(gateArgv: string[]): Promise<void> {
        const { options: rawOptions } = parseOptions(
            gateArgv,
            RECORD_REVIEW_INVOCATION_OPTION_DEFINITIONS,
            { allowPositionals: false }
        );
        const options = rawOptions as ParsedOptionsRecord;
        const taskId = assertValidTaskId(options.taskId);
        const reviewType = String(options.reviewType || '').trim().toLowerCase();
        if (!reviewType) throw new Error('ReviewType is required.');

        const repoRoot = normalizePathValue(options.repoRoot || '.');
        assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-invocation', 'review_phase');
        const preflightPath = resolveCanonicalPreflightArtifactPath(repoRoot, taskId);
        const reviewsRoot = path.dirname(preflightPath);
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
        const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = parseReviewerIdentity(
            options,
            "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
        );
        const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
        const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const preflightSha256 = fileSha256(preflightPath);
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
            gateName: 'record-review-invocation'
        });
        const promptBinding = resolveReviewerPromptArtifactBinding({
            repoRoot,
            contextPath,
            reviewContext: parsedReviewContext,
            gateName: 'record-review-invocation'
        });
        const handoffBindings = resolveReviewerHandoffBindings({
            repoRoot,
            contextPath,
            reviewContext: parsedReviewContext,
            gateName: 'record-review-invocation'
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

        const launchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
            repoRoot,
            taskId,
            reviewType,
            artifactPathValue: options.reviewerLaunchArtifactPath
        });
        const launchArtifactForRouting = readJsonFile(launchArtifactPath, 'Reviewer launch artifact');
        const plannedReviewerIdentity = getStringField(
            launchArtifactForRouting,
            'planned_reviewer_identity',
            'plannedReviewerIdentity'
        ) || getStringField(
            launchArtifactForRouting,
            'reviewer_identity',
            'reviewerIdentity',
            'reviewer_session_id',
            'reviewerSessionId'
        );
        const routingReviewerIdentity = isPlannedReviewerIdentity(plannedReviewerIdentity)
            ? plannedReviewerIdentity
            : reviewerIdentity;

        const currentExecutionMode = normalizeCompatibilityReviewerExecutionMode(currentRouting?.actual_execution_mode);
        const currentReviewerSessionId = currentRouting?.reviewer_session_id != null
            ? String(currentRouting.reviewer_session_id).trim()
            : '';
        const contextReviewerSessionMatches = currentReviewerSessionId === reviewerIdentity
            || (
                isPlannedReviewerIdentity(currentReviewerSessionId)
                && currentReviewerSessionId === routingReviewerIdentity
                && isResolvedReviewerIdentity(reviewerIdentity)
            );
        if (currentExecutionMode !== reviewerExecutionMode || !contextReviewerSessionMatches) {
            throw new Error(
                `Reviewer invocation attestation requires review-context routing metadata for '${reviewType}' ` +
                `to match reviewer '${reviewerIdentity}' and execution mode '${reviewerExecutionMode}'.`
            );
        }

        const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
        const timelineEvents = readDependencyTimelineEvents(timelinePath);
        const routingEvent = findMatchingRoutingEvent(
            timelineEvents,
            reviewType,
            reviewerExecutionMode,
            routingReviewerIdentity,
            reviewerFallbackReason
        );
        if (!routingEvent) {
            throw new Error(
                `Reviewer invocation attestation requires current-cycle REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}' ` +
                `and reviewer '${routingReviewerIdentity}'.`
            );
        }
        const routingEventProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
        if (!routingEventProvenance) {
            throw new Error(
                `Reviewer invocation attestation requires integrity-backed REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}'.`
            );
        }
        const contextSha256 = fileSha256(contextPath);
        if (!contextSha256) {
            throw new Error(`Reviewer invocation attestation requires a hashable review-context artifact: ${normalizePath(contextPath)}.`);
        }
        const launchArtifact = validateReviewerLaunchArtifact({
            repoRoot,
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewContextSha256: contextSha256,
            routingEventSha256: routingEventProvenance.event_sha256,
            reviewerPromptSha256: promptBinding.reviewerPromptSha256,
            rolePromptSha256: handoffBindings.rolePromptSha256,
            promptTemplateSha256: handoffBindings.promptTemplateSha256,
            outputTemplateSha256: handoffBindings.outputTemplateSha256,
            evidenceManifestSha256: handoffBindings.evidenceManifestSha256,
            reviewTreeStateSha256: getReviewTreeStateSha256(parsedReviewContext),
            routingEventSequence: routingEvent.sequence,
            timelineEvents,
            artifactPathValue: options.reviewerLaunchArtifactPath
        });
        const invocationAttestedAtUtc = new Date().toISOString();
        const invocationEvent = await emitReviewerInvocationAttestedEventAsync(
            gateHelpers.joinOrchestratorPath(repoRoot, ''),
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            contextSha256,
            routingEventProvenance.event_sha256,
            {
                launchDetails: {
                    reviewer_launch_artifact_path: normalizePath(launchArtifact.artifactPath),
                    reviewer_launch_artifact_sha256: launchArtifact.artifactSha256,
                    reviewer_launch_attempt_id: launchArtifact.reviewerLaunchAttemptId,
                    execution_provider: runtimeIdentity.execution_provider,
                    execution_provider_source: runtimeIdentity.execution_provider_source,
                    canonical_source_of_truth: runtimeIdentity.canonical_source_of_truth,
                    routed_to: runtimeIdentity.routed_to,
                    provider_bridge: runtimeIdentity.provider_bridge,
                    reviewer_launch_attestation_source: launchArtifact.attestationSource,
                    reviewer_launch_tool: launchArtifact.launchTool,
                    provider_invocation_id: launchArtifact.providerInvocationId,
                    launch_input_mode: launchArtifact.launchInputMode,
                    launch_input_sha256: launchArtifact.launchInputSha256,
                    copy_paste_reviewer_launch_prompt_sha256: launchArtifact.copyPasteReviewerLaunchPromptSha256,
                    launch_prepared_at_utc: launchArtifact.launchPreparedAtUtc,
                    delegation_started_at_utc: launchArtifact.delegationStartedAtUtc,
                    launched_at_utc: launchArtifact.launchedAtUtc,
                    launch_completed_at_utc: launchArtifact.launchCompletedAtUtc,
                    invocation_attested_at_utc: invocationAttestedAtUtc,
                    review_tree_state_sha256: getReviewTreeStateSha256(parsedReviewContext) || null
                }
            }
        );
        if (!invocationEvent || taskEventAppendHasBlockingFailure(invocationEvent, false)) {
            throw new Error(
                `Reviewer invocation attestation requires REVIEWER_INVOCATION_ATTESTED telemetry for '${reviewType}'. ` +
                'The lifecycle event could not be persisted.'
            );
        }
        console.log(`REVIEWER_INVOCATION_ATTESTED: ${reviewType}`);
        console.log(`ReviewerIdentity: ${reviewerIdentity}`);
        console.log(`LaunchArtifactPath: ${normalizePath(launchArtifact.artifactPath)}`);
        console.log(`LaunchArtifactSha256: ${launchArtifact.artifactSha256}`);
    }

    async function handleRecordReviewInvocation(gateArgv: string[]): Promise<void> {
        const { options: rawOptions } = parseOptions(
            gateArgv,
            RECORD_REVIEW_INVOCATION_OPTION_DEFINITIONS,
            { allowPositionals: false }
        );
        const options = rawOptions as ParsedOptionsRecord;
        const taskId = assertValidTaskId(options.taskId);
        const reviewType = String(options.reviewType || '').trim().toLowerCase();
        if (!reviewType) throw new Error('ReviewType is required.');
        const repoRoot = normalizePathValue(options.repoRoot || '.');
        const canonicalLaunchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
            repoRoot,
            taskId,
            reviewType,
            artifactPathValue: undefined
        });
        await withReviewerLaunchLaneTransaction(
            canonicalLaunchArtifactPath,
            () => handleRecordReviewInvocationUnlocked(gateArgv)
        );
    }

    return {
        handleRecordReviewInvocation,
        handleRecordReviewInvocationWithLaneHeld: handleRecordReviewInvocationUnlocked,
        validateReviewerLaunchArtifact
    };
}
