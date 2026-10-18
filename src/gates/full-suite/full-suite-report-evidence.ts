import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPlainRecord } from '../../core/records';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { prepareValidationReportCapture, completeValidationReportCapture } from '../../core/validation-report-capture';
import { parseValidationReportFiles, type ValidationReportCaptureStart, type ValidationReportEvidenceBinding } from '../../core/validation-report-contract';
import { MAX_RETAINED_VALIDATION_OUTPUT_BYTES, parseValidationReportEvidenceBinding, readRetainedValidationReports } from '../../core/validation-report-evidence';
import { FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX } from '../../core/workflow-config';
import { readTaskQueueEntries } from '../../core/task-queue-read';
import { readTaskQueueStatusToken } from '../../core/task-queue/task-queue-status';
import { appendMandatoryTaskEventAsync } from '../../gate-runtime/task-events-io';
import { readValidationEventSnapshot, writeValidationFact } from '../project-validation/attempt-evidence';
import { joinOrchestratorPath, normalizePath } from '../shared/helpers';

export interface FullSuiteReportAttempt {
    attempt_id: string;
    attempt: number;
    scope_content_sha256: string;
    report_evidence: ValidationReportEvidenceBinding;
    output_path: string;
    output_sha256: string;
    output_bytes: number;
    violations: string[];
}

interface StartedFullSuiteReports {
    start: ValidationReportCaptureStart;
    repoRoot: string;
    taskId: string;
    reference: Omit<FullSuiteReportAttempt, 'output_sha256' | 'output_bytes' | 'violations'>;
}

export async function startFullSuiteReports(options: {
    repoRoot: string; taskId: string; reviewsRoot: string; eventsRoot: string; command: string;
    declarations: unknown; attempt: number; changedFiles: readonly string[];
}): Promise<StartedFullSuiteReports | null> {
    const declarations = parseValidationReportFiles(options.declarations);
    if (!declarations.length) return null;
    const snapshot = readValidationEventSnapshot(options.repoRoot, options.taskId);
    const attemptId = randomUUID();
    const directory = normalizePath(path.relative(options.repoRoot,
        path.join(options.reviewsRoot, `${options.taskId}-full-suite-reports`, attemptId)));
    const start = prepareValidationReportCapture(options.repoRoot, declarations,
        { evidenceDirectory: directory, excludedPaths: options.changedFiles,
            excludedRoots: [options.reviewsRoot, options.eventsRoot].map(root =>
                normalizePath(path.relative(options.repoRoot, path.resolve(options.repoRoot, root)))) })!;
    const reportEvidence = { declarations, start_sha256: validationDigest(start), evidence_directory: directory };
    const reference = { attempt_id: attemptId, attempt: options.attempt, scope_content_sha256: snapshot.scope_content_sha256,
        report_evidence: reportEvidence, output_path: `${directory}/output.json` };
    await appendMandatoryTaskEventAsync(joinOrchestratorPath(options.repoRoot, ''), options.taskId,
        'FULL_SUITE_REPORT_STARTED', 'STARTED', 'Declared full-suite report observation started.',
        { ...reference, command: options.command }, { actor: 'gate', eventsRoot: options.eventsRoot });
    return { start, repoRoot: options.repoRoot, taskId: options.taskId, reference };
}

export function completeFullSuiteReports(started: StartedFullSuiteReports | null): FullSuiteReportAttempt | null {
    if (!started) return null;
    const capture = completeValidationReportCapture(started.repoRoot, started.start)!;
    const violations = [...capture.violations];
    try {
        if (readValidationEventSnapshot(started.repoRoot, started.taskId).scope_content_sha256 !== started.reference.scope_content_sha256)
            violations.push('Full-suite source scope changed while producing report evidence.');
    } catch (error) { violations.push(`Full-suite report source observation failed: ${String(error)}`); }
    const output = JSON.stringify({ report_capture: capture });
    return { ...started.reference, output_sha256: writeValidationFact(started.repoRoot, started.reference.output_path, output),
        output_bytes: Buffer.byteLength(output), violations };
}

