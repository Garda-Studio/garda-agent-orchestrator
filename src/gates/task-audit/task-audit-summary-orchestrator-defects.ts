import * as fs from 'node:fs';
import * as path from 'node:path';

import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { TASK_ID_ALLOWED_PATTERN } from '../../core/task-ids';
import { parseTaskQueueEntriesFromContent, type TaskQueueEntry } from '../../core/task-queue-read';
import type { TaskAuditEvent } from './task-audit-summary-lifecycle';

export const ORCHESTRATOR_DEFECT_ACKNOWLEDGED_EVENT = 'ORCHESTRATOR_DEFECT_ACKNOWLEDGED';

export type OrchestratorDefectResolution = 'fixed_in_current_task' | 'deferred_to_follow_up';

export interface OrchestratorDefectCaptureRecord {
    defect_id: string | null;
    summary: string | null;
    resolution: OrchestratorDefectResolution | null;
    problem_record_id: string | null;
    follow_up_task_id: string | null;
    timestamp_utc: string | null;
    problem_record_found: boolean;
    follow_up_task_found: boolean;
    status: 'CAPTURED' | 'INVALID';
    violations: string[];
}

export interface FinalCloseoutOrchestratorDefectCaptureSummary {
    status: 'NOT_DECLARED' | 'CAPTURED' | 'INVALID';
    encountered: boolean | null;
    acknowledged_count: number;
    captured_count: number;
    records: OrchestratorDefectCaptureRecord[];
    violations: string[];
    visible_summary_line: string;
}

interface ParsedAcknowledgement {
    key: string;
    eventIndex: number;
    record: Omit<OrchestratorDefectCaptureRecord,
        'problem_record_found' | 'follow_up_task_found' | 'status' | 'violations'>;
}

function readText(value: unknown): string | null {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || null;
}

function readDetails(event: TaskAuditEvent): Record<string, unknown> {
    return event.details && typeof event.details === 'object' && !Array.isArray(event.details)
        ? event.details as Record<string, unknown>
        : {};
}

function normalizeResolution(value: unknown): OrchestratorDefectResolution | null {
    const resolution = readText(value)?.toLowerCase() || null;
    return resolution === 'fixed_in_current_task' || resolution === 'deferred_to_follow_up'
        ? resolution
        : null;
}

function isProblemSectionHeading(line: string): boolean {
    const match = /^#{1,6}\s+(.+?)\s*$/u.exec(line.trim());
    if (!match) {
        return false;
    }
    const heading = match[1].toLowerCase();
    return heading === 'найденные проблемы оркестратора'
        || (/orchestrator/u.test(heading) && /(defect|problem)/u.test(heading));
}

