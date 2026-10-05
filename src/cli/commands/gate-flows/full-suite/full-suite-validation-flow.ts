import * as fs from 'node:fs';
import * as path from 'node:path';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../../../core/constants';
import { VALIDATION_REPO_ROOT_ENV, VALIDATION_TASK_ID_ENV } from '../../../../core/validation-output-retention';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { redactSecretText } from '../../../../core/redaction';
import {
    buildFullSuiteDurationHistoryComparison,
    buildFullSuiteValidationOutputTelemetry,
    buildFullSuiteTimeoutForecast,
    buildFullSuiteTimeoutRepairTaskProposal,
    buildDocsOnlyNotRequiredResult,
    buildSkippedResult,
    buildValidationResult,
    buildZeroDiffNoReviewableNotRequiredResult,
    formatFullSuiteValidationResult,
    isFullSuiteNotRequiredForDocsOnlyScope,
    isFullSuiteNotRequiredForZeroDiffNoReviewableScope,
    loadFullSuiteValidationConfig,
    persistFullSuiteFailureEvidence,
    recordFullSuiteValidationDuration,
    resolveFullSuiteTimeoutBlockerEvidence,
    type FullSuiteValidationResult,
    type FullSuiteTimeoutAttemptEvidence
} from '../../../../gates/full-suite/full-suite-validation';
import {
    buildRawOutputRetentionEvidence,
    serializeCapturedOutputLines
} from '../../../../gate-runtime/output-log-retention';
import {
    getCurrentWorkflowConfigChanges,
    getWorkflowConfigWorkViolations
} from '../../../../gates/workflow-config/workflow-config-work';
import { executeCommandAsync } from '../../../gate-cli/gates-subprocess';
import { EXIT_GATE_FAILURE, EXIT_GENERAL_FAILURE } from '../../../exit-codes';
import {
    type FullSuiteValidationCommandOptions,
    type FullSuiteValidationCommandResult
} from './full-suite-validation-flow-types';
import {
    tryReadRebindableFullSuiteValidationArtifact
} from './full-suite-validation-cycle-binding';
import { writeArtifactThenEmitMandatoryFullSuiteEvent } from './full-suite-validation-lifecycle';
import {
    normalizeSuccessfulFullSuiteOutputRetention,
    shouldOmitSuccessfulFullSuiteOutput
} from './full-suite-validation-output-retention';
import {
    cleanupGeneratedLocksAfterTimedOutFullSuite,
    formatGeneratedLockCleanupObservation
} from './full-suite-validation-lock-cleanup';
import { validateFullSuiteCommandContract } from './full-suite-command-contract';
import { buildWorkflowConfigWorkBlockedResult } from './full-suite-validation-workflow-config';
import {
    clearFullSuiteValidationRunMarker,
    updateFullSuiteValidationRunMarkerChildProcess,
    writeFullSuiteValidationRunMarker
} from '../../../../gates/full-suite/full-suite-validation-run-marker';
import {
    runFullSuiteValidationPreflightPipeline
} from './full-suite-validation-preflight-pipeline';

export { shouldOmitSuccessfulFullSuiteOutput } from './full-suite-validation-output-retention';
export type {
    FullSuiteValidationCommandOptions,
    FullSuiteValidationCommandResult
} from './full-suite-validation-flow-types';

const BUILD_SCRIPTS_PROCESS_TIMEOUT_MS_ENV = 'GARDA_BUILD_SCRIPTS_PROCESS_TIMEOUT_MS';
const NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS_ENV = 'GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS';

function readPositiveIntegerEnv(name: string): number | null {
    const rawValue = String(process.env[name] || '').trim();
    if (!rawValue) {
        return null;
    }
    const parsedValue = Number(rawValue);
    return Number.isSafeInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
}

function resolvePropagatedMinimumTimeoutEnvValue(name: string, timeoutMs: number): string {
    const inheritedTimeoutMs = readPositiveIntegerEnv(name);
    return String(Math.max(timeoutMs, inheritedTimeoutMs || 0));
}

