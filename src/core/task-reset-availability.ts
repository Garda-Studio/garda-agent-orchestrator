import * as fs from 'node:fs';
import { assertWorkflowTransactionReadable } from './workflow-transaction-state';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { buildDefaultWorkflowConfig } from './workflow-config';
import { joinOrchestratorPath } from './orchestrator-paths';
import {
    computeProtectedSnapshotDigest,
    resolveProtectedControlPlaneManifestPath
} from './protected-control-plane-contracts';
import { validateWorkflowConfig } from '../schemas/config-artifacts';
import { isPlainRecord } from './records';

export interface TaskResetAvailability {
    enabled: boolean;
    configuredEnabled: boolean;
    auditedEnablement: boolean;
    configPath: string;
    disabledReason: string | null;
    remediationCommand: string;
}

interface WorkflowConfigAuditRecord {
    event_source?: unknown;
    command?: unknown;
    changed_fields?: unknown;
    before_sha256?: unknown;
    after_sha256?: unknown;
    line_sha256?: string;
}

interface TaskResetEnablementReceipt {
    event_source?: unknown;
    command?: unknown;
    config_path?: unknown;
    changed_fields?: unknown;
    after_sha256?: unknown;
    audit_record_sha256?: unknown;
    receipt_sha256?: unknown;
}

interface ProtectedReceiptEvidence {
    manifest_path: string;
    receipt_path: string;
    receipt_relative_path: string;
    receipt_manifest_paths: string[];
    status: 'MISSING' | 'INVALID' | 'MATCH' | 'DRIFT';
}

function fileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

export function sha256Text(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeSha256(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/u.test(text) ? text : null;
}

function recordChangedTaskResetEnabled(record: WorkflowConfigAuditRecord): boolean {
    return Array.isArray(record.changed_fields)
        && record.changed_fields.some((field) => String(field || '').trim() === 'task_reset.enabled');
}

function readWorkflowConfigAuditRecords(auditPath: string): WorkflowConfigAuditRecord[] {
    if (!fileExists(auditPath)) {
        return [];
    }

    const records: WorkflowConfigAuditRecord[] = [];
    for (const line of fs.readFileSync(auditPath, 'utf8').split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (isPlainRecord(parsed)) {
                records.push({
                    ...(parsed as WorkflowConfigAuditRecord),
                    line_sha256: sha256Text(trimmed)
                });
            }
        } catch {
            // Ignore malformed legacy audit rows; they cannot authorize reset.
        }
    }
    return records;
}

export function resolveTaskResetEnablementReceiptPath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, path.join('live', 'config', 'task-reset-enablement-receipt.json'));
}

function readTaskResetEnablementReceipt(repoRoot: string): TaskResetEnablementReceipt | null {
    const receiptPath = resolveTaskResetEnablementReceiptPath(repoRoot);
    if (!fileExists(receiptPath)) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as unknown;
        return isPlainRecord(parsed) ? parsed as TaskResetEnablementReceipt : null;
    } catch {
        return null;
    }
}

function buildTaskResetReceiptHashPayload(receipt: TaskResetEnablementReceipt): Record<string, unknown> {
    return {
        event_source: receipt.event_source,
        command: receipt.command,
        config_path: receipt.config_path,
        changed_fields: Array.isArray(receipt.changed_fields) ? receipt.changed_fields : [],
        after_sha256: receipt.after_sha256,
        audit_record_sha256: receipt.audit_record_sha256
    };
}

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function readProtectedReceiptEvidence(repoRoot: string): ProtectedReceiptEvidence {
    const receiptPath = resolveTaskResetEnablementReceiptPath(repoRoot);
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    const receiptRelativePath = normalizeRelativePath(path.relative(path.resolve(repoRoot), receiptPath));
    const manifestOrchestratorRoot = path.dirname(path.dirname(manifestPath));
    const receiptManifestPaths = [...new Set([
        receiptRelativePath,
        normalizeRelativePath(path.relative(manifestOrchestratorRoot, receiptPath))
    ].filter(Boolean))];
    const baseEvidence = {
        manifest_path: manifestPath,
        receipt_path: receiptPath,
        receipt_relative_path: receiptRelativePath,
        receipt_manifest_paths: receiptManifestPaths
    };
    if (!fileExists(receiptPath) || !fileExists(manifestPath)) {
        return { ...baseEvidence, status: 'MISSING' };
    }
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
        if (!isPlainRecord(manifest)
            || !isPlainRecord(manifest.protected_snapshot)
            || normalizeSha256(manifest.protected_snapshot_sha256) !== computeProtectedSnapshotDigest(
                manifest.protected_snapshot as Record<string, string>
            )) {
            return { ...baseEvidence, status: 'INVALID' };
        }
        const snapshot = manifest.protected_snapshot as Record<string, unknown>;
        const expectedReceiptSha256 = receiptManifestPaths
            .map((candidatePath) => normalizeSha256(snapshot[candidatePath]))
            .find((candidateSha256): candidateSha256 is string => Boolean(candidateSha256))
            ?? null;
        if (!expectedReceiptSha256) {
            return { ...baseEvidence, status: 'MISSING' };
        }
        const actualReceiptSha256 = sha256Text(fs.readFileSync(receiptPath, 'utf8'));
        return {
            ...baseEvidence,
            status: expectedReceiptSha256 === actualReceiptSha256 ? 'MATCH' : 'DRIFT'
        };
    } catch {
        return { ...baseEvidence, status: 'INVALID' };
    }
}

