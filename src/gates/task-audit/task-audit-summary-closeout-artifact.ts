import * as path from 'node:path';
import type { TaskCycleStatusSnapshot } from '../../validators/status';
import type { EffectiveReviewExecutionPolicyMode } from '../../core/review-execution-policy';
import { buildReviewExecutionPolicySummaryLine } from '../../core/review-execution-policy';
import {
    buildTaskQueueStatusContract
} from '../../core/task-queue-status-contract';
import type { TaskCycleBindingSnapshot } from '../task-events-summary/task-events-summary';
import { getCurrentNoOpEventSha256, getNoOpEvidence } from '../task-mode/no-op';
import { isFullSuiteNotRequiredForZeroDiffNoReviewableScope } from '../full-suite/full-suite-validation-results';
import { buildDomainScopeFingerprints } from '../scope/domain-scope-fingerprints';
import {
    getWorkspaceSnapshotCached,
    resolveWorkspaceSnapshotRequest,
    type WorkspaceSnapshotRequest
} from '../workspace/workspace-snapshot-cache';
import { toPosix } from '../shared/helpers';
import type { ProjectMemoryImpactLifecycleEvidence } from '../project-memory-impact';
import type {
    FinalCloseoutArtifact,
    FinalCloseoutFullSuiteTimeoutSummary,
    FinalCloseoutProjectMemorySummary,
    FinalCloseoutReviewTimingAuditSummary,
    FinalCloseoutTaskCycleDiagnostics,
    FinalCloseoutWorkflowConfigAuditSummary
} from './task-audit-summary';
import type {
    FinalCloseoutAuditedScopeProvenance,
    FinalCloseoutChangeMetrics,
    FinalCloseoutDocsSummary,
    FinalCloseoutOptionalSkillsSummary,
    FinalCloseoutReviewIntegrityAttestation,
    FinalCloseoutReviewTrustSummary,
    FinalReportContract,
    ReviewAttemptSummary
} from './task-audit-summary-collectors';
import { parseOptionalNumber } from './task-audit-summary-collectors';
import { buildFinalCloseoutProjectMemorySummary } from './task-audit-summary-project-memory';
import type { ReviewCoverageAuditSummary } from './task-audit-summary-review-coverage';
import type { ReviewFindingsAuditSummary } from './task-audit-summary-review-findings';
import type { FinalCloseoutOrchestratorDefectCaptureSummary } from './task-audit-summary-orchestrator-defects';
import {
    collectKnownNonBlockingSignals
} from '../shared/known-nonblocking-signals';
import {
    getAuditedWorkflowConfigChangeProvenance,
    getCurrentWorkflowConfigChanges,
    normalizeWorkflowConfigFileHashes
} from '../workflow-config/workflow-config-work';

export interface BuildFinalCloseoutArtifactInput {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    auditStatus: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    finalReportContract: FinalReportContract;
    finalCloseoutJsonPath: string;
    finalCloseoutMarkdownPath: string;
    finalUserReportPath: string;
    currentCycle: TaskCycleBindingSnapshot | null;
    preflight: Record<string, unknown> | null;
    taskMode: Record<string, unknown> | null;
    pathMode: string | null;
    reviewVerdicts: Record<string, string>;
    docsSummary: FinalCloseoutDocsSummary;
    changedFiles: string[];
    changedFilesCount: number;
    changedLinesTotal: number;
    changeMetrics: FinalCloseoutChangeMetrics;
    scopeCategory: string | null;
    reviewTrustSummary: FinalCloseoutReviewTrustSummary | null;
    reviewTimingAudit: FinalCloseoutReviewTimingAuditSummary | null;
    reviewIntegrityAttestation: FinalCloseoutReviewIntegrityAttestation;
    reviewAttemptSummary: ReviewAttemptSummary | null;
    reviewFindingsAudit: ReviewFindingsAuditSummary | null;
    reviewCoverageSummary: ReviewCoverageAuditSummary | null;
    optionalSkillsSummary: FinalCloseoutOptionalSkillsSummary | null;
    fullSuiteValidation: Record<string, unknown> | null;
    fullSuiteValidationRequiredForLifecycle: boolean;
    reviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode;
    projectMemoryImpactEvidence: ProjectMemoryImpactLifecycleEvidence;
    orchestratorDefectCapture: FinalCloseoutOrchestratorDefectCaptureSummary;
    tokenEconomy: FinalCloseoutArtifact['token_economy'];
    taskCycleDiagnostics: FinalCloseoutTaskCycleDiagnostics;
    workspaceStatusSnapshot: TaskCycleStatusSnapshot;
    commitCommandTemplate: string;
    commitCommandSuggestion: string;
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest;
}

