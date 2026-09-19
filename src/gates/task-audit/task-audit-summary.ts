import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    assertValidTaskId,
    inspectTaskEventFile,
    withTaskTimelineReadSnapshot
} from '../../gate-runtime/task-events';
import { withReviewArtifactReadBarrier } from '../../gate-runtime/review-artifacts';
import { withTaskIndexReadSnapshot } from '../../gate-runtime/reviews-index';
import {
    inspectCompletionGateFinalizationLock,
    type FinalizationLockInspection
} from '../locks/finalization-lock';
import { isPathRealpathInsideRoot, toPosix } from '../shared/helpers';
import {
    buildTokenEconomySummary,
    resolveTaskCycleBindingSnapshot
} from '../task-events-summary/task-events-summary';
import { readOptionalSkillSelectionTimelineEvidence } from '../../runtime/optional-skill-selection';
import {
    isFullSuiteNotRequiredForZeroDiffNoReviewableScope,
    loadFullSuiteValidationConfig,
    resolveWorkflowConfigPath
} from '../full-suite/full-suite-validation';
import {
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    getProjectMemoryImpactLifecycleEvidence
} from '../project-memory-impact';
import {
    loadReviewExecutionPolicyConfig,
    resolveReviewExecutionPolicyModeFromPreflight
} from '../../core/review-execution-policy';
import { resolveCompiledReviewDependencyGraphFromPreflight } from '../../core/review-dependency-graph';
import { normalizeReviewCycleGuardConfig } from '../../core/review-cycle-guard';
import { getTaskCycleStatusSnapshot, type TaskCycleStatusSnapshot } from '../../validators';
import {
    buildUnavailableRequiredReviewTrustSummary,
    type EvidenceArtifact,
    type FinalCloseoutChangeMetrics,
    type FinalReportContract,
    buildReviewIntegrityAttestation,
    collectReviewAuthorshipAttestationIssues,
    readDocImpactSummary,
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate,
    buildReviewAttemptSummary,
    readOptionalSkillsSummary,
    readReviewVerdicts,
    readTaskQueueMetadata,
    resolveEventsRoot,
    resolveReviewsRoot,
    safeReadJson
} from './task-audit-summary-collectors';
import { buildCommitCommandSuggestion } from './task-audit-summary-commit-suggestion';
import {
    buildCompletionReviewOrderBlocker,
    buildLifecycleGateOutcomes,
    getLifecycleGates,
    hasCurrentCycleReviewProgress,
    hasCurrentCycleProjectMemoryImpactEvent,
    readOrderedTaskEvents,
    resolveFullSuiteValidationRequirementForCurrentCycle
} from './task-audit-summary-lifecycle';
import {
    buildAuditedChangedFiles,
    buildPostDoneWorkspaceDriftBlocker,
    isLocalControlPlaneCommitPath,
    resolveCommittableChangedFiles
} from './task-audit-summary-drift';
import {
    resolveWorkspaceSnapshotRequest,
    type WorkspaceSnapshotRequest
} from '../workspace/workspace-snapshot-cache';
import { getTaskOwnedPreflightScopeFromPreflight } from '../workspace/dirty-worktree-protection';
import {
    collectEvidenceArtifacts,
    collectRequiredReviewBlockers
} from './task-audit-summary-review-evidence';
import { buildFinalCloseoutArtifact } from './task-audit-summary-closeout-artifact';
import {
    readPreflightSummary,
    readProfileReviewDecisions
} from './task-audit-summary-preflight-collection';
import {
    buildReviewTimingAuditSummary,
    readReviewExecutionPolicyModeFromCurrentCycleTimeline
} from './task-audit-summary-review-timing-audit';
import { buildReviewCoverageAuditSummary } from './task-audit-summary-review-coverage';
import { buildReviewFindingsAuditSummary } from './task-audit-summary-review-findings';
import {
    buildOrchestratorDefectCaptureSummary
} from './task-audit-summary-orchestrator-defects';
import type {
    FinalCloseoutTaskCycleDiagnostics,
    PointInTimeSnapshot,
    TaskAuditSummaryOptions,
    TaskAuditSummaryResult
} from './task-audit-summary-types';
export { formatFinalCloseoutMarkdown, formatTaskAuditSummaryText } from './task-audit-summary-renderers';
export { formatFinalUserReport } from './task-audit-summary-final-report';
export { synchronizeFinalCloseoutArtifacts } from './task-audit-summary-closeout-sync';
export type {
    FinalCloseoutArtifact,
    FinalCloseoutFullSuiteTimeoutSummary,
    FinalCloseoutProjectMemorySummary,
    FinalCloseoutReviewTimingAuditEntry,
    FinalCloseoutReviewTimingAuditSummary,
    FinalCloseoutTaskCycleDiagnostics,
    FinalCloseoutWorkflowConfigAuditSummary,
    PointInTimeSnapshot,
    TaskAuditSummaryOptions,
    TaskAuditSummaryResult
} from './task-audit-summary-types';
export type {
    FinalCloseoutOrchestratorDefectCaptureSummary,
    OrchestratorDefectCaptureRecord
} from './task-audit-summary-orchestrator-defects';
export type {
    ReviewFindingsAuditItem,
    ReviewFindingsAuditLane,
    ReviewFindingsAuditSummary,
    ReviewFindingsRemediationCycleAudit,
    ReviewFindingsValidationFailureAudit
} from './task-audit-summary-review-findings';

