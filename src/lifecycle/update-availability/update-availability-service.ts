import * as crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assertContainedDestination, bindContainedDestination } from '../../core/contained-filesystem';
import { withFilesystemLockAsync } from '../../gate-runtime/task-events-locking';
import { compareVersionStrings } from '../common';
import { queryNpmUpdateMetadata } from '../check-update/check-update-source';
import { buildUpdateCommand } from './update-availability-notice';
import { checkUpdateAvailabilityInProcess, readUpdateAvailabilityInProcess } from './update-availability-client';
import { isUpdateMetadata, resolveUpdateAvailabilitySource, resolveUpdateAvailabilitySourceAsync } from './update-availability-source';
import { isAutomaticUpdateCacheBlocked, isUpdateCacheFresh, prepareUpdateCache, readUpdateCache, readUpdateCacheStateAsync, updateCachePaths, writeUpdateCache } from './update-availability-cache';
import {
    UPDATE_CHECK_OPT_OUT_ENV, UPDATE_CHECK_TIMEOUT_MS,
    type UpdateAvailabilityCacheEntry, type UpdateAvailabilityService, type UpdateAvailabilityServiceOptions,
    type UpdateAvailabilityClaim, type UpdateAvailabilitySource, type UpdateAvailabilityView, type UpdateMetadata
} from './update-availability-types';

const inFlight = new Map<string, Promise<void>>();
const cacheQueue = new Map<string, Promise<void>>();
const CLAIM_POLL_INITIAL_MS = 100;
const CLAIM_POLL_MAX_MS = 1_000;
const unavailable = (): UpdateAvailabilityView => ({ status: 'unavailable', currentVersion: null, latestVersion: null, updateCommand: null });
const flightKey = (source: UpdateAvailabilitySource): string => `${source.bundleRoot}:${source.fingerprint}`;

function viewFor(source: UpdateAvailabilitySource, entry: UpdateAvailabilityCacheEntry | null, now: number, automaticBlocked?: boolean): UpdateAvailabilityView {
    const result: UpdateAvailabilityView = { status: 'unknown', currentVersion: source.currentVersion, latestVersion: null, updateCommand: null };
    if (inFlight.has(flightKey(source))) return { ...result, status: 'checking' };
    if (!isUpdateCacheFresh(entry, now)) return (automaticBlocked ?? isAutomaticUpdateCacheBlocked(source, now)) ? { ...result, status: 'unavailable' } : result;
    if (entry?.outcome === 'pending' && now - entry.attemptedAt < UPDATE_CHECK_TIMEOUT_MS + 1_000) return { ...result, status: 'checking' };
    if (entry?.outcome !== 'success' || !entry.metadata) return { ...result, status: 'unavailable' };
    const newer = compareVersionStrings(source.currentVersion, entry.metadata.version) < 0;
    return { ...result, status: newer ? 'available' : 'up_to_date', latestVersion: entry.metadata.version,
        updateCommand: newer ? buildUpdateCommand(source.cwd) : null };
}

/** Read only. Isolate filesystem probes so even synchronous I/O cannot block the caller deadline. */
export function readCachedUpdateAvailabilityView(repoRoot: string, now?: () => number): Promise<UpdateAvailabilityView> {
    return readUpdateAvailabilityInProcess(repoRoot, now?.());
}

/** Internal read-only child entrypoint; never schedules or performs a metadata query. */
export async function readCachedUpdateAvailabilityLocally(repoRoot: string, now: () => number = Date.now): Promise<UpdateAvailabilityView> {
    try {
        const source = await resolveUpdateAvailabilitySourceAsync(repoRoot);
        const cached = await readUpdateCacheStateAsync(source, now());
        const current = await resolveUpdateAvailabilitySourceAsync(repoRoot);
        if (current.fingerprint !== source.fingerprint || current.currentVersion !== source.currentVersion) return unavailable();
        return viewFor(current, cached.entry, now(), cached.automaticBlocked);
    } catch { return unavailable(); }
}

async function boundedMetadataQuery(source: UpdateAvailabilitySource, options: UpdateAvailabilityServiceOptions): Promise<UpdateMetadata> {
    const timeoutMs = options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Update metadata check timed out.')); }, timeoutMs);
    });
    const query = options.queryMetadata || ((input: UpdateAvailabilitySource, signal: AbortSignal) =>
        queryNpmUpdateMetadata({ packageSpec: input.packageSpec, cwd: input.cwd, signal, timeoutMs }));
    try {
        const metadata = await Promise.race([Promise.resolve().then(() => query(source, controller.signal)), timeout]);
        if (!isUpdateMetadata(metadata)) throw new Error('Update metadata is invalid.');
        return metadata;
    } finally { clearTimeout(timer); }
}

