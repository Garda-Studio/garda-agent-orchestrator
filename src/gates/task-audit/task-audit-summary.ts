import { isInvocationReadObservationActive } from '../../core/invocation-read-observation';
import { readTaskTimelineNavigationQuery } from '../../gate-runtime/timeline/task-events-integrity';
import { navigationRawEvents, navigationQueryForEvents, navigationLatestEvent, navigationEventSequence,
    type NavigationTimelineQuery } from '../../gate-runtime/timeline/task-navigation-query';
import { createReportProjectionValue, bindNavigationAuditCycle } from './task-audit-summary-navigation';
import { countNextStepArrayCopy, measureNextStepPhase, countNextStepWork } from '../../core/next-step-measurement';
import { getReviewHistoryIntegrityViolations } from '../review-attempts/review-history-integrity';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { isTaskQueueDecomposedStatus } from '../../core/active-task-state';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readNativeParentObligationProofs } from './task-audit-summary-parent-obligation-proofs';
import {
    assertValidTaskId,
    inspectTaskEventFile,
    readTaskTimelineJsonlEntries,
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
import { resolveLocalCommitAvailability } from '../../core/auth/local-commit-availability';
import {
    buildCompletionReviewOrderBlocker,
    buildLifecycleGateOutcomes,
    getLifecycleGates,
    hasCurrentCycleReviewProgress,
    hasCurrentCycleProjectMemoryImpactEvent,
    readImmutableOrderedTaskEvents,
    readNavigationOrderedTaskEvents,
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
import { getNoOpEvidence } from '../task-mode';
import { getCurrentNoOpEventSha256 } from '../task-mode/no-op';
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
const AGGREGATE_STARTUP_GATES = new Set([
    'enter-task-mode', 'load-rule-pack', 'handshake-diagnostics', 'shell-smoke-preflight'
]);

function buildNativeAggregateAudit(options: TaskAuditSummaryOptions, events: Readonly<Record<string, unknown>>[],
    taskMetadata: ReturnType<typeof readTaskQueueMetadata>, inspectReviewHistory: boolean, navigationQuery: NavigationTimelineQuery | null = null): TaskAuditSummaryResult | null {
    const repoRoot = path.resolve(options.repoRoot), taskId = options.taskId;
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot), reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const parentMarker = navigationQuery?.hasParentMarker ?? events.some(event => (countNextStepWork('visit:task-audit-summary:145'), event.event_type === 'DECOMPOSED_PARENT_COMPLETED'
        || (event.event_type === 'STRICT_DECOMPOSITION_DECISION_RECORDED'
            && (event.details as Record<string, unknown> | undefined)?.decision === 'split-required')));
    if (!taskMetadata && !parentMarker) return null;
    let proof: ReturnType<typeof readNativeParentObligationProofs> = null;
    const blockers: TaskAuditSummaryResult['blockers'] = [];
    try { proof = readNativeParentObligationProofs(repoRoot, taskId,
        childTaskId => buildTaskAuditSummaryForPurpose({ repoRoot, taskId: childTaskId }, inspectReviewHistory)); }
    catch (error: unknown) { blockers.push({ gate: 'decomposed-parent-obligations', reason: error instanceof Error ? error.message : String(error) }); }
    const canonicalParentMarker = Boolean(proof?.native.facts.decomposition || proof?.native.facts.completion);
    if (!parentMarker && !canonicalParentMarker && proof && !isTaskQueueDecomposedStatus(proof.native.facts.taskStatus)) return null;
    if (!proof && blockers.length === 0) return null;
    blockers.push(...(proof?.violations || []).map(reason => (countNextStepWork('visit:task-audit-summary:157'), ({ gate: 'decomposed-parent-obligations', reason }))));
    if (eventsRoot !== resolveEventsRoot(repoRoot) || reviewsRoot !== resolveReviewsRoot(repoRoot)) {
        blockers.push({ gate: 'decomposed-parent-obligations', reason: 'Native aggregate proof requires canonical event and review roots.' });
    }
    const timeline = path.join(eventsRoot, taskId + '.jsonl'), inspection = inspectTaskEventFile(timeline, taskId);
    if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status) || inspection.violations.length) {
        blockers.push({ gate: 'integrity', reason: 'Native aggregate timeline integrity is ' + inspection.status + '.' });
    }
    if (inspectReviewHistory && ['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status) && !inspection.violations.length) {
        blockers.push(...getReviewHistoryIntegrityViolations({ repoRoot, reviewsRoot, taskId, timelineEvents: events })
            .map(reason => ({ gate: 'review-history-integrity', reason })));
    }
    if (proof?.status !== 'QUALIFIED' && blockers.length === 0) {
        blockers.push({ gate: 'decomposed-parent-obligations', reason: 'Original native parent obligations are not qualified.' });
    }
    const reviewIntegrity = buildReviewIntegrityAttestation({ requiredReviews: {}, reviewsRoot, taskId,
        scopeCategory: 'decomposed-parent', reviewTrustSummary: null, repoRoot, timelineEvents: events });
    const lock = options.ignoreActiveCompletionFinalizationLock ? null : inspectCompletionGateFinalizationLock(reviewsRoot, taskId);
    const inFlight = Boolean(lock?.active || lock?.stale);
    const point: PointInTimeSnapshot = inFlight && lock ? {
        status: 'FINALIZATION_IN_FLIGHT', gate: 'completion-gate', message: lock.remediation, recommended_action: lock.remediation,
        lock_path: toPosix(lock.lock_path), owner_pid: lock.owner_pid, owner_hostname: lock.owner_hostname,
        owner_created_at_utc: lock.owner_created_at_utc, owner_alive: lock.owner_alive, owner_metadata_status: lock.owner_metadata_status,
        stale_reason: lock.stale_reason, subsystem_scope_note: lock.subsystem_scope_note, acquisition_policy: lock.acquisition_policy
    } : { status: 'STABLE', gate: null, message: null, recommended_action: null, lock_path: null };
    const status = blockers.length ? 'BLOCKED' : inFlight ? 'INCOMPLETE' : 'PASS';
    const generated = new Date().toISOString(), ready = status === 'PASS';
    const entryIndex = events.map(event => (countNextStepWork('visit:task-audit-summary:180'), event.event_type)).lastIndexOf('TASK_MODE_ENTERED');
    const startup = buildLifecycleGateOutcomes(
        getLifecycleGates(false, false).filter(gate => (countNextStepWork('visit:task-audit-summary:182'), AGGREGATE_STARTUP_GATES.has(gate.gate))),
        entryIndex < 0 ? [] : countNextStepArrayCopy('visit:task-audit-summary:copy:183', events.slice(entryIndex)), null, repoRoot
    );
    const contract: FinalReportContract = { status: ready ? 'READY' : 'NOT_READY',
        blocker: ready ? null : blockers.map(blocker => (countNextStepWork('visit:task-audit-summary:186'), blocker.reason)).join(' ') || point.message,
        required_order: ['short agent-authored summary of what changed', 'verbatim Garda final user report'],
        implementation_summary_requirements: ['native aggregate proof and child source provenance'],
        commit_command_template: 'No commit command required.', commit_command_suggestion: NO_COMMIT_REQUIRED_MESSAGE,
        commit_question: NO_COMMIT_CONFIRMATION_MESSAGE };
    const evidence: EvidenceArtifact[] = (proof?.native.childSources || []).map(source => (countNextStepWork('visit:task-audit-summary:191'), ({
        kind: 'child-source:' + source.taskId, path: source.artifactPath, exists: true, sha256: source.artifactSha256
    })));
    if (fs.existsSync(timeline)) evidence.push({ kind: 'native-parent-timeline', path: timeline, exists: true,
        sha256: createHash('sha256').update(fs.readFileSync(timeline)).digest('hex') });
    return {
        task_id: taskId, generated_utc: generated, status, events_count: events.length,
        first_event_utc: typeof events[0]?.timestamp_utc === 'string' ? events[0].timestamp_utc : null,
        last_event_utc: typeof events.at(-1)?.timestamp_utc === 'string' ? String(events.at(-1)!.timestamp_utc) : null,
        integrity_status: inspection.status,
        gates: [...startup.gates, ...(proof?.native.requirements.requiredProofs || []).map(name => (countNextStepWork('visit:task-audit-summary:201'), ({ gate: 'decomposed-parent:' + name,
            status: proof!.qualifiedProofs.includes(name) ? 'PASS' as const : 'MISSING' as const })))],
        changed_files: [], changed_files_count: 0, changed_lines_total: 0, required_reviews: {},
        scope_category: 'decomposed-parent', profile_review_decisions: null, evidence, blockers,
        point_in_time_snapshot: point, final_report_contract: contract,
        final_closeout: {
            schema_version: 1, event_source: 'task-audit-summary', task_id: taskId, generated_utc: generated,
            audit_status: status, status: contract.status, blocker: contract.blocker, artifact_state: ready ? 'PENDING' : 'NOT_READY',
            artifact_paths: { json: path.join(reviewsRoot, taskId + '-final-closeout.json'),
                markdown: path.join(reviewsRoot, taskId + '-final-closeout.md'), final_user_report: path.join(reviewsRoot, taskId + '-final-user-report.md') },
            implementation_summary: { requested_depth: null, effective_depth: null, path_mode: 'DECOMPOSED_PARENT',
                review_verdicts: {}, docs_updated: false, changed_files_count: 0, changed_lines_total: 0,
                scope_category: 'decomposed-parent', active_profile: taskMetadata?.profile || null },
            review_integrity_attestation: reviewIntegrity,
            workflow: { mandatory_full_suite_enabled: proof?.native.requirements.requiredProofs.includes('full-suite-composition') === true,
                visible_summary_line: 'Native original command composition and child SOURCE acceptance; no direct parent review execution is claimed.' },
            docs: { decision: 'AGGREGATE_SOURCE_PROVENANCE', behavior_changed: false, changelog_updated: false, docs_updated: [] },
            token_economy: null, commit_command_template: contract.commit_command_template,
            commit_command_suggestion: contract.commit_command_suggestion, commit_question: contract.commit_question
        }
    };
}

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
    return candidateFiles.filter((changedFile) => (countNextStepWork('visit:task-audit-summary:240'), taskScopeSet.has(toPosix(changedFile))));
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
    const matchingDetails = warningDetails.filter((detail) => (countNextStepWork('visit:task-audit-summary:265'), detail.task_id === options.taskId));
    const preferred = matchingDetails.find((detail) => (countNextStepWork('visit:task-audit-summary:266'), detail.kind === 'INCOMPLETE')) ?? matchingDetails[0] ?? null;
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
    const preflightFileSet = new Set(options.preflightChangedFiles.map((entry) => (countNextStepWork('visit:task-audit-summary:307'), toPosix(entry))).filter(Boolean));
    const lateEvidenceFiles = [...new Set(options.finalTrackedChangedFiles
        .map((entry) => (countNextStepWork('visit:task-audit-summary:308'), toPosix(entry)))
        .filter((entry) => (countNextStepWork('visit:task-audit-summary:308'), entry && !preflightFileSet.has(entry))))]
        .sort((left, right) => (countNextStepWork('visit:task-audit-summary:308'), left.localeCompare(right)));
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
        compileGateRequired: boolean;
        completionGatePassed: boolean;
    }
): EvidenceArtifact[] {
    return evidence.filter((artifact) => {
        countNextStepWork('visit:task-audit-summary:352');
        if (artifact.exists) {
            return true;
        }
        if (!options.fullSuiteRequired && artifact.kind === 'full-suite-validation') {
            return false;
        }
        if (!options.compileGateRequired && (artifact.kind === 'compile-gate' || artifact.kind === 'compile-output')) {
            return false;
        }
        if (options.completionGatePassed && artifact.kind === 'completion-gate') {
            return false;
        }
        return true;
    });
}

