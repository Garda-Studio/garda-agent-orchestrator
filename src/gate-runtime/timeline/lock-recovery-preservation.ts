import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertContainedDestination, bindContainedDestination, ensureContainedDirectory,
    readBoundedContainedDirectory, type ContainedDestination } from '../../core/contained-filesystem';
import { lstatFileIdentitySync } from '../../core/file-stat';

const MAX_MEMBERS = 64;
const MAX_BYTES = 1024 * 1024;
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

function identity(stat: fs.BigIntStats) {
    return { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
        birthtimeNs: String(stat.birthtimeNs), uid: String(stat.uid), gid: String(stat.gid) };
}

function signature(stat: fs.BigIntStats): string {
    return JSON.stringify({ ...identity(stat), nlink: String(stat.nlink), size: String(stat.size),
        mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
}

function readMember(root: string, file: string, budget: number) {
    const binding = bindContainedDestination(root, file);
    const before = lstatFileIdentitySync(file, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error('Preservation requires ordinary unlinked files.');
    if (before.size > BigInt(budget)) throw new Error('Preservation byte limit exceeded.');
    const descriptor = fs.openSync(file, READ_FLAGS);
    try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || signature(opened) !== signature(before)) throw new Error('Source identity changed before reading.');
        const bytes = Buffer.alloc(budget + 1);
        let count = 0;
        while (count < bytes.length) {
            const read = fs.readSync(descriptor, bytes, count, bytes.length - count, null);
            if (!read) break;
            count += read;
        }
        if (count > budget) throw new Error('Preservation byte limit exceeded.');
        if (BigInt(count) !== before.size) throw new Error('Source size changed or reading stopped before EOF.');
        assertContainedDestination(binding);
        if (signature(fs.fstatSync(descriptor, { bigint: true })) !== signature(before)
            || signature(lstatFileIdentitySync(file, { bigint: true })) !== signature(before)) {
            throw new Error('Source identity or content changed during reading.');
        }
        return { bytes: bytes.subarray(0, count), identity: identity(before), signature: signature(before) };
    } finally {
        fs.closeSync(descriptor);
    }
}

function writeExclusive(parent: ContainedDestination, file: string, bytes: Buffer) {
    assertContainedDestination(parent);
    const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT
        | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
        assertContainedDestination(parent);
        const opened = fs.fstatSync(descriptor, { bigint: true });
        const current = lstatFileIdentitySync(file, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || JSON.stringify(identity(opened)) !== JSON.stringify(identity(current))) {
            throw new Error('Preservation destination identity changed before writing.');
        }
        let offset = 0;
        while (offset < bytes.length) {
            const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
            if (written <= 0) throw new Error('Preservation copy made no write progress.');
            offset += written;
        }
        fs.fsyncSync(descriptor);
        return identity(fs.fstatSync(descriptor, { bigint: true }));
    } finally {
        fs.closeSync(descriptor);
    }
}

function verifyCopy(parent: ContainedDestination, file: string, bytes: Buffer, expectedIdentity: ReturnType<typeof identity>) {
    assertContainedDestination(parent);
    const copied = readMember(parent.root, file, bytes.length);
    if (JSON.stringify(copied.identity) !== JSON.stringify(expectedIdentity) || !copied.bytes.equals(bytes)) {
        throw new Error('Preservation copy identity or bytes changed.');
    }
    return { file, signature: copied.signature };
}

function createCapture(project: string): ContainedDestination {
    const parent = path.dirname(project);
    const namespace = path.join(parent, 'garda-recovery-preserved');
    const storage = path.join(namespace, 'lock-claims');
    if (parent === project || path.basename(project).toLowerCase() === 'garda-recovery-preserved') throw new Error('Preservation storage must be outside the project.');
    if (typeof process.getuid !== 'function') throw new Error('Preservation copy requires verifiable owner-managed storage identity on this platform.');
    ensureContainedDirectory(parent, storage);
    const storageBinding = bindContainedDestination(parent, storage);
    for (const directory of [namespace, storage]) {
        const stat = lstatFileIdentitySync(directory, { bigint: true });
        if (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o022n) !== 0n) {
            throw new Error('Preservation storage must be owner-managed without shared write permissions.');
        }
    }
    assertContainedDestination(storageBinding);
    const capture = path.join(storage, crypto.randomUUID());
    fs.mkdirSync(capture, { mode: 0o700 });
    assertContainedDestination(storageBinding);
    return bindContainedDestination(parent, capture);
}

export function preserveDisputedLockDirectory(projectRoot: string, claimedPath: string): { capturePath: string } {
    const project = path.resolve(projectRoot), source = path.resolve(claimedPath);
    let capturePath: string | undefined;
    try {
        bindContainedDestination(path.parse(project).root, project);
        const sourceBinding = bindContainedDestination(project, source);
        const directory = lstatFileIdentitySync(source, { bigint: true });
        if (source === project || !directory.isDirectory()) throw new Error('Preservation requires a claimed ordinary directory inside the project.');
        const names = readBoundedContainedDirectory(sourceBinding, MAX_MEMBERS);
        let remaining = MAX_BYTES;
        const members = names.map(name => {
            const snapshot = readMember(project, path.join(source, name), remaining);
            remaining -= snapshot.bytes.length;
            return { name, ...snapshot };
        });
        const capture = createCapture(project);
        capturePath = capture.path;
        const files = path.join(capture.path, 'files');
        ensureContainedDirectory(capture.root, files);
        const filesBinding = bindContainedDestination(capture.root, files);
        const copies = members.map(member => {
            const destination = path.join(files, member.name);
            const issued = writeExclusive(filesBinding, destination, member.bytes);
            return { destination, issued, bytes: member.bytes };
        });
        const manifest = Buffer.from(JSON.stringify({ kind: 'DISPUTED_LOCK_COPY_NOT_RECOVERY_AUTHORITY',
            capturedAtUtc: new Date().toISOString(), source: { project, path: source, directory: identity(directory) },
            files: members.map(member => ({ name: member.name, bytes: member.bytes.length,
                sha256: crypto.createHash('sha256').update(member.bytes).digest('hex'), sourceIdentity: member.identity, sourceSignature: member.signature })) }, null, 2));
        const manifestPath = path.join(capture.path, 'manifest.json');
        const issued = writeExclusive(capture, manifestPath, manifest);
        const verified = [verifyCopy(capture, manifestPath, manifest, issued),
            ...copies.map(copy => verifyCopy(filesBinding, copy.destination, copy.bytes, copy.issued))];
        for (const member of members) {
            const current = readMember(project, path.join(source, member.name), member.bytes.length);
            if (current.signature !== member.signature || !current.bytes.equals(member.bytes)) throw new Error('Source changed after copying.');
        }
        for (const checked of [...members.map(member => ({ file: path.join(source, member.name), signature: member.signature })), ...verified]) {
            if (signature(lstatFileIdentitySync(checked.file, { bigint: true })) !== checked.signature) {
                throw new Error('Source or preservation copy changed during final verification.');
            }
        }
        assertContainedDestination(sourceBinding);
        if (signature(lstatFileIdentitySync(source, { bigint: true })) !== signature(directory)
            || JSON.stringify(readBoundedContainedDirectory(sourceBinding, MAX_MEMBERS)) !== JSON.stringify(names)) {
            throw new Error('Source directory identity or membership changed during preservation.');
        }
        assertContainedDestination(filesBinding);
        assertContainedDestination(capture);
        return { capturePath: capture.path };
    } catch (error: unknown) {
        throw new Error(`Lock preservation failed; original retained; partial capture retained at ${capturePath || 'none'}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
