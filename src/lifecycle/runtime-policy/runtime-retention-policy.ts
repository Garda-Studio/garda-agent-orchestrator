import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { rebuildIndex } from '../../gate-runtime/reviews-index';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { readTaskHistoryLedgerScanStatus, type TaskHistoryLedgerScanStatus } from '../../gate-runtime/task-history-ledger';
import { readTimelineSummaryIndex } from '../../gate-runtime/timeline-summary';
import {
    collectRuntimeTaskState,
    readTaskQueueStatusToken
} from '../../core/active-task-state';
import { parseCanonicalActiveTaskQueue } from '../../core/task-md-table';
import {
    assertCanonicalTaskId,
    parseStructuredTaskArtifactTaskId
} from '../../core/task-ids';
import { validateManagedConfigByName } from '../../schemas/config-artifacts';
import {
    queryPerformanceQualifiedTaskActivitySummaries,
    SQLITE_BULK_QUERY_MIN_TASK_EVENT_FILES
} from '../../runtime/sqlite-catalog';
import { isTaskScopedRuntimeCandidateCategory } from '../cleanup/runtime-cleanup-ownership';

export type RuntimeRetentionTier =
    | 'active_evidence'
    | 'compact_ledger_candidate'
    | 'compressed_forensic_candidate';

export type RuntimeRetentionHealthState =
    | 'active'
    | 'healthy_done'
    | 'blocked'
    | 'failed'
    | 'incomplete'
    | 'tampered'
    | 'ambiguous';

export interface RuntimeRetentionPolicyDocument {
    version: number;
    active_tasks: {
        protect_runtime_grace_days: number;
        protect_current_cycle_artifacts: boolean;
    };
    healthy_done: {
        compact_after_days: number;
        require_ledger: boolean;
        retain_task_events_until_ledger_verified: boolean;
    };
    problem_tasks: {
        compress_after_days: number;
        preserve_detailed_evidence: boolean;
    };
    purge: {
        require_confirm: boolean;
    };
    daily_maintenance: {
        enabled: boolean;
        max_tasks_per_run: number;
        eligible_older_than_days: number;
        keep_latest_tasks: number;
        dry_run: boolean;
    };
    [key: string]: unknown;
}

export interface RuntimeRetentionPolicy {
    version: number;
    activeTasks: {
        protectRuntimeGraceDays: number;
        protectCurrentCycleArtifacts: boolean;
    };
    healthyDone: {
        compactAfterDays: number;
        requireLedger: boolean;
        retainTaskEventsUntilLedgerVerified: boolean;
    };
    problemTasks: {
        compressAfterDays: number;
        preserveDetailedEvidence: boolean;
    };
    purge: {
        requireConfirm: boolean;
    };
    dailyMaintenance: {
        enabled: boolean;
        maxTasksPerRun: number;
        eligibleOlderThanDays: number;
        keepLatestTasks: number;
        dryRun: boolean;
    };
}

export interface RuntimeRetentionTaskPreview {
    task_id: string;
    queue_status: string | null;
    health_state: RuntimeRetentionHealthState;
    retention_tier: RuntimeRetentionTier;
    ledger_status: TaskHistoryLedgerScanStatus;
    eligible_now: boolean;
    age_days: number | null;
    threshold_days: number | null;
    latest_artifact_mtime_ms: number | null;
    candidate_categories: string[];
    candidate_count: number;
    reasons: string[];
}

export interface RuntimeRetentionPreviewSummary {
    policy_path: string;
    config_version: number;
    task_count: number;
    eligible_now_count: number;
    tiers: Record<RuntimeRetentionTier, number>;
    health_states: Record<RuntimeRetentionHealthState, number>;
    ledger_statuses: Record<TaskHistoryLedgerScanStatus, number>;
    tasks: RuntimeRetentionTaskPreview[];
}

export interface RuntimeRetentionPreviewOptions {
    queryTaskActivitySummaries?: typeof queryPerformanceQualifiedTaskActivitySummaries;
}

interface CandidateGroup {
    categories: Set<string>;
    count: number;
    newestMtimeMs: number;
}

interface TimelineEvidence {
    latestStatus: string | null;
    hasCompletionPass: boolean;
    hasFailureEvent: boolean;
    hasBlockedEvent: boolean;
    parseFailed: boolean;
}

