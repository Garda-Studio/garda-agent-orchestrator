import { isPlainRecord } from './records';
import { readTransactionBytes } from './file-transaction-journal';
import { joinOrchestratorPath } from './orchestrator-paths';
import { normalizeBooleanLike } from '../schemas/shared';

export type ParentDecompositionOrigin = 'manual-at-creation' | 'runtime';

export interface ParentCompletionPolicy {
    schema_version: 1;
    origin: ParentDecompositionOrigin;
    audit_enabled: boolean;
}

export function resolveParentCompletionPolicy(origin: ParentDecompositionOrigin, enabled: boolean): ParentCompletionPolicy {
    return { schema_version: 1, origin, audit_enabled: origin === 'runtime' && enabled };
}

export function parseParentCompletionPolicy(value: unknown): ParentCompletionPolicy {
    if (!isPlainRecord(value) || value.schema_version !== 1
        || !['manual-at-creation', 'runtime'].includes(String(value.origin)) || typeof value.audit_enabled !== 'boolean'
        || (value.origin === 'manual-at-creation' && value.audit_enabled)) {
        throw new Error('Parent completion policy is invalid.');
    }
    return resolveParentCompletionPolicy(value.origin as ParentDecompositionOrigin, value.audit_enabled);
}

export function readParentAuditEnabled(root: string): boolean {
    const bytes = readTransactionBytes(root, joinOrchestratorPath(root, 'live/config/workflow-config.json'));
    if (!bytes) return false;
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isPlainRecord(raw)) throw new Error('Workflow configuration must be an object.');
    if (raw.parent_audit === undefined) return false;
    if (!isPlainRecord(raw.parent_audit)) throw new Error('Invalid parent_audit.enabled.');
    return normalizeBooleanLike(raw.parent_audit.enabled, 'workflow-config.parent_audit.enabled');
}
