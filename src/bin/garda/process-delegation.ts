import * as childProcess from 'node:child_process';

import { PRODUCT_NAME } from './launcher-constants';

const DELEGATION_TIMEOUT_ENV = 'GARDA_LAUNCHER_DELEGATION_TIMEOUT_MS';
const DELEGATION_TIMEOUT_KILL_GRACE_MS = 1000;

export function getDelegationForwardSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
    return platform === 'win32'
        ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
        : ['SIGINT', 'SIGTERM'];
}

export function getDelegationExitCode(status: number | null, signal: NodeJS.Signals | null): number {
    if (status !== null) {
        return status;
    }
    if (signal === 'SIGINT') {
        return 130;
    }
    if (signal === 'SIGTERM') {
        return 143;
    }
    if (signal === 'SIGBREAK') {
        return 149;
    }
    if (signal === 'SIGKILL') {
        return 137;
    }
    return 1;
}

function readDelegationTimeoutMs(): number | null {
    const rawValue = process.env[DELEGATION_TIMEOUT_ENV];
    if (rawValue === undefined || rawValue === '') {
        return null;
    }
    const timeoutMs = Number(rawValue);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`${PRODUCT_NAME} ${DELEGATION_TIMEOUT_ENV} must be a positive integer number of milliseconds.`);
    }
    return timeoutMs;
}

export async function delegateToLocalCli(cliPath: string, argv: string[]): Promise<number> {
    const timeoutMs = readDelegationTimeoutMs();
    const child = childProcess.spawn(process.execPath, [cliPath, ...argv], {
        stdio: 'inherit',
        env: process.env
    });

    const forwardedSignalHandlers = getDelegationForwardSignals().map((signal) => {
        const handler = (): void => {
            child.kill(signal);
        };
        process.once(signal, handler);
        return { signal, handler };
    });

    let timeoutHandle: NodeJS.Timeout | null = null;
    let hardKillHandle: NodeJS.Timeout | null = null;
    if (timeoutMs !== null) {
        timeoutHandle = setTimeout(() => {
            console.error(`${PRODUCT_NAME} delegated CLI timed out after ${timeoutMs}ms; terminating child process.`);
            child.kill('SIGTERM');
            hardKillHandle = setTimeout(() => {
                child.kill('SIGKILL');
            }, DELEGATION_TIMEOUT_KILL_GRACE_MS);
        }, timeoutMs);
    }

    try {
        const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (status, signal) => {
                resolve({ status, signal });
            });
        });
        return getDelegationExitCode(result.status, result.signal);
    } finally {
        for (const { signal, handler } of forwardedSignalHandlers) {
            process.removeListener(signal, handler);
        }
        if (timeoutHandle !== null) {
            clearTimeout(timeoutHandle);
        }
        if (hardKillHandle !== null) {
            clearTimeout(hardKillHandle);
        }
    }
}
