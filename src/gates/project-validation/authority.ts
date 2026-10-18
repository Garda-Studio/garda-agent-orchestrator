import * as path from 'node:path';
import { resolveBundleNameForTarget } from '../../core/constants';
import { bindContainedDestination } from '../../core/contained-filesystem';
import { readValidationFile, readValidationInputs, readValidationTool, validationDigest } from '../../core/project-validation-identity';
import { validationRelativePath } from '../../core/project-validation-recipes';
import type { FrozenValidationRecipe } from '../../core/project-validation-contract';
import { readProjectValidationAuthority } from '../../core/project-validation-authority';
export { readProjectValidationAuthority } from '../../core/project-validation-authority';
import { resolveCurrentNoOpPreflightPath } from '../task-mode/no-op';

const MAXIMUM_CONTROL_BYTES = 8 * 1024 * 1024;

export function validationPaths(repoRoot: string, taskId: string): { bundle: string; preflight: string; attempts: string; timeline: string } {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(taskId)) throw new Error('Invalid validation task identity');
    const bundle = resolveBundleNameForTarget(repoRoot);
    return { bundle, preflight: `${bundle}/runtime/reviews/${taskId}-preflight.json`,
        attempts: `${bundle}/runtime/reviews/project-validation/${taskId}`, timeline: `${bundle}/runtime/task-events/${taskId}.jsonl` };
}
export function freezeProjectValidationAuthority(repoRoot: string): Record<string, string> | undefined {
    return freezeProjectValidationAdmission(repoRoot).binding;
}
export function freezeProjectValidationAdmission(repoRoot: string): {
    binding: Record<string, string> | undefined; declared_test_paths: string[];
} {
    const authority = readProjectValidationAuthority(repoRoot);
    return { binding: authority ? { authority_sha256: authority.sha256, contract_sha256: validationDigest(authority.approved) } : undefined,
        declared_test_paths: authority ? [...new Set(authority.approved.contract.recipes.flatMap(recipe =>
            recipe.inputs.filter(input => input.role === 'test').map(input => input.path)))].sort() : [] };
}
export function currentProjectValidationAuthority(repoRoot: string, preflight: Record<string, unknown>): ReturnType<typeof readProjectValidationAuthority> {
    const authority = readProjectValidationAuthority(repoRoot);
    const frozen = preflight.project_validation as Record<string, unknown> | undefined;
    if (!authority && !frozen) return null;
    if (!authority || !frozen || frozen.authority_sha256 !== authority.sha256 || frozen.contract_sha256 !== validationDigest(authority.approved)) throw new Error('Project validation authority changed; refresh preflight after audited admission');
    return authority;
}
export function freezeValidationRecipe(repoRoot: string, taskId: string, recipeId: string): FrozenValidationRecipe {
    const paths = validationPaths(repoRoot, taskId);
    // Standalone freezing grants no execution authority. Existing native timelines
    // must select their actual current classification rather than a default name.
    const preflightPath = bindContainedDestination(repoRoot, path.resolve(repoRoot, paths.timeline)).missingAt
        ? paths.preflight
        : path.relative(path.resolve(repoRoot), resolveCurrentNoOpPreflightPath(repoRoot, taskId)).replace(/\\/gu, '/');
    const file = readValidationFile(repoRoot, preflightPath, MAXIMUM_CONTROL_BYTES);
    const preflight = JSON.parse(file.bytes.toString('utf8')) as Record<string, unknown>;
    if (preflight.task_id !== taskId) throw new Error('Foreign validation preflight');
    const authority = currentProjectValidationAuthority(repoRoot, preflight);
    if (!authority) throw new Error('No audited project validation authority');
    const recipe = authority.approved.contract.recipes.find((entry) => entry.id === recipeId);
    if (!recipe) throw new Error('Recipe is not in the frozen authority');
    const tool = readValidationTool(recipe.executable);
    if (JSON.stringify(tool) !== JSON.stringify(authority.approved.tools[recipe.id])) throw new Error('Approved executable identity changed');
    const inputs = readValidationInputs(repoRoot, recipe);
    inputs.forEach((identity, index) => {
        const input = recipe.inputs[index];
        if ((input.role === 'helper' || input.role === 'config') && JSON.stringify(identity) !== JSON.stringify(authority.approved.dependencies[input.path])) throw new Error(`Approved dependency changed: ${input.path}`);
    });
    if (!Array.isArray(preflight.changed_files)) throw new Error('Missing validation task scope');
    const scope = preflight.changed_files.map((value) => {
        const relative = validationRelativePath(value);
        const binding = bindContainedDestination(repoRoot, path.resolve(repoRoot, relative));
        return binding.missingAt ? { path: relative, deleted: true } : readValidationFile(repoRoot, relative).identity;
    });
    const snapshot = { schema_version: 1 as const, task_id: taskId, preflight_sha256: file.identity.sha256,
        authority_sha256: authority.sha256, scope_sha256: validationDigest(scope), recipe, tool, inputs };
    return { ...snapshot, snapshot_sha256: validationDigest(snapshot) };
}
