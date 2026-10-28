import { registerInvocationDependency, isInvocationReadObservationActive, createInvocationReadMemoKey, memoizeInvocationRead } from '../../core/invocation-read-observation';
import { countNextStepWork } from '../../core/next-step-measurement';
import { createHash, type Hash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import { completePathFileIdentitySync, lstatFileIdentitySync } from '../../core/file-stat';
import * as path from 'node:path';
import { inspectTrustedWindowsWriteAuthority } from './windows-acl-authority';
export { windowsAclOutputHasExplicitWriteGrant } from './windows-acl-authority';

import {
    normalizeBoundedJsonlTailLimits,
    readBoundedJsonlTailBuffer,
    type BoundedJsonlTailLimits,
    type BoundedJsonlTailResult
} from '../../core/bounded-jsonl-tail';
import { assertCanonicalTaskId } from '../../core/task-ids';

type TimelineSnapshotState = 'valid' | 'missing' | 'invalid';

interface CachedTaskTimelineRead {
    state: TimelineSnapshotState;
    identity: fs.Stats | null;
    content: Buffer | null;
    text: string | null;
    sha256: string | null;
    sha256State: Hash | null;
    memoizedValues: Map<symbol, Map<string, unknown>>;
}

interface ActiveTaskTimelineReadSnapshot {
    depth: number;
    eventsRoot: string;
    realEventsRoot: string;
    eventsRootIdentity: fs.Stats | null;
    timelinePath: string;
    cachedRead: CachedTaskTimelineRead | null;
}

interface EventsRootBoundary {
    eventsRoot: string;
    realEventsRoot: string;
    eventsRootIdentity: fs.Stats | null;
}

export interface TaskTimelineAppendAuthority extends EventsRootBoundary {
    timelinePath: string;
    timelineIdentity: fs.Stats | null;
}

export interface TaskTimelineFileReadSnapshot {
    active: boolean;
    exists: boolean;
    valid: boolean;
    content: Buffer | null;
    sha256: string | null;
}

export type TaskTimelineFileMetadataSnapshot = Omit<TaskTimelineFileReadSnapshot, 'content'>;

declare const taskTimelineMemoizationKeyBrand: unique symbol;

export interface TaskTimelineMemoizationKey<T> {
    readonly token: symbol;
    readonly [taskTimelineMemoizationKeyBrand]: (value: T) => T;
}

export type TaskTimelineDeepReadonly<T> =
    T extends (...args: never[]) => unknown ? T
        : T extends readonly (infer TValue)[] ? readonly TaskTimelineDeepReadonly<TValue>[]
            : T extends object ? { readonly [TKey in keyof T]: TaskTimelineDeepReadonly<T[TKey]> }
                : T;

export interface TaskTimelineMemoizedRead<T> {
    readonly active: boolean;
    readonly exists: boolean;
    readonly valid: boolean;
    readonly byteLength: number | null;
    readonly value: TaskTimelineDeepReadonly<T> | null;
}

export function createTaskTimelineMemoizationKey<T>(description: string): TaskTimelineMemoizationKey<T> {
    const normalizedDescription = String(description || '').trim();
    if (!normalizedDescription) {
        throw new Error('Task timeline memoization key description is required.');
    }
    return Object.freeze({
        token: Symbol(normalizedDescription)
    }) as TaskTimelineMemoizationKey<T>;
}

const taskTimelineReadSnapshotStorage = new AsyncLocalStorage<Map<string, ActiveTaskTimelineReadSnapshot>>();
const INVOCATION_TIMELINE_SNAPSHOTS = createInvocationReadMemoKey<Map<string, ActiveTaskTimelineReadSnapshot>>('retained-timeline-owners');
function retainedInvocationTimelineSnapshots(): Map<string, ActiveTaskTimelineReadSnapshot> | null {
    return isInvocationReadObservationActive()
        ? memoizeInvocationRead(INVOCATION_TIMELINE_SNAPSHOTS, '', () => new Map<string, ActiveTaskTimelineReadSnapshot>()).value
        : null;
}

// A task timeline is canonical lifecycle evidence, so snapshot consumers need
// the complete payload. Keep that payload bounded independently from callers
// that request a smaller tail view so a corrupted or attacker-inflated file
// cannot cause an unbounded allocation.
export const MAX_TASK_TIMELINE_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_TASK_TIMELINE_MEMOIZED_OBJECTS = 500_000;
const MAX_TASK_TIMELINE_MEMOIZED_DEPTH = 256;
const TASK_TIMELINE_FILE_CREATE_MODE = 0o600;
const WINDOWS_ACL_CACHE_MAX_ENTRIES = 128;

const TASK_TIMELINE_TEXT_MEMOIZATION_KEY = createTaskTimelineMemoizationKey<string>('utf8-text');
const TASK_TIMELINE_BOUNDED_TAIL_MEMOIZATION_KEY = createTaskTimelineMemoizationKey<
    BoundedJsonlTailResult<unknown>
>('bounded-jsonl-tail');

export function taskTimelineAppendExceedsSnapshotLimit(
    existingSize: number,
    appendByteLength: number
): boolean {
    return (
        !Number.isSafeInteger(existingSize)
        || existingSize < 0
        || !Number.isSafeInteger(appendByteLength)
        || appendByteLength < 0
        || existingSize > MAX_TASK_TIMELINE_SNAPSHOT_BYTES - appendByteLength
    );
}

function normalizeSnapshotKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameResolvedPath(left: string, right: string): boolean {
    return normalizeSnapshotKey(left) === normalizeSnapshotKey(right);
}

function sameNodeIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}

function hasExclusiveTimelineLink(identity: fs.Stats): boolean {
    return Number.isSafeInteger(identity.nlink) && identity.nlink === 1;
}

interface WindowsAclAuthorityCacheEntry {
    dev: number;
    ino: number;
    mode: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    trusted: boolean;
}

const windowsAclAuthorityCache = new Map<string, WindowsAclAuthorityCacheEntry>();

function rememberWindowsAclAuthority(
    cacheKey: string,
    entry: WindowsAclAuthorityCacheEntry
): boolean {
    if (!windowsAclAuthorityCache.has(cacheKey) && windowsAclAuthorityCache.size >= WINDOWS_ACL_CACHE_MAX_ENTRIES) {
        const oldestKey = windowsAclAuthorityCache.keys().next().value as string | undefined;
        if (oldestKey) {
            windowsAclAuthorityCache.delete(oldestKey);
        }
    }
    windowsAclAuthorityCache.set(cacheKey, entry);
    return entry.trusted;
}

function hasTrustedWindowsWriteAuthority(filePath: string, identity: fs.Stats): boolean {
    identity = completePathFileIdentitySync(filePath, identity);
    if (isInvocationReadObservationActive()) return inspectTrustedWindowsWriteAuthority(path.resolve(filePath));
    const cacheKey = normalizeSnapshotKey(filePath);
    const cached = windowsAclAuthorityCache.get(cacheKey);
    if (
        cached
        && cached.dev === identity.dev
        && cached.ino === identity.ino
        && cached.mode === identity.mode
        && cached.size === identity.size
        && cached.mtimeMs === identity.mtimeMs
        && cached.ctimeMs === identity.ctimeMs
    ) {
        return cached.trusted;
    }

    const trusted = inspectTrustedWindowsWriteAuthority(path.resolve(filePath));
    return rememberWindowsAclAuthority(cacheKey, {
        dev: identity.dev,
        ino: identity.ino,
        mode: identity.mode,
        size: identity.size,
        mtimeMs: identity.mtimeMs,
        ctimeMs: identity.ctimeMs,
        trusted
    });
}

