import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    normalizeOrchestratorStartBanner,
    ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE
} from '../../core/orchestrator-start-banner';
import {
    assertValidTaskId,
    readTaskTimelineJsonlEntries,
    taskTimelineAwareFileExists,
    withTaskTimelineReadSnapshot
} from '../../gate-runtime/task-events';
import { withTaskTimelineFileReadSnapshot } from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import { fileSha256, joinOrchestratorPath, normalizePath } from '../shared/helpers';
import { normalizeDirtyWorkspaceBaseline } from '../workspace/dirty-worktree-protection';
import { normalizeWorkflowConfigFileHashes } from '../workflow-config/workflow-config-work';
import { validateTaskProfilePolicySnapshot } from '../../policy/task-profile-policy-snapshot';
import {
    TASK_MODE_ENTRY_EXECUTION_PROVIDER_SOURCES,
    TASK_MODE_ENTRY_MODES,
    TASK_MODE_RUNTIME_IDENTITY_STATUSES,
    type TaskModeEntryMode,
    type TaskModeEvidenceResult
} from './task-mode-contracts';
import { normalizeTaskModePathList, resolveTaskModeArtifactPath } from './task-mode-artifact';
import { applyLegacyTaskModeIdentityBackfill, resolveLegacyRouteIdentity } from './task-mode-legacy-identity';

function getTaskTimelinePath(repoRoot: string, taskId: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
}

function getLatestTaskModeTimelineMetadata(repoRoot: string, taskId: string): {
    artifact_path: string | null;
    declares_runtime_identity_metadata: boolean;
    declares_start_banner: boolean;
    start_banner: string | null;
    declares_profile_policy_snapshot: boolean;
    profile_policy_snapshot_hash: string | null;
} {
    const timelinePath = getTaskTimelinePath(repoRoot, taskId);
    return withTaskTimelineReadSnapshot(path.dirname(timelinePath), taskId, () => {
        if (!taskTimelineAwareFileExists(timelinePath)) {
            return {
                artifact_path: null,
                declares_runtime_identity_metadata: false,
                declares_start_banner: false,
                start_banner: null,
                declares_profile_policy_snapshot: false,
                profile_policy_snapshot_hash: null
            };
        }

        const entries = readTaskTimelineJsonlEntries(timelinePath);
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const parsed = entries[index].record;
            if (!parsed) {
                continue;
            }
            try {
                if (String(parsed.event_type || '').trim().toUpperCase() !== 'TASK_MODE_ENTERED') {
                    continue;
                }
                const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                    ? parsed.details as Record<string, unknown>
                    : null;
                const artifactPath = String(details?.artifact_path || details?.artifactPath || '').trim();
                const declaresRuntimeIdentityMetadata = [
                    'canonical_source_of_truth',
                    'execution_provider_source',
                    'reviewer_capability_level',
                    'reviewer_expected_execution_mode',
                    'reviewer_fallback_allowed',
                    'reviewer_fallback_reason_required',
                    'reviewer_subagent_launch_status',
                    'reviewer_subagent_launch_route',
                    'reviewer_subagent_launch_reason',
                    'reviewer_subagent_launch_remediation',
                    'runtime_identity_status',
                    'runtime_identity_violations'
                ].some((key) => Object.prototype.hasOwnProperty.call(details || {}, key));
                const declaresStartBanner = Object.prototype.hasOwnProperty.call(details || {}, 'start_banner');
                const profilePolicySnapshotHash = String(details?.profile_policy_snapshot_hash || '').trim().toLowerCase();
                const validProfilePolicySnapshotHash = /^[a-f0-9]{64}$/u.test(profilePolicySnapshotHash)
                    ? profilePolicySnapshotHash
                    : null;
                return {
                    artifact_path: artifactPath ? normalizePath(artifactPath) : null,
                    declares_runtime_identity_metadata: declaresRuntimeIdentityMetadata,
                    declares_start_banner: declaresStartBanner,
                    start_banner: normalizeOrchestratorStartBanner(details?.start_banner),
                    declares_profile_policy_snapshot: details?.profile_policy_snapshot_required === true
                        || validProfilePolicySnapshotHash !== null,
                    profile_policy_snapshot_hash: validProfilePolicySnapshotHash
                };
            } catch {
                continue;
            }
        }

        return {
            artifact_path: null,
            declares_runtime_identity_metadata: false,
            declares_start_banner: false,
            start_banner: null,
            declares_profile_policy_snapshot: false,
            profile_policy_snapshot_hash: null
        };
    });
}

