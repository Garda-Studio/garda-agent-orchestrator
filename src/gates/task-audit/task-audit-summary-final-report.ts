import type { FinalCloseoutArtifact } from './task-audit-summary';
import {
    getReviewIntegrityAttestation,
    type ReviewIntegrityAttestation,
    type ReviewTimingAuditEntry
} from './task-audit-summary-renderer-common';
const MAX_FINAL_USER_REPORT_FINDING_PREVIEW = 10;
const MAX_FINAL_USER_REPORT_INLINE_CHARACTERS = 1_000;
const MAX_FINAL_USER_REPORT_REVIEW_COMPONENT_CHARACTERS = 384;

interface FinalUserReportSection {
    preview: string[];
    totalEntries: number;
}

function createFinalUserReportSection(): FinalUserReportSection {
    return { preview: [], totalEntries: 0 };
}

function appendFinalUserReportSectionEntry(
    section: FinalUserReportSection,
    buildEntry: () => string
): void {
    section.totalEntries += 1;
    if (section.preview.length < MAX_FINAL_USER_REPORT_FINDING_PREVIEW) {
        section.preview.push(buildEntry());
    }
}

function normalizeBoundedFinalUserReportInlineText(
    value: unknown,
    maxCharacters: number = MAX_FINAL_USER_REPORT_INLINE_CHARACTERS
): string {
    const rawText = String(value ?? '');
    const omittedCharacterCount = Math.max(
        0,
        rawText.length - maxCharacters
    );
    const normalizedText = rawText
        .slice(0, maxCharacters)
        .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    return omittedCharacterCount > 0
        ? normalizedText + `... (${omittedCharacterCount} more character(s); see machine-readable closeout evidence.)`
        : normalizedText;
}

