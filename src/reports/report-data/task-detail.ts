import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { buildTaskStats, type TaskStatsResult } from '../../cli/commands/stats';
import { joinOrchestratorPath, toPosix } from '../../gates/shared/helpers';
import {
    buildCompactLatestCycleTaskEventsSummary,
    buildTaskEventsSummary,
    type CompactLatestCycleTaskEventsSummary,
    type TaskEventsSummaryResult
} from '../../gates/task-events-summary';
import { buildTaskAuditSummary, type TaskAuditSummaryResult } from '../../gates/task-audit/task-audit-summary';
import {
    buildFullSuiteTimeoutForecast,
    formatFullSuiteTimeoutForecast,
    isFullSuiteNotRequiredForZeroDiffNoReviewableScope,
    loadFullSuiteValidationConfig,
    type FullSuiteTimeoutAttemptEvidence,
    type FullSuiteTimeoutPolicyEvidence,
    type FullSuiteTimeoutRepairTaskProposal,
    type FullSuiteValidationResult
} from '../../gates/full-suite/full-suite-validation';
import { getTaskModeEvidence, readOptionalMarkdownWorkingPlan } from '../../gates/task-mode';
import {
    getReviewFollowUpTaskClosurePolicySnapshotViolations,
    resolveReviewFollowUpTaskClosurePolicy,
    type ReviewFollowUpTaskClosurePolicySnapshot
} from '../../core/review-follow-up-task-closure-policy';
import { readCanonicalActiveQueueRows } from './task-queue';
import { buildTaskQualityChecklist, withQualityChecklistArtifactLink } from './task-quality-checklist';
import { buildTaskProgress } from './task-progress';
import type {
    BuildReportTaskDetailOptions,
    ReportArtifactLink,
    ReportDataUnavailableEntry,
    ReportFullSuiteFreshness,
    ReportFullSuiteState,
    ReportFullSuiteSummary,
    ReportTaskDetail,
    ReportTaskQueueRow
} from './types';
import { DEFAULT_REPORT_MAX_DETAILED_TASKS } from './types';
import {
    resolveWorkspaceSnapshotRequest,
    type WorkspaceSnapshotRequest
} from '../../gates/workspace/workspace-snapshot-cache';

const TERMINAL_TASK_STATUS_TOKENS = new Set(['DONE']);

function readLatestCycleEvents(
    taskId: string,
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    unavailable: ReportDataUnavailableEntry[]
): CompactLatestCycleTaskEventsSummary | null {
    try {
        const summary = buildTaskEventsSummary({
            taskId,
            eventsRoot,
            repoRoot,
            reviewsRoot
        }) as TaskEventsSummaryResult;
        return buildCompactLatestCycleTaskEventsSummary(summary);
    } catch (error: unknown) {
        unavailable.push({
            scope: `task:${taskId}:events`,
            reason: error instanceof Error ? error.message : String(error)
        });
        return null;
    }
}

function readTaskAuditSummary(
    taskId: string,
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    unavailable: ReportDataUnavailableEntry[],
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest
): TaskAuditSummaryResult | null {
    try {
        return buildTaskAuditSummary({
            taskId,
            repoRoot,
            eventsRoot,
            reviewsRoot,
            workspaceSnapshotRequest
        });
    } catch (error: unknown) {
        unavailable.push({
            scope: `task:${taskId}:audit`,
            reason: error instanceof Error ? error.message : String(error)
        });
        return null;
    }
}

function summarizeTaskAudit(audit: TaskAuditSummaryResult): ReportTaskDetail['audit'] {
    return {
        status: audit.status,
        gates: audit.gates,
        blockers: audit.blockers,
        required_reviews: audit.required_reviews,
        changed_files: audit.changed_files,
        review_attempt_summary: audit.review_attempt_summary,
        review_findings_audit: audit.review_findings_audit,
        final_report_contract_status: audit.final_report_contract.status,
        final_closeout_artifact_state: audit.final_closeout.artifact_state
    };
}

function fileSha256(filePath: string): string | null {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return null;
        }
        return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
        return null;
    }
}

function safeReadJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return null;
        }
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function normalizeStatus(value: unknown): FullSuiteValidationResult['status'] | null {
    const normalized = String(value || '').trim().toUpperCase();
    if (normalized === 'PASSED' || normalized === 'FAILED' || normalized === 'WARNED' || normalized === 'SKIPPED') {
        return normalized;
    }
    return null;
}

