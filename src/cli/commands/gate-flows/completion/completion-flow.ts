import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    EXIT_GENERAL_FAILURE
} from '../../../exit-codes';
import {
    DEFAULT_GIT_TIMEOUT_MS,
    spawnStreamed
} from '../../../../core/subprocess';
import {
    parseOperatorConfirmationYes,
    validateFreshOperatorConfirmation
} from '../../../../core/operator-confirmation';
import {
    appendTaskEvent,
    assertValidTaskId
} from '../../../../gate-runtime/task-events';
import { auditCommandCompactness } from '../../../../gates/task-events-summary/task-events-summary';
import {
    buildOrchestratorDefectCaptureSummary,
    ORCHESTRATOR_DEFECT_ACKNOWLEDGED_EVENT
} from '../../../../gates/task-audit/task-audit-summary-orchestrator-defects';
import type { CommandCompactnessAudit } from '../../../../gates/task-events-summary/task-events-summary';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    cleanupTerminalCompileLogs,
    cleanupTerminalReviewTempOutputs,
    resolvePathForWrite,
    type TerminalLogCleanupResult
} from '../../../gate-cli/gates-artifacts';
import {
    toCommandPolicyAuditSummary
} from '../../../gate-cli/gates-formatter';
import {
    parseJsonOption
} from '../../../gate-cli/gates-parser';
import { requireResolvedPath } from '../../shared-command-utils';
import {
    resolveOrchestratorRoot,
    isPlainObject
} from '../compile/gate-flow-helpers';

type CommandPolicyAudit = CommandCompactnessAudit;

export interface LogTaskEventCommandOptions {
    repoRoot?: string;
    eventsRoot?: string;
    taskId?: unknown;
    eventType?: unknown;
    outcome?: unknown;
    actor?: unknown;
    message?: unknown;
    detailsJson?: unknown;
}

export interface HumanCommitOptions {
    cwd?: string;
}

function parseHumanCommitInvocation(
    gitArgs: unknown,
    options: HumanCommitOptions
): { commitArgs: string[]; cwd: string } {
    const invocationCwd = options.cwd || process.cwd();
    let cwd = invocationCwd;
    let operatorConfirmed = false;
    let operatorConfirmedAtUtc: string | null = null;
    const commitArgs: string[] = [];
    const rawArgs = gateHelpers.toStringArray(gitArgs).filter(function (item: string) {
        return String(item || '').trim() !== '';
    });

    for (let index = 0; index < rawArgs.length; index += 1) {
        const argument = rawArgs[index];
        if (argument === '--') {
            commitArgs.push(...rawArgs.slice(index));
            break;
        }
        if (argument === '--repo-root') {
            const repoRoot = rawArgs[index + 1];
            if (!repoRoot) throw new Error('--repo-root requires a value.');
            cwd = path.resolve(invocationCwd, repoRoot);
            index += 1;
            continue;
        }
        if (argument.startsWith('--repo-root=')) {
            const repoRoot = argument.slice('--repo-root='.length);
            if (!repoRoot) throw new Error('--repo-root requires a value.');
            cwd = path.resolve(invocationCwd, repoRoot);
            continue;
        }
        if (argument === '--operator-confirmed') {
            const confirmation = rawArgs[index + 1];
            if (!confirmation) throw new Error('--operator-confirmed requires the exact value "yes".');
            operatorConfirmed = parseOperatorConfirmationYes(confirmation);
            index += 1;
            continue;
        }
        if (argument.startsWith('--operator-confirmed=')) {
            operatorConfirmed = parseOperatorConfirmationYes(argument.slice('--operator-confirmed='.length));
            continue;
        }
        if (argument === '--operator-confirmed-at-utc') {
            const confirmedAt = rawArgs[index + 1];
            if (!confirmedAt) throw new Error('--operator-confirmed-at-utc requires an ISO-8601 timestamp.');
            operatorConfirmedAtUtc = confirmedAt;
            index += 1;
            continue;
        }
        if (argument.startsWith('--operator-confirmed-at-utc=')) {
            operatorConfirmedAtUtc = argument.slice('--operator-confirmed-at-utc='.length);
            continue;
        }
        commitArgs.push(argument);
    }

    validateFreshOperatorConfirmation({
        actionLabel: 'human-commit',
        confirmed: operatorConfirmed,
        confirmedAtUtc: operatorConfirmedAtUtc,
        instruction: 'Ask the user "Do you want me to commit now? (yes/no)" and rerun only after a yes response with --operator-confirmed yes.'
    });

    if (commitArgs.length === 0) {
        throw new Error('Provide git commit arguments, for example: -m "feat: message"');
    }

    return { commitArgs, cwd };
}