function readTaskModePlannedChangedFiles(taskMode: Record<string, unknown> | null): string[] {
    const plannedChangedFiles = Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files
        : [];
    return [...new Set(plannedChangedFiles
        .map((entry) => toPosix(String(entry || '').trim()))
        .filter(Boolean))]
        .sort((left, right) => left.localeCompare(right));
}

function readTaskModeDirtyWorkspaceBaselineChangedFiles(taskMode: Record<string, unknown> | null): string[] {
    const dirtyWorkspaceBaseline = taskMode?.dirty_workspace_baseline;
    if (!dirtyWorkspaceBaseline || typeof dirtyWorkspaceBaseline !== 'object' || Array.isArray(dirtyWorkspaceBaseline)) {
        return [];
    }
    const changedFiles = (dirtyWorkspaceBaseline as Record<string, unknown>).changed_files;
    if (!Array.isArray(changedFiles)) {
        return [];
    }
    return [...new Set(changedFiles
        .map((entry) => toPosix(String(entry || '').trim()))
        .filter(Boolean))]
        .sort((left, right) => left.localeCompare(right));
}

function buildWorkflowConfigAuditSummary(input: BuildFinalCloseoutArtifactInput): FinalCloseoutWorkflowConfigAuditSummary {
    const workflowConfigBaseline = normalizeWorkflowConfigFileHashes(input.taskMode?.workflow_config_file_hashes);
    const changes = getCurrentWorkflowConfigChanges(input.repoRoot, workflowConfigBaseline, {
        allowProtectedManifestFallback: false,
        workspaceSnapshotRequest: input.workspaceSnapshotRequest
    });
    const provenance = getAuditedWorkflowConfigChangeProvenance({
        repoRoot: input.repoRoot,
        changedFiles: changes.changed_files,
        currentFileHashes: changes.current_file_hashes,
        taskId: input.taskId
    });
    const status = changes.changed_files.length === 0
        ? 'none'
        : provenance.accepted
            ? 'audited'
            : 'unaudited';
    const firstTimestamp = provenance.records[0]?.timestamp_utc || null;
    const sources = [...new Set(provenance.records.map((record) => record.mutation_source))].sort();
    const fields = [...new Set(provenance.records.flatMap((record) => record.changed_fields))].sort();
    return {
        status,
        changed_files: changes.changed_files,
        audited_files: provenance.audited_files,
        unaudited_files: provenance.unaudited_files,
        records: provenance.records.map((record) => ({
            timestamp_utc: record.timestamp_utc,
            mutation_source: record.mutation_source,
            actor: record.actor,
            config_path: record.config_path,
            changed_fields: record.changed_fields,
            active_task_ids: record.active_task_ids,
            active_task_id: record.active_task_id,
            audit_path: record.audit_path
        })),
        visible_summary_line: status === 'none'
            ? 'Workflow-config audit: no in-task workflow-config changes detected.'
            : status === 'audited'
                ? `Workflow-config audit warning: guarded workflow-config changed during this task; source=${sources.join(', ') || 'unknown'}; fields=${fields.join(', ') || 'unknown'}; files=${provenance.audited_files.join(', ')}; first_timestamp=${firstTimestamp || 'unknown'}; gates were refreshed against current config evidence.`
                : `Workflow-config audit warning: unaudited workflow-config drift detected; files=${provenance.unaudited_files.join(', ')}.`
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function normalizeOptionalNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
}

function normalizeOptionalSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}

