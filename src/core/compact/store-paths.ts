import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../constants';
import { assertCanonicalTaskId } from '../task-ids';
import { withFilesystemLockAsync } from '../../gate-runtime/task-events-locking';

export function containedDirectory(root: string, relative: string, create = false): string {
    const base = fs.realpathSync(root);
    const target = path.resolve(base, relative);
    const rel = path.relative(base, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Compact path escapes containment.');
    let current = base;
    for (const part of rel.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Compact directory contains a link or non-directory.');
    }
    return target;
}

export function openCompactFile(file: string, flags: number): number {
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Compact file cannot be a link.');
    const fd = fs.openSync(file, flags | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
        fs.closeSync(fd);
        throw new Error('Compact requires an unshared regular file.');
    }
    return fd;
}

export class CompactStore {
    constructor(readonly root: string) {}
    taskPath(taskId: string, create = false): string {
        return containedDirectory(this.root, assertCanonicalTaskId(taskId), create);
    }
    runPath(taskId: string, ref: string, create = false): string {
        if (!/^[a-f0-9]{32}$/.test(ref)) throw new Error('Invalid compact reference.');
        return containedDirectory(this.taskPath(taskId, create), ref, create);
    }
    usage(taskId?: string): { bytes: number; runs: number } {
        const target = taskId ? this.taskPath(taskId, true) : this.root;
        let bytes = 0;
        let runs = 0;
        let entries = 0;
        const walk = (dir: string, depth: number): void => {
            if (depth > 2) throw new Error('Unexpected compact cache layout.');
            for (const name of fs.readdirSync(dir)) {
                if (++entries > 12000) throw new Error('Compact cache entry limit exceeded.');
                const file = path.join(dir, name);
                const stat = fs.lstatSync(file);
                if (stat.isSymbolicLink()) throw new Error('Compact cache contains a link.');
                if (stat.isDirectory()) {
                    if (/^[a-f0-9]{32}$/.test(name)) runs++;
                    walk(file, depth + 1);
                } else if (stat.isFile() && stat.nlink === 1) bytes += stat.size;
                else throw new Error('Unexpected compact cache file.');
            }
        };
        walk(target, taskId ? 1 : 0);
        return { bytes, runs };
    }
}

export async function withCompactStore<T>(repoRoot: string, operation: (store: CompactStore) => Promise<T> | T): Promise<T> {
    const runtime = containedDirectory(repoRoot, `${resolveBundleName()}/runtime`, true);
    const root = containedDirectory(runtime, 'compact', true);
    const locked = await withFilesystemLockAsync(path.join(runtime, 'compact.lock'), {
        timeoutMs: 5000, requireKnownDeadOwner: true, ownerLabel: 'compact'
    }, async () => {
        if (containedDirectory(runtime, 'compact') !== root) throw new Error('Compact cache identity changed.');
        return operation(new CompactStore(root));
    });
    return locked.result;
}