const DEFAULT_POLICY_DOCUMENT: RuntimeRetentionPolicyDocument = Object.freeze({
    version: 1,
    active_tasks: {
        protect_runtime_grace_days: 7,
        protect_current_cycle_artifacts: true
    },
    healthy_done: {
        compact_after_days: 30,
        require_ledger: true,
        retain_task_events_until_ledger_verified: true
    },
    problem_tasks: {
        compress_after_days: 30,
        preserve_detailed_evidence: true
    },
    purge: {
        require_confirm: false
    },
    daily_maintenance: {
        enabled: false,
        max_tasks_per_run: 25,
        eligible_older_than_days: 30,
        keep_latest_tasks: 0,
        dry_run: false
    }
});

function buildDefaultPolicy(): RuntimeRetentionPolicy {
    return {
        version: DEFAULT_POLICY_DOCUMENT.version,
        activeTasks: {
            protectRuntimeGraceDays: DEFAULT_POLICY_DOCUMENT.active_tasks.protect_runtime_grace_days,
            protectCurrentCycleArtifacts: DEFAULT_POLICY_DOCUMENT.active_tasks.protect_current_cycle_artifacts
        },
        healthyDone: {
            compactAfterDays: DEFAULT_POLICY_DOCUMENT.healthy_done.compact_after_days,
            requireLedger: DEFAULT_POLICY_DOCUMENT.healthy_done.require_ledger,
            retainTaskEventsUntilLedgerVerified: DEFAULT_POLICY_DOCUMENT.healthy_done.retain_task_events_until_ledger_verified
        },
        problemTasks: {
            compressAfterDays: DEFAULT_POLICY_DOCUMENT.problem_tasks.compress_after_days,
            preserveDetailedEvidence: DEFAULT_POLICY_DOCUMENT.problem_tasks.preserve_detailed_evidence
        },
        purge: {
            requireConfirm: DEFAULT_POLICY_DOCUMENT.purge.require_confirm
        },
        dailyMaintenance: {
            enabled: DEFAULT_POLICY_DOCUMENT.daily_maintenance.enabled,
            maxTasksPerRun: DEFAULT_POLICY_DOCUMENT.daily_maintenance.max_tasks_per_run,
            eligibleOlderThanDays: DEFAULT_POLICY_DOCUMENT.daily_maintenance.eligible_older_than_days,
            keepLatestTasks: DEFAULT_POLICY_DOCUMENT.daily_maintenance.keep_latest_tasks,
            dryRun: DEFAULT_POLICY_DOCUMENT.daily_maintenance.dry_run
        }
    };
}

export function resolveRuntimeRetentionPolicyConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'runtime-retention.json');
}

export function readRuntimeRetentionPolicyDocument(bundleRoot: string): RuntimeRetentionPolicyDocument {
    const configPath = resolveRuntimeRetentionPolicyConfigPath(bundleRoot);
    if (!fs.existsSync(configPath)) {
        return JSON.parse(JSON.stringify(DEFAULT_POLICY_DOCUMENT)) as RuntimeRetentionPolicyDocument;
    }

    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return validateManagedConfigByName('runtime-retention', raw) as RuntimeRetentionPolicyDocument;
    } catch {
        return JSON.parse(JSON.stringify(DEFAULT_POLICY_DOCUMENT)) as RuntimeRetentionPolicyDocument;
    }
}

export function loadRuntimeRetentionPolicy(bundleRoot: string): RuntimeRetentionPolicy {
    const document = readRuntimeRetentionPolicyDocument(bundleRoot);
    const defaults = buildDefaultPolicy();
    return {
        version: Number(document.version || defaults.version),
        activeTasks: {
            protectRuntimeGraceDays: Number(document.active_tasks?.protect_runtime_grace_days ?? defaults.activeTasks.protectRuntimeGraceDays),
            protectCurrentCycleArtifacts: Boolean(document.active_tasks?.protect_current_cycle_artifacts ?? defaults.activeTasks.protectCurrentCycleArtifacts)
        },
        healthyDone: {
            compactAfterDays: Number(document.healthy_done?.compact_after_days ?? defaults.healthyDone.compactAfterDays),
            requireLedger: Boolean(document.healthy_done?.require_ledger ?? defaults.healthyDone.requireLedger),
            retainTaskEventsUntilLedgerVerified: Boolean(
                document.healthy_done?.retain_task_events_until_ledger_verified
                ?? defaults.healthyDone.retainTaskEventsUntilLedgerVerified
            )
        },
        problemTasks: {
            compressAfterDays: Number(document.problem_tasks?.compress_after_days ?? defaults.problemTasks.compressAfterDays),
            preserveDetailedEvidence: Boolean(
                document.problem_tasks?.preserve_detailed_evidence
                ?? defaults.problemTasks.preserveDetailedEvidence
            )
        },
        purge: {
            requireConfirm: Boolean(document.purge?.require_confirm ?? defaults.purge.requireConfirm)
        },
        dailyMaintenance: {
            enabled: Boolean(document.daily_maintenance?.enabled ?? defaults.dailyMaintenance.enabled),
            maxTasksPerRun: Number(document.daily_maintenance?.max_tasks_per_run ?? defaults.dailyMaintenance.maxTasksPerRun),
            eligibleOlderThanDays: Number(
                document.daily_maintenance?.eligible_older_than_days
                ?? defaults.dailyMaintenance.eligibleOlderThanDays
            ),
            keepLatestTasks: Number(document.daily_maintenance?.keep_latest_tasks ?? defaults.dailyMaintenance.keepLatestTasks),
            dryRun: Boolean(document.daily_maintenance?.dry_run ?? defaults.dailyMaintenance.dryRun)
        }
    };
}