function buildFullSuiteValidationCommandEnv(timeoutMs: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        GARDA_NODE_FOUNDATION_REUSE_PUBLISH_RUNTIME: '1',
        GARDA_NODE_FOUNDATION_TEST_PREBUILT: '1',
        [BUILD_SCRIPTS_PROCESS_TIMEOUT_MS_ENV]: resolvePropagatedMinimumTimeoutEnvValue(
            BUILD_SCRIPTS_PROCESS_TIMEOUT_MS_ENV,
            timeoutMs
        )
    };
    const inheritedShardTimeoutMs = readPositiveIntegerEnv(NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS_ENV);
    if (inheritedShardTimeoutMs !== null) {
        env[NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS_ENV] = String(inheritedShardTimeoutMs);
    }
    return env;
}

function resolveEffectiveFullSuiteValidationConfig(
    repoRoot: string,
    config: ReturnType<typeof loadFullSuiteValidationConfig>
): ReturnType<typeof loadFullSuiteValidationConfig> {
    const timeoutForecast = buildFullSuiteTimeoutForecast(repoRoot, config);
    const effectiveTimeoutMs = Math.max(config.timeout_ms, timeoutForecast.recommended_timeout_seconds * 1000);
    return effectiveTimeoutMs === config.timeout_ms
        ? config
        : { ...config, timeout_ms: effectiveTimeoutMs };
}

function buildCompileReadinessBlockedResult(
    config: ReturnType<typeof loadFullSuiteValidationConfig>,
    cycleBinding: FullSuiteValidationResult['cycle_binding'],
    violations: readonly string[]
): FullSuiteValidationResult {
    return {
        status: 'FAILED',
        enabled: true,
        command: config.command,
        placement: config.placement,
        exit_code: null,
        timed_out: false,
        output_artifact_path: null,
        compact_summary: ['Full-suite validation requires current compile evidence.'],
        failure_chunks: [],
        out_of_scope_failure_policy: config.out_of_scope_failure_policy,
        out_of_scope_failure_detected: false,
        out_of_scope_audit_verdict: 'NOT_APPLICABLE',
        violations: [...violations],
        warnings: [],
        cycle_binding: cycleBinding
    };
}

