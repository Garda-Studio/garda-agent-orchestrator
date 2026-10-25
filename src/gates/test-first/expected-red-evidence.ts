import * as path from 'node:path';
import { readTaskQueueEntries } from '../../core/task-queue-read';
import { isPlainRecord } from '../../core/records';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { assertCurrentIntermediateSelection, isIntermediateSelection, latestMatchingIntermediateAttempt } from '../../core/intermediate-selected-cases';
import { readValidationEventSnapshot, type ValidationEvidenceInspection } from '../project-validation/attempt-evidence';
import { readBoundIntermediateCommandEvidence } from '../review/focused-intermediate-evidence';
import { requiredExpectedRedFiles } from './expected-red-scope';
import { readNativeCaseObligations, retainedNativeCaseOutput, type NativeCaseExecution } from '../review/native-case-semantics';
import type { QualityValidationObligation } from '../quality-checklist/quality-checklist-validation-phases';
import { readReportedTestCases, getCurrentIntermediateTestTargets } from '../../cli/commands/gate-flows/command-run/intermediate-command-scope';
import { hasTestFirstExpectedRedDeclaration } from './test-first-declaration';
import { readRecipeExpectedRedObligations } from './expected-red-recipe-evidence';

export interface ExpectedRedExecutionEvidence {
    schema_version: 1;
    task_id: string;
    preflight_sha256: string;
    scope_content_sha256: string;
    obligations: QualityValidationObligation[];
    sha256: string;
}

export function taskRequiresExpectedRed(repoRoot: string, taskId: string): boolean {
    return hasTestFirstExpectedRedDeclaration(readTaskQueueEntries(repoRoot).get(taskId));
}

/** A current execution projection; assertion semantics remain pending the ordinary independent review. */
interface ExpectedRedEvidenceOptions {
    repoRoot: string; taskId: string; preflightPath: string; preflightSha256: string | null;
    inspection?: ValidationEvidenceInspection;
}

function projectExpectedRedExecutions(options: ExpectedRedEvidenceOptions, currentOnly: boolean): ExpectedRedExecutionEvidence | null {
    if (!options.preflightSha256 || !hasTestFirstExpectedRedDeclaration(readTaskQueueEntries(options.repoRoot).get(options.taskId)))
        return null;
    const relative = path.relative(path.resolve(options.repoRoot), path.resolve(options.repoRoot, options.preflightPath)).replace(/\\/gu, '/');
    const retained = readValidationFile(options.repoRoot, relative);
    const preflight: unknown = JSON.parse(retained.bytes.toString('utf8'));
    if (retained.identity.sha256 !== options.preflightSha256 || !isPlainRecord(preflight)
        || preflight.task_id !== options.taskId || currentOnly && preflight.scope_category !== 'test-only') return null;
    const snapshot = readValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection);
    if (snapshot.preflight_sha256 !== options.preflightSha256
        || path.resolve(snapshot.preflight_path) !== path.resolve(options.repoRoot, options.preflightPath)) return null;
    const cycle = snapshot.events.slice(snapshot.events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED') + 1);
    const attempts = cycle.filter(event => ['INTERMEDIATE_COMMAND_RUN', 'INTERMEDIATE_COMMAND_STARTED',
        'TEST_FIRST_EXPECTED_FAILURE_RECORDED'].includes(event.event_type)
        && (!currentOnly || event.details?.preflight_sha256 === snapshot.preflight_sha256
            && Number(event.integrity?.task_sequence) > snapshot.preflight_sequence));
    const redIds = new Set(attempts.filter(event => event.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED')
        .map(event => event.details?.execution_id));
    const redAttempts = attempts.filter(event => event.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'
        || event.event_type === 'INTERMEDIATE_COMMAND_STARTED'
            && (event.details?.expected_failure === true || redIds.has(event.details?.execution_id)));
    const relevantAttempts = currentOnly ? attempts : redAttempts;
    const obligations = new Map<string, QualityValidationObligation>();
    for (const event of [...attempts].reverse()) {
        if (event.event_type !== 'TEST_FIRST_EXPECTED_FAILURE_RECORDED') continue;
        const recordedBinding = event.details?.selected_case_binding;
        const observed = isPlainRecord(recordedBinding) ? recordedBinding.before : undefined;
        if (isIntermediateSelection(observed)) {
            const claims = observed.cases.length ? observed.cases
                : observed.sources.map(source => ({ source: source.path, case_id: undefined }));
            if (!claims.some(claim => snapshot.changed_files.includes(claim.source)
                && latestMatchingIntermediateAttempt(relevantAttempts, claim.source, claim.case_id) === event)) continue;
        }
        const originalScope = String(event.details?.test_scope_sha256 ?? '');
        const { entry, violation } = readBoundIntermediateCommandEvidence({ ...options, event, expectedFailure: true,
            reviewsRoot: path.dirname(snapshot.preflight_path), executionOnly: true,
            expectedPreflightPath: snapshot.preflight_path, expectedPreflightSha256: String(event.details?.preflight_sha256 ?? ''),
            expectedScopeContentSha256: originalScope });
        if (!entry && !currentOnly) throw new Error(`Retained expected-RED execution rejected: ${violation}`);
        if (!entry?.selected_case_binding || !entry.execution_id) continue;
        const selection = entry.selected_case_binding.before;
        const starts = attempts.filter(item => item.event_type === 'INTERMEDIATE_COMMAND_STARTED'
            && item.details?.execution_id === entry.execution_id);
        const start = starts[0];
        if (starts.length !== 1 || Number(start.integrity?.task_sequence) >= entry.event_task_sequence
            || start.details?.command !== entry.command || start.details?.artifact_path !== event.details?.artifact_path
            || validationDigest(start.details?.selected_case_selection) !== validationDigest(selection)
            || validationDigest(start.details?.report_evidence ?? null) !== validationDigest(entry.report_evidence ?? null)) continue;
        const execution: NativeCaseExecution = { record_path: entry.artifact_path, record_sha256: entry.artifact_sha256,
            output_path: entry.output_artifact_path, output_sha256: entry.output_artifact_sha256,
            output_size_bytes: entry.output_artifact_size_bytes, output_encoding: entry.output_encoding ?? 'utf8',
            event_task_sequence: entry.event_task_sequence, scope_content_sha256: originalScope,
            expected_failure: true, exit_code: entry.exit_code,
            ...(entry.report_evidence ? { report_evidence: entry.report_evidence } : {}) };
        let cases = selection.cases;
        if (!cases.length) {
            const sources = getCurrentIntermediateTestTargets(options.repoRoot, entry.command, snapshot.changed_files, selection);
            const reported = readReportedTestCases(retainedNativeCaseOutput(options.repoRoot, execution).text);
            if (sources.length !== 1 || !reported?.length) continue;
            cases = reported.map(item => ({ source: sources[0], case_id: item.id, selector: item.id }));
        }
        for (const claim of cases) {
            if (!snapshot.changed_files.includes(claim.source)
                || latestMatchingIntermediateAttempt(relevantAttempts, claim.source, claim.case_id) !== event) continue;
            assertCurrentIntermediateSelection(options.repoRoot, entry.selected_case_binding, [claim.source]);
            const source = selection.sources.find(item => item.path === claim.source);
            if (!source) throw new Error('Expected-red selected source was not observed before execution.');
            const key = JSON.stringify([source.path, claim.case_id]);
            const binding = { task_id: options.taskId, preflight_sha256: snapshot.preflight_sha256,
                source_identity: source, case_id: claim.case_id, case_execution: execution };
            obligations.set(key, { id: validationDigest(binding), recipe_id: 'native-task-command',
                target_id: claim.case_id, selector: claim.selector, source_identity: source,
                snapshot_sha256: snapshot.preflight_sha256, execution: 'OBSERVED', attempt_id: entry.artifact_sha256,
                result_status: 'UNRESOLVED', result_sha256: null, case_execution: execution });
        }
    }
    const requiredSources = new Set(requiredExpectedRedFiles(preflight, options.repoRoot));
    if (!obligations.size || currentOnly && snapshot.changed_files.some(file => requiredSources.has(file)
        && ![...obligations.values()].some(item => item.source_identity.path === file)))
        return null;
    if (readValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection).timeline_sha256 !== snapshot.timeline_sha256)
        throw new Error('Expected-red timeline changed during evidence projection.');
    const value = { schema_version: 1 as const, task_id: options.taskId, preflight_sha256: snapshot.preflight_sha256,
        scope_content_sha256: snapshot.scope_content_sha256,
        obligations: [...obligations.values()].sort((left, right) => left.id.localeCompare(right.id)) };
    return { ...value, sha256: validationDigest(value) };
}

