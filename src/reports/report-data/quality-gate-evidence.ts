import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPathInsideRoot } from '../../core/paths';
import { formatOptionalQualityChecksRuleSetDiagnostics } from '../../core/workflow-config';
import {
    QUALITY_CHECKLIST_ID,
    QUALITY_CHECKLIST_STATUSES,
    assessQualityChecklistPolicyCompatibility,
    type QualityChecklistStatus
} from '../../gates/quality-checklist';
import {
    fileSha256,
    normalizePath,
    stringSha256,
    toPosix
} from '../../gates/shared/helpers';
import { readImmutableOrderedTaskEvents } from '../../gates/task-audit/task-audit-summary-lifecycle';
import {
    resolveWorkspaceSnapshotRequest,
    type WorkspaceSnapshotRequest
} from '../../gates/workspace/workspace-snapshot-cache';
import type {
    ReportQualityGateActionRequiredHistoryEntry,
    ReportQualityGateAnswerSummary,
    ReportQualityGateEffect,
    ReportQualityGateEvidenceStatus,
    ReportQualityGateLatestCheck,
    ReportQualityGateSkippedRuleSummary,
    ReportWorkflowConfigTab
} from './types';

const QUALITY_CHECKLIST_FILE_SUFFIX = '-quality-checklist.json';
const PREFLIGHT_FILE_SUFFIX = '-preflight.json';
const MAX_QUALITY_CHECKLIST_ARTIFACTS = 80;
const MAX_PREFLIGHT_ARTIFACTS = 80;
const MAX_TASK_EVENT_FILES = 80;
const MAX_ACTION_HISTORY = 8;
const MAX_ACTION_ITEMS = 5;
const MAX_CHANGED_FILES = 8;
const MAX_ANSWERS = 12;
const MAX_SKIPPED_RULES = 12;
const MAX_SUMMARY_CHARS = 220;

interface RuntimeFileCandidate {
    path: string;
    mtimeMs: number;
}

interface QualityChecklistArtifactRecord {
    path: string;
    mtimeMs: number;
    payload: Record<string, unknown> | null;
}

interface QualityChecklistTimelineSummary {
    count: number;
    latestEventUtc: string | null;
}

interface QualityChecklistTimelineEvidence {
    summary: QualityChecklistTimelineSummary;
    actionRequiredHistory: ReportQualityGateActionRequiredHistoryEntry[];
}

interface ScopeBinding {
    changedFilesSha256: string | null;
    scopeSha256: string | null;
    scopeContentSha256: string | null;
}

interface PreflightScopeBinding extends ScopeBinding {
    path: string;
    sha256: string | null;
    mtimeMs: number;
    taskId: string | null;
    detectionSource: string;
    changedFiles: string[];
}

interface CurrentEvidenceContext {
    latestPreflight: PreflightScopeBinding | null;
    currentGitScope: ScopeBinding | null;
}

interface ArtifactReferenceResolution {
    path: string | null;
    staleReason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toText(value: unknown): string {
    return String(value || '').trim();
}

function toTextArray(value: unknown, limit = Number.MAX_SAFE_INTEGER): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map(toText)
        .filter(Boolean)
        .slice(0, limit);
}

