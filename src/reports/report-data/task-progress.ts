import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { resolvePathInsideRepo } from '../../core/orchestrator-paths';
import { resolveNextStep, type NextStepResult } from '../../gates/next-step';
import type { TaskAuditSummaryResult } from '../../gates/task-audit/task-audit-summary';
import { toPosix } from '../../gates/shared/helpers';
import type { ReportArtifactLink, ReportTaskDetail } from './types';

type TaskProgress = NonNullable<ReportTaskDetail['progress']>;

const MAX_PROGRESS_STAGES = 32;
const MAX_PROGRESS_TEXT_CHARS = 2048;
const MAX_PROGRESS_COMMAND_CHARS = 16384;
const MAX_PROGRESS_PATH_CHARS = 4096;
const MAX_CLOSEOUT_REFERENCE_BYTES = 1024 * 1024;
const PROGRESS_EVIDENCE_KINDS = Object.freeze(['task-mode', 'preflight', 'compile-gate', 'review-gate']);
const CLOSEOUT_SUFFIXES = Object.freeze(['final-closeout.json', 'final-closeout.md', 'final-user-report.md']);

interface TaskProgressOptions {
    repoRoot: string;
    taskId: string;
    eventsRoot: string;
    reviewsRoot: string;
    taskKnown: boolean;
    audit: TaskAuditSummaryResult | null;
}

function boundedText(value: string): string {
    return value.slice(0, MAX_PROGRESS_TEXT_CHARS);
}

function availableTimestamp(value: string | null | undefined): string | null {
    return value && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
}

function emptyProgress(state: TaskProgress['state'], reason: string, audit: TaskAuditSummaryResult | null): TaskProgress {
    return {
        state,
        navigator_status: null,
        completed_stages: [],
        current_stage: null,
        remaining_stages: [],
        blocker: { gate: null, reason: boundedText(reason) },
        next_action: null,
        final_report: { state: 'unavailable', path: null, exists: false, sha256: null },
        evidence_references: [],
        timing: { first_event_utc: availableTimestamp(audit?.first_event_utc), last_event_utc: availableTimestamp(audit?.last_event_utc) },
        diagnostics: [boundedText(reason)]
    };
}

function confinedPath(candidate: string, root: string): string {
    if (candidate.length > MAX_PROGRESS_PATH_CHARS) throw new Error('Task progress reference path exceeds its response limit.');
    const resolved = resolvePathInsideRepo(candidate, root, { allowMissing: true, enforceInside: true });
    if (!resolved) throw new Error('Task progress reference is outside its allowed root.');
    return resolved;
}

function inspectCloseoutReferences(reviewsRoot: string, taskId: string): boolean {
    let reportExists = false;
    for (const suffix of CLOSEOUT_SUFFIXES) {
        const candidate = confinedPath(path.join(reviewsRoot, `${taskId}-${suffix}`), reviewsRoot);
        if (!fs.existsSync(candidate)) continue;
        const stat = fs.statSync(candidate);
        if (!stat.isFile() || stat.size > MAX_CLOSEOUT_REFERENCE_BYTES) {
            throw new Error('Task closeout reference is not a bounded regular file.');
        }
        if (suffix === 'final-user-report.md') reportExists = true;
    }
    return reportExists;
}

