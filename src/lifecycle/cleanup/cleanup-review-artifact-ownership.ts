import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import {
    isCanonicalTaskId,
    parseStructuredTaskArtifactTaskId,
    taskIdsEqualCaseInsensitive
} from '../../core/task-ids';

const MAX_JSON_TASK_IDENTITY_BYTES = 64 * 1024 * 1024;

interface JsonTaskIdentity {
    present: boolean;
    taskId: string | null;
}

function readBoundedArtifactBytes(filePath: string): Buffer {
    const before = fs.lstatSync(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_JSON_TASK_IDENTITY_BYTES) {
        throw new Error('Task artifact identity requires a bounded unshared regular file.');
    }
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
            throw new Error('Task artifact identity changed before inspection.');
        }
        const bytes = Buffer.alloc(opened.size + 1);
        let count = 0;
        while (count < bytes.length) {
            const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
            if (read === 0) break;
            count += read;
        }
        const after = fs.lstatSync(filePath);
        const finished = fs.fstatSync(fd);
        if (count !== opened.size || after.isSymbolicLink() || after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino
            || finished.size !== opened.size || finished.mtimeMs !== opened.mtimeMs || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
            throw new Error('Task artifact identity changed during inspection.');
        }
        return bytes.subarray(0, count);
    } finally {
        fs.closeSync(fd);
    }
}

function readJsonTaskIdentity(filePath: string): JsonTaskIdentity | null {
    const compressed = filePath.endsWith('.gz');
    const plainPath = compressed ? filePath.slice(0, -3) : filePath;
    const markdown = plainPath.endsWith('.md');
    if (!markdown && !plainPath.endsWith('.json')) return null;
    try {
        const bytes = readBoundedArtifactBytes(filePath);
        const content = compressed ? zlib.gunzipSync(bytes, { maxOutputLength: MAX_JSON_TASK_IDENTITY_BYTES }) : bytes;
        const text = content.toString('utf8');
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            if (markdown && !/^\s*(?:\{|\[)/u.test(text)) return null;
            return { present: true, taskId: null };
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { present: true, taskId: null };
        if (!Object.hasOwn(parsed, 'task_id')) return { present: false, taskId: null };
        const record = parsed as Record<string, unknown>;
        const taskId = record.task_id;
        return { present: true, taskId: typeof taskId === 'string' && isCanonicalTaskId(taskId) ? taskId.trim() : null };
    } catch {
        return { present: true, taskId: null };
    }
}

export function readTaskIdFromJsonReviewArtifact(filePath: string): string | null {
    return readJsonTaskIdentity(filePath)?.taskId ?? null;
}

export function hasConsistentReviewArtifactTaskId(filePath: string, indexedTaskId: string): boolean {
    try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false;
    } catch {
        return false;
    }
    const identity = readJsonTaskIdentity(filePath);
    return !identity?.present || Boolean(identity.taskId && taskIdsEqualCaseInsensitive(identity.taskId, indexedTaskId));
}

export function resolveStructuredOrJsonReviewArtifactTaskId(filePath: string, fileName: string): string | null {
    const structuredTaskId = parseStructuredTaskArtifactTaskId(fileName);
    const identity = readJsonTaskIdentity(filePath);
    if (identity?.present && !identity.taskId) return null;
    const jsonTaskId = identity?.taskId ?? null;
    if (jsonTaskId && structuredTaskId) {
        return taskIdsEqualCaseInsensitive(jsonTaskId, structuredTaskId) ? structuredTaskId : null;
    }
    return jsonTaskId ?? structuredTaskId;
}
