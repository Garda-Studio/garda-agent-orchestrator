import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

let allowedDist: string;

export function initialize(data: { distPath: string }): void {
    allowedDist = fs.realpathSync.native(data.distPath);
}

export async function resolve(
    specifier: string,
    context: unknown,
    nextResolve: (specifier: string, context: unknown) => Promise<{ url: string }>
): Promise<{ url: string }> {
    const result = await nextResolve(specifier, context);
    if (result.url.startsWith('node:')) {
        return result;
    }
    if (!result.url.startsWith('file:')) {
        throw new Error('Updated bundle module resolves outside its contained runtime.');
    }
    const realPath = fs.realpathSync.native(fileURLToPath(result.url));
    const relative = path.relative(allowedDist, realPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Updated bundle module resolves outside its contained runtime.');
    }
    return result;
}
