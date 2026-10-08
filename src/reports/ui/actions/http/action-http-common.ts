import type * as http from 'node:http';
import { BACKUP_RESTORE_ACTION_ID_PREFIX } from '../backup-actions';
import {
    appendUiActionAudit,
    findAction,
    formatPublicAction,
    normalizeUiActionRunnerResult,
    uiActionExecutionAuditFields,
    uiActionExecutionPayload,
    uiActionHttpStatus
} from '../action-common';
import type { UiActionDefinition, UiActionMode, UiActionRunner } from '../types';

export interface LocalUiServerRuntimeOptions {
    actionsEnabled: boolean;
    actionRunner: UiActionRunner;
    actionToken: string;
    trustedOriginHost: string;
}

export interface UiActionRequest {
    action_id?: unknown;
    mode?: unknown;
    confirmation?: unknown;
}

export function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
    });
    response.end(JSON.stringify(payload, null, 2));
}

export function sendApiError(response: http.ServerResponse, statusCode: number, error: string, code: string): void {
    sendJson(response, statusCode, { error, code });
}

export function readJsonBody(request: http.IncomingMessage, maxBytes = 8192): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let raw = '';
        let receivedBytes = 0;
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            receivedBytes += Buffer.byteLength(chunk, 'utf8');
            if (receivedBytes > maxBytes) {
                reject(new Error('Request body is too large.'));
                request.destroy();
                return;
            }
            raw += chunk;
        });
        request.on('error', reject);
        request.on('end', () => {
            if (raw.trim() === '') {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new Error('Request body must be valid JSON.'));
            }
        });
    });
}

function isJsonRequest(request: http.IncomingMessage): boolean {
    const contentType = request.headers['content-type'];
    const value = Array.isArray(contentType) ? contentType[0] : contentType;
    return typeof value === 'string' && value.toLowerCase().split(';', 1)[0].trim() === 'application/json';
}

function getRequestOrigin(request: http.IncomingMessage): string | null {
    const origin = request.headers.origin;
    if (Array.isArray(origin)) {
        return origin[0] || null;
    }
    return typeof origin === 'string' && origin ? origin : null;
}

function getExpectedOrigin(request: http.IncomingMessage, options: Pick<LocalUiServerRuntimeOptions, 'trustedOriginHost'>): string | null {
    const localPort = request.socket.localPort;
    if (typeof localPort !== 'number' || !Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
        return null;
    }
    return new URL(`http://${options.trustedOriginHost}:${localPort}`).origin;
}

export function isValidActionRequestBoundary(
    request: http.IncomingMessage,
    options: Pick<LocalUiServerRuntimeOptions, 'actionToken' | 'trustedOriginHost'>
): boolean {
    const expectedOrigin = getExpectedOrigin(request, options);
    const actualOrigin = getRequestOrigin(request);
    const token = request.headers['x-garda-action-token'];
    return expectedOrigin !== null
        && actualOrigin === expectedOrigin
        && token === options.actionToken
        && isJsonRequest(request);
}

export function normalizeActionRequest(payload: unknown): UiActionRequest {
    return payload && typeof payload === 'object' ? payload as UiActionRequest : {};
}

export function resolveUiActionMode(payload: UiActionRequest): UiActionMode {
    return payload.mode === 'execute' ? 'execute' : 'preview';
}

export function resolveActionForMode(action: UiActionDefinition, mode: UiActionMode): UiActionDefinition {
    if (mode !== 'preview' || !action.id.startsWith(BACKUP_RESTORE_ACTION_ID_PREFIX)) {
        return action;
    }
    const rollbackIndex = action.command.args.indexOf('rollback');
    if (rollbackIndex === -1 || action.command.args.includes('--dry-run')) {
        return action;
    }
    const previewArgs = [
        ...action.command.args.slice(0, rollbackIndex + 1),
        '--dry-run',
        ...action.command.args.slice(rollbackIndex + 1)
    ];
    return {
        ...action,
        command: {
            ...action.command,
            args: previewArgs,
            display: action.command.display.replace('rollback', 'rollback --dry-run')
        }
    };
}

export interface ProcessUiActionOptions {
    auditActionId?: string;
    extraResponseFields?: Record<string, unknown>;
}

export async function processUiActionRequest(
    response: http.ServerResponse,
    repoRoot: string,
    payload: UiActionRequest,
    actions: UiActionDefinition[],
    options: LocalUiServerRuntimeOptions,
    processOptions: ProcessUiActionOptions = {}
): Promise<void> {
    const action = findAction(actions, payload.action_id);
    if (!action) {
        sendApiError(response, 400, processOptions.extraResponseFields?.task_id ? 'Unknown task UI action.' : 'Unknown UI action.', processOptions.extraResponseFields?.task_id ? 'unknown_task_action' : 'unknown_action');
        return;
    }
    const taskId = processOptions.extraResponseFields?.task_id;
    const auditActionId = typeof taskId === 'string' && taskId
        ? `${taskId}:${action.id}`
        : processOptions.auditActionId || action.id;
    const mode = resolveUiActionMode(payload);
    const responseExtras = processOptions.extraResponseFields || {};

    if (action.enabled === false) {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: auditActionId,
            mode,
            status: 'unavailable',
            command: action.command.display
        });
        sendJson(response, 409, {
            action_id: action.id,
            mode,
            status: 'unavailable',
            command: action.command.display,
            unavailable_reason: action.unavailable_reason || 'Action is unavailable.',
            audit_path: auditPath,
            ...responseExtras
        });
        return;
    }

    if (mode === 'preview') {
        const effectiveAction = resolveActionForMode(action, mode);
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: auditActionId,
            mode,
            status: 'previewed',
            command: effectiveAction.command.display
        });
        sendJson(response, 200, {
            action_id: action.id,
            mode,
            status: 'previewed',
            command: effectiveAction.command.display,
            requires_confirmation: action.requires_confirmation,
            confirmation_phrase: action.confirmation_phrase,
            audit_path: auditPath,
            ...responseExtras
        });
        return;
    }

    if (action.requires_confirmation && payload.confirmation !== action.confirmation_phrase) {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: auditActionId,
            mode,
            status: 'confirmation_required',
            command: action.command.display
        });
        sendJson(response, 409, {
            action_id: action.id,
            mode,
            status: 'confirmation_required',
            command: action.command.display,
            requires_confirmation: true,
            confirmation_phrase: action.confirmation_phrase,
            audit_path: auditPath,
            ...responseExtras
        });
        return;
    }

    try {
        const effectiveAction = resolveActionForMode(action, mode);
        const result = normalizeUiActionRunnerResult(effectiveAction, await options.actionRunner(effectiveAction, repoRoot));
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: auditActionId,
            mode,
            status: 'executed',
            command: effectiveAction.command.display,
            ...uiActionExecutionAuditFields(result)
        });
        sendJson(response, uiActionHttpStatus(result), {
            action_id: action.id,
            mode,
            status: 'executed',
            command: effectiveAction.command.display,
            ...uiActionExecutionPayload(result),
            audit_path: auditPath,
            ...responseExtras
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: auditActionId,
            mode,
            status: 'failed_to_launch',
            command: action.command.display,
            error: message
        });
        sendJson(response, 500, {
            action_id: action.id,
            mode,
            status: 'failed_to_launch',
            command: action.command.display,
            error: message,
            audit_path: auditPath,
            ...responseExtras
        });
    }
}

export function formatPublicActions(actions: UiActionDefinition[]): Record<string, unknown>[] {
    return actions.map(formatPublicAction);
}