function formatFinalUserReportInlineText(value: unknown): string {
    const boundedText = normalizeBoundedFinalUserReportInlineText(value);
    const inlineText = boundedText
        .replace(/\\/gu, '\\\\')
        .replace(/\b([a-z][a-z0-9+.-]{1,31}):(?=\/\/)/giu, '$1\\:')
        .replace(
            /\b([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@((?:[a-z0-9-]+\.)+[a-z]{2,63})\b/giu,
            '$1\\@$2'
        )
        .replace(/\bwww\.(?=[a-z0-9])/giu, 'www\\.')
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/([`*_[\]!|~])/gu, '\\$1');
    return inlineText
        .replace(/^([#+\-=])/u, '\\$1')
        .replace(/^(\d{1,9})([.)])(?=\s)/u, '$1\\$2');
}

function formatDurationMsAsMinutesSeconds(durationMs: number | null | undefined): string {
    if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
        return 'unknown';
    }
    const totalSeconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function parseReviewTimingAuditTimestamp(value: string | null | undefined): number | null {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
}

function getReviewTimingAuditSortTimestamp(entry: ReviewTimingAuditEntry): number {
    return parseReviewTimingAuditTimestamp(entry.review_result_recorded_at_utc)
        ?? parseReviewTimingAuditTimestamp(entry.review_output_source_mtime_utc)
        ?? parseReviewTimingAuditTimestamp(entry.invocation_attested_at_utc)
        ?? parseReviewTimingAuditTimestamp(entry.launch_completed_at_utc)
        ?? parseReviewTimingAuditTimestamp(entry.launched_at_utc)
        ?? parseReviewTimingAuditTimestamp(entry.delegation_started_at_utc)
        ?? parseReviewTimingAuditTimestamp(entry.launch_prepared_at_utc)
        ?? Number.NEGATIVE_INFINITY;
}

function selectPreferredFinalUserReportTimingEntries(
    timingEntries: readonly ReviewTimingAuditEntry[],
    reviewType: string,
    limit: number
): { entries: ReviewTimingAuditEntry[]; totalEligibleEntries: number } {
    const selected: Array<{ entry: ReviewTimingAuditEntry; index: number }> = [];
    let totalEligibleEntries = 0;
    for (let index = 0; index < timingEntries.length; index += 1) {
        const entry = timingEntries[index];
        if (entry.review_type !== reviewType || entry.reused_existing_review) {
            continue;
        }
        totalEligibleEntries += 1;
        if (limit <= 0) {
            continue;
        }
        const insertionIndex = selected.findIndex((candidate) => (
            getReviewTimingAuditSortTimestamp(entry) < getReviewTimingAuditSortTimestamp(candidate.entry)
            || (
                getReviewTimingAuditSortTimestamp(entry) === getReviewTimingAuditSortTimestamp(candidate.entry)
                && index < candidate.index
            )
        ));
        if (insertionIndex < 0) {
            selected.push({ entry, index });
        } else {
            selected.splice(insertionIndex, 0, { entry, index });
        }
        if (selected.length > limit) {
            selected.pop();
        }
    }
    return {
        entries: selected.map(({ entry }) => entry),
        totalEligibleEntries
    };
}

export function formatReviewResultStatus(value: string): string {
    const text = String(value || '').trim();
    if (!text) {
        return 'unknown';
    }
    if (/\bPASSED\b/iu.test(text)) {
        return 'findings-satisfied';
    }
    if (/\bFAILED\b/iu.test(text)) {
        return 'findings-unsatisfied';
    }
    return text.toLowerCase();
}

function formatHumanReviewOutcome(value: string): string {
    const text = String(value || '').trim();
    if (/\bPASSED\b/iu.test(text)) {
        return 'passed';
    }
    if (/\bFAILED\b/iu.test(text)) {
        return 'failed';
    }
    return text ? text.toLowerCase() : 'unknown';
}

function buildUnescapedFinalUserReportReviewLine(
    reviewType: string,
    verdict: string,
    timingEntries: readonly ReviewTimingAuditEntry[],
    closeout: FinalCloseoutArtifact
): string {
    const boundedReviewType = normalizeBoundedFinalUserReportInlineText(
        reviewType,
        MAX_FINAL_USER_REPORT_REVIEW_COMPONENT_CHARACTERS
    );
    const boundedVerdict = normalizeBoundedFinalUserReportInlineText(
        verdict,
        MAX_FINAL_USER_REPORT_REVIEW_COMPONENT_CHARACTERS
    );
    const lane = closeout.review_findings_audit?.lanes.find((entry) => entry.review_type === reviewType);
    const hasUnmaterializedRequiredFollowUp = lane?.findings.some((finding) => (
        finding.action === 'create_follow_up'
        && (!finding.follow_up_task_id || finding.materialization_status !== 'MATERIALIZED')
    ));
    const hasMaterializedRequiredFollowUp = lane?.findings.some((finding) => (
        finding.action === 'create_follow_up'
        && !!finding.follow_up_task_id
        && finding.materialization_status === 'MATERIALIZED'
    ));
    const normalizedVerdict = /\bFAILED\b/iu.test(boundedVerdict)
        || (lane?.remaining_blocker_ids.length || 0) > 0
        || hasUnmaterializedRequiredFollowUp
        ? 'failed'
        : hasMaterializedRequiredFollowUp
            ? 'passed with follow-up'
            : formatHumanReviewOutcome(boundedVerdict);
    const recordedAttemptSummary = closeout.review_attempt_summary?.review_types
        .find((entry) => entry.review_type === reviewType);
    const recordedAttemptCount = recordedAttemptSummary?.total_attempts;
    const timingSelection = selectPreferredFinalUserReportTimingEntries(
        timingEntries,
        reviewType,
        recordedAttemptCount == null
            ? MAX_FINAL_USER_REPORT_FINDING_PREVIEW
            : Math.min(recordedAttemptCount, MAX_FINAL_USER_REPORT_FINDING_PREVIEW)
    );
    const attemptCount = recordedAttemptCount ?? timingSelection.totalEligibleEntries;
    const authenticatedTimedCount = Math.min(attemptCount, timingSelection.totalEligibleEntries);
    const durations = timingSelection.entries
        .slice(0, attemptCount)
        .map((entry) => formatDurationMsAsMinutesSeconds(entry.delegation_to_result_ms));
    const omittedDurationCount = Math.max(0, authenticatedTimedCount - durations.length);
    if (omittedDurationCount > 0) {
        durations.push(`${omittedDurationCount} more duration(s); see machine-readable closeout evidence`);
    }
    const missingDurationCount = Math.max(0, attemptCount - authenticatedTimedCount);
    if (missingDurationCount > 0) {
        durations.push(missingDurationCount === 1 ? 'unknown' : `unknown x${missingDurationCount}`);
    }
    const durationSuffix = durations.length > 0 ? ` (${durations.join(' / ')})` : '';
    return `${boundedReviewType}(${attemptCount}): ${normalizedVerdict}${durationSuffix}`;
}

function buildReviewTimingWarning(closeout: FinalCloseoutArtifact, attestation: ReviewIntegrityAttestation): string {
    const hasSuspiciousEntry = (closeout.review_timing_audit?.entries || [])
        .some((entry) => !entry.reused_existing_review && entry.hidden_timing_status === 'DISTRUSTED');
    if (hasSuspiciousEntry) {
        return 'WARNING: review accepted, but timing looked unusual; operator may double-check.';
    }
    if (attestation.completion_allowed !== true || attestation.status === 'DEGRADED_OR_UNVERIFIABLE') {
        return `WARNING: review evidence is degraded or unverifiable. ${attestation.reason}`;
    }
    return 'none';
}

function buildFullSuiteResult(closeout: FinalCloseoutArtifact): string {
    const status = String(closeout.workflow?.full_suite_timeout?.status || '').trim();
    if (status) {
        return status.toLowerCase();
    }
    if (closeout.workflow?.mandatory_full_suite_enabled !== true) {
        return 'not required';
    }
    return closeout.status === 'READY' && closeout.audit_status === 'PASS'
        ? 'passed'
        : 'result unavailable';
}

function appendExceptionalFullSuiteLines(
    section: FinalUserReportSection,
    closeout: FinalCloseoutArtifact
): void {
    const timeout = closeout.workflow?.full_suite_timeout;
    if (!timeout || (
        timeout.timed_out !== true
        && timeout.warnings.length === 0
        && !timeout.forecast_warning
        && !timeout.repair_task_proposal
    )) {
        return;
    }
    appendFinalUserReportSectionEntry(section, () => timeout.visible_summary_line);
    for (const warning of timeout.warnings) {
        appendFinalUserReportSectionEntry(section, () => `Warning: ${warning}`);
    }
    if (timeout.forecast_warning) {
        appendFinalUserReportSectionEntry(section, () => `Forecast warning: ${timeout.forecast_warning}`);
    }
    const repairTaskProposal = timeout.repair_task_proposal;
    if (repairTaskProposal) {
        appendFinalUserReportSectionEntry(section, () => (
            `RepairTask: ${repairTaskProposal.suggested_task_id} - ${repairTaskProposal.title}`
        ));
    }
}

function buildReviewFindingSections(closeout: FinalCloseoutArtifact): {
    nonBlocking: FinalUserReportSection;
    followUps: FinalUserReportSection;
    blockers: FinalUserReportSection;
    residualRisks: FinalUserReportSection;
} {
    const sections = {
        nonBlocking: createFinalUserReportSection(),
        followUps: createFinalUserReportSection(),
        blockers: createFinalUserReportSection(),
        residualRisks: createFinalUserReportSection()
    };
    const summary = closeout.review_findings_audit;
    if (!summary) {
        return sections;
    }
    const materializedFollowUpTaskIds = new Set<string>();
    for (const lane of summary.lanes) {
        for (const id of lane.remaining_blocker_ids) {
            const retainedItem = lane.findings.find((item) => (
                item.id === id
                && item.source_rule === 'review_follow_up_task_closure_policy.forbid_child_tasks'
            ));
            appendFinalUserReportSectionEntry(sections.blockers, () => retainedItem
                ? `${lane.review_type}/${id} retained in the current F task; descendant creation prohibited`
                : `${lane.review_type}/${id}`);
        }
        for (const item of lane.findings) {
            const requiresFollowUp = item.action === 'create_follow_up';
            const hasMaterializedFollowUp = requiresFollowUp
                && !!item.follow_up_task_id
                && item.materialization_status === 'MATERIALIZED';
            const missingRequiredFollowUp = requiresFollowUp && !hasMaterializedFollowUp;
            if (item.kind === 'finding' && !item.blocking && !missingRequiredFollowUp) {
                appendFinalUserReportSectionEntry(sections.nonBlocking, () => (
                    `${lane.review_type}/${item.id} (${item.severity}): ${item.title || item.description}`
                    + (item.source_rule === 'review_follow_up_task_closure_policy.skip_low_findings'
                        ? ' [ignored by F-task skip-low policy]'
                        : '')
                    + (item.follow_up_task_id ? ` -> ${item.follow_up_task_id}` : '')
                ));
            }
            if (
                hasMaterializedFollowUp
                && !materializedFollowUpTaskIds.has(item.follow_up_task_id!)
            ) {
                materializedFollowUpTaskIds.add(item.follow_up_task_id!);
                appendFinalUserReportSectionEntry(sections.followUps, () => item.follow_up_task_id!);
            }
            if (missingRequiredFollowUp) {
                appendFinalUserReportSectionEntry(
                    sections.blockers,
                    () => `${lane.review_type}/${item.id} has no materialized follow-up`
                );
            }
            if (item.kind === 'residual_risk') {
                appendFinalUserReportSectionEntry(
                    sections.residualRisks,
                    () => `${lane.review_type}/${item.id}: ${item.description}`
                );
            }
        }
    }
    return sections;
}

function formatFinalUserReportSectionEntries(
    section: FinalUserReportSection,
    entryLabel: string,
    emptyEntry: string = 'none'
): string[] {
    const entries = section.preview.map((entry) => formatFinalUserReportInlineText(entry));
    if (section.totalEntries > section.preview.length) {
        entries.push(formatFinalUserReportInlineText(
            `${section.totalEntries - section.preview.length} more ${entryLabel}(s); `
            + 'see machine-readable closeout evidence.'
        ));
    }
    return entries.length > 0 ? entries : [emptyEntry];
}

function pushReportSection(
    lines: string[],
    title: string,
    section: FinalUserReportSection,
    entryLabel: string
): void {
    lines.push('');
    lines.push(`${title}:`);
    lines.push(...formatFinalUserReportSectionEntries(section, entryLabel));
}

function selectFinalUserReportReviewEntries(
    verdicts: Readonly<Record<string, string>>
): { preview: Array<[string, string]>; totalEntries: number } {
    const preview: Array<[string, string]> = [];
    let totalEntries = 0;
    for (const reviewType in verdicts) {
        if (!Object.prototype.hasOwnProperty.call(verdicts, reviewType)) {
            continue;
        }
        totalEntries += 1;
        const entry: [string, string] = [reviewType, verdicts[reviewType]];
        const insertionIndex = preview.findIndex(([candidate]) => reviewType.localeCompare(candidate) < 0);
        if (insertionIndex < 0) {
            preview.push(entry);
        } else {
            preview.splice(insertionIndex, 0, entry);
        }
        if (preview.length > MAX_FINAL_USER_REPORT_FINDING_PREVIEW) {
            preview.pop();
        }
    }
    return { preview, totalEntries };
}

export function formatFinalUserReport(closeout: FinalCloseoutArtifact): string {
    const reviewIntegrityAttestation = getReviewIntegrityAttestation(closeout);
    const taskStatus = closeout.status === 'READY' && closeout.audit_status === 'PASS' ? 'DONE' : 'BLOCKED';
    const timingEntries = closeout.review_timing_audit?.entries || [];
    const reviewEntries = selectFinalUserReportReviewEntries(
        closeout.implementation_summary.review_verdicts || {}
    );
    const reviewSection = createFinalUserReportSection();
    reviewSection.totalEntries = reviewEntries.totalEntries;
    for (const [reviewType, verdict] of reviewEntries.preview) {
        reviewSection.preview.push(buildUnescapedFinalUserReportReviewLine(
            reviewType,
            verdict,
            timingEntries,
            closeout
        ));
    }
    const lines = [
        'GARDA FINAL REPORT',
        '',
        `Task: ${formatFinalUserReportInlineText(closeout.task_id)}`,
        `Status: ${taskStatus}`,
        '',
        'Reviews:'
    ];
    lines.push(...formatFinalUserReportSectionEntries(reviewSection, 'review', 'none required'));
    const closurePolicy = closeout.review_findings_audit?.review_follow_up_task_closure_policy;
    if (closurePolicy) {
        lines.push('');
        lines.push(
            `F-task closure policy: skip_low_findings=${closurePolicy.skip_low_findings}; `
            + `forbid_child_tasks=${closurePolicy.forbid_child_tasks}; `
            + `ignored_low=${closurePolicy.ignored_low_findings_count}; `
            + `retained_current_task=${closurePolicy.retained_current_task_count}; `
            + `prohibited_descendants=${closurePolicy.prohibited_descendant_creation_count}`
        );
    }
    lines.push('');
    lines.push(`Full suite: ${formatFinalUserReportInlineText(buildFullSuiteResult(closeout))}`);
    const findingSections = buildReviewFindingSections(closeout);
    pushReportSection(lines, 'Non-blocking findings', findingSections.nonBlocking, 'finding');
    pushReportSection(lines, 'Follow-ups', findingSections.followUps, 'follow-up');
    if (closeout.blocker) {
        appendFinalUserReportSectionEntry(findingSections.blockers, () => closeout.blocker!);
    }
    pushReportSection(lines, 'Unresolved blockers', findingSections.blockers, 'blocker');
    pushReportSection(lines, 'Residual risks', findingSections.residualRisks, 'residual risk');
    const processWarnings = createFinalUserReportSection();
    for (const entry of closeout.review_findings_audit?.correction_transports || []) {
        if (
            entry.event_type === 'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED'
            || entry.transport === 'full_reviewer_relaunch'
        ) {
            appendFinalUserReportSectionEntry(processWarnings, () => (
                `WARNING: review-output validation caused a full reviewer relaunch for ${entry.review_type}.`
            ));
        }
    }
    const timingWarning = buildReviewTimingWarning(closeout, reviewIntegrityAttestation);
    if (timingWarning !== 'none') {
        appendFinalUserReportSectionEntry(processWarnings, () => timingWarning);
    }
    appendExceptionalFullSuiteLines(processWarnings, closeout);
    for (const signal of closeout.known_non_blocking_signals || []) {
        appendFinalUserReportSectionEntry(
            processWarnings,
            () => `Known non-blocking notes: ${signal.summary}`
        );
    }
    if (processWarnings.totalEntries > 0) {
        pushReportSection(lines, 'Process warnings', processWarnings, 'process warning');
    }
    return lines.join('\n');
}
