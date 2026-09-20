import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    resolveContextOutputPath,
    resolveScopedDiffMetadataPath
} from '../../../../gates/review-context/build-review-context';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { resolveGateExecutionPath } from '../../../../gates/isolation/isolation-sandbox';
import {
    resolveRuntimeReviewerIdentity,
    type RuntimeReviewerIdentity
} from '../../../../gates/review/reviewer-routing';
import { getTaskModeEvidence } from '../../../../gates/task-mode/task-mode';
import type { ReviewContextSectionsResult } from '../../../../gate-runtime/review-context';
import type { ReviewDependencyTimelineEvent } from '../../../../gates/review/review-dependencies';
import type { TokenEconomyConfig } from '../../../../gates/review-context/review-context-token-economy';
import { REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION } from '../../../../gate-runtime/reviewer-session-contract';
import type {
    ReviewRemediationReviewContract,
    ReviewRemediationReviewContractValidationAuthority
} from '../../../../gates/review-remediation/review-remediation-review-contract';
import {
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from '../../cli-helpers';
import {
    buildKeyValueOutputLines,
    requireResolvedPath
} from '../../shared-command-utils';

export interface TimelineEventsSummaryResult {
    events: ReviewDependencyTimelineEvent[];
    hasInvalidLines: boolean;
}

export function readTimelineEventsSummary(timelinePath: string): TimelineEventsSummaryResult {
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return {
            events: [],
            hasInvalidLines: false
        };
    }
    const events: ReviewDependencyTimelineEvent[] = [];
    let hasInvalidLines = false;
    const lines = fs.readFileSync(timelinePath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
    for (let index = 0; index < lines.length; index += 1) {
        try {
            const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
            const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                ? parsed.details as Record<string, unknown>
                : null;
            const rawIntegrity = parsed.integrity && typeof parsed.integrity === 'object' && !Array.isArray(parsed.integrity)
                ? parsed.integrity as Record<string, unknown>
                : null;
            const taskSequence = typeof rawIntegrity?.task_sequence === 'number'
                ? rawIntegrity.task_sequence
                : Number(rawIntegrity?.task_sequence);
            const eventSha256 = String(rawIntegrity?.event_sha256 || '').trim().toLowerCase();
            const prevEventSha256Raw = rawIntegrity?.prev_event_sha256;
            const prevEventSha256 = prevEventSha256Raw == null
                ? null
                : String(prevEventSha256Raw).trim().toLowerCase() || null;
            events.push({
                event_type: String(parsed.event_type || '').trim().toUpperCase(),
                outcome: String(parsed.outcome || '').trim().toUpperCase(),
                sequence: index,
                details,
                integrity: rawIntegrity
                    && Number.isInteger(taskSequence)
                    && taskSequence > 0
                    && /^[0-9a-f]{64}$/.test(eventSha256)
                    && (prevEventSha256 == null || /^[0-9a-f]{64}$/.test(prevEventSha256))
                    ? {
                        schema_version: typeof rawIntegrity.schema_version === 'number'
                            ? rawIntegrity.schema_version
                            : Number(rawIntegrity.schema_version) || 1,
                        task_sequence: taskSequence,
                        prev_event_sha256: prevEventSha256,
                        event_sha256: eventSha256
                    }
                    : null
            });
        } catch {
            hasInvalidLines = true;
        }
    }
    return {
        events,
        hasInvalidLines
    };
}

export interface BuildReviewContextCommandResult {
    reviewType: string;
    outputPath: string;
    ruleContextArtifactPath: string;
    tokenEconomyActive: boolean;
    reusedReviewEvidence: boolean;
    acceptedReviewEvidenceKind: 'REUSED' | 'FRESH' | null;
    reusedReceiptPath: string | null;
    reusedReviewerExecutionMode: string | null;
    reusedReviewerIdentity: string | null;
    outputLines: string[];
}

export interface BuildReviewContextCommandOptions {
    reviewType?: unknown;
    depth?: unknown;
    preflightPath?: unknown;
    preflightPayload?: Record<string, unknown> | null;
    taskModePath?: unknown;
    taskModeEvidence?: ReturnType<typeof getTaskModeEvidence> | null;
    runtimeReviewerIdentity?: RuntimeReviewerIdentity | null;
    tokenEconomyConfigPath?: unknown;
    tokenEconomyConfigData?: TokenEconomyConfig | null;
    timelineEventsSummary?: TimelineEventsSummaryResult | null;
    scopedDiffMetadataPath?: unknown;
    outputPath?: unknown;
    repoRoot?: unknown;
    focusedRequiredTestPath?: unknown;
    reviewReuseBlockedReason?: unknown;
    remediationPreservedScopeMismatchReason?: unknown;
    reviewExecutionContract?: ReviewRemediationReviewContract | null;
    reviewExecutionValidationAuthority?: ReviewRemediationReviewContractValidationAuthority | null;
    persistedRemediationReuseRequired?: boolean;
    ruleContextSectionsCache?: Map<string, ReviewContextSectionsResult> | null;
    ruleFileContentCache?: Map<string, string> | null;
    telemetryLockTimeoutMs?: unknown;
    telemetryLockRetryMs?: unknown;
}

export interface ResolvedBuildReviewContextCommandInputs {
    repoRoot: string;
    reviewType: string;
    depth: number;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    taskModePath: string;
    taskId: string;
    taskModeEvidence: ReturnType<typeof getTaskModeEvidence> | null;
    runtimeReviewerIdentity: RuntimeReviewerIdentity | null;
    timelinePath: string | null;
    timelineSummary: TimelineEventsSummaryResult | null;
    tokenEconomyConfigPath: string;
    outputPath: string;
    scopedDiffMetadataPath: string;
    focusedRequiredTestPath: string | null;
    reviewReuseBlockedReason: string;
    reviewExecutionContract: ReviewRemediationReviewContract | null;
    reviewExecutionValidationAuthority: ReviewRemediationReviewContractValidationAuthority | null;
    persistedRemediationReuseRequired: boolean;
}

export function resolveBuildReviewContextCommandInputs(
    options: BuildReviewContextCommandOptions
): ResolvedBuildReviewContextCommandInputs {
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'Repo root');
    const reviewType = parseRequiredText(options.reviewType, 'ReviewType');
    const depth = Number.parseInt(parseRequiredText(options.depth, 'Depth'), 10);
    if (!Number.isInteger(depth) || depth < 1 || depth > 3) {
        throw new Error('Depth must be an integer between 1 and 3.');
    }
    const preflightPath = requireResolvedPath(
        gateHelpers.resolvePathInsideRepo(parseRequiredText(options.preflightPath, 'PreflightPath'), repoRoot),
        'PreflightPath'
    );
    if (!gateHelpers.isPathRealpathInsideRoot(preflightPath, repoRoot)) {
        throw new Error(
            `PreflightPath must resolve inside repo root without symlink or junction escape: ` +
            `${gateHelpers.normalizePath(preflightPath)}.`
        );
    }
    const preflightPayload = (
        options.preflightPayload
        && typeof options.preflightPayload === 'object'
        && !Array.isArray(options.preflightPayload)
    )
        ? options.preflightPayload
        : JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const taskModePath = String(options.taskModePath || '').trim();
    const taskId = String(preflightPayload.task_id || '').trim();
    const taskModeEvidence = taskId
        ? (
            options.taskModeEvidence
            || getTaskModeEvidence(repoRoot, taskId, taskModePath)
        )
        : null;
    const runtimeReviewerIdentity = taskId
        ? (
            options.runtimeReviewerIdentity
            || resolveRuntimeReviewerIdentity({
                repoRoot,
                taskId,
                taskModePath,
                taskModeEvidence,
                allowLegacyFallback: true
            })
        )
        : null;
    const timelinePath = taskId
        ? gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`))
        : null;
    const timelineSummary = timelinePath
        ? (options.timelineEventsSummary || readTimelineEventsSummary(timelinePath))
        : null;
    const tokenEconomyConfigPath = options.tokenEconomyConfigPath
        ? requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.tokenEconomyConfigPath), repoRoot, { allowMissing: true }),
            'TokenEconomyConfigPath'
        )
        : resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'token-economy.json'));
    const outputPath = resolveContextOutputPath(String(options.outputPath || ''), preflightPath, reviewType, repoRoot);
    const scopedDiffMetadataPath = resolveScopedDiffMetadataPath(
        String(options.scopedDiffMetadataPath || ''),
        preflightPath,
        reviewType,
        repoRoot
    );
    const focusedRequiredTestPath = gateHelpers.normalizePath(String(options.focusedRequiredTestPath || '').trim())
        .replace(/^\.\/?/u, '') || null;

    return {
        repoRoot,
        reviewType,
        depth,
        preflightPath,
        preflightPayload,
        taskModePath,
        taskId,
        taskModeEvidence,
        runtimeReviewerIdentity,
        timelinePath,
        timelineSummary,
        tokenEconomyConfigPath,
        outputPath,
        scopedDiffMetadataPath,
        focusedRequiredTestPath,
        reviewReuseBlockedReason: String(options.reviewReuseBlockedReason || '').trim(),
        reviewExecutionContract: options.reviewExecutionContract || null,
        reviewExecutionValidationAuthority: options.reviewExecutionValidationAuthority || null,
        persistedRemediationReuseRequired: options.persistedRemediationReuseRequired === true
    };
}

export function buildAcceptedCurrentPassReviewContextCommandResult(options: {
    reviewType: string;
    reviewContextPath: string;
    ruleContextArtifactPath: string | null;
    tokenEconomyActive: boolean;
    reusedExistingReview: boolean;
    receiptPath: string | null;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
    reason: string;
}): BuildReviewContextCommandResult {
    const reviewContextSha256 = gateHelpers.fileSha256(options.reviewContextPath) || '';
    const outputKV: Record<string, unknown> = {
        reviewContextPath: options.reviewContextPath,
        reviewContextSha256,
        outputPath: options.reviewContextPath,
        ruleContextArtifactPath: options.ruleContextArtifactPath,
        handoffInstruction: REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
        tokenEconomyActive: options.tokenEconomyActive,
        reviewReuseEvidence: options.reusedExistingReview ? 'REUSED' : 'FRESH',
        reviewReuseDecision: 'accepted',
        reviewReuseReason: options.reason,
        currentPassReviewEvidence: true
    };
    const orderedKeys = [
        'reviewContextPath',
        'reviewContextSha256',
        'outputPath',
        'ruleContextArtifactPath',
        'handoffInstruction',
        'tokenEconomyActive',
        'reviewReuseEvidence',
        'reviewReuseDecision',
        'reviewReuseReason',
        'currentPassReviewEvidence'
    ];
    if (options.reusedExistingReview) {
        outputKV.reusedReceiptPath = options.receiptPath;
        outputKV.reusedReviewerExecutionMode = options.reviewerExecutionMode;
        outputKV.reusedReviewerIdentity = options.reviewerIdentity;
        orderedKeys.push('reusedReceiptPath', 'reusedReviewerExecutionMode', 'reusedReviewerIdentity');
    }
    return {
        reviewType: options.reviewType,
        outputPath: options.reviewContextPath,
        ruleContextArtifactPath: options.ruleContextArtifactPath || '',
        tokenEconomyActive: options.tokenEconomyActive,
        reusedReviewEvidence: options.reusedExistingReview,
        acceptedReviewEvidenceKind: options.reusedExistingReview ? 'REUSED' : 'FRESH',
        reusedReceiptPath: options.reusedExistingReview ? options.receiptPath : null,
        reusedReviewerExecutionMode: options.reusedExistingReview ? options.reviewerExecutionMode : null,
        reusedReviewerIdentity: options.reusedExistingReview ? options.reviewerIdentity : null,
        outputLines: buildKeyValueOutputLines(outputKV, orderedKeys)
    };
}

export function buildGeneratedReviewContextCommandResult(options: {
    reviewType: string;
    outputPath: string;
    ruleContextArtifactPath: string;
    tokenEconomyActive: boolean;
    reviewReuseResult: {
        reused: boolean;
        receiptPath: string | null;
        reviewerExecutionMode: string | null;
        reviewerIdentity: string | null;
        reason: string;
    };
    currentPassReviewEvidenceAccepted: boolean;
    currentPassReviewEvidenceReason: string;
}): BuildReviewContextCommandResult {
    const reviewContextSha256 = gateHelpers.fileSha256(options.outputPath) || '';
    const outputKV: Record<string, unknown> = {
        reviewContextPath: options.outputPath,
        reviewContextSha256,
        reviewContextSha256Stage: 'generated_pre_routing',
        outputPath: options.outputPath,
        ruleContextArtifactPath: options.ruleContextArtifactPath,
        handoffInstruction: REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
        tokenEconomyActive: options.tokenEconomyActive,
        reviewReuseEvidence: options.reviewReuseResult.reused ? 'REUSED' : 'FRESH',
        reviewReuseDecision: options.reviewReuseResult.reused ? 'accepted' : 'rejected',
        reviewReuseReason: options.reviewReuseResult.reason,
        currentPassReviewEvidence: options.currentPassReviewEvidenceAccepted ? true : 'rejected',
        currentPassReviewEvidenceReason:
            'Prior review-context reuse candidate rejected before the ReviewContextSha256 shown above was generated: '
            + options.currentPassReviewEvidenceReason
    };
    const orderedKeys = [
        'reviewContextPath',
        'reviewContextSha256',
        'reviewContextSha256Stage',
        'outputPath',
        'ruleContextArtifactPath',
        'handoffInstruction',
        'tokenEconomyActive',
        'reviewReuseEvidence',
        'reviewReuseDecision',
        'reviewReuseReason',
        'currentPassReviewEvidence',
        'currentPassReviewEvidenceReason'
    ];
    if (options.reviewReuseResult.reused) {
        outputKV.reusedReceiptPath = options.reviewReuseResult.receiptPath;
        outputKV.reusedReviewerExecutionMode = options.reviewReuseResult.reviewerExecutionMode;
        outputKV.reusedReviewerIdentity = options.reviewReuseResult.reviewerIdentity;
        orderedKeys.push('reusedReceiptPath', 'reusedReviewerExecutionMode', 'reusedReviewerIdentity');
    }
    return {
        reviewType: options.reviewType,
        outputPath: options.outputPath,
        ruleContextArtifactPath: options.ruleContextArtifactPath,
        tokenEconomyActive: options.tokenEconomyActive,
        reusedReviewEvidence: options.reviewReuseResult.reused,
        acceptedReviewEvidenceKind: options.reviewReuseResult.reused ? 'REUSED' : null,
        reusedReceiptPath: options.reviewReuseResult.receiptPath,
        reusedReviewerExecutionMode: options.reviewReuseResult.reviewerExecutionMode,
        reusedReviewerIdentity: options.reviewReuseResult.reviewerIdentity,
        outputLines: buildKeyValueOutputLines(outputKV, orderedKeys)
    };
}
