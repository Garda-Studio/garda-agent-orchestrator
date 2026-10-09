import type * as http from 'node:http';

import {
    appendUiActionAudit,
    buildUiActionDefinition,
    normalizeUiActionRunnerResult,
    normalizeUiActionTimeoutMs,
    uiActionExecutionAuditFields,
    uiActionExecutionPayload,
    uiActionHttpStatus
} from '../action-common';
import {
    TASK_RESET_CLOSE_ACTION_ID,
    TASK_RESET_REOPEN_ACTION_ID,
    TASK_RESET_CLOSE_CONFIRMATION_PHRASE,
    TASK_RESET_REOPEN_CONFIRMATION_PHRASE
} from '../task-actions';
import type { UiActionDefinition, UiActionRunnerResult } from '../types';
import {
    resolveUiActionMode,
    sendJson,
    type LocalUiServerRuntimeOptions,
    type UiActionRequest
} from './action-http-common';

const MAX_STEP_OUTPUT_CHARS = 1200;

export function isTaskResetOneShotActionId(actionId: unknown): boolean {
    return actionId === TASK_RESET_REOPEN_ACTION_ID || actionId === TASK_RESET_CLOSE_ACTION_ID;
}

function taskResetActionLabel(action: UiActionDefinition): string {
    return action.id === TASK_RESET_CLOSE_ACTION_ID ? 'Close without execution' : 'Reset task';
}

function taskResetActionSuccessLine(action: UiActionDefinition): string {
    return action.id === TASK_RESET_CLOSE_ACTION_ID
        ? 'Close without execution completed.'
        : 'Task reset completed.';
}

function buildTaskResetOneAction(repoRoot: string, action: UiActionDefinition): UiActionDefinition {
    return buildUiActionDefinition(
        repoRoot,
        action.id,
        action.category,
        action.label,
        action.description,
        [
            ...action.command.args.slice(1),
            '--one-action',
            '--operator-confirmed',
            'yes',
            '--operator-confirmed-at-utc',
            new Date().toISOString()
        ],
        { mutates: true, confirmationPhrase: action.confirmation_phrase || undefined, timeoutMs: action.timeout_ms }
    );
}

function buildOneShotCommandDisplay(action: UiActionDefinition): string {
    return `UI one-shot: confirmed native reset without changing permanent task-reset policy; ${action.command.display}`;
}

function actionSucceeded(result: UiActionRunnerResult): boolean {
    return result.timed_out !== true && result.exit_code === 0;
}

function compactOutput(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length <= MAX_STEP_OUTPUT_CHARS) {
        return trimmed;
    }
    return `${trimmed.slice(0, MAX_STEP_OUTPUT_CHARS)}\n[step output truncated]`;
}

function compactStepFailure(label: string, result: UiActionRunnerResult): string {
    const code = result.timed_out === true
        ? `timed out after ${result.timeout_ms ?? 'unknown'} ms`
        : `exit code ${result.exit_code ?? 'unknown'}`;
    const output = compactOutput([result.stderr, result.stdout].filter(Boolean).join('\n'));
    return output ? `${label} failed with ${code}.\n${output}` : `${label} failed with ${code}.`;
}

async function runStep(
    action: UiActionDefinition,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<UiActionRunnerResult> {
    try {
        return normalizeUiActionRunnerResult(action, await options.actionRunner(action, repoRoot));
    } catch (error: unknown) {
        return {
            exit_code: 1,
            signal: null,
            stdout: '',
            stderr: `Failed to launch command: ${error instanceof Error ? error.message : String(error)}`,
            timed_out: false,
            timeout_ms: normalizeUiActionTimeoutMs(action)
        };
    }
}

async function runTaskResetOneShotAction(
    action: UiActionDefinition,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<UiActionRunnerResult> {
    const result = await runStep(buildTaskResetOneAction(repoRoot, action), repoRoot, options);
    return {
        ...result,
        stdout: actionSucceeded(result) ? taskResetActionSuccessLine(action) : '',
        stderr: actionSucceeded(result) ? compactOutput(result.stderr) : compactStepFailure(taskResetActionLabel(action), result)
    };
}

export async function processTaskResetOneShotActionRequest(
    response: http.ServerResponse,
    repoRoot: string,
    taskId: string,
    payload: UiActionRequest,
    action: UiActionDefinition,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    const mode = resolveUiActionMode(payload);
    const command = buildOneShotCommandDisplay(action);
    const auditActionId = `${taskId}:${action.id}`;

    if (mode === 'preview') {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: auditActionId,
            mode,
            status: 'previewed',
            command
        });
        sendJson(response, 200, {
            action_id: action.id,
            mode,
            status: 'previewed',
            command,
            requires_confirmation: action.requires_confirmation,
            confirmation_phrase: action.confirmation_phrase,
            audit_path: auditPath,
            task_id: taskId
        });
        return;
    }

    const confirmationPhrase = action.id === TASK_RESET_CLOSE_ACTION_ID
        ? TASK_RESET_CLOSE_CONFIRMATION_PHRASE : TASK_RESET_REOPEN_CONFIRMATION_PHRASE;
    if (payload.confirmation !== confirmationPhrase) {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: auditActionId,
            mode,
            status: 'confirmation_required',
            command
        });
        sendJson(response, 409, {
            action_id: action.id,
            mode,
            status: 'confirmation_required',
            command,
            requires_confirmation: true,
            confirmation_phrase: confirmationPhrase,
            audit_path: auditPath,
            task_id: taskId
        });
        return;
    }

    const result = await runTaskResetOneShotAction(action, repoRoot, options);
    const auditPath = appendUiActionAudit(repoRoot, {
        timestamp_utc: new Date().toISOString(),
        action_id: auditActionId,
        mode,
        status: 'executed',
        command,
        ...uiActionExecutionAuditFields(result)
    });
    sendJson(response, uiActionHttpStatus(result), {
        action_id: action.id,
        mode,
        status: 'executed',
        command,
        ...uiActionExecutionPayload(result),
        audit_path: auditPath,
        task_id: taskId
    });
}
