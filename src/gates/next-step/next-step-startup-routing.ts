import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveBundleRootForTarget } from '../../core/constants';
import { inspectTaskEventFile, readTaskTimelineJsonlEntries } from '../../gate-runtime/task-events';
import { evaluateProtectedControlPlaneManifest, normalizePath } from '../shared/helpers';
import type {
    NextStepCommand,
    NextStepStatus
} from './';
import { buildCommand, quoteCommandValue } from './next-step-command-formatters';

function readJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readPathList(value: unknown): string[] {
    return Array.isArray(value) ? value.map((entry) => normalizePath(entry)).filter(Boolean) : [];
}

function formatFailureReason(value: unknown): string {
    return String(value || 'unavailable').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 1000) || 'unavailable';
}

function latestEventDetails(eventsRoot: string, taskId: string, eventType: string, outcome: string): Record<string, unknown> | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const inspection = inspectTaskEventFile(timelinePath, taskId);
    if (inspection.status !== 'PASS' && inspection.status !== 'PASS_WITH_LEGACY_PREFIX') return null;
    const entries = readTaskTimelineJsonlEntries(timelinePath);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const event = entries[index].record;
        if (event?.event_type === eventType && event.outcome === outcome) {
            return event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown> : null;
        }
    }
    return null;
}

function recoveryEventDetails(eventsRoot: string, taskId: string): Record<string, unknown> | null {
    return latestEventDetails(eventsRoot, taskId, 'TASK_MODE_PROTECTED_MANIFEST_RECOVERED', 'PASS');
}

function trustedFailureArtifact(eventsRoot: string, taskId: string, failurePath: string, failure: Record<string, unknown>): boolean {
    const details = latestEventDetails(eventsRoot, taskId, 'TASK_MODE_ENTRY_FAILED', 'FAIL');
    const attemptPath = path.resolve(String(details?.artifact_path || ''));
    const reviewsRoot = path.dirname(failurePath);
    const expectedAttemptName = new RegExp(`^${taskId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-task-mode-entry-failure-[0-9a-f-]{36}\\.json$`, 'iu');
    return failure.schema_version === 1
        && failure.task_id === taskId && failure.status === 'BLOCKED'
        && /^[0-9a-f-]{36}$/iu.test(String(failure.attempt_id || ''))
        && !!details && path.dirname(attemptPath) === reviewsRoot && expectedAttemptName.test(path.basename(attemptPath))
        && normalizePath(String(details.current_artifact_path || '')) === normalizePath(failurePath)
        && String(details.current_artifact_sha256 || '') === fileSha256(failurePath)
        && fs.existsSync(attemptPath)
        && String(details.artifact_sha256 || '') === fileSha256(attemptPath)
        && fileSha256(attemptPath) === fileSha256(failurePath)
        && String(details.attempt_id || '') === String(failure.attempt_id || '')
        && String(details.timestamp_utc || '') === String(failure.timestamp_utc || '')
        && String(details.manifest_status || '') === String(failure.manifest_status || '')
        && normalizePath(String(details.manifest_path || '')) === normalizePath(String(failure.manifest_path || ''))
        && String(details.observed_protected_snapshot_sha256 || '') === String(failure.observed_protected_snapshot_sha256 || '')
        && JSON.stringify(details.requested_entry) === JSON.stringify(failure.requested_entry);
}

function buildValidatedFreshEntryCommand(cliPrefix: string, taskId: string, value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    if (String(input.taskId || '') !== taskId) return null;
    const parts = [
        `${cliPrefix} gate enter-task-mode`, `--task-id ${quoteCommandValue(taskId)}`,
        `--entry-mode ${quoteCommandValue(String(input.entryMode || 'EXPLICIT_TASK_EXECUTION'))}`,
        `--requested-depth ${quoteCommandValue(String(input.requestedDepth || '2'))}`,
        `--task-summary ${quoteCommandValue(String(input.taskSummary || ''))}`,
        `--provider ${quoteCommandValue(String(input.provider || ''))}`
    ];
    for (const [flag, key] of [
        ['--effective-depth', 'effectiveDepth'], ['--start-banner', 'startBanner'], ['--routed-to', 'routedTo'],
        ['--actor', 'actor'], ['--plan-path', 'planPath'], ['--artifact-path', 'artifactPath'],
        ['--metrics-path', 'metricsPath']
    ] as const) {
        const field = String(input[key] || '').trim();
        if (field) parts.push(`${flag} ${quoteCommandValue(field)}`);
    }
    if (input.orchestratorWork === true) parts.push('--orchestrator-work');
    if (input.workflowConfigWork === true) parts.push('--workflow-config-work');
    if (input.orchestratorWork === true || input.workflowConfigWork === true) {
        parts.push('--operator-confirmed yes', '--operator-confirmed-at-utc "<ISO-8601 timestamp>"');
    }
    if (input.emitMetrics === false || String(input.emitMetrics || '').trim().toLowerCase() === 'false') {
        parts.push('--emit-metrics false');
    }
    for (const file of readPathList(input.plannedChangedFiles)) parts.push(`--planned-changed-file ${quoteCommandValue(file)}`);
    parts.push('--repo-root "."');
    return parts.join(' ');
}