/** Capture precedes implementation; semantic acceptance belongs to the ordinary final review. */
export function readExpectedRedExecutionEvidence(options: ExpectedRedEvidenceOptions): ExpectedRedExecutionEvidence | null {
    return projectExpectedRedExecutions(options, true);
}

export function readExpectedRedReviewObligations(options: ExpectedRedEvidenceOptions,
    currentObligations: readonly QualityValidationObligation[] = []): QualityValidationObligation[] {
    const recipeRed = readRecipeExpectedRedObligations(options, currentObligations);
    const red = projectExpectedRedExecutions(options, false);
    if (!red) {
        if (recipeRed.length) return recipeRed;
        throw new Error('Expected-RED evidence for the unchanged selected test sources is missing.');
    }
    const native = readValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection);
    const green = readNativeCaseObligations({ ...options, preflightSha256: native.preflight_sha256,
        scopeContentSha256: native.scope_content_sha256, sources: red.obligations.map(item => ({
            source_identity: item.source_identity, case_id: item.target_id, selector: item.selector, syntax_status: 'UNRESOLVED' })) });
    for (const failed of red.obligations) {
        const passed = green.find(item => item.target_id === failed.target_id
            && validationDigest(item.source_identity) === validationDigest(failed.source_identity));
        if (!passed?.case_execution || passed.case_execution.event_task_sequence <= failed.case_execution!.event_task_sequence)
            throw new Error('Expected-RED requires a later current GREEN for every unchanged selected case.');
    }
    if (readValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection).timeline_sha256 !== native.timeline_sha256)
        throw new Error('Expected-RED/GREEN timeline changed during review projection.');
    return [...red.obligations, ...green, ...recipeRed];
}

export function currentExpectedRedExecutionEvidence(repoRoot: string, taskId: string): ExpectedRedExecutionEvidence | null {
    if (!hasTestFirstExpectedRedDeclaration(readTaskQueueEntries(repoRoot).get(taskId))) return null;
    try {
        const snapshot = readValidationEventSnapshot(repoRoot, taskId);
        return readExpectedRedExecutionEvidence({ repoRoot, taskId, preflightPath: snapshot.preflight_path,
            preflightSha256: snapshot.preflight_sha256 });
    } catch { return null; }
}
