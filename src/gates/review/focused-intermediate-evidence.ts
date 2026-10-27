import { verifiedIndexForEvents, selectVerifiedEvents } from '../../gate-runtime/timeline/task-verified-event-index';
import { countNextStepWork } from '../../core/next-step-measurement';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { splitCommandLine } from '../../cli/gate-cli/gates-subprocess';
import { isPlainRecord } from '../../core/records';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { MAX_RETAINED_VALIDATION_OUTPUT_BYTES, parseValidationReportEvidenceBinding, readRetainedValidationReports } from '../../core/validation-report-evidence';
import type { ValidationReportEvidenceBinding } from '../../core/validation-report-contract';
import { assertCurrentIntermediateSelection, intermediateInvocationIdentity, intermediateSourcePathKey, latestMatchingIntermediateAttempt,
    type IntermediateSelectionBinding } from '../../core/intermediate-selected-cases';
import { declaredFileRole, isTestScopePath, normalizeFileRoleBindings } from '../../core/file-role-bindings';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import {
    readNavigationOrderedTaskEvents,
    type TaskAuditEvent
} from '../task-audit/task-audit-summary-lifecycle';
import {
    isPathRealpathInsideRoot,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import { getChangedTestPathsTargetedByCommandTokens, isFocusedIntermediateCommand } from '../shared/focused-intermediate-command-grammar';
import { declaredValidationTestPaths, readFocusedRecipeEntry } from '../project-validation/focused';
import { readImmutableValidationEventSnapshot, type ValidationEvidenceInspection } from '../project-validation/attempt-evidence';
import { validationPaths } from '../project-validation/authority';

const INTERMEDIATE_COMMAND_SOURCES = new Set(['node-test', 'targeted-test', 'typecheck', 'validation']);
const DEFAULT_MAX_ENTRIES = 8;
const MAX_WARNINGS = 16;
const MAX_NATIVE_PREFLIGHT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TIMELINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TIMELINE_EVENTS = 1024;
const DEFAULT_MAX_INTERMEDIATE_CANDIDATES_SCANNED = 128;

export interface FocusedIntermediateEvidenceEntry {
    command_source: string;
    command: string;
    recipe_context?: { cwd: string; environment: Record<string, string> };
    status: 'PASSED';
    exit_code: 0;
    preflight_path: string | null;
    preflight_sha256: string | null;
    coverage_contract_sha256: string | null;
    event_timestamp_utc: string;
    event_task_sequence: number;
    artifact_path: string;
    artifact_sha256: string;
    output_artifact_path: string;
    output_artifact_sha256: string;
    output_artifact_size_bytes: number;
    output_encoding?: 'base64-streams';
    report_evidence?: ValidationReportEvidenceBinding;
    focused_test_paths: string[];
    scope_content_sha256?: string;
    execution_id?: string;
    selected_case_binding?: IntermediateSelectionBinding;
    semantic_status?: 'PENDING_INDEPENDENT_REVIEW';
}

export interface FocusedIntermediateEvidenceSelection {
    entries: FocusedIntermediateEvidenceEntry[];
    warnings: string[];
    latest_task_mode_sequence: number | null;
    candidate_count: number;
    rejected_candidate_count: number;
    truncated: boolean;
}

export type ExpectedFailureIntermediateEvidenceEntry = Omit<FocusedIntermediateEvidenceEntry, 'status' | 'exit_code'> & {
    status: 'PENDING_REVIEW' | 'EXPECTED_FAILURE'; exit_code: number; expected_failure: true;
};

interface BoundIntermediateCommandEvidence<T = FocusedIntermediateEvidenceEntry> {
    entry: T | null;
    violation: string | null;
}

export function isPassedIntermediateCommandEvent(event: TaskAuditEvent): boolean {
    const details = isPlainRecord(event.details) ? event.details : {};
    const commandSource = String(details.command_source || '').trim();
    if (!INTERMEDIATE_COMMAND_SOURCES.has(commandSource)) {
        return false;
    }
    const outcome = String(event.outcome || '').trim().toUpperCase();
    const exitCode = details.exit_code;
    return typeof exitCode === 'number'
        && Number.isInteger(exitCode)
        && exitCode === 0
        && (outcome === 'PASS' || outcome === 'PASSED');
}

export function isFocusedReviewTestPath(filePath: string): boolean {
    const normalizedPath = normalizePath(filePath).replace(/^\.\/?/u, '');
    return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/iu.test(normalizedPath)
        || /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(normalizedPath);
}

function focusedTestPathsFromCommand(command: string, candidates: readonly string[] = []): string[] {
    return [...new Set(
        [...getChangedTestPathsTargetedByCommandTokens(splitCommandLine(command), candidates), ...splitCommandLine(command)
            .map((token) => normalizePath(token).replace(/^\.\/?/u, ''))
            .filter(isFocusedReviewTestPath)]
    )].sort();
}

function focusedPathsMatchScope(options: {
    focusedTestPaths: readonly string[];
    changedTestPaths: ReadonlySet<string>;
    requiredTestPath: string;
}): boolean {
    return options.requiredTestPath
        ? options.focusedTestPaths.includes(options.requiredTestPath)
        : options.focusedTestPaths.some((filePath) => options.changedTestPaths.has(filePath));
}

function isCheapEligibleFocusedEvent(options: {
    event: TaskAuditEvent;
    changedTestPaths: ReadonlySet<string>;
    requiredTestPath: string;
}): boolean {
    const details = isPlainRecord(options.event.details) ? options.event.details : {};
    const commandSource = String(details.command_source || '').trim();
    const command = String(details.command || '').trim();
    if (
        !isPassedIntermediateCommandEvent(options.event)
        || !command
        || !isFocusedIntermediateCommand(commandSource, splitCommandLine(command))
    ) {
        return false;
    }
    const focusedTestPaths = focusedTestPathsFromCommand(command, [...options.changedTestPaths]);
    return focusedTestPaths.length > 0
        && focusedPathsMatchScope({
            focusedTestPaths,
            changedTestPaths: options.changedTestPaths,
            requiredTestPath: options.requiredTestPath
        });
}

function parseUtcTimestamp(value: unknown): number | null {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : null;
}

function isSha256Hex(value: string): boolean {
    return /^[0-9a-f]{64}$/u.test(value);
}

function readTaskSequence(event: TaskAuditEvent): number | null {
    const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
    const sequence = integrity.task_sequence;
    return typeof sequence === 'number' && Number.isInteger(sequence) && sequence >= 0
        ? sequence
        : null;
}

function resolveRequiredArtifact(
    artifactPathText: string,
    repoRoot: string,
    requiredRoot: string
): string | null {
    try {
        const artifactPath = resolvePathInsideRepo(artifactPathText, repoRoot, {
            allowMissing: false,
            enforceInside: true
        });
        return artifactPath && isPathRealpathInsideRoot(artifactPath, requiredRoot)
            ? artifactPath
            : null;
    } catch {
        return null;
    }
}

interface BoundIntermediateCommandOptions {
    event: TaskAuditEvent;
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    expectedPreflightPath?: string | null;
    expectedPreflightSha256?: string | null;
    expectedCoverageContractSha256?: string | null;
    expectedScopeContentSha256?: string;
    candidateTestPaths?: readonly string[];
    executionOnly?: boolean;
    inspection?: ValidationEvidenceInspection;
}

export function readBoundIntermediateCommandEvidence(options: BoundIntermediateCommandOptions & {
    expectedFailure: true;
}): BoundIntermediateCommandEvidence<ExpectedFailureIntermediateEvidenceEntry>;
export function readBoundIntermediateCommandEvidence(options: BoundIntermediateCommandOptions & {
    expectedFailure?: false;
}): BoundIntermediateCommandEvidence;
export function readBoundIntermediateCommandEvidence(options: BoundIntermediateCommandOptions & {
    expectedFailure?: boolean;
}): BoundIntermediateCommandEvidence<FocusedIntermediateEvidenceEntry | ExpectedFailureIntermediateEvidenceEntry> {
    const details = isPlainRecord(options.event.details) ? options.event.details : {};
    const commandSource = String(details.command_source || '').trim();
    const command = String(details.command || '').trim();
    const artifactPathText = String(details.artifact_path || '').trim();
    const artifactSha256 = String(details.artifact_sha256 || '').trim().toLowerCase();
    const eventOutputArtifactPathText = String(details.output_artifact_path || '').trim();
    const eventOutputArtifactSha256 = String(details.output_artifact_sha256 || '').trim().toLowerCase();
    const eventOutputArtifactSizeBytes = details.output_artifact_size_bytes;
    const eventPreflightPath = normalizePath(String(details.preflight_path || '').trim());
    const eventPreflightSha256 = String(details.preflight_sha256 || '').trim().toLowerCase();
    const eventCoverageContractSha256 = String(details.coverage_contract_sha256 || '').trim().toLowerCase();
    const eventTaskSequence = readTaskSequence(options.event);
    const eventTimestampUtc = String(options.event.timestamp_utc || '').trim();
    if (!INTERMEDIATE_COMMAND_SOURCES.has(commandSource)) {
        return { entry: null, violation: `unsupported command_source '${commandSource || 'missing'}'` };
    }
    if (!command || !artifactPathText || !/^[0-9a-f]{64}$/u.test(artifactSha256)) {
        return { entry: null, violation: 'missing command, artifact path, or artifact sha256' };
    }
    const expectedFailureEvent = options.event.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'
        && details.expected_failure === true && details.timed_out === false && details.cancelled === false
        && typeof details.exit_code === 'number' && Number.isSafeInteger(details.exit_code) && details.exit_code > 0
        && (details.recorded_status === 'PENDING_REVIEW' && options.event.outcome === 'PENDING'
            || details.recorded_status === 'EXPECTED_FAILURE' && options.event.outcome === 'PASS');
    if (options.expectedFailure ? !expectedFailureEvent : !isPassedIntermediateCommandEvent(options.event)) {
        return { entry: null, violation: 'event is not a gate-owned PASSED command with exit_code=0' };
    }
    if (eventTaskSequence == null || parseUtcTimestamp(eventTimestampUtc) == null) {
        return { entry: null, violation: 'event is missing valid task sequence or timestamp binding' };
    }
    const artifactPath = resolveRequiredArtifact(artifactPathText, options.repoRoot, options.reviewsRoot);
    if (!artifactPath) {
        return { entry: null, violation: 'intermediate command artifact is missing, outside reviews root, or hash-mismatched' };
    }
    let record: Record<string, unknown>;
    try {
        const artifact = readValidationFile(options.repoRoot, normalizePath(path.relative(options.repoRoot, artifactPath)),
            MAX_NATIVE_PREFLIGHT_BYTES);
        if (artifact.identity.sha256 !== artifactSha256)
            return { entry: null, violation: 'intermediate command artifact is hash-mismatched' };
        const parsed = JSON.parse(artifact.bytes.toString('utf8')) as unknown;
        if (!isPlainRecord(parsed)) {
            return { entry: null, violation: 'intermediate command artifact must be a JSON object' };
        }
        record = parsed;
    } catch {
        return { entry: null, violation: 'intermediate command artifact is malformed JSON' };
    }
    const recordOutputArtifactText = String(record.output_artifact || '').trim();
    const recordOutputArtifactSha256 = String(record.output_artifact_sha256 || '').trim().toLowerCase();
    const recordOutputArtifactSizeBytes = record.output_artifact_size_bytes;
    const recordPreflightPath = normalizePath(String(record.preflight_path || '').trim());
    const recordPreflightSha256 = String(record.preflight_sha256 || '').trim().toLowerCase();
    const recordCoverageContractSha256 = String(record.coverage_contract_sha256 || '').trim().toLowerCase();
    const expectedPreflightPath = normalizePath(options.expectedPreflightPath || '');
    const expectedPreflightSha256 = String(options.expectedPreflightSha256 || '').trim().toLowerCase();
    const expectedCoverageContractSha256 = String(options.expectedCoverageContractSha256 || '').trim().toLowerCase();
    let expectedScope = options.expectedScopeContentSha256;
    let selectionBinding: IntermediateSelectionBinding | undefined;
    const historicalProductionInputs = new Set<string>();
    if (record.selected_case_binding !== undefined) {
        try {
            // Authenticate the envelope first; report-output exceptions are applied only after report validation.
            assertCurrentIntermediateSelection(options.repoRoot, record.selected_case_binding, []);
            if (JSON.stringify(record.selected_case_binding) !== JSON.stringify(details.selected_case_binding)
                || typeof record.execution_id !== 'string' || !record.execution_id
                || record.execution_id !== details.execution_id) throw new Error('Selected execution event binding differs.');
            selectionBinding = record.selected_case_binding;
            const current = readImmutableValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection);
            if (options.expectedFailure) {
                // RED predates the implementation preflight. Authenticate its original native facts,
                // while the caller checks that each selected test source is still unchanged.
                const cycle = current.events.slice(current.events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED') + 1);
                const native = cycle.find(event => validationDigest(event) === validationDigest(options.event));
                const starts = cycle.filter(event => event.event_type === 'INTERMEDIATE_COMMAND_STARTED'
                    && event.details?.execution_id === record.execution_id);
                const start = starts[0];
                const classified = cycle.filter(event => event.event_type === 'PREFLIGHT_CLASSIFIED'
                    && Number(event.integrity?.task_sequence) < Number(start?.integrity?.task_sequence)).at(-1);
                if (!native || starts.length !== 1 || Number(start.integrity?.task_sequence) >= eventTaskSequence
                    || start.details?.preflight_sha256 !== recordPreflightSha256
                    || start.details?.command !== command || start.details?.artifact_path !== artifactPathText
                    || validationDigest(start.details?.selected_case_selection) !== validationDigest(selectionBinding.before)
                    || record.test_scope_sha256 !== details.test_scope_sha256
                    || record.test_scope_sha256 !== classified?.details?.scope_content_sha256
                    || expectedScope !== record.test_scope_sha256)
                    throw new Error('Expected-red execution lacks its authenticated original classification and start.');
                const originalProfile = classified?.details?.profile_policy_snapshot;
                const profile = isPlainRecord(originalProfile) ? originalProfile : {};
                const policy = isPlainRecord(profile.review_trigger_policy) ? profile.review_trigger_policy : {};
                const roles = normalizeFileRoleBindings(policy.file_roles);
                for (const source of selectionBinding.before.sources) {
                    if (declaredFileRole(source.path, roles) === 'source' && current.changed_files.includes(source.path)
                        && !selectionBinding.before.cases.some(claim => intermediateSourcePathKey(claim.source) === intermediateSourcePathKey(source.path)))
                        historicalProductionInputs.add(intermediateSourcePathKey(source.path));
                }
            } else {
                if (recordPreflightSha256 !== current.preflight_sha256
                    || path.resolve(options.repoRoot, recordPreflightPath) !== path.resolve(current.preflight_path))
                    throw new Error('Selected execution requires the current canonical preflight.');
                expectedScope = current.scope_content_sha256;
            }
        } catch (error) { return { entry: null, violation: `selected execution binding rejected: ${String(error)}` }; }
    }
    if (expectedScope && (!isSha256Hex(expectedScope)
        || record.timed_out !== false || record.cancelled !== false
        || (options.expectedFailure ? record.expected_failure !== true : record.expected_failure === true)
        || record.scope_content_sha256_before !== expectedScope || record.scope_content_sha256_after !== expectedScope
        || details.scope_content_sha256_before !== expectedScope || details.scope_content_sha256_after !== expectedScope)) {
        return { entry: null, violation: 'native execution source-content binding differs from the current scope' };
    }
    const malformedHashBinding = [
        { label: 'event preflight_sha256', value: eventPreflightSha256 },
        { label: 'event coverage_contract_sha256', value: eventCoverageContractSha256 },
        { label: 'artifact preflight_sha256', value: recordPreflightSha256 },
        { label: 'artifact coverage_contract_sha256', value: recordCoverageContractSha256 },
        { label: 'expected preflight_sha256', value: expectedPreflightSha256 },
        { label: 'expected coverage_contract_sha256', value: expectedCoverageContractSha256 }
    ].find((binding) => binding.value && !isSha256Hex(binding.value));
    if (malformedHashBinding) {
        return { entry: null, violation: `${malformedHashBinding.label} is not a valid SHA-256 hex binding` };
    }
    const outputArtifactPath = resolveRequiredArtifact(
        recordOutputArtifactText,
        options.repoRoot,
        options.reviewsRoot
    );
    const eventOutputArtifactPath = eventOutputArtifactPathText
        ? resolveRequiredArtifact(eventOutputArtifactPathText, options.repoRoot, options.reviewsRoot)
        : null;
    if (options.expectedFailure && (record.output_truncated !== false || details.output_truncated !== false
        || !Array.isArray(record.invocations) || record.invocations.length !== 1
        || !isPlainRecord(record.invocations[0]) || record.invocations[0].exitCode !== record.exit_code
        || record.invocations[0].executionError !== undefined || record.invocations[0].terminationSignal != null
        || record.invocations[0].sinkError !== undefined || record.invocations[0].outputTruncated !== false))
        return { entry: null, violation: 'Expected-red requires a complete observed child invocation without termination or capture errors.' };
    if (
        record.schema_version !== 1
        || String(record.task_id || '').trim() !== options.taskId
        || String(record.command_source || '').trim() !== commandSource
        || String(record.command || '').trim() !== command
        || (options.expectedFailure ? record.status !== details.recorded_status || record.exit_code !== details.exit_code
            : String(record.status || '').trim().toUpperCase() !== 'PASSED' || record.exit_code !== 0)
        || record.termination_signal != null || details.termination_signal != null
        || record.output_truncated === true || details.output_truncated === true
        || record.output_sink_error !== undefined || details.output_sink_error !== undefined
        || !outputArtifactPath
        || !/^[0-9a-f]{64}$/u.test(recordOutputArtifactSha256)
        || typeof recordOutputArtifactSizeBytes !== 'number'
        || !Number.isSafeInteger(recordOutputArtifactSizeBytes)
        || recordOutputArtifactSizeBytes < 0
        || !eventOutputArtifactPathText
        || eventOutputArtifactSha256 !== recordOutputArtifactSha256
        || eventOutputArtifactSizeBytes !== recordOutputArtifactSizeBytes
        || eventOutputArtifactPath !== outputArtifactPath
    ) {
        return { entry: null, violation: 'artifact task, command, status, output, or event binding is inconsistent' };
    }
    if (
        ((recordPreflightPath || eventPreflightPath) && recordPreflightPath !== eventPreflightPath)
        || ((recordPreflightSha256 || eventPreflightSha256) && recordPreflightSha256 !== eventPreflightSha256)
        || ((recordCoverageContractSha256 || eventCoverageContractSha256) && recordCoverageContractSha256 !== eventCoverageContractSha256)
    ) {
        return { entry: null, violation: 'artifact and event preflight or coverage binding is inconsistent' };
    }
    if (
        (expectedPreflightPath && recordPreflightPath !== expectedPreflightPath)
        || (expectedPreflightSha256 && recordPreflightSha256 !== expectedPreflightSha256)
        || (expectedCoverageContractSha256 && recordCoverageContractSha256 !== expectedCoverageContractSha256)
    ) {
        return { entry: null, violation: 'focused evidence preflight or coverage binding does not match the current review context' };
    }
    let reportEvidence: ValidationReportEvidenceBinding | undefined;
    try {
        if (record.report_evidence !== undefined || details.report_evidence !== undefined
            || record.output_encoding !== undefined || details.output_encoding !== undefined) {
            reportEvidence = parseValidationReportEvidenceBinding(record.report_evidence,
                normalizePath(path.relative(options.repoRoot, artifactPath)) + '.reports');
            if (validationDigest(record.report_evidence) !== validationDigest(details.report_evidence)
                || record.output_encoding !== 'base64-streams' || details.output_encoding !== 'base64-streams'
                || !Array.isArray(record.report_violations) || record.report_violations.length !== 0
                || !Array.isArray(details.report_violations) || details.report_violations.length !== 0)
                throw new Error('Failed or foreign report evidence cannot prove a successful intermediate execution.');
        }
        const output = readValidationFile(options.repoRoot, normalizePath(path.relative(options.repoRoot, outputArtifactPath)),
            MAX_RETAINED_VALIDATION_OUTPUT_BYTES);
        if (output.bytes.length !== recordOutputArtifactSizeBytes || output.identity.sha256 !== recordOutputArtifactSha256) {
            return { entry: null, violation: 'output artifact size or sha256 no longer matches the recorded evidence' };
        }
        if (reportEvidence) {
            const envelope: unknown = JSON.parse(output.bytes.toString('utf8'));
            if (!isPlainRecord(envelope)) throw new Error('Report capture envelope is malformed.');
            readRetainedValidationReports({ repoRoot: options.repoRoot, capture: envelope.report_capture,
                declarations: reportEvidence.declarations, expectedStartSha256: reportEvidence.start_sha256,
                evidenceDirectory: reportEvidence.evidence_directory, executionViolations: [] });
        }
        if (selectionBinding) {
            const outputs = new Set(reportEvidence?.declarations.map(report => intermediateSourcePathKey(report.path)) ?? []);
            const currentInputs: string[] = [];
            for (const [index, source] of selectionBinding.before.sources.entries()) {
                if (outputs.has(intermediateSourcePathKey(source.path))) continue;
                if (validationDigest(source) !== validationDigest(selectionBinding.after?.[index]))
                    throw new Error('Captured command input changed during execution.');
                if (!historicalProductionInputs.has(intermediateSourcePathKey(source.path))) currentInputs.push(source.path);
            }
            assertCurrentIntermediateSelection(options.repoRoot, selectionBinding, currentInputs);
        }
    } catch (error) {
        return { entry: null, violation: `output artifact is unavailable or invalid: ${String(error)}` };
    }
    if (!options.executionOnly && !selectionBinding && !isFocusedIntermediateCommand(commandSource, splitCommandLine(command))) {
        return { entry: null, violation: 'command is not an allowed focused test invocation' };
    }
    const focusedTestPaths = options.executionOnly ? [] : selectionBinding
        ? [...new Set((selectionBinding.before.cases.length ? selectionBinding.before.cases.map(item => item.source)
            : selectionBinding.before.sources.map(item => item.path)).map(source => options.candidateTestPaths?.find(candidate =>
                intermediateSourcePathKey(candidate) === intermediateSourcePathKey(source)))
            .filter((source): source is string => source !== undefined))].sort()
        : focusedTestPathsFromCommand(command, options.candidateTestPaths);
    if (selectionBinding && !options.executionOnly) {
        try { assertCurrentIntermediateSelection(options.repoRoot, selectionBinding, focusedTestPaths); }
        catch (error) { return { entry: null, violation: String(error) }; }
    }
    if (!options.executionOnly && focusedTestPaths.length === 0) {
        return { entry: null, violation: 'focused command does not name a concrete test path' };
    }
    return {
        entry: {
            command_source: commandSource,
            command,
            ...(options.expectedFailure ? { status: record.status as 'PENDING_REVIEW' | 'EXPECTED_FAILURE',
                exit_code: record.exit_code as number, expected_failure: true as const }
                : { status: 'PASSED' as const, exit_code: 0 as const }),
            preflight_path: recordPreflightPath || null,
            preflight_sha256: recordPreflightSha256 || null,
            coverage_contract_sha256: recordCoverageContractSha256 || null,
            event_timestamp_utc: eventTimestampUtc,
            event_task_sequence: eventTaskSequence,
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            output_artifact_path: normalizePath(outputArtifactPath),
            output_artifact_sha256: recordOutputArtifactSha256,
            output_artifact_size_bytes: recordOutputArtifactSizeBytes,
            ...(reportEvidence ? { output_encoding: 'base64-streams' as const, report_evidence: reportEvidence } : {}),
            focused_test_paths: focusedTestPaths,
            ...(selectionBinding ? { selected_case_binding: selectionBinding, execution_id: String(record.execution_id),
                semantic_status: 'PENDING_INDEPENDENT_REVIEW' as const } : {}),
            ...(expectedScope ? { scope_content_sha256: expectedScope } : {})
        },
        violation: null
    };
}

function appendWarning(warnings: string[], warning: string): void {
    if (warnings.length < MAX_WARNINGS) {
        warnings.push(warning);
    }
}

interface IntermediateEvidenceOptions {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    taskId: string;
    changedFiles: readonly string[];
    requiredTestPath?: string | null;
    minimumTimestampExclusive?: number | null;
    minimumTaskSequenceExclusive?: number | null;
    maxEntries?: number;
    maxTimelineBytes?: number;
    maxTimelineEvents?: number;
    maxIntermediateCandidatesScanned?: number;
    expectedPreflightPath?: string | null;
    expectedPreflightSha256?: string | null;
    expectedCoverageContractSha256?: string | null;
    expectedScopeContentSha256?: string;
    inspection?: ValidationEvidenceInspection;
}

function readIntermediateEvidence(options: IntermediateEvidenceOptions, executionOnly: boolean): FocusedIntermediateEvidenceSelection {
    const timelinePath = path.join(options.eventsRoot, `${options.taskId}.jsonl`);
    let timelineSha256: string | null = null;
    const maxTimelineBytes = Number.isInteger(options.maxTimelineBytes) && Number(options.maxTimelineBytes) > 0
        ? Number(options.maxTimelineBytes)
        : DEFAULT_MAX_TIMELINE_BYTES;
    const maxTimelineEvents = Number.isInteger(options.maxTimelineEvents) && Number(options.maxTimelineEvents) > 0
        ? Number(options.maxTimelineEvents)
        : DEFAULT_MAX_TIMELINE_EVENTS;
    const maxIntermediateCandidatesScanned = Number.isInteger(options.maxIntermediateCandidatesScanned)
        && Number(options.maxIntermediateCandidatesScanned) > 0
        ? Number(options.maxIntermediateCandidatesScanned)
        : DEFAULT_MAX_INTERMEDIATE_CANDIDATES_SCANNED;
    try {
        const timelineStat = fs.statSync(timelinePath);
        if (!timelineStat.isFile() || timelineStat.size > maxTimelineBytes) {
            return {
                entries: [],
                warnings: [`focused intermediate evidence rejected: task timeline exceeds ${maxTimelineBytes} byte read bound`],
                latest_task_mode_sequence: null,
                candidate_count: 0,
                rejected_candidate_count: 0,
                truncated: true
            };
        }
        timelineSha256 = readValidationFile(options.repoRoot, normalizePath(path.relative(options.repoRoot, timelinePath)),
            maxTimelineBytes).identity.sha256;
    } catch {
        return {
            entries: [],
            warnings: ['focused intermediate evidence rejected: task timeline is missing'],
            latest_task_mode_sequence: null,
            candidate_count: 0,
            rejected_candidate_count: 0,
            truncated: false
        };
    }
    const timelineInspection = inspectTaskEventFile(timelinePath, options.taskId);
    if (timelineInspection.status !== 'PASS' && timelineInspection.status !== 'PASS_WITH_LEGACY_PREFIX') {
        return {
            entries: [],
            warnings: [`focused intermediate evidence rejected: task timeline integrity is ${timelineInspection.status}`],
            latest_task_mode_sequence: null,
            candidate_count: 0,
            rejected_candidate_count: 0,
            truncated: false
        };
    }
    const events = readNavigationOrderedTaskEvents(timelinePath, options.taskId).events;
    if (events.length > maxTimelineEvents) {
        return {
            entries: [],
            warnings: [`focused intermediate evidence rejected: task timeline exceeds ${maxTimelineEvents} event read bound`],
            latest_task_mode_sequence: null,
            candidate_count: 0,
            rejected_candidate_count: 0,
            truncated: true
        };
    }
    const indexed = verifiedIndexForEvents(events);
    const taskModes = indexed ? selectVerifiedEvents(indexed, ['TASK_MODE_ENTERED'], { trimmed: true }) : events;
    const latestTaskModeSequence = taskModes.reduce<number | null>((latest, event) => {
        countNextStepWork('visit:focused_intermediate_task_mode_event');
        if (String(event.event_type || '').trim() !== 'TASK_MODE_ENTERED') {
            return latest;
        }
        const sequence = readTaskSequence(event);
        return sequence == null || (latest != null && latest >= sequence) ? latest : sequence;
    }, null);
    const warnings: string[] = [];
    if (latestTaskModeSequence == null) {
        appendWarning(warnings, 'focused intermediate evidence rejected: current task-mode sequence is missing');
    }
    let declaredTests = new Set<string>();
    try { if (!executionOnly) declaredTests = declaredValidationTestPaths(options.repoRoot); } catch (error) {
        appendWarning(warnings, `Declared test scope rejected: ${String(error)}`);
    }
    const changedTestPaths = new Set(
        options.changedFiles
            .map((filePath) => normalizePath(filePath).replace(/^\.\/?/u, ''))
            .filter(filePath => isFocusedReviewTestPath(filePath) || declaredTests.has(filePath))
    );
    const requiredTestPath = normalizePath(options.requiredTestPath || '').replace(/^\.\/?/u, '');
    const maxEntries = Number.isInteger(options.maxEntries) && Number(options.maxEntries) > 0
        ? Number(options.maxEntries)
        : DEFAULT_MAX_ENTRIES;
    const entries: FocusedIntermediateEvidenceEntry[] = [];
    const changedPaths = options.changedFiles.map(normalizePath);
    let candidateCount = 0;
    let rejectedCandidateCount = 0;
    let eligibleCount = 0;
    let scanLimitReached = false;
    const candidates = indexed ? selectVerifiedEvents(indexed, ['INTERMEDIATE_COMMAND_RUN', 'PROJECT_VALIDATION_RESULTS_EVALUATED'], { trimmed: true, ordered: true }) : events;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
        countNextStepWork('visit:focused_intermediate_event');
        const event = candidates[index];
        if (!['INTERMEDIATE_COMMAND_RUN', 'PROJECT_VALIDATION_RESULTS_EVALUATED'].includes(String(event.event_type || '').trim())) {
            continue;
        }
        if (executionOnly && event.event_type !== 'INTERMEDIATE_COMMAND_RUN') continue;
        if (candidateCount >= maxIntermediateCandidatesScanned) {
            scanLimitReached = true;
            appendWarning(warnings, `focused intermediate evidence scan stopped after ${maxIntermediateCandidatesScanned} intermediate candidates`);
            break;
        }
        candidateCount += 1;
        const sequence = readTaskSequence(event);
        const timestamp = parseUtcTimestamp(event.timestamp_utc);
        if (
            String(event.task_id || '').trim() !== options.taskId
            || latestTaskModeSequence == null
            || sequence == null
            || sequence <= latestTaskModeSequence
            || (options.minimumTaskSequenceExclusive != null && sequence <= options.minimumTaskSequenceExclusive)
            || (options.minimumTimestampExclusive != null && (timestamp == null || timestamp <= options.minimumTimestampExclusive))
        ) {
            rejectedCandidateCount += 1;
            appendWarning(warnings, `focused intermediate evidence candidate seq=${sequence ?? 'missing'} rejected: stale or foreign task/cycle binding`);
            continue;
        }
        const bound = event.event_type === 'PROJECT_VALIDATION_RESULTS_EVALUATED'
            ? readFocusedRecipeEntry({ repoRoot: options.repoRoot, taskId: options.taskId, event,
                expectedPreflightSha256: options.expectedPreflightSha256 }) : readBoundIntermediateCommandEvidence({
            event,
            repoRoot: options.repoRoot,
            reviewsRoot: options.reviewsRoot,
            taskId: options.taskId,
            expectedPreflightPath: options.expectedPreflightPath,
            expectedPreflightSha256: options.expectedPreflightSha256,
            expectedCoverageContractSha256: options.expectedCoverageContractSha256,
            expectedScopeContentSha256: options.expectedScopeContentSha256,
            candidateTestPaths: changedPaths, executionOnly, inspection: options.inspection
        });
        if (!bound.entry) {
            rejectedCandidateCount += 1;
            appendWarning(warnings, `focused intermediate evidence candidate seq=${sequence} rejected: ${bound.violation || 'invalid evidence'}`);
            continue;
        }
        if (!executionOnly && bound.entry.selected_case_binding) {
            try {
                const entry = bound.entry;
                const attemptEvents = indexed ? selectVerifiedEvents(indexed, ['INTERMEDIATE_COMMAND_RUN', 'INTERMEDIATE_COMMAND_STARTED'], { ordered: true }) : events;
                const attempts = attemptEvents.filter(attempt => {
                    countNextStepWork('visit:focused_intermediate_attempt_event');
                    const data = isPlainRecord(attempt.details) ? attempt.details : {};
                    return ['INTERMEDIATE_COMMAND_RUN', 'INTERMEDIATE_COMMAND_STARTED'].includes(String(attempt.event_type))
                        && attempt.task_id === options.taskId
                        && data.preflight_sha256 === entry.preflight_sha256
                        && (readTaskSequence(attempt) ?? -1) > latestTaskModeSequence!;
                });
                for (const source of entry.focused_test_paths) {
                    const latest = latestMatchingIntermediateAttempt(attempts, source);
                    if (readTaskSequence(latest ?? {}) !== entry.event_task_sequence)
                        throw new Error('Latest matching focused attempt is failed, unfinished or supersedes this execution.');
                }
                const start = attempts.find(attempt => attempt.event_type === 'INTERMEDIATE_COMMAND_STARTED'
                    && isPlainRecord(attempt.details) && attempt.details.execution_id === entry.execution_id);
                const data = start && isPlainRecord(start.details) ? start.details : {};
                if (!start || (readTaskSequence(start) ?? Infinity) >= entry.event_task_sequence
                    || data.command !== entry.command || data.artifact_path !== (isPlainRecord(event.details) ? event.details.artifact_path : null)
                    || JSON.stringify(data.selected_case_selection) !== JSON.stringify(entry.selected_case_binding?.before)
                    || validationDigest(data.report_evidence ?? null) !== validationDigest(entry.report_evidence ?? null))
                    throw new Error('Focused selected execution has no matching authenticated prior start.');
            } catch (error) {
                rejectedCandidateCount += 1; appendWarning(warnings, String(error)); continue;
            }
        }
        if (!executionOnly && !focusedPathsMatchScope({
            focusedTestPaths: bound.entry.focused_test_paths,
            changedTestPaths: bound.entry.selected_case_binding ? new Set(changedPaths) : changedTestPaths,
            requiredTestPath
        })) {
            rejectedCandidateCount += 1;
            appendWarning(warnings, `focused intermediate evidence candidate seq=${sequence} rejected: focused test path is outside the current review scope`);
            continue;
        }
        eligibleCount += 1;
        if (entries.length < maxEntries) {
            entries.push(bound.entry);
        }
        if (entries.length >= maxEntries) {
            for (let surplusIndex = index - 1; surplusIndex >= 0; surplusIndex -= 1) {
                countNextStepWork('visit:focused_intermediate_surplus_event');
                const surplusEvent = candidates[surplusIndex];
                if (!['INTERMEDIATE_COMMAND_RUN', 'PROJECT_VALIDATION_RESULTS_EVALUATED'].includes(String(surplusEvent.event_type || '').trim())) {
                    continue;
                }
                if (executionOnly && surplusEvent.event_type !== 'INTERMEDIATE_COMMAND_RUN') continue;
                if (candidateCount >= maxIntermediateCandidatesScanned) {
                    scanLimitReached = true;
                    appendWarning(warnings, `focused intermediate evidence surplus scan stopped after ${maxIntermediateCandidatesScanned} intermediate candidates`);
                    break;
                }
                candidateCount += 1;
                const surplusSequence = readTaskSequence(surplusEvent);
                const surplusTimestamp = parseUtcTimestamp(surplusEvent.timestamp_utc);
                if (
                    String(surplusEvent.task_id || '').trim() !== options.taskId
                    || latestTaskModeSequence == null
                    || surplusSequence == null
                    || surplusSequence <= latestTaskModeSequence
                    || (options.minimumTaskSequenceExclusive != null && surplusSequence <= options.minimumTaskSequenceExclusive)
                    || (options.minimumTimestampExclusive != null && (surplusTimestamp == null || surplusTimestamp <= options.minimumTimestampExclusive))
                ) {
                    rejectedCandidateCount += 1;
                    appendWarning(warnings, `focused intermediate evidence candidate seq=${surplusSequence ?? 'missing'} rejected: stale or foreign task/cycle binding`);
                    continue;
                }
                let surplusEligible: boolean;
                if (executionOnly) {
                    surplusEligible = isPassedIntermediateCommandEvent(surplusEvent);
                } else if (surplusEvent.event_type === 'PROJECT_VALIDATION_RESULTS_EVALUATED') {
                    const { entry } = readFocusedRecipeEntry({ repoRoot: options.repoRoot, taskId: options.taskId,
                        event: surplusEvent, expectedPreflightSha256: options.expectedPreflightSha256 });
                    surplusEligible = !!entry && focusedPathsMatchScope({
                        focusedTestPaths: entry.focused_test_paths, changedTestPaths, requiredTestPath });
                } else {
                    surplusEligible = isCheapEligibleFocusedEvent({ event: surplusEvent, changedTestPaths, requiredTestPath });
                }
                if (surplusEligible) {
                    eligibleCount += 1;
                } else {
                    rejectedCandidateCount += 1;
                }
            }
            break;
        }
    }
    if (!executionOnly && entries.some(entry => entry.selected_case_binding)) {
        try {
            if (readImmutableValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection).timeline_sha256 !== timelineSha256)
                throw new Error('Focused native timeline changed during evidence inspection.');
            for (const entry of entries) if (entry.selected_case_binding)
                assertCurrentIntermediateSelection(options.repoRoot, entry.selected_case_binding, entry.focused_test_paths);
        } catch (error) { entries.length = 0; appendWarning(warnings, String(error)); }
    }
    return {
        entries,
        warnings,
        latest_task_mode_sequence: latestTaskModeSequence,
        candidate_count: candidateCount,
        rejected_candidate_count: rejectedCandidateCount,
        truncated: scanLimitReached || eligibleCount > entries.length
    };
}

