import * as path from 'node:path';
import type { ValidationAttempt } from '../../core/project-validation-contract';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { isPlainRecord } from '../../core/records';
import { MAX_RETAINED_VALIDATION_OUTPUT_BYTES, readRetainedValidationReports } from '../../core/validation-report-evidence';
import { summarizeValidationResults } from '../../core/project-validation-results';
import { requiredExpectedRedFiles } from '../test-first/expected-red-scope';
import { eligibleExpectedRedRecipes } from '../../core/project-validation-recipes';
import { readTaskQueueEntries } from '../../core/task-queue-read';
import { hasTestFirstExpectedRedDeclaration } from '../test-first/test-first-declaration';
import { getClassificationConfig } from '../preflight/classify-change-config';
import { classifyScopeCategory } from '../preflight/classify-change-scope-category';
import { getTaskModeEvidence } from '../task-mode/task-mode';
import { resolveTaskProfileReviewTriggerPolicy } from '../../policy/task-profile-policy-snapshot';
import { bindContainedDestination, assertExistingPathIdentity } from '../../core/contained-filesystem';
import { withFilesystemLockAsync } from '../../gate-runtime/timeline/task-events-locking';
import { freezeValidationRecipe, validationPaths } from './authority';
import { declaredValidationTestPaths } from './focused';
import { readValidationEvents, readValidationRecipeSnapshot, recordValidationEvent, writeValidationFact,
    type ValidationEvidenceBatch, type ValidationEvidenceInspection } from './attempt-evidence';