function hasTrustedWriteAuthority(filePath: string, identity: fs.Stats): boolean {
    if (typeof process.getuid !== 'function') {
        // The configured workspace DACL is the Windows trust root because a
        // principal that can rewrite the repository can also rewrite this code.
        // Explicit grants to SYSTEM, Administrators and the current token do
        // not widen it. Other explicit writers still invalidate the boundary.
        return hasTrustedWindowsWriteAuthority(filePath, identity);
    }
    return identity.uid === process.getuid() && (identity.mode & 0o022) === 0;
}

function isMissingPathError(error: unknown): boolean {
    const code = error && typeof error === 'object' && 'code' in error
        ? String((error as NodeJS.ErrnoException).code || '')
        : '';
    return code === 'ENOENT' || code === 'ENOTDIR';
}

function captureEventsRootBoundary(eventsRoot: string, allowMissing: boolean): EventsRootBoundary {
    const resolvedEventsRoot = path.resolve(eventsRoot);
    let identity: fs.Stats;
    try {
        identity = lstatFileIdentitySync(resolvedEventsRoot);
    } catch (error: unknown) {
        if (allowMissing && isMissingPathError(error)) {
            return {
                eventsRoot: resolvedEventsRoot,
                realEventsRoot: resolvedEventsRoot,
                eventsRootIdentity: null
            };
        }
        throw new Error(`Task timeline events root is unavailable: ${resolvedEventsRoot}`);
    }
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
        throw new Error(`Task timeline events root must be a non-redirected directory: ${resolvedEventsRoot}`);
    }
    if (!hasTrustedWriteAuthority(resolvedEventsRoot, identity)) {
        throw new Error(
            'Task timeline events root must retain trusted owner/DACL write authority and not be '
            + `writable by untrusted principals: ${resolvedEventsRoot}`
        );
    }

    let realEventsRoot: string;
    try {
        realEventsRoot = fs.realpathSync.native(resolvedEventsRoot);
    } catch {
        throw new Error(`Task timeline events root is unavailable: ${resolvedEventsRoot}`);
    }
    if (!sameResolvedPath(realEventsRoot, resolvedEventsRoot)) {
        throw new Error(`Task timeline events root must be a non-redirected directory: ${resolvedEventsRoot}`);
    }
    return {
        eventsRoot: resolvedEventsRoot,
        realEventsRoot,
        eventsRootIdentity: identity
    };
}

function isEventsRootBoundaryCurrent(boundary: EventsRootBoundary): boolean {
    if (!boundary.eventsRootIdentity) {
        try {
            lstatFileIdentitySync(boundary.eventsRoot);
            return false;
        } catch (error: unknown) {
            return isMissingPathError(error);
        }
    }

    try {
        const currentIdentity = lstatFileIdentitySync(boundary.eventsRoot);
        const currentRealPath = fs.realpathSync.native(boundary.eventsRoot);
        return currentIdentity.isDirectory()
            && !currentIdentity.isSymbolicLink()
            && hasTrustedWriteAuthority(boundary.eventsRoot, currentIdentity)
            && sameNodeIdentity(boundary.eventsRootIdentity, currentIdentity)
            && sameResolvedPath(currentRealPath, boundary.realEventsRoot)
            && sameResolvedPath(currentRealPath, boundary.eventsRoot);
    } catch {
        return false;
    }
}

function invalidCachedRead(): CachedTaskTimelineRead {
    return {
        state: 'invalid',
        identity: null,
        content: null,
        text: null,
        sha256: null,
        sha256State: null,
        memoizedValues: new Map()
    };
}

function deepFreezeMemoizedValue<T>(value: T): T {
    if (value == null || typeof value !== 'object') {
        return value;
    }

    const visited = new WeakSet<object>();
    const pending: Array<{ value: object; depth: number }> = [{ value, depth: 0 }];
    let objectCount = 0;
    while (pending.length > 0) {
        const current = pending.pop()!;
        if (visited.has(current.value)) {
            continue;
        }
        if (current.depth > MAX_TASK_TIMELINE_MEMOIZED_DEPTH) {
            throw new Error(
                `Task timeline memoized value exceeds the ${MAX_TASK_TIMELINE_MEMOIZED_DEPTH} level depth limit.`
            );
        }
        objectCount += 1;
        countNextStepWork('visit:timeline_memoized_object');
        if (objectCount > MAX_TASK_TIMELINE_MEMOIZED_OBJECTS) {
            throw new Error(
                `Task timeline memoized value exceeds the ${MAX_TASK_TIMELINE_MEMOIZED_OBJECTS} object limit.`
            );
        }
        visited.add(current.value);
        const prototype = Object.getPrototypeOf(current.value) as unknown;
        if (
            ArrayBuffer.isView(current.value)
            || (!Array.isArray(current.value)
                && prototype !== Object.prototype
                && prototype !== null)
        ) {
            throw new Error(
                'Task timeline memoized values may contain only plain objects, arrays, and primitives.'
            );
        }
        for (const child of Object.values(current.value)) {
            countNextStepWork('visit:timeline_memoized_child');
            if (child != null && typeof child === 'object') {
                pending.push({ value: child, depth: current.depth + 1 });
            }
        }
        Object.freeze(current.value);
    }
    return value;
}

function memoizeCachedTaskTimelineValue<T>(
    cachedRead: CachedTaskTimelineRead,
    key: TaskTimelineMemoizationKey<T>,
    memoKey: string,
    buildValue: () => T
): T {
    let keyValues = cachedRead.memoizedValues.get(key.token);
    if (!keyValues) {
        keyValues = new Map<string, unknown>();
        cachedRead.memoizedValues.set(key.token, keyValues);
    }
    if (!keyValues.has(memoKey)) {
        keyValues.set(memoKey, deepFreezeMemoizedValue(buildValue()));
    }
    return keyValues.get(memoKey) as T;
}

function invalidateCachedRead(cachedRead: CachedTaskTimelineRead): void {
    cachedRead.state = 'invalid';
    cachedRead.identity = null;
    cachedRead.content = null;
    cachedRead.text = null;
    cachedRead.sha256 = null;
    cachedRead.sha256State = null;
    cachedRead.memoizedValues.clear();
}

function failChangedSnapshot(cachedRead: CachedTaskTimelineRead, timelinePath: string): never {
    invalidateCachedRead(cachedRead);
    throw new Error(`Task timeline snapshot changed while reading: ${timelinePath}`);
}

function readTaskTimelineDescriptorPayload(
    fileDescriptor: number,
    expectedSize: number
): Buffer | null {
    return readTaskTimelineDescriptorRange(fileDescriptor, 0, expectedSize);
}

function readTaskTimelineDescriptorRange(
    fileDescriptor: number,
    start: number,
    expectedSize: number
): Buffer | null {
    const content = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
        const bytesRead = fs.readSync(
            fileDescriptor,
            content,
            offset,
            expectedSize - offset,
            start + offset
        );
        if (bytesRead <= 0) {
            return null;
        }
        offset += bytesRead;
    }
    return content;
}