export async function runFullSuiteValidationCommand(
    options: FullSuiteValidationCommandOptions
): Promise<FullSuiteValidationCommandResult> {
    const {
        repoRoot,
        taskId,
        preflight,
        cycleBinding,
        taskModeEvidence,
        timelineReadiness
    } = runFullSuiteValidationPreflightPipeline(options);

    const config = loadFullSuiteValidationConfig(repoRoot);
    const reviewsRoot = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const eventsRoot = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
    const outputArtifactPath = path.join(reviewsRoot, `${taskId}-full-suite-output.log`);
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    let workflowConfigBaseline = taskModeEvidence.workflow_config_file_hashes;
    const workflowConfigChanges = getCurrentWorkflowConfigChanges(repoRoot, workflowConfigBaseline, {
        allowProtectedManifestFallback: false
    });
    workflowConfigBaseline = workflowConfigChanges.baseline_file_hashes;
    const workflowConfigViolations = getWorkflowConfigWorkViolations({
        repoRoot,
        changedFiles: workflowConfigChanges.changed_files,
        taskModeEvidence,
        phaseLabel: 'full-suite validation',
        baselineFileHashes: workflowConfigChanges.baseline_file_hashes,
        currentFileHashes: workflowConfigChanges.current_file_hashes
    });
    if (workflowConfigViolations.length > 0) {
        const blockedResult = buildWorkflowConfigWorkBlockedResult(
            config,
            cycleBinding,
            workflowConfigViolations,
            workflowConfigChanges.scan_error
        );
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, blockedResult.status, blockedResult, {
            status: blockedResult.status,
            enabled: blockedResult.enabled,
            command: blockedResult.command,
            placement: blockedResult.placement,
            exit_code: blockedResult.exit_code,
            timed_out: blockedResult.timed_out,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: blockedResult.cycle_binding,
            violations: blockedResult.violations,
            warnings: blockedResult.warnings
        });
        return {
            outputText: `${formatFullSuiteValidationResult(blockedResult)}\n`,
            exitCode: EXIT_GATE_FAILURE
        };
    }

    if (!config.enabled) {
        const skippedResult = buildSkippedResult(config, cycleBinding);
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, skippedResult.status, skippedResult, {
            status: skippedResult.status,
            enabled: skippedResult.enabled,
            command: skippedResult.command,
            placement: skippedResult.placement,
            required: skippedResult.required,
            skip_reason: skippedResult.skip_reason,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: skippedResult.cycle_binding
        });
        return {
            outputText: `${formatFullSuiteValidationResult(skippedResult)}\n`,
            exitCode: 0
        };
    }

    if (isFullSuiteNotRequiredForDocsOnlyScope(preflight)) {
        const skippedResult = buildDocsOnlyNotRequiredResult(config, cycleBinding);
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, skippedResult.status, skippedResult, {
            status: skippedResult.status,
            enabled: skippedResult.enabled,
            command: skippedResult.command,
            placement: skippedResult.placement,
            required: skippedResult.required,
            skip_reason: skippedResult.skip_reason,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: skippedResult.cycle_binding
        });
        return {
            outputText: `${formatFullSuiteValidationResult(skippedResult)}\n`,
            exitCode: 0
        };
    }

    if (isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflight)) {
        const skippedResult = buildZeroDiffNoReviewableNotRequiredResult(config, cycleBinding);
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, skippedResult.status, skippedResult, {
            status: skippedResult.status,
            enabled: skippedResult.enabled,
            command: skippedResult.command,
            placement: skippedResult.placement,
            required: skippedResult.required,
            skip_reason: skippedResult.skip_reason,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: skippedResult.cycle_binding
        });
        return {
            outputText: `${formatFullSuiteValidationResult(skippedResult)}\n`,
            exitCode: 0
        };
    }

    const commandIsUnconfigured = String(config.command || '').trim() === UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND;
    const commandContract = commandIsUnconfigured
        ? null
        : validateFullSuiteCommandContract(config.command);
    const reboundResult = commandContract?.supported === true
        && timelineReadiness.compileEvidenceCurrent
        ? tryReadRebindableFullSuiteValidationArtifact({
            artifactPath,
            repoRoot,
            taskId,
            configCommand: config.command,
            configPlacement: config.placement,
            cycleBinding
        })
        : null;
    if (reboundResult && commandContract) {
        const retainedReboundResult = normalizeSuccessfulFullSuiteOutputRetention(repoRoot, outputArtifactPath, reboundResult);
        retainedReboundResult.command_provenance = commandContract.provenance;
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, retainedReboundResult.status, retainedReboundResult, {
            status: retainedReboundResult.status,
            enabled: retainedReboundResult.enabled,
            command: retainedReboundResult.command,
            placement: retainedReboundResult.placement,
            exit_code: retainedReboundResult.exit_code,
            timed_out: retainedReboundResult.timed_out,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: retainedReboundResult.cycle_binding,
            out_of_scope_audit_verdict: retainedReboundResult.out_of_scope_audit_verdict,
            violations: retainedReboundResult.violations,
            warnings: retainedReboundResult.warnings,
            output_retention: retainedReboundResult.output_retention,
            reused_existing_evidence: true
        });
        return {
            outputText:
                `${formatFullSuiteValidationResult(retainedReboundResult)}\n`
                + 'Rebound existing full-suite evidence to the current compile/preflight cycle without rerunning the configured command.\n',
            exitCode: 0
        };
    }

    if (commandIsUnconfigured) {
        const unconfiguredResult = {
            status: 'FAILED' as const,
            enabled: true,
            command: config.command,
            placement: config.placement,
            exit_code: null,
            timed_out: false,
            output_artifact_path: null,
            compact_summary: ['Full-suite validation command is not configured.'],
            failure_chunks: [],
            out_of_scope_failure_policy: config.out_of_scope_failure_policy,
            out_of_scope_failure_detected: false,
            out_of_scope_audit_verdict: 'NOT_APPLICABLE' as const,
            violations: [
                'Full-suite validation command is not configured. Run agent-init to seed a project-appropriate default or set workflow-config.full_suite_validation.command explicitly.'
            ],
            warnings: [],
            cycle_binding: cycleBinding
        };
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, unconfiguredResult.status, unconfiguredResult, {
            status: unconfiguredResult.status,
            enabled: unconfiguredResult.enabled,
            command: unconfiguredResult.command,
            placement: unconfiguredResult.placement,
            exit_code: unconfiguredResult.exit_code,
            timed_out: unconfiguredResult.timed_out,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: unconfiguredResult.cycle_binding,
            out_of_scope_audit_verdict: unconfiguredResult.out_of_scope_audit_verdict,
            violations: unconfiguredResult.violations,
            warnings: unconfiguredResult.warnings
        });
        return {
            outputText: `${formatFullSuiteValidationResult(unconfiguredResult)}\n`,
            exitCode: EXIT_GATE_FAILURE
        };
    }

    if (!commandContract) {
        throw new Error('Full-suite command contract was not evaluated.');
    }
    if (!commandContract.supported) {
        const invalidCommandResult = {
            status: 'FAILED' as const,
            enabled: true,
            command: config.command,
            placement: config.placement,
            exit_code: null,
            timed_out: false,
            output_artifact_path: null,
            compact_summary: ['Full-suite validation command violates the direct argv execution contract.'],
            failure_chunks: [],
            out_of_scope_failure_policy: config.out_of_scope_failure_policy,
            out_of_scope_failure_detected: false,
            out_of_scope_audit_verdict: 'NOT_APPLICABLE' as const,
            violations: commandContract.violation ? [commandContract.violation] : [],
            warnings: [],
            command_provenance: commandContract.provenance,
            cycle_binding: cycleBinding
        };
        await writeArtifactThenEmitMandatoryFullSuiteEvent(
            repoRoot,
            eventsRoot,
            taskId,
            artifactPath,
            invalidCommandResult.status,
            invalidCommandResult,
            {
                status: invalidCommandResult.status,
                enabled: invalidCommandResult.enabled,
                command: invalidCommandResult.command,
                placement: invalidCommandResult.placement,
                exit_code: invalidCommandResult.exit_code,
                timed_out: invalidCommandResult.timed_out,
                preflight_path: cycleBinding.preflight_path,
                artifact_path: gateHelpers.normalizePath(artifactPath),
                cycle_binding: invalidCommandResult.cycle_binding,
                violations: invalidCommandResult.violations,
                warnings: invalidCommandResult.warnings
            }
        );
        return {
            outputText: `${formatFullSuiteValidationResult(invalidCommandResult)}\n`,
            exitCode: EXIT_GATE_FAILURE
        };
    }

    if (!timelineReadiness.compileEvidenceCurrent) {
        const readinessBlockedResult = buildCompileReadinessBlockedResult(
            config,
            cycleBinding,
            timelineReadiness.violations
        );
        await writeArtifactThenEmitMandatoryFullSuiteEvent(
            repoRoot,
            eventsRoot,
            taskId,
            artifactPath,
            readinessBlockedResult.status,
            readinessBlockedResult,
            {
                status: readinessBlockedResult.status,
                enabled: readinessBlockedResult.enabled,
                command: readinessBlockedResult.command,
                placement: readinessBlockedResult.placement,
                exit_code: readinessBlockedResult.exit_code,
                timed_out: readinessBlockedResult.timed_out,
                preflight_path: cycleBinding.preflight_path,
                artifact_path: gateHelpers.normalizePath(artifactPath),
                cycle_binding: readinessBlockedResult.cycle_binding,
                violations: readinessBlockedResult.violations,
                warnings: readinessBlockedResult.warnings
            }
        );
        return {
            outputText: `${formatFullSuiteValidationResult(readinessBlockedResult)}\n`,
            exitCode: EXIT_GATE_FAILURE
        };
    }

    let commandExitCode = EXIT_GENERAL_FAILURE;
    let timedOut = false;
    let cancelled = false;
    let outputLines: string[] = [];
    const executionConfig = resolveEffectiveFullSuiteValidationConfig(repoRoot, config);
    const startedAtMs = Date.now();
    const timeoutRetryCount = Number.isSafeInteger(executionConfig.timeout_retry_count)
        && (executionConfig.timeout_retry_count ?? 0) >= 0
        ? executionConfig.timeout_retry_count ?? 0
        : 1;
    const maxAttempts = Math.max(1, 1 + timeoutRetryCount);
    const timeoutCleanupObservations: string[] = [];
    const timeoutAttempts: FullSuiteTimeoutAttemptEvidence[] = [];
    try {
        writeFullSuiteValidationRunMarker({
            repoRoot,
            taskId,
            command: config.command,
            cwd: repoRoot,
            timeoutMs: executionConfig.timeout_ms,
            cycleBinding
        });
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                const execution = await executeCommandAsync(config.command, {
                    cwd: repoRoot,
                    env: {
                        ...buildFullSuiteValidationCommandEnv(executionConfig.timeout_ms),
                        [VALIDATION_REPO_ROOT_ENV]: path.resolve(repoRoot),
                        [VALIDATION_TASK_ID_ENV]: taskId
                    },
                    timeoutMs: executionConfig.timeout_ms,
                    onSpawn: (child) => updateFullSuiteValidationRunMarkerChildProcess(repoRoot, taskId, child)
                });
                commandExitCode = execution.exitCode;
                timedOut = execution.timedOut;
                cancelled = execution.cancelled;
                const attemptLines = maxAttempts > 1 && (attempt > 1 || execution.timedOut)
                    ? [`FULL_SUITE_ATTEMPT ${attempt}/${maxAttempts}`]
                    : [];
                outputLines = [
                    ...outputLines,
                    ...attemptLines,
                    ...execution.outputLines
                ];
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                commandExitCode = EXIT_GENERAL_FAILURE;
                timedOut = false;
                cancelled = false;
                const attemptLines = maxAttempts > 1 && attempt > 1
                    ? [`FULL_SUITE_ATTEMPT ${attempt}/${maxAttempts}`]
                    : [];
                outputLines = [
                    ...outputLines,
                    ...attemptLines,
                    message
                ];
            }
            timeoutAttempts.push({
                attempt,
                exit_code: commandExitCode,
                timed_out: timedOut,
                cancelled
            });

            if (timedOut) {
                const generatedLockCleanup = cleanupGeneratedLocksAfterTimedOutFullSuite(repoRoot);
                if (generatedLockCleanup.length > 0) {
                    const cleanupObservations = generatedLockCleanup.map(formatGeneratedLockCleanupObservation);
                    timeoutCleanupObservations.push(...cleanupObservations);
                    outputLines = [
                        ...outputLines,
                        ...cleanupObservations
                    ];
                }
            }

            if (!timedOut || attempt >= maxAttempts) {
                break;
            }

            outputLines.push(
                `FULL_SUITE_TIMEOUT_RETRY attempt=${attempt} next_attempt=${attempt + 1} max_attempts=${maxAttempts} timeout_ms=${executionConfig.timeout_ms}`
            );
        }
        const durationMs = Math.max(1, Date.now() - startedAtMs);
        const retryContaminated = timeoutAttempts.some((attempt) => attempt.timed_out || attempt.cancelled === true);
        outputLines = outputLines.map((line) => redactSecretText(line));
        const rawOutputText = serializeCapturedOutputLines(outputLines);
        const result = buildValidationResult(
            executionConfig,
            commandExitCode,
            timedOut,
            outputLines,
            outputArtifactPath,
            changedFiles,
            cycleBinding
        );
        result.command_provenance = commandContract.provenance;
        const timeoutAttemptsExhausted = timedOut && timeoutAttempts.length >= maxAttempts;
        const timeoutBlockerEvidence = timeoutAttemptsExhausted && executionConfig.timeout_blocker !== false
            ? resolveFullSuiteTimeoutBlockerEvidence({
                repoRoot,
                taskId,
                cycleBinding
            })
            : null;
        result.timeout_policy = {
            timeout_blocker: executionConfig.timeout_blocker !== false,
            timeout_retry_count: timeoutRetryCount,
            max_attempts: maxAttempts,
            attempts: timeoutAttempts,
            attempts_exhausted: timeoutAttemptsExhausted,
            warning_only_continuation: timedOut && executionConfig.timeout_blocker === false,
            repair_task_proposal: timeoutAttemptsExhausted && executionConfig.timeout_blocker !== false
                ? buildFullSuiteTimeoutRepairTaskProposal(taskId)
                : null,
            blocker_identity: timeoutBlockerEvidence?.blocker_identity || null,
            repeated_blocker_analysis: timeoutBlockerEvidence?.repeated_blocker_analysis || null
        };
        if (result.timeout_policy.repair_task_proposal) {
            result.violations.push(
                'Full-suite timeout blocker exhausted the configured retry policy; materialize the proposed repair follow-up before reviewer launch.'
            );
        }
        if (result.timeout_policy.repeated_blocker_analysis) {
            result.violations.push(
                'Repeated full-suite blocker fingerprint matches a repair ancestor; do not create another automatic nested repair child. '
                + 'Record a true multi-child decomposition or an explicit recovery decision.'
            );
        }
        fs.writeFileSync(outputArtifactPath, rawOutputText, 'utf8');
        result.output_retention = buildRawOutputRetentionEvidence(rawOutputText, true);
        result.failure_evidence = persistFullSuiteFailureEvidence({
            repoRoot,
            reviewsRoot,
            taskId,
            result,
            outputLines
        });
        if (timeoutCleanupObservations.length > 0) {
            result.warnings.push(...timeoutCleanupObservations);
        }
        result.duration_ms = durationMs;
        result.output_telemetry = buildFullSuiteValidationOutputTelemetry(outputLines, result);
        const postWorkflowConfigChanges = getCurrentWorkflowConfigChanges(repoRoot, workflowConfigBaseline, {
            allowProtectedManifestFallback: false
        });
        const postWorkflowConfigViolations = getWorkflowConfigWorkViolations({
            repoRoot,
            changedFiles: postWorkflowConfigChanges.changed_files,
            taskModeEvidence,
            phaseLabel: 'full-suite validation output validation',
            baselineFileHashes: postWorkflowConfigChanges.baseline_file_hashes,
            currentFileHashes: postWorkflowConfigChanges.current_file_hashes
        });
        if (postWorkflowConfigViolations.length > 0) {
            const blockedResult = buildWorkflowConfigWorkBlockedResult(
                config,
                cycleBinding,
                postWorkflowConfigViolations,
                postWorkflowConfigChanges.scan_error
            );
            blockedResult.command_provenance = commandContract.provenance;
            blockedResult.output_artifact_path = gateHelpers.normalizePath(outputArtifactPath);
            blockedResult.output_retention = buildRawOutputRetentionEvidence(rawOutputText, true);
            blockedResult.duration_ms = durationMs;
            blockedResult.duration_history_comparison = buildFullSuiteDurationHistoryComparison(repoRoot, config, durationMs);
            blockedResult.failure_evidence = persistFullSuiteFailureEvidence({
                repoRoot,
                reviewsRoot,
                taskId,
                result: blockedResult,
                outputLines
            });
            if (blockedResult.status !== 'SKIPPED') {
                recordFullSuiteValidationDuration(repoRoot, config, {
                    timestamp_utc: new Date().toISOString(),
                    task_id: taskId,
                    status: blockedResult.status,
                    duration_ms: durationMs,
                    timed_out: timedOut,
                    cancelled,
                    retry_contaminated: retryContaminated,
                    exit_code: commandExitCode
                });
            }
            blockedResult.timeout_forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
            blockedResult.output_telemetry = buildFullSuiteValidationOutputTelemetry(outputLines, blockedResult);
            await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, blockedResult.status, blockedResult, {
                status: blockedResult.status,
                enabled: blockedResult.enabled,
                command: blockedResult.command,
                placement: blockedResult.placement,
                exit_code: blockedResult.exit_code,
                timed_out: blockedResult.timed_out,
                preflight_path: cycleBinding.preflight_path,
                artifact_path: gateHelpers.normalizePath(artifactPath),
                output_artifact_path: gateHelpers.normalizePath(outputArtifactPath),
                duration_ms: blockedResult.duration_ms,
                duration_history_comparison: blockedResult.duration_history_comparison,
                timeout_forecast: blockedResult.timeout_forecast,
                cycle_binding: blockedResult.cycle_binding,
                violations: blockedResult.violations,
                warnings: blockedResult.warnings,
                output_telemetry: blockedResult.output_telemetry,
                output_retention: blockedResult.output_retention,
                timeout_policy: blockedResult.timeout_policy,
                failure_evidence: blockedResult.failure_evidence
            });
            return {
                outputText: `${formatFullSuiteValidationResult(blockedResult)}\n`,
                exitCode: EXIT_GATE_FAILURE
            };
        }
        if (result.status !== 'SKIPPED') {
            result.duration_history_comparison = buildFullSuiteDurationHistoryComparison(repoRoot, config, durationMs);
            recordFullSuiteValidationDuration(repoRoot, config, {
                timestamp_utc: new Date().toISOString(),
                task_id: taskId,
                status: result.status,
                duration_ms: durationMs,
                timed_out: timedOut,
                cancelled,
                retry_contaminated: retryContaminated,
                exit_code: commandExitCode
            });
        }
        if (shouldOmitSuccessfulFullSuiteOutput(result)) {
            fs.rmSync(outputArtifactPath, { force: true });
            result.output_artifact_path = null;
            result.output_retention = buildRawOutputRetentionEvidence(rawOutputText, false);
        }
        result.timeout_forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
        result.output_telemetry = buildFullSuiteValidationOutputTelemetry(outputLines, result);
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, result.status, result, {
            status: result.status,
            enabled: result.enabled,
            command: result.command,
            placement: result.placement,
            exit_code: result.exit_code,
            timed_out: result.timed_out,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            output_artifact_path: result.output_artifact_path,
            duration_ms: result.duration_ms,
            duration_history_comparison: result.duration_history_comparison,
            timeout_forecast: result.timeout_forecast,
            cycle_binding: result.cycle_binding,
            out_of_scope_audit_verdict: result.out_of_scope_audit_verdict,
            violations: result.violations,
            warnings: result.warnings,
            output_telemetry: result.output_telemetry,
            output_retention: result.output_retention,
            timeout_policy: result.timeout_policy,
            failure_evidence: result.failure_evidence
        });

        return {
            outputText: `${formatFullSuiteValidationResult(result)}\n`,
            exitCode: result.status === 'FAILED' ? EXIT_GATE_FAILURE : 0
        };
    } finally {
        clearFullSuiteValidationRunMarker(repoRoot, taskId);
    }
}