export function readTaskModeProtectedManifestRecoveryRoute(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    cliPrefix: string
): {
    recovered: boolean; reason: string; command: string;
} | null {
    const reviewsRoot = path.join(resolveBundleRootForTarget(repoRoot), 'runtime', 'reviews');
    const failurePath = path.join(reviewsRoot, `${taskId}-task-mode-entry-failure.json`);
    const failure = readJsonRecord(failurePath);
    if (!failure) return null;
    if (!trustedFailureArtifact(eventsRoot, taskId, failurePath, failure)) return null;
    const taskMode = readJsonRecord(path.join(reviewsRoot, `${taskId}-task-mode.json`));
    if (taskMode && Date.parse(String(taskMode.timestamp_utc || '')) > Date.parse(String(failure.timestamp_utc || ''))) return null;
    const recoveryPath = path.join(reviewsRoot, `${taskId}-task-mode-entry-recovery.json`);
    const recovery = readJsonRecord(recoveryPath);
    const eventDetails = recoveryEventDetails(eventsRoot, taskId);
    const requestedEntry = failure.requested_entry;
    const freshEntryCommand = buildValidatedFreshEntryCommand(cliPrefix, taskId, requestedEntry);
    const recoveryMatchesFailure = recovery
        && recovery.schema_version === 1
        && String(recovery.task_id || '') === taskId
        && recovery.status === 'RECOVERED'
        && recovery.status_after === 'MATCH'
        && normalizePath(String(recovery.failure_artifact_path || '')) === normalizePath(failurePath)
        && String(recovery.failure_artifact_sha256 || '') === fileSha256(failurePath)
        && eventDetails
        && normalizePath(String(eventDetails.artifact_path || '')) === normalizePath(recoveryPath)
        && String(eventDetails.artifact_sha256 || '') === fileSha256(recoveryPath)
        && String(eventDetails.failure_artifact_sha256 || '') === String(recovery.failure_artifact_sha256 || '')
        && String(eventDetails.inspected_protected_snapshot_sha256 || '') === String(recovery.inspected_protected_snapshot_sha256 || '')
        && String(eventDetails.operator_confirmed_at_utc || '') === String(recovery.operator_confirmed_at_utc || '')
        && JSON.stringify(eventDetails.requested_entry) === JSON.stringify(requestedEntry)
        && JSON.stringify(recovery.requested_entry) === JSON.stringify(requestedEntry)
        && Date.parse(String(recovery.timestamp_utc || '')) >= Date.parse(String(failure.timestamp_utc || ''))
        && evaluateProtectedControlPlaneManifest(repoRoot, null, true).status === 'MATCH'
        && freshEntryCommand;
    if (recoveryMatchesFailure) {
        return { recovered: true, reason: 'Confirmed protected-manifest recovery is recorded; retry task-mode entry with fresh authorization.', command: freshEntryCommand };
    }
    const affected = readPathList(failure.affected_protected_paths);
    return {
        recovered: false,
        reason: `Task-mode entry failed because protected manifest status is ${String(failure.manifest_status || 'unknown')}. Failure reason: ${formatFailureReason(failure.reason)}. Manifest: ${String(failure.manifest_path || 'unknown')}. Affected paths: ${affected.join(', ') || 'unavailable'}. Inspect read-only with: ${String(failure.inspection_command || '')}. Explicit operator confirmation is required before mutation.`,
        command: `${cliPrefix} gate recover-task-mode-protected-manifest --task-id ${quoteCommandValue(taskId)} --inspected-protected-snapshot-sha256 ${quoteCommandValue(String(failure.observed_protected_snapshot_sha256 || '<sha256-from-failure>'))} --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --repo-root "."`
    };
}

export interface NextStepStartupCycleReadiness {
    ready: boolean;
    nextGate: string | null;
    title: string;
    reason: string;
}