const NO_COMMIT_REQUIRED_MESSAGE = 'No commit required: no committable changes are present.';
const NO_COMMIT_CONFIRMATION_MESSAGE = 'No commit confirmation required.';

function filterCommitCandidatesToTaskOwnedPreflightScope(
    repoRoot: string,
    preflight: Record<string, unknown> | null,
    candidateFiles: readonly string[]
): string[] {
    if (!preflight) {
        return [...candidateFiles];
    }
    const taskScope = getTaskOwnedPreflightScopeFromPreflight(repoRoot, preflight);
    if (
        taskScope.task_owned_files.length === 0
        && taskScope.excluded_untouched_baseline_files.length === 0
    ) {
        return [...candidateFiles];
    }
    const taskScopeSet = new Set(taskScope.changed_files);
    return candidateFiles.filter((changedFile) => taskScopeSet.has(toPosix(changedFile)));
}

function readReviewCycleExcludedReviewTypes(repoRoot: string): string[] {
    const configPath = resolveWorkflowConfigPath(repoRoot);
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        return normalizeReviewCycleGuardConfig(undefined).excluded_review_types;
    }
    let rawConfig: unknown;
    try {
        rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        return normalizeReviewCycleGuardConfig(undefined).excluded_review_types;
    }
    const config = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
        ? rawConfig as Record<string, unknown>
        : {};
    return normalizeReviewCycleGuardConfig(config.review_cycle_guard).excluded_review_types;
}

function buildTaskCycleDiagnostics(options: {
    taskId: string;
    workspaceStatusSnapshot: TaskCycleStatusSnapshot;
}): FinalCloseoutTaskCycleDiagnostics {
    const warningDetails = options.workspaceStatusSnapshot.timelineWarningDetails || [];
    const matchingDetails = warningDetails.filter((detail) => detail.task_id === options.taskId);
    const preferred = matchingDetails.find((detail) => detail.kind === 'INCOMPLETE') ?? matchingDetails[0] ?? null;
    const workspaceReady = options.workspaceStatusSnapshot.readyForTasks === true;

    if (!preferred) {
        return {
            status: 'NONE',
            task_status: null,
            timeline_warning_kind: null,
            missing_lifecycle_events: [],
            message: null,
            repair_guidance: null,
            timeline_path: null,
            workspace_ready_for_tasks: workspaceReady,
            visible_summary_line: `Task-cycle diagnostics: none; workspace_ready=${workspaceReady}`
        };
    }

    const status = preferred.kind === 'INCOMPLETE' ? 'PARTIAL' : 'DIAGNOSTIC';
    const taskStatus = preferred.task_status || null;
    return {
        status,
        task_status: taskStatus,
        timeline_warning_kind: preferred.kind,
        missing_lifecycle_events: preferred.kind === 'INCOMPLETE' ? preferred.details.slice() : [],
        message: preferred.message,
        repair_guidance: preferred.repair_guidance,
        timeline_path: preferred.timeline_path,
        workspace_ready_for_tasks: workspaceReady,
        visible_summary_line:
            `Task-cycle diagnostic: status=${status}; task_status=${taskStatus || 'unknown'}; ` +
            `timeline=${preferred.kind}; workspace_ready=${workspaceReady}; action=${preferred.repair_guidance}`
    };
}

