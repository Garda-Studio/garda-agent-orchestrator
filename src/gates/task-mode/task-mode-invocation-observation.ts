import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
    readInvocationFileContent, readInvocationPathObservation
} from '../../core/invocation-file-observation';
import { createInvocationReadMemoKey, memoizeInvocationRead, registerInvocationDependency } from '../../core/invocation-read-observation';

const TASK_MODE_PATH = createInvocationReadMemoKey<string>('task-mode-resolved-path');
const TASK_MODE_FILE_EXISTS = createInvocationReadMemoKey<boolean>('task-mode-native-file-exists');
const TASK_MODE_TEXT = createInvocationReadMemoKey<string>('task-mode-native-text');
// Q2 retains bytes up to this bound, but the legacy JSON readers never imposed it.
const RETAINED_CONTENT_LIMIT = 128 * 1024 * 1024;

/** Include lexical root identity; aliases retain their own final path checks. */
export function taskModeInvocationRepoKey(repoRoot: string): string {
    const resolved = path.resolve(repoRoot);
    const observation = readInvocationPathObservation(resolved);
    const identity = observation && 'value' in observation.targetIdentity ? observation.targetIdentity.value : null;
    const realPath = observation && 'value' in observation.realPath ? observation.realPath.value : null;
    return JSON.stringify([resolved, realPath, identity?.dev.toString(), identity?.ino.toString(), identity?.birthtimeNs.toString()]);
}

/** Retain branch-sensitive path selection, including deployed-bundle discovery. */
export function resolveTaskModeInvocationPath(key: string, resolve: () => string): string {
    return memoizeInvocationRead(TASK_MODE_PATH, key, () => {
        const resolved = resolve();
        const owner = {};
        registerInvocationDependency(owner, () => {
            if (resolve() !== resolved) throw new Error('Task-mode input path resolution changed: ' + resolved);
        });
        return resolved;
    }).value;
}

/** Preserve the native predicate and its stat-error boundary outside the JSON catch. */
export function taskModeInvocationFileExists(filePath: string): boolean {
    return memoizeInvocationRead(TASK_MODE_FILE_EXISTS, path.resolve(filePath), () => {
        readInvocationPathObservation(filePath);
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    }).value;
}

/** Native fallback preserves the original UTF-8 and unbounded read semantics. */
export function readTaskModeInvocationText(filePath: string): string {
    return memoizeInvocationRead(TASK_MODE_TEXT, path.resolve(filePath), () => {
        const content = readInvocationFileContent(filePath);
        if (!content) return fs.readFileSync(filePath, 'utf8');
        if (content.size <= RETAINED_CONTENT_LIMIT) return content.copyBytes().toString('utf8');
        const bytes = fs.readFileSync(filePath);
        if (createHash('sha256').update(bytes).digest('hex') !== content.sha256) {
            throw new Error('Task-mode input changed after its invocation observation: ' + filePath);
        }
        return bytes.toString('utf8');
    }).value;
}
