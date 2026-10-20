import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspectValidationCommand, type ValidationCommandDescriptor } from '../../../../core/validation-command-contract';
import { validationDigest } from '../../../../core/project-validation-identity';
import { prepareValidationReportCapture, completeValidationReportCapture } from '../../../../core/validation-report-capture';
import { parseValidationReportArguments, type ValidationReportEvidenceBinding } from '../../../../core/validation-report-contract';
import { validationPathKey } from '../../../../core/validation-relative-path';
import { appendMandatoryTaskEventAsync, appendTaskEventAsync } from '../../../../gate-runtime/task-events-io';
import { captureIntermediateSelection, completeIntermediateSelection, assertCurrentIntermediateSelection,
    type IntermediateSelectionBinding } from '../../../../core/intermediate-selected-cases';
import type { CommandInvocationExecution } from '../../../gate-cli/gates-subprocess';
import { isPlainRecord } from '../../../../core/records';
import { runGit } from '../../../../core/git-helpers';
import { TASK_QUEUE_FILENAME } from '../../../../core/orchestration-constants';
import { resolveWorkflowConfigPath } from '../../../../core/full-suite-validation-config';
import { authenticateLocalCommitWorkflowAudit, resolveLocalCommitAvailability } from '../../../../core/auth/local-commit-availability';
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
    isFocusedIntermediateCommand
} from '../../../../gates/shared/focused-intermediate-command-grammar';
import { hasTestFirstExpectedRedDeclaration } from '../../../../gates/test-first/test-first-declaration';
import { executeCommandAsync, splitCommandLine } from '../../../gate-cli/gates-subprocess';
import { runRecipeCommand } from './recipe-command-flow';
import { getCurrentIntermediateTestTargets, hasReportedFailedTestCase, isLiteralIntermediateInvocation, observeNativeIntermediateScope } from './intermediate-command-scope';

const ALLOWED_COMMAND_SOURCES = ['node-test', 'targeted-test', 'typecheck', 'validation'] as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FAILURE_TAIL_LINES = 50;
const SOURCE_INPUT_MAX_BYTES = 4 * 1024 * 1024;
const SOURCE_GIT_OPTIONS = { timeoutMs: 5_000, maxBuffer: SOURCE_INPUT_MAX_BYTES };

type IntermediateCommandSource = (typeof ALLOWED_COMMAND_SOURCES)[number];
type IntermediateCommandStatus = 'PASSED' | 'FAILED' | 'EXPECTED_FAILURE' | 'UNEXPECTED_PASS' | 'PENDING_REVIEW';

export interface RunIntermediateCommandOptions {
    taskId?: unknown;
    recipeId?: unknown;
    command?: unknown;
    commandSource?: unknown;
    selectedCases?: unknown;
    reportFiles?: unknown;
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
    command_descriptor: ValidationCommandDescriptor;
    schema_version: 1;
    event_source: 'native-intermediate-command';
    generated_utc: string;
    task_id: string;
    command_source: IntermediateCommandSource;
    command: string;
    status: IntermediateCommandStatus;
    exit_code: number;
    expected_failure?: true;
    test_scope_sha256?: string;
    timed_out?: boolean;
    cancelled?: boolean;
    termination_signal?: NodeJS.Signals;
    output_truncated?: boolean;
    output_sink_error?: string;
    duration_ms: number;
    output_artifact: string;
    output_artifact_sha256: string;
    output_artifact_size_bytes: number;
    output_encoding?: 'base64-streams';
    report_evidence?: ValidationReportEvidenceBinding;
    report_violations?: string[];
    preflight_path?: string;
    preflight_sha256?: string;
    coverage_contract_sha256?: string;
    output_telemetry: ReturnType<typeof buildOutputTelemetry>;
    source_composition: IntermediateSourceComposition;
    local_commit_authentication?: Record<string, string>;
    source_authentication_error?: string;
    scope_content_sha256_before?: string;
    scope_content_sha256_after?: string | null;
    scope_observation_error?: string;
    execution_id?: string;
    selected_case_binding?: IntermediateSelectionBinding;
    invocations?: CommandInvocationExecution[];
}

interface IntermediateCompositionAuthority {
    stamp: string | null;
    error?: string;
}