function buildFinalCloseoutChangeMetrics(options: {
    repoRoot: string;
    preflightChangedFiles: string[];
    preflightChangedLinesTotal: number;
    finalTrackedChangedFiles: string[];
    workspaceSnapshotRequest: WorkspaceSnapshotRequest;
}): FinalCloseoutChangeMetrics {
    const preflightFileSet = new Set(options.preflightChangedFiles.map((entry) => toPosix(entry)).filter(Boolean));
    const lateEvidenceFiles = [...new Set(options.finalTrackedChangedFiles
        .map((entry) => toPosix(entry))
        .filter((entry) => entry && !preflightFileSet.has(entry)))]
        .sort((left, right) => left.localeCompare(right));
    let finalTrackedChangedLinesTotal: number | null = null;
    let finalTrackedChangedLinesSource: FinalCloseoutChangeMetrics['final_tracked_changed_lines_source'] = 'unavailable';
    if (options.finalTrackedChangedFiles.length === 0) {
        finalTrackedChangedLinesTotal = 0;
        finalTrackedChangedLinesSource = 'workspace_snapshot';
    } else {
        try {
            const finalSnapshot = options.workspaceSnapshotRequest.read(
                'explicit_changed_files',
                true,
                options.finalTrackedChangedFiles
            );
            const lineTotal = Number(finalSnapshot.changed_lines_total);
            if (Number.isFinite(lineTotal)) {
                finalTrackedChangedLinesTotal = lineTotal;
                finalTrackedChangedLinesSource = 'workspace_snapshot';
            }
        } catch {
            finalTrackedChangedLinesTotal = null;
            finalTrackedChangedLinesSource = 'unavailable';
        }
    }
    return {
        preflight_changed_files_count: options.preflightChangedFiles.length,
        preflight_changed_lines_total: options.preflightChangedLinesTotal,
        final_tracked_changed_files_count: options.finalTrackedChangedFiles.length,
        final_tracked_changed_lines_total: finalTrackedChangedLinesTotal,
        final_tracked_changed_lines_source: finalTrackedChangedLinesSource,
        late_evidence_files: lateEvidenceFiles
    };
}

function filterNotRequiredEvidenceArtifacts(
    evidence: EvidenceArtifact[],
    options: {
        fullSuiteRequired: boolean;
        completionGatePassed: boolean;
    }
): EvidenceArtifact[] {
    return evidence.filter((artifact) => {
        if (artifact.exists) {
            return true;
        }
        if (!options.fullSuiteRequired && artifact.kind === 'full-suite-validation') {
            return false;
        }
        if (options.completionGatePassed && artifact.kind === 'completion-gate') {
            return false;
        }
        return true;
    });
}

export function buildTaskAuditSummary(options: TaskAuditSummaryOptions): TaskAuditSummaryResult {
    const repoRoot = path.resolve(options.repoRoot);
    const safeTaskId = assertValidTaskId(options.taskId);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    if (!isPathRealpathInsideRoot(eventsRoot, repoRoot, { allowMissing: true })) {
        throw new Error(
            `EventsRoot must resolve inside repo root without symlink or junction escape: ${toPosix(eventsRoot)}.`
        );
    }
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    if (!isPathRealpathInsideRoot(reviewsRoot, repoRoot, { allowMissing: true })) {
        throw new Error(
            `ReviewsRoot must resolve inside repo root without symlink or junction escape: ${toPosix(reviewsRoot)}.`
        );
    }
    return withTaskTimelineReadSnapshot(eventsRoot, safeTaskId, () => (
        withReviewArtifactReadBarrier(reviewsRoot, () => (
            withTaskIndexReadSnapshot(reviewsRoot, safeTaskId, () => (
                buildTaskAuditSummaryFromSnapshot(options)
            ))
        ))
    ));
}

