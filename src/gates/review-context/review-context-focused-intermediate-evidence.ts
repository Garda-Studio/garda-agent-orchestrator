import * as path from 'node:path';

import { type ReviewCoverageContract } from '../review/review-coverage-ledger';
import {
    readTaskOwnedFocusedIntermediateEvidence,
    type FocusedIntermediateEvidenceEntry
} from '../review/focused-intermediate-evidence';
import { normalizePath } from '../shared/helpers';
import { inspectReviewerFocusedValidationCommand } from '../review/review-findings-schema';

interface ReviewerFocusedCommandHints {
    status: 'AVAILABLE' | 'NOT_AVAILABLE';
    instruction: string;
    commands: {
        command: string;
        target: string;
        source_event_sequence: number;
        source_artifact_sha256: string;
    }[];
    rejected_command_count: number;
}

export interface ReviewContextFocusedIntermediateEvidence {
    schema_version: 1;
    task_id: string | null;
    review_type: string;
    status: 'AVAILABLE' | 'NOT_AVAILABLE';
    trust: {
        evidence_role: 'current_verification';
        replaces_mandatory_gates: false;
        implies_review_outcome: false;
        instruction: string;
    };
    scope_binding: {
        current_task_mode_sequence: number | null;
        preflight_path: string;
        preflight_sha256: string | null;
        coverage_contract_sha256: string;
    };
    entries: FocusedIntermediateEvidenceEntry[];
    reviewer_command_hints?: ReviewerFocusedCommandHints;
    warnings: string[];
    candidate_count: number;
    rejected_candidate_count: number;
    truncated: boolean;
}

export function buildFocusedIntermediateValidationEvidence(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string | null;
    reviewType: string;
    changedFiles: readonly string[];
    focusedRequiredTestPath?: string | null;
    preflightPath: string;
    preflightSha256: string | null;
    coverageContract: ReviewCoverageContract;
}): ReviewContextFocusedIntermediateEvidence {
    const eventsRoot = path.join(path.dirname(options.reviewsRoot), 'task-events');
    const selection = options.taskId
        ? readTaskOwnedFocusedIntermediateEvidence({
            repoRoot: options.repoRoot,
            reviewsRoot: options.reviewsRoot,
            eventsRoot,
            taskId: options.taskId,
            changedFiles: options.changedFiles,
            requiredTestPath: options.focusedRequiredTestPath,
            expectedPreflightPath: options.preflightPath,
            expectedPreflightSha256: options.preflightSha256,
            expectedCoverageContractSha256: options.coverageContract.contract_sha256
        })
        : {
            entries: [],
            warnings: ['focused intermediate evidence rejected: task id is missing'],
            latest_task_mode_sequence: null,
            candidate_count: 0,
            rejected_candidate_count: 0,
            truncated: false
        };
    return {
        schema_version: 1,
        task_id: options.taskId,
        review_type: options.reviewType,
        status: selection.entries.length > 0 ? 'AVAILABLE' : 'NOT_AVAILABLE',
        trust: {
            evidence_role: 'current_verification',
            replaces_mandatory_gates: false,
            implies_review_outcome: false,
            instruction: 'Focused validation evidence supplements the current review context. It does not replace compile, full-suite validation, or required review gates and does not imply a review outcome.'
        },
        scope_binding: {
            current_task_mode_sequence: selection.latest_task_mode_sequence,
            preflight_path: normalizePath(options.preflightPath),
            preflight_sha256: options.preflightSha256,
            coverage_contract_sha256: options.coverageContract.contract_sha256
        },
        entries: selection.entries,
        reviewer_command_hints: buildReviewerFocusedCommandHints(selection.entries, options.repoRoot),
        warnings: selection.warnings,
        candidate_count: selection.candidate_count,
        rejected_candidate_count: selection.rejected_candidate_count,
        truncated: selection.truncated
    };
}

