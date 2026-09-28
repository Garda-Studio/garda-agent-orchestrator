import * as fs from 'node:fs';
import * as path from 'node:path';

export function resolveMockFilesystemPath(file: fs.PathLike): string {
    const lexicalPath = path.resolve(String(file));
    try {
        return path.join(fs.realpathSync.native(path.dirname(lexicalPath)), path.basename(lexicalPath));
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        return lexicalPath;
    }
}
