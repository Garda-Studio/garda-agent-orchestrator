import * as path from 'node:path';
import { resolveProtectedControlPlaneManifestPath } from '../../../core/protected-control-plane-contracts';
import { withRecoverableFileTransaction, type RecoverableFileTransaction } from '../../../core/recoverable-file-transaction';
import { workflowTransactionPaths } from '../../../core/workflow-transaction-state';
import type { WorkflowCommandRoots } from './workflow-command-types';

export function withWorkflowConfigTransaction<T>(
    roots: WorkflowCommandRoots,
    manifestRoot: string,
    operation: (transaction: RecoverableFileTransaction) => T
): T {
    return withRecoverableFileTransaction({
        root: manifestRoot,
        ...workflowTransactionPaths(roots.bundleRoot),
        files: {
            config: roots.configPath,
            policy: roots.optionalSkillSelectionPolicyPath,
            receipt: path.join(roots.bundleRoot, 'live/config/task-reset-enablement-receipt.json'),
            localCommitReceipt: path.join(roots.bundleRoot, 'live/config/local-commit-enablement-receipt.json'),
            audit: path.join(roots.bundleRoot, 'runtime/workflow-config-audit.jsonl'),
            manifest: resolveProtectedControlPlaneManifestPath(roots.bundleRoot)
        }
    }, operation);
}
