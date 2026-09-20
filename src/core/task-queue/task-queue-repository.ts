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
    handle: LockHandle;
    expectedContent: Buffer | null;
}

const transactions = new Map<string, QueueTransaction>();

function canonicalQueuePath(taskPath: string): string {
    if (path.basename(taskPath) !== 'TASK.md') throw new Error('Task queue must be named TASK.md.');
    return path.join(fs.realpathSync(path.dirname(path.resolve(taskPath))), 'TASK.md');
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
    try {
        canonicalPath = canonicalQueuePath(taskPath);
        const lockPath = `${canonicalPath}.garda-status-sync.lock`;
        if (fs.existsSync(lockPath) && !fs.lstatSync(lockPath).isDirectory()) {
            throw new Error('Legacy or invalid TASK.md lock requires explicit operator recovery.');
        }
        const { handle } = acquireFilesystemLock(lockPath, {
            ownerLabel: 'task-queue-transaction',
            requireKnownDeadOwner: true,
            allowForeignHostStaleRecovery: false
        });
        try {
            transaction = { handle, expectedContent: readQueueBytes(canonicalPath) };
        } catch (error) {
            releaseFilesystemLock(handle);
            throw error;
        }
    } catch (error) {
        return onLockFailure(`Could not acquire TASK.md status-sync lock: ${error instanceof Error ? error.message : String(error)}`);
    }
    transactions.set(canonicalPath, transaction);
    try {
        return operation();
    } finally {
        transactions.delete(canonicalPath);
        releaseFilesystemLock(transaction.handle);
    }
}

export function writeTaskQueueFile(taskPath: string, content: string | Buffer): void {
    const canonicalPath = canonicalQueuePath(taskPath);
    const transaction = transactions.get(canonicalPath);
    if (!transaction) throw new Error('TASK.md write requires a task-queue transaction.');
    const inspection = inspectFilesystemLock(transaction.handle.lockPath);
    if (inspection.metadata.lock_id !== transaction.handle.lockId || inspection.metadata.pid !== process.pid) {
        throw new Error('TASK.md transaction lock ownership changed before publication.');
    }
    const current = readQueueBytes(canonicalPath);
    if (current === null ? transaction.expectedContent !== null : !transaction.expectedContent?.equals(current)) {
        throw new Error('TASK.md changed outside the transaction; refusing to overwrite it.');
    }
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    writeFileAtomically(canonicalPath, bytes);
    transaction.expectedContent = bytes;
}