function parseTaskIdFromTaskEvents(fileName: string): string | null {
    if (!fileName.endsWith('.jsonl') || fileName === 'all-tasks.jsonl') {
        return null;
    }
    try {
        return assertCanonicalTaskId(fileName.slice(0, -'.jsonl'.length));
    } catch {
        return null;
    }
}

function parseTaskIdFromWorkingPlan(fileName: string): string | null {
    if (!fileName.endsWith('.md')) {
        return null;
    }
    try {
        return assertCanonicalTaskId(fileName.slice(0, -'.md'.length));
    } catch {
        return null;
    }
}

function parseTaskIdFromProjectMemoryArtifact(fileName: string): string | null {
    for (const suffix of ['-impact.json', '-update.json']) {
        if (!fileName.endsWith(suffix)) {
            continue;
        }
        try {
            return assertCanonicalTaskId(fileName.slice(0, -suffix.length));
        } catch {
            return null;
        }
    }
    return null;
}

function parseTaskIdFromTaskDirectory(fileName: string): string | null {
    try {
        return assertCanonicalTaskId(fileName);
    } catch {
        return null;
    }
}

function parseTaskIdFromTaskLedgerArtifact(fileName: string): string | null {
    if (!fileName.endsWith('.json')) {
        return null;
    }
    try {
        return assertCanonicalTaskId(fileName.slice(0, -'.json'.length));
    } catch {
        return null;
    }
}

function parseTaskIdFromTmpArtifact(candidatePath: string, fileName: string): string | null {
    try {
        if (assertCanonicalTaskId(fileName)) {
            return fileName;
        }
    } catch {
        // Fall through to structured task artifact parsing.
    }
    if (path.basename(path.dirname(candidatePath)) === 'reviews') {
        return null;
    }
    return parseStructuredTaskArtifactTaskId(fileName);
}

function parseTaskIdFromCandidatePath(
    candidatePath: string,
    category: string,
    indexedReviewTaskIds: ReadonlyMap<string, string> = new Map()
): string | null {
    if (!isTaskScopedRuntimeCandidateCategory(category)) {
        return null;
    }
    const fileName = path.basename(candidatePath);
    switch (category) {
        case 'manual-validation':
        case 'compact':
            return parseTaskIdFromTaskDirectory(fileName);
        case 'reviews':
            return indexedReviewTaskIds.get(fileName) || null;
        case 'task-events':
            return parseTaskIdFromTaskEvents(fileName)
                ?? (fileName.endsWith('.completeness.json')
                    ? parseTaskIdFromTaskEvents(fileName.replace(/\.completeness\.json$/, '.jsonl'))
                    : null);
        case 'plans':
            return parseTaskIdFromWorkingPlan(fileName);
        case 'project-memory':
            return parseTaskIdFromProjectMemoryArtifact(fileName);
        case 'task-ledger':
            return parseTaskIdFromTaskLedgerArtifact(fileName);
        case 'tmp':
            return parseTaskIdFromTmpArtifact(candidatePath, fileName);
        default:
            return null;
    }
}

