import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    assertExistingPathIdentity, bindContainedDestination, type ContainedDestination
} from '../../../core/contained-filesystem';
import { lstatFileIdentitySync } from '../../../core/file-stat';

const MAX_LOCK_BYTES = 4096;
const MAX_RECOVERY_DEPTH = 2;
const MAX_ACQUISITION_ATTEMPTS = 3;
const RECOVERY_SUFFIX = '.stale-recovery';
const BUSY = 'Another review-catalog management transaction is active; concurrent mutation rejected';

export interface ReviewCatalogTransactionLock {
    lockPath: string;
    lockFd: number;
    parent: ContainedDestination;
    identity: fs.BigIntStats;
    content: string | null;
}

type LockSnapshot = ReviewCatalogTransactionLock & { content: string };

function changedLock(): Error {
    return new Error('Review catalog transaction lock changed before release.');
}

function sameObject(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
        && left.birthtimeNs === right.birthtimeNs;
}

function assertLockCurrent(lock: ReviewCatalogTransactionLock): fs.BigIntStats {
    assertExistingPathIdentity(lock.parent);
    const current = lstatFileIdentitySync(lock.lockPath, { bigint: true });
    const held = fs.fstatSync(lock.lockFd, { bigint: true });
    if (!current.isFile() || !held.isFile() || current.nlink !== 1n || held.nlink !== 1n
        || held.ino <= 0n || held.birthtimeNs <= 0n || !sameObject(current, held)
        || !sameObject(held, lock.identity)) throw changedLock();
    return held;
}

function readLockContent(lock: ReviewCatalogTransactionLock): string {
    const before = assertLockCurrent(lock);
    if (before.size > BigInt(MAX_LOCK_BYTES)) throw changedLock();
    const bytes = Buffer.alloc(MAX_LOCK_BYTES + 1);
    const count = fs.readSync(lock.lockFd, bytes, 0, bytes.length, 0);
    const after = assertLockCurrent(lock);
    if (count > MAX_LOCK_BYTES || BigInt(count) !== before.size || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw changedLock();
    return bytes.subarray(0, count).toString('utf8');
}

export function releaseReviewCatalogTransactionLock(lock: ReviewCatalogTransactionLock): void {
    try {
        assertLockCurrent(lock);
        if (lock.content !== null && readLockContent(lock) !== lock.content) throw changedLock();
        assertLockCurrent(lock);
        fs.unlinkSync(lock.lockPath);
    } finally {
        fs.closeSync(lock.lockFd);
    }
}

function publishLock(
    lockPath: string, lockFd: number, parent: ContainedDestination
): ReviewCatalogTransactionLock {
    let lock: ReviewCatalogTransactionLock | undefined;
    try {
        lock = { lockPath, lockFd, parent, identity: fs.fstatSync(lockFd, { bigint: true }), content: null };
        assertLockCurrent(lock);
        const content = JSON.stringify({ schema_version: 1, pid: process.pid, hostname: os.hostname(),
            lock_id: randomUUID(), timestamp_utc: new Date().toISOString() }) + '\n';
        fs.writeFileSync(lockFd, content, 'utf8');
        fs.fsyncSync(lockFd);
        lock.content = content;
        if (readLockContent(lock) !== content) throw changedLock();
        return lock;
    } catch (error: unknown) {
        if (lock) {
            try {
                releaseReviewCatalogTransactionLock(lock);
            } catch (cleanupError: unknown) {
                throw new AggregateError([error, cleanupError],
                    'Review catalog transaction lock publication failed and cleanup was rejected.');
            }
        } else fs.closeSync(lockFd);
        throw error;
    }
}

function readLockSnapshot(bundleRoot: string, lockPath: string): LockSnapshot {
    const parent = bindContainedDestination(bundleRoot, path.dirname(lockPath));
    const identity = lstatFileIdentitySync(lockPath, { bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n || identity.birthtimeNs <= 0n) throw changedLock();
    const lockFd = fs.openSync(lockPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
        const lock = { lockPath, lockFd, parent, identity, content: null };
        return { ...lock, content: readLockContent(lock) };
    } catch (error: unknown) {
        fs.closeSync(lockFd);
        throw error;
    }
}

function hasKnownDeadOwner(snapshot: LockSnapshot): boolean {
    try {
        const owner = JSON.parse(snapshot.content);
        if (owner?.schema_version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
            || owner.hostname !== os.hostname() || typeof owner.lock_id !== 'string' || !owner.lock_id) return false;
        try {
            process.kill(owner.pid, 0);
            return false;
        } catch (error: unknown) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
    } catch {
        return false;
    }
}

function recoverDeadOwner(bundleRoot: string, lockPath: string, depth: number): void {
    let observed: LockSnapshot;
    try {
        observed = readLockSnapshot(bundleRoot, lockPath);
    } catch {
        throw new Error(`${BUSY}: owner is not safely verifiable.`);
    }
    try {
        if (!hasKnownDeadOwner(observed) || depth >= MAX_RECOVERY_DEPTH) {
            throw new Error(`${BUSY}: owner or bounded recovery guard is not safely verifiable.`);
        }
        const guard = takeLock(bundleRoot, lockPath + RECOVERY_SUFFIX, depth + 1);
        try {
            const current = readLockSnapshot(bundleRoot, lockPath);
            try {
                if (!sameObject(observed.identity, current.identity) || observed.content !== current.content
                    || !hasKnownDeadOwner(current)) throw new Error(`${BUSY}: owner changed during recovery.`);
                if (readLockContent(current) !== current.content) throw changedLock();
                assertLockCurrent(current);
                fs.unlinkSync(lockPath);
            } finally {
                fs.closeSync(current.lockFd);
            }
        } finally {
            releaseReviewCatalogTransactionLock(guard);
        }
    } finally {
        fs.closeSync(observed.lockFd);
    }
}

function takeLock(bundleRoot: string, lockPath: string, depth: number): ReviewCatalogTransactionLock {
    const parent = bindContainedDestination(bundleRoot, path.dirname(lockPath));
    for (let attempt = 0; attempt < MAX_ACQUISITION_ATTEMPTS; attempt += 1) {
        assertExistingPathIdentity(parent);
        let descriptor: number;
        try {
            descriptor = fs.openSync(lockPath, 'wx+', 0o600);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            recoverDeadOwner(bundleRoot, lockPath, depth);
            continue;
        }
        return publishLock(lockPath, descriptor, parent);
    }
    throw new Error(`${BUSY}: bounded acquisition attempts exhausted.`);
}

export function acquireReviewCatalogTransactionLock(
    bundleRoot: string, lockPath: string
): ReviewCatalogTransactionLock {
    return takeLock(bundleRoot, lockPath, 0);
}
