import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveBundleNameForTarget } from '../../core/constants';
import { isAuthenticatedWorkflowMigration } from '../../core/auth/local-commit-availability';
import { readWorkflowAuditTaskEntryHash } from '../../core/workflow-config-audit';
import { normalizePath, toPlainRecord } from '../shared/helpers';
import type {
    WorkflowConfigAuditChangeRecord,
    WorkflowConfigAuditProvenance
} from './workflow-config-work-contracts';
import {
    getWorkflowConfigChangedFiles,
    normalizeWorkflowConfigSha256
} from './workflow-config-work-paths';

function resolveWorkflowConfigAuditPath(repoRoot: string): string {
    return path.join(repoRoot, resolveBundleNameForTarget(repoRoot), 'runtime', 'workflow-config-audit.jsonl');
}

function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(value
        .map((entry) => String(entry || '').trim())
        .filter(Boolean))]
        .sort((left, right) => left.localeCompare(right));
}

function normalizeAuditConfigPath(repoRoot: string, rawPath: unknown): string {
    const rawText = String(rawPath || '').trim();
    if (!rawText) {
        return '';
    }
    const normalizedText = normalizePath(rawText);
    try {
        const absolutePath = path.isAbsolute(rawText)
            ? rawText
            : path.resolve(repoRoot, ...normalizedText.split('/'));
        const relativePath = normalizePath(path.relative(repoRoot, absolutePath));
        return relativePath && !relativePath.startsWith('..')
            ? relativePath
            : normalizedText;
    } catch {
        return normalizedText;
    }
}

function readWorkflowConfigAuditRecords(repoRoot: string): WorkflowConfigAuditChangeRecord[] {
    const auditPath = resolveWorkflowConfigAuditPath(repoRoot);
    if (!fs.existsSync(auditPath)) {
        return [];
    }
    const records: WorkflowConfigAuditChangeRecord[] = [];
    try {
        const lines = fs.readFileSync(auditPath, 'utf8').split(/\r?\n/u);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(trimmed);
            } catch {
                continue;
            }
            const record = toPlainRecord(parsed);
            if (!record || record.event_source !== 'workflow-config-set') {
                continue;
            }
            const migration = record.mutation_source === 'lifecycle';
            if (migration && !isAuthenticatedWorkflowMigration(repoRoot, record)) continue;
            const afterSha256 = normalizeWorkflowConfigSha256(record.after_sha256);
            records.push({
                audit_path: normalizePath(auditPath),
                timestamp_utc: String(record.timestamp_utc || '').trim() || null,
                mutation_source: String(record.mutation_source || 'cli').trim().toLowerCase() || 'cli',
                actor: String(record.actor || '').trim() || null,
                config_path: normalizeAuditConfigPath(repoRoot, record.config_path),
                changed_fields: toStringArray(record.changed_fields),
                active_task_ids: toStringArray(record.active_task_ids),
                active_task_id: String(record.active_task_id || '').trim() || null,
                after_sha256: afterSha256,
                before_sha256: normalizeWorkflowConfigSha256(record.before_sha256),
                ...(migration ? { migration_task_entries: toPlainRecord(record.task_entry_sha256) as Record<string, string> || {} } : {})
            });
        }
    } catch {
        return [];
    }
    return records;
}

function isAcceptedMutationSource(source: string): boolean {
    return source === 'local-ui' || source === 'cli' || source === 'lifecycle';
}

function auditRecordMatchesTask(record: WorkflowConfigAuditChangeRecord, taskId: string | null): boolean {
    if (!taskId || record.active_task_ids.length === 0) {
        return true;
    }
    return record.active_task_ids.includes(taskId);
}

function findAuditRecordForChangedFile(params: {
    records: readonly WorkflowConfigAuditChangeRecord[];
    relativePath: string;
    currentHash: string | null;
    taskId: string | null;
    baselineHash: string | null;
    taskEntryHash: string | null;
}): WorkflowConfigAuditChangeRecord | null {
    if (!params.currentHash) {
        return null;
    }
    const matches = params.records.filter((record) => (
        isAcceptedMutationSource(record.mutation_source)
        && record.config_path === params.relativePath
        && record.after_sha256 === params.currentHash
        && record.changed_fields.length > 0
        && auditRecordMatchesTask(record, params.taskId)
    ));
    const match = matches.at(-1);
    if (!match) return null;
    if (match.mutation_source !== 'lifecycle') return match;
    if (!params.baselineHash) return null;
    let expectedHash = params.currentHash;
    for (let index = params.records.lastIndexOf(match); index >= 0; index--) {
        const record = params.records[index];
        if (record.config_path !== params.relativePath) continue;
        if (record.after_sha256 !== expectedHash || !isAcceptedMutationSource(record.mutation_source)
            || !auditRecordMatchesTask(record, params.taskId)) return null;
        if (record.mutation_source === 'lifecycle' && params.taskId
            && (!params.taskEntryHash || record.migration_task_entries?.[params.taskId] !== params.taskEntryHash)) return null;
        if (record.before_sha256 === params.baselineHash) return match;
        if (!record.before_sha256) return null;
        expectedHash = record.before_sha256;
    }
    return null;
}

export function getAuditedWorkflowConfigChangeProvenance(options: {
    repoRoot: string;
    changedFiles: readonly string[];
    currentFileHashes: Record<string, string | null>;
    baselineFileHashes?: Record<string, string | null> | null;
    taskId?: string | null;
}): WorkflowConfigAuditProvenance {
    const changedFiles = getWorkflowConfigChangedFiles(options.changedFiles, Object.keys(options.currentFileHashes));
    const records = changedFiles.length > 0 ? readWorkflowConfigAuditRecords(options.repoRoot) : [];
    const acceptedRecords: WorkflowConfigAuditChangeRecord[] = [];
    const auditedFiles: string[] = [];
    const unauditedFiles: string[] = [];
    const taskId = String(options.taskId || '').trim() || null;
    const needsMigrationBinding = records.some(record => record.mutation_source === 'lifecycle'
        && changedFiles.includes(record.config_path));
    const taskEntryHash = taskId && needsMigrationBinding ? readWorkflowAuditTaskEntryHash(
        path.join(options.repoRoot, resolveBundleNameForTarget(options.repoRoot)), taskId) : null;
    for (const relativePath of changedFiles) {
        const record = findAuditRecordForChangedFile({
            records,
            relativePath,
            currentHash: options.currentFileHashes[relativePath] ?? null,
            taskId,
            baselineHash: options.baselineFileHashes?.[relativePath] ?? null,
            taskEntryHash
        });
        if (record) {
            auditedFiles.push(relativePath);
            acceptedRecords.push(record);
        } else {
            unauditedFiles.push(relativePath);
        }
    }
    const uniqueSources = [...new Set(acceptedRecords.map((record) => record.mutation_source))].sort();
    const uniqueFields = [...new Set(acceptedRecords.flatMap((record) => record.changed_fields))].sort();
    const accepted = changedFiles.length > 0 && unauditedFiles.length === 0;
    return {
        accepted,
        audited_files: auditedFiles,
        unaudited_files: unauditedFiles,
        records: acceptedRecords,
        visible_summary_line: accepted
            ? `Workflow-config changes audited: files=${auditedFiles.join(', ')}; source=${uniqueSources.join(', ')}; fields=${uniqueFields.join(', ')}. Current gates must refresh against the new config.`
            : unauditedFiles.length > 0
                ? `Workflow-config changes missing accepted audit provenance: ${unauditedFiles.join(', ')}.`
                : 'Workflow-config audit provenance: no changed workflow-config files.'
    };
}
