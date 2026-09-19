import { TASK_QUEUE_FILENAME } from '../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists } from '../core/filesystem';
import { getBundleCliCommand, PRIMARY_CLI_NAME, resolveBundleName } from '../core/constants';
import { readTaskQueueStatusToken } from '../core/active-task-state';
import { parseCanonicalActiveTaskQueue } from '../core/task-md-table';
import { isCanonicalTaskId } from '../core/task-ids';
import {
    getMandatoryEvents,
    hasSatisfiedLifecycleEvent,
    resolveFullSuiteValidationRequirementForTaskEvents
} from '../gate-runtime/lifecycle-event-types';
import {
    readTaskTimelineJsonlEntries,
    scanTaskEventLocks,
    taskTimelineAwareFileExists,
    type TaskEventLockHealth
} from '../gate-runtime/task-events';
import { withTaskTimelineFileReadSnapshot } from '../gate-runtime/timeline/task-timeline-read-snapshot';
import { scanReviewArtifactLocks, type ReviewArtifactLockHealth } from '../gate-runtime/review-artifacts';
import { scanCompletionGateFinalizationLocks, type FinalizationLockInspection } from '../gates/locks/finalization-lock';
import { loadFullSuiteValidationConfig } from '../gates/full-suite/full-suite-validation';
import { detectCodeChanged } from '../gates/preflight/preflight-code-change';

export interface TaskStatus {
    id: string;
    status: string;
    priority: string;
    area: string;
    title: string;
    owner: string;
    updated: string;
    profile: string;
    notes: string;
}

export interface BlockingReason {
    reason_code: string;
    description: string;
    remediation: string;
}

export interface WhyBlockedTask {
    task: TaskStatus;
    blocking_reasons: BlockingReason[];
    missing_events: string[];
    failed_gates: string[];
    timeline_status: string;
    related_locks: TaskEventLockHealth[];
    related_review_locks?: ReviewArtifactLockHealth[];
    related_completion_finalization_locks?: FinalizationLockInspection[];
}

export interface WhyBlockedResult {
    has_blocked_tasks: boolean;
    blocked_tasks: WhyBlockedTask[];
    in_progress_tasks: WhyBlockedTask[];
    lock_observations: TaskEventLockHealth[];
    review_lock_observations?: ReviewArtifactLockHealth[];
    completion_finalization_lock_observations?: FinalizationLockInspection[];
    summary_lines: string[];
}

function parseTaskMd(taskMdPath: string): TaskStatus[] {
    const tasks: TaskStatus[] = [];

    if (!pathExists(taskMdPath)) {
        return tasks;
    }

    let content: string;
    try {
        content = fs.readFileSync(taskMdPath, 'utf8');
    } catch {
        return tasks;
    }

    for (const row of parseCanonicalActiveTaskQueue(content).rows) {
        const id = row.taskId;
        if (!isCanonicalTaskId(id)) {
            continue;
        }
        tasks.push({
            id: id,
            status: readTaskQueueStatusToken(row.status) || row.status.trim().toUpperCase(),
            priority: row.priority,
            area: row.area,
            title: row.title,
            owner: row.owner,
            updated: row.updated,
            profile: row.profile,
            notes: row.notes
        });
    }

    return tasks;
}

interface TimelineEventsSnapshot {
    events: string[];
    exists: boolean;
}

function readTimelineEvents(timelinePath: string): TimelineEventsSnapshot {
    const eventTypes: string[] = [];

    return withTaskTimelineFileReadSnapshot(timelinePath, () => {
        if (!taskTimelineAwareFileExists(timelinePath)) {
            return { events: eventTypes, exists: false };
        }

        const entries = readTaskTimelineJsonlEntries(timelinePath);

        for (const timelineEntry of entries) {
            const parsed = timelineEntry.record;
            if (!parsed) {
                continue;
            }
            try {
                const eventType = String(parsed.event_type || '').trim().toUpperCase();
                if (eventType) {
                    eventTypes.push(eventType);
                }
            } catch {
                // Malformed record, skip
            }
        }

        return { events: eventTypes, exists: true };
    });
}

function getFailedGates(events: string[]): string[] {
    const failKeys = ['COMPILE_GATE_FAILED', 'REVIEW_GATE_FAILED', 'COMPLETION_GATE_FAILED',
        'FULL_SUITE_VALIDATION_FAILED',
        'PREFLIGHT_FAILED', 'RULE_PACK_LOAD_FAILED', 'DOC_IMPACT_ASSESSMENT_FAILED'];
    return failKeys.filter(function (k) { return events.includes(k); });
}