function normalizeDurationMs(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.round(value)
        : null;
}

function normalizeTimeoutRetryCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : 0;
}

function normalizeTimeoutAttempts(value: unknown): FullSuiteTimeoutAttemptEvidence[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const attempts: FullSuiteTimeoutAttemptEvidence[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            continue;
        }
        const record = entry as Record<string, unknown>;
        const attempt = typeof record.attempt === 'number' && Number.isFinite(record.attempt)
            ? Math.floor(record.attempt)
            : null;
        if (attempt == null || attempt <= 0) {
            continue;
        }
        attempts.push({
            attempt,
            exit_code: typeof record.exit_code === 'number' && Number.isFinite(record.exit_code)
                ? Math.trunc(record.exit_code)
                : null,
            timed_out: record.timed_out === true,
            ...(typeof record.cancelled === 'boolean' ? { cancelled: record.cancelled } : {})
        });
    }
    return attempts;
}

function normalizeTimeoutRepairTaskProposal(value: unknown): FullSuiteTimeoutRepairTaskProposal | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const suggestedTaskId = String(record.suggested_task_id || '').trim();
    const title = String(record.title || '').trim();
    const area = String(record.area || '').trim();
    const rationale = String(record.rationale || '').trim();
    return suggestedTaskId && title && area && rationale
        ? {
            suggested_task_id: suggestedTaskId,
            title,
            area,
            rationale
        }
        : null;
}

function normalizeTimeoutPolicy(
    value: unknown,
    config: ReturnType<typeof loadFullSuiteValidationConfig>
): FullSuiteTimeoutPolicyEvidence {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        const retryCount = normalizeTimeoutRetryCount(config.timeout_retry_count);
        return {
            timeout_blocker: config.timeout_blocker !== false,
            timeout_retry_count: retryCount,
            max_attempts: retryCount + 1,
            attempts: [],
            attempts_exhausted: false,
            warning_only_continuation: false,
            repair_task_proposal: null
        };
    }
    const record = value as Record<string, unknown>;
    const retryCount = normalizeTimeoutRetryCount(record.timeout_retry_count);
    const maxAttempts = typeof record.max_attempts === 'number' && Number.isFinite(record.max_attempts) && record.max_attempts > 0
        ? Math.floor(record.max_attempts)
        : retryCount + 1;
    return {
        timeout_blocker: record.timeout_blocker !== false,
        timeout_retry_count: retryCount,
        max_attempts: maxAttempts,
        attempts: normalizeTimeoutAttempts(record.attempts),
        attempts_exhausted: record.attempts_exhausted === true,
        warning_only_continuation: record.warning_only_continuation === true,
        repair_task_proposal: normalizeTimeoutRepairTaskProposal(record.repair_task_proposal)
    };
}

