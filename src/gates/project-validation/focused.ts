import { quoteCommandValue } from '../../core/command-quoting';
import { isPlainRecord } from '../../core/records';
import type { FrozenValidationRecipe } from '../../core/project-validation-contract';
import { freezeValidationRecipe, readProjectValidationAuthority } from './authority';
import { readValidationEvents } from './attempt-evidence';
import { readValidationResult } from './evidence';
import type { TaskAuditEvent } from '../task-audit/task-audit-summary-lifecycle';
import type { FocusedIntermediateEvidenceEntry } from '../review/focused-intermediate-evidence';

function invocation(snapshot: Pick<FrozenValidationRecipe, 'tool' | 'recipe'>): string[] {
    return [snapshot.tool.path, ...snapshot.recipe.argv.map(argument => typeof argument === 'string'
        ? argument : snapshot.recipe.targets.find(target => target.id === argument.target)!.selector)];
}
function focusedTarget(snapshot: FrozenValidationRecipe): string {
    const sources = [...new Set(snapshot.recipe.targets.map(target => target.source))];
    if (!['test', 'validation'].includes(snapshot.recipe.purpose) || sources.length !== 1
        || !snapshot.recipe.inputs.some(input => input.path === sources[0] && input.role === 'test'))
        throw new Error('Recipe must name one declared test source; no first-input fallback');
    return sources[0];
}
export function declaredValidationTestPaths(repoRoot: string): Set<string> {
    return new Set(readProjectValidationAuthority(repoRoot)?.approved.contract.recipes
        .flatMap(recipe => recipe.inputs.filter(input => input.role === 'test').map(input => input.path)) ?? []);
}
function latestRecipeAttemptEvent(repoRoot: string, taskId: string, recipeId: string) {
    const events = readValidationEvents(repoRoot, taskId);
    for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index];
        if (event.details?.recipe_id === recipeId && ['PROJECT_VALIDATION_STARTED', 'PROJECT_VALIDATION_COMPLETED',
            'PROJECT_VALIDATION_RESULTS_EVALUATED'].includes(event.event_type)) return event;
    }
    return undefined;
}
export function inspectRecipeFocusedCommand(repoRoot: string, taskId: string, tokens: string[]) {
    try {
        const authority = readProjectValidationAuthority(repoRoot);
        if (!authority) return null;
        const matches = authority.approved.contract.recipes.filter(recipe => JSON.stringify(invocation({ recipe,
            tool: authority.approved.tools[recipe.id] })) === JSON.stringify(tokens));
        if (matches.length !== 1) throw new Error('Command must match exactly one current admitted recipe');
        const snapshot = freezeValidationRecipe(repoRoot, taskId, matches[0].id), target = focusedTarget(snapshot);
        if (snapshot.recipe.cwd !== '.' || Object.keys(snapshot.recipe.environment).length !== 0)
            throw new Error('Bare command omits recipe cwd or environment; use the authenticated retained recipe result');
        const event = latestRecipeAttemptEvent(repoRoot, taskId, snapshot.recipe.id);
        const status = event?.event_type === 'PROJECT_VALIDATION_RESULTS_EVALUATED'
            ? readValidationResult({ repoRoot, taskId, attemptId: String(event.details?.attempt_id) }).result.status : null;
        return { target, status, violations: [] as string[] };
    } catch (error) {
        return { target: null, status: null, violations: [String(error)] };
    }
}
export function readFocusedRecipeEntry(options: {
    repoRoot: string; taskId: string; event: TaskAuditEvent; expectedPreflightSha256?: string | null;
}): { entry: FocusedIntermediateEvidenceEntry | null; violation: string | null } {
    try {
        const details = isPlainRecord(options.event.details) ? options.event.details : {};
        const integrity = isPlainRecord(options.event.integrity) ? options.event.integrity : {};
        if (typeof integrity.task_sequence !== 'number' || !Number.isInteger(integrity.task_sequence))
            throw new Error('Recipe result requires a canonical task sequence');
        const { snapshot, attempt, result } = readValidationResult({ repoRoot: options.repoRoot, taskId: options.taskId,
            attemptId: String(details.attempt_id) });
        const target = focusedTarget(snapshot);
        if (result.status !== 'PASSED' || attempt.exit_code !== 0
            || (options.expectedPreflightSha256 && snapshot.preflight_sha256 !== options.expectedPreflightSha256))
            throw new Error(`Recipe result is not current focused PASS: ${result.status}`);
        const latest = latestRecipeAttemptEvent(options.repoRoot, options.taskId, snapshot.recipe.id);
        if (latest?.details?.attempt_id !== attempt.attempt_id) throw new Error('Historical recipe result is superseded');
        return { entry: { command_source: 'project-recipe', command: invocation(snapshot).map(quoteCommandValue).join(' '),
            recipe_context: { cwd: snapshot.recipe.cwd, environment: snapshot.recipe.environment },
            status: 'PASSED', exit_code: 0, preflight_path: null, preflight_sha256: snapshot.preflight_sha256,
            coverage_contract_sha256: null, event_timestamp_utc: String(options.event.timestamp_utc),
            event_task_sequence: integrity.task_sequence, artifact_path: result.result_path,
            artifact_sha256: result.result_sha256, output_artifact_path: attempt.output_path,
            output_artifact_sha256: attempt.output_sha256, output_artifact_size_bytes: attempt.output_bytes,
            focused_test_paths: [target] }, violation: null };
    } catch (error) {
        return { entry: null, violation: String(error) };
    }
}