interface CommandAuditPayload {
    command_text: string;
    mode: string;
    justification: string;
}

interface LogTaskEventCommandResult {
    status: string;
    task_id: string;
    event_type: string;
    outcome: string;
    actor: string;
    task_event_log_path: string;
    all_tasks_log_path: string;
    integrity?: NonNullable<ReturnType<typeof appendTaskEvent>>['integrity'];
    warnings?: string[];
    command_policy_audit?: CommandPolicyAudit;
    terminal_log_cleanup?: TerminalLogCleanupResult;
    terminal_review_temp_cleanup?: TerminalLogCleanupResult;
}

function toDetailsMap(detailsObject: unknown): Record<string, unknown> {
    if (detailsObject == null) {
        return {};
    }
    if (isPlainObject(detailsObject)) {
        return { ...detailsObject };
    }
    return {
        input_details: detailsObject
    };
}

function getCommandAuditPayload(detailsObject: unknown): CommandAuditPayload | null {
    if (!isPlainObject(detailsObject)) {
        return null;
    }

    let commandText = '';
    for (const candidateKey of ['command', 'command_text', 'shell_command']) {
        const value = detailsObject[candidateKey];
        if (typeof value === 'string' && value.trim()) {
            commandText = value.trim();
            break;
        }
    }
    if (!commandText) {
        return null;
    }

    return {
        command_text: commandText,
        mode: String(detailsObject.command_mode || detailsObject.mode || 'scan'),
        justification: String(detailsObject.command_justification || detailsObject.justification || '')
    };
}