function formatDurationMs(durationMs: number | null): string | null {
    if (durationMs == null) {
        return null;
    }
    if (durationMs < 1000) {
        return `${durationMs} ms`;
    }
    const secondsText = (seconds: number): string => seconds.toFixed(1).replace(/\.0$/, '');
    const totalSeconds = durationMs / 1000;
    if (totalSeconds < 60) {
        return `${secondsText(totalSeconds)}s`;
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds - totalMinutes * 60;
    if (totalMinutes < 60) {
        return `${totalMinutes}m ${secondsText(remainingSeconds)}s`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m ${secondsText(remainingSeconds)}s`;
}

function readLatestCompileGateTimestamp(eventsRoot: string, taskId: string): string | null {
    const eventFile = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fs.existsSync(eventFile) || !fs.statSync(eventFile).isFile()) {
        return null;
    }
    let latest: string | null = null;
    const lines = fs.readFileSync(eventFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.event_type === 'COMPILE_GATE_PASSED') {
                latest = String(event.timestamp_utc || '').trim() || latest;
            }
        } catch {
            // Ignore malformed event lines; the timeline summary reports them separately.
        }
    }
    return latest;
}

function normalizePathText(value: unknown): string | null {
    const text = String(value || '').trim();
    return text ? toPosix(text) : null;
}

function summarizeFullSuiteFreshness(options: {
    required: boolean;
    artifactExists: boolean;
    preflightPath: string;
    preflightSha256: string | null;
    latestCompileGateTimestamp: string | null;
    cycleBinding: Record<string, unknown> | null;
}): { freshness: ReportFullSuiteFreshness; mismatchReason: string | null } {
    if (!options.required) {
        return { freshness: 'not_required', mismatchReason: null };
    }
    if (!options.artifactExists) {
        return { freshness: 'missing', mismatchReason: 'Full-suite validation evidence artifact is missing.' };
    }
    if (!options.cycleBinding) {
        return { freshness: 'stale', mismatchReason: 'Full-suite validation artifact is missing cycle_binding.' };
    }
    const preflightPathMatches = normalizePathText(options.cycleBinding.preflight_path) === toPosix(options.preflightPath);
    const preflightShaMatches = !!options.preflightSha256
        && String(options.cycleBinding.preflight_sha256 || '').trim().toLowerCase() === options.preflightSha256;
    const compileTimestamp = options.cycleBinding.compile_gate_timestamp == null
        ? null
        : String(options.cycleBinding.compile_gate_timestamp || '').trim() || null;
    const compileMatches = !!options.latestCompileGateTimestamp
        && compileTimestamp === options.latestCompileGateTimestamp;
    if (preflightPathMatches && preflightShaMatches && compileMatches) {
        return { freshness: 'current', mismatchReason: null };
    }
    if (preflightPathMatches && preflightShaMatches && options.cycleBinding.scope_binding) {
        return {
            freshness: 'reused_current_scope',
            mismatchReason: 'Full-suite validation artifact is reused for the current preflight scope.'
        };
    }
    const mismatches: string[] = [];
    if (!preflightPathMatches || !preflightShaMatches) {
        mismatches.push('preflight artifact');
    }
    if (!compileMatches) {
        mismatches.push('compile gate cycle');
    }
    return {
        freshness: 'stale',
        mismatchReason: `Full-suite validation cycle binding does not match the current ${mismatches.join(', ')}.`
    };
}

function resolveFullSuiteState(options: {
    required: boolean;
    artifactExists: boolean;
    freshness: ReportFullSuiteFreshness;
    status: FullSuiteValidationResult['status'] | null;
    timedOut: boolean | null;
}): ReportFullSuiteState {
    if (!options.required) {
        return 'not_required';
    }
    if (!options.artifactExists) {
        return 'not_run';
    }
    if (options.freshness === 'stale') {
        return 'stale';
    }
    if (options.timedOut === true) {
        return 'timed_out';
    }
    if (options.status === 'PASSED') {
        return 'passed';
    }
    if (options.status === 'WARNED') {
        return 'warned';
    }
    if (options.status === 'FAILED') {
        return 'failed';
    }
    if (options.status === 'SKIPPED') {
        return 'skipped';
    }
    return 'unavailable';
}

function buildFullSuiteSummary(
    taskId: string,
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string
): ReportFullSuiteSummary {
    const config = loadFullSuiteValidationConfig(repoRoot);
    const timeoutForecast = buildFullSuiteTimeoutForecast(repoRoot, config);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const preflight = safeReadJsonRecord(preflightPath);
    const fullSuiteRequired = config.enabled && !(preflight && isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflight));
    const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
    const artifactExists = fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile();
    const artifact = artifactExists ? safeReadJsonRecord(artifactPath) : null;
    const status = normalizeStatus(artifact?.status);
    const durationMs = normalizeDurationMs(artifact?.duration_ms);
    const timedOut = typeof artifact?.timed_out === 'boolean' ? artifact.timed_out : null;
    const timeoutPolicy = normalizeTimeoutPolicy(artifact?.timeout_policy, config);
    const cycleBinding = artifact && artifact.cycle_binding && typeof artifact.cycle_binding === 'object' && !Array.isArray(artifact.cycle_binding)
        ? artifact.cycle_binding as Record<string, unknown>
        : null;
    const freshness = summarizeFullSuiteFreshness({
        required: fullSuiteRequired,
        artifactExists,
        preflightPath,
        preflightSha256: fileSha256(preflightPath),
        latestCompileGateTimestamp: readLatestCompileGateTimestamp(eventsRoot, taskId),
        cycleBinding
    });
    const stat = artifactExists ? fs.statSync(artifactPath) : null;
    return {
        state: resolveFullSuiteState({
            required: fullSuiteRequired,
            artifactExists,
            freshness: freshness.freshness,
            status,
            timedOut
        }),
        freshness: freshness.freshness,
        enabled: config.enabled,
        required: fullSuiteRequired,
        status,
        command: typeof artifact?.command === 'string' && artifact.command.trim() ? artifact.command : config.command,
        placement: config.placement,
        duration_ms: durationMs,
        duration_human: formatDurationMs(durationMs),
        timed_out: timedOut,
        exit_code: typeof artifact?.exit_code === 'number' && Number.isFinite(artifact.exit_code) ? artifact.exit_code : null,
        timeout_blocker: timeoutPolicy.timeout_blocker,
        timeout_retry_count: timeoutPolicy.timeout_retry_count,
        timeout_max_attempts: timeoutPolicy.max_attempts,
        timeout_attempts: timeoutPolicy.attempts,
        timeout_attempts_exhausted: artifact?.timeout_policy ? timeoutPolicy.attempts_exhausted : null,
        timeout_warning_only_continuation: artifact?.timeout_policy ? timeoutPolicy.warning_only_continuation : null,
        timeout_repair_task_proposal: timeoutPolicy.repair_task_proposal,
        artifact_path: toPosix(artifactPath),
        artifact_exists: artifactExists,
        artifact_sha256: fileSha256(artifactPath),
        output_artifact_path: normalizePathText(artifact?.output_artifact_path),
        updated_at_utc: stat ? stat.mtime.toISOString() : null,
        compact_summary: toStringArray(artifact?.compact_summary),
        violations: toStringArray(artifact?.violations),
        warnings: toStringArray(artifact?.warnings),
        skip_reason: typeof artifact?.skip_reason === 'string' && artifact.skip_reason.trim() ? artifact.skip_reason : null,
        mismatch_reason: freshness.mismatchReason,
        timeout_forecast: timeoutForecast,
        timeout_forecast_label: formatFullSuiteTimeoutForecast(timeoutForecast)
    };
}

function buildArtifactLinksFromAudit(audit: TaskAuditSummaryResult | null): ReportArtifactLink[] {
    if (!audit) {
        return [];
    }
    return audit.evidence.map((artifact) => ({
        kind: artifact.kind,
        path: toPosix(artifact.path),
        exists: artifact.exists,
        sha256: artifact.sha256
    }));
}

function readPlanMarkdown(repoRoot: string, planPath: string | null): string | null {
    if (!planPath) {
        return null;
    }
    const resolvedPath = path.resolve(repoRoot, planPath);
    if (!resolvedPath.startsWith(path.resolve(repoRoot) + path.sep) && resolvedPath !== path.resolve(repoRoot)) {
        return null;
    }
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return null;
    }
    return fs.readFileSync(resolvedPath, 'utf8');
}

function buildTaskPlanDetail(
    repoRoot: string,
    taskId: string,
    taskRow: ReportTaskQueueRow | null,
    evidence: ReturnType<typeof getTaskModeEvidence>
): ReportTaskDetail['plan'] {
    const fallbackMarkdownPlan = readOptionalMarkdownWorkingPlan(repoRoot, taskId);
    const markdownPath = evidence.markdown_working_plan?.working_plan_path || fallbackMarkdownPlan?.working_plan_path || null;
    const planPath = evidence.plan?.plan_path || null;
    const markdown = readPlanMarkdown(repoRoot, markdownPath);
    return {
        available: Boolean(markdown || evidence.plan || evidence.markdown_working_plan),
        task_id: taskId,
        task_title: taskRow?.title || evidence.task_summary || null,
        task_status: taskRow?.status_token || taskRow?.status || null,
        summary: evidence.plan?.plan_summary || evidence.task_summary || null,
        plan_path: planPath,
        markdown_path: markdownPath,
        markdown
    };
}

function readFrozenTaskClosurePolicy(
    taskModeEvidence: ReturnType<typeof getTaskModeEvidence>
): ReviewFollowUpTaskClosurePolicySnapshot | null {
    if (
        taskModeEvidence.evidence_status !== 'PASS'
        || taskModeEvidence.profile_policy_snapshot_status !== 'PASS'
    ) {
        return null;
    }
    const profilePolicySnapshot = taskModeEvidence.profile_policy_snapshot;
    if (!profilePolicySnapshot || typeof profilePolicySnapshot !== 'object' || Array.isArray(profilePolicySnapshot)) {
        return null;
    }
    const candidate = profilePolicySnapshot.review_follow_up_task_closure_policy;
    if (getReviewFollowUpTaskClosurePolicySnapshotViolations(candidate).length > 0) {
        return null;
    }
    const policy = candidate as ReviewFollowUpTaskClosurePolicySnapshot;
    return {
        ...policy,
        diagnostics: [...policy.diagnostics]
    };
}

function buildTaskClosurePolicyDetail(
    taskRow: ReportTaskQueueRow | null,
    taskRows: readonly ReportTaskQueueRow[],
    taskModeEvidence: ReturnType<typeof getTaskModeEvidence>
): ReportTaskDetail['review_follow_up_task_closure_policy'] {
    const stored = resolveReviewFollowUpTaskClosurePolicy(
        taskRow?.notes,
        taskRow
            ? {
                taskId: taskRow.task_id,
                taskRows: taskRows.map((candidate) => ({
                    taskId: candidate.task_id,
                    notes: candidate.notes || null
                }))
            }
            : undefined
    );
    const frozen = readFrozenTaskClosurePolicy(taskModeEvidence);
    const effective = frozen || stored;
    const driftDetected = Boolean(
        frozen
        && (
            frozen.eligible !== stored.eligible
            || frozen.configured !== stored.configured
            || frozen.valid !== stored.valid
            || frozen.provenance !== stored.provenance
            || frozen.skip_low_findings !== stored.skip_low_findings
            || frozen.forbid_child_tasks !== stored.forbid_child_tasks
        )
    );
    const completed = taskRow?.status_token === 'DONE';
    const state: ReportTaskDetail['review_follow_up_task_closure_policy']['state'] = !stored.eligible
        ? 'inapplicable'
        : !stored.valid
            ? 'invalid'
            : completed
                ? 'completed'
                : driftDetected
                    ? 'pending_next_cycle'
                    : 'editable';
    const editable = stored.eligible && stored.valid && !completed;
    const editableReason = editable
        ? null
        : completed
            ? 'Completed tasks cannot be changed retroactively.'
            : stored.diagnostics.join(' ') || 'Closure policy metadata is unavailable.';
    const diagnostics = [...new Set([
        ...stored.diagnostics,
        ...(frozen?.diagnostics || []),
        ...(driftDetected
            ? ['Stored task metadata differs from the frozen current-cycle policy; the persisted values apply on the next task-mode entry.']
            : [])
    ])];
    return {
        stored,
        effective,
        effective_source: frozen ? 'task_mode_profile_policy_snapshot' : 'task_metadata',
        state,
        editable,
        editable_reason: editableReason,
        metadata_path: TASK_QUEUE_FILENAME,
        drift_detected: driftDetected,
        diagnostics
    };
}

export function buildReportTaskDetail(options: BuildReportTaskDetailOptions): ReportTaskDetail {
    const repoRoot = path.resolve(options.repoRoot);
    const workspaceSnapshotRequest = resolveWorkspaceSnapshotRequest(
        repoRoot,
        options.workspaceSnapshotRequest
    );
    const eventsRoot = options.eventsRoot
        ? path.resolve(options.eventsRoot)
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const reviewsRoot = options.reviewsRoot
        ? path.resolve(options.reviewsRoot)
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const taskId = options.taskId;
    const unavailable: ReportDataUnavailableEntry[] = [];
    const queueState = readCanonicalActiveQueueRows(repoRoot);
    const queueRow = queueState.rows.find((row) => row.task_id === taskId) || null;
    const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId);
    let stats: TaskStatsResult | null = null;
    try {
        stats = buildTaskStats(taskId, repoRoot, eventsRoot, reviewsRoot, {
            includeReviewAttemptSummary: true
        });
    } catch (error: unknown) {
        unavailable.push({
            scope: `task:${taskId}:stats`,
            reason: error instanceof Error ? error.message : String(error)
        });
    }
    const audit = readTaskAuditSummary(
        taskId,
        repoRoot,
        eventsRoot,
        reviewsRoot,
        unavailable,
        workspaceSnapshotRequest
    );
    const qualityChecklist = buildTaskQualityChecklist(
        taskId,
        repoRoot,
        eventsRoot,
        reviewsRoot,
        workspaceSnapshotRequest
    );

    return {
        task_id: taskId,
        detail_status: 'loaded',
        progress: buildTaskProgress({ repoRoot, taskId, eventsRoot, reviewsRoot, taskKnown: !!queueRow, audit }),
        stats,
        latest_cycle_events: readLatestCycleEvents(taskId, repoRoot, eventsRoot, reviewsRoot, unavailable),
        full_suite_validation: buildFullSuiteSummary(taskId, repoRoot, eventsRoot, reviewsRoot),
        review_follow_up_task_closure_policy: buildTaskClosurePolicyDetail(
            queueRow,
            queueState.rows,
            taskModeEvidence
        ),
        audit: audit ? summarizeTaskAudit(audit) : null,
        plan: buildTaskPlanDetail(repoRoot, taskId, queueRow, taskModeEvidence),
        artifact_links: withQualityChecklistArtifactLink(buildArtifactLinksFromAudit(audit), taskId, reviewsRoot),
        quality_checklist: qualityChecklist,
        unavailable
    };
}

export function isLazyReportDetailEntry(entry: ReportDataUnavailableEntry): boolean {
    return /^task:[^:]+:detail$/u.test(entry.scope)
        && (
            entry.reason.includes('Deep task details are lazy')
            || entry.reason.includes('detail collection is limited')
        );
}

export function buildSkippedTaskDetail(taskId: string, maxDetailedTasks: number): ReportTaskDetail {
    const detailLimitReason = maxDetailedTasks === 0
        ? 'Deep task details are lazy for static reports and are not collected by default'
        : `Initial report detail collection is limited to ${maxDetailedTasks} task(s)`;
    return {
        task_id: taskId,
        detail_status: 'skipped',
        progress: null,
        stats: null,
        latest_cycle_events: null,
        full_suite_validation: {
            state: 'not_required',
            freshness: 'not_required',
            enabled: false,
            required: false,
            status: null,
            command: '',
            placement: 'after_compile_before_reviews',
            duration_ms: null,
            duration_human: null,
            timed_out: null,
            exit_code: null,
            timeout_blocker: false,
            timeout_retry_count: 0,
            timeout_max_attempts: 1,
            timeout_attempts: [],
            timeout_attempts_exhausted: null,
            timeout_warning_only_continuation: null,
            timeout_repair_task_proposal: null,
            artifact_path: '',
            artifact_exists: false,
            artifact_sha256: null,
            output_artifact_path: null,
            updated_at_utc: null,
            compact_summary: [],
            violations: [],
            warnings: [],
            skip_reason: null,
            mismatch_reason: null,
            timeout_forecast: {
                history_path: '',
                sample_count: 0,
                excluded_sample_count: 0,
                excluded_sample_reasons: {},
                average_duration_seconds: null,
                high_watermark_duration_seconds: null,
                recommended_timeout_seconds: 0,
                safety_margin_seconds: null,
                recommendation_source: 'config_timeout',
                configured_timeout_seconds: 0,
                warning: null
            },
            timeout_forecast_label: ''
        },
        review_follow_up_task_closure_policy: {
            stored: resolveReviewFollowUpTaskClosurePolicy(undefined),
            effective: resolveReviewFollowUpTaskClosurePolicy(undefined),
            effective_source: 'task_metadata',
            state: 'inapplicable',
            editable: false,
            editable_reason: 'Task details must be loaded before closure policy controls are available.',
            metadata_path: TASK_QUEUE_FILENAME,
            drift_detected: false,
            diagnostics: ['Task details must be loaded before closure policy controls are available.']
        },
        audit: null,
        plan: {
            available: false,
            task_id: taskId,
            task_title: null,
            task_status: null,
            summary: null,
            plan_path: null,
            markdown_path: null,
            markdown: null
        },
        artifact_links: [],
        quality_checklist: {
            latest: null,
            action_required_history: []
        },
        unavailable: [{
            scope: `task:${taskId}:detail`,
            reason: `${detailLimitReason} to keep garda html responsive; use --max-detailed-tasks N for a heavier snapshot or garda task "${taskId}" stats/events for focused inspection.`
        }]
    };
}

export function normalizeMaxDetailedTasks(value: number | null | undefined): number {
    if (value === null || value === undefined) {
        return DEFAULT_REPORT_MAX_DETAILED_TASKS;
    }
    if (!Number.isInteger(value) || value < 0) {
        throw new Error('maxDetailedTasks must be a non-negative integer.');
    }
    return value;
}

export function selectDetailedTaskIds(rows: ReportTaskQueueRow[], maxDetailedTasks: number): Set<string> {
    const selected = new Set<string>();
    if (maxDetailedTasks < 1) {
        return selected;
    }
    const addIfRoom = (row: ReportTaskQueueRow): void => {
        if (selected.size < maxDetailedTasks) {
            selected.add(row.task_id);
        }
    };
    for (const row of rows) {
        if (!TERMINAL_TASK_STATUS_TOKENS.has(row.status_token || '')) {
            addIfRoom(row);
        }
    }
    for (const row of rows) {
        addIfRoom(row);
    }
    return selected;
}
