import * as fs from 'node:fs';
import {
    normalizeCompatibilityReviewerExecutionMode,
    normalizePath,
    type ReviewDependencyTimelineEvent
} from './review-launch-entrypoints';
import {
    reviewerIdentityMatchesDelegatedLaunchCycle
} from '../../../../gate-runtime/review/reviewer-identity-contract';

export type ReviewerLaunchInputMode = 'copy_paste_prompt' | 'launch_artifact_path';

export interface ReviewerLaunchArtifactValidationResult {
    artifactPath: string;
    artifactSha256: string;
    reviewerLaunchAttemptId: string;
    attestationSource: string;
    launchTool: string;
    providerInvocationId: string;
    launchPreparedAtUtc: string | null;
    delegationStartedAtUtc: string | null;
    launchedAtUtc: string;
    launchCompletedAtUtc: string | null;
    launchInputMode: ReviewerLaunchInputMode | null;
    launchInputSha256: string | null;
    copyPasteReviewerLaunchPromptSha256: string | null;
}

export interface SupersededReviewerLaunchArtifactSnapshot {
    artifact_path: string;
    artifact_sha256: string;
    snapshot_path: string;
    superseded_reason: string;
    mismatches: string[];
}

export const PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch_preparation';
export const COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch';
export const PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE = 'garda_prepare_reviewer_launch';
const FORBIDDEN_COMPLETED_REVIEWER_LAUNCH_ATTESTATION_SOURCES = new Set([
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
    'orchestrator_mock',
    'mock',
    'manual'
]);
export const LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY = (
    'Local reviewer launch artifacts are convenience metadata for a real delegated reviewer launch; ' +
    'they are not non-forgeable proof without provider-owned recording.'
);
export const REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS = Object.freeze([
    "evidence_type='delegated_reviewer_launch'",
    "attestation_state='launched'",
    'attestation_source=<provider/controller source, not garda_prepare_reviewer_launch/manual/mock>',
    'provider_invocation_id or controller_invocation_id=<actual delegated reviewer invocation id>',
    'delegation_started_at_utc=<gate-owned UTC timestamp recorded by record-reviewer-delegation-started>',
    'launched_at_utc=<same reviewer delegation start timestamp for compatibility>',
    'launch_input_mode=copy_paste_prompt or launch_artifact_path',
    'launch_input_sha256=<ReviewerLaunchInputArtifactSha256 for launch_artifact_path, or CopyPasteReviewerLaunchPromptSha256>',
    'launch_input_artifact_sha256=<artifact JSON field for ReviewerLaunchInputArtifactSha256 when launch_input_mode=launch_artifact_path>',
    'fresh_context=true, isolated_context=true, or fork_context=false'
]);

export const REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT: ReviewerLaunchInputMode = 'copy_paste_prompt';
export const REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH: ReviewerLaunchInputMode = 'launch_artifact_path';
const REVIEWER_LAUNCH_INPUT_MODES = new Set<ReviewerLaunchInputMode>([
    REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT,
    REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH
]);
const UTC_ISO_8601_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

export function normalizeReviewerLaunchAttestationSource(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

export function isForbiddenReviewerLaunchAttestationSource(value: string): boolean {
    return FORBIDDEN_COMPLETED_REVIEWER_LAUNCH_ATTESTATION_SOURCES.has(
        normalizeReviewerLaunchAttestationSource(value)
    );
}

export function getStringField(record: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
        const value = record[key];
        if (value == null) {
            continue;
        }
        const text = String(value).trim();
        if (text) {
            return text;
        }
    }
    return '';
}