export function readTaskOwnedFocusedIntermediateEvidence(options: IntermediateEvidenceOptions): FocusedIntermediateEvidenceSelection {
    return readIntermediateEvidence(options, false);
}

/** Only current authenticated observations can supply a symbolic focused target to command syntax inspection. */
export function readCurrentNativeFocusedCommand(repoRoot: string, taskId: string,
    command: string): FocusedIntermediateEvidenceEntry | null {
    try {
        const current = readImmutableValidationEventSnapshot(repoRoot, taskId);
        const relative = normalizePath(path.relative(repoRoot, current.preflight_path));
        const file = readValidationFile(repoRoot, relative, MAX_NATIVE_PREFLIGHT_BYTES);
        if (file.identity.sha256 !== current.preflight_sha256) return null;
        const preflight: unknown = JSON.parse(file.bytes.toString('utf8'));
        if (!isPlainRecord(preflight) || !Array.isArray(preflight.changed_files)
            || !preflight.changed_files.every(item => typeof item === 'string')) return null;
        const paths = validationPaths(repoRoot, taskId);
        const evidence = readTaskOwnedFocusedIntermediateEvidence({ repoRoot, taskId,
            reviewsRoot: path.join(repoRoot, path.dirname(paths.timeline), '../reviews'),
            eventsRoot: path.join(repoRoot, path.dirname(paths.timeline)), changedFiles: preflight.changed_files,
            expectedPreflightPath: current.preflight_path, expectedPreflightSha256: current.preflight_sha256,
            expectedScopeContentSha256: current.scope_content_sha256, minimumTaskSequenceExclusive: current.preflight_sequence });
        const identity = intermediateInvocationIdentity(command);
        const entry = evidence.entries.find(item => item.selected_case_binding && item.focused_test_paths.length === 1
            && identity !== null && intermediateInvocationIdentity(item.command) === identity);
        if (entry?.selected_case_binding) {
            const snapshot = isPlainRecord(preflight.profile_policy_snapshot) ? preflight.profile_policy_snapshot : {};
            const policy = isPlainRecord(snapshot.review_trigger_policy) ? snapshot.review_trigger_policy : {};
            const roles = normalizeFileRoleBindings(policy.file_roles);
            const testPatterns = Array.isArray(policy.test_path_regexes)
                ? policy.test_path_regexes.filter((pattern): pattern is string => typeof pattern === 'string') : [];
            const isTest = (source: string): boolean => {
                const role = declaredFileRole(source, roles);
                return role ? role === 'test' : testPatterns.length > 0
                    ? isTestScopePath(source, testPatterns) : isFocusedReviewTestPath(source);
            };
            const selection = entry.selected_case_binding.before;
            // Historical capture omitted directories; it cannot establish one-target native authority.
            if (!Array.isArray(selection.scope_operands)) return null;
            if (selection.scope_operands.length) {
                if (selection.scope_operands.some(scope => !isPathRealpathInsideRoot(
                    path.resolve(repoRoot, scope), repoRoot, { allowMissing: false }))) return null;
                const operandKey = (value: string): string => intermediateSourcePathKey(
                    normalizePath(path.relative(repoRoot, path.resolve(repoRoot, value))) || '.');
                const operands = new Set([...selection.sources.map(source => source.path),
                    ...selection.scope_operands, ...(selection.unobserved_operands ?? [])].map(operandKey));
                const argumentsOnly = splitCommandLine(entry.command).slice(1);
                const values = new Set(argumentsOnly.flatMap(token =>
                    [token, ...(token.includes('=') ? [token.slice(token.indexOf('=') + 1)] : [])]));
                const terminator = argumentsOnly.indexOf('--');
                const literalValues = new Set([...argumentsOnly.flatMap(token => token.includes('=')
                    ? [token.slice(token.indexOf('=') + 1)] : []),
                ...(terminator < 0 ? [] : argumentsOnly.slice(terminator + 1))]);
                // A source/directory operand or mode flag cannot pretend to narrow a directory run.
                if (!selection.cases.length || selection.cases.some(claim =>
                    claim.selector.startsWith('-') && !literalValues.has(claim.selector)
                    || !values.has(claim.selector) || operands.has(operandKey(claim.selector)))) return null;
            }
            const allTargets = new Set([...entry.focused_test_paths, ...selection.cases.map(item => item.source),
                ...(selection.unobserved_operands ?? []).filter(isTest),
                ...selection.sources.filter(source => isTest(source.path))
                    .map(source => source.path)].map(intermediateSourcePathKey));
            // Scope relevance cannot erase other actual test operands from the focused invocation.
            if (allTargets.size !== 1) return null;
        }
        if (readImmutableValidationEventSnapshot(repoRoot, taskId).timeline_sha256 !== current.timeline_sha256) return null;
        return entry ?? null;
    } catch { return null; }
}

