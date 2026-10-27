import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
    formatOptionalQualityChecksRuleSetDiagnostics,
    normalizeOptionalQualityChecksConfig
} from '../../core/workflow-config';
import { resolveBundleRootForTarget } from '../../core/constants';
import { isPathInsideRoot } from '../../core/paths';
import {
    assessQualityChecklistPolicyCompatibility,
    QUALITY_CHECKLIST_ID,
    QUALITY_CHECKLIST_STATUSES,
    type QualityChecklistStatus
} from '../../gates/quality-checklist';
import {
    toPosix
} from '../../gates/shared/helpers';
import { readImmutableOrderedTaskEvents } from '../../gates/task-audit/task-audit-summary-lifecycle';
import {
    resolveWorkspaceSnapshotRequest,
    type WorkspaceSnapshotRequest
} from '../../gates/workspace/workspace-snapshot-cache';
import type {
    ReportArtifactLink,
    ReportQualityGateActionRequiredHistoryEntry,
    ReportQualityGateAnswerSummary,
    ReportQualityGateEffect,
    ReportQualityGateEvidenceStatus,
    ReportTaskQualityChecklist,
    ReportTaskQualityChecklistLatest
} from './types';

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_ACTION_HISTORY = 8;

interface RepoPathReference {
    filePath: string | null;
    staleReason: string | null;
}