export function readJsonFile(pathValue: string, label: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(pathValue, 'utf8')) as unknown;
    } catch (error: unknown) {
        if (error instanceof SyntaxError) {
            throw new Error(`${label} must contain valid JSON: ${error.message}`);
        }
        throw error;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${label} must contain a JSON object.`);
    }
    return parsed as Record<string, unknown>;
}

export function normalizeReviewerLaunchInputMode(value: unknown): ReviewerLaunchInputMode | null {
    const normalized = String(value || '').trim().toLowerCase();
    return REVIEWER_LAUNCH_INPUT_MODES.has(normalized as ReviewerLaunchInputMode)
        ? normalized as ReviewerLaunchInputMode
        : null;
}

export function isValidUtcIso8601Timestamp(value: string): boolean {
    const match = UTC_ISO_8601_TIMESTAMP_PATTERN.exec(value);
    if (!match) {
        return false;
    }
    const timestampMs = Date.parse(value);
    if (!Number.isFinite(timestampMs)) {
        return false;
    }
    const parsed = new Date(timestampMs);
    const [, year, month, day, hour, minute, second] = match.map(Number);
    return parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() + 1 === month
        && parsed.getUTCDate() === day
        && parsed.getUTCHours() === hour
        && parsed.getUTCMinutes() === minute
        && parsed.getUTCSeconds() === second;
}

export function buildReviewerLaunchCompletionHint(): string {
    return [
        'Completion hint:',
        '- Start from the prepared reviewer-launch artifact; do not search for or recompute its hashes.',
        '- Attest the exact launch input: copy_paste_prompt uses CopyPasteReviewerLaunchPromptSha256; launch_artifact_path uses the reviewer-facing ReviewerLaunchInputArtifactPath and ReviewerLaunchInputArtifactSha256. ReviewerLaunchArtifactPath remains main-agent control metadata. The CLI flag is --launch-input-sha256; launch_input_sha256 and launch_input_artifact_sha256 are artifact JSON fields.',
        `- Required completed-launch updates: ${REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS.join('; ')}.`,
        `- Trust boundary: ${LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY}`
    ].join('\n');
}

export function getReviewerLaunchArtifactMismatchReasons(
    artifact: Record<string, unknown>,
    options: {
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
        reviewOutputPath?: string | null;
        copyPasteReviewerLaunchPrompt?: string | null;
        copyPasteReviewerLaunchPromptSha256?: string | null;
        reviewTreeStateSha256: string | null;
        reviewerLaunchAttemptId?: string | null;
        launchBindingSha256: string;
        preparedLaunchEventSha256: string;
        routingEventSequence: number;
        timelineEvents: readonly ReviewDependencyTimelineEvent[];
        deferPreparedLaunchEventValidationForRecovery?: boolean;
    }
): string[] {
    const mismatches: string[] = [];
    if (getStringField(artifact, 'task_id', 'taskId') !== options.taskId) {
        mismatches.push('task_id mismatch');
    }
    if (getStringField(artifact, 'review_type', 'reviewType').toLowerCase() !== options.reviewType) {
        mismatches.push('review_type mismatch');
    }
    if (getStringField(artifact, 'reviewer_execution_mode', 'reviewerExecutionMode') !== options.reviewerExecutionMode) {
        mismatches.push('reviewer_execution_mode mismatch');
    }
    if (
        getStringField(artifact, 'reviewer_identity', 'reviewerIdentity', 'reviewer_session_id', 'reviewerSessionId') !== options.reviewerIdentity
    ) {
        mismatches.push('reviewer_identity mismatch');
    }
    if (getStringField(artifact, 'review_context_sha256', 'reviewContextSha256').toLowerCase() !== options.reviewContextSha256) {
        mismatches.push('review_context_sha256 mismatch');
    }
    if (getStringField(artifact, 'routing_event_sha256', 'routingEventSha256').toLowerCase() !== options.routingEventSha256) {
        mismatches.push('routing_event_sha256 mismatch');
    }
    if (
        options.reviewerPromptSha256
        && getStringField(artifact, 'reviewer_prompt_sha256', 'reviewerPromptSha256').toLowerCase() !== options.reviewerPromptSha256
    ) {
        mismatches.push('reviewer_prompt_sha256 mismatch');
    }
    if (
        options.rolePromptSha256
        && getStringField(artifact, 'role_prompt_sha256', 'rolePromptSha256').toLowerCase() !== options.rolePromptSha256
    ) {
        mismatches.push('role_prompt_sha256 mismatch');
    }
    if (
        options.promptTemplateSha256
        && getStringField(artifact, 'prompt_template_sha256', 'promptTemplateSha256').toLowerCase() !== options.promptTemplateSha256
    ) {
        mismatches.push('prompt_template_sha256 mismatch');
    }
    if (
        options.outputTemplateSha256
        && getStringField(artifact, 'output_template_sha256', 'outputTemplateSha256').toLowerCase() !== options.outputTemplateSha256
    ) {
        mismatches.push('output_template_sha256 mismatch');
    }
    if (
        options.evidenceManifestSha256
        && getStringField(artifact, 'evidence_manifest_sha256', 'evidenceManifestSha256').toLowerCase() !== options.evidenceManifestSha256
    ) {
        mismatches.push('evidence_manifest_sha256 mismatch');
    }
    if (
        options.reviewOutputPath
        && getStringField(artifact, 'review_output_path', 'reviewOutputPath') !== normalizePath(options.reviewOutputPath)
    ) {
        mismatches.push('review_output_path mismatch');
    }
    if (
        options.copyPasteReviewerLaunchPrompt
        && getStringField(artifact, 'copy_paste_reviewer_launch_prompt', 'copyPasteReviewerLaunchPrompt') !== options.copyPasteReviewerLaunchPrompt
    ) {
        mismatches.push('copy_paste_reviewer_launch_prompt mismatch');
    }
    if (
        options.copyPasteReviewerLaunchPromptSha256
        && getStringField(
            artifact,
            'copy_paste_reviewer_launch_prompt_sha256',
            'copyPasteReviewerLaunchPromptSha256'
        ).toLowerCase() !== options.copyPasteReviewerLaunchPromptSha256
    ) {
        mismatches.push('copy_paste_reviewer_launch_prompt_sha256 mismatch');
    }
    if (
        options.reviewTreeStateSha256
        && getStringField(artifact, 'review_tree_state_sha256', 'reviewTreeStateSha256').toLowerCase() !== options.reviewTreeStateSha256
    ) {
        mismatches.push('review_tree_state_sha256 mismatch');
    }
    if (getStringField(artifact, 'launch_binding_sha256', 'launchBindingSha256').toLowerCase() !== options.launchBindingSha256) {
        mismatches.push('launch_binding_sha256 mismatch');
    }
    if (!options.deferPreparedLaunchEventValidationForRecovery) {
        if (
            getStringField(artifact, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256').toLowerCase()
                !== options.preparedLaunchEventSha256
        ) {
            mismatches.push('prepared_launch_event_sha256 mismatch');
        } else if (
            !findMatchingReviewerLaunchPreparedEvent(options.timelineEvents, {
                taskId: options.taskId,
                reviewType: options.reviewType,
                reviewerExecutionMode: options.reviewerExecutionMode,
                reviewerIdentity: options.reviewerIdentity,
                reviewContextSha256: options.reviewContextSha256,
                routingEventSha256: options.routingEventSha256,
                reviewerLaunchAttemptId: options.reviewerLaunchAttemptId,
                launchBindingSha256: options.launchBindingSha256,
                preparedLaunchEventSha256: options.preparedLaunchEventSha256,
                minSequenceExclusive: options.routingEventSequence
            })
        ) {
            mismatches.push('prepared_launch_event_sha256 is not current telemetry');
        }
    }
    return mismatches;
}

export function findMatchingReviewerLaunchPreparedEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    options: {
        taskId: string;
        reviewType: string;
        reviewerExecutionMode: 'delegated_subagent';
        reviewerIdentity: string;
        reviewContextSha256: string;
        routingEventSha256: string;
        reviewerLaunchAttemptId?: string | null;
        launchBindingSha256: string;
        preparedLaunchEventSha256: string;
        minSequenceExclusive: number;
    }
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(options.reviewType || '').trim().toLowerCase();
    const normalizedTaskId = String(options.taskId || '').trim();
    const normalizedReviewContextSha256 = String(options.reviewContextSha256 || '').trim().toLowerCase();
    const normalizedRoutingEventSha256 = String(options.routingEventSha256 || '').trim().toLowerCase();
    const normalizedReviewerLaunchAttemptId = String(options.reviewerLaunchAttemptId || '').trim().toLowerCase();
    const normalizedLaunchBindingSha256 = String(options.launchBindingSha256 || '').trim().toLowerCase();
    const normalizedPreparedLaunchEventSha256 = String(options.preparedLaunchEventSha256 || '').trim().toLowerCase();
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        const details = entry.details;
        const detailsTaskId = String(details?.task_id || details?.taskId || '').trim();
        const detailsReviewContextSha256 = String(details?.review_context_sha256 || details?.reviewContextSha256 || '')
            .trim()
            .toLowerCase();
        const detailsRoutingEventSha256 = String(details?.routing_event_sha256 || details?.routingEventSha256 || '')
            .trim()
            .toLowerCase();
        const detailsLaunchBindingSha256 = String(details?.launch_binding_sha256 || details?.launchBindingSha256 || '')
            .trim()
            .toLowerCase();
        const detailsReviewerLaunchAttemptId = String(
            details?.reviewer_launch_attempt_id || details?.reviewerLaunchAttemptId || ''
        ).trim().toLowerCase();
        const detailsReviewerIdentity = String(
            (details?.reviewer_session_id ?? details?.reviewerSessionId ?? details?.reviewer_identity ?? details?.reviewerIdentity) || ''
        ).trim();
        if (
            entry.event_type === 'REVIEWER_LAUNCH_PREPARED'
            && entry.sequence > options.minSequenceExclusive
            && (!detailsTaskId || detailsTaskId === normalizedTaskId)
            && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === options.reviewerExecutionMode
            && reviewerIdentityMatchesDelegatedLaunchCycle({
                observedIdentity: detailsReviewerIdentity,
                expectedIdentity: options.reviewerIdentity,
                taskId: normalizedTaskId,
                reviewType: normalizedReviewType
            })
            && detailsReviewContextSha256 === normalizedReviewContextSha256
            && detailsRoutingEventSha256 === normalizedRoutingEventSha256
            && (!normalizedReviewerLaunchAttemptId || detailsReviewerLaunchAttemptId === normalizedReviewerLaunchAttemptId)
            && detailsLaunchBindingSha256 === normalizedLaunchBindingSha256
            && entry.integrity?.event_sha256 === normalizedPreparedLaunchEventSha256
        ) {
            return entry;
        }
    }
    return null;
}

export function findMatchingReviewerDelegationStartedEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    options: {
        taskId: string;
        reviewType: string;
        reviewerExecutionMode: 'delegated_subagent';
        reviewerIdentity: string;
        reviewContextSha256: string;
        routingEventSha256: string;
        reviewerLaunchAttemptId?: string | null;
        launchBindingSha256: string;
        preparedLaunchEventSha256: string;
        reviewerLaunchArtifactSha256?: string | null;
        providerInvocationId: string;
        delegationStartedAtUtc: string;
        minSequenceExclusive: number;
    }
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(options.reviewType || '').trim().toLowerCase();
    const normalizedTaskId = String(options.taskId || '').trim();
    const normalizedReviewContextSha256 = String(options.reviewContextSha256 || '').trim().toLowerCase();
    const normalizedRoutingEventSha256 = String(options.routingEventSha256 || '').trim().toLowerCase();
    const normalizedReviewerLaunchAttemptId = String(options.reviewerLaunchAttemptId || '').trim().toLowerCase();
    const normalizedReviewerLaunchArtifactSha256 = String(
        options.reviewerLaunchArtifactSha256 || ''
    ).trim().toLowerCase();
    const normalizedProviderInvocationId = String(options.providerInvocationId || '').trim();
    const normalizedDelegationStartedAtUtc = String(options.delegationStartedAtUtc || '').trim();
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        const details = entry.details;
        const detailsTaskId = String(details?.task_id || details?.taskId || '').trim();
        const detailsReviewContextSha256 = String(details?.review_context_sha256 || details?.reviewContextSha256 || '')
            .trim()
            .toLowerCase();
        const detailsRoutingEventSha256 = String(details?.routing_event_sha256 || details?.routingEventSha256 || '')
            .trim()
            .toLowerCase();
        const detailsProviderInvocationId = String(
            details?.provider_invocation_id
                || details?.providerInvocationId
                || details?.controller_invocation_id
                || details?.controllerInvocationId
                || ''
        ).trim();
        const detailsReviewerLaunchAttemptId = String(
            details?.reviewer_launch_attempt_id || details?.reviewerLaunchAttemptId || ''
        ).trim().toLowerCase();
        const detailsReviewerLaunchArtifactSha256 = String(
            details?.reviewer_launch_artifact_sha256
                || details?.reviewerLaunchArtifactSha256
                || ''
        ).trim().toLowerCase();
        const detailsDelegationStartedAtUtc = String(
            details?.delegation_started_at_utc || details?.delegationStartedAtUtc || ''
        ).trim();
        const detailsReviewerIdentity = String(
            (details?.reviewer_session_id ?? details?.reviewerSessionId ?? details?.reviewer_identity ?? details?.reviewerIdentity) || ''
        ).trim();
        if (
            entry.event_type === 'REVIEWER_DELEGATION_STARTED'
            && entry.sequence > options.minSequenceExclusive
            && (!detailsTaskId || detailsTaskId === normalizedTaskId)
            && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === options.reviewerExecutionMode
            && reviewerIdentityMatchesDelegatedLaunchCycle({
                observedIdentity: detailsReviewerIdentity,
                expectedIdentity: options.reviewerIdentity,
                taskId: normalizedTaskId,
                reviewType: normalizedReviewType
            })
            && detailsReviewContextSha256 === normalizedReviewContextSha256
            && detailsRoutingEventSha256 === normalizedRoutingEventSha256
            && (!normalizedReviewerLaunchAttemptId || detailsReviewerLaunchAttemptId === normalizedReviewerLaunchAttemptId)
            && (
                !normalizedReviewerLaunchArtifactSha256
                || detailsReviewerLaunchArtifactSha256 === normalizedReviewerLaunchArtifactSha256
            )
            && detailsProviderInvocationId === normalizedProviderInvocationId
            && detailsDelegationStartedAtUtc === normalizedDelegationStartedAtUtc
        ) {
            return entry;
        }
    }
    return null;
}

export function findMatchingReviewerLaunchCompletedEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    options: {
        taskId: string;
        reviewType: string;
        reviewerExecutionMode: 'delegated_subagent';
        reviewerIdentity: string;
        reviewContextSha256: string;
        routingEventSha256: string;
        reviewerLaunchAttemptId?: string | null;
        reviewerLaunchArtifactSha256: string;
        providerInvocationId: string;
        delegationStartedAtUtc: string;
        launchCompletedAtUtc: string;
        minSequenceExclusive: number;
    }
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(options.reviewType || '').trim().toLowerCase();
    const normalizedTaskId = String(options.taskId || '').trim();
    const normalizedReviewContextSha256 = String(options.reviewContextSha256 || '').trim().toLowerCase();
    const normalizedRoutingEventSha256 = String(options.routingEventSha256 || '').trim().toLowerCase();
    const normalizedReviewerLaunchAttemptId = String(options.reviewerLaunchAttemptId || '').trim().toLowerCase();
    const normalizedReviewerLaunchArtifactSha256 = String(options.reviewerLaunchArtifactSha256 || '').trim().toLowerCase();
    const normalizedProviderInvocationId = String(options.providerInvocationId || '').trim();
    const normalizedDelegationStartedAtUtc = String(options.delegationStartedAtUtc || '').trim();
    const normalizedLaunchCompletedAtUtc = String(options.launchCompletedAtUtc || '').trim();
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        const details = entry.details;
        const detailsTaskId = String(details?.task_id || details?.taskId || '').trim();
        const detailsReviewContextSha256 = String(details?.review_context_sha256 || details?.reviewContextSha256 || '')
            .trim()
            .toLowerCase();
        const detailsRoutingEventSha256 = String(details?.routing_event_sha256 || details?.routingEventSha256 || '')
            .trim()
            .toLowerCase();
        const detailsReviewerLaunchArtifactSha256 = String(
            details?.reviewer_launch_artifact_sha256 || details?.reviewerLaunchArtifactSha256 || ''
        ).trim().toLowerCase();
        const detailsReviewerLaunchAttemptId = String(
            details?.reviewer_launch_attempt_id || details?.reviewerLaunchAttemptId || ''
        ).trim().toLowerCase();
        const detailsProviderInvocationId = String(
            details?.provider_invocation_id
                || details?.providerInvocationId
                || details?.controller_invocation_id
                || details?.controllerInvocationId
                || ''
        ).trim();
        const detailsDelegationStartedAtUtc = String(
            details?.delegation_started_at_utc || details?.delegationStartedAtUtc || ''
        ).trim();
        const detailsLaunchCompletedAtUtc = String(
            details?.launch_completed_at_utc || details?.launchCompletedAtUtc || ''
        ).trim();
        const detailsReviewerIdentity = String(
            (details?.reviewer_session_id ?? details?.reviewerSessionId ?? details?.reviewer_identity ?? details?.reviewerIdentity) || ''
        ).trim();
        if (
            entry.event_type === 'REVIEWER_LAUNCH_COMPLETED'
            && entry.sequence > options.minSequenceExclusive
            && (!detailsTaskId || detailsTaskId === normalizedTaskId)
            && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === options.reviewerExecutionMode
            && reviewerIdentityMatchesDelegatedLaunchCycle({
                observedIdentity: detailsReviewerIdentity,
                expectedIdentity: options.reviewerIdentity,
                taskId: normalizedTaskId,
                reviewType: normalizedReviewType
            })
            && detailsReviewContextSha256 === normalizedReviewContextSha256
            && detailsRoutingEventSha256 === normalizedRoutingEventSha256
            && (!normalizedReviewerLaunchAttemptId || detailsReviewerLaunchAttemptId === normalizedReviewerLaunchAttemptId)
            && detailsReviewerLaunchArtifactSha256 === normalizedReviewerLaunchArtifactSha256
            && detailsProviderInvocationId === normalizedProviderInvocationId
            && detailsDelegationStartedAtUtc === normalizedDelegationStartedAtUtc
            && detailsLaunchCompletedAtUtc === normalizedLaunchCompletedAtUtc
        ) {
            return entry;
        }
    }
    return null;
}
