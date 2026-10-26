import type { ValidationAttempt } from '../../core/project-validation-contract';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { isPlainRecord } from '../../core/records';
import { isInvocationReadObservationActive } from '../../core/invocation-read-observation';
import { MAX_RETAINED_VALIDATION_OUTPUT_BYTES, readRetainedValidationReports } from '../../core/validation-report-evidence';
import { readValidationAttemptMultiplicity, type ValidationEventMultiplicity } from '../../gate-runtime/timeline/validation-timeline-query';
import { validationPaths } from './authority';
import { readCurrentValidationSnapshotInBatch, readValidationRecipeSnapshot,
    type ValidationEvidenceBatch, type ValidationEvidenceInspection } from './attempt-evidence';
type ValidationEvent = { event_type: string; details?: Record<string, unknown>; integrity?: { task_sequence?: number } };

// Navigation-only counterpart to the unchanged public full-history reader.
// Every original artifact/authentication/order/bound check below is retained.
export function readCurrentValidationAttemptFacts(repoRoot: string, taskId: string, attemptId: string,
    inspection: ValidationEvidenceInspection = 'active', batch?: ValidationEvidenceBatch, expectedRedHistory = false) {
    if (!isInvocationReadObservationActive()) return null;
    const current = readCurrentValidationSnapshotInBatch(repoRoot, taskId, inspection, batch);
    const multiplicity = readValidationAttemptMultiplicity(current.query, attemptId);
    if (!multiplicity) return null;
    const paths = validationPaths(repoRoot, taskId);
    const projected = (value: ValidationEventMultiplicity): { length: number; [index: number]: ValidationEvent } =>
        ({ length: value.count, 0: value.first?.event as ValidationEvent });
    const completed = projected(multiplicity.completed);
    if (completed.length !== 1) throw new Error('Missing or ambiguous canonical completed attempt');
    const details = completed[0].details!, attemptPath = String(details.artifact_path);
    const file = readValidationFile(repoRoot, attemptPath);
    if (file.identity.sha256 !== details.artifact_sha256) throw new Error('Retained attempt digest changed');
    const attempt = JSON.parse(file.bytes.toString('utf8')) as ValidationAttempt;
    const currentSnapshot = readValidationRecipeSnapshot(repoRoot, taskId, String(details.recipe_id), inspection, batch);
    let snapshot = currentSnapshot;
    if (expectedRedHistory) {
        const evaluated = projected(multiplicity.evaluated);
        const resultFile = readValidationFile(repoRoot, `${paths.attempts}/${attemptId}/result.json`);
        const result: unknown = JSON.parse(resultFile.bytes.toString('utf8'));
        const cycleStart = current.query.modeIndex;
        const starts = projected(multiplicity.started);
        const { snapshot_sha256: originalHash, ...original } = attempt.snapshot;
        if (evaluated.length !== 1 || resultFile.identity.sha256 !== evaluated[0].details?.artifact_sha256
            || !isPlainRecord(result) || result.expected_failure !== true || !['EXPECTED_FAILURE', 'UNRESOLVED'].includes(String(result.status))
            || starts.length !== 1 || (multiplicity.started.first?.ordinal ?? -1) <= cycleStart || (multiplicity.completed.first?.ordinal ?? -1) <= (multiplicity.started.first?.ordinal ?? -1)
            || (multiplicity.evaluated.first?.ordinal ?? -1) <= (multiplicity.completed.first?.ordinal ?? -1) || starts[0].details?.snapshot_sha256 !== originalHash
            || validationDigest(original) !== originalHash || original.authority_sha256 !== currentSnapshot.authority_sha256
            || validationDigest(original.recipe) !== validationDigest(currentSnapshot.recipe)
            || validationDigest(original.tool) !== validationDigest(currentSnapshot.tool)
            || original.inputs.length !== currentSnapshot.inputs.length
            || original.recipe.inputs.some((input, index) => input.role !== 'source'
                && validationDigest(original.inputs[index]) !== validationDigest(currentSnapshot.inputs[index])))
            throw new Error(`Historical expected-RED recipe source, authority or native execution binding changed. Selected sources: ${original.recipe.targets.map(target => target.source).join(', ')}.`);
        snapshot = attempt.snapshot;
    }
    if (attempt.schema_version !== 1 || attempt.attempt_id !== attemptId || attempt.snapshot.task_id !== taskId
        || attempt.snapshot.snapshot_sha256 !== snapshot.snapshot_sha256 || details.snapshot_sha256 !== snapshot.snapshot_sha256
        || attempt.cases !== null || attempt.expected_failure !== false) throw new Error('Foreign or stale execution facts');
    const directory = `${paths.attempts}/${attemptId}`;
    if (attemptPath !== `${directory}/attempt.json` || attempt.output_path !== `${directory}/output.json`
        || attempt.source_archive_path !== `${directory}/sources.json`) throw new Error('Foreign retained attempt paths');
    const output = readValidationFile(repoRoot, attempt.output_path, snapshot.recipe.report_files?.length
        ? MAX_RETAINED_VALIDATION_OUTPUT_BYTES : Math.ceil(snapshot.recipe.max_output_bytes * 4 / 3) + 128);
    if (output.identity.sha256 !== attempt.output_sha256 || output.bytes.length !== attempt.output_bytes
        || readValidationFile(repoRoot, attempt.source_archive_path).identity.sha256 !== attempt.source_archive_sha256) throw new Error('Retained source or output digest changed');
    const streams = JSON.parse(output.bytes.toString('utf8')) as { stdout_base64: string; stderr_base64: string; report_capture?: unknown };
    const decoded = [streams.stdout_base64, streams.stderr_base64].map(value => {
        if (typeof value !== 'string') throw new Error('Invalid retained output stream');
        const bytes = Buffer.from(value, 'base64');
        if (bytes.toString('base64') !== value) throw new Error('Invalid retained output encoding');
        return bytes;
    });
    if (decoded[0].length + decoded[1].length > snapshot.recipe.max_output_bytes) throw new Error('Retained output exceeds frozen budget');
    const starts = projected(multiplicity.started);
    const startSha256 = attempt.report_capture_start_sha256 ?? null;
    if (startSha256 && (starts.length !== 1 || starts[0].details?.report_capture_start_sha256 !== startSha256
        || starts[0].details?.snapshot_sha256 !== snapshot.snapshot_sha256 || starts[0].details?.recipe_id !== snapshot.recipe.id
        || Number(starts[0].integrity?.task_sequence) >= Number(completed[0].integrity?.task_sequence)))
        throw new Error('Report capture lacks the matching native execution start');
    const reports = readRetainedValidationReports({ repoRoot, capture: streams.report_capture, declarations: snapshot.recipe.report_files,
        evidenceDirectory: directory, expectedStartSha256: startSha256, executionViolations: attempt.violations });
    return { timelineQuery: current, multiplicity, attempt, snapshot, currentSnapshot, attemptPath, attemptSha256: file.identity.sha256, directory, decoded, reports };
}