interface ScopeBinding {
    changedFilesSha256: string | null;
    scopeSha256: string | null;
    scopeContentSha256: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
        return isRecord(parsed)
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

function toLimitedStringArray(value: unknown, limit: number): string[] {
    return toStringArray(value).slice(0, limit);
}

function toFiniteNumber(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeQualityChecklistStatus(value: unknown): string | null {
    const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/gu, '_');
    return normalized || null;
}

function normalizeKnownQualityChecklistStatus(value: unknown): QualityChecklistStatus | null {
    const normalized = normalizeQualityChecklistStatus(value);
    return normalized && QUALITY_CHECKLIST_STATUSES.includes(normalized as QualityChecklistStatus)
        ? normalized as QualityChecklistStatus
        : null;
}

function normalizePathText(value: unknown): string | null {
    const text = String(value || '').trim();
    return text ? toPosix(text) : null;
}

function normalizeHash(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return HASH_PATTERN.test(text) ? text : null;
}

function resolveRepoPath(repoRoot: string, value: unknown, label: string): RepoPathReference {
    const text = String(value || '').trim();
    if (!text) {
        return { filePath: null, staleReason: null };
    }
    const nativePath = text.replace(/\//gu, path.sep);
    const resolved = path.isAbsolute(nativePath)
        ? nativePath
        : path.resolve(repoRoot, nativePath);
    if (!isPathInsideRoot(repoRoot, resolved)) {
        return {
            filePath: null,
            staleReason: `${label} points outside the repository: ${text}.`
        };
    }
    return { filePath: resolved, staleReason: null };
}

function addHashFreshnessReason(
    reasons: string[],
    label: string,
    reference: RepoPathReference,
    expectedHash: string | null
): void {
    if (reference.staleReason) {
        reasons.push(reference.staleReason);
    }
    if (!reference.filePath || !expectedHash) {
        return;
    }
    const actualHash = fileSha256(reference.filePath);
    if (!actualHash) {
        reasons.push(`${label} is missing: ${toPosix(reference.filePath)}.`);
        return;
    }
    if (actualHash !== expectedHash) {
        reasons.push(`${label} hash changed after the quality checklist was recorded.`);
    }
}

function addWorkflowConfigFreshnessReasons(
    reasons: string[],
    repoRoot: string,
    payload: Record<string, unknown>
): void {
    const workflowConfigReference = String(payload.workflow_config_path || '').trim()
        ? resolveRepoPath(repoRoot, payload.workflow_config_path, 'Workflow config path')
        : {
            filePath: path.join(resolveBundleRootForTarget(repoRoot), 'live', 'config', 'workflow-config.json'),
            staleReason: null
        };
    if (workflowConfigReference.staleReason) {
        reasons.push(workflowConfigReference.staleReason);
    }
    const expectedHash = normalizeHash(payload.workflow_config_sha256);
    if (!workflowConfigReference.filePath || !expectedHash) {
        return;
    }
    const actualHash = fileSha256(workflowConfigReference.filePath);
    if (!actualHash) {
        reasons.push(`Workflow config is missing: ${toPosix(workflowConfigReference.filePath)}.`);
        return;
    }
    if (actualHash === expectedHash) {
        return;
    }
    const workflowConfig = safeReadJsonRecord(workflowConfigReference.filePath);
    const optionalQualityChecks = normalizeOptionalQualityChecksConfig(workflowConfig?.optional_quality_checks);
    const ruleSetDiagnostic = formatOptionalQualityChecksRuleSetDiagnostics(workflowConfig?.optional_quality_checks);
    const evidence = isRecord(payload.changed_file_evidence) ? payload.changed_file_evidence : {};
    const scopeCategory = String(payload.scope_category || evidence.scope_category || '').trim() || null;
    const changedFiles = Array.isArray(evidence.changed_files) ? evidence.changed_files : [];
    const compatibility = assessQualityChecklistPolicyCompatibility({
        currentRules: optionalQualityChecks.rules,
        artifactRules: payload.rules,
        artifactAnswers: payload.answers,
        scopeCategory,
        changedFiles,
        currentRuleSetDiagnostic: ruleSetDiagnostic
    });
    if (!compatibility.compatible) {
        reasons.push(
            `Workflow config effective quality policy changed after the quality checklist was recorded: ${compatibility.reasons[0] || 'policy snapshot is incompatible'}.`
        );
    }
}

function validateTaskQualityChecklistPayload(
    payload: Record<string, unknown> | null,
    taskId: string
): string[] {
    if (!payload) {
        return ['Quality checklist artifact is not a valid JSON object.'];
    }
    const reasons: string[] = [];
    if (!normalizeKnownQualityChecklistStatus(payload.status)) {
        reasons.push(`Unsupported quality checklist status: ${String(payload.status || '').trim() || '<missing>'}.`);
    }
    if (String(payload.checklist_id || '').trim() !== QUALITY_CHECKLIST_ID) {
        reasons.push(`Quality checklist id must be '${QUALITY_CHECKLIST_ID}'.`);
    }
    if (String(payload.task_id || '').trim() !== taskId) {
        reasons.push(`Quality checklist task_id must be '${taskId}'.`);
    }
    if (!String(payload.preflight_path || '').trim()) {
        reasons.push('Quality checklist preflight_path is missing.');
    }
    if (!normalizeHash(payload.preflight_sha256)) {
        reasons.push('Quality checklist preflight_sha256 is missing or invalid.');
    }
    if (!normalizeHash(payload.workflow_config_sha256)) {
        reasons.push('Quality checklist workflow_config_sha256 is missing or invalid.');
    }
    const evidence = isRecord(payload.changed_file_evidence) ? payload.changed_file_evidence : null;
    if (!evidence) {
        reasons.push('Quality checklist changed_file_evidence is missing.');
        return reasons;
    }
    if (!Array.isArray(evidence.changed_files)) {
        reasons.push('Quality checklist changed_file_evidence.changed_files is missing.');
    }
    if (toFiniteNumber(evidence.changed_files_count) === null) {
        reasons.push('Quality checklist changed_file_evidence.changed_files_count is missing.');
    }
    if (!normalizeHash(evidence.changed_files_sha256)) {
        reasons.push('Quality checklist changed_file_evidence.changed_files_sha256 is missing or invalid.');
    }
    if (!normalizeHash(evidence.scope_sha256)) {
        reasons.push('Quality checklist changed_file_evidence.scope_sha256 is missing or invalid.');
    }
    if (!normalizeHash(evidence.scope_content_sha256)) {
        reasons.push('Quality checklist changed_file_evidence.scope_content_sha256 is missing or invalid.');
    }
    return reasons;
}

function artifactScopeBinding(payload: Record<string, unknown> | null): ScopeBinding | null {
    const evidence = payload && isRecord(payload.changed_file_evidence)
        ? payload.changed_file_evidence
        : null;
    if (!evidence) {
        return null;
    }
    return {
        changedFilesSha256: normalizeHash(evidence.changed_files_sha256),
        scopeSha256: normalizeHash(evidence.scope_sha256),
        scopeContentSha256: normalizeHash(evidence.scope_content_sha256)
    };
}

function readPreflightScopeBinding(preflightPath: string | null): ScopeBinding | null {
    if (!preflightPath) {
        return null;
    }
    const preflight = safeReadJsonRecord(preflightPath);
    const metrics = preflight && isRecord(preflight.metrics) ? preflight.metrics : {};
    return {
        changedFilesSha256: normalizeHash(metrics.changed_files_sha256),
        scopeSha256: normalizeHash(metrics.scope_sha256),
        scopeContentSha256: normalizeHash(metrics.scope_content_sha256)
    };
}

function addScopeMismatchReasons(
    reasons: string[],
    artifactBinding: ScopeBinding | null,
    currentBinding: ScopeBinding | null,
    sourceLabel: string
): void {
    if (!artifactBinding || !currentBinding) {
        return;
    }
    if (
        artifactBinding.changedFilesSha256
        && currentBinding.changedFilesSha256
        && artifactBinding.changedFilesSha256 !== currentBinding.changedFilesSha256
    ) {
        reasons.push(`Changed-file list no longer matches ${sourceLabel}.`);
    }
    if (
        artifactBinding.scopeSha256
        && currentBinding.scopeSha256
        && artifactBinding.scopeSha256 !== currentBinding.scopeSha256
    ) {
        reasons.push(`Scope binding no longer matches ${sourceLabel}.`);
    }
    if (
        artifactBinding.scopeContentSha256
        && currentBinding.scopeContentSha256
        && artifactBinding.scopeContentSha256 !== currentBinding.scopeContentSha256
    ) {
        reasons.push(`Scope content no longer matches ${sourceLabel}.`);
    }
}

function readCurrentGitScopeBinding(
    workspaceSnapshotRequest: WorkspaceSnapshotRequest,
    currentPreflightPath: string
): { binding: ScopeBinding | null; sourceLabel: string } {
    const preflight = safeReadJsonRecord(currentPreflightPath);
    const preflightDetectionSource = String(preflight?.detection_source || '').trim().toLowerCase();
    const usesStagedScope = preflightDetectionSource === 'git_staged_only'
        || preflightDetectionSource === 'git_staged_plus_untracked';
    const currentDetectionSource = usesStagedScope
        ? preflightDetectionSource
        : 'git_auto';
    const sourceLabel = usesStagedScope ? 'the current staged git scope' : 'the current git worktree';
    let currentSnapshot: ReturnType<WorkspaceSnapshotRequest['read']>;
    try {
        currentSnapshot = workspaceSnapshotRequest.read(
            currentDetectionSource,
            currentDetectionSource !== 'git_staged_only',
            []
        );
    } catch {
        return { binding: null, sourceLabel };
    }
    if (currentSnapshot.changed_files.length === 0) {
        return { binding: null, sourceLabel };
    }
    return {
        binding: {
            changedFilesSha256: currentSnapshot.changed_files_sha256 || null,
            scopeSha256: null,
            scopeContentSha256: currentSnapshot.scope_content_sha256 || null
        },
        sourceLabel
    };
}

function taskQualityChecklistFreshnessReasons(
    payload: Record<string, unknown> | null,
    repoRoot: string,
    currentPreflightPath: string,
    workspaceSnapshotRequest: WorkspaceSnapshotRequest
): string[] {
    if (!payload) {
        return [];
    }
    const reasons: string[] = [];
    const artifactBinding = artifactScopeBinding(payload);
    const preflightReference = resolveRepoPath(repoRoot, payload.preflight_path, 'Preflight artifact path');
    addHashFreshnessReason(
        reasons,
        'Preflight artifact',
        preflightReference,
        normalizeHash(payload.preflight_sha256)
    );
    addScopeMismatchReasons(
        reasons,
        artifactBinding,
        readPreflightScopeBinding(preflightReference.filePath),
        'the recorded preflight artifact'
    );
    const expectedPreflightSha256 = normalizeHash(payload.preflight_sha256);
    const currentPreflightSha256 = fileSha256(currentPreflightPath);
    if (
        currentPreflightSha256
        && expectedPreflightSha256
        && currentPreflightSha256 !== expectedPreflightSha256
    ) {
        reasons.push('A newer task preflight artifact exists after the quality checklist was recorded.');
    }
    addScopeMismatchReasons(
        reasons,
        artifactBinding,
        readPreflightScopeBinding(currentPreflightPath),
        'the current task preflight scope'
    );
    const currentGitScope = readCurrentGitScopeBinding(workspaceSnapshotRequest, currentPreflightPath);
    addScopeMismatchReasons(
        reasons,
        artifactBinding,
        currentGitScope.binding,
        currentGitScope.sourceLabel
    );
    addWorkflowConfigFreshnessReasons(reasons, repoRoot, payload);
    return reasons;
}

function qualityChecklistEffect(
    status: string | null,
    actionTakenCount: number,
    evidenceStatus: 'current' | 'stale' | 'invalid'
): ReportQualityGateEffect {
    if (evidenceStatus === 'invalid') {
        return 'invalid';
    }
    if (evidenceStatus === 'stale') {
        return 'stale';
    }
    if (status === 'ACTION_REQUIRED') {
        return 'required_rework';
    }
    if (status === 'WARN') {
        return 'warned';
    }
    if (status === 'SKIPPED_DISABLED') {
        return 'disabled';
    }
    if (status === 'SKIPPED_CADENCE') {
        return 'skipped_cadence';
    }
    if (status === 'CONFIG_ERROR') {
        return 'invalid';
    }
    return actionTakenCount > 0 ? 'helped' : 'passed';
}

function qualityChecklistSummary(
    status: string | null,
    effect: ReportQualityGateEffect,
    staleReasons: string[],
    actionRequiredCount: number,
    actionTakenCount: number
): string {
    if (effect === 'invalid') {
        return 'Quality checklist artifact is invalid.';
    }
    if (effect === 'stale') {
        return `Quality checklist artifact is stale: ${staleReasons[0] || 'cycle binding changed'}`;
    }
    if (effect === 'required_rework') {
        return `Quality checklist required rework (${actionRequiredCount} action item(s)).`;
    }
    if (effect === 'warned') {
        return 'Quality checklist passed with warnings.';
    }
    if (effect === 'helped') {
        return `Quality checklist passed after recorded implementation action(s) (${actionTakenCount}).`;
    }
    if (effect === 'disabled') {
        return 'Optional quality checks were disabled for this task.';
    }
    if (effect === 'skipped_cadence') {
        return 'Quality checklist was skipped by the review-failure cadence.';
    }
    return `Quality checklist is current with status ${status || 'PASS'}.`;
}

function qualityChecklistSummaryKey(effect: ReportQualityGateEffect): string {
    if (effect === 'invalid') {
        return 'invalid';
    }
    if (effect === 'stale') {
        return 'stale';
    }
    if (effect === 'required_rework') {
        return 'required_rework';
    }
    if (effect === 'warned') {
        return 'warned';
    }
    if (effect === 'helped') {
        return 'helped';
    }
    if (effect === 'disabled') {
        return 'disabled';
    }
    if (effect === 'skipped_cadence') {
        return 'skipped_cadence';
    }
    return 'passed';
}

function qualityChecklistStaleReasonCode(reason: string): string {
    if (/not a valid JSON object/iu.test(reason)) {
        return 'artifact_json_invalid';
    }
    if (/unsupported quality checklist status/iu.test(reason)) {
        return 'status_unsupported';
    }
    if (/quality checklist id must/iu.test(reason)) {
        return 'checklist_id_mismatch';
    }
    if (/quality checklist task_id must/iu.test(reason)) {
        return 'task_id_mismatch';
    }
    if (/preflight_path is missing/iu.test(reason)) {
        return 'preflight_path_missing';
    }
    if (/preflight_sha256 is missing or invalid/iu.test(reason)) {
        return 'preflight_sha256_invalid';
    }
    if (/workflow_config_sha256 is missing or invalid/iu.test(reason)) {
        return 'workflow_config_sha256_invalid';
    }
    if (/changed_file_evidence is missing/iu.test(reason)) {
        return 'changed_file_evidence_missing';
    }
    if (/changed_file_evidence\.changed_files is missing/iu.test(reason)) {
        return 'changed_files_missing';
    }
    if (/changed_file_evidence\.changed_files_count is missing/iu.test(reason)) {
        return 'changed_files_count_missing';
    }
    if (/changed_file_evidence\.changed_files_sha256 is missing or invalid/iu.test(reason)) {
        return 'changed_files_sha256_invalid';
    }
    if (/changed_file_evidence\.scope_sha256 is missing or invalid/iu.test(reason)) {
        return 'scope_sha256_invalid';
    }
    if (/changed_file_evidence\.scope_content_sha256 is missing or invalid/iu.test(reason)) {
        return 'scope_content_sha256_invalid';
    }
    if (/points outside the repository/iu.test(reason)) {
        return 'path_outside_repository';
    }
    if (/ is missing:/iu.test(reason)) {
        return 'referenced_artifact_missing';
    }
    if (/hash changed after the quality checklist was recorded/iu.test(reason)) {
        return /workflow config/iu.test(reason) ? 'workflow_config_hash_changed' : 'referenced_artifact_hash_changed';
    }
    if (/effective quality policy/iu.test(reason)) {
        return 'effective_policy_changed';
    }
    if (/changed-file list no longer matches/iu.test(reason)) {
        return 'changed_files_mismatch';
    }
    if (/scope binding no longer matches/iu.test(reason)) {
        return 'scope_binding_mismatch';
    }
    if (/scope content no longer matches/iu.test(reason)) {
        return 'scope_content_mismatch';
    }
    if (/newer task preflight artifact exists/iu.test(reason)) {
        return 'newer_preflight_exists';
    }
    return 'unknown';
}

function qualityChecklistStaleReasonCodes(reasons: string[]): string[] {
    return [...new Set(reasons.map(qualityChecklistStaleReasonCode))];
}

function summarizeQualityChecklistAnswers(value: unknown): ReportQualityGateAnswerSummary[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter((entry): entry is Record<string, unknown> => (
            typeof entry === 'object'
            && entry !== null
            && !Array.isArray(entry)
        ))
        .slice(0, 12)
        .map((answer) => ({
            rule_id: String(answer.rule_id || '').trim(),
            status: normalizeQualityChecklistStatus(answer.status) || '',
            answer: String(answer.answer || '').trim().replace(/\s+/gu, ' ').slice(0, 220),
            evidence_files: toLimitedStringArray(answer.evidence_files, 8).map(toPosix),
            actions_taken: toLimitedStringArray(answer.actions_taken, 5),
            actions_required: toLimitedStringArray(answer.actions_required, 5)
        }));
}

function changedFilesPreviewFromQualityChecklist(payload: Record<string, unknown> | null): {
    changedFilesCount: number | null;
    changedFilesPreview: string[];
} {
    const evidence = payload && typeof payload.changed_file_evidence === 'object' && payload.changed_file_evidence !== null && !Array.isArray(payload.changed_file_evidence)
        ? payload.changed_file_evidence as Record<string, unknown>
        : {};
    const changedFilesPreview = toLimitedStringArray(evidence.changed_files, 8).map(toPosix);
    return {
        changedFilesCount: toFiniteNumber(evidence.changed_files_count) ?? changedFilesPreview.length,
        changedFilesPreview
    };
}

function buildTaskQualityChecklistLatest(
    taskId: string,
    repoRoot: string,
    currentPreflightPath: string,
    artifactPath: string,
    workspaceSnapshotRequest: WorkspaceSnapshotRequest
): ReportTaskQualityChecklistLatest | null {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return null;
    }
    const payload = safeReadJsonRecord(artifactPath);
    const actionsTaken = toLimitedStringArray(payload?.actions_taken, 5);
    const actionsRequired = toLimitedStringArray(payload?.actions_required, 5);
    const status = normalizeKnownQualityChecklistStatus(payload?.status);
    const invalidReasons = validateTaskQualityChecklistPayload(payload, taskId);
    const staleReasons = invalidReasons.length > 0
        ? invalidReasons
        : taskQualityChecklistFreshnessReasons(
            payload,
            repoRoot,
            currentPreflightPath,
            workspaceSnapshotRequest
        );
    const evidenceStatus = invalidReasons.length > 0
        ? 'invalid'
        : staleReasons.length > 0
            ? 'stale'
            : 'current';
    const effect = qualityChecklistEffect(status, actionsTaken.length, evidenceStatus);
    const changedFiles = changedFilesPreviewFromQualityChecklist(payload);
    return {
        artifact_path: toPosix(artifactPath),
        artifact_exists: true,
        artifact_sha256: fileSha256(artifactPath),
        evidence_status: evidenceStatus,
        checklist_status: status,
        outcome: String(payload?.outcome || '').trim() || null,
        effect,
        summary_key: qualityChecklistSummaryKey(effect),
        summary: qualityChecklistSummary(status, effect, staleReasons, actionsRequired.length, actionsTaken.length),
        stale_reason_codes: qualityChecklistStaleReasonCodes(staleReasons),
        stale_reasons: staleReasons,
        timestamp_utc: String(payload?.timestamp_utc || '').trim() || null,
        changed_files_count: changedFiles.changedFilesCount,
        changed_files_preview: changedFiles.changedFilesPreview,
        answer_count: Array.isArray(payload?.answers) ? payload.answers.length : 0,
        action_taken_count: Array.isArray(payload?.actions_taken) ? payload.actions_taken.length : actionsTaken.length,
        action_required_count: Array.isArray(payload?.actions_required) ? payload.actions_required.length : actionsRequired.length,
        actions_taken: actionsTaken,
        actions_required: actionsRequired,
        answers: summarizeQualityChecklistAnswers(payload?.answers)
    };
}

function taskQualityChecklistTimelineEvidenceStatus(
    repoRoot: string,
    details: Record<string, unknown>
): ReportQualityGateEvidenceStatus {
    const reference = resolveRepoPath(repoRoot, details.artifact_path, 'Quality checklist artifact path');
    const expectedHash = normalizeHash(details.artifact_hash);
    if (reference.staleReason || !reference.filePath || !expectedHash) {
        return 'stale';
    }
    return fileSha256(reference.filePath) === expectedHash ? 'current' : 'stale';
}

function readTaskQualityChecklistActionHistory(
    taskId: string,
    repoRoot: string,
    eventsRoot: string
): ReportQualityGateActionRequiredHistoryEntry[] {
    const eventPath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fs.existsSync(eventPath) || !fs.statSync(eventPath).isFile()) {
        return [];
    }
    try {
        return readImmutableOrderedTaskEvents(eventPath).events
            .filter((event) => String(event.event_type || '').toUpperCase() === 'QUALITY_CHECKLIST_RECORDED')
            .filter((event) => {
                const details = typeof event.details === 'object' && event.details !== null && !Array.isArray(event.details)
                    ? event.details as Record<string, unknown>
                    : {};
                return normalizeQualityChecklistStatus(details.status ?? event.outcome) === 'ACTION_REQUIRED';
            })
            .reverse()
            .slice(0, MAX_ACTION_HISTORY)
            .map((event) => {
                const details = typeof event.details === 'object' && event.details !== null && !Array.isArray(event.details)
                    ? event.details as Record<string, unknown>
                    : {};
                const artifactPath = normalizePathText(details.artifact_path)
                    || toPosix(path.join(resolveBundleRootForTarget(repoRoot), 'runtime', 'reviews', `${taskId}-quality-checklist.json`));
                return {
                    task_id: taskId,
                    timestamp_utc: String(event.timestamp_utc || '').trim() || null,
                    artifact_path: artifactPath,
                    evidence_status: taskQualityChecklistTimelineEvidenceStatus(repoRoot, details),
                    action_required_count: toFiniteNumber(details.action_required_count) ?? toStringArray(details.actions_required).length,
                    actions_required: toLimitedStringArray(details.actions_required, 5),
                    changed_files_count: toFiniteNumber(details.changed_files_count),
                    changed_files_preview: toLimitedStringArray(details.changed_files_preview ?? details.changed_files, 8).map(toPosix)
                };
            });
    } catch {
        return [];
    }
}

