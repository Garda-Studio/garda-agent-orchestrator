import * as fs from 'node:fs';
import * as path from 'node:path';
import { allocateNextParentDerivedTaskId } from '../../core/task-id-allocation';
import { parseCanonicalActiveTaskQueue, formatActiveTaskQueueTable } from '../../core/task-md-table';
import { withTaskQueueTransaction, writeTaskQueueFile } from '../../core/task-queue/task-queue-repository';
import { withTaskPlanMutationLock } from '../../core/task-plan-save';
import { resolveCanonicalTaskPlanPath } from '../../core/task-plan-read';
import { serializeTaskPlan, validateTaskPlan, type TaskPlan } from '../../schemas/task-plan';
import { readParentAuditProofBytes } from '../task-audit/task-audit-summary-decomposed-parent-proofs';
import { parentDigest, parentRecordDigest, publishParentRecord, readParentRecord, writeParentAuditArtifact } from './parent-audit-auth';
import { readParentQueue } from './parent-audit-contract';
import type { ParentReviewObservation } from './parent-audit-evidence';
import type { ParentCompletionContract, ParentRecord, ParentReviewInput } from './parent-audit-types';

export interface ParentAuditFollowUp extends ParentRecord {
    kind: 'follow-up';
    observation_sha256: string;
    follow_up_task_id: string;
    profile: string;
    title: string;
    notes: string;
    plan: TaskPlan;
    plan_bytes_sha256: string;
    status: 'PREPARED' | 'MATERIALIZED';
}

function cell(value: string): string {
    return value.replace(/\r?\n/gu, ' ').replace(/\|/gu, '\\|');
}

function prepareFollowUp(root: string, contract: ParentCompletionContract, input: ParentReviewInput, observation: ParentReviewObservation): ParentAuditFollowUp {
    const { entries } = readParentQueue(root);
    const id = allocateNextParentDerivedTaskId({ parentTaskId: contract.task_id, existingTaskIds: entries.keys(), kind: 'followup' });
    const title = `Resolve the aggregate audit findings for ${contract.task_id}`;
    const criteria = observation.findings.map(finding => `${finding.id}: ${finding.title}. ${finding.description} Required correction: ${finding.remediation}`);
    const plan = validateTaskPlan({ schema_version: 1, task_id: id, status: 'approved', goal: title,
        scope_files: input.changed_files.length ? input.changed_files : ['TASK.md'], risk_level: 'high',
        steps: [{ id: 'correct', title: 'Reproduce and resolve every frozen aggregate finding.' },
            { id: 'verify', title: 'Verify the corrections through the ordinary native lifecycle and required independent reviews.' }],
        acceptance_criteria: criteria, verification_expectations: [
            ...contract.original_commands,
            'Demonstrate every frozen finding is corrected on the accepted SOURCE through native validation and independent review.'
        ], out_of_scope: ['Do not reopen or reset original children, repeat the completed aggregate review, or create recursive aggregate F-tasks.'],
        notes: `One grouped correction for parent audit ${contract.task_id}; observation ${parentRecordDigest(observation)}. Acceptance of this task discharges this parent audit.` });
    return publishParentRecord(root, { schema_version: 1, event_source: 'parent-audit', task_id: contract.task_id, kind: 'follow-up',
        observation_sha256: parentRecordDigest(observation), follow_up_task_id: id, profile: 'strict', title,
        notes: `Parent aggregate audit: ${contract.task_id}; immutable findings: ${parentRecordDigest(observation)}. All ${criteria.length} mandatory findings are in the attached native task plan. Ordinary tests and independent reviews are required.`,
        plan, plan_bytes_sha256: parentDigest(serializeTaskPlan(plan)), status: 'PREPARED' } satisfies ParentAuditFollowUp);
}

export function materializeParentAuditFollowUp(root: string, contract: ParentCompletionContract, input: ParentReviewInput, observation: ParentReviewObservation): string {
    const record = readParentRecord<ParentAuditFollowUp>(root, contract.task_id, 'follow-up') || prepareFollowUp(root, contract, input, observation);
    if (record.observation_sha256 !== parentRecordDigest(observation)) throw new Error('Another aggregate audit owns the grouped F-task.');
    const taskPath = path.join(root, 'TASK.md');
    withTaskPlanMutationLock(root, record.follow_up_task_id, () => {
        const file = resolveCanonicalTaskPlanPath(root, record.follow_up_task_id), bytes = serializeTaskPlan(record.plan);
        if (parentDigest(bytes) !== record.plan_bytes_sha256) throw new Error('Grouped correction plan differs.');
        if (fs.existsSync(file)) readParentAuditProofBytes(root, file, record.plan_bytes_sha256);
        else writeParentAuditArtifact(root, file, bytes);
        withTaskQueueTransaction(taskPath, message => { throw new Error(message); }, () => {
            const content = fs.readFileSync(taskPath, 'utf8'), queue = parseCanonicalActiveTaskQueue(content);
            if (!queue.found || queue.diagnostics?.length) throw new Error('Cannot materialize into an uncertain canonical queue.');
            const existing = queue.rows.find(row => row.taskId === record.follow_up_task_id);
            if (existing) {
                if (existing.title !== record.title || existing.profile !== record.profile || !existing.notes.includes(record.notes)) {
                    throw new Error('Grouped correction ID is occupied by another task.');
                }
                return;
            }
            const parent = queue.rows.find(row => row.taskId === contract.task_id);
            if (!parent) throw new Error('Parent disappeared during grouped correction materialization.');
            const newline = content.includes('\r\n') ? '\r\n' : '\n', lines = content.split(/\r?\n/u);
            const row = [record.follow_up_task_id, '🟦 TODO', 'P0', 'workflow/aggregate-correction', record.title,
                'unassigned (local)', new Date().toISOString().slice(0, 10), record.profile, record.notes];
            lines.splice(parent.lineIndex + 1, 0, '| ' + row.map(cell).join(' | ') + ' |');
            writeTaskQueueFile(taskPath, formatActiveTaskQueueTable(lines.join(newline)));
        });
    });
    if (record.status !== 'MATERIALIZED') publishParentRecord(root, { ...record, status: 'MATERIALIZED' });
    return record.follow_up_task_id;
}

export function readParentAuditFollowUp(root: string, taskId: string): ParentAuditFollowUp | null {
    const record = readParentRecord<ParentAuditFollowUp>(root, taskId, 'follow-up');
    if (!record) return null;
    const entry = readParentQueue(root).entries.get(record.follow_up_task_id);
    if (record.status !== 'MATERIALIZED' || !entry || entry.title !== record.title || entry.profile !== record.profile
        || !entry.notes?.includes(record.notes)) throw new Error('Grouped correction was not natively materialized or its acceptance binding changed.');
    readParentAuditProofBytes(root, resolveCanonicalTaskPlanPath(root, record.follow_up_task_id), record.plan_bytes_sha256);
    return record;
}

export function isParentAuditFollowUp(root: string, taskId: string): boolean {
    const parentId = taskId.replace(/-F[1-9][0-9]*$/u, '');
    return parentId !== taskId && readParentAuditFollowUp(root, parentId)?.follow_up_task_id === taskId;
}
