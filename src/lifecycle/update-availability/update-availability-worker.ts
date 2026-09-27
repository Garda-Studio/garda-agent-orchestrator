import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { assertContainedDestination, bindContainedDestination, ensureContainedDirectory, writeContainedFile } from '../../core/contained-filesystem';
import { withFilesystemLock } from '../../gate-runtime/task-events-locking';
import { checkClaimedUpdateAvailability, runUpdateAvailabilityCheck, prepareBackgroundUpdateAvailability, readCachedUpdateAvailabilityView, readCachedUpdateAvailabilityLocally } from './update-availability-service';
import { formatUpdateAvailabilityNotice } from './update-availability-notice';
import { readUpdateAvailabilityInProcess } from './update-availability-client';
import { UPDATE_CHECK_OPT_OUT_ENV, UPDATE_CHECK_TIMEOUT_MS, type UpdateAvailabilityServiceOptions, type UpdateAvailabilityView } from './update-availability-types';

export const UPDATE_SCHEDULER_INTERVAL_MS = 60_000;

interface SchedulerTicket {
    schema: 2;
    attemptedAt: number;
    heartbeatAt: number;
    attemptId: string;
}

function readSchedulerTicket(bundleRoot: string, file: string, now: number): SchedulerTicket | null {
    const binding = bindContainedDestination(bundleRoot, file);
    if (binding.missingAt) return null;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 512) throw new Error('Invalid update scheduler record.');
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    assertContainedDestination(binding);
    if (typeof record.attemptedAt !== 'number' || !Number.isFinite(record.attemptedAt)
        || record.attemptedAt < 0 || record.attemptedAt > now) throw new Error('Invalid update scheduler record.');
    if (record.schema === 1 && typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid >= 0) {
        // Legacy tickets keep their initial throttle, but PID liveness cannot prove ownership.
        return { schema: 2, attemptedAt: record.attemptedAt, heartbeatAt: record.attemptedAt, attemptId: '' };
    }
    if (record.schema !== 2 || typeof record.attemptId !== 'string'
        || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(record.attemptId)
        || typeof record.heartbeatAt !== 'number' || !Number.isFinite(record.heartbeatAt)
        || record.heartbeatAt < record.attemptedAt || record.heartbeatAt > now) throw new Error('Invalid update scheduler record.');
    return { schema: 2, attemptedAt: record.attemptedAt, heartbeatAt: record.heartbeatAt, attemptId: record.attemptId };
}

function renewSchedulerLease(repoRoot: string, attemptId: string): boolean {
    const bundleRoot = joinOrchestratorPath(path.resolve(repoRoot), '');
    const directory = path.join(bundleRoot, 'runtime', 'update-availability');
    const ticket = path.join(directory, 'scheduler.json');
    const binding = bindContainedDestination(bundleRoot, directory);
    const lock = path.join(directory, 'scheduler.lock');
    bindContainedDestination(bundleRoot, lock);
    return withFilesystemLock(lock, {
        // Only the detached scheduler waits here; foreground task boundaries never do.
        timeoutMs: UPDATE_CHECK_TIMEOUT_MS, requireKnownDeadOwner: true, ownerLabel: 'update-scheduler'
    }, () => {
        assertContainedDestination(binding);
        const now = Date.now();
        const record = readSchedulerTicket(bundleRoot, ticket, now);
        if (!record || record.attemptId !== attemptId) return false;
        writeContainedFile(bundleRoot, ticket, JSON.stringify({ ...record, heartbeatAt: now }) + '\n');
        return true;
    }).result;
}

function launchScheduler(repoRoot: string): void {
    const bundleRoot = joinOrchestratorPath(path.resolve(repoRoot), '');
    const directory = path.join(bundleRoot, 'runtime', 'update-availability');
    ensureContainedDirectory(bundleRoot, directory);
    const binding = bindContainedDestination(bundleRoot, directory);
    const ticket = path.join(directory, 'scheduler.json');
    const lock = path.join(directory, 'scheduler.lock');
    bindContainedDestination(bundleRoot, lock);
    // The scheduler renews its own bounded lease; an unrelated recycled PID has no authority.
    const attemptId = withFilesystemLock(lock, { timeoutMs: 1, requireKnownDeadOwner: true, ownerLabel: 'update-scheduler' }, () => {
        assertContainedDestination(binding);
        const attemptedAt = Date.now();
        const current = readSchedulerTicket(bundleRoot, ticket, attemptedAt);
        if (current && attemptedAt - current.heartbeatAt < UPDATE_SCHEDULER_INTERVAL_MS) return;
        const attemptId = randomUUID();
        writeContainedFile(bundleRoot, ticket, JSON.stringify({ schema: 2, attemptedAt, heartbeatAt: attemptedAt, attemptId }) + '\n');
        assertContainedDestination(binding);
        return attemptId;
    }).result;
    if (!attemptId) return;
    const child = spawn(process.execPath, [__filename, '--schedule', path.resolve(repoRoot), attemptId], {
        detached: true, stdio: 'ignore', windowsHide: true
    });
    child.on('error', () => undefined);
    child.unref();
}

