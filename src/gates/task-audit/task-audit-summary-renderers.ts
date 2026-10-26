import { countNextStepWork } from '../../core/next-step-measurement';
import type { FinalCloseoutArtifact, TaskAuditSummaryResult } from './task-audit-summary';
import type { ReviewAttemptSummary } from './task-audit-summary-collectors';
import type { ReviewFindingsAuditSummary } from './task-audit-summary-review-findings';
import {
    buildAgentReportBlock,
    getAgentReportMessages
} from '../../cli/commands/cli-format-output';
import { buildTaskQueueStatusContract } from '../../core/task-queue-status-contract';
import {
    getReviewIntegrityAttestation,
    shouldRenderReviewTrustSummary,
    type ReviewIntegrityAttestation
} from './task-audit-summary-renderer-common';
import {
    getReviewExecutionPreparationOrder,
    type EffectiveReviewExecutionPolicyMode
} from '../../core/review-execution-policy';
import {
    formatKnownNonBlockingSignals
} from '../shared/known-nonblocking-signals';
export { buildCommitCommandSuggestion } from './task-audit-summary-commit-suggestion';
export { formatFinalUserReport } from './task-audit-summary-final-report';
import { formatReviewResultStatus } from './task-audit-summary-final-report';

function buildLocalizedCloseoutReviewMode(
    closeout: FinalCloseoutArtifact,
    reviewIntegrityAttestation: ReviewIntegrityAttestation
): string {
    const reportMessages = getAgentReportMessages();
    let trustPrefix: string;
    if (
        reviewIntegrityAttestation.status === 'INDEPENDENT_REVIEW_ATTESTED' &&
        reviewIntegrityAttestation.completion_review_attested
    ) {
        trustPrefix = reportMessages.summaries.independentReviewAttested;
    } else if (
        reviewIntegrityAttestation.status === 'NO_REVIEW_REQUIRED' ||
        reviewIntegrityAttestation.completion_review_attestation_not_required
    ) {
        trustPrefix = reportMessages.summaries.noRequiredReview;
    } else {
        trustPrefix = `review integrity=${reviewIntegrityAttestation.status}`;
    }
    const reviewResults = Object.entries(closeout.implementation_summary.review_verdicts)
        .map(([reviewType, verdict]) => (countNextStepWork('visit:task-audit-summary-renderers:event:44'), `${reviewType}=${formatReviewResultStatus(verdict)}`));
    if (reviewResults.length === 0) {
        return trustPrefix;
    }
    return `${trustPrefix}; review results: ${reviewResults.join(', ')}`;
}

function buildLocalizedOptionalSkillsSummary(
    closeout: FinalCloseoutArtifact
): string | null {
    const reportMessages = getAgentReportMessages();
    const summary = closeout.optional_skills;
    if (!summary) {
        return null;
    }
    const visibleSummaryLine = String(summary.visible_summary_line || '').trim();
    const reasonMatch = visibleSummaryLine.match(/(?:\(|,\s*)reason:\s*([^)]+)\)\s*$/i);
    const reasonValue = reasonMatch?.[1]?.trim() || null;
    const reasonSuffix = reasonValue
        ? ` (${reportMessages.summaries.reason}: ${reasonValue})`
        : '';
    if (summary.decision === 'selected_installed_skills' && summary.selected_skill_ids.length > 0) {
        if (summary.post_diff_self_check === true && visibleSummaryLine) {
            return visibleSummaryLine.replace(/^Optional skills:\s*/i, '');
        }
        if (summary.used_skill_ids.length === 0) {
            const selectedDetails = `${reportMessages.summaries.selected}: ${summary.selected_skill_ids.join(', ')}`;
            return `${reportMessages.summaries.noneUsed} (${selectedDetails}${reasonValue ? `, ${reportMessages.summaries.reason}: ${reasonValue}` : ''})`;
        }
        if (summary.used_skill_ids.length !== summary.selected_skill_ids.length) {
            return `${summary.used_skill_ids.join(', ')}${reasonSuffix}`;
        }
        return `${reportMessages.summaries.selected}: ${summary.selected_skill_ids.join(', ')}`;
    }
    if (summary.decision === 'recommended_missing_packs' && summary.recommended_missing_pack_ids.length > 0) {
        return `${reportMessages.summaries.recommendedPacks}: ${summary.recommended_missing_pack_ids.join(', ')}`;
    }
    if (summary.decision === 'as_is') {
        return `${reportMessages.summaries.noAdditionalSkills}${summary.as_is_reason ? ` (${summary.as_is_reason})` : ''}`;
    }
    if (summary.decision === 'unavailable' || summary.decision === 'invalidated') {
        return `${reportMessages.summaries.unavailable}${reasonSuffix}`;
    }
    if (visibleSummaryLine) {
        return visibleSummaryLine.replace(/^Optional skills:\s*/i, '');
    }
    return summary.visible_summary_line;
}