export function inspectFullSuiteReports(options: {
    repoRoot: string; taskId: string; reviewsRoot: string; artifact: Record<string, unknown>; declarations: unknown;
}): { attempts: FullSuiteReportAttempt[]; texts: string[] } {
    const declarations = parseValidationReportFiles(options.declarations);
    const rawAttempts = options.artifact.report_attempts;
    if (!declarations.length && rawAttempts === undefined) return { attempts: [], texts: [] };
    if (!Array.isArray(rawAttempts) || rawAttempts.length < 1 || rawAttempts.length > FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX + 1)
        throw new Error('Required full-suite report attempts are missing or unbounded.');
    const completed = readTaskQueueStatusToken(readTaskQueueEntries(options.repoRoot).get(options.taskId)?.status ?? null) === 'DONE';
    const snapshot = readValidationEventSnapshot(options.repoRoot, options.taskId, completed ? 'retained_completed' : 'active');
    const terminals = snapshot.events.filter(event => /^FULL_SUITE_VALIDATION_(?:PASSED|WARNED|FAILED)$/u.test(event.event_type));
    const terminal = terminals.at(-1);
    if (!terminal || terminal.details?.command !== options.artifact.command
        || validationDigest(terminal.details?.report_attempts ?? null) !== validationDigest(rawAttempts))
        throw new Error('Full-suite report attempts lack matching native terminal evidence.');
    if (snapshot.events.some(event => event.event_type === 'FULL_SUITE_REPORT_STARTED'
        && Number(event.integrity?.task_sequence) > Number(terminal.integrity?.task_sequence)))
        throw new Error('A newer unfinished full-suite report attempt supersedes the retained completion.');
    const seen = new Set<string>();
    const results = rawAttempts.map((raw, index) => {
        if (!isPlainRecord(raw) || Object.keys(raw).some(key => !['attempt_id', 'attempt', 'scope_content_sha256',
            'report_evidence', 'output_path', 'output_sha256', 'output_bytes', 'violations'].includes(key))
            || typeof raw.attempt_id !== 'string' || !/^[a-f0-9-]{36}$/u.test(raw.attempt_id) || seen.has(raw.attempt_id)
            || raw.attempt !== index + 1 || raw.scope_content_sha256 !== snapshot.scope_content_sha256
            || typeof raw.output_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.output_sha256)
            || !Number.isSafeInteger(raw.output_bytes) || Number(raw.output_bytes) < 0
            || !Array.isArray(raw.violations) || raw.violations.length > 34 || raw.violations.some(value => typeof value !== 'string'))
            throw new Error('Full-suite report attempt is malformed, stale or duplicated.');
        seen.add(raw.attempt_id);
        const directory = normalizePath(path.relative(options.repoRoot,
            path.join(options.reviewsRoot, `${options.taskId}-full-suite-reports`, raw.attempt_id)));
        const binding = parseValidationReportEvidenceBinding(raw.report_evidence, directory);
        if (validationDigest(binding.declarations) !== validationDigest(declarations) || raw.output_path !== `${directory}/output.json`)
            throw new Error('Full-suite report declaration or retained path changed.');
        const starts = snapshot.events.filter(event => event.event_type === 'FULL_SUITE_REPORT_STARTED'
            && event.details?.attempt_id === raw.attempt_id);
        const start = starts[0];
        if (starts.length !== 1 || start.details?.command !== options.artifact.command
            || start.details?.attempt !== raw.attempt || start.details?.scope_content_sha256 !== raw.scope_content_sha256
            || start.details?.output_path !== raw.output_path
            || validationDigest(start.details?.report_evidence ?? null) !== validationDigest(binding)
            || Number(start.integrity?.task_sequence) >= Number(terminal.integrity?.task_sequence))
            throw new Error('Full-suite report attempt lacks its authenticated prior start.');
        const output = readValidationFile(options.repoRoot, String(raw.output_path), MAX_RETAINED_VALIDATION_OUTPUT_BYTES);
        if (output.identity.sha256 !== raw.output_sha256 || output.bytes.length !== raw.output_bytes)
            throw new Error('Retained full-suite report output changed.');
        const envelope: unknown = JSON.parse(output.bytes.toString('utf8'));
        if (!isPlainRecord(envelope) || Object.keys(envelope).some(key => key !== 'report_capture'))
            throw new Error('Full-suite report capture envelope is malformed.');
        const reports = readRetainedValidationReports({ repoRoot: options.repoRoot, capture: envelope.report_capture,
            declarations, expectedStartSha256: binding.start_sha256, evidenceDirectory: directory,
            executionViolations: raw.violations as string[] });
        return { attempt: { ...raw, report_evidence: binding } as unknown as FullSuiteReportAttempt, texts: reports.texts };
    });
    if (['PASSED', 'WARNED'].includes(String(options.artifact.status)) && results.at(-1)!.attempt.violations.length)
        throw new Error('Failed declared reports cannot become accepted full-suite evidence.');
    return { attempts: results.map(result => result.attempt), texts: results.at(-1)!.texts };
}