export function buildTaskQualityChecklist(
    taskId: string,
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest
): ReportTaskQualityChecklist {
    const resolvedWorkspaceSnapshotRequest = resolveWorkspaceSnapshotRequest(
        repoRoot,
        workspaceSnapshotRequest
    );
    const artifactPath = path.join(reviewsRoot, `${taskId}-quality-checklist.json`);
    const currentPreflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    return {
        latest: buildTaskQualityChecklistLatest(
            taskId,
            repoRoot,
            currentPreflightPath,
            artifactPath,
            resolvedWorkspaceSnapshotRequest
        ),
        action_required_history: readTaskQualityChecklistActionHistory(taskId, repoRoot, eventsRoot)
    };
}

export function withQualityChecklistArtifactLink(
    artifactLinks: ReportArtifactLink[],
    taskId: string,
    reviewsRoot: string
): ReportArtifactLink[] {
    const artifactPath = path.join(reviewsRoot, `${taskId}-quality-checklist.json`);
    const artifactPathPosix = toPosix(artifactPath);
    if (artifactLinks.some((artifact) => toPosix(artifact.path) === artifactPathPosix)) {
        return artifactLinks;
    }
    return [
        ...artifactLinks,
        {
            kind: 'quality-checklist',
            path: artifactPathPosix,
            exists: fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile(),
            sha256: fileSha256(artifactPath)
        }
    ];
}