function pendingEntry(source: UpdateAvailabilitySource, now: number): UpdateAvailabilityCacheEntry {
    return {
        schema: 1, sourceFingerprint: source.fingerprint, packageSpec: source.packageSpec,
        trustPolicy: source.trustPolicy, transport: source.transport,
        attemptId: crypto.randomBytes(16).toString('hex'), attemptedAt: now, outcome: 'pending', metadata: null
    };
}

async function withCacheLock<T>(source: UpdateAvailabilitySource, timeoutMs: number, action: () => Promise<T>): Promise<T> {
    const previous = cacheQueue.get(source.bundleRoot) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => held);
    cacheQueue.set(source.bundleRoot, queued);
    await previous;
    try {
        return await withPhysicalCacheLock(source, timeoutMs, action);
    } finally {
        release();
        if (cacheQueue.get(source.bundleRoot) === queued) cacheQueue.delete(source.bundleRoot);
    }
}

async function withPhysicalCacheLock<T>(source: UpdateAvailabilitySource, timeoutMs: number, action: () => Promise<T>): Promise<T> {
    prepareUpdateCache(source);
    const paths = updateCachePaths(source);
    const directoryBinding = bindContainedDestination(source.bundleRoot, paths.directory);
    const locked = await withFilesystemLockAsync(paths.lock, {
        timeoutMs,
        requireKnownDeadOwner: true, ownerLabel: 'update-availability'
    }, async () => {
        assertContainedDestination(directoryBinding);
        const result = await action();
        assertContainedDestination(directoryBinding);
        return result;
    });
    return locked.result;
}

async function checkLocked(source: UpdateAvailabilitySource, manual: boolean, options: UpdateAvailabilityServiceOptions, claim?: UpdateAvailabilityClaim): Promise<void> {
    const now = options.now || Date.now;
    if (claim && (claim.sourceFingerprint !== source.fingerprint || !/^[a-f0-9]{32}$/u.test(claim.attemptId))) return;
    const observed = readUpdateCache(source, now());
    const lockTimeout = (options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS) + 1_000;
    const owned = await withCacheLock(source, lockTimeout, async () => {
        const cached = readUpdateCache(source, now());
        if (claim && (cached?.attemptId !== claim.attemptId || cached.outcome !== 'pending' || !isUpdateCacheFresh(cached, now()))) return;
        if (!claim && cached?.outcome === 'pending' && now() - cached.attemptedAt < UPDATE_CHECK_TIMEOUT_MS + 1_000) return;
        const completedObservedRequest = observed?.outcome === 'pending' && cached?.outcome !== 'pending';
        if (!claim && isUpdateCacheFresh(cached, now()) && (!manual || cached?.attemptId !== observed?.attemptId || completedObservedRequest)) return;
        if (!manual && !claim && isAutomaticUpdateCacheBlocked(source, now())) return;
        // Consume launch claims by replacing their nonce before releasing the lock.
        const entry = claim && cached ? { ...cached, attemptId: crypto.randomBytes(16).toString('hex') } : pendingEntry(source, now());
        writeUpdateCache(source, entry, now());
        return { entry, binding: bindContainedDestination(source.bundleRoot, updateCachePaths(source).directory) };
    });
    if (!owned) return;
    const { entry, binding } = owned;
    try {
        if (resolveUpdateAvailabilitySource(source.cwd).fingerprint !== source.fingerprint) throw new Error('Update source changed.');
        entry.metadata = await boundedMetadataQuery(source, options);
        if (resolveUpdateAvailabilitySource(source.cwd).fingerprint !== source.fingerprint) throw new Error('Update source changed.');
        entry.outcome = 'success';
    } catch {
        // Availability is advisory: persist only a generic, throttled failure, never npm diagnostics or credentials.
        entry.outcome = 'unavailable';
        entry.metadata = null;
    }
    assertContainedDestination(binding);
    await withCacheLock(source, lockTimeout, async () => {
        assertContainedDestination(binding);
        const current = readUpdateCache(source, now());
        if (current?.attemptId !== entry.attemptId || current.outcome !== 'pending') return;
        writeUpdateCache(source, entry, now());
    });
}