function buildTaskAuditSummaryFromSnapshot(options: TaskAuditSummaryOptions): TaskAuditSummaryResult {
    const repoRoot = path.resolve(options.repoRoot);
    const workspaceSnapshotRequest = resolveWorkspaceSnapshotRequest(
        repoRoot,
        options.workspaceSnapshotRequest
    );
    const safeTaskId = assertValidTaskId(options.taskId);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const liveFullSuiteValidationEnabled = loadFullSuiteValidationConfig(repoRoot).enabled;
    const liveReviewExecutionPolicyMode = loadReviewExecutionPolicyConfig(repoRoot).mode;
    const reviewCycleExcludedReviewTypes = readReviewCycleExcludedReviewTypes(repoRoot);
    const taskMetadata = readTaskQueueMetadata(repoRoot, safeTaskId, options.taskQueueEntries);
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    const taskFileExists = fs.existsSync(taskPath) && fs.statSync(taskPath).isFile();
    const taskEventFile = path.join(eventsRoot, `${safeTaskId}.jsonl`);
    const orderedEvents = readOrderedTaskEvents(taskEventFile);
    const events = orderedEvents.events;
    const currentCycle = resolveTaskCycleBindingSnapshot(safeTaskId, events, repoRoot, reviewsRoot);
    const fullSuiteValidationEnabled = resolveFullSuiteValidationRequirementForCurrentCycle(
        events,
        currentCycle,
        repoRoot,
        liveFullSuiteValidationEnabled
    );
    const preflightForLifecycle = safeReadJson(path.join(reviewsRoot, `${safeTaskId}-preflight.json`));
    const fullSuiteValidationRequiredForLifecycle = fullSuiteValidationEnabled
        && !isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflightForLifecycle || {});
    const projectMemoryImpactEvidence = getProjectMemoryImpactLifecycleEvidence({
        repoRoot,
        taskId: safeTaskId,
        preflightPath: path.join(reviewsRoot, `${safeTaskId}-preflight.json`)
    });
    const hasCurrentProjectMemoryImpactEvent = hasCurrentCycleProjectMemoryImpactEvent(events, currentCycle, repoRoot);
    const hasCompletionPassEvent = events.some((event) => String(event.event_type || '').trim().toUpperCase() === 'COMPLETION_GATE_PASSED');
    const projectMemoryImpactRequired = projectMemoryImpactEvidence.required
        && (!hasCompletionPassEvent || hasCurrentProjectMemoryImpactEvent);
    const workspaceStatusSnapshot = getTaskCycleStatusSnapshot(
        repoRoot,
        safeTaskId,
        undefined,
        options.taskQueueEntries
    );
    const lifecycleGates = getLifecycleGates(fullSuiteValidationRequiredForLifecycle, projectMemoryImpactRequired);
    let integrityStatus: string;
    if (fs.existsSync(taskEventFile) && fs.statSync(taskEventFile).isFile()) {
        try {
            const report = inspectTaskEventFile(taskEventFile, safeTaskId);
            integrityStatus = report.status;
        } catch {
            integrityStatus = 'ERROR';
        }
    } else {
        integrityStatus = 'MISSING';
    }
    const lifecycleStatus = buildLifecycleGateOutcomes(
        lifecycleGates,
        events,
        currentCycle,
        repoRoot
    );
    const gates = [...lifecycleStatus.gates];
    const blockers = [...lifecycleStatus.blockers];
    const orchestratorDefectCapture = buildOrchestratorDefectCaptureSummary({
        repoRoot,
        taskId: safeTaskId,
        events
    });
    if (orchestratorDefectCapture.status === 'INVALID') {
        blockers.push({
            gate: 'orchestrator-defect-capture',
            reason:
                'An acknowledged orchestrator defect lacks durable TASK.md capture: '
                + orchestratorDefectCapture.violations.join(' | ')
        });
    }
    let pointInTimeSnapshot: PointInTimeSnapshot = {
        status: 'STABLE',
        gate: null,
        message: null,
        recommended_action: null,
        lock_path: null,
        owner_pid: null,
        owner_hostname: null,
        owner_created_at_utc: null,
        owner_alive: null,
        owner_metadata_status: null,
        stale_reason: null,
        subsystem_scope_note: null,
        acquisition_policy: null
    };

    const preflightSummary = readPreflightSummary(reviewsRoot, safeTaskId);
    const requiredReviews = preflightSummary.requiredReviews;
    const scopeCategory = preflightSummary.scopeCategory;
    const pathMode = preflightSummary.pathMode;
    const preflightPath = preflightSummary.path;
    const preflight = preflightSummary.raw;
    const fullSuiteValidation = safeReadJson(path.join(reviewsRoot, `${safeTaskId}-full-suite-validation.json`));
    const docImpactPath = path.join(reviewsRoot, `${safeTaskId}-doc-impact.json`);
    const docImpact = safeReadJson(docImpactPath);
    const docsSummary = readDocImpactSummary(docImpact);
    const auditedChangedFiles = buildAuditedChangedFiles(repoRoot, preflightSummary.changedFiles, docsSummary);
    const changedFiles = auditedChangedFiles.changedFiles;
    const changedFilesCount = changedFiles.length;
    const preflightChangedLinesTotal = preflightSummary.changedLinesTotal;
    const changeMetrics = buildFinalCloseoutChangeMetrics({
        repoRoot,
        preflightChangedFiles: preflightSummary.changedFiles,
        preflightChangedLinesTotal,
        finalTrackedChangedFiles: changedFiles,
        workspaceSnapshotRequest
    });
    const changedLinesTotal = changeMetrics.final_tracked_changed_lines_total ?? preflightChangedLinesTotal;
    const finalCloseoutJsonPath = path.join(reviewsRoot, `${safeTaskId}-final-closeout.json`);
    const finalCloseoutMarkdownPath = path.join(reviewsRoot, `${safeTaskId}-final-closeout.md`);
    const finalUserReportPath = path.join(reviewsRoot, `${safeTaskId}-final-user-report.md`);
    const hasCompletionPass = gates.some(
        (g) => g.gate === 'completion-gate' && g.status === 'PASS'
    );
    const hasMaterializedFinalCloseoutArtifact = fs.existsSync(finalCloseoutJsonPath) || fs.existsSync(finalCloseoutMarkdownPath);
    if (hasCompletionPass && hasMaterializedFinalCloseoutArtifact) {
        const postDoneDriftBlocker = buildPostDoneWorkspaceDriftBlocker(
            repoRoot,
            changedFiles,
            preflightSummary.changedFiles,
            preflight,
            finalCloseoutJsonPath,
            workspaceSnapshotRequest
        );
        if (postDoneDriftBlocker) {
            blockers.push(postDoneDriftBlocker);
        }
    }
    const timelineReviewExecutionPolicyMode = preflight
        ? null
        : readReviewExecutionPolicyModeFromCurrentCycleTimeline(events, currentCycle, repoRoot);
    const reviewExecutionPolicyMode = preflight
        ? resolveReviewExecutionPolicyModeFromPreflight(preflight)
        : timelineReviewExecutionPolicyMode || liveReviewExecutionPolicyMode;
    const reviewDependencyGraph = preflight
        ? resolveCompiledReviewDependencyGraphFromPreflight(preflight, reviewExecutionPolicyMode)
        : null;
    const preflightSha256 = preflightSummary.sha256;
    const taskModePath = path.join(reviewsRoot, `${safeTaskId}-task-mode.json`);
    const taskMode = safeReadJson(taskModePath);
    const profileReviewDecisions = readProfileReviewDecisions(taskMode, preflight, scopeCategory, requiredReviews);
    const reviewGatePath = path.join(reviewsRoot, `${safeTaskId}-review-gate.json`);
    const reviewSnapshot = withReviewArtifactReadBarrier(reviewsRoot, () => {
        const requiredReviewBlockers = collectRequiredReviewBlockers(
            requiredReviews,
            safeTaskId,
            reviewsRoot,
            events,
            currentCycle,
            preflight
        );
        const evidence = filterNotRequiredEvidenceArtifacts(collectEvidenceArtifacts(
            repoRoot,
            reviewsRoot,
            safeTaskId,
            taskEventFile,
            projectMemoryImpactEvidence,
            preflight
        ), {
            fullSuiteRequired: fullSuiteValidationRequiredForLifecycle,
            completionGatePassed: hasCompletionPass
        });
        const reviewGate = safeReadJson(reviewGatePath);
        const reviewVerdicts = readReviewVerdicts(requiredReviews, reviewGate);
        const receiptReviewTrustSummary = readReviewTrustSummary(
            requiredReviews,
            reviewsRoot,
            safeTaskId,
            scopeCategory,
            preflightSha256,
            preflight,
            repoRoot
        );
        const reviewGateTrustSummary = readReviewTrustSummaryFromReviewGate(
            reviewGate,
            requiredReviews,
            safeTaskId,
            scopeCategory,
            preflightSha256,
            preflight,
            reviewsRoot
        );
        const reviewAuthorshipAttestationIssues = collectReviewAuthorshipAttestationIssues(
            reviewGate,
            requiredReviews,
            preflight
        );
        const hasRequiredReviews = Object.values(requiredReviews).some((value) => value);
        const reviewTrustSummary = reviewGateTrustSummary
            ?? receiptReviewTrustSummary
            ?? (hasRequiredReviews
                ? buildUnavailableRequiredReviewTrustSummary(requiredReviews, scopeCategory)
                : null);
        const reviewIntegrityAttestation = buildReviewIntegrityAttestation({
            requiredReviews,
            reviewsRoot,
            taskId: safeTaskId,
            scopeCategory,
            preflightSha256,
            reviewTrustSummary,
            repoRoot,
            currentPreflight: preflight,
            timelineEvents: events,
            initialIssues: reviewAuthorshipAttestationIssues
        });
        const reviewAttemptSummary = buildReviewAttemptSummary({
            reviewsRoot,
            taskId: safeTaskId,
            timelineEvents: events,
            currentPreflight: preflight,
            excludedReviewTypes: reviewCycleExcludedReviewTypes
        });
        const reviewFindingsAudit = buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: safeTaskId,
            requiredReviews,
            currentPreflight: preflight,
            timelineEvents: events,
            reviewAttemptSummary,
            taskQueueEntries: options.taskQueueEntries
        });
        const reviewTimingAudit = buildReviewTimingAuditSummary(
            reviewsRoot,
            safeTaskId,
            events,
            repoRoot,
            preflight
        );
        const reviewCoverageSummary = buildReviewCoverageAuditSummary({
            reviewsRoot,
            taskId: safeTaskId,
            requiredReviews,
            orderedEvents: events
        });
        return {
            evidence,
            requiredReviewBlockers,
            reviewAttemptSummary,
            reviewFindingsAudit,
            reviewIntegrityAttestation,
            reviewTimingAudit,
            reviewCoverageSummary,
            reviewTrustSummary,
            reviewVerdicts
        };
    });
    blockers.push(...auditedChangedFiles.violations.map((reason) => ({
        gate: 'doc-impact-gate',
        reason
    })));
    if (!hasCompletionPass) {
        blockers.push(...reviewSnapshot.requiredReviewBlockers);
    }
    if (
        reviewSnapshot.reviewCoverageSummary.status === 'INCOMPLETE'
        && hasCurrentCycleReviewProgress(events)
    ) {
        blockers.push({
            gate: 'review-coverage',
            reason: reviewSnapshot.reviewCoverageSummary.visible_summary_line
        });
    }
    if (projectMemoryImpactRequired && projectMemoryImpactEvidence.evidence_status !== 'CURRENT') {
        blockers.push({
            gate: 'project-memory-impact',
            reason:
                `Project memory impact evidence is ${projectMemoryImpactEvidence.evidence_status}. ` +
                `${projectMemoryImpactEvidence.visible_summary_line}`
        });
    }
    const completionReviewOrderBlocker = buildCompletionReviewOrderBlocker(
        requiredReviews,
        events,
        currentCycle,
        repoRoot,
        reviewDependencyGraph
    );
    if (completionReviewOrderBlocker) {
        blockers.push(completionReviewOrderBlocker);
    }
    const tokenEconomy = buildTokenEconomySummary(safeTaskId, events, repoRoot, reviewsRoot);
    const taskCycleDiagnostics = buildTaskCycleDiagnostics({
        taskId: safeTaskId,
        workspaceStatusSnapshot
    });
    const evidence = reviewSnapshot.evidence;
    const hasFailedGate = gates.some((g) => g.status === 'FAIL');
    const failedGateNames = gates.filter((g) => g.status === 'FAIL').map((g) => g.gate);
    const hasNonCompletionFailure = failedGateNames.some((gateName) => gateName !== 'completion-gate');
    const hasIntegrityFailure = integrityStatus === 'FAILED';
    const completionGateLock: FinalizationLockInspection | null = options.ignoreActiveCompletionFinalizationLock
        ? null
        : inspectCompletionGateFinalizationLock(reviewsRoot, safeTaskId);
    if (completionGateLock && (completionGateLock.active || completionGateLock.stale)) {
        const ownerPidText = completionGateLock.owner_pid === null ? 'unknown' : String(completionGateLock.owner_pid);
        const ownerHostText = completionGateLock.owner_hostname || 'unknown';
        pointInTimeSnapshot = {
            status: 'FINALIZATION_IN_FLIGHT',
            gate: 'completion-gate',
            message: completionGateLock.active
                ? `Completion gate finalization is currently in flight under PID ${ownerPidText} on ${ownerHostText}, so this audit summary is a point-in-time snapshot and may still reflect an older completion result.`
                : `Completion finalization lock is stale (${completionGateLock.stale_reason || 'unknown reason'}, metadata=${completionGateLock.owner_metadata_status}) for PID ${ownerPidText} on ${ownerHostText}, so this audit summary is treated as a point-in-time snapshot and may still reflect an older completion result.`,
            recommended_action: completionGateLock.active
                ? `Re-run task-audit-summary sequentially after completion-gate finishes. ${completionGateLock.remediation}`
                : completionGateLock.remediation,
            lock_path: toPosix(completionGateLock.lock_path),
            owner_pid: completionGateLock.owner_pid,
            owner_hostname: completionGateLock.owner_hostname,
            owner_created_at_utc: completionGateLock.owner_created_at_utc,
            owner_alive: completionGateLock.owner_alive,
            owner_metadata_status: completionGateLock.owner_metadata_status,
            stale_reason: completionGateLock.stale_reason,
            subsystem_scope_note: completionGateLock.subsystem_scope_note,
            acquisition_policy: completionGateLock.acquisition_policy
        };
    }

    if (hasIntegrityFailure) {
        blockers.push({
            gate: 'integrity',
            reason: `Task event timeline integrity check returned ${integrityStatus}`
        });
    }

    const hasNonCompletionBlockers = blockers.some((blocker) => blocker.gate !== 'completion-gate');
    if (
        pointInTimeSnapshot.status === 'FINALIZATION_IN_FLIGHT'
        && !hasIntegrityFailure
        && !hasNonCompletionBlockers
        && !hasNonCompletionFailure
    ) {
        for (let index = blockers.length - 1; index >= 0; index--) {
            if (blockers[index].gate === 'completion-gate') {
                blockers.splice(index, 1);
            }
        }
    }

    let status: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    const reviewsRequired = Object.keys(requiredReviews).some((reviewType) => requiredReviews[reviewType]);
    const reviewDomainFinalitySatisfied = reviewsRequired
        && reviewSnapshot.reviewIntegrityAttestation.completion_allowed === true
        && reviewSnapshot.reviewIntegrityAttestation.completion_review_attested === true;
    const supportingLifecycleAnchorEvents = new Set([
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'SHELL_SMOKE_PREFLIGHT_RECORDED',
        'PREFLIGHT_CLASSIFIED',
        'COMPILE_GATE_PASSED',
        'REVIEW_PHASE_STARTED',
        'REVIEW_GATE_PASSED',
        'REVIEW_GATE_PASSED_WITH_OVERRIDE',
        'DOC_IMPACT_ASSESSED',
        PROJECT_MEMORY_IMPACT_ASSESSED_EVENT
    ]);
    const requireSupportingGateCompleteness = events.some((event) =>
        supportingLifecycleAnchorEvents.has(String(event.event_type || ''))
    );
    const supportingGateGaps = requireSupportingGateCompleteness
        ? gates
            .filter((gate) => {
                if (gate.gate === 'completion-gate') {
                    return false;
                }
                if (!reviewsRequired && gate.gate === 'review-phase') {
                    return false;
                }
                if (gate.gate === 'required-reviews-check' && reviewDomainFinalitySatisfied) {
                    return false;
                }
                return gate.status !== 'PASS';
            })
            .map((gate) => gate.gate)
        : [];
    if (pointInTimeSnapshot.status === 'FINALIZATION_IN_FLIGHT') {
        status = !hasIntegrityFailure && blockers.length === 0 && !hasNonCompletionFailure
            ? 'INCOMPLETE'
            : 'BLOCKED';
    } else if (
        hasCompletionPass
        && blockers.length === 0
        && !hasIntegrityFailure
        && supportingGateGaps.length === 0
    ) {
        status = 'PASS';
    } else if (hasFailedGate || blockers.length > 0) {
        status = 'BLOCKED';
    } else {
        status = 'INCOMPLETE';
    }

    const commitGuardEnabled = workspaceStatusSnapshot.enforceNoAutoCommit === true;
    const committableChangedFiles = resolveCommittableChangedFiles(repoRoot, workspaceSnapshotRequest);
    const rawCommitCandidateChangedFiles = committableChangedFiles == null
        ? changedFiles.filter((changedFile) => !isLocalControlPlaneCommitPath(changedFile))
        : committableChangedFiles;
    const commitCandidateChangedFiles = filterCommitCandidatesToTaskOwnedPreflightScope(
        repoRoot,
        preflight,
        rawCommitCandidateChangedFiles
    );
    const commitCommand = buildCommitCommandSuggestion(
        commitCandidateChangedFiles.length > 0
            ? commitCandidateChangedFiles
            : filterCommitCandidatesToTaskOwnedPreflightScope(repoRoot, preflight, changedFiles),
        taskMetadata,
        commitGuardEnabled
    );
    const commitRequired = commitCandidateChangedFiles.length > 0;
    const commitCommandTemplate = commitRequired
        ? commitCommand.template
        : 'No commit command required.';
    const commitCommandSuggestion = commitRequired
        ? commitCommand.suggestion
        : NO_COMMIT_REQUIRED_MESSAGE;
    const commitQuestionText = commitRequired
        ? 'Do you want me to commit now? (yes/no)'
        : NO_COMMIT_CONFIRMATION_MESSAGE;
    
    const {
        reviewVerdicts,
        reviewTrustSummary,
        reviewAttemptSummary,
        reviewFindingsAudit,
        reviewTimingAudit,
        reviewIntegrityAttestation
    } = reviewSnapshot;
    const reviewIntegrityBlocker = hasCompletionPass && reviewIntegrityAttestation.completion_allowed === false
        ? {
            gate: 'review-integrity',
            reason: reviewIntegrityAttestation.reason
        }
        : null;
    if (reviewIntegrityBlocker && !blockers.some((blocker) => blocker.gate === reviewIntegrityBlocker.gate)) {
        blockers.push(reviewIntegrityBlocker);
    }
    if (status === 'PASS' && reviewIntegrityBlocker) {
        status = 'BLOCKED';
    }
    const optionalSkillsPath = path.join(reviewsRoot, `${safeTaskId}-optional-skill-selection.json`);
    const bundleRoot = path.dirname(path.dirname(reviewsRoot));
    const taskEventsTimelineEvidence = readOptionalSkillSelectionTimelineEvidence(bundleRoot, safeTaskId, taskEventFile);
    const optionalSkillsSummary = readOptionalSkillsSummary(
        bundleRoot,
        preflightPath,
        preflightSha256,
        taskMetadata?.title || null,
        taskFileExists && taskMetadata == null,
        optionalSkillsPath,
        safeReadJson(optionalSkillsPath),
        taskEventsTimelineEvidence
    );
    const implementationSummaryRequirements = [
        'path mode',
        'review result status',
        'docs updated'
    ];
    if (projectMemoryImpactRequired || projectMemoryImpactEvidence.evidence_status !== 'NOT_REQUIRED') {
        implementationSummaryRequirements.push('project memory status');
    }
    const finalReportContract: FinalReportContract = {
        status: status === 'PASS' ? 'READY' : 'NOT_READY',
        blocker: status === 'PASS'
            ? null
            : reviewIntegrityBlocker
                ? `Review integrity blocked final closeout: ${reviewIntegrityBlocker.reason}`
            : pointInTimeSnapshot.status === 'FINALIZATION_IN_FLIGHT' && status === 'INCOMPLETE'
                ? `${pointInTimeSnapshot.message} ${pointInTimeSnapshot.recommended_action}`
                : hasCompletionPass && supportingGateGaps.length > 0
                    ? `Completion gate passed, but supporting lifecycle evidence is incomplete: ${supportingGateGaps.join(', ')}.`
                : hasCompletionPass && blockers.length > 0
                    ? `Completion gate passed, but final closeout is blocked: ${blockers.map((blocker) => blocker.reason).join(' ')}`
                : 'Completion gate has not passed cleanly yet; do not deliver the task-complete final report contract.',
        required_order: [
            'short agent-authored summary of what changed',
            'verbatim Garda final user report'
        ],
        implementation_summary_requirements: implementationSummaryRequirements,
        commit_command_template: commitCommandTemplate,
        commit_command_suggestion: commitCommandSuggestion,
        commit_question: commitQuestionText
    };
    const finalCloseout = buildFinalCloseoutArtifact({
        repoRoot,
        taskId: safeTaskId,
        auditStatus: status,
        finalReportContract,
        finalCloseoutJsonPath,
        finalCloseoutMarkdownPath,
        finalUserReportPath,
        currentCycle,
        preflight,
        taskMode,
        pathMode,
        reviewVerdicts,
        docsSummary,
        changedFiles,
        changedFilesCount,
        changedLinesTotal,
        changeMetrics,
        scopeCategory,
        reviewTrustSummary,
        reviewTimingAudit,
        reviewIntegrityAttestation,
        reviewAttemptSummary,
        reviewFindingsAudit,
        reviewCoverageSummary: reviewSnapshot.reviewCoverageSummary,
        optionalSkillsSummary,
        fullSuiteValidation,
        fullSuiteValidationRequiredForLifecycle,
        reviewExecutionPolicyMode,
        projectMemoryImpactEvidence,
        orchestratorDefectCapture,
        tokenEconomy,
        taskCycleDiagnostics,
        workspaceStatusSnapshot,
        commitCommandTemplate,
        commitCommandSuggestion,
        workspaceSnapshotRequest
    });

    return {
        task_id: safeTaskId,
        generated_utc: finalCloseout.generated_utc,
        status,
        events_count: orderedEvents.count,
        first_event_utc: orderedEvents.firstEventUtc,
        last_event_utc: orderedEvents.lastEventUtc,
        integrity_status: integrityStatus,
        gates,
        changed_files: changedFiles,
        changed_files_count: changedFilesCount,
        changed_lines_total: changedLinesTotal,
        required_reviews: requiredReviews,
        scope_category: scopeCategory,
        profile_review_decisions: profileReviewDecisions,
        evidence,
        blockers,
        point_in_time_snapshot: pointInTimeSnapshot,
        task_cycle_diagnostics: taskCycleDiagnostics,
        review_attempt_summary: reviewAttemptSummary,
        review_findings_audit: reviewFindingsAudit,
        review_coverage_summary: reviewSnapshot.reviewCoverageSummary,
        final_report_contract: finalReportContract,
        final_closeout: finalCloseout
    };
}