function buildReviewerFocusedCommandHints(
    entries: readonly FocusedIntermediateEvidenceEntry[],
    repoRoot: string
): ReviewerFocusedCommandHints {
    const commands: ReviewerFocusedCommandHints['commands'] = [];
    const seenCommands = new Set<string>();
    let rejectedCommandCount = 0;
    for (const entry of entries) {
        const inspection = inspectReviewerFocusedValidationCommand(entry.command, repoRoot);
        if (
            !inspection.syntax_supported
            || !inspection.target
            || !entry.focused_test_paths.includes(inspection.target)
        ) {
            rejectedCommandCount += 1;
            continue;
        }
        if (!seenCommands.has(entry.command)) {
            seenCommands.add(entry.command);
            commands.push({
                command: entry.command,
                target: inspection.target,
                source_event_sequence: entry.event_task_sequence,
                source_artifact_sha256: entry.artifact_sha256
            });
        }
    }
    return {
        status: commands.length > 0 ? 'AVAILABLE' : 'NOT_AVAILABLE',
        instruction: 'Command hints use exact current authenticated focused evidence and the review-result command validator. They describe existing PASS evidence, not execution permission or a reason to repeat gate-owned checks. Absence is not a finding or proof that a configured check cannot run; never invent an inline compiler or temporary runner.',
        commands,
        rejected_command_count: rejectedCommandCount
    };
}

export function buildFocusedIntermediateValidationEvidenceMarkdown(
    evidence: ReviewContextFocusedIntermediateEvidence
): string[] {
    const lines = [
        '## Focused Intermediate Validation Evidence',
        `- Status: ${evidence.status}`,
        `- Current task-mode sequence: ${evidence.scope_binding.current_task_mode_sequence ?? 'unavailable'}`,
        `- Preflight sha256: ${evidence.scope_binding.preflight_sha256 || 'unavailable'}`,
        `- Coverage contract sha256: ${evidence.scope_binding.coverage_contract_sha256}`,
        `- Trust boundary: ${evidence.trust.instruction}`
    ];
    if (evidence.entries.length === 0) {
        lines.push('- Eligible focused command evidence: none');
    }
    for (const entry of evidence.entries) {
        lines.push(
            `- PASS ${entry.command_source}: ${entry.command}`,
            `  - Event: sequence=${entry.event_task_sequence}; timestamp=${entry.event_timestamp_utc}`,
            `  - Scope binding: preflight=${entry.preflight_path || 'unavailable'}; preflight_sha256=${entry.preflight_sha256 || 'unavailable'}; coverage_contract_sha256=${entry.coverage_contract_sha256 || 'unavailable'}`,
            `  - Record: ${entry.artifact_path} (sha256=${entry.artifact_sha256})`,
            `  - Output: ${entry.output_artifact_path} (sha256=${entry.output_artifact_sha256}; size=${entry.output_artifact_size_bytes})`,
            `  - Focused tests: ${entry.focused_test_paths.join(', ')}`
        );
    }
    for (const warning of evidence.warnings) {
        lines.push(`- Warning: ${warning}`);
    }
    if (evidence.truncated) {
        lines.push('- Warning: additional eligible focused evidence was omitted by the bounded handoff limit.');
    }
    const hints = evidence.reviewer_command_hints;
    if (hints) {
        lines.push(
            '### Reviewer Focused Command Hints',
            `- Status: ${hints.status}`,
            `- ${hints.instruction}`
        );
        for (const hint of hints.commands) {
            lines.push(
                `- Validator-compatible command: ${hint.command}`,
                `  - Exact target: ${hint.target}; source event: ${hint.source_event_sequence}; source artifact sha256: ${hint.source_artifact_sha256}`
            );
        }
        if (hints.commands.length === 0) {
            lines.push('- No exact validator-compatible command can be supplied from current authenticated focused evidence. Use the project-configured invocation or record concrete unavailable/prohibited diagnostics without creating a substitute runner.');
        }
    }
    return lines;
}
