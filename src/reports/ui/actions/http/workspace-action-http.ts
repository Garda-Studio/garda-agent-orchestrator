import type * as http from 'node:http';
import { buildUiWorkspaceAndBackupActionDefinitions } from '../registry';
import { BACKUP_DELETE_SELECTED_ACTION_ID } from '../backup-actions';
import { handleBackupDeletionRequest } from './backup-deletion-http';
import {
    isValidActionRequestBoundary,
    normalizeActionRequest,
    processUiActionRequest,
    readJsonBody,
    sendApiError,
    type LocalUiServerRuntimeOptions
} from './action-http-common';

export async function handleUiWorkspaceActionRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    if (!options.actionsEnabled) {
        sendApiError(response, 403, 'UI actions are disabled. Restart with --actions to enable allow-listed commands.', 'actions_disabled');
        return;
    }
    if (!isValidActionRequestBoundary(request, options)) {
        sendApiError(response, 403, 'UI action request failed origin, token, or content-type validation.', 'action_boundary_rejected');
        return;
    }
    const rawPayload = await readJsonBody(request);
    const payload = normalizeActionRequest(rawPayload);
    if (payload.action_id === BACKUP_DELETE_SELECTED_ACTION_ID) {
        handleBackupDeletionRequest(response, repoRoot, rawPayload);
        return;
    }
    const actions = buildUiWorkspaceAndBackupActionDefinitions(repoRoot);
    await processUiActionRequest(response, repoRoot, payload, actions, options);
}
