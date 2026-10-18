import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnStreamed, type SpawnStreamedResult } from '../../core/process/subprocess';
import { assertContainedDestination, assertExistingPathIdentity, bindContainedDestination, ensureContainedDirectory } from '../../core/contained-filesystem';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { prepareValidationReportCapture, completeValidationReportCapture } from '../../core/validation-report-capture';
import type { ValidationReportCapture } from '../../core/validation-report-contract';
import type { FrozenValidationRecipe, ValidationAttempt } from '../../core/project-validation-contract';
import { withFilesystemLockAsync } from '../../gate-runtime/timeline/task-events-locking';
import { freezeValidationRecipe, validationPaths } from './authority';
import { readValidationEvents, recordValidationEvent, writeValidationFact } from './attempt-evidence';

function assertCurrent(repoRoot: string, snapshot: FrozenValidationRecipe): void {
    readValidationEvents(repoRoot, snapshot.task_id);
    if (freezeValidationRecipe(repoRoot, snapshot.task_id, snapshot.recipe.id).snapshot_sha256 !== snapshot.snapshot_sha256) throw new Error('Validation identities changed during execution');
}
function archiveSources(repoRoot: string, snapshot: FrozenValidationRecipe): string {
    return JSON.stringify(snapshot.inputs.map(input => {
        const file = readValidationFile(repoRoot, input.path, snapshot.recipe.max_input_bytes);
        if (JSON.stringify(file.identity) !== JSON.stringify(input)) throw new Error('Source changed while retaining validation snapshot');
        return { path: input.path, sha256: input.sha256, content_base64: file.bytes.toString('base64') };
    }));
}
function retainOutput(repoRoot: string, relative: string, result: SpawnStreamedResult | undefined, budget: number,
    reports: ValidationReportCapture | null) {
    const stdout = Buffer.from(result?.stdout ?? '').subarray(0, budget);
    const stderr = Buffer.from(result?.stderr ?? '').subarray(0, budget - stdout.length);
    const content = JSON.stringify({ stdout_base64: stdout.toString('base64'), stderr_base64: stderr.toString('base64'),
        ...(reports ? { report_capture: reports } : {}) });
    return { output_sha256: writeValidationFact(repoRoot, relative, content), output_bytes: Buffer.byteLength(content),
        truncated: !result || result.stdoutTruncated || result.stderrTruncated || result.stdoutOriginalBytes + result.stderrOriginalBytes > budget };
}
async function runAttempt(repoRoot: string, snapshot: FrozenValidationRecipe, signal?: AbortSignal): Promise<ValidationAttempt> {
    const { recipe, task_id: taskId } = snapshot, paths = validationPaths(repoRoot, taskId), attemptId = randomUUID();
    const relative = `${paths.attempts}/${attemptId}`, directory = path.join(repoRoot, relative);
    const reservation = bindContainedDestination(repoRoot, directory);
    if (!reservation.missingAt) throw new Error('Validation attempt directory is already reserved');
    assertContainedDestination(reservation); fs.mkdirSync(directory);
    const ownedDirectory = bindContainedDestination(repoRoot, directory);
    const sourceArchivePath = `${relative}/sources.json`, outputPath = `${relative}/output.json`;
    const sourceArchiveSha256 = writeValidationFact(repoRoot, sourceArchivePath, archiveSources(repoRoot, snapshot));
    const cwd = path.resolve(repoRoot, recipe.cwd), cwdBinding = bindContainedDestination(repoRoot, cwd);
    if (!fs.lstatSync(cwd).isDirectory()) throw new Error('Validation cwd must be a contained directory');
    assertCurrent(repoRoot, snapshot);
    const reportStart = prepareValidationReportCapture(repoRoot, recipe.report_files,
        { evidenceDirectory: relative, excludedPaths: snapshot.inputs.map(input => input.path),
            excludedRoots: [`${paths.bundle}/runtime/reviews`, `${paths.bundle}/runtime/task-events`] });
    const reportStartBinding = reportStart ? { report_capture_start_sha256: validationDigest(reportStart) } : {};
    const started = Date.now();
    await recordValidationEvent(repoRoot, taskId, 'PROJECT_VALIDATION_STARTED',
        { attempt_id: attemptId, recipe_id: recipe.id, snapshot_sha256: snapshot.snapshot_sha256, ...reportStartBinding });
    const violations: string[] = []; let result: SpawnStreamedResult | undefined;
    try {
        assertCurrent(repoRoot, snapshot); assertExistingPathIdentity(cwdBinding);
        const argv = recipe.argv.map(arg => typeof arg === 'string' ? arg : recipe.targets.find(target => target.id === arg.target)!.selector);
        result = await spawnStreamed(snapshot.tool.path, argv, { cwd, signal, env: recipe.environment, envMode: 'replace',
            timeoutMs: recipe.timeout_ms, maxBuffer: recipe.max_output_bytes,
            capturePolicy: { mode: 'full-buffer', maxBytes: recipe.max_output_bytes } });
    } catch (error) { violations.push(String(error)); }
    const reports = completeValidationReportCapture(repoRoot, reportStart);
    violations.push(...reports?.violations ?? []);
    try { assertCurrent(repoRoot, snapshot); assertExistingPathIdentity(cwdBinding); } catch (error) { violations.push(String(error)); }
    assertExistingPathIdentity(ownedDirectory);
    if (readValidationFile(repoRoot, sourceArchivePath).identity.sha256 !== sourceArchiveSha256) throw new Error('Retained source archive changed during execution');
    const completedAt = new Date().toISOString();
    const attempt: ValidationAttempt = { schema_version: 1, attempt_id: attemptId, snapshot, started_at: new Date(started).toISOString(),
        completed_at: completedAt, duration_ms: Date.now() - started, exit_code: result?.exitCode ?? -1,
        termination_signal: result?.terminationSignal ?? null, timed_out: result?.timedOut ?? false, cancelled: result?.cancelled ?? false,
        output_path: outputPath, ...retainOutput(repoRoot, outputPath, result, recipe.max_output_bytes, reports), ...reportStartBinding,
        source_archive_path: sourceArchivePath, source_archive_sha256: sourceArchiveSha256, cases: null, violations, expected_failure: false };
    const artifactPath = `${relative}/attempt.json`, artifactSha256 = writeValidationFact(repoRoot, artifactPath, JSON.stringify(attempt));
    await recordValidationEvent(repoRoot, taskId, 'PROJECT_VALIDATION_COMPLETED', { attempt_id: attemptId, recipe_id: recipe.id,
        snapshot_sha256: snapshot.snapshot_sha256, artifact_path: artifactPath, artifact_sha256: artifactSha256 });
    return attempt;
}

export async function executeValidationRecipe(options: { repoRoot: string; taskId: string; recipeId: string; signal?: AbortSignal }): Promise<ValidationAttempt> {
    const { repoRoot, taskId, recipeId } = options, paths = validationPaths(repoRoot, taskId);
    const directory = path.join(repoRoot, paths.attempts); ensureContainedDirectory(repoRoot, directory);
    const lock = bindContainedDestination(repoRoot, path.join(directory, '.execution.lock'));
    const locked = await withFilesystemLockAsync(lock.path, {}, async () => {
        assertExistingPathIdentity(lock);
        const events = readValidationEvents(repoRoot, taskId), snapshot = freezeValidationRecipe(repoRoot, taskId, recipeId);
        if (snapshot.recipe.required_capabilities.length) throw new Error(`No enforcing provider is installed for: ${snapshot.recipe.required_capabilities.join(', ')}. Local hashes are not capability attestation.`);
        const used = events.filter(event => event.event_type === 'PROJECT_VALIDATION_STARTED' && event.details?.recipe_id === recipeId).length;
        if (used >= snapshot.recipe.max_attempts) throw new Error('Frozen recipe attempt budget exhausted');
        return runAttempt(repoRoot, snapshot, options.signal);
    });
    return locked.result;
}
