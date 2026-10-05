import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendTaskEventAsync } from '../../../../gate-runtime/task-events-io';
import { isPlainRecord } from '../../../../core/records';
import {
    assertContainedDestination,
    assertExistingPathIdentity,
    bindContainedDestination,
    ensureContainedDirectory,
    removeBoundContainedPath,
    type ContainedDestination
} from '../../../../core/contained-filesystem';
import { readTaskQueueEntries } from '../../../../core/task-queue-read';
import {
    buildOutputTelemetry,
    formatVisibleSavingsLine,
} from '../../../../gate-runtime/token-telemetry';
import { EXIT_GATE_FAILURE, EXIT_SUCCESS } from '../../../exit-codes';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    getChangedTestPathsTargetedByCommandTokens,
    isFocusedIntermediateCommand
} from '../../../../gates/shared/focused-intermediate-command-grammar';
import { hasTestFirstExpectedRedDeclaration } from '../../../../gates/test-first/test-first-declaration';
import { executeCommandAsync, splitCommandLine } from '../../../gate-cli/gates-subprocess';

const ALLOWED_COMMAND_SOURCES = ['node-test', 'targeted-test', 'typecheck', 'validation'] as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FAILURE_TAIL_LINES = 50;

type IntermediateCommandSource = (typeof ALLOWED_COMMAND_SOURCES)[number];
type IntermediateCommandStatus = 'PASSED' | 'FAILED' | 'EXPECTED_FAILURE' | 'UNEXPECTED_PASS';

export interface RunIntermediateCommandOptions {
    taskId?: unknown;
    command?: unknown;
    commandSource?: unknown;
    artifactPath?: unknown;
    outputPath?: unknown;
    timeoutMs?: unknown;
    preflightPath?: unknown;
    preflightSha256?: unknown;
    coverageContractSha256?: unknown;
    expectFailure?: unknown;
    signal?: AbortSignal;
    repoRoot?: unknown;
    eventsRoot?: unknown;
}

interface IntermediateCommandArtifacts {
    artifactPath: string;
    outputPath: string;
}

interface ReservedIntermediateFile {
    descriptor: number;
    binding: ContainedDestination;
}

interface ReservedIntermediateArtifacts {
    artifact: ReservedIntermediateFile;
    output: ReservedIntermediateFile;
}

interface IntermediateCommandResult {
    exitCode: number;
    outputLines: string[];
}

