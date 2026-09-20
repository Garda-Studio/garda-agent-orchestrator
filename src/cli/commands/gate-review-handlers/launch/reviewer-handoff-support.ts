import * as fs from 'node:fs';
import * as path from 'node:path';
import { compactGuidance } from '../../../../core/compact/guidance';
import { buildExhaustiveReviewContractLines } from '../../../../gates/review-context/review-context-artifacts';
import {
    buildReviewerFocusedSelfValidationContractLines,
    buildReviewerTerminalContractLines
} from '../../../../gates/review/reviewer-execution-contract';

import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleNameForTarget
} from '../../../../core/constants';
import { quoteCommandValue } from '../../../../core/command-quoting';
import {
    getProviderEntryById,
    normalizeProviderId
} from '../../../../core/provider-registry';
import { isOrchestratorSourceCheckout, normalizePath } from '../../../../gates/shared/helpers';
import {
    resolveReviewerHandoffArtifactBinding,
} from '../../../../gates/review/review-prompt-artifact';
import { resolveRuntimeReviewerIdentity } from '../../../../gates/review/reviewer-routing';
import {
    getObjectField,
    getStringField,
    toReviewerHandoffAbsolutePath
} from '../support/review-handler-common';
import { type ReviewDependencyTimelineEvent } from '../../../../gates/review/review-dependencies';
import { inspectTaskEventFile } from '../../../../gate-runtime/task-events-integrity';
import { resolveLaunchBindingReviewerIdentity } from '../../../../gate-runtime/review/reviewer-identity-contract';
import { isAuthenticatedReviewRestartBoundary } from '../../../../gates/review/review-restart-boundary';
import { buildReviewerLaunchBindingSha256 } from './review-launch-input-attestation';
import type { ReviewExecutionRuntimeBindings } from '../context/review-context-runtime-validation';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isReviewerLaunchAttemptSupersededByAuthenticatedRestart(
    timelinePath: string,
    taskId: string,
    reviewType: string,
    launchArtifactPath: string,
    launchArtifact: Record<string, unknown>
): boolean {
    const normalizedTaskId = taskId.trim();
    const normalizedReviewType = reviewType.trim().toLowerCase();
    const attemptId = getStringField(
        launchArtifact,
        'reviewer_launch_attempt_id',
        'reviewerLaunchAttemptId'
    ).toLowerCase();
    const preparedEventSha256 = getStringField(
        launchArtifact,
        'prepared_launch_event_sha256',
        'preparedLaunchEventSha256'
    ).toLowerCase();
    const preparedTaskSequence = Number(
        launchArtifact.prepared_launch_event_task_sequence
        ?? launchArtifact.preparedLaunchEventTaskSequence
        ?? 0
    );
    const reviewerExecutionMode = getStringField(
        launchArtifact,
        'reviewer_execution_mode',
        'reviewerExecutionMode'
    );
    const reviewerIdentity = getStringField(launchArtifact, 'reviewer_identity', 'reviewerIdentity');
    const plannedReviewerIdentity = getStringField(
        launchArtifact,
        'planned_reviewer_identity',
        'plannedReviewerIdentity'
    );
    const launchBindingReviewerIdentity = resolveLaunchBindingReviewerIdentity({
        taskId: normalizedTaskId,
        reviewType: normalizedReviewType,
        artifactReviewerIdentity: reviewerIdentity,
        plannedReviewerIdentity
    });
    const reviewContextSha256 = getStringField(
        launchArtifact,
        'review_context_sha256',
        'reviewContextSha256'
    ).toLowerCase();
    const routingEventSha256 = getStringField(
        launchArtifact,
        'routing_event_sha256',
        'routingEventSha256'
    ).toLowerCase();
    const reviewerPromptSha256 = getStringField(
        launchArtifact,
        'reviewer_prompt_sha256',
        'reviewerPromptSha256'
    ).toLowerCase();
    const launchBindingSha256 = getStringField(
        launchArtifact,
        'launch_binding_sha256',
        'launchBindingSha256'
    ).toLowerCase();
    const normalizedLaunchArtifactPath = normalizePath(path.resolve(launchArtifactPath));
    if (
        !normalizedTaskId
        || !normalizedReviewType
        || getStringField(launchArtifact, 'task_id', 'taskId') !== normalizedTaskId
        || getStringField(launchArtifact, 'review_type', 'reviewType').toLowerCase() !== normalizedReviewType
        || !attemptId
        || reviewerExecutionMode !== 'delegated_subagent'
        || !reviewerIdentity
        || !launchBindingReviewerIdentity
        || !/^[0-9a-f]{64}$/.test(reviewContextSha256)
        || !/^[0-9a-f]{64}$/.test(routingEventSha256)
        || !/^[0-9a-f]{64}$/.test(reviewerPromptSha256)
        || !/^[0-9a-f]{64}$/.test(launchBindingSha256)
        || buildReviewerLaunchBindingSha256({
            taskId: normalizedTaskId,
            reviewType: normalizedReviewType,
            reviewerExecutionMode,
            reviewerIdentity: launchBindingReviewerIdentity,
            reviewContextSha256,
            routingEventSha256,
            reviewerPromptSha256
        }) !== launchBindingSha256
        || !/^[0-9a-f]{64}$/.test(preparedEventSha256)
        || !Number.isInteger(preparedTaskSequence)
        || preparedTaskSequence <= 0
        || !fs.existsSync(timelinePath)
        || !inspectTaskEventFile(timelinePath, normalizedTaskId).status.startsWith('PASS')
    ) {
        return false;
    }

    const events = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
            try {
                const event = JSON.parse(line) as Record<string, unknown>;
                return [event];
            } catch {
                return [];
            }
        });
    const preparedEvent = events.find((event) => {
        const details = isPlainRecord(event.details) ? event.details : {};
        const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
        return String(event.event_type || '').trim() === 'REVIEWER_LAUNCH_PREPARED'
            && String(event.task_id || '').trim() === normalizedTaskId
            && String(event.outcome || '').trim() === 'INFO'
            && String(event.actor || '').trim() === 'orchestrator'
            && String(details.task_id || '').trim() === normalizedTaskId
            && String(details.review_type || '').trim().toLowerCase() === normalizedReviewType
            && String(details.reviewer_execution_mode || '').trim() === reviewerExecutionMode
            && String(details.reviewer_identity || '').trim() === launchBindingReviewerIdentity
            && String(details.review_context_sha256 || '').trim().toLowerCase() === reviewContextSha256
            && String(details.routing_event_sha256 || '').trim().toLowerCase() === routingEventSha256
            && String(details.reviewer_prompt_sha256 || '').trim().toLowerCase() === reviewerPromptSha256
            && String(details.launch_binding_sha256 || '').trim().toLowerCase() === launchBindingSha256
            && normalizePath(String(details.reviewer_launch_artifact_path || '').trim()) === normalizedLaunchArtifactPath
            && String(details.reviewer_launch_attempt_id || '').trim().toLowerCase() === attemptId
            && Number(integrity.task_sequence) === preparedTaskSequence
            && String(integrity.event_sha256 || '').trim().toLowerCase() === preparedEventSha256;
    });
    if (!preparedEvent) {
        return false;
    }
    const latestRestartSequence = events.reduce((latestSequence, event) => {
        if (!isAuthenticatedReviewRestartBoundary(
            event,
            normalizedTaskId,
            normalizedReviewType,
            preparedTaskSequence
        )) {
            return latestSequence;
        }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
        return Math.max(latestSequence, Number(integrity.task_sequence) || 0);
    }, 0);
    if (latestRestartSequence <= preparedTaskSequence) {
        return false;
    }
    const hasCurrentPreparedAttempt = events.some((event) => {
        const details = isPlainRecord(event.details) ? event.details : {};
        const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
        return String(event.event_type || '').trim() === 'REVIEWER_LAUNCH_PREPARED'
            && String(event.task_id || '').trim() === normalizedTaskId
            && String(event.outcome || '').trim() === 'INFO'
            && String(event.actor || '').trim() === 'orchestrator'
            && String(details.task_id || '').trim() === normalizedTaskId
            && String(details.review_type || '').trim().toLowerCase() === normalizedReviewType
            && Number(integrity.task_sequence) > latestRestartSequence;
    });
    return !hasCurrentPreparedAttempt;
}

