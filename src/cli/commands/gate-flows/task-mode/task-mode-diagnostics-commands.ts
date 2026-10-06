import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import {
    emitCommandTimeoutDiagnosticsEvent,
    emitHandshakeDiagnosticsEvent,
    emitShellSmokePreflightEvent
} from '../../../../gate-runtime/lifecycle-events';
import {
    assertValidTaskId
} from '../../../../gate-runtime/task-events';
import { withFilesystemLock } from '../../../../gate-runtime/task-events-locking';
import {
    buildCommandTimeoutDiagnostics,
    formatCommandTimeoutDiagnosticsResult,
    resolveCommandTimeoutArtifactPath,
    type CommandPhaseRecord
} from '../../../../gates/diagnostics/command-timeout-diagnostics';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    buildHandshakeDiagnostics,
    formatHandshakeDiagnosticsResult,
    getHandshakeEvidence,
    getHandshakeEvidenceViolations,
    resolveHandshakeArtifactPath
} from '../../../../gates/diagnostics/handshake-diagnostics';
import {
    buildShellSmokePreflight,
    formatShellSmokePreflightResult,
    getShellSmokeEvidence,
    resolveShellSmokeArtifactPath
} from '../../../../gates/diagnostics/shell-smoke-preflight';
import {
    resolveDefaultMetricsPath,
    resolvePathForWrite,
    writeJsonArtifact
} from '../../../gate-cli/gates-artifacts';
import {
    parseBooleanOption
} from '../../../gate-cli/gates-parser';
import { requireResolvedPath } from '../../shared-command-utils';
import {
    appendMetricsIfEnabled,
    resolveOrchestratorRoot
} from '../compile/gate-flow-helpers';
import { readRoutingDecision } from './routing-decision';
import { getTaskModeEvidence } from '../../../../gates/task-mode/task-mode';
import { buildTaskPlanDiagnostics } from '../../../../gates/diagnostics/task-plan-diagnostics';
import {
    buildGateCommandPrefix,
    quotePowerShellCliValue
} from './task-mode-command-format';
import {
    assertResolvedRuntimeIdentityForDependentPreflightGate,
    resolveTaskModeReviewerRoutingFields
} from './task-mode-runtime-identity';

export interface HandshakeDiagnosticsCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    provider?: unknown;
    taskModePath?: string;
    cliPath?: unknown;
    effectiveCwd?: unknown;
    canonicalEntrypoint?: unknown;
    providerBridge?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    allowCurrentShellSmokePrecheck?: unknown;
    emitMetrics?: unknown;
}

export interface ShellSmokePreflightCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    provider?: unknown;
    routedTo?: unknown;
    taskModePath?: string;
    effectiveCwd?: unknown;
    probeTimeoutMs?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface CommandTimeoutDiagnosticsCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    provider?: unknown;
    routedTo?: unknown;
    taskModePath?: string;
    effectiveCwd?: unknown;
    commandRecordsPath?: string;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