export function buildTaskAuditSummary(options: TaskAuditSummaryOptions): TaskAuditSummaryResult {
    return buildTaskAuditSummaryForPurpose(options, true);
}

/** Navigator projection only; explicit audit and completion always use buildTaskAuditSummary. */
export function buildNavigationTaskAuditSummary(options: TaskAuditSummaryOptions): TaskAuditSummaryResult {
    return buildTaskAuditSummaryForPurpose(options, false);
}

function buildTaskAuditSummaryForPurpose(options: TaskAuditSummaryOptions, inspectReviewHistory: boolean): TaskAuditSummaryResult {
    return measureNextStepPhase('audit', () => {
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
                buildTaskAuditSummaryFromSnapshot(options, inspectReviewHistory)
            ))
        ))
    ));

    });
}

function buildTaskAuditSummaryFromSnapshot(options: TaskAuditSummaryOptions, inspectReviewHistory: boolean): TaskAuditSummaryResult {
    const repoRoot = path.resolve(options.repoRoot);
    const workspaceSnapshotRequest = resolveWorkspaceSnapshotRequest(
        repoRoot,
        options.workspaceSnapshotRequest
    );
    const safeTaskId = assertValidTaskId(options.taskId);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const lazyReports = !inspectReviewHistory && isInvocationReadObservationActive();
    const reportValue = <T>(name: string, build: () => T): (() => T) => createReportProjectionValue(name, lazyReports, build,
        action => withTaskTimelineReadSnapshot(eventsRoot, safeTaskId, () => withReviewArtifactReadBarrier(reviewsRoot,
            () => withTaskIndexReadSnapshot(reviewsRoot, safeTaskId, action))));
    const liveFullSuiteValidationEnabled = loadFullSuiteValidationConfig(repoRoot).enabled;
    const liveReviewExecutionPolicyMode = loadReviewExecutionPolicyConfig(repoRoot).mode;
    const reviewCycleExcludedReviewTypes = readReviewCycleExcludedReviewTypes(repoRoot);
    const taskMetadata = readTaskQueueMetadata(repoRoot, safeTaskId, options.taskQueueEntries);
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    const taskFileExists = fs.existsSync(taskPath) && fs.statSync(taskPath).isFile();
    const taskEventFile = path.join(eventsRoot, `${safeTaskId}.jsonl`);
    const navigationQuery = inspectReviewHistory ? null : readTaskTimelineNavigationQuery(taskEventFile, safeTaskId);
    const orderedEvents = inspectReviewHistory ? readImmutableOrderedTaskEvents(taskEventFile, safeTaskId)
        : readNavigationOrderedTaskEvents(taskEventFile, safeTaskId);
    const events = orderedEvents.events;
    const readNativeFileOrderedEvents = () => readTaskTimelineJsonlEntries(taskEventFile)
        .map((entry) => (countNextStepWork('visit:task-audit-summary:414'), entry.record))
        .filter((entry): entry is Readonly<Record<string, unknown>> => (countNextStepWork('visit:task-audit-summary:414'), entry !== null))
        .map((entry) => (countNextStepWork('visit:task-audit-summary:414'), ({ ...entry })));
    let fileOrderedEvents = navigationQuery
        ? navigationRawEvents(navigationQuery) as Readonly<Record<string, unknown>>[] : readNativeFileOrderedEvents();
    const aggregate = buildNativeAggregateAudit(options, fileOrderedEvents, taskMetadata, inspectReviewHistory, navigationQuery);
    if (aggregate) return aggregate;
    let compileEvents = events;
    if (navigationQuery?.ordered) {
        const passed = navigationLatestEvent(navigationQuery, 'COMPILE_GATE_PASSED', true);
        const failed = navigationLatestEvent(navigationQuery, 'COMPILE_GATE_FAILED', true);
        const latest = passed && failed ? (navigationEventSequence(passed) > navigationEventSequence(failed) ? passed : failed) : passed || failed;
        compileEvents = latest ? [latest] : [];
    }
    const resolvedCompileCycle = resolveTaskCycleBindingSnapshot(safeTaskId, compileEvents, repoRoot, reviewsRoot);
    const preflightForLifecycle = safeReadJson(path.join(reviewsRoot, `${safeTaskId}-preflight.json`));
    const noOpEvidenceForLifecycle = getNoOpEvidence(
        repoRoot,
        safeTaskId,
        path.join(reviewsRoot, `${safeTaskId}-no-op.json`),
        path.join(reviewsRoot, `${safeTaskId}-preflight.json`)
    );
    const auditedNoOpLifecycle = isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflightForLifecycle || {})
        && noOpEvidenceForLifecycle.evidence_status === 'PASS';
    // Native no-op filtering relies on separately copied raw record identities; preserve that boundary.
    if (auditedNoOpLifecycle && navigationQuery) fileOrderedEvents = readNativeFileOrderedEvents();
    const currentCycle = auditedNoOpLifecycle ? null : resolvedCompileCycle;
    const noOpEventSha256 = auditedNoOpLifecycle
        ? getCurrentNoOpEventSha256(repoRoot, safeTaskId, noOpEvidenceForLifecycle, eventsRoot)
        : null;
    const noOpEvent = noOpEventSha256
        ? fileOrderedEvents.find((event) => {
            countNextStepWork('visit:task-audit-summary:435');
            const integrity = event.integrity && typeof event.integrity === 'object'
                ? event.integrity as Record<string, unknown>
                : null;
            return integrity?.event_sha256 === noOpEventSha256;
        })
        : null;
    let latestTaskEntryIndex = navigationQuery?.latestTaskEntryIndex ?? -1;
    for (let index = navigationQuery ? -1 : fileOrderedEvents.length - 1; index >= 0; index -= 1) {
        countNextStepWork('visit:task-audit-summary:443');
        if (fileOrderedEvents[index].event_type === 'TASK_MODE_ENTERED') {
            latestTaskEntryIndex = index;
            break;
        }
    }
    const cycleEvents = auditedNoOpLifecycle && latestTaskEntryIndex >= 0
        ? countNextStepArrayCopy('visit:task-audit-summary:copy:453', fileOrderedEvents.slice(latestTaskEntryIndex))
        : events;
    const noOpAnchorIndex = noOpEvent ? cycleEvents.indexOf(noOpEvent) : -1;
    const preNoOpLifecycleTypes = new Set([
        'TASK_MODE_ENTERED',
        'RULE_PACK_LOADED',
        'RULE_PACK_LOAD_FAILED',
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'SHELL_SMOKE_PREFLIGHT_RECORDED',
        'PREFLIGHT_CLASSIFIED',
        'PREFLIGHT_FAILED'
    ]);
    const lifecycleEvents = auditedNoOpLifecycle && noOpAnchorIndex >= 0
        ? cycleEvents.filter((event, index) => (countNextStepWork('visit:task-audit-summary:463'), (
            index > noOpAnchorIndex || preNoOpLifecycleTypes.has(String(event.event_type || '').trim().toUpperCase())
        )))
        : cycleEvents;
    const fullSuiteValidationEnabled = resolveFullSuiteValidationRequirementForCurrentCycle(
        events,
        currentCycle,
        repoRoot,
        liveFullSuiteValidationEnabled
    );
    const fullSuiteValidationRequiredForLifecycle = fullSuiteValidationEnabled
        && !isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflightForLifecycle || {});
    const compileGateRequiredForLifecycle = !auditedNoOpLifecycle;
    const projectMemoryImpactEvidence = getProjectMemoryImpactLifecycleEvidence({
        repoRoot,
        taskId: safeTaskId,
        preflightPath: path.join(reviewsRoot, `${safeTaskId}-preflight.json`)
    });
    const hasCurrentProjectMemoryImpactEvent = hasCurrentCycleProjectMemoryImpactEvent(lifecycleEvents, currentCycle, repoRoot);
    const lifecycleQuery = navigationQueryForEvents(lifecycleEvents);
    const hasCompletionPassEvent = lifecycleQuery?.ordered
        ? !!navigationLatestEvent(lifecycleQuery, 'COMPLETION_GATE_PASSED', true)
        : lifecycleEvents.some((event) => (countNextStepWork('visit:task-audit-summary:482'), String(event.event_type || '').trim().toUpperCase() === 'COMPLETION_GATE_PASSED'));
    const projectMemoryImpactRequired = projectMemoryImpactEvidence.required
        && (!hasCompletionPassEvent || hasCurrentProjectMemoryImpactEvent);
    const getWorkspaceStatusSnapshot = reportValue('task-cycle-status', () => getTaskCycleStatusSnapshot(
        repoRoot,
        safeTaskId,
        undefined,
        options.taskQueueEntries
    ));
    const lifecycleGates = getLifecycleGates(
        fullSuiteValidationRequiredForLifecycle,
        projectMemoryImpactRequired,
        compileGateRequiredForLifecycle
    );
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
        lifecycleEvents,
        currentCycle,
        repoRoot
    );
    const gates = countNextStepArrayCopy('visit:task-audit-summary:copy:516', [...lifecycleStatus.gates]);
    const blockers = countNextStepArrayCopy('visit:task-audit-summary:copy:517', [...lifecycleStatus.blockers]);
    if (inspectReviewHistory && ['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(integrityStatus)) {
        blockers.push(...getReviewHistoryIntegrityViolations({ repoRoot, reviewsRoot, taskId: safeTaskId, timelineEvents: events })
            .map(reason => ({ gate: 'review-history-integrity', reason })));
    }
    if (auditedNoOpLifecycle && !noOpEventSha256) {
        blockers.push({
            gate: 'record-no-op',
            reason: 'Current audited no-op evidence has no matching NO_OP_RECORDED event in the active completed task cycle.'
        });
    }
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
    const getChangeMetrics = reportValue('change-metrics', () => buildFinalCloseoutChangeMetrics({
        repoRoot,
        preflightChangedFiles: preflightSummary.changedFiles,
        preflightChangedLinesTotal,
        finalTrackedChangedFiles: changedFiles,
        workspaceSnapshotRequest
    }));
    const getChangedLinesTotal = () => getChangeMetrics().final_tracked_changed_lines_total ?? preflightChangedLinesTotal;
    const finalCloseoutJsonPath = path.join(reviewsRoot, `${safeTaskId}-final-closeout.json`);
    const finalCloseoutMarkdownPath = path.join(reviewsRoot, `${safeTaskId}-final-closeout.md`);
    const finalUserReportPath = path.join(reviewsRoot, `${safeTaskId}-final-user-report.md`);
    const hasCompletionPass = gates.some(
        (g) => (countNextStepWork('visit:task-audit-summary:575'), g.gate === 'completion-gate' && g.status === 'PASS')
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
            compileGateRequired: compileGateRequiredForLifecycle,
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
        const hasRequiredReviews = Object.values(requiredReviews).some((value) => (countNextStepWork('visit:task-audit-summary:652'), value));
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
        const getReviewAttemptSummary = reportValue('review-attempts', () => buildReviewAttemptSummary({
            reviewsRoot,
            taskId: safeTaskId,
            timelineEvents: events,
            currentPreflight: preflight,
            excludedReviewTypes: reviewCycleExcludedReviewTypes
        }));
        const getReviewFindingsAudit = reportValue('review-findings', () => buildReviewFindingsAuditSummary({
            repoRoot,
            reviewsRoot,
            taskId: safeTaskId,
            requiredReviews,
            currentPreflight: preflight,
            timelineEvents: events,
            reviewAttemptSummary: getReviewAttemptSummary(),
            currentCycle,
            reviewIntegrityAttestation,
            timelineIntegrityStatus: integrityStatus,
            currentPreflightSha256: preflightSha256,
            taskQueueEntries: options.taskQueueEntries
        }));
        const getReviewTimingAudit = reportValue('review-timing', () => buildReviewTimingAuditSummary(
            reviewsRoot,
            safeTaskId,
            events,
            repoRoot,
            preflight
        ));
        const reviewCoverageSummary = buildReviewCoverageAuditSummary({
            reviewsRoot,
            taskId: safeTaskId,
            requiredReviews,
            orderedEvents: events,
            taskQueueEntries: options.taskQueueEntries
        });
        return {
            evidence,
            requiredReviewBlockers,
            get reviewAttemptSummary() { return getReviewAttemptSummary(); },
            get reviewFindingsAudit() { return getReviewFindingsAudit(); },
            reviewIntegrityAttestation,
            get reviewTimingAudit() { return getReviewTimingAudit(); },
            reviewCoverageSummary,
            reviewTrustSummary,
            reviewVerdicts
        };
    });
    blockers.push(...auditedChangedFiles.violations.map((reason) => (countNextStepWork('visit:task-audit-summary:717'), ({
        gate: 'doc-impact-gate',
        reason
    }))));
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
        lifecycleEvents,
        currentCycle,
        repoRoot,
        reviewDependencyGraph
    );
    if (completionReviewOrderBlocker) {
        blockers.push(completionReviewOrderBlocker);
    }
    const getTokenEconomy = reportValue('token-economy', () => buildTokenEconomySummary(safeTaskId, events, repoRoot, reviewsRoot));
    const getTaskCycleDiagnostics = reportValue('task-cycle-diagnostics', () => buildTaskCycleDiagnostics({
        taskId: safeTaskId,
        workspaceStatusSnapshot: getWorkspaceStatusSnapshot()
    }));
    const evidence = reviewSnapshot.evidence;
    const hasFailedGate = gates.some((g) => (countNextStepWork('visit:task-audit-summary:757'), g.status === 'FAIL'));
    const failedGateNames = gates.filter((g) => (countNextStepWork('visit:task-audit-summary:758'), g.status === 'FAIL')).map((g) => (countNextStepWork('visit:task-audit-summary:758'), g.gate));
    const hasNonCompletionFailure = failedGateNames.some((gateName) => (countNextStepWork('visit:task-audit-summary:759'), gateName !== 'completion-gate'));
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

    const hasNonCompletionBlockers = blockers.some((blocker) => (countNextStepWork('visit:task-audit-summary:795'), blocker.gate !== 'completion-gate'));
    if (
        pointInTimeSnapshot.status === 'FINALIZATION_IN_FLIGHT'
        && !hasIntegrityFailure
        && !hasNonCompletionBlockers
        && !hasNonCompletionFailure
    ) {
        for (let index = blockers.length - 1; index >= 0; index--) {
            countNextStepWork('visit:task-audit-summary:802');
            if (blockers[index].gate === 'completion-gate') {
                blockers.splice(index, 1);
            }
        }
    }

    let status: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    const reviewsRequired = Object.keys(requiredReviews).some((reviewType) => (countNextStepWork('visit:task-audit-summary:810'), requiredReviews[reviewType]));
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
    const requireSupportingGateCompleteness = navigationQuery?.ordered ? navigationQuery.hasSupportingLifecycleAnchor : events.some((event) =>
        (countNextStepWork('visit:task-audit-summary:825'), supportingLifecycleAnchorEvents.has(String(event.event_type || '')))
    );
    const supportingGateGaps = requireSupportingGateCompleteness
        ? gates
            .filter((gate) => {
                countNextStepWork('visit:task-audit-summary:829');
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
            .map((gate) => (countNextStepWork('visit:task-audit-summary:829'), gate.gate))
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

    const getCommitPresentation = reportValue('commit-presentation', () => {
    const commitGuardEnabled = getWorkspaceStatusSnapshot().enforceNoAutoCommit === true;
    const committableChangedFiles = resolveCommittableChangedFiles(repoRoot, workspaceSnapshotRequest);
    const rawCommitCandidateChangedFiles = committableChangedFiles == null
        ? changedFiles.filter((changedFile) => (countNextStepWork('visit:task-audit-summary:864'), !isLocalControlPlaneCommitPath(changedFile)))
        : committableChangedFiles;
    const commitCandidateChangedFiles = filterCommitCandidatesToTaskOwnedPreflightScope(
        repoRoot,
        preflight,
        rawCommitCandidateChangedFiles
    );
    const localCommitEnabled = resolveLocalCommitAvailability(repoRoot).enabled;
    const commitCommand = buildCommitCommandSuggestion(
        commitCandidateChangedFiles.length > 0
            ? commitCandidateChangedFiles
            : filterCommitCandidatesToTaskOwnedPreflightScope(repoRoot, preflight, changedFiles),
        taskMetadata,
        commitGuardEnabled,
        { taskId: safeTaskId, requireOperatorConfirmation: !localCommitEnabled }
    );
    const commitRequired = commitCandidateChangedFiles.length > 0;
    const commitCommandTemplate = commitRequired
        ? commitCommand.template
        : 'No commit command required.';
    const commitCommandSuggestion = commitRequired
        ? commitCommand.suggestion
        : NO_COMMIT_REQUIRED_MESSAGE;
    const commitQuestionText = commitRequired
        ? localCommitEnabled ? '' : 'Do you want me to commit now? (yes/no)'
        : NO_COMMIT_CONFIRMATION_MESSAGE;
    
        return { commitCommandTemplate, commitCommandSuggestion, commitQuestionText };
    });
    const {
        reviewVerdicts,
        reviewTrustSummary,
        reviewIntegrityAttestation
    } = reviewSnapshot;
    const reviewIntegrityBlocker = hasCompletionPass && reviewIntegrityAttestation.completion_allowed === false
        ? {
            gate: 'review-integrity',
            reason: reviewIntegrityAttestation.reason
        }
        : null;
    if (reviewIntegrityBlocker && !blockers.some((blocker) => (countNextStepWork('visit:task-audit-summary:906'), blocker.gate === reviewIntegrityBlocker.gate))) {
        blockers.push(reviewIntegrityBlocker);
    }
    if (status === 'PASS' && reviewIntegrityBlocker) {
        status = 'BLOCKED';
    }
    const getOptionalSkillsSummary = reportValue('optional-skills', () => {
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
        return optionalSkillsSummary;
    });
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
                    ? `Completion gate passed, but final closeout is blocked: ${blockers.map((blocker) => (countNextStepWork('visit:task-audit-summary:944'), blocker.reason)).join(' ')}`
                : 'Completion gate has not passed cleanly yet; do not deliver the task-complete final report contract.',
        get required_order() { return [
            'short agent-authored summary of what changed',
            'verbatim Garda final user report',
            ...(getCommitPresentation().commitQuestionText === 'Do you want me to commit now? (yes/no)'
                ? ['Do you want me to commit now? (yes/no)'] : [])
        ]; },
        implementation_summary_requirements: implementationSummaryRequirements,
        get commit_command_template() { return getCommitPresentation().commitCommandTemplate; },
        get commit_command_suggestion() { return getCommitPresentation().commitCommandSuggestion; },
        get commit_question() { return getCommitPresentation().commitQuestionText; }
    };
    const getFinalCloseout = reportValue('closeout', () => buildFinalCloseoutArtifact({
        repoRoot,
        eventsRoot,
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
        changedLinesTotal: getChangedLinesTotal(),
        changeMetrics: getChangeMetrics(),
        scopeCategory,
        reviewTrustSummary,
        reviewTimingAudit: reviewSnapshot.reviewTimingAudit,
        reviewIntegrityAttestation,
        reviewAttemptSummary: reviewSnapshot.reviewAttemptSummary,
        reviewFindingsAudit: reviewSnapshot.reviewFindingsAudit,
        reviewCoverageSummary: reviewSnapshot.reviewCoverageSummary,
        optionalSkillsSummary: getOptionalSkillsSummary(),
        fullSuiteValidation,
        fullSuiteValidationRequiredForLifecycle,
        reviewExecutionPolicyMode,
        projectMemoryImpactEvidence,
        orchestratorDefectCapture,
        tokenEconomy: getTokenEconomy(),
        taskCycleDiagnostics: getTaskCycleDiagnostics(),
        workspaceStatusSnapshot: getWorkspaceStatusSnapshot(),
        commitCommandTemplate: getCommitPresentation().commitCommandTemplate,
        commitCommandSuggestion: getCommitPresentation().commitCommandSuggestion,
        workspaceSnapshotRequest
    }));

    const result: TaskAuditSummaryResult = {
        task_id: safeTaskId,
        get generated_utc() { return getFinalCloseout().generated_utc; },
        status,
        events_count: orderedEvents.count,
        first_event_utc: orderedEvents.firstEventUtc,
        last_event_utc: orderedEvents.lastEventUtc,
        integrity_status: integrityStatus,
        gates,
        changed_files: changedFiles,
        changed_files_count: changedFilesCount,
        get changed_lines_total() { return getChangedLinesTotal(); },
        required_reviews: requiredReviews,
        scope_category: scopeCategory,
        profile_review_decisions: profileReviewDecisions,
        evidence,
        blockers,
        point_in_time_snapshot: pointInTimeSnapshot,
        get task_cycle_diagnostics() { return getTaskCycleDiagnostics(); },
        get review_attempt_summary() { return reviewSnapshot.reviewAttemptSummary; },
        get review_findings_audit() { return reviewSnapshot.reviewFindingsAudit; },
        review_coverage_summary: reviewSnapshot.reviewCoverageSummary,
        final_report_contract: finalReportContract,
        get final_closeout() { return getFinalCloseout(); }
    };
    if (lazyReports) {
        const materializedLedgerPath = path.join(path.dirname(reviewsRoot), 'task-ledger', `${safeTaskId}.json`);
        if (hasCompletionPass && !hasMaterializedFinalCloseoutArtifact && !fs.existsSync(finalUserReportPath) && !fs.existsSync(materializedLedgerPath)) {
            countNextStepWork('terminal_legacy_without_materialized_result');
            getFinalCloseout(); // A6 permits eager legacy computation when no materialized result exists.
        }
        bindNavigationAuditCycle(result, currentCycle ? {
            preflight_path: currentCycle.preflight_path, preflight_sha256: currentCycle.preflight_sha256,
            compile_gate_timestamp: currentCycle.compile_gate_timestamp
        } : auditedNoOpLifecycle && noOpEvidenceForLifecycle.evidence_status === 'PASS' && noOpEventSha256
            && noOpEvidenceForLifecycle.evidence_hash && noOpEvidenceForLifecycle.preflight_path && noOpEvidenceForLifecycle.preflight_sha256 ? {
                preflight_path: noOpEvidenceForLifecycle.preflight_path, preflight_sha256: noOpEvidenceForLifecycle.preflight_sha256,
                compile_gate_timestamp: null, no_op_sha256: noOpEvidenceForLifecycle.evidence_hash, no_op_event_sha256: noOpEventSha256
            } : null);
        return result;
    }
    return { ...result, final_report_contract: { ...result.final_report_contract } };
}