export function isCompletedReviewerLaunchAttemptConsumed(
    timelineEvents: ReviewDependencyTimelineEvent[],
    launchArtifact: Record<string, unknown>
): boolean {
    const attemptId = getStringField(
        launchArtifact,
        'reviewer_launch_attempt_id',
        'reviewerLaunchAttemptId'
    ).toLowerCase();
    const reviewType = getStringField(launchArtifact, 'review_type', 'reviewType').toLowerCase();
    const reviewerIdentity = getStringField(
        launchArtifact,
        'reviewer_identity',
        'reviewerIdentity'
    );
    const reviewContextSha256 = getStringField(
        launchArtifact,
        'review_context_sha256',
        'reviewContextSha256'
    ).toLowerCase();
    if (!attemptId || !reviewType || !reviewerIdentity || !reviewContextSha256) {
        return false;
    }

    const completionEvent = timelineEvents.find((event) => {
        if (event.event_type !== 'REVIEWER_LAUNCH_COMPLETED' || !event.details) {
            return false;
        }
        return getStringField(
            event.details,
            'reviewer_launch_attempt_id',
            'reviewerLaunchAttemptId'
        ).toLowerCase() === attemptId
            && getStringField(event.details, 'review_type', 'reviewType').toLowerCase() === reviewType
            && getStringField(event.details, 'reviewer_identity', 'reviewerIdentity') === reviewerIdentity
            && getStringField(
                event.details,
                'review_context_sha256',
                'reviewContextSha256'
            ).toLowerCase() === reviewContextSha256;
    });
    if (!completionEvent) {
        return false;
    }

    return timelineEvents.some((event) => {
        if (
            event.sequence <= completionEvent.sequence
            || event.event_type !== 'REVIEW_RECORDED'
            || !event.details
        ) {
            return false;
        }
        return getStringField(event.details, 'review_type', 'reviewType').toLowerCase() === reviewType
            && getStringField(event.details, 'reviewer_identity', 'reviewerIdentity') === reviewerIdentity
            && getStringField(
                event.details,
                'review_context_sha256',
                'reviewContextSha256'
            ).toLowerCase() === reviewContextSha256;
    });
}

