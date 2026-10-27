import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleNameForTarget } from './constants';

/** CLI prefix printed in runtime guidance; matches the next-step navigator for the same repository. */
export function resolveGardaCliPrefix(repoRoot: string): string {
    const resolvedRepoRoot = path.resolve(repoRoot || '.');
    return fs.existsSync(path.join(resolvedRepoRoot, 'bin', 'garda.js'))
        ? 'node bin/garda.js'
        : `node ${resolveBundleNameForTarget(resolvedRepoRoot)}/bin/garda.js`;
}
