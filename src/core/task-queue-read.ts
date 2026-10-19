import { TASK_QUEUE_FILENAME } from './orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import { TASK_ID_ALLOWED_PATTERN } from './task-ids';
import { parseCanonicalActiveTaskQueue } from './task-md-table';
import {
    resolveReviewFollowUpTaskClosurePolicy,
    type ReviewFollowUpTaskClosurePolicySnapshot
} from './review-follow-up-task-closure-policy';

export interface TaskQueueEntry {
    taskId: string;
    status: string | null;
    area: string | null;
    title: string | null;
    profile: string | null;
    notes: string | null;
    reviewFollowUpTaskClosurePolicy?: ReviewFollowUpTaskClosurePolicySnapshot;
}

export interface ReadTaskQueueEntriesOptions {
    missingFile?: 'empty' | 'throw';
}

interface TaskQueueReadSnapshot {
    active: boolean;
    contents: Map<string, string>;
}

const taskQueueReadSnapshots = new AsyncLocalStorage<TaskQueueReadSnapshot>();

export function withTaskQueueReadSnapshot<T>(callback: () => T): T {
    const snapshot: TaskQueueReadSnapshot = { active: true, contents: new Map() };
    return taskQueueReadSnapshots.run(snapshot, () => {
        try {
            return callback();
        } finally {
            snapshot.active = false;
            snapshot.contents.clear();
        }
    });
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

export function parseTaskQueueEntriesFromContent(content: string): Map<string, TaskQueueEntry> {
    const entries = new Map<string, TaskQueueEntry>();
    const rows = parseCanonicalActiveTaskQueue(content).rows;
    const policyTaskRows = rows.map((row) => ({
        taskId: row.taskId,
        notes: row.notes || null
    }));
    for (const row of rows) {
        const rawTaskId = row.taskId;
        if (!TASK_ID_ALLOWED_PATTERN.test(rawTaskId)) {
            continue;
        }
        const taskId = rawTaskId;
        entries.set(taskId, {
            taskId,
            status: row.status || null,
            area: row.area || null,
            title: row.title || null,
            profile: row.profile || null,
            notes: row.notes || null,
            reviewFollowUpTaskClosurePolicy: resolveReviewFollowUpTaskClosurePolicy(row.notes, {
                taskId,
                taskRows: policyTaskRows
            })
        });
    }
    return entries;
}

export function readTaskQueueEntries(
    repoRoot: string,
    options: ReadTaskQueueEntriesOptions = {}
): Map<string, TaskQueueEntry> {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    const snapshot = taskQueueReadSnapshots.getStore();
    const resolvedPath = path.resolve(taskPath);
    const key = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    let content = snapshot?.active ? snapshot.contents.get(key) : undefined;
    if (content === undefined) {
        if (options.missingFile !== 'throw' && !fileExists(taskPath)) {
            return new Map<string, TaskQueueEntry>();
        }
        content = fs.readFileSync(taskPath, 'utf8');
        if (snapshot?.active) snapshot.contents.set(key, content);
    }
    return parseTaskQueueEntriesFromContent(content);
}
