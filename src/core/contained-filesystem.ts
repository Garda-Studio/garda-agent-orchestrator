import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

interface PathIdentity {
    readonly path: string;
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
}

export interface ContainedDestination {
    readonly root: string;
    readonly path: string;
    readonly existing: readonly PathIdentity[];
    readonly missingAt: string | null;
}

function lstatIfPresent(filePath: string): fs.Stats | null {
    try {
        return fs.lstatSync(filePath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

function inspectContainedPath(
    root: string, candidate: string
): { existing: PathIdentity[]; missingAt: string | null } {
    const relative = path.relative(root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Destination resolves outside permitted root: ${candidate}`);
    }

    const components = relative ? relative.split(path.sep) : [];
    const existing: PathIdentity[] = [];
    let missingAt: string | null = null;
    let current = root;
    for (let index = -1; index < components.length; index += 1) {
        if (index >= 0) current = path.join(current, components[index]);
        const stat = lstatIfPresent(current);
        if (!stat) {
            missingAt = current;
            break;
        }
        if (stat.isSymbolicLink()) {
            throw new Error(`Refusing to overwrite symlink or junction destination: ${current}`);
        }
        if ((index === -1 || index < components.length - 1) && !stat.isDirectory()) {
            throw new Error(`Destination parent is not a directory: ${current}`);
        }
        if (stat.isFile() && stat.nlink !== 1) {
            throw new Error(`Destination crosses a hard-linked file: ${current}`);
        }
        if (!stat.isDirectory() && !stat.isFile()) {
            throw new Error(`Destination has an unsupported path type: ${current}`);
        }
        existing.push({ path: current, dev: stat.dev, ino: stat.ino, mode: stat.mode });
    }
    if (existing.length === 0) throw new Error(`Destination root does not exist: ${root}`);
    return { existing, missingAt };
}

export function bindContainedDestination(root: string, candidate: string): ContainedDestination {
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(candidate);
    return { root: resolvedRoot, path: resolvedPath, ...inspectContainedPath(resolvedRoot, resolvedPath) };
}

export function assertExistingPathIdentity(binding: ContainedDestination): void {
    const current = inspectContainedPath(binding.root, binding.path).existing;
    for (const original of binding.existing) {
        const observed = current.find((entry) => entry.path === original.path);
        if (!observed || observed.dev !== original.dev || observed.ino !== original.ino
            || observed.mode !== original.mode) {
            throw new Error(`Destination identity changed before mutation: ${original.path}`);
        }
    }
}

export function assertContainedDestination(binding: ContainedDestination): void {
    assertExistingPathIdentity(binding);
    if (binding.missingAt && lstatIfPresent(binding.missingAt)) {
        throw new Error(`Destination identity changed before mutation: ${binding.missingAt}`);
    }
}

export function ensureContainedDirectory(root: string, directoryPath: string): void {
    const binding = bindContainedDestination(root, directoryPath);
    const relative = path.relative(binding.root, binding.path);
    let current = binding.root;
    for (const component of relative ? relative.split(path.sep) : []) {
        current = path.join(current, component);
        assertExistingPathIdentity(binding);
        if (!lstatIfPresent(current)) fs.mkdirSync(current);
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error(`Destination parent is not a directory: ${current}`);
        }
    }
    assertExistingPathIdentity(binding);
}

function writeTempAndReplace(
    root: string,
    destinationPath: string,
    writeTemp: (tempPath: string) => void,
    preserveExistingMode = false,
    onReplaced?: () => void
): void {
    const initial = bindContainedDestination(root, destinationPath);
    ensureContainedDirectory(root, path.dirname(initial.path));
    assertExistingPathIdentity(initial);
    if (initial.missingAt && lstatIfPresent(initial.path)) {
        throw new Error(`Destination identity changed before mutation: ${initial.path}`);
    }
    const binding = bindContainedDestination(root, destinationPath);
    const parent = bindContainedDestination(root, path.dirname(binding.path));
    const existing = lstatIfPresent(binding.path);
    const tempPath = path.join(path.dirname(binding.path),
        `.${path.basename(binding.path)}.contained-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
    const tempBinding = bindContainedDestination(root, tempPath);
    try {
        writeTemp(tempPath);
        assertExistingPathIdentity(tempBinding);
        bindContainedDestination(root, tempPath);
        if (preserveExistingMode && existing?.isFile()) {
            fs.chmodSync(tempPath, existing.mode & 0o777);
        }
        const readyTemp = bindContainedDestination(root, tempPath);
        assertContainedDestination(readyTemp);
        assertContainedDestination(binding);
        assertContainedDestination(parent);
        fs.renameSync(tempPath, binding.path);
        onReplaced?.();
        assertContainedDestination(parent);
    } finally {
        if (lstatIfPresent(tempPath)) {
            assertExistingPathIdentity(tempBinding);
            bindContainedDestination(root, tempPath);
            fs.rmSync(tempPath, { force: true });
        }
    }
}

export function writeContainedFile(
    root: string, destinationPath: string, content: string | Buffer, onReplaced?: () => void
): void {
    writeTempAndReplace(root, destinationPath, (tempPath) => {
        fs.writeFileSync(tempPath, content, { flag: 'wx' });
    }, true, onReplaced);
}

export function copyContainedFile(
    root: string, sourcePath: string, destinationPath: string, onReplaced?: () => void
): void {
    bindContainedDestination(path.parse(path.resolve(sourcePath)).root, sourcePath);
    const source = lstatIfPresent(sourcePath);
    if (!source || !source.isFile() || source.isSymbolicLink() || source.nlink !== 1) {
        throw new Error(`Copy source must be an ordinary unlinked file: ${sourcePath}`);
    }
    writeTempAndReplace(root, destinationPath, (tempPath) => {
        fs.copyFileSync(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
        bindContainedDestination(path.parse(path.resolve(sourcePath)).root, sourcePath);
        const observed = fs.lstatSync(sourcePath);
        if (observed.dev !== source.dev || observed.ino !== source.ino || observed.nlink !== 1) {
            throw new Error(`Copy source identity changed: ${sourcePath}`);
        }
    }, false, onReplaced);
}

export function removeContainedPath(
    root: string, destinationPath: string, recursive = false, onRemoved?: () => void
): void {
    const binding = bindContainedDestination(root, destinationPath);
    assertContainedDestination(binding);
    if (!recursive && lstatIfPresent(binding.path)?.isDirectory()) {
        fs.rmdirSync(binding.path);
        onRemoved?.();
        return;
    }
    fs.rmSync(binding.path, { recursive, force: true });
    onRemoved?.();
}
