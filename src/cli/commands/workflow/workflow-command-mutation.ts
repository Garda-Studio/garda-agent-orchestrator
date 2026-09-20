import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { buildProtectedControlPlaneManifest, resolveProtectedControlPlaneManifestPath, writeProtectedControlPlaneManifest } from '../../../gates/protected-control-plane/protected-control-plane';
import type { RecoverableFileTransaction } from '../../../core/recoverable-file-transaction';
import { writeFileAtomically } from '../../../core/filesystem';
import { validateWorkflowConfig } from '../../../schemas/config-artifacts';
import { resolveActiveTaskIds } from '../../../core/task-queue/active-task-state';
import type {
    WorkflowConfigMutationSource,
    WorkflowFileConfigData
} from './workflow-command-types';

export interface WorkflowConfigAuditWriteOptions {
    transaction?: RecoverableFileTransaction;
    mutationSource?: WorkflowConfigMutationSource | null;
    targetRoot?: string | null;
}

export function getWorkflowConfigField(config: WorkflowFileConfigData, fieldPath: string): unknown {
    return fieldPath.split('.').reduce<unknown>((current, segment) => {
        if (current && typeof current === 'object' && segment in current) {
            return (current as Record<string, unknown>)[segment];
        }
        return undefined;
    }, config);
}

export function workflowConfigValuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function resolveActualChangedFields(
    requestedFields: readonly string[],
    currentConfig: WorkflowFileConfigData,
    nextConfig: WorkflowFileConfigData,
    configExists: boolean
): string[] {
    if (!configExists) {
        return [...requestedFields];
    }
    return requestedFields.filter((field) => !workflowConfigValuesEqual(
        getWorkflowConfigField(currentConfig, field),
        getWorkflowConfigField(nextConfig, field)
    ));
}

export function writeWorkflowConfig(configPath: string, config: WorkflowFileConfigData, transaction?: RecoverableFileTransaction): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const validated = validateWorkflowConfig(config) as WorkflowFileConfigData;
    const content = JSON.stringify(validated, null, 2) + '\n';
    if (transaction) transaction.write(configPath, content);
    else writeFileAtomically(configPath, content);
}

export function sha256Text(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function normalizeOutputPath(value: string): string {
    return path.normalize(value).replace(/\\/g, '/');
}

export function normalizeWorkflowConfigMutationSource(value: unknown): WorkflowConfigMutationSource {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'local-ui' || normalized === 'cli' || normalized === 'manual') {
        return normalized;
    }
    if (!normalized) {
        return 'cli';
    }
    throw new Error('--mutation-source must be one of: cli, local-ui, manual.');
}

function resolveAuditActiveTaskIds(bundleRoot: string, targetRoot: string | null | undefined): string[] {
    const resolvedTargetRoot = targetRoot && targetRoot.trim()
        ? targetRoot
        : path.dirname(bundleRoot);
    try {
        return [...resolveActiveTaskIds(resolvedTargetRoot, bundleRoot, [], {
            includeAmbiguousRuntimeTasks: false,
            includeStaleRuntimeActiveTasks: false
        })].sort((left, right) => left.localeCompare(right));
    } catch {
        return [];
    }
}

export function writeWorkflowConfigAuditRecord(
    bundleRoot: string,
    configPath: string,
    changedFields: string[],
    beforeText: string,
    afterText: string,
    options: WorkflowConfigAuditWriteOptions = {}
): string {
    const auditPath = path.join(bundleRoot, 'runtime', 'workflow-config-audit.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    const mutationSource = normalizeWorkflowConfigMutationSource(options.mutationSource);
    const activeTaskIds = resolveAuditActiveTaskIds(bundleRoot, options.targetRoot);
    const record = {
        schema_version: 1,
        event_source: 'workflow-config-set',
        timestamp_utc: new Date().toISOString(),
        actor: mutationSource === 'local-ui' ? 'local_ui' : 'operator_command',
        command: 'workflow set',
        mutation_source: mutationSource,
        config_path: normalizeOutputPath(configPath),
        changed_fields: changedFields,
        active_task_ids: activeTaskIds,
        active_task_id: activeTaskIds.length === 1 ? activeTaskIds[0] : null,
        ui_session: mutationSource === 'local-ui'
            ? {
                action_session: 'enabled',
                running_marker: true
            }
            : null,
        before_sha256: sha256Text(beforeText),
        after_sha256: sha256Text(afterText)
    };
    const serializedRecord = JSON.stringify(record);
    if (options.transaction) options.transaction.append(auditPath, serializedRecord + '\n');
    else fs.appendFileSync(auditPath, serializedRecord + '\n', 'utf8');
    if (changedFields.includes('task_reset.enabled')) {
        writeTaskResetEnablementReceipt(
            configPath,
            changedFields,
            record.after_sha256,
            sha256Text(serializedRecord),
            options.transaction
        );
    }
    return auditPath;
}

function buildTaskResetReceiptHashPayload(receipt: {
    event_source: string;
    command: string;
    config_path: string;
    changed_fields: string[];
    after_sha256: string;
    audit_record_sha256: string;
}): Record<string, unknown> {
    return {
        event_source: receipt.event_source,
        command: receipt.command,
        config_path: receipt.config_path,
        changed_fields: receipt.changed_fields,
        after_sha256: receipt.after_sha256,
        audit_record_sha256: receipt.audit_record_sha256
    };
}

function writeTaskResetEnablementReceipt(
    configPath: string,
    changedFields: string[],
    afterSha256: string,
    auditRecordSha256: string,
    transaction?: RecoverableFileTransaction
): void {
    const receiptPath = path.join(path.dirname(configPath), 'task-reset-enablement-receipt.json');
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    const receipt = {
        schema_version: 1,
        event_source: 'task-reset-enablement-receipt',
        timestamp_utc: new Date().toISOString(),
        actor: 'operator_command',
        command: 'workflow set',
        config_path: normalizeOutputPath(configPath),
        changed_fields: changedFields,
        after_sha256: afterSha256,
        audit_record_sha256: auditRecordSha256,
        receipt_sha256: ''
    };
    receipt.receipt_sha256 = sha256Text(JSON.stringify(buildTaskResetReceiptHashPayload(receipt)));
    const content = JSON.stringify(receipt, null, 2) + '\n';
    if (transaction) transaction.write(receiptPath, content);
    else writeFileAtomically(receiptPath, content);
}

export function refreshWorkflowProtectedManifest(targetRoot: string, transaction?: RecoverableFileTransaction): string {
    if (transaction) {
        const manifestPath = resolveProtectedControlPlaneManifestPath(targetRoot);
        transaction.write(manifestPath, JSON.stringify(buildProtectedControlPlaneManifest(targetRoot), null, 2));
        return manifestPath;
    }
    return writeProtectedControlPlaneManifest(targetRoot);
}