function getReviewAttemptSummaryLine(summary: ReviewAttemptSummary | null | undefined): string | null {
    const visibleSummaryLine = String(summary?.visible_summary_line || '').trim();
    const reviewCycleSummaryLine = String(summary?.review_cycle_summary_line || '').trim();
    if (visibleSummaryLine && reviewCycleSummaryLine) {
        return `${visibleSummaryLine}; ${reviewCycleSummaryLine}`;
    }
    return visibleSummaryLine || reviewCycleSummaryLine || null;
}

function appendReviewFindingsAuditLines(
    lines: string[],
    summary: ReviewFindingsAuditSummary | null | undefined,
    indent = ''
): void {
    if (!summary) {
        return;
    }
    lines.push(`${indent}${summary.visible_summary_line}`);
    if (summary.review_follow_up_task_closure_policy) {
        lines.push(`${indent}${summary.review_follow_up_task_closure_policy.visible_summary_line}`);
        for (const diagnostic of summary.review_follow_up_task_closure_policy.diagnostics) {
            lines.push(`${indent}  F-task closure policy diagnostic: ${diagnostic}`);
        }
    }
    for (const lane of summary.lanes) {
        lines.push(
            `${indent}Review findings ${lane.review_type}: source=${lane.source_mode}; validation=${lane.validation_status}; ` +
            `disposition=${lane.disposition_status}; fix_now=${lane.disposition_counts.fix_now}; ` +
            `follow_up=${lane.disposition_counts.create_follow_up}; ignored=${lane.disposition_counts.ignore}; ` +
            `remaining=${lane.remaining_blocker_ids.join(',') || 'none'}.`
        );
        for (const violation of lane.validation_violations) {
            lines.push(`${indent}  Validation violation: ${violation}`);
        }
        for (const item of lane.findings) {
            lines.push(
                `${indent}  Finding ${lane.review_type}/${item.id}: kind=${item.kind}; severity=${item.severity}; ` +
                `title=${item.title || 'none'}; ` +
                `action=${item.action || 'evidence_only'}; blocking=${item.blocking}; ` +
                `source_rule=${item.source_rule || 'none'}; ` +
                `materialization=${item.follow_up_task_id ? `task:${item.follow_up_task_id}` : item.materialization_status || 'none'}; ` +
                `evidence=${item.evidence_locations.join(',') || 'none'}; description=${item.description}`
            );
        }
        for (const violation of lane.disposition_violations) {
            lines.push(`${indent}  Disposition blocker: ${violation}`);
        }
    }
    for (const failure of summary.validation_failures) {
        lines.push(
            `${indent}Rejected findings validation ${failure.review_type} at ${failure.timestamp_utc || 'unknown'}: ` +
            `${failure.violation}`
        );
    }
    for (const cycle of summary.remediation_cycles) {
        countNextStepWork('visit:task-audit-summary-renderers:event:148');
        lines.push(
            `${indent}Remediation cycle ${cycle.timestamp_utc || 'unknown'}: reason=${cycle.reason || 'unknown'}; ` +
            `invalidated=${cycle.invalidated_review_types.join(',') || 'none'}; ` +
            `preserved=${cycle.preserved_review_types.join(',') || 'none'}; ` +
            `launch_required=${cycle.launch_required_review_types.join(',') || 'none'}; ` +
            `reused=${cycle.reused_review_types.join(',') || 'none'}.`
        );
    }
}

function formatTaskModeAuthorizationSummary(
    implementationSummary: FinalCloseoutArtifact['implementation_summary']
): string {
    const plannedChangedFiles = Array.isArray(implementationSummary.planned_changed_files)
        ? implementationSummary.planned_changed_files
        : [];
    const base =
        `orchestrator_work=${implementationSummary.orchestrator_work === true}; ` +
        `workflow_config_work=${implementationSummary.workflow_config_work === true}`;
    if (plannedChangedFiles.length === 0) {
        return base;
    }
    return `${base}; planned_changed_files=${plannedChangedFiles.join(', ')}`;
}