function scanTimelineEvidence(bundleRoot: string, taskId: string): TimelineEvidence {
    const timelinePath = path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
    if (!fs.existsSync(timelinePath)) {
        return {
            latestStatus: null,
            hasCompletionPass: false,
            hasFailureEvent: false,
            hasBlockedEvent: false,
            parseFailed: false
        };
    }

    const result: TimelineEvidence = {
        latestStatus: null,
        hasCompletionPass: false,
        hasFailureEvent: false,
        hasBlockedEvent: false,
        parseFailed: false
    };

    try {
        const content = fs.readFileSync(timelinePath, 'utf8');
        for (const rawLine of content.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) {
                continue;
            }
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const eventType = String(parsed.event_type || '').trim().toUpperCase();
            if (!eventType) {
                continue;
            }

            if (eventType === 'COMPLETION_GATE_PASSED') {
                result.hasCompletionPass = true;
            }
            if (eventType === 'TASK_BLOCKED' || eventType === 'COMPLETION_GATE_FAILED') {
                result.hasBlockedEvent = true;
            }
            if (eventType.endsWith('_FAILED') || String(parsed.outcome || '').trim().toUpperCase() === 'FAIL') {
                result.hasFailureEvent = true;
            }
            if (eventType === 'STATUS_CHANGED') {
                const details = parsed.details;
                if (details && typeof details === 'object' && !Array.isArray(details)) {
                    const nextStatus = readTaskQueueStatusToken(String((details as Record<string, unknown>).new_status || ''));
                    if (nextStatus) {
                        result.latestStatus = nextStatus;
                    }
                }
            }
        }
    } catch {
        result.parseFailed = true;
    }

    return result;
}

function normalizeAgeDays(ageMs: number): number {
    return Math.floor(ageMs / (24 * 60 * 60 * 1000));
}

export function contributesToRetentionAge(category: string): boolean {
    return category !== 'task-ledger';
}

function classifyTaskPreview(
    bundleRoot: string,
    taskId: string,
    candidateGroup: CandidateGroup,
    policy: RuntimeRetentionPolicy,
    runtimeState: ReturnType<typeof collectRuntimeTaskState>,
    queueStatuses: ReadonlyMap<string, string>
): RuntimeRetentionTaskPreview {
    const queueStatus = queueStatuses.get(taskId) ?? null;

    const activeByRuntime = runtimeState.activeTaskIds.has(taskId);
    const ambiguousByRuntime = runtimeState.ambiguousTaskIds.has(taskId);
    const integrityPath = path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
    const integrityStatus = fs.existsSync(integrityPath)
        ? inspectTaskEventFile(integrityPath, taskId).status
        : 'MISSING';
    const timelineSummary = readTimelineSummaryIndex(path.join(bundleRoot, 'runtime', 'task-events'))?.entries?.[taskId] ?? null;
    const timelineEvidence = scanTimelineEvidence(bundleRoot, taskId);
    const ageDays = candidateGroup.newestMtimeMs > 0
        ? normalizeAgeDays(Date.now() - candidateGroup.newestMtimeMs)
        : null;
    const ledgerStatus = readTaskHistoryLedgerScanStatus(bundleRoot, taskId);

    let healthState: RuntimeRetentionHealthState = 'ambiguous';
    const reasons: string[] = [];

    const hasCompleteDoneEvidence = (
        (queueStatus === 'DONE' || timelineEvidence.hasCompletionPass)
        && timelineSummary?.completeness_status === 'COMPLETE'
    );

    if (integrityStatus !== 'PASS') {
        healthState = 'tampered';
        reasons.push(`Timeline integrity status is ${integrityStatus}.`);
    } else if (activeByRuntime) {
        healthState = 'active';
        reasons.push('Active task evidence is protected.');
    } else if (queueStatus === 'BLOCKED' || timelineEvidence.hasBlockedEvent) {
        healthState = 'blocked';
        reasons.push('Task is blocked or completion failed.');
    } else if (timelineEvidence.hasFailureEvent) {
        healthState = 'failed';
        reasons.push('Timeline contains failed gate or review events.');
    } else if (hasCompleteDoneEvidence) {
        healthState = 'healthy_done';
        reasons.push('Terminal DONE evidence is complete and integrity passed.');
        if (policy.healthyDone.requireLedger && ledgerStatus === 'VERIFIED') {
            reasons.push('Verified task ledger exists for this task.');
        } else if (policy.healthyDone.requireLedger) {
            reasons.push('Heavy artifacts stay authoritative until a ledger exists and is verified.');
        }
    } else if (queueStatus === 'IN_PROGRESS' || queueStatus === 'IN_REVIEW') {
        healthState = 'active';
        reasons.push('Queue status still marks the task as active.');
    } else if (queueStatus === 'DONE' || timelineEvidence.hasCompletionPass) {
        healthState = 'incomplete';
        reasons.push('Terminal task evidence is present but completeness is not COMPLETE.');
    } else if (ambiguousByRuntime || timelineEvidence.parseFailed) {
        healthState = 'ambiguous';
        reasons.push('Runtime state is ambiguous or timeline parsing failed.');
    } else {
        healthState = 'incomplete';
        reasons.push('Task did not reach a verified terminal retention state.');
    }

    let retentionTier: RuntimeRetentionTier;
    let thresholdDays: number | null;
    switch (healthState) {
        case 'active':
            retentionTier = 'active_evidence';
            thresholdDays = policy.activeTasks.protectRuntimeGraceDays;
            break;
        case 'healthy_done':
            retentionTier = 'compact_ledger_candidate';
            thresholdDays = policy.healthyDone.compactAfterDays;
            break;
        default:
            retentionTier = 'compressed_forensic_candidate';
            thresholdDays = policy.problemTasks.compressAfterDays;
            break;
    }

    const ledgerRequirementSatisfied = healthState !== 'healthy_done'
        || !policy.healthyDone.requireLedger
        || ledgerStatus === 'VERIFIED';
    const problemEvidencePreservationSatisfied = retentionTier !== 'compressed_forensic_candidate'
        || !policy.problemTasks.preserveDetailedEvidence;
    const eligibleNow = ageDays !== null
        && thresholdDays !== null
        && ageDays >= thresholdDays
        && healthState !== 'active'
        && ledgerRequirementSatisfied
        && problemEvidencePreservationSatisfied;
    if (retentionTier === 'compressed_forensic_candidate' && policy.problemTasks.preserveDetailedEvidence) {
        reasons.push('Problem task detailed evidence is preserved by policy.');
    }

    return {
        task_id: taskId,
        queue_status: queueStatus,
        health_state: healthState,
        retention_tier: retentionTier,
        ledger_status: ledgerStatus,
        eligible_now: eligibleNow,
        age_days: ageDays,
        threshold_days: thresholdDays,
        latest_artifact_mtime_ms: candidateGroup.newestMtimeMs > 0 ? Math.floor(candidateGroup.newestMtimeMs) : null,
        candidate_categories: Array.from(candidateGroup.categories).sort(),
        candidate_count: candidateGroup.count,
        reasons
    };
}

