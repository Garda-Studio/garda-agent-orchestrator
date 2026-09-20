import * as fs from 'node:fs';
import * as path from 'node:path';
import { isFileTransactionOwned } from './recoverable-file-transaction';

export function workflowTransactionPaths(bundleRoot: string): { journalPath: string; lockPath: string } {
    return {
        journalPath: path.resolve(bundleRoot, 'runtime/workflow-config-transaction.json'),
        lockPath: path.resolve(bundleRoot, 'runtime/workflow-config-transaction.lock')
    };
}

export function assertWorkflowTransactionReadable(bundleRoot: string): void {
    const { journalPath, lockPath } = workflowTransactionPaths(bundleRoot);
    if (!isFileTransactionOwned(journalPath) && (fs.existsSync(journalPath) || fs.existsSync(lockPath))) {
        throw new Error('Workflow configuration transaction is in progress or recovery is pending; retry workflow set to recover before reading settings.');
    }
}
