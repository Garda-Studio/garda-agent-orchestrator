import * as fs from 'node:fs';
import { isBuiltin, register } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

interface CommonJsLoader {
    _resolveFilename: (...args: unknown[]) => string;
}

if (process.env.GARDA_UPDATE_HANDOFF_INTERNAL_LOADER !== '1') {
    const distPath = process.env.GARDA_UPDATE_HANDOFF_DIST;
    if (!distPath) {
        throw new Error('Updated bundle loader boundary is missing.');
    }
    const allowedDist = fs.realpathSync.native(distPath);
    process.env.GARDA_UPDATE_HANDOFF_INTERNAL_LOADER = '1';
    try {
        register('./update-runtime-esm-guard.js', {
            parentURL: pathToFileURL(__filename),
            data: { distPath: allowedDist }
        });
    } finally {
        delete process.env.GARDA_UPDATE_HANDOFF_INTERNAL_LOADER;
    }

    const loader = require('node:module') as CommonJsLoader;
    const originalResolve = loader._resolveFilename;
    loader._resolveFilename = function (this: CommonJsLoader, ...args: unknown[]): string {
        const resolved = originalResolve.apply(this, args);
        if (isBuiltin(String(args[0]))) {
            return resolved;
        }
        const realPath = fs.realpathSync.native(resolved);
        const relative = path.relative(allowedDist, realPath);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error('Updated bundle module resolves outside its contained runtime.');
        }
        return resolved;
    };
}