function receiptMatchesAuditRecord(
    receipt: TaskResetEnablementReceipt | null,
    protectedReceiptEvidence: ProtectedReceiptEvidence,
    record: WorkflowConfigAuditRecord
): boolean {
    if (!receipt) {
        return false;
    }
    if (protectedReceiptEvidence.status !== 'MATCH') {
        return false;
    }
    if (String(receipt.event_source || '') !== 'task-reset-enablement-receipt') {
        return false;
    }
    if (String(receipt.command || '') !== 'workflow set') {
        return false;
    }
    if (!Array.isArray(receipt.changed_fields)
        || !receipt.changed_fields.some((field) => String(field || '').trim() === 'task_reset.enabled')) {
        return false;
    }
    if (normalizeSha256(receipt.after_sha256) !== normalizeSha256(record.after_sha256)) {
        return false;
    }
    if (normalizeSha256(receipt.audit_record_sha256) !== normalizeSha256(record.line_sha256)) {
        return false;
    }
    const receiptSha256 = normalizeSha256(receipt.receipt_sha256);
    if (!receiptSha256) {
        return false;
    }
    return receiptSha256 === sha256Text(JSON.stringify(buildTaskResetReceiptHashPayload(receipt)));
}

export function hasAuditedTaskResetEnablement(repoRoot: string, currentConfigSha256: string): boolean {
    const auditPath = joinOrchestratorPath(repoRoot, path.join('runtime', 'workflow-config-audit.jsonl'));
    const receipt = readTaskResetEnablementReceipt(repoRoot);
    const protectedReceiptEvidence = readProtectedReceiptEvidence(repoRoot);
    const currentConfigHash = normalizeSha256(currentConfigSha256);
    if (!currentConfigHash) {
        return false;
    }
    for (const record of readWorkflowConfigAuditRecords(auditPath)) {
        if (String(record.event_source || '') !== 'workflow-config-set') {
            continue;
        }
        if (String(record.command || '') !== 'workflow set') {
            continue;
        }
        if (normalizeSha256(record.after_sha256) === currentConfigHash
            && recordChangedTaskResetEnabled(record)
            && receiptMatchesAuditRecord(receipt, protectedReceiptEvidence, record)) {
            return true;
        }
    }
    return false;
}

function buildRemediationCommand(): string {
    return 'garda workflow set --target-root "." --task-reset-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"';
}

export function resolveTaskResetAvailability(repoRoot: string): TaskResetAvailability {
    const configPath = joinOrchestratorPath(repoRoot, path.join('live', 'config', 'workflow-config.json'));
    assertWorkflowTransactionReadable(path.dirname(path.dirname(path.dirname(configPath))));
    const remediationCommand = buildRemediationCommand();
    if (!fileExists(configPath)) {
        return {
            enabled: false,
            configuredEnabled: false,
            auditedEnablement: false,
            configPath,
            disabledReason: 'workflow-config.json is missing',
            remediationCommand
        };
    }

    try {
        const configText = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(configText) as unknown;
        const validated = validateWorkflowConfig(parsed);
        const defaultTaskReset = buildDefaultWorkflowConfig().task_reset as unknown as Record<string, unknown>;
        const taskReset = isPlainRecord(validated.task_reset)
            ? validated.task_reset
            : defaultTaskReset;
        const configuredEnabled = taskReset.enabled === true;
        const auditedEnablement = configuredEnabled
            ? hasAuditedTaskResetEnablement(repoRoot, sha256Text(configText))
            : false;
        if (configuredEnabled && !auditedEnablement) {
            return {
                enabled: false,
                configuredEnabled,
                auditedEnablement,
                configPath,
                disabledReason: 'workflow-config.task_reset.enabled is true but no matching audited workflow set record was found',
                remediationCommand
            };
        }
        return {
            enabled: configuredEnabled,
            configuredEnabled,
            auditedEnablement,
            configPath,
            disabledReason: configuredEnabled ? null : 'workflow-config.task_reset.enabled is false',
            remediationCommand
        };
    } catch (error: unknown) {
        return {
            enabled: false,
            configuredEnabled: false,
            auditedEnablement: false,
            configPath,
            disabledReason: `workflow-config.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
            remediationCommand
        };
    }
}
