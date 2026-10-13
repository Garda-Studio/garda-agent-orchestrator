import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertContainedDestination, bindContainedDestination, ensureContainedDirectory,
    type ContainedDestination } from '../../core/contained-filesystem';
import { lstatFileIdentitySync } from '../../core/file-stat';

interface MarkerLease {
    root: string;
    file: string;
    parent: ContainedDestination;
    identity: fs.BigIntStats;
    content: string;
}

// The JSON record is inspectable recovery metadata, never an issued handle.
const leases = new WeakMap<object, MarkerLease>();
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
function changed(): Error { return new Error('Full-suite run marker owner or generation changed; mutation rejected.'); }
function sameObject(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
        && left.birthtimeNs === right.birthtimeNs;
}
function assertCurrent(lease: MarkerLease, fd?: number): fs.BigIntStats {
    try {
        assertContainedDestination(lease.parent);
        const current = lstatFileIdentitySync(lease.file, { bigint: true });
        const held = fd === undefined ? current : fs.fstatSync(fd, { bigint: true });
        if (!held.isFile() || !current.isFile() || held.nlink !== 1n || current.nlink !== 1n
            || held.ino <= 0n || held.birthtimeNs <= 0n || !sameObject(held, current)
            || !sameObject(held, lease.identity)) throw changed();
        return held;
    } catch (error: unknown) { throw new Error(changed().message, { cause: error }); }
}
function assertHeldContent(lease: MarkerLease, fd: number): fs.BigIntStats {
    const before = assertCurrent(lease, fd), expected = Buffer.from(lease.content, 'utf8');
    if (before.size !== BigInt(expected.length)) throw changed();
    const bytes = Buffer.alloc(expected.length + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = assertCurrent(lease, fd);
    if (count !== expected.length || !bytes.subarray(0, count).equals(expected)
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs) throw changed();
    return after;
}
function assertContent(lease: MarkerLease): void {
    assertCurrent(lease);
    // Namespace mutations on Windows require all marker descriptors to be closed.
    const fd = fs.openSync(lease.file, READ_FLAGS);
    let held: fs.BigIntStats;
    try { held = assertHeldContent(lease, fd); }
    finally { fs.closeSync(fd); }
    const current = assertCurrent(lease);
    if (held.size !== current.size || held.mtimeNs !== current.mtimeNs
        || held.ctimeNs !== current.ctimeNs) throw changed();
}
function ownedLease(root: string, file: string, owner: object): MarkerLease {
    const lease = owner && leases.get(owner);
    if (!lease || lease.root !== path.resolve(root) || lease.file !== path.resolve(file)) throw changed();
    assertContent(lease);
    return lease;
}
function openLease(root: string, file: string, content: string): MarkerLease {
    const parent = bindContainedDestination(root, path.dirname(file));
    const destination = bindContainedDestination(root, file);
    assertContainedDestination(destination);
    let fd: number;
    try { fd = fs.openSync(file, 'wx+', 0o600); }
    catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error('Full-suite run marker occupied; inspect it and use native recovery before retrying.', { cause: error });
        }
        throw error;
    }
    let lease: MarkerLease;
    try {
        lease = { root: path.resolve(root), file: path.resolve(file), parent,
            identity: fs.fstatSync(fd, { bigint: true }), content };
        assertCurrent(lease, fd);
        fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd);
        assertHeldContent(lease, fd);
    } finally {
        // Partial publication stays available for explicit recovery. Never unlink a replacement.
        fs.closeSync(fd);
    }
    assertContent(lease);
    return lease;
}
export function issueFullSuiteRunMarkerOwner(root: string, file: string, owner: object, content: string): void {
    ensureContainedDirectory(root, path.dirname(file));
    leases.set(owner, openLease(root, file, content));
}
function bindPublishedLease(previous: MarkerLease, next: MarkerLease, file: string): MarkerLease {
    assertContainedDestination(next.parent);
    const published = lstatFileIdentitySync(file, { bigint: true });
    // Windows can retain the destination's creation time across our same-name rename.
    const retainedCreationTime = process.platform === 'win32'
        && published.birthtimeNs === previous.identity.birthtimeNs;
    if (published.dev !== next.identity.dev || published.ino !== next.identity.ino
        || published.mode !== next.identity.mode
        || (published.birthtimeNs !== next.identity.birthtimeNs && !retainedCreationTime)) throw changed();
    const lease = { ...next, file: path.resolve(file), identity: published };
    assertContent(lease);
    return lease;
}
export function updateOwnedFullSuiteRunMarker(
    root: string, file: string, owner: object, update: (content: string) => string
): void {
    const current = ownedLease(root, file, owner);
    const tempPath = `${file}.owner-${randomUUID()}.tmp`;
    const next = openLease(root, tempPath, update(current.content));
    let committed = false;
    try {
        assertContent(current); assertContent(next);
        fs.renameSync(tempPath, file);
        committed = true;
        leases.set(owner, bindPublishedLease(current, next, file));
    } finally {
        if (!committed) {
            assertContent(next); fs.unlinkSync(tempPath);
        }
    }
}
export function clearOwnedFullSuiteRunMarker(root: string, file: string, owner: object): void {
    const lease = owner && leases.get(owner);
    if (!lease || lease.root !== path.resolve(root) || lease.file !== path.resolve(file)) throw changed();
    try { assertContent(lease); fs.unlinkSync(file); }
    finally { leases.delete(owner); }
}
