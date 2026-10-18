import * as path from 'node:path';

export function validationRelativePath(value: unknown, label = 'path'): string {
    if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f]/u.test(value))
        throw new Error(`${label}: expected nonempty text`);
    if (value.includes('\\') || value.includes(':') || path.posix.isAbsolute(value)
        || value.split('/').some(part => !part || part === '.' || part === '..'
            || (process.platform === 'win32' && /[ .]$/u.test(part))))
        throw new Error(`${label}: expected canonical repository relative path`);
    return value;
}

export function validationPathKey(value: string): string {
    return process.platform === 'win32' ? value.toLowerCase() : value;
}
