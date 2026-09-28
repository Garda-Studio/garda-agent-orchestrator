import * as fs from 'node:fs';

type FileStat = fs.Stats | fs.BigIntStats;

function sameMetadata(left: FileStat, right: FileStat): boolean {
    const sameNode = left.ino === right.ino
        && left.mode === right.mode
        && left.uid === right.uid
        && left.gid === right.gid
        && left.rdev === right.rdev
        && left.birthtimeMs === right.birthtimeMs
        && (!('birthtimeNs' in left && 'birthtimeNs' in right) || left.birthtimeNs === right.birthtimeNs);
    if (!sameNode) return false;
    // Directory children can change independently. Authenticate the directory
    // node and permissions; callers retain their own captured metadata checks.
    if (left.isDirectory() && right.isDirectory()) return true;
    return left.nlink === right.nlink
        && left.size === right.size
        && ('mtimeNs' in left && 'mtimeNs' in right
            ? left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
                && left.birthtimeNs === right.birthtimeNs
            : left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs);
}

function sameIdentity(left: FileStat, right: FileStat): boolean {
    return left.dev === right.dev && sameMetadata(left, right);
}

function readFileIdentity(filePath: fs.PathLike, followLinks: boolean, bigint: boolean, expected?: FileStat): FileStat {
    const readPathStat = (): FileStat => {
        if (bigint) return followLinks ? fs.statSync(filePath, { bigint: true }) : fs.lstatSync(filePath, { bigint: true });
        return followLinks ? fs.statSync(filePath) : fs.lstatSync(filePath);
    };
    const before = readPathStat();
    if (expected && !sameIdentity(expected, before)) {
        throw new Error(`File identity changed while inspecting: ${String(filePath)}`);
    }
    if (process.platform !== 'win32' || (before.dev !== 0 && before.dev !== 0n)
        || (!before.isFile() && !before.isDirectory())) return before;

    // Older Windows stat APIs omit the volume id. Reconstruct the complete
    // identity from two live descriptors; never make zero a device wildcard.
    const realPath = fs.realpathSync.native(filePath);
    let firstDescriptor: number | undefined;
    let secondDescriptor: number | undefined;
    const readDescriptorStat = (descriptor: number): FileStat => bigint
        ? fs.fstatSync(descriptor, { bigint: true }) : fs.fstatSync(descriptor);
    try {
        firstDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
        const first = readDescriptorStat(firstDescriptor);
        secondDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
        const second = readDescriptorStat(secondDescriptor);
        const current = readDescriptorStat(firstDescriptor);
        const after = readPathStat();
        if (first.isFile() !== before.isFile() || first.isDirectory() !== before.isDirectory()
            || second.isFile() !== before.isFile() || second.isDirectory() !== before.isDirectory()
            || current.isFile() !== before.isFile() || current.isDirectory() !== before.isDirectory()
            || !sameMetadata(before, first) || !sameIdentity(first, second)
            || !sameIdentity(first, current) || !sameIdentity(before, after)
            || fs.realpathSync.native(filePath) !== realPath) {
            throw new Error(`File identity changed while inspecting: ${String(filePath)}`);
        }
        return current;
    } finally {
        try {
            if (secondDescriptor !== undefined) fs.closeSync(secondDescriptor);
        } finally {
            if (firstDescriptor !== undefined) fs.closeSync(firstDescriptor);
        }
    }
}

export function completePathFileIdentitySync(filePath: fs.PathLike, identity: fs.Stats): fs.Stats {
    if (process.platform !== 'win32' || identity.dev !== 0
        || (!identity.isFile() && !identity.isDirectory())) return identity;
    return readFileIdentity(filePath, false, false, identity) as fs.Stats;
}

export function lstatFileIdentitySync(filePath: fs.PathLike, options: { bigint: true }): fs.BigIntStats;
export function lstatFileIdentitySync(filePath: fs.PathLike): fs.Stats;
export function lstatFileIdentitySync(filePath: fs.PathLike, options?: { bigint: true }): FileStat {
    return readFileIdentity(filePath, false, options?.bigint === true);
}

export function statFileIdentitySync(filePath: fs.PathLike, options: { bigint: true }): fs.BigIntStats;
export function statFileIdentitySync(filePath: fs.PathLike): fs.Stats;
export function statFileIdentitySync(filePath: fs.PathLike, options?: { bigint: true }): FileStat {
    return readFileIdentity(filePath, true, options?.bigint === true);
}