export interface ReviewerHandoffBindings {
    rolePromptPath: string | null;
    rolePromptSha256: string | null;
    promptTemplatePath: string;
    promptTemplateSha256: string;
    outputTemplatePath: string;
    outputTemplateSha256: string;
    evidenceManifestPath: string;
    evidenceManifestSha256: string;
}

export interface ReviewerLaunchPromptOptions {
    repoRoot: string;
    executionProvider?: string | null;
    taskId?: string | null;
    reviewType: string;
    reviewContextSha256?: string | null;
    reviewTreeStateSha256?: string | null;
    rolePromptPath: string | null;
    rolePromptSha256: string | null;
    reviewerPromptPath: string;
    reviewerPromptSha256: string;
    promptTemplatePath: string;
    promptTemplateSha256: string;
    outputTemplatePath: string;
    outputTemplateSha256: string;
    evidenceManifestPath: string;
    evidenceManifestSha256: string;
    reviewOutputPath: string;
    reviewExecutionBindings?: ReviewExecutionRuntimeBindings | null;
}

export function buildReviewerCompletenessCheckNotice(executionProvider: unknown): string {
    const checkingProvider = normalizeProviderId(executionProvider) === 'Claude'
        ? 'ChatGPT Codex'
        : 'Claude';
    return `The completeness of your review will be checked by ${checkingProvider}.`;
}

export interface ReviewerLaunchInputHandoffArtifactOptions extends ReviewerLaunchPromptOptions {
    taskId: string;
    reviewerLaunchAttemptId: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextPath: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    routingEventTaskSequence: number;
    launchBindingSha256: string;
    reviewOutputAttemptSha256: string;
    reviewTreeStateSha256: string | null;
    reviewExecutionBindings: ReviewExecutionRuntimeBindings;
    copyPasteReviewerLaunchPromptSha256: string;
    preparedLaunchEventSha256: string;
    preparedLaunchEventTaskSequence: number | null;
    reviewLaneArtifactEvidence: Readonly<Record<string, string>>;
    localTrustBoundary: string;
}

