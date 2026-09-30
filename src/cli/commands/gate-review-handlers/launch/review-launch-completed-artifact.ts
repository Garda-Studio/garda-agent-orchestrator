import * as fs from 'node:fs';
import {
    fileSha256,
    gateHelpers,
    normalizePath,
    type ReviewDependencyTimelineEvent
} from './review-launch-entrypoints';
import { isTaskOwnedReviewTempPath } from '../../../gate-cli/gates-artifacts';
import {
    resolveLaunchBindingReviewerIdentity
} from '../../../../gate-runtime/review/reviewer-identity-contract';
import {
    buildReviewerLaunchBindingSha256,
    stringSha256
} from './review-launch-input-attestation';
import {
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT,
    REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH,
    buildReviewerLaunchCompletionHint,
    getStringField,
    isForbiddenReviewerLaunchAttestationSource,
    isValidUtcIso8601Timestamp,
    normalizeReviewerLaunchInputMode,
    readJsonFile,
    type ReviewerLaunchArtifactValidationResult
} from './review-launch-artifact-fields';
import {
    findMatchingReviewerLaunchInputPinnedEvent
} from './review-launch-prepared-artifact';
import {
    findMatchingReviewerDelegationStartedEvent,
    findMatchingReviewerLaunchCompletedEvent,
    findMatchingReviewerLaunchPreparedEvent
} from './review-launch-artifact-fields';

export function isCurrentCompletedReviewerLaunchArtifact(options: {
    repoRoot: string;
    artifactPath: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewerPromptSha256: string | null;
    rolePromptSha256?: string | null;
    promptTemplateSha256?: string | null;
    outputTemplateSha256?: string | null;
    evidenceManifestSha256?: string | null;
    reviewTreeStateSha256: string | null;
    routingEventSequence: number;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
}): boolean {
    try {
        validateReviewerLaunchArtifact({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: options.reviewerIdentity,
            reviewContextSha256: options.reviewContextSha256,
            routingEventSha256: options.routingEventSha256,
            reviewerPromptSha256: options.reviewerPromptSha256,
            rolePromptSha256: options.rolePromptSha256,
            promptTemplateSha256: options.promptTemplateSha256,
            outputTemplateSha256: options.outputTemplateSha256,
            evidenceManifestSha256: options.evidenceManifestSha256,
            reviewTreeStateSha256: options.reviewTreeStateSha256,
            routingEventSequence: options.routingEventSequence,
            timelineEvents: options.timelineEvents,
            artifactPathValue: options.artifactPath
        });
        return true;
    } catch {
        return false;
    }
}