function detectBlockingReasons(
    task: TaskStatus,
    events: string[],
    missingEvents: string[],
    failedGates: string[],
    relatedLocks: TaskEventLockHealth[],
    relatedReviewLocks: ReviewArtifactLockHealth[],
    relatedCompletionFinalizationLocks: FinalizationLockInspection[]
): BlockingReason[] {
    const reasons: BlockingReason[] = [];

    // Parse blocked_reason_code from Notes column
    const notesText = task.notes || '';
    const blockedMatch = notesText.match(/blocked_reason_code\s*[=:]\s*([A-Z_0-9]+)/i);
    if (blockedMatch) {
        reasons.push({
            reason_code: blockedMatch[1].toUpperCase(),
            description: `Explicit blocked reason code recorded in TASK.md: ${blockedMatch[1]}`,
            remediation: `Resolve the '${blockedMatch[1]}' condition and update the task status to resume.`
        });
    }

    // Task mode not entered
    if (!events.includes('TASK_MODE_ENTERED')) {
        reasons.push({
            reason_code: 'TASK_MODE_NOT_ENTERED',
            description: 'enter-task-mode gate was never run for this task.',
            remediation: `Run: ${getBundleCliCommand()} gate enter-task-mode --task-id "${task.id}" ...`
        });
    }

    // Rule pack evidence missing
    if (events.includes('TASK_MODE_ENTERED') && !events.includes('RULE_PACK_LOADED')) {
        reasons.push({
            reason_code: 'RULE_PACK_NOT_LOADED',
            description: 'load-rule-pack gate was not run after entering task mode.',
            remediation: `Run: ${getBundleCliCommand()} gate load-rule-pack --task-id "${task.id}" --stage "TASK_ENTRY" --loaded-rule-file "<rule-file>"`
        });
    }

    // Compile failed
    if (failedGates.includes('COMPILE_GATE_FAILED')) {
        reasons.push({
            reason_code: 'COMPILE_GATE_FAILED',
            description: 'Build failed during compile gate.',
            remediation: `Fix compile errors, run the configured compile/build/type-check command if a local debug pass is needed, then rerun: ${getBundleCliCommand()} gate compile-gate --task-id "${task.id}" --preflight-path "${resolveBundleName()}/runtime/reviews/${task.id}-preflight.json".`
        });
    }

    // Review gate failed
    if (failedGates.includes('REVIEW_GATE_FAILED')) {
        reasons.push({
            reason_code: 'REVIEW_GATE_FAILED',
            description: 'Required review(s) returned FAILED verdict.',
            remediation: 'Check runtime/reviews/' + task.id + '-*.md for findings. Fix blocking issues and rerun reviews.'
        });
    }

    // Completion failed
    if (failedGates.includes('COMPLETION_GATE_FAILED')) {
        reasons.push({
            reason_code: 'COMPLETION_GATE_FAILED',
            description: 'Completion gate failed — lifecycle evidence or review artifacts incomplete.',
            remediation: `Run: ${getBundleCliCommand()} gate completion-gate --task-id "${task.id}" and resolve each listed failure.`
        });
    }

    if (failedGates.includes('FULL_SUITE_VALIDATION_FAILED')) {
        reasons.push({
            reason_code: 'FULL_SUITE_VALIDATION_FAILED',
            description: 'Mandatory full-suite validation failed.',
            remediation: `Fix the configured full-suite command failures and rerun: ${getBundleCliCommand()} gate full-suite-validation --task-id "${task.id}" ...`
        });
    }

    // Missing events
    if (missingEvents.length > 0) {
        reasons.push({
            reason_code: 'TIMELINE_INCOMPLETE',
            description:
                `Task timeline is missing ${missingEvents.length} mandatory event(s): ${missingEvents.join(', ')}. ` +
                'This is a task-cycle stall diagnostic; workspace readiness is evaluated separately.',
            remediation: 'Re-run the appropriate gate commands to emit the missing events.'
        });
    }

    for (const lock of relatedLocks) {
        const ownerPidText = lock.owner_pid === null ? 'unknown' : String(lock.owner_pid);
        const ownerHostText = lock.owner_hostname || 'unknown';
        if (lock.status === 'STALE') {
            reasons.push({
                reason_code: 'STALE_TASK_EVENT_LOCK',
                description: `Task-event lock '${lock.lock_name}' is stale (${lock.stale_reason || 'unknown reason'}) and can block timeline writes for this task.`,
                remediation: `Run '${PRIMARY_CLI_NAME} doctor --target-root "." --cleanup-stale-locks --dry-run' first, then rerun without '--dry-run' if the candidate list is correct.`
            });
            continue;
        }
        reasons.push({
            reason_code: 'ACTIVE_TASK_EVENT_LOCK',
            description: `Task-event lock '${lock.lock_name}' is currently held by PID ${ownerPidText} on ${ownerHostText}; gate writes may block until it is released.`,
            remediation: `Wait for the owning process to finish or terminate PID ${ownerPidText} safely if it is hung. Do not delete live task-event locks manually.`
        });
    }

    for (const lock of relatedReviewLocks) {
        const ownerPidText = lock.owner_pid === null ? 'unknown' : String(lock.owner_pid);
        const ownerHostText = lock.owner_hostname || 'unknown';
        const artifactLabel = lock.artifact_type || path.basename(lock.artifact_path);
        if (lock.status === 'STALE') {
            reasons.push({
                reason_code: 'STALE_REVIEW_ARTIFACT_LOCK',
                description: `Review-artifact lock '${lock.lock_name}' for '${artifactLabel}' is stale (${lock.stale_reason || 'unknown reason'}) and can block runtime/reviews writes for this task.`,
                remediation: `Run '${PRIMARY_CLI_NAME} doctor --target-root "." --cleanup-stale-locks --dry-run' first, then rerun without '--dry-run' if the review-artifact lock candidate list is correct.`
            });
            continue;
        }
        reasons.push({
            reason_code: 'ACTIVE_REVIEW_ARTIFACT_LOCK',
            description: `Review-artifact lock '${lock.lock_name}' for '${artifactLabel}' is currently held by PID ${ownerPidText} on ${ownerHostText}; runtime/reviews writes may block until it is released.`,
            remediation: `Wait for the owning process to finish or terminate PID ${ownerPidText} safely if it is hung. Do not delete live review-artifact locks manually.`
        });
    }

    for (const lock of relatedCompletionFinalizationLocks) {
        const ownerPidText = lock.owner_pid === null ? 'unknown' : String(lock.owner_pid);
        const ownerHostText = lock.owner_hostname || 'unknown';
        if (lock.stale) {
            reasons.push({
                reason_code: 'STALE_COMPLETION_FINALIZATION_LOCK',
                description: `Completion finalization lock '${lock.lock_name}' is stale (${lock.stale_reason || 'unknown reason'}) and can block completion-gate finalization for this task.`,
                remediation: lock.remediation
            });
            continue;
        }
        reasons.push({
            reason_code: 'ACTIVE_COMPLETION_FINALIZATION_LOCK',
            description: `Completion finalization lock '${lock.lock_name}' is currently held by PID ${ownerPidText} on ${ownerHostText}; completion-gate finalization may block until it is released.`,
            remediation: lock.remediation
        });
    }

    return reasons;
}