function quoteReviewerLaunchCommandValue(value: string): string {
    const normalizedValue = value.replace(/\\/g, '/');
    return normalizedValue.includes("'")
        ? quoteCommandValue(normalizedValue)
        : `'${normalizedValue}'`;
}

function quoteRecordReviewResultCommandValue(value: string): string {
    const normalizedValue = value.replace(/\\/g, '/');
    return normalizedValue.includes("'")
        ? quoteCommandValue(normalizedValue)
        : `'${normalizedValue}'`;
}

function toRepoRelativeCommandPath(repoRoot: string, artifactPath: string): string {
    if (/^<[^>]+>$/.test(String(artifactPath || '').trim())) {
        return artifactPath;
    }
    const relativePath = path.relative(repoRoot, artifactPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return normalizePath(artifactPath);
    }
    return normalizePath(relativePath);
}

function buildReviewerHandoffCliPrefix(repoRoot: string): string {
    return isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(repoRoot));
}

export function getReviewerScopedDiffHandoffPaths(repoRoot: string, reviewContext: Record<string, unknown>) {
    const scopedDiff = getObjectField(reviewContext, 'scoped_diff');
    if (!scopedDiff) {
        return {
            metadataPath: '',
            outputPath: '',
            cachePath: ''
        };
    }
    const metadata = getObjectField(scopedDiff, 'metadata');
    return {
        metadataPath: toReviewerHandoffAbsolutePath(repoRoot, getStringField(scopedDiff, 'metadata_path')),
        outputPath: toReviewerHandoffAbsolutePath(repoRoot, metadata ? getStringField(metadata, 'output_path') : ''),
        cachePath: toReviewerHandoffAbsolutePath(repoRoot, metadata ? getStringField(metadata, 'cache_path', 'diff_cache_path') : getStringField(scopedDiff, 'diff_cache_path'))
    };
}

export function buildRecordReviewInvocationCommand(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextPath: string;
    reviewerLaunchArtifactPath: string;
}): string {
    const cliPrefix = buildReviewerHandoffCliPrefix(options.repoRoot);
    const commandParts = [
        `${cliPrefix} gate record-review-invocation`,
        '--task-id', quoteReviewerLaunchCommandValue(options.taskId),
        '--review-type', quoteReviewerLaunchCommandValue(options.reviewType),
        '--review-context-path', quoteReviewerLaunchCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.reviewContextPath)),
        '--reviewer-execution-mode', quoteReviewerLaunchCommandValue(options.reviewerExecutionMode),
        '--reviewer-identity', quoteReviewerLaunchCommandValue(options.reviewerIdentity),
        '--reviewer-launch-artifact-path', quoteReviewerLaunchCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.reviewerLaunchArtifactPath)),
        '--repo-root', quoteReviewerLaunchCommandValue('.')
    ];
    return commandParts.join(' ');
}