function readPreflightChangedFiles(preflight: Record<string, unknown> | null): string[] {
    const changedFiles = Array.isArray(preflight?.changed_files)
        ? preflight.changed_files
        : [];
    return [...new Set(changedFiles
        .map((entry) => toPosix(String(entry || '').trim()))
        .filter(Boolean))]
        .sort((left, right) => left.localeCompare(right));
}

function inferUseStaged(detectionSource: string | null, explicitValue: unknown): boolean | null {
    if (typeof explicitValue === 'boolean') {
        return explicitValue;
    }
    if (!detectionSource) {
        return null;
    }
    return detectionSource === 'git_staged_only' || detectionSource === 'git_staged_plus_untracked';
}

function inferIncludeUntracked(detectionSource: string | null, explicitValue: unknown): boolean | null {
    if (typeof explicitValue === 'boolean') {
        return explicitValue;
    }
    if (!detectionSource) {
        return null;
    }
    return detectionSource !== 'git_staged_only';
}

function buildAuditedScopeProvenance(input: {
    repoRoot: string;
    preflight: Record<string, unknown> | null;
    currentCycle: TaskCycleBindingSnapshot | null;
    fallbackChangedFiles: string[];
    fallbackSnapshot: ReturnType<typeof getWorkspaceSnapshotCached> | null;
    closeoutExtraSnapshot: ReturnType<typeof getWorkspaceSnapshotCached> | null;
}): FinalCloseoutAuditedScopeProvenance | null {
    const metrics = readRecord(input.preflight?.metrics);
    const detectionSource = typeof input.preflight?.detection_source === 'string' && input.preflight.detection_source.trim()
        ? input.preflight.detection_source.trim().toLowerCase()
        : input.fallbackSnapshot?.detection_source ?? null;
    const preflightChangedFiles = readPreflightChangedFiles(input.preflight);
    const changedFiles = preflightChangedFiles.length > 0
        ? preflightChangedFiles
        : [...new Set(input.fallbackChangedFiles.map((entry) => toPosix(entry)).filter(Boolean))]
            .sort((left, right) => left.localeCompare(right));
    const changedFilesSha256 = normalizeOptionalSha256(metrics?.changed_files_sha256)
        ?? input.currentCycle?.scope_binding?.changed_files_sha256
        ?? input.fallbackSnapshot?.changed_files_sha256
        ?? null;
    const scopeContentSha256 = normalizeOptionalSha256(metrics?.scope_content_sha256)
        ?? input.currentCycle?.scope_binding?.scope_content_sha256
        ?? input.fallbackSnapshot?.scope_content_sha256
        ?? null;
    const scopeSha256 = normalizeOptionalSha256(metrics?.scope_sha256)
        ?? input.currentCycle?.scope_binding?.scope_sha256
        ?? input.fallbackSnapshot?.scope_sha256
        ?? null;
    if (!detectionSource && changedFiles.length === 0 && !changedFilesSha256 && !scopeContentSha256 && !scopeSha256) {
        return null;
    }
    const domainScopeFingerprints = readRecord(metrics?.domain_scope_fingerprints) as FinalCloseoutAuditedScopeProvenance['domain_scope_fingerprints'];
    return {
        source: metrics ? 'preflight' : 'workspace_snapshot',
        detection_source: detectionSource,
        use_staged: inferUseStaged(detectionSource, input.preflight?.use_staged),
        include_untracked: inferIncludeUntracked(detectionSource, input.preflight?.include_untracked),
        changed_files: changedFiles,
        changed_files_sha256: changedFilesSha256,
        scope_content_sha256: scopeContentSha256,
        scope_sha256: scopeSha256,
        domain_scope_fingerprints: domainScopeFingerprints ?? (
            input.fallbackSnapshot
                ? buildDomainScopeFingerprints({
                    repoRoot: input.repoRoot,
                    detectionSource: input.fallbackSnapshot.detection_source,
                    includeUntracked: !!input.fallbackSnapshot.include_untracked,
                    changedFiles: input.fallbackSnapshot.changed_files
                })
                : null
        ),
        closeout_extra_scope: input.closeoutExtraSnapshot
            ? {
                changed_files: input.closeoutExtraSnapshot.changed_files,
                changed_files_sha256: input.closeoutExtraSnapshot.changed_files_sha256,
                scope_content_sha256: input.closeoutExtraSnapshot.scope_content_sha256,
                scope_sha256: input.closeoutExtraSnapshot.scope_sha256,
                domain_scope_fingerprints: buildDomainScopeFingerprints({
                    repoRoot: input.repoRoot,
                    detectionSource: input.closeoutExtraSnapshot.detection_source,
                    includeUntracked: !!input.closeoutExtraSnapshot.include_untracked,
                    changedFiles: input.closeoutExtraSnapshot.changed_files
                })
            }
            : null,
        compile_gate_scope_binding: input.currentCycle?.scope_binding
            ? {
                changed_files_sha256: input.currentCycle.scope_binding.changed_files_sha256,
                scope_content_sha256: input.currentCycle.scope_binding.scope_content_sha256,
                scope_sha256: input.currentCycle.scope_binding.scope_sha256
            }
            : null
    };
}