function analyseTask(
    task: TaskStatus,
    bundlePath: string,
    fullSuiteValidationEnabled: boolean,
    lockObservations: TaskEventLockHealth[],
    reviewLockObservations: ReviewArtifactLockHealth[],
    completionFinalizationLockObservations: FinalizationLockInspection[]
): WhyBlockedTask {
    const timelinePath = path.join(bundlePath, 'runtime', 'task-events', task.id + '.jsonl');
    const timeline = readTimelineEvents(timelinePath);
    const events = timeline.events;

    let timelineStatus = 'MISSING';
    if (timeline.exists) {
        timelineStatus = events.length > 0 ? 'PRESENT' : 'EMPTY';
    }

    const failedGates = getFailedGates(events);

    // Detect code-change from preflight artifact
    let codeChanged = false;
    const preflightPath = path.join(bundlePath, 'runtime', 'reviews', task.id + '-preflight.json');
    if (pathExists(preflightPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            codeChanged = detectCodeChanged(parsed, bundlePath);
        } catch {
            // Ignore
        }
    }

    const fullSuiteValidationRequirement = resolveFullSuiteValidationRequirementForTaskEvents(
        events,
        fullSuiteValidationEnabled
    );
    const mandatory = getMandatoryEvents({
        codeChanged,
        fullSuiteValidationEnabled: fullSuiteValidationRequirement.required
    });
    const missingEvents = mandatory.filter(function (ev) { return !hasSatisfiedLifecycleEvent(events, ev); });
    const relatedLocks = lockObservations.filter(function (lock) {
        return lock.scope === 'aggregate' || lock.task_id === task.id;
    });
    const relatedReviewLocks = reviewLockObservations.filter(function (lock) {
        return lock.task_id === null || lock.task_id === task.id;
    });
    const relatedCompletionFinalizationLocks = completionFinalizationLockObservations.filter(function (lock) {
        return lock.task_id === task.id;
    });

    const blockingReasons = detectBlockingReasons(
        task,
        events,
        missingEvents,
        failedGates,
        relatedLocks,
        relatedReviewLocks,
        relatedCompletionFinalizationLocks
    );

    return {
        task,
        blocking_reasons: blockingReasons,
        missing_events: missingEvents,
        failed_gates: failedGates,
        timeline_status: timelineStatus,
        related_locks: relatedLocks,
        related_review_locks: relatedReviewLocks,
        related_completion_finalization_locks: relatedCompletionFinalizationLocks
    };
}