function formatAuthorizationScopeSnapshot(
    implementationSummary: FinalCloseoutArtifact['implementation_summary']
): string {
    const snapshot = implementationSummary.task_mode_scope_snapshot;
    const plannedChangedFiles = Array.isArray(snapshot?.planned_changed_files)
        ? snapshot.planned_changed_files
        : [];
    const dirtyWorkspaceBaselineChangedFiles = Array.isArray(snapshot?.dirty_workspace_baseline_changed_files)
        ? snapshot.dirty_workspace_baseline_changed_files
        : [];
    const authorizedChangedFiles = Array.isArray(snapshot?.authorized_changed_files)
        ? snapshot.authorized_changed_files
        : [];
    const parts = [
        `orchestrator_work=${snapshot?.orchestrator_work === true}`,
        `workflow_config_work=${snapshot?.workflow_config_work === true}`,
        `original_planned_changed_files=${plannedChangedFiles.length > 0 ? plannedChangedFiles.join(', ') : 'none'}`,
        `dirty_workspace_baseline_changed_files=${dirtyWorkspaceBaselineChangedFiles.length > 0 ? dirtyWorkspaceBaselineChangedFiles.join(', ') : 'none'}`,
        `authorized_changed_files=${authorizedChangedFiles.length > 0 ? authorizedChangedFiles.join(', ') : 'none'}`
    ];
    return `${parts.join('; ')} (historical task-mode authorization snapshot; current audited files are reported in ChangedFiles)`;
}

function formatFinalTrackedChangedLines(
    implementationSummary: FinalCloseoutArtifact['implementation_summary']
): string {
    const metrics = implementationSummary.change_metrics;
    if (!metrics || metrics.final_tracked_changed_lines_source !== 'workspace_snapshot') {
        return 'unavailable';
    }
    return String(metrics.final_tracked_changed_lines_total ?? 0);
}

function formatLateEvidenceFiles(
    implementationSummary: FinalCloseoutArtifact['implementation_summary']
): string {
    const lateEvidenceFiles = implementationSummary.change_metrics?.late_evidence_files || [];
    if (lateEvidenceFiles.length === 0) {
        return 'none';
    }
    return lateEvidenceFiles.join(', ');
}

function formatFullSuiteTimeoutWarnings(closeout: FinalCloseoutArtifact): string | null {
    const timeout = closeout.workflow?.full_suite_timeout;
    if (!timeout) {
        return null;
    }
    const warnings = [
        ...timeout.warnings,
        ...(timeout.forecast_warning ? [`Forecast: ${timeout.forecast_warning}`] : [])
    ];
    return warnings.length > 0 ? warnings.join(' | ') : null;
}

function isCommitCommandSuggestion(value: string): boolean {
    const trimmed = String(value || '').trim();
    return /^git\s+commit\s+-m\s+"/u.test(trimmed)
        || /\bgarda(?:\.js)?\s+gate\s+human-commit\b/u.test(trimmed)
        || /\bhuman-commit\s+--operator-confirmed\s+yes\b/u.test(trimmed);
}

function getOrderedRequiredReviewTypes(summary: TaskAuditSummaryResult): string[] {
    const policyMode = summary.final_closeout.workflow?.review_execution_policy_mode as EffectiveReviewExecutionPolicyMode | undefined;
    const preparationOrder = getReviewExecutionPreparationOrder(policyMode || 'legacy_test_downstream');
    return Object.entries(summary.required_reviews)
        .filter(([, required]) => (countNextStepWork('visit:task-audit-summary-renderers:event:239'), required))
        .map(([reviewType]) => (countNextStepWork('visit:task-audit-summary-renderers:event:239'), reviewType))
        .sort((left, right) => {
            countNextStepWork('visit:task-audit-summary-renderers:event:239');
            const leftRank = preparationOrder.indexOf(left);
            const rightRank = preparationOrder.indexOf(right);
            if (leftRank !== rightRank) {
                return (leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank)
                    - (rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank);
            }
            return left.localeCompare(right);
        });
}