export function buildCompleteReviewerLaunchCommand(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextPath: string;
    reviewerLaunchArtifactPath: string;
    providerInvocationId?: string | null;
    controllerInvocationId?: string | null;
    attestationSource: string;
    launchInputMode: 'copy_paste_prompt' | 'launch_artifact_path';
    launchInputArtifactPath?: string | null;
    launchInputSha256: string;
    forkContext: boolean;
    recordInvocation?: boolean;
}): string {
    const cliPrefix = buildReviewerHandoffCliPrefix(options.repoRoot);
    const commandParts = [
        `${cliPrefix} gate complete-reviewer-launch`,
        '--task-id', quoteReviewerLaunchCommandValue(options.taskId),
        '--review-type', quoteReviewerLaunchCommandValue(options.reviewType),
        '--review-context-path', quoteReviewerLaunchCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.reviewContextPath)),
        '--reviewer-execution-mode', quoteReviewerLaunchCommandValue(options.reviewerExecutionMode),
        '--reviewer-identity', quoteReviewerLaunchCommandValue(options.reviewerIdentity),
        '--reviewer-launch-artifact-path', quoteReviewerLaunchCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.reviewerLaunchArtifactPath))
    ];
    if (options.providerInvocationId) {
        commandParts.push('--provider-invocation-id', quoteReviewerLaunchCommandValue(options.providerInvocationId));
    } else if (options.controllerInvocationId) {
        commandParts.push('--controller-invocation-id', quoteReviewerLaunchCommandValue(options.controllerInvocationId));
    }
    commandParts.push(
        '--attestation-source', quoteReviewerLaunchCommandValue(options.attestationSource),
        '--launch-input-mode', quoteReviewerLaunchCommandValue(options.launchInputMode),
    );
    if (options.launchInputMode === 'launch_artifact_path') {
        const launchInputArtifactPath = String(options.launchInputArtifactPath || '').trim();
        if (launchInputArtifactPath) {
            commandParts.push(
                '--launch-input-artifact-path',
                quoteReviewerLaunchCommandValue(toRepoRelativeCommandPath(options.repoRoot, launchInputArtifactPath))
            );
        }
    }
    commandParts.push(
        '--launch-input-sha256', quoteReviewerLaunchCommandValue(options.launchInputSha256),
        '--fork-context', options.forkContext ? 'true' : 'false'
    );
    if (options.recordInvocation) {
        commandParts.push('--record-invocation');
    }
    commandParts.push('--repo-root', quoteReviewerLaunchCommandValue('.'));
    return commandParts.join(' ');
}

export function buildRecordReviewerLaunchFailedCommand(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextPath: string;
    reviewerLaunchArtifactPath: string;
    providerInvocationId?: string | null;
    controllerInvocationId?: string | null;
    failureReason: string;
}): string {
    const cliPrefix = buildReviewerHandoffCliPrefix(options.repoRoot);
    const commandParts = [
        `${cliPrefix} gate record-reviewer-launch-failed`,
        '--task-id', quoteReviewerLaunchCommandValue(options.taskId),
        '--review-type', quoteReviewerLaunchCommandValue(options.reviewType),
        '--review-context-path', quoteReviewerLaunchCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.reviewContextPath)),
        '--reviewer-execution-mode', quoteReviewerLaunchCommandValue(options.reviewerExecutionMode),
        '--reviewer-identity', quoteReviewerLaunchCommandValue(options.reviewerIdentity),
        '--reviewer-launch-artifact-path', quoteReviewerLaunchCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.reviewerLaunchArtifactPath))
    ];
    if (options.providerInvocationId) {
        commandParts.push('--provider-invocation-id', quoteReviewerLaunchCommandValue(options.providerInvocationId));
    } else if (options.controllerInvocationId) {
        commandParts.push('--controller-invocation-id', quoteReviewerLaunchCommandValue(options.controllerInvocationId));
    }
    commandParts.push(
        '--failure-reason', quoteReviewerLaunchCommandValue(options.failureReason),
        '--repo-root', quoteReviewerLaunchCommandValue('.')
    );
    return commandParts.join(' ');
}

export function buildRecordReviewResultCommand(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: string;
    reviewerIdentity: string;
    preflightPath: string;
    reviewContextPath: string;
    reviewOutputPath: string;
    taskModePath?: string | null;
}): string {
    const cliPrefix = buildReviewerHandoffCliPrefix(options.repoRoot);
    const commandParts = [
        `${cliPrefix} gate record-review-result`,
        '--task-id', quoteRecordReviewResultCommandValue(options.taskId),
        '--review-type', quoteRecordReviewResultCommandValue(options.reviewType),
        '--preflight-path', quoteRecordReviewResultCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.preflightPath)),
        '--review-context-path', quoteRecordReviewResultCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.reviewContextPath)),
        '--review-output-path', quoteRecordReviewResultCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.reviewOutputPath)),
        '--reviewer-execution-mode', quoteRecordReviewResultCommandValue(options.reviewerExecutionMode),
        '--reviewer-identity', quoteRecordReviewResultCommandValue(options.reviewerIdentity)
    ];
    if (options.taskModePath) {
        commandParts.push(
            '--task-mode-path',
            quoteRecordReviewResultCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.taskModePath))
        );
    }
    commandParts.push('--repo-root', quoteRecordReviewResultCommandValue('.'));
    return commandParts.join(' ');
}

