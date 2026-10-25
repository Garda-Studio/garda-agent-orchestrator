import * as path from 'node:path';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { isCompleteExpectedFailureAttempt } from '../../core/project-validation-results';
import { readValidationResult } from '../project-validation/evidence';
import { readValidationEventSnapshot, type ValidationEvidenceInspection } from '../project-validation/attempt-evidence';
import type { QualityValidationObligation } from '../quality-checklist/quality-checklist-validation-phases';
import type { NativeCaseExecution } from '../review/native-case-semantics';

/** Reuses admitted recipes and their retained executions; it grants no assertion PASS. */
export function readRecipeExpectedRedObligations(options: {
    repoRoot: string; taskId: string; inspection?: ValidationEvidenceInspection;
}, current: readonly QualityValidationObligation[]): QualityValidationObligation[] {
    const native = readValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection);
    const cycle = native.events.slice(native.events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED') + 1);
    const starts = new Map(cycle.filter(event => event.event_type === 'PROJECT_VALIDATION_STARTED')
        .map(event => [event.details?.attempt_id, Number(event.integrity?.task_sequence)]));
    const results = cycle.filter(event => event.event_type === 'PROJECT_VALIDATION_RESULTS_EVALUATED')
        .sort((left, right) => (starts.get(right.details?.attempt_id) ?? Infinity) - (starts.get(left.details?.attempt_id) ?? Infinity)
            || Number(right.integrity?.task_sequence) - Number(left.integrity?.task_sequence));
    const seen = new Set<string>(), obligations: QualityValidationObligation[] = [];
    for (const event of results) {
        const retained = readValidationFile(options.repoRoot, String(event.details?.artifact_path));
        if (retained.identity.sha256 !== event.details?.artifact_sha256) throw new Error('Expected-RED result digest changed.');
        const recorded = JSON.parse(retained.bytes.toString('utf8')) as Record<string, unknown>;
        if (recorded.expected_failure !== true || seen.has(String(recorded.recipe_id))) continue;
        seen.add(String(recorded.recipe_id));
        const { attempt, result, snapshot } = readValidationResult({ ...options,
            attemptId: String(event.details?.attempt_id), expectedRedHistory: true });
        if (!isCompleteExpectedFailureAttempt(attempt)) throw new Error('Expected-RED recipe lacks a complete nonzero execution.');
        const start = cycle.find(item => item.event_type === 'PROJECT_VALIDATION_STARTED' && item.details?.attempt_id === attempt.attempt_id)!;
        const classified = cycle.filter(item => item.event_type === 'PREFLIGHT_CLASSIFIED'
            && Number(item.integrity?.task_sequence) < Number(start.integrity?.task_sequence)).at(-1);
        const execution: NativeCaseExecution = { record_path: result.attempt_path, record_sha256: result.attempt_sha256,
            output_path: attempt.output_path, output_sha256: attempt.output_sha256, output_size_bytes: attempt.output_bytes,
            output_encoding: 'base64-streams', event_task_sequence: Number(event.integrity?.task_sequence),
            scope_content_sha256: String(classified?.details?.scope_content_sha256 ?? ''), expected_failure: true, exit_code: attempt.exit_code,
            ...(attempt.report_capture_start_sha256 ? { report_evidence: { declarations: snapshot.recipe.report_files!,
                start_sha256: attempt.report_capture_start_sha256, evidence_directory: path.posix.dirname(attempt.output_path) } } : {}) };
        for (const target of snapshot.recipe.targets) {
            const source = snapshot.inputs.find(input => input.path === target.source);
            const green = current.find(item => item.recipe_id === snapshot.recipe.id && item.target_id === target.id);
            if (!source || !green || green.execution !== 'OBSERVED' || green.case_execution?.expected_failure
                || !['PASSED', 'UNRESOLVED'].includes(green.result_status ?? '')
                || validationDigest(green.source_identity) !== validationDigest(source)
                || green.case_execution && green.case_execution.event_task_sequence <= execution.event_task_sequence)
                throw new Error('Expected-RED requires current GREEN for every unchanged declared recipe target.');
            const latestStart = cycle.filter(item => item.event_type === 'PROJECT_VALIDATION_STARTED'
                && item.details?.recipe_id === snapshot.recipe.id).at(-1);
            if (latestStart?.details?.attempt_id !== green.attempt_id
                || Number(latestStart.integrity?.task_sequence) <= execution.event_task_sequence)
                throw new Error('Expected-RED recipe GREEN is superseded or precedes the failure.');
            const binding = { recipe_id: snapshot.recipe.id, target_id: target.id, selector: target.selector,
                source_identity: source, snapshot_sha256: snapshot.snapshot_sha256, case_execution: execution };
            obligations.push({ id: validationDigest(binding), ...binding, execution: 'OBSERVED', attempt_id: attempt.attempt_id,
                result_status: 'UNRESOLVED', result_sha256: result.result_sha256 });
        }
    }
    if (readValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection).timeline_sha256 !== native.timeline_sha256)
        throw new Error('Expected-RED recipe timeline changed during projection.');
    return obligations;
}

/** Read-only diagnostic; it grants no acceptance or GREEN semantics. */
export function readRetainedRecipeExpectedRedRejection(options: {
    repoRoot: string; taskId: string; inspection?: ValidationEvidenceInspection;
}): string | null {
    try {
        const native = readValidationEventSnapshot(options.repoRoot, options.taskId, options.inspection);
        const starts = new Map(native.events.filter(event => event.event_type === 'PROJECT_VALIDATION_STARTED')
            .map(event => [event.details?.attempt_id, Number(event.integrity?.task_sequence)]));
        const results = native.events.filter(event => event.event_type === 'PROJECT_VALIDATION_RESULTS_EVALUATED')
            .sort((left, right) => (starts.get(right.details?.attempt_id) ?? Infinity) - (starts.get(left.details?.attempt_id) ?? Infinity)
                || Number(right.integrity?.task_sequence) - Number(left.integrity?.task_sequence));
        const seen = new Set<string>();
        for (const event of results) {
            const retained = readValidationFile(options.repoRoot, String(event.details?.artifact_path));
            if (retained.identity.sha256 !== event.details?.artifact_sha256)
                return `Retained expected-RED recipe result digest changed. Selected sources: ${native.changed_files.join(', ')}.`;
            const result = JSON.parse(retained.bytes.toString('utf8')) as Record<string, unknown>;
            if (result.expected_failure !== true || seen.has(String(result.recipe_id))) continue;
            seen.add(String(result.recipe_id));
            try {
                readValidationResult({ ...options, attemptId: String(event.details?.attempt_id), expectedRedHistory: true });
            } catch (error) {
                return `${String(error)} Current selected sources: ${native.changed_files.join(', ')}. RED from before task re-entry cannot be retained.`;
            }
        }
        return null;
    } catch (error) { return `Retained expected-RED recipe cannot be inspected: ${String(error)}`; }
}
