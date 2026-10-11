import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { assertExistingPathIdentity, bindContainedDestination } from './contained-filesystem';
import type { ApprovedValidationContract, ValidationFileIdentity, ValidationRecipe } from './project-validation-contract';
import { parseProjectValidationContract, validationRelativePath } from './project-validation-recipes';

const MAXIMUM_FILE_BYTES = 128 * 1024 * 1024;

export function validationDigest(value: unknown): string {
    return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
}
export function readValidationFile(root: string, relative: string, maximumBytes = MAXIMUM_FILE_BYTES): { identity: ValidationFileIdentity; bytes: Buffer } {
    relative = validationRelativePath(relative);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAXIMUM_FILE_BYTES) throw new Error('Invalid validation file byte bound');
    const target = path.resolve(root, relative);
    const binding = bindContainedDestination(root, target);
    const descriptor = fs.openSync(target, 'r');
    try {
        const before = fs.fstatSync(descriptor, { bigint: true });
        const bound = binding.existing.at(-1);
        if (binding.missingAt || !bound || before.dev !== bound.dev || before.ino !== bound.ino || before.birthtimeNs !== bound.birthtimeNs) throw new Error(`Validation descriptor does not match the bound file: ${relative}`);
        if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) throw new Error(`Invalid validation input or byte bound: ${relative}`);
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
            if (count === 0) break;
            offset += count;
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        assertExistingPathIdentity(binding);
        if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs || after.nlink !== 1n
            || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || offset !== Number(before.size)) throw new Error(`Validation input changed during read: ${relative}`);
        const bytes = buffer.subarray(0, offset);
        return { bytes, identity: { path: relative, sha256: validationDigest(bytes), size: bytes.length,
            identity: `${before.dev}:${before.ino}:${before.birthtimeNs}` } };
    } finally { fs.closeSync(descriptor); }
}
export function readValidationInputs(root: string, recipe: ValidationRecipe): ValidationFileIdentity[] {
    let remaining = recipe.max_input_bytes;
    return recipe.inputs.map((input) => {
        const { identity } = readValidationFile(root, input.path, remaining);
        remaining -= identity.size;
        return identity;
    });
}
export function readValidationTool(executable: string): ValidationFileIdentity {
    if (!path.isAbsolute(executable)) throw new Error('Audited executable must be an absolute path (resolve it before admission)');
    bindContainedDestination(path.parse(executable).root, executable);
    return { ...readValidationFile(path.dirname(executable), path.basename(executable)).identity, path: executable };
}
export function approveProjectValidationContract(repoRoot: string, value: unknown): ApprovedValidationContract {
    const contract = parseProjectValidationContract(value);
    const tools: ApprovedValidationContract['tools'] = Object.create(null) as ApprovedValidationContract['tools'];
    const dependencies: ApprovedValidationContract['dependencies'] = Object.create(null) as ApprovedValidationContract['dependencies'];
    for (const recipe of contract.recipes) {
        tools[recipe.id] = readValidationTool(recipe.executable);
        for (const [index, identity] of readValidationInputs(repoRoot, recipe).entries()) {
            const input = recipe.inputs[index];
            if (input.role === 'helper' || input.role === 'config') dependencies[input.path] = identity;
        }
    }
    return parseApprovedValidationContract({ schema_version: 1, contract, tools, dependencies });
}
export function parseApprovedValidationContract(value: unknown): ApprovedValidationContract {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid approved validation contract');
    const raw = value as ApprovedValidationContract;
    if (raw.schema_version !== 1 || Object.keys(raw).some((key) => !['schema_version', 'contract', 'tools', 'dependencies'].includes(key))) throw new Error('Invalid approved validation contract version or properties');
    const contract = parseProjectValidationContract(raw.contract);
    for (const field of ['tools', 'dependencies'] as const) {
        const entries = raw[field];
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`Missing approved ${field}`);
    }
    const toolIds = contract.recipes.map((recipe) => recipe.id).sort();
    const deps = [...new Set(contract.recipes.flatMap((recipe) => recipe.inputs.filter((input) => input.role === 'helper' || input.role === 'config').map((input) => input.path)))].sort();
    if (JSON.stringify(Object.keys(raw.tools).sort()) !== JSON.stringify(toolIds) || JSON.stringify(Object.keys(raw.dependencies).sort()) !== JSON.stringify(deps)) throw new Error('Approved identities do not cover the exact contract');
    const tools: ApprovedValidationContract['tools'] = Object.create(null) as ApprovedValidationContract['tools'];
    const dependencies: ApprovedValidationContract['dependencies'] = Object.create(null) as ApprovedValidationContract['dependencies'];
    for (const recipe of contract.recipes) tools[recipe.id] = parseFileIdentity(raw.tools[recipe.id], recipe.executable);
    for (const dependency of deps) dependencies[dependency] = parseFileIdentity(raw.dependencies[dependency], dependency);
    return { schema_version: 1, contract, tools, dependencies };
}
function parseFileIdentity(value: ValidationFileIdentity, expectedPath: string): ValidationFileIdentity {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.path !== expectedPath || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
        || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAXIMUM_FILE_BYTES || typeof value.identity !== 'string'
        || !/^\d+:\d+:\d+$/u.test(value.identity) || Object.keys(value).some((key) => !['path', 'sha256', 'size', 'identity'].includes(key))) throw new Error('Invalid approved file identity');
    return { path: value.path, sha256: value.sha256, size: value.size, identity: value.identity };
}