export function resolveReviewerDraftOutputPath(
    reviewerLaunchArtifactPath: string,
    reviewOutputAttemptSha256?: string | null
): string {
    const normalizedAttemptSha256 = String(reviewOutputAttemptSha256 || '').trim().toLowerCase();
    const attemptSuffix = /^[0-9a-f]{64}$/.test(normalizedAttemptSha256)
        ? `-${normalizedAttemptSha256.slice(0, 16)}`
        : '';
    return path.join(path.dirname(reviewerLaunchArtifactPath), `review-output${attemptSuffix}.md`);
}

export function buildCopyPasteReviewerLaunchPrompt(options: ReviewerLaunchPromptOptions): string {
    const lines = [
        `You are the delegated ${options.reviewType} reviewer for this Garda task.`,
        buildReviewerCompletenessCheckNotice(options.executionProvider),
        `Repository: ${options.repoRoot}`,
        ...[compactGuidance(options.repoRoot, options.taskId || '', true)].filter(Boolean),
        'Reviewer-only boundary: you are not the main orchestrating agent for TASK.md.',
        'Do not run Garda workflow/navigation/validation gates such as next-step, classify-change, compile-gate, full-suite-validation, build-review-context, record-review-routing, prepare-reviewer-launch, record-reviewer-delegation-started, complete-reviewer-launch, record-review-invocation, or record-review-result.',
        'Do not launch another reviewer or subagent, and do not modify reviewer launch/control artifacts, task events, preflight artifacts, review context artifacts, receipts, TASK.md, or project memory.',
        'Only read the artifacts named in this handoff and write the completed review JSON to the single ReviewOutputPath when file writing is available.'
    ];
    if (options.rolePromptPath) {
        lines.push(`First open and read RolePromptPath: ${options.rolePromptPath}`);
        if (options.rolePromptSha256) {
            lines.push(`RolePromptSha256: ${options.rolePromptSha256}`);
        }
        lines.push(`Then open and read PromptTemplatePath: ${options.promptTemplatePath}`);
    } else {
        lines.push(`First open and read PromptTemplatePath: ${options.promptTemplatePath}`);
    }
    lines.push(
        `PromptTemplateSha256: ${options.promptTemplateSha256}`,
        `Then open and read ReviewerPromptPath: ${options.reviewerPromptPath}`,
        `ReviewerPromptSha256: ${options.reviewerPromptSha256}`,
        `Use EvidenceManifestPath to locate the review context, scoped diff, and supporting evidence: ${options.evidenceManifestPath}`,
        `EvidenceManifestSha256: ${options.evidenceManifestSha256}`,
        `Fill OutputTemplatePath exactly, preserving the required JSON object shape: ${options.outputTemplatePath}`,
        `OutputTemplateSha256: ${options.outputTemplateSha256}`,
        'Required JSON fields: schema_version, task_id, review_type, review_context_sha256, tree_state_sha256, validation_notes, coverage_ledger, findings, residual_risks, reviewer_notes.',
        `Required JSON binding values: task_id=${options.taskId || '<task-id>'}; review_type=${options.reviewType}; review_context_sha256=${options.reviewContextSha256 || '<review-context-sha256>'}; tree_state_sha256=${options.reviewTreeStateSha256 || '<tree-state-sha256>'}.`,
        ...(options.reviewExecutionBindings
            ? [`Required review execution binding: mode=${options.reviewExecutionBindings.review_execution_mode}; contract_sha256=${options.reviewExecutionBindings.review_execution_contract_sha256}; full_scope_sha256=${options.reviewExecutionBindings.review_execution_full_scope_sha256}; complete_scope_lineage_sha256=${options.reviewExecutionBindings.review_execution_complete_scope_lineage_sha256}; finding_reconciliation_sha256=${options.reviewExecutionBindings.review_execution_finding_reconciliation_sha256}.`]
            : []),
        'Active finding object fields: id, title, description, evidence[{location, observation}], coverage_obligation_ids. Put each active finding object in exactly one severity array: findings.critical, findings.high, findings.medium, or findings.low.',
        'Return exactly one JSON object; do not wrap it in Markdown fences and do not append prose outside the JSON object.',
        'Do not include review verdict, PASS/FAIL, status, downstream disposition, profile strictness, or remediation policy fields.',
        ...buildExhaustiveReviewContractLines(),
        ...buildReviewerFocusedSelfValidationContractLines(),
        `Write the final review report to ReviewOutputPath when file writing is available, or return the filled report in your final response: ${options.reviewOutputPath}`,
        'Do not replace the required JSON object with a summary sentence. After writing or returning that one object, stop immediately.',
        ...buildReviewerTerminalContractLines()
    );
    return lines.join('\n');
}

