import { readCurrentValidationAttemptFacts } from './current-attempt-facts';
import { readCurrentValidationSnapshot } from './attempt-evidence';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { isPlainRecord } from '../../core/records';
import { freezeValidationRecipe } from './authority';
import { readValidationEvents, type ValidationEvidenceBatch, type ValidationEvidenceInspection } from './attempt-evidence';
import { readValidationAttemptFacts, type evaluateValidationAttempt } from './result-evaluation';

type ValidationResult = Awaited<ReturnType<typeof evaluateValidationAttempt>>;

export function readValidationResult(options: { repoRoot: string; taskId: string; attemptId: string;
    inspection?: ValidationEvidenceInspection; batch?: ValidationEvidenceBatch; expectedRedHistory?: true }) {
    const { repoRoot, taskId, attemptId } = options;
    const facts = readCurrentValidationAttemptFacts(repoRoot, taskId, attemptId, options.inspection, options.batch, options.expectedRedHistory)
        ?? readValidationAttemptFacts(repoRoot, taskId, attemptId, options.inspection, options.batch, options.expectedRedHistory),
        { snapshot, currentSnapshot, attempt } = facts;
    const evaluated = 'timelineQuery' in facts
        ? { length: facts.multiplicity.evaluated.count, 0: facts.multiplicity.evaluated.first?.event as {
            details?: Record<string, unknown> } }
        : facts.events.filter(event => event.event_type === 'PROJECT_VALIDATION_RESULTS_EVALUATED' && event.details?.attempt_id === attemptId);
    if (evaluated.length !== 1) throw new Error('Missing or ambiguous canonical validation result');
    const details = evaluated[0].details!, resultPath = `${facts.directory}/result.json`;
    if (details.artifact_path !== resultPath) throw new Error('Foreign retained validation result path');
    const file = readValidationFile(repoRoot, resultPath);
    if (file.identity.sha256 !== details.artifact_sha256) throw new Error('Retained validation result digest changed');
    const record: unknown = JSON.parse(file.bytes.toString('utf8'));
    if (!isPlainRecord(record) || record.schema_version !== 1 || record.event_source !== 'native-project-validation-result'
        || record.task_id !== taskId || record.attempt_id !== attemptId || record.recipe_id !== snapshot.recipe.id
        || record.snapshot_sha256 !== snapshot.snapshot_sha256 || record.attempt_path !== facts.attemptPath
        || record.attempt_sha256 !== facts.attemptSha256 || record.output_sha256 !== attempt.output_sha256
        || record.source_archive_sha256 !== attempt.source_archive_sha256 || details.recipe_id !== record.recipe_id
        || details.attempt_sha256 !== record.attempt_sha256 || details.status !== record.status
        || typeof record.expected_failure !== 'boolean'
        || !['PASSED', 'FAILED', 'EXPECTED_FAILURE', 'UNEXPECTED_PASS', 'UNRESOLVED'].includes(String(record.status)))
        throw new Error('Foreign or stale validation result binding');
    // A live batch owner revalidates every recipe and the native timeline before returning the combined result.
    if (!options.batch && (freezeValidationRecipe(repoRoot, taskId, snapshot.recipe.id).snapshot_sha256 !== currentSnapshot.snapshot_sha256
        || ('timelineQuery' in facts
            ? readCurrentValidationSnapshot(repoRoot, taskId, options.inspection).timeline_sha256 !== facts.timelineQuery.timeline_sha256
            : validationDigest(readValidationEvents(repoRoot, taskId, options.inspection)) !== validationDigest(facts.events))))
        throw new Error('Validation identities or timeline changed during result inspection');
    return { snapshot, attempt, result: { ...record, result_path: resultPath, result_sha256: file.identity.sha256 } as ValidationResult };
}
