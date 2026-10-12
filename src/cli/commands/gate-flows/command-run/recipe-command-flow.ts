import * as path from 'node:path';
import { executeValidationRecipe } from '../../../../gates/project-validation/execution';
import { assertValidationExpectedRed, evaluateValidationAttempt } from '../../../../gates/project-validation/result-evaluation';
import { EXIT_GATE_FAILURE, EXIT_SUCCESS } from '../../../exit-codes';
import type { RunIntermediateCommandOptions } from './command-run-flow';

export async function runRecipeCommand(options: RunIntermediateCommandOptions) {
    for (const key of ['command', 'commandSource', 'artifactPath', 'outputPath', 'timeoutMs', 'preflightPath', 'preflightSha256', 'coverageContractSha256', 'eventsRoot'] as const) {
        if (options[key] !== undefined) throw new Error(`Recipe mode forbids '${key}' overrides`);
    }
    if (typeof options.taskId !== 'string' || !options.taskId.trim() || typeof options.recipeId !== 'string' || !options.recipeId.trim()) throw new Error('Recipe mode requires task and recipe identities');
    if (options.expectFailure !== undefined && typeof options.expectFailure !== 'boolean') throw new Error('Invalid expected-failure option');
    const repoRoot = path.resolve(typeof options.repoRoot === 'string' ? options.repoRoot : process.cwd()), taskId = options.taskId;
    const expectedFailure = options.expectFailure === true;
    if (expectedFailure) assertValidationExpectedRed(repoRoot, taskId, options.recipeId);
    const attempt = await executeValidationRecipe({ repoRoot, taskId, recipeId: options.recipeId, signal: options.signal });
    const result = await evaluateValidationAttempt({ repoRoot, taskId, attemptId: attempt.attempt_id, expectedFailure });
    return { exitCode: result.status === 'PASSED' || result.status === 'EXPECTED_FAILURE' ? EXIT_SUCCESS : EXIT_GATE_FAILURE,
        outputLines: [`PROJECT_VALIDATION_${result.status}`, `RecipeId: ${result.recipe_id}`, `AttemptId: ${attempt.attempt_id}`,
            `ResultPath: ${result.result_path}`, `ResultSha256: ${result.result_sha256}`, `ExitCode: ${attempt.exit_code}`] };
}