export interface NextStepStartupRoute {
    status: NextStepStatus;
    nextGate: string;
    title: string;
    reason: string;
    commands: NextStepCommand[];
}

export interface NextStepStartupRouteOptions {
    enterTaskModePassed: boolean;
    defaultExecutionProvider: string | null;
    enterTaskModeCommand: string;
    startupCycleReadiness: NextStepStartupCycleReadiness;
    loadRulePackPassed: boolean;
    rulePackStage: string | null;
    preflightExists: boolean;
    taskEntryRulePackCommand: string;
    handshakeDiagnosticsPassed: boolean;
    handshakeDiagnosticsCommand: string;
    shellSmokePreflightPassed: boolean;
    shellSmokePreflightCommand: string;
    protectedManifestRecovery?: { recovered: boolean; reason: string; command: string } | null;
}

function commandForStartupCycleGate(
    readiness: NextStepStartupCycleReadiness,
    options: NextStepStartupRouteOptions
): NextStepCommand {
    if (readiness.nextGate === 'load-rule-pack') {
        return buildCommand('Load TASK_ENTRY rules', options.taskEntryRulePackCommand);
    }
    if (readiness.nextGate === 'handshake-diagnostics') {
        return buildCommand('Run handshake diagnostics', options.handshakeDiagnosticsCommand);
    }
    return buildCommand('Run shell smoke preflight', options.shellSmokePreflightCommand);
}

export function resolveNextStepStartupRoute(
    options: NextStepStartupRouteOptions
): NextStepStartupRoute | null {
    if (options.protectedManifestRecovery) {
        return {
            status: 'BLOCKED',
            nextGate: options.protectedManifestRecovery.recovered ? 'enter-task-mode' : 'recover-task-mode-protected-manifest',
            title: options.protectedManifestRecovery.recovered
                ? 'Retry task mode after confirmed protected-manifest recovery.'
                : 'Protected-manifest task-mode recovery requires operator confirmation.',
            reason: options.protectedManifestRecovery.reason,
            commands: [buildCommand(
                options.protectedManifestRecovery.recovered ? 'Enter task mode' : 'Recover protected manifest after operator confirmation',
                options.protectedManifestRecovery.command
            )]
        };
    }
    if (!options.enterTaskModePassed) {
        return {
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Enter task mode first.',
            reason: options.defaultExecutionProvider
                ? 'No TASK_MODE_ENTERED event exists for this task.'
                : 'No TASK_MODE_ENTERED event exists for this task, and runtime provider could not be detected from GARDA_EXECUTION_PROVIDER or known provider environment markers. Set GARDA_EXECUTION_PROVIDER to the current execution provider before running the command; do not use SourceOfTruth as a runtime-provider fallback.',
            commands: [
                buildCommand('Enter task mode', options.enterTaskModeCommand)
            ]
        };
    }

    if (!options.startupCycleReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: options.startupCycleReadiness.nextGate || 'startup-readiness',
            title: options.startupCycleReadiness.title,
            reason: options.startupCycleReadiness.reason,
            commands: [commandForStartupCycleGate(options.startupCycleReadiness, options)]
        };
    }

    if (
        !options.loadRulePackPassed
        || options.rulePackStage !== 'TASK_ENTRY' && !options.preflightExists
    ) {
        return {
            status: 'BLOCKED',
            nextGate: 'load-rule-pack',
            title: 'Record TASK_ENTRY rule files.',
            reason: 'Task execution must record the loaded core workflow rule pack before preflight.',
            commands: [
                buildCommand('Load TASK_ENTRY rules', options.taskEntryRulePackCommand)
            ]
        };
    }

    if (!options.handshakeDiagnosticsPassed) {
        return {
            status: 'BLOCKED',
            nextGate: 'handshake-diagnostics',
            title: 'Run handshake diagnostics.',
            reason: 'Runtime identity and reviewer launchability have not been recorded.',
            commands: [
                buildCommand('Run handshake diagnostics', options.handshakeDiagnosticsCommand)
            ]
        };
    }

    if (!options.shellSmokePreflightPassed) {
        return {
            status: 'BLOCKED',
            nextGate: 'shell-smoke-preflight',
            title: 'Run shell smoke preflight.',
            reason: 'CLI launchability and filesystem probes have not been recorded.',
            commands: [
                buildCommand('Run shell smoke preflight', options.shellSmokePreflightCommand)
            ]
        };
    }

    return null;
}