function toNumber(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHash(value: unknown): string | null {
    const text = toText(value).toLowerCase();
    return /^[a-f0-9]{64}$/u.test(text) ? text : null;
}

function summarizeText(value: unknown): string {
    const text = toText(value).replace(/\s+/gu, ' ');
    return text.length > MAX_SUMMARY_CHARS
        ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}...`
        : text;
}

function resolveArtifactReference(
    repoRoot: string,
    value: unknown,
    label: string
): ArtifactReferenceResolution {
    const raw = toText(value);
    if (!raw) {
        return { path: null, staleReason: null };
    }
    const nativePath = raw.replace(/\//gu, path.sep);
    const resolved = path.isAbsolute(nativePath)
        ? nativePath
        : path.resolve(repoRoot, nativePath);
    if (!isPathInsideRoot(repoRoot, resolved)) {
        return {
            path: null,
            staleReason: `${label} points outside the repository: ${raw}.`
        };
    }
    return { path: resolved, staleReason: null };
}

function safeFileSha256(filePath: string): string | null {
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
            ? fileSha256(filePath)
            : null;
    } catch {
        return null;
    }
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function isExistingDirectory(rootPath: string): boolean {
    try {
        return fs.existsSync(rootPath) && fs.statSync(rootPath).isDirectory();
    } catch {
        return false;
    }
}

function listRecentFilesBySuffix(
    rootPath: string,
    suffix: string,
    limit: number,
    excludedNames = new Set<string>()
): RuntimeFileCandidate[] {
    if (!isExistingDirectory(rootPath)) {
        return [];
    }
    return fs.readdirSync(rootPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(suffix) && !excludedNames.has(entry.name))
        .map((entry): RuntimeFileCandidate | null => {
            const filePath = path.join(rootPath, entry.name);
            try {
                return {
                    path: filePath,
                    mtimeMs: fs.statSync(filePath).mtimeMs
                };
            } catch {
                return null;
            }
        })
        .filter((entry): entry is RuntimeFileCandidate => entry !== null)
        .sort((left, right) => {
            if (right.mtimeMs !== left.mtimeMs) {
                return right.mtimeMs - left.mtimeMs;
            }
            return right.path.localeCompare(left.path);
        })
        .slice(0, limit);
}

function readQualityChecklistArtifacts(reviewsRoot: string): QualityChecklistArtifactRecord[] {
    return listRecentFilesBySuffix(
        reviewsRoot,
        QUALITY_CHECKLIST_FILE_SUFFIX,
        MAX_QUALITY_CHECKLIST_ARTIFACTS
    )
        .map((candidate) => ({
            path: candidate.path,
            mtimeMs: candidate.mtimeMs,
            payload: readJsonRecord(candidate.path)
        }));
}

function readPreflightScopeBinding(preflightPath: string): PreflightScopeBinding | null {
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return null;
    }
    const payload = readJsonRecord(preflightPath);
    const changedFiles = Array.isArray(payload?.changed_files)
        ? [...new Set(payload.changed_files.map(normalizePath).filter(Boolean))].sort()
        : [];
    const metrics = isRecord(payload?.metrics) ? payload.metrics : {};
    let mtimeMs = 0;
    try {
        mtimeMs = fs.statSync(preflightPath).mtimeMs;
    } catch {
        mtimeMs = 0;
    }
    return {
        path: preflightPath,
        sha256: safeFileSha256(preflightPath),
        mtimeMs,
        taskId: toText(payload?.task_id) || null,
        detectionSource: toText(payload?.detection_source) || 'git_auto',
        changedFiles,
        changedFilesSha256: normalizeHash(metrics.changed_files_sha256) || stringSha256(changedFiles.join('\n')) || null,
        scopeSha256: normalizeHash(metrics.scope_sha256),
        scopeContentSha256: normalizeHash(metrics.scope_content_sha256)
    };
}

function readLatestPreflightScopeBinding(reviewsRoot: string): PreflightScopeBinding | null {
    const preflights = listRecentFilesBySuffix(
        reviewsRoot,
        PREFLIGHT_FILE_SUFFIX,
        MAX_PREFLIGHT_ARTIFACTS
    )
        .map((candidate) => readPreflightScopeBinding(candidate.path))
        .filter((entry): entry is PreflightScopeBinding => entry !== null)
        .sort((left, right) => right.mtimeMs - left.mtimeMs);
    return preflights[0] || null;
}

function readQualityChecklistTimelineEvidence(options: {
    repoRoot: string;
    eventsRoot: string;
}): QualityChecklistTimelineEvidence {
    let count = 0;
    let latestEventUtc: string | null = null;
    const actionRequiredHistory: ReportQualityGateActionRequiredHistoryEntry[] = [];
    const eventFiles = listRecentFilesBySuffix(
        options.eventsRoot,
        '.jsonl',
        MAX_TASK_EVENT_FILES,
        new Set(['all-tasks.jsonl'])
    );
    for (const eventFile of eventFiles) {
        const events = readImmutableOrderedTaskEvents(eventFile.path).events;
        for (const event of events) {
            if (toText(event.event_type).toUpperCase() !== 'QUALITY_CHECKLIST_RECORDED') {
                continue;
            }
            count += 1;
            const timestamp = toText(event.timestamp_utc);
            if (!latestEventUtc || Date.parse(timestamp) > Date.parse(latestEventUtc)) {
                latestEventUtc = timestamp || latestEventUtc;
            }
            const historyEntry = buildActionRequiredHistoryFromTimelineEvent({
                repoRoot: options.repoRoot,
                eventPath: eventFile.path,
                event
            });
            if (historyEntry) {
                actionRequiredHistory.push(historyEntry);
            }
        }
    }
    return {
        summary: { count, latestEventUtc },
        actionRequiredHistory
    };
}

function normalizeChecklistStatus(value: unknown): QualityChecklistStatus | null {
    const normalized = toText(value).toUpperCase().replace(/[\s-]+/gu, '_');
    return QUALITY_CHECKLIST_STATUSES.includes(normalized as QualityChecklistStatus)
        ? normalized as QualityChecklistStatus
        : null;
}

function timelineEventDetails(event: Record<string, unknown>): Record<string, unknown> {
    return isRecord(event.details) ? event.details : {};
}

function resolveTimelineEventEvidenceStatus(
    repoRoot: string,
    details: Record<string, unknown>
): ReportQualityGateEvidenceStatus {
    const artifactPath = resolveArtifactReference(
        repoRoot,
        details.artifact_path,
        'Quality checklist artifact path'
    ).path;
    const expectedArtifactHash = normalizeHash(details.artifact_hash);
    if (!artifactPath || !expectedArtifactHash) {
        return 'stale';
    }
    const currentArtifactHash = safeFileSha256(artifactPath);
    return currentArtifactHash === expectedArtifactHash ? 'current' : 'stale';
}

function buildActionRequiredHistoryFromTimelineEvent(options: {
    repoRoot: string;
    eventPath: string;
    event: Record<string, unknown>;
}): ReportQualityGateActionRequiredHistoryEntry | null {
    const details = timelineEventDetails(options.event);
    if (normalizeChecklistStatus(details.status ?? options.event.outcome) !== 'ACTION_REQUIRED') {
        return null;
    }
    const actionsRequired = toTextArray(details.actions_required, MAX_ACTION_ITEMS);
    const changedFilesPreview = toTextArray(
        details.changed_files_preview ?? details.changed_files,
        MAX_CHANGED_FILES
    ).map(normalizePath);
    return {
        task_id: toText(options.event.task_id) || null,
        timestamp_utc: toText(options.event.timestamp_utc) || null,
        artifact_path: normalizePath(toText(details.artifact_path) || options.eventPath),
        evidence_status: resolveTimelineEventEvidenceStatus(options.repoRoot, details),
        action_required_count: toNumber(details.action_required_count) ?? actionsRequired.length,
        actions_required: actionsRequired,
        changed_files_count: toNumber(details.changed_files_count),
        changed_files_preview: changedFilesPreview
    };
}

function artifactScopeBinding(payload: Record<string, unknown>): ScopeBinding | null {
    if (!isRecord(payload.changed_file_evidence)) {
        return null;
    }
    return {
        changedFilesSha256: normalizeHash(payload.changed_file_evidence.changed_files_sha256),
        scopeSha256: normalizeHash(payload.changed_file_evidence.scope_sha256),
        scopeContentSha256: normalizeHash(payload.changed_file_evidence.scope_content_sha256)
    };
}

function changedFileEvidence(payload: Record<string, unknown>): {
    changedFilesCount: number | null;
    changedFilesPreview: string[];
    changedFilesTruncated: boolean;
} {
    const evidence = isRecord(payload.changed_file_evidence) ? payload.changed_file_evidence : {};
    const changedFiles = toTextArray(evidence.changed_files, MAX_CHANGED_FILES + 1).map(normalizePath);
    const explicitCount = toNumber(evidence.changed_files_count);
    const truncated = changedFiles.length > MAX_CHANGED_FILES;
    return {
        changedFilesCount: explicitCount ?? changedFiles.length,
        changedFilesPreview: changedFiles.slice(0, MAX_CHANGED_FILES),
        changedFilesTruncated: truncated
    };
}

function summarizeAnswers(payload: Record<string, unknown>): ReportQualityGateAnswerSummary[] {
    if (!Array.isArray(payload.answers)) {
        return [];
    }
    return payload.answers
        .filter(isRecord)
        .slice(0, MAX_ANSWERS)
        .map((answer) => ({
            rule_id: toText(answer.rule_id),
            status: toText(answer.status).toUpperCase().replace(/[\s-]+/gu, '_'),
            answer: summarizeText(answer.answer),
            evidence_files: toTextArray(answer.evidence_files, MAX_CHANGED_FILES).map(normalizePath),
            actions_taken: toTextArray(answer.actions_taken, MAX_ACTION_ITEMS),
            actions_required: toTextArray(answer.actions_required, MAX_ACTION_ITEMS)
        }));
}

function summarizeSkippedByScopeRules(payload: Record<string, unknown>): ReportQualityGateSkippedRuleSummary[] {
    if (!Array.isArray(payload.rules)) {
        return [];
    }
    return payload.rules
        .filter((rule): rule is Record<string, unknown> => (
            isRecord(rule)
            && toText(rule.scope_applicability) === 'skipped_by_scope'
        ))
        .slice(0, MAX_SKIPPED_RULES)
        .map((rule) => ({
            rule_id: toText(rule.id),
            title: summarizeText(rule.title),
            excluded_scope_categories: toTextArray(rule.excluded_scope_categories),
            scope_skip_reason: toText(rule.scope_skip_reason) || null
        }))
        .filter((rule) => rule.rule_id);
}

function validateArtifactPayload(payload: Record<string, unknown> | null): string[] {
    if (!payload) {
        return ['Quality checklist artifact is not a valid JSON object.'];
    }
    const reasons: string[] = [];
    const status = normalizeChecklistStatus(payload.status);
    if (!status) {
        reasons.push(`Unsupported quality checklist status: ${toText(payload.status) || '<missing>'}.`);
    }
    if (toText(payload.checklist_id) !== QUALITY_CHECKLIST_ID) {
        reasons.push(`Quality checklist id must be '${QUALITY_CHECKLIST_ID}'.`);
    }
    if (!toText(payload.task_id)) {
        reasons.push('Quality checklist task_id is missing.');
    }
    if (!toText(payload.preflight_path)) {
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
    if (toNumber(evidence.changed_files_count) === null) {
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

function qualityChecklistStaleReasonCode(reason: string): string {
    if (/not a valid JSON object/iu.test(reason)) return 'artifact_json_invalid';
    if (/unsupported quality checklist status/iu.test(reason)) return 'status_unsupported';
    if (/quality checklist id must/iu.test(reason)) return 'checklist_id_mismatch';
    if (/quality checklist task_id/iu.test(reason)) return 'task_id_mismatch';
    if (/preflight_path is missing/iu.test(reason)) return 'preflight_path_missing';
    if (/preflight_sha256 is missing or invalid/iu.test(reason)) return 'preflight_sha256_invalid';
    if (/workflow_config_sha256 is missing or invalid/iu.test(reason)) return 'workflow_config_sha256_invalid';
    if (/changed_file_evidence is missing/iu.test(reason)) return 'changed_file_evidence_missing';
    if (/changed_file_evidence\.changed_files is missing/iu.test(reason)) return 'changed_files_missing';
    if (/changed_file_evidence\.changed_files_count is missing/iu.test(reason)) return 'changed_files_count_missing';
    if (/changed_file_evidence\.changed_files_sha256 is missing or invalid/iu.test(reason)) return 'changed_files_sha256_invalid';
    if (/changed_file_evidence\.scope_sha256 is missing or invalid/iu.test(reason)) return 'scope_sha256_invalid';
    if (/changed_file_evidence\.scope_content_sha256 is missing or invalid/iu.test(reason)) return 'scope_content_sha256_invalid';
    if (/points outside the repository/iu.test(reason)) return 'path_outside_repository';
    if (/ is missing:/iu.test(reason)) return 'referenced_artifact_missing';
    if (/effective quality policy/iu.test(reason)) return 'effective_policy_changed';
    if (/hash changed after the quality checklist was recorded/iu.test(reason)) {
        return /workflow config/iu.test(reason) ? 'workflow_config_hash_changed' : 'referenced_artifact_hash_changed';
    }
    if (/changed-file list no longer matches/iu.test(reason)) return 'changed_files_mismatch';
    if (/scope binding no longer matches/iu.test(reason)) return 'scope_binding_mismatch';
    if (/scope content no longer matches/iu.test(reason)) return 'scope_content_mismatch';
    if (/newer preflight artifact exists/iu.test(reason)) return 'newer_preflight_exists';
    return 'unknown';
}

function qualityChecklistStaleReasonCodes(reasons: string[]): string[] {
    return [...new Set(reasons.map(qualityChecklistStaleReasonCode))];
}

function addScopeMismatchReasons(options: {
    staleReasons: string[];
    artifactBinding: ScopeBinding | null;
    currentBinding: ScopeBinding | null;
    sourceLabel: string;
}): void {
    if (!options.artifactBinding || !options.currentBinding) {
        return;
    }
    if (
        options.artifactBinding.changedFilesSha256
        && options.currentBinding.changedFilesSha256
        && options.artifactBinding.changedFilesSha256 !== options.currentBinding.changedFilesSha256
    ) {
        options.staleReasons.push(`Changed-file list no longer matches ${options.sourceLabel}.`);
    }
    if (
        options.artifactBinding.scopeSha256
        && options.currentBinding.scopeSha256
        && options.artifactBinding.scopeSha256 !== options.currentBinding.scopeSha256
    ) {
        options.staleReasons.push(`Scope binding no longer matches ${options.sourceLabel}.`);
    }
    if (
        options.artifactBinding.scopeContentSha256
        && options.currentBinding.scopeContentSha256
        && options.artifactBinding.scopeContentSha256 !== options.currentBinding.scopeContentSha256
    ) {
        options.staleReasons.push(`Scope content no longer matches ${options.sourceLabel}.`);
    }
}

function buildCurrentEvidenceContext(
    reviewsRoot: string,
    workspaceSnapshotRequest: WorkspaceSnapshotRequest
): CurrentEvidenceContext {
    const latestPreflight = readLatestPreflightScopeBinding(reviewsRoot);
    const preflightDetectionSource = latestPreflight?.detectionSource.trim().toLowerCase() || '';
    const currentDetectionSource = preflightDetectionSource === 'git_staged_only'
        || preflightDetectionSource === 'git_staged_plus_untracked'
        ? preflightDetectionSource
        : 'git_auto';
    let currentSnapshot: ReturnType<WorkspaceSnapshotRequest['read']> | null;
    try {
        currentSnapshot = workspaceSnapshotRequest.read(
            currentDetectionSource,
            currentDetectionSource !== 'git_staged_only',
            []
        );
    } catch {
        currentSnapshot = null;
    }
    const currentGitScope = currentSnapshot && currentSnapshot.changed_files.length > 0
        ? {
            changedFilesSha256: currentSnapshot.changed_files_sha256 || null,
            scopeSha256: null,
            scopeContentSha256: currentSnapshot.scope_content_sha256 || null
        }
        : null;
    return { latestPreflight, currentGitScope };
}

function resolveEvidenceFreshness(options: {
    repoRoot: string;
    workflowConfigTab: ReportWorkflowConfigTab;
    payload: Record<string, unknown> | null;
    currentContext?: CurrentEvidenceContext | null;
    compareCurrentBinding?: boolean;
}): { status: ReportQualityGateEvidenceStatus; staleReasons: string[] } {
    const payload = options.payload;
    const invalidReasons = validateArtifactPayload(payload);
    if (invalidReasons.length > 0) {
        return {
            status: 'invalid',
            staleReasons: invalidReasons
        };
    }
    const validPayload = payload as Record<string, unknown>;
    const staleReasons: string[] = [];
    const artifactBinding = artifactScopeBinding(validPayload);
    const preflightReference = resolveArtifactReference(
        options.repoRoot,
        validPayload.preflight_path,
        'Preflight artifact path'
    );
    if (preflightReference.staleReason) {
        staleReasons.push(preflightReference.staleReason);
    }
    const preflightPath = preflightReference.path;
    const expectedPreflightSha256 = normalizeHash(validPayload.preflight_sha256);
    if (preflightPath && expectedPreflightSha256) {
        const actualPreflightSha256 = safeFileSha256(preflightPath);
        if (!actualPreflightSha256) {
            staleReasons.push(`Preflight artifact is missing: ${toPosix(preflightPath)}.`);
        } else if (actualPreflightSha256 !== expectedPreflightSha256) {
            staleReasons.push('Preflight artifact hash changed after the quality checklist was recorded.');
        }
        const recordedPreflightBinding = readPreflightScopeBinding(preflightPath);
        addScopeMismatchReasons({
            staleReasons,
            artifactBinding,
            currentBinding: recordedPreflightBinding,
            sourceLabel: 'the recorded preflight artifact'
        });
    }

    const workflowConfigReference = resolveArtifactReference(
        options.repoRoot,
        options.workflowConfigTab.config_path,
        'Workflow config path'
    );
    if (workflowConfigReference.staleReason) {
        staleReasons.push(workflowConfigReference.staleReason);
    }
    const workflowConfigPath = workflowConfigReference.path;
    const expectedWorkflowConfigSha256 = normalizeHash(validPayload.workflow_config_sha256);
    if (workflowConfigPath && expectedWorkflowConfigSha256) {
        const actualWorkflowConfigSha256 = safeFileSha256(workflowConfigPath);
        if (!actualWorkflowConfigSha256) {
            staleReasons.push(`Workflow config is missing: ${toPosix(workflowConfigPath)}.`);
        } else if (actualWorkflowConfigSha256 !== expectedWorkflowConfigSha256) {
            const rawWorkflowConfig = readJsonRecord(workflowConfigPath);
            const compatibility = assessQualityChecklistPolicyCompatibility({
                currentRules: options.workflowConfigTab.optional_quality_checks.rules,
                artifactRules: validPayload.rules,
                artifactAnswers: validPayload.answers,
                scopeCategory: toText(validPayload.scope_category)
                    || (isRecord(validPayload.changed_file_evidence) ? toText(validPayload.changed_file_evidence.scope_category) : '')
                    || null,
                changedFiles: isRecord(validPayload.changed_file_evidence)
                    ? toTextArray(validPayload.changed_file_evidence.changed_files)
                    : [],
                currentRuleSetDiagnostic: formatOptionalQualityChecksRuleSetDiagnostics(
                    rawWorkflowConfig?.optional_quality_checks
                )
            });
            if (!compatibility.compatible) {
                staleReasons.push(
                    `Workflow config effective quality policy changed after the quality checklist was recorded: ${compatibility.reasons[0] || 'policy snapshot is incompatible'}.`
                );
            }
        }
    }

    if (options.compareCurrentBinding !== false) {
        const latestPreflight = options.currentContext?.latestPreflight || null;
        if (
            latestPreflight?.sha256
            && expectedPreflightSha256
            && latestPreflight.sha256 !== expectedPreflightSha256
        ) {
            staleReasons.push('A newer preflight artifact exists after the quality checklist was recorded.');
        }
        addScopeMismatchReasons({
            staleReasons,
            artifactBinding,
            currentBinding: latestPreflight,
            sourceLabel: 'the latest preflight scope'
        });
        addScopeMismatchReasons({
            staleReasons,
            artifactBinding,
            currentBinding: options.currentContext?.currentGitScope || null,
            sourceLabel: 'the current git worktree'
        });
    }

    return {
        status: staleReasons.length > 0 ? 'stale' : 'current',
        staleReasons
    };
}

function effectForArtifact(options: {
    payload: Record<string, unknown> | null;
    evidenceStatus: ReportQualityGateEvidenceStatus;
    actionTakenCount: number;
}): ReportQualityGateEffect {
    if (options.evidenceStatus === 'invalid') {
        return 'invalid';
    }
    if (options.evidenceStatus === 'stale') {
        return 'stale';
    }
    const status = normalizeChecklistStatus(options.payload?.status);
    if (!status) {
        return 'invalid';
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
    return options.actionTakenCount > 0 ? 'helped' : 'passed';
}

function summaryForLatestCheck(options: {
    evidenceStatus: ReportQualityGateEvidenceStatus;
    effect: ReportQualityGateEffect;
    checklistStatus: string | null;
    staleReasons: string[];
    actionRequiredCount: number;
    actionTakenCount: number;
}): string {
    if (options.evidenceStatus === 'missing') {
        return 'No quality checklist artifact has been recorded yet.';
    }
    if (options.evidenceStatus === 'disabled') {
        return 'Optional quality checks are disabled; no current checklist artifact is required.';
    }
    if (options.evidenceStatus === 'invalid') {
        return 'Latest quality checklist artifact is invalid.';
    }
    if (options.evidenceStatus === 'stale') {
        return `Latest quality checklist artifact is stale: ${options.staleReasons[0] || 'cycle binding changed'}`;
    }
    if (options.effect === 'required_rework') {
        return `Quality checklist required rework (${options.actionRequiredCount} action item(s)).`;
    }
    if (options.effect === 'warned') {
        return 'Quality checklist passed with warnings.';
    }
    if (options.effect === 'helped') {
        return `Quality checklist passed after recorded implementation action(s) (${options.actionTakenCount}).`;
    }
    if (options.effect === 'skipped_cadence') {
        return 'Quality checklist was skipped by the review-failure cadence.';
    }
    return `Quality checklist is current with status ${options.checklistStatus || 'PASS'}.`;
}

function buildMissingLatestCheck(
    workflowConfigTab: ReportWorkflowConfigTab,
    timelineSummary: QualityChecklistTimelineSummary
): ReportQualityGateLatestCheck {
    const disabled = !workflowConfigTab.optional_quality_checks.enabled;
    return {
        artifact_path: null,
        artifact_exists: false,
        evidence_status: disabled ? 'disabled' : 'missing',
        checklist_status: null,
        outcome: null,
        effect: disabled ? 'disabled' : 'missing',
        summary: disabled
            ? 'Optional quality checks are disabled; no current checklist artifact is required.'
            : 'No quality checklist artifact has been recorded yet.',
        stale_reasons: [],
        task_id: null,
        timestamp_utc: null,
        preflight_path: null,
        preflight_sha256: null,
        workflow_config_sha256: null,
        effective_policy_sha256: null,
        scope_category: null,
        changed_files_count: null,
        changed_files_preview: [],
        changed_files_truncated: false,
        enabled_rule_count: workflowConfigTab.optional_quality_checks.rules.filter((rule) => rule.enabled !== false).length,
        active_rule_count: null,
        skipped_by_scope_rule_count: null,
        skipped_by_scope_rules: [],
        answer_count: 0,
        action_taken_count: 0,
        action_required_count: 0,
        actions_taken: [],
        actions_required: [],
        answers: [],
        timeline_event_count: timelineSummary.count,
        latest_timeline_event_utc: timelineSummary.latestEventUtc
    };
}

function buildLatestCheckFromArtifact(options: {
    repoRoot: string;
    workflowConfigTab: ReportWorkflowConfigTab;
    record: QualityChecklistArtifactRecord;
    timelineSummary: QualityChecklistTimelineSummary;
    currentContext: CurrentEvidenceContext;
}): ReportQualityGateLatestCheck {
    const payload = options.record.payload;
    const freshness = resolveEvidenceFreshness({
        repoRoot: options.repoRoot,
        workflowConfigTab: options.workflowConfigTab,
        payload,
        currentContext: options.currentContext
    });
    const actionsTaken = toTextArray(payload?.actions_taken, MAX_ACTION_ITEMS);
    const actionsRequired = toTextArray(payload?.actions_required, MAX_ACTION_ITEMS);
    const changedFiles = payload ? changedFileEvidence(payload) : {
        changedFilesCount: null,
        changedFilesPreview: [],
        changedFilesTruncated: false
    };
    const enabledRuleCount = Array.isArray(payload?.rules)
        ? payload.rules.filter((rule) => isRecord(rule) && rule.enabled !== false).length
        : 0;
    const activeRuleCount = toNumber(payload?.active_rule_count);
    const skippedByScopeRuleCount = toNumber(payload?.skipped_by_scope_rule_count);
    const scopeCategory = payload
        ? toText(payload.scope_category) || (isRecord(payload.changed_file_evidence) ? toText(payload.changed_file_evidence.scope_category) : '')
        : '';
    const skippedByScopeRules = payload ? summarizeSkippedByScopeRules(payload) : [];
    const effect = effectForArtifact({
        payload,
        evidenceStatus: freshness.status,
        actionTakenCount: actionsTaken.length
    });
    const checklistStatus = normalizeChecklistStatus(payload?.status);
    const summary = summaryForLatestCheck({
        evidenceStatus: freshness.status,
        effect,
        checklistStatus,
        staleReasons: freshness.staleReasons,
        actionRequiredCount: actionsRequired.length,
        actionTakenCount: actionsTaken.length
    });

    return {
        artifact_path: normalizePath(options.record.path),
        artifact_exists: true,
        evidence_status: freshness.status,
        checklist_status: checklistStatus,
        outcome: toText(payload?.outcome) || null,
        effect,
        summary,
        stale_reason_codes: qualityChecklistStaleReasonCodes(freshness.staleReasons),
        stale_reasons: freshness.staleReasons,
        task_id: toText(payload?.task_id) || null,
        timestamp_utc: toText(payload?.timestamp_utc) || null,
        preflight_path: toText(payload?.preflight_path) || null,
        preflight_sha256: toText(payload?.preflight_sha256).toLowerCase() || null,
        workflow_config_sha256: toText(payload?.workflow_config_sha256).toLowerCase() || null,
        effective_policy_sha256: toText(payload?.effective_policy_sha256).toLowerCase()
            || assessQualityChecklistPolicyCompatibility({
                currentRules: options.workflowConfigTab.optional_quality_checks.rules,
                artifactRules: payload?.rules,
                artifactAnswers: payload?.answers,
                scopeCategory: scopeCategory || null,
                changedFiles: isRecord(payload?.changed_file_evidence)
                    ? toTextArray(payload.changed_file_evidence.changed_files)
                    : []
            }).effective_policy_sha256,
        scope_category: scopeCategory || null,
        changed_files_count: changedFiles.changedFilesCount,
        changed_files_preview: changedFiles.changedFilesPreview,
        changed_files_truncated: changedFiles.changedFilesTruncated,
        enabled_rule_count: enabledRuleCount,
        active_rule_count: activeRuleCount,
        skipped_by_scope_rule_count: skippedByScopeRuleCount,
        skipped_by_scope_rules: skippedByScopeRules,
        answer_count: Array.isArray(payload?.answers) ? payload.answers.length : 0,
        action_taken_count: Array.isArray(payload?.actions_taken) ? payload.actions_taken.length : 0,
        action_required_count: Array.isArray(payload?.actions_required) ? payload.actions_required.length : 0,
        actions_taken: actionsTaken,
        actions_required: actionsRequired,
        answers: payload ? summarizeAnswers(payload) : [],
        timeline_event_count: options.timelineSummary.count,
        latest_timeline_event_utc: options.timelineSummary.latestEventUtc
    };
}

function buildActionRequiredHistoryEntry(options: {
    repoRoot: string;
    workflowConfigTab: ReportWorkflowConfigTab;
    record: QualityChecklistArtifactRecord;
}): ReportQualityGateActionRequiredHistoryEntry | null {
    const payload = options.record.payload;
    if (!payload || normalizeChecklistStatus(payload.status) !== 'ACTION_REQUIRED') {
        return null;
    }
    const freshness = resolveEvidenceFreshness({
        repoRoot: options.repoRoot,
        workflowConfigTab: options.workflowConfigTab,
        payload,
        compareCurrentBinding: false
    });
    const changedFiles = changedFileEvidence(payload);
    return {
        task_id: toText(payload.task_id) || null,
        timestamp_utc: toText(payload.timestamp_utc) || null,
        artifact_path: normalizePath(options.record.path),
        evidence_status: freshness.status,
        action_required_count: Array.isArray(payload.actions_required) ? payload.actions_required.length : 0,
        actions_required: toTextArray(payload.actions_required, MAX_ACTION_ITEMS),
        changed_files_count: changedFiles.changedFilesCount,
        changed_files_preview: changedFiles.changedFilesPreview
    };
}

function actionRequiredHistoryKey(entry: ReportQualityGateActionRequiredHistoryEntry): string {
    return [
        entry.task_id || '',
        entry.timestamp_utc || '',
        normalizePath(entry.artifact_path)
    ].join('|');
}

function mergeActionRequiredHistory(
    entries: ReportQualityGateActionRequiredHistoryEntry[]
): ReportQualityGateActionRequiredHistoryEntry[] {
    const seen = new Set<string>();
    return entries
        .sort((left, right) => {
            const leftTimestamp = Date.parse(left.timestamp_utc || '');
            const rightTimestamp = Date.parse(right.timestamp_utc || '');
            const leftSort = Number.isFinite(leftTimestamp) ? leftTimestamp : 0;
            const rightSort = Number.isFinite(rightTimestamp) ? rightTimestamp : 0;
            return rightSort - leftSort;
        })
        .filter((entry) => {
            const key = actionRequiredHistoryKey(entry);
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
}

export function buildQualityGateEvidence(options: {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    workflowConfigTab: ReportWorkflowConfigTab;
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest;
}): {
    latestCheck: ReportQualityGateLatestCheck;
    actionRequiredHistory: ReportQualityGateActionRequiredHistoryEntry[];
} {
    const workspaceSnapshotRequest = resolveWorkspaceSnapshotRequest(
        options.repoRoot,
        options.workspaceSnapshotRequest
    );
    const artifacts = readQualityChecklistArtifacts(options.reviewsRoot);
    const timelineEvidence = readQualityChecklistTimelineEvidence({
        repoRoot: options.repoRoot,
        eventsRoot: options.eventsRoot
    });
    const currentContext = buildCurrentEvidenceContext(
        options.reviewsRoot,
        workspaceSnapshotRequest
    );
    const latestCheck = artifacts[0]
        ? buildLatestCheckFromArtifact({
            repoRoot: options.repoRoot,
            workflowConfigTab: options.workflowConfigTab,
            record: artifacts[0],
            timelineSummary: timelineEvidence.summary,
            currentContext
        })
        : buildMissingLatestCheck(options.workflowConfigTab, timelineEvidence.summary);
    const artifactActionRequiredHistory = artifacts
        .map((record) => buildActionRequiredHistoryEntry({
            repoRoot: options.repoRoot,
            workflowConfigTab: options.workflowConfigTab,
            record
        }))
        .filter((entry): entry is ReportQualityGateActionRequiredHistoryEntry => entry !== null);
    const actionRequiredHistory = mergeActionRequiredHistory([
        ...artifactActionRequiredHistory,
        ...timelineEvidence.actionRequiredHistory
    ])
        .slice(0, MAX_ACTION_HISTORY);
    return { latestCheck, actionRequiredHistory };
}
