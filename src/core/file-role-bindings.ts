import { matchAnyRegex } from '../gate-runtime/text-utils';
import { validationRelativePath } from './project-validation-recipes';

export type DeclaredFileRole = 'source' | 'test';
export type FileRoleBindings = Readonly<Record<string, DeclaredFileRole>>;
const MAXIMUM_FILE_ROLES = 1024;

function pathKey(value: string): string {
    return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function normalizeFileRoleBindings(value: unknown, label = 'file_roles'): FileRoleBindings {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object of exact repository-relative source/test paths.`);
    }
    const entries = Object.entries(value);
    if (entries.length > MAXIMUM_FILE_ROLES) throw new Error(`${label} exceeds ${MAXIMUM_FILE_ROLES} paths.`);
    const roles: Record<string, DeclaredFileRole> = {};
    for (const [file, role] of entries.sort(([left], [right]) => left.localeCompare(right))) {
        const key = pathKey(validationRelativePath(file, `${label} path`));
        if (role !== 'source' && role !== 'test') throw new Error(`${label}.${file} must be source or test.`);
        if (Object.hasOwn(roles, key)) throw new Error(`${label} contains a duplicate path: ${file}`);
        Object.defineProperty(roles, key, { value: role, enumerable: true });
    }
    return roles;
}

export function mergeFileRoleBindings(...bindings: readonly FileRoleBindings[]): FileRoleBindings {
    const merged: Record<string, DeclaredFileRole> = {};
    for (const binding of bindings) {
        for (const [file, role] of Object.entries(normalizeFileRoleBindings(binding))) {
            if (Object.hasOwn(merged, file) && merged[file] !== role) {
                throw new Error(`Conflicting declared file roles for ${file}.`);
            }
            Object.defineProperty(merged, file, { value: role, enumerable: true, configurable: true });
        }
    }
    return normalizeFileRoleBindings(merged);
}

export function declaredFileRole(file: string, bindings: FileRoleBindings = {}): DeclaredFileRole | undefined {
    const key = pathKey(file.replace(/\\/gu, '/'));
    if (Object.hasOwn(bindings, key)) return bindings[key];
    if (process.platform === 'win32') {
        const match = Object.keys(bindings).find(candidate => pathKey(candidate) === key);
        if (match !== undefined) return bindings[match];
    }
    return undefined;
}

export function isTestScopePath(file: string, testRegexes: readonly string[], bindings?: FileRoleBindings): boolean {
    const role = declaredFileRole(file, bindings);
    return role ? role === 'test' : matchAnyRegex(file.replace(/\\/gu, '/'), [...testRegexes], {
        skipInvalidRegex: true, caseInsensitive: true
    });
}