export function formatFinalCloseoutMarkdown(closeout: FinalCloseoutArtifact): string {
    const reviewIntegrityAttestation = getReviewIntegrityAttestation(closeout);
    const profileText = closeout.implementation_summary.active_profile
        ? `profile=${closeout.implementation_summary.active_profile}`
        : 'profile=unknown';
    const pathModeText = closeout.implementation_summary.path_mode || 'unknown';
    const reviewResults = Object.entries(closeout.implementation_summary.review_verdicts)
        .map(([reviewType, verdict]) => (countNextStepWork('visit:task-audit-summary-renderers:event:259'), `\`${reviewType}: ${formatReviewResultStatus(verdict)}\``));
    const reviewResultText = reviewResults.length > 0 ? reviewResults.join(', ') : '`none required`';
    const docsUpdatedText = closeout.implementation_summary.docs_updated ? '`yes`' : '`no`';

    const lines: string[] = ['## Review Integrity Attestation'];
    for (const entry of reviewIntegrityAttestation.final_report_lines) {
        lines.push(`- ${entry}`);
    }
    if (reviewIntegrityAttestation.observed_issues.length > 0) {
        lines.push('- Observed review evidence issues:');
        for (const issue of reviewIntegrityAttestation.observed_issues) {
            lines.push(`  - ${issue}`);
        }
    }

    lines.push('');
    lines.push(
        `Task \`${closeout.task_id}\` completed in \`${profileText}\`, \`path mode=${pathModeText}\`. ` +
        `Review result status: ${reviewResultText}. Docs updated: ${docsUpdatedText}.`
    );
    lines.push(`Task-mode authorization: ${formatTaskModeAuthorizationSummary(closeout.implementation_summary)}.`);
    lines.push(`Task-mode authorization snapshot: ${formatAuthorizationScopeSnapshot(closeout.implementation_summary)}.`);
    lines.push(
        `Current audited changed files: ${closeout.implementation_summary.changed_files_count}.`
    );
    lines.push(`Preflight changed lines: ${closeout.implementation_summary.change_metrics?.preflight_changed_lines_total ?? closeout.implementation_summary.changed_lines_total}.`);
    lines.push(`Final tracked changed lines: ${formatFinalTrackedChangedLines(closeout.implementation_summary)}.`);
    lines.push(`Late evidence files: ${formatLateEvidenceFiles(closeout.implementation_summary)}.`);

    if (closeout.optional_skills?.visible_summary_line) {
        lines.push(closeout.optional_skills.visible_summary_line);
    }

    if (shouldRenderReviewTrustSummary(closeout, reviewIntegrityAttestation) && closeout.review_trust?.visible_summary_line) {
        lines.push(closeout.review_trust.visible_summary_line);
    }

    if (shouldRenderReviewTrustSummary(closeout, reviewIntegrityAttestation) && closeout.review_trust?.policy_summary_line) {
        lines.push(closeout.review_trust.policy_summary_line);
    }

    const reviewAttemptSummaryLine = getReviewAttemptSummaryLine(closeout.review_attempt_summary);
    if (reviewAttemptSummaryLine) {
        lines.push(reviewAttemptSummaryLine);
    }
    appendReviewFindingsAuditLines(lines, closeout.review_findings_audit);
    if (closeout.review_coverage_summary) {
        lines.push(closeout.review_coverage_summary.visible_summary_line);
        for (const entry of closeout.review_coverage_summary.entries) {
            countNextStepWork('visit:task-audit-summary-renderers:event:308');
            lines.push(
                `Review coverage ${entry.review_type}: status=${entry.status}; ` +
                `mode=${entry.review_execution_mode || 'legacy_unknown'}; ` +
                `obligations=${entry.completed_obligation_count}/${entry.obligation_count}; ` +
                `omitted=${entry.omitted_obligation_ids.join(',') || 'none'}; ` +
                `violations=${entry.violations.join(',') || 'none'}.`
            );
        }
    }

    if (closeout.review_timing_audit?.visible_summary_line) {
        lines.push(closeout.review_timing_audit.visible_summary_line);
    }

    if (closeout.workflow?.visible_summary_line) {
        lines.push(closeout.workflow.visible_summary_line);
    }

    if (closeout.workflow?.full_suite_timeout?.visible_summary_line) {
        lines.push(closeout.workflow.full_suite_timeout.visible_summary_line);
        const timeoutWarnings = formatFullSuiteTimeoutWarnings(closeout);
        if (timeoutWarnings) {
            lines.push(`Full-suite timeout warnings: ${timeoutWarnings}`);
        }
    }

    if (closeout.workflow?.review_execution_policy_summary_line) {
        lines.push(closeout.workflow.review_execution_policy_summary_line);
    }

    if (
        closeout.workflow?.workflow_config_audit
        && closeout.workflow.workflow_config_audit.status !== 'none'
    ) {
        lines.push(closeout.workflow.workflow_config_audit.visible_summary_line);
    }

    if (closeout.project_memory?.visible_summary_line) {
        lines.push(closeout.project_memory.visible_summary_line);
    }
    if (closeout.orchestrator_defect_capture) {
        lines.push(closeout.orchestrator_defect_capture.visible_summary_line);
        for (const record of closeout.orchestrator_defect_capture.records) {
            countNextStepWork('visit:task-audit-summary-renderers:event:351');
            lines.push(
                `Orchestrator defect ${record.defect_id || 'unknown'}: status=${record.status}; `
                + `resolution=${record.resolution || 'missing'}; `
                + `problem_record=${record.problem_record_id || 'missing'}; `
                + `follow_up=${record.follow_up_task_id || 'missing'}.`
            );
        }
    }
    const knownNonBlockingSignalsLine = formatKnownNonBlockingSignals(closeout.known_non_blocking_signals || []);
    if (knownNonBlockingSignalsLine) {
        lines.push(knownNonBlockingSignalsLine);
    }

    if (closeout.token_economy?.visible_summary_line) {
        lines.push(closeout.token_economy.visible_summary_line);
    }

    if (closeout.task_cycle_diagnostics && closeout.task_cycle_diagnostics.status !== 'NONE') {
        lines.push(closeout.task_cycle_diagnostics.visible_summary_line);
    }

    lines.push((closeout.task_queue_status_contract || buildTaskQueueStatusContract(closeout.task_id)).visible_summary_line);
    lines.push('');
    lines.push(buildAgentReportBlock({
        context: 'task_closeout',
        assistantLanguage: closeout.agent_report?.assistant_language || null,
        assistantLanguageConfirmed: closeout.agent_report?.assistant_language_confirmed ?? null,
        profileSummary: closeout.implementation_summary.active_profile,
        reviewModeSummary: buildLocalizedCloseoutReviewMode(closeout, reviewIntegrityAttestation),
        optionalSkillsSummary: buildLocalizedOptionalSkillsSummary(closeout),
        mandatoryFullSuiteEnabled: closeout.workflow?.mandatory_full_suite_enabled ?? null,
        nextTaskPrompt: closeout.agent_report?.next_task_command || null,
        latestUpdateNotice: closeout.agent_report?.latest_update_notice || null
    }));

    lines.push('');
    if (isCommitCommandSuggestion(closeout.commit_command_suggestion)) {
        lines.push('Suggested commit command:');
        lines.push('```bash');
        lines.push(closeout.commit_command_suggestion);
        lines.push('```');
        lines.push('');
        lines.push(closeout.commit_question);
    } else {
        lines.push('Commit guidance:');
        lines.push(closeout.commit_command_suggestion);
        if (closeout.commit_question) {
            lines.push(closeout.commit_question);
        }
    }

    return lines.join('\n');
}