function readRetentionQueueStatuses(
    targetRoot: string,
    candidateTaskCount: number,
    queryTaskActivitySummaries: typeof queryPerformanceQualifiedTaskActivitySummaries
): Map<string, string> {
    const statuses = new Map<string, string>();
    if (candidateTaskCount >= SQLITE_BULK_QUERY_MIN_TASK_EVENT_FILES) {
        const activityQuery = queryTaskActivitySummaries(targetRoot);
        if (activityQuery.source === 'sqlite') {
            for (const summary of activityQuery.value) {
                const status = readTaskQueueStatusToken(summary.status || '');
                if (status) statuses.set(summary.taskId, status);
            }
            return statuses;
        }
    }

    const taskPath = path.join(targetRoot, TASK_QUEUE_FILENAME);
    if (!fs.existsSync(taskPath)) return statuses;
    try {
        const content = fs.readFileSync(taskPath, 'utf8');
        for (const row of parseCanonicalActiveTaskQueue(content).rows) {
            const status = readTaskQueueStatusToken(row.status);
            if (status) statuses.set(row.taskId, status);
        }
    } catch {
        // Best-effort queue hints only; deletion safety still comes from canonical runtime evidence.
    }
    return statuses;
}

export function buildRuntimeRetentionPreview(
    targetRoot: string,
    bundleRoot: string,
    candidates: ReadonlyArray<{ path: string; category: string }>,
    options: RuntimeRetentionPreviewOptions = {}
): RuntimeRetentionPreviewSummary {
    const policy = loadRuntimeRetentionPolicy(bundleRoot);
    const candidateGroups = new Map<string, CandidateGroup>();
    const reviewTaskIdsByDirectory = new Map<string, ReadonlyMap<string, string>>();
    for (const candidate of candidates) {
        const reviewDirectory = candidate.category === 'reviews'
            ? path.dirname(candidate.path)
            : null;
        let indexedReviewTaskIds: ReadonlyMap<string, string> = new Map();
        if (reviewDirectory) {
            indexedReviewTaskIds = reviewTaskIdsByDirectory.get(reviewDirectory) || new Map();
            if (!reviewTaskIdsByDirectory.has(reviewDirectory)) {
                indexedReviewTaskIds = new Map(
                    rebuildIndex(reviewDirectory).entries.map((entry) => [entry.fileName, entry.taskId])
                );
                reviewTaskIdsByDirectory.set(reviewDirectory, indexedReviewTaskIds);
            }
        }
        const taskId = parseTaskIdFromCandidatePath(
            candidate.path,
            candidate.category,
            indexedReviewTaskIds
        );
        if (!taskId) {
            continue;
        }
        const group = candidateGroups.get(taskId) ?? {
            categories: new Set<string>(),
            count: 0,
            newestMtimeMs: 0
        };
        group.categories.add(candidate.category);
        group.count += 1;
        if (contributesToRetentionAge(candidate.category)) {
            try {
                const stat = fs.statSync(candidate.path);
                group.newestMtimeMs = Math.max(group.newestMtimeMs, stat.mtimeMs);
            } catch {
                // Best-effort age hint only.
            }
        }
        candidateGroups.set(taskId, group);
    }

    const runtimeState = collectRuntimeTaskState(bundleRoot);
    const queueStatuses = readRetentionQueueStatuses(
        targetRoot,
        candidateGroups.size,
        options.queryTaskActivitySummaries ?? queryPerformanceQualifiedTaskActivitySummaries
    );
    const tasks = Array.from(candidateGroups.entries())
        .map(([taskId, group]) => classifyTaskPreview(
            bundleRoot,
            taskId,
            group,
            policy,
            runtimeState,
            queueStatuses
        ))
        .sort((left, right) => left.task_id.localeCompare(right.task_id));

    const tiers: Record<RuntimeRetentionTier, number> = {
        active_evidence: 0,
        compact_ledger_candidate: 0,
        compressed_forensic_candidate: 0
    };
    const healthStates: Record<RuntimeRetentionHealthState, number> = {
        active: 0,
        healthy_done: 0,
        blocked: 0,
        failed: 0,
        incomplete: 0,
        tampered: 0,
        ambiguous: 0
    };
    const ledgerStatuses: Record<TaskHistoryLedgerScanStatus, number> = {
        MISSING: 0,
        VERIFIED: 0,
        INCOMPLETE: 0,
        CONTRADICTORY: 0,
        INVALID: 0
    };

    for (const task of tasks) {
        tiers[task.retention_tier] += 1;
        healthStates[task.health_state] += 1;
        ledgerStatuses[task.ledger_status] += 1;
    }

    return {
        policy_path: resolveRuntimeRetentionPolicyConfigPath(bundleRoot),
        config_version: policy.version,
        task_count: tasks.length,
        eligible_now_count: tasks.filter((task) => task.eligible_now).length,
        tiers,
        health_states: healthStates,
        ledger_statuses: ledgerStatuses,
        tasks
    };
}