function selectEvidenceReferences(audit: TaskAuditSummaryResult, reviewsRoot: string, taskId: string): ReportArtifactLink[] {
    const references: ReportArtifactLink[] = [];
    for (const kind of PROGRESS_EVIDENCE_KINDS) {
        const candidate = confinedPath(path.join(reviewsRoot, `${taskId}-${kind}.json`), reviewsRoot);
        const evidence = audit.evidence.find(entry => entry.kind === kind && path.resolve(entry.path) === candidate);
        if (!evidence?.exists || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
        references.push({ kind, path: toPosix(candidate), exists: true, sha256: evidence.sha256 });
    }
    return references;
}

function projectProgress(
    audit: TaskAuditSummaryResult,
    next: NextStepResult,
    repoRoot: string,
    reportPath: string,
    reportExists: boolean,
    evidenceReferences: ReportArtifactLink[]
): TaskProgress {
    const currentArtifactKey = next.next_gate === 'classify-change' ? 'preflight' : next.next_gate;
    const currentArtifactMissing = next.missing_artifacts.some(artifact => artifact.key === currentArtifactKey);
    const stale = !!next.invalidation_impact?.stale_artifact_classes.length && !currentArtifactMissing;
    const trusted = audit.integrity_status === 'PASS' && !stale;
    const completed = trusted && reportExists && audit.status === 'PASS' && next.status === 'DONE'
        && !!next.final_report && path.resolve(repoRoot, next.final_report.final_user_report_path) === reportPath;
    const state: TaskProgress['state'] = stale ? 'stale'
        : audit.events_count === 0 && audit.integrity_status !== 'FAIL' ? 'incomplete'
        : !trusted ? 'unknown'
        : completed ? 'completed'
        : audit.status === 'PASS' ? 'incomplete'
        : next.status === 'BLOCKED' || next.status === 'SPLIT_REQUIRED' ? 'blocked'
        : 'active';
    const stages = audit.gates.slice(0, MAX_PROGRESS_STAGES);
    const command = next.commands[0] || null;
    const commandFits = !command || command.command.length <= MAX_PROGRESS_COMMAND_CHARS;
    const reportState: TaskProgress['final_report']['state'] = completed ? 'available'
        : reportExists ? 'stale'
        : audit.status === 'PASS' ? 'pending' : 'missing';
    return {
        state,
        navigator_status: next.status,
        completed_stages: trusted
            ? stages.filter(stage => stage.status === 'PASS').map(stage => ({ gate: stage.gate, timestamp_utc: availableTimestamp(stage.timestamp_utc) }))
            : [],
        current_stage: next.next_gate,
        remaining_stages: completed ? [] : stages.filter(stage => !trusted || stage.status !== 'PASS').map(stage => ({
            gate: stage.gate,
            status: !trusted ? 'unknown' : stage.status === 'FAIL' ? 'failed' : 'pending'
        })),
        blocker: next.status === 'BLOCKED' || next.status === 'SPLIT_REQUIRED'
            ? { gate: next.next_gate, reason: boundedText(next.reason) } : null,
        next_action: completed ? null : {
            gate: next.next_gate,
            label: boundedText(command?.label || next.title),
            command: commandFits ? command?.command || null : null
        },
        final_report: {
            state: reportState,
            path: toPosix(reportPath),
            exists: reportExists,
            sha256: completed ? next.final_report!.final_user_report_sha256 : null
        },
        evidence_references: evidenceReferences,
        timing: { first_event_utc: availableTimestamp(audit.first_event_utc), last_event_utc: availableTimestamp(audit.last_event_utc) },
        diagnostics: [
            ...next.warnings.slice(0, 6).map(boundedText),
            ...(!commandFits ? ['The next command exceeds the bounded progress response; inspect the navigator directly.'] : [])
        ]
    };
}

export function buildTaskProgress(options: TaskProgressOptions): TaskProgress {
    try {
        const repoRoot = path.resolve(options.repoRoot);
        const taskId = assertCanonicalTaskId(options.taskId);
        const reviewsRoot = confinedPath(path.resolve(options.reviewsRoot), repoRoot);
        const eventsRoot = confinedPath(path.resolve(options.eventsRoot), repoRoot);
        if (!options.taskKnown) return emptyProgress('unknown', 'Task is absent from the current active queue.', options.audit);
        if (!options.audit) return emptyProgress('unavailable', 'Current task audit is unavailable.', null);
        if (options.audit.task_id !== taskId) return emptyProgress('unavailable', 'Task audit belongs to a different task.', null);
        const reportExists = inspectCloseoutReferences(reviewsRoot, taskId);
        const next = resolveNextStep({ taskId, repoRoot, eventsRoot, reviewsRoot });
        const references = selectEvidenceReferences(options.audit, reviewsRoot, taskId);
        return projectProgress(options.audit, next, repoRoot, path.join(reviewsRoot, `${taskId}-final-user-report.md`), reportExists, references);
    } catch (error: unknown) {
        return emptyProgress('unavailable', error instanceof Error ? error.message : String(error), options.audit);
    }
}