function readAuthenticatedTaskTimelineBoundedJsonlTail<T>(
    filePath: string,
    limits: BoundedJsonlTailLimits
): BoundedJsonlTailResult<T> {
    const timelinePath = path.resolve(filePath);
    const taskId = path.basename(timelinePath, path.extname(timelinePath));
    assertTaskTimelinePathMatchesTaskId(timelinePath, taskId);
    const boundary = captureEventsRootBoundary(path.dirname(timelinePath), false);

    let beforeRead: fs.Stats;
    try {
        beforeRead = fs.lstatSync(timelinePath);
    } catch {
        throw new Error(`Task timeline snapshot is unavailable: ${timelinePath}`);
    }
    if (beforeRead.size > MAX_TASK_TIMELINE_SNAPSHOT_BYTES) {
        throw new Error(
            `Task timeline exceeds the ${MAX_TASK_TIMELINE_SNAPSHOT_BYTES} byte read limit: ${timelinePath}`
        );
    }
    if (
        !beforeRead.isFile()
        || beforeRead.isSymbolicLink()
        || !hasExclusiveTimelineLink(beforeRead)
        || !hasTrustedWriteAuthority(timelinePath, beforeRead)
    ) {
        throw new Error(`Task timeline snapshot is unavailable: ${timelinePath}`);
    }

    let fileDescriptor: number | null = null;
    let authenticatedIdentity: fs.Stats | null = null;
    let retainedContent: Buffer | null = null;
    try {
        const realPathBeforeRead = fs.realpathSync.native(timelinePath);
        if (!isPathInside(realPathBeforeRead, boundary.realEventsRoot)) {
            throw new Error(`Task timeline snapshot is unavailable: ${timelinePath}`);
        }
        beforeRead = completePathFileIdentitySync(timelinePath, beforeRead);
        fileDescriptor = fs.openSync(timelinePath, 'r');
        const descriptorBeforeRead = fs.fstatSync(fileDescriptor);
        if (
            !sameFileIdentity(beforeRead, descriptorBeforeRead)
            || !hasExclusiveTimelineLink(descriptorBeforeRead)
            || !hasTrustedWriteAuthority(timelinePath, descriptorBeforeRead)
        ) {
            throw new Error(`Task timeline snapshot changed while reading: ${timelinePath}`);
        }
        const bytesRead = Math.min(descriptorBeforeRead.size, limits.maxBytes);
        const start = descriptorBeforeRead.size - bytesRead;
        retainedContent = readTaskTimelineDescriptorRange(fileDescriptor, start, bytesRead);
        const descriptorAfterRead = fs.fstatSync(fileDescriptor);
        const afterRead = lstatFileIdentitySync(timelinePath);
        const realPathAfterRead = fs.realpathSync.native(timelinePath);
        if (
            !retainedContent
            || !sameFileIdentity(descriptorBeforeRead, descriptorAfterRead)
            || !sameFileIdentity(descriptorAfterRead, afterRead)
            || afterRead.isSymbolicLink()
            || !hasExclusiveTimelineLink(descriptorAfterRead)
            || !hasExclusiveTimelineLink(afterRead)
            || !hasTrustedWriteAuthority(timelinePath, descriptorAfterRead)
            || !hasTrustedWriteAuthority(timelinePath, afterRead)
            || !isEventsRootBoundaryCurrent(boundary)
            || !isPathInside(realPathAfterRead, boundary.realEventsRoot)
        ) {
            throw new Error(`Task timeline snapshot changed while reading: ${timelinePath}`);
        }
        authenticatedIdentity = afterRead;
    } finally {
        if (fileDescriptor != null) {
            try {
                fs.closeSync(fileDescriptor);
            } catch {
                // Best-effort descriptor cleanup.
            }
        }
    }

    if (!authenticatedIdentity || !retainedContent) {
        throw new Error(`Task timeline snapshot is unavailable: ${timelinePath}`);
    }
    const result = readBoundedJsonlTailBuffer<T>(retainedContent, authenticatedIdentity.size, limits);
    try {
        const afterParse = lstatFileIdentitySync(timelinePath);
        const realPathAfterParse = fs.realpathSync.native(timelinePath);
        if (
            !sameFileIdentity(authenticatedIdentity, afterParse)
            || afterParse.isSymbolicLink()
            || !hasExclusiveTimelineLink(afterParse)
            || !hasTrustedWriteAuthority(timelinePath, afterParse)
            || !isEventsRootBoundaryCurrent(boundary)
            || !isPathInside(realPathAfterParse, boundary.realEventsRoot)
        ) {
            throw new Error(`Task timeline snapshot changed while reading: ${timelinePath}`);
        }
    } catch (error: unknown) {
        if (error instanceof Error && error.message.includes('snapshot changed while reading')) {
            throw error;
        }
        throw new Error(`Task timeline snapshot changed while reading: ${timelinePath}`);
    }
    return result;
}

