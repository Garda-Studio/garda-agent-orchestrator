import * as crypto from 'node:crypto';
import { assertContainedDestination, bindContainedDestination } from '../../core/contained-filesystem';
import { withFilesystemLockAsync } from '../../gate-runtime/task-events-locking';
import { compareVersionStrings } from '../common';
import { queryNpmUpdateMetadata } from '../check-update/check-update-source';
import { buildUpdateCommand } from './update-availability-notice';
import { isUpdateMetadata, resolveUpdateAvailabilitySource } from './update-availability-source';
import { isUpdateCacheFresh, prepareUpdateCache, readUpdateCache, updateCachePaths, writeUpdateCache } from './update-availability-cache';
import {
    UPDATE_CHECK_OPT_OUT_ENV, UPDATE_CHECK_TIMEOUT_MS,
    type UpdateAvailabilityCacheEntry, type UpdateAvailabilityService, type UpdateAvailabilityServiceOptions,
    type UpdateAvailabilitySource, type UpdateAvailabilityView, type UpdateMetadata
} from './update-availability-types';

const inFlight = new Map<string, Promise<void>>();
const unavailable = (): UpdateAvailabilityView => ({ status: 'unavailable', currentVersion: null, latestVersion: null, updateCommand: null });
const flightKey = (source: UpdateAvailabilitySource): string => `${source.bundleRoot}:${source.fingerprint}`;

function viewFor(source: UpdateAvailabilitySource, entry: UpdateAvailabilityCacheEntry | null, now: number): UpdateAvailabilityView {
    const result: UpdateAvailabilityView = { status: 'unknown', currentVersion: source.currentVersion, latestVersion: null, updateCommand: null };
    if (inFlight.has(flightKey(source))) return { ...result, status: 'checking' };
    if (!isUpdateCacheFresh(entry, now)) return result;
    if (entry?.outcome !== 'success' || !entry.metadata) return { ...result, status: 'unavailable' };
    const newer = compareVersionStrings(source.currentVersion, entry.metadata.version) < 0;
    return { ...result, status: newer ? 'available' : 'up_to_date', latestVersion: entry.metadata.version,
        updateCommand: newer ? buildUpdateCommand(source.cwd) : null };
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

async function checkLocked(source: UpdateAvailabilitySource, manual: boolean, options: UpdateAvailabilityServiceOptions): Promise<void> {
    const now = options.now || Date.now;
    const observed = readUpdateCache(source, now());
    prepareUpdateCache(source);
    const paths = updateCachePaths(source);
    const directoryBinding = bindContainedDestination(source.bundleRoot, paths.directory);
    await withFilesystemLockAsync(paths.lock, {
        timeoutMs: (options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS) + 1_000,
        requireKnownDeadOwner: true, ownerLabel: 'update-availability'
    }, async () => {
        assertContainedDestination(directoryBinding);
        const cached = readUpdateCache(source, now());
        const completedObservedRequest = observed?.outcome === 'pending' && cached?.outcome !== 'pending';
        if (isUpdateCacheFresh(cached, now()) && (!manual || cached?.attemptId !== observed?.attemptId || completedObservedRequest)) return;
        const entry: UpdateAvailabilityCacheEntry = {
            schema: 1, sourceFingerprint: source.fingerprint, packageSpec: source.packageSpec,
            trustPolicy: source.trustPolicy, transport: source.transport,
            attemptId: crypto.randomBytes(16).toString('hex'), attemptedAt: now(), outcome: 'pending', metadata: null
        };
        assertContainedDestination(directoryBinding);
        writeUpdateCache(source, entry);
        try {
            entry.metadata = await boundedMetadataQuery(source, options);
            entry.outcome = 'success';
        } catch {
            // Availability is advisory: persist only a generic, throttled failure, never npm diagnostics or credentials.
            entry.outcome = 'unavailable';
        }
        assertContainedDestination(directoryBinding);
        writeUpdateCache(source, entry);
    });
}

export function createUpdateAvailabilityService(repoRoot: string, options: UpdateAvailabilityServiceOptions = {}): UpdateAvailabilityService {
    const now = options.now || Date.now;
    const enabled = (): boolean => options.automaticEnabled ?? process.env[UPDATE_CHECK_OPT_OUT_ENV] !== '0';
    const snapshot = (): UpdateAvailabilityView => {
        try {
            const source = resolveUpdateAvailabilitySource(repoRoot);
            const view = viewFor(source, readUpdateCache(source, now()), now());
            return view.status === 'unknown' && !enabled() ? { ...view, status: 'disabled' } : view;
        } catch { return unavailable(); }
    };
    const check = async (request: { manual?: boolean } = {}): Promise<UpdateAvailabilityView> => {
        if (!request.manual && !enabled()) return { ...snapshot(), status: 'disabled' };
        try {
            const source = resolveUpdateAvailabilitySource(repoRoot);
            const key = flightKey(source);
            let pending = inFlight.get(key);
            if (!pending) {
                pending = checkLocked(source, request.manual === true, options);
                inFlight.set(key, pending);
            }
            try { await pending; } finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
            return snapshot();
        } catch { return unavailable(); }
    };
    return { snapshot, check };
}