export function getWhyBlocked(targetRoot: string): WhyBlockedResult {
    const resolvedRoot = path.resolve(targetRoot);
    const bundlePath = path.join(resolvedRoot, resolveBundleName());
    const fullSuiteValidationEnabled = loadFullSuiteValidationConfig(bundlePath).enabled;
    const taskMdPath = path.join(resolvedRoot, TASK_QUEUE_FILENAME);

    const allTasks = parseTaskMd(taskMdPath);
    const lockObservations = pathExists(bundlePath)
        ? scanTaskEventLocks(bundlePath).locks
        : [];
    const reviewLockObservations = pathExists(bundlePath)
        ? scanReviewArtifactLocks(bundlePath).locks
        : [];
    const completionFinalizationLockObservations = pathExists(bundlePath)
        ? scanCompletionGateFinalizationLocks(path.join(bundlePath, 'runtime', 'reviews')).locks
        : [];
    const blocked: WhyBlockedTask[] = [];
    const inProgress: WhyBlockedTask[] = [];

    for (const task of allTasks) {
        if (task.status === 'BLOCKED') {
            blocked.push(analyseTask(
                task,
                bundlePath,
                fullSuiteValidationEnabled,
                lockObservations,
                reviewLockObservations,
                completionFinalizationLockObservations
            ));
        } else if (task.status === 'IN_PROGRESS' || task.status === 'IN_REVIEW') {
            const analysed = analyseTask(
                task,
                bundlePath,
                fullSuiteValidationEnabled,
                lockObservations,
                reviewLockObservations,
                completionFinalizationLockObservations
            );
            if (analysed.blocking_reasons.length > 0 || analysed.missing_events.length > 0 || analysed.failed_gates.length > 0) {
                inProgress.push(analysed);
            }
        }
    }

    const summaryLines: string[] = [];
    if (blocked.length === 0 && inProgress.length === 0) {
        summaryLines.push('No blocked or stalled tasks found.');
        if (lockObservations.length > 0) {
            summaryLines.push(`Task-event locks observed: ${lockObservations.length}.`);
        }
        if (reviewLockObservations.length > 0) {
            summaryLines.push(`Review-artifact locks observed: ${reviewLockObservations.length}.`);
        }
        if (completionFinalizationLockObservations.length > 0) {
            summaryLines.push(`Completion finalization locks observed: ${completionFinalizationLockObservations.length}.`);
        }
        if (allTasks.filter(function (t) { return t.status === 'TODO' || t.status === 'IN_PROGRESS'; }).length === 0) {
            summaryLines.push('All tasks are DONE or queue is empty.');
        }
    } else {
        if (blocked.length > 0) {
            summaryLines.push(`Blocked tasks: ${blocked.length}`);
        }
        if (inProgress.length > 0) {
            summaryLines.push(`In-progress tasks with gate issues: ${inProgress.length}`);
            summaryLines.push('Task-cycle stalls are task-level diagnostics; workspace readiness is reported separately by status.');
        }
        if (lockObservations.length > 0) {
            summaryLines.push(`Task-event locks observed: ${lockObservations.length}.`);
        }
        if (reviewLockObservations.length > 0) {
            summaryLines.push(`Review-artifact locks observed: ${reviewLockObservations.length}.`);
        }
        if (completionFinalizationLockObservations.length > 0) {
            summaryLines.push(`Completion finalization locks observed: ${completionFinalizationLockObservations.length}.`);
        }
        summaryLines.push(`Run: ${PRIMARY_CLI_NAME} doctor explain <FAILURE_ID> for remediation steps.`);
    }

    return {
        has_blocked_tasks: blocked.length > 0 || inProgress.length > 0,
        blocked_tasks: blocked,
        in_progress_tasks: inProgress,
        lock_observations: lockObservations,
        review_lock_observations: reviewLockObservations,
        completion_finalization_lock_observations: completionFinalizationLockObservations,
        summary_lines: summaryLines
    };
}