/** The detached process may consume only the exact pending claim persisted by its launcher. */
export async function checkClaimedUpdateAvailability(repoRoot: string, claim: UpdateAvailabilityClaim): Promise<void> {
    if (process.env[UPDATE_CHECK_OPT_OUT_ENV] === '0') return;
    const source = resolveUpdateAvailabilitySource(repoRoot);
    await checkLocked(source, false, {}, claim);
}

/** Runs in the bounded CLI probe thread; the shared lock suppresses launches before spawn. */
export async function prepareBackgroundUpdateAvailability(repoRoot: string): Promise<{ view: UpdateAvailabilityView; claim: UpdateAvailabilityClaim | null }> {
    const source = resolveUpdateAvailabilitySource(repoRoot);
    const now = Date.now;
    const cached = readUpdateCache(source, now());
    const view = viewFor(source, cached, now());
    if (process.env[UPDATE_CHECK_OPT_OUT_ENV] === '0' || isUpdateCacheFresh(cached, now()) || view.status === 'unavailable') return { view, claim: null };
    return withCacheLock(source, UPDATE_CHECK_TIMEOUT_MS + 1_000, async () => {
        const current = readUpdateCache(source, now());
        if (isUpdateCacheFresh(current, now()) || isAutomaticUpdateCacheBlocked(source, now())) return { view: viewFor(source, current, now()), claim: null };
        const entry = pendingEntry(source, now());
        writeUpdateCache(source, entry, now());
        return { view: viewFor(source, entry, now()), claim: { sourceFingerprint: source.fingerprint, attemptId: entry.attemptId } };
    });
}

function snapshotUpdateAvailability(repoRoot: string, options: UpdateAvailabilityServiceOptions): UpdateAvailabilityView {
    const now = options.now || Date.now;
    try {
        const source = resolveUpdateAvailabilitySource(repoRoot);
        const view = viewFor(source, readUpdateCache(source, now()), now());
        return view.status === 'unknown' && !automaticEnabled(options) ? { ...view, status: 'disabled' } : view;
    } catch { return unavailable(); }
}

const automaticEnabled = (options: UpdateAvailabilityServiceOptions): boolean => options.automaticEnabled ?? process.env[UPDATE_CHECK_OPT_OUT_ENV] !== '0';

export function createUpdateAvailabilityService(repoRoot: string, options: UpdateAvailabilityServiceOptions = {}): UpdateAvailabilityService {
    const snapshot = (): UpdateAvailabilityView => snapshotUpdateAvailability(repoRoot, options);
    const snapshotAsync = async (): Promise<UpdateAvailabilityView> => {
        const view = await readCachedUpdateAvailabilityView(repoRoot, options.now);
        return view.status === 'unknown' && !automaticEnabled(options) ? { ...view, status: 'disabled' } : view;
    };
    const check = (request: { manual?: boolean } = {}): Promise<UpdateAvailabilityView> =>
        !options.queryMetadata && !options.now
            ? checkUpdateAvailabilityInProcess(repoRoot, request, options)
            : runUpdateAvailabilityCheck(repoRoot, request, options);
    return { snapshot, snapshotAsync, check };
}

/** Local execution for the disposable metadata process and injected test services. */
export async function runUpdateAvailabilityCheck(repoRoot: string, request: { manual?: boolean }, options: UpdateAvailabilityServiceOptions = {}): Promise<UpdateAvailabilityView> {
    const now = options.now || Date.now;
    if (!request.manual && !automaticEnabled(options)) return { ...snapshotUpdateAvailability(repoRoot, options), status: 'disabled' };
    try {
        const source = resolveUpdateAvailabilitySource(repoRoot);
        const key = flightKey(source);
        let pending = inFlight.get(key);
        if (!pending) {
            pending = checkLocked(source, request.manual === true, options);
            inFlight.set(key, pending);
        }
        try { await pending; } finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
        const deadline = performance.now() + (options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS) + 1_000;
        let view = viewFor(source, readUpdateCache(source, now()), now());
        let pollMs = CLAIM_POLL_INITIAL_MS;
        // Join a launch claim even if its detached process has not acquired the lock yet.
        while (view.status === 'checking' && performance.now() < deadline) {
            await delay(Math.min(pollMs, Math.max(0, deadline - performance.now())));
            view = viewFor(source, readUpdateCache(source, now()), now());
            pollMs = Math.min(pollMs * 2, CLAIM_POLL_MAX_MS);
        }
        // Reconstruct the source once before presentation, rather than on every cache poll.
        return view.status === 'checking' ? unavailable() : snapshotUpdateAvailability(repoRoot, options);
    } catch { return unavailable(); }
}