export function formatTaskAuditSummaryText(summary: TaskAuditSummaryResult): string {
    const lines: string[] = [];

    lines.push(`Task: ${summary.task_id}`);
    lines.push(`Status: ${summary.status}`);
    lines.push(`Events: ${summary.events_count}`);
    lines.push(`Integrity: ${summary.integrity_status}`);
    if (summary.first_event_utc) lines.push(`FirstEvent: ${summary.first_event_utc}`);
    if (summary.last_event_utc) lines.push(`LastEvent: ${summary.last_event_utc}`);

    lines.push('');
    lines.push('Gates:');
    for (const gate of summary.gates) {
        const marker = gate.status === 'PASS' ? '[+]' : gate.status === 'FAIL' ? '[X]' : '[ ]';
        const ts = gate.timestamp_utc ? ` (${gate.timestamp_utc})` : '';
        lines.push(`  ${marker} ${gate.gate}${ts}`);
    }

    lines.push('');
    lines.push(`ChangedFiles: ${summary.changed_files_count}`);
    for (const file of summary.changed_files) {
        lines.push(`  - ${file}`);
    }

    const activeReviews = getOrderedRequiredReviewTypes(summary);
    if (activeReviews.length > 0) {
        lines.push('');
        lines.push(`RequiredReviews: ${activeReviews.join(', ')}`);
    }

    if (summary.scope_category) {
        lines.push(`ScopeCategory: ${summary.scope_category}`);
    }

    if (summary.task_cycle_diagnostics && summary.task_cycle_diagnostics.status !== 'NONE') {
        lines.push(`TaskCycleDiagnostics: ${summary.task_cycle_diagnostics.visible_summary_line}`);
    }

    lines.push(`TaskModeAuthorization: ${formatTaskModeAuthorizationSummary(summary.final_closeout.implementation_summary)}`);
    lines.push(`TaskModeAuthorizationSnapshot: ${formatAuthorizationScopeSnapshot(summary.final_closeout.implementation_summary)}`);
    lines.push(`CurrentAuditedChangedFiles: ${summary.changed_files_count}`);
    lines.push(`PreflightChangedLines: ${summary.final_closeout.implementation_summary.change_metrics?.preflight_changed_lines_total ?? summary.changed_lines_total}`);
    lines.push(`FinalTrackedChangedLines: ${formatFinalTrackedChangedLines(summary.final_closeout.implementation_summary)}`);
    lines.push(`LateEvidenceFiles: ${formatLateEvidenceFiles(summary.final_closeout.implementation_summary)}`);

    const reviewAttemptSummaryLine = getReviewAttemptSummaryLine(summary.review_attempt_summary);
    if (reviewAttemptSummaryLine) {
        lines.push('');
        lines.push(reviewAttemptSummaryLine);
    }
    appendReviewFindingsAuditLines(lines, summary.review_findings_audit);
    if (summary.review_coverage_summary) {
        lines.push(summary.review_coverage_summary.visible_summary_line);
        for (const entry of summary.review_coverage_summary.entries) {
            countNextStepWork('visit:task-audit-summary-renderers:event:459');
            lines.push(
                `  - ${entry.review_type}: status=${entry.status}; ` +
                `mode=${entry.review_execution_mode || 'legacy_unknown'}; ` +
                `obligations=${entry.completed_obligation_count}/${entry.obligation_count}; ` +
                `omitted=${entry.omitted_obligation_ids.join(',') || 'none'}; ` +
                `duplicate=${entry.duplicate_obligation_ids.join(',') || 'none'}; ` +
                `unknown=${entry.unknown_obligation_ids.join(',') || 'none'}; ` +
                `violations=${entry.violations.join(',') || 'none'}`
            );
        }
    }

    if (summary.profile_review_decisions) {
        const prd = summary.profile_review_decisions;
        lines.push('');
        lines.push('ProfileReviewDecisions:');
        if (prd.profile_name) lines.push(`  Profile: ${prd.profile_name}`);
        if (prd.scope_category) lines.push(`  ScopeCategory: ${prd.scope_category}`);
        lines.push(`  GuardrailsActive: ${prd.guardrails_active}`);
        lines.push(`  LighteningEligible: ${prd.lightening_eligible}`);
        if (prd.decisions.length > 0) {
            for (const d of prd.decisions) {
                const marker = d.decision === 'safety_floor_enforced' ? '[!]'
                    : d.decision === 'lightened_by_profile' || d.decision === 'not_required_by_preflight' ? '[-]'
                        : d.decision === 'domain_triggered' || d.decision === 'preflight_required' ? '[+]'
                            : '[=]';
                const reasonSuffix = d.reason ? ` - ${d.reason}` : '';
                lines.push(`  ${marker} ${d.review_type}: ${d.effective_value} (${d.decision})${reasonSuffix}`);
            }
        }
        if (prd.safety_floors_applied.length > 0) {
            lines.push('  SafetyFloors:');
            for (const f of prd.safety_floors_applied) {
                lines.push(`    - ${f}`);
            }
        }
    }

    const presentEvidence = summary.evidence.filter((e) => e.exists);
    const missingEvidence = summary.evidence.filter((e) => !e.exists);
    lines.push('');
    lines.push(`Evidence (${presentEvidence.length} present, ${missingEvidence.length} absent):`);
    for (const e of presentEvidence) {
        lines.push(`  [+] ${e.kind}: ${e.path}`);
    }
    for (const e of missingEvidence) {
        lines.push(`  [ ] ${e.kind}: ${e.path}`);
    }

    if (summary.blockers.length > 0) {
        lines.push('');
        lines.push('Blockers:');
        for (const b of summary.blockers) {
            lines.push(`  [!] ${b.gate}: ${b.reason}`);
        }
    }

    if (summary.point_in_time_snapshot.status !== 'STABLE') {
        lines.push('');
        lines.push(`PointInTimeSnapshot: ${summary.point_in_time_snapshot.status}`);
        if (summary.point_in_time_snapshot.message) {
            lines.push(`  Reason: ${summary.point_in_time_snapshot.message}`);
        }
        if (summary.point_in_time_snapshot.recommended_action) {
            lines.push(`  RecommendedAction: ${summary.point_in_time_snapshot.recommended_action}`);
        }
        if (summary.point_in_time_snapshot.lock_path) {
            lines.push(`  LockPath: ${summary.point_in_time_snapshot.lock_path}`);
        }
        if (summary.point_in_time_snapshot.owner_pid !== undefined) {
            lines.push(`  OwnerPid: ${summary.point_in_time_snapshot.owner_pid === null ? 'unknown' : summary.point_in_time_snapshot.owner_pid}`);
        }
        if (summary.point_in_time_snapshot.owner_hostname !== undefined) {
            lines.push(`  OwnerHost: ${summary.point_in_time_snapshot.owner_hostname || 'unknown'}`);
        }
        if (summary.point_in_time_snapshot.owner_created_at_utc !== undefined) {
            lines.push(`  OwnerCreatedAtUtc: ${summary.point_in_time_snapshot.owner_created_at_utc || 'unknown'}`);
        }
        if (summary.point_in_time_snapshot.owner_alive !== undefined) {
            lines.push(`  OwnerAlive: ${summary.point_in_time_snapshot.owner_alive === null ? 'unknown' : summary.point_in_time_snapshot.owner_alive}`);
        }
        if (summary.point_in_time_snapshot.owner_metadata_status !== undefined) {
            lines.push(`  OwnerMetadataStatus: ${summary.point_in_time_snapshot.owner_metadata_status || 'unknown'}`);
        }
        if (summary.point_in_time_snapshot.stale_reason !== undefined) {
            lines.push(`  StaleReason: ${summary.point_in_time_snapshot.stale_reason || 'none'}`);
        }
        if (summary.point_in_time_snapshot.subsystem_scope_note) {
            lines.push(`  Scope: ${summary.point_in_time_snapshot.subsystem_scope_note}`);
        }
        if (summary.point_in_time_snapshot.acquisition_policy) {
            lines.push(
                `  AcquisitionPolicy: timeout=${summary.point_in_time_snapshot.acquisition_policy.timeout_ms}ms ` +
                `retry=${summary.point_in_time_snapshot.acquisition_policy.retry_ms}ms ` +
                `stale_after=${summary.point_in_time_snapshot.acquisition_policy.stale_after_ms}ms`
            );
        }
    }

    lines.push('');
    lines.push(`FinalReportContract: ${summary.final_report_contract.status}`);
    if (summary.final_report_contract.blocker) {
        lines.push(`  Reason: ${summary.final_report_contract.blocker}`);
    }
    lines.push(`FinalCloseout: ${summary.final_closeout.status} (${summary.final_closeout.artifact_state})`);
    lines.push(`  JsonArtifact: ${summary.final_closeout.artifact_paths.json}`);
    lines.push(`  MarkdownArtifact: ${summary.final_closeout.artifact_paths.markdown}`);
    if (summary.final_closeout.artifact_paths.final_user_report) {
        lines.push(`  FinalUserReportArtifact: ${summary.final_closeout.artifact_paths.final_user_report}`);
    }
    const reviewIntegrityAttestation = getReviewIntegrityAttestation(summary.final_closeout);
    if (summary.final_closeout.optional_skills?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.optional_skills.visible_summary_line}`);
    }
    if (shouldRenderReviewTrustSummary(summary.final_closeout, reviewIntegrityAttestation) && summary.final_closeout.review_trust?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.review_trust.visible_summary_line}`);
    }
    if (shouldRenderReviewTrustSummary(summary.final_closeout, reviewIntegrityAttestation) && summary.final_closeout.review_trust?.policy_summary_line) {
        lines.push(`  ${summary.final_closeout.review_trust.policy_summary_line}`);
    }
    if (summary.final_closeout.review_attempt_summary?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.review_attempt_summary.visible_summary_line}`);
    }
    appendReviewFindingsAuditLines(lines, summary.final_closeout.review_findings_audit, '  ');
    if (summary.final_closeout.review_coverage_summary) {
        lines.push(`  ${summary.final_closeout.review_coverage_summary.visible_summary_line}`);
    }
    if (summary.final_closeout.review_timing_audit?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.review_timing_audit.visible_summary_line}`);
        for (const entry of summary.final_closeout.review_timing_audit.entries) {
            countNextStepWork('visit:task-audit-summary-renderers:event:589');
            lines.push(
                `    - ${entry.review_type}: reviewer=${entry.reviewer_identity || 'unknown'} ` +
                `provider=${entry.provider || 'unknown'} ` +
                `provider_invocation=${entry.provider_invocation_id || 'unknown'} ` +
                `delegation_started=${entry.delegation_started_at_utc || 'unknown'} ` +
                `launched=${entry.launched_at_utc || 'unknown'} ` +
                `result_recorded=${entry.review_result_recorded_at_utc || 'unknown'} ` +
                `source_mtime=${entry.review_output_source_mtime_utc || 'unknown'} ` +
                `delegation_to_result=${entry.delegation_to_result_ms == null ? 'unknown' : `${entry.delegation_to_result_ms}ms`} ` +
                `delegation_to_source_mtime=${entry.delegation_to_source_mtime_ms == null ? 'unknown' : `${entry.delegation_to_source_mtime_ms}ms`} ` +
                `gate_finalize=${entry.gate_finalize_ms == null ? 'unknown' : `${entry.gate_finalize_ms}ms`} ` +
                `hidden_timing_status=${entry.hidden_timing_status}` +
                `${entry.hidden_timing_distrust_code ? `:${entry.hidden_timing_distrust_code}` : ''}`
            );
        }
    }
    lines.push(`  ${reviewIntegrityAttestation.visible_summary_line}`);
    if (reviewIntegrityAttestation.observed_issues.length > 0) {
        lines.push('  ReviewIntegrityIssues:');
        for (const issue of reviewIntegrityAttestation.observed_issues) {
            lines.push(`    - ${issue}`);
        }
    }
    if (summary.final_closeout.workflow?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.workflow.visible_summary_line}`);
    }
    if (summary.final_closeout.workflow?.full_suite_timeout?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.workflow.full_suite_timeout.visible_summary_line}`);
        const timeoutWarnings = formatFullSuiteTimeoutWarnings(summary.final_closeout);
        if (timeoutWarnings) {
            lines.push(`    Warnings: ${timeoutWarnings}`);
        }
    }
    if (summary.final_closeout.workflow?.review_execution_policy_summary_line) {
        lines.push(`  ${summary.final_closeout.workflow.review_execution_policy_summary_line}`);
    }
    if (
        summary.final_closeout.workflow?.workflow_config_audit
        && summary.final_closeout.workflow.workflow_config_audit.status !== 'none'
    ) {
        lines.push(`  WorkflowConfigAudit: ${summary.final_closeout.workflow.workflow_config_audit.visible_summary_line}`);
    }
    if (summary.final_closeout.project_memory?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.project_memory.visible_summary_line}`);
    }
    if (summary.final_closeout.orchestrator_defect_capture) {
        lines.push(`  ${summary.final_closeout.orchestrator_defect_capture.visible_summary_line}`);
        for (const record of summary.final_closeout.orchestrator_defect_capture.records) {
            countNextStepWork('visit:task-audit-summary-renderers:event:637');
            lines.push(
                `  OrchestratorDefect: id=${record.defect_id || 'unknown'}; status=${record.status}; `
                + `resolution=${record.resolution || 'missing'}; `
                + `problem_record=${record.problem_record_id || 'missing'}; `
                + `follow_up=${record.follow_up_task_id || 'missing'}`
            );
        }
    }
    const knownNonBlockingSignalsLine = formatKnownNonBlockingSignals(summary.final_closeout.known_non_blocking_signals || []);
    if (knownNonBlockingSignalsLine) {
        lines.push(`  ${knownNonBlockingSignalsLine}`);
    }
    if (summary.final_closeout.token_economy?.visible_summary_line) {
        lines.push(`  ${summary.final_closeout.token_economy.visible_summary_line}`);
    }
    if (summary.final_closeout.task_cycle_diagnostics && summary.final_closeout.task_cycle_diagnostics.status !== 'NONE') {
        lines.push(`  ${summary.final_closeout.task_cycle_diagnostics.visible_summary_line}`);
    }
    lines.push(`  ${(summary.final_closeout.task_queue_status_contract || buildTaskQueueStatusContract(summary.task_id)).visible_summary_line}`);
    lines.push('FinalReportOrder:');
    for (const [index, entry] of summary.final_report_contract.required_order.entries()) {
        countNextStepWork('visit:task-audit-summary-renderers:event:658');
        const suffix = entry === 'implementation summary' ? ` (include ${summary.final_report_contract.implementation_summary_requirements.join(', ')})` : '';
        lines.push(`  ${index + 1}. ${entry}${suffix}`);
    }

    return lines.join('\n');
}