export function getTaskModeEvidence(repoRoot: string, taskId: string | null, artifactPath = ''): TaskModeEvidenceResult {
    const result: TaskModeEvidenceResult = {
        task_id: taskId,
        evidence_path: null,
        timeline_artifact_path: null,
        timeline_declares_runtime_identity_metadata: false,
        timeline_declares_start_banner: false,
        timeline_start_banner: null,
        evidence_hash: null,
        declares_runtime_identity_metadata: false,
        identity_backfilled_from_legacy: false,
        evidence_status: 'UNKNOWN',
        evidence_outcome: null,
        evidence_task_id: null,
        evidence_source: null,
        entry_mode: null,
        requested_depth: null,
        effective_depth: null,
        requested_depth_source: null,
        effective_depth_source: null,
        task_summary: null,
        orchestrator_work: null,
        workflow_config_work: null,
        start_banner: null,
        provider: null,
        canonical_source_of_truth: null,
        execution_provider_source: null,
        reviewer_capability_level: null,
        reviewer_expected_execution_mode: null,
        reviewer_fallback_allowed: null,
        reviewer_fallback_reason_required: null,
        reviewer_subagent_launch_status: null,
        reviewer_subagent_launch_route: null,
        reviewer_subagent_launch_reason: null,
        reviewer_subagent_launch_remediation: null,
        runtime_identity_status: null,
        runtime_identity_violations: [],
        routed_to: null,
        plan: null,
        markdown_working_plan: null,
        planned_changed_files: [],
        task_profile: null,
        profile_selection_source: null,
        active_profile: null,
        profile_source: null,
        runtime_active_profile: null,
        runtime_profile_source: null,
        profile_policy_snapshot_required: null,
        profile_policy_snapshot: null,
        profile_policy_snapshot_status: 'MISSING',
        profile_policy_snapshot_hash: null,
        profile_policy_snapshot_config_hash: null,
        profile_policy_snapshot_violations: [],
        timeline_declares_profile_policy_snapshot: false,
        timeline_profile_policy_snapshot_hash: null,
        dirty_workspace_baseline: null,
        workflow_config_file_hashes: null,
        workflow_config_compatibility_baseline_files: []
    };

    if (!taskId) {
        result.evidence_status = 'TASK_ID_MISSING';
        return result;
    }

    const resolvedTaskId = assertValidTaskId(taskId);
    const resolvedPath = resolveTaskModeArtifactPath(repoRoot, resolvedTaskId, artifactPath);
    result.evidence_path = normalizePath(resolvedPath);
    const timelineMetadata = getLatestTaskModeTimelineMetadata(repoRoot, resolvedTaskId);
    result.timeline_artifact_path = timelineMetadata.artifact_path;
    result.timeline_declares_runtime_identity_metadata = timelineMetadata.declares_runtime_identity_metadata;
    result.timeline_declares_start_banner = timelineMetadata.declares_start_banner;
    result.timeline_start_banner = timelineMetadata.start_banner;
    result.timeline_declares_profile_policy_snapshot = timelineMetadata.declares_profile_policy_snapshot;
    result.timeline_profile_policy_snapshot_hash = timelineMetadata.profile_policy_snapshot_hash;

    if (!taskTimelineAwareFileExists(resolvedPath)) {
        result.evidence_status = 'EVIDENCE_FILE_MISSING';
        return result;
    }

    let artifactObject: Record<string, unknown>;
    try {
        artifactObject = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
    } catch {
        result.evidence_status = 'EVIDENCE_INVALID_JSON';
        return result;
    }

    result.evidence_hash = fileSha256(resolvedPath);
    result.declares_runtime_identity_metadata = [
        'canonical_source_of_truth',
        'execution_provider_source',
        'reviewer_capability_level',
        'reviewer_expected_execution_mode',
        'reviewer_fallback_allowed',
        'reviewer_fallback_reason_required',
        'reviewer_subagent_launch_status',
        'reviewer_subagent_launch_route',
        'reviewer_subagent_launch_reason',
        'reviewer_subagent_launch_remediation',
        'runtime_identity_status',
        'runtime_identity_violations'
    ].some((key) => Object.prototype.hasOwnProperty.call(artifactObject, key));
    result.evidence_status = String(artifactObject.status || '').trim().toUpperCase();
    result.evidence_outcome = String(artifactObject.outcome || '').trim().toUpperCase();
    result.evidence_task_id = String(artifactObject.task_id || '').trim() || null;
    result.evidence_source = String(artifactObject.event_source || '').trim() || null;
    result.entry_mode = String(artifactObject.entry_mode || '').trim() || null;
    result.task_summary = String(artifactObject.task_summary || '').trim() || null;
    result.orchestrator_work = typeof artifactObject.orchestrator_work === 'boolean' ? artifactObject.orchestrator_work : null;
    result.workflow_config_work = typeof artifactObject.workflow_config_work === 'boolean' ? artifactObject.workflow_config_work : null;
    result.start_banner = normalizeOrchestratorStartBanner(artifactObject.start_banner);
    result.provider = String(artifactObject.provider || '').trim() || null;
    result.canonical_source_of_truth = String(artifactObject.canonical_source_of_truth || '').trim() || null;
    result.execution_provider_source = String(artifactObject.execution_provider_source || '').trim() || null;
    result.reviewer_capability_level = String(artifactObject.reviewer_capability_level || '').trim() || null;
    result.reviewer_expected_execution_mode = String(artifactObject.reviewer_expected_execution_mode || '').trim() || null;
    result.reviewer_fallback_allowed = typeof artifactObject.reviewer_fallback_allowed === 'boolean'
        ? artifactObject.reviewer_fallback_allowed
        : null;
    result.reviewer_fallback_reason_required = typeof artifactObject.reviewer_fallback_reason_required === 'boolean'
        ? artifactObject.reviewer_fallback_reason_required
        : null;
    result.reviewer_subagent_launch_status = String(artifactObject.reviewer_subagent_launch_status || '').trim() || null;
    result.reviewer_subagent_launch_route = String(artifactObject.reviewer_subagent_launch_route || '').trim() || null;
    result.reviewer_subagent_launch_reason = String(artifactObject.reviewer_subagent_launch_reason || '').trim() || null;
    result.reviewer_subagent_launch_remediation = String(artifactObject.reviewer_subagent_launch_remediation || '').trim() || null;
    result.runtime_identity_status = String(artifactObject.runtime_identity_status || '').trim() || null;
    result.runtime_identity_violations = Array.isArray(artifactObject.runtime_identity_violations)
        ? artifactObject.runtime_identity_violations.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    result.routed_to = String(artifactObject.routed_to || '').trim() || null;
    applyLegacyTaskModeIdentityBackfill(repoRoot, result);

    const rawPlan = artifactObject.plan;
    if (rawPlan && typeof rawPlan === 'object' && !Array.isArray(rawPlan)) {
        const planObj = rawPlan as Record<string, unknown>;
        const planPath = String(planObj.plan_path || '').trim();
        const planSha256 = String(planObj.plan_sha256 || '').trim();
        const planSummary = String(planObj.plan_summary || '').trim();
        if (planPath && planSha256 && planSummary) {
            result.plan = { plan_path: planPath, plan_sha256: planSha256, plan_summary: planSummary };
        }
    }
    const rawMarkdownWorkingPlan = artifactObject.markdown_working_plan;
    if (rawMarkdownWorkingPlan && typeof rawMarkdownWorkingPlan === 'object' && !Array.isArray(rawMarkdownWorkingPlan)) {
        const planObj = rawMarkdownWorkingPlan as Record<string, unknown>;
        const format = String(planObj.format || '').trim();
        const workingPlanPath = String(planObj.working_plan_path || '').trim();
        const workingPlanSha256 = String(planObj.working_plan_sha256 || '').trim();
        const byteCount = Number(planObj.byte_count);
        if (format === 'markdown' && workingPlanPath && workingPlanSha256) {
            result.markdown_working_plan = {
                format,
                working_plan_path: workingPlanPath,
                working_plan_sha256: workingPlanSha256,
                byte_count: Number.isFinite(byteCount) ? Math.max(0, Math.trunc(byteCount)) : 0
            };
        }
    }
    result.planned_changed_files = normalizeTaskModePathList(artifactObject.planned_changed_files);
    result.task_profile = String(artifactObject.task_profile || '').trim() || null;
    result.profile_selection_source = String(artifactObject.profile_selection_source || '').trim() || null;
    result.active_profile = String(artifactObject.active_profile || '').trim() || null;
    result.profile_source = String(artifactObject.profile_source || '').trim() || null;
    result.runtime_active_profile = String(artifactObject.runtime_active_profile || '').trim() || null;
    result.runtime_profile_source = String(artifactObject.runtime_profile_source || '').trim() || null;
    result.profile_policy_snapshot_required = typeof artifactObject.profile_policy_snapshot_required === 'boolean'
        ? artifactObject.profile_policy_snapshot_required
        : null;
    const snapshotValidation = validateTaskProfilePolicySnapshot(artifactObject.profile_policy_snapshot);
    result.profile_policy_snapshot_status = snapshotValidation.status;
    result.profile_policy_snapshot = snapshotValidation.snapshot;
    result.profile_policy_snapshot_hash = snapshotValidation.snapshot?.snapshot_hash || null;
    result.profile_policy_snapshot_config_hash = snapshotValidation.snapshot?.config_hash || null;
    result.profile_policy_snapshot_violations = snapshotValidation.violations;
    result.dirty_workspace_baseline = normalizeDirtyWorkspaceBaseline(
        artifactObject.dirty_workspace_baseline,
        repoRoot
    );
    result.workflow_config_file_hashes = normalizeWorkflowConfigFileHashes(artifactObject.workflow_config_file_hashes);
    result.workflow_config_compatibility_baseline_files = normalizeTaskModePathList(
        artifactObject.workflow_config_compatibility_baseline_files
    );

    const requestedDepth = artifactObject.requested_depth;
    if (typeof requestedDepth === 'number' && Number.isInteger(requestedDepth)) {
        result.requested_depth = requestedDepth;
    }
    const effectiveDepth = artifactObject.effective_depth;
    if (typeof effectiveDepth === 'number' && Number.isInteger(effectiveDepth)) {
        result.effective_depth = effectiveDepth;
    }
    const requestedDepthSource = String(artifactObject.requested_depth_source || '').trim();
    if (
        requestedDepthSource === 'explicit'
        || requestedDepthSource === 'profile_default'
        || requestedDepthSource === 'legacy_default'
    ) {
        result.requested_depth_source = requestedDepthSource;
    }
    const effectiveDepthSource = String(artifactObject.effective_depth_source || '').trim();
    if (effectiveDepthSource === 'explicit' || effectiveDepthSource === 'requested_depth') {
        result.effective_depth_source = effectiveDepthSource;
    }

    if (result.evidence_task_id !== resolvedTaskId) {
        result.evidence_status = 'EVIDENCE_TASK_MISMATCH';
        return result;
    }
    if ((result.evidence_source || '').toLowerCase() !== 'enter-task-mode') {
        result.evidence_status = 'EVIDENCE_SOURCE_INVALID';
        return result;
    }
    if (!result.entry_mode || !TASK_MODE_ENTRY_MODES.includes(result.entry_mode as TaskModeEntryMode)) {
        result.evidence_status = 'EVIDENCE_ENTRY_MODE_INVALID';
        return result;
    }
    if (!result.requested_depth || result.requested_depth < 1 || result.requested_depth > 3) {
        result.evidence_status = 'EVIDENCE_REQUESTED_DEPTH_INVALID';
        return result;
    }
    if (!result.effective_depth || result.effective_depth < 1 || result.effective_depth > 3) {
        result.evidence_status = 'EVIDENCE_EFFECTIVE_DEPTH_INVALID';
        return result;
    }
    if (!result.task_summary || result.task_summary.length < 8) {
        result.evidence_status = 'EVIDENCE_SUMMARY_INVALID';
        return result;
    }
    if (!result.canonical_source_of_truth) {
        result.evidence_status = 'EVIDENCE_CANONICAL_SOURCE_OF_TRUTH_INVALID';
        return result;
    }
    if (
        !result.execution_provider_source
        || !TASK_MODE_ENTRY_EXECUTION_PROVIDER_SOURCES.includes(
            result.execution_provider_source as (typeof TASK_MODE_ENTRY_EXECUTION_PROVIDER_SOURCES)[number]
        )
    ) {
        result.evidence_status = 'EVIDENCE_EXECUTION_PROVIDER_SOURCE_INVALID';
        return result;
    }
    if (
        !result.runtime_identity_status
        || !TASK_MODE_RUNTIME_IDENTITY_STATUSES.includes(
            result.runtime_identity_status as (typeof TASK_MODE_RUNTIME_IDENTITY_STATUSES)[number]
        )
    ) {
        result.evidence_status = 'EVIDENCE_RUNTIME_IDENTITY_STATUS_INVALID';
        return result;
    }
    if (result.runtime_identity_status !== 'resolved') {
        result.evidence_status = 'EVIDENCE_RUNTIME_IDENTITY_NOT_RESOLVED';
        return result;
    }
    if (result.runtime_identity_violations.length > 0) {
        result.evidence_status = 'EVIDENCE_RUNTIME_IDENTITY_VIOLATIONS_PRESENT';
        return result;
    }
    const routeIdentity = resolveLegacyRouteIdentity(result.routed_to);
    if (routeIdentity.provider && result.provider && routeIdentity.provider !== result.provider) {
        result.evidence_status = 'EVIDENCE_PROVIDER_ROUTE_MISMATCH';
        return result;
    }
    if (
        result.timeline_artifact_path
        && result.evidence_path
        && result.timeline_artifact_path.toLowerCase() !== result.evidence_path.toLowerCase()
    ) {
        result.evidence_status = 'EVIDENCE_ARTIFACT_PATH_MISMATCH';
        return result;
    }
    if (
        result.profile_policy_snapshot_required === true
        || result.timeline_declares_profile_policy_snapshot
        || result.profile_policy_snapshot_status !== 'MISSING'
    ) {
        if (result.profile_policy_snapshot_status === 'MISSING') {
            result.evidence_status = 'EVIDENCE_PROFILE_POLICY_SNAPSHOT_MISSING';
            return result;
        }
        if (result.profile_policy_snapshot_status !== 'PASS') {
            result.evidence_status = 'EVIDENCE_PROFILE_POLICY_SNAPSHOT_INVALID';
            return result;
        }
        if (!result.timeline_profile_policy_snapshot_hash) {
            result.evidence_status = 'EVIDENCE_PROFILE_POLICY_SNAPSHOT_TIMELINE_HASH_MISSING';
            return result;
        }
        if (
            result.timeline_profile_policy_snapshot_hash
            && result.profile_policy_snapshot_hash
            && result.timeline_profile_policy_snapshot_hash !== result.profile_policy_snapshot_hash
        ) {
            result.evidence_status = 'EVIDENCE_PROFILE_POLICY_SNAPSHOT_STALE';
            return result;
        }
    }
    if (result.evidence_status === 'PASSED' && result.evidence_outcome === 'PASS') {
        result.evidence_status = 'PASS';
        return result;
    }

    result.evidence_status = 'EVIDENCE_NOT_PASS';
    return result;
}

