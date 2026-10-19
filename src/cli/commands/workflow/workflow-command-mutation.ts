import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { buildProtectedControlPlaneManifest, resolveProtectedControlPlaneManifestPath, writeProtectedControlPlaneManifest } from '../../../gates/protected-control-plane/protected-control-plane';
import type { RecoverableFileTransaction } from '../../../core/recoverable-file-transaction';
import { writeFileAtomically } from '../../../core/filesystem';
import { validateWorkflowConfig } from '../../../schemas/config-artifacts';
import { bindCommittedWorkflowConfigAudit, captureWorkflowAuditTaskContext, recordWorkflowConfigAuditStage,
    type WorkflowConfigAuditBinding } from '../../../core/workflow-config-audit';
export { bindCommittedWorkflowConfigAudit, type WorkflowConfigAuditBinding } from '../../../core/workflow-config-audit';
import { normalizeWorkflowFileConfig, resolveWorkflowRoots } from './workflow-command-state';
import { authenticateLocalCommitWorkflowAudit, localCommitReceiptPath } from '../../../core/auth/local-commit-availability';
import { assertTaskTestSelectionCurrent, type TaskTestSelectionAuthority } from './workflow-command-task-test-selection';
import type {
    WorkflowConfigMutationSource,
    WorkflowFileConfigData
} from './workflow-command-types';

export interface WorkflowConfigAuditWriteOptions {
    projectValidationAdmissionSha256?: string;
    transaction?: RecoverableFileTransaction;
    mutationSource?: WorkflowConfigMutationSource | null;
    targetRoot?: string | null;
    onAuditWritten?: (binding: WorkflowConfigAuditBinding) => void;
    taskTestSelection?: TaskTestSelectionAuthority | null;
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

function isCommandOnlyConfigChange(beforeText: string, afterText: string): boolean {
    try {
        const before = normalizeWorkflowFileConfig(validateWorkflowConfig(JSON.parse(beforeText)) as WorkflowFileConfigData);
        const after = normalizeWorkflowFileConfig(validateWorkflowConfig(JSON.parse(afterText)) as WorkflowFileConfigData);
        before.full_suite_validation.command = '';
        after.full_suite_validation.command = '';
        return isDeepStrictEqual(before, after);
    } catch {
        return false;
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
    const { activeTaskIds, taskEntryHashes } = captureWorkflowAuditTaskContext(
        bundleRoot, options.targetRoot?.trim() || path.dirname(bundleRoot));
    if (options.taskTestSelection) {
        if (!activeTaskIds.includes(options.taskTestSelection.task_id)
            || taskEntryHashes[options.taskTestSelection.task_id] !== options.taskTestSelection.task_mode_entry_sha256) {
            throw new Error('Task-scoped test selection audit cannot bind to a changed task cycle.');
        }
        assertTaskTestSelectionCurrent(resolveWorkflowRoots({
            targetRoot: options.targetRoot?.trim() || path.dirname(bundleRoot)
        }), options.taskTestSelection);
    }
    const permissionRequested = changedFields.includes('local_commit.enabled');
    const auditRecordByteOffset = permissionRequested && fs.existsSync(auditPath) ? fs.statSync(auditPath).size : 0;
    const record = authenticateLocalCommitWorkflowAudit(options.targetRoot || path.dirname(bundleRoot), {
        schema_version: 1,
        event_source: 'workflow-config-set',
        timestamp_utc: new Date().toISOString(),
        actor: options.taskTestSelection ? 'task_selection_command' : mutationSource === 'local-ui' ? 'local_ui' : 'operator_command',
        ...(options.taskTestSelection ? { task_test_selection_authority: options.taskTestSelection } : {}),
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
        after_sha256: sha256Text(afterText),
        ...(options.projectValidationAdmissionSha256 && changedFields.includes('project_validation')
            ? { project_validation_admission_sha256: options.projectValidationAdmissionSha256 } : {}),
        command_only_change: isCommandOnlyConfigChange(beforeText, afterText),
        ...(permissionRequested ? { local_commit_enabled: (JSON.parse(afterText) as WorkflowFileConfigData).local_commit?.enabled === true,
            audit_record_byte_offset: auditRecordByteOffset } : {})
    }, permissionRequested);
    const serializedRecord = JSON.stringify(record);
    const binding = { auditPath, configPath, recordSha256: sha256Text(serializedRecord), taskEntryHashes };
    // Persist the cycle binding before commit so interrupted publication remains visible.
    recordWorkflowConfigAuditStage(bundleRoot, binding, false);
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
    if (permissionRequested) {
        const receiptPath = localCommitReceiptPath(options.targetRoot || path.dirname(bundleRoot));
        const content = JSON.stringify({ schema_version: 2, event_source: 'local-commit-enablement-receipt',
            enabled: record.local_commit_enabled, after_sha256: record.after_sha256,
            audit_record_byte_offset: auditRecordByteOffset,
            audit_record_sha256: sha256Text(serializedRecord) }, null, 2) + '\n';
        if (options.transaction) options.transaction.write(receiptPath, content);
        else writeFileAtomically(receiptPath, content);
    }
    if (options.onAuditWritten) options.onAuditWritten(binding);
    else if (!options.transaction) bindCommittedWorkflowConfigAudit(bundleRoot, binding);
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
