import * as path from 'node:path';
import type { ProjectValidationContract, ValidationRecipe } from './project-validation-contract';
import { rejectInlineValidationProgram } from './project-validation-command';
export { rejectInlineValidationProgram } from './project-validation-command';

function object(value: unknown, keys: string[] | null, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected object`);
    const record = value as Record<string, unknown>;
    if (keys && Object.keys(record).some((key) => !keys.includes(key))) throw new Error(`${label}: unknown property`);
    return record;
}
function text(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f]/u.test(value)) throw new Error(`${label}: expected nonempty text`);
    return value;
}
export function validationRelativePath(value: unknown, label = 'path'): string {
    const result = text(value, label);
    if (result.includes('\\') || result.includes(':') || path.posix.isAbsolute(result)
        || result.split('/').some((part) => !part || part === '.' || part === '..'
            || (process.platform === 'win32' && /[ .]$/u.test(part)))) throw new Error(`${label}: expected canonical repository relative path`);
    return result;
}
function list(value: unknown, label: string, maximum = 1024): unknown[] {
    if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label}: expected bounded array`);
    return Array.from({ length: value.length }, (_, index) => value[index]);
}
function integer(value: unknown, min: number, max: number, label: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${label}: out of bounds`);
    return Number(value);
}
function unique(values: string[], label: string): void {
    if (new Set(values).size !== values.length) throw new Error(`${label}: duplicate identity`);
}
function pathKey(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value; }

function parseInputs(value: unknown): ValidationRecipe['inputs'] {
    const inputs = list(value, 'inputs').map((input) => {
        const item = object(input, ['path', 'role'], 'input');
        const role = text(item.role, 'role') as ValidationRecipe['inputs'][number]['role'];
        if (!['source', 'test', 'helper', 'config'].includes(role)) throw new Error('Unknown input role');
        return { path: validationRelativePath(item.path), role };
    });
    if (inputs.length === 0) throw new Error('A recipe must bind its source inputs');
    unique(inputs.map((input) => pathKey(input.path)), 'inputs');
    return inputs;
}

function parseTargets(value: unknown, inputs: ValidationRecipe['inputs'], purpose: ValidationRecipe['purpose']): ValidationRecipe['targets'] {
    const targets = list(value, 'targets').map((target) => {
        const item = object(target, ['id', 'source', 'selector'], 'target');
        const source = validationRelativePath(item.source);
        if (!inputs.some((input) => input.path === source && input.role === 'test')) throw new Error('Target source must be a declared test input');
        return { id: text(item.id, 'target.id'), source, selector: text(item.selector, 'target.selector') };
    });
    unique(targets.map((target) => target.id), 'targets');
    unique(targets.map((target) => target.selector), 'selectors');
    if (purpose === 'test' && targets.length === 0) throw new Error('Test recipes require exact targets');
    return targets;
}

function parseArguments(value: unknown, targets: ValidationRecipe['targets']): ValidationRecipe['argv'] {
    return list(value, 'argv', 256).map((arg) => {
        if (typeof arg === 'string') {
            if (arg.includes('\0')) throw new Error('NUL argument');
            return arg;
        }
        const slot = object(arg, ['target'], 'argument slot');
        const target = text(slot.target, 'argument target');
        if (!targets.some((entry) => entry.id === target)) throw new Error('Unknown argument target');
        return { target };
    });
}

function parseEnvironment(value: unknown): Record<string, string> {
    const environment: Record<string, string> = Object.create(null) as Record<string, string>;
    const env = object(value, null, 'environment');
    for (const [key, value] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid literal environment');
        if (/^(?:NODE_OPTIONS|BASH_ENV|ENV|LD_PRELOAD|LD_AUDIT|DYLD_INSERT_LIBRARIES|PYTHONSTARTUP|PYTHONPATH|ZDOTDIR|HOME|RUBYOPT|PERL5OPT)$/iu.test(key)) throw new Error(`Implicit program injection environment is forbidden: ${key}`);
        environment[key] = value;
    }
    unique(Object.keys(environment).map((key) => key.toUpperCase()), 'environment');
    return environment;
}

function parseCapabilities(value: unknown): ValidationRecipe['required_capabilities'] {
    const capabilities = list(value, 'capabilities', 2).map((item) => {
        if (item !== 'offline' && item !== 'write_confinement') throw new Error('Unknown enforced capability');
        return item;
    });
    unique(capabilities, 'capabilities');
    return capabilities;
}

function recipe(value: unknown): ValidationRecipe {
    const raw = object(value, ['id', 'purpose', 'executable', 'argv', 'cwd', 'inputs', 'targets', 'environment',
        'timeout_ms', 'max_attempts', 'max_output_bytes', 'max_input_bytes', 'required_capabilities', 'result_format'], 'recipe');
    const id = text(raw.id, 'recipe.id');
    const purpose = text(raw.purpose, 'purpose') as ValidationRecipe['purpose'];
    if (!['test', 'compile', 'typecheck', 'validation'].includes(purpose)) throw new Error('Unknown validation purpose');
    const executable = text(raw.executable, 'executable');
    const cwd = raw.cwd === '.' ? '.' : validationRelativePath(raw.cwd, 'cwd');
    const inputs = parseInputs(raw.inputs);
    const targets = parseTargets(raw.targets, inputs, purpose);
    const argv = parseArguments(raw.argv, targets);
    const environment = parseEnvironment(raw.environment);
    const requiredCapabilities = parseCapabilities(raw.required_capabilities);
    const result_format = raw.result_format;
    if (result_format !== 'tap' && result_format !== 'opaque') throw new Error('Unknown result format');
    rejectInlineValidationProgram(executable, argv.map((arg) => typeof arg === 'string' ? arg : targets.find((target) => target.id === arg.target)!.selector));
    return { id, purpose, executable, argv, cwd, inputs, targets, environment,
        timeout_ms: integer(raw.timeout_ms, 100, 3_600_000, 'timeout_ms'),
        max_attempts: integer(raw.max_attempts, 1, 10, 'max_attempts'),
        max_output_bytes: integer(raw.max_output_bytes, 1024, 16_777_216, 'max_output_bytes'),
        max_input_bytes: integer(raw.max_input_bytes, 1024, 67_108_864, 'max_input_bytes'),
        required_capabilities: requiredCapabilities, result_format };
}

function assertDeclarationByteBound(value: unknown): void {
    let remaining = 1024 * 1024; const active = new WeakSet<object>();
    function visit(item: unknown): void {
        if (typeof item === 'string') { if (item.length > remaining) throw new Error('Project validation declaration exceeds byte bound'); remaining -= Buffer.byteLength(JSON.stringify(item)); }
        else if (item && typeof item === 'object') {
            if (active.has(item)) throw new Error('Cyclic project validation declaration'); active.add(item); remaining -= 2;
            if (Array.isArray(item)) { if (item.length > 1024) throw new Error('Project validation declaration exceeds byte bound'); remaining -= Math.max(0, item.length - 1); for (const entry of item) visit(entry); }
            else { let fields = 0; for (const key in item) if (Object.hasOwn(item, key)) { visit(key); remaining -= 1 + Number(fields++ > 0); visit((item as Record<string, unknown>)[key]); } }
            active.delete(item);
        } else remaining -= Buffer.byteLength(JSON.stringify(item) ?? 'null');
        if (remaining < 0) throw new Error('Project validation declaration exceeds byte bound');
    }
    visit(value);
}
export function parseProjectValidationContract(value: unknown): ProjectValidationContract {
    const raw = object(value, ['schema_version', 'recipes'], 'project validation contract');
    if (raw.schema_version !== 1) throw new Error('Unsupported project validation contract version');
    const declarations = list(raw.recipes, 'recipes', 64);
    assertDeclarationByteBound(raw);
    const recipes = declarations.map(recipe);
    if (recipes.length === 0) throw new Error('Project validation requires at least one recipe');
    unique(recipes.map((entry) => entry.id), 'recipes');
    return { schema_version: 1, recipes };
}

export function eligibleExpectedRedRecipes(recipes: readonly ValidationRecipe[], changedFiles: readonly unknown[]): ValidationRecipe[] {
    if (!changedFiles.length || !Array.from(changedFiles).every((file) => typeof file === 'string'
        && recipes.some((recipe) => recipe.inputs.some((input) => pathKey(input.path) === pathKey(file) && input.role === 'test'))
        && !recipes.some((recipe) => recipe.inputs.some((input) => pathKey(input.path) === pathKey(file) && input.role !== 'test')))) {
        throw new Error('Expected-red requires an exact changed test-only recipe scope');
    }
    const eligible = recipes.filter((recipe) => recipe.purpose === 'test' && recipe.result_format === 'tap'
        && recipe.targets.some((target) => recipe.argv.some((arg) => typeof arg !== 'string' && arg.target === target.id) && changedFiles.some((file) => typeof file === 'string' && pathKey(file) === pathKey(target.source))));
    if (!changedFiles.every((file) => typeof file === 'string' && eligible.some((recipe) => recipe.targets.some((target) => recipe.argv.some((arg) => typeof arg !== 'string' && arg.target === target.id) && pathKey(file) === pathKey(target.source))))) throw new Error('Expected-red requires a recipe with a changed declared test target and a supported case adapter');
    return eligible;
}
