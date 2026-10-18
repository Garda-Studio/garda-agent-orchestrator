import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveActiveTaskIds } from './task-queue/active-task-state';
import { appendMandatoryTaskEvent, inspectTaskEventFile, readTaskTimelineJsonlEntries } from '../gate-runtime/task-events';

export interface WorkflowConfigAuditBinding {
    auditPath: string;
    configPath: string;
    recordSha256: string;
    taskEntryHashes: Record<string, string>;
}

export function workflowConfigTextDigest(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function readWorkflowAuditTaskEntryHash(bundleRoot: string, taskId: string): string | null {
    const timelinePath = path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
    if (!fs.existsSync(timelinePath)
        || !['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspectTaskEventFile(timelinePath, taskId).status)) return null;
    const entry = [...readTaskTimelineJsonlEntries(timelinePath)].reverse()
        .find(({ record }) => record?.event_type === 'TASK_MODE_ENTERED');
    return entry?.record?.outcome === 'PASS' ? workflowConfigTextDigest(entry.rawLine.trim()) : null;
}

export function captureWorkflowAuditTaskContext(bundleRoot: string, targetRoot: string): {
    activeTaskIds: string[]; taskEntryHashes: Record<string, string>;
} {
    const activeTaskIds = [...resolveActiveTaskIds(targetRoot, bundleRoot, [], {
        includeAmbiguousRuntimeTasks: false,
        includeStaleRuntimeActiveTasks: false
    })].sort((left, right) => left.localeCompare(right));
    const taskEntryHashes: Record<string, string> = {};
    for (const taskId of activeTaskIds) {
        const entryHash = readWorkflowAuditTaskEntryHash(bundleRoot, taskId);
        if (entryHash) taskEntryHashes[taskId] = entryHash;
    }
    return { activeTaskIds, taskEntryHashes };
}

export function recordWorkflowConfigAuditStage(
    bundleRoot: string, binding: WorkflowConfigAuditBinding, committed: boolean
): void {
    for (const [taskId, entryHash] of Object.entries(binding.taskEntryHashes)) {
        if (readWorkflowAuditTaskEntryHash(bundleRoot, taskId) !== entryHash) {
            throw new Error(`Workflow audit cannot bind to a changed task cycle for '${taskId}'.`);
        }
        appendMandatoryTaskEvent(bundleRoot, taskId,
            committed ? 'WORKFLOW_CONFIG_MUTATION_AUDITED' : 'WORKFLOW_CONFIG_MUTATION_PREPARED',
            committed ? 'PASS' : 'INFO',
            committed ? 'Committed workflow configuration mutation bound to the current task cycle.'
                : 'Workflow configuration mutation prepared for the current task cycle.', {
                audit_path: path.normalize(binding.auditPath).replace(/\\/g, '/'),
                config_path: path.normalize(binding.configPath).replace(/\\/g, '/'),
                audit_record_sha256: binding.recordSha256,
                task_mode_entry_sha256: entryHash
            }, { actor: 'workflow-config-set' });
    }
}

export function bindCommittedWorkflowConfigAudit(bundleRoot: string, binding: WorkflowConfigAuditBinding): void {
    recordWorkflowConfigAuditStage(bundleRoot, binding, true);
}
