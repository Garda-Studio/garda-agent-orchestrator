import * as path from 'node:path';

import { EXIT_SIGNAL_INTERRUPT } from './exit-codes';
import {
    assertContainedDestination,
    bindContainedDestination,
    ContainedDestination,
    removeBoundContainedPath
} from '../core/contained-filesystem';
import {
    computeTerminationSignalExitCode,
    registerSubprocessSignalHandler,
    settleWithShutdownConcurrency,
    SUBPROCESS_TERMINATION_TIMEOUT_MS
} from '../core/process/subprocess';

type CleanupCallback = () => void | Promise<void>;

const cleanupCallbacks: Set<CleanupCallback> = new Set();

let controller: AbortController | null = null;

let shuttingDown = false;

let installed = false;
let disposeSubprocessSignalHandler: (() => void) | null = null;

export function registerCleanup(fn: CleanupCallback): () => void {
    cleanupCallbacks.add(fn);
    return function dispose() {
        cleanupCallbacks.delete(fn);
    };
}

export function unregisterCleanup(fn: CleanupCallback): void {
    cleanupCallbacks.delete(fn);
}

export function getShutdownSignal(): AbortSignal | null {
    return controller ? controller.signal : null;
}

export function installSignalHandlers(): void {
    if (installed) return;
    installed = true;

    controller = new AbortController();

    disposeSubprocessSignalHandler = registerSubprocessSignalHandler(onSignal);
}

export function uninstallSignalHandlers(): void {
    if (!installed) return;
    installed = false;

    disposeSubprocessSignalHandler?.();
    disposeSubprocessSignalHandler = null;

    cleanupCallbacks.clear();
    controller = null;
    shuttingDown = false;
}

function waitForCleanup(
    subprocessCleanup: Promise<void>,
    callbacks: readonly CleanupCallback[]
): Promise<void> {
    const cleanupTasks: Array<() => void | Promise<void>> = [
        function () { return subprocessCleanup; },
        ...callbacks
    ];
    const cleanup = settleWithShutdownConcurrency(cleanupTasks, function (callback) {
        return Promise.resolve().then(callback);
    });
    return new Promise(function (resolve) {
        let finished = false;
        const timeoutHandle = setTimeout(function () {
            if (finished) return;
            finished = true;
            resolve();
        }, SUBPROCESS_TERMINATION_TIMEOUT_MS);
        cleanup.then(function () {
            if (finished) return;
            finished = true;
            clearTimeout(timeoutHandle);
            resolve();
        });
    });
}

function onSignal(sig: NodeJS.Signals, subprocessCleanup: Promise<void>): void {
    if (shuttingDown) return;
    shuttingDown = true;

    // Fire AbortController so in-flight async work can cancel early.
    if (controller && !controller.signal.aborted) {
        try { controller.abort(); } catch (_e) { /* ignore */ }
    }

    const callbacks = [...cleanupCallbacks];
    cleanupCallbacks.clear();

    const exitCode = computeSignalExitCode(sig);
    void waitForCleanup(subprocessCleanup, callbacks).then(function () {
        process.exit(exitCode);
    });
}

export function computeSignalExitCode(sig: NodeJS.Signals | null): number {
    return sig ? computeTerminationSignalExitCode(sig) : EXIT_SIGNAL_INTERRUPT;
}

export function registerTempRoot(dirPath: string, ownerBinding?: ContainedDestination): () => void {
    const resolvedPath = path.resolve(dirPath);
    if (ownerBinding && ownerBinding.path !== resolvedPath) {
        throw new Error(`Temporary cleanup binding does not match root: ${resolvedPath}`);
    }
    const binding = ownerBinding ?? bindContainedDestination(path.dirname(resolvedPath), resolvedPath);
    if (binding.missingAt) {
        throw new Error(`Temporary cleanup root does not exist: ${resolvedPath}`);
    }
    assertContainedDestination(binding);
    const fn = function () {
        try {
            removeBoundContainedPath(binding, true);
        } catch (error: unknown) {
            const reason = error instanceof Error ? error.message : String(error);
            process.stderr.write(`Temporary cleanup preserved ambiguous root ${resolvedPath}: ${reason}\n`);
        }
    };
    return registerCleanup(fn);
}