export function formatRuntimeRetentionPreviewLines(preview: RuntimeRetentionPreviewSummary): string[] {
    const lines: string[] = [];
    lines.push(`RuntimeRetentionPolicyPath: ${preview.policy_path.replace(/\\/g, '/')}`);
    lines.push(`RuntimeRetentionPreviewTasks: ${preview.task_count}`);
    lines.push(`RuntimeRetentionEligibleNow: ${preview.eligible_now_count}`);
    lines.push(
        'RuntimeRetentionTiers: '
        + `active=${preview.tiers.active_evidence}, `
        + `ledger=${preview.tiers.compact_ledger_candidate}, `
        + `forensic=${preview.tiers.compressed_forensic_candidate}`
    );
    lines.push(
        'RuntimeRetentionLedgerStatus: '
        + `verified=${preview.ledger_statuses.VERIFIED}, `
        + `missing=${preview.ledger_statuses.MISSING}, `
        + `incomplete=${preview.ledger_statuses.INCOMPLETE}, `
        + `contradictory=${preview.ledger_statuses.CONTRADICTORY}, `
        + `invalid=${preview.ledger_statuses.INVALID}`
    );
    lines.push('RuntimeRetentionTiersLegend: active_evidence=preserve, compact_ledger_candidate=ledger-history-after-verified-ledger, compressed_forensic_candidate=compress-heavy-problem-evidence, purge=confirm-only');
    if (preview.tasks.length > 0) {
        const sampleTasks = preview.tasks
            .slice(0, 5)
            .map((task) => `${task.task_id}:${task.health_state}->${task.retention_tier}:${task.ledger_status}${task.eligible_now ? ':eligible' : ''}`);
        lines.push(`RuntimeRetentionSample: ${sampleTasks.join(', ')}`);
    }
    return lines;
}
