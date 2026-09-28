import * as fs from 'node:fs';
import { lstatFileIdentitySync } from './file-stat';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

interface PathIdentity {
    readonly path: string;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mode: bigint;
    readonly birthtimeNs: bigint;
}

export interface ContainedDestination {
    readonly root: string;
    readonly path: string;
    readonly existing: readonly PathIdentity[];
    readonly missingAt: string | null;
}

function lstatIfPresent(filePath: string): fs.Stats | null {
    try {
        return lstatFileIdentitySync(filePath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

function lstatIdentityIfPresent(filePath: string): fs.BigIntStats | null {
    try {
        return lstatFileIdentitySync(filePath, { bigint: true });
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
        const stat = lstatIdentityIfPresent(current);
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
        if (stat.isFile() && stat.nlink !== 1n) {
            throw new Error(`Destination crosses a hard-linked file: ${current}`);
        }
        if (!stat.isDirectory() && !stat.isFile()) {
            throw new Error(`Destination has an unsupported path type: ${current}`);
        }
        if (stat.birthtimeNs <= 0n) {
            throw new Error(`Destination creation identity is unavailable: ${current}`);
        }
        existing.push({ path: current, dev: stat.dev, ino: stat.ino, mode: stat.mode,
            birthtimeNs: stat.birthtimeNs });
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
            || observed.mode !== original.mode || observed.birthtimeNs !== original.birthtimeNs) {
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

export function ensureContainedDirectory(
    root: string, directoryPath: string, onCreated?: (binding: ContainedDestination) => void
): void {
    const binding = bindContainedDestination(root, directoryPath);
    const relative = path.relative(binding.root, binding.path);
    let current = binding.root;
    for (const component of relative ? relative.split(path.sep) : []) {
        current = path.join(current, component);
        assertExistingPathIdentity(binding);
        const created = !lstatIfPresent(current);
        if (created) fs.mkdirSync(current);
        const stat = lstatFileIdentitySync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error(`Destination parent is not a directory: ${current}`);
        }
        if (created) onCreated?.(bindContainedDestination(root, current));
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
        const observed = lstatFileIdentitySync(sourcePath);
        if (observed.dev !== source.dev || observed.ino !== source.ino || observed.nlink !== 1) {
            throw new Error(`Copy source identity changed: ${sourcePath}`);
        }
    }, false, onReplaced);
}

interface RemovalEntry {
    readonly binding: ContainedDestination;
    readonly directory: boolean;
}

const ambiguousRemovalPaths = new Set<string>();
const completedRemovals = new WeakSet<ContainedDestination>();

function removalKey(candidate: string): string {
    const resolved = path.resolve(candidate);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isAtOrInside(candidate: string, parent: string): boolean {
    const relative = path.relative(parent, candidate);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function assertRemovalNotAmbiguous(candidate: string): void {
    const requested = removalKey(candidate);
    for (const blocked of ambiguousRemovalPaths) {
        if (isAtOrInside(requested, blocked) || isAtOrInside(blocked, requested)) {
            throw new Error(`Refusing cleanup of ambiguous previously rejected path: ${candidate}`);
        }
    }
}

function mountedDirectoryPaths(): Set<string> {
    if (process.platform !== 'linux') return new Set();
    const entries = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
    const mountPoints = new Set<string>();
    for (const entry of entries) {
        const mountPoint = entry.split(' ')[4];
        if (!mountPoint) continue;
        const decoded = mountPoint.replace(/\\([0-7]{3})/gu, (_, octal: string) =>
            String.fromCharCode(Number.parseInt(octal, 8)));
        mountPoints.add(removalKey(decoded));
    }
    return mountPoints;
}

function assertRemovalMountBoundary(
    candidate: string, rootDevice: bigint, mountPoints: ReadonlySet<string>
): void {
    const stat = lstatIdentityIfPresent(candidate);
    if (!stat) throw new Error(`Cleanup destination disappeared during mount inspection: ${candidate}`);
    if (stat.dev !== rootDevice || mountPoints.has(removalKey(candidate))) {
        throw new Error(`Refusing cleanup across mounted directory boundary: ${candidate}`);
    }
}

function collectRemovalEntries(rootBinding: ContainedDestination): RemovalEntry[] {
    const pending = [rootBinding];
    const entries: RemovalEntry[] = [];
    const rootStat = lstatIdentityIfPresent(rootBinding.path);
    if (!rootStat) throw new Error(`Cleanup destination disappeared before inspection: ${rootBinding.path}`);
    const rootDevice = rootStat.dev;
    const mountPoints = mountedDirectoryPaths();
    while (pending.length > 0) {
        const binding = pending.pop()!;
        const currentPath = binding.path;
        assertContainedDestination(binding);
        assertRemovalMountBoundary(currentPath, rootDevice, mountPoints);
        const stat = lstatIfPresent(currentPath);
        if (!stat) throw new Error(`Cleanup destination disappeared during inspection: ${currentPath}`);
        entries.push({ binding, directory: stat.isDirectory() });
        if (stat.isDirectory()) {
            const before = lstatFileIdentitySync(currentPath, { bigint: true });
            const children = fs.readdirSync(currentPath).sort().map((name) =>
                bindContainedDestination(rootBinding.root, path.join(currentPath, name)));
            const after = lstatFileIdentitySync(currentPath, { bigint: true });
            if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
                || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
                throw new Error(`Cleanup directory changed during enumeration: ${currentPath}`);
            }
            assertContainedDestination(binding);
            pending.push(...children);
        }
    }
    const currentMountPoints = mountedDirectoryPaths();
    for (const entry of entries) {
        assertContainedDestination(entry.binding);
        assertRemovalMountBoundary(entry.binding.path, rootDevice, currentMountPoints);
    }
    return entries;
}

export function removeBoundContainedPath(
    binding: ContainedDestination, recursive = false, onRemoved?: () => void
): void {
    if (path.relative(binding.root, binding.path) === '') {
        throw new Error(`Refusing to remove containment root: ${binding.path}`);
    }
    if (completedRemovals.has(binding)) return;
    assertRemovalNotAmbiguous(binding.path);
    try {
        assertContainedDestination(binding);
        const stat = lstatIfPresent(binding.path);
        if (!stat) {
            completedRemovals.add(binding);
            onRemoved?.();
            return;
        }
        const entries = recursive ? collectRemovalEntries(binding) : [{ binding, directory: stat.isDirectory() }];
        for (const entry of entries.reverse()) {
            assertContainedDestination(entry.binding);
            if (entry.directory) fs.rmdirSync(entry.binding.path);
            else fs.unlinkSync(entry.binding.path);
        }
        completedRemovals.add(binding);
        onRemoved?.();
    } catch (error: unknown) {
        ambiguousRemovalPaths.add(removalKey(binding.path));
        throw error;
    }
}

export function removeContainedPath(
    root: string, destinationPath: string, recursive = false, onRemoved?: () => void
): void {
    let binding: ContainedDestination;
    try {
        binding = bindContainedDestination(root, destinationPath);
    } catch (error: unknown) {
        ambiguousRemovalPaths.add(removalKey(destinationPath));
        throw error;
    }
    removeBoundContainedPath(binding, recursive, onRemoved);
}