function normalizeForecastExcludedReasons(value: unknown): Record<string, number> {
    if (!isRecord(value)) {
        return {};
    }
    const entries: [string, number][] = [];
    for (const [reason, count] of Object.entries(value)) {
        const normalizedCount = normalizeOptionalNumber(count);
        if (normalizedCount != null && normalizedCount > 0) {
            entries.push([reason, normalizedCount]);
        }
    }
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeRepairTaskProposal(value: unknown): FinalCloseoutFullSuiteTimeoutSummary['repair_task_proposal'] {
    if (!isRecord(value)) {
        return null;
    }
    const suggestedTaskId = String(value.suggested_task_id || '').trim();
    const title = String(value.title || '').trim();
    const area = String(value.area || '').trim();
    const rationale = String(value.rationale || '').trim();
    if (!suggestedTaskId || !title || !area || !rationale) {
        return null;
    }
    return {
        suggested_task_id: suggestedTaskId,
        title,
        area,
        rationale
    };
}

function formatForecastExcludedReasons(reasons: Record<string, number>): string {
    const parts = Object.entries(reasons)
        .map(([reason, count]) => `${reason}=${count}`);
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function buildFullSuiteTimeoutSummary(
    artifact: Record<string, unknown> | null
): FinalCloseoutFullSuiteTimeoutSummary | null {
    if (!artifact) {
        return null;
    }
    const timeoutPolicy = isRecord(artifact.timeout_policy) ? artifact.timeout_policy : {};
    const timeoutForecast = isRecord(artifact.timeout_forecast) ? artifact.timeout_forecast : {};
    const attempts = Array.isArray(timeoutPolicy.attempts) ? timeoutPolicy.attempts : [];
    const forecastExcludedSampleReasons = normalizeForecastExcludedReasons(timeoutForecast.excluded_sample_reasons);
    const forecastExcludedSampleCount = normalizeOptionalNumber(timeoutForecast.excluded_sample_count);
    const summary: FinalCloseoutFullSuiteTimeoutSummary = {
        artifact_present: true,
        status: typeof artifact.status === 'string' && artifact.status.trim() ? artifact.status.trim() : null,
        timed_out: normalizeOptionalBoolean(artifact.timed_out),
        timeout_blocker: normalizeOptionalBoolean(timeoutPolicy.timeout_blocker),
        timeout_retry_count: normalizeOptionalNumber(timeoutPolicy.timeout_retry_count),
        max_attempts: normalizeOptionalNumber(timeoutPolicy.max_attempts),
        attempts_count: attempts.length,
        attempts_exhausted: normalizeOptionalBoolean(timeoutPolicy.attempts_exhausted),
        warning_only_continuation: normalizeOptionalBoolean(timeoutPolicy.warning_only_continuation),
        repair_task_proposal: normalizeRepairTaskProposal(timeoutPolicy.repair_task_proposal),
        warnings: normalizeStringArray(artifact.warnings),
        forecast_warning: typeof timeoutForecast.warning === 'string' && timeoutForecast.warning.trim()
            ? timeoutForecast.warning.trim()
            : null,
        forecast_excluded_sample_count: forecastExcludedSampleCount,
        forecast_excluded_sample_reasons: forecastExcludedSampleReasons,
        visible_summary_line: ''
    };
    const attemptsText = summary.max_attempts != null
        ? `${summary.attempts_count}/${summary.max_attempts}`
        : String(summary.attempts_count);
    const warningsCount = summary.warnings.length + (summary.forecast_warning ? 1 : 0);
    summary.visible_summary_line =
        `Full-suite timeout: status=${summary.status || 'unknown'}; timed_out=${summary.timed_out ?? 'unknown'}; ` +
        `blocker=${summary.timeout_blocker ?? 'unknown'}; retry_count=${summary.timeout_retry_count ?? 'unknown'}; ` +
        `attempts=${attemptsText}; exhausted=${summary.attempts_exhausted ?? 'unknown'}; ` +
        `warning_only=${summary.warning_only_continuation ?? 'unknown'}; ` +
        `forecast_excluded=${summary.forecast_excluded_sample_count ?? 0}${formatForecastExcludedReasons(summary.forecast_excluded_sample_reasons)}; ` +
        `warnings=${warningsCount}`;
    return summary;
}

export function buildFinalCloseoutArtifact(input: BuildFinalCloseoutArtifactInput): FinalCloseoutArtifact {
    const authenticatedWorkspaceSnapshotRequest = input.workspaceSnapshotRequest
        ? resolveWorkspaceSnapshotRequest(input.repoRoot, input.workspaceSnapshotRequest)
        : undefined;
    let closeoutScopeSnapshot: ReturnType<typeof getWorkspaceSnapshotCached> | null = null;
    if (input.changedFiles.length > 0) {
        try {
            closeoutScopeSnapshot = authenticatedWorkspaceSnapshotRequest
                ? authenticatedWorkspaceSnapshotRequest.read('explicit_changed_files', true, input.changedFiles)
                : getWorkspaceSnapshotCached(input.repoRoot, 'explicit_changed_files', true, input.changedFiles, {
                    noCache: true,
                    readOnly: true
                });
        } catch {
            closeoutScopeSnapshot = null;
        }
    }
    const plannedChangedFiles = readTaskModePlannedChangedFiles(input.taskMode);
    const dirtyWorkspaceBaselineChangedFiles = readTaskModeDirtyWorkspaceBaselineChangedFiles(input.taskMode);
    const preflightChangedFiles = readPreflightChangedFiles(input.preflight);
    const preflightChangedFileSet = new Set(preflightChangedFiles);
    const closeoutExtraFiles = input.changedFiles
        .map((entry) => toPosix(entry))
        .filter((entry) => entry && !preflightChangedFileSet.has(entry))
        .sort((left, right) => left.localeCompare(right));
    let closeoutExtraSnapshot: ReturnType<typeof getWorkspaceSnapshotCached> | null = null;
    if (closeoutExtraFiles.length > 0) {
        try {
            closeoutExtraSnapshot = authenticatedWorkspaceSnapshotRequest
                ? authenticatedWorkspaceSnapshotRequest.read('explicit_changed_files', true, closeoutExtraFiles)
                : getWorkspaceSnapshotCached(input.repoRoot, 'explicit_changed_files', true, closeoutExtraFiles, {
                    noCache: true,
                    readOnly: true
                });
        } catch {
            closeoutExtraSnapshot = null;
        }
    }
    const auditedScopeProvenance = buildAuditedScopeProvenance({
        repoRoot: input.repoRoot,
        preflight: input.preflight,
        currentCycle: input.currentCycle,
        fallbackChangedFiles: input.changedFiles,
        fallbackSnapshot: closeoutScopeSnapshot,
        closeoutExtraSnapshot
    });
    const stagedAuditedScope = auditedScopeProvenance?.use_staged === true;
    const implementationChangedFilesSha256 = stagedAuditedScope
        ? auditedScopeProvenance.changed_files_sha256
        : closeoutScopeSnapshot?.changed_files_sha256 ?? null;
    const implementationScopeContentSha256 = stagedAuditedScope
        ? auditedScopeProvenance.scope_content_sha256
        : closeoutScopeSnapshot?.scope_content_sha256 ?? null;
    const implementationScopeSha256 = stagedAuditedScope
        ? auditedScopeProvenance.scope_sha256
        : closeoutScopeSnapshot?.scope_sha256 ?? null;
    const implementationDomainScopeFingerprints = stagedAuditedScope
        ? auditedScopeProvenance.domain_scope_fingerprints
        : closeoutScopeSnapshot
            ? buildDomainScopeFingerprints({
                repoRoot: input.repoRoot,
                detectionSource: closeoutScopeSnapshot.detection_source,
                includeUntracked: !!closeoutScopeSnapshot.include_untracked,
                changedFiles: closeoutScopeSnapshot.changed_files
            })
            : null;

    const projectMemory = buildFinalCloseoutProjectMemorySummary(input.projectMemoryImpactEvidence) as FinalCloseoutProjectMemorySummary;
    const knownNonBlockingSignals = collectKnownNonBlockingSignals({
        projectMemory
    });
    const fullSuiteTimeoutSummary = buildFullSuiteTimeoutSummary(input.fullSuiteValidation);
    const workflowConfigAuditSummary = buildWorkflowConfigAuditSummary(input);
    const noOpEvidence = !input.currentCycle
        && input.preflight
        && isFullSuiteNotRequiredForZeroDiffNoReviewableScope(input.preflight)
        ? getNoOpEvidence(
            input.repoRoot,
            input.taskId,
            path.join(path.dirname(input.finalCloseoutJsonPath), `${input.taskId}-no-op.json`),
            path.join(path.dirname(input.finalCloseoutJsonPath), `${input.taskId}-preflight.json`)
        )
        : null;
    const noOpEventSha256 = noOpEvidence
        ? getCurrentNoOpEventSha256(input.repoRoot, input.taskId, noOpEvidence, input.eventsRoot)
        : null;
    const noOpBinding = noOpEvidence?.evidence_status === 'PASS'
        && noOpEvidence.evidence_hash
        && noOpEvidence.preflight_path
        && noOpEvidence.preflight_sha256
        && noOpEventSha256
        ? {
            preflight_path: noOpEvidence.preflight_path,
            preflight_sha256: noOpEvidence.preflight_sha256,
            compile_gate_timestamp: null,
            no_op_sha256: noOpEvidence.evidence_hash,
            no_op_event_sha256: noOpEventSha256
        }
        : null;

    return {
        schema_version: 1,
        event_source: 'task-audit-summary',
        task_id: input.taskId,
        generated_utc: new Date().toISOString(),
        audit_status: input.auditStatus,
        status: input.finalReportContract.status,
        blocker: input.finalReportContract.blocker,
        artifact_state: input.finalReportContract.status === 'READY' ? 'PENDING' : 'NOT_READY',
        cycle_binding: input.currentCycle
            ? {
                preflight_path: input.currentCycle.preflight_path,
                preflight_sha256: input.currentCycle.preflight_sha256,
                compile_gate_timestamp: input.currentCycle.compile_gate_timestamp
            }
            : noOpBinding,
        artifact_paths: {
            json: toPosix(input.finalCloseoutJsonPath),
            markdown: toPosix(input.finalCloseoutMarkdownPath),
            final_user_report: toPosix(input.finalUserReportPath)
        },
        implementation_summary: {
            requested_depth: parseOptionalNumber(input.taskMode?.requested_depth),
            effective_depth: parseOptionalNumber(input.taskMode?.effective_depth),
            path_mode: input.pathMode,
            orchestrator_work: input.taskMode?.orchestrator_work === true,
            workflow_config_work: input.taskMode?.workflow_config_work === true,
            planned_changed_files: plannedChangedFiles,
            task_mode_scope_snapshot: {
                orchestrator_work: input.taskMode?.orchestrator_work === true,
                workflow_config_work: input.taskMode?.workflow_config_work === true,
                planned_changed_files: plannedChangedFiles,
                dirty_workspace_baseline_changed_files: dirtyWorkspaceBaselineChangedFiles,
                authorized_changed_files: [...new Set([
                    ...plannedChangedFiles,
                    ...dirtyWorkspaceBaselineChangedFiles
                ])].sort((left, right) => left.localeCompare(right))
            },
            review_verdicts: input.reviewVerdicts,
            docs_updated: input.docsSummary.decision === 'DOCS_UPDATED',
            changed_files: input.changedFiles,
            changed_files_sha256: implementationChangedFilesSha256,
            scope_content_sha256: implementationScopeContentSha256,
            scope_sha256: implementationScopeSha256,
            domain_scope_fingerprints: implementationDomainScopeFingerprints,
            audited_scope_provenance: auditedScopeProvenance,
            change_metrics: input.changeMetrics,
            changed_files_count: input.changedFilesCount,
            changed_lines_total: input.changedLinesTotal,
            scope_category: input.scopeCategory,
            active_profile: typeof input.taskMode?.active_profile === 'string' && input.taskMode.active_profile.trim()
                ? input.taskMode.active_profile.trim()
                : null
        },
        review_trust: input.reviewTrustSummary,
        review_timing_audit: input.reviewTimingAudit,
        review_integrity_attestation: input.reviewIntegrityAttestation,
        review_attempt_summary: input.reviewAttemptSummary,
        review_findings_audit: input.reviewFindingsAudit,
        review_coverage_summary: input.reviewCoverageSummary,
        optional_skills: input.optionalSkillsSummary,
        workflow: {
            mandatory_full_suite_enabled: input.fullSuiteValidationRequiredForLifecycle,
            visible_summary_line: `Mandatory full-suite: ${input.fullSuiteValidationRequiredForLifecycle ? 'true' : 'false'}`,
            review_execution_policy_mode: input.reviewExecutionPolicyMode,
            review_execution_policy_summary_line: buildReviewExecutionPolicySummaryLine(input.reviewExecutionPolicyMode),
            full_suite_timeout: fullSuiteTimeoutSummary,
            workflow_config_audit: workflowConfigAuditSummary
        },
        docs: input.docsSummary,
        project_memory: projectMemory,
        orchestrator_defect_capture: input.orchestratorDefectCapture,
        known_non_blocking_signals: knownNonBlockingSignals,
        token_economy: input.tokenEconomy,
        task_cycle_diagnostics: input.taskCycleDiagnostics,
        task_queue_status_contract: buildTaskQueueStatusContract(input.taskId),
        agent_report: {
            assistant_language: input.workspaceStatusSnapshot.assistantLanguage,
            assistant_language_confirmed: input.workspaceStatusSnapshot.assistantLanguageConfirmed,
            next_task_command: input.workspaceStatusSnapshot.readyForTasks
                ? input.workspaceStatusSnapshot.recommendedNextCommand
                : null,
            latest_update_notice: input.workspaceStatusSnapshot.latestUpdateNotice
        },
        commit_command_template: input.commitCommandTemplate,
        commit_command_suggestion: input.commitCommandSuggestion,
        commit_question: input.finalReportContract.commit_question
    };
}
