import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { readCachedUpdateAvailabilityView } from './update-availability-service';
import { updateAvailabilityEnvironmentFingerprint } from './update-availability-source';
import { UPDATE_CHECK_OPT_OUT_ENV, UPDATE_CHECK_TIMEOUT_MS, type UpdateAvailabilityServiceOptions, type UpdateAvailabilityView } from './update-availability-types';

interface ActiveProcess {
    result: Promise<UpdateAvailabilityView>;
    exited: Promise<void>;
    environmentFingerprint: string;
    mode: ProcessRequest['mode'];
    timeoutMs: number;
    finished: boolean;
}

interface ProcessRequest {
    payload: object;
    timeoutMs: number;
    group: string;
    mode: 'snapshot' | 'manual' | 'automatic' | 'disabled';
    environment: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}

const activeProcesses = new Map<string | symbol, ActiveProcess[]>();
const unavailable: UpdateAvailabilityView = { status: 'unavailable', currentVersion: null, latestVersion: null, updateCommand: null };
const processKey = (repoRoot: string, group: string): string => {
    const root = path.resolve(repoRoot);
    return `${group}:${process.platform === 'win32' ? root.toLowerCase() : root}`;
};

export function readUpdateAvailabilityInProcess(repoRoot: string, checkedAt?: number, signal?: AbortSignal): Promise<UpdateAvailabilityView> {
    return runCheckProcess(repoRoot, {
        payload: { checkedAt }, timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
        group: `snapshot:${checkedAt ?? 'live'}`, mode: 'snapshot', environment: { ...process.env }, signal
    });
}

/** Production UI requests keep source, cache and network work off the request-serving thread. */
export function checkUpdateAvailabilityInProcess(repoRoot: string, request: { manual?: boolean }, options: UpdateAvailabilityServiceOptions): Promise<UpdateAvailabilityView> {
    const automaticEnabled = options.automaticEnabled ?? process.env[UPDATE_CHECK_OPT_OUT_ENV] !== '0';
    const environment = { ...process.env };
    const disabledAutomatic = !request.manual && !automaticEnabled;
    return runCheckProcess(repoRoot, {
        payload: { request, options: { timeoutMs: options.timeoutMs, automaticEnabled } },
        timeoutMs: 2 * ((options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS) + 1_000),
        group: disabledAutomatic ? 'disabled' : 'check',
        mode: request.manual ? 'manual' : disabledAutomatic ? 'disabled' : 'automatic', environment
    });
}

function isAvailabilityView(value: unknown): value is UpdateAvailabilityView {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const view = value as UpdateAvailabilityView;
    return ['unknown', 'checking', 'available', 'up_to_date', 'unavailable', 'disabled'].includes(view.status)
        && [view.currentVersion, view.latestVersion].every(version => version === null || typeof version === 'string' && version.length <= 128)
        && (view.updateCommand === null || typeof view.updateCommand === 'string' && view.updateCommand.length <= 4096);
}

function withCallerDeadline(result: Promise<UpdateAvailabilityView>, timeoutMs: number): Promise<UpdateAvailabilityView> {
    return new Promise(resolve => {
        const finish = (value: UpdateAvailabilityView): void => { clearTimeout(timer); resolve(value); };
        const timer = setTimeout(() => finish(unavailable), timeoutMs);
        void result.then(finish);
    });
}

function runCheckProcess(repoRoot: string, request: ProcessRequest): Promise<UpdateAvailabilityView> {
    const { payload, timeoutMs, group, mode, environment, signal } = request;
    const environmentFingerprint = updateAvailabilityEnvironmentFingerprint(environment);
    const snapshotEnvironment = mode === 'snapshot' ? environmentFingerprint : undefined;
    const fallback = unavailable;
    if (signal?.aborted) return Promise.resolve(fallback);
    const root = path.resolve(repoRoot);
    // A cancellable speculative read owns its process; cancelling it cannot affect
    // another consumer of the shared UI/cached-read queue.
    const key = signal ? Symbol('speculative-snapshot') : processKey(root, group);
    const queue = activeProcesses.get(key) ?? [];
    const active = queue.find(entry => !entry.finished && entry.environmentFingerprint === environmentFingerprint
        && entry.timeoutMs === timeoutMs && (mode !== 'manual' || entry.mode === 'manual'));
    if (active) return withCallerDeadline(active.result, timeoutMs);
    const predecessor = queue.at(-1)?.exited;
    let resolveResult: (result: UpdateAvailabilityView) => void = () => undefined;
    let resolveExit: () => void = () => undefined;
    const result = new Promise<UpdateAvailabilityView>((resolve) => { resolveResult = resolve; });
    const entry: ActiveProcess = { result, exited: new Promise<void>((resolve) => { resolveExit = resolve; }), environmentFingerprint, mode, timeoutMs, finished: false };
    queue.push(entry);
    activeProcesses.set(key, queue);
    const callerResult = withCallerDeadline(result, timeoutMs);
    let child: ChildProcess | undefined;
    let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: UpdateAvailabilityView): void => {
        if (entry.finished) return;
        entry.finished = true;
        resolveResult(value);
    };
    const release = (): void => {
        clearTimeout(lifetimeTimer);
        signal?.removeEventListener('abort', cancel);
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        if (queue.length === 0 && activeProcesses.get(key) === queue) activeProcesses.delete(key);
        resolveExit();
    };
    const cancel = (): void => {
        finish(fallback);
        if (child) child.kill('SIGKILL'); else release();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const start = (): void => {
        if (signal?.aborted) { cancel(); return; }
        try {
            child = spawn(process.execPath, [path.join(__dirname, 'update-availability-worker.js'), snapshotEnvironment ? '--snapshot' : '--check', root, JSON.stringify(payload)], {
                stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, env: environment
            });
            // Each waiting caller owns a referenced deadline; background work cannot
            // keep an otherwise finished CLI alive after those deadlines expire.
            child.unref();
            child.channel?.unref();
            let received: UpdateAvailabilityView | undefined;
            child.on('message', (message: unknown) => { if (isAvailabilityView(message)) received = message; });
            child.on('error', () => finish(fallback));
            child.on('close', () => {
                clearTimeout(lifetimeTimer);
                if (entry.finished || !received) { finish(fallback); release(); return; }
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
        } catch {
            release();
            finish(fallback);
        }
    };
    // Queued manual intent survives its caller deadline and receives its own lifetime
    // once started. Only process exit permits a successor to recover its dead-owner lock.
    if (predecessor) void predecessor.then(start); else start();
    return callerResult;
}