interface IntermediateCommandRecord {
    schema_version: 1;
    task_id: string;
    command_source: IntermediateCommandSource;
    command: string;
    status: IntermediateCommandStatus;
    exit_code: number;
    expected_failure?: true;
    test_scope_sha256?: string;
    timed_out?: boolean;
    cancelled?: boolean;
    duration_ms: number;
    output_artifact: string;
    output_artifact_sha256: string;
    output_artifact_size_bytes: number;
    preflight_path?: string;
    preflight_sha256?: string;
    coverage_contract_sha256?: string;
    output_telemetry: ReturnType<typeof buildOutputTelemetry>;
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${fieldName} is required.`);
    }
    return value.trim();
}

function normalizeOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeOptionalSha256(value: unknown, fieldName: string): string | undefined {
    const normalized = normalizeOptionalString(value);
    if (!normalized) {
        return undefined;
    }
    const lower = normalized.toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(lower)) {
        throw new Error(`${fieldName} must be a 64-character lowercase or uppercase SHA-256 hex string.`);
    }
    return lower;
}

function normalizeTimeoutMs(value: unknown): number {
    if (typeof value === 'undefined') {
        return DEFAULT_TIMEOUT_MS;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--timeout-ms must be a positive number.');
    }
    return Math.trunc(parsed);
}

function normalizeCommandSource(value: unknown): IntermediateCommandSource {
    const commandSource = normalizeRequiredString(value, '--command-source');
    if (!ALLOWED_COMMAND_SOURCES.includes(commandSource as IntermediateCommandSource)) {
        throw new Error(`--command-source must be one of: ${ALLOWED_COMMAND_SOURCES.join(', ')}.`);
    }
    return commandSource as IntermediateCommandSource;
}

function normalizeBoolean(value: unknown): boolean {
    return value === true || String(value || '').trim().toLowerCase() === 'true';
}

function basenameLower(token: string): string {
    return path.basename(token).toLowerCase();
}

function isBareCommandToken(token: string): boolean {
    return token === path.basename(token) && !token.includes('/') && !token.includes('\\');
}

function isNpmToken(token: string): boolean {
    return isBareCommandToken(token) && ['npm', 'npm.cmd', 'npm.exe'].includes(basenameLower(token));
}

function isAllowedIntermediateCommand(command: string, commandSource: IntermediateCommandSource): boolean {
    const tokens = splitCommandLine(command);
    if (tokens.length === 0) {
        return false;
    }
    if (commandSource === 'node-test' || commandSource === 'targeted-test') {
        return isFocusedIntermediateCommand(commandSource, tokens);
    }
    const [, ...args] = tokens;
    if (commandSource === 'typecheck') {
        return isNpmToken(tokens[0]) && args[0] === 'run' && args[1] === 'typecheck';
    }
    if (commandSource === 'validation') {
        return isNpmToken(tokens[0]) && args[0] === 'run' && /^validate(?::|-|$)/.test(args[1] ?? '');
    }
    return false;
}

interface ExpectedFailurePreflightBinding {
    preflightSha256: string;
    testScopeSha256: string;
}

function readExpectedFailurePreflightBinding(options: {
    repoRoot: string;
    taskId: string;
    command: string;
    commandSource: IntermediateCommandSource;
    preflightPath?: string;
    requestedPreflightSha256?: string;
}): ExpectedFailurePreflightBinding {
    if (options.commandSource !== 'node-test' && options.commandSource !== 'targeted-test') {
        throw new Error('--expect-failure is allowed only for node-test or targeted-test commands.');
    }
    if (!options.preflightPath) {
        throw new Error('--expect-failure requires --preflight-path.');
    }
    const reviewsRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, path.join('runtime', 'reviews'));
    if (!gateHelpers.isPathRealpathInsideRoot(options.preflightPath, reviewsRoot)) {
        throw new Error('--expect-failure preflight must be a regular artifact inside the Garda reviews root.');
    }
    let preflight: Record<string, unknown>;
    try {
        const parsed = JSON.parse(fs.readFileSync(options.preflightPath, 'utf8')) as unknown;
        if (!isPlainRecord(parsed)) {
            throw new Error('not an object');
        }
        preflight = parsed;
    } catch {
        throw new Error('--expect-failure preflight must be a readable JSON object.');
    }
    if (String(preflight.task_id || '').trim() !== options.taskId) {
        throw new Error('--expect-failure preflight task_id must match --task-id.');
    }
    if (String(preflight.scope_category || '').trim().toLowerCase() !== 'test-only') {
        throw new Error('--expect-failure requires a current test-only preflight scope.');
    }
    const taskEntry = readTaskQueueEntries(options.repoRoot).get(options.taskId);
    if (!hasTestFirstExpectedRedDeclaration(taskEntry)) {
        throw new Error('--expect-failure requires the exact TASK.md Notes marker "Test-first: expected-red".');
    }
    const changedFiles = new Set(
        (Array.isArray(preflight.changed_files) ? preflight.changed_files : [])
            .map((entry) => gateHelpers.normalizePath(String(entry || '').trim()).replace(/^\.\/?/u, ''))
            .filter(Boolean)
    );
    const focusedTestPaths = getChangedTestPathsTargetedByCommandTokens(
        splitCommandLine(options.command),
        [...changedFiles]
    );
    if (focusedTestPaths.length === 0) {
        throw new Error('--expect-failure command must name a concrete changed test from the current preflight scope.');
    }
    const actualPreflightSha256 = gateHelpers.fileSha256(options.preflightPath);
    if (!actualPreflightSha256) {
        throw new Error('Unable to hash --expect-failure preflight evidence.');
    }
    if (
        options.requestedPreflightSha256
        && options.requestedPreflightSha256 !== actualPreflightSha256
    ) {
        throw new Error('--preflight-sha256 does not match the current --expect-failure preflight artifact.');
    }
    const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
    const testScopeSha256 = String(metrics.scope_content_sha256 || metrics.scope_sha256 || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(testScopeSha256)) {
        throw new Error('--expect-failure preflight is missing a valid current scope SHA-256 binding.');
    }
    return {
        preflightSha256: actualPreflightSha256,
        testScopeSha256
    };
}

function buildDefaultArtifacts(
    repoRoot: string,
    taskId: string,
    commandSource: IntermediateCommandSource,
    command: string,
): IntermediateCommandArtifacts {
    const commandHash = createHash('sha256').update(command).digest('hex').slice(0, 12);
    const safeSource = commandSource.replace(/[^a-z0-9-]/gi, '-');
    const baseName = `${taskId}-intermediate-command-${safeSource}-${commandHash}`;
    const attemptDirectory = path.join('runtime', 'reviews', 'intermediate-attempts', randomUUID());
    const artifactPath = gateHelpers.joinOrchestratorPath(repoRoot, path.join(attemptDirectory, `${baseName}.json`));
    const outputPath = gateHelpers.joinOrchestratorPath(repoRoot, path.join(attemptDirectory, `${baseName}.log`));
    return { artifactPath, outputPath };
}

function ensureIntermediateDirectory(repoRoot: string, directoryPath: string): void {
    const binding = bindContainedDestination(repoRoot, directoryPath);
    const componentCount = path.relative(binding.root, binding.path).split(path.sep).length;
    for (let remainingRaces = componentCount; ; remainingRaces -= 1) {
        try {
            ensureContainedDirectory(repoRoot, directoryPath);
            break;
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || remainingRaces === 0) throw error;
            assertExistingPathIdentity(binding);
            bindContainedDestination(repoRoot, directoryPath);
        }
    }
    assertExistingPathIdentity(binding);
}

function reserveIntermediateFile(repoRoot: string, filePath: string): ReservedIntermediateFile {
    bindContainedDestination(repoRoot, filePath);
    ensureIntermediateDirectory(repoRoot, path.dirname(filePath));
    const destination = bindContainedDestination(repoRoot, filePath);
    if (!destination.missingAt) {
        throw new Error(`Intermediate evidence destination already exists: ${filePath}`);
    }
    assertContainedDestination(destination);
    const descriptor = fs.openSync(filePath, 'wx');
    try {
        const binding = bindContainedDestination(repoRoot, filePath);
        const identity = binding.existing[binding.existing.length - 1];
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!identity || identity.dev !== opened.dev || identity.ino !== opened.ino
            || identity.birthtimeNs !== opened.birthtimeNs || !opened.isFile() || opened.nlink !== 1n) {
            throw new Error(`Intermediate evidence destination identity changed: ${filePath}`);
        }
        return { descriptor, binding };
    } catch (error: unknown) {
        fs.closeSync(descriptor);
        throw error;
    }
}

function reserveIntermediateArtifacts(
    repoRoot: string, artifacts: IntermediateCommandArtifacts
): ReservedIntermediateArtifacts {
    const pathKey = (filePath: string): string => process.platform === 'win32'
        ? filePath.toLowerCase() : filePath;
    if (pathKey(artifacts.artifactPath) === pathKey(artifacts.outputPath)) {
        throw new Error('Intermediate JSON and raw-log destinations must use distinct paths.');
    }
    const artifact = reserveIntermediateFile(repoRoot, artifacts.artifactPath);
    try {
        const output = reserveIntermediateFile(repoRoot, artifacts.outputPath);
        return { artifact, output };
    } catch (error: unknown) {
        fs.closeSync(artifact.descriptor);
        removeBoundContainedPath(artifact.binding);
        throw error;
    }
}

function writeReservedIntermediateFile(file: ReservedIntermediateFile, content: string): void {
    assertContainedDestination(file.binding);
    fs.writeFileSync(file.descriptor, content, 'utf8');
    assertContainedDestination(file.binding);
}

function resolveArtifacts(
    repoRoot: string,
    taskId: string,
    commandSource: IntermediateCommandSource,
    command: string,
    artifactPathInput: unknown,
    outputPathInput: unknown,
): IntermediateCommandArtifacts {
    const defaults = buildDefaultArtifacts(repoRoot, taskId, commandSource, command);
    const artifactPath = path.resolve(repoRoot, normalizeOptionalString(artifactPathInput) ?? defaults.artifactPath);
    const outputPath = path.resolve(repoRoot, normalizeOptionalString(outputPathInput) ?? defaults.outputPath);
    return { artifactPath, outputPath };
}

function boundedTail(lines: string[]): string[] {
    if (lines.length <= DEFAULT_FAILURE_TAIL_LINES) {
        return lines;
    }
    return lines.slice(lines.length - DEFAULT_FAILURE_TAIL_LINES);
}

function formatStatusLines(
    status: IntermediateCommandStatus,
    commandSource: IntermediateCommandSource,
    command: string,
    exitCode: number,
    durationMs: number,
    artifactPath: string,
    outputPath: string,
): string[] {
    const statusLabel = status === 'EXPECTED_FAILURE'
        ? 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'
        : status === 'UNEXPECTED_PASS'
            ? 'TEST_FIRST_EXPECTED_FAILURE_NOT_REPRODUCED'
            : `INTERMEDIATE_COMMAND_${status}`;
    return [
        statusLabel,
        `CommandSource: ${commandSource}`,
        `Command: ${command}`,
        `ExitCode: ${exitCode}`,
        `DurationMs: ${durationMs}`,
        `ArtifactPath: ${artifactPath}`,
        `OutputArtifact: ${outputPath}`,
    ];
}

function formatRejectedLines(message: string, commandSource: IntermediateCommandSource, command: string): string[] {
    return [
        'INTERMEDIATE_COMMAND_REJECTED',
        `CommandSource: ${commandSource}`,
        `Command: ${command}`,
        `Reason: ${message}`,
    ];
}

function formatTelemetryLine(telemetry: Record<string, unknown>): string {
    return [
        `raw_lines=${telemetry.raw_line_count ?? 0}`,
        `visible_lines=${telemetry.filtered_line_count ?? 0}`,
        `estimated_saved_chars=${telemetry.estimated_saved_chars ?? 0}`,
        `estimated_saved_tokens=${telemetry.estimated_saved_tokens ?? 0}`,
    ].join('; ');
}

async function persistCommandEvent(
    repoRoot: string,
    taskId: string,
    commandSource: IntermediateCommandSource,
    command: string,
    status: IntermediateCommandStatus,
    record: IntermediateCommandRecord,
    artifactPath: string,
    artifactSha256: string,
    eventsRoot?: string,
): Promise<void> {
    const expectedFailure = record.expected_failure === true;
    const eventType = expectedFailure
        ? 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'
        : 'INTERMEDIATE_COMMAND_RUN';
    const outcome = expectedFailure
        ? (status === 'EXPECTED_FAILURE' ? 'PASS' : 'FAIL')
        : status;
    await appendTaskEventAsync(
        gateHelpers.joinOrchestratorPath(repoRoot, ''),
        taskId,
        eventType,
        outcome,
        expectedFailure
            ? `Test-first ${commandSource} expected failure ${status === 'EXPECTED_FAILURE' ? 'recorded' : 'not reproduced'}.`
            : `Intermediate ${commandSource} command ${status.toLowerCase()}.`,
        {
            command_source: commandSource,
            command,
            artifact_path: artifactPath,
            artifact_sha256: artifactSha256,
            output_artifact_path: record.output_artifact,
            output_artifact_sha256: record.output_artifact_sha256,
            output_artifact_size_bytes: record.output_artifact_size_bytes,
            ...(record.preflight_path ? { preflight_path: record.preflight_path } : {}),
            ...(record.preflight_sha256 ? { preflight_sha256: record.preflight_sha256 } : {}),
            ...(record.coverage_contract_sha256 ? { coverage_contract_sha256: record.coverage_contract_sha256 } : {}),
            output_telemetry: record.output_telemetry,
            exit_code: record.exit_code,
            duration_ms: record.duration_ms,
            ...(expectedFailure ? {
                expected_failure: true,
                recorded_status: status,
                test_scope_sha256: record.test_scope_sha256,
                timed_out: record.timed_out === true,
                cancelled: record.cancelled === true
            } : {}),
        },
        {
            actor: 'gate',
            eventsRoot,
        },
    );
}

export async function runIntermediateCommandCommand(
    options: RunIntermediateCommandOptions,
): Promise<IntermediateCommandResult> {
    const repoRoot = path.resolve(normalizeOptionalString(options.repoRoot) ?? process.cwd());
    const taskId = normalizeRequiredString(options.taskId, '--task-id');
    const command = normalizeRequiredString(options.command, '--command');
    const commandSource = normalizeCommandSource(options.commandSource);
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const preflightPathInput = normalizeOptionalString(options.preflightPath);
    const preflightPath = preflightPathInput ? path.resolve(repoRoot, preflightPathInput) : undefined;
    const requestedPreflightSha256 = normalizeOptionalSha256(options.preflightSha256, '--preflight-sha256');
    const expectFailure = normalizeBoolean(options.expectFailure);
    const expectedFailureBinding = expectFailure
        ? readExpectedFailurePreflightBinding({
            repoRoot,
            taskId,
            command,
            commandSource,
            preflightPath,
            requestedPreflightSha256
        })
        : null;
    const preflightSha256 = expectedFailureBinding?.preflightSha256
        ?? requestedPreflightSha256
        ?? (preflightPath ? gateHelpers.fileSha256(preflightPath) ?? undefined : undefined);
    const coverageContractSha256 = normalizeOptionalSha256(options.coverageContractSha256, '--coverage-contract-sha256');

    if (!isAllowedIntermediateCommand(command, commandSource)) {
        const message = 'Command is not eligible for auditable intermediate compaction for the selected source.';
        return {
            exitCode: EXIT_GATE_FAILURE,
            outputLines: formatRejectedLines(message, commandSource, command),
        };
    }

    const artifacts = resolveArtifacts(
        repoRoot,
        taskId,
        commandSource,
        command,
        options.artifactPath,
        options.outputPath,
    );
    const reserved = reserveIntermediateArtifacts(repoRoot, artifacts);
    try {
        const startedAt = Date.now();
        const result = await executeCommandAsync(command, {
            cwd: repoRoot,
            timeoutMs,
            signal: options.signal
        });
        const durationMs = Date.now() - startedAt;
        const rawLines = result.outputLines;
        writeReservedIntermediateFile(reserved.output, `${rawLines.join('\n')}\n`);
        const outputArtifactSha256 = gateHelpers.fileSha256(artifacts.outputPath);
        if (!outputArtifactSha256) {
            throw new Error(`Unable to hash intermediate command output artifact '${artifacts.outputPath}'.`);
        }
        const outputArtifactSizeBytes = fs.statSync(artifacts.outputPath).size;

        const status: IntermediateCommandStatus = expectFailure
            ? result.timedOut || result.cancelled
                ? 'FAILED'
                : result.exitCode === EXIT_SUCCESS
                    ? 'UNEXPECTED_PASS'
                    : 'EXPECTED_FAILURE'
            : result.exitCode === EXIT_SUCCESS
                ? 'PASSED'
                : 'FAILED';
        const statusLines = formatStatusLines(
            status,
            commandSource,
            command,
            result.exitCode,
            durationMs,
            artifacts.artifactPath,
            artifacts.outputPath,
        );
        const visibleLines = status === 'PASSED' ? statusLines : [...statusLines, ...boundedTail(rawLines)];
        const telemetry = buildOutputTelemetry(rawLines, visibleLines, {
            filterMode: 'compact_summary',
            parserName: 'intermediate-command',
            parserStrategy: status === 'PASSED'
                ? 'status_summary'
                : status === 'EXPECTED_FAILURE'
                    ? 'bounded_expected_failure_tail'
                    : 'bounded_failure_tail',
        });
        const record: IntermediateCommandRecord = {
            schema_version: 1,
            task_id: taskId,
            command_source: commandSource,
            command,
            status,
            exit_code: result.exitCode,
            ...(expectFailure ? {
                expected_failure: true as const,
                test_scope_sha256: expectedFailureBinding!.testScopeSha256,
                timed_out: result.timedOut,
                cancelled: result.cancelled
            } : {}),
            duration_ms: durationMs,
            output_artifact: artifacts.outputPath,
            output_artifact_sha256: outputArtifactSha256,
            output_artifact_size_bytes: outputArtifactSizeBytes,
            ...(preflightPath ? { preflight_path: gateHelpers.normalizePath(preflightPath) } : {}),
            ...(preflightSha256 ? { preflight_sha256: preflightSha256 } : {}),
            ...(coverageContractSha256 ? { coverage_contract_sha256: coverageContractSha256 } : {}),
            output_telemetry: telemetry,
        };
        writeReservedIntermediateFile(reserved.artifact, `${JSON.stringify(record, null, 2)}\n`);
        const artifactSha256 = gateHelpers.fileSha256(artifacts.artifactPath);
        if (!artifactSha256) {
            throw new Error(`Unable to hash intermediate command artifact '${artifacts.artifactPath}'.`);
        }
        await persistCommandEvent(
            repoRoot,
            taskId,
            commandSource,
            command,
            status,
            record,
            artifacts.artifactPath,
            artifactSha256,
            normalizeOptionalString(options.eventsRoot),
        );

        const savingsLine = formatVisibleSavingsLine(telemetry, {
            label: 'intermediate-command',
            minimumSavedChars: 0,
            minimumSavedTokens: 0,
        });
        const outputLines = [...visibleLines, `OutputTelemetry: ${formatTelemetryLine(telemetry)}`];
        return {
            exitCode: expectFailure
                ? (status === 'EXPECTED_FAILURE' ? EXIT_SUCCESS : EXIT_GATE_FAILURE)
                : result.exitCode,
            outputLines: savingsLine ? [...outputLines, savingsLine] : outputLines,
        };
    } finally {
        try {
            fs.closeSync(reserved.output.descriptor);
        } finally {
            fs.closeSync(reserved.artifact.descriptor);
        }
    }
}