interface IntermediateSourceSnapshot {
    repo_root: string;
    source_head_sha: string;
    source_tree_sha: string;
    source_status_sha256: string;
    clean_worktree: boolean;
    task_queue_sha256: string | null;
    workflow_config_sha256: string | null;
}

interface IntermediateSourceComposition {
    schema_version: 1;
    status: 'STABLE_CLEAN' | 'CHANGED_OR_DIRTY' | 'UNAVAILABLE';
    before: IntermediateSourceSnapshot | null;
    after: IntermediateSourceSnapshot | null;
    unavailable_reasons: string[];
}

function readCompositionInputHash(repoRoot: string, filePath: string): string | null {
    const binding = bindContainedDestination(repoRoot, filePath);
    if (binding.missingAt) { assertContainedDestination(binding); return null; }
    const descriptor = fs.openSync(filePath,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    try {
        const original = binding.existing[binding.existing.length - 1]!;
        const stat = fs.fstatSync(descriptor, { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(SOURCE_INPUT_MAX_BYTES)
            || stat.dev !== original.dev || stat.ino !== original.ino
            || stat.mode !== original.mode || stat.birthtimeNs !== original.birthtimeNs) {
            throw new Error('Source composition requires an ordinary bounded input with intact path identity.');
        }
        const bytes = Buffer.alloc(Number(stat.size) + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
            if (count === 0) break;
            length += count;
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        assertExistingPathIdentity(binding);
        if (length !== Number(stat.size) || after.size !== stat.size
            || after.ctimeNs !== stat.ctimeNs || after.mtimeNs !== stat.mtimeNs) {
            throw new Error('Source composition input changed during its bounded read.');
        }
        return createHash('sha256').update(bytes.subarray(0, length)).digest('hex');
    } finally { fs.closeSync(descriptor); }
}

function observeIntermediateSource(repoRoot: string): {
    snapshot: IntermediateSourceSnapshot | null; error: string | null;
} {
    try {
        const root = fs.realpathSync.native(repoRoot);
        const git = (args: string[]) => runGit(repoRoot, args, SOURCE_GIT_OPTIONS);
        const top = fs.realpathSync.native(git(['rev-parse', '--show-toplevel']).trim());
        if (top !== root) throw new Error('Source composition Git root differs from the command workspace.');
        const head = git(['rev-parse', '--verify', 'HEAD']).trim();
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) throw new Error('Source commit identity is unavailable.');
        const tree = git(['rev-parse', '--verify', `${head}^{tree}`]).trim();
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tree)) throw new Error('Source tree identity is unavailable.');
        const statusArgs = ['status', '--porcelain=v1', '--untracked-files=all', '-z'];
        const status = git(statusArgs);
        const snapshot = {
            repo_root: root, source_head_sha: head, source_tree_sha: tree,
            source_status_sha256: createHash('sha256').update(status).digest('hex'),
            clean_worktree: status.length === 0,
            task_queue_sha256: readCompositionInputHash(repoRoot, path.join(repoRoot, TASK_QUEUE_FILENAME)),
            workflow_config_sha256: readCompositionInputHash(repoRoot, resolveWorkflowConfigPath(repoRoot))
        };
        if (git(['rev-parse', '--verify', 'HEAD']).trim() !== head || git(statusArgs) !== status) {
            throw new Error('Source composition changed during snapshot observation.');
        }
        return { snapshot, error: null };
    } catch (error: unknown) {
        // Optional observation failure is explicit metadata, never a command-success or acceptance claim.
        const reason = error instanceof Error ? error.message.split('\n')[0].slice(0, 240) : 'Source observation failed.';
        return { snapshot: null, error: reason };
    }
}

function bindIntermediateSourceComposition(
    before: ReturnType<typeof observeIntermediateSource>, after: ReturnType<typeof observeIntermediateSource>
): IntermediateSourceComposition {
    const stable = before.snapshot?.clean_worktree === true && after.snapshot?.clean_worktree === true
        && JSON.stringify(before.snapshot) === JSON.stringify(after.snapshot);
    return {
        schema_version: 1,
        status: !before.snapshot || !after.snapshot ? 'UNAVAILABLE' : stable ? 'STABLE_CLEAN' : 'CHANGED_OR_DIRTY',
        before: before.snapshot, after: after.snapshot,
        unavailable_reasons: [before.error, after.error].filter((reason): reason is string => reason !== null)
    };
}

