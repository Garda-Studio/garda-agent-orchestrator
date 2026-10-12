import * as fs from 'node:fs';
import * as path from 'node:path';

import { splitCommandLine } from '../../cli/gate-cli/gates-subprocess';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import {
    readOrderedTaskEvents,
    type TaskAuditEvent
} from '../task-audit/task-audit-summary-lifecycle';
import {
    fileSha256,
    isPathRealpathInsideRoot,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import { isFocusedIntermediateCommand } from '../shared/focused-intermediate-command-grammar';
import { declaredValidationTestPaths, readFocusedRecipeEntry } from '../project-validation/focused';

const INTERMEDIATE_COMMAND_SOURCES = new Set(['node-test', 'targeted-test', 'typecheck', 'validation']);
const DEFAULT_MAX_ENTRIES = 8;
const MAX_WARNINGS = 16;
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
    focused_test_paths: string[];
}

export interface FocusedIntermediateEvidenceSelection {
    entries: FocusedIntermediateEvidenceEntry[];
    warnings: string[];
    latest_task_mode_sequence: number | null;
    candidate_count: number;
    rejected_candidate_count: number;
    truncated: boolean;
}

interface BoundIntermediateCommandEvidence {
    entry: FocusedIntermediateEvidenceEntry | null;
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

function focusedTestPathsFromCommand(command: string): string[] {
    return [...new Set(
        splitCommandLine(command)
            .map((token) => normalizePath(token).replace(/^\.\/?/u, ''))
            .filter(isFocusedReviewTestPath)
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
    const focusedTestPaths = focusedTestPathsFromCommand(command);
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

function readBoundIntermediateCommandEvidence(options: {
    event: TaskAuditEvent;
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    expectedPreflightPath?: string | null;
    expectedPreflightSha256?: string | null;
    expectedCoverageContractSha256?: string | null;
}): BoundIntermediateCommandEvidence {
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
    if (!isPassedIntermediateCommandEvent(options.event)) {
        return { entry: null, violation: 'event is not a gate-owned PASSED command with exit_code=0' };
    }
    if (eventTaskSequence == null || parseUtcTimestamp(eventTimestampUtc) == null) {
        return { entry: null, violation: 'event is missing valid task sequence or timestamp binding' };
    }
    const artifactPath = resolveRequiredArtifact(artifactPathText, options.repoRoot, options.reviewsRoot);
    if (!artifactPath || fileSha256(artifactPath) !== artifactSha256) {
        return { entry: null, violation: 'intermediate command artifact is missing, outside reviews root, or hash-mismatched' };
    }
    let record: Record<string, unknown>;
    try {
        const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown;
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
    if (
        record.schema_version !== 1
        || String(record.task_id || '').trim() !== options.taskId
        || String(record.command_source || '').trim() !== commandSource
        || String(record.command || '').trim() !== command
        || String(record.status || '').trim().toUpperCase() !== 'PASSED'
        || record.exit_code !== 0
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
    try {
        if (
            fs.statSync(outputArtifactPath).size !== recordOutputArtifactSizeBytes
            || fileSha256(outputArtifactPath) !== recordOutputArtifactSha256
        ) {
            return { entry: null, violation: 'output artifact size or sha256 no longer matches the recorded evidence' };
        }
    } catch {
        return { entry: null, violation: 'output artifact is unavailable' };
    }
    if (!isFocusedIntermediateCommand(commandSource, splitCommandLine(command))) {
        return { entry: null, violation: 'command is not an allowed focused test invocation' };
    }
    const focusedTestPaths = focusedTestPathsFromCommand(command);
    if (focusedTestPaths.length === 0) {
        return { entry: null, violation: 'focused command does not name a concrete test path' };
    }
    return {
        entry: {
            command_source: commandSource,
            command,
            status: 'PASSED',
            exit_code: 0,
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
            focused_test_paths: focusedTestPaths
        },
        violation: null
    };
}

function appendWarning(warnings: string[], warning: string): void {
    if (warnings.length < MAX_WARNINGS) {
        warnings.push(warning);
    }
}

export function readTaskOwnedFocusedIntermediateEvidence(options: {
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
}): FocusedIntermediateEvidenceSelection {
    const timelinePath = path.join(options.eventsRoot, `${options.taskId}.jsonl`);
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
    const events = readOrderedTaskEvents(timelinePath).events;
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
    const latestTaskModeSequence = events.reduce<number | null>((latest, event) => {
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
    try { declaredTests = declaredValidationTestPaths(options.repoRoot); } catch (error) {
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
    let candidateCount = 0;
    let rejectedCandidateCount = 0;
    let eligibleCount = 0;
    let scanLimitReached = false;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!['INTERMEDIATE_COMMAND_RUN', 'PROJECT_VALIDATION_RESULTS_EVALUATED'].includes(String(event.event_type || '').trim())) {
            continue;
        }
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
            expectedCoverageContractSha256: options.expectedCoverageContractSha256
        });
        if (!bound.entry) {
            rejectedCandidateCount += 1;
            appendWarning(warnings, `focused intermediate evidence candidate seq=${sequence} rejected: ${bound.violation || 'invalid evidence'}`);
            continue;
        }
        if (!focusedPathsMatchScope({
            focusedTestPaths: bound.entry.focused_test_paths,
            changedTestPaths,
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
                const surplusEvent = events[surplusIndex];
                if (!['INTERMEDIATE_COMMAND_RUN', 'PROJECT_VALIDATION_RESULTS_EVALUATED'].includes(String(surplusEvent.event_type || '').trim())) {
                    continue;
                }
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
                if (surplusEvent.event_type === 'PROJECT_VALIDATION_RESULTS_EVALUATED') {
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
    return {
        entries,
        warnings,
        latest_task_mode_sequence: latestTaskModeSequence,
        candidate_count: candidateCount,
        rejected_candidate_count: rejectedCandidateCount,
        truncated: scanLimitReached || eligibleCount > entries.length
    };
}
