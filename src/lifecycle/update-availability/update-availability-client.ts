import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { readCachedUpdateAvailabilityView } from './update-availability-service';
import { updateAvailabilityEnvironmentFingerprint } from './update-availability-source';
import { UPDATE_CHECK_OPT_OUT_ENV, UPDATE_CHECK_TIMEOUT_MS, type UpdateAvailabilityServiceOptions, type UpdateAvailabilityView } from './update-availability-types';

interface ActiveProcess {
    result: Promise<unknown>;
    exited: Promise<void>;
}

const activeProcesses = new Map<string, ActiveProcess>();
const unavailable: UpdateAvailabilityView = { status: 'unavailable', currentVersion: null, latestVersion: null, updateCommand: null };
const processKey = (repoRoot: string, group: string): string => {
    const root = path.resolve(repoRoot);
    return `${group}:${process.platform === 'win32' ? root.toLowerCase() : root}`;
};

export function readUpdateAvailabilityInProcess(repoRoot: string, checkedAt?: number): Promise<UpdateAvailabilityView> {
    const environment = updateAvailabilityEnvironmentFingerprint();
    return runCheckProcess(repoRoot, { checkedAt }, UPDATE_CHECK_TIMEOUT_MS, unavailable,
        `snapshot:${environment}:${checkedAt ?? 'live'}`, undefined, environment);
}

/** Production UI requests keep source, cache and network work off the request-serving thread. */
export function checkUpdateAvailabilityInProcess(repoRoot: string, request: { manual?: boolean }, options: UpdateAvailabilityServiceOptions): Promise<UpdateAvailabilityView> {
    const fallback: UpdateAvailabilityView = { status: 'unavailable', currentVersion: null, latestVersion: null, updateCommand: null };
    const disabledAutomatic = !request.manual && !(options.automaticEnabled ?? process.env[UPDATE_CHECK_OPT_OUT_ENV] !== '0');
    const automatic = activeProcesses.get(processKey(repoRoot, 'automatic'));
    const manual = activeProcesses.get(processKey(repoRoot, 'manual'));
    if (!request.manual && !disabledAutomatic && manual) return manual.result as Promise<UpdateAvailabilityView>;
    return runCheckProcess(repoRoot, { request, options: { timeoutMs: options.timeoutMs, automaticEnabled: options.automaticEnabled } },
        2 * ((options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS) + 1_000), fallback,
        request.manual ? 'manual' : disabledAutomatic ? 'disabled' : 'automatic', request.manual ? automatic?.exited : undefined);
}

function isAvailabilityView(value: unknown): value is UpdateAvailabilityView {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const view = value as UpdateAvailabilityView;
    return ['unknown', 'checking', 'available', 'up_to_date', 'unavailable', 'disabled'].includes(view.status)
        && [view.currentVersion, view.latestVersion].every(version => version === null || typeof version === 'string' && version.length <= 128)
        && (view.updateCommand === null || typeof view.updateCommand === 'string' && view.updateCommand.length <= 4096);
}

function runCheckProcess(repoRoot: string, payload: object, timeoutMs: number, fallback: UpdateAvailabilityView, group: string, predecessor?: Promise<void>, snapshotEnvironment?: string): Promise<UpdateAvailabilityView> {
    const root = path.resolve(repoRoot);
    const key = processKey(root, group);
    const active = activeProcesses.get(key);
    if (active) return active.result as Promise<UpdateAvailabilityView>;
    let resolveResult: (result: UpdateAvailabilityView) => void = () => undefined;
    let resolveExit: () => void = () => undefined;
    const result = new Promise<UpdateAvailabilityView>((resolve) => { resolveResult = resolve; });
    const entry = { result, exited: new Promise<void>((resolve) => { resolveExit = resolve; }) };
    activeProcesses.set(key, entry);
    let settled = false;
    let child: ChildProcess | undefined;
    let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: UpdateAvailabilityView): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child?.unref();
        child?.channel?.unref();
        resolveResult(value);
    };
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    const release = (): void => {
        clearTimeout(lifetimeTimer);
        if (activeProcesses.get(key) === entry) activeProcesses.delete(key);
        resolveExit();
    };
    const start = (): void => {
        try {
            child = spawn(process.execPath, [path.join(__dirname, 'update-availability-worker.js'), snapshotEnvironment ? '--snapshot' : '--check', root, JSON.stringify(payload)], {
                stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
            });
            let received: UpdateAvailabilityView | undefined;
            child.on('message', (message: unknown) => { if (isAvailabilityView(message)) received = message; });
            child.on('error', () => finish(fallback));
            child.on('close', () => {
                clearTimeout(lifetimeTimer);
                if (settled || !received) { finish(fallback); release(); return; }
                const completed = received;
                if (snapshotEnvironment) {
                    finish(updateAvailabilityEnvironmentFingerprint() === snapshotEnvironment ? completed : fallback);
                    release();
                    return;
                }
                // The child has its own environment snapshot. Reconstruct current parent
                // source/version before presentation, before releasing queued manual work.
                void readCachedUpdateAvailabilityView(root).then(view => {
                    finish(completed.status === 'disabled' ? { ...view, status: 'disabled' } : view);
                }, () => finish(fallback)).finally(release);
            });
            lifetimeTimer = setTimeout(() => {
                finish(fallback);
                child?.kill('SIGKILL');
            }, timeoutMs);
            lifetimeTimer.unref?.();
            if (settled) { child.unref(); child.channel?.unref(); }
        } catch {
            release();
            finish(fallback);
        }
    };
    // Queued manual intent survives its caller deadline and receives its own lifetime
    // once started. Only process exit permits a successor to recover its dead-owner lock.
    if (predecessor) void predecessor.then(start); else start();
    return result;
}