export type NativeIntermediateExecutionEntry = Omit<FocusedIntermediateEvidenceEntry, 'status' | 'focused_test_paths'> & {
    process_status: 'PASSED'; execution: 'OBSERVED'; semantic_status: 'PENDING_INDEPENDENT_REVIEW';
};
export function readTaskOwnedIntermediateExecutionEvidence(options: Omit<IntermediateEvidenceOptions, 'changedFiles'> & {
    expectedPreflightPath: string; expectedPreflightSha256: string; expectedScopeContentSha256: string;
    inspection?: ValidationEvidenceInspection;
}): Omit<FocusedIntermediateEvidenceSelection, 'entries'> & { entries: NativeIntermediateExecutionEntry[] } {
    const rejected = (warning: string) => ({ entries: [], warnings: [warning],
        latest_task_mode_sequence: null, candidate_count: 0, rejected_candidate_count: 0, truncated: false });
    if (!options.expectedPreflightPath || !isSha256Hex(options.expectedPreflightSha256)
        || !isSha256Hex(options.expectedScopeContentSha256)) {
        return rejected('Native execution requires current preflight and source-content bindings.');
    }
    try {
        const snapshot = readImmutableValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection);
        const timeline = validationPaths(options.repoRoot, options.taskId).timeline;
        if (path.resolve(options.repoRoot, options.expectedPreflightPath) !== path.resolve(snapshot.preflight_path)
            || options.expectedPreflightSha256 !== snapshot.preflight_sha256
            || options.expectedScopeContentSha256 !== snapshot.scope_content_sha256
            || path.resolve(options.eventsRoot, `${options.taskId}.jsonl`) !== path.resolve(options.repoRoot, timeline)) {
            return rejected('Native execution requires the current canonical preflight and source-content binding.');
        }
        const relative = normalizePath(path.relative(path.resolve(options.repoRoot),
            snapshot.preflight_path));
        const result = readIntermediateEvidence({ ...options, changedFiles: [], minimumTaskSequenceExclusive:
            Math.max(options.minimumTaskSequenceExclusive ?? 0, snapshot.preflight_sequence) }, true);
        if (readValidationFile(options.repoRoot, relative, MAX_NATIVE_PREFLIGHT_BYTES).identity.sha256
            !== snapshot.preflight_sha256 || readValidationFile(options.repoRoot, timeline, MAX_NATIVE_PREFLIGHT_BYTES).identity.sha256
            !== snapshot.timeline_sha256) return rejected('Native execution canonical binding changed during evidence inspection.');
        return { ...result, entries: result.entries.map(({ status, focused_test_paths: _paths, ...entry }) => ({
            ...entry, process_status: status, execution: 'OBSERVED', semantic_status: 'PENDING_INDEPENDENT_REVIEW'
        })) };
    } catch (error) {
        return rejected(`Native execution preflight/source-content binding rejected: ${String(error).split(/\r?\n/u)[0].slice(0, 512)}`);
    }
}