export function runLogTaskEventCommand(options: LogTaskEventCommandOptions): { outputText: string; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const eventsRoot = options.eventsRoot
        ? requireResolvedPath(resolvePathForWrite(options.eventsRoot, repoRoot), 'EventsRoot')
        : gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const eventType = String(options.eventType || '').trim();
    const outcome = String(options.outcome || 'INFO').trim().toUpperCase();
    const actor = String(options.actor || 'orchestrator').trim() || 'orchestrator';
    const message = String(options.message || '');
    const details = parseJsonOption(options.detailsJson || '', 'DetailsJson');

    if (!eventType) {
        throw new Error('EventType must not be empty.');
    }
    if (!['INFO', 'PASS', 'FAIL', 'BLOCKED'].includes(outcome)) {
        throw new Error(`Outcome must be one of INFO, PASS, FAIL, BLOCKED. Got '${outcome}'.`);
    }
    const reservedEventTypes = new Set([
        'TASK_MODE_ENTERED',
        'RULE_PACK_LOADED',
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'SHELL_SMOKE_PREFLIGHT_RECORDED',
        'WORKFLOW_CONFIG_MUTATION_AUDITED',
        'WORKFLOW_CONFIG_MUTATION_PREPARED',
        'REVIEW_PHASE_STARTED',
        'REVIEW_RECORDED',
        'REVIEWER_DELEGATION_ROUTED',
        'REVIEWER_LAUNCH_PREPARED',
        'REVIEWER_INVOCATION_ATTESTED'
    ]);
    const reservedEventPattern = /^(COMPILE_GATE_|REVIEW_GATE_|REVIEWER_|PREFLIGHT_|COMPLETION_GATE_|FULL_SUITE_VALIDATION_|DOC_IMPACT_)/;
    const normalizedEventType = eventType.toUpperCase();
    if (reservedEventTypes.has(normalizedEventType) || reservedEventPattern.test(normalizedEventType)) {
        throw new Error(`EventType '${eventType}' is reserved and cannot be emitted via log-task-event.`);
    }
    if (normalizedEventType === ORCHESTRATOR_DEFECT_ACKNOWLEDGED_EVENT) {
        const capture = buildOrchestratorDefectCaptureSummary({
            repoRoot,
            taskId,
            events: [{ task_id: taskId, event_type: normalizedEventType, details }]
        });
        if (capture.status !== 'CAPTURED') {
            throw new Error(`${ORCHESTRATOR_DEFECT_ACKNOWLEDGED_EVENT} admission rejected: `
                + (capture.violations.join('; ') || capture.visible_summary_line));
        }
    }

    fs.mkdirSync(eventsRoot, { recursive: true });

    let eventDetails: unknown = details;
    let terminalLogCleanup: TerminalLogCleanupResult = {
        triggered: false,
        attempted_paths: 0,
        discovered_paths: [],
        deleted_paths: [],
        stale_deleted_paths: [],
        missing_paths: [],
        retained_paths: [],
        errors: []
    };
    let terminalReviewTempCleanup: TerminalLogCleanupResult = {
        triggered: false,
        attempted_paths: 0,
        discovered_paths: [],
        deleted_paths: [],
        stale_deleted_paths: [],
        missing_paths: [],
        retained_paths: [],
        errors: []
    };
    const isTerminalEvent = eventType === 'TASK_DONE' || eventType === 'TASK_BLOCKED';
    if (isTerminalEvent) {
        terminalLogCleanup = cleanupTerminalCompileLogs(repoRoot, taskId);
        terminalReviewTempCleanup = cleanupTerminalReviewTempOutputs(repoRoot, taskId);
        const detailsMap = toDetailsMap(eventDetails);
        detailsMap.terminal_log_cleanup = terminalLogCleanup;
        detailsMap.terminal_review_temp_cleanup = terminalReviewTempCleanup;
        eventDetails = detailsMap;
    }

    let commandCompactnessAudit: CommandPolicyAudit | null = null;
    const auditPayload = getCommandAuditPayload(eventDetails);
    if (auditPayload) {
        commandCompactnessAudit = auditCommandCompactness(auditPayload.command_text, {
            mode: auditPayload.mode,
            justification: auditPayload.justification
        });
        const detailsMap = toDetailsMap(eventDetails);
        detailsMap.command_policy_audit = commandCompactnessAudit;
        eventDetails = detailsMap;
    }

    const appendResult = appendTaskEvent(
        orchestratorRoot,
        taskId,
        eventType,
        outcome,
        message,
        eventDetails,
        {
            actor,
            passThru: true,
            eventsRoot
        }
    );
    const result: LogTaskEventCommandResult = {
        status: 'TASK_EVENT_LOGGED',
        task_id: taskId,
        event_type: eventType,
        outcome,
        actor,
        task_event_log_path: gateHelpers.normalizePath(path.join(eventsRoot, `${taskId}.jsonl`)),
        all_tasks_log_path: gateHelpers.normalizePath(path.join(eventsRoot, 'all-tasks.jsonl'))
    };

    if (appendResult && isPlainObject(appendResult.integrity)) {
        result.integrity = appendResult.integrity;
    }
    if (appendResult && Array.isArray(appendResult.warnings) && appendResult.warnings.length > 0) {
        result.warnings = [...appendResult.warnings];
    }
    if (commandCompactnessAudit) {
        result.command_policy_audit = commandCompactnessAudit;
        const auditSummary = toCommandPolicyAuditSummary(commandCompactnessAudit);
        if (auditSummary.warning_count > 0) {
            result.warnings = [...(result.warnings || []), ...auditSummary.warnings];
        }
    }
    if (isTerminalEvent) {
        result.terminal_log_cleanup = terminalLogCleanup;
        result.terminal_review_temp_cleanup = terminalReviewTempCleanup;
    }

    const cleanupFailed = isTerminalEvent
        && (terminalLogCleanup.errors.length > 0 || terminalReviewTempCleanup.errors.length > 0);
    if (cleanupFailed) {
        result.status = 'TASK_EVENT_LOGGED_CLEANUP_FAILED';
    }

    return {
        outputText: `${JSON.stringify(result, null, 2)}\n`,
        exitCode: cleanupFailed ? EXIT_GENERAL_FAILURE : 0
    };
}

export async function runHumanCommitCommand(gitArgs: unknown, options: HumanCommitOptions = {}): Promise<number> {
    const invocation = parseHumanCommitInvocation(gitArgs, options);

    const result = await spawnStreamed('git', ['commit', ...invocation.commitArgs], {
        cwd: invocation.cwd,
        inheritStdio: true,
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        env: { GARDA_ALLOW_COMMIT: '1' }
    });

    return result.exitCode;
}