export function getTaskModeEvidenceViolations(result: TaskModeEvidenceResult): string[] {
    const evidencePath = result.evidence_path || '<missing>';
    switch (result.evidence_status) {
        case 'PASS':
            return [];
        case 'TASK_ID_MISSING':
            return ['Task-mode entry evidence cannot be verified: task id is missing.'];
        case 'EVIDENCE_FILE_MISSING':
            return [
                `Task-mode entry evidence missing: file not found at '${evidencePath}'. ` +
                'Run enter-task-mode before preflight/compile/review/completion gates.'
            ];
        case 'EVIDENCE_INVALID_JSON':
            return [`Task-mode entry evidence is invalid JSON at '${evidencePath}'. Re-run enter-task-mode.`];
        case 'EVIDENCE_TASK_MISMATCH':
            return [
                `Task-mode entry evidence task mismatch. Expected '${result.task_id}', got '${result.evidence_task_id}'.`
            ];
        case 'EVIDENCE_SOURCE_INVALID':
            return [
                `Task-mode entry evidence source is invalid. Expected 'enter-task-mode', got '${result.evidence_source}'.`
            ];
        case 'EVIDENCE_ENTRY_MODE_INVALID':
            return [
                `Task-mode entry evidence has invalid entry_mode '${result.entry_mode}'. ` +
                `Allowed values: ${TASK_MODE_ENTRY_MODES.join(', ')}.`
            ];
        case 'EVIDENCE_REQUESTED_DEPTH_INVALID':
            return ['Task-mode entry evidence is missing a valid requested_depth (1..3).'];
        case 'EVIDENCE_EFFECTIVE_DEPTH_INVALID':
            return ['Task-mode entry evidence is missing a valid effective_depth (1..3).'];
        case 'EVIDENCE_SUMMARY_INVALID':
            return ['Task-mode entry evidence is missing a usable task_summary (>= 8 chars).'];
        case 'EVIDENCE_START_BANNER_INVALID':
            return [
                `Task-mode entry evidence must record one repo-owned start_banner (` +
                `${ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE}), and current-cycle banner evidence cannot be missing or malformed.`
            ];
        case 'EVIDENCE_START_BANNER_MISMATCH':
            return [
                `Task-mode entry evidence start_banner '${result.start_banner || 'missing'}' does not match the ` +
                `TASK_MODE_ENTERED timeline banner '${result.timeline_start_banner || 'missing'}'.`
            ];
        case 'EVIDENCE_CANONICAL_SOURCE_OF_TRUTH_INVALID':
            return ['Task-mode entry evidence is missing canonical_source_of_truth. Re-run enter-task-mode.'];
        case 'EVIDENCE_EXECUTION_PROVIDER_SOURCE_INVALID':
            return [
                `Task-mode entry evidence must record an explicit execution_provider_source (` +
                `${TASK_MODE_ENTRY_EXECUTION_PROVIDER_SOURCES.join(', ')}), got '${result.execution_provider_source || 'missing'}'.`
            ];
        case 'EVIDENCE_RUNTIME_IDENTITY_STATUS_INVALID':
            return [
                `Task-mode entry evidence has invalid runtime_identity_status '${result.runtime_identity_status || 'missing'}'. ` +
                `Allowed values: ${TASK_MODE_RUNTIME_IDENTITY_STATUSES.join(', ')}.`
            ];
        case 'EVIDENCE_RUNTIME_IDENTITY_NOT_RESOLVED':
            return [
                `Task-mode entry evidence must record runtime_identity_status='resolved', got '${result.runtime_identity_status}'. ` +
                'Re-run enter-task-mode with explicit runtime identity; legacy fallback and contradictory runtime identity are invalid.'
            ];
        case 'EVIDENCE_RUNTIME_IDENTITY_VIOLATIONS_PRESENT':
            return [
                `Task-mode entry evidence recorded runtime identity violations: ${result.runtime_identity_violations.join(' ')}`
            ];
        case 'EVIDENCE_PROVIDER_ROUTE_MISMATCH':
            return [
                `Task-mode entry evidence records provider '${result.provider || 'missing'}', ` +
                `but routed_to '${result.routed_to || 'missing'}' identifies a different provider.`
            ];
        case 'EVIDENCE_ARTIFACT_PATH_MISMATCH':
            return [
                `Task-mode entry evidence artifact path mismatch. Timeline recorded '${result.timeline_artifact_path}', ` +
                `but current evidence path is '${evidencePath}'. Re-run downstream gates with the task-mode artifact path recorded by TASK_MODE_ENTERED.`
            ];
        case 'EVIDENCE_PROFILE_POLICY_SNAPSHOT_MISSING':
            return [
                'Task-mode entry evidence is missing the required profile policy snapshot. ' +
                'Re-run enter-task-mode so the effective review policy is locked before preflight.'
            ];
        case 'EVIDENCE_PROFILE_POLICY_SNAPSHOT_INVALID':
            return [
                'Task-mode entry evidence has an invalid profile policy snapshot: ' +
                (result.profile_policy_snapshot_violations.join(' ') || 'snapshot validation failed.')
            ];
        case 'EVIDENCE_PROFILE_POLICY_SNAPSHOT_TIMELINE_HASH_MISSING':
            return [
                'Task-mode entry evidence profile policy snapshot is not bound to the latest TASK_MODE_ENTERED timeline: ' +
                'profile_policy_snapshot_hash is missing from the timeline event. Re-run enter-task-mode so the frozen policy snapshot is recorded in immutable task history.'
            ];
        case 'EVIDENCE_PROFILE_POLICY_SNAPSHOT_STALE':
            return [
                `Task-mode entry evidence profile policy snapshot hash '${result.profile_policy_snapshot_hash || 'missing'}' ` +
                `does not match the latest TASK_MODE_ENTERED timeline hash '${result.timeline_profile_policy_snapshot_hash || 'missing'}'. ` +
                'Re-run downstream gates with the current task-mode artifact.'
            ];
        case 'EVIDENCE_NOT_PASS':
            return [
                `Task-mode entry evidence must be PASSED/PASS, got status='${result.evidence_status}', outcome='${result.evidence_outcome}'.`
            ];
        default:
            return ['Task-mode entry evidence is missing or invalid. Re-run enter-task-mode.'];
    }
}

export function collectTaskTimelineEventTypes(timelinePath: string, errors: string[]): Set<string> {
    const eventTypes = new Set<string>();
    const resolvedPath = path.resolve(String(timelinePath || ''));
    return withTaskTimelineFileReadSnapshot(resolvedPath, () => {
        if (!taskTimelineAwareFileExists(resolvedPath)) {
            errors.push(`Task timeline not found: ${normalizePath(resolvedPath)}`);
            return eventTypes;
        }

        for (const timelineEntry of readTaskTimelineJsonlEntries(resolvedPath)) {
            const parsed = timelineEntry.record;
            if (!parsed) {
                errors.push(`Task timeline contains invalid JSON line: ${normalizePath(resolvedPath)}`);
                break;
            }
            try {
                const eventType = String(parsed.event_type || '').trim().toUpperCase();
                if (eventType) {
                    eventTypes.add(eventType);
                }
            } catch {
                errors.push(`Task timeline contains invalid JSON line: ${normalizePath(resolvedPath)}`);
                break;
            }
        }

        return eventTypes;
    });
}