function compositionAuthenticationError(error: unknown): string {
    return error instanceof Error ? error.message.split('\n')[0].slice(0, 240) : 'Native composition authentication unavailable.';
}

function observeCompositionAuthority(repoRoot: string): IntermediateCompositionAuthority {
    try {
        if (!resolveLocalCommitAvailability(repoRoot).enabled) return { stamp: null };
        const authentication = authenticateLocalCommitWorkflowAudit(repoRoot,
            { event_source: 'native-intermediate-composition-authority', schema_version: 1 }, false).local_commit_authentication;
        return { stamp: authentication ? JSON.stringify(authentication) : null };
    } catch (error: unknown) {
        return { stamp: null, error: compositionAuthenticationError(error) };
    }
}

function authenticateSuccessfulCompositionRecord(
    repoRoot: string, record: IntermediateCommandRecord, actualOutput: string, before: IntermediateCompositionAuthority
): IntermediateCommandRecord {
    if (record.status !== 'PASSED' || record.exit_code !== EXIT_SUCCESS || record.expected_failure === true
        || record.timed_out !== false || record.cancelled !== false
        || record.source_composition.status !== 'STABLE_CLEAN'
        || record.output_artifact_sha256 !== createHash('sha256').update(actualOutput).digest('hex')
        || record.output_artifact_size_bytes !== Buffer.byteLength(actualOutput)) return record;
    if (!before.stamp) return before.error ? { ...record, source_authentication_error: before.error } : record;
    try {
        if (!resolveLocalCommitAvailability(repoRoot).enabled) return record;
        const authenticated = authenticateLocalCommitWorkflowAudit(repoRoot, { ...record }, false);
        const after = observeCompositionAuthority(repoRoot);
        if (after.stamp !== before.stamp) {
            return after.error ? { ...record, source_authentication_error: after.error } : record;
        }
        return authenticated;
    } catch (error: unknown) {
        // Optional proof authentication never changes the actual command outcome.
        return { ...record, source_authentication_error: compositionAuthenticationError(error) };
    }
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
    selectedCases?: unknown;
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
    const admission = inspectValidationCommand(options.command, 'test');
    const selection = admission.descriptor
        ? captureIntermediateSelection(options.repoRoot, admission.descriptor, options.selectedCases) : undefined;
    const focusedTestPaths = getCurrentIntermediateTestTargets(
        options.repoRoot, options.command,
        [...changedFiles], selection
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
    const statusLabel = status === 'PENDING_REVIEW'
        ? 'TEST_FIRST_ASSERTION_SEMANTICS_PENDING'
        : status === 'EXPECTED_FAILURE'
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
        ? (status === 'PENDING_REVIEW' ? 'PENDING' : status === 'EXPECTED_FAILURE' ? 'PASS' : 'FAIL')
        : status;
    await appendTaskEventAsync(
        gateHelpers.joinOrchestratorPath(repoRoot, ''),
        taskId,
        eventType,
        outcome,
        expectedFailure
            ? status === 'PENDING_REVIEW' ? 'Test-first execution retained; the ordinary post-implementation review must verify assertion semantics alongside current GREEN.'
                : `Test-first ${commandSource} expected failure ${status === 'EXPECTED_FAILURE' ? 'recorded' : 'not reproduced'}.`
            : `Intermediate ${commandSource} command ${status.toLowerCase()}.`,
        {
            command_source: commandSource,
            command,
            artifact_path: artifactPath,
            artifact_sha256: artifactSha256,
            output_artifact_path: record.output_artifact,
            output_artifact_sha256: record.output_artifact_sha256,
            output_artifact_size_bytes: record.output_artifact_size_bytes,
            ...(record.report_evidence ? { output_encoding: record.output_encoding,
                report_evidence: record.report_evidence, report_violations: record.report_violations } : {}),
            ...(record.preflight_path ? { preflight_path: record.preflight_path } : {}),
            ...(record.preflight_sha256 ? { preflight_sha256: record.preflight_sha256 } : {}),
            ...(record.coverage_contract_sha256 ? { coverage_contract_sha256: record.coverage_contract_sha256 } : {}),
            ...(record.scope_content_sha256_before ? {
                scope_content_sha256_before: record.scope_content_sha256_before,
                scope_content_sha256_after: record.scope_content_sha256_after
            } : {}),
            output_telemetry: record.output_telemetry,
            exit_code: record.exit_code,
            ...(record.termination_signal ? { termination_signal: record.termination_signal } : {}),
            output_truncated: record.output_truncated === true,
            ...(record.output_sink_error !== undefined ? { output_sink_error: record.output_sink_error } : {}),
            duration_ms: record.duration_ms,
            source_composition_sha256: createHash('sha256').update(JSON.stringify(record.source_composition)).digest('hex'),
            ...(record.selected_case_binding ? { execution_id: record.execution_id,
                selected_case_binding: record.selected_case_binding } : {}),
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
    if (options.recipeId !== undefined) return runRecipeCommand(options);
    const repoRoot = path.resolve(normalizeOptionalString(options.repoRoot) ?? process.cwd());
    const taskId = normalizeRequiredString(options.taskId, '--task-id');
    const command = normalizeRequiredString(options.command, '--command');
    const commandSource = normalizeCommandSource(options.commandSource);
    const reportFiles = parseValidationReportArguments(options.reportFiles);
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
            requestedPreflightSha256,
            selectedCases: options.selectedCases
        })
        : null;
    const preflightSha256 = expectedFailureBinding?.preflightSha256
        ?? requestedPreflightSha256
        ?? (preflightPath ? gateHelpers.fileSha256(preflightPath) ?? undefined : undefined);
    const coverageContractSha256 = normalizeOptionalSha256(options.coverageContractSha256, '--coverage-contract-sha256');

    const nativeScopeBefore = observeNativeIntermediateScope(repoRoot, taskId, preflightPath);
    if (expectFailure && (!nativeScopeBefore.scope_content_sha256
        || nativeScopeBefore.scope_content_sha256 !== expectedFailureBinding!.testScopeSha256)) {
        return { exitCode: EXIT_GATE_FAILURE, outputLines: formatRejectedLines(
            nativeScopeBefore.error || 'Expected-red requires the current authenticated native test scope.', commandSource, command) };
    }
    if (nativeScopeBefore.preflight_sha256 && preflightSha256 !== nativeScopeBefore.preflight_sha256) {
        return { exitCode: EXIT_GATE_FAILURE,
            outputLines: formatRejectedLines('Requested preflight digest differs from the observed native document.',
                commandSource, command) };
    }
    const conventionalInvocation = isAllowedIntermediateCommand(command, commandSource);
    const commandPurpose = commandSource === 'targeted-test' || commandSource === 'node-test' ? 'test'
        : commandSource === 'typecheck' ? 'compile' : 'validation';
    const commandAdmission = inspectValidationCommand(command, commandPurpose);
    if (!commandAdmission.supported || !commandAdmission.descriptor || !conventionalInvocation && (!nativeScopeBefore.scope_content_sha256
        || !isLiteralIntermediateInvocation(command))) {
        const message = 'Command is not eligible for auditable intermediate compaction for the selected source. '
            + (nativeScopeBefore.scope_content_sha256
                ? 'Use one literal project command without shell operators, redirection or environment assignments.'
                : 'Add --preflight-path to run the literal project command against the current preflight, '
                    + 'or use a conventional focused form (for example `mvn -q -Dtest=<Class> test`, '
                    + '`gradle test --tests <Class> --console=plain`, `python -m pytest <file>`, `go test ./<package>`).');
        return {
            exitCode: EXIT_GATE_FAILURE,
            outputLines: formatRejectedLines(message, commandSource, command),
        };
    }

    if ((options.selectedCases !== undefined || reportFiles.length > 0) && !nativeScopeBefore.scope_content_sha256)
        return { exitCode: EXIT_GATE_FAILURE, outputLines: formatRejectedLines(
            'Selected cases and report files require the current authenticated native preflight.', commandSource, command) };
    const selection = nativeScopeBefore.scope_content_sha256
        ? captureIntermediateSelection(repoRoot, commandAdmission.descriptor, options.selectedCases) : null;
    const executionId = selection ? randomUUID() : undefined;
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
        const reportPaths = new Set(reportFiles.map(report => validationPathKey(report.path)));
        const reportStart = prepareValidationReportCapture(repoRoot, reportFiles, {
            evidenceDirectory: gateHelpers.normalizePath(path.relative(repoRoot, artifacts.artifactPath)) + '.reports',
            excludedRoots: [gateHelpers.joinOrchestratorPath(repoRoot, 'runtime/reviews'),
                normalizeOptionalString(options.eventsRoot) ?? gateHelpers.joinOrchestratorPath(repoRoot, 'runtime/task-events')]
                .map(directory => gateHelpers.normalizePath(path.relative(repoRoot, path.resolve(repoRoot, directory)))),
            excludedPaths: [...nativeScopeBefore.changed_files, ...selection?.cases.map(claim => claim.source) ?? [],
                ...selection?.sources.map(source => source.path).filter(file => !reportPaths.has(validationPathKey(file))) ?? [],
                ...[artifacts.artifactPath, artifacts.outputPath].map(file => gateHelpers.normalizePath(path.relative(repoRoot, file)))]
        });
        const reportEvidence: ValidationReportEvidenceBinding | undefined = reportStart ? {
            declarations: reportStart.declarations, start_sha256: validationDigest(reportStart),
            evidence_directory: path.posix.dirname(reportStart.anchor.identity.path)
        } : undefined;
        const authorityBefore = observeCompositionAuthority(repoRoot);
        const sourceBefore = observeIntermediateSource(repoRoot);
        if (selection) await appendMandatoryTaskEventAsync(gateHelpers.joinOrchestratorPath(repoRoot, ''), taskId,
            'INTERMEDIATE_COMMAND_STARTED', 'STARTED', 'Native intermediate command selection captured before execution.', {
                command_source: commandSource, command, execution_id: executionId,
                expected_failure: options.expectFailure === true,
                artifact_path: artifacts.artifactPath, selected_case_selection: selection,
                ...(reportEvidence ? { report_evidence: reportEvidence } : {}),
                preflight_path: preflightPath ? gateHelpers.normalizePath(preflightPath) : undefined,
                preflight_sha256: preflightSha256, scope_content_sha256_before: nativeScopeBefore.scope_content_sha256
            }, { actor: 'gate', eventsRoot: normalizeOptionalString(options.eventsRoot) });
        const startedAt = Date.now();
        const result = await executeCommandAsync(command, {
            cwd: repoRoot,
            timeoutMs,
            signal: options.signal,
            captureInvocations: true
        });
        const durationMs = Date.now() - startedAt;
        const reports = completeValidationReportCapture(repoRoot, reportStart);
        const selectionBinding = selection ? completeIntermediateSelection(repoRoot, selection) : undefined;
        const nativeScopeAfter = nativeScopeBefore.scope_content_sha256
            ? observeNativeIntermediateScope(repoRoot, taskId, preflightPath) : null;
        const sourceComposition = bindIntermediateSourceComposition(sourceBefore, observeIntermediateSource(repoRoot));
        const rawLines = result.outputLines;
        const streamOutput = `${rawLines.join('\n')}\n`;
        const actualOutput = reports ? JSON.stringify({ stdout_base64: Buffer.from(streamOutput).toString('base64'),
            stderr_base64: '', report_capture: reports }) : streamOutput;
        writeReservedIntermediateFile(reserved.output, actualOutput);
        const outputArtifactSha256 = gateHelpers.fileSha256(artifacts.outputPath);
        if (!outputArtifactSha256) {
            throw new Error(`Unable to hash intermediate command output artifact '${artifacts.outputPath}'.`);
        }
        const outputArtifactSizeBytes = fs.statSync(artifacts.outputPath).size;
        let semanticCandidate = false;
        if (expectFailure && selectionBinding?.before.cases.length && result.exitCode > 0
            && !result.timedOut && !result.cancelled && result.invocations?.length === 1
            && !result.terminationSignal && !result.outputTruncated && result.sinkError === undefined
            && result.invocations[0].exitCode === result.exitCode && !result.invocations[0].executionError
            && nativeScopeAfter?.preflight_sha256 === nativeScopeBefore.preflight_sha256
            && nativeScopeAfter?.scope_content_sha256 === nativeScopeBefore.scope_content_sha256
            && selectionBinding.before.cases.every(claim => nativeScopeBefore.changed_files.includes(claim.source))) {
            try {
                assertCurrentIntermediateSelection(repoRoot, selectionBinding, selectionBinding.before.sources
                    .filter(source => !reportPaths.has(validationPathKey(source.path))).map(source => source.path));
                semanticCandidate = true;
            } catch { /* Changed source identities cannot become semantic review candidates. */ }
        }
        const status: IntermediateCommandStatus = reports?.violations.length || result.terminationSignal
            || result.outputTruncated || result.sinkError !== undefined ? 'FAILED' : expectFailure
            ? result.timedOut || result.cancelled
                ? 'FAILED'
                : result.exitCode === EXIT_SUCCESS
                    ? 'UNEXPECTED_PASS'
                    : hasReportedFailedTestCase(streamOutput) ? 'EXPECTED_FAILURE' : semanticCandidate ? 'PENDING_REVIEW' : 'FAILED'
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
        const visibleLines = status === 'PASSED' ? statusLines : [...statusLines, ...reports?.violations ?? [], ...boundedTail(rawLines)];
        const telemetry = buildOutputTelemetry(rawLines, visibleLines, {
            filterMode: 'compact_summary',
            parserName: 'intermediate-command',
            parserStrategy: status === 'PASSED'
                ? 'status_summary'
                : status === 'EXPECTED_FAILURE'
                    ? 'bounded_expected_failure_tail'
                    : 'bounded_failure_tail',
        });
        const record = authenticateSuccessfulCompositionRecord(repoRoot, {
            schema_version: 1,
            event_source: 'native-intermediate-command',
            generated_utc: new Date().toISOString(),
            task_id: taskId,
            command_source: commandSource,
            command,
            command_descriptor: commandAdmission.descriptor,
            status,
            exit_code: result.exitCode,
            timed_out: result.timedOut,
            cancelled: result.cancelled,
            ...(result.terminationSignal ? { termination_signal: result.terminationSignal } : {}),
            output_truncated: result.outputTruncated === true,
            ...(result.sinkError !== undefined ? { output_sink_error: result.sinkError } : {}),
            invocations: result.invocations,
            ...(selectionBinding ? { execution_id: executionId, selected_case_binding: selectionBinding } : {}),
            ...(expectFailure ? {
                expected_failure: true as const,
                test_scope_sha256: expectedFailureBinding!.testScopeSha256,
            } : {}),
            duration_ms: durationMs,
            output_artifact: artifacts.outputPath,
            output_artifact_sha256: outputArtifactSha256,
            output_artifact_size_bytes: outputArtifactSizeBytes,
            ...(reportEvidence ? { output_encoding: 'base64-streams' as const,
                report_evidence: reportEvidence, report_violations: reports!.violations } : {}),
            ...(preflightPath ? { preflight_path: gateHelpers.normalizePath(preflightPath) } : {}),
            ...(preflightSha256 ? { preflight_sha256: preflightSha256 } : {}),
            ...(coverageContractSha256 ? { coverage_contract_sha256: coverageContractSha256 } : {}),
            output_telemetry: telemetry,
            source_composition: sourceComposition,
            ...(nativeScopeBefore.scope_content_sha256 ? {
                scope_content_sha256_before: nativeScopeBefore.scope_content_sha256,
                scope_content_sha256_after: nativeScopeAfter?.preflight_sha256 === nativeScopeBefore.preflight_sha256
                    ? nativeScopeAfter.scope_content_sha256 : null,
                ...(nativeScopeAfter?.error ? { scope_observation_error: nativeScopeAfter.error } : {})
            } : {}),
        }, actualOutput, authorityBefore);
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
            exitCode: reports?.violations.length ? EXIT_GATE_FAILURE : expectFailure
                ? (status === 'EXPECTED_FAILURE' || status === 'PENDING_REVIEW' ? EXIT_SUCCESS : EXIT_GATE_FAILURE)
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