/** Cached presentation only; canonical reports, hashes, and gate evidence stay immutable. */
export async function cachedUpdateAvailabilityNotice(repoRoot: string): Promise<string> {
    if (process.env[UPDATE_CHECK_OPT_OUT_ENV] === '0') return '';
    return formatUpdateAvailabilityNotice(repoRoot, await readCachedUpdateAvailabilityView(repoRoot));
}

/** A speculative closeout read owns its process so discarded results can be cancelled. */
export function prefetchUpdateAvailabilityNotice(repoRoot: string): { (): Promise<string>; cancel(): void } {
    const controller = new AbortController();
    const notice = process.env[UPDATE_CHECK_OPT_OUT_ENV] === '0' ? Promise.resolve('')
        : readUpdateAvailabilityInProcess(repoRoot, undefined, controller.signal)
            .then(view => formatUpdateAvailabilityNotice(repoRoot, view)).catch(() => '');
    return Object.assign(() => notice, { cancel: () => controller.abort() });
}

/** Launch only at task entry/closeout boundaries; no foreground network wait. */
export async function scheduleUpdateAvailabilityCheck(repoRoot: string): Promise<void> {
    if (process.env[UPDATE_CHECK_OPT_OUT_ENV] === '0') return;
    try {
        launchScheduler(repoRoot);
    } catch {
        // Advisory scheduling must not delay or fail successful task entry.
    }
}

async function probeAndSchedule(repoRoot: string): Promise<string> {
    const prepared = await prepareBackgroundUpdateAvailability(repoRoot);
    if (prepared.claim) {
        try {
            const child = spawn(process.execPath, [__filename, path.resolve(repoRoot), prepared.claim.sourceFingerprint, prepared.claim.attemptId], {
                detached: true, stdio: 'ignore', windowsHide: true
            });
            child.on('error', () => undefined);
            child.unref();
        } catch {
            // The persisted pending attempt throttles launch failures and crashes too.
        }
    }
    return formatUpdateAvailabilityNotice(repoRoot, prepared.view);
}

async function runScheduler(repoRoot: string, attemptId: string): Promise<void> {
    if (!attemptId || !renewSchedulerLease(repoRoot, attemptId)) return;
    const heartbeat = setInterval(() => {
        try { if (!renewSchedulerLease(repoRoot, attemptId)) clearInterval(heartbeat); }
        catch { /* A failed renewal expires naturally without delaying ordinary work. */ }
    }, UPDATE_SCHEDULER_INTERVAL_MS / 2);
    heartbeat.unref();
    try { await probeAndSchedule(repoRoot); } finally { clearInterval(heartbeat); }
}

if (require.main === module && ['--check', '--snapshot'].includes(process.argv[2]) && process.argv[3] && process.argv[4] && process.send) {
    const input = JSON.parse(process.argv[4]) as { request: { manual?: boolean }; options: UpdateAvailabilityServiceOptions; checkedAt?: number };
    const respond = (view: UpdateAvailabilityView | null): void => { process.send?.(view, () => { if (process.connected) process.disconnect(); }); };
    process.once('disconnect', () => process.exit(0));
    const result = process.argv[2] === '--snapshot'
        ? readCachedUpdateAvailabilityLocally(process.argv[3], input.checkedAt === undefined ? Date.now : () => input.checkedAt!)
        : runUpdateAvailabilityCheck(process.argv[3], input.request, input.options);
    void result.then(respond, () => respond(null));
} else if (require.main === module && process.argv[2] === '--schedule' && process.argv[3] && process.argv[4]) {
    void runScheduler(process.argv[3], process.argv[4]).catch(() => undefined);
} else if (require.main === module && process.argv[2] && process.argv[3] && process.argv[4]) {
    void checkClaimedUpdateAvailability(process.argv[2], { sourceFingerprint: process.argv[3], attemptId: process.argv[4] }).catch(() => undefined);
}
