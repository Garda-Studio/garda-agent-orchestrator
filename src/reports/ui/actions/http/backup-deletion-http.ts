import type * as http from 'node:http';
import { deleteSelectedBackups, previewBackupDeletion } from '../../../../lifecycle/backups';
import { appendUiActionAudit } from '../action-common';
import { BACKUP_DELETE_CONFIRMATION_PHRASE, BACKUP_DELETE_SELECTED_ACTION_ID } from '../backup-actions';
import { sendApiError, sendJson } from './action-http-common';

const REQUEST_KEYS = new Set(['action_id', 'mode', 'snapshot_ids', 'confirmation',
    'confirmation_token', 'confirm_final_recovery_point']);

// Called only after the shared actions-enabled/origin/token/JSON boundary.
// The backend owns its lifecycle lock; never wrap this adapter in another lock.
export function handleBackupDeletionRequest(
    response: http.ServerResponse,
    repoRoot: string,
    raw: unknown
): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        sendApiError(response, 400, 'Expected a backup deletion request object.', 'invalid_backup_selection');
        return;
    }
    const payload = raw as Record<string, unknown>;
    const ids = payload.snapshot_ids;
    if (Object.keys(payload).some(key => !REQUEST_KEYS.has(key))
        || payload.action_id !== BACKUP_DELETE_SELECTED_ACTION_ID
        || (payload.mode !== 'preview' && payload.mode !== 'execute')
        || !Array.isArray(ids) || ids.length === 0 || ids.length > 128
        || ids.some(id => typeof id !== 'string' || !id || id.length > 128)
        || new Set(ids).size !== ids.length) {
        sendApiError(response, 400, 'Use explicit unique snapshot IDs and a preview or execute mode; client paths are not accepted.', 'invalid_backup_selection');
        return;
    }
    const mode = payload.mode as 'preview' | 'execute';
    if (mode === 'execute' && (payload.confirmation !== BACKUP_DELETE_CONFIRMATION_PHRASE
        || typeof payload.confirmation_token !== 'string'
        || !/^[a-f0-9]{64}$/u.test(payload.confirmation_token)
        || payload.confirm_final_recovery_point !== undefined && typeof payload.confirm_final_recovery_point !== 'boolean')) {
        sendApiError(response, 409, 'Confirm the exact previewed selection before deleting recovery points.', 'confirmation_required');
        return;
    }
    let auditPath: string;
    try {
        // Persist intent before a destructive call: audit failure must not hide a completed deletion.
        auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(), action_id: BACKUP_DELETE_SELECTED_ACTION_ID,
            mode, status: mode === 'execute' ? 'execution_requested' : 'preview_requested',
            command: `backup delete-selected ${JSON.stringify(ids)}`
        });
    } catch {
        sendApiError(response, 503, 'Backup deletion audit is unavailable; no deletion was attempted.', 'backup_audit_unavailable');
        return;
    }
    const recordOutcome = (status: string, details: Record<string, unknown>): string | null => {
        try {
            appendUiActionAudit(repoRoot, {
                timestamp_utc: new Date().toISOString(), action_id: BACKUP_DELETE_SELECTED_ACTION_ID,
                mode, status, command: `backup delete-selected ${JSON.stringify(ids)}`, ...details
            });
            return null;
        } catch {
            // An outcome-audit failure cannot turn an already completed deletion into a rejection.
            return 'Backup outcome audit could not be persisted; use the returned deletion result.';
        }
    };
    try {
        if (mode === 'preview') {
            const { targetRoot: _targetRoot, ...preview } = previewBackupDeletion({ targetRoot: repoRoot, snapshotIds: ids });
            const auditError = recordOutcome('previewed', { snapshotIds: preview.snapshotIds });
            sendJson(response, 200, { audit_error: auditError, action_id: BACKUP_DELETE_SELECTED_ACTION_ID, mode, status: 'previewed',
                ...preview, confirmation_phrase: BACKUP_DELETE_CONFIRMATION_PHRASE,
                irreversible: true, audit_path: auditPath });
            return;
        }
        const { targetRoot: _targetRoot, ...result } = deleteSelectedBackups({
            targetRoot: repoRoot, snapshotIds: ids, confirmationToken: payload.confirmation_token as string,
            confirm: true, confirmFinalRecoveryPoint: payload.confirm_final_recovery_point === true
        });
        const status = result.result === 'SUCCESS' ? 'executed' : 'partial_failure';
        const auditError = recordOutcome(status, { ...result });
        sendJson(response, 200, { action_id: BACKUP_DELETE_SELECTED_ACTION_ID, mode,
            status, ...result, audit_path: auditPath, audit_error: auditError });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Backup deletion was rejected.';
        recordOutcome('rejected', { error: message });
        sendApiError(response, 409, message, 'backup_deletion_rejected');
    }
}