export function buildReviewerLaunchInputHandoffArtifact(
    options: ReviewerLaunchInputHandoffArtifactOptions
): Record<string, unknown> {
    const copyPasteReviewerLaunchPrompt = buildCopyPasteReviewerLaunchPrompt(options);
    return {
        reviewer_handoff_contract: `You are the delegated ${options.reviewType} reviewer for this Garda task.`,
        schema_version: 1,
        artifact_type: 'delegated_reviewer_handoff',
        handoff_role: 'delegated_reviewer',
        task_id: options.taskId,
        reviewer_launch_attempt_id: options.reviewerLaunchAttemptId,
        review_type: options.reviewType,
        reviewer_execution_mode: options.reviewerExecutionMode,
        reviewer_identity: options.reviewerIdentity,
        repository: options.repoRoot,
        review_context_path: options.reviewContextPath,
        review_context_sha256: options.reviewContextSha256,
        routing_event_sha256: options.routingEventSha256,
        routing_event_task_sequence: options.routingEventTaskSequence,
        launch_binding_sha256: options.launchBindingSha256,
        ...options.reviewLaneArtifactEvidence,
        prepared_launch_event_sha256: options.preparedLaunchEventSha256,
        prepared_launch_event_task_sequence: options.preparedLaunchEventTaskSequence,
        ...(options.rolePromptPath
            ? {
                role_prompt_path: options.rolePromptPath,
                role_prompt_sha256: options.rolePromptSha256
            }
            : {}),
        prompt_template_path: options.promptTemplatePath,
        prompt_template_sha256: options.promptTemplateSha256,
        reviewer_prompt_path: options.reviewerPromptPath,
        reviewer_prompt_sha256: options.reviewerPromptSha256,
        evidence_manifest_path: options.evidenceManifestPath,
        evidence_manifest_sha256: options.evidenceManifestSha256,
        output_template_path: options.outputTemplatePath,
        output_template_sha256: options.outputTemplateSha256,
        review_output_path: options.reviewOutputPath,
        review_output_attempt_sha256: options.reviewOutputAttemptSha256,
        review_tree_state_sha256: options.reviewTreeStateSha256,
        ...options.reviewExecutionBindings,
        copy_paste_reviewer_launch_prompt: copyPasteReviewerLaunchPrompt,
        copy_paste_reviewer_launch_prompt_sha256: options.copyPasteReviewerLaunchPromptSha256,
        reviewer_only_instructions: [
            ...[compactGuidance(options.repoRoot, options.taskId || '', true)].filter(Boolean),
            'Act as the delegated reviewer named by this artifact.',
            'You are not the main orchestrating agent for TASK.md.',
            'Do not launch another reviewer or subagent.',
            'Do not run Garda workflow/navigation/validation gates such as next-step, classify-change, compile-gate, full-suite-validation, build-review-context, record-review-routing, prepare-reviewer-launch, record-reviewer-delegation-started, complete-reviewer-launch, record-review-invocation, or record-review-result.',
            'Do not modify reviewer launch/control artifacts, task events, preflight artifacts, review context artifacts, receipts, TASK.md, or project memory.',
            'Only read the artifacts named in this handoff.',
            ...buildReviewerFocusedSelfValidationContractLines().map((line) => line.replace(/^- /u, '')),
            'Write the completed review report to review_output_path when file writing is available, or return it in the final response, then stop immediately.',
            ...buildReviewerTerminalContractLines().map((line) => line.replace(/^- /u, ''))
        ],
        local_trust_boundary: options.localTrustBoundary
    };
}