function buildGateRerunCommand(repoRoot: string, taskId: string, gateName: string, taskModePath = ''): string {
    const parts = [
        `${buildGateCommandPrefix(repoRoot)} gate ${gateName}`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`
    ];
    const trimmedTaskModePath = String(taskModePath || '').trim();
    if (trimmedTaskModePath) {
        parts.push(`--task-mode-path ${quotePowerShellCliValue(trimmedTaskModePath)}`);
    }
    return parts.join(' ');
}

function resolvePrePreflightSequenceLockPath(repoRoot: string, taskId: string): string {
    return gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'task-events', `${taskId}-pre-preflight-sequence.lock`)
    );
}

export function runHandshakeDiagnosticsCommand(options: HandshakeDiagnosticsCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const routingDecision = readRoutingDecision(
        repoRoot,
        options.provider,
        options.providerBridge,
        taskId,
        options.taskModePath || ''
    );
    const provider = routingDecision.provider;
    const sequenceLockPath = resolvePrePreflightSequenceLockPath(repoRoot, taskId);

    return withFilesystemLock(sequenceLockPath, {}, () => {
        const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
        const shellSmokeEvidence = getShellSmokeEvidence(repoRoot, taskId, { timelinePath });
        const allowCurrentShellSmokePrecheck = parseBooleanOption(options.allowCurrentShellSmokePrecheck, false);
        const handshakePrecheckViolations = shellSmokeEvidence.evidence_status === 'PASS' && !allowCurrentShellSmokePrecheck
            ? [
                `Current task cycle in '${gateHelpers.normalizePath(timelinePath)}' already has valid SHELL_SMOKE_PREFLIGHT_RECORDED evidence. ` +
                'Re-running handshake-diagnostics now would invalidate the existing shell-smoke artifact for this cycle. ' +
                `Suggested rerun commands for the next cycle: ${buildGateRerunCommand(repoRoot, taskId, 'handshake-diagnostics', String(options.taskModePath || ''))} ; ` +
                `${buildGateRerunCommand(repoRoot, taskId, 'shell-smoke-preflight', String(options.taskModePath || ''))}.`
            ]
            : [];

        const artifactPath = options.artifactPath
            ? requireResolvedPath(resolvePathForWrite(options.artifactPath, repoRoot), 'ArtifactPath')
            : resolveHandshakeArtifactPath(repoRoot, taskId, '');
        const reviewerRoutingFields = resolveTaskModeReviewerRoutingFields(provider);

        const artifact = buildHandshakeDiagnostics({
            taskId,
            repoRoot,
            provider,
            canonicalSourceOfTruth: routingDecision.canonicalSourceOfTruth,
            cliPath: options.cliPath ? String(options.cliPath) : undefined,
            effectiveCwd: options.effectiveCwd ? String(options.effectiveCwd) : undefined,
            canonicalEntrypoint: options.canonicalEntrypoint ? String(options.canonicalEntrypoint) : undefined,
            providerBridge: options.providerBridge ? String(options.providerBridge) : undefined,
            routedTo: routingDecision.routedTo,
            executionProviderSource: routingDecision.executionProviderSource,
            reviewerCapabilityLevel: reviewerRoutingFields.reviewerCapabilityLevel,
            reviewerExpectedExecutionMode: reviewerRoutingFields.reviewerExpectedExecutionMode,
            reviewerFallbackAllowed: reviewerRoutingFields.reviewerFallbackAllowed,
            reviewerFallbackReasonRequired: reviewerRoutingFields.reviewerFallbackReasonRequired,
            reviewerSubagentLaunchStatus: routingDecision.reviewerSubagentLaunchStatus,
            reviewerSubagentLaunchRoute: routingDecision.reviewerSubagentLaunchRoute,
            reviewerSubagentLaunchReason: routingDecision.reviewerSubagentLaunchReason,
            reviewerSubagentLaunchRemediation: routingDecision.reviewerSubagentLaunchRemediation,
            runtimeIdentityStatus: routingDecision.identityStatus,
            runtimeIdentityViolations: routingDecision.violations,
            precheckViolations: handshakePrecheckViolations
        });
        const entryEvidence = getTaskModeEvidence(repoRoot, taskId, options.taskModePath || '');
        artifact.task_plan = buildTaskPlanDiagnostics(repoRoot, taskId, entryEvidence, entryEvidence.evidence_status);

        writeJsonArtifact(artifactPath, artifact);

        const artifactHash = gateHelpers.fileSha256(artifactPath);

        const metricsPath = options.metricsPath
            ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
            : resolveDefaultMetricsPath(repoRoot);
        appendMetricsIfEnabled(repoRoot, metricsPath, {
            timestamp_utc: artifact.timestamp_utc,
            event_type: 'handshake_diagnostics_recorded',
            task_id: taskId,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            artifact_hash: artifactHash,
            provider: artifact.provider,
            execution_context: artifact.execution_context,
            cli_path: artifact.cli_path,
            outcome: artifact.outcome
        }, parseBooleanOption(options.emitMetrics, true));

        emitHandshakeDiagnosticsEvent(
            orchestratorRoot,
            taskId,
            artifact.provider,
            artifact.execution_context,
            artifact.cli_path,
            artifact.outcome === 'PASS',
            artifactHash
        );

        const outputLines = formatHandshakeDiagnosticsResult(artifact);
        outputLines.push(`HandshakeArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`);

        return {
            outputLines,
            exitCode: artifact.outcome === 'PASS' ? 0 : EXIT_GATE_FAILURE
        };
    }).result;
}

export function runShellSmokePreflightCommand(options: ShellSmokePreflightCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const routingDecision = readRoutingDecision(
        repoRoot,
        options.provider,
        options.routedTo,
        taskId,
        options.taskModePath || ''
    );
    assertResolvedRuntimeIdentityForDependentPreflightGate(
        repoRoot,
        taskId,
        'shell-smoke-preflight',
        routingDecision,
        String(options.taskModePath || '')
    );
    const provider = routingDecision.provider;

    const sequenceLockPath = resolvePrePreflightSequenceLockPath(repoRoot, taskId);

    return withFilesystemLock(sequenceLockPath, {}, () => {
        const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));

        const artifactPath = options.artifactPath
            ? requireResolvedPath(resolvePathForWrite(options.artifactPath, repoRoot), 'ArtifactPath')
            : resolveShellSmokeArtifactPath(repoRoot, taskId, '');

        const probeTimeoutMs = options.probeTimeoutMs ? parseInt(String(options.probeTimeoutMs), 10) : undefined;
        const handshakeEvidence = getHandshakeEvidence(repoRoot, taskId, {
            taskModePath: options.taskModePath || '',
            timelinePath
        });
        const handshakeViolations = getHandshakeEvidenceViolations(handshakeEvidence).map((violation) => (
            `${violation} Suggested rerun commands: ${buildGateRerunCommand(repoRoot, taskId, 'handshake-diagnostics', String(options.taskModePath || ''))} ; ` +
            `${buildGateRerunCommand(repoRoot, taskId, 'shell-smoke-preflight', String(options.taskModePath || ''))}.`
        ));

        const artifact = buildShellSmokePreflight({
            taskId,
            repoRoot,
            provider,
            effectiveCwd: options.effectiveCwd ? String(options.effectiveCwd) : undefined,
            probeTimeoutMs: (probeTimeoutMs && probeTimeoutMs > 0) ? probeTimeoutMs : undefined,
            precheckViolations: handshakeViolations
        });

        writeJsonArtifact(artifactPath, artifact);

        const artifactHash = gateHelpers.fileSha256(artifactPath);

        const metricsPath = options.metricsPath
            ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
            : resolveDefaultMetricsPath(repoRoot);
        appendMetricsIfEnabled(repoRoot, metricsPath, {
            timestamp_utc: artifact.timestamp_utc,
            event_type: 'shell_smoke_preflight_recorded',
            task_id: taskId,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            artifact_hash: artifactHash,
            provider: artifact.provider,
            execution_context: artifact.execution_context,
            outcome: artifact.outcome
        }, parseBooleanOption(options.emitMetrics, true));

        emitShellSmokePreflightEvent(
            orchestratorRoot,
            taskId,
            artifact.provider,
            artifact.execution_context,
            artifact.outcome === 'PASS',
            artifactHash
        );

        const outputLines = formatShellSmokePreflightResult(artifact);
        outputLines.push(`ShellSmokeArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`);

        return {
            outputLines,
            exitCode: artifact.outcome === 'PASS' ? 0 : EXIT_GATE_FAILURE
        };
    }).result;
}

export function runCommandTimeoutDiagnosticsCommand(options: CommandTimeoutDiagnosticsCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const routingDecision = readRoutingDecision(
        repoRoot,
        options.provider,
        options.routedTo,
        taskId,
        options.taskModePath || ''
    );
    assertResolvedRuntimeIdentityForDependentPreflightGate(
        repoRoot,
        taskId,
        'command-timeout-diagnostics',
        routingDecision,
        String(options.taskModePath || '')
    );
    const provider = routingDecision.provider;

    const artifactPath = options.artifactPath
        ? requireResolvedPath(resolvePathForWrite(options.artifactPath, repoRoot), 'ArtifactPath')
        : resolveCommandTimeoutArtifactPath(repoRoot, taskId, '');

    let commands: CommandPhaseRecord[] = [];
    const commandRecordsPath = options.commandRecordsPath ? String(options.commandRecordsPath).trim() : '';
    if (commandRecordsPath) {
        const resolvedRecordsPath = path.resolve(repoRoot, commandRecordsPath);
        if (fs.existsSync(resolvedRecordsPath) && fs.statSync(resolvedRecordsPath).isFile()) {
            try {
                const raw = JSON.parse(fs.readFileSync(resolvedRecordsPath, 'utf8'));
                if (Array.isArray(raw)) {
                    commands = raw as CommandPhaseRecord[];
                } else if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).commands)) {
                    commands = (raw as Record<string, unknown>).commands as CommandPhaseRecord[];
                }
            } catch {
                return {
                    outputLines: [`ERROR: Failed to parse command records from '${commandRecordsPath}'.`],
                    exitCode: 3 // EXIT_USAGE_ERROR
                };
            }
        }
    }

    const artifact = buildCommandTimeoutDiagnostics({
        taskId,
        repoRoot,
        provider,
        effectiveCwd: options.effectiveCwd ? String(options.effectiveCwd) : undefined,
        commands
    });

    writeJsonArtifact(artifactPath, artifact);

    const artifactHash = gateHelpers.fileSha256(artifactPath);

    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: artifact.timestamp_utc,
        event_type: 'command_timeout_diagnostics_recorded',
        task_id: taskId,
        artifact_path: gateHelpers.normalizePath(artifactPath),
        artifact_hash: artifactHash,
        provider: artifact.provider,
        execution_context: artifact.execution_context,
        outcome: artifact.outcome,
        command_count: artifact.commands.length,
        timed_out_count: artifact.commands.filter(c => c.timed_out).length
    }, parseBooleanOption(options.emitMetrics, true));

    emitCommandTimeoutDiagnosticsEvent(
        orchestratorRoot,
        taskId,
        artifact.provider,
        artifact.execution_context,
        artifact.outcome === 'PASS',
        artifact.commands.length,
        artifact.commands.filter(c => c.timed_out).length,
        artifactHash
    );

    const outputLines = formatCommandTimeoutDiagnosticsResult(artifact, artifactPath);
    outputLines.push(`CommandTimeoutArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`);

    return {
        outputLines,
        exitCode: artifact.outcome === 'PASS' ? 0 : EXIT_GATE_FAILURE
    };
}