export function assertValidationExpectedRed(repoRoot: string, taskId: string, recipeId: string): void {
    readValidationEvents(repoRoot, taskId);
    const snapshot = freezeValidationRecipe(repoRoot, taskId, recipeId);
    const preflight = JSON.parse(readValidationFile(repoRoot, validationPaths(repoRoot, taskId).preflight).bytes.toString('utf8')) as Record<string, unknown>;
    const taskMode = getTaskModeEvidence(repoRoot, taskId);
    if (taskMode.evidence_status !== 'PASS')
        throw new Error(`Expected-red requires authenticated native task profile policy (${taskMode.evidence_status}; ${taskMode.profile_policy_snapshot_status})`);
    const reviewTriggerPolicy = taskMode.profile_policy_snapshot_status === 'PASS' && taskMode.profile_policy_snapshot
        ? resolveTaskProfileReviewTriggerPolicy(taskMode.profile_policy_snapshot) : undefined;
    const config = getClassificationConfig(repoRoot, { reviewTriggerPolicy }), changedFiles = preflight.changed_files as string[];
    const category = classifyScopeCategory(changedFiles, config.code_like_regexes, config.runtime_roots, { testTriggerRegexes: config.test_trigger_regexes,
        declaredTestPaths: [...declaredValidationTestPaths(repoRoot)],
        protectedControlPlaneRoots: config.protected_control_plane_roots, ordinaryDocPaths: config.ordinary_doc_paths,
        sqlOrMigrationRegexes: config.sql_or_migration_regexes, dbTriggerRegexes: config.db_trigger_regexes,
        securityTriggerRegexes: config.security_trigger_regexes, apiTriggerRegexes: config.api_trigger_regexes, dependencyTriggerRegexes: config.dependency_trigger_regexes });
    if (preflight.scope_category !== 'test-only' || category.category !== 'test-only'
        || !hasTestFirstExpectedRedDeclaration(readTaskQueueEntries(repoRoot).get(taskId))) throw new Error('Expected-red requires current native test-only scope and TASK declaration');
    if (!eligibleExpectedRedRecipes([snapshot.recipe], requiredExpectedRedFiles(preflight, repoRoot, config)).some(recipe => recipe.id === recipeId)) throw new Error('Expected-red recipe lacks changed declared test targets');
}
export function readValidationAttemptFacts(repoRoot: string, taskId: string, attemptId: string,
    inspection: ValidationEvidenceInspection = 'active', batch?: ValidationEvidenceBatch, expectedRedHistory = false) {
    const paths = validationPaths(repoRoot, taskId), events = readValidationEvents(repoRoot, taskId, inspection, batch);
    const completed = events.filter(event => event.event_type === 'PROJECT_VALIDATION_COMPLETED' && event.details?.attempt_id === attemptId);
    if (completed.length !== 1) throw new Error('Missing or ambiguous canonical completed attempt');
    const details = completed[0].details!, attemptPath = String(details.artifact_path);
    const file = readValidationFile(repoRoot, attemptPath);
    if (file.identity.sha256 !== details.artifact_sha256) throw new Error('Retained attempt digest changed');
    const attempt = JSON.parse(file.bytes.toString('utf8')) as ValidationAttempt;
    const currentSnapshot = readValidationRecipeSnapshot(repoRoot, taskId, String(details.recipe_id), inspection, batch);
    let snapshot = currentSnapshot;
    if (expectedRedHistory) {
        const evaluated = events.filter(event => event.event_type === 'PROJECT_VALIDATION_RESULTS_EVALUATED'
            && event.details?.attempt_id === attemptId);
        const resultFile = readValidationFile(repoRoot, `${paths.attempts}/${attemptId}/result.json`);
        const result: unknown = JSON.parse(resultFile.bytes.toString('utf8'));
        const cycleStart = events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED');
        const starts = events.filter(event => event.event_type === 'PROJECT_VALIDATION_STARTED' && event.details?.attempt_id === attemptId);
        const { snapshot_sha256: originalHash, ...original } = attempt.snapshot;
        if (evaluated.length !== 1 || resultFile.identity.sha256 !== evaluated[0].details?.artifact_sha256
            || !isPlainRecord(result) || result.expected_failure !== true || !['EXPECTED_FAILURE', 'UNRESOLVED'].includes(String(result.status))
            || starts.length !== 1 || events.indexOf(starts[0]) <= cycleStart || events.indexOf(completed[0]) <= events.indexOf(starts[0])
            || events.indexOf(evaluated[0]) <= events.indexOf(completed[0]) || starts[0].details?.snapshot_sha256 !== originalHash
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
    const starts = events.filter(event => event.event_type === 'PROJECT_VALIDATION_STARTED' && event.details?.attempt_id === attemptId);
    const startSha256 = attempt.report_capture_start_sha256 ?? null;
    if (startSha256 && (starts.length !== 1 || starts[0].details?.report_capture_start_sha256 !== startSha256
        || starts[0].details?.snapshot_sha256 !== snapshot.snapshot_sha256 || starts[0].details?.recipe_id !== snapshot.recipe.id
        || Number(starts[0].integrity?.task_sequence) >= Number(completed[0].integrity?.task_sequence)))
        throw new Error('Report capture lacks the matching native execution start');
    const reports = readRetainedValidationReports({ repoRoot, capture: streams.report_capture, declarations: snapshot.recipe.report_files,
        evidenceDirectory: directory, expectedStartSha256: startSha256, executionViolations: attempt.violations });
    return { events, attempt, snapshot, currentSnapshot, attemptPath, attemptSha256: file.identity.sha256, directory, decoded, reports };
}
export async function evaluateValidationAttempt(options: { repoRoot: string; taskId: string; attemptId: string; expectedFailure?: boolean }) {
    const { repoRoot, taskId, attemptId } = options, paths = validationPaths(repoRoot, taskId);
    const lock = bindContainedDestination(repoRoot, path.join(repoRoot, paths.attempts, '.execution.lock'));
    const locked = await withFilesystemLockAsync(lock.path, {}, async () => {
        assertExistingPathIdentity(lock);
        const { attempt, snapshot, attemptPath, attemptSha256, directory, decoded } = readValidationAttemptFacts(repoRoot, taskId, attemptId);
        if (options.expectedFailure) assertValidationExpectedRed(repoRoot, taskId, snapshot.recipe.id);
        const summary = summarizeValidationResults(snapshot.recipe, attempt, decoded[0].toString('utf8'), options.expectedFailure);
        const result = { schema_version: 1, event_source: 'native-project-validation-result', task_id: taskId, attempt_id: attemptId,
            recipe_id: snapshot.recipe.id, snapshot_sha256: snapshot.snapshot_sha256, attempt_path: attemptPath, attempt_sha256: attemptSha256,
            output_sha256: attempt.output_sha256, source_archive_sha256: attempt.source_archive_sha256, expected_failure: options.expectedFailure === true, ...summary };
        readValidationEvents(repoRoot, taskId);
        if (freezeValidationRecipe(repoRoot, taskId, snapshot.recipe.id).snapshot_sha256 !== snapshot.snapshot_sha256) throw new Error('Validation identities changed during evaluation');
        const resultPath = `${directory}/result.json`, resultSha256 = writeValidationFact(repoRoot, resultPath, JSON.stringify(result));
        await recordValidationEvent(repoRoot, taskId, 'PROJECT_VALIDATION_RESULTS_EVALUATED', { attempt_id: attemptId,
            recipe_id: snapshot.recipe.id, attempt_sha256: attemptSha256, artifact_path: resultPath, artifact_sha256: resultSha256, status: result.status });
        return { ...result, result_path: resultPath, result_sha256: resultSha256 };
    });
    return locked.result;
}
