import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomically } from '../filesystem';
import { readTransactionBytes } from '../file-transaction-journal';
import {
    acquireFilesystemLock,
    inspectFilesystemLock,
    releaseFilesystemLock,
    type LockHandle
} from '../../gate-runtime/task-events-locking';

interface QueueTransaction {
    handles: LockHandle[];
    expectedContent: Buffer | null;
}

const transactions = new Map<string, QueueTransaction>();

const RUNTIME_LOCK_PATH_SEGMENTS = [
    'garda-agent-orchestrator',
    'runtime',
    'task-queue-locks',
    'TASK.md.lock'
] as const;

function canonicalQueuePath(taskPath: string): string {
    if (path.basename(taskPath) !== 'TASK.md') throw new Error('Task queue must be named TASK.md.');
    return path.join(fs.realpathSync(path.dirname(path.resolve(taskPath))), 'TASK.md');
}

function resolveRuntimeLockPath(canonicalPath: string): string {
    const queueRoot = path.dirname(canonicalPath);
    let currentPath = queueRoot;
    for (const segment of RUNTIME_LOCK_PATH_SEGMENTS) {
        currentPath = path.join(currentPath, segment);
        try {
            if (fs.lstatSync(currentPath).isSymbolicLink()) {
                throw new Error('TASK.md runtime lock path contains a symlink or junction.');
            }
        } catch (error) {
            const code = String((error as NodeJS.ErrnoException)?.code || '');
            if (code === 'ENOENT' || code === 'ENOTDIR') break;
            throw error;
        }
    }
    return path.join(queueRoot, ...RUNTIME_LOCK_PATH_SEGMENTS);
}

export function resolveTaskQueueTransactionLockPath(taskPath: string): string {
    return resolveRuntimeLockPath(canonicalQueuePath(taskPath));
}

function resolveLegacyTaskQueueTransactionLockPath(canonicalPath: string): string {
    return `${canonicalPath}.garda-status-sync.lock`;
}

function assertTransactionLockOwnership(transaction: QueueTransaction, message: string): void {
    for (const handle of transaction.handles) {
        const inspection = inspectFilesystemLock(handle.lockPath);
        if (inspection.metadata.lock_id !== handle.lockId || inspection.metadata.pid !== process.pid) {
            throw new Error(message);
        }
    }
}

function readQueueBytes(taskPath: string): Buffer | null {
    return readTransactionBytes(path.dirname(taskPath), taskPath);
}

export function withTaskQueueTransaction<T>(
    taskPath: string,
    onLockFailure: (message: string) => T,
    operation: () => T
): T {
    let canonicalPath: string;
    let transaction: QueueTransaction;
    let nested = false;
    try {
        canonicalPath = canonicalQueuePath(taskPath);
        const activeTransaction = transactions.get(canonicalPath);
        if (activeTransaction) {
            assertTransactionLockOwnership(
                activeTransaction,
                'TASK.md transaction lock ownership changed before nested operation.'
            );
            transaction = activeTransaction;
            nested = true;
        } else {
            const lockPaths = [
                resolveLegacyTaskQueueTransactionLockPath(canonicalPath),
                resolveRuntimeLockPath(canonicalPath)
            ];
            const handles: LockHandle[] = [];
            try {
                for (const lockPath of lockPaths) {
                    if (fs.existsSync(lockPath) && !fs.lstatSync(lockPath).isDirectory()) {
                        throw new Error('Legacy or invalid TASK.md lock requires explicit operator recovery.');
                    }
                    const { handle } = acquireFilesystemLock(lockPath, {
                        ownerLabel: 'task-queue-transaction',
                        requireKnownDeadOwner: true,
                        allowForeignHostStaleRecovery: false
                    });
                    handles.push(handle);
                }
                transaction = { handles, expectedContent: readQueueBytes(canonicalPath) };
            } catch (error) {
                for (const handle of handles.reverse()) {
                    releaseFilesystemLock(handle);
                }
                throw error;
            }
        }
    } catch (error) {
        return onLockFailure(`Could not acquire TASK.md status-sync lock: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (nested) {
        return operation();
    }
    transactions.set(canonicalPath, transaction);
    try {
        return operation();
    } finally {
        transactions.delete(canonicalPath);
        for (const handle of [...transaction.handles].reverse()) {
            releaseFilesystemLock(handle);
        }
    }
}

export function writeTaskQueueFile(taskPath: string, content: string | Buffer): void {
    const canonicalPath = canonicalQueuePath(taskPath);
    const transaction = transactions.get(canonicalPath);
    if (!transaction) throw new Error('TASK.md write requires a task-queue transaction.');
    assertTransactionLockOwnership(
        transaction,
        'TASK.md transaction lock ownership changed before publication.'
    );
    const current = readQueueBytes(canonicalPath);
    if (current === null ? transaction.expectedContent !== null : !transaction.expectedContent?.equals(current)) {
        throw new Error('TASK.md changed outside the transaction; refusing to overwrite it.');
    }
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    writeFileAtomically(canonicalPath, bytes);
    transaction.expectedContent = bytes;
}