export function printCopyPasteReviewerLaunchPrompt(prompt: string): void {
    console.log('CopyPasteReviewerLaunchPrompt:');
    for (const line of prompt.split('\n')) {
        console.log(`  ${line}`);
    }
}

export function resolveReviewerHandoffBindings(options: {
    repoRoot: string;
    contextPath: string;
    reviewContext: Record<string, unknown>;
    gateName: string;
}): ReviewerHandoffBindings {
    const handoff = getObjectField(options.reviewContext, 'reviewer_handoff');
    const rolePrompt = handoff && getObjectField(handoff, 'role_prompt')
        ? resolveReviewerHandoffArtifactBinding({
            ...options,
            handoffKey: 'role_prompt',
            artifactLabel: 'reviewer role prompt'
        })
        : null;
    const promptTemplate = resolveReviewerHandoffArtifactBinding({
        ...options,
        handoffKey: 'prompt_template',
        artifactLabel: 'reviewer prompt template'
    });
    const outputTemplate = resolveReviewerHandoffArtifactBinding({
        ...options,
        handoffKey: 'output_template',
        artifactLabel: 'reviewer output template'
    });
    const evidenceManifest = resolveReviewerHandoffArtifactBinding({
        ...options,
        handoffKey: 'evidence_manifest',
        artifactLabel: 'reviewer evidence manifest'
    });
    return {
        rolePromptPath: rolePrompt?.artifactPath || null,
        rolePromptSha256: rolePrompt?.artifactSha256 || null,
        promptTemplatePath: promptTemplate.artifactPath,
        promptTemplateSha256: promptTemplate.artifactSha256,
        outputTemplatePath: outputTemplate.artifactPath,
        outputTemplateSha256: outputTemplate.artifactSha256,
        evidenceManifestPath: evidenceManifest.artifactPath,
        evidenceManifestSha256: evidenceManifest.artifactSha256
    };
}

export function getReviewTreeStateSha256(reviewContext: Record<string, unknown>): string {
    const treeState = reviewContext.tree_state
        && typeof reviewContext.tree_state === 'object'
        && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    return treeState
        ? getStringField(treeState, 'tree_state_sha256', 'treeStateSha256').toLowerCase()
        : '';
}

export function getReviewTreeStateLaunchSummary(reviewContext: Record<string, unknown>): Record<string, unknown> | null {
    const treeState = reviewContext.tree_state
        && typeof reviewContext.tree_state === 'object'
        && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    if (!treeState) {
        return null;
    }
    return {
        tree_state_sha256: getStringField(treeState, 'tree_state_sha256', 'treeStateSha256').toLowerCase(),
        detection_source: getStringField(treeState, 'detection_source', 'detectionSource'),
        use_staged: treeState.use_staged === true,
        include_untracked: treeState.include_untracked === true,
        changed_files: Array.isArray(treeState.changed_files) ? treeState.changed_files : [],
        stale_staged_snapshot_files: Array.isArray(treeState.stale_staged_snapshot_files)
            ? treeState.stale_staged_snapshot_files
            : []
    };
}

export function resolveProviderLaunchMetadata(runtimeIdentity: ReturnType<typeof resolveRuntimeReviewerIdentity>): {
    provider: string | null;
    launchTool: string;
    launchInstruction: string;
} {
    const provider = runtimeIdentity.execution_provider || runtimeIdentity.canonical_source_of_truth || null;
    const providerEntry = provider ? getProviderEntryById(provider) : null;
    return {
        provider,
        launchTool: providerEntry?.reviewerLaunchLabel || provider || 'delegated_subagent',
        launchInstruction: providerEntry?.delegatedReviewerLaunchInstruction
            || 'launch a clean-context reviewer sub-agent with isolated context.'
    };
}