function readProblemRecordBlocks(taskContent: string): string[] {
    const lines = taskContent.split(/\r?\n/u);
    const headingIndex = lines.findIndex(isProblemSectionHeading);
    if (headingIndex < 0) {
        return [];
    }
    const headingLevel = /^#+/u.exec(lines[headingIndex].trim())?.[0].length || 6;
    const sectionLines: string[] = [];
    for (let index = headingIndex + 1; index < lines.length; index += 1) {
        const nextHeading = /^(#+)\s+/u.exec(lines[index].trim());
        if (nextHeading && nextHeading[1].length <= headingLevel) {
            break;
        }
        sectionLines.push(lines[index]);
    }

    const blocks: string[] = [];
    let current: string[] = [];
    for (const line of sectionLines) {
        if (/^\s*-\s+/u.test(line)) {
            if (current.length > 0) {
                blocks.push(current.join('\n'));
            }
            current = [line];
        } else if (current.length > 0) {
            current.push(line);
        }
    }
    if (current.length > 0) {
        blocks.push(current.join('\n'));
    }
    return blocks;
}

function containsTaskId(text: string, taskId: string): boolean {
    const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9-])${escaped}(?=$|[^A-Za-z0-9-])`, 'u').test(text);
}

function hasLinkedProblemRecord(blocks: readonly string[], problemRecordId: string, followUpTaskId: string): boolean {
    return blocks.some((block) => (
        containsTaskId(block, problemRecordId)
        && containsTaskId(block, followUpTaskId)
    ));
}

function readTaskContent(repoRoot: string): string | null {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return null;
    }
    return fs.readFileSync(taskPath, 'utf8');
}

function collectLatestAcknowledgements(events: readonly TaskAuditEvent[]): ParsedAcknowledgement[] {
    const latestByDefectId = new Map<string, ParsedAcknowledgement>();
    events.forEach((event, eventIndex) => {
        if (String(event.event_type || '').trim().toUpperCase() !== ORCHESTRATOR_DEFECT_ACKNOWLEDGED_EVENT) {
            return;
        }
        const details = readDetails(event);
        const defectId = readText(details.defect_id);
        const acknowledgement: ParsedAcknowledgement = {
            key: defectId || `missing-defect-id-${eventIndex}`,
            eventIndex,
            record: {
                defect_id: defectId,
                summary: readText(details.summary),
                resolution: normalizeResolution(details.resolution),
                problem_record_id: readText(details.problem_record_id),
                follow_up_task_id: readText(details.follow_up_task_id),
                timestamp_utc: readText(event.timestamp_utc)
            }
        };
        latestByDefectId.set(acknowledgement.key, acknowledgement);
    });
    return [...latestByDefectId.values()].sort((left, right) => left.eventIndex - right.eventIndex);
}

function validateAcknowledgement(
    acknowledgement: ParsedAcknowledgement,
    currentTaskId: string,
    taskEntries: ReadonlyMap<string, TaskQueueEntry>,
    problemRecordBlocks: readonly string[],
    taskFileAvailable: boolean
): OrchestratorDefectCaptureRecord {
    const record = acknowledgement.record;
    const violations: string[] = [];
    if (!record.defect_id) {
        violations.push('acknowledgement is missing defect_id');
    }
    if (!record.summary) {
        violations.push(`defect '${record.defect_id || acknowledgement.key}' is missing summary`);
    }
    if (!record.resolution) {
        violations.push(
            `defect '${record.defect_id || acknowledgement.key}' must declare resolution as `
            + 'fixed_in_current_task or deferred_to_follow_up'
        );
    }
    if (!record.problem_record_id || !TASK_ID_ALLOWED_PATTERN.test(record.problem_record_id)) {
        violations.push(`defect '${record.defect_id || acknowledgement.key}' has no valid problem_record_id`);
    }
    if (!record.follow_up_task_id || !TASK_ID_ALLOWED_PATTERN.test(record.follow_up_task_id)) {
        violations.push(`defect '${record.defect_id || acknowledgement.key}' has no valid follow_up_task_id`);
    } else if (record.follow_up_task_id === currentTaskId) {
        violations.push(
            `defect '${record.defect_id || acknowledgement.key}' follow-up task must be distinct from `
            + `the current task '${currentTaskId}'`
        );
    }

    const followUpTaskFound = !!record.follow_up_task_id
        && record.follow_up_task_id !== currentTaskId
        && taskEntries.has(record.follow_up_task_id);
    if (record.follow_up_task_id && !followUpTaskFound) {
        violations.push(
            `defect '${record.defect_id || acknowledgement.key}' follow-up task '${record.follow_up_task_id}' `
            + `is missing from ${TASK_QUEUE_FILENAME}`
        );
    }
    const problemRecordFound = !!record.problem_record_id
        && !!record.follow_up_task_id
        && hasLinkedProblemRecord(problemRecordBlocks, record.problem_record_id, record.follow_up_task_id);
    if (record.problem_record_id && record.follow_up_task_id && !problemRecordFound) {
        violations.push(
            taskFileAvailable
                ? `defect '${record.defect_id || acknowledgement.key}' has no linked record for `
                    + `'${record.problem_record_id}' and follow-up '${record.follow_up_task_id}' in the canonical `
                    + `${TASK_QUEUE_FILENAME} orchestrator-problems section`
                : `defect '${record.defect_id || acknowledgement.key}' cannot verify durable capture because `
                    + `${TASK_QUEUE_FILENAME} is missing`
        );
    }

    return {
        ...record,
        problem_record_found: problemRecordFound,
        follow_up_task_found: followUpTaskFound,
        status: violations.length === 0 ? 'CAPTURED' : 'INVALID',
        violations
    };
}

export function buildOrchestratorDefectCaptureSummary(options: {
    repoRoot: string;
    taskId: string;
    events: readonly TaskAuditEvent[];
}): FinalCloseoutOrchestratorDefectCaptureSummary {
    const acknowledgements = collectLatestAcknowledgements(options.events);
    if (acknowledgements.length === 0) {
        return {
            status: 'NOT_DECLARED',
            encountered: null,
            acknowledged_count: 0,
            captured_count: 0,
            records: [],
            violations: [],
            visible_summary_line:
                'Orchestrator defect capture: status=NOT_DECLARED; encountered=unknown; '
                + 'historical read-only compatibility applied.'
        };
    }

    const taskContent = readTaskContent(options.repoRoot);
    const taskEntries = parseTaskQueueEntriesFromContent(taskContent ?? '');
    const problemRecordBlocks = taskContent ? readProblemRecordBlocks(taskContent) : [];
    const records = acknowledgements.map((acknowledgement) => validateAcknowledgement(
        acknowledgement,
        options.taskId,
        taskEntries,
        problemRecordBlocks,
        taskContent !== null
    ));
    const violations = records.flatMap((record) => record.violations);
    const capturedCount = records.filter((record) => record.status === 'CAPTURED').length;
    const status = violations.length === 0 ? 'CAPTURED' : 'INVALID';
    return {
        status,
        encountered: true,
        acknowledged_count: records.length,
        captured_count: capturedCount,
        records,
        violations,
        visible_summary_line:
            `Orchestrator defect capture: status=${status}; encountered=true; `
            + `captured=${capturedCount}/${records.length}; violations=${violations.length}.`
    };
}