export function validateReviewerLaunchArtifact(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewerPromptSha256?: string | null;
    rolePromptSha256?: string | null;
    promptTemplateSha256?: string | null;
    outputTemplateSha256?: string | null;
    evidenceManifestSha256?: string | null;
    reviewTreeStateSha256?: string | null;
    routingEventSequence: number;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    artifactPathValue: unknown;
    allowMissingCompletedEventForRecovery?: boolean;
}): ReviewerLaunchArtifactValidationResult {
    const rawArtifactPath = String(options.artifactPathValue || '').trim();
    if (!rawArtifactPath) {
        throw new Error('ReviewerLaunchArtifactPath is required.');
    }
    const artifactPath = gateHelpers.resolvePathInsideRepo(rawArtifactPath, options.repoRoot, { allowMissing: true });
    if (!artifactPath || !fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        throw new Error(`Reviewer launch artifact not found: ${normalizePath(rawArtifactPath)}.`);
    }
    if (!isTaskOwnedReviewTempPath(options.repoRoot, options.taskId, artifactPath)) {
        throw new Error(
            `ReviewerLaunchArtifactPath must be task-owned under reviewer scratch storage for '${options.taskId}'. ` +
            `Got ${normalizePath(artifactPath)}.`
        );
    }

    const artifact = readJsonFile(artifactPath, 'ReviewerLaunchArtifactPath');
    const reviewerLaunchArtifactSha256 = fileSha256(artifactPath) || '';
    const schemaVersion = Number(artifact.schema_version);
    const evidenceType = String(artifact.evidence_type || artifact.artifact_type || '').trim();
    const attestationState = getStringField(artifact, 'attestation_state', 'attestationState');
    const reviewType = String(artifact.review_type || artifact.reviewType || '').trim().toLowerCase();
    const taskId = String(artifact.task_id || artifact.taskId || '').trim();
    const reviewerExecutionMode = String(
        artifact.reviewer_execution_mode || artifact.reviewerExecutionMode || ''
    ).trim();
    const reviewerIdentity = String(
        artifact.reviewer_identity || artifact.reviewerIdentity || artifact.reviewer_session_id || artifact.reviewerSessionId || ''
    ).trim();
    const reviewContextSha256 = String(
        artifact.review_context_sha256 || artifact.reviewContextSha256 || ''
    ).trim().toLowerCase();
    const routingEventSha256 = String(
        artifact.routing_event_sha256 || artifact.routingEventSha256 || ''
    ).trim().toLowerCase();
    const reviewerLaunchAttemptId = getStringField(
        artifact,
        'reviewer_launch_attempt_id',
        'reviewerLaunchAttemptId'
    ).toLowerCase();
    const attestationSource = String(
        artifact.attestation_source || artifact.attestationSource || artifact.source || ''
    ).trim().toLowerCase();
    const launchTool = String(artifact.launch_tool || artifact.launchTool || '').trim();
    const providerInvocationId = getStringField(
        artifact,
        'provider_invocation_id',
        'providerInvocationId',
        'controller_invocation_id',
        'controllerInvocationId'
    );
    const launchPreparedAtUtc = getStringField(artifact, 'launch_prepared_at_utc', 'launchPreparedAtUtc') || null;
    const delegationStartedAtUtc = getStringField(
        artifact,
        'delegation_started_at_utc',
        'delegationStartedAtUtc'
    ) || null;
    const launchedAtUtc = getStringField(artifact, 'launched_at_utc', 'launchedAtUtc');
    const launchCompletedAtUtc = getStringField(artifact, 'launch_completed_at_utc', 'launchCompletedAtUtc') || null;
    const preparedLaunchEventSha256 = getStringField(
        artifact,
        'prepared_launch_event_sha256',
        'preparedLaunchEventSha256'
    ).toLowerCase();
    const reviewerPromptSha256 = getStringField(artifact, 'reviewer_prompt_sha256', 'reviewerPromptSha256').toLowerCase();
    const rolePromptSha256 = getStringField(artifact, 'role_prompt_sha256', 'rolePromptSha256').toLowerCase();
    const promptTemplateSha256 = getStringField(artifact, 'prompt_template_sha256', 'promptTemplateSha256').toLowerCase();
    const outputTemplateSha256 = getStringField(artifact, 'output_template_sha256', 'outputTemplateSha256').toLowerCase();
    const evidenceManifestSha256 = getStringField(artifact, 'evidence_manifest_sha256', 'evidenceManifestSha256').toLowerCase();
    const launchBindingSha256 = getStringField(artifact, 'launch_binding_sha256', 'launchBindingSha256').toLowerCase();
    const copyPastePrompt = getStringField(
        artifact,
        'copy_paste_reviewer_launch_prompt',
        'copyPasteReviewerLaunchPrompt'
    );
    const copyPastePromptSha256 = getStringField(
        artifact,
        'copy_paste_reviewer_launch_prompt_sha256',
        'copyPasteReviewerLaunchPromptSha256'
    ).toLowerCase();
    const launchInputMode = normalizeReviewerLaunchInputMode(getStringField(artifact, 'launch_input_mode', 'launchInputMode'));
    const rawLaunchInputMode = getStringField(artifact, 'launch_input_mode', 'launchInputMode');
    const launchInputSha256 = getStringField(artifact, 'launch_input_sha256', 'launchInputSha256').toLowerCase();
    const launchInputArtifactPath = getStringField(artifact, 'launch_input_artifact_path', 'launchInputArtifactPath');
    const reviewerLaunchInputArtifactPath = getStringField(
        artifact,
        'reviewer_launch_input_artifact_path',
        'reviewerLaunchInputArtifactPath'
    );
    const reviewerLaunchInputArtifactSha256 = getStringField(
        artifact,
        'reviewer_launch_input_artifact_sha256',
        'reviewerLaunchInputArtifactSha256'
    ).toLowerCase();
    const reviewerLaunchInputPinnedEventSha256 = getStringField(
        artifact,
        'reviewer_launch_input_pinned_event_sha256',
        'reviewerLaunchInputPinnedEventSha256'
    ).toLowerCase();
    const reviewerLaunchInputPinnedEventTaskSequence = Number(
        artifact.reviewer_launch_input_pinned_event_task_sequence
        ?? artifact.reviewerLaunchInputPinnedEventTaskSequence
    );
    const launchInputArtifactSha256 = getStringField(artifact, 'launch_input_artifact_sha256', 'launchInputArtifactSha256').toLowerCase();
    const preparedReviewerLaunchArtifactSha256 = getStringField(
        artifact,
        'prepared_reviewer_launch_artifact_sha256',
        'preparedReviewerLaunchArtifactSha256'
    ).toLowerCase();
    const reviewTreeStateSha256 = getStringField(
        artifact,
        'review_tree_state_sha256',
        'reviewTreeStateSha256'
    ).toLowerCase();
    const plannedReviewerIdentity = getStringField(
        artifact,
        'planned_reviewer_identity',
        'plannedReviewerIdentity'
    );
    const launchBindingReviewerIdentity = resolveLaunchBindingReviewerIdentity({
        taskId: options.taskId,
        reviewType: options.reviewType,
        artifactReviewerIdentity: reviewerIdentity,
        plannedReviewerIdentity
    });
    const expectedLaunchBindingSha256 = buildReviewerLaunchBindingSha256({
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: launchBindingReviewerIdentity,
        reviewContextSha256: options.reviewContextSha256,
        routingEventSha256: options.routingEventSha256,
        reviewerPromptSha256: options.reviewerPromptSha256 || reviewerPromptSha256 || null
    });
    const freshContext = artifact.fresh_context === true
        || artifact.freshContext === true
        || artifact.isolated_context === true
        || artifact.isolatedContext === true
        || artifact.fork_context === false
        || artifact.forkContext === false;
    const violations: string[] = [];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reviewerLaunchAttemptId)) {
        violations.push('reviewer_launch_attempt_id must be an immutable UUID v4');
    }
    if (schemaVersion !== 1) {
        violations.push('schema_version must be 1');
    }
    if (evidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE || attestationState === 'prepared') {
        violations.push(
            'prepared reviewer launch metadata cannot satisfy REVIEWER_INVOCATION_ATTESTED; ' +
            'launch a real delegated reviewer and persist provider/controller invocation evidence first'
        );
    }
    if (evidenceType !== COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE) {
        violations.push(`evidence_type must be '${COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE}'`);
    }
    if (attestationState !== 'launched') {
        violations.push("attestation_state must be 'launched'");
    }
    if (taskId !== options.taskId) {
        violations.push(`task_id must be '${options.taskId}'`);
    }
    if (reviewType !== options.reviewType) {
        violations.push(`review_type must be '${options.reviewType}'`);
    }
    if (reviewerExecutionMode !== options.reviewerExecutionMode) {
        violations.push(`reviewer_execution_mode must be '${options.reviewerExecutionMode}'`);
    }
    if (reviewerIdentity !== options.reviewerIdentity) {
        violations.push(`reviewer_identity must be '${options.reviewerIdentity}'`);
    }
    if (reviewContextSha256 !== options.reviewContextSha256) {
        violations.push('review_context_sha256 must match the current review context');
    }
    if (routingEventSha256 !== options.routingEventSha256) {
        violations.push('routing_event_sha256 must match the current routing event');
    }
    if (options.reviewerPromptSha256 && reviewerPromptSha256 !== options.reviewerPromptSha256) {
        violations.push('reviewer_prompt_sha256 must match the current review context prompt artifact');
    }
    if (options.rolePromptSha256 && rolePromptSha256 !== options.rolePromptSha256) {
        violations.push('role_prompt_sha256 must match the current review context role prompt artifact');
    }
    if (options.promptTemplateSha256 && promptTemplateSha256 !== options.promptTemplateSha256) {
        violations.push('prompt_template_sha256 must match the current review context prompt template artifact');
    }
    if (options.outputTemplateSha256 && outputTemplateSha256 !== options.outputTemplateSha256) {
        violations.push('output_template_sha256 must match the current review context output template artifact');
    }
    if (options.evidenceManifestSha256 && evidenceManifestSha256 !== options.evidenceManifestSha256) {
        violations.push('evidence_manifest_sha256 must match the current review context evidence manifest artifact');
    }
    const launchInputFidelityRequired = evidenceType === COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE
        || attestationState === 'launched'
        || Boolean(
            copyPastePrompt
            || copyPastePromptSha256
            || rawLaunchInputMode
            || launchInputSha256
            || launchInputArtifactPath
            || launchInputArtifactSha256
            || preparedReviewerLaunchArtifactSha256
        );
    if (launchInputFidelityRequired) {
        if (!copyPastePrompt) {
            violations.push('copy_paste_reviewer_launch_prompt is required for launch input fidelity');
        }
        if (!copyPastePromptSha256) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 is required');
        } else if (!/^[0-9a-f]{64}$/.test(copyPastePromptSha256)) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 must be a lowercase sha256 hex digest');
        } else if (copyPastePrompt && copyPastePromptSha256 !== stringSha256(copyPastePrompt)) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 must match copy_paste_reviewer_launch_prompt');
        }
        if (!rawLaunchInputMode) {
            violations.push('launch_input_mode is required');
        } else if (!launchInputMode) {
            violations.push(
                `launch_input_mode must be '${REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT}' ` +
                `or '${REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH}'`
            );
        }
        if (!launchInputSha256) {
            violations.push('launch_input_sha256 is required');
        } else if (!/^[0-9a-f]{64}$/.test(launchInputSha256)) {
            violations.push('launch_input_sha256 must be a lowercase sha256 hex digest');
        } else if (
            launchInputMode === REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT
            && copyPastePromptSha256
            && launchInputSha256 !== copyPastePromptSha256
        ) {
            violations.push('launch_input_sha256 must match copy_paste_reviewer_launch_prompt_sha256 for copy_paste_prompt mode');
        } else if (launchInputMode === REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH) {
            if (!launchInputArtifactPath) {
                violations.push('launch_input_artifact_path is required for launch_artifact_path mode');
            } else {
                const resolvedLaunchInputArtifactPath = gateHelpers.resolvePathInsideRepo(
                    launchInputArtifactPath,
                    options.repoRoot,
                    { allowMissing: true }
                );
                const resolvedReviewerLaunchInputArtifactPath = reviewerLaunchInputArtifactPath
                    ? gateHelpers.resolvePathInsideRepo(
                        reviewerLaunchInputArtifactPath,
                        options.repoRoot,
                        { allowMissing: true }
                    )
                    : null;
                const normalizedResolvedLaunchInputArtifactPath = resolvedLaunchInputArtifactPath
                    ? normalizePath(resolvedLaunchInputArtifactPath).toLowerCase()
                    : '';
                const normalizedReviewerLaunchInputArtifactPath = resolvedReviewerLaunchInputArtifactPath
                    ? normalizePath(resolvedReviewerLaunchInputArtifactPath).toLowerCase()
                    : '';
                if (!resolvedLaunchInputArtifactPath) {
                    violations.push('launch_input_artifact_path could not be resolved inside the repository');
                } else if (!normalizedReviewerLaunchInputArtifactPath) {
                    violations.push('reviewer_launch_input_artifact_path is required for launch_artifact_path attestation');
                } else if (normalizedResolvedLaunchInputArtifactPath !== normalizedReviewerLaunchInputArtifactPath) {
                    violations.push(
                        'launch_input_artifact_path must match ReviewerLaunchInputArtifactPath; ' +
                        'ReviewerLaunchArtifactPath control metadata is not valid reviewer launch input'
                    );
                } else {
                    const actualLaunchInputArtifactSha256 = fileSha256(resolvedLaunchInputArtifactPath) || '';
                    if (!actualLaunchInputArtifactSha256) {
                        violations.push('ReviewerLaunchInputArtifactPath must be hashable');
                    } else if (
                        !reviewerLaunchInputArtifactSha256
                        || !/^[0-9a-f]{64}$/.test(reviewerLaunchInputArtifactSha256)
                    ) {
                        violations.push('reviewer_launch_input_artifact_sha256 is required for ReviewerLaunchInputArtifactPath attestation');
                    } else if (actualLaunchInputArtifactSha256 !== reviewerLaunchInputArtifactSha256) {
                        violations.push('ReviewerLaunchInputArtifactPath contents must match the immutable prepare-time handoff hash');
                    } else if (launchInputArtifactSha256 && actualLaunchInputArtifactSha256 !== launchInputArtifactSha256) {
                        violations.push('launch_input_artifact_sha256 must match ReviewerLaunchInputArtifactPath contents');
                    } else if (launchInputSha256 && actualLaunchInputArtifactSha256 !== launchInputSha256) {
                        violations.push('launch_input_sha256 must match ReviewerLaunchInputArtifactPath contents');
                    }
                }
            }
            if (!launchInputArtifactSha256) {
                violations.push('launch_input_artifact_sha256 is required for launch_artifact_path mode');
            }
            if (!preparedReviewerLaunchArtifactSha256) {
                violations.push('prepared_reviewer_launch_artifact_sha256 is required for launch_artifact_path mode');
            }
            if (
                launchInputArtifactSha256
                && preparedReviewerLaunchArtifactSha256
                && launchInputArtifactSha256 !== preparedReviewerLaunchArtifactSha256
            ) {
                violations.push('launch_input_artifact_sha256 must match prepared_reviewer_launch_artifact_sha256');
            }
            if (
                launchInputSha256
                && preparedReviewerLaunchArtifactSha256
                && launchInputSha256 !== preparedReviewerLaunchArtifactSha256
            ) {
                violations.push('launch_input_sha256 must match prepared_reviewer_launch_artifact_sha256 for launch_artifact_path mode');
            }
        }
    }
    if (options.reviewTreeStateSha256 && reviewTreeStateSha256 !== options.reviewTreeStateSha256) {
        violations.push('review_tree_state_sha256 must match the current review context tree_state');
    }
    if (!launchBindingSha256) {
        violations.push('launch_binding_sha256 is required');
    } else if (launchBindingSha256 !== expectedLaunchBindingSha256) {
        violations.push('launch_binding_sha256 must match the current prepared launch binding');
    }
    if (!preparedLaunchEventSha256) {
        violations.push('prepared_launch_event_sha256 is required');
    } else if (!/^[0-9a-f]{64}$/.test(preparedLaunchEventSha256)) {
        violations.push('prepared_launch_event_sha256 must be a lowercase sha256 hex digest');
    } else if (
        !findMatchingReviewerLaunchPreparedEvent(options.timelineEvents, {
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: launchBindingReviewerIdentity,
            reviewContextSha256: options.reviewContextSha256,
            routingEventSha256: options.routingEventSha256,
            reviewerLaunchAttemptId,
            launchBindingSha256: expectedLaunchBindingSha256,
            preparedLaunchEventSha256,
            minSequenceExclusive: options.routingEventSequence
        })
    ) {
        violations.push('prepared_launch_event_sha256 must reference current REVIEWER_LAUNCH_PREPARED telemetry');
    }
    const resolvedPinnedReviewerLaunchInputArtifactPath = reviewerLaunchInputArtifactPath
        ? gateHelpers.resolvePathInsideRepo(
            reviewerLaunchInputArtifactPath,
            options.repoRoot,
            { allowMissing: true }
        )
        : null;
    if (!resolvedPinnedReviewerLaunchInputArtifactPath) {
        violations.push('reviewer_launch_input_artifact_path is required for immutable input pin validation');
    } else if (!/^[0-9a-f]{64}$/.test(reviewerLaunchInputArtifactSha256)) {
        violations.push('reviewer_launch_input_artifact_sha256 must be a lowercase sha256 hex digest');
    } else if (
        !/^[0-9a-f]{64}$/.test(reviewerLaunchInputPinnedEventSha256)
        || !Number.isInteger(reviewerLaunchInputPinnedEventTaskSequence)
        || reviewerLaunchInputPinnedEventTaskSequence < 1
    ) {
        violations.push('reviewer launch input pin event binding is required');
    } else if (!findMatchingReviewerLaunchInputPinnedEvent({
        artifactPath,
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: launchBindingReviewerIdentity,
        reviewContextSha256: options.reviewContextSha256,
        routingEventSha256: options.routingEventSha256,
        launchBindingSha256: expectedLaunchBindingSha256,
        reviewerLaunchAttemptId,
        preparedLaunchEventSha256,
        reviewerLaunchInputArtifactPath: resolvedPinnedReviewerLaunchInputArtifactPath,
        reviewerLaunchInputArtifactSha256,
        timelineEvents: options.timelineEvents,
        pinnedEventSha256: reviewerLaunchInputPinnedEventSha256,
        pinnedEventTaskSequence: reviewerLaunchInputPinnedEventTaskSequence
    })) {
        violations.push('reviewer launch input pin must reference current REVIEWER_LAUNCH_INPUT_PINNED telemetry');
    }
    if (!freshContext) {
        violations.push('fresh_context, isolated_context, or fork_context=false must attest clean reviewer context');
    }
    if (!attestationSource) {
        violations.push('attestation_source is required');
    } else if (isForbiddenReviewerLaunchAttestationSource(attestationSource)) {
        violations.push('attestation_source must be provider/controller-owned completed launch evidence');
    }
    if (!launchTool) {
        violations.push('launch_tool is required');
    }
    if (!providerInvocationId) {
        violations.push('provider_invocation_id or controller_invocation_id is required');
    }
    if (!delegationStartedAtUtc) {
        violations.push('delegation_started_at_utc is required');
    } else if (!isValidUtcIso8601Timestamp(delegationStartedAtUtc)) {
        violations.push('delegation_started_at_utc must be a valid UTC ISO-8601 timestamp');
    }
    if (!launchedAtUtc) {
        violations.push('launched_at_utc is required');
    } else if (!isValidUtcIso8601Timestamp(launchedAtUtc)) {
        violations.push('launched_at_utc must be a valid UTC ISO-8601 timestamp');
    } else if (delegationStartedAtUtc && launchedAtUtc !== delegationStartedAtUtc) {
        violations.push('launched_at_utc must match delegation_started_at_utc for compatibility');
    }
    if (
        delegationStartedAtUtc
        && isValidUtcIso8601Timestamp(delegationStartedAtUtc)
        && providerInvocationId
        && /^[0-9a-f]{64}$/.test(preparedLaunchEventSha256)
        && /^[0-9a-f]{64}$/.test(launchBindingSha256)
        && !findMatchingReviewerDelegationStartedEvent(options.timelineEvents, {
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: launchBindingReviewerIdentity,
            reviewContextSha256: options.reviewContextSha256,
            routingEventSha256: options.routingEventSha256,
            reviewerLaunchAttemptId,
            launchBindingSha256: expectedLaunchBindingSha256,
            preparedLaunchEventSha256,
            providerInvocationId,
            delegationStartedAtUtc,
            minSequenceExclusive: options.routingEventSequence
        })
    ) {
        violations.push('delegation_started_at_utc must reference current REVIEWER_DELEGATION_STARTED telemetry');
    }
    if (launchPreparedAtUtc && !isValidUtcIso8601Timestamp(launchPreparedAtUtc)) {
        violations.push('launch_prepared_at_utc must be a valid UTC ISO-8601 timestamp');
    }
    if (launchCompletedAtUtc && !isValidUtcIso8601Timestamp(launchCompletedAtUtc)) {
        violations.push('launch_completed_at_utc must be a valid UTC ISO-8601 timestamp');
    }
    if (!launchCompletedAtUtc) {
        violations.push('launch_completed_at_utc is required');
    } else if (
        isValidUtcIso8601Timestamp(launchCompletedAtUtc)
        && delegationStartedAtUtc
        && isValidUtcIso8601Timestamp(delegationStartedAtUtc)
        && providerInvocationId
        && reviewerLaunchArtifactSha256
        && options.allowMissingCompletedEventForRecovery !== true
        && !findMatchingReviewerLaunchCompletedEvent(options.timelineEvents, {
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: launchBindingReviewerIdentity,
            reviewContextSha256: options.reviewContextSha256,
            routingEventSha256: options.routingEventSha256,
            reviewerLaunchAttemptId,
            reviewerLaunchArtifactSha256,
            providerInvocationId,
            delegationStartedAtUtc,
            launchCompletedAtUtc,
            minSequenceExclusive: options.routingEventSequence
        })
    ) {
        violations.push('launch_completed_at_utc must reference current REVIEWER_LAUNCH_COMPLETED telemetry');
    }
    if (violations.length > 0) {
        throw new Error(
            'Reviewer launch artifact is not eligible for invocation attestation:\n' +
            violations.map((violation) => `- ${violation}`).join('\n') +
            '\n\n' +
            buildReviewerLaunchCompletionHint()
        );
    }

    return {
        artifactPath,
        artifactSha256: reviewerLaunchArtifactSha256,
        reviewerLaunchAttemptId,
        attestationSource,
        launchTool,
        providerInvocationId,
        launchPreparedAtUtc,
        delegationStartedAtUtc,
        launchedAtUtc,
        launchCompletedAtUtc,
        launchInputMode: launchInputMode || null,
        launchInputSha256: launchInputSha256 || null,
        copyPasteReviewerLaunchPromptSha256: copyPastePromptSha256 || null
    };
}