function captureTaskTimelineRead(snapshot: ActiveTaskTimelineReadSnapshot): CachedTaskTimelineRead {
    countNextStepWork('timeline_capture:' + snapshot.timelinePath);
    if (!isEventsRootBoundaryCurrent(snapshot)) {
        return invalidCachedRead();
    }
    let beforeRead: fs.Stats;
    try {
        beforeRead = fs.lstatSync(snapshot.timelinePath);
    } catch (error: unknown) {
        if (isMissingPathError(error)) {
            return {
                state: 'missing',
                identity: null,
                content: null,
                text: null,
                sha256: null,
                sha256State: null,
                memoizedValues: new Map()
            };
        }
        return invalidCachedRead();
    }
    if (beforeRead.size > MAX_TASK_TIMELINE_SNAPSHOT_BYTES) {
        throw new Error(
            `Task timeline exceeds the ${MAX_TASK_TIMELINE_SNAPSHOT_BYTES} byte read limit: `
            + snapshot.timelinePath
        );
    }
    if (
        !beforeRead.isFile()
        || beforeRead.isSymbolicLink()
        || !hasExclusiveTimelineLink(beforeRead)
        || !hasTrustedWriteAuthority(snapshot.timelinePath, beforeRead)
    ) {
        return invalidCachedRead();
    }

    let fileDescriptor: number | null = null;
    try {
        const realPathBeforeRead = fs.realpathSync.native(snapshot.timelinePath);
        if (!isPathInside(realPathBeforeRead, snapshot.realEventsRoot)) {
            return invalidCachedRead();
        }
        beforeRead = completePathFileIdentitySync(snapshot.timelinePath, beforeRead);
        // Descriptor acquisition authenticates identity but does not transfer timeline payload bytes.
        // Keep the full payload transfer below to exactly one read per capture.
        // Reject a final-file FIFO replacement without waiting for a writer.
        fileDescriptor = fs.openSync(snapshot.timelinePath,
            fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
        const openedIdentityBeforeRead = fs.fstatSync(fileDescriptor);
        if (
            openedIdentityBeforeRead.size > MAX_TASK_TIMELINE_SNAPSHOT_BYTES
            || !hasExclusiveTimelineLink(openedIdentityBeforeRead)
            || !hasTrustedWriteAuthority(snapshot.timelinePath, openedIdentityBeforeRead)
            || !sameFileIdentity(beforeRead, openedIdentityBeforeRead)
        ) {
            return invalidCachedRead();
        }
        countNextStepWork('timeline_payload_read:' + snapshot.timelinePath);
        const content = readTaskTimelineDescriptorPayload(
            fileDescriptor,
            openedIdentityBeforeRead.size
        );
        const openedIdentityAfterRead = fs.fstatSync(fileDescriptor);
        const afterRead = lstatFileIdentitySync(snapshot.timelinePath);
        const realPathAfterRead = fs.realpathSync.native(snapshot.timelinePath);
        if (
            !content
            || !hasExclusiveTimelineLink(openedIdentityAfterRead)
            || !hasExclusiveTimelineLink(afterRead)
            || !hasTrustedWriteAuthority(snapshot.timelinePath, openedIdentityAfterRead)
            || !hasTrustedWriteAuthority(snapshot.timelinePath, afterRead)
            || !sameFileIdentity(openedIdentityBeforeRead, openedIdentityAfterRead)
            || !sameFileIdentity(beforeRead, afterRead)
            || !sameFileIdentity(openedIdentityAfterRead, afterRead)
            || afterRead.isSymbolicLink()
            || !isPathInside(realPathAfterRead, snapshot.realEventsRoot)
        ) {
            return invalidCachedRead();
        }
        countNextStepWork('timeline_bytes', content.length);
        const sha256State = createHash('sha256').update(content);
        return {
            state: 'valid',
            identity: afterRead,
            content,
            text: null,
            sha256: sha256State.copy().digest('hex').toLowerCase(),
            sha256State,
            memoizedValues: new Map()
        };
    } catch {
        return invalidCachedRead();
    } finally {
        if (fileDescriptor != null) {
            try {
                fs.closeSync(fileDescriptor);
            } catch {
                // Best-effort descriptor cleanup.
            }
        }
    }
}

function revalidateCachedRead(snapshot: ActiveTaskTimelineReadSnapshot, cachedRead: CachedTaskTimelineRead): void {
    countNextStepWork('timeline_revalidate');
    countNextStepWork('timeline_revalidate:' + snapshot.timelinePath);
    if (cachedRead.state === 'invalid') {
        return;
    }
    if (!isEventsRootBoundaryCurrent(snapshot)) {
        invalidateCachedRead(cachedRead);
        return;
    }
    if (cachedRead.state === 'missing') {
        try {
            lstatFileIdentitySync(snapshot.timelinePath);
            invalidateCachedRead(cachedRead);
        } catch (error: unknown) {
            if (!isMissingPathError(error)) {
                invalidateCachedRead(cachedRead);
            }
        }
        return;
    }

    try {
        const currentIdentity = lstatFileIdentitySync(snapshot.timelinePath);
        const currentRealPath = fs.realpathSync.native(snapshot.timelinePath);
        if (
            !cachedRead.identity
            || currentIdentity.isSymbolicLink()
            || !hasExclusiveTimelineLink(currentIdentity)
            || !hasTrustedWriteAuthority(snapshot.timelinePath, currentIdentity)
            || !sameFileIdentity(cachedRead.identity, currentIdentity)
            || !isPathInside(currentRealPath, snapshot.realEventsRoot)
        ) {
            invalidateCachedRead(cachedRead);
        }
    } catch {
        invalidateCachedRead(cachedRead);
    }
}

function getActiveSnapshot(filePath: string): ActiveTaskTimelineReadSnapshot | null {
    return taskTimelineReadSnapshotStorage.getStore()?.get(normalizeSnapshotKey(filePath))
        || retainedInvocationTimelineSnapshots()?.get(normalizeSnapshotKey(filePath)) || null;
}

export function isTaskTimelineReadSnapshotActive(filePath: string): boolean {
    return getActiveSnapshot(filePath) !== null;
}

export function assertTaskTimelinePathMatchesTaskId(filePath: string, taskId: string): string {
    const safeTaskId = assertCanonicalTaskId(taskId);
    const timelinePath = path.resolve(filePath);
    const expectedTimelinePath = path.resolve(path.dirname(timelinePath), `${safeTaskId}.jsonl`);
    if (!sameResolvedPath(timelinePath, expectedTimelinePath)) {
        throw new Error(
            `Task timeline path does not match task ID '${safeTaskId}': ${timelinePath}`
        );
    }
    return safeTaskId;
}

function getCachedRead(snapshot: ActiveTaskTimelineReadSnapshot): CachedTaskTimelineRead {
    if (!snapshot.cachedRead) {
        snapshot.cachedRead = captureTaskTimelineRead(snapshot);
    } else if (!isInvocationReadObservationActive()) {
        revalidateCachedRead(snapshot, snapshot.cachedRead);
    }
    if (snapshot.cachedRead.state !== 'invalid') {
        // Retain the owner after nested snapshot release. Authenticated appends
        // replace cachedRead only after proving their exact post-write bytes.
        registerInvocationDependency(snapshot, () => {
            if (!snapshot.cachedRead) throw new Error(`Task timeline snapshot is unavailable: ${snapshot.timelinePath}`);
            revalidateCachedRead(snapshot, snapshot.cachedRead);
            if (snapshot.cachedRead.state === 'invalid') {
                throw new Error(`Task timeline snapshot is unavailable: ${snapshot.timelinePath}`);
            }
        });
    }
    return snapshot.cachedRead;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (
        value != null
        && (typeof value === 'object' || typeof value === 'function')
        && typeof (value as { then?: unknown }).then === 'function'
    );
}

function invokeWithinTaskTimelineSnapshot<T>(
    activeSnapshots: Map<string, ActiveTaskTimelineReadSnapshot>,
    snapshot: ActiveTaskTimelineReadSnapshot,
    snapshotKey: string,
    callback: () => T
): T {
    const release = () => {
        snapshot.depth -= 1;
        if (snapshot.depth <= 0 && !isInvocationReadObservationActive()) {
            activeSnapshots.delete(snapshotKey);
        }
    };

    let result: T;
    try {
        result = callback();
    } catch (error: unknown) {
        release();
        throw error;
    }
    if (isPromiseLike(result)) {
        return Promise.resolve(result).finally(release) as T;
    }
    release();
    return result;
}

export function withTaskTimelineFileReadSnapshot<T>(filePath: string, callback: () => T): T {
    const timelinePath = path.resolve(filePath);
    const resolvedEventsRoot = path.dirname(timelinePath);
    const snapshotKey = normalizeSnapshotKey(timelinePath);
    const activeSnapshots = taskTimelineReadSnapshotStorage.getStore();
    if (!activeSnapshots) {
        const invocationSnapshots = retainedInvocationTimelineSnapshots() || new Map<string, ActiveTaskTimelineReadSnapshot>();
        return taskTimelineReadSnapshotStorage.run(invocationSnapshots, () => (
            withTaskTimelineFileReadSnapshot(timelinePath, callback)
        ));
    }
    const existing = activeSnapshots.get(snapshotKey);
    if (existing) {
        existing.depth += 1;
        return invokeWithinTaskTimelineSnapshot(activeSnapshots, existing, snapshotKey, callback);
    }

    const eventsRootBoundary = captureEventsRootBoundary(resolvedEventsRoot, true);
    const snapshot: ActiveTaskTimelineReadSnapshot = {
        depth: 1,
        eventsRoot: eventsRootBoundary.eventsRoot,
        realEventsRoot: eventsRootBoundary.realEventsRoot,
        eventsRootIdentity: eventsRootBoundary.eventsRootIdentity,
        timelinePath,
        cachedRead: null
    };
    activeSnapshots.set(snapshotKey, snapshot);
    return invokeWithinTaskTimelineSnapshot(activeSnapshots, snapshot, snapshotKey, callback);
}

export function withTaskTimelineReadSnapshot<T>(
    eventsRoot: string,
    taskId: string,
    callback: () => T
): T {
    const safeTaskId = assertCanonicalTaskId(taskId);
    const resolvedEventsRoot = path.resolve(eventsRoot);
    const timelinePath = path.resolve(resolvedEventsRoot, `${safeTaskId}.jsonl`);
    if (!isPathInside(timelinePath, resolvedEventsRoot)) {
        throw new Error('Task timeline path must remain inside the events root.');
    }
    return withTaskTimelineFileReadSnapshot(timelinePath, callback);
}

export function readTaskTimelineFileSnapshot(filePath: string): TaskTimelineFileReadSnapshot {
    const snapshot = getActiveSnapshot(filePath);
    if (!snapshot) {
        return { active: false, exists: false, valid: false, content: null, sha256: null };
    }
    let cachedRead: CachedTaskTimelineRead;
    try {
        cachedRead = getCachedRead(snapshot);
    } catch {
        return { active: true, exists: false, valid: false, content: null, sha256: null };
    }
    return {
        active: true,
        exists: cachedRead.state === 'valid',
        valid: cachedRead.state !== 'invalid',
        content: cachedRead.content ? Buffer.from(cachedRead.content) : null,
        sha256: cachedRead.sha256
    };
}

export function readTaskTimelineFileMetadataSnapshot(filePath: string): TaskTimelineFileMetadataSnapshot {
    const snapshot = getActiveSnapshot(filePath);
    if (!snapshot) {
        return { active: false, exists: false, valid: false, sha256: null };
    }
    let cachedRead: CachedTaskTimelineRead;
    try {
        cachedRead = getCachedRead(snapshot);
    } catch {
        return { active: true, exists: false, valid: false, sha256: null };
    }
    return {
        active: true,
        exists: cachedRead.state === 'valid',
        valid: cachedRead.state !== 'invalid',
        sha256: cachedRead.sha256
    };
}

export function taskTimelineAwareFileExists(filePath: string): boolean {
    const snapshot = getActiveSnapshot(filePath);
    if (!snapshot) {
        return withTaskTimelineFileReadSnapshot(filePath, () => taskTimelineAwareFileExists(filePath));
    }
    const cachedRead = getCachedRead(snapshot);
    if (cachedRead.state === 'invalid') {
        throw new Error(`Task timeline snapshot is unavailable: ${snapshot.timelinePath}`);
    }
    return cachedRead.state === 'valid';
}

export function captureTaskTimelineReadSnapshotSha256(filePath: string): string {
    const snapshot = getActiveSnapshot(filePath);
    if (!snapshot) {
        throw new Error(`Task timeline read snapshot is not active: ${path.resolve(filePath)}`);
    }
    const cachedRead = getCachedRead(snapshot);
    if (cachedRead.state !== 'valid' || !cachedRead.sha256) {
        throw new Error(`Task timeline snapshot is unavailable: ${snapshot.timelinePath}`);
    }
    return cachedRead.sha256;
}

export function assertTaskTimelineReadSnapshotCurrent(
    filePath: string,
    expectedSha256: string
): void {
    const snapshot = getActiveSnapshot(filePath);
    if (!snapshot) {
        throw new Error(`Task timeline read snapshot is not active: ${path.resolve(filePath)}`);
    }
    const cachedRead = getCachedRead(snapshot);
    if (
        cachedRead.state !== 'valid'
        || !cachedRead.sha256
        || cachedRead.sha256 !== expectedSha256
    ) {
        return failChangedSnapshot(cachedRead, snapshot.timelinePath);
    }
}

function failChangedAppendAuthority(timelinePath: string): never {
    throw new Error(`Task timeline append authority changed before write: ${timelinePath}`);
}

export function captureTaskTimelineAppendAuthority(filePath: string): TaskTimelineAppendAuthority {
    const timelinePath = path.resolve(filePath);
    const boundary = captureEventsRootBoundary(path.dirname(timelinePath), false);
    let beforeCapture: fs.Stats;
    try {
        beforeCapture = fs.lstatSync(timelinePath);
    } catch (error: unknown) {
        if (isMissingPathError(error)) {
            if (!isEventsRootBoundaryCurrent(boundary)) {
                return failChangedAppendAuthority(timelinePath);
            }
            return {
                ...boundary,
                timelinePath,
                timelineIdentity: null
            };
        }
        return failChangedAppendAuthority(timelinePath);
    }

    if (
        !beforeCapture.isFile()
        || beforeCapture.isSymbolicLink()
        || !hasExclusiveTimelineLink(beforeCapture)
        || beforeCapture.size > MAX_TASK_TIMELINE_SNAPSHOT_BYTES
        || !hasTrustedWriteAuthority(timelinePath, beforeCapture)
    ) {
        return failChangedAppendAuthority(timelinePath);
    }
    try {
        const realTimelinePath = fs.realpathSync.native(timelinePath);
        if (!isPathInside(realTimelinePath, boundary.realEventsRoot)) {
            return failChangedAppendAuthority(timelinePath);
        }
        beforeCapture = completePathFileIdentitySync(timelinePath, beforeCapture);
        const afterCapture = lstatFileIdentitySync(timelinePath);
        if (
            !isPathInside(realTimelinePath, boundary.realEventsRoot)
            || !sameFileIdentity(beforeCapture, afterCapture)
            || !hasExclusiveTimelineLink(afterCapture)
            || !hasTrustedWriteAuthority(timelinePath, afterCapture)
            || !isEventsRootBoundaryCurrent(boundary)
        ) {
            return failChangedAppendAuthority(timelinePath);
        }
        return {
            ...boundary,
            timelinePath,
            timelineIdentity: afterCapture
        };
    } catch {
        return failChangedAppendAuthority(timelinePath);
    }
}

function assertTaskTimelineAppendAuthorityCurrent(
    filePath: string,
    authority: TaskTimelineAppendAuthority
): void {
    const timelinePath = path.resolve(filePath);
    if (
        !sameResolvedPath(timelinePath, authority.timelinePath)
        || !isEventsRootBoundaryCurrent(authority)
    ) {
        return failChangedAppendAuthority(authority.timelinePath);
    }

    let currentIdentity: fs.Stats;
    try {
        currentIdentity = lstatFileIdentitySync(authority.timelinePath);
    } catch (error: unknown) {
        if (isMissingPathError(error) && !authority.timelineIdentity) {
            return;
        }
        return failChangedAppendAuthority(authority.timelinePath);
    }
    if (!authority.timelineIdentity) {
        return failChangedAppendAuthority(authority.timelinePath);
    }
    try {
        const currentRealPath = fs.realpathSync.native(authority.timelinePath);
        if (
            !currentIdentity.isFile()
            || currentIdentity.isSymbolicLink()
            || !hasExclusiveTimelineLink(currentIdentity)
            || !hasTrustedWriteAuthority(authority.timelinePath, currentIdentity)
            || !sameFileIdentity(authority.timelineIdentity, currentIdentity)
            || !isPathInside(currentRealPath, authority.realEventsRoot)
        ) {
            return failChangedAppendAuthority(authority.timelinePath);
        }
    } catch {
        return failChangedAppendAuthority(authority.timelinePath);
    }
}

function assertAppendAuthorityDescriptorIdentity(
    authority: TaskTimelineAppendAuthority,
    fileDescriptor: number
): fs.Stats {
    const descriptorIdentity = fs.fstatSync(fileDescriptor);
    const pathIdentity = lstatFileIdentitySync(authority.timelinePath);
    const realPath = fs.realpathSync.native(authority.timelinePath);
    if (
        !descriptorIdentity.isFile()
        || descriptorIdentity.isSymbolicLink()
        || !hasExclusiveTimelineLink(descriptorIdentity)
        || !hasTrustedWriteAuthority(authority.timelinePath, descriptorIdentity)
        || !pathIdentity.isFile()
        || pathIdentity.isSymbolicLink()
        || !hasExclusiveTimelineLink(pathIdentity)
        || !hasTrustedWriteAuthority(authority.timelinePath, pathIdentity)
        || !isEventsRootBoundaryCurrent(authority)
        || !sameFileIdentity(descriptorIdentity, pathIdentity)
        || !isPathInside(realPath, authority.realEventsRoot)
        || (authority.timelineIdentity
            && !sameFileIdentity(authority.timelineIdentity, descriptorIdentity))
    ) {
        return failChangedAppendAuthority(authority.timelinePath);
    }
    return descriptorIdentity;
}

function assertAppendAuthorityPostWriteIdentity(
    authority: TaskTimelineAppendAuthority,
    fileDescriptor: number,
    expectedSize: number
): void {
    const descriptorIdentity = fs.fstatSync(fileDescriptor);
    const pathIdentity = lstatFileIdentitySync(authority.timelinePath);
    const realPath = fs.realpathSync.native(authority.timelinePath);
    if (
        !descriptorIdentity.isFile()
        || descriptorIdentity.isSymbolicLink()
        || !hasExclusiveTimelineLink(descriptorIdentity)
        || !hasTrustedWriteAuthority(authority.timelinePath, descriptorIdentity)
        || !pathIdentity.isFile()
        || pathIdentity.isSymbolicLink()
        || !hasExclusiveTimelineLink(pathIdentity)
        || !hasTrustedWriteAuthority(authority.timelinePath, pathIdentity)
        || !isEventsRootBoundaryCurrent(authority)
        || !sameFileIdentity(descriptorIdentity, pathIdentity)
        || !isPathInside(realPath, authority.realEventsRoot)
        || descriptorIdentity.size !== expectedSize
        || (authority.timelineIdentity
            && !sameNodeIdentity(authority.timelineIdentity, descriptorIdentity))
    ) {
        return failChangedAppendAuthority(authority.timelinePath);
    }
}

function writeTaskTimelineAppendBytes(
    fileDescriptor: number,
    appendBytes: Buffer,
    timelinePath: string
): void {
    let offset = 0;
    while (offset < appendBytes.length) {
        const written = fs.writeSync(fileDescriptor, appendBytes, offset, appendBytes.length - offset);
        if (written <= 0) {
            throw new Error(`Failed to append task timeline: ${timelinePath}`);
        }
        offset += written;
    }
}

function buildTaskTimelineAppendBytes(existingContent: Buffer, serializedLine: string): Buffer {
    const separator = existingContent.length > 0 && existingContent[existingContent.length - 1] !== 0x0A
        ? '\n'
        : '';
    return Buffer.from(`${separator}${serializedLine}\n`, 'utf8');
}

/**
 * Revalidate an already captured timeline immediately before a writer mutates it.
 * This deliberately checks metadata and path identity only; the append's
 * post-write authentication performs the bounded second payload capture.
 */
export function assertTaskTimelineAppendPrecondition(filePath: string): void {
    const snapshot = getActiveSnapshot(filePath);
    if (!snapshot || !snapshot.cachedRead) {
        return;
    }

    const cachedRead = snapshot.cachedRead;
    revalidateCachedRead(snapshot, cachedRead);
    if (cachedRead.state === 'invalid') {
        throw new Error(`Task timeline snapshot changed while reading: ${snapshot.timelinePath}`);
    }
}

function assertAppendDescriptorIdentity(
    snapshot: ActiveTaskTimelineReadSnapshot,
    cachedRead: CachedTaskTimelineRead,
    fileDescriptor: number
): void {
    const descriptorIdentity = fs.fstatSync(fileDescriptor);
    const pathIdentity = lstatFileIdentitySync(snapshot.timelinePath);
    const realPath = fs.realpathSync.native(snapshot.timelinePath);
    if (
        !descriptorIdentity.isFile()
        || descriptorIdentity.isSymbolicLink()
        || !hasExclusiveTimelineLink(descriptorIdentity)
        || !hasTrustedWriteAuthority(snapshot.timelinePath, descriptorIdentity)
        || !pathIdentity.isFile()
        || pathIdentity.isSymbolicLink()
        || !hasExclusiveTimelineLink(pathIdentity)
        || !hasTrustedWriteAuthority(snapshot.timelinePath, pathIdentity)
        || !isEventsRootBoundaryCurrent(snapshot)
        || !sameFileIdentity(descriptorIdentity, pathIdentity)
        || !isPathInside(realPath, snapshot.realEventsRoot)
        || (cachedRead.state === 'valid'
            && (!cachedRead.identity || !sameFileIdentity(cachedRead.identity, descriptorIdentity)))
    ) {
        return failChangedSnapshot(cachedRead, snapshot.timelinePath);
    }
}

function assertAppendDescriptorPostWriteIdentity(
    snapshot: ActiveTaskTimelineReadSnapshot,
    cachedRead: CachedTaskTimelineRead,
    fileDescriptor: number,
    expectedSize: number
): fs.Stats {
    const descriptorIdentity = fs.fstatSync(fileDescriptor);
    const pathIdentity = lstatFileIdentitySync(snapshot.timelinePath);
    const realPath = fs.realpathSync.native(snapshot.timelinePath);
    if (
        !descriptorIdentity.isFile()
        || descriptorIdentity.isSymbolicLink()
        || !hasExclusiveTimelineLink(descriptorIdentity)
        || !hasTrustedWriteAuthority(snapshot.timelinePath, descriptorIdentity)
        || !pathIdentity.isFile()
        || pathIdentity.isSymbolicLink()
        || !hasExclusiveTimelineLink(pathIdentity)
        || !hasTrustedWriteAuthority(snapshot.timelinePath, pathIdentity)
        || !isEventsRootBoundaryCurrent(snapshot)
        || !sameFileIdentity(descriptorIdentity, pathIdentity)
        || !isPathInside(realPath, snapshot.realEventsRoot)
        || descriptorIdentity.size !== expectedSize
        || (cachedRead.state === 'valid'
            && (!cachedRead.identity || !sameNodeIdentity(cachedRead.identity, descriptorIdentity)))
    ) {
        return failChangedSnapshot(cachedRead, snapshot.timelinePath);
    }
    return descriptorIdentity;
}

/**
 * Append through an authenticated descriptor while a read snapshot is active.
 * The descriptor is opened after the precondition and all path/identity checks
 * are repeated on that descriptor before any event bytes are transferred.
 */
export function appendTaskTimelineLineSync(
    filePath: string,
    serializedLine: string,
    appendAuthority?: TaskTimelineAppendAuthority
): void {
    const snapshot = getActiveSnapshot(filePath);
    if (!snapshot) {
        const authority = appendAuthority || captureTaskTimelineAppendAuthority(filePath);
        assertTaskTimelineAppendAuthorityCurrent(filePath, authority);
        const existingSize = authority.timelineIdentity?.size || 0;
        const flags = authority.timelineIdentity
            ? fs.constants.O_RDWR | fs.constants.O_APPEND
            : fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL;
        let fileDescriptor: number | null = null;
        try {
            fileDescriptor = fs.openSync(authority.timelinePath, flags, TASK_TIMELINE_FILE_CREATE_MODE);
            const descriptorIdentity = assertAppendAuthorityDescriptorIdentity(authority, fileDescriptor);
            if (descriptorIdentity.size !== existingSize) {
                return failChangedAppendAuthority(authority.timelinePath);
            }
            const existingContent = readTaskTimelineDescriptorPayload(fileDescriptor, existingSize);
            if (existingContent == null) {
                return failChangedAppendAuthority(authority.timelinePath);
            }
            assertAppendAuthorityDescriptorIdentity(authority, fileDescriptor);
            const appendBytes = buildTaskTimelineAppendBytes(existingContent, serializedLine);
            if (taskTimelineAppendExceedsSnapshotLimit(existingContent.length, appendBytes.length)) {
                throw new Error(
                    `Task timeline append exceeds the ${MAX_TASK_TIMELINE_SNAPSHOT_BYTES} byte snapshot limit: `
                    + authority.timelinePath
                );
            }
            const expectedSize = existingContent.length + appendBytes.length;
            const expectedSha256 = createHash('sha256')
                .update(existingContent)
                .update(appendBytes)
                .digest('hex')
                .toLowerCase();
            writeTaskTimelineAppendBytes(fileDescriptor, appendBytes, authority.timelinePath);
            assertAppendAuthorityPostWriteIdentity(
                authority,
                fileDescriptor,
                expectedSize
            );
            const authenticatedContent = readTaskTimelineDescriptorPayload(
                fileDescriptor,
                expectedSize
            );
            assertAppendAuthorityPostWriteIdentity(
                authority,
                fileDescriptor,
                expectedSize
            );
            if (
                !authenticatedContent
                || createHash('sha256').update(authenticatedContent).digest('hex').toLowerCase() !== expectedSha256
            ) {
                return failChangedAppendAuthority(authority.timelinePath);
            }
        } finally {
            if (fileDescriptor != null) {
                try {
                    fs.closeSync(fileDescriptor);
                } catch {
                    // Best-effort descriptor cleanup.
                }
            }
        }
        return;
    }

    if (appendAuthority) {
        assertTaskTimelineAppendAuthorityCurrent(filePath, appendAuthority);
    }
    const cachedRead = getCachedRead(snapshot);
    assertTaskTimelineAppendPrecondition(filePath);
    if (cachedRead.state === 'invalid') {
        throw new Error(`Task timeline snapshot changed while reading: ${snapshot.timelinePath}`);
    }

    const existingSize = cachedRead.state === 'valid'
        ? cachedRead.identity?.size
        : 0;
    const existingContent = cachedRead.state === 'valid'
        ? cachedRead.content
        : Buffer.alloc(0);
    if (!existingContent) {
        return failChangedSnapshot(cachedRead, snapshot.timelinePath);
    }
    const appendBytes = buildTaskTimelineAppendBytes(existingContent, serializedLine);
    if (
        existingSize == null
        || taskTimelineAppendExceedsSnapshotLimit(existingSize, appendBytes.length)
    ) {
        throw new Error(
            `Task timeline append exceeds the ${MAX_TASK_TIMELINE_SNAPSHOT_BYTES} byte snapshot limit: `
            + snapshot.timelinePath
        );
    }
    const flags = cachedRead.state === 'missing'
        ? fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL
        : fs.constants.O_WRONLY | fs.constants.O_APPEND;
    let fileDescriptor: number | null = null;
    try {
        fileDescriptor = fs.openSync(snapshot.timelinePath, flags, TASK_TIMELINE_FILE_CREATE_MODE);
        assertAppendDescriptorIdentity(snapshot, cachedRead, fileDescriptor);
        writeTaskTimelineAppendBytes(fileDescriptor, appendBytes, snapshot.timelinePath);
        const postWriteIdentity = assertAppendDescriptorPostWriteIdentity(
            snapshot,
            cachedRead,
            fileDescriptor,
            existingSize + appendBytes.length
        );
        recordTaskTimelineAppendInSnapshot(filePath, appendBytes, postWriteIdentity);
        assertAppendDescriptorPostWriteIdentity(
            snapshot,
            cachedRead,
            fileDescriptor,
            existingSize + appendBytes.length
        );
    } finally {
        if (fileDescriptor != null) {
            try {
                fs.closeSync(fileDescriptor);
            } catch {
                // Best-effort descriptor cleanup.
            }
        }
    }
}

function recordTaskTimelineAppendInSnapshot(
    filePath: string,
    appendedContent: Buffer,
    expectedIdentity: fs.Stats
): void {
    const snapshot = getActiveSnapshot(filePath);
    if (!snapshot || !snapshot.cachedRead) {
        return;
    }
    const cachedRead = snapshot.cachedRead;
    if (cachedRead.state === 'invalid') {
        throw new Error(`Task timeline snapshot changed while reading: ${snapshot.timelinePath}`);
    }

    let expectedByteLength: number;
    let expectedSha256: string;
    if (cachedRead.state === 'missing') {
        expectedByteLength = appendedContent.length;
        expectedSha256 = createHash('sha256')
            .update(appendedContent)
            .digest('hex')
            .toLowerCase();
    } else {
        if (!cachedRead.identity || !cachedRead.content || !cachedRead.sha256State) {
            return failChangedSnapshot(cachedRead, snapshot.timelinePath);
        }
        expectedByteLength = cachedRead.content.length + appendedContent.length;
        expectedSha256 = cachedRead.sha256State
            .copy()
            .update(appendedContent)
            .digest('hex')
            .toLowerCase();
    }

    const authenticatedAppendRead = captureTaskTimelineRead(snapshot);
    if (
        authenticatedAppendRead.state !== 'valid'
        || !authenticatedAppendRead.identity
        || !authenticatedAppendRead.content
        || !sameFileIdentity(expectedIdentity, authenticatedAppendRead.identity)
        || authenticatedAppendRead.content.length !== expectedByteLength
        || authenticatedAppendRead.sha256 !== expectedSha256
    ) {
        return failChangedSnapshot(cachedRead, snapshot.timelinePath);
    }

    snapshot.cachedRead = authenticatedAppendRead;
}

export function memoizeTaskTimelineSnapshot<T>(
    filePath: string,
    key: TaskTimelineMemoizationKey<T>,
    memoKey: string,
    buildValue: (content: string) => T,
    maxByteLength?: number
): TaskTimelineMemoizedRead<T> {
    return memoizeTaskTimelineSnapshotValue(filePath, key, memoKey, cachedRead => {
        cachedRead.text ??= (cachedRead.content as Buffer).toString('utf8');
        return buildValue(cachedRead.text);
    }, maxByteLength);
}

function memoizeTaskTimelineSnapshotValue<T>(
    filePath: string,
    key: TaskTimelineMemoizationKey<T>,
    memoKey: string,
    buildValue: (cachedRead: CachedTaskTimelineRead) => T,
    maxByteLength?: number
): TaskTimelineMemoizedRead<T> {
    const normalizedMemoKey = String(memoKey || '').trim();
    if (!normalizedMemoKey) {
        throw new Error('Task timeline memoization entry key is required.');
    }
    if (maxByteLength != null && (!Number.isSafeInteger(maxByteLength) || maxByteLength <= 0)) {
        throw new Error('Task timeline memoization maxByteLength must be a positive safe integer.');
    }
    const snapshot = getActiveSnapshot(filePath);
    if (!snapshot) {
        return { active: false, exists: false, valid: false, byteLength: null, value: null };
    }
    const cachedRead = getCachedRead(snapshot);
    if (cachedRead.state !== 'valid' || !cachedRead.content) {
        return {
            active: true,
            exists: false,
            valid: cachedRead.state === 'missing',
            byteLength: cachedRead.state === 'missing' ? 0 : null,
            value: null
        };
    }
    if (maxByteLength != null && cachedRead.content.length > maxByteLength) {
        throw new Error(`Task timeline exceeds the ${maxByteLength} byte read limit: ${filePath}`);
    }
    const value = memoizeCachedTaskTimelineValue(
        cachedRead,
        key,
        normalizedMemoKey,
        () => buildValue(cachedRead)
    );
    if (!isInvocationReadObservationActive()) revalidateCachedRead(snapshot, cachedRead);
    if (
        snapshot.cachedRead !== cachedRead
        || cachedRead.state !== 'valid'
        || !cachedRead.content
    ) {
        return {
            active: true,
            exists: false,
            valid: false,
            byteLength: null,
            value: null
        };
    }
    return {
        active: true,
        exists: true,
        valid: true,
        byteLength: cachedRead.content.length,
        value: value as TaskTimelineDeepReadonly<T>
    };
}

export function readTaskTimelineTextFile(filePath: string): string {
    if (!getActiveSnapshot(filePath)) {
        return withTaskTimelineFileReadSnapshot(filePath, () => readTaskTimelineTextFile(filePath));
    }
    const memoized = memoizeTaskTimelineSnapshot(
        filePath,
        TASK_TIMELINE_TEXT_MEMOIZATION_KEY,
        'default',
        (content) => content,
        MAX_TASK_TIMELINE_SNAPSHOT_BYTES
    );
    if (!memoized.valid || !memoized.exists || memoized.value == null) {
        throw new Error(`Task timeline snapshot is unavailable: ${path.resolve(filePath)}`);
    }
    return memoized.value;
}

function cloneBoundedResult<T>(result: BoundedJsonlTailResult<T>): BoundedJsonlTailResult<T> {
    return {
        ...result,
        records: result.records.map((record) => { countNextStepWork('visit:timeline_cloned_event'); return structuredClone(record); }),
        limits: { ...result.limits }
    };
}

export function readTaskTimelineBoundedJsonlTail<T>(
    filePath: string,
    limits: BoundedJsonlTailLimits
): BoundedJsonlTailResult<T> {
    const normalizedLimits = normalizeBoundedJsonlTailLimits(limits);
    if (!getActiveSnapshot(filePath)) return readAuthenticatedTaskTimelineBoundedJsonlTail<T>(filePath, normalizedLimits);
    return cloneBoundedResult(readImmutableTaskTimelineBoundedJsonlTail<T>(filePath, normalizedLimits) as BoundedJsonlTailResult<T>);
}

/** Internal readonly delivery; mutable public callers retain the explicit copy above. */
export function readImmutableTaskTimelineBoundedJsonlTail<T>(
    filePath: string,
    limits: BoundedJsonlTailLimits
): TaskTimelineDeepReadonly<BoundedJsonlTailResult<T>> {
    const normalizedLimits = normalizeBoundedJsonlTailLimits(limits);
    const snapshot = getActiveSnapshot(filePath);
    if (!snapshot) {
        return deepFreezeMemoizedValue(readAuthenticatedTaskTimelineBoundedJsonlTail<T>(filePath, normalizedLimits)) as TaskTimelineDeepReadonly<BoundedJsonlTailResult<T>>;
    }
    const cachedRead = getCachedRead(snapshot);
    if (cachedRead.state !== 'valid' || !cachedRead.content) {
        throw new Error(`Task timeline snapshot is unavailable: ${path.resolve(filePath)}`);
    }
    const memoKey = `bounded-tail-v1:${normalizedLimits.maxBytes}:${normalizedLimits.maxLines}:${normalizedLimits.maxEvents}:${normalizedLimits.maxParseAttempts}`;
    const result = memoizeCachedTaskTimelineValue(
        cachedRead,
        TASK_TIMELINE_BOUNDED_TAIL_MEMOIZATION_KEY,
        memoKey,
        () => readBoundedJsonlTailBuffer<unknown>(
            cachedRead.content as Buffer,
            cachedRead.content?.length || 0,
            normalizedLimits
        )
    );

    if (!isInvocationReadObservationActive()) revalidateCachedRead(snapshot, cachedRead);
    if (
        snapshot.cachedRead !== cachedRead
        || cachedRead.state !== 'valid'
        || !cachedRead.sha256
    ) {
        return failChangedSnapshot(cachedRead, snapshot.timelinePath);
    }
    return result as TaskTimelineDeepReadonly<BoundedJsonlTailResult<T>>;
}

export interface TaskTimelineByteLine {
    readonly rawLine: string;
    readonly lineNumber: number;
    readonly startByte: number;
}

export interface TaskTimelineByteLineVisitResult {
    readonly lineCount: number;
    readonly trailingWhitespaceCompatible: boolean;
}

/** Internal parser adapter; consumers receive immutable text/offsets, never the private mutable Buffer. */
export function memoizeTaskTimelineSnapshotByteLines<T>(
    filePath: string, key: TaskTimelineMemoizationKey<T>, memoKey: string,
    buildValue: (visitLines: (visit: (line: TaskTimelineByteLine) => void) => TaskTimelineByteLineVisitResult) => T,
    maxByteLength: number, maxLines: number
): TaskTimelineMemoizedRead<T> {
    const snapshot = getActiveSnapshot(filePath);
    if (!snapshot) return { active: false, exists: false, valid: false, byteLength: null, value: null };
    return memoizeTaskTimelineSnapshotValue(filePath, key, memoKey, captured => buildValue(visit => {
        const source = captured.content;
        if (!source) throw new Error(`Task timeline snapshot is unavailable: ${filePath}`);
        const ends: number[] = [];
        let start = 0;
        for (let newline = source.indexOf(0x0a); newline >= 0; newline = source.indexOf(0x0a, start)) {
            ends.push(newline);
            if (ends.length > maxLines) throw new Error(`Task timeline exceeds the ${maxLines} line limit.`);
            start = newline + 1;
        }
        // Match splitTaskTimelineJsonlLines: discard only the final whitespace-only fragment.
        const finalFragment = source.subarray(start).toString('utf8');
        const hasFinalRecord = !!finalFragment.trim();
        if (hasFinalRecord) ends.push(source.length);
        if (ends.length > maxLines) throw new Error(`Task timeline exceeds the ${maxLines} line limit.`);
        start = 0;
        for (let index = 0; index < ends.length; index += 1) {
            visit({ rawLine: source.subarray(start, ends[index]).toString('utf8'), lineNumber: index + 1, startByte: start });
            start = ends[index] + 1;
        }
        return { lineCount: ends.length,
            trailingWhitespaceCompatible: hasFinalRecord || finalFragment.length === 0 };
    }), maxByteLength);
}

export function captureTaskTimelineReadSnapshotByteLength(filePath: string): number {
    const snapshot = getActiveSnapshot(filePath);
    if (!snapshot) throw new Error(`Task timeline read snapshot is not active: ${path.resolve(filePath)}`);
    const captured = getCachedRead(snapshot);
    if (captured.state === 'invalid') throw new Error(`Task timeline snapshot is unavailable: ${snapshot.timelinePath}`);
    return captured.content?.length || 0;
}

// Add inside task-timeline-read-snapshot.ts; no Buffer leaves the snapshot.
export function readTaskTimelineSnapshotByteLength(filePath: string): number | null {
    const snapshot = getActiveSnapshot(filePath);
    if (!snapshot) return null;
    try {
        const cached = getCachedRead(snapshot);
        return cached.state === 'valid' && cached.content ? cached.content.length : null;
    } catch { return null; }
}
