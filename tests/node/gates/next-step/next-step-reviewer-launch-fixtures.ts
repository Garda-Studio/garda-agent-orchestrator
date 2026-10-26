import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    buildReviewerLaunchBindingSha256
} from '../../../../src/cli/commands/gate-review-handlers/launch/review-launch-input-attestation';

export interface ReviewerLaunchEventIntegrity {
    task_sequence: number;
    prev_event_sha256: string | null;
    event_sha256: string;
}

export type AppendReviewerLaunchEvent = (
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome?: string,
    details?: Record<string, unknown>,
    timestampUtc?: string
) => ReviewerLaunchEventIntegrity;

export interface AuthenticatedReviewerLaunchFixture {
    routeIntegrity: ReviewerLaunchEventIntegrity;
    preparedIntegrity: ReviewerLaunchEventIntegrity;
    pinnedInputIntegrity: ReviewerLaunchEventIntegrity;
    invocationIntegrity: ReviewerLaunchEventIntegrity | null;
    launchArtifactPath: string;
    launchArtifactSha256: string;
    launchInputArtifactPath: string;
    launchInputArtifactSha256: string;
    reviewerLaunchAttemptId: string;
    launchBindingSha256: string;
    providerInvocationId: string;
    launchTool: string;
    attestationSource: string;
    launchPreparedAtUtc: string;
    delegationStartedAtUtc: string;
    launchCompletedAtUtc: string;
    invocationAttestedAtUtc: string;
    launchInputMode: 'copy_paste_prompt';
    launchInputSha256: string;
    copyPastePromptSha256: string;
}

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function deterministicUuidV4(seed: string): string {
    const hex = sha256Text(seed).slice(0, 32).split('');
    hex[12] = '4';
    hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
    const value = hex.join('');
    return [
        value.slice(0, 8),
        value.slice(8, 12),
        value.slice(12, 16),
        value.slice(16, 20),
        value.slice(20)
    ].join('-');
}

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function seedAuthenticatedReviewerLaunchFixture(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    reviewContextPath: string;
    reviewTreeStateSha256?: string;
    appendEvent: AppendReviewerLaunchEvent;
    includeInvocation?: boolean;
    reviewOutputPath?: string;
    launchArtifactPath?: string;
    reviewExecutionBindings?: object;
    uniqueAttempt?: boolean;
    provider?: string;
}): AuthenticatedReviewerLaunchFixture {
    const reviewContextSha256 = fileSha256(options.reviewContextPath);
    const launchTool = 'test-subagent-spawn';
    const attestationSource = 'test-subagent-spawn';
    const providerInvocationId = `test-${options.reviewType}-invocation${options.uniqueAttempt ? ":" + reviewContextSha256 : ""}`;
    const launchPreparedAtUtc = '2026-04-28T00:00:00.000Z';
    const delegationStartedAtUtc = '2026-04-28T00:00:01.000Z';
    const launchCompletedAtUtc = '2026-04-28T00:00:12.000Z';
    const invocationAttestedAtUtc = '2026-04-28T00:00:13.000Z';
    const launchArtifactPath = options.launchArtifactPath || path.join(
        options.repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'tmp',
        'reviews',
        options.taskId,
        options.reviewType,
        'reviewer-launch.json'
    );
    const launchInputArtifactPath = path.join(path.dirname(launchArtifactPath), 'reviewer-launch-input.json');
    const reviewerLaunchAttemptId = deterministicUuidV4(
        `${options.taskId}:${options.reviewType}:${options.reviewerIdentity}${options.uniqueAttempt ? ":" + reviewContextSha256 : ""}`
    );
    const copyPastePrompt = `Delegated ${options.reviewType} reviewer launch prompt for ${options.taskId}.`;
    const copyPastePromptSha256 = sha256Text(copyPastePrompt);
    const reviewerPromptSha256 = sha256Text(`reviewer-prompt:${options.taskId}:${options.reviewType}`);
    const rolePromptSha256 = sha256Text(`role-prompt:${options.taskId}:${options.reviewType}`);
    const promptTemplateSha256 = sha256Text(`prompt-template:${options.taskId}:${options.reviewType}`);
    const outputTemplateSha256 = sha256Text(`output-template:${options.taskId}:${options.reviewType}`);
    const evidenceManifestSha256 = sha256Text(`evidence-manifest:${options.taskId}:${options.reviewType}`);

    const routeIntegrity = options.appendEvent(
        options.repoRoot,
        options.taskId,
        'REVIEWER_DELEGATION_ROUTED',
        'INFO',
        {
            ...options.reviewExecutionBindings,
            task_id: options.taskId,
            review_type: options.reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: options.reviewerIdentity,
            reviewer_identity: options.reviewerIdentity,
            review_context_sha256: reviewContextSha256
        }
    );
    const launchBindingSha256 = buildReviewerLaunchBindingSha256({
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: 'delegated_subagent',
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256,
        routingEventSha256: routeIntegrity.event_sha256,
        reviewerPromptSha256
    });
    const preparedIntegrity = options.appendEvent(
        options.repoRoot,
        options.taskId,
        'REVIEWER_LAUNCH_PREPARED',
        'INFO',
        {
            ...options.reviewExecutionBindings,
            task_id: options.taskId,
            review_type: options.reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: options.reviewerIdentity,
            reviewer_identity: options.reviewerIdentity,
            review_context_sha256: reviewContextSha256,
            routing_event_sha256: routeIntegrity.event_sha256,
            reviewer_prompt_sha256: reviewerPromptSha256,
            role_prompt_sha256: rolePromptSha256,
            prompt_template_sha256: promptTemplateSha256,
            output_template_sha256: outputTemplateSha256,
            evidence_manifest_sha256: evidenceManifestSha256,
            launch_binding_sha256: launchBindingSha256,
            reviewer_launch_attempt_id: reviewerLaunchAttemptId,
            reviewer_launch_artifact_path: normalizePath(launchArtifactPath),
            reviewer_launch_input_artifact_path: normalizePath(launchInputArtifactPath)
        }
    );
    writeJson(launchInputArtifactPath, {
        schema_version: 1,
        evidence_type: 'delegated_reviewer_launch_input',
        ...options.reviewExecutionBindings,
        task_id: options.taskId,
        review_type: options.reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: options.reviewerIdentity,
        reviewer_session_id: options.reviewerIdentity,
        review_context_sha256: reviewContextSha256,
        routing_event_sha256: routeIntegrity.event_sha256,
        reviewer_prompt_sha256: reviewerPromptSha256,
        role_prompt_sha256: rolePromptSha256,
        prompt_template_sha256: promptTemplateSha256,
        output_template_sha256: outputTemplateSha256,
        evidence_manifest_sha256: evidenceManifestSha256,
        launch_binding_sha256: launchBindingSha256,
        reviewer_launch_attempt_id: reviewerLaunchAttemptId,
        prepared_launch_event_sha256: preparedIntegrity.event_sha256,
        copy_paste_reviewer_launch_prompt: copyPastePrompt,
        copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256
    });
    const launchInputArtifactSha256 = fileSha256(launchInputArtifactPath);
    const pinnedInputIntegrity = options.appendEvent(
        options.repoRoot,
        options.taskId,
        'REVIEWER_LAUNCH_INPUT_PINNED',
        'INFO',
        {
            ...options.reviewExecutionBindings,
            task_id: options.taskId,
            review_type: options.reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: options.reviewerIdentity,
            reviewer_identity: options.reviewerIdentity,
            review_context_sha256: reviewContextSha256,
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            reviewer_launch_attempt_id: reviewerLaunchAttemptId,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            reviewer_launch_artifact_path: normalizePath(launchArtifactPath),
            reviewer_launch_input_artifact_path: normalizePath(launchInputArtifactPath),
            reviewer_launch_input_artifact_sha256: launchInputArtifactSha256
        }
    );
    options.appendEvent(
        options.repoRoot,
        options.taskId,
        'REVIEWER_DELEGATION_STARTED',
        'INFO',
        {
            ...options.reviewExecutionBindings,
            task_id: options.taskId,
            review_type: options.reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: options.reviewerIdentity,
            reviewer_identity: options.reviewerIdentity,
            review_context_sha256: reviewContextSha256,
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            reviewer_launch_attempt_id: reviewerLaunchAttemptId,
            provider_invocation_id: providerInvocationId,
            delegation_started_at_utc: delegationStartedAtUtc,
            launched_at_utc: delegationStartedAtUtc
        }
    );
    writeJson(launchArtifactPath, {
        schema_version: 1,
        evidence_type: 'delegated_reviewer_launch',
        attestation_state: 'launched',
        ...(options.provider ? { provider: options.provider } : {}),
        ...options.reviewExecutionBindings,
        task_id: options.taskId,
        review_type: options.reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: options.reviewerIdentity,
        reviewer_session_id: options.reviewerIdentity,
        review_context_sha256: reviewContextSha256,
        routing_event_sha256: routeIntegrity.event_sha256,
        reviewer_prompt_sha256: reviewerPromptSha256,
        role_prompt_sha256: rolePromptSha256,
        prompt_template_sha256: promptTemplateSha256,
        output_template_sha256: outputTemplateSha256,
        evidence_manifest_sha256: evidenceManifestSha256,
        launch_binding_sha256: launchBindingSha256,
        prepared_launch_event_sha256: preparedIntegrity.event_sha256,
        reviewer_launch_attempt_id: reviewerLaunchAttemptId,
        reviewer_launch_artifact_path: normalizePath(launchArtifactPath),
        reviewer_launch_input_artifact_path: normalizePath(launchInputArtifactPath),
        reviewer_launch_input_artifact_sha256: launchInputArtifactSha256,
        reviewer_launch_input_pinned_event_sha256: pinnedInputIntegrity.event_sha256,
        reviewer_launch_input_pinned_event_task_sequence: pinnedInputIntegrity.task_sequence,
        copy_paste_reviewer_launch_prompt: copyPastePrompt,
        copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
        launch_input_mode: 'copy_paste_prompt',
        launch_input_sha256: copyPastePromptSha256,
        launch_input_copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
        launch_tool: launchTool,
        attestation_source: attestationSource,
        provider_invocation_id: providerInvocationId,
        launch_prepared_at_utc: launchPreparedAtUtc,
        delegation_started_at_utc: delegationStartedAtUtc,
        launched_at_utc: delegationStartedAtUtc,
        launch_completed_at_utc: launchCompletedAtUtc,
        ...(options.reviewOutputPath
            ? { review_output_path: normalizePath(options.reviewOutputPath) }
            : {}),
        fork_context: false
    });
    const launchArtifactSha256 = fileSha256(launchArtifactPath);
    options.appendEvent(
        options.repoRoot,
        options.taskId,
        'REVIEWER_LAUNCH_COMPLETED',
        'INFO',
        {
            ...options.reviewExecutionBindings,
            task_id: options.taskId,
            review_type: options.reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: options.reviewerIdentity,
            reviewer_identity: options.reviewerIdentity,
            review_context_sha256: reviewContextSha256,
            routing_event_sha256: routeIntegrity.event_sha256,
            reviewer_launch_attempt_id: reviewerLaunchAttemptId,
            reviewer_launch_artifact_path: normalizePath(launchArtifactPath),
            reviewer_launch_artifact_sha256: launchArtifactSha256,
            provider_invocation_id: providerInvocationId,
            delegation_started_at_utc: delegationStartedAtUtc,
            launched_at_utc: delegationStartedAtUtc,
            launch_completed_at_utc: launchCompletedAtUtc
        }
    );
    const invocationIntegrity = options.includeInvocation === false
        ? null
        : options.appendEvent(
            options.repoRoot,
            options.taskId,
            'REVIEWER_INVOCATION_ATTESTED',
            'INFO',
            {
                ...options.reviewExecutionBindings,
                task_id: options.taskId,
                review_type: options.reviewType,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: options.reviewerIdentity,
                reviewer_identity: options.reviewerIdentity,
                review_context_sha256: reviewContextSha256,
                review_tree_state_sha256: options.reviewTreeStateSha256 || '',
                routing_event_sha256: routeIntegrity.event_sha256,
                reviewer_launch_attempt_id: reviewerLaunchAttemptId,
                reviewer_launch_artifact_path: normalizePath(launchArtifactPath),
                reviewer_launch_artifact_sha256: launchArtifactSha256,
                reviewer_launch_attestation_source: attestationSource,
                reviewer_launch_tool: launchTool,
                provider_invocation_id: providerInvocationId,
                launch_prepared_at_utc: launchPreparedAtUtc,
                delegation_started_at_utc: delegationStartedAtUtc,
                launched_at_utc: delegationStartedAtUtc,
                launch_completed_at_utc: launchCompletedAtUtc,
                reviewer_launch_input_artifact_path: normalizePath(launchInputArtifactPath),
                reviewer_launch_input_artifact_sha256: launchInputArtifactSha256,
                reviewer_launch_input_pinned_event_sha256: pinnedInputIntegrity.event_sha256,
                reviewer_launch_input_pinned_event_task_sequence: pinnedInputIntegrity.task_sequence,
                launch_input_mode: 'copy_paste_prompt',
                launch_input_sha256: copyPastePromptSha256,
                copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
                invocation_attested_at_utc: invocationAttestedAtUtc
            }
        );

    return {
        routeIntegrity,
        preparedIntegrity,
        pinnedInputIntegrity,
        invocationIntegrity,
        launchArtifactPath,
        launchArtifactSha256,
        launchInputArtifactPath,
        launchInputArtifactSha256,
        reviewerLaunchAttemptId,
        launchBindingSha256,
        providerInvocationId,
        launchTool,
        attestationSource,
        launchPreparedAtUtc,
        delegationStartedAtUtc,
        launchCompletedAtUtc,
        invocationAttestedAtUtc,
        launchInputMode: 'copy_paste_prompt',
        launchInputSha256: copyPastePromptSha256,
        copyPastePromptSha256
    };
}