export function formatWhyBlockedResult(result: WhyBlockedResult): string {
    const lines: string[] = [];
    lines.push('WhyBlocked');
    lines.push('');

    if (result.lock_observations.length > 0) {
        lines.push('Task-Event Locks');
        for (const lock of result.lock_observations) {
            const ageText = lock.age_ms === null ? 'unknown' : `${lock.age_ms}ms`;
            lines.push(
                `  ${lock.lock_name}: ${lock.status} scope=${lock.scope}` +
                (lock.task_id ? ` task=${lock.task_id}` : '') +
                ` age=${ageText} owner_pid=${lock.owner_pid === null ? 'unknown' : lock.owner_pid}`
            );
            lines.push(`    Fix: ${lock.remediation}`);
        }
        lines.push('');
    }

    if ((result.review_lock_observations || []).length > 0) {
        lines.push('Review Artifact Locks');
        for (const lock of result.review_lock_observations || []) {
            const ageText = lock.age_ms === null ? 'unknown' : `${lock.age_ms}ms`;
            lines.push(
                `  ${lock.lock_name}: ${lock.status}` +
                (lock.task_id ? ` task=${lock.task_id}` : '') +
                (lock.artifact_type ? ` artifact=${lock.artifact_type}` : '') +
                ` age=${ageText} owner_pid=${lock.owner_pid === null ? 'unknown' : lock.owner_pid}`
            );
            lines.push(`    Fix: ${lock.remediation}`);
        }
        lines.push('');
    }

    if ((result.completion_finalization_lock_observations || []).length > 0) {
        lines.push('Completion Finalization Locks');
        for (const lock of result.completion_finalization_lock_observations || []) {
            const ageText = lock.age_ms === null ? 'unknown' : `${lock.age_ms}ms`;
            lines.push(
                `  ${lock.lock_name}: ${lock.stale ? 'STALE' : 'ACTIVE'}` +
                ` task=${lock.task_id}` +
                ` age=${ageText}` +
                ` owner_pid=${lock.owner_pid === null ? 'unknown' : lock.owner_pid}` +
                ` owner_host=${lock.owner_hostname || 'unknown'}` +
                ` metadata=${lock.owner_metadata_status}` +
                ` stale_reason=${lock.stale_reason || 'none'}`
            );
            lines.push(`    Fix: ${lock.remediation}`);
        }
        lines.push('');
    }

    if (!result.has_blocked_tasks) {
        for (const line of result.summary_lines) {
            lines.push(line);
        }
        return lines.join('\n');
    }

    function formatAnalysed(analysed: WhyBlockedTask, sectionLabel: string): void {
        const task = analysed.task;
        lines.push(`${sectionLabel}: ${task.id} — ${task.title}`);
        lines.push(`  Status: ${task.status}  |  Priority: ${task.priority}  |  Owner: ${task.owner}`);
        lines.push(`  Timeline: ${analysed.timeline_status}`);

        if (analysed.failed_gates.length > 0) {
            lines.push(`  Failed gates: ${analysed.failed_gates.join(', ')}`);
        }

        if (analysed.related_locks.length > 0) {
            lines.push(`  Related locks: ${analysed.related_locks.map((lock) => `${lock.lock_name}:${lock.status}`).join(', ')}`);
        }

        if ((analysed.related_review_locks || []).length > 0) {
            lines.push(`  Related review locks: ${(analysed.related_review_locks || []).map((lock) => `${lock.lock_name}:${lock.status}`).join(', ')}`);
        }

        if ((analysed.related_completion_finalization_locks || []).length > 0) {
            lines.push(`  Related completion finalization locks: ${(analysed.related_completion_finalization_locks || []).map((lock) => `${lock.lock_name}:${lock.stale ? 'STALE' : 'ACTIVE'}`).join(', ')}`);
        }

        if (analysed.missing_events.length > 0) {
            lines.push(`  Missing timeline events: ${analysed.missing_events.join(', ')}`);
        }

        if (analysed.blocking_reasons.length > 0) {
            lines.push('  Blocking reasons:');
            for (const reason of analysed.blocking_reasons) {
                lines.push(`    [${reason.reason_code}] ${reason.description}`);
                lines.push(`      Fix: ${reason.remediation}`);
            }
        } else {
            lines.push('  No specific blocking reason detected — check timeline and review artifacts manually.');
        }

        lines.push('');
    }

    for (const analysed of result.blocked_tasks) {
        formatAnalysed(analysed, 'BLOCKED');
    }

    for (const analysed of result.in_progress_tasks) {
        formatAnalysed(analysed, 'STALLED');
    }

    for (const line of result.summary_lines) {
        lines.push(line);
    }

    return lines.join('\n');
}
